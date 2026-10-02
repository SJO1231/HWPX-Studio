// 빈 곳 눌림(R2): 점을 담은 칸·글상자의 문단을 낸다. 점이 칸 안이면 줄 후보는 그 칸에 속한 런뿐이고, 칸 밖이면 본문 런뿐이다.
// 칸 사각형은 rhwp의 쪽 컨트롤 배치(`getPageControlLayout`)에서 읽고, 눌린 문단이 어느 칸인지는 엔진 주소를 rhwp 위치로 되돌려(`toRhwpPosition`)
// 칸 색인과 맞대어 본다 — 구현이 런의 `cellPath`로 정하는 소속과 다른 경로다.
import assert from "node:assert/strict";
import { before, test } from "node:test";
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
