import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { refsOf } from "../model/header.ts";
import type { ResourceItem } from "../model/types.ts";
import { isUnitCharFormat, isUnitSwitch } from "../package/format-version.ts";
import { escapeAttr } from "../xml/chars.ts";
import { tokenize, type XAttr } from "../xml/tokenizer.ts";
import { attrNode, attrValue, buildTree, elIs, subElements, walkElements, type XElement } from "../xml/tree.ts";
import { createFingerprinter, resourceRefs, type FingerprintLookup } from "./resources.ts";
import type { Fragment, FragmentRef, FragmentResource } from "./types.ts";
import { applyReps, collectPrefixes, collectValueNamespaces, type Rep } from "./util.ts";

// 형식 버전과 단위(엔진 명세 7.66. 근거는 검증 기준 26·27절의 한컴 실측)
// - 한컴은 HwpUnitChar 스위치를 형식 버전과 관계없이 `hp:case`로 읽는다.
// - 여백·간격 값은 `version.xml`의 xmlVersion이 1.5 이상이면 HWPUNIT, 그 아래면 그 2배 단위(옛 단위)로 받는다(스위치 밖 값도 같다).
// - `hp:default`에는 옛 단위 값이 있다. 그래서 1.5 원본의 자원을 1.5 미만 대상에 넣을 때는 스위치를 default 내용으로 바꾸고
//   스위치 밖 값을 2배로 하면, 반대 방향은 default 밖의 값을 절반으로 하면 한컴이 같은 값으로 읽는다(홀수 값은 1 차이).

/**
 * 단위가 형식 버전을 따르는 값의 속성: 문단 여백(`hh:margin`의 자식)의 value, 비율이 아닌 줄 간격의 value, 탭 항목의 pos.
 * `unit`이 없거나 HWPUNIT일 때만이다(글자 단위 `CHAR`는 그대로 둔다).
 */
function unitValueAttr(el: XElement): XAttr | undefined {
  const unit = attrValue(el, "unit");
  if (unit !== undefined && unit !== "HWPUNIT") return undefined;
  if (el.parent !== null && elIs(el.parent, "head", "margin")) return attrNode(el, "value");
  if (elIs(el, "head", "lineSpacing") && attrValue(el, "type") !== "PERCENT") return attrNode(el, "value");
  if (elIs(el, "head", "tabItem")) return attrNode(el, "pos");
  return undefined;
}

type Direction = "down" | "up";

/** 자원 원문을 바깥 접두사 선언으로 감싸 읽는다. `element`는 자원 요소, `offset`은 감싼 글에서 자원 원문이 시작하는 위치다. */
function parseResource(xml: string, namespaces: Record<string, string>): { element: XElement; offset: number } {
  const decls = Object.entries(namespaces)
    .map(([prefix, uri]) => (prefix === "" ? ` xmlns="${escapeAttr(uri)}"` : ` xmlns:${prefix}="${escapeAttr(uri)}"`))
    .join("");
  const open = `<w${decls}>`;
  const text = `${open}${xml}</w>`;
  const element = subElements(buildTree(text, tokenize(text)))[0];
  if (element === undefined) throw new HwpxError("FRAG_SCHEMA", "자원 원문에 요소가 없습니다.");
  return { element, offset: open.length };
}

/**
 * 자원 원문 하나를 대상 형식의 단위로 바꾼다. 바뀐 것이 없으면 undefined.
 * - down(1.5 이상 → 미만): HwpUnitChar 스위치를 `hp:default` 내용으로 바꾸고, 스위치 밖 단위 값을 2배로 한다.
 * - up(미만 → 1.5 이상): HwpUnitChar 스위치의 `hp:default` 밖에 있는 단위 값(스위치 밖 값과 `hp:case` 안 값)을 절반으로 한다(0 쪽으로 버림).
 */
