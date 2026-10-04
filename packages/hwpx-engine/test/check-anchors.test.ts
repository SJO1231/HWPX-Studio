// 원본 변경 감지와 재지정(8.8.13, 수용 조건 8.8.16 W7): checkAnchors의 상태 6종, planRelocation 일괄 갱신, redraftAnchor 재지정.
// 기대값은 명세의 판정 규칙(8.2의 word·line 지문, 7.10의 range·cell·object 지문, 8.8.13의 상태표)을 변경 기록 모형(어느 문단을 넣고·지우고·
// 복제하고·바꿨는지)에 적용해 세운다. checkAnchors·resolveAnchors의 출력을 기대값으로 옮겨 적지 않는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HwpxError } from "../src/errors.ts";
import {
  isTableNode,
  listFields,
  readStudioTemplate,
  readTemplate,
  writeStudioTemplate,
  type HwpxDocument,
  type ParagraphNode,
  type StudioAnchor,
  type StudioTemplate,
  type Template,
} from "../src/index.ts";
import {
  checkAnchors,
  draftAnchors,
  generate,
  makeCellAnchor,
  makeObjectAnchor,
  makeRangeAnchor,
  makeWordAnchor,
  planRelocation,
  redraftAnchor,
  type AnchorAddress,
  type AnchorCheck,
  type AnchorCheckState,
  type RedraftInput,
} from "../src/fill/index.ts";
import { readFixture, reparse } from "./helpers.ts";
import { HEADINGS, KEEP, at, del, done, ds, failed, fragOf, inject, insertText, line, notice, range, rng, top, tpl } from "./range-helpers.ts";

// ── 시험 원본 ──────────────────────────────────────────────────

let baseBytes: Uint8Array | undefined;
/**
 * 합성 공고서(7.10의 시험 문서)에서 사본 표 둘(서수 2·3)의 마지막 행을 지워 표 4개의 모양을 모두 다르게 한 것.
 * 최상위 63문단, 표 4개: [12] 6×3, [15] 4×2, [58] 5×3, [61] 3×2.
 */
function base(): Uint8Array {
  if (baseBytes !== undefined) return baseBytes;
  const cell = (id: string, ordinal: number, row: number) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal }, row, col: 0 });
  const rowDel = (id: string, anchor: string) => ({ id, do: { type: "delete", anchor, scope: "row" } });
  baseBytes = done(generate(notice(), tpl([cell("a", 2, 5), cell("b", 3, 3)], [rowDel("x", "a"), rowDel("y", "b")]), ds({}), KEEP)).output;
  return baseBytes;
}
const TABLE_LIBS = ["b12", "b15", "b58", "b61"];

let tableFrag: Record<string, unknown> | undefined;
/** 앞에 넣을 다른 표: `tables/tables-merged`의 4×3 병합 표 문단 */
const otherTable = (): Record<string, unknown> => (tableFrag ??= fragOf(reparse(readFixture("tables/tables-merged")), 1, 1));

// ── 변경 기록 모형 ─────────────────────────────────────────────

/** 알려진 문단(원본 문단 `b<i>`와 다른 표 문단 `x`)의 글, 하위 목록의 글, 필드 키, 표 칸 주소 */
type Lib = { text: string; lists: { rel: number[]; texts: string[] }[]; fields: string[]; cells?: Set<string>; plain: boolean };

const fieldKey = (f: { name: string; mergeKey?: string }): string => (f.mergeKey === undefined ? `n:${f.name}` : `m:${f.mergeKey}`);

function listsUnder(p: ParagraphNode, rel: number[]): { rel: number[]; texts: string[] }[] {
  return p.subLists.flatMap((sub, k) => [
    { rel: [...rel, k], texts: sub.paragraphs.map((q) => q.logicalText) },
    ...sub.paragraphs.flatMap((q, j) => listsUnder(q, [...rel, k, j])),
  ]);
}

function libOf(p: ParagraphNode, fields: string[]): Lib {
  const table = p.objects.find(isTableNode);
  const out: Lib = { text: p.logicalText, lists: listsUnder(p, []), fields, plain: p.objects.length === 0 };
  if (table !== undefined) out.cells = new Set(table.cells.map((c) => `${c.row},${c.col}`));
  return out;
}

let libCache: Map<string, Lib> | undefined;
function lib(): Map<string, Lib> {
  if (libCache !== undefined) return libCache;
  const doc = reparse(base());
  const byTop = new Map<number, string[]>();
  for (const f of listFields(doc)) {
    assert.equal(f.sectionIndex, 0);
    const i = at(f.path, 0);
    byTop.set(i, [...(byTop.get(i) ?? []), fieldKey(f)]);
  }
  const m = new Map<string, Lib>();
  top(doc).forEach((p, i) => m.set(`b${i}`, libOf(p, byTop.get(i) ?? [])));
  m.set("x", libOf(at(top(reparse(readFixture("tables/tables-merged"))), 1), []));
  return (libCache = m);
}
function libAt(key: string): Lib {
  const l = lib().get(key);
  assert.ok(l !== undefined, key);
  return l;
}

/** 최상위 문단 하나: 알려진 문단(원본·사본)이면 `lib`, 새로 넣었거나 글을 바꾼 문단이면 글만 */
type Item = { lib?: string; text: string };
const model0 = (): Item[] => top(reparse(base())).map((p, i) => ({ lib: `b${i}`, text: p.logicalText }));

type Op =
  | { t: "insert"; after: number; text: string }
  | { t: "table"; after: number }
  | { t: "delete"; at: number }
  | { t: "dup"; from: number; to: number; after: number }
  | { t: "change"; at: number; text: string; start?: number; end?: number };

type State = { bytes: Uint8Array; M: Item[] };

/** 변경 하나를 문서(엔진의 insertText·inject·delete·fill)와 모형에 함께 적용한다. 모형의 최상위 글과 표 수가 문서와 같은지도 본다. */
function apply(s: State, op: Op): State {
  const doc = reparse(s.bytes);
  const m = s.M.slice();
  let t: Template;
  switch (op.t) {
    case "insert":
      t = tpl([line(doc, "p", [op.after])], [insertText("x", "p", op.text, "after")]);
      m.splice(op.after + 1, 0, ...op.text.split("\n").map((text) => ({ text })));
      break;
    case "table":
      t = tpl([line(doc, "p", [op.after])], [inject("x", "p", otherTable(), "after")]);
      m.splice(op.after + 1, 0, { lib: "x", text: libAt("x").text });
      break;
    case "delete":
      t = tpl([line(doc, "p", [op.at])], [del("x", "p")]);
      m.splice(op.at, 1);
      break;
    case "dup":
      t = tpl([line(doc, "p", [op.after])], [inject("x", "p", fragOf(doc, op.from, op.to), "after")]);
      m.splice(op.after + 1, 0, ...s.M.slice(op.from, op.to + 1).map((x) => ({ ...x })));
      break;
    case "change": {
      const old = at(s.M, op.at).text;
      if (op.start === undefined || op.end === undefined) {
        t = tpl([line(doc, "p", [op.at])], [{ id: "x", do: { type: "fill", anchor: "p", value: { text: op.text } } }]);
        m[op.at] = { text: op.text };
      } else {
        const w = makeWordAnchor(doc, "p", 0, [op.at], op.start, op.end);
        assert.ok(w !== undefined);
        t = tpl([w], [{ id: "x", do: { type: "fill", anchor: "p", value: { text: op.text } } }]);
        m[op.at] = { text: old.slice(0, op.start) + op.text + old.slice(op.end) };
      }
      break;
    }
  }
  const bytes = done(generate(s.bytes, t, ds({}), KEEP)).output;
  const after = reparse(bytes);
  assert.deepEqual(top(after).map((p) => p.logicalText), m.map((x) => x.text), `모형과 문서의 최상위 글이 다르다: ${JSON.stringify(op).slice(0, 80)}`);
  assert.equal(top(after).reduce((n, p) => n + p.objects.filter((o) => isTableNode(o)).length, 0), tablesOf(m).length);
  return { bytes, M: m };
}

const run = (ops: Op[], from: State = { bytes: base(), M: model0() }): State => ops.reduce(apply, from);

// ── 기대값: 모형에 명세의 판정 규칙을 적용한다 ───────────────────

