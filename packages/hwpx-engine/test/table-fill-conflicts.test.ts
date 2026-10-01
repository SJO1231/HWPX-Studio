// 독립 검증에서 나온 결함 수정: M1(행 반복과 그 표의 삭제·교체), M2(행 삭제와 표 액션의 EDIT_OVERLAP).
// 기대는 명세에서 정했다: 삭제·교체 범위 안의 액션은 버리고 `report.dropped`에 남기며, 남은 곳에는 그대로 적용되고 게이트를 통과한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFragment, generate, readDataset, readTemplate, type GenerateResult } from "../src/index.ts";
import { loadDoc, readFixture, sha256Hex } from "./helpers.ts";
import { docOf, gridTable, outerTableXml, readCells, sectionText, tableParagraph, textPara, topRows } from "./table-helpers.ts";

type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;
const done = (r: GenerateResult): Done => {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  assert.ok(!r.dryRun);
  return r as Done;
};
const tpl = (spec: { anchors?: unknown[]; rules?: unknown[]; options?: unknown }) => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const cellAnchor = (id: string, row: number, col = 0, ordinal = 0) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal }, row, col });
const tableAnchor = (id = "tbl", ordinal = 0) => ({ id, kind: "object", objectType: "tbl", sectionIndex: 0, ordinal });
const rule = (id: string, action: Record<string, unknown>, when?: unknown) => ({ id, ...(when === undefined ? {} : { when }), do: action });
const run = (bytes: Uint8Array, t: ReturnType<typeof tpl>, data: unknown = {}) => generate(bytes, t, readDataset(data));

// ── M1: 행 반복과 같은 표의 삭제·교체 ───────────────────────────

/** `hancom/ph-table`: 제목 / 3행 2열 표(행 1이 원형) / 맺음말. 표를 담은 문단은 [1]이다. */
function phTable() {
  const bytes = readFixture("hancom/ph-table");
  const doc = loadDoc("hancom/ph-table");
  const par = doc.sections[0]?.paragraphs[1];
  assert.ok(par !== undefined);
  const line = { id: "para", kind: "line", at: { sectionIndex: 0, path: [1] }, print: { text: par.logicalText.slice(0, 40), sha256: sha256Hex(new TextEncoder().encode(par.logicalText)) } };
  const fragment = JSON.parse(JSON.stringify(extractFragment(doc, { sectionIndex: 0, parentPath: [], from: 2, to: 2 })));
  return { bytes, line, fragment };
}
const repeatRule = rule("r", { type: "repeat", anchor: "row", each: { path: "items" } });
/** 표 안의 `{{}}`(성명·비고)와 반복할 배열 */
const FULL = { applicant: { name: "갑" }, note: "비고" };
const ITEMS = { ...FULL, items: [{ n: "a" }, { n: "b" }] };
/** 문서 안 `{{}}` 자리를 버렸다는 암묵 항목을 뺀 버린 규칙 id */
const droppedRules = (r: Done): string[] => r.report.plan.dropped.map((d) => d.ruleId).filter((id) => id !== "implicit");

test("M1: repeat와 같은 표의 delete(object)는 반복을 버리고 dropped에 남긴다 — 표가 지워진다", () => {
  const { bytes } = phTable();
  const t = tpl({ anchors: [cellAnchor("row", 1), tableAnchor()], rules: [repeatRule, rule("d", { type: "delete", anchor: "tbl" })] });
  const r = done(run(bytes, t, ITEMS));
  assert.deepEqual(droppedRules(r), ["r"]);
  assert.ok(!sectionText(r.output).includes("<hp:tbl"), "표가 지워졌어야 한다");
  assert.deepEqual(r.report.plan.actions.map((a) => a.ruleId), ["d"]);
});

test("M1: repeat와 표를 담은 문단의 delete(line)", () => {
  const { bytes, line } = phTable();
  const t = tpl({ anchors: [cellAnchor("row", 1), line], rules: [repeatRule, rule("d", { type: "delete", anchor: "para" })] });
  const r = done(run(bytes, t, ITEMS));
  assert.deepEqual(droppedRules(r), ["r"]);
  assert.ok(!sectionText(r.output).includes("<hp:tbl"));
});

test("M1: repeat와 표를 담은 문단의 replace(inject·insertText)", () => {
  const { bytes, line, fragment } = phTable();
  const inject = tpl({ anchors: [cellAnchor("row", 1), line], rules: [repeatRule, rule("i", { type: "inject", anchor: "para", position: "replace", fragment })] });
  const a = done(run(bytes, inject, ITEMS));
  assert.deepEqual(droppedRules(a), ["r"]);
  assert.ok(!sectionText(a.output).includes("<hp:tbl"), "표를 담은 문단이 교체됐어야 한다");
  const text = tpl({ anchors: [cellAnchor("row", 1), line], rules: [repeatRule, rule("i", { type: "insertText", anchor: "para", position: "replace", value: { text: "바뀐 글" } })] });
  const b = done(run(bytes, text, ITEMS));
  assert.deepEqual(droppedRules(b), ["r"]);
  assert.ok(sectionText(b.output).includes("바뀐 글") && !sectionText(b.output).includes("<hp:tbl"));
});

