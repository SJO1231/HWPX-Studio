// 4단계 템플릿 액션: tableProps·resize·repeat·inject의 fitTable (저장 게이트를 거친다). B6(행 반복)과 게이트 통과·결정성.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFillPlan,
  extractFragment,
  generate,
  listTables,
  openPackage,
  parseDocument,
  readDataset,
  readTemplate,
  rewriteArchive,
  selectTable,
  validateDocument,
  type GenerateOptions,
  type GenerateResult,
} from "../src/index.ts";
import { verifyRepeat } from "../src/fill/table-actions.ts";
import { duplicates, loadDoc, objectIdsIn, sha256Hex } from "./helpers.ts";
import {
  attrIn,
  docOf,
  gridTable,
  outerTableXml,
  paragraph,
  readCells,
  rowWidthSums,
  sectionText,
  tableParagraph,
  tableXml,
  textPara,
  topRows,
  type TableSpec,
} from "./table-helpers.ts";

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

const tpl = (spec: { anchors?: unknown[]; rules?: unknown[]; options?: unknown }) => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const ds = (data: unknown) => readDataset(data);
const run = (bytes: Uint8Array, t: ReturnType<typeof tpl>, data: unknown, options: GenerateOptions = {}) => generate(bytes, t, ds(data), options);
const parse = (bytes: Uint8Array) => parseDocument(openPackage(bytes));

const tableAnchor = (id = "tbl", ordinal = 0) => ({ id, kind: "object", objectType: "tbl", sectionIndex: 0, ordinal });
const cellAnchor = (id: string, row: number, col = 0, ordinal = 0) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal }, row, col });
const rule = (id: string, action: Record<string, unknown>, when?: unknown) => ({ id, ...(when === undefined ? {} : { when }), do: action });

/** 머리 행 + 반복할 데이터 행(원형) + 합계 행(가로 병합) */
function listSpec(extra: Partial<TableSpec> = {}): TableSpec {
  return {
    id: "5001",
    rowCnt: 3,
    colCnt: 3,
    repeatHeader: true,
    cells: [
      { row: 0, col: 0, width: 2000, height: 500, text: "번호", header: true },
      { row: 0, col: 1, width: 3000, height: 500, text: "이름", header: true },
      { row: 0, col: 2, width: 4000, height: 500, text: "내용", header: true },
      { row: 1, col: 0, width: 2000, height: 800, text: "{{no}}" },
      { row: 1, col: 1, width: 3000, height: 800, text: "{{item.name}}" },
      { row: 1, col: 2, width: 4000, height: 800, text: "{{item.note}} / {{project}}" },
      { row: 2, col: 0, colSpan: 3, width: 9000, height: 600, text: "합계" },
    ],
    ...extra,
  };
}
const listDoc = (extra: Partial<TableSpec> = {}): Uint8Array => docOf([textPara("제목"), tableParagraph(listSpec(extra)), textPara("끝")]);
/** `{{}}`가 없는 같은 모양의 표(표 설정·크기 시험용) */
const plainDoc = (extra: Partial<TableSpec> = {}): Uint8Array => {
  const spec = listSpec(extra);
  spec.cells = spec.cells.map((c) => (c.text?.includes("{{") === true ? { ...c, text: "값" } : c));
  return docOf([textPara("제목"), tableParagraph(spec), textPara("끝")]);
};
const repeatTemplate = (extraRules: unknown[] = [], extraAnchors: unknown[] = [], action: Record<string, unknown> = {}) =>
  tpl({
    anchors: [cellAnchor("row", 1), tableAnchor(), ...extraAnchors],
    rules: [rule("r1", { type: "repeat", anchor: "row", each: { path: "items" }, index: "no", ...action }), ...extraRules],
  });
const rowsText = (bytes: Uint8Array): string[] => topRows(outerTableXml(sectionText(bytes), 0)).map((r) => [...r.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|"));
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `이름${i + 1}`, note: `비고${i + 1}` }));

// ── 템플릿 읽기 ─────────────────────────────────────────────────

