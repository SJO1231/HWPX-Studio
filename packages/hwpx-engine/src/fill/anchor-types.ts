// 범위·셀·객체·제목 범위 앵커의 형과 제목 꼴 목록(7.10). 문서 모델을 가져오지 않아 `template/types.ts`·`template/read.ts`가 참조한다.

/** 지문에 쓰는 문단 하나의 글: 글 앞 40자와 문단 글 해시(`line` 앵커의 지문과 같은 방식) */
export type ParagraphPrint = { text: string; sha256: string };

/** `range` 앵커의 지문: 첫·끝 문단, 문단 수, 범위 전체 글(문단 논리 텍스트를 줄바꿈 하나로 이은 것)의 sha256 */
export type RangePrint = { first: ParagraphPrint; last: ParagraphPrint; count: number; sha256: string };

/**
 * 같은 부모 안의 연속 문단(표 칸 안 포함)을 가리키는 앵커. `parentPath`는 `[문단, 하위목록, ...]` 짝의 하위 목록 주소이고
 * 빈 배열이면 구역 최상위 문단이다. `from`~`to`는 0부터 세는 포함 범위다.
 */
export type RangeAnchor = {
  id: string;
  kind: "range";
  at: { sectionIndex: number; parentPath: number[] };
  from: number;
  to: number;
  print: RangePrint;
};

/**
 * 제목의 번호 글자 꼴(7.10 `headingRange`). 순서가 기본 서열(앞이 높은 단계)이다: 조문(제N장·절·조·항·호), 로마 숫자(Ⅰ~Ⅻ), 숫자+점,
 * 한글+점, `1)`, `가)`, `(1)`, `(가)`, 원문자, 기호(같은 부모 안에서 기호마다 처음 나온 순서로 한 단계씩 아래), 번호 글자 없음(굵고 짧은 글).
 */
export const HEADING_FORMS = ["article", "roman", "digitDot", "hangulDot", "digitParen", "hangulParen", "digitParens", "hangulParens", "circled", "box", "none"] as const;
export type HeadingForm = (typeof HEADING_FORMS)[number];

/** 번호 글자 꼴과 단계(1부터. 같은 부모 안에서 실제로 나타난 꼴만 빈 단계 없이 센다) */
export type HeadingMarker = { form: HeadingForm; level: number };

/**
 * 제목 범위 앵커(7.10): 제목 문단 `index`부터 같은 부모에서 단계가 같거나 높은 다음 제목 앞까지(없으면 부모 끝까지).
 * `heading`은 제목 문단의 글 앞 40자와 글 해시, `print`는 해석된 범위의 지문(`range`와 같다).
 * `order`는 기본 서열과 다른 서열로 만든 앵커의 서열(빠진 꼴까지 채운 전체)이고, 해석·재지정이 이 서열로 범위를 계산한다. 없으면 기본 서열이다.
 */
export type HeadingRangeAnchor = {
  id: string;
  kind: "headingRange";
  at: { sectionIndex: number; parentPath: number[] };
  index: number;
  marker: HeadingMarker;
  heading: ParagraphPrint;
  print: RangePrint;
  order?: HeadingForm[];
};

/**
 * 탐지한 제목 하나(`detectHeadings`). `text`는 개체 자리 글자(U+FFFC)를 뺀 글의 앞 40자, `sha256`은 문단 글 해시(`line` 앵커와 같다).
 * `bold`·`height`는 첫 글 조각이 든 run의 글자모양(진하게, 글자 크기 HWPUNIT)이고, 글자모양을 찾지 못하면 `height`가 없다.
 */
export type Heading = {
  at: { sectionIndex: number; parentPath: number[] };
  index: number;
  text: string;
  sha256: string;
  marker: HeadingMarker;
  bold: boolean;
  height?: number;
};

/** `cell` 앵커의 선택 지문: 표 모양(행·열 수), 첫 행 글들의 해시, 그 셀 글의 해시 */
export type CellPrint = { rows: number; cols: number; head: string; text: string };

/** `object` 앵커의 선택 지문: 종류, 크기(HWPUNIT), 수량(표는 셀 수. 그 밖은 생략) */
export type ObjectPrint = { objectType: string; width?: number; height?: number; count?: number };

/**
 * 이동표의 항목: 같은 구역·같은 부모의 `from`~`to` 문단이 `count`개 문단으로 바뀐다(문서 순서의 원본 좌표).
 * 삭제는 `count = 0`, 삽입은 덮이는 문단이 없는 빈 범위(`to = from - 1`)다. `delta = count - (to - from + 1)`.
 */
export type Move = { sectionIndex: number; parentPath: number[]; from: number; to: number; count: number; delta: number };