test("M1: 원소가 0개인 repeat와 표의 delete도 같다(행 삭제 후보가 표 삭제 범위 안이라 버려진다)", () => {
  const { bytes } = phTable();
  const t = tpl({ anchors: [cellAnchor("row", 1), tableAnchor()], rules: [repeatRule, rule("d", { type: "delete", anchor: "tbl" })] });
  const r = done(run(bytes, t, { ...FULL, items: [] }));
  assert.deepEqual(droppedRules(r), ["r"]);
  assert.ok(!sectionText(r.output).includes("<hp:tbl"));
});

test("M1: 삭제·교체가 없으면 repeat는 그대로 된다(대조군)", () => {
  const { bytes } = phTable();
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [repeatRule] });
  const r = done(run(bytes, t, ITEMS));
  assert.deepEqual(r.report.plan.dropped, []);
  assert.equal(topRows(outerTableXml(sectionText(r.output))).length, 4);
});

test("M1: 삭제되는 표에서 반복의 데이터가 없어도(원래는 DATA_MISSING) 버려진 규칙은 오류를 내지 않는다", () => {
  const { bytes } = phTable();
  const t = tpl({ anchors: [cellAnchor("row", 1), tableAnchor()], rules: [repeatRule, rule("d", { type: "delete", anchor: "tbl" })] });
  const r = done(run(bytes, t, FULL));
  assert.deepEqual(droppedRules(r), ["r"]);
});

// ── M2: 행 삭제와 표 액션 ───────────────────────────────────────

