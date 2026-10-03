import type { XElement } from "../xml/tree.ts";

/** 표 연산의 대상: 구역 색인과 모델의 표(`tbl`) 요소. 중첩 표도 가리킬 수 있다. */
export type TableTarget = { sectionIndex: number; element: XElement };

export type Margins = { left: number; right: number; top: number; bottom: number };

export type Side = "left" | "right" | "top" | "bottom";

/**
 * 테두리 변경 요청. 기준 테두리 자원(borderFill)을 복제해 지정한 변만 바꾼다(`src/format`의 파생 자원: 같은 모양이 이미 있으면 그것을 쓴다).
 * `sides`를 빼면 네 변 전부다. 요청한 항목만 바꾸고 나머지는 기준 그대로다.
 */
export type BorderSpec = {
  sides?: Side[];
  /** 선 종류. 한컴 저장본에서 관측한 값: NONE, SOLID, DASH, DOT, DASH_DOT, DASH_DOT_DOT, LONG_DASH, CIRCLE, DOUBLE_SLIM, SLIM_THICK, THICK_SLIM, SLIM_THICK_SLIM */
  type?: string;
  /** 선 굵기. `0.12 mm` 꼴 */
  width?: string;
  /** `#RRGGBB` */
  color?: string;
};

export const BORDER_TYPES = [
  "NONE",
  "SOLID",
  "DASH",
  "DOT",
  "DASH_DOT",
  "DASH_DOT_DOT",
  "LONG_DASH",
  "CIRCLE",
  "DOUBLE_SLIM",
  "SLIM_THICK",
  "THICK_SLIM",
  "SLIM_THICK_SLIM",
] as const;

export const PAGE_BREAKS = ["CELL", "NONE", "TABLE"] as const;
export const HALIGNS = ["LEFT", "CENTER", "RIGHT"] as const;
export const VERT_ALIGNS = ["TOP", "CENTER", "BOTTOM"] as const;
export const LINE_WRAPS = ["BREAK", "SQUEEZE"] as const;

/** 표 설정(`planSetTableProps`). 요청한 항목만 바뀐다. */
export type TableSettings = {
  /** 글자처럼 취급(`pos@treatAsChar`) */
  treatAsChar?: boolean;
  /** 쪽 경계에서 나눔(`tbl@pageBreak`) */
  pageBreak?: (typeof PAGE_BREAKS)[number];
  /** 제목 행 반복(`tbl@repeatHeader`) */
  repeatHeader?: boolean;
  /** 셀 간격(`tbl@cellSpacing`, HWPUNIT) */
  cellSpacing?: number;
  /** 바깥 여백(`outMargin`). 일부 변만 줄 수 있다. */
  outMargin?: Partial<Margins>;
  /** 안 여백(`inMargin`, 셀 기본 안 여백) */
  inMargin?: Partial<Margins>;
  /** 가로 정렬(`pos@horzAlign`) */
  hAlign?: (typeof HALIGNS)[number];
  /** 표 테두리(`tbl@borderFillIDRef`를 파생 자원으로) */
  border?: BorderSpec;
};

/** 셀 설정(`planSetCellProps`) */
export type CellSettings = {
  /** 세로 정렬(`subList@vertAlign`) */
  vertAlign?: (typeof VERT_ALIGNS)[number];
  /** 줄 나눔(`subList@lineWrap`) */
  lineWrap?: (typeof LINE_WRAPS)[number];
  /** 제목 셀(`tc@header`) */
  header?: boolean;
  /** 셀 안 여백(`cellMargin`). 정하면 `tc@hasMargin`도 켠다. */
  margin?: Partial<Margins>;
  /** 보호(`tc@protect`) */
  protect?: boolean;
  /** 셀 테두리(`tc@borderFillIDRef`를 파생 자원으로) */
  border?: BorderSpec;
};

/** 셀 선택: 셀의 주소(`rowAddr`, `colAddr`)가 두 범위(양 끝 포함)에 든 셀. 범위를 빼면 그 방향 전부다. */
export type CellSelection = { rows?: [number, number]; cols?: [number, number] };

export type CellPropsEntry = CellSelection & { props: CellSettings };

export type CopyText = "clear" | "keep";
