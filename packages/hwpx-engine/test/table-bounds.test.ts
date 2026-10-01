// H1: 열 너비·행 높이를 경계 위치로 구한다. 병합 셀 경계가 행마다 다르게 말하는 표(너비 불규칙)는 열 너비가 필요한 연산에서 거절하고,
// 모순이 없는 표는 경계 위치를 정확히 지킨다. 독립 기준은 시험 도우미의 정규식 행별 너비 합(`rowWidthSums`)이다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkTableGeometry,
  listTables,
  planCloneTable,
  planDeleteColumns,
  planInsertColumns,
  planInsertRows,
  planMergeCells,
  planRepeatRows,
  planScaleTable,
  planSetCellProps,
  planSetColumnWidths,
  planSetRowHeights,
  planSetTableProps,
  planSplitCell,
  readTableGrid,
} from "../src/index.ts";
import {
  applyChecked,
  outerTableXml,
  readCells,
  rowWidthSums,
  sectionText,
  singleTableDoc,
  target,
  type CellSpec,
  type TableSpec,
} from "./table-helpers.ts";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, `${code}가 나와야 한다`);
}

/**
 * 3행 × 5열, 표 너비 15000. (행, 열) 병합 너비:
 * 0행 (0,0)1×1 1000, (0,1)1×2 5000, (0,3)1×2 9000 / 1행 (1,0)1×3 6000, (1,3)1×1 4000, (1,4)1×1 5000 / 2행 (2,0)1×2 1500, (2,2)1×3 13500.
 * 맞는 열 너비는 [1000, 500, 4500, 4000, 5000]이다(경계 위치 0, 1000, 1500, 6000, 10000, 15000).
 */
function fiveColumns(): TableSpec {
  return {
    rowCnt: 3,
    colCnt: 5,
    width: 15000,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500, text: "a" },
      { row: 0, col: 1, colSpan: 2, width: 5000, height: 500, text: "b" },
      { row: 0, col: 3, colSpan: 2, width: 9000, height: 500, text: "c" },
      { row: 1, col: 0, colSpan: 3, width: 6000, height: 500, text: "d" },
      { row: 1, col: 3, width: 4000, height: 500, text: "e" },
      { row: 1, col: 4, width: 5000, height: 500, text: "f" },
      { row: 2, col: 0, colSpan: 2, width: 1500, height: 500, text: "g" },
      { row: 2, col: 2, colSpan: 3, width: 13500, height: 500, text: "h" },
    ],
  };
}

/** 세로 병합이 섞이고 열 1의 경계가 어느 행에서도 가장자리가 아닌 표(너비 10000): 맞는 열 너비는 [1500, 1500, 2000, 5000] */
function verticalMix(): TableSpec {
  return {
    rowCnt: 3,
    colCnt: 4,
    width: 10000,
    cells: [
      { row: 0, col: 0, rowSpan: 2, colSpan: 2, width: 3000, height: 1000, text: "큰" },
      { row: 0, col: 2, width: 2000, height: 500, text: "p" },
      { row: 0, col: 3, width: 5000, height: 500, text: "q" },
      { row: 1, col: 2, colSpan: 2, width: 7000, height: 500, text: "r" },
      { row: 2, col: 0, colSpan: 2, width: 3000, height: 500, text: "s" },
      { row: 2, col: 2, width: 2000, height: 500, text: "t" },
      { row: 2, col: 3, width: 5000, height: 500, text: "u" },
    ],
  };
}

/** 행끼리 모순: 열 경계 1을 0행은 1000, 1행은 1200으로 말한다 */
function contradictory(): TableSpec {
  return {
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500, text: "a" },
      { row: 0, col: 1, width: 1000, height: 500, text: "b" },
      { row: 1, col: 0, width: 1200, height: 500, text: "c" },
      { row: 1, col: 1, width: 1000, height: 500, text: "d" },
    ],
  };
}

