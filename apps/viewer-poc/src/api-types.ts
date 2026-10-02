// 서버와 웹 화면이 주고받는 JSON의 형. 형만 있는 파일이라 브라우저 코드가 `import type`으로 가져온다(엔진을 값으로 가져오지 않는다).
import type { CellAnchor, FieldAnchor, LineAnchor, WordAnchor } from "../../../packages/hwpx-engine/src/template/types.ts";
import type { EngineAddress, LocateEdge, RhwpPosition, Shown } from "../../../packages/viewer/src/map/types.ts";

/** 앵커 초안(템플릿에 `id`만 더해 넣을 수 있는 꼴) */
export type AnchorDraftJson = Omit<FieldAnchor, "id"> | Omit<WordAnchor, "id"> | Omit<LineAnchor, "id"> | Omit<CellAnchor, "id">;

export type ApiError = { error: { code: string; message: string } };

export type FixtureList = { names: string[] };

/** `POST /api/open` 본문: 저장소 시험 문서 이름. 올린 바이트는 `application/octet-stream` 본문으로 보낸다. */
export type OpenFixtureRequest = { fixture: string };

export type OpenResponse = {
  session: string;
  label: string;
  bytes: number;
  sections: number;
  generation: number;
  /** 엔진이 문서를 열며 낸 경고·오류의 코드 */
  issues: string[];
};

/**
 * 눌린 점 하나. `position`·`shown`은 뷰어 화면이 점 아래에 그려진 런에서 얻은 것이다(`ViewerDocument.pick`).
 * `limit: "paragraph"`는 화면이 문단까지만 믿는 점(빈 곳·같은 문단의 런이 겹친 곳)이고 `reason`이 그 사유다.
 * `guide`는 문서 좌표 없이 그려진 안내문 글(안내문 상태 누름틀 후보)이며, `position`·`shown`은 그 자리의 빈 런이다.
 */
export type LocatePoint = { position: RhwpPosition; shown?: Shown; guide?: string; trailing?: boolean; limit?: "char" | "paragraph"; reason?: string };

export type LocateRequest = {
  from: LocatePoint;
  /** 끌기로 고른 범위의 끝(같은 문단) */
  to?: LocatePoint;
};

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
  edge: LocateEdge;
  drafts: DraftView[];
};

export type ServerMark = {
  id: string;
  kind: string;
  evidence: string;
  anchor: AnchorDraftJson;
  mark?: MarkRange;
};

export type MarksResponse = { marks: ServerMark[] };

export type FillRequest = {
  fills: { anchor: AnchorDraftJson; value: string }[];
  mode?: "baseline" | "strict";
};

export type IssueJson = { severity: "error" | "warning"; code: string; message: string };

export type FillSummary = {
  actions: { type: string; anchor: string; targets: number }[];
  skipped: { anchor: string; code: string; message: string }[];
  stages: number;
  reread: { fields: number; paragraphs: number };
  validation: { beforeErrors: number; afterErrors: number; newErrors: number } | null;
};

export type FillResponse =
  | { ok: true; generation: number; bytes: number; summary: FillSummary; issues: IssueJson[] }
  /** `code`는 게이트를 통과하고도 적용된 채움이 없을 때의 `FILL_NOTHING_APPLIED`(세션은 그대로다). 게이트가 막은 경우에는 없다 */
  | { ok: false; code?: string; summary: FillSummary; issues: IssueJson[] };
