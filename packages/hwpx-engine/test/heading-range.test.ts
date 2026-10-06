// 제목 범위 앵커(7.10 `headingRange`): 제목 탐지(꼴 7종·다단·조문·표 칸 안·굵은 제목·제목 아님), 단계와 `opts.order`, 범위 경계,
// 앵커 초안의 지문, 1판·2판 읽기, 교체·삭제·삽입이 같은 범위의 `range` 앵커와 바이트 동일, 2판 슬롯 생성, 해석·checkAnchors·재지정, 무작위 50회 이상.
// 기대값은 heading-helpers의 모형(시험이 적어 넣은 꼴)에 명세 규칙을 적용해 세운다. 엔진 출력을 기대값으로 옮겨 적지 않는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HwpxError } from "../src/errors.ts";
import { findPlaceholders, listFields, type HwpxDocument, type ParagraphNode } from "../src/index.ts";
import {
  checkAnchors,
  detectHeadings,
  draftAnchors,
  generate,
  generateFromTemplate,
  headingRangeOf,
  makeHeadingRangeAnchor,
  makeRangeAnchor,
  planRelocation,
  redraftAnchor,
  resolveAnchors,
  type GenerateResult,
  type HeadingForm,
  type HeadingRangeAnchor,
  type RangeAnchor,
  type StudioGenerateResult,
} from "../src/fill/index.ts";
import { readStudioTemplate, readTemplate, sha256Hex as sha256Text, writeStudioTemplate, type StudioAnchor } from "../src/template/index.ts";
import { generateText } from "../src/text/index.ts";
import { bytesEqual, readFixture, reparse, sha256Hex, utf8 } from "./helpers.ts";
import { BLOCK, BOLD, CELL_LINES, COPY_AFTER, H, P, SPEC_ORDER, expectedHeadings, headingDoc, headingIndex, insertLines, levelsOf, rangeOfModel, type Item, type Line, type Model } from "./heading-helpers.ts";
import { HEADINGS, KEEP, at, dataFor, del, done, ds, failed, fragOf, gateClean, inject, insertText, line, listOf, longValue, notice, remapHolds, rng, texts, top, tpl, walkTexts } from "./range-helpers.ts";

// ── 도우미 ────────────────────────────────────────────────────

function heading(doc: HwpxDocument, id: string, index: number, parentPath: number[] = []): HeadingRangeAnchor {
  const draft = makeHeadingRangeAnchor(doc, 0, parentPath, index);
  assert.ok(draft !== undefined, `제목 ${parentPath.join(",")}:${index}의 앵커를 만들지 못했다`);
  return { id, ...draft };
}
/** 제목 앵커와 같은 범위(모형에서 계산)의 range 앵커 */
function sameRange(doc: HwpxDocument, h: HeadingRangeAnchor, items: readonly Item[]): RangeAnchor {
  const r = rangeOfModel(items, h.index);
  const draft = makeRangeAnchor(doc, 0, h.at.parentPath, r.from, r.to);
  assert.ok(draft !== undefined);
  return { id: h.id, ...draft };
}
const printOf = (p: ParagraphNode) => ({ text: p.logicalText.slice(0, 40), sha256: sha256Hex(utf8(p.logicalText)) });
const codes = (r: GenerateResult | StudioGenerateResult): string[] => r.report.issues.map((i) => `${i.severity}:${i.code}:${i.where ?? ""}`);
function throwsCode(fn: () => unknown, code: string, label: string): void {
  assert.throws(fn, (e: unknown) => e instanceof HwpxError && e.code === code, `${label}: ${code}가 나야 한다`);
}
const itemsOf = (model: Model, parentPath: number[]): Item[] => {
  if (parentPath.length === 0) return model.top;
  const items = model.lists.get(parentPath.join(","));
  assert.ok(items !== undefined, `모형에 목록 ${parentPath.join(",")}이 없다`);
  return items;
};
const rawTpl = (anchors: unknown[], rules: unknown[] = []): Record<string, unknown> => ({ schema: "hwpx-studio/template@1", anchors, rules });

// ── 탐지 ──────────────────────────────────────────────────────

test("7.10 시험 문서: 최상위 125문단(합성 공고서 63 + 덧붙인 60 + 표 2), 칸 [12, 1]은 13문단·그 복사본은 16문단, 자리 수십 개", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  assert.equal(top(doc).length, model.top.length);
  assert.equal(top(doc).length, 63 + BLOCK.length + 2);
  assert.equal(top(doc).length, 125);
  // 시험이 적어 넣은 글이 모형의 자리에 그대로 있다(규칙 순서대로 이어 붙었다)
  model.top.forEach((x, i) => {
    if (x.text !== undefined) assert.equal(at(top(doc), i).logicalText, x.text, `문단 ${i}`);
  });
  for (const [key, items] of model.lists) assert.deepEqual(texts(listOf(doc, key.split(",").map(Number))).slice(6), items.slice(6).map((x) => x.text), key);
  assert.deepEqual([...model.lists.values()].map((x) => x.length), [13, 16]);
  assert.ok(listFields(doc).length >= 60, `필드 ${listFields(doc).length}개`);
  const placeholders = walkTexts(top(doc)).reduce((n, t) => n + findPlaceholders(t).length, 0);
  assert.ok(placeholders >= 60, `{{}} ${placeholders}곳`);
  assert.ok((BLOCK.find((l) => l.text.startsWith("아주 긴"))?.text.length ?? 0) > 40, "긴 굵은 글은 40자보다 길어야 한다");
});

test("7.10 detectHeadings: 꼴 11종·다단·조문 장/절/조·기호별 단계·칸 안·굵은 제목이 기대(꼴·단계·글 앞 40자·굵기)와 같고 제목이 아닌 문단은 없다(문서 순서)", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const got = detectHeadings(doc);
  const want = expectedHeadings(model);
  assert.equal(got.length, want.length);
  assert.equal(want.length, 47);
  got.forEach((h, k) => {
    const w = at(want, k);
    assert.deepEqual(
      [h.at, h.index, h.marker, h.text, h.bold],
      [{ sectionIndex: 0, parentPath: w.parentPath }, w.index, { form: w.form, level: w.level }, w.text, w.bold],
      `제목 ${k}`,
    );
    assert.equal(h.sha256, sha256Hex(utf8(at(listOf(doc, w.parentPath), w.index).logicalText)), `제목 ${k}의 글 해시`);
    assert.equal(h.height, 1000, "합성 공고서의 글자모양 0·7은 10pt");
    assert.ok(h.text.length <= 40);
  });
  // 꼴 11종이 모두 있다
  assert.deepEqual([...new Set(got.map((h) => h.marker.form))].sort(), [...SPEC_ORDER].sort());
  // 최상위 단계: 조문 장 1·절 2·조 3 → 로마 4 → 숫자 단일 5·다단 6·7 → 한글+점 8 → 1) 9 → 가) 10 → (1) 11 → (가) 12 → 원문자 13
  // → 기호는 처음 나온 순서대로 □ 14·- 15·※ 16·◆ 17 → 번호 없음 18
  const lv = (text: string) => got.find((h) => h.at.parentPath.length === 0 && h.text.startsWith(text))?.marker.level;
  assert.deepEqual(
    ["제1장", "제1절", "제1조", "Ⅰ.", "Ⅱ", "7. 일반", "7.1. 세부", "7.1.1.", "7.2 점", "8. 점", "12. 두 자리", "가. 첫째", "1) 닫는", "가) 닫는", "(1)", "(가)", "①", "⑴", "㉠", "㉮", "➀", "❶", "□ 네모", "- 줄표", "※", "◆", "굵은 짧은"].map(lv),
    [1, 2, 3, 4, 4, 5, 6, 7, 6, 5, 5, 8, 9, 10, 11, 12, 13, 13, 13, 13, 13, 13, 14, 15, 16, 17, 18],
  );
  // 칸 안: 숫자+점 1, 한글+점 2, 기호 3(그 목록에 나타난 꼴만 센다)
  assert.deepEqual(got.filter((h) => h.at.parentPath.join(",") === "12,1").map((h) => [h.index, h.marker.form, h.marker.level]), [[6, "digitDot", 1], [8, "hangulDot", 2], [10, "box", 3], [11, "digitDot", 1]]);
  // 제목이 아닌 것: 번호 글자 뒤 빈 글, 문장 끝 굵은 글, 40자 넘는 굵은 글, 1.5배·(주)·날짜·Ⅲ.·ASCII I.·-5도,
  // 점 없는 숫자(`8 공백`·`3 개월`·날짜 빈칸 `20  .`), 번호 뒤 글이 `숫자.`인 날짜(`10. 4.(금)`)
  const notHeading = BLOCK.filter((l) => l.mark === undefined).map((l) => l.text);
  for (const t of notHeading) assert.ok(!got.some((h) => h.text === t.slice(0, 40)), `'${t.slice(0, 12)}'는 제목이 아니다`);
  assert.ok(notHeading.length >= 24);
  for (const t of ["8 공백", "20  .", "3 개월", "10. 4."]) assert.ok(notHeading.some((x) => x.startsWith(t)), t);
  // 결정성: 다시 읽은 문서에서 같은 결과
  assert.deepEqual(detectHeadings(reparse(bytes)), got);
});

