// 실제 문서 모음 대조 도구(V1·V2·V8). 문서마다 rhwp와 엔진으로 열고, 모든 쪽의 문서 좌표 있는 런을 엔진 주소로 옮겨
// 런의 글이 엔진 논리 텍스트의 그 자리와 같은지 본다. 이름·글 내용은 보고하지 않는다(식별자 = 모음 기준 상대 경로 sha256 앞 10자).
//
//   node packages/viewer/tools/crosscheck.ts --corpus <폴더> [--limit N] --report <경로> [--oracles] [--timing N]
//        [--clicks] [--after-fill] [--clicks-only] [--click-pages N] [--click-runs N]
//
//   --corpus   `.hwpx`를 하위 폴더까지 모두 찾는 폴더(읽기만). 환경변수 HWPX_CORPUS_DIR도 받는다.
//   --limit    N개만(모음 전체에서 고르게 건너뛰며 뽑는다). 생략하면 전부.
//   --report   보고 JSON 경로. `tools/stress/out/` 안이어야 한다(그 폴더는 git에서 제외된다).
//   --oracles  rhwp 자신의 글·컨트롤 개수·표 크기와도 대조한다(느리다).
//   --timing   쪽 수 상위 N개 문서의 열기·그리기·글자 배치·클릭 시간을 잰다(기본 3).
//   --timing-only  글 대조는 하지 않고 쪽 수만 세어 --timing만 한다(다른 작업이 없는 때 시간만 다시 잴 때).
//   --clicks   클릭 경로 대조도 한다: 문서마다 쪽에서 글자 사각형의 왼쪽·오른쪽 4분의 1, 빈 곳(런 옆·쪽 전체·표 칸 한가운데), 문서 좌표 없는 글, 머리말·꼬리말 글을 눌러
//              실제 경로(`pick` → `locatePicked`)로 엔진 주소를 얻고, 글자는 엔진 논리 텍스트를 직접 읽어 눌린 글자와 비교한다(대응표를 쓰지 않는다).
//   --after-fill  (--clicks와 함께) 문서의 채울 수 있는 첫 자리를 채운 결과(엔진이 줄 배치 정보를 지운 구역을 rhwp가 다시 배치한다)에서도 같은 대조를 한다.
//   --clicks-only  글 대조(V2)는 건너뛰고 클릭 경로 대조만 한다.
//   --click-pages  문서마다 누르는 쪽 수 상한(기본 30, 고르게 뽑는다). --click-runs  쪽마다 누르는 런 수 상한(기본 80).
// 종료 코드: 0 정상(조용한 불일치 0, 영역 오판 0), 1 조용한 불일치나 영역 오판이 있음, 2 인자 오류.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRhwp, openDocument } from "../src/rhwp/index.ts";
import { scanCorpus, sameStat, snapshotOf, type CorpusFile } from "../../../tools/stress/corpus.ts";
import { POINT_KINDS, RUN_CLASSES, checkClicks, checkDocument, fillOnce, mergeClickReports, mergeReports, measureDocument, newClickReport, newReport, silentTotal, type ClickReport, type DocReport, type Timing } from "./verify.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outDir = resolve(repoRoot, "tools/stress/out");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const corpus = arg("corpus") ?? process.env["HWPX_CORPUS_DIR"];
if (corpus === undefined || corpus === "") fail("--corpus <폴더>(또는 HWPX_CORPUS_DIR)가 필요합니다.");
const reportArg = arg("report");
if (reportArg === undefined) fail("--report <경로>가 필요합니다.");
const reportPath = resolve(reportArg);
if (!(reportPath === outDir || reportPath.startsWith(outDir + sep))) fail("보고 파일은 tools/stress/out/ 안에만 쓸 수 있습니다.");
const limit = arg("limit") === undefined ? undefined : Number(arg("limit"));
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) fail("--limit은 1 이상의 정수여야 합니다.");
const oracles = flag("oracles");
const timingTop = arg("timing") === undefined ? 3 : Number(arg("timing"));
const timingOnly = flag("timing-only");
const afterFill = flag("after-fill");
const clicksOnly = flag("clicks-only");
const clicks = flag("clicks") || afterFill || clicksOnly;
const clickPages = arg("click-pages") === undefined ? 30 : Number(arg("click-pages"));
const clickRuns = arg("click-runs") === undefined ? 80 : Number(arg("click-runs"));
if (!Number.isInteger(clickPages) || clickPages < 1 || !Number.isInteger(clickRuns) || clickRuns < 1) fail("--click-pages·--click-runs는 1 이상의 정수여야 합니다.");

