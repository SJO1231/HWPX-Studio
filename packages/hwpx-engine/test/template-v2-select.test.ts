// 2판 템플릿의 값 연결(bindValues, 8.8.4), 선택 평가(selectSlots, 8.8.8, W3), 원형 영향·전파(8.8.7, W4의 순수 함수 부분), 무작위 100회.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HwpxError } from "../src/errors.ts";
import {
  bindValues,
  contentSha256,
  evaluateCondition,
  listProtoUsage,
  planProtoUpdate,
  readBlockProto,
  readStudioTemplate,
  selectSlots,
  sha256Hex,
  writeStudioTemplate,
  type BlockContent,
  type BlockProto,
  type BoundValue,
  type Condition,
  type SlotSelection,
  type StudioCase,
  type StudioTemplate,
} from "../src/index.ts";

const DIR = new URL("./fixtures/template-v2/", import.meta.url);
const fixtureText = (name: string): string => readFileSync(new URL(name, DIR), "utf8");
const SHA = "d".repeat(64);

function studio(json: string): StudioTemplate {
  const t = readStudioTemplate(json);
  assert.ok(t.schema === "hwpx-studio/template@2");
  return t;
}

/** 템플릿 객체를 JSON으로 써서 읽기 검사를 거친 2판 템플릿으로 만든다 */
const make = (raw: Record<string, unknown>): StudioTemplate => studio(JSON.stringify(raw));

