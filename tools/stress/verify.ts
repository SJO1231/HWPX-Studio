// 건마다 하는 검증 V-a ~ V-i. 전부 메모리에서 한다. 결과에는 항목과 코드만 남기고 문서의 글·이름은 남기지 않는다.
import {
  collectBodyRefs,
  type CountSlot,
  walkElements,
  walkParagraphs,
  type Fragment,
  type FragmentSelection,
  type HwpxDocument,
  type InsertPoint,
  type ParagraphNode,
  type XElement,
} from "../../packages/hwpx-engine/src/index.ts";
import { explainInherited } from "../../packages/hwpx-engine/src/fill/index.ts";
import { createFingerprinter, makeLookup } from "../../packages/hwpx-engine/src/fragment/resources.ts";
import type { ImportPlan, InheritedProblems } from "../../packages/hwpx-engine/src/fragment/types.ts";
import { compareToBaseline, validateDocument, type ValidationReport } from "../../packages/hwpx-engine/src/validate/index.ts";
import { binaryRefsIn, bodyRefsOf, makeCanon, textRuns, type Canon } from "./canon.ts";

export type Fail = { item: string; code: string };

/** 가져온 한 번 = 계획 + 적용 + 다시 파싱 */
export type Step = {
  base: HwpxDocument;
  fragment: Fragment;
  point: InsertPoint;
  plan: ImportPlan;
  bytes: Uint8Array;
  result: HwpxDocument;
  /** 삽입된 문단들의 (삽입 지점과 같은 목록 안) 첫 서수와 개수 */
  first: number;
  count: number;
};

/** 조각의 글·서식이 나온 곳: 문서와 선택. 연쇄에서는 처음 소스다. */
export type Origin = { doc: HwpxDocument; sel: FragmentSelection };

/** 검증이 얼마나 비교했는지(도구 자체의 범위 확인용) */
export type Notes = Record<string, number>;
const note = (notes: Notes, key: string, by = 1): void => {
  notes[key] = (notes[key] ?? 0) + by;
};

export function listAt(doc: HwpxDocument, sectionIndex: number, parentPath: readonly number[]): ParagraphNode[] {
  let list = doc.sections[sectionIndex]?.paragraphs ?? [];
  for (let i = 0; i < parentPath.length; i += 2) list = list[parentPath[i] ?? 0]?.subLists[parentPath[i + 1] ?? 0]?.paragraphs ?? [];
  return list;
}

