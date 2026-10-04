import type { FragmentSelection } from "../fragment/types.ts";
import type { HwpxDocument, ParagraphNode, SectionModel } from "../model/types.ts";
import { sha256Hex } from "../template/hash.ts";
import { attrValue, elIs, walkElements } from "../xml/tree.ts";
import type { ParagraphPrint, RangeAnchor, RangePrint } from "./anchor-types.ts";

// `range` 앵커의 지문과 해석(7.10). 문단 글은 `line` 앵커와 같은 방식(글 앞 40자, 문단 논리 텍스트의 sha256)으로 본다.

/** 첫·끝 문단 지문의 글 길이(`line` 앵커의 `LINE_PREFIX`와 같다) */
const PRINT_TEXT = 40;

/** 앵커 초안: `id`는 템플릿에 넣는 쪽이 정한다(`draftAnchors`의 초안과 같은 꼴). */
export type RangeDraft = Omit<RangeAnchor, "id">;

/** 해석한 범위: 실제 위치(재탐색이면 새 위치)의 구역·상위 목록 주소·문단들 */
export type FoundRange = { section: SectionModel; parentPath: number[]; from: number; to: number; paragraphs: ParagraphNode[] };

/**
 * 범위 지문 대조 결과. `changed`는 첫·끝 문단은 찾았으나 안쪽이 다른 경우, `notFound`는 구역이 없거나 지문과 맞는 범위가 없는 경우다.
 * `checkAnchors`(8.8.13)의 상태 판정에도 쓸 수 있도록 이슈를 만들지 않고 상태만 돌려준다.
 */
export type RangeLocation =
  | { state: "exact"; found: FoundRange }
  | { state: "relocated"; found: FoundRange }
  | { state: "ambiguous"; count: number }
  | { state: "changed" }
  | { state: "notFound"; noSection: boolean };

const hashes = new WeakMap<ParagraphNode, string>();
/** 문단 글(논리 텍스트)의 sha256. 같은 문단은 한 번만 계산한다. */
export function paragraphHash(p: ParagraphNode): string {
  let h = hashes.get(p);
  if (h === undefined) hashes.set(p, (h = sha256Hex(p.logicalText)));
  return h;
}

const printOf = (p: ParagraphNode): ParagraphPrint => ({ text: p.logicalText.slice(0, PRINT_TEXT), sha256: paragraphHash(p) });
const joinedHash = (paragraphs: readonly ParagraphNode[]): string => sha256Hex(paragraphs.map((p) => p.logicalText).join("\n"));

/** 문단들(비어 있지 않아야 한다)의 범위 지문 */
export function rangePrintOf(paragraphs: readonly ParagraphNode[]): RangePrint {
  const first = paragraphs[0];
  const last = paragraphs[paragraphs.length - 1];
  if (first === undefined || last === undefined) throw new RangeError("범위에 문단이 없습니다.");
  return { first: printOf(first), last: printOf(last), count: paragraphs.length, sha256: joinedHash(paragraphs) };
}

/** 구역의 문단 목록 하나: `parentPath`가 빈 배열이면 최상위, 아니면 그 주소(`[문단, 하위목록, ...]` 짝)의 하위 목록. 없으면 undefined. */
export function listAtParent(section: SectionModel, parentPath: readonly number[]): ParagraphNode[] | undefined {
  if (parentPath.length % 2 !== 0) return undefined;
  let list = section.paragraphs;
  for (let i = 0; i < parentPath.length; i += 2) {
    const sub = list[parentPath[i] ?? -1]?.subLists[parentPath[i + 1] ?? -1];
    if (sub === undefined) return undefined;
    list = sub.paragraphs;
  }
  return list;
}

/** 문단 목록(최상위와 모든 하위 목록)을 문서 순서로 돌려준다. */
export function* paragraphLists(paragraphs: ParagraphNode[]): Generator<ParagraphNode[]> {
  yield paragraphs;
  for (const p of paragraphs) for (const sub of p.subLists) yield* paragraphLists(sub.paragraphs);
}

const isIndex = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * 문서의 지금 글에서 지문을 떠 `range` 앵커 초안을 만든다. 구역·목록·범위가 없으면 undefined.
 * 선택은 7.2의 `FragmentSelection`이거나 `(구역, 상위 주소, from, to)`다.
 */
export function makeRangeAnchor(doc: HwpxDocument, selection: FragmentSelection): RangeDraft | undefined;
export function makeRangeAnchor(doc: HwpxDocument, sectionIndex: number, parentPath: number[], from: number, to: number): RangeDraft | undefined;
export function makeRangeAnchor(doc: HwpxDocument, a: FragmentSelection | number, b?: number[], c?: number, d?: number): RangeDraft | undefined {
  const sel: FragmentSelection =
    typeof a === "object" ? a : { sectionIndex: a, parentPath: b ?? [], from: c ?? -1, to: d ?? -1 };
  const section = isIndex(sel.sectionIndex) ? doc.sections[sel.sectionIndex] : undefined;
  const list = section === undefined ? undefined : listAtParent(section, sel.parentPath);
  if (list === undefined || !isIndex(sel.from) || !isIndex(sel.to) || sel.from > sel.to || sel.to >= list.length) return undefined;
  return {
    kind: "range",
    at: { sectionIndex: sel.sectionIndex, parentPath: [...sel.parentPath] },
    from: sel.from,
    to: sel.to,
    print: rangePrintOf(list.slice(sel.from, sel.to + 1)),
  };
}

