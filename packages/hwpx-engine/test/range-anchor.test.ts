// 범위 앵커(7.10): 지문·해석, range를 받는 액션(inject·insertText·delete), 이동표, cell·object 선택 지문.
// 기대값은 명세 7.10의 규칙(지문의 정의, 교체 = 범위 삭제 + 그 자리 삽입, 이동표 변환식)에서 세운다. 엔진 출력을 기대값으로 옮겨 적지 않는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findPlaceholders, isTableNode, listFields, type HwpxDocument, type ParagraphNode, type TableCell } from "../src/index.ts";
import { generate, makeCellAnchor, makeObjectAnchor, makeRangeAnchor, makeWordAnchor, remapAddress, resolveAnchors, type Move, type RangeAnchor } from "../src/fill/index.ts";
import { generateText } from "../src/text/index.ts";
import { HwpxError } from "../src/errors.ts";
import { readTemplate } from "../src/template/index.ts";
import { bytesEqual, readFixture, reparse, sha256Hex, utf8 } from "./helpers.ts";
import {
  HEADINGS,
  KEEP,
  OBJ,
  at,
  dataFor,
  del,
  done,
  ds,
  failed,
  fragOf,
  gateClean,
  inject,
  insertText,
  line,
  listOf,
  longValue,
  move,
  notice,
  range,
  remapHolds,
  rng,
  tablesIn,
  texts,
  top,
  tpl,
  walkTexts,
} from "./range-helpers.ts";

// ── 지문 ──────────────────────────────────────────────────────

test("7.10 시험 문서: 63문단(제목 6개·본문 24개·복사본), 칸 [12, 1]은 6문단, 자리 수십 개", () => {
  const doc = reparse(notice());
  assert.equal(top(doc).length, 63);
  for (const h of HEADINGS) assert.match(at(top(doc), h).logicalText, /^\d\. 제\d장 사업 안내$/);
  assert.equal(listOf(doc, [12, 1]).length, 6);
  assert.ok(listFields(doc).length >= 60, `필드 ${listFields(doc).length}개`);
  const placeholders = walkTexts(top(doc)).reduce((n, t) => n + findPlaceholders(t).length, 0);
  assert.ok(placeholders >= 60, `{{}} ${placeholders}곳`);
  assert.equal(tablesIn(top(doc)), 4);
});

test("7.10 makeRangeAnchor: 지문 = 첫·끝 문단(글 앞 40자·문단 글 해시), 문단 수, 범위 글(문단 글을 줄바꿈 하나로 이음)의 해시", () => {
  const doc = reparse(notice());
  const ps = top(doc).slice(18, 22);
  const printOf = (p: ParagraphNode) => ({ text: p.logicalText.slice(0, 40), sha256: sha256Hex(utf8(p.logicalText)) });
  const expected = {
    kind: "range",
    at: { sectionIndex: 0, parentPath: [] },
    from: 18,
    to: 21,
    print: { first: printOf(at(ps, 0)), last: printOf(at(ps, 3)), count: 4, sha256: sha256Hex(utf8(texts(ps).join("\n"))) },
  };
  assert.deepEqual(makeRangeAnchor(doc, 0, [], 18, 21), expected);
  assert.ok(at(ps, 0).logicalText.length > 40, "첫 문단 글이 40자보다 길어야 앞 40자를 시험한다");
  // 7.2의 조각 선택 꼴도 같은 결과
  assert.deepEqual(makeRangeAnchor(doc, { sectionIndex: 0, parentPath: [], from: 18, to: 21 }), expected);
  // 표 칸 안(같은 하위 목록)
  const cell = listOf(doc, [12, 1]).slice(1, 5);
  assert.deepEqual(makeRangeAnchor(doc, 0, [12, 1], 1, 4)?.print, { first: printOf(at(cell, 0)), last: printOf(at(cell, 3)), count: 4, sha256: sha256Hex(utf8(texts(cell).join("\n"))) });
  // 한 문단 범위는 첫·끝이 같다
  const one = makeRangeAnchor(doc, 0, [], 5, 5);
  assert.deepEqual(one?.print.first, one?.print.last);
  // 없는 구역·목록·범위
  const bad: [number, number[], number, number][] = [[1, [], 0, 0], [0, [], 5, 4], [0, [], 0, 63], [0, [12], 0, 0], [0, [12, 99], 0, 0], [0, [99, 0], 0, 0], [0, [], -1, 2], [0, [12, 1], 0, 6]];
  for (const [s, pp, f, t] of bad) assert.equal(makeRangeAnchor(doc, s, pp, f, t), undefined, JSON.stringify([s, pp, f, t]));
});

// ── 해석 ──────────────────────────────────────────────────────

