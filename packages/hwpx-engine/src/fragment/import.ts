import { deflateRawSync } from "node:zlib";
import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import type { HeaderModel, HwpxDocument } from "../model/types.ts";
import type { HwpxPackage } from "../package/open.ts";
import { findEntry, readEntry } from "../package/zip-read.ts";
import { decodeEntities, escapeAttr } from "../xml/chars.ts";
import { parseXmlBytes } from "../xml/parse.ts";
import { attrNode, attrValue, childEl, childEls, elementChildren, elIs, nsRole, walkElements, type XElement } from "../xml/tree.ts";
import { validateFragment } from "./json.ts";
import { createFingerprinter, makeLookup } from "./resources.ts";
import { paragraphsAt, sectionAt } from "./select.ts";
import type { Fragment, FragmentResource, InsertPoint } from "./types.ts";
import { applyReps, missingDeclarations, scanInstanceAttrs, sha256Hex, type Rep } from "./util.ts";

// 자원 종류 → header의 목록 요소(local 이름)
const LIST_NAME: Record<string, string> = {
  borderFill: "borderFills",
  charPr: "charProperties",
  tabPr: "tabProperties",
  numbering: "numberings",
  bullet: "bullets",
  paraPr: "paraProperties",
  style: "styles",
};

const MAX_ID = 4294967295;
const isNumericId = (v: string): boolean => /^\d+$/.test(v) && Number(v) < MAX_ID;
const refKey = (kind: string, lang: string | undefined, id: string): string => JSON.stringify([kind, lang ?? "", id]);

function findList(header: HeaderModel, kind: string, lang: string | undefined): XElement | undefined {
  const refList = childEl(header.root, "head", "refList");
  if (refList === undefined) return undefined;
  for (const list of elementChildren(refList)) {
    if (kind === "font") {
      if (!elIs(list, "head", "fontfaces")) continue;
      const face = childEls(list, "head", "fontface").find((f) => attrValue(f, "lang") === lang);
      if (face !== undefined) return face;
    } else if (elIs(list, "head", LIST_NAME[kind] ?? "")) {
      return list;
    }
  }
  return undefined;
}

// ── 자원 대응 ───────────────────────────────────────────────────

type AddedResource = { res: FragmentResource; newId: string; newName?: string; list: XElement };
type ResourcePlan = { ids: Map<string, string>; added: AddedResource[] };

/** 조각 자원을 대상의 같은 지문 자원에 대응시키거나 새 id를 준다. */
function mapResources(target: HwpxDocument, fragment: Fragment): ResourcePlan {
  const lookup = makeLookup(target);
  const fingerprint = createFingerprinter(lookup);

  // 종류(글꼴은 언어별) 안의 지문 → id 목록, 다음 새 id(그 종류에서 가장 큰 숫자 id + 1, 항목이 없으면 0)
  const groups = new Map<string, { byFp: Map<string, string[]>; next: number }>();
  const groupOf = (kind: string, lang: string | undefined): { byFp: Map<string, string[]>; next: number } => {
    const key = refKey(kind, lang, "");
    let group = groups.get(key);
    if (group === undefined) {
      const items = (target.header.resources[kind] ?? []).filter(
        (i) => (kind !== "font" || i.lang === lang) && attrNode(i.element, "id") !== undefined,
      );
      const byFp = new Map<string, string[]>();
      let max = -1;
      for (const item of items) {
        const fp = fingerprint(item);
        const ids = byFp.get(fp);
        if (ids === undefined) byFp.set(fp, [item.id]);
        else ids.push(item.id);
        if (isNumericId(item.id)) max = Math.max(max, Number(item.id));
      }
      group = { byFp, next: max + 1 };
      groups.set(key, group);
    }
    return group;
  };

  const styleNames = new Set((target.header.resources["style"] ?? []).flatMap((s) => attrValue(s.element, "name") ?? []));
  const ids = new Map<string, string>();
  const added: AddedResource[] = [];
  for (const res of fragment.resources) {
    const group = groupOf(res.kind, res.lang);
    const known = group.byFp.get(res.fingerprint);
    let newId: string;
    if (known !== undefined && known.length > 0) {
      newId = known.includes(res.id) ? res.id : (known[0] ?? res.id);
    } else {
      const list = findList(target.header, res.kind, res.lang);
      if (list === undefined) {
        const where = res.lang === undefined ? res.kind : `${res.kind}(${res.lang})`;
        throw new HwpxError("FRAG_NO_LIST", `대상 header에 ${where} 목록이 없어 자원 ${res.id}을(를) 넣을 수 없습니다.`, target.pkg.headerEntry);
      }
      newId = String(group.next++);
      group.byFp.set(res.fingerprint, [newId]);
      const entry: AddedResource = { res, newId, list };
      if (res.kind === "style" && res.nameSpan !== undefined) {
        const name = decodeEntities(res.xml.slice(res.nameSpan.start, res.nameSpan.end));
        let unique = name;
        for (let k = 2; styleNames.has(unique); k++) unique = `${name} (${k})`;
        styleNames.add(unique);
        if (unique !== name) entry.newName = unique;
      }
      added.push(entry);
    }
    ids.set(refKey(res.kind, res.lang, res.id), newId);
  }
  return { ids, added };
}

