// 실제 문서 스트레스 캠페인에서 나온 조각 가져오기 수정(명세 7.8 "캠페인에 따른 수정" 1~5)의 재현 시험.
// 기대값은 명세에서 정했고, 합성 최소 문서(tools/stress/repro.ts의 결함 재현 문서와 같은 모양)로 만든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  applyPlan,
  collectBodyRefs,
  subElements,
  childEl,
  extractFragment,
  listFields,
  planImport,
  validateDocument,
  compareToBaseline,
  type Fragment,
  type HwpxDocument,
  type InsertPoint,
} from "../src/index.ts";
import type { ImportPlan } from "../src/fragment/types.ts";
import { MINIMAL_HEADER, NS_HC, buildHwpx, expandResource, loadDoc, parseSynthetic, reparse, sectionXml } from "./helpers.ts";

const sel = (from: number, to: number, parentPath: number[] = []) => ({ sectionIndex: 0, parentPath, from, to });
const endOf = (doc: HwpxDocument): InsertPoint => ({
  sectionIndex: 0,
  parentPath: [],
  index: (doc.sections[0]?.paragraphs.length ?? 1) - 1,
  position: "after",
});
const para = (id: string, inner: string, text = "x"): string =>
  `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}<hp:t>${text}</hp:t></hp:run></hp:p>`;

/** 소스의 `from`~`to`를 대상의 끝에 넣는다(옵션 포함). 적용·재파싱·검사기 기준선 대조까지 한다. */
function importInto(src: HwpxDocument, tgt: HwpxDocument, from = 0, to = (src.sections[0]?.paragraphs.length ?? 1) - 1, options?: { reissueInternalDuplicates?: boolean }) {
  const fragment = extractFragment(src, sel(from, to));
  const plan = planImport(tgt, fragment, endOf(tgt), options) as ImportPlan;
  const bytes = applyPlan(tgt.pkg, plan);
  const result = reparse(bytes);
  const cmp = compareToBaseline(validateDocument(tgt.pkg.bytes), validateDocument(bytes));
  return { fragment, plan, bytes, result, newErrors: cmp.newErrors.map((e) => `${e.code}: ${e.message}`) };
}

const listNames = (doc: HwpxDocument): string[] => {
  const refList = childEl(doc.header.root, "head", "refList");
  return refList === undefined ? [] : subElements(refList).map((e) => e.local);
};

// ── 1. 없는 자원 목록 만들기 ────────────────────────────────────────────

/** 글머리표 목록과 그것을 쓰는 문단모양(1번)이 있는 합성 header */
const BULLET_HEADER = MINIMAL_HEADER.replace(
  '<hh:paraProperties itemCnt="1">',
  '<hh:bullets itemCnt="1"><hh:bullet id="1" char="&#8226;" useImage="0"/></hh:bullets><hh:paraProperties itemCnt="2">',
).replace("</hh:paraProperties>", '<hh:paraPr id="1"><hh:heading type="BULLET" idRef="1" level="0"/><hh:border borderFillIDRef="1"/></hh:paraPr></hh:paraProperties>');
const bulletPara = '<hp:p id="1" paraPrIDRef="1" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>x</hp:t></hp:run></hp:p>';

test("1. 대상 header에 글머리표 목록이 없으면 FRAG_NO_LIST로 거절하지 않고 목록을 만든다", () => {
  const src = reparse(buildHwpx([bulletPara], BULLET_HEADER));
  const tgt = parseSynthetic([para("1", "")]);
  assert.ok(!listNames(tgt).includes("bullets"), "전제: 대상에 목록이 없다");
  const r = importInto(src, tgt);
  assert.deepEqual(r.newErrors, [], "검사기 새 오류 0");
  assert.equal(r.plan.summary["addedResources"], 1 + 1, "문단모양과 글머리표 하나씩");
  // 목록과 개수 속성
  const text = r.result.header.text;
  const m = /<hh:bullets itemCnt="(\d+)">(.*?)<\/hh:bullets>/.exec(text);
  assert.ok(m !== null, "새 bullets 목록이 있다");
  assert.equal(m[1], "1");
  assert.equal([...(m[2] ?? "").matchAll(/<hh:bullet /g)].length, 1);
  assert.ok((m[2] ?? "").includes('char="&#8226;"'), "글머리표 원문이 그대로다");
  assert.deepEqual(validateDocument(r.bytes).warnings.filter((w) => w.code === "RES_ITEMCNT"), [], "개수 속성이 맞다");
  // 서식 지문: 가져온 문단모양이 가리키는 글머리표까지 전개한 모양이 소스와 같다
  const inserted = r.result.sections[0]?.paragraphs.at(-1);
  assert.ok(inserted !== undefined);
  const paraRef = collectBodyRefs(inserted.element).find((x) => x.kind === "paraPr");
  assert.ok(paraRef !== undefined);
  assert.deepEqual(expandResource(r.result, "paraPr", paraRef.id), expandResource(src, "paraPr", "1"));
  // 가져온 문단모양이 가리키는 글머리표 id는 만든 목록의 글머리표 id다
  const bulletId = /<hh:bullet id="(\d+)"/.exec(m[2] ?? "")?.[1];
  const idRefs = [...text.matchAll(/<hh:heading type="BULLET" idRef="(\d+)"/g)].map((x) => x[1]);
  assert.deepEqual(idRefs, [bulletId]);
  assert.deepEqual(r.result.issues.filter((i) => i.severity === "error"), []);
});