test("7.10 detectHeadings opts.order: 서열을 바꾸면 그 서열로 단계를 다시 센다(빠진 꼴은 기본 서열대로 뒤에)", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const orders: HeadingForm[][] = [["box", "digitDot"], ["none"], ["circled", "hangulParens", "digitParen", "hangulDot", "digitDot", "article", "box", "none", "roman"], ["digitDot", "digitDot", "article"], ["digitParens", "roman"]];
  for (const order of orders) {
    const got = detectHeadings(doc, { order }).map((h) => [h.at.parentPath, h.index, h.marker.form, h.marker.level]);
    assert.deepEqual(got, expectedHeadings(model, order).map((w) => [w.parentPath, w.index, w.form, w.level]), order.join(">"));
  }
  // 기호를 맨 앞에 두면 최상위의 기호 제목이 처음 나온 순서대로 1~4단계, 조문 장이 5단계
  const boxFirst = detectHeadings(doc, { order: ["box"] });
  assert.equal(boxFirst.find((h) => h.text.startsWith("□ 네모"))?.marker.level, 1);
  assert.equal(boxFirst.find((h) => h.text.startsWith("◆"))?.marker.level, 4);
  assert.equal(boxFirst.find((h) => h.text.startsWith("제1장"))?.marker.level, 5);
  // 서열을 주지 않은 것과 기본 서열을 그대로 준 것은 같다
  assert.deepEqual(detectHeadings(doc, { order: SPEC_ORDER }), detectHeadings(doc));
});

// ── 범위 ──────────────────────────────────────────────────────

test("7.10 headingRangeOf: 다음 같은 단계 이상 제목 앞까지, 부모 끝, 사이의 표 포함, 칸 안 제목은 범위를 끊지 않는다", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  let checked = 0;
  for (const w of expectedHeadings(model)) {
    const items = itemsOf(model, w.parentPath);
    assert.deepEqual(headingRangeOf(doc, { sectionIndex: 0, parentPath: w.parentPath }, w.index), rangeOfModel(items, w.index), `${w.parentPath.join(",")}:${w.index}`);
    checked++;
  }
  assert.equal(checked, 47);
  const copyAt = 63 + COPY_AFTER + 1;
  const range = (text: string) => headingRangeOf(doc, { sectionIndex: 0, parentPath: [] }, headingIndex(model, text));
  // '7. 일반 사항'은 '8. 점 번호 항목' 앞까지이고 칸 안에 제목이 든 표 복사본을 포함한다
  assert.deepEqual(range("7. 일반"), { from: headingIndex(model, "7. 일반"), to: headingIndex(model, "8. 점") - 1 });
  assert.ok(at(top(doc), copyAt).subLists.length > 1 && detectHeadings(doc).some((h) => h.at.parentPath.join(",") === `${copyAt},1`));
  assert.deepEqual(range("가. 첫째"), { from: headingIndex(model, "가. 첫째"), to: copyAt });
  // 원본의 '6. 제6장'은 덧붙인 '제1장 총칙'(더 높은 단계) 앞까지(사이의 표 2개 포함)
  assert.deepEqual(range("6. 제6장"), { from: 42, to: 62 });
  // 같은 단계 이상이 더 없는 제목은 부모(구역 최상위)의 끝까지
  for (const t of ["제2장", "제1절", "제3조의2", "9. 마지막"]) assert.equal(range(t)?.to, top(doc).length - 1, t);
  // 1)의 범위는 아래 단계인 가)에서 끊기지 않고 다음 같은 단계 이상 제목('7.1.1.') 앞까지, 로마 Ⅱ는 부모 끝까지
  assert.deepEqual(range("1) 닫는"), { from: headingIndex(model, "1) 닫는"), to: headingIndex(model, "7.1.1.") - 1 });
  assert.deepEqual(range("Ⅰ."), { from: headingIndex(model, "Ⅰ."), to: headingIndex(model, "Ⅱ") - 1 });
  assert.equal(range("Ⅱ")?.to, top(doc).length - 1);
  // 칸 안 목록: 끝까지
  assert.deepEqual(headingRangeOf(doc, { sectionIndex: 0, parentPath: [12, 1] }, 11), { from: 11, to: 12 });
  // 제목이 아니거나 주소가 없으면 undefined
  const none: [number, number[], number][] = [[0, [], 0], [0, [], 1], [0, [], headingIndex(model, "굵은 짧은") + 2], [0, [], 999], [1, [], 17], [0, [12], 0], [0, [12, 99], 0], [0, [], -1]];
  for (const [s, pp, i] of none) assert.equal(headingRangeOf(doc, { sectionIndex: s, parentPath: pp }, i), undefined, JSON.stringify([s, pp, i]));
});

test("7.10 makeHeadingRangeAnchor: 꼴·단계, 제목 지문(글 앞 40자·글 해시), 범위 지문 = 같은 범위의 makeRangeAnchor 지문", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  for (const w of expectedHeadings(model)) {
    const items = itemsOf(model, w.parentPath);
    const r = rangeOfModel(items, w.index);
    const draft = makeHeadingRangeAnchor(doc, 0, w.parentPath, w.index);
    const list = listOf(doc, w.parentPath);
    assert.deepEqual(draft, {
      kind: "headingRange",
      at: { sectionIndex: 0, parentPath: w.parentPath },
      index: w.index,
      marker: { form: w.form, level: w.level },
      heading: printOf(at(list, w.index)),
      print: makeRangeAnchor(doc, 0, w.parentPath, r.from, r.to)?.print,
    });
    assert.deepEqual(draft?.heading, draft?.print.first, "제목 지문은 범위의 첫 문단 지문과 같다");
  }
  assert.equal(makeHeadingRangeAnchor(doc, 0, [], 1), undefined);
  assert.equal(makeHeadingRangeAnchor(doc, 0, [], headingIndex(model, "굵은 짧은") + 2), undefined, "굵은 문장은 제목이 아니다");
  assert.equal(makeHeadingRangeAnchor(doc, 3, [], 17), undefined);
  // Heading.text는 개체 자리 글자를 뺀 앞 40자, 앵커의 제목 지문 글은 문단 글 앞 40자 그대로(해시는 같다): hancom/blocks의 문단 0은 개체 자리 글자 둘 뒤에 '1. 개요'
  const blocks = reparse(readFixture("hancom/blocks"));
  const h0 = at(detectHeadings(blocks), 0);
  const a0 = makeHeadingRangeAnchor(blocks, 0, [], 0);
  assert.equal(h0.text, "1. 개요");
  assert.equal(a0?.heading.text, at(top(blocks), 0).logicalText.slice(0, 40));
  assert.notEqual(a0?.heading.text, h0.text);
  assert.equal(a0?.heading.sha256, h0.sha256);
});

// ── 읽기 ──────────────────────────────────────────────────────

