// 칸·글상자 사각형과 문단 위치(rhwp/containers.ts)의 순수 판단. 쪽 렌더 트리와 표 경로 칸 사각형 응답을 흉내 내서 시험한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainers, containerAt, runInContainer, type ApiCell, type Container, type ContainerSource } from "../src/rhwp/containers.ts";
import type { LayoutRun } from "../src/rhwp/index.ts";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const cell = (row: number, col: number, b: ReturnType<typeof box>, children: unknown[] = []) => ({ type: "Cell", row, col, bbox: b, children });
const table = (pi: number, ci: number, b: ReturnType<typeof box>, cells: unknown[]) => ({ type: "Table", pi, ci, bbox: b, children: cells });
const apiCell = (cellIdx: number, row: number, col: number, b: ReturnType<typeof box>): ApiCell => ({ cellIdx, row, col, ...b });

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

/** 표 경로 → 칸 사각형 응답을 표로 준다(호출 기록도 남긴다) */
function source(answers: Record<string, ApiCell[]>, controls: unknown = { controls: [] }, runs?: LayoutRun[]): { src: ContainerSource; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    src: {
      controls,
      ...(runs === undefined ? {} : { runs }),
      tableCells(parentPara, path) {
        const key = JSON.stringify([parentPara, path.map((s) => [s.controlIndex, s.cellIndex, s.cellParaIndex])]);
        calls.push(key);
        return answers[key];
      },
    },
  };
}

test("최상위 표: 칸마다 식별된다(표를 담은 문단 번호와 컨트롤 번호, 응답의 칸 색인). 병합으로 칸 색인이 행·열 곱과 달라도 응답의 색인을 쓴다", () => {
  const tree = { type: "Page", children: [{ type: "Body", children: [table(17, 1, box(0, 0, 100, 20), [cell(0, 0, box(0, 0, 40, 20)), cell(0, 2, box(40, 0, 60, 20))])] }] };
  const { src, calls } = source(
    { [JSON.stringify([17, [[1, 0, 0]]])]: [apiCell(0, 0, 0, box(0, 0, 40, 20)), apiCell(1, 0, 2, box(40, 0, 60, 20))] },
    { controls: [] },
    [textRun(17, [[1, 0, 0]], { x: 5, y: 5 }), textRun(17, [[1, 1, 0]], { x: 45, y: 5 })],
  );
  const list = buildContainers(tree, src);
  assert.deepEqual(calls, [JSON.stringify([17, [[1, 0, 0]]])]);
  assert.deepEqual(
    list.map((c) => c.id),
    [
      { parentPara: 17, steps: [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 0 }] },
      { parentPara: 17, steps: [{ controlIndex: 1, cellIndex: 1, cellParaIndex: 0 }] },
    ],
  );
});

test("칸 사각형이 응답과 맞지 않거나 응답이 없으면 식별하지 못한 칸이다(그 안의 점은 unknown)", () => {
  const tree = { type: "Body", children: [table(1, 0, box(0, 0, 100, 20), [cell(0, 0, box(0, 0, 100, 20))])] };
  const key = JSON.stringify([1, [[0, 0, 0]]]);
  for (const answers of [{}, { [key]: [apiCell(0, 0, 0, box(30, 0, 100, 20))] }, { [key]: [apiCell(0, 1, 0, box(0, 0, 100, 20))] }]) {
    const list = buildContainers(tree, source(answers).src);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, undefined);
    assert.deepEqual(containerAt(list, 10, 10), { kind: "unknown" });
  }
});

