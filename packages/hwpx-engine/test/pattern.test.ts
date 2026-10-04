// 패턴과 같은 유형 일괄 제안(7.10 패턴, #20): patternOf·suggestSimilar·rejectSuggestion.
// 합성 공고서(자리 수십 개) 뒤에 꼴·단계·글자모양·문단모양을 시험이 정한 줄과 표 칸 제목·라벨 셀·`라벨:` 글을 넣은 문서에서,
// 기대값은 시험이 적어 넣은 모형(줄마다 꼴과 글자모양·문단모양 id)에 명세 규칙(같은 place, marker는 늘, match에 켠 항목만 같은 값)을 적용해 세운다.
// 엔진의 제안 결과를 기대값으로 옮겨 적지 않는다. 초안은 명세가 정한 함수(makeHeadingRangeAnchor·makeCellAnchor·makeWordAnchor·line 지문)의 결과와 대조한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attrValue, childEl, fingerprintResource, isTableNode, makeLookup, type HwpxDocument, type ParagraphNode, type TableCell } from "../src/index.ts";
import {
  checkAnchors,
  detectHeadings,
  findCandidates,
  generate,
  makeCellAnchor,
  makeHeadingRangeAnchor,
  makeRangeAnchor,
  makeWordAnchor,
  patternOf,
  redraftAnchor,
  rejectSuggestion,
  suggestSimilar,
  type HeadingForm,
  type Pattern,
  type PatternMatchKey,
  type Suggestion,
  type SuggestionDraft,
} from "../src/fill/index.ts";
import { paragraphAtPath } from "../src/fill/doc.ts";
import { readStudioTemplate, writeStudioTemplate, type StudioAnchor, type StudioTemplate } from "../src/template/index.ts";
import { readFixture, reparse, sha256Hex, utf8 } from "./helpers.ts";
import { H, P, SPEC_ORDER, levelsOf, rangeOfModel, type Item, type Line } from "./heading-helpers.ts";
import { HEADINGS, KEEP, at, done, ds, fragOf, gateClean, inject, insertText, line, notice, rng, top, tpl } from "./range-helpers.ts";

// ── 글자모양·문단모양(합성 공고서 header의 값. 시험 전제 시험이 header XML에서 확인한다) ──

/** 줄의 모양: 글자모양 id와 문단모양 id */
const LOOKS = {
  /** 보통(1000, 굵지 않음), 양쪽 정렬 */
  N: { charPr: "0", paraPr: "0" },
  /** 굵게(1000) */
  B: { charPr: "7", paraPr: "0" },
  /** 크기 1100(굵지 않음) */
  Z: { charPr: "6", paraPr: "0" },
  /** 크기·굵기는 보통과 같고 글꼴이 다름 */
  F: { charPr: "1", paraPr: "0" },
  /** 크기·굵기는 보통과 같고 빨간 글자 */
  R: { charPr: "8", paraPr: "0" },
  /** 왼쪽 정렬 문단모양 */
  L: { charPr: "0", paraPr: "11" },
  /** 양쪽 정렬이지만 다른 문단모양 */
  J: { charPr: "0", paraPr: "1" },
} as const;
type LookName = keyof typeof LOOKS;
const LOOK_NAMES = Object.keys(LOOKS) as LookName[];
const CHAR: Record<string, { bold: boolean; height: number }> = { "0": { bold: false, height: 1000 }, "1": { bold: false, height: 1000 }, "6": { bold: false, height: 1100 }, "7": { bold: true, height: 1000 }, "8": { bold: false, height: 1000 } };
const ALIGN: Record<string, string> = { "0": "JUSTIFY", "1": "JUSTIFY", "11": "LEFT" };
const styleOf = (look: LookName) => ({ paraPrIDRef: LOOKS[look].paraPr, charPrIDRef: LOOKS[look].charPr, styleIDRef: "0" });

/** 모형의 줄: 글, 굵기, 제목이면 꼴, 모양 */
type PLine = Line & { look: LookName };
const S = (look: LookName, l: Line): PLine => ({ ...l, look, bold: CHAR[LOOKS[look].charPr]?.bold ?? false });

/** 모양이 같은 연속 줄마다 insertText 규칙 하나(같은 앵커 뒤 삽입은 규칙 순서대로 놓인다) */
function insertGroups(prefix: string, anchor: string, lines: readonly PLine[]): unknown[] {
  const groups: PLine[][] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0]?.look === l.look) last.push(l);
    else groups.push([l]);
  }
  return groups.map((g, k) => ({ id: `${prefix}${k}`, do: { type: "insertText", anchor, position: "after", value: { text: g.map((l) => l.text).join("\n") }, style: styleOf(at(g, 0).look) } }));
}

// ── 시험 문서 ─────────────────────────────────────────────────

/** 합성 공고서 최상위 끝(문단 62 뒤)에 붙이는 줄. 최상위 단계: 숫자+점 1, 한글+점 2, `1)` 3, 굵은 제목 4 */
const BLOCK: PLine[] = [
  S("N", H("digitDot", 0, "7. 추가 장 일곱: {{기관명}} & <안내>")),
  S("N", P("일곱 장 본문: {{사업명}} 세부 사항 & <참고>.")),
  S("N", H("hangulDot", 0, "가. 소항목 하나")),
  S("N", P(`가 항목 본문입니다. ${"제출 서류는 원본 1부 & 사본 2부입니다. ".repeat(6)}`)),
  S("B", H("digitDot", 0, "8. 굵은 장 여덟")),
  S("Z", H("digitDot", 0, "9. 큰 글자 장 아홉")),
  S("F", H("digitDot", 0, "10. 다른 글꼴 장 열")),
  S("R", H("digitDot", 0, "11. 빨간 글자 장 열하나")),
  S("L", H("digitDot", 0, "12. 왼쪽 정렬 장 열둘")),
  S("J", H("digitDot", 0, "13. 다른 문단모양 장 열셋")),
  S("N", H("digitDot", 0, "14. 추가 장 열넷 {{담당자}}")),
  S("N", P("열넷 장 본문 {{연락처}}.")),
  S("N", H("hangulDot", 0, "나. 소항목 둘")),
  S("N", H("digitParen", 0, "1) 다른 꼴 항목")),
  S("N", H("digitDot", 0, "7. 추가 장 일곱: {{기관명}} & <안내>")),
  S("N", H("digitDot", 0, "15. 추가 장 열다섯")),
  S("N", P("성명:")),
  S("N", P("소속:   ")),
  S("N", P("연락처 :")),
  S("N", P("전자우편： ")),
  S("N", P("참고: 다음과 같습니다.")),
  S("N", P("아주 긴 라벨 이름이 열두 글자를 넘는 경우:")),
  S("B", H("none", 0, "굵은 짧은 제목")),
  S("B", P("굵은 문장으로 끝납니다.")),
  S("N", H("digitDot", 0, "16. 추가 장 열여섯")),
  S("B", H("hangulDot", 0, "다. 굵은 소항목")),
  S("N", H("digitDot", 0, "17. 마지막 장 열일곱")),
  S("N", P("마지막 본문입니다.")),
];
const B0 = 63;
/** 덧붙인 줄 `j`의 최상위 문단 번호 */
const bi = (j: number): number => B0 + j;
/** 덧붙인 줄 뒤에 넣는 표: `hancom/ph-table`(라벨 셀 3개) 3벌, `tables/tables-nested` 1벌 */
const PH = [B0 + BLOCK.length, B0 + BLOCK.length + 1, B0 + BLOCK.length + 2];
const NESTED = B0 + BLOCK.length + 3;
const TOP_LENGTH = NESTED + 1;

