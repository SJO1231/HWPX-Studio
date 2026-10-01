// 저장 게이트와 상속한 문제(명세 7.8 "캠페인에 따른 수정" 2): 조각이 소스에서부터 갖고 있던 id 중복·없는 참조는
// 대상의 새 오류로 세지 않고 보고서에 "상속"으로 따로 낸다. 설명되지 않는 새 오류는 그대로 막고, strict 방식은 상속 오류도 막는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFragment, serializeFragment, validateDocument, type Fragment, type HwpxDocument } from "../src/index.ts";
import { generate, makeLineAnchor, type GenerateOptions, type GenerateResult } from "../src/fill/index.ts";
import { emptyTemplate, readDataset, readTemplate } from "../src/template/index.ts";
import { parseSynthetic, reparse } from "./helpers.ts";

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
  const r = generate(target().pkg.bytes, emptyTemplate(), readDataset({}));
  assert.ok(r.ok);
  assert.deepEqual(r.report.inherited, { duplicateIds: [], danglingRefs: [], errors: [] });
});