const infoOf = (doc: Parameters<typeof listTables>[0]) => listTables(doc)[0];
const sumsOf = (bytes: Uint8Array): number[] => rowWidthSums(outerTableXml(sectionText(bytes)));
const cellsOf = (bytes: Uint8Array) => readCells(outerTableXml(sectionText(bytes)));
const tableWidth = (bytes: Uint8Array): number => Number(/<hp:sz width="(\d+)"/.exec(outerTableXml(sectionText(bytes)))?.[1]);
const allPositive = (bytes: Uint8Array): boolean => cellsOf(bytes).every((c) => c.width >= 1 && c.height >= 0);

test("H1: 병합 경계에서 열 너비를 추정한다 — 3×5 표는 [1000, 500, 4500, 4000, 5000]이고 규칙적이다", () => {
  const { doc } = singleTableDoc(fiveColumns());
  const grid = readTableGrid(infoOf(doc)?.target.element as never);
  assert.deepEqual(grid.problems, []);
  assert.deepEqual(grid.widthProblems, []);
  assert.deepEqual(grid.xBounds, [0, 1000, 1500, 6000, 10000, 15000]);
  assert.deepEqual(grid.widths, [1000, 500, 4500, 4000, 5000]);
  const info = infoOf(doc);
  assert.deepEqual([info?.structureRegular, info?.widthRegular, info?.regular], [true, true, true]);
  assert.deepEqual(checkTableGeometry(info?.target.element as never), []);
});

test("H1: 세로 병합이 섞이고 병합으로만 덮인 열이 있는 표 — 아는 경계 사이를 균등하게 나눈다(나머지는 묶음의 마지막 열)", () => {
  const { doc } = singleTableDoc(verticalMix());
  const grid = readTableGrid(infoOf(doc)?.target.element as never);
  assert.deepEqual(grid.widths, [1500, 1500, 2000, 5000]);
  // 홀수로 나뉘는 묶음: 너비 3001을 두 열로 → [1500, 1501](나머지는 묶음의 마지막 열). 열 2·3은 1999·5001
  const odd: TableSpec = {
    rowCnt: 3,
    colCnt: 4,
    width: 10001,
    cells: [
      { row: 0, col: 0, rowSpan: 2, colSpan: 2, width: 3001, height: 1000, text: "큰" },
      { row: 0, col: 2, width: 1999, height: 500, text: "p" },
      { row: 0, col: 3, width: 5001, height: 500, text: "q" },
      { row: 1, col: 2, colSpan: 2, width: 7000, height: 500, text: "r" },
      { row: 2, col: 0, colSpan: 2, width: 3001, height: 500, text: "s" },
      { row: 2, col: 2, width: 1999, height: 500, text: "t" },
      { row: 2, col: 3, width: 5001, height: 500, text: "u" },
    ],
  };
  const g2 = readTableGrid(infoOf(singleTableDoc(odd).doc)?.target.element as never);
  assert.deepEqual(g2.widthProblems, []);
  assert.deepEqual(g2.widths, [1500, 1501, 1999, 5001]);
});

test("H1: 열 삭제 — 병합 셀 너비가 지운 열의 너비만큼 줄고 행별 너비 합이 표 너비와 같다(음수 없음)", () => {
  const { doc } = singleTableDoc(fiveColumns());
  const { bytes } = applyChecked(doc, planDeleteColumns(doc, target(doc), { cols: [1] }));
  assert.deepEqual(sumsOf(bytes), [14500, 14500, 14500]);
  assert.equal(tableWidth(bytes), 14500);
  assert.ok(allPositive(bytes));
  const widthOf = (row: number, col: number): number | undefined => cellsOf(bytes).find((c) => c.row === row && c.col === col)?.width;
  assert.equal(widthOf(0, 1), 4500); // 열 1·2에 걸쳐 5000이던 셀 → 열 2만 남는다
  assert.equal(widthOf(1, 0), 5500); // 열 0~2에 걸친 6000 → 열 0·2
  assert.equal(widthOf(2, 0), 1000); // 열 0·1에 걸친 1500 → 열 0
  // 열 2도 지운다
  const two = applyChecked(doc, planDeleteColumns(doc, target(doc), { cols: [1, 2] })).bytes;
  assert.deepEqual(sumsOf(two), [10000, 10000, 10000]);
});

