// 3단계 구조(열·병합·분할): planInsertColumns·planDeleteColumns·planMergeCells·planSplitCell.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPlan, compareToBaseline, listTables, planDeleteColumns, planInsertColumns, planMergeCells, planSplitCell, validateDocument } from "../src/index.ts";
import { duplicates, formatRefsIn, loadDoc, objectIdsIn } from "./helpers.ts";
import {
  applyChecked,
  attrIn,
  gridTable,
  outerTableXml,
  paragraph,
  readCells,
  reparseBytes,
  rowWidthSums,
  sectionText,
  segPara,
  singleTableDoc,
  tableXml,
  target,
  topRows,
  type CellSpec,
  type TableSpec,
} from "./table-helpers.ts";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, `${code}가 나와야 한다`);
}

const rowTexts = (tbl: string): string[] => topRows(tbl).map((r) => [...r.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|"));
const cellInfo = (tbl: string): string[] => readCells(tbl).map((c) => `${c.row},${c.col}:${c.rowSpan}x${c.colSpan}@${c.width}x${c.height}`);

const uniform = (): TableSpec => gridTable([2000, 3000, 4000], 3, [["a1", "b1", "c1"], ["a2", "b2", "c2"], ["a3", "b3", "c3"]], {}, 700);

test("B3: 열 삽입 — 열 수·열 주소·너비가 맞고 행별 너비 합이 표 너비와 같다. 복제 셀의 서식 참조는 원형과 같다", () => {
  const { doc } = singleTableDoc(uniform());
  const before = outerTableXml(sectionText(doc.pkg.bytes));
  const { bytes } = applyChecked(doc, planInsertColumns(doc, target(doc), { prototype: 1, count: 2, text: "keep" }));
  const tbl = outerTableXml(sectionText(bytes));
  assert.equal(attrIn(tbl, "tbl", "colCnt"), "5");
  assert.equal(attrIn(tbl, "sz", "width"), String(9000 + 2 * 3000));
  assert.deepEqual(rowWidthSums(tbl), [15000, 15000, 15000]);
  assert.deepEqual(readCells(tbl).filter((c) => c.row === 0).map((c) => [c.col, c.width]), [[0, 2000], [1, 3000], [2, 3000], [3, 3000], [4, 4000]]);
  assert.deepEqual(rowTexts(tbl), ["a1|b1|b1|b1|c1", "a2|b2|b2|b2|c2", "a3|b3|b3|b3|c3"]);
  // 복제 셀(열 2, 3)의 서식 참조(테두리·문단·글자)는 원형 셀(열 1)과 같다
  const refs = (row: string, col: number): string => JSON.stringify(formatRefsIn([...row.matchAll(/<hp:tc [\s\S]*?<\/hp:tc>/g)][col]?.[0] ?? ""));
  const rowBefore = topRows(before)[0] ?? "";
  const rowAfter = topRows(tbl)[0] ?? "";
  assert.equal(refs(rowAfter, 2), refs(rowBefore, 1));
  assert.equal(refs(rowAfter, 3), refs(rowBefore, 1));
  assert.equal(attrIn(tbl, "sz", "height"), attrIn(before, "sz", "height"), "높이는 그대로");
});

test("열 삽입: before는 원형 앞에, clear(기본)는 글을 비운다", () => {
  const { doc } = singleTableDoc(uniform());
  const { bytes } = applyChecked(doc, planInsertColumns(doc, target(doc), { prototype: 0, position: "before" }));
  const tbl = outerTableXml(sectionText(bytes));
  assert.deepEqual(rowTexts(tbl), ["|a1|b1|c1", "|a2|b2|c2", "|a3|b3|c3"]);
  assert.deepEqual(readCells(tbl).filter((c) => c.row === 1).map((c) => [c.col, c.width]), [[0, 2000], [1, 2000], [2, 3000], [3, 4000]]);
  assert.deepEqual(rowWidthSums(tbl), [11000, 11000, 11000]);
  const last = applyChecked(doc, planInsertColumns(doc, target(doc), { prototype: 2 })).bytes;
  assert.deepEqual(rowTexts(outerTableXml(sectionText(last))), ["a1|b1|c1|", "a2|b2|c2|", "a3|b3|c3|"]);
});

test("열 삽입: 원형 열을 걸친 가로 병합 셀은 폭과 너비를 늘리고, 세로 병합 셀은 그대로 복제한다", () => {
  const cells: CellSpec[] = [
    { row: 0, col: 0, colSpan: 3, width: 9000, height: 600, text: "제목" },
    { row: 1, col: 0, width: 2000, height: 600, text: "a" },
    { row: 1, col: 1, rowSpan: 2, width: 3000, height: 1200, text: "세로" },
    { row: 1, col: 2, width: 4000, height: 600, text: "c" },
    { row: 2, col: 0, width: 2000, height: 600, text: "d" },
    { row: 2, col: 2, width: 4000, height: 600, text: "f" },
  ];
  const { doc } = singleTableDoc({ rowCnt: 3, colCnt: 3, cells });
  const { bytes } = applyChecked(doc, planInsertColumns(doc, target(doc), { prototype: 1, text: "keep" }));
  const tbl = outerTableXml(sectionText(bytes));
  assert.deepEqual(cellInfo(tbl), [
    "0,0:1x4@12000x600",
    "1,0:1x1@2000x600",
    "1,1:2x1@3000x1200",
    "1,2:2x1@3000x1200",
    "1,3:1x1@4000x600",
    "2,0:1x1@2000x600",
    "2,3:1x1@4000x600",
  ]);
  assert.deepEqual(rowWidthSums(tbl), [12000, 12000, 12000]);
  assert.equal(attrIn(tbl, "sz", "width"), "12000");
});

test("열 삽입: 복제한 셀 안의 인스턴스 id와 책갈피 이름을 새로 준다", () => {
  const nested = gridTable([1000], 1, [["안"]], { id: "6001" });
  const cell = (id: number): string[] => [
    paragraph(`<hp:pic id="${id}" zOrder="2" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id + 1}"><hp:sz width="1" widthRelTo="ABSOLUTE" height="1" heightRelTo="ABSOLUTE" protect="0"/></hp:pic><hp:ctrl><hp:bookmark name="BM"/></hp:ctrl><hp:t/>`, String(id + 10)),
    paragraph(`${tableXml(nested)}<hp:t/>`, String(id + 20)),
  ];
  const { doc } = singleTableDoc({ rowCnt: 2, colCnt: 2, cells: [
    { row: 0, col: 0, width: 2000, height: 600, paragraphs: cell(100) },
    { row: 0, col: 1, width: 2000, height: 600, text: "x" },
    { row: 1, col: 0, width: 2000, height: 600, text: "y" },
    { row: 1, col: 1, width: 2000, height: 600, text: "z" },
  ] });
  const { bytes } = applyChecked(doc, planInsertColumns(doc, target(doc), { prototype: 0, count: 2, text: "keep" }));
  const xml = sectionText(bytes);
  assert.deepEqual(duplicates(objectIdsIn(xml)), []);
  assert.deepEqual(duplicates([...xml.matchAll(/<hp:bookmark name="([^"]*)"/g)].map((m) => m[1] ?? "")), []);
  assert.deepEqual(duplicates([...xml.matchAll(/<hp:p id="(\d+)"/g)].map((m) => m[1] ?? "").filter((v) => v !== "0")), []);
  assert.equal(validateDocument(bytes).census.pictures, 3);
  assert.equal(validateDocument(bytes).census.tables, 4, "바깥 표 1개와 복사본마다 하나씩인 중첩 표 3개");
});

test("열 삽입의 거절: 인자 TABLE_BAD_ARG, 불규칙 TABLE_IRREGULAR, 셀 영역 TABLE_UNSUPPORTED, 너비 기준 TABLE_RELATIVE_SIZE", () => {
  const { doc } = singleTableDoc(uniform());
  const t = target(doc);
  const bad = (o: unknown): void => expectCode(() => planInsertColumns(doc, t, o as never), "TABLE_BAD_ARG");
  bad({ prototype: 3 });
  bad({ prototype: -1 });
  bad({});
  bad({ prototype: 0, count: 0 });
  bad({ prototype: 0, position: "left" });
  bad({ prototype: 0, text: "x" });
  const d4 = loadDoc("D4");
  expectCode(() => planInsertColumns(d4, listTables(d4).find((x) => !x.regular)?.target as never, { prototype: 0 }), "TABLE_IRREGULAR");
  const conflict = singleTableDoc({
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500 },
      { row: 0, col: 1, width: 1000, height: 500 },
      { row: 1, col: 0, width: 1200, height: 500 },
      { row: 1, col: 1, width: 1000, height: 500 },
    ],
  });
  expectCode(() => planInsertColumns(conflict.doc, target(conflict.doc), { prototype: 0 }), "TABLE_IRREGULAR");
  const zone = singleTableDoc({ ...gridTable([2000, 2000], 1), cellzone: true });
  expectCode(() => planInsertColumns(zone.doc, target(zone.doc), { prototype: 0 }), "TABLE_UNSUPPORTED");
  expectCode(() => planDeleteColumns(zone.doc, target(zone.doc), { cols: [0] }), "TABLE_UNSUPPORTED");
  const rel = singleTableDoc({ ...gridTable([2000, 2000], 1), widthRelTo: "PAGE" });
  expectCode(() => planInsertColumns(rel.doc, target(rel.doc), { prototype: 0 }), "TABLE_RELATIVE_SIZE");
  expectCode(() => planDeleteColumns(rel.doc, target(rel.doc), { cols: [0] }), "TABLE_RELATIVE_SIZE");
});

test("열 삭제: 셀·열 주소·열 수·너비를 갱신하고 행별 너비 합이 표 너비와 같다", () => {
  const { doc } = singleTableDoc(uniform());
  const { bytes } = applyChecked(doc, planDeleteColumns(doc, target(doc), { cols: [1] }));
  const tbl = outerTableXml(sectionText(bytes));
  assert.equal(attrIn(tbl, "tbl", "colCnt"), "2");
  assert.equal(attrIn(tbl, "sz", "width"), "6000");
  assert.deepEqual(rowTexts(tbl), ["a1|c1", "a2|c2", "a3|c3"]);
  assert.deepEqual(readCells(tbl).filter((c) => c.row === 0).map((c) => [c.col, c.width]), [[0, 2000], [1, 4000]]);
  assert.deepEqual(rowWidthSums(tbl), [6000, 6000, 6000]);
  // 여러 열: 0과 2를 지우면 가운데 열이 0번이 된다
  const two = applyChecked(doc, planDeleteColumns(doc, target(doc), { cols: [2, 0] })).bytes;
  const t2 = outerTableXml(sectionText(two));
  assert.deepEqual(rowTexts(t2), ["b1", "b2", "b3"]);
  assert.deepEqual(readCells(t2).map((c) => c.col), [0, 0, 0]);
  assert.equal(attrIn(t2, "sz", "width"), "3000");
});

test("열 삭제: 지운 열을 일부 걸친 병합 셀은 폭과 너비가 줄고, 지운 열 안에만 있던 셀은 사라진다", () => {
  const cells: CellSpec[] = [
    { row: 0, col: 0, colSpan: 3, width: 9000, height: 600, text: "제목" },
    { row: 1, col: 0, width: 2000, height: 600, text: "a" },
    { row: 1, col: 1, colSpan: 2, width: 7000, height: 600, text: "bc" },
    { row: 2, col: 0, width: 2000, height: 600, text: "d" },
    { row: 2, col: 1, width: 3000, height: 600, text: "e" },
    { row: 2, col: 2, width: 4000, height: 600, text: "f" },
  ];
  const { doc } = singleTableDoc({ rowCnt: 3, colCnt: 3, cells });
  const one = applyChecked(doc, planDeleteColumns(doc, target(doc), { cols: [2] })).bytes;
  assert.deepEqual(cellInfo(outerTableXml(sectionText(one))), ["0,0:1x2@5000x600", "1,0:1x1@2000x600", "1,1:1x1@3000x600", "2,0:1x1@2000x600", "2,1:1x1@3000x600"]);
  assert.deepEqual(rowWidthSums(outerTableXml(sectionText(one))), [5000, 5000, 5000]);
  const both = applyChecked(doc, planDeleteColumns(doc, target(doc), { cols: [1, 2] })).bytes;
  assert.deepEqual(cellInfo(outerTableXml(sectionText(both))), ["0,0:1x1@2000x600", "1,0:1x1@2000x600", "2,0:1x1@2000x600"]);
});

test("열 삭제의 거절: 모든 열·범위 밖·겹침은 TABLE_BAD_ARG, 셀이 하나도 남지 않는 행이 생기면 TABLE_SPAN_CONFLICT", () => {
  const { doc } = singleTableDoc(uniform());
  const t = target(doc);
  const bad = (o: unknown): void => expectCode(() => planDeleteColumns(doc, t, o as never), "TABLE_BAD_ARG");
  bad({ cols: [0, 1, 2] });
  bad({ cols: [] });
  bad({ cols: [3] });
  bad({ cols: [-1] });
  bad({ cols: [1, 1] });
  bad({});
  const vertical = singleTableDoc({
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500, text: "A" },
      { row: 0, col: 1, rowSpan: 2, width: 1000, height: 1000, text: "B" },
      { row: 1, col: 0, width: 1000, height: 500, text: "C" },
    ],
  });
  expectCode(() => planDeleteColumns(vertical.doc, target(vertical.doc), { cols: [0] }), "TABLE_SPAN_CONFLICT");
  // 오른쪽 열을 지우는 것은 된다(B가 사라지고 행 0·1에 A, C만 남는다)
  const ok = applyChecked(vertical.doc, planDeleteColumns(vertical.doc, target(vertical.doc), { cols: [1] })).bytes;
  assert.deepEqual(cellInfo(outerTableXml(sectionText(ok))), ["0,0:1x1@1000x500", "1,0:1x1@1000x500"]);
});

