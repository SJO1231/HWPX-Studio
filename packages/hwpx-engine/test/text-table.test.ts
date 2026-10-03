// md·txt 어댑터의 표 액션: repeat(md 표 행 복제), tableProps·resize(텍스트에는 없어 건너뜀), inject의 fitTable(무시). 명세 7.9·9절.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { isTableNode, listTables } from "../src/index.ts";
import { generate } from "../src/fill/index.ts";
import { DATASET_SCHEMA, readDataset, readTemplate, type MissingPolicy, type Template } from "../src/template/index.ts";
import { buildTextPlan, checkTextOutput, generateText, parseText, type TextFragment, type TextKind, type TextOptions, type TextResult } from "../src/text/index.ts";
import { mutateEntryText, readFixture, reparse } from "./helpers.ts";

// ── 도구 ────────────────────────────────────────────────────────

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const tpl = (spec: { anchors?: unknown[]; rules?: unknown[]; options?: unknown }): Template => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const cellAnchor = (id: string, row: number, col = 0, ordinal = 0) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal }, row, col });
const lineAnchor = (id: string, ordinal: number, logical: string) => ({ id, kind: "line", at: { sectionIndex: 0, path: [ordinal] }, print: { text: logical.slice(0, 40), sha256: sha(logical) } });
const FRAGMENT: TextFragment = { schema: "hwpx-studio/text-fragment@1", blocks: ["새 문단"] };
const rule = (id: string, action: Record<string, unknown>, when?: unknown) => ({ id, ...(when === undefined ? {} : { when }), do: action });
const repeatRule = (id = "r", anchor = "row", extra: Record<string, unknown> = {}) => rule(id, { type: "repeat", anchor, each: { path: "items" }, index: "no", ...extra });

