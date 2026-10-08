// 블록 저장소 후속(이슈 #99, 엔진 명세 8.8.10·8.8.17, 검증 기준 32절):
// D3 원형 시각의 달력 검사, D5 원본에 없는 자원을 가리키는 블록 문단의 서식 비교(넣은 뒤 대상에서 풀리는 자원과 견줌), D8 범위 지문 오류가 겹칠 때 먼저 나는 오류.
// D5의 기대값은 계획을 실제로 적용한 결과 문서에서 넣은 문단과 자리 문단의 자원 지문을 견준 것이다(엔진의 비교 함수와 따로 계산).
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPlan, fingerprintResource, HwpxError, makeLookup, rewriteArchive, type HwpxDocument } from "../src/index.ts";
import { blockFormatDiffs, extractBlock, makeRangeAnchor, planBlockInsert, type ExtractedBlock } from "../src/fill/index.ts";
import { parseFragmentXml } from "../src/fill/fragment-fill.ts";
import { readBlockProto, writeBlockProto } from "../src/template/index.ts";
import { readFixture, reparse, utf8 } from "./helpers.ts";
import { at, rng } from "./range-helpers.ts";

const AT = "2026-10-07T09:30:00Z";
const meta = (at = AT) => ({ id: "k0000c099", name: "후속 시험", at });

const failure = (f: () => unknown): HwpxError => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아니다: ${String(e)}`);
    return e;
  }
  assert.fail("던지지 않았다");
};

// ── D3: 시각의 달력 검사 ───────────────────────────────────────

test("8.8.17 D3: 원형 시각은 달력에 있는 날짜·시각만 받는다(2월 30일·4월 31일·평년 2월 29일·24:00 거절 → TPL_FIELD), 윤년 2월 29일·밀리초는 받는다", () => {
  const doc = reparse(readFixture("D2"));
  const range = makeRangeAnchor(doc, 0, [], 1, 3);
  assert.ok(range !== undefined);
  const base = JSON.parse(writeBlockProto(extractBlock(doc, range, meta()).proto)) as Record<string, any>;
  const withTime = (where: "extractedAt" | "history", v: string): string => {
    const p = structuredClone(base);
    if (where === "extractedAt") p["source"].extractedAt = v;
    else p["history"][0].at = v;
    return JSON.stringify(p);
  };
  const bad = ["2026-02-30T00:00:00Z", "2026-04-31T12:00:00Z", "2026-06-31T00:00:00Z", "2026-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-10-06T24:00:00Z", "2026-10-06T24:00:00.000Z", "2026-13-01T00:00:00Z", "2026-10-06T23:60:00Z"];
  for (const v of bad) {
    for (const where of ["extractedAt", "history"] as const) {
      const e = failure(() => readBlockProto(withTime(where, v)));
      assert.equal(e.code, "TPL_FIELD", `${where} ${v}`);
      assert.ok(e.where?.startsWith("block-proto"), `${where} ${v}: ${e.where}`);
    }
    assert.equal(failure(() => extractBlock(doc, range, meta(v))).code, "TPL_FIELD", `extractBlock ${v}`);
  }
  const good = ["2024-02-29T23:59:59.999Z", "2000-02-29T00:00:00Z", "2026-12-31T23:59:59Z", "2026-10-06T00:00:00.5Z", "2026-04-30T09:30:00.12Z", "0001-01-01T00:00:00Z"];
  for (const v of good) {
    for (const where of ["extractedAt", "history"] as const) {
      const p = readBlockProto(withTime(where, v));
      assert.equal(where === "extractedAt" ? p.source?.extractedAt : p.history?.[0]?.at, v, `${where} ${v}`);
    }
  }
});

// ── D8: 범위 지문 오류가 겹칠 때 ─────────────────────────────────

test("8.8.10 D8: 원형 출처의 지문 형식 오류와 문단 수 불일치가 겹치면 지문 형식 오류가 먼저다(where = …print.first). 불일치만이면 출처 위치", () => {
  const doc = reparse(readFixture("D2"));
  const base = JSON.parse(writeBlockProto(extractBlock(doc, makeRangeAnchor(doc, 0, [], 1, 3)!, meta()).proto)) as Record<string, any>;
  const P = (edit: (p: Record<string, any>) => void): string => {
    const p = structuredClone(base);
    edit(p);
    return JSON.stringify(p);
  };
  const both = failure(() => readBlockProto(P((p) => ((p["source"].print.count = 5), (p["source"].print.first.sha256 = "abc")))));
  const only = failure(() => readBlockProto(P((p) => (p["source"].print.count = 5))));
  assert.equal(both.code, "TPL_FIELD");
  assert.equal(only.code, "TPL_FIELD");
  assert.ok(both.where?.endsWith("source.print.first"), `겹침: ${both.where}`);
  assert.ok(only.where?.endsWith("source") && !only.message.includes("sha256"), `불일치만: ${only.where}`);
  assert.match(only.message, /print\.count\(5\)/);
});

// ── D5: 원본에 없는 자원을 가리키는 블록 문단의 서식 비교 ─────────────────

type Edit = [paragraph: number, attr: "paraPrIDRef" | "styleIDRef", value: string];

/** 구역 0 최상위 문단들의 문단 모양·스타일 참조를 바꾼 사본(시험 자료는 그대로) */
function withRefs(bytes: Uint8Array, edits: readonly Edit[]): Uint8Array {
  const doc = reparse(bytes);
  const s = at(doc.sections, 0);
  let text = s.text;
  const byPara = new Map<number, Edit[]>();
  for (const e of edits) byPara.set(e[0], [...(byPara.get(e[0]) ?? []), e]);
  for (const i of [...byPara.keys()].sort((a, b) => b - a)) {
    const el = at(s.paragraphs, i).element;
    let open = text.slice(el.start, el.openEnd);
    for (const [, attr, value] of byPara.get(i) ?? []) {
      const next = open.replace(new RegExp(`\\b${attr}="[^"]*"`), `${attr}="${value}"`);
      assert.notEqual(next, open, `문단 ${i}에 ${attr}가 없다`);
      open = next;
    }
    text = text.slice(0, el.start) + open + text.slice(el.openEnd);
  }
  return rewriteArchive(bytes, doc.pkg.archive, { replace: new Map([[s.entryName, utf8(text)]]) });
}

