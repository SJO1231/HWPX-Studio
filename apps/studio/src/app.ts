import type { Server } from "node:http";
import { createShell, errorReply, HOST } from "../../../packages/viewer/src/host/index.ts";
import { handleApi, MAX_UPLOAD, type StudioContext } from "./api.ts";
import { resolveStatic } from "./files.ts";
import { createSessionStore, type SessionStore } from "./sessions.ts";
import { defaultWorkspace, openWithExplorer, type FolderOpener } from "./workspace.ts";

export const PORT = 4174;
// 로컬 서버 껍데기(Host·Origin 검사, CSP, 본문 한도, `.ts` 타입 제거 제공, JSON 오류)는 호스트 공용 코드다.
export { HOST, errorReply };

export type StudioOptions = {
  /** 작업 공간 폴더(기본: 사용자 홈의 `HWPX Studio`) */
  workspace?: string;
  /** 폴더를 여는 방법(기본: Windows 탐색기). 시험이 바꿔 끼운다 */
  opener?: FolderOpener;
  /** 요청 본문의 최대 바이트(기본 64 MiB) */
  maxBody?: number;
  /** 결과 폴더 이름에 쓰는 시각 */
  now?: () => Date;
};

export type StudioApp = { server: Server; store: SessionStore; workspace: string };

/** 스튜디오 서버를 만든다(아직 듣지 않는다). `listen(port, "127.0.0.1")`은 부르는 쪽이 한다. */
export function createStudioApp(options: StudioOptions = {}): StudioApp {
  const store = createSessionStore();
  const workspace = options.workspace ?? defaultWorkspace();
  const ctx: StudioContext = { store, workspace, opener: options.opener ?? openWithExplorer, now: options.now ?? ((): Date => new Date()) };
  const server = createShell({ port: PORT, maxBody: options.maxBody ?? MAX_UPLOAD, api: (request) => handleApi(ctx, request), resolveStatic });
  return { server, store, workspace };
}