/** 칸 [12, 1](원래 6문단 뒤): 숫자+점 1단계 둘, 한글+점, `라벨:` 글. 상속 모양(보통) */
const CELL_A = ["1. 칸 제목 하나", "칸 본문 {{담당자}} & <참고>.", "가. 칸 소제목", "2. 칸 제목 둘", "주소:  "];
/** 칸 [15, 5](원래 1문단 뒤): 숫자+점 1단계 둘 */
const CELL_B = ["1. 연락 칸 제목", "2. 연락 칸 둘째"];
/** 칸 [58, 1](복사본 표, 원래 1문단 뒤): 숫자+점 1단계 */
const CELL_C = ["1. 복사 칸 제목"];
/** 칸 [61, 7](원래 1문단 뒤): 굵은 숫자+점 1단계 */
const CELL_BOLD = "1. 굵은 칸 제목";
/** 칸 [61, 5](원래 1문단 뒤): 로마 숫자 아래의 숫자+점(2단계) */
const CELL_ROMAN = ["Ⅰ. 로마 칸 제목", "1. 로마 아래 칸 제목"];
/** 중첩 표의 안쪽 칸(안1·안3 뒤): 숫자+점 1단계(보통 모양) */
const NESTED_A = ["1. 중첩 칸 제목"];
const NESTED_B = ["1. 중첩 칸 둘", "2. 중첩 칸 셋"];

/** 최상위 모형: 합성 공고서 63문단(제목은 `HEADINGS`의 `N. 제N장 사업 안내`, 보통 모양) + 덧붙인 줄 + 표 4개 */
function modelTop(lines: readonly PLine[]): (Item & { look?: LookName })[] {
  const items: (Item & { look?: LookName })[] = Array.from({ length: 63 }, (_, i) => {
    const h = HEADINGS.indexOf(i);
    return h < 0 ? { bold: false } : { text: `${h + 1}. 제${h + 1}장 사업 안내`, bold: false, mark: { form: "digitDot" as HeadingForm, sub: 0 }, look: "N" as LookName };
  });
  return [...items, ...lines];
}

/** 시험 문서의 최상위 모형: `modelTop(BLOCK)` 뒤에 표 4개(ph-table 3벌·중첩 표, 제목 아님) */
const docModel = (): (Item & { look?: LookName })[] => [...modelTop(BLOCK), ...Array.from({ length: TOP_LENGTH - B0 - BLOCK.length }, (): Item => ({ bold: false }))];

let docCache: Uint8Array | undefined;
/**
 * 시험 문서: 합성 공고서 + `BLOCK`(모양별 insertText) + 칸 제목(칸 [12,1]·[15,5]·[58,1]·[61,7]·[61,5]) → 끝에 ph-table 3벌·중첩 표 →
 * 중첩 표 안쪽 칸에 제목을 넣고 ph-table의 `{{applicant.name}}`·`{{note}}`를 빈 글로 채운다(라벨 셀 성명·연락처·비고가 된다).
 */
function patternDoc(): Uint8Array {
  if (docCache !== undefined) return docCache;
  const base = notice();
  const d0 = reparse(base);
  const step1 = done(
    generate(
      base,
      tpl(
        [line(d0, "end", [62]), line(d0, "ca", [12, 1, 5]), line(d0, "cb", [15, 5, 0]), line(d0, "cc", [58, 1, 0]), line(d0, "cd", [61, 7, 0]), line(d0, "ce", [61, 5, 0])],
        [
          ...insertGroups("b", "end", BLOCK),
          insertText("ia", "ca", CELL_A.join("\n"), "after"),
          insertText("ib", "cb", CELL_B.join("\n"), "after"),
          insertText("ic", "cc", CELL_C.join("\n"), "after"),
          { id: "id", do: { type: "insertText", anchor: "cd", position: "after", value: { text: CELL_BOLD }, style: styleOf("B") } },
          insertText("ie", "ce", CELL_ROMAN.join("\n"), "after"),
        ],
      ),
      ds({}),
      KEEP,
    ),
  );
  const d1 = reparse(step1.output);
  const ph = fragOf(reparse(readFixture("hancom/ph-table")), 1, 1);
  const nested = fragOf(reparse(readFixture("tables/tables-nested")), 1, 1);
  const step2 = done(generate(step1.output, tpl([line(d1, "t", [B0 + BLOCK.length - 1])], [inject("p1", "t", ph, "after"), inject("p2", "t", ph, "after"), inject("p3", "t", ph, "after"), inject("n1", "t", nested, "after")]), ds({}), KEEP));
  const d2 = reparse(step2.output);
  const N = styleOf("N");
  const step3 = done(
    generate(
      step2.output,
      tpl(
        [line(d2, "na", [NESTED, 1, 0, 0, 0]), line(d2, "nb", [NESTED, 1, 0, 2, 0])],
        [
          { id: "na", do: { type: "insertText", anchor: "na", position: "after", value: { text: NESTED_A.join("\n") }, style: N } },
          { id: "nb", do: { type: "insertText", anchor: "nb", position: "after", value: { text: NESTED_B.join("\n") }, style: N } },
        ],
      ),
      ds({ applicant: { name: "" }, note: "" }),
      KEEP,
    ),
  );
  docCache = step3.output;
  return docCache;
}

// ── 도우미 ────────────────────────────────────────────────────

/** 제목 아닌 문단(과 라벨 자리의 번호 없는 문단)의 꼴·단계 */
const NOT_HEADING = { form: "none" as HeadingForm, level: 0 };
/** 명세의 기본 match: 꼴·단계·굵기·크기(글자모양 지문·문단모양 지문·정렬은 끔) */
const DEFAULT_MATCH: PatternMatchKey[] = ["marker", "bold", "height"];
const S0 = (path: number[]) => ({ sectionIndex: 0, path });

function paragraph(doc: HwpxDocument, path: number[]): ParagraphNode {
  const p = paragraphAtPath(at(doc.sections, 0), path);
  assert.ok(p !== undefined, `문단 ${path.join(",")}이 없다`);
  return p;
}

/** 최상위 문단 `owner`의 하위 목록 `k`인 표 칸 */
function cellOf(doc: HwpxDocument, owner: number[], k: number): TableCell {
  const p = paragraph(doc, owner);
  const sub = at(p.subLists, k);
  for (const o of p.objects) {
    if (!isTableNode(o)) continue;
    const cell = o.cells.find((c) => c.subList === sub);
    if (cell !== undefined) return cell;
  }
  assert.fail(`문단 ${owner.join(",")}의 하위 목록 ${k}는 표 칸이 아니다`);
}

function cellDraft(doc: HwpxDocument, ordinal: number, owner: number, k: number): SuggestionDraft {
  const c = cellOf(doc, [owner], k);
  const d = makeCellAnchor(doc, 0, ordinal, c.row, c.col);
  assert.ok(d !== undefined);
  return d;
}

function headingDraft(doc: HwpxDocument, index: number, order?: readonly HeadingForm[], parentPath: number[] = []): SuggestionDraft {
  const d = makeHeadingRangeAnchor(doc, 0, parentPath, index, order === undefined ? undefined : { order });
  assert.ok(d !== undefined, `제목 ${index}의 초안`);
  return d;
}

const lineDraft = (doc: HwpxDocument, path: number[]): SuggestionDraft => {
  const text = paragraph(doc, path).logicalText;
  return { kind: "line", at: S0(path), print: { text: text.slice(0, 40), sha256: sha256Hex(utf8(text)) } };
};

function wordDraft(doc: HwpxDocument, path: number[], start: number, end: number): SuggestionDraft {
  const w = makeWordAnchor(doc, "x", 0, path, start, end);
  assert.ok(w !== undefined);
  const { id: _id, ...draft } = w;
  return draft;
}

/** 기대 제안: 문서의 그 문단 글(앞 40자·해시)과 초안 */
function sug(doc: HwpxDocument, path: number[], draft: SuggestionDraft): Suggestion {
  const text = paragraph(doc, path).logicalText;
  return { at: S0(path), text: text.slice(0, 40), sha256: sha256Hex(utf8(text)), draft };
}

const paths = (s: readonly Suggestion[]): string[] => s.map((x) => x.at.path.join(","));
const withMatch = (p: Pattern, match: PatternMatchKey[]): Pattern => ({ ...p, match });

