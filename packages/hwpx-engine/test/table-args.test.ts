// L1: 공개 `plan*` 함수의 입구는 null·잘못된 형의 인자를 코드 없는 TypeError로 터뜨리지 않고 `HwpxError`(코드가 있다)로 거절한다.
// 인자 하나씩을 쓸 수 없는 값으로 바꿔 부르고, 성공하거나 HwpxError를 던지면 통과다(TypeError·RangeError 등은 결함).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  mergeTablePlans,
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
} from "../src/index.ts";
import { gridTable, singleTableDoc, target } from "./table-helpers.ts";

const { doc } = singleTableDoc(gridTable([2000, 3000, 4000], 3, [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]], {}, 800));
const t = target(doc);
const at = { sectionIndex: 0, parentPath: [], index: 1, position: "after" as const };

/** 어느 자리에나 쓸 수 있는 잘못된 값 */
const JUNK: unknown[] = [null, undefined, 0, -1, 1.5, Number.NaN, "x", "", true, [], [null], [undefined], {}, { x: 1 }, () => 1];

type Case = { name: string; call: (...args: unknown[]) => unknown; valid: unknown[]; /** 자리별로 덧붙일 잘못된 값(일반 값에 더한다) */ extra?: unknown[][] };

const CASES: Case[] = [
  {
    name: "planSetTableProps",
    call: (d, tg, p, o) => planSetTableProps(d as never, tg as never, p as never, o as never),
    valid: [doc, t, { pageBreak: "NONE" }, undefined],
    extra: [[], [], [{ border: null }, { border: "x" }, { border: [] }, { border: {} }, { border: { sides: null } }, { border: { sides: "left" } }, { border: { type: null } }, { border: { width: null } }, { border: { color: null } }, { outMargin: null }, { inMargin: null }, { outMargin: { left: null } }, { treatAsChar: null }, { cellSpacing: null }, { hAlign: null }, { pageBreak: null }, { repeatHeader: null }], [{ deriver: null }, { deriver: 1 }]],
  },
  {
    name: "planSetCellProps",
    call: (d, tg, e, o) => planSetCellProps(d as never, tg as never, e as never, o as never),
    valid: [doc, t, [{ props: { vertAlign: "TOP" } }], undefined],
    extra: [[], [], [[null], [undefined], [{}], [{ props: null }], [{ props: { border: null } }], [{ props: { border: "x" } }], [{ props: { border: { sides: null } } }], [{ props: { margin: null } }], [{ props: { vertAlign: null } }], [{ props: { vertAlign: "TOP" }, rows: null }], [{ props: { vertAlign: "TOP" }, cols: "x" }], [{ props: { vertAlign: "TOP" }, rows: [null, null] }]], [{ deriver: null }]],
  },
  { name: "planSetColumnWidths", call: (d, tg, w) => planSetColumnWidths(d as never, tg as never, w as never), valid: [doc, t, [1000, 1000, 1000]], extra: [[], [], [[null, 1, 1], [undefined, 1, 1], [[1], 1, 1], ["1", 1, 1], [{}, 1, 1]]] },
  { name: "planScaleTable", call: (d, tg, s) => planScaleTable(d as never, tg as never, s as never), valid: [doc, t, { scale: 2 }], extra: [[], [], [{ scale: null }, { width: null }, { scale: "2" }, { width: "9000" }, { scale: {} }, { width: [] }, { scale: 1, width: 9000 }]] },
  { name: "planSetRowHeights", call: (d, tg, r) => planSetRowHeights(d as never, tg as never, r as never), valid: [doc, t, [{ row: 0, height: 700 }]], extra: [[], [], [[null], [{}], [{ row: null, height: 1 }], [{ row: 0, height: null }], [{ row: "0", height: 1 }], [[]]]] },
  { name: "planInsertRows", call: (d, tg, o) => planInsertRows(d as never, tg as never, o as never), valid: [doc, t, { prototype: 0 }], extra: [[], [], [{ prototype: null }, { prototype: 0, count: null }, { prototype: 0, position: null }, { prototype: 0, text: null }, { prototype: 0, extendSpans: null }, { count: 1 }]] },
  { name: "planRepeatRows", call: (d, tg, o) => planRepeatRows(d as never, tg as never, o as never), valid: [doc, t, { row: 0, count: 2 }], extra: [[], [], [{ row: null, count: 1 }, { row: 0, count: null }, { row: 0, count: 2, rewrite: 1 }, { row: 0, count: 2, rewrite: () => 1 }, { count: 2 }]] },
  { name: "planInsertColumns", call: (d, tg, o) => planInsertColumns(d as never, tg as never, o as never), valid: [doc, t, { prototype: 0 }], extra: [[], [], [{ prototype: null }, { prototype: 0, count: null }, { prototype: 0, position: null }, { prototype: 0, text: null }]] },
  { name: "planDeleteColumns", call: (d, tg, o) => planDeleteColumns(d as never, tg as never, o as never), valid: [doc, t, { cols: [0] }], extra: [[], [], [{ cols: null }, { cols: [null] }, { cols: ["0"] }, { cols: "0" }, {}]] },
  { name: "planMergeCells", call: (d, tg, o) => planMergeCells(d as never, tg as never, o as never), valid: [doc, t, { rows: [0, 0], cols: [0, 1] }], extra: [[], [], [{ rows: null, cols: [0, 1] }, { rows: [0, 0], cols: null }, { rows: [null, 0], cols: [0, 1] }, { rows: [0], cols: [0, 1] }, { rows: [0, 0], cols: [0, 1], content: null }, {}]] },
  { name: "planSplitCell", call: (d, tg, o) => planSplitCell(d as never, tg as never, o as never), valid: [doc, t, { row: 0, col: 0 }], extra: [[], [], [{ row: null, col: 0 }, { row: 0, col: null }, {}]] },
  {
    name: "planCloneTable",
    call: (d, a, s, o) => planCloneTable(d as never, a as never, s as never, o as never),
    valid: [doc, at, { table: t }, undefined],
    extra: [[], [{ sectionIndex: null }, { sectionIndex: 0, parentPath: null, index: 1, position: "after" }, { sectionIndex: 0, parentPath: [], index: null, position: "after" }, { sectionIndex: 0, parentPath: [], index: 1, position: null }], [{ table: null }, { table: {} }, { table: { sectionIndex: 0, element: null } }, { fragment: null }, { fragment: {} }, { fragment: { namespaces: null } }], [{ rows: null }, { cols: null }, { text: null }, { rows: "2" }]],
  },
];

