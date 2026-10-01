// 2단계 크기: planSetColumnWidths·planScaleTable·planSetRowHeights (B2: 모든 행에서 셀 너비 합 = 표 너비, 병합 포함).
import assert from "node:assert/strict";
import { test } from "node:test";
import { listTables, planScaleTable, planSetColumnWidths, planSetRowHeights, scaleWidths } from "../src/index.ts";
import { loadDoc } from "./helpers.ts";
import {
  applyChecked,
  attrDiff,
  attrIn,
  gridTable,
  outerTableXml,
  readCells,
  rowWidthSums,
  sectionText,
  singleTableDoc,
  target,
  type TableSpec,
} from "./table-helpers.ts";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, `${code}가 나와야 한다`);
}

const merged: TableSpec = {
  rowCnt: 3,
  colCnt: 3,
  cells: [
    { row: 0, col: 0, colSpan: 3, width: 9000, height: 600, text: "제목" },
    { row: 1, col: 0, width: 2000, height: 600, text: "a" },
    { row: 1, col: 1, colSpan: 2, width: 7000, height: 600, text: "b" },
    { row: 2, col: 0, rowSpan: 1, width: 2000, height: 600, text: "c" },
    { row: 2, col: 1, width: 3000, height: 600, text: "d" },
    { row: 2, col: 2, width: 4000, height: 600, text: "e" },
  ],
};

test("B2: 열 너비를 지정하면 모든 셀 너비가 걸친 열의 합이 되고 표 너비는 열 합이다(병합 셀 포함)", () => {
  const { doc } = singleTableDoc(merged);
  const widths = [1000, 2500, 3500];
  const { bytes } = applyChecked(doc, planSetColumnWidths(doc, target(doc), widths));
  const tbl = outerTableXml(sectionText(bytes));
  assert.equal(attrIn(tbl, "sz", "width"), "7000");
  assert.deepEqual(rowWidthSums(tbl), [7000, 7000, 7000]);
  const w = (row: number, col: number): number | undefined => readCells(tbl).find((c) => c.row === row && c.col === col)?.width;
  assert.equal(w(0, 0), 7000, "3열을 걸친 셀");
  assert.equal(w(1, 0), 1000);
  assert.equal(w(1, 1), 6000, "열 1·2를 걸친 셀");
  assert.deepEqual([w(2, 0), w(2, 1), w(2, 2)], [1000, 2500, 3500]);
  // 높이는 그대로
  assert.equal(attrIn(tbl, "sz", "height"), attrIn(outerTableXml(sectionText(doc.pkg.bytes)), "sz", "height"));
  assert.deepEqual(readCells(tbl).map((c) => c.height), readCells(outerTableXml(sectionText(doc.pkg.bytes))).map((c) => c.height));
});

test("B1: 열 너비 변경은 너비 속성만 바꾼다", () => {
  const { doc } = singleTableDoc(gridTable([2000, 3000], 2, [], {}, 700));
  const plan = planSetColumnWidths(doc, target(doc), [2500, 2500]);
  const { bytes } = applyChecked(doc, plan);
  const { structural, diffs } = attrDiff(sectionText(doc.pkg.bytes), sectionText(bytes));
  assert.equal(structural, false);
  assert.ok(diffs.every((d) => d.includes("@width:")), diffs.join("\n"));
  assert.equal(diffs.length, 4, "셀 4개(합이 그대로라 표 너비는 바뀌지 않는다)");
  // 이미 같은 너비면 편집이 없다
  assert.equal(planSetColumnWidths(doc, target(doc), [2000, 3000]).edits.length, 0);
});

test("표 너비가 열 합과 달랐던(불변식이 깨진) 표도 열 너비를 정하면 맞는다", () => {
  const { doc } = singleTableDoc({ ...gridTable([2000, 3000], 2), width: 5100 });
  assert.deepEqual(rowWidthSums(outerTableXml(sectionText(doc.pkg.bytes))), [5000, 5000]);
  const { bytes } = applyChecked(doc, planSetColumnWidths(doc, target(doc), [2000, 3000]));
  assert.equal(attrIn(outerTableXml(sectionText(bytes)), "sz", "width"), "5000");
});

