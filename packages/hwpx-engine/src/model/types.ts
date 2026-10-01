import type { Issue } from "../errors.ts";
import type { HwpxPackage } from "../package/open.ts";
import type { XAttr } from "../xml/tokenizer.ts";
import type { XElement } from "../xml/tree.ts";

// ── 자원(header.xml) ─────────────────────────────────────────────

/**
 * 자원 종류. `font`, `borderFill`, `charPr`, `tabPr`, `numbering`, `bullet`, `paraPr`, `style`,
 * refList 안의 그 밖 목록은 `other:<목록 요소의 local 이름>`.
 */
export type ResourceKind = string;

export const FONT_LANGS = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"] as const;

export type ResourceRef = {
  kind: ResourceKind;
  lang?: string;
  id: string;
  /** 이 참조를 담은 요소와 속성(원문 위치 포함) */
  element: XElement;
  attr: XAttr;
};

export type ResourceItem = {
  kind: ResourceKind;
  lang?: string;
  id: string;
  element: XElement;
  refs: ResourceRef[];
};

export type CountSlot = {
  /** 목록 요소의 local 이름 (fontfaces, charProperties 등) */
  list: string;
  kind: ResourceKind;
  lang?: string;
  element: XElement;
  /** 개수를 담은 속성(itemCnt 또는 fontCnt) */
  attr: XAttr;
  /** 속성이 선언한 값 */
  value: number;
  /** 목록 요소의 실제 자식 요소 수 */
  actual: number;
};

export type HeaderModel = {
  text: string;
  root: XElement;
  resources: Record<ResourceKind, ResourceItem[]>;
  counts: CountSlot[];
  secCnt: { element: XElement; attr: XAttr; value: number } | null;
};

// ── 본문 ────────────────────────────────────────────────────────

export type BodyRefKind = "charPr" | "paraPr" | "style" | "borderFill" | "binaryItem" | "numbering" | "memoShape" | "unknown";

export type BodyRef = {
  kind: BodyRefKind;
  id: string;
  element: XElement;
  attr: XAttr;
};

export type PieceKind = "text" | "entity" | "inline" | "object";

export type Piece = {
  kind: PieceKind;
  /** 원문 구간(구역 텍스트의 UTF-16 오프셋) */
  start: number;
  end: number;
  logicalStart: number;
  logicalEnd: number;
  runOrdinal: number;
};

export type RunNode = { element: XElement; charPrIDRef: string | null; ordinal: number };

export type SubListNode = { element: XElement; owner: string; paragraphs: ParagraphNode[] };

export type TableCell = {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  borderFillIDRef: string | null;
  subList: SubListNode | null;
};

export type ObjectNode = {
  element: XElement;
  type: string;
  id?: string;
  instId?: string;
  /** 이 객체를 나타내는 `object` Piece의 위치 */
  pieceIndex: number;
  subLists: SubListNode[];
};

export type TableNode = ObjectNode & { rowCnt: number; colCnt: number; cells: TableCell[] };

export type FieldMark = {
  kind: "begin" | "end";
  /** begin은 `id` 속성, end는 `fieldid` 속성 값. 없으면 빈 문자열 */
  id: string;
  name?: string;
  type?: string;
  dirty?: string;
  beginIDRef?: string;
  element: XElement;
  /** 이 표식을 담은 ctrl의 `object` Piece 위치 */
  pieceIndex: number;
};

export type Bookmark = { name: string; element: XElement };

export type ParagraphNode = {
  element: XElement;
  path: number[];
  attrs: { paraPrIDRef: string | null; styleIDRef: string | null; id?: string };
  runs: RunNode[];
  lineSegArray?: XElement;
  pieces: Piece[];
  logicalText: string;
  subLists: SubListNode[];
  objects: ObjectNode[];
  fieldMarks: FieldMark[];
  bookmarks: Bookmark[];
};

export type SectionModel = {
  entryName: string;
  index: number;
  text: string;
  root: XElement;
  paragraphs: ParagraphNode[];
  bodyRefs: BodyRef[];
};

export type HwpxDocument = {
  pkg: HwpxPackage;
  header: HeaderModel;
  sections: SectionModel[];
  issues: Issue[];
};

// ── 누름틀 ──────────────────────────────────────────────────────

export type FieldShape = "simple" | "empty" | "inline" | "crossParagraph" | "unpaired";

export type FieldInfo = {
  name: string;
  type: string;
  occurrence: number;
  sectionIndex: number;
  path: number[];
  valueText: string;
  dirty: string;
  shape: FieldShape;
};
