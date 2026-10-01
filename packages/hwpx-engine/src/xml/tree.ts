import { HwpxError } from "../errors.ts";
import { decodeEntities } from "./chars.ts";
import { lineColumn, type Token, type XAttr } from "./tokenizer.ts";

export type XText = {
  start: number;
  end: number;
  raw: string;
  /** 엔티티를 해독한 값. CDATA 구역이면 표식을 뺀 안쪽 내용 */
  value: string;
};

export type XElement = {
  qname: string;
  prefix: string;
  local: string;
  /** 해석된 네임스페이스 URI. 없으면 빈 문자열 */
  ns: string;
  attrs: XAttr[];
  /** 여는 태그 시작 */
  start: number;
  /** 여는 태그 끝(다음 위치). 안쪽 내용은 [openEnd, closeStart) */
  openEnd: number;
  /** 닫는 태그 시작. 빈 태그면 openEnd와 같다 */
  closeStart: number;
  end: number;
  children: (XElement | XText)[];
  parent: XElement | null;
};

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const NS_ATTR_PREFIX = "xmlns";

const OTHER_ROLES = new Map([
  ["http://www.idpf.org/2007/opf/", "opf"],
  ["urn:oasis:names:tc:opendocument:xmlns:container", "container"],
  ["http://www.hancom.co.kr/schema/2011/hpf", "hpf"],
]);
const HWPML = /^http:\/\/www\.hancom\.co\.kr\/hwpml\/(?:2011|2016)\/([^/]+)$/;
const OWPML = /^http:\/\/www\.owpml\.org\/owpml\/2024\/([^/]+)$/;
const roleCache = new Map<string, string>();

/**
 * 네임스페이스 URI의 역할 이름. 2011·2016·2024 계열은 URI 끝의 역할(paragraph, head 등)로 묶고,
 * 그 밖의 URI는 알려진 짧은 이름이나 URI 자신을 돌려준다.
 */
export function nsRole(uri: string): string {
  let role = roleCache.get(uri);
  if (role === undefined) {
    role = OTHER_ROLES.get(uri) ?? HWPML.exec(uri)?.[1] ?? OWPML.exec(uri)?.[1] ?? uri;
    roleCache.set(uri, role);
  }
  return role;
}

/** 요소가 (네임스페이스 역할, local 이름)과 같은가. 접두사는 비교하지 않는다. */
export function elIs(el: XElement, role: string, local: string): boolean {
  return el.local === local && nsRole(el.ns) === role;
}

/** 자식 노드처럼 종류를 모르는 값에 쓰는 형 판별. */
export function isEl(node: XElement | XText | null | undefined, role: string, local: string): node is XElement {
  return node !== null && node !== undefined && "local" in node && elIs(node, role, local);
}

export function isElement(node: XElement | XText): node is XElement {
  return "local" in node;
}

export function subElements(el: XElement): XElement[] {
  const out: XElement[] = [];
  for (const c of el.children) if (isElement(c)) out.push(c);
  return out;
}

export function childEl(el: XElement, role: string, local: string): XElement | undefined {
  for (const c of el.children) if (isEl(c, role, local)) return c;
  return undefined;
}

export function childEls(el: XElement, role: string, local: string): XElement[] {
  const out: XElement[] = [];
  for (const c of el.children) if (isEl(c, role, local)) out.push(c);
  return out;
}

/** 요소 자신과 모든 후손을 문서 순서로 방문한다. 반복문이라 깊은 트리에서도 호출 스택을 쓰지 않는다. */
export function* walkElements(root: XElement): Generator<XElement> {
  const stack: XElement[] = [root];
  while (stack.length > 0) {
    const el = stack.pop();
    if (el === undefined) break;
    yield el;
    for (let i = el.children.length - 1; i >= 0; i--) {
      const c = el.children[i];
      if (c !== undefined && isElement(c)) stack.push(c);
    }
  }
}

