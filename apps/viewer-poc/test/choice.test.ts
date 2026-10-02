// 앵커 초안의 기본 선택 규칙(web/choice.ts). 채울 수 없는 초안은 고르지 않고, 문단 초안은 그것만 있을 때만 고른다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnchorDraftJson } from "../src/api-types.ts";
import { defaultDraftIndex } from "../web/choice.ts";

const at = { sectionIndex: 0, path: [1] };
const print = { text: "글", before: "", after: "", lineHash: "x" } as never;
const field = (blocked?: string) => ({ anchor: { kind: "field", name: "이름", occurrence: 0 } as AnchorDraftJson, ...(blocked === undefined ? {} : { blocked }) });
const word = (blocked?: string) => ({ anchor: { kind: "word", at, start: 0, end: 1, print } as unknown as AnchorDraftJson, ...(blocked === undefined ? {} : { blocked }) });
const line = (blocked?: string) => ({ anchor: { kind: "line", at, print } as unknown as AnchorDraftJson, ...(blocked === undefined ? {} : { blocked }) });
const cell = (blocked?: string) => ({ anchor: { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 0, col: 0 } as AnchorDraftJson, ...(blocked === undefined ? {} : { blocked }) });

test("기본 선택: 누름틀·낱말·셀 초안이 있으면 막히지 않은 첫 것을 고른다", () => {
  assert.equal(defaultDraftIndex([word(), line()]), 0);
  assert.equal(defaultDraftIndex([field(), word(), line()]), 0);
  assert.equal(defaultDraftIndex([field("FILL_HAS_OBJECT"), word(), line()]), 1, "막힌 앞 초안은 건너뛴다");
  assert.equal(defaultDraftIndex([word("FILL_MIXED_FORMAT"), line(), cell()]), 2, "낱말이 막히면 문단이 아니라 막히지 않은 셀이다");
});

test("기본 선택: 누름틀·낱말·셀 초안이 있는데 전부 막혔으면 문단 초안이 막히지 않았어도 아무것도 고르지 않는다", () => {
  assert.equal(defaultDraftIndex([word("FILL_MIXED_FORMAT"), line()]), undefined, "hancom/ph-mixed의 낱말이 막힌 경우");
  assert.equal(defaultDraftIndex([word("FILL_MIXED_FORMAT"), line(), cell("FILL_HAS_OBJECT")]), undefined);
  assert.equal(defaultDraftIndex([field("FILL_HAS_OBJECT"), line()]), undefined);
  assert.equal(defaultDraftIndex([line(), cell("FILL_HAS_OBJECT")]), undefined, "문단 초안과 막힌 셀 초안");
});

test("기본 선택: 문단 초안은 그것이 유일한 초안일 때(빈 곳·문단 정밀도)만 고르고, 막혔으면 고르지 않는다. 초안이 없으면 고르지 않는다", () => {
  assert.equal(defaultDraftIndex([line()]), 0);
  assert.equal(defaultDraftIndex([line("FILL_HAS_OBJECT")]), undefined);
  assert.equal(defaultDraftIndex([line(), cell()]), 1, "문단 정밀도의 표 칸: 문단과 셀이 있으면 셀이다");
  assert.equal(defaultDraftIndex([]), undefined);
});
