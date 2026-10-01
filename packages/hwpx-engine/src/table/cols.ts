import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";
import type { HwpxDocument } from "../model/types.ts";
import { childEls, walkElements, type XElement } from "../xml/tree.ts";
import { assertFieldsClosed, copyElement } from "./copy.ts";
import { attrRep, resolveTarget, setAttrs, span, type Ctx } from "./edit.ts";
import type { TableGrid } from "./grid.ts";
import { makeReissuer, type Reissuer } from "./ids.ts";
import { finishPlan } from "./props.ts";
import { requireAbsolute, requireGrid } from "./require.ts";
import { checkCount, checkIndex, widthDeltaEdits } from "./rows.ts";
import type { CopyText, TableTarget } from "./types.ts";

const bad = (message: string): HwpxError => new HwpxError("TABLE_BAD_ARG", message);

export type InsertColumnsOptions = {
  /** 원형 열 번호(0부터) */
  prototype: number;
  /** 넣을 열 수. 기본 1 */
  count?: number;
  /** 원형 열 뒤(`after`, 기본)나 앞(`before`)에 넣는다 */
  position?: "after" | "before";
  /** `clear`(기본)면 복제한 셀의 글을 비우고, `keep`이면 유지한다 */
  text?: CopyText;
};

/**
 * 열 삽입의 편집들. 원형 열을 덮는 셀 가운데 colSpan 1인 셀은 복제하고, 여러 열에 걸친 셀은 걸친 폭을 늘린다(복제하면 겹치므로).
 * 새 열의 너비는 원형 열 너비다. 열 주소가 새 열 앞이 아닌 셀은 그대로 두고 그 뒤 셀은 `colAddr`를 옮긴다.
 */
export function insertColumnsEdits(ctx: Ctx, grid: TableGrid, options: Required<InsertColumnsOptions>, reissue: Reissuer): { edits: SpanEdit[]; clonedCells: number } {
  const pc = options.prototype;
  const k = options.count;
  const widths = grid.widths;
  if (widths === undefined) throw new HwpxError("TABLE_IRREGULAR", "열 너비를 읽을 수 없습니다.", ctx.entry);
  const ins = options.position === "after" ? pc + 1 : pc;
  const protoWidth = widths[pc] ?? 0;
  const covering = grid.cells.filter((c) => c.col <= pc && pc < c.col + c.colSpan);
  const extended = new Set(covering.filter((c) => c.colSpan > 1));
  const edits: SpanEdit[] = [];
  let clonedCells = 0;

  for (const c of grid.cells) {
    if (c.col >= ins && !extended.has(c) && c.addr !== undefined) edits.push(...setAttrs(ctx, c.addr, { colAddr: String(c.col + k) }, "뒤 열의 열 주소"));
  }
  for (const c of extended) {
    if (c.span !== undefined) edits.push(...setAttrs(ctx, c.span, { colSpan: String(c.colSpan + k) }, "가로 병합 늘림"));
    if (c.size !== undefined) edits.push(...setAttrs(ctx, c.size, { width: String(c.width + k * protoWidth) }, "병합 셀 너비"));
  }
  for (const c of covering) {
    if (c.colSpan !== 1) continue;
    const copies: string[] = [];
    for (let j = 0; j < k; j++) {
      const rep = c.addr === undefined ? undefined : attrRep(c.addr, "colAddr", String(ins + j), c.tc.start);
      copies.push(copyElement(ctx, c.tc, { text: options.text, reissue, blankCellNames: true, closedFields: true }, rep === undefined ? [] : [rep]));
    }
    clonedCells += k;
    const at = options.position === "after" ? c.tc.end : c.tc.start;
    edits.push(span(ctx, at, at, copies.join(""), `열 ${pc}의 셀(행 ${c.row})을 원형으로 ${k}개 복제`));
  }
  edits.push(...setAttrs(ctx, grid.table, { colCnt: String(grid.colCnt + k) }, "표 열 수"));
  edits.push(...widthDeltaEdits(ctx, grid.table, k * protoWidth));
  return { edits, clonedCells };
}

function normalizeInsert(grid: TableGrid, options: InsertColumnsOptions): Required<InsertColumnsOptions> {
  if (typeof options !== "object" || options === null) throw bad("options는 객체여야 합니다.");
  const position = options.position ?? "after";
  if (position !== "after" && position !== "before") throw bad(`position ${JSON.stringify(position)}은(는) after나 before여야 합니다.`);
  const text = options.text ?? "clear";
  if (text !== "clear" && text !== "keep") throw bad(`text ${JSON.stringify(text)}은(는) clear나 keep이어야 합니다.`);
  return {
    prototype: checkIndex("prototype", options.prototype, grid.colCnt),
    count: options.count === undefined ? 1 : checkCount("count", options.count),
    position,
    text,
  };
}

/**
 * 열을 원형으로 복제해 넣는다. 복제한 셀의 서식 참조는 원형과 같다. 열 주소·열 수·너비를 갱신한다: 새 열의 너비는 원형 열 너비이고
 * 표 너비는 그만큼 늘어난다(원본이 "표 너비 = 열 합"이 아니었다면 그 차이가 유지된다). 원형 열을 걸친 가로 병합 셀은 폭을 늘린다.
 * 격자가 불규칙하면 `TABLE_IRREGULAR`, 셀 영역 목록이 있으면 `TABLE_UNSUPPORTED`, 너비 기준이 절대값이 아니면 `TABLE_RELATIVE_SIZE`.
 */