const PROPS = [["paraPr", "paraPrIDRef"], ["style", "styleIDRef"]] as const;

function printIn(doc: HwpxDocument): (kind: string, id: string | null) => string {
  const lookup = makeLookup(doc);
  return (kind, id) => {
    if (id === null) return "none";
    const item = lookup.resource(kind, undefined, id);
    return item === undefined ? `missing:${id}` : fingerprintResource(item, lookup);
  };
}

/** 실제 차이: 계획을 적용한 결과 문서에서 넣은 문단(자리 뒤 n개)과 자리 문단의 문단 모양·스타일 지문을 견준다 */
function actualDiffs(target: HwpxDocument, plan: Parameters<typeof applyPlan>[1], index: number, n: number): string[] {
  const out = reparse(applyPlan(target.pkg, plan));
  const print = printIn(out);
  const list = at(out.sections, 0).paragraphs;
  const spot = at(list, index);
  const diffs: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = at(list, index + 1 + i);
    for (const [kind, attr] of PROPS) if (print(kind, p.attrs[attr]) !== print(kind, spot.attrs[attr])) diffs.push(`${i}:${kind}`);
  }
  return diffs;
}

/** 고치기 전 규칙(블록 쪽 없는 자원은 언제나 `missing:<id>`)으로 낸 차이. 이 시험이 D5의 경우를 실제로 담는지 세는 데만 쓴다 */
function oldRuleDiffs(target: HwpxDocument, block: ExtractedBlock, index: number): string[] {
  const own = new Map(block.fragment.resources.map((r) => [`${r.kind}|${r.id}`, r.fingerprint]));
  const want = printIn(target);
  const spot = at(at(target.sections, 0).paragraphs, index);
  const diffs: string[] = [];
  parseFragmentXml(block.fragment).paragraphs.forEach((p, i) => {
    for (const [kind, attr] of PROPS) {
      const id = p.attrs[attr];
      const mine = id === null ? "none" : (own.get(`${kind}|${id}`) ?? `missing:${id}`);
      if (mine !== want(kind, spot.attrs[attr])) diffs.push(`${i}:${kind}`);
    }
  });
  return diffs;
}

const pairs = (diffs: readonly { paragraph: number; property: string }[]): string[] => diffs.map((d) => `${d.paragraph}:${d.property}`);
const maxId = (doc: HwpxDocument, kind: string): number => Math.max(-1, ...(doc.header.resources[kind] ?? []).map((r) => Number(r.id)).filter(Number.isInteger));
const hasId = (doc: HwpxDocument, kind: string, id: string): boolean => (doc.header.resources[kind] ?? []).some((r) => r.id === id);

