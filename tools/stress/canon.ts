// 엔진의 fingerprintResource·collectBodyRefs와 별도로 만든 독립 기준.
// 자원 요소를 참조까지 전개해 정규 문자열로 만들고(엔진은 참조를 대상의 지문으로 바꿔 해시한다), 본문 참조와 글을 원문에서 직접 뽑는다.
import { createHash } from "node:crypto";
import { findEntry, readEntry, walkElements, type HwpxDocument, type XElement } from "../../packages/hwpx-engine/src/index.ts";

const FONT_ATTR_LANG: Record<string, string> = {
  hangul: "HANGUL",
  latin: "LATIN",
  hanja: "HANJA",
  japanese: "JAPANESE",
  other: "OTHER",
  symbol: "SYMBOL",
  user: "USER",
};

const LIST_ITEM: Record<string, [kind: string, item: string]> = {
  borderFills: ["borderFill", "borderFill"],
  charProperties: ["charPr", "charPr"],
  tabProperties: ["tabPr", "tabPr"],
  numberings: ["numbering", "numbering"],
  bullets: ["bullet", "bullet"],
  paraProperties: ["paraPr", "paraPr"],
  styles: ["style", "style"],
};

const NO_REF = new Set(["4294967295", "-1"]);
const localName = (qname: string): string => qname.slice(qname.indexOf(":") + 1);
const children = (el: XElement): XElement[] => el.children.filter((c): c is XElement => "local" in c);

const sha = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export type Canon = {
  /** 자원(종류·언어·id)의 참조 전개 문자열. 대상이 없으면 `<missing:…>`가 안에 들어 있다. */
  resource(kind: string, lang: string | undefined, id: string): string;
  /** 본문 참조 하나의 전개. 이진 자료는 내용의 sha256이다. */
  bodyRef(kind: string, id: string): string;
};

/** 본문 요소가 가리키는 자원 종류. `binaryItem`은 이진 자료. */
const BODY_ATTR: Record<string, string> = {
  charPrIDRef: "charPr",
  paraPrIDRef: "paraPr",
  styleIDRef: "style",
  borderFillIDRef: "borderFill",
  outlineShapeIDRef: "numbering",
  binaryItemIDRef: "binaryItem",
};

export type BodyRefLite = { kind: string; id: string };

/** 요소들 아래의 본문 참조(자원 id)를 문서 순서로 모은다. "참조 없음" 관례값은 뺀다. */
export function bodyRefsOf(roots: readonly XElement[]): BodyRefLite[] {
  const out: BodyRefLite[] = [];
  for (const root of roots) {
    for (const el of walkElements(root)) {
      for (const a of el.attrs) {
        const kind = BODY_ATTR[a.qname.slice(a.qname.lastIndexOf(":") + 1)];
        if (kind !== undefined && !NO_REF.has(a.value)) out.push({ kind, id: a.value });
      }
    }
  }
  return out;
}

