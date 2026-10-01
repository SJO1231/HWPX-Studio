import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";
import type { HwpxDocument } from "../model/types.ts";
import { childEl, type XElement } from "../xml/tree.ts";
import { resolveTarget, setAttrs, type Ctx } from "./edit.ts";
import { intAttr, rowHeights, type TableGrid } from "./grid.ts";
import { finishPlan } from "./props.ts";
import { requireAbsolute, requireGrid } from "./require.ts";
import type { TableTarget } from "./types.ts";

const MAX_UNIT = 2147483647;
const bad = (message: string): HwpxError => new HwpxError("TABLE_BAD_ARG", message);

function requireSz(table: XElement, entry: string): XElement {
  const sz = childEl(table, "paragraph", "sz");
  if (sz === undefined) throw new HwpxError("TABLE_IRREGULAR", "표에 sz 요소가 없어 크기를 맞출 수 없습니다.", entry);
  return sz;
}

const sum = (list: readonly number[], from = 0, to = list.length): number => {
  let total = 0;
  for (let i = from; i < to; i++) total += list[i] ?? 0;
  return total;
};

/** 열 너비 → 열 경계 위치(길이 `widths.length + 1`, 맨 왼쪽이 0) */
const boundsOfWidths = (widths: readonly number[]): number[] => {
  const bounds = [0];
  for (const w of widths) bounds.push((bounds[bounds.length - 1] ?? 0) + w);
  return bounds;
};

/**
 * 셀 너비를 새 열 경계의 차(걸친 열의 합)로, 표 `sz@width`를 `tableWidth`로 맞추는 편집들. `tableWidth`가 없으면 `sz`는 건드리지 않는다.
 * 값이 같으면 편집이 없다.
 */
export function widthEdits(ctx: Ctx, grid: TableGrid, bounds: readonly number[], tableWidth: number | undefined): SpanEdit[] {
  const edits: SpanEdit[] = [];
  for (const cell of grid.cells) {
    if (cell.size === undefined) continue;
    edits.push(...setAttrs(ctx, cell.size, { width: String((bounds[cell.col + cell.colSpan] ?? 0) - (bounds[cell.col] ?? 0)) }, "셀 너비"));
  }
  const sz = childEl(grid.table, "paragraph", "sz");
  if (sz !== undefined && tableWidth !== undefined) edits.push(...setAttrs(ctx, sz, { width: String(tableWidth) }, "표 너비"));
  return edits;
}

/**
 * 열 너비를 지정한다(HWPUNIT, 열마다 1 이상의 정수, 개수는 `colCnt`). 모든 셀의 너비를 걸친 열의 합으로 맞추고(병합 셀 포함)
 * 표 너비(`sz@width`)는 열 너비의 합으로 맞춘다. 구조가 규칙적이어야 하고(`TABLE_IRREGULAR`) 너비 기준이 절대값이어야 한다(`TABLE_RELATIVE_SIZE`).
 * 새 너비를 주는 연산이라 지금 열 너비가 모순이어도(행끼리 열 경계가 어긋나도) 한다. 결과의 모든 셀이 새 열 너비의 합이 되어 모순이 사라진다.
 */
export function planSetColumnWidths(doc: HwpxDocument, target: TableTarget, widths: number[]): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  const grid = requireGrid(table, ctx.entry);
  requireAbsolute(table, "width", ctx.entry);
  requireSz(table, ctx.entry);
  if (!Array.isArray(widths) || widths.length !== grid.colCnt) throw bad(`열 너비는 ${grid.colCnt}개여야 합니다(받은 것 ${Array.isArray(widths) ? widths.length : "배열 아님"}개).`);
  for (const w of widths) {
    if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > MAX_UNIT) throw bad(`열 너비 ${JSON.stringify(w)}은(는) 1 이상의 정수여야 합니다.`);
  }
  const total = sum(widths);
  if (total > MAX_UNIT) throw bad(`열 너비의 합 ${total}이(가) 너무 큽니다.`);
  const edits = widthEdits(ctx, grid, boundsOfWidths(widths), total);
  return finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, columns: grid.colCnt });
}

/**
 * 비례 조정(열 너비 목록용): 새 너비 `total`에 맞춰 열 너비를 비례로 줄이거나 늘린다. 열마다 반올림하고 나머지는 마지막 열이 흡수해 합이 정확히 `total`이 된다.
 * `planScaleTable`은 이것이 아니라 경계 위치를 조정하는 `scaleBounds`를 쓴다.
 */
export function scaleWidths(old: readonly number[], total: number): number[] {
  const oldTotal = sum(old);
  if (oldTotal <= 0) throw new HwpxError("TABLE_IRREGULAR", "열 너비의 합이 0이라 비례 조정할 수 없습니다.");
  const last = old.length - 1;
  const out = old.map((w, i) => (i < last ? Math.round((w * total) / oldTotal) : 0));
  out[last] = total - sum(out, 0, last);
  return out;
}

/**
 * 경계 위치를 비례로 조정한다: 새 경계 = round(경계 × 새 너비 / 지금 너비), 맨 오른쪽 경계는 새 너비다. 열 너비는 이웃 경계의 차이므로
 * 병합 셀의 경계도 같은 비율로 옮겨져 행마다 셀 너비의 합이 새 너비와 같다. 비율이 1이면 경계가 그대로다.
 */