/** 앵커와 기대값 계산에 쓰는 원래 글(word·line은 문단 글, range는 문단 글들)과 표(cell·object는 그 표 문단의 `lib`) */
type Spec = { a: StudioAnchor; text?: string; texts?: string[]; lib?: string };
type Want = { state: AnchorCheckState; found?: AnchorAddress };

const sameNums = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const listsOf = (M: Item[]): { pp: number[]; texts: string[] }[] => [
  { pp: [], texts: M.map((x) => x.text) },
  ...M.flatMap((x, i) => (x.lib === undefined ? [] : libAt(x.lib).lists.map((l) => ({ pp: [i, ...l.rel], texts: l.texts })))),
];
const listAt = (M: Item[], pp: readonly number[]): string[] | undefined => listsOf(M).find((l) => sameNums(l.pp, pp))?.texts;
const paraAt = (M: Item[], path: readonly number[]): string | undefined => listAt(M, path.slice(0, -1))?.[at(path, path.length - 1)];
const tablesOf = (M: Item[]): string[] => M.flatMap((x) => (x.lib !== undefined && libAt(x.lib).cells !== undefined ? [x.lib] : []));
/** 8.2의 word 지문: 대상 글과 앞뒤 24자 */
const wordPrint = (t: string, s: number, e: number): string => JSON.stringify([t.slice(s, e), t.slice(Math.max(0, s - 24), s), t.slice(e, e + 24)]);
const need = <T>(v: T | undefined): T => {
  assert.ok(v !== undefined);
  return v;
};

function pick(hits: AnchorAddress[]): Want {
  const only = hits[0];
  if (hits.length === 1 && only !== undefined) return { state: "relocated", found: only };
  return { state: hits.length === 0 ? "notFound" : "ambiguous" };
}

function expected(M: Item[], s: Spec): Want {
  const a = s.a;
  switch (a.kind) {
    case "field":
    case "mergeField": {
      const key = a.kind === "mergeField" ? `m:${a.key}` : a.mergeKey !== undefined ? `m:${a.mergeKey}` : `n:${a.name ?? ""}`;
      const count = M.reduce((n, x) => n + (x.lib === undefined ? 0 : libAt(x.lib).fields.filter((k) => k === key).length), 0);
      return { state: count > (a.occurrence ?? 0) ? "exact" : "notFound" };
    }
    case "line": {
      const T = need(s.text);
      if (paraAt(M, a.at.path) === T) return { state: "exact", found: { kind: "line", at: a.at } };
      return pick(listsOf(M).flatMap((l) => l.texts.flatMap((t, j): AnchorAddress[] => (t === T ? [{ kind: "line", at: { sectionIndex: 0, path: [...l.pp, j] } }] : []))));
    }
    case "word": {
      const T = need(s.text);
      const want = wordPrint(T, a.start, a.end);
      const target = T.slice(a.start, a.end);
      const here = paraAt(M, a.at.path);
      if (here !== undefined && a.end <= here.length && wordPrint(here, a.start, a.end) === want) return { state: "exact", found: { kind: "word", at: a.at, start: a.start, end: a.end } };
      const hits: AnchorAddress[] = [];
      for (const l of listsOf(M)) {
        l.texts.forEach((t, j) => {
          for (let st = t.indexOf(target); st >= 0; st = t.indexOf(target, st + 1)) {
            if (wordPrint(t, st, st + target.length) === want) hits.push({ kind: "word", at: { sectionIndex: 0, path: [...l.pp, j] }, start: st, end: st + target.length });
          }
        });
      }
      return pick(hits);
    }
    case "range": {
      // 7.10: 첫·끝 문단 글, 문단 수, 범위 글(줄바꿈 하나로 이음)이 모두 같으면 맞는 범위
      const T = need(s.texts);
      const n = T.length;
      const [first, last, joined] = [at(T, 0), at(T, n - 1), T.join("\n")];
      const fits = (texts: string[], i: number): boolean => {
        const seg = texts.slice(i, i + n);
        return seg.length === n && seg[0] === first && seg[n - 1] === last && seg.join("\n") === joined;
      };
      const own = listAt(M, a.at.parentPath);
      if (own !== undefined && a.to - a.from + 1 === n && fits(own, a.from)) return { state: "exact", found: { kind: "range", at: a.at, from: a.from, to: a.to } };
      const hits: AnchorAddress[] = [];
      let changed = false;
      for (const l of listsOf(M)) {
        l.texts.forEach((t, i) => {
          if (t !== first) return;
          if (fits(l.texts, i)) {
            hits.push({ kind: "range", at: { sectionIndex: 0, parentPath: l.pp }, from: i, to: i + n - 1 });
            return;
          }
          // 첫 문단만 맞으면: 첫 문단을 포함해 길이 2×count 안에 끝 문단이 있으면 changed(문단 하나짜리 범위는 아님)
          if (n >= 2 && l.texts.slice(i + 1, i + 2 * n).includes(last)) changed = true;
        });
      }
      return hits.length > 0 ? pick(hits) : { state: changed ? "changed" : "notFound" };
    }
    case "cell": {
      const tables = tablesOf(M);
      if (a.print === undefined) {
        const owner = tables[a.table.ordinal];
        return owner !== undefined && libAt(owner).cells?.has(`${a.row},${a.col}`) === true
          ? { state: "unverified", found: { kind: "cell", table: a.table, row: a.row, col: a.col } }
          : { state: "notFound" };
      }
      if (tables[a.table.ordinal] === s.lib) return { state: "exact", found: { kind: "cell", table: a.table, row: a.row, col: a.col } };
      return pick(tables.flatMap((k, o): AnchorAddress[] => (k === s.lib ? [{ kind: "cell", table: { sectionIndex: 0, ordinal: o }, row: a.row, col: a.col }] : [])));
    }
    case "object": {
      const tables = tablesOf(M);
      const own: AnchorAddress = { kind: "object", objectType: a.objectType, sectionIndex: a.sectionIndex, ordinal: a.ordinal };
      if (a.print === undefined) return tables[a.ordinal] !== undefined ? { state: "unverified", found: own } : { state: "notFound" };
      if (tables[a.ordinal] === s.lib) return { state: "exact", found: own };
      return pick(tables.flatMap((k, o): AnchorAddress[] => (k === s.lib ? [{ kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: o }] : [])));
    }
  }
}

const CODE: Record<AnchorCheckState, [string, string][]> = {
  exact: [],
  relocated: [["warning", "ANCHOR_RELOCATED"]],
  unverified: [["warning", "ANCHOR_UNVERIFIED"]],
  changed: [["error", "ANCHOR_CHANGED"]],
  ambiguous: [["error", "ANCHOR_AMBIGUOUS"]],
  notFound: [["error", "ANCHOR_NOT_FOUND"]],
};
/** 이슈 문구에 문서의 글이 들어가면 안 된다: 시험 문서의 앵커 글에서 뽑은 조각 */
const TEXT_PROBES = ["본문", "사업 안내", "칸 문단", "세부 사항", "끼운", "바뀐", "공고 내용", "[L", "머리글"];

/** checkAnchors를 모형의 기대값과 대조한다: 앵커마다 id·종류·상태·찾은 주소·이슈(심각도·코드·where), 이슈에 글 원문 없음 */
function verify(doc: HwpxDocument, M: Item[], S: Spec[], label: string): AnchorCheck[] {
  const checks = checkAnchors(doc, { anchors: S.map((s) => s.a) });
  assert.equal(checks.length, S.length);
  S.forEach((s, k) => {
    const c = at(checks, k);
    const want = expected(M, s);
    assert.deepEqual([c.anchor, c.kind, c.state], [s.a.id, s.a.kind, want.state], `${label}: ${s.a.id}`);
    assert.deepEqual(c.found, want.found, `${label}: ${s.a.id}의 찾은 주소`);
    assert.deepEqual(c.issues.map((i) => [i.severity, i.code, i.where]), CODE[want.state].map(([sev, code]) => [sev, code, s.a.id]), `${label}: ${s.a.id}의 이슈`);
    for (const i of c.issues) for (const probe of TEXT_PROBES) assert.ok(!i.message.includes(probe), `${label}: ${s.a.id}의 이슈 문구에 글 원문이 있다`);
  });
  return checks;
}

const isBare = (a: StudioAnchor): boolean => (a.kind === "cell" || a.kind === "object") && a.print === undefined;
const printOf = (a: StudioAnchor): string => JSON.stringify("print" in a ? a.print : null);