type Done = Extract<TextResult, { ok: true; dryRun: false }>;
const run = (text: string, template: Template, data: unknown, options: TextOptions = {}, kind: TextKind = "md"): TextResult => generateText(text, kind, template, readDataset(data), options);
const done = (r: TextResult): Done => {
  assert.ok(r.ok && !r.dryRun, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  return r as Done;
};
const errorCodes = (r: TextResult): string[] => {
  assert.equal(r.ok, false, "생성이 성공해 버렸다");
  assert.ok(!("output" in r), "실패인데 출력이 있다");
  return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
};

/** 머리행 + 반복할 데이터 행(원형) + 합계 행. 표 앞뒤에 문단이 있다. */
const LIST = ["# 목록", "", "| 번호 | 이름 | 내용 |", "| --- | --- | --- |", "| {{no}} | {{item.name}} | {{item.note}} / {{project}} |", "| 합계 | | |", "", "끝", ""].join("\n");
const ITEMS = [
  { name: "갑", note: "가" },
  { name: "을", note: "나" },
  { name: "병", note: "다" },
];
const DATA = { project: "P", items: ITEMS };
const rows = (n: number): string[] => ITEMS.slice(0, n).map((x, i) => `| ${i + 1} | ${x.name} | ${x.note} / P |`);
const listWith = (dataRows: string[]): string => ["# 목록", "", "| 번호 | 이름 | 내용 |", "| --- | --- | --- |", ...dataRows, "| 합계 | | |", "", "끝", ""].join("\n");
const repeatTemplate = (extraRules: unknown[] = [], extraAnchors: unknown[] = [], extra: Record<string, unknown> = {}) => tpl({ anchors: [cellAnchor("row", 1), ...extraAnchors], rules: [repeatRule("r", "row", extra), ...extraRules] });

// ── repeat: 길이 0·1·여러 개 ────────────────────────────────────

test("repeat: 원소가 여럿이면 원형 행이 원소마다 한 줄이 된다 — 원소·순번·전체 데이터 값, 수량 예고, 다른 글은 그대로", () => {
  const r = done(run(LIST, repeatTemplate(), DATA));
  assert.equal(r.output, listWith(rows(3)));
  const plan = r.report.plan;
  assert.deepEqual(plan.actions, [{ ruleId: "r", type: "repeat", anchor: "row", targets: 3 }]);
  assert.deepEqual(plan.expected, { tableRows: 2 });
  // 읽는 데이터 경로는 전체 데이터의 것만이다(원소 이름·순번 이름은 데이터에 없다). 반복 행 안 `{{}}`는 DATA_MISSING을 내지 않는다
  assert.deepEqual(plan.requiredPaths, ["items", "project"]);
  assert.deepEqual(plan.missingPaths, []);
  assert.deepEqual(plan.dropped, []);
  assert.equal(r.report.reread.tables, 1);
  // 편집은 원형 행 줄 하나를 바꾸는 것뿐이다
  assert.equal(r.report.edits.length, 1);
});

test("repeat: 원소가 하나면 원형 행이 그 원소로 채워진 한 줄이 된다(수량 증감 없음)", () => {
  const r = done(run(LIST, repeatTemplate(), { project: "P", items: [ITEMS[0]] }));
  assert.equal(r.output, listWith(rows(1)));
  assert.deepEqual(r.report.plan.actions, [{ ruleId: "r", type: "repeat", anchor: "row", targets: 1 }]);
  assert.deepEqual(r.report.plan.expected, {});
});

test("repeat: 원소가 0개면 원형 행을 지운다(행 삭제 규칙과 같은 결과) — 보고서에는 repeat 0행으로 남는다", () => {
  const r = done(run(LIST, repeatTemplate(), { project: "P", items: [] }));
  assert.equal(r.output, listWith([]));
  assert.deepEqual(r.report.plan.actions, [{ ruleId: "r", type: "repeat", anchor: "row", targets: 0 }]);
  assert.deepEqual(r.report.plan.expected, { tableRows: -1 });
  // 같은 행을 지우는 삭제 규칙을 쓴 결과와 같다
  const del = done(run(LIST, tpl({ anchors: [cellAnchor("row", 1)], rules: [rule("d", { type: "delete", anchor: "row", scope: "row" })] }), DATA));
  assert.equal(r.output, del.output);
  assert.deepEqual(del.report.plan.expected, { tableRows: -1 });
});

test("repeat: 데이터에 배열이 없을 때 누락 정책(error 거절, empty는 행 삭제, keep은 행 그대로)과 배열이 아닌 값", () => {
  const none = { project: "P" };
  assert.deepEqual(errorCodes(run(LIST, repeatTemplate(), none)), ["DATA_MISSING"]);
  assert.equal(done(run(LIST, repeatTemplate(), none, { missing: "empty" })).output, listWith([]));
  // keep: 행을 그대로 두고 그 안의 {{}}도 남긴다(남은 {{}} 검사에 걸리지 않는다)
  const kept = done(run(LIST, repeatTemplate(), none, { missing: "keep" }));
  assert.equal(kept.output, LIST);
  assert.deepEqual(kept.report.plan.kept, [{ path: "items", count: 1 }]);
  assert.deepEqual(kept.report.plan.actions, []);
  assert.deepEqual(errorCodes(run(LIST, repeatTemplate(), { project: "P", items: "x" })), ["DATA_NOT_ARRAY"]);
  assert.deepEqual(errorCodes(run(LIST, repeatTemplate(), { project: "P", items: { name: "갑" } })), ["DATA_NOT_ARRAY"]);
});

test("repeat: 원소 이름(as)과 순번 이름(index)을 바꾸고, 순번을 안 주면 순번 이름은 데이터에서 읽는다", () => {
  const text = ["| a | b |", "| --- | --- |", "| {{row.name}} | {{n}} / {{project}} |", ""].join("\n");
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "items" }, as: "row", index: "n" })] });
  assert.equal(done(run(text, t, DATA)).output, ["| a | b |", "| --- | --- |", "| 갑 | 1 / P |", "| 을 | 2 / P |", "| 병 | 3 / P |", ""].join("\n"));
  // 원소가 문자열이면 원소 이름 자체를 쓴다. 순번 이름을 주지 않으면 {{n}}은 전체 데이터에서 찾는다
  const plain = ["| a |", "| --- |", "| {{item}}-{{n}} |", ""].join("\n");
  const t2 = tpl({ anchors: [cellAnchor("row", 1)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "items" } })] });
  assert.equal(done(run(plain, t2, { items: ["x", "y"], n: "N" })).output, ["| a |", "| --- |", "| x-N |", "| y-N |", ""].join("\n"));
});

// ── repeat: 머리행 거절과 앵커 ──────────────────────────────────

