// 문단(line)·셀(cell) 채움이 원래 있던 줄바꿈·탭 요소를 남기던 결함(이슈 #14). 기대값은 총괄 결정(2026-10-04, 범위를 넓힌 두 번째 결정)에서 만들었다:
//  - line·cell 채움은 글을 지우는 모든 자리의 줄바꿈(`lineBreak`)·탭(`tab`) 요소도 함께 지운다: 채우는 문단의 모든 run(값을 넣는 run과 글이 비워지는 다른 run),
//    `cell`이면 글이 비워지는 나머지 문단까지. 그래서 다시 읽은 문단 글이 (줄바꿈을 `\n`으로 맞춘) 값과 같고, 줄바꿈·탭 요소 수는 값에 든 수와 같으며, 나머지 문단은 빈 글이다.
//  - 값에 든 줄바꿈·탭은 전처럼 요소로 넣는다. 그 밖의 인라인(고정폭 공백·형광펜·변경 추적 표식 등)은 그대로 둔다.
//  - 누름틀·`{{}}`·낱말 채움은 바뀌지 않는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generate, isTableNode, listFields, readArchive, readEntry, validateDocument, type GenerateResult, type HwpxDocument, type ParagraphNode } from "../src/index.ts";
import { paragraphAtPath } from "../src/fill/doc.ts";
import { readDataset, readTemplate, type Template } from "../src/template/index.ts";
import { buildHwpx, newErrorsAfter, readFixture, reparse, sha256Hex, utf8 } from "./helpers.ts";
import { gridTable, tableXml, type CellSpec } from "./table-helpers.ts";

const SEC = "Contents/section0.xml";
type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;
const done = (r: GenerateResult): Done => {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error").map((i) => [i.code, i.message]))}`);
  assert.ok(!r.dryRun);
  return r as Done;
};
const tpl = (spec: { anchors?: unknown[]; rules?: unknown[] }): Template => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const ds = (data: unknown) => readDataset(data);
const fillRule = (id: string, anchor: string, value: unknown) => ({ id, do: { type: "fill", anchor, value } });
const sectionOf = (bytes: Uint8Array): string => new TextDecoder().decode(readEntry(readArchive(bytes), bytes, SEC));
const norm = (v: string): string => v.replace(/\r\n?/g, "\n");
const count = (xml: string, re: RegExp): number => xml.match(re)?.length ?? 0;
const breaks = (xml: string): number => count(xml, /<hp:lineBreak\/>/g);
const tabs = (xml: string): number => count(xml, /<hp:tab\b/g);
const occurrences = (text: string, ch: string): number => text.split(ch).length - 1;

const LB = "<hp:lineBreak/>";
const TAB = '<hp:tab width="0" leader="0" type="1"/>';
const para = (inner: string, charPr = "0"): string =>
  `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}">${inner}</hp:run></hp:p>`;
const t = (inner: string): string => `<hp:t>${inner}</hp:t>`;
const cellOf = (row: number, col: number, paragraphs: string[]): CellSpec => ({ row, col, width: 3000, height: 1000, paragraphs });
const tableDoc = (cells: CellSpec[], rowCnt: number, colCnt: number, id = "1001"): string => para(`${tableXml({ id, rowCnt, colCnt, cells })}<hp:t/>`);

const lineAnchor = (id: string, par: ParagraphNode) => ({
  id,
  kind: "line",
  at: { sectionIndex: 0, path: par.path },
  print: { text: par.logicalText.slice(0, 40), sha256: sha256Hex(utf8(par.logicalText)) },
});
const cellAnchor = (id: string, ordinal: number, row: number, col: number) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal }, row, col });
const at = (doc: HwpxDocument, path: number[]): ParagraphNode => {
  const p = doc.sections[0] === undefined ? undefined : paragraphAtPath(doc.sections[0], path);
  assert.ok(p !== undefined, `문단 [${path.join(", ")}]이 없다`);
  return p;
};
const xmlOf = (doc: HwpxDocument, p: ParagraphNode): string => doc.sections[0]?.text.slice(p.element.start, p.element.end) ?? "";
const cellParagraphs = (doc: HwpxDocument, ordinal: number, row: number, col: number): ParagraphNode[] => {
  const tables = (doc.sections[0]?.paragraphs ?? []).flatMap((p) => p.objects.filter(isTableNode));
  return tables[ordinal]?.cells.find((c) => c.row === row && c.col === col)?.subList?.paragraphs ?? [];
};

// ── 재현 ────────────────────────────────────────────────────────

