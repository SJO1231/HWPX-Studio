// 조각 스트레스 캠페인(엔진 명세 7.8절). 실제 문서 모음에서 길고 복잡한 구간을 서로 무관한 문서 사이에서 옮기고, 결과를 수량과 코드로만 기록한다.
//
// 실행: node tools/stress/campaign.ts --corpus <폴더> [--seed N] [--pairs N] [--min-paras 20] [--max-paras 200]
//        [--oracle-sample N] [--no-com] [--no-rhwp] [--report <출력.json>] [--time-budget-min N]
//
// 원칙: 모음 폴더는 읽기만 한다. 파일 이름·문서 내용은 어디에도 남기지 않고(식별자 = 상대 경로 sha256 앞 10자),
// 결과물은 OS 임시 폴더 아래 hwpx-studio-stress/ 에만 두었다가 끝나면 지운다.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFragment, openPackage, parseDocument } from "../../packages/hwpx-engine/src/index.ts";
import { validateDocument } from "../../packages/hwpx-engine/src/validate/index.ts";
import {
  readCorpusFile,
  sameSnapshot,
  sameStat,
  scanCorpus,
  snapshotOf,
  type CorpusFile,
  type CorpusSnapshot,
} from "./corpus.ts";
import { describeDoc, type DocInfo, type WindowPick } from "./docinfo.ts";
import { METHODS, CaseStop, loadDocument, reparse, runMethod, type Loaded, type MethodName, type MethodOutcome, type PairCtx } from "./methods.ts";
import {
  OraclePool,
  STRESS_DIR,
  comAvailable,
  removeStressDir,
  rhwpAvailable,
  runCom,
  runRhwp,
  stressDirIsEmpty,
  summarizeOracle,
  type ComRun,
  type OracleEntry,
} from "./oracle.ts";
import { hashSeed, makeRng, type Rng } from "./rng.ts";
import { bump, dist, pct, sortedRecord } from "./stats.ts";
import type { FormatStats } from "./formats.ts";
import type { Fail, Notes } from "./verify.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..", "..");

// ── 인자 ────────────────────────────────────────────────────────

type Options = {
  corpus: string;
  seed: number;
  pairs: number;
  minParas: number;
  maxParas: number;
  oracleSample: number;
  noCom: boolean;
  noRhwp: boolean;
  report: string;
  timeBudgetMin: number | null;
};

function parseArgs(argv: string[]): Options {
  const o: Options = {
    corpus: "",
    seed: 1,
    pairs: 150,
    minParas: 20,
    maxParas: 200,
    oracleSample: 30,
    noCom: false,
    noRhwp: false,
    report: join(HERE, "out", "report.json"),
    timeBudgetMin: null,
  };
  const num = (name: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < 0) throw new Error(`${name} 값이 올바르지 않다`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--corpus":
        o.corpus = next ?? "";
        i++;
        break;
      case "--seed":
        o.seed = num(a, next);
        i++;
        break;
      case "--pairs":
        o.pairs = num(a, next);
        i++;
        break;
      case "--min-paras":
        o.minParas = num(a, next);
        i++;
        break;
      case "--max-paras":
        o.maxParas = num(a, next);
        i++;
        break;
      case "--oracle-sample":
        o.oracleSample = num(a, next);
        i++;
        break;
      case "--no-com":
        o.noCom = true;
        break;
      case "--no-rhwp":
        o.noRhwp = true;
        break;
      case "--report":
        o.report = resolve(next ?? "");
        i++;
        break;
      case "--time-budget-min":
        o.timeBudgetMin = num(a, next);
        i++;
        break;
      default:
        throw new Error(`알 수 없는 인자: ${a}`);
    }
  }
  if (o.corpus === "") throw new Error("--corpus <폴더>가 필요하다");
  o.corpus = resolve(o.corpus);
  if (o.minParas < 1 || o.maxParas < o.minParas) throw new Error("--min-paras / --max-paras 범위가 올바르지 않다");
  return o;
}

// ── 엔진 상태 표시 ──────────────────────────────────────────────

/** 엔진 소스의 상태를 한 줄로(다른 담당이 동시에 고치는 파일이 있어 결과와 대조하려는 것이다). 내용은 남지 않는다. */
function engineFingerprint(): { files: number; all: string; importTs: string } {
  const root = join(REPO, "packages", "hwpx-engine", "src");
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".ts")) files.push(p);
    }
  }
  files.sort();
  const all = createHash("sha256");
  for (const f of files) all.update(f.slice(root.length)).update(readFileSync(f));
  const importTs = createHash("sha256").update(readFileSync(join(root, "fragment", "import.ts"))).digest("hex");
  return { files: files.length, all: all.digest("hex").slice(0, 12), importTs: importTs.slice(0, 12) };
}

// ── 색인 ────────────────────────────────────────────────────────

type IndexEntry = {
  file: CorpusFile;
  info: DocInfo;
  baselineErrors: number;
  baselineErrorCodes: string[];
  size: number;
};

type IndexResult = { entries: IndexEntry[]; failures: Record<string, number>; ms: number };