test("7.10 해석: exact·relocated(앞에 문단 삽입)·ambiguous(글 복제)·notFound(끝 문단 삭제)·ANCHOR_CHANGED(안쪽 글 변경·문단 추가)", () => {
  const base = notice();
  const doc = reparse(base);
  const ranges = HEADINGS.map((h, k) => range(doc, `r${k}`, h + 1, h + 4));
  const inCell = range(doc, "cell", 1, 4, [12, 1]);
  const all = tpl([...ranges, inCell], []);

  // exact
  const exact = resolveAnchors(doc, all);
  assert.deepEqual(exact.issues, []);
  for (const [k, h] of HEADINGS.entries()) {
    const r = exact.anchors.get(`r${k}`);
    assert.ok(r?.kind === "range");
    assert.deepEqual([r.parentPath, r.from, r.to, r.relocated, texts(r.paragraphs)], [[], h + 1, h + 4, false, texts(top(doc).slice(h + 1, h + 5))]);
  }

  // 앞에 문단 하나 삽입 → 모든 범위가 한 칸 뒤로(표 칸 안 범위는 상위 표 문단 번호가 바뀐다). 경고만
  const shifted = reparse(done(generate(base, tpl([line(doc, "p1", [1])], [insertText("i", "p1", "끼운 문단", "after")]), ds({}), KEEP)).output);
  const moved = resolveAnchors(shifted, all);
  assert.deepEqual(moved.issues.map((i) => [i.severity, i.code, i.where]), [...ranges.map((r) => ["warning", "ANCHOR_RELOCATED", r.id]), ["warning", "ANCHOR_RELOCATED", "cell"]]);
  for (const [k, h] of HEADINGS.entries()) {
    const r = moved.anchors.get(`r${k}`);
    assert.ok(r?.kind === "range");
    assert.deepEqual([r.from, r.to, r.relocated], [h + 2, h + 5, true]);
  }
  const c = moved.anchors.get("cell");
  assert.ok(c?.kind === "range");
  assert.deepEqual([c.parentPath, c.from, c.to], [[13, 1], 1, 4]);

  // 앞에 문단 삽입 + 같은 글을 다른 곳에 복제 → 지문이 두 곳 → ANCHOR_AMBIGUOUS
  const dup = reparse(
    done(generate(base, tpl([line(doc, "p1", [1]), line(doc, "p46", [46])], [insertText("i", "p1", "끼운 문단", "after"), inject("c", "p46", fragOf(doc, 18, 21), "after")]), ds({}), KEEP)).output,
  );
  assert.deepEqual(resolveAnchors(dup, tpl([at(ranges, 0)], [])).issues.map((i) => [i.severity, i.code]), [["error", "ANCHOR_AMBIGUOUS"]]);

  // 범위 끝 문단 삭제 → 첫 문단은 있지만 끝 문단이 없다 → ANCHOR_NOT_FOUND
  const endGone = reparse(done(generate(base, tpl([line(doc, "p21", [21])], [del("d", "p21")]), ds({}), KEEP)).output);
  assert.deepEqual(resolveAnchors(endGone, tpl([at(ranges, 0)], [])).issues.map((i) => [i.severity, i.code]), [["error", "ANCHOR_NOT_FOUND"]]);

  // 안쪽 문단 글 변경 → 양 끝은 맞고 안쪽 해시가 다르다 → ANCHOR_CHANGED
  const word = makeWordAnchor(doc, "w", 0, [19], 0, 3);
  assert.ok(word !== undefined);
  const inner = reparse(done(generate(base, tpl([word], [{ id: "f", do: { type: "fill", anchor: "w", value: { text: "바뀐" } } }]), ds({}), KEEP)).output);
  assert.deepEqual(resolveAnchors(inner, tpl([at(ranges, 0)], [])).issues.map((i) => [i.severity, i.code]), [["error", "ANCHOR_CHANGED"]]);
  // 안쪽에 문단 추가 → 문단 수가 달라도 양 끝이 있으면 ANCHOR_CHANGED
  const grown = reparse(done(generate(base, tpl([line(doc, "p19", [19])], [insertText("i", "p19", "더한 문단", "after")]), ds({}), KEEP)).output);
  assert.deepEqual(resolveAnchors(grown, tpl([at(ranges, 0)], [])).issues.map((i) => [i.severity, i.code]), [["error", "ANCHOR_CHANGED"]]);

  // 없는 구역
  assert.deepEqual(resolveAnchors(doc, tpl([{ ...at(ranges, 0), at: { sectionIndex: 3, parentPath: [] } }], [])).issues.map((i) => i.code), ["ANCHOR_NOT_FOUND"]);

  // 생성: 오류 상태는 막고, relocated는 경고와 함께 새 자리를 지운다
  const r0 = at(ranges, 0);
  assert.deepEqual(failed(generate(done(generate(base, tpl([line(doc, "p19", [19])], [insertText("i", "p19", "x", "after")]), ds({}), KEEP)).output, tpl([r0], [del("d", r0.id)]), ds({}), KEEP)), ["ANCHOR_CHANGED"]);
  const shiftedBytes = done(generate(base, tpl([line(doc, "p1", [1])], [insertText("i", "p1", "끼운 문단", "after")]), ds({}), KEEP)).output;
  const ok = done(generate(shiftedBytes, tpl([r0], [del("d", r0.id)]), ds({}), KEEP));
  assert.deepEqual(ok.report.plan.relocated.map((x) => x.anchor), [r0.id]);
  assert.deepEqual(texts(top(reparse(ok.output))), [...texts(top(shifted)).slice(0, 19), ...texts(top(shifted)).slice(23)]);
  assert.deepEqual(ok.report.plan.moves, [move(19, 22, 0)]);
});

// ── 교체·삭제 ─────────────────────────────────────────────────

test("7.10 본문 범위(길이 2~20)를 조각(표 포함)·글로 교체하고 지운다: 문단·표 수, 이동표, 범위 밖 글 보존, 게이트, 결정성", () => {
  const base = notice();
  const doc = reparse(base);
  const before = texts(top(doc));
  const blocks = reparse(readFixture("hancom/blocks"));
  const tableFrag = fragOf(blocks, 3, 4); // 본문 문단 + 3×3 표
  const fragTexts = texts(top(blocks).slice(3, 5));
  const longLines = [
    `첫 줄 ${"긴 문장이 이어집니다. ".repeat(12)}`,
    "둘째 줄: 특수 문자 & < > \" ' 와 따옴표", // insertText 값은 탭을 받지 않는다(VALUE_CONTROL_CHAR, 8.3)
    `셋째 줄 ${"끝맺음. ".repeat(30)}`,
  ];
  const cases: [number, number][] = [[18, 19], [23, 27], [5, 14], [25, 44], [47, 62], [1, 20], [40, 46]];
  let runs = 0;
  for (const [from, to] of cases) {
    const len = to - from + 1;
    assert.ok(len >= 2 && len <= 20);
    const removedTables = tablesIn(top(doc).slice(from, to + 1));
    const variants: { rule: unknown; inserted: string[]; tables: number }[] = [
      { rule: inject("x", "r", tableFrag), inserted: fragTexts, tables: 1 },
      { rule: insertText("x", "r", longLines.join("\n")), inserted: longLines, tables: 0 },
      { rule: del("x", "r"), inserted: [], tables: 0 },
    ];
    for (const v of variants) {
      const t = tpl([range(doc, "r", from, to)], [v.rule]);
      const r = done(generate(base, t, ds({}), KEEP));
      const out = reparse(r.output);
      const want = [...before.slice(0, from), ...v.inserted, ...before.slice(to + 1)];
      assert.deepEqual(texts(top(out)), want, `${from}~${to}`);
      assert.equal(tablesIn(top(out)), tablesIn(top(doc)) - removedTables + v.tables);
      assert.deepEqual(r.report.plan.moves, [move(from, to, v.inserted.length)]);
      assert.equal(remapHolds(r.report.plan.moves, before, out), len);
      gateClean(base, r);
      assert.ok(bytesEqual(done(generate(base, t, ds({}), KEEP)).output, r.output), "같은 입력은 같은 바이트");
      runs++;
    }
  }
  assert.equal(runs, 21);
});

test("7.10 range 앵커의 before·after: 첫 문단 앞·끝 문단 뒤에 넣고 이동표는 빈 범위(to = from − 1)", () => {
  const base = notice();
  const doc = reparse(base);
  const before = texts(top(doc));
  const blocks = reparse(readFixture("hancom/blocks"));
  const t = tpl([range(doc, "r", 18, 21)], [inject("b", "r", fragOf(blocks, 3, 4), "before"), insertText("a", "r", "뒤 1\n뒤 2\n뒤 3", "after")]);
  const r = done(generate(base, t, ds({}), KEEP));
  const out = reparse(r.output);
  assert.deepEqual(texts(top(out)), [...before.slice(0, 18), "선택 조항 본문입니다. (해당 시)", OBJ, ...before.slice(18, 22), "뒤 1", "뒤 2", "뒤 3", ...before.slice(22)]);
  assert.deepEqual(r.report.plan.moves, [move(18, 17, 2), move(22, 21, 3)]);
  assert.equal(remapHolds(r.report.plan.moves, before, out), 0);
  gateClean(base, r);
  // 구역 설정 문단으로 시작하는 범위 앞 삽입은 경고만
  const s = done(generate(base, tpl([range(doc, "r", 0, 2)], [insertText("b", "r", "맨 앞", "before")]), ds({}), KEEP));
  assert.deepEqual(s.report.issues.filter((i) => i.code === "FILL_BEFORE_SECPR").length, 1);
});