test("B3: 실제 시험 문서에서 마지막 열을 복제해 넣고 지워도 격자와 검사기가 맞다(병합 포함)", () => {
  let inserted = 0;
  let deleted = 0;
  for (const name of ["D1", "D2", "D3", "D5", "D6", "D7", "hancom-merged", "hancom/blocks", "hancom/ph-table", "extra/features-picture"]) {
    const doc = loadDoc(name);
    for (const info of listTables(doc)) {
      if (!info.regular || info.depth > 0 || info.colCnt === undefined) continue;
      const add = applyChecked(doc, planInsertColumns(doc, info.target, { prototype: info.colCnt - 1, count: 2 }));
      assert.equal(listTables(add.doc).find((x) => x.ordinal === info.ordinal)?.colCnt, info.colCnt + 2);
      inserted++;
      if (info.colCnt < 2) continue;
      try {
        const del = applyChecked(doc, planDeleteColumns(doc, info.target, { cols: [info.colCnt - 1] }));
        assert.equal(listTables(del.doc).find((x) => x.ordinal === info.ordinal)?.colCnt, info.colCnt - 1);
        deleted++;
      } catch (e) {
        assert.equal((e as { code?: string }).code, "TABLE_SPAN_CONFLICT", `${name} #${info.ordinal}`);
      }
    }
  }
  assert.ok(inserted >= 25 && deleted >= 15, `삽입 ${inserted}, 삭제 ${deleted}`);
});

