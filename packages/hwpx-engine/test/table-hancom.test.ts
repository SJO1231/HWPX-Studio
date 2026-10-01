// 한컴 13이 저장한 표 문서(병합·글자처럼 취급·중첩·셀 안 그림과 누름틀)로 표 조정 연산을 시험한다.
// 기대값은 문서를 만든 의도(tools/com/make_fixtures.py)와 표 구조에서 정했다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractFragment,
  generate,
  listTables,
  planCloneTable,
  planDeleteColumns,
  planInsertColumns,
  planInsertRows,
  planMergeCells,
  planScaleTable,
  planSetCellProps,
  planSetColumnWidths,
  planSetRowHeights,
  planSetTableProps,
  planSplitCell,
  readDataset,
  readTemplate,
  selectTable,
  validateDocument,
  type InsertPoint,
} from "../src/index.ts";
import { duplicates, loadDoc, mutateEntryText, objectIdsIn, readFixture, readFixtureText, sha256Hex } from "./helpers.ts";
import { applyChecked, attrIn, outerTableXml, readCells, reparseBytes, rowWidthSums, sectionText, topRows } from "./table-helpers.ts";

const NAMES = ["tables-merged", "tables-inline", "tables-nested", "tables-rich"] as const;

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, `${code}가 나와야 한다`);
}
const at = (index: number, position: "before" | "after" = "after", parentPath: number[] = []): InsertPoint => ({ sectionIndex: 0, parentPath, index, position });
const rowTexts = (tbl: string): string[] => topRows(tbl).map((r) => [...r.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|"));
const cellInfo = (tbl: string): string[] => readCells(tbl).map((c) => `${c.row},${c.col}:${c.rowSpan}x${c.colSpan}`);

test("한컴 표 문서의 SHA256SUMS와 구조: 만든 의도와 같다", () => {
  const listed = new Map(readFixtureText("tables/SHA256SUMS").split("\n").filter((l) => l.trim() !== "").map((l) => l.trim().split(/\s+/)).map(([h, n]) => [n, h]));
  for (const name of NAMES) assert.equal(sha256Hex(readFixture(`tables/${name}`)), listed.get(`${name}.hwpx`), name);

  const merged = listTables(loadDoc("tables/tables-merged"));
  assert.deepEqual(merged.map((t) => [t.rowCnt, t.colCnt, t.mergedCells, t.treatAsChar, t.repeatHeader, t.regular]), [[4, 3, 2, false, true, true]]);
  const inline = listTables(loadDoc("tables/tables-inline"));
  assert.deepEqual(inline.map((t) => [t.rowCnt, t.colCnt, t.treatAsChar, t.pageBreak]), [[2, 3, true, "CELL"]]);
  const nested = listTables(loadDoc("tables/tables-nested"));
  assert.deepEqual(nested.map((t) => [t.depth, t.rowCnt, t.colCnt, t.topOrdinal]), [[0, 2, 2, 0], [1, 2, 2, undefined]]);
  const rich = loadDoc("tables/tables-rich");
  assert.equal(validateDocument(rich.pkg.bytes).census.pictures, 1);
  assert.equal(validateDocument(rich.pkg.bytes).census.fieldPairs, 1);
});

test("tables-merged: 병합이 든 한컴 표에 행·열 삽입·삭제·병합·분할이 격자를 지킨다", () => {
  const doc = loadDoc("tables/tables-merged");
  const t = listTables(doc)[0]?.target as never;
  const before = outerTableXml(sectionText(doc.pkg.bytes));
  assert.deepEqual(cellInfo(before), ["0,0:1x2", "0,2:1x1", "1,0:1x1", "1,1:1x1", "1,2:2x1", "2,0:1x1", "2,1:1x1", "3,0:1x1", "3,1:1x1", "3,2:1x1"]);

  // 행 삽입: 마지막 행은 된다. 세로 병합이 시작하는 행 1은 거절, 그 병합이 덮는 행 2는 extendSpans로만
  const last = applyChecked(doc, planInsertRows(doc, t, { prototype: 3, count: 2, text: "keep" }));
  assert.deepEqual(rowTexts(outerTableXml(sectionText(last.bytes))).slice(3), ["다|C|c", "다|C|c", "다|C|c"]);
  expectCode(() => planInsertRows(doc, t, { prototype: 1 }), "TABLE_SPAN_CONFLICT");
  expectCode(() => planInsertRows(doc, t, { prototype: 2 }), "TABLE_SPAN_CONFLICT");
  const ext = applyChecked(doc, planInsertRows(doc, t, { prototype: 2, extendSpans: true }));
  assert.equal(readCells(outerTableXml(sectionText(ext.bytes))).find((c) => c.row === 1 && c.col === 2)?.rowSpan, 3);

  // 열 삽입: 가로 병합이 늘어난다
  const col = applyChecked(doc, planInsertColumns(doc, t, { prototype: 0 }));
  const colXml = outerTableXml(sectionText(col.bytes));
  assert.equal(readCells(colXml).find((c) => c.row === 0 && c.col === 0)?.colSpan, 3);
  assert.deepEqual(rowWidthSums(colXml), Array(4).fill(41952 + 13984));
  // 열 삭제: 2열(병합 셀 하나가 걸쳐 있는 열 1)
  const del = applyChecked(doc, planDeleteColumns(doc, t, { cols: [1] }));
  const delXml = outerTableXml(sectionText(del.bytes));
  assert.equal(readCells(delXml).find((c) => c.row === 0 && c.col === 0)?.colSpan, 1);
  assert.equal(attrIn(delXml, "tbl", "colCnt"), "2");

  // 병합 → 분할: 한컴이 만든 가로 병합 셀을 풀면 병합 전 격자가 된다
  const split = applyChecked(doc, planSplitCell(doc, t, { row: 0, col: 0 }));
  const splitXml = outerTableXml(sectionText(split.bytes));
  assert.equal(readCells(splitXml).filter((c) => c.row === 0).length, 3);
  assert.deepEqual(readCells(splitXml).filter((c) => c.row === 0).map((c) => c.width), [13984, 13984, 13984]);
  assert.equal(rowTexts(splitXml)[0], "신청 내역|비고", "새로 생긴 셀은 글이 없다");
  // 다시 합치면(분할로 생긴 빈 셀은 비어 있다) 처음 글이 그대로다
  const again = applyChecked(split.doc, planMergeCells(split.doc, listTables(split.doc)[0]?.target as never, { rows: [0, 0], cols: [0, 1] }));
  assert.equal(rowTexts(outerTableXml(sectionText(again.bytes)))[0], rowTexts(before)[0]);

  // 열 너비·행 높이·표 크기
  const sized = applyChecked(doc, planScaleTable(doc, t, { scale: 0.5 }));
  assert.ok(rowWidthSums(outerTableXml(sectionText(sized.bytes))).every((w) => w === 20976));
  const widths = applyChecked(doc, planSetColumnWidths(doc, t, [10000, 10000, 5000]));
  assert.deepEqual(rowWidthSums(outerTableXml(sectionText(widths.bytes))), Array(4).fill(25000));
  const heights = applyChecked(doc, planSetRowHeights(doc, t, [{ row: 1, height: 1000 }]));
  assert.equal(readCells(outerTableXml(sectionText(heights.bytes))).find((c) => c.row === 1 && c.col === 2)?.height, 1000 + 282, "세로 병합 셀은 행 1(1000)과 행 2(282)의 합");
});

test("tables-merged: 병합 행(셀 하나가 전 열을 덮는 구조는 아님)과 병합 셀이 든 원형 행으로 행 반복한다(템플릿 액션)", () => {
  // 마지막 행의 글 `다`·`C`·`c`를 자리 표시자로 바꾼 사본
  const bytes = mutateEntryText(mutateEntryText(mutateEntryText(readFixture("tables/tables-merged"), "Contents/section0.xml", (x) => x.replace("<hp:t>다</hp:t>", "<hp:t>{{item.a}}</hp:t>")), "Contents/section0.xml", (x) => x.replace("<hp:t>C</hp:t>", "<hp:t>{{item.b}}</hp:t>")), "Contents/section0.xml", (x) => x.replace("<hp:t>c</hp:t>", "<hp:t>{{no}}</hp:t>"));
  const t = readTemplate({
    schema: "hwpx-studio/template@1",
    anchors: [{ id: "row", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 3, col: 0 }],
    rules: [{ id: "r", do: { type: "repeat", anchor: "row", each: { path: "xs" }, index: "no" } }],
  });
  for (const n of [0, 1, 4]) {
    const xs = Array.from({ length: n }, (_, i) => ({ a: `가${i}`, b: `나${i}` }));
    const r = generate(bytes, t, readDataset({ xs }));
    assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues.filter((i) => i.severity === "error")));
    const tbl = outerTableXml(sectionText(r.output));
    assert.deepEqual(rowTexts(tbl).slice(3), n === 0 ? [] : xs.map((x, i) => `${x.a}|${x.b}|${i + 1}`));
    assert.equal(attrIn(tbl, "tbl", "rowCnt"), String(3 + n));
    assert.equal(validateDocument(r.output).errors.length, 0);
  }
});