function failure(fn: () => unknown): HwpxError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아님: ${String(e)}`);
    return e;
  }
  assert.fail("오류가 나야 한다");
}

function caseOf(t: StudioTemplate, parts: Partial<Pick<StudioCase, "selections" | "valueEdits" | "blockEdits">> = {}): StudioCase {
  return {
    schema: "hwpx-studio/case@1",
    template: { id: t.id, version: t.version, sha256: SHA },
    record: { dataset: "d00000001", version: 1, row: 0, sha256: SHA },
    selections: parts.selections ?? {},
    valueEdits: parts.valueEdits ?? {},
    blockEdits: parts.blockEdits ?? {},
  };
}

const byId = (values: BoundValue[], id: string): BoundValue => {
  const v = values.find((x) => x.id === id);
  assert.ok(v !== undefined, id);
  return v;
};

const anchorLine = (id: string, p: number): Record<string, unknown> => ({ id, kind: "line", at: { sectionIndex: 0, path: [p] }, print: { text: "", sha256: SHA } });

// ── bindValues ───────────────────────────────────────────────────

test("bindValues: key는 열 이름 그대로(공백·점·괄호), path는 중첩 경로, 별칭은 key와 같은 순위", () => {
  const t = studio(fixtureText("form.template.json"));
  const row = { "계약 금액(원)": 150000000, "부서(담당)": "총무과", contact: { phone: "02-000-0000" }, "담당자": "홍길동", "업체구분": "중소기업" };
  const v = bindValues(t, row, undefined, { missing: "keep" });
  assert.deepEqual(byId(v, "v25"), { id: "v25", name: "계약금액", format: "money", state: "bound", source: "key", text: "150,000,000원", normalized: "150000000", number: 150000000 });
  assert.deepEqual(byId(v, "v4"), { id: "v4", name: "담당 부서", format: "text", state: "bound", source: "alias", text: "총무과" });
  assert.deepEqual(byId(v, "v6"), { id: "v6", name: "전화", format: "text", state: "bound", source: "path", text: "02-000-0000" });
  assert.equal(byId(v, "v5").text, "홍길동");
  assert.deepEqual(v.map((x) => x.id), t.values.map((x) => x.id), "템플릿 values 순서");
  // 점은 경로 구분이 아니다: "담당.부서"는 { 담당: { 부서 } }를 찾지 않는다
  assert.equal(byId(bindValues(t, { "담당": { "부서": "x" } }, undefined, { missing: "keep" }), "v4").state, "missing");
  assert.equal(byId(bindValues(t, { "담당.부서": "x" }, undefined, { missing: "keep" }), "v4").source, "key");
  // 쓰이지 않아 연결이 없는 값은 missing
  assert.equal(byId(v, "v31").state, "missing");
});

test("bindValues: 별칭 둘 이상에 값이 있으면 DATA_ALIAS_CONFLICT(빈 글도 값, null은 값이 아님)", () => {
  const t = studio(fixtureText("form.template.json"));
  const rows: [Record<string, unknown>, string, string?][] = [
    [{ "담당.부서": "a", "담당 부서": "b" }, "rejected", "DATA_ALIAS_CONFLICT"],
    [{ "담당.부서": "", "부서(담당)": "b" }, "rejected", "DATA_ALIAS_CONFLICT"],
    [{ "담당.부서": "a", "담당 부서": "a" }, "rejected", "DATA_ALIAS_CONFLICT"],
    [{ "담당.부서": null, "부서(담당)": "b" }, "bound"],
    [{ "담당 부서": "b" }, "bound"],
    [{ "계약 금액(원)": 1, "계약금액": 2 }, "rejected", "DATA_ALIAS_CONFLICT"],
  ];
  for (const [row, state, code] of rows) {
    const values = bindValues(t, row, undefined, { missing: "keep" });
    const v = values.find((x) => x.id === ("계약금액" in row ? "v25" : "v4"));
    assert.equal(v?.state, state, JSON.stringify(row));
    assert.equal(v?.issue?.code, code, JSON.stringify(row));
    if (code !== undefined) assert.equal(v?.text, undefined);
  }
});

// #131(사용자 결정 2026-10-09)로 money 규칙이 바뀌었다: 금·원·원정·₩·쉼표·공백을 떼고 십진 글로 읽는다(범위 제한 없음, 소수 허용, 빈 글은 빈 값).
// 아래 ok·bad 표는 #29의 표에서 새 규칙으로 받게 된 입력 9개(" 1234"·"1234 "·"1,234"·"1,234원"·"12.5"·12.5·2^53·-(2^53)·"9007199254740993")를 ok로, ""를 빈 값으로 옮긴 것이다.
test("bindValues: money는 금·원·원정·₩·쉼표·공백을 떼고 십진 글로 읽는다(자릿수 보존), 출력 1,234원, 읽지 못하면 DATA_FORMAT", () => {
  const t = make({
    schema: "hwpx-studio/template@2", id: "t00000002", version: 1, source: { kind: "hwpx", sha256: SHA }, anchors: [],
    values: [{ id: "m", name: "금액", format: "money" }], bindings: [{ value: "m", key: "금액" }],
    places: [{ id: "p1", kind: "placeholder", key: "금액", value: "m" }], slots: [], blocks: [],
  });
  const ok: [unknown, string, number][] = [
    [0, "0원", 0], [7, "7원", 7], [999, "999원", 999], [1000, "1,000원", 1000], [1234, "1,234원", 1234], [-1234567, "-1,234,567원", -1234567],
    ["1234", "1,234원", 1234], ["-50", "-50원", -50], ["007", "7원", 7], [-0, "0원", 0], ["100000000", "100,000,000원", 100000000],
    [Number.MAX_SAFE_INTEGER, "9,007,199,254,740,991원", Number.MAX_SAFE_INTEGER], [Number.MIN_SAFE_INTEGER, "-9,007,199,254,740,991원", Number.MIN_SAFE_INTEGER],
    [" 1234", "1,234원", 1234], ["1234 ", "1,234원", 1234], ["1,234", "1,234원", 1234], ["1,234원", "1,234원", 1234], ["12.5", "12.5원", 12.5], [12.5, "12.5원", 12.5],
    [2 ** 53, "9,007,199,254,740,992원", 2 ** 53], [-(2 ** 53), "-9,007,199,254,740,992원", -(2 ** 53)], ["9007199254740993", "9,007,199,254,740,993원", 9007199254740993],
  ];
  for (const [raw, text, number] of ok) {
    const [v] = bindValues(t, { "금액": raw }, undefined);
    assert.equal(v?.state, "bound", String(raw));
    assert.equal(v?.text, text);
    assert.ok(Object.is(v?.number, number), `${String(raw)} → ${String(v?.number)}`);
  }
  const bad: unknown[] = ["1e3", "+5", "-", "０１", true, Number.NaN, Infinity];
  for (const raw of bad) {
    const [v] = bindValues(t, { "금액": raw }, undefined);
    assert.equal(v?.state, "rejected", String(raw));
    assert.equal(v?.issue?.code, "DATA_FORMAT", String(raw));
    assert.equal(v?.text, undefined);
    assert.ok(!v?.issue?.message.includes(String(raw)) || String(raw).length < 2, "메시지에 값 원문을 담지 않는다");
  }
  // 빈 글은 빈 값(형식 오류가 아니다)
  assert.deepEqual(bindValues(t, { "금액": "" }, undefined)[0], { id: "m", name: "금액", format: "money", state: "empty", source: "key", text: "" });
  assert.equal(bindValues(t, { "금액": { won: 1 } }, undefined)[0]?.issue?.code, "DATA_NOT_SCALAR");
  assert.equal(bindValues(t, { "금액": [1] }, undefined)[0]?.issue?.code, "DATA_NOT_SCALAR");
});

test("bindValues: 제어 문자는 VALUE_CONTROL_CHAR, 줄바꿈·탭·XML 특수문자는 그대로", () => {
  const t = studio(fixtureText("notice.template.json"));
  for (const bad of ["a\u0001b", "\u0000", "x\u000Bx", "￾", "\uD800", "끝\uDC00"]) {
    const v = byId(bindValues(t, { "사업명": bad }, undefined), "v1");
    assert.equal(v.state, "rejected", JSON.stringify(bad));
    assert.equal(v.issue?.code, "VALUE_CONTROL_CHAR");
  }
  const good = "첫 줄\n둘째\t줄\r\n<a href=\"x\">&amp;</a> 'q'";
  const v = byId(bindValues(t, { "사업명": good }, undefined), "v1");
  assert.equal(v.state, "bound");
  assert.equal(v.text, good);
  // valueEdits의 제어 문자도 거절한다
  const e = byId(bindValues(t, {}, caseOf(t, { valueEdits: { v1: "\u0007" } })), "v1");
  assert.deepEqual([e.state, e.issue?.code], ["rejected", "VALUE_CONTROL_CHAR"]);
});

test("bindValues: valueEdits가 행을 이기고(edited), 형식을 다시 적용하며, 행·이번 건은 바꾸지 않는다", () => {
  const t = studio(fixtureText("notice.template.json"));
  const row = { "사업명": "원래 사업", "사업 명": "충돌", "추정가격(원)": 5000, bidder: { sme: "아니오" } };
  const snapshot = structuredClone(row);
  const c = caseOf(t, { valueEdits: { v1: "정정 사업", v2: "2000" } });
  const cSnapshot = structuredClone(c);
  const v = bindValues(t, row, c);
  assert.deepEqual(byId(v, "v1"), { id: "v1", name: "사업명", format: "text", state: "edited", source: "edit", text: "정정 사업" });
  assert.deepEqual(byId(v, "v2"), { id: "v2", name: "추정가격", format: "money", state: "edited", source: "edit", text: "2,000원", normalized: "2000", number: 2000 });
  assert.equal(byId(v, "v3").text, "아니오");
  assert.deepEqual(row, snapshot);
  assert.deepEqual(c, cSnapshot);
  // "2,000원"은 #131부터 금액으로 읽힌다. 읽지 못하는 글(단위가 다름)로 거절을 본다
  const bad = byId(bindValues(t, row, caseOf(t, { valueEdits: { v2: "2,000달러" } })), "v2");
  assert.deepEqual([bad.state, bad.issue?.code], ["rejected", "DATA_FORMAT"]);
  assert.equal(byId(bindValues(t, row, caseOf(t, { valueEdits: { v1: "" } })), "v1").text, "");
});

test("bindValues: 누락 정책 3종(error·empty·keep), opts.missing이 템플릿 옵션을 이긴다, 빈 글은 empty", () => {
  const t = studio(fixtureText("notice.template.json")); // options.missing = error
  const err = byId(bindValues(t, { "사업명": null }, undefined), "v1");
  assert.deepEqual(err, { id: "v1", name: "사업명", format: "text", state: "missing", source: "none", issue: { code: "DATA_MISSING", message: err.issue?.message ?? "" } });
  assert.equal(err.text, undefined);
  const empty = byId(bindValues(t, {}, undefined, { missing: "empty" }), "v1");
  assert.deepEqual([empty.state, empty.text, empty.issue], ["missing", "", undefined]);
  const keep = byId(bindValues(t, {}, undefined, { missing: "keep" }), "v1");
  assert.deepEqual([keep.state, keep.text, keep.issue], ["missing", undefined, undefined]);
  const t2 = make({ ...JSON.parse(fixtureText("notice.template.json")), options: { missing: "empty" } });
  assert.equal(byId(bindValues(t2, {}, undefined), "v1").text, "");
  const blank = byId(bindValues(t, { "사업명": "" }, undefined), "v1");
  assert.deepEqual([blank.state, blank.text], ["empty", ""]);
  // 숫자·불리언은 글로
  assert.equal(byId(bindValues(t, { bidder: { sme: true } }, undefined), "v3").text, "true");
  assert.equal(byId(bindValues(t, { "사업명": 12 }, undefined), "v1").text, "12");
});

test("bindValues 규모: 자리 41개 템플릿에 200~1,000자 긴 값(여러 문장·줄바꿈·탭·XML 특수문자)을 넣어도 값이 그대로이고 결정적이다", () => {
  const t = studio(fixtureText("form.template.json"));
  const sentence = (i: number, n: number): string => {
    let s = "";
    for (let k = 0; s.length < n; k++) s += `${i}번째 값의 ${k}번째 문장입니다 <태그 & "인용" '작은'>.${k % 3 === 0 ? "\n" : k % 3 === 1 ? "\t" : " "}`;
    return s.slice(0, n);
  };
  const row: Record<string, unknown> = { contact: { phone: sentence(6, 300), fax: sentence(7, 1000) } };
  const expected = new Map<string, string>();
  t.bindings.forEach((b, i) => {
    const def = t.values.find((x) => x.id === b.value);
    if (def === undefined || "path" in b) return;
    if (def.format === "money") row[b.key] = 1000000 * (i + 1);
    else {
      const text = sentence(i, 200 + ((i * 97) % 801));
      row[b.key] = text;
      expected.set(def.id, text);
    }
  });
  const a = bindValues(t, row, undefined);
  const b = bindValues(t, structuredClone(row), undefined);
  assert.deepEqual(a, b);
  for (const [id, text] of expected) {
    const v = byId(a, id);
    assert.equal(v.state, "bound", id);
    assert.equal(v.text, text, id);
    assert.ok(text.length >= 200 && text.length <= 1000);
  }
  assert.equal(byId(a, "v7").text?.length, 1000);
  assert.equal(a.filter((v) => v.state === "bound").length, 30);
  assert.equal(byId(a, "v31").state, "missing");
});

// ── selectSlots: W3 ──────────────────────────────────────────────

/** 금액 경계·동률·조건 없는 블록 시험용 템플릿. 슬롯 s1(경계), s2(동률), s3(조건 없는 블록 둘), s4(후보 없음), s5(exists·empty만), s6(우선순위) */
function w3Raw(): Record<string, any> {
  const values = [
    { id: "amt", name: "금액", format: "money" },
    { id: "kind", name: "구분", format: "text" },
    { id: "memo", name: "메모", format: "text" },
  ];
  const slots = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `s${n}`, name: `슬롯${n}`, anchors: [`a${n}`], parent: null }));
  const B = (id: string, slot: string, when?: Condition, priority?: number): Record<string, unknown> => ({
    id, slot, name: id, content: { text: `${id} 글` }, ...(when === undefined ? {} : { when }), ...(priority === undefined ? {} : { priority }),
  });
  return {
    schema: "hwpx-studio/template@2", id: "t0000000a", version: 1, source: { kind: "hwpx", sha256: SHA },
    anchors: [1, 2, 3, 4, 5, 6].map((n) => anchorLine(`a${n}`, n * 10)),
    values,
    bindings: [{ value: "amt", key: "금액" }, { value: "kind", key: "구분" }, { value: "memo", key: "메모" }],
    places: [],
    slots,
    blocks: [
      B("high", "s1", { path: "amt", op: "ge", value: 100000000 }, 10),
      B("low", "s1", { path: "amt", op: "lt", value: 100000000 }, 10),
      B("plain1", "s1"),
      B("tieA", "s2", { path: "kind", op: "eq", value: "물품" }, 5),
      B("tieB", "s2", { path: "kind", op: "in", value: ["물품", "용역"] }, 5),
      B("tieC", "s2", { path: "kind", op: "eq", value: "공사" }, 1),
      B("free1", "s3"),
      B("free2", "s3"),
      B("never", "s4", { path: "kind", op: "eq", value: "없는 구분" }),
      B("hasMemo", "s5", { path: "memo", op: "exists" }, 1),
      B("noMemo", "s5", { path: "memo", op: "empty" }, 1),
      B("p1", "s6", { path: "amt", op: "gt", value: 0 }, 1),
      B("p9", "s6", { all: [{ path: "amt", op: "gt", value: 0 }, { path: "kind", op: "ne", value: "공사" }] }, 9),
    ],
  };
}

type Expect = Partial<Pick<SlotSelection, "state" | "block" | "reason" | "differs" | "candidates" | "blocked">>;
type W3Row = { name: string; row: Record<string, unknown>; expect: Record<string, Expect>; selections?: StudioCase["selections"] };

/** 입력별 기대 블록 시험표 */
const W3: W3Row[] = [
  { name: "금액 경계 아래(99,999,999)", row: { "금액": 99999999, "구분": "물품", "메모": "m" },
    expect: { s1: { state: "default", block: "low" }, s2: { state: "undecided", reason: "tie", candidates: ["tieA", "tieB"], blocked: "SEL_UNDECIDED" } } },
  { name: "금액 경계 같음(100,000,000)", row: { "금액": 100000000, "구분": "용역" },
    expect: { s1: { state: "default", block: "high" }, s2: { state: "default", block: "tieB" } } },
  { name: "금액 경계 위(100,000,001, 글 금액)", row: { "금액": "100000001", "구분": "공사" },
    expect: { s1: { state: "default", block: "high" }, s2: { state: "default", block: "tieC" }, s6: { state: "default", block: "p1" } } },
  { name: "음수 금액", row: { "금액": -5, "구분": "물품" },
    expect: { s1: { state: "default", block: "low" }, s6: { state: "undecided", reason: "noCandidate", candidates: [] } } },
  { name: "조건 없는 블록 2개는 동률", row: { "금액": 1, "구분": "물품" },
    expect: { s3: { state: "undecided", reason: "tie", candidates: ["free1", "free2"], blocked: "SEL_UNDECIDED" } } },
  { name: "참인 조건이 없고 조건 없는 블록이 없으면 후보 없음", row: { "금액": 1, "구분": "물품" },
    expect: { s4: { state: "undecided", reason: "noCandidate", candidates: [], blocked: "SEL_UNDECIDED" } } },
  { name: "조건 값 누락(금액 없음)은 판정할 수 없다", row: { "구분": "물품", "메모": "m" },
    expect: { s1: { state: "undecided", reason: "valueMissing", candidates: ["high", "low"], blocked: "SEL_UNDECIDED" }, s3: { state: "undecided", reason: "tie" }, s6: { state: "undecided", reason: "valueMissing", candidates: ["p1", "p9"] } } },
  { name: "조건 값 누락(구분 없음)", row: { "금액": 5 },
    expect: { s2: { state: "undecided", reason: "valueMissing", candidates: ["tieA", "tieB", "tieC"] }, s4: { state: "undecided", reason: "valueMissing" }, s1: { state: "default", block: "low" } } },
  { name: "exists·empty만 쓴 참조는 값이 없어도 판정한다(메모 없음 → empty 참)", row: { "금액": 5, "구분": "물품" },
    expect: { s5: { state: "default", block: "noMemo" } } },
  { name: "exists·empty만 쓴 참조(메모 있음 → exists 참)", row: { "금액": 5, "구분": "물품", "메모": "있음" },
    expect: { s5: { state: "default", block: "hasMemo" } } },
  { name: "빈 글 메모는 값이지만 empty가 참", row: { "금액": 5, "구분": "물품", "메모": "" },
    expect: { s5: { state: "undecided", reason: "tie", candidates: ["hasMemo", "noMemo"] } } },
  { name: "우선순위가 높은 참 블록", row: { "금액": 5, "구분": "물품" },
    expect: { s6: { state: "default", block: "p9" } } },
  { name: "형식 오류 값을 조건이 쓰면 판정하지 않는다", row: { "금액": "1,000달러", "구분": "물품" },
    expect: { s1: { state: "undecided", reason: "valueRejected", candidates: ["high", "low"] }, s2: { state: "undecided", reason: "tie" } } },
  { name: "수동 선택은 데이터가 바뀌어도 유지하고 차이만 표시", row: { "금액": 200000000, "구분": "물품" },
    selections: { s1: { block: "low", basis: "manual", content: sha256Hex("low 글") } },
    expect: { s1: { state: "manual", block: "low", differs: true, candidates: ["high"] } } },
  { name: "수동 선택이 조건과 같으면 differs 없음", row: { "금액": 5, "구분": "물품" },
    selections: { s1: { block: "low", basis: "manual", content: sha256Hex("low 글") } },
    expect: { s1: { state: "manual", block: "low" } } },
  { name: "확정 유지(조건 값이 없어져도)", row: { "구분": "물품" },
    selections: { s1: { block: "high", basis: "confirmed", content: sha256Hex("high 글") }, s3: { block: "free2", basis: "manual", content: sha256Hex("free2 글") } },
    expect: { s1: { state: "confirmed", block: "high" }, s3: { state: "manual", block: "free2" } } },
  { name: "저장한 블록 내용 해시가 다르면 recheck", row: { "금액": 5, "구분": "물품" },
    selections: { s1: { block: "low", basis: "manual", content: SHA } },
    expect: { s1: { state: "recheck", block: "low", reason: "contentChanged", blocked: "SEL_RECHECK" } } },
  { name: "저장한 블록이 없으면 recheck", row: { "금액": 5, "구분": "물품" },
    selections: { s1: { block: "gone", basis: "confirmed", content: SHA } },
    expect: { s1: { state: "recheck", block: "gone", reason: "blockMissing", blocked: "SEL_RECHECK" } } },
  { name: "저장한 블록이 다른 슬롯의 것이면 recheck", row: { "금액": 5, "구분": "물품" },
    selections: { s1: { block: "free1", basis: "manual", content: sha256Hex("free1 글") } },
    expect: { s1: { state: "recheck", reason: "blockMissing" } } },
];

test(`W3 선택 평가 시험표(${W3.length}건): 입력별 기대 상태·블록·이유`, () => {
  const t = make(w3Raw());
  for (const row of W3) {
    const c = caseOf(t, { selections: row.selections ?? {} });
    const values = bindValues(t, row.row, c, { missing: "keep" });
    const result = selectSlots(t, values, c);
    assert.deepEqual(result.map((r) => r.slot), t.slots.map((s) => s.id), `${row.name}: 슬롯마다 하나씩, 템플릿 순서`);
    for (const [slot, expect] of Object.entries(row.expect)) {
      const got = result.find((r) => r.slot === slot);
      assert.ok(got !== undefined);
      const picked = Object.fromEntries(Object.keys(expect).map((k) => [k, (got as Record<string, unknown>)[k]]));
      assert.deepEqual(picked, expect, `${row.name} / ${slot}: ${got.message}`);
      assert.ok(got.message.length > 0, "이유 문구");
      if (expect.differs === undefined && (got.state === "manual" || got.state === "confirmed")) assert.equal(got.differs, undefined, `${row.name} / ${slot}`);
    }
    // 막는 상태 표시: undecided → SEL_UNDECIDED, recheck → SEL_RECHECK, 쓸 수 있는 상태는 없음
    for (const r of result) {
      const want = r.state === "undecided" ? "SEL_UNDECIDED" : r.state === "recheck" ? "SEL_RECHECK" : undefined;
      assert.equal(r.blocked, want, `${row.name} / ${r.slot}`);
    }
  }
});

test("W3 막는 슬롯을 모두 모은다(첫 슬롯에서 멈추지 않는다), 이유 문구에 값 원문이 없다", () => {
  const t = make(w3Raw());
  const secret = "비밀스러운-구분-값";
  const values = bindValues(t, { "금액": 123456789, "구분": secret }, undefined, { missing: "keep" });
  const result = selectSlots(t, values, undefined);
  // s2: 구분이 어느 조건과도 맞지 않고 조건 없는 블록이 없다(noCandidate), s3: 조건 없는 블록 둘(tie), s4: noCandidate
  assert.deepEqual(result.filter((r) => r.blocked !== undefined).map((r) => [r.slot, r.reason]), [["s2", "noCandidate"], ["s3", "tie"], ["s4", "noCandidate"]]);
  for (const r of result) {
    assert.ok(!r.message.includes(secret) && !r.message.includes("123456789") && !r.message.includes("123,456,789"), r.message);
  }
});

test("W3 requireConfirm: default·fallback은 needConfirm으로 막고, 확정(confirmed)·수동은 쓴다", () => {
  const raw = w3Raw();
  raw["options"] = { requireConfirm: true };
  raw["blocks"] = raw["blocks"].filter((b: any) => b.id !== "free2");
  const t = make(raw);
  const values = bindValues(t, { "금액": 5, "구분": "물품" }, undefined, { missing: "keep" });
  const plain = selectSlots(t, values, undefined);
  const s1 = plain.find((r) => r.slot === "s1");
  const s3 = plain.find((r) => r.slot === "s3");
  assert.deepEqual([s1?.state, s1?.block, s1?.reason, s1?.blocked], ["default", "low", "needConfirm", "SEL_UNDECIDED"]);
  assert.deepEqual([s3?.state, s3?.block, s3?.reason, s3?.blocked], ["fallback", "free1", "needConfirm", "SEL_UNDECIDED"]);
  const c = caseOf(t, { selections: { s1: { block: "low", basis: "confirmed", content: sha256Hex("low 글") }, s3: { block: "free1", basis: "manual", content: sha256Hex("free1 글") } } });
  const confirmed = selectSlots(t, values, c);
  assert.deepEqual(confirmed.filter((r) => r.slot === "s1" || r.slot === "s3").map((r) => [r.state, r.blocked]), [["confirmed", undefined], ["manual", undefined]]);
  // requireConfirm이 없으면 막지 않는다
  const free = selectSlots(make(w3Raw()), values, undefined).find((r) => r.slot === "s1");
  assert.deepEqual([free?.state, free?.blocked, free?.reason], ["default", undefined, undefined]);
});

test("W3 블록 삭제·내용 변경(새 템플릿 판) → recheck, 그대로면 선택 유지", () => {
  const t1 = make(w3Raw());
  const c = caseOf(t1, { selections: {
    s1: { block: "low", basis: "manual", content: contentSha256({ text: "low 글" }) },
    s2: { block: "tieA", basis: "confirmed", content: contentSha256({ text: "tieA 글" }) },
    s3: { block: "free1", basis: "manual", content: contentSha256({ text: "free1 글" }) },
  } });
  const values = bindValues(t1, { "금액": 5, "구분": "물품" }, c, { missing: "keep" });
  assert.deepEqual(selectSlots(t1, values, c).slice(0, 3).map((r) => r.state), ["manual", "confirmed", "manual"]);
  const raw2 = w3Raw();
  raw2["version"] = 2;
  raw2["blocks"] = raw2["blocks"].filter((b: any) => b.id !== "low");
  raw2["blocks"].find((b: any) => b.id === "tieA").content = { text: "tieA 글(개정)" };
  const t2 = make(raw2);
  const r2 = selectSlots(t2, values, c);
  assert.deepEqual(r2.slice(0, 3).map((r) => [r.state, r.reason, r.blocked]), [
    ["recheck", "blockMissing", "SEL_RECHECK"],
    ["recheck", "contentChanged", "SEL_RECHECK"],
    ["manual", undefined, undefined],
  ]);
  // 사용자가 다시 확정하면(새 내용 해시) recheck가 풀린다
  const c2 = caseOf(t2, { selections: { s2: { block: "tieA", basis: "confirmed", content: contentSha256({ text: "tieA 글(개정)" }) } } });
  assert.equal(selectSlots(t2, values, c2)[1]?.state, "confirmed");
  // blockEdits(이번 건 수정)는 저장 선택의 내용 해시 비교에 쓰이지 않는다
  const c3 = caseOf(t1, { selections: c.selections, blockEdits: { low: { text: "이번 건만 고친 글" } } });
  assert.equal(selectSlots(t1, values, c3)[0]?.state, "manual");
});

function nestedRaw(): Record<string, any> {
  return {
    schema: "hwpx-studio/template@2", id: "t0000000b", version: 1, source: { kind: "hwpx", sha256: SHA },
    anchors: [anchorLine("a1", 1), anchorLine("a2", 50)],
    values: [{ id: "kind", name: "구분", format: "text" }],
    bindings: [{ value: "kind", key: "구분" }],
    places: [],
    slots: [
      { id: "child", name: "하위", anchors: ["a2"], parent: "top1" },
      { id: "top", name: "상위", anchors: ["a1"], parent: null },
    ],
    blocks: [
      { id: "top1", slot: "top", name: "상위1", when: { path: "kind", op: "eq", value: "A" }, content: { text: "상위1" } },
      { id: "top2", slot: "top", name: "상위2", content: { text: "상위2" } },
      { id: "c1", slot: "child", name: "하위1", content: { text: "하위1" } },
      { id: "c2", slot: "child", name: "하위2", when: { path: "kind", op: "eq", value: "Z" }, content: { text: "하위2" } },
    ],
  };
}

test("W3 중첩 슬롯: 상위 블록이 선택되지 않으면 inactive, 선택되면 계산, 상위가 recheck이면 하위 저장 선택도 recheck", () => {
  const t = make(nestedRaw());
  const pick = (row: Record<string, unknown>, c?: StudioCase, tt: StudioTemplate = t): string[] =>
    selectSlots(tt, bindValues(tt, row, c, { missing: "keep" }), c).map((r) => `${r.slot}:${r.state}:${r.block ?? "-"}:${r.reason ?? "-"}`);
  assert.deepEqual(pick({ "구분": "B" }), ["child:inactive:-:-", "top:fallback:top2:-"]);
  assert.deepEqual(pick({ "구분": "A" }), ["child:fallback:c1:-", "top:default:top1:-"]);
  // 하위 저장 선택은 상위가 다른 블록이면 쓰이지 않는다(inactive)
  const c = caseOf(t, { selections: {
    top: { block: "top1", basis: "manual", content: contentSha256({ text: "상위1" }) },
    child: { block: "c2", basis: "manual", content: contentSha256({ text: "하위2" }) },
  } });
  assert.deepEqual(pick({ "구분": "B" }, c), ["child:manual:c2:-", "top:manual:top1:-"]);
  const cTop2 = caseOf(t, { selections: { top: { block: "top2", basis: "manual", content: contentSha256({ text: "상위2" }) }, child: c.selections["child"]! } });
  assert.deepEqual(pick({ "구분": "A" }, cTop2), ["child:inactive:-:-", "top:manual:top2:-"]);
  // 상위 블록 내용이 바뀐 새 판: 상위 recheck → 하위 recheck(parentChanged)
  const raw2 = nestedRaw();
  raw2["version"] = 2;
  raw2["blocks"][0].content = { text: "상위1(개정)" };
  assert.deepEqual(pick({ "구분": "A" }, c, make(raw2)), ["child:recheck:c2:parentChanged", "top:recheck:top1:contentChanged"]);
  // 확정을 기다리는 상위 default도 선택으로 본다(하위를 계산하고, 하위도 확정을 기다린다)
  const confirm = nestedRaw();
  confirm["options"] = { requireConfirm: true };
  assert.deepEqual(pick({ "구분": "A" }, undefined, make(confirm)), ["child:fallback:c1:needConfirm", "top:default:top1:needConfirm"]);
});

test("W3 실제 모양 템플릿(B): 데이터에 따라 슬롯 3개의 선택이 정해진다", () => {
  const t = studio(fixtureText("form.template.json"));
  const base = { "업체구분": "중소기업", "공동수급": "아니오", "특약여부": "없음", "기초 금액(원)": 10000000 };
  const run = (row: Record<string, unknown>): string[] => selectSlots(t, bindValues(t, row, undefined, { missing: "keep" }), undefined).map((r) => `${r.slot}:${r.state}:${r.block ?? r.reason}`);
  assert.deepEqual(run({ ...base, "계약 금액(원)": 99999999 }), ["s1:default:b2", "s2:fallback:b5", "s3:fallback:b6"]);
  assert.deepEqual(run({ ...base, "계약금액": 100000000 }), ["s1:default:b1", "s2:fallback:b5", "s3:fallback:b6"]);
  assert.deepEqual(run({ ...base, "계약금액": 100000000, "공동수급": "예", "특약여부": "있음", "기초 금액(원)": 60000000 }), ["s1:default:b3", "s2:default:b4", "s3:default:b7"]);
  assert.deepEqual(run({ "업체구분": "중소기업" }), ["s1:undecided:valueMissing", "s2:undecided:valueMissing", "s3:undecided:valueMissing"]);
});

test("W3 조건 계산 실패(matches 입력 10,000자 초과)는 던지지 않고 그 슬롯만 undecided, 다른 슬롯은 정상, 저장 선택은 유지", () => {
  const t = make({
    schema: "hwpx-studio/template@2", id: "t0000000c", version: 1, source: { kind: "hwpx", sha256: SHA },
    anchors: [anchorLine("a1", 1), anchorLine("a2", 5)],
    values: [{ id: "memo", name: "메모", format: "text" }, { id: "kind", name: "구분", format: "text" }],
    bindings: [{ value: "memo", key: "메모" }, { value: "kind", key: "구분" }],
    places: [],
    slots: [{ id: "s1", name: "메모 슬롯", anchors: ["a1"], parent: null }, { id: "s2", name: "구분 슬롯", anchors: ["a2"], parent: null }],
    blocks: [
      { id: "m1", slot: "s1", name: "가로 시작", when: { path: "memo", op: "matches", value: "^가" }, content: { text: "가" } },
      { id: "m2", slot: "s1", name: "기본", content: { text: "기본" } },
      { id: "k1", slot: "s2", name: "물품", when: { path: "kind", op: "eq", value: "물품" }, content: { text: "물품" } },
      { id: "k2", slot: "s2", name: "기본", content: { text: "기본" } },
    ],
  });
  const row = { "메모": "가".repeat(10001), "구분": "물품" };
  const values = bindValues(t, row, undefined);
  const result = selectSlots(t, values, undefined);
  const s1 = result[0];
  assert.deepEqual([s1?.state, s1?.reason, s1?.blocked, s1?.candidates], ["undecided", "valueRejected", "SEL_UNDECIDED", ["m1"]]);
  assert.ok(s1?.message.includes("TPL_CONDITION"), s1?.message);
  assert.ok(!s1?.message.includes("가가가"), "이유 문구에 값 원문이 없다");
  assert.deepEqual([result[1]?.state, result[1]?.block, result[1]?.blocked], ["default", "k1", undefined]);
  // 저장 선택이 있으면 선택은 유지하고 differs 계산 실패만 무시한다
  const c = caseOf(t, { selections: { s1: { block: "m1", basis: "manual", content: contentSha256({ text: "가" }) } } });
  const kept = selectSlots(t, bindValues(t, row, c), c)[0];
  assert.deepEqual([kept?.state, kept?.block, kept?.blocked, kept?.differs], ["manual", "m1", undefined, undefined]);
  // 한도 안이면 그대로 계산한다
  assert.deepEqual(selectSlots(t, bindValues(t, { ...row, "메모": "가".repeat(10000) }, undefined), undefined).map((r) => r.block), ["m1", "k1"]);
});

test("값 id·슬롯 id가 Object 원형의 이름(toString·constructor)이어도 빈 이번 건에서 bound·fallback이다", () => {
  const t = make({
    schema: "hwpx-studio/template@2", id: "t0000000d", version: 1, source: { kind: "hwpx", sha256: SHA },
    anchors: [anchorLine("a1", 1)],
    values: [{ id: "toString", name: "글", format: "text" }, { id: "valueOf", name: "금액", format: "money" }],
    bindings: [{ value: "toString", key: "글" }, { value: "valueOf", key: "금액" }],
    places: [{ id: "p1", kind: "placeholder", key: "글", value: "toString" }, { id: "p2", kind: "placeholder", key: "금액", value: "valueOf" }],
    slots: [{ id: "constructor", name: "슬롯", anchors: ["a1"], parent: null }],
    blocks: [{ id: "hasOwnProperty", slot: "constructor", name: "기본", content: { text: "기본" } }],
  });
  const c = caseOf(t);
  const values = bindValues(t, { "글": "x", "금액": 3 }, c);
  assert.deepEqual(values.map((v) => [v.id, v.state, v.text]), [["toString", "bound", "x"], ["valueOf", "bound", "3원"]]);
  assert.deepEqual(selectSlots(t, values, c).map((r) => [r.slot, r.state, r.block]), [["constructor", "fallback", "hasOwnProperty"]]);
});

// ── 원형 영향 목록과 전파 계획 ───────────────────────────────────

const protoV2 = (): BlockProto => readBlockProto(fixtureText("proto-v2.json"));
const protoV3 = (): BlockProto => readBlockProto(fixtureText("proto-v3.json"));
const protoV4 = (): BlockProto => ({ ...protoV3(), version: 4, content: { text: "{{사업명}} 계약기간 {{계약기간}}" }, keys: ["사업명", "계약기간"], previous: { version: 3, content: contentSha256(protoV3().content) } });

test("원형 영향 목록: behind·current·forked, 다른 원형은 빈 목록", () => {
  const A = studio(fixtureText("notice.template.json"));
  const B = studio(fixtureText("form.template.json"));
  assert.deepEqual(listProtoUsage([A, B], "k7d20a4e1", 3), {
    proto: "k7d20a4e1", latest: 3, usages: [
      { template: "t3f9a01c2", version: 4, blocks: ["b1"], pinned: 2, state: "behind" },
      { template: "t0a55e7b9", version: 7, blocks: ["b3"], pinned: 3, state: "current" },
      { template: "t0a55e7b9", version: 7, blocks: ["b7"], forkedFrom: 2, state: "forked" },
    ],
  });
  assert.deepEqual(listProtoUsage([A, B], "k7d20a4e1", 2).usages.map((u) => u.state), ["current", "current", "forked"]);
  assert.deepEqual(listProtoUsage([A, B], "k00000000", 1).usages, []);
  assert.deepEqual(listProtoUsage([], "k7d20a4e1", 3).usages, []);
});

test("원형 전파 계획: 고른 템플릿만 새 판(핀·내용 갱신), 입력은 그대로, 전파 뒤 저장 선택은 recheck", () => {
  const A = studio(fixtureText("notice.template.json"));
  const before = writeStudioTemplate(A);
  const plan = planProtoUpdate(A, protoV3());
  assert.equal(writeStudioTemplate(A), before, "입력 템플릿은 바뀌지 않는다");
  assert.equal(plan.template.version, 5);
  assert.deepEqual(plan.updated, [{ block: "b1", from: 2, to: 3 }]);
  const b1 = plan.template.blocks.find((b) => b.id === "b1");
  assert.deepEqual([b1?.proto, b1?.content], [{ id: "k7d20a4e1", version: 3 }, protoV3().content]);
  assert.deepEqual(plan.template.blocks.find((b) => b.id === "b2"), A.blocks.find((b) => b.id === "b2"));
  // 새 판은 다시 읽어도 같고, 원형 핀 검사도 통과한다
  const pins = new Map<string, BlockContent>([["k7d20a4e1@3", protoV3().content]]);
  assert.deepEqual(readStudioTemplate(writeStudioTemplate(plan.template), { lookupProto: (id, v) => pins.get(`${id}@${v}`) }), plan.template);
  // 영향 목록에서 A가 current가 된다
  const B = studio(fixtureText("form.template.json"));
  assert.deepEqual(listProtoUsage([plan.template, B], "k7d20a4e1", 3).usages.map((u) => u.state), ["current", "current", "forked"]);
  // 이미 최신이면 바꿀 것이 없다(판 번호 그대로)
  const noop = planProtoUpdate(B, protoV3());
  assert.deepEqual([noop.template.version, noop.updated], [7, []]);
  assert.equal(writeStudioTemplate(noop.template), writeStudioTemplate(B));
  // 전파로 블록 내용이 바뀌면 그 블록을 저장 선택으로 가진 이번 건은 recheck
  const c = caseOf(A, { selections: { s1: { block: "b1", basis: "manual", content: contentSha256(protoV2().content) } } });
  const values = bindValues(A, { "사업명": "x", "추정가격(원)": 1, bidder: { sme: "아니오" } }, c);
  assert.equal(selectSlots(A, values, c)[0]?.state, "manual");
  const after = selectSlots(plan.template, values, c)[0];
  assert.deepEqual([after?.state, after?.reason], ["recheck", "contentChanged"]);
});

test("W4 두 템플릿이 같은 원형을 참조 → 원형 수정(4판, 새 키) → 영향 2건, 새 키에 연결이 없는 템플릿 전파는 PROTO_UNBOUND_KEY", () => {
  const A = studio(fixtureText("notice.template.json"));
  const B = studio(fixtureText("form.template.json"));
  const v4 = protoV4();
  const usage = listProtoUsage([A, B], v4.id, 4);
  assert.deepEqual(usage.usages.filter((u) => u.state !== "forked").map((u) => [u.template, u.state]), [["t3f9a01c2", "behind"], ["t0a55e7b9", "behind"]]);
  const snapshotA = writeStudioTemplate(A);
  const e = failure(() => planProtoUpdate(A, v4));
  assert.equal(e.code, "PROTO_UNBOUND_KEY");
  assert.ok(e.message.includes("계약기간"));
  assert.equal(writeStudioTemplate(A), snapshotA, "막힌 전파는 아무것도 바꾸지 않는다");
  const planB = planProtoUpdate(B, v4);
  assert.deepEqual([planB.template.version, planB.updated], [8, [{ block: "b3", from: 3, to: 4 }]]);
  assert.deepEqual(planB.template.blocks.find((b) => b.id === "b7"), B.blocks.find((b) => b.id === "b7"), "분기 블록은 전파 대상이 아니다");
  // 자리는 있으나 그 값에 연결이 없어도 막는다
  const unbound = structuredClone(B);
  unbound.bindings = unbound.bindings.filter((b) => b.value !== "v20");
  assert.equal(failure(() => planProtoUpdate(unbound, v4)).code, "PROTO_UNBOUND_KEY");
  // 다른 블록에만 적용되는 자리(where)는 세지 않는다
  const scoped = structuredClone(B);
  const p = scoped.places.find((x) => x.kind === "placeholder" && x.key === "계약기간");
  assert.ok(p !== undefined && p.kind === "placeholder");
  p.where = "b4";
  assert.equal(failure(() => planProtoUpdate(scoped, v4)).code, "PROTO_UNBOUND_KEY");
  p.where = "b3";
  assert.equal(planProtoUpdate(scoped, v4).updated.length, 1);
});

// ── 무작위 100회: 생성 → 쓰기 → 읽기 동일, 선택 평가 결정성 ─────

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

const KEY_CHARS = ["가", "나", "금", "액", " ", ".", "(", ")", "A", "b", "1", "_", "-", "원"];

function randomTemplate(r: () => number, n: number): { raw: Record<string, any>; row: Record<string, unknown>; c: StudioCase | undefined } {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const valueCount = int(5, 40);
  const values = Array.from({ length: valueCount }, (_, i) => ({ id: `v${i + 1}`, name: `값 ${i + 1}`, format: r() < 0.3 ? "money" : "text" }));
  const keyOf = (i: number): string => `${Array.from({ length: int(1, 6) }, () => pick(KEY_CHARS)).join("").trim() || "k"}#${i}`;
  const bindings: Record<string, unknown>[] = [];
  const row: Record<string, unknown> = {};
  for (const v of values) {
    const i = Number(v.id.slice(1));
    const dataValue = (): unknown => {
      const roll = r();
      if (roll < 0.12) return undefined;
      if (roll < 0.17) return null;
      if (v.format === "money") return r() < 0.8 ? int(-5, 3) * 50000000 + int(0, 2) : pick(["1,000", "12.5", " 7"]);
      return r() < 0.2 ? "" : "글".repeat(int(1, 300)) + pick(["\n둘째 줄", "\t탭", " <&>", ""]);
    };
    if (r() < 0.2) {
      bindings.push({ value: v.id, path: `grp${i}.f${i}` });
      const d = dataValue();
      if (d !== undefined) row[`grp${i}`] = { [`f${i}`]: d };
    } else {
      const key = keyOf(i);
      const aliases = r() < 0.3 ? [`${key} 별칭`] : undefined;
      bindings.push({ value: v.id, key, ...(aliases === undefined ? {} : { aliases }) });
      const d = dataValue();
      if (d !== undefined) row[aliases !== undefined && r() < 0.5 ? (aliases[0] as string) : key] = d;
      if (aliases !== undefined && r() < 0.1) row[aliases[0] as string] = "충돌";
    }
  }
  const anchors: Record<string, unknown>[] = [];
  const places: Record<string, unknown>[] = [];
  const placeCount = int(10, 60);
  for (let i = 1; i <= placeCount; i++) {
    const v = pick(values).id;
    const kind = pick(["placeholder", "mailMerge", "clickHere", "word", "line", "cell"]);
    if (kind === "placeholder" || kind === "mailMerge") places.push({ id: `p${i}`, kind, key: `${kind}-${v}`, value: v });
    else if (kind === "clickHere") places.push({ id: `p${i}`, kind, name: `누름틀 ${v}`, value: v, ...(r() < 0.3 ? { occurrence: int(0, 3) } : {}) });
    else {
      const a = `pa${i}`;
      if (kind === "word") anchors.push({ id: a, kind, at: { sectionIndex: 0, path: [1000 + i] }, start: 0, end: 2, print: { text: "ab", before: "", after: "" } });
      if (kind === "line") anchors.push({ id: a, kind, at: { sectionIndex: 1, path: [i] }, print: { text: "줄", sha256: SHA } });
      if (kind === "cell") anchors.push({ id: a, kind, table: { sectionIndex: 0, ordinal: int(0, 3) }, row: int(0, 5), col: int(0, 5), ...(r() < 0.5 ? { print: { rows: 6, cols: 6, head: SHA, text: SHA } } : {}) });
      places.push({ id: `p${i}`, kind, anchor: a, value: v });
    }
  }
  const slotCount = int(1, 4);
  const slots: Record<string, unknown>[] = [];
  const blocks: Record<string, any>[] = [];
  let at = 0;
  const leaf = (): Condition => {
    const v = pick(values);
    if (v.format === "money") return { path: v.id, op: pick(["ge", "lt", "gt", "le", "eq"] as const), value: int(-2, 2) * 50000000 };
    return pick<Condition>([{ path: v.id, op: "exists" }, { path: v.id, op: "empty" }, { path: v.id, op: "eq", value: "" }, { path: v.id, op: "lengthGt", value: int(0, 200) }]);
  };
  const cond = (): Condition => {
    const roll = r();
    if (roll < 0.5) return leaf();
    if (roll < 0.7) return { all: [leaf(), leaf()] };
    if (roll < 0.9) return { any: [leaf(), leaf()] };
    return { not: leaf() };
  };
  for (let s = 1; s <= slotCount; s++) {
    const anchorIds: string[] = [];
    for (let k = 0; k < int(1, 2); k++) {
      const id = `sa${s}_${k}`;
      const from = at;
      const to = at + int(0, 4);
      at = to + 1 + int(0, 3);
      anchors.push(r() < 0.7
        ? { id, kind: "range", at: { sectionIndex: 0, parentPath: [] }, from, to, print: { first: { text: "", sha256: SHA }, last: { text: "", sha256: SHA }, count: to - from + 1, sha256: SHA } }
        : { id, kind: "line", at: { sectionIndex: 0, path: [from] }, print: { text: "", sha256: SHA } });
      anchorIds.push(id);
    }
    slots.push({ id: `s${s}`, name: `슬롯 ${s}`, anchors: anchorIds, parent: null });
    for (let b = 1; b <= int(1, 5); b++) {
      const block: Record<string, any> = { id: `b${s}_${b}`, slot: `s${s}`, name: `블록 ${b}`, content: r() < 0.5 ? { text: `블록 ${s}-${b} 글 ${int(0, 9)}` } : { fragment: sha256Hex(`조각 ${n} ${s} ${b}`) } };
      if (r() < 0.7) block["when"] = cond();
      if (r() < 0.6) block["priority"] = int(-1, 3);
      if (r() < 0.2) block["proto"] = { id: "k7d20a4e1", version: int(1, 4) };
      else if (r() < 0.1) block["forkedFrom"] = { id: "k7d20a4e1", version: int(1, 4) };
      blocks.push(block);
    }
  }
  const raw: Record<string, any> = {
    schema: "hwpx-studio/template@2", id: `t${(n + 0x10000000).toString(16)}`, version: int(1, 30), source: { kind: "hwpx", sha256: sha256Hex(`원본 ${n}`) },
    anchors, values, bindings, places, slots, blocks,
    options: { missing: pick(["error", "empty", "keep"]), requireConfirm: r() < 0.3, unregistered: pick(["error", "keep"]) },
  };
  if (r() < 0.5) raw["meta"] = { name: `무작위 ${n}` };
  let c: StudioCase | undefined;
  if (r() < 0.6) {
    const selections: StudioCase["selections"] = {};
    for (const s of slots) {
      if (r() < 0.5) continue;
      const own = blocks.filter((b) => b["slot"] === s["id"]);
      const b = r() < 0.15 ? { id: "gone", content: { text: "x" } } : pick(own);
      selections[s["id"] as string] = { block: b["id"] as string, basis: pick(["manual", "confirmed"] as const), content: r() < 0.15 ? SHA : contentSha256(b["content"] as BlockContent) };
    }
    c = {
      schema: "hwpx-studio/case@1", template: { id: raw["id"], version: raw["version"], sha256: SHA }, record: { dataset: "d00000001", version: 1, row: n, sha256: SHA },
      selections, valueEdits: r() < 0.5 ? { v1: values[0]?.format === "money" ? String(int(0, 9) * 10000000) : "정정 글" } : {}, blockEdits: {},
    };
  }
  return { raw, row, c };
}