// ── 병합·분할 ───────────────────────────────────────────────────

test("병합: 왼쪽 위 셀이 남아 병합 수와 너비·높이가 걸친 열·행의 합이 되고 다른 셀은 사라진다. concat은 비어 있지 않은 문단을 이어 붙인다", () => {
  const { doc } = singleTableDoc(uniform());
  const { bytes } = applyChecked(doc, planMergeCells(doc, target(doc), { rows: [0, 1], cols: [0, 1] }));
  const tbl = outerTableXml(sectionText(bytes));
  assert.deepEqual(cellInfo(tbl), ["0,0:2x2@5000x1400", "0,2:1x1@4000x700", "1,2:1x1@4000x700", "2,0:1x1@2000x700", "2,1:1x1@3000x700", "2,2:1x1@4000x700"]);
  // 글: a1, b1, a2, b2 가 행·열 순서로 한 셀에 이어 붙는다(문단 4개)
  const topLeft = topRows(tbl)[0]?.match(/<hp:tc [\s\S]*?<\/hp:tc>/)?.[0] ?? "";
  assert.deepEqual([...topLeft.matchAll(/<hp:p [^>]*>[\s\S]*?<\/hp:p>/g)].map((m) => [...m[0].matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((x) => x[1]).join("")), ["a1", "b1", "a2", "b2"]);
  assert.equal(attrIn(tbl, "tbl", "rowCnt"), "3");
  assert.equal(attrIn(tbl, "sz", "width"), "9000", "표 크기는 그대로");
  assert.deepEqual(rowWidthSums(tbl), [9000, 9000, 9000]);
});

test("병합 content: first는 왼쪽 위 셀의 글만 남기고, 비어 있는 셀은 문단을 보태지 않으며, 왼쪽 위가 비면 그 빈 문단을 지운다", () => {
  const spec = gridTable([2000, 3000, 1000], 2, [["x", "", "p"], ["", "w", "q"]], {}, 700);
  const { doc } = singleTableDoc(spec);
  const first = applyChecked(doc, planMergeCells(doc, target(doc), { rows: [0, 1], cols: [0, 1], content: "first" })).bytes;
  assert.deepEqual(rowTexts(outerTableXml(sectionText(first))), ["x|p", "q"]);
  const concat = applyChecked(doc, planMergeCells(doc, target(doc), { rows: [0, 1], cols: [0, 1] })).bytes;
  assert.deepEqual(rowTexts(outerTableXml(sectionText(concat))), ["x|w|p", "q"]);
  // 왼쪽 위(빈) + 다른 셀의 글
  const emptyHead = singleTableDoc(gridTable([2000, 3000], 1, [["", "뒤"]], {}, 700));
  const out = applyChecked(emptyHead.doc, planMergeCells(emptyHead.doc, target(emptyHead.doc), { rows: [0, 0], cols: [0, 1] })).bytes;
  const cell = outerTableXml(sectionText(out)).match(/<hp:tc [\s\S]*?<\/hp:tc>/)?.[0] ?? "";
  assert.equal(cell.match(/<hp:p /g)?.length, 1, "빈 문단은 지워지고 옮긴 문단 하나만 남는다");
  assert.match(cell, /<hp:t>뒤<\/hp:t>/);
});

test("병합 거절: 합친 뒤 셀이 하나도 시작하지 않는 행이 생기면 TABLE_SPAN_CONFLICT(한컴이 빈 행을 열지 못한다)", () => {
  // 모든 열을 덮는 두 행 병합: 행 1에 시작하는 셀이 없어진다
  const { doc } = singleTableDoc(uniform());
  expectCode(() => planMergeCells(doc, target(doc), { rows: [0, 1], cols: [0, 2] }), "TABLE_SPAN_CONFLICT");
  expectCode(() => planMergeCells(doc, target(doc), { rows: [0, 2], cols: [0, 2] }), "TABLE_SPAN_CONFLICT");
  // 한 행의 전체 열 병합은 된다
  assert.ok(planMergeCells(doc, target(doc), { rows: [1, 1], cols: [0, 2] }).edits.length > 0);
  // 남은 열이 위에서 내려오는 병합에 덮이는 경우: 열 2의 세로 병합(행 0~2)과 열 0·1 행 1~2 병합
  const tall = singleTableDoc({
    rowCnt: 3,
    colCnt: 3,
    cells: [
      { row: 0, col: 0, width: 2000, height: 600, text: "a" },
      { row: 0, col: 1, width: 3000, height: 600, text: "b" },
      { row: 0, col: 2, rowSpan: 3, width: 4000, height: 1800, text: "세로" },
      { row: 1, col: 0, width: 2000, height: 600, text: "c" },
      { row: 1, col: 1, width: 3000, height: 600, text: "d" },
      { row: 2, col: 0, width: 2000, height: 600, text: "e" },
      { row: 2, col: 1, width: 3000, height: 600, text: "f" },
    ],
  });
  expectCode(() => planMergeCells(tall.doc, target(tall.doc), { rows: [1, 2], cols: [0, 1] }), "TABLE_SPAN_CONFLICT");
  expectCode(() => planMergeCells(tall.doc, target(tall.doc), { rows: [0, 1], cols: [0, 1] }), "TABLE_SPAN_CONFLICT");
  // 한 행 안의 병합은 언제나 된다
  assert.ok(planMergeCells(tall.doc, target(tall.doc), { rows: [1, 1], cols: [0, 1] }).edits.length > 0);
});

test("병합: 범위가 병합 셀을 일부만 덮으면 TABLE_SPAN_CONFLICT, 이미 하나인 셀·범위 밖·역순은 TABLE_BAD_ARG", () => {
  const cells: CellSpec[] = [
    { row: 0, col: 0, colSpan: 2, width: 5000, height: 600, text: "넓은" },
    { row: 0, col: 2, width: 4000, height: 600, text: "c" },
    { row: 1, col: 0, width: 2000, height: 600, text: "d" },
    { row: 1, col: 1, width: 3000, height: 600, text: "e" },
    { row: 1, col: 2, width: 4000, height: 600, text: "f" },
  ];
  const { doc } = singleTableDoc({ rowCnt: 2, colCnt: 3, cells });
  const t = target(doc);
  expectCode(() => planMergeCells(doc, t, { rows: [0, 1], cols: [1, 2] }), "TABLE_SPAN_CONFLICT");
  // 병합 셀(0,0 colSpan 2)의 한 칸만 고르면 그 셀이 범위 밖으로 뻗는다
  expectCode(() => planMergeCells(doc, t, { rows: [0, 0], cols: [0, 0] }), "TABLE_SPAN_CONFLICT");
  // 이미 셀 하나인 범위: 보통 셀 한 칸, 그리고 병합 셀과 정확히 같은 범위
  expectCode(() => planMergeCells(doc, t, { rows: [1, 1], cols: [0, 0] }), "TABLE_BAD_ARG");
  expectCode(() => planMergeCells(doc, t, { rows: [0, 0], cols: [0, 1] }), "TABLE_BAD_ARG");
  expectCode(() => planMergeCells(doc, t, { rows: [0, 2], cols: [0, 1] }), "TABLE_BAD_ARG");
  expectCode(() => planMergeCells(doc, t, { rows: [1, 0], cols: [0, 1] }), "TABLE_BAD_ARG");
  expectCode(() => planMergeCells(doc, t, { rows: [0, 1], cols: [0, 1], content: "all" as never }), "TABLE_BAD_ARG");
  expectCode(() => planMergeCells(doc, t, {} as never), "TABLE_BAD_ARG");
  // 이미 병합된 셀을 완전히 포함하는 범위는 된다
  const ok = applyChecked(doc, planMergeCells(doc, t, { rows: [0, 1], cols: [0, 1] })).bytes;
  assert.deepEqual(cellInfo(outerTableXml(sectionText(ok))).slice(0, 2), ["0,0:2x2@5000x1200", "0,2:1x1@4000x600"]);
  const d4 = loadDoc("D4");
  expectCode(() => planMergeCells(d4, listTables(d4).find((x) => !x.regular)?.target as never, { rows: [0, 0], cols: [0, 1] }), "TABLE_IRREGULAR");
});

test("분할: 병합을 풀면 칸마다 1×1 셀이 되고 새 셀은 원 셀의 서식을 복제한 빈 셀이다. 병합→분할은 격자를 되돌린다", () => {
  const spec = uniform();
  spec.cells = spec.cells.map((c) => (c.row === 0 && c.col === 0 ? { ...c, borderFillIDRef: "1", name: "머리" } : c));
  const { doc } = singleTableDoc(spec);
  const merged = applyChecked(doc, planMergeCells(doc, target(doc), { rows: [0, 1], cols: [0, 1] }));
  const { bytes } = applyChecked(merged.doc, planSplitCell(merged.doc, target(merged.doc), { row: 0, col: 0 }));
  const tbl = outerTableXml(sectionText(bytes));
  const original = outerTableXml(sectionText(doc.pkg.bytes));
  assert.deepEqual(cellInfo(tbl), cellInfo(original), "병합 전과 같은 격자(주소·병합·너비·높이)");
  assert.equal(attrIn(tbl, "tbl", "rowCnt"), "3");
  // 왼쪽 위 칸은 합쳐진 글(문단 4개)을 그대로 갖고, 새로 생긴 셀 셋은 글이 없다
  const cellsOf = (row: string): string[] => row.match(/<hp:tc [\s\S]*?<\/hp:tc>/g) ?? [];
  const rows = topRows(tbl);
  const [r0, r1] = [cellsOf(rows[0] ?? ""), cellsOf(rows[1] ?? "")];
  assert.deepEqual([...(r0[0] ?? "").matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]), ["a1", "b1", "a2", "b2"]);
  for (const empty of [r0[1], r1[0], r1[1]]) assert.ok(!/<hp:t>[^<]+<\/hp:t>/.test(empty ?? "x"), "새 셀은 글이 없다");
  assert.equal(r0.length, 3);
  assert.equal(r1.length, 3);
  // 새 셀은 원 셀과 같은 서식 참조(테두리·세로 정렬·여백·문단·글자)를 갖되 셀 이름은 비운다
  const startTag = (cell: string): string => cell.match(/^<hp:tc [^>]*>/)?.[0] ?? "";
  assert.equal(startTag(r0[1] ?? "").replace(/ name="[^"]*"/, ""), startTag(r0[0] ?? "").replace(/ name="[^"]*"/, ""));
  assert.match(startTag(r0[1] ?? ""), / name=""/);
  const subTag = (cell: string): string => cell.match(/<hp:subList [^>]*>/)?.[0] ?? "";
  assert.equal(subTag(r0[1] ?? ""), subTag(r0[0] ?? ""));
  assert.deepEqual(formatRefsIn(r1[1] ?? "").map((x) => x.kind), formatRefsIn(r0[0]?.replace(/<hp:p [\s\S]*<\/hp:p>/, (r1[1] ?? "").match(/<hp:p [\s\S]*<\/hp:p>/)?.[0] ?? "") ?? "").map((x) => x.kind));
  // 병합이 합친 글은 분할로 없어지지 않는다(원 셀에 남는다)
  assert.equal([...sectionText(bytes).matchAll(/<hp:t>/g)].length, [...sectionText(merged.bytes).matchAll(/<hp:t>/g)].length);
});

