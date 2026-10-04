// 빠른 생성의 핵심(quick.ts): 자리 목록·대조표·건 나누기·건별 생성이 엔진 함수 결과와 같다(Q2의 핵심, Q3의 바이트 동치, Q4).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkValueText,
  collectFields,
  emptyTemplate,
  fieldFillBlock,
  findCandidates,
  findPlaceholders,
  generate,
  HwpxError,
  isValidPath,
  listFields,
  lookupPath,
  openPackage,
  parseDocument,
  planBatchNames,
  readDataset,
  scalarToText,
  walkParagraphs,
  type FieldTarget,
} from "../../../packages/hwpx-engine/src/index.ts";
import { HostError } from "../../../packages/viewer/src/host/index.ts";
import type { PlacesView } from "../src/api-types.ts";
import { MAX_RECORDS, analyzePlaces, countInvalidRecords, generateAll, listKeys, matchPlaces, parseQuickData } from "../src/quick.ts";
import { plainOf } from "../src/messages.ts";
import { FIELD_BEGIN, FIELD_END, P, PIC, R, T, TBL, synth } from "../../../packages/viewer/test/helpers.ts";
import { blockMessages, crossed, fixtureNames, mixedDoc, mutateSection, openCross, readFixture, secBetween } from "./helpers.ts";

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

// ── Q4: 자리 목록 = 엔진의 누름틀 목록·{{}} 탐지·후보 탐지 ─────────────

/** 엔진이 막는 곳의 분류(시험 쪽 기준): 여러 문단 곳은 crossBlocked, 그림·표가 든 곳은 object, 다른 칸·구역은 crossContainer, 나머지(끝 표식 없음 등)는 unpaired */
const blockedShape = (t: FieldTarget): string => (t.info.shape === "crossParagraph" ? "crossBlocked" : t.info.shape === "object" || t.info.shape === "crossContainer" ? t.info.shape : "unpaired");

// 자리로 세는 필드: 누름틀(CLICK_HERE, 키 = 이름)과 키가 있는 메일 머지 필드(키 = mergeKey). 엔진 암묵 채움과 같은 기준
const isPlaceField = (f: { type: string; mergeKey?: string }): boolean => f.type === "CLICK_HERE" || (f.type === "MAILMERGE" && f.mergeKey !== undefined);
const keyOf = (f: { type: string; name: string; mergeKey?: string }): string => (f.type === "CLICK_HERE" ? f.name : (f.mergeKey ?? ""));