test("템플릿 읽기: 새 액션의 올바른 형식과 거절", () => {
  const ok = readTemplate({
    schema: "hwpx-studio/template@1",
    anchors: [tableAnchor(), cellAnchor("c", 1), { id: "line", kind: "line", at: { sectionIndex: 0, path: [0] }, print: { text: "", sha256: "0".repeat(64) } }],
    rules: [
      rule("a", { type: "tableProps", anchor: "tbl", table: { treatAsChar: false, pageBreak: "CELL", repeatHeader: true, cellSpacing: 5, outMargin: { left: 1 }, inMargin: { top: 2 }, hAlign: "CENTER" }, cells: [{ rows: [0, 1], cols: [0, 0], props: { vertAlign: "TOP", lineWrap: "SQUEEZE", header: true, margin: { left: 1 }, protect: false } }] }),
      rule("b", { type: "tableProps", anchor: "c", table: { pageBreak: "NONE" } }),
      rule("c", { type: "resize", anchor: "tbl", columns: [1, 2, 3], rowHeights: [{ row: 0, height: 5 }] }),
      rule("d", { type: "resize", anchor: "tbl", scale: 0.5 }),
      rule("e", { type: "resize", anchor: "tbl", width: 10 }),
      rule("f", { type: "repeat", anchor: "c", each: { path: "items" } }),
      rule("g", { type: "repeat", anchor: "c", each: { path: "a.b" }, as: "row", index: "n" }),
      rule("h", { type: "inject", anchor: "line", position: "after", fragment: {}, fitTable: "allowBreak" }),
    ],
  });
  assert.equal(ok.rules.length, 8);

  const bad = (rules: unknown[], code = "TPL_RULE"): void =>
    assert.throws(() => readTemplate({ schema: "hwpx-studio/template@1", anchors: [tableAnchor(), cellAnchor("c", 1), { id: "pic", kind: "object", objectType: "pic", sectionIndex: 0, ordinal: 0 }, { id: "line", kind: "line", at: { sectionIndex: 0, path: [0] }, print: { text: "", sha256: "0".repeat(64) } }], rules }), (e: unknown) => (e as { code?: string }).code === code, JSON.stringify(rules));
  bad([rule("x", { type: "tableProps", anchor: "tbl" })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", table: {} })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", table: { pageBreak: "ALWAYS" } })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", table: { treatAsChar: 1 } })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", table: { cellSpacing: -1 } })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", table: { outMargin: {} } })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", table: { outMargin: { middle: 1 } } })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", table: { color: "red" } })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", cells: [] })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", cells: [{ rows: [2, 1], cols: [0, 0], props: { header: true } }] })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", cells: [{ rows: [0, 0], cols: [0, 0], props: {} }] })]);
  bad([rule("x", { type: "tableProps", anchor: "tbl", cells: [{ rows: [0, 0], cols: [0, 0], props: { vertAlign: "MIDDLE" } }] })]);
  bad([rule("x", { type: "tableProps", anchor: "pic", table: { treatAsChar: true } })]);
  bad([rule("x", { type: "tableProps", anchor: "line", table: { treatAsChar: true } })]);
  bad([rule("x", { type: "resize", anchor: "tbl" })]);
  bad([rule("x", { type: "resize", anchor: "tbl", columns: [1], width: 5 })]);
  bad([rule("x", { type: "resize", anchor: "tbl", width: 5, scale: 2 })]);
  bad([rule("x", { type: "resize", anchor: "tbl", columns: [] })]);
  bad([rule("x", { type: "resize", anchor: "tbl", columns: [0] })]);
  bad([rule("x", { type: "resize", anchor: "tbl", scale: 0 })]);
  bad([rule("x", { type: "resize", anchor: "tbl", rowHeights: [{ row: 0 }] })]);
  bad([rule("x", { type: "resize", anchor: "c", width: 5 })]);
  bad([rule("x", { type: "repeat", anchor: "tbl", each: { path: "items" } })]);
  bad([rule("x", { type: "repeat", anchor: "c" })]);
  bad([rule("x", { type: "repeat", anchor: "c", each: { path: "a b" } })]);
  bad([rule("x", { type: "repeat", anchor: "c", each: { path: "items" }, as: "a.b" })]);
  bad([rule("x", { type: "repeat", anchor: "c", each: { path: "items" }, as: "n", index: "n" })]);
  bad([rule("x", { type: "repeat", anchor: "c", each: { path: "items" }, index: "item" })]);
  bad([rule("x", { type: "inject", anchor: "line", position: "after", fragment: {}, fitTable: "always" })]);
  bad([rule("x", { type: "delete", anchor: "c", scope: "row", fitTable: "allowBreak" })]);
});

// ── tableProps ──────────────────────────────────────────────────

test("tableProps: 표 설정과 셀 설정을 저장 게이트를 거쳐 적용하고 보고서에 남긴다", () => {
  const bytes = plainDoc();
  const t = tpl({
    anchors: [tableAnchor(), cellAnchor("c", 2, 0)],
    rules: [
      rule("t1", { type: "tableProps", anchor: "tbl", table: { treatAsChar: true, pageBreak: "NONE", repeatHeader: false } }),
      rule("t2", { type: "tableProps", anchor: "c", cells: [{ rows: [0, 0], cols: [0, 2], props: { vertAlign: "BOTTOM", header: true } }] }),
    ],
  });
  const r = done(run(bytes, t, {}));
  const after = outerTableXml(sectionText(r.output), 0);
  assert.equal(attrIn(after, "pos", "treatAsChar"), "1");
  assert.equal(attrIn(after, "tbl", "pageBreak"), "NONE");
  assert.equal(attrIn(after, "tbl", "repeatHeader"), "0");
  const row0 = topRows(after)[0] ?? "";
  assert.equal(row0.match(/vertAlign="BOTTOM"/g)?.length, 3);
  assert.equal(row0.match(/header="1"/g)?.length, 3);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.type, a.targets]), [["t1", "tableProps", 1], ["t2", "tableProps", 3]]);
  assert.deepEqual(r.report.plan.expected, {});
  assert.equal(r.report.validation?.newErrors.length, 0);
  // 줄 배치 캐시를 지우는 구역이므로 글 외에는 앞뒤 문단도 그대로다
  assert.deepEqual(parse(r.output).sections[0]?.paragraphs.map((p) => p.logicalText), parse(bytes).sections[0]?.paragraphs.map((p) => p.logicalText));
});

test("tableProps·resize: 같은 표에 규칙이 여럿이어도 같은 속성이 같은 값이면 합쳐지고 다른 값이면 TPL_CONFLICT", () => {
  const bytes = plainDoc();
  const same = tpl({
    anchors: [tableAnchor()],
    rules: [rule("a", { type: "tableProps", anchor: "tbl", table: { pageBreak: "NONE" } }), rule("b", { type: "tableProps", anchor: "tbl", table: { pageBreak: "NONE", treatAsChar: true } })],
  });
  const ok = done(run(bytes, same, {}));
  assert.equal(attrIn(outerTableXml(sectionText(ok.output), 0), "tbl", "pageBreak"), "NONE");
  const clash = tpl({
    anchors: [tableAnchor()],
    rules: [rule("a", { type: "tableProps", anchor: "tbl", table: { pageBreak: "NONE" } }), rule("b", { type: "tableProps", anchor: "tbl", table: { pageBreak: "TABLE" } })],
  });
  assert.deepEqual(failedCodes(run(bytes, clash, {})), ["TPL_CONFLICT"]);
});

