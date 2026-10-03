// 위치 요청 하나를 엔진 주소와 앵커 초안, 강조 구간으로 바꾼다. 문서(`HwpxDocument`)는 부르는 쪽 호스트가 갖는다.
import { draftAnchors, type AnchorDraft, type DraftedAnchor, type HwpxDocument } from "../../../hwpx-engine/src/index.ts";
import { locateInCell, locatePicked, type LocateEdge, type Located, type Unlocated } from "../map/index.ts";
import { sameParagraph } from "../rhwp/layout.ts";
import { HostError } from "./errors.ts";
import { markOf, resolveDrafts } from "./marks.ts";
import { isObj, parsePoint } from "./request.ts";
import type { AnchorDraftJson, DraftView, LocateResponse } from "./types.ts";

const toJson = (d: AnchorDraft): AnchorDraftJson => d;

type Result = Located | Unlocated;

/** 위치 결과가 가리키는 자리의 앵커 초안과 강조 구간. 위치가 없으면 빈 목록. */
export function draftsFor(doc: HwpxDocument, result: Result, range?: { start: number; end: number }): DraftView[] {
  if (result.precision === "none") return [];
  const { sectionIndex, path } = result.address;
  let drafts: DraftedAnchor[];
  if (result.precision === "paragraph") drafts = draftAnchors(doc, { sectionIndex, path });
  else {
    const start = range?.start ?? result.address.offset;
    const request = start === undefined ? { sectionIndex, path } : range === undefined ? { sectionIndex, path, start } : { sectionIndex, path, start, end: range.end };
    drafts = draftAnchors(doc, request);
  }
  const anchors = drafts.map((draft) => {
    // `blocked`는 템플릿 앵커의 키가 아니므로 앵커에서 떼어 따로 준다(채울 때 앵커만 돌려보낸다)
    const { blocked: _blocked, ...anchor } = draft;
    return anchor;
  });
  const found = resolveDrafts(doc, anchors);
  return drafts.map((draft, i) => {
    const { blocked } = draft;
    const anchor = anchors[i] as AnchorDraft;
    const mark = markOf(doc, anchor, found[i]);
    const view: DraftView = { anchor: toJson(anchor) };
    if (mark !== undefined) view.mark = mark;
    if (blocked !== undefined) view.blocked = blocked;
    return view;
  });
}

function respond(doc: HwpxDocument, result: Result, edge: LocateEdge, range?: { start: number; end: number }): LocateResponse {
  const out: LocateResponse = { precision: result.precision, trail: result.trail, edge, drafts: draftsFor(doc, result, range) };
  if (result.reason !== undefined) out.reason = result.reason;
  if (result.address !== undefined) out.address = result.address;
  if (range !== undefined) out.range = range;
  return out;
}

/**
 * 위치 요청(`LocateRequest`)을 푼다. 본문이 틀리면 `HostError`(400)다.
 * 표 칸의 빈 곳이면 칸을 엔진 표·행·열로 찾고, 같은 문단 안 범위(`to`)이면 범위 `word` 초안을 낸다. 여러 문단에 걸친 선택은 받지 않는다.
 */
export function locate(doc: HwpxDocument, body: unknown): LocateResponse {
  if (!isObj(body) || !isObj(body["from"])) throw new HostError(400, "BAD_REQUEST", "본문은 { from: { position? 또는 cell, shown?, guide?, limit?, reason? }, to? }이어야 합니다.");
  const parsedFrom = parsePoint(body["from"]);
  // 표 칸의 빈 곳: 칸은 엔진 표·행·열로 찾고, 위치가 있으면 그 런의 문단이 이 칸의 것인지 맞대어 본다
  // (문단까지만 믿는 시작점에서 끈 범위도 문단 단위이므로 `to`는 쓰지 않는다)
  if (parsedFrom.cell !== undefined) return respond(doc, locateInCell(doc, parsedFrom.cell), "start");
  const from = parsedFrom.point;
  if (from === undefined) throw new HostError(400, "BAD_POSITION", "위치(position)가 없습니다.");
  const to = body["to"] === undefined ? undefined : parsePoint(body["to"]).point;
  if (body["to"] !== undefined && to === undefined) throw new HostError(400, "BAD_POSITION", "to에는 위치(position)가 있어야 합니다.");

  // 같은 문단 안의 범위만 받는다(여러 문단에 걸친 선택은 이 시험 구현의 범위 밖)
  if (to !== undefined && !sameParagraph(from.position, to.position)) {
    return { precision: "none", reason: "RANGE_PARAGRAPHS_DIFFER", trail: [], edge: "start", drafts: [] };
  }
  // 안내문을 눌렀거나 끝이 없으면 한 점이다
  if (to === undefined || from.guide !== undefined || to.guide !== undefined) {
    const edge: LocateEdge = from.guide !== undefined ? "guide" : from.trailing === true ? "trail" : "start";
    return respond(doc, locatePicked(doc, from, edge), edge);
  }
  // 두 끝의 순서는 rhwp 글자 순번(런마다 기준이 다를 수 있다)이 아니라 엔진 오프셋으로 가른다
  const first = locatePicked(doc, from, "start");
  const second = locatePicked(doc, to, "start");
  if (first.precision !== "char" || second.precision !== "char") {
    // 어느 한쪽이라도 글자까지 확인하지 못했으면 범위를 버리고 문단 단위로 내린다
    const worst = first.precision === "none" ? first : second.precision === "none" ? second : first.precision === "paragraph" ? first : second;
    return respond(doc, worst, "start");
  }
  const a = first.address.offset ?? 0;
  const b = second.address.offset ?? 0;
  if (a === b) return respond(doc, first, "start");
  const [hi, loResult] = a < b ? [to, first] : [from, second];
  const end = locatePicked(doc, hi, "end");
  const start = loResult.address?.offset ?? 0;
  const stop = end.address?.offset ?? 0;
  if (end.precision !== "char" || stop <= start) return respond(doc, loResult, "start");
  return respond(doc, loResult, "start", { start, end: stop });
}
