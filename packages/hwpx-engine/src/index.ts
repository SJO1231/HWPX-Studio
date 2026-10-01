export { HwpxError, makeIssue, type Issue } from "./errors.ts";

export { readArchive, readEntry, findEntry, LIMITS, type Archive, type ArchiveEntry } from "./package/zip-read.ts";
export { rewriteArchive, type AddedEntry, type ArchiveChanges } from "./package/zip-write.ts";
export { openPackage, type HwpxPackage, type ManifestItem } from "./package/open.ts";

export { tokenize, lineColumn, MAX_DEPTH, type Token, type TokenKind, type XAttr } from "./xml/tokenizer.ts";
export {
  buildTree,
  nsRole,
  elIs,
  isEl,
  isElement,
  elementChildren,
  childEl,
  childEls,
  walkElements,
  attrNode,
  attrValue,
  type XElement,
  type XText,
} from "./xml/tree.ts";
export { decodeEntities, escapeText, escapeAttr, isXmlCodePoint } from "./xml/chars.ts";
export { decodeUtf8, encodeUtf8, parseXmlBytes, type ParsedXml } from "./xml/parse.ts";

export * from "./model/types.ts";
export { parseDocument } from "./model/document.ts";
export { parseHeader } from "./model/header.ts";
export { parseParagraph, walkParagraphs, isTableNode } from "./model/paragraph.ts";
export { collectBodyRefs, checkReferences } from "./model/refs.ts";
export { listFields } from "./model/fields.ts";

export {
  exportModel,
  xmlToJson,
  MODEL_SCHEMA_VERSION,
  type ModelJson,
  type XmlJson,
  type ParagraphJson,
  type ObjectJson,
  type ResourceJson,
} from "./store/export.ts";

export { applyPlan, mergePlans, type SpanEdit, type EditPlan } from "./edit/plan.ts";

export * from "./validate/index.ts";

export type {
  Fragment,
  FragmentBinary,
  FragmentRef,
  FragmentResource,
  FragmentSelection,
  InsertPoint,
  InstanceIdRole,
} from "./fragment/types.ts";
export { selectTable } from "./fragment/select.ts";
export { extractFragment } from "./fragment/extract.ts";
export { planImport } from "./fragment/import.ts";
export { fingerprintResource, makeLookup, type FingerprintLookup } from "./fragment/resources.ts";
export { serializeFragment, parseFragment } from "./fragment/json.ts";

export * from "./repair/index.ts";