test("7.10 표 칸 안 범위(같은 하위 목록): 조각(표 포함)·글 교체·삭제, 칸의 문단을 전부 지우면 FILL_LAST_PARAGRAPH", () => {
  const base = notice();
  const doc = reparse(base);
  const cellBefore = texts(listOf(doc, [12, 1]));
  const blocks = reparse(readFixture("hancom/blocks"));
  const cases: { rule: unknown; from: number; to: number; inserted: string[] }[] = [
    { rule: inject("x", "r", fragOf(blocks, 3, 4)), from: 1, to: 4, inserted: ["선택 조항 본문입니다. (해당 시)", OBJ] },
    { rule: insertText("x", "r", "가\n나"), from: 1, to: 3, inserted: ["가", "나"] },
    { rule: del("x", "r"), from: 1, to: 5, inserted: [] },
    { rule: insertText("x", "r", "전부 교체"), from: 0, to: 5, inserted: ["전부 교체"] },
  ];
  for (const c of cases) {
    const r = done(generate(base, tpl([range(doc, "r", c.from, c.to, [12, 1])], [c.rule]), ds({}), KEEP));
    const out = reparse(r.output);
    assert.deepEqual(texts(listOf(out, [12, 1])), [...cellBefore.slice(0, c.from), ...c.inserted, ...cellBefore.slice(c.to + 1)]);
    assert.deepEqual(texts(top(out)), texts(top(doc)), "최상위 문단 글은 그대로");
    assert.deepEqual(r.report.plan.moves, [move(c.from, c.to, c.inserted.length, [12, 1])]);
    assert.equal(remapHolds(r.report.plan.moves, cellBefore, out, [12, 1]), c.to - c.from + 1);
    gateClean(base, r);
  }
  assert.deepEqual(failed(generate(base, tpl([range(doc, "r", 0, 5, [12, 1])], [del("x", "r")]), ds({}), KEEP)), ["FILL_LAST_PARAGRAPH"]);
});

test("7.10 구역 설정(secPr) 문단이 든 범위의 교체·삭제는 FILL_SECTION_PROPS, 누름틀을 자르는 범위는 FRAG_SPLITS_FIELD", () => {
  const base = notice();
  const doc = reparse(base);
  const blocks = reparse(readFixture("hancom/blocks"));
  for (const rule of [del("x", "r"), inject("x", "r", fragOf(blocks, 1, 1)), insertText("x", "r", "글")]) {
    assert.deepEqual(failed(generate(base, tpl([range(doc, "r", 0, 3)], [rule]), ds({}), KEEP)), ["FILL_SECTION_PROPS"]);
  }
  // 여러 문단에 걸친 누름틀: 시작 [1]·끝 [3]. 범위 [2..3]은 끝만 담아 자른다, [1..3]은 통째로 담는다
  const spanBytes = readFixture("span/field-span");
  const span = reparse(spanBytes);
  for (const rule of [del("x", "r"), insertText("x", "r", "글"), inject("x", "r", fragOf(blocks, 1, 1))]) {
    assert.deepEqual(failed(generate(spanBytes, tpl([range(span, "r", 2, 3)], [rule]), ds({}), KEEP)), ["FRAG_SPLITS_FIELD"]);
    assert.deepEqual(failed(generate(spanBytes, tpl([range(span, "r", 1, 2)], [rule]), ds({}), KEEP)), ["FRAG_SPLITS_FIELD"]);
  }
  const whole = done(generate(spanBytes, tpl([range(span, "r", 1, 3)], [del("x", "r")]), ds({}), KEEP));
  assert.deepEqual(texts(top(reparse(whole.output))), [texts(top(span))[0], texts(top(span))[4]]);
  assert.equal(listFields(reparse(whole.output)).length, 0);
  gateClean(spanBytes, whole);
});

test("7.10 range 앵커를 받지 않는 액션(fill·tableProps·resize·repeat)과 delete의 scope는 TPL_RULE(규칙마다 한 번)", () => {
  const base = notice();
  const doc = reparse(base);
  const rules = [
    { id: "f", do: { type: "fill", anchor: "r", value: { text: "x" } } },
    { id: "t", do: { type: "tableProps", anchor: "r", table: { treatAsChar: false } } },
    { id: "z", do: { type: "resize", anchor: "r", scale: 0.9 } },
    { id: "p", do: { type: "repeat", anchor: "r", each: { path: "items" } } },
    { id: "d", do: { type: "delete", anchor: "r", scope: "row" } },
  ];
  for (const rule of rules) {
    const r = generate(base, tpl([range(doc, "r", 18, 21)], [rule]), ds({ items: [] }), KEEP);
    assert.deepEqual(failed(r), ["TPL_RULE"], rule.id);
  }
});

test("7.10 범위 안의 {{}}·누름틀·메일 머지 필드 암묵 채움은 dropped, 범위 밖의 같은 이름은 채운다", () => {
  const base = notice();
  const doc = reparse(base);
  const next = rng(7);
  const data = dataFor(doc, () => longValue(next, 200, 600));
  // [8]=메일 머지(재공고), [9]=누름틀 성명, [10]=누름틀 소속, [11]={{project.*}}. 복사본의 같은 문단 [54..57]은 그대로 채운다
  const t = tpl([range(doc, "r", 8, 11)], [insertText("x", "r", "교체한 글")]);
  const r = done(generate(base, t, ds(data)));
  const dropped = r.report.plan.dropped.filter((d) => d.ruleId === "implicit").map((d) => d.anchor);
  for (const name of ["merge:재공고", "field:성명", "field:소속", "{{project.name}}", "{{project.start}}", "{{project.end}}"]) assert.ok(dropped.includes(name), `${name} dropped`);
  const targets = (anchor: string) => r.report.plan.actions.find((a) => a.ruleId === "implicit" && a.anchor === anchor)?.targets;
  assert.equal(targets("field:성명"), 1);
  assert.equal(targets("field:소속"), 1);
  assert.equal(targets("{{project.name}}"), 1);
  const out = reparse(r.output);
  const names = (d: HwpxDocument, n: string) => listFields(d).filter((f) => f.name === n).length;
  assert.equal(names(doc, "성명"), 2);
  assert.equal(names(out, "성명"), 1);
  // 범위 밖은 채워져 {{경로}}가 남지 않는다(메일 머지 표시 글 포함)
  assert.deepEqual(walkTexts(top(out)).flatMap((x) => findPlaceholders(x).map((p) => p.path)), []);
  gateClean(base, r);
});

