import { HwpxError } from "../errors.ts";
import { readEntry, type Archive } from "../package/zip-read.ts";
import { parseXmlBytes, type ParsedXml } from "../xml/parse.ts";
import { attrValue, walkElements, type XElement } from "../xml/tree.ts";
import type { IssueLog } from "./types.ts";

export const CONTAINER_ENTRY = "META-INF/container.xml";
export const HPF_ENTRY = "Contents/content.hpf";
export const HEADER_ENTRY = "Contents/header.xml";
export const PREVIEW_TEXT_ENTRY = "Preview/PrvText.txt";

const MIMETYPE_VALUE = "application/hwp+zip";
const XML_NAME = /\.(xml|hpf|rdf)$/i;

/** 검사 한 번에 걸쳐 쓰는 상태. XML은 항목마다 한 번만 읽고 실패도 한 번만 보고한다. */
export type Ctx = {
  bytes: Uint8Array;
  archive: Archive;
  log: IssueLog;
  /** CRC 검사 때 풀어 둔 XML 항목 내용. 읽기에 실패한 항목은 없다. */
  xmlBytes: Map<string, Uint8Array>;
  xml: Map<string, ParsedXml | null>;
};

export type ManifestMap = Map<string | undefined, string | undefined>;

/** 값이 없을 때 보고문에 쓰는 표기 */
export function show(v: string | undefined): string {
  return v ?? "(없음)";
}

/** XML 항목을 읽는다. 없거나 읽기에 실패한 항목은 null이다(패키지 검사가 이미 보고한다). 정형성 오류는 처음 읽을 때 보고한다. */
export function parseEntry(ctx: Ctx, name: string): ParsedXml | null {
  const cached = ctx.xml.get(name);
  if (cached !== undefined) return cached;
  let parsed: ParsedXml | null = null;
  const bytes = ctx.xmlBytes.get(name);
  if (bytes !== undefined) {
    try {
      parsed = parseXmlBytes(bytes, name);
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      // 읽을 수 없는 XML은 어떤 사유든 XML_MALFORMED로 낸다. 엔진이 사유별 코드를 따로 갖는 경우 그 코드도 더한다.
      ctx.log.err("XML_MALFORMED", `XML 정형성 오류: ${e.message}`, name);
      if (e.code === "XML_ILLEGAL_CHAR" || e.code === "XML_ENCODING" || e.code === "XML_DOCTYPE") {
        ctx.log.err(e.code, e.message, name);
      }
    }
  }
  ctx.xml.set(name, parsed);
  return parsed;
}

function sortedNames(ctx: Ctx): string[] {
  return ctx.archive.entries.map((e) => e.name).sort();
}

function mimetypeText(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : "�";
  return out.trim();
}

