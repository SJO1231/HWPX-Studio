import { decodeEntities } from "../xml/chars.ts";
import {
  attrValue,
  childEl,
  childEls,
  elementChildren,
  elIs,
  isElement,
  nsRole,
  type XElement,
  type XText,
} from "../xml/tree.ts";
import type {
  Bookmark,
  FieldMark,
  ObjectNode,
  ParagraphNode,
  Piece,
  PieceKind,
  RunNode,
  SubListNode,
  TableCell,
  TableNode,
} from "./types.ts";

const OBJECT_CHAR = "￼";

const INLINE_CHARS = new Map([
  ["tab", "\t"],
  ["lineBreak", "\n"],
  ["nbSpace", " "],
  ["fwSpace", " "],
  ["hyphen", "­"],
]);

function intAttr(el: XElement | undefined, name: string, fallback: number): number {
  if (el === undefined) return fallback;
  const v = attrValue(el, name);
  if (v === undefined || !/^-?\d+$/.test(v)) return fallback;
  return Number(v);
}

/** 문단 요소 안에서 하위 목록(subList) 요소를 문서 순서로 찾는다. subList 안쪽은 들어가지 않는다. */
function findSubListElements(paragraph: XElement): XElement[] {
  const found: XElement[] = [];
  const stack: XElement[] = elementChildren(paragraph).reverse();
  while (stack.length > 0) {
    const el = stack.pop();
    if (el === undefined) break;
    if (elIs(el, "paragraph", "subList")) {
      found.push(el);
      continue;
    }
    const kids = elementChildren(el);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k !== undefined) stack.push(k);
    }
  }
  return found;
}

function buildSubList(element: XElement, path: number[], ordinal: number): SubListNode {
  const paragraphs = childEls(element, "paragraph", "p").map((p, i) => parseParagraph(p, [...path, ordinal, i]));
  return { element, owner: element.parent?.local ?? "", paragraphs };
}

function buildTable(element: XElement, base: ObjectNode, subListOf: Map<XElement, SubListNode>): TableNode {
  const cells: TableCell[] = [];
  childEls(element, "paragraph", "tr").forEach((tr, rowIndex) => {
    childEls(tr, "paragraph", "tc").forEach((tc, colIndex) => {
      const addr = childEl(tc, "paragraph", "cellAddr");
      const span = childEl(tc, "paragraph", "cellSpan");
      const subList = childEl(tc, "paragraph", "subList");
      cells.push({
        row: intAttr(addr, "rowAddr", rowIndex),
        col: intAttr(addr, "colAddr", colIndex),
        rowSpan: intAttr(span, "rowSpan", 1),
        colSpan: intAttr(span, "colSpan", 1),
        borderFillIDRef: attrValue(tc, "borderFillIDRef") ?? null,
        subList: subList === undefined ? null : (subListOf.get(subList) ?? null),
      });
    });
  });
  return { ...base, rowCnt: intAttr(element, "rowCnt", 0), colCnt: intAttr(element, "colCnt", 0), cells };
}

export function isTableNode(o: ObjectNode): o is TableNode {
  return "cells" in o;
}

