// 과업 C: 여러 문단에 걸친 누름틀(crossParagraph)과 인라인 요소(탭·줄바꿈)가 든 누름틀(inline)을 한컴 방식으로 채운다.
// 기대값은 과업 명세(C1~C4)와 한컴이 직접 채워 저장한 전·후 문서(fixtures/span)에서 만들었다:
//  - 시작 표식 뒤부터 끝 표식 앞까지가 한 구간이다. 여러 문단에 걸치면 첫 문단에 값이 들어가고 사이 문단(표가 든 문단 포함)과 끝 문단의 앞부분은 사라지며,
//    끝 표식 뒤의 글은 첫 문단에 이어 붙는다. 첫 문단의 문단 속성은 그대로다. 탭·줄바꿈 요소는 옛 값의 일부로 보고 통째로 바꾼다.
//  - 그림·표 같은 객체가 든 누름틀(object)과 다른 칸·구역에 끝 표식이 있는 누름틀(crossContainer)은 건드리지 않는다.
//  - 지워지는 부분(시작 문단 꼬리·끝 문단 머리 포함)의 표·쪽 번호·책갈피는 한컴처럼 함께 지운다(독립 검증이 한컴 COM으로 확인). 짝이 끊기는 필드와 형광펜·변경 추적 표식만 건너뛴다.
//  - 구간 안을 가리키는 명시 규칙은 규칙 순서와 무관하게 TPL_CONFLICT다(dropped는 암묵 채움에만).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  censusOfDoc,
  collectFields,
  draftAnchors,
  emptyTemplate,
  extractFragment,
  fieldFillBlock,
  generate,
  generateBatch,
  listFields,
  makeLineAnchor,
  makeWordAnchor,
  readDataset,
  readTemplate,
  serializeFragment,
  validateDocument,
  walkParagraphs,
  type BatchItem,
  type GenerateOptions,
  type GenerateResult,
  type HwpxDocument,
  type Template,
} from "../src/index.ts";
import { MINIMAL_HEADER, buildHwpx, mutateEntryText, newErrorsAfter, readFixture, reparse } from "./helpers.ts";
import { lineSeg, sectionText, tableXml, type TableSpec } from "./table-helpers.ts";

const SEC = "Contents/section0.xml";
const OBJ = "￼";

type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;
const done = (r: GenerateResult): Done => {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  assert.ok(!r.dryRun);
  return r as Done;
};
const failedCodes = (r: GenerateResult): string[] => {
  assert.equal(r.ok, false, "생성이 성공해 버렸다");
  assert.ok(!("output" in r), "실패인데 출력이 있다");
  return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
};
const ds = (data: unknown) => readDataset(data);
const tpl = (spec: { anchors?: unknown[]; rules?: unknown[] }): Template => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const fillRule = (id: string, anchor: string, value: unknown) => ({ id, do: { type: "fill", anchor, value } });
const nameTemplate = (value: string, name = "성명"): Template => tpl({ anchors: [{ id: "a", kind: "field", name }], rules: [fillRule("r", "a", { text: value })] });
const run = (bytes: Uint8Array, data: unknown, options: GenerateOptions = {}): GenerateResult => generate(bytes, emptyTemplate(), ds(data), options);

const allParagraphs = (doc: HwpxDocument) => doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)]);
const texts = (doc: HwpxDocument): string[] => allParagraphs(doc).map((p) => p.logicalText);
/** 구역 바로 아래 문단 */
const topTexts = (doc: HwpxDocument): string[] => (doc.sections[0]?.paragraphs ?? []).map((p) => p.logicalText);
const plain = (s: string): string => s.replaceAll(OBJ, "");
const fieldsOf = (doc: HwpxDocument) => listFields(doc).map((f) => [f.name, f.valueText, f.dirty, f.shape]);
const merged = (r: GenerateResult) => r.report.issues.filter((i) => i.code === "FIELD_PARAGRAPHS_MERGED");
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

// ── 합성 문서 ───────────────────────────────────────────────────

/** 문단 속성 1·스타일 1이 더 있는 머리 */
const HEADER2 = MINIMAL_HEADER.replace(
  "</hh:paraPr></hh:paraProperties>",
  '</hh:paraPr><hh:paraPr id="1"><hh:heading type="NONE" idRef="0" level="0"/><hh:border borderFillIDRef="1"/></hh:paraPr></hh:paraProperties>',
)
  .replace('<hh:paraProperties itemCnt="1">', '<hh:paraProperties itemCnt="2">')
  .replace("</hh:styles>", '<hh:style id="1" type="PARA" name="m" paraPrIDRef="1" charPrIDRef="0" nextStyleIDRef="1"/></hh:styles>')
  .replace('<hh:styles itemCnt="1">', '<hh:styles itemCnt="2">');

const t = (s: string): string => `<hp:t>${s}</hp:t>`;
const begin = (name: string, id: string, dirty = "1"): string =>
  `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="${dirty}" zorder="-1" fieldid="${id}9" metaTag=""/></hp:ctrl>`;
const end = (id: string): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}9"/></hp:ctrl>`;
type ParaOptions = { paraPr?: string; style?: string; charPr?: string; seg?: boolean };
/** 문단 하나(run 하나). `seg`면 줄 배치 캐시를 단다. */
const para = (id: string, inner: string, o: ParaOptions = {}): string =>
  `<hp:p id="${id}" paraPrIDRef="${o.paraPr ?? "0"}" styleIDRef="${o.style ?? "0"}"><hp:run charPrIDRef="${o.charPr ?? "0"}">${inner}</hp:run>${o.seg === true ? lineSeg : ""}</hp:p>`;
const table = (cells: TableSpec["cells"], id = "7001"): string => tableXml({ id, rowCnt: 1, colCnt: cells.length, cells });
const cell = (col: number, paragraphs: string[]) => ({ row: 0, col, width: 3000, height: 500, paragraphs });
const doc = (...body: string[]): Uint8Array => buildHwpx([body.join("")], HEADER2);
const PAGE_NUM = `<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>`;

/** 본문에서 네 문단에 걸친 누름틀: 사이에 일반 문단 하나와 표가 든 문단 하나, 끝 문단에 끝 표식 뒤 글. 시작 문단은 문단 속성 1·스타일 1, dirty 0(안내문 상태). */
const CROSS = doc(
  para("1", t("앞 문단")),
  para("2", t("성명: ") + begin("성명", "501", "0") + t("안내1"), { paraPr: "1", style: "1", seg: true }),
  para("3", t("안내2"), { seg: true }),
  para("4", table([cell(0, [para("41", t("칸"))])]) + t(""), { seg: true }),
  para("5", t("안내3") + end("501") + t(" 끝 뒤 글"), { seg: true }),
  para("6", t("뒤 문단")),
);

// ── 모양 분류 ───────────────────────────────────────────────────

test("C1 listFields: 모양 — simple·empty·inline·object·crossParagraph·crossContainer·unpaired, 끝 문단 경로(endPath)는 끝이 다른 문단에 있을 때만", () => {
  const shapes = (bytes: Uint8Array) => listFields(reparse(bytes)).map((f) => [f.name, f.shape, f.endPath]);
  const one = (name: string, id: string, inner: string) => para(`p${id}`, begin(name, id) + inner + end(id));
  assert.deepEqual(shapes(doc(one("a", "1", t("값")), one("b", "2", ""), one("c", "3", `<hp:t>가<hp:tab width="0" leader="0" type="1"/>나</hp:t>`))), [
    ["a", "simple", undefined],
    ["b", "empty", undefined],
    ["c", "inline", undefined],
  ]);
  // 사이에 표·컨트롤이 있으면 object(탭·줄바꿈 같은 인라인 조각만 있는 inline과 다르다)
  const withTable = para("t1", begin("d", "4") + t("앞") + table([cell(0, [para("t11", t("칸"))])]) + t("뒤") + end("4"));
  const withCtrl = para("t2", begin("e", "5") + PAGE_NUM + end("5"));
  assert.deepEqual(shapes(doc(withTable, withCtrl)), [["d", "object", undefined], ["e", "object", undefined]]);
  // 끝 표식이 같은 목록의 다른 문단: crossParagraph(사이 문단이 표를 가져도 같은 목록의 형제다)
  assert.deepEqual(shapes(CROSS), [["성명", "crossParagraph", [4]]]);
  // 시작은 표 칸 안, 끝은 표 밖이거나 다른 칸: crossContainer
  const inCell = doc(para("c1", table([cell(0, [para("c11", begin("f", "6") + t("값"))]), cell(1, [para("c12", end("6"))])])));
  assert.deepEqual(shapes(inCell), [["f", "crossContainer", [0, 1, 0]]]);
  const toOutside = doc(para("c2", table([cell(0, [para("c21", begin("g", "7") + t("값"))])])), para("c3", end("7")));
  assert.deepEqual(shapes(toOutside), [["g", "crossContainer", [1]]]);
  // 끝 표식이 없다
  assert.deepEqual(shapes(doc(para("u1", begin("h", "8") + t("값")))), [["h", "unpaired", undefined]]);
});

test("C1 collectFields: 끝 표식을 담은 문단(endParagraph)과 끝 표식 — 한 문단 안은 시작 문단, 여러 문단은 끝 문단, 다른 컨테이너·짝 없음은 null", () => {
  const cross = collectFields(reparse(CROSS))[0];
  assert.deepEqual(cross?.endParagraph?.path, [4]);
  assert.equal(cross?.end?.beginIDRef, cross?.begin.id);
  assert.equal(cross?.endParagraph?.pieces[cross.end?.pieceIndex ?? -1]?.kind, "object");
  const same = collectFields(reparse(doc(para("1", begin("a", "1") + t("x") + end("1")))))[0];
  assert.ok(same !== undefined && same.endParagraph === same.paragraph && same.end !== null);
  const split = collectFields(reparse(doc(para("c2", table([cell(0, [para("c21", begin("g", "7") + t("값"))])])), para("c3", end("7")))))[0];
  assert.deepEqual([split?.endParagraph, split?.end], [null, null]);
  const lone = collectFields(reparse(doc(para("u1", begin("h", "8") + t("값")))))[0];
  assert.deepEqual([lone?.endParagraph, lone?.end], [null, null]);
});

