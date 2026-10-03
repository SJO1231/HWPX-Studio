// 앵커가 가리키는 자리를 쪽 위에 강조할 구간으로 옮긴다. 앵커 해석은 엔진의 `resolveAnchors`(채움이 앵커를 찾는 것과 같은 규칙)가 한다.
import {
  emptyTemplate,
  resolveAnchors,
  type Anchor,
  type AnchorDraft,
  type HwpxDocument,
  type ResolvedAnchor,
} from "../../../hwpx-engine/src/index.ts";
import { offsetTable, paragraphAtAddress, rhwpOffsetAt, toRhwpPosition } from "../map/index.ts";
import type { MarkRange } from "./types.ts";

/**
 * 앵커 초안들을 엔진의 앵커 해석으로 문서에서 찾는다. 입력과 같은 순서이고, 찾지 못한 앵커는 undefined다.
 * 방금 같은 문서에서 만든 앵커는 지문이 맞지만, 해석 규칙을 이쪽에서 다시 구현하지 않는다.
 */
export function resolveDrafts(doc: HwpxDocument, anchors: AnchorDraft[]): (ResolvedAnchor | undefined)[] {
  const template = { ...emptyTemplate(), anchors: anchors.map((a, i): Anchor => ({ ...a, id: `t${i}` })) };
  const { anchors: found } = resolveAnchors(doc, template);
  return anchors.map((_, i) => found.get(`t${i}`));
}

type Target = { sectionIndex: number; path: number[]; from: number; until: number; guideOf?: boolean };

/** 누름틀 해석의 `i`번째 대상이 가리키는 문단과 값 구간. 시작·끝 조각이 없으면 undefined. */
function fieldTarget(resolved: Extract<ResolvedAnchor, { kind: "field" }>, i: number): Target | undefined {
  const target = resolved.targets[i];
  const begin = target === undefined ? undefined : target.paragraph.pieces[target.begin.pieceIndex];
  const end = target?.end == null ? undefined : target.paragraph.pieces[target.end.pieceIndex];
  if (target === undefined || begin === undefined || end === undefined) return undefined;
  return { sectionIndex: target.info.sectionIndex, path: target.info.path, from: begin.logicalEnd, until: end.logicalStart, guideOf: true };
}

/** 앵커 초안이 가리키는 문단과 논리 구간. 엔진이 못 찾았거나, 지문으로 다시 찾아 주소가 바뀐(`relocated`) 앵커처럼 주소를 정할 수 없으면 undefined. */
function targetOf(anchor: AnchorDraft, resolved: ResolvedAnchor | undefined): Target | undefined {
  if (resolved === undefined) return undefined;
  // 이름이 같은 누름틀이 여럿이면 첫째(순번을 준 앵커는 하나뿐이다)
  if (resolved.kind === "field") return fieldTarget(resolved, 0);
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

/** 대상 하나를 쪽 위에 강조할 rhwp 글자 순번 구간으로 옮긴다. 옮길 수 없으면 undefined. */
function markFor(doc: HwpxDocument, anchor: AnchorDraft, target: Target): MarkRange | undefined {
  const address = { sectionIndex: target.sectionIndex, path: target.path };
  const paragraph = paragraphAtAddress(doc, address);
  if (paragraph === undefined) return undefined;
  const table = offsetTable(paragraph);
  const position = toRhwpPosition(doc, { ...address, offset: target.from });
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

/** 앵커 초안의 자리를 쪽 위에 강조할 rhwp 글자 순번 구간으로 옮긴다(이름이 같은 누름틀이 여럿이면 첫째). 옮길 수 없으면 undefined. */
export function markOf(doc: HwpxDocument, anchor: AnchorDraft, resolved: ResolvedAnchor | undefined): MarkRange | undefined {
  const target = targetOf(anchor, resolved);
  return target === undefined ? undefined : markFor(doc, anchor, target);
}

/** 앵커가 가리키는 자리 전부의 강조 구간. 이름이 같은 누름틀 전부를 가리키는 앵커는 여러 곳이다. 옮길 수 없는 자리는 뺀다. */
export function markRanges(doc: HwpxDocument, anchor: AnchorDraft, resolved: ResolvedAnchor | undefined): MarkRange[] {
  if (resolved === undefined) return [];
  const targets: (Target | undefined)[] = resolved.kind === "field" ? resolved.targets.map((_, i) => fieldTarget(resolved, i)) : [targetOf(anchor, resolved)];
  const out: MarkRange[] = [];
  for (const t of targets) {
    const mark = t === undefined ? undefined : markFor(doc, anchor, t);
    if (mark !== undefined) out.push(mark);
  }
  return out;
}