test("7.10 값이 비어 글 교체(insertText replace)를 건너뛰면 범위·문단은 그대로이고 안의 {{}}·누름틀은 채운다(이동표 없음). range·line 앵커", () => {
  const base = notice();
  const doc = reparse(base);
  const next = rng(17);
  const data = dataFor(doc, () => longValue(next, 100, 400));
  // 기준: 같은 데이터로 규칙 없이 채운 결과
  const filled = done(generate(base, tpl([], []), ds(data), KEEP));
  const want = texts(top(reparse(filled.output)));
  const fieldTargets = (r: { report: { plan: { actions: { ruleId: string; anchor: string; targets: number }[] } } }, anchor: string) =>
    r.report.plan.actions.find((a) => a.ruleId === "implicit" && a.anchor === anchor)?.targets;
  const cases: { name: string; anchors: unknown[]; value: unknown; options: Parameters<typeof generate>[3] }[] = [
    // [18..21]=본문 4개({{기관명}}·{{사업명}}), [8..13]=메일 머지·누름틀·{{project.*}}·표(칸 안 {{담당자}}), [9]=누름틀 성명
    { name: "range keep", anchors: [range(doc, "r", 18, 21)], value: { path: "nothing.here" }, options: KEEP },
    { name: "range empty", anchors: [range(doc, "r", 8, 13)], value: { path: "nothing.here" }, options: { missing: "empty" } },
    { name: "range 빈 글", anchors: [range(doc, "r", 8, 13)], value: { text: "" }, options: KEEP },
    { name: "line keep", anchors: [line(doc, "r", [9])], value: { path: "nothing.here" }, options: KEEP },
    { name: "line 빈 글", anchors: [line(doc, "r", [19])], value: { text: "" }, options: KEEP },
  ];
  for (const c of cases) {
    const rule = { id: "x", do: { type: "insertText", anchor: "r", position: "replace", value: c.value, style: "inherit" } };
    const r = done(generate(base, tpl(c.anchors, [rule]), ds(data), c.options));
    const out = reparse(r.output);
    assert.deepEqual(texts(top(out)), want, c.name);
    assert.deepEqual(r.report.plan.moves, [], c.name);
    // 버린 자리는 기준과 같다(메일 머지 표시 글 안의 {{}}만)
    assert.deepEqual(r.report.plan.dropped, filled.report.plan.dropped, `${c.name}: 버린 자리`);
    assert.equal(fieldTargets(r, "field:성명"), 2, c.name);
    assert.equal(fieldTargets(r, "{{기관명}}"), fieldTargets(filled, "{{기관명}}"), c.name);
    assert.deepEqual(walkTexts(top(out)).flatMap((x) => findPlaceholders(x).map((p) => p.path)), [], c.name);
    gateClean(base, r);
  }
  // 값이 있으면 지금처럼 교체한다(같은 범위 안 자리는 dropped)
  const replaced = done(generate(base, tpl([range(doc, "r", 18, 21)], [insertText("x", "r", "교체")]), ds(data), KEEP));
  assert.deepEqual(replaced.report.plan.moves, [move(18, 21, 1)]);
  assert.ok(replaced.report.plan.dropped.some((d) => d.anchor === "{{기관명}}"));
});

test("7.10 범위와 겹치는 다른 규칙은 규칙 순서와 상관없이 TPL_CONFLICT, 같은 범위의 앞 삽입 + 교체는 함께 쓴다", () => {
  const base = notice();
  const doc = reparse(base);
  const word = makeWordAnchor(doc, "w20", 0, [20], 0, 3);
  assert.ok(word !== undefined);
  const others = {
    lineFill: { anchors: [line(doc, "l19", [19])], rule: { id: "o", do: { type: "fill", anchor: "l19", value: { text: "x" } } } },
    wordFill: { anchors: [word], rule: { id: "o", do: { type: "fill", anchor: "w20", value: { text: "x" } } } },
    lineDelete: { anchors: [line(doc, "l21", [21])], rule: del("o", "l21") },
    injectBefore: { anchors: [line(doc, "l18", [18])], rule: insertText("o", "l18", "x", "before") },
    overlapDelete: { anchors: [range(doc, "r2", 20, 25)], rule: del("o", "r2") },
    sameReplace: { anchors: [], rule: inject("o", "r", fragOf(doc, 30, 30)) },
    innerRange: { anchors: [range(doc, "r3", 19, 20)], rule: insertText("o", "r3", "x", "after") },
  };
  for (const [name, o] of Object.entries(others)) {
    for (const order of ["first", "last"]) {
      const main = insertText("x", "r", "교체");
      const rules = order === "first" ? [o.rule, main] : [main, o.rule];
      const r = generate(base, tpl([range(doc, "r", 18, 21), ...o.anchors], rules), ds({}), KEEP);
      assert.deepEqual(failed(r), ["TPL_CONFLICT"], `${name} ${order}`);
    }
  }
  // 누름틀 앵커(대상이 범위 안)·표 앵커(표가 범위 안)
  const fieldRule = { id: "o", do: { type: "fill", anchor: "f", value: { text: "x" } } };
  assert.deepEqual(failed(generate(base, tpl([range(doc, "r", 8, 11), { id: "f", kind: "field", name: "성명", occurrence: 0 }], [insertText("x", "r", "교체"), fieldRule]), ds({}), KEEP)), ["TPL_CONFLICT"]);
  const table = makeObjectAnchor(doc, "tbl", 0, 0);
  assert.ok(table !== undefined);
  assert.deepEqual(
    failed(generate(base, tpl([range(doc, "r", 11, 13), { id: "t", ...table }], [del("x", "r"), { id: "o", do: { type: "tableProps", anchor: "t", table: { treatAsChar: false } } }]), ds({}), KEEP)),
    ["TPL_CONFLICT"],
  );
  // 같은 범위: 앞 삽입 + 교체(조각)는 함께 쓴다
  const before = texts(top(doc));
  const ok = done(generate(base, tpl([range(doc, "r", 18, 21)], [inject("b", "r", fragOf(doc, 30, 30), "before"), inject("x", "r", fragOf(doc, 40, 41))]), ds({}), KEEP));
  assert.deepEqual(texts(top(reparse(ok.output))), [...before.slice(0, 18), at(before, 30), at(before, 40), at(before, 41), ...before.slice(22)]);
  assert.deepEqual(ok.report.plan.moves, [move(18, 17, 1), move(18, 21, 2)]);
  gateClean(base, ok);
  // 구현의 선택: 글 교체(insertText replace)는 주 계획에서 범위를 지우므로 같은 범위의 다른 삽입과는 TPL_CONFLICT
  assert.deepEqual(failed(generate(base, tpl([range(doc, "r", 18, 21)], [inject("b", "r", fragOf(doc, 30, 30), "before"), insertText("x", "r", "교체")]), ds({}), KEEP)), ["TPL_CONFLICT"]);
});