test("tableProps: 표가 아닌 앵커·범위 밖 셀 선택·잘못된 표는 오류로 막고 출력이 없다", () => {
  const bytes = plainDoc();
  const noCells = tpl({ anchors: [tableAnchor()], rules: [rule("a", { type: "tableProps", anchor: "tbl", cells: [{ rows: [9, 9], cols: [0, 0], props: { header: true } }] })] });
  assert.deepEqual(failedCodes(run(bytes, noCells, {})), ["TABLE_BAD_ARG"]);
  const missing = tpl({ anchors: [tableAnchor("tbl", 4)], rules: [rule("a", { type: "tableProps", anchor: "tbl", table: { treatAsChar: true } })] });
  assert.deepEqual(failedCodes(run(bytes, missing, {})), ["ANCHOR_NOT_FOUND"]);
});

// ── resize ──────────────────────────────────────────────────────

test("resize: 열 너비·표 너비·비율·행 높이를 바꾸고 행별 너비 합이 표 너비와 같다(B2)", () => {
  const bytes = plainDoc();
  const run1 = (action: Record<string, unknown>): Uint8Array => done(run(bytes, tpl({ anchors: [tableAnchor()], rules: [rule("s", { type: "resize", anchor: "tbl", ...action })] }), {})).output;
  const cols = outerTableXml(sectionText(run1({ columns: [1000, 2000, 3000] })), 0);
  assert.equal(attrIn(cols, "sz", "width"), "6000");
  assert.deepEqual(rowWidthSums(cols), [6000, 6000, 6000]);
  const width = outerTableXml(sectionText(run1({ width: 4501 })), 0);
  assert.equal(attrIn(width, "sz", "width"), "4501");
  assert.deepEqual(rowWidthSums(width), [4501, 4501, 4501]);
  const scale = outerTableXml(sectionText(run1({ scale: 2 })), 0);
  assert.deepEqual(rowWidthSums(scale), [18000, 18000, 18000]);
  const heights = outerTableXml(sectionText(run1({ rowHeights: [{ row: 1, height: 1234 }] })), 0);
  assert.equal(readCells(heights).find((c) => c.row === 1)?.height, 1234);
  // 열 너비와 행 높이를 한 규칙에
  const both = outerTableXml(sectionText(run1({ columns: [1000, 2000, 3000], rowHeights: [{ row: 0, height: 100 }] })), 0);
  assert.deepEqual(rowWidthSums(both), [6000, 6000, 6000]);
  assert.equal(readCells(both).find((c) => c.row === 0)?.height, 100);
});

test("resize 거절: 열 수가 다르면 TABLE_BAD_ARG, 너비 기준이 절대값이 아니면 TABLE_RELATIVE_SIZE, 불규칙 표는 TABLE_IRREGULAR", () => {
  const t = (action: Record<string, unknown>) => tpl({ anchors: [tableAnchor()], rules: [rule("s", { type: "resize", anchor: "tbl", ...action })] });
  assert.deepEqual(failedCodes(run(plainDoc(), t({ columns: [1, 2] }), {})), ["TABLE_BAD_ARG"]);
  assert.deepEqual(failedCodes(run(plainDoc({ widthRelTo: "PAPER" }), t({ width: 100 }), {})), ["TABLE_RELATIVE_SIZE"]);
  const d4 = loadDoc("D4");
  const broken = listTables(d4).find((x) => !x.regular);
  assert.ok(broken !== undefined);
  const tt = tpl({ anchors: [tableAnchor("tbl", broken.topOrdinal ?? 0)], rules: [rule("s", { type: "resize", anchor: "tbl", scale: 2 })] });
  assert.deepEqual(failedCodes(generate(d4.pkg.bytes, tt, ds({}))), ["TABLE_IRREGULAR"]);
});

// ── repeat (B6) ─────────────────────────────────────────────────

test("B6 repeat: 배열 길이 여럿 — 행 수·주소·값(원소·순번·전체 데이터)·수량 예고·검사를 모두 확인한다", () => {
  const bytes = listDoc();
  const r = done(run(bytes, repeatTemplate(), { items: items(3), project: "알파" }));
  assert.deepEqual(rowsText(r.output), ["번호|이름|내용", "1|이름1|비고1 / 알파", "2|이름2|비고2 / 알파", "3|이름3|비고3 / 알파", "합계"]);
  const tbl = outerTableXml(sectionText(r.output), 0);
  assert.equal(attrIn(tbl, "tbl", "rowCnt"), "5");
  assert.deepEqual(readCells(tbl).filter((c) => c.col === 0 && c.colSpan === 1).map((c) => c.row), [0, 1, 2, 3]);
  assert.deepEqual(readCells(tbl).filter((c) => c.colSpan === 3).map((c) => c.row), [4], "병합 행은 4로 밀렸다");
  assert.deepEqual(rowWidthSums(tbl), [9000, 9000, 9000, 9000, 9000]);
  assert.equal(attrIn(tbl, "tbl", "repeatHeader"), "1", "제목 행 반복 설정은 그대로");
  assert.deepEqual(r.report.plan.expected, { paragraphs: 6, tableRows: 2, tableCells: 6 }, "원형 행의 문단·셀 3개 × 추가 2행");
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.type, a.targets]), [["r1", "repeat", 3]]);
  assert.deepEqual(r.report.plan.requiredPaths.sort(), ["items", "project"]);
  assert.deepEqual(r.report.stages.map((s) => s.label), ["main", "repeat:r1"]);
  assert.ok(r.report.reread.paragraphs >= 9, "반복한 행의 글을 다시 읽어 확인했다");
  assert.equal(validateDocument(r.output).errors.length, 0);
  // 남은 {{}}가 없다
  assert.ok(!sectionText(r.output).includes("{{"));
  // 같은 입력은 같은 바이트
  const again = done(run(bytes, repeatTemplate(), { items: items(3), project: "알파" }));
  assert.equal(sha256Hex(again.output), sha256Hex(r.output));
  assert.deepEqual(again.ledger, r.ledger);
});

