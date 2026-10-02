// 칸·글상자 사각형과 식별(rhwp/containers.ts)의 순수 판단. 쪽 렌더 트리와 쪽 컨트롤 배치를 흉내 내서 시험한다.
// 표 칸은 렌더 트리의 표 경로(표를 담은 문단 번호·컨트롤 번호·행·열)로 식별하고 rhwp의 칸 색인·표 경로 응답은 쓰지 않는다(예전 시험은 칸 색인 검증을 시험했다).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainers, containerAt, runInContainer, runsInCell, type Container } from "../src/rhwp/containers.ts";
import type { LayoutRun } from "../src/rhwp/index.ts";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const cell = (row: number, col: number, b: ReturnType<typeof box>, children: unknown[] = []) => ({ type: "Cell", row, col, bbox: b, children });
const table = (pi: number, ci: number, b: ReturnType<typeof box>, cells: unknown[]) => ({ type: "Table", pi, ci, bbox: b, children: cells });

/** 글 있는 런(왼쪽 끝이 `at`에 놓인다). `path`는 [컨트롤, 칸 색인, 칸 안 문단] 단계들 */
const textRun = (parent: number, path: [number, number, number][], at: { x: number; y: number }, text = "글"): LayoutRun => ({
  text,
  x: at.x,
  y: at.y,
  w: 5,
  h: 5,
  charX: [0, 5],
  secIdx: 0,
  paraIdx: 0,
  charStart: 0,
  parentParaIdx: parent,
  cellPath: path.map(([controlIndex, cellIndex, cellParaIndex]) => ({ controlIndex, cellIndex, cellParaIndex })),
});

const noControls = { controls: [] };

test("최상위 표: 칸마다 식별된다(표를 담은 문단 번호·컨트롤 번호·행·열). 병합으로 칸 색인이 어긋나는 표도 행·열로 식별하고, 칸 사각형을 rhwp에 묻지 않는다", () => {
  const tree = { type: "Page", children: [{ type: "Body", children: [table(17, 1, box(0, 0, 100, 20), [cell(0, 0, box(0, 0, 40, 20)), cell(0, 2, box(40, 0, 60, 20))])] }] };
  const list = buildContainers(tree, noControls);
  assert.deepEqual(
    list.map((c) => (c.kind === "cell" ? c.table : undefined)),
    [[{ paragraph: 17, control: 1, row: 0, col: 0 }], [{ paragraph: 17, control: 1, row: 0, col: 2 }]],
  );
  // 글이 하나도 없는 표(런 정보가 없어도)도 식별된다
  assert.equal(list.length, 2);
});

test("표 번호(pi·ci)나 칸 행·열이 렌더 트리에 없으면 식별하지 못한 칸이다(그 안의 점은 unknown)", () => {
  for (const tree of [
    { type: "Body", children: [{ type: "Table", bbox: box(0, 0, 100, 20), children: [cell(0, 0, box(0, 0, 100, 20))] }] },
    { type: "Body", children: [table(1, 0, box(0, 0, 100, 20), [{ type: "Cell", bbox: box(0, 0, 100, 20), children: [] }])] },
  ]) {
    const list = buildContainers(tree, noControls);
    assert.equal(list.length, 1);
    assert.deepEqual(containerAt(list, 10, 10), { kind: "unknown" });
  }
});

test("중첩 표: 안쪽 표는 바깥 칸의 단계(행·열)와 안쪽 표를 담은 칸 안 문단 번호(`pi`)를 이은 표 경로이고, 점은 가장 안쪽 칸으로 정한다", () => {
  const inner = table(1, 0, box(60, 5, 30, 10), [cell(0, 0, box(60, 5, 15, 10)), cell(0, 1, box(75, 5, 15, 10))]);
  const tree = { type: "Body", children: [table(2, 0, box(0, 0, 100, 20), [cell(0, 0, box(0, 0, 50, 20)), cell(0, 1, box(50, 0, 50, 20), [inner])])] };
  const list = buildContainers(tree, noControls);
  const hit = containerAt(list, 80, 10);
  assert.equal(hit.kind, "cell");
  assert.deepEqual(hit.kind === "cell" ? hit.table : undefined, [
    { paragraph: 2, control: 0, row: 0, col: 1 },
    { paragraph: 1, control: 0, row: 0, col: 1 },
  ]);
  // 바깥 칸(0행 1열)에서 안쪽 표 밖
  const outside = containerAt(list, 55, 18);
  assert.deepEqual(outside.kind === "cell" ? outside.table : undefined, [{ paragraph: 2, control: 0, row: 0, col: 1 }]);
  assert.deepEqual(containerAt(list, 200, 10), { kind: "none" });
});

