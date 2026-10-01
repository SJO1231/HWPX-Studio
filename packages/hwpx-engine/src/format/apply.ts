import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";
import type { HwpxDocument, ParagraphNode, Piece, SectionModel } from "../model/types.ts";
import { attrNode, elementChildren, elIs, walkElements, type XElement } from "../xml/tree.ts";
import { createDeriver } from "./derive.ts";
import type { CharTarget, FormatDelta, ParaTarget } from "./types.ts";

// ── 대상 찾기 ───────────────────────────────────────────────────

function sectionOf(doc: HwpxDocument, sectionIndex: number): SectionModel {
  const section = Number.isInteger(sectionIndex) ? doc.sections[sectionIndex] : undefined;
  if (section === undefined) throw new HwpxError("FMT_TARGET", `구역 ${sectionIndex}이(가) 없습니다(구역 ${doc.sections.length}개).`);
  return section;
}

/** 문단 주소 `[문단, 하위목록, 문단, ...]`(홀수 길이)가 가리키는 문단 */
function paragraphAt(section: SectionModel, path: number[]): ParagraphNode {
  let found: ParagraphNode | undefined;
  if (path.length % 2 === 1 && path.every((n) => Number.isInteger(n) && n >= 0)) {
    let list = section.paragraphs;
    for (let n = 0; n < path.length; n++) {
      const i = path[n] ?? -1;
      if (n % 2 === 0) {
        found = list[i];
        if (found === undefined) break;
      } else {
        const sub = found?.subLists[i];
        if (sub === undefined) {
          found = undefined;
          break;
        }
        list = sub.paragraphs;
      }
    }
  }
  if (found === undefined) throw new HwpxError("FMT_TARGET", `문단 주소 [${path.join(", ")}]가 구역 ${section.index}에 없습니다.`, section.entryName);
  return found;
}

/** 구역의 줄 배치 캐시(`linesegarray`) 요소를 전부 지우는 편집들 */
function lineSegRemovals(section: SectionModel): SpanEdit[] {
  const edits: SpanEdit[] = [];
  for (const el of walkElements(section.root)) {
    if (!elIs(el, "paragraph", "linesegarray")) continue;
    edits.push({
      entry: section.entryName,
      start: el.start,
      end: el.end,
      expected: section.text.slice(el.start, el.end),
      replacement: "",
      reason: "서식 변경으로 줄 배치 캐시 제거",
    });
  }
  return edits;
}

// ── 글자 서식 ───────────────────────────────────────────────────

const width = (p: Piece): number => p.logicalEnd - p.logicalStart;
const CDATA_OPEN = "<![CDATA[";
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

type Split = {
  boundary: "start" | "end";
  /** 쪼갤 원문 위치 */
  raw: number;
  /** `t`: `hp:t` 안(t와 run을 닫고 다시 연다), `run`: run의 자식 사이(run만 닫고 다시 연다) */
  kind: "t" | "run";
  cdata: boolean;
  t?: XElement;
};

function containerOf(run: XElement, piece: Piece): XElement {
  const found = elementChildren(run).find((c) => c.start <= piece.start && piece.end <= c.end);
  if (found === undefined) throw new HwpxError("FMT_INTERNAL", "조각을 담은 run의 자식 요소를 찾지 못했습니다.");
  return found;
}

/**
 * 한 문단 안의 논리 텍스트 구간 `[start, end)`의 글자모양을 바꾸는 계획을 만든다.
 * 구간 경계에서 run을 쪼개고(글 조각 중간이면 `hp:t`와 run을 닫고 같은 속성으로 다시 연다), 구간에 걸친 run마다
 * "그 run의 글자모양 + delta"로 파생한 id를 `charPrIDRef`에 넣는다. 글자모양이 바뀌지 않는 run은 건드리지 않는다.
 * 계획은 header 추가, 구역 편집, 그 구역의 줄 배치 캐시 제거를 담는다.
 */
