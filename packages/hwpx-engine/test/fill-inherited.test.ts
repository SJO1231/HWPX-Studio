// 저장 게이트와 상속한 문제(명세 7.8 "캠페인에 따른 수정" 2): 조각이 소스에서부터 갖고 있던 id 중복·없는 참조는
// 대상의 새 오류로 세지 않고 보고서에 "상속"으로 따로 낸다. 설명되지 않는 새 오류는 그대로 막고, strict 방식은 상속 오류도 막는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFragment, selectTable, serializeFragment, validateDocument, type Fragment, type HwpxDocument, type InheritedProblems, type ValidationIssue } from "../src/index.ts";
import { explainInherited, generate, makeLineAnchor, noInherited, splitTolerated, type GenerateOptions, type GenerateResult } from "../src/fill/index.ts";
import { emptyTemplate, readDataset, readTemplate } from "../src/template/index.ts";
import { duplicates, loadDoc, mutateEntryText, objectIdsIn, parseSynthetic, readFixture, reparse } from "./helpers.ts";

const para = (id: string, inner: string, text = "x"): string =>
  `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}<hp:t>${text}</hp:t></hp:run></hp:p>`;

/** 대상 문서(합성 최소 문서)의 마지막 문단 뒤에 조각(JSON 객체)을 주입한다. */
function inject(target: HwpxDocument, fragment: unknown, options: GenerateOptions = {}): GenerateResult {
  const last = (target.sections[0]?.paragraphs.length ?? 1) - 1;
  const anchor = makeLineAnchor(target, "a", 0, [last]);
  assert.ok(anchor !== undefined);
  const template = readTemplate({
    schema: "hwpx-studio/template@1",
    anchors: [anchor],
    rules: [{ id: "r", do: { type: "inject", anchor: "a", position: "after", fragment } }],
  });
  return generate(target.pkg.bytes, template, readDataset({}), { missing: "keep", ...options });
}

const fragmentOf = (src: HwpxDocument, from = 0, to = (src.sections[0]?.paragraphs.length ?? 1) - 1): Fragment =>
  extractFragment(src, { sectionIndex: 0, parentPath: [], from, to });
const asJson = (f: Fragment): Record<string, unknown> => JSON.parse(serializeFragment(f)) as Record<string, unknown>;
const target = (): HwpxDocument => parseSynthetic([para("1", '<hp:rect id="100"/>')]);

/** 소스가 이미 갖고 있던 겹침: 같은 id의 도형 둘이 든 문단(tools/stress/repro.ts의 D1과 같은 모양) */
const DUP_SRC = (): HwpxDocument => parseSynthetic([para("1", '<hp:rect id="2"/><hp:rect id="2"/>')]);

const errorCodes = (r: GenerateResult): string[] => r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);