test("재현: 글 뒤에 줄바꿈 요소가 있는 셀을 채우면 다시 읽은 셀 글이 값과 정확히 같고 줄바꿈 요소가 남지 않는다(전에는 '값 + 줄바꿈')", () => {
  const bytes = buildHwpx([tableDoc([cellOf(0, 0, [para(t(`ONE${LB}`))]), cellOf(0, 1, [para(t("옆 칸"))])], 1, 2)]);
  assert.equal(cellParagraphs(reparse(bytes), 0, 0, 0)[0]?.logicalText, "ONE\n");
  const r = done(generate(bytes, tpl({ anchors: [cellAnchor("c", 0, 0, 0)], rules: [fillRule("r", "c", { text: "TWO" })] }), ds({})));
  const out = reparse(r.output);
  assert.equal(cellParagraphs(out, 0, 0, 0)[0]?.logicalText, "TWO");
  assert.equal(breaks(sectionOf(r.output)), 0, "줄바꿈 요소 0");
  assert.equal(cellParagraphs(out, 0, 0, 1)[0]?.logicalText, "옆 칸", "다른 칸은 그대로");
  assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), []);
});

test("재현: 문단(line) 채움도 같다 — 글 앞뒤·사이의 줄바꿈·탭 요소, 글 없이 줄바꿈만 있는 문단, 줄바꿈 값을 채운 문단을 다시 채우기", () => {
  const cases: [string, string][] = [
    ["글 뒤 줄바꿈", t(`가${LB}`)],
    ["글 앞 탭", t(`${TAB}나`)],
    ["사이의 줄바꿈·탭", t(`가${LB}나${TAB}다`)],
    ["여러 hp:t", t(`가${LB}`) + t(`나${TAB}`)],
    ["줄바꿈만(글 조각 없음)", t(`${LB}${LB}`)],
    ["엔티티 옆", t(`a&amp;b${LB}c`)],
  ];
  for (const [label, inner] of cases) {
    const bytes = buildHwpx([para(inner) + para(t("뒤 문단"))]);
    const doc = reparse(bytes);
    const r = done(generate(bytes, tpl({ anchors: [lineAnchor("l", at(doc, [0]))], rules: [fillRule("r", "l", { text: "값" })] }), ds({})));
    const out = reparse(r.output);
    assert.equal(at(out, [0]).logicalText, "값", label);
    assert.equal(breaks(xmlOf(out, at(out, [0]))) + tabs(xmlOf(out, at(out, [0]))), 0, `${label}: 줄바꿈·탭 요소 0`);
    assert.equal(at(out, [1]).logicalText, "뒤 문단", label);
  }
  // 줄바꿈·탭이 든 값으로 채운 문단을 다른 값으로 다시 채우면 옛 요소가 남지 않는다
  const bytes = buildHwpx([para(t("처음"))]);
  const first = done(generate(bytes, tpl({ anchors: [lineAnchor("l", at(reparse(bytes), [0]))], rules: [fillRule("r", "l", { text: "첫 줄\n둘째\t줄\n셋째" })] }), ds({})));
  assert.equal(at(reparse(first.output), [0]).logicalText, "첫 줄\n둘째\t줄\n셋째");
  const again = done(generate(first.output, tpl({ anchors: [lineAnchor("l", at(reparse(first.output), [0]))], rules: [fillRule("r", "l", { text: "새 값" })] }), ds({})));
  assert.equal(at(reparse(again.output), [0]).logicalText, "새 값");
  assert.equal(breaks(sectionOf(again.output)) + tabs(sectionOf(again.output)), 0);
});

