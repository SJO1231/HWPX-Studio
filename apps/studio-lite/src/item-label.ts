// 입력 항목 라벨 찾기(#148, 요구 8.9-3). 라벨인지는 엔진의 라벨 판정(`colonLabel`·`isLabelText`, 엔진 명세 8.3 후보 자리와 같은 규칙)으로 본다.
// 가까운 것부터: 같은 문단에서 자리 앞이 `라벨:` → 같은 표 행에서 왼쪽으로 가장 가까운 라벨 칸 → 위 제목(엔진 `detectHeadings`).
import { colonLabel, isLabelText, isTableNode, walkParagraphs, type HwpxDocument, type ParagraphNode, type TableCell, type TableNode } from '@hwpx-studio/engine';
import { LABEL_MAX, type ItemLabel } from './input-table.ts';

type Row = { id: string; sectionIndex: number; path: number[]; text: string };
type Heading = { id: string; name: string };

const clean = (text: string) => text.replaceAll('\uFFFC', '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
/**
 * 한 문단에 `라벨: 값, 라벨: 값`이나 `라벨: 값 ~ 라벨: 값`처럼 여럿이면 앞 값 뒤의 나눔(쉼표·쌍반점·탭·물결) 뒤만 라벨로 본다.
 * 공백은 나눔이 아니다(공고서 라벨은 `신  청  기  관:`처럼 글자 사이를 띄운다).
 */
const SEPARATOR = /[,，;；\t~∼～]/gu;
/** 쌍점에서 자리까지 이 글자 수 안이면 그 `라벨:`의 값으로 본다(`접수 기간: 2026. 1. 5. 09:00 ~ 2026. 1. 9. 18:00`의 뒤 값까지) */
const COLON_REACH = 40;

/**
 * 자리 앞(같은 문단)의 가장 가까운 `라벨:`. 시각의 쌍점(`10:00`)은 라벨 쌍점이 아니고, 개체·필드 자리 표시(`\uFFFC`)는 빼고 본다.
 * 라벨은 그 쌍점 앞에서 앞 쌍점·나눔 뒤 글이고 엔진의 `라벨:` 글 규칙(`colonLabel`)에 맞아야 한다. 거리는 쌍점 뒤부터 자리까지 글자 수.
 */
export function colonLabelBefore(text: string, start: number): ItemLabel | undefined {
  const prefix = text.slice(0, start).replaceAll('\uFFFC', '');
  const isTime = (i: number) => /\d/u.test(prefix[i - 1] ?? '') && /\d/u.test(prefix[i + 1] ?? '');
  const colon = [...prefix.matchAll(/[:：]/gu)].map(m => m.index).filter(i => !isTime(i)).at(-1);
  if (colon === undefined || prefix.length - colon - 1 > COLON_REACH) return undefined;
  const before = prefix.slice(0, colon);
  const cut = Math.max(before.lastIndexOf(':'), before.lastIndexOf('：'), ...[...before.matchAll(SEPARATOR)].map(m => m.index));
  const label = colonLabel(prefix.slice(cut + 1, colon + 1));
  return label === undefined ? undefined : { text: clean(label), rel: 'colon', distance: prefix.length - colon - 1 };
}

const samePath = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);
/** 줄(문단)이 든 표 칸. 표 칸 문단의 주소는 [… 표를 가진 문단, 칸 목록 번호, 문단 번호]다 */
function cellOf(doc: HwpxDocument, row: Row): { table: TableNode; cell: TableCell } | undefined {
  if (row.path.length < 3) return undefined;
  const section = doc.sections[row.sectionIndex], ownerPath = row.path.slice(0, -2);
  const owner = section === undefined ? undefined : [...walkParagraphs(section.paragraphs)].find((p: ParagraphNode) => samePath(p.path, ownerPath));
  const sub = owner?.subLists[row.path.at(-2)!];
  for (const o of owner?.objects ?? []) {
    if (!isTableNode(o)) continue;
    const cell = o.cells.find(c => c.subList === sub);
    if (cell) return { table: o, cell };
  }
  return undefined;
}
const cellText = (cell: TableCell) => (cell.subList?.paragraphs ?? []).map(p => p.logicalText).join('\n');

/** 같은 표 행(행 병합 포함)에서 왼쪽으로 가장 가까운 라벨 칸. 거리는 몇 칸 왼쪽인지(1 = 바로 왼쪽) */
export function rowHeaderLabel(doc: HwpxDocument, row: Row): ItemLabel | undefined {
  const at = cellOf(doc, row);
  if (!at) return undefined;
  const { table, cell } = at;
  const left = table.cells.filter(c => c !== cell && c.row <= cell.row && cell.row < c.row + c.rowSpan && c.col + c.colSpan <= cell.col).sort((a, b) => b.col - a.col);
  for (const [i, c] of left.entries()) if (isLabelText(cellText(c))) return { text: clean(cellText(c)), rel: 'rowHeader', distance: i + 1 };
  return undefined;
}

/** 줄보다 앞의 가장 가까운 제목. 거리는 몇 문단 위인지 */
export function headingLabel(rows: readonly Row[], headings: readonly Heading[], rowId: string): ItemLabel | undefined {
  const order = new Map(rows.map((r, i) => [r.id, i])), at = order.get(rowId);
  if (at === undefined) return undefined;
  let best: { h: Heading; i: number } | undefined;
  for (const h of headings) { const i = order.get(h.id); if (i !== undefined && i < at && (!best || i > best.i)) best = { h, i }; }
  return best && clean(best.h.name) ? { text: clean(best.h.name), rel: 'heading', distance: at - best.i } : undefined;
}

/** 자리(줄과 시작 위치)의 가장 가까운 라벨: `라벨:` → 행 머리 칸 → 위 제목. 없으면 undefined */
export function labelAt(doc: HwpxDocument | undefined, rows: readonly Row[], headings: readonly Heading[], row: Row, start: number): ItemLabel | undefined {
  return colonLabelBefore(row.text, start) ?? (doc ? rowHeaderLabel(doc, row) : undefined) ?? headingLabel(rows, headings, row.id);
}