// ── 같은 문단 안 inline ─────────────────────────────────────────

test("C4-1 inline(줄바꿈·탭이 든 누름틀): 값으로 채우면 simple이 되고 문단 수는 같다. 줄바꿈이 든 값으로 다시 채워도(여러 번) 성공한다", () => {
  const bytes = readFixture("inline/inline-breaks");
  const before = reparse(bytes);
  assert.deepEqual(fieldsOf(before).map((f) => [f[0], f[3]]), [["줄", "inline"], ["탭", "inline"]]);
  const r = done(run(bytes, { 줄: "x", 탭: "x" }));
  const after = reparse(r.output);
  assert.deepEqual(fieldsOf(after), [["줄", "x", "1", "simple"], ["탭", "x", "1", "simple"]]);
  assert.equal(allParagraphs(after).length, allParagraphs(before).length, "문단 수 같음");
  assert.equal(r.report.reread.fields, 2);
  assert.equal(merged(r).length, 0, "같은 문단 안 inline은 경고가 없다");
  assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), []);
  // 다른 문단(첫 줄/둘째 줄, 가 탭 나, 표 칸의 줄바꿈)은 그대로다
  const others = (d: HwpxDocument): string[] => texts(d).filter((x) => !x.startsWith("누름틀:"));
  assert.deepEqual(others(after), others(before));
  // 줄바꿈·탭이 든 값으로 채우고 또 채운다
  let current = bytes;
  for (const [a, b] of [["첫\n둘", "가\t나"], ["x\ny\nz", "탭\t탭\t탭"], ["다시", "또"], ["a\r\nb", "c"]] as const) {
    const g = done(run(current, { 줄: a, 탭: b }));
    const read = fieldsOf(reparse(g.output));
    assert.deepEqual(read.map((f) => f[1]), [a.replace(/\r\n?/g, "\n"), b], JSON.stringify([a, b]));
    assert.equal(allParagraphs(reparse(g.output)).length, allParagraphs(before).length);
    assert.equal(g.report.plan.skipped.length, 0);
    current = g.output;
  }
  // 값의 줄바꿈은 요소로, 안에 있던 옛 줄바꿈 요소는 사라진다
  assert.match(sectionText(done(run(bytes, { 줄: "a\nb", 탭: "c" })).output), /<hp:t>a<hp:lineBreak\/>b<\/hp:t><hp:ctrl><hp:fieldEnd/);
});

// ── 여러 문단에 걸친 누름틀 ──────────────────────────────────────

test("C4-2 crossParagraph(본문): 사이 문단·끝 문단이 사라지고 끝 표식 뒤 글이 첫 문단에 이어 붙는다 — 문단 수·글·문단 속성·표 수·값·dirty·경고·결정성", () => {
  const before = reparse(CROSS);
  assert.equal(before.sections[0]?.paragraphs.length, 6);
  const r = done(run(CROSS, { 성명: "홍길동" }));
  const after = reparse(r.output);
  // 문단 수: 사이 문단 2개 + 끝 문단 1개가 줄었다
  assert.equal(after.sections[0]?.paragraphs.length, 3);
  assert.deepEqual(topTexts(after).map(plain), ["앞 문단", "성명: 홍길동 끝 뒤 글", "뒤 문단"]);
  // 합친 문단의 글 = 시작 문단의 표식 앞 글 + 값 + 끝 문단의 표식 뒤 글(표식 자리는 객체 글자)
  assert.equal(after.sections[0]?.paragraphs[1]?.logicalText, `성명: ${OBJ}홍길동${OBJ} 끝 뒤 글`);
  // 첫 문단의 문단 속성·스타일·id 유지
  assert.deepEqual(after.sections[0]?.paragraphs[1]?.attrs, { paraPrIDRef: "1", styleIDRef: "1", id: "2" });
  // 표 수 1 감소, 수량 예고(문단·표·표 행·셀)는 게이트가 확인한다
  assert.deepEqual([censusOfDoc(before).tables, censusOfDoc(after).tables], [1, 0]);
  assert.deepEqual(r.report.plan.expected, { paragraphs: -4, tables: -1, tableRows: -1, tableCells: -1 });
  // 값 재읽기: 같은 문단 안 simple, dirty 1(안내문 상태 0이었다), 값 일치
  assert.deepEqual(fieldsOf(after), [["성명", "홍길동", "1", "simple"]]);
  assert.deepEqual([r.report.reread.fields, r.report.reread.paragraphs], [1, 1]);
  // 경고 한 건, 수치(걸친 문단 4개, 사이 문단 2개, 표 1개)
  assert.deepEqual(merged(r).map((i) => [i.severity, i.message, i.where]), [
    ["warning", "누름틀 성명이 걸친 문단 4개를 합쳤고 사이의 문단 2개를 지웠습니다(그 안의 표 1개 포함).", "field:성명"],
  ]);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.type, a.anchor, a.targets]), [["implicit", "fill", "field:성명", 1]]);
  // 줄 배치 캐시가 남지 않고(합친 문단의 것도 낡아서 지운다), 검사기 새 오류는 0
  const xml = sectionText(r.output);
  assert.ok(!xml.includes("<hp:linesegarray>"));
  assert.deepEqual(newErrorsAfter(validateDocument(CROSS), validateDocument(r.output)), []);
  // 결정성
  assert.ok(bytesEqual(done(run(CROSS, { 성명: "홍길동" })).output, r.output), "같은 입력은 같은 바이트");
  // 한컴이 저장한 모양과 같다: 시작 run 안에 시작 컨트롤, 값, 끝 컨트롤, 끝 뒤 글
  assert.match(xml, /<hp:t>성명: <\/hp:t><hp:ctrl><hp:fieldBegin [^>]*dirty="1"[^>]*\/><\/hp:ctrl><hp:t>홍길동<\/hp:t><hp:ctrl><hp:fieldEnd [^>]*\/><\/hp:ctrl><hp:t> 끝 뒤 글<\/hp:t><\/hp:run><\/hp:p>/);
  // 값 원문은 보고서·원장에 없다
  assert.ok(!JSON.stringify({ report: r.report, ledger: r.ledger }).includes("홍길동"));
});

test("C4-2 crossParagraph: 명시 규칙(field 앵커)도 같은 결과이고, 값에 줄바꿈이 들면 합친 문단 안 inline이 되어 다시 채울 수 있다", () => {
  const implicit = done(run(CROSS, { 성명: "홍길동" }));
  const explicit = done(generate(CROSS, nameTemplate("홍길동"), ds({})));
  assert.ok(bytesEqual(explicit.output, implicit.output), "명시 규칙 = 암묵 채움");
  assert.deepEqual(merged(explicit).map((i) => i.where), ["r"]);
  const multi = done(run(CROSS, { 성명: "가\n나" }));
  assert.deepEqual(fieldsOf(reparse(multi.output)), [["성명", "가\n나", "1", "inline"]]);
  assert.deepEqual(topTexts(reparse(multi.output)).map(plain), ["앞 문단", "성명: 가\n나 끝 뒤 글", "뒤 문단"]);
  const again = done(run(multi.output, { 성명: "다시" }));
  assert.deepEqual(fieldsOf(reparse(again.output)), [["성명", "다시", "1", "simple"]]);
  assert.equal(merged(again).length, 0, "합친 뒤 같은 문단 안이라 경고가 없다");
});

test("C4-2 crossParagraph: 끝 run의 글자모양이 시작 run과 다르면 끝 표식 뒤 글이 제 글자모양을 지킨다", () => {
  const bytes = doc(
    para("1", t("앞")),
    para("2", t("성명: ") + begin("성명", "501") + t("안내1")),
    para("3", t("안내2") + end("501") + t(" 끝 뒤 글"), { charPr: "1" }),
  );
  const after = reparse(done(run(bytes, { 성명: "값" })).output);
  const p = after.sections[0]?.paragraphs[1];
  assert.equal(p?.logicalText, `성명: ${OBJ}값${OBJ} 끝 뒤 글`);
  const charOf = (needle: string): string | null | undefined => {
    const piece = p?.pieces.find((x) => x.kind === "text" && p.logicalText.slice(x.logicalStart, x.logicalEnd).includes(needle));
    return piece === undefined ? undefined : p?.runs[piece.runOrdinal]?.charPrIDRef;
  };
  assert.deepEqual([charOf("성명:"), charOf("값"), charOf("끝 뒤 글")], ["0", "0", "1"]);
  assert.deepEqual(fieldsOf(after), [["성명", "값", "1", "simple"]]);
});

test("C4-3 표 칸 안에서 두 문단 이상에 걸친 누름틀(같은 subList): 채워지고 칸의 문단 수만 줄며 표 수·옆 칸은 그대로다", () => {
  const spanning = (cellParagraphs: string[]) =>
    doc(para("1", t("표 앞")), para("2", table([cell(0, cellParagraphs), cell(1, [para("22", t("옆 칸"))])]) + t("")), para("3", t("표 뒤")));
  // 두 문단
  const two = spanning([para("21", t("칸: ") + begin("칸", "601") + t("칸 첫 문단")), para("23", t("칸 둘째 문단") + end("601") + t(" 뒤"))]);
  assert.deepEqual(listFields(reparse(two)).map((f) => [f.shape, f.path, f.endPath]), [["crossParagraph", [1, 0, 0], [1, 0, 1]]]);
  const a = done(run(two, { 칸: "새 칸 값" }));
  const after = reparse(a.output);
  assert.deepEqual(allParagraphs(after).map((p) => plain(p.logicalText)), ["표 앞", "", "칸: 새 칸 값 뒤", "옆 칸", "표 뒤"]);
  assert.equal(allParagraphs(reparse(two)).length - allParagraphs(after).length, 1, "칸의 문단 수 1 감소");
  assert.deepEqual([censusOfDoc(reparse(two)).tables, censusOfDoc(after).tables], [1, 1]);
  assert.deepEqual(merged(a).map((i) => i.message), ["누름틀 칸이 걸친 문단 2개를 합쳤고 사이의 문단 0개를 지웠습니다(그 안의 표 0개 포함)."]);
  assert.deepEqual(fieldsOf(after), [["칸", "새 칸 값", "1", "simple"]]);
  // 세 문단(사이 문단 하나)
  const three = spanning([para("21", t("칸: ") + begin("칸", "601") + t("첫")), para("24", t("가운데")), para("23", t("끝") + end("601") + t(" 뒤"))]);
  const b = done(run(three, { 칸: "값" }));
  assert.deepEqual(allParagraphs(reparse(b.output)).map((p) => plain(p.logicalText)), ["표 앞", "", "칸: 값 뒤", "옆 칸", "표 뒤"]);
  assert.equal(allParagraphs(reparse(three)).length - allParagraphs(reparse(b.output)).length, 2);
  assert.deepEqual(merged(b).map((i) => i.message), ["누름틀 칸이 걸친 문단 3개를 합쳤고 사이의 문단 1개를 지웠습니다(그 안의 표 0개 포함)."]);
});