export function planApplyCharFormat(doc: HwpxDocument, target: CharTarget, delta: FormatDelta): EditPlan {
  const section = sectionOf(doc, target.sectionIndex);
  const paragraph = paragraphAt(section, target.path);
  const { start: s, end: e } = target;
  const total = paragraph.logicalText.length;
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > total || s >= e) {
    throw new HwpxError("FMT_BAD_RANGE", `구간 [${s}, ${e})이 올바르지 않습니다(문단 글 길이 ${total}, 길이 0 구간은 거절합니다).`, section.entryName);
  }
  const text = section.text;
  const pieces = paragraph.pieces;

  // 구간에 걸친 run: 폭이 있는 조각이 구간과 겹치거나, 폭 0 조각이 구간 안쪽에 있는 run, 그 사이의 빈 run
  const overlaps = (p: Piece): boolean => (width(p) > 0 ? p.logicalStart < e && p.logicalEnd > s : p.logicalStart > s && p.logicalStart < e);
  const affected = new Set<number>();
  for (const p of pieces) if (overlaps(p)) affected.add(p.runOrdinal);
  const first = Math.min(...affected);
  const last = Math.max(...affected);
  for (const run of paragraph.runs) if (run.ordinal > first && run.ordinal < last) affected.add(run.ordinal);

  // 경계 검사와 쪼갤 위치
  const splits = new Map<number, Split[]>();
  const addSplit = (ordinal: number, split: Split): void => {
    const list = splits.get(ordinal);
    if (list === undefined) splits.set(ordinal, [split]);
    else list.push(split);
  };
  for (const [b, boundary] of [
    [s, "start"],
    [e, "end"],
  ] as const) {
    const inner = pieces.find((p) => p.logicalStart < b && b < p.logicalEnd);
    if (inner !== undefined) {
      if (inner.kind !== "text") {
        throw new HwpxError("FMT_BAD_RANGE", `구간 경계 ${b}이(가) ${inner.kind === "entity" ? "엔티티 참조" : "경계 조각"} 한가운데입니다.`, section.entryName);
      }
      if (isHighSurrogate(paragraph.logicalText.charCodeAt(b - 1)) && isLowSurrogate(paragraph.logicalText.charCodeAt(b))) {
        throw new HwpxError("FMT_BAD_RANGE", `구간 경계 ${b}이(가) 서로게이트 쌍 한가운데입니다.`, section.entryName);
      }
      const run = paragraph.runs[inner.runOrdinal]?.element;
      if (run === undefined) continue;
      addSplit(inner.runOrdinal, {
        boundary,
        raw: inner.start + (b - inner.logicalStart),
        kind: "t",
        cdata: text.slice(inner.start - CDATA_OPEN.length, inner.start) === CDATA_OPEN,
        t: containerOf(run, inner),
      });
      continue;
    }
    const prev = pieces.find((p) => width(p) > 0 && p.logicalEnd === b);
    const next = pieces.find((p) => width(p) > 0 && p.logicalStart === b);
    if (prev === undefined || next === undefined || prev.runOrdinal !== next.runOrdinal) continue; // run 경계이거나 문단 끝
    const run = paragraph.runs[prev.runOrdinal]?.element;
    if (run === undefined) continue;
    const prevBox = containerOf(run, prev);
    if (prevBox === containerOf(run, next) && elIs(prevBox, "paragraph", "t")) {
      const cdata = text.slice(prev.end, prev.end + 3) === "]]>" && text.slice(prev.start - CDATA_OPEN.length, prev.start) === CDATA_OPEN;
      addSplit(prev.runOrdinal, { boundary, raw: prev.end + (cdata ? 3 : 0), kind: "t", cdata: false, t: prevBox });
    } else {
      addSplit(prev.runOrdinal, { boundary, raw: prevBox.end, kind: "run", cdata: false });
    }
  }

  // run마다 새 글자모양 id
  const deriver = createDeriver(doc);
  const derived = new Map<string, string>();
  const changed: { ordinal: number; baseId: string; newId: string }[] = [];
  for (const ordinal of [...affected].sort((a, b) => a - b)) {
    const run = paragraph.runs[ordinal];
    if (run === undefined) continue;
    if (run.charPrIDRef === null) {
      throw new HwpxError("FMT_NO_BASE", `run ${ordinal}에 charPrIDRef가 없어 기준 글자모양을 알 수 없습니다.`, section.entryName);
    }
    let newId = derived.get(run.charPrIDRef);
    if (newId === undefined) {
      newId = deriver.derive("charPr", run.charPrIDRef, delta).id;
      derived.set(run.charPrIDRef, newId);
    }
    if (newId !== run.charPrIDRef) changed.push({ ordinal, baseId: run.charPrIDRef, newId });
  }
  const headerPlan = deriver.finish();
  if (changed.length === 0) return { ...headerPlan, summary: { ...headerPlan.summary, changedRuns: 0, addedRuns: 0, removedLineSegs: 0 } };

  const entry = section.entryName;
  const edits: SpanEdit[] = [];
  let addedRuns = 0;
  for (const { ordinal, baseId, newId } of changed) {
    const el = paragraph.runs[ordinal]?.element;
    const attr = el === undefined ? undefined : attrNode(el, "charPrIDRef");
    if (el === undefined || attr === undefined) continue;
    const tagWith = (id: string): string => text.slice(el.start, attr.valueStart) + id + text.slice(attr.valueEnd, el.openEnd);
    const closeRun = text.slice(el.closeStart, el.end);
    const list = [...(splits.get(ordinal) ?? [])].sort((a, b) => a.raw - b.raw);
    let inside = !list.some((sp) => sp.boundary === "start");
    if (inside) {
      edits.push({
        entry,
        start: attr.valueStart,
        end: attr.valueEnd,
        expected: text.slice(attr.valueStart, attr.valueEnd),
        replacement: newId,
        reason: `글자모양 ${baseId} → ${newId}`,
      });
    }
    for (const sp of list) {
      inside = sp.boundary === "start";
      let replacement = closeRun + tagWith(inside ? newId : baseId);
      if (sp.kind === "t" && sp.t !== undefined) {
        replacement =
          (sp.cdata ? "]]>" : "") + text.slice(sp.t.closeStart, sp.t.end) + replacement + text.slice(sp.t.start, sp.t.openEnd) + (sp.cdata ? CDATA_OPEN : "");
      }
      edits.push({ entry, start: sp.raw, end: sp.raw, expected: "", replacement, reason: `run 쪼개기(경계 ${sp.boundary === "start" ? s : e})` });
      addedRuns++;
    }
  }
  const lineSegs = lineSegRemovals(section);
  return {
    edits: [...headerPlan.edits, ...edits, ...lineSegs],
    additions: [],
    summary: { ...headerPlan.summary, changedRuns: changed.length, addedRuns, removedLineSegs: lineSegs.length },
    issues: [],
  };
}