/** 두 범위 지문이 모두 같은가(첫·끝 문단, 문단 수, 전체 글 해시) */
export const samePrint = (a: RangePrint, b: RangePrint): boolean =>
  a.count === b.count && a.first.text === b.first.text && a.first.sha256 === b.first.sha256 && a.last.text === b.last.text && a.last.sha256 === b.last.sha256 && a.sha256 === b.sha256;

/** 양 끝이 어긋난 범위를 `changed`로 보는 길이의 한도: 원래 문단 수의 2배(안쪽 문단이 늘고 줄어든 경우까지) */
const changedSpan = (count: number): number => count * 2;

/**
 * 범위 앵커를 문서에서 찾는다. 주소의 범위가 지문과 모두 맞으면 `exact`. 아니면 같은 구역의 모든 문단 목록에서
 * 첫·끝 문단·문단 수·전체 글 해시가 모두 맞는 범위를 찾는다: 하나면 `relocated`, 여럿이면 `ambiguous`.
 * 없으면 첫 문단과 끝 문단(앞 문단 뒤 원래 문단 수의 2배 안)이 있는 곳이 있을 때 `changed`, 아니면 `notFound`다.
 * 문단 글은 논리 텍스트라 표 안의 글은 지문에 들지 않는다(표를 담은 문단은 표 자리 글자 하나로 본다).
 */
export function locateRange(doc: HwpxDocument, a: RangeAnchor): RangeLocation {
  const section = doc.sections[a.at.sectionIndex];
  if (section === undefined) return { state: "notFound", noSection: true };
  const foundAt = (parentPath: number[], from: number, list: ParagraphNode[], count: number): FoundRange => ({
    section,
    parentPath,
    from,
    to: from + count - 1,
    paragraphs: list.slice(from, from + count),
  });

  const own = listAtParent(section, a.at.parentPath);
  if (own !== undefined && isIndex(a.from) && a.from <= a.to && a.to < own.length) {
    const paragraphs = own.slice(a.from, a.to + 1);
    if (samePrint(rangePrintOf(paragraphs), a.print)) return { state: "exact", found: { section, parentPath: [...a.at.parentPath], from: a.from, to: a.to, paragraphs } };
  }

  const { first, last, count } = a.print;
  const full: FoundRange[] = [];
  let changed = false;
  for (const list of paragraphLists(section.paragraphs)) {
    const hashOf = (i: number): string | undefined => {
      const p = list[i];
      return p === undefined ? undefined : paragraphHash(p);
    };
    const parentPath = list[0]?.path.slice(0, -1) ?? [];
    for (let i = 0; i < list.length; i++) {
      if (hashOf(i) !== first.sha256 || list[i]?.logicalText.slice(0, PRINT_TEXT) !== first.text) continue;
      const end = i + count - 1;
      if (end < list.length && hashOf(end) === last.sha256 && list[end]?.logicalText.slice(0, PRINT_TEXT) === last.text) {
        const paragraphs = list.slice(i, end + 1);
        if (joinedHash(paragraphs) === a.print.sha256) {
          full.push(foundAt(parentPath, i, list, count));
          continue;
        }
      }
      if (changed || count < 2) continue;
      // 끝 문단이 앞 문단 뒤 일정 길이 안에 있으면 안쪽만 바뀐 것으로 본다
      for (let b = i + 1; b < list.length && b - i + 1 <= changedSpan(count); b++) {
        if (hashOf(b) === last.sha256) {
          changed = true;
          break;
        }
      }
    }
  }
  const only = full[0];
  if (full.length === 1 && only !== undefined) return { state: "relocated", found: only };
  if (full.length > 1) return { state: "ambiguous", count: full.length };
  return changed ? { state: "changed" } : { state: "notFound", noSection: false };
}

/**
 * 범위 안 문단들의 누름틀 시작·끝 짝이 범위 안에서 닫히지 않으면 닫히지 않은 시작 수와 끝 수를 돌려준다(7.2의 `FRAG_SPLITS_FIELD`와 같은 판정).
 * 같은 id로 겹쳐 열린 시작은 안쪽 것부터 닫힌다. 짝이 모두 닫히면 undefined.
 */
export function splitsField(paragraphs: readonly ParagraphNode[]): { begins: number; ends: number } | undefined {
  const opened = new Map<string, number>();
  let ends = 0;
  for (const p of paragraphs) {
    for (const el of walkElements(p.element)) {
      if (elIs(el, "paragraph", "fieldBegin")) {
        const id = attrValue(el, "id") ?? "";
        opened.set(id, (opened.get(id) ?? 0) + 1);
      } else if (elIs(el, "paragraph", "fieldEnd")) {
        const id = attrValue(el, "beginIDRef") ?? "";
        const n = opened.get(id) ?? 0;
        if (n === 0) ends++;
        else opened.set(id, n - 1);
      }
    }
  }
  const begins = [...opened.values()].reduce((sum, n) => sum + n, 0);
  return begins > 0 || ends > 0 ? { begins, ends } : undefined;
}
