// 오라클 표본: 결과 HWPX를 OS 임시 폴더(hwpx-studio-stress/)에 두고 rhwp·한컴 COM으로 연다. 끝나면 폴더째 지운다.
// 결과에는 사례 식별자·종료 코드·쪽 수만 담는다. 파일 이름·문서 내용·rhwp가 출력한 제목·글꼴 목록은 버린다.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bump, dist, sortedRecord, type Dist } from "./stats.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..", "..");
export const STRESS_DIR = join(tmpdir(), "hwpx-studio-stress");
const RHWP = join(REPO, "hwpx-edit", ".cargo-root", "bin", "rhwp.exe");
const OPEN_CHECK = join(REPO, "tools", "com", "open_check.py");

export type Candidate = {
  caseId: string;
  method: string;
  risk: number;
  bytes: Uint8Array;
  baseId: string;
  baseBytes: Uint8Array;
  /** 표본 구성 설명용 수량(구간 길이·포함 요소 수·예고된 문단 증가 등) */
  meta: Record<string, number>;
};

type Held = { caseId: string; method: string; risk: number; baseId: string; baseFile: string; file: string; meta: Record<string, number> };

/** 표본을 고를 때의 묶음: 서식 변경 조합(M10), 셀 안 삽입(M6), 없던 목록을 만들어 새로 통과하게 된 건, 그 밖 */
type Group = "M10" | "M6" | "listCreated" | "other";

const groupOf = (c: { method: string; meta: Record<string, number> }): Group =>
  c.method === "M10" ? "M10" : c.method === "M6" ? "M6" : (c.meta["createdLists"] ?? 0) > 0 ? "listCreated" : "other";

/** 위험이 큰 결과를 임시 폴더에 모아 두는 제한 크기 풀. 묶음마다 넘치면 위험이 가장 낮은 것을 지운다. */
export class OraclePool {
  private held: Record<Group, Held[]> = { M10: [], M6: [], listCreated: [], other: [] };
  private cap: number;
  constructor(cap: number) {
    this.cap = cap;
    this.reset();
  }

  /** 폴더를 비우고 다시 만든다. 이 폴더는 이 도구가 만든 것이다. */
  reset(): void {
    removeStressDir();
    mkdirSync(join(STRESS_DIR, "out"), { recursive: true });
    mkdirSync(join(STRESS_DIR, "base"), { recursive: true });
  }

  offer(c: Candidate): void {
    if (this.cap <= 0) return;
    const list = this.held[groupOf(c)];
    if (list.length >= this.cap && c.risk <= (list[list.length - 1]?.risk ?? 0)) return;
    const file = join(STRESS_DIR, "out", `${c.caseId}.hwpx`);
    writeFileSync(file, c.bytes);
    // 대상 원본 사본은 디스크에만 둔다(같은 문서는 한 번만 쓴다)
    const baseFile = join(STRESS_DIR, "base", `${c.baseId}.hwpx`);
    if (!existsSync(baseFile)) writeFileSync(baseFile, c.baseBytes);
    list.push({ caseId: c.caseId, method: c.method, risk: c.risk, baseId: c.baseId, baseFile, file, meta: c.meta });
    list.sort((a, b) => b.risk - a.risk);
    while (list.length > this.cap) {
      const drop = list.pop();
      if (drop !== undefined) rmSync(drop.file, { force: true });
    }
  }