test("7.10 1판 readTemplate: headingRange 앵커와 inject·insertText·delete 규칙을 읽고 쓴 그대로 돌려준다. 틀린 모양은 TPL_ANCHOR, fill·tableProps·resize·repeat·scope는 TPL_RULE", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const a = heading(doc, "h", headingIndex(model, "7. 일반"));
  const c = heading(doc, "c", 6, [12, 1]);
  const rules = [inject("i", "h", "frag.json", "before"), insertText("t", "c", "글", "replace"), del("d", "h")];
  const raw = rawTpl([a, c], rules);
  const t = readTemplate(JSON.stringify(raw));
  assert.deepEqual(t.anchors, [a, c]);
  assert.equal(t.rules.length, 3);

  const bad: [string, (x: Record<string, any>) => void][] = [
    ["index 없음", (x) => delete x["index"]],
    ["음수 index", (x) => (x["index"] = -1)],
    ["모르는 꼴(옛 이름 paren)", (x) => (x["marker"] = { form: "paren", level: 1 })],
    ["단계 0", (x) => (x["marker"] = { form: "digitDot", level: 0 })],
    ["marker의 모르는 키", (x) => (x["marker"] = { form: "digitDot", level: 1, sub: 0 })],
    ["모르는 키 from", (x) => (x["from"] = 3)],
    ["홀수 parentPath", (x) => (x["at"] = { sectionIndex: 0, parentPath: [12] })],
    ["heading 없음", (x) => delete x["heading"]],
    ["heading 해시가 64자 아님", (x) => (x["heading"] = { text: "x", sha256: "abc" })],
    ["print.count 0", (x) => (x["print"] = { ...x["print"], count: 0 })],
    ["print.last 없음", (x) => (x["print"] = { first: x["print"]["first"], count: 1, sha256: x["print"]["sha256"] })],
  ];
  for (const [label, change] of bad) {
    const anchor = structuredClone(a) as unknown as Record<string, any>;
    change(anchor);
    throwsCode(() => readTemplate(JSON.stringify(rawTpl([anchor]))), "TPL_ANCHOR", label);
  }
  const rule = (r: unknown) => () => readTemplate(JSON.stringify(rawTpl([a], [r])));
  throwsCode(rule({ id: "f", do: { type: "fill", anchor: "h", value: { text: "x" } } }), "TPL_RULE", "fill");
  throwsCode(rule({ id: "f", do: { type: "tableProps", anchor: "h", table: { treatAsChar: false } } }), "TPL_RULE", "tableProps");
  throwsCode(rule({ id: "f", do: { type: "resize", anchor: "h", scale: 0.5 } }), "TPL_RULE", "resize");
  throwsCode(rule({ id: "f", do: { type: "repeat", anchor: "h", each: { path: "items" } } }), "TPL_RULE", "repeat");
  throwsCode(rule({ id: "f", do: { type: "delete", anchor: "h", scope: "row" } }), "TPL_RULE", "delete scope");
});

function studioRaw(bytes: Uint8Array, anchors: unknown[], slots: unknown[], blocks: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "hwpx-studio/template@2",
    id: "t0a1b2c3d",
    version: 1,
    source: { kind: "hwpx", sha256: sha256Hex(bytes) },
    patterns: [{ id: "pt1", name: "제목", marker: { form: "hangulDot", level: 7 }, place: "body", match: ["marker"] }],
    anchors,
    values: [{ id: "v1", name: "기관", format: "text" }],
    bindings: [{ value: "v1", key: "기관명" }],
    places: [{ id: "p1", kind: "placeholder", key: "기관명", value: "v1" }],
    slots,
    blocks,
    options: { unregistered: "keep" },
    ...extra,
  };
}

test("7.10 2판 readStudioTemplate: headingRange 앵커(pattern 포함)를 슬롯 앵커로 받고 정규 쓰기 왕복. 틀린 모양·md 원본은 TPL_ANCHOR, 겹치는 슬롯은 TPL_CONFLICT, 패턴 꼴은 11종(옛 paren은 TPL_FIELD)", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const h1 = { ...heading(doc, "h1", headingIndex(model, "가. 첫째")), pattern: "pt1" };
  const h2 = heading(doc, "h2", 6, [12, 1]);
  const slots = [{ id: "s1", name: "가 항목", anchors: ["h1"], parent: null }, { id: "s2", name: "칸", anchors: ["h2"], parent: null }];
  const blocks = [{ id: "b1", slot: "s1", name: "글", content: { text: "교체" } }, { id: "b2", slot: "s2", name: "글 둘", content: { text: "칸 교체" } }];
  const raw = studioRaw(bytes, [h1, h2], slots, blocks);
  const t = readStudioTemplate(JSON.stringify(raw));
  assert.ok(t.schema === "hwpx-studio/template@2");
  assert.deepEqual(t.anchors, [h1, h2]);
  const again = readStudioTemplate(writeStudioTemplate(t));
  assert.deepEqual(again, t);

  const wrong = structuredClone(h1) as unknown as Record<string, any>;
  wrong["marker"] = { form: "digitDot" };
  throwsCode(() => readStudioTemplate(JSON.stringify(studioRaw(bytes, [wrong, h2], slots, blocks))), "TPL_ANCHOR", "단계 없음");
  throwsCode(() => readStudioTemplate(JSON.stringify({ ...raw, source: { kind: "md", sha256: sha256Hex(bytes) }, slots: [], blocks: [] })), "TPL_ANCHOR", "md 원본");
  // 패턴의 꼴은 제목 꼴 11종과 같다: 새 꼴은 받고 옛 이름 paren은 거절(TPL_FIELD)
  const withPattern = (form: string) => JSON.stringify({ ...raw, patterns: [{ id: "pt1", name: "제목", marker: { form, level: 1 }, place: "body", match: ["marker"] }] });
  for (const form of ["roman", "digitParen", "hangulParen", "digitParens", "hangulParens"]) assert.equal(readStudioTemplate(withPattern(form)).schema, "hwpx-studio/template@2", form);
  throwsCode(() => readStudioTemplate(withPattern("paren")), "TPL_FIELD", "패턴 꼴 paren");
  // '7. 일반 사항'의 범위는 '가. 첫째 항목'의 범위를 품는다: 두 슬롯이 겹친다
  const h3 = heading(doc, "h3", headingIndex(model, "7. 일반"));
  throwsCode(
    () => readStudioTemplate(JSON.stringify(studioRaw(bytes, [h1, h3], [{ id: "s1", name: "가", anchors: ["h1"], parent: null }, { id: "s3", name: "칠", anchors: ["h3"], parent: null }], [blocks[0], { id: "b3", slot: "s3", name: "셋", content: { text: "x" } }]))),
    "TPL_CONFLICT",
    "겹치는 슬롯",
  );
  // range와 겹쳐도 같다
  const r = sameRange(doc, { ...h3, id: "r3" }, model.top);
  throwsCode(
    () => readStudioTemplate(JSON.stringify(studioRaw(bytes, [h1, r], [{ id: "s1", name: "가", anchors: ["h1"], parent: null }, { id: "s3", name: "칠", anchors: ["r3"], parent: null }], [blocks[0], { id: "b3", slot: "s3", name: "셋", content: { text: "x" } }]))),
    "TPL_CONFLICT",
    "range와 겹치는 슬롯",
  );
});

// ── 교체·삭제·삽입: 같은 범위의 range와 바이트 동일 ───────────────

/** 제목 앵커 템플릿과 같은 범위의 range 템플릿으로 각각 만든 결과가 바이트·이동표·버림·건너뜀까지 같은가 */
function sameAsRange(bytes: Uint8Array, doc: HwpxDocument, model: Model, anchors: HeadingRangeAnchor[], rules: unknown[], data: Record<string, unknown> | undefined, label: string): { h: GenerateResult; r: GenerateResult } {
  const ranges = anchors.map((a) => sameRange(doc, a, itemsOf(model, a.at.parentPath)));
  const run = (as: unknown[]) => (data === undefined ? generate(bytes, tpl(as, rules), ds({}), KEEP) : generate(bytes, tpl(as, rules), ds(data)));
  const h = run(anchors);
  const r = run(ranges);
  assert.equal(h.ok, r.ok, `${label}: 성공 여부`);
  assert.deepEqual(codes(h), codes(r), `${label}: 이슈`);
  if (h.ok && !h.dryRun && r.ok && !r.dryRun) {
    assert.ok(bytesEqual(h.output, r.output), `${label}: 결과 바이트가 range와 같다`);
    assert.deepEqual(h.report.plan.moves, r.report.plan.moves, `${label}: 이동표`);
    assert.deepEqual(h.report.plan.dropped, r.report.plan.dropped, `${label}: 버림`);
    assert.deepEqual(h.report.plan.actions, r.report.plan.actions, `${label}: 액션`);
  }
  return { h, r };
}