export function planInsertColumns(doc: HwpxDocument, target: TableTarget, options: InsertColumnsOptions): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  const grid = requireGrid(table, ctx.entry, { widths: true, structure: true });
  requireAbsolute(table, "width", ctx.entry);
  const o = normalizeInsert(grid, options);
  const reissue = makeReissuer(doc);
  const { edits, clonedCells } = insertColumnsEdits(ctx, grid, o, reissue);
  return finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, insertedColumns: o.count, insertedCells: clonedCells, reissuedIds: reissue.count });
}

/**
 * 열 삭제의 편집들. 지운 열 안에만 있던 셀은 지우고, 지운 열을 일부 걸친 병합 셀은 폭과 너비를 줄이고, 뒤 열의 `colAddr`를 당긴다.
 * 지운 뒤 셀이 하나도 남지 않는 행(`tr`)이 생기면 `TABLE_SPAN_CONFLICT`. 지워지는 셀들이 셀을 가로지르는 누름틀의 시작과 끝 사이를 자르면
 * (한쪽 반이 남는다) `TABLE_SPLITS_FIELD`.
 */
export function deleteColumnsEdits(ctx: Ctx, grid: TableGrid, cols: readonly number[]): { edits: SpanEdit[]; removedCells: number } {
  const widths = grid.widths;
  if (widths === undefined) throw new HwpxError("TABLE_IRREGULAR", "열 너비를 읽을 수 없습니다.", ctx.entry);
  const doomed = new Set(cols);
  const before: number[] = []; // 열 번호 → 그 앞에서 지워진 열 수
  let gone = 0;
  for (let c = 0; c < grid.colCnt; c++) {
    before.push(gone);
    if (doomed.has(c)) gone++;
  }
  const wholeCells = grid.cells.filter((cell) => {
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) if (!doomed.has(c)) return false;
    return true;
  });
  assertFieldsClosed(wholeCells.flatMap((cell) => [...walkElements(cell.tc)]), "지울");
  const edits: SpanEdit[] = [];
  const remaining = new Map<XElement, number>();
  for (const tr of grid.rows) remaining.set(tr, childEls(tr, "paragraph", "tc").length);
  let removedCells = 0;
  let removedWidth = 0;
  for (let c = 0; c < grid.colCnt; c++) if (doomed.has(c)) removedWidth += widths[c] ?? 0;

  for (const cell of grid.cells) {
    const kept: number[] = [];
    let deletedWidth = 0;
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
      if (doomed.has(c)) deletedWidth += widths[c] ?? 0;
      else kept.push(c);
    }
    if (kept.length === 0) {
      edits.push(span(ctx, cell.tc.start, cell.tc.end, "", `열 삭제로 셀(행 ${cell.row}, 열 ${cell.col}) 삭제`));
      remaining.set(cell.tr, (remaining.get(cell.tr) ?? 1) - 1);
      removedCells++;
      continue;
    }
    const first = kept[0] ?? 0;
    const newCol = first - (before[first] ?? 0);
    if (cell.addr !== undefined && newCol !== cell.col) edits.push(...setAttrs(ctx, cell.addr, { colAddr: String(newCol) }, "열 주소"));
    if (cell.span !== undefined && kept.length !== cell.colSpan) edits.push(...setAttrs(ctx, cell.span, { colSpan: String(kept.length) }, "가로 병합 줄임"));
    if (cell.size !== undefined && deletedWidth > 0) edits.push(...setAttrs(ctx, cell.size, { width: String(cell.width - deletedWidth) }, "셀 너비"));
  }
  for (const [tr, left] of remaining) {
    if (left === 0 && childEls(tr, "paragraph", "tc").length > 0) {
      throw new HwpxError("TABLE_SPAN_CONFLICT", "열을 지우면 셀이 하나도 남지 않는 행이 생깁니다(세로 병합이 그 행을 덮고 있습니다).", ctx.entry);
    }
  }
  edits.push(...setAttrs(ctx, grid.table, { colCnt: String(grid.colCnt - doomed.size) }, "표 열 수"));
  edits.push(...widthDeltaEdits(ctx, grid.table, -removedWidth));
  return { edits, removedCells };
}

/**
 * 열을 지운다(`cols`는 열 번호, 0부터). 모든 열을 지우거나 범위 밖이거나 겹치면 `TABLE_BAD_ARG`.
 * 지운 열의 너비만큼 표 너비가 줄고, 지운 열을 일부 걸친 병합 셀은 폭과 너비가 준다. 거절 규칙은 `planInsertColumns`와 같다.
 */
export function planDeleteColumns(doc: HwpxDocument, target: TableTarget, options: { cols: number[] }): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  const grid = requireGrid(table, ctx.entry, { widths: true, structure: true });
  requireAbsolute(table, "width", ctx.entry);
  const list = options?.cols;
  if (!Array.isArray(list) || list.length === 0) throw bad("cols는 비어 있지 않은 열 번호 배열이어야 합니다.");
  const cols = list.map((c) => checkIndex("열 번호", c, grid.colCnt));
  if (new Set(cols).size !== cols.length) throw bad("같은 열을 두 번 지정했습니다.");
  if (cols.length >= grid.colCnt) throw bad("모든 열을 지울 수는 없습니다.");
  const { edits, removedCells } = deleteColumnsEdits(ctx, grid, cols);
  return finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, deletedColumns: cols.length, deletedCells: removedCells });
}
