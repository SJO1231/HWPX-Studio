import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import {
  compareToBaseline,
  openPackage,
  parseDocument,
  readEntry,
  rewriteArchive,
  splitTolerated,
  xmlToJson,
  type HwpxDocument,
  type ValidationIssue,
  type ValidationReport,
  type XmlJson,
} from "../src/index.ts";

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);

export const FIXTURE_NAMES = [
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D7",
  "hancom-merged",
  "hancom-field",
] as const;

/** fixtures 사본. fs가 돌려주는 Buffer 그대로 쓴다(엔진이 입력을 건드리지 않는지 보려는 뜻도 있다). */
export function readFixture(name: string): Uint8Array {
  return readFileSync(new URL(`${name}.hwpx`, FIXTURE_DIR));
}

export function readFixtureText(file: string): string {
  return readFileSync(new URL(file, FIXTURE_DIR), "utf8");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isXmlEntryName(name: string): boolean {
  return /\.(xml|hpf|rdf)$/i.test(name);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

export function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

// ── 바이트 수준 변형 (엔진의 해석기와 무관하게 ZIP 서명을 직접 찾는다) ───────────────

export function copyOf(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes); // 복사본
}

/** 파일 끝에서 EOCD 위치를 찾는다. */
export function eocdOffset(buf: Buffer): number {
  const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) throw new Error("테스트 입력에 EOCD가 없다");
  return at;
}

/** 중앙 디렉터리 레코드를 순서대로 읽어 (이름, 시작 위치)를 돌려준다. */
export function cdRecords(buf: Buffer): { name: string; at: number }[] {
  const eocd = eocdOffset(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out: { name: string; at: number }[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    out.push({ name: buf.toString("utf8", at + 46, at + 46 + nameLen), at });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function cdRecordOf(buf: Buffer, name: string): number {
  const rec = cdRecords(buf).find((r) => r.name === name);
  if (rec === undefined) throw new Error(`중앙 디렉터리에 ${name}이 없다`);
  return rec.at;
}

// ── 임의 ZIP 만들기 (엔진의 쓰기와 별개의 구현) ─────────────────────────────

export type RawEntry = {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  /** true면 로컬 헤더에 크기를 쓰지 않고 데이터 설명자(bit 3)를 뒤에 붙인다 */
  descriptor?: boolean;
};

export function buildZip(entries: RawEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  const cd: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(e.data) : Buffer.from(e.data);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const flags = e.descriptor === true ? 0x0008 : 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    if (e.descriptor !== true) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(e.data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    parts.push(local, body);
    let size = local.length + body.length;
    if (e.descriptor === true) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(e.data.length, 12);
      parts.push(dd);
      size += dd.length;
    }
    const rec = Buffer.alloc(46 + name.length);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(20, 4);
    rec.writeUInt16LE(20, 6);
    rec.writeUInt16LE(flags, 8);
    rec.writeUInt16LE(method, 10);
    rec.writeUInt16LE(0, 12);
    rec.writeUInt16LE(0x21, 14);
    rec.writeUInt32LE(crc, 16);
    rec.writeUInt32LE(body.length, 20);
    rec.writeUInt32LE(e.data.length, 24);
    rec.writeUInt16LE(name.length, 28);
    rec.writeUInt32LE(offset, 42);
    name.copy(rec, 46);
    cd.push(rec);
    offset += size;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, eocd]));
}

// ── 합성 HWPX ───────────────────────────────────────────────────────────

export const NS_HP = "http://www.hancom.co.kr/hwpml/2011/paragraph";
export const NS_HS = "http://www.hancom.co.kr/hwpml/2011/section";
export const NS_HH = "http://www.hancom.co.kr/hwpml/2011/head";
export const NS_HC = "http://www.hancom.co.kr/hwpml/2011/core";

export const MINIMAL_HEADER =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>` +
  `<hh:head xmlns:hh="${NS_HH}" xmlns:hc="${NS_HC}" version="1.5" secCnt="1">` +
  `<hh:refList>` +
  `<hh:fontfaces itemCnt="1"><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="x" type="TTF" isEmbedded="0"/></hh:fontface></hh:fontfaces>` +
  `<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0"/></hh:borderFills>` +
  `<hh:charProperties itemCnt="2"><hh:charPr id="0" height="1000" borderFillIDRef="1"><hh:fontRef hangul="0"/></hh:charPr>` +
  `<hh:charPr id="1" height="1200" borderFillIDRef="1"><hh:fontRef hangul="0"/></hh:charPr></hh:charProperties>` +
  `<hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:heading type="NONE" idRef="0" level="0"/><hh:border borderFillIDRef="1"/></hh:paraPr></hh:paraProperties>` +
  `<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="n" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"/></hh:styles>` +
  `</hh:refList></hh:head>`;

