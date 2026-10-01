// 1단계 설정: planSetTableProps·planSetCellProps (B1: 요청한 속성만 바뀌고 편집 구간 밖 원문은 그대로).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeriver, listTables, mergeTablePlans, planSetCellProps, planSetTableProps, type EditPlan, type HwpxDocument } from "../src/index.ts";
import { loadDoc } from "./helpers.ts";
import {
  applyChecked,
  attrDiff,
  docOf,
  gridTable,
  reparseBytes,
  sectionText,
  segPara,
  singleTableDoc,
  tableParagraph,
  target,
  type TableSpec,
} from "./table-helpers.ts";

const base = (extra: Partial<TableSpec> = {}) => singleTableDoc(gridTable([2000, 3000, 4000], 3, [["가", "나", "다"]], extra, 700));

function expectCodes(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof Error && (e as { code?: string }).code === code, `${code}가 나와야 한다`);
}

/** 적용 뒤 원문 차이: 속성 변경 목록만 있고 구조 변화는 없다 */
function diffOf(doc: HwpxDocument, plan: EditPlan): string[] {
  const { bytes } = applyChecked(doc, plan);
  const { structural, diffs } = attrDiff(sectionText(doc.pkg.bytes), sectionText(bytes));
  assert.equal(structural, false, "요소 구조가 바뀌었다");
  return diffs;
}

test("B1: 표 설정 하나씩 바꾸면 그 속성만 바뀐다", () => {
  const { doc } = base();
  const t = target(doc);
  const only = (props: Parameters<typeof planSetTableProps>[2]): string[] => diffOf(doc, planSetTableProps(doc, t, props)).map((d) => d.replace(/^.*\/(hp:\w+)\[\d+\]@/, "$1@"));
  assert.deepEqual(only({ treatAsChar: true }), ["hp:pos@treatAsChar: 0→1"]);
  assert.deepEqual(only({ pageBreak: "NONE" }), ["hp:tbl@pageBreak: CELL→NONE"]);
  assert.deepEqual(only({ pageBreak: "TABLE" }), ["hp:tbl@pageBreak: CELL→TABLE"]);
  assert.deepEqual(only({ repeatHeader: true }), ["hp:tbl@repeatHeader: 0→1"]);
  assert.deepEqual(only({ cellSpacing: 120 }), ["hp:tbl@cellSpacing: 0→120"]);
  assert.deepEqual(only({ hAlign: "RIGHT" }), ["hp:pos@horzAlign: LEFT→RIGHT"]);
  assert.deepEqual(only({ hAlign: "CENTER" }), ["hp:pos@horzAlign: LEFT→CENTER"]);
  assert.deepEqual(only({ outMargin: { left: 10, right: 20, top: 30, bottom: 40 } }), [
    "hp:outMargin@left: 283→10",
    "hp:outMargin@right: 283→20",
    "hp:outMargin@top: 283→30",
    "hp:outMargin@bottom: 283→40",
  ]);
  assert.deepEqual(only({ inMargin: { top: 5 } }), ["hp:inMargin@top: 141→5"]);
  // 여러 항목을 함께
  assert.deepEqual(only({ treatAsChar: true, pageBreak: "NONE", repeatHeader: true }).sort(), ["hp:pos@treatAsChar: 0→1", "hp:tbl@pageBreak: CELL→NONE", "hp:tbl@repeatHeader: 0→1"].sort());
});

test("B1: 이미 그 값이면 편집이 없고 바이트가 그대로다", () => {
  const { doc } = base({ treatAsChar: true, repeatHeader: true });
  const plan = planSetTableProps(doc, target(doc), { treatAsChar: true, repeatHeader: true, pageBreak: "CELL", cellSpacing: 0, hAlign: "LEFT" });
  assert.equal(plan.edits.length, 0);
  assert.deepEqual(plan.additions, []);
});

test("줄 배치 캐시: 바뀐 것이 있으면 그 구역의 줄 배치 캐시를 전부 지우고 글은 그대로다", () => {
  const spec = gridTable([5000], 1, [["표 글"]], {}, 700);
  const bytes = docOf([segPara("앞 문단"), tableParagraph(spec), segPara("뒤 문단")]);
  const doc = reparseBytes(bytes);
  const plan = planSetTableProps(doc, target(doc), { treatAsChar: true });
  const { bytes: out } = applyChecked(doc, plan);
  assert.equal(sectionText(bytes).match(/<hp:linesegarray>/g)?.length, 2);
  assert.equal(sectionText(out).match(/<hp:linesegarray>/g), null);
  assert.deepEqual(
    reparseBytes(out).sections[0]?.paragraphs.map((p) => p.logicalText),
    doc.sections[0]?.paragraphs.map((p) => p.logicalText),
  );
  // 바뀐 것이 없으면 캐시도 그대로
  const none = planSetTableProps(doc, target(doc), { pageBreak: "CELL" });
  assert.equal(none.edits.length, 0);
});