test("B6 repeat: 배열 길이 1 — 원형 행이 그 원소로 채워진 한 행이 된다", () => {
  const r = done(run(listDoc(), repeatTemplate(), { items: items(1), project: "알파" }));
  assert.deepEqual(rowsText(r.output), ["번호|이름|내용", "1|이름1|비고1 / 알파", "합계"]);
  assert.equal(attrIn(outerTableXml(sectionText(r.output), 0), "tbl", "rowCnt"), "3");
  assert.deepEqual(r.report.plan.expected, {});
});

test("B6 repeat: 배열 길이 0 — 원형 행을 지운다(행 삭제 규칙과 같다). 보고서에는 repeat 0행으로 남는다", () => {
  const r = done(run(listDoc(), repeatTemplate(), { items: [], project: "알파" }));
  assert.deepEqual(rowsText(r.output), ["번호|이름|내용", "합계"]);
  const tbl = outerTableXml(sectionText(r.output), 0);
  assert.equal(attrIn(tbl, "tbl", "rowCnt"), "2");
  assert.deepEqual(readCells(tbl).map((c) => c.row), [0, 0, 0, 1], "뒤 행 주소가 당겨졌다");
  assert.deepEqual(r.report.plan.expected, { paragraphs: -3, tableRows: -1, tableCells: -3 });
  assert.deepEqual(r.report.plan.actions.map((a) => [a.type, a.targets]), [["repeat", 0]]);
  // 원형 행이 세로 병합에 걸려 있으면 행 삭제 규칙대로 FILL_ROW_SPAN
  const spec = listSpec();
  spec.cells = spec.cells.map((c) => (c.row === 0 && c.col === 0 ? { ...c, rowSpan: 2, height: 1300 } : c)).filter((c) => !(c.row === 1 && c.col === 0));
  const bytes = docOf([tableParagraph({ ...spec, repeatHeader: true })]);
  const t = tpl({ anchors: [cellAnchor("row", 1, 1)], rules: [rule("r1", { type: "repeat", anchor: "row", each: { path: "items" } })] });
  assert.deepEqual(failedCodes(run(bytes, t, { items: [] })), ["FILL_ROW_SPAN"]);
});

test("B6 repeat: 마지막 남은 행까지 지우면 표를 담은 문단을 지운다", () => {
  const bytes = docOf([textPara("앞"), tableParagraph(gridTable([5000], 1, [["{{item}}"]])), textPara("뒤")]);
  const t = tpl({ anchors: [cellAnchor("row", 0)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "xs" } })] });
  const r = done(run(bytes, t, { xs: [] }));
  assert.deepEqual(parse(r.output).sections[0]?.paragraphs.map((p) => p.logicalText), ["앞", "뒤"]);
  assert.deepEqual(r.report.plan.expected, { paragraphs: -2, tables: -1, tableRows: -1, tableCells: -1 });
});

test("B6 repeat: 병합 셀이 든 원형 행(가로 병합)과 제목 행 반복이 켜진 표", () => {
  const spec: TableSpec = {
    id: "5002",
    rowCnt: 3,
    colCnt: 3,
    repeatHeader: true,
    cells: [
      { row: 0, col: 0, colSpan: 3, width: 9000, height: 500, text: "목록", header: true },
      { row: 1, col: 0, colSpan: 2, width: 5000, height: 700, text: "{{item.name}}" },
      { row: 1, col: 2, width: 4000, height: 700, text: "{{item.note}}" },
      { row: 2, col: 0, width: 2000, height: 600, text: "끝" },
      { row: 2, col: 1, width: 3000, height: 600, text: "" },
      { row: 2, col: 2, width: 4000, height: 600, text: "" },
    ],
  };
  const bytes = docOf([tableParagraph(spec)]);
  const t = tpl({ anchors: [cellAnchor("row", 1, 0)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "items" } })] });
  const r = done(run(bytes, t, { items: items(4) }));
  const tbl = outerTableXml(sectionText(r.output), 0);
  assert.equal(attrIn(tbl, "tbl", "rowCnt"), "6", "3행에서 원형 행 하나가 4행이 되어 6행");
  assert.deepEqual(readCells(tbl).filter((c) => c.row >= 1 && c.row <= 4).map((c) => [c.row, c.col, c.colSpan]), [[1, 0, 2], [1, 2, 1], [2, 0, 2], [2, 2, 1], [3, 0, 2], [3, 2, 1], [4, 0, 2], [4, 2, 1]]);
  assert.deepEqual(rowWidthSums(tbl), Array(6).fill(9000));
  assert.deepEqual(rowsText(r.output).slice(1, 5), ["이름1|비고1", "이름2|비고2", "이름3|비고3", "이름4|비고4"]);
  assert.equal(attrIn(tbl, "tbl", "repeatHeader"), "1");
  assert.match(topRows(tbl)[0] ?? "", /header="1"/, "제목 셀 표시는 그대로");
});