test("분할: 세로·가로·2×3 병합을 풀고(병합 셀이 덮는 아무 칸의 주소로 지정), 1×1이나 범위 밖 주소는 TABLE_BAD_ARG다", () => {
  const spec: TableSpec = {
    rowCnt: 3,
    colCnt: 3,
    cells: [
      { row: 0, col: 0, rowSpan: 2, colSpan: 3, width: 9000, height: 1400, paragraphs: [segPara("큰", "55555")] },
      { row: 2, col: 0, colSpan: 2, width: 5000, height: 700, text: "가로" },
      { row: 2, col: 2, width: 4000, height: 700, text: "끝" },
    ],
  };
  const { doc } = singleTableDoc(spec);
  // 칸 (1, 2)를 지정해도 그 칸을 덮는 병합 셀을 푼다. 열 너비는 가로 병합 셀을 균등 분배한 [2500, 2500, 4000], 행 높이는 [700, 700, 700]
  const { bytes } = applyChecked(doc, planSplitCell(doc, target(doc), { row: 1, col: 2 }));
  const tbl = outerTableXml(sectionText(bytes));
  const top = readCells(tbl).filter((c) => c.row < 2);
  assert.equal(top.length, 6);
  assert.ok(top.every((c) => c.rowSpan === 1 && c.colSpan === 1 && c.height === 700));
  assert.deepEqual(top.filter((c) => c.row === 0).map((c) => c.width), [2500, 2500, 4000]);
  // 원 셀의 문단 id(55555)는 한 번만 쓰이고 새 셀의 문단 id는 자리값 0이다
  assert.deepEqual([...sectionText(bytes).matchAll(/<hp:p id="(\d+)"/g)].map((m) => m[1]).filter((v) => v !== "0"), ["55555"]);
  assert.equal(validateDocument(bytes).errors.length, 0);
  // 이어서 가로 병합만 푼다
  const next = reparseBytes(bytes);
  const again = applyChecked(next, planSplitCell(next, target(next), { row: 2, col: 0 })).bytes;
  assert.deepEqual(readCells(outerTableXml(sectionText(again))).filter((c) => c.row === 2).map((c) => [c.col, c.colSpan, c.width]), [[0, 1, 2500], [1, 1, 2500], [2, 1, 4000]]);

  const bad = (o: unknown): void => expectCode(() => planSplitCell(doc, target(doc), o as never), "TABLE_BAD_ARG");
  bad({ row: 3, col: 0 });
  bad({ row: -1, col: 0 });
  bad({});
  expectCode(() => planSplitCell(next, target(next), { row: 2, col: 2 }), "TABLE_BAD_ARG");
});