test("H1: 분할 — 합쳐진 칸의 너비가 그 열의 너비로 나뉘어 행별 합이 표 너비 그대로다", () => {
  const { doc } = singleTableDoc(fiveColumns());
  const { bytes } = applyChecked(doc, planSplitCell(doc, target(doc), { row: 2, col: 0 }));
  assert.deepEqual(sumsOf(bytes), [15000, 15000, 15000]);
  assert.deepEqual(cellsOf(bytes).filter((c) => c.row === 2 && c.col < 2).map((c) => c.width), [1000, 500]);
  assert.ok(allPositive(bytes));
  // 가로로 걸친 셀을 하나씩 모두 풀어도 합이 유지된다
  let cur = doc;
  let out = bytes;
  for (const [row, col] of [[0, 1], [0, 3], [1, 0], [2, 2]] as const) {
    const done = applyChecked(cur, planSplitCell(cur, target(cur), { row, col }));
    cur = done.doc;
    out = done.bytes;
  }
  assert.deepEqual(sumsOf(out), [15000, 15000, 15000]);
  assert.deepEqual(cellsOf(out).filter((c) => c.row === 0).map((c) => c.width), [1000, 500, 4500, 4000, 5000]);
});

test("H1: 비례 조정은 경계 위치를 옮긴다 — scale 1과 같은 width는 편집이 없고, 그 밖의 비율에서도 행별 합이 목표 너비다", () => {
  const { doc } = singleTableDoc(fiveColumns());
  assert.equal(planScaleTable(doc, target(doc), { scale: 1 }).edits.length, 0);
  assert.equal(planScaleTable(doc, target(doc), { width: 15000 }).edits.length, 0);
  // 표 `sz@width`가 열 합과 다른 표도 비율 1이면 편집이 없다(표 너비를 건드리지 않는다)
  const off = singleTableDoc({ ...fiveColumns(), width: 15200 });
  assert.equal(planScaleTable(off.doc, target(off.doc), { scale: 1 }).edits.length, 0);

  const doubled = applyChecked(doc, planScaleTable(doc, target(doc), { scale: 2 })).bytes;
  assert.deepEqual(sumsOf(doubled), [30000, 30000, 30000]);
  assert.deepEqual(cellsOf(doubled).filter((c) => c.row === 0).map((c) => c.width), [2000, 10000, 18000]);
  for (const width of [14999, 7500, 9001, 6000, 33333, 1234]) {
    const bytes = applyChecked(doc, planScaleTable(doc, target(doc), { width })).bytes;
    assert.deepEqual(sumsOf(bytes), [width, width, width], `width ${width}`);
    assert.equal(tableWidth(bytes), width);
    assert.ok(allPositive(bytes), `width ${width}`);
    // 경계 위치가 round(경계 × 비율)이다: 0행 첫 셀(경계 0~1000)의 너비
    assert.equal(cellsOf(bytes).find((c) => c.row === 0 && c.col === 0)?.width, Math.round((1000 * width) / 15000), `width ${width}`);
  }
});

test("H1: 비례 조정으로 열 너비가 1 미만이 되면 TABLE_BAD_ARG(열 경계 사이가 좁은 병합 표)", () => {
  const { doc } = singleTableDoc(fiveColumns());
  // 표 너비 5는 열 수(5) 이상이지만 경계 1000이 round(0.33) = 0으로 가서 첫 열 너비가 0이 된다
  expectCode(() => planScaleTable(doc, target(doc), { width: 5 }), "TABLE_BAD_ARG");
  expectCode(() => planScaleTable(doc, target(doc), { scale: 0.0005 }), "TABLE_BAD_ARG");
});

