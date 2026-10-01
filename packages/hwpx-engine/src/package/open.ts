import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { attrValue, elIs, walkElements } from "../xml/tree.ts";
import { parseXmlBytes } from "../xml/parse.ts";
import { readArchive, readEntry, findEntry, type Archive } from "./zip-read.ts";

export type ManifestItem = { id: string; href: string; mediaType: string };

export type HwpxPackage = {
  archive: Archive;
  bytes: Uint8Array;
  headerEntry: string;
  sectionEntries: string[];
  manifestItems: ManifestItem[];
  /** BinData/ 아래의 파일 항목 이름 */
  binaryEntries: string[];
  issues: Issue[];
};

const CONTAINER_ENTRY = "META-INF/container.xml";
const MIMETYPE_ENTRY = "mimetype";
const MIMETYPE_VALUE = "application/hwp+zip";
const SECTION_HREF = /(?:^|\/)section(\d+)\.xml$/i;
const SECTION_ENTRY = /^Contents\/section(\d+)\.xml$/;

function checkMimetype(archive: Archive, bytes: Uint8Array, issues: Issue[]): void {
  const entry = findEntry(archive, MIMETYPE_ENTRY);
  if (entry === undefined) {
    issues.push(makeIssue("warning", "PKG_MIMETYPE_MISSING", "mimetype 항목이 없습니다.", MIMETYPE_ENTRY));
    return;
  }
  const first = archive.entries.reduce((a, b) => (b.localStart < a.localStart ? b : a));
  if (first !== entry) {
    issues.push(makeIssue("warning", "PKG_MIMETYPE_POSITION", `mimetype이 첫 항목이 아닙니다(첫 항목: ${first.name}).`, MIMETYPE_ENTRY));
  }
  if (entry.method !== 0) {
    issues.push(makeIssue("warning", "PKG_MIMETYPE_COMPRESSED", "mimetype이 무압축이 아닙니다.", MIMETYPE_ENTRY));
  }
  const content = new TextDecoder().decode(readEntry(archive, bytes, MIMETYPE_ENTRY));
  if (content !== MIMETYPE_VALUE) {
    issues.push(makeIssue("warning", "PKG_MIMETYPE_CONTENT", `mimetype 내용이 ${MIMETYPE_VALUE}가 아닙니다.`, MIMETYPE_ENTRY));
  }
}

/**
 * 필수 항목을 찾지 못했을 때의 오류. 항목 이름에 역슬래시가 하나라도 있으면 원인을 구별해 PKG_BACKSLASH_NAMES로 낸다.
 * 구분자가 역슬래시인 파일은 1차에서 읽지 않는다. 그 밖의 경우는 PKG_MISSING이다.
 */
function missing(archive: Archive, message: string, where: string): HwpxError {
  if (archive.entries.some((e) => e.name.includes("\\"))) {
    return new HwpxError("PKG_BACKSLASH_NAMES", `항목 이름의 구분자가 역슬래시(\\)인 파일은 지원하지 않습니다. ${message}`, where);
  }
  return new HwpxError("PKG_MISSING", message, where);
}

function requireEntry(archive: Archive, name: string): void {
  if (findEntry(archive, name) === undefined) throw missing(archive, `필수 항목이 없습니다: ${name}`, name);
}

export function openPackage(bytes: Uint8Array): HwpxPackage {
  const archive = readArchive(bytes);
  const issues: Issue[] = [];
  checkMimetype(archive, bytes, issues);

  requireEntry(archive, CONTAINER_ENTRY);
  const container = parseXmlBytes(readEntry(archive, bytes, CONTAINER_ENTRY), CONTAINER_ENTRY);
  const rootfiles: { path: string; mediaType: string }[] = [];
  for (const el of walkElements(container.root)) {
    if (!elIs(el, "container", "rootfile")) continue;
    const path = attrValue(el, "full-path");
    if (path !== undefined) rootfiles.push({ path, mediaType: attrValue(el, "media-type") ?? "" });
  }
  const rootfile =
    rootfiles.find((r) => r.mediaType === "application/hwpml-package+xml") ?? rootfiles.find((r) => r.path.endsWith(".hpf"));
  if (rootfile === undefined) {
    throw missing(archive, "container.xml에 패키지 루트 파일(rootfile)이 없습니다.", CONTAINER_ENTRY);
  }
  requireEntry(archive, rootfile.path);
  const hpf = parseXmlBytes(readEntry(archive, bytes, rootfile.path), rootfile.path);

  const manifestItems: ManifestItem[] = [];
  const spineIds: string[] = [];
  for (const el of walkElements(hpf.root)) {
    if (elIs(el, "opf", "item")) {
      const id = attrValue(el, "id");
      const href = attrValue(el, "href");
      if (id === undefined || href === undefined) {
        issues.push(makeIssue("warning", "PKG_MANIFEST_ITEM", "id 또는 href가 없는 manifest 항목을 건너뛰었습니다.", rootfile.path));
      } else {
        manifestItems.push({ id, href, mediaType: attrValue(el, "media-type") ?? "" });
      }
    } else if (elIs(el, "opf", "itemref")) {
      const idref = attrValue(el, "idref");
      if (idref !== undefined) spineIds.push(idref);
    }
  }
  const byId = new Map(manifestItems.map((m) => [m.id, m]));
  const spineItems = spineIds.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });

  const header =
    spineItems.find((m) => m.id === "header" || /(?:^|\/)header\.xml$/i.test(m.href)) ??
    manifestItems.find((m) => m.id === "header" || /(?:^|\/)header\.xml$/i.test(m.href));
  if (header === undefined) {
    throw missing(archive, "manifest에 header 항목이 없습니다.", rootfile.path);
  }
  requireEntry(archive, header.href);

  const sectionEntries = spineItems.filter((m) => SECTION_HREF.test(m.href)).map((m) => m.href);
  const extra = archive.entries
    .map((e) => ({ name: e.name, m: SECTION_ENTRY.exec(e.name) }))
    .filter((x) => x.m !== null && !sectionEntries.includes(x.name))
    .map((x) => ({ name: x.name, n: Number(x.m?.[1] ?? "0") }))
    .sort((a, b) => a.n - b.n);
  for (const x of extra) {
    sectionEntries.push(x.name);
    issues.push(makeIssue("warning", "PKG_SECTION_NOT_IN_SPINE", "spine에 없는 구역 파일을 번호순으로 뒤에 붙였습니다.", x.name));
  }
  if (sectionEntries.length === 0) {
    throw missing(archive, "구역 파일(section<N>.xml)이 없습니다.", rootfile.path);
  }
  for (const name of sectionEntries) requireEntry(archive, name);

  const binaryEntries = archive.entries.filter((e) => !e.isDirectory && e.name.startsWith("BinData/")).map((e) => e.name);
  return { archive, bytes, headerEntry: header.href, sectionEntries, manifestItems, binaryEntries, issues };
}
