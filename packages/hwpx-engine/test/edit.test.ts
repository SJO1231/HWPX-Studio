import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  applyPlan,
  mergePlans,
  openPackage,
  readArchive,
  readEntry,
  type EditPlan,
  type SpanEdit,
} from "../src/index.ts";
import { FIXTURE_NAMES, buildHwpx, bytesEqual, readFixture, sectionXml, utf8 } from "./helpers.ts";

const SECTION = "Contents/section0.xml";
const HEADER = "Contents/header.xml";
const ALL_FIXTURES = [
  ...FIXTURE_NAMES,
  "hancom/blocks",
  "hancom/field-states",
  "hancom/header-footer",
  "hancom/ph-mixed",
  "hancom/ph-single",
  "hancom/ph-table",
  "hancom/picture",
  "extra/features-picture",
  "extra/features-rhwp",
];

const emptyPlan = (): EditPlan => ({ edits: [], additions: [], summary: {}, issues: [] });
const planOf = (...edits: SpanEdit[]): EditPlan => ({ ...emptyPlan(), edits });
const edit = (start: number, end: number, expected: string, replacement: string, entry = SECTION, reason = "시험"): SpanEdit => ({
  entry,
  start,
  end,
  expected,
  replacement,
  reason,
});
const text = (bytes: Uint8Array, entry: string): string => {
  const pkg = openPackage(bytes);
  // BOM은 글자(U+FEFF)로 남겨 둔다: 엔진의 오프셋이 그렇게 센다
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(readEntry(pkg.archive, bytes, entry));
};
const throwsCode = (fn: () => unknown, code: string, label = ""): void =>
  assert.throws(fn, (e: unknown) => e instanceof HwpxError && e.code === code, `${label} ${code}가 나와야 한다`);

// ── F1 ──────────────────────────────────────────────────────────────────

for (const name of ALL_FIXTURES) {
  test(`F1 편집이 없는 계획의 applyPlan 결과는 입력과 바이트 동일하다: ${name}`, () => {
    const bytes = readFixture(name);
    const out = applyPlan(openPackage(bytes), emptyPlan());
    assert.ok(bytesEqual(out, bytes));
  });
}

// ── F2 ──────────────────────────────────────────────────────────────────

test("F2 expected가 다른 편집은 EDIT_STALE이다 (어느 편집이든, 다른 편집이 맞아도)", () => {
  const pkg = openPackage(readFixture("D1"));
  const original = text(pkg.bytes, SECTION);
  const at = original.indexOf("첫째 문단");
  assert.ok(at > 0);
  const good = edit(at, at + 2, "첫째", "첫번째");
  const stale = edit(at + 10, at + 12, "틀린값", "x");
  throwsCode(() => applyPlan(pkg, planOf(stale)), "EDIT_STALE");
  throwsCode(() => applyPlan(pkg, planOf(good, stale)), "EDIT_STALE");
  // 길이 0 삽입도 expected는 빈 문자열이어야 한다
  throwsCode(() => applyPlan(pkg, planOf(edit(at, at, "빈 문자열 아님", "x"))), "EDIT_STALE");
  // 오류에는 항목 이름이 붙는다
  assert.throws(
    () => applyPlan(pkg, planOf(stale)),
    (e: unknown) => e instanceof HwpxError && e.where === SECTION,
  );
});

test("F2 겹치는 편집은 EDIT_OVERLAP이다 (부분 겹침·포함·같은 구간·구간 안쪽 삽입, 순서와 무관)", () => {
  const pkg = openPackage(readFixture("D1"));
  const original = text(pkg.bytes, SECTION);
  const at = original.indexOf("첫째 문단입니다");
  const sub = (s: number, e: number) => original.slice(at + s, at + e);
  const cases: [string, SpanEdit, SpanEdit][] = [
    ["부분 겹침", edit(at, at + 4, sub(0, 4), "A"), edit(at + 2, at + 6, sub(2, 6), "B")],
    ["포함", edit(at, at + 8, sub(0, 8), "A"), edit(at + 2, at + 4, sub(2, 4), "B")],
    ["같은 구간", edit(at, at + 4, sub(0, 4), "A"), edit(at, at + 4, sub(0, 4), "B")],
    ["같은 시작·다른 끝", edit(at, at + 4, sub(0, 4), "A"), edit(at, at + 6, sub(0, 6), "B")],
    ["구간 안쪽 삽입", edit(at, at + 6, sub(0, 6), "A"), edit(at + 3, at + 3, "", "B")],
  ];
  for (const [label, a, b] of cases) {
    throwsCode(() => applyPlan(pkg, planOf(a, b)), "EDIT_OVERLAP", label);
    throwsCode(() => applyPlan(pkg, planOf(b, a)), "EDIT_OVERLAP", label);
  }
});

