import { deflateRawSync } from "node:zlib";
import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { FONT_LANGS, type HeaderModel, type HwpxDocument } from "../model/types.ts";
import { readXmlVersion } from "../package/format-version.ts";
import type { HwpxPackage } from "../package/open.ts";
import { findEntry, readEntry } from "../package/zip-read.ts";
import { decodeEntities, escapeAttr } from "../xml/chars.ts";
import { parseXmlBytes } from "../xml/parse.ts";
import { attrNode, attrValue, childEl, childEls, subElements, elIs, nsRole, walkElements, type XElement } from "../xml/tree.ts";
import { validateFragment } from "./json.ts";
import { createFingerprinter, danglingIdsOf, makeLookup } from "./resources.ts";
import { paragraphsAt, sectionAt } from "./select.ts";
import type { Fragment, FragmentResource, ImportOptions, ImportPlan, InheritedDuplicate, InsertPoint } from "./types.ts";
import { convertFragmentUnits } from "./units.ts";
import { applyReps, declaresPrefixOrUri, missingDeclarations, scanInstanceAttrs, sha256Hex, type Rep } from "./util.ts";

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

// refList 안에서 관측한 목록 순서(한컴 저장본·합성 시험 문서 공통). 새 목록은 자기보다 순서가 뒤인 첫 목록 앞에 둔다. 그 밖의 목록(메모 모양 등)은 맨 뒤다.
const LIST_ORDER = ["fontfaces", "borderFills", "charProperties", "tabProperties", "numberings", "bullets", "paraProperties", "styles"];
const listRank = (local: string): number => {
  const i = LIST_ORDER.indexOf(local);
  return i < 0 ? LIST_ORDER.length : i;
};
const langRank = (lang: string | undefined): number => {
  const i = FONT_LANGS.findIndex((l) => l === lang);
  return i < 0 ? FONT_LANGS.length : i;
};

const MAX_ID = 4294967295;
const isNumericId = (v: string): boolean => /^\d+$/.test(v) && Number(v) < MAX_ID;
const refKey = (kind: string, lang: string | undefined, id: string): string => JSON.stringify([kind, lang ?? "", id]);