test("분할: 실제 시험 문서의 병합 셀을 하나씩 풀어도 격자와 검사기가 맞다", () => {
  let split = 0;
  for (const name of ["D2", "D3", "D6", "extra/features-picture"]) {
    const doc = loadDoc(name);
    for (const info of listTables(doc)) {
      if (!info.regular || info.depth > 0 || info.mergedCells === 0) continue;
      const tbl = outerTableXml(sectionText(doc.pkg.bytes), info.topOrdinal ?? 0);
      const merged = readCells(tbl).filter((c) => c.rowSpan > 1 || c.colSpan > 1);
      for (const c of merged.slice(0, 6)) {
        const out = applyChecked(doc, planSplitCell(doc, info.target, { row: c.row, col: c.col }));
        const after = listTables(out.doc).find((x) => x.ordinal === info.ordinal);
        assert.equal(after?.regular, true, `${name} #${info.ordinal} (${c.row},${c.col})`);
        assert.equal(after?.mergedCells, info.mergedCells - 1);
        split++;
      }
    }
  }
  assert.ok(split >= 10, `푼 병합 셀 ${split}개`);
});

test("분할: 새 셀은 원 셀의 서식 참조를 그대로 물려받는다 — 원 셀이 없는 서식을 가리키면 같은 오류가 칸 수만큼 늘 뿐 새 종류의 오류는 없다", () => {
  const spec: TableSpec = {
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, colSpan: 2, width: 6000, height: 700, text: "합", borderFillIDRef: "999" },
      { row: 1, col: 0, width: 3000, height: 700, text: "a" },
      { row: 1, col: 1, width: 3000, height: 700, text: "b" },
    ],
  };
  const { doc } = singleTableDoc(spec);
  const before = validateDocument(doc.pkg.bytes);
  assert.ok(before.errors.some((e) => e.code === "RES_DANGLING"), "원본에 이미 끊어진 참조가 있어야 한다");
  const plan = planSplitCell(doc, target(doc), { row: 0, col: 0 });
  const bytes = applyPlan(doc.pkg, plan);
  const tbl = outerTableXml(sectionText(bytes));
  const topCells = [...tbl.matchAll(/<hp:tc [^>]*borderFillIDRef="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(topCells.slice(0, 2), ["999", "999"]);
  const fresh = compareToBaseline(before, validateDocument(bytes)).newErrors;
  assert.ok(fresh.length > 0);
  for (const e of fresh) assert.ok(before.errors.some((x) => x.code === e.code && x.message === e.message), `${e.code}: ${e.message}`);
});