const sha10 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 10);

await loadRhwp({ wasmBytes: readFileSync(new URL("./rhwp_bg.wasm", import.meta.resolve("@rhwp/core"))) });

const all = scanCorpus(resolve(corpus));
const before = snapshotOf(all);
const stride = limit === undefined || limit >= all.length ? 1 : all.length / limit;
const picked: CorpusFile[] = [];
for (let i = 0; i < (limit === undefined ? all.length : Math.min(limit, all.length)); i++) {
  const f = all[Math.floor(i * stride)];
  if (f !== undefined) picked.push(f);
}

type DocLine = {
  id: string;
  contentId: string;
  bytes: number;
  engine: DocReport["engine"];
  rhwp: DocReport["rhwp"];
  pages: number;
  runs: DocReport["runs"];
  char: number;
  paragraph: number;
  none: number;
  silent: number;
  ms: number;
  /** 문서에서 많은 사유(최대 4개, 수량 순) */
  topReasons: Record<string, number>;
  /** 클릭 경로 대조(`--clicks`): 누른 점·조용한 불일치·영역 오판(그 문서의 수량) */
  clicks?: { presses: number; silent: number; regionBad: number };
  /** 채운 뒤 문서의 클릭 경로 대조(`--after-fill`) */
  afterFill?: { filled: boolean; presses: number; silent: number; regionBad: number };
  crash?: string;
};

const total = newReport();
const clickTotal = newClickReport();
const fillTotal = newClickReport();
let filledDocs = 0;
let fillFailed = 0;
const clickSilentDocs: string[] = [];
const pressesOf = (c: ClickReport): number => POINT_KINDS.reduce((n, k) => n + c.presses[k], 0);
const lines: DocLine[] = [];
let changed = 0;
const engineFail: Record<string, number> = {};
const rhwpFail: Record<string, number> = {};
const silentDocs: string[] = [];
const started = Date.now();