test("repeat: 머리행을 가리키면 FILL_TABLE_HEADER로 거절한다(원소 수와 무관, 출력 없음)", () => {
  const plainTable = ["| 항목 | 내용 |", "| --- | --- |", "| 값 | 값 |", ""].join("\n");
  for (const data of [DATA, { project: "P", items: [] }]) {
    const t = tpl({ anchors: [cellAnchor("row", 0)], rules: [repeatRule()] });
    assert.deepEqual(errorCodes(run(plainTable, t, data)), ["FILL_TABLE_HEADER"]);
  }
  // 구분선 행(`| --- |`)은 앵커로 가리킬 수 없다: 행 번호는 머리행(0) 다음에 데이터 행(1)이 온다. 없는 행은 ANCHOR_NOT_FOUND
  const t = tpl({ anchors: [cellAnchor("row", 9)], rules: [repeatRule()] });
  assert.deepEqual(errorCodes(run(plainTable, t, DATA)), ["ANCHOR_NOT_FOUND"]);
});

test("repeat: 표가 여럿이면 앵커의 표 서수가 가리키는 표만 반복한다", () => {
  const two = ["| a |", "| --- |", "| {{item}} |", "", "문단", "", "| b |", "| --- |", "| {{item}} |", ""].join("\n");
  const t = tpl({ anchors: [cellAnchor("row", 1, 0, 1)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "items" } })] });
  // 첫째 표의 {{item}}은 반복 행이 아니라 일반 채움이라 데이터에 없는 경로다: 기본 정책은 거절. keep이면 그대로 남고 둘째 표만 반복한다
  assert.deepEqual(errorCodes(run(two, t, { items: ["x", "y"] })), ["DATA_MISSING"]);
  const kept = done(run(two, t, { items: ["x", "y"] }, { missing: "keep" }));
  assert.equal(kept.output, ["| a |", "| --- |", "| {{item}} |", "", "문단", "", "| b |", "| --- |", "| x |", "| y |", ""].join("\n"));
});

test("repeat: txt에는 표가 없으므로 앵커 해석 오류가 그대로 난다", () => {
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [repeatRule()] });
  assert.deepEqual(errorCodes(run("가\n나\n", t, DATA, {}, "txt")), ["ANCHOR_NOT_FOUND"]);
});

// ── repeat: 값의 쓰임 ───────────────────────────────────────────

test("repeat: 값에 `|`가 있으면 칸 규칙대로 `\\|`로 쓰고 칸 수가 유지된다. 줄바꿈이 있으면 거절한다", () => {
  const r = done(run(LIST, repeatTemplate(), { project: "P", items: [{ name: "a|b", note: "x" }] }));
  assert.equal(r.output, listWith(["| 1 | a\\|b | x / P |"]));
  assert.equal(r.report.issues.filter((i) => i.code === "VAL_TABLE_COLS").length, 0);
  assert.deepEqual(errorCodes(run(LIST, repeatTemplate(), { project: "P", items: [{ name: "a\nb", note: "x" }] })), ["VALUE_CONTROL_CHAR"]);
});

test("repeat: 원소의 값이 없을 때 누락 정책 — error 거절, empty는 빈 칸, keep은 {{}} 그대로", () => {
  const data = { project: "P", items: [{ name: "갑" }] };
  assert.deepEqual(errorCodes(run(LIST, repeatTemplate(), data)), ["DATA_MISSING"]);
  assert.equal(done(run(LIST, repeatTemplate(), data, { missing: "empty" })).output, listWith(["| 1 | 갑 |  / P |"]));
  const kept = done(run(LIST, repeatTemplate(), data, { missing: "keep" }));
  assert.equal(kept.output, listWith(["| 1 | 갑 | {{item.note}} / P |"]));
  assert.deepEqual(kept.report.plan.kept, [{ path: "item.note", count: 1 }]);
});

test("repeat: 줄바꿈 방식(CRLF)과 BOM, 파일 끝 줄바꿈 없음을 지키고 복사본은 그 줄의 줄바꿈으로 잇는다", () => {
  const src = "﻿" + ["| 이름 | 번호 |", "| --- | --- |", "| {{item.name}} | {{no}} |"].join("\r\n");
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [repeatRule()] });
  const r = done(run(src, t, { items: [{ name: "갑" }, { name: "을" }] }));
  assert.equal(r.output, "﻿" + ["| 이름 | 번호 |", "| --- | --- |", "| 갑 | 1 |", "| 을 | 2 |"].join("\r\n"));
  // 줄바꿈이 섞여 있어도 원형 행 줄의 줄바꿈을 따른다
  const mixed = "| 이름 | 번호 |\n| --- | --- |\r\n| {{item.name}} | {{no}} |\r\n| 끝 | |\n";
  assert.equal(done(run(mixed, t, { items: [{ name: "갑" }, { name: "을" }] })).output, "| 이름 | 번호 |\n| --- | --- |\r\n| 갑 | 1 |\r\n| 을 | 2 |\r\n| 끝 | |\n");
});

