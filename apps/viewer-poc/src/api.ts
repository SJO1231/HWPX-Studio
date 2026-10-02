// 서버의 JSON API. 문서 바이트·파싱·위치 변환·앵커 초안·채움은 모두 이 호스트가 하고, 브라우저는 표시용 바이트만 받는다.
import { readFileSync } from "node:fs";
import {
  HwpxError,
  draftAnchors,
  emptyTemplate,
  findCandidates,
  generate,
  readDataset,
  readTemplate,
  resolveAnchors,
  type Anchor,
  type AnchorDraft,
  type DraftedAnchor,
  type Issue,
  type ResolvedAnchor,
} from "../../../packages/hwpx-engine/src/index.ts";
import {
  locateInCell,
  locatePicked,
  offsetTable,
  paragraphAtAddress,
  rhwpOffsetAt,
  toRhwpPosition,
  type CellRef,
  type CellStep,
  type LocateEdge,
  type Located,
  type PickedPoint,
  type RhwpPosition,
  type Shown,
  type Unlocated,
} from "../../../packages/viewer/src/map/index.ts";
import { sameParagraph } from "../../../packages/viewer/src/rhwp/layout.ts";
import type {
  AnchorDraftJson,
  DraftView,
  FillRequest,
  FillResponse,
  FillSummary,
  FixtureList,
  IssueJson,
  LocateResponse,
  MarkRange,
  MarksResponse,
  OpenResponse,
  ServerMark,
} from "./api-types.ts";
import { listFixtures, resolveFixture } from "./files.ts";
import type { Session, SessionStore } from "./sessions.ts";

export type ApiRequest = { method: string; pathname: string; query: URLSearchParams; contentType: string; body: Uint8Array };
export type ApiResponse = { status: number; contentType: string; body: string | Uint8Array; headers?: Record<string, string> };

/** 올린 문서의 최대 크기 */
export const MAX_UPLOAD = 64 * 1024 * 1024;

class ApiFail extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (body: unknown, status = 200): ApiResponse => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
const failure = (status: number, code: string, message: string): ApiResponse => json({ error: { code, message } }, status);

// ── 입력 검사 ────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 2 ** 32;

function parseStep(v: unknown): CellStep {
  if (!isObj(v) || !isInt(v["controlIndex"]) || !isInt(v["cellIndex"]) || !isInt(v["cellParaIndex"])) throw new ApiFail(400, "BAD_POSITION", "cellPath의 단계가 올바르지 않습니다.");
  return { controlIndex: v["controlIndex"], cellIndex: v["cellIndex"], cellParaIndex: v["cellParaIndex"] };
}

function parsePosition(v: unknown): RhwpPosition {
  if (!isObj(v) || !isInt(v["sectionIndex"]) || !isInt(v["paragraphIndex"]) || !isInt(v["charOffset"])) {
    throw new ApiFail(400, "BAD_POSITION", "위치는 sectionIndex·paragraphIndex·charOffset(0 이상 정수)을 가져야 합니다.");
  }
  const pos: RhwpPosition = { sectionIndex: v["sectionIndex"], paragraphIndex: v["paragraphIndex"], charOffset: v["charOffset"] };
  if (v["cellPath"] !== undefined) {
    if (!Array.isArray(v["cellPath"]) || v["cellPath"].length === 0 || v["cellPath"].length > 64 || !isInt(v["parentParaIndex"])) {
      throw new ApiFail(400, "BAD_POSITION", "cellPath는 비어 있지 않은 배열이어야 하고 parentParaIndex가 있어야 합니다.");
    }
    pos.parentParaIndex = v["parentParaIndex"];
    pos.cellPath = v["cellPath"].map(parseStep);
  }
  return pos;
}

function parseShown(v: unknown): Shown | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v) || typeof v["text"] !== "string" || !isInt(v["start"]) || v["text"].length > 100_000) throw new ApiFail(400, "BAD_SHOWN", "shown은 { text, start }여야 합니다.");
  return { text: v["text"], start: v["start"] };
}

