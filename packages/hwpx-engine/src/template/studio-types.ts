import type {
  CellAnchor,
  Condition,
  FieldAnchor,
  LineAnchor,
  MissingPolicy,
  ObjectAnchor,
  Rule,
  WordAnchor,
} from "./types.ts";
import { HEADING_FORMS, type CellPrint, type HeadingRangeAnchor, type ObjectPrint, type ParagraphPrint, type RangeAnchor } from "../fill/anchor-types.ts";
// 같은 선언을 다시 내보낸다(`fill/index.ts`와 같은 선언이라 겹치지 않는다).
export type { CellPrint, HeadingRangeAnchor, ObjectPrint, RangeAnchor, RangePrint } from "../fill/anchor-types.ts";

// 2판 템플릿 계약(엔진 명세 8.8). 이 폴더는 문서 형식을 모른다(8.5).

export const STUDIO_TEMPLATE_SCHEMA = "hwpx-studio/template@2";
export const CASE_SCHEMA = "hwpx-studio/case@1";
export const BLOCK_PROTO_SCHEMA = "hwpx-studio/block-proto@1";

// ── 앵커 ────────────────────────────────────────────────────────

// range·cell·object 지문과 range 앵커의 형은 `fill/anchor-types.ts`가 정본이다(7.10. 문서 모델을 가져오지 않는 순수 형이라 8.5를 지킨다).
/** `range` 앵커의 첫·끝 문단 지문: 글 앞 40자와 문단 글 해시(= `ParagraphPrint`) */
export type RangeEndPrint = ParagraphPrint;

/** 메일머지(MAILMERGE) 필드를 FieldValue 인자로 가리킨다(7.10). occurrence는 같은 키 안의 순번 */
export type MergeFieldAnchor = { id: string; kind: "mergeField"; key: string; occurrence?: number; pattern?: string };

/** 1판 앵커 5종(필드·낱말·줄·셀·개체)에 range·headingRange·mergeField를 더하고, 모든 앵커에 선택 pattern(패턴 id)을 둔다. */
export type StudioAnchor =
  | (FieldAnchor & { pattern?: string })
  | (WordAnchor & { pattern?: string })
  | (LineAnchor & { pattern?: string })
  | (CellAnchor & { pattern?: string; print?: CellPrint })
  | (ObjectAnchor & { pattern?: string; print?: ObjectPrint })
  | (RangeAnchor & { pattern?: string })
  | (HeadingRangeAnchor & { pattern?: string })
  | MergeFieldAnchor;

// ── 패턴(형만. 판정은 #20) ──────────────────────────────────────

/** 패턴의 번호 글자 꼴: 제목 범위의 꼴(`HEADING_FORMS`, 7.10)과 같은 11종 */
export const PATTERN_FORMS = HEADING_FORMS;
export const PATTERN_PLACES = ["body", "cell", "labelCell", "labelColon"] as const;
export const PATTERN_MATCH = ["marker", "bold", "height", "print", "paraPrint", "align"] as const;

export type TemplatePattern = {
  id: string;
  name: string;
  marker: { form: (typeof PATTERN_FORMS)[number]; level: number };
  char?: { bold?: boolean; height?: number; print?: string };
  para?: { print?: string; align?: string };
  place: (typeof PATTERN_PLACES)[number];
  match: (typeof PATTERN_MATCH)[number][];
  rejected?: RangeEndPrint[];
};

// ── 값·연결·자리 ────────────────────────────────────────────────

export type ValueFormat = "text" | "money";
export type ValueDef = { id: string; name: string; format: ValueFormat };

/** key(데이터 행의 최상위 열 이름 그대로) 또는 path(중첩 경로) 하나로 값을 데이터에 잇는다. aliases는 key와 같은 순위의 다른 열 이름이다. */
export type ValueBinding = { value: string; key: string; aliases?: string[] } | { value: string; path: string };

type PlaceBase = { id: string; value: string };
export type ValuePlace =
  | (PlaceBase & { kind: "clickHere"; name: string; occurrence?: number; where?: string })
  | (PlaceBase & { kind: "mailMerge"; key: string; occurrence?: number; where?: string })
  | (PlaceBase & { kind: "placeholder"; key: string; where?: string })
  | (PlaceBase & { kind: "word" | "line" | "cell"; anchor: string });

// ── 슬롯·블록 ───────────────────────────────────────────────────

export type TemplateSlot = { id: string; name: string; anchors: string[]; parent: string | null };

/** fragment는 조각 hwpx-studio/fragment@1 JSON 바이트의 sha256, text는 글(여러 줄이면 줄마다 문단) */
export type BlockContent = { fragment: string } | { text: string };
export type ProtoRef = { id: string; version: number };

export type TemplateBlock = {
  id: string;
  slot: string;
  name: string;
  content: BlockContent;
  /** 원형 판을 고정한다. forkedFrom과 함께 쓸 수 없다. */
  proto?: ProtoRef;
  forkedFrom?: ProtoRef;
  when?: Condition;
  priority?: number;
};

export type StudioOptions = {
  missing?: MissingPolicy;
  mixedFormat?: "first";
  unregistered?: "error" | "keep";
  requireConfirm?: boolean;
  unwrapFilled?: boolean;
  refreshPreview?: boolean;
};

export type TemplateOrigin = { kind: "lite"; revision: number | string };

