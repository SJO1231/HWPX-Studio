import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";
import { parseParagraph } from "../model/paragraph.ts";
import type { HwpxDocument } from "../model/types.ts";
import { attrNode, childEl, childEls, walkElements, type XElement } from "../xml/tree.ts";
import { assertFieldsClosed, copyElement } from "./copy.ts";
import { applyReps, resolveTarget, setAttrs, span, type Ctx, type Rep } from "./edit.ts";
import { rowHeights, type GridCell, type TableGrid } from "./grid.ts";
import { finishPlan } from "./props.ts";
import { requireGrid } from "./require.ts";
import { checkIndex } from "./rows.ts";
import type { TableTarget } from "./types.ts";

const bad = (message: string): HwpxError => new HwpxError("TABLE_BAD_ARG", message);
const conflict = (message: string): HwpxError => new HwpxError("TABLE_SPAN_CONFLICT", message);

const sum = (list: readonly number[], from: number, to: number): number => {
  let total = 0;
  for (let i = from; i < to; i++) total += list[i] ?? 0;
  return total;
};

function readRange(what: string, value: unknown, size: number): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw bad(`${what}은(는) [시작, 끝] 두 정수여야 합니다.`);
  const from = checkIndex(`${what}의 시작`, value[0], size);
  const to = checkIndex(`${what}의 끝`, value[1], size);
  if (to < from) throw bad(`${what} ${JSON.stringify(value)}의 시작이 끝보다 큽니다.`);
  return [from, to];
}

/** 셀의 직속 문단 요소들 */
function cellParagraphs(tc: XElement): XElement[] {
  const sub = childEl(tc, "paragraph", "subList");
  return sub === undefined ? [] : childEls(sub, "paragraph", "p");
}

/** 글·탭·객체가 하나도 없는 빈 문단인가(논리 텍스트가 비었다) */
const isEmptyParagraph = (p: XElement): boolean => parseParagraph(p, []).logicalText === "";

export type MergeOptions = {
  /** 합칠 행 범위 `[시작, 끝]`(양 끝 포함, 0부터) */
  rows: [number, number];
  /** 합칠 열 범위 `[시작, 끝]`(양 끝 포함, 0부터) */
  cols: [number, number];
  /** `concat`(기본)이면 합쳐지는 다른 셀의 비어 있지 않은 문단을 왼쪽 위 셀 뒤에 이어 붙이고, `first`면 왼쪽 위 셀의 글만 남긴다 */
  content?: "concat" | "first";
};

/**
 * 직사각형 범위의 셀들을 하나로 합친다. 남는 셀은 왼쪽 위 셀이고(서식 그대로) 병합 수와 너비·높이는 걸친 열·행의 합으로 맞춘다.
 * 범위 안에 있는 다른 셀은 지운다. 범위를 일부만 덮는 셀(병합 셀이 범위 경계를 가로지름)이 있으면 `TABLE_SPAN_CONFLICT`,
 * 범위가 이미 셀 하나뿐이면 `TABLE_BAD_ARG`. `content: "first"`로 버려지는 셀이 셀을 가로지르는 누름틀의 시작과 끝 사이를 자르면 `TABLE_SPLITS_FIELD`.
 * `concat`: 다른 셀의 문단 가운데 글·객체가 있는 것을 행·열 순서로 왼쪽 위 셀 뒤에 옮긴다(옮기는 문단은 그대로 이동이라 id가 겹치지 않는다).
 * 왼쪽 위 셀이 비어 있으면 그 빈 문단은 지운다.
 */
