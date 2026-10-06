// 시작·끝 깃발 범위(#74): `locate`에 `{ flags: { start, end } }`를 보내면 같은 두 문단을 끈 것(#53, `{ from, to }`)과 같은 응답이 나오는가.
// 깃발은 쪽 글자 배치의 런에서 얻은 점(런이 없는 문단은 문단 처음의 위치)이거나 표 칸의 빈 곳(`cell`)이다.
// 기대값은 제목 모형(heading-helpers)·문단 목록과 엔진의 makeRangeAnchor·makeHeadingRangeAnchor에서 세우고, 끌기 응답과도 맞대어 본다.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { generate, makeHeadingRangeAnchor, makeRangeAnchor, readDataset, type HwpxDocument } from "../../hwpx-engine/src/index.ts";
import { headingDoc, rangeOfModel, type Item } from "../../hwpx-engine/test/heading-helpers.ts";
import { reparse } from "../../hwpx-engine/test/helpers.ts";
import { dataFor, del, done, fragOf, gateClean, inject, KEEP, listOf, longValue, rng, tpl } from "../../hwpx-engine/test/range-helpers.ts";
import { defaultDraftIndex } from "../src/dom/choice.ts";
import { HostError } from "../src/host/errors.ts";
import { locate } from "../src/host/locate.ts";
import type { AnchorDraftJson, DraftView, FlagRequest, LocatePoint, LocateResponse } from "../src/host/types.ts";
import { controlSlots, type CellRef } from "../src/map/index.ts";
import { MARKER_PARA_MIN, openDocument, type LayoutRun } from "../src/rhwp/index.ts";
import { FOOTNOTE, P, R, RECT, SUBLIST, SUBP, T, TBL, ensureRhwp, paragraphKey, paragraphPoints, readFixture, synth } from "./helpers.ts";

/** 시험 문서: 바이트, 엔진 문서, 문단마다 누를 점, 제목 모형의 목록(키: 부모 주소를 쉼표로 이은 것), 부모 주소에서 지나오는 컨테이너 */
type Fixture = { bytes: Uint8Array; doc: HwpxDocument; points: Map<string, LocatePoint[]>; lists: ReadonlyMap<string, readonly Item[]>; trailOf: (parentPath: readonly number[]) => string[] };
let fx: Fixture;
let obj: Fixture;

const keyOf = (path: readonly number[]): string => path.join(",");
const lastOf = (path: readonly number[]): number => path[path.length - 1] ?? -1;

/** 글상자·각주·표가 든 합성 문서: [1] 본문, [2] 글상자 문단(그 안 [2,0,0..2], 둘째가 제목), [3] 각주가 든 문단, [4] 제목, [5] 본문, [6] 표(칸 [6,0,0..1]·[6,1,0]), [7] 본문 */
const OBJECT_DOC = [
  P(R(T("본문 하나"))),
  P(R(T("앞") + RECT(SUBLIST(SUBP("글상자 첫째") + SUBP("1. 글상자 제목") + SUBP("글상자 셋째")), "1") + T("뒤"))),
  P(R(T("본문 셋 각주 앞") + FOOTNOTE("각주 글") + T(" 뒤"))),
  P(R(T("1. 본문 제목"))),
  P(R(T("본문 다섯"))),
  P(R(TBL([[SUBP("칸 하나") + SUBP("칸 둘")], [SUBP("칸 셋")]]))),
  P(R(T("본문 일곱"))),
];

before(async () => {
  await ensureRhwp();
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  // 제목 시험 문서의 하위 목록은 모두 표 칸이다(중첩이면 바깥부터 표마다 하나)
  fx = { bytes, doc, points: paragraphPoints(bytes, doc), lists: new Map([["", model.top], ...model.lists]), trailOf: (pp) => pp.filter((_, i) => i % 2 === 0).map(() => "tbl") };
  const objBytes = synth(OBJECT_DOC);
  const objDoc = reparse(objBytes);
  obj = { bytes: objBytes, doc: objDoc, points: paragraphPoints(objBytes, objDoc), lists: new Map(), trailOf: (pp) => (pp.length === 0 ? [] : pp[0] === 2 ? ["rect"] : ["tbl"]) };
});

function pointAt(f: Fixture, path: readonly number[], k = 0): LocatePoint {
  const list = f.points.get(paragraphKey(0, path)) ?? [];
  const p = list[Math.min(k, list.length - 1)];
  assert.ok(p !== undefined, `문단 [${keyOf(path)}]에 누를 점이 없다`);
  return p;
}