  /**
   * 표본 `n`개를 고른다. 서식 변경 조합(M10)과 셀 안 삽입(M6)에 각각 `n`의 20%, 없던 목록을 만들어 새로 통과하게 된 건에 10%를 먼저 배정하고
   * (M6는 `FRAG_CELL_MAY_CLIP` 경고가 난 건을 절반까지 먼저 담는다), 나머지는 위험 순으로 채운다. 그 밖의 방식은 방식마다 상한(n의 40%)을 두고, 모자라면 상한 없이 채운다.
   */
  select(n: number): { caseId: string; method: string; risk: number; file: string; baseId: string; baseFile: string; meta: Record<string, number> }[] {
    const cap = Math.max(1, Math.ceil(n * 0.4));
    const picked: Held[] = [];
    const take = (list: Held[], k: number): void => {
      for (const h of list) {
        if (k <= 0 || picked.length >= n) break;
        if (picked.includes(h)) continue;
        picked.push(h);
        k--;
      }
    };
    const share = (p: number): number => Math.max(1, Math.round(n * p));
    take(this.held.M10, share(0.2));
    const clip = this.held.M6.filter((h) => (h.meta["cellClip"] ?? 0) > 0);
    take(clip, Math.ceil(share(0.2) / 2));
    take(this.held.M6, share(0.2) - picked.filter((h) => h.method === "M6").length);
    take(this.held.listCreated, share(0.1));
    const perMethod: Record<string, number> = {};
    for (const h of picked) perMethod[h.method] = (perMethod[h.method] ?? 0) + 1;
    const rest = Object.values(this.held).flat().sort((a, b) => b.risk - a.risk);
    for (const h of rest) {
      if (picked.length >= n) break;
      if (picked.includes(h) || h.method === "M10" || h.method === "M6" || (perMethod[h.method] ?? 0) >= cap) continue;
      perMethod[h.method] = (perMethod[h.method] ?? 0) + 1;
      picked.push(h);
    }
    for (const h of rest) {
      if (picked.length >= n) break;
      if (!picked.includes(h)) picked.push(h);
    }
    for (const h of rest) if (!picked.includes(h)) rmSync(h.file, { force: true });
    return picked.map((h) => ({ caseId: h.caseId, method: h.method, risk: h.risk, file: h.file, baseId: h.baseId, baseFile: h.baseFile, meta: h.meta }));
  }

  size(): number {
    return Object.values(this.held).reduce((n, l) => n + l.length, 0);
  }
}

/** 임시 폴더 비우기. 정확히 `hwpx-studio-stress` 폴더만 지운다. */
export function removeStressDir(): void {
  rmSync(STRESS_DIR, { recursive: true, force: true });
}

export function stressDirIsEmpty(): boolean {
  return !existsSync(STRESS_DIR) || readdirSync(STRESS_DIR).length === 0;
}

// ── rhwp ────────────────────────────────────────────────────────

export type RhwpResult = { exit: number | null; pages: number | null; paras: number | null; warnings: number | null; ms: number };

export function rhwpAvailable(): boolean {
  return existsSync(RHWP);
}

