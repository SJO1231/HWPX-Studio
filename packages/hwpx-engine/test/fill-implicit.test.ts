// 암묵 채움(누름틀)과 FILL_NOTHING_APPLIED. 기대값은 코디네이터 결정(2026-10-03)에서 만들었다:
//  - 템플릿이 없거나 템플릿에 그 누름틀을 가리키는 규칙이 없으면, 이름이 데이터 경로 문법에 맞는 누름틀은 이름을 경로로 채운다
//    (`{{}}`의 암묵 규칙과 같은 자리·누락 정책·보고). 같은 이름 누름틀은 전부 같은 값. 규칙이 가리키는 누름틀은 그 규칙이 맡는다.
//  - 이름이 경로가 아닌 누름틀은 건너뜀 FIELD_NAME_NOT_PATH로 보고하고 그대로 둔다.
//  - 적용된 액션이 0이면 generate는 ok:false, FILL_NOTHING_APPLIED(건너뜀 사유 포함, 출력 없음).
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileDocument, generateBatch, listFields, makeLineAnchor, validateDocument, type HwpxDocument } from "../src/index.ts";
import { generate, type GenerateResult } from "../src/fill/index.ts";
import { emptyTemplate, readDataset, readTemplate, type BatchRecord } from "../src/template/index.ts";
import { buildHwpx, mutateEntryText, newErrorsAfter, readFixture, reparse } from "./helpers.ts";

const SEC = "Contents/section0.xml";
type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;
const done = (r: GenerateResult): Done => {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  assert.ok(!r.dryRun);
  return r as Done;
};
const failed = (r: GenerateResult): string[] => {
  assert.equal(r.ok, false, "생성이 성공해 버렸다");
  assert.ok(!("output" in r), "실패인데 출력이 있다");
  return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
};
const tpl = (spec: { anchors?: unknown[]; rules?: unknown[] }) => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const ds = (data: unknown) => readDataset(data);
const values = (doc: HwpxDocument): [string, string, string][] => listFields(doc).map((f) => [f.name, f.valueText, f.dirty]);
const FIELDS = readFixture("hancom/field-states"); // 성명(안내문 상태) · 소속(값 합성기관, dirty=1) · 성명(안내문 상태)

// ── 누름틀 암묵 채움 ───────────────────────────────────────────

test("암묵 채움: 템플릿 없이 누름틀을 이름 = 데이터 경로로 채운다(같은 이름은 전부 같은 값, dirty=1, 값 재읽기·검사기·결정성)", () => {
  const data = ds({ 성명: "홍길동", 소속: "새 기관" });
  const r = done(generate(FIELDS, emptyTemplate(), data));
  assert.deepEqual(values(reparse(r.output)), [["성명", "홍길동", "1"], ["소속", "새 기관", "1"], ["성명", "홍길동", "1"]]);
  assert.equal(r.report.reread.fields, 3, "채운 누름틀 3개를 다시 읽었다");
  assert.deepEqual(r.report.plan.requiredPaths, ["성명", "소속"]);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.type, a.anchor, a.targets]), [["implicit", "fill", "field:성명", 2], ["implicit", "fill", "field:소속", 1]]);
  assert.deepEqual(newErrorsAfter(validateDocument(FIELDS), validateDocument(r.output)), []);
  assert.ok(Buffer.from(done(generate(FIELDS, emptyTemplate(), data)).output).equals(Buffer.from(r.output)), "같은 입력은 같은 바이트");
  // 명시한 규칙으로 채운 결과와 같은 바이트다(같은 값·같은 방식)
  const explicit = tpl({
    anchors: [{ id: "a", kind: "field", name: "성명" }, { id: "b", kind: "field", name: "소속" }],
    rules: [{ id: "r1", do: { type: "fill", anchor: "a", value: { path: "성명" } } }, { id: "r2", do: { type: "fill", anchor: "b", value: { path: "소속" } } }],
  });
  assert.ok(Buffer.from(done(generate(FIELDS, explicit, data)).output).equals(Buffer.from(r.output)), "명시 규칙과 같은 결과");
  // 값에 보고서·원장의 원문이 없다
  assert.ok(!JSON.stringify({ report: r.report, ledger: r.ledger }).includes("홍길동"));
});

