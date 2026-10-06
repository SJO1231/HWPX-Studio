// 여러 문단에 걸친 끌기의 초안(#53): 두 끝이 같은 구역·같은 부모의 다른 문단이면 `range` 초안(앞 문단이 제목이면 `headingRange` 초안이 둘째),
// 부모가 다르면 `none`(`RANGE_PARAGRAPHS_DIFFER`), 한 끝이라도 문단을 찾지 못하면 그 끝의 결과다.
// 끄는 점은 rhwp가 그린 쪽 글자 배치의 런에서 얻는다(런이 없는 표 문단·빈 문단은 문단 처음의 위치). 기대값은 시험 문서의 제목 모형(heading-helpers)과 문단 목록에서 세운다.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  checkAnchors,
  generate,
  makeHeadingRangeAnchor,
  makeRangeAnchor,
  readDataset,
  redraftAnchor,
  walkParagraphs,
  type HwpxDocument,
  type StudioAnchor,
} from "../../hwpx-engine/src/index.ts";
import { headingDoc, rangeOfModel, type Item } from "../../hwpx-engine/test/heading-helpers.ts";
import { bytesEqual, reparse } from "../../hwpx-engine/test/helpers.ts";
import { dataFor, del, done, fragOf, gateClean, inject, KEEP, listOf, longValue, rng, texts, tpl } from "../../hwpx-engine/test/range-helpers.ts";
import { defaultDraftIndex } from "../src/dom/choice.ts";
import { locate } from "../src/host/locate.ts";
import type { AnchorDraftJson, LocatePoint, LocateResponse } from "../src/host/types.ts";
import { toEngineAddress, toRhwpPosition } from "../src/map/index.ts";
import { openDocument } from "../src/rhwp/index.ts";
import { codePointLength, runPosition } from "../src/rhwp/layout.ts";
import { ensureRhwp } from "./helpers.ts";

/** 시험 문서와 문단마다 끌 수 있는 점(키: 엔진 주소 `path`를 쉼표로 이은 것. 구역은 0 하나) */
type Fixture = { bytes: Uint8Array; doc: HwpxDocument; lists: ReadonlyMap<string, readonly Item[]>; points: Map<string, LocatePoint[]> };
let fx: Fixture;

const keyOf = (path: readonly number[]): string => path.join(",");
const lastOf = (path: readonly number[]): number => path[path.length - 1] ?? -1;

before(async () => {
  await ensureRhwp();
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const points = new Map<string, LocatePoint[]>();
  const view = openDocument(bytes);
  try {
    for (let page = 0; page < view.pageCount(); page++) {
      for (const run of view.pageLayout(page).runs) {
        const position = runPosition(run);
        if (position === undefined || run.text === "") continue;
        const shown = { text: run.text, start: position.charOffset };
        const found = toEngineAddress(doc, position, shown);
        if (found.precision !== "char" || found.address.sectionIndex !== 0) continue;
        // 런의 첫 글자와 가운데 글자를 누른 점
        const list = points.get(keyOf(found.address.path)) ?? [];
        list.push({ position, shown }, { position: { ...position, charOffset: position.charOffset + (codePointLength(run.text) >> 1) }, shown });
        points.set(keyOf(found.address.path), list);
      }
    }
  } finally {
    view.free();
  }
  // 런이 없는 문단(표를 담은 문단 등): 확인할 런이 없는 문단 처음(문단 단위로 풀린다)
  for (const p of walkParagraphs(doc.sections[0]?.paragraphs ?? [])) {
    if (points.has(keyOf(p.path))) continue;
    const position = toRhwpPosition(doc, { sectionIndex: 0, path: p.path });
    if (position !== undefined) points.set(keyOf(p.path), [{ position }]);
  }
  fx = { bytes, doc, lists: new Map([["", model.top], ...model.lists]), points };
});