export function findList(header: HeaderModel, kind: string, lang: string | undefined): XElement | undefined {
  const refList = childEl(header.root, "head", "refList");
  if (refList === undefined) return undefined;
  for (const list of subElements(refList)) {
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

/**
 * 대상 header에 없어 새로 만들 목록. 글꼴은 `fontfaces` 안의 언어별 `fontface`, 그 밖은 `refList` 안의 목록 요소다.
 * 요소 이름은 종류별로 정해져 있고(`LIST_NAME`) 접두사는 가져오는 항목 원문의 것을 따른다.
 */
type NewList = { create: true; kind: string; lang: string | undefined; qname: string; parent: XElement };
type TargetList = XElement | NewList;
type AddedResource = { res: FragmentResource; newId: string; newName?: string; list: TargetList };
type ResourcePlan = { ids: Map<string, string>; added: AddedResource[] };

const isNewList = (list: TargetList): list is NewList => "create" in list;

/** 새 목록을 만든다. 만들 자리(`refList`, 글꼴은 `fontfaces`)가 대상에 없으면 `FRAG_NO_LIST`. */
function makeNewList(target: HwpxDocument, res: FragmentResource): NewList {
  const refList = childEl(target.header.root, "head", "refList");
  const parent = res.kind === "font" && refList !== undefined ? childEl(refList, "head", "fontfaces") : refList;
  const name = res.kind === "font" ? "fontface" : LIST_NAME[res.kind];
  if (parent === undefined || name === undefined) {
    const where = res.lang === undefined ? res.kind : `${res.kind}(${res.lang})`;
    throw new HwpxError("FRAG_NO_LIST", `대상 header에 ${where} 목록이 없고 만들 자리도 없어 자원 ${res.id}을(를) 넣을 수 없습니다.`, target.pkg.headerEntry);
  }
  const itemName = /^<([^\s/>]+)/.exec(res.xml)?.[1] ?? "";
  const prefix = itemName.includes(":") ? itemName.slice(0, itemName.indexOf(":") + 1) : "";
  return { create: true, kind: res.kind, lang: res.lang, qname: `${prefix}${name}`, parent };
}

/** 조각 자원을 대상의 같은 지문 자원에 대응시키거나 새 id를 준다. */
function mapResources(target: HwpxDocument, fragment: Fragment): ResourcePlan {
  const lookup = makeLookup(target);
  const fingerprint = createFingerprinter(lookup);

  // 종류(글꼴은 언어별) 안의 지문 → id 목록, 다음 새 id(그 종류에서 가장 큰 숫자 id + 1, 항목이 없으면 0)와 건너뛸 id
  // (대상에서 없는 자원을 가리키던 참조의 id: 새 자원이 받으면 기존 문단·자원이 새 자원을 가리키게 된다)
  const danglingIds = danglingIdsOf(target, lookup);
  type Group = { byFp: Map<string, string[]>; next: number; skip: ReadonlySet<string> };
  const groups = new Map<string, Group>();
  const groupOf = (kind: string, lang: string | undefined): Group => {
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
      group = { byFp, next: max + 1, skip: danglingIds(kind, lang) };
      groups.set(key, group);
    }
    return group;
  };

  const styleNames = new Set((target.header.resources["style"] ?? []).flatMap((s) => attrValue(s.element, "name") ?? []));
  const created = new Map<string, NewList>();
  const ids = new Map<string, string>();
  const added: AddedResource[] = [];
  for (const res of fragment.resources) {
    const group = groupOf(res.kind, res.lang);
    const known = group.byFp.get(res.fingerprint);
    let newId: string;
    if (known !== undefined && known.length > 0) {
      newId = known.includes(res.id) ? res.id : (known[0] ?? res.id);
    } else {
      const key = refKey(res.kind, res.lang, "");
      let list: TargetList | undefined = findList(target.header, res.kind, res.lang) ?? created.get(key);
      if (list === undefined) {
        list = makeNewList(target, res);
        created.set(key, list);
      }
      while (group.skip.has(String(group.next))) group.next++;
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
export function listEdits(header: HeaderModel, headerEntry: string, list: XElement, items: string[], reason: string): SpanEdit[] {
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
    const last = subElements(list).at(-1);
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

/**
 * 대상에 없던 목록을 만드는 편집들. 목록은 부모(`refList`, 글꼴은 `fontfaces`) 안에서 자기보다 순서가 뒤인 첫 목록 앞에 놓고,
 * 없으면 맨 뒤에 놓는다. 같은 자리의 삽입은 계획 순서를 지키므로 순서가 앞선 목록부터 낸다. 새 `fontface`를 만들면 `fontfaces`의 개수 속성도 고친다.
 * 개수 속성(`itemCnt`, 글꼴은 `fontCnt`)은 새로 넣는다.
 */
function newListEdits(header: HeaderModel, headerEntry: string, groups: { list: NewList; items: string[]; reason: string }[]): SpanEdit[] {
  const rankOf = (nl: NewList): number => (nl.kind === "font" ? langRank(nl.lang) : listRank(LIST_NAME[nl.kind] ?? ""));
  const edits: SpanEdit[] = [];
  const byParent = new Map<XElement, { list: NewList; text: string; reason: string }[]>();
  for (const g of [...groups].sort((a, b) => rankOf(a.list) - rankOf(b.list))) {
    const nl = g.list;
    const attrs = nl.kind === "font" ? ` lang="${escapeAttr(nl.lang ?? "")}" fontCnt="${g.items.length}"` : ` itemCnt="${g.items.length}"`;
    const text = `<${nl.qname}${attrs}>${g.items.join("")}</${nl.qname}>`;
    byParent.set(nl.parent, [...(byParent.get(nl.parent) ?? []), { list: nl, text, reason: g.reason }]);
  }
  for (const [parent, news] of byParent) {
    const font = news[0]?.list.kind === "font";
    if (parent.end === parent.openEnd) {
      // 자식이 없는 `<부모/>`는 펼쳐 새 목록들을 순서대로 넣는다
      const reason = news.map((n) => n.reason).join(", ");
      edits.push({ entry: headerEntry, start: parent.openEnd - 2, end: parent.openEnd, expected: "/>", replacement: `>${news.map((n) => n.text).join("")}</${parent.qname}>`, reason });
    } else {
      const kids = subElements(parent);
      for (const n of news) {
        const own = rankOf(n.list);
        const next = kids.find((k) => (font ? langRank(attrValue(k, "lang")) : listRank(k.local)) > own);
        const at = next === undefined ? (kids.at(-1)?.end ?? parent.openEnd) : next.start;
        edits.push({ entry: headerEntry, start: at, end: at, expected: "", replacement: n.text, reason: n.reason });
      }
    }
    const slot = font ? header.counts.find((c) => c.element === parent) : undefined;
    if (slot !== undefined) {
      edits.push({
        entry: headerEntry,
        start: slot.attr.valueStart,
        end: slot.attr.valueEnd,
        expected: header.text.slice(slot.attr.valueStart, slot.attr.valueEnd),
        replacement: String(slot.actual + news.length),
        reason: `${parent.local} 개수 속성 갱신`,
      });
    }
  }
  return edits;
}

// ── 이진 자료 ───────────────────────────────────────────────────

function locateManifest(pkg: HwpxPackage): { entry: string; manifest: XElement } {
  const entry = pkg.rootfile;
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
  const lastItem = subElements(located.manifest).filter((el) => elIs(el, "opf", "item")).at(-1);
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

/** 한컴이 여러 문단에 같은 값을 쓰는 자리값. 겹쳐도 되므로 바꾸지 않고, 새 값으로도 쓰지 않는다. */
const PARAGRAPH_PLACEHOLDERS = new Set(["", "0", "2147483648", "4294967295"]);

/**
 * 객체·instId·누름틀 id(대상과 조각을 합친 가장 큰 숫자 + 1부터)와 문단 id(문단 id끼리의 최댓값 + 1부터)를 재발급한다.
 * 객체 계열은 대상에 있거나 자리값(0, 빈 값)이면 바꾸고, 문단 id는 자리값이 아니고 대상에 이미 있을 때만 바꾼다.
 * `internal`이면 조각 안에서 겹치는 값도 첫 등장만 두고 바꾼다. 누름틀 끝은 짝인 시작(같은 id가 겹쳐 열렸으면 안쪽 시작이 먼저 닫히는 짝)이
 * 새 id를 받았을 때 함께 바꾼다. `finals`는 `fragment.instanceIds`마다 가져온 뒤의 값이다.
 */
function reissueIds(target: HwpxDocument, fragment: Fragment, reps: Rep[], internal: boolean): { reissued: number; finals: string[] } {
  const used = { object: new Set<string>(), inst: new Set<string>(), fieldBegin: new Set<string>(), paragraph: new Set<string>() };
  let max = 0;
  let paragraphMax = 0;
  const note = (v: string): void => {
    if (isNumericId(v)) max = Math.max(max, Number(v));
  };
  const noteParagraph = (v: string): void => {
    if (isNumericId(v)) paragraphMax = Math.max(paragraphMax, Number(v));
  };
  for (const s of target.sections) {
    for (const x of scanInstanceAttrs(walkElements(s.root))) {
      if (x.role === "paragraph") {
        used.paragraph.add(x.attr.value);
        noteParagraph(x.attr.value);
        continue;
      }
      if (x.role !== "fieldEndRef") used[x.role].add(x.attr.value);
      note(x.attr.value);
    }
  }
  for (const x of fragment.instanceIds) (x.role === "paragraph" ? noteParagraph : note)(x.value);

  const finals = fragment.instanceIds.map((x) => x.value);
  let counter = max + 1;
  let reissued = 0;
  const seen = { object: new Set<string>(), inst: new Set<string>(), fieldBegin: new Set<string>() };
  const open = new Map<string, number[]>(); // 원래 id → 아직 닫히지 않은 시작의 서수(문서 순서)
  const latest = new Map<string, string>(); // 원래 id → 가장 최근에 새 id를 받은 시작의 값(짝을 찾지 못한 끝용)
  fragment.instanceIds.forEach((x, i) => {
    if (x.role === "paragraph") return;
    if (x.role === "fieldEndRef") {
      const begin = open.get(x.value)?.pop();
      const next = begin === undefined ? latest.get(x.value) : finals[begin];
      if (next !== undefined && next !== x.value) {
        reps.push({ start: x.start, end: x.end, text: next });
        finals[i] = next;
      }
      return;
    }
    const placeholder = x.role !== "fieldBegin" && (x.value === "0" || x.value === "");
    const repeated = internal && seen[x.role].has(x.value);
    seen[x.role].add(x.value);
    if (x.role === "fieldBegin") open.set(x.value, [...(open.get(x.value) ?? []), i]);
    if (!placeholder && !repeated && !used[x.role].has(x.value)) return;
    const next = String(counter++);
    reps.push({ start: x.start, end: x.end, text: next });
    finals[i] = next;
    reissued++;
    if (x.role === "fieldBegin") latest.set(x.value, next);
  });
  return { reissued: reissued + reissueParagraphIds(fragment, used.paragraph, paragraphMax, reps, internal, finals), finals };
}

/**
 * 조각 문단의 id가 자리값이 아니고 대상에 이미 있으면(`internal`이면 조각 안에서 앞서 나온 값과 같을 때도) 새 값으로 바꾼다
 * (같은 문서에 다시 넣을 때 문단 id가 겹치지 않게). 새 값은 `paragraphMax + 1`부터 문서 순서로 주되 자리값과 이미 쓰인 값은 건너뛴다.
 * 4294967295에 닿으면 1부터 빈 값을 찾는다.
 */
function reissueParagraphIds(fragment: Fragment, inTarget: Set<string>, paragraphMax: number, reps: Rep[], internal: boolean, finals: string[]): number {
  const taken = new Set(inTarget);
  for (const x of fragment.instanceIds) if (x.role === "paragraph") taken.add(x.value);
  let counter = paragraphMax + 1;
  const take = (): string => {
    for (;;) {
      if (counter >= MAX_ID) counter = 1;
      const id = String(counter++);
      if (!PARAGRAPH_PLACEHOLDERS.has(id) && !taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  };
  let reissued = 0;
  const seen = new Set<string>();
  fragment.instanceIds.forEach((x, i) => {
    if (x.role !== "paragraph" || PARAGRAPH_PLACEHOLDERS.has(x.value)) return;
    const repeated = internal && seen.has(x.value);
    seen.add(x.value);
    if (!repeated && !inTarget.has(x.value)) return;
    const next = take();
    reps.push({ start: x.start, end: x.end, text: next });
    finals[i] = next;
    reissued++;
  });
  return reissued;
}

/**
 * 가져온 뒤에도 조각 안에서 겹치는 id(대상과 부딪쳐 재발급한 것은 이미 갈라져 있어 없다)를 센다. 검사기가 세지 않는 값(빈 값, 문단 id의 자리값)은 뺀다.
 */
function inheritedDuplicates(fragment: Fragment, finals: string[]): InheritedDuplicate[] {
  const counts = new Map<string, InheritedDuplicate>();
  fragment.instanceIds.forEach((x, i) => {
    if (x.role === "fieldEndRef") return;
    const value = finals[i] ?? x.value;
    if (value === "" || (x.role === "paragraph" && PARAGRAPH_PLACEHOLDERS.has(value))) return;
    const key = JSON.stringify([x.role, value]);
    const found = counts.get(key);
    if (found === undefined) counts.set(key, { role: x.role, value, count: 1 });
    else found.count++;
  });
  return [...counts.values()].filter((d) => d.count > 1);
}

const ROLE_LABEL: Record<InheritedDuplicate["role"], string> = { paragraph: "문단 id", object: "객체 id", inst: "instId", fieldBegin: "누름틀 id" };

/**
 * 삽입 지점이 표 셀 안이고 그 표가 글자처럼 취급(`treatAsChar="1"`)이거나 쪽 나눔이 없거나(`pageBreak="NONE"`) 표 단위로만 나뉘면(`pageBreak="TABLE"`) 그 사유를 돌려준다.
 * 이런 표는 셀 높이가 늘지 않거나 한 셀이 쪽 경계에서 나뉘지 않아(`TABLE`은 행 경계에서만 나뉜다) 셀 안 내용이 쪽보다 길면 잘릴 수 있다(동작은 바꾸지 않고 경고만 한다).
 */
function cellClipReasons(anchor: XElement): string[] {
  // 문단 → subList → tc → tr → tbl
  const up = (el: XElement | null, n: number): XElement | null => (n === 0 || el === null ? el : up(el.parent, n - 1));
  const subList = up(anchor, 1);
  const tc = up(anchor, 2);
  const table = up(anchor, 4);
  if (subList === null || tc === null || table === null) return [];
  if (!elIs(subList, "paragraph", "subList") || !elIs(tc, "paragraph", "tc") || !elIs(table, "paragraph", "tbl")) return [];
  const reasons: string[] = [];
  const pos = childEl(table, "paragraph", "pos");
  if ((attrValue(table, "treatAsChar") ?? (pos === undefined ? undefined : attrValue(pos, "treatAsChar"))) === "1") reasons.push('treatAsChar="1"(글자처럼 취급)');
  const pageBreak = attrValue(table, "pageBreak");
  if (pageBreak === "NONE") reasons.push('pageBreak="NONE"(쪽 나눔 없음)');
  else if (pageBreak === "TABLE") reasons.push('pageBreak="TABLE"(셀 안에서는 나뉘지 않음)');
  return reasons;
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
 * 참조 id·인스턴스 id·책갈피 이름의 속성값 구간만 바꾸고 줄 배치 캐시는 지운다. 대상에 없는 목록(글머리표 목록 등)은 만든다.
 * 소스에서부터 조각이 갖고 있던 문제(조각 안에서 겹치는 id, 없는 대상을 가리키던 참조)는 계획의 `inherited`에 기록한다.
 * `options.reissueInternalDuplicates`를 켜면 조각 안에서 겹치는 id도 첫 등장만 두고 새 값으로 바꾼다(기본은 끔: 소스 원문 그대로).
 * 원본과 대상의 형식 버전이 1.5 이상·미만으로 갈리면 자원 대응 전에 자원을 대상 단위로 바꾼다(`convertFragmentUnits`, 명세 7.66).
 */
export function planImport(target: HwpxDocument, given: Fragment, at: InsertPoint, options: ImportOptions = {}): ImportPlan {
  validateFragment(given);
  const section = sectionAt(target, at.sectionIndex, "FRAG_INSERT_POINT");
  const siblings = paragraphsAt(section, at.parentPath, "FRAG_INSERT_POINT");
  const anchor = Number.isInteger(at.index) ? siblings[at.index] : undefined;
  if (anchor === undefined || (at.position !== "before" && at.position !== "after")) {
    throw new HwpxError("FRAG_INSERT_POINT", `삽입 지점 ${at.index}(${at.position})이 올바르지 않습니다(목록의 문단 ${siblings.length}개).`);
  }
  const headerEntry = target.pkg.headerEntry;
  // 2(앞부분). 단위 변환: 원본과 대상의 형식 버전이 1.5 이상·미만으로 갈리면 자원을 대상 단위로 바꾼다(자원 대응 전이라 같은 모양이면 대상 자원을 재사용한다)
  const units = convertFragmentUnits(given, readXmlVersion(target.pkg), headerEntry);
  const fragment = units.fragment;
  const issues: Issue[] = [...fragment.issues, ...units.issues];
  const edits: SpanEdit[] = [];
  const additions: EditPlan["additions"] = [];

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
  const byList = new Map<TargetList, { items: string[]; reason: string }>();
  const headerDeclarations = new Map<string, string>();
  for (const entry of resources.added) {
    const what = `자원 ${entry.res.kind} ${entry.res.id}`;
    const scope = isNewList(entry.list) ? entry.list.parent : entry.list;
    for (const [prefix, uri] of missingDeclarations(entry.res.prefixes, entry.res.namespaces, scope, headerEntry, what)) {
      const known = headerDeclarations.get(prefix);
      if (known !== undefined && nsRole(known) !== nsRole(uri)) {
        throw new HwpxError("FRAG_NS_MISMATCH", `${what}: 접두사 '${prefix}'가 자원마다 다른 역할입니다.`, headerEntry);
      }
      if (known === undefined) headerDeclarations.set(prefix, uri);
    }
    // 스위치가 요구하는 네임스페이스(속성값의 URI) 선언은 정리 차원이다: 두 형식 버전을 알 때만, 접두사도 URI도 선언돼 있지 않으면 원본 접두사로 더한다(명세 7.66)
    for (const [prefix, uri] of units.versionsKnown ? Object.entries(entry.res.valueNamespaces ?? {}) : []) {
      if (declaresPrefixOrUri(scope, prefix, uri) || [...headerDeclarations].some(([p, u]) => p === prefix || u === uri)) continue;
      headerDeclarations.set(prefix, uri);
    }
    const group = byList.get(entry.list) ?? {
      items: [],
      reason: isNewList(entry.list) ? `${entry.list.qname} 목록을 만들고 자원 추가` : `${entry.list.local}에 자원 추가`,
    };
    group.items.push(rewriteResource(entry, resources.ids, binaries.ids));
    byList.set(entry.list, group);
  }
  edits.push(...declarationEdit(headerEntry, target.header.root, headerDeclarations));
  const created: { list: NewList; items: string[]; reason: string }[] = [];
  for (const [list, group] of byList) {
    if (isNewList(list)) created.push({ list, ...group });
    else edits.push(...listEdits(target.header, headerEntry, list, group.items, group.reason));
  }
  edits.push(...newListEdits(target.header, headerEntry, created));

  // 3~5. 본문 재작성
  const reps: Rep[] = [];
  for (const r of fragment.refs) {
    const to = r.kind === "binaryItem" ? binaries.ids.get(r.id) : resources.ids.get(refKey(r.kind, undefined, r.id));
    if (to === undefined) throw new HwpxError("FRAG_SCHEMA", `본문 참조 ${r.kind} ${r.id}에 대응하는 값이 없습니다.`);
    if (to !== r.id) reps.push({ start: r.start, end: r.end, text: to });
  }
  for (const s of fragment.lineSegSpans) reps.push({ start: s.start, end: s.end, text: "" });
  const reissue = reissueIds(target, fragment, reps, options.reissueInternalDuplicates === true);
  const renamedBookmarks = renameBookmarks(target, fragment, reps);

  // 소스에서부터 있던 문제의 기록과 경고
  const inherited = { duplicateIds: inheritedDuplicates(fragment, reissue.finals), danglingRefs: fragment.dangling.map((d) => ({ ...d })) };
  for (const d of inherited.duplicateIds) {
    issues.push(
      makeIssue(
        "warning",
        "FRAG_INHERITED_DUP",
        `${ROLE_LABEL[d.role]} ${d.value}이(가) 조각 안에서 ${d.count}번 쓰입니다. 소스에서 이미 겹쳐 있던 것을 그대로 옮깁니다.`,
        section.entryName,
      ),
    );
  }
  const clip = cellClipReasons(anchor.element);
  if (clip.length > 0) {
    issues.push(
      makeIssue(
        "warning",
        "FRAG_CELL_MAY_CLIP",
        `표 셀 안에 넣습니다. 그 표가 ${clip.join(", ")}라 셀 높이가 늘지 않으면 넣은 내용이 잘릴 수 있습니다.`,
        section.entryName,
      ),
    );
  }

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
      convertedResources: units.converted,
      createdLists: created.length,
      reusedBinaries: binaries.reused,
      addedBinaries: binaries.added,
      reissuedIds: reissue.reissued,
      renamedStyles: resources.added.filter((a) => a.newName !== undefined).length,
      renamedBookmarks,
      insertedParagraphs: fragment.census.paragraphs,
      insertedTables: fragment.census.tables,
      insertedPictures: fragment.census.pictures,
      insertedFields: fragment.census.fields,
      insertedBookmarks: fragment.census.bookmarks,
    },
    issues,
    inherited,
  };
}