/** 패키지 검사. 구역 파일 이름 목록(정렬)과 manifest(id → href)를 돌려준다. ZIP이 비어 있으면 null. */
export function checkPackage(ctx: Ctx): { sections: string[]; manifest: ManifestMap } | null {
  const { archive, log } = ctx;
  const infos = archive.entries;
  if (infos.length === 0) {
    log.err("PKG_EMPTY", "ZIP 항목이 없음");
    return null;
  }

  const first = infos[0];
  if (first !== undefined && first.name !== "mimetype") {
    log.err("PKG_MIMETYPE_ORDER", `첫 항목이 mimetype 이 아님(${first.name})`);
  }
  const mime = infos.find((e) => e.name === "mimetype");
  if (mime !== undefined) {
    if (mime.method !== 0) log.err("PKG_MIMETYPE_COMPRESSED", "mimetype 이 무압축이 아님");
    try {
      const val = mimetypeText(readEntry(archive, ctx.bytes, "mimetype"));
      if (val !== MIMETYPE_VALUE) log.warn("PKG_MIMETYPE_VALUE", `mimetype 값이 예상과 다름: '${val}'`);
    } catch {
      // 읽기 오류는 아래 CRC 검사가 보고한다.
    }
  } else {
    log.err("PKG_MIMETYPE_MISSING", "mimetype 항목 없음");
  }

  // 항목마다 끝까지 풀어 CRC를 확인한다. XML 항목은 내용을 남겨 둔다.
  for (const e of infos) {
    if (e.isDirectory) continue;
    try {
      const data = readEntry(archive, ctx.bytes, e.name);
      if (XML_NAME.test(e.name)) ctx.xmlBytes.set(e.name, data);
    } catch (err) {
      if (!(err instanceof HwpxError)) throw err;
      log.err(err.code, `CRC/읽기 오류: ${err.message}`, e.name);
    }
  }

  const nameset = new Set(infos.map((e) => e.name));
  for (const req of [CONTAINER_ENTRY, HPF_ENTRY, HEADER_ENTRY]) {
    if (!nameset.has(req)) log.err("PKG_MISSING", "필수 항목 없음", req);
  }
  const sections = [...nameset].filter((n) => n.startsWith("Contents/section") && n.toLowerCase().endsWith(".xml")).sort();
  if (sections.length === 0) log.err("PKG_MISSING", "Contents/section*.xml 이 하나도 없음");
  if (!nameset.has("META-INF/manifest.xml")) {
    log.warn("PKG_NO_ODF_MANIFEST", "META-INF/manifest.xml 없음(한컴 저장본에는 있고 합성 문서에는 없음)");
  }

  for (const n of sortedNames(ctx)) {
    if (XML_NAME.test(n)) parseEntry(ctx, n);
  }

  const container = parseEntry(ctx, CONTAINER_ENTRY);
  if (container !== null) {
    const roots = [...walkElements(container.root)].filter((e) => e.local === "rootfile").map((e) => attrValue(e, "full-path"));
    if (roots.length === 0) log.err("PKG_ROOTFILE", "container.xml 에 rootfile 이 없음");
    for (const r of roots) {
      if (r === undefined || !nameset.has(r)) log.err("PKG_ROOTFILE", "container.xml rootfile 이 가리키는 항목이 없음", show(r));
    }
  }

  const manifest: ManifestMap = new Map();
  const hpf = parseEntry(ctx, HPF_ENTRY);
  if (hpf !== null) {
    const els: XElement[] = [...walkElements(hpf.root)];
    for (const it of els) {
      if (it.local !== "item") continue;
      const iid = attrValue(it, "id");
      const href = attrValue(it, "href");
      if (manifest.has(iid)) log.err("PKG_MANIFEST_DUP_ID", "manifest item id 중복", show(iid));
      manifest.set(iid, href);
      if (href !== undefined && href !== "" && !href.startsWith("http:") && !href.startsWith("https:") && !nameset.has(href)) {
        const inPackage = href.startsWith("BinData/") || href.startsWith("Contents/");
        const message = `manifest item(${show(iid)})의 href 항목이 ZIP 에 없음`;
        if (inPackage) log.err("PKG_MANIFEST_HREF_MISSING", message, href);
        else log.warn("PKG_MANIFEST_HREF_MISSING", message, href);
      }
    }
    for (const ref of els) {
      if (ref.local !== "itemref") continue;
      const idref = attrValue(ref, "idref");
      if (!manifest.has(idref)) log.err("PKG_SPINE_IDREF", "spine itemref 가 manifest 에 없는 id 를 가리킴", show(idref));
    }
    const hrefs = new Set(manifest.values());
    for (const s of sections) {
      if (!hrefs.has(s)) log.err("PKG_SECTION_NOT_IN_MANIFEST", "section 파일이 content.hpf manifest 에 없음", s);
    }
    const bins = [...nameset].filter((n) => n.startsWith("BinData/") && !n.endsWith("/")).sort();
    for (const b of bins) {
      if (!hrefs.has(b)) log.warn("PKG_BINDATA_ORPHAN", "BinData 항목이 manifest 에 없음", b);
    }
  }
  return { sections, manifest };
}