function convertXml(res: FragmentResource, direction: Direction): string | undefined {
  const { element, offset } = parseResource(res.xml, res.namespaces);
  const reps: Rep[] = [];
  let coveredEnd = -1; // down에서 통째로 바꾼 스위치의 끝(그 안은 보지 않는다)
  const defaults: XElement[] = []; // up에서 건드리지 않는 default
  for (const el of walkElements(element)) {
    if (el.start < coveredEnd) continue;
    if (isUnitSwitch(el)) {
      const fallback = subElements(el).find((c) => elIs(c, "paragraph", "default"));
      if (direction === "down") {
        // default가 없는 스위치는 관측하지 못했다. 내용을 잃지 않도록 그대로 둔다(검사기가 RES_UNIT_SWITCH_LEGACY로 알린다)
        if (fallback !== undefined) reps.push({ start: el.start - offset, end: el.end - offset, text: res.xml.slice(fallback.openEnd - offset, fallback.closeStart - offset) });
        coveredEnd = el.end;
        continue;
      }
      if (fallback !== undefined) defaults.push(fallback);
    }
    const attr = unitValueAttr(el);
    if (attr === undefined || !/^-?\d+$/.test(attr.value)) continue;
    if (direction === "up" && defaults.some((d) => el.start >= d.start && el.end <= d.end)) continue;
    const n = Number(attr.value);
    const next = String(direction === "down" ? n * 2 : Math.trunc(n / 2));
    if (next !== attr.value) reps.push({ start: attr.valueStart - offset, end: attr.valueEnd - offset, text: next });
  }
  return reps.length === 0 ? undefined : applyReps(res.xml, reps);
}

const keyOf = (kind: string, lang: string | undefined, id: string): string => JSON.stringify([kind, lang ?? "", id]);

/**
 * 원문이 바뀐 조각 자원들의 참조 구간·접두사·지문을 다시 만든다. 지문은 다른 자원의 지문에 기대므로(스타일 → 문단모양 → 탭) 전부 다시 계산한다.
 * 계산 방법은 추출 때와 같다(조각 안 자원과 이진 자료의 sha256을 찾는 표로 `createFingerprinter`).
 */
function rebuildResources(fragment: Fragment, xmls: (string | undefined)[]): FragmentResource[] {
  const parsed = fragment.resources.map((res, i) => {
    const xml = xmls[i] ?? res.xml;
    const { element, offset } = parseResource(xml, res.namespaces);
    const item: ResourceItem = { kind: res.kind, id: res.id, element, refs: refsOf(res.kind, element) };
    if (res.lang !== undefined) item.lang = res.lang;
    return { res, xml, element, offset, item };
  });
  const index = new Map(parsed.map((p) => [keyOf(p.item.kind, p.item.lang, p.item.id), p.item]));
  const binaries = new Map(fragment.binaries.map((b) => [b.itemId, b.sha256]));
  const lookup: FingerprintLookup = { resource: (kind, lang, id) => index.get(keyOf(kind, lang, id)), binary: (id) => binaries.get(id) };
  const fingerprint = createFingerprinter(lookup);
  return parsed.map(({ res, xml, element, offset, item }) => {
    const rel = (n: number): number => n - offset;
    const refs: FragmentRef[] = [];
    for (const ref of resourceRefs(item)) {
      const found = ref.kind === "binaryItem" ? binaries.has(ref.id) : lookup.resource(ref.kind, ref.lang, ref.id) !== undefined;
      if (!found) continue;
      const out: FragmentRef = { kind: ref.kind, id: ref.id, start: rel(ref.attr.valueStart), end: rel(ref.attr.valueEnd) };
      if (ref.lang !== undefined) out.lang = ref.lang;
      refs.push(out);
    }
    const scope = collectPrefixes(walkElements(element), element.start);
    const valueNamespaces = collectValueNamespaces(walkElements(element), element.start);
    const idAttr = attrNode(element, "id");
    if (idAttr === undefined) throw new HwpxError("FRAG_SCHEMA", `자원 ${res.kind} ${res.id}에 id 속성이 없습니다.`);
    const out: FragmentResource = {
      kind: res.kind,
      id: res.id,
      xml,
      idSpan: { start: rel(idAttr.valueStart), end: rel(idAttr.valueEnd) },
      refs,
      fingerprint: fingerprint(item),
      ...scope,
    };
    if (res.lang !== undefined) out.lang = res.lang;
    if (Object.keys(valueNamespaces).length > 0) out.valueNamespaces = valueNamespaces;
    const nameAttr = res.kind === "style" ? attrNode(element, "name") : undefined;
    if (nameAttr !== undefined) out.nameSpan = { start: rel(nameAttr.valueStart), end: rel(nameAttr.valueEnd) };
    return out;
  });
}

