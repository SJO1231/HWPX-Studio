import { walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument } from "../model/types.ts";
import { attrValue, childEl, elIs, walkElements, type XElement } from "../xml/tree.ts";
import { intAttr, readTableGrid } from "./grid.ts";
import type { TableTarget } from "./types.ts";

/** 표 하나의 요약(글 내용은 없다) */
export type TableInfo = {
  sectionIndex: number;
  target: TableTarget;
  /** 구역 안 문서 순서 번호(중첩 표 포함, 0부터) */
  ordinal: number;
  /** 구역 최상위 문단에 든 표의 순서(템플릿 `object` 앵커의 `ordinal`). 중첩 표나 머리말 등 안의 표는 undefined */
  topOrdinal?: number;
  /** 중첩 깊이: 다른 표 안에 있으면 1, 그 안이면 2… 최상위는 0 */
  depth: number;
  /** 표를 담은 문단의 주소(`[문단, 하위목록, 문단, ...]`) */
  paragraphPath: number[];
  rowCnt: number | undefined;
  colCnt: number | undefined;
  width: number | undefined;
  height: number | undefined;
  treatAsChar: boolean | undefined;
  pageBreak: string | undefined;
  repeatHeader: boolean | undefined;
  /** 병합된 셀(rowSpan이나 colSpan이 1보다 큰 셀) 수 */
  mergedCells: number;
  /** 구조가 규칙적인 격자인가(행 삽입·반복·행 높이·행 수만 바꾸는 복제 등은 이것만 요구한다) */
  structureRegular: boolean;
  /** 열 너비가 정해지는가: 구조가 규칙적이고 행끼리 열 경계의 위치가 어긋나지 않는다(비례 조정·열·병합·분할은 이것도 요구한다) */
  widthRegular: boolean;
  /** 구조와 너비가 둘 다 정상이다(`structureRegular && widthRegular`) */
  regular: boolean;
};

const flag = (v: string | undefined): boolean | undefined => (v === undefined ? undefined : v === "1" || v === "true");

/** 구역 안 모든 표(중첩 포함)를 문서 순서로 모은다. */
export function listTables(doc: HwpxDocument): TableInfo[] {
  const out: TableInfo[] = [];
  for (const section of doc.sections) {
    let ordinal = 0;
    let top = 0;
    const paths = new Map<XElement, number[]>();
    for (const p of walkParagraphs(section.paragraphs)) paths.set(p.element, p.path);
    for (const el of walkElements(section.root)) {
      if (!elIs(el, "paragraph", "tbl")) continue;
      let depth = 0;
      for (let a = el.parent; a !== null; a = a.parent) if (elIs(a, "paragraph", "tbl")) depth++;
      const host = el.parent?.parent ?? null;
      const isTop = host !== null && host.parent === section.root;
      const grid = readTableGrid(el);
      const sz = childEl(el, "paragraph", "sz");
      const pos = childEl(el, "paragraph", "pos");
      const info: TableInfo = {
        sectionIndex: section.index,
        target: { sectionIndex: section.index, element: el },
        ordinal: ordinal++,
        depth,
        paragraphPath: host === null ? [] : [...(paths.get(host) ?? [])],
        rowCnt: intAttr(el, "rowCnt"),
        colCnt: intAttr(el, "colCnt"),
        width: intAttr(sz, "width"),
        height: intAttr(sz, "height"),
        treatAsChar: pos === undefined ? undefined : flag(attrValue(pos, "treatAsChar")),
        pageBreak: attrValue(el, "pageBreak"),
        repeatHeader: flag(attrValue(el, "repeatHeader")),
        mergedCells: grid.cells.filter((c) => c.rowSpan > 1 || c.colSpan > 1).length,
        structureRegular: grid.problems.length === 0,
        widthRegular: grid.widths !== undefined,
        regular: grid.problems.length === 0 && grid.widths !== undefined,
      };
      if (isTop) info.topOrdinal = top++;
      out.push(info);
    }
  }
  return out;
}