test("1. 만든 목록의 자리는 관측한 목록 순서(글꼴, 테두리, 글자모양, 탭, 번호, 글머리표, 문단모양, 스타일)를 따른다", () => {
  // 소스: 탭·번호·글머리표를 다 쓰는 문단모양. 대상: 셋 다 없다
  const header = MINIMAL_HEADER.replace(
    '<hh:paraProperties itemCnt="1">',
    '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
      '<hh:numberings itemCnt="1"><hh:numbering id="1" start="0"><hh:paraHead level="1" numFormat="DIGIT">^1.</hh:paraHead></hh:numbering></hh:numberings>' +
      '<hh:bullets itemCnt="1"><hh:bullet id="1" char="&#8226;" useImage="0"/></hh:bullets>' +
      '<hh:paraProperties itemCnt="4">',
  ).replace(
    "</hh:paraProperties>",
    '<hh:paraPr id="1" tabPrIDRef="0"><hh:heading type="NUMBER" idRef="1" level="0"/><hh:border borderFillIDRef="1"/></hh:paraPr>' +
      '<hh:paraPr id="2"><hh:heading type="BULLET" idRef="1" level="0"/><hh:border borderFillIDRef="1"/></hh:paraPr>' +
      '<hh:paraPr id="3" tabPrIDRef="0"><hh:heading type="NONE" idRef="0" level="0"/><hh:border borderFillIDRef="1"/></hh:paraPr></hh:paraProperties>',
  );
  const body = ["1", "2", "3"].map((n) => `<hp:p id="${n}" paraPrIDRef="${n}" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>x</hp:t></hp:run></hp:p>`).join("");
  const src = reparse(buildHwpx([body], header));
  const tgt = parseSynthetic([para("1", "")]);
  const r = importInto(src, tgt);
  assert.deepEqual(r.newErrors, []);
  assert.deepEqual(listNames(r.result), [
    "fontfaces",
    "borderFills",
    "charProperties",
    "tabProperties",
    "numberings",
    "bullets",
    "paraProperties",
    "styles",
  ]);
  for (const kind of ["tabPr", "numbering", "bullet"]) assert.equal((r.result.header.resources[kind] ?? []).length, 1, kind);
  assert.deepEqual(validateDocument(r.bytes).warnings.filter((w) => w.code === "RES_ITEMCNT"), []);
  // 같은 조각을 한 번 더 넣으면 만든 목록의 항목이 재사용된다
  const second = planImport(r.result, r.fragment, endOf(r.result));
  assert.equal(second.summary["addedResources"], 0);
});

test("1. 대상 refList의 끝(스타일 뒤 다른 목록이 있는 경우)과 중간에도 자리가 맞다", () => {
  // 대상에 memoProperties(그 밖 목록)가 스타일 뒤에 있다: 글머리표는 문단모양 앞, 그 밖 목록은 그대로 맨 뒤
  const tgtHeader = MINIMAL_HEADER.replace("</hh:refList>", '<hh:memoProperties itemCnt="0"/></hh:refList>');
  const src = reparse(buildHwpx([bulletPara], BULLET_HEADER));
  const tgt = parseSynthetic([para("1", "")], tgtHeader);
  const r = importInto(src, tgt);
  assert.deepEqual(r.newErrors, []);
  assert.deepEqual(listNames(r.result), ["fontfaces", "borderFills", "charProperties", "bullets", "paraProperties", "styles", "memoProperties"]);
});