// ── 채우지 않는 모양 ────────────────────────────────────────────

test("C4-4 crossContainer(시작은 칸 안, 끝은 표 밖 또는 다른 칸): FIELD_UNSUPPORTED_SHAPE로 건너뛰고 문서는 그대로다", () => {
  const other = para("3", t("소속 ") + begin("소속", "602") + t("옛") + end("602"));
  const toOutside = (withOther: boolean) =>
    doc(para("1", table([cell(0, [para("11", t("칸: ") + begin("성명", "601") + t("값"))])]) + t("")), para("2", t("끝") + end("601") + t("뒤")), ...(withOther ? [other] : []));
  const toOtherCell = (withOther: boolean) =>
    doc(para("1", table([cell(0, [para("11", begin("성명", "601") + t("값"))]), cell(1, [para("12", end("601"))])]) + t("")), ...(withOther ? [other] : []));
  for (const build of [toOutside, toOtherCell]) {
    const bytes = build(true);
    const before = reparse(bytes);
    assert.equal(listFields(before)[0]?.shape, "crossContainer");
    const r = done(run(bytes, { 성명: "새 값", 소속: "새 소속" }));
    assert.deepEqual(r.report.plan.skipped.map((s) => [s.code, s.anchor]), [["FIELD_UNSUPPORTED_SHAPE", "field:성명"]]);
    const after = reparse(r.output);
    assert.deepEqual(texts(after), texts(before).map((x) => x.replace("옛", "새 소속")), "건너뛴 누름틀의 문단은 그대로");
    assert.deepEqual(listFields(after).map((f) => [f.name, f.shape, f.valueText]), [["성명", "crossContainer", ""], ["소속", "simple", "새 소속"]]);
    assert.equal(merged(r).length, 0);
    // 이 누름틀뿐이면 채울 자리가 없어 실패하고 출력이 없다(원본 그대로). 명시 규칙이면 오류다
    const only = build(false);
    assert.deepEqual(failedCodes(run(only, { 성명: "x" })), ["FILL_NOTHING_APPLIED"]);
    assert.deepEqual(failedCodes(generate(only, nameTemplate("x"), ds({}))), ["FIELD_UNSUPPORTED_SHAPE"]);
  }
});

test("C4-5 object(사이에 표·컨트롤이 같은 문단 안에 있음): 건너뛰고 문서는 그대로다", () => {
  const withTable = para("1", begin("성명", "601") + t("앞") + table([cell(0, [para("11", t("칸"))])]) + t("뒤") + end("601"));
  const withCtrl = para("2", begin("소속", "602") + PAGE_NUM + t("글") + end("602"));
  const simple = para("3", begin("이름", "603") + t("옛") + end("603"));
  const bytes = doc(withTable, withCtrl, simple);
  assert.deepEqual(listFields(reparse(bytes)).map((f) => f.shape), ["object", "object", "simple"]);
  const r = done(run(bytes, { 성명: "a", 소속: "b", 이름: "c" }));
  assert.deepEqual(r.report.plan.skipped.map((s) => [s.code, s.anchor]), [["FIELD_UNSUPPORTED_SHAPE", "field:성명"], ["FIELD_UNSUPPORTED_SHAPE", "field:소속"]]);
  const after = reparse(r.output);
  assert.deepEqual(texts(after), texts(reparse(bytes)).map((x) => x.replace("옛", "c")));
  assert.deepEqual(censusOfDoc(after), censusOfDoc(reparse(bytes)), "표 수 불변");
  // 이 누름틀뿐이면 채운 자리가 없어 실패하고, 명시 규칙은 오류다
  const only = doc(withTable);
  assert.deepEqual(failedCodes(generate(only, nameTemplate("x"), ds({}))), ["FIELD_UNSUPPORTED_SHAPE"]);
  assert.deepEqual(failedCodes(run(only, { 성명: "x" })), ["FILL_NOTHING_APPLIED"]);
});

// ── 건너뛰는 조건: 구역 설정·끊기는 필드 짝, 함께 사라지는 것 ────────────────

const SPAN = readFixture("span/field-span");
const secPrOf = (bytes: Uint8Array): string => /<hp:secPr[\s\S]*?<\/hp:secPr>/.exec(sectionText(bytes))?.[0] ?? "";
const targetOf = (bytes: Uint8Array, name = "성명") => {
  const found = collectFields(reparse(bytes)).find((f) => f.info.name === name);
  assert.ok(found !== undefined, `누름틀 ${name}이 없다`);
  return found;
};

test("C4-6 사이 문단·끝 문단에 구역 설정(secPr)이 있으면 건너뛴다(시작 문단의 secPr는 상관없다)", () => {
  const secPr = secPrOf(SPAN);
  assert.ok(secPr.length > 100);
  for (const [label, from, to] of [
    ["사이 문단", "<hp:t>가운데 문단</hp:t>", `${secPr}<hp:t>가운데 문단</hp:t>`],
    ["끝 문단", "<hp:t>끝 문단</hp:t>", `${secPr}<hp:t>끝 문단</hp:t>`],
  ] as const) {
    const bytes = mutateEntryText(SPAN, SEC, (x) => x.replace(from, to));
    const target = targetOf(bytes);
    assert.equal(target.info.shape, "crossParagraph", label);
    assert.equal(fieldFillBlock(target)?.code, "FIELD_UNSUPPORTED_SHAPE", label);
    assert.match(fieldFillBlock(target)?.message ?? "", /구역 설정/, label);
    assert.deepEqual(failedCodes(run(bytes, { 성명: "x" })), ["FILL_NOTHING_APPLIED"], label);
    assert.deepEqual(failedCodes(generate(bytes, nameTemplate("x"), ds({}))), ["FIELD_UNSUPPORTED_SHAPE"], label);
  }
  // 시작 문단에 구역 설정이 있어도(표식 앞) 채운다
  const startWithSecPr = doc(
    `<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${secPr}</hp:run><hp:run charPrIDRef="0">${t("성명: ")}${begin("성명", "501")}${t("안내")}</hp:run></hp:p>`,
    para("2", t("끝") + end("501") + t(" 뒤")),
    para("3", t("뒤 문단")),
  );
  const r = done(run(startWithSecPr, { 성명: "값" }));
  assert.deepEqual(topTexts(reparse(r.output)).map(plain), ["성명: 값 뒤", "뒤 문단"]);
  assert.ok(secPrOf(r.output).length > 100, "구역 설정은 남는다");
});

test("C4-6 구간을 가로질러 짝이 끊기는 다른 필드가 있으면 건너뛴다. 구간 안에 통째로 든 다른 누름틀·책갈피는 함께 사라지고 dropped로 보고한다", () => {
  const middle = "<hp:t>가운데 문단</hp:t>";
  // 구간 안에서 시작하고 구간 밖(끝 표식 뒤)에서 끝난다
  const outward = mutateEntryText(SPAN, SEC, (x) => x.replace(middle, `${begin("소속", "7001")}${middle}`).replace("<hp:t> 끝 뒤 글</hp:t>", `<hp:t> 끝 뒤 글</hp:t>${end("7001")}`));
  assert.equal(fieldFillBlock(targetOf(outward))?.code, "FIELD_UNSUPPORTED_SHAPE");
  assert.match(fieldFillBlock(targetOf(outward))?.message ?? "", /필드/);
  assert.deepEqual(failedCodes(generate(outward, nameTemplate("x"), ds({}))), ["FIELD_UNSUPPORTED_SHAPE"]);
  // 구간 밖(시작 표식 앞)에서 시작해 구간 안에서 끝난다
  const inward = mutateEntryText(SPAN, SEC, (x) => x.replace("<hp:t>앞 문단</hp:t>", `<hp:t>앞 문단</hp:t>${begin("소속", "7002")}`).replace(middle, `${middle}${end("7002")}`));
  assert.deepEqual(failedCodes(generate(inward, nameTemplate("x"), ds({}))), ["FIELD_UNSUPPORTED_SHAPE"]);
  // 구간 안에 통째로 든 다른 누름틀(필드 짝이 구간 안에서 닫힌다)과 책갈피: 함께 사라지고 이름이 dropped에 나온다
  const inner = mutateEntryText(SPAN, SEC, (x) => x.replace(middle, `${begin("소속", "7003")}<hp:t>안쪽</hp:t>${end("7003")}<hp:ctrl><hp:bookmark name="북마크"/></hp:ctrl>${middle}`));
  assert.deepEqual(listFields(reparse(inner)).map((f) => f.name), ["성명", "소속"]);
  const r = done(run(inner, { 성명: "새 값", 소속: "소속값" }));
  assert.deepEqual(fieldsOf(reparse(r.output)), [["성명", "새 값", "1", "simple"]], "안쪽 누름틀이 사라졌다");
  assert.deepEqual(r.report.plan.dropped.map((d) => [d.ruleId, d.anchor]), [["implicit", "bookmark:북마크"], ["implicit", "field:소속"]]);
  assert.ok(!sectionText(r.output).includes("북마크") && !sectionText(r.output).includes("소속값"));
  assert.deepEqual(r.report.plan.expected, { paragraphs: -2, fieldPairs: -1, bookmarks: -1 }, "누름틀·책갈피도 수량 예고에 든다(게이트가 확인한다)");
  assert.deepEqual(r.report.plan.actions.map((a) => a.anchor), ["field:성명"], "안쪽 누름틀은 채운 자리가 아니다");
  assert.deepEqual(merged(r).map((i) => i.message), ["누름틀 성명이 걸친 문단 3개를 합쳤고 사이의 문단 1개를 지웠습니다(그 안의 표 0개 포함)."]);
  // 명시 규칙이 안쪽 누름틀을 가리키면 규칙 순서와 상관없이 TPL_CONFLICT다(바깥 규칙이 앞이든 뒤든 버리지 않는다)
  const anchors = [{ id: "a", kind: "field", name: "성명" }, { id: "b", kind: "field", name: "소속" }];
  const outer = fillRule("r1", "a", { text: "새 값" });
  const nested = fillRule("r2", "b", { text: "소속값" });
  for (const [label, rules] of [["바깥 규칙이 앞", [outer, nested]], ["바깥 규칙이 뒤", [nested, outer]]] as const) {
    const g = generate(inner, tpl({ anchors, rules: [...rules] }), ds({}));
    assert.deepEqual(failedCodes(g), ["TPL_CONFLICT"], label);
    assert.deepEqual(g.report.plan.dropped.filter((d) => d.ruleId === "r2"), [], `${label}: 버리지 않는다`);
  }
});

