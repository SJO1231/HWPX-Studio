import { HwpxError } from "../errors.ts";
import { listFields } from "../model/fields.ts";
import { walkParagraphs } from "../model/paragraph.ts";
import type { Bookmark, FieldInfo, FieldMark, FieldShape, HwpxDocument, ParagraphNode, RunNode, SectionModel } from "../model/types.ts";
import { declsOf, wrapXml } from "../table/wrap.ts";
import { attrNode, elIs, walkElements } from "../xml/tree.ts";
import { addDelta, deltaOfElements, type Delta } from "./census.ts";
import { paragraphAtPath, hasSecPr, isTextPiece, nsPrefixOf, siblingsAtPath } from "./doc.ts";
import { encodeValue, span, valueXml, type Ctx, type Fail, type TextPlan } from "./text.ts";
import type { SpanEdit } from "../edit/plan.ts";

/** 누름틀 하나: 시작·끝 표식과 그 문단. */
export type FieldTarget = {
  section: SectionModel;
  /** 시작 표식을 담은 문단 */
  paragraph: ParagraphNode;
  info: FieldInfo;
  begin: FieldMark;
  /**
   * 끝 표식을 담은 문단. 시작과 같은 문단이면 `paragraph`와 같다.
   * 끝 표식이 없거나(`unpaired`) 다른 컨테이너·구역에 있으면(`crossContainer`) null이다.
   */
  endParagraph: ParagraphNode | null;
  end: FieldMark | null;
};

/** 문서의 누름틀을 `listFields`의 순서와 이름·순번 그대로, 표식과 함께 모은다. */
export function collectFields(doc: HwpxDocument): FieldTarget[] {
  const perParagraph = new Map<string, number>();
  const out: FieldTarget[] = [];
  for (const info of listFields(doc)) {
    const section = doc.sections[info.sectionIndex];
    const paragraph = section === undefined ? undefined : paragraphAtPath(section, info.path);
    if (section === undefined || paragraph === undefined) continue;
    const key = `${info.sectionIndex}:${info.path.join(".")}`;
    const nth = perParagraph.get(key) ?? 0;
    perParagraph.set(key, nth + 1);
    const begin = paragraph.fieldMarks.filter((m) => m.kind === "begin" && (m.type ?? "") !== "HYPERLINK")[nth];
    if (begin === undefined || (begin.name ?? "") !== info.name) continue;
    const from = paragraph.fieldMarks.indexOf(begin);
    let endParagraph: ParagraphNode | null = null;
    if (info.shape === "crossParagraph") endParagraph = (info.endPath === undefined ? undefined : paragraphAtPath(section, info.endPath)) ?? null;
    else if (info.shape !== "unpaired" && info.shape !== "crossContainer") endParagraph = paragraph;
    const marks = endParagraph === null ? [] : endParagraph === paragraph ? paragraph.fieldMarks.slice(from + 1) : endParagraph.fieldMarks;
    const end = marks.find((m) => m.kind === "end" && m.beginIDRef === begin.id) ?? null;
    out.push({ section, paragraph, info, begin, endParagraph, end });
  }
  return out;
}

/**
 * 구간 치환의 결과. 구간은 시작 표식을 담은 조각(`hp:ctrl`)의 끝부터 끝 표식을 담은 조각의 시작까지다(구역 텍스트 오프셋).
 */
