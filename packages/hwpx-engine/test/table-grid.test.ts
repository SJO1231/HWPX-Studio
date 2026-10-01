// 표 격자 모델(`readTableGrid`)·열 너비·행 높이·불변식 검사(`checkTableGeometry`)·표 목록(`listTables`).
// 기대값은 명세 7.9와 표 구조에서 정했다(구현 출력에 맞추지 않았다).
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTableGeometry, listTables, readTableGrid, rowHeights } from "../src/index.ts";
import { docOf, gridTable, paragraph, reparseBytes, singleTableDoc, tableParagraph, tableXml, tablesOf, textPara, type CellSpec, type TableSpec } from "./table-helpers.ts";
import { loadDoc } from "./helpers.ts";

const grid = (spec: TableSpec) => {
  const { doc } = singleTableDoc(spec);
  return readTableGrid(tablesOf(doc)[0] as never);
};

test("규칙적인 균일 격자: 열 너비·행 높이·칸 조회", () => {
  const g = grid(gridTable([3000, 2000, 5000], 3, [["a", "b", "c"]], {}, 800));
  assert.deepEqual(g.problems, []);
  assert.equal(g.rowCnt, 3);
  assert.equal(g.colCnt, 3);
  assert.deepEqual(g.widths, [3000, 2000, 5000]);
  assert.deepEqual(rowHeights(g), [800, 800, 800]);
  assert.equal(g.at(1, 2)?.col, 2);
  assert.equal(g.at(3, 0), undefined);
});

test("병합 셀: 열 너비는 colSpan 1인 셀에서 읽고, 없는 열은 걸친 셀에서 아는 열을 뺀 나머지를 균등 분배한다(나머지는 마지막 열)", () => {
  const cells = (qWidth: number): CellSpec[] => [
    { row: 0, col: 0, colSpan: 3, width: 9000 + (qWidth - 7000), height: 500 },
    { row: 1, col: 0, width: 2000, height: 500 },
    { row: 1, col: 1, colSpan: 2, width: qWidth, height: 500 },
  ];
  assert.deepEqual(grid({ rowCnt: 2, colCnt: 3, cells: cells(7000) }).widths, [2000, 3500, 3500]);
  assert.deepEqual(grid({ rowCnt: 2, colCnt: 3, cells: cells(7001) }).widths, [2000, 3500, 3501]);
  // 아는 열이 안에 있으면 그것을 빼고 나머지를 모르는 열에 준다: Q가 열 1·2를 걸치고 열 1이 다른 행에서 1000으로 알려짐
  const mixed = grid({
    rowCnt: 3,
    colCnt: 3,
    cells: [
      { row: 0, col: 0, width: 2000, height: 500 },
      { row: 0, col: 1, width: 1000, height: 500 },
      { row: 0, col: 2, width: 6000, height: 500 },
      { row: 1, col: 0, width: 2000, height: 500 },
      { row: 1, col: 1, colSpan: 2, width: 7000, height: 500 },
      { row: 2, col: 0, colSpan: 3, width: 9000, height: 500 },
    ],
  });
  assert.deepEqual(mixed.problems, []);
  assert.deepEqual(mixed.widths, [2000, 1000, 6000]);
});

test("행 높이는 그 행에서 시작하는 rowSpan 1 셀 높이의 최댓값이고, 그런 셀이 없는 행은 병합 셀에서 아는 행을 뺀 나머지를 균등 분배한다", () => {
  const ok = grid({
    rowCnt: 3,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, rowSpan: 3, width: 1000, height: 3001 },
      { row: 0, col: 1, width: 1000, height: 500 },
      { row: 1, col: 1, width: 1000, height: 700 },
      { row: 2, col: 1, width: 1000, height: 900 },
    ],
  });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(rowHeights(ok), [500, 700, 900]);
  // 모든 행이 병합 셀로만 덮이면 병합 셀 높이를 균등 분배한다(나머지는 마지막 행)
  const only = grid({ rowCnt: 2, colCnt: 1, cells: [{ row: 0, col: 0, rowSpan: 2, width: 1000, height: 1001 }] });
  assert.deepEqual(rowHeights(only), [500, 501]);
  // 한 행 안에서 rowSpan 1 셀 높이가 다르면 가장 큰 값
  const differ = grid({
    rowCnt: 1,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 400 },
      { row: 0, col: 1, width: 1000, height: 900 },
    ],
  });
  assert.deepEqual(rowHeights(differ), [900]);
});

