import { HwpxError } from "../errors.ts";

const PREDEFINED = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
]);

/** XML 1.0의 Char 생산식에 해당하는 코드 포인트인가. */
export function isXmlCodePoint(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

// 허용되지 않는 제어 문자, U+FFFE/U+FFFF, 짝이 맞지 않는 서로게이트.
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 허용되지 않는 문자가 처음 나타나는 위치. 없으면 -1. */
export function findIllegalChar(text: string): number {
  return text.search(ILLEGAL);
}

export function assertLegalChars(value: string, what: string): void {
  const at = findIllegalChar(value);
  if (at >= 0) {
    const cp = value.codePointAt(at) ?? 0;
    throw new HwpxError(
      "XML_ILLEGAL_CHAR",
      `${what}에 XML 1.0에서 허용하지 않는 문자 U+${cp.toString(16).toUpperCase().padStart(4, "0")}가 있습니다.`,
    );
  }
}

const MAX_CODE_POINT = 0x10ffff;

/** 숫자 문자의 값. radix 안의 숫자가 아니면 -1. */
function digitValue(code: number, radix: 10 | 16): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (radix === 16) {
    if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
    if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  }
  return -1;
}

/**
 * `text[at]`이 `&`일 때 엔티티 참조 하나를 읽는다.
 * 반환: 참조 끝 다음 위치와 해독한 문자열. 문법이 틀리면 null. 숫자 참조가 금지된 문자를 가리키면 예외.
 *
 * 숫자 참조는 자릿수가 아니라 값으로 판정한다. 앞자리 0은 몇 개든 정형이다.
 * 값이 U+10FFFF를 넘으면 더 키우지 않고 끝까지 자릿수만 읽으므로, 참조 길이에 비례한 시간만 든다.
 */
export function readReference(text: string, at: number): { end: number; value: string } | null {
  if (text.charCodeAt(at + 1) !== 0x23 /* # */) {
    for (const [name, value] of PREDEFINED) {
      if (text.startsWith(name + ";", at + 1)) return { end: at + 1 + name.length + 1, value };
    }
    return null;
  }
  let p = at + 2;
  const radix = text.charCodeAt(p) === 0x78 /* x */ ? 16 : 10;
  if (radix === 16) p++;
  const digitsStart = p;
  let cp = 0;
  for (; p < text.length; p++) {
    const d = digitValue(text.charCodeAt(p), radix);
    if (d < 0) break;
    if (cp <= MAX_CODE_POINT) cp = cp * radix + d;
  }
  if (p === digitsStart || text.charCodeAt(p) !== 0x3b /* ; */) return null;
  if (!isXmlCodePoint(cp)) {
    const body = text.slice(at + 1, p);
    const shown = body.length > 24 ? `${body.slice(0, 24)}…` : body;
    throw new HwpxError("XML_ILLEGAL_CHAR", `숫자 참조 &${shown};가 허용되지 않는 문자를 가리킵니다.`);
  }
  return { end: p + 1, value: String.fromCodePoint(cp) };
}

export function decodeEntities(raw: string): string {
  let at = raw.indexOf("&");
  if (at < 0) return raw;
  let out = "";
  let from = 0;
  while (at >= 0) {
    const ref = readReference(raw, at);
    if (ref === null) throw new HwpxError("XML_MALFORMED", `잘못된 엔티티 참조입니다: ${raw.slice(at, at + 12)}`);
    out += raw.slice(from, at) + ref.value;
    from = ref.end;
    at = raw.indexOf("&", from);
  }
  return out + raw.slice(from);
}

export function escapeText(value: string): string {
  assertLegalChars(value, "텍스트 값");
  return value.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

export function escapeAttr(value: string): string {
  assertLegalChars(value, "속성 값");
  return value.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}