test("H1: 세로 병합이 섞인 표 — 열 삭제·분할·비례 조정·열 삽입 뒤 행별 너비 합이 표 너비와 같다", () => {
  const { doc } = singleTableDoc(verticalMix());
  const sumsAre = (bytes: Uint8Array, width: number): void => {
    assert.deepEqual(sumsOf(bytes), [width, width, width]);
    assert.ok(allPositive(bytes));
  };
  sumsAre(applyChecked(doc, planDeleteColumns(doc, target(doc), { cols: [1] })).bytes, 8500);
  sumsAre(applyChecked(doc, planDeleteColumns(doc, target(doc), { cols: [2] })).bytes, 8000);
  sumsAre(applyChecked(doc, planSplitCell(doc, target(doc), { row: 0, col: 0 })).bytes, 10000);
  sumsAre(applyChecked(doc, planScaleTable(doc, target(doc), { scale: 1.5 })).bytes, 15000);
  sumsAre(applyChecked(doc, planScaleTable(doc, target(doc), { scale: 1 })).bytes, 10000);
  sumsAre(applyChecked(doc, planInsertColumns(doc, target(doc), { prototype: 0, count: 2 })).bytes, 13000);
  sumsAre(applyChecked(doc, planInsertColumns(doc, target(doc), { prototype: 2, position: "before" })).bytes, 12000);
  // 분할한 칸의 너비: 병합으로만 덮인 열 0·1이 균등하게 1500씩
  const split = applyChecked(doc, planSplitCell(doc, target(doc), { row: 0, col: 0 })).bytes;
  assert.deepEqual(cellsOf(split).filter((c) => c.row === 0 && c.col < 2).map((c) => c.width), [1500, 1500]);
  // 합치기: 위 규칙으로 구한 너비의 합이 합친 셀의 너비다
  const merged = applyChecked(doc, planMergeCells(doc, target(doc), { rows: [2, 2], cols: [2, 3] })).bytes;
  assert.equal(cellsOf(merged).find((c) => c.row === 2 && c.col === 2)?.width, 7000);
  sumsAre(merged, 10000);
});

test("H1: 행끼리 열 경계가 모순인 표는 너비 불규칙이다 — 열 너비가 필요한 연산은 TABLE_IRREGULAR, 행 연산·열 너비 지정·설정은 한다", () => {
  const { doc } = singleTableDoc(contradictory());
  const info = infoOf(doc);
  assert.deepEqual([info?.structureRegular, info?.widthRegular, info?.regular], [true, false, false]);
  const grid = readTableGrid(info?.target.element as never);
  assert.deepEqual(grid.problems, []);
  assert.equal(grid.widths, undefined);
  assert.equal(grid.widthProblems.length, 1);
  const issues = checkTableGeometry(info?.target.element as never);
  assert.deepEqual(issues.map((i) => i.code), ["TABLE_WIDTH_SUM"]);

  const t = target(doc);
  expectCode(() => planScaleTable(doc, t, { scale: 2 }), "TABLE_IRREGULAR");
  expectCode(() => planScaleTable(doc, t, { scale: 1 }), "TABLE_IRREGULAR");
  expectCode(() => planDeleteColumns(doc, t, { cols: [0] }), "TABLE_IRREGULAR");
  expectCode(() => planInsertColumns(doc, t, { prototype: 0 }), "TABLE_IRREGULAR");
  expectCode(() => planMergeCells(doc, t, { rows: [0, 0], cols: [0, 1] }), "TABLE_IRREGULAR");
  expectCode(() => planSplitCell(doc, t, { row: 0, col: 0 }), "TABLE_IRREGULAR");
  // 열 수를 바꾸는 복제는 거절, 행 수만 바꾸거나 그대로 복제하는 것은 한다(지금까지 복제만 거절하던 불일치를 없앤다)
  const at = { sectionIndex: 0, parentPath: [], index: 1, position: "after" as const };
  expectCode(() => planCloneTable(doc, at, { table: t }, { cols: 3 }), "TABLE_IRREGULAR");
  assert.ok(planCloneTable(doc, at, { table: t }, { rows: 3 }).edits.length > 0);
  assert.ok(planCloneTable(doc, at, { table: t }, { rows: 1 }).edits.length > 0);
  assert.ok(planCloneTable(doc, at, { table: t }).edits.length > 0);
  // 허용: 행 삽입·반복·행 높이·열 너비 지정·표와 셀 설정
  assert.ok(planInsertRows(doc, t, { prototype: 0 }).edits.length > 0);
  assert.ok(planRepeatRows(doc, t, { row: 0, count: 3 }).edits.length > 0);
  assert.ok(planSetRowHeights(doc, t, [{ row: 0, height: 10 }]).edits.length > 0);
  assert.ok(planSetTableProps(doc, t, { pageBreak: "NONE" }).edits.length > 0);
  assert.ok(planSetCellProps(doc, t, [{ props: { vertAlign: "TOP" } }]).edits.length > 0);
  // 열 너비 지정은 새 너비를 주므로 모순을 풀어 준다: 모든 셀이 새 열 너비의 합이다
  const fixed = applyChecked(doc, planSetColumnWidths(doc, t, [1500, 2500]));
  assert.deepEqual(sumsOf(fixed.bytes), [4000, 4000]);
  assert.deepEqual(listTables(fixed.doc).map((x) => x.regular), [true]);
});