test("7.10 headingRange 교체·삭제·앞뒤 삽입(조각·글): 결과·이동표·범위 밖 글 보존·게이트·새 오류 0이 같은 범위의 range 결과와 바이트 동일", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const blocks = reparse(readFixture("hancom/blocks"));
  const rich = reparse(readFixture("tables/tables-rich"));
  const targets: [string, number, number[]][] = [
    ["7. 일반(표 복사본 포함)", headingIndex(model, "7. 일반"), []],
    ["가. 첫째", headingIndex(model, "가. 첫째"), []],
    ["굵은 짧은 제목(표 포함)", headingIndex(model, "굵은 짧은"), []],
    ["제1장 총칙", headingIndex(model, "제1장"), []],
    ["9. 마지막(부모 끝)", headingIndex(model, "9. 마지막"), []],
    ["원본 3. 제3장", 27, []],
    ["칸 1. 칸 제목 하나", 6, [12, 1]],
    ["칸 2. 칸 제목 둘(칸 끝)", 11, [12, 1]],
  ];
  const actions: [string, (id: string) => unknown][] = [
    ["조각 교체", (id) => inject("x", id, fragOf(blocks, 2, 4))],
    ["표 조각 교체", (id) => inject("x", id, fragOf(rich, 1, 1))],
    ["글 교체", (id) => insertText("x", id, "교체 글 & <a> \"인용\"\n둘째 줄 {{기관명}}")],
    ["삭제", (id) => del("x", id)],
    ["앞 조각", (id) => inject("x", id, fragOf(blocks, 2, 3), "before")],
    ["뒤 글", (id) => insertText("x", id, "뒤에 붙인 글", "after")],
  ];
  const beforeTop = texts(top(doc));
  let runs = 0;
  for (const [name, index, parentPath] of targets) {
    const a = heading(doc, "h", index, parentPath);
    const items = itemsOf(model, parentPath);
    const r = rangeOfModel(items, index);
    for (const [act, rule] of actions) {
      const { h } = sameAsRange(bytes, doc, model, [a], [rule("h")], undefined, `${name} ${act}`);
      const ok = done(h);
      gateClean(bytes, ok);
      // 이동표: 범위 하나가 항목 하나(교체·삭제), 삽입은 빈 범위
      const move = at(ok.report.plan.moves, 0);
      assert.deepEqual([move.parentPath, move.from, move.to], act.startsWith("앞") ? [parentPath, r.from, r.from - 1] : act.startsWith("뒤") ? [parentPath, r.to + 1, r.to] : [parentPath, r.from, r.to], `${name} ${act}: 이동표`);
      // 범위 밖 최상위 문단은 이동표대로 옮긴 자리에 그대로 있다
      const after = reparse(ok.output);
      const covered = remapHolds(ok.report.plan.moves, beforeTop, after);
      assert.equal(covered, parentPath.length === 0 && !act.startsWith("앞") && !act.startsWith("뒤") ? r.to - r.from + 1 : 0, `${name} ${act}: 덮인 문단 수`);
      runs++;
    }
  }
  assert.equal(runs, targets.length * actions.length);
});

test("7.10 headingRange 여러 규칙 + 자리 수십 개에 긴 값(수백 자·줄바꿈·탭·XML 특수문자): range 결과와 바이트 동일, 범위 안 자리는 dropped, 겹치면 TPL_CONFLICT", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const blocks = reparse(readFixture("hancom/blocks"));
  const next = rng(19);
  const data = dataFor(doc, () => longValue(next, 150, 700));
  const anchors = [
    heading(doc, "a", headingIndex(model, "제1조")),
    heading(doc, "b", headingIndex(model, "가. 첫째")),
    heading(doc, "c", headingIndex(model, "(1)")),
    heading(doc, "d", headingIndex(model, "굵은 짧은")),
    heading(doc, "e", 6, [12, 1]),
    heading(doc, "f", 27),
  ];
  const rules = [inject("A", "a", fragOf(blocks, 2, 4)), del("B", "b"), insertText("C", "c", "괄호 항목 교체 & <글>\n둘째 줄"), inject("D", "d", fragOf(blocks, 2, 3), "before"), insertText("E", "e", "칸 교체"), del("F", "f")];
  const { h } = sameAsRange(bytes, doc, model, anchors, rules, data, "여러 규칙");
  const ok = done(h);
  gateClean(bytes, ok);
  assert.ok(ok.report.plan.dropped.length > 0, "교체·삭제 범위 안의 자리는 dropped");
  assert.equal(ok.report.plan.moves.length, 6);
  // 결정성
  const again = done(generate(bytes, tpl(anchors, rules), ds(data)));
  assert.ok(bytesEqual(again.output, ok.output));

  // '7. 일반'의 범위는 '가. 첫째'를 품는다: 둘 다 교체·삭제면 TPL_CONFLICT(range와 같은 판정)
  const outer = heading(doc, "o", headingIndex(model, "7. 일반"));
  const { h: clash } = sameAsRange(bytes, doc, model, [outer, at(anchors, 1)], [del("O", "o"), insertText("B", "b", "글")], undefined, "겹침");
  assert.ok(failed(clash).includes("TPL_CONFLICT"));
});

test("7.10 2판 generateFromTemplate: headingRange 슬롯 앵커(조각·글·빈 글 블록)의 결과가 같은 범위의 range 슬롯 결과와 바이트 동일", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const blocksDoc = reparse(readFixture("hancom/blocks"));
  const blob = new TextEncoder().encode(JSON.stringify(fragOf(blocksDoc, 2, 4)));
  const sha = sha256Text(blob);
  const blobs = new Map([[sha, blob]]);
  const hs = [{ ...heading(doc, "h1", headingIndex(model, "가. 첫째")), pattern: "pt1" }, heading(doc, "h2", 6, [12, 1]), heading(doc, "h3", headingIndex(model, "굵은 짧은"))];
  const slots = [{ id: "s1", name: "가 항목", anchors: ["h1"], parent: null }, { id: "s2", name: "칸", anchors: ["h2"], parent: null }, { id: "s3", name: "굵은", anchors: ["h3"], parent: null }];
  const blocks = [
    { id: "b1", slot: "s1", name: "조각", content: { fragment: sha } },
    { id: "b2", slot: "s2", name: "글", content: { text: "칸 교체 {{기관명}}\n둘째 줄 & <x>" } },
    { id: "b3", slot: "s3", name: "빈 글", content: { text: "" } },
  ];
  const record = { 기관명: longValue(rng(7), 200, 400) };
  const make = (anchors: unknown[]) => readStudioTemplate(JSON.stringify(studioRaw(bytes, anchors, slots, blocks)), { hasBlob: (s) => blobs.has(s) });
  const tH = make(hs);
  const tR = make(hs.map((a) => ({ ...sameRange(doc, a, itemsOf(model, a.at.parentPath)), ...("pattern" in a ? { pattern: a.pattern } : {}) })));
  assert.ok(tH.schema === "hwpx-studio/template@2" && tR.schema === "hwpx-studio/template@2");
  const rH = generateFromTemplate(bytes, tH, record, undefined, (s) => blobs.get(s));
  const rR = generateFromTemplate(bytes, tR, record, undefined, (s) => blobs.get(s));
  assert.ok(rH.ok && !rH.dryRun, JSON.stringify(codes(rH)));
  assert.ok(rR.ok && !rR.dryRun);
  assert.ok(rH.output instanceof Uint8Array && rR.output instanceof Uint8Array);
  assert.ok(bytesEqual(rH.output, rR.output), "결과 바이트가 range 슬롯과 같다");
  assert.deepEqual(rH.report.moves, rR.report.moves);
  assert.deepEqual(rH.report.anchors?.map((c) => c.state), ["exact", "exact", "exact"]);
  assert.deepEqual(rH.report.validation?.newErrors, []);
  // 슬롯 자리에 블록 글이 들어갔다
  const out = reparse(rH.output);
  const cellTexts = texts(listOf(out, [12, 1]));
  const cellRange = rangeOfModel(itemsOf(model, [12, 1]), 6);
  assert.equal(cellTexts.length, 13 - (cellRange.to - cellRange.from + 1) + 2, "칸 범위 5문단이 블록 글 2문단으로");
  assert.ok(cellTexts.some((t) => t.startsWith("칸 교체 ") && !t.includes("{{")), "칸 블록의 {{기관명}}이 채워졌다");
});