test("repeat: as·index 이름과 스칼라 원소, 값의 XML 특수문자", () => {
  const bytes = docOf([tableParagraph(gridTable([3000, 3000], 2, [["x", "y"], ["{{p}}", "{{idx}}"]]))]);
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "xs" }, as: "p", index: "idx" })] });
  const r = done(run(bytes, t, { xs: ["가&나", "<b>"] }));
  assert.deepEqual(rowsText(r.output).slice(1), ["가&amp;나|1", "&lt;b&gt;|2"]);
  assert.deepEqual(parse(r.output).sections[0]?.paragraphs[0]?.subLists.map((s) => s.paragraphs[0]?.logicalText), ["x", "y", "가&나", "1", "<b>", "2"]);
});

test("repeat 오류: 배열이 아니면 DATA_NOT_ARRAY, 값이 없으면 정책을 따른다(error는 DATA_MISSING, empty는 0행, keep은 그대로)", () => {
  const bytes = listDoc();
  for (const bad of [{ a: 1 }, "문자", 5, true]) assert.deepEqual(failedCodes(run(bytes, repeatTemplate(), { items: bad, project: "x" })), ["DATA_NOT_ARRAY"]);
  assert.deepEqual(failedCodes(run(bytes, repeatTemplate(), { project: "x" })), ["DATA_MISSING"]);
  assert.deepEqual(failedCodes(run(bytes, repeatTemplate(), { items: null, project: "x" })), ["DATA_MISSING"]);
  // empty: 값이 없는 배열은 0개로 본다(원형 행 삭제)
  const empty = done(run(bytes, repeatTemplate(), { project: "x" }, { missing: "empty" }));
  assert.deepEqual(rowsText(empty.output), ["번호|이름|내용", "합계"]);
  assert.deepEqual(empty.report.plan.missingPaths, ["items"]);
  // keep: 원형 행을 그대로 두고 그 안의 {{}}도 그대로 둔다
  const keep = done(run(bytes, repeatTemplate(), { project: "x" }, { missing: "keep" }));
  // 원형 행은 통째로 그대로다(그 안의 문서 전체 `{{project}}`도 채우지 않는다)
  assert.deepEqual(rowsText(keep.output), ["번호|이름|내용", "{{no}}|{{item.name}}|{{item.note}} / {{project}}", "합계"]);
  assert.ok(keep.report.plan.kept.some((k) => k.path === "items"));
});

test("repeat 오류: 원소에 필요한 값이 없으면 누락 정책을 따르고 값에 줄바꿈이 있으면 VALUE_CONTROL_CHAR", () => {
  const bytes = listDoc();
  assert.deepEqual(failedCodes(run(bytes, repeatTemplate(), { items: [{ name: "a" }], project: "p" })), ["DATA_MISSING"]);
  const empty = done(run(bytes, repeatTemplate(), { items: [{ name: "a" }], project: "p" }, { missing: "empty" }));
  assert.deepEqual(rowsText(empty.output).slice(1, 2), ["1|a| / p"]);
  assert.ok(empty.report.plan.missingPaths.includes("item.note"));
  assert.deepEqual(failedCodes(run(bytes, repeatTemplate(), { items: [{ name: "a\nb", note: "n" }], project: "p" })), ["VALUE_CONTROL_CHAR"]);
  assert.deepEqual(failedCodes(run(bytes, repeatTemplate(), { items: [{ name: { x: 1 }, note: "n" }], project: "p" })), ["DATA_NOT_SCALAR"]);
});

test("repeat: 원형 행이 세로 병합에 걸리면 TABLE_SPAN_CONFLICT, 원형 행을 못 찾으면 ANCHOR_NOT_FOUND", () => {
  const spec: TableSpec = {
    rowCnt: 3,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, rowSpan: 3, width: 2000, height: 2100, text: "세로" },
      { row: 0, col: 1, width: 3000, height: 700, text: "a" },
      { row: 1, col: 1, width: 3000, height: 700, text: "{{item}}" },
      { row: 2, col: 1, width: 3000, height: 700, text: "c" },
    ],
  };
  const bytes = docOf([tableParagraph(spec)]);
  const t = tpl({ anchors: [cellAnchor("row", 1, 1)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "xs" } })] });
  assert.deepEqual(failedCodes(run(bytes, t, { xs: ["a", "b"] })), ["TABLE_SPAN_CONFLICT"]);
  const missing = tpl({ anchors: [cellAnchor("row", 7, 1)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "xs" } })] });
  assert.ok(failedCodes(run(bytes, missing, { xs: ["a"] })).includes("ANCHOR_NOT_FOUND"));
});

test("repeat와 다른 규칙: 열 너비 변경이 복사본에 이어지고, 같은 표의 다른 행 삭제·두 번째 반복도 함께 된다", () => {
  const bytes = listDoc();
  // resize(열 너비)와 tableProps(셀 설정)는 주 계획에서 먼저 적용되고 복사본은 그 위에서 만들어진다
  const t = repeatTemplate([
    rule("w", { type: "resize", anchor: "tbl", columns: [1000, 2000, 3000] }),
    rule("p", { type: "tableProps", anchor: "tbl", cells: [{ rows: [1, 1], cols: [0, 2], props: { vertAlign: "TOP" } }] }),
  ]);
  const r = done(run(bytes, t, { items: items(2), project: "알파" }));
  const tbl = outerTableXml(sectionText(r.output), 0);
  assert.deepEqual(rowWidthSums(tbl), Array(4).fill(6000));
  assert.equal(topRows(tbl)[1]?.match(/vertAlign="TOP"/g)?.length, 3);
  assert.equal(topRows(tbl)[2]?.match(/vertAlign="TOP"/g)?.length, 3, "복사본도 같은 설정을 갖는다");
  assert.deepEqual(rowsText(r.output), ["번호|이름|내용", "1|이름1|비고1 / 알파", "2|이름2|비고2 / 알파", "합계"]);

  // 합계 행을 지우는 delete와 함께
  const del = repeatTemplate([rule("d", { type: "delete", anchor: "sum", scope: "row" })], [cellAnchor("sum", 2)]);
  const r2 = done(run(bytes, del, { items: items(2), project: "알파" }));
  assert.deepEqual(rowsText(r2.output), ["번호|이름|내용", "1|이름1|비고1 / 알파", "2|이름2|비고2 / 알파"]);
  assert.equal(attrIn(outerTableXml(sectionText(r2.output), 0), "tbl", "rowCnt"), "3");
  assert.deepEqual(r2.report.plan.expected, { paragraphs: 3 - 1, tableCells: 3 - 1 }, "원형 행의 문단·셀 3개 × 추가 1행 − 합계 행 문단·셀 1개(행은 +1 −1 = 0)");
});

