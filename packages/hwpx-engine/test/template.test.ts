// 템플릿·데이터 묶음·값 해석·조건 평가(문서 형식과 무관한 계층). G1, G2의 값 수준, TPL_*·DATA_* 오류.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HwpxError } from "../src/errors.ts";
import {
  canonicalJson,
  checkValueText,
  digestValue,
  emptyTemplate,
  evaluateCondition,
  findPlaceholders,
  fragmentPaths,
  isValidPath,
  lookupPath,
  readDataset,
  readTemplate,
  resolveValue,
  selectRules,
  sha256Hex,
  type Condition,
  type Dataset,
  type MissingPolicy,
} from "../src/template/index.ts";

const SHA = "a".repeat(64);

/** 명세 8.2의 예시 템플릿 */
function specTemplate(): Record<string, unknown> {
  return {
    schema: "hwpx-studio/template@1",
    source: { sha256: SHA },
    anchors: [
      { id: "a1", kind: "field", name: "성명" },
      { id: "a2", kind: "word", at: { sectionIndex: 0, path: [3] }, start: 5, end: 12, print: { text: "대상 글", before: "앞", after: "뒤" } },
      { id: "a3", kind: "line", at: { sectionIndex: 0, path: [7] }, print: { text: "문단 글 앞 40자", sha256: SHA } },
      { id: "a4", kind: "cell", table: { sectionIndex: 0, ordinal: 1 }, row: 2, col: 1 },
      { id: "a5", kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 0 },
    ],
    rules: [
      { id: "r1", do: { type: "fill", anchor: "a1", value: { path: "applicant.name" } } },
      {
        id: "r2",
        when: { path: "contract.type", op: "eq", value: "용역" },
        do: { type: "inject", anchor: "a3", position: "after", fragment: "fragments/service-terms.json" },
      },
      { id: "r3", when: { not: { path: "attachments", op: "exists" } }, do: { type: "delete", anchor: "a5" } },
    ],
    options: { missing: "error" },
  };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아님: ${String(e)}`);
    return e.code;
  }
  return "(오류 없음)";
}

// ── 템플릿 읽기 ────────────────────────────────────────────────

test("템플릿: 명세 8.2의 예시를 그대로 읽고 앵커 5종·규칙 3개·액션 모양을 보존한다", () => {
  const t = readTemplate(specTemplate());
  assert.deepEqual(t.anchors.map((a) => a.kind), ["field", "word", "line", "cell", "object"]);
  assert.deepEqual(t.rules.map((r) => r.id), ["r1", "r2", "r3"]);
  assert.deepEqual(t.rules[0]?.do, { type: "fill", anchor: "a1", value: { path: "applicant.name" } });
  assert.equal(t.rules[0]?.when, undefined);
  assert.deepEqual(t.rules[2]?.when, { not: { path: "attachments", op: "exists" } });
  assert.equal(t.options.missing, "error");
  assert.deepEqual(fragmentPaths(t), ["fragments/service-terms.json"]);
});

test("템플릿: JSON 문자열도 읽고, 앵커·규칙·옵션을 생략하면 빈 목록이다", () => {
  const t = readTemplate(JSON.stringify({ schema: "hwpx-studio/template@1" }));
  assert.deepEqual([t.anchors, t.rules, t.options], [[], [], {}]);
  assert.deepEqual(emptyTemplate().rules, []);
});

test("템플릿: insertText의 style을 생략하면 inherit, 숫자 id는 문자열로 읽는다", () => {
  const base = { schema: "hwpx-studio/template@1", anchors: [{ id: "a", kind: "line", at: { sectionIndex: 0, path: [1] }, print: { text: "", sha256: SHA } }] };
  const a = readTemplate({ ...base, rules: [{ id: "r", do: { type: "insertText", anchor: "a", position: "after", value: { text: "x" } } }] });
  assert.equal(a.rules[0]?.do.type === "insertText" ? a.rules[0].do.style : undefined, "inherit");
  const b = readTemplate({
    ...base,
    rules: [{ id: "r", do: { type: "insertText", anchor: "a", position: "before", value: { text: "x" }, style: { paraPrIDRef: 3, charPrIDRef: "4", styleIDRef: 0 } } }],
  });
  assert.deepEqual(b.rules[0]?.do.type === "insertText" ? b.rules[0].do.style : undefined, { paraPrIDRef: "3", charPrIDRef: "4", styleIDRef: "0" });
});

test("템플릿: 잘못된 템플릿은 각자의 TPL_* 코드로 거절한다", () => {
  const withAnchor = (anchor: unknown): unknown => ({ schema: "hwpx-studio/template@1", anchors: [anchor] });
  const rule = (anchors: unknown[], r: unknown): unknown => ({ schema: "hwpx-studio/template@1", anchors, rules: [r] });
  const line = { id: "l", kind: "line", at: { sectionIndex: 0, path: [1] }, print: { text: "x", sha256: SHA } };
  const word = { id: "w", kind: "word", at: { sectionIndex: 0, path: [1] }, start: 0, end: 2, print: { text: "ab", before: "", after: "" } };
  const cell = { id: "c", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 0, col: 0 };
  const field = { id: "f", kind: "field", name: "x" };

  assert.equal(code(() => readTemplate("{ 깨진")), "TPL_JSON");
  assert.equal(code(() => readTemplate([])), "TPL_SCHEMA");
  assert.equal(code(() => readTemplate({ schema: "다른" })), "TPL_SCHEMA");
  assert.equal(code(() => readTemplate(withAnchor({ id: "x", kind: "mystery" }))), "TPL_ANCHOR");
  assert.equal(code(() => readTemplate({ schema: "hwpx-studio/template@1", anchors: [field, field] })), "TPL_ANCHOR");
  assert.equal(code(() => readTemplate(withAnchor({ ...word, start: 5, end: 5 }))), "TPL_ANCHOR");
  assert.equal(code(() => readTemplate(withAnchor({ ...word, at: { sectionIndex: 0, path: [1, 0] } }))), "TPL_ANCHOR");
  assert.equal(code(() => readTemplate(withAnchor({ ...line, print: { text: "x", sha256: "짧음" } }))), "TPL_ANCHOR");
  assert.equal(code(() => readTemplate(withAnchor({ ...field, extra: 1 }))), "TPL_ANCHOR");
  assert.equal(code(() => readTemplate(withAnchor({ ...field, occurrence: -1 }))), "TPL_ANCHOR");

  assert.equal(code(() => readTemplate(rule([field], { id: "r", do: { type: "fill", anchor: "없음", value: { text: "x" } } }))), "TPL_UNKNOWN_ANCHOR");
  assert.equal(code(() => readTemplate(rule([field], { id: "r", do: { type: "mystery", anchor: "f" } }))), "TPL_RULE");
  assert.equal(code(() => readTemplate(rule([field], { id: "r", do: { type: "delete", anchor: "f" } }))), "TPL_RULE");
  assert.equal(code(() => readTemplate(rule([cell], { id: "r", do: { type: "delete", anchor: "c" } }))), "TPL_RULE");
  assert.equal(code(() => readTemplate(rule([line], { id: "r", do: { type: "delete", anchor: "l", scope: "row" } }))), "TPL_RULE");
  assert.equal(code(() => readTemplate(rule([word], { id: "r", do: { type: "inject", anchor: "w", position: "after", fragment: "f.json" } }))), "TPL_RULE");
  assert.equal(code(() => readTemplate(rule([line], { id: "r", do: { type: "inject", anchor: "l", position: "옆", fragment: "f.json" } }))), "TPL_RULE");
  assert.equal(code(() => readTemplate(rule([line], { id: "r", do: { type: "inject", anchor: "l", position: "after", fragment: 7 } }))), "TPL_RULE");
  assert.equal(code(() => readTemplate(rule([field], { id: "r", do: { type: "fill", anchor: "f", value: { path: "a", text: "b" } } }))), "TPL_RULE");
  assert.equal(code(() => readTemplate(rule([field], { id: "r", do: { type: "fill", anchor: "f", value: { path: "a b" } } }))), "TPL_RULE");
  assert.equal(code(() => readTemplate({ schema: "hwpx-studio/template@1", anchors: [field], rules: [
    { id: "r", do: { type: "fill", anchor: "f", value: { text: "x" } } },
    { id: "r", do: { type: "fill", anchor: "f", value: { text: "y" } } },
  ] })), "TPL_RULE");

  assert.equal(code(() => readTemplate({ schema: "hwpx-studio/template@1", options: { missing: "무시" } })), "TPL_OPTIONS");
  assert.equal(code(() => readTemplate({ schema: "hwpx-studio/template@1", options: { mixedFormat: "last" } })), "TPL_OPTIONS");
  assert.equal(code(() => readTemplate({ schema: "hwpx-studio/template@1", options: { 다른: 1 } })), "TPL_OPTIONS");
});

test("템플릿: 조건의 틀린 모양은 TPL_CONDITION", () => {
  const field = { id: "f", kind: "field", name: "x" };
  const withWhen = (when: unknown): unknown => ({
    schema: "hwpx-studio/template@1",
    anchors: [field],
    rules: [{ id: "r", when, do: { type: "fill", anchor: "f", value: { text: "x" } } }],
  });
  assert.equal(code(() => readTemplate(withWhen({ path: "a", op: "같다", value: 1 }))), "TPL_CONDITION");
  assert.equal(code(() => readTemplate(withWhen({ path: "a", op: "eq" }))), "TPL_CONDITION");
  assert.equal(code(() => readTemplate(withWhen({ path: "a b", op: "exists" }))), "TPL_CONDITION");
  assert.equal(code(() => readTemplate(withWhen({ path: "a", op: "in", value: "x" }))), "TPL_CONDITION");
  assert.equal(code(() => readTemplate(withWhen({ path: "a", op: "matches", value: "(" }))), "TPL_CONDITION");
  assert.equal(code(() => readTemplate(withWhen({ path: "a", op: "lengthGt", value: "3" }))), "TPL_CONDITION");
  assert.equal(code(() => readTemplate(withWhen({ all: "x" }))), "TPL_CONDITION");
  assert.equal(code(() => readTemplate(withWhen({ all: [], any: [] }))), "TPL_CONDITION");
  assert.equal(code(() => readTemplate(withWhen({ not: { path: "a", op: "exists", 오타: 1 } }))), "TPL_CONDITION");
  let deep: unknown = { path: "a", op: "exists" };
  for (let i = 0; i < 40; i++) deep = { not: deep };
  assert.equal(code(() => readTemplate(withWhen(deep))), "TPL_CONDITION");
});

// ── 데이터 묶음 ────────────────────────────────────────────────

test("데이터: 묶음 형식은 data·derived를 나누고, 일반 JSON은 전체를 data로 본다", () => {
  const bundle = readDataset({ schema: "hwpx-studio/dataset@1", data: { a: 1 }, derived: { b: 2 } });
  assert.deepEqual([bundle.data, bundle.derived], [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(readDataset({ schema: "hwpx-studio/dataset@1" }), { data: {}, derived: {} });
  const plain = readDataset('{"a":{"b":"c"}}');
  assert.deepEqual([plain.data, plain.derived], [{ a: { b: "c" } }, {}]);
  assert.equal(code(() => readDataset("[1]")), "DATA_SCHEMA");
  assert.equal(code(() => readDataset("깨짐")), "DATA_JSON");
  assert.equal(code(() => readDataset({ schema: "hwpx-studio/dataset@1", data: [] })), "DATA_SCHEMA");
});

test("데이터: 경로는 data에서 먼저 찾고 없으면 derived에서 찾는다(배열은 숫자 이름, 프로토타입은 보지 않는다)", () => {
  const ds: Dataset = { data: { a: { b: "원천" }, list: [{ n: 1 }, { n: 2 }], 빈: null }, derived: { a: { b: "파생", c: "파생만" }, only: "d" } };
  assert.deepEqual(lookupPath(ds, "a.b"), { found: true, value: "원천" });
  assert.deepEqual(lookupPath(ds, "a.c"), { found: true, value: "파생만" });
  assert.deepEqual(lookupPath(ds, "only"), { found: true, value: "d" });
  assert.deepEqual(lookupPath(ds, "list.1.n"), { found: true, value: 2 });
  assert.deepEqual(lookupPath(ds, "list.2.n"), { found: false });
  assert.deepEqual(lookupPath(ds, "list.x"), { found: false });
  assert.deepEqual(lookupPath(ds, "빈"), { found: true, value: null });
  assert.deepEqual(lookupPath(ds, "constructor"), { found: false });
  assert.deepEqual(lookupPath(ds, "a.b.c"), { found: false });
});

// ── {{}} 문법 ──────────────────────────────────────────────────

test("{{}} 문법: 공백 허용, 이름은 글자·숫자·_·-, 점으로 이은 경로", () => {
  const hits = findPlaceholders("앞 {{a.b}} 중 {{ 사업.이름_2 }} 뒤 {{x-y}}{{z}}");
  assert.deepEqual(hits.map((h) => h.path), ["a.b", "사업.이름_2", "x-y", "z"]);
  const text = "앞 {{a.b}} 뒤";
  assert.equal(text.slice(hits[0]?.start, hits[0]?.end), "{{a.b}}");
  assert.deepEqual(findPlaceholders("{{}} {{a b}} {{.a}} {{a.}} {{a..b}} { {a}} {{a}"), []);
  assert.deepEqual(findPlaceholders("{{{a}}}").map((h) => h.path), ["a"]);
  assert.deepEqual(findPlaceholders("{{a}}").map((h) => [h.start, h.end]), [[0, 5]]);
  assert.ok(isValidPath("a.b-c_d") && !isValidPath("a b") && !isValidPath("") && !isValidPath("a..b"));
});

// ── 값 해석과 누락 정책(G2의 값 수준) ───────────────────────────

const DS: Dataset = { data: { name: "홍길동", n: 1500000, ok: true, nul: null, obj: { x: 1 }, arr: [1], nl: "두\n줄", tab: "탭\t", ctl: "제어\u0001" }, derived: {} };

test("값 해석: 문자열은 그대로, 숫자·불리언은 문자열로, 객체·배열은 DATA_NOT_SCALAR", () => {
  assert.deepEqual(resolveValue(DS, { path: "name" }, "error"), { kind: "text", text: "홍길동", path: "name" });
  assert.deepEqual(resolveValue(DS, { path: "n" }, "error"), { kind: "text", text: "1500000", path: "n" });
  assert.deepEqual(resolveValue(DS, { path: "ok" }, "error"), { kind: "text", text: "true", path: "ok" });
  assert.deepEqual(resolveValue(DS, { text: "고정" }, "error"), { kind: "text", text: "고정" });
  for (const path of ["obj", "arr"]) {
    const r = resolveValue(DS, { path }, "empty");
    assert.equal(r.kind, "error");
    assert.equal(r.kind === "error" ? r.code : "", "DATA_NOT_SCALAR");
  }
});

test("누락 정책: error는 DATA_MISSING, empty는 빈 글, keep은 자리 유지(없음과 null 모두)", () => {
  for (const path of ["없음", "nul"]) {
    const e = resolveValue(DS, { path }, "error");
    assert.equal(e.kind === "error" ? e.code : e.kind, "DATA_MISSING");
    assert.deepEqual(resolveValue(DS, { path }, "empty"), { kind: "empty", path });
    assert.deepEqual(resolveValue(DS, { path }, "keep"), { kind: "keep", path });
  }
  const policies: MissingPolicy[] = ["error", "empty", "keep"];
  for (const policy of policies) assert.equal(resolveValue(DS, { path: "name" }, policy).kind, "text");
});

test("VALUE_CONTROL_CHAR: XML 금지 문자는 거절하고, 줄바꿈·탭은 기본(inline)이 받고, insertText 방식은 줄바꿈만, md·txt 방식은 둘 다 거절한다", () => {
  for (const path of ["ctl"]) {
    const r = resolveValue(DS, { path }, "error");
    assert.equal(r.kind === "error" ? r.code : r.kind, "VALUE_CONTROL_CHAR");
    // 오류 메시지에 값 원문이 없다
    assert.ok(r.kind === "error" && !r.message.includes("두") && !r.message.includes("탭") && !r.message.includes("제어"), r.kind === "error" ? r.message : "");
  }
  for (const path of ["nl", "tab"]) assert.equal(resolveValue(DS, { path }, "error").kind, "text");
  assert.equal(resolveValue(DS, { path: "nl" }, "error", "paragraphs").kind, "text");
  assert.equal(resolveValue(DS, { path: "tab" }, "error", "paragraphs").kind, "error");
  assert.equal(resolveValue(DS, { path: "ctl" }, "error", "paragraphs").kind, "error");
  for (const path of ["nl", "tab", "ctl"]) assert.equal(resolveValue(DS, { path }, "error", "none").kind, "error");
  assert.equal(resolveValue(DS, { text: "a\u0000b" }, "error").kind, "error");
  assert.equal(checkValueText("정상 &<> \"'"), undefined);
  assert.equal(checkValueText("\r"), undefined);
  assert.equal(checkValueText("\r", "none"), "U+000D");
  assert.equal(checkValueText("\ud800"), "U+D800");
  assert.equal(checkValueText("￿"), "U+FFFF");
  assert.equal(checkValueText("😀"), undefined);
});

test("값 지문: 길이와 sha256 앞 8자만 담는다", () => {
  const d = digestValue("홍길동");
  assert.deepEqual(d, { length: 3, sha256: sha256Hex("홍길동").slice(0, 8) });
  assert.equal(d.sha256.length, 8);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
});

// ── G1: 조건 평가 ──────────────────────────────────────────────

const CASES: { op: string; true: [unknown, unknown][]; false: [unknown, unknown][] }[] = [
  { op: "eq", true: [["용역", "용역"], [3, 3], [3, "3"], [true, true], [true, "true"], ["1.0", 1]], false: [["용역", "물품"], [3, 4], ["007", "7"], [null, null], [[1], 1]] },
  { op: "ne", true: [["용역", "물품"], [3, 4], ["007", "7"], [null, 1], [[1], 1]], false: [["용역", "용역"], [3, "3"]] },
  { op: "gt", true: [[5, 3], ["b", "a"], ["10", 9]], false: [[3, 5], [3, 3], ["a", "b"], [null, 1], [[1], 0]] },
  { op: "ge", true: [[5, 3], [3, 3], ["b", "a"], ["b", "b"]], false: [[3, 5], ["a", "b"], [null, 1]] },
  { op: "lt", true: [[3, 5], ["a", "b"], ["9", 10]], false: [[5, 3], [3, 3], ["b", "a"], [null, 1]] },
  { op: "le", true: [[3, 5], [3, 3], ["a", "b"], ["b", "b"]], false: [[5, 3], ["b", "a"], [null, 1]] },
  { op: "contains", true: [["서울 강남", "강남"], [["a", "b"], "b"], [["1", "2"], 2]], false: [["서울", "부산"], [["a"], "b"], [5, 5], [null, "x"]] },
  { op: "in", true: [["a", ["a", "b"]], [2, ["1", "2"]], [true, ["true"]]], false: [["c", ["a", "b"]], [null, ["a"]], [[1], [1]]] },
  { op: "matches", true: [["INV-2026-0042", "^INV-\\d{4}-\\d+$"], [12, "^1"]], false: [["INV-26", "^INV-\\d{4}"], [null, ".*"], [[1], "1"]] },
  { op: "lengthEq", true: [["abc", 3], [[1, 2], 2], ["가나다", 3], ["😀", 2]], false: [["abc", 2], [5, 1], [null, 0], ["😀", 1]] },
  { op: "lengthGt", true: [["abc", 2], [[1, 2], 1]], false: [["abc", 3], [5, 0]] },
  { op: "lengthLt", true: [["abc", 4], [[1], 2]], false: [["abc", 3], [5, 9]] },
];

test("G1: 조건 연산자 14종 각각의 참·거짓 사례", () => {
  const seen = new Set<string>();
  for (const c of CASES) {
    seen.add(c.op);
    for (const [left, arg] of c.true) {
      const ds: Dataset = { data: { v: left }, derived: {} };
      assert.equal(evaluateCondition({ path: "v", op: c.op, value: arg } as Condition, ds), true, `${c.op}(${JSON.stringify(left)}, ${JSON.stringify(arg)})는 참이어야 한다`);
    }
    for (const [left, arg] of c.false) {
      const ds: Dataset = { data: { v: left }, derived: {} };
      assert.equal(evaluateCondition({ path: "v", op: c.op, value: arg } as Condition, ds), false, `${c.op}(${JSON.stringify(left)}, ${JSON.stringify(arg)})는 거짓이어야 한다`);
    }
  }
  const ds: Dataset = { data: { s: "x", e: "", z: 0, f: false, n: null, arr: [], obj: {}, full: [1] }, derived: {} };
  // exists: 경로가 있고 null이 아니다(빈 문자열·0·false·빈 배열도 있는 것이다)
  for (const p of ["s", "e", "z", "f", "arr", "obj", "full"]) assert.equal(evaluateCondition({ path: p, op: "exists" }, ds), true, p);
  for (const p of ["n", "없음", "a.b"]) assert.equal(evaluateCondition({ path: p, op: "exists" }, ds), false, p);
  // empty: 없거나 null이거나 빈 문자열·빈 배열
  for (const p of ["e", "n", "없음", "arr"]) assert.equal(evaluateCondition({ path: p, op: "empty" }, ds), true, p);
  for (const p of ["s", "z", "f", "obj", "full"]) assert.equal(evaluateCondition({ path: p, op: "empty" }, ds), false, p);
  seen.add("exists");
  seen.add("empty");
  assert.equal(seen.size, 14);
});

test("G1: 없는 경로에서는 exists·in·비교가 거짓이고 ne만 참이다. derived의 값도 조건에 쓴다", () => {
  const ds: Dataset = { data: {}, derived: { total: 10 } };
  for (const op of ["eq", "gt", "ge", "lt", "le", "contains", "lengthEq"]) {
    assert.equal(evaluateCondition({ path: "없음", op, value: 1 } as Condition, ds), false, op);
  }
  assert.equal(evaluateCondition({ path: "없음", op: "ne", value: 1 }, ds), true);
  assert.equal(evaluateCondition({ path: "total", op: "gt", value: 5 }, ds), true);
});

test("G1: all·any·not 조합과 빈 all·any", () => {
  const ds: Dataset = { data: { a: 1, b: "x", c: null }, derived: {} };
  const T: Condition = { path: "a", op: "eq", value: 1 };
  const F: Condition = { path: "b", op: "eq", value: "y" };
  const ev = (c: Condition): boolean => evaluateCondition(c, ds);
  assert.equal(ev({ all: [T, T] }), true);
  assert.equal(ev({ all: [T, F] }), false);
  assert.equal(ev({ any: [F, T] }), true);
  assert.equal(ev({ any: [F, F] }), false);
  assert.equal(ev({ not: F }), true);
  assert.equal(ev({ not: T }), false);
  assert.equal(ev({ not: { not: T } }), true);
  assert.equal(ev({ all: [] }), true);
  assert.equal(ev({ any: [] }), false);
  assert.equal(ev({ all: [T, { any: [F, { not: F }] }, { not: { path: "c", op: "exists" } }] }), true);
  assert.equal(ev({ any: [{ all: [T, F] }, { all: [F, T] }] }), false);
  assert.equal(ev({ not: { all: [T, F] } }), true);
});

test("규칙 선별: 조건이 참이거나 없는 규칙만 템플릿 순서대로 남긴다", () => {
  const t = readTemplate({
    schema: "hwpx-studio/template@1",
    anchors: [{ id: "f", kind: "field", name: "x" }],
    rules: [
      { id: "r1", do: { type: "fill", anchor: "f", value: { text: "1" } } },
      { id: "r2", when: { path: "k", op: "eq", value: "a" }, do: { type: "fill", anchor: "f", value: { text: "2" } } },
      { id: "r3", when: { not: { path: "k", op: "eq", value: "a" } }, do: { type: "fill", anchor: "f", value: { text: "3" } } },
    ],
  });
  const sel = selectRules(t, { data: { k: "a" }, derived: {} });
  assert.deepEqual(sel.active.map((r) => r.id), ["r1", "r2"]);
  assert.deepEqual(sel.inactive.map((r) => r.id), ["r3"]);
});

// ── 조건 평가의 명세 빈틈(결정) ──────────────────────────────────────

test("G1 결정: 숫자로 읽히는 글은 선행·후행 공백 없는 10진수(부호·소수점 허용, 지수 표기는 숫자가 아니다)", () => {
  const ev = (left: unknown, op: string, arg: unknown): boolean => evaluateCondition({ path: "v", op, value: arg } as Condition, { data: { v: left }, derived: {} });
  // 숫자로 읽히는 글
  for (const text of ["5", "+5", "-5", "5.0", ".5", "5.", "-0.5", "007"]) assert.equal(ev(text, "eq", Number(text)), true, `eq(${JSON.stringify(text)})`);
  assert.equal(ev("10", "gt", 9), true, "숫자로 견주면 10 > 9");
  assert.equal(ev("-0.5", "lt", 0), true);
  // 숫자로 읽히지 않는 글: 공백이 붙었거나, 지수 표기, 16진수, 천 단위 쉼표, 단위
  for (const text of [" 5", "5 ", " 5 ", "\t5", "5\n", "1e3", "1E3", "0x10", "1,000", "5원"]) {
    assert.equal(ev(text, "eq", Number.parseFloat(text) || 5), false, `eq(${JSON.stringify(text)})는 글로 견준다`);
  }
  // 글로 견주므로 문자열 순서다: " 5"는 "10"보다 앞, "1e3"은 "999"보다 앞(숫자였다면 1000 > 999)
  assert.equal(ev(" 5", "lt", 10), true, "글 비교: ' 5' < '10'");
  assert.equal(ev("1e3", "gt", 999), false, "1e3은 숫자가 아니라 글 비교: '1e3' < '999'");
  assert.equal(ev("1e3", "lt", 999), true);
  // 양쪽이 숫자 값이면 그대로 숫자다
  assert.equal(ev(1000, "gt", 999), true);
});

test("G1 결정: data의 값이 null이면 derived를 본다(derived에도 없으면 null로 남는다)", () => {
  const ds: Dataset = { data: { a: null, b: null, c: "원천", n: { x: null } }, derived: { a: "파생", c: "파생", n: { x: 7 }, d: "파생만" } };
  assert.deepEqual(lookupPath(ds, "a"), { found: true, value: "파생" });
  assert.deepEqual(lookupPath(ds, "n.x"), { found: true, value: 7 });
  assert.deepEqual(lookupPath(ds, "b"), { found: true, value: null }, "derived에도 없으면 null이다");
  assert.deepEqual(lookupPath(ds, "c"), { found: true, value: "원천" }, "null이 아니면 data가 먼저다");
  const ev = (c: Condition): boolean => evaluateCondition(c, ds);
  assert.equal(ev({ path: "a", op: "exists" }), true);
  assert.equal(ev({ path: "a", op: "eq", value: "파생" }), true);
  assert.equal(ev({ path: "a", op: "empty" }), false);
  assert.equal(ev({ path: "b", op: "exists" }), false);
  assert.equal(ev({ path: "b", op: "empty" }), true);
  // 값 해석도 같다: null인 data 대신 derived의 값을 글로 쓴다
  assert.deepEqual(resolveValue(ds, { path: "a" }, "error"), { kind: "text", text: "파생", path: "a" });
  assert.equal(resolveValue(ds, { path: "b" }, "error").kind, "error");
});

test("G1 결정: 빈 all은 참이고 빈 any는 거짓이다(읽을 때도 거절하지 않는다)", () => {
  const t = readTemplate({
    schema: "hwpx-studio/template@1",
    anchors: [{ id: "f", kind: "field", name: "x" }],
    rules: [
      { id: "all0", when: { all: [] }, do: { type: "fill", anchor: "f", value: { text: "1" } } },
      { id: "any0", when: { any: [] }, do: { type: "fill", anchor: "f", value: { text: "2" } } },
      { id: "not-any0", when: { not: { any: [] } }, do: { type: "fill", anchor: "f", value: { text: "3" } } },
      { id: "not-all0", when: { not: { all: [] } }, do: { type: "fill", anchor: "f", value: { text: "4" } } },
    ],
  });
  const sel = selectRules(t, { data: {}, derived: {} });
  assert.deepEqual(sel.active.map((r) => r.id), ["all0", "not-any0"]);
  assert.deepEqual(sel.inactive.map((r) => r.id), ["any0", "not-all0"]);
});

test("G1 결정: length*는 배열이면 원소 수, 문자열이면 UTF-16 단위 길이다(이모지 2, 결합 글자는 각각)", () => {
  const ev = (v: unknown, op: "lengthEq" | "lengthGt" | "lengthLt", n: number): boolean => evaluateCondition({ path: "v", op, value: n }, { data: { v }, derived: {} });
  assert.equal(ev("😀", "lengthEq", 2), true);
  assert.equal(ev("😀", "lengthEq", 1), false);
  assert.equal(ev("😀", "lengthGt", 1), true);
  assert.equal(ev("a😀b", "lengthEq", 4), true);
  assert.equal(ev("e\u0301", "lengthEq", 2), true, "결합 글자는 묶지 않고 단위로 센다");
  assert.equal(ev("가나다", "lengthEq", 3), true);
  assert.equal(ev(["😀"], "lengthEq", 1), true, "배열은 원소 수");
  assert.equal(ev(["a", "b", "c"], "lengthLt", 4), true);
  assert.equal(ev(12, "lengthEq", 2), false, "숫자는 길이가 없다");
});

// ── 정규식 조건의 실행 시간 막기 ─────────────────────────────────────

const whenMatches = (pattern: unknown): unknown => ({
  schema: "hwpx-studio/template@1",
  anchors: [{ id: "f", kind: "field", name: "x" }],
  rules: [{ id: "r", when: { path: "a", op: "matches", value: pattern }, do: { type: "fill", anchor: "f", value: { text: "x" } } }],
});

test("TPL_CONDITION: matches 패턴이 200자를 넘으면 읽을 때 거절한다(200자는 통과)", () => {
  assert.doesNotThrow(() => readTemplate(whenMatches("a".repeat(200))));
  assert.equal(code(() => readTemplate(whenMatches("a".repeat(201)))), "TPL_CONDITION");
  assert.equal(code(() => readTemplate(whenMatches(`^${"(ab)".repeat(60)}$`))), "TPL_CONDITION", "길이만 본다");
});

test("TPL_CONDITION: 수량자가 붙은 묶음 안에 다시 수량자가 있는 중첩 수량자 패턴은 읽을 때 거절한다", () => {
  for (const pattern of ["^(a+)+$", "(a*)*", "(a+)*", "(a*)+", "(a{2,})+", "(a+){2,}", "^(\\w+\\s?)*$", "^(?:a+)+$", "^((ab)+c)+$", "^(a|b+)*$", "(x(y+)z)+", "^(a{1,3})+$", "^(.*)*$", "^(?<n>a+)+$"]) {
    assert.equal(code(() => readTemplate(whenMatches(pattern))), "TPL_CONDITION", pattern);
  }
});

test("TPL_CONDITION: 중첩 수량자가 아닌 일상적인 패턴은 통과한다(이스케이프·문자 클래스 안의 기호, 묶음만, 수량자만, 고정 횟수)", () => {
  for (const pattern of [
    "^INV-\\d{4}-\\d+$",
    "^(\\d{3})-(\\d{4})$",
    "^(\\d+)-(\\d+)$",
    "^(?:abc|def)+$",
    "^[a+]+$",
    "^([+*])+$",
    "^\\(a+\\)$",
    "^(a{3})+$",
    "^a+b*c?$",
    "^(a)(b)+$",
    "(?=a+)b",
    "^[^()]+(\\+[0-9]+)?$",
  ]) {
    assert.doesNotThrow(() => readTemplate(whenMatches(pattern)), pattern);
  }
});

test("TPL_CONDITION: matches 평가는 입력 글을 10,000자까지만 본다(넘으면 거짓이 아니라 TPL_CONDITION으로 중단, 10,000자는 평가한다)", () => {
  const cond: Condition = { path: "v", op: "matches", value: "^a+$" };
  const ev = (v: unknown): boolean => evaluateCondition(cond, { data: { v }, derived: {} });
  assert.equal(ev("a".repeat(10_000)), true);
  assert.equal(ev(`${"a".repeat(9_999)}b`), false);
  assert.equal(code(() => ev("a".repeat(10_001))), "TPL_CONDITION");
  // 없는 값·배열은 지금처럼 거짓이다(오류가 아니다)
  assert.equal(ev(["a".repeat(20_000)]), false);
  assert.equal(evaluateCondition(cond, { data: {}, derived: {} }), false);
});