/** 넣기 수, 견준 (문단, 속성) 수와 그 가운데 실제로 다른 것, 고치기 전 규칙이 낸 거짓 차이·놓친 차이 수 */
type Tally = { cases: number; compared: number; differ: number; falseBefore: number; missedBefore: number; danglingParas: number };

/** 블록을 대상의 한 자리 뒤에 넣는 계획의 서식 차이 = 적용한 결과의 실제 차이. 고치기 전 규칙과 다르면 센다 */
function compare(target: HwpxDocument, block: ExtractedBlock, index: number, tally: Tally, label: string): void {
  const n = parseFragmentXml(block.fragment).paragraphs.length;
  const plan = planBlockInsert(target, block.proto, block.blob, { sectionIndex: 0, parentPath: [], index, position: "after" });
  const got = pairs(plan.formatDiffs);
  const truth = actualDiffs(target, plan, index, n);
  assert.deepEqual(got, truth, `${label}: 거짓 경고·놓친 경고`);
  assert.deepEqual(pairs(blockFormatDiffs(target, block.fragment, { sectionIndex: 0, parentPath: [], index })), got, `${label}: blockFormatDiffs`);
  assert.equal(plan.issues.filter((i) => i.code === "BLOCK_FORMAT_DIFFERS").length, truth.length > 0 ? 1 : 0, `${label}: 경고 수`);
  const old = oldRuleDiffs(target, block, index);
  tally.cases++;
  tally.compared += n * PROPS.length;
  tally.differ += truth.length;
  tally.falseBefore += old.filter((d) => !truth.includes(d)).length;
  tally.missedBefore += truth.filter((d) => !old.includes(d)).length;
}

test("8.8.17 D5: 원본에 없는 자원을 가리키는 블록(D1→D2)의 서식 비교 = 넣은 결과의 실제 차이(거짓 경고 0·놓친 경고 0). 자원 안 참조(문단 모양 → 탭)와 문단의 참조 둘 다", (t) => {
  const d1 = readFixture("D1");
  const src0 = reparse(d1);
  const d2 = reparse(readFixture("D2"));
  // D1에는 탭 목록이 없는데 문단 모양들이 탭 0을 가리킨다(자원 안의 없는 참조). D2에는 탭 0이 있다
  assert.equal((src0.header.resources["tabPr"] ?? []).length, 0);
  assert.ok(hasId(d2, "tabPr", "0"));
  // 문단의 없는 참조: 문단 1은 D2 본문이 쓰는 문단 모양, 문단 2는 D2에 있는 스타일 3, 문단 3은 D2에도 없는 문단 모양.
  // 대상의 다음 새 id는 여기서 쓰지 않는다(그 경우는 아래 #115 시험이 본다)
  const shared = at(d2.sections, 0).paragraphs.map((p) => p.attrs.paraPrIDRef).find((id): id is string => id !== null && !hasId(src0, "paraPr", id));
  assert.ok(shared !== undefined && hasId(d2, "style", "3") && !hasId(src0, "style", "3"));
  const absentPara = String(maxId(d2, "paraPr") + 100);
  const src1 = reparse(withRefs(d1, [[1, "paraPrIDRef", shared], [2, "styleIDRef", "3"], [3, "paraPrIDRef", absentPara]]));
  const blocks: [string, ExtractedBlock][] = [
    ...[1, 4, 7, 10].map((from): [string, ExtractedBlock] => [`D1 ${from}~${from + 2}`, extractBlock(src0, makeRangeAnchor(src0, 0, [], from, from + 2)!, meta())]),
    ["D1 1~3 문단 참조 바꿈", extractBlock(src1, makeRangeAnchor(src1, 0, [], 1, 3)!, meta())],
  ];
  for (const [label, b] of blocks) {
    assert.ok(b.fragment.dangling.some((d) => d.kind === "tabPr" && d.id === "0"), `${label}: 탭 0`);
    assert.ok(b.issues.some((i) => i.code === "FRAG_DANGLING_SOURCE"), label);
  }
  assert.deepEqual(at(blocks, 4)[1].fragment.dangling.map((d) => `${d.kind} ${d.id}`).sort(), [`paraPr ${absentPara}`, `paraPr ${shared}`, "style 3", "tabPr 0"].sort());
  // 대상: D2 그대로와, 본문 몇 곳이 스타일 3을 쓰게 바꾼 D2
  const targets: [string, HwpxDocument][] = [["D2", d2], ["D2 스타일 3", reparse(withRefs(readFixture("D2"), [[2, "styleIDRef", "3"], [5, "styleIDRef", "3"], [9, "styleIDRef", "3"]]))]];
  const tally: Tally = { cases: 0, compared: 0, differ: 0, falseBefore: 0, missedBefore: 0, danglingParas: 3 };
  for (const [tl, target] of targets) {
    for (const [bl, b] of blocks) at(target.sections, 0).paragraphs.forEach((_, j) => compare(target, b, j, tally, `${bl} → ${tl} 자리 ${j}`));
  }
  t.diagnostic(`넣기 ${tally.cases}, 견준 (문단, 속성) ${tally.compared}, 실제로 다름 ${tally.differ}, 고치기 전 규칙의 거짓 차이 ${tally.falseBefore}·놓친 차이 ${tally.missedBefore}`);
  assert.ok(tally.falseBefore > 0, "고치기 전 규칙이 거짓 차이를 내는 자리가 있다(D5 재현)");
  assert.ok(tally.differ > 0 && tally.differ < tally.compared, "같은 것과 다른 것이 다 있다");
});

