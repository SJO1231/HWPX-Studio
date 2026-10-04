import { isTableNode } from "../model/paragraph.ts";
import type { HwpxDocument, ObjectNode, ParagraphNode, SectionModel, TableCell, TableNode } from "../model/types.ts";
import { sha256Hex } from "../template/hash.ts";
import type { CellAnchor, ObjectAnchor } from "../template/types.ts";
import { attrValue, childEl } from "../xml/tree.ts";
import type { CellPrint, ObjectPrint } from "./anchor-types.ts";
import { topLevelObjects } from "./doc.ts";

// `cell`·`object` 앵커의 선택 지문(7.10). 지문이 없는 앵커는 서수만 본다(1판).

const cellText = (cell: TableCell): string => (cell.subList?.paragraphs ?? []).map((p: ParagraphNode) => p.logicalText).join("\n");

/** 표 모양과 첫 행 글들의 해시: 첫 행(가장 작은 행 주소)의 셀을 열 순서로 늘어놓은 글 목록의 sha256 */
function shapeOf(table: TableNode): { rows: number; cols: number; head: string } {
  const top = Math.min(...table.cells.map((c) => c.row));
  const heads = table.cells
    .filter((c) => c.row === top)
    .sort((a, b) => a.col - b.col)
    .map(cellText);
  return { rows: table.rowCnt, cols: table.colCnt, head: sha256Hex(JSON.stringify(heads)) };
}

/** 표의 한 셀의 지문: 표 모양(행·열 수), 첫 행 글들의 해시, 그 셀 글의 해시. 셀이 없으면 undefined. */
export function cellPrintOf(table: TableNode, row: number, col: number): CellPrint | undefined {
  const cell = table.cells.find((c) => c.row === row && c.col === col);
  return cell === undefined ? undefined : { ...shapeOf(table), text: sha256Hex(cellText(cell)) };
}

const sizeOf = (o: ObjectNode, name: "width" | "height"): number | undefined => {
  const v = attrValue(childEl(o.element, "paragraph", "sz") ?? o.element, name);
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
};

/** 객체의 지문: 종류, 크기(HWPUNIT, 있을 때), 수량(표는 셀 수. 그 밖은 생략) */
export function objectPrintOf(o: ObjectNode): ObjectPrint {
  const print: ObjectPrint = { objectType: o.type };
  const width = sizeOf(o, "width");
  const height = sizeOf(o, "height");
  if (width !== undefined) print.width = width;
  if (height !== undefined) print.height = height;
  if (isTableNode(o)) print.count = o.cells.length;
  return print;
}

const objectMatches = (o: ObjectNode, print: ObjectPrint): boolean => {
  const now = objectPrintOf(o);
  return now.objectType === print.objectType && now.width === print.width && now.height === print.height && now.count === print.count;
};

/** 구역 최상위 `ordinal`번째 표의 `(row, col)` 셀 앵커 초안(지문 포함). 표나 셀이 없으면 undefined. `id`는 쓰는 쪽이 정한다. */
export function makeCellAnchor(doc: HwpxDocument, sectionIndex: number, ordinal: number, row: number, col: number): Omit<CellAnchor, "id"> | undefined {
  const section = doc.sections[sectionIndex];
  const object = section === undefined ? undefined : topLevelObjects(section, "tbl")[ordinal]?.object;
  const print = object !== undefined && isTableNode(object) ? cellPrintOf(object, row, col) : undefined;
  return print === undefined ? undefined : { kind: "cell", table: { sectionIndex, ordinal }, row, col, print };
}

/** 구역 최상위 `ordinal`번째 `objectType` 객체의 앵커 초안(지문 포함). 없으면 undefined. `id`는 쓰는 쪽이 정한다. */
export function makeObjectAnchor(doc: HwpxDocument, objectType: string, sectionIndex: number, ordinal: number): Omit<ObjectAnchor, "id"> | undefined {
  const section = doc.sections[sectionIndex];
  const object = section === undefined ? undefined : topLevelObjects(section, objectType)[ordinal]?.object;
  return object === undefined ? undefined : { kind: "object", objectType, sectionIndex, ordinal, print: objectPrintOf(object) };
}

/** 지문을 가진 앵커의 대조 결과 */
export type PrintLocation<T> = { state: "exact"; found: T } | { state: "relocated"; found: T } | { state: "ambiguous"; count: number } | { state: "notFound" };

function pick<T>(exact: T | undefined, others: T[]): PrintLocation<T> {
  if (exact !== undefined) return { state: "exact", found: exact };
  const only = others[0];
  if (others.length === 1 && only !== undefined) return { state: "relocated", found: only };
  return others.length > 1 ? { state: "ambiguous", count: others.length } : { state: "notFound" };
}

type CellFound = { owner: ParagraphNode; table: TableNode; cell: TableCell };

/**
 * 지문이 있는 `cell` 앵커를 찾는다. 서수의 표가 모양·첫 행·셀 글이 모두 맞으면 exact다. 아니면 같은 구역 최상위 표 가운데
 * 표 모양(`rows`·`cols`)과 첫 행(`head`)이 맞는 표를 찾고, 그 표의 `row`·`col` 셀 글 해시가 맞는 곳을 센다.
 */
export function locateCell(section: SectionModel, a: CellAnchor, print: CellPrint): PrintLocation<CellFound> {
  const matches = (owner: ParagraphNode, table: TableNode): CellFound | undefined => {
    const now = cellPrintOf(table, a.row, a.col);
    const cell = table.cells.find((c) => c.row === a.row && c.col === a.col);
    if (now === undefined || cell === undefined) return undefined;
    return now.rows === print.rows && now.cols === print.cols && now.head === print.head && now.text === print.text ? { owner, table, cell } : undefined;
  };
  const all = topLevelObjects(section, "tbl").flatMap((x) => (isTableNode(x.object) ? [{ owner: x.paragraph, table: x.object }] : []));
  const at = topLevelObjects(section, "tbl")[a.table.ordinal];
  const exact = at !== undefined && isTableNode(at.object) ? matches(at.paragraph, at.object) : undefined;
  return pick(
    exact,
    all.flatMap((x) => {
      const hit = matches(x.owner, x.table);
      return hit === undefined ? [] : [hit];
    }),
  );
}

type ObjectFound = { paragraph: ParagraphNode; object: ObjectNode };

/** 지문이 있는 `object` 앵커를 찾는다. 서수의 객체가 지문과 맞으면 exact, 아니면 같은 구역 최상위의 같은 종류 객체 가운데 지문이 맞는 곳을 센다. */
export function locateObject(section: SectionModel, a: ObjectAnchor, print: ObjectPrint): PrintLocation<ObjectFound> {
  const all = topLevelObjects(section, a.objectType);
  const at = all[a.ordinal];
  const exact = at !== undefined && objectMatches(at.object, print) ? at : undefined;
  return pick(
    exact,
    all.filter((x) => objectMatches(x.object, print)),
  );
}