function parseCell(v: unknown): CellRef {
  const steps = isObj(v) ? v["steps"] : undefined;
  if (!isObj(v) || !isInt(v["sectionIndex"]) || !Array.isArray(steps) || steps.length === 0 || steps.length > 16) {
    throw new ApiFail(400, "BAD_CELL", "cell은 sectionIndex와 비어 있지 않은 steps(표 경로)를 가져야 합니다.");
  }
  const cell: CellRef = {
    sectionIndex: v["sectionIndex"],
    steps: steps.map((s) => {
      if (!isObj(s) || !isInt(s["paragraph"]) || !isInt(s["control"]) || !isInt(s["row"]) || !isInt(s["col"])) {
        throw new ApiFail(400, "BAD_CELL", "표 경로의 단계는 paragraph·control·row·col(0 이상 정수)을 가져야 합니다.");
      }
      return { paragraph: s["paragraph"], control: s["control"], row: s["row"], col: s["col"] };
    }),
  };
  const runs = v["runs"];
  if (runs !== undefined) {
    if (!Array.isArray(runs) || runs.length > 32) throw new ApiFail(400, "BAD_CELL", "cell.runs는 32개 이하의 배열이어야 합니다.");
    cell.runs = runs.map((r) => {
      const shown = isObj(r) ? parseShown(r["shown"]) : undefined;
      if (!isObj(r) || shown === undefined) throw new ApiFail(400, "BAD_CELL", "cell.runs의 항목은 { position, shown }이어야 합니다.");
      return { position: parsePosition(r["position"]), shown };
    });
  }
  return cell;
}

/** 눌린 점 하나: 위치와 확인할 런, 그리고 뷰어 화면이 정한 한계(`limit`·`reason`)와 안내문 글(`guide`). 표 칸의 빈 곳이면 눌린 칸(`cell`, 줄 후보 포함)만 있고 위치는 없다. */
type ParsedPoint = { point?: PickedPoint; cell?: CellRef };

function parsePoint(v: unknown): ParsedPoint {
  if (!isObj(v)) throw new ApiFail(400, "BAD_REQUEST", "위치 항목이 올바르지 않습니다.");
  const parsed: ParsedPoint = {};
  if (v["cell"] !== undefined) parsed.cell = parseCell(v["cell"]);
  // 칸이 있으면 칸만 받는다(줄 후보가 칸 안에 들어 있다): 위치에 딸린 나머지 항목은 뜻이 없다
  if (parsed.cell !== undefined) return parsed;
  const point: PickedPoint = { position: parsePosition(v["position"]) };
  const shown = parseShown(v["shown"]);
  if (shown !== undefined) point.shown = shown;
  const guide = v["guide"];
  if (guide !== undefined) {
    if (typeof guide !== "string" || guide === "" || guide.length > 10_000) throw new ApiFail(400, "BAD_GUIDE", "guide는 눌린 안내문 글(비어 있지 않은 문자열)이어야 합니다.");
    point.guide = guide;
  }
  const trailing = v["trailing"];
  if (trailing !== undefined) {
    if (typeof trailing !== "boolean") throw new ApiFail(400, "BAD_TRAILING", "trailing은 불리언이어야 합니다.");
    if (trailing) point.trailing = true;
  }
  const limit = v["limit"];
  if (limit !== undefined) {
    if (limit !== "char" && limit !== "paragraph") throw new ApiFail(400, "BAD_LIMIT", "limit은 char 또는 paragraph여야 합니다.");
    point.limit = limit;
  }
  const reason = v["reason"];
  if (reason !== undefined) {
    if (typeof reason !== "string" || !/^[A-Z_]{1,64}$/.test(reason)) throw new ApiFail(400, "BAD_REASON", "reason은 대문자와 밑줄로 된 사유 코드여야 합니다.");
    point.reason = reason;
  }
  parsed.point = point;
  return parsed;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new ApiFail(400, "BAD_JSON", "본문이 JSON이 아닙니다.");
  }
}

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
    if (req.body.length === 0) throw new ApiFail(400, "EMPTY_UPLOAD", "빈 파일입니다.");
    return json(openResponse(store.open("올린 파일", new Uint8Array(req.body))));
  }
  const body = parseJson(req.body);
  if (!isObj(body) || typeof body["fixture"] !== "string") throw new ApiFail(400, "BAD_REQUEST", "본문은 { fixture: 이름 }이어야 합니다.");
  // 목록(`/api/fixtures`)에 있는 이름과 글자 그대로 같을 때만 연다(Windows의 파일 시스템은 대소문자를 가리지 않으므로 목록으로 먼저 가른다)
  const file = listFixtures().includes(body["fixture"]) ? resolveFixture(body["fixture"]) : undefined;
  if (file === undefined) throw new ApiFail(404, "FIXTURE_NOT_FOUND", "그런 시험 문서가 없습니다.");
  return json(openResponse(store.open(body["fixture"], new Uint8Array(readFileSync(file)))));
}

