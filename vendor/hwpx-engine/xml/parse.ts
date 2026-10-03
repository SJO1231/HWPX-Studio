import { HwpxError } from "../errors.ts";
import { tokenize, type Token } from "./tokenizer.ts";
import { buildTree, type XElement } from "./tree.ts";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** UTF-8 치명 모드로 해독한다. BOM은 문자 U+FEFF로 남겨 보존한다. */
export function decodeUtf8(bytes: Uint8Array, where?: string): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw new HwpxError("XML_ENCODING", "UTF-8로 해독할 수 없습니다.", where);
  }
}

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export type ParsedXml = { text: string; tokens: Token[]; root: XElement };

/** 바이트를 해독해 토큰과 트리를 만든다. XML 오류의 where에 항목 이름을 붙인다. */
export function parseXmlBytes(bytes: Uint8Array, entryName: string): ParsedXml {
  const text = decodeUtf8(bytes, entryName);
  try {
    const tokens = tokenize(text);
    return { text, tokens, root: buildTree(text, tokens) };
  } catch (e) {
    if (e instanceof HwpxError && e.code.startsWith("XML_")) {
      throw new HwpxError(e.code, `${entryName}: ${e.message}`, e.where === undefined ? entryName : `${entryName}:${e.where}`);
    }
    throw e;
  }
}