/** 추가할 자원의 원문을 새 id·새 참조·새 이름으로 고친다. */
function rewriteResource(entry: AddedResource, ids: Map<string, string>, binaries: Map<string, string>): string {
  const { res } = entry;
  const reps: Rep[] = [{ ...res.idSpan, text: entry.newId }];
  for (const r of res.refs) {
    const to = r.kind === "binaryItem" ? binaries.get(r.id) : ids.get(refKey(r.kind, r.lang, r.id));
    if (to === undefined) throw new HwpxError("FRAG_SCHEMA", `자원 ${res.kind} ${res.id}의 참조 ${r.kind} ${r.id}에 대응하는 값이 없습니다.`);
    reps.push({ start: r.start, end: r.end, text: to });
  }
  if (entry.newName !== undefined && res.nameSpan !== undefined) {
    reps.push({ ...res.nameSpan, text: escapeAttr(entry.newName) });
  }
  return applyReps(res.xml, reps);
}

/** 루트 요소의 시작 태그에 네임스페이스 선언을 더하는 편집. 선언이 없던 접두사를 조각이 쓸 때만 있다. */
function declarationEdit(entry: string, root: XElement, missing: Map<string, string>): SpanEdit[] {
  if (missing.size === 0) return [];
  const text = [...missing].map(([prefix, uri]) => ` xmlns:${prefix}="${escapeAttr(uri)}"`).join("");
  const at = root.openEnd - 1; // 시작 태그의 `>` 앞
  return [{ entry, start: at, end: at, expected: "", replacement: text, reason: "조각이 쓰는 네임스페이스 접두사 선언 추가" }];
}

/** 목록 요소 끝에 항목 원문을 더하고 개수 속성을 고치는 편집들. */
function listEdits(header: HeaderModel, headerEntry: string, list: XElement, items: string[], reason: string): SpanEdit[] {
  const text = items.join("");
  const edits: SpanEdit[] = [];
  if (list.end === list.openEnd) {
    // `<목록 .../>`는 펼친다
    edits.push({
      entry: headerEntry,
      start: list.openEnd - 2,
      end: list.openEnd,
      expected: "/>",
      replacement: `>${text}</${list.qname}>`,
      reason,
    });
  } else {
    const last = elementChildren(list).at(-1);
    const at = last === undefined ? list.openEnd : last.end;
    edits.push({ entry: headerEntry, start: at, end: at, expected: "", replacement: text, reason });
  }
  const slot = header.counts.find((c) => c.element === list);
  if (slot !== undefined) {
    edits.push({
      entry: headerEntry,
      start: slot.attr.valueStart,
      end: slot.attr.valueEnd,
      expected: header.text.slice(slot.attr.valueStart, slot.attr.valueEnd),
      replacement: String(slot.actual + items.length),
      reason: `${list.local} 개수 속성 갱신`,
    });
  }
  return edits;
}

// ── 이진 자료 ───────────────────────────────────────────────────

