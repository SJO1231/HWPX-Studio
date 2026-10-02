import type { SpanEdit } from "../edit/plan.ts";
import { clusterBoundaries } from "../model/clusters.ts";
import type { ParagraphNode, Piece } from "../model/types.ts";
import { escapeText } from "../xml/chars.ts";
import { childEls } from "../xml/tree.ts";
import { contentObjects, isTextPiece, nsPrefixOf, type Repl } from "./doc.ts";

/** 편집 대상 구역 파일 하나: 항목 이름과 그 텍스트(편집 오프셋의 기준). */
export type Ctx = { entry: string; text: string };

export type TextPlan = { edits: SpanEdit[]; repls: Repl[] };
export type Skip = { skip: { code: "FILL_CROSSES_MARKUP" | "FILL_SPLITS_CLUSTER" | "FILL_MIXED_FORMAT"; message: string } };
export type Fail = { fail: { code: string; message: string } };

export function span(ctx: Ctx, start: number, end: number, replacement: string, reason: string): SpanEdit {
  return { entry: ctx.entry, start, end, expected: ctx.text.slice(start, end), replacement, reason };
}

/** 값을 조각 안에 넣을 모양으로 부호화한다. CDATA 안이면 그대로(`]]>`만 쪼갬), 아니면 엔티티로 바꾼다. */
export function encodeValue(ctx: Ctx, piece: Piece, value: string): string {
  if (value === "") return "";
  const inCdata =
    piece.kind === "text" && piece.start >= 9 && ctx.text.startsWith("<![CDATA[", piece.start - 9) && ctx.text.startsWith("]]>", piece.end);
  return inCdata ? value.replaceAll("]]>", "]]]]><![CDATA[>") : escapeText(value);
}

/** 위치 `at`(구역 텍스트 오프셋) 앞에 있는 마지막 조각의 논리 끝. 앞에 조각이 없으면 0. */
export function logicalPosAt(par: ParagraphNode, at: number): number {
  let pos = 0;
  for (const piece of par.pieces) {
    if (piece.end <= at) pos = piece.logicalEnd;
    else break;
  }
  return pos;
}

/** 글 조각 하나를 값으로(또는 비워서) 바꾸는 편집과 그 논리 구간. 조각이 부분만 겹치면 겹친 만큼만 바꾼다. */
function replacePiece(ctx: Ctx, piece: Piece, value: string, reason: string, ls = piece.logicalStart, le = piece.logicalEnd): { edit: SpanEdit; repl: Repl } {
  if (piece.kind === "entity") {
    return {
      edit: span(ctx, piece.start, piece.end, encodeValue(ctx, piece, value), reason),
      repl: { start: piece.logicalStart, end: piece.logicalEnd, text: value },
    };
  }
  const a = Math.max(ls, piece.logicalStart);
  const b = Math.min(le, piece.logicalEnd);
  return {
    edit: span(ctx, piece.start + (a - piece.logicalStart), piece.start + (b - piece.logicalStart), encodeValue(ctx, piece, value), reason),
    repl: { start: a, end: b, text: value },
  };
}

/** 논리 구간 `[ls, le)`에 겹친 조각 */
const piecesInside = (par: ParagraphNode, ls: number, le: number): Piece[] =>
  par.pieces.filter((p) => {
    const zero = p.logicalStart === p.logicalEnd;
    return zero ? ls < p.logicalStart && p.logicalStart < le : p.logicalStart < le && p.logicalEnd > ls;
  });

/**
 * 논리 구간 `[ls, le)`의 글을 값으로 바꿀 수 없는 사유. 바꿀 수 있으면 undefined. 편집은 만들지 않고 판단만 한다 —
 * `planRangeReplace`와 앵커 초안(`draftAnchors`의 `blocked`)이 같은 판단을 쓴다.
 * 구간 안에 경계 조각(inline·object)이 있으면 `FILL_CROSSES_MARKUP`, 구간의 시작·끝이 글자 묶음(grapheme cluster) 한가운데면 `FILL_SPLITS_CLUSTER`,
 * 글자모양이 다른 run에 걸치면 `FILL_MIXED_FORMAT`(`mixed: "first"`면 통과).
 */
export function rangeReplaceBlock(par: ParagraphNode, ls: number, le: number, mixed: "skip" | "first"): Skip["skip"] | undefined {
  const inside = piecesInside(par, ls, le);
  if (inside.some((p) => p.kind === "inline" || p.kind === "object")) {
    return { code: "FILL_CROSSES_MARKUP", message: "치환할 글 사이에 탭·줄바꿈·객체가 끼어 있어 건너뜁니다." };
  }
  const clusters = clusterBoundaries(par);
  if (!clusters.has(ls) || !clusters.has(le)) {
    return { code: "FILL_SPLITS_CLUSTER", message: "치환할 글의 시작이나 끝이 결합 부호·옛한글 조합 자모 같은 글자 묶음 한가운데라 건너뜁니다." };
  }
  const formats = new Set(inside.filter(isTextPiece).map((p) => par.runs[p.runOrdinal]?.charPrIDRef ?? ""));
  if (formats.size > 1 && mixed === "skip") {
    return { code: "FILL_MIXED_FORMAT", message: "치환할 글이 글자모양이 다른 run들에 걸쳐 있어 건너뜁니다(mixedFormat: \"first\"로 첫 run에 넣을 수 있습니다)." };
  }
  return undefined;
}