test("불규칙 격자의 사유: 겹침·빈 칸·행/열 수 불일치·범위 밖·누락·잘못된 tr·열 너비 모순", () => {
  const base: CellSpec[] = [
    { row: 0, col: 0, width: 1000, height: 500 },
    { row: 0, col: 1, width: 1000, height: 500 },
    { row: 1, col: 0, width: 1000, height: 500 },
    { row: 1, col: 1, width: 1000, height: 500 },
  ];
  const problems = (spec: TableSpec) => grid(spec).problems.join("|");
  assert.deepEqual(grid({ rowCnt: 2, colCnt: 2, cells: base }).problems, []);

  // 겹침: 두 셀이 같은 칸
  assert.match(problems({ rowCnt: 2, colCnt: 2, cells: [...base, { row: 1, col: 1, width: 1000, height: 500 }] }), /겹치는 칸/);
  // 빈 칸
  assert.match(problems({ rowCnt: 2, colCnt: 2, cells: base.slice(0, 3) }), /덮지 않는 칸/);
  // 행 수 선언 불일치(tr은 2개인데 rowCnt 3)
  assert.match(problems({ rowCnt: 3, colCnt: 2, cells: base }), /rowCnt\(3\)/);
  // 열 수 선언 불일치
  assert.match(problems({ rowCnt: 2, colCnt: 3, cells: base }), /colCnt\(3\)/);
  // 범위 밖: 병합이 colCnt를 넘는다
  assert.match(problems({ rowCnt: 2, colCnt: 2, cells: [{ row: 0, col: 0, colSpan: 3, width: 3000, height: 500 }, ...base.slice(2)] }), /밖으로 나가는|colCnt/);

  // 누락: cellSz가 없는 셀
  const broken = docOf([tableParagraph({ rowCnt: 2, colCnt: 2, cells: base }).replaceAll('<hp:cellSz width="1000" height="500"/>', "")]);
  assert.match(readTableGrid(tablesOf(reparseBytes(broken))[0] as never).problems.join("|"), /읽지 못한 셀 4개/);

  // 셀이 자기 행의 tr에 없다: 1행 셀을 0행 tr에 넣는다
  const swapped = tableXml({ rowCnt: 2, colCnt: 2, cells: base }).replace(/(<hp:tr>)([\s\S]*?)(<\/hp:tr>)(<hp:tr>)([\s\S]*?)(<\/hp:tr>)/, "$1$5$3$4$2$6");
  assert.match(readTableGrid(tablesOf(reparseBytes(docOf([paragraph(`${swapped}<hp:t/>`)])))[0] as never).problems.join("|"), /tr에 들어 있지 않은 셀/);

  // 열 너비 모순은 구조 문제가 아니다: problems는 비고 widths만 없다
  const conflict = grid({
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500 },
      { row: 0, col: 1, width: 1000, height: 500 },
      { row: 1, col: 0, width: 1200, height: 500 },
      { row: 1, col: 1, width: 1000, height: 500 },
    ],
  });
  assert.deepEqual(conflict.problems, []);
  assert.equal(conflict.widths, undefined);
});