test("경계: 다른 run(글이 있는 run, 줄바꿈·탭만 있는 run)과 셀의 나머지 문단의 줄바꿈·탭 요소도 지운다. 줄바꿈·탭이 아닌 인라인(고정폭 공백·형광펜 표식)은 지우지 않는다", () => {
  // 첫 run: 글(값을 넣는 run), 둘째 run(다른 글자모양): 글 + 줄바꿈, 셋째 run: 줄바꿈·탭만
  const threeRuns = `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${t(`앞${LB}`)}</hp:run><hp:run charPrIDRef="1">${t(`뒤${LB}`)}</hp:run><hp:run charPrIDRef="0">${t(`${LB}${TAB}`)}</hp:run></hp:p>`;
  const restRuns = `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${t(`셋째${TAB}`)}</hp:run><hp:run charPrIDRef="1">${t(LB)}</hp:run></hp:p>`;
  const bytes = buildHwpx([threeRuns + tableDoc([cellOf(0, 0, [para(t(`첫${LB}`)), para(t(`둘째${LB}`)), restRuns])], 1, 1)]);
  const doc = reparse(bytes);
  assert.equal(at(doc, [0]).logicalText, "앞\n뒤\n\n\t");
  const r = done(
    generate(bytes, tpl({ anchors: [lineAnchor("l", at(doc, [0])), cellAnchor("c", 0, 0, 0)], rules: [fillRule("r1", "l", { text: "값" }), fillRule("r2", "c", { text: "칸" })] }), ds({})),
  );
  const out = reparse(r.output);
  assert.equal(at(out, [0]).logicalText, "값", "모든 run의 줄바꿈·탭을 지운다");
  assert.deepEqual(cellParagraphs(out, 0, 0, 0).map((p) => p.logicalText), ["칸", "", ""], "셀 첫 문단은 값만, 나머지 문단은 줄바꿈·탭까지 비운다");
  assert.equal(breaks(sectionOf(r.output)) + tabs(sectionOf(r.output)), 0, "줄바꿈·탭 요소 0");
  assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), []);
  // 고정폭 공백은 줄바꿈·탭이 아니라 그대로 둔다
  const spaced = buildHwpx([para(t(`가<hp:nbSpace/>나${LB}`))]);
  const s = done(generate(spaced, tpl({ anchors: [lineAnchor("l", at(reparse(spaced), [0]))], rules: [fillRule("r", "l", { text: "값" })] }), ds({})));
  assert.equal(at(reparse(s.output), [0]).logicalText, "값 ");
  // 형광펜 표식은 줄바꿈·탭이 아니라 그대로 둔다(짝이 깨지지 않는다)
  const marked = buildHwpx([para(t(`<hp:markpenBegin color="#FFFF00"/>강조${LB}<hp:markpenEnd/>`))]);
  const m = done(generate(marked, tpl({ anchors: [lineAnchor("l", at(reparse(marked), [0]))], rules: [fillRule("r", "l", { text: "값" })] }), ds({})));
  const xml = sectionOf(m.output);
  assert.equal(at(reparse(m.output), [0]).logicalText, "값");
  assert.ok(xml.includes("<hp:markpenBegin") && xml.includes("<hp:markpenEnd/>") && breaks(xml) === 0);
  assert.deepEqual(newErrorsAfter(validateDocument(marked), validateDocument(m.output)), []);
});

test("바뀌지 않음: 누름틀·{{}}·낱말 채움은 그 자리 밖의 줄바꿈 요소를 건드리지 않는다", () => {
  const field = `<hp:ctrl><hp:fieldBegin id="7" type="CLICK_HERE" name="성명" dirty="1" fieldid="1"/></hp:ctrl>${t("옛")}<hp:ctrl><hp:fieldEnd beginIDRef="7" fieldid="1"/></hp:ctrl>`;
  const bytes = buildHwpx([para(t(`앞${LB}`) + field + t(`뒤${LB}`)) + para(t(`{{k}}${LB}끝`)) + para(t(`앞 대상${LB}`))]);
  const doc = reparse(bytes);
  const logical = at(doc, [2]).logicalText;
  const word = { id: "w", kind: "word", at: { sectionIndex: 0, path: [2] }, start: 2, end: 4, print: { text: "대상", before: logical.slice(0, 2), after: logical.slice(4) } };
  const r = done(generate(bytes, tpl({ anchors: [word], rules: [fillRule("r", "w", { text: "값" })] }), ds({ 성명: "새", k: "케이" })));
  const out = reparse(r.output);
  assert.deepEqual(listFields(out).map((f) => f.valueText), ["새"]);
  assert.deepEqual([0, 1, 2].map((i) => at(out, [i]).logicalText), [`앞\n${"￼"}새${"￼"}뒤\n`, "케이\n끝", "앞 값\n"]);
  assert.equal(breaks(sectionOf(r.output)), breaks(sectionOf(bytes)));
});

// ── 많은 자리·긴 값 ─────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const PARTS = ["공고", "사업", "기간", "계약", "(주)", "A&B", "x<y", "a>b", '"인용"', "'작은따옴표'", "1,234,500원", "2026-10-04", "]]>", "😀", "제3항"];
/** 1~max자 값. 낱말 사이에 공백·줄바꿈(LF·CRLF)·탭이 들고, 줄바꿈·탭으로 시작하거나 끝날 수 있다. */
function valueOf(r: () => number, max: number): string {
  const target = 1 + Math.floor(r() * max);
  let out = r() < 0.1 ? "\n" : r() < 0.1 ? "\t" : "";
  while (out.length < target) {
    out += PARTS[Math.floor(r() * PARTS.length)] ?? "";
    const x = r();
    out += x < 0.1 ? "\n" : x < 0.14 ? "\r\n" : x < 0.22 ? "\t" : r() < 0.3 ? ". " : " ";
  }
  return out;
}