function indexCorpus(files: CorpusFile[], opts: Options): IndexResult {
  const t0 = Date.now();
  const entries: IndexEntry[] = [];
  const failures: Record<string, number> = {};
  files.forEach((file, i) => {
    try {
      const bytes = readCorpusFile(file);
      const doc = parseDocument(openPackage(bytes));
      const info = describeDoc(doc, opts.minParas, opts.maxParas);
      const report = validateDocument(bytes);
      entries.push({
        file,
        info,
        baselineErrors: report.errors.reduce((n, e) => n + e.count, 0),
        baselineErrorCodes: [...new Set(report.errors.map((e) => e.code))],
        size: file.size,
      });
    } catch (e) {
      bump(failures, e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : `EXCEPTION:${e instanceof Error ? e.name : "Error"}`);
    }
    if ((i + 1) % 100 === 0) log(`색인 ${i + 1}/${files.length} (열림 ${entries.length})`);
  });
  return { entries, failures, ms: Date.now() - t0 };
}

type WindowSummary = Pick<WindowPick, "sectionIndex" | "from" | "to" | "len" | "score" | "kinds" | "charPrs" | "paraPrs" | "depth" | "tables" | "pics" | "fields" | "clickHere" | "bookmarks" | "notes" | "boxes" | "headerFooter">;

const summarizeWindow = (w: WindowPick): WindowSummary => ({
  sectionIndex: w.sectionIndex,
  from: w.from,
  to: w.to,
  len: w.len,
  score: w.score,
  kinds: w.kinds,
  charPrs: w.charPrs,
  paraPrs: w.paraPrs,
  depth: w.depth,
  tables: w.tables,
  pics: w.pics,
  fields: w.fields,
  clickHere: w.clickHere,
  bookmarks: w.bookmarks,
  notes: w.notes,
  boxes: w.boxes,
  headerFooter: w.headerFooter,
});

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

// ── 쌍 뽑기 ─────────────────────────────────────────────────────

type Pair = {
  n: number;
  src: IndexEntry;
  tgt: IndexEntry;
  third: IndexEntry;
  styleDiffers: boolean;
  fontDiffers: boolean;
  folderDiffers: boolean;
};

const setsEqual = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

