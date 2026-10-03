// 로컬 호스트 서버의 껍데기: 루프백 Host·Origin 검사, CSP, 본문 한도, 브라우저용 `.ts`의 타입 제거 제공, JSON 오류 응답.
// 앱은 `/api/` 요청을 처리하는 함수와 정적 파일 해석 함수를 넘기고, `listen(port, HOST)`는 부르는 쪽이 한다.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import type { StaticFile } from "./static.ts";

export const HOST = "127.0.0.1";

// 화면은 외부 주소를 요청하지 않는다: 같은 출처의 파일·API와 SVG(blob:)·wasm만 허용한다.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export type HostRequest = { method: string; pathname: string; query: URLSearchParams; contentType: string; body: Uint8Array };
export type HostResponse = { status: number; contentType: string; body: string | Uint8Array; headers?: Record<string, string> };

export type ShellOptions = {
  /** 서버가 아직 듣기 전에 쓰는 기본 포트(Host 검사의 기준). 듣기 시작하면 실제 포트를 쓴다 */
  port: number;
  /** 요청 본문의 최대 바이트 */
  maxBody: number;
  /** `/api/` 아래 요청 처리. 던지지 않아야 한다(오류는 응답으로 낸다) */
  api(request: HostRequest): HostResponse | Promise<HostResponse>;
  /** 정적 파일 해석(API 밖의 GET) */
  resolveStatic(pathname: string): StaticFile | undefined;
};

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

/** 껍데기 거절 응답의 JSON 본문: `plain`은 비전문가가 읽는 쉬운 말 한 문장이다. */
const errorJson = (code: string, message: string, plain?: string): string => JSON.stringify({ error: plain === undefined ? { code, message } : { code, message, plain } });

/**
 * 오류 응답의 형. `/api/` 아래는 화면이 읽을 수 있게 `{ error: { code, message } }` JSON(`plain`을 주면 `plain`도 담는다)이고,
 * 그 밖(정적 파일)은 `message`만 있는 글이다.
 */
export function errorReply(url: string | undefined, code: string, message: string, plain?: string): { contentType: string; body: string } {
  return pathOf(url).startsWith("/api/")
    ? { contentType: "application/json; charset=utf-8", body: errorJson(code, message, plain) }
    : { contentType: "text/plain; charset=utf-8", body: message };
}

function sendError(req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string, plain?: string): void {
  const reply = errorReply(req.url, code, message, plain);
  send(res, status, reply.contentType, reply.body);
}

/** 본문 한도를 사람이 읽는 크기로(1 MiB 미만이면 KiB). */
const sizeText = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB` : `${Math.ceil(bytes / 1024)} KiB`);

/**
 * 요청 본문을 읽는다. 한도(`maxBody`)를 넘으면 undefined다: 이미 받은 조각은 버리고(메모리에 쌓지 않는다) 남은 본문도 읽어서 버린다 —
 * 본문을 읽지 않은 채 응답하면 같은 연결의 다음 요청이 남은 본문과 섞이고 클라이언트는 ECONNRESET을 만난다. 한도의 두 배를 넘게 보내면 연결을 끊는다.
 */
async function readBody(req: IncomingMessage, maxBody: number): Promise<Uint8Array | undefined> {
  let chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 2 * maxBody) {
      req.destroy();
      return undefined;
    }
    if (size > maxBody) {
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

/** 서버를 만든다(아직 듣지 않는다). `listen(port, "127.0.0.1")`은 부르는 쪽이 한다. */
export function createShell(options: ShellOptions): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const port = (server.address() as { port?: number } | null)?.port ?? options.port;
        if (!hostAllowed(req, port)) return sendError(req, res, 403, "HOST", "허용되지 않은 호스트입니다.", `이 주소로는 열 수 없습니다. 브라우저에서 http://${HOST}:${port} 로 여세요.`);
        const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);

        if (url.pathname.startsWith("/api/")) {
          // 같은 출처의 화면에서 온 요청만 받는다(다른 사이트의 페이지가 로컬 서버를 두드리지 못하게)
          const origin = req.headers.origin;
          if (origin !== undefined && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) {
            return send(res, 403, "application/json; charset=utf-8", errorJson("ORIGIN", "허용되지 않은 출처입니다.", "다른 사이트에서 온 요청이라 받지 않았습니다."));
          }
          const body = req.method === "GET" || req.method === "HEAD" ? new Uint8Array(0) : await readBody(req, options.maxBody);
          // 413 뒤에는 연결을 닫는다(본문을 끝까지 읽지 못했을 수 있어 같은 연결을 다시 쓰면 안 된다)
          if (body === undefined) {
            return send(res, 413, "application/json; charset=utf-8", errorJson("TOO_LARGE", "본문이 너무 큽니다.", `올린 내용이 너무 큽니다(한도 ${sizeText(options.maxBody)}).`), { Connection: "close" });
          }
          const out = await options.api({ method: req.method ?? "GET", pathname: url.pathname, query: url.searchParams, contentType: req.headers["content-type"] ?? "", body });
          return send(res, out.status, out.contentType, out.body, out.headers);
        }

        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "GET만 받습니다.");
        const file = options.resolveStatic(url.pathname);
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
  return server;
}