function pattern(doc: HwpxDocument, path: number[], order?: readonly HeadingForm[]): Pattern {
  const p = patternOf(doc, S0(path), order === undefined ? undefined : { order });
  assert.ok(p !== undefined, `문단 ${path.join(",")}의 패턴`);
  return p;
}

/**
 * 최상위 모형에서 본문 제목 패턴(원점 `origin`)의 기대 제안 번호: 원점 아님, 꼴·단계 같음(제목이 아닌 문단은 `none`·1), `match`에 켠 항목은 모양 표의 값이 같음,
 * `excluded` 번호 아님, `rejectedTexts`의 글이 아님. 문서 순서.
 */
function expectBody(items: readonly (Item & { look?: LookName })[], origin: number, match: readonly PatternMatchKey[], opts: { order?: readonly HeadingForm[] | undefined; excluded?: ReadonlySet<number>; rejectedTexts?: ReadonlySet<string> } = {}): number[] {
  const levels = levelsOf(items, opts.order);
  const markerOf = (i: number) => {
    const x = at(items, i);
    return x.mark === undefined ? NOT_HEADING : { form: x.mark.form, level: levels.get(i) };
  };
  const o = at(items, origin);
  assert.ok(o.look !== undefined && o.mark !== undefined);
  const want = markerOf(origin);
  const oc = LOOKS[o.look];
  const on = new Set(match);
  const out: number[] = [];
  items.forEach((x, i) => {
    if (i === origin || x.look === undefined) return;
    const m = markerOf(i);
    if (m.form !== want.form || m.level !== want.level) return;
    const xc = LOOKS[x.look];
    if (on.has("bold") && CHAR[xc.charPr]?.bold !== CHAR[oc.charPr]?.bold) return;
    if (on.has("height") && CHAR[xc.charPr]?.height !== CHAR[oc.charPr]?.height) return;
    if (on.has("print") && xc.charPr !== oc.charPr) return;
    if (on.has("paraPrint") && xc.paraPr !== oc.paraPr) return;
    if (on.has("align") && ALIGN[xc.paraPr] !== ALIGN[oc.paraPr]) return;
    if (opts.excluded?.has(i) === true || opts.rejectedTexts?.has(x.text ?? "") === true) return;
    out.push(i);
  });
  return out;
}

// ── 시험 전제 ─────────────────────────────────────────────────

test("7.10 패턴 시험 전제: 모양 표(굵기·크기·정렬)가 header XML과 같고 글자모양·문단모양 지문이 서로 다르며, 시험 문서의 줄·칸·표가 모형 자리에 있다(자리 수십 개)", () => {
  const doc = reparse(patternDoc());
  const res = (kind: string, id: string) => {
    const item = (doc.header.resources[kind] ?? []).find((x) => x.id === id);
    assert.ok(item !== undefined, `${kind} ${id}`);
    return item;
  };
  for (const [id, want] of Object.entries(CHAR)) {
    const el = res("charPr", id).element;
    assert.deepEqual({ bold: childEl(el, "head", "bold") !== undefined, height: Number(attrValue(el, "height")) }, want, `charPr ${id}`);
  }
  for (const [id, want] of Object.entries(ALIGN)) {
    const align = childEl(res("paraPr", id).element, "head", "align");
    assert.equal(align === undefined ? undefined : attrValue(align, "horizontal"), want, `paraPr ${id}`);
  }
  const lookup = makeLookup(doc);
  const charPrints = new Set(Object.keys(CHAR).map((id) => fingerprintResource(res("charPr", id), lookup)));
  const paraPrints = new Set(Object.keys(ALIGN).map((id) => fingerprintResource(res("paraPr", id), lookup)));
  assert.equal(charPrints.size, Object.keys(CHAR).length);
  assert.equal(paraPrints.size, Object.keys(ALIGN).length);

  const list = top(doc);
  assert.equal(list.length, TOP_LENGTH);
  BLOCK.forEach((l, j) => {
    const p = at(list, bi(j));
    assert.equal(p.logicalText, l.text, `줄 ${j}`);
    const run = p.runs[0];
    assert.equal(run?.charPrIDRef, LOOKS[l.look].charPr, `줄 ${j} 글자모양`);
    assert.equal(p.attrs.paraPrIDRef, LOOKS[l.look].paraPr, `줄 ${j} 문단모양`);
  });
  for (const h of HEADINGS) assert.deepEqual([at(list, h).runs[0]?.charPrIDRef, at(list, h).attrs.paraPrIDRef], ["0", "0"], `공고서 제목 ${h}`);
  const texts = (owner: number, k: number) => (cellOf(doc, [owner], k).subList?.paragraphs ?? []).map((p) => p.logicalText);
  assert.deepEqual(texts(12, 1).slice(6), CELL_A);
  assert.deepEqual(texts(15, 5).slice(1), CELL_B);
  assert.deepEqual(texts(58, 1).slice(1), CELL_C);
  assert.deepEqual(texts(61, 7).slice(1), [CELL_BOLD]);
  assert.deepEqual(texts(61, 5).slice(1), CELL_ROMAN);
  for (const o of PH) assert.deepEqual([0, 1, 2, 3, 4, 5].map((k) => texts(o, k).join("\n")), ["성명", "", "연락처", "", "비고", ""]);
  const inner = (k: number) => (paragraph(doc, [NESTED, 1, 0]).subLists[k]?.paragraphs ?? []).map((p) => p.logicalText);
  assert.deepEqual(inner(0), ["안1", ...NESTED_A]);
  assert.deepEqual(inner(2), ["안3", ...NESTED_B]);
  // 자리 수십 개: 합성 공고서의 `{{ }}`·누름틀이 그대로 있다
  const holders = [...JSON.stringify(list.map((p) => p.logicalText)).matchAll(/\{\{[^}]+\}\}/g)].length;
  assert.ok(holders >= 30, `{{ }} 자리 ${holders}개`);
});

// ── patternOf ─────────────────────────────────────────────────