test("8.8.17 D5 무작위 60회(시드 99): 합성 문서 7개·한컴 저장본에서 뗀 블록 문단에 없는 자원 참조를 넣고 다른 문서에 넣기 → 서식 비교 = 실제 차이", (t) => {
  const names = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "hancom-merged"];
  const docs = new Map(names.map((n) => [n, reparse(readFixture(n))]));
  const next = rng(99);
  const pick = <T>(list: readonly T[]): T => at(list, Math.floor(next() * list.length));
  const tally: Tally = { cases: 0, compared: 0, differ: 0, falseBefore: 0, missedBefore: 0, danglingParas: 0 };
  let runs = 0;
  let tries = 0;
  while (runs < 60) {
    assert.ok(++tries < 600, "뗄 수 있는 범위를 찾지 못했다");
    const srcName = pick(names);
    const targetName = pick(names.filter((n) => n !== srcName));
    const target = docs.get(targetName)!;
    const src0 = docs.get(srcName)!;
    const list = at(src0.sections, 0).paragraphs;
    if (list.length < 3) continue;
    const from = 1 + Math.floor(next() * (list.length - 1));
    const to = Math.min(list.length - 1, from + Math.floor(next() * 4));
    // 범위 안 문단 1~2개에 원본에 없는 id를 넣는다: 대상 본문이 쓰는 id(대상에 있음), 대상에 있는 다른 id, 대상에도 없는 id(새 자원이 받을 수 있는 id는 피한다)
    const edits: Edit[] = [];
    for (let i = from; i <= to; i++) {
      if (edits.length >= 2 || next() < 0.4) continue;
      const [kind, attr] = pick(PROPS);
      const used = at(target.sections, 0).paragraphs.map((p) => p.attrs[attr]).filter((id): id is string => id !== null && !hasId(src0, kind, id));
      const r = next();
      const present = (target.header.resources[kind] ?? []).map((x) => x.id).filter((x) => !hasId(src0, kind, x));
      const id = r < 0.6 && used.length > 0 ? pick(used) : r < 0.8 && present.length > 0 ? pick(present) : String(Math.max(maxId(target, kind), maxId(src0, kind)) + 100);
      if (hasId(src0, kind, id)) continue;
      edits.push([i, attr, id]);
    }
    if (edits.length === 0) continue;
    let block: ExtractedBlock;
    try {
      const src = reparse(withRefs(readFixture(srcName), edits));
      block = extractBlock(src, makeRangeAnchor(src, 0, [], from, to)!, meta());
    } catch (e) {
      if (e instanceof HwpxError) continue; // 구역 설정·누름틀 자름 등 뗄 수 없는 범위
      throw e;
    }
    assert.ok(block.fragment.dangling.length > 0, `${srcName} ${from}~${to}`);
    tally.danglingParas += edits.length;
    // 자리는 넣은 id를 쓰는 대상 문단을 자주 고른다(넣은 뒤 같은 모양이 되는 경우를 담으려고)
    const spots = at(target.sections, 0).paragraphs.flatMap((p, j) => (edits.some(([, attr, id]) => p.attrs[attr] === id) ? [j] : []));
    const index = spots.length > 0 && next() < 0.7 ? pick(spots) : Math.floor(next() * at(target.sections, 0).paragraphs.length);
    compare(target, block, index, tally, `${runs} ${srcName} ${from}~${to} ${JSON.stringify(edits)} → ${targetName} 자리 ${index}`);
    runs++;
  }
  t.diagnostic(`넣기 ${tally.cases}, 넣은 없는 참조 ${tally.danglingParas}, 견준 (문단, 속성) ${tally.compared}, 실제로 다름 ${tally.differ}, 고치기 전 규칙의 거짓 차이 ${tally.falseBefore}·놓친 차이 ${tally.missedBefore}`);
  assert.ok(tally.falseBefore > 0, "고치기 전 규칙의 거짓 차이 경우가 들어 있다");
  assert.ok(tally.differ > 0 && tally.differ < tally.compared, "같은 것과 다른 것이 다 있다");
});

