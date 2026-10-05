// 조각 가져오기의 형식 버전 단위 변환(엔진 명세 7.66, 이슈 #69 ②)과 검사기 경고 RES_UNIT_SWITCH_LEGACY.
// 기대값은 한컴 실측(검증 기준 26절·27절)에서 만든 "한컴이 읽는 값" 모형으로 낸다: HwpUnitChar 스위치는 형식과 관계없이 case를 읽고,
// 여백·비율 아닌 줄 간격·탭 위치는 xmlVersion 1.5 이상이면 XML 값의 2배(옛 단위), 미만이면 XML 값 그대로 받는다. 글자 단위(CHAR)·비율 줄 간격은 그대로다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPlan,
  compareToBaseline,
  extractFragment,
  openPackage,
  parseDocument,
  parseFragment,
  planImport,
  readEntry,
  serializeFragment,
  validateDocument,
  walkElements,
  type Fragment,
  type HwpxDocument,
  type ImportPlan,
} from "../src/index.ts";
import { NS_HC, NS_HH, NS_HP, buildZip, bytesEqual, hpfXml, loadDoc, mutateEntryText, readFixture, sectionXml, utf8 } from "./helpers.ts";
import { UNITCHAR, assertShownSame, isUnitSwitch, readSlots, readSlotsOutside, top } from "./units-helpers.ts";

const HEADER = "Contents/header.xml";
const SECTION = "Contents/section0.xml";

// ── 합성 문서 ───────────────────────────────────────────────────────────

type Val = { v: number; unit?: "HWPUNIT" | "CHAR" | "none" };
type Body = { margin: Record<"intent" | "left" | "right" | "prev" | "next", Val>; ls: { type: string; v: number } };
type ParaSpec = { tab: number } & ({ sw: { c: Body; d: Body } } | { plain: Body });
type TabItem = { pos: Val };
type TabSpec = ({ sw: { c: TabItem; d: TabItem } } | { plain: TabItem })[];

const unitAttr = (x: Val): string => (x.unit === "none" ? "" : ` unit="${x.unit ?? "HWPUNIT"}"`);
const bodyXml = (b: Body): string =>
  `<hh:margin>${(["intent", "left", "right", "prev", "next"] as const).map((k) => `<hc:${k} value="${b.margin[k].v}"${unitAttr(b.margin[k])}/>`).join("")}</hh:margin>` +
  `<hh:lineSpacing type="${b.ls.type}" value="${b.ls.v}" unit="HWPUNIT"/>`;
const switchXml = (c: string, d: string): string => `<hp:switch><hp:case hp:required-namespace="${UNITCHAR}">${c}</hp:case><hp:default>${d}</hp:default></hp:switch>`;
const paraPrXml = (id: number, p: ParaSpec): string =>
  `<hh:paraPr id="${id}" tabPrIDRef="${p.tab}" condense="0"><hh:align horizontal="LEFT" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>` +
  ("sw" in p ? switchXml(bodyXml(p.sw.c), bodyXml(p.sw.d)) : bodyXml(p.plain)) +
  `<hh:border borderFillIDRef="1"/></hh:paraPr>`;
const tabItemXml = (t: TabItem): string => `<hh:tabItem pos="${t.pos.v}" type="LEFT" leader="NONE"${unitAttr(t.pos)}/>`;
const tabPrXml = (id: number, items: TabSpec): string =>
  `<hh:tabPr id="${id}" autoTabLeft="0" autoTabRight="0">${items.map((t) => ("sw" in t ? switchXml(tabItemXml(t.sw.c), tabItemXml(t.sw.d)) : tabItemXml(t.plain))).join("")}</hh:tabPr>`;

type DocSpec = { version: string | undefined; declareUnitChar: boolean; paraPrs: ParaSpec[]; tabPrs: TabSpec[]; paragraphs: number[] };

