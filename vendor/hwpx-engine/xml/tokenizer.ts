import { HwpxError } from "../errors.ts";
import { findIllegalChar, readReference } from "./chars.ts";

export type TokenKind = "bom" | "decl" | "pi" | "comment" | "cdata" | "start" | "end" | "empty" | "text";

export type XAttr = {
  qname: string;
  /** 엔티티를 해독한 값 */
  value: string;
  nameStart: number;
  /** 따옴표 안쪽 원문 구간 */
  valueStart: number;
  valueEnd: number;
};

export type Token = {
  kind: TokenKind;
  start: number;
  end: number;
  name?: string;
  attrs?: XAttr[];
};

export const MAX_DEPTH = 1000;

const NAME_START =
  ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D" +
  "\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const NAME_REST = NAME_START + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
const NAME = new RegExp(`[${NAME_START}][${NAME_REST}]*`, "uy");

const DECL =
  /<\?xml\s+version\s*=\s*(?:"1\.\d+"|'1\.\d+')(?:\s+encoding\s*=\s*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/y;

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** 오프셋을 1부터 세는 줄·열로 바꾼다. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    lastBreak = i;
  }
  return { line, column: offset - lastBreak };
}

function fail(text: string, at: number, code: string, message: string): never {
  const { line, column } = lineColumn(text, at);
  throw new HwpxError(code, `${message} (줄 ${line}, 열 ${column})`, `${line}:${column}`);
}

function readName(text: string, at: number): string | null {
  NAME.lastIndex = at;
  const m = NAME.exec(text);
  return m === null ? null : m[0];
}

/** text[from, to)의 참조를 모두 검사하고 해독한 문자열을 돌려준다. 오류 위치는 text 기준이다. */
function decodeRange(text: string, from: number, to: number): string {
  const raw = text.slice(from, to);
  let at = raw.indexOf("&");
  if (at < 0) return raw;
  let out = "";
  let cursor = 0;
  while (at >= 0) {
    let ref: { end: number; value: string } | null;
    try {
      ref = readReference(raw, at);
    } catch (e) {
      if (e instanceof HwpxError) fail(text, from + at, e.code, e.message);
      throw e;
    }
    if (ref === null) {
      fail(text, from + at, "XML_MALFORMED", `잘못된 엔티티 참조입니다: ${raw.slice(at, at + 12)}`);
    }
    out += raw.slice(cursor, at) + ref.value;
    cursor = ref.end;
    at = raw.indexOf("&", cursor);
  }
  return out + raw.slice(cursor);
}