/**
 * planRelocation을 상태표와 대조한다: 모두 exact·relocated·unverified일 때만 새 앵커(같은 id·종류·pattern·지문, relocated만 새 주소,
 * 나머지는 그대로), 아니면 undefined. 새 앵커로 다시 검사하면 지문 없는 cell·object 말고는 모두 exact. 입력 템플릿은 바뀌지 않는다.
 */
function checkPlan(doc: HwpxDocument, S: Spec[], checks: AnchorCheck[]): boolean {
  const anchors = S.map((s) => s.a);
  const before = JSON.stringify(anchors);
  const plan = planRelocation({ anchors }, checks);
  assert.equal(JSON.stringify(anchors), before, "입력 템플릿을 바꾸지 않는다");
  const movable = checks.every((c) => c.state === "exact" || c.state === "relocated" || c.state === "unverified");
  if (!movable) {
    assert.equal(plan, undefined);
    return false;
  }
  assert.ok(plan !== undefined);
  assert.deepEqual(plan.changed, checks.filter((c) => c.state === "relocated").map((c) => c.anchor));
  plan.anchors.forEach((n, k) => {
    const old = at(anchors, k);
    assert.deepEqual([n.id, n.kind, n.pattern, printOf(n)], [old.id, old.kind, old.pattern, printOf(old)]);
    if (at(checks, k).state !== "relocated") assert.deepEqual(n, old);
    else assert.notDeepEqual(n, old);
  });
  const again = checkAnchors(doc, { anchors: plan.anchors });
  assert.deepEqual(again.map((c) => [c.anchor, c.state]), S.map((s) => [s.a.id, isBare(s.a) ? "unverified" : "exact"]));
  assert.deepEqual(again.map((c) => c.found), checks.map((c) => c.found), "새 앵커의 주소 = 상태표가 찾은 주소");
  return true;
}

// ── 앵커 49개(7종) ─────────────────────────────────────────────

const WORDS: [number, number, number][] = [[18, 0, 4], [24, 5, 7], [29, 0, 4], [36, 0, 4], [41, 5, 7], [46, 0, 4]];
const LINES = [17, 22, 27, 32, 37, 42, 20, 45];
const RANGES: [number, number][] = [...HEADINGS.map((h): [number, number] => [h, h + 4]), [18, 19], [44, 45]];
const CELLS: [number, number, number][] = [[0, 0, 0], [0, 1, 1], [0, 2, 2], [0, 5, 0], [1, 0, 0], [1, 3, 1]];
const BARE_CELLS: [number, number, number][] = [[0, 1, 0], [1, 2, 1], [2, 0, 0]];
const G = {
  fields: ["fc1", "fc2", "fc3", "fc4", "fm1", "fm2", "mg1", "mg2", "mg3", "mg4", "mg5"],
  words: WORDS.map(([p]) => `w${p}`),
  lines: LINES.map((p) => `l${p}`),
  ranges: RANGES.map(([f]) => `r${f}`),
  rc: ["rc"],
  cells: CELLS.map(([o, r, c]) => `c${o}${r}${c}`),
  t0cells: CELLS.filter(([o]) => o === 0).map(([o, r, c]) => `c${o}${r}${c}`),
  t1cells: CELLS.filter(([o]) => o === 1).map(([o, r, c]) => `c${o}${r}${c}`),
  objects: ["o0", "o1", "o2", "o3"],
  bare: ["n0", "n1", "n2", "q0", "q3"],
};

function specs(doc: HwpxDocument): Spec[] {
  const T = (i: number): string => at(top(doc), i).logicalText;
  const out: Spec[] = [
    { a: { id: "fc1", kind: "field", name: "성명" } },
    { a: { id: "fc2", kind: "field", name: "성명", occurrence: 1 } },
    { a: { id: "fc3", kind: "field", name: "소속", pattern: "pt1" } },
    { a: { id: "fc4", kind: "field", name: "이름" } },
    { a: { id: "fm1", kind: "field", mergeKey: "기관명" } },
    { a: { id: "fm2", kind: "field", mergeKey: "사업명", occurrence: 3 } },
    { a: { id: "mg1", kind: "mergeField", key: "담당자", pattern: "pt2" } },
    { a: { id: "mg2", kind: "mergeField", key: "연락처" } },
    { a: { id: "mg3", kind: "mergeField", key: "공고번호", occurrence: 2 } },
    { a: { id: "mg4", kind: "mergeField", key: "사유 설명" } },
    { a: { id: "mg5", kind: "mergeField", key: "재공고" } },
  ];
  for (const [p, s, e] of WORDS) {
    const w = makeWordAnchor(doc, `w${p}`, 0, [p], s, e);
    assert.ok(w !== undefined);
    out.push({ a: p === 18 ? { ...w, pattern: "pt1" } : w, text: T(p) });
  }
  for (const p of LINES) out.push({ a: p === 17 ? { ...line(doc, `l${p}`, [p]), pattern: "pt1" } : line(doc, `l${p}`, [p]), text: T(p) });
  for (const [f, t] of RANGES) {
    const r = range(doc, `r${f}`, f, t);
    out.push({ a: f === 17 ? { ...r, pattern: "pt2" } : r, texts: top(doc).slice(f, t + 1).map((p) => p.logicalText) });
  }
  const cellList = at(at(top(doc), 12).subLists, 1).paragraphs;
  out.push({ a: range(doc, "rc", 1, 4, [12, 1]), texts: cellList.slice(1, 5).map((p) => p.logicalText) });
  for (const [o, r, c] of CELLS) {
    const x = makeCellAnchor(doc, 0, o, r, c);
    assert.ok(x !== undefined);
    out.push({ a: { id: `c${o}${r}${c}`, ...x, ...(o === 0 && r === 1 ? { pattern: "pt2" } : {}) }, lib: at(TABLE_LIBS, o) });
  }
  BARE_CELLS.forEach(([o, r, c], k) => out.push({ a: { id: `n${k}`, kind: "cell", table: { sectionIndex: 0, ordinal: o }, row: r, col: c } }));
  for (let o = 0; o < 4; o++) {
    const x = makeObjectAnchor(doc, "tbl", 0, o);
    assert.ok(x !== undefined);
    out.push({ a: { id: `o${o}`, ...x }, lib: at(TABLE_LIBS, o) });
  }
  for (const o of [0, 3]) out.push({ a: { id: `q${o}`, kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: o } });
  return out;
}

let specCache: Spec[] | undefined;
const baseSpecs = (): Spec[] => (specCache ??= specs(reparse(base())));

/** 앵커마다 기대 상태를 적은 표와 결과를 대조한다(모든 앵커가 표에 있어야 한다) */
function expectStates(checks: AnchorCheck[], want: Partial<Record<AnchorCheckState, string[]>>): void {
  const exp = new Map<string, string>();
  for (const [state, ids] of Object.entries(want)) {
    for (const id of ids) {
      assert.ok(!exp.has(id), `기대 표에 ${id}가 두 번 있다`);
      exp.set(id, state);
    }
  }
  assert.deepEqual(checks.map((c) => [c.anchor, c.state]), checks.map((c) => [c.anchor, exp.get(c.anchor) ?? "(기대 없음)"]));
}
const foundOf = (checks: AnchorCheck[], id: string): AnchorAddress | undefined => checks.find((c) => c.anchor === id)?.found;
const without = (ids: string[], drop: string[]): string[] => ids.filter((id) => !drop.includes(id));

// ── 시험 ──────────────────────────────────────────────────────