test("F2 겹치지 않는 편집은 허용한다: 맞닿은 구간, 구간 경계의 삽입, 다른 항목의 같은 구간", () => {
  const pkg = openPackage(readFixture("D1"));
  const original = text(pkg.bytes, SECTION);
  const at = original.indexOf("첫째 문단입니다");
  const a = edit(at, at + 3, original.slice(at, at + 3), "[A]");
  const b = edit(at + 3, at + 5, original.slice(at + 3, at + 5), "[B]"); // a에 맞닿음
  const insStart = edit(at, at, "", "<시작>"); // a의 시작 위치 삽입
  const insEnd = edit(at + 5, at + 5, "", "<끝>"); // b의 끝 위치 삽입
  const out = text(applyPlan(pkg, planOf(b, insEnd, a, insStart)), SECTION);
  const expected = original.slice(0, at) + "<시작>[A][B]<끝>" + original.slice(at + 5);
  assert.equal(out, expected);
  // 항목이 다르면 같은 오프셋이어도 겹치지 않는다
  const headerAt = text(pkg.bytes, HEADER).indexOf("hh:refList");
  const h = edit(headerAt, headerAt, "", "<!--h-->", HEADER);
  const out2 = applyPlan(pkg, planOf(edit(headerAt, headerAt, "", "<!--s-->", SECTION), h));
  assert.ok(text(out2, HEADER).includes("<!--h-->") && text(out2, SECTION).includes("<!--s-->"));
});

// ── applyPlan의 동작 ────────────────────────────────────────────────────

test("7.1 같은 위치의 길이 0 삽입은 계획에 실린 순서를 지킨다", () => {
  const pkg = openPackage(readFixture("D1"));
  const original = text(pkg.bytes, SECTION);
  const at = original.indexOf("<hp:p ");
  const plan = planOf(edit(at, at, "", "<!--1-->"), edit(at, at, "", "<!--2-->"), edit(at, at, "", "<!--3-->"));
  assert.equal(text(applyPlan(pkg, plan), SECTION), original.slice(0, at) + "<!--1--><!--2--><!--3-->" + original.slice(at));
  const reversed = planOf(edit(at, at, "", "<!--3-->"), edit(at, at, "", "<!--2-->"), edit(at, at, "", "<!--1-->"));
  assert.equal(text(applyPlan(pkg, reversed), SECTION), original.slice(0, at) + "<!--3--><!--2--><!--1-->" + original.slice(at));
});

test("7.1 편집한 항목만 바뀌고 나머지 로컬 레코드는 바이트 동일하다. 결과는 다시 열린다", () => {
  const bytes = readFixture("D1");
  const pkg = openPackage(bytes);
  const original = text(bytes, SECTION);
  const at = original.indexOf("첫째 문단");
  const out = applyPlan(pkg, planOf(edit(at, at + 2, "첫째", "여럿째")));
  // 독립 계산: 문자열 조각을 직접 이어 붙인다
  assert.equal(text(out, SECTION), original.slice(0, at) + "여럿째" + original.slice(at + 2));
  const before = readArchive(bytes);
  const after = readArchive(out);
  assert.deepEqual(after.entries.map((e) => e.name), before.entries.map((e) => e.name));
  for (const e of before.entries) {
    const o = after.entries.find((x) => x.name === e.name);
    assert.ok(o !== undefined);
    if (e.name === SECTION) continue;
    assert.ok(bytesEqual(bytes.subarray(e.localStart, e.localEnd), out.subarray(o.localStart, o.localEnd)), `${e.name}의 로컬 레코드가 달라졌다`);
  }
  assert.notEqual(text(out, HEADER), "");
  assert.equal(text(out, HEADER), text(bytes, HEADER));
});