function headerXml(s: DocSpec): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>` +
    `<hh:head xmlns:hh="${NS_HH}" xmlns:hc="${NS_HC}" xmlns:hp="${NS_HP}"${s.declareUnitChar ? ` xmlns:hwpunitchar="${UNITCHAR}"` : ""} version="${s.version ?? "1.4"}" secCnt="1">` +
    `<hh:refList>` +
    `<hh:fontfaces itemCnt="1"><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="x" type="TTF" isEmbedded="0"/></hh:fontface></hh:fontfaces>` +
    `<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0"/></hh:borderFills>` +
    `<hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000" borderFillIDRef="1"><hh:fontRef hangul="0"/></hh:charPr></hh:charProperties>` +
    `<hh:tabProperties itemCnt="${s.tabPrs.length + 1}"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/>${s.tabPrs.map((t, i) => tabPrXml(i + 1, t)).join("")}</hh:tabProperties>` +
    `<hh:paraProperties itemCnt="${s.paraPrs.length}">${s.paraPrs.map((p, i) => paraPrXml(i, p)).join("")}</hh:paraProperties>` +
    `<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="본문" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"/></hh:styles>` +
    `</hh:refList></hh:head>`
  );
}

const versionXml = (v: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" xmlVersion="${v}" application="합성"/>`;

function buildDoc(s: DocSpec): Uint8Array {
  const body = s.paragraphs
    .map((pp, i) => `<hp:p id="${1000 + i}" paraPrIDRef="${pp}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>문단 ${i}</hp:t></hp:run></hp:p>`)
    .join("");
  return buildZip([
    { name: "mimetype", data: utf8("application/hwp+zip") },
    ...(s.version === undefined ? [] : [{ name: "version.xml", data: utf8(versionXml(s.version)), method: 8 as const }]),
    { name: "Contents/content.hpf", data: utf8(hpfXml([0])), method: 8 },
    {
      name: "META-INF/container.xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`,
      ),
      method: 8,
    },
    { name: HEADER, data: utf8(headerXml(s)), method: 8 },
    { name: SECTION, data: utf8(sectionXml(body)), method: 8 },
  ]);
}

const open = (bytes: Uint8Array): HwpxDocument => parseDocument(openPackage(bytes));
const zero: Val = { v: 0 };
const body = (m: Partial<Body["margin"]>, ls: Body["ls"] = { type: "PERCENT", v: 160 }): Body => ({
  margin: { intent: zero, left: zero, right: zero, prev: zero, next: zero, ...m },
  ls,
});
/** 한컴 1.5 저장본과 같은 짝: case는 HWPUNIT 값, default는 그 2배 */
const pair = (m: Partial<Record<keyof Body["margin"], number>>, ls?: Body["ls"]): { c: Body; d: Body } => ({
  c: body(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { v }])), ls),
  d: body(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { v: 2 * v }])), ls === undefined || ls.type === "PERCENT" ? ls : { type: ls.type, v: 2 * ls.v }),
});

// ── 공통 ────────────────────────────────────────────────────────────────

const sel = (from: number, to: number) => ({ sectionIndex: 0, parentPath: [], from, to });
const after = (index: number) => ({ sectionIndex: 0, parentPath: [], index, position: "after" as const });
const codes = (plan: ImportPlan): string[] => plan.issues.map((i) => i.code);
const headerOf = (bytes: Uint8Array): string => {
  const pkg = openPackage(bytes);
  return new TextDecoder().decode(readEntry(pkg.archive, bytes, HEADER));
};
const entryBytes = (bytes: Uint8Array, name: string): Uint8Array => {
  const pkg = openPackage(bytes);
  return readEntry(pkg.archive, bytes, name);
};
const importInto = (target: Uint8Array, fragment: Fragment, index: number): { plan: ImportPlan; bytes: Uint8Array; doc: HwpxDocument } => {
  const doc = open(target);
  const plan = planImport(doc, fragment, after(index));
  const bytes = applyPlan(doc.pkg, plan);
  return { plan, bytes, doc: open(bytes) };
};
const newErrors = (before: Uint8Array, after: Uint8Array) => compareToBaseline(validateDocument(before), validateDocument(after)).newErrors;
const addedXml = (before: Uint8Array, after: Uint8Array, kind: string): string[] => {
  const a = open(before).header.resources[kind] ?? [];
  const b = open(after);
  return (b.header.resources[kind] ?? []).slice(a.length).map((r) => b.header.text.slice(r.element.start, r.element.end));
};