test("tables-inline: 글자처럼 취급 표의 설정을 바꾸고(B1) fitTable로 셀에 긴 조각을 넣는다", () => {
  const doc = loadDoc("tables/tables-inline");
  const t = listTables(doc)[0]?.target as never;
  const off = applyChecked(doc, planSetTableProps(doc, t, { treatAsChar: false }));
  assert.equal(listTables(off.doc)[0]?.treatAsChar, false);
  const cell = applyChecked(doc, planSetCellProps(doc, t, [{ rows: [0, 0], props: { vertAlign: "BOTTOM", lineWrap: "SQUEEZE" } }]));
  assert.match(topRows(outerTableXml(sectionText(cell.bytes)))[0] ?? "", /vertAlign="BOTTOM"/);

  // 조각: hancom/blocks의 표를 담은 문단. 삽입 지점은 표 첫 셀의 문단(주소 [1, 0, 0])
  const src = loadDoc("hancom/blocks");
  const fragment = JSON.parse(JSON.stringify(extractFragment(src, selectTable(src, 0, 0).selection)));
  const target = doc.sections[0]?.paragraphs[1]?.subLists[0]?.paragraphs[0];
  assert.ok(target !== undefined);
  const anchor = { id: "cell", kind: "line", at: { sectionIndex: 0, path: [1, 0, 0] }, print: { text: target.logicalText.slice(0, 40), sha256: sha256Hex(new TextEncoder().encode(target.logicalText)) } };
  const make = (fit: boolean) => readTemplate({ schema: "hwpx-studio/template@1", anchors: [anchor], rules: [{ id: "i", do: { type: "inject", anchor: "cell", position: "after", fragment, ...(fit ? { fitTable: "allowBreak" } : {}) } }] });
  const plain = generate(doc.pkg.bytes, make(false), readDataset({}));
  assert.ok(plain.ok && !plain.dryRun);
  assert.ok(plain.report.issues.some((i) => i.code === "FRAG_CELL_MAY_CLIP"));
  const fit = generate(doc.pkg.bytes, make(true), readDataset({}));
  assert.ok(fit.ok && !fit.dryRun);
  assert.ok(!fit.report.issues.some((i) => i.code === "FRAG_CELL_MAY_CLIP"));
  assert.deepEqual(fit.report.plan.tableChanges.map((c) => c.change), ["treatAsChar 1→0"]);
  const tables = listTables(reparseBytes(fit.output));
  assert.equal(tables.find((x) => x.depth === 0)?.treatAsChar, false);
  assert.equal(validateDocument(fit.output).errors.length, 0);
});