export function attrNode(el: XElement, qname: string): XAttr | undefined {
  return el.attrs.find((a) => a.qname === qname);
}

export function attrValue(el: XElement, qname: string): string | undefined {
  return attrNode(el, qname)?.value;
}

export function buildTree(text: string, tokens: Token[]): XElement {
  let root: XElement | null = null;
  const stack: XElement[] = [];
  const scopes: Map<string, string>[] = [new Map([["xml", XML_NS]])];

  const resolve = (prefix: string, at: number): string => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const uri = scopes[i]?.get(prefix);
      if (uri !== undefined) return uri;
    }
    if (prefix === "") return "";
    const { line, column } = lineColumn(text, at);
    throw new HwpxError("XML_MALFORMED", `선언되지 않은 접두사 '${prefix}' (줄 ${line}, 열 ${column})`, `${line}:${column}`);
  };

  const openElement = (tok: Token): XElement => {
    const attrs = tok.attrs ?? [];
    const decls = new Map<string, string>();
    for (const a of attrs) {
      if (a.qname === NS_ATTR_PREFIX) decls.set("", a.value);
      else if (a.qname.startsWith(NS_ATTR_PREFIX + ":")) decls.set(a.qname.slice(NS_ATTR_PREFIX.length + 1), a.value);
    }
    scopes.push(decls);
    const qname = tok.name ?? "";
    const colon = qname.indexOf(":");
    const prefix = colon < 0 ? "" : qname.slice(0, colon);
    const local = colon < 0 ? qname : qname.slice(colon + 1);
    if (local === "" || local.includes(":")) {
      const { line, column } = lineColumn(text, tok.start);
      throw new HwpxError("XML_MALFORMED", `이름 ${qname}이 네임스페이스 규칙에 맞지 않습니다 (줄 ${line}, 열 ${column})`, `${line}:${column}`);
    }
    const ns = resolve(prefix, tok.start);
    // 접두사가 붙은 속성은 그 접두사가 선언돼 있어야 한다. xmlns 선언은 검사 대상이 아니고, xml: 접두사는 처음부터 선언된 것으로 본다.
    // (기본 네임스페이스는 속성에 적용되지 않으므로 접두사 없는 속성은 볼 것이 없다.)
    for (const a of attrs) {
      if (a.qname === NS_ATTR_PREFIX || a.qname.startsWith(NS_ATTR_PREFIX + ":")) continue;
      const attrColon = a.qname.indexOf(":");
      if (attrColon > 0) resolve(a.qname.slice(0, attrColon), a.nameStart);
    }
    const el: XElement = {
      qname,
      prefix,
      local,
      ns,
      attrs,
      start: tok.start,
      openEnd: tok.end,
      closeStart: tok.end,
      end: tok.end,
      children: [],
      parent: stack[stack.length - 1] ?? null,
    };
    el.parent?.children.push(el);
    return el;
  };

  for (const tok of tokens) {
    switch (tok.kind) {
      case "start": {
        const el = openElement(tok);
        if (root === null) root = el;
        stack.push(el);
        break;
      }
      case "empty": {
        const el = openElement(tok);
        scopes.pop();
        if (root === null) root = el;
        break;
      }
      case "end": {
        const el = stack.pop();
        if (el === undefined) break;
        el.closeStart = tok.start;
        el.end = tok.end;
        scopes.pop();
        break;
      }
      case "text":
      case "cdata": {
        const parent = stack[stack.length - 1];
        if (parent === undefined) break;
        const raw = text.slice(tok.start, tok.end);
        parent.children.push({
          start: tok.start,
          end: tok.end,
          raw,
          value: tok.kind === "cdata" ? raw.slice(9, -3) : decodeEntities(raw),
        });
        break;
      }
      default:
        break;
    }
  }
  if (root === null) throw new HwpxError("XML_MALFORMED", "루트 요소가 없습니다");
  return root;
}