/** 줄바꿈·탭 모양 여러 가지. 원소 하나가 run 하나의 내용이다(run이 여럿이면 글자모양 0·1을 번갈아 쓴다). */
const SHAPES: string[][] = [
  [t(`가${LB}`)],
  [t(`${TAB}나`)],
  [t(`가${LB}나${TAB}다`)],
  [t(`${LB}${LB}`)],
  [t("평범한 글")],
  [t(`a&amp;b${LB}c`)],
  [t(`x${LB}y${LB}z${TAB}w`)],
  [t(`처음`) + t(`${LB}둘째`)],
  [""],
  [t("")],
  [t(`<![CDATA[가<>]]>${LB}나`)],
  [t(`앞${LB}`), t(`뒤${LB}`)],
  [t("글"), t(`${LB}${TAB}`)],
  [t(`${TAB}`), t("가"), t(`나${LB}${TAB}`)],
];
const paraRuns = (runs: string[]): string =>
  `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs.map((r, i) => `<hp:run charPrIDRef="${i % 2}">${r}</hp:run>`).join("")}</hp:p>`;
const shape = (i: number): string => paraRuns(SHAPES[i % SHAPES.length] ?? [""]);
const BODY_PLACES = 22;
const KEYS = 12;
/**
 * 머리말 문단 2·본문 문단 22·표 둘(3×3, 2×3: 둘째 표는 칸마다 문단 둘이고 둘째 문단에도 줄바꿈·탭이 든다)의 칸 15 = 자리 39. 고정 문단 2개는 채우지 않는다.
 * 경로는 k0~k11을 돌려 쓴다(같은 경로 여러 곳).
 */
const BIG = (() => {
  const header =
    `<hp:ctrl><hp:header id="1" applyPageType="BOTH"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="42520" textHeight="4252" hasTextRef="0" hasNumRef="0">` +
    `${para(t(`머리 글${LB}`))}${paraRuns([t("머리"), t(`${TAB}둘째${LB}`)])}</hp:subList></hp:header></hp:ctrl><hp:t/>`;
  const body = Array.from({ length: BODY_PLACES }, (_, i) => shape(i));
  const t0 = gridTable([3000, 3000, 3000], 3).cells.map((c, i) => cellOf(c.row, c.col, [shape(i + 3)]));
  const t1 = gridTable([3000, 3000, 3000], 2).cells.map((c, i) => cellOf(c.row, c.col, [shape(i + 5), i % 2 === 0 ? para(t(`나머지${LB}${i}${TAB}`)) : paraRuns([t(`나머지 ${i}`), t(LB)])]));
  return buildHwpx([
    para(header) + para(t(`고정 글${LB}둘째`)) + body.join("") + tableDoc(t0, 3, 3, "1001") + para(t(`고정${TAB}글`)) + tableDoc(t1, 2, 3, "1002"),
  ]);
})();

type BigPlace = { kind: "line"; path: number[]; key: string } | { kind: "cell"; ordinal: number; row: number; col: number; key: string };
const BIG_DOC = reparse(BIG);
const BIG_PLACES: BigPlace[] = [
  ...[[0, 0, 0], [0, 0, 1], ...Array.from({ length: BODY_PLACES }, (_, i) => [i + 2])].map((path, i): BigPlace => ({ kind: "line", path, key: `k${i % KEYS}` })),
  ...[0, 1].flatMap((ordinal) =>
    Array.from({ length: ordinal === 0 ? 9 : 6 }, (_, i): BigPlace => ({ kind: "cell", ordinal, row: Math.floor(i / 3), col: i % 3, key: `k${(i + ordinal * 9 + BODY_PLACES + 2) % KEYS}` })),
  ),
];
const BIG_TEMPLATE = tpl({
  anchors: BIG_PLACES.map((p, i) => (p.kind === "line" ? lineAnchor(`a${i}`, at(BIG_DOC, p.path)) : cellAnchor(`a${i}`, p.ordinal, p.row, p.col))),
  rules: BIG_PLACES.map((p, i) => fillRule(`r${i}`, `a${i}`, { path: p.key })),
});
/** 채우지 않는 문단(머리말을 담은 문단, 고정 문단 둘, 표를 담은 문단 둘)의 경로 */
const FIXED_PATHS = [[0], [1], [BODY_PLACES + 2], [BODY_PLACES + 3], [BODY_PLACES + 4]];

