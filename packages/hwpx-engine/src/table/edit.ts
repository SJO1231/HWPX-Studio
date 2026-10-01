import type { SpanEdit } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";
import { walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, SectionModel } from "../model/types.ts";
import { escapeAttr } from "../xml/chars.ts";
import { elIs, type XElement } from "../xml/tree.ts";
import type { TableTarget } from "./types.ts";

/** 편집 대상 구역 파일 하나: 항목 이름과 그 텍스트(편집 오프셋의 기준). */
export type Ctx = { entry: string; text: string };

/** 줄 배치 캐시를 지우는 편집의 사유. 채움 경로(`src/fill`)가 쓰는 것과 같다. */
export const LINESEG_REASON = "줄 배치 캐시 제거";

export function span(ctx: Ctx, start: number, end: number, replacement: string, reason: string): SpanEdit {
  return { entry: ctx.entry, start, end, expected: ctx.text.slice(start, end), replacement, reason };
}

export const prefixOf = (el: XElement): string => (el.prefix === "" ? "" : `${el.prefix}:`);

/** `target`이 가리키는 구역과 표 요소. 표가 아니거나 그 구역의 요소 트리에 없으면 `TABLE_NOT_FOUND`. */
export function resolveTarget(doc: HwpxDocument, target: TableTarget): { section: SectionModel; ctx: Ctx; table: XElement } {
  // 공개 plan* 함수의 입구: 쓸 수 없는 값은 코드 없는 TypeError가 아니라 TABLE_BAD_ARG로 거절한다
  if (typeof doc !== "object" || doc === null || !Array.isArray(doc.sections)) throw new HwpxError("TABLE_BAD_ARG", "doc은 문서 모델이어야 합니다.");
  if (typeof target !== "object" || target === null || typeof target.element !== "object" || target.element === null) {
    throw new HwpxError("TABLE_BAD_ARG", "target은 { sectionIndex, element } 객체여야 합니다.");
  }
  const section = doc.sections[target.sectionIndex];
  if (section === undefined) throw new HwpxError("TABLE_NOT_FOUND", `구역 ${target.sectionIndex}이(가) 없습니다(구역 ${doc.sections.length}개).`);
  const table = target.element;
  if (!elIs(table, "paragraph", "tbl")) throw new HwpxError("TABLE_NOT_FOUND", `대상 요소가 표(tbl)가 아니라 ${table.local}입니다.`, section.entryName);
  let top: XElement | null = table;
  while (top !== null && top.parent !== null) top = top.parent;
  if (top !== section.root) throw new HwpxError("TABLE_NOT_FOUND", `대상 표가 구역 ${target.sectionIndex}의 문서 트리에 없습니다.`, section.entryName);
  return { section, ctx: { entry: section.entryName, text: section.text }, table };
}

const attrOf = (el: XElement, name: string): XElement["attrs"][number] | undefined => el.attrs.find((a) => a.qname === name);

/**
 * 속성값을 정하는 편집들. 있는 속성은 값 구간만 바꾸고(같으면 편집 없음), 없는 속성은 시작 태그의 마지막 속성 뒤에 한 번에 더한다.
 * `values`의 값은 원문 그대로 쓸 문자열이다(`escapeAttr`를 거친다).
 */
export function setAttrs(ctx: Ctx, el: XElement, values: Record<string, string>, reason: string): SpanEdit[] {
  const edits: SpanEdit[] = [];
  let added = "";
  for (const [name, value] of Object.entries(values)) {
    const attr = attrOf(el, name);
    if (attr !== undefined) {
      if (ctx.text.slice(attr.valueStart, attr.valueEnd) !== escapeAttr(value)) {
        edits.push(span(ctx, attr.valueStart, attr.valueEnd, escapeAttr(value), reason));
      }
    } else {
      added += ` ${name}="${escapeAttr(value)}"`;
    }
  }
  if (added !== "") {
    const last = el.attrs.at(-1);
    const at = last === undefined ? el.start + 1 + el.qname.length : last.valueEnd + 1;
    edits.push(span(ctx, at, at, added, reason));
  }
  return edits;
}

/** 요소 원문에서 속성값 구간(요소 시작 기준 상대)을 새 값으로 바꾼 문자열. 요소 원문의 복사본을 고칠 때 쓴다. */
export type Rep = { start: number; end: number; text: string };

export function applyReps(text: string, reps: Rep[]): string {
  const sorted = [...reps].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.end < r.start || r.end > text.length) {
      throw new HwpxError("TABLE_INTERNAL", `복사본의 편집 구간 [${r.start}, ${r.end})이 겹치거나 범위를 벗어납니다.`);
    }
    out += text.slice(pos, r.start) + r.text;
    pos = r.end;
  }
  return out + text.slice(pos);
}

/** 속성 하나의 값 구간을 바꾸는 복사본용 치환. 속성이 없으면 undefined. */
export function attrRep(el: XElement, name: string, value: string, base: number): Rep | undefined {
  const attr = attrOf(el, name);
  return attr === undefined ? undefined : { start: attr.valueStart - base, end: attr.valueEnd - base, text: escapeAttr(value) };
}

/**
 * 구역의 모든 줄 배치 캐시(`linesegarray`)를 지우는 편집. `exclude` 구간(서로 겹치지 않는다) 안의 것은 건너뛴다. 다른 편집이 통째로 바꾸거나 지우는 구간이다.
 * 줄 배치 캐시는 문단에서만 나오므로 문단 모델을 거친다(하위 목록 안 문단 포함).
 */
export function lineSegEdits(section: SectionModel, exclude: { start: number; end: number }[] = []): SpanEdit[] {
  const ctx: Ctx = { entry: section.entryName, text: section.text };
  const spans = [...exclude].sort((a, b) => a.start - b.start);
  const covered = (start: number, end: number): boolean => {
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((spans[mid]?.start ?? Infinity) <= start) lo = mid + 1;
      else hi = mid;
    }
    const x = spans[lo - 1];
    return x !== undefined && x.start <= start && end <= x.end;
  };
  const edits: SpanEdit[] = [];
  for (const p of walkParagraphs(section.paragraphs)) {
    const seg = p.lineSegArray;
    if (seg === undefined || covered(seg.start, seg.end)) continue;
    edits.push(span(ctx, seg.start, seg.end, "", LINESEG_REASON));
  }
  return edits;
}

/** 구간이 겹치지 않는 편집들을 텍스트에 적용한다(길이 0 삽입이 같은 위치에 여럿이면 목록 순서). 복제한 표 원문을 고치는 데 쓴다. */
export function applySpanEdits(text: string, edits: SpanEdit[]): string {
  const sorted = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => a.edit.start - b.edit.start || a.edit.end - b.edit.end || a.index - b.index)
    .map((x) => x.edit);
  let out = "";
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos || e.end > text.length || text.slice(e.start, e.end) !== e.expected) {
      throw new HwpxError("TABLE_INTERNAL", `복제한 표 원문의 편집 구간 [${e.start}, ${e.end})이 겹치거나 원문과 다릅니다(${e.reason}).`);
    }
    out += text.slice(pos, e.start) + e.replacement;
    pos = e.end;
  }
  return out + text.slice(pos);
}