test("repeat: 같은 입력이면 출력과 보고서가 같다(결정성)", () => {
  const a = done(run(LIST, repeatTemplate(), DATA));
  const b = done(run(LIST, repeatTemplate(), DATA));
  assert.equal(a.output, b.output);
  assert.deepEqual(a.report, b.report);
  // 계획까지만(dryRun)도 같은 계획이고 출력은 없다
  const dry = run(LIST, repeatTemplate(), DATA, { dryRun: true });
  assert.ok(dry.ok && dry.dryRun);
  assert.deepEqual(dry.report.plan, a.report.plan);
});

// ── repeat: 다른 규칙과 겹칠 때 ─────────────────────────────────

test("repeat: 같은 원형 행을 지우는 규칙은 버리고, 그 행 칸을 채우는 규칙도 버린다(보고서에 남는다)", () => {
  const t = repeatTemplate([rule("d", { type: "delete", anchor: "row", scope: "row" }), rule("f", { type: "fill", anchor: "cell", value: { text: "X" } })], [cellAnchor("cell", 1, 1)]);
  const r = done(run(LIST, t, DATA));
  assert.equal(r.output, listWith(rows(3)));
  const dropped = r.report.plan.dropped.map((d) => `${d.ruleId}:${d.reason}`).sort();
  assert.deepEqual(dropped, ["d:반복하는 원형 행을 지우는 규칙이라 버렸습니다.", "f:삭제·교체되는 범위 안의 자리 1곳을 버렸습니다."]);
  assert.deepEqual(r.report.plan.actions.map((a) => a.ruleId), ["r"]);
});

test("repeat: 같은 행을 반복하는 규칙이 둘이면 TPL_CONFLICT", () => {
  const t = tpl({ anchors: [cellAnchor("row", 1), cellAnchor("row2", 1, 2)], rules: [repeatRule("r1", "row"), repeatRule("r2", "row2")] });
  assert.deepEqual(errorCodes(run(LIST, t, DATA)), ["TPL_CONFLICT"]);
});

test("repeat: 다른 행의 삭제·채움은 그대로 되고, 표 블록이 지워지면 반복은 버린다", () => {
  // 합계 행(2)을 지우는 규칙과 함께: 반복 행 바로 뒤 줄이 지워진다
  const t = repeatTemplate([rule("d", { type: "delete", anchor: "tail", scope: "row" })], [cellAnchor("tail", 2)]);
  const r = done(run(LIST, t, DATA));
  assert.equal(r.output, ["# 목록", "", "| 번호 | 이름 | 내용 |", "| --- | --- | --- |", ...rows(3), "", "끝", ""].join("\n"));
  assert.deepEqual(r.report.plan.expected, { tableRows: 1 });
  // 표 전체를 지우면 반복은 버린다
  const gone = repeatTemplate([rule("g", { type: "delete", anchor: "all" })], [{ id: "all", kind: "object", objectType: "table", sectionIndex: 0, ordinal: 0 }]);
  const g = done(run(LIST, gone, DATA));
  assert.deepEqual(g.report.plan.dropped.map((d) => d.ruleId), ["r"]);
  assert.equal(parseText(g.output, "md").blocks.some((b) => b.kind === "table"), false);
});

test("repeat: 반복 행 앞의 줄을 지우거나 뒤에 글을 넣어도 편집이 겹치지 않는다", () => {
  const t = repeatTemplate([rule("i", { type: "inject", anchor: "end", position: "after", fragment: "f.json" })], [lineAnchor("end", 2, "끝")]);
  const r = done(run(LIST, t, DATA, { fragments: { "f.json": FRAGMENT } }));
  assert.equal(r.output, listWith(rows(3)).replace(/끝\n$/, "끝\n\n새 문단\n"));
});

// ── 값 재읽기와 수량 검사 ───────────────────────────────────────

