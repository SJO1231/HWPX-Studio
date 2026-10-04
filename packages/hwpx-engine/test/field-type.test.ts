// 필드 종류 판정(이슈 #12). 기대값은 총괄 결정(2026-10-04)에서 만들었다:
//  - type은 허용 목록(CLICK_HERE·MAILMERGE·HYPERLINK)과 대소문자를 무시해 비교한다. click_here·clickhere·Click_Here는 CLICK_HERE, mailmerge·MailMerge는 MAILMERGE다.
//    그래서 type 글자만 다른 서식은 같은 자리로 채워지고, 채운 결과는 type 글자(바이트 그대로 둔다)만 다르다.
//  - type 속성이 없거나 비면 종류 UNKNOWN이다. 목록(listFields)에는 나오지만 자리로 세지 않는다: 암묵 채움이 채우지 않고 필요한 경로·건너뜀 보고에도 넣지 않는다.
//  - 목록 밖의 type(날짜 등)은 값 그대로다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileDocument, emptyTemplate, generate, listFields, readDataset, validateDocument, type GenerateResult } from "../src/index.ts";
import { collectFields } from "../src/fill/fields.ts";
import { buildHwpx, mutateEntryText, newErrorsAfter, readFixture, reparse } from "./helpers.ts";

const SEC = "Contents/section0.xml";
/** 메일 머지 33개(경로 꼴 키 29개, 같은 키 최대 4번)·누름틀 4개·{{}} 8곳이 본문·표 두 개·머리말·꼬리말에 흩어진 합성 서식 */
const FIXTURE = readFixture("merge/merge-fields");
const CLICK_NAMES = ["성명", "소속", "이름", "직위"];

