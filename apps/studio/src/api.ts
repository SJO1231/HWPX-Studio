// 서버의 JSON API(명세 4a). 문서·데이터·엔진은 이 호스트가 갖고, 브라우저는 보기와 선택만 한다.
// 오류는 `{ error: { code, message, plain } }`다: `plain`은 쉬운 말 한 문장(messages.ts).
import { HwpxError } from "../../../packages/hwpx-engine/src/index.ts";
import { HostError, isObj, parseJson, type HostRequest, type HostResponse } from "../../../packages/viewer/src/host/index.ts";
import type { DataResponse, GenerateResponse, MissingPolicy, TemplateResponse } from "./api-types.ts";
import { plainOf } from "./messages.ts";
import { analyzePlaces, countInvalidRecords, generateAll, listKeys, matchPlaces, parseQuickData } from "./quick.ts";
import type { QuickSession, SessionStore } from "./sessions.ts";
import { openFolder, saveResults, type FolderOpener } from "./workspace.ts";

/** 올린 문서·데이터의 최대 크기 */
export const MAX_UPLOAD = 64 * 1024 * 1024;

export type StudioContext = {
  store: SessionStore;
  /** 작업 공간 폴더(`out/`에 결과를 저장한다) */
  workspace: string;
  opener: FolderOpener;
  now(): Date;
};

const json = (body: unknown, status = 200): HostResponse => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
const failure = (status: number, code: string, message: string): HostResponse => json({ error: { code, message, plain: plainOf(code) } }, status);

const SESSION_ID = /^[0-9a-f-]{36}$/;

function sessionOf(ctx: StudioContext, id: unknown): QuickSession {
  const session = typeof id === "string" && SESSION_ID.test(id) ? ctx.store.get(id) : undefined;
  if (session === undefined) throw new HostError(404, "SESSION_NOT_FOUND", "세션이 없습니다(서버가 다시 시작됐거나 닫았습니다).");
  return session;
}

/** 본문을 JSON 객체로 읽는다. 아니면 `BAD_REQUEST`(400). */
function bodyObject(req: HostRequest): Record<string, unknown> {
  const body = parseJson(req.body);
  if (!isObj(body)) throw new HostError(400, "BAD_REQUEST", "본문은 JSON 객체여야 합니다.");
  return body;
}

const notEmpty = (req: HostRequest): void => {
  if (req.body.length === 0) throw new HostError(400, "EMPTY_UPLOAD", "빈 파일입니다.");
};

// ── 문서 올리기 → 자리 목록 ──────────────────────────────────────

function uploadTemplate(ctx: StudioContext, req: HostRequest): HostResponse {
  notEmpty(req);
  const name = (req.query.get("name") ?? "").slice(0, 255);
  const fileName = name === "" ? "문서.hwpx" : name;
  const places = analyzePlaces(req.body);
  const session = ctx.store.open(fileName, req.body, places);
  return json({ session: session.id, name: session.fileName, bytes: session.bytes.length, places } satisfies TemplateResponse);
}

// ── 데이터 올리기 → 키 목록과 대조표 ─────────────────────────────

function uploadData(ctx: StudioContext, req: HostRequest): HostResponse {
  const session = sessionOf(ctx, req.query.get("session"));
  notEmpty(req);
  const data = parseQuickData(req.body);
  session.data = data;
  session.dataBytes = req.body.length;
  ctx.store.touch(session);
  const { keys, truncated } = listKeys(data.records);
  const response: DataResponse = {
    session: session.id,
    form: data.form,
    records: data.records.length,
    invalidRecords: countInvalidRecords(data.records),
    keys,
    keysTruncated: truncated,
    matches: matchPlaces(session.places, data.records),
  };
  return json(response);
}

// ── 생성 ─────────────────────────────────────────────────────────

function saveErrorOf(e: unknown): NonNullable<GenerateResponse["saveError"]> {
  const code = e instanceof HostError ? e.code : "QUICK_SAVE_FAILED";
  const detail = e instanceof HostError ? e.message : `결과를 저장하지 못했습니다(${(e as NodeJS.ErrnoException).code ?? "알 수 없는 오류"}).`;
  return { code, message: detail, plain: plainOf(code) };
}