test("C4-7 사이 문단에 든 {{키}}는 dropped로 보고되고 결과에 남지 않는다. 시작 문단의 앞·끝 문단의 뒤 {{키}}는 채워진다", () => {
  const bytes = mutateEntryText(SPAN, SEC, (x) =>
    x.replace("<hp:t>가운데 문단</hp:t>", "<hp:t>가운데 {{키}} 문단</hp:t>").replace("<hp:t>성명: </hp:t>", "<hp:t>{{앞}} 성명: </hp:t>").replace("<hp:t> 끝 뒤 글</hp:t>", "<hp:t> 끝 뒤 {{뒤}}</hp:t>"),
  );
  const r = done(run(bytes, { 성명: "새 값", 키: "KEY", 앞: "A", 뒤: "Z" }));
  assert.deepEqual(r.report.plan.dropped.map((d) => [d.ruleId, d.anchor]), [["implicit", "{{키}}"]]);
  assert.deepEqual(topTexts(reparse(r.output)).map(plain), ["앞 문단", "A 성명: 새 값 끝 뒤 Z", "뒤 문단"]);
  assert.ok(!sectionText(r.output).includes("KEY") && !sectionText(r.output).includes("{{"));
  assert.deepEqual(r.report.plan.actions.map((a) => a.anchor).sort(), ["field:성명", "{{뒤}}", "{{앞}}"].sort());
  // 데이터에 키가 없어도 버려지는 자리라서 오류가 아니다(필요한 경로에도 오르지 않는다)
  const noKey = done(run(bytes, { 성명: "새 값", 앞: "A", 뒤: "Z" }));
  assert.deepEqual(noKey.report.plan.dropped.map((d) => d.anchor), ["{{키}}"]);
  assert.ok(!noKey.report.plan.requiredPaths.includes("키"));
});

test("C4-7 시작 문단의 표식 뒤나 끝 문단의 표식 앞(지워지는 부분)에 든 {{키}}도 dropped로 보고되고 결과에 남지 않는다. 구간 밖(시작 문단의 표식 앞, 끝 문단의 표식 뒤) {{키}}는 채워진다", () => {
  for (const [from, to] of [["<hp:t>첫 문단</hp:t>", "<hp:t>첫 {{키}} 문단</hp:t>"], ["<hp:t>끝 문단</hp:t>", "<hp:t>끝 {{키}} 문단</hp:t>"]] as const) {
    const bytes = mutateEntryText(SPAN, SEC, (x) => x.replace(from, to));
    const r = done(run(bytes, { 성명: "새 값", 키: "KEY" }));
    assert.deepEqual(r.report.plan.dropped.map((d) => [d.ruleId, d.anchor]), [["implicit", "{{키}}"]], from);
    assert.deepEqual(topTexts(reparse(r.output)).map(plain), ["앞 문단", "성명: 새 값 끝 뒤 글", "뒤 문단"], from);
    assert.ok(!sectionText(r.output).includes("KEY") && !sectionText(r.output).includes("{{"), from);
    assert.deepEqual(r.report.plan.actions.map((a) => a.anchor), ["field:성명"], from);
    // 데이터에 키가 없어도 버려지는 자리라서 오류가 아니다
    assert.deepEqual(done(run(bytes, { 성명: "새 값" })).report.plan.missingPaths, [], from);
  }
});

// ── 꼬리·머리의 개체: 한컴처럼 채우며 함께 지운다 ──────────────────────────

const bookmark = (name: string): string => `<hp:ctrl><hp:bookmark name="${name}"/></hp:ctrl>`;
/** 필드 시작 표식(`type`이 CLICK_HERE가 아니어도 된다) */
const fieldOpen = (type: string, name: string, id: string): string =>
  `<hp:ctrl><hp:fieldBegin id="${id}" type="${type}" name="${name}" editable="0" dirty="0" zorder="-1" fieldid="${id}9"/></hp:ctrl>`;
/** 필드 한 쌍. 이름이 빈 문자열인 하이퍼링크 같은 모양도 만든다. */
const pairField = (type: string, name: string, id: string, inner: string): string => fieldOpen(type, name, id) + inner + end(id);
const smallTable = (id: string, text: string): string => table([cell(0, [para(`${id}1`, t(text))])], id) + t("");
/** 시작 문단 꼬리(`startTail`)·끝 문단 머리(`endHead`)·끝 표식 뒤(`endTail`)에 개체를 둘 수 있는 문서: 앞 / 성명 시작 / 표가 든 사이 문단 / 끝 / 뒤 / 소속(simple) */
const tailDoc = (startTail: string, endHead: string, endTail = ""): Uint8Array =>
  doc(
    para("1", t("앞")),
    para("2", t("성명: ") + begin("성명", "501") + t("안내1") + startTail),
    para("3", table([cell(0, [para("31", t("칸"))])], "7101") + t("")),
    para("4", endHead + t("안내3") + end("501") + t(" 끝 뒤") + endTail),
    para("5", t("뒤 문단")),
    para("6", t("소속 ") + begin("소속", "502") + t("옛") + end("502")),
  );

test("L4 꼬리·머리의 표·쪽 번호·책갈피·중첩 필드는 한컴처럼 채우며 함께 지우고, 지운 수량(문단·표·표 행·셀·필드·책갈피)을 예고와 경고에 센다", () => {
  const BASE = { paragraphs: -3, tables: -1, tableRows: -1, tableCells: -1 };
  const WITH_TABLE = { paragraphs: -4, tables: -2, tableRows: -2, tableCells: -2 };
  type Case = { label: string; bytes: Uint8Array; expected: Record<string, number>; tables: number; dropped: [string, string][]; gone: string[] };
  const cases: Case[] = [
    // 실제 문서에서 채우기를 막던 원인 셋: 표(14곳), 쪽 번호(4곳), 중첩 필드 표식(5곳)
    { label: "시작 문단 꼬리의 표", bytes: tailDoc(smallTable("7102", "꼬리표"), ""), expected: WITH_TABLE, tables: 2, dropped: [], gone: ["꼬리표"] },
    { label: "끝 문단 머리의 표", bytes: tailDoc("", smallTable("7103", "머리표")), expected: WITH_TABLE, tables: 2, dropped: [], gone: ["머리표"] },
    { label: "시작 문단 꼬리의 쪽 번호", bytes: tailDoc(PAGE_NUM, ""), expected: BASE, tables: 1, dropped: [], gone: ["<hp:pageNum"] },
    { label: "끝 문단 머리의 쪽 번호", bytes: tailDoc("", PAGE_NUM), expected: BASE, tables: 1, dropped: [], gone: ["<hp:pageNum"] },
    { label: "끝 문단 머리의 중첩 누름틀", bytes: tailDoc("", pairField("CLICK_HERE", "내부", "509", t("안쪽"))), expected: { ...BASE, fieldPairs: -1 }, tables: 1, dropped: [["implicit", "field:내부"]], gone: ["안쪽"] },
    { label: "시작 문단 꼬리의 중첩 날짜 필드", bytes: tailDoc(pairField("DATE", "작성일", "510", t("2020")), ""), expected: { ...BASE, fieldPairs: -1 }, tables: 1, dropped: [["implicit", "field:작성일"]], gone: ["2020"] },
    { label: "끝 문단 머리의 이름 없는 하이퍼링크", bytes: tailDoc("", pairField("HYPERLINK", "", "511", t("링크"))), expected: { ...BASE, fieldPairs: -1 }, tables: 1, dropped: [["implicit", "field:HYPERLINK"]], gone: ["링크"] },
    { label: "시작 문단 꼬리의 책갈피", bytes: tailDoc(bookmark("꼬리책갈피"), ""), expected: { ...BASE, bookmarks: -1 }, tables: 1, dropped: [["implicit", "bookmark:꼬리책갈피"]], gone: ["꼬리책갈피"] },
  ];
  for (const c of cases) {
    assert.equal(listFields(reparse(c.bytes)).find((f) => f.name === "성명")?.shape, "crossParagraph", c.label);
    assert.equal(fieldFillBlock(targetOf(c.bytes)), undefined, `${c.label}: 채울 수 있다`);
    const r = done(run(c.bytes, { 성명: "값", 소속: "기관", 내부: "x" }));
    const after = reparse(r.output);
    // 한컴과 같은 결과: 값이 들어가고 사이 문단·개체가 사라진다
    assert.deepEqual(topTexts(after).map(plain), ["앞", "성명: 값 끝 뒤", "뒤 문단", "소속 기관"], c.label);
    assert.deepEqual(fieldsOf(after).filter((f) => f[0] === "성명"), [["성명", "값", "1", "simple"]], c.label);
    assert.equal(censusOfDoc(after).tables, 0, `${c.label}: 표 0`);
    for (const gone of c.gone) assert.ok(!sectionText(r.output).includes(gone), `${c.label}: ${gone}이(가) 사라졌다`);
    // 수량 예고(게이트가 확인한다), 경고 수치, 함께 지운 필드·책갈피 보고
    assert.deepEqual(r.report.plan.expected, c.expected, c.label);
    assert.deepEqual(merged(r).map((i) => i.message), [`누름틀 성명이 걸친 문단 3개를 합쳤고 사이의 문단 1개를 지웠습니다(그 안의 표 ${c.tables}개 포함).`], c.label);
    assert.deepEqual(r.report.plan.dropped.map((d) => [d.ruleId, d.anchor]), c.dropped, c.label);
    assert.deepEqual(newErrorsAfter(validateDocument(c.bytes), validateDocument(r.output)), [], c.label);
    // 명시 규칙도 같은 결과다
    const g = done(generate(c.bytes, nameTemplate("값"), ds({ 소속: "기관" })));
    assert.deepEqual(topTexts(reparse(g.output)).map(plain), ["앞", "성명: 값 끝 뒤", "뒤 문단", "소속 기관"], `${c.label}: 명시 규칙`);
  }
});