test("7.10 patternOf: 꼴·단계(제목 아닌 문단은 none·0), 첫 글 run의 굵기·크기·글자모양 지문, 문단모양 지문·정렬, place(body·cell·labelCell·labelColon), 기본 match, id·name 빈 글. 문단이 없으면 undefined", () => {
  const doc = reparse(patternDoc());
  const lookup = makeLookup(doc);
  const fp = (kind: string, id: string) => {
    const item = (doc.header.resources[kind] ?? []).find((x) => x.id === id);
    assert.ok(item !== undefined);
    return fingerprintResource(item, lookup);
  };
  assert.deepEqual(pattern(doc, [17]), {
    id: "",
    name: "",
    marker: { form: "digitDot", level: 1 },
    char: { bold: false, height: 1000, print: fp("charPr", "0") },
    para: { print: fp("paraPr", "0"), align: "JUSTIFY" },
    place: "body",
    match: DEFAULT_MATCH,
  });
  const items = docModel();
  const levels = levelsOf(items);
  // 덧붙인 줄마다: 제목은 모형의 꼴·단계, 아니면 none·0. 굵기·크기는 모양 표, 지문은 그 글자모양·문단모양의 지문
  BLOCK.forEach((l, j) => {
    const p = pattern(doc, [bi(j)]);
    const want = l.mark === undefined ? NOT_HEADING : { form: l.mark.form, level: levels.get(bi(j)) };
    assert.deepEqual(p.marker, want, `줄 ${j} 꼴·단계`);
    const c = LOOKS[l.look];
    assert.deepEqual(p.char, { ...CHAR[c.charPr], print: fp("charPr", c.charPr) }, `줄 ${j} 글자`);
    assert.deepEqual(p.para, { print: fp("paraPr", c.paraPr), align: ALIGN[c.paraPr] }, `줄 ${j} 문단`);
    const colon = j >= 16 && j <= 19;
    assert.equal(p.place, colon ? "labelColon" : "body", `줄 ${j} 자리`);
  });
  assert.deepEqual(pattern(doc, [bi(22)]).marker, { form: "none", level: 4 });
  // 칸: 칸 안 단계는 그 칸의 목록에서 센다
  assert.deepEqual([pattern(doc, [12, 1, 6]).place, pattern(doc, [12, 1, 6]).marker], ["cell", { form: "digitDot", level: 1 }]);
  assert.deepEqual([pattern(doc, [61, 5, 2]).place, pattern(doc, [61, 5, 2]).marker], ["cell", { form: "digitDot", level: 2 }]);
  assert.deepEqual([pattern(doc, [12, 1, 10]).place, pattern(doc, [12, 1, 10]).marker], ["labelColon", NOT_HEADING]);
  assert.deepEqual([pattern(doc, [NESTED, 1, 0, 0, 1]).place, pattern(doc, [NESTED, 1, 0, 0, 1]).marker], ["cell", { form: "digitDot", level: 1 }]);
  // 라벨 셀: 문서 전체의 칸 문단 가운데 ph-table의 성명·연락처·비고(라벨 규칙: 짧은 글, 오른쪽 칸이 빈 칸)만 labelCell
  const labels = new Set(PH.flatMap((o) => [0, 2, 4].map((k) => `${o},${k},0`)));
  const cellPlaces: string[] = [];
  const walk = (list: readonly ParagraphNode[], inCell: boolean): void => {
    for (const p of list) {
      if (inCell) {
        const place = pattern(doc, p.path).place;
        if (place === "labelCell") cellPlaces.push(p.path.join(","));
        else assert.ok(!labels.has(p.path.join(",")), `${p.path.join(",")}는 라벨 셀이다`);
      }
      p.subLists.forEach((sub) => walk(sub.paragraphs, p.objects.some((o) => isTableNode(o) && o.cells.some((c) => c.subList === sub))));
    }
  };
  walk(top(doc), false);
  assert.deepEqual(new Set(cellPlaces), labels);
  assert.deepEqual(pattern(doc, [PH[0] ?? -1, 0, 0]).marker, NOT_HEADING);
  // opts.order: 한글+점을 앞에 두면 숫자+점은 2단계
  assert.deepEqual(pattern(doc, [17], ["hangulDot"]).marker, { form: "digitDot", level: levelsOf(items, ["hangulDot"]).get(17) });
  assert.equal(levelsOf(items, ["hangulDot"]).get(17), 2);
  // 문단이 없음
  for (const addr of [S0([999]), S0([]), S0([12, 1]), S0([12, 99, 0]), { sectionIndex: 3, path: [0] }, { sectionIndex: -1, path: [0] }]) assert.equal(patternOf(doc, addr), undefined, JSON.stringify(addr));
});

// ── suggestSimilar: 본문 제목 ──────────────────────────────────

test("7.10 suggestSimilar (a): 본문 제목 하나의 패턴(기본 match) → 같은 꼴·단계·굵기·크기의 나머지 제목만 문서 순서로(자신 제외, 10개 이상), 초안은 makeHeadingRangeAnchor와 같다. 결정적", () => {
  const bytes = patternDoc();
  const doc = reparse(bytes);
  const items = docModel();
  const p = pattern(doc, [17]);
  const got = suggestSimilar(doc, p, { origin: S0([17]) });
  const want = expectBody(items, 17, p.match);
  assert.ok(want.length >= 10, `기대 ${want.length}개`);
  assert.deepEqual(want, [22, 27, 32, 37, 42, bi(0), bi(6), bi(7), bi(8), bi(9), bi(10), bi(14), bi(15), bi(24), bi(26)]);
  assert.deepEqual(got, want.map((i) => sug(doc, [i], headingDraft(doc, i))));
  for (const [k, i] of want.entries()) {
    const r = rangeOfModel(items, i);
    const d = at(got, k).draft;
    assert.ok(d.kind === "headingRange" && d.print.count === r.to - r.from + 1, `제목 ${i} 범위`);
  }
  // 빠진 것: 다른 단계(가.·나.·1)), 굵은 것, 크기 다른 것, 칸 안 같은 꼴. 글꼴·색만 다른 것(줄 6·7)은 기본 match에서 들어온다
  for (const j of [2, 4, 5, 12, 13, 25]) assert.ok(!paths(got).includes(String(bi(j))), `줄 ${j}`);
  assert.ok(!paths(got).some((x) => x.includes(",")), "칸 안 문단");
  // 원점을 주지 않으면 자신도 나온다
  assert.deepEqual(paths(suggestSimilar(doc, p)), [17, ...want].map(String));
  // 결정성: 다시 읽은 문서에서 같은 결과
  assert.deepEqual(suggestSimilar(reparse(bytes), p, { origin: S0([17]) }), got);
  // 덧붙인 제목에서 시작해도 같은 묶음(원점만 바뀐다)
  assert.deepEqual(paths(suggestSimilar(doc, pattern(doc, [bi(15)]), { origin: S0([bi(15)]) })), [17, ...want].filter((i) => i !== bi(15)).map(String));
});

test("7.10 suggestSimilar (b): match 항목을 끄고 켜면 결과가 모형대로 바뀐다(bold·height 끔, print·paraPrint·align 켬). 굵은 제목·한글+점 단계 패턴도 같다", () => {
  const doc = reparse(patternDoc());
  const items = docModel();
  const p = pattern(doc, [17]);
  assert.deepEqual(p.match, DEFAULT_MATCH);
  // [match, 기본보다 더 들어오는 것, 기본에서 빠지는 것]
  const cases: [PatternMatchKey[], number[], number[]][] = [
    [DEFAULT_MATCH, [], []],
    [["marker", "bold", "height", "print"], [], [bi(6), bi(7)]],
    [["marker", "height"], [bi(4)], []],
    [["marker", "bold"], [bi(5)], []],
    [["marker"], [bi(4), bi(5)], []],
    [["marker", "bold", "height", "paraPrint"], [], [bi(8), bi(9)]],
    [["marker", "bold", "height", "align"], [], [bi(8)]],
    [["marker", "bold", "height", "print", "paraPrint", "align"], [], [bi(6), bi(7), bi(8), bi(9)]],
    [["marker", "align"], [bi(4), bi(5)], [bi(8)]],
  ];
  const base = expectBody(items, 17, DEFAULT_MATCH);
  for (const [match, more, less] of cases) {
    const want = expectBody(items, 17, match);
    assert.deepEqual(paths(suggestSimilar(doc, withMatch(p, match), { origin: S0([17]) })), want.map(String), match.join("+"));
    // 기본과의 차이는 모양이 다른 제목들뿐(모형이 시험 의도대로인지)
    assert.deepEqual([want.filter((i) => !base.includes(i)), base.filter((i) => !want.includes(i))], [more, less], `${match.join("+")}: 기본과의 차이`);
  }
  // `marker`가 빠진 match도 꼴·단계는 본다
  assert.deepEqual(paths(suggestSimilar(doc, withMatch(p, []), { origin: S0([17]) })), expectBody(items, 17, []).map(String));
  // 한글+점(2단계): 굵은 '다.'는 빠지고, bold를 끄면 들어온다
  const ga = bi(2);
  assert.deepEqual(paths(suggestSimilar(doc, pattern(doc, [ga]), { origin: S0([ga]) })), [bi(12)].map(String));
  assert.deepEqual(paths(suggestSimilar(doc, withMatch(pattern(doc, [ga]), ["marker", "height"]), { origin: S0([ga]) })), [bi(12), bi(25)].map(String));
  // 굵은 짧은 제목(none·4단계)은 혼자다: 굵은 문장(제목 아님)은 none·0이라 다르다
  assert.deepEqual(suggestSimilar(doc, pattern(doc, [bi(22)]), { origin: S0([bi(22)]) }), []);
});

