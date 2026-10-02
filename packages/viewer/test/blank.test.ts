// 빈 곳 눌림(R2): 점을 담은 칸·글상자의 문단을 낸다. 점이 칸 안이면 줄 후보는 그 칸에 속한 런뿐이고, 칸 밖이면 본문 런뿐이다.
// 칸 사각형은 rhwp의 쪽 컨트롤 배치(`getPageControlLayout`)에서 읽고, 눌린 문단이 어느 칸인지는 엔진 주소를 rhwp 위치로 되돌려(`toRhwpPosition`)
// 칸 색인과 맞대어 본다 — 구현이 런의 `cellPath`로 정하는 소속과 다른 경로다.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { isTableNode } from "../../hwpx-engine/src/index.ts";
import { paragraphAtAddress, toRhwpPosition, type EngineAddress } from "../src/map/index.ts";
import { openDocument, type ViewerDocument } from "../src/rhwp/index.ts";
import { clickAt, type ClickResult } from "../tools/verify.ts";
import { P, R, RECT, SUBLIST, SUBP, T, TBL, ensureRhwp, parse, readFixture, synth } from "./helpers.ts";

before(ensureRhwp);

type Box = { x: number; y: number; w: number; h: number };
type CellBox = { parentPara: number; controlIdx: number; cellIdx: number; rect: Box };

/** 쪽 컨트롤 배치의 최상위 표 칸 사각형(칸마다 하나). */
function tableCells(rdoc: ViewerDocument, page: number): CellBox[] {
  const out: CellBox[] = [];
  const layout = JSON.parse(rdoc.native.getPageControlLayout(page)) as { controls: { type: string; paraIdx: number; controlIdx: number; cells?: { cellIdx: number; x: number; y: number; w: number; h: number }[]; stableIndex: number[] }[] };
  for (const c of layout.controls) {
    // 최상위 표만(중첩 표의 식별은 이 쪽 배치만으로는 정할 수 없다)
    if (c.type !== "table" || c.cells === undefined || c.stableIndex.length !== 3) continue;
    for (const cell of c.cells) out.push({ parentPara: c.paraIdx, controlIdx: c.controlIdx, cellIdx: cell.cellIdx, rect: { x: cell.x, y: cell.y, w: cell.w, h: cell.h } });
  }
  return out;
}

/** 칸 사각형 안쪽 2픽셀 지점들: 왼쪽·오른쪽·윗·아랫 가장자리 가운데와 한가운데. */
function insets(r: Box): { name: string; x: number; y: number }[] {
  return [
    { name: "왼쪽", x: r.x + 2, y: r.y + r.h / 2 },
    { name: "오른쪽", x: r.x + r.w - 2, y: r.y + r.h / 2 },
    { name: "윗 여백", x: r.x + r.w / 2, y: r.y + 2 },
    { name: "아랫 여백", x: r.x + r.w / 2, y: r.y + r.h - 2 },
    { name: "한가운데", x: r.x + r.w / 2, y: r.y + r.h / 2 },
  ];
}

/** 눌러서 나온 주소가 가리키는 칸(엔진 주소 → rhwp 위치): 부모 문단과 맨 바깥 칸 색인. */
function cellOf(doc: ReturnType<typeof parse>, r: ClickResult): { parentPara: number; steps: [number, number, number][] } | undefined {
  if (r.address === undefined) return undefined;
  const pos = toRhwpPosition(doc, r.address);
  if (pos?.cellPath === undefined || pos.parentParaIndex === undefined) return undefined;
  return { parentPara: pos.parentParaIndex, steps: pos.cellPath.map((s) => [s.controlIndex, s.cellIndex, s.cellParaIndex]) };
}