/** 4행 3열(열 너비 2000·3000·4000, 행 높이 800). 글은 `r행c열`. */
function listBytes(): Uint8Array {
  const texts = Array.from({ length: 4 }, (_, r) => [0, 1, 2].map((c) => `r${r}c${c}`));
  return docOf([textPara("제목"), tableParagraph(gridTable([2000, 3000, 4000], 4, texts, { id: "7001", repeatHeader: true }, 800)), textPara("끝")]);
}
/** 셀 안 문단 목록의 세로 정렬(표 `pos`의 `vertAlign`과 구별한다) */
const subListAligns = (bytes: Uint8Array, value: string): number => (sectionText(bytes).match(new RegExp(`<hp:subList [^>]*vertAlign="${value}"`, "g")) ?? []).length;
const delRow = (id: string, anchor: string) => rule(id, { type: "delete", anchor, scope: "row" });
const cellsOf = (bytes: Uint8Array) => readCells(outerTableXml(sectionText(bytes)));
const widthsOfRow = (bytes: Uint8Array, row: number): number[] => cellsOf(bytes).filter((c) => c.row === row).map((c) => c.width);
const tableSz = (bytes: Uint8Array): { width: number; height: number } => {
  const m = /<hp:sz width="(\d+)" widthRelTo="ABSOLUTE" height="(\d+)"/.exec(outerTableXml(sectionText(bytes)));
  return { width: Number(m?.[1]), height: Number(m?.[2]) };
};
const rowTexts = (bytes: Uint8Array): string[] => topRows(outerTableXml(sectionText(bytes))).map((x) => [...x.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|"));
const base = [cellAnchor("gone", 2), tableAnchor()];

test("M2: 행 삭제 + resize columns — 지운 행 안의 셀 너비 편집은 빠지고 남은 행에는 그대로 적용된다", () => {
  const t = tpl({ anchors: base, rules: [delRow("d", "gone"), rule("s", { type: "resize", anchor: "tbl", columns: [1000, 1500, 2000] })] });
  const r = done(run(listBytes(), t));
  assert.deepEqual(rowTexts(r.output), ["r0c0|r0c1|r0c2", "r1c0|r1c1|r1c2", "r3c0|r3c1|r3c2"]);
  // 지운 행 뒤의 행은 주소가 당겨진다(원래 3행이 2행이 된다)
  for (const row of [0, 1, 2]) assert.deepEqual(widthsOfRow(r.output, row), [1000, 1500, 2000]);
  assert.equal(tableSz(r.output).width, 4500);
});

test("M2: 행 삭제 + resize width·scale", () => {
  const w = done(run(listBytes(), tpl({ anchors: base, rules: [delRow("d", "gone"), rule("s", { type: "resize", anchor: "tbl", width: 4500 })] })));
  for (const row of [0, 1, 2]) assert.deepEqual(widthsOfRow(w.output, row), [1000, 1500, 2000]);
  assert.equal(tableSz(w.output).width, 4500);
  const s = done(run(listBytes(), tpl({ anchors: base, rules: [delRow("d", "gone"), rule("s", { type: "resize", anchor: "tbl", scale: 2 })] })));
  for (const row of [0, 1, 2]) assert.deepEqual(widthsOfRow(s.output, row), [4000, 6000, 8000]);
  assert.equal(tableSz(s.output).width, 18000);
});

test("M2: 행 삭제 + 지운 행만 가리키는 resize rowHeights는 버리고 dropped에 남긴다 — 표 높이는 그대로", () => {
  const before = tableSz(listBytes());
  const t = tpl({ anchors: base, rules: [delRow("d", "gone"), rule("s", { type: "resize", anchor: "tbl", rowHeights: [{ row: 2, height: 100 }] })] });
  const r = done(run(listBytes(), t));
  assert.deepEqual(r.report.plan.dropped.map((d) => d.ruleId), ["s"]);
  assert.deepEqual(cellsOf(r.output).map((c) => c.height), Array(9).fill(800));
  assert.equal(tableSz(r.output).height, before.height);
});

test("M2: 행 삭제 + 일부만 지운 행을 가리키는 resize rowHeights — 남은 행만 바뀌고 지운 행 항목은 dropped에 남는다", () => {
  const before = tableSz(listBytes());
  const t = tpl({ anchors: base, rules: [delRow("d", "gone"), rule("s", { type: "resize", anchor: "tbl", rowHeights: [{ row: 1, height: 500 }, { row: 2, height: 100 }] })] });
  const r = done(run(listBytes(), t));
  assert.deepEqual(cellsOf(r.output).filter((c) => c.row === 1).map((c) => c.height), [500, 500, 500]);
  assert.deepEqual(cellsOf(r.output).filter((c) => c.row !== 1).map((c) => c.height), Array(6).fill(800));
  assert.equal(tableSz(r.output).height, before.height - 300);
  assert.equal(r.report.plan.dropped.filter((d) => d.ruleId === "s").length, 1);
});

test("M2: 행 삭제 + 지운 행을 포함하는 tableProps.cells — 남은 행에만 적용되고, 지운 행만 가리키는 항목은 dropped에 남는다", () => {
  const props = { vertAlign: "TOP" };
  const t = tpl({ anchors: base, rules: [delRow("d", "gone"), rule("p", { type: "tableProps", anchor: "tbl", cells: [{ rows: [1, 3], cols: [0, 2], props }] })] });
  const r = done(run(listBytes(), t));
  assert.equal(subListAligns(r.output, "TOP"), 6, "행 1·3의 셀 6개");
  assert.deepEqual(r.report.plan.dropped, []);
  const only = tpl({ anchors: base, rules: [delRow("d", "gone"), rule("p", { type: "tableProps", anchor: "tbl", cells: [{ rows: [2, 2], cols: [0, 2], props }] })] });
  const o = done(run(listBytes(), only));
  assert.equal(subListAligns(o.output, "TOP"), 0);
  assert.deepEqual(o.report.plan.dropped.map((d) => d.ruleId), ["p"]);
});

test("M2: 원소가 0개인 repeat(행 삭제) + resize columns·width·scale", () => {
  for (const spec of [{ columns: [1000, 1500, 2000] }, { width: 4500 }, { scale: 0.5 }]) {
    const t = tpl({ anchors: [cellAnchor("gone", 2), tableAnchor()], rules: [rule("r", { type: "repeat", anchor: "gone", each: { path: "items" } }), rule("s", { type: "resize", anchor: "tbl", ...spec })] });
    const r = done(run(listBytes(), t, { items: [] }));
    assert.equal(topRows(outerTableXml(sectionText(r.output))).length, 3, JSON.stringify(spec));
    for (const row of [0, 1, 2]) assert.deepEqual(widthsOfRow(r.output, row), [1000, 1500, 2000], JSON.stringify(spec));
    assert.equal(tableSz(r.output).width, 4500);
  }
});

test("M2: 모든 조합을 한 번에 — 행 삭제 + resize(열 너비) + 다른 규칙의 tableProps(표·셀) + rowHeights", () => {
  const t = tpl({
    anchors: base,
    rules: [
      delRow("d", "gone"),
      rule("s", { type: "resize", anchor: "tbl", columns: [1000, 1500, 2000], rowHeights: [{ row: 0, height: 700 }, { row: 2, height: 1 }] }),
      rule("p", { type: "tableProps", anchor: "tbl", table: { pageBreak: "NONE" }, cells: [{ rows: [0, 3], cols: [1, 1], props: { vertAlign: "BOTTOM" } }] }),
    ],
  });
  const r = done(run(listBytes(), t));
  assert.deepEqual(rowTexts(r.output).length, 3);
  assert.equal(subListAligns(r.output, "BOTTOM"), 3, "행 0·1·3의 둘째 열");
  assert.match(outerTableXml(sectionText(r.output)), /pageBreak="NONE"/);
  assert.deepEqual(cellsOf(r.output).filter((c) => c.row === 0).map((c) => c.height), [700, 700, 700]);
});