test("많은 자리: 머리말·본문·표 칸 39곳(같은 경로 여러 곳, run 여럿·셀 나머지 문단 포함)을 줄바꿈·탭·특수문자가 든 긴 값으로 무작위 50건 채운다 — 자리마다 글이 값과 정확히 같고 값에 없는 줄바꿈·탭 요소 0, 셀 나머지 문단은 빈 글, 나머지는 그대로·게이트·검사기 새 오류 0·결정성", () => {
  assert.equal(BIG_PLACES.length, 39);
  const placeBefore = BIG_PLACES.filter((p) => p.kind === "line").map((p) => at(BIG_DOC, p.path));
  assert.ok(placeBefore.filter((x) => /[\n\t]/.test(x.logicalText)).length >= 15, "줄바꿈·탭이 든 자리가 충분하다");
  assert.ok(placeBefore.filter((x) => x.runs.length > 1 && /[\n\t]/.test(x.logicalText)).length >= 4, "run이 여럿인 줄바꿈·탭 자리가 있다");
  const restBefore = BIG_PLACES.flatMap((p) => (p.kind === "cell" ? cellParagraphs(BIG_DOC, p.ordinal, p.row, p.col).slice(1) : []));
  assert.ok(restBefore.length === 6 && restBefore.every((q) => /[\n\t]/.test(q.logicalText)), "셀 나머지 문단에도 줄바꿈·탭이 있다");
  const fixedBefore = FIXED_PATHS.map((p) => at(BIG_DOC, p).logicalText);
  const baseErrors = validateDocument(BIG);
  let longValues = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const r = rng(seed);
    const data = Object.fromEntries(Array.from({ length: KEYS }, (_, i) => [`k${i}`, valueOf(r, r() < 0.3 ? 20 : 600)]));
    longValues += Object.values(data).filter((v) => v.length >= 200).length;
    const g = done(generate(BIG, BIG_TEMPLATE, ds(data)));
    const out = reparse(g.output);
    for (const p of BIG_PLACES) {
      const v = norm(data[p.key] ?? "");
      const [first, ...rest] = p.kind === "line" ? [at(out, p.path)] : cellParagraphs(out, p.ordinal, p.row, p.col);
      assert.ok(first !== undefined);
      const where = `seed ${seed} ${p.kind} ${p.kind === "line" ? p.path.join(".") : `${p.ordinal}:${p.row},${p.col}`}`;
      assert.equal(first.logicalText, v, `${where}: 글이 값과 같다`);
      assert.equal(breaks(xmlOf(out, first)), occurrences(v, "\n"), `${where}: 줄바꿈 요소 수`);
      assert.equal(tabs(xmlOf(out, first)), occurrences(v, "\t"), `${where}: 탭 요소 수`);
      assert.deepEqual(rest.map((q) => q.logicalText), rest.map(() => ""), `${where}: 셀의 나머지 문단은 비었다`);
      assert.equal(rest.reduce((n, q) => n + breaks(xmlOf(out, q)) + tabs(xmlOf(out, q)), 0), 0, `${where}: 셀 나머지 문단의 줄바꿈·탭 요소 0`);
    }
    assert.deepEqual(FIXED_PATHS.map((p) => at(out, p).logicalText), fixedBefore, `seed ${seed}: 채우지 않은 문단은 그대로`);
    assert.equal(g.report.plan.actions.reduce((n, a) => n + a.targets, 0), 39);
    assert.deepEqual(newErrorsAfter(baseErrors, validateDocument(g.output)), [], `seed ${seed}: 검사기 새 오류 없음`);
    assert.ok(Buffer.from(done(generate(BIG, BIG_TEMPLATE, ds(data))).output).equals(Buffer.from(g.output)), `seed ${seed}: 같은 입력은 같은 바이트`);
  }
  assert.ok(longValues >= 100, `긴 값(200자 이상)이 충분히 들었다: ${longValues}`);
});

test("한컴 서식: 셀 채움 정답(hancom/ph-table)의 빈 칸 채움은 바뀌지 않는다", () => {
  const bytes = readFixture("hancom/ph-table");
  const r = done(generate(bytes, tpl({ anchors: [cellAnchor("c", 0, 1, 1)], rules: [fillRule("r", "c", { text: "줄1\n줄2\t끝" })] }), ds({ applicant: { name: "홍" }, note: "비" })));
  const table = reparse(r.output).sections[0]?.paragraphs[1]?.objects[0];
  assert.ok(table !== undefined && isTableNode(table));
  assert.deepEqual(table.cells.map((c) => c.subList?.paragraphs[0]?.logicalText), ["성명", "홍", "연락처", "줄1\n줄2\t끝", "비고", "비"]);
});