/** 표의 모든 칸 안쪽 점을 눌러, 칸 글자·빈 곳 어느 쪽이든 그 칸의 문단이 나오는지(다른 칸·본문 문단이 아닌지) 본다. */
function expectCellsOwnTheirBlanks(rdoc: ViewerDocument, doc: ReturnType<typeof parse>, page: number, label: string): number {
  let checked = 0;
  for (const cell of tableCells(rdoc, page)) {
    for (const p of insets(cell.rect)) {
      const r = clickAt(rdoc, doc, page, p.x, p.y);
      const where = `${label} 칸 ${cell.cellIdx} ${p.name} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
      assert.ok(r.precision === "paragraph" || r.precision === "char", `${where}: ${r.precision} ${r.reason}`);
      const got = cellOf(doc, r);
      assert.deepEqual(got && [got.parentPara, got.steps.length, got.steps[0]?.[0], got.steps[0]?.[1]], [cell.parentPara, 1, cell.controlIdx, cell.cellIdx], `${where}: 다른 칸의 문단이다 ${JSON.stringify(r.address)}`);
      checked++;
    }
  }
  return checked;
}

test("R2: D2 둘째 쪽 표(문단 17) 0행 2열 칸의 왼쪽 안쪽 2px 지점은 다른 칸(0열)이 아니라 그 칸의 문단이다", () => {
  const bytes = readFixture("D2");
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    // 사실: rhwp의 hitTest는 이 점에서 0열 칸을 가리킨다 — 이 시험이 막는 결함의 근거
    const raw = rdoc.hit(1, 292.1, 143.3);
    assert.equal(raw.position?.cellPath?.[0]?.cellIndex, 0);
    const r = clickAt(rdoc, doc, 1, 292.1, 143.3);
    assert.deepEqual([r.precision, r.reason], ["paragraph", "NEAREST_LINE"]);
    assert.deepEqual(r.address?.path, [17, 2, 0], "2열 칸(칸 색인 2)의 문단");
    // 표의 모든 칸(빈 칸 포함: 좁은 칸의 빈 글 런이 이웃 칸보다 넓게 그려진다)의 안쪽 점
    assert.ok(expectCellsOwnTheirBlanks(rdoc, doc, 1, "D2") >= 35);
  } finally {
    rdoc.free();
  }
});

test("R2: 병합 칸이 있는 표의 모든 칸 안쪽 점은 그 칸(병합 칸 포함)의 문단이다", () => {
  const bytes = readFixture("tables/tables-merged");
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    assert.ok(expectCellsOwnTheirBlanks(rdoc, doc, 0, "병합") >= 40);
    // 병합 칸(행·열을 합친 칸)이 실제로 있다
    const layout = JSON.parse(rdoc.native.getPageControlLayout(0)) as { controls: { cells?: { rowSpan: number; colSpan: number }[] }[] };
    assert.ok(layout.controls.some((c) => c.cells?.some((x) => x.rowSpan > 1 || x.colSpan > 1)));
  } finally {
    rdoc.free();
  }
});

test("R2: 표 칸 안 윗/아랫 여백·왼쪽·줄 끝 오른쪽 — 칸 글이 세로 가운데 맞춤이고 이웃 칸 글이 그 높이를 담아도 그 칸의 문단이다", () => {
  const bytes = synth([P(R(TBL([[SUBP("가"), SUBP("나다라마바사아자차카타파하")]], "0")))]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const a = rdoc.pageLayout(0).runs.find((r) => r.text === "가");
    const b = rdoc.pageLayout(0).runs.find((r) => r.text.startsWith("나다"));
    assert.ok(a !== undefined && b !== undefined);
    const cells = tableCells(rdoc, 0);
    const cellA = cells.find((c) => c.cellIdx === 0);
    assert.ok(cellA !== undefined);
    // 사실: 둘째 칸 첫 줄이 첫 칸 글보다 위에 있어, 첫 칸 윗 여백의 높이를 둘째 칸 런이 담는다
    assert.ok(b.y + b.h > a.y - 4 && b.y < a.y);
    const points = [
      { name: "윗 여백(이웃 칸 글 높이)", x: cellA.rect.x + cellA.rect.w - 20, y: b.y + b.h / 2 },
      { name: "아랫 여백", x: cellA.rect.x + cellA.rect.w / 2, y: cellA.rect.y + cellA.rect.h - 2 },
      { name: "칸 왼쪽(글 시작 앞)", x: cellA.rect.x + 0.8, y: a.y + a.h / 2 },
      { name: "줄 끝 오른쪽", x: a.x + a.w + 20, y: a.y + a.h / 2 },
      { name: "칸 오른쪽 끝(경계 가까이)", x: cellA.rect.x + cellA.rect.w - 2, y: a.y + a.h / 2 },
    ];
    for (const p of points) {
      const r = clickAt(rdoc, doc, 0, p.x, p.y);
      assert.deepEqual([r.precision, r.reason], ["paragraph", "NEAREST_LINE"], `${p.name}: ${JSON.stringify([r.precision, r.reason])}`);
      assert.equal(paragraphAtAddress(doc, r.address as EngineAddress)?.logicalText, "가", `${p.name}: 첫 칸의 문단이 아니다`);
    }
    // 둘째 칸의 같은 자리들
    const cellB = cells.find((c) => c.cellIdx === 1);
    assert.ok(cellB !== undefined);
    for (const p of insets(cellB.rect)) {
      const r = clickAt(rdoc, doc, 0, p.x, p.y);
      assert.notEqual(r.precision, "none", `둘째 칸 ${p.name}`);
      assert.ok(paragraphAtAddress(doc, r.address as EngineAddress)?.logicalText.startsWith("나다") || paragraphAtAddress(doc, r.address as EngineAddress)?.logicalText.startsWith("자차"), `둘째 칸 ${p.name}`);
    }
  } finally {
    rdoc.free();
  }
});

test("R2: 중첩 표 — 안쪽 표 칸의 빈 곳은 안쪽 칸의 문단이고, 바깥 칸에서 안쪽 표 밖의 빈 곳은 바깥 칸의 문단이다", () => {
  const inner = TBL([[SUBP("나1"), SUBP("나2")]], "0");
  const bytes = synth([P(R(TBL([[SUBP("가"), SUBP("") + P(R(inner))]], "0")))]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    // 안쪽 표의 칸 사각형은 쪽 컨트롤 배치의 표 항목(문단 번호가 칸 안 문단 번호로 나온다)에서 읽는다
    const layout = JSON.parse(rdoc.native.getPageControlLayout(0)) as { controls: { type: string; cells?: { cellIdx: number; x: number; y: number; w: number; h: number }[]; stableIndex: number[] }[] };
    const tables = layout.controls.filter((c) => c.type === "table" && c.cells !== undefined);
    assert.equal(tables.length, 2);
    const outer = tables.find((t) => t.stableIndex.length === 3);
    const nested = tables.find((t) => t !== outer);
    assert.ok(outer?.cells !== undefined && nested?.cells !== undefined);
    for (const cell of nested.cells) {
      for (const p of insets(cell)) {
        const r = clickAt(rdoc, doc, 0, p.x, p.y);
        assert.ok(r.precision !== "none", `안쪽 칸 ${cell.cellIdx} ${p.name}: ${r.reason}`);
        const got = cellOf(doc, r);
        assert.deepEqual(got?.steps.map((s) => [s[0], s[1]]), [[0, 1], [0, cell.cellIdx]], `안쪽 칸 ${cell.cellIdx} ${p.name}: ${JSON.stringify(got)}`);
      }
    }
    // 바깥 둘째 칸에서 안쪽 표 밖(안쪽 표 왼쪽 가장자리 바로 바깥)
    const cell1 = outer.cells.find((c) => c.cellIdx === 1);
    assert.ok(cell1 !== undefined);
    const firstNested = nested.cells[0];
    assert.ok(firstNested !== undefined);
    const outside = clickAt(rdoc, doc, 0, cell1.x + 0.8, firstNested.y + firstNested.h / 2);
    assert.notEqual(outside.precision, "none");
    assert.deepEqual(cellOf(doc, outside)?.steps.map((s) => [s[0], s[1]]), [[0, 1]], "바깥 칸 1의 문단(안쪽 표의 문단이 아니다)");
    // 바깥 첫 칸
    const cell0 = outer.cells.find((c) => c.cellIdx === 0);
    assert.ok(cell0 !== undefined);
    for (const p of insets(cell0)) {
      const r = clickAt(rdoc, doc, 0, p.x, p.y);
      assert.deepEqual(cellOf(doc, r)?.steps.map((s) => [s[0], s[1]]), [[0, 0]], `바깥 첫 칸 ${p.name}`);
    }
  } finally {
    rdoc.free();
  }
});

test("R2: 글상자 안 빈 곳은 글상자의 문단이고, 글상자 밖 같은 높이의 빈 곳은 본문 문단이다", () => {
  const bytes = synth([P(R(T("앞") + RECT(SUBLIST(SUBP("박스 글")), "1") + T("뒤")))]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const layout = JSON.parse(rdoc.native.getPageControlLayout(0)) as { controls: { type: string; x: number; y: number; w: number; h: number }[] };
    const box = layout.controls.find((c) => c.type === "shape");
    assert.ok(box !== undefined);
    const text = rdoc.pageLayout(0).runs.find((r) => r.text === "박스 글");
    assert.ok(text !== undefined);
    for (const p of insets(box)) {
      const r = clickAt(rdoc, doc, 0, p.x, p.y);
      assert.ok(r.precision !== "none", `글상자 ${p.name}: ${r.reason}`);
      assert.equal(paragraphAtAddress(doc, r.address as EngineAddress)?.logicalText, "박스 글", `글상자 ${p.name}`);
      assert.deepEqual(r.trail, ["rect"]);
    }
    // 글상자 오른쪽 바깥 같은 높이: 본문 문단(`앞…뒤`)
    const after = rdoc.pageLayout(0).runs.find((r) => r.text === "뒤");
    assert.ok(after !== undefined);
    const outside = clickAt(rdoc, doc, 0, after.x + after.w + 20, after.y + after.h / 2);
    assert.equal(outside.precision, "paragraph");
    assert.deepEqual(outside.address?.path, [1]);
  } finally {
    rdoc.free();
  }
});

test("R2 회귀: 칸 밖 본문 여백은 칸의 문단이 아니다(본문 문단이거나 옮기지 않는다)", () => {
  const bytes = readFixture("tables/tables-merged");
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const cells = tableCells(rdoc, 0);
    const table = cells.map((c) => c.rect);
    const left = Math.min(...table.map((r) => r.x));
    const right = Math.max(...table.map((r) => r.x + r.w));
    const top = Math.min(...table.map((r) => r.y));
    const bottom = Math.max(...table.map((r) => r.y + r.h));
    const info = rdoc.pageInfo(0);
    for (const p of [
      { name: "표 왼쪽 바깥", x: Math.max(2, left - 20), y: (top + bottom) / 2 },
      { name: "표 오른쪽 바깥", x: Math.min(info.width - 2, right + 20), y: (top + bottom) / 2 },
      { name: "표 위 바깥", x: (left + right) / 2, y: top - 8 },
      { name: "표 아래 바깥", x: (left + right) / 2, y: bottom + 8 },
    ]) {
      const r = clickAt(rdoc, doc, 0, p.x, p.y);
      assert.notEqual(r.precision, "char", p.name);
      if (r.precision === "paragraph") assert.equal(r.address?.path.length, 1, `${p.name}: 칸 안 문단이 나왔다 ${JSON.stringify(r.address)}`);
    }
  } finally {
    rdoc.free();
  }
});

// ── 리뷰 15: 칸은 렌더 트리의 표 경로(행·열)로 식별하고, 서버가 엔진 표·행·열로 문단을 찾는다 ──────────────

type GridCell = { row: number; col: number; rect: Box };
type GridTable = { stable: number; cells: GridCell[] };

/** 쪽 컨트롤 배치의 표들(안쪽 표 포함)과 칸의 행·열·사각형. 눌린 점의 기대는 이 기하와 엔진 모델의 행·열로만 만든다. */
function gridTables(rdoc: ViewerDocument, page: number): GridTable[] {
  const layout = JSON.parse(rdoc.native.getPageControlLayout(page)) as { controls: { type: string; stableIndex: number[]; cells?: { row: number; col: number; x: number; y: number; w: number; h: number }[] }[] };
  return layout.controls
    .filter((c) => c.type === "table" && c.cells !== undefined)
    .map((c) => ({ stable: c.stableIndex.length, cells: (c.cells ?? []).map((x) => ({ row: x.row, col: x.col, rect: { x: x.x, y: x.y, w: x.w, h: x.h } })) }));
}

/** 엔진 모델에서 (문단, 행, 열) 단계들을 따라 내려가 칸 안 첫 문단의 주소. 바깥 단계의 `paragraph`는 구역 문단, 안쪽 단계의 것은 바깥 칸 안 문단 번호다. */
function engineCellPath(doc: ReturnType<typeof parse>, steps: { paragraph: number; row: number; col: number }[]): number[] {
  const path: number[] = [];
  let list = doc.sections[0]?.paragraphs ?? [];
  for (const step of steps) {
    const owner = list[step.paragraph];
    const table = owner?.objects.find(isTableNode);
    const cell = table?.cells.find((c) => c.row === step.row && c.col === step.col);
    assert.ok(owner !== undefined && cell?.subList != null, `엔진에 칸이 없다 ${JSON.stringify(step)}`);
    path.push(step.paragraph, owner.subLists.indexOf(cell.subList));
    list = cell.subList.paragraphs;
  }
  return [...path, 0];
}

const EMPTY_PARA = `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"/></hp:p>`;

/** 표의 모든 칸 안쪽 점을 눌러, 칸마다 그 칸의 첫 문단(`paragraph`, `NEAREST_LINE`)이 나오는지 본다. */
function expectEmptyCellsOwnTheirBlanks(rdoc: ViewerDocument, doc: ReturnType<typeof parse>, page: number, owner: number, label: string): number {
  let checked = 0;
  const table = gridTables(rdoc, page).find((t) => t.stable === 3);
  assert.ok(table !== undefined, `${label}: 쪽 ${page}에 최상위 표가 없다`);
  for (const cell of table.cells) {
    const expected = engineCellPath(doc, [{ paragraph: owner, row: cell.row, col: cell.col }]);
    for (const p of insets(cell.rect)) {
      const r = clickAt(rdoc, doc, page, p.x, p.y);
      const where = `${label} 쪽 ${page} (${cell.row}, ${cell.col}) ${p.name}`;
      assert.deepEqual([r.precision, r.reason, r.address?.path], ["paragraph", "NEAREST_LINE", expected], where);
      assert.deepEqual(r.trail, ["tbl"], where);
      checked++;
    }
  }
  return checked;
}

for (const [label, emptyCell] of [["빈 글 런", SUBP("")], ["런이 없는 문단", EMPTY_PARA]] as const) {
  test(`리뷰 15: 글이 없는 표(${label}) — 모든 칸의 안쪽 점은 그 칸(행·열)의 첫 문단이다`, () => {
    const bytes = synth([P(R(TBL([[emptyCell, emptyCell, emptyCell], [emptyCell, emptyCell, emptyCell], [emptyCell, emptyCell, emptyCell]], "0")))]);
    const doc = parse(bytes);
    const rdoc = openDocument(bytes);
    try {
      assert.equal(rdoc.pageLayout(0).runs.filter((r) => r.text !== "" && r.cellPath !== undefined).length, 0, "글 있는 칸 런이 없어야 이 시험이 의미가 있다");
      assert.equal(expectEmptyCellsOwnTheirBlanks(rdoc, doc, 0, 1, label), 45);
    } finally {
      rdoc.free();
    }
  });
}

/** `TBL`이 만든 표의 문자열에서 칸을 합친다(합쳐 없어지는 칸은 지운다): `merges`의 항목 [행, 열, 행 병합, 열 병합]. */
function merged(xml: string, merges: [number, number, number, number][]): string {
  let out = xml;
  for (const [row, col, rowSpan, colSpan] of merges) {
    // 합쳐지는 칸(왼쪽 위 칸 말고 영역 안의 칸)을 지운다
    for (let r = row; r < row + rowSpan; r++) {
      for (let c = col; c < col + colSpan; c++) {
        if (r === row && c === col) continue;
        out = out.replace(new RegExp(`<hp:tc [^>]*>(?:(?!</hp:tc>).)*<hp:cellAddr colAddr="${c}" rowAddr="${r}"/>.*?</hp:tc>`), "");
      }
    }
    out = out.replace(new RegExp(`(<hp:cellAddr colAddr="${col}" rowAddr="${row}"/>)<hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="8000" height="1000"/>`), `$1<hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/><hp:cellSz width="${8000 * colSpan}" height="${1000 * rowSpan}"/>`);
  }
  return out;
}

test("리뷰 15: 글이 없는 표의 병합 칸 — 합친 칸 어디를 눌러도 합친 칸(왼쪽 위 칸의 행·열)의 첫 문단이다", () => {
  const rows = Array.from({ length: 4 }, () => [SUBP(""), SUBP(""), SUBP("")]);
  // 0행 전체(열 3개)를 한 칸으로, 1행 0열을 아래 행까지(2행 0열을 먹는다) 합친다
  const xml = merged(TBL(rows, "0"), [[0, 0, 1, 3], [1, 0, 2, 1]]);
  const bytes = synth([P(R(xml))]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const table = gridTables(rdoc, 0).find((t) => t.stable === 3);
    assert.ok(table !== undefined);
    // 합친 칸이 실제로 쪽 배치에 있다: 0행에는 칸이 하나, 1행 0열 칸은 2행 높이다
    assert.deepEqual(table.cells.filter((c) => c.row === 0).map((c) => c.col), [0]);
    const tall = table.cells.find((c) => c.row === 1 && c.col === 0);
    const short = table.cells.find((c) => c.row === 1 && c.col === 1);
    assert.ok(tall !== undefined && short !== undefined && tall.rect.h > short.rect.h * 1.5);
    assert.ok(expectEmptyCellsOwnTheirBlanks(rdoc, doc, 0, 1, "병합") >= 5 * 4);
    // 합쳐서 먹힌 자리(2행 0열)의 점도 합친 칸(1행 0열)이다
    const y = tall.rect.y + tall.rect.h - 3;
    const r = clickAt(rdoc, doc, 0, tall.rect.x + tall.rect.w / 2, y);
    assert.deepEqual(r.address?.path, engineCellPath(doc, [{ paragraph: 1, row: 1, col: 0 }]));
  } finally {
    rdoc.free();
  }
});

test("리뷰 15: 글이 없는 중첩 표 — 안쪽 칸의 점은 안쪽 표의 칸(바깥 칸 → 안쪽 표를 담은 문단 → 안쪽 행·열)이고, 바깥 칸에서 안쪽 표 밖은 바깥 칸의 첫 문단이다", () => {
  const inner = TBL([[SUBP(""), SUBP("")], [SUBP(""), SUBP("")]], "0");
  const bytes = synth([P(R(TBL([[SUBP(""), SUBP("") + P(R(inner))]], "0")))]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const tables = gridTables(rdoc, 0);
    const outer = tables.find((t) => t.stable === 3);
    const nested = tables.find((t) => t !== outer);
    assert.ok(outer !== undefined && nested !== undefined);
    // 안쪽 표를 담은 바깥 칸: 안쪽 표 사각형을 가진 칸. 안쪽 표는 그 칸 하위 목록의 둘째 문단(첫 문단은 빈 문단)이다
    const first = nested.cells[0];
    assert.ok(first !== undefined);
    const holder = outer.cells.find((c) => first.rect.x >= c.rect.x && first.rect.x + first.rect.w <= c.rect.x + c.rect.w + 0.6 && first.rect.y >= c.rect.y);
    assert.ok(holder !== undefined);
    for (const cell of nested.cells) {
      const expected = engineCellPath(doc, [{ paragraph: 1, row: holder.row, col: holder.col }, { paragraph: 1, row: cell.row, col: cell.col }]);
      for (const p of insets(cell.rect)) {
        const r = clickAt(rdoc, doc, 0, p.x, p.y);
        assert.deepEqual([r.precision, r.reason, r.address?.path, r.trail], ["paragraph", "NEAREST_LINE", expected, ["tbl", "tbl"]], `안쪽 (${cell.row}, ${cell.col}) ${p.name}`);
      }
    }
    // 바깥 둘째 칸에서 안쪽 표 왼쪽 바로 바깥
    const outside = clickAt(rdoc, doc, 0, holder.rect.x + 0.8, first.rect.y + first.rect.h / 2);
    assert.deepEqual([outside.precision, outside.address?.path, outside.trail], ["paragraph", engineCellPath(doc, [{ paragraph: 1, row: holder.row, col: holder.col }]), ["tbl"]]);
    // 바깥 첫 칸
    const other = outer.cells.find((c) => c !== holder);
    assert.ok(other !== undefined);
    for (const p of insets(other.rect)) {
      const r = clickAt(rdoc, doc, 0, p.x, p.y);
      assert.deepEqual(r.address?.path, engineCellPath(doc, [{ paragraph: 1, row: other.row, col: other.col }]), `바깥 첫 칸 ${p.name}`);
    }
  } finally {
    rdoc.free();
  }
});

test("리뷰 15: 여러 쪽에 걸친 표 — 둘째 쪽(이어지는 행)의 칸도 그 행·열의 문단이다(글이 없는 표)", () => {
  const rows = Array.from({ length: 120 }, () => [SUBP(""), SUBP("")]);
  const bytes = synth([P(R(TBL(rows, "0")))]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    assert.ok(rdoc.pageCount() >= 2, `쪽 수 ${rdoc.pageCount()}`);
    // 둘째 쪽 표의 행은 0이 아닌 행부터 이어진다
    const second = gridTables(rdoc, 1).find((t) => t.stable === 3);
    assert.ok(second !== undefined && Math.min(...second.cells.map((c) => c.row)) > 0, "둘째 쪽 표가 이어지는 행으로 시작해야 한다");
    for (const page of [0, 1]) {
      const table = gridTables(rdoc, page).find((t) => t.stable === 3);
      assert.ok(table !== undefined);
      let checked = 0;
      // 쪽의 칸들 가운데 고르게 몇 개: 첫·가운데·마지막
      for (const cell of [table.cells[0], table.cells[Math.floor(table.cells.length / 2)], table.cells[table.cells.length - 1]]) {
        assert.ok(cell !== undefined);
        const expected = engineCellPath(doc, [{ paragraph: 1, row: cell.row, col: cell.col }]);
        for (const p of insets(cell.rect)) {
          const r = clickAt(rdoc, doc, page, p.x, p.y);
          assert.deepEqual([r.precision, r.reason, r.address?.path], ["paragraph", "NEAREST_LINE", expected], `쪽 ${page} (${cell.row}, ${cell.col}) ${p.name}`);
          checked++;
        }
      }
      assert.equal(checked, 15);
    }
  } finally {
    rdoc.free();
  }
});

test("리뷰 5: 표 칸의 빈 곳을 누를 때 칸마다 rhwp의 칸 정보(getCellInfoByPath)·표 경로 칸 사각형(getTableCellBboxesByPath)을 묻지 않는다", () => {
  const rows = Array.from({ length: 20 }, () => [SUBP("가"), SUBP(""), SUBP("나다")]);
  const bytes = synth([P(R(TBL(rows, "0")))]);
  const rdoc = openDocument(bytes);
  try {
    const native = rdoc.native as unknown as Record<string, (...args: unknown[]) => unknown>;
    const calls: Record<string, number> = {};
    for (const name of ["getCellInfoByPath", "getTableCellBboxesByPath"]) {
      const original = native[name];
      assert.ok(original !== undefined);
      native[name] = function (this: unknown, ...args: unknown[]): unknown {
        calls[name] = (calls[name] ?? 0) + 1;
        return original.apply(this, args);
      };
    }
    const table = gridTables(rdoc, 0).find((t) => t.stable === 3);
    assert.ok(table !== undefined);
    for (const cell of table.cells) rdoc.pick(0, cell.rect.x + cell.rect.w / 2, cell.rect.y + 2);
    assert.deepEqual(calls, {});
  } finally {
    rdoc.free();
  }
});

test("리뷰 15: 바깥 칸 아래의 빈 곳(안쪽 표가 칸 문단 하나에 들어 있다)은 그 바깥 칸의 문단이다 — 안쪽 표 칸의 문단이나 다른 칸의 문단이 아니다", () => {
  const nested = TBL([[SUBP("다")]], "0");
  // 바깥 첫 칸: 빈 첫 문단 + 안쪽 표를 담은 둘째 문단. 둘째 칸은 높아서 첫 칸 아래에 빈 곳이 생긴다
  const tall = ["가", "나", "다", "라", "마", "바", "사", "아"].map((t) => SUBP(t)).join("");
  const bytes = synth([P(R(TBL([[SUBP("") + P(R(nested)), tall]], "0")))]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const outer = gridTables(rdoc, 0).find((t) => t.stable === 3);
    const cell = outer?.cells.find((c) => c.row === 0 && c.col === 0);
    assert.ok(cell !== undefined);
    const inner = rdoc.pageLayout(0).runs.find((r) => r.text === "다" && r.cellPath?.length === 2);
    assert.ok(inner !== undefined && cell.rect.y + cell.rect.h - (inner.y + inner.h) > 6, "안쪽 표 글 아래에 바깥 칸의 빈 곳이 있어야 한다");
    const r = clickAt(rdoc, doc, 0, cell.rect.x + cell.rect.w / 2, cell.rect.y + cell.rect.h - 2);
    assert.equal(r.precision, "paragraph");
    // 바깥 칸(0행 0열)의 첫째(빈 문단) 또는 둘째(안쪽 표를 담은 문단) 문단: 길이 3의 주소
    const first = engineCellPath(doc, [{ paragraph: 1, row: 0, col: 0 }]);
    assert.deepEqual(r.address?.path.slice(0, 2), first.slice(0, 2));
    assert.equal(r.address?.path.length, 3);
    assert.ok([0, 1].includes(r.address?.path[2] ?? -1));
  } finally {
    rdoc.free();
  }
});