export type FieldSpan = {
  start: number;
  end: number;
  /**
   * 구간 치환이 지우는 글의 논리 구간(문단별). 문단 전체가 구간 안인 사이 문단은 담지 않는다(구역 오프셋 `start`~`end` 안이다).
   * 한 문단 안이면 표식 사이, 여러 문단이면 시작 문단의 표식 뒤부터 끝까지와 끝 문단의 처음부터 끝 표식 앞까지다.
   */
  gone: { paragraph: ParagraphNode; from: number; until: number }[];
  /** 이 치환이 더하는 수량(지워지는 문단·표·그림은 음수) */
  delta: Delta;
  /**
   * 구간 안에 통째로 들어 함께 지워지는 `CLICK_HERE`가 아닌 필드(하이퍼링크·날짜 등)와 책갈피(문서 순서). 여러 문단에 걸칠 때만 센다.
   * 구간 안의 누름틀(`CLICK_HERE`)은 여기에 없다(암묵 채움 대상이면 호출자가 따로 `dropped`로 보고하고, 규칙이 가리키면 충돌이다).
   */
  removed: { kind: "field" | "bookmark"; name: string }[];
  /** 끝 표식이 다른 문단에 있어 문단을 합칠 때만 */
  merge?: {
    /** 합쳐져 사라지는 끝 문단 */
    endParagraph: ParagraphNode;
    /** 끝 표식을 담은 조각의 논리 시작(끝 문단 글에서). 합친 문단의 글 = 시작 문단 글(표식까지) + 값 + 끝 문단 글(이 위치부터) */
    endFrom: number;
    /** 시작·끝 문단 사이에 있어 지워지는 문단 수 */
    between: number;
    /** 지워지는 표 수 */
    tables: number;
  };
};

export type FieldFill = TextPlan & { check: { beginStart: number; name: string; value: string; setsDirty: boolean }; span?: FieldSpan };

/** 채울 수 없는 모양의 사유 */
const SHAPE_REASON: Partial<Record<FieldShape, string>> = {
  unpaired: "끝 표식이 없습니다.",
  object: "시작과 끝 사이에 그림·표 같은 개체가 있습니다.",
  crossContainer: "끝 표식이 시작과 다른 칸·표·구역에 있습니다.",
};

export function fieldShapeError(shape: FieldShape): Fail {
  return { fail: { code: "FIELD_UNSUPPORTED_SHAPE", message: `누름틀의 모양(${shape})은 채울 수 없습니다. ${SHAPE_REASON[shape] ?? ""}`.trim() } };
}

const unsupported = (message: string): Fail["fail"] => ({ code: "FIELD_UNSUPPORTED_SHAPE", message });

const marksCache = new WeakMap<SectionModel, FieldMark[]>();
/** 구역의 모든 필드 표식(문단 안 하위 목록 포함, 문서 순서). */
function marksOf(section: SectionModel): FieldMark[] {
  let marks = marksCache.get(section);
  if (marks === undefined) {
    marks = [];
    for (const p of walkParagraphs(section.paragraphs)) marks.push(...p.fieldMarks);
    marksCache.set(section, marks);
  }
  return marks;
}

const bookmarksCache = new WeakMap<SectionModel, Bookmark[]>();
/** 구역의 모든 책갈피(문단 안 하위 목록 포함, 문서 순서). */
function bookmarksOf(section: SectionModel): Bookmark[] {
  let list = bookmarksCache.get(section);
  if (list === undefined) {
    list = [];
    for (const p of walkParagraphs(section.paragraphs)) list.push(...p.bookmarks);
    list.sort((a, b) => a.element.start - b.element.start);
    bookmarksCache.set(section, list);
  }
  return list;
}

/** 형광펜·변경 추적(삽입·삭제) 표식: `hp:t` 안의 짝 요소(`markpenBegin`/`markpenEnd`, `insertBegin`/`insertEnd`, `deleteBegin`/`deleteEnd`) */
type PairMark = { kind: string; open: boolean; start: number; end: number };
const PAIR_MARK = /^<(?:[^\s:<>/]+:)?(markpen|insert|delete)(Begin|End)(?=[\s/>])/;
const pairMarksCache = new WeakMap<SectionModel, PairMark[]>();
/** 구역의 형광펜·변경 추적 표식(구역 텍스트 오프셋 순서). 모델이 `inline` 조각으로 보는 요소 가운데 짝이 있는 것만 모은다. */
function pairMarksOf(section: SectionModel): PairMark[] {
  let list = pairMarksCache.get(section);
  if (list === undefined) {
    list = [];
    for (const p of walkParagraphs(section.paragraphs)) {
      for (const piece of p.pieces) {
        if (piece.kind !== "inline") continue;
        const m = PAIR_MARK.exec(section.text.slice(piece.start, piece.start + 48));
        if (m !== null) list.push({ kind: m[1] ?? "", open: m[2] === "Begin", start: piece.start, end: piece.end });
      }
    }
    list.sort((a, b) => a.start - b.start);
    pairMarksCache.set(section, list);
  }
  return list;
}