test("7.10 여러 범위를 한 계획에서 교체·삭제한다(규칙 순서와 무관하게 문서 순서의 이동표, 누적 변환)", () => {
  const base = notice();
  const doc = reparse(base);
  const before = texts(top(doc));
  const blocks = reparse(readFixture("hancom/blocks"));
  const rich = reparse(readFixture("tables/tables-rich"));
  const t = tpl(
    [range(doc, "a", 2, 4), range(doc, "b", 18, 21), range(doc, "c", 33, 40), range(doc, "d", 47, 50), range(doc, "e", 2, 5, [12, 1])],
    [inject("D", "d", fragOf(rich, 1, 1)), del("A", "a"), insertText("C", "c", "씨 1\n씨 2\n씨 3"), inject("B", "b", fragOf(blocks, 3, 4)), del("E", "e")],
  );
  const r = done(generate(base, t, ds({}), KEEP));
  const out = reparse(r.output);
  assert.deepEqual(texts(top(out)), [
    ...before.slice(0, 2),
    ...before.slice(5, 18),
    "선택 조항 본문입니다. (해당 시)",
    OBJ,
    ...before.slice(22, 33),
    "씨 1",
    "씨 2",
    "씨 3",
    ...before.slice(41, 47),
    OBJ,
    ...before.slice(51),
  ]);
  assert.deepEqual(r.report.plan.moves, [move(2, 4, 0), move(2, 5, 0, [12, 1]), move(18, 21, 2), move(33, 40, 3), move(47, 50, 1)]);
  assert.equal(remapHolds(r.report.plan.moves, before, out), 3 + 4 + 8 + 4);
  const cellBefore = texts(listOf(doc, [12, 1]));
  assert.equal(remapHolds(r.report.plan.moves, cellBefore, out, [12, 1]), 4);
  // 칸 안 주소는 상위 표 문단의 이동까지 함께 옮긴다: [12, 1, 1] → [9, 1, 1]
  assert.deepEqual(remapAddress(r.report.plan.moves, { sectionIndex: 0, path: [12, 1, 1] }), { sectionIndex: 0, path: [9, 1, 1] });
  assert.equal(tablesIn(top(out)), 4 - 0 + 1 + 1);
  gateClean(base, r);
  assert.ok(bytesEqual(done(generate(base, t, ds({}), KEEP)).output, r.output));
});

test("7.10 remapAddress: i < from 그대로, i > to는 + (count − 길이), 덮이면 undefined, 하위 경로는 단계마다 옮긴다", () => {
  const moves: Move[] = [move(5, 7, 2), move(10, 9, 3), move(0, 0, 2, [12, 1]), { ...move(3, 3, 0), sectionIndex: 1 }];
  const m = (path: number[], sectionIndex = 0) => remapAddress(moves, { sectionIndex, path })?.path;
  assert.deepEqual(m([4]), [4]);
  for (const i of [5, 6, 7]) assert.equal(m([i]), undefined);
  assert.deepEqual(m([8]), [7]);
  assert.deepEqual(m([9]), [8]);
  assert.deepEqual(m([10]), [12]);
  assert.deepEqual(m([12, 1, 0]), undefined, "칸 안 문단 0은 덮였다");
  assert.deepEqual(m([12, 1, 3]), [14, 1, 4]);
  assert.deepEqual(m([12, 0, 3]), [14, 0, 3], "다른 칸은 첫 번호만");
  assert.deepEqual(m([6, 0, 0]), undefined, "상위 문단이 덮이면 하위도 없어진다");
  // 다른 구역의 항목은 그 구역 주소만 옮긴다
  assert.deepEqual(m([2], 1), [2]);
  assert.deepEqual(m([3], 1), undefined);
  assert.deepEqual(m([4], 1), [3]);
  assert.deepEqual(m([10], 1), [9]);
});

test("7.10 md·txt 문서의 range 앵커는 ANCHOR_NOT_FOUND", () => {
  const draft = makeRangeAnchor(reparse(notice()), 0, [], 18, 21);
  assert.ok(draft !== undefined);
  const r = generateText("# 제목\n\n본문\n", "md", tpl([{ id: "r", ...draft }], [del("x", "r")]), ds({}));
  assert.equal(r.ok, false);
  assert.deepEqual(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code), ["ANCHOR_NOT_FOUND"]);
});

// ── 공고서 조각 교체 실험(검증 기준 17절)의 재현 ─────────────────────

test("7.10 제목 사이 범위를 조각으로 뽑아 다른 문서의 제목 사이 범위와 바꾼다(소스 12 × 대상 4 = 48회): 게이트·새 오류 0·글 순서·제목 유지", () => {
  const sources: [string, number, number][] = [
    ["hancom/blocks", 1, 1],
    ["hancom/blocks", 3, 4],
    ["tables/tables-rich", 1, 1],
    ["tables/tables-nested", 1, 1],
    ["tables/tables-merged", 1, 1],
    ["tables/tables-inline", 1, 2],
    ["span/field-span", 1, 3],
    ["span/field-span-table", 1, 3],
    ["span/field-span-cell", 1, 1],
    ["merge/merge-fields", 1, 11],
    ["merge/merge-fields", 13, 14],
    ["merge/merge-fields", 12, 15],
  ];
  const targets: [Uint8Array, number, number][] = [
    [readFixture("hancom/blocks"), 1, 1], // "1. 개요" ~ "2. 선택 조항" 사이
    [readFixture("hancom/blocks"), 3, 4], // "2. 선택 조항" ~ "3. 끝" 사이(표 포함)
    [notice(), 18, 21],
    [notice(), 28, 31],
  ];
  const isHeading = (t: string): boolean => /^(?:￼*)\d\. /.test(t);
  let ok = 0;
  for (const [name, sf, st] of sources) {
    const src = reparse(readFixture(name));
    const frag = fragOf(src, sf, st);
    const fragTop = texts(top(src).slice(sf, st + 1));
    const fragTables = tablesIn(top(src).slice(sf, st + 1));
    for (const [bytes, from, to] of targets) {
      const doc = reparse(bytes);
      const before = texts(top(doc));
      const r = done(generate(bytes, tpl([range(doc, "r", from, to)], [inject("x", "r", frag)]), ds({}), KEEP));
      const out = reparse(r.output);
      const after = texts(top(out));
      assert.deepEqual(after, [...before.slice(0, from), ...fragTop, ...before.slice(to + 1)], `${name} → ${from}~${to}`);
      assert.deepEqual(after.filter(isHeading), [...before.slice(0, from), ...before.slice(to + 1)].filter(isHeading));
      assert.equal(tablesIn(top(out)), tablesIn(top(doc)) - tablesIn(top(doc).slice(from, to + 1)) + fragTables);
      assert.deepEqual(r.report.plan.moves, [move(from, to, st - sf + 1)]);
      gateClean(bytes, r);
      ok++;
    }
  }
  assert.equal(ok, 48);
});

