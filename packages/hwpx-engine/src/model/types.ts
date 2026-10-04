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
  /** 메일 머지 필드(`type="MAILMERGE"`)의 키: `hp:parameters` 안 `stringParam name="FieldValue"`의 값. 없거나 비면 없다. */
  mergeKey?: string;
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

/**
 * 누름틀의 모양(시작·끝 표식의 위치와 그 사이에 든 것).
 * - `simple`: 한 문단 안, 사이에 글이 있다. `empty`: 한 문단 안, 사이에 아무것도 없다.
 * - `inline`: 한 문단 안, 사이에 탭·줄바꿈 같은 인라인 조각이 있다(객체는 없다).
 * - `object`: 한 문단 안, 사이에 그림·표·중첩 컨트롤 같은 객체가 하나라도 있다.
 * - `crossParagraph`: 끝 표식이 다른 문단에 있고, 두 문단이 같은 컨테이너(같은 구역 최상위, 같은 칸, 같은 머리말 등)의 형제다.
 * - `crossContainer`: 끝 표식이 다른 컨테이너(예: 시작은 표 칸 안, 끝은 표 밖)나 다른 구역에 있다.
 * - `unpaired`: 끝 표식이 없다.
 */
export type FieldShape = "simple" | "empty" | "inline" | "object" | "crossParagraph" | "crossContainer" | "unpaired";

export type FieldInfo = {
  name: string;
  type: string;
  /** 메일 머지 필드(`type="MAILMERGE"`)의 키(`FieldValue` 인자). 메일 머지 필드는 `name`이 비어 있어 이 키로 가리킨다. 없거나 비면 없다. */
  mergeKey?: string;
  /** 같은 이름 안의 순번. 키가 있는 메일 머지 필드는 같은 키 안의 순번이다. */
  occurrence: number;
  sectionIndex: number;
  path: number[];
  valueText: string;
  dirty: string;
  shape: FieldShape;
  /** 끝 표식을 담은 문단의 경로. 끝 표식이 시작과 다른 문단에 있을 때(`crossParagraph`·`crossContainer`)만 있다(다른 구역에 있으면 그 구역 안의 경로다). */
  endPath?: number[];
};