test("8.8.13 시험 원본: 최상위 63문단, 모양이 모두 다른 표 4개, 앵커 49개(7종)와 필드 키의 위치", () => {
  const doc = reparse(base());
  assert.equal(top(doc).length, 63);
  const tables = top(doc).flatMap((p, i) => p.objects.filter((o) => isTableNode(o)).map((o) => (isTableNode(o) ? [i, o.rowCnt, o.colCnt] : [])));
  assert.deepEqual(tables, [[12, 6, 3], [15, 4, 2], [58, 5, 3], [61, 3, 2]]);
  // 지문이 서로 달라야 표마다 다시 찾기가 하나로 정해진다
  const objectPrints = [0, 1, 2, 3].map((o) => JSON.stringify(makeObjectAnchor(doc, "tbl", 0, o)?.print));
  assert.equal(new Set(objectPrints).size, 4);
  const S = baseSpecs();
  assert.equal(S.length, 49);
  assert.deepEqual([...new Set(S.map((s) => s.a.kind))].sort(), ["cell", "field", "line", "mergeField", "object", "range", "word"]);
  assert.equal(new Set(S.map((s) => s.a.id)).size, 49);
  assert.ok(listFields(doc).length >= 60, `필드 ${listFields(doc).length}개`);
  // 지운 필드 키를 찾을 문단: 누름틀 "성명"은 [9]·[55], 메일 머지 "재공고"·"사유 설명"은 [8]·[54]에만 있다
  const holders = (key: string): number[] => top(doc).flatMap((_, i) => (libAt(`b${i}`).fields.includes(key) ? [i] : []));
  assert.deepEqual([holders("n:성명"), holders("m:재공고"), holders("m:사유 설명")], [[9, 55], [8, 54], [8, 54]]);
});

test("8.8.13 W7 같은 원본: 전부 exact이고 지문 없는 cell·object만 unverified(경고), 찾은 주소는 앵커의 주소", () => {
  const s = run([]);
  const checks = verify(reparse(s.bytes), s.M, baseSpecs(), "같은 원본");
  expectStates(checks, { exact: [...G.fields, ...G.words, ...G.lines, ...G.ranges, ...G.rc, ...G.cells, ...G.objects], unverified: G.bare });
  assert.ok(checkPlan(reparse(s.bytes), baseSpecs(), checks));
});

test("8.8.13 W7 앞에 문단 삽입: word·line·range relocated(경고, 주소 +1, 칸 안 범위는 상위 [13, 1]), field·mergeField·cell·object exact, planRelocation 뒤 전부 exact", () => {
  const s = run([{ t: "insert", after: 0, text: "앞에 끼운 문단" }]);
  const doc = reparse(s.bytes);
  const S = baseSpecs();
  const checks = verify(doc, s.M, S, "앞에 문단");
  expectStates(checks, { exact: [...G.fields, ...G.cells, ...G.objects], relocated: [...G.words, ...G.lines, ...G.ranges, ...G.rc], unverified: G.bare });
  // 주소 +1(명세에서 바로 세운 값)
  for (const [p, st, e] of WORDS) assert.deepEqual(foundOf(checks, `w${p}`), { kind: "word", at: { sectionIndex: 0, path: [p + 1] }, start: st, end: e });
  for (const p of LINES) assert.deepEqual(foundOf(checks, `l${p}`), { kind: "line", at: { sectionIndex: 0, path: [p + 1] } });
  for (const [f, t] of RANGES) assert.deepEqual(foundOf(checks, `r${f}`), { kind: "range", at: { sectionIndex: 0, parentPath: [] }, from: f + 1, to: t + 1 });
  assert.deepEqual(foundOf(checks, "rc"), { kind: "range", at: { sectionIndex: 0, parentPath: [13, 1] }, from: 1, to: 4 });
  assert.ok(checkPlan(doc, S, checks));

  // 1판 Template(readTemplate)도 받는다: mergeField·pattern이 없는 앵커만으로 같은 상태
  const v1 = S.filter((x) => x.a.kind !== "mergeField").map((x) => {
    const { pattern: _p, ...a } = x.a as StudioAnchor & { pattern?: string };
    return a;
  });
  const t1 = readTemplate({ schema: "hwpx-studio/template@1", anchors: v1, rules: [], options: {} });
  assert.deepEqual(checkAnchors(doc, t1), checks.filter((c) => c.kind !== "mergeField"));

  // 2판 StudioTemplate(readStudioTemplate)을 받고, planRelocation의 새 앵커로 쓴 템플릿을 다시 읽을 수 있다
  const studio = readStudioTemplate(JSON.stringify(studioJson(S.map((x) => x.a))));
  assert.ok(studio.schema === "hwpx-studio/template@2");
  assert.deepEqual(checkAnchors(doc, studio), checks);
  const plan = planRelocation(studio, checkAnchors(doc, studio));
  assert.ok(plan !== undefined);
  const next = readStudioTemplate(writeStudioTemplate({ ...studio, version: studio.version + 1, anchors: plan.anchors }));
  assert.ok(next.schema === "hwpx-studio/template@2");
  assert.deepEqual(checkAnchors(doc, next).map((c) => c.state), S.map((x) => (isBare(x.a) ? "unverified" : "exact")));
});

/** 2판 템플릿 JSON: 앵커만 있고 값·자리·슬롯·블록은 비었다(패턴 pt1·pt2는 앵커의 pattern 참조용) */
function studioJson(anchors: StudioAnchor[]): Record<string, unknown> {
  const pattern = (id: string) => ({ id, name: `패턴 ${id}`, marker: { form: "digitDot", level: 1 }, place: "body", match: ["marker"] });
  return {
    schema: "hwpx-studio/template@2",
    id: "t0a1b2c3d",
    version: 1,
    source: { kind: "hwpx", sha256: "a".repeat(64) },
    patterns: [pattern("pt1"), pattern("pt2")],
    anchors,
    values: [],
    bindings: [],
    places: [],
    slots: [],
    blocks: [],
  };
}

test("8.8.13 W7 앞에 표 삽입: 지문 있는 cell·object는 원래 표를 다시 찾고(relocated, 서수 +1), 지문 없는 cell·object는 unverified(서수 그대로 = 다른 표)", () => {
  const s = run([{ t: "table", after: 0 }]);
  const doc = reparse(s.bytes);
  const S = baseSpecs();
  const checks = verify(doc, s.M, S, "앞에 표");
  // 표 문단도 문단이라 word·line·range도 한 칸 밀린다
  expectStates(checks, { exact: G.fields, relocated: [...G.words, ...G.lines, ...G.ranges, ...G.rc, ...G.cells, ...G.objects], unverified: G.bare });
  for (const [o, r, c] of CELLS) assert.deepEqual(foundOf(checks, `c${o}${r}${c}`), { kind: "cell", table: { sectionIndex: 0, ordinal: o + 1 }, row: r, col: c });
  for (let o = 0; o < 4; o++) assert.deepEqual(foundOf(checks, `o${o}`), { kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: o + 1 });
  // 지문 없는 셀은 서수 0(이제 앞에 넣은 표)을 가리킨 채로 경고만 받는다
  assert.deepEqual(foundOf(checks, "n0"), { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 0 });
  assert.ok(checkPlan(doc, S, checks));
});

test("8.8.13 W7 대상 글 복제(본문·표 복제 + 앞에 표): word·line·range·표 0의 cell·object ambiguous이고 생성이 막힌다, planRelocation은 undefined", () => {
  // 본문 [17..46]을 끝에 복제, 표 0 문단 [12]를 끝에 복제, 앞에 다른 표 → 원래 자리는 모두 한 칸 밀리고 지문이 맞는 곳이 둘
  const s = run([
    { t: "dup", from: 17, to: 46, after: 62 },
    { t: "dup", from: 12, to: 12, after: 92 },
    { t: "table", after: 0 },
  ]);
  const doc = reparse(s.bytes);
  const S = baseSpecs();
  const checks = verify(doc, s.M, S, "복제");
  expectStates(checks, {
    exact: G.fields,
    ambiguous: [...G.words, ...G.lines, ...G.ranges, ...G.rc, ...G.t0cells, "o0"],
    relocated: [...G.t1cells, "o1", "o2", "o3"],
    unverified: G.bare,
  });
  assert.equal(checkPlan(doc, S, checks), false);
  const w18 = at(S.filter((x) => x.a.id === "w18"), 0).a;
  const c011 = at(S.filter((x) => x.a.id === "c011"), 0).a;
  assert.deepEqual(failed(generate(s.bytes, tpl([w18], [{ id: "f", do: { type: "fill", anchor: "w18", value: { text: "값" } } }]), ds({}), KEEP)), ["ANCHOR_AMBIGUOUS"]);
  assert.deepEqual(failed(generate(s.bytes, tpl([c011], [{ id: "f", do: { type: "fill", anchor: "c011", value: { text: "값" } } }]), ds({}), KEEP)), ["ANCHOR_AMBIGUOUS"]);
});

