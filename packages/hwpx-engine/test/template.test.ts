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

test("VALUE_CONTROL_CHAR: XML 금지 문자·탭·줄바꿈은 거절하고, insertText 방식은 줄바꿈만 허용한다", () => {
  for (const path of ["nl", "tab", "ctl"]) {
    const r = resolveValue(DS, { path }, "error");
    assert.equal(r.kind === "error" ? r.code : r.kind, "VALUE_CONTROL_CHAR");
    // 오류 메시지에 값 원문이 없다
    assert.ok(r.kind === "error" && !r.message.includes("두") && !r.message.includes("탭") && !r.message.includes("제어"), r.kind === "error" ? r.message : "");
  }
  assert.equal(resolveValue(DS, { path: "nl" }, "error", true).kind, "text");
  assert.equal(resolveValue(DS, { path: "tab" }, "error", true).kind, "error");
  assert.equal(resolveValue(DS, { path: "ctl" }, "error", true).kind, "error");
  assert.equal(resolveValue(DS, { text: "a\u0000b" }, "error").kind, "error");
  assert.equal(checkValueText("정상 &<> \"'"), undefined);
  assert.equal(checkValueText("\r"), "U+000D");
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
  { op: "lengthEq", true: [["abc", 3], [[1, 2], 2], ["가나다", 3], ["😀", 1]], false: [["abc", 2], [5, 1], [null, 0]] },
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