type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;
const done = (r: GenerateResult): Done => {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error").map((i) => [i.code, i.message]))}`);
  assert.ok(!r.dryRun);
  return r as Done;
};
const ds = (data: unknown) => readDataset(data);
const sectionOf = (bytes: Uint8Array): string => {
  let text = "";
  mutateEntryText(bytes, SEC, (x) => ((text = x), x + " "));
  return text;
};
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** 서식의 type 글자를 바꾼다: n번째 MAILMERGE는 MERGE_CASES[n % 3], n번째 CLICK_HERE는 CLICK_CASES[n % 4] */
const MERGE_CASES = ["mailmerge", "MailMerge", "mailMerge"];
const CLICK_CASES = ["click_here", "clickhere", "Click_Here", "ClickHere"];
function recase(xml: string): string {
  let m = 0;
  let c = 0;
  return xml.replace(/(<hp:fieldBegin\b[^>]*?\stype=")(MAILMERGE|CLICK_HERE)"/g, (_, head: string, type: string) => `${head}${type === "MAILMERGE" ? MERGE_CASES[m++ % 3] : CLICK_CASES[c++ % 4]}"`);
}
const CASED = mutateEntryText(FIXTURE, SEC, recase);

/** 누름틀 4개의 type을 없앤다: 1·3번째는 속성을 지우고 2·4번째는 빈 값으로 둔다 */
const TYPELESS = mutateEntryText(FIXTURE, SEC, (x) => {
  let n = 0;
  return x.replace(/ type="CLICK_HERE"/g, () => (n++ % 2 === 0 ? "" : ' type=""'));
});

// ── 값: 짧은 값과 긴 값(수백 자, 여러 문장, 줄바꿈·탭, & < > 따옴표·숫자·날짜) ────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PARTS = ["공고", "사업", "기간", "계약", "접수", "(주)", "A&B", "x<y", "a>b", '"인용"', "'작은따옴표'", "1,234,500원", "2026-10-04", "제3항", "5%"];
/** 1~max자 값. 낱말 사이에 공백·줄바꿈·탭이 들고 끝은 공백이 아니다. */
function valueOf(r: () => number, max: number): string {
  const target = 1 + Math.floor(r() * max);
  let out = "";
  while (out.length < target) {
    out += PARTS[Math.floor(r() * PARTS.length)] ?? "";
    const x = r();
    out += x < 0.1 ? "\n" : x < 0.18 ? "\t" : r() < 0.3 ? ". " : " ";
  }
  out = out.slice(0, target);
  return /\s$/.test(out) ? `${out.slice(0, -1)}.` : out;
}
function dataOf(seed: number): Record<string, unknown> {
  const r = rng(seed);
  const v = (): string => valueOf(r, r() < 0.4 ? 30 : 700);
  const keys = ["사업명", "기관명", "담당자", "연락처", "공고번호", "시행일", "접수기간", "추정가격", "장소", "예정가격", "부가세", "재공고", ...CLICK_NAMES];
  return {
    ...Object.fromEntries(keys.map((k) => [k, v()])),
    project: { name: v(), start: v(), end: v() },
    dates: { start: v(), end: v(), days: v() },
    manager: { phone: v(), email: v() },
  };
}
const without = (data: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(data).filter(([k]) => !keys.includes(k)));

// ── 모델 ────────────────────────────────────────────────────────

test("종류: 소문자·혼합 대소문자 type은 허용 목록의 종류로(click_here·clickhere → CLICK_HERE, mailmerge → MAILMERGE, hyperlink는 목록에서 뺀다), type 없음·빈 값은 UNKNOWN, 목록 밖 type은 그대로", () => {
  const field = (id: number, attrs: string, inner = ""): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" ${attrs} fieldid="1">${inner}</hp:fieldBegin></hp:ctrl><hp:t>글${id}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
  const key = (k: string): string => `<hp:parameters cnt="1" name=""><hp:stringParam name="FieldValue">${k}</hp:stringParam></hp:parameters>`;
  const body = [
    field(1, 'type="click_here" name="가"'),
    field(2, 'type="clickhere" name="나"'),
    field(3, 'type="Click_Here" name="다"'),
    field(4, 'type="CLICKHERE" name="라"'),
    field(5, 'type="mailmerge" name=""', key("키1")),
    field(6, 'type="MailMerge" name=""', key("키2")),
    field(7, 'type="hyperlink" name="링크"'),
    field(8, 'type="HyperLink" name="링크"'),
    field(9, 'name="마"'),
    field(10, 'type="" name="바"'),
    field(11, 'type="Date" name="사"'),
    field(12, 'name=""', key("키3")),
  ].join("");
  const doc = reparse(buildHwpx([`<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${body}</hp:run></hp:p>`]));
  assert.deepEqual(
    listFields(doc).map((f) => [f.type, f.name, f.mergeKey, f.valueText]),
    [
      ["CLICK_HERE", "가", undefined, "글1"],
      ["CLICK_HERE", "나", undefined, "글2"],
      ["CLICK_HERE", "다", undefined, "글3"],
      ["CLICK_HERE", "라", undefined, "글4"],
      ["MAILMERGE", "", "키1", "글5"],
      ["MAILMERGE", "", "키2", "글6"],
      ["UNKNOWN", "마", undefined, "글9"],
      ["UNKNOWN", "바", undefined, "글10"],
      ["Date", "사", undefined, "글11"],
      // type이 없으면 메일 머지가 아니라 FieldValue 인자가 있어도 키가 아니다
      ["UNKNOWN", "", undefined, "글12"],
    ],
  );
  // 채움이 쓰는 표식 목록도 같은 필드를 같은 순서로 짝짓는다(소문자 hyperlink도 뺀다)
  assert.deepEqual(collectFields(doc).map((f) => f.begin.id), ["1", "2", "3", "4", "5", "6", "9", "10", "11", "12"]);
  // 원문 type 글자는 표식에 그대로 남는다(모델 내보내기도 원문을 쓴다)
  const marks = doc.sections[0]?.paragraphs[0]?.fieldMarks.filter((m) => m.kind === "begin").map((m) => m.type) ?? [];
  assert.deepEqual(marks, ["click_here", "clickhere", "Click_Here", "CLICKHERE", "mailmerge", "MailMerge", "hyperlink", "HyperLink", undefined, "", "Date", undefined]);
});

// ── 채움: 큰 서식(필드 37개)의 type 글자를 바꾼 것 ───────────────────

test("대소문자: 메일 머지 33개·누름틀 4개의 type을 소문자·혼합으로 바꾼 서식을 무작위 값 50건으로 채우면, 대문자 서식을 채운 결과와 type 글자만 다르다(게이트·검사기 새 오류 0·결정성)", () => {
  const before = listFields(reparse(CASED));
  assert.equal(before.filter((f) => f.type === "MAILMERGE" && f.mergeKey !== undefined).length, 33);
  assert.deepEqual(before.filter((f) => f.type === "CLICK_HERE").map((f) => f.name), CLICK_NAMES);
  assert.ok(sectionOf(CASED).includes('type="mailMerge"') && sectionOf(CASED).includes('type="clickhere"') && !sectionOf(CASED).includes('type="MAILMERGE"'));
  const casedErrors = validateDocument(CASED);
  let long = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const data = dataOf(seed);
    long += Object.values(data).filter((x) => typeof x === "string" && x.length >= 300).length;
    const base = done(generate(FIXTURE, emptyTemplate(), ds(data)));
    const r = done(generate(CASED, emptyTemplate(), ds(data)));
    assert.equal(sectionOf(r.output), recase(sectionOf(base.output)), `seed ${seed}: 대문자 서식을 채운 결과와 type 글자만 다르다`);
    assert.deepEqual(r.report.plan.actions, base.report.plan.actions, `seed ${seed}: 같은 자리를 채운다`);
    assert.deepEqual(r.report.plan.requiredPaths, base.report.plan.requiredPaths);
    assert.deepEqual(r.report.plan.skipped, base.report.plan.skipped);
    assert.equal(r.report.reread.fields, base.report.reread.fields);
    assert.deepEqual(newErrorsAfter(casedErrors, validateDocument(r.output)), [], `seed ${seed}: 검사기 새 오류 없음`);
    assert.ok(bytesEqual(done(generate(CASED, emptyTemplate(), ds(data))).output, r.output), `seed ${seed}: 같은 입력은 같은 바이트`);
  }
  assert.ok(long >= 50, `긴 값(300자 이상)이 충분히 들었다: ${long}`);
});