test("8.8.13 W7 범위 끝 문단 삭제 → 그 range notFound, 안쪽 글 변경 → changed(끝 문단이 바뀐 range는 notFound), 안쪽 문단 추가 → changed", () => {
  const S = baseSpecs();
  const shifted = (from: number, ids: { w?: boolean; l?: boolean; r?: boolean }) => [
    ...(ids.w === true ? WORDS.filter(([p]) => p >= from).map(([p]) => `w${p}`) : []),
    ...(ids.l === true ? LINES.filter((p) => p >= from).map((p) => `l${p}`) : []),
    ...(ids.r === true ? RANGES.filter(([f]) => f >= from).map(([f]) => `r${f}`) : []),
  ];
  // [21] 삭제: r17(17~21)의 끝 문단이 없다. [21] 뒤의 앵커는 한 칸 당겨진다
  const endGone = run([{ t: "delete", at: 21 }]);
  const c1 = verify(reparse(endGone.bytes), endGone.M, S, "끝 문단 삭제");
  const moved1 = shifted(22, { w: true, l: true, r: true });
  expectStates(c1, {
    notFound: ["r17"],
    relocated: moved1,
    exact: [...G.fields, ...without([...G.words, ...G.lines, ...G.ranges], [...moved1, "r17"]), ...G.rc, ...G.cells, ...G.objects],
    unverified: G.bare,
  });
  assert.deepEqual(foundOf(c1, "r22"), { kind: "range", at: { sectionIndex: 0, parentPath: [] }, from: 21, to: 25 });
  assert.equal(checkPlan(reparse(endGone.bytes), S, c1), false);

  // [19]의 앞 4자를 바꿈: r17은 양 끝이 그대로라 changed, r18(18~19)은 끝 문단이 바뀌어 notFound
  const inner = run([{ t: "change", at: 19, start: 0, end: 4, text: "바뀐 번호" }]);
  const c2 = verify(reparse(inner.bytes), inner.M, S, "안쪽 글 변경");
  expectStates(c2, {
    changed: ["r17"],
    notFound: ["r18"],
    exact: [...G.fields, ...G.words, ...G.lines, ...without(G.ranges, ["r17", "r18"]), ...G.rc, ...G.cells, ...G.objects],
    unverified: G.bare,
  });
  assert.deepEqual(c2.find((c) => c.anchor === "r17")?.found, undefined);
  assert.equal(checkPlan(reparse(inner.bytes), S, c2), false);

  // [19] 뒤에 문단 추가: r17(5문단)은 끝 문단이 길이 10 안에 있어 changed, r18은 그대로, 뒤는 한 칸 밀린다
  const grown = run([{ t: "insert", after: 19, text: "안쪽에 더한 문단" }]);
  const c3 = verify(reparse(grown.bytes), grown.M, S, "안쪽 문단 추가");
  const moved3 = shifted(20, { w: true, l: true, r: true });
  expectStates(c3, {
    changed: ["r17"],
    relocated: moved3,
    exact: [...G.fields, ...without([...G.words, ...G.lines, ...G.ranges], [...moved3, "r17"]), ...G.rc, ...G.cells, ...G.objects],
    unverified: G.bare,
  });
  assert.equal(checkPlan(reparse(grown.bytes), S, c3), false);
});

test("8.8.13 W7 누름틀 이름·메일 머지 키를 품은 문단 삭제 → 그 field·mergeField notFound, 나머지 필드는 exact", () => {
  const S = baseSpecs();
  const s = run([{ t: "delete", at: 55 }, { t: "delete", at: 54 }, { t: "delete", at: 9 }, { t: "delete", at: 8 }]);
  const checks = verify(reparse(s.bytes), s.M, S, "필드 삭제");
  expectStates(checks, {
    notFound: ["fc1", "fc2", "mg4", "mg5"],
    exact: [...without(G.fields, ["fc1", "fc2", "mg4", "mg5"]), ...G.cells, ...G.objects],
    relocated: [...G.words, ...G.lines, ...G.ranges, ...G.rc],
    unverified: G.bare,
  });
  assert.equal(checkPlan(reparse(s.bytes), S, checks), false);
  // 한 곳만 지우면 순번 없는 앵커는 남고 순번 1은 없어진다
  const one = run([{ t: "delete", at: 55 }]);
  const c1 = verify(reparse(one.bytes), one.M, S, "성명 하나 삭제");
  assert.deepEqual(["fc1", "fc2"].map((id) => c1.find((c) => c.anchor === id)?.state), ["exact", "notFound"]);
});

test("8.8.13 재지정: 막힌 앵커를 새 원본에서 클릭(draftAnchors·make*Anchor) → redraftAnchor(id·pattern 유지, cell·object 지문 채움) → 다시 검사하면 relocated만 남고 일괄 갱신 뒤 전부 exact", () => {
  const s = run([
    { t: "dup", from: 17, to: 46, after: 62 },
    { t: "dup", from: 12, to: 12, after: 92 },
    { t: "table", after: 0 },
  ]);
  const doc = reparse(s.bytes);
  const S = baseSpecs();
  const checks = verify(doc, s.M, S, "복제");
  const draftOf = (path: number[], kind: string, start?: number, end?: number) => {
    const d = draftAnchors(doc, { sectionIndex: 0, path, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) }).find((x) => x.kind === kind);
    assert.ok(d !== undefined, `${path.join(",")}의 ${kind} 초안`);
    return d;
  };
  const owner = at(top(doc), 13); // 원래 표 0(앞에 표를 넣어 [13])
  const table0 = owner.objects.find(isTableNode);
  assert.ok(table0 !== undefined);
  const cellPath = (r: number, c: number): number[] => {
    const cell = table0.cells.find((x) => x.row === r && x.col === c);
    const k = owner.subLists.findIndex((sub) => sub === cell?.subList);
    assert.ok(k >= 0);
    return [13, k, 0];
  };
  // 사용자가 원래 자리(한 칸 밀린 곳)를 고른다
  const pickDraft = (a: StudioAnchor) => {
    switch (a.kind) {
      case "word":
        return draftOf([at(a.at.path, 0) + 1], "word", a.start, a.end);
      case "line":
        return draftOf([at(a.at.path, 0) + 1], "line");
      case "range":
        return a.id === "rc" ? makeRangeAnchor(doc, 0, [13, 1], 1, 4) : makeRangeAnchor(doc, 0, [], a.from + 1, a.to + 1);
      case "cell":
        return draftOf(cellPath(a.row, a.col), "cell");
      case "object":
        return makeObjectAnchor(doc, "tbl", 0, a.ordinal + 1);
      default:
        return undefined;
    }
  };
  let redrafted = 0;
  const fixed = S.map((x, k) => {
    if (at(checks, k).state !== "ambiguous") return x.a;
    const d = pickDraft(x.a);
    assert.ok(d !== undefined, x.a.id);
    const { anchor: r, kindChanged } = redraftAnchor(doc, x.a, d);
    redrafted++;
    assert.deepEqual([r.id, r.kind, r.pattern, kindChanged, "kindChanged" in r, "blocked" in r], [x.a.id, x.a.kind, x.a.pattern, false, false, false]);
    if (r.kind === "cell") {
      // draftAnchors의 cell 초안에는 지문이 없다 → 재지정이 그 셀의 지문을 채운다(= 원래 표의 지문)
      assert.equal("print" in d, false);
      assert.deepEqual(r.print, makeCellAnchor(doc, 0, 1, r.row, r.col)?.print);
      assert.deepEqual(r.print, x.a.kind === "cell" ? x.a.print : null);
    }
    if (r.kind === "object") assert.deepEqual(r.print, x.a.kind === "object" ? x.a.print : null);
    return r;
  });
  assert.equal(redrafted, G.words.length + G.lines.length + G.ranges.length + 1 + G.t0cells.length + 1);
  // 재지정한 앵커는 exact, 원래 relocated는 그대로 → 이제 일괄 갱신이 된다
  const after = checkAnchors(doc, { anchors: fixed });
  expectStates(after, {
    exact: [...G.fields, ...G.words, ...G.lines, ...G.ranges, ...G.rc, ...G.t0cells, "o0"],
    relocated: [...G.t1cells, "o1", "o2", "o3"],
    unverified: G.bare,
  });
  const plan = planRelocation({ anchors: fixed }, after);
  assert.ok(plan !== undefined);
  assert.deepEqual(plan.changed, [...G.t1cells, "o1", "o2", "o3"]);
  assert.deepEqual(checkAnchors(doc, { anchors: plan.anchors }).map((c) => c.state), S.map((x) => (isBare(x.a) ? "unverified" : "exact")));
  // 새 판으로 저장할 수 있는 앵커다(2판 읽기 통과)
  const saved = readStudioTemplate(JSON.stringify(studioJson(plan.anchors)));
  assert.equal((saved as StudioTemplate).anchors.length, 49);
});