// 손으로 만든 원본: 스위치 있는 문단모양(들여쓰기·위 간격·고정 줄 간격·글자 단위 case), 스위치 없는 문단모양, 탭(스위치·스위치 없음)
const HAND: Omit<DocSpec, "version" | "declareUnitChar"> = {
  paraPrs: [
    { tab: 0, plain: body({}) },
    { tab: 1, sw: pair({ intent: -2005, prev: 300 }) },
    { tab: 0, plain: body({ left: { v: 1500 }, intent: { v: -7 } }, { type: "FIXED", v: 1201 }) },
    { tab: 2, sw: pair({ next: 150 }, { type: "FIXED", v: 1300 }) },
    { tab: 0, sw: { c: body({ left: { v: 2, unit: "CHAR" } }), d: body({ left: { v: 2000 } }) } },
  ],
  tabPrs: [
    [{ sw: { c: { pos: { v: 4000 } }, d: { pos: { v: 8000, unit: "none" } } } }, { sw: { c: { pos: { v: 4033 } }, d: { pos: { v: 8066, unit: "none" } } } }],
    [{ plain: { pos: { v: 3001, unit: "none" } } }],
  ],
  paragraphs: [0, 1, 2, 3, 4, 1, 2, 0],
};
const hand = (version: string | undefined, declareUnitChar = version === "1.5"): Uint8Array => buildDoc({ ...HAND, version, declareUnitChar });
// 대상: 원본의 문단모양 0과 같은 것(재사용된다)과 대상 고유 문단모양 1(왼쪽 여백 1000, 스위치 없음)
const blank = (version: string | undefined, declareUnitChar = false): Uint8Array =>
  buildDoc({ version, declareUnitChar, paraPrs: [{ tab: 0, plain: body({}) }, { tab: 0, plain: body({ left: { v: 1000 } }) }], tabPrs: [], paragraphs: [0, 1] });

// ── 단위 시험 ───────────────────────────────────────────────────────────

test("7.66 1.5 조각 → 1.2 대상: HwpUnitChar 스위치는 default 내용으로, 스위치 밖 여백·고정 줄 간격·탭 위치는 2배, 글자 단위·비율은 그대로", () => {
  const src = open(hand("1.5"));
  const fragment = extractFragment(src, sel(1, 6));
  assert.equal(fragment.source.xmlVersion, "1.5");
  const target = blank("1.2");
  const r = importInto(target, fragment, 1);
  // 손으로 쓴 기대 원문(문단모양 0·스타일은 대상 것과 같아 재사용. 새 문단모양 id는 2부터, 탭은 대상에 0만 있으므로 1부터)
  const m = (o: Record<string, number>, unit: Record<string, string> = {}): string =>
    `<hh:margin>${["intent", "left", "right", "prev", "next"].map((k) => `<hc:${k} value="${o[k] ?? 0}" unit="${unit[k] ?? "HWPUNIT"}"/>`).join("")}</hh:margin>`;
  const head = (id: number, tab: number): string =>
    `<hh:paraPr id="${id}" tabPrIDRef="${tab}" condense="0"><hh:align horizontal="LEFT" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>`;
  const tail = `<hh:border borderFillIDRef="1"/></hh:paraPr>`;
  const ls = (type: string, v: number): string => `<hh:lineSpacing type="${type}" value="${v}" unit="HWPUNIT"/>`;
  assert.deepEqual(addedXml(target, r.bytes, "tabPr"), [
    `<hh:tabPr id="1" autoTabLeft="0" autoTabRight="0"><hh:tabItem pos="8000" type="LEFT" leader="NONE"/><hh:tabItem pos="8066" type="LEFT" leader="NONE"/></hh:tabPr>`,
    `<hh:tabPr id="2" autoTabLeft="0" autoTabRight="0"><hh:tabItem pos="6002" type="LEFT" leader="NONE"/></hh:tabPr>`,
  ]);
  assert.deepEqual(addedXml(target, r.bytes, "paraPr"), [
    head(2, 1) + m({ intent: -4010, prev: 600 }) + ls("PERCENT", 160) + tail,
    head(3, 0) + m({ left: 3000, intent: -14 }) + ls("FIXED", 2402) + tail,
    head(4, 2) + m({ next: 300 }) + ls("FIXED", 2600) + tail,
    head(5, 0) + m({ left: 2000 }) + ls("PERCENT", 160) + tail,
  ]);
  assert.equal(r.plan.summary["convertedResources"], 6, "바뀐 자원: 문단모양 4·탭 2");
  const warn = r.plan.issues.filter((i) => i.code === "FRAG_UNIT_CONVERTED");
  assert.equal(warn.length, 1);
  assert.match(warn[0]?.message ?? "", /1\.5.*6개.*1\.2/);
  // 대상의 version.xml·헤더 version은 그대로, 대상 고유 문단모양도 그대로
  assert.ok(bytesEqual(entryBytes(r.bytes, "version.xml"), entryBytes(target, "version.xml")));
  assert.match(headerOf(r.bytes), /<hh:head [^>]*version="1\.2"/);
  assert.ok(headerOf(r.bytes).includes(paraPrXml(1, { tab: 0, plain: body({ left: { v: 1000 } }) })));
  assert.ok(!headerOf(r.bytes).includes(UNITCHAR), "스위치와 선언이 들어가지 않는다");
  assert.deepEqual(newErrors(target, r.bytes), []);
  assertShownSame(src, top(src, 1, 6), true, r.doc, top(r.doc, 2, 6), false, "1.5 → 1.2");
});