// ── 해석·checkAnchors·재지정 ───────────────────────────────────

test("7.10 해석·checkAnchors: exact, 앞에 문단 삽입 relocated(found 갱신), 제목 복제 중 범위 지문이 한 곳만 맞으면 relocated·둘 다 맞으면 ambiguous, 제목 글 변경 notFound, 범위 글 변경·문단 추가 changed", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const i7 = headingIndex(model, "7. 일반");
  const iga = headingIndex(model, "가. 첫째");
  const ijang = headingIndex(model, "제1장");
  const inone = headingIndex(model, "굵은 짧은");
  const copyAt = 63 + COPY_AFTER + 1;
  const anchors: StudioAnchor[] = [
    heading(doc, "a7", i7),
    { ...heading(doc, "aga", iga), pattern: "pt1" },
    heading(doc, "acell", 6, [12, 1]),
    heading(doc, "ajang", ijang),
    heading(doc, "anone", inone),
    heading(doc, "acopy", 14, [copyAt, 1]),
    heading(doc, "acell2", 11, [12, 1]),
  ];
  const t = { anchors };
  const v1 = tpl(anchors, []);
  const range = (i: number, pp: number[] = []) => rangeOfModel(itemsOf(model, pp), i);
  const markerOf = (i: number, pp: number[]) => ({ form: itemsOf(model, pp)[i]?.mark?.form, level: levelsOf(itemsOf(model, pp)).get(i) });
  const found = (i: number, pp: number[] = [], shift = 0, ppAfter = pp) => ({
    kind: "headingRange",
    at: { sectionIndex: 0, parentPath: ppAfter },
    index: i + shift,
    marker: markerOf(i, pp),
    from: range(i, pp).from + shift,
    to: range(i, pp).to + shift,
  });
  const states = (d: HwpxDocument) => checkAnchors(d, t).map((c) => [c.anchor, c.state, c.issues.map((i) => i.code).join(",")]);

  // exact
  const exact = resolveAnchors(doc, v1);
  assert.deepEqual(exact.issues, []);
  const r7 = exact.anchors.get("a7");
  assert.ok(r7?.kind === "range");
  assert.deepEqual([r7.parentPath, r7.from, r7.to, r7.relocated], [[], range(i7).from, range(i7).to, false]);
  const checks = checkAnchors(doc, t);
  assert.deepEqual(checks.map((c) => c.state), ["exact", "exact", "exact", "exact", "exact", "exact", "exact"]);
  assert.deepEqual(checks.map((c) => c.found), [found(i7), found(iga), found(6, [12, 1]), found(ijang), found(inone), found(14, [copyAt, 1]), found(11, [12, 1])]);

  // 앞(문단 1 뒤)에 문단 하나 → relocated, 최상위는 번호 + 1, 칸은 상위 표 문단 번호 + 1.
  // 칸 [12, 1]의 제목은 표 복사본 칸에도 있어 주소가 어긋나면 제목 지문이 두 곳이다. '1. 칸 제목 하나'(6)는 두 곳의 범위 글도 같아 ambiguous,
  // '2. 칸 제목 둘'(11)은 복사본 칸 범위에 덧붙인 본문이 있어 범위 지문이 원래 칸에서만 맞으므로 relocated
  const shifted = reparse(done(generate(bytes, tpl([line(doc, "p1", [1])], [insertText("i", "p1", "끼운 문단", "after")]), ds({}), KEEP)).output);
  assert.deepEqual(
    states(shifted),
    anchors.map((a) => (a.id === "acell" ? [a.id, "ambiguous", "ANCHOR_AMBIGUOUS"] : [a.id, "relocated", "ANCHOR_RELOCATED"])),
  );
  assert.deepEqual(checkAnchors(shifted, t).map((c) => c.found), [
    found(i7, [], 1),
    found(iga, [], 1),
    undefined,
    found(ijang, [], 1),
    found(inone, [], 1),
    found(14, [copyAt, 1], 0, [copyAt + 1, 1]),
    found(11, [12, 1], 0, [13, 1]),
  ]);
  const moved = resolveAnchors(shifted, v1).anchors.get("acopy");
  assert.ok(moved?.kind === "range" && moved.relocated);

  // 제목 글 변경 → 그 앵커만 notFound('7.'의 범위 안에 다른 앵커의 제목은 없다)
  const renamed = reparse(done(generate(bytes, tpl([line(doc, "p", [i7])], [insertText("i", "p", "7. 일반 사항 바뀜")]), ds({}), KEEP)).output);
  assert.deepEqual(states(renamed), [["a7", "notFound", "ANCHOR_NOT_FOUND"], ["aga", "exact", ""], ["acell", "exact", ""], ["ajang", "exact", ""], ["anone", "exact", ""], ["acopy", "exact", ""], ["acell2", "exact", ""]]);

  // 범위 안 본문 글 변경 → '가.'와 그것을 품은 '7.'이 changed(제목은 맞음)
  const body = iga + 1;
  const edited = reparse(done(generate(bytes, tpl([line(doc, "p", [body])], [insertText("i", "p", "바뀐 본문")]), ds({}), KEEP)).output);
  assert.deepEqual(states(edited), [["a7", "changed", "ANCHOR_CHANGED"], ["aga", "changed", "ANCHOR_CHANGED"], ["acell", "exact", ""], ["ajang", "exact", ""], ["anone", "exact", ""], ["acopy", "exact", ""], ["acell2", "exact", ""]]);
  // 범위 안에 문단 추가 → 같고, 그 뒤의 제목(굵은 제목, 표 복사본 칸 — 상위 표 문단이 뒤에 있다)은 한 칸 밀려 relocated
  const added = reparse(done(generate(bytes, tpl([line(doc, "p", [body])], [insertText("i", "p", "더한 문단", "after")]), ds({}), KEEP)).output);
  assert.deepEqual(states(added), [["a7", "changed", "ANCHOR_CHANGED"], ["aga", "changed", "ANCHOR_CHANGED"], ["acell", "exact", ""], ["ajang", "exact", ""], ["anone", "relocated", "ANCHOR_RELOCATED"], ["acopy", "relocated", "ANCHOR_RELOCATED"], ["acell2", "exact", ""]]);
  // 굵은 제목의 굵기를 잃으면(글은 같다) 제목이 아니다 → notFound
  const plain = reparse(done(generate(bytes, tpl([line(doc, "p", [inone])], [{ id: "i", do: { type: "insertText", anchor: "p", position: "replace", value: { text: "굵은 짧은 제목" }, style: { ...BOLD, charPrIDRef: "0" } } }]), ds({}), KEEP)).output);
  assert.equal(states(plain).find((s) => s[0] === "anone")?.[1], "notFound");

  // 앞에 문단 삽입 + '가. 첫째 항목' 제목 문단만 끝에 복제 → 제목 지문은 두 곳이지만 범위 지문은 원래 자리만 맞다 → relocated
  const end = [model.top.length - 1];
  const dupHead = reparse(done(generate(bytes, tpl([line(doc, "p1", [1]), line(doc, "end", end)], [insertText("i", "p1", "끼운 문단", "after"), inject("c", "end", fragOf(doc, iga, iga), "after")]), ds({}), KEEP)).output);
  assert.equal(states(dupHead).find((s) => s[0] === "aga")?.slice(1).join(), "relocated,ANCHOR_RELOCATED");
  // 범위 전체('가.'부터 표 복사본까지)를 끝에 복제 → 두 곳 모두 범위 지문까지 맞다 → ambiguous
  const r = range(iga);
  const dup = reparse(done(generate(bytes, tpl([line(doc, "p1", [1]), line(doc, "end", end)], [insertText("i", "p1", "끼운 문단", "after"), inject("c", "end", fragOf(doc, r.from, r.to), "after")]), ds({}), KEEP)).output);
  assert.equal(states(dup).find((s) => s[0] === "aga")?.slice(1).join(), "ambiguous,ANCHOR_AMBIGUOUS");

  // 생성: changed·ambiguous·notFound는 생성을 막고, relocated는 경고와 함께 된다
  assert.deepEqual(failed(generate(textsBytes(edited), tpl([at(anchors, 1)], [del("d", "aga")]), ds({}), KEEP)), ["ANCHOR_CHANGED"]);
  const ok = done(generate(textsBytes(shifted), tpl([at(anchors, 1)], [del("d", "aga")]), ds({}), KEEP));
  assert.deepEqual(ok.report.plan.relocated.map((x) => x.anchor), ["aga"]);
});
const textsBytes = (d: HwpxDocument): Uint8Array => d.pkg.bytes;