const flagReq = (start: LocatePoint, end: LocatePoint): FlagRequest => ({ flags: { start, end } });
const flags = (f: Fixture, start: LocatePoint, end: LocatePoint): LocateResponse => locate(f.doc, flagReq(start, end));
const drag = (f: Fixture, from: LocatePoint, to: LocatePoint): LocateResponse => locate(f.doc, { from, to });
const DIFFER: LocateResponse = { precision: "none", reason: "RANGE_PARAGRAPHS_DIFFER", trail: [], edge: "start", drafts: [] };
const none = (reason: string, trail: string[] = []): LocateResponse => ({ precision: "none", reason, trail, edge: "start", drafts: [] });

/**
 * 두 문단 `a`·`b`(엔진 주소)를 고른 범위의 기대 응답: 부모가 다르면 `RANGE_PARAGRAPHS_DIFFER`, 같으면 문서 순서의 문단 범위와 시작 문단 주소,
 * 첫 초안은 range(makeRangeAnchor), 앞 문단이 제목이면 둘째 초안은 headingRange(makeHeadingRangeAnchor). 모형이 있는 목록은 제목 여부를 모형과 맞대어 본다.
 */
function expected(f: Fixture, a: readonly number[], b: readonly number[]): LocateResponse {
  const parentPath = a.slice(0, -1);
  if (keyOf(parentPath) !== keyOf(b.slice(0, -1))) return DIFFER;
  const from = Math.min(lastOf(a), lastOf(b));
  const to = Math.max(lastOf(a), lastOf(b));
  const range = makeRangeAnchor(f.doc, 0, parentPath, from, to);
  assert.ok(range !== undefined, `범위 [${keyOf(parentPath)}] ${from}~${to}`);
  assert.deepEqual([range.print.count, range.from, range.to], [to - from + 1, from, to]);
  const drafts: DraftView[] = [{ anchor: range }];
  const heading = makeHeadingRangeAnchor(f.doc, 0, parentPath, from);
  const items = f.lists.get(keyOf(parentPath));
  if (items !== undefined) assert.equal(heading !== undefined, items[from]?.mark !== undefined, `[${keyOf(parentPath)}] ${from}: 모형과 엔진의 제목 판정`);
  if (heading !== undefined) drafts.push({ anchor: heading });
  return { precision: "paragraph", address: { sectionIndex: 0, path: [...parentPath, from] }, trail: f.trailOf(parentPath), span: { sectionIndex: 0, parentPath, from, to }, edge: "start", drafts };
}

/** 깃발 응답이 기대와 같고, 역순 깃발도 같고, 다시 불러도 같고, 두 문단이 다르면 같은 점으로 끈 응답과도 같은가(칸 깃발 제외). 돌려주는 값: 깃발 응답 */
function checkPair(f: Fixture, a: readonly number[], b: readonly number[], p: LocatePoint, q: LocatePoint, label: string): LocateResponse {
  const r = flags(f, p, q);
  assert.deepEqual(r, expected(f, a, b), label);
  assert.deepEqual(flags(f, q, p), r, `${label}: 역순`);
  assert.deepEqual(flags(f, p, q), r, `${label}: 결정성`);
  // 끌기는 칸의 빈 곳(`cell`)에서 시작하면 한 점이고 끝으로는 칸을 받지 않으므로, 칸 깃발은 칸의 첫 문단을 끈 것과 따로 맞대어 본다
  if (keyOf(a) !== keyOf(b) && p.cell === undefined && q.cell === undefined) assert.deepEqual(drag(f, p, q), r, `${label}: 끌기와 같다`);
  if (r.precision === "paragraph") assert.equal(defaultDraftIndex(r.drafts), 0, `${label}: 기본 초안은 range`);
  return r;
}

/** 초안으로 1판 생성(바꾸기·지우기)해 게이트·검사기 새 오류 0을 본다. 구역 설정 문단(최상위 0)을 덮는 범위는 엔진이 거절하므로 건너뛴다. 돌려주는 값: 생성했는가 */
function generateWith(f: Fixture, r: LocateResponse, draft: AnchorDraftJson, next: () => number): boolean {
  const span = r.span;
  assert.ok(span !== undefined);
  if (span.parentPath.length === 0 && span.from === 0) return false;
  const frag = fragOf(f.doc, 1, 1);
  const data = readDataset(dataFor(f.doc, () => longValue(next, 200, 600)));
  // 칸의 문단 전부를 지우면 칸이 비므로(FILL_LAST_PARAGRAPH) 그때는 바꾼다
  const whole = span.parentPath.length > 0 && span.from === 0 && span.to === listOf(f.doc, span.parentPath).length - 1;
  const rule = whole || next() < 0.5 ? inject("x", "a", frag) : del("x", "a");
  const out = done(generate(f.bytes, tpl([{ ...draft, id: "a" }], [rule]), data, KEEP));
  gateClean(f.bytes, out);
  return true;
}