test("머리말·꼬리말·바탕쪽·각주 영역 안의 표 칸과 글상자 안의 표는 식별하지 않는다(문서 좌표가 본문과 겹쳐 보인다)", () => {
  const t = (pi: number) => table(pi, 0, box(0, 0, 10, 10), [cell(0, 0, box(0, 0, 10, 10))]);
  for (const area of ["Header", "Footer", "MasterPage", "FootnoteArea"]) {
    const list = buildContainers({ type: "Page", children: [{ type: area, children: [t(0)] }] }, noControls);
    assert.equal(list.length, 1, area);
    assert.equal(list[0]?.kind === "cell" ? list[0].table : "다른 종류", undefined, area);
  }
  const boxed = { type: "Body", children: [{ type: "Rect", bbox: box(0, 0, 50, 50), children: [{ type: "TextBox", bbox: box(2, 2, 46, 46), children: [t(0)] }] }] };
  const list = buildContainers(boxed, { controls: { controls: [{ type: "shape", x: 0, y: 0, w: 50, h: 50, paraIdx: 1, controlIdx: 0 }] }, runs: [textRun(1, [[0, 0, 0]], { x: 5, y: 5 })] });
  assert.deepEqual(
    list.map((c) => [c.kind, c.kind === "textbox" ? c.id !== undefined : c.table !== undefined]),
    [["textbox", true], ["cell", false]],
  );
});

test("글상자: 쪽 컨트롤 배치의 shape 항목과 사각형이 맞으면 식별한다. 칸 안 글상자·맞는 항목이 없는 글상자(묶음 안)는 식별하지 않는다", () => {
  const rect = (b: ReturnType<typeof box>) => ({ type: "Rect", bbox: b, children: [{ type: "TextBox", bbox: b, children: [] }] });
  const tree = {
    type: "Body",
    children: [rect(box(10, 10, 40, 20)), { type: "Group", children: [rect(box(100, 10, 40, 20))] }, table(1, 0, box(0, 100, 100, 40), [cell(0, 0, box(0, 100, 100, 40), [rect(box(5, 105, 40, 20))])])],
  };
  const controls = {
    controls: [
      { type: "shape", x: 10, y: 10, w: 40, h: 20, paraIdx: 1, controlIdx: 0 },
      { type: "group", x: 100, y: 10, w: 40, h: 20, paraIdx: 1, controlIdx: 1 },
      { type: "shape", x: 5, y: 105, w: 40, h: 20, paraIdx: 1, controlIdx: 0, cellIdx: 0, cellParaIdx: 1, outerTableControlIdx: 0 },
    ],
  };
  const list = buildContainers(tree, { controls, runs: [textRun(1, [[0, 0, 0]], { x: 15, y: 15 })] });
  const textboxes = list.filter((c): c is Extract<Container, { kind: "textbox" }> => c.kind === "textbox");
  assert.deepEqual(
    textboxes.map((c) => c.id),
    [{ parentPara: 1, steps: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] }, undefined, undefined],
  );
  // 식별한 글상자는 containerAt이 textbox로 돌려준다
  assert.deepEqual(containerAt(list, 20, 20), { kind: "textbox", id: { parentPara: 1, steps: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] } });
});

test("containerAt: 가장 작은 사각형이 나머지 모두 안에 들어야 한다 — 서로 포개지 않고 겹친 사각형 안의 점은 unknown, 식별하지 못한 칸도 unknown", () => {
  const id = { parentPara: 1, steps: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] };
  const table0 = [{ paragraph: 1, control: 0, row: 0, col: 0 }];
  const a: Container = { rect: box(0, 0, 100, 100), kind: "cell", table: table0 };
  const b: Container = { rect: box(20, 20, 30, 30), kind: "textbox", id };
  const c: Container = { rect: box(40, 40, 60, 60), kind: "textbox", id };
  const hit = containerAt([a, b], 30, 30);
  assert.deepEqual(hit, { kind: "textbox", id });
  assert.deepEqual(containerAt([a], 30, 30), { kind: "cell", rect: a.rect, table: table0 });
  assert.deepEqual(containerAt([a, b, c], 45, 45), { kind: "unknown" }, "b와 c가 서로 포개지 않고 겹친다");
  assert.deepEqual(containerAt([a, { rect: box(10, 10, 20, 20), kind: "cell" }], 15, 15), { kind: "unknown" }, "식별하지 못한 칸");
});