export function insertedOf(s: Step): ParagraphNode[] {
  return listAt(s.result, s.point.sectionIndex, s.point.parentPath).slice(s.first, s.first + s.count);
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// ── 수량 ────────────────────────────────────────────────────────

export type Census5 = { p: number; tbl: number; pic: number; field: number; bookmark: number };
const censusCache = new WeakMap<HwpxDocument, Census5>();

/** 구역 원문 트리에서 직접 센다(엔진의 census·fragment.census와 별개). */
export function census5(doc: HwpxDocument): Census5 {
  const hit = censusCache.get(doc);
  if (hit !== undefined) return hit;
  const c: Census5 = { p: 0, tbl: 0, pic: 0, field: 0, bookmark: 0 };
  for (const sec of doc.sections) {
    for (const el of walkElements(sec.root)) {
      switch (el.local) {
        case "p":
          c.p++;
          break;
        case "tbl":
          c.tbl++;
          break;
        case "pic":
          c.pic++;
          break;
        case "fieldBegin":
          c.field++;
          break;
        case "bookmark":
          c.bookmark++;
          break;
        default:
          break;
      }
    }
  }
  censusCache.set(doc, c);
  return c;
}

const sumKeyOf = (steps: readonly Step[], key: string): number => steps.reduce((n, s) => n + (s.plan.summary[key] ?? 0), 0);
const resourceCount = (doc: HwpxDocument): number => Object.values(doc.header.resources).reduce((n, items) => n + items.length, 0);

// ── 독립 기준의 캐시 ────────────────────────────────────────────

const canonCache = new WeakMap<HwpxDocument, Canon>();
function canonOf(doc: HwpxDocument): Canon {
  let c = canonCache.get(doc);
  if (c === undefined) canonCache.set(doc, (c = makeCanon(doc)));
  return c;
}

// ── 단계별 검증 ─────────────────────────────────────────────────

/** V-c 글 */
function checkTexts(s: Step, origin: Origin, fails: Fail[], notes: Notes): void {
  const ins = insertedOf(s);
  if (ins.length !== s.count) {
    fails.push({ item: "V-c", code: "INSERTED_COUNT" });
    return;
  }
  const texts = [...walkParagraphs(ins)].map((p) => p.logicalText);
  note(notes, "vc.paragraphsCompared", texts.length);
  if (!sameList(texts, s.fragment.texts)) fails.push({ item: "V-c", code: "TEXTS_VS_FRAGMENT" });
  const srcList = listAt(origin.doc, origin.sel.sectionIndex, origin.sel.parentPath).slice(origin.sel.from, origin.sel.to + 1);
  const srcTexts = [...walkParagraphs(srcList)].map((p) => p.logicalText);
  if (!sameList(texts, srcTexts)) fails.push({ item: "V-c", code: "TEXTS_VS_SOURCE" });

  // 원문에서 정규식으로 뽑은 hp:t 글(엔진의 논리 텍스트와 별개)
  const first = ins[0];
  const last = ins[ins.length - 1];
  const sFirst = srcList[0];
  const sLast = srcList[srcList.length - 1];
  if (first === undefined || last === undefined || sFirst === undefined || sLast === undefined) return;
  const outXml = s.result.sections[s.point.sectionIndex]?.text.slice(first.element.start, last.element.end) ?? "";
  const srcXml = origin.doc.sections[origin.sel.sectionIndex]?.text.slice(sFirst.element.start, sLast.element.end) ?? "";
  if (!sameList(textRuns(outXml), textRuns(srcXml))) fails.push({ item: "V-c", code: "TEXT_RUNS_XML" });
  else note(notes, "vc.textRunsCompared", textRuns(outXml).length);
}

/** V-d 서식 지문: 엔진의 지문(조각의 prints)과 독립 구현 둘 다 */
function checkFormats(s: Step, origin: Origin, fails: Fail[], notes: Notes): void {
  const ins = insertedOf(s);
  const lookup = makeLookup(s.result);
  const fp = createFingerprinter(lookup);

  // (1) 엔진의 지문. prints와 같은 규칙으로 참조를 고른다. 소스에서 이미 없는 대상을 (안쪽까지 따라가) 가리키던 참조는
  // 대상 문서에 같은 id가 있으면 그 자원을 가리키게 되므로(명세 7.65) 지문이 달라질 수 있다. 그 위치는 건너뛰고 센다.
  const keep = (r: { kind: string; id: string }): boolean =>
    r.kind !== "unknown" && r.kind !== "memoShape" && r.kind !== "binaryItem" && r.id !== "4294967295" && r.id !== "-1";
  const srcPlain = listAt(origin.doc, origin.sel.sectionIndex, origin.sel.parentPath).slice(origin.sel.from, origin.sel.to + 1);
  const refs = ins.flatMap((p) => collectBodyRefs(p.element)).filter(keep);
  const srcEngineRefs = srcPlain.flatMap((p) => collectBodyRefs(p.element)).filter(keep);
  const canonSrc = canonOf(origin.doc);
  if (refs.length !== s.fragment.prints.length || srcEngineRefs.length !== refs.length) {
    fails.push({ item: "V-d", code: "PRINTS_COUNT" });
  } else {
    refs.forEach((r, i) => {
      const want = s.fragment.prints[i] ?? "";
      const from = srcEngineRefs[i];
      if (want.startsWith("missing:") || (from !== undefined && canonSrc.bodyRef(from.kind, from.id).includes("<missing:"))) {
        note(notes, "vd.engine.danglingSkipped");
        return;
      }
      const item = lookup.resource(r.kind, undefined, r.id);
      if (item === undefined) fails.push({ item: "V-d", code: "REF_UNRESOLVED" });
      else if (fp(item) !== want) fails.push({ item: "V-d", code: `PRINT_MISMATCH:${r.kind}` });
      else note(notes, "vd.engine.compared");
    });
  }

  // (2) 독립 구현: 소스의 참조와 결과의 참조를 같은 순서로 맞춰, 참조까지 전개한 문자열을 견준다.
  const sRefs = bodyRefsOf(srcPlain.map((p) => p.element));
  const rRefs = bodyRefsOf(ins.map((p) => p.element));
  if (sRefs.length !== rRefs.length) {
    fails.push({ item: "V-d", code: "INDEP_REF_COUNT" });
    return;
  }
  const cs = canonSrc;
  const cr = canonOf(s.result);
  sRefs.forEach((sr, i) => {
    const rr = rRefs[i];
    if (rr === undefined || rr.kind !== sr.kind) {
      fails.push({ item: "V-d", code: "INDEP_REF_KIND" });
      return;
    }
    const want = cs.bodyRef(sr.kind, sr.id);
    if (want.includes("<missing:")) {
      note(notes, "vd.indep.danglingSkipped");
      return;
    }
    if (cr.bodyRef(rr.kind, rr.id) !== want) fails.push({ item: "V-d", code: `INDEP_MISMATCH:${sr.kind}` });
    else note(notes, "vd.indep.compared");
  });
}

/** 루트 시작 태그에 더한 네임스페이스 선언(xmlns:*)을 뺀 문자열 */
function rootTagWithoutAdded(text: string, root: XElement, baseRoot: XElement): { stripped: string; ok: boolean } {
  const known = new Map(baseRoot.attrs.map((a) => [a.qname, a.value]));
  const spans: [number, number][] = [];
  let ok = true;
  for (const a of root.attrs) {
    if (known.has(a.qname)) {
      if (known.get(a.qname) !== a.value) ok = false;
      continue;
    }
    if (!a.qname.startsWith("xmlns:")) ok = false;
    let start = a.nameStart;
    while (start > 0 && /\s/.test(text[start - 1] ?? "")) start--;
    spans.push([start, a.valueEnd + 1]);
  }
  let stripped = text.slice(0, root.openEnd);
  for (const [a, b] of spans.reverse()) stripped = stripped.slice(0, a) + stripped.slice(b);
  return { stripped, ok };
}

/** V-e 단계별: 삽입한 문단들을 빼면 구역 원문이 직전 문서와 같다(루트의 네임스페이스 선언 추가만 허용). 다른 구역은 그대로. */
function checkBodyPreserved(s: Step, fails: Fail[]): void {
  const idx = s.point.sectionIndex;
  s.base.sections.forEach((b, i) => {
    if (i !== idx && s.result.sections[i]?.text !== b.text) fails.push({ item: "V-e", code: "OTHER_SECTION_CHANGED" });
  });
  const ins = insertedOf(s);
  const first = ins[0];
  const last = ins[ins.length - 1];
  const r = s.result.sections[idx];
  const b = s.base.sections[idx];
  if (first === undefined || last === undefined || r === undefined || b === undefined) return;
  const rest = r.text.slice(r.root.openEnd, first.element.start) + r.text.slice(last.element.end);
  if (rest !== b.text.slice(b.root.openEnd)) fails.push({ item: "V-e", code: "BODY_CHANGED" });
  const tag = rootTagWithoutAdded(r.text, r.root, b.root);
  if (!tag.ok || tag.stripped !== b.text.slice(0, b.root.openEnd)) fails.push({ item: "V-e", code: "ROOT_TAG_CHANGED" });
}

/** V-f 단계별: 수량 증감이 계획 summary의 예고와 같다. */
function checkQuantities(s: Step, fails: Fail[]): void {
  const b = census5(s.base);
  const r = census5(s.result);
  const sm = s.plan.summary;
  const expect: [string, number, number][] = [
    ["PARAGRAPHS", r.p - b.p, sm["insertedParagraphs"] ?? -1],
    ["TABLES", r.tbl - b.tbl, sm["insertedTables"] ?? -1],
    ["PICTURES", r.pic - b.pic, sm["insertedPictures"] ?? -1],
    ["FIELDS", r.field - b.field, sm["insertedFields"] ?? -1],
    ["BOOKMARKS", r.bookmark - b.bookmark, sm["insertedBookmarks"] ?? -1],
  ];
  for (const [name, got, want] of expect) if (got !== want) fails.push({ item: "V-f", code: name });
  const added = sm["addedResources"] ?? -1;
  if (resourceCount(s.result) - resourceCount(s.base) !== added) fails.push({ item: "V-f", code: "ADDED_RESOURCES" });
  if ((sm["reusedResources"] ?? -1) + added !== s.fragment.resources.length) fails.push({ item: "V-f", code: "RESOURCE_TOTAL" });
  const addedBin = sm["addedBinaries"] ?? -1;
  if (s.result.pkg.manifestItems.length - s.base.pkg.manifestItems.length !== addedBin) fails.push({ item: "V-f", code: "ADDED_BINARIES_MANIFEST" });
  if (s.result.pkg.binaryEntries.length - s.base.pkg.binaryEntries.length !== addedBin) fails.push({ item: "V-f", code: "ADDED_BINARIES_ENTRIES" });
  if ((sm["reusedBinaries"] ?? -1) + addedBin !== s.fragment.binaries.length) fails.push({ item: "V-f", code: "BINARY_TOTAL" });
}

/** 단계 하나의 검증: V-c, V-d, V-e(구역 원문), V-f(수량) */
export function verifyStep(s: Step, origin: Origin, fails: Fail[], notes: Notes): void {
  checkTexts(s, origin, fails, notes);
  checkFormats(s, origin, fails, notes);
  checkBodyPreserved(s, fails);
  checkQuantities(s, fails);
}

// ── 문서 단위 검증 ──────────────────────────────────────────────

export type BaseDoc = { doc: HwpxDocument; baseline: ValidationReport };

export type DocCheckInput = {
  base: BaseDoc;
  result: HwpxDocument;
  bytes: Uint8Array;
  /** 이 문서를 만든 단계들의 summary 합(검사기 census와 대조) */
  steps: Step[];
  /** 이 문서를 만든 단계들의 계획이 기록한 상속(조각이 소스에서부터 갖고 있던 문제). 이것으로 설명되는 새 오류만 상속이고 나머지는 결함이다. */
  inherited: InheritedProblems;
  /** 이 문서를 만든 단계들의 조각(문단 id 중복이 소스 조각 안의 중복에서 온 것인지 가르는 데 쓴다) */
  fragments?: Fragment[];
  /**
   * 서식 변경(M10)을 마친 문서다. 서식 변경은 그 구역의 줄 배치 캐시를 전부 지우고(명세 7.7) 파생 자원을 header에 더하므로,
   * 대상의 기존 문단 원문 비교는 줄 배치 캐시를 뺀 원문으로 하고, 대상에서 없던 참조를 새 자원이 채우는 일은 결함이 아니라 참고 수량으로 센다.
   */
  afterFormat?: boolean;
  /** 삽입 지점이 든 최상위 문단(표 셀에 넣은 경우 그 문단은 원문 비교에서 뺀다) */
  hostParagraph?: { sectionIndex: number; index: number };
};

export type DocCheckOutput = { fails: Fail[]; inherited: Fail[]; report: ValidationReport };

const SPACE_OF_MESSAGE: [string, string][] = [
  ["paragraph id", "paraId"],
  ["object id", "objectId"],
  ["instId", "instId"],
  ["field id", "fieldId"],
];

/** 모델이 낸 오류를 (코드, 위치, 대상)으로 줄인다. 개수·예시는 뗀다. */
function modelKey(code: string, message: string, where: string): string {
  return `${code}\u0000${where}\u0000${message.replace(/\(예:[^)]*\)/, "").replace(/\d+곳/, "N곳")}`;
}

const danglingTarget = (message: string): string | undefined => {
  const bin = /^이진 자료 (\S*?)이\(가\) 없는데/.exec(message);
  if (bin !== null) return `binItem:${bin[1]}`;
  const m = /^(\w+)(?:\(\w+\))? (\S*?)이\(가\) 없는데/.exec(message);
  return m === null ? undefined : `${m[1] === "binaryItem" ? "binItem" : m[1]}:${m[2]}`;
};

const ROLE_OF_SPACE: Record<string, string> = { paraId: "paragraph", objectId: "object", instId: "inst", fieldId: "fieldBegin" };

/** 그 id 공간의 값이 조각 하나 안에서 두 번 이상 나오는가(= 소스 문서가 이미 가진 중복) */
function repeatedInFragment(fragments: readonly Fragment[] | undefined, space: string, value: string): boolean {
  const role = ROLE_OF_SPACE[space];
  return (fragments ?? []).some((f) => f.instanceIds.filter((x) => x.role === role && x.value === value).length > 1);
}

/**
 * V-g 이진 자료 정합: 결과의 모든 `binaryItemIDRef`가 manifest와 ZIP 항목에 있다(대상 원본에 이미 없던 참조와 빈 값은 뺀다).
 * 소스에서 이미 없던 참조를 그대로 옮긴 것은 상속으로 따로 센다.
 */
function checkBinaries(base: HwpxDocument, result: HwpxDocument, danglingKeys: Set<string>, fails: Fail[], inherited: Fail[], notes: Notes): void {
  const problems = (doc: HwpxDocument): Map<string, string> => {
    const items = new Map(doc.pkg.manifestItems.map((m) => [m.id, m.href]));
    const names = new Set(doc.pkg.archive.entries.map((e) => e.name));
    const out = new Map<string, string>();
    for (const text of [doc.header.text, ...doc.sections.map((s) => s.text)]) {
      for (const id of binaryRefsIn(text)) {
        if (id === "" || id === "4294967295" || id === "-1") continue;
        const href = items.get(id);
        if (href === undefined) out.set(id, "REF_NOT_IN_MANIFEST");
        else if (!names.has(href)) out.set(id, "REF_HREF_MISSING");
      }
    }
    return out;
  };
  const before = problems(base);
  for (const [id, code] of problems(result)) {
    if (before.has(id)) continue;
    (danglingKeys.has(`binItem:${id}`) ? inherited : fails).push({ item: "V-g", code });
  }
  const baseNames = new Set(base.pkg.archive.entries.map((e) => e.name));
  const baseIds = new Set(base.pkg.manifestItems.map((m) => m.id));
  const names = new Set(result.pkg.archive.entries.map((e) => e.name));
  const hrefs = new Set(result.pkg.manifestItems.map((m) => m.href));
  for (const m of result.pkg.manifestItems) {
    if (!baseIds.has(m.id)) {
      note(notes, "vg.newManifestItems");
      if (!names.has(m.href)) fails.push({ item: "V-g", code: "NEW_ITEM_WITHOUT_ENTRY" });
    }
  }
  for (const e of result.pkg.archive.entries) {
    if (!baseNames.has(e.name) && !e.isDirectory && !hrefs.has(e.name)) fails.push({ item: "V-g", code: "NEW_ENTRY_NOT_IN_MANIFEST" });
  }
}

type IdCounts = Record<"objectId" | "instId" | "fieldId", Map<string, number>>;

/** 객체 id·instId·누름틀 시작 id의 값별 개수(자리값 `0`·빈 값은 뺀다) */
function idCounts(doc: HwpxDocument): IdCounts {
  const counts: IdCounts = { objectId: new Map(), instId: new Map(), fieldId: new Map() };
  const objectTags = new Set([
    "tbl", "pic", "ole", "container", "equation", "rect", "ellipse", "arc", "polygon", "curve", "line", "connectLine",
    "textart", "video", "chart", "compose", "dutmal", "btn", "radioBtn", "checkBtn", "comboBox", "edit", "listBox", "scrollBar",
  ]);
  const bump = (m: Map<string, number>, v: string): void => {
    m.set(v, (m.get(v) ?? 0) + 1);
  };
  for (const sec of doc.sections) {
    for (const el of walkElements(sec.root)) {
      for (const a of el.attrs) {
        const name = a.qname.slice(a.qname.lastIndexOf(":") + 1);
        if (name.toLowerCase() === "instid") {
          if (a.value !== "" && a.value !== "0") bump(counts.instId, a.value);
        } else if (name === "id" && objectTags.has(el.local)) {
          if (a.value !== "" && a.value !== "0") bump(counts.objectId, a.value);
        } else if (name === "id" && el.local === "fieldBegin") {
          if (a.value !== "") bump(counts.fieldId, a.value);
        }
      }
    }
  }
  return counts;
}

/**
 * 개수 속성(itemCnt·fontCnt): 원본에서 맞던 목록이 결과에서 어긋나지 않는다. 가져오기가 새로 만든 목록(`createdLists`)은 개수 속성이
 * 새로 생기므로 그 수만큼 슬롯이 늘고, 새 목록의 개수 속성도 실제 항목 수와 맞아야 한다. 슬롯은 (목록 요소, 글꼴 언어)별 순서로 짝짓는다.
 */
function checkCounts(base: HwpxDocument, result: HwpxDocument, createdLists: number, fails: Fail[]): void {
  const keyOf = (s: CountSlot): string => `${s.list} ${s.lang ?? ""}`;
  const was = new Map<string, CountSlot[]>();
  for (const s of base.header.counts) was.set(keyOf(s), [...(was.get(keyOf(s)) ?? []), s]);
  const seen = new Map<string, number>();
  let fresh = 0;
  for (const slot of result.header.counts) {
    const k = keyOf(slot);
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    const old = was.get(k)?.[i];
    if (old === undefined) fresh++;
    if ((old === undefined || old.value === old.actual) && slot.value !== slot.actual) fails.push({ item: "V-f", code: "ITEMCNT_MISMATCH" });
  }
  if (fresh !== createdLists || base.header.counts.length !== result.header.counts.length - fresh) fails.push({ item: "V-f", code: "COUNT_SLOTS_CHANGED" });
}

/** 스타일 이름 규칙: 이름이 겹치는 새 스타일은 이름을 바꿔 가져오므로 같은 이름의 중복이 원본보다 늘지 않는다. */
function checkStyleNames(base: HwpxDocument, result: HwpxDocument, fails: Fail[]): void {
  const excess = (doc: HwpxDocument): number => {
    const seen = new Map<string, number>();
    for (const item of doc.header.resources["style"] ?? []) {
      const name = item.element.attrs.find((a) => a.qname === "name")?.value;
      if (name !== undefined) seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    return [...seen.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);
  };
  if (excess(result) > excess(base)) fails.push({ item: "V-f", code: "STYLE_NAME_DUPLICATED" });
}

/**
 * 대상 원본에서 없는 대상을 가리키던 참조(본문·자원 안)가 가져온 자원 때문에 가리키는 곳이 생겼는데(기존 문단의 모양이 바뀔 수 있다)
 * 계획이 FRAG_FILLS_DANGLING 경고를 내지 않았다면 결함이다.
 */
function checkSilentFill(base: HwpxDocument, result: HwpxDocument, steps: readonly Step[], notes: Notes, fails: Fail[]): void {
  const before = makeLookup(base);
  const after = makeLookup(result);
  const manifestBefore = new Set(base.pkg.manifestItems.map((m) => m.id));
  const manifestAfter = new Set(result.pkg.manifestItems.map((m) => m.id));
  let filled = 0;
  const check = (kind: string, lang: string | undefined, id: string): void => {
    if (id === "" || id === "4294967295" || id === "-1") return;
    if (kind === "binaryItem") {
      if (!manifestBefore.has(id) && manifestAfter.has(id)) filled++;
    } else if (before.resource(kind, lang, id) === undefined && after.resource(kind, lang, id) !== undefined) filled++;
  };
  for (const ref of base.sections.flatMap((s) => s.bodyRefs)) {
    if (ref.kind !== "unknown" && ref.kind !== "memoShape") check(ref.kind, undefined, ref.id);
  }
  for (const item of Object.values(base.header.resources).flat()) for (const ref of item.refs) check(ref.kind, ref.lang, ref.id);
  if (filled === 0) return;
  note(notes, "ve.targetDanglingRefsFilled", filled);
  if (!steps.some((s) => s.plan.issues.some((i) => i.code === "FRAG_FILLS_DANGLING"))) fails.push({ item: "V-e", code: "FILLS_DANGLING_SILENT" });
}

/** 문서 하나(가져오기가 끝난 결과)의 검증: V-a(모델 오류), V-b, V-e(원문·자원·항목), V-f(검사기 census), V-g, V-i */
export function verifyDocument(input: DocCheckInput, notes: Notes): DocCheckOutput {
  const { base, result, bytes, steps } = input;
  const fails: Fail[] = [];
  const inherited: Fail[] = [];
  const report = validateDocument(bytes);
  const danglingKeys = danglingKeysOf(input.inherited);

  // V-a: 다시 파싱한 모델이 새 오류를 내지 않는다
  const beforeKeys = new Set(base.doc.issues.filter((i) => i.severity === "error").map((i) => modelKey(i.code, i.message, i.where ?? "")));
  for (const i of result.issues) {
    if (i.severity !== "error" || beforeKeys.has(modelKey(i.code, i.message, i.where ?? ""))) continue;
    const target = danglingTarget(i.message);
    if (target !== undefined && danglingKeys.has(target)) inherited.push({ item: "V-a", code: i.code });
    else fails.push({ item: "V-a", code: i.code });
  }

  // V-b: 검사기 기준선 대비 새 오류
  const cmp = compareToBaseline(base.baseline, report);
  const explained = new Set(explainInherited(cmp.newErrors, input.inherited).explained);
  for (const e of cmp.newErrors) {
    let code = e.code;
    if (code === "INST_DUP_ID") {
      let sub = SPACE_OF_MESSAGE.find(([prefix]) => e.message.startsWith(prefix))?.[1];
      if (sub !== undefined) {
        // 값이 조각 하나 안에서 이미 두 번 이상 나오면 소스가 가진 중복을 옮긴 것이다(대상의 id와 겹쳐 생긴 것과 구별한다).
        const value = /^[^']*'([^']*)'/.exec(e.message)?.[1];
        if (value !== undefined && repeatedInFragment(input.fragments, sub, value)) sub = `${sub}.inFragment`;
        code = `${code}:${sub}`;
      }
    }
    (explained.has(e) ? inherited : fails).push({ item: "V-b", code });
    note(notes, `vb.newErrors.${code}`, e.count);
  }

  // V-e: 대상의 기존 최상위 문단 원문이 순서대로 그대로 있고, 기존 자원 원문도 그대로이며, 바뀐 항목은 header·구역·패키지 문서뿐이다
  base.doc.sections.forEach((bs, si) => {
    const rs = result.sections[si];
    if (rs === undefined) {
      fails.push({ item: "V-e", code: "SECTION_MISSING" });
      return;
    }
    let from = 0;
    const lineSeg = /<(?:[\w.-]+:)?linesegarray>[\s\S]*?<\/(?:[\w.-]+:)?linesegarray>/g;
    const haystack = input.afterFormat === true ? rs.text.replace(lineSeg, "") : rs.text;
    for (const [pi, p] of bs.paragraphs.entries()) {
      if (input.hostParagraph?.sectionIndex === si && input.hostParagraph.index === pi) continue;
      const raw = input.afterFormat === true ? bs.text.slice(p.element.start, p.element.end).replace(lineSeg, "") : bs.text.slice(p.element.start, p.element.end);
      const found = haystack.indexOf(raw, from);
      if (found < from) {
        fails.push({ item: "V-e", code: "PARAGRAPH_MISSING" });
        return;
      }
      from = found + raw.length;
    }
    note(notes, "ve.paragraphsPresent", bs.paragraphs.length);
  });
  {
    const hBefore = base.doc.header.text;
    const hAfter = result.header.text;
    let pos = 0;
    const items = Object.values(base.doc.header.resources).flat().sort((a, b) => a.element.start - b.element.start);
    for (const item of items) {
      const raw = hBefore.slice(item.element.start, item.element.end);
      const found = hAfter.indexOf(raw, pos);
      if (found < pos) {
        fails.push({ item: "V-e", code: "HEADER_RESOURCE_CHANGED" });
        break;
      }
      pos = found + raw.length;
    }
  }
  {
    const editedSections = new Set(steps.map((st) => result.pkg.sectionEntries[st.point.sectionIndex] ?? ""));
    const allowed = (name: string): boolean => name === base.doc.pkg.headerEntry || editedSections.has(name) || name.endsWith(".hpf");
    const after = new Map(result.pkg.archive.entries.map((e) => [e.name, e]));
    const baseEntries = base.doc.pkg.archive.entries;
    baseEntries.forEach((e, i) => {
      const r = after.get(e.name);
      if (r === undefined || result.pkg.archive.entries[i]?.name !== e.name) fails.push({ item: "V-e", code: "ENTRY_ORDER_OR_MISSING" });
      else if (!allowed(e.name) && (r.crc32 !== e.crc32 || r.size !== e.size)) fails.push({ item: "V-e", code: "ENTRY_CHANGED" });
    });
    const baseNames = new Set(baseEntries.map((e) => e.name));
    for (const e of result.pkg.archive.entries) {
      if (!baseNames.has(e.name) && !e.name.startsWith("BinData/")) fails.push({ item: "V-e", code: "ENTRY_ADDED_NON_BINARY" });
    }
  }

  // V-f: 검사기 census의 증감도 계획의 예고(단계 합)와 같다
  {
    const sum = (key: string): number => steps.reduce((n, st) => n + (st.plan.summary[key] ?? 0), 0);
    const b = base.baseline.census;
    const c = report.census;
    const pairs: [string, number, number][] = [
      ["VALIDATOR_PARAGRAPHS", c.paragraphs - b.paragraphs, sum("insertedParagraphs")],
      ["VALIDATOR_TABLES", c.tables - b.tables, sum("insertedTables")],
      ["VALIDATOR_PICTURES", c.pictures - b.pictures, sum("insertedPictures")],
      ["VALIDATOR_FIELDS", c.fieldPairs - b.fieldPairs, sum("insertedFields")],
    ];
    if (report.errors.every((e) => e.code !== "VAL_INTERNAL")) {
      for (const [name, got, want] of pairs) if (got !== want) fails.push({ item: "V-f", code: name });
    }
  }

  checkCounts(base.doc, result, sumKeyOf(steps, "createdLists"), fails);
  checkStyleNames(base.doc, result, fails);
  if (input.afterFormat !== true) checkSilentFill(base.doc, result, steps, notes, fails);

  // V-g, V-i
  checkBinaries(base.doc, result, danglingKeys, fails, inherited, notes);
  const idBefore = idCounts(base.doc);
  const idAfter = idCounts(result);
  for (const space of ["objectId", "instId", "fieldId"] as const) {
    const role = ROLE_OF_SPACE[space];
    const recorded = new Set(input.inherited.duplicateIds.filter((d) => d.role === role).map((d) => d.value));
    const grown = [...idAfter[space]].filter(([v, n]) => n > 1 && n - 1 > Math.max(0, (idBefore[space].get(v) ?? 0) - 1) && !recorded.has(v));
    if (grown.length === 0) continue;
    const inFragment = grown.some(([v]) => repeatedInFragment(input.fragments, space, v));
    fails.push({ item: "V-i", code: inFragment ? `${space}.inFragment` : space });
  }
  return { fails, inherited, report };
}

/** 계획이 기록한 상속(소스에서 없던 대상을 가리키던 참조)의 열쇠 `<공간>:<id>`. 공간 이름은 검사기·모델의 메시지와 같다(이진 자료는 `binItem`). */
export function danglingKeysOf(inherited: InheritedProblems): Set<string> {
  return new Set(inherited.danglingRefs.map((d) => `${d.kind === "binaryItem" ? "binItem" : d.kind}:${d.id}`));
}
