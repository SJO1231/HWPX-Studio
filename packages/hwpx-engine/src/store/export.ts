import { createHash } from "node:crypto";
import type { Issue } from "../errors.ts";
import { isTableNode } from "../model/paragraph.ts";
import type { HwpxDocument, ObjectNode, ParagraphNode, ResourceKind, SubListNode } from "../model/types.ts";
import { readEntry } from "../package/zip-read.ts";
import { isElement, type XElement } from "../xml/tree.ts";

export const MODEL_SCHEMA_VERSION = 1;

export type XmlJson = {
  name: string;
  attrs: Record<string, string>;
  children: XmlJson[];
  text: string;
};

export type ResourceJson = {
  kind: ResourceKind;
  lang?: string;
  id: string;
  tree: XmlJson;
  refs: { kind: ResourceKind; lang?: string; id: string }[];
};

export type ObjectJson = {
  type: string;
  id?: string;
  instId?: string;
  /** 문단의 subLists 배열에서의 위치 */
  subLists: number[];
  table?: {
    rowCnt: number;
    colCnt: number;
    cells: {
      row: number;
      col: number;
      rowSpan: number;
      colSpan: number;
      borderFillIDRef: string | null;
      subList: number | null;
    }[];
  };
};

export type ParagraphJson = {
  path: number[];
  paraPrIDRef: string | null;
  styleIDRef: string | null;
  id?: string;
  runs: { ordinal: number; charPrIDRef: string | null }[];
  logicalText: string;
  hasLineSegArray: boolean;
  objects: ObjectJson[];
  fields: { kind: "begin" | "end"; id: string; name?: string; type?: string; dirty?: string; beginIDRef?: string }[];
  bookmarks: { name: string }[];
  subLists: { owner: string; paragraphs: ParagraphJson[] }[];
};

export type ModelJson = {
  schemaVersion: number;
  source: { size: number; sha256: string };
  entries: { name: string; size: number; method: number; sha256: string }[];
  header: {
    entry: string;
    secCnt: number | null;
    counts: { list: string; kind: ResourceKind; lang?: string; value: number; actual: number }[];
    resources: Record<ResourceKind, ResourceJson[]>;
  };
  sections: { index: number; entry: string; paragraphs: ParagraphJson[] }[];
  issues: Issue[];
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function xmlToJson(el: XElement): XmlJson {
  const children: XmlJson[] = [];
  let text = "";
  for (const c of el.children) {
    if (isElement(c)) children.push(xmlToJson(c));
    else text += c.value;
  }
  if (children.length > 0 && text.trim() === "") text = "";
  return {
    name: el.qname,
    attrs: Object.fromEntries(el.attrs.map((a) => [a.qname, a.value])),
    children,
    text,
  };
}

function objectJson(o: ObjectNode, subLists: SubListNode[]): ObjectJson {
  const out: ObjectJson = {
    type: o.type,
    subLists: o.subLists.map((s) => subLists.indexOf(s)),
  };
  if (o.id !== undefined) out.id = o.id;
  if (o.instId !== undefined) out.instId = o.instId;
  if (isTableNode(o)) {
    out.table = {
      rowCnt: o.rowCnt,
      colCnt: o.colCnt,
      cells: o.cells.map((c) => ({
        row: c.row,
        col: c.col,
        rowSpan: c.rowSpan,
        colSpan: c.colSpan,
        borderFillIDRef: c.borderFillIDRef,
        subList: c.subList === null ? null : subLists.indexOf(c.subList),
      })),
    };
  }
  return out;
}

function paragraphJson(p: ParagraphNode): ParagraphJson {
  const out: ParagraphJson = {
    path: [...p.path],
    paraPrIDRef: p.attrs.paraPrIDRef,
    styleIDRef: p.attrs.styleIDRef,
    runs: p.runs.map((r) => ({ ordinal: r.ordinal, charPrIDRef: r.charPrIDRef })),
    logicalText: p.logicalText,
    hasLineSegArray: p.lineSegArray !== undefined,
    objects: p.objects.map((o) => objectJson(o, p.subLists)),
    fields: p.fieldMarks.map((m) => {
      const f: ParagraphJson["fields"][number] = { kind: m.kind, id: m.id };
      if (m.name !== undefined) f.name = m.name;
      if (m.type !== undefined) f.type = m.type;
      if (m.dirty !== undefined) f.dirty = m.dirty;
      if (m.beginIDRef !== undefined) f.beginIDRef = m.beginIDRef;
      return f;
    }),
    bookmarks: p.bookmarks.map((b) => ({ name: b.name })),
    subLists: p.subLists.map((s) => ({ owner: s.owner, paragraphs: s.paragraphs.map(paragraphJson) })),
  };
  if (p.attrs.id !== undefined) out.id = p.attrs.id;
  return out;
}

export function exportModel(doc: HwpxDocument): ModelJson {
  const { pkg, header } = doc;
  const resources: Record<ResourceKind, ResourceJson[]> = {};
  for (const [kind, items] of Object.entries(header.resources)) {
    resources[kind] = items.map((item) => {
      const r: ResourceJson = {
        kind: item.kind,
        id: item.id,
        tree: xmlToJson(item.element),
        refs: item.refs.map((ref) => {
          const x: ResourceJson["refs"][number] = { kind: ref.kind, id: ref.id };
          if (ref.lang !== undefined) x.lang = ref.lang;
          return x;
        }),
      };
      if (item.lang !== undefined) r.lang = item.lang;
      return r;
    });
  }
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    source: { size: pkg.bytes.length, sha256: sha256(pkg.bytes) },
    entries: pkg.archive.entries.map((e) => ({
      name: e.name,
      size: e.size,
      method: e.method,
      sha256: sha256(readEntry(pkg.archive, pkg.bytes, e.name)),
    })),
    header: {
      entry: pkg.headerEntry,
      secCnt: header.secCnt === null ? null : header.secCnt.value,
      counts: header.counts.map((c) => {
        const x: ModelJson["header"]["counts"][number] = { list: c.list, kind: c.kind, value: c.value, actual: c.actual };
        if (c.lang !== undefined) x.lang = c.lang;
        return x;
      }),
      resources,
    },
    sections: doc.sections.map((s) => ({ index: s.index, entry: s.entryName, paragraphs: s.paragraphs.map(paragraphJson) })),
    issues: doc.issues.map((i) => ({ ...i })),
  };
}