test("게이트: 같은 id의 도형 둘이 든 문단을 주입하면 통과하고, 그 오류는 새 오류가 아니라 상속으로 보고한다", () => {
  const r = inject(target(), asJson(fragmentOf(DUP_SRC())));
  assert.equal(r.ok, true, `막혔다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  assert.deepEqual(r.report.validation?.newErrors, [], "새 오류로 세지 않는다");
  assert.deepEqual(r.report.inherited.duplicateIds, [{ role: "object", value: "2", count: 2 }]);
  assert.deepEqual(r.report.inherited.danglingRefs, []);
  assert.deepEqual(r.report.inherited.errors.map((e) => e.code), ["INST_DUP_ID"]);
  assert.ok(r.report.inherited.errors[0]?.message.includes("'2'"));
  // 경고로 따로 나온다: 계획의 FRAG_INHERITED_DUP, 게이트의 GATE_INHERITED
  const warn = r.report.issues.filter((i) => i.severity === "warning").map((i) => i.code);
  assert.ok(warn.includes("FRAG_INHERITED_DUP") && warn.includes("GATE_INHERITED"), warn.join());
  // 출력은 소스 원문 그대로다(도형 id는 바꾸지 않는다)
  assert.ok(r.ok && !r.dryRun);
  if (r.ok && !r.dryRun) assert.equal([...(reparse(r.output).sections[0]?.text ?? "").matchAll(/<hp:rect id="2"\/>/g)].length, 2);
});

test("게이트: 문단 id·누름틀 id 중복과 소스에서 없던 참조도 상속으로 설명된다", () => {
  const field = (id: string, name: string): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="1"/></hp:ctrl>` +
    `<hp:t>값</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
  const src = parseSynthetic([para("7", field("570", "a") + field("570", "b"), "a") + para("7", "", "b") + '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="9"><hp:t>끊김</hp:t></hp:run></hp:p>']);
  const r = inject(target(), asJson(fragmentOf(src)));
  assert.equal(r.ok, true, JSON.stringify(r.report.issues.filter((i) => i.severity === "error")));
  assert.deepEqual(r.report.validation?.newErrors, []);
  assert.deepEqual(r.report.inherited.duplicateIds.map((d) => `${d.role}:${d.value}x${d.count}`).sort(), ["fieldBegin:570x2", "paragraph:7x2"]);
  assert.deepEqual(r.report.inherited.danglingRefs, [{ kind: "charPr", id: "9", count: 1 }]);
  assert.deepEqual([...new Set(r.report.inherited.errors.map((e) => e.code))].sort(), ["FIELD_MULTI_END", "INST_DUP_ID", "RES_DANGLING"]);
});

test("게이트: strict 방식은 상속한 오류도 막는다", () => {
  const r = inject(target(), asJson(fragmentOf(DUP_SRC())), { mode: "strict" });
  assert.equal(r.ok, false);
  assert.ok(errorCodes(r).includes("GATE_ERRORS") && errorCodes(r).includes("INST_DUP_ID"), errorCodes(r).join());
  assert.deepEqual(r.report.inherited.errors, [], "strict는 상속으로 가리지 않는다");
});

test("게이트: reissueInternalDuplicates를 켜면 조각 안 중복 id를 새 값으로 바꿔 상속한 중복이 없다(기본은 끔)", () => {
  const frag = asJson(fragmentOf(DUP_SRC()));
  const off = inject(target(), frag);
  assert.ok(off.ok);
  assert.deepEqual(off.report.inherited.duplicateIds, [{ role: "object", value: "2", count: 2 }], "기본은 소스 원문 그대로");

  const on = inject(target(), frag, { reissueInternalDuplicates: true });
  assert.equal(on.ok, true, JSON.stringify(on.report.issues.filter((i) => i.severity === "error")));
  assert.deepEqual(on.report.inherited, { duplicateIds: [], danglingRefs: [], errors: [] });
  assert.deepEqual(on.report.validation?.newErrors, []);
  const codes = on.report.issues.map((i) => i.code);
  assert.ok(!codes.includes("FRAG_INHERITED_DUP") && !codes.includes("GATE_INHERITED"), codes.join());
  assert.ok(on.ok && !on.dryRun);
  if (on.ok && !on.dryRun) {
    const ids = objectIdsIn(reparse(on.output).sections[0]?.text ?? "");
    assert.equal(ids.length, 3, "대상의 도형 1개와 조각의 도형 2개");
    assert.deepEqual(duplicates(ids), [], "겹치는 id가 없다");
    assert.deepEqual(ids.slice(0, 2), ["100", "2"], "첫 등장은 그대로 둔다");
    assert.deepEqual(validateDocument(on.output).errors, [], "엄격 검사 기준으로도 오류가 없다");
  }
  // 엄격 방식은 상속한 오류를 막지만, 재발급하면 통과한다
  assert.equal(inject(target(), frag, { mode: "strict" }).ok, false);
  assert.equal(inject(target(), frag, { mode: "strict", reissueInternalDuplicates: true }).ok, true);
});

test("게이트 대조군: 상속과 무관한 새 오류(짝 없는 누름틀)는 상속 오류가 함께 있어도 막힌다", () => {
  const f = asJson(fragmentOf(DUP_SRC())) as { xml: string };
  f.xml = f.xml.replace(/<\/hp:p>$/, '<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="9" type="CLICK_HERE" name="x" fieldid="1"/></hp:ctrl></hp:run></hp:p>');
  const r = inject(target(), f);
  assert.equal(r.ok, false);
  const codes = errorCodes(r);
  assert.ok(codes.includes("FIELD_UNPAIRED_BEGIN") && codes.includes("GATE_NEW_ERRORS"), codes.join());
  assert.deepEqual(r.report.validation?.newErrors.map((e) => e.code), ["FIELD_UNPAIRED_BEGIN"], "상속으로 설명되는 INST_DUP_ID는 새 오류에 없다");
  assert.deepEqual(r.report.inherited.errors.map((e) => e.code), ["INST_DUP_ID"]);
});

test("게이트 대조군: 조각의 기록이 없으면(이전 형식 조각) 같은 오류도 설명되지 않아 지금처럼 막힌다", () => {
  const f = asJson(fragmentOf(DUP_SRC())) as { instanceIds: { role: string; value: string }[] };
  f.instanceIds = f.instanceIds.filter((x) => x.role !== "object");
  const dup = inject(target(), f);
  assert.equal(dup.ok, false);
  assert.ok(errorCodes(dup).includes("GATE_NEW_ERRORS") && errorCodes(dup).includes("INST_DUP_ID"), errorCodes(dup).join());

  const src = parseSynthetic(['<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="9"><hp:t>끊김</hp:t></hp:run></hp:p>']);
  const g = asJson(fragmentOf(src)) as { dangling?: unknown };
  assert.equal(inject(target(), g).ok, true, "기록이 있으면 통과");
  delete g.dangling;
  const dangling = inject(target(), g);
  assert.equal(dangling.ok, false);
  assert.ok(errorCodes(dangling).includes("RES_DANGLING"), errorCodes(dangling).join());
});

test("게이트 대조군: 상속 기록에 없는 값의 id 중복은 같은 코드라도 설명되지 않는다(코드와 id 값을 함께 맞춘다)", () => {
  const src = parseSynthetic([para("1", '<hp:rect id="2"/><hp:rect id="2"/><hp:rect id="3"/><hp:rect id="3"/>')]);
  const f = asJson(fragmentOf(src)) as { instanceIds: { role: string; value: string }[] };
  assert.equal(inject(target(), JSON.parse(JSON.stringify(f))).ok, true, "둘 다 기록돼 있으면 통과");
  f.instanceIds = f.instanceIds.filter((x) => !(x.role === "object" && x.value === "3"));
  const r = inject(target(), f);
  assert.equal(r.ok, false);
  assert.deepEqual(r.report.validation?.newErrors.map((e) => e.message), ["object id (표·도형) 중복: '3' x2"]);
  assert.deepEqual(r.report.inherited.errors.map((e) => e.message), ["object id (표·도형) 중복: '2' x2"]);
});

test("게이트: 같은 입력이면 같은 출력과 같은 보고서다(결정성)", () => {
  const a = inject(target(), asJson(fragmentOf(DUP_SRC())));
  const b = inject(target(), asJson(fragmentOf(DUP_SRC())));
  assert.ok(a.ok && b.ok && !a.dryRun && !b.dryRun);
  assert.equal(JSON.stringify(a.report), JSON.stringify(b.report));
  if (a.ok && b.ok && !a.dryRun && !b.dryRun) assert.deepEqual(validateDocument(a.output).errors.map((e) => e.code), ["INST_DUP_ID"]);
});

test("게이트: 조각이 없는 문서(주입 없음)의 보고서 inherited는 비어 있다", () => {
  // 채울 것이 없으면 FILL_NOTHING_APPLIED로 실패하지만 보고서는 남고 상속 항목은 비어 있다
  const r = generate(target().pkg.bytes, emptyTemplate(), readDataset({}));
  assert.ok(!r.ok && r.report.issues.some((i) => i.code === "FILL_NOTHING_APPLIED"));
  assert.deepEqual(r.report.inherited, { duplicateIds: [], danglingRefs: [], errors: [] });
});

// ── 상속으로 설명하는 양은 조각이 기록한 개수를 넘지 못한다 ───────────────────────────────────────────
// 같은 (코드, id)의 오류가 기록된 개수보다 많이 늘면, 넘는 만큼은 새 오류다(다른 규칙이 만든 같은 오류가 가려지지 않는다).

/** 대상 hancom/ph-single: 문단 1의 첫 run `charPrIDRef`를 없는 id 77로 바꾼다(원래 오류 RES_DANGLING 1건) */
function danglingTarget(): Uint8Array {
  const doc = loadDoc("hancom/ph-single");
  const attr = doc.sections[0]?.paragraphs[1]?.runs[0]?.element.attrs.find((a) => a.qname === "charPrIDRef");
  assert.ok(attr !== undefined);
  return mutateEntryText(readFixture("hancom/ph-single"), "Contents/section0.xml", (t) => t.slice(0, attr.valueStart) + "77" + t.slice(attr.valueEnd));
}

/** 소스 D5의 최상위 문단 4의 첫 run `charPrIDRef`를 77로 바꾼 뒤 그 문단을 조각으로 뽑는다(조각의 없는 참조 기록 1건) */
function danglingFragment(): Record<string, unknown> {
  const d5 = loadDoc("D5");
  const attr = d5.sections[0]?.paragraphs[4]?.runs[0]?.element.attrs.find((a) => a.qname === "charPrIDRef");
  assert.ok(attr !== undefined);
  const changed = reparse(mutateEntryText(readFixture("D5"), "Contents/section0.xml", (t) => t.slice(0, attr.valueStart) + "77" + t.slice(attr.valueEnd)));
  const f = extractFragment(changed, { sectionIndex: 0, parentPath: [], from: 4, to: 4 });
  assert.deepEqual(f.dangling, [{ kind: "charPr", id: "77", count: 1 }]);
  return asJson(f);
}

/** r1: 문단 1 뒤에 insertText(style inherit — 없는 77을 물려받는다), r2: 마지막 문단 뒤에 조각 주입 */
function twoRules(bytes: Uint8Array, rules: ("r1" | "r2")[]): GenerateResult {
  const doc = reparse(bytes);
  const a1 = makeLineAnchor(doc, "a1", 0, [1]);
  const a2 = makeLineAnchor(doc, "a2", 0, [(doc.sections[0]?.paragraphs.length ?? 1) - 1]);
  assert.ok(a1 !== undefined && a2 !== undefined);
  const all = {
    r1: { id: "r1", do: { type: "insertText", anchor: "a1", position: "after", value: { text: "새 문단" }, style: "inherit" } },
    r2: { id: "r2", do: { type: "inject", anchor: "a2", position: "after", fragment: danglingFragment() } },
  };
  const template = readTemplate({ schema: "hwpx-studio/template@1", anchors: [a1, a2], rules: rules.map((r) => all[r]) });
  return generate(bytes, template, readDataset({}), { missing: "keep" });
}

const danglingErrors = (issues: readonly { code: string; count?: number }[]): number =>
  issues.filter((e) => e.code === "RES_DANGLING").reduce((n, e) => n + (e.count ?? 1), 0);

test("게이트: r1(insertText inherit)이 만든 없는 참조 오류는 r2(조각 주입)의 상속 기록 1건에 가려지지 않아 막힌다", () => {
  const bytes = danglingTarget();
  assert.equal(validateDocument(bytes).errors.filter((e) => e.code === "RES_DANGLING").length, 1, "원래 오류 1건");

  // 대조군 1: r1만 — 새 오류 1건이라 막힌다(상속 기록 없음)
  const only1 = twoRules(bytes, ["r1"]);
  assert.equal(only1.ok, false);
  assert.ok(errorCodes(only1).includes("GATE_NEW_ERRORS"), errorCodes(only1).join());
  assert.equal(danglingErrors(only1.report.validation?.newErrors ?? []), 1);

  // 대조군 2: r2만 — 조각이 가져온 없는 참조 1건을 상속 기록 1건이 설명해 통과한다
  const only2 = twoRules(bytes, ["r2"]);
  assert.equal(only2.ok, true, JSON.stringify(only2.report.issues.filter((i) => i.severity === "error")));
  assert.deepEqual(only2.report.inherited.danglingRefs, [{ kind: "charPr", id: "77", count: 1 }]);
  assert.equal(danglingErrors(only2.report.inherited.errors), 1);
  assert.deepEqual(only2.report.validation?.newErrors, []);

  // r1 + r2: 새 오류 2건(r1 1건 + 조각 1건) 중 기록이 설명하는 것은 1건뿐이다. 나머지 1건은 새 오류로 막는다.
  const both = twoRules(bytes, ["r1", "r2"]);
  assert.equal(both.ok, false, "r1이 만든 오류까지 상속으로 설명돼 통과해 버렸다");
  assert.ok(errorCodes(both).includes("GATE_NEW_ERRORS"), errorCodes(both).join());
  assert.equal(danglingErrors(both.report.validation?.newErrors ?? []), 1, "설명되지 않은 1건");
  assert.equal(danglingErrors(both.report.inherited.errors), 1, "설명된 1건(기록의 개수 이하)");
});

// 검사기의 새 오류(메시지·개수는 검사기가 내는 모양 그대로)
const dangling = (value: string, count: number, where = "Contents/section0.xml <run>"): ValidationIssue => ({
  severity: "error",
  code: "RES_DANGLING",
  message: `charPrIDRef='${value}' 가 가리키는 charPr 가 없음`,
  where,
  count,
});
const dupId = (value: string, n: number): ValidationIssue => ({
  severity: "error",
  code: "INST_DUP_ID",
  message: `object id (표·도형) 중복: '${value}' x${n}`,
  where: "Contents/section0.xml <rect>",
  count: 1,
});
const rec = (over: Partial<InheritedProblems>): InheritedProblems => ({ ...noInherited(), ...over });

test("explainInherited: 없는 참조는 (종류, id)별 발생 횟수가 기록의 개수 이하일 때만 그만큼 설명하고, 넘는 부분은 설명하지 않는다", () => {
  const inherited = rec({ danglingRefs: [{ kind: "charPr", id: "77", count: 2 }] });
  // 2건 이하는 전부 설명
  let r = explainInherited([dangling("77", 2)], inherited);
  assert.deepEqual(r.explained.map((e) => e.count), [2]);
  assert.deepEqual(r.unexplained, []);
  // 3건: 2건만 설명하고 1건은 설명하지 않는다(한 오류의 개수를 쪼갠다)
  r = explainInherited([dangling("77", 3)], inherited);
  assert.deepEqual(r.explained.map((e) => e.count), [2]);
  assert.deepEqual(r.unexplained.map((e) => [e.code, e.count]), [["RES_DANGLING", 1]]);
  // 위치가 다른 같은 (종류, id) 오류들이 한 예산을 나눠 쓴다
  r = explainInherited([dangling("77", 1, "a <run>"), dangling("77", 1, "b <style>"), dangling("77", 1, "c <p>")], inherited);
  assert.equal(r.explained.reduce((n, e) => n + e.count, 0), 2);
  assert.equal(r.unexplained.reduce((n, e) => n + e.count, 0), 1);
  // 기록에 없는 id나 종류는 설명하지 않는다(예산 0)
  r = explainInherited([dangling("78", 1)], inherited);
  assert.deepEqual(r.explained, []);
  assert.equal(r.unexplained.length, 1);
});

test("explainInherited: id 중복은 메시지의 xN(그 id가 나온 횟수)에서 원래 문서의 횟수를 뺀 증가분이 기록의 개수 이하일 때만 설명한다", () => {
  const inherited = rec({ duplicateIds: [{ role: "object", value: "2", count: 2 }] });
  assert.deepEqual(explainInherited([dupId("2", 2)], inherited).unexplained, []);
  // 조각 밖의 다른 곳에서 같은 id가 하나 더 생겨 x3이 되면 증가분 3이 기록(2)을 넘어 설명하지 않는다
  const over = explainInherited([dupId("2", 3)], inherited);
  assert.deepEqual(over.explained, []);
  assert.equal(over.unexplained.length, 1);
  // 원래 문서에 이미 x2가 있었고 지금 x4면 증가분은 2라 설명한다
  const baseline = [{ ...dupId("2", 2), where: "Contents/section0.xml <tbl>" }];
  assert.deepEqual(explainInherited([dupId("2", 4)], inherited, baseline).unexplained, []);
  assert.equal(explainInherited([dupId("2", 5)], inherited, baseline).unexplained.length, 1);
});

// ── 기준선에서 관용 경고였던 같은 참조는 "원래 있던 문제"다 ────────────────────────────────────────────
// 엔진 검사기는 "탭 목록이 비었는데 tabPrIDRef=0"을 경고(RES_DANGLING_TOLERATED)로 두는데, 목록에 항목이 생기면 같은 참조가 오류(RES_DANGLING)로 올라간다.
// 새 탭이 없는 tabPr 0을 건너뛰어 목록이 차므로(명세 7.5), 그 오류는 가져오기가 만든 새 오류가 아니라 원래 있던 문제다.

test("게이트: D5의 표를 D1에 가져오면(tabPr 0을 건너뛰어 탭 목록이 차서 같은 참조가 오류로 올라가도) 통과한다", () => {
  const d1 = loadDoc("D1");
  const d5 = loadDoc("D5");
  const f = extractFragment(d5, selectTable(d5, 0, 4).selection);
  const before = validateDocument(d1.pkg.bytes);
  assert.ok(before.warnings.some((w) => w.code === "RES_DANGLING_TOLERATED" && w.message.startsWith("tabPrIDRef='0'")), "전제: 기준선에서는 관용 경고");
  assert.equal(before.errors.filter((e) => e.code === "RES_DANGLING").length, 0);

  const r = inject(d1, asJson(f));
  assert.equal(r.ok, true, JSON.stringify(r.report.issues.filter((i) => i.severity === "error")));
  assert.ok(r.ok && !r.dryRun);
  if (!(r.ok && !r.dryRun)) return;
  const out = reparse(r.output);
  // 새 탭은 0이 아닌 id를 받고, D1 기존 문단모양의 tabPrIDRef="0"은 여전히 없는 대상을 가리킨다
  const tabIds = (out.header.resources["tabPr"] ?? []).map((t) => t.id);
  assert.ok(tabIds.length > 0 && !tabIds.includes("0"), tabIds.join());
  assert.ok(out.issues.some((i) => i.code === "MODEL_REF_MISSING" && i.message.startsWith("tabPr 0이(가) 없는데 8곳")));
  // 엔진 검사기는 이제 그 참조를 오류로 올린다(목록이 비어 있지 않으므로). 게이트는 그것을 새 오류로 세지 않는다
  const after = validateDocument(r.output);
  assert.ok(after.errors.some((e) => e.code === "RES_DANGLING" && e.message.startsWith("tabPrIDRef='0'")), "목록이 차서 오류로 올라간다");
  assert.deepEqual(r.report.validation?.newErrors, []);
  assert.deepEqual(r.report.inherited.errors, [], "조각이 소스에서 갖고 있던 문제가 아니다");
  const note = r.report.issues.filter((i) => i.severity === "warning" && i.message.includes("tabPrIDRef='0'"));
  assert.ok(note.length > 0, "원래 있던 문제로 경고에 남는다");
  // strict 방식은 이것을 가리지 않는다(오류 0을 요구한다)
  assert.equal(inject(d1, asJson(f), { mode: "strict" }).ok, false);
});

const toleratedWarning = (count: number, value = "0"): ValidationIssue => ({
  severity: "warning",
  code: "RES_DANGLING_TOLERATED",
  message: `tabPrIDRef='${value}' 인데 tabProperties 가 비어 있음(한컴 실측: 열림)`,
  where: "Contents/header.xml <paraPr>",
  count,
});
const tabError = (count: number, value = "0", space = "tabPr"): ValidationIssue => ({
  severity: "error",
  code: "RES_DANGLING",
  message: `tabPrIDRef='${value}' 가 가리키는 ${space} 가 없음`,
  where: "Contents/header.xml <paraPr>",
  count,
});

test("splitTolerated: 기준선의 관용 경고와 같은 (종류, id)의 오류만, 경고의 개수까지 원래 있던 문제로 센다", () => {
  const warning = toleratedWarning(8);
  // 같은 (tabPr, 0) 8건: 전부 원래 있던 문제
  let r = splitTolerated([tabError(8)], [warning]);
  assert.deepEqual(r.original.map((e) => e.count), [8]);
  assert.deepEqual(r.rest, []);
  // 9건이면 8건까지만, 1건은 새 오류
  r = splitTolerated([tabError(9)], [warning]);
  assert.deepEqual(r.original.map((e) => e.count), [8]);
  assert.deepEqual(r.rest.map((e) => e.count), [1]);
  // 기준선에 관용 경고가 없으면 전부 새 오류
  r = splitTolerated([tabError(1)], []);
  assert.deepEqual(r.original, []);
  assert.equal(r.rest.length, 1);
  // 다른 id나 다른 종류, 다른 코드는 가리지 않는다
  assert.equal(splitTolerated([tabError(1, "3")], [warning]).rest.length, 1);
  assert.equal(splitTolerated([tabError(1, "0", "numbering")], [warning]).rest.length, 1);
  const dup: ValidationIssue = { severity: "error", code: "INST_DUP_ID", message: "object id (표·도형) 중복: '0' x2", count: 1 };
  assert.deepEqual(splitTolerated([dup], [warning]).rest, [dup]);
});