test("출력 검사: 반복한 행을 다시 읽어 계획과 견주고, 행 수 증감은 수량 검사가 본다", () => {
  const doc = parseText(LIST, "md");
  const { plan, report } = buildTextPlan(doc, repeatTemplate(), readDataset(DATA));
  assert.equal(report.issues.filter((i) => i.severity === "error").length, 0);
  assert.equal(plan.repeats?.length, 1);
  const okOut = done(run(LIST, repeatTemplate(), DATA)).output;
  const codes = (p: typeof plan, out: string) => checkTextOutput(doc, p, out).issues.map((i) => `${i.severity}:${i.code}`);
  assert.deepEqual(codes(plan, okOut), []);
  // 계획의 기대를 어긋나게 하면(칸 글이 다르다고 하면) 값 재읽기가 잡는다
  const bad = { ...plan, repeats: [{ start: plan.repeats?.[0]?.start ?? 0, rows: [["1", "갑", "가 / P"], ["2", "다른 값", "나 / P"], ["3", "병", "다 / P"]] }] };
  assert.deepEqual(codes(bad, okOut), ["error:REREAD_TEXT"]);
  // 예상 수량(표 행 수)이 다르면 PRESERVE_CENSUS
  const shortDelta = { ...plan, delta: { ...plan.delta, tableRows: 1 } };
  assert.ok(codes(shortDelta, okOut).includes("error:PRESERVE_CENSUS"));
  // 적용 직후 출력을 일부러 망가뜨리면(한 행을 지운다) 게이트가 거절한다
  const hook = run(LIST, repeatTemplate(), DATA, { testHooks: { afterApply: (o) => o.replace("| 2 | 을 | 나 / P |\n", "") } });
  assert.ok(errorCodes(hook).some((c) => c === "PRESERVE_SPAN" || c === "PRESERVE_CENSUS"));
});

// ── tableProps·resize: 건너뜀, fitTable: 무시 ───────────────────

const HWPX_ONLY_RULES = [
  rule("p", { type: "tableProps", anchor: "tbl", table: { pageBreak: "NONE", treatAsChar: false } }),
  rule("s", { type: "resize", anchor: "tbl", scale: 0.5 }),
  rule("q", { type: "tableProps", anchor: "cell", cells: [{ rows: [0, 0], cols: [0, 0], props: { vertAlign: "TOP" } }] }),
];

test("tableProps·resize: 텍스트에는 표 설정·크기가 없어 적용하지 않고 TEXT_NOT_APPLICABLE로 건너뛴다(오류 아님) — 그 밖의 규칙만 반영된다", () => {
  // 앵커는 hwpx 표의 object(tbl)여도 텍스트에서 풀지 않는다
  const anchors = [{ id: "tbl", kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 0 }, cellAnchor("cell", 0, 0), cellAnchor("row", 1)];
  const withProps = tpl({ anchors, rules: [...HWPX_ONLY_RULES, repeatRule()] });
  const without = tpl({ anchors, rules: [repeatRule()] });
  const r = done(run(LIST, withProps, DATA));
  assert.equal(r.output, done(run(LIST, without, DATA)).output);
  assert.equal(r.output, listWith(rows(3)));
  assert.deepEqual(
    r.report.plan.skipped.map((s) => [s.ruleId, s.anchor, s.code]),
    [["p", "tbl", "TEXT_NOT_APPLICABLE"], ["s", "tbl", "TEXT_NOT_APPLICABLE"], ["q", "cell", "TEXT_NOT_APPLICABLE"]],
  );
  assert.ok(r.report.plan.skipped.every((s) => s.message.length > 0 && !s.message.includes("{{")));
  assert.deepEqual(r.report.plan.actions.map((a) => a.ruleId), ["r"]);
  // 조건이 거짓인 규칙은 건너뜀으로도 남기지 않는다(비활성으로만 보고한다)
  const off = tpl({ anchors, rules: [rule("p", { type: "tableProps", anchor: "tbl", table: { pageBreak: "NONE" } }, { path: "no.such", op: "exists" }), repeatRule()] });
  const o = done(run(LIST, off, DATA));
  assert.deepEqual(o.report.plan.skipped, []);
  assert.deepEqual(o.report.plan.inactiveRules, ["p"]);
  // txt에서도 오류가 아니다(앵커를 풀지 않는다)
  const txt = done(run("가\n나\n", tpl({ anchors, rules: HWPX_ONLY_RULES }), {}, {}, "txt"));
  assert.equal(txt.output, "가\n나\n");
  assert.equal(txt.report.plan.skipped.length, 3);
});