test("깃발 제목 범위: 모형의 제목마다 시작 깃발은 제목, 끝 깃발은 그 제목 범위의 끝 문단 → range 초안이 headingRange 초안과 같은 범위, 끌기와 같다, 생성하면 새 오류 0", (t) => {
  const next = rng(74);
  let pairs = 0;
  let single = 0;
  let generated = 0;
  for (const [parent, items] of fx.lists) {
    const parentPath = parent === "" ? [] : parent.split(",").map(Number);
    items.forEach((item, i) => {
      if (item.mark === undefined) return;
      const { to } = rangeOfModel(items, i);
      const a = [...parentPath, i];
      const b = [...parentPath, to];
      const label = `제목 [${keyOf(a)}] ~ [${keyOf(b)}]`;
      const r = checkPair(fx, a, b, pointAt(fx, a), pointAt(fx, b, 1), label);
      const [range, heading] = r.drafts;
      assert.ok(range?.anchor.kind === "range" && heading?.anchor.kind === "headingRange", label);
      assert.deepEqual(range.anchor.print, heading.anchor.print, `${label}: 깃발 범위 = 제목 범위`);
      pairs++;
      if (to === i) single++;
      // 두 초안을 번갈아 생성에 쓴다
      if (generateWith(fx, r, (pairs % 2 === 0 ? range : heading).anchor, next)) generated++;
    });
  }
  t.diagnostic(JSON.stringify({ pairs, single, generated }));
  // 모형의 제목 47개(최상위·칸 [12,1]·복사본 칸) 전부, 그 가운데 제목 범위가 제목 문단 하나뿐인 것 13개
  assert.ok(pairs >= 45 && single >= 10 && generated >= 40, JSON.stringify({ pairs, single, generated }));
});

test("깃발 무작위 80쌍(시드 고정): 본문·표 칸·같은 문단 두 번·경계 넘김 — 기대 응답과 같고, 역순·다시 불러도 같고, 다른 문단이면 끌기와 같다", (t) => {
  const next = rng(7474);
  const pick = <T>(list: readonly T[]): T => {
    const v = list[Math.floor(next() * list.length)];
    assert.ok(v !== undefined);
    return v;
  };
  const keys = [...fx.points.keys()].map((k) => (k.split("|")[1] ?? "").split(",").map(Number));
  const counts = { body: 0, cells: 0, same: 0, differ: 0, heading: 0, generated: 0 };
  for (let n = 0; n < 80; n++) {
    let a: number[];
    let b: number[];
    const roll = next();
    if (roll < 0.5) {
      // 같은 목록(최상위·칸 [12,1]·복사본 칸 [79,1])의 다른 두 문단
      const parent = pick(["", "", "12,1", "79,1"]);
      const prefix = parent === "" ? [] : parent.split(",").map(Number);
      const size = listOf(fx.doc, prefix).length;
      const i = Math.floor(next() * size);
      a = [...prefix, i];
      b = [...prefix, (i + 1 + Math.floor(next() * (size - 1))) % size];
    } else if (roll < 0.7) {
      // 같은 문단 두 번(같은 점이거나 다른 글자)
      a = pick(keys);
      b = a;
    } else {
      // 문서 전체에서 두 문단
      a = pick(keys);
      b = pick(keys);
    }
    const label = `${n}: [${keyOf(a)}] ~ [${keyOf(b)}]`;
    const p = pick(fx.points.get(paragraphKey(0, a)) ?? []);
    const q = pick(fx.points.get(paragraphKey(0, b)) ?? []);
    const r = checkPair(fx, a, b, p, q, label);
    if (r.precision === "none") {
      counts.differ++;
      continue;
    }
    if (keyOf(a) === keyOf(b)) counts.same++;
    else if (a.length === 1) counts.body++;
    else counts.cells++;
    if (r.drafts.length === 2) counts.heading++;
    if (generateWith(fx, r, pick(r.drafts).anchor, next)) counts.generated++;
  }
  t.diagnostic(JSON.stringify(counts));
  assert.ok(counts.body >= 15 && counts.cells >= 8 && counts.same >= 10 && counts.differ >= 8 && counts.heading >= 5 && counts.generated >= 30, JSON.stringify(counts));
});