function pointAt(path: readonly number[], k = 0): LocatePoint {
  const list = fx.points.get(keyOf(path)) ?? [];
  const p = list[Math.min(k, list.length - 1)];
  assert.ok(p !== undefined, `문단 [${keyOf(path)}]에 끌 점이 없다`);
  return p;
}

const drag = (from: LocatePoint, to: LocatePoint): LocateResponse => locate(fx.doc, { from, to });

const differ: LocateResponse = { precision: "none", reason: "RANGE_PARAGRAPHS_DIFFER", trail: [], edge: "start", drafts: [] };

/**
 * 같은 부모 안 두 문단 `a`·`b`를 끈 응답이 모형과 같은가: 문단 범위(앞 문단 ~ 뒤 문단), 시작 문단 주소, 표 칸이면 `tbl`을 지나옴,
 * 첫 초안은 `range`(지문의 첫·끝 문단 글과 문단 수는 문단 목록에서 직접), 앞 문단이 모형의 제목이면 둘째 초안이 `headingRange`(범위 길이는 모형의 제목 범위), 기본 선택은 `range`.
 * 돌려주는 값: 제목 범위 초안이 있었는가.
 */
function expectSpan(r: LocateResponse, a: readonly number[], b: readonly number[], label: string): boolean {
  const parentPath = a.slice(0, -1);
  const from = Math.min(lastOf(a), lastOf(b));
  const to = Math.max(lastOf(a), lastOf(b));
  const items = fx.lists.get(keyOf(parentPath));
  assert.ok(items !== undefined, `${label}: 모형에 없는 목록 [${keyOf(parentPath)}]`);
  const list = listOf(fx.doc, parentPath);
  assert.equal(r.precision, "paragraph", label);
  assert.deepEqual(r.span, { sectionIndex: 0, parentPath, from, to }, label);
  assert.deepEqual(r.address, { sectionIndex: 0, path: [...parentPath, from] }, label);
  assert.deepEqual([r.reason, r.range, r.edge], [undefined, undefined, "start"], label);
  assert.deepEqual(r.trail, parentPath.length === 0 ? [] : ["tbl"], label);

  const range = r.drafts[0];
  assert.deepEqual(range, { anchor: makeRangeAnchor(fx.doc, 0, parentPath, from, to) }, `${label}: range 초안`);
  assert.ok(range?.anchor.kind === "range");
  assert.deepEqual(
    [range.anchor.at, range.anchor.from, range.anchor.to, range.anchor.print.count, range.anchor.print.first.text, range.anchor.print.last.text],
    [{ sectionIndex: 0, parentPath }, from, to, to - from + 1, list[from]?.logicalText.slice(0, 40), list[to]?.logicalText.slice(0, 40)],
    label,
  );
  const heading = items[from]?.mark !== undefined;
  assert.equal(r.drafts.length, heading ? 2 : 1, `${label}: 초안 수`);
  if (heading) {
    const h = r.drafts[1];
    assert.deepEqual(h, { anchor: makeHeadingRangeAnchor(fx.doc, 0, parentPath, from) }, `${label}: headingRange 초안`);
    assert.ok(h?.anchor.kind === "headingRange");
    const m = rangeOfModel(items, from);
    assert.deepEqual([h.anchor.at, h.anchor.index, h.anchor.print.count], [{ sectionIndex: 0, parentPath }, from, m.to - m.from + 1], label);
  }
  assert.equal(defaultDraftIndex(r.drafts), 0, `${label}: 기본 초안`);
  return heading;
}

/** 초안을 템플릿 앵커로(`id`만 더한다) */
function anchorOf(d: AnchorDraftJson | undefined, id: string): AnchorDraftJson & { id: string } {
  assert.ok(d !== undefined);
  return { ...d, id };
}