test("inject의 fitTable은 텍스트에서 무시한다 — 주입은 수행하고 건너뜀으로도 남기지 않는다", () => {
  const t = tpl({ anchors: [lineAnchor("end", 2, "끝")], rules: [rule("i", { type: "inject", anchor: "end", position: "after", fragment: "f.json", fitTable: "allowBreak" })] });
  const r = done(run(LIST.replace(/\| \{\{no\}\}.*\n/, "| 1 | 갑 | 가 / P |\n"), t, DATA, { fragments: { "f.json": FRAGMENT } }));
  assert.ok(r.output.endsWith("끝\n\n새 문단\n"));
  assert.deepEqual(r.report.plan.skipped, []);
  assert.deepEqual(r.report.plan.tableChanges, []);
  // fitTable이 없는 같은 규칙과 출력이 같다
  const plain = tpl({ anchors: [lineAnchor("end", 2, "끝")], rules: [rule("i", { type: "inject", anchor: "end", position: "after", fragment: "f.json" })] });
  assert.equal(done(run(LIST.replace(/\| \{\{no\}\}.*\n/, "| 1 | 갑 | 가 / P |\n"), plain, DATA, { fragments: { "f.json": FRAGMENT } })).output, r.output);
});

// ── 같은 템플릿·데이터를 hwpx와 md에 ────────────────────────────

/** `tables/tables-inline`의 둘째 행(a·b·c)을 반복 행 원형으로 바꾼다 */
function repeatFixture(): Uint8Array {
  return mutateEntryText(readFixture("tables/tables-inline"), "Contents/section0.xml", (x) =>
    x.replace("<hp:t>a</hp:t>", "<hp:t>{{no}}</hp:t>").replace("<hp:t>b</hp:t>", "<hp:t>{{item.name}}</hp:t>").replace("<hp:t>c</hp:t>", "<hp:t>{{item.note}} / {{project}}</hp:t>"),
  );
}
const MD_SAME = ["앞 문단", "", "| 항목 | 내용 | 비고 |", "| --- | --- | --- |", "| {{no}} | {{item.name}} | {{item.note}} / {{project}} |", "", "뒤 문단", ""].join("\n");

const hwpxRows = (bytes: Uint8Array): string[][] => {
  for (const p of reparse(bytes).sections[0]?.paragraphs ?? []) {
    for (const o of p.objects) {
      if (!isTableNode(o)) continue;
      const cols = Math.max(...o.cells.map((c) => c.col + c.colSpan));
      const flat = o.cells.map((c) => c.subList?.paragraphs[0]?.logicalText ?? "");
      return Array.from({ length: flat.length / cols }, (_, r) => flat.slice(r * cols, (r + 1) * cols));
    }
  }
  return [];
};
const mdRows = (text: string): string[][] => {
  const doc = parseText(text, "md");
  const table = doc.blocks.find((b) => b.kind === "table")?.table;
  return (table?.rows ?? []).map((r) => r.cells.map((c) => doc.source.slice(c.contentStart, c.contentEnd).replace(/\\\|/g, "|")));
};