test("tables-nested: 중첩 표에도 표 연산이 되고 바깥 표는 그대로다. 최상위 표만 앵커로 가리킨다", () => {
  const doc = loadDoc("tables/tables-nested");
  const [outer, inner] = listTables(doc);
  assert.ok(outer !== undefined && inner !== undefined);
  const grown = applyChecked(doc, planInsertRows(doc, inner.target, { prototype: 1, count: 2, text: "keep" }));
  const tables = listTables(grown.doc);
  assert.deepEqual(tables.map((x) => [x.depth, x.rowCnt, x.colCnt]), [[0, 2, 2], [1, 4, 2]]);
  assert.deepEqual(duplicates(objectIdsIn(sectionText(grown.bytes))), []);
  // 안쪽 표 열 삽입, 병합, 설정
  const col = applyChecked(doc, planInsertColumns(doc, inner.target, { prototype: 0 }));
  assert.equal(listTables(col.doc)[1]?.colCnt, 3);
  const props = applyChecked(doc, planSetTableProps(doc, inner.target, { pageBreak: "NONE", repeatHeader: false }));
  assert.equal(listTables(props.doc)[1]?.pageBreak, "NONE");
  assert.equal(listTables(props.doc)[0]?.pageBreak, "CELL");
  const merged = applyChecked(doc, planMergeCells(doc, inner.target, { rows: [0, 1], cols: [0, 0] }));
  assert.equal(listTables(merged.doc)[1]?.mergedCells, 1);
  // 안쪽 표를 담은 문단을 새 문단으로 복제(바깥 셀 안): 중첩 깊이 1이 하나 늘어난다
  const host = inner.paragraphPath;
  const clone = applyChecked(doc, planCloneTable(doc, at(host[host.length - 1] ?? 0, "after", host.slice(0, -1)), { table: inner.target }, { text: "keep" }));
  assert.equal(listTables(clone.doc).filter((x) => x.depth === 1).length, 2);
  assert.deepEqual(duplicates(objectIdsIn(sectionText(clone.bytes))), []);
  // 템플릿 앵커는 최상위 표만: 중첩 표의 순번은 없다
  assert.equal(inner.topOrdinal, undefined);
});

