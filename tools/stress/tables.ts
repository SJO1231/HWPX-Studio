// 표 조정 스트레스 시험(엔진 명세 7.9절, 수용 조건 B7). 실제 문서 모음에서 병합·중첩이 든 표를 무작위로 골라 설정·크기·구조 연산을 적용하고,
// 다시 파싱·검사기 기준선 비교·표 불변식·보존 계약·연산별 사후 조건을 건마다 확인한다. 결과는 수량과 코드로만 기록한다.
//
// 실행: node tools/stress/tables.ts --corpus <폴더> [--seed N] [--docs M] [--ops K] [--com-sample N] [--no-com] [--prefer-merged-only] [--report <출력.json>]
//
// 원칙: 모음 폴더는 읽기만 한다(쓰기·이동·삭제 호출이 없다). 파일 이름·문서 내용은 어디에도 남기지 않고(식별자 = 상대 경로 sha256 앞 10자)
// 결과물은 OS 임시 폴더 아래 hwpx-studio-stress/ 에만 두었다가 끝나면 지운다. 모음 경로는 인자로만 받는다.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  childEls,
  type XElement,
  HwpxError,
  applyPlan,
  checkTableGeometry,
  compareToBaseline,
  generate,
  listTables,
  openPackage,
  parseDocument,
  planCloneTable,
  planDeleteColumns,
  planInsertColumns,
  planInsertRows,
  planMergeCells,
  planRepeatRows,
  planScaleTable,
  planSetCellProps,
  planSetColumnWidths,
  planSetRowHeights,
  planSetTableProps,
  planSplitCell,
  readDataset,
  readTableGrid,
  readTemplate,
  rowHeights,
  splitTolerated,
  validateDocument,
  attrValue,
  childEl,
  type EditPlan,
  type HwpxDocument,
  type TableInfo,
} from "../../packages/hwpx-engine/src/index.ts";
import { verifyPreservation } from "../../packages/hwpx-engine/src/fill/index.ts";
import { readCorpusFile, sameSnapshot, sameStat, scanCorpus, snapshotOf, type CorpusFile } from "./corpus.ts";
import { STRESS_DIR, comAvailable, removeStressDir, runCom } from "./oracle.ts";
import { hashSeed, makeRng, type Rng } from "./rng.ts";
import { bump, dist, pct, sortedRecord } from "./stats.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// ── 인자 ────────────────────────────────────────────────────────

type Options = { corpus: string; seed: number; docs: number; ops: number; comSample: number; noCom: boolean; preferMergedOnly: boolean; report: string };

function parseArgs(argv: string[]): Options {
  const o: Options = { corpus: "", seed: 1, docs: 150, ops: 1200, comSample: 20, noCom: false, preferMergedOnly: false, report: join(HERE, "out", "tables-report.json") };
  const num = (name: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < 0) throw new Error(`${name} 값이 올바르지 않다`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--corpus") o.corpus = next ?? "";
    else if (a === "--seed") o.seed = num(a, next);
    else if (a === "--docs") o.docs = num(a, next);
    else if (a === "--ops") o.ops = num(a, next);
    else if (a === "--com-sample") o.comSample = num(a, next);
    else if (a === "--report") o.report = resolve(next ?? "");
    else if (a === "--no-com") {
      o.noCom = true;
      continue;
    } else if (a === "--prefer-merged-only") {
      o.preferMergedOnly = true;
      continue;
    } else throw new Error(`알 수 없는 인자: ${a}`);
    i++;
  }
  if (o.corpus === "") throw new Error("--corpus <폴더>가 필요하다");
  return o;
}

// ── 관측(문서 모음 전체) ─────────────────────────────────────────

type Observed = {
  docsTried: number;
  docsOpened: number;
  docsWithTables: number;
  tables: number;
  nestedTables: number;
  topLevelTables: number;
  widthBasis: Record<string, number>;
  heightBasis: Record<string, number>;
  gridRegular: number;
  gridStructuralProblems: number;
  /** 구조는 규칙적인데 행끼리 열 경계의 위치가 어긋나거나 열 너비가 1 미만이라 열 너비가 필요한 연산을 거절하는 표(너비 불규칙) */
  gridWidthConflicts: number;
  /** 병합 셀로만 덮인 열(colSpan 1 셀이 없는 열)이 있는 규칙적인 표 */
  mergedOnlyColumnTables: number;
  cellzoneTables: number;
  /** 규칙적인 격자에서 표 높이와 행 높이 합의 관계 */
  heightVsRows: Record<string, number>;
  /** 규칙적인 격자에서 표 너비와 열 너비 합의 관계 */
  widthVsColumns: Record<string, number>;
  rowSumsMatchTableWidth: number;
  treatAsChar: Record<string, number>;
  pageBreak: Record<string, number>;
  repeatHeader: Record<string, number>;
  withMergedCells: number;
  maxRows: number;
  maxCols: number;
};

const newObserved = (): Observed => ({
  docsTried: 0,
  docsOpened: 0,
  docsWithTables: 0,
  tables: 0,
  nestedTables: 0,
  topLevelTables: 0,
  widthBasis: {},
  heightBasis: {},
  gridRegular: 0,
  gridStructuralProblems: 0,
  gridWidthConflicts: 0,
  mergedOnlyColumnTables: 0,
  cellzoneTables: 0,
  heightVsRows: {},
  widthVsColumns: {},
  rowSumsMatchTableWidth: 0,
  treatAsChar: {},
  pageBreak: {},
  repeatHeader: {},
  withMergedCells: 0,
  maxRows: 0,
  maxCols: 0,
});

