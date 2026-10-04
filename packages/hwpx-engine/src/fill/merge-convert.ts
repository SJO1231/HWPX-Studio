import type { SpanEdit } from "../edit/plan.ts";
import { makeIssue, type Issue } from "../errors.ts";
import type { HwpxDocument, ParagraphNode } from "../model/types.ts";
import { findPlaceholders, isValidPath } from "../template/placeholder.ts";
import { attrNode, subElements, type XElement } from "../xml/tree.ts";
import { fieldBeginXml, HANCOM_FIELD_ID } from "./click-here.ts";
import { isTextPiece, nsPrefixOf } from "./doc.ts";
import { collectFields, fieldFillBlock, type FieldTarget } from "./fields.ts";
import { encodeValue, span, type Ctx } from "./text.ts";

/**
 * 메일 머지 필드(`MAILMERGE`)를 한컴 메일 머지 없이 쓰는 꼴로 바꾸는 방식.
 * - `to-placeholder`: 필드 표식과 표시 글을 지우고 그 자리에 `{{키}}` 글을 둔다.
 * - `to-field`: 필드 표식을 누름틀(`CLICK_HERE`, 이름 = 키)로 고쳐 쓴다. 표시 글은 그대로 두고 `dirty`는 "1"(글이 값이다)이다.
 */
export type MergeFieldsMode = "to-placeholder" | "to-field";

export type MergeConversion = {
  edits: SpanEdit[];
  /** 바꾼 필드 수 */
  converted: number;
  /** 바꾼 필드가 바꾸기 전에 표시 글 안에 가진 `{{경로}}` 자리의 수(바꾼 뒤 자리 수를 대조하는 데 쓴다) */
  placeholdersInside: number;
  issues: Issue[];
};

/** 필드 요소를 지울 때 함께 지울 범위: 요소가 든 `ctrl`이 그 필드 하나만 담았으면 `ctrl` 전체, 아니면 요소만. */
function removable(el: XElement): XElement {
  const parent = el.parent;
  return parent !== null && parent.local === "ctrl" && subElements(parent).length === 1 ? parent : el;
}

/** 필드 안(시작·끝 표식 사이)의 글·인라인 조각을 `{{키}}`로 바꾸는 편집. 첫 글 조각에 값을 넣고 나머지 글·탭·줄바꿈 조각은 지운다. 글 조각이 없으면 시작 표식 뒤에 새 `hp:t`를 넣는다. */
function placeholderTextEdits(ctx: Ctx, target: FieldTarget, key: string, reason: string): SpanEdit[] {
  const { paragraph: par, begin, end } = target;
  const beginPiece = par.pieces[begin.pieceIndex];
  const endPiece = end === null ? undefined : par.pieces[end.pieceIndex];
  if (beginPiece === undefined || endPiece === undefined) return [];
  const between = par.pieces.slice(begin.pieceIndex + 1, end?.pieceIndex);
  const prefix = nsPrefixOf(begin.element);
  const text = `{{${key}}}`;
  const edits: SpanEdit[] = [];
  let placed = false;
  for (const piece of between) {
    if (isTextPiece(piece)) {
      edits.push(span(ctx, piece.start, piece.end, placed ? "" : encodeValue(ctx, piece, text, prefix), reason));
      placed = true;
    } else {
      edits.push(span(ctx, piece.start, piece.end, "", reason));
    }
  }
  if (!placed) edits.push(span(ctx, beginPiece.end, beginPiece.end, `<${prefix}t>${text}</${prefix}t>`, reason));
  return edits;
}

/** 줄 배치 캐시(`linesegarray`)를 지우는 편집(글이 바뀐 문단의 옛 줄 배치를 믿지 않게 한다. 채움과 같다). */
const lineSegEdit = (ctx: Ctx, par: ParagraphNode, reason: string): SpanEdit | undefined =>
  par.lineSegArray === undefined ? undefined : span(ctx, par.lineSegArray.start, par.lineSegArray.end, "", reason);

/**
 * 문서의 메일 머지 필드(키가 있는 것)를 `mode`에 따라 바꾸는 편집 계획. 키가 데이터 경로 꼴이 아니거나, 채울 수 없는 모양(`fieldFillBlock`)이거나,
 * (`to-placeholder`) 여러 문단에 걸쳐 있으면 바꾸지 않고 `COMPILE_SKIPPED` 경고를 남긴다. 키 없는 메일 머지 필드와 다른 종류의 필드는 건드리지 않는다.
 */
export function planMergeConversion(doc: HwpxDocument, mode: MergeFieldsMode): MergeConversion {
  const out: MergeConversion = { edits: [], converted: 0, placeholdersInside: 0, issues: [] };
  const lineSegDone = new Set<ParagraphNode>();
  for (const target of collectFields(doc)) {
    const { info, section, paragraph, begin, end } = target;
    const key = info.mergeKey;
    if (info.type !== "MAILMERGE" || key === undefined) continue;
    const where = `${section.entryName} [${paragraph.path.join(", ")}]`;
    const skip = (why: string): void => void out.issues.push(makeIssue("warning", "COMPILE_SKIPPED", `${where}: 메일 머지 필드 '${key}'을(를) ${why} 바꾸지 않았습니다.`, where));
    if (!isValidPath(key)) {
      skip("데이터 경로(글자·숫자·_·-를 .으로 이은 꼴)가 아닌 키라");
      continue;
    }
    const block = fieldFillBlock(target);
    if (block !== undefined || end === null) {
      skip(`채울 수 없는 모양(${info.shape})이라`);
      continue;
    }
    const ctx: Ctx = { entry: section.entryName, text: section.text };
    if (mode === "to-field") {
      const fieldEnd = attrNode(end.element, "fieldid");
      if (begin.id === "" || fieldEnd === undefined) {
        skip("짝 표식의 속성이 없어");
        continue;
      }
      const reason = `메일 머지 필드 → 누름틀: ${key}`;
      out.edits.push(span(ctx, begin.element.start, begin.element.end, fieldBeginXml(nsPrefixOf(begin.element), begin.id, key), reason));
      out.edits.push(span(ctx, fieldEnd.valueStart, fieldEnd.valueEnd, HANCOM_FIELD_ID, reason));
      out.converted++;
      continue;
    }
    if (info.shape === "crossParagraph" || target.endParagraph !== paragraph) {
      skip("여러 문단에 걸쳐 있어");
      continue;
    }
    const reason = `메일 머지 필드 → {{키}}: ${key}`;
    const beginWrap = removable(begin.element);
    const endWrap = removable(end.element);
    out.edits.push(span(ctx, beginWrap.start, beginWrap.end, "", reason));
    out.edits.push(...placeholderTextEdits(ctx, target, key, reason));
    out.edits.push(span(ctx, endWrap.start, endWrap.end, "", reason));
    if (!lineSegDone.has(paragraph)) {
      lineSegDone.add(paragraph);
      const seg = lineSegEdit(ctx, paragraph, "줄 배치 캐시 제거");
      if (seg !== undefined) out.edits.push(seg);
    }
    out.placeholdersInside += findPlaceholders(info.valueText).length;
    out.converted++;
  }
  return out;
}