test("7.10 planRelocation·redraftAnchor: relocated는 at·index와 새 자리의 marker를 넣은 앵커(다시 읽고 exact), line 초안(제목 문단 클릭) → headingRange(id·pattern 유지), 제목 아닌 문단은 FILL_DRAFT_ADDRESS", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const iga = headingIndex(model, "가. 첫째");
  const copyAt = 63 + COPY_AFTER + 1;
  const anchors: StudioAnchor[] = [{ ...heading(doc, "aga", iga), pattern: "pt1" }, heading(doc, "acopy", 14, [copyAt, 1]), heading(doc, "a27", 27)];
  const shiftedBytes = done(generate(bytes, tpl([line(doc, "p1", [1])], [insertText("i", "p1", "끼운 문단", "after")]), ds({}), KEEP)).output;
  const shifted = reparse(shiftedBytes);
  const plan = planRelocation({ anchors }, checkAnchors(shifted, { anchors }));
  assert.ok(plan !== undefined);
  assert.deepEqual(plan.changed, ["aga", "acopy", "a27"]);
  const [ga, cell, a27] = plan.anchors;
  assert.deepEqual(ga, { ...at(anchors, 0), index: iga + 1 });
  assert.deepEqual(cell, { ...at(anchors, 1), at: { sectionIndex: 0, parentPath: [copyAt + 1, 1] } });
  assert.deepEqual(a27, { ...at(anchors, 2), index: 28 });
  assert.deepEqual(checkAnchors(shifted, { anchors: plan.anchors }).map((c) => c.state), ["exact", "exact", "exact"]);
  // 새 자리에서 단계가 바뀌면 marker도 바뀐다: 복사본 칸 머리에 로마 숫자 제목을 넣으면 그 칸의 '3. 복사본 칸 제목'은 한 칸 밀리고 1단계 → 2단계
  const roman = done(generate(bytes, tpl([line(doc, "c0", [copyAt, 1, 0])], [insertText("i", "c0", "Ⅰ. 로마 숫자 칸 머리", "after")]), ds({}), KEEP)).output;
  const romanDoc = reparse(roman);
  const acopy = at(anchors, 1);
  assert.ok(acopy.kind === "headingRange" && acopy.marker.level === 1);
  const replan = planRelocation({ anchors: [acopy] }, checkAnchors(romanDoc, { anchors: [acopy] }));
  assert.deepEqual(replan?.anchors, [{ ...acopy, index: 15, marker: { form: "digitDot", level: 2 } }]);
  assert.deepEqual(checkAnchors(romanDoc, { anchors: replan?.anchors ?? [] }).map((c) => c.state), ["exact"]);
  // 1판 읽기도 받는다(알 수 없는 키가 없다)
  assert.deepEqual(readTemplate(JSON.stringify(rawTpl(plan.anchors.slice(1)))).anchors, plan.anchors.slice(1));
  // changed가 있으면 일괄 갱신 없음
  const edited = reparse(done(generate(bytes, tpl([line(doc, "p", [iga + 1])], [insertText("i", "p", "바뀐 본문")]), ds({}), KEEP)).output);
  assert.equal(planRelocation({ anchors }, checkAnchors(edited, { anchors })), undefined);

  // 재지정: 새 원본의 제목 문단을 클릭한 line 초안 → headingRange
  const drafts = draftAnchors(shifted, { sectionIndex: 0, path: [iga + 1] });
  const lineDraft = drafts.find((d) => d.kind === "line");
  assert.ok(lineDraft !== undefined);
  const re = redraftAnchor(shifted, at(anchors, 0), lineDraft);
  assert.deepEqual(re, { anchor: { id: "aga", ...makeHeadingRangeAnchor(shifted, 0, [], iga + 1), pattern: "pt1" }, kindChanged: false });
  // 칸 안 제목 문단 클릭
  const cellDraft = draftAnchors(shifted, { sectionIndex: 0, path: [13, 1, 8] }).find((d) => d.kind === "line");
  assert.ok(cellDraft !== undefined);
  assert.deepEqual(redraftAnchor(shifted, at(anchors, 1), cellDraft).anchor, { id: "acopy", ...makeHeadingRangeAnchor(shifted, 0, [13, 1], 8) });
  // headingRange 초안도 받는다, range 초안이면 종류가 바뀐다
  const hd = makeHeadingRangeAnchor(shifted, 0, [], 28);
  assert.ok(hd !== undefined);
  assert.deepEqual(redraftAnchor(shifted, at(anchors, 2), hd), { anchor: { id: "a27", ...hd }, kindChanged: false });
  const rd = makeRangeAnchor(shifted, 0, [], 28, 30);
  assert.ok(rd !== undefined);
  assert.deepEqual(redraftAnchor(shifted, at(anchors, 2), rd), { anchor: { id: "a27", ...rd }, kindChanged: true });
  // 제목이 아닌 문단·없는 문단
  const bodyDraft = draftAnchors(shifted, { sectionIndex: 0, path: [iga + 2] }).find((d) => d.kind === "line");
  assert.ok(bodyDraft !== undefined);
  throwsCode(() => redraftAnchor(shifted, at(anchors, 0), bodyDraft), "FILL_DRAFT_ADDRESS", "본문 문단");
  throwsCode(() => redraftAnchor(shifted, at(anchors, 0), { kind: "line", at: { sectionIndex: 0, path: [999] }, print: { text: "", sha256: "0".repeat(64) } }), "FILL_DRAFT_ADDRESS", "없는 문단");
  throwsCode(() => redraftAnchor(shifted, at(anchors, 0), { ...hd, index: 29 }), "FILL_DRAFT_ADDRESS", "제목 아닌 번호");
});

test("7.10 텍스트 어댑터(md): headingRange 앵커는 ANCHOR_NOT_FOUND", () => {
  const { bytes, model } = headingDoc();
  const a = heading(reparse(bytes), "h", headingIndex(model, "7. 일반"));
  const r = generateText(("# 제목\n\n본문\n"), "md", tpl([a], [del("d", "h")]), ds({}));
  assert.equal(r.ok, false);
  assert.ok(r.report.issues.some((i) => i.code === "ANCHOR_NOT_FOUND" && i.where === "h"));
});

// ── 무작위 ─────────────────────────────────────────────────────

const HANGUL = "가나다라마바사아자차카타파하";
const CIRCLED = ["①", "⑦", "⑳", "⑴", "⒇", "㉠", "㉭", "㉮", "㉻", "❶", "❿", "➀", "➉"];
const ROMANS = ["Ⅰ", "Ⅳ", "Ⅸ", "Ⅻ"];
const BOXES = ["□", "■", "○", "●", "◇", "◆", "▶", "▷", "※", "- ", "· "];
const ARTICLE = ["장", "절", "조", "항", "호"];