// ── 문단 서식 ───────────────────────────────────────────────────

/**
 * 문단들의 문단모양을 바꾸는 계획을 만든다. 문단의 `paraPrIDRef`를 "그 문단의 문단모양 + delta"로 파생한 id로 바꾼다.
 * 같은 문단 주소가 여럿이면 한 번만 적용한다. 바뀐 문단이 있는 구역의 줄 배치 캐시는 지운다.
 */
export function planApplyParaFormat(doc: HwpxDocument, targets: ParaTarget[], delta: FormatDelta): EditPlan {
  if (targets.length === 0) throw new HwpxError("FMT_TARGET", "대상 문단이 없습니다.");
  const deriver = createDeriver(doc);
  const derived = new Map<string, string>();
  const seen = new Set<string>();
  const edits: SpanEdit[] = [];
  const touched = new Map<number, SectionModel>();
  for (const t of targets) {
    const key = `${t.sectionIndex}:${t.path.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const section = sectionOf(doc, t.sectionIndex);
    const paragraph = paragraphAt(section, t.path);
    const baseId = paragraph.attrs.paraPrIDRef;
    const attr = attrNode(paragraph.element, "paraPrIDRef");
    if (baseId === null || attr === undefined) {
      throw new HwpxError("FMT_NO_BASE", `문단 [${t.path.join(", ")}]에 paraPrIDRef가 없어 기준 문단모양을 알 수 없습니다.`, section.entryName);
    }
    let newId = derived.get(baseId);
    if (newId === undefined) {
      newId = deriver.derive("paraPr", baseId, delta).id;
      derived.set(baseId, newId);
    }
    if (newId === baseId) continue;
    edits.push({
      entry: section.entryName,
      start: attr.valueStart,
      end: attr.valueEnd,
      expected: section.text.slice(attr.valueStart, attr.valueEnd),
      replacement: newId,
      reason: `문단모양 ${baseId} → ${newId}`,
    });
    touched.set(section.index, section);
  }
  const headerPlan = deriver.finish();
  const lineSegs = [...touched.values()].flatMap(lineSegRemovals);
  return {
    edits: [...headerPlan.edits, ...edits, ...lineSegs],
    additions: [],
    summary: { ...headerPlan.summary, changedParagraphs: edits.length, removedLineSegs: lineSegs.length },
    issues: [],
  };
}