function drawPairs(entries: IndexEntry[], pairs: number, rng: Rng): { pairs: Pair[]; sources: number; pool: number } {
  const hasWindow = entries.filter((e) => e.info.window !== null);
  const full = hasWindow.filter((e) => e.info.window?.full === true);
  const sources = full.length >= Math.min(pairs, 10) ? full : hasWindow;
  const byScore = [...sources].sort((a, b) => (b.info.window?.score ?? 0) - (a.info.window?.score ?? 0));
  const poolSize = Math.min(byScore.length, Math.max(pairs, Math.ceil(byScore.length * 0.5)));
  const pool = rng.shuffle(byScore.slice(0, poolSize));
  const targets = entries.filter((e) => e.info.summary.topParas > 0);
  const out: Pair[] = [];
  for (let n = 0; n < pairs && pool.length > 0; n++) {
    const src = pool[n % pool.length] as IndexEntry;
    const candidates = rng.shuffle(targets.filter((t) => t !== src)).slice(0, 12);
    if (candidates.length === 0) break;
    const scored = candidates.map((t) => {
      const styleDiffers = !setsEqual(src.info.styleNames, t.info.styleNames);
      const fontDiffers = !setsEqual(src.info.fontNames, t.info.fontNames);
      const folderDiffers = src.file.folderId !== t.file.folderId;
      return { t, styleDiffers, fontDiffers, folderDiffers, score: (styleDiffers ? 2 : 0) + (fontDiffers ? 2 : 0) + (folderDiffers ? 1 : 0) };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0] as (typeof scored)[number];
    const rest = entries.filter((e) => e !== src && e !== best.t && e.info.summary.topParas > 0);
    out.push({
      n,
      src,
      tgt: best.t,
      third: rng.pick(rest.length > 0 ? rest : [best.t]),
      styleDiffers: best.styleDiffers,
      fontDiffers: best.fontDiffers,
      folderDiffers: best.folderDiffers,
    });
  }
  return { pairs: out, sources: sources.length, pool: pool.length };
}

// ── 건 기록 ─────────────────────────────────────────────────────

type Outcome = "ok" | "rejected" | "inherited" | "defect" | "skipped";

type CaseRecord = {
  pair: number;
  caseId: string;
  method: MethodName;
  outcome: Outcome;
  /** 대표 코드. 결함은 `<V항목>:<코드>`, 거절은 엔진 코드, 상속·건너뜀도 같은 형식 */
  code: string;
  /** 결함이 가진 모든 코드(대표 코드 포함) */
  codes: string[];
  phase: string;
  detail: string;
  site: string;
  ms: number;
  steps: number;
  parts: number | null;
  summary: Record<string, number>;
  planIssues: Record<string, number>;
  notes: Notes;
  /** 조각이 소스에서 이미 없는 대상을 가리키는 참조를 담았는가(FRAG_DANGLING_SOURCE) */
  dangling: boolean;
  /** 소스에서 이미 없던 대상을 가리키는 참조의 종류별 서로 다른 대상 수(FRAG_DANGLING_SOURCE) */
  danglingSpaces: Record<string, number>;
  /** 계획이 기록한 상속(inherited)의 항목 수: 조각 안에서 겹치는 id (역할, 값)과 소스에서 없던 참조 (종류, id)의 단계별 합 */
  planInherited: { duplicateIds: number; danglingRefs: number };
  /** M10: 서식 변경을 적용한 종류별 건수와 거절 사유 */
  formats: FormatStats | null;
  deterministic: "same" | "differ" | null;
};

const SUMMARY_KEYS = [
  "reusedResources",
  "addedResources",
  "createdLists",
  "reusedBinaries",
  "addedBinaries",
  "reissuedIds",
  "renamedStyles",
  "renamedBookmarks",
  "insertedParagraphs",
  "insertedTables",
  "insertedPictures",
  "insertedFields",
  "insertedBookmarks",
] as const;

const fmt = (f: Fail): string => `${f.item}:${f.code}`;

function summarizeOutcome(out: MethodOutcome): { summary: Record<string, number>; planIssues: Record<string, number> } {
  const summary: Record<string, number> = {};
  for (const k of SUMMARY_KEYS) summary[k] = out.steps.reduce((n, s) => n + (s.plan.summary[k] ?? 0), 0);
  const planIssues: Record<string, number> = {};
  for (const s of out.steps) for (const i of s.plan.issues) bump(planIssues, i.code);
  return { summary, planIssues };
}

const emptyRecord = (pair: number, method: MethodName): CaseRecord => ({
  pair,
  caseId: `p${String(pair).padStart(3, "0")}-${method}`,
  method,
  outcome: "ok",
  code: "",
  codes: [],
  phase: "",
  detail: "",
  site: "",
  ms: 0,
  steps: 0,
  parts: null,
  summary: {},
  planIssues: {},
  notes: {},
  dangling: false,
  danglingSpaces: {},
  planInherited: { duplicateIds: 0, danglingRefs: 0 },
  formats: null,
  deterministic: null,
});

/** 위험이 큰 건에 높은 점수를 준다(오라클 표본을 고를 때). */
function riskOf(win: WindowPick, method: MethodName, caseId: string): number {
  let r = 0;
  if (win.pics > 0) r += 3;
  if (win.clickHere > 0) r += 2;
  else if (win.fields > 0) r += 1;
  if (win.depth >= 2) r += 3;
  else if (win.tables > 0) r += 1;
  if (win.boxes > 0) r += 2;
  if (win.notes > 0) r += 2;
  if (win.bookmarks > 0) r += 1;
  if (win.headerFooter > 0) r += 1;
  if (win.len >= 100) r += 1;
  if (method === "M4" || method === "M5" || method === "M8") r += 1;
  if (method === "M6" || method === "M10") r += 1;
  return r + (hashSeed(caseId) % 1000) / 1000;
}

// ── 메인 ────────────────────────────────────────────────────────

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const engine = engineFingerprint();
  log(`엔진 소스 ${engine.files}개, 지문 ${engine.all} (fragment/import.ts ${engine.importTs})`);

  // 코퍼스 스냅샷(시작)
  const scanStart = scanCorpus(opts.corpus);
  const snapStart = snapshotOf(scanStart);
  log(`모음: .hwpx ${snapStart.hwpxFiles}개, ${snapStart.totalBytes} 바이트`);
  if (snapStart.hwpxFiles === 0) throw new Error("모음에 .hwpx 파일이 없다");

  const pool = new OraclePool(Math.ceil(opts.oracleSample * 1.5));
  let corpusChanged = false;
  const checkCorpus = (): void => {
    const now = snapshotOf(scanCorpus(opts.corpus));
    if (!sameSnapshot(snapStart, now)) corpusChanged = true;
  };

  // 색인
  const index = indexCorpus(scanStart, opts);
  const entries = index.entries;
  log(`색인 완료: 열림 ${entries.length}, 열기 실패 ${scanStart.length - entries.length} (${Math.round(index.ms / 1000)}초)`);

  // 쌍
  const rngPairs = makeRng(hashSeed(`${opts.seed}:pairs`));
  const drawn = drawPairs(entries, opts.pairs, rngPairs);
  log(`쌍 ${drawn.pairs.length}개(소스 후보 ${drawn.sources}, 풀 ${drawn.pool})`);

  const records: CaseRecord[] = [];
  const pairLog: { n: number; src: string; tgt: string; third: string; window: WindowSummary; ms: number }[] = [];
  const pairErrors: Record<string, number> = {};
  const listNeeds: Record<string, number> = {};
  let truncated = false;
  const loadEntry = (e: IndexEntry): Loaded => {
    if (!sameStat(e.file)) {
      corpusChanged = true;
      throw new Error("CORPUS_CHANGED");
    }
    const bytes = readCorpusFile(e.file);
    return loadDocument(e.file.id, bytes, e.info);
  };

  for (const pair of drawn.pairs) {
    if (opts.timeBudgetMin !== null && (Date.now() - t0) / 60000 > opts.timeBudgetMin) {
      truncated = true;
      break;
    }
    if (corpusChanged) break;
    const pairStart = Date.now();
    let src: Loaded;
    let tgt: Loaded;
    let thirdLoaded: Loaded | undefined;
    const win = pair.src.info.window as WindowPick;
    try {
      src = loadEntry(pair.src);
      tgt = loadEntry(pair.tgt);
    } catch (e) {
      bump(pairErrors, e instanceof Error ? (e.message === "CORPUS_CHANGED" ? e.message : "code" in e ? String((e as { code: unknown }).code) : e.name) : "ERROR");
      if (corpusChanged) break;
      continue;
    }
    // 조각이 요구하는 자원 종류와 대상 header의 목록 유무(거절 사유가 목록 부재인지 대조하려는 것이다)
    try {
      const f = extractFragment(src.doc, { sectionIndex: win.sectionIndex, parentPath: [], from: win.from, to: win.to });
      const kinds = new Set(f.resources.map((r) => r.kind));
      const t = pair.tgt.info.summary;
      const need = (kind: string, lacks: boolean): void => {
        if (kinds.has(kind)) bump(listNeeds, `${kind}:needed`);
        if (kinds.has(kind) && lacks) bump(listNeeds, `${kind}:needed_and_target_lacks_list`);
      };
      need("bullet", t.lacksBullets);
      need("numbering", t.lacksNumberings);
      need("tabPr", t.lacksTabProperties);
      bump(listNeeds, "pairs");
    } catch {
      bump(listNeeds, "extractFailed");
    }
    const reload = (l: Loaded): Loaded => ({ ...l, doc: reparse(l.bytes) });
    const makeCtx = (fresh: boolean): PairCtx => {
      const s = fresh ? reload(src) : src;
      const t = fresh ? reload(tgt) : tgt;
      return {
        pair: pair.n,
        seed: opts.seed,
        src: s,
        win,
        tgt: t,
        loadThird: () => {
          thirdLoaded ??= loadEntry(pair.third);
          return fresh ? reload(thirdLoaded) : thirdLoaded;
        },
      };
    };
    const ctx = makeCtx(false);

    for (const method of METHODS) {
      const rec = emptyRecord(pair.n, method);
      const start = Date.now();
      let out: MethodOutcome | undefined;
      try {
        out = runMethod(method, ctx, true);
      } catch (e) {
        if (e instanceof CaseStop) {
          rec.outcome = e.kind;
          rec.code = e.kind === "rejected" ? e.code : `${e.item}:${e.code}`;
          if (e.kind === "defect") rec.codes = [rec.code];
          rec.phase = e.item;
          rec.detail = e.detail;
          rec.site = e.site;
        } else {
          rec.outcome = "skipped";
          rec.code = `TOOL_ERROR:${e instanceof Error ? e.name : "Error"}`;
          rec.site = e instanceof Error ? (e.stack ?? "").split("\n").slice(1, 3).map((l) => l.trim().replace(/\(.*[\\/](tools|packages)[\\/]/, "($1/")).join(" | ") : "";
        }
      }
      if (out !== undefined) {
        const { summary, planIssues } = summarizeOutcome(out);
        rec.summary = summary;
        if (method === "M7" && out.steps.length === 2) rec.summary["secondAddedResources"] = out.steps[1]?.plan.summary["addedResources"] ?? 0;
        rec.planIssues = planIssues;
        rec.steps = out.steps.length;
        rec.parts = out.parts ?? null;
        rec.notes = out.notes;
        rec.dangling = out.fragments.some((f) => f.dangling.length > 0);
        const seenDangling = new Set<string>();
        for (const f of out.fragments) {
          for (const d of f.dangling) {
            if (seenDangling.has(`${d.kind}:${d.id}`)) continue;
            seenDangling.add(`${d.kind}:${d.id}`);
            bump(rec.danglingSpaces, d.kind);
          }
        }
        rec.planInherited = {
          duplicateIds: out.steps.reduce((n, st) => n + st.plan.inherited.duplicateIds.length, 0),
          danglingRefs: out.steps.reduce((n, st) => n + st.plan.inherited.danglingRefs.length, 0),
        };
        if (out.formats !== undefined) rec.formats = out.formats;
        const fails = [...out.fails];
        // V-h: 표본으로 같은 입력을 새로 읽어 한 번 더 실행해 출력 바이트를 견준다
        if (hashSeed(`${opts.seed}:det:${rec.caseId}`) % 5 === 0) {
          try {
            const again = runMethod(method, makeCtx(true), false);
            const same = again.outputs.length === out.outputs.length && again.outputs.every((h, i) => h === out?.outputs[i]);
            rec.deterministic = same ? "same" : "differ";
            if (!same) fails.push({ item: "V-h", code: "OUTPUT_DIFFERS" });
          } catch (e) {
            rec.deterministic = "differ";
            fails.push({ item: "V-h", code: e instanceof CaseStop ? `RERUN_${e.kind.toUpperCase()}:${e.code}` : "RERUN_EXCEPTION" });
          }
        }
        if (fails.length > 0) {
          rec.outcome = "defect";
          rec.codes = [...new Set(fails.map(fmt))];
          rec.code = rec.codes[0] as string;
        } else if (out.inherited.length > 0) {
          rec.outcome = "inherited";
          rec.codes = [...new Set(out.inherited.map(fmt))];
          rec.code = rec.codes[0] as string;
        } else {
          pool.offer({
            caseId: rec.caseId,
            method,
            risk: riskOf(win, method, rec.caseId),
            bytes: out.final.bytes,
            baseId: out.final.base.id,
            baseBytes: out.final.base.bytes,
            meta: {
              windowLen: win.len,
              pics: win.pics,
              clickHere: win.clickHere,
              fields: win.fields,
              depth: win.depth,
              boxes: win.boxes,
              notes: win.notes,
              bookmarks: win.bookmarks,
              headerFooter: win.headerFooter,
              createdLists: out.steps.reduce((n, st) => n + (st.plan.summary["createdLists"] ?? 0), 0),
              cellClip: out.steps.some((st) => st.plan.issues.some((i) => i.code === "FRAG_CELL_MAY_CLIP")) ? 1 : 0,
              insertedAll: out.final.steps.reduce((n, st) => n + (st.plan.summary["insertedParagraphs"] ?? 0), 0),
              insertedTop: method === "M6" ? 0 : out.final.steps.reduce((n, st) => n + st.count, 0),
            },
          });
        }
        if (method === "M1") ctx.wholeAdded = rec.summary["addedResources"] ?? 0;
      }
      rec.ms = Date.now() - start;
      records.push(rec);
    }
    pairLog.push({
      n: pair.n,
      src: pair.src.file.id,
      tgt: pair.tgt.file.id,
      third: pair.third.file.id,
      window: summarizeWindow(win),
      ms: Date.now() - pairStart,
    });
    const mine = records.filter((r) => r.pair === pair.n);
    const tally = (o: Outcome): number => mine.filter((r) => r.outcome === o).length;
    log(`쌍 ${pair.n + 1}/${drawn.pairs.length} (${Math.round((Date.now() - pairStart) / 100) / 10}초): ok ${tally("ok")} 거절 ${tally("rejected")} 상속 ${tally("inherited")} 결함 ${tally("defect")} 건너뜀 ${tally("skipped")}`);
    for (const f of [pair.src.file, pair.tgt.file, pair.third.file]) {
      if (!sameStat(f)) corpusChanged = true;
    }
    if ((pair.n + 1) % 50 === 0) checkCorpus();
    if (corpusChanged) {
      log("모음이 바뀐 것이 감지되어 멈춘다");
      break;
    }
  }

  // 오라클
  const campaignMs = Date.now() - t0;
  let oracleSummary = summarizeOracle([], false, null, false);
  if (!corpusChanged && opts.oracleSample > 0) {
    const picked = pool.select(opts.oracleSample);
    log(`오라클 표본 ${picked.length}건`);
    const entriesO: OracleEntry[] = picked.map((p) => ({ caseId: p.caseId, method: p.method, risk: Math.round(p.risk * 100) / 100, base: p.baseId, meta: p.meta }));
    const rhwpOn = !opts.noRhwp && rhwpAvailable();
    if (rhwpOn) {
      const baseCache = new Map<string, ReturnType<typeof runRhwp>>();
      picked.forEach((p, i) => {
        const base = baseCache.get(p.baseId) ?? runRhwp(p.baseFile);
        baseCache.set(p.baseId, base);
        const r = runRhwp(p.file);
        const e = entriesO[i];
        if (e !== undefined) e.rhwp = { ...r, basePages: base.pages, baseParas: base.paras, baseWarnings: base.warnings, baseExit: base.exit };
      });
      log("rhwp 완료");
    }
    let com: ComRun | null = null;
    const pdfDir = join(STRESS_DIR, "pdf");
    if (!opts.noCom && comAvailable() && picked.length > 0) {
      const files = [...new Set(picked.flatMap((p) => [p.file, p.baseFile]))];
      com = runCom(files, pdfDir);
      const nameOf = (f: string): string => f.slice(Math.max(f.lastIndexOf("\\"), f.lastIndexOf("/")) + 1);
      picked.forEach((p, i) => {
        const e = entriesO[i];
        const r = com?.results.get(nameOf(p.file));
        const b = com?.results.get(nameOf(p.baseFile));
        if (e !== undefined && r !== undefined) e.hancom = { ...r, basePages: b?.pages ?? null, baseOpened: b?.opened === true };
      });
      log(`한컴 완료: 열림 ${[...(com?.results.values() ?? [])].filter((r) => r.opened).length}/${com?.results.size ?? 0}`);
    }
    oracleSummary = summarizeOracle(entriesO, rhwpOn, com, true);
    if (opts.noRhwp || !rhwpAvailable()) oracleSummary.rhwp = null;
  }
  removeStressDir();
  const tmpEmpty = stressDirIsEmpty();

  // 코퍼스 스냅샷(끝)
  const snapEnd = snapshotOf(scanCorpus(opts.corpus));
  const unchanged = sameSnapshot(snapStart, snapEnd) && !corpusChanged;

  // 보고서
  const report = buildReport({ opts, engine, snapStart, snapEnd, unchanged, files: scanStart, index, drawn, records, pairLog, truncated, pairErrors, listNeeds, oracleSummary, tmpEmpty, campaignMs, totalMs: Date.now() - t0 });
  mkdirSync(dirname(opts.report), { recursive: true });
  writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report as ReportShape);
  return unchanged ? 0 : 3;
}