export function tokenize(text: string): Token[] {
  const bad = findIllegalChar(text);
  if (bad >= 0) {
    fail(text, bad, "XML_ILLEGAL_CHAR", `XML 1.0에서 허용하지 않는 문자 U+${(text.codePointAt(bad) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
  }
  const n = text.length;
  const tokens: Token[] = [];
  const open: string[] = [];
  let pos = 0;
  let rootSeen = false;

  if (text.charCodeAt(0) === 0xfeff) {
    tokens.push({ kind: "bom", start: 0, end: 1 });
    pos = 1;
  }
  const declPos = pos;

  while (pos < n) {
    if (text.charCodeAt(pos) !== 0x3c) {
      // 문자 데이터
      let end = text.indexOf("<", pos);
      if (end < 0) end = n;
      if (open.length === 0) {
        for (let i = pos; i < end; i++) {
          if (!isWs(text.charCodeAt(i))) fail(text, i, "XML_MALFORMED", "루트 요소 밖에 문자 데이터가 있습니다");
        }
      } else {
        const cd = text.slice(pos, end).indexOf("]]>");
        if (cd >= 0) fail(text, pos + cd, "XML_MALFORMED", "문자 데이터에 ']]>'가 있습니다");
        decodeRange(text, pos, end);
      }
      tokens.push({ kind: "text", start: pos, end });
      pos = end;
      continue;
    }

    const next = text.charCodeAt(pos + 1);
    if (next === 0x3f /* ? */) {
      const close = text.indexOf("?>", pos + 2);
      if (close < 0) fail(text, pos, "XML_MALFORMED", "처리 명령이 닫히지 않았습니다");
      const target = readName(text, pos + 2);
      if (target === null) fail(text, pos, "XML_MALFORMED", "처리 명령의 대상 이름이 없습니다");
      if (target.toLowerCase() === "xml") {
        if (pos !== declPos || target !== "xml") fail(text, pos, "XML_MALFORMED", "XML 선언은 문서 맨 앞에만 올 수 있습니다");
        DECL.lastIndex = pos;
        const m = DECL.exec(text);
        if (m === null) fail(text, pos, "XML_MALFORMED", "XML 선언의 형식이 올바르지 않습니다");
        const enc = m[1] ?? m[2];
        if (enc !== undefined && enc.toUpperCase() !== "UTF-8") {
          fail(text, pos, "XML_ENCODING", `선언된 인코딩 ${enc}은 지원하지 않습니다. UTF-8만 지원합니다`);
        }
        tokens.push({ kind: "decl", start: pos, end: DECL.lastIndex });
        pos = DECL.lastIndex;
      } else {
        tokens.push({ kind: "pi", start: pos, end: close + 2 });
        pos = close + 2;
      }
      continue;
    }

    if (next === 0x21 /* ! */) {
      if (text.startsWith("<!--", pos)) {
        const dash = text.indexOf("--", pos + 4);
        if (dash < 0) fail(text, pos, "XML_MALFORMED", "주석이 닫히지 않았습니다");
        if (text.charCodeAt(dash + 2) !== 0x3e) fail(text, dash, "XML_MALFORMED", "주석 안에 '--'가 있습니다");
        tokens.push({ kind: "comment", start: pos, end: dash + 3 });
        pos = dash + 3;
      } else if (text.startsWith("<![CDATA[", pos)) {
        if (open.length === 0) fail(text, pos, "XML_MALFORMED", "루트 요소 밖에 CDATA가 있습니다");
        const close = text.indexOf("]]>", pos + 9);
        if (close < 0) fail(text, pos, "XML_MALFORMED", "CDATA가 닫히지 않았습니다");
        tokens.push({ kind: "cdata", start: pos, end: close + 3 });
        pos = close + 3;
      } else if (text.startsWith("<!DOCTYPE", pos)) {
        fail(text, pos, "XML_DOCTYPE", "DOCTYPE 선언은 허용하지 않습니다");
      } else {
        fail(text, pos, "XML_MALFORMED", "알 수 없는 '<!' 구문입니다");
      }
      continue;
    }

    if (next === 0x2f /* / */) {
      const name = readName(text, pos + 2);
      if (name === null) fail(text, pos, "XML_MALFORMED", "닫는 태그의 이름이 없습니다");
      let p = pos + 2 + name.length;
      while (isWs(text.charCodeAt(p))) p++;
      if (text.charCodeAt(p) !== 0x3e) fail(text, pos, "XML_MALFORMED", `닫는 태그 </${name}>가 '>'로 끝나지 않습니다`);
      const expected = open.pop();
      if (expected === undefined) fail(text, pos, "XML_MALFORMED", `여는 태그가 없는 닫는 태그 </${name}>`);
      if (expected !== name) fail(text, pos, "XML_MALFORMED", `태그 불일치: <${expected}>를 </${name}>로 닫았습니다`);
      tokens.push({ kind: "end", start: pos, end: p + 1, name });
      pos = p + 1;
      continue;
    }

    // 시작 태그 또는 빈 태그
    const name = readName(text, pos + 1);
    if (name === null) fail(text, pos, "XML_MALFORMED", "태그 이름이 올바르지 않습니다");
    if (open.length === 0 && rootSeen) fail(text, pos, "XML_MALFORMED", "루트 요소가 둘 이상입니다");
    let p = pos + 1 + name.length;
    const attrs: XAttr[] = [];
    const seen = new Set<string>();
    let empty = false;
    for (;;) {
      const wsStart = p;
      while (isWs(text.charCodeAt(p))) p++;
      const c = text.charCodeAt(p);
      if (Number.isNaN(c)) fail(text, pos, "XML_MALFORMED", `<${name}> 태그가 닫히지 않았습니다`);
      if (c === 0x3e) {
        p++;
        break;
      }
      if (c === 0x2f) {
        if (text.charCodeAt(p + 1) !== 0x3e) fail(text, p, "XML_MALFORMED", "'/' 뒤에 '>'가 와야 합니다");
        p += 2;
        empty = true;
        break;
      }
      if (p === wsStart) fail(text, p, "XML_MALFORMED", "속성 앞에 공백이 필요합니다");
      const qname = readName(text, p);
      if (qname === null) fail(text, p, "XML_MALFORMED", "속성 이름이 올바르지 않습니다");
      const nameStart = p;
      p += qname.length;
      while (isWs(text.charCodeAt(p))) p++;
      if (text.charCodeAt(p) !== 0x3d) fail(text, p, "XML_MALFORMED", `속성 ${qname}에 '='가 없습니다`);
      p++;
      while (isWs(text.charCodeAt(p))) p++;
      const quote = text.charCodeAt(p);
      if (quote !== 0x22 && quote !== 0x27) fail(text, p, "XML_MALFORMED", `속성 ${qname}의 값이 따옴표로 시작하지 않습니다`);
      const valueStart = p + 1;
      const valueEnd = text.indexOf(quote === 0x22 ? '"' : "'", valueStart);
      if (valueEnd < 0) fail(text, p, "XML_MALFORMED", `속성 ${qname}의 값이 닫히지 않았습니다`);
      const lt = text.slice(valueStart, valueEnd).indexOf("<");
      if (lt >= 0) fail(text, valueStart + lt, "XML_MALFORMED", `속성 ${qname}의 값에 '<'가 있습니다`);
      if (seen.has(qname)) fail(text, nameStart, "XML_MALFORMED", `속성 ${qname}이 중복됩니다`);
      seen.add(qname);
      attrs.push({ qname, value: decodeRange(text, valueStart, valueEnd), nameStart, valueStart, valueEnd });
      p = valueEnd + 1;
    }
    if (open.length === 0) rootSeen = true;
    if (empty) {
      tokens.push({ kind: "empty", start: pos, end: p, name, attrs });
    } else {
      if (open.length >= MAX_DEPTH) fail(text, pos, "XML_MALFORMED", `요소 중첩이 ${MAX_DEPTH}단계를 넘습니다`);
      open.push(name);
      tokens.push({ kind: "start", start: pos, end: p, name, attrs });
    }
    pos = p;
  }

  if (open.length > 0) fail(text, n, "XML_MALFORMED", `<${open[open.length - 1]}> 태그가 닫히지 않았습니다`);
  if (!rootSeen) fail(text, n, "XML_MALFORMED", "루트 요소가 없습니다");
  return tokens;
}