test("checkTableGeometry: 정상이면 비고, 각 위반이 자기 코드로 나온다", () => {
  const ok = singleTableDoc(gridTable([2000, 3000], 2, [], {}, 600));
  assert.deepEqual(checkTableGeometry(tablesOf(ok.doc)[0] as never), []);

  const codes = (spec: TableSpec, patch?: (xml: string) => string): string[] => {
    const xml = patch === undefined ? tableXml(spec) : patch(tableXml(spec));
    const doc = reparseBytes(docOf([paragraph(`${xml}<hp:t/>`)]));
    return checkTableGeometry(tablesOf(doc)[0] as never).map((i) => i.code);
  };
  const two = gridTable([2000, 3000], 2, [], {}, 600);
  assert.ok(codes({ ...two, rowCnt: 5 }).includes("TABLE_COUNT"));
  assert.ok(codes(two, (x) => x.replace('colAddr="1" rowAddr="0"', 'colAddr="0" rowAddr="0"')).includes("TABLE_ADDR"));
  const noSize = codes(two, (x) => x.replace('<hp:cellSz width="3000" height="600"/>', ""));
  assert.ok(noSize.includes("TABLE_CELL_PARTS"));
  assert.ok(noSize.includes("TABLE_ADDR"), "cellSz가 없는 셀은 읽지 못해 그 칸이 비는 것으로 본다");
  // 표 너비가 열 합과 다르다
  assert.deepEqual(codes({ ...two, width: 5001 }), ["TABLE_WIDTH_SUM"]);
  // 병합 셀 너비가 걸친 열의 합과 다르다
  const merged: TableSpec = {
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, colSpan: 2, width: 4000, height: 500 },
      { row: 1, col: 0, width: 2000, height: 500 },
      { row: 1, col: 1, width: 3000, height: 500 },
    ],
    width: 5000,
  };
  assert.deepEqual(codes(merged), ["TABLE_WIDTH_SUM"]);
});

test("listTables: 문서 순서, 최상위 서수, 중첩 깊이, 문단 주소, 요약 수치", () => {
  const inner = gridTable([1000, 1000], 1, [["x", "y"]]);
  const outer: TableSpec = {
    rowCnt: 1,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 4000, height: 800, paragraphs: [textPara("앞"), paragraph(`${tableXml({ ...inner, id: "2002" })}<hp:t/>`)] },
      { row: 0, col: 1, width: 3000, height: 800, text: "옆" },
    ],
    treatAsChar: true,
    pageBreak: "NONE",
    repeatHeader: true,
  };
  const bytes = docOf([textPara("제목"), tableParagraph(outer), tableParagraph(gridTable([5000], 2, [], { id: "3003" }))]);
  const tables = listTables(reparseBytes(bytes));
  assert.deepEqual(
    tables.map((t) => [t.ordinal, t.topOrdinal, t.depth, t.paragraphPath.join(".")]),
    [
      [0, 0, 0, "1"],
      [1, undefined, 1, "1.0.1"],
      [2, 1, 0, "2"],
    ],
  );
  const first = tables[0];
  assert.ok(first !== undefined);
  assert.equal(first.rowCnt, 1);
  assert.equal(first.colCnt, 2);
  assert.equal(first.width, 7000);
  assert.equal(first.treatAsChar, true);
  assert.equal(first.pageBreak, "NONE");
  assert.equal(first.repeatHeader, true);
  assert.equal(first.regular, true);
  assert.equal(first.mergedCells, 0);
  assert.equal(tables[2]?.height, 2000);
});

test("실제 시험 문서: 한컴 저장 표와 합성 병합 표가 규칙적인 격자로 읽히고 불변식을 지킨다", () => {
  const d3 = loadDoc("D3");
  const infos = listTables(d3);
  assert.equal(infos.length, 2);
  assert.equal(infos[1]?.rowCnt, 11);
  assert.equal(infos[1]?.colCnt, 48);
  assert.ok((infos[1]?.mergedCells ?? 0) > 0);
  for (const t of infos) {
    assert.equal(t.regular, true);
    assert.deepEqual(checkTableGeometry(t.target.element), [], `표 ${t.ordinal}`);
  }
  // D4에는 셀 요소가 불완전한 표가 있다(독립 확인: 셀 하나가 cellAddr 없이 있는 표 2개)
  const d4 = listTables(loadDoc("D4"));
  assert.equal(d4.filter((t) => !t.regular).length, 2);
  for (const t of d4.filter((x) => !x.regular)) assert.ok(checkTableGeometry(t.target.element).length > 0);
});