/** 구간 `[from, to]`(구역 텍스트 오프셋) 안에 짝이 구간 밖으로 이어지는(짝 없는) 형광펜·변경 추적 표식이 있는가. 짝이 구간 안에서 맞으면 아니다. */
function strayPairMark(section: SectionModel, from: number, to: number): boolean {
  const depth = new Map<string, number>();
  for (const m of pairMarksOf(section)) {
    if (m.start < from || m.end > to) continue;
    const d = depth.get(m.kind) ?? 0;
    if (m.open) depth.set(m.kind, d + 1);
    else if (d === 0) return true;
    else depth.set(m.kind, d - 1);
  }
  return [...depth.values()].some((d) => d > 0);
}

/** 구간 `[from, to]` 안에 통째로 든 필드 표식 */
const marksBetween = (section: SectionModel, from: number, to: number): FieldMark[] => marksOf(section).filter((m) => m.element.start >= from && m.element.end <= to);

/** 시작 문단에서 `from`(구역 텍스트 오프셋) 뒤에 구역 설정(`secPr`)이 있는가 */
const secPrAfter = (p: ParagraphNode, from: number): boolean => {
  for (const el of walkElements(p.element)) if (elIs(el, "paragraph", "secPr") && el.start >= from) return true;
  return false;
};

/**
 * 여러 문단에 걸친 누름틀(`crossParagraph`)을 채울 수 없는 사유. 채울 수 있으면 undefined.
 * 지워지는 구간에 구역 설정이 있거나, 구간 안에서 시작·끝나는 다른 필드의 짝이 구간 밖으로 이어져 있으면 채우지 않는다.
 * 지워지는 부분(시작 문단의 표식 뒤, 사이 문단, 끝 문단의 표식 앞)의 표·그림·책갈피·쪽 번호 같은 개체는 한컴처럼 함께 지운다(한컴 COM으로 확인).
 */
function crossBlock(target: FieldTarget, first: ParagraphNode, last: ParagraphNode, begin: FieldMark, end: FieldMark): Fail["fail"] | undefined {
  const list = siblingsAtPath(target.section, first.path);
  const i = first.path[first.path.length - 1];
  const j = last.path[last.path.length - 1];
  const from = first.pieces[begin.pieceIndex]?.end;
  const to = last.pieces[end.pieceIndex]?.start;
  if (list === undefined || i === undefined || j === undefined || list[i] !== first || list[j] !== last || j <= i || from === undefined || to === undefined) {
    return fieldShapeError(target.info.shape).fail;
  }
  if (secPrAfter(first, from) || list.slice(i + 1, j + 1).some(hasSecPr)) {
    return unsupported("사이 문단이나 끝 문단에 구역 설정이 있어 채울 수 없습니다.");
  }
  const inside = marksBetween(target.section, from, to);
  const begins = new Set(inside.filter((m) => m.kind === "begin").map((m) => m.id));
  const refs = new Set(inside.flatMap((m) => (m.kind === "end" && m.beginIDRef !== undefined ? [m.beginIDRef] : [])));
  if (inside.some((m) => (m.kind === "begin" ? !refs.has(m.id) : m.beginIDRef === undefined || !begins.has(m.beginIDRef)))) {
    return unsupported("지워지는 구간 안에서 시작하거나 끝나는 다른 필드의 짝이 구간 밖으로 이어져 있어 채울 수 없습니다.");
  }
  return undefined;
}

/**
 * 이 누름틀을 값으로 채울 수 없는 사유(모양이 `simple`·`empty`·`inline`·`crossParagraph`가 아니거나, 끝 표식이 없거나, 시작·끝이 같은 조각이거나,
 * 지워질 구간에 구역 설정이 있거나 다른 필드의 짝이 끊기거나, 짝이 구간 밖으로 이어지는 형광펜·변경 추적 표식이 있다). 채울 수 있으면 undefined.
 * 채움(`planFieldFill`)과 앵커 초안(`draftAnchors`: 채울 수 없는 모양의 누름틀은 `field` 초안을 만들지 않는다)이 같은 판단을 쓴다.
 */