test("1. refList가 없는 대상은 지금처럼 FRAG_NO_LIST로 거절한다", () => {
  const src = reparse(buildHwpx([bulletPara], BULLET_HEADER));
  const noRefList = MINIMAL_HEADER.replace(/<hh:refList>[\s\S]*<\/hh:refList>/, "");
  assert.ok(!noRefList.includes("refList"));
  const tgt = parseSynthetic([para("1", "")], noRefList);
  const fragment = extractFragment(src, sel(0, 0));
  assert.throws(
    () => planImport(tgt, fragment, endOf(tgt)),
    (e: unknown) => e instanceof HwpxError && e.code === "FRAG_NO_LIST",
  );
});

test("1. 대상의 fontface가 없는 언어도 fontfaces 안에 언어 순서대로 만든다", () => {
  // 소스: LATIN 글꼴을 쓰는 글자모양. 대상(합성 최소 header): HANGUL 글꼴 목록뿐
  const srcHeader = MINIMAL_HEADER.replace(
    '<hh:fontfaces itemCnt="1"><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="x" type="TTF" isEmbedded="0"/></hh:fontface></hh:fontfaces>',
    '<hh:fontfaces itemCnt="2"><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="x" type="TTF" isEmbedded="0"/></hh:fontface>' +
      '<hh:fontface lang="LATIN" fontCnt="1"><hh:font id="0" face="y" type="TTF" isEmbedded="0"/></hh:fontface></hh:fontfaces>',
  ).replace('<hh:fontRef hangul="0"/></hh:charPr><hh:charPr id="1"', '<hh:fontRef hangul="0" latin="0"/></hh:charPr><hh:charPr id="1"');
  assert.notEqual(srcHeader, MINIMAL_HEADER);
  const src = reparse(buildHwpx([para("1", "")], srcHeader));
  const tgt = parseSynthetic([para("1", "")]);
  const r = importInto(src, tgt);
  assert.deepEqual(r.newErrors, []);
  const fonts = r.result.header.resources["font"] ?? [];
  assert.deepEqual(fonts.map((f) => `${f.lang}:${f.id}`), ["HANGUL:0", "LATIN:0"]);
  assert.match(r.result.header.text, /<hh:fontfaces itemCnt="2">/);
  assert.match(r.result.header.text, /<hh:fontface lang="LATIN" fontCnt="1">/);
  assert.deepEqual(validateDocument(r.bytes).warnings.filter((w) => w.code === "RES_ITEMCNT"), []);
});

// ── 2. 상속한 문제 기록 ────────────────────────────────────────────────

test("2. 조각 안에서 겹치는 객체 id는 plan.inherited.duplicateIds로 기록하고 경고 FRAG_INHERITED_DUP을 낸다", () => {
  const src = parseSynthetic([para("1", '<hp:rect id="2"/><hp:rect id="2"/>')]);
  const tgt = parseSynthetic([para("1", '<hp:rect id="100"/>')]);
  const r = importInto(src, tgt);
  assert.deepEqual(r.plan.inherited.duplicateIds, [{ role: "object", value: "2", count: 2 }]);
  assert.deepEqual(r.plan.inherited.danglingRefs, []);
  const warn = r.plan.issues.filter((i) => i.code === "FRAG_INHERITED_DUP");
  assert.equal(warn.length, 1);
  assert.equal(warn[0]?.severity, "warning");
  // 전제: 검사기는 이것을 새 오류로 센다(그래서 게이트가 기록을 보고 설명해야 한다)
  assert.ok(r.newErrors.some((e) => e.startsWith("INST_DUP_ID") && e.includes("object id")), r.newErrors.join(" | "));
});

test("2. 문단 id 중복: 대상과 부딪치지 않는 것만 상속이다(부딪치면 재발급하므로 기록하지 않는다)", () => {
  const src = parseSynthetic([para("7", "", "a") + para("7", "", "b")]);
  const free = importInto(src, parseSynthetic([para("1", "")]));
  assert.deepEqual(free.plan.inherited.duplicateIds, [{ role: "paragraph", value: "7", count: 2 }]);
  const clash = importInto(src, parseSynthetic([para("7", "")]));
  assert.deepEqual(clash.plan.inherited.duplicateIds, [], "대상에 있는 id는 두 번 다 재발급돼 겹침이 남지 않는다");
  assert.deepEqual(clash.newErrors, []);
  // 자리값(0, 4294967295 등)은 한컴이 여러 문단에 쓰므로 겹침이 아니다
  const placeholder = importInto(parseSynthetic([para("4294967295", "", "a") + para("4294967295", "", "b")]), parseSynthetic([para("1", "")]));
  assert.deepEqual(placeholder.plan.inherited.duplicateIds, []);
});

