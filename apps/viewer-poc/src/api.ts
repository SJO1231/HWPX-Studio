// 서버의 JSON API. 문서 바이트·파싱·위치 변환·앵커 초안·채움은 모두 이 호스트가 하고, 브라우저는 표시용 바이트만 받는다.
// 위치 변환·앵커 초안·강조 계산과 위치 요청의 입력 검사는 호스트 공용 코드(`packages/viewer/src/host/`)다.
import { readFileSync } from "node:fs";
import {
  HwpxError,
  findCandidates,
  generate,
  readDataset,
  readTemplate,
  type AnchorDraft,
  type Issue,
} from "../../../packages/hwpx-engine/src/index.ts";
import { HostError, isObj, locate, markOf, parseJson, resolveDrafts, type HostRequest, type HostResponse } from "../../../packages/viewer/src/host/index.ts";
import type {
  AnchorDraftJson,
  FillRequest,
  FillResponse,
  FillSummary,
  FixtureList,
  IssueJson,
  MarksResponse,
  OpenResponse,
  ServerMark,
} from "./api-types.ts";
import { listFixtures, resolveFixture } from "./files.ts";
import type { Session, SessionStore } from "./sessions.ts";

export type ApiRequest = HostRequest;
export type ApiResponse = HostResponse;

/** 올린 문서의 최대 크기 */
export const MAX_UPLOAD = 64 * 1024 * 1024;

const json = (body: unknown, status = 200): ApiResponse => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
const failure = (status: number, code: string, message: string): ApiResponse => json({ error: { code, message } }, status);

// ── 문서 열기 ────────────────────────────────────────────────────

function openResponse(session: Session): OpenResponse {
  return {
    session: session.id,
    label: session.label,
    bytes: session.bytes.length,
    sections: session.doc.sections.length,
    generation: session.generation,
    issues: session.doc.issues.map((i) => i.code),
  };
}

function open(store: SessionStore, req: ApiRequest): ApiResponse {
  if (req.contentType.startsWith("application/octet-stream")) {
    if (req.body.length === 0) throw new HostError(400, "EMPTY_UPLOAD", "빈 파일입니다.");
    return json(openResponse(store.open("올린 파일", new Uint8Array(req.body))));
  }
  const body = parseJson(req.body);
  if (!isObj(body) || typeof body["fixture"] !== "string") throw new HostError(400, "BAD_REQUEST", "본문은 { fixture: 이름 }이어야 합니다.");
  // 목록(`/api/fixtures`)에 있는 이름과 글자 그대로 같을 때만 연다(Windows의 파일 시스템은 대소문자를 가리지 않으므로 목록으로 먼저 가른다)
  const file = listFixtures().includes(body["fixture"]) ? resolveFixture(body["fixture"]) : undefined;
  if (file === undefined) throw new HostError(404, "FIXTURE_NOT_FOUND", "그런 시험 문서가 없습니다.");
  return json(openResponse(store.open(body["fixture"], new Uint8Array(readFileSync(file)))));
}

// ── 강조할 자리 ──────────────────────────────────────────────────

const toJson = (d: AnchorDraft): AnchorDraftJson => d;

function marks(session: Session): MarksResponse {
  const out: ServerMark[] = [];
  const candidates = findCandidates(session.doc);
  const found = resolveDrafts(session.doc, candidates.map((c) => c.anchor));
  candidates.forEach((c, i) => {
    const mark = markOf(session.doc, c.anchor, found[i]);
    const item: ServerMark = { id: `m${i}`, kind: c.kind, evidence: c.evidence, anchor: toJson(c.anchor) };
    if (mark !== undefined) item.mark = mark;
    out.push(item);
  });
  return { marks: out };
}

// ── 채우기 ───────────────────────────────────────────────────────

const issueJson = (i: Issue): IssueJson => ({ severity: i.severity, code: i.code, message: i.message });

