// 4단계 새 표: planCloneTable(문서나 조각의 표를 원형으로 복제해 행·열 수를 맞춘다).
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFragment, listTables, planCloneTable, selectTable, validateDocument, type InsertPoint } from "../src/index.ts";
import { duplicates, loadDoc, objectIdsIn } from "./helpers.ts";
import {
  applyChecked,
  attrIn,
  docOf,
  gridTable,
  outerTableXml,
  paragraph,
  readCells,
  reparseBytes,
  rowWidthSums,
  sectionText,
  singleTableDoc,
  tableParagraph,
  tableXml,
  target,
  textPara,
  topRows,
  type CellSpec,
  type TableSpec,
} from "./table-helpers.ts";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, `${code}가 나와야 한다`);
}

const at = (index: number, position: "before" | "after" = "after", parentPath: number[] = []): InsertPoint => ({ sectionIndex: 0, parentPath, index, position });
const rowTexts = (tbl: string): string[] => topRows(tbl).map((r) => [...r.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|"));
const cellInfo = (tbl: string): string[] => readCells(tbl).map((c) => `${c.row},${c.col}:${c.rowSpan}x${c.colSpan}@${c.width}x${c.height}`);

const source = (): TableSpec => gridTable([2000, 3000], 3, [["h1", "h2"], ["a", "b"], ["c", "d"]], { id: "4001", repeatHeader: true }, 700);

test("같은 문서의 표를 복제하면 표를 담은 문단이 새 문단으로 들어가고 글은 비며(clear) 표 id는 새로 받는다", () => {
  const { doc, bytes: original } = singleTableDoc(source());
  const plan = planCloneTable(doc, at(2), { table: target(doc) });
  assert.equal(plan.summary["insertedParagraphs"], 1 + 6, "문단 하나와 셀 문단 6개");
  assert.equal(plan.summary["insertedTables"], 1);
  const { bytes, doc: after } = applyChecked(doc, plan);
  const tables = listTables(after);
  assert.equal(tables.length, 2);
  assert.deepEqual(after.sections[0]?.paragraphs.map((p) => p.logicalText.replace(/￼/g, "T")), ["앞 문단", "T", "뒤 문단", "T"]);
  const first = outerTableXml(sectionText(bytes), 0);
  const second = outerTableXml(sectionText(bytes), 1);
  assert.deepEqual(objectIdsIn(sectionText(bytes)).length, 2);
  assert.deepEqual(duplicates(objectIdsIn(sectionText(bytes))), []);
  assert.notEqual(attrIn(second, "tbl", "id"), "4001");
  assert.equal(first, outerTableXml(sectionText(original), 0).replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, ""), "원형 표는 그대로");
  // 복제본: 같은 행·열·크기·속성, 글은 비었다
  assert.equal(attrIn(second, "tbl", "rowCnt"), "3");
  assert.equal(attrIn(second, "tbl", "repeatHeader"), "1");
  assert.deepEqual(cellInfo(second), cellInfo(first));
  assert.deepEqual(rowTexts(second), ["|", "|", "|"], "셀의 hp:t는 남고 글만 비었다");
  // keep은 글을 유지한다
  const keep = applyChecked(doc, planCloneTable(doc, at(0, "before"), { table: target(doc) }, { text: "keep" }));
  assert.deepEqual(rowTexts(outerTableXml(sectionText(keep.bytes), 0)), ["h1|h2", "a|b", "c|d"]);
});

test("행·열 수 맞추기: 늘리면 마지막 행·열을 복제하고 줄이면 뒤 행·열을 지운다. 행별 너비 합은 표 너비와 같다", () => {
  const { doc } = singleTableDoc(source());
  const clone = (options: { rows?: number; cols?: number; text?: "clear" | "keep" }): string => {
    const { bytes } = applyChecked(doc, planCloneTable(doc, at(2), { table: target(doc) }, options));
    return outerTableXml(sectionText(bytes), 1);
  };
  const grow = clone({ rows: 5, cols: 4, text: "keep" });
  assert.equal(attrIn(grow, "tbl", "rowCnt"), "5");
  assert.equal(attrIn(grow, "tbl", "colCnt"), "4");
  assert.deepEqual(rowTexts(grow), ["h1|h2|h2|h2", "a|b|b|b", "c|d|d|d", "c|d|d|d", "c|d|d|d"]);
  assert.equal(attrIn(grow, "sz", "width"), String(2000 + 3 * 3000));
  assert.ok(rowWidthSums(grow).every((w) => w === 11000));
  const shrink = clone({ rows: 2, cols: 1, text: "keep" });
  assert.equal(attrIn(shrink, "tbl", "rowCnt"), "2");
  assert.equal(attrIn(shrink, "tbl", "colCnt"), "1");
  assert.deepEqual(rowTexts(shrink), ["h1", "a"]);
  assert.equal(attrIn(shrink, "sz", "width"), "2000");
  // 행만, 열만
  assert.equal(attrIn(clone({ rows: 1 }), "tbl", "rowCnt"), "1");
  assert.equal(attrIn(clone({ cols: 2 }), "tbl", "colCnt"), "2");
});

test("병합이 든 표를 복제해 행·열을 늘리고 줄인다(세로 병합은 늘리거나 줄인다)", () => {
  const cells: CellSpec[] = [
    { row: 0, col: 0, colSpan: 2, width: 5000, height: 600, text: "제목" },
    { row: 1, col: 0, rowSpan: 2, width: 2000, height: 1200, text: "세로" },
    { row: 1, col: 1, width: 3000, height: 600, text: "b" },
    { row: 2, col: 1, width: 3000, height: 600, text: "c" },
  ];
  const { doc } = singleTableDoc({ rowCnt: 3, colCnt: 2, cells });
  const out = (o: { rows?: number; cols?: number }): string => outerTableXml(sectionText(applyChecked(doc, planCloneTable(doc, at(2), { table: target(doc) }, o)).bytes), 1);
  // 행 늘리기: 마지막 행(세로 병합이 덮는다)을 복제하므로 세로 병합이 늘어난다
  assert.deepEqual(cellInfo(out({ rows: 4 })), ["0,0:1x2@5000x600", "1,0:3x1@2000x1800", "1,1:1x1@3000x600", "2,1:1x1@3000x600", "3,1:1x1@3000x600"]);
  // 행 줄이기: 세로 병합이 남은 행까지로 줄어든다
  assert.deepEqual(cellInfo(out({ rows: 2 })), ["0,0:1x2@5000x600", "1,0:1x1@2000x600", "1,1:1x1@3000x600"]);
  // 열 늘리기: 가로 병합이 늘어난다
  assert.deepEqual(cellInfo(out({ cols: 3 })), ["0,0:1x3@8000x600", "1,0:2x1@2000x1200", "1,1:1x1@3000x600", "1,2:1x1@3000x600", "2,1:1x1@3000x600", "2,2:1x1@3000x600"]);
});

test("복제본의 인스턴스 id(중첩 표·그림·누름틀 짝·책갈피·문단)는 새로 받고 검사기 새 오류가 없다", () => {
  const nested = gridTable([1000], 1, [["안"]], { id: "6001" });
  const rich = paragraph(
    `<hp:ctrl><hp:fieldBegin id="7001" type="CLICK_HERE" name="필드" editable="1" dirty="1" fieldid="8001"/></hp:ctrl><hp:t>값</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="7001" fieldid="8001"/></hp:ctrl>` +
      `<hp:ctrl><hp:bookmark name="BM"/></hp:ctrl><hp:t/>`,
    "90001",
  );
  const spec: TableSpec = {
    id: "5001",
    rowCnt: 1,
    colCnt: 1,
    cells: [{ row: 0, col: 0, width: 5000, height: 600, paragraphs: [rich, paragraph(`${tableXml(nested)}<hp:t/>`, "90002")] }],
  };
  const { doc } = singleTableDoc(spec);
  const { bytes } = applyChecked(doc, planCloneTable(doc, at(2), { table: target(doc) }, { text: "keep" }));
  const xml = sectionText(bytes);
  assert.deepEqual(duplicates(objectIdsIn(xml)), []);
  assert.equal(objectIdsIn(xml).length, 4);
  const begins = [...xml.matchAll(/<hp:fieldBegin id="(\d+)"/g)].map((m) => m[1]);
  const ends = [...xml.matchAll(/<hp:fieldEnd beginIDRef="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(duplicates(begins as string[]), []);
  assert.deepEqual([...(ends as string[])].sort(), [...(begins as string[])].sort());
  assert.deepEqual(duplicates([...xml.matchAll(/<hp:bookmark name="([^"]*)"/g)].map((m) => m[1] ?? "")), []);
  assert.deepEqual(duplicates([...xml.matchAll(/<hp:p id="(\d+)"/g)].map((m) => m[1] ?? "").filter((v) => v !== "0")), []);
  const census = validateDocument(bytes).census;
  assert.equal(census.tables, 4);
  assert.equal(census.fieldPairs, 2);
  assert.equal(census.bookmarks, 2);
});

test("표 안(하위 목록)에 넣거나 중첩 표를 원형으로 쓸 수 있다", () => {
  const nested = gridTable([1000, 1000], 1, [["x", "y"]], { id: "6001" });
  const outer: TableSpec = { id: "5001", rowCnt: 1, colCnt: 1, cells: [{ row: 0, col: 0, width: 5000, height: 600, paragraphs: [textPara("앞"), paragraph(`${tableXml(nested)}<hp:t/>`)] }] };
  const doc = reparseBytes(docOf([tableParagraph(outer)]));
  const tables = listTables(doc);
  const inner = tables.find((t) => t.depth === 1);
  assert.ok(inner !== undefined);
  // 중첩 표를 원형으로 같은 셀의 첫 문단 앞에 넣는다: 새 문단은 최상위가 아니라 그 셀 안에 들어간다
  const plan = planCloneTable(doc, at(0, "before", [0, 0]), { table: inner.target }, { rows: 2, text: "keep" });
  const { bytes, doc: after } = applyChecked(doc, plan);
  const all = listTables(after);
  assert.equal(all.length, 3);
  assert.equal(all.filter((t) => t.depth === 1).length, 2);
  assert.deepEqual(duplicates(objectIdsIn(sectionText(bytes))), []);
  assert.equal(all.find((t) => t.depth === 1 && t.rowCnt === 2)?.colCnt, 2);
});

test("조각 안의 표를 복제하면 planImport가 자원을 대상에 맞추고 표를 담은 문단만 넣는다", () => {
  const src = loadDoc("hancom/ph-table");
  const fragment = extractFragment(src, selectTable(src, 0, 0).selection);
  const dst = loadDoc("hancom/blocks");
  const plan = planCloneTable(dst, at(1), { fragment }, { rows: 4, cols: 3 });
  assert.ok(plan.summary["insertedTables"] === 1);
  const { bytes, doc: after } = applyChecked(dst, plan);
  const tables = listTables(after);
  assert.equal(tables.length, 2);
  const made = tables.find((t) => t.topOrdinal === 0) ?? tables[0];
  assert.equal(made?.rowCnt, 4);
  assert.equal(made?.colCnt, 3);
  assert.deepEqual(validateDocument(bytes).errors, []);
  // 결정성: 같은 입력이면 같은 바이트
  const again = planCloneTable(dst, at(1), { fragment }, { rows: 4, cols: 3 });
  assert.deepEqual(again.edits, plan.edits);
});

test("여러 문단이 든 조각에서 표를 담은 문단만 넣고 경고 TABLE_FRAGMENT_EXTRA를 낸다", () => {
  const src = loadDoc("D1");
  const found = listTables(src).find((t) => t.topOrdinal === 0);
  assert.ok(found !== undefined);
  const index = found.paragraphPath[0] ?? 0;
  const fragment = extractFragment(src, { sectionIndex: 0, parentPath: [], from: Math.max(0, index - 1), to: index });
  const dst = loadDoc("D5");
  const plan = planCloneTable(dst, at(0), { fragment }, {});
  assert.ok(plan.issues.some((i) => i.code === "TABLE_FRAGMENT_EXTRA"));
  const { doc: after } = applyChecked(dst, plan);
  assert.equal(listTables(after).length, listTables(dst).length + 1);
  assert.equal(plan.summary["insertedTables"], 1);
});

test("거절: 인자·삽입 지점·표 찾기·구역 설정 문단·불규칙 원형", () => {
  const { doc } = singleTableDoc(source());
  const t = target(doc);
  expectCode(() => planCloneTable(doc, at(2), { table: t }, { rows: 0 }), "TABLE_BAD_ARG");
  expectCode(() => planCloneTable(doc, at(2), { table: t }, { cols: -1 }), "TABLE_BAD_ARG");
  expectCode(() => planCloneTable(doc, at(2), { table: t }, { text: "blank" as never }), "TABLE_BAD_ARG");
  expectCode(() => planCloneTable(doc, at(9), { table: t }, {}), "FRAG_INSERT_POINT");
  expectCode(() => planCloneTable(doc, at(0, "middle" as never), { table: t }, {}), "FRAG_INSERT_POINT");
  const fragment = extractFragment(doc, selectTable(doc, 0, 0).selection);
  expectCode(() => planCloneTable(doc, at(0), { fragment, ordinal: 3 }, {}), "TABLE_NOT_FOUND");
  // 구역 설정이 든 문단의 표
  const secPara = paragraph(`<hp:secPr id="" textDirection="HORIZONTAL"></hp:secPr>${tableXml(gridTable([1000], 1))}<hp:t/>`);
  const withSec = reparseBytes(docOf([secPara, textPara("끝")]));
  expectCode(() => planCloneTable(withSec, at(1), { table: target(withSec) }, {}), "TABLE_BAD_ARG");
  // 불규칙한 원형은 같은 크기로 복제는 되지만(행·열을 바꾸지 않음) 크기를 바꾸면 거절된다
  const d4 = loadDoc("D4");
  const broken = listTables(d4).find((x) => !x.regular);
  assert.ok(broken !== undefined);
  expectCode(() => planCloneTable(d4, at(0), { table: broken.target }, { rows: 2 }), "TABLE_IRREGULAR");
  assert.equal(planCloneTable(d4, at(0), { table: broken.target }, {}).summary["insertedTables"], 1);
});

test("표를 담은 문단이 문단을 가로지르는 누름틀의 끝을 갖고 있으면 복제를 TABLE_SPLITS_FIELD로 거절한다", () => {
  const begin = `<hp:ctrl><hp:fieldBegin id="7001" type="CLICK_HERE" name="n" editable="1" dirty="1" fieldid="97001"/></hp:ctrl>`;
  const end = `<hp:ctrl><hp:fieldEnd beginIDRef="7001" fieldid="97001"/></hp:ctrl>`;
  const bytes = docOf([paragraph(`${begin}<hp:t>시작</hp:t>`), paragraph(`${tableXml(gridTable([3000], 1, [["셀"]]))}${end}<hp:t/>`)]);
  const doc = reparseBytes(bytes);
  expectCode(() => planCloneTable(doc, at(1), { table: target(doc) }, {}), "TABLE_SPLITS_FIELD");
});