test("8.8.13 redraftAnchor: 종류를 바꾸면 kindChanged, mergeField는 키 초안으로 mergeField 유지, blocked는 빼고, 없는 주소는 FILL_DRAFT_ADDRESS", () => {
  const s = run([{ t: "insert", after: 0, text: "앞에 끼운 문단" }]);
  const doc = reparse(s.bytes);
  const byId = (id: string): StudioAnchor => at(baseSpecs().filter((x) => x.a.id === id), 0).a;

  // word → line(사용자가 문단 전체를 고름)
  const lineDraft = draftAnchors(doc, { sectionIndex: 0, path: [19] }).find((d) => d.kind === "line");
  assert.ok(lineDraft !== undefined);
  const changedKind = redraftAnchor(doc, byId("w18"), lineDraft);
  assert.deepEqual(changedKind, { anchor: { id: "w18", ...lineDraft, pattern: "pt1" }, kindChanged: true });
  assert.equal(at(checkAnchors(doc, { anchors: [changedKind.anchor] }), 0).state, "exact");

  // mergeField: 메일 머지 필드 안을 클릭한 field 초안(mergeKey) → mergeField(key, 순번)로 적는다. 1판 꼴 field(mergeKey)는 field 그대로
  const p = top(doc).findIndex((x) => x.logicalText.includes("{{담당자}}") && x.fieldMarks.length > 0);
  const offset = at(top(doc), p).logicalText.indexOf("담당자}}");
  const fieldDraft = draftAnchors(doc, { sectionIndex: 0, path: [p], start: offset }).find((d) => d.kind === "field");
  assert.ok(fieldDraft !== undefined && fieldDraft.kind === "field" && fieldDraft.mergeKey === "담당자");
  const mg = redraftAnchor(doc, byId("mg1"), fieldDraft);
  assert.equal(at(checkAnchors(doc, { anchors: [mg.anchor] }), 0).state, "exact");
  assert.deepEqual(mg, { anchor: { id: "mg1", kind: "mergeField", key: "담당자", occurrence: fieldDraft.occurrence, pattern: "pt2" }, kindChanged: false });
  const fm = redraftAnchor(doc, byId("fm1"), fieldDraft);
  assert.deepEqual(fm, { anchor: { id: "fm1", ...fieldDraft }, kindChanged: false });
  // mergeField → 누름틀(이름) 초안은 종류가 바뀐 것
  const click = top(doc).findIndex((x) => x.logicalText.startsWith("성명:"));
  const nameDraft = draftAnchors(doc, { sectionIndex: 0, path: [click], start: at(top(doc), click).logicalText.length - 2 }).find((d) => d.kind === "field");
  assert.ok(nameDraft !== undefined && nameDraft.kind === "field" && nameDraft.name === "성명");
  assert.deepEqual(redraftAnchor(doc, byId("mg1"), nameDraft), { anchor: { id: "mg1", ...nameDraft, pattern: "pt2" }, kindChanged: true });

  // 막힌 초안(표 문단의 line은 FILL_HAS_OBJECT)도 받되 blocked는 앵커에 남기지 않는다
  const blockedDraft = draftAnchors(doc, { sectionIndex: 0, path: [13] }).find((d) => d.kind === "line");
  assert.ok(blockedDraft?.blocked !== undefined);
  const unblocked = redraftAnchor(doc, byId("o0"), blockedDraft);
  assert.deepEqual([unblocked.anchor.kind, "blocked" in unblocked.anchor, unblocked.kindChanged], ["line", false, true]);

  // object 초안(지문 없음)에도 지문을 채운다
  const bare = redraftAnchor(doc, byId("q0"), { kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 2 });
  assert.deepEqual(bare, { anchor: { id: "q0", ...makeObjectAnchor(doc, "tbl", 0, 2) }, kindChanged: false });

  // 없는 주소
  const missing: RedraftInput[] = [
    { kind: "cell", table: { sectionIndex: 0, ordinal: 99 }, row: 0, col: 0 },
    { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 40, col: 0 },
    { kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 9 },
    { kind: "range", at: { sectionIndex: 0, parentPath: [] }, from: 60, to: 80, print: { first: { text: "", sha256: "" }, last: { text: "", sha256: "" }, count: 21, sha256: "" } },
  ];
  // word·line도 문단과 글 구간을 문서에 대어 본다
  const word19 = draftAnchors(doc, { sectionIndex: 0, path: [19], start: 0, end: 4 }).find((d) => d.kind === "word");
  assert.ok(word19 !== undefined && word19.kind === "word");
  missing.push(
    { ...lineDraft, at: { sectionIndex: 0, path: [999] } },
    { ...word19, at: { sectionIndex: 0, path: [999] } },
    { ...word19, end: 9999 },
    { ...lineDraft, at: { sectionIndex: 5, path: [19] } },
    { ...word19, start: 3, end: 3 },
  );
  for (const d of missing) {
    assert.throws(() => redraftAnchor(doc, byId("c000"), d), (e: unknown) => e instanceof HwpxError && e.code === "FILL_DRAFT_ADDRESS", JSON.stringify(d).slice(0, 120));
  }
});

test("8.8.13 redraftAnchor: 초안의 id·pattern·다른 종류의 키는 버리고 옛 앵커의 id·pattern만 쓴다(옛 앵커에 pattern이 없으면 키가 없다)", () => {
  const s = run([{ t: "insert", after: 0, text: "앞에 끼운 문단" }]);
  const doc = reparse(s.bytes);
  const byId = (id: string): StudioAnchor => at(baseSpecs().filter((x) => x.a.id === id), 0).a;
  const drafts = draftAnchors(doc, { sectionIndex: 0, path: [19], start: 0, end: 4 });
  const word = drafts.find((d) => d.kind === "word");
  const lineD = drafts.find((d) => d.kind === "line");
  assert.ok(word?.kind === "word" && lineD?.kind === "line");
  const stray = { id: "OTHER", pattern: "px" };
  // 옛 앵커에 pattern이 있으면(w18: pt1) 그것, 없으면(w24) 키 없음
  const a1 = { ...word, ...stray };
  assert.deepEqual(redraftAnchor(doc, byId("w18"), a1), { anchor: { id: "w18", kind: "word", at: word.at, start: word.start, end: word.end, print: word.print, pattern: "pt1" }, kindChanged: false });
  const r2 = redraftAnchor(doc, byId("w24"), a1);
  assert.deepEqual(r2, { anchor: { id: "w24", kind: "word", at: word.at, start: word.start, end: word.end, print: word.print }, kindChanged: false });
  assert.equal("pattern" in r2.anchor, false);
  // 다른 종류의 키(start·end·print·table·key·blocked)가 섞인 line 초안 → line의 키만
  const a3 = { ...lineD, ...stray, start: 0, end: 4, table: { sectionIndex: 0, ordinal: 0 }, key: "x", blocked: "FILL_HAS_OBJECT" as const };
  assert.deepEqual(redraftAnchor(doc, byId("l22"), a3), { anchor: { id: "l22", kind: "line", at: lineD.at, print: lineD.print }, kindChanged: false });
  // 문서와 다른 지문을 실은 초안 → doc에서 다시 뜬 지문
  const a4 = { ...lineD, print: { text: "가짜", sha256: "0".repeat(64) } };
  assert.deepEqual(redraftAnchor(doc, byId("l17"), a4).anchor, { id: "l17", kind: "line", at: lineD.at, print: lineD.print, pattern: "pt1" });
  // 필드·메일 머지·셀·범위·객체도 같은 규칙
  const f = redraftAnchor(doc, byId("fc3"), { kind: "field", name: "소속", ...stray, mergeKey: undefined, start: 1 } as unknown as RedraftInput);
  assert.deepEqual(f, { anchor: { id: "fc3", kind: "field", name: "소속", pattern: "pt1" }, kindChanged: false });
  const m = redraftAnchor(doc, byId("mg2"), { kind: "field", mergeKey: "연락처", occurrence: 1, ...stray, name: "" } as RedraftInput);
  assert.deepEqual(m, { anchor: { id: "mg2", kind: "mergeField", key: "연락처", occurrence: 1 }, kindChanged: false });
  const cellD = { kind: "cell" as const, table: { sectionIndex: 0, ordinal: 1 }, row: 3, col: 1, ...stray, at: lineD.at };
  assert.deepEqual(redraftAnchor(doc, byId("c131"), cellD).anchor, { id: "c131", ...makeCellAnchor(doc, 0, 1, 3, 1) });
  const rangeD = { ...need(makeRangeAnchor(doc, 0, [], 18, 22)), ...stray, path: [3] };
  assert.deepEqual(redraftAnchor(doc, byId("r17"), rangeD).anchor, { id: "r17", ...makeRangeAnchor(doc, 0, [], 18, 22), pattern: "pt2" });
  const objD = { ...need(makeObjectAnchor(doc, "tbl", 0, 3)), ...stray, row: 1 };
  assert.deepEqual(redraftAnchor(doc, byId("o3"), objD).anchor, { id: "o3", ...makeObjectAnchor(doc, "tbl", 0, 3) });
});