test("2. 누름틀 시작 id 중복도 상속으로 기록한다", () => {
  const field = (id: string, name: string): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="1"/></hp:ctrl>` +
    `<hp:t>값</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
  const src = parseSynthetic([para("1", field("570", "a") + field("570", "b"))]);
  const r = importInto(src, parseSynthetic([para("1", "")]));
  assert.deepEqual(r.plan.inherited.duplicateIds, [{ role: "fieldBegin", value: "570", count: 2 }]);
  assert.ok(r.newErrors.some((e) => e.startsWith("INST_DUP_ID") && e.includes("field id")), r.newErrors.join(" | "));
});

test("2. 소스에서 없던 참조는 plan.inherited.danglingRefs로 기록하고 FRAG_DANGLING_SOURCE 경고와 짝이 맞는다", () => {
  const src = parseSynthetic(['<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="9"><hp:t>가</hp:t></hp:run></hp:p>']);
  const r = importInto(src, parseSynthetic([para("1", "")]), 0, 0);
  assert.deepEqual(r.plan.inherited.danglingRefs, [{ kind: "charPr", id: "9", count: 1 }]);
  assert.ok(r.plan.issues.some((i) => i.code === "FRAG_DANGLING_SOURCE" && i.message.startsWith("charPr 9이(가) 없는데")));
  // 자원 안의 없는 참조: D1의 문단모양은 비어 있는 tabProperties의 0번을 가리킨다
  const d1 = extractFragment(loadDoc("D1"), sel(1, 1));
  const plan = planImport(parseSynthetic([para("1", "")]), d1, endOf(parseSynthetic([para("1", "")]))) as ImportPlan;
  assert.ok(plan.inherited.danglingRefs.some((x) => x.kind === "tabPr" && x.id === "0" && x.count >= 1));
  assert.ok(plan.issues.some((i) => i.code === "FRAG_DANGLING_SOURCE" && i.message.startsWith("tabPr 0이(가) 없는데")));
});

test("2. 깨끗한 조각의 inherited는 비어 있다", () => {
  for (const [name, from, to] of [["D5", 4, 9], ["D1", 8, 11], ["hancom-merged", 1, 14]] as const) {
    const tgt = loadDoc("hancom/blocks");
    const plan = planImport(tgt, extractFragment(loadDoc(name), sel(from, to)), endOf(tgt)) as ImportPlan;
    // D1·D5의 문단모양은 소스에서 비어 있는 탭 목록 0번을 가리킨다(소스의 문제)
    assert.deepEqual(plan.inherited.duplicateIds, [], name);
    for (const d of plan.inherited.danglingRefs) assert.ok(name !== "hancom-merged", `${name}: ${JSON.stringify(d)}`);
  }
});

// ── 3. reissueInternalDuplicates ───────────────────────────────────────

test("3. reissueInternalDuplicates: 조각 안 객체 id·instId·문단 id 중복을 첫 등장만 두고 새 값으로 바꾼다", () => {
  const src = parseSynthetic([
    para("7", '<hp:rect id="2" instId="5"/><hp:rect id="2" instId="5"/><hp:rect id="2" instId="6"/>', "a") + para("7", "", "b"),
  ]);
  const tgt = parseSynthetic([para("1", '<hp:rect id="100"/>')]);

  const off = importInto(src, tgt);
  assert.deepEqual(off.plan.inherited.duplicateIds.map((d) => `${d.role}:${d.value}x${d.count}`).sort(), ["inst:5x2", "object:2x3", "paragraph:7x2"]);
  assert.ok(off.newErrors.some((e) => e.startsWith("INST_DUP_ID")));

  const on = importInto(src, tgt, 0, 0, { reissueInternalDuplicates: true });
  assert.deepEqual(on.plan.inherited.duplicateIds, [], "켜면 기록에서 빠진다");
  assert.deepEqual(on.newErrors, [], "검사기 새 오류 0");
  const text = on.result.sections[0]?.text ?? "";
  // 첫 등장은 그대로
  assert.equal([...text.matchAll(/<hp:rect id="2" instId="5"\/>/g)].length, 1);
  assert.equal([...text.matchAll(/<hp:p id="7"/g)].length, 1);
  assert.ok(on.plan.issues.every((i) => i.code !== "FRAG_INHERITED_DUP"));
  // 재발급한 만큼 summary에 센다: 객체 id 2, instId 1(5의 둘째), 문단 id 1
  assert.ok((on.plan.summary["reissuedIds"] ?? 0) > (off.plan.summary["reissuedIds"] ?? 0));
});