/** 2판 템플릿(hwpx-studio/template@2). 1판은 readStudioTemplate가 1판 Template 그대로 돌려준다(승계). */
export type StudioTemplate = {
  schema: typeof STUDIO_TEMPLATE_SCHEMA;
  id: string;
  version: number;
  meta?: { name?: string };
  source: { kind: "hwpx" | "md"; sha256: string };
  anchors: StudioAnchor[];
  patterns?: TemplatePattern[];
  values: ValueDef[];
  bindings: ValueBinding[];
  places: ValuePlace[];
  slots: TemplateSlot[];
  blocks: TemplateBlock[];
  /** 1판 규칙. 승계 전용이라 slots·places와 함께 쓸 수 없다(TPL_MIXED_RULES). */
  rules?: Rule[];
  options?: StudioOptions;
  origin?: TemplateOrigin;
};

// ── 원형 ────────────────────────────────────────────────────────

export type BlockProto = {
  schema: typeof BLOCK_PROTO_SCHEMA;
  id: string;
  version: number;
  name: string;
  content: BlockContent;
  /** 내용에 쓰인 자리 키 목록(만드는 쪽이 계산해 넣는다. 읽기는 형식만 본다) */
  keys: string[];
  previous?: { version: number; content: string };
  note?: string;
};

// ── 이번 건 ─────────────────────────────────────────────────────

export type CaseSelection = { block: string; basis: "manual" | "confirmed"; content: string };

export type StudioCase = {
  schema: typeof CASE_SCHEMA;
  template: { id: string; version: number; sha256: string };
  record: { dataset: string; version: number; row: number; sha256: string };
  selections: Record<string, CaseSelection>;
  valueEdits: Record<string, string>;
  blockEdits: Record<string, BlockContent>;
};

// ── 읽기 옵션 ───────────────────────────────────────────────────

export type StudioReadOptions = {
  /** 원형 판의 내용을 준다(없으면 undefined). 주면 원형 핀 검사를 한다(TPL_PROTO_MISMATCH). */
  lookupProto?: (id: string, version: number) => BlockContent | undefined;
  /** 조각 덩어리의 존재를 알려 준다. 주면 TPL_FRAGMENT_MISSING 검사를 한다. */
  hasBlob?: (sha256: string) => boolean;
};

// ── 값 표 ───────────────────────────────────────────────────────

/**
 * bound: 데이터 행에서 찾았다. edited: 이번 건의 valueEdits가 덮었다. missing: 데이터에 없다(연결이 없는 값 포함).
 * empty: 데이터에 있으나 빈 글이다(빈 글도 값이다). rejected: 값을 쓸 수 없다(issue가 사유: 별칭 충돌·형식·제어 문자).
 */
export type ValueState = "bound" | "edited" | "missing" | "empty" | "rejected";
export type BoundSource = "key" | "alias" | "path" | "edit" | "none";

export type BoundValue = {
  id: string;
  name: string;
  format: ValueFormat;
  state: ValueState;
  /**
   * 자리에 채울 글(형식 적용 뒤. money는 1,234원 꼴). 값이 missing이고 누락 정책이 empty이면 빈 글이다.
   * 소비자는 text가 있으면 채우고, issue가 있으면 막고, 둘 다 없으면(missing + keep) 자리를 그대로 둔다.
   */
  text?: string;
  /** money의 정수 값(조건에서 숫자로 쓴다) */
  number?: number;
  source: BoundSource;
  /** 이 값으로 자리를 채우면 막히는 사유: rejected의 DATA_*·VALUE_CONTROL_CHAR, 누락 정책이 error인 missing의 DATA_MISSING. 값 원문은 담지 않는다. */
  issue?: { code: string; message: string };
};

// ── 선택 평가 ───────────────────────────────────────────────────

export type SelectionState = "manual" | "confirmed" | "default" | "fallback" | "undecided" | "recheck" | "inactive";
export type SelectionReason =
  | "tie"
  | "noCandidate"
  | "valueMissing"
  | "valueRejected"
  | "needConfirm"
  | "blockMissing"
  | "contentChanged"
  | "parentChanged";

export type SlotSelection = {
  slot: string;
  state: SelectionState;
  /** 고른 블록. recheck는 저장해 둔 블록 id(없어졌을 수 있다) */
  block?: string;
  reason?: SelectionReason;
  /** 저장된 선택(manual·confirmed)이 조건이 고르는 블록과 다르다. 표시만 하고 바꾸지 않는다. 조건이 고르는 블록은 candidates에 있다. */
  differs?: boolean;
  /** 동률이면 동률인 블록, differs이면 조건이 고르는 블록, valueMissing·valueRejected이면 그 값을 조건에 쓴 블록 */
  candidates?: string[];
  /** 생성을 막는 사유 코드. 없으면 쓸 수 있다. */
  blocked?: "SEL_UNDECIDED" | "SEL_RECHECK";
  /** 사용자에게 보일 이유 문구. 값 원문은 담지 않는다. */
  message: string;
};

// ── 원형 영향·전파 ──────────────────────────────────────────────

export type ProtoUsageState = "behind" | "current" | "forked";
export type ProtoUsage = {
  template: string;
  version: number;
  blocks: string[];
  /** 고정한 원형 판(behind·current) */
  pinned?: number;
  /** 갈라진 원형 판(forked) */
  forkedFrom?: number;
  state: ProtoUsageState;
};
export type ProtoUsageList = { proto: string; latest: number; usages: ProtoUsage[] };

export type ProtoUpdatePlan = {
  /** 새 템플릿 판(version + 1, 핀과 내용 갱신). 갱신할 블록이 없으면 입력의 복사본(판 번호 그대로)이다. */
  template: StudioTemplate;
  updated: { block: string; from: number; to: number }[];
};