/** 문단의 글을 `line` 앵커로 바꿀 수 없는 사유(문단에 객체가 있다). 바꿀 수 있으면 undefined. 채움과 앵커 초안이 같은 판단을 쓴다. */
export function lineFillBlock(par: ParagraphNode): { code: "FILL_HAS_OBJECT"; message: string } | undefined {
  return contentObjects(par).length > 0 ? { code: "FILL_HAS_OBJECT", message: "문단에 객체(표·그림·누름틀 등)가 있어 문단 글을 바꿀 수 없습니다." } : undefined;
}

/** 셀의 글을 `cell` 앵커로 바꿀 수 없는 사유(셀 안에 객체나 하위 목록이 있다). 바꿀 수 있으면 undefined. 채움과 앵커 초안이 같은 판단을 쓴다. */
export function cellFillBlock(paragraphs: ParagraphNode[]): { code: "FILL_HAS_OBJECT"; message: string } | undefined {
  return paragraphs.some((p) => contentObjects(p).length > 0 || p.subLists.length > 0)
    ? { code: "FILL_HAS_OBJECT", message: "셀 안에 객체(표·그림·누름틀 등)가 있어 셀 글을 바꿀 수 없습니다." }
    : undefined;
}

/**
 * 논리 구간 `[ls, le)`의 글을 값으로 바꾼다(`word` 앵커·`{{}}`). 바꿀 수 없는 경우는 `rangeReplaceBlock`이 정한다.
 * 첫 글 조각에 값을 넣고 나머지 겹친 구간은 지운다. run·`hp:t` 요소는 지우지 않는다.
 */
export function planRangeReplace(
  ctx: Ctx,
  par: ParagraphNode,
  ls: number,
  le: number,
  value: string,
  mixed: "skip" | "first",
  reason: string,
): TextPlan | Skip {
  const block = rangeReplaceBlock(par, ls, le, mixed);
  if (block !== undefined) return { skip: block };
  const texts = piecesInside(par, ls, le).filter(isTextPiece);
  const plan: TextPlan = { edits: [], repls: [] };
  texts.forEach((piece, i) => {
    const r = replacePiece(ctx, piece, i === 0 ? value : "", reason, ls, le);
    plan.edits.push(r.edit);
    plan.repls.push(r.repl);
  });
  return plan;
}

/** 새 `hp:t`를 둘 곳: 첫 run 안. 글 조각이 없는 문단에 쓴다. */
function placeNewText(ctx: Ctx, par: ParagraphNode, value: string, reason: string): { edit: SpanEdit; at: number } | Fail {
  const run = par.runs[0];
  if (run === undefined) return { fail: { code: "FILL_NO_RUN", message: "문단에 run이 없어 글을 넣을 곳이 없습니다." } };
  const el = run.element;
  const tag = `${nsPrefixOf(el)}t`;
  const body = escapeText(value);
  if (el.end === el.openEnd) {
    // 자기닫힘 run은 펼친다
    return { edit: span(ctx, el.start, el.end, `${ctx.text.slice(el.start, el.end - 2)}><${tag}>${body}</${tag}></${el.qname}>`, reason), at: el.start };
  }
  const t = childEls(el, "paragraph", "t")[0];
  if (t !== undefined && t.children.length === 0) {
    if (t.end === t.openEnd) {
      return { edit: span(ctx, t.start, t.end, `${ctx.text.slice(t.start, t.end - 2)}>${body}</${t.qname}>`, reason), at: t.start };
    }
    return { edit: span(ctx, t.openEnd, t.openEnd, body, reason), at: t.openEnd };
  }
  return { edit: span(ctx, el.closeStart, el.closeStart, `<${tag}>${body}</${tag}>`, reason), at: el.closeStart };
}

/**
 * 문단의 글을 값으로 바꾼다(`line` 앵커). 첫 글 조각에 값을 넣고 나머지 글 조각을 비운다.
 * 글 조각이 없으면 첫 run 안에 `hp:t`를 넣는다(자기닫힘 run은 펼친다).
 */
export function planLineFill(ctx: Ctx, par: ParagraphNode, value: string, reason: string): TextPlan | Fail {
  const texts = par.pieces.filter(isTextPiece);
  const plan: TextPlan = { edits: [], repls: [] };
  if (texts.length > 0) {
    texts.forEach((piece, i) => {
      const r = replacePiece(ctx, piece, i === 0 ? value : "", reason);
      plan.edits.push(r.edit);
      plan.repls.push(r.repl);
    });
    return plan;
  }
  if (value === "") return plan;
  const placed = placeNewText(ctx, par, value, reason);
  if ("fail" in placed) return placed;
  plan.edits.push(placed.edit);
  const at = logicalPosAt(par, placed.at);
  plan.repls.push({ start: at, end: at, text: value });
  return plan;
}

/** 문단의 글 조각을 모두 비운다(셀의 나머지 문단). */
export function planClear(ctx: Ctx, par: ParagraphNode, reason: string): TextPlan {
  const plan: TextPlan = { edits: [], repls: [] };
  for (const piece of par.pieces.filter(isTextPiece)) {
    const r = replacePiece(ctx, piece, "", reason);
    plan.edits.push(r.edit);
    plan.repls.push(r.repl);
  }
  return plan;
}