export type UnitConversion = {
  /** 단위를 바꾼 조각(바꿀 것이 없으면 입력 그대로) */
  fragment: Fragment;
  /** 원문이 바뀐 자원 수 */
  converted: number;
  /** 원본과 대상의 형식 버전을 둘 다 알았는가 */
  versionsKnown: boolean;
  issues: Issue[];
};

/**
 * 조각 자원을 대상 문서의 형식 버전에 맞는 단위로 바꾼다(엔진 명세 7.66). 원본(`fragment.source.xmlVersion`)과 대상(`version.xml`)이
 * 1.5 이상·미만으로 갈리면 바꾸고 `FRAG_UNIT_CONVERTED`를 낸다. 한쪽만 버전을 알 수 없으면 바꾸지 않고 `FRAG_FORMAT_UNKNOWN`을 낸다
 * (둘 다 모르면 같은 형식으로 본다). 대상의 `version.xml`·헤더 버전은 바꾸지 않는다(바꾸면 대상 고유 여백까지 2배가 된다).
 */
export function convertFragmentUnits(fragment: Fragment, targetVersion: string | undefined, where: string): UnitConversion {
  const sourceVersion = fragment.source.xmlVersion;
  const from = isUnitCharFormat(sourceVersion);
  const to = isUnitCharFormat(targetVersion);
  const show = (v: string | undefined): string => v ?? "알 수 없음";
  if (from === undefined || to === undefined) {
    if (from === undefined && to === undefined) return { fragment, converted: 0, versionsKnown: false, issues: [] };
    const issue = makeIssue(
      "warning",
      "FRAG_FORMAT_UNKNOWN",
      `형식 버전을 알 수 없어(원본 ${show(sourceVersion)}, 대상 ${show(targetVersion)}) 자원의 단위를 바꾸지 않았습니다. 두 형식이 1.5 이상·미만으로 갈리면 한컴에서 여백·간격이 2배나 절반으로 보입니다.`,
      where,
    );
    return { fragment, converted: 0, versionsKnown: false, issues: [issue] };
  }
  if (from === to) return { fragment, converted: 0, versionsKnown: true, issues: [] };
  const direction: Direction = from ? "down" : "up";
  const xmls = fragment.resources.map((res) => convertXml(res, direction));
  const converted = xmls.filter((x) => x !== undefined).length;
  if (converted === 0) return { fragment, converted: 0, versionsKnown: true, issues: [] };
  const how =
    direction === "down"
      ? "HwpUnitChar 스위치는 default 내용으로, 스위치 밖 여백·줄 간격·탭 위치는 2배로"
      : "HwpUnitChar 스위치의 default 밖 여백·줄 간격·탭 위치를 절반으로";
  const issue = makeIssue(
    "warning",
    "FRAG_UNIT_CONVERTED",
    `형식 버전 ${show(sourceVersion)} 원본의 자원 ${converted}개를 형식 버전 ${show(targetVersion)} 대상의 단위로 바꿨습니다(${how}).`,
    where,
  );
  return { fragment: { ...fragment, resources: rebuildResources(fragment, xmls) }, converted, versionsKnown: true, issues: [issue] };
}
