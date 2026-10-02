// rhwp가 주는 위치(클릭과 쪽 글자 배치가 같은 꼴)와 엔진 주소, 둘 사이의 변환 결과의 자료 구조.
// 이 파일은 엔진도 rhwp도 가져오지 않는다(브라우저 화면 코드도 이 형을 쓴다).

/** `cellPath`의 한 단계. 바깥 표(또는 글상자)부터 안쪽 순서로 나열한다. */
export type CellStep = { controlIndex: number; cellIndex: number; cellParaIndex: number };

export type RhwpPosition = {
  sectionIndex: number;
  /** 본문이면 구역 최상위 문단 번호, 표 셀·글상자 안이면 그 안의 문단 번호 */
  paragraphIndex: number;
  /** rhwp의 글자 순번(유니코드 글자 단위, 탭·줄바꿈 1칸, 글자처럼 취급하는 그림·도형·수식과 자동 번호 1칸) */
  charOffset: number;
  /** 표 셀·글상자 안이면 그것을 담은 최상위 문단 번호 */
  parentParaIndex?: number;
  cellPath?: CellStep[];
};

/** 엔진 주소. `path`는 `[문단, 하위목록, 문단, ...]`, `offset`은 문단 논리 텍스트의 UTF-16 오프셋 */
export type EngineAddress = { sectionIndex: number; path: number[]; offset?: number };

export type Located = {
  address: EngineAddress;
  precision: "char" | "paragraph";
  /** `paragraph`로 내려온 사유 */
  reason?: string;
  /** 지나온 컨테이너 컨트롤의 종류(`tbl`, `rect` 등), 바깥부터. 본문이면 빈 목록 */
  trail: string[];
};

/** 엔진 문단 자체를 찾지 못한 경우. 틀린 주소를 내지 않으려고 주소 없이 사유만 돌려준다. */
export type Unlocated = { address?: undefined; precision: "none"; reason: string; trail: string[] };

/** rhwp가 그 자리에 그린 글(쪽 글자 배치의 런 하나)과 그 첫 글자의 rhwp 글자 순번 */
export type Shown = { text: string; start: number };

/**
 * 폭 0 객체 자리 글자가 끼어 있을 때 어느 쪽 엔진 오프셋으로 옮길지. `start`: 다음 글자 바로 앞, `end`: 앞 글자 바로 뒤,
 * `guide`: 안내문 상태 누름틀의 안내문(rhwp가 글자 칸 없이 따로 그린다)을 눌렀을 때 그 누름틀 안,
 * `trail`: 글자 사각형의 뒤쪽 절반을 눌러 캐럿이 글자 바로 뒤에 놓인 경우(`start`와 같되 안내문 상태 누름틀 바로 앞이면 누름틀 시작 표식 앞).
 */
export type LocateEdge = "start" | "end" | "guide" | "trail";

/** rhwp가 표 캡션 문단에 붙이는 `cellIndex` [실행 관측] */
export const TABLE_CAPTION_CELL = 65534;

/** 위치를 옮기지 못했을 때 쓰는 사유 코드(`Located.reason`, `Unlocated.reason`) */
export const REASONS = {
  sectionNotFound: "SECTION_NOT_FOUND",
  paragraphNotFound: "PARAGRAPH_NOT_FOUND",
  parentMissing: "PARENT_PARAGRAPH_MISSING",
  controlNotFound: "CONTROL_NOT_FOUND",
  controlUnknown: "CONTROL_KIND_UNKNOWN",
  controlNotContainer: "CONTROL_NOT_CONTAINER",
  cellNotFound: "CELL_NOT_FOUND",
  textboxAmbiguous: "TEXTBOX_AMBIGUOUS",
  cellParagraphNotFound: "CELL_PARAGRAPH_NOT_FOUND",
  pathInconsistent: "PATH_INCONSISTENT",
  offsetOutOfRange: "OFFSET_OUT_OF_RANGE",
  widthUnknown: "OBJECT_WIDTH_UNKNOWN",
  shownRange: "SHOWN_OUT_OF_RANGE",
  textMismatch: "TEXT_MISMATCH",
  paragraphMismatch: "PARAGRAPH_MISMATCH",
  ambiguousRun: "AMBIGUOUS_RUN",
  labelRun: "LABEL_RUN",
  objectRun: "OBJECT_RUN",
  /** 눌린 점 아래에 글자가 겹친 런이 둘 이상이다(다른 문단이면 `none`, 같은 문단이면 `paragraph`) */
  overlappingRuns: "OVERLAPPING_RUNS",
  /** 눌린 점 아래의 글이 문서 좌표 없이 그려졌다(쪽 번호·번호 글·각주 번호 등) */
  unpositionedText: "UNPOSITIONED_TEXT",
  /** 글자가 없는 곳을 눌러 rhwp가 가리킨 가장 가까운 줄의 문단으로 내려왔다(`paragraph`) */
  nearestLine: "NEAREST_LINE",
  /** 글자가 없는 곳인데 rhwp가 가리킨 문단이 점에서 가장 가까운 런의 문단과 다르다(`none`) */
  nearestUnconfirmed: "NEAREST_UNCONFIRMED",
  /** 호출한 쪽이 문단까지만 허용하며 사유를 주지 않았다 */
  limited: "LIMITED",
} as const;

/**
 * 뷰어 화면이 눌린 점에서 얻은 위치와 한계(`ViewerDocument.pick`의 결과 가운데 서버가 위치 변환에 쓰는 것).
 * `position`의 글자 순번은 `shown`의 런 안 경계(`shown.start` + 런 안 순번)다. `guide`는 문서 좌표 없이 그려진 안내문 글(안내문 상태 누름틀 후보)이다.
 */
export type PickedPoint = {
  position: RhwpPosition;
  shown?: Shown;
  guide?: string;
  /** 글자 뒤쪽 절반을 눌러 캐럿이 글자 뒤에 놓였다. 안내문 상태 누름틀 바로 앞 경계를 누름틀 시작 표식 앞으로 옮기는 데 쓴다(`LocateEdge`의 `trail`) */
  trailing?: boolean;
  /** `char`(기본): 글을 확인하면 글자까지. `paragraph`: 문단까지만 */
  limit?: "char" | "paragraph";
  /** `limit: "paragraph"`일 때의 사유(없으면 `LIMITED`) */
  reason?: string;
};