test("7.10 suggestSimilar (c): rejectSuggestion 뒤 그 글 해시의 문단(같은 글의 복제 포함)만 빠지고 나머지는 그대로. 입력 패턴은 바뀌지 않고 같은 해시는 한 번만", () => {
  const doc = reparse(patternDoc());
  const p = pattern(doc, [17]);
  const before = structuredClone(p);
  const all = suggestSimilar(doc, p, { origin: S0([17]) });
  const seven = all.find((s) => s.at.path[0] === bi(0));
  assert.ok(seven !== undefined);
  const r1 = rejectSuggestion(p, seven);
  assert.deepEqual(p, before, "입력 불변");
  const text = at(BLOCK, 0).text;
  assert.deepEqual(r1.rejected, [{ text: text.slice(0, 40), sha256: sha256Hex(utf8(text)) }]);
  const after = suggestSimilar(doc, r1, { origin: S0([17]) });
  assert.deepEqual(after, all.filter((s) => s.at.path[0] !== bi(0) && s.at.path[0] !== bi(14)), "복제(줄 14)도 함께 빠진다");
  assert.deepEqual(rejectSuggestion(r1, seven), r1, "같은 해시는 다시 더하지 않는다");
  const r2 = rejectSuggestion(r1, at(after, 0));
  assert.equal(r2.rejected?.length, 2);
  assert.equal(r1.rejected?.length, 1, "r1 불변");
  assert.deepEqual(suggestSimilar(doc, r2, { origin: S0([17]) }), after.slice(1));
  // 해시만 본다(글 앞 40자가 달라도 해시가 같으면 뺀다)
  assert.deepEqual(suggestSimilar(doc, { ...p, rejected: [{ text: "다른 글", sha256: seven.sha256 }] }, { origin: S0([17]) }), after);
});

test("7.10 suggestSimilar (d): opts.exclude의 앵커가 가리키는 범위(headingRange·range는 범위 전체), 문단(line·word), 칸(cell)은 빠진다", () => {
  const doc = reparse(patternDoc());
  const items = docModel();
  const p = pattern(doc, [17]);
  const h22 = { id: "e1", ...(makeHeadingRangeAnchor(doc, 0, [], 22) ?? assert.fail()) };
  const r = makeRangeAnchor(doc, 0, [], 36, 47);
  assert.ok(r !== undefined);
  const h73 = { id: "e4", ...(makeHeadingRangeAnchor(doc, 0, [], bi(10)) ?? assert.fail()) };
  const exclude: StudioAnchor[] = [h22, { id: "e2", ...r }, { id: "e3", kind: "line", at: S0([32]), print: { text: "", sha256: "0".repeat(64) } }, h73];
  const excluded = new Set<number>();
  for (const i of [22, bi(10)]) {
    const m = rangeOfModel(items, i);
    for (let k = m.from; k <= m.to; k++) excluded.add(k);
  }
  for (let k = 36; k <= 47; k++) excluded.add(k);
  excluded.add(32);
  const want = expectBody(items, 17, p.match, { excluded });
  assert.deepEqual(want, [27, bi(0), bi(6), bi(7), bi(8), bi(9), bi(14), bi(15), bi(24), bi(26)]);
  assert.deepEqual(paths(suggestSimilar(doc, p, { origin: S0([17]), exclude })), want.map(String));
  // headingRange 범위 끝 경계: '14.'(줄 10)의 범위 끝 문단(index + count - 1)은 제목 '1) 다른 꼴 항목'(줄 13)이다. 그 제목의 패턴에서 빠져야 한다
  assert.equal(rangeOfModel(items, bi(10)).to, bi(13));
  assert.equal(h73.index + h73.print.count - 1, bi(13));
  const paren = pattern(doc, [bi(13)]);
  assert.deepEqual(paths(suggestSimilar(doc, paren)), [String(bi(13))]);
  assert.deepEqual(suggestSimilar(doc, paren, { exclude: [h73] }), []);
  // word 앵커도 그 문단을 뺀다. 필드·개체 앵커는 문단 주소가 없어 영향이 없다
  const w = wordDraft(doc, [27], 0, 2);
  assert.deepEqual(paths(suggestSimilar(doc, p, { origin: S0([17]), exclude: [{ id: "w", ...(w as Extract<SuggestionDraft, { kind: "word" }>) }, { id: "f", kind: "field", name: "x" }] })), expectBody(items, 17, p.match, { excluded: new Set([27]) }).map(String));
});

// ── suggestSimilar: 칸·라벨 ────────────────────────────────────

test("7.10 suggestSimilar (e): 칸 안 패턴 → 최상위 표 칸은 cell 초안(지문, 칸마다 하나), 중첩 표 칸은 line 초안. labelCell → 라벨 오른쪽 값 칸의 cell 초안(8.3 emptyCell과 같은 칸), labelColon → 쌍점 뒤 빈 곳의 word 초안(빈 곳이 없으면 line)", () => {
  const bytes = patternDoc();
  const doc = reparse(bytes);
  // 칸 [12, 1]의 '1. 칸 제목 하나'(그 칸의 숫자+점 1단계, 보통 모양). 표 서수: [12] 0, [15] 1, [58] 2, [61] 3, ph-table 4~6, 중첩 7
  const p = pattern(doc, [12, 1, 6]);
  const want = [
    sug(doc, [15, 5, 1], cellDraft(doc, 1, 15, 5)),
    sug(doc, [58, 1, 1], cellDraft(doc, 2, 58, 1)),
    sug(doc, [NESTED, 1, 0, 0, 1], lineDraft(doc, [NESTED, 1, 0, 0, 1])),
    sug(doc, [NESTED, 1, 0, 2, 1], lineDraft(doc, [NESTED, 1, 0, 2, 1])),
    sug(doc, [NESTED, 1, 0, 2, 2], lineDraft(doc, [NESTED, 1, 0, 2, 2])),
  ];
  const got = suggestSimilar(doc, p, { origin: S0([12, 1, 6]) });
  assert.deepEqual(got, want);
  for (const s of got.slice(0, 2)) assert.ok(s.draft.kind === "cell" && s.draft.print !== undefined, "cell 초안에 지문");
  // 원점 칸의 다른 문단('2. 칸 제목 둘')에서 시작해도 원점 칸은 빠진다
  assert.deepEqual(suggestSimilar(doc, pattern(doc, [12, 1, 9]), { origin: S0([12, 1, 9]) }), want);
  // 원점이 없으면 원점 칸도 칸마다 하나(첫 문단)로 나온다
  assert.deepEqual(paths(suggestSimilar(doc, p)), ["12,1,6", ...paths(want)]);
  // 굵은 칸 제목은 bold를 끄면 들어오고, 로마 숫자 아래 2단계는 들어오지 않는다
  assert.deepEqual(suggestSimilar(doc, withMatch(p, ["marker"]), { origin: S0([12, 1, 6]) }), [...want.slice(0, 2), sug(doc, [61, 7, 1], cellDraft(doc, 3, 61, 7)), ...want.slice(2)]);
  // 칸 앵커로 빼기
  const c15 = cellDraft(doc, 1, 15, 5);
  assert.ok(c15.kind === "cell");
  assert.deepEqual(suggestSimilar(doc, p, { origin: S0([12, 1, 6]), exclude: [{ id: "c", ...c15 }] }), want.slice(1));
  // 해제: 칸의 대표 문단을 해제하면 그 칸이 빠진다(그 칸의 다음 문단으로 바꿔 내지 않는다)
  assert.deepEqual(suggestSimilar(doc, rejectSuggestion(p, at(want, 0)), { origin: S0([12, 1, 6]) }), want.slice(1));

  // 라벨 셀: ph-table 3벌의 성명·연락처·비고(9개) 가운데 원점 빼고 8개. 초안은 라벨 오른쪽 값 칸(하위 목록 k + 1)의 cell 초안
  const [ph0, ph1, ph2] = PH as [number, number, number];
  const lp = pattern(doc, [ph0, 0, 0]);
  assert.equal(lp.place, "labelCell");
  const labelWant = [ph0, ph1, ph2].flatMap((o, n) => [0, 2, 4].map((k) => ({ o, k, ord: 4 + n }))).filter((x) => !(x.o === ph0 && x.k === 0));
  const labels = suggestSimilar(doc, lp, { origin: S0([ph0, 0, 0]) });
  assert.deepEqual(labels, labelWant.map((x) => sug(doc, [x.o, x.k, 0], cellDraft(doc, x.ord, x.o, x.k + 1))));
  // 8.3 후보(findCandidates)의 emptyCell 초안과 같은 칸이다(후보에는 지문이 없어 칸 주소만 대조)
  const empty = findCandidates(doc).filter((c) => c.kind === "emptyCell").map((c) => JSON.stringify(c.anchor));
  for (const s of labels) {
    assert.ok(s.draft.kind === "cell" && s.draft.print !== undefined);
    const { print: _print, ...addr } = s.draft;
    assert.ok(empty.includes(JSON.stringify(addr)), `${s.at.path.join(",")}: emptyCell 후보와 같은 칸`);
  }
  // 값 칸을 가리키는 cell 앵커로 빼면 그 라벨이 빠진다. 라벨 칸 자체의 cell 앵커도 그 칸의 문단(라벨)을 빼므로 같은 라벨이 빠진다
  const v1 = at(labels, 0).draft;
  assert.ok(v1.kind === "cell");
  assert.deepEqual(suggestSimilar(doc, lp, { origin: S0([ph0, 0, 0]), exclude: [{ id: "v", ...v1 }] }), labels.slice(1));
  const labelCellItself = cellDraft(doc, 4, ph0, 2);
  assert.ok(labelCellItself.kind === "cell");
  assert.deepEqual(suggestSimilar(doc, lp, { origin: S0([ph0, 0, 0]), exclude: [{ id: "l", ...labelCellItself }] }), labels.slice(1));

  // 라벨: 본문 '성명:'의 패턴 → 같은 모양의 `라벨:` 문단(본문·칸). '소속:   '·'전자우편： '·칸의 '주소:  '는 word, '연락처 :'는 line
  const cp = pattern(doc, [bi(16)]);
  assert.equal(cp.place, "labelColon");
  const colonWant = [
    sug(doc, [12, 1, 10], wordDraft(doc, [12, 1, 10], 3, 5)),
    sug(doc, [bi(17)], wordDraft(doc, [bi(17)], 3, 6)),
    sug(doc, [bi(18)], lineDraft(doc, [bi(18)])),
    sug(doc, [bi(19)], wordDraft(doc, [bi(19)], 5, 6)),
  ];
  assert.deepEqual(suggestSimilar(doc, cp, { origin: S0([bi(16)]) }), colonWant);
  // word 초안은 그대로 채울 수 있다(라벨 뒤 빈 곳만 값으로 바뀐다)
  const wd = at(colonWant, 1).draft;
  assert.ok(wd.kind === "word");
  const filled = done(generate(bytes, tpl([{ id: "w", ...wd }], [{ id: "f", do: { type: "fill", anchor: "w", value: { text: "홍길동 & <소속>" } } }]), ds({}), KEEP));
  gateClean(bytes, filled);
  assert.equal(at(top(reparse(filled.output)), bi(17)).logicalText, "소속:홍길동 & <소속>");
});