test("없는 자식 요소는 한컴 저장본의 순서(sz, pos, outMargin, inMargin)대로 만든다", () => {
  const spec = gridTable([5000], 1, [["x"]], {}, 700);
  for (const omit of [["pos"], ["outMargin"], ["inMargin"], ["pos", "outMargin"], ["outMargin", "inMargin"], ["pos", "outMargin", "inMargin"]] as const) {
    const { doc } = singleTableDoc({ ...spec, omit: [...omit] });
    const plan = planSetTableProps(doc, target(doc), { treatAsChar: true, hAlign: "CENTER", outMargin: { left: 7 }, inMargin: { bottom: 9 } });
    const { bytes } = applyChecked(doc, plan);
    const xml = sectionText(bytes);
    const children = [...xml.slice(xml.indexOf("<hp:tbl "), xml.indexOf("<hp:tr>")).matchAll(/<hp:(sz|pos|outMargin|inMargin|cellzoneList)\b/g)].map((m) => m[1]);
    assert.deepEqual(children, ["sz", "pos", "outMargin", "inMargin"], `omit=${omit.join(",")}`);
    assert.match(xml, /<hp:pos treatAsChar="1"[^>]*horzAlign="CENTER"/);
    assert.match(xml, /<hp:outMargin [^>]*left="7"/);
    assert.match(xml, /<hp:inMargin [^>]*bottom="9"/);
    // 요소를 만들 때 요청하지 않은 변은 기존 값(있으면) 또는 0이다
    if ((omit as readonly string[]).includes("outMargin")) assert.match(xml, /<hp:outMargin left="7" right="0" top="0" bottom="0"\/>/);
  }
});

test("바깥 여백만 요청하고 pos·outMargin이 모두 없는 표는 같은 자리 삽입을 하나로 합친다(편집 구간이 겹치지 않는다)", () => {
  const { doc } = singleTableDoc({ ...gridTable([5000], 1, [["x"]]), omit: ["pos", "outMargin"] });
  const plan = planSetTableProps(doc, target(doc), { treatAsChar: true, outMargin: { top: 1 } });
  const inserts = plan.edits.filter((e) => e.start === e.end && e.replacement.includes("<hp:pos"));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0]?.replacement ?? "", /^<hp:pos [^>]*\/><hp:outMargin [^>]*\/>$/);
});

test("셀 설정: 범위 안 셀만 바뀌고(주소 기준) 병합 셀은 왼쪽 위 주소로 고른다", () => {
  const spec: TableSpec = {
    rowCnt: 3,
    colCnt: 3,
    cells: [
      { row: 0, col: 0, colSpan: 2, width: 5000, height: 600, text: "제목" },
      { row: 0, col: 2, width: 4000, height: 600, text: "c" },
      { row: 1, col: 0, width: 2000, height: 600, text: "d" },
      { row: 1, col: 1, width: 3000, height: 600, text: "e" },
      { row: 1, col: 2, width: 4000, height: 600, text: "f" },
      { row: 2, col: 0, width: 2000, height: 600, text: "g" },
      { row: 2, col: 1, width: 3000, height: 600, text: "h" },
      { row: 2, col: 2, width: 4000, height: 600, text: "i" },
    ],
  };
  const { doc } = singleTableDoc(spec);
  const t = target(doc);
  // 1행(rows [1,1])의 모든 열: 세로 정렬 TOP, 제목 셀, 보호
  const diffs = diffOf(doc, planSetCellProps(doc, t, [{ rows: [1, 1], props: { vertAlign: "TOP", header: true, protect: true } }]));
  assert.equal(diffs.length, 9, "셀 3개 × (vertAlign, header, protect)");
  assert.equal(diffs.filter((d) => d.includes("hp:subList") && d.endsWith("vertAlign: CENTER→TOP")).length, 3);
  assert.equal(diffs.filter((d) => d.endsWith("header: 0→1")).length, 3);
  assert.equal(diffs.filter((d) => d.endsWith("protect: 0→1")).length, 3);

  // 열 범위 [1,1]: 병합 셀(0,0 colSpan 2)은 주소가 열 0이라 빠진다
  const colDiffs = diffOf(doc, planSetCellProps(doc, t, [{ cols: [1, 1], props: { lineWrap: "SQUEEZE" } }]));
  assert.equal(colDiffs.length, 2, "(1,1)과 (2,1) 두 셀");
  // 겹치는 항목: 뒤의 것이 이긴다
  const later = diffOf(doc, planSetCellProps(doc, t, [{ props: { vertAlign: "TOP" } }, { rows: [0, 0], cols: [0, 0], props: { vertAlign: "BOTTOM" } }]));
  assert.equal(later.filter((d) => d.endsWith("vertAlign: CENTER→TOP")).length, 7);
  assert.equal(later.filter((d) => d.endsWith("vertAlign: CENTER→BOTTOM")).length, 1);
});