for (const f of picked) {
  if (!sameStat(f)) {
    changed++;
    continue;
  }
  const bytes = new Uint8Array(readFileSync(f.abs));
  const t0 = performance.now();
  let r: DocReport;
  let crash: string | undefined;
  try {
    if (clicksOnly) {
      r = newReport();
    } else if (timingOnly) {
      // 글 대조 없이 쪽 수만
      r = newReport();
      try {
        const d = openDocument(bytes);
        r.rhwp.ok = true;
        r.engine.ok = true;
        r.pages = d.pageCount();
        d.free();
      } catch (e) {
        r.rhwp.code = e !== null && typeof e === "object" && "code" in e ? String(e.code) : "UNKNOWN";
      }
    } else {
      r = checkDocument(bytes, { oracles });
    }
  } catch (e) {
    r = newReport();
    crash = (e instanceof Error ? e.name : typeof e) + (e !== null && typeof e === "object" && "code" in e ? `:${String(e.code)}` : "");
  }
  const ms = performance.now() - t0;
  if (!clicksOnly && !r.engine.ok) engineFail[r.engine.code ?? "?"] = (engineFail[r.engine.code ?? "?"] ?? 0) + 1;
  if (!clicksOnly && !r.rhwp.ok) rhwpFail[r.rhwp.code ?? "?"] = (rhwpFail[r.rhwp.code ?? "?"] ?? 0) + 1;
  mergeReports(total, r);
  const sums = RUN_CLASSES.reduce((a, c) => ({ char: a.char + r.classes[c].char, paragraph: a.paragraph + r.classes[c].paragraph, none: a.none + r.classes[c].none }), { char: 0, paragraph: 0, none: 0 });
  const silent = silentTotal(r);
  if (silent > 0) silentDocs.push(f.id);
  const line: DocLine = { id: f.id, contentId: sha10(bytes), bytes: bytes.length, engine: r.engine, rhwp: r.rhwp, pages: r.pages, runs: r.runs, ...sums, silent, ms: Math.round(ms), topReasons: Object.fromEntries(Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).slice(0, 4)) };
  if (crash !== undefined) line.crash = crash;
  if (clicks && crash === undefined && !timingOnly) {
    // 클릭 경로 대조(실제 경로: pick → locatePicked). 문서가 열리지 않으면 건너뛴다
    try {
      const cr = checkClicks(bytes, { pageCap: clickPages, runCap: clickRuns });
      mergeClickReports(clickTotal, cr);
      line.clicks = { presses: pressesOf(cr), silent: cr.silent, regionBad: cr.regionBad };
      if (cr.silent > 0 || cr.regionBad > 0) clickSilentDocs.push(f.id);
      if (clicksOnly) {
        line.engine = cr.engine;
        line.rhwp = cr.rhwp;
        line.pages = cr.pages;
        if (!cr.engine.ok) engineFail[cr.engine.code ?? "?"] = (engineFail[cr.engine.code ?? "?"] ?? 0) + 1;
        if (!cr.rhwp.ok) rhwpFail[cr.rhwp.code ?? "?"] = (rhwpFail[cr.rhwp.code ?? "?"] ?? 0) + 1;
      }
      if (afterFill && cr.engine.ok && cr.rhwp.ok) {
        const out = fillOnce(bytes);
        if (out === undefined) {
          fillFailed++;
          line.afterFill = { filled: false, presses: 0, silent: 0, regionBad: 0 };
        } else {
          filledDocs++;
          const ar = checkClicks(out, { pageCap: clickPages, runCap: clickRuns });
          mergeClickReports(fillTotal, ar);
          line.afterFill = { filled: true, presses: pressesOf(ar), silent: ar.silent, regionBad: ar.regionBad };
          if (ar.silent > 0 || ar.regionBad > 0) clickSilentDocs.push(`${f.id}:after-fill`);
        }
      }
    } catch (e) {
      line.crash = (e instanceof Error ? e.name : typeof e) + (e !== null && typeof e === "object" && "code" in e ? `:${String(e.code)}` : "");
    }
  }
  lines.push(line);
}

// V8: 쪽 수 상위 문서(내용이 같은 것은 한 번만)의 시간
const timings: { id: string; timing: Timing }[] = [];
if (timingTop > 0) {
  const seen = new Set<string>();
  const top = [...lines]
    .filter((l) => l.rhwp.ok)
    .sort((a, b) => b.pages - a.pages)
    .filter((l) => (seen.has(l.contentId) ? false : (seen.add(l.contentId), true)))
    .slice(0, timingTop);
  for (const l of top) {
    const file = picked.find((p) => p.id === l.id);
    if (file === undefined) continue;
    const timing = measureDocument(new Uint8Array(readFileSync(file.abs)));
    if (timing !== undefined) timings.push({ id: l.id, timing });
  }
}

const after = snapshotOf(scanCorpus(resolve(corpus)));
const unique = new Set(lines.map((l) => l.contentId)).size;
const checkedClasses: Record<string, unknown> = {};
for (const c of RUN_CLASSES) {
  const s = total.classes[c];
  checkedClasses[c] = { ...s, charRate: s.runs === 0 ? null : Number(((s.char / s.runs) * 100).toFixed(2)) };
}
const sumRuns = RUN_CLASSES.reduce((n, c) => n + total.classes[c].runs, 0);
const sumChar = RUN_CLASSES.reduce((n, c) => n + total.classes[c].char, 0);

/** 클릭 경로 대조 합계의 보고 모양(수량과 사유 코드만) */
function clickSummary(c: ClickReport): Record<string, unknown> {
  return {
    docs: lines.filter((l) => l.clicks !== undefined).length,
    pages: c.pages,
    sampledPages: c.sampledPages,
    presses: c.presses,
    byKind: c.byKind,
    blankBy: c.blankBy,
    blankPlaces: c.blankPlaces,
    blankPlaceReasons: Object.fromEntries(Object.entries(c.blankPlaceReasons).sort((a, b) => b[1] - a[1])),
    blankCellReasons: Object.fromEntries(Object.entries(c.blankCellReasons).sort((a, b) => b[1] - a[1])),
    reasons: Object.fromEntries(Object.entries(c.reasons).sort((a, b) => b[1] - a[1])),
    silent: c.silent,
    silentKinds: c.silentKinds,
    regionBad: c.regionBad,
    regionKinds: c.regionKinds,
    glyphRegions: c.glyphRegions,
    hitDisagree: c.hitDisagree,
    skipped: c.skipped,
    errors: c.errors,
  };
}

