import type { Server } from "node:http";
import { createShell, errorReply, HOST } from "../../../packages/viewer/src/host/index.ts";
import { handleApi, MAX_UPLOAD } from "./api.ts";
import { resolveStatic } from "./files.ts";
import { createSessionStore, type SessionStore } from "./sessions.ts";

export const PORT = 4173;
// 로컬 서버 껍데기(Host·Origin 검사, CSP, 본문 한도, `.ts` 타입 제거 제공, JSON 오류)는 호스트 공용 코드다.
export { HOST, errorReply };

export type ViewerApp = { server: Server; store: SessionStore };

/** 시험 구현 서버를 만든다(아직 듣지 않는다). `listen(port, "127.0.0.1")`은 부르는 쪽이 한다. */
export function createViewerApp(): ViewerApp {
  const store = createSessionStore();
  const server = createShell({ port: PORT, maxBody: MAX_UPLOAD, api: (request) => handleApi(store, request), resolveStatic });
  return { server, store };
}