// ── cell·object 선택 지문 ─────────────────────────────────────

test("7.10 cell·object 선택 지문: 표를 앞에 넣어도 지문 있는 앵커는 원래 표를 다시 찾고(경고), 지문 없는 앵커는 서수대로(1판)", () => {
  const blocksBytes = readFixture("hancom/blocks");
  const blocks = reparse(blocksBytes);
  const merged = reparse(readFixture("tables/tables-merged"));
  // 원래 표(3×3)의 앞 문단 [3] 뒤에 다른 표(4×3)를 넣는다 → 원래 표는 서수 1
  const shiftedBytes = done(generate(blocksBytes, tpl([line(blocks, "p3", [3])], [inject("t", "p3", fragOf(merged, 1, 1), "after")]), ds({}), KEEP)).output;
  const shifted = reparse(shiftedBytes);

  const table = at(blocks.sections, 0).paragraphs[4]?.objects.find((o) => isTableNode(o));
  assert.ok(table !== undefined && isTableNode(table));
  const cellText = (c: TableCell) => texts(c.subList?.paragraphs ?? []).join("\n");

  const cells = table.cells.map((c) => {
    const a = makeCellAnchor(blocks, 0, 0, c.row, c.col);
    assert.ok(a !== undefined && a.print !== undefined);
    // 표 모양·셀 글 해시는 명세대로(셀 글 = 셀 문단 글을 줄바꿈으로 이음). 첫 행 해시(head)의 직렬화는 명세가 정하지 않으므로 표마다 같은 64자 해시인지만 본다
    assert.deepEqual([a.print.rows, a.print.cols, a.print.text], [3, 3, sha256Hex(utf8(cellText(c)))]);
    assert.match(a.print.head, /^[0-9a-f]{64}$/);
    return { id: `c${c.row}${c.col}`, ...a };
  });
  assert.equal(new Set(cells.map((c) => c.print?.head)).size, 1);
  const otherHead = makeCellAnchor(merged, 0, 0, 0, 0)?.print?.head;
  assert.ok(otherHead !== undefined && otherHead !== at(cells, 0).print?.head, "첫 행이 다른 표는 head가 다르다");
  const obj = makeObjectAnchor(blocks, "tbl", 0, 0);
  assert.ok(obj !== undefined);
  assert.equal(obj.print?.objectType, "tbl");
  assert.equal(obj.print?.count, 9);
  assert.ok((obj.print?.width ?? 0) > 0 && (obj.print?.height ?? 0) > 0);

  // 같은 문서: exact(이슈 없음)
  const same = resolveAnchors(blocks, tpl([...cells, { id: "o", ...obj }], []));
  assert.deepEqual(same.issues, []);

  // 표를 앞에 넣은 문서: 지문 있는 앵커 9 + 1개 모두 경고와 함께 원래 표로
  const res = resolveAnchors(shifted, tpl([...cells, { id: "o", ...obj }], []));
  assert.deepEqual(res.issues.map((i) => [i.severity, i.code]), Array.from({ length: 10 }, () => ["warning", "ANCHOR_RELOCATED"]));
  const original = at(shifted.sections, 0).paragraphs.flatMap((p) => p.objects.filter((o) => isTableNode(o)))[1];
  for (const c of cells) {
    const found = res.anchors.get(c.id);
    assert.ok(found?.kind === "cell");
    assert.equal(found.table.element, original?.element);
    assert.equal(cellText(found.cell), cellText(at(table.cells.filter((x) => x.row === c.row && x.col === c.col), 0)));
  }
  const o = res.anchors.get("o");
  assert.ok(o?.kind === "object");
  assert.equal(o.object.element, original?.element);

  // 지문 없는 앵커(1판): 서수 0 = 새로 넣은 표, 이슈 없음
  const { print: _p, ...bare } = at(cells, 0);
  const plain = resolveAnchors(shifted, tpl([bare], []));
  assert.deepEqual(plain.issues, []);
  const p0 = plain.anchors.get(bare.id);
  assert.ok(p0?.kind === "cell");
  assert.notEqual(p0.table.element, original?.element);

  // 채움: 지문 있는 칸 9곳에 긴 값을 넣으면 원래 표에 들어가고 새 표는 그대로
  const next = rng(11);
  const values = cells.map(() => longValue(next, 150, 400));
  const r = done(generate(shiftedBytes, tpl(cells, cells.map((c, k) => ({ id: `f${k}`, do: { type: "fill", anchor: c.id, value: { text: values[k] } } }))), ds({}), KEEP));
  const out = reparse(r.output);
  const tablesOut = at(out.sections, 0).paragraphs.flatMap((p) => p.objects.filter((x) => isTableNode(x)));
  const filled = tablesOut[1];
  assert.ok(filled !== undefined && isTableNode(filled));
  cells.forEach((c, k) => assert.equal(cellText(at(filled.cells.filter((x) => x.row === c.row && x.col === c.col), 0)), values[k]));
  const inserted = tablesOut[0];
  assert.ok(inserted !== undefined && isTableNode(inserted));
  const mergedTable = at(merged.sections, 0).paragraphs[1]?.objects.find((x) => isTableNode(x));
  assert.ok(mergedTable !== undefined && isTableNode(mergedTable));
  assert.deepEqual(inserted.cells.map(cellText), mergedTable.cells.map(cellText));
  assert.equal(r.report.plan.relocated.length, 9);
  gateClean(shiftedBytes, r);
});

test("7.10 cell·object 선택 지문: 같은 표가 둘이면 ANCHOR_AMBIGUOUS, 셀 글이 바뀌었거나 표가 없으면 ANCHOR_NOT_FOUND", () => {
  const blocksBytes = readFixture("hancom/blocks");
  const blocks = reparse(blocksBytes);
  const merged = reparse(readFixture("tables/tables-merged"));
  const cell = makeCellAnchor(blocks, 0, 0, 1, 1);
  const obj = makeObjectAnchor(blocks, "tbl", 0, 0);
  assert.ok(cell !== undefined && obj !== undefined);
  const t = tpl([{ id: "c", ...cell }, { id: "o", ...obj }], []);
  // 다른 표를 앞에 넣고 원래 표를 하나 더 복제 → 서수 0은 다른 표, 지문이 맞는 표가 둘
  const dup = reparse(
    done(generate(blocksBytes, tpl([line(blocks, "p3", [3]), line(blocks, "p5", [5])], [inject("t", "p3", fragOf(merged, 1, 1), "after"), inject("u", "p5", fragOf(blocks, 4, 4), "after")]), ds({}), KEEP)).output,
  );
  assert.deepEqual(resolveAnchors(dup, t).issues.map((i) => [i.where, i.code]), [["c", "ANCHOR_AMBIGUOUS"], ["o", "ANCHOR_AMBIGUOUS"]]);
  // 셀 글을 바꾼 문서(1판 앵커로 채움) → 지문이 맞는 셀이 없다
  const changed = reparse(
    done(generate(blocksBytes, tpl([{ id: "x", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 1 }], [{ id: "f", do: { type: "fill", anchor: "x", value: { text: "바뀐 칸" } } }]), ds({}), KEEP))
      .output,
  );
  assert.deepEqual(resolveAnchors(changed, t).issues.map((i) => [i.where, i.code]), [["c", "ANCHOR_NOT_FOUND"]]);
  // 표를 지운 문서 → 둘 다 없음
  const gone = reparse(done(generate(blocksBytes, tpl([{ id: "x", kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 0 }], [del("d", "x")]), ds({}), KEEP)).output);
  assert.deepEqual(resolveAnchors(gone, t).issues.map((i) => [i.where, i.code]), [["c", "ANCHOR_NOT_FOUND"], ["o", "ANCHOR_NOT_FOUND"]]);
  // 생성은 막는다
  assert.deepEqual(failed(generate(dup.pkg.bytes, tpl([{ id: "c", ...cell }], [{ id: "f", do: { type: "fill", anchor: "c", value: { text: "x" } } }]), ds({}), KEEP)), ["ANCHOR_AMBIGUOUS"]);
});