// ── 보고서 ──────────────────────────────────────────────────────

type ReportInput = {
  opts: Options;
  engine: ReturnType<typeof engineFingerprint>;
  snapStart: CorpusSnapshot;
  snapEnd: CorpusSnapshot;
  unchanged: boolean;
  files: CorpusFile[];
  index: IndexResult;
  drawn: ReturnType<typeof drawPairs>;
  records: CaseRecord[];
  pairLog: { n: number; src: string; tgt: string; third: string; window: WindowSummary; ms: number }[];
  truncated: boolean;
  pairErrors: Record<string, number>;
  listNeeds: Record<string, number>;
  oracleSummary: ReturnType<typeof summarizeOracle>;
  tmpEmpty: boolean;
  campaignMs: number;
  totalMs: number;
};

type ReportShape = { methods: Record<string, Record<string, number>>; totals: Record<string, number>; corpus: { unchanged: boolean } };

function buildReport(r: ReportInput): Record<string, unknown> {
  const { records, index } = r;
  const entries = index.entries;
  const sums = entries.map((e) => e.info.summary);
  const has = (pred: (s: (typeof sums)[number]) => boolean): { docs: number; percent: number } => {
    const n = sums.filter(pred).length;
    return { docs: n, percent: pct(n, sums.length) };
  };

  // 색인 요약
  const originalErrorCodes: Record<string, number> = {};
  for (const e of entries) for (const c of e.baselineErrorCodes) bump(originalErrorCodes, c);
  const windows = entries.flatMap((e) => (e.info.window === null ? [] : [e.info.window]));
  const indexReport = {
    opened: entries.length,
    openFailures: sortedRecord(index.failures),
    sectionsPerDoc: dist(sums.map((s) => s.sections)),
    topLevelParagraphs: dist(sums.map((s) => s.topParas)),
    tables: dist(sums.map((s) => s.tables)),
    maxTableDepth: dist(sums.map((s) => s.maxTableDepth)),
    pictures: dist(sums.map((s) => s.pics)),
    distinctCharPrsUsed: dist(sums.map((s) => s.charPrsUsed)),
    distinctParaPrsUsed: dist(sums.map((s) => s.paraPrsUsed)),
    charPrsDefined: dist(sums.map((s) => s.charPrsDefined)),
    paraPrsDefined: dist(sums.map((s) => s.paraPrsDefined)),
    styleNames: dist(sums.map((s) => s.styles)),
    fontNames: dist(sums.map((s) => s.fonts)),
    fileBytes: dist(entries.map((e) => e.size)),
    originalErrors: dist(entries.map((e) => e.baselineErrors)),
    docsWithOriginalErrors: entries.filter((e) => e.baselineErrors > 0).length,
    originalErrorCodes: sortedRecord(originalErrorCodes),
    prevalence: {
      multiSection: has((s) => s.sections > 1),
      withTables: has((s) => s.tables > 0),
      nestedTables: has((s) => s.maxTableDepth >= 2),
      tablesDepth3OrMore: has((s) => s.maxTableDepth >= 3),
      withPictures: has((s) => s.pics > 0),
      withFields: has((s) => s.fields > 0),
      withClickHereFields: has((s) => s.clickHere > 0),
      withBookmarks: has((s) => s.bookmarks > 0),
      withFootEndNotes: has((s) => s.notes > 0),
      withTextBoxes: has((s) => s.boxes > 0),
      withHeaderFooter: has((s) => s.headerFooter > 0),
      withCellTarget: has((s) => s.hasCellTarget),
      headerLacksBulletsList: has((s) => s.lacksBullets),
      headerLacksNumberingsList: has((s) => s.lacksNumberings),
      headerLacksTabPropertiesList: has((s) => s.lacksTabProperties),
    },
    windowCandidates: {
      docsWithWindow: windows.length,
      fullLength: windows.filter((w) => w.full).length,
      score: dist(windows.map((w) => w.score)),
      length: dist(windows.map((w) => w.len)),
    },
  };

  // 건 집계
  const outcomes: Outcome[] = ["ok", "rejected", "inherited", "defect", "skipped"];
  const methods: Record<string, Record<string, number>> = {};
  for (const m of METHODS) {
    const mine = records.filter((x) => x.method === m);
    methods[m] = { cases: mine.length };
    for (const o of outcomes) methods[m][o] = mine.filter((x) => x.outcome === o).length;
  }
  const totals: Record<string, number> = { cases: records.length };
  for (const o of outcomes) totals[o] = records.filter((x) => x.outcome === o).length;

  const codes: Record<string, Record<string, number>> = { rejected: {}, defectPrimary: {}, defectAll: {}, inherited: {}, inheritedAll: {}, skipped: {}, exceptionSites: {} };
  const byMethodCodes: Record<string, Record<string, number>> = {};
  for (const x of records) {
    if (x.outcome === "ok") continue;
    const bucket = x.outcome === "rejected" ? codes.rejected : x.outcome === "defect" ? codes.defectPrimary : x.outcome === "inherited" ? codes.inherited : codes.skipped;
    bump(bucket as Record<string, number>, x.code);
    bump((byMethodCodes[x.method] ??= {}), `${x.outcome}:${x.code}`);
    if (x.outcome === "defect") for (const c of x.codes) bump(codes.defectAll as Record<string, number>, c);
    if (x.outcome === "inherited") for (const c of x.codes) bump(codes.inheritedAll as Record<string, number>, c);
    if (x.site !== "" && x.code.startsWith("exception")) bump(codes.exceptionSites as Record<string, number>, `${x.code} @ ${x.site}`);
  }
  const rejectedByPhase: Record<string, number> = {};
  const rejectedDetail: Record<string, number> = {};
  for (const x of records) {
    if (x.outcome !== "rejected") continue;
    bump(rejectedByPhase, `${x.phase}:${x.code}`);
    if (x.detail !== "") bump(rejectedDetail, `${x.code}:${x.detail}`);
  }
  for (const k of Object.keys(codes)) codes[k] = sortedRecord(codes[k] as Record<string, number>);

  const newErrorIssues: Record<string, number> = {};
  const toolNotes: Record<string, number> = {};
  for (const x of records) {
    for (const [k, v] of Object.entries(x.notes)) {
      if (k.startsWith("vb.newErrors.")) bump(newErrorIssues, k.slice("vb.newErrors.".length), v);
      else bump(toolNotes, k, v);
    }
  }
  const planWarnings: Record<string, number> = {};
  for (const x of records) for (const [k, v] of Object.entries(x.planIssues)) bump(planWarnings, k, v > 0 ? 1 : 0);

  // M10(서식 변경 조합): 적용한 서식 종류별 건수와 거절 사유
  const m10 = records.filter((x) => x.method === "M10");
  const sumBy = (pick: (f: FormatStats) => Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const x of m10) if (x.formats !== null) for (const [k, v] of Object.entries(pick(x.formats))) bump(out, k, v);
    return sortedRecord(out);
  };
  const appliedByKind = sumBy((f) => f.applied);
  const formatReport = {
    cases: m10.length,
    casesWithApplied: m10.filter((x) => x.formats !== null && Object.keys(x.formats.applied).length > 0).length,
    applied: appliedByKind,
    appliedTotals: {
      char: Object.entries(appliedByKind).filter(([k]) => k.startsWith("char:")).reduce((n, [, v]) => n + v, 0),
      para: Object.entries(appliedByKind).filter(([k]) => k.startsWith("para:")).reduce((n, [, v]) => n + v, 0),
    },
    noop: m10.reduce((n, x) => n + (x.formats?.noop ?? 0), 0),
    rejected: sumBy((f) => f.rejected),
    rejectedByKind: sumBy((f) => f.rejectedByKind),
    casesRejectedAsAWhole: m10.filter((x) => x.outcome === "rejected").length,
  };
  // 상속 기록(plan.inherited)과 목록 생성, 셀 안 삽입 경고
  const inheritedPlan = {
    casesWithDuplicateIds: records.filter((x) => x.planInherited.duplicateIds > 0).length,
    casesWithDanglingRefs: records.filter((x) => x.planInherited.danglingRefs > 0).length,
    byMethodDuplicateIds: sortedRecord(Object.fromEntries(METHODS.map((m) => [m, records.filter((x) => x.method === m && x.planInherited.duplicateIds > 0).length]))),
  };
  const created = records.filter((x) => (x.summary["createdLists"] ?? 0) > 0);
  const createdLists = { cases: created.length, byMethod: sortedRecord(Object.fromEntries(METHODS.map((m) => [m, created.filter((x) => x.method === m).length]))), lists: created.reduce((n, x) => n + (x.summary["createdLists"] ?? 0), 0) };
  const m6 = records.filter((x) => x.method === "M6" && x.steps > 0);
  const cellMayClip = {
    m6Cases: m6.length,
    warned: m6.filter((x) => (x.planIssues["FRAG_CELL_MAY_CLIP"] ?? 0) > 0).length,
    notWarned: m6.filter((x) => (x.planIssues["FRAG_CELL_MAY_CLIP"] ?? 0) === 0).length,
  };

  const paragraphIdDup = {
    collidesWithTarget: records.filter((x) => x.codes.some((c) => c.endsWith("INST_DUP_ID:paraId"))).length,
    duplicateInsideSourceFragment: records.filter((x) => x.codes.some((c) => c.endsWith("INST_DUP_ID:paraId.inFragment"))).length,
  };
  const defects = records
    .filter((x) => x.outcome === "defect")
    .map((x) => {
      const p = r.pairLog.find((q) => q.n === x.pair);
      return { case: x.caseId, method: x.method, codes: x.codes, site: x.site, src: p?.src, tgt: p?.tgt, third: x.method === "M8" ? p?.third : undefined, window: p?.window, parts: x.parts };
    });

  // 자원 재사용·추가(통째로 대상 끝에 넣은 M1)
  const m1 = records.filter((x) => x.method === "M1" && x.steps > 0);
  const resourceStats = {
    basis: "M1(통째로 끝에)",
    cases: m1.length,
    reusedResources: dist(m1.map((x) => x.summary["reusedResources"] ?? 0)),
    addedResources: dist(m1.map((x) => x.summary["addedResources"] ?? 0)),
    reusedBinaries: dist(m1.map((x) => x.summary["reusedBinaries"] ?? 0)),
    addedBinaries: dist(m1.map((x) => x.summary["addedBinaries"] ?? 0)),
    reissuedIds: dist(m1.map((x) => x.summary["reissuedIds"] ?? 0)),
    renamedBookmarks: dist(m1.map((x) => x.summary["renamedBookmarks"] ?? 0)),
    styleNameCollisions: { total: m1.reduce((n, x) => n + (x.summary["renamedStyles"] ?? 0), 0), casesWithCollision: m1.filter((x) => (x.summary["renamedStyles"] ?? 0) > 0).length, perCase: dist(m1.map((x) => x.summary["renamedStyles"] ?? 0)) },
    reuseRatePercent: dist(m1.map((x) => pct(x.summary["reusedResources"] ?? 0, (x.summary["reusedResources"] ?? 0) + (x.summary["addedResources"] ?? 0)))),
    m7SecondAddedResources: dist(records.filter((x) => x.method === "M7" && x.steps === 2).map((x) => x.summary["secondAddedResources"] ?? 0)),
    splitAddedSumDiffers: {
      withDanglingSource: records.filter((x) => (x.notes["split.addedSumDiffers"] ?? 0) > 0 && x.dangling).length,
      withoutDanglingSource: records.filter((x) => (x.notes["split.addedSumDiffers"] ?? 0) > 0 && !x.dangling).length,
    },
    danglingSourceCases: records.filter((x) => x.dangling).length,
    danglingSourceKindsInM1: (() => {
      const kinds: Record<string, number> = {};
      for (const x of m1) for (const k of Object.keys(x.danglingSpaces)) bump(kinds, k);
      return sortedRecord(kinds);
    })(),
  };

  const usedWindows = r.pairLog.map((p) => p.window);
  const det = records.filter((x) => x.deterministic !== null);
  const oks = records.filter((x) => x.outcome === "ok" || x.outcome === "inherited");
  const pairs = r.drawn.pairs.slice(0, r.pairLog.length);

  return {
    schema: "hwpx-studio/stress-report@1",
    tool: {
      seed: r.opts.seed,
      pairsRequested: r.opts.pairs,
      minParas: r.opts.minParas,
      maxParas: r.opts.maxParas,
      oracleSample: r.opts.oracleSample,
      noCom: r.opts.noCom,
      noRhwp: r.opts.noRhwp,
      methods: [...METHODS],
      timeBudgetMin: r.opts.timeBudgetMin,
      truncatedByTimeBudget: r.truncated,
      node: process.version,
    },
    engine: { sourceFiles: r.engine.files, sourceFingerprint: r.engine.all, fragmentImportFingerprint: r.engine.importTs },
    corpus: {
      hwpxFiles: r.snapStart.hwpxFiles,
      totalBytes: r.snapStart.totalBytes,
      opened: entries.length,
      openFailures: sortedRecord(index.failures),
      before: r.snapStart,
      after: r.snapEnd,
      unchanged: r.unchanged,
    },
    index: indexReport,
    pairs: {
      requested: r.opts.pairs,
      run: r.pairLog.length,
      pairErrors: r.pairErrors,
      sourceCandidates: r.drawn.sources,
      sourcePool: r.drawn.pool,
      distinctSources: new Set(pairs.map((p) => p.src.file.id)).size,
      distinctTargets: new Set(pairs.map((p) => p.tgt.file.id)).size,
      styleSetDiffers: pairs.filter((p) => p.styleDiffers).length,
      fontSetDiffers: pairs.filter((p) => p.fontDiffers).length,
      folderDiffers: pairs.filter((p) => p.folderDiffers).length,
      list: r.pairLog,
    },
    windows: {
      length: dist(usedWindows.map((w) => w.len)),
      score: dist(usedWindows.map((w) => w.score)),
      objectKinds: dist(usedWindows.map((w) => w.kinds)),
      distinctCharPrs: dist(usedWindows.map((w) => w.charPrs)),
      distinctParaPrs: dist(usedWindows.map((w) => w.paraPrs)),
      maxTableDepth: dist(usedWindows.map((w) => w.depth)),
      withTables: usedWindows.filter((w) => w.tables > 0).length,
      withNestedTables: usedWindows.filter((w) => w.depth >= 2).length,
      withPictures: usedWindows.filter((w) => w.pics > 0).length,
      withFields: usedWindows.filter((w) => w.fields > 0).length,
      withClickHereFields: usedWindows.filter((w) => w.clickHere > 0).length,
      withBookmarks: usedWindows.filter((w) => w.bookmarks > 0).length,
      withFootEndNotes: usedWindows.filter((w) => w.notes > 0).length,
      withTextBoxes: usedWindows.filter((w) => w.boxes > 0).length,
      withHeaderFooter: usedWindows.filter((w) => w.headerFooter > 0).length,
    },
    methods,
    totals,
    codes: { ...codes, rejectedByPhase: sortedRecord(rejectedByPhase), rejectedDetail: sortedRecord(rejectedDetail), byMethod: sortedRecord(byMethodCodes), validatorNewErrorIssues: sortedRecord(newErrorIssues), planWarningCases: sortedRecord(planWarnings), paragraphIdDuplicateCases: paragraphIdDup },
    defects,
    formatCombination: formatReport,
    inheritedPlan,
    createdLists,
    cellMayClip,
    resources: resourceStats,
    fragmentListNeeds: { basis: "쌍마다 통째 조각이 요구하는 자원 종류와 대상 header의 목록 유무", ...sortedRecord(r.listNeeds) },
    toolCoverage: sortedRecord(toolNotes),
    determinism: { sampled: det.length, same: det.filter((x) => x.deterministic === "same").length, differ: det.filter((x) => x.deterministic === "differ").length },
    time: {
      caseMs: dist(records.map((x) => x.ms)),
      pairMs: dist(r.pairLog.map((p) => p.ms)),
      campaignSeconds: Math.round(r.campaignMs / 100) / 10,
      indexSeconds: Math.round(index.ms / 100) / 10,
      totalSeconds: Math.round(r.totalMs / 100) / 10,
    },
    oracle: r.oracleSummary,
    oracleCandidatesConsidered: oks.length,
    tempDirEmptiedAtEnd: r.tmpEmpty,
  };
}