test("검증: 칸 사각형 안 글 있는 런의 칸 색인이 식별한 색인과 어긋나면(표 칸 응답 번호와 런의 칸 번호가 한 칸씩 밀린 표) 그 표의 칸은 모두 식별하지 않는다. 검증할 런이 없어도 마찬가지다", () => {
  const tree = { type: "Body", children: [table(9, 0, box(0, 0, 100, 20), [cell(0, 0, box(0, 0, 50, 20)), cell(0, 1, box(50, 0, 50, 20))])] };
  const answers = { [JSON.stringify([9, [[0, 0, 0]]])]: [apiCell(1, 0, 0, box(0, 0, 50, 20)), apiCell(2, 0, 1, box(50, 0, 50, 20))] }; // 응답은 칸 색인이 1부터
  const ids = (runs: LayoutRun[] | undefined): (string | undefined)[] =>
    buildContainers(tree, source(answers, { controls: [] }, runs).src).map((c) => (c.id === undefined ? undefined : JSON.stringify(c.id.steps[0]?.cellIndex)));
  // 런의 칸 번호는 응답 색인보다 하나 작다: 어긋남
  assert.deepEqual(ids([textRun(9, [[0, 0, 0]], { x: 5, y: 5 }), textRun(9, [[0, 1, 0]], { x: 55, y: 5 })]), [undefined, undefined]);
  // 어긋난 런이 하나라도 있으면(다른 칸은 맞아도) 표 전체를 식별하지 않는다
  assert.deepEqual(ids([textRun(9, [[0, 1, 0]], { x: 5, y: 5 }), textRun(9, [[0, 0, 0]], { x: 55, y: 5 })]), [undefined, undefined]);
  // 맞는 런만 있으면 식별한다
  assert.deepEqual(ids([textRun(9, [[0, 1, 0]], { x: 5, y: 5 }), textRun(9, [[0, 2, 0]], { x: 55, y: 5 })]), ["1", "2"]);
  // 글 있는 런이 없으면(빈 런뿐이거나 런 정보가 없으면) 검증할 수 없어 식별하지 않는다
  assert.deepEqual(ids([textRun(9, [[0, 1, 0]], { x: 5, y: 5 }, "")]), [undefined, undefined]);
  assert.deepEqual(ids(undefined), [undefined, undefined]);
});

test("중첩 표: 안쪽 표는 바깥 칸 단계(칸 색인, 안쪽 표를 담은 칸 안 문단 번호 `pi`)를 이은 경로로 묻고, 점은 가장 안쪽 칸으로 정한다", () => {
  const inner = table(1, 0, box(60, 5, 30, 10), [cell(0, 0, box(60, 5, 15, 10)), cell(0, 1, box(75, 5, 15, 10))]);
  const tree = { type: "Body", children: [table(2, 0, box(0, 0, 100, 20), [cell(0, 0, box(0, 0, 50, 20)), cell(0, 1, box(50, 0, 50, 20), [inner])])] };
  const outerKey = JSON.stringify([2, [[0, 0, 0]]]);
  const innerKey = JSON.stringify([2, [[0, 1, 1], [0, 0, 0]]]);
  const { src, calls } = source(
    {
      [outerKey]: [apiCell(0, 0, 0, box(0, 0, 50, 20)), apiCell(1, 0, 1, box(50, 0, 50, 20))],
      [innerKey]: [apiCell(0, 0, 0, box(60, 5, 15, 10)), apiCell(1, 0, 1, box(75, 5, 15, 10))],
    },
    { controls: [] },
    [textRun(2, [[0, 0, 0]], { x: 5, y: 5 }), textRun(2, [[0, 1, 1], [0, 0, 0]], { x: 62, y: 8 }), textRun(2, [[0, 1, 1], [0, 1, 0]], { x: 77, y: 8 })],
  );
  const list = buildContainers(tree, src);
  assert.deepEqual(calls, [outerKey, innerKey]);
  const hit = containerAt(list, 80, 10);
  assert.equal(hit.kind, "in");
  assert.deepEqual(hit.kind === "in" ? hit.container.id : undefined, {
    parentPara: 2,
    steps: [
      { controlIndex: 0, cellIndex: 1, cellParaIndex: 1 },
      { controlIndex: 0, cellIndex: 1, cellParaIndex: 0 },
    ],
  });
  // 바깥 칸 1에서 안쪽 표 밖
  const outside = containerAt(list, 55, 18);
  assert.deepEqual(outside.kind === "in" ? outside.container.id.steps : undefined, [{ controlIndex: 0, cellIndex: 1, cellParaIndex: 0 }]);
  assert.deepEqual(containerAt(list, 200, 10), { kind: "none" });
});