test("8.8.13 redraftAnchor의 anchor는 그대로 2판 템플릿 anchors[]에 넣어 writeStudioTemplate → readStudioTemplate를 통과한다(종류가 바뀐 경우 포함)", () => {
  const s = run([{ t: "table", after: 0 }]);
  const doc = reparse(s.bytes);
  const S = baseSpecs();
  const byId = (id: string): StudioAnchor => at(S.filter((x) => x.a.id === id), 0).a;
  const draft = (path: number[], kind: string, start?: number, end?: number) => {
    const d = draftAnchors(doc, { sectionIndex: 0, path, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) }).find((x) => x.kind === kind);
    assert.ok(d !== undefined, `${path.join(",")}의 ${kind} 초안`);
    return d;
  };
  const merge = top(doc).findIndex((x) => x.logicalText.includes("{{담당자}}") && x.fieldMarks.length > 0);
  const click = top(doc).findIndex((x) => x.logicalText.startsWith("성명:"));
  const owner = at(top(doc), 13); // 원래 표 0
  const table0 = owner.objects.find(isTableNode);
  const sub = owner.subLists.findIndex((x) => x === table0?.cells.find((c) => c.row === 1 && c.col === 1)?.subList);
  assert.ok(sub >= 0);
  const cases: [string, RedraftInput, boolean][] = [
    // 같은 종류
    ["w18", draft([19], "word", 0, 4), false],
    ["l17", draft([18], "line"), false],
    ["r17", need(makeRangeAnchor(doc, 0, [], 18, 22)), false],
    ["rc", need(makeRangeAnchor(doc, 0, [13, 1], 1, 4)), false],
    ["c011", draft([13, sub, 0], "cell"), false],
    ["o0", need(makeObjectAnchor(doc, "tbl", 0, 1)), false],
    ["mg1", draft([merge], "field", at(top(doc), merge).logicalText.indexOf("담당자}}")), false],
    ["n0", draft([13, sub, 0], "cell"), false],
    // 종류가 바뀜: word → line, line → word, mergeField → 누름틀 field, 객체 → 막힌 line(blocked는 빠진다), cell → range, range → cell
    ["w24", draft([25], "line"), true],
    ["l22", draft([23], "word", 0, 4), true],
    ["mg2", draft([click], "field", at(top(doc), click).logicalText.length - 2), true],
    ["o1", draft([16], "line"), true],
    ["c100", need(makeRangeAnchor(doc, 0, [], 30, 31)), true],
    ["r22", draft([13, sub, 0], "cell"), true],
  ];
  const redrafted = new Map(cases.map(([id, d, changed]) => {
    const r = redraftAnchor(doc, byId(id), d);
    assert.equal(r.kindChanged, changed, id);
    assert.deepEqual([r.anchor.id, r.anchor.pattern], [id, byId(id).pattern]);
    return [id, r.anchor] as const;
  }));
  const anchors = S.map((x) => redrafted.get(x.a.id) ?? x.a);
  const studio = readStudioTemplate(JSON.stringify(studioJson(S.map((x) => x.a))));
  assert.ok(studio.schema === "hwpx-studio/template@2");
  const written = writeStudioTemplate({ ...studio, version: studio.version + 1, anchors });
  const reread = readStudioTemplate(written);
  assert.ok(reread.schema === "hwpx-studio/template@2");
  assert.deepEqual(reread.anchors, anchors);
  assert.equal(writeStudioTemplate(reread), written);
  // 다시 지정한 앵커는 새 원본에서 exact다(지문 없던 n0도 재지정이 지문을 채워 unverified가 아니다)
  const n0 = redrafted.get("n0");
  assert.ok(n0?.kind === "cell" && n0.print !== undefined);
  const checks = checkAnchors(doc, reread);
  for (const [id] of cases) assert.equal(checks.find((c) => c.anchor === id)?.state, "exact", id);
});

// ── 긴 글 ──────────────────────────────────────────────────────

const SHORT = ["공고 내용을 안내합니다.", "제출 서류는 원본 1부입니다.", "문의: 담당 부서 & 지원 팀.", "<참고> 기한을 지키십시오.", "\"인용\"과 '홑따옴표'.", "추가 설명이 이어집니다."];
/** 길이 min~max의 한 줄 글. 조각마다 고유 표지([태그·번호])가 있어 24자 문맥이 겹치지 않는다(줄바꿈·탭 없음: insertText는 줄바꿈마다 문단을 나눈다) */
function longText(next: () => number, tag: string, min: number, max: number): string {
  const n = min + Math.floor(next() * (max - min));
  let s = "";
  for (let k = 0; s.length < n; k++) s += `[${tag}·${k}] ${SHORT[Math.floor(next() * SHORT.length)] ?? ""} `;
  return s.slice(0, n).trimEnd();
}

test("8.8.13 긴 글(200~1,500자) 문단: 앞 40자가 같은 두 문단을 해시로 가르고, 앞에 삽입하면 relocated, 꼬리·머리 변경은 line notFound·range changed·word 재탐색", () => {
  const next = rng(1500);
  const head = `[머리] ${"같은 머리글로 시작하는 긴 문단입니다. ".repeat(3)}`;
  const L = [
    longText(next, "L1", 200, 400),
    head + longText(next, "L2", 300, 600),
    head + longText(next, "L3", 300, 600),
    longText(next, "L4", 800, 1500),
    longText(next, "L5", 1100, 1500),
    longText(next, "L6", 200, 300),
  ];
  for (const t of L) assert.ok(t.length >= 200 && t.length <= 1500 + head.length, `${t.length}자`);
  const start = run([{ t: "insert", after: 62, text: L.join("\n") }]); // [63..68]
  const doc = reparse(start.bytes);
  const word = (id: string, p: number, s: number, e: number) => {
    const w = makeWordAnchor(doc, id, 0, [p], s, e);
    assert.ok(w !== undefined);
    return w;
  };
  const S: Spec[] = [
    ...L.map((t, k): Spec => ({ a: line(doc, `L${k + 1}`, [63 + k]), text: t })),
    { a: word("W1", 63, 150, 156), text: at(L, 0) },
    { a: word("W5", 67, 1100, 1106), text: at(L, 4) },
    { a: range(doc, "R14", 63, 66), texts: L.slice(0, 4) },
    { a: range(doc, "R23", 64, 65), texts: L.slice(1, 3) },
    { a: range(doc, "R56", 67, 68), texts: L.slice(4, 6) },
  ];
  // L2·L3: 지문 글(앞 40자)은 같고 해시는 다르다
  const [l2, l3] = [at(S, 1).a, at(S, 2).a];
  assert.ok(l2.kind === "line" && l3.kind === "line");
  assert.deepEqual([l2.print.text === l3.print.text, l2.print.sha256 === l3.print.sha256, l2.print.text.length], [true, false, 40]);
  const ALL = S.map((x) => x.a.id);

  expectStates(verify(doc, start.M, S, "긴 글 같은 원본"), { exact: ALL });

  const shifted = run([{ t: "insert", after: 0, text: "앞에 끼운 문단" }], start);
  const c1 = verify(reparse(shifted.bytes), shifted.M, S, "긴 글 앞에 삽입");
  expectStates(c1, { relocated: ALL });
  assert.deepEqual(foundOf(c1, "W5"), { kind: "word", at: { sectionIndex: 0, path: [68] }, start: 1100, end: 1106 });
  assert.deepEqual(foundOf(c1, "R14"), { kind: "range", at: { sectionIndex: 0, parentPath: [] }, from: 64, to: 67 });
  assert.ok(checkPlan(reparse(shifted.bytes), S, c1));

  // L3의 끝 5자를 바꿈: L3 notFound(앞 40자가 같은 L2와 헷갈리지 않는다), R14 changed, R23 notFound(끝 문단), 나머지 exact
  const l3len = at(L, 2).length;
  const tail = run([{ t: "change", at: 65, start: l3len - 5, end: l3len, text: "끝을 바꿈" }], start);
  expectStates(verify(reparse(tail.bytes), tail.M, S, "긴 글 꼬리 변경"), { notFound: ["L3", "R23"], changed: ["R14"], exact: without(ALL, ["L3", "R23", "R14"]) });

  // L5의 앞 3자를 더 긴 글로 바꿈: W5(1,100자 뒤)는 같은 문단에서 다시 찾고(시작 +37), L5·R56(첫 문단)은 notFound
  const longer = "앞 글을 훨씬 길게 바꾼 머리말입니다. 사십 자 가까이 됩니다";
  const headChange = run([{ t: "change", at: 67, start: 0, end: 3, text: longer }], start);
  const c3 = verify(reparse(headChange.bytes), headChange.M, S, "긴 글 머리 변경");
  expectStates(c3, { relocated: ["W5"], notFound: ["L5", "R56"], exact: without(ALL, ["W5", "L5", "R56"]) });
  assert.deepEqual(foundOf(c3, "W5"), { kind: "word", at: { sectionIndex: 0, path: [67] }, start: 1100 + longer.length - 3, end: 1106 + longer.length - 3 });
});

