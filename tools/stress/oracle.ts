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

type Held = { caseId: string; method: string; risk: number; baseId: string; baseBytes: Uint8Array; file: string; meta: Record<string, number> };

/** 위험이 큰 결과를 임시 폴더에 모아 두는 제한 크기 풀. 넘치면 위험이 가장 낮은 것을 지운다. */
export class OraclePool {
  private held: Held[] = [];
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
    if (this.held.length >= this.cap && c.risk <= (this.held[this.held.length - 1]?.risk ?? 0)) return;
    const file = join(STRESS_DIR, "out", `${c.caseId}.hwpx`);
    writeFileSync(file, c.bytes);
    this.held.push({ caseId: c.caseId, method: c.method, risk: c.risk, baseId: c.baseId, baseBytes: c.baseBytes, file, meta: c.meta });
    this.held.sort((a, b) => b.risk - a.risk);
    while (this.held.length > this.cap) {
      const drop = this.held.pop();
      if (drop !== undefined) rmSync(drop.file, { force: true });
    }
  }

  /** 위험 순으로 `n`개를 고른다. 한 방식이 표본을 독차지하지 않게 방식마다 상한(n의 40%)을 두고, 모자라면 상한 없이 채운다. */
  select(n: number): { caseId: string; method: string; risk: number; file: string; baseId: string; baseFile: string; meta: Record<string, number> }[] {
    const cap = Math.max(1, Math.ceil(n * 0.4));
    const perMethod: Record<string, number> = {};
    const picked: Held[] = [];
    for (const h of this.held) {
      if (picked.length >= n) break;
      if ((perMethod[h.method] ?? 0) >= cap) continue;
      perMethod[h.method] = (perMethod[h.method] ?? 0) + 1;
      picked.push(h);
    }
    for (const h of this.held) {
      if (picked.length >= n) break;
      if (!picked.includes(h)) picked.push(h);
    }
    for (const h of this.held) if (!picked.includes(h)) rmSync(h.file, { force: true });
    return picked.map((h) => {
      const baseFile = join(STRESS_DIR, "base", `${h.baseId}.hwpx`);
      if (!existsSync(baseFile)) writeFileSync(baseFile, h.baseBytes);
      return { caseId: h.caseId, method: h.method, risk: h.risk, file: h.file, baseId: h.baseId, baseFile, meta: h.meta };
    });
  }

  size(): number {
    return this.held.length;
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

export type OracleSummary = {
  sample: number;
  methods: Record<string, number>;
  /** 표본의 구성: 포함 요소가 있는 건 수와 구간 길이 분포 */
  composition: Record<string, number>;
  windowLen: Dist;
  /** 건별 수량(식별자·쪽 수·문단 수만) */
  rows: Record<string, unknown>[];
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
  };
  const rows = entries.map((e) => ({
    case: e.caseId,
    method: e.method,
    windowLen: e.meta["windowLen"] ?? null,
    expectedParagraphs: { topLevel: e.meta["insertedTop"] ?? null, all: e.meta["insertedAll"] ?? null },
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