test("머리말·꼬리말·바탕쪽·각주 영역 안의 표 칸과 글상자 안의 표는 식별하지 않는다(문서 좌표가 본문과 겹쳐 보인다)", () => {
  const t = (pi: number) => table(pi, 0, box(0, 0, 10, 10), [cell(0, 0, box(0, 0, 10, 10))]);
  const answers = { [JSON.stringify([0, [[0, 0, 0]]])]: [apiCell(0, 0, 0, box(0, 0, 10, 10))] };
  for (const area of ["Header", "Footer", "MasterPage", "FootnoteArea"]) {
    const list = buildContainers({ type: "Page", children: [{ type: area, children: [t(0)] }] }, source(answers).src);
    assert.equal(list[0]?.id, undefined, area);
  }
  const boxed = { type: "Body", children: [{ type: "Rect", bbox: box(0, 0, 50, 50), children: [{ type: "TextBox", bbox: box(2, 2, 46, 46), children: [t(0)] }] }] };
  const list = buildContainers(boxed, source(answers, { controls: [{ type: "shape", x: 0, y: 0, w: 50, h: 50, paraIdx: 1, controlIdx: 0 }] }, [textRun(1, [[0, 0, 0]], { x: 5, y: 5 })]).src);
  assert.deepEqual(
    list.map((c) => [c.kind, c.id !== undefined]),
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
  const list = buildContainers(tree, source({ [JSON.stringify([1, [[0, 0, 0]]])]: [apiCell(0, 0, 0, box(0, 100, 100, 40))] }, controls, [textRun(1, [[0, 0, 0]], { x: 15, y: 15 })]).src);
  const textboxes = list.filter((c) => c.kind === "textbox");
  assert.deepEqual(
    textboxes.map((c) => c.id),
    [{ parentPara: 1, steps: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] }, undefined, undefined],
  );
});

test("containerAt: 가장 작은 사각형이 나머지 모두 안에 들어야 한다 — 서로 포개지 않고 겹친 사각형 안의 점은 unknown", () => {
  const id = { parentPara: 1, steps: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] };
  const a: Container = { rect: box(0, 0, 100, 100), kind: "cell", id };
  const b: Container = { rect: box(20, 20, 30, 30), kind: "textbox", id };
  const c: Container = { rect: box(40, 40, 60, 60), kind: "textbox", id };
  const hit = containerAt([a, b], 30, 30);
  assert.equal(hit.kind, "in");
  assert.deepEqual(hit.kind === "in" ? hit.container.rect : undefined, b.rect);
  assert.deepEqual(containerAt([a, b, c], 45, 45), { kind: "unknown" }, "b와 c가 서로 포개지 않고 겹친다");
  assert.deepEqual(containerAt([a, { rect: box(10, 10, 20, 20), kind: "cell" }], 15, 15), { kind: "unknown" }, "식별하지 못한 칸");
});

test("runInContainer: 같은 부모 문단·같은 깊이·단계마다 컨트롤과 칸 색인이 같고 바깥 단계는 칸 안 문단 번호도 같아야 한다", () => {
  const run = (parent: number, steps: [number, number, number][]): LayoutRun => ({
    text: "x",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    charX: [0, 1],
    secIdx: 0,
    paraIdx: 0,
    charStart: 0,
    parentParaIdx: parent,
    cellPath: steps.map(([controlIndex, cellIndex, cellParaIndex]) => ({ controlIndex, cellIndex, cellParaIndex })),
  });
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