// ── 중첩 라벨 칸·굵은 제목과 굵은 문단·굵은 라벨 ─────────────────

let extraCache: Uint8Array | undefined;
/** 덧붙인 문서: 시험 문서 끝에 중첩 표를 하나 더 넣은 번호 */
const N2 = NESTED + 1;
/** 덧붙인 문서의 최상위 굵은 `라벨:` 문단 번호 */
const BOLD_LABEL = N2 + 1;
/**
 * 시험 문서에 더한 것: 끝에 `tables/tables-nested`를 한 벌 더(N2) 넣고, 그 안쪽 표의 '안2'·'안4'를 빈 글로 채워 '안1'·'안3'을 라벨 칸으로 만들고
 * '안3' 칸에 문단 '비고 둘'을 더한다(라벨 칸 하나에 맞는 문단 2개). 바깥 칸 '바깥3' 뒤에 굵은 짧은 제목, '바깥4' 뒤에 굵은 문장(제목 아님),
 * 원래 중첩 표의 '바깥3' 뒤에 굵은 짧은 제목 하나 더, N2 바깥 칸 [1]에 굵은 '확인자:', 최상위 N2 뒤에 굵은 '담당자:'.
 */
function extraDoc(): Uint8Array {
  if (extraCache !== undefined) return extraCache;
  const base = patternDoc();
  const d0 = reparse(base);
  const nested = fragOf(reparse(readFixture("tables/tables-nested")), 1, 1);
  const step1 = done(generate(base, tpl([line(d0, "t", [NESTED])], [inject("n2", "t", nested, "after")]), ds({}), KEEP));
  const d1 = reparse(step1.output);
  const B = styleOf("B");
  const boldAfter = (id: string, anchor: string, text: string) => ({ id, do: { type: "insertText", anchor, position: "after", value: { text }, style: B } });
  const step2 = done(
    generate(
      step1.output,
      tpl(
        [
          line(d1, "an2", [N2, 1, 0, 1, 0]),
          line(d1, "an4", [N2, 1, 0, 3, 0]),
          line(d1, "an3", [N2, 1, 0, 2, 0]),
          line(d1, "o3", [N2, 2, 0]),
          line(d1, "o4", [N2, 3, 0]),
          line(d1, "p3", [NESTED, 2, 0]),
          line(d1, "o1", [N2, 1, 1]),
          line(d1, "top", [N2]),
        ],
        [
          { id: "f2", do: { type: "fill", anchor: "an2", value: { text: "" } } },
          { id: "f4", do: { type: "fill", anchor: "an4", value: { text: "" } } },
          insertText("i3", "an3", "비고 둘", "after"),
          boldAfter("b3", "o3", "굵은 칸 제목"),
          boldAfter("b4", "o4", "굵은 칸 문장입니다."),
          boldAfter("bp", "p3", "굵은 칸 제목 둘"),
          boldAfter("b1", "o1", "확인자:"),
          boldAfter("bt", "top", "담당자:"),
        ],
      ),
      ds({}),
      KEEP,
    ),
  );
  extraCache = step2.output;
  return extraCache;
}

test("7.10 suggestSimilar: 중첩 표의 라벨 칸에 맞는 문단이 2개여도 제안은 하나(값 칸 첫 문단의 line 초안). 원점 라벨 칸·값 칸 line 앵커로 빼기", () => {
  const doc = reparse(extraDoc());
  const texts = (k: number) => (paragraph(doc, [N2, 1, 0]).subLists[k]?.paragraphs ?? []).map((p) => p.logicalText);
  assert.deepEqual([texts(0), texts(1), texts(2), texts(3)], [["안1"], [""], ["안3", "비고 둘"], [""]]);
  const lp = pattern(doc, [N2, 1, 0, 0, 0]);
  assert.deepEqual([lp.place, lp.marker], ["labelCell", NOT_HEADING]);
  // 라벨 칸 '안3'의 두 문단 모두 같은 자리·꼴·굵기·크기다(중복 제거가 없으면 둘 다 나온다)
  for (const path of [[N2, 1, 0, 2, 0], [N2, 1, 0, 2, 1]]) {
    const q = pattern(doc, path);
    assert.deepEqual([q.place, q.marker, q.char?.bold, q.char?.height], [lp.place, lp.marker, lp.char?.bold, lp.char?.height], path.join(","));
  }
  const inN2 = (s: readonly Suggestion[]) => s.filter((x) => x.at.path[0] === N2);
  assert.deepEqual(inN2(suggestSimilar(doc, lp, { origin: S0([N2, 1, 0, 0, 0]) })), [sug(doc, [N2, 1, 0, 2, 0], lineDraft(doc, [N2, 1, 0, 3, 0]))]);
  // 원점이 라벨 칸의 둘째 문단이면 그 칸은 빠지고 '안1' 칸만 남는다
  assert.deepEqual(inN2(suggestSimilar(doc, pattern(doc, [N2, 1, 0, 2, 1]), { origin: S0([N2, 1, 0, 2, 1]) })), [sug(doc, [N2, 1, 0, 0, 0], lineDraft(doc, [N2, 1, 0, 1, 0]))]);
  // 값 칸 첫 문단을 가리키는 line 앵커로 빼면 그 라벨이 빠진다
  const valueLine = lineDraft(doc, [N2, 1, 0, 3, 0]);
  assert.ok(valueLine.kind === "line");
  assert.deepEqual(inN2(suggestSimilar(doc, lp, { origin: S0([N2, 1, 0, 0, 0]), exclude: [{ id: "v", ...valueLine }] })), []);
});