test("Q4: 모든 시험 문서에서 자리 목록이 listFields(CLICK_HERE와 키 있는 메일 머지)·findCandidates와 같다", () => {
  const names = fixtureNames();
  assert.ok(names.length >= 20);
  let withFields = 0;
  let withPlaceholders = 0;
  for (const name of [...names, "합성"]) {
    const bytes = name === "합성" ? mixedDoc() : readFixture(name);
    const doc = parseDocument(openPackage(bytes));
    const places = analyzePlaces(bytes);

    // 곳마다 채울 수 있는지는 엔진의 fieldFillBlock이 정한다(데이터와 무관하다). 모양만 보면 여러 문단 곳이 막히는 경우를 놓친다
    const infos = listFields(doc).filter(isPlaceField);
    const targets = collectFields(doc).filter((t) => isPlaceField(t.info));
    assert.equal(targets.length, infos.length, `${name}: collectFields가 누름틀을 빠뜨리지 않는다`);
    const fieldNames = [...new Set(infos.map(keyOf))];
    const expected = fieldNames.map((n) => {
      const here = targets.filter((t) => keyOf(t.info) === n);
      const open = here.filter((t) => fieldFillBlock(t) === undefined);
      const shut = here.filter((t) => fieldFillBlock(t) !== undefined);
      const unfillable = (["object", "crossContainer", "unpaired", "crossBlocked"] as const).flatMap((shape): PlacesView["fields"][number]["unfillable"] => {
        const mine = shut.filter((t) => blockedShape(t) === shape);
        if (mine.length === 0) return [];
        return shape === "crossBlocked"
          ? [{ shape, count: mine.length, reasons: [...new Set(mine.flatMap((t) => fieldFillBlock(t)?.message ?? []))] }]
          : [{ shape, count: mine.length }];
      });
      assert.equal(open.length + unfillable.reduce((sum, u) => sum + u.count, 0), here.length, `${name}: ${n}: 곳 수`);
      return { name: n, count: here.length, usable: isValidPath(n), fillable: open.length, merging: open.filter((t) => t.info.shape === "crossParagraph").length, unfillable };
    });
    assert.deepEqual(places.fields, expected, `${name}: 누름틀`);

    // {{키}}는 후보 탐지(findCandidates)의 placeholder 항목에서 센다: 문서 순서의 목록을 키별로 묶으면 같아야 한다
    const keys = new Map<string, number>();
    for (const c of findCandidates(doc)) {
      if (c.kind !== "placeholder" || c.anchor.kind !== "word") continue;
      const key = findPlaceholders(c.anchor.print.text)[0]?.path;
      assert.ok(key !== undefined, `${name}: {{}} 근거 글에서 키를 못 찾았다`);
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    assert.deepEqual(
      [...places.placeholders].sort((a, b) => (a.key < b.key ? -1 : 1)),
      [...keys].map(([key, count]) => ({ key, count })).sort((a, b) => (a.key < b.key ? -1 : 1)),
      `${name}: {{키}}`,
    );

    const cands = findCandidates(doc).filter((c) => c.kind === "emptyCell" || c.kind === "labelColon" || c.kind === "blankMark");
    assert.deepEqual(places.candidates, cands.slice(0, 200).map((c) => ({ kind: c.kind, evidence: c.evidence })), `${name}: 후보`);
    assert.equal(places.candidatesTruncated, cands.length > 200);
    if (places.fields.length > 0) withFields++;
    if (places.placeholders.length > 0) withPlaceholders++;
  }
  assert.ok(withFields >= 2 && withPlaceholders >= 3, `누름틀 문서 ${withFields}, {{}} 문서 ${withPlaceholders}`);
});

test("Q4: 알려진 문서의 자리 — ph-single은 {{}} 셋, field-states는 누름틀 둘(성명 두 곳), 합성 문서는 이름이 나쁜 누름틀을 usable:false로 표시", () => {
  assert.deepEqual(analyzePlaces(readFixture("hancom/ph-single")).placeholders, [
    { key: "project.name", count: 1 },
    { key: "project.start", count: 1 },
    { key: "project.end", count: 1 },
  ]);
  assert.deepEqual(analyzePlaces(readFixture("hancom/field-states")).fields, [
    { name: "성명", count: 2, usable: true, fillable: 2, merging: 0, unfillable: [] },
    { name: "소속", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
  ]);
  assert.deepEqual(analyzePlaces(mixedDoc()).fields, [
    { name: "성명", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
    { name: "이 름", count: 1, usable: false, fillable: 1, merging: 0, unfillable: [] },
  ]);
});

// 위의 시험은 같은 엔진 함수로 기대값을 다시 계산하므로 스스로를 확인하는 구조다. 아래는 문서마다 사람이 문서를 보고 적은 기대값이다.
test("Q4: 시험 문서의 자리 목록 — 글자 그대로의 기대값(field-states·header-footer·tables-rich)", () => {
  const fieldStates = analyzePlaces(readFixture("hancom/field-states"));
  assert.deepEqual(fieldStates.fields, [
    { name: "성명", count: 2, usable: true, fillable: 2, merging: 0, unfillable: [] },
    { name: "소속", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
  ]);
  assert.deepEqual(fieldStates.placeholders, []);

  const headerFooter = analyzePlaces(readFixture("hancom/header-footer"));
  assert.deepEqual(headerFooter.fields, []);
  assert.deepEqual(headerFooter.placeholders, [
    { key: "doc.title", count: 1 },
    { key: "doc.owner", count: 1 },
  ]);

  const rich = analyzePlaces(readFixture("tables/tables-rich"));
  assert.deepEqual(rich.fields, [{ name: "이름", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] }]);
});

test("Q4: 줄바꿈·탭이 든 누름틀(inline-breaks)은 이제 채울 수 있는 모양(inline)이라 fillable로 세고, 대조표는 데이터로 판정한다", () => {
  const bytes = readFixture("inline/inline-breaks");
  assert.deepEqual(listFields(parseDocument(openPackage(bytes))).map((f) => [f.name, f.shape]), [["줄", "inline"], ["탭", "inline"]]);
  const places = analyzePlaces(bytes);
  assert.deepEqual(places.fields, [
    { name: "줄", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
    { name: "탭", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
  ]);
  const matches = matchPlaces(places, parseQuickData(enc({ 줄: "x", 탭: "y\tz" })).records);
  assert.deepEqual(
    matches.map((m) => [m.kind, m.key, m.state, m.counts, m.multiline]),
    [
      ["field", "줄", "ok", { ok: 1, missing: 0, notScalar: 0, rejected: 0 }, 0],
      ["field", "탭", "ok", { ok: 1, missing: 0, notScalar: 0, rejected: 0 }, 1],
    ],
  );
  // 데이터가 없으면 다른 누름틀처럼 없음이다
  assert.deepEqual(matchPlaces(places, parseQuickData(enc({ 다른: "것" })).records).map((m) => m.state), ["missing", "missing"]);
});

test("Q4: CLICK_HERE가 아닌 필드(책갈피 등)는 자리 목록에 넣지 않는다 — 이름이 같은 CLICK_HERE가 따로 있으면 그것만 센다", () => {
  const bytes = readFixture("hancom/field-states");
  const bookmark = mutateSection(bytes, (xml) => xml.replace('type="CLICK_HERE" name="소속"', 'type="BOOKMARK" name="소속"'));
  // 엔진의 목록에는 있고(type만 다르다), 자리 목록에는 없다
  assert.deepEqual(listFields(parseDocument(openPackage(bookmark))).map((f) => [f.name, f.type]), [["성명", "CLICK_HERE"], ["소속", "BOOKMARK"], ["성명", "CLICK_HERE"]]);
  const places = analyzePlaces(bookmark);
  assert.deepEqual(places.fields, [{ name: "성명", count: 2, usable: true, fillable: 2, merging: 0, unfillable: [] }]);
  assert.deepEqual(matchPlaces(places, parseQuickData(enc({ 성명: "가", 소속: "나" })).records).map((m) => m.key), ["성명"]);

  // 종류가 다른 필드와 이름이 같은 누름틀: 누름틀의 곳만 센다
  const mixed = mutateSection(bytes, (xml) => xml.replace('type="CLICK_HERE" name="성명"', 'type="MAILMERGE" name="성명"'));
  assert.deepEqual(analyzePlaces(mixed).fields, [
    { name: "소속", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
    { name: "성명", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
  ]);

  // 종류가 CLICK_HERE가 아닌 필드만 있는 문서
  const none = synth([P(R(T("앞") + FIELD_BEGIN("21", "메일", "1", "x").replace('type="CLICK_HERE"', 'type="MAILMERGE"') + T("값") + FIELD_END("21")))]);
  assert.deepEqual(analyzePlaces(none).fields, []);
});

test("Q4: 모양별로 센다 — 채울 수 있는 곳(simple·empty·inline·crossParagraph)과 채울 수 없는 곳(object·crossContainer·unpaired), 여러 문단에 걸친 곳은 merging에도 센다. 곳 수 = 채울 수 있는 수 + 못 채우는 수", () => {
  const bytes = readFixture("hancom/field-states");
  // 첫 `성명`의 끝 표식을 다음 문단으로 옮긴다: 여러 문단에 걸친 곳이지만 채울 수 있다(채우면 문단이 합쳐진다)
  const cross = mutateSection(bytes, (xml) => xml.replace(/<hp:ctrl><hp:fieldEnd/, '</hp:run></hp:p><hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd'));
  assert.deepEqual(listFields(parseDocument(openPackage(cross))).map((f) => f.shape), ["crossParagraph", "simple", "simple"]);
  assert.deepEqual(analyzePlaces(cross).fields, [
    { name: "성명", count: 2, usable: true, fillable: 2, merging: 1, unfillable: [] },
    { name: "소속", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
  ]);
  // 첫 `성명`의 끝 표식을 없앤다
  const unpaired = mutateSection(bytes, (xml) => xml.replace(/<hp:ctrl><hp:fieldEnd[^>]*\/><\/hp:ctrl>/, ""));
  assert.deepEqual(analyzePlaces(unpaired).fields, [
    { name: "성명", count: 2, usable: true, fillable: 1, merging: 0, unfillable: [{ shape: "unpaired", count: 1 }] },
    { name: "소속", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
  ]);

  // 한 이름에 모양이 다 섞인 문서: simple 1·empty 1, 줄바꿈·탭 inline 2, 여러 문단 1(채울 수 있음 5곳, 그중 합침 1곳),
  // 안에 그림 1(object), 표 칸에서 시작해 표 밖에서 끝남 1(crossContainer), 끝 표식 없음 1(unpaired), 이름이 빈 누름틀 1
  const doc = synth([
    P(R(T("a") + FIELD_BEGIN("31", "가", "1", "x") + T("값") + FIELD_END("31"))),
    P(R(FIELD_BEGIN("32", "가", "1", "x") + "<hp:t>줄<hp:lineBreak/>바꿈</hp:t>" + FIELD_END("32"))),
    P(R(FIELD_BEGIN("33", "가", "1", "x") + '<hp:t>탭<hp:tab width="1" leader="0" type="1"/>있음</hp:t>' + FIELD_END("33"))),
    P(R(FIELD_BEGIN("34", "가", "1", "x") + T("앞"))),
    P(R(T("뒤") + FIELD_END("34"))),
    P(R(FIELD_BEGIN("35", "가", "1", "x") + T("끝 없음"))),
    P(R(FIELD_BEGIN("36", "가", "1", "x") + FIELD_END("36"))),
    P(R(FIELD_BEGIN("37", "", "1", "x") + T("이름 없음") + FIELD_END("37"))),
    P(R(FIELD_BEGIN("38", "가", "1", "x") + T("앞") + PIC("1") + T("뒤") + FIELD_END("38"))),
    P(R(TBL([[P(R(FIELD_BEGIN("39", "가", "1", "x") + T("칸 안")))]], "0"))),
    P(R(T("밖") + FIELD_END("39"))),
  ]);
  const shapes = listFields(parseDocument(openPackage(doc))).map((f) => f.shape);
  assert.deepEqual(shapes, ["simple", "inline", "inline", "crossParagraph", "unpaired", "empty", "simple", "object", "crossContainer"]);
  const places = analyzePlaces(doc);
  assert.deepEqual(places.fields, [
    {
      name: "가",
      count: 8,
      usable: true,
      fillable: 5,
      merging: 1,
      unfillable: [
        { shape: "object", count: 1 },
        { shape: "crossContainer", count: 1 },
        { shape: "unpaired", count: 1 },
      ],
    },
    { name: "", count: 1, usable: false, fillable: 1, merging: 0, unfillable: [] },
  ]);
  // 일부 곳만 채울 수 없는 누름틀은 데이터로 판정한다(건수 판정을 막지 않는다)
  const matches = matchPlaces(places, parseQuickData(enc([{ 가: "x" }, { 다른: 1 }])).records);
  assert.deepEqual(matches.map((m) => [m.key, m.state]), [["가", "missing"], ["", "badKey"]]);
  assert.deepEqual(matches[0]?.counts, { ok: 1, missing: 1, notScalar: 0, rejected: 0 });
});

test("Q4: 곳이 전부 채울 수 없는 모양(안에 그림·표가 든 object, 표 칸 경계를 넘는 crossContainer, 끝 표식 없는 unpaired)인 이름은 unfillable이고, 엔진이 건너뛰며 쉬운 말과 자리 이름을 단다. 여러 문단에 걸친 이름은 데이터로 판정한다", () => {
  const doc = synth([
    P(R(FIELD_BEGIN("51", "그림", "1", "x") + T("앞") + PIC("1") + T("뒤") + FIELD_END("51"))),
    P(R(TBL([[P(R(FIELD_BEGIN("52", "칸밖", "1", "x") + T("칸 안")))]], "0"))),
    P(R(T("밖") + FIELD_END("52"))),
    P(R(FIELD_BEGIN("53", "끝없음", "1", "x") + T("본문"))),
    P(R(FIELD_BEGIN("54", "여럿", "1", "x") + T("앞"))),
    P(R(T("뒤") + FIELD_END("54"))),
    P(R(T("성명 ") + FIELD_BEGIN("55", "성명", "1", "x") + T("값") + FIELD_END("55"))),
  ]);
  const places = analyzePlaces(doc);
  assert.deepEqual(places.fields, [
    { name: "그림", count: 1, usable: true, fillable: 0, merging: 0, unfillable: [{ shape: "object", count: 1 }] },
    { name: "칸밖", count: 1, usable: true, fillable: 0, merging: 0, unfillable: [{ shape: "crossContainer", count: 1 }] },
    { name: "끝없음", count: 1, usable: true, fillable: 0, merging: 0, unfillable: [{ shape: "unpaired", count: 1 }] },
    { name: "여럿", count: 1, usable: true, fillable: 1, merging: 1, unfillable: [] },
    { name: "성명", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] },
  ]);
  const data = { 그림: "a", 칸밖: "b", 끝없음: "c", 여럿: "d", 성명: "e" };
  const none = { 다른: "것" };
  assert.deepEqual(matchPlaces(places, parseQuickData(enc(data)).records).map((m) => [m.key, m.state]), [["그림", "unfillable"], ["칸밖", "unfillable"], ["끝없음", "unfillable"], ["여럿", "ok"], ["성명", "ok"]]);
  // 데이터가 없어도 채울 수 없는 모양이 먼저다. 여러 문단에 걸친 이름은 데이터로 판정한다
  assert.deepEqual(matchPlaces(places, parseQuickData(enc(none)).records).map((m) => m.state), ["unfillable", "unfillable", "unfillable", "missing", "missing"]);

  const [g] = generateAll(doc, places, parseQuickData(enc(data)), "f.hwpx", "error");
  assert.deepEqual([g?.view.ok, g?.view.filled, g?.view.errors], [true, 2, []]);
  assert.deepEqual(g?.view.skipped.map((s) => [s.code, s.place]), [
    ["FIELD_UNSUPPORTED_SHAPE", '누름틀 "그림"'],
    ["FIELD_UNSUPPORTED_SHAPE", '누름틀 "칸밖"'],
    ["FIELD_UNSUPPORTED_SHAPE", '누름틀 "끝없음"'],
  ]);
  for (const s of g?.view.skipped ?? []) for (const cause of ["그림·표", "표 칸", "끝 표식", "구역 설정", "한컴에서"]) assert.ok(s.plain.includes(cause), cause);
  assert.deepEqual(g?.view.notes.map((n) => [n.code, n.place]), [["FIELD_PARAGRAPHS_MERGED", '누름틀 "여럿"']]);
});

// ── 엔진이 건너뛰는 여러 문단 누름틀(crossBlocked) ────────────────
// 모양(crossParagraph)만 보면 채울 수 있는 것 같지만 엔진의 fieldFillBlock이 막는 곳. 막는 일은 데이터와 무관하게 문서만으로 정해진다.

const simpleAt = (id: string, name: string): string => P(R(T("a ") + FIELD_BEGIN(id, name, "1", "x") + T("값") + FIELD_END(id)));
const objectAt = (id: string, name: string): string => P(R(FIELD_BEGIN(id, name, "1", "x") + T("앞") + PIC("1") + T("뒤") + FIELD_END(id)));
const cellAt = (id: string, name: string): string => P(R(TBL([[P(R(FIELD_BEGIN(id, name, "1", "x") + T("칸 안")))]], "0"))) + P(R(T("밖") + FIELD_END(id)));
const unpairedAt = (id: string, name: string): string => P(R(FIELD_BEGIN(id, name, "1", "x") + T("끝 없음")));

test("Q4: 모양은 여러 문단이지만 엔진이 건너뛰는 곳(사이 문단의 구역 설정, 엇갈린 누름틀)은 crossBlocked로 세고 merging에 넣지 않는다 — 데이터가 있어도 대조표는 unfillable이고, 생성은 미리 알린 그 곳들을 건너뛰며 FILL_NOTHING_APPLIED로 실패한다", () => {
  const cases: [string, Uint8Array, string[], RegExp][] = [
    ["사이 문단의 구역 설정", synth([secBetween("101", "구역")]), ["구역"], /구역 설정/],
    ["엇갈린 누름틀", synth([crossed("102", "바깥", "103", "안쪽")]), ["바깥", "안쪽"], /짝/],
  ];
  for (const [label, bytes, names, cause] of cases) {
    const messages = blockMessages(bytes);
    assert.equal(messages.length, names.length, label);
    for (const m of messages) assert.match(m ?? "", cause, label);
    // 모양만 보면 채울 수 있는 곳(crossParagraph)이다
    assert.ok(listFields(parseDocument(openPackage(bytes))).every((f) => f.shape === "crossParagraph"), label);

    const places = analyzePlaces(bytes);
    assert.deepEqual(
      places.fields,
      names.map((name, i) => ({ name, count: 1, usable: true, fillable: 0, merging: 0, unfillable: [{ shape: "crossBlocked", count: 1, reasons: [messages[i]] }] })),
      label,
    );

    const data = Object.fromEntries(names.map((n) => [n, "값"]));
    for (const d of [data, { 다른: "것" }]) {
      assert.deepEqual(matchPlaces(places, parseQuickData(enc(d)).records).map((m) => [m.key, m.state]), names.map((n) => [n, "unfillable"]), label);
    }
    const [g] = generateAll(bytes, places, parseQuickData(enc(data)), "f.hwpx", "error");
    assert.deepEqual([g?.view.ok, g?.output, g?.view.filled, g?.view.errors.map((e) => e.code)], [false, undefined, 0, ["FILL_NOTHING_APPLIED"]], label);
    // 미리 알린 곳이 그대로 건너뜀에 나온다: 이름·곳 수가 같고 엔진의 사유가 detail에 실린다
    assert.deepEqual(g?.view.skipped.map((s) => [s.code, s.place]), names.map((n) => ["FIELD_UNSUPPORTED_SHAPE", `누름틀 "${n}"`]), label);
    g?.view.skipped.forEach((s, i) => assert.ok(s.detail?.startsWith(messages[i] ?? "?"), `${label}: ${s.detail}`));
  }
});

test("Q4: 한 이름에 막힌 곳과 채울 수 있는 곳이 섞이면 채울 수 있는 곳만 fillable·merging에 세고, 사유는 서로 다른 것만 처음 나온 순서로 한 번씩 담는다. 생성은 채울 수 있는 곳만 채운다", () => {
  const doc = synth([
    simpleAt("111", "혼합"), // 채울 수 있음
    objectAt("112", "혼합"), // object
    secBetween("113", "혼합"), // crossBlocked(구역 설정)
    secBetween("114", "혼합"), // crossBlocked(같은 사유)
    crossed("115", "혼합", "116", "혼합"), // crossBlocked 둘(다른 사유)
    openCross("117", "혼합"), // 채울 수 있음(문단이 합쳐진다)
    secBetween("118", "구역"),
  ]);
  const messages = blockMessages(doc);
  const [, , sec, sec2, crossA, crossB] = messages;
  assert.deepEqual(messages.map((m) => m !== undefined), [false, true, true, true, true, true, false, true]);
  assert.ok(sec !== undefined && sec === sec2 && crossA !== undefined && crossA === crossB && sec !== crossA, "구역 설정 사유와 엇갈림 사유는 서로 다르고 같은 사유는 같은 문구다");

  const places = analyzePlaces(doc);
  assert.deepEqual(places.fields, [
    {
      name: "혼합",
      count: 7,
      usable: true,
      fillable: 2,
      merging: 1,
      unfillable: [
        { shape: "object", count: 1 },
        { shape: "crossBlocked", count: 4, reasons: [sec, crossA] },
      ],
    },
    { name: "구역", count: 1, usable: true, fillable: 0, merging: 0, unfillable: [{ shape: "crossBlocked", count: 1, reasons: [sec] }] },
  ]);
  const data = { 혼합: "값", 구역: "z" };
  // 일부 곳만 막힌 이름은 데이터로 판정하고, 전부 막힌 이름만 unfillable이다
  assert.deepEqual(matchPlaces(places, parseQuickData(enc(data)).records).map((m) => [m.key, m.state]), [["혼합", "ok"], ["구역", "unfillable"]]);

  const [g] = generateAll(doc, places, parseQuickData(enc(data)), "f.hwpx", "error");
  assert.deepEqual([g?.view.ok, g?.view.filled, g?.view.errors], [true, 2, []]);
  const skippedPlaces = g?.view.skipped.map((s) => s.place).sort();
  assert.deepEqual(skippedPlaces, ['누름틀 "구역"', ...Array<string>(5).fill('누름틀 "혼합"')].sort(), "건너뛴 곳 = 막힌 곳(object 1 + crossBlocked 4 + 구역 1)");
  assert.ok(g?.view.skipped.every((s) => s.code === "FIELD_UNSUPPORTED_SHAPE"));
  assert.deepEqual(g?.view.notes.map((n) => [n.code, n.place]), [["FIELD_PARAGRAPHS_MERGED", '누름틀 "혼합"']]);
  assert.deepEqual(g?.output, direct(doc, data));
  const after = listFields(parseDocument(openPackage(g?.output ?? new Uint8Array(0))));
  assert.equal(after.filter((f) => f.name === "혼합" && f.valueText === "값").length, 2, "채운 곳만 값이 들어갔다");
  assert.equal(after.filter((f) => f.name === "혼합").length, 7, "누름틀은 하나도 지워지지 않는다");
  const paragraphs = (b: Uint8Array): number => parseDocument(openPackage(b)).sections.reduce((n, sec) => n + [...walkParagraphs(sec.paragraphs)].length, 0);
  assert.equal(paragraphs(g?.output ?? new Uint8Array(0)), paragraphs(doc) - 1, "합친 곳(openCross) 하나만 문단이 하나 줄었다");
});

test("Q4: 모든 시험 문서와 합성 문서에서 곳 수 = 채울 수 있는 수 + 채울 수 없는 수이고, 채울 수 있다고 센 곳은 생성에서 실제로 채워지고 못 채운다고 센 곳은 건너뜀으로 나온다", () => {
  const docs: [string, Uint8Array][] = [
    ...fixtureNames().map((n): [string, Uint8Array] => [n, readFixture(n)]),
    ["합성: 혼합", mixedDoc()],
    ["합성: 구역 설정", synth([secBetween("121", "구역"), openCross("122", "열림"), simpleAt("123", "성명")])],
    ["합성: 엇갈림", synth([crossed("124", "바깥", "125", "안쪽"), simpleAt("126", "성명")])],
    ["합성: 엇갈림만", synth([crossed("127", "바깥", "128", "안쪽")])],
    ["합성: 모양", synth([simpleAt("131", "성명"), objectAt("132", "그림"), cellAt("133", "칸밖"), unpairedAt("134", "끝없음"), openCross("135", "열림"), secBetween("136", "구역")])],
  ];
  assert.ok(docs.length >= 25);
  const VALUE = "채움-7391";
  const seen = { fields: 0, fillable: 0, blocked: 0, crossBlocked: 0, merging: 0, failedAll: 0 };
  for (const [label, bytes] of docs) {
    const places = analyzePlaces(bytes);
    const infos = listFields(parseDocument(openPackage(bytes))).filter(isPlaceField);
    assert.equal(places.fields.reduce((n, f) => n + f.count, 0), infos.length, `${label}: 곳 수`);
    for (const f of places.fields) {
      assert.equal(f.fillable + f.unfillable.reduce((n, u) => n + u.count, 0), f.count, `${label}: ${f.name}: 곳 수 = 채울 수 있는 수 + 채울 수 없는 수`);
      assert.ok(f.merging <= f.fillable, `${label}: ${f.name}: merging은 fillable의 일부다`);
      for (const u of f.unfillable) assert.equal(u.reasons !== undefined && u.reasons.length > 0, u.shape === "crossBlocked", `${label}: reasons는 crossBlocked에만 있다`);
    }
    seen.fields += places.fields.length;
    // 데이터가 있는 이름(키로 쓸 수 있고 점이 없는 것)만 센다. 누락 정책은 그대로 둠이라 {{키}}는 건드리지 않는다
    const named = places.fields.filter((f) => f.usable && !f.name.includes("."));
    if (named.length === 0) continue;
    const fillable = named.reduce((n, f) => n + f.fillable, 0);
    const blocked = named.reduce((n, f) => n + f.unfillable.reduce((m, u) => m + u.count, 0), 0);
    seen.fillable += fillable;
    seen.blocked += blocked;
    seen.merging += named.reduce((n, f) => n + f.merging, 0);
    seen.crossBlocked += named.reduce((n, f) => n + (f.unfillable.find((u) => u.shape === "crossBlocked")?.count ?? 0), 0);

    const [g] = generateAll(bytes, places, parseQuickData(enc(Object.fromEntries(named.map((f) => [f.name, VALUE])))), "f.hwpx", "keep");
    assert.equal(g?.view.skipped.filter((s) => s.code === "FIELD_UNSUPPORTED_SHAPE").length, blocked, `${label}: 건너뛴 곳 = 못 채운다고 센 곳`);
    if (fillable === 0) {
      seen.failedAll++;
      assert.deepEqual([g?.view.ok, g?.output, g?.view.errors.map((e) => e.code)], [false, undefined, ["FILL_NOTHING_APPLIED"]], `${label}: 채울 곳이 없으면 아무것도 채우지 못해 실패한다`);
      continue;
    }
    assert.deepEqual([g?.view.ok, g?.view.filled, g?.view.errors], [true, fillable, []], `${label}: 채울 수 있다고 센 곳은 모두 채워진다`);
    const after = listFields(parseDocument(openPackage(g?.output ?? new Uint8Array(0))));
    assert.equal(after.filter((f) => isPlaceField(f) && f.valueText === VALUE).length, fillable, `${label}: 결과에서 다시 읽은 값`);
  }
  // 시험이 비어 있지 않다: 채울 수 있는 곳, 모양이 다른 막힌 곳, 막힌 여러 문단 곳, 합쳐지는 곳, 아무것도 못 채우는 문서가 모두 있다
  assert.ok(seen.fields >= 15 && seen.fillable >= 12 && seen.blocked >= 8 && seen.crossBlocked >= 6 && seen.merging >= 4 && seen.failedAll >= 1, JSON.stringify(seen));
});

test("여러 문단에 걸친 누름틀(span 시험 문서): 자리 목록은 merging으로 알리고, 대조표는 데이터로 판정하며, 만들면 한컴이 채운 정답과 같은 문단 수가 되고 알림에 FIELD_PARAGRAPHS_MERGED가 한 건 나온다", () => {
  const count = (b: Uint8Array): number => parseDocument(openPackage(b)).sections.reduce((n, s) => n + [...walkParagraphs(s.paragraphs)].length, 0);
  // [시험 문서, 한컴이 채운 정답, 누름틀 이름]
  for (const [name, answer, key] of [
    ["span/field-span", "span/field-span-filled", "성명"],
    ["span/field-span-table", "span/field-span-table-filled", "성명"],
    ["span/field-span-cell", "span/field-span-cell-filled", "칸"],
  ] as const) {
    const bytes = readFixture(name);
    const places = analyzePlaces(bytes);
    assert.deepEqual(places.fields, [{ name: key, count: 1, usable: true, fillable: 1, merging: 1, unfillable: [] }], name);
    const data = { [key]: "새 값" };
    const records = parseQuickData(enc(data)).records;
    assert.deepEqual(matchPlaces(places, records).map((m) => [m.key, m.state, m.counts.ok]), [[key, "ok", 1]], name);

    const [g] = generateAll(bytes, places, parseQuickData(enc(data)), "f.hwpx", "error");
    assert.deepEqual([g?.view.ok, g?.view.filled, g?.view.skipped, g?.view.errors], [true, 1, [], []], name);
    assert.deepEqual(g?.view.notes.map((n) => [n.code, n.place]), [["FIELD_PARAGRAPHS_MERGED", `누름틀 "${key}"`]], name);
    assert.equal(g?.view.notes[0]?.plain, plainOf("FIELD_PARAGRAPHS_MERGED"));
    assert.match(g?.view.notes[0]?.detail ?? "", /합쳤/, "엔진의 메시지가 detail에 실린다");
    assert.deepEqual(g?.output, direct(bytes, data), `${name}: 엔진을 직접 부른 결과와 같다`);
    const after = g?.output ?? new Uint8Array(0);
    assert.equal(count(after), count(readFixture(answer)), `${name}: 문단 수가 한컴이 채운 정답과 같다`);
    assert.ok(count(after) < count(bytes), `${name}: 문단이 합쳐졌다`);
    assert.deepEqual(listFields(parseDocument(openPackage(after))).map((f) => [f.name, f.valueText, f.shape]), [[key, "새 값", "simple"]], name);
  }
});

test("문서를 열 수 없으면 엔진의 코드로 거절한다", () => {
  assert.throws(() => analyzePlaces(new Uint8Array([1, 2, 3, 4])), (e: unknown) => e instanceof HwpxError && /^(PKG|XML|MODEL)_/.test(e.code));
  assert.throws(() => analyzePlaces(new Uint8Array(0)), HwpxError);
});

// ── Q4: 대조표 = 엔진의 경로·값 함수 ──────────────────────────────

const DATA = {
  text: "글", num: 5, flag: false, nothing: null, obj: { x: 1 }, list: [1, 2], bad: "가\u0001나", multi: "첫 줄\n둘째 줄", tab: "a\tb", nested: { deep: "깊다" },
  "a.b": "점이 든 키",
};

/** 시험 쪽 기준: 엔진의 lookupPath·scalarToText·checkValueText로 직접 판정한다 */
function oracle(ds: ReturnType<typeof readDataset>, key: string): "ok" | "missing" | "notScalar" | "rejected" {
  const found = lookupPath(ds, key);
  if (!found.found || found.value === null) return "missing";
  const text = scalarToText(found.value);
  if (text === undefined) return "notScalar";
  return checkValueText(text) === undefined ? "ok" : "rejected";
}

test("Q4: 대조표의 판정은 엔진의 lookupPath·scalarToText·checkValueText와 같다(줄바꿈 값은 엔진 결과를 그대로 따른다)", () => {
  const keys = ["text", "num", "flag", "nothing", "obj", "list", "bad", "multi", "tab", "nested.deep", "nested", "absent", "obj.x", "list.0", "a.b"];
  const places: PlacesView = { fields: [], placeholders: keys.map((key) => ({ key, count: 1 })), candidates: [], candidatesTruncated: false };
  const { records } = parseQuickData(enc(DATA));
  const matches = matchPlaces(places, records);
  const ds = readDataset(DATA);
  assert.deepEqual(matches.map((m) => m.key), keys);
  for (const m of matches) {
    assert.equal(m.state, oracle(ds, m.key), m.key);
    assert.equal(m.counts[m.state as "ok"], 1, `${m.key}: 건수`);
  }
  const byKey = new Map(matches.map((m) => [m.key, m]));
  // XML 금지 문자는 어떤 경우에도 거절이고, 사유는 엔진의 값 검사가 준 것이다
  assert.deepEqual([byKey.get("bad")?.state, byKey.get("bad")?.reason], ["rejected", "U+0001"]);
  assert.equal(byKey.get("obj")?.state, "notScalar");
  assert.equal(byKey.get("list")?.state, "notScalar");
  assert.equal(byKey.get("nothing")?.state, "missing");
  assert.equal(byKey.get("absent")?.state, "missing");
  assert.equal(byKey.get("nested.deep")?.state, "ok");
  assert.equal(byKey.get("text")?.state, "ok");
  assert.equal(byKey.get("num")?.state, "ok", "숫자는 글로 바꿔 넣는다");
  assert.equal(byKey.get("flag")?.state, "ok", "false도 값이다");
  // 줄바꿈·탭: 엔진이 받는지 거절하는지에 따라 같은 결과다(엔진이 거절하면 사유 코드가 붙는다)
  for (const [key, text] of [["multi", DATA.multi], ["tab", DATA.tab]] as const) {
    const verdict = checkValueText(text);
    assert.deepEqual([byKey.get(key)?.state, byKey.get(key)?.reason], verdict === undefined ? ["ok", undefined] : ["rejected", verdict], key);
  }
});

test("Q4: 키로 쓸 수 없는 누름틀 이름은 badKey, 여러 건이면 건수를 센다(없는 키 표시). 객체가 아닌 건은 판정하지 않는다", () => {
  const bad = ["이 름", "a b", "", "a..b", "a(b)", "a.", ".a"];
  for (const name of bad) assert.equal(isValidPath(name), false, JSON.stringify(name));
  const places: PlacesView = {
    fields: [...bad.map((name) => ({ name, count: 1, usable: false, fillable: 1, merging: 0, unfillable: [] })), { name: "성명", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] }],
    placeholders: [{ key: "project.name", count: 1 }, { key: "extra", count: 2 }],
    candidates: [],
    candidatesTruncated: false,
  };
  const { form, records } = parseQuickData(enc([{ 성명: "가", project: { name: "A" } }, { 성명: "나", project: {} }, { 성명: "다", project: { name: "C" }, extra: { x: 1 } }, 7]));
  assert.equal(form, "array");
  assert.equal(records.length, 4);
  const matches = matchPlaces(places, records);
  for (const m of matches.slice(0, bad.length)) assert.deepEqual([m.state, m.counts], ["badKey", { ok: 0, missing: 0, notScalar: 0, rejected: 0 }]);
  const byKey = new Map(matches.map((m) => [m.key, m]));
  assert.deepEqual(byKey.get("성명")?.counts, { ok: 3, missing: 0, notScalar: 0, rejected: 0 }, "객체가 아닌 항목(7)은 데이터가 없는 건으로 세지 않는다");
  assert.deepEqual([byKey.get("project.name")?.state, byKey.get("project.name")?.counts], ["missing", { ok: 2, missing: 1, notScalar: 0, rejected: 0 }]);
  assert.deepEqual([byKey.get("extra")?.state, byKey.get("extra")?.counts], ["missing", { ok: 0, missing: 2, notScalar: 1, rejected: 0 }]);
});

test("객체가 아닌 건(invalidRecords)은 데이터에 없음으로 세지 않고 대조표의 건수에서 뺀다. 건이 전부 객체가 아니면 판정할 건이 없어 missing이다", () => {
  const places: PlacesView = {
    fields: [{ name: "성명", count: 1, usable: true, fillable: 1, merging: 0, unfillable: [] }],
    placeholders: [{ key: "project.name", count: 1 }],
    candidates: [],
    candidatesTruncated: false,
  };
  const { records } = parseQuickData(enc([{ 성명: "가", project: { name: "A" } }, 42, { 성명: "나", project: { name: "B" } }]));
  assert.equal(records.length, 3);
  assert.equal(countInvalidRecords(records), 1);
  const matches = matchPlaces(places, records);
  assert.deepEqual(matches.map((m) => [m.key, m.state, m.counts]), [
    ["성명", "ok", { ok: 2, missing: 0, notScalar: 0, rejected: 0 }],
    ["project.name", "ok", { ok: 2, missing: 0, notScalar: 0, rejected: 0 }],
  ]);
  assert.equal(countInvalidRecords(parseQuickData(enc([{ a: 1 }, { a: 2 }])).records), 0);
  // 글자·null·배열도 객체가 아니다
  assert.equal(countInvalidRecords(parseQuickData(enc([{ a: 1 }, "글", null, [1], 3, true])).records), 5);

  const only = parseQuickData(enc([42, "글"])).records;
  assert.equal(countInvalidRecords(only), 2);
  for (const m of matchPlaces(places, only)) assert.deepEqual([m.state, m.counts], ["missing", { ok: 0, missing: 0, notScalar: 0, rejected: 0 }], m.key);
});

// ── 데이터 형식 ──────────────────────────────────────────────────

test("데이터 형식: 객체 하나, 객체 배열, 묶음(객체), 묶음(배열 — derived 공유)", () => {
  const one = parseQuickData(enc({ a: 1 }));
  assert.deepEqual([one.form, one.records.length], ["object", 1]);
  const many = parseQuickData(enc([{ a: 1 }, { a: 2 }, { a: 3 }]));
  assert.deepEqual([many.form, many.records.length], ["array", 3]);
  const bundle = parseQuickData(enc({ schema: "hwpx-studio/dataset@1", data: { a: 1 }, derived: { d: "파생" } }));
  assert.deepEqual([bundle.form, bundle.records.length], ["bundle", 1]);
  const bundleArray = parseQuickData(enc({ schema: "hwpx-studio/dataset@1", data: [{ a: 1 }, { a: 2 }], derived: { d: "파생" } }));
  assert.deepEqual([bundleArray.form, bundleArray.records.length], ["bundleArray", 2]);
  for (const r of bundleArray.records) assert.deepEqual("dataset" in r ? r.dataset.derived : undefined, { d: "파생" });
  // 묶음 형식이 아닌 객체는 schema 키가 있어도 일반 데이터다
  assert.equal(parseQuickData(enc({ schema: "다른 것", a: 1 })).form, "object");
  // UTF-8 BOM이 붙은 JSON도 읽는다
  assert.equal(parseQuickData(new Uint8Array([0xef, 0xbb, 0xbf, ...enc({ a: 1 })])).form, "object");
});

test("데이터 형식 오류: JSON이 아님·객체도 배열도 아님·건 없음·너무 많음·묶음 형식 오류", () => {
  const code = (body: Uint8Array): string => {
    try {
      parseQuickData(body);
    } catch (e) {
      if (e instanceof HostError || e instanceof HwpxError) return e.code;
      throw e;
    }
    return "통과";
  };
  assert.equal(code(enc("{ 깨진")), "BAD_JSON");
  assert.equal(code(new Uint8Array([0xff, 0xfe, 0x7b])), "BAD_JSON", "UTF-8이 아니다");
  for (const top of ["3", '"글"', "null", "true"]) assert.equal(code(enc(top)), "QUICK_BAD_DATA", top);
  assert.equal(code(enc([])), "QUICK_NO_RECORDS");
  assert.equal(code(enc({ schema: "hwpx-studio/dataset@1", data: [] })), "QUICK_NO_RECORDS");
  assert.equal(code(enc(new Array(MAX_RECORDS + 1).fill({ a: 1 }))), "QUICK_TOO_MANY_RECORDS");
  assert.equal(code(enc(new Array(MAX_RECORDS).fill({ a: 1 }))), "통과");
  assert.equal(code(enc({ schema: "hwpx-studio/dataset@1", data: "글" })), "DATA_SCHEMA");
  assert.equal(code(enc({ schema: "hwpx-studio/dataset@1", data: [{ a: 1 }], derived: 5 })), "DATA_SCHEMA");
});

test("키 목록: 객체는 점으로 이어 안으로 들어가고 배열은 잎이다. 공백·점이 든 키는 쓸 수 없다", () => {
  const { records } = parseQuickData(enc([{ a: 1, 그룹: { 이름: "x", 하위: { 깊이: 2 } }, 목록: [1], "a b": 1, "점.키": 2, n: null }, { a: 2, 그룹: { 이름: "y" } }]));
  const { keys, truncated } = listKeys(records);
  assert.equal(truncated, false);
  assert.deepEqual(
    keys.map((k) => [k.path, k.type, k.records, k.usable]),
    [
      ["a", "number", 2, true],
      ["그룹", "object", 2, true],
      ["그룹.이름", "string", 2, true],
      ["그룹.하위", "object", 1, true],
      ["그룹.하위.깊이", "number", 1, true],
      ["목록", "array", 1, true],
      ["a b", "number", 1, false],
      ["점.키", "number", 1, false],
      ["n", "null", 1, true],
    ],
  );
  const wide = parseQuickData(enc(Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`k${i}`, i]))));
  const listed = listKeys(wide.records);
  assert.deepEqual([listed.keys.length, listed.truncated], [1000, true]);
});

// ── 줄바꿈 값은 거절이 아니라 정보다 ─────────────────────────────

test("줄바꿈·탭이 든 값은 ok(엔진이 받는다)이고 multiline으로만 알린다. 제어 문자는 여전히 rejected", () => {
  const places: PlacesView = { fields: [], placeholders: ["a", "b", "c", "d"].map((key) => ({ key, count: 1 })), candidates: [], candidatesTruncated: false };
  const { records } = parseQuickData(enc([{ a: "한 줄", b: "첫 줄\n둘째 줄", c: "탭\t있음", d: "제어\u0001문자" }, { a: "x", b: "윈도\r\n줄바꿈", c: "y", d: "z" }]));
  const byKey = new Map(matchPlaces(places, records).map((m) => [m.key, m]));
  assert.deepEqual([byKey.get("a")?.state, byKey.get("a")?.multiline], ["ok", 0]);
  assert.deepEqual([byKey.get("b")?.state, byKey.get("b")?.multiline, byKey.get("b")?.counts.ok], ["ok", 2, 2]);
  assert.deepEqual([byKey.get("c")?.state, byKey.get("c")?.multiline], ["ok", 1]);
  assert.deepEqual([byKey.get("d")?.state, byKey.get("d")?.reason, byKey.get("d")?.multiline], ["rejected", "U+0001", 0]);
  // 엔진이 받는 값인지는 엔진의 값 검사가 정한다
  assert.equal(checkValueText("첫 줄\n둘째 줄"), undefined);
});

// ── 건별 생성: Q2의 핵심과 Q3의 바이트 동치 ──────────────────────

const PH = { project: { name: "알파", start: "2026-01", end: "2027-01" } };

/** 템플릿 없이 엔진 generate를 직접 부른 바이트 */
function direct(bytes: Uint8Array, data: unknown, missing: "error" | "empty" | "keep" = "error"): Uint8Array {
  const r = generate(bytes, emptyTemplate(), readDataset(data), { missing });
  assert.ok(r.ok && !r.dryRun);
  return r.output;
}

test("Q3: 건별 결과 바이트는 템플릿 없이 엔진 generate를 직접 부른 결과와 같고, 같은 입력은 같은 바이트다 — {{}} 문서", () => {
  const bytes = readFixture("hancom/ph-single");
  const places = analyzePlaces(bytes);
  const [a] = generateAll(bytes, places, parseQuickData(enc(PH)), "양식.hwpx", "error");
  const [b] = generateAll(bytes, places, parseQuickData(enc(PH)), "양식.hwpx", "error");
  assert.ok(a?.output !== undefined && b?.output !== undefined);
  assert.deepEqual(a.output, direct(bytes, PH));
  assert.deepEqual(a.output, b.output, "결정성");
  assert.deepEqual([a.view.ok, a.view.filled, a.view.name, a.view.errors, a.view.skipped, a.view.notes], [true, 3, "양식-001.hwpx", [], [], []]);
});

test("Q3: 누름틀 문서 — 템플릿 없이 엔진이 이름 = 데이터 경로로 채운다. 결과는 엔진 직접 호출과 같고 채운 뒤 다시 읽은 값이 데이터와 같다", () => {
  const bytes = readFixture("hancom/field-states");
  const data = { 성명: "홍길동", 소속: "한국" };
  const [g] = generateAll(bytes, analyzePlaces(bytes), parseQuickData(enc(data)), "f.hwpx", "error");
  assert.deepEqual(g?.output, direct(bytes, data));
  assert.equal(g?.view.filled, 3, "성명 두 곳 + 소속 한 곳");
  const after = listFields(parseDocument(openPackage(g?.output ?? new Uint8Array(0)))).map((f) => [f.name, f.valueText]);
  assert.deepEqual(after, [["성명", "홍길동"], ["소속", "한국"], ["성명", "홍길동"]]);
});

test("Q2: 배열 N건이면 N개 보고, 이름은 엔진의 planBatchNames, 한 건이 실패해도 나머지는 만들고 건별로 적는다", () => {
  const bytes = readFixture("hancom/ph-single");
  const places = analyzePlaces(bytes);
  const data = parseQuickData(enc([
    PH,
    { project: { name: "빠짐", start: "x" } },
    { project: { name: "가\u0001", start: "x", end: "y" } },
    7,
    { project: { name: "마지막", start: "s", end: "e" } },
  ]));
  const out = generateAll(bytes, places, data, "계약서.hwpx", "error");
  assert.deepEqual(out.map((g) => g.view.name), planBatchNames(data.records, "계약서.hwpx"));
  assert.deepEqual(out.map((g) => g.view.name), ["계약서-001.hwpx", "계약서-002.hwpx", "계약서-003.hwpx", "계약서-004.hwpx", "계약서-005.hwpx"]);
  assert.deepEqual(out.map((g) => g.view.ok), [true, false, false, false, true]);
  assert.deepEqual(out.map((g) => g.output !== undefined), [true, false, false, false, true], "실패한 건은 파일이 없다");
  assert.deepEqual(out.map((g) => g.view.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(out.map((g) => g.view.filled), [3, 0, 0, 0, 3], "실패한 건은 채운 자리가 0이다");
  assert.deepEqual(out[1]?.view.errors.map((e) => e.code), ["DATA_MISSING"]);
  assert.deepEqual(out[2]?.view.errors.map((e) => e.code), ["VALUE_CONTROL_CHAR"]);
  assert.deepEqual(out[3]?.view.errors.map((e) => e.code), ["DATA_SCHEMA"]);
  for (const g of out) for (const e of g.view.errors) assert.ok(e.plain.length > 5 && e.plain !== e.code, e.code);
  assert.deepEqual(out[4]?.output, direct(bytes, { project: { name: "마지막", start: "s", end: "e" } }));
});

test("원본 이름은 엔진의 이름 규칙(sanitizeFileStem)을 거친다: 폴더 부분·.hwpx·금지 문자·빈 이름", () => {
  const bytes = readFixture("hancom/ph-single");
  const places = analyzePlaces(bytes);
  const data = parseQuickData(enc(PH));
  const name = (original: string): string | undefined => generateAll(bytes, places, data, original, "error")[0]?.view.name;
  assert.equal(name("계약서.hwpx"), "계약서-001.hwpx");
  assert.equal(name(["C:", "문서", "양식.HWPX"].join(String.fromCharCode(92))), "양식-001.hwpx");
  assert.equal(name("../../evil:name?.hwpx"), "evil_name_-001.hwpx");
  assert.equal(name(""), "문서-001.hwpx");
});

// ── 누락 정책과 보고서의 모양 ────────────────────────────────────

test("누락 정책: 오류로 멈춤은 건을 실패로 적고, 빈칸은 비워서 채우고, 그대로 둠은 그대로 두고 나머지를 채운다", () => {
  const bytes = readFixture("hancom/field-states");
  const places = analyzePlaces(bytes);
  const data = parseQuickData(enc({ 성명: "홍길동" }));
  const [error] = generateAll(bytes, places, data, "f.hwpx", "error");
  assert.equal(error?.view.ok, false);
  assert.equal(error?.output, undefined);
  assert.deepEqual(error?.view.errors.map((e) => e.code), ["DATA_MISSING"]);
  assert.match(error?.view.errors[0]?.detail ?? "", /누름틀 소속/, "엔진 메시지가 자리를 밝힌다");
  assert.doesNotMatch(error?.view.errors[0]?.detail ?? "", /규칙 r\d|앵커 a\d/);

  const [empty] = generateAll(bytes, places, data, "f.hwpx", "empty");
  assert.deepEqual([empty?.view.ok, empty?.view.filled, empty?.view.skipped], [true, 3, []]);
  assert.deepEqual(empty?.output, direct(bytes, { 성명: "홍길동" }, "empty"));
  const emptied = listFields(parseDocument(openPackage(empty?.output ?? new Uint8Array(0)))).map((f) => [f.name, f.valueText]);
  assert.deepEqual(emptied, [["성명", "홍길동"], ["소속", ""], ["성명", "홍길동"]]);

  const [keep] = generateAll(bytes, places, data, "f.hwpx", "keep");
  assert.deepEqual([keep?.view.ok, keep?.view.filled], [true, 2]);
  assert.deepEqual(keep?.output, direct(bytes, { 성명: "홍길동" }, "keep"));
  const kept = listFields(parseDocument(openPackage(keep?.output ?? new Uint8Array(0)))).map((f) => [f.name, f.valueText]);
  assert.deepEqual(kept, [["성명", "홍길동"], ["소속", "합성기관"], ["성명", "홍길동"]]);
});

test("채운 자리가 하나도 없으면 엔진이 FILL_NOTHING_APPLIED로 실패시키고 결과를 내지 않는다 — 데이터가 전부 없고 그대로 둠이거나, 문서에 자리가 없을 때", () => {
  const ph = readFixture("hancom/ph-single");
  const [allKept] = generateAll(ph, analyzePlaces(ph), parseQuickData(enc({ 다른: "키" })), "x.hwpx", "keep");
  assert.deepEqual([allKept?.view.ok, allKept?.output, allKept?.view.errors.map((e) => e.code), allKept?.view.filled], [false, undefined, ["FILL_NOTHING_APPLIED"], 0]);
  const none = readFixture("hancom/picture");
  const [noPlaces] = generateAll(none, analyzePlaces(none), parseQuickData(enc({ a: 1 })), "x.hwpx", "error");
  assert.deepEqual([noPlaces?.view.ok, noPlaces?.view.errors.map((e) => e.code)], [false, ["FILL_NOTHING_APPLIED"]]);
  assert.match(noPlaces?.view.errors[0]?.plain ?? "", /하나도 없어/);
});

test("데이터 경로가 아닌 이름의 누름틀은 엔진이 FIELD_NAME_NOT_PATH로 건너뛰고(자리 이름과 쉬운 말과 함께) 나머지 자리는 채운다", () => {
  const bytes = mixedDoc();
  const [g] = generateAll(bytes, analyzePlaces(bytes), parseQuickData(enc({ 성명: "홍", project: { name: "알파", start: "1" } })), "m.hwpx", "error");
  assert.deepEqual([g?.view.ok, g?.view.filled], [true, 3]);
  assert.deepEqual(g?.view.skipped.map((s) => [s.code, s.place]), [["FIELD_NAME_NOT_PATH", '누름틀 "이 름"']]);
  assert.match(g?.view.skipped[0]?.plain ?? "", /누름틀 이름/);
  assert.deepEqual(g?.output, direct(bytes, { 성명: "홍", project: { name: "알파", start: "1" } }));
  const fields = listFields(parseDocument(openPackage(g?.output ?? new Uint8Array(0)))).map((f) => [f.name, f.valueText]);
  assert.deepEqual(fields, [["성명", "홍"], ["이 름", "YY"]], "이름이 나쁜 누름틀은 그대로다");
});

test("엔진이 건너뛴 자리(FILL_MIXED_FORMAT)는 자리 이름과 쉬운 말과 함께 건너뜀에 적힌다", () => {
  const bytes = readFixture("hancom/ph-mixed");
  const data = { project: { name: "알파" }, company: { name: "회사" }, manager: { name: "담당", phone: "010" } };
  const [g] = generateAll(bytes, analyzePlaces(bytes), parseQuickData(enc(data)), "x.hwpx", "error");
  assert.equal(g?.view.ok, true);
  assert.deepEqual(g?.view.skipped.map((s) => [s.code, s.place]), [["FILL_MIXED_FORMAT", "{{project.name}}"]]);
  assert.match(g?.view.skipped[0]?.plain ?? "", /글자 모양/);
  assert.equal(g?.view.filled, 3);
});

test("줄바꿈이 든 값은 엔진이 줄바꿈 요소로 넣고(문단 수가 같다), 보고서에는 정보(QUICK_MULTILINE)로만 나온다", () => {
  const bytes = readFixture("hancom/field-states");
  const data = { 성명: "홍\n길동", 소속: "한국" };
  const places = analyzePlaces(bytes);
  const [g] = generateAll(bytes, places, parseQuickData(enc(data)), "f.hwpx", "error");
  assert.deepEqual([g?.view.ok, g?.view.errors, g?.view.skipped], [true, [], []]);
  assert.deepEqual(g?.view.notes.map((n) => [n.code, n.place]), [["QUICK_MULTILINE", "키 성명"]]);
  assert.match(g?.view.notes[0]?.plain ?? "", /줄바꿈/);
  assert.deepEqual(g?.output, direct(bytes, data));
  const after = parseDocument(openPackage(g?.output ?? new Uint8Array(0)));
  const before = parseDocument(openPackage(bytes));
  const count = (d: typeof after): number => d.sections.reduce((n, s) => n + [...walkParagraphs(s.paragraphs)].length, 0);
  assert.equal(count(after), count(before), "문단은 나뉘지 않는다");
  assert.deepEqual(listFields(after).map((f) => f.valueText), ["홍\n길동", "한국", "홍\n길동"]);
  // 실패한 건에는 알림이 없다
  const [failed] = generateAll(bytes, places, parseQuickData(enc({ 성명: "홍\n길동" })), "f.hwpx", "error");
  assert.deepEqual([failed?.view.ok, failed?.view.notes], [false, []]);
});

test("줄바꿈 알림은 값이 실제로 들어간 자리에만 붙는다 — 줄바꿈·탭이 든 누름틀(inline)은 이제 채워져 알림이 붙고, 엔진이 건너뛴 자리(안에 그림이 든 object)에는 붙지 않는다", () => {
  // inline-breaks의 `줄`·`탭`: 한 문단 안, 사이에 줄바꿈·탭 요소가 있는 누름틀. 엔진이 채운다
  const inline = readFixture("inline/inline-breaks");
  const inlineData = { 줄: "가\n나", 탭: "다\t라" };
  const [a] = generateAll(inline, analyzePlaces(inline), parseQuickData(enc(inlineData)), "f.hwpx", "error");
  assert.deepEqual([a?.view.ok, a?.view.filled, a?.view.skipped, a?.view.errors], [true, 2, [], []]);
  assert.deepEqual(a?.view.notes.map((n) => [n.code, n.place]), [["QUICK_MULTILINE", "키 줄"], ["QUICK_MULTILINE", "키 탭"]]);
  assert.deepEqual(a?.output, direct(inline, inlineData));
  assert.deepEqual(listFields(parseDocument(openPackage(a?.output ?? new Uint8Array(0)))).map((f) => [f.name, f.valueText]), [["줄", "가\n나"], ["탭", "다\t라"]]);

  // 안에 그림이 든 누름틀(object)은 엔진이 건너뛰므로 값에 줄바꿈이 있어도 알림이 붙지 않는다
  const bytes = synth([
    P(R(T("성명: ") + FIELD_BEGIN("41", "성명", "1", "x") + T("값") + FIELD_END("41"))),
    P(R(FIELD_BEGIN("42", "그림", "1", "x") + T("앞") + PIC("1") + T("뒤") + FIELD_END("42"))),
  ]);
  const places = analyzePlaces(bytes);
  assert.deepEqual(places.fields.map((f) => [f.name, f.fillable, f.unfillable]), [["성명", 1, []], ["그림", 0, [{ shape: "object", count: 1 }]]]);
  const [g] = generateAll(bytes, places, parseQuickData(enc({ 성명: "홍\n길동", 그림: "가\n나" })), "f.hwpx", "error");
  assert.equal(g?.view.ok, true);
  assert.deepEqual(g?.view.skipped.map((s) => [s.code, s.place]), [["FIELD_UNSUPPORTED_SHAPE", '누름틀 "그림"']]);
  assert.deepEqual(g?.view.notes.map((n) => n.place), ["키 성명"]);
  assert.match(g?.view.skipped[0]?.plain ?? "", /그림·표/, "쉬운 말이 안에 그림·표가 든 누름틀도 해당함을 밝힌다");
});

test("대조표의 badKey(usable:false)는 엔진이 FIELD_NAME_NOT_PATH로 건너뛰는 누름틀과 같은 기준이다", () => {
  const names = ["성명", "이 름", "a.b", "a..b", "x(y)", "회사-이름", "_밑줄", "끝점.", ".앞점"];
  const bytes = synth(names.map((name, i) => P(R(T("앞 ") + FIELD_BEGIN(String(60 + i), name, "1", "안내") + T("값") + FIELD_END(String(60 + i))))));
  const places = analyzePlaces(bytes);
  assert.deepEqual(places.fields.map((f) => f.name), names);
  // 엔진이 건너뛴 누름틀: 템플릿 없이 모의 실행한 보고서의 건너뜀
  const data = { 성명: "가", a: { b: "나" }, "회사-이름": "다", _밑줄: "라" };
  const r = generate(bytes, emptyTemplate(), readDataset(data), { dryRun: true });
  assert.ok(r.ok);
  const skipped = r.report.plan.skipped.filter((s) => s.code === "FIELD_NAME_NOT_PATH").map((s) => s.anchor.slice("field:".length));
  assert.deepEqual(places.fields.filter((f) => !f.usable).map((f) => f.name).sort(), [...skipped].sort());
  assert.deepEqual(places.fields.filter((f) => f.usable).map((f) => f.name), ["성명", "a.b", "회사-이름", "_밑줄"]);
  // 대조표도 같은 자리를 badKey로 보인다
  const matches = matchPlaces(places, parseQuickData(enc(data)).records);
  assert.deepEqual(matches.filter((m) => m.state === "badKey").map((m) => m.key).sort(), [...skipped].sort());
});