// ── 위치 변환과 앵커 초안 ────────────────────────────────────────

const toJson = (d: AnchorDraft): AnchorDraftJson => d;

type Result = Located | Unlocated;

function draftsFor(session: Session, result: Result, range?: { start: number; end: number }): DraftView[] {
  if (result.precision === "none") return [];
  const { sectionIndex, path } = result.address;
  let drafts: DraftedAnchor[];
  if (result.precision === "paragraph") drafts = draftAnchors(session.doc, { sectionIndex, path });
  else {
    const start = range?.start ?? result.address.offset;
    const request = start === undefined ? { sectionIndex, path } : range === undefined ? { sectionIndex, path, start } : { sectionIndex, path, start, end: range.end };
    drafts = draftAnchors(session.doc, request);
  }
  const anchors = drafts.map((draft) => {
    // `blocked`는 템플릿 앵커의 키가 아니므로 앵커에서 떼어 따로 준다(채울 때 앵커만 돌려보낸다)
    const { blocked: _blocked, ...anchor } = draft;
    return anchor;
  });
  const found = resolveDrafts(session, anchors);
  return drafts.map((draft, i) => {
    const { blocked } = draft;
    const anchor = anchors[i] as AnchorDraft;
    const mark = markOf(session, anchor, found[i]);
    const view: DraftView = { anchor: toJson(anchor) };
    if (mark !== undefined) view.mark = mark;
    if (blocked !== undefined) view.blocked = blocked;
    return view;
  });
}

function respond(session: Session, result: Result, edge: LocateEdge, range?: { start: number; end: number }): LocateResponse {
  const out: LocateResponse = { precision: result.precision, trail: result.trail, edge, drafts: draftsFor(session, result, range) };
  if (result.reason !== undefined) out.reason = result.reason;
  if (result.address !== undefined) out.address = result.address;
  if (range !== undefined) out.range = range;
  return out;
}