function fill(session: Session, store: SessionStore, body: unknown): FillResponse {
  const req = body as FillRequest;
  if (!isObj(body) || !Array.isArray(req.fills) || req.fills.length === 0 || req.fills.length > 200) {
    throw new HostError(400, "BAD_REQUEST", "본문은 { fills: [{ anchor, value }, ...] }이어야 합니다(1~200건).");
  }
  const mode = req.mode === "strict" ? "strict" : "baseline";
  const anchors: unknown[] = [];
  const rules: unknown[] = [];
  req.fills.forEach((f, i) => {
    if (!isObj(f) || !isObj(f.anchor) || typeof f.value !== "string") throw new HostError(400, "BAD_REQUEST", `fills[${i}]은 { anchor, value(문자열) }여야 합니다.`);
    // 서버가 붙인 id가 이긴다(요청의 앵커가 id를 들고 와도 규칙이 가리키는 앵커와 어긋나지 않게)
    anchors.push({ ...f.anchor, id: `a${i}` });
    rules.push({ id: `r${i}`, do: { type: "fill", anchor: `a${i}`, value: { text: f.value } } });
  });
  // 문서의 다른 `{{}}` 자리는 데이터가 없으므로 그대로 둔다
  const template = readTemplate({ schema: "hwpx-studio/template@1", anchors, rules, options: { missing: "keep" } });
  const result = generate(session.bytes, template, readDataset({}), { mode });

  const plan = result.report.plan;
  const validation = result.report.validation;
  const summary: FillSummary = {
    actions: plan.actions.map((a) => ({ type: a.type, anchor: a.anchor, targets: a.targets })),
    skipped: plan.skipped.map((s) => ({ anchor: s.anchor, code: s.code, message: s.message })),
    stages: result.report.stages.length,
    reread: result.report.reread,
    validation: validation === null ? null : { beforeErrors: validation.before.errors, afterErrors: validation.after.errors, newErrors: validation.newErrors.length },
  };
  const issues = result.report.issues.map(issueJson);
  if (!result.ok || result.dryRun) return { ok: false, summary, issues };
  // 게이트는 통과했지만 적용된 채움이 하나도 없다(건너뜀만 있다): 바뀐 것이 없으므로 성공으로 알리지 않고 세션도 그대로 둔다
  if (summary.actions.reduce((n, a) => n + a.targets, 0) === 0) return { ok: false, code: "FILL_NOTHING_APPLIED", summary, issues };
  // 게이트를 통과한 바이트만 세션에 반영한다
  store.replace(session, result.output);
  return { ok: true, generation: session.generation, bytes: session.bytes.length, summary, issues };
}

// ── 라우팅 ───────────────────────────────────────────────────────

const SESSION_ROUTE = /^\/api\/session\/([0-9a-f-]{36})\/([a-z]+)$/;
const SESSION_ONLY = /^\/api\/session\/([0-9a-f-]{36})$/;

export function handleApi(store: SessionStore, req: ApiRequest): ApiResponse {
  try {
    if (req.pathname === "/api/fixtures" && req.method === "GET") return json({ names: listFixtures() } satisfies FixtureList);
    if (req.pathname === "/api/open" && req.method === "POST") return open(store, req);

    const only = SESSION_ONLY.exec(req.pathname);
    const route = SESSION_ROUTE.exec(req.pathname);
    const id = only?.[1] ?? route?.[1];
    if (id === undefined) return failure(404, "NOT_FOUND", "그런 API가 없습니다.");
    const session = store.get(id);
    if (session === undefined) return failure(404, "SESSION_NOT_FOUND", "세션이 없습니다(서버가 다시 시작됐거나 닫았습니다).");

    if (only !== null) {
      if (req.method !== "DELETE") return failure(405, "METHOD_NOT_ALLOWED", "DELETE만 받습니다.");
      store.close(id);
      return json({ closed: true });
    }
    const action = route?.[2];
    if (action === "bytes" && req.method === "GET") {
      return { status: 200, contentType: "application/octet-stream", body: session.bytes, headers: { "X-Generation": String(session.generation) } };
    }
    if (action === "download" && req.method === "GET") {
      return {
        status: 200,
        contentType: "application/hwp+zip",
        body: session.bytes,
        headers: { "Content-Disposition": 'attachment; filename="result.hwpx"', "X-Generation": String(session.generation) },
      };
    }
    if (action === "marks" && req.method === "GET") return json(marks(session));
    if (action === "locate" && req.method === "POST") return json(locate(session.doc, parseJson(req.body)));
    if (action === "fill" && req.method === "POST") return json(fill(session, store, parseJson(req.body)));
    if (action === "reset" && req.method === "POST") {
      store.reset(session);
      return json(openResponse(session));
    }
    return failure(404, "NOT_FOUND", "그런 API가 없습니다.");
  } catch (e) {
    if (e instanceof HostError) return failure(e.status, e.code, e.message);
    // 문서를 열 수 없거나(PKG_·XML_·MODEL_) 템플릿·값이 틀린 경우: 엔진의 코드를 그대로 알린다
    if (e instanceof HwpxError) return failure(400, e.code, e.message);
    return failure(500, "INTERNAL", "서버 내부 오류입니다.");
  }
}