test("3. reissueInternalDuplicates: 같은 id의 누름틀 둘은 시작과 끝이 각자 짝을 맺은 채 새 id를 받는다", () => {
  const field = (id: string, name: string): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="1"/></hp:ctrl>` +
    `<hp:t>값${name}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
  const src = parseSynthetic([para("1", field("570", "a") + field("570", "b"))]);
  const tgt = parseSynthetic([para("1", "")]);
  const on = importInto(src, tgt, 0, 0, { reissueInternalDuplicates: true });
  assert.deepEqual(on.newErrors, []);
  assert.deepEqual(on.plan.inherited.duplicateIds, []);
  const fields = listFields(on.result);
  assert.deepEqual(fields.map((f) => [f.name, f.valueText, f.shape]), [["a", "값a", "simple"], ["b", "값b", "simple"]]);
  const ids = [...(on.result.sections[0]?.text ?? "").matchAll(/<hp:fieldBegin id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids[0], "570", "첫 등장은 그대로");
  // 겹쳐 열린 같은 id: 안쪽 시작이 먼저 닫히는 짝으로 맺는다
  const nested =
    '<hp:ctrl><hp:fieldBegin id="580" type="CLICK_HERE" name="outer" fieldid="1"/></hp:ctrl>' +
    '<hp:ctrl><hp:fieldBegin id="580" type="CLICK_HERE" name="inner" fieldid="2"/></hp:ctrl><hp:t>값</hp:t>' +
    '<hp:ctrl><hp:fieldEnd beginIDRef="580" fieldid="2"/></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="580" fieldid="1"/></hp:ctrl>';
  const n = importInto(parseSynthetic([para("1", nested)]), tgt, 0, 0, { reissueInternalDuplicates: true });
  assert.deepEqual(n.newErrors, []);
});

test("3. 대조: 옵션을 켜도 겹치지 않는 조각은 바이트까지 같은 계획이다", () => {
  const src = parseSynthetic([para("11", '<hp:rect id="2" instId="5"/>', "a") + para("12", '<hp:rect id="3" instId="6"/>', "b")]);
  const tgt = parseSynthetic([para("1", '<hp:rect id="100"/>')]);
  const a = importInto(src, tgt);
  const b = importInto(src, tgt, 0, 1, { reissueInternalDuplicates: true });
  assert.deepEqual(a.plan.edits, b.plan.edits);
  assert.deepEqual(a.plan.inherited, b.plan.inherited);
});

// ── 4. 빈 이진 참조 ────────────────────────────────────────────────────

test("4. binaryItemIDRef=\"\"는 참조 없음이다: FRAG_DANGLING_SOURCE도 inherited.danglingRefs도 없다", () => {
  const body = para("1", '<hp:pic id="9"><hc:img binaryItemIDRef=""/></hp:pic>');
  const src = parseSynthetic([sectionXml(body, ` xmlns:hc="${NS_HC}"`)], MINIMAL_HEADER, true);
  const f: Fragment = extractFragment(src, sel(0, 0));
  assert.deepEqual(f.issues.filter((i) => i.code === "FRAG_DANGLING_SOURCE"), []);
  assert.deepEqual(f.binaries, []);
  assert.deepEqual(f.refs.filter((r) => r.kind === "binaryItem"), []);
  const tgt = parseSynthetic([para("1", "")]);
  const plan = planImport(tgt, f, endOf(tgt)) as ImportPlan;
  assert.deepEqual(plan.inherited.danglingRefs, []);
  assert.deepEqual(plan.issues.filter((i) => i.code === "FRAG_DANGLING_SOURCE"), []);
  // 대조: manifest에 없는 비어 있지 않은 id는 지금처럼 경고와 기록이 남는다
  const nope = parseSynthetic([sectionXml(para("1", '<hp:pic id="9"><hc:img binaryItemIDRef="nope"/></hp:pic>'), ` xmlns:hc="${NS_HC}"`)], MINIMAL_HEADER, true);
  const g = extractFragment(nope, sel(0, 0));
  assert.ok(g.issues.some((i) => i.code === "FRAG_DANGLING_SOURCE"));
  assert.deepEqual((planImport(tgt, g, endOf(tgt)) as ImportPlan).inherited.danglingRefs, [{ kind: "binaryItem", id: "nope", count: 1 }]);
  // 검사기는 빈 값을 오류가 아니라 경고(RES_EMPTY_REF)로 낸다
  const report = validateDocument(src.pkg.bytes);
  assert.ok(report.warnings.some((w) => w.code === "RES_EMPTY_REF"));
  assert.ok(!report.errors.some((e) => e.code === "RES_DANGLING"));
});

// ── 5. 셀 안 삽입 경고 ─────────────────────────────────────────────────

/** 표 하나를 가진 합성 대상. 표 속성은 인자로 바꾼다. */
function tableDoc(tbl: { treatAsChar: string; pageBreak: string }): HwpxDocument {
  const cell = '<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER"><hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>c</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>';
  const table =
    `<hp:tbl id="50" pageBreak="${tbl.pageBreak}" rowCnt="1" colCnt="1" borderFillIDRef="1"><hp:sz width="100" height="100"/><hp:pos treatAsChar="${tbl.treatAsChar}"/><hp:tr>${cell}</hp:tr></hp:tbl>`;
  return parseSynthetic([para("1", table, "")]);
}
const cellPoint: InsertPoint = { sectionIndex: 0, parentPath: [0, 0], index: 0, position: "after" };
const clip = (doc: HwpxDocument, at: InsertPoint): boolean => {
  const src = parseSynthetic([para("9", "", "새 글")]);
  return planImport(doc, extractFragment(src, sel(0, 0)), at).issues.some((i) => i.code === "FRAG_CELL_MAY_CLIP");
};

test("5. 셀 안 삽입: 표가 글자처럼 취급(treatAsChar=1)이거나 쪽 나눔이 없거나(pageBreak=NONE) 표 단위로만 나뉘면(pageBreak=TABLE) FRAG_CELL_MAY_CLIP 경고를 낸다", () => {
  assert.equal(clip(tableDoc({ treatAsChar: "1", pageBreak: "CELL" }), cellPoint), true, "글자처럼 취급");
  assert.equal(clip(tableDoc({ treatAsChar: "0", pageBreak: "NONE" }), cellPoint), true, "쪽 나눔 없음");
  assert.equal(clip(tableDoc({ treatAsChar: "1", pageBreak: "NONE" }), cellPoint), true, "둘 다");
  // 표 단위 나눔: 표는 행 경계에서 나뉘어도 셀 안에서는 나뉘지 않아 한 셀이 쪽보다 길면 잘린다(한컴 PDF로 관측, table-com.test.ts)
  assert.equal(clip(tableDoc({ treatAsChar: "0", pageBreak: "TABLE" }), cellPoint), true, "표 단위 나눔");
  const tablePlan = planImport(tableDoc({ treatAsChar: "0", pageBreak: "TABLE" }), extractFragment(parseSynthetic([para("9", "", "새 글")]), sel(0, 0)), cellPoint);
  assert.match(tablePlan.issues.find((i) => i.code === "FRAG_CELL_MAY_CLIP")?.message ?? "", /pageBreak="TABLE"/);
  // 대조군: 글자처럼 취급도 아니고 셀 단위 쪽 나눔이면 경고가 없다. 구역 최상위 삽입도 없다
  assert.equal(clip(tableDoc({ treatAsChar: "0", pageBreak: "CELL" }), cellPoint), false);
  const top = tableDoc({ treatAsChar: "1", pageBreak: "NONE" });
  assert.equal(clip(top, { sectionIndex: 0, parentPath: [], index: 0, position: "after" }), false, "최상위 삽입은 경고하지 않는다");
  // 경고는 동작을 바꾸지 않는다: 같은 계획이 그대로 적용된다
  const doc = tableDoc({ treatAsChar: "1", pageBreak: "CELL" });
  const src = parseSynthetic([para("9", "", "새 글")]);
  const plan = planImport(doc, extractFragment(src, sel(0, 0)), cellPoint);
  assert.equal(reparse(applyPlan(doc.pkg, plan)).sections[0]?.paragraphs[0]?.subLists[0]?.paragraphs.length, 2);
  assert.equal(plan.issues.find((i) => i.code === "FRAG_CELL_MAY_CLIP")?.severity, "warning");
});