// ── 무작위 ─────────────────────────────────────────────────────

const BODY = /^b(1[7-9]|[2-3]\d|4[0-6])$/;

function randomOp(next: () => number, M: Item[], safe: boolean, tag: string): Op | undefined {
  const int = (n: number): number => Math.floor(next() * n);
  const len = M.length;
  const body = M.flatMap((x, i) => (x.lib !== undefined && BODY.test(x.lib) ? [i] : []));
  const tables = M.flatMap((x, i) => (x.lib !== undefined && libAt(x.lib).cells !== undefined ? [i] : []));
  // 자리: 절반은 본문(범위·word·line 앵커), 20%는 표 문단(cell·object 앵커), 나머지는 아무 곳
  const pos = (): number => {
    const r = next();
    if (body.length > 0 && r < 0.5) return at(body, int(body.length));
    if (tables.length > 0 && r < 0.7) return at(tables, int(tables.length));
    return 1 + int(len - 1);
  };
  const text = (): string => `끼운 문단 ${tag}${next() < 0.3 ? ` ${longText(next, tag, 200, 1500)}` : ""}`;
  if (safe) {
    // 범위 안쪽(본문 [17..45] 뒤)을 피해 넣기만 한다 → 모든 비-exact가 relocated·unverified
    const ok = M.flatMap((x, i) => (x.lib !== undefined && /^b(1[7-9]|[2-3]\d|4[0-5])$/.test(x.lib) ? [] : [i]));
    const after = at(ok, int(ok.length));
    return next() < 0.6 ? { t: "insert", after, text: text() } : { t: "table", after };
  }
  switch (int(5)) {
    case 0:
      return { t: "insert", after: next() < 0.5 ? pos() : int(len), text: text() };
    case 1:
      return { t: "table", after: int(len) };
    case 2:
      return { t: "delete", at: pos() };
    case 3: {
      // 복제: 40%는 범위 앵커의 첫 문단부터 2~6문단(범위를 통째로 복제할 수 있게), 나머지는 아무 곳 1~3문단
      const heads = M.flatMap((x, i) => (x.lib !== undefined && /^b(17|18|22|27|32|37|42|44)$/.test(x.lib) ? [i] : []));
      const fromHead = heads.length > 0 && next() < 0.4;
      const from = fromHead ? at(heads, int(heads.length)) : pos();
      return { t: "dup", from, to: Math.min(len - 1, from + (fromHead ? 1 + int(5) : int(3))), after: int(len) };
    }
    default: {
      // 글 변경: 객체가 없는 문단만. 본문·새 문단은 앞 10자 안의 낱말, 그 밖은 문단 전체
      const plain = M.flatMap((x, i) => (i > 0 && (x.lib === undefined || libAt(x.lib).plain) ? [i] : []));
      if (plain.length === 0) return undefined;
      const prefer = plain.filter((i) => body.includes(i));
      const i = prefer.length > 0 && next() < 0.7 ? at(prefer, int(prefer.length)) : at(plain, int(plain.length));
      const item = at(M, i);
      const t = at(M, i).text;
      if ((item.lib === undefined || BODY.test(item.lib)) && t.length >= 2 && next() < 0.6) {
        const start = int(Math.min(10, t.length - 1));
        return { t: "change", at: i, start, end: Math.min(t.length, start + 1 + int(3)), text: `바뀐${tag}` };
      }
      return { t: "change", at: i, text: `바뀐 문단 ${tag}` };
    }
  }
}

test("8.8.13 무작위 64회(시드 고정): 삽입·표 삽입·삭제·복제·글 변경을 섞은 원본에서 앵커 49개의 상태·찾은 주소·이슈가 변경 기록 모형의 기대와 같고, 결정적이며, 일괄 갱신 조건이 맞다", () => {
  const next = rng(832);
  const S = baseSpecs();
  const tally: Record<AnchorCheckState, number> = { exact: 0, relocated: 0, changed: 0, ambiguous: 0, notFound: 0, unverified: 0 };
  const perKind = new Map<string, Set<AnchorCheckState>>();
  let planned = 0;
  let blocked = 0;
  let ops = 0;
  for (let trial = 0; trial < 64; trial++) {
    const safe = trial % 4 === 0;
    let s: State = { bytes: base(), M: model0() };
    const n = 1 + Math.floor(next() * 4);
    for (let k = 0; k < n; k++) {
      const op = randomOp(next, s.M, safe, `${trial}-${k}`);
      if (op === undefined) continue;
      s = apply(s, op);
      ops++;
    }
    const doc = reparse(s.bytes);
    const checks = verify(doc, s.M, S, `시행 ${trial}`);
    assert.deepEqual(checkAnchors(reparse(s.bytes), { anchors: S.map((x) => x.a) }), checks, `시행 ${trial}: 같은 입력은 같은 결과`);
    for (const c of checks) {
      tally[c.state]++;
      perKind.set(c.kind, (perKind.get(c.kind) ?? new Set()).add(c.state));
    }
    if (checkPlan(doc, S, checks)) planned++;
    else blocked++;
    if (safe) assert.ok(checks.every((c) => c.state === "exact" || c.state === "relocated" || c.state === "unverified"), `시행 ${trial}: 넣기만 했다`);
  }
  // 상태 6종이 모두 충분히 나왔고, 종류마다 가능한 상태가 나왔다
  for (const [state, count] of Object.entries(tally)) assert.ok(count >= 10, `${state} ${count}건`);
  assert.deepEqual([...(perKind.get("range") ?? [])].sort(), ["ambiguous", "changed", "exact", "notFound", "relocated"]);
  for (const kind of ["word", "line"]) assert.deepEqual([...(perKind.get(kind) ?? [])].sort(), ["ambiguous", "exact", "notFound", "relocated"], kind);
  for (const kind of ["cell", "object"]) assert.deepEqual([...(perKind.get(kind) ?? [])].sort(), ["ambiguous", "exact", "notFound", "relocated", "unverified"], kind);
  assert.ok(planned >= 16 && blocked >= 16, `일괄 갱신 ${planned}회, 막힘 ${blocked}회`);
  assert.ok(ops >= 100, `변경 ${ops}건`);
  console.log(`무작위: 변경 ${ops}건, 상태 ${JSON.stringify(tally)}, 일괄 갱신 ${planned}회·막힘 ${blocked}회`);
});
