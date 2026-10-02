import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { handleApi, MAX_UPLOAD, type ApiRequest } from "./api.ts";
import { resolveStatic } from "./files.ts";
import { createSessionStore, type SessionStore } from "./sessions.ts";

export const PORT = 4173;
export const HOST = "127.0.0.1";

// 화면은 외부 주소를 요청하지 않는다: 같은 출처의 파일·API와 SVG(blob:)·wasm만 허용한다.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export type ViewerApp = { server: Server; store: SessionStore };

function send(res: ServerResponse, status: number, contentType: string, body: string | Uint8Array, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": typeof body === "string" ? Buffer.byteLength(body) : body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": CSP,
    ...headers,
  });
  res.end(body);
}

/** 요청 경로(쿼리 제외). 풀 수 없는 주소는 `/`로 본다. */
const pathOf = (url: string | undefined): string => {
  try {
    return new URL(url ?? "/", `http://${HOST}`).pathname;
  } catch {
    return "/";
  }
};

/** 오류 응답의 형. `/api/` 아래는 화면이 읽을 수 있게 `{ error: { code, message } }` JSON이고, 그 밖(정적 파일)은 글이다. */
export function errorReply(url: string | undefined, code: string, message: string): { contentType: string; body: string } {
  return pathOf(url).startsWith("/api/")
    ? { contentType: "application/json; charset=utf-8", body: JSON.stringify({ error: { code, message } }) }
    : { contentType: "text/plain; charset=utf-8", body: message };
}

function sendError(req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string): void {
  const reply = errorReply(req.url, code, message);
  send(res, status, reply.contentType, reply.body);
}

/**
 * 요청 본문을 읽는다. 한도(`MAX_UPLOAD`)를 넘으면 undefined다: 이미 받은 조각은 버리고(메모리에 쌓지 않는다) 남은 본문도 읽어서 버린다 —
 * 본문을 읽지 않은 채 응답하면 같은 연결의 다음 요청이 남은 본문과 섞이고 클라이언트는 ECONNRESET을 만난다. 한도의 두 배를 넘게 보내면 연결을 끊는다.
 */
async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  let chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 2 * MAX_UPLOAD) {
      req.destroy();
      return undefined;
    }
    if (size > MAX_UPLOAD) {
      over = true;
      chunks = [];
    }
    if (!over) chunks.push(buf);
  }
  return over ? undefined : new Uint8Array(Buffer.concat(chunks));
}

/** 요청의 `Host`가 이 서버(루프백)의 것인가. 다른 호스트 이름으로 들어온 요청(DNS 리바인딩)은 받지 않는다. */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host ?? "";
  return host === `${HOST}:${port}` || host === `localhost:${port}`;
}

/** 시험 구현 서버를 만든다(아직 듣지 않는다). `listen(port, "127.0.0.1")`은 부르는 쪽이 한다. */
export function createViewerApp(): ViewerApp {
  const store = createSessionStore();
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const port = (server.address() as { port?: number } | null)?.port ?? PORT;
        if (!hostAllowed(req, port)) return sendError(req, res, 403, "HOST", "허용되지 않은 호스트입니다.");
        const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);

        if (url.pathname.startsWith("/api/")) {
          // 같은 출처의 화면에서 온 요청만 받는다(다른 사이트의 페이지가 로컬 서버를 두드리지 못하게)
          const origin = req.headers.origin;
          if (origin !== undefined && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) {
            return send(res, 403, "application/json; charset=utf-8", JSON.stringify({ error: { code: "ORIGIN", message: "허용되지 않은 출처입니다." } }));
          }
          const body = req.method === "GET" || req.method === "HEAD" ? new Uint8Array(0) : await readBody(req);
          // 413 뒤에는 연결을 닫는다(본문을 끝까지 읽지 못했을 수 있어 같은 연결을 다시 쓰면 안 된다)
          if (body === undefined) return send(res, 413, "application/json; charset=utf-8", JSON.stringify({ error: { code: "TOO_LARGE", message: "본문이 너무 큽니다." } }), { Connection: "close" });
          const request: ApiRequest = { method: req.method ?? "GET", pathname: url.pathname, query: url.searchParams, contentType: req.headers["content-type"] ?? "", body };
          const out = handleApi(store, request);
          return send(res, out.status, out.contentType, out.body, out.headers);
        }

        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "GET만 받습니다.");
        const file = resolveStatic(url.pathname);
        if (file === undefined) return send(res, 404, "text/plain; charset=utf-8", "없는 파일입니다.");
        const bytes = readFileSync(file.file);
        // 브라우저용 .ts는 번들러 없이 Node의 타입 제거로 바꿔서 준다(import의 `.ts` 확장자는 그대로 두면 서버가 같은 규칙으로 다시 준다)
        // 번들러가 하는 일이 하나 더 있다: 맨몸 지정자 `@rhwp/core`(Node에서는 node_modules에서 풀린다)를 서버가 제공하는 주소로 바꾼다
        const body = file.strip
          ? stripTypeScriptTypes(bytes.toString("utf8"), { mode: "strip" }).replace(/(from\s*)"@rhwp\/core"/g, '$1"/vendor/rhwp/rhwp.js"')
          : new Uint8Array(bytes);
        return send(res, 200, file.type, body);
      } catch {
        if (!res.headersSent) sendError(req, res, 500, "INTERNAL", "서버 내부 오류입니다.");
        else res.end();
      }
    })();
  });
  return { server, store };
}