/** 시드 고정 무작위 줄: 제목(꼴·아래 단계 무작위), 본문, 문장 끝 굵은 글, 번호 뒤 빈 글 */
function randomLines(next: () => number, n: number): Line[] {
  const pick = <T>(xs: readonly T[]): T => at(xs, Math.floor(next() * xs.length));
  const num = (): number => 1 + Math.floor(next() * 30);
  const out: Line[] = [];
  for (let k = 0; k < n; k++) {
    const roll = next();
    if (roll < 0.5) {
      const form = pick(SPEC_ORDER);
      const tail = ` 제목 ${k} {{기관명}} & <${k}>`;
      if (form === "article") {
        const sub = Math.floor(next() * 5);
        out.push(H("article", sub, `제${num()}${at(ARTICLE, sub)}${next() < 0.3 ? `의${num()}` : ""}${tail}`));
      } else if (form === "digitDot") {
        const sub = Math.floor(next() * 3);
        const nums = Array.from({ length: sub + 1 }, num).join(".");
        out.push(H("digitDot", sub, `${nums}${sub === 0 || next() < 0.7 ? "." : ""}${tail}`));
      } else if (form === "hangulDot") out.push(H("hangulDot", 0, `${pick([...HANGUL])}.${tail}`));
      else if (form === "roman") out.push(H("roman", 0, `${pick(ROMANS)}${next() < 0.7 ? "." : ""}${tail}`));
      else if (form === "digitParen") out.push(H("digitParen", 0, `${num()})${tail}`));
      else if (form === "hangulParen") out.push(H("hangulParen", 0, `${pick([...HANGUL])})${tail}`));
      else if (form === "digitParens") out.push(H("digitParens", 0, `(${num()})${tail}`));
      else if (form === "hangulParens") out.push(H("hangulParens", 0, `(${pick([...HANGUL])})${tail}`));
      else if (form === "circled") out.push(H("circled", 0, `${pick(CIRCLED)}${tail}`));
      else if (form === "box") out.push(H("box", 0, `${pick(BOXES)}${tail}`));
      else out.push(H("none", 0, `굵은 제목 ${k}`, true));
    } else if (roll < 0.85) out.push(P(`본문 ${k}: {{사업명}} 안내 ${"세부 사항 & <참고>. ".repeat(1 + Math.floor(next() * 4))}`));
    else if (roll < 0.95) out.push(P(`굵은 문장 ${k}입니다.`, true));
    else out.push(P(pick(["1.", "□", "가.", "(가)", "가)", "1)", "제5조", "Ⅲ.", "3 개월 이내", "20  .   .   .", "10. 4.(금) 18:00 제출"])));
  }
  return out;
}

test("7.10 무작위 60회(시드 고정): 제목 수·꼴·단계·표 위치를 섞은 문서에서 탐지·범위·opts.order가 모형과 같고, 교체가 range와 바이트 동일·결정적", () => {
  const base = notice();
  const d0 = reparse(base);
  const rich = fragOf(reparse(readFixture("tables/tables-rich")), 1, 1);
  const blocksDoc = reparse(readFixture("hancom/blocks"));
  const replacements = [fragOf(blocksDoc, 2, 4), rich];
  let replaced = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const next = rng(1900 + seed);
    const lines = randomLines(next, 12 + Math.floor(next() * 30));
    const step1 = done(generate(base, tpl([line(d0, "end", [62])], insertLines("b", "end", lines)), ds({}), KEEP));
    const d1 = reparse(step1.output);
    const tableAfter = [...new Set(Array.from({ length: Math.floor(next() * 4) }, () => Math.floor(next() * lines.length)))].sort((a, b) => a - b);
    const bytes =
      tableAfter.length === 0
        ? step1.output
        : done(generate(step1.output, tpl(tableAfter.map((j) => line(d1, `t${j}`, [63 + j])), tableAfter.map((j) => inject(`i${j}`, `t${j}`, rich, "after"))), ds({}), KEEP)).output;
    const items: Item[] = [...Array.from({ length: 63 }, (_, i): Item => (i >= 17 && i <= 42 && (i - 17) % 5 === 0 ? { text: `${(i - 17) / 5 + 1}. 제${(i - 17) / 5 + 1}장 사업 안내`, bold: false, mark: { form: "digitDot", sub: 0 } } : { bold: false }))];
    lines.forEach((l, j) => {
      items.push(l);
      if (tableAfter.includes(j)) items.push({ bold: false });
    });
    const model: Model = { top: items, lists: new Map() };
    const doc = reparse(bytes);
    assert.equal(top(doc).length, items.length, `시드 ${seed}: 문단 수`);
    // 탐지와 단계
    const got = detectHeadings(doc);
    const want = expectedHeadings(model);
    assert.deepEqual(got.map((h) => [h.at.parentPath, h.index, h.marker.form, h.marker.level, h.text]), want.map((w) => [w.parentPath, w.index, w.form, w.level, w.text]), `시드 ${seed}: 탐지`);
    assert.deepEqual(detectHeadings(reparse(bytes)), got, `시드 ${seed}: 결정성`);
    const order = [...SPEC_ORDER].sort(() => next() - 0.5).slice(0, 1 + Math.floor(next() * 7));
    assert.deepEqual(detectHeadings(doc, { order }).map((h) => [h.index, h.marker.level]), expectedHeadings(model, order).map((w) => [w.index, w.level]), `시드 ${seed}: 서열 ${order.join(">")}`);
    // 범위
    const levels = levelsOf(items);
    for (const i of levels.keys()) assert.deepEqual(headingRangeOf(doc, { sectionIndex: 0, parentPath: [] }, i), rangeOfModel(items, i), `시드 ${seed}: 제목 ${i}`);
    // 덧붙인 제목 하나를 골라 교체: range와 바이트 동일, 게이트 통과, 같은 입력은 같은 바이트
    const added = [...levels.keys()].filter((i) => i >= 63);
    if (added.length === 0) continue;
    const index = at(added, Math.floor(next() * added.length));
    const a = heading(doc, "h", index);
    assert.deepEqual(a.print, makeRangeAnchor(doc, 0, [], rangeOfModel(items, index).from, rangeOfModel(items, index).to)?.print);
    const kind = Math.floor(next() * 4);
    const rule = kind === 0 ? inject("x", "h", at(replacements, Math.floor(next() * 2))) : kind === 1 ? del("x", "h") : kind === 2 ? insertText("x", "h", "교체 & <글>\n둘째") : inject("x", "h", rich, next() < 0.5 ? "before" : "after");
    const { h } = sameAsRange(bytes, doc, model, [a], [rule], undefined, `시드 ${seed}`);
    gateClean(bytes, done(h));
    assert.ok(bytesEqual(done(generate(bytes, tpl([a], [rule]), ds({}), KEEP)).output, done(h).output), `시드 ${seed}: 결정성`);
    replaced++;
  }
  assert.ok(replaced >= 50, `교체 ${replaced}회`);
});

test("7.10 시험 전제: 합성 공고서의 굵은 글자모양(charPr 7)으로 넣은 문단은 굵은 제목으로, 상속 글자모양(charPr 0) 문단은 굵지 않게 탐지된다", () => {
  const base = notice();
  const d0 = reparse(base);
  const out = done(generate(base, tpl([line(d0, "end", [62])], insertLines("b", "end", [H("none", 0, "굵은 제목", true), P("보통 제목")])), ds({}), KEEP)).output;
  const hs = detectHeadings(reparse(out)).filter((h) => h.index > 62);
  assert.deepEqual(hs.map((h) => [h.index, h.marker.form, h.bold]), [[63, "none", true]]);
});

// ── 흔한 위계와 서열 저장 ──────────────────────────────────────