const report = {
  schema: "hwpx-studio/viewer-crosscheck@1",
  note: "문서 이름·글 내용 없음. id는 모음 기준 상대 경로 sha256 앞 10자, contentId는 바이트 sha256 앞 10자.",
  options: { limit: limit ?? null, oracles, timingTop, clicks, afterFill, clicksOnly, clickPages, clickRuns },
  corpus: { files: all.length, picked: picked.length, uniqueContents: unique, changedDuringRun: changed, unchangedAfter: before.listDigest === snapshotOf(all).listDigest && before.listDigest === after.listDigest },
  opened: {
    engineOk: lines.filter((l) => l.engine.ok).length,
    rhwpOk: lines.filter((l) => l.rhwp.ok).length,
    both: lines.filter((l) => l.engine.ok && l.rhwp.ok).length,
    engineFail,
    rhwpFail,
    crashes: lines.filter((l) => l.crash !== undefined).length,
  },
  runs: total.runs,
  pages: total.pages,
  classes: checkedClasses,
  overall: { runs: sumRuns, char: sumChar, charRate: sumRuns === 0 ? null : Number(((sumChar / sumRuns) * 100).toFixed(2)), silent: silentTotal(total) },
  reasons: Object.fromEntries(Object.entries(total.reasons).sort((a, b) => b[1] - a[1])),
  silentKinds: total.silentKinds,
  oracle: total.oracle,
  oracleKinds: Object.fromEntries(Object.entries(total.oracleKinds).sort((a, b) => b[1] - a[1]).slice(0, 40)),
  silentDocs,
  ...(clicks
    ? {
        clicks: { ...clickSummary(clickTotal), silentDocs: clickSilentDocs },
        ...(afterFill ? { afterFill: { filledDocs, notFilled: fillFailed, ...clickSummary(fillTotal) } } : {}),
      }
    : {}),
  timings,
  seconds: Math.round((Date.now() - started) / 1000),
  docs: lines,
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 1));
const rel = relative(repoRoot, reportPath).split(sep).join("/");
console.log(
  `문서 ${lines.length}건(내용 기준 ${unique}건) 열림 엔진 ${report.opened.engineOk} / rhwp ${report.opened.rhwpOk}; 런 검사 ${sumRuns}: char ${sumChar} (${report.overall.charRate}%), 조용한 불일치 ${report.overall.silent}; 보고 ${rel}`,
);
if (clicks) {
  console.log(
    `클릭 경로: 문서 ${lines.filter((l) => l.clicks !== undefined).length}건, 누른 점 ${pressesOf(clickTotal)}(글자 ${clickTotal.presses.glyph}, 빈 곳 ${clickTotal.presses.blank}, 좌표 없는 글 ${clickTotal.presses.unpositioned}, 머리말·꼬리말·각주 글 ${clickTotal.presses.marker}); 글자 눌림 결과 ${JSON.stringify(clickTotal.byKind.glyph)}; 조용한 불일치 ${clickTotal.silent}, 영역 오판 ${clickTotal.regionBad}, 오류 ${clickTotal.errors}`,
  );
  if (afterFill) {
    console.log(
      `채운 뒤: 채운 문서 ${filledDocs}건(채우지 못한 ${fillFailed}건), 누른 점 ${pressesOf(fillTotal)}; 글자 눌림 결과 ${JSON.stringify(fillTotal.byKind.glyph)}; 조용한 불일치 ${fillTotal.silent}, 영역 오판 ${fillTotal.regionBad}, 오류 ${fillTotal.errors}`,
    );
  }
}
const clicksClean = !clicks || (clickTotal.silent === 0 && clickTotal.regionBad === 0 && fillTotal.silent === 0 && fillTotal.regionBad === 0);
process.exit(silentTotal(total) === 0 && silentDocs.length === 0 && changed === 0 && clicksClean ? 0 : 1);