function observe(doc: HwpxDocument, o: Observed): number {
  const infos = listTables(doc);
  if (infos.length > 0) o.docsWithTables++;
  for (const info of infos) {
    const el = info.target.element;
    const sz = childEl(el, "paragraph", "sz");
    o.tables++;
    if (info.depth > 0) o.nestedTables++;
    else o.topLevelTables++;
    bump(o.widthBasis, (sz === undefined ? undefined : attrValue(sz, "widthRelTo")) ?? "(없음)");
    bump(o.heightBasis, (sz === undefined ? undefined : attrValue(sz, "heightRelTo")) ?? "(없음)");
    bump(o.treatAsChar, String(info.treatAsChar));
    bump(o.pageBreak, info.pageBreak ?? "(없음)");
    bump(o.repeatHeader, String(info.repeatHeader));
    if (childEl(el, "paragraph", "cellzoneList") !== undefined) o.cellzoneTables++;
    o.maxRows = Math.max(o.maxRows, info.rowCnt ?? 0);
    o.maxCols = Math.max(o.maxCols, info.colCnt ?? 0);
    const grid = readTableGrid(el);
    if (grid.problems.length > 0) {
      o.gridStructuralProblems++;
      continue;
    }
    if (grid.widths === undefined) {
      o.gridWidthConflicts++;
      continue;
    }
    if (hasMergedOnlyColumn(grid.cells, grid.colCnt)) o.mergedOnlyColumnTables++;
    o.gridRegular++;
    if (info.mergedCells > 0) o.withMergedCells++;
    const heights = rowHeights(grid) ?? [];
    const sumH = heights.reduce((a, b) => a + b, 0);
    const sumW = grid.widths.reduce((a, b) => a + b, 0);
    bump(o.heightVsRows, info.height === undefined ? "(없음)" : info.height === sumH ? "같음" : info.height > sumH ? "표가 큼" : "표가 작음");
    bump(o.widthVsColumns, info.width === undefined ? "(없음)" : info.width === sumW ? "같음" : info.width > sumW ? "표가 큼" : "표가 작음");
    if (!checkTableGeometry(el).some((i) => i.code === "TABLE_WIDTH_SUM")) o.rowSumsMatchTableWidth++;
  }
  return infos.length;
}

// ── 건 기록 ─────────────────────────────────────────────────────

type Outcome = { cls: "ok" | "inherited" | "rejected" | "defect" | "skipped"; code: string };
type Defect = { caseId: string; doc: string; op: string; code: string; params: Record<string, unknown> };

const sha10 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 10);

/** 병합 셀로만 덮인 열(colSpan 1 셀이 하나도 없는 열)이 있는가. 엔진의 너비 추정을 쓰지 않고 셀의 주소·병합 수만 본다. */
function hasMergedOnlyColumn(cells: readonly { col: number; colSpan: number }[], colCnt: number): boolean {
  const single = new Set<number>();
  for (const c of cells) if (c.colSpan === 1) single.add(c.col);
  for (let k = 0; k < colCnt; k++) if (!single.has(k)) return true;
  return false;
}

/**
 * 엔진의 열 너비 추정을 쓰지 않는 독립 검사. 표의 `tr`·`tc`에서 주소·병합·너비를 직접 읽어 행마다 그 행을 덮는 셀의 너비를 더한다(위에서 내려온 세로 병합 포함).
 * `sums`는 행 번호 순의 합, `minCell`은 가장 작은 셀 너비, `ok`는 모든 셀의 주소·병합·너비를 정수로 읽었는가다.
 */
type WidthFacts = { ok: boolean; sums: number[]; tableWidth: number | undefined; minCell: number };
function widthFacts(table: XElement): WidthFacts {
  const int = (el: XElement | undefined, name: string): number | undefined => {
    const v = el === undefined ? undefined : attrValue(el, name);
    return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : undefined;
  };
  const rowCnt = int(table, "rowCnt");
  const sz = childEl(table, "paragraph", "sz");
  const out: WidthFacts = { ok: rowCnt !== undefined && rowCnt >= 0 && rowCnt <= 100000, sums: [], tableWidth: int(sz, "width"), minCell: Number.POSITIVE_INFINITY };
  if (!out.ok || rowCnt === undefined) return out;
  out.sums = new Array<number>(rowCnt).fill(0);
  for (const tr of childEls(table, "paragraph", "tr")) {
    for (const tc of childEls(tr, "paragraph", "tc")) {
      const r = int(childEl(tc, "paragraph", "cellAddr"), "rowAddr");
      const rs = int(childEl(tc, "paragraph", "cellSpan"), "rowSpan");
      const w = int(childEl(tc, "paragraph", "cellSz"), "width");
      if (r === undefined || rs === undefined || w === undefined || r < 0 || rs < 1) {
        out.ok = false;
        continue;
      }
      out.minCell = Math.min(out.minCell, w);
      for (let k = r; k < Math.min(rowCnt, r + rs); k++) out.sums[k] = (out.sums[k] ?? 0) + w;
    }
  }
  return out;
}

/**
 * 원본 표의 성질이 결과에서도 유지되는가(독립 검사): (a) 행마다 셀 너비 합이 표 너비와 같았다면 같고, (b) 행끼리 합이 같았다면 같고, (c) 모든 셀 너비가 1 이상이었다면 1 이상이다.
 * 원본이 그 성질을 갖지 않았다면 견주지 않는다. 읽지 못한 표는 견주지 않는다.
 */
function widthRegression(before: XElement, after: XElement): string[] {
  const a = widthFacts(before);
  const b = widthFacts(after);
  if (!a.ok || !b.ok) return [];
  const bad: string[] = [];
  const equalToTable = (f: WidthFacts): boolean => f.tableWidth !== undefined && f.sums.every((x) => x === f.tableWidth);
  const allEqual = (f: WidthFacts): boolean => f.sums.every((x) => x === f.sums[0]);
  if (equalToTable(a) && !equalToTable(b)) bad.push("widths:rowSumVsTable");
  if (allEqual(a) && !allEqual(b)) bad.push("widths:rowSumsDiffer");
  if (a.minCell >= 1 && b.minCell < 1) bad.push("widths:cellBelowOne");
  return bad;
}

/** 정규식으로 센 수량(독립 기준): 문단·표·그림·누름틀 시작·책갈피 */
function regexCensus(xml: string): { p: number; tbl: number; pic: number; field: number; bookmark: number } {
  const n = (re: RegExp): number => xml.match(re)?.length ?? 0;
  return { p: n(/<[A-Za-z0-9]+:p[ >]/g), tbl: n(/<[A-Za-z0-9]+:tbl[ >]/g), pic: n(/<[A-Za-z0-9]+:pic[ >]/g), field: n(/<[A-Za-z0-9]+:fieldBegin[ >]/g), bookmark: n(/<[A-Za-z0-9]+:bookmark[ >]/g) };
}

type Prepared = {
  kind: "plan" | "gate";
  /** 연산 이름과 인자 요약(결함 보고용, 값 원문 없음) */
  op: string;
  params: Record<string, unknown>;
  run: () => { plan?: EditPlan; bytes: Uint8Array; gateOk?: boolean; gateCodes?: string[] };
  /** 사후 조건: 문제가 있으면 코드 목록 */
  post: (after: HwpxDocument, afterBytes: Uint8Array) => string[];
  /** 표 개수가 그대로이고 표마다 불변식을 견줄 수 있는 연산인가(속성만 바꾸는 연산). 아니면 코드별로 새 종류의 위반만 본다. */
  keepsTableCount: boolean;
  risk: number;
};