function printSummary(report: ReportShape): void {
  const lines = ["", "방식    건   ok  거절  상속  결함  건너뜀"];
  for (const [m, v] of Object.entries(report.methods)) {
    lines.push(`${m.padEnd(4)} ${String(v["cases"]).padStart(5)} ${String(v["ok"]).padStart(5)} ${String(v["rejected"]).padStart(5)} ${String(v["inherited"]).padStart(5)} ${String(v["defect"]).padStart(5)} ${String(v["skipped"]).padStart(6)}`);
  }
  const t = report.totals;
  lines.push(`합계 ${String(t["cases"]).padStart(5)} ${String(t["ok"]).padStart(5)} ${String(t["rejected"]).padStart(5)} ${String(t["inherited"]).padStart(5)} ${String(t["defect"]).padStart(5)} ${String(t["skipped"]).padStart(6)}`);
  lines.push(`코퍼스 무변경: ${report.corpus.unchanged}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

try {
  process.exitCode = main();
} catch (e) {
  // 메시지에는 경로나 문서 값이 섞일 수 있어 이름과 코드만 낸다.
  process.stderr.write(`오류: ${e instanceof Error ? `${e.name}${"code" in e ? ` ${String((e as { code: unknown }).code)}` : ""}` : "알 수 없음"}\n`);
  removeStressDir();
  process.exitCode = 1;
}