test("H1: 병합 셀 경계가 모순인 표(3×5에서 한 셀 너비를 바꿈)도 너비 불규칙이다 — 행마다 합이 같아도 경계가 어긋난다", () => {
  const spec = fiveColumns();
  // 행 1의 (1,0)·(1,3) 너비를 6100·3900으로 바꿔 행 합은 그대로(15000) 두고, 경계 3을 0행은 6000, 1행은 6100으로 달리 말하게 한다
  spec.cells[3] = { ...(spec.cells[3] as CellSpec), width: 6100 };
  spec.cells[4] = { ...(spec.cells[4] as CellSpec), width: 3900 };
  const { doc } = singleTableDoc(spec);
  assert.deepEqual(rowWidthSums(outerTableXml(sectionText(doc.pkg.bytes))), [15000, 15000, 15000]);
  const info = infoOf(doc);
  assert.deepEqual([info?.structureRegular, info?.widthRegular], [true, false]);
  expectCode(() => planDeleteColumns(doc, target(doc), { cols: [1] }), "TABLE_IRREGULAR");
  expectCode(() => planScaleTable(doc, target(doc), { scale: 1 }), "TABLE_IRREGULAR");
  assert.equal(checkTableGeometry(info?.target.element as never).filter((i) => i.code === "TABLE_WIDTH_SUM").length, 1);
});

test("H1: 열 너비가 1 미만으로 읽히는 표(경계가 겹침)와 행 합이 다른 표는 너비 불규칙이다", () => {
  const zero: TableSpec = {
    rowCnt: 1,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 0, height: 500, text: "a" },
      { row: 0, col: 1, width: 1000, height: 500, text: "b" },
    ],
  };
  const z = infoOf(singleTableDoc(zero).doc);
  assert.deepEqual([z?.structureRegular, z?.widthRegular], [true, false]);
  const rowsDiffer: TableSpec = {
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500, text: "a" },
      { row: 0, col: 1, width: 1000, height: 500, text: "b" },
      { row: 1, col: 0, width: 1000, height: 500, text: "c" },
      { row: 1, col: 1, width: 1100, height: 500, text: "d" },
    ],
  };
  const r = infoOf(singleTableDoc(rowsDiffer).doc);
  assert.deepEqual([r?.structureRegular, r?.widthRegular], [true, false]);
});

