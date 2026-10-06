// 호스트(Node 서버)와 웹 화면이 주고받는 JSON 가운데 위치 변환·앵커 초안·강조에 관한 공용 형. 형만 있는 파일이라 브라우저 코드가 `import type`으로 가져온다(엔진을 값으로 가져오지 않는다).
import type { HeadingRangeAnchor, RangeAnchor } from "../../../hwpx-engine/src/fill/anchor-types.ts";
import type { BlockPreviewField, BlockPreviewPlace } from "../../../hwpx-engine/src/fill/block-preview-types.ts";
import type { BlockProto } from "../../../hwpx-engine/src/template/studio-types.ts";
import type { CellAnchor, FieldAnchor, LineAnchor, WordAnchor } from "../../../hwpx-engine/src/template/types.ts";
import type { CellRef, EngineAddress, LocateEdge, RhwpPosition, Shown } from "../map/types.ts";

/** 앵커 초안(템플릿에 `id`만 더해 넣을 수 있는 꼴). `range`·`headingRange`는 여러 문단에 걸친 끌기의 초안이다 */
export type AnchorDraftJson =
  | Omit<FieldAnchor, "id">
  | Omit<WordAnchor, "id">
  | Omit<LineAnchor, "id">
  | Omit<CellAnchor, "id">
  | Omit<RangeAnchor, "id">
  | Omit<HeadingRangeAnchor, "id">;

export type ApiError = { error: { code: string; message: string } };

/**
 * 눌린 점 하나. `position`·`shown`은 뷰어 화면이 점 아래에 그려진 런에서 얻은 것이다(`ViewerDocument.pick`).
 * `limit: "paragraph"`는 화면이 문단까지만 믿는 점(빈 곳·같은 문단의 런이 겹친 곳)이고 `reason`이 그 사유다.
 * `guide`는 문서 좌표 없이 그려진 안내문 글(안내문 상태 누름틀 후보)이며, `position`·`shown`은 그 자리의 빈 런이다.
 * `cell`은 표 칸의 빈 곳이다(렌더 트리의 표 경로의 행·열과 칸 안 줄 후보). 서버가 엔진 표·행·열로 칸을 찾고 줄 후보 가운데 이 칸의 문단으로 옮겨지는 첫 후보를 쓴다
 * (후보가 없거나 모두 다른 칸의 런이면 칸의 첫 문단). `cell`이 있으면 `position`·`shown` 등은 보내지 않는다(받아도 쓰지 않는다). 문단까지만 믿는 점에서 끈 범위도 문단 단위이므로 `to`도 쓰지 않는다.
 */
export type LocatePoint = { position?: RhwpPosition; cell?: CellRef; shown?: Shown; guide?: string; trailing?: boolean; limit?: "char" | "paragraph"; reason?: string };

export type LocateRequest = {
  from: LocatePoint;
  /** 끌기로 고른 범위의 끝(같은 문단이면 글자 범위, 다른 문단이면 문단 범위) */
  to?: LocatePoint;
};

/**
 * 시작·끝 깃발로 고른 문단 범위(#74). 위치 요청과 같은 `locate`로 보내며 `from`·`to`와 함께 쓰지 않는다.
 * 깃발은 각각 눌린 점 하나(`LocatePoint`. 표 칸의 빈 곳이면 `cell`)이고 그 점의 문단까지만 쓴다(글자 순번은 범위에 쓰지 않는다).
 * 응답은 두 문단을 끈 것과 같은 `LocateResponse`다: 같은 구역·같은 부모이면 `span`과 `range` 초안(앞 문단이 제목이면 `headingRange` 초안 둘째),
 * 끝이 시작보다 앞이면 바꿔 잡고, 두 깃발이 같은 문단이면 문단 하나짜리 범위다. 부모가 다르면 `none`(`RANGE_PARAGRAPHS_DIFFER`), 한 깃발을 풀지 못하면 그 깃발의 사유다.
 */
export type FlagRequest = { flags: { start: LocatePoint; end: LocatePoint } };

/** 쪽 위에 강조할 자리: 같은 문단 안 rhwp 글자 순번 구간(`guide`가 있으면 안내문 상태 누름틀의 안내문 글) */
export type MarkRange = { position: RhwpPosition; endOffset: number; guide?: string; /** 구간이 덮어야 할 글(낱말·누름틀 값). 화면이 쪽 글자 배치와 비교해 어긋나면 그리지 않는다 */ text?: string };

/**
 * 앵커 초안과 그것이 가리키는 자리의 강조 구간. `blocked`는 채움이 이 초안을 건너뛰거나 거절할 사유 코드
 * (`FILL_MIXED_FORMAT`·`FILL_CROSSES_MARKUP`·`FILL_SPLITS_CLUSTER`·`FILL_HAS_OBJECT`)이다. 초안은 그대로 두고 알리기만 한다.
 */
export type DraftView = { anchor: AnchorDraftJson; mark?: MarkRange; blocked?: string };

export type LocateResponse = {
  precision: "char" | "paragraph" | "none";
  reason?: string;
  address?: EngineAddress;
  /** 지나온 컨테이너 컨트롤(`tbl`, `rect`, `tbl:caption` 등) */
  trail: string[];
  /** 범위 선택이면 엔진 논리 오프셋 구간 */
  range?: { start: number; end: number };
  /** 문단 범위(여러 문단에 걸친 끌기, 시작·끝 깃발)이면 같은 부모(`parentPath`: 빈 배열이면 구역 최상위) 안 문단 범위 `from`~`to`(문서 순서, 포함) */
  span?: { sectionIndex: number; parentPath: number[]; from: number; to: number };
  edge: LocateEdge;
  drafts: DraftView[];
};

/**
 * 블록 단독 미리보기 요청(#75). 저장한 블록의 id(앱의 저장소가 찾는다) 하나, 또는 원형(`block-proto@1` JSON 객체)과 그 판의 조각 덩어리(base64)를 보낸다.
 * 둘을 함께 보내지 않는다. 덩어리 상한은 `PREVIEW_MAX_BLOB`(32 MiB)이다.
 */
export type BlockPreviewRequest = { block: string } | { proto: BlockProto; blob: string };

/**
 * 블록 단독 미리보기 응답. `hwpx`는 엔진이 빈 바탕 문서(형식 1.5, A4)에 블록을 넣어 만든 HWPX 바이트(base64)이고 저장 게이트를 통과한 것이다(블록 최상위 문단은 구역 0의 최상위 1번부터).
 * `fields`는 같은 종류·이름 입력 항목 수(처음 나온 순서), `places`는 미리보기 문서 안 자리(엔진 주소·논리 오프셋)와 쪽 위 강조 구간(`marks`. 옮길 수 없는 자리는 빈 목록),
 * `warnings`는 조각 가져오기 경고(`FRAG_UNIT_CONVERTED`·`FRAG_FORMAT_UNKNOWN`·`FRAG_DANGLING_SOURCE` 등)와 상속 오류 `GATE_INHERITED`다.
 */
export type BlockPreviewResponse = {
  hwpx: string;
  /** `hwpx` 바이트의 sha256(16진) */
  sha256: string;
  fields: BlockPreviewField[];
  places: (BlockPreviewPlace & { marks: MarkRange[] })[];
  warnings: { code: string; message: string }[];
};