test("암묵 채움: 값의 줄바꿈·탭·CRLF도 요소로 들어간다", () => {
  const r = done(generate(FIELDS, emptyTemplate(), ds({ 성명: "첫 줄\r\n둘째 줄", 소속: "가\t나" })));
  assert.deepEqual(values(reparse(r.output)).map((v) => v[1]), ["첫 줄\n둘째 줄", "가\t나", "첫 줄\n둘째 줄"]);
});

test("암묵 채움: 누락 정책 — error는 DATA_MISSING(채우지 못한 이름마다 하나), empty는 빈 글, keep은 그대로", () => {
  const partial = ds({ 성명: "홍" });
  assert.deepEqual(failed(generate(FIELDS, emptyTemplate(), partial)), ["DATA_MISSING"]);
  const r = generate(FIELDS, emptyTemplate(), ds({}));
  assert.deepEqual(failed(r), ["DATA_MISSING", "DATA_MISSING"]);
  assert.match(r.report.issues[0]?.message ?? "", /^누름틀 성명: 데이터에 성명 값이 없습니다/);
  assert.deepEqual(r.report.plan.missingPaths, ["성명", "소속"]);

  const empty = done(generate(FIELDS, emptyTemplate(), partial, { missing: "empty" }));
  assert.deepEqual(values(reparse(empty.output)), [["성명", "홍", "1"], ["소속", "", "1"], ["성명", "홍", "1"]]);
  assert.deepEqual(empty.report.plan.missingPaths, ["소속"]);

  const keep = done(generate(FIELDS, emptyTemplate(), partial, { missing: "keep" }));
  assert.deepEqual(values(reparse(keep.output)), [["성명", "홍", "1"], ["소속", "합성기관", "1"], ["성명", "홍", "1"]]);
  assert.deepEqual(keep.report.plan.kept, [{ path: "소속", count: 1 }]);
});

test("암묵 채움: 객체·배열 값은 DATA_NOT_SCALAR, 제어 문자는 VALUE_CONTROL_CHAR", () => {
  assert.deepEqual(failed(generate(FIELDS, emptyTemplate(), ds({ 성명: { a: 1 }, 소속: "x" }))), ["DATA_NOT_SCALAR"]);
  assert.deepEqual(failed(generate(FIELDS, emptyTemplate(), ds({ 성명: "a\u0001", 소속: "x" }))), ["VALUE_CONTROL_CHAR"]);
});

test("암묵 채움: 점이 든 경로 이름(applicant.name)과 숫자 값", () => {
  const renamed = mutateEntryText(FIELDS, SEC, (x) => x.replaceAll('name="성명"', 'name="applicant.name"').replace('name="소속"', 'name="n-1_a"'));
  const r = done(generate(renamed, emptyTemplate(), ds({ applicant: { name: "김" }, "n-1_a": 42 })));
  assert.deepEqual(values(reparse(r.output)).map((v) => v[1]), ["김", "42", "김"]);
});

test("암묵 채움: 이름이 데이터 경로가 아닌 누름틀은 FIELD_NAME_NOT_PATH로 건너뛰고 그대로 둔다(오류가 아니다)", () => {
  const renamed = mutateEntryText(FIELDS, SEC, (x) => x.replace('name="성명"', 'name="성 명!"'));
  const r = done(generate(renamed, emptyTemplate(), ds({ 성명: "홍", 소속: "기관" })));
  // 이름이 맞는 둘째 성명과 소속만 채운다. 첫 누름틀은 안내문 상태 그대로
  assert.deepEqual(values(reparse(r.output)), [["성 명!", "이름을 입력", "0"], ["소속", "기관", "1"], ["성명", "홍", "1"]]);
  assert.deepEqual(r.report.plan.skipped.map((s) => [s.ruleId, s.code, s.anchor]), [["implicit", "FIELD_NAME_NOT_PATH", "field:성 명!"]]);
  // 이름이 없는 누름틀도 같다
  const unnamed = mutateEntryText(FIELDS, SEC, (x) => x.replace('name="성명"', 'name=""'));
  assert.deepEqual(done(generate(unnamed, emptyTemplate(), ds({ 성명: "홍", 소속: "기관" }))).report.plan.skipped.map((s) => s.code), ["FIELD_NAME_NOT_PATH"]);
  // 건너뛴 것뿐이면 채운 자리가 없어 실패한다. 사유가 메시지에 든다
  const only = mutateEntryText(readFixture("hancom-field"), SEC, (x) => x.replace('name="성명"', 'name="a b"'));
  const none = generate(only, emptyTemplate(), ds({}));
  assert.deepEqual(failed(none), ["FILL_NOTHING_APPLIED"]);
  assert.match(none.report.issues[0]?.message ?? "", /FIELD_NAME_NOT_PATH 1곳/);
});