test("7.66 1.2 조각 → 1.2 대상, 1.5 → 1.5: 변환 없음(경고·요약 0, 자원 원문 그대로)", () => {
  for (const v of ["1.2", "1.5"]) {
    const src = open(hand(v, false));
    const fragment = extractFragment(src, sel(1, 6));
    const target = blank(v);
    const r = importInto(target, fragment, 1);
    assert.equal(r.plan.summary["convertedResources"], 0, v);
    assert.deepEqual(codes(r.plan).filter((c) => c.startsWith("FRAG_UNIT") || c === "FRAG_FORMAT_UNKNOWN"), [], v);
    // 들어간 문단모양 원문은 원본과 id·탭 참조만 다르다
    const strip = (x: string): string => x.replace(/ (id|tabPrIDRef)="\d+"/g, "");
    assert.deepEqual(addedXml(target, r.bytes, "paraPr").map(strip), [1, 2, 3, 4].map((i) => strip(paraPrXml(i, HAND.paraPrs[i] as ParaSpec))), v);
    assertShownSame(src, top(src, 1, 6), v === "1.5", r.doc, top(r.doc, 2, 6), v === "1.5", `${v} → ${v}`);
  }
});

test("7.66 1.2 조각 → 1.5 대상: default 밖 단위 값을 절반(0 쪽으로 버림), default는 그대로", () => {
  const src = open(hand("1.2", false));
  const fragment = extractFragment(src, sel(1, 6));
  const target = blank("1.5");
  const r = importInto(target, fragment, 1);
  const added = addedXml(target, r.bytes, "paraPr");
  assert.ok(added[0]?.includes(`<hp:case hp:required-namespace="${UNITCHAR}"><hh:margin><hc:intent value="-1002" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="150" unit="HWPUNIT"/>`), added[0]);
  assert.ok(added[0]?.includes(`<hp:default><hh:margin><hc:intent value="-4010" unit="HWPUNIT"/>`), "default는 그대로");
  assert.ok(added[1]?.includes(`<hc:intent value="-3" unit="HWPUNIT"/><hc:left value="750" unit="HWPUNIT"/>`) && added[1].includes(`type="FIXED" value="600"`), added[1]);
  assert.ok(added[3]?.includes(`<hc:left value="2" unit="CHAR"/>`), "글자 단위는 그대로");
  assert.equal(r.plan.summary["convertedResources"], 5, "바뀐 자원: 문단모양 3·탭 2(글자 단위만 있는 문단모양 4는 그대로)");
  assert.deepEqual(newErrors(target, r.bytes), []);
  const { compared } = assertShownSame(src, top(src, 1, 6), false, r.doc, top(r.doc, 2, 6), true, "1.2 → 1.5");
  assert.ok(compared > 30);
});

