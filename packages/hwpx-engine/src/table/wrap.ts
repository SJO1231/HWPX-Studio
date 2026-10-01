import { escapeAttr } from "../xml/chars.ts";
import { tokenize } from "../xml/tokenizer.ts";
import { buildTree, type XElement } from "../xml/tree.ts";

const WRAPPER = "tableCloneRoot";

/** 요소가 선언한 네임스페이스 접두사 → URI(기본 네임스페이스는 빈 접두사) */
export function declsOf(root: XElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of root.attrs) {
    if (a.qname === "xmlns") out.set("", a.value);
    else if (a.qname.startsWith("xmlns:")) out.set(a.qname.slice(6), a.value);
  }
  return out;
}

/**
 * 복사본 원문(문단이나 행 같은 조각)을 접두사 선언을 단 가짜 뿌리 요소로 감싸 읽는다.
 * `text`는 감싼 전체 텍스트이고 `offset`은 그 안에서 원문이 시작하는 위치다.
 */
export function wrapXml(xml: string, decls: ReadonlyMap<string, string>): { text: string; root: XElement; offset: number } {
  let attrs = "";
  for (const [prefix, uri] of decls) attrs += prefix === "" ? ` xmlns="${escapeAttr(uri)}"` : ` xmlns:${prefix}="${escapeAttr(uri)}"`;
  const open = `<${WRAPPER}${attrs}>`;
  const text = `${open}${xml}</${WRAPPER}>`;
  return { text, root: buildTree(text, tokenize(text)), offset: open.length };
}

/** `wrapXml`로 감싼 텍스트에서 원문만 꺼낸다. */
export function unwrapXml(text: string, offset: number): string {
  return text.slice(offset, text.length - `</${WRAPPER}>`.length);
}