test("비례 조정의 반올림 나머지는 마지막 열이 흡수해 합이 정확히 맞는다", () => {
  assert.deepEqual(scaleWidths([1000, 1000, 1000], 100), [33, 33, 34]);
  assert.deepEqual(scaleWidths([3333, 3333, 3334], 1000), [333, 333, 334]);
  assert.deepEqual(scaleWidths([1, 1, 1], 3), [1, 1, 1]);
  assert.deepEqual(scaleWidths([5000, 5000], 12345), [6173, 6172]);
  for (const total of [7, 99, 1000, 10001, 48000]) {
    const out = scaleWidths([1234, 2345, 3456, 4567], total);
    assert.equal(out.reduce((a, b) => a + b, 0), total);
  }
});

test("planScaleTable: 비율이나 목표 너비로 표를 줄이고 늘린다. 합은 정확히 목표와 같다", () => {
  const { doc } = singleTableDoc(merged);
  const t = target(doc);
  const cases: [Parameters<typeof planScaleTable>[2], number][] = [
    [{ scale: 0.5 }, 4500],
    [{ scale: 2 }, 18000],
    [{ scale: 0.333 }, Math.round(9000 * 0.333)],
    [{ width: 12345 }, 12345],
    [{ width: 3 }, 3],
  ];
  for (const [spec, total] of cases) {
    const { bytes } = applyChecked(doc, planScaleTable(doc, t, spec));
    const tbl = outerTableXml(sectionText(bytes));
    assert.equal(attrIn(tbl, "sz", "width"), String(total), JSON.stringify(spec));
    assert.ok(rowWidthSums(tbl).every((s) => s === total), `${JSON.stringify(spec)}: ${rowWidthSums(tbl).join(",")}`);
  }
  // 비례: [2000,3000,4000] → 너비 900이면 [200,300,400]
  const { doc: d2 } = singleTableDoc(gridTable([2000, 3000, 4000], 1));
  const { bytes } = applyChecked(d2, planScaleTable(d2, target(d2), { width: 900 }));
  assert.deepEqual(readCells(outerTableXml(sectionText(bytes))).map((c) => c.width), [200, 300, 400]);
});

test("행 높이: 그 행의 rowSpan 1 셀과 걸친 병합 셀만 바뀌고 표 높이는 행 합의 변화량만큼 바뀐다", () => {
  const spec: TableSpec = {
    rowCnt: 3,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, rowSpan: 2, width: 3000, height: 1200, text: "병합" },
      { row: 0, col: 1, width: 3000, height: 600, text: "a" },
      { row: 1, col: 1, width: 3000, height: 600, text: "b" },
      { row: 2, col: 0, width: 3000, height: 700, text: "c" },
      { row: 2, col: 1, width: 3000, height: 700, text: "d" },
    ],
    height: 1900,
  };
  const { doc } = singleTableDoc(spec);
  // 원본은 표 높이 = 행 합(600 + 600 + 700 = 1900)
  const { bytes } = applyChecked(doc, planSetRowHeights(doc, target(doc), [{ row: 1, height: 1000 }]));
  const tbl = outerTableXml(sectionText(bytes));
  const cells = readCells(tbl);
  const h = (row: number, col: number): number | undefined => cells.find((c) => c.row === row && c.col === col)?.height;
  assert.equal(h(1, 1), 1000);
  assert.equal(h(0, 0), 1600, "행 0(600)과 행 1(1000)을 걸친 병합 셀");
  assert.equal(h(0, 1), 600, "다른 행의 셀은 그대로");
  assert.equal(h(2, 0), 700);
  assert.equal(attrIn(tbl, "sz", "height"), "2300", "원본이 표 높이 = 행 합이었으니 새 행 합(600+1000+700)이다");

  // 표 높이가 행 합보다 컸던 표(내용이 늘려 그린 표): 그 차이가 유지된다
  const { doc: d2 } = singleTableDoc({ ...spec, height: 2500 });
  const out2 = applyChecked(d2, planSetRowHeights(d2, target(d2), [{ row: 2, height: 100 }])).bytes;
  assert.equal(attrIn(outerTableXml(sectionText(out2)), "sz", "height"), String(2500 + (100 - 700)));

  // 여러 행과 0 높이
  const out3 = applyChecked(doc, planSetRowHeights(doc, target(doc), [{ row: 0, height: 0 }, { row: 2, height: 5 }])).bytes;
  const tbl3 = outerTableXml(sectionText(out3));
  assert.equal(readCells(tbl3).find((c) => c.row === 0 && c.col === 1)?.height, 0);
  assert.equal(readCells(tbl3).find((c) => c.row === 0 && c.col === 0)?.height, 600, "병합 셀: 행 0(0) + 행 1(600)");
  assert.equal(attrIn(tbl3, "sz", "height"), String(0 + 600 + 5));
});

