import { attrValue, walkElements, type HwpxDocument, type ParagraphNode } from "../../../hwpx-engine/src/index.ts";

const cache = new WeakMap<HwpxDocument, Map<string, boolean>>();

/**
 * 문단모양이 문단 머리 번호·글머리표·개요를 가졌는가(`heading`의 `type`이 `NONE`이 아니다).
 * rhwp는 그런 문단의 번호·글머리표 글(`6) ` 같은 것)을 문단 글이 아닌데도 그 문단의 문서 좌표(글자 순번 0)를 붙인 런으로 그린다 [실행 관측].
 */
export function hasNumbering(doc: HwpxDocument, paragraph: ParagraphNode): boolean {
  const id = paragraph.attrs.paraPrIDRef;
  if (id === null) return false;
  let byId = cache.get(doc);
  if (byId === undefined) {
    byId = new Map();
    cache.set(doc, byId);
  }
  const known = byId.get(id);
  if (known !== undefined) return known;
  const item = doc.header.resources["paraPr"]?.find((i) => i.id === id);
  let numbered = false;
  if (item !== undefined) {
    for (const el of walkElements(item.element)) {
      if (el.local !== "heading") continue;
      const type = attrValue(el, "type");
      if (type !== undefined && type !== "NONE") numbered = true;
    }
  }
  byId.set(id, numbered);
  return numbered;
}