test("runInContainer(글상자): 같은 부모 문단·같은 깊이·단계마다 컨트롤과 칸 색인이 같고 바깥 단계는 칸 안 문단 번호도 같아야 한다", () => {
  const run = (parent: number, steps: [number, number, number][]): LayoutRun => ({ ...textRun(parent, steps, { x: 0, y: 0 }, "x"), w: 1, h: 1, charX: [0, 1] });
  const id = {
    parentPara: 2,
    steps: [
      { controlIndex: 0, cellIndex: 1, cellParaIndex: 1 },
      { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
    ],
  };
  assert.equal(runInContainer(run(2, [[0, 1, 1], [0, 0, 5]]), id), true, "마지막 단계의 칸 안 문단 번호는 보지 않는다");
  assert.equal(runInContainer(run(2, [[0, 1, 0], [0, 0, 0]]), id), false, "바깥 단계의 칸 안 문단 번호가 다르다");
  assert.equal(runInContainer(run(3, [[0, 1, 1], [0, 0, 0]]), id), false, "부모 문단이 다르다");
  assert.equal(runInContainer(run(2, [[0, 1, 1]]), id), false, "깊이가 다르다");
  assert.equal(runInContainer(run(2, [[0, 1, 1], [0, 1, 0]]), id), false, "칸 색인이 다르다");
  const { cellPath: _gone, ...noPath } = run(2, []);
  assert.equal(runInContainer(noPath, id), false);
});

test("runsInCell: 같은 표(문단·컨트롤 번호)의 문서 좌표 런 가운데 왼쪽 끝이 칸 사각형 안에 드는 것만 — 빈 런과 칸 안 안쪽 표의 글(더 깊은 경로)도 들고, 칸 위에 떠 있는 글상자의 글·다른 표·표 캡션은 들지 않는다", () => {
  const rect = box(0, 0, 50, 20);
  const here = [{ paragraph: 7, control: 2, row: 0, col: 0 }];
  const inCell = textRun(7, [[2, 3, 0]], { x: 5, y: 5 });
  const empty = textRun(7, [[2, 3, 1]], { x: 8, y: 12 }, "");
  const spill = textRun(7, [[2, 4, 0]], { x: 60, y: 5 }); // 같은 표의 이웃 칸(사각형 밖)
  const floating = textRun(7, [[5, 0, 0]], { x: 5, y: 5 }); // 같은 문단의 다른 컨트롤(글상자) — 깊이는 같다
  const otherPara = textRun(8, [[2, 3, 0]], { x: 5, y: 5 });
  const deeper = textRun(7, [[2, 3, 0], [0, 0, 0]], { x: 5, y: 5 }); // 칸 안 표의 글: 이 칸의 문단 안 안쪽 표라 칸의 줄이다
  const deeperElsewhere = textRun(7, [[5, 3, 0], [0, 0, 0]], { x: 5, y: 5 }); // 같은 문단의 다른 컨트롤 안 표의 글
  const caption = textRun(7, [[2, 65534, 0]], { x: 5, y: 5 });
  const noCoords: LayoutRun = { ...inCell, paraIdx: 4294967295 };
  const atRightEdge = textRun(7, [[2, 4, 0]], { x: 49.2, y: 5 }); // 이웃 칸의 글이 자기 칸보다 1픽셀 왼쪽(이 칸의 오른쪽 가장자리 안)에서 시작한다
  const got = runsInCell([inCell, empty, spill, floating, otherPara, deeper, deeperElsewhere, caption, noCoords, atRightEdge], here, rect);
  assert.deepEqual(got, [inCell, empty, deeper]);
  // 중첩: 바깥 표 단계의 칸 안 문단 번호가 안쪽 표를 담은 문단 번호와 같아야 한다
  const nested = [
    { paragraph: 7, control: 2, row: 0, col: 1 },
    { paragraph: 4, control: 0, row: 1, col: 0 },
  ];
  const innerRun = textRun(7, [[2, 9, 4], [0, 1, 0]], { x: 5, y: 5 });
  const wrongPara = textRun(7, [[2, 9, 3], [0, 1, 0]], { x: 5, y: 5 });
  assert.deepEqual(runsInCell([innerRun, wrongPara, inCell], nested, rect), [innerRun], "깊이가 모자란 런(바깥 칸의 글)은 안쪽 칸의 것이 아니다");
});