test("7.66 형식 버전을 알 수 없음: 한쪽만 모르면 FRAG_FORMAT_UNKNOWN(변환 없음), 둘 다 모르면 경고 없음", () => {
  const src = open(hand("1.5"));
  const fragment = extractFragment(src, sel(1, 6));
  // 이전 형식 조각(JSON에 xmlVersion 없음)
  const old = JSON.parse(serializeFragment(fragment)) as { source: Record<string, unknown> };
  delete old.source["xmlVersion"];
  const legacy = parseFragment(JSON.stringify(old));
  assert.equal(legacy.source.xmlVersion, undefined);
  const cases: [string, Fragment, Uint8Array, boolean][] = [
    ["예전 조각 → 1.2", legacy, blank("1.2"), true],
    ["1.5 조각 → 버전 없는 대상", fragment, blank(undefined), true],
    ["예전 조각 → 버전 없는 대상", legacy, blank(undefined), false],
  ];
  for (const [label, f, target, warns] of cases) {
    const r = importInto(target, f, 1);
    assert.equal(codes(r.plan).filter((c) => c === "FRAG_FORMAT_UNKNOWN").length, warns ? 1 : 0, label);
    assert.equal(codes(r.plan).includes("FRAG_UNIT_CONVERTED"), false, label);
    assert.equal(r.plan.summary["convertedResources"], 0, label);
    assert.ok(addedXml(target, r.bytes, "paraPr").every((x) => x.includes(UNITCHAR) || !x.includes("switch")), `${label}: 원문 그대로(스위치 유지)`);
    assert.equal(addedXml(target, r.bytes, "paraPr").filter((x) => x.includes(UNITCHAR)).length, 3, label);
    assert.deepEqual(newErrors(target, r.bytes), [], label);
  }
  // 버전 문자열을 읽을 수 없어도 알 수 없음이다
  const odd = JSON.parse(serializeFragment(fragment)) as { source: Record<string, unknown> };
  odd.source["xmlVersion"] = "x";
  const r = importInto(blank("1.2"), parseFragment(JSON.stringify(odd)), 1);
  assert.deepEqual(codes(r.plan).filter((c) => c.startsWith("FRAG_")), ["FRAG_FORMAT_UNKNOWN"]);
});

test("7.66 같은 조각 두 번(1.5 → 1.2, 1.2 → 1.5): 둘째는 자원 전부 재사용, 변환 수는 같다, 결정적", () => {
  for (const [sv, tv] of [["1.5", "1.2"], ["1.2", "1.5"]] as const) {
    const fragment = extractFragment(open(hand(sv, false)), sel(0, 7));
    const first = importInto(blank(tv), fragment, 1);
    const again = planImport(open(blank(tv)), fragment, after(1));
    assert.ok(bytesEqual(applyPlan(open(blank(tv)).pkg, again), first.bytes), `${sv} → ${tv}: 같은 입력 같은 바이트`);
    const second = importInto(first.bytes, fragment, 3);
    assert.equal(second.plan.summary["addedResources"], 0, `${sv} → ${tv}`);
    assert.equal(second.plan.summary["reusedResources"], fragment.resources.length, `${sv} → ${tv}`);
    assert.equal(second.plan.summary["convertedResources"], first.plan.summary["convertedResources"], `${sv} → ${tv}`);
  }
});

test("7.66 JSON 왕복: source.xmlVersion·valueNamespaces가 남고 가져온 결과가 같다", () => {
  const fragment = extractFragment(open(hand("1.5")), sel(1, 6));
  const round = parseFragment(serializeFragment(fragment));
  assert.equal(round.source.xmlVersion, "1.5");
  assert.deepEqual(
    fragment.resources.filter((r) => r.valueNamespaces !== undefined).map((r) => r.valueNamespaces),
    fragment.resources.filter((r) => r.xml.includes(UNITCHAR)).map(() => ({ hwpunitchar: UNITCHAR })),
  );
  assert.deepEqual(round, fragment);
  for (const tv of ["1.2", "1.5", undefined]) {
    assert.ok(bytesEqual(importInto(blank(tv), round, 1).bytes, importInto(blank(tv), fragment, 1).bytes), String(tv));
  }
  // 원본에 선언이 없으면 valueNamespaces도 없다
  assert.ok(extractFragment(open(hand("1.5", false)), sel(1, 6)).resources.every((r) => r.valueNamespaces === undefined));
});