function locateManifest(pkg: HwpxPackage): { entry: string; manifest: XElement } {
  const container = parseXmlBytes(readEntry(pkg.archive, pkg.bytes, "META-INF/container.xml"), "META-INF/container.xml");
  const rootfiles = [...walkElements(container.root)].filter((el) => elIs(el, "container", "rootfile"));
  const rootfile =
    rootfiles.find((el) => attrValue(el, "media-type") === "application/hwpml-package+xml") ??
    rootfiles.find((el) => (attrValue(el, "full-path") ?? "").endsWith(".hpf"));
  const entry = rootfile === undefined ? undefined : attrValue(rootfile, "full-path");
  if (entry === undefined) throw new HwpxError("PKG_MISSING", "container.xml에 패키지 루트 파일(rootfile)이 없습니다.", "META-INF/container.xml");
  const hpf = parseXmlBytes(readEntry(pkg.archive, pkg.bytes, entry), entry);
  const manifest = [...walkElements(hpf.root)].find((el) => elIs(el, "opf", "manifest"));
  if (manifest === undefined) throw new HwpxError("PKG_MISSING", "content.hpf에 manifest가 없습니다.", entry);
  return { entry, manifest };
}

/** 숫자로 끝나는 id는 자릿수를 유지하며 겹치지 않는 값을 찾는다(image1 → image2, BIN0001 → BIN0002). */
function freeItemId(want: string, taken: Set<string>): string {
  if (!taken.has(want)) return want;
  const m = /^(.*?)(\d*)$/.exec(want);
  const base = m?.[1] ?? want;
  const width = m?.[2]?.length ?? 0;
  for (let k = 1; ; k++) {
    const id = `${base}${String(k).padStart(width, "0")}`;
    if (!taken.has(id)) return id;
  }
}

function freeEntryName(id: string, href: string, taken: Set<string>): string {
  const ext = /\.[A-Za-z0-9]+$/.exec(href)?.[0] ?? "";
  let name = `BinData/${id}${ext}`;
  for (let k = 2; taken.has(name.toLowerCase()); k++) name = `BinData/${id}_${k}${ext}`;
  return name;
}

type BinaryPlan = { ids: Map<string, string>; reused: number; added: number };

/** 조각의 이진 자료를 대상에 대응시킨다: 같은 내용이 있으면 재사용, 없으면 항목과 manifest 등록을 계획에 더한다. */
function planBinaries(target: HwpxDocument, fragment: Fragment, edits: SpanEdit[], additions: EditPlan["additions"]): BinaryPlan {
  const out: BinaryPlan = { ids: new Map(), reused: 0, added: 0 };
  if (fragment.binaries.length === 0) return out;
  const { pkg } = target;
  const takenIds = new Set(pkg.manifestItems.map((m) => m.id));
  const takenNames = new Set(pkg.archive.entries.map((e) => e.name.toLowerCase()));
  const addedBySha = new Map<string, string>();
  const items: string[] = [];
  const located = locateManifest(pkg);
  const lastItem = elementChildren(located.manifest).filter((el) => elIs(el, "opf", "item")).at(-1);
  if (lastItem === undefined) throw new HwpxError("PKG_MISSING", "content.hpf의 manifest에 항목이 없습니다.", located.entry);

  for (const b of fragment.binaries) {
    const data = new Uint8Array(Buffer.from(b.base64, "base64"));
    if (sha256Hex(data) !== b.sha256) throw new HwpxError("FRAG_SCHEMA", `이진 자료 ${b.itemId}의 내용이 sha256과 다릅니다.`);

    // 대상 manifest에 같은 내용의 항목이 있는가(크기가 같은 것만 해시를 본다)
    const same = pkg.manifestItems.find((m) => {
      const entry = findEntry(pkg.archive, m.href);
      return entry !== undefined && entry.size === data.length && sha256Hex(readEntry(pkg.archive, pkg.bytes, m.href)) === b.sha256;
    });
    const duplicate = addedBySha.get(b.sha256);
    if (same !== undefined || duplicate !== undefined) {
      out.ids.set(b.itemId, same?.id ?? duplicate ?? b.itemId);
      out.reused++;
      continue;
    }

    const id = freeItemId(b.itemId, takenIds);
    const name = freeEntryName(id, b.href, takenNames);
    takenIds.add(id);
    takenNames.add(name.toLowerCase());
    addedBySha.set(b.sha256, id);
    const deflated = deflateRawSync(data);
    additions.push({ name, data, method: deflated.length < data.length ? 8 : 0 });
    const prefix = lastItem.prefix === "" ? "" : `${lastItem.prefix}:`;
    items.push(
      `<${prefix}item id="${escapeAttr(id)}" href="${escapeAttr(name)}" media-type="${escapeAttr(b.mediaType)}" isEmbeded="1"/>`,
    );
    out.ids.set(b.itemId, id);
    out.added++;
  }
  if (items.length > 0) {
    edits.push({
      entry: located.entry,
      start: lastItem.end,
      end: lastItem.end,
      expected: "",
      replacement: items.join(""),
      reason: "manifest에 이진 자료 항목 등록",
    });
  }
  return out;
}