test("tables-rich: 셀 안 그림·누름틀이 든 행·열을 복제하면 id가 새로 매겨지고 이진 자료는 그대로 쓴다", () => {
  const doc = loadDoc("tables/tables-rich");
  const t = listTables(doc)[0]?.target as never;
  const before = validateDocument(doc.pkg.bytes);
  const rows = applyChecked(doc, planInsertRows(doc, t, { prototype: 1, count: 2, text: "keep" }));
  const after = validateDocument(rows.bytes);
  assert.equal(after.census.pictures, before.census.pictures + 2);
  assert.equal(after.census.fieldPairs, before.census.fieldPairs + 2);
  assert.equal(after.census.binaryItems, before.census.binaryItems, "그림이 같은 이진 자료를 가리킨다(항목을 더하지 않는다)");
  const xml = sectionText(rows.bytes);
  assert.deepEqual(duplicates(objectIdsIn(xml)), []);
  assert.deepEqual(duplicates([...xml.matchAll(/<hp:fieldBegin id="(\d+)"/g)].map((m) => m[1] ?? "")), []);
  assert.equal([...xml.matchAll(/binaryItemIDRef="image1"/g)].length, 3);
  // 글만 비우면(clear) 누름틀·그림은 남는다
  const cleared = applyChecked(doc, planInsertRows(doc, t, { prototype: 1 }));
  assert.equal(validateDocument(cleared.bytes).census.pictures, before.census.pictures + 1);
  const row = topRows(outerTableXml(sectionText(cleared.bytes)))[2] ?? "";
  assert.ok(!/<hp:t>[^<]+<\/hp:t>/.test(row));
  // 열 복제(그림 열)
  const cols = applyChecked(doc, planInsertColumns(doc, t, { prototype: 2, text: "keep" }));
  assert.equal(validateDocument(cols.bytes).census.pictures, before.census.pictures + 1, "그림 열의 셀 셋이 복제되지만 그림은 한 셀에만 있다");
});

test("조각 복제: 그림이 든 표를 다른 문서에 복제하면 이진 자료와 자원을 가져오고 검사기 새 오류가 없다", () => {
  const src = loadDoc("tables/tables-rich");
  const fragment = extractFragment(src, selectTable(src, 0, 0).selection);
  const dst = loadDoc("hancom/blocks");
  const plan = planCloneTable(dst, at(1), { fragment }, { text: "keep", rows: 4 });
  assert.equal(plan.summary["addedBinaries"], 1);
  const { bytes, doc } = applyChecked(dst, plan);
  const census = validateDocument(bytes).census;
  assert.equal(census.pictures, 1);
  assert.equal(census.binaryItems, 1);
  assert.equal(listTables(doc).find((x) => x.rowCnt === 4)?.colCnt, 3);
  // 같은 문서 안 복제는 이진 자료를 더하지 않는다
  const same = applyChecked(src, planCloneTable(src, at(1), { table: listTables(src)[0]?.target as never }, { text: "keep" }));
  assert.equal(validateDocument(same.bytes).census.binaryItems, 1);
  assert.equal(validateDocument(same.bytes).census.pictures, 2);
});