export function sectionXml(body: string, extraNs = ""): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>` +
    `<hs:sec xmlns:hs="${NS_HS}" xmlns:hp="${NS_HP}"${extraNs}>${body}</hs:sec>`
  );
}

const CONTAINER =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>` +
  `<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles>` +
  `<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>` +
  `</ocf:rootfiles></ocf:container>`;

export function hpfXml(sectionIds: number[], spineIds: string[] = ["header", ...sectionIds.map((n) => `section${n}`)]): string {
  const items = [
    `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>`,
    ...sectionIds.map((n) => `<opf:item id="section${n}" href="Contents/section${n}.xml" media-type="application/xml"/>`),
  ].join("");
  const spine = spineIds.map((id) => `<opf:itemref idref="${id}"/>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>` +
    `<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest>${items}</opf:manifest><opf:spine>${spine}</opf:spine></opf:package>`
  );
}

/** sectionBodies는 hs:sec 안쪽 XML이고, raw를 켜면 구역 파일 전체 텍스트로 쓴다. */
export function buildHwpx(sectionBodies: string[], header = MINIMAL_HEADER, raw = false): Uint8Array {
  return buildZip([
    { name: "mimetype", data: utf8("application/hwp+zip") },
    { name: "META-INF/container.xml", data: utf8(CONTAINER), method: 8 },
    { name: "Contents/content.hpf", data: utf8(hpfXml(sectionBodies.map((_, i) => i))), method: 8 },
    { name: "Contents/header.xml", data: utf8(header), method: 8 },
    ...sectionBodies.map((body, i) => ({
      name: `Contents/section${i}.xml`,
      data: utf8(raw ? body : sectionXml(body)),
      method: 8 as const,
    })),
  ]);
}

/** 합성 HWPX를 열어 모델을 만든다. */
export function parseSynthetic(sectionBodies: string[], header = MINIMAL_HEADER, raw = false): HwpxDocument {
  return parseDocument(openPackage(buildHwpx(sectionBodies, header, raw)));
}

/** fixtures 사본의 한 XML 항목 텍스트를 바꾼 새 패키지 바이트를 만든다(파일로 저장하지 않는다). */
export function mutateEntryText(bytes: Uint8Array, entry: string, change: (text: string) => string): Uint8Array {
  const pkg = openPackage(bytes);
  const original = new TextDecoder().decode(readEntry(pkg.archive, bytes, entry));
  const changed = change(original);
  if (changed === original) throw new Error(`변형이 ${entry}를 바꾸지 못했다`);
  return rewriteArchive(bytes, pkg.archive, { replace: new Map([[entry, utf8(changed)]]) });
}

// ── 조각 시험용: 엔진의 가져오기 코드와 독립인 기준 ───────────────────────────

/** 한 fixtures 파일을 열어 모델을 만든다. 하위 폴더는 이름에 포함한다(예: "hancom/picture"). */
export function loadDoc(name: string): HwpxDocument {
  return parseDocument(openPackage(readFixture(name)));
}

export function reparse(bytes: Uint8Array): HwpxDocument {
  return parseDocument(openPackage(bytes));
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeText(raw: string): string {
  return raw.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (_m, dec?: string, hex?: string, name?: string) =>
    name !== undefined ? (ENTITIES[name] ?? "") : String.fromCodePoint(dec !== undefined ? Number(dec) : parseInt(hex ?? "0", 16)),
  );
}

/** `hp:t` 안의 글을 문서 순서로 정규식만으로 뽑는다(안쪽 태그는 뺀다). */
export function hpTexts(xml: string): string[] {
  return [...xml.matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/g)].map((m) => decodeText((m[1] ?? "").replace(/<[^>]+>/g, "")));
}

/** 모든 속성값을 비우고 줄 배치 캐시를 지운다. 조각 본문이 원문 그대로이고 속성값만 달라졌는지 비교하는 데 쓴다. */
export function maskValues(xml: string): string {
  return xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "").replace(/="[^"]*"/g, '=""');
}

const OBJECT_TAG_RE = "(?:tbl|pic|ole|container|equation|rect|ellipse|arc|polygon|curve|line|connectLine|textart|video|chart)";