test("H1: 표 너비(sz)와 행 합이 다른 것은 너비 불규칙이 아니다 — 비례 조정이 된다", () => {
  const { doc } = singleTableDoc({ ...fiveColumns(), width: 15200 });
  assert.equal(infoOf(doc)?.regular, true);
  const bytes = applyChecked(doc, planScaleTable(doc, target(doc), { scale: 2 })).bytes;
  assert.deepEqual(sumsOf(bytes), [30000, 30000, 30000]);
  assert.equal(tableWidth(bytes), 30000);
});

test("H1: 행 높이도 경계로 구한다 — 열마다 위에서부터 쌓은 높이가 같으면 그 차이가 행 높이이고, 어긋나면 행 안 최댓값이다", () => {
  // 열 0은 (0,0) 2행 병합 1000 + (2,0) 400, 열 1은 300 + 700 + 400. 경계 [0, 300, 1000, 1400] → [300, 700, 400]
  const spec: TableSpec = {
    rowCnt: 3,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, rowSpan: 2, width: 1000, height: 1000, text: "a" },
      { row: 0, col: 1, width: 1000, height: 300, text: "b" },
      { row: 1, col: 1, width: 1000, height: 700, text: "c" },
      { row: 2, col: 0, width: 1000, height: 400, text: "d" },
      { row: 2, col: 1, width: 1000, height: 400, text: "e" },
    ],
  };
  const { doc } = singleTableDoc(spec);
  assert.deepEqual(readTableGrid(infoOf(doc)?.target.element as never).heights, [300, 700, 400]);
  // 병합 셀로만 덮인 행의 경계: 0행 안에 rowSpan 1 셀이 없어도 열 경계로 알려진다
  const only: TableSpec = {
    rowCnt: 3,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, rowSpan: 3, width: 1000, height: 3000, text: "a" },
      { row: 0, col: 1, rowSpan: 2, width: 1000, height: 1000, text: "b" },
      { row: 2, col: 1, width: 1000, height: 2000, text: "c" },
    ],
  };
  assert.deepEqual(readTableGrid(infoOf(singleTableDoc(only).doc)?.target.element as never).heights, [500, 500, 2000]);
  // 같은 행의 셀 높이가 다르면(열마다 쌓은 경계가 어긋난다) 행 안 최댓값을 쓴다
  const uneven: TableSpec = {
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500, text: "a" },
      { row: 0, col: 1, width: 1000, height: 700, text: "b" },
      { row: 1, col: 0, width: 1000, height: 400, text: "c" },
      { row: 1, col: 1, width: 1000, height: 400, text: "d" },
    ],
  };
  const u = singleTableDoc(uneven).doc;
  assert.deepEqual(readTableGrid(infoOf(u)?.target.element as never).heights, [700, 400]);
  // 행 삽입은 높이 불규칙 표도 한다(원형 행 높이 = 행 안 최댓값 700): 표 높이 1100 → 1800
  const done = applyChecked(u, planInsertRows(u, target(u), { prototype: 0 }));
  assert.equal(/<hp:sz width="2000" widthRelTo="ABSOLUTE" height="(\d+)"/.exec(outerTableXml(sectionText(done.bytes)))?.[1], "1800");
});

test("H1: 높이가 0인 행에 걸친 병합 셀은 쪼갤 수 없다(새 셀 높이 1 미만은 TABLE_BAD_ARG)", () => {
  const spec: TableSpec = {
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, rowSpan: 2, width: 1000, height: 500, text: "a" },
      { row: 0, col: 1, width: 1000, height: 0, text: "b" },
      { row: 1, col: 1, width: 1000, height: 500, text: "c" },
    ],
  };
  const { doc } = singleTableDoc(spec);
  expectCode(() => planSplitCell(doc, target(doc), { row: 0, col: 0 }), "TABLE_BAD_ARG");
});