// ── 채움: type 없는 필드 ─────────────────────────────────────────

test("type 없음: 누름틀 4개(본문 2·표 칸 2)의 type을 지우거나 비우면 UNKNOWN으로 남아 채우지 않고 보고하지 않는다. 메일 머지 33개는 대문자 서식과 같게 채운다(무작위 50건, 검사기 새 오류 0·결정성)", () => {
  const before = listFields(reparse(TYPELESS));
  const unknown = before.filter((f) => f.type === "UNKNOWN");
  assert.deepEqual(unknown.map((f) => f.name), CLICK_NAMES);
  assert.equal(before.filter((f) => f.type === "CLICK_HERE").length, 0);
  const typelessErrors = validateDocument(TYPELESS);
  const mergeTexts = (bytes: Uint8Array): string[] => listFields(reparse(bytes)).filter((f) => f.type === "MAILMERGE").map((f) => f.valueText);
  for (let seed = 1; seed <= 50; seed++) {
    const data = dataOf(seed);
    const base = done(generate(FIXTURE, emptyTemplate(), ds(data)));
    const r = done(generate(TYPELESS, emptyTemplate(), ds(data)));
    const after = listFields(reparse(r.output)).filter((f) => f.type === "UNKNOWN");
    assert.deepEqual(after.map((f) => [f.name, f.valueText, f.dirty]), unknown.map((f) => [f.name, f.valueText, f.dirty]), `seed ${seed}: type 없는 필드는 그대로다`);
    assert.deepEqual(mergeTexts(r.output), mergeTexts(base.output), `seed ${seed}: 메일 머지 필드는 같은 값으로 채운다`);
    const anchors = r.report.plan.actions.map((a) => a.anchor);
    for (const name of CLICK_NAMES) {
      assert.ok(!r.report.plan.requiredPaths.includes(name), `seed ${seed}: ${name}은 필요한 경로가 아니다`);
      assert.ok(!anchors.includes(`field:${name}`) && !r.report.plan.skipped.some((s) => s.anchor === `field:${name}`), `seed ${seed}: ${name}은 채움·건너뜀 보고에 없다`);
    }
    // 누름틀 값이 데이터에 없어도 DATA_MISSING이 아니고 결과가 같다(자리로 세지 않는다)
    assert.ok(bytesEqual(done(generate(TYPELESS, emptyTemplate(), ds(without(data, CLICK_NAMES)))).output, r.output), `seed ${seed}: 누름틀 값 없이도 같은 결과`);
    assert.deepEqual(newErrorsAfter(typelessErrors, validateDocument(r.output)), [], `seed ${seed}: 검사기 새 오류 없음`);
    assert.ok(bytesEqual(done(generate(TYPELESS, emptyTemplate(), ds(data))).output, r.output), `seed ${seed}: 같은 입력은 같은 바이트`);
  }
});

test("type 없음: type 없는 필드만 있는 문서는 채울 자리가 없어 FILL_NOTHING_APPLIED다(이름이 경로 꼴이고 데이터가 있어도)", () => {
  const field = (id: number, attrs: string): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" ${attrs} fieldid="1"/></hp:ctrl><hp:t>안내</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
  const bytes = buildHwpx([`<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${field(1, 'name="성명"')}${field(2, 'type="" name="소속"')}${field(3, 'name="성명"')}</hp:run></hp:p>`]);
  const r = generate(bytes, emptyTemplate(), ds({ 성명: "홍길동", 소속: "기관" }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code), ["FILL_NOTHING_APPLIED"]);
  assert.deepEqual(r.report.plan.requiredPaths, []);
  assert.deepEqual(r.report.plan.skipped, []);
  // 같은 문서에서 type만 소문자로 주면 채운다
  const lower = mutateEntryText(bytes, SEC, (x) => x.replace(' name="성명"', ' type="click_here" name="성명"'));
  const filled = done(generate(lower, emptyTemplate(), ds({ 성명: "홍길동", 소속: "기관" })));
  assert.deepEqual(listFields(reparse(filled.output)).map((f) => [f.type, f.name, f.valueText]), [["CLICK_HERE", "성명", "홍길동"], ["UNKNOWN", "소속", "안내"], ["UNKNOWN", "성명", "안내"]]);
});