test("7.10 suggestSimilar: 제목 아닌 문단은 none·0이라 굵은 짧은 제목(none·1) 패턴에 굵은 일반 문단이 섞이지 않는다. 굵은 `라벨:` 패턴은 본문·칸 라벨과 맞고(라벨 자리의 번호 없는 문단은 none·0) 2판 읽기가 단계 0을 받는다", () => {
  const bytes = extraDoc();
  const doc = reparse(bytes);
  // 굵은 짧은 제목(칸 목록에서 none·1)과 굵은 문장(제목 아님, none·0)
  const hp = pattern(doc, [N2, 2, 1]);
  assert.deepEqual([hp.place, hp.marker, hp.char?.bold], ["cell", { form: "none", level: 1 }, true]);
  const sp = pattern(doc, [N2, 3, 1]);
  assert.deepEqual([sp.place, sp.marker, sp.char?.bold], ["cell", NOT_HEADING, true]);
  const want = [sug(doc, [NESTED, 2, 1], cellDraft(doc, 7, NESTED, 2))];
  assert.deepEqual(suggestSimilar(doc, hp, { origin: S0([N2, 2, 1]) }), want);
  assert.deepEqual(suggestSimilar(doc, withMatch(hp, ["marker"]), { origin: S0([N2, 2, 1]) }), want, "match marker만이어도 굵은 문장은 섞이지 않는다");
  // 굵은 문장 패턴(none·0, 굵게): 같은 칸 자리의 굵은 짧은 제목(none·1)은 들어오지 않는다
  assert.ok(suggestSimilar(doc, sp, { origin: S0([N2, 3, 1]) }).every((s) => s.at.path.join(",") !== [N2, 2, 1].join(",") && s.at.path.join(",") !== [NESTED, 2, 1].join(",")));

  // 굵은 라벨: 최상위 '담당자:'(그 목록의 none 제목 4단계)와 칸 '확인자:'(그 칸 목록의 none 제목 1단계)는 라벨 자리라 둘 다 none·0
  const heads = new Map(detectHeadings(doc).map((h) => [[...h.at.parentPath, h.index].join(","), h.marker]));
  assert.deepEqual(heads.get(String(BOLD_LABEL)), { form: "none", level: 4 });
  assert.deepEqual(heads.get([N2, 1, 2].join(",")), { form: "none", level: 1 });
  const bp = pattern(doc, [BOLD_LABEL]);
  assert.deepEqual([bp.place, bp.marker, bp.char?.bold], ["labelColon", NOT_HEADING, true]);
  assert.deepEqual(suggestSimilar(doc, bp, { origin: S0([BOLD_LABEL]) }), [sug(doc, [N2, 1, 2], lineDraft(doc, [N2, 1, 2]))]);
  // 굵기를 끄면 굵지 않은 라벨(본문 '성명:' 등·칸 '주소:  ')도 같은 none·0이라 들어온다
  const all = paths(suggestSimilar(doc, withMatch(bp, ["marker", "height"]), { origin: S0([BOLD_LABEL]) }));
  for (const path of [[12, 1, 10], [bi(16)], [bi(17)], [bi(18)], [bi(19)], [N2, 1, 2]]) assert.ok(all.includes(path.join(",")), path.join(","));
  // 2판 읽기: 패턴 marker.level 0을 받고 정규 쓰기 왕복
  const t: StudioTemplate = {
    schema: "hwpx-studio/template@2",
    id: "t0a1b2c3d",
    version: 1,
    source: { kind: "hwpx", sha256: sha256Hex(bytes) },
    anchors: [],
    patterns: [{ ...bp, id: "pl", name: "굵은 라벨" }],
    values: [],
    bindings: [],
    places: [],
    slots: [],
    blocks: [],
  };
  const read = readStudioTemplate(writeStudioTemplate(t));
  assert.deepEqual(read, t);
  assert.equal(read.patterns?.[0]?.marker.level, 0);
});

// ── 2판 왕복·재지정 ────────────────────────────────────────────

test("7.10 suggestSimilar (f): 제안 초안에 id·pattern을 붙여 2판 anchors[]에, 패턴(rejected 포함)을 patterns[]에 넣고 writeStudioTemplate → readStudioTemplate 왕복. checkAnchors exact, exclude로 넣은 앵커는 다시 제안되지 않는다. redraftAnchor 연결", () => {
  const bytes = patternDoc();
  const doc = reparse(bytes);
  const origin = S0([17]);
  const p1: Pattern = { ...pattern(doc, [17]), id: "pt1", name: "1단계 제목" };
  const s1 = suggestSimilar(doc, p1, { origin });
  const p1r = rejectSuggestion(p1, at(s1, 0));
  const p2: Pattern = { ...pattern(doc, [12, 1, 6]), id: "pt2", name: "칸 제목" };
  const s2 = suggestSimilar(doc, p2, { origin: S0([12, 1, 6]) });
  const p3: Pattern = { ...pattern(doc, [bi(16)]), id: "pt3", name: "라벨" };
  const s3 = suggestSimilar(doc, p3, { origin: S0([bi(16)]) });
  const anchors: StudioAnchor[] = [
    { id: "a0", ...headingDraft(doc, 17), pattern: "pt1" } as StudioAnchor,
    ...s1.slice(1, 5).map((s, k) => ({ id: `a${k + 1}`, ...s.draft, pattern: "pt1" }) as StudioAnchor),
    { id: "c1", ...at(s2, 0).draft, pattern: "pt2" } as StudioAnchor,
    { id: "w1", ...at(s3, 1).draft, pattern: "pt3" } as StudioAnchor,
  ];
  const t: StudioTemplate = {
    schema: "hwpx-studio/template@2",
    id: "t0a1b2c3d",
    version: 1,
    source: { kind: "hwpx", sha256: sha256Hex(bytes) },
    anchors,
    patterns: [p1r, p2, p3],
    values: [],
    bindings: [],
    places: [],
    slots: [],
    blocks: [],
  };
  const read = readStudioTemplate(writeStudioTemplate(t));
  assert.deepEqual(read, t);
  assert.equal(writeStudioTemplate(read), writeStudioTemplate(t));
  assert.deepEqual(checkAnchors(doc, read).map((c) => c.state), anchors.map(() => "exact"));
  // 읽은 패턴과 앵커로 다시 제안: 앵커가 된 것·해제한 것은 빠지고 나머지는 그대로
  const pr = at(read.patterns ?? [], 0);
  const again = suggestSimilar(doc, pr, { origin, exclude: read.anchors });
  assert.deepEqual(again, s1.slice(5));
  // 원본 앞에 문단을 끼운 뒤(8.8.13 재지정): 같은 패턴의 제안에서 옛 앵커의 제목을 골라 redraftAnchor → id·pattern 유지, exact
  const shiftedBytes = done(generate(bytes, tpl([line(doc, "p1", [1])], [insertText("i", "p1", "끼운 문단입니다.", "after")]), ds({}), KEEP)).output;
  const shifted = reparse(shiftedBytes);
  const old = at(read.anchors, 1);
  assert.ok(old.kind === "headingRange");
  const pick = suggestSimilar(shifted, pr, { origin: S0([18]) }).find((s) => s.sha256 === old.heading.sha256);
  assert.ok(pick !== undefined && pick.at.path[0] === old.index + 1);
  const re = redraftAnchor(shifted, old, pick.draft);
  assert.deepEqual(re, { anchor: { id: old.id, ...headingDraft(shifted, old.index + 1), pattern: "pt1" }, kindChanged: false });
  assert.deepEqual(checkAnchors(shifted, { anchors: [re.anchor] }).map((c) => c.state), ["exact"]);
});