test("행 높이 변경은 너비 속성을 건드리지 않고(B1) 같은 값이면 편집이 없다", () => {
  const { doc } = singleTableDoc(gridTable([2000, 3000], 2, [], {}, 700));
  const plan = planSetRowHeights(doc, target(doc), [{ row: 0, height: 900 }]);
  const { bytes } = applyChecked(doc, plan);
  const { structural, diffs } = attrDiff(sectionText(doc.pkg.bytes), sectionText(bytes));
  assert.equal(structural, false);
  assert.ok(diffs.every((d) => d.includes("@height:")), diffs.join("\n"));
  assert.equal(diffs.length, 2 + 1, "행 0의 셀 둘과 표 높이");
  assert.equal(planSetRowHeights(doc, target(doc), [{ row: 1, height: 700 }]).edits.length, 0);
});

test("거절 TABLE_RELATIVE_SIZE: 쓰는 방향의 크기 기준이 절대값이 아니면 그 방향 연산만 거절한다", () => {
  const rel = singleTableDoc({ ...gridTable([2000, 3000], 2), widthRelTo: "PAPER" });
  expectCode(() => planSetColumnWidths(rel.doc, target(rel.doc), [1, 1]), "TABLE_RELATIVE_SIZE");
  expectCode(() => planScaleTable(rel.doc, target(rel.doc), { scale: 2 }), "TABLE_RELATIVE_SIZE");
  // 높이 연산은 된다
  assert.ok(planSetRowHeights(rel.doc, target(rel.doc), [{ row: 0, height: 10 }]).edits.length > 0);
  const relH = singleTableDoc({ ...gridTable([2000, 3000], 2), heightRelTo: "PERCENT" });
  expectCode(() => planSetRowHeights(relH.doc, target(relH.doc), [{ row: 0, height: 10 }]), "TABLE_RELATIVE_SIZE");
  assert.ok(planSetColumnWidths(relH.doc, target(relH.doc), [10, 10]).edits.length > 0);
});

test("거절 TABLE_IRREGULAR: 셀이 불완전하거나 열 너비가 모순되는 표", () => {
  const doc = loadDoc("D4");
  const broken = listTables(doc).find((t) => !t.regular);
  assert.ok(broken !== undefined);
  expectCode(() => planSetColumnWidths(doc, broken.target, [1]), "TABLE_IRREGULAR");
  expectCode(() => planScaleTable(doc, broken.target, { scale: 2 }), "TABLE_IRREGULAR");
  expectCode(() => planSetRowHeights(doc, broken.target, [{ row: 0, height: 1 }]), "TABLE_IRREGULAR");

  const conflict: TableSpec = {
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500 },
      { row: 0, col: 1, width: 1000, height: 500 },
      { row: 1, col: 0, width: 1200, height: 500 },
      { row: 1, col: 1, width: 1000, height: 500 },
    ],
  };
  const c = singleTableDoc(conflict);
  // 새 너비를 주는 열 너비 지정은 열 너비가 모순인 표(행끼리 열 경계가 어긋남)도 한다 — 결과는 모든 셀이 새 열 너비의 합이다. 지금 너비가 필요한 비례 조정은 거절한다
  assert.ok(planSetColumnWidths(c.doc, target(c.doc), [1, 1]).edits.length > 0);
  expectCode(() => planScaleTable(c.doc, target(c.doc), { scale: 2 }), "TABLE_IRREGULAR");
  // 행 높이는 열 너비를 쓰지 않으므로 된다
  assert.ok(planSetRowHeights(c.doc, target(c.doc), [{ row: 0, height: 10 }]).edits.length > 0);
});