function generateRun(ctx: StudioContext, req: HostRequest): HostResponse {
  const body = bodyObject(req);
  const missing = body["missing"] === undefined ? "error" : body["missing"];
  if (missing !== "error" && missing !== "empty" && missing !== "keep") throw new HostError(400, "BAD_REQUEST", "missing은 error·empty·keep 가운데 하나여야 합니다.");
  const session = sessionOf(ctx, body["session"]);
  if (session.data === undefined) throw new HostError(409, "QUICK_NO_DATA", "데이터를 먼저 올려야 합니다.");

  const generated = generateAll(session.bytes, session.places, session.data, session.fileName, missing satisfies MissingPolicy);
  const toSave = generated.flatMap((g) => (g.output === undefined ? [] : [{ name: g.view.name, bytes: g.output }]));
  let folder: string | undefined;
  let saveError: GenerateResponse["saveError"];
  if (toSave.length > 0) {
    try {
      folder = saveResults(ctx.workspace, toSave, ctx.now());
    } catch (e) {
      saveError = saveErrorOf(e);
    }
  }
  const results = generated.map((g) => g.view);
  session.last = { results, files: generated.map((g) => g.output), folder };
  ctx.store.touch(session);
  const response: GenerateResponse = { session: session.id, results, folder: folder ?? null };
  if (saveError !== undefined) response.saveError = saveError;
  return json(response);
}

// ── 내려받기·폴더 열기 ───────────────────────────────────────────

const RESULT_ROUTE = /^\/api\/quick\/result\/([0-9a-f-]{36})\/(\d{1,6})$/;

/** `filename`은 ASCII 대체 이름, `filename*`는 한글 이름(RFC 5987) */
function disposition(name: string, index: number): string {
  const ascii = `result-${String(index + 1).padStart(3, "0")}.hwpx`;
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function download(ctx: StudioContext, id: string, indexText: string): HostResponse {
  const session = sessionOf(ctx, id);
  const index = Number(indexText);
  const bytes = session.last?.files[index];
  const view = session.last?.results[index];
  if (bytes === undefined || view === undefined) throw new HostError(404, "QUICK_RESULT_NOT_FOUND", "그 결과가 없습니다.");
  return { status: 200, contentType: "application/hwp+zip", body: bytes, headers: { "Content-Disposition": disposition(view.name, index) } };
}

async function openResultFolder(ctx: StudioContext, req: HostRequest): Promise<HostResponse> {
  const session = sessionOf(ctx, bodyObject(req)["session"]);
  const folder = session.last?.folder;
  if (folder === undefined) throw new HostError(409, "QUICK_NO_FOLDER", "저장된 결과 폴더가 없습니다.");
  await openFolder(ctx.workspace, folder, ctx.opener);
  return json({ opened: true });
}

// ── 라우팅 ───────────────────────────────────────────────────────

const methodNotAllowed = (): HostResponse => failure(405, "METHOD_NOT_ALLOWED", "허용되지 않는 요청 방식입니다.");

export async function handleApi(ctx: StudioContext, req: HostRequest): Promise<HostResponse> {
  try {
    const post = (run: () => HostResponse | Promise<HostResponse>): HostResponse | Promise<HostResponse> => (req.method === "POST" ? run() : methodNotAllowed());
    switch (req.pathname) {
      case "/api/quick/template":
        return await post(() => uploadTemplate(ctx, req));
      case "/api/quick/data":
        return await post(() => uploadData(ctx, req));
      case "/api/quick/generate":
        return await post(() => generateRun(ctx, req));
      case "/api/quick/open-folder":
        return await post(() => openResultFolder(ctx, req));
    }
    const result = RESULT_ROUTE.exec(req.pathname);
    if (result !== null) return req.method === "GET" ? download(ctx, result[1] as string, result[2] as string) : methodNotAllowed();
    return failure(404, "NOT_FOUND", "그런 API가 없습니다.");
  } catch (e) {
    if (e instanceof HostError) return failure(e.status, e.code, e.message);
    // 문서를 열 수 없거나(PKG_·XML_·MODEL_) 데이터가 틀린(DATA_) 경우: 엔진의 코드를 그대로 알린다
    if (e instanceof HwpxError) return failure(400, e.code, e.message);
    return failure(500, "INTERNAL", "서버 내부 오류입니다.");
  }
}