// ── 무작위 ─────────────────────────────────────────────────────

const HANGUL = "가나다라마바사아자차카타파하";
const CIRCLED = ["①", "⑦", "⑴", "㉠", "㉮", "❶", "➀"];
type RandomForm = "digitDot" | "digitDot2" | "hangulDot" | "digitParen" | "digitParens" | "circled" | "box" | "roman" | "none";
const RANDOM_FORMS: RandomForm[] = ["digitDot", "digitDot", "digitDot2", "hangulDot", "digitParen", "digitParens", "circled", "box", "roman", "none"];

/** 시드 고정 무작위 줄: 제목(꼴·단계·모양 무작위, 굵은 제목은 굵은 모양), 본문(문장 끝, 모양 무작위), 앞 제목의 복제 */
function randomLines(next: () => number, n: number): PLine[] {
  const pick = <T>(xs: readonly T[]): T => at(xs, Math.floor(next() * xs.length));
  const out: PLine[] = [];
  for (let k = 0; k < n; k++) {
    const roll = next();
    const heads = out.filter((l) => l.mark !== undefined);
    if (roll < 0.08 && heads.length > 0) {
      out.push({ ...pick(heads) });
      continue;
    }
    if (roll < 0.6) {
      const form = pick(RANDOM_FORMS);
      const look: LookName = form === "none" ? "B" : pick(LOOK_NAMES);
      const tail = ` 제목 ${k} {{기관명}} & <${k}>`;
      const line =
        form === "digitDot"
          ? H("digitDot", 0, `${1 + Math.floor(next() * 30)}.${tail}`)
          : form === "digitDot2"
            ? H("digitDot", 1, `${1 + Math.floor(next() * 9)}.${1 + Math.floor(next() * 9)}.${tail}`)
            : form === "hangulDot"
              ? H("hangulDot", 0, `${pick([...HANGUL])}.${tail}`)
              : form === "digitParen"
                ? H("digitParen", 0, `${1 + k})${tail}`)
                : form === "digitParens"
                  ? H("digitParens", 0, `(${1 + k})${tail}`)
                  : form === "circled"
                    ? H("circled", 0, `${pick(CIRCLED)}${tail}`)
                    : form === "box"
                      ? H("box", 0, `${pick(["□", "○"])}${tail}`)
                      : form === "roman"
                        ? H("roman", 0, `Ⅱ.${tail}`)
                        : H("none", 0, `굵은 제목 ${k}`, true);
      out.push(S(look, line));
    } else {
      out.push(S(pick(LOOK_NAMES), P(`본문 ${k}: {{사업명}} 안내 ${"세부 사항 & <참고>. ".repeat(1 + Math.floor(next() * 3))}`)));
    }
  }
  return out;
}

test("7.10 무작위 60회(시드 고정): 제목 수·꼴·단계·굵기·크기·모양 무작위 문서에서 패턴의 꼴·단계와 제안 집합(match·order·exclude·rejected 무작위)이 모형과 같고 결정적", () => {
  const base = notice();
  const d0 = reparse(base);
  let compared = 0;
  let suggested = 0;
  let defaults = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const next = rng(2000 + seed);
    const lines = randomLines(next, 12 + Math.floor(next() * 30));
    const bytes = done(generate(base, tpl([line(d0, "end", [62])], insertGroups("b", "end", lines)), ds({}), KEEP)).output;
    const doc = reparse(bytes);
    const items = modelTop(lines);
    assert.equal(top(doc).length, items.length, `시드 ${seed}: 문단 수`);
    const order = next() < 0.3 ? [...SPEC_ORDER].filter((f) => f !== "none").sort(() => next() - 0.5).slice(0, 1 + Math.floor(next() * 5)) : undefined;
    const levels = levelsOf(items, order);
    const heads = [...levels.keys()];
    const origin = at(heads, Math.floor(next() * heads.length));
    const p0 = pattern(doc, [origin], order);
    const o = at(items, origin);
    assert.ok(o.mark !== undefined && o.look !== undefined);
    assert.deepEqual(p0.marker, { form: o.mark.form, level: levels.get(origin) }, `시드 ${seed}: 꼴·단계`);
    assert.deepEqual([p0.place, p0.char?.bold, p0.char?.height], ["body", CHAR[LOOKS[o.look].charPr]?.bold, CHAR[LOOKS[o.look].charPr]?.height], `시드 ${seed}: 굵기·크기`);
    // 기본 match(꼴·단계·굵기·크기)
    assert.deepEqual(p0.match, DEFAULT_MATCH);
    const byDefault = suggestSimilar(doc, p0, { origin: S0([origin]), ...(order === undefined ? {} : { order }) });
    assert.deepEqual(paths(byDefault), expectBody(items, origin, DEFAULT_MATCH, { order }).map(String), `시드 ${seed}: 기본 match`);
    defaults += byDefault.length;
    const match: PatternMatchKey[] = ["marker", ...(["bold", "height", "print", "paraPrint", "align"] as PatternMatchKey[]).filter(() => next() < 0.5)];
    const before = expectBody(items, origin, match, { order });
    // 무작위로 다른 제목 하나를 앵커로 빼고, 남은 제안 하나의 글을 해제한다
    const excluded = new Set<number>();
    const exclude: StudioAnchor[] = [];
    const others = heads.filter((i) => i !== origin);
    if (next() < 0.5 && others.length > 0) {
      const e = at(others, Math.floor(next() * others.length));
      const m = rangeOfModel(items, e, order);
      for (let k = m.from; k <= m.to; k++) excluded.add(k);
      exclude.push({ id: "e", ...(headingDraft(doc, e, order) as Extract<SuggestionDraft, { kind: "headingRange" }>) });
    }
    const rejectedTexts = new Set<string>();
    let pat = withMatch(p0, match);
    const left = before.filter((i) => !excluded.has(i));
    if (next() < 0.5 && left.length > 0) {
      const text = at(items, at(left, Math.floor(next() * left.length))).text ?? "";
      rejectedTexts.add(text);
      pat = { ...pat, rejected: [{ text: text.slice(0, 40), sha256: sha256Hex(utf8(text)) }] };
    }
    const want = expectBody(items, origin, match, { order, excluded, rejectedTexts });
    const opts = { origin: S0([origin]), exclude, ...(order === undefined ? {} : { order }) };
    const got = suggestSimilar(doc, pat, opts);
    assert.deepEqual(paths(got), want.map(String), `시드 ${seed}: 제안(${match.join("+")}${order === undefined ? "" : `, 서열 ${order.join(">")}`})`);
    for (const [k, i] of want.entries()) {
      assert.deepEqual(at(got, k).draft, headingDraft(doc, i, order), `시드 ${seed}: 초안 ${i}`);
      const r = rangeOfModel(items, i, order);
      const d = at(got, k).draft;
      assert.ok(d.kind === "headingRange" && d.print.count === r.to - r.from + 1, `시드 ${seed}: 범위 ${i}`);
    }
    assert.deepEqual(suggestSimilar(reparse(bytes), pat, opts), got, `시드 ${seed}: 결정성`);
    compared++;
    suggested += got.length;
  }
  assert.ok(compared >= 50, `비교 ${compared}회`);
  assert.ok(suggested >= 100, `제안 ${suggested}개`);
  assert.ok(defaults >= 100, `기본 match 제안 ${defaults}개`);
});