test("암묵 채움: 채울 수 없는 모양(object)의 누름틀은 FIELD_UNSUPPORTED_SHAPE로 건너뛴다(오류가 아니다). 줄바꿈 값으로 채운 누름틀(inline)은 다시 채운다", () => {
  const object = mutateEntryText(readFixture("hancom-field"), SEC, (x) =>
    x.replace("<hp:t>홍길동</hp:t>", '<hp:t>홍</hp:t><hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl><hp:t>길동</hp:t>'),
  );
  const r = generate(object, emptyTemplate(), ds({ 성명: "x" }));
  assert.deepEqual(failed(r), ["FILL_NOTHING_APPLIED"]);
  assert.deepEqual(r.report.plan.skipped.map((s) => s.code), ["FIELD_UNSUPPORTED_SHAPE"]);
  // 데이터에 키가 없어도 채울 수 없는 누름틀은 DATA_MISSING을 만들지 않는다
  assert.deepEqual(generate(object, emptyTemplate(), ds({})).report.plan.missingPaths, []);
  // 줄바꿈이 든 값으로 채운 누름틀은 모양이 inline이 된다: 구간 전체를 바꿔 다시 채운다(건너뜀 없음)
  const filled = done(generate(FIELDS, emptyTemplate(), ds({ 성명: "a\nb", 소속: "c" }))).output;
  assert.deepEqual(values(reparse(filled)).map((v) => v[1]), ["a\nb", "c", "a\nb"]);
  const again = generate(filled, emptyTemplate(), ds({ 성명: "x", 소속: "y" }));
  assert.deepEqual(values(reparse(done(again).output)).map((v) => v[1]), ["x", "y", "x"]);
  assert.deepEqual(again.report.plan.skipped, []);
});

test("암묵 채움: 명시 규칙이 가리키는 누름틀은 그 규칙이 맡는다(순번을 준 규칙은 그 순번만). 조건이 거짓인 규칙의 누름틀도 암묵으로 채우지 않는다", () => {
  const data = ds({ 성명: "데이터", 소속: "기관" });
  const all = tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "규칙" } } }] });
  assert.deepEqual(values(reparse(done(generate(FIELDS, all, data)).output)).map((v) => v[1]), ["규칙", "기관", "규칙"]);
  const second = tpl({ anchors: [{ id: "a", kind: "field", name: "성명", occurrence: 1 }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "둘째" } } }] });
  assert.deepEqual(values(reparse(done(generate(FIELDS, second, data)).output)).map((v) => v[1]), ["데이터", "기관", "둘째"]);
  // 조건이 거짓이면 규칙도 암묵도 그 누름틀을 건드리지 않는다
  const idle = tpl({
    anchors: [{ id: "a", kind: "field", name: "성명" }],
    rules: [{ id: "r", when: { path: "x", op: "eq", value: 1 }, do: { type: "fill", anchor: "a", value: { text: "규칙" } } }],
  });
  const r = done(generate(FIELDS, idle, ds({ x: 2, 소속: "기관" })));
  assert.deepEqual(values(reparse(r.output)), [["성명", "이름을 입력", "0"], ["소속", "기관", "1"], ["성명", "이름을 입력", "0"]]);
  assert.deepEqual(r.report.plan.inactiveRules, ["r"]);
  // 규칙 값이 없을 때의 누락 정책은 규칙의 것이다(암묵으로 넘어가지 않는다)
  const missingRule = tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { path: "없는.경로" } } }] });
  assert.deepEqual(failed(generate(FIELDS, missingRule, ds({ 성명: "데이터", 소속: "기관" }))), ["DATA_MISSING"]);
});

