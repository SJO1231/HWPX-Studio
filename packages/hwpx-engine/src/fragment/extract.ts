import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { collectBodyRefs } from "../model/refs.ts";
import { walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, ResourceItem } from "../model/types.ts";
import { findEntry, readEntry } from "../package/zip-read.ts";
import { attrNode, attrValue, elIs, walkElements, type XElement } from "../xml/tree.ts";
import { createFingerprinter, makeLookup, resourceRefs } from "./resources.ts";
import { resolveSelection } from "./select.ts";
import type { Fragment, FragmentBinary, FragmentDangling, FragmentRef, FragmentResource, FragmentSelection } from "./types.ts";
import { collectPrefixes, isNoRefOf, scanInstanceAttrs, sha256Hex } from "./util.ts";

const SCHEMA = "hwpx-studio/fragment@1";

/** 같은 원인의 경고를 한 줄로 묶어 개수를 센다. */
function makeTally(): {
  add(code: string, key: string, where: string, message: (n: number) => string): void;
  issues(): Issue[];
} {
  const counts = new Map<string, { code: string; message: (n: number) => string; where: string; n: number }>();
  return {
    add(code, key, where, message) {
      const k = JSON.stringify([code, where, key]);
      const found = counts.get(k);
      if (found === undefined) counts.set(k, { code, message, where, n: 1 });
      else found.n++;
    },
    issues: () => [...counts.values()].map((c) => makeIssue("warning", c.code, c.message(c.n), c.where)),
  };
}

/**
 * 선택한 문단들을 조각으로 뽑는다. 본문은 원문 그대로이고, 서식 자원은 의존 닫힘으로, 그림은 이진 자료까지 담는다.
 * 구역 설정(`secPr`)이 든 문단이 있으면 `FRAG_SECTION_PROPS`, 누름틀의 시작·끝 짝이 범위 안에서 닫히지 않으면 `FRAG_SPLITS_FIELD`.
 */