test("7.10 흔한 위계 1. > 가. > 1) > 가) > (1) > (가) > ① > □ > ○ > -가 한 문서에서 모두 다른 단계이고, 1)의 범위는 가)에서 끊기지 않는다", () => {
  const base = notice();
  const d0 = reparse(base);
  const lines: Line[] = [
    H("digitDot", 0, "10. 위계 시험 장"),
    H("hangulDot", 0, "가. 첫 항목 {{기관명}}"),
    H("digitParen", 0, "1) 세부 하나"),
    H("hangulParen", 0, "가) 세세부 하나"),
    H("digitParens", 0, "(1) 괄호 숫자"),
    H("hangulParens", 0, "(가) 괄호 한글"),
    H("circled", 0, "① 동그라미"),
    H("box", 0, "□ 네모 기호"),
    H("box", 0, "○ 동그라미 기호"),
    H("box", 0, "- 줄표 기호"),
    P("가장 아래 본문 {{사업명}} & <참고>"),
    H("box", 0, "○ 동그라미 기호 둘"),
    H("digitParen", 0, "2) 세부 둘"),
    H("hangulParen", 0, "가) 세부 둘의 세세부"),
    P("세부 둘 본문"),
    H("hangulDot", 0, "나. 둘째 항목"),
    P("둘째 항목 본문"),
    H("digitDot", 0, "11. 다음 장"),
  ];
  const bytes = done(generate(base, tpl([line(d0, "end", [62])], insertLines("b", "end", lines)), ds({}), KEEP)).output;
  const doc = reparse(bytes);
  const model: Model = { top: [...Array.from({ length: 63 }, (_, i): Item => (HEADINGS.includes(i) ? { text: `${HEADINGS.indexOf(i) + 1}. 제${HEADINGS.indexOf(i) + 1}장 사업 안내`, bold: false, mark: { form: "digitDot", sub: 0 } } : { bold: false })), ...lines], lists: new Map() };
  const got = detectHeadings(doc);
  assert.deepEqual(got.map((h) => [h.index, h.marker.form, h.marker.level]), expectedHeadings(model).map((w) => [w.index, w.form, w.level]));
  const lv = (i: number) => got.find((h) => h.index === 63 + i)?.marker.level;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(lv), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "열 단계가 모두 다르다");
  assert.equal(lv(11), 9, "두 번째 ○는 처음 나온 ○와 같은 단계");
  const r = (i: number) => headingRangeOf(doc, { sectionIndex: 0, parentPath: [] }, 63 + i);
  assert.deepEqual(r(2), { from: 65, to: 63 + 11 }, "1)의 범위는 가)·(1)·①·기호를 지나 다음 2) 앞까지");
  assert.deepEqual(r(12), { from: 75, to: 63 + 14 }, "2)의 범위는 상위 제목 나. 앞까지");
  assert.deepEqual(r(3), { from: 66, to: 63 + 11 }, "가)는 다음 2)(상위) 앞까지");
  assert.deepEqual(r(7), { from: 70, to: 63 + 11 }, "□는 아래 단계 ○·-를 품는다");
  assert.deepEqual(r(8), { from: 71, to: 63 + 10 }, "○는 다음 ○ 앞까지");
  for (const [i] of lines.entries()) if (lines[i]?.mark !== undefined) assert.deepEqual(r(i), rangeOfModel(model.top, 63 + i), `줄 ${i}`);
  // 1)의 범위 교체는 같은 범위의 range와 바이트 동일
  const a = heading(doc, "h", 65);
  const { h } = sameAsRange(bytes, doc, model, [a], [inject("x", "h", fragOf(reparse(readFixture("hancom/blocks")), 2, 4))], undefined, "1) 교체");
  gateClean(bytes, done(h));
});

test("7.10 opts.order 저장: 기본과 다른 서열로 만든 앵커는 order(전체 서열)를 담고 해석·checkAnchors·재지정이 그 서열로 범위를 계산한다. 1판·2판 읽기 왕복, 모르는 꼴은 TPL_ANCHOR", () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const order: HeadingForm[] = ["box"];
  const full = [...SPEC_ORDER].filter((f) => f !== "box");
  const ib = headingIndex(model, "□ 네모");
  // 기본 서열: □(14단계)는 '7.1.1.' 앞까지. 기호가 먼저인 서열: □가 1단계라 부모 끝까지
  const byDefault = rangeOfModel(model.top, ib);
  const byBox = rangeOfModel(model.top, ib, order);
  assert.notDeepEqual(byDefault, byBox);
  assert.deepEqual(headingRangeOf(doc, { sectionIndex: 0, parentPath: [] }, ib), byDefault);
  assert.deepEqual(headingRangeOf(doc, { sectionIndex: 0, parentPath: [] }, ib, { order }), byBox);
  const draft = makeHeadingRangeAnchor(doc, 0, [], ib, { order });
  assert.ok(draft !== undefined);
  assert.deepEqual(draft.order, ["box", ...full]);
  assert.deepEqual(draft.marker, { form: "box", level: 1 });
  assert.deepEqual(draft.print, makeRangeAnchor(doc, 0, [], byBox.from, byBox.to)?.print);
  // 기본 서열과 같은 결과가 되는 서열은 order를 두지 않는다
  assert.equal("order" in (makeHeadingRangeAnchor(doc, 0, [], ib, { order: ["article"] }) ?? {}), false);
  assert.equal("order" in (makeHeadingRangeAnchor(doc, 0, [], ib, { order: SPEC_ORDER }) ?? {}), false);
  assert.equal("order" in (makeHeadingRangeAnchor(doc, 0, [], ib) ?? {}), false);

  const a: HeadingRangeAnchor = { id: "hb", ...draft };
  const r = resolveAnchors(doc, tpl([a], [])).anchors.get("hb");
  assert.ok(r?.kind === "range");
  assert.deepEqual([r.from, r.to], [byBox.from, byBox.to]);
  // order를 떼면 기본 서열로 범위를 다시 계산해 지문이 다르다 → changed
  const { order: _order, ...noOrder } = a;
  assert.deepEqual(checkAnchors(doc, { anchors: [noOrder] }).map((c) => c.state), ["changed"]);
  // 앞에 문단 삽입: relocated, found의 marker도 그 서열로 센다
  const shifted = reparse(done(generate(bytes, tpl([line(doc, "p1", [1])], [insertText("i", "p1", "끼운 문단", "after")]), ds({}), KEEP)).output);
  const c = checkAnchors(shifted, { anchors: [a] });
  assert.deepEqual(c.map((x) => [x.state, x.found]), [["relocated", { kind: "headingRange", at: { sectionIndex: 0, parentPath: [] }, index: ib + 1, marker: { form: "box", level: 1 }, from: byBox.from + 1, to: byBox.to + 1 }]]);
  assert.deepEqual(planRelocation({ anchors: [a] }, c)?.anchors, [{ ...a, index: ib + 1 }]);
  // 재지정: 옛 앵커의 서열로 다시 뜬다
  const lineDraft = draftAnchors(shifted, { sectionIndex: 0, path: [ib + 1] }).find((d) => d.kind === "line");
  assert.ok(lineDraft !== undefined);
  assert.deepEqual(redraftAnchor(shifted, a, lineDraft).anchor, { id: "hb", ...makeHeadingRangeAnchor(shifted, 0, [], ib + 1, { order }) });
  // 읽기: 1판·2판 왕복, 모르는 꼴·배열 아님은 TPL_ANCHOR
  assert.deepEqual(readTemplate(JSON.stringify(rawTpl([a]))).anchors, [a]);
  const t2 = readStudioTemplate(JSON.stringify(studioRaw(bytes, [a], [{ id: "s1", name: "기호", anchors: ["hb"], parent: null }], [{ id: "b1", slot: "s1", name: "글", content: { text: "교체" } }])));
  assert.deepEqual(t2.anchors, [a]);
  for (const bad of [["paren"], "box", [1], ["box", "roman", "x"]]) {
    throwsCode(() => readTemplate(JSON.stringify(rawTpl([{ ...a, order: bad }]))), "TPL_ANCHOR", `1판 order ${JSON.stringify(bad)}`);
    throwsCode(() => readStudioTemplate(JSON.stringify(studioRaw(bytes, [{ ...a, order: bad }], [], []))), "TPL_ANCHOR", `2판 order ${JSON.stringify(bad)}`);
  }
  // 저장한 서열로 만든 결과가 같은 범위의 range와 바이트 동일
  const blocks = reparse(readFixture("hancom/blocks"));
  const rd = makeRangeAnchor(doc, 0, [], byBox.from, byBox.to);
  assert.ok(rd !== undefined);
  const rule = [inject("x", "hb", fragOf(blocks, 2, 4))];
  const outH = done(generate(bytes, tpl([a], rule), ds({}), KEEP));
  const outR = done(generate(bytes, tpl([{ id: "hb", ...rd }], rule), ds({}), KEEP));
  assert.ok(bytesEqual(outH.output, outR.output));
  gateClean(bytes, outH);
});
