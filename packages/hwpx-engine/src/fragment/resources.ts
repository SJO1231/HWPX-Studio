import type { HwpxDocument, ResourceItem, ResourceRef } from "../model/types.ts";
import { findEntry, readEntry } from "../package/zip-read.ts";
import type { XAttr } from "../xml/tokenizer.ts";
import { attrNode, isElement, walkElements, type XElement } from "../xml/tree.ts";
import { isNoRefOf, sha256Hex } from "./util.ts";

/** 지문 계산이 다른 자원과 이진 자료를 찾는 방법 */
export type FingerprintLookup = {
  resource(kind: string, lang: string | undefined, id: string): ResourceItem | undefined;
  /** 이진 자료 항목(manifest id)의 내용 sha256. 항목이나 내용이 없으면 undefined */
  binary(id: string): string | undefined;
};

const keyOf = (kind: string, lang: string | undefined, id: string): string => JSON.stringify([kind, lang ?? "", id]);

/**
 * 문서의 자원 색인. `id` 속성이 있는 자원만 대상이 된다(같은 id가 겹치면 앞의 것).
 * 이진 자료의 해시는 처음 물을 때 계산해 둔다.
 */
export function makeLookup(doc: HwpxDocument): FingerprintLookup {
  const index = new Map<string, ResourceItem>();
  for (const items of Object.values(doc.header.resources)) {
    for (const item of items) {
      if (attrNode(item.element, "id") === undefined) continue;
      const key = keyOf(item.kind, item.lang, item.id);
      if (!index.has(key)) index.set(key, item);
    }
  }
  const hashes = new Map<string, string | undefined>();
  const { pkg } = doc;
  return {
    resource: (kind, lang, id) => index.get(keyOf(kind, lang, id)),
    binary: (id) => {
      if (!hashes.has(id)) {
        const item = pkg.manifestItems.find((m) => m.id === id);
        const present = item !== undefined && findEntry(pkg.archive, item.href) !== undefined;
        hashes.set(id, present ? sha256Hex(readEntry(pkg.archive, pkg.bytes, item.href)) : undefined);
      }
      return hashes.get(id);
    },
  };
}

/**
 * 자원이 가리키는 다른 자원·이진 자료. 모델의 ResourceRef에 더해, 이진 자료를 가리키는 `binaryItemIDRef`(예: 이미지 채우기)와
 * 번호·글머리표 모양이 가리키는 글자모양(`charPrIDRef`)도 의존으로 본다. "참조 없음"(관례값, 빈 이진 자료 참조)은 뺀다.
 */
export function resourceRefs(item: ResourceItem): ResourceRef[] {
  const refs: ResourceRef[] = [...item.refs];
  for (const el of walkElements(item.element)) {
    for (const attr of el.attrs) {
      if (attr.qname === "binaryItemIDRef") refs.push({ kind: "binaryItem", id: attr.value, element: el, attr });
      else if (attr.qname === "charPrIDRef" && (item.kind === "numbering" || item.kind === "bullet")) {
        refs.push({ kind: "charPr", id: attr.value, element: el, attr });
      }
    }
  }
  return refs.filter((r) => !isNoRefOf(r.kind, r.id));
}

// ── 지문 ────────────────────────────────────────────────────────

type Canon = string | [string, [string, string][], ...Canon[]];

// 스타일 이름이 충돌해 붙인 ` (2)` 같은 접미사는 지문에서 뺀다(가져온 스타일을 다시 가져올 때 재사용되도록)
const STYLE_SUFFIX = / \(\d+\)$/;

function canonical(el: XElement, refFp: Map<XAttr, string>, isRoot: boolean, kind: string): Canon {
  const attrs: [string, string][] = [];
  for (const a of el.attrs) {
    if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) continue;
    const name = a.qname.slice(a.qname.indexOf(":") + 1);
    if (isRoot && name === "id") continue;
    let value = refFp.get(a) ?? a.value;
    if (isRoot && kind === "style" && name === "name") value = value.replace(STYLE_SUFFIX, "");
    attrs.push([name, value]);
  }
  attrs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const kids: Canon[] = [];
  let text = "";
  const flush = (): void => {
    const trimmed = text.trim();
    if (trimmed !== "") kids.push(trimmed);
    text = "";
  };
  for (const c of el.children) {
    if (isElement(c)) {
      flush();
      kids.push(canonical(c, refFp, false, kind));
    } else {
      text += c.value;
    }
  }
  flush();
  return [el.local, attrs, ...kids];
}

/**
 * 같은 `lookup`으로 여러 자원의 지문을 구할 때 쓰는 계산기. 결과를 기억해 둔다.
 * 순환 참조(스타일의 nextStyleIDRef가 자기 자신 등)는 `cycle:<거리>`로 적어 id에 의존하지 않게 한다.
 */
export function createFingerprinter(lookup: FingerprintLookup): (item: ResourceItem) => string {
  const memo = new Map<XElement, string>();
  const stack: ResourceItem[] = [];

  // open: 이 자원을 계산하는 동안 닿은, 아직 계산 중인 조상 가운데 가장 바깥의 스택 위치(없으면 Infinity)
  const compute = (item: ResourceItem): { fp: string; open: number } => {
    const cached = memo.get(item.element);
    if (cached !== undefined) return { fp: cached, open: Infinity };
    const index = stack.length;
    stack.push(item);
    let open = Infinity;
    const refFp = new Map<XAttr, string>();
    for (const ref of resourceRefs(item)) {
      if (ref.kind === "binaryItem") {
        const hash = lookup.binary(ref.id);
        refFp.set(ref.attr, hash ?? `missing:${ref.id}`);
        continue;
      }
      const target = lookup.resource(ref.kind, ref.lang, ref.id);
      if (target === undefined) {
        refFp.set(ref.attr, `missing:${ref.id}`);
        continue;
      }
      const at = stack.findIndex((s) => s.element === target.element);
      if (at >= 0) {
        refFp.set(ref.attr, `cycle:${stack.length - at}`);
        open = Math.min(open, at);
      } else {
        const sub = compute(target);
        refFp.set(ref.attr, sub.fp);
        open = Math.min(open, sub.open);
      }
    }
    stack.pop();
    const fp = sha256Hex(JSON.stringify([item.kind, item.lang ?? "", canonical(item.element, refFp, true, item.kind)]));
    if (open >= index) memo.set(item.element, fp);
    return { fp, open };
  };

  return (item) => compute(item).fp;
}

/**
 * 자원의 지문: 요소의 정규 문자열의 SHA-256(16진). 정규 문자열은 local 이름, 속성(이름순, 접두사 제외, 자신의 id 제외),
 * 자식(문서 순서), 글자 데이터(앞뒤 공백 제거)로 만든다. 다른 자원을 가리키는 속성값은 대상의 지문으로 바꾸고
 * 대상이 없으면 `missing:<id>`로 적는다. 같은 모양의 자원은 문서가 달라도 같은 지문을 갖는다.
 */
export function fingerprintResource(item: ResourceItem, lookup: FingerprintLookup): string {
  return createFingerprinter(lookup)(item);
}
