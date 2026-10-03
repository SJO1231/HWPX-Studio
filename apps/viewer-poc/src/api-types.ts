// 서버와 웹 화면이 주고받는 JSON의 형. 형만 있는 파일이라 브라우저 코드가 `import type`으로 가져온다(엔진을 값으로 가져오지 않는다).
// 위치 변환·앵커 초안·강조에 관한 형은 호스트 공용(`packages/viewer/src/host/types.ts`)이고, 이 파일은 시험 앱 고유의 형을 더해 함께 내보낸다.
import type { AnchorDraftJson, MarkRange } from "../../../packages/viewer/src/host/types.ts";

export type { AnchorDraftJson, ApiError, DraftView, LocatePoint, LocateRequest, LocateResponse, MarkRange } from "../../../packages/viewer/src/host/types.ts";

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
