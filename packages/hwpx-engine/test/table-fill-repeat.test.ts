// 독립 검증 결함 수정 중 행 반복 규칙: L5(원소 이름은 원소에서만 찾는다), L6(같은 원형 행에 repeat 둘 → TPL_CONFLICT),
// 조건이 거짓인 repeat(원형 행은 그대로, 원소·순번 자리는 REPEAT_INACTIVE로 건너뜀). md 쪽은 text-table.test.ts에 있다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DATASET_SCHEMA, extractFragment, generate, readDataset, readTemplate, type GenerateOptions, type GenerateResult } from "../src/index.ts";
import { verifyTableCounts, zeroDelta } from "../src/fill/census.ts";
import { loadDoc, readFixture, sha256Hex } from "./helpers.ts";
import { docOf, outerTableXml, sectionText, tableParagraph, textPara, topRows, type TableSpec } from "./table-helpers.ts";

type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;
const done = (r: GenerateResult): Done => {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  assert.ok(!r.dryRun);
  return r as Done;
};
const codes = (r: GenerateResult): string[] => r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
const tpl = (spec: { anchors?: unknown[]; rules?: unknown[] }) => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const cellAnchor = (id: string, row: number, col = 0) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row, col });
const rule = (id: string, action: Record<string, unknown>, when?: unknown) => ({ id, ...(when === undefined ? {} : { when }), do: action });
const bundle = (data: unknown, derived: unknown = {}) => readDataset({ schema: DATASET_SCHEMA, data, derived });
const run = (t: ReturnType<typeof tpl>, ds: ReturnType<typeof readDataset>, options: GenerateOptions = {}) => generate(list(), t, ds, options);

/** 머리 행 / 원형 행(번호·이름·내용 + 전역 경로) / 합계 행 */
const SPEC: TableSpec = {
  id: "5101",
  rowCnt: 3,
  colCnt: 3,
  cells: [
    { row: 0, col: 0, width: 2000, height: 500, text: "번호" },
    { row: 0, col: 1, width: 3000, height: 500, text: "이름" },
    { row: 0, col: 2, width: 4000, height: 500, text: "내용" },
    { row: 1, col: 0, width: 2000, height: 800, text: "{{no}}" },
    { row: 1, col: 1, width: 3000, height: 800, text: "{{item.name}}" },
    { row: 1, col: 2, width: 4000, height: 800, text: "{{item.note}} / {{project}}" },
    { row: 2, col: 0, colSpan: 3, width: 9000, height: 600, text: "합계" },
  ],
};
function list(): Uint8Array {
  return docOf([textPara("제목"), tableParagraph(SPEC), textPara("끝")]);
}
const rowsText = (bytes: Uint8Array): string[] => topRows(outerTableXml(sectionText(bytes), 0)).map((r) => [...r.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|"));
const repeat = (id = "r", anchor = "row", extra: Record<string, unknown> = {}, when?: unknown) => rule(id, { type: "repeat", anchor, each: { path: "items" }, index: "no", ...extra }, when);

// ── L5 ──────────────────────────────────────────────────────────

test("L5: 원소 이름이 가리키는 경로는 원소에서만 찾는다 — 원소에 없으면 derived로 넘어가지 않고 누락 정책을 따른다", () => {
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [repeat()] });
  // `item.note`는 원소에 없고 derived에는 있다: 쓰지 않는다
  const ds = bundle({ project: "P", items: [{ name: "갑" }] }, { item: { name: "파생", note: "파생 비고" } });
  assert.deepEqual(codes(run(t, ds)), ["DATA_MISSING"]);
  assert.deepEqual(rowsText(done(run(t, ds, { missing: "empty" })).output), ["번호|이름|내용", "1|갑| / P", "합계"]);
  assert.match(sectionText(done(run(t, ds, { missing: "keep" })).output), /\{\{item\.note\}\} \/ P/);
  // 전역 경로(원소 이름이 아닌 것)는 derived에서도 찾는다
  const ds2 = bundle({ items: [{ name: "갑", note: "가" }] }, { project: "파생 값" });
  assert.deepEqual(rowsText(done(run(t, ds2)).output), ["번호|이름|내용", "1|갑|가 / 파생 값", "합계"]);
});