test("repeat: 원형 행 안을 가리키는 채움·삭제 규칙은 버리고 보고한다", () => {
  const bytes = listDoc();
  const t = repeatTemplate(
    [rule("f", { type: "fill", anchor: "inner", value: { text: "덮어쓰기" } }), rule("d", { type: "delete", anchor: "inner", scope: "row" })],
    [cellAnchor("inner", 1, 1)],
  );
  const r = done(run(bytes, t, { items: items(2), project: "알파" }));
  assert.deepEqual(rowsText(r.output).slice(1, 3), ["1|이름1|비고1 / 알파", "2|이름2|비고2 / 알파"]);
  assert.deepEqual(r.report.plan.dropped.map((d) => d.ruleId).sort(), ["d", "f"]);
});

test("repeat: 같은 표의 두 행을 각각 반복하고, 표가 둘이면 각각 반복한다", () => {
  const spec: TableSpec = {
    rowCnt: 4,
    colCnt: 1,
    cells: [
      { row: 0, col: 0, width: 5000, height: 500, text: "{{a}}" },
      { row: 1, col: 0, width: 5000, height: 500, text: "구분" },
      { row: 2, col: 0, width: 5000, height: 500, text: "{{b}}" },
      { row: 3, col: 0, width: 5000, height: 500, text: "끝" },
    ],
  };
  const bytes = docOf([tableParagraph(spec), tableParagraph({ ...spec, id: "5009" })]);
  const t = tpl({
    anchors: [cellAnchor("r0", 0), cellAnchor("r2", 2), cellAnchor("s0", 0, 0, 1), cellAnchor("s2", 2, 0, 1)],
    rules: [
      rule("a", { type: "repeat", anchor: "r0", each: { path: "as" }, as: "a" }),
      rule("b", { type: "repeat", anchor: "r2", each: { path: "bs" }, as: "b" }),
      rule("c", { type: "repeat", anchor: "s2", each: { path: "bs" }, as: "b" }),
      rule("d", { type: "repeat", anchor: "s0", each: { path: "as" }, as: "a" }),
    ],
  });
  const r = done(run(bytes, t, { as: ["a1", "a2"], bs: ["b1", "b2", "b3"] }));
  const texts = (n: number): string[] => topRows(outerTableXml(sectionText(r.output), n)).map((x) => [...x.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|"));
  assert.deepEqual(texts(0), ["a1", "a2", "구분", "b1", "b2", "b3", "끝"]);
  assert.deepEqual(texts(1), ["a1", "a2", "구분", "b1", "b2", "b3", "끝"]);
  assert.deepEqual(r.report.stages.map((s) => s.label), ["main", "repeat:a", "repeat:b", "repeat:c", "repeat:d"]);
  assert.equal(listTables(parse(r.output)).every((x) => x.regular), true);
  assert.deepEqual(duplicates(objectIdsIn(sectionText(r.output))), []);
});

test("repeat: 복사본의 인스턴스 id(중첩 표·그림·누름틀 짝)는 새로 받고 검사기 새 오류가 없다", () => {
  const nested = gridTable([1000], 1, [["{{item.name}}"]], { id: "6001" });
  const spec: TableSpec = {
    id: "5001",
    rowCnt: 1,
    colCnt: 1,
    cells: [
      {
        row: 0,
        col: 0,
        width: 5000,
        height: 600,
        paragraphs: [
          paragraph(`<hp:ctrl><hp:fieldBegin id="7001" type="CLICK_HERE" name="필드" editable="1" dirty="1" fieldid="8001"/></hp:ctrl><hp:t>{{item.name}}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="7001" fieldid="8001"/></hp:ctrl><hp:ctrl><hp:bookmark name="BM"/></hp:ctrl><hp:t/>`, "90001"),
          paragraph(`${tableXml(nested)}<hp:t/>`, "90002"),
        ],
      },
    ],
  };
  const bytes = docOf([tableParagraph(spec)]);
  const t = tpl({ anchors: [cellAnchor("row", 0)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "items" } })] });
  const r = done(run(bytes, t, { items: items(3) }));
  const xml = sectionText(r.output);
  assert.deepEqual(duplicates(objectIdsIn(xml)), []);
  assert.deepEqual(duplicates([...xml.matchAll(/<hp:fieldBegin id="(\d+)"/g)].map((m) => m[1] ?? "")), []);
  assert.deepEqual(duplicates([...xml.matchAll(/<hp:bookmark name="([^"]*)"/g)].map((m) => m[1] ?? "")), []);
  assert.equal(validateDocument(r.output).census.tables, 4);
  assert.equal(validateDocument(r.output).census.fieldPairs, 3);
  // 복사본 하나는 바깥 행 1 + 안쪽 표 행 1 = 행 2, 셀도 2개다(추가 복사본 2개)
  assert.deepEqual(r.report.plan.expected, { paragraphs: 2 * 3, tables: 2, fieldPairs: 2, bookmarks: 2, tableRows: 2 * 2, tableCells: 2 * 2 });
  assert.ok(parse(r.output).sections[0]?.paragraphs[0]?.subLists.some((s) => s.paragraphs.some((p) => p.logicalText.includes("이름3"))));
});

test("repeat 게이트: 단계 출력을 일부러 망가뜨리면 값 재읽기·보존 확인이 잡아 출력이 없다", () => {
  const bytes = listDoc();
  const t = repeatTemplate();
  const data = { items: items(2), project: "알파" };
  const tamper = (from: string, to: string): GenerateOptions => ({
    testHooks: {
      afterApply: (output, stage) => {
        if (stage !== "repeat:r1") return output;
        const text = sectionText(output);
        assert.ok(text.includes(from));
        const changed = text.replace(from, to);
        // 같은 길이를 유지해야 ZIP 조립이 쉽다: 이 시험은 바이트 하나를 바꾸는 식으로만 쓴다
        const patched = new TextEncoder().encode(changed);
        return replaceEntry(output, "Contents/section0.xml", patched);
      },
    },
  });
  const codes = failedCodes(run(bytes, t, data, tamper("이름2", "이름9")));
  assert.ok(codes.includes("PRESERVE_SPAN") || codes.includes("REREAD_TEXT"), codes.join(","));
});

function replaceEntry(bytes: Uint8Array, entry: string, data: Uint8Array): Uint8Array {
  const pkg = openPackage(bytes);
  return rewriteArchive(bytes, pkg.archive, { replace: new Map([[entry, data]]) });
}

// ── fitTable ────────────────────────────────────────────────────

function clipDoc(): { bytes: Uint8Array } {
  // 바깥 표(글자처럼 취급) 안 셀 → 안쪽 표(쪽 나눔 없음) 안 셀 안의 문단에 삽입한다
  const inner = gridTable([4000], 1, [["안쪽 셀"]], { id: "6001", pageBreak: "NONE" });
  const outer: TableSpec = {
    id: "5001",
    rowCnt: 1,
    colCnt: 1,
    treatAsChar: true,
    cells: [{ row: 0, col: 0, width: 6000, height: 800, paragraphs: [textPara("바깥 셀"), paragraph(`${tableXml(inner)}<hp:t/>`)] }],
  };
  return { bytes: docOf([textPara("앞"), tableParagraph(outer), textPara("뒤")]) };
}

function lineAnchorOf(bytes: Uint8Array, path: number[], id = "line") {
  const doc = parse(bytes);
  let list = doc.sections[0]?.paragraphs ?? [];
  let found = undefined as undefined | (typeof list)[number];
  path.forEach((n, i) => {
    if (i % 2 === 0) found = list[n];
    else list = found?.subLists[n]?.paragraphs ?? [];
  });
  const text = found?.logicalText ?? "";
  return { id, kind: "line", at: { sectionIndex: 0, path }, print: { text: text.slice(0, 40), sha256: sha256Hex(new TextEncoder().encode(text)) } };
}

test("inject의 fitTable: allowBreak면 감싸는 표 가운데 잘릴 수 있는 표를 쪽을 넘길 수 있게 바꾸고 보고서에 남긴다. 기본은 경고만", () => {
  const { bytes } = clipDoc();
  // 조각: hancom/blocks의 표 문단 하나
  const src = loadDoc("hancom/blocks");
  const fragment = JSON.parse(JSON.stringify(extractFragment(src, selectTable(src, 0, 0).selection)));
  // 삽입 지점: 안쪽 표(6001)의 셀 안 문단 [1, 0, 1, 0, 0] (감싸는 표는 안쪽과 바깥 둘)
  const anchor = lineAnchorOf(bytes, [1, 0, 1, 0, 0]);
  const make = (fit: boolean) => tpl({ anchors: [anchor], rules: [rule("i", { type: "inject", anchor: "line", position: "after", fragment, ...(fit ? { fitTable: "allowBreak" } : {}) })] });

  const plain = done(run(bytes, make(false), {}));
  assert.ok(plain.report.issues.some((i) => i.code === "FRAG_CELL_MAY_CLIP"), "기본은 경고만");
  assert.deepEqual(plain.report.plan.tableChanges, []);
  const byId = (doc: ReturnType<typeof parse>, id: string) => listTables(doc).find((x) => x.target.element.attrs.some((a) => a.qname === "id" && a.value === id));
  const after0 = parse(plain.output);
  assert.equal(byId(after0, "5001")?.treatAsChar, true, "표는 바뀌지 않았다");
  assert.equal(byId(after0, "6001")?.pageBreak, "NONE");

  const fit = done(run(bytes, make(true), {}));
  assert.ok(!fit.report.issues.some((i) => i.code === "FRAG_CELL_MAY_CLIP"), "표를 고쳤으니 경고가 없다");
  const after1 = parse(fit.output);
  const tables = listTables(after1);
  assert.equal(byId(after1, "5001")?.treatAsChar, false);
  assert.equal(byId(after1, "5001")?.pageBreak, "CELL");
  assert.equal(byId(after1, "6001")?.pageBreak, "CELL");
  // 바깥 표(글자처럼 취급)는 treatAsChar만, 안쪽 표(쪽 나눔 없음)는 pageBreak만 바뀐다
  assert.deepEqual(fit.report.plan.tableChanges.map((c) => c.change).sort(), ["pageBreak NONE→CELL", "treatAsChar 1→0"]);
  assert.deepEqual(fit.report.plan.tableChanges.map((c) => c.ruleId), ["i", "i"]);
  assert.ok(fit.report.plan.tableChanges.every((c) => /^구역 0 표 id=\d+$/.test(c.table)));
  assert.equal(validateDocument(fit.output).errors.length, 0);
  // 삽입된 표가 셀 안에 들어갔다: 표 3개
  assert.equal(tables.length, 3);
});

test("fitTable: 잘리지 않는 표나 표 밖 삽입은 아무것도 바꾸지 않는다", () => {
  const safe = docOf([textPara("앞"), tableParagraph(gridTable([5000], 1, [["셀"]], { id: "7001", pageBreak: "CELL" })), textPara("뒤")]);
  const src = loadDoc("hancom/blocks");
  const fragment = JSON.parse(JSON.stringify(extractFragment(src, selectTable(src, 0, 0).selection)));
  for (const path of [[1, 0, 0], [0]]) {
    const t = tpl({ anchors: [lineAnchorOf(safe, path)], rules: [rule("i", { type: "inject", anchor: "line", position: "after", fragment, fitTable: "allowBreak" })] });
    const r = done(run(safe, t, {}));
    assert.deepEqual(r.report.plan.tableChanges, [], path.join("."));
    assert.equal(listTables(parse(r.output))[0]?.pageBreak, "CELL");
  }
});

test("행 반복의 값 재읽기: 반복한 행의 글이 계획 단계에서 채워 본 글과 다르면 REREAD_TEXT를 낸다", () => {
  const bytes = listDoc();
  const t = repeatTemplate();
  const data = { items: items(3), project: "알파" };
  const built = buildFillPlan(parse(bytes), t, ds(data));
  const step = built.plan.repeats[0];
  assert.ok(step !== undefined);
  assert.equal(step.texts.length, 3);
  const out = done(run(bytes, t, data)).output;
  const next = parse(out);
  const table = listTables(next)[0]?.target.element;
  const firstRow = table?.children.filter((c): c is NonNullable<typeof table> => "local" in c && c.local === "tr")[1];
  assert.ok(firstRow !== undefined);
  assert.deepEqual(verifyRepeat(next, step, firstRow.start), []);
  // 기대 글을 하나 바꾸면 그 행의 그 문단이 다르다고 나온다
  const wrong = { ...step, texts: step.texts.map((row, i) => (i === 1 ? row.map((x, k) => (k === 1 ? `${x}!` : x)) : row)) };
  const issues = verifyRepeat(next, wrong, firstRow.start);
  assert.deepEqual(issues.map((i) => i.code), ["REREAD_TEXT"]);
  assert.match(issues[0]?.message ?? "", /2번째 행의 문단 1/);
  // 행 수가 다르면(기대는 4개) 행 수 불일치
  const more = verifyRepeat(next, { ...step, items: [...step.items, {}], texts: [...step.texts, []] }, firstRow.start);
  assert.deepEqual(more.map((i) => i.code), ["REREAD_TEXT"]);
  // 다른 곳을 가리키면 첫 행을 찾지 못한다
  assert.deepEqual(verifyRepeat(next, step, 3).map((i) => i.code), ["REREAD_TEXT"]);
});

test("fitTable: 쪽 나눔이 TABLE(행 단위로만 나눔)인 표도 한컴에서 긴 셀 내용을 자르므로 CELL로 바꾼다", () => {
  const spec = gridTable([5000], 1, [["셀"]], { id: "7002", pageBreak: "TABLE" });
  const bytes = docOf([textPara("앞"), tableParagraph(spec), textPara("뒤")]);
  const src = loadDoc("hancom/blocks");
  const fragment = JSON.parse(JSON.stringify(extractFragment(src, selectTable(src, 0, 0).selection)));
  const t = tpl({ anchors: [lineAnchorOf(bytes, [1, 0, 0])], rules: [rule("i", { type: "inject", anchor: "line", position: "after", fragment, fitTable: "allowBreak" })] });
  const r = done(run(bytes, t, {}));
  assert.deepEqual(r.report.plan.tableChanges.map((c) => c.change), ["pageBreak TABLE→CELL"]);
  assert.equal(listTables(parse(r.output))[0]?.pageBreak, "CELL");
});

test("repeat: 원형 행이 원래 갖던 없는 서식 참조는 복제로 늘어도 새 오류가 아니라 상속으로 보고한다", () => {
  // 원형 행의 문단이 문서에 없는 스타일(styleIDRef=9)을 가리킨다
  const spec: TableSpec = {
    rowCnt: 2,
    colCnt: 1,
    cells: [
      { row: 0, col: 0, width: 5000, height: 600, text: "머리" },
      { row: 1, col: 0, width: 5000, height: 600, paragraphs: [paragraph("<hp:t>{{item}}</hp:t>").replace('styleIDRef="0"', 'styleIDRef="9"')] },
    ],
  };
  const bytes = docOf([textPara("앞"), tableParagraph(spec)]);
  const t = tpl({ anchors: [cellAnchor("row", 1)], rules: [rule("r", { type: "repeat", anchor: "row", each: { path: "xs" } })] });
  const base = validateDocument(bytes);
  assert.ok(base.errors.some((e) => e.code === "RES_DANGLING"), "원본에 이미 없는 스타일 참조 오류가 있다");
  const r = done(run(bytes, t, { xs: ["a", "b", "c"] }));
  assert.ok(r.report.inherited.danglingRefs.some((d) => d.kind === "style" && d.id === "9" && d.count === 2), JSON.stringify(r.report.inherited.danglingRefs));
  assert.ok(r.report.issues.some((i) => i.code === "GATE_INHERITED"));
  assert.equal(r.report.validation?.newErrors.length, 0);
  assert.deepEqual(rowsText(r.output), ["머리", "a", "b", "c"]);
  // strict는 상속으로 가리지 않고 막는다(원본의 오류가 그대로 있다)
  assert.ok(failedCodes(run(bytes, t, { xs: ["a", "b", "c"] }, { mode: "strict" })).length > 0);
});