test("7.66 스위치가 요구하는 네임스페이스 선언: 두 버전을 알고 스위치가 남을 때만, 대상 헤더 루트에 없을 때 원본 접두사로 더한다", () => {
  const fragment = extractFragment(open(hand("1.5")), sel(1, 6));
  const decl = `xmlns:hwpunitchar="${UNITCHAR}"`;
  const rootOf = (bytes: Uint8Array): string => /<hh:head [^>]*>/.exec(headerOf(bytes))?.[0] ?? "";
  // 1.5 → 1.5, 대상에 선언 없음: 더한다
  const t15 = blank("1.5", false);
  const r15 = importInto(t15, fragment, 1);
  assert.ok(rootOf(r15.bytes).includes(decl));
  assert.equal(rootOf(r15.bytes).replace(` ${decl}`, ""), rootOf(t15));
  // 대상에 이미 있으면 그대로
  const declared = blank("1.5", true);
  assert.equal(rootOf(importInto(declared, fragment, 1).bytes), rootOf(declared));
  // 1.5 → 1.2: 스위치가 사라지므로 선언하지 않는다. 대상 버전을 모르면 정리하지 않는다
  assert.ok(!rootOf(importInto(blank("1.2"), fragment, 1).bytes).includes("hwpunitchar"));
  assert.ok(!rootOf(importInto(blank(undefined), fragment, 1).bytes).includes("hwpunitchar"));
  // 같은 URI를 다른 접두사로 선언한 대상에는 더하지 않는다
  const other = mutateEntryText(blank("1.5"), HEADER, (t) => t.replace(`xmlns:hp="${NS_HP}"`, `xmlns:hp="${NS_HP}" xmlns:huc="${UNITCHAR}"`));
  assert.ok(!rootOf(importInto(other, fragment, 1).bytes).includes("xmlns:hwpunitchar"));
});

test("7.66 default가 없는 HwpUnitChar 스위치는 내림 변환에서 그대로 둔다(내용을 잃지 않는다)", () => {
  // 문단모양 1의 스위치에서 default를 뺀다(탭 1의 스위치는 그대로)
  const caseOnly = mutateEntryText(hand("1.5"), HEADER, (t) => t.replace(/<hh:paraPr id="1"[\s\S]*?<\/hh:paraPr>/, (m) => m.replace(/<hp:default>[\s\S]*?<\/hp:default>/, "")));
  const src = open(caseOnly);
  const fragment = extractFragment(src, sel(1, 1));
  const r = importInto(blank("1.2"), fragment, 1);
  const added = addedXml(blank("1.2"), r.bytes, "paraPr");
  assert.equal(added.length, 1);
  assert.ok(added[0]?.includes(`<hp:switch><hp:case hp:required-namespace="${UNITCHAR}"><hh:margin><hc:intent value="-2005" unit="HWPUNIT"/>`) && !added[0].includes("hp:default"), added[0]);
  assert.equal(r.plan.summary["convertedResources"], 1, "탭 1만 바뀐다");
  assert.equal(validateDocument(r.bytes).warnings.filter((i) => i.code === "RES_UNIT_SWITCH_LEGACY").length, 1);
});

test("7.66 본문은 바뀌지 않는다: 1.2 대상과 1.5 대상에 넣은 문단 원문이 같다", () => {
  const fragment = extractFragment(open(hand("1.5", false)), sel(0, 7));
  const section = (bytes: Uint8Array): string => new TextDecoder().decode(entryBytes(bytes, SECTION));
  assert.equal(section(importInto(blank("1.2"), fragment, 1).bytes), section(importInto(blank("1.5"), fragment, 1).bytes));
});

