import { attrValue, elementChildren, elIs, isElement, walkElements, type XElement } from "../xml/tree.ts";
import { spanEdit, type EntryDoc } from "./entries.ts";
import { emptyPart, type PlanPart } from "./types.ts";

/**
 * 한 문단의 줄 시작 위치가 가질 수 있는 최댓값(HWP 문자 위치 단위).
 * 글은 UTF-16 단위로 1칸씩 세고, 탭·개체·컨트롤 같은 확장 문자는 8칸씩 센다(컨트롤 요소 하나에 여러 자식이 있으면 자식마다 8칸).
 * 줄 시작 위치는 문단 끝 표지 뒤(글 길이 + 1)까지 올 수 있다.
 * 모델의 논리 텍스트 길이는 개체를 한 글자로만 세므로 이 기준으로는 쓸 수 없다(실제 문서의 개체 든 문단 2,000여 개가 그 길이를 넘는다).
 */
export function maxLineStart(paragraph: XElement): number {
  let n = 1;
  for (const run of elementChildren(paragraph)) {
    if (!elIs(run, "paragraph", "run")) continue;
    for (const part of run.children) {
      if (!isElement(part)) continue;
      if (elIs(part, "paragraph", "t")) {
        for (const c of part.children) n += isElement(c) ? 8 : c.value.length;
      } else if (elIs(part, "paragraph", "ctrl")) {
        n += 8 * Math.max(1, elementChildren(part).length);
      } else {
        n += 8;
      }
    }
  }
  return n;
}

/** 줄 배치 캐시가 문단의 위치 범위 밖을 가리키는 문단의 수 */
function countStaleParagraphs(doc: EntryDoc): number {
  let stale = 0;
  for (const p of walkElements(doc.root)) {
    if (!elIs(p, "paragraph", "p")) continue;
    const array = elementChildren(p).find((c) => elIs(c, "paragraph", "linesegarray"));
    if (array === undefined) continue;
    const limit = maxLineStart(p);
    const beyond = elementChildren(array).some((seg) => {
      const pos = attrValue(seg, "textpos");
      return pos !== undefined && /^\d+$/.test(pos) && Number(pos) > limit;
    });
    if (beyond) stale++;
  }
  return stale;
}

/**
 * 줄 배치 캐시(`linesegarray`)의 `textpos`가 문단의 위치 범위를 벗어나는 문단이 있는 구역에서 캐시 요소를 전부 지운다.
 * 캐시는 한컴이 다시 계산하는 값이다.
 */
export function planDropStaleLineSeg(sections: EntryDoc[]): PlanPart {
  const part = emptyPart();
  for (const doc of sections) {
    const stale = countStaleParagraphs(doc);
    if (stale === 0) continue;
    let removed = 0;
    for (const el of walkElements(doc.root)) {
      if (!elIs(el, "paragraph", "linesegarray")) continue;
      part.edits.push(spanEdit(doc, el.start, el.end, "", "낡은 줄 배치 캐시 제거"));
      removed++;
    }
    part.notes.push({
      kind: "dropStaleLineSeg",
      entry: doc.entry,
      what: "linesegarray",
      count: removed,
      detail: `문단 위치 범위를 벗어난 캐시가 있는 문단 ${stale}개`,
    });
  }
  return part;
}
