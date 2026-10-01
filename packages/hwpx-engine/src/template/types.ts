import type { Issue } from "../errors.ts";

// 이 폴더는 문서 형식을 모른다(8.5). HWPX 모델을 import하지 않는다.

export const TEMPLATE_SCHEMA = "hwpx-studio/template@1";
export const DATASET_SCHEMA = "hwpx-studio/dataset@1";

export type MissingPolicy = "error" | "empty" | "keep";
export type MixedFormatPolicy = "skip" | "first";

// ── 앵커 ────────────────────────────────────────────────────────

/** 문서 안 문단의 주소. `path`의 의미는 형식이 정한다(HWPX는 `[문단, 하위목록, 문단, ...]`). */
export type AnchorAt = { sectionIndex: number; path: number[] };

/** `word` 앵커의 지문: 대상 글과 앞뒤 24자까지의 글 */
export type WordPrint = { text: string; before: string; after: string };
/** `line` 앵커의 지문: 문단 글 앞 40자와 문단 글 전체의 sha256 */
export type LinePrint = { text: string; sha256: string };

export type FieldAnchor = { id: string; kind: "field"; name: string; occurrence?: number };
export type WordAnchor = { id: string; kind: "word"; at: AnchorAt; start: number; end: number; print: WordPrint };
export type LineAnchor = { id: string; kind: "line"; at: AnchorAt; print: LinePrint };
export type CellAnchor = {
  id: string;
  kind: "cell";
  table: { sectionIndex: number; ordinal: number };
  row: number;
  col: number;
};
export type ObjectAnchor = { id: string; kind: "object"; objectType: string; sectionIndex: number; ordinal: number };
export type Anchor = FieldAnchor | WordAnchor | LineAnchor | CellAnchor | ObjectAnchor;
export type AnchorKind = Anchor["kind"];

// ── 조건 ────────────────────────────────────────────────────────

export const CONDITION_OPS = [
  "exists",
  "empty",
  "eq",
  "ne",
  "gt",
  "ge",
  "lt",
  "le",
  "contains",
  "in",
  "matches",
  "lengthEq",
  "lengthGt",
  "lengthLt",
] as const;
export type Op = (typeof CONDITION_OPS)[number];

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { path: string; op: Op; value?: unknown };

// ── 규칙·액션 ───────────────────────────────────────────────────

export type ValueSource = { path: string } | { text: string };
export type Position = "before" | "after" | "replace";
export type InsertStyle = "inherit" | { paraPrIDRef: string; charPrIDRef: string; styleIDRef: string };

export type FillAction = { type: "fill"; anchor: string; value: ValueSource };
export type DeleteAction = { type: "delete"; anchor: string; scope?: "row" };
export type InjectAction = {
  type: "inject";
  anchor: string;
  position: Position;
  /** 조각 JSON의 경로(문자열) 또는 내장 조각 객체 */
  fragment: string | Record<string, unknown>;
};
export type InsertTextAction = {
  type: "insertText";
  anchor: string;
  position: Position;
  value: ValueSource;
  style: InsertStyle;
};
export type Action = FillAction | DeleteAction | InjectAction | InsertTextAction;
export type ActionType = Action["type"];

export type Rule = { id: string; when?: Condition; do: Action };

export type Template = {
  schema: typeof TEMPLATE_SCHEMA;
  source?: { sha256: string };
  anchors: Anchor[];
  rules: Rule[];
  options: { missing?: MissingPolicy; mixedFormat?: MixedFormatPolicy };
};

// ── 데이터 묶음 ─────────────────────────────────────────────────

export type Dataset = {
  data: Record<string, unknown>;
  derived: Record<string, unknown>;
};

// ── 보고서 자료 구조 ────────────────────────────────────────────

/** 값 원문 대신 남기는 길이와 sha256 앞 8자 */
export type ValueDigest = { length: number; sha256: string };

export type ReportAction = {
  ruleId: string;
  type: ActionType;
  /** 앵커 id. 문서 안 `{{경로}}` 자리는 `{{경로}}` 표기 */
  anchor: string;
  /** 바뀐 자리 수(누름틀·글 범위·문단·행·삽입 문단 등) */
  targets: number;
  position?: Position;
  /** 채움·삽입의 값 지문(여러 자리면 자리마다 같은 값) */
  value?: ValueDigest;
};

export type ReportSkip = { ruleId: string; anchor: string; code: string; message: string; where?: string };
export type ReportDrop = { ruleId: string; anchor: string; reason: string };
export type ReportKept = { path: string; count: number };

export type FillReport = {
  actions: ReportAction[];
  skipped: ReportSkip[];
  dropped: ReportDrop[];
  /** 지문으로 다시 찾은 앵커(ANCHOR_RELOCATED) */
  relocated: { anchor: string; message: string }[];
  /** `missing: keep`으로 자리를 그대로 둔 경로와 자리 수 */
  kept: ReportKept[];
  /** 값을 읽는 데이터 경로(중복 없이 정렬) */
  requiredPaths: string[];
  /** 데이터에 없던 경로 */
  missingPaths: string[];
  /** 조건이 거짓이라 건너뛴 규칙 id */
  inactiveRules: string[];
  /** 예상 수량 증감(문단·표 등의 이름 → 증감) */
  expected: Record<string, number>;
  issues: Issue[];
};

export function emptyFillReport(): FillReport {
  return {
    actions: [],
    skipped: [],
    dropped: [],
    relocated: [],
    kept: [],
    requiredPaths: [],
    missingPaths: [],
    inactiveRules: [],
    expected: {},
    issues: [],
  };
}