test("암묵 채움: 삭제되는 문단 안의 누름틀은 채우지 않고 dropped로 보고한다(DATA_MISSING도 없다)", () => {
  const anchor = makeLineAnchor(reparse(FIELDS), "p", 0, [1]); // 소속 문단
  assert.ok(anchor !== undefined);
  const del = tpl({ anchors: [anchor], rules: [{ id: "d", do: { type: "delete", anchor: "p" } }] });
  const r = done(generate(FIELDS, del, ds({ 성명: "홍" })));
  assert.deepEqual(values(reparse(r.output)), [["성명", "홍", "1"], ["성명", "홍", "1"]]);
  assert.deepEqual(r.report.plan.dropped.map((d) => [d.ruleId, d.anchor, d.kind]), [["implicit", "field:소속", "covered"]]);
  assert.deepEqual(r.report.plan.missingPaths, []);
});

test("암묵 채움: 승격(compile)한 문서 — 값 글이 {{경로}}인 누름틀과 같은 자리의 {{}}가 충돌 없이 한 번에 채워진다", () => {
  const compiled = compileDocument(readFixture("hancom/ph-table"));
  assert.ok(compiled.ok);
  const bytes = (compiled as { output: Uint8Array }).output;
  assert.deepEqual(listFields(reparse(bytes)).map((f) => f.name), ["applicant.name", "note"]);
  const r = done(generate(bytes, emptyTemplate(), ds({ applicant: { name: "홍" }, note: "비고\n둘째 줄" })));
  assert.deepEqual(listFields(reparse(r.output)).map((f) => f.valueText), ["홍", "비고\n둘째 줄"]);
  assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), []);
});

// ── 누름틀 암묵 채움은 type="CLICK_HERE"에만 ──────────────────
// 책갈피(BOOKMARK)·메일 머지(MAILMERGE) 같은 다른 종류의 필드는 암묵 채움의 대상이 아니다: 채우지 않고, 필수 경로·건너뜀·dropped로도 세지 않는다.
// (명시한 `field` 앵커가 가리키는 필드는 type과 무관하게 규칙이 맡는다.)

const bookmarkedOrg = (): Uint8Array => mutateEntryText(FIELDS, SEC, (x) => x.replace('type="CLICK_HERE" name="소속"', 'type="BOOKMARK" name="소속"'));

test("암묵 채움은 CLICK_HERE만: BOOKMARK로 바꾼 필드는 글 그대로이고 필수 경로·건너뜀·dropped에 없으며, 나머지 누름틀은 채운다", () => {
  const bookmarked = bookmarkedOrg();
  const r = done(generate(bookmarked, emptyTemplate(), ds({ 소속: "X", 성명: "Y" })));
  assert.deepEqual(values(reparse(r.output)), [["성명", "Y", "1"], ["소속", "합성기관", "1"], ["성명", "Y", "1"]]);
  assert.deepEqual(listFields(reparse(r.output)).map((f) => f.type), ["CLICK_HERE", "BOOKMARK", "CLICK_HERE"]);
  assert.deepEqual(r.report.plan.requiredPaths, ["성명"]);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.type, a.anchor, a.targets]), [["implicit", "fill", "field:성명", 2]]);
  assert.deepEqual(r.report.plan.skipped, []);
  assert.deepEqual(r.report.plan.dropped, []);
  assert.equal(r.report.reread.fields, 2, "채운 누름틀 2개만 다시 읽는다");
  assert.deepEqual(newErrorsAfter(validateDocument(bookmarked), validateDocument(r.output)), []);

  // 데이터에 그 이름이 없어도 오류가 아니다(기본 정책 error에서도 DATA_MISSING·missingPaths가 없다)
  const noOrg = done(generate(bookmarked, emptyTemplate(), ds({ 성명: "Y" })));
  assert.deepEqual(noOrg.report.plan.missingPaths, []);
  assert.deepEqual(values(reparse(noOrg.output))[1], ["소속", "합성기관", "1"]);
  // 같은 문서를 type만 CLICK_HERE로 두면 소속이 필수라 실패한다(대조)
  assert.deepEqual(failed(generate(FIELDS, emptyTemplate(), ds({ 성명: "Y" }))), ["DATA_MISSING"]);

  // 삭제되는 문단 안의 책갈피 필드도 dropped로 세지 않는다
  const anchor = makeLineAnchor(reparse(bookmarked), "p", 0, [1]); // 소속 문단
  assert.ok(anchor !== undefined);
  const del = tpl({ anchors: [anchor], rules: [{ id: "d", do: { type: "delete", anchor: "p" } }] });
  const deleted = done(generate(bookmarked, del, ds({ 성명: "Y" })));
  assert.deepEqual(values(reparse(deleted.output)), [["성명", "Y", "1"], ["성명", "Y", "1"]]);
  assert.deepEqual(deleted.report.plan.dropped, []);
});

