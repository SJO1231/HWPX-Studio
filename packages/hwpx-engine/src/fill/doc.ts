import { walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, ObjectNode, ParagraphNode, Piece, SectionModel } from "../model/types.ts";
import { subElements, elIs, walkElements, type XElement } from "../xml/tree.ts";

/** 문단 주소 `[문단, 하위목록, 문단, ...]`(홀수 길이)가 가리키는 문단. */
export function paragraphAtPath(section: SectionModel, path: number[]): ParagraphNode | undefined {
  if (path.length % 2 === 0 || path.length === 0) return undefined;
  let list = section.paragraphs;
  let paragraph: ParagraphNode | undefined;
  for (let n = 0; n < path.length; n++) {
    const i = path[n] ?? -1;
    if (n % 2 === 0) {
      paragraph = list[i];
      if (paragraph === undefined) return undefined;
    } else {
      const sub = paragraph?.subLists[i];
      if (sub === undefined) return undefined;
      list = sub.paragraphs;
    }
  }
  return paragraph;
}

/** 문단이 든 목록(같은 부모 아래 형제 문단들). */
export function siblingsAtPath(section: SectionModel, path: number[]): ParagraphNode[] | undefined {
  if (path.length === 1) return section.paragraphs;
  const parent = paragraphAtPath(section, path.slice(0, -2));
  return parent?.subLists[path[path.length - 2] ?? -1]?.paragraphs;
}

export function* eachParagraph(doc: HwpxDocument): Generator<{ section: SectionModel; paragraph: ParagraphNode }> {
  for (const section of doc.sections) {
    for (const paragraph of walkParagraphs(section.paragraphs)) yield { section, paragraph };
  }
}

export const startKey = (entry: string, start: number): string => `${entry}\u0000${start}`;

/** 구역 파일 이름과 문단 요소의 시작 오프셋으로 문단을 찾는 색인. */
export function paragraphIndex(doc: HwpxDocument): Map<string, { section: SectionModel; paragraph: ParagraphNode }> {
  const map = new Map<string, { section: SectionModel; paragraph: ParagraphNode }>();
  for (const x of eachParagraph(doc)) map.set(startKey(x.section.entryName, x.paragraph.element.start), x);
  return map;
}

/** 글을 가진 조각(text·entity)인가. */
export const isTextPiece = (p: Piece): boolean => p.kind === "text" || p.kind === "entity";

/** 구역 설정(`secPr`)과 단 설정(`ctrl` 안의 `colPr`만 든 것)은 글의 위치와 상관없는 구조라 객체로 세지 않는다. */
function isStructural(o: ObjectNode): boolean {
  if (elIs(o.element, "paragraph", "secPr")) return true;
  if (!elIs(o.element, "paragraph", "ctrl")) return false;
  const kids = subElements(o.element);
  return kids.length > 0 && kids.every((k) => elIs(k, "paragraph", "colPr"));
}

/** 문단 직속 run 안의 내용 객체(표·그림·누름틀 컨트롤 등). 구역 설정과 단 설정은 뺀다. */
export function contentObjects(p: ParagraphNode): ObjectNode[] {
  return p.objects.filter((o) => !isStructural(o));
}

export function hasSecPr(p: ParagraphNode): boolean {
  for (const el of walkElements(p.element)) if (elIs(el, "paragraph", "secPr")) return true;
  return false;
}

/** 요소 `el`의 이름 앞 접두사 표기(`hp:`). 접두사가 없으면 빈 문자열. */
export const nsPrefixOf = (el: XElement): string => (el.prefix === "" ? "" : `${el.prefix}:`);

/** 구역 최상위 문단들에서 그 종류의 객체가 나타나는 순서대로 모은다. */
export function topLevelObjects(section: SectionModel, type: string): { paragraph: ParagraphNode; object: ObjectNode }[] {
  const out: { paragraph: ParagraphNode; object: ObjectNode }[] = [];
  for (const paragraph of section.paragraphs) {
    for (const object of paragraph.objects) if (object.type === type) out.push({ paragraph, object });
  }
  return out;
}

/** 구간 목록을 논리 텍스트에 적용한다(구간은 서로 겹치지 않아야 한다). */
export type Repl = { start: number; end: number; text: string };
export function applyRepls(text: string, repls: Repl[]): string {
  const sorted = [...repls].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    out += text.slice(pos, r.start) + r.text;
    pos = r.end;
  }
  return out + text.slice(pos);
}

/** 위치 `pos`를 편집들이 지난 뒤의 위치로 옮긴다(`pos` 앞에서 끝나는 편집만 센다). */
export function mapPos(edits: { start: number; end: number; replacement: string }[], pos: number): number {
  let shift = 0;
  for (const e of edits) if (e.end <= pos) shift += e.replacement.length - (e.end - e.start);
  return pos + shift;
}

/** 항목들을 키별 배열로 묶는다(순서 유지). */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list === undefined) out.set(k, [item]);
    else list.push(item);
  }
  return out;
}

/**
 * `mapPos`와 같은 결과를 내는 함수를 만든다. 편집을 끝 위치순으로 정렬하고 누적 증감을 미리 계산해 두어
 * 위치마다 이진 탐색 한 번으로 옮긴다(위치가 많을 때 `mapPos`를 반복하면 제곱으로 는다).
 */
export function makeMapper(edits: { start: number; end: number; replacement: string }[]): (pos: number) => number {
  const sorted = [...edits].sort((a, b) => a.end - b.end);
  const ends = sorted.map((e) => e.end);
  const total: number[] = [];
  let sum = 0;
  for (const e of sorted) {
    sum += e.replacement.length - (e.end - e.start);
    total.push(sum);
  }
  return (pos) => {
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((ends[mid] ?? Infinity) <= pos) lo = mid + 1;
      else hi = mid;
    }
    return pos + (lo === 0 ? 0 : (total[lo - 1] ?? 0));
  };
}