test("같은 규칙·데이터를 hwpx(tables-inline)와 md에 쓰면 반복 행의 칸 글이 같다. tableProps·resize는 hwpx에만 적용되고 md에서는 건너뛴다", () => {
  const cases = [[], [ITEMS[0]], [...ITEMS, { name: "정|무", note: "라" }]];
  for (const items of cases) {
    const n = items.length;
    const data = { project: "P", items };
    // 원소가 0개면 원형 행을 지우는데, hwpx는 같은 표의 resize와 겹치면 EDIT_OVERLAP으로 거절한다(행 삭제 규칙과 resize의 기존 한계). 그 경우는 resize를 뺀다
    const rules = [repeatRule(), rule("p", { type: "tableProps", anchor: "tbl", table: { pageBreak: "NONE" } }), ...(n === 0 ? [] : [rule("s", { type: "resize", anchor: "tbl", scale: 0.5 })])];
    const tplHwpx = tpl({ anchors: [cellAnchor("row", 1), { id: "tbl", kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 0 }], rules });
    const tplMd = tpl({ anchors: [cellAnchor("row", 1), { id: "tbl", kind: "object", objectType: "table", sectionIndex: 0, ordinal: 0 }], rules });
    assert.deepEqual(tplHwpx.rules, tplMd.rules, "규칙은 양쪽에 같다");
    const h = generate(repeatFixture(), tplHwpx, readDataset(data));
    assert.ok(h.ok && !h.dryRun, `hwpx 생성 실패(${n}): ${JSON.stringify(h.report.issues.filter((i) => i.severity === "error"))}`);
    const m = done(run(MD_SAME, tplMd, data));
    const hr = hwpxRows(h.output);
    const mr = mdRows(m.output);
    assert.deepEqual(hr, mr, `반복 행의 칸 글이 같아야 한다(${n}개)`);
    assert.equal(mr.length, 1 + n, "머리행 + 반복 행");
    // 보고서의 반복 행 수도 같다
    const hAct = h.report.plan.actions.filter((a) => a.type === "repeat").map((a) => a.targets);
    const mAct = m.report.plan.actions.filter((a) => a.type === "repeat").map((a) => a.targets);
    assert.deepEqual(hAct, mAct);
    // tableProps·resize: hwpx는 적용하고(쪽 나눔 없음) md는 건너뛴다
    assert.equal(h.report.plan.skipped.some((s) => s.code === "TEXT_NOT_APPLICABLE"), false);
    assert.deepEqual(m.report.plan.skipped.map((s) => `${s.ruleId}:${s.code}`), n === 0 ? ["p:TEXT_NOT_APPLICABLE"] : ["p:TEXT_NOT_APPLICABLE", "s:TEXT_NOT_APPLICABLE"]);
    assert.equal(listTables(reparse(h.output))[0]?.pageBreak, "NONE", "hwpx는 tableProps를 적용한다");
  }
});

test("같은 템플릿을 hwpx에 쓰면 tableProps가 실제로 적용된다(md의 건너뜀과 대조)", () => {
  const tplHwpx = tpl({ anchors: [cellAnchor("row", 1), { id: "tbl", kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 0 }], rules: [repeatRule(), rule("p", { type: "tableProps", anchor: "tbl", table: { pageBreak: "NONE" } })] });
  const h = generate(repeatFixture(), tplHwpx, readDataset(DATA));
  assert.ok(h.ok && !h.dryRun, JSON.stringify(h.report.issues.filter((i) => i.severity === "error")));
  assert.equal(listTables(reparse(h.output))[0]?.pageBreak, "NONE");
});

test("누락 정책 세 가지(error·empty·keep)로 같은 repeat가 hwpx와 md에서 같은 성패이고 실패하면 같은 오류 코드다", () => {
  const tplHwpx = tpl({ anchors: [cellAnchor("row", 1)], rules: [repeatRule()] });
  for (const missing of ["error", "empty", "keep"] as MissingPolicy[]) {
    for (const data of [{ project: "P" }, { project: "P", items: [{ name: "갑" }] }]) {
      const h = generate(repeatFixture(), tplHwpx, readDataset(data), { missing });
      const m = run(MD_SAME, tplHwpx, data, { missing });
      if (missing === "keep" && !("items" in data)) {
        // 그대로 두기만 하면 hwpx는 적용된 액션이 없어 FILL_NOTHING_APPLIED로 실패한다. md는 그대로 낸다(md·txt 동작 유지)
        assert.ok(m.ok && !h.ok && h.report.issues.some((i) => i.code === "FILL_NOTHING_APPLIED"));
        continue;
      }
      assert.equal(m.ok, h.ok, `${missing} ${JSON.stringify(data)}: 성패가 같아야 한다`);
      if (!m.ok && !h.ok) {
        const codes = (rs: { severity: string; code: string }[]) => [...new Set(rs.filter((i) => i.severity === "error").map((i) => i.code))].sort();
        assert.deepEqual(codes(m.report.issues), codes(h.report.issues));
      }
    }
  }
});

// ── L5: 원소 이름은 원소에서만 찾는다 / 조건이 거짓인 repeat (hwpx 쪽은 table-fill-repeat.test.ts) ──

const bundle = (data: unknown, derived: unknown = {}) => readDataset({ schema: DATASET_SCHEMA, data, derived });