test("암묵 채움은 CLICK_HERE만: 필드가 전부 BOOKMARK면 채울 것이 없어 FILL_NOTHING_APPLIED이고 DATA_MISSING·건너뜀은 없다", () => {
  const all = mutateEntryText(FIELDS, SEC, (x) => x.replaceAll('type="CLICK_HERE"', 'type="BOOKMARK"'));
  const r = generate(all, emptyTemplate(), ds({}));
  assert.deepEqual(failed(r), ["FILL_NOTHING_APPLIED"]);
  assert.deepEqual(r.report.plan.missingPaths, []);
  assert.deepEqual(r.report.plan.requiredPaths, []);
  assert.deepEqual(r.report.plan.skipped, []);
});

test("암묵 채움은 CLICK_HERE만: {{k}}가 있는 문서에 책갈피 필드 bm1을 더해도 {k}만으로 성공한다(이전에는 DATA_MISSING bm1)", () => {
  const field = (type: string): string =>
    `<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>값: {{k}}</hp:t><hp:ctrl><hp:fieldBegin id="3001" type="${type}" name="bm1" fieldid="1"/></hp:ctrl><hp:t>범위</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="3001" fieldid="1"/></hp:ctrl></hp:run></hp:p>`;
  const r = done(generate(buildHwpx([field("BOOKMARK")]), emptyTemplate(), ds({ k: "K" })));
  assert.deepEqual(r.report.plan.requiredPaths, ["k"]);
  assert.deepEqual(r.report.plan.missingPaths, []);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.anchor, a.targets]), [["implicit", "{{k}}", 1]]);
  const text = reparse(r.output).sections[0]?.paragraphs[0]?.logicalText ?? "";
  assert.ok(text.includes("값: K") && !text.includes("{{"), text);
  assert.deepEqual(listFields(reparse(r.output)).map((f) => [f.name, f.type, f.valueText]), [["bm1", "BOOKMARK", "범위"]]);
  // 같은 문서의 필드가 CLICK_HERE이면 bm1이 필수라 실패한다(대조)
  assert.deepEqual(failed(generate(buildHwpx([field("CLICK_HERE")]), emptyTemplate(), ds({ k: "K" }))), ["DATA_MISSING"]);
});

test("암묵 채움은 CLICK_HERE만: 이름이 빈 MAILMERGE 필드와 경로가 아닌 이름의 BOOKMARK 필드는 FIELD_NAME_NOT_PATH로 보고하지 않는다", () => {
  const mail = (id: number, type: string, name: string, text: string): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" type="${type}" name="${name}" fieldid="1"/></hp:ctrl><hp:t>${text}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
  const extra = mail(2001, "MAILMERGE", "", "병합") + mail(2002, "BOOKMARK", "책 갈피!", "범위") + mail(2003, "DATE", "", "날짜");
  const merged = mutateEntryText(FIELDS, SEC, (x) => x.replace("<hp:t>확인자 성명: </hp:t>", `<hp:t>확인자 성명: </hp:t>${extra}`));
  const r = done(generate(merged, emptyTemplate(), ds({ 성명: "Y", 소속: "X" })));
  assert.deepEqual(r.report.plan.skipped, []);
  assert.deepEqual(r.report.plan.requiredPaths, ["성명", "소속"]);
  assert.deepEqual(values(reparse(r.output)), [["성명", "Y", "1"], ["소속", "X", "1"], ["", "병합", ""], ["책 갈피!", "범위", ""], ["", "날짜", ""], ["성명", "Y", "1"]]);
  // 채울 수 있는 것이 없으면 이 필드들만으로는 FILL_NOTHING_APPLIED이고 건너뜀 사유도 없다
  const only = mutateEntryText(readFixture("hancom-field"), SEC, (x) => x.replace("<hp:t>홍길동</hp:t>", `<hp:t>홍길동</hp:t>${extra}`).replace('name="성명"', 'name=""'));
  const none = generate(only, emptyTemplate(), ds({}));
  assert.deepEqual(failed(none), ["FILL_NOTHING_APPLIED"]);
  assert.deepEqual(none.report.plan.skipped.map((s) => s.code), ["FIELD_NAME_NOT_PATH"], "CLICK_HERE 하나(이름 빈 것)만 건너뜀으로 센다");
});