test("끌기 초안: 두 문단·열 문단·표 문단·제목에서 시작한 범위·표 칸 안 연속 문단 → range(제목이면 headingRange 둘째), 역순·다른 글자로 끌어도 같다", () => {
  const block = fx.lists.get("")?.findIndex((x) => x.text === "제1장 총칙") ?? -1;
  assert.ok(block > 0);
  const cases: [number[], number[], string][] = [
    [[17], [18], "두 문단(제목에서 시작)"],
    [[18], [27], "열 문단(본문에서 시작, 끝이 제목)"],
    [[12], [16], "표를 담은 문단에서 시작"],
    [[block], [block + 5], "조문 장 제목에서 시작"],
    [[12, 1, 1], [12, 1, 4], "칸 안 문단 넷"],
    [[12, 1, 6], [12, 1, 9], "칸 안 제목에서 시작"],
    [[79, 1, 0], [79, 1, 15], "복사본 칸 전체"],
  ];
  let headings = 0;
  for (const [a, b, label] of cases) {
    const r = drag(pointAt(a), pointAt(b));
    if (expectSpan(r, a, b, label)) headings++;
    assert.deepEqual(drag(pointAt(b, 1), pointAt(a, 1)), r, `${label}: 역순·다른 글자`);
  }
  assert.equal(headings, 3, "제목에서 시작한 경우: 17, 제1장, 칸 6");
});

test("끌기 초안: 부모가 다르면(최상위 ↔ 칸, 같은 표의 다른 칸, 다른 표의 칸, 표 문단 ↔ 그 칸) none·RANGE_PARAGRAPHS_DIFFER", () => {
  const pairs: [number[], number[]][] = [
    [[17], [12, 1, 3]],
    [[12, 1, 2], [12, 0, 0]],
    [[12, 1, 2], [79, 1, 2]],
    [[12], [12, 1, 0]],
    [[100], [100, 1, 0]],
  ];
  for (const [a, b] of pairs) {
    assert.deepEqual(drag(pointAt(a), pointAt(b)), differ, `[${keyOf(a)}] → [${keyOf(b)}]`);
    assert.deepEqual(drag(pointAt(b), pointAt(a)), differ, `[${keyOf(b)}] → [${keyOf(a)}]`);
  }
});

test("끌기 초안: 한 끝이 none이면 그 끝의 결과(기존 규칙), 같은 문단 안 끌기는 그대로 word 범위", () => {
  const missing: LocatePoint = { position: { sectionIndex: 0, paragraphIndex: 999, charOffset: 0 } };
  const noSection: LocatePoint = { position: { sectionIndex: 3, paragraphIndex: 0, charOffset: 0 } };
  const good = pointAt([17]);
  const other = pointAt([18]);
  const foreign: LocatePoint = { ...other, shown: { text: "문서에 없는 글", start: other.shown?.start ?? 0 } };
  const none = (reason: string): LocateResponse => ({ precision: "none", reason, trail: [], edge: "start", drafts: [] });
  assert.deepEqual(drag(good, missing), none("PARAGRAPH_NOT_FOUND"));
  assert.deepEqual(drag(missing, good), none("PARAGRAPH_NOT_FOUND"));
  assert.deepEqual(drag(noSection, good), none("SECTION_NOT_FOUND"));
  assert.deepEqual(drag(good, foreign), none("PARAGRAPH_MISMATCH"));
  assert.deepEqual(drag(foreign, pointAt([12, 1, 3])), none("PARAGRAPH_MISMATCH"), "부모가 다른 끝이어도 문단을 못 찾은 끝이 먼저");

  // 같은 문단 안: 글자 범위와 word 초안(문단 범위·range 초안 없음)
  const start = fx.points.get("18")?.find((p) => p.shown?.start === 0);
  assert.ok(start?.position !== undefined);
  const same = drag(start, { ...start, position: { ...start.position, charOffset: 4 } });
  assert.deepEqual([same.precision, same.range, same.span, same.address], ["char", { start: 0, end: 4 }, undefined, { sectionIndex: 0, path: [18], offset: 0 }]);
  const word = same.drafts[0]?.anchor;
  assert.ok(word?.kind === "word");
  assert.deepEqual([word.at, word.start, word.end, word.print.text], [{ sectionIndex: 0, path: [18] }, 0, 4, "1-1."]);
  assert.equal(same.drafts.some((d) => d.anchor.kind === "range" || d.anchor.kind === "headingRange"), false);
  assert.equal(defaultDraftIndex(same.drafts), 0);
});