export function extractFragment(doc: HwpxDocument, selection: FragmentSelection): Fragment {
  const { section, paragraphs } = resolveSelection(doc, selection);
  const first = paragraphs[0];
  const last = paragraphs[paragraphs.length - 1];
  if (first === undefined || last === undefined) throw new HwpxError("FRAG_SELECTION", "선택한 문단이 없습니다.");

  const elements: XElement[] = paragraphs.flatMap((p) => [...walkElements(p.element)]);
  const secPr = elements.find((el) => elIs(el, "paragraph", "secPr"));
  if (secPr !== undefined) {
    throw new HwpxError(
      "FRAG_SECTION_PROPS",
      "구역 설정(secPr)이 든 문단은 조각으로 뽑을 수 없습니다(1차 범위 밖).",
      section.entryName,
    );
  }

  // 누름틀의 시작과 끝은 범위 안에서 짝이 닫혀야 한다(같은 id로 겹쳐 열린 시작은 안쪽 것부터 닫힌다). 아니면 가져온 뒤 짝 없는 시작·끝이 남는다.
  const opened = new Map<string, number>();
  let strayEnds = 0;
  for (const el of elements) {
    if (elIs(el, "paragraph", "fieldBegin")) {
      const id = attrValue(el, "id") ?? "";
      opened.set(id, (opened.get(id) ?? 0) + 1);
    } else if (elIs(el, "paragraph", "fieldEnd")) {
      const id = attrValue(el, "beginIDRef") ?? "";
      const n = opened.get(id) ?? 0;
      if (n === 0) strayEnds++;
      else opened.set(id, n - 1);
    }
  }
  const strayBegins = [...opened.values()].reduce((sum, n) => sum + n, 0);
  if (strayBegins > 0 || strayEnds > 0) {
    throw new HwpxError(
      "FRAG_SPLITS_FIELD",
      `선택한 범위가 누름틀의 시작과 끝 사이를 자릅니다(범위 안에서 짝이 닫히지 않는 시작 ${strayBegins}개, 끝 ${strayEnds}개).`,
      section.entryName,
    );
  }

  const base = first.element.start;
  const xml = section.text.slice(base, last.element.end);
  const lookup = makeLookup(doc);
  const fingerprint = createFingerprinter(lookup);
  const tally = makeTally();
  const headerEntry = doc.pkg.headerEntry;
  // 소스에서 없는 대상을 가리키던 참조의 구조화된 기록(경고 FRAG_DANGLING_SOURCE와 같은 자리에서 센다)
  const dangling = new Map<string, FragmentDangling>();
  const noteDangling = (kind: string, id: string): void => {
    const key = JSON.stringify([kind, id]);
    const found = dangling.get(key);
    if (found === undefined) dangling.set(key, { kind, id, count: 1 });
    else found.count++;
  };

  // 이진 자료: manifest 항목 → 내용
  const binaries = new Map<string, FragmentBinary>();
  const addBinary = (itemId: string, where: string): boolean => {
    if (binaries.has(itemId)) return true;
    const item = doc.pkg.manifestItems.find((m) => m.id === itemId);
    if (item === undefined || findEntry(doc.pkg.archive, item.href) === undefined) {
      tally.add("FRAG_DANGLING_SOURCE", `binaryItem ${itemId}`, where, (n) => `이진 자료 ${itemId}이(가) 없는데 ${n}곳에서 가리킵니다.`);
      noteDangling("binaryItem", itemId);
      return false;
    }
    const bytes = readEntry(doc.pkg.archive, doc.pkg.bytes, item.href);
    binaries.set(itemId, {
      itemId,
      href: item.href,
      mediaType: item.mediaType,
      sha256: sha256Hex(bytes),
      base64: Buffer.from(bytes).toString("base64"),
    });
    return true;
  };

  // 본문 참조
  const refs: FragmentRef[] = [];
  const prints: string[] = [];
  const roots: ResourceItem[] = [];
  for (const p of paragraphs) {
    for (const ref of collectBodyRefs(p.element)) {
      if (ref.kind === "memoShape" || isNoRefOf(ref.kind, ref.id)) continue;
      if (ref.kind === "unknown") {
        const name = ref.attr.qname;
        tally.add("FRAG_UNKNOWN_REF", name, section.entryName, (n) => `자원 참조로 해석하지 못한 ${name} 속성이 ${n}곳 있습니다. 대상을 알 수 없어 번역하지 않고 원래 값 그대로 옮깁니다.`);
        continue;
      }
      const at = { start: ref.attr.valueStart - base, end: ref.attr.valueEnd - base };
      if (ref.kind === "binaryItem") {
        if (addBinary(ref.id, section.entryName)) refs.push({ kind: ref.kind, id: ref.id, ...at });
        continue;
      }
      const target = lookup.resource(ref.kind, undefined, ref.id);
      if (target === undefined) {
        tally.add("FRAG_DANGLING_SOURCE", `${ref.kind} ${ref.id}`, section.entryName, (n) => `${ref.kind} ${ref.id}이(가) 없는데 ${n}곳에서 가리킵니다.`);
        noteDangling(ref.kind, ref.id);
        prints.push(`missing:${ref.id}`);
        continue;
      }
      refs.push({ kind: ref.kind, id: ref.id, ...at });
      prints.push(fingerprint(target));
      roots.push(target);
    }
  }

  // 자원의 의존 닫힘(참조되는 것이 먼저)
  const order: ResourceItem[] = [];
  const seen = new Set<ResourceItem>();
  const visit = (item: ResourceItem): void => {
    if (seen.has(item)) return;
    seen.add(item);
    for (const ref of resourceRefs(item)) {
      if (ref.kind === "binaryItem") {
        addBinary(ref.id, headerEntry);
        continue;
      }
      const target = lookup.resource(ref.kind, ref.lang, ref.id);
      if (target !== undefined) {
        visit(target);
        continue;
      }
      const label = ref.lang === undefined ? `${ref.kind} ${ref.id}` : `${ref.kind}(${ref.lang}) ${ref.id}`;
      tally.add("FRAG_DANGLING_SOURCE", label, headerEntry, (n) => `${label}이(가) 없는데 자원 ${item.kind} ${item.id} 등 ${n}곳에서 가리킵니다.`);
      noteDangling(ref.kind, ref.id);
    }
    order.push(item);
  };
  for (const root of roots) visit(root);

  const headerText = doc.header.text;
  const resources: FragmentResource[] = order.map((item) => {
    const resourcePrefixes = collectPrefixes(walkElements(item.element), item.element.start);
    const el = item.element;
    const idAttr = attrNode(el, "id");
    if (idAttr === undefined) throw new HwpxError("FRAG_SCHEMA", `자원 ${item.kind} ${item.id}에 id 속성이 없습니다.`, headerEntry);
    const rel = (n: number): number => n - el.start;
    const itemRefs: FragmentRef[] = [];
    for (const ref of resourceRefs(item)) {
      const found = ref.kind === "binaryItem" ? binaries.has(ref.id) : lookup.resource(ref.kind, ref.lang, ref.id) !== undefined;
      if (!found) continue;
      const out: FragmentRef = { kind: ref.kind, id: ref.id, start: rel(ref.attr.valueStart), end: rel(ref.attr.valueEnd) };
      if (ref.lang !== undefined) out.lang = ref.lang;
      itemRefs.push(out);
    }
    const res: FragmentResource = {
      kind: item.kind,
      id: item.id,
      xml: headerText.slice(el.start, el.end),
      idSpan: { start: rel(idAttr.valueStart), end: rel(idAttr.valueEnd) },
      refs: itemRefs,
      fingerprint: fingerprint(item),
      ...resourcePrefixes,
    };
    if (item.lang !== undefined) res.lang = item.lang;
    const nameAttr = item.kind === "style" ? attrNode(el, "name") : undefined;
    if (nameAttr !== undefined) res.nameSpan = { start: rel(nameAttr.valueStart), end: rel(nameAttr.valueEnd) };
    return res;
  });

  // 인스턴스 id, 책갈피, 줄 배치 캐시
  const instanceIds = scanInstanceAttrs(elements).map((x) => ({
    role: x.role,
    value: x.attr.value,
    start: x.attr.valueStart - base,
    end: x.attr.valueEnd - base,
  }));
  const bookmarks = elements
    .filter((el) => elIs(el, "paragraph", "bookmark"))
    .flatMap((el) => {
      const name = attrNode(el, "name");
      return name === undefined ? [] : [{ name: name.value, start: name.valueStart - base, end: name.valueEnd - base }];
    });
  const all = [...walkParagraphs(paragraphs)];
  const lineSegSpans = all.flatMap((p) =>
    p.lineSegArray === undefined ? [] : [{ start: p.lineSegArray.start - base, end: p.lineSegArray.end - base }],
  );

  const bodyPrefixes = collectPrefixes(elements, base);
  return {
    schema: SCHEMA,
    source: {
      sha256: sha256Hex(doc.pkg.bytes),
      selection: { ...selection, parentPath: [...selection.parentPath] },
    },
    xml,
    ...bodyPrefixes,
    refs,
    resources,
    binaries: [...binaries.values()],
    instanceIds,
    bookmarks,
    lineSegSpans,
    texts: all.map((p) => p.logicalText),
    prints,
    dangling: [...dangling.values()],
    census: {
      paragraphs: all.length,
      tables: elements.filter((el) => elIs(el, "paragraph", "tbl")).length,
      pictures: elements.filter((el) => elIs(el, "paragraph", "pic")).length,
      fields: elements.filter((el) => elIs(el, "paragraph", "fieldBegin")).length,
      bookmarks: bookmarks.length,
    },
    issues: tally.issues(),
  };
}