test("L4 구간을 가로질러 짝이 끊기는 필드는 꼬리·머리에 걸쳐도 지금처럼 건너뛴다(개체가 있다고 건너뛰지는 않는다)", () => {
  // 시작 문단 꼬리에서 시작한 필드가 끝 표식 뒤(구간 밖)에서 끝난다
  const outward = tailDoc(fieldOpen("DATE", "날짜", "512"), "", end("512"));
  assert.equal(fieldFillBlock(targetOf(outward))?.code, "FIELD_UNSUPPORTED_SHAPE");
  assert.match(fieldFillBlock(targetOf(outward))?.message ?? "", /필드/);
  assert.deepEqual(failedCodes(generate(outward, nameTemplate("x"), ds({ 소속: "기관" }))), ["FIELD_UNSUPPORTED_SHAPE"]);
  // 구간 밖(시작 표식 앞)에서 시작해 끝 문단 머리에서 끝난다
  const inward = doc(
    para("1", t("앞") + fieldOpen("DATE", "날짜", "513")),
    para("2", t("성명: ") + begin("성명", "501") + t("안내1")),
    para("3", end("513") + t("안내3") + end("501") + t(" 끝 뒤")),
  );
  assert.deepEqual(failedCodes(generate(inward, nameTemplate("x"), ds({}))), ["FIELD_UNSUPPORTED_SHAPE"]);
});

test("C4-8 빈 값(missing: empty): 구간을 지우기만 한다 — 문단은 합쳐지고 값은 없으며 dirty는 그대로, 모양은 empty", () => {
  const guide = mutateEntryText(SPAN, SEC, (x) => x.replace('dirty="1"', 'dirty="0"'));
  assert.equal(listFields(reparse(guide))[0]?.dirty, "0");
  const r = done(run(guide, {}, { missing: "empty" }));
  const after = reparse(r.output);
  assert.deepEqual(fieldsOf(after), [["성명", "", "0", "empty"]]);
  assert.deepEqual(topTexts(after).map(plain), ["앞 문단", "성명:  끝 뒤 글", "뒤 문단"]);
  assert.equal(merged(r).length, 1);
  assert.deepEqual(r.report.plan.missingPaths, ["성명"]);
  assert.match(sectionText(r.output), /<hp:fieldBegin [^>]*dirty="0"[^>]*>[\s\S]*?<\/hp:ctrl><hp:ctrl><hp:fieldEnd /);
  // 같은 문단 안 inline도 빈 값이면 값만 지운다
  const e = done(run(readFixture("inline/inline-breaks"), {}, { missing: "empty" }));
  assert.deepEqual(fieldsOf(reparse(e.output)).map((f) => [f[0], f[1], f[3]]), [["줄", "", "empty"], ["탭", "", "empty"]]);
  // keep이면 그대로 두므로 채운 자리가 없다
  assert.deepEqual(failedCodes(run(SPAN, {}, { missing: "keep" })), ["FILL_NOTHING_APPLIED"]);
});

test("C4-9 같은 이름의 누름틀 둘(simple 하나, crossParagraph 하나): 둘 다 같은 값으로 채워진다", () => {
  const bytes = mutateEntryText(SPAN, SEC, (x) => x.replace("<hp:t>뒤 문단</hp:t>", `${begin("성명", "801")}<hp:t>옛값</hp:t>${end("801")}`));
  assert.deepEqual(listFields(reparse(bytes)).map((f) => [f.name, f.occurrence, f.shape]), [["성명", 0, "crossParagraph"], ["성명", 1, "simple"]]);
  const r = done(run(bytes, { 성명: "새 값" }));
  assert.deepEqual(fieldsOf(reparse(r.output)), [["성명", "새 값", "1", "simple"], ["성명", "새 값", "1", "simple"]]);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.anchor, a.targets]), [["field:성명", 2]]);
  assert.equal(r.report.reread.fields, 2);
  // 순번을 준 규칙은 그 순번만 맡는다(나머지 순번은 암묵 채움)
  const second = tpl({ anchors: [{ id: "a", kind: "field", name: "성명", occurrence: 1 }], rules: [fillRule("r", "a", { text: "둘째" })] });
  assert.deepEqual(fieldsOf(reparse(done(generate(bytes, second, ds({ 성명: "데이터" }))).output)), [["성명", "데이터", "1", "simple"], ["성명", "둘째", "1", "simple"]]);
});

// ── 겹침과 연쇄 ─────────────────────────────────────────────────

test("겹침: 같은 누름틀을 같은 값으로 채우는 규칙 둘은 하나로 합쳐지고(수량·경고도 한 번), 값이 다르면 TPL_CONFLICT다", () => {
  const anchors = [{ id: "a", kind: "field", name: "성명" }, { id: "b", kind: "field", name: "성명", occurrence: 0 }];
  const same = tpl({ anchors, rules: [fillRule("r1", "a", { text: "값" }), fillRule("r2", "b", { text: "값" })] });
  const r = done(generate(CROSS, same, ds({})));
  assert.deepEqual(topTexts(reparse(r.output)).map(plain), ["앞 문단", "성명: 값 끝 뒤 글", "뒤 문단"]);
  assert.equal(merged(r).length, 1);
  assert.ok(bytesEqual(r.output, done(generate(CROSS, nameTemplate("값"), ds({}))).output));
  const diff = tpl({ anchors, rules: [fillRule("r1", "a", { text: "가" }), fillRule("r2", "b", { text: "나" })] });
  assert.deepEqual(failedCodes(generate(CROSS, diff, ds({}))), ["TPL_CONFLICT"]);
});

test("겹침: 지워지는 구간 안 문단을 삭제하는 규칙은 TPL_CONFLICT다(조용히 깨지지 않는다). 구간 밖 문단은 그대로 지워진다", () => {
  const d = reparse(CROSS);
  const anchor = (path: number[]) => makeLineAnchor(d, "m", 0, path) as NonNullable<ReturnType<typeof makeLineAnchor>>;
  const field = { id: "a", kind: "field", name: "성명" };
  const withDelete = (path: number[]) => tpl({ anchors: [field, anchor(path)], rules: [fillRule("r1", "a", { text: "값" }), { id: "r2", do: { type: "delete", anchor: "m" } }] });
  assert.deepEqual(failedCodes(generate(CROSS, withDelete([2]), ds({}))), ["TPL_CONFLICT"], "사이 문단");
  assert.deepEqual(failedCodes(generate(CROSS, withDelete([3]), ds({}))), ["TPL_CONFLICT"], "표가 든 사이 문단");
  assert.deepEqual(failedCodes(generate(CROSS, withDelete([4]), ds({}))), ["TPL_CONFLICT"], "끝 문단");
  const ok = done(generate(CROSS, withDelete([5]), ds({})));
  assert.deepEqual(topTexts(reparse(ok.output)).map(plain), ["앞 문단", "성명: 값 끝 뒤 글"]);
});

test("연쇄: 한 누름틀의 끝 문단에서 다른 여러 문단 누름틀이 시작하면 둘 다 채워지고 하나의 문단으로 합쳐진다(기대 글도 이어서 센다)", () => {
  const bytes = doc(
    para("1", t("앞")),
    para("2", t("성명: ") + begin("성명", "501") + t("안내1")),
    para("3", t("안내2") + end("501") + t(" 가 ") + begin("소속", "502") + t("안내3")),
    para("4", t("안내4")),
    para("5", t("안내5") + end("502") + t(" 끝")),
    para("6", t("뒤")),
  );
  assert.deepEqual(listFields(reparse(bytes)).map((f) => f.shape), ["crossParagraph", "crossParagraph"]);
  const r = done(run(bytes, { 성명: "A", 소속: "B" }));
  assert.deepEqual(topTexts(reparse(r.output)).map(plain), ["앞", "성명: A 가 B 끝", "뒤"]);
  assert.deepEqual(fieldsOf(reparse(r.output)), [["성명", "A", "1", "simple"], ["소속", "B", "1", "simple"]]);
  assert.equal(merged(r).length, 2);
  assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), []);
});

// ── 보고: BatchItem.warnings, generate의 issues ─────────────────