function locate(session: Session, body: unknown): LocateResponse {
  if (!isObj(body) || !isObj(body["from"])) throw new ApiFail(400, "BAD_REQUEST", "본문은 { from: { position? 또는 cell, shown?, guide?, limit?, reason? }, to? }이어야 합니다.");
  const parsedFrom = parsePoint(body["from"]);
  const doc = session.doc;
  // 표 칸의 빈 곳: 칸은 엔진 표·행·열로 찾고, 위치가 있으면 그 런의 문단이 이 칸의 것인지 맞대어 본다
  // (문단까지만 믿는 시작점에서 끈 범위도 문단 단위이므로 `to`는 쓰지 않는다)
  if (parsedFrom.cell !== undefined) return respond(session, locateInCell(doc, parsedFrom.cell), "start");
  const from = parsedFrom.point;
  if (from === undefined) throw new ApiFail(400, "BAD_POSITION", "위치(position)가 없습니다.");
  const to = body["to"] === undefined ? undefined : parsePoint(body["to"]).point;
  if (body["to"] !== undefined && to === undefined) throw new ApiFail(400, "BAD_POSITION", "to에는 위치(position)가 있어야 합니다.");

  // 같은 문단 안의 범위만 받는다(여러 문단에 걸친 선택은 이 시험 구현의 범위 밖)
  if (to !== undefined && !sameParagraph(from.position, to.position)) {
    return { precision: "none", reason: "RANGE_PARAGRAPHS_DIFFER", trail: [], edge: "start", drafts: [] };
  }
  // 안내문을 눌렀거나 끝이 없으면 한 점이다
  if (to === undefined || from.guide !== undefined || to.guide !== undefined) {
    const edge: LocateEdge = from.guide !== undefined ? "guide" : from.trailing === true ? "trail" : "start";
    return respond(session, locatePicked(doc, from, edge), edge);
  }
  // 두 끝의 순서는 rhwp 글자 순번(런마다 기준이 다를 수 있다)이 아니라 엔진 오프셋으로 가른다
  const first = locatePicked(doc, from, "start");
  const second = locatePicked(doc, to, "start");
  if (first.precision !== "char" || second.precision !== "char") {
    // 어느 한쪽이라도 글자까지 확인하지 못했으면 범위를 버리고 문단 단위로 내린다
    const worst = first.precision === "none" ? first : second.precision === "none" ? second : first.precision === "paragraph" ? first : second;
    return respond(session, worst, "start");
  }
  const a = first.address.offset ?? 0;
  const b = second.address.offset ?? 0;
  if (a === b) return respond(session, first, "start");
  const [hi, loResult] = a < b ? [to, first] : [from, second];
  const end = locatePicked(doc, hi, "end");
  const start = loResult.address?.offset ?? 0;
  const stop = end.address?.offset ?? 0;
  if (end.precision !== "char" || stop <= start) return respond(session, loResult, "start");
  return respond(session, loResult, "start", { start, end: stop });
}

// ── 강조할 자리 ──────────────────────────────────────────────────

/**
 * 앵커 초안들을 엔진의 앵커 해석(`resolveAnchors`: 채움이 앵커를 찾는 것과 같은 규칙)으로 문서에서 찾는다. 입력과 같은 순서이고, 찾지 못한 앵커는 undefined다.
 * 이 서버가 쓰는 앵커는 방금 같은 문서에서 만든 것이라 지문이 맞지만, 해석 규칙을 이쪽에서 다시 구현하지 않는다.
 */
function resolveDrafts(session: Session, anchors: AnchorDraft[]): (ResolvedAnchor | undefined)[] {
  const template = { ...emptyTemplate(), anchors: anchors.map((a, i): Anchor => ({ ...a, id: `t${i}` })) };
  const { anchors: found } = resolveAnchors(session.doc, template);
  return anchors.map((_, i) => found.get(`t${i}`));
}

type Target = { sectionIndex: number; path: number[]; from: number; until: number; guideOf?: boolean };

/** 앵커 초안이 가리키는 문단과 논리 구간. 엔진이 못 찾았거나, 지문으로 다시 찾아 주소가 바뀐(`relocated`) 앵커처럼 주소를 정할 수 없으면 undefined. */
function targetOf(anchor: AnchorDraft, resolved: ResolvedAnchor | undefined): Target | undefined {
  if (resolved === undefined) return undefined;
  if (resolved.kind === "field") {
    // 이름이 같은 누름틀이 여럿이면 첫째(순번을 준 앵커는 하나뿐이다)
    const target = resolved.targets[0];
    const begin = target === undefined ? undefined : target.paragraph.pieces[target.begin.pieceIndex];
    const end = target?.end == null ? undefined : target.paragraph.pieces[target.end.pieceIndex];
    if (target === undefined || begin === undefined || end === undefined) return undefined;
    return { sectionIndex: target.info.sectionIndex, path: target.info.path, from: begin.logicalEnd, until: end.logicalStart, guideOf: true };
  }
  if (resolved.kind === "word" && anchor.kind === "word") return resolved.relocated ? undefined : { ...anchor.at, from: resolved.start, until: resolved.end };
  if (resolved.kind === "line" && anchor.kind === "line") return resolved.relocated ? undefined : { ...anchor.at, from: 0, until: resolved.paragraph.logicalText.length };
  if (resolved.kind === "cell" && anchor.kind === "cell") {
    // 칸의 첫 문단: 구역 최상위 표를 담은 문단 번호, 칸의 하위 목록 번호, 칸 안 첫 문단
    const first = resolved.cell.subList?.paragraphs[0];
    const owner = resolved.section.paragraphs.indexOf(resolved.owner);
    const sub = resolved.cell.subList == null ? -1 : resolved.owner.subLists.indexOf(resolved.cell.subList);
    if (first === undefined || owner < 0 || sub < 0) return undefined;
    return { sectionIndex: anchor.table.sectionIndex, path: [owner, sub, 0], from: 0, until: first.logicalText.length };
  }
  return undefined;
}