export function parseParagraph(element: XElement, path: number[]): ParagraphNode {
  const attrs: ParagraphNode["attrs"] = {
    paraPrIDRef: attrValue(element, "paraPrIDRef") ?? null,
    styleIDRef: attrValue(element, "styleIDRef") ?? null,
  };
  const id = attrValue(element, "id");
  if (id !== undefined) attrs.id = id;

  const runs: RunNode[] = [];
  const pieces: Piece[] = [];
  const objects: ObjectNode[] = [];
  const fieldMarks: FieldMark[] = [];
  const bookmarks: Bookmark[] = [];
  let logical = "";

  const subListEls = findSubListElements(element);
  const subLists = subListEls.map((el, i) => buildSubList(el, path, i));
  const subListOf = new Map<XElement, SubListNode>(subLists.map((s) => [s.element, s]));

  const addPiece = (kind: PieceKind, start: number, end: number, contribution: string, runOrdinal: number): void => {
    pieces.push({ kind, start, end, logicalStart: logical.length, logicalEnd: logical.length + contribution.length, runOrdinal });
    logical += contribution;
  };

  const addText = (t: XText, runOrdinal: number): void => {
    if (t.raw.startsWith("<![CDATA[")) {
      if (t.value.length > 0) addPiece("text", t.start + 9, t.end - 3, t.value, runOrdinal);
      return;
    }
    const raw = t.raw;
    let i = 0;
    while (i < raw.length) {
      const amp = raw.indexOf("&", i);
      if (amp < 0) {
        addPiece("text", t.start + i, t.end, raw.slice(i), runOrdinal);
        break;
      }
      if (amp > i) addPiece("text", t.start + i, t.start + amp, raw.slice(i, amp), runOrdinal);
      const semi = raw.indexOf(";", amp);
      addPiece("entity", t.start + amp, t.start + semi + 1, decodeEntities(raw.slice(amp, semi + 1)), runOrdinal);
      i = semi + 1;
    }
  };

  const addObject = (el: XElement, runOrdinal: number): void => {
    const pieceIndex = pieces.length;
    addPiece("object", el.start, el.end, OBJECT_CHAR, runOrdinal);
    const base: ObjectNode = {
      element: el,
      type: el.local,
      pieceIndex,
      subLists: subLists.filter((s) => s.element.start >= el.start && s.element.end <= el.end),
    };
    const objId = attrValue(el, "id");
    if (objId !== undefined) base.id = objId;
    const instId = attrValue(el, "instId") ?? attrValue(el, "instid");
    if (instId !== undefined) base.instId = instId;
    objects.push(elIs(el, "paragraph", "tbl") ? buildTable(el, base, subListOf) : base);

    if (elIs(el, "paragraph", "ctrl")) {
      for (const c of elementChildren(el)) {
        if (elIs(c, "paragraph", "fieldBegin")) {
          const mark: FieldMark = { kind: "begin", id: attrValue(c, "id") ?? "", element: c, pieceIndex };
          const name = attrValue(c, "name");
          const type = attrValue(c, "type");
          const dirty = attrValue(c, "dirty");
          if (name !== undefined) mark.name = name;
          if (type !== undefined) mark.type = type;
          if (dirty !== undefined) mark.dirty = dirty;
          fieldMarks.push(mark);
        } else if (elIs(c, "paragraph", "fieldEnd")) {
          const mark: FieldMark = { kind: "end", id: attrValue(c, "fieldid") ?? "", element: c, pieceIndex };
          const beginIDRef = attrValue(c, "beginIDRef");
          if (beginIDRef !== undefined) mark.beginIDRef = beginIDRef;
          fieldMarks.push(mark);
        } else if (elIs(c, "paragraph", "bookmark")) {
          bookmarks.push({ name: attrValue(c, "name") ?? "", element: c });
        }
      }
    }
  };

  let ordinal = 0;
  for (const child of element.children) {
    if (!isElement(child)) continue;
    if (!elIs(child, "paragraph", "run")) continue;
    runs.push({ element: child, charPrIDRef: attrValue(child, "charPrIDRef") ?? null, ordinal });
    for (const part of child.children) {
      if (!isElement(part)) continue;
      if (elIs(part, "paragraph", "t")) {
        for (const inner of part.children) {
          if (isElement(inner)) {
            const ch = nsRole(inner.ns) === "paragraph" ? (INLINE_CHARS.get(inner.local) ?? "") : "";
            addPiece("inline", inner.start, inner.end, ch, ordinal);
          } else {
            addText(inner, ordinal);
          }
        }
      } else {
        addObject(part, ordinal);
      }
    }
    ordinal++;
  }

  const result: ParagraphNode = {
    element,
    path,
    attrs,
    runs,
    pieces,
    logicalText: logical,
    subLists,
    objects,
    fieldMarks,
    bookmarks,
  };
  const lineSeg = childEl(element, "paragraph", "linesegarray");
  if (lineSeg !== undefined) result.lineSegArray = lineSeg;
  return result;
}

/** 문단과 그 하위 목록 안 문단을 문서 순서(선행 순회)로 방문한다. */
export function* walkParagraphs(paragraphs: ParagraphNode[]): Generator<ParagraphNode> {
  const stack: ParagraphNode[] = [...paragraphs].reverse();
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined) break;
    yield p;
    for (let i = p.subLists.length - 1; i >= 0; i--) {
      const sl = p.subLists[i];
      if (sl === undefined) continue;
      for (let j = sl.paragraphs.length - 1; j >= 0; j--) {
        const q = sl.paragraphs[j];
        if (q !== undefined) stack.push(q);
      }
    }
  }
}