test("C3 generateBatch의 BatchItem.warnings: 계획 단계 경고(FIELD_PARAGRAPHS_MERGED)를 싣고 없으면 빈 배열이다. 단건 generate는 report.issues에 severity와 함께 싣는다", () => {
  const records = [{ dataset: { data: { 성명: "가" }, derived: {} } }, { dataset: { data: {}, derived: {} } }, { error: { code: "DATA_SCHEMA", message: "x" } }];
  const items: BatchItem[] = [...generateBatch(SPAN, emptyTemplate(), records, { baseName: "f" })];
  assert.deepEqual(items.map((i) => [i.ok, i.warnings.map((w) => [w.code, w.anchor])]), [
    [true, [["FIELD_PARAGRAPHS_MERGED", "field:성명"]]],
    [false, []],
    [false, []],
  ]);
  assert.equal(items[0]?.warnings[0]?.message, "누름틀 성명이 걸친 문단 3개를 합쳤고 사이의 문단 1개를 지웠습니다(그 안의 표 0개 포함).");
  const plainDoc = [...generateBatch(readFixture("hancom-field"), emptyTemplate(), [{ dataset: { data: { 성명: "x" }, derived: {} } }], { baseName: "f" })];
  assert.deepEqual(plainDoc[0]?.warnings, []);
  const single = run(SPAN, { 성명: "가" });
  assert.deepEqual(single.report.issues.filter((i) => i.severity === "warning").map((i) => i.code), ["FIELD_PARAGRAPHS_MERGED"]);
  assert.deepEqual(single.report.plan.issues.filter((i) => i.severity === "warning").map((i) => i.code), ["FIELD_PARAGRAPHS_MERGED"]);
});

// ── 앵커 초안 ───────────────────────────────────────────────────

test("draftAnchors: 여러 문단에 걸친 누름틀은 시작 문단의 표식 뒤·사이 문단·끝 문단의 표식 앞 어디서든 field 초안이 나오고, 표식 앞·뒤 글에서는 나오지 않는다", () => {
  const d = reparse(SPAN);
  const hasField = (path: number[], start: number): boolean => draftAnchors(d, { sectionIndex: 0, path, start }).some((x) => x.kind === "field" && x.name === "성명");
  assert.equal(hasField([1], 6), true, "시작 문단의 표식 뒤");
  assert.equal(hasField([1], 1), false, "시작 문단의 표식 앞(성명:)");
  assert.equal(hasField([2], 2), true, "사이 문단");
  assert.equal(hasField([3], 2), true, "끝 문단의 표식 앞");
  assert.equal(hasField([3], 7), false, "끝 문단의 표식 뒤(끝 뒤 글)");
  assert.equal(hasField([4], 1), false, "누름틀 밖 문단");
  // 채울 수 없는 crossParagraph(사이 문단에 secPr)는 초안이 없다
  const bad = reparse(mutateEntryText(SPAN, SEC, (x) => x.replace("<hp:t>가운데 문단</hp:t>", `${secPrOf(SPAN)}<hp:t>가운데 문단</hp:t>`)));
  assert.equal(draftAnchors(bad, { sectionIndex: 0, path: [2], start: 2 }).some((x) => x.kind === "field"), false);
  // 초안을 그대로 템플릿에 넣으면 채워진다
  const draft = draftAnchors(d, { sectionIndex: 0, path: [2], start: 2 }).find((x) => x.kind === "field");
  assert.ok(draft !== undefined);
  const r = done(generate(SPAN, tpl({ anchors: [{ id: "a", ...draft }], rules: [fillRule("r", "a", { text: "초안" })] }), ds({})));
  assert.deepEqual(topTexts(reparse(r.output)).map(plain), ["앞 문단", "성명: 초안 끝 뒤 글", "뒤 문단"]);
});

// ── 한컴이 직접 채워 저장한 정답 문서와 대조 ─────────────────────────

/** 문서의 구조 요약: 구역 바로 아래 문단 수, 모든 문단의 속성과 논리 글(문서 순서), 표 수, 누름틀의 값·dirty·모양 */
function summary(d: HwpxDocument) {
  return {
    top: d.sections[0]?.paragraphs.length,
    paragraphs: allParagraphs(d).map((p) => [p.attrs, p.logicalText]),
    tables: censusOfDoc(d).tables,
    fields: listFields(d).map((f) => [f.name, f.type, f.valueText, f.dirty, f.shape]),
  };
}
/** 원본을 엔진이 채운 결과와 한컴이 채워 저장한 문서 */
function answer(original: string, filled: string, data: Record<string, string>) {
  const bytes = readFixture(original);
  const result = done(run(bytes, data));
  return { before: reparse(bytes), ours: reparse(result.output), hancom: reparse(readFixture(filled)), result };
}

test("C4-11 한컴 대조: field-span — 세 문단에 걸친 누름틀 `성명`에 값을 넣은 결과가 한컴이 저장한 field-span-filled와 구조·글·누름틀이 같다", () => {
  const { before, ours, hancom, result } = answer("span/field-span", "span/field-span-filled", { 성명: "새 값" });
  assert.deepEqual(topTexts(before).map(plain), ["앞 문단", "성명: 첫 문단", "가운데 문단", "끝 문단 끝 뒤 글", "뒤 문단"]);
  assert.deepEqual(listFields(before).map((f) => [f.shape, f.dirty, f.path, f.endPath]), [["crossParagraph", "1", [1], [3]]]);
  assert.deepEqual(topTexts(hancom).map(plain), ["앞 문단", "성명: 새 값 끝 뒤 글", "뒤 문단"]);
  assert.deepEqual(summary(ours), summary(hancom));
  assert.equal(ours.sections[0]?.paragraphs[1]?.attrs.paraPrIDRef, before.sections[0]?.paragraphs[1]?.attrs.paraPrIDRef);
  assert.equal(ours.sections[0]?.paragraphs[1]?.attrs.styleIDRef, before.sections[0]?.paragraphs[1]?.attrs.styleIDRef);
  assert.equal(merged(result).length, 1);
});

test("C4-11 한컴 대조: field-span-table — 사이에 표가 든 문단까지 지워지고(표 0), 결과가 field-span-table-filled와 같다", () => {
  const { before, ours, hancom, result } = answer("span/field-span-table", "span/field-span-table-filled", { 성명: "새 값" });
  assert.deepEqual(topTexts(before).map(plain), ["앞 문단", "첫 문단", "", "끝 문단 끝 뒤 글", "뒤 문단"]);
  assert.deepEqual([censusOfDoc(before).tables, censusOfDoc(hancom).tables], [1, 0]);
  assert.deepEqual(topTexts(hancom).map(plain), ["앞 문단", "새 값 끝 뒤 글", "뒤 문단"]);
  assert.deepEqual(summary(ours), summary(hancom));
  assert.deepEqual(merged(result).map((i) => i.message), ["누름틀 성명이 걸친 문단 3개를 합쳤고 사이의 문단 1개를 지웠습니다(그 안의 표 1개 포함)."]);
});

test("C4-11 한컴 대조: field-span-cell — 표 칸 안 두 문단에 걸친 누름틀 `칸`의 결과가 field-span-cell-filled와 같다", () => {
  const { before, ours, hancom } = answer("span/field-span-cell", "span/field-span-cell-filled", { 칸: "새 칸 값" });
  assert.deepEqual([allParagraphs(before).length, allParagraphs(hancom).length], [6, 5]);
  assert.deepEqual(topTexts(before).map(plain), ["표 앞", "", "표 뒤"]);
  assert.deepEqual(allParagraphs(hancom).map((p) => plain(p.logicalText)), ["표 앞", "", "칸: 새 칸 값", "옆 칸", "표 뒤"]);
  assert.deepEqual(summary(ours), summary(hancom));
});

test("C4-11 한컴 대조: inline-breaks — 줄바꿈·탭이 든 값을 한컴처럼 통째로 바꾼 결과가 inline-breaks-filled와 같고 다른 문단은 그대로다", () => {
  const { before, ours, hancom } = answer("inline/inline-breaks", "span/inline-breaks-filled", { 줄: "다시 넣은 값", 탭: "탭 다시" });
  assert.deepEqual([before.sections[0]?.paragraphs.length, hancom.sections[0]?.paragraphs.length], [7, 7]);
  assert.deepEqual(summary(ours), summary(hancom));
  const lines = texts(ours).map(plain);
  assert.ok(lines.includes("누름틀: 다시 넣은 값") && lines.includes("누름틀: 탭 다시"));
  assert.equal(censusOfDoc(ours).tables, 1);
});

// ── 독립 검증 반영: 규칙 순서와 무관한 충돌(M1), 삽입·주입 앵커(L2), 함께 지운 필드·책갈피(L1), 형광펜·변경 추적 표식(L3) ──

/** 주입할 조각: 문단 하나("주입 문단") */
const FRAGMENT = JSON.parse(serializeFragment(extractFragment(reparse(doc(para("f1", t("주입 문단")), para("f2", t("다른 문단")))), { sectionIndex: 0, parentPath: [], from: 0, to: 0 }))) as Record<string, unknown>;
const ruleOf = (id: string, action: Record<string, unknown>) => ({ id, do: action });
const inject = (id: string, anchor: string, position: string) => ruleOf(id, { type: "inject", anchor, position, fragment: FRAGMENT });
const insertText = (id: string, anchor: string, position: string) => ruleOf(id, { type: "insertText", anchor, position, value: { text: "삽입 문단" } });

/** 구간(성명) 안에 일반 문단·표(2행)·안쪽 누름틀(소속, 같은 문단 안)이 든 문서. 구역 바로 아래: 0 앞 / 1 시작 / 2 가운데 / 3 표 / 4 소속 / 5 끝 / 6 뒤 */
const MATRIX = doc(
  para("1", t("앞 문단")),
  para("2", t("성명: ") + begin("성명", "501", "0") + t("안내1"), { seg: true }),
  para("3", t("가운데 문단")),
  para("4", tableXml({ id: "7201", rowCnt: 2, colCnt: 1, cells: [{ row: 0, col: 0, width: 3000, height: 500, paragraphs: [para("41", t("머리"))] }, { row: 1, col: 0, width: 3000, height: 500, paragraphs: [para("42", t("{{item.name}}"))] }] }) + t("")),
  para("5", t("소속: ") + begin("소속", "502") + t("옛") + end("502")),
  para("6", t("안내3") + end("501") + t(" 끝 뒤 글")),
  para("7", t("뒤 문단")),
);
const matrixLine = (id: string, path: number[]) => makeLineAnchor(reparse(MATRIX), id, 0, path) as NonNullable<ReturnType<typeof makeLineAnchor>>;