function shuffled(v: unknown, r: () => number): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffled(x, r));
  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v);
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [entries[i], entries[j]] = [entries[j]!, entries[i]!];
    }
    return Object.fromEntries(entries.map(([k, x]) => [k, shuffled(x, r)]));
  }
  return v;
}

test("무작위 100회: 템플릿 생성 → 정규 쓰기 → 읽기 동일, 값 연결·선택 평가가 결정적이고 상태 규칙을 지킨다", () => {
  const r = rng(20261004);
  const states = new Map<string, number>();
  let places = 0;
  for (let n = 0; n < 100; n++) {
    const { raw, row, c } = randomTemplate(r, n);
    const t = make(raw);
    places += t.places.length;
    const out = writeStudioTemplate(t);
    const again = studio(out);
    assert.deepEqual(again, t, `회차 ${n}`);
    assert.equal(writeStudioTemplate(again), out);
    assert.equal(writeStudioTemplate(studio(JSON.stringify(shuffled(raw, r), null, 1))), out, `회차 ${n}: 키 순서와 무관`);

    const values = bindValues(t, row, c);
    assert.deepEqual(bindValues(again, structuredClone(row), c), values, `회차 ${n}: 값 연결 결정성`);
    const sel = selectSlots(t, values, c);
    assert.deepEqual(selectSlots(again, bindValues(again, row, c), c), sel, `회차 ${n}: 선택 결정성`);

    const data: Record<string, unknown> = {};
    for (const v of values) if (v.state !== "missing" && v.state !== "rejected") data[v.id] = v.format === "money" ? v.number : v.text;
    for (const s of sel) {
      states.set(s.state, (states.get(s.state) ?? 0) + 1);
      const own = t.blocks.filter((b) => b.slot === s.slot);
      const holds = (b: (typeof own)[number]): boolean => evaluateCondition(b.when ?? { all: [] }, { data, derived: {} });
      const saved = c?.selections[s.slot];
      if (s.state === "default") {
        const b = own.find((x) => x.id === s.block);
        assert.ok(b?.when !== undefined && holds(b), `회차 ${n}: default 블록의 조건이 참`);
        assert.ok(own.every((x) => x === b || x.when === undefined || !holds(x) || (x.priority ?? 0) < (b.priority ?? 0)), `회차 ${n}: default는 유일한 최고 우선순위`);
      }
      if (s.state === "fallback") {
        assert.ok(own.every((x) => x.when === undefined || !holds(x)), `회차 ${n}: fallback이면 참인 조건이 없다`);
        assert.equal(own.filter((x) => x.when === undefined).length, 1);
      }
      if (s.state === "manual" || s.state === "confirmed") {
        assert.equal(s.block, saved?.block);
        assert.equal(s.state, saved?.basis);
      }
      if (s.state === "recheck") assert.ok(saved !== undefined && (s.block === "gone" || saved.content === SHA), `회차 ${n}: recheck는 저장 선택이 어긋날 때만`);
      if (saved !== undefined) assert.ok(["manual", "confirmed", "recheck"].includes(s.state), `회차 ${n}: 저장 선택이 있으면 계산하지 않는다`);
      const blocked = s.state === "undecided" || (s.reason === "needConfirm" && t.options?.requireConfirm === true) ? "SEL_UNDECIDED" : s.state === "recheck" ? "SEL_RECHECK" : undefined;
      assert.equal(s.blocked, blocked, `회차 ${n}: ${s.slot}`);
    }
  }
  assert.ok(places >= 1000, `자리 ${places}개`);
  for (const s of ["manual", "confirmed", "default", "fallback", "undecided", "recheck"]) assert.ok((states.get(s) ?? 0) > 0, `상태 ${s}가 한 번 이상 나온다`);
});