test("끌기 초안: 1판 inject replace·delete에 넣어 생성 → makeRangeAnchor·makeHeadingRangeAnchor로 만든 앵커와 바이트 동일, 범위만 바뀐다", () => {
  const frag = fragOf(fx.doc, 1, 3);
  const fragTexts = texts(listOf(fx.doc, []).slice(1, 4));
  const empty = readDataset({});
  const cases: { a: number[]; b: number[]; kind: "range" | "headingRange"; rule: "replace" | "delete" }[] = [
    { a: [27], b: [18], kind: "range", rule: "replace" },
    { a: [12, 1, 1], b: [12, 1, 4], kind: "range", rule: "delete" },
    { a: [17], b: [18], kind: "headingRange", rule: "delete" },
    { a: [12, 1, 6], b: [12, 1, 7], kind: "headingRange", rule: "replace" },
  ];
  for (const c of cases) {
    const label = `${c.kind} ${c.rule} [${keyOf(c.a)}]~[${keyOf(c.b)}]`;
    const parentPath = c.a.slice(0, -1);
    const from = Math.min(lastOf(c.a), lastOf(c.b));
    const dragged = Math.max(lastOf(c.a), lastOf(c.b));
    const draft = drag(pointAt(c.a), pointAt(c.b)).drafts.find((d) => d.anchor.kind === c.kind)?.anchor;
    const direct = c.kind === "range" ? makeRangeAnchor(fx.doc, 0, parentPath, from, dragged) : makeHeadingRangeAnchor(fx.doc, 0, parentPath, from);
    assert.ok(draft !== undefined && direct !== undefined, label);
    const rule = c.rule === "replace" ? inject("x", "a", frag) : del("x", "a");
    const viaDraft = done(generate(fx.bytes, tpl([anchorOf(draft, "a")], [rule]), empty, KEEP));
    const viaEngine = done(generate(fx.bytes, tpl([{ ...direct, id: "a" }], [rule]), empty, KEEP));
    assert.ok(bytesEqual(viaDraft.output, viaEngine.output), `${label}: 바이트가 다르다`);
    gateClean(fx.bytes, viaDraft);
    // 결과: 범위(range는 끈 문단들, headingRange는 모형의 제목 범위)만 빠지거나 조각 문단으로 바뀐다
    const to = c.kind === "range" ? dragged : rangeOfModel(fx.lists.get(keyOf(parentPath)) ?? [], from).to;
    const before = texts(listOf(fx.doc, parentPath));
    const after = texts(listOf(reparse(viaDraft.output), parentPath));
    assert.deepEqual(after, [...before.slice(0, from), ...(c.rule === "replace" ? fragTexts : []), ...before.slice(to + 1)], label);
  }
});

test("끌기 초안: 2판 redraftAnchor — 옛 range 앵커 자리에 끌기 초안을 넣으면 같은 id의 새 범위(exact), 제목 범위 초안이면 종류가 바뀐다", () => {
  const made = makeRangeAnchor(fx.doc, 0, [], 30, 33);
  assert.ok(made !== undefined);
  const old: StudioAnchor = { id: "공고 범위", ...made };
  const draft = drag(pointAt([18]), pointAt([27])).drafts[0]?.anchor;
  assert.ok(draft !== undefined);
  const re = redraftAnchor(fx.doc, old, draft);
  assert.deepEqual(re, { anchor: { id: "공고 범위", ...makeRangeAnchor(fx.doc, 0, [], 18, 27) }, kindChanged: false });
  assert.deepEqual(checkAnchors(fx.doc, { anchors: [re.anchor] }).map((x) => x.state), ["exact"]);

  const heading = drag(pointAt([12, 1, 6]), pointAt([12, 1, 8])).drafts[1]?.anchor;
  assert.ok(heading?.kind === "headingRange");
  const hr = redraftAnchor(fx.doc, old, heading);
  assert.deepEqual(hr, { anchor: { id: "공고 범위", ...makeHeadingRangeAnchor(fx.doc, 0, [12, 1], 6) }, kindChanged: true });
  assert.deepEqual(checkAnchors(fx.doc, { anchors: [hr.anchor] }).map((x) => x.state), ["exact"]);
});

