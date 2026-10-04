// 범위·셀·객체 앵커의 형(7.10). 문서 모델을 가져오지 않는 순수 형 정의라 `template/types.ts`가 참조한다.

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

/** `cell` 앵커의 선택 지문: 표 모양(행·열 수), 첫 행 글들의 해시, 그 셀 글의 해시 */
export type CellPrint = { rows: number; cols: number; head: string; text: string };

/** `object` 앵커의 선택 지문: 종류, 크기(HWPUNIT), 수량(표는 셀 수. 그 밖은 생략) */
export type ObjectPrint = { objectType: string; width?: number; height?: number; count?: number };

/**
 * 이동표의 항목: 같은 구역·같은 부모의 `from`~`to` 문단이 `count`개 문단으로 바뀐다(문서 순서의 원본 좌표).
 * 삭제는 `count = 0`, 삽입은 덮이는 문단이 없는 빈 범위(`to = from - 1`)다. `delta = count - (to - from + 1)`.
 */
export type Move = { sectionIndex: number; parentPath: number[]; from: number; to: number; count: number; delta: number };