test("암묵 채움은 CLICK_HERE만: 명시한 field 앵커가 가리키는 필드는 type과 무관하게 규칙이 채운다(동작 보존)", () => {
  const rule = tpl({ anchors: [{ id: "a", kind: "field", name: "소속" }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "규칙" } } }] });
  const r = done(generate(bookmarkedOrg(), rule, ds({ 성명: "Y" })));
  assert.deepEqual(values(reparse(r.output)), [["성명", "Y", "1"], ["소속", "규칙", "1"], ["성명", "Y", "1"]]);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.anchor, a.targets]).sort(), [["implicit", "field:성명", 2], ["r", "a", 1]]);
});

// ── FILL_NOTHING_APPLIED ──────────────────────────────────────

test("FILL_NOTHING_APPLIED: 적용된 액션이 0이면 ok:false(출력·원장 없음), 건너뜀 사유가 메시지와 보고서에 있다. 모의 실행도 같다", () => {
  const ph = readFixture("hancom/ph-single");
  // 데이터가 있어도 문서에 맞는 자리가 없으면 채울 것이 없다
  const plain = readFixture("hancom/blocks");
  const r = generate(plain, emptyTemplate(), ds({ 아무: "값" }));
  assert.deepEqual(failed(r), ["FILL_NOTHING_APPLIED"]);
  assert.deepEqual(r.report.plan.actions, []);
  assert.equal(r.report.stages.length, 0);
  assert.equal(generate(plain, emptyTemplate(), ds({}), { dryRun: true }).ok, false);
  // 값이 있어 적용되면 통과한다
  assert.equal(generate(ph, emptyTemplate(), ds({ project: { name: "a", start: "b", end: "c" } })).ok, true);
  // 규칙이 삭제 하나라도 적용되면 액션이 있다
  const anchor = makeLineAnchor(reparse(plain), "p", 0, [2]);
  assert.ok(anchor !== undefined);
  const del = tpl({ anchors: [anchor], rules: [{ id: "d", do: { type: "delete", anchor: "p" } }] });
  assert.equal(generate(plain, del, ds({})).ok, true);
  // 조건이 거짓이면 규칙 안 한 것과 같다
  const idle = tpl({ anchors: [anchor], rules: [{ id: "d", when: { path: "x", op: "exists" }, do: { type: "delete", anchor: "p" } }] });
  assert.deepEqual(failed(generate(plain, idle, ds({}))), ["FILL_NOTHING_APPLIED"]);
});

test("FILL_NOTHING_APPLIED: --batch용 generateBatch에서는 그 건만 실패로 센다", () => {
  const records: BatchRecord[] = [
    { dataset: { data: { project: { name: "가", start: "S", end: "E" } }, derived: {} } },
    { dataset: { data: { 다른: "키" }, derived: {} } },
    { dataset: { data: { project: { name: "나", start: "S", end: "E" } }, derived: {} } },
  ];
  const items = [...generateBatch(readFixture("hancom/ph-single"), emptyTemplate(), records, { baseName: "x", missing: "keep" })];
  assert.deepEqual(items.map((i) => [i.ok, i.errorCodes]), [[true, []], [false, ["FILL_NOTHING_APPLIED"]], [true, []]]);
  assert.ok(items[1]?.skipped.length === 0 && items[1].output === undefined);
});

test("generateBatch의 filled: 문서 안 {{}}와 누름틀의 암묵 채움을 모두 센다({{a}} 1곳 + 누름틀 f 2곳 = 3)", () => {
  const click = (id: number): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="f" fieldid="1"/></hp:ctrl><hp:t>안내</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
  const doc = buildHwpx([`<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>{{a}}</hp:t>${click(5001)}${click(5002)}</hp:run></hp:p>`]);
  const records: BatchRecord[] = [{ dataset: { data: { a: "A", f: "F" }, derived: {} } }];
  const items = [...generateBatch(doc, emptyTemplate(), records, { baseName: "x" })];
  assert.deepEqual(items.map((i) => [i.ok, i.filled]), [[true, 3]]);
});
