import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";
import type { HwpxDocument } from "../model/types.ts";
import { childEl, childEls, walkElements, type XElement } from "../xml/tree.ts";
import { assertFieldsClosed, copyElement } from "./copy.ts";
import { attrRep, resolveTarget, setAttrs, span, type Ctx, type Rep } from "./edit.ts";
import { intAttr, rowHeights, type GridCell, type TableGrid } from "./grid.ts";
import { makeReissuer, type Reissuer } from "./ids.ts";
import { finishPlan } from "./props.ts";
import { requireAbsolute, requireGrid } from "./require.ts";
import type { CopyText, TableTarget } from "./types.ts";

const bad = (message: string): HwpxError => new HwpxError("TABLE_BAD_ARG", message);
const conflict = (message: string): HwpxError => new HwpxError("TABLE_SPAN_CONFLICT", message);

export const MAX_COUNT = 100000;

export function checkCount(what: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_COUNT) throw bad(`${what} ${JSON.stringify(value)}은(는) 1 이상 ${MAX_COUNT} 이하의 정수여야 합니다.`);
  return value;
}

export function checkIndex(what: string, value: unknown, size: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= size) throw bad(`${what} ${JSON.stringify(value)}이(가) 범위(0~${size - 1})를 벗어납니다.`);
  return value;
}

/** 표 `sz@height`를 `delta`만큼 바꾸는 편집(0 아래로는 내려가지 않는다). `sz`가 없으면 편집이 없다. */
export function heightDeltaEdits(ctx: Ctx, table: XElement, delta: number): SpanEdit[] {
  const sz = childEl(table, "paragraph", "sz");
  const height = intAttr(sz, "height");
  if (sz === undefined || height === undefined || delta === 0) return [];
  return setAttrs(ctx, sz, { height: String(Math.max(0, height + delta)) }, "표 높이");
}

/** 표 `sz@width`를 `delta`만큼 바꾸는 편집(0 아래로는 내려가지 않는다). */
export function widthDeltaEdits(ctx: Ctx, table: XElement, delta: number): SpanEdit[] {
  const sz = childEl(table, "paragraph", "sz");
  const width = intAttr(sz, "width");
  if (sz === undefined || width === undefined || delta === 0) return [];
  return setAttrs(ctx, sz, { width: String(Math.max(0, width + delta)) }, "표 너비");
}

/** `tr`의 직속 셀들의 행 주소를 `row`로 바꾸는 복사본용 치환(중첩 표의 주소는 건드리지 않는다). */
function rowAddrReps(tr: XElement, row: number): Rep[] {
  const reps: Rep[] = [];
  for (const tc of childEls(tr, "paragraph", "tc")) {
    const addr = childEl(tc, "paragraph", "cellAddr");
    const rep = addr === undefined ? undefined : attrRep(addr, "rowAddr", String(row), tr.start);
    if (rep !== undefined) reps.push(rep);
  }
  return reps;
}

/**
 * 원형 행 `p`를 가로지르는 병합 셀을 검사한다. 그 행에서 시작해 아래로 뻗는 셀은 복제할 수 없다(`TABLE_SPAN_CONFLICT`).
 * 위에서 내려오는 셀은 `extendSpans`가 있어야 늘려서 받아들인다. 늘릴 셀을 돌려준다.
 */
function checkPrototypeSpans(grid: TableGrid, p: number, extendSpans: boolean): GridCell[] {
  const extended: GridCell[] = [];
  for (const c of grid.cells) {
    if (c.row > p || p >= c.row + c.rowSpan) continue;
    if (c.row === p && c.rowSpan > 1) {
      throw conflict(`행 ${p}에서 시작해 아래로 뻗는 세로 병합 셀(열 ${c.col}, rowSpan ${c.rowSpan})이 있어 그 행을 원형으로 복제할 수 없습니다.`);
    }
    if (c.row < p) {
      if (!extendSpans) throw conflict(`행 ${p}를 가로지르는 세로 병합 셀(행 ${c.row}, 열 ${c.col}, rowSpan ${c.rowSpan})이 있습니다(extendSpans: true로 그 병합을 늘릴 수 있습니다).`);
      extended.push(c);
    }
  }
  return extended;
}

/** 위에서 내려오는 병합 셀의 `rowSpan`과 `cellSz@height`를 늘리는 편집들 */
function extendEdits(ctx: Ctx, cells: GridCell[], extraRows: number, extraHeight: number): SpanEdit[] {
  const edits: SpanEdit[] = [];
  for (const c of cells) {
    if (c.span !== undefined) edits.push(...setAttrs(ctx, c.span, { rowSpan: String(c.rowSpan + extraRows) }, "세로 병합 늘림"));
    if (c.size !== undefined) edits.push(...setAttrs(ctx, c.size, { height: String(c.height + extraHeight) }, "병합 셀 높이"));
  }
  return edits;
}

