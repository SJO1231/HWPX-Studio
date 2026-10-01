import type { SpanEdit } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";
import { findEntry, readEntry, type Archive } from "../package/zip-read.ts";
import { isXmlCodePoint } from "../xml/chars.ts";
import { decodeUtf8 } from "../xml/parse.ts";
import { tokenize, type Token, type XAttr } from "../xml/tokenizer.ts";
import { buildTree, type XElement } from "../xml/tree.ts";

/** 검사기가 header로 보는 항목 */
export const HEADER_ENTRY = "Contents/header.xml";

/** 구역 이름의 숫자 부분. 숫자가 아닌 이름은 뒤로 보낸다. */
const SECTION_NUMBER = /^Contents\/section(\d+)\.xml$/i;

/** 검사기가 구역으로 보는 항목(`Contents/section*.xml`)의 이름. 번호 순서(숫자 비교)로 놓는다. */
export function sectionEntryNames(archive: Archive): string[] {
  const names = archive.entries
    .filter((e) => !e.isDirectory && e.name.startsWith("Contents/section") && e.name.toLowerCase().endsWith(".xml"))
    .map((e) => e.name);
  const number = (name: string): number => {
    const m = SECTION_NUMBER.exec(name);
    return m === null ? Number.POSITIVE_INFINITY : Number(m[1]);
  };
  return names.sort((a, b) => {
    const na = number(a);
    const nb = number(b);
    if (na !== nb) return na < nb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * XML 항목 하나의 해독 결과. 오프셋은 `applyPlan`이 쓰는 원문(`original`)의 UTF-16 단위와 같다.
 * 금지 문자가 있어 토크나이저가 거부하는 항목은 그 자리를 같은 길이의 공백으로 바꾼 `text`로 트리를 만들므로 오프셋이 원문과 같다.
 */
export type EntryDoc = {
  entry: string;
  original: string;
  text: string;
  root: XElement;
  /** 지울 금지 문자 구간(글 데이터 안에 있는 것만). 문자 그대로인 것(`char`)과 숫자 참조(`ref`)를 합쳐 센다. */
  strips: { start: number; end: number; chars: number; refs: number }[];
};

export type SkippedEntry = { entry: string; reason: string };

export type Loaded = {
  archive: Archive;
  header: EntryDoc | null;
  sectionNames: string[];
  /** 해독에 성공한 구역(번호 순서) */
  sections: EntryDoc[];
  skipped: SkippedEntry[];
};

// 문자 그대로인 금지 문자. 짝이 맞지 않는 서로게이트는 올바른 UTF-8 해독에서 나올 수 없다.
const ILLEGAL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]+/g;
// 금지된 코드 포인트를 가리킬 수 있는 숫자 참조(소문자 x만 정형이다)
const NUMERIC_REF = /&#(?:x([0-9a-fA-F]+)|([0-9]+));/g;

type Found = { start: number; end: number; literal: boolean };

function findIllegal(text: string): Found[] {
  const found: Found[] = [];
  for (const m of text.matchAll(ILLEGAL_CHAR)) found.push({ start: m.index, end: m.index + m[0].length, literal: true });
  for (const m of text.matchAll(NUMERIC_REF)) {
    const cp = m[1] !== undefined ? Number.parseInt(m[1], 16) : Number.parseInt(m[2] ?? "", 10);
    if (!isXmlCodePoint(cp)) found.push({ start: m.index, end: m.index + m[0].length, literal: false });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** `pos`를 덮는 토큰. 토큰은 입력을 빈틈없이 덮는다. */
function tokenAt(tokens: Token[], pos: number): Token | undefined {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid];
    if (t === undefined) return undefined;
    if (pos < t.start) hi = mid - 1;
    else if (pos >= t.end) lo = mid + 1;
    else return t;
  }
  return undefined;
}

function parseTree(text: string): { tokens: Token[]; root: XElement } {
  const tokens = tokenize(text);
  return { tokens, root: buildTree(text, tokens) };
}

/**
 * 항목 하나를 해독한다. 금지 문자가 글 데이터 안에만 있으면 그 구간을 `strips`에 담는다(`allowStrip`일 때).
 * 읽을 수 없으면 사유 코드를 돌려준다. 금지 문자가 태그·속성·주석에 있는 항목은 지우면 구조를 건드리므로 읽지 않는다.
 */
function analyze(entry: string, original: string, allowStrip: boolean): EntryDoc | string {
  try {
    const { root } = parseTree(original);
    return { entry, original, text: original, root, strips: [] };
  } catch (e) {
    if (!(e instanceof HwpxError)) throw e;
    if (e.code !== "XML_ILLEGAL_CHAR" || !allowStrip) return e.code;
  }

  const found = findIllegal(original);
  let blanked = original;
  for (const f of found) blanked = blanked.slice(0, f.start) + " ".repeat(f.end - f.start) + blanked.slice(f.end);
  let parsed: { tokens: Token[]; root: XElement };
  try {
    parsed = parseTree(blanked);
  } catch (e) {
    if (!(e instanceof HwpxError)) throw e;
    return e.code === "XML_ILLEGAL_CHAR" ? "XML_MALFORMED" : e.code;
  }

  const strips: EntryDoc["strips"] = [];
  for (const f of found) {
    const kind = tokenAt(parsed.tokens, f.start)?.kind;
    const inText = kind === "text" || (f.literal && kind === "cdata");
    // 주석·CDATA·처리 명령 안의 숫자 참조는 문자로 해독되지 않으므로 금지 문자가 아니다.
    const harmless = !f.literal && (kind === "comment" || kind === "cdata" || kind === "pi");
    if (harmless) continue;
    if (!inText) return "XML_ILLEGAL_CHAR";
    const last = strips[strips.length - 1];
    if (last !== undefined && last.end === f.start) {
      last.end = f.end;
      if (f.literal) last.chars += f.end - f.start;
      else last.refs++;
    } else {
      strips.push({ start: f.start, end: f.end, chars: f.literal ? f.end - f.start : 0, refs: f.literal ? 0 : 1 });
    }
  }
  return { entry, original, text: blanked, root: parsed.root, strips };
}

/** header와 구역 항목을 읽는다. 읽을 수 없는 항목은 `skipped`에 사유 코드와 함께 남기고 나머지는 계속 처리한다. */
export function loadEntries(bytes: Uint8Array, archive: Archive, allowStrip: boolean): Loaded {
  const skipped: SkippedEntry[] = [];
  const load = (name: string): EntryDoc | null => {
    if (findEntry(archive, name) === undefined) return null;
    let text: string;
    try {
      text = decodeUtf8(readEntry(archive, bytes, name), name);
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      skipped.push({ entry: name, reason: e.code });
      return null;
    }
    const doc = analyze(name, text, allowStrip);
    if (typeof doc === "string") {
      skipped.push({ entry: name, reason: doc });
      return null;
    }
    return doc;
  };
  const header = load(HEADER_ENTRY);
  const sectionNames = sectionEntryNames(archive);
  const sections: EntryDoc[] = [];
  for (const name of sectionNames) {
    const doc = load(name);
    if (doc !== null) sections.push(doc);
  }
  return { archive, header, sectionNames, sections, skipped };
}

/** 원문의 `[start, end)`를 `replacement`로 바꾸는 편집. `expected`는 항상 원문에서 읽는다. */
export function spanEdit(doc: EntryDoc, start: number, end: number, replacement: string, reason: string): SpanEdit {
  return { entry: doc.entry, start, end, expected: doc.original.slice(start, end), replacement, reason };
}

/** 속성값(따옴표 안쪽 원문 구간)을 바꾸는 편집 */
export function attrEdit(doc: EntryDoc, attr: XAttr, replacement: string, reason: string): SpanEdit {
  return spanEdit(doc, attr.valueStart, attr.valueEnd, replacement, reason);
}

/** 속성 이름에서 접두사를 뗀 local 이름 */
export function attrLocal(qname: string): string {
  return qname.slice(qname.lastIndexOf(":") + 1);
}

export function isNsDecl(qname: string): boolean {
  return qname === "xmlns" || qname.startsWith("xmlns:");
}