// ── 무작위 ─────────────────────────────────────────────────────

test("7.10 무작위 60회: 범위(길이 1~20)·위치·조각·액션과 긴 값(자리 수십 개)을 바꿔 결정성·게이트·새 오류 0·이동표·범위 밖 글을 본다", () => {
  const base = notice();
  const doc = reparse(base);
  const before = texts(top(doc));
  const pool: { frag: Record<string, unknown>; top: number; tables: number; walk: string[] | undefined }[] = [];
  const add = (src: HwpxDocument, from: number, to: number, plain: boolean): void => {
    const ps = top(src).slice(from, to + 1);
    pool.push({ frag: fragOf(src, from, to), top: ps.length, tables: tablesIn(ps), walk: plain ? walkTexts(ps) : undefined });
  };
  const blocks = reparse(readFixture("hancom/blocks"));
  add(blocks, 1, 1, true);
  add(blocks, 3, 4, true);
  add(reparse(readFixture("tables/tables-nested")), 1, 1, true);
  add(reparse(readFixture("tables/tables-merged")), 1, 1, true);
  add(reparse(readFixture("tables/tables-inline")), 1, 2, true);
  add(reparse(readFixture("tables/tables-rich")), 1, 1, false);
  add(reparse(readFixture("span/field-span")), 1, 3, false);
  add(doc, 18, 21, false);
  add(doc, 47, 53, false);

  // 데이터 3벌: 모든 자리에 긴 값(120~700자, 줄바꿈·탭·XML 특수 문자). 범위 밖 글의 기준은 같은 데이터로 범위 규칙 없이 채운 결과다
  const datasets = [1, 2, 3].map((seed) => {
    const next = rng(seed);
    const data = dataFor(doc, () => longValue(next, 120, 700));
    const filled = reparse(done(generate(base, tpl([], []), ds(data))).output);
    return { data, filled: texts(top(filled)) };
  });

  const next = rng(2026);
  const pick = (n: number): number => Math.floor(next() * n);
  let runs = 0;
  let multi = 0;
  for (let k = 0; k < 60; k++) {
    const set = at(datasets, k % datasets.length);
    // 겹치지 않는 범위 1~2개
    const spans: [number, number][] = [];
    const count = next() < 0.35 ? 2 : 1;
    while (spans.length < count) {
      const from = 1 + pick(62);
      const to = Math.min(62, from + pick(20));
      if (spans.every(([f, t]) => to < f || from > t)) spans.push([from, to]);
    }
    if (count === 2) multi++;
    const anchors: RangeAnchor[] = [];
    const rules: unknown[] = [];
    const want: { from: number; to: number; count: number; inserted?: string[]; walk?: string[]; tables: number }[] = [];
    spans.forEach(([from, to], j) => {
      anchors.push(range(doc, `r${j}`, from, to));
      const kind = pick(3);
      if (kind === 0) {
        const f = at(pool, pick(pool.length));
        rules.push(inject(`x${j}`, `r${j}`, f.frag));
        want.push({ from, to, count: f.top, ...(f.walk === undefined ? {} : { walk: f.walk }), tables: f.tables });
      } else if (kind === 1) {
        const lines = Array.from({ length: 1 + pick(5) }, () => longValue(next, 20, 300).replace(/[\n\t]/g, " ")); // insertText 값은 탭을 받지 않는다
        rules.push(insertText(`x${j}`, `r${j}`, lines.join("\n")));
        want.push({ from, to, count: lines.length, inserted: lines, tables: 0 });
      } else {
        rules.push(del(`x${j}`, `r${j}`));
        want.push({ from, to, count: 0, inserted: [], tables: 0 });
      }
    });
    const t = tpl(anchors, rules.reverse());
    const r = done(generate(base, t, ds(set.data)));
    gateClean(base, r);
    assert.ok(bytesEqual(done(generate(base, t, ds(set.data))).output, r.output), `회 ${k}: 결정성`);

    const sorted = [...want].sort((a, b) => a.from - b.from);
    assert.deepEqual(r.report.plan.moves, sorted.map((w) => move(w.from, w.to, w.count)), `회 ${k}: 이동표`);
    const out = reparse(r.output);
    const after = top(out);
    const delta = sorted.reduce((n, w) => n + w.count - (w.to - w.from + 1), 0);
    assert.equal(after.length, before.length + delta);
    // 범위 밖 문단은 같은 데이터로 채운 기준과 글이 같다(이동표로 옮긴 주소)
    const covered = remapHolds(r.report.plan.moves, before, out, [], (i) => at(set.filled, i));
    assert.equal(covered, sorted.reduce((n, w) => n + w.to - w.from + 1, 0));
    // 범위 자리의 새 내용
    let shift = 0;
    let tables = tablesIn(top(doc));
    for (const w of sorted) {
      const start = w.from + shift;
      const placed = after.slice(start, start + w.count);
      if (w.inserted !== undefined) assert.deepEqual(texts(placed), w.inserted, `회 ${k}`);
      if (w.walk !== undefined) assert.deepEqual(walkTexts(placed), w.walk, `회 ${k}`);
      tables += w.tables - tablesIn(top(doc).slice(w.from, w.to + 1));
      shift += w.count - (w.to - w.from + 1);
    }
    assert.equal(tablesIn(after), tables, `회 ${k}: 표 수`);
    runs++;
  }
  assert.equal(runs, 60);
  assert.ok(multi >= 10, `여러 범위 ${multi}회`);
});

// ── 1판 템플릿 읽기(readTemplate) ──────────────────────────────

const codeOf = (f: () => unknown): string | undefined => {
  try {
    f();
    return undefined;
  } catch (e) {
    if (e instanceof HwpxError) return e.code;
    throw e;
  }
};

