import { listFields } from "../model/fields.ts";
import type { FieldInfo, FieldMark, FieldShape, HwpxDocument, ParagraphNode, SectionModel } from "../model/types.ts";
import { escapeText } from "../xml/chars.ts";
import { attrNode } from "../xml/tree.ts";
import { paragraphAtPath, isTextPiece, nsPrefixOf } from "./doc.ts";
import { encodeValue, span, type Ctx, type Fail, type TextPlan } from "./text.ts";

/** 누름틀 하나: 시작·끝 표식과 그 문단. */
export type FieldTarget = {
  section: SectionModel;
  paragraph: ParagraphNode;
  info: FieldInfo;
  begin: FieldMark;
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
    const end = paragraph.fieldMarks.slice(from + 1).find((m) => m.kind === "end" && m.beginIDRef === begin.id) ?? null;
    out.push({ section, paragraph, info, begin, end });
  }
  return out;
}

export type FieldFill = TextPlan & { check: { beginStart: number; name: string; value: string; setsDirty: boolean } };

export function fieldShapeError(shape: FieldShape): Fail {
  return { fail: { code: "FIELD_UNSUPPORTED_SHAPE", message: `누름틀의 모양(${shape})은 채울 수 없습니다(simple·empty만 지원).` } };
}

/**
 * 이 누름틀을 값으로 채울 수 없는 사유(모양이 `simple`·`empty`가 아니거나 끝 표식이 없거나 시작·끝이 같은 조각이다). 채울 수 있으면 undefined.
 * 채움(`planFieldFill`)과 앵커 초안(`draftAnchors`: 채울 수 없는 모양의 누름틀은 `field` 초안을 만들지 않는다)이 같은 판단을 쓴다.
 */
export function fieldFillBlock(target: FieldTarget): Fail["fail"] | undefined {
  const { info, begin, end } = target;
  if ((info.shape !== "simple" && info.shape !== "empty") || end === null || begin.pieceIndex === end.pieceIndex) return fieldShapeError(info.shape).fail;
  return undefined;
}

/**
 * 누름틀에 값을 넣는다(안내문과 비교하지 않는다).
 * - `simple`: 시작과 끝 사이 첫 글 조각에 값을 넣고 나머지 글 조각은 비운다.
 * - `empty`: 시작 컨트롤 바로 뒤에 `hp:t`를 넣는다.
 * - 값이 비어 있지 않으면 시작 요소의 `dirty`를 `"1"`로 한다. `dirty`가 `"1"`이 아니던(안내문 상태) 누름틀은
 *   시작 run과 끝 run 사이 run들의 글자모양을 시작 컨트롤이 든 run의 것으로 바꾼다. 빈 값이면 둘 다 건드리지 않는다.
 */
export function planFieldFill(ctx: Ctx, target: FieldTarget, value: string, reason: string): FieldFill | Fail {
  const { paragraph: par, begin, end, info } = target;
  const block = fieldFillBlock(target);
  if (block !== undefined || end === null) return { fail: block ?? fieldShapeError(info.shape).fail };
  const beginPiece = par.pieces[begin.pieceIndex];
  const endPiece = par.pieces[end.pieceIndex];
  if (beginPiece === undefined || endPiece === undefined) return fieldShapeError(info.shape);

  const plan: FieldFill = {
    edits: [],
    repls: [],
    check: { beginStart: begin.element.start, name: info.name, value, setsDirty: value !== "" },
  };
  const texts = par.pieces.slice(begin.pieceIndex + 1, end.pieceIndex).filter(isTextPiece);
  if (info.shape === "simple") {
    texts.forEach((piece, i) => {
      const text = i === 0 ? value : "";
      plan.edits.push(span(ctx, piece.start, piece.end, encodeValue(ctx, piece, text), reason));
      plan.repls.push({ start: piece.logicalStart, end: piece.logicalEnd, text });
    });
  } else if (value !== "") {
    const tag = `${nsPrefixOf(begin.element)}t`;
    plan.edits.push(span(ctx, beginPiece.end, beginPiece.end, `<${tag}>${escapeText(value)}</${tag}>`, reason));
    plan.repls.push({ start: beginPiece.logicalEnd, end: beginPiece.logicalEnd, text: value });
  }

  if (value !== "") {
    const dirty = attrNode(begin.element, "dirty");
    if (dirty === undefined) {
      const at = begin.element.end === begin.element.openEnd ? begin.element.openEnd - 2 : begin.element.openEnd - 1;
      plan.edits.push(span(ctx, at, at, ' dirty="1"', `${reason}: dirty 설정`));
    } else if (dirty.value !== "1") {
      plan.edits.push(span(ctx, dirty.valueStart, dirty.valueEnd, "1", `${reason}: dirty 설정`));
    }
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