test("끌기 초안: 무작위 60회(시드 고정) — 같은 부모면 range(·headingRange), 아니면 none. 다시 불러도·역순이어도 같고, 초안으로 생성하면 게이트·검사기 새 오류 0", (t) => {
  const next = rng(53);
  const pick = <T>(list: readonly T[]): T => {
    const v = list[Math.floor(next() * list.length)];
    assert.ok(v !== undefined);
    return v;
  };
  const keys = [...fx.points.keys()];
  const frag = fragOf(fx.doc, 1, 3);
  const counts = { range: 0, heading: 0, differ: 0, cells: 0, generated: 0 };
  for (let n = 0; n < 60; n++) {
    let a: number[];
    let b: number[];
    if (next() < 0.6) {
      // 같은 목록(최상위·칸 [12,1]·복사본 칸 [79,1])의 다른 두 문단
      const parent = pick(["", "", "12,1", "79,1"]);
      const prefix = parent === "" ? [] : parent.split(",").map(Number);
      const size = listOf(fx.doc, prefix).length;
      const i = Math.floor(next() * size);
      const j = (i + 1 + Math.floor(next() * (size - 1))) % size;
      a = [...prefix, i];
      b = [...prefix, j];
    } else {
      // 문서 전체에서 다른 두 문단
      const i = pick(keys);
      let j = pick(keys);
      while (j === i) j = pick(keys);
      a = i.split(",").map(Number);
      b = j.split(",").map(Number);
    }
    const label = `${n}: [${keyOf(a)}] → [${keyOf(b)}]`;
    const from = pick(fx.points.get(keyOf(a)) ?? []);
    const to = pick(fx.points.get(keyOf(b)) ?? []);
    const r = drag(from, to);
    assert.deepEqual(drag(from, to), r, `${label}: 결정성`);
    assert.deepEqual(drag(to, from), r, `${label}: 역순`);
    if (keyOf(a.slice(0, -1)) !== keyOf(b.slice(0, -1))) {
      assert.deepEqual(r, differ, label);
      counts.differ++;
      continue;
    }
    counts.range++;
    if (a.length > 1) counts.cells++;
    if (expectSpan(r, a, b, label)) counts.heading++;
    // 구역 설정 문단(최상위 0)을 덮는 범위는 엔진이 거절한다(FILL_SECTION_PROPS): 생성은 그 밖의 범위만
    const span = r.span;
    assert.ok(span !== undefined);
    if (span.parentPath.length === 0 && span.from === 0) continue;
    const data = readDataset(dataFor(fx.doc, () => longValue(next, 200, 600)));
    const draft = pick(r.drafts).anchor;
    // 칸의 문단 전부를 지우면 칸이 비므로(FILL_LAST_PARAGRAPH) 그때는 바꾼다
    const whole = span.parentPath.length > 0 && span.from === 0 && span.to === listOf(fx.doc, span.parentPath).length - 1;
    const rule = whole || next() < 0.5 ? inject("x", "a", frag) : del("x", "a");
    const out = done(generate(fx.bytes, tpl([anchorOf(draft, "a")], [rule]), data, KEEP));
    gateClean(fx.bytes, out);
    counts.generated++;
  }
  t.diagnostic(JSON.stringify(counts));
  assert.ok(counts.range >= 25 && counts.differ >= 10 && counts.heading >= 3 && counts.cells >= 5 && counts.generated >= 20, JSON.stringify(counts));
});