test("L5(md): 원소 이름이 가리키는 경로는 원소에서만 찾는다 — 원소에 없으면 derived로 넘어가지 않고 누락 정책을 따른다(hwpx와 같은 rowDataset)", () => {
  const t = repeatTemplate();
  const ds = bundle({ project: "P", items: [{ name: "갑" }] }, { item: { name: "파생", note: "파생 비고" } });
  assert.deepEqual(errorCodes(generateText(LIST, "md", t, ds)), ["DATA_MISSING"]);
  assert.equal(done(generateText(LIST, "md", t, ds, { missing: "empty" })).output, listWith(["| 1 | 갑 |  / P |"]));
  assert.equal(done(generateText(LIST, "md", t, ds, { missing: "keep" })).output, listWith(["| 1 | 갑 | {{item.note}} / P |"]));
  // 전역 경로는 derived에서도 찾는다
  assert.equal(done(generateText(LIST, "md", t, bundle({ items: [{ name: "갑", note: "가" }] }, { project: "파생 값" }))).output, listWith(["| 1 | 갑 | 가 / 파생 값 |"]));
  // 원소 이름과 같은 최상위 키(data·derived)는 원소가 가린다. 순번 이름(no)도 같다
  const shadow = bundle({ project: "P", item: { name: "전역", note: "전역 비고" }, no: "전역", items: [{ name: "갑", note: "가" }] }, { item: { name: "파생" }, no: "파생" });
  assert.equal(done(generateText(LIST, "md", t, shadow)).output, listWith(["| 1 | 갑 | 가 / P |"]));
  assert.deepEqual([...new Set(errorCodes(generateText(LIST, "md", t, bundle({ project: "P", item: { name: "전역", note: "전역" }, items: [{}] }))))], ["DATA_MISSING"]);
});

test("조건이 거짓인 repeat(md): 원형 행은 그대로 두고 원소·순번 자리는 REPEAT_INACTIVE로 건너뛴다(오류 아님) — 전역 경로는 채우고 남은 {{}} 검사에 걸리지 않는다", () => {
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [repeatRule("r", "row", {}), ].map((r) => ({ ...r, when: { path: "on", op: "exists" } })) });
  const r = done(generateText(LIST, "md", t, readDataset({ project: "P" })));
  assert.equal(r.output, LIST.replace("{{project}}", "P"));
  assert.deepEqual(r.report.plan.inactiveRules, ["r"]);
  assert.deepEqual(r.report.plan.skipped.map((s) => [s.ruleId, s.anchor, s.code]), [["r", "row", "REPEAT_INACTIVE"]]);
  assert.ok(r.report.plan.skipped[0]?.message.includes("3곳"));
  assert.deepEqual(r.report.plan.requiredPaths, ["project"]);
  assert.deepEqual(r.report.plan.expected, {});
  // 조건이 참이면 평소대로 반복한다(대조군)
  const on = done(generateText(LIST, "md", t, readDataset({ project: "P", on: 1, items: ITEMS })));
  assert.equal(on.output, listWith(rows(3)));
  assert.deepEqual(on.report.plan.skipped, []);
  // 앵커를 풀 수 없어도 오류가 아니다
  const lost = tpl({ anchors: [cellAnchor("row", 9)], rules: [{ ...repeatRule("r", "row"), when: { path: "on", op: "exists" } }] });
  assert.equal(done(generateText(LIST, "md", lost, bundle({ project: "P", no: "n", item: { name: "x", note: "y" } }))).report.plan.skipped.length, 0);
  // 같은 입력이면 결과가 같다(결정성)
  assert.deepEqual(done(generateText(LIST, "md", t, readDataset({ project: "P" }))).report, r.report);
});

test("조건이 거짓인 repeat: hwpx와 md가 같은 결과(원형 행 그대로, 전역 경로만 채움, REPEAT_INACTIVE)", () => {
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [{ ...repeatRule("r", "row"), when: { path: "on", op: "exists" } }] });
  const data = { project: "P" };
  const h = generate(repeatFixture(), t, readDataset(data));
  assert.ok(h.ok && !h.dryRun, JSON.stringify(h.report.issues.filter((i) => i.severity === "error")));
  const m = done(generateText(MD_SAME, "md", t, readDataset(data)));
  assert.deepEqual(hwpxRows(h.output)[1], ["{{no}}", "{{item.name}}", "{{item.note}} / {{project}}".replace("{{project}}", "P")]);
  assert.deepEqual(hwpxRows(h.output), mdRows(m.output));
  assert.deepEqual(h.report.plan.skipped.map((s) => s.code), m.report.plan.skipped.map((s) => s.code));
  assert.deepEqual(m.report.plan.skipped.map((s) => s.code), ["REPEAT_INACTIVE"]);
});