test("M1 구간 안을 가리키는 명시 규칙은 규칙 순서와 상관없이 TPL_CONFLICT다(line·cell 채움, insertText, inject, tableProps, 안쪽 누름틀 채움, 삭제, 행 반복 × 바깥 규칙이 앞·뒤)", () => {
  const field = { id: "a", kind: "field", name: "성명" };
  const outer = fillRule("f", "a", { text: "값" });
  const cellAt = (id: string, row: number) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row, col: 0 });
  const kinds: [string, unknown[], ReturnType<typeof ruleOf>][] = [
    ["line 채움", [matrixLine("m", [2])], fillRule("x", "m", { text: "바꿈" })],
    ["cell 채움", [cellAt("c", 0)], fillRule("x", "c", { text: "바꿈" })],
    ["insertText", [matrixLine("m", [2])], insertText("x", "m", "after")],
    ["inject", [matrixLine("m", [2])], inject("x", "m", "after")],
    ["tableProps", [{ id: "tb", kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 0 }], ruleOf("x", { type: "tableProps", anchor: "tb", table: { pageBreak: "NONE" } })],
    ["안쪽 누름틀 채움", [{ id: "i", kind: "field", name: "소속" }], fillRule("x", "i", { text: "소속값" })],
    ["삭제", [matrixLine("m", [2])], ruleOf("x", { type: "delete", anchor: "m" })],
    ["행 반복", [cellAt("row", 1)], ruleOf("x", { type: "repeat", anchor: "row", each: { path: "items" } })],
  ];
  const data = { items: [{ name: "A" }, { name: "B" }] };
  for (const [label, anchors, rule] of kinds) {
    for (const [order, rules] of [["바깥 규칙이 앞", [outer, rule]], ["바깥 규칙이 뒤", [rule, outer]]] as const) {
      const r = generate(MATRIX, tpl({ anchors: [field, ...anchors], rules: [...rules] }), ds(data));
      const where = `${label}, ${order}`;
      assert.deepEqual(failedCodes(r), ["TPL_CONFLICT"], where);
      assert.ok(r.report.issues.filter((i) => i.severity === "error").every((i) => i.where === "x" && i.message.includes("규칙 f")), `${where}: 충돌은 규칙 x가 규칙 f의 구간을 건드린다고 알린다`);
      assert.deepEqual(r.report.plan.dropped.filter((d) => d.ruleId === "x"), [], `${where}: 버리지 않는다`);
    }
  }
  // 바깥 누름틀을 규칙이 아니라 암묵 채움(이름 = 데이터 경로)으로 채울 때도 같다
  for (const [label, anchors, rule] of kinds) {
    const r = generate(MATRIX, tpl({ anchors, rules: [rule] }), ds({ ...data, 성명: "값", 소속: "기관" }));
    assert.deepEqual(failedCodes(r), ["TPL_CONFLICT"], `${label}: 암묵 채움이 바깥`);
    assert.ok(r.report.issues.filter((i) => i.severity === "error").every((i) => i.message.includes("누름틀 성명")), `${label}: 암묵 채움이 바깥`);
  }
  // 구간 밖(뒤 문단)을 가리키는 규칙은 순서와 상관없이 그대로 채워진다
  const lineAfter = matrixLine("m", [6]);
  for (const rules of [[outer, fillRule("x", "m", { text: "바꿈" })], [fillRule("x", "m", { text: "바꿈" }), outer]]) {
    const ok = done(generate(MATRIX, tpl({ anchors: [field, lineAfter], rules }), ds(data)));
    assert.deepEqual(topTexts(reparse(ok.output)).map(plain), ["앞 문단", "성명: 값 끝 뒤 글", "바꿈"]);
  }
  // 암묵 채움(`{{}}`·암묵 누름틀)은 순서와 상관없이 dropped다(오류가 아니다)
  const implicit = done(run(MATRIX, { 성명: "값", 소속: "기관", item: { name: "x" } }));
  assert.deepEqual(implicit.report.plan.dropped.map((d) => [d.ruleId, d.anchor]), [["implicit", "{{item.name}}"], ["implicit", "field:소속"]]);
});

test("M1 구간 안의 word 규칙도 순서와 상관없이 TPL_CONFLICT다(한 문단 안 inline 구간의 값 안, 여러 문단 구간의 시작 문단 꼬리 안)", () => {
  // 시작 문단 꼬리의 글: 구간 안이다
  const cross = doc(
    para("1", t("앞")),
    para("2", t("성명: ") + begin("성명", "501") + t("안내1 꼬리글")),
    para("3", t("안내2") + end("501") + t(" 끝")),
  );
  const d = reparse(cross);
  const tailText = d.sections[0]?.paragraphs[1]?.logicalText ?? "";
  const at = tailText.indexOf("꼬리글");
  const word = makeWordAnchor(d, "w", 0, [1], at, at + 3) as NonNullable<ReturnType<typeof makeWordAnchor>>;
  const field = { id: "a", kind: "field", name: "성명" };
  const outer = fillRule("f", "a", { text: "값" });
  const inner = fillRule("x", "w", { text: "바뀐 글" });
  for (const rules of [[outer, inner], [inner, outer]]) assert.deepEqual(failedCodes(generate(cross, tpl({ anchors: [field, word], rules }), ds({}))), ["TPL_CONFLICT"]);
  // 값이 같은 글이라 편집이 없어도(`꼬리글` → `꼬리글`) 구간 안이다
  const same = fillRule("x", "w", { text: "꼬리글" });
  for (const rules of [[outer, same], [same, outer]]) assert.deepEqual(failedCodes(generate(cross, tpl({ anchors: [field, word], rules }), ds({}))), ["TPL_CONFLICT"]);
  // 시작 문단의 표식 앞 글은 구간 밖이라 채워진다
  const head = makeWordAnchor(d, "h", 0, [1], 0, 2) as NonNullable<ReturnType<typeof makeWordAnchor>>;
  const ok = done(generate(cross, tpl({ anchors: [field, head], rules: [fillRule("x", "h", { text: "이름" }), outer] }), ds({})));
  assert.deepEqual(topTexts(reparse(ok.output)).map(plain), ["앞", "이름: 값 끝"]);
});

test("L2 합쳐지는 시작·끝 문단을 앵커로 쓰는 insertText·inject는 앞뒤 어디든 TPL_CONFLICT다. 구간 바깥 문단의 앞뒤 삽입은 성공한다", () => {
  const d = reparse(CROSS); // 0 앞 문단 / 1 시작 / 2 안내2 / 3 표 / 4 끝 / 5 뒤 문단
  const field = { id: "a", kind: "field", name: "성명" };
  const outer = fillRule("f", "a", { text: "값" });
  const lineAt = (path: number[]) => makeLineAnchor(d, "m", 0, path) as NonNullable<ReturnType<typeof makeLineAnchor>>;
  const make = { insertText, inject } as const;
  for (const [kind, build] of Object.entries(make)) {
    for (const position of ["before", "after"]) {
      for (const [label, path] of [["시작 문단", [1]], ["사이 문단", [2]], ["표가 든 사이 문단", [3]], ["끝 문단", [4]]] as [string, number[]][]) {
        for (const rules of [[outer, build("x", "m", position)], [build("x", "m", position), outer]]) {
          assert.deepEqual(failedCodes(generate(CROSS, tpl({ anchors: [field, lineAt(path)], rules }), ds({}))), ["TPL_CONFLICT"], `${kind} ${label} ${position}`);
        }
      }
    }
  }
  // 구간 바깥 문단(앞 문단·뒤 문단)의 앞뒤는 순서와 상관없이 성공한다. 삽입한 문단은 합쳐진 문단 바로 앞이나 뒤에 놓인다
  const expectTexts = (inserted: string, position: string, path: number[]): string[] => {
    const base = ["앞 문단", "성명: 값 끝 뒤 글", "뒤 문단"];
    const i = path[0] === 0 ? 0 : 2;
    base.splice(position === "before" ? i : i + 1, 0, inserted);
    return base;
  };
  for (const [kind, build] of Object.entries(make)) {
    for (const position of ["before", "after"]) {
      for (const path of [[0], [5]]) {
        for (const rules of [[outer, build("x", "m", position)], [build("x", "m", position), outer]]) {
          const ok = done(generate(CROSS, tpl({ anchors: [field, lineAt(path)], rules }), ds({})));
          assert.deepEqual(topTexts(reparse(ok.output)).map(plain), expectTexts(kind === "insertText" ? "삽입 문단" : "주입 문단", position, path), `${kind} ${position} ${path.join()}`);
        }
      }
    }
  }
  // 한 문단 안 inline 구간은 문단을 합치지 않으므로 그 문단의 앞뒤 삽입은 성공한다
  const inline = readFixture("inline/inline-breaks");
  const di = reparse(inline);
  const holder = allParagraphs(di).find((p) => p.fieldMarks.length > 0 && p.fieldMarks.some((m) => m.name === "줄"));
  assert.ok(holder !== undefined);
  const ia = makeLineAnchor(di, "m", 0, holder.path) as NonNullable<ReturnType<typeof makeLineAnchor>>;
  const t2 = tpl({ anchors: [{ id: "a", kind: "field", name: "줄" }, ia], rules: [fillRule("f", "a", { text: "값" }), insertText("x", "m", "after")] });
  const kept = done(generate(inline, t2, ds({}), { missing: "keep" }));
  assert.equal(allParagraphs(reparse(kept.output)).length, allParagraphs(di).length + 1);
});