export function scaleBounds(bounds: readonly number[], total: number): number[] {
  const old = bounds[bounds.length - 1] ?? 0;
  if (old <= 0) throw new HwpxError("TABLE_IRREGULAR", "열 너비의 합이 0이라 비례 조정할 수 없습니다.");
  const last = bounds.length - 1;
  return bounds.map((b, i) => (i === 0 ? 0 : i === last ? total : Math.round((b * total) / old)));
}

/**
 * 표 전체 너비를 `{ scale }`(비율)이나 `{ width }`(목표값, HWPUNIT)로 바꾸고 열 경계를 비례 조정한다. 기준은 지금 열 너비의 합(맨 오른쪽 경계)이다.
 * 열 너비가 1 미만이 되면 `TABLE_BAD_ARG`. 비율 1이나 지금 너비와 같은 `width`는 편집이 없다(표 `sz@width`도 그대로 둔다).
 * 열 너비가 필요한 연산이라 너비 불규칙이면 `TABLE_IRREGULAR`. 나머지 규칙은 `planSetColumnWidths`와 같다.
 */
export function planScaleTable(doc: HwpxDocument, target: TableTarget, spec: { scale: number } | { width: number }): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  if (typeof spec !== "object" || spec === null) throw bad("spec은 { scale } 이나 { width } 객체여야 합니다.");
  const grid = requireGrid(table, ctx.entry, { widths: true });
  requireAbsolute(table, "width", ctx.entry);
  requireSz(table, ctx.entry);
  const bounds = grid.xBounds ?? [];
  const current = bounds[bounds.length - 1] ?? 0;
  let total: number;
  if ("scale" in spec) {
    if (typeof spec.scale !== "number" || !Number.isFinite(spec.scale) || spec.scale <= 0) throw bad(`scale ${JSON.stringify(spec.scale)}은(는) 0보다 큰 수여야 합니다.`);
    total = Math.round(current * spec.scale);
  } else {
    total = spec.width;
  }
  if (typeof total !== "number" || !Number.isInteger(total) || total < grid.colCnt || total > MAX_UNIT) {
    throw bad(`표 너비 ${JSON.stringify(total)}은(는) 열 수(${grid.colCnt}) 이상 ${MAX_UNIT} 이하의 정수여야 합니다.`);
  }
  const next = scaleBounds(bounds, total);
  for (let i = 0; i + 1 < next.length; i++) {
    if ((next[i + 1] ?? 0) - (next[i] ?? 0) < 1) throw bad(`너비를 줄이면 1 미만이 되는 열이 있습니다(열 ${i}).`);
  }
  const edits = widthEdits(ctx, grid, next, total === current ? undefined : total);
  return finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, columns: grid.colCnt, width: total });
}

/**
 * 행 높이(최소 높이)를 지정한다. `rows`의 `row`는 행 번호(0부터), `height`는 0 이상의 HWPUNIT 정수다.
 * 그 행에서 시작하는 rowSpan 1 셀들의 높이를 그 값으로, 그 행을 걸친 병합 셀은 걸친 행 높이의 합으로 맞춘다. 그 밖의 셀은 건드리지 않는다.
 * 표 높이(`sz@height`)는 행 높이 합의 변화량만큼 바꾼다: 원본이 "표 높이 = 행 합"이었다면 그 관계가 유지되고, 아니었다면(내용이 늘려 그린 표) 그 차이가 유지된다.
 */
export function planSetRowHeights(doc: HwpxDocument, target: TableTarget, rows: { row: number; height: number }[]): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  const grid = requireGrid(table, ctx.entry);
  requireAbsolute(table, "height", ctx.entry);
  const sz = requireSz(table, ctx.entry);
  const old = rowHeights(grid) ?? [];
  if (!Array.isArray(rows) || rows.length === 0) throw bad("rows는 비어 있지 않은 배열이어야 합니다.");
  const next = [...old];
  const changed = new Set<number>();
  for (const r of rows) {
    if (typeof r !== "object" || r === null || !Number.isInteger(r.row) || r.row < 0 || r.row >= grid.rowCnt) throw bad(`행 번호 ${JSON.stringify(r?.row)}이(가) 범위(0~${grid.rowCnt - 1})를 벗어납니다.`);
    if (!Number.isInteger(r.height) || r.height < 0 || r.height > MAX_UNIT) throw bad(`행 높이 ${JSON.stringify(r.height)}은(는) 0 이상의 정수여야 합니다.`);
    if (changed.has(r.row)) throw bad(`행 ${r.row}을(를) 두 번 지정했습니다.`);
    changed.add(r.row);
    next[r.row] = r.height;
  }
  const edits: SpanEdit[] = [];
  for (const cell of grid.cells) {
    let touched = false;
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) if (changed.has(r)) touched = true;
    if (touched && cell.size !== undefined) edits.push(...setAttrs(ctx, cell.size, { height: String(sum(next, cell.row, cell.row + cell.rowSpan)) }, "셀 높이"));
  }
  const height = intAttr(sz, "height");
  if (height !== undefined) edits.push(...setAttrs(ctx, sz, { height: String(Math.max(0, height + sum(next) - sum(old))) }, "표 높이"));
  return finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, editedRows: changed.size });
}