// ── 인스턴스 id·책갈피 ──────────────────────────────────────────

function reissueIds(target: HwpxDocument, fragment: Fragment, reps: Rep[]): number {
  const used = { object: new Set<string>(), inst: new Set<string>(), fieldBegin: new Set<string>() };
  let max = 0;
  const note = (v: string): void => {
    if (isNumericId(v)) max = Math.max(max, Number(v));
  };
  for (const s of target.sections) {
    for (const x of scanInstanceAttrs(walkElements(s.root))) {
      if (x.role !== "fieldEndRef") used[x.role].add(x.attr.value);
      note(x.attr.value);
    }
  }
  for (const x of fragment.instanceIds) note(x.value);

  let counter = max + 1;
  let reissued = 0;
  const fieldIds = new Map<string, string>();
  for (const x of fragment.instanceIds) {
    if (x.role === "fieldEndRef") continue;
    const placeholder = x.role !== "fieldBegin" && (x.value === "0" || x.value === "");
    if (!placeholder && !used[x.role].has(x.value)) continue;
    const next = String(counter++);
    reps.push({ start: x.start, end: x.end, text: next });
    reissued++;
    if (x.role === "fieldBegin") fieldIds.set(x.value, next);
  }
  // 누름틀의 끝은 짝인 시작이 새 id를 받았을 때 함께 바꾼다
  for (const x of fragment.instanceIds) {
    const next = x.role === "fieldEndRef" ? fieldIds.get(x.value) : undefined;
    if (next !== undefined) reps.push({ start: x.start, end: x.end, text: next });
  }
  return reissued;
}

function renameBookmarks(target: HwpxDocument, fragment: Fragment, reps: Rep[]): number {
  const taken = new Set<string>();
  for (const s of target.sections) {
    for (const el of walkElements(s.root)) {
      const name = elIs(el, "paragraph", "bookmark") ? attrValue(el, "name") : undefined;
      if (name !== undefined) taken.add(name);
    }
  }
  let renamed = 0;
  for (const b of fragment.bookmarks) {
    let name = b.name;
    if (taken.has(name)) {
      let k = 1;
      while (taken.has(`${b.name}_${k}`)) k++;
      name = `${b.name}_${k}`;
      reps.push({ start: b.start, end: b.end, text: escapeAttr(name) });
      renamed++;
    }
    taken.add(name);
  }
  return renamed;
}

// ── 가져오기 ────────────────────────────────────────────────────

/**
 * 조각을 대상 문서의 삽입 지점에 넣는 편집 계획을 만든다. 대상 문서를 바꾸지 않고, 적용은 `applyPlan`이 한다.
 * 자원은 지문이 같은 것을 재사용하고 없으면 header 목록 끝에 추가한다. 조각 본문은 원문 그대로 옮기되
 * 참조 id·인스턴스 id·책갈피 이름의 속성값 구간만 바꾸고 줄 배치 캐시는 지운다.
 */