test("7.1 오프셋은 UTF-16 단위다: 보충 평면 문자(이모지) 뒤의 편집", () => {
  const pkg = openPackage(buildHwpx(['<hp:p><hp:run><hp:t>😀 가나 😀 다라</hp:t></hp:run></hp:p>']));
  const original = text(pkg.bytes, SECTION);
  const at = original.indexOf("다라");
  assert.equal(original.charCodeAt(original.indexOf("😀") + 1) >= 0xdc00, true, "이모지는 서로게이트 쌍이다");
  const out = text(applyPlan(pkg, planOf(edit(at, at + 2, "다라", "마바"))), SECTION);
  assert.equal(out, original.replace("다라", "마바"));
  assert.equal([...out].filter((c) => c === "😀").length, 2);
});

test("7.1 원본의 BOM은 유지한다", () => {
  const bom = String.fromCharCode(0xfeff);
  const bytes = buildHwpx([bom + sectionXml("<hp:p><hp:run><hp:t>가나</hp:t></hp:run></hp:p>")], undefined, true);
  const pkg = openPackage(bytes);
  const raw = readEntry(pkg.archive, bytes, SECTION);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const original = text(bytes, SECTION);
  const at = original.indexOf("가나");
  const out = applyPlan(pkg, planOf(edit(at, at + 2, "가나", "다라")));
  const outPkg = openPackage(out);
  const outRaw = readEntry(outPkg.archive, out, SECTION);
  assert.deepEqual([...outRaw.subarray(0, 3)], [0xef, 0xbb, 0xbf], "결과도 BOM으로 시작한다");
  assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(outRaw), original.replace("가나", "다라"));
});

test("7.1 범위가 올바르지 않은 편집은 EDIT_RANGE이다", () => {
  const pkg = openPackage(readFixture("D1"));
  const length = text(pkg.bytes, SECTION).length;
  throwsCode(() => applyPlan(pkg, planOf(edit(-1, 0, "", "x"))), "EDIT_RANGE");
  throwsCode(() => applyPlan(pkg, planOf(edit(5, 4, "", "x"))), "EDIT_RANGE");
  throwsCode(() => applyPlan(pkg, planOf(edit(length, length + 1, "", "x"))), "EDIT_RANGE");
  throwsCode(() => applyPlan(pkg, planOf(edit(0.5, 1, "", "x"))), "EDIT_RANGE");
  // 끝 위치(length)의 삽입은 범위 안이다
  const out = text(applyPlan(pkg, planOf(edit(length, length, "", "<!--끝-->"))), SECTION);
  assert.ok(out.endsWith("<!--끝-->"));
});

test("7.1 없는 항목을 편집하면 PKG_MISSING, mimetype 편집은 PKG_MIMETYPE_LOCKED", () => {
  const pkg = openPackage(readFixture("D1"));
  throwsCode(() => applyPlan(pkg, planOf(edit(0, 0, "", "x", "Contents/none.xml"))), "PKG_MISSING");
  throwsCode(() => applyPlan(pkg, planOf(edit(0, 0, "", "x", "mimetype"))), "PKG_MIMETYPE_LOCKED");
});