export type InsertRowsOptions = {
  /** 원형 행 번호(0부터) */
  prototype: number;
  /** 넣을 행 수. 기본 1 */
  count?: number;
  /** 원형 행 뒤(`after`, 기본)나 앞(`before`)에 넣는다 */
  position?: "after" | "before";
  /** `clear`(기본)면 복제한 행의 글을 비우고, `keep`이면 유지한다 */
  text?: CopyText;
  /** 위에서 내려와 원형 행을 가로지르는 세로 병합을 늘려 받아들인다. 기본은 거절 */
  extendSpans?: boolean;
};

/** 행 삽입의 편집들. `ctx`는 `grid`를 읽은 텍스트다(복제한 표 원문 위에서도 쓴다). */
export function insertRowsEdits(ctx: Ctx, grid: TableGrid, options: Required<InsertRowsOptions>, reissue: Reissuer): { edits: SpanEdit[]; cellsPerRow: number } {
  const p = options.prototype;
  const count = options.count;
  const tr = grid.rows[p];
  const heights = rowHeights(grid);
  if (tr === undefined || heights === undefined) throw new HwpxError("TABLE_IRREGULAR", "원형 행을 읽을 수 없습니다.", ctx.entry);
  const extended = checkPrototypeSpans(grid, p, options.extendSpans);
  const ins = options.position === "after" ? p + 1 : p;
  const protoHeight = heights[p] ?? 0;

  const copies: string[] = [];
  for (let k = 0; k < count; k++) copies.push(copyElement(ctx, tr, { text: options.text, reissue, blankCellNames: true, closedFields: true }, rowAddrReps(tr, ins + k)));
  const at = options.position === "after" ? tr.end : tr.start;
  const edits: SpanEdit[] = [span(ctx, at, at, copies.join(""), `행 ${p}을(를) 원형으로 ${count}행 복제`)];
  edits.push(...setAttrs(ctx, grid.table, { rowCnt: String(grid.rowCnt + count) }, "표 행 수"));
  for (const c of grid.cells) {
    if (c.row >= ins && c.addr !== undefined) edits.push(...setAttrs(ctx, c.addr, { rowAddr: String(c.row + count) }, "뒤 행의 행 주소"));
  }
  edits.push(...extendEdits(ctx, extended, count, count * protoHeight));
  edits.push(...heightDeltaEdits(ctx, grid.table, count * protoHeight));
  return { edits, cellsPerRow: childEls(tr, "paragraph", "tc").length };
}

function normalizeInsert(grid: TableGrid, options: InsertRowsOptions): Required<InsertRowsOptions> {
  if (typeof options !== "object" || options === null) throw bad("options는 객체여야 합니다.");
  const position = options.position ?? "after";
  if (position !== "after" && position !== "before") throw bad(`position ${JSON.stringify(position)}은(는) after나 before여야 합니다.`);
  const text = options.text ?? "clear";
  if (text !== "clear" && text !== "keep") throw bad(`text ${JSON.stringify(text)}은(는) clear나 keep이어야 합니다.`);
  return {
    prototype: checkIndex("prototype", options.prototype, grid.rowCnt),
    count: options.count === undefined ? 1 : checkCount("count", options.count),
    position,
    text,
    extendSpans: options.extendSpans === true,
  };
}

/**
 * 기존 행을 원형으로 복제해 넣는다. 복제한 행의 서식 참조는 원형과 같고, 안의 인스턴스 id(중첩 표·그림·누름틀 짝)와 책갈피 이름은 새로 준다.
 * 뒤 행의 `rowAddr`, `rowCnt`, 표 높이(원형 행 높이만큼)를 갱신한다. 원형 행을 가로지르는 세로 병합이 있으면 거절한다(`TABLE_SPAN_CONFLICT`):
 * 그 행에서 시작해 아래로 뻗는 병합은 언제나, 위에서 내려오는 병합은 `extendSpans`가 없을 때.
 * 격자가 불규칙하면 `TABLE_IRREGULAR`, 셀 영역 목록이 있으면 `TABLE_UNSUPPORTED`, 높이 기준이 절대값이 아니면 `TABLE_RELATIVE_SIZE`.
 */
export function planInsertRows(doc: HwpxDocument, target: TableTarget, options: InsertRowsOptions): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  const grid = requireGrid(table, ctx.entry, { structure: true });
  requireAbsolute(table, "height", ctx.entry);
  const o = normalizeInsert(grid, options);
  const reissue = makeReissuer(doc);
  const { edits, cellsPerRow } = insertRowsEdits(ctx, grid, o, reissue);
  return finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, insertedRows: o.count, insertedCells: o.count * cellsPerRow, reissuedIds: reissue.count });
}

export type RepeatRowsOptions = {
  /** 원형 행 번호(0부터) */
  row: number;
  /** 원형 행을 대신할 행 수(1 이상). 원형 행 자신이 첫 행이 되고 복제본이 뒤따른다. 0이면 행 삭제이므로 이 함수가 아니라 호출자가 한다. */
  count: number;
  /** 위에서 내려와 원형 행을 가로지르는 세로 병합을 늘려 받아들인다. 기본은 거절 */
  extendSpans?: boolean;
  /** 행 원문(`index`번째 복사본)을 받아 고친 원문을 돌려준다. 템플릿 채움이 `{{}}`를 원소로 채우는 데 쓴다. 주소·id는 이미 정해진 뒤다. */
  rewrite?: (rowXml: string, index: number) => string;
};