// ── 구간 치환: 여러 문단에 걸친 누름틀 안의 필드 ───────────────────────

test("구간 안: 여러 문단에 걸친 누름틀이 지우는 구간에 든 소문자 누름틀·혼합 메일 머지 필드·type 없는 필드는 dropped에 한 번씩 나온다(소문자 누름틀이 다른 필드로 한 번 더 세이지 않는다)", () => {
  const t = (x: string): string => `<hp:t>${x}</hp:t>`;
  const field = (id: string, attrs: string, inner: string, key?: string): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" ${attrs} dirty="0" fieldid="1">${key === undefined ? "" : `<hp:parameters cnt="1" name=""><hp:stringParam name="FieldValue">${key}</hp:stringParam></hp:parameters>`}</hp:fieldBegin></hp:ctrl>${inner}<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
  const para = (id: string, inner: string): string => `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`;
  const begin = `<hp:ctrl><hp:fieldBegin id="1" type="CLICK_HERE" name="성명" dirty="0" fieldid="1"/></hp:ctrl>`;
  const end = `<hp:ctrl><hp:fieldEnd beginIDRef="1" fieldid="1"/></hp:ctrl>`;
  const bytes = buildHwpx([
    para("1", t("앞 ") + begin + t("안내")) +
      para("2", field("2", 'type="click_here" name="소속"', t("안쪽1")) + field("3", 'type="MailMerge" name=""', t("안쪽2"), "키") + field("4", 'name="비고"', t("안쪽3"))) +
      para("3", t("안내") + end + t(" 뒤")),
  ]);
  assert.deepEqual(listFields(reparse(bytes)).map((f) => [f.type, f.name, f.mergeKey, f.shape]), [
    ["CLICK_HERE", "성명", undefined, "crossParagraph"],
    ["CLICK_HERE", "소속", undefined, "simple"],
    ["MAILMERGE", "", "키", "simple"],
    ["UNKNOWN", "비고", undefined, "simple"],
  ]);
  const r = done(generate(bytes, emptyTemplate(), ds({ 성명: "새 값", 소속: "소속값", 키: "키값" })));
  assert.deepEqual(listFields(reparse(r.output)).map((f) => [f.name, f.valueText]), [["성명", "새 값"]]);
  assert.deepEqual(r.report.plan.dropped.map((d) => d.anchor).sort(), ["field:비고", "field:소속", "merge:키"]);
});

// ── 승격: 메일 머지 변환 ─────────────────────────────────────────

test("대소문자: 소문자·혼합 type의 메일 머지 필드도 compile이 메일 머지로 본다 — 표시 글 안 {{}}는 '메일 머지 필드 안' 23곳, --merge-fields 변환 29개로 대문자 서식과 같다", () => {
  const compiled = (bytes: Uint8Array, mergeFields?: "to-placeholder" | "to-field") => {
    const r = compileDocument(bytes, mergeFields === undefined ? {} : { mergeFields });
    assert.ok(r.ok, JSON.stringify(r.report.issues.map((i) => [i.code, i.message])));
    return r as Extract<typeof r, { ok: true }>;
  };
  const plain = compiled(CASED);
  assert.equal(plain.report.promoted, 8);
  const skipped = plain.report.issues.filter((i) => i.code === "COMPILE_SKIPPED");
  assert.equal(skipped.length, 23);
  assert.ok(skipped.every((i) => i.message.includes("이미 메일 머지 필드 안에 있는 자리라")));
  for (const mode of ["to-placeholder", "to-field"] as const) {
    const upper = compiled(FIXTURE, mode);
    const cased = compiled(CASED, mode);
    assert.equal(cased.report.mergeConverted, 29, mode);
    const view = (bytes: Uint8Array) => listFields(reparse(bytes)).map((f) => [f.type, f.name, f.mergeKey, f.valueText, f.dirty]);
    assert.deepEqual(view(cased.output), view(upper.output), `${mode}: 변환 뒤 필드 목록이 대문자 서식과 같다`);
  }
});