test("깃발 같은 문단 두 번: 문단 하나짜리 range(제목이면 headingRange 둘째) — 같은 문단 안 끌기(글자 범위 word)와 다르다", () => {
  const cases: number[][] = [[18], [17], [12], [12, 1, 3], [12, 1, 6], [79, 1, 15]];
  for (const a of cases) {
    const label = `[${keyOf(a)}]`;
    const twice = checkPair(fx, a, a, pointAt(fx, a), pointAt(fx, a), `${label} 같은 점`);
    assert.deepEqual(checkPair(fx, a, a, pointAt(fx, a, 0), pointAt(fx, a, 1), `${label} 다른 글자`), twice);
    assert.deepEqual([twice.span?.from, twice.span?.to, twice.drafts[0]?.anchor.kind === "range" && twice.drafts[0].anchor.print.count], [lastOf(a), lastOf(a), 1], label);
  }
  // 대조: 같은 문단 안 끌기는 글자 범위의 word 초안이다(#53 그대로)
  const start = fx.points.get(paragraphKey(0, [18]))?.find((p) => p.shown?.start === 0);
  assert.ok(start?.position !== undefined);
  const word = drag(fx, start, { ...start, position: { ...start.position, charOffset: 4 } });
  assert.deepEqual([word.precision, word.range, word.span, word.drafts[0]?.anchor.kind], ["char", { start: 0, end: 4 }, undefined, "word"]);
  assert.equal(flags(fx, start, { ...start, position: { ...start.position, charOffset: 4 } }).span?.to, 18);
});

test("깃발 표 칸 빈 곳(cell): 칸을 엔진 표·행·열로 찾아 칸의 첫 문단이 깃발 — 칸 안 문단과의 범위는 끌기와 같고, 다른 칸·최상위와는 RANGE_PARAGRAPHS_DIFFER, 없는 칸은 그 깃발의 사유", () => {
  /** 문단 `owner`의 표에서 하위 목록 `sub`인 칸의 표 경로(행·열) */
  const cellRef = (owner: number, sub: number): CellRef => {
    const paragraph = fx.doc.sections[0]?.paragraphs[owner];
    assert.ok(paragraph !== undefined);
    const target = paragraph.subLists[sub];
    const slot = controlSlots(paragraph).find((s) => s.cells?.some((c) => c.subList === target) === true);
    const cell = slot?.cells?.find((c) => c.subList === target);
    assert.ok(slot !== undefined && cell !== undefined, `[${owner}, ${sub}]의 칸`);
    return { sectionIndex: 0, steps: [{ paragraph: owner, control: slot.index, row: cell.row, col: cell.col }] };
  };
  const blank: LocatePoint = { cell: cellRef(12, 1) };
  for (const k of [1, 4, 9, 12]) {
    const b = [12, 1, k];
    const r = checkPair(fx, [12, 1, 0], b, blank, pointAt(fx, b), `빈 칸 ~ [${keyOf(b)}]`);
    assert.deepEqual(drag(fx, pointAt(fx, [12, 1, 0]), pointAt(fx, b)), r, `[${keyOf(b)}]: 칸 첫 문단을 끈 것과 같다`);
  }
  checkPair(fx, [12, 1, 0], [12, 1, 0], blank, pointAt(fx, [12, 1, 0]), "빈 칸 ~ 같은 칸 첫 문단");
  assert.deepEqual(flags(fx, blank, { cell: cellRef(79, 1) }), DIFFER, "다른 표의 칸");
  assert.deepEqual(flags(fx, { cell: cellRef(12, 0) }, pointAt(fx, [12, 1, 3])), DIFFER, "같은 표의 다른 칸");
  assert.deepEqual(flags(fx, blank, pointAt(fx, [30])), DIFFER, "칸 ↔ 최상위");
  const missing: LocatePoint = { cell: { sectionIndex: 0, steps: [{ paragraph: 12, control: 0, row: 99, col: 99 }] } };
  const res = flags(fx, missing, pointAt(fx, [12, 1, 3]));
  assert.equal(res.precision, "none");
  assert.equal(res.drafts.length, 0);
  assert.ok(res.reason !== undefined && res.reason !== "RANGE_PARAGRAPHS_DIFFER", `없는 칸의 사유: ${res.reason}`);
});

