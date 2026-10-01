// L3: 지워지는 셀(열 삭제·`content: "first"` 병합)이 셀을 가로지르는 누름틀의 짝을 자르면 TABLE_SPLITS_FIELD로 거절한다.
// 지워지는 쪽 안에서 시작과 끝이 모두 닫히는 누름틀은 그대로 지울 수 있다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planCloneTable, planDeleteColumns, planMergeCells, validateDocument } from "../src/index.ts";
import { applyChecked, paragraph, sectionText, singleTableDoc, target, type TableSpec } from "./table-helpers.ts";

const begin = (id: string): string => `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="n${id}" editable="1" dirty="1" fieldid="9${id}"/></hp:ctrl>`;
const end = (id: string): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="9${id}"/></hp:ctrl>`;
const cell = (row: number, col: number, inner: string, extra: Partial<TableSpec["cells"][number]> = {}) => ({ row, col, width: 1000, height: 500, paragraphs: [paragraph(inner)], ...extra });

/** 2행 3열. 칸마다 `inner`(누름틀 시작·끝·글) */
function spec(inners: string[][]): TableSpec {
  return { rowCnt: 2, colCnt: 3, cells: inners.flatMap((row, r) => row.map((inner, c) => cell(r, c, inner))) };
}
const t = (inners: string[][]) => singleTableDoc(spec(inners)).doc;
const plain = (r: number, c: number): string => `<hp:t>${r}${c}</hp:t>`;
function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, `${code}가 나와야 한다`);
}
const fieldEndsOf = (bytes: Uint8Array): number => (sectionText(bytes).match(/<hp:fieldEnd /g) ?? []).length;

test("L3: 열 삭제 — 셀을 가로지르는 누름틀의 한쪽만 지우면 TABLE_SPLITS_FIELD(시작이 남든 끝이 남든)", () => {
  // 시작은 (0,1), 끝은 (0,2): 열 1만 지우면 끝만 남는다
  const endOnly = t([[plain(0, 0), `${begin("7001")}${plain(0, 1)}`, `${plain(0, 2)}${end("7001")}`], [plain(1, 0), plain(1, 1), plain(1, 2)]]);
  expectCode(() => planDeleteColumns(endOnly, target(endOnly), { cols: [1] }), "TABLE_SPLITS_FIELD");
  // 시작은 (0,0), 끝은 (0,1): 열 1만 지우면 시작만 남는다
  const beginOnly = t([[`${begin("7002")}${plain(0, 0)}`, `${plain(0, 1)}${end("7002")}`, plain(0, 2)], [plain(1, 0), plain(1, 1), plain(1, 2)]]);
  expectCode(() => planDeleteColumns(beginOnly, target(beginOnly), { cols: [1] }), "TABLE_SPLITS_FIELD");
  // 같은 셀 안에서 닫히는 누름틀은 지워진다
  const inside = t([[plain(0, 0), `${begin("7003")}${plain(0, 1)}${end("7003")}`, plain(0, 2)], [plain(1, 0), plain(1, 1), plain(1, 2)]]);
  const { bytes } = applyChecked(inside, planDeleteColumns(inside, target(inside), { cols: [1] }));
  assert.equal(fieldEndsOf(bytes), 0);
});

test("L3: 열 삭제 — 누름틀의 시작과 끝이 모두 지워지는 열 안에 있으면 지울 수 있다(다른 열의 셀에 걸쳐도)", () => {
  // 시작은 (0,0), 끝은 (1,1)이고 열 0·1을 함께 지운다
  const both = t([[`${begin("7004")}${plain(0, 0)}`, plain(0, 1), plain(0, 2)], [plain(1, 0), `${plain(1, 1)}${end("7004")}`, plain(1, 2)]]);
  const { bytes } = applyChecked(both, planDeleteColumns(both, target(both), { cols: [0, 1] }));
  assert.equal(fieldEndsOf(bytes), 0);
  assert.equal(validateDocument(bytes).errors.length, 0);
  // 하나만 지우면 거절
  expectCode(() => planDeleteColumns(both, target(both), { cols: [0] }), "TABLE_SPLITS_FIELD");
  expectCode(() => planDeleteColumns(both, target(both), { cols: [1] }), "TABLE_SPLITS_FIELD");
});

test("L3: 병합 content:first — 지워지는 셀이 누름틀의 반쪽을 가지면 TABLE_SPLITS_FIELD, concat이면 옮겨 짝이 유지된다", () => {
  const cross = t([[`${begin("7005")}${plain(0, 0)}`, `${plain(0, 1)}${end("7005")}`, plain(0, 2)], [plain(1, 0), plain(1, 1), plain(1, 2)]]);
  expectCode(() => planMergeCells(cross, target(cross), { rows: [0, 0], cols: [0, 1], content: "first" }), "TABLE_SPLITS_FIELD");
  const kept = applyChecked(cross, planMergeCells(cross, target(cross), { rows: [0, 0], cols: [0, 1], content: "concat" }));
  assert.equal(fieldEndsOf(kept.bytes), 1, "concat은 다른 셀의 문단을 옮겨 짝이 그대로 남는다");
  assert.equal(validateDocument(kept.bytes).errors.length, 0);
  // 시작과 끝이 모두 지워지는 셀 안에 있으면 first로도 합친다
  const inOthers = t([[plain(0, 0), `${begin("7006")}${plain(0, 1)}`, plain(0, 2)], [plain(1, 0), `${plain(1, 1)}${end("7006")}`, plain(1, 2)]]);
  const merged = applyChecked(inOthers, planMergeCells(inOthers, target(inOthers), { rows: [0, 1], cols: [0, 1], content: "first" }));
  assert.equal(fieldEndsOf(merged.bytes), 0);
  // 반쪽이 남는 head 셀에 있는 경우
  const headHalf = t([[`${begin("7007")}${plain(0, 0)}`, plain(0, 1), plain(0, 2)], [plain(1, 0), `${plain(1, 1)}${end("7007")}`, plain(1, 2)]]);
  expectCode(() => planMergeCells(headHalf, target(headHalf), { rows: [0, 1], cols: [0, 1], content: "first" }), "TABLE_SPLITS_FIELD");
});

test("L3: 복제한 표의 행을 줄일 때도 누름틀 짝이 잘리면 거절한다(대조: 짝이 같은 쪽에 있으면 줄일 수 있다)", () => {
  // 시작은 0행, 끝은 1행: 행을 1개로 줄이면 끝이 지워진다
  const doc = t([[`${begin("7008")}${plain(0, 0)}`, plain(0, 1), plain(0, 2)], [`${plain(1, 0)}${end("7008")}`, plain(1, 1), plain(1, 2)]]);
  const at = { sectionIndex: 0, parentPath: [], index: 1, position: "after" as const };
  expectCode(() => planCloneTable(doc, at, { table: target(doc) }, { rows: 1 }), "TABLE_SPLITS_FIELD");
  // 같은 행 안에서 닫히면 된다
  const closed = t([[`${begin("7009")}${plain(0, 0)}${end("7009")}`, plain(0, 1), plain(0, 2)], [plain(1, 0), plain(1, 1), plain(1, 2)]]);
  assert.ok(planCloneTable(closed, at, { table: target(closed) }, { rows: 1 }).edits.length > 0);
});