function outcome(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof HwpxError && typeof e.code === "string" && e.code !== "" ? undefined : `${(e as Error)?.constructor?.name ?? typeof e}: ${(e as Error)?.message}`;
  }
}

test("L1: 공개 plan* 함수는 잘못된 형의 인자에 HwpxError(코드 있음)로만 거절한다", () => {
  const failures: string[] = [];
  for (const c of CASES) {
    c.valid.forEach((_v, pos) => {
      const values = [...JUNK, ...(c.extra?.[pos] ?? [])];
      for (const junk of values) {
        const args = c.valid.map((v, i) => (i === pos ? junk : v));
        const bad = outcome(() => c.call(...args));
        if (bad !== undefined) failures.push(`${c.name}[${pos}] ${typeof junk === "function" ? "fn" : JSON.stringify(junk)} → ${bad}`);
      }
    });
  }
  assert.deepEqual(failures, []);
});

test("L1: mergeTablePlans와 인자를 모두 빼고 부른 plan*도 HwpxError다", () => {
  const failures: string[] = [];
  for (const c of CASES) {
    const bad = outcome(() => c.call());
    if (bad !== undefined) failures.push(`${c.name}() → ${bad}`);
  }
  for (const junk of [null, undefined, 1, "x", {}, [], { edits: null }, { edits: [null] }]) {
    const bad = outcome(() => (mergeTablePlans as (...a: unknown[]) => unknown)(junk));
    if (bad !== undefined) failures.push(`mergeTablePlans(${JSON.stringify(junk)}) → ${bad}`);
  }
  assert.deepEqual(failures, []);
});

test("L1: 요청한 대표 사례 — border:null, 셀 목록의 null, 셀 border:null, planScaleTable(null), planCloneTable의 null 삽입 지점·출처", () => {
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  assert.equal(code(() => planSetTableProps(doc, t, { border: null } as never)), "TABLE_BAD_ARG");
  assert.equal(code(() => planSetCellProps(doc, t, [null] as never)), "TABLE_BAD_ARG");
  assert.equal(code(() => planSetCellProps(doc, t, [{ props: { border: null } }] as never)), "TABLE_BAD_ARG");
  assert.equal(code(() => planScaleTable(doc, t, null as never)), "TABLE_BAD_ARG");
  assert.equal(code(() => planCloneTable(doc, null as never, { table: t })), "TABLE_BAD_ARG");
  assert.equal(code(() => planCloneTable(doc, at, null as never)), "TABLE_BAD_ARG");
  assert.equal(code(() => planCloneTable(doc, at, {} as never)), "TABLE_BAD_ARG");
  assert.equal(code(() => planCloneTable(doc, at, { table: null } as never)), "TABLE_BAD_ARG");
});