test("L5: 원소 이름과 같은 최상위 키는 원소가 가린다(의도된 동작) — data·derived 둘 다", () => {
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [repeat()] });
  // data에 `item` 키(전역)가 있어도 반복 행의 {{item.name}}은 원소의 값이다
  const shadow = bundle({ project: "P", item: { name: "전역", note: "전역 비고" }, items: [{ name: "갑", note: "가" }] });
  assert.deepEqual(rowsText(done(run(t, shadow)).output), ["번호|이름|내용", "1|갑|가 / P", "합계"]);
  // 원소에 그 키가 없으면 가린 전역 값으로도 넘어가지 않는다
  const missing = bundle({ project: "P", item: { name: "전역", note: "전역 비고" }, items: [{}] });
  assert.deepEqual([...new Set(codes(run(t, missing)))], ["DATA_MISSING"]);
  assert.equal(codes(run(t, missing)).length, 2, "item.name과 item.note 둘 다 없다");
  // 순번 이름(`no`)도 같다: 전역 `no`가 있어도 순번이 이긴다
  const index = bundle({ project: "P", no: "전역", items: [{ name: "갑", note: "가" }] }, { no: "파생" });
  assert.deepEqual(rowsText(done(run(t, index)).output), ["번호|이름|내용", "1|갑|가 / P", "합계"]);
});

// ── L6 ──────────────────────────────────────────────────────────

test("L6: 같은 원형 행에 repeat가 둘이면 계획 단계에서 TPL_CONFLICT(md와 같게)", () => {
  const t = tpl({ anchors: [cellAnchor("a", 1, 0), cellAnchor("b", 1, 2)], rules: [repeat("r1", "a"), repeat("r2", "b")] });
  const r = run(t, bundle({ project: "P", items: [{ name: "갑", note: "가" }] }));
  assert.deepEqual(codes(r), ["TPL_CONFLICT"]);
  assert.ok(!codes(r).includes("REPEAT_ANCHOR_LOST"));
  // 서로 다른 행이면 둘 다 된다
  const t2 = tpl({ anchors: [cellAnchor("a", 1, 0), cellAnchor("b", 2, 0)], rules: [repeat("r1", "a"), rule("r2", { type: "repeat", anchor: "b", each: { path: "extra" } })] });
  const ok = done(run(t2, bundle({ project: "P", items: [{ name: "갑", note: "가" }], extra: [{}, {}] })));
  assert.equal(rowsText(ok.output).length, 4);
});

// ── 조건이 거짓인 repeat ────────────────────────────────────────

test("조건이 거짓인 repeat: 원형 행은 그대로 두고 원소·순번 자리는 REPEAT_INACTIVE로 건너뛴다(오류 아님) — 전역 경로는 채운다", () => {
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [repeat("r", "row", {}, { path: "on", op: "exists" })] });
  const r = done(run(t, bundle({ project: "P" })));
  assert.deepEqual(rowsText(r.output), ["번호|이름|내용", "{{no}}|{{item.name}}|{{item.note}} / P", "합계"]);
  assert.deepEqual(r.report.plan.inactiveRules, ["r"]);
  assert.deepEqual(r.report.plan.skipped.map((s) => [s.ruleId, s.anchor, s.code]), [["r", "row", "REPEAT_INACTIVE"]]);
  assert.ok(r.report.plan.skipped[0]?.message.includes("3곳"), "원소·순번 자리 {{no}}·{{item.name}}·{{item.note}}");
  assert.deepEqual(r.report.plan.requiredPaths, ["project"]);
  // 원소 이름을 바꾸면 그 이름이 기준이다: `row.`로 시작하는 자리만 건너뛰고 `item.`은 전역 경로라 데이터에서 찾는다
  const renamed = tpl({ anchors: [cellAnchor("row", 1)], rules: [repeat("r", "row", { as: "row", index: "n" }, { path: "on", op: "exists" })] });
  assert.deepEqual(codes(run(renamed, bundle({ project: "P" }))), ["DATA_MISSING", "DATA_MISSING", "DATA_MISSING"]);
  // 조건이 참이면 평소대로 반복한다(대조군)
  const on = done(run(t, bundle({ project: "P", on: 1, items: [{ name: "갑", note: "가" }, { name: "을", note: "나" }] })));
  assert.deepEqual(rowsText(on.output), ["번호|이름|내용", "1|갑|가 / P", "2|을|나 / P", "합계"]);
  assert.deepEqual(on.report.plan.skipped, []);
});