export function fieldFillBlock(target: FieldTarget): Fail["fail"] | undefined {
  const { info, paragraph, endParagraph, begin, end } = target;
  const supported = info.shape === "simple" || info.shape === "empty" || info.shape === "inline" || info.shape === "crossParagraph";
  if (!supported || end === null || endParagraph === null || (endParagraph === paragraph && begin.pieceIndex === end.pieceIndex)) return fieldShapeError(info.shape).fail;
  if (info.shape === "crossParagraph") {
    const block = crossBlock(target, paragraph, endParagraph, begin, end);
    if (block !== undefined) return block;
  }
  if (info.shape === "inline" || info.shape === "crossParagraph") {
    const from = paragraph.pieces[begin.pieceIndex]?.end;
    const to = endParagraph.pieces[end.pieceIndex]?.start;
    if (from !== undefined && to !== undefined && strayPairMark(target.section, from, to)) {
      return unsupported("강조·변경 추적 표식이 누름틀 경계에 걸쳐 있음 — 구간 안 표식의 짝이 구간 밖으로 이어져 채울 수 없습니다.");
    }
  }
  return undefined;
}

/**
 * 문단 `p`에서 이 누름틀의 글이 차지하는 논리 구간 `[from, until]`. 이 문단이 누름틀의 글에 들어 있지 않으면 undefined.
 * 한 문단 안 누름틀은 시작·끝 표식 사이, 여러 문단에 걸친 누름틀은 시작 문단의 표식 뒤부터 끝까지, 사이 문단 전부, 끝 문단의 처음부터 끝 표식 앞까지다.
 * (채울 수 있는 모양의 누름틀에 쓴다.)
 */
export function fieldRangeIn(target: FieldTarget, p: ParagraphNode): { from: number; until: number } | undefined {
  const { paragraph, endParagraph, begin, end } = target;
  const bp = paragraph.pieces[begin.pieceIndex];
  if (bp === undefined || end === null || endParagraph === null) return undefined;
  const ep = endParagraph.pieces[end.pieceIndex];
  if (ep === undefined) return undefined;
  if (endParagraph === paragraph) return p === paragraph ? { from: bp.logicalEnd, until: ep.logicalStart } : undefined;
  if (p === paragraph) return { from: bp.logicalEnd, until: p.logicalText.length };
  if (p === endParagraph) return { from: 0, until: ep.logicalStart };
  const list = siblingsAtPath(target.section, paragraph.path);
  const i = paragraph.path[paragraph.path.length - 1] ?? -1;
  const j = endParagraph.path[endParagraph.path.length - 1] ?? -1;
  return list !== undefined && list.slice(i + 1, j).includes(p) ? { from: 0, until: p.logicalText.length } : undefined;
}

/** 시작 요소의 `dirty`를 `"1"`로 하는 편집(이미 `"1"`이면 없다). */
function dirtyEdit(ctx: Ctx, begin: FieldMark, reason: string): SpanEdit | undefined {
  const dirty = attrNode(begin.element, "dirty");
  if (dirty === undefined) {
    const at = begin.element.end === begin.element.openEnd ? begin.element.openEnd - 2 : begin.element.openEnd - 1;
    return span(ctx, at, at, ' dirty="1"', `${reason}: dirty 설정`);
  }
  return dirty.value !== "1" ? span(ctx, dirty.valueStart, dirty.valueEnd, "1", `${reason}: dirty 설정`) : undefined;
}

/**
 * `inline`·`crossParagraph` 누름틀을 채운다: 시작 표식을 담은 조각의 끝부터 끝 표식을 담은 조각의 시작까지를 하나의 구간으로 보고
 * `<hp:t>값</hp:t>`로 통째로 바꾼다(값이 비면 지우기만 한다). 사이의 글·줄바꿈·탭·문단(표가 든 문단 포함)과 시작 문단 꼬리·끝 문단 머리의 개체(표·그림·책갈피·쪽 번호 등)가
 * 사라지고 끝 표식 뒤의 글이 시작 문단에 이어 붙는다.
 * 값은 시작 표식이 든 run에 들어가 그 글자모양을 받는다. 끝 표식이 든 run의 여는 태그가 시작 run과 다르면(글자모양이 다르면) 그 run을 다시 열어
 * 끝 표식 뒤의 글이 제 글자모양을 지키게 한다.
 */