test("L1 구간 안에 통째로 든 CLICK_HERE가 아닌 필드(날짜·하이퍼링크)와 책갈피는 함께 지워지고 dropped(field:이름·bookmark:이름)에 적힌다. 구간 안 필드를 가리키는 명시 규칙은 TPL_CONFLICT다", () => {
  const bytes = doc(
    para("1", t("앞")),
    para("2", t("성명: ") + begin("성명", "501") + t("안내1")),
    para("3", pairField("DATE", "작성일", "601", t("2020")) + pairField("HYPERLINK", "", "602", t("링크")) + bookmark("책1") + bookmark("책1") + bookmark("책2") + t("가운데")),
    para("4", t("안내3") + end("501") + t(" 끝 뒤")),
    para("5", t("뒤")),
  );
  const r = done(run(bytes, { 성명: "값" }));
  assert.deepEqual(topTexts(reparse(r.output)).map(plain), ["앞", "성명: 값 끝 뒤", "뒤"]);
  assert.deepEqual(
    r.report.plan.dropped.map((d) => [d.ruleId, d.anchor]),
    [["implicit", "field:작성일"], ["implicit", "field:HYPERLINK"], ["implicit", "bookmark:책1"], ["implicit", "bookmark:책2"]],
  );
  assert.match(r.report.plan.dropped[0]?.reason ?? "", /누름틀 성명이 지우는 구간 안에 있어 함께 지웠습니다/);
  assert.match(r.report.plan.dropped[2]?.reason ?? "", /\(2곳\)/);
  assert.deepEqual(r.report.plan.expected, { paragraphs: -2, fieldPairs: -2, bookmarks: -3 });
  const xml = sectionText(r.output);
  assert.ok(!xml.includes("작성일") && !xml.includes("책1") && !xml.includes("링크"));
  assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), []);
  // 구간 밖(시작 표식 앞, 끝 표식 뒤)의 필드·책갈피는 그대로이고 dropped에 없다
  const outside = doc(
    para("1", t("앞") + bookmark("앞책") + pairField("DATE", "앞날짜", "603", t("2021"))),
    para("2", t("성명: ") + begin("성명", "501") + t("안내1")),
    para("3", t("안내3") + end("501") + t(" 끝 뒤") + bookmark("뒤책")),
  );
  const o = done(run(outside, { 성명: "값" }));
  assert.deepEqual(o.report.plan.dropped, []);
  assert.ok(sectionText(o.output).includes("앞책") && sectionText(o.output).includes("뒤책") && sectionText(o.output).includes("앞날짜"));
  // 구간 안의 다른 type 필드를 이름으로 가리키는 명시 규칙은 순서와 상관없이 TPL_CONFLICT다
  const anchors = [{ id: "a", kind: "field", name: "성명" }, { id: "d", kind: "field", name: "작성일" }];
  const outer = fillRule("f", "a", { text: "값" });
  const inner = fillRule("x", "d", { text: "오늘" });
  for (const rules of [[outer, inner], [inner, outer]]) assert.deepEqual(failedCodes(generate(bytes, tpl({ anchors, rules }), ds({}))), ["TPL_CONFLICT"]);
});

// ── 형광펜·변경 추적 표식이 구간 경계에 걸치면 건너뛴다 ──────────────────────

const MARK_OPEN = '<hp:markpenBegin color="#FFFF00"/>';
const MARK_CLOSE = "<hp:markpenEnd/>";
const INSERT_OPEN = '<hp:insertBegin Id="1" TcId="1" Date="2026-10-04T00:00:00Z" Author="a"/>';
const INSERT_CLOSE = '<hp:insertEnd Id="1" TcId="1"/>';
const DELETE_OPEN = '<hp:deleteBegin Id="2" TcId="2" Date="2026-10-04T00:00:00Z" Author="a"/>';
const DELETE_CLOSE = '<hp:deleteEnd Id="2" TcId="2"/>';
const STRAY = /강조·변경 추적 표식이 누름틀 경계에 걸쳐 있음/;
/** 시작 문단 `성명: ` + 시작 표식 + 안내 / 가운데 문단 / 끝 문단 안내 + 끝 표식 + ` 끝 뒤`. 각 자리의 글 안에 표식을 넣는다. */
const marked = (parts: { head?: string; start?: string; middle?: string; endHead?: string; endTail?: string }): Uint8Array =>
  doc(
    para("1", t("앞")),
    para("2", `<hp:t>성명${parts.head ?? ""}: </hp:t>` + begin("성명", "501") + `<hp:t>안내1${parts.start ?? ""}</hp:t>`),
    para("3", `<hp:t>가운데${parts.middle ?? ""}문단</hp:t>`),
    para("4", `<hp:t>안내3${parts.endHead ?? ""}</hp:t>` + end("501") + `<hp:t> 끝${parts.endTail ?? ""} 뒤</hp:t>`),
    para("5", t("뒤")),
  );

test("L3 짝이 구간 경계에 걸친 형광펜·변경 추적 표식은 FIELD_UNSUPPORTED_SHAPE로 건너뛰고 문서는 그대로다(여러 문단·한 문단 inline, 시작이 안이든 끝이 안이든)", () => {
  const cases: [string, Uint8Array][] = [
    ["형광펜: 구간 안에서 시작해 끝 표식 뒤에서 끝남", marked({ middle: MARK_OPEN, endTail: MARK_CLOSE })],
    ["형광펜: 시작 표식 앞에서 시작해 구간 안에서 끝남", marked({ head: MARK_OPEN, middle: MARK_CLOSE })],
    ["변경 추적 삽입: 구간 안에서 시작해 구간 밖에서 끝남", marked({ start: INSERT_OPEN, endTail: INSERT_CLOSE })],
    ["변경 추적 삭제: 구간 밖에서 시작해 구간 안에서 끝남", marked({ head: DELETE_OPEN, endHead: DELETE_CLOSE })],
    ["형광펜 끝만 구간 안에 있음", marked({ endHead: MARK_CLOSE })],
    ["형광펜 시작만 구간 안에 있음", marked({ middle: MARK_OPEN })],
    [
      "같은 문단 inline: 값 안에서 시작해 끝 표식 뒤에서 끝남",
      doc(para("1", t("앞")), para("2", begin("성명", "501") + `<hp:t>가<hp:tab width="0" leader="0" type="1"/>${MARK_OPEN}나</hp:t>` + end("501") + `<hp:t>다${MARK_CLOSE}</hp:t>`), para("3", t("뒤"))),
    ],
  ];
  for (const [label, bytes] of cases) {
    const target = targetOf(bytes);
    assert.equal(fieldFillBlock(target)?.code, "FIELD_UNSUPPORTED_SHAPE", label);
    assert.match(fieldFillBlock(target)?.message ?? "", STRAY, label);
    assert.deepEqual(failedCodes(generate(bytes, nameTemplate("x"), ds({}))), ["FIELD_UNSUPPORTED_SHAPE"], label);
    assert.deepEqual(failedCodes(run(bytes, { 성명: "x" })), ["FILL_NOTHING_APPLIED"], label);
    assert.equal(draftAnchors(reparse(bytes), { sectionIndex: 0, path: [1], start: 6 }).some((x) => x.kind === "field"), false, `${label}: 채울 수 없는 누름틀은 field 초안이 없다`);
  }
  // 표식이 구간 밖에 걸쳐 있는 것이 아니라 시작 문단 머리와 끝 문단 꼬리 사이(구간을 감싸는)에서 맞으면 채운다
  const around = marked({ head: MARK_OPEN, endTail: MARK_CLOSE });
  const r = done(run(around, { 성명: "값" }));
  assert.deepEqual(topTexts(reparse(r.output)).map(plain), ["앞", "성명: 값 끝 뒤", "뒤"]);
  assert.ok(sectionText(r.output).includes("markpenBegin") && sectionText(r.output).includes("markpenEnd"), "구간을 감싸는 표식은 그대로 남는다");
});

test("L3 구간 안에서 짝이 맞는 형광펜·변경 추적 표식은 함께 지우고 채운다(여러 문단·한 문단 inline). 구간 밖의 표식은 그대로다", () => {
  const cases: [string, Uint8Array, string[]][] = [
    ["형광펜 한 쌍이 가운데 문단 안에", marked({ middle: `${MARK_OPEN}운${MARK_CLOSE}` }), ["markpen"]],
    ["변경 추적 삽입이 시작 문단 꼬리에서 가운데 문단까지", marked({ start: INSERT_OPEN, middle: INSERT_CLOSE }), ["insertBegin", "insertEnd"]],
    ["변경 추적 삭제가 가운데에서 끝 문단 머리까지, 형광펜이 끝 문단 머리 안에", marked({ middle: DELETE_OPEN, endHead: `${DELETE_CLOSE}${MARK_OPEN}${MARK_CLOSE}` }), ["deleteBegin", "deleteEnd", "markpen"]],
  ];
  for (const [label, bytes, gone] of cases) {
    assert.equal(fieldFillBlock(targetOf(bytes)), undefined, label);
    const r = done(run(bytes, { 성명: "값" }));
    assert.deepEqual(topTexts(reparse(r.output)).map(plain), ["앞", "성명: 값 끝 뒤", "뒤"], label);
    for (const name of gone) assert.ok(!sectionText(r.output).includes(name), `${label}: ${name} 표식이 사라졌다`);
    assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), [], label);
  }
  // 구간 밖(시작 표식 앞, 끝 표식 뒤)의 짝 맞는 표식은 남는다
  const outside = marked({ head: `${MARK_OPEN}`, middle: "", endTail: MARK_CLOSE });
  assert.equal(fieldFillBlock(targetOf(outside)), undefined);
  const kept = sectionText(done(run(outside, { 성명: "값" })).output);
  assert.ok(kept.includes("markpenBegin") && kept.includes("markpenEnd"));
  // 같은 문단 inline: 값 안에서 짝이 맞는 형광펜은 값과 함께 바뀌고, 같은 문단 안 짝 없는 표식(구간 밖)은 남는다
  const inline = doc(
    para("1", begin("성명", "501") + `<hp:t>가<hp:tab width="0" leader="0" type="1"/>${MARK_OPEN}나${MARK_CLOSE}</hp:t>` + end("501") + t("끝")),
    para("2", t("뒤")),
  );
  assert.equal(listFields(reparse(inline))[0]?.shape, "inline");
  const r = done(run(inline, { 성명: "값" }));
  assert.deepEqual(fieldsOf(reparse(r.output)), [["성명", "값", "1", "simple"]]);
  assert.ok(!sectionText(r.output).includes("markpen"));
});