test("조건이 거짓인 repeat: 앵커를 풀 수 없어도 오류가 아니다(그 규칙은 어차피 적용되지 않는다)", () => {
  const t = tpl({ anchors: [cellAnchor("row", 9)], rules: [repeat("r", "row", {}, { path: "on", op: "exists" })] });
  // 앵커가 가리키는 행이 없으니 행 안 자리는 일반 채움이다(데이터에 다 있으면 오류가 없다)
  const r = done(run(t, bundle({ project: "P", no: "n", item: { name: "x", note: "y" } })));
  assert.deepEqual(r.report.plan.skipped, []);
});

// ── 예상 수량에 표 행·셀(tableRows·tableCells) ───────────────────

test("예상 수량: 표 행·셀 수 증감이 보고서에 있고(0이 아닌 것만) 기존 항목의 값은 그대로다 — 조각 주입으로 표를 넣는 경우", () => {
  // hancom/ph-table의 표(3행 2열)를 담은 문단을 조각으로 떼어 hancom/blocks의 문단 뒤에 넣는다
  const source = loadDoc("hancom/ph-table");
  const fragment = JSON.parse(JSON.stringify(extractFragment(source, { sectionIndex: 0, parentPath: [], from: 1, to: 1 })));
  const blocks = loadDoc("hancom/blocks");
  const par = blocks.sections[0]?.paragraphs[3];
  assert.ok(par !== undefined);
  const anchor = { id: "p", kind: "line", at: { sectionIndex: 0, path: [3] }, print: { text: par.logicalText.slice(0, 40), sha256: sha256Hex(new TextEncoder().encode(par.logicalText)) } };
  const t = tpl({ anchors: [anchor], rules: [rule("i", { type: "inject", anchor: "p", position: "after", fragment })] });
  const r = done(generate(readFixture("hancom/blocks"), t, readDataset({ applicant: { name: "갑" }, note: "비고" })));
  const e = r.report.plan.expected;
  assert.equal(e["tables"], 1);
  assert.equal(e["tableRows"], 3, "넣은 표의 행");
  assert.equal(e["tableCells"], 6, "넣은 표의 셀(3행 × 2열)");
  assert.equal((sectionText(r.output).match(/<hp:tr>/g) ?? []).length, (sectionText(readFixture("hancom/blocks")).match(/<hp:tr>/g) ?? []).length + 3);
});

test("예상 수량: 표 행·셀 수가 예고와 다르면 PRESERVE_CENSUS(단위 확인)", () => {
  const delta = { ...zeroDelta(), tableRows: -1, tableCells: -3 };
  assert.deepEqual(verifyTableCounts({ rows: 3, cells: 9 }, { rows: 2, cells: 6 }, delta), []);
  const bad = verifyTableCounts({ rows: 3, cells: 9 }, { rows: 3, cells: 6 }, delta);
  assert.deepEqual(bad.map((i) => [i.code, i.message.startsWith("tableRows")]), [["PRESERVE_CENSUS", true]]);
  assert.equal(verifyTableCounts({ rows: 3, cells: 9 }, { rows: 2, cells: 8 }, delta).length, 1);
});