test("8.8.17 #115: 블록 문단이 원본에도 대상에도 없는 id를 가리키고 그 id가 대상의 다음 새 id(가져오기가 새 자원에 줄 id)여도 서식 비교 = 넣은 결과의 실제 차이, 블록 쪽 지문 = 넣은 문단의 실제 지문", (t) => {
  const d1 = readFixture("D1");
  const src0 = reparse(d1);
  const d2 = reparse(readFixture("D2"));
  // D1 1~3을 D2에 넣으면 새 문단 모양·스타일이 들어온다. 블록 문단이 D2의 다음 새 문단 모양·스타일 id(원본에도 없다)를 가리키게 바꾼다
  const nextPara = String(maxId(d2, "paraPr") + 1);
  const nextStyle = String(maxId(d2, "style") + 1);
  assert.ok(!hasId(src0, "paraPr", nextPara) && !hasId(src0, "style", nextStyle));
  const src = reparse(withRefs(d1, [[1, "paraPrIDRef", nextPara], [2, "styleIDRef", nextStyle], [3, "paraPrIDRef", nextPara]]));
  const block = extractBlock(src, makeRangeAnchor(src, 0, [], 1, 3)!, meta());
  assert.deepEqual(block.fragment.dangling.map((d) => `${d.kind} ${d.id}`).sort(), [`paraPr ${nextPara}`, `style ${nextStyle}`, "tabPr 0"].sort());
  const tally: Tally = { cases: 0, compared: 0, differ: 0, falseBefore: 0, missedBefore: 0, danglingParas: 3 };
  at(d2.sections, 0).paragraphs.forEach((_, j) => compare(d2, block, j, tally, `D1 1~3 다음 새 id → D2 자리 ${j}`));
  // 넣은 결과: 새 문단 모양·스타일이 들어오되 그 id는 건너뛰어, 블록 문단의 없는 참조는 넣은 뒤에도 없다
  const plan = planBlockInsert(d2, block.proto, block.blob, { sectionIndex: 0, parentPath: [], index: 0, position: "after" });
  const out = reparse(applyPlan(d2.pkg, plan));
  const added = (kind: string): string[] => (out.header.resources[kind] ?? []).flatMap((r) => (hasId(d2, kind, r.id) ? [] : [r.id]));
  assert.ok(added("paraPr").length > 0 && added("style").length > 0, `새 자원 ${added("paraPr")} / ${added("style")}`);
  assert.ok(!hasId(out, "paraPr", nextPara) && !hasId(out, "style", nextStyle), "블록의 없는 id를 새 자원이 받지 않는다");
  // 블록 쪽 지문(formatDiffs의 block) = 넣은 결과에서 넣은 문단이 가리키는 자원의 지문(없으면 missing:<id>)
  const print = printIn(out);
  const list = at(out.sections, 0).paragraphs;
  assert.ok(plan.formatDiffs.length > 0);
  for (const d of plan.formatDiffs) {
    const attr = d.property === "paraPr" ? "paraPrIDRef" : "styleIDRef";
    assert.equal(d.block, print(d.property, at(list, 1 + d.paragraph).attrs[attr]), `문단 ${d.paragraph} ${d.property}`);
  }
  assert.ok(plan.formatDiffs.some((d) => d.block === `missing:${nextPara}`) && plan.formatDiffs.some((d) => d.block === `missing:${nextStyle}`));
  t.diagnostic(`넣기 ${tally.cases}, 견준 (문단, 속성) ${tally.compared}, 실제로 다름 ${tally.differ}, 새 문단 모양 ${added("paraPr").join(",")}·스타일 ${added("style").join(",")}`);
});