test("셀 여백: cellMargin을 정하고 hasMargin을 켠다. cellMargin 요소가 없으면 표 안 여백을 바탕으로 만든다", () => {
  const { doc } = base();
  const diffs = diffOf(doc, planSetCellProps(doc, target(doc), [{ rows: [0, 0], cols: [0, 0], props: { margin: { left: 33, top: 44 } } }]));
  assert.deepEqual(diffs.map((d) => d.replace(/^.*\/(hp:\w+)\[\d+\]@/, "$1@")).sort(), ["hp:cellMargin@left: 141→33", "hp:cellMargin@top: 141→44", "hp:tc@hasMargin: 0→1"].sort());

  // cellMargin이 없는 셀
  const bytes = docOf([tableParagraph(gridTable([5000], 1, [["x"]])).replace(/<hp:cellMargin [^>]*\/>/, "")]);
  const d2 = reparseBytes(bytes);
  const plan = planSetCellProps(d2, target(d2), [{ props: { margin: { right: 55 } } }]);
  const { bytes: out } = applyChecked(d2, plan);
  // 표 안 여백(left 510, right 510, top 141, bottom 141)을 바탕으로 right만 55
  assert.match(sectionText(out), /<hp:cellMargin left="510" right="55" top="141" bottom="141"\/>/);
  assert.match(sectionText(out), /<hp:tc [^>]*hasMargin="1"/);
});

