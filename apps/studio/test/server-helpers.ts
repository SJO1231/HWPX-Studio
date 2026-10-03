// 서버 시험 도우미: 시험마다 새 서버(임시 작업 공간, 포트 0)를 띄우고 끝나면 닫고 지운다. 실제 HTTP로 부른다.
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { createStudioApp, HOST, type StudioApp, type StudioOptions } from "../src/app.ts";
import type { DataResponse, GenerateResponse, TemplateResponse } from "../src/api-types.ts";
import { sandbox } from "./helpers.ts";

export type Ctx = {
  base: string;
  port: number;
  /** 시험 전용 폴더(이 안에서만 쓴다) */
  dir: string;
  /** 작업 공간(처음에는 없다) */
  workspace: string;
  /** os.tmpdir()가 가리키게 한 폴더: 서버 코드가 임시 파일을 쓰면 여기서 보인다 */
  tmp: string;
  /** 폴더 열기 요청이 받은 경로들 */
  opened: string[];
  app: StudioApp;
};

export const STAMP = "20261003-143005";

/**
 * 포트 0으로 띄우되 `fetch`가 받아 주는 포트가 나올 때까지 다시 띄운다. Windows의 동적 포트 범위가 1025~15000인 PC에서는 운영체제가 준 포트가
 * fetch 표준의 차단 포트(4045, 5060, 6000, 6665~6669, 10080 등)일 수 있고, 그러면 fetch가 "bad port"로 실패해 시험이 가끔 무작위로 깨진다.
 */
async function listenUsable(app: StudioApp): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise<void>((resolve) => app.server.listen(0, HOST, resolve));
    const port = (app.server.address() as AddressInfo).port;
    try {
      await fetch(`http://${HOST}:${port}/api/nothing`);
      return port;
    } catch (e) {
      if (!/bad port/.test(String((e as { cause?: { message?: unknown } }).cause?.message))) throw e;
    }
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
  throw new Error("fetch가 받아 주는 포트를 얻지 못했다");
}

export async function withApp(fn: (c: Ctx) => Promise<void>, options: StudioOptions = {}): Promise<void> {
  const box = sandbox();
  const tmp = join(box.dir, "tmp");
  mkdirSync(tmp);
  const saved = { TEMP: process.env["TEMP"], TMP: process.env["TMP"], TMPDIR: process.env["TMPDIR"] };
  process.env["TEMP"] = process.env["TMP"] = process.env["TMPDIR"] = tmp;
  const opened: string[] = [];
  const workspace = join(box.dir, "ws");
  const app = createStudioApp({ workspace, opener: (folder) => Promise.resolve(void opened.push(folder)), now: () => new Date(2026, 9, 3, 14, 30, 5), ...options });
  const port = await listenUsable(app);
  try {
    await fn({ base: `http://${HOST}:${port}`, port, dir: box.dir, workspace, tmp, opened, app });
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    box.remove();
  }
}

/** 폴더 아래의 파일 경로 전부(`/` 구분, 정렬). 폴더 자체는 세지 않는다. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path).split(/[\\/]/).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

export const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

export const post = (c: Ctx, path: string, body: Uint8Array, type = "application/octet-stream"): Promise<Response> =>
  fetch(`${c.base}${path}`, { method: "POST", headers: { "Content-Type": type }, body: new Uint8Array(body) });

export const postJson = (c: Ctx, path: string, body: unknown): Promise<Response> => post(c, path, enc(body), "application/json");

export async function uploadTemplate(c: Ctx, bytes: Uint8Array, name = "양식.hwpx"): Promise<TemplateResponse> {
  const res = await post(c, `/api/quick/template?name=${encodeURIComponent(name)}`, bytes);
  if (res.status !== 200) throw new Error(`template ${res.status}: ${await res.text()}`);
  return (await res.json()) as TemplateResponse;
}

export async function uploadData(c: Ctx, session: string, data: unknown): Promise<DataResponse> {
  const res = await post(c, `/api/quick/data?session=${session}`, enc(data));
  if (res.status !== 200) throw new Error(`data ${res.status}: ${await res.text()}`);
  return (await res.json()) as DataResponse;
}

export async function generateRun(c: Ctx, session: string, missing?: string): Promise<GenerateResponse> {
  const res = await postJson(c, "/api/quick/generate", missing === undefined ? { session } : { session, missing });
  if (res.status !== 200) throw new Error(`generate ${res.status}: ${await res.text()}`);
  return (await res.json()) as GenerateResponse;
}

export async function download(c: Ctx, session: string, index: number): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
  const res = await fetch(`${c.base}/api/quick/result/${session}/${index}`);
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
}

/** 서버 앞에서 헤더를 마음대로 정해 GET을 보내 상태와 본문을 받는다(Host·Origin 시험) */
export function rawGetBody(c: Ctx, path: string, headers: Record<string, string>): Promise<{ status: number; type: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port: c.port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (x: Buffer) => chunks.push(x));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** `rawGetBody`의 상태 코드만 */
export const rawGet = async (c: Ctx, path: string, headers: Record<string, string>): Promise<number> => (await rawGetBody(c, path, headers)).status;