function planSpanFill(ctx: Ctx, target: FieldTarget, endParagraph: ParagraphNode, end: FieldMark, value: string, reason: string): FieldFill | Fail {
  const { section, paragraph: par, begin, info } = target;
  const beginPiece = par.pieces[begin.pieceIndex];
  const endPiece = endParagraph.pieces[end.pieceIndex];
  const startRun = beginPiece === undefined ? undefined : par.runs[beginPiece.runOrdinal];
  const endRun = endPiece === undefined ? undefined : endParagraph.runs[endPiece.runOrdinal];
  if (beginPiece === undefined || endPiece === undefined || startRun === undefined || endRun === undefined || endPiece.start < beginPiece.end) return fieldShapeError(info.shape);

  const prefix = nsPrefixOf(begin.element);
  const tag = `${prefix}t`;
  const openTag = (r: RunNode): string => ctx.text.slice(r.element.start, r.element.openEnd);
  const reopen = startRun !== endRun && openTag(startRun) !== openTag(endRun) ? `</${startRun.element.qname}>${openTag(endRun)}` : "";
  const replacement = (value === "" ? "" : `<${tag}>${valueXml(value, prefix)}</${tag}>`) + reopen;

  // 수량 증감: 문단들의 원문 구간과 치환한 결과를 읽어 센 수량의 차이(지워지는 문단·표·그림·필드·책갈피가 모두 센다)
  const regionStart = par.element.start;
  const regionEnd = endParagraph.element.end;
  const before = ctx.text.slice(regionStart, regionEnd);
  const after = ctx.text.slice(regionStart, beginPiece.end) + replacement + ctx.text.slice(endPiece.start, regionEnd);
  let delta: Delta;
  try {
    const decls = declsOf(section.root);
    delta = addDelta(deltaOfElements([wrapXml(after, decls).root], ctx.entry, 1), deltaOfElements([wrapXml(before, decls).root], ctx.entry, -1));
  } catch (e) {
    if (!(e instanceof HwpxError)) throw e;
    return { fail: unsupported(`누름틀의 구간을 바꾼 결과를 읽을 수 없어 채울 수 없습니다: ${e.message}`) };
  }

  const gone: FieldSpan["gone"] =
    endParagraph === par
      ? [{ paragraph: par, from: beginPiece.logicalEnd, until: endPiece.logicalStart }]
      : [
          { paragraph: par, from: beginPiece.logicalEnd, until: par.logicalText.length },
          { paragraph: endParagraph, from: 0, until: endPiece.logicalStart },
        ];
  const removed: FieldSpan["removed"] = [];
  if (endParagraph !== par) {
    // 구간 안에 통째로 든 CLICK_HERE가 아닌 필드와 책갈피(`fieldFillBlock`이 짝이 끊기는 필드를 이미 거른다)
    for (const m of marksBetween(section, beginPiece.end, endPiece.start)) {
      if (m.kind === "begin" && m.type !== "CLICK_HERE") removed.push({ kind: "field", name: m.name !== undefined && m.name !== "" ? m.name : (m.type ?? "") });
    }
    for (const b of bookmarksOf(section)) if (b.element.start >= beginPiece.end && b.element.end <= endPiece.start) removed.push({ kind: "bookmark", name: b.name });
  }
  const fieldSpan: FieldSpan = { start: beginPiece.end, end: endPiece.start, gone, delta, removed };
  const plan: FieldFill = {
    edits: [span(ctx, beginPiece.end, endPiece.start, replacement, reason)],
    repls: [],
    check: { beginStart: begin.element.start, name: info.name, value, setsDirty: value !== "" },
    span: fieldSpan,
  };
  if (endParagraph === par) {
    plan.repls.push({ start: beginPiece.logicalEnd, end: endPiece.logicalStart, text: value });
  } else {
    // 시작 문단의 글은 표식 뒤부터 끝까지를 값으로 바꾸고, 끝 문단의 글(끝 표식부터)은 합친 뒤 이어 붙는다(`merge.endFrom`)
    plan.repls.push({ start: beginPiece.logicalEnd, end: par.logicalText.length, text: value });
    const i = par.path[par.path.length - 1] ?? 0;
    const j = endParagraph.path[endParagraph.path.length - 1] ?? 0;
    fieldSpan.merge = { endParagraph, endFrom: endPiece.logicalStart, between: j - i - 1, tables: -delta.tables };
  }
  const dirty = value === "" ? undefined : dirtyEdit(ctx, begin, reason);
  if (dirty !== undefined) plan.edits.push(dirty);
  return plan;
}