test("7.66 한컴 저장본(1.5) 조각 → 합성 1.2 대상: 스위치가 남지 않고 한컴이 보여 줄 값이 같다", () => {
  for (const name of ["hancom/blocks", "hancom/ph-table", "hancom/field-states", "tables/tables-rich", "tables/tables-merged"]) {
    const src = loadDoc(name);
    const n = src.sections[0]?.paragraphs.length ?? 0;
    const fragment = extractFragment(src, sel(1, n - 1));
    assert.equal(fragment.source.xmlVersion, "1.5", name);
    const target = blank("1.2");
    const r = importInto(target, fragment, 1);
    assert.ok(!headerOf(r.bytes).includes(UNITCHAR), name);
    assert.ok((r.plan.summary["convertedResources"] ?? 0) > 0, name);
    assert.deepEqual(newErrors(target, r.bytes), [], name);
    assertShownSame(src, top(src, 1, n - 1), true, r.doc, top(r.doc, 2, n - 1), false, name);
  }
});

// ── 무작위 ──────────────────────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSpec(r: () => number, version: string | undefined, paraPrs: number, paragraphs: number): DocSpec {
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const val = (): number => (r() < 0.35 ? 0 : int(-30000, 30000));
  const lineSpacing = (): Body["ls"] => (r() < 0.6 ? { type: "PERCENT", v: int(80, 300) } : { type: pick(["FIXED", "AT_LEAST", "BETWEEN_LINES"]), v: int(0, 5000) });
  const tabPrs: TabSpec[] = Array.from({ length: int(3, 12) }, () =>
    Array.from({ length: int(1, 6) }, () => {
      const v = int(0, 60000);
      return r() < 0.5 ? { sw: { c: { pos: { v } }, d: { pos: { v: 2 * v, unit: "none" as const } } } } : { plain: { pos: { v, unit: pick(["none", "HWPUNIT"] as const) } } };
    }),
  );
  const specs: ParaSpec[] = Array.from({ length: paraPrs }, () => {
    const tab = int(0, tabPrs.length);
    if (r() < 0.5) {
      const p = pair({ intent: val(), left: val(), right: val(), prev: val(), next: val() }, lineSpacing());
      if (r() < 0.15) p.c.margin.left = { v: int(1, 9), unit: "CHAR" };
      return { tab, sw: p };
    }
    const b = body({ intent: { v: val() }, left: { v: val() }, right: { v: val() }, prev: { v: val() }, next: { v: val() } }, lineSpacing());
    if (r() < 0.1) b.margin.prev = { v: int(1, 9), unit: "CHAR" };
    return { tab, plain: b };
  });
  return { version, declareUnitChar: r() < 0.5, paraPrs: specs, tabPrs, paragraphs: Array.from({ length: paragraphs }, () => int(0, paraPrs - 1)) };
}