/** 구역 원문에서 개체(표·그림 등)의 id를 문서 순서로 모은다. */
export function objectIdsIn(sectionText: string): string[] {
  return [...sectionText.matchAll(new RegExp(`<hp:${OBJECT_TAG_RE}\\b[^>]*?\\sid="([^"]*)"`, "g"))].map((m) => m[1] ?? "");
}

export function instIdsIn(sectionText: string): string[] {
  return [...sectionText.matchAll(/\s(?:instId|instid)="([^"]*)"/g)].map((m) => m[1] ?? "");
}

export function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

/** 본문 원문에서 서식 참조(글자·문단·스타일·테두리)를 문서 순서로 모은다. */
export function formatRefsIn(xml: string): { kind: string; id: string }[] {
  const kinds: Record<string, string> = { charPrIDRef: "charPr", paraPrIDRef: "paraPr", styleIDRef: "style", borderFillIDRef: "borderFill" };
  return [...xml.matchAll(/\s(charPrIDRef|paraPrIDRef|styleIDRef|borderFillIDRef)="([^"]*)"/g)].map((m) => ({
    kind: kinds[m[1] ?? ""] ?? "",
    id: m[2] ?? "",
  }));
}

const FONT_LANG_NAMES = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
const local = (qname: string): string => qname.slice(qname.indexOf(":") + 1);

/**
 * 자원 하나를 참조까지 전개한 JSON 트리. 자신의 id와 다른 자원을 가리키는 id는 빼고 대상의 전개로 바꾼다.
 * 스타일 이름의 ` (n)` 접미사는 뗀다(이름 충돌 시 붙인 것). 대상이 없으면 `<missing:id>`, 순환이면 `<cycle:n>`.
 */
export function expandResource(doc: HwpxDocument, kind: string, id: string, lang?: string, stack: string[] = []): unknown {
  const item = (doc.header.resources[kind] ?? []).find((i) => i.id === id && (kind !== "font" || i.lang === lang));
  if (item === undefined) return `<missing:${id}>`;
  const key = `${kind}/${lang ?? ""}/${id}`;
  const at = stack.indexOf(key);
  if (at >= 0) return `<cycle:${stack.length - at}>`;
  const inner = [...stack, key];

  const target = (node: XmlJson, attr: string, root: boolean): [string, string | undefined] | undefined => {
    const n = local(node.name);
    if (kind === "charPr") {
      if (n === "charPr" && attr === "borderFillIDRef") return ["borderFill", undefined];
      if (n === "fontRef" && FONT_LANG_NAMES.includes(attr.toUpperCase())) return ["font", attr.toUpperCase()];
    } else if (kind === "paraPr") {
      if (n === "paraPr" && attr === "tabPrIDRef") return ["tabPr", undefined];
      if (n === "border" && attr === "borderFillIDRef") return ["borderFill", undefined];
      if (n === "heading" && attr === "idRef" && node.attrs["type"] === "NUMBER") return ["numbering", undefined];
      if (n === "heading" && attr === "idRef" && node.attrs["type"] === "BULLET") return ["bullet", undefined];
    } else if (kind === "style" && root) {
      if (attr === "paraPrIDRef") return ["paraPr", undefined];
      if (attr === "charPrIDRef") return ["charPr", undefined];
      if (attr === "nextStyleIDRef") return ["style", undefined];
    }
    return undefined;
  };
  const expand = (node: XmlJson, root: boolean): unknown => {
    const attrs: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.attrs)) {
      if (name.startsWith("xmlns")) continue;
      const t = target(node, name, root);
      if (root && name === "id") continue;
      if (root && kind === "style" && name === "name") attrs[name] = value.replace(/ \(\d+\)$/, "");
      else attrs[name] = t === undefined || value === "4294967295" ? value : expandResource(doc, t[0], value, t[1], inner);
    }
    return { name: local(node.name), attrs, text: node.text.trim(), children: node.children.map((c) => expand(c, false)) };
  };
  return expand(xmlToJson(item.element), true);
}

/**
 * 편집 뒤에 새로 생긴 검사 오류. 기준선에서 한컴이 받아 주는 경고(RES_DANGLING_TOLERATED)였던 같은 참조가 오류로 올라온 것
 * (탭 목록이 비었다가 새 탭이 들어와 찬 경우)은 원래 있던 문제이므로 뺀다(저장 게이트와 같은 규칙).
 */
export function newErrorsAfter(before: ValidationReport, after: ValidationReport): ValidationIssue[] {
  return splitTolerated(compareToBaseline(before, after).newErrors, before.warnings).rest;
}