/**
 * 원형 행을 `count`개 행으로 바꾼다(첫 복사본은 원형 자신의 id를 쓰고 나머지는 새 id). 복사본마다 `rewrite`로 내용을 채울 수 있다.
 * 뒤 행 주소·`rowCnt`·표 높이를 `count - 1`행만큼 갱신한다. 거절 규칙은 `planInsertRows`와 같다.
 */
export function planRepeatRows(doc: HwpxDocument, target: TableTarget, options: RepeatRowsOptions): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  if (typeof options !== "object" || options === null) throw bad("options는 객체여야 합니다.");
  if (options.rewrite !== undefined && typeof options.rewrite !== "function") throw bad("rewrite는 함수여야 합니다.");
  const grid = requireGrid(table, ctx.entry, { structure: true });
  requireAbsolute(table, "height", ctx.entry);
  const p = checkIndex("row", options.row, grid.rowCnt);
  const count = checkCount("count", options.count);
  const tr = grid.rows[p];
  const heights = rowHeights(grid);
  if (tr === undefined || heights === undefined) throw new HwpxError("TABLE_IRREGULAR", "원형 행을 읽을 수 없습니다.", ctx.entry);
  const extended = checkPrototypeSpans(grid, p, options.extendSpans === true);
  const reissue = makeReissuer(doc);
  const extraRows = count - 1;
  const protoHeight = heights[p] ?? 0;

  const copies: string[] = [];
  for (let k = 0; k < count; k++) {
    const xml = copyElement(ctx, tr, { text: "keep", reissue: k === 0 ? undefined : reissue, blankCellNames: k > 0, closedFields: k > 0 }, rowAddrReps(tr, p + k));
    copies.push(options.rewrite === undefined ? xml : options.rewrite(xml, k));
  }
  const edits: SpanEdit[] = [span(ctx, tr.start, tr.end, copies.join(""), `행 ${p}을(를) ${count}행으로 반복`)];
  if (extraRows > 0) {
    edits.push(...setAttrs(ctx, grid.table, { rowCnt: String(grid.rowCnt + extraRows) }, "표 행 수"));
    for (const c of grid.cells) {
      if (c.row > p && c.addr !== undefined) edits.push(...setAttrs(ctx, c.addr, { rowAddr: String(c.row + extraRows) }, "뒤 행의 행 주소"));
    }
    edits.push(...extendEdits(ctx, extended, extraRows, extraRows * protoHeight));
    edits.push(...heightDeltaEdits(ctx, grid.table, extraRows * protoHeight));
  }
  const cellsPerRow = childEls(tr, "paragraph", "tc").length;
  return finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, insertedRows: extraRows, insertedCells: extraRows * cellsPerRow, reissuedIds: reissue.count });
}

/**
 * 뒤쪽 `n`개 행을 지우는 편집들(복제한 표의 행 수를 줄이는 데 쓴다). 지운 행을 가로지르는 위쪽 병합 셀은 남은 행까지로 줄인다.
 */
export function deleteTrailingRowsEdits(ctx: Ctx, grid: TableGrid, n: number): SpanEdit[] {
  const keep = grid.rowCnt - n;
  if (n < 1 || keep < 1) throw bad(`지울 행 수 ${n}은(는) 1 이상 ${grid.rowCnt - 1} 이하여야 합니다.`);
  const heights = rowHeights(grid);
  if (heights === undefined) throw new HwpxError("TABLE_IRREGULAR", "행 높이를 읽을 수 없습니다.", ctx.entry);
  // 지우는 행들이 누름틀의 시작과 끝 사이를 자르면 한쪽 반이 남는다
  assertFieldsClosed(grid.rows.slice(keep).flatMap((tr) => [...walkElements(tr)]), "지울");
  const edits: SpanEdit[] = [];
  for (let r = keep; r < grid.rowCnt; r++) {
    const tr = grid.rows[r];
    if (tr !== undefined) edits.push(span(ctx, tr.start, tr.end, "", `뒤 행 ${r} 삭제`));
  }
  edits.push(...setAttrs(ctx, grid.table, { rowCnt: String(keep) }, "표 행 수"));
  let removedHeight = 0;
  for (let r = keep; r < grid.rowCnt; r++) removedHeight += heights[r] ?? 0;
  for (const c of grid.cells) {
    if (c.row < keep && c.row + c.rowSpan > keep) {
      let kept = 0;
      for (let r = c.row; r < keep; r++) kept += heights[r] ?? 0;
      if (c.span !== undefined) edits.push(...setAttrs(ctx, c.span, { rowSpan: String(keep - c.row) }, "세로 병합 줄임"));
      if (c.size !== undefined) edits.push(...setAttrs(ctx, c.size, { height: String(kept) }, "병합 셀 높이"));
    }
  }
  edits.push(...heightDeltaEdits(ctx, grid.table, -removedHeight));
  return edits;
}