export function planMergeCells(doc: HwpxDocument, target: TableTarget, options: MergeOptions): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  const grid = requireGrid(table, ctx.entry, { widths: true, structure: true });
  if (typeof options !== "object" || options === null) throw bad("options는 객체여야 합니다.");
  const [r0, r1] = readRange("rows", options.rows, grid.rowCnt);
  const [c0, c1] = readRange("cols", options.cols, grid.colCnt);
  const content = options.content ?? "concat";
  if (content !== "concat" && content !== "first") throw bad(`content ${JSON.stringify(content)}은(는) concat이나 first여야 합니다.`);

  const inside = new Set<GridCell>();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = grid.at(r, c);
      if (cell !== undefined) inside.add(cell);
    }
  }
  for (const cell of inside) {
    if (cell.row < r0 || cell.col < c0 || cell.row + cell.rowSpan - 1 > r1 || cell.col + cell.colSpan - 1 > c1) {
      throw conflict(`범위 밖으로 뻗는 병합 셀(행 ${cell.row}, 열 ${cell.col}, ${cell.rowSpan}×${cell.colSpan})이 있어 그 범위를 하나로 합칠 수 없습니다.`);
    }
  }
  if (inside.size < 2) throw bad("합칠 범위가 이미 셀 하나입니다.");
  // 한컴은 셀이 하나도 시작하지 않는 행(`tr`)을 열지 못한다(관측: 그런 표를 열면 열기에 실패한다). 한컴 화면은 그런 행을 지우며 합친다.
  // 합친 뒤 첫 행 아래의 행에 범위 밖 셀이 없으면(범위가 모든 열을 덮거나, 남은 열이 위에서 내려오는 병합에 덮이면) 이 연산은 그 행을 만들 수 없어 거절한다.
  for (let r = r0 + 1; r <= r1; r++) {
    if (!grid.cells.some((c) => c.row === r && !inside.has(c))) {
      throw conflict(`합치면 행 ${r}에 시작하는 셀이 하나도 남지 않습니다(한컴은 빈 행을 열지 못합니다). 범위가 모든 열을 덮는 병합은 행을 지운 뒤 한 행에서 하세요.`);
    }
  }
  const head = grid.at(r0, c0);
  const widths = grid.widths;
  const heights = rowHeights(grid);
  if (head === undefined || widths === undefined || heights === undefined) throw new HwpxError("TABLE_IRREGULAR", "격자를 읽을 수 없습니다.", ctx.entry);

  const others = [...inside].filter((c) => c !== head).sort((a, b) => a.row - b.row || a.col - b.col);
  // `first`는 다른 셀의 문단을 옮기지 않고 버린다: 버려지는 셀들이 셀을 가로지르는 누름틀의 시작과 끝 사이를 자르면 한쪽 반이 남는다
  if (content === "first") assertFieldsClosed(others.flatMap((c) => [...walkElements(c.tc)]), "지울");
  const edits: SpanEdit[] = [];
  if (head.span !== undefined) edits.push(...setAttrs(ctx, head.span, { rowSpan: String(r1 - r0 + 1), colSpan: String(c1 - c0 + 1) }, "병합 수"));
  if (head.size !== undefined) edits.push(...setAttrs(ctx, head.size, { width: String(sum(widths, c0, c1 + 1)), height: String(sum(heights, r0, r1 + 1)) }, "병합 셀 크기"));

  let moved = 0;
  let dropped = 0;
  const appended: string[] = [];
  const headSub = childEl(head.tc, "paragraph", "subList");
  const headParagraphs = cellParagraphs(head.tc);
  for (const cell of others) {
    edits.push(span(ctx, cell.tc.start, cell.tc.end, "", `병합으로 셀(행 ${cell.row}, 열 ${cell.col}) 지움`));
    for (const p of cellParagraphs(cell.tc)) {
      if (content === "concat" && !isEmptyParagraph(p)) {
        appended.push(copyElement(ctx, p, { text: "keep", reissue: undefined }));
        moved++;
      } else {
        dropped++;
      }
    }
  }
  if (appended.length > 0) {
    if (headSub === undefined || headSub.closeStart === headSub.openEnd) throw new HwpxError("TABLE_IRREGULAR", "왼쪽 위 셀에 문단을 이을 subList가 없습니다.", ctx.entry);
    if (headParagraphs.every(isEmptyParagraph)) {
      for (const p of headParagraphs) {
        edits.push(span(ctx, p.start, p.end, "", "병합: 왼쪽 위 셀의 빈 문단 지움"));
        dropped++;
      }
    }
    edits.push(span(ctx, headSub.closeStart, headSub.closeStart, appended.join(""), "병합: 다른 셀의 문단을 이어 붙임"));
  }
  return finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, removedCells: others.length, movedParagraphs: moved, removedParagraphs: dropped });
}

