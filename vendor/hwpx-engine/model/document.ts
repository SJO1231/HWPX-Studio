import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import type { HwpxPackage } from "../package/open.ts";
import { readEntry } from "../package/zip-read.ts";
import { parseXmlBytes } from "../xml/parse.ts";
import { childEls, elIs, walkElements } from "../xml/tree.ts";
import { parseHeader } from "./header.ts";
import { parseParagraph, walkParagraphs } from "./paragraph.ts";
import { checkReferences, collectBodyRefs } from "./refs.ts";
import type { HwpxDocument, ParagraphNode, SectionModel } from "./types.ts";

function parseSection(pkg: HwpxPackage, entryName: string, index: number, issues: Issue[]): SectionModel {
  const { text, root } = parseXmlBytes(readEntry(pkg.archive, pkg.bytes, entryName), entryName);
  if (!elIs(root, "section", "sec")) {
    throw new HwpxError("MODEL_ROOT_ELEMENT", `구역 파일의 루트가 sec가 아니라 ${root.qname}입니다.`, entryName);
  }
  const paragraphs: ParagraphNode[] = childEls(root, "paragraph", "p").map((p, i) => parseParagraph(p, [i]));

  let present = 0;
  for (const el of walkElements(root)) if (elIs(el, "paragraph", "p")) present++;
  let reached = 0;
  for (const _ of walkParagraphs(paragraphs)) reached++;
  if (present !== reached) {
    issues.push(
      makeIssue("warning", "MODEL_UNREACHED_PARAGRAPH", `문단 ${present}개 중 ${present - reached}개가 모델에 연결되지 않았습니다.`, entryName),
    );
  }
  return { entryName, index, text, root, paragraphs, bodyRefs: collectBodyRefs(root) };
}

export function parseDocument(pkg: HwpxPackage): HwpxDocument {
  const issues: Issue[] = [...pkg.issues];

  const parsedHeader = parseXmlBytes(readEntry(pkg.archive, pkg.bytes, pkg.headerEntry), pkg.headerEntry);
  if (!elIs(parsedHeader.root, "head", "head")) {
    throw new HwpxError("MODEL_ROOT_ELEMENT", `header 파일의 루트가 head가 아니라 ${parsedHeader.root.qname}입니다.`, pkg.headerEntry);
  }
  const header = parseHeader(parsedHeader.text, parsedHeader.root);
  const sections = pkg.sectionEntries.map((name, i) => parseSection(pkg, name, i, issues));

  issues.push(...checkReferences(pkg, header, sections));
  return { pkg, header, sections, issues };
}