test("7.1 추가 항목은 기존 레코드 뒤에 붙고 내용이 그대로 읽힌다. 이름 중복은 PKG_DUP_ENTRY", () => {
  const bytes = readFixture("D1");
  const pkg = openPackage(bytes);
  const data = new Uint8Array([1, 2, 3, 4, 5, 0, 255]);
  const out = applyPlan(pkg, { ...emptyPlan(), additions: [{ name: "BinData/x.bin", data, method: 8 }] });
  const outPkg = openPackage(out);
  assert.deepEqual([...readEntry(outPkg.archive, out, "BinData/x.bin")], [...data]);
  assert.deepEqual(
    outPkg.archive.entries.map((e) => e.name).slice(0, pkg.archive.entries.length),
    pkg.archive.entries.map((e) => e.name),
  );
  for (const e of pkg.archive.entries) {
    const o = outPkg.archive.entries.find((x) => x.name === e.name);
    assert.ok(o !== undefined && bytesEqual(bytes.subarray(e.localStart, e.localEnd), out.subarray(o.localStart, o.localEnd)));
  }
  throwsCode(() => applyPlan(pkg, { ...emptyPlan(), additions: [{ name: SECTION, data, method: 0 }] }), "PKG_DUP_ENTRY");
  throwsCode(() => applyPlan(pkg, { ...emptyPlan(), additions: [{ name: "mimetype", data, method: 0 }] }), "PKG_MIMETYPE_LOCKED");
});

// ── mergePlans ──────────────────────────────────────────────────────────

test("7.1 mergePlans: 편집·추가·경고를 이어 붙이고 요약은 같은 키끼리 더한다", () => {
  const warn = { severity: "warning" as const, code: "X_Y", message: "m" };
  const a: EditPlan = {
    edits: [edit(10, 12, "", "A", SECTION)],
    additions: [{ name: "BinData/a.png", data: new Uint8Array([1]), method: 0 }],
    summary: { addedResources: 2, reissuedIds: 1 },
    issues: [warn],
  };
  const b: EditPlan = {
    edits: [edit(20, 20, "", "B", SECTION), edit(5, 5, "", "H", HEADER)],
    additions: [{ name: "BinData/b.png", data: new Uint8Array([2]), method: 0 }],
    summary: { addedResources: 3, reusedResources: 4 },
    issues: [],
  };
  // a의 [10,12) expected는 빈 문자열이 아니지만 병합은 원문을 읽지 않으므로 겹침만 본다
  const merged = mergePlans(a, b);
  assert.equal(merged.edits.length, 3);
  assert.deepEqual(merged.additions.map((x) => x.name), ["BinData/a.png", "BinData/b.png"]);
  assert.deepEqual(merged.summary, { addedResources: 5, reissuedIds: 1, reusedResources: 4 });
  assert.deepEqual(merged.issues, [warn]);
  // 입력 계획은 바뀌지 않는다
  assert.equal(a.edits.length, 1);
  assert.deepEqual(a.summary, { addedResources: 2, reissuedIds: 1 });
});

test("7.1 mergePlans: 같은 항목에서 구간이 겹치면 EDIT_OVERLAP, 항목이 다르면 겹치지 않는다", () => {
  const a = planOf(edit(10, 20, "", "A"));
  throwsCode(() => mergePlans(a, planOf(edit(15, 25, "", "B"))), "EDIT_OVERLAP");
  throwsCode(() => mergePlans(a, planOf(edit(12, 12, "", "B"))), "EDIT_OVERLAP");
  assert.equal(mergePlans(a, planOf(edit(15, 25, "", "B", HEADER))).edits.length, 2);
  assert.equal(mergePlans(a, planOf(edit(20, 20, "", "B"))).edits.length, 2, "구간 끝 위치의 삽입은 겹치지 않는다");
});

test("7.1 mergePlans 결과를 적용한 것은 두 계획을 차례로 적용한 것과 같은 글이다 (겹치지 않을 때)", () => {
  const pkg = openPackage(readFixture("D1"));
  const original = text(pkg.bytes, SECTION);
  const x = original.indexOf("첫째 문단");
  const y = original.indexOf("둘째 수준");
  const a = planOf(edit(x, x + 2, "첫째", "A"));
  const b = planOf(edit(y, y + 2, "둘째", "B"));
  const merged = text(applyPlan(pkg, mergePlans(a, b)), SECTION);
  assert.equal(merged, original.slice(0, x) + "A" + original.slice(x + 2, y) + "B" + original.slice(y + 2));
  assert.equal(utf8(merged).length > 0, true);
});
