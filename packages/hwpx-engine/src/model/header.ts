import type { XElement } from "../xml/tree.ts";
import { attrNode, attrValue, childEl, elementChildren, elIs, nsRole, walkElements } from "../xml/tree.ts";
import {
  FONT_LANGS,
  type CountSlot,
  type HeaderModel,
  type ResourceItem,
  type ResourceKind,
  type ResourceRef,
} from "./types.ts";

// refList 안의 알려진 목록: 목록 요소 → [자원 종류, 항목 요소]
const KNOWN_LISTS = new Map<string, [ResourceKind, string]>([
  ["borderFills", ["borderFill", "borderFill"]],
  ["charProperties", ["charPr", "charPr"]],
  ["tabProperties", ["tabPr", "tabPr"]],
  ["numberings", ["numbering", "numbering"]],
  ["bullets", ["bullet", "bullet"]],
  ["paraProperties", ["paraPr", "paraPr"]],
  ["styles", ["style", "style"]],
]);

function makeRef(kind: ResourceKind, element: XElement, attrName: string, lang?: string): ResourceRef | null {
  const attr = attrNode(element, attrName);
  if (attr === undefined) return null;
  const ref: ResourceRef = { kind, id: attr.value, element, attr };
  if (lang !== undefined) ref.lang = lang;
  return ref;
}

function addRef(refs: ResourceRef[], ref: ResourceRef | null): void {
  if (ref !== null) refs.push(ref);
}

function charPrRefs(item: XElement): ResourceRef[] {
  const refs: ResourceRef[] = [];
  const fontRef = childEl(item, "head", "fontRef");
  if (fontRef !== undefined) {
    for (const lang of FONT_LANGS) addRef(refs, makeRef("font", fontRef, lang.toLowerCase(), lang));
  }
  addRef(refs, makeRef("borderFill", item, "borderFillIDRef"));
  return refs;
}

function paraPrRefs(item: XElement): ResourceRef[] {
  const refs: ResourceRef[] = [];
  addRef(refs, makeRef("tabPr", item, "tabPrIDRef"));
  for (const el of walkElements(item)) {
    if (elIs(el, "head", "heading")) {
      const type = attrValue(el, "type");
      if (type === "NUMBER") addRef(refs, makeRef("numbering", el, "idRef"));
      else if (type === "BULLET") addRef(refs, makeRef("bullet", el, "idRef"));
    } else if (elIs(el, "head", "border")) {
      addRef(refs, makeRef("borderFill", el, "borderFillIDRef"));
    }
  }
  return refs;
}

function styleRefs(item: XElement): ResourceRef[] {
  const refs: ResourceRef[] = [];
  addRef(refs, makeRef("paraPr", item, "paraPrIDRef"));
  addRef(refs, makeRef("charPr", item, "charPrIDRef"));
  addRef(refs, makeRef("style", item, "nextStyleIDRef"));
  return refs;
}

function refsOf(kind: ResourceKind, item: XElement): ResourceRef[] {
  switch (kind) {
    case "charPr":
      return charPrRefs(item);
    case "paraPr":
      return paraPrRefs(item);
    case "style":
      return styleRefs(item);
    default:
      return [];
  }
}

function countSlot(list: XElement, kind: ResourceKind, attrName: string, lang?: string): CountSlot | null {
  const attr = attrNode(list, attrName);
  if (attr === undefined) return null;
  const slot: CountSlot = {
    list: list.local,
    kind,
    element: list,
    attr,
    value: Number(attr.value),
    actual: elementChildren(list).length,
  };
  if (lang !== undefined) slot.lang = lang;
  return slot;
}

export function parseHeader(text: string, root: XElement): HeaderModel {
  const resources: Record<ResourceKind, ResourceItem[]> = {};
  const counts: CountSlot[] = [];
  const add = (item: ResourceItem): void => {
    (resources[item.kind] ??= []).push(item);
  };
  // 알려진 종류는 목록이 없어도 빈 배열로 둔다.
  for (const kind of ["font", "borderFill", "charPr", "tabPr", "numbering", "bullet", "paraPr", "style"]) {
    resources[kind] = [];
  }

  const refList = childEl(root, "head", "refList");
  for (const list of refList === undefined ? [] : elementChildren(refList)) {
    if (elIs(list, "head", "fontfaces")) {
      const slot = countSlot(list, "font", "itemCnt");
      if (slot !== null) counts.push(slot);
      for (const face of elementChildren(list)) {
        if (!elIs(face, "head", "fontface")) continue;
        const lang = attrValue(face, "lang") ?? "";
        const faceSlot = countSlot(face, "font", "fontCnt", lang);
        if (faceSlot !== null) counts.push(faceSlot);
        for (const font of elementChildren(face)) {
          if (!elIs(font, "head", "font")) continue;
          add({ kind: "font", lang, id: attrValue(font, "id") ?? "", element: font, refs: [] });
        }
      }
      continue;
    }
    const known = nsRole(list.ns) === "head" ? KNOWN_LISTS.get(list.local) : undefined;
    const kind = known === undefined ? `other:${list.local}` : known[0];
    const slot = countSlot(list, kind, "itemCnt");
    if (slot !== null) counts.push(slot);
    const items = elementChildren(list);
    items.forEach((item, index) => {
      if (known !== undefined && !elIs(item, "head", known[1])) return;
      add({ kind, id: attrValue(item, "id") ?? String(index), element: item, refs: refsOf(kind, item) });
    });
  }

  const secAttr = attrNode(root, "secCnt");
  const secCnt = secAttr === undefined ? null : { element: root, attr: secAttr, value: Number(secAttr.value) };
  return { text, root, resources, counts, secCnt };
}