test("깃발 개체 경계: 글상자 안 문단끼리는 범위(제목이면 headingRange), 글상자 ↔ 본문·그 글상자를 담은 문단·표 칸, 표의 다른 칸은 RANGE_PARAGRAPHS_DIFFER — 끌기와 같다", () => {
  const inside: [number[], number[]][] = [
    [[2, 0, 0], [2, 0, 2]],
    [[2, 0, 1], [2, 0, 2]],
    [[2, 0, 2], [2, 0, 0]],
    [[1], [7]],
    [[4], [5]],
    [[6, 0, 0], [6, 0, 1]],
  ];
  let headings = 0;
  for (const [a, b] of inside) {
    const r = checkPair(obj, a, b, pointAt(obj, a), pointAt(obj, b, 1), `[${keyOf(a)}] ~ [${keyOf(b)}]`);
    assert.equal(r.precision, "paragraph");
    if (r.drafts.length === 2) headings++;
  }
  assert.equal(headings, 2, "글상자 제목 [2,0,1]과 본문 제목 [4]");
  const across: [number[], number[]][] = [
    [[2, 0, 0], [1]],
    [[2, 0, 1], [2]],
    [[2, 0, 2], [6, 0, 0]],
    [[6, 0, 1], [6, 1, 0]],
    [[6], [6, 0, 0]],
    [[3], [2, 0, 0]],
  ];
  for (const [a, b] of across) assert.deepEqual(checkPair(obj, a, b, pointAt(obj, a), pointAt(obj, b), `[${keyOf(a)}] ~ [${keyOf(b)}]`), DIFFER);
});

test("깃발 한계: 머리말·꼬리말·각주 글은 화면이 위치를 얻지 못하므로(pick: 위치 없음) 깃발이 될 수 없고, 위치 없는 깃발·틀린 본문은 400", () => {
  const markerRuns = (runs: readonly LayoutRun[]): LayoutRun[] => runs.filter((r) => typeof r.paraIdx === "number" && r.paraIdx >= MARKER_PARA_MIN);
  // 각주 글(합성 문서), 머리말·꼬리말 글(한컴 저장본): 화면의 pick이 영역만 주고 위치·한계를 주지 않는다
  for (const [bytes, regions] of [[obj.bytes, ["footnote"]], [readFixture("hancom/header-footer"), ["footer", "header"]]] as const) {
    const view = openDocument(bytes);
    try {
      const seen = new Set<string>();
      for (const run of markerRuns(view.pageLayout(0).runs)) {
        const pick = view.pick(0, run.x + run.w / 2, run.y + run.h / 2);
        assert.deepEqual([pick.hit.position, pick.limit], [undefined, "none"]);
        seen.add(pick.hit.region);
      }
      assert.deepEqual([...seen].sort(), [...regions]);
    } finally {
      view.free();
    }
  }
  const good = pointAt(obj, [1]);
  const bad = (body: unknown, code: string): void => {
    assert.throws(() => locate(obj.doc, body), (e: unknown) => e instanceof HostError && e.status === 400 && e.code === code, code);
  };
  bad({ flags: { start: {}, end: good } }, "BAD_POSITION");
  bad({ flags: { start: good, end: { shown: { text: "글", start: 0 } } } }, "BAD_POSITION");
  bad({ flags: { start: good } }, "BAD_REQUEST");
  bad({ flags: [good, good] }, "BAD_REQUEST");
  bad({ flags: { start: good, end: good }, from: good }, "BAD_REQUEST");
  bad({ flags: { start: good, end: { ...good, limit: "none" } } }, "BAD_LIMIT");
  // 위치를 풀지 못한 깃발은 그 깃발의 사유(끌기와 같다)
  const lost: LocatePoint = { position: { sectionIndex: 0, paragraphIndex: 999, charOffset: 0 } };
  const foreign: LocatePoint = { ...good, shown: { text: "문서에 없는 글", start: good.shown?.start ?? 0 } };
  assert.deepEqual(flags(obj, good, lost), none("PARAGRAPH_NOT_FOUND"));
  assert.deepEqual(flags(obj, lost, good), none("PARAGRAPH_NOT_FOUND"));
  assert.deepEqual(flags(obj, foreign, pointAt(obj, [2, 0, 0])), none("PARAGRAPH_MISMATCH"), "부모가 다른 깃발이어도 풀지 못한 깃발이 먼저");
  assert.deepEqual(flags(obj, good, lost), drag(obj, good, lost));
});