export function makeCanon(doc: HwpxDocument): Canon {
  // header의 목록을 원문 트리에서 직접 훑어 (종류, 언어, id) → 요소 색인을 만든다. 같은 id가 겹치면 앞의 것.
  const index = new Map<string, XElement>();
  const key = (kind: string, lang: string | undefined, id: string): string => `${kind}\u0000${lang ?? ""}\u0000${id}`;
  const refList = children(doc.header.root).find((c) => c.local === "refList");
  for (const list of refList === undefined ? [] : children(refList)) {
    if (list.local === "fontfaces") {
      for (const face of children(list)) {
        const lang = face.attrs.find((a) => a.qname === "lang")?.value ?? "";
        for (const font of children(face)) {
          const id = font.attrs.find((a) => a.qname === "id")?.value;
          if (id !== undefined && !index.has(key("font", lang, id))) index.set(key("font", lang, id), font);
        }
      }
      continue;
    }
    const known = LIST_ITEM[list.local];
    if (known === undefined) continue;
    for (const item of children(list)) {
      if (item.local !== known[1]) continue;
      const id = item.attrs.find((a) => a.qname === "id")?.value;
      if (id !== undefined && !index.has(key(known[0], undefined, id))) index.set(key(known[0], undefined, id), item);
    }
  }

  const binaryHash = new Map<string, string>();
  const binary = (id: string): string => {
    const hit = binaryHash.get(id);
    if (hit !== undefined) return hit;
    const item = doc.pkg.manifestItems.find((m) => m.id === id);
    const present = item !== undefined && findEntry(doc.pkg.archive, item.href) !== undefined;
    const value = present ? `bin:${sha(readEntry(doc.pkg.archive, doc.pkg.bytes, item.href))}` : `<missing:bin:${id}>`;
    binaryHash.set(id, value);
    return value;
  };

  const memo = new Map<string, string>();

  // 참조 속성의 대상 종류(없으면 undefined). 자원 종류와 요소 이름·속성 이름으로 정한다.
  const targetOf = (kind: string, el: XElement, root: boolean, attr: string): { kind: string; lang?: string } | undefined => {
    if (attr === "binaryItemIDRef") return { kind: "binaryItem" };
    const name = el.local;
    if (kind === "charPr") {
      if (name === "charPr" && attr === "borderFillIDRef") return { kind: "borderFill" };
      if (name === "fontRef" && FONT_ATTR_LANG[attr] !== undefined) return { kind: "font", lang: FONT_ATTR_LANG[attr] as string };
    } else if (kind === "paraPr") {
      if (name === "paraPr" && attr === "tabPrIDRef") return { kind: "tabPr" };
      if (name === "border" && attr === "borderFillIDRef") return { kind: "borderFill" };
      if (name === "heading" && attr === "idRef") {
        const type = el.attrs.find((a) => a.qname === "type")?.value;
        if (type === "NUMBER") return { kind: "numbering" };
        if (type === "BULLET") return { kind: "bullet" };
      }
    } else if (kind === "style" && root) {
      if (attr === "paraPrIDRef") return { kind: "paraPr" };
      if (attr === "charPrIDRef") return { kind: "charPr" };
      if (attr === "nextStyleIDRef") return { kind: "style" };
    } else if ((kind === "numbering" || kind === "bullet") && attr === "charPrIDRef") {
      return { kind: "charPr" };
    }
    return undefined;
  };

  const expand = (kind: string, lang: string | undefined, id: string, stack: string[]): string => {
    const k = key(kind, lang, id);
    const el = index.get(k);
    if (el === undefined) return `<missing:${kind}:${id}>`;
    const at = stack.indexOf(k);
    if (at >= 0) return `<cycle:${stack.length - at}>`;
    const cached = memo.get(k);
    if (cached !== undefined) return cached;
    const inner = [...stack, k];
    const walk = (node: XElement, root: boolean): unknown => {
      const attrs: [string, string][] = [];
      for (const a of node.attrs) {
        if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) continue;
        const name = localName(a.qname);
        if (root && name === "id") continue;
        let value = a.value;
        const t = NO_REF.has(value) ? undefined : targetOf(kind, node, root, name);
        if (t !== undefined) value = t.kind === "binaryItem" ? binary(value) : expand(t.kind, t.lang, value, inner);
        else if (root && kind === "style" && name === "name") value = value.replace(/ \(\d+\)$/, "");
        attrs.push([name, value]);
      }
      attrs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
      const kids: unknown[] = [];
      let text = "";
      const flush = (): void => {
        if (text.trim() !== "") kids.push(text.trim());
        text = "";
      };
      for (const c of node.children) {
        if ("local" in c) {
          flush();
          kids.push(walk(c, false));
        } else {
          text += c.value;
        }
      }
      flush();
      return [node.local, attrs, kids];
    };
    const result = JSON.stringify([kind, lang ?? "", walk(el, true)]);
    if (!result.includes("<cycle:")) memo.set(k, result);
    return result;
  };

  return {
    resource: (kind, lang, id) => expand(kind, lang, id, []),
    bodyRef: (kind, id) => (kind === "binaryItem" ? binary(id) : expand(kind, undefined, id, [])),
  };
}

// ── 원문에서 글 뽑기 ───────────────────────────────────────────

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeText(raw: string): string {
  return raw.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (_m, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return ENTITIES[name] ?? "";
    const code = dec !== undefined ? Number(dec) : parseInt(hex ?? "0", 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** 접두사와 무관하게 `<…:t>`(자기닫힘 제외) 안의 글을 문서 순서로 정규식만으로 뽑는다. 안쪽 태그는 뺀다. CDATA는 그대로 둔다. */
export function textRuns(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?t(?:\s(?:[^>]*[^>/])?)?>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g)) {
    const inner = (m[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_x, c: string) => c.replace(/&/g, "&amp;"));
    out.push(decodeText(inner.replace(/<[^>]+>/g, "")));
  }
  return out;
}

/** 구역·header 원문에서 이진 자료 참조 id를 뽑는다. */
export function binaryRefsIn(xml: string): string[] {
  return [...xml.matchAll(/\sbinaryItemIDRef="([^"]*)"/g)].map((m) => m[1] ?? "");
}