// ── 연산 만들기 ─────────────────────────────────────────────────

const SIDES = ["left", "right", "top", "bottom"] as const;
const randomMargins = (rng: Rng): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const s of SIDES) if (rng.chance(0.5)) out[s] = rng.range(0, 1200);
  if (Object.keys(out).length === 0) out[rng.pick(SIDES)] = rng.range(0, 1200);
  return out;
};

function makeOp(doc: HwpxDocument, bytes: Uint8Array, info: TableInfo, kind: string, rng: Rng, baselineCensus: ReturnType<typeof validateDocument>["census"]): Prepared | undefined {
  const t = info.target;
  const grid = readTableGrid(t.element);
  const rows = grid.rowCnt;
  const cols = grid.colCnt;
  const merged = info.mergedCells > 0;
  const attrOnly = ["props", "cellProps", "columns", "scale", "rowHeights", "gateProps"].includes(kind);
  const base = { keepsTableCount: attrOnly, risk: (merged ? 3 : 0) + (info.depth > 0 ? 3 : 0) + (rows > 8 ? 1 : 0) + rng.range(0, 2) };
  const structural = (e: TableInfo | undefined): boolean => e !== undefined && readTableGrid(e.target.element).problems.length === 0;
  const regularNow = (d: HwpxDocument): TableInfo | undefined => listTables(d).find((x) => x.ordinal === info.ordinal && x.sectionIndex === info.sectionIndex);
  const planOp = (op: string, params: Record<string, unknown>, make: () => EditPlan, post: Prepared["post"], extra: Partial<Prepared> = {}): Prepared => ({
    kind: "plan",
    op,
    params,
    run: () => {
      const plan = make();
      return { plan, bytes: applyPlan(doc.pkg, plan) };
    },
    post,
    ...base,
    ...extra,
  });

  switch (kind) {
    case "props": {
      const props: Record<string, unknown> = {};
      if (rng.chance(0.5)) props["treatAsChar"] = rng.chance(0.5);
      if (rng.chance(0.5)) props["pageBreak"] = rng.pick(["CELL", "NONE", "TABLE"]);
      if (rng.chance(0.5)) props["repeatHeader"] = rng.chance(0.5);
      if (rng.chance(0.3)) props["cellSpacing"] = rng.range(0, 600);
      if (rng.chance(0.3)) props["hAlign"] = rng.pick(["LEFT", "CENTER", "RIGHT"]);
      if (rng.chance(0.3)) props["outMargin"] = randomMargins(rng);
      if (rng.chance(0.3)) props["inMargin"] = randomMargins(rng);
      if (Object.keys(props).length === 0) props["repeatHeader"] = rng.chance(0.5);
      return planOp("props", { keys: Object.keys(props) }, () => planSetTableProps(doc, t, props as never), (after) => {
        const now = regularNow(after);
        const bad: string[] = [];
        if (props["treatAsChar"] !== undefined && now?.treatAsChar !== props["treatAsChar"]) bad.push("treatAsChar");
        if (props["pageBreak"] !== undefined && now?.pageBreak !== props["pageBreak"]) bad.push("pageBreak");
        if (props["repeatHeader"] !== undefined && now?.repeatHeader !== props["repeatHeader"]) bad.push("repeatHeader");
        if (props["cellSpacing"] !== undefined && attrValue(now?.target.element as never, "cellSpacing") !== String(props["cellSpacing"])) bad.push("cellSpacing");
        const pos = now === undefined ? undefined : childEl(now.target.element, "paragraph", "pos");
        if (props["hAlign"] !== undefined && (pos === undefined || attrValue(pos, "horzAlign") !== props["hAlign"])) bad.push("hAlign");
        for (const side of ["outMargin", "inMargin"] as const) {
          const want = props[side] as Record<string, number> | undefined;
          const el = now === undefined ? undefined : childEl(now.target.element, "paragraph", side);
          if (want !== undefined) for (const [k, v] of Object.entries(want)) if (el === undefined || attrValue(el, k) !== String(v)) bad.push(side);
        }
        return bad.map((b) => `props:${b}`);
      });
    }
    case "cellProps": {
      const r0 = rng.range(0, Math.max(0, rows - 1));
      const c0 = rng.range(0, Math.max(0, cols - 1));
      const props: Record<string, unknown> = {};
      if (rng.chance(0.5)) props["vertAlign"] = rng.pick(["TOP", "CENTER", "BOTTOM"]);
      if (rng.chance(0.4)) props["lineWrap"] = rng.pick(["BREAK", "SQUEEZE"]);
      if (rng.chance(0.4)) props["header"] = rng.chance(0.5);
      if (rng.chance(0.3)) props["protect"] = rng.chance(0.5);
      if (rng.chance(0.3)) props["margin"] = randomMargins(rng);
      if (rng.chance(0.4)) {
        const border: Record<string, unknown> = { type: rng.pick(["SOLID", "DASH", "DOT", "NONE"]), width: rng.pick(["0.1 mm", "0.3 mm", "0.5 mm"]), color: rng.pick(["#FF0000", "#0000FF", "#000000"]) };
        if (rng.chance(0.5)) border["sides"] = [rng.pick(SIDES)];
        props["border"] = border;
      }
      if (Object.keys(props).length === 0) props["header"] = true;
      const entry = { rows: [r0, r0 + rng.range(0, 2)] as [number, number], cols: [c0, c0 + rng.range(0, 2)] as [number, number], props };
      return planOp("cellProps", { rows: entry.rows, cols: entry.cols, keys: Object.keys(props) }, () => planSetCellProps(doc, t, [entry as never]), (after) => {
        const now = regularNow(after);
        const bad: string[] = [];
        const g = now === undefined ? undefined : readTableGrid(now.target.element);
        if (g === undefined) return ["cellProps:table-lost"];
        for (const c of g.cells) {
          if (c.row < entry.rows[0] || c.row > entry.rows[1] || c.col < entry.cols[0] || c.col > entry.cols[1]) continue;
          if (props["header"] !== undefined && attrValue(c.tc, "header") !== (props["header"] ? "1" : "0")) bad.push("header");
          if (props["protect"] !== undefined && attrValue(c.tc, "protect") !== (props["protect"] ? "1" : "0")) bad.push("protect");
          const sub = childEl(c.tc, "paragraph", "subList");
          if (props["vertAlign"] !== undefined && sub !== undefined && attrValue(sub, "vertAlign") !== props["vertAlign"]) bad.push("vertAlign");
        }
        return [...new Set(bad)].map((b) => `cellProps:${b}`);
      });
    }
    case "columns": {
      const widths = Array.from({ length: cols }, () => rng.range(300, 20000));
      const total = widths.reduce((a, b) => a + b, 0);
      return planOp("columns", { cols }, () => planSetColumnWidths(doc, t, widths), (after) => {
        const now = regularNow(after);
        const g = now === undefined ? undefined : readTableGrid(now.target.element);
        const bad: string[] = [];
        // 병합 셀에만 덮인 열은 개별 너비를 어느 셀도 담지 못한다(걸친 셀 너비의 균등 분배로 읽힌다). 그 밖의 열은 요청 너비 그대로여야 한다.
        const single = new Set((g?.cells ?? []).filter((c) => c.colSpan === 1).map((c) => c.col));
        if (g?.widths === undefined || widths.some((w, c) => single.has(c) && g.widths?.[c] !== w)) bad.push("columns:widths");
        if (g?.cells.some((c) => c.width !== widths.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0)) === true) bad.push("columns:cellWidth");
        if (now?.width !== total) bad.push("columns:tableWidth");
        if (now !== undefined && checkTableGeometry(now.target.element).some((i) => i.code === "TABLE_WIDTH_SUM")) bad.push("columns:rowSums");
        return bad;
      });
    }
    case "scale": {
      const useWidth = rng.chance(0.5);
      const spec = useWidth ? { width: rng.range(Math.max(cols, 100), 60000) } : { scale: Math.round((0.3 + rng.next() * 2.2) * 1000) / 1000 };
      const oldTotal = (grid.widths ?? []).reduce((a, b) => a + b, 0);
      const total = "width" in spec ? spec.width : Math.round(oldTotal * spec.scale);
      return planOp("scale", { by: useWidth ? "width" : "scale" }, () => planScaleTable(doc, t, spec), (after) => {
        const now = regularNow(after);
        const bad: string[] = [];
        if (now?.width !== total) bad.push("scale:tableWidth");
        if (now !== undefined && checkTableGeometry(now.target.element).some((i) => i.code === "TABLE_WIDTH_SUM")) bad.push("scale:rowSums");
        const g = now === undefined ? undefined : readTableGrid(now.target.element);
        if (g?.widths === undefined || g.widths.reduce((a, b) => a + b, 0) !== total || g.widths.some((w) => w < 1)) bad.push("scale:widths");
        return bad;
      });
    }
    case "rowHeights": {
      const picks = new Set<number>();
      const want = rng.range(1, 3);
      for (let i = 0; i < want; i++) picks.add(rng.range(0, Math.max(0, rows - 1)));
      const list = [...picks].map((row) => ({ row, height: rng.range(0, 5000) }));
      return planOp("rowHeights", { rows: list.length }, () => planSetRowHeights(doc, t, list), (after) => {
        const now = regularNow(after);
        const g = now === undefined ? undefined : readTableGrid(now.target.element);
        const h = g === undefined ? undefined : rowHeights(g);
        const bad: string[] = [];
        if (h === undefined) return ["rowHeights:unreadable"];
        // 병합이 걸친 행은 병합 셀 높이에서 다시 정해지므로, 그 행에서 시작하는 rowSpan 1 셀이 있는 행만 견준다
        for (const e of list) if (g?.cells.some((c) => c.row === e.row && c.rowSpan === 1) === true && h[e.row] !== e.height) bad.push("rowHeights:height");
        return [...new Set(bad)];
      });
    }
    case "insertRows": {
      const opts = { prototype: rng.range(0, Math.max(0, rows - 1)), count: rng.range(1, 4), position: rng.pick(["after", "before"] as const), text: rng.pick(["clear", "keep"] as const), extendSpans: rng.chance(0.5) };
      const protoText = (() => {
        const tr = grid.rows[opts.prototype];
        return tr === undefined ? "" : doc.sections[t.sectionIndex]?.text.slice(tr.start, tr.end) ?? "";
      })();
      return planOp("insertRows", { count: opts.count, text: opts.text, ext: opts.extendSpans }, () => planInsertRows(doc, t, opts), (after, afterBytes) => {
        const now = regularNow(after);
        const bad: string[] = [];
        if (now?.rowCnt !== rows + opts.count) bad.push("insertRows:rowCnt");
        if (!structural(now)) bad.push("insertRows:irregular");
        if (now !== undefined && readTableGrid(now.target.element).rows.length !== rows + opts.count) bad.push("insertRows:trCount");
        // 수량: 새로 생긴 문단·표·그림·누름틀·책갈피는 원형 행 원문에서 센 수의 복제 수만큼
        const want = regexCensus(protoText);
        const before = baselineCensus;
        const aft = validateDocument(afterBytes).census;
        if (aft.paragraphs - before.paragraphs !== want.p * opts.count) bad.push("insertRows:census-paragraphs");
        if (aft.tables - before.tables !== want.tbl * opts.count) bad.push("insertRows:census-tables");
        if (aft.pictures - before.pictures !== want.pic * opts.count) bad.push("insertRows:census-pictures");
        if (aft.fieldPairs - before.fieldPairs !== want.field * opts.count) bad.push("insertRows:census-fields");
        return bad;
      }, { risk: base.risk + 2 });
    }
    case "repeatRows": {
      const count = rng.range(1, 5);
      const row = rng.range(0, Math.max(0, rows - 1));
      return planOp("repeatRows", { count }, () => planRepeatRows(doc, t, { row, count, extendSpans: rng.chance(0.5) }), (after) => {
        const now = regularNow(after);
        const bad: string[] = [];
        if (now?.rowCnt !== rows + count - 1) bad.push("repeatRows:rowCnt");
        if (!structural(now)) bad.push("repeatRows:irregular");
        return bad;
      }, { risk: base.risk + 2 });
    }
    case "insertColumns": {
      const opts = { prototype: rng.range(0, Math.max(0, cols - 1)), count: rng.range(1, 3), position: rng.pick(["after", "before"] as const), text: rng.pick(["clear", "keep"] as const) };
      return planOp("insertColumns", { count: opts.count, text: opts.text }, () => planInsertColumns(doc, t, opts), (after) => {
        const now = regularNow(after);
        const bad: string[] = [];
        if (now?.colCnt !== cols + opts.count) bad.push("insertColumns:colCnt");
        if (!structural(now)) bad.push("insertColumns:irregular");
        const g = now === undefined ? undefined : readTableGrid(now.target.element);
        const w = grid.widths;
        if (g?.widths !== undefined && w !== undefined) {
          // 표 너비(`sz@width`)는 새 열 너비만큼 는다(델타 규칙). 열 너비를 모든 열이 colSpan 1 셀에서 읽히는 표(열 너비가 병합 셀의 균등 분배 추정에 기대지 않는 표)만 열마다 견준다.
          const ins = opts.position === "after" ? opts.prototype + 1 : opts.prototype;
          if (info.width !== undefined && now?.width !== info.width + opts.count * (w[opts.prototype] ?? 0)) bad.push("insertColumns:tableWidth");
          const allSingle = Array.from({ length: cols }, (_, c) => grid.cells.some((x) => x.col === c && x.colSpan === 1)).every(Boolean);
          if (allSingle) {
            const want = [...w.slice(0, ins), ...Array(opts.count).fill(w[opts.prototype] ?? 0), ...w.slice(ins)];
            if (want.join(",") !== g.widths.join(",")) bad.push("insertColumns:widths");
          }
        }
        return bad;
      }, { risk: base.risk + 2 });
    }
    case "deleteColumns": {
      if (cols < 2) return undefined;
      const set = new Set<number>();
      const want = rng.range(1, Math.min(3, cols - 1));
      for (let i = 0; i < want; i++) set.add(rng.range(0, cols - 1));
      const list = [...set];
      return planOp("deleteColumns", { n: list.length }, () => planDeleteColumns(doc, t, { cols: list }), (after) => {
        const now = regularNow(after);
        const bad: string[] = [];
        if (now?.colCnt !== cols - list.length) bad.push("deleteColumns:colCnt");
        if (!structural(now)) bad.push("deleteColumns:irregular");
        return bad;
      });
    }
    case "merge": {
      if (rows * cols < 2) return undefined;
      const r0 = rng.range(0, rows - 1);
      const c0 = rng.range(0, cols - 1);
      const r1 = Math.min(rows - 1, r0 + rng.range(0, 3));
      const c1 = Math.min(cols - 1, c0 + rng.range(0, 3));
      const content = rng.pick(["concat", "first"] as const);
      return planOp("merge", { content }, () => planMergeCells(doc, t, { rows: [r0, r1], cols: [c0, c1], content }), (after) => {
        const now = regularNow(after);
        const bad: string[] = [];
        if (!structural(now)) bad.push("merge:irregular");
        const g = now === undefined ? undefined : readTableGrid(now.target.element);
        const head = g?.at(r0, c0);
        if (head === undefined || head.rowSpan !== r1 - r0 + 1 || head.colSpan !== c1 - c0 + 1) bad.push("merge:span");
        if (now?.rowCnt !== rows || now?.colCnt !== cols) bad.push("merge:dims");
        return bad;
      }, { risk: base.risk + 2 });
    }
    case "split": {
      const cells = grid.cells.filter((c) => c.rowSpan > 1 || c.colSpan > 1);
      const pick = cells.length > 0 ? rng.pick(cells) : grid.cells[0];
      if (pick === undefined) return undefined;
      return planOp("split", { merged: cells.length > 0 }, () => planSplitCell(doc, t, { row: pick.row, col: pick.col }), (after) => {
        const now = regularNow(after);
        const bad: string[] = [];
        if (!structural(now)) bad.push("split:irregular");
        if (now?.mergedCells !== info.mergedCells - 1) bad.push("split:mergedCount");
        return bad;
      }, { risk: base.risk + 2 });
    }
    case "clone": {
      const section = doc.sections[t.sectionIndex];
      if (section === undefined || section.paragraphs.length === 0) return undefined;
      const index = rng.range(0, section.paragraphs.length - 1);
      const opts = { rows: rng.chance(0.6) ? rng.range(1, 6) : undefined, cols: rng.chance(0.6) ? rng.range(1, 5) : undefined, text: rng.pick(["clear", "keep"] as const) };
      const options: Record<string, unknown> = { text: opts.text };
      if (opts.rows !== undefined) options["rows"] = opts.rows;
      if (opts.cols !== undefined) options["cols"] = opts.cols;
      return planOp("clone", { rows: opts.rows ?? null, cols: opts.cols ?? null }, () => planCloneTable(doc, { sectionIndex: t.sectionIndex, parentPath: [], index, position: rng.pick(["after", "before"] as const) }, { table: t }, options as never), (after) => {
        const infos = listTables(after);
        const bad: string[] = [];
        if (infos.length < listTables(doc).length + 1) bad.push("clone:tableCount");
        // 구조 문제가 있는 표의 수는 원본 문서보다 (복제된 표 부분 트리 안의 구조 문제 표 수)만큼만 늘 수 있다
        const broken = (d: HwpxDocument): number => listTables(d).filter((x) => readTableGrid(x.target.element).problems.length > 0).length;
        const inside = listTables(doc).filter((x) => readTableGrid(x.target.element).problems.length > 0 && x.target.element.start >= t.element.start && x.target.element.end <= t.element.end).length;
        if (broken(after) > broken(doc) + inside) bad.push("clone:irregular");
        return bad;
      }, { risk: base.risk + 3 });
    }
    case "gateProps": {
      if (info.topOrdinal === undefined) return undefined;
      const table: Record<string, unknown> = {};
      if (rng.chance(0.6)) table["treatAsChar"] = rng.chance(0.5);
      if (rng.chance(0.6)) table["pageBreak"] = rng.pick(["CELL", "NONE", "TABLE"]);
      if (Object.keys(table).length === 0) table["repeatHeader"] = rng.chance(0.5);
      const rules: unknown[] = [{ id: "p", do: { type: "tableProps", anchor: "t", table } }];
      if (rng.chance(0.5)) rules.push({ id: "z", do: { type: "resize", anchor: "t", scale: Math.round((0.5 + rng.next()) * 100) / 100 } });
      return {
        kind: "gate",
        op: "gateProps",
        params: { rules: rules.length },
        run: () => {
          const tpl = readTemplate({ schema: "hwpx-studio/template@1", anchors: [{ id: "t", kind: "object", objectType: "tbl", sectionIndex: info.sectionIndex, ordinal: info.topOrdinal ?? 0 }], rules });
          const r = generate(bytes, tpl, readDataset({}), { missing: "keep" });
          return r.ok && !r.dryRun ? { bytes: r.output, gateOk: true } : { bytes, gateOk: false, gateCodes: r.report.issues.filter((i) => i.severity === "error").map((i) => i.code) };
        },
        post: (after) => {
          const now = regularNow(after);
          const bad: string[] = [];
          if (table["treatAsChar"] !== undefined && now?.treatAsChar !== table["treatAsChar"]) bad.push("gateProps:treatAsChar");
          if (table["pageBreak"] !== undefined && now?.pageBreak !== table["pageBreak"]) bad.push("gateProps:pageBreak");
          return bad;
        },
        keepsTableCount: true,
        risk: base.risk + 1,
      };
    }
    case "gateRepeat": {
      if (info.topOrdinal === undefined || rows < 1) return undefined;
      const row = rng.range(0, rows - 1);
      const cell = grid.cells.find((c) => c.row === row);
      if (cell === undefined) return undefined;
      const n = rng.range(0, 4);
      return {
        kind: "gate",
        op: "gateRepeat",
        params: { n },
        run: () => {
          const tpl = readTemplate({
            schema: "hwpx-studio/template@1",
            anchors: [{ id: "c", kind: "cell", table: { sectionIndex: info.sectionIndex, ordinal: info.topOrdinal ?? 0 }, row, col: cell.col }],
            rules: [{ id: "r", do: { type: "repeat", anchor: "c", each: { path: "xs" } } }],
          });
          const r = generate(bytes, tpl, readDataset({ xs: Array.from({ length: n }, (_, i) => ({ i })) }), { missing: "keep" });
          return r.ok && !r.dryRun ? { bytes: r.output, gateOk: true } : { bytes, gateOk: false, gateCodes: r.report.issues.filter((i) => i.severity === "error").map((i) => i.code) };
        },
        post: (after) => {
          // 마지막 남은 행을 0개로 반복하면 표를 담은 문단이 지워진다(표 수 -1, 중첩 표가 든 행이면 그 안의 표도 함께). 그 밖에는 행 수가 맞아야 한다
          if (n === 0 && rows === 1) return listTables(after).length < listTables(doc).length ? [] : ["gateRepeat:tableNotRemoved"];
          const now = regularNow(after);
          return now?.rowCnt === rows - 1 + n ? [] : ["gateRepeat:rowCnt"];
        },
        keepsTableCount: false,
        risk: base.risk + 3,
      };
    }
    default:
      return undefined;
  }
}