/**
 * 누름틀에 값을 넣는다(안내문과 비교하지 않는다).
 * - `simple`: 시작과 끝 사이 첫 글 조각에 값을 넣고 나머지 글 조각은 비운다.
 * - `empty`: 시작 컨트롤 바로 뒤에 `hp:t`를 넣는다.
 * - `inline`(탭·줄바꿈이 든 것)·`crossParagraph`(여러 문단에 걸친 것): 구간 치환(`planSpanFill`).
 * - 값이 비어 있지 않으면 시작 요소의 `dirty`를 `"1"`로 한다. `dirty`가 `"1"`이 아니던(안내문 상태) `simple` 누름틀은
 *   시작 run과 끝 run 사이 run들의 글자모양을 시작 컨트롤이 든 run의 것으로 바꾼다. 빈 값이면 둘 다 건드리지 않는다.
 */
export function planFieldFill(ctx: Ctx, target: FieldTarget, value: string, reason: string): FieldFill | Fail {
  const { paragraph: par, begin, end, info } = target;
  const block = fieldFillBlock(target);
  if (block !== undefined || end === null || target.endParagraph === null) return { fail: block ?? fieldShapeError(info.shape).fail };
  if (info.shape === "inline" || info.shape === "crossParagraph") return planSpanFill(ctx, target, target.endParagraph, end, value, reason);
  const beginPiece = par.pieces[begin.pieceIndex];
  const endPiece = par.pieces[end.pieceIndex];
  if (beginPiece === undefined || endPiece === undefined) return fieldShapeError(info.shape);

  const plan: FieldFill = {
    edits: [],
    repls: [],
    check: { beginStart: begin.element.start, name: info.name, value, setsDirty: value !== "" },
  };
  const texts = par.pieces.slice(begin.pieceIndex + 1, end.pieceIndex).filter(isTextPiece);
  const prefix = nsPrefixOf(begin.element);
  if (info.shape === "simple") {
    texts.forEach((piece, i) => {
      const text = i === 0 ? value : "";
      plan.edits.push(span(ctx, piece.start, piece.end, encodeValue(ctx, piece, text, prefix), reason));
      plan.repls.push({ start: piece.logicalStart, end: piece.logicalEnd, text });
    });
  } else if (value !== "") {
    const tag = `${prefix}t`;
    plan.edits.push(span(ctx, beginPiece.end, beginPiece.end, `<${tag}>${valueXml(value, prefix)}</${tag}>`, reason));
    plan.repls.push({ start: beginPiece.logicalEnd, end: beginPiece.logicalEnd, text: value });
  }

  if (value !== "") {
    const dirty = dirtyEdit(ctx, begin, reason);
    if (dirty !== undefined) plan.edits.push(dirty);
    if (begin.dirty !== "1") {
      const startRun = par.runs[beginPiece.runOrdinal];
      for (let n = beginPiece.runOrdinal + 1; n < endPiece.runOrdinal; n++) {
        const run = par.runs[n];
        const attr = run === undefined ? undefined : attrNode(run.element, "charPrIDRef");
        if (startRun?.charPrIDRef == null || attr === undefined || attr.value === startRun.charPrIDRef) continue;
        plan.edits.push(span(ctx, attr.valueStart, attr.valueEnd, startRun.charPrIDRef, `${reason}: 안내문 글자모양을 시작 컨트롤의 것으로`));
      }
    }
  }
  return plan;
}