test("셀·표 테두리: 기준 테두리 자원을 복제해 파생하고 같은 요청은 재사용한다", () => {
  const { doc } = base();
  const t = target(doc);
  const border = { sides: ["left" as const], type: "SOLID", width: "0.5 mm", color: "#ff0000" };
  const plan = planSetCellProps(doc, t, [{ rows: [0, 1], props: { border } }]);
  assert.equal(plan.summary["addedResources"], 1);
  const { bytes, doc: after } = applyChecked(doc, plan);
  const borders = after.header.resources["borderFill"] ?? [];
  assert.equal(borders.length, 2);
  const created = borders.find((b) => b.id !== "1");
  assert.ok(created !== undefined);
  const xml = after.header.text.slice(created.element.start, created.element.end);
  assert.match(xml, /<hh:leftBorder [^>]*type="SOLID"/);
  assert.match(xml, /<hh:leftBorder [^>]*width="0.5 mm"/);
  assert.match(xml, /<hh:leftBorder [^>]*color="#FF0000"/);
  // 헤더의 개수 속성이 맞다
  assert.match(after.header.text, /<hh:borderFills itemCnt="2">/);
  // 셀 6개는 새 자원, 나머지 셀은 그대로
  const refs = [...sectionText(bytes).matchAll(/<hp:tc [^>]*borderFillIDRef="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(refs, [created.id, created.id, created.id, created.id, created.id, created.id, "1", "1", "1"]);
  // 같은 요청을 결과에 다시 하면 새 자원이 없다(재사용)
  const again = planSetCellProps(after, target(after), [{ rows: [0, 1], props: { border } }]);
  assert.equal(again.edits.length, 0);
  // 다른 셀에 같은 모양을 요청하면 새 자원 없이 기존 것을 재사용한다
  const reuse = planSetCellProps(after, target(after), [{ rows: [2, 2], props: { border } }]);
  assert.equal(reuse.summary["addedResources"], 0);
  const applied = applyChecked(after, reuse);
  assert.equal((applied.doc.header.resources["borderFill"] ?? []).length, 2);

  // 표 자체의 테두리
  const tablePlan = planSetTableProps(doc, t, { border: { type: "NONE" } });
  const tb = applyChecked(doc, tablePlan);
  assert.equal(tb.doc.header.resources["borderFill"]?.length, 2);
});

test("파생기를 공유하면 여러 계획의 새 테두리 id가 겹치지 않고 mergeTablePlans로 합칠 수 있다", () => {
  const { doc } = base();
  const deriver = createDeriver(doc);
  const a = planSetCellProps(doc, target(doc), [{ rows: [0, 0], props: { border: { type: "SOLID", color: "#00ff00" } } }], { deriver });
  const b = planSetCellProps(doc, target(doc), [{ rows: [1, 1], props: { border: { type: "DASH", color: "#0000ff" } } }], { deriver });
  const merged = mergeTablePlans(a, b, deriver.finish());
  const { bytes, doc: after } = applyChecked(doc, merged);
  const ids = (after.header.resources["borderFill"] ?? []).map((r) => r.id);
  assert.deepEqual(ids.sort(), ["1", "2", "3"]);
  const refs = [...sectionText(bytes).matchAll(/<hp:tc [^>]*borderFillIDRef="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(refs, ["2", "2", "2", "3", "3", "3", "1", "1", "1"]);
});

test("거절: 잘못된 값은 TABLE_BAD_ARG, 표가 아닌 요소나 다른 문서의 표는 TABLE_NOT_FOUND", () => {
  const { doc } = base();
  const t = target(doc);
  const bad = (props: unknown): void => expectCodes(() => planSetTableProps(doc, t, props as never), "TABLE_BAD_ARG");
  bad({});
  bad({ pageBreak: "SOMETIMES" });
  bad({ treatAsChar: "yes" });
  bad({ cellSpacing: -1 });
  bad({ cellSpacing: 1.5 });
  bad({ outMargin: {} });
  bad({ outMargin: { middle: 1 } });
  bad({ inMargin: { left: -5 } });
  bad({ hAlign: "INSIDE" });
  bad({ unknownProp: 1 });
  bad({ border: { type: "WIGGLY" } });
  bad({ border: { width: "thick" } });
  bad({ border: { color: "red" } });
  bad({ border: {} });
  bad({ border: { sides: [], type: "SOLID" } });
  const cell = (entries: unknown): void => expectCodes(() => planSetCellProps(doc, t, entries as never), "TABLE_BAD_ARG");
  cell([]);
  cell([{ props: {} }]);
  cell([{ props: { vertAlign: "MIDDLE" } }]);
  cell([{ props: { lineWrap: "KEEP" } }]);
  cell([{ rows: [2, 1], props: { header: true } }]);
  cell([{ rows: [0], props: { header: true } }]);
  cell([{ rows: [5, 6], props: { header: true } }]);
  cell([{ props: { margin: { left: -1 } } }]);

  const notTable = doc.sections[0]?.paragraphs[0]?.element;
  expectCodes(() => planSetTableProps(doc, { sectionIndex: 0, element: notTable as never }, { treatAsChar: true }), "TABLE_NOT_FOUND");
  expectCodes(() => planSetTableProps(doc, { sectionIndex: 3, element: t.element }, { treatAsChar: true }), "TABLE_NOT_FOUND");
  const other = singleTableDoc(gridTable([1000], 1));
  expectCodes(() => planSetTableProps(doc, target(other.doc), { treatAsChar: true }), "TABLE_NOT_FOUND");
});

test("설정은 격자가 불규칙해도 동작한다(D4의 셀이 불완전한 표)", () => {
  const doc = loadDoc("D4");
  const broken = listTables(doc).filter((x) => !x.regular);
  assert.equal(broken.length, 2);
  const plan = planSetTableProps(doc, broken[0]?.target as never, { pageBreak: "NONE", repeatHeader: true });
  const { bytes } = applyChecked(doc, plan);
  assert.ok(plan.edits.length > 0);
  assert.equal(listTables(reparseBytes(bytes))[broken[0]?.ordinal ?? 0]?.pageBreak, "NONE");
});

test("실제 시험 문서의 모든 표에 설정을 적용해도 검사기 새 오류가 없고 요청한 값을 다시 읽을 수 있다", () => {
  for (const name of ["D1", "D2", "D3", "D5", "D6", "hancom-merged", "hancom/blocks", "extra/features-picture"]) {
    const doc = loadDoc(name);
    for (const info of listTables(doc)) {
      const plan = planSetTableProps(doc, info.target, { treatAsChar: !(info.treatAsChar ?? false), pageBreak: info.pageBreak === "NONE" ? "CELL" : "NONE", repeatHeader: !(info.repeatHeader ?? false) });
      const { doc: after } = applyChecked(doc, plan);
      const now = listTables(after).find((x) => x.ordinal === info.ordinal);
      assert.equal(now?.treatAsChar, !(info.treatAsChar ?? false), `${name} #${info.ordinal}`);
      assert.equal(now?.repeatHeader, !(info.repeatHeader ?? false));
      assert.equal(now?.pageBreak, info.pageBreak === "NONE" ? "CELL" : "NONE");
    }
  }
});