const KINDS = ["props", "cellProps", "columns", "scale", "rowHeights", "insertRows", "repeatRows", "insertColumns", "deleteColumns", "merge", "split", "clone", "gateProps", "gateRepeat"];

// ── 실행 ────────────────────────────────────────────────────────

function main(): number {
  const o = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const files = scanCorpus(o.corpus);
  const startSnapshot = snapshotOf(files);

  // 1. 색인과 관측
  const observed = newObserved();
  const usable: { file: CorpusFile; bytes: Uint8Array; tables: number; mergedOnly: number }[] = [];
  for (const f of files) {
    observed.docsTried++;
    let bytes: Uint8Array;
    let doc: HwpxDocument;
    try {
      bytes = readCorpusFile(f);
      doc = parseDocument(openPackage(bytes));
    } catch {
      continue;
    }
    observed.docsOpened++;
    const n = observe(doc, observed);
    if (n > 0) {
      const mergedOnly = listTables(doc).filter((i) => {
        const g = readTableGrid(i.target.element);
        return g.problems.length === 0 && hasMergedOnlyColumn(g.cells, g.colCnt);
      }).length;
      usable.push({ file: f, bytes, tables: n, mergedOnly });
    }
  }
  // 문서 바이트를 모두 쥐고 있으면 메모리를 많이 쓰므로 뽑힌 문서만 다시 읽는다
  const rngPick = makeRng(hashSeed(`tables:${o.seed}`));
  // `--prefer-merged-only`: 병합 셀로만 덮인 열이 있는 표가 든 문서를 먼저 고른다(모자라면 나머지로 채운다)
  const shuffled = rngPick.shuffle(usable.map((u) => ({ file: u.file, tables: u.tables, mergedOnly: u.mergedOnly })));
  const ordered = o.preferMergedOnly ? [...shuffled.filter((u) => u.mergedOnly > 0), ...shuffled.filter((u) => u.mergedOnly === 0)] : shuffled;
  const chosen = ordered.slice(0, o.docs);
  usable.length = 0;

  // 2. 건
  const byKind: Record<string, Record<string, number>> = {};
  const codes: Record<string, number> = {};
  const totals: Record<string, number> = { ok: 0, inherited: 0, rejected: 0, defect: 0, skipped: 0 };
  const defects: Defect[] = [];
  const gateCodes: Record<string, number> = {};
  const timeMs: number[] = [];
  let determinismChecked = 0;
  let determinismBad = 0;
  let opCount = 0;
  const candidates: { caseId: string; docId: string; risk: number; bytes: Uint8Array; baseBytes: Uint8Array }[] = [];
  let docsUsed = 0;
  let tablesTried = 0;

  const record = (kind: string, outcome: Outcome): void => {
    totals[outcome.cls] = (totals[outcome.cls] ?? 0) + 1;
    const k = (byKind[kind] ??= {});
    bump(k, outcome.cls);
    if (outcome.cls !== "ok") bump(codes, `${outcome.cls}:${kind}:${outcome.code}`);
  };

  for (const pick of chosen) {
    if (opCount >= o.ops && docsUsed >= Math.min(o.docs, 150)) break;
    if (!sameStat(pick.file)) {
      console.error("모음의 파일이 실행 중 바뀐 것이 감지됐다. 멈춘다.");
      return 3;
    }
    const bytes = readCorpusFile(pick.file);
    let doc: HwpxDocument;
    try {
      doc = parseDocument(openPackage(bytes));
    } catch {
      continue;
    }
    docsUsed++;
    const baseline = validateDocument(bytes);
    const infos = listTables(doc);
    const baselineGeo = infos.map((i) => checkTableGeometry(i.target.element).map((x) => x.code));
    const rngDoc = makeRng(hashSeed(`${o.seed}:${pick.file.id}`));
    // 병합·중첩이 든 표를 우선 고른다
    const mergedOnlyOf = (i: TableInfo): boolean => {
      if (!o.preferMergedOnly) return false;
      const g = readTableGrid(i.target.element);
      return g.problems.length === 0 && hasMergedOnlyColumn(g.cells, g.colCnt);
    };
    const weighted = infos
      .map((i) => ({ i, w: (i.mergedCells > 0 ? 3 : 0) + (i.depth > 0 ? 3 : 0) + (mergedOnlyOf(i) ? 6 : 0) + rngDoc.next() * 2 }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 6);
    for (const { i: info } of weighted) {
      tablesTried++;
      const kinds = rngDoc.shuffle(KINDS).slice(0, 3);
      for (const kind of kinds) {
        opCount++;
        const caseId = `${pick.file.id}-t${info.ordinal}-${kind}`;
        const rng = makeRng(hashSeed(`${o.seed}:${caseId}`));
        let prepared: Prepared | undefined;
        try {
          prepared = makeOp(doc, bytes, info, kind, rng, baseline.census);
        } catch (e) {
          record(kind, { cls: "defect", code: `prepare:${e instanceof Error ? e.name : "?"}` });
          defects.push({ caseId, doc: pick.file.id, op: kind, code: "defect:prepare", params: {} });
          continue;
        }
        if (prepared === undefined) {
          record(kind, { cls: "skipped", code: "n/a" });
          continue;
        }
        const started = Date.now();
        let result: ReturnType<Prepared["run"]>;
        try {
          result = prepared.run();
        } catch (e) {
          if (e instanceof HwpxError) {
            const internal = ["EDIT_OVERLAP", "EDIT_STALE", "EDIT_RANGE", "TABLE_INTERNAL"].includes(e.code);
            record(kind, { cls: internal ? "defect" : "rejected", code: e.code });
            if (internal) defects.push({ caseId, doc: pick.file.id, op: kind, code: `defect:internal:${e.code}`, params: prepared.params });
          } else {
            record(kind, { cls: "defect", code: `exception:${e instanceof Error ? e.name : "?"}` });
            defects.push({ caseId, doc: pick.file.id, op: kind, code: `defect:exception:${e instanceof Error ? e.name : "?"}`, params: prepared.params });
          }
          continue;
        }
        timeMs.push(Date.now() - started);
        if (prepared.kind === "gate" && result.gateOk === false) {
          const cs = result.gateCodes ?? [];
          for (const c of cs) bump(gateCodes, `${kind}:${c}`);
          const internal = cs.some((c) => /^(GATE_|PRESERVE_|REREAD_|INJECT_|REPEAT_)/.test(c));
          record(kind, { cls: internal ? "defect" : "rejected", code: cs[0] ?? "?" });
          if (internal) defects.push({ caseId, doc: pick.file.id, op: kind, code: `defect:gate:${cs.join("+")}`, params: prepared.params });
          continue;
        }

        // 건마다 확인
        const bad: string[] = [];
        let after: HwpxDocument | undefined;
        const inheritedHere: string[] = [];
        try {
          after = parseDocument(openPackage(result.bytes));
        } catch (e) {
          bad.push(`V-a:${e instanceof HwpxError ? e.code : "exception"}`);
        }
        if (after !== undefined) {
          if (result.plan !== undefined) {
            const pres = verifyPreservation(bytes, result.bytes, result.plan);
            for (const p of pres) bad.push(`preserve:${p.code}`);
          }
          const cmp = compareToBaseline(baseline, validateDocument(result.bytes));
          const fresh = splitTolerated(cmp.newErrors, baseline.warnings).rest;
          // 행·열·표를 복제하거나 병합 셀을 쪼개 새 셀을 만들면 원본이 이미 갖고 있던 오류(없는 서식을 가리키는 참조 등)도 복제돼 개수가 는다. 같은 오류(코드·메시지)가 원본에 있었으면 상속이다.
          const copies = ["insertRows", "repeatRows", "insertColumns", "split", "clone", "gateRepeat"].includes(kind);
          for (const e of fresh) {
            if (copies && baseline.errors.some((x) => x.code === e.code && x.message === e.message)) inheritedHere.push(e.code);
            else bad.push(`V-b:${e.code}`);
          }
          // 표 불변식: 표 수가 같은 연산은 표마다, 아니면 코드별 총량이 원본보다 늘지 않는다
          const afterInfos = listTables(after);
          if (prepared.keepsTableCount) {
            if (afterInfos.length !== infos.length) bad.push("tableCount");
            afterInfos.forEach((ai, k) => {
              const was = baselineGeo[k] ?? [];
              for (const c of checkTableGeometry(ai.target.element).map((x) => x.code)) if (!was.includes(c)) bad.push(`geometry:${c}`);
            });
          } else {
            const countBy = (list: string[][]): Record<string, number> => {
              const out: Record<string, number> = {};
              for (const l of list) for (const c of l) bump(out, c);
              return out;
            };
            // 행·열·표를 복제하면 원본의 위반도 복제되므로, 원본에 없던 종류의 위반만 결함으로 본다
            const wasTotals = countBy(baselineGeo);
            const nowTotals = countBy(afterInfos.map((x) => checkTableGeometry(x.target.element).map((y) => y.code)));
            for (const c of Object.keys(nowTotals)) if ((wasTotals[c] ?? 0) === 0) bad.push(`geometry:${c}`);
          }
          for (const p of prepared.post(after, result.bytes)) bad.push(p);
          // 엔진의 열 너비 추정을 쓰지 않는 독립 검사: 원본 표의 행별 너비 합·셀 너비 성질이 유지된다(복제한 표는 그 복사본도)
          // (표 수가 달라지는 건(표 복제, 마지막 행을 지워 표가 사라지는 행 반복)은 뒤 표의 서수가 밀려 대상 표를 서수로 찾을 수 없어 뺀다. 복제 속 열·행 연산은 같은 검사를 받는 열·행 연산 건이 덮는다.)
          const nowTable = afterInfos.find((x) => x.ordinal === info.ordinal && x.sectionIndex === info.sectionIndex);
          if (afterInfos.length === infos.length && nowTable !== undefined) for (const c of widthRegression(info.target.element, nowTable.target.element)) bad.push(c);
          // 결정성(표본): 같은 입력으로 다시 계획해 같은 바이트
          if (prepared.kind === "plan" && opCount % 8 === 0) {
            determinismChecked++;
            const doc2 = parseDocument(openPackage(bytes));
            const info2 = listTables(doc2).find((x) => x.ordinal === info.ordinal && x.sectionIndex === info.sectionIndex);
            const again = info2 === undefined ? undefined : makeOp(doc2, bytes, info2, kind, makeRng(hashSeed(`${o.seed}:${caseId}`)), baseline.census);
            let same = false;
            try {
              const r2 = again?.run();
              same = r2 !== undefined && sha10(r2.bytes) === sha10(result.bytes);
            } catch {
              same = false;
            }
            if (!same) {
              determinismBad++;
              bad.push("determinism");
            }
          }
        }
        const uniq = [...new Set(bad)];
        if (uniq.length > 0) {
          record(kind, { cls: "defect", code: uniq[0] ?? "?" });
          for (const c of uniq) defects.push({ caseId, doc: pick.file.id, op: kind, code: `defect:${c}`, params: prepared.params });
          bump(codes, `defectAll:${kind}`, 1);
        } else if (inheritedHere.length > 0) {
          record(kind, { cls: "inherited", code: [...new Set(inheritedHere)].join("+") });
        } else {
          record(kind, { cls: "ok", code: "" });
          // 한컴 표본 후보: 위험이 큰 것 위주로 최대 60개만 쥔다
          if (candidates.length < 60 || prepared.risk > (candidates[candidates.length - 1]?.risk ?? 0)) {
            candidates.push({ caseId, docId: pick.file.id, risk: prepared.risk, bytes: result.bytes, baseBytes: bytes });
            candidates.sort((a, b) => b.risk - a.risk);
            if (candidates.length > 60) candidates.length = 60;
          }
        }
      }
    }
  }

  // 3. 한컴 표본(열림·쪽 수): 문서마다 하나씩, 위험이 큰 순서로
  const com: Record<string, unknown> = { ran: false };
  if (!o.noCom && comAvailable() && o.comSample > 0) {
    removeStressDir();
    mkdirSync(join(STRESS_DIR, "out"), { recursive: true });
    mkdirSync(join(STRESS_DIR, "base"), { recursive: true });
    const seen = new Set<string>();
    const picked = candidates.filter((c) => (seen.has(c.docId) ? false : (seen.add(c.docId), true))).slice(0, o.comSample);
    const outFiles: string[] = [];
    const baseFiles: string[] = [];
    for (const c of picked) {
      const outFile = join(STRESS_DIR, "out", `${c.caseId}.hwpx`);
      const baseFile = join(STRESS_DIR, "base", `${c.docId}.hwpx`);
      writeFileSync(outFile, c.bytes);
      writeFileSync(baseFile, c.baseBytes);
      outFiles.push(outFile);
      baseFiles.push(baseFile);
    }
    const run = runCom([...outFiles, ...baseFiles], undefined);
    const rows = picked.map((c) => {
      const a = run.results.get(`${c.caseId}.hwpx`);
      const b = run.results.get(`${c.docId}.hwpx`);
      return { caseId: c.caseId, opened: a?.opened === true, pages: a?.pages ?? null, basePages: b?.pages ?? null, baseOpened: b?.opened === true, error: a?.error ?? null };
    });
    const both = rows.filter((r) => r.opened && r.baseOpened);
    com["ran"] = run.ran;
    com["aborted"] = run.aborted;
    com["version"] = run.version;
    com["sample"] = rows.length;
    com["opened"] = rows.filter((r) => r.opened).length;
    com["baseOpened"] = rows.filter((r) => r.baseOpened).length;
    com["failedToOpen"] = rows.filter((r) => !r.opened).map((r) => ({ caseId: r.caseId, baseOpened: r.baseOpened, error: r.error }));
    com["pagesDelta"] = dist(both.map((r) => (r.pages ?? 0) - (r.basePages ?? 0)));
    // 쪽 수가 가장 많이 는 표본(원인을 연산 종류로 가늠하려는 것: 식별자와 수치만)
    com["pagesDeltaTop"] = both
      .map((r) => ({ caseId: r.caseId, delta: (r.pages ?? 0) - (r.basePages ?? 0), pages: r.pages, basePages: r.basePages }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 3);
    com["pagesDecreased"] = both.filter((r) => (r.pages ?? 0) < (r.basePages ?? 0)).length;
    com["processesLeft"] = run.processesLeft;
    removeStressDir();
  }

  // 4. 모음이 그대로인가
  const endSnapshot = snapshotOf(scanCorpus(o.corpus));
  const unchanged = sameSnapshot(startSnapshot, endSnapshot);

  const defectCodes: Record<string, number> = {};
  for (const d of defects) bump(defectCodes, d.code);
  const report = {
    options: { seed: o.seed, docs: o.docs, ops: o.ops, comSample: o.comSample, preferMergedOnly: o.preferMergedOnly },
    corpus: { hwpxFiles: startSnapshot.hwpxFiles, totalBytes: startSnapshot.totalBytes, unchanged },
    observed: {
      ...observed,
      widthBasis: sortedRecord(observed.widthBasis),
      heightBasis: sortedRecord(observed.heightBasis),
      heightVsRows: sortedRecord(observed.heightVsRows),
      widthVsColumns: sortedRecord(observed.widthVsColumns),
      treatAsChar: sortedRecord(observed.treatAsChar),
      pageBreak: sortedRecord(observed.pageBreak),
      repeatHeader: sortedRecord(observed.repeatHeader),
      regularPct: pct(observed.gridRegular, observed.tables),
      heightEqualPct: pct(observed.heightVsRows["같음"] ?? 0, observed.gridRegular),
      widthEqualPct: pct(observed.widthVsColumns["같음"] ?? 0, observed.gridRegular),
    },
    selection: { docsUsed, tablesTried, ops: opCount },
    totals,
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, sortedRecord(v)])),
    codes: sortedRecord(codes),
    gateCodes: sortedRecord(gateCodes),
    defectCodes: sortedRecord(defectCodes),
    defects: defects.slice(0, 200),
    determinism: { checked: determinismChecked, mismatched: determinismBad },
    time: { totalSec: Math.round((Date.now() - t0) / 100) / 10, perOpMs: dist(timeMs) },
    com,
  };
  mkdirSync(dirname(o.report), { recursive: true });
  writeFileSync(o.report, JSON.stringify(report, null, 2) + "\n");
  console.log(
    `표 스트레스: 문서 ${docsUsed}건, 표 ${tablesTried}개, 연산 ${opCount}건 | 정상 ${totals["ok"]}, 거절 ${totals["rejected"]}, 결함 ${totals["defect"]}, 건너뜀 ${totals["skipped"]} | ` +
      `한컴 표본 ${String(com["opened"] ?? "-")}/${String(com["sample"] ?? "-")} 열림 | 모음 변경 ${unchanged ? "없음" : "감지됨"} | ${report.time.totalSec}초`,
  );
  return unchanged ? 0 : 3;
}

process.exitCode = main();