test("7.66 무작위 60회: 원본·대상 형식(1.5·1.2·모름) 조합에서 한컴이 보여 줄 값 보존, 경고·변환 수, 결정성, 재사용, 검사기 새 오류 0", (t) => {
  const versions = ["1.5", "1.2", undefined] as const;
  const tally: Record<string, number> = {};
  let shown = 0;
  let converted = 0;
  for (let seed = 6901; seed <= 6960; seed++) {
    const r = rng(seed);
    const sv = versions[Math.floor(r() * 3)];
    const tv = versions[Math.floor(r() * 3)];
    const srcBytes = buildDoc(randomSpec(r, sv, 40, 80));
    const targetBytes = buildDoc(randomSpec(r, tv, 12, 20));
    const src = open(srcBytes);
    const from = Math.floor(r() * 60);
    const to = from + 5 + Math.floor(r() * 15);
    const index = Math.floor(r() * 20);
    const label = `시드 ${seed}(${sv ?? "모름"} → ${tv ?? "모름"}, ${from}~${to} → ${index})`;
    const fragment = extractFragment(src, sel(from, to));
    const one = importInto(targetBytes, fragment, index);
    // 결정성
    assert.ok(bytesEqual(applyPlan(open(targetBytes).pkg, planImport(open(targetBytes), parseFragment(serializeFragment(fragment)), after(index))), one.bytes), `${label}: 같은 입력 같은 바이트`);
    assert.deepEqual(newErrors(targetBytes, one.bytes), [], label);
    assert.ok(tv === undefined || bytesEqual(entryBytes(one.bytes, "version.xml"), entryBytes(targetBytes, "version.xml")), `${label}: version.xml 그대로`);
    // 기대 경고와 변환 수: 형식이 갈리면, 바뀌는 자원(down: 스위치가 있거나 스위치 밖 HWPUNIT 값이 0이 아님 / up: default 밖 HWPUNIT 값이 0이 아님)의 수
    const su = sv === undefined ? undefined : sv === "1.5";
    const tu = tv === undefined ? undefined : tv === "1.5";
    let expected = 0;
    for (const res of fragment.resources) {
      const item = (src.header.resources[res.kind] ?? []).find((i) => i.id === res.id && i.lang === res.lang);
      assert.ok(item !== undefined);
      const hasSwitch = [...walkElements(item.element)].some(isUnitSwitch);
      const nonzero = readSlots(item.element).some(([, kind, v]) => kind === "HWP" && v !== 0);
      const plainNonzero = readSlotsOutside(item.element).some(([, kind, v]) => kind === "HWP" && v !== 0);
      if (su === true && tu === false && (hasSwitch || plainNonzero)) expected++;
      if (su === false && tu === true && nonzero) expected++;
    }
    const unknown = (su === undefined) !== (tu === undefined);
    assert.equal(one.plan.summary["convertedResources"], expected, `${label}: 변환 수`);
    assert.equal(codes(one.plan).filter((c) => c === "FRAG_UNIT_CONVERTED").length, expected > 0 ? 1 : 0, label);
    assert.equal(codes(one.plan).filter((c) => c === "FRAG_FORMAT_UNKNOWN").length, unknown ? 1 : 0, label);
    if (su !== undefined && tu !== undefined) shown += assertShownSame(src, top(src, from, to - from + 1), su, one.doc, top(one.doc, index + 1, to - from + 1), tu, label).compared;
    // 두 번째는 전부 재사용
    const second = importInto(one.bytes, fragment, 0);
    assert.equal(second.plan.summary["addedResources"], 0, `${label}: 두 번째 추가 자원`);
    const key = `${sv ?? "모름"}→${tv ?? "모름"}`;
    tally[key] = (tally[key] ?? 0) + 1;
    converted += expected;
  }
  t.diagnostic(`조합 ${JSON.stringify(tally)}, 대조한 값 ${shown}, 변환한 자원 ${converted}`);
  assert.equal(Object.keys(tally).length, 9, `조합 ${JSON.stringify(tally)}`);
  assert.ok(shown > 1000 && converted > 100, `대조한 값 ${shown}, 변환한 자원 ${converted}`);
});

// ── 검사기 ──────────────────────────────────────────────────────────────

test("8.1 RES_UNIT_SWITCH_LEGACY: 형식 버전 1.5 미만인데 HwpUnitChar 스위치가 있으면 경고(오류 아님), 그 밖에는 없다", () => {
  const count = (bytes: Uint8Array) => {
    const rep = validateDocument(bytes);
    return {
      warn: rep.warnings.filter((i) => i.code === "RES_UNIT_SWITCH_LEGACY"),
      err: rep.errors.filter((i) => i.code === "RES_UNIT_SWITCH_LEGACY").length,
    };
  };
  const legacy = count(hand("1.2"));
  assert.equal(legacy.warn.length, 1);
  assert.equal(legacy.err, 0);
  assert.match(legacy.warn[0]?.message ?? "", /1\.2.*5개/, "스위치 5개(문단모양 3·탭 2)");
  assert.equal(validateDocument(hand("1.2"), { strict: true }).errors.filter((i) => i.code === "RES_UNIT_SWITCH_LEGACY").length, 0);
  for (const [label, bytes] of [
    ["1.5 스위치", hand("1.5")],
    ["버전 없음 스위치", hand(undefined)],
    ["1.2 스위치 없음", blank("1.2")],
    ["한컴 저장본", readFixture("hancom-merged")],
  ] as const) {
    assert.equal(count(bytes).warn.length, 0, label);
  }
  // 1.5 원본을 1.2 대상에 넣은 결과는 스위치가 남지 않아 경고가 없다
  const r = importInto(blank("1.2"), extractFragment(open(hand("1.5")), sel(0, 7)), 1);
  assert.equal(count(r.bytes).warn.length, 0);
});