test("거절 TABLE_BAD_ARG: 열 수가 다르거나 값이 올바르지 않은 인자", () => {
  const { doc } = singleTableDoc(gridTable([2000, 3000], 2));
  const t = target(doc);
  const bad = (fn: () => unknown): void => expectCode(fn, "TABLE_BAD_ARG");
  bad(() => planSetColumnWidths(doc, t, [1000]));
  bad(() => planSetColumnWidths(doc, t, [1000, 2000, 3000]));
  bad(() => planSetColumnWidths(doc, t, [0, 1000]));
  bad(() => planSetColumnWidths(doc, t, [1000, 1.5]));
  bad(() => planSetColumnWidths(doc, t, [1000, -2]));
  bad(() => planSetColumnWidths(doc, t, [2147483647, 2147483647]));
  bad(() => planScaleTable(doc, t, { scale: 0 }));
  bad(() => planScaleTable(doc, t, { scale: -1 }));
  bad(() => planScaleTable(doc, t, { scale: Number.NaN }));
  bad(() => planScaleTable(doc, t, { width: 1 }));
  bad(() => planScaleTable(doc, t, { width: 100.5 }));
  bad(() => planScaleTable(doc, t, { scale: 0.00001 }));
  bad(() => planSetRowHeights(doc, t, []));
  bad(() => planSetRowHeights(doc, t, [{ row: 2, height: 10 }]));
  bad(() => planSetRowHeights(doc, t, [{ row: -1, height: 10 }]));
  bad(() => planSetRowHeights(doc, t, [{ row: 0, height: -1 }]));
  bad(() => planSetRowHeights(doc, t, [{ row: 0, height: 1 }, { row: 0, height: 2 }]));
});

test("B2: 실제 시험 문서의 규칙적인 최상위 표 전부에서 비례 조정·열 너비 지정 뒤 행별 너비 합이 표 너비와 같다", () => {
  let checked = 0;
  for (const name of ["D1", "D2", "D3", "D5", "D6", "D7", "hancom-merged", "hancom/blocks", "hancom/ph-table", "extra/features-picture", "extra/features-rhwp"]) {
    const doc = loadDoc(name);
    for (const info of listTables(doc)) {
      if (!info.regular || info.depth > 0) continue;
      for (const spec of [{ scale: 0.8 }, { scale: 1.37 }, { width: 30001 }] as const) {
        const { bytes } = applyChecked(doc, planScaleTable(doc, info.target, spec));
        const tbl = outerTableXml(sectionText(bytes), info.topOrdinal ?? 0);
        const width = Number(attrIn(tbl, "sz", "width"));
        assert.ok(rowWidthSums(tbl).every((s) => s === width), `${name} #${info.ordinal} ${JSON.stringify(spec)}`);
        checked++;
      }
      // 열 하나를 늘린 열 너비 지정
      const widthsBefore = doc.sections[0] === undefined ? [] : readCells(outerTableXml(sectionText(doc.pkg.bytes), info.topOrdinal ?? 0)).filter((c) => c.row === 0 && c.colSpan === 1).map((c) => c.width);
      if (widthsBefore.length === info.colCnt) {
        const widths = widthsBefore.map((w, i) => w + (i === 0 ? 100 : 0));
        const { bytes } = applyChecked(doc, planSetColumnWidths(doc, info.target, widths));
        const tbl = outerTableXml(sectionText(bytes), info.topOrdinal ?? 0);
        assert.ok(rowWidthSums(tbl).every((s) => s === widths.reduce((a, b) => a + b, 0)), `${name} #${info.ordinal} 열 지정`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 40, `검사한 조합 ${checked}개`);
});