/** 원 셀의 서식을 복제한 빈 셀 원문: 내용은 첫 문단의 모양을 따른 빈 문단 하나다. */
function emptyCellXml(ctx: Ctx, cell: GridCell, row: number, col: number, width: number, height: number): string {
  const sub = childEl(cell.tc, "paragraph", "subList");
  const first = cellParagraphs(cell.tc)[0];
  if (sub === undefined || first === undefined || sub.closeStart === sub.openEnd) throw new HwpxError("TABLE_IRREGULAR", `셀(행 ${cell.row}, 열 ${cell.col})에 문단이 없어 복제할 수 없습니다.`, ctx.entry);
  const run = childEl(first, "paragraph", "run");
  const charPr = run === undefined ? undefined : attrNode(run, "charPrIDRef")?.value;
  const runName = run === undefined ? `${first.prefix === "" ? "" : `${first.prefix}:`}run` : run.qname;
  const idAttr = attrNode(first, "id");
  const placeholder = idAttr === undefined || ["", "0", "2147483648", "4294967295"].includes(idAttr.value);
  const startTag = applyReps(
    ctx.text.slice(first.start, first.openEnd),
    placeholder || idAttr === undefined ? [] : [{ start: idAttr.valueStart - first.start, end: idAttr.valueEnd - first.start, text: "0" }],
  );
  const paragraph = `${startTag}<${runName} charPrIDRef="${charPr ?? "0"}"/></${first.qname}>`;

  const base = cell.tc.start;
  const reps: Rep[] = [{ start: sub.openEnd - base, end: sub.closeStart - base, text: paragraph }];
  const put = (el: XElement | undefined, name: string, value: string): void => {
    const attr = el === undefined ? undefined : attrNode(el, name);
    if (attr !== undefined) reps.push({ start: attr.valueStart - base, end: attr.valueEnd - base, text: value });
  };
  put(childEl(cell.tc, "paragraph", "cellAddr"), "rowAddr", String(row));
  put(childEl(cell.tc, "paragraph", "cellAddr"), "colAddr", String(col));
  put(childEl(cell.tc, "paragraph", "cellSpan"), "rowSpan", "1");
  put(childEl(cell.tc, "paragraph", "cellSpan"), "colSpan", "1");
  put(childEl(cell.tc, "paragraph", "cellSz"), "width", String(width));
  put(childEl(cell.tc, "paragraph", "cellSz"), "height", String(height));
  const name = attrNode(cell.tc, "name");
  if (name !== undefined && name.value !== "") reps.push({ start: name.valueStart - base, end: name.valueEnd - base, text: "" });
  return applyReps(ctx.text.slice(cell.tc.start, cell.tc.end), reps);
}

/**
 * 병합된 셀을 1×1 셀들로 되돌린다. 왼쪽 위 칸은 원래 셀(글 그대로)이 되고 나머지 칸에는 원 셀의 서식을 복제한 빈 셀을 만든다
 * (내용은 원 셀 첫 문단의 모양을 따른 빈 문단 하나). 칸의 너비·높이는 그 열·행의 너비·높이다.
 * `row`·`col`은 병합 셀이 덮는 아무 칸의 주소여도 된다. 이미 1×1인 셀이면 `TABLE_BAD_ARG`(더 쪼개는 것은 지원하지 않는다).
 */
export function planSplitCell(doc: HwpxDocument, target: TableTarget, options: { row: number; col: number }): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  const grid: TableGrid = requireGrid(table, ctx.entry, { widths: true, structure: true });
  const row = checkIndex("row", options?.row, grid.rowCnt);
  const col = checkIndex("col", options?.col, grid.colCnt);
  const cell = grid.at(row, col);
  const widths = grid.widths;
  const heights = rowHeights(grid);
  if (cell === undefined || widths === undefined || heights === undefined) throw bad(`주소 (${row}, ${col})에 셀이 없습니다.`);
  // 새 셀의 너비·높이는 그 열·행의 너비·높이다. 1 미만이면(높이 0인 행 등) 만들 수 없다
  for (let c = cell.col; c < cell.col + cell.colSpan; c++) if ((widths[c] ?? 0) < 1) throw bad(`열 ${c}의 너비가 1 미만이라 셀을 쪼갤 수 없습니다.`);
  for (let r = cell.row; r < cell.row + cell.rowSpan; r++) if ((heights[r] ?? 0) < 1) throw bad(`행 ${r}의 높이가 1 미만이라 셀을 쪼갤 수 없습니다.`);
  if (cell.rowSpan === 1 && cell.colSpan === 1) throw bad(`셀(행 ${cell.row}, 열 ${cell.col})은 이미 1×1이라 더 쪼갤 수 없습니다(병합된 셀만 되돌립니다).`);

  const edits: SpanEdit[] = [];
  if (cell.span !== undefined) edits.push(...setAttrs(ctx, cell.span, { rowSpan: "1", colSpan: "1" }, "병합 풀기"));
  if (cell.size !== undefined) edits.push(...setAttrs(ctx, cell.size, { width: String(widths[cell.col] ?? 0), height: String(heights[cell.row] ?? 0) }, "분할한 셀 크기"));
  let created = 0;
  for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
    const tr = grid.rows[r];
    if (tr === undefined) continue;
    const here = grid.cells.filter((c) => c.tr === tr);
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
      if (r === cell.row && c === cell.col) continue;
      const next = here.filter((x) => x.col > c).sort((a, b) => a.col - b.col)[0];
      const at = next === undefined ? tr.closeStart : next.tc.start;
      edits.push(span(ctx, at, at, emptyCellXml(ctx, cell, r, c, widths[c] ?? 0, heights[r] ?? 0), `병합 셀을 풀며 칸 (${r}, ${c})에 셀 추가`));
      created++;
    }
  }
  return finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, createdCells: created });
}