test("7.10 readTemplate: range 앵커를 읽고(JSON 왕복 그대로) inject·insertText·delete 규칙이 받는다. 읽은 템플릿의 생성 결과는 직접 만든 템플릿과 같다", () => {
  const base = notice();
  const doc = reparse(base);
  const blocks = reparse(readFixture("hancom/blocks"));
  const rich = reparse(readFixture("tables/tables-rich"));
  const anchors = [range(doc, "a", 2, 4), range(doc, "b", 18, 21), range(doc, "c", 33, 40), range(doc, "d", 47, 50), range(doc, "e", 2, 5, [12, 1])];
  const rules = [
    inject("D", "d", fragOf(rich, 1, 1)),
    del("A", "a"),
    insertText("C", "c", "씨 1\n씨 2"),
    inject("B", "b", fragOf(blocks, 3, 4)),
    del("E", "e"),
    inject("F", "b", fragOf(blocks, 1, 1), "before"),
    insertText("G", "d", "뒤 글", "after"),
  ];
  const raw = JSON.parse(JSON.stringify({ schema: "hwpx-studio/template@1", anchors, rules })) as { anchors: unknown[] };
  const read = readTemplate(raw);
  assert.deepEqual(read.anchors, raw.anchors);
  const viaRead = done(generate(base, read, ds({}), KEEP));
  assert.ok(bytesEqual(viaRead.output, done(generate(base, tpl(anchors, rules), ds({}), KEEP)).output));
  gateClean(base, viaRead);
  // 지문의 sha256은 대문자도 받아 소문자로 둔다
  const upper = { ...at(anchors, 0), print: { ...at(anchors, 0).print, sha256: at(anchors, 0).print.sha256.toUpperCase() } };
  assert.deepEqual(readTemplate({ schema: "hwpx-studio/template@1", anchors: [upper] }).anchors, [at(anchors, 0)]);
});

test("7.10 readTemplate: 틀린 range 앵커는 TPL_ANCHOR, range를 받지 않는 액션과 delete의 scope는 TPL_RULE", () => {
  const doc = reparse(notice());
  const r = range(doc, "r", 18, 21);
  const withAnchor = (a: unknown, rules: unknown[] = []) => ({ schema: "hwpx-studio/template@1", anchors: [a], rules });
  const hex = "a".repeat(64);
  const bad: unknown[] = [
    { ...r, at: { sectionIndex: 0, parentPath: [12] } },
    { ...r, at: { sectionIndex: 0, parentPath: [-1, 0] } },
    { ...r, at: { sectionIndex: 0, parentPath: [1.5, 0] } },
    { ...r, at: { sectionIndex: 0, parentPath: "12,1" } },
    { ...r, at: { sectionIndex: 0, path: [18] } },
    { ...r, at: { sectionIndex: 0, parentPath: [], path: [18] } },
    { ...r, at: { parentPath: [] } },
    { ...r, from: -1 },
    { ...r, from: 22, to: 21 },
    { ...r, to: 22 },
    { ...r, print: undefined },
    { ...r, print: { ...r.print, sha256: "짧음" } },
    { ...r, print: { ...r.print, count: 0 } },
    { ...r, print: { ...r.print, first: { text: r.print.first.text } } },
    { ...r, print: { ...r.print, last: { ...r.print.last, extra: 1 } } },
    { ...r, print: { ...r.print, extra: 1 } },
    { ...r, extra: 1 },
    { ...r, print: { ...r.print, first: { text: 1, sha256: hex } } },
  ];
  for (const [k, a] of bad.entries()) assert.equal(codeOf(() => readTemplate(withAnchor(JSON.parse(JSON.stringify(a))))), "TPL_ANCHOR", `${k}`);
  const rules: unknown[] = [
    { id: "f", do: { type: "fill", anchor: "r", value: { text: "x" } } },
    { id: "t", do: { type: "tableProps", anchor: "r", table: { treatAsChar: false } } },
    { id: "z", do: { type: "resize", anchor: "r", scale: 0.9 } },
    { id: "p", do: { type: "repeat", anchor: "r", each: { path: "items" } } },
    { id: "d", do: { type: "delete", anchor: "r", scope: "row" } },
    { id: "i", do: { type: "inject", anchor: "r", position: "middle", fragment: "f.json" } },
  ];
  for (const rule of rules) assert.equal(codeOf(() => readTemplate(withAnchor(r, [rule]))), "TPL_RULE", JSON.stringify(rule));
});

test("7.10 readTemplate: cell·object 앵커의 선택 지문을 읽고(없으면 지금처럼), 틀린 지문은 TPL_ANCHOR", () => {
  const blocks = reparse(readFixture("hancom/blocks"));
  const cell = makeCellAnchor(blocks, 0, 0, 1, 1);
  const obj = makeObjectAnchor(blocks, "tbl", 0, 0);
  assert.ok(cell?.print !== undefined && obj?.print !== undefined);
  const c = { id: "c", ...cell };
  const o = { id: "o", ...obj };
  const withAnchors = (anchors: unknown[]) => ({ schema: "hwpx-studio/template@1", anchors });
  assert.deepEqual(readTemplate(withAnchors([c, o])).anchors, [c, o]);
  // 지문 없는 앵커는 지금처럼(키 없음)
  const { print: _c, ...bareCell } = c;
  const { print: _o, ...bareObj } = o;
  assert.deepEqual(readTemplate(withAnchors([bareCell, bareObj])).anchors, [bareCell, bareObj]);
  assert.ok(!("print" in (readTemplate(withAnchors([bareCell])).anchors[0] ?? {})));
  // 지문 있는 템플릿으로 생성: 같은 문서는 exact라 경고 없이 채운다
  const r = done(generate(readFixture("hancom/blocks"), readTemplate({ ...withAnchors([c]), rules: [{ id: "f", do: { type: "fill", anchor: "c", value: { text: "칸 값" } } }] }), ds({}), KEEP));
  assert.deepEqual(r.report.plan.relocated, []);
  const bad: unknown[] = [
    { ...c, print: { ...cell.print, rows: 0 } },
    { ...c, print: { ...cell.print, cols: -1 } },
    { ...c, print: { ...cell.print, head: "x" } },
    { ...c, print: { ...cell.print, text: undefined } },
    { ...c, print: { ...cell.print, extra: 1 } },
    { ...c, print: "지문" },
    { ...o, print: { ...obj.print, objectType: "pic" } },
    { ...o, print: { ...obj.print, width: -1 } },
    { ...o, print: { ...obj.print, count: 1.5 } },
    { ...o, print: { ...obj.print, extra: 1 } },
    { ...o, print: {} },
  ];
  for (const [k, a] of bad.entries()) assert.equal(codeOf(() => readTemplate(withAnchors([JSON.parse(JSON.stringify(a))]))), "TPL_ANCHOR", `${k}`);
});