/** `rhwp info <파일> --json`. 출력에서 쪽 수·문단 수·경고 수만 꺼낸다. */
export function runRhwp(file: string): RhwpResult {
  const t0 = Date.now();
  const r = spawnSync(RHWP, ["info", file, "--json"], { encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const out: RhwpResult = { exit: r.status, pages: null, paras: null, warnings: null, ms: Date.now() - t0 };
  if (r.status === 0) {
    try {
      const j = JSON.parse(r.stdout) as { pageCount?: unknown; paraCount?: unknown; warnings?: unknown };
      if (typeof j.pageCount === "number") out.pages = j.pageCount;
      if (typeof j.paraCount === "number") out.paras = j.paraCount;
      if (Array.isArray(j.warnings)) out.warnings = j.warnings.length;
    } catch {
      out.exit = -1; // JSON을 읽지 못함
    }
  }
  return out;
}

// ── 한컴 COM ────────────────────────────────────────────────────

export type ComResult = { opened: boolean; pages: number | null; pdf: { saved: boolean; bytes: number } | null; error: string | null; timeout: boolean; seconds: number };
export type ComRun = { results: Map<string, ComResult>; aborted: string | null; processesLeft: number | null; version: string | null; hwpBefore: number | null; ran: boolean };

export function comAvailable(): boolean {
  return existsSync(OPEN_CHECK);
}

/** `python tools/com/open_check.py`로 파일들을 연다. 결과는 파일 이름(사례 식별자)으로 찾는다. */
export function runCom(files: string[], pdfDir: string | undefined): ComRun {
  const out = join(STRESS_DIR, "com-result.json");
  const args = [OPEN_CHECK, "--out", out, ...(pdfDir === undefined ? [] : ["--pdf-dir", pdfDir]), ...files];
  const r = spawnSync("python", args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: Math.max(600_000, files.length * 75_000) });
  const run: ComRun = { results: new Map(), aborted: null, processesLeft: null, version: null, hwpBefore: null, ran: false };
  if (r.status !== 0 || !existsSync(out)) return run;
  const j = JSON.parse(readFileSync(out, "utf8")) as {
    results: (ComResult & { file: string })[];
    aborted: string | null;
    hwp_processes_left_by_this_run: number;
    hancom_version: string | null;
    hwp_pids_before: number;
  };
  run.ran = true;
  run.aborted = j.aborted;
  run.processesLeft = j.hwp_processes_left_by_this_run;
  run.version = j.hancom_version;
  run.hwpBefore = j.hwp_pids_before;
  for (const x of j.results) run.results.set(x.file, x);
  return run;
}

// ── 집계 ────────────────────────────────────────────────────────

export type OracleEntry = {
  caseId: string;
  method: string;
  risk: number;
  base: string;
  meta: Record<string, number>;
  rhwp?: RhwpResult & { basePages: number | null; baseParas: number | null; baseWarnings: number | null; baseExit: number | null };
  hancom?: ComResult & { basePages: number | null; baseOpened: boolean };
};

const histogram = (deltas: number[]): Record<string, number> => {
  const h: Record<string, number> = {};
  for (const d of deltas) bump(h, d > 10 ? ">10" : String(d));
  return sortedRecord(h);
};

/** 쪽 수 변화(결과 - 원본)의 분포를 건 묶음마다 낸다. 열리지 않았거나 쪽 수를 읽지 못한 건은 뺀다. */
type DeltaSplit = { cases: number; rhwpOpened: number; hancomOpened: number; rhwpPagesDelta: Record<string, number>; hancomPagesDelta: Record<string, number> };

export type OracleSummary = {
  sample: number;
  methods: Record<string, number>;
  /** 표본의 구성: 포함 요소가 있는 건 수와 구간 길이 분포 */
  composition: Record<string, number>;
  windowLen: Dist;
  /** 건별 수량(식별자·쪽 수·문단 수만) */
  rows: Record<string, unknown>[];
  /** 셀 안 삽입(M6) 표본을 계획이 `FRAG_CELL_MAY_CLIP` 경고를 낸 건과 아닌 건으로 갈라 본 쪽 수 변화 */
  cellMayClip: { flagged: DeltaSplit; notFlagged: DeltaSplit };
  /** 없던 목록을 만들어 새로 통과하게 된 건(plan.summary.createdLists > 0)과 서식 변경 조합(M10) */
  listCreated: DeltaSplit;
  formatCombination: DeltaSplit;
  /** rhwp가 센 문단 수의 증가가 계획이 예고한 문단 증가(최상위 문단 수, 하위 목록 포함 전체)와 같은 건 수 */
  rhwpParagraphDelta: { equalsTopLevel: number; equalsAll: number; equalsEither: number; neither: number } | null;
  rhwp: { ran: boolean; ok: number; fail: number; failures: { case: string; exit: number | null }[]; baseFail: number; warningsIncreased: number; pagesDelta: Record<string, number>; shrink: string[]; pages: Dist; deltas: Dist; ms: Dist } | null;
  hancom: {
    ran: boolean;
    opened: number;
    notOpened: number;
    failures: { case: string; error: string | null; timeout: boolean }[];
    baseNotOpened: number;
    pagesDelta: Record<string, number>;
    shrink: string[];
    pdf: { requested: number; saved: number };
    aborted: string | null;
    version: string | null;
    hwpProcessesBefore: number | null;
    hwpProcessesLeft: number | null;
    seconds: Dist;
  } | null;
};

function split(list: OracleEntry[]): DeltaSplit {
  const rhwp: number[] = [];
  const hancom: number[] = [];
  for (const e of list) {
    if (e.rhwp?.exit === 0 && e.rhwp.pages !== null && e.rhwp.basePages !== null) rhwp.push(e.rhwp.pages - e.rhwp.basePages);
    if (e.hancom?.opened === true && e.hancom.pages !== null && e.hancom.basePages !== null) hancom.push(e.hancom.pages - e.hancom.basePages);
  }
  return {
    cases: list.length,
    rhwpOpened: list.filter((e) => e.rhwp?.exit === 0).length,
    hancomOpened: list.filter((e) => e.hancom?.opened === true).length,
    rhwpPagesDelta: histogram(rhwp),
    hancomPagesDelta: histogram(hancom),
  };
}

export function summarizeOracle(entries: OracleEntry[], rhwpRan: boolean, com: ComRun | null, pdfRequested: boolean): OracleSummary {
  const methods: Record<string, number> = {};
  for (const e of entries) bump(methods, e.method);
  const has = (key: string): number => entries.filter((e) => (e.meta[key] ?? 0) > 0).length;
  const composition: Record<string, number> = {
    withPictures: has("pics"),
    withClickHereFields: has("clickHere"),
    withNestedTables: entries.filter((e) => (e.meta["depth"] ?? 0) >= 2).length,
    withTextBoxes: has("boxes"),
    withFootEndNotes: has("notes"),
    withBookmarks: has("bookmarks"),
    withHeaderFooter: has("headerFooter"),
    windowLenAtLeast100: entries.filter((e) => (e.meta["windowLen"] ?? 0) >= 100).length,
    splitOrChainOrCell: entries.filter((e) => ["M4", "M5", "M6", "M8"].includes(e.method)).length,
    formatCombination: entries.filter((e) => e.method === "M10").length,
    cellMayClipWarned: entries.filter((e) => e.method === "M6" && (e.meta["cellClip"] ?? 0) > 0).length,
    listCreated: entries.filter((e) => (e.meta["createdLists"] ?? 0) > 0).length,
  };
  const rows = entries.map((e) => ({
    case: e.caseId,
    method: e.method,
    windowLen: e.meta["windowLen"] ?? null,
    expectedParagraphs: { topLevel: e.meta["insertedTop"] ?? null, all: e.meta["insertedAll"] ?? null },
    cellMayClip: e.method === "M6" ? (e.meta["cellClip"] ?? 0) > 0 : null,
    createdLists: e.meta["createdLists"] ?? 0,
    rhwp: e.rhwp === undefined ? null : { exit: e.rhwp.exit, pages: e.rhwp.pages, basePages: e.rhwp.basePages, paras: e.rhwp.paras, baseParas: e.rhwp.baseParas, warnings: e.rhwp.warnings, baseWarnings: e.rhwp.baseWarnings },
    hancom: e.hancom === undefined ? null : { opened: e.hancom.opened, pages: e.hancom.pages, basePages: e.hancom.basePages, pdfSaved: e.hancom.pdf?.saved ?? null },
  }));
  let paraDelta: OracleSummary["rhwpParagraphDelta"] = null;
  if (rhwpRan) {
    paraDelta = { equalsTopLevel: 0, equalsAll: 0, equalsEither: 0, neither: 0 };
    for (const e of entries) {
      if (e.rhwp?.exit !== 0 || e.rhwp.paras === null || e.rhwp.baseParas === null) continue;
      const d = e.rhwp.paras - e.rhwp.baseParas;
      const top = d === e.meta["insertedTop"];
      const all = d === e.meta["insertedAll"];
      if (top) paraDelta.equalsTopLevel++;
      if (all) paraDelta.equalsAll++;
      if (top || all) paraDelta.equalsEither++;
      else paraDelta.neither++;
    }
  }
  const summary: OracleSummary = {
    sample: entries.length,
    methods: sortedRecord(methods),
    composition,
    windowLen: dist(entries.map((e) => e.meta["windowLen"] ?? 0)),
    rows,
    rhwpParagraphDelta: paraDelta,
    cellMayClip: {
      flagged: split(entries.filter((e) => e.method === "M6" && (e.meta["cellClip"] ?? 0) > 0)),
      notFlagged: split(entries.filter((e) => e.method === "M6" && (e.meta["cellClip"] ?? 0) === 0)),
    },
    listCreated: split(entries.filter((e) => (e.meta["createdLists"] ?? 0) > 0)),
    formatCombination: split(entries.filter((e) => e.method === "M10")),
    rhwp: null,
    hancom: null,
  };

  if (rhwpRan) {
    const withR = entries.filter((e) => e.rhwp !== undefined);
    const failures = withR.filter((e) => e.rhwp?.exit !== 0).map((e) => ({ case: e.caseId, exit: e.rhwp?.exit ?? null }));
    const deltas: number[] = [];
    const shrink: string[] = [];
    for (const e of withR) {
      if (e.rhwp?.exit === 0 && e.rhwp.pages !== null && e.rhwp.basePages !== null) {
        const d = e.rhwp.pages - e.rhwp.basePages;
        deltas.push(d);
        if (d < 0) shrink.push(e.caseId);
      }
    }
    summary.rhwp = {
      ran: true,
      ok: withR.length - failures.length,
      fail: failures.length,
      failures,
      baseFail: withR.filter((e) => e.rhwp?.baseExit !== 0).length,
      warningsIncreased: withR.filter((e) => e.rhwp?.warnings !== null && e.rhwp?.baseWarnings !== null && (e.rhwp?.warnings ?? 0) > (e.rhwp?.baseWarnings ?? 0)).length,
      pagesDelta: histogram(deltas),
      shrink,
      pages: dist(withR.flatMap((e) => (e.rhwp?.pages === null || e.rhwp?.pages === undefined ? [] : [e.rhwp.pages]))),
      deltas: dist(deltas),
      ms: dist(withR.map((e) => e.rhwp?.ms ?? 0)),
    };
  }
  if (com !== null && com.ran) {
    const withC = entries.filter((e) => e.hancom !== undefined);
    const failures = withC.filter((e) => e.hancom?.opened !== true).map((e) => ({ case: e.caseId, error: e.hancom?.error ?? null, timeout: e.hancom?.timeout ?? false }));
    const deltas: number[] = [];
    const shrink: string[] = [];
    for (const e of withC) {
      if (e.hancom?.opened === true && e.hancom.pages !== null && e.hancom.basePages !== null) {
        const d = e.hancom.pages - e.hancom.basePages;
        deltas.push(d);
        if (d < 0) shrink.push(e.caseId);
      }
    }
    summary.hancom = {
      ran: true,
      opened: withC.length - failures.length,
      notOpened: failures.length,
      failures,
      baseNotOpened: withC.filter((e) => e.hancom?.baseOpened !== true).length,
      pagesDelta: histogram(deltas),
      shrink,
      pdf: { requested: pdfRequested ? withC.length : 0, saved: withC.filter((e) => e.hancom?.pdf?.saved === true).length },
      aborted: com.aborted,
      version: com.version,
      hwpProcessesBefore: com.hwpBefore,
      hwpProcessesLeft: com.processesLeft,
      seconds: dist(withC.map((e) => e.hancom?.seconds ?? 0)),
    };
  }
  return summary;
}
