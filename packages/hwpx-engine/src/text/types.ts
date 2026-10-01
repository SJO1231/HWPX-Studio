import type { Issue } from "../errors.ts";
import type { FillReport, MissingPolicy } from "../template/index.ts";

// md·txt 어댑터(명세 9절). 이 폴더는 `src/template/`과 `src/errors.ts`만 쓴다. HWPX 모델·패키지·채움 코드를 import하지 않는다.

export const TEXT_FRAGMENT_SCHEMA = "hwpx-studio/text-fragment@1";

export type TextKind = "md" | "txt";

/** `blank`는 txt의 빈 줄(공백뿐인 줄)이다. md에서는 빈 줄이 블록 사이의 구분이라 블록이 아니다. */
export type TextBlockKind = "paragraph" | "heading" | "code" | "table" | "blank";

/** 원문의 한 줄. `end`는 줄바꿈 앞이고 `eol`은 그 줄의 줄바꿈(`""`·`"\n"`·`"\r\n"`)이다. */
export type TextLine = { start: number; end: number; eol: string };

/** 파이프 표의 칸. `[start, end)`는 구분 파이프 사이의 조각, `[contentStart, contentEnd)`는 앞뒤 공백을 뺀 글이다. */
export type TextTableCell = { start: number; end: number; contentStart: number; contentEnd: number };
export type TextTableRow = { line: number; cells: TextTableCell[] };
/** `rows[0]`은 머리행, 그 뒤는 데이터 행이다(구분행 `|---|`은 담지 않는다). */
export type TextTableInfo = { rows: TextTableRow[] };

export type TextBlock = {
  /** 문서 안 블록 서수(0부터). `line`·`word` 앵커의 `at.path[0]` */
  index: number;
  kind: TextBlockKind;
  /** 원문 구간 `[start, end)`. `end`는 마지막 줄의 줄바꿈 앞이다. 블록 사이의 줄바꿈·빈 줄은 구간에 들지 않는다. */
  start: number;
  end: number;
  /** `TextDoc.lines`에서 이 블록의 첫 줄·마지막 줄(둘 다 포함) */
  firstLine: number;
  lastLine: number;
  /** 논리 글: 줄들을 `\n`으로 이은 것(줄바꿈 방식과 무관). 지문과 `word` 구간이 이것을 기준으로 한다. */
  text: string;
  table?: TextTableInfo;
};

export type TextDoc = {
  kind: TextKind;
  /** 입력 원문(BOM 포함) */
  source: string;
  /** 맨 앞 BOM 길이(0 또는 1). 블록과 줄은 BOM 뒤에서 시작한다. */
  bomLength: number;
  lines: TextLine[];
  blocks: TextBlock[];
  /** 읽으면서 알게 된 경고 */
  issues: Issue[];
};

/** 텍스트 조각: 블록 원문 목록. md는 블록마다 한 덩어리(코드 블록·표는 통째로)여야 한다. */
export type TextFragment = { schema: typeof TEXT_FRAGMENT_SCHEMA; blocks: string[] };

export type TextOptions = {
  /** 누락 정책. 템플릿의 `options.missing`보다 앞선다. 기본 `error`. */
  missing?: MissingPolicy;
  /** 코드 블록 안의 `{{}}`도 채운다. 기본 `false`. */
  fillInCode?: boolean;
  /** 규칙의 `fragment` 경로 → 조각(객체 또는 JSON 글). 엔진은 파일을 읽지 않으므로 읽는 쪽이 채워 넘긴다. */
  fragments?: Record<string, TextFragment | string>;
  /** 계획까지만 만들어 보고서를 돌려준다(출력 없음). */
  dryRun?: boolean;
  /** 시험 전용 훅: 적용 직후 출력을 바꿔 검사가 결함을 잡는지 본다. */
  testHooks?: { afterApply?: (output: string) => string };
};

/** 원문 구간 치환. 삽입은 `start === end`다. */
export type TextEdit = { start: number; end: number; replacement: string; label: string };

/** 보고서에 싣는 편집: 원문 좌표와 바뀐 뒤 길이만 있고 글은 없다. */
export type TextEditSummary = { start: number; end: number; newLength: number; label: string };

/** 수량: 블록·표·코드 블록·표 행(머리행 포함). 편집이 만드는 증감과 검사에 쓴다. */
export type TextCensus = { blocks: number; tables: number; code: number; tableRows: number };

/** 행 반복이 만든 행의 기대: 첫 행이 놓일 원문 줄의 시작 오프셋과, 행마다 칸 글(앞뒤 공백을 뺀 것) */
export type TextRepeat = { start: number; rows: string[][] };

export type TextPlan = {
  /** 원문 좌표 편집. 시작 → 끝 → 규칙 순서로 정렬되어 있고 서로 겹치지 않는다. */
  edits: TextEdit[];
  /** 편집이 만드는 수량 증감 */
  delta: TextCensus;
  /** 채우지 않기로 한 `{{}}`(`missing: keep`, 조건이 거짓인 규칙의 `field` 앵커)의 원문 시작 오프셋 */
  leaves: number[];
  /** 행 반복이 만든 행들. 검사가 출력에서 다시 읽어 칸 글을 견준다. 행 반복이 없으면 없다. */
  repeats?: TextRepeat[];
};

export type TextReport = {
  kind: TextKind;
  dryRun: boolean;
  /** 형식 중립 채움 보고서(값 원문 없음) */
  plan: FillReport;
  /** 적용한 편집의 원문 좌표와 길이(값 원문 없음). 계획 단계에서 막혔으면 비어 있다. */
  edits: TextEditSummary[];
  /** 출력에서 다시 읽어 확인한 `{{}}` 수와 표 수 */
  reread: { placeholders: number; tables: number };
  /** 오류와 경고 전부(읽기·계획·검사) */
  issues: Issue[];
};

export type TextResult =
  | { ok: true; dryRun: false; output: string; report: TextReport }
  | { ok: true; dryRun: true; report: TextReport }
  | { ok: false; report: TextReport };