/** 앵커 초안의 자리를 쪽 위에 강조할 rhwp 글자 순번 구간으로 옮긴다. 옮길 수 없으면 undefined. */
function markOf(session: Session, anchor: AnchorDraft, resolved: ResolvedAnchor | undefined): MarkRange | undefined {
  const target = targetOf(anchor, resolved);
  if (target === undefined) return undefined;
  const address = { sectionIndex: target.sectionIndex, path: target.path };
  const paragraph = paragraphAtAddress(session.doc, address);
  if (paragraph === undefined) return undefined;
  const table = offsetTable(paragraph);
  const position = toRhwpPosition(session.doc, { ...address, offset: target.from });
  const endOffset = rhwpOffsetAt(table, target.until);
  if (position === undefined || endOffset === undefined) return undefined;
  // 안내문 상태 누름틀: 안내문 글은 글자 칸이 없으므로 안내문이 그려진 사각형을 덮는다
  const guide = target.guideOf === true ? table.guides.find((g) => g.logicalStart === target.from && g.logicalEnd === target.until) : undefined;
  if (guide !== undefined) return { position, endOffset: position.charOffset, guide: guide.text };
  // 글자 구간(낱말·누름틀 값)은 덮어야 할 글을 함께 준다(화면이 쪽 글자 배치와 맞는지 확인하는 데 쓴다). 문단 전체 강조는 순번이 필요 없다
  if (anchor.kind === "word" || anchor.kind === "field") {
    const k1 = position.charOffset;
    return { position, endOffset, text: table.slots.slice(k1, endOffset).map((s) => s.shown).join("") };
  }
  return { position, endOffset };
}

function marks(session: Session): MarksResponse {
  const out: ServerMark[] = [];
  const candidates = findCandidates(session.doc);
  const found = resolveDrafts(session, candidates.map((c) => c.anchor));
  candidates.forEach((c, i) => {
    const mark = markOf(session, c.anchor, found[i]);
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
    throw new ApiFail(400, "BAD_REQUEST", "본문은 { fills: [{ anchor, value }, ...] }이어야 합니다(1~200건).");
  }
  const mode = req.mode === "strict" ? "strict" : "baseline";
  const anchors: unknown[] = [];
  const rules: unknown[] = [];
  req.fills.forEach((f, i) => {
    if (!isObj(f) || !isObj(f.anchor) || typeof f.value !== "string") throw new ApiFail(400, "BAD_REQUEST", `fills[${i}]은 { anchor, value(문자열) }여야 합니다.`);
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
    if (action === "locate" && req.method === "POST") return json(locate(session, parseJson(req.body)));
    if (action === "fill" && req.method === "POST") return json(fill(session, store, parseJson(req.body)));
    if (action === "reset" && req.method === "POST") {
      store.reset(session);
      return json(openResponse(session));
    }
    return failure(404, "NOT_FOUND", "그런 API가 없습니다.");
  } catch (e) {
    if (e instanceof ApiFail) return failure(e.status, e.code, e.message);
    // 문서를 열 수 없거나(PKG_·XML_·MODEL_) 템플릿·값이 틀린 경우: 엔진의 코드를 그대로 알린다
    if (e instanceof HwpxError) return failure(400, e.code, e.message);
    return failure(500, "INTERNAL", "서버 내부 오류입니다.");
  }
}