export function planImport(target: HwpxDocument, fragment: Fragment, at: InsertPoint): EditPlan {
  validateFragment(fragment);
  const section = sectionAt(target, at.sectionIndex, "FRAG_INSERT_POINT");
  const siblings = paragraphsAt(section, at.parentPath, "FRAG_INSERT_POINT");
  const anchor = Number.isInteger(at.index) ? siblings[at.index] : undefined;
  if (anchor === undefined || (at.position !== "before" && at.position !== "after")) {
    throw new HwpxError("FRAG_INSERT_POINT", `삽입 지점 ${at.index}(${at.position})이 올바르지 않습니다(목록의 문단 ${siblings.length}개).`);
  }
  const issues: Issue[] = [...fragment.issues];
  const edits: SpanEdit[] = [];
  const additions: EditPlan["additions"] = [];
  const headerEntry = target.pkg.headerEntry;

  // 1. 접두사: 같은 역할로 선언돼 있으면 통과, 다른 역할이면 거절, 선언이 없으면 루트에 선언을 더한다
  edits.push(
    ...declarationEdit(
      section.entryName,
      section.root,
      missingDeclarations(fragment.prefixes, fragment.namespaces, anchor.element.parent, section.entryName, "조각 본문"),
    ),
  );
  if (at.position === "before" && [...walkElements(anchor.element)].some((el) => elIs(el, "paragraph", "secPr"))) {
    issues.push(
      makeIssue("warning", "FRAG_BEFORE_SECPR", "구역 설정(secPr)이 든 문단 앞에 넣으면 구역 설정이 첫 문단이 아니게 됩니다.", section.entryName),
    );
  }

  // 6. 이진 자료(자원이 이진 자료를 가리킬 수 있으므로 먼저 대응시킨다)
  const binaries = planBinaries(target, fragment, edits, additions);

  // 2. 자원 대응과 header 편집
  const resources = mapResources(target, fragment);
  const byList = new Map<XElement, { items: string[]; reason: string }>();
  const headerDeclarations = new Map<string, string>();
  for (const entry of resources.added) {
    const what = `자원 ${entry.res.kind} ${entry.res.id}`;
    for (const [prefix, uri] of missingDeclarations(entry.res.prefixes, entry.res.namespaces, entry.list, headerEntry, what)) {
      const known = headerDeclarations.get(prefix);
      if (known !== undefined && nsRole(known) !== nsRole(uri)) {
        throw new HwpxError("FRAG_NS_MISMATCH", `${what}: 접두사 '${prefix}'가 자원마다 다른 역할입니다.`, headerEntry);
      }
      if (known === undefined) headerDeclarations.set(prefix, uri);
    }
    const group = byList.get(entry.list) ?? { items: [], reason: `${entry.list.local}에 자원 추가` };
    group.items.push(rewriteResource(entry, resources.ids, binaries.ids));
    byList.set(entry.list, group);
  }
  edits.push(...declarationEdit(headerEntry, target.header.root, headerDeclarations));
  for (const [list, group] of byList) edits.push(...listEdits(target.header, headerEntry, list, group.items, group.reason));

  // 3~5. 본문 재작성
  const reps: Rep[] = [];
  for (const r of fragment.refs) {
    const to = r.kind === "binaryItem" ? binaries.ids.get(r.id) : resources.ids.get(refKey(r.kind, undefined, r.id));
    if (to === undefined) throw new HwpxError("FRAG_SCHEMA", `본문 참조 ${r.kind} ${r.id}에 대응하는 값이 없습니다.`);
    if (to !== r.id) reps.push({ start: r.start, end: r.end, text: to });
  }
  for (const s of fragment.lineSegSpans) reps.push({ start: s.start, end: s.end, text: "" });
  const reissuedIds = reissueIds(target, fragment, reps);
  const renamedBookmarks = renameBookmarks(target, fragment, reps);

  // 7. 삽입
  const position = at.position === "before" ? anchor.element.start : anchor.element.end;
  edits.push({
    entry: section.entryName,
    start: position,
    end: position,
    expected: "",
    replacement: applyReps(fragment.xml, reps),
    reason: `조각 삽입(문단 ${fragment.census.paragraphs}개)`,
  });

  return {
    edits,
    additions,
    summary: {
      reusedResources: fragment.resources.length - resources.added.length,
      addedResources: resources.added.length,
      reusedBinaries: binaries.reused,
      addedBinaries: binaries.added,
      reissuedIds,
      renamedStyles: resources.added.filter((a) => a.newName !== undefined).length,
      renamedBookmarks,
      insertedParagraphs: fragment.census.paragraphs,
      insertedTables: fragment.census.tables,
      insertedPictures: fragment.census.pictures,
      insertedFields: fragment.census.fields,
      insertedBookmarks: fragment.census.bookmarks,
    },
    issues,
  };
}
