// 3단계 구조(행): planInsertRows·planRepeatRows (B3: 행 수·주소·병합이 맞고 검사기 새 오류가 없고 복제 행의 서식 참조는 원형과 같다).
import assert from "node:assert/strict";
import { test } from "node:test";
import { listTables, planInsertColumns, planInsertRows, planRepeatRows, validateDocument } from "../src/index.ts";
import { duplicates, formatRefsIn, instIdsIn, loadDoc, objectIdsIn } from "./helpers.ts";
import {
  applyChecked,
  attrDiff,
  attrIn,
  docOf,
  gridTable,
  outerTableXml,
  paragraph,
  readCells,
  reparseBytes,
  sectionText,
  segPara,
  singleTableDoc,
  tableParagraph,
  tableXml,
  target,
  topRows,
  type CellSpec,
  type TableSpec,
} from "./table-helpers.ts";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, `${code}가 나와야 한다`);
}

const trs = topRows;
const pic = (id: string): string =>
  `<hp:pic id="${id}" zOrder="2" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${Number(id) + 1}"><hp:sz width="100" widthRelTo="ABSOLUTE" height="100" heightRelTo="ABSOLUTE" protect="0"/></hp:pic>`;
const field = (id: string, name: string, value: string): string =>
  `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="1" fieldid="${Number(id) + 1000}"/></hp:ctrl><hp:t>${value}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${Number(id) + 1000}"/></hp:ctrl>`;
const bookmark = (name: string): string => `<hp:ctrl><hp:bookmark name="${name}"/></hp:ctrl>`;

/** 머리 행 + 풍부한 데이터 행(중첩 표·그림·누름틀·책갈피·문단 id) + 병합 행 + 끝 행 */
function richSpec(): TableSpec {
  const nested = gridTable([1000, 1000], 1, [["안", "표"]], { id: "6001" });
  const rows: CellSpec[] = [
    { row: 0, col: 0, width: 2000, height: 500, text: "번호", header: true },
    { row: 0, col: 1, width: 3000, height: 500, text: "이름", header: true },
    { row: 0, col: 2, width: 4000, height: 500, text: "내용", header: true },
    { row: 1, col: 0, width: 2000, height: 800, paragraphs: [segPara("1", "70001")] },
    { row: 1, col: 1, width: 3000, height: 800, paragraphs: [paragraph(`${field("7001", "필드", "홍길동")}`, "70002")] },
    { row: 1, col: 2, width: 4000, height: 800, paragraphs: [paragraph(`${pic("8001")}${bookmark("책1")}<hp:t/>`, "70003"), paragraph(`${tableXml(nested)}<hp:t/>`, "70004")] },
    { row: 2, col: 0, colSpan: 2, width: 5000, height: 600, text: "병합 행" },
    { row: 2, col: 2, width: 4000, height: 600, text: "끝" },
  ];
  return { id: "5001", rowCnt: 3, colCnt: 3, cells: rows, repeatHeader: true };
}

function ids(bytes: Uint8Array): { objects: string[]; insts: string[]; paragraphs: string[]; begins: string[]; ends: string[]; marks: string[] } {
  const xml = sectionText(bytes);
  return {
    objects: objectIdsIn(xml),
    insts: instIdsIn(xml),
    paragraphs: [...xml.matchAll(/<hp:p id="(\d+)"/g)].map((m) => m[1] ?? "").filter((v) => v !== "0"),
    begins: [...xml.matchAll(/<hp:fieldBegin id="(\d+)"/g)].map((m) => m[1] ?? ""),
    ends: [...xml.matchAll(/<hp:fieldEnd beginIDRef="(\d+)"/g)].map((m) => m[1] ?? ""),
    marks: [...xml.matchAll(/<hp:bookmark name="([^"]*)"/g)].map((m) => m[1] ?? ""),
  };
}

test("B3: 행 삽입 — 행 수·행 주소·뒤 행 이동·표 높이, 복제 행의 서식 참조는 원형과 같다", () => {
  const { doc } = singleTableDoc(gridTable([2000, 3000, 4000], 4, [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"], ["j", "k", "l"]], {}, 700));
  const before = outerTableXml(sectionText(doc.pkg.bytes));
  const { bytes } = applyChecked(doc, planInsertRows(doc, target(doc), { prototype: 1, count: 2, text: "keep" }));
  const tbl = outerTableXml(sectionText(bytes));
  assert.equal(attrIn(tbl, "tbl", "rowCnt"), "6");
  assert.equal(trs(tbl).length, 6);
  assert.deepEqual(readCells(tbl).map((c) => c.row), [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]);
  // 새 행(2, 3)은 원형(행 1)의 글을 유지하고, 뒤 행(원래 2, 3)은 4, 5로 옮겨졌다
  assert.deepEqual(trs(tbl).map((r) => [...r.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("")), ["abc", "def", "def", "def", "ghi", "jkl"]);
  // 서식 참조(글자·문단·스타일·테두리)는 원형과 같다: 행 1의 참조 목록 = 새 행들의 참조 목록
  const refsOf = (row: string): string => JSON.stringify(formatRefsIn(row));
  assert.equal(refsOf(trs(tbl)[2] ?? ""), refsOf(trs(before)[1] ?? ""));
  assert.equal(refsOf(trs(tbl)[3] ?? ""), refsOf(trs(before)[1] ?? ""));
  // 너비는 그대로, 표 높이는 행 합(2800 → 4200)
  assert.deepEqual(readCells(tbl).filter((c) => c.row === 2).map((c) => c.width), [2000, 3000, 4000]);
  assert.equal(attrIn(before, "sz", "height"), "2800");
  assert.equal(attrIn(tbl, "sz", "height"), "4200");
});

test("행 삽입: before는 원형 앞에, clear(기본)는 글을 비운다", () => {
  const { doc } = singleTableDoc(gridTable([2000, 3000], 3, [["a", "b"], ["c", "d"], ["e", "f"]], {}, 700));
  const { bytes } = applyChecked(doc, planInsertRows(doc, target(doc), { prototype: 0, position: "before" }));
  const tbl = outerTableXml(sectionText(bytes));
  assert.deepEqual(trs(tbl).map((r) => [...r.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("")), ["", "ab", "cd", "ef"]);
  assert.deepEqual(readCells(tbl).map((c) => c.row), [0, 0, 1, 1, 2, 2, 3, 3]);
  // 새 행의 hp:t는 비어 있다(구조는 같다)
  assert.match(trs(tbl)[0] ?? "", /<hp:t><\/hp:t>|<hp:t\/>/);
  // 기본은 원형 뒤
  const after = applyChecked(doc, planInsertRows(doc, target(doc), { prototype: 2 })).bytes;
  assert.deepEqual(trs(outerTableXml(sectionText(after))).map((r) => [...r.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("")), ["ab", "cd", "ef", ""]);
});

test("B1: 행 삽입은 새 행·행 수·뒤 행 주소·표 높이만 바꾸고 나머지는 그대로다", () => {
  const { doc } = singleTableDoc(gridTable([2000, 3000], 3, [], {}, 700));
  const { bytes } = applyChecked(doc, planInsertRows(doc, target(doc), { prototype: 1 }));
  assert.equal(attrDiff(sectionText(doc.pkg.bytes), sectionText(bytes)).structural, true, "행이 늘었으니 구조가 바뀐다");
  // 구조가 바뀌어 속성 비교는 못 하지만, 앞 행 0·원형 행 1의 원문은 글자 그대로다
  const a = trs(outerTableXml(sectionText(doc.pkg.bytes)));
  const b = trs(outerTableXml(sectionText(bytes)));
  assert.equal(b[0], a[0]);
  assert.equal(b[1], a[1]);
  // 앞뒤 문단은 줄 배치 캐시를 빼면 그대로
  assert.equal(sectionText(bytes).split(outerTableXml(sectionText(bytes)))[0], sectionText(doc.pkg.bytes).split(outerTableXml(sectionText(doc.pkg.bytes)))[0]);
});

test("복제한 행 안의 인스턴스 id(중첩 표·그림·누름틀 짝·문단)와 책갈피 이름을 새로 준다. 원형의 값은 그대로", () => {
  const { doc, bytes: original } = singleTableDoc(richSpec());
  const baseline = ids(original);
  const { bytes } = applyChecked(doc, planInsertRows(doc, target(doc), { prototype: 1, count: 2, text: "keep" }));
  const now = ids(bytes);
  assert.deepEqual(duplicates(now.objects), [], "개체 id 중복");
  assert.deepEqual(duplicates(now.insts), [], "instId 중복");
  assert.deepEqual(duplicates(now.paragraphs), [], "문단 id 중복");
  assert.deepEqual(duplicates(now.begins), [], "누름틀 시작 id 중복");
  assert.deepEqual(duplicates(now.marks), [], "책갈피 이름 중복");
  // 개수: 누름틀 1 → 3, 책갈피 1 → 3 (중첩 표와 그림은 복사본마다 하나씩)
  assert.equal(now.objects.length, baseline.objects.length + 2 * 2, "복사본마다 중첩 표와 그림의 개체 id가 하나씩 는다");
  assert.equal(now.begins.length, 3);
  assert.equal(now.marks.length, 3);
  // 누름틀 짝: 각 끝이 가리키는 시작이 있고 1:1이다
  assert.deepEqual([...now.ends].sort(), [...now.begins].sort());
  // 원형 행의 값은 그대로(원래 id가 남아 있다)
  for (const v of baseline.objects) assert.ok(now.objects.includes(v));
  assert.ok(now.begins.includes("7001"));
  assert.deepEqual(now.marks.slice(0, 1), ["책1"]);
  assert.deepEqual(now.marks.slice(1), ["책1_1", "책1_2"]);
  // 검사기: 새 오류 0(applyChecked), 수량: 문단·표·그림이 복제 수만큼 늘었다
  const after = validateDocument(bytes).census;
  const prev = validateDocument(original).census;
  assert.equal(after.tables, prev.tables + 2);
  assert.equal(after.pictures, prev.pictures + 2);
  assert.equal(after.fieldPairs, prev.fieldPairs + 2);
  assert.equal(after.bookmarks, prev.bookmarks + 2);
});

test("text: clear는 글만 비우고 구조(중첩 표·그림·누름틀 짝)는 복제한다", () => {
  const { doc } = singleTableDoc(richSpec());
  const { bytes, doc: after } = applyChecked(doc, planInsertRows(doc, target(doc), { prototype: 1 }));
  const row = trs(outerTableXml(sectionText(bytes)))[2] ?? "";
  assert.ok(!/<hp:t>[^<]+<\/hp:t>/.test(row), "새 행에는 글이 없다");
  assert.match(row, /<hp:pic /);
  assert.match(row, /<hp:fieldBegin /);
  assert.match(row, /<hp:bookmark /);
  assert.equal(row.match(/<hp:tbl /g)?.length, 1);
  assert.equal(validateDocument(bytes).errors.length, 0);
  assert.equal(listTables(after).length, 3, "중첩 표 포함 표 3개");
});

test("세로 병합: 위에서 내려오는 병합은 extendSpans가 있어야 늘려서 복제하고, 그 행에서 시작해 아래로 뻗는 병합은 언제나 거절한다", () => {
  const spec: TableSpec = {
    rowCnt: 4,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, rowSpan: 3, width: 2000, height: 1800, text: "세로 병합" },
      { row: 0, col: 1, width: 3000, height: 600, text: "a" },
      { row: 1, col: 1, width: 3000, height: 600, text: "b" },
      { row: 2, col: 1, width: 3000, height: 600, text: "c" },
      { row: 3, col: 0, width: 2000, height: 500, text: "d" },
      { row: 3, col: 1, width: 3000, height: 500, text: "e" },
    ],
  };
  const { doc } = singleTableDoc(spec);
  const t = target(doc);
  // 행 1은 행 0에서 내려오는 병합이 덮는다
  expectCode(() => planInsertRows(doc, t, { prototype: 1 }), "TABLE_SPAN_CONFLICT");
  // 행 0은 거기서 시작해 아래로 뻗는 병합이 있다: extendSpans로도 거절
  expectCode(() => planInsertRows(doc, t, { prototype: 0 }), "TABLE_SPAN_CONFLICT");
  expectCode(() => planInsertRows(doc, t, { prototype: 0, extendSpans: true }), "TABLE_SPAN_CONFLICT");
  // 병합과 무관한 행 3은 된다
  assert.ok(planInsertRows(doc, t, { prototype: 3 }).edits.length > 0);

  const { bytes } = applyChecked(doc, planInsertRows(doc, t, { prototype: 1, count: 2, extendSpans: true, text: "keep" }));
  const tbl = outerTableXml(sectionText(bytes));
  const cells = readCells(tbl);
  const big = cells.find((c) => c.row === 0 && c.col === 0);
  assert.equal(big?.rowSpan, 5, "병합이 새 행만큼 늘었다");
  assert.equal(big?.height, 1800 + 2 * 600, "병합 셀 높이는 새 행 높이만큼 는다");
  assert.equal(attrIn(tbl, "tbl", "rowCnt"), "6");
  // 새 행(2, 3)에는 오른쪽 열 셀만 있다
  assert.deepEqual(cells.filter((c) => c.row === 2 || c.row === 3).map((c) => [c.row, c.col]), [[2, 1], [3, 1]]);
  // 마지막 행 둘은 4, 5로 밀렸다
  assert.deepEqual(cells.filter((c) => c.row >= 4).map((c) => [c.row, c.col]), [[4, 1], [5, 0], [5, 1]]);
});

test("가로 병합이 든 원형 행은 그대로 복제한다(병합 셀의 병합 수 유지)", () => {
  const { doc } = singleTableDoc(richSpec());
  const { bytes } = applyChecked(doc, planInsertRows(doc, target(doc), { prototype: 2, count: 1 }));
  const cells = readCells(outerTableXml(sectionText(bytes)));
  assert.deepEqual(cells.filter((c) => c.row === 3).map((c) => [c.col, c.colSpan, c.width]), [[0, 2, 5000], [2, 1, 4000]]);
});

test("줄 배치 캐시: 행 삽입 뒤 구역의 줄 배치 캐시는 전부 지워진다", () => {
  const spec = gridTable([5000], 2, [], {}, 700);
  const bytes = docOf([segPara("앞"), tableParagraph(spec), segPara("뒤")]);
  const doc = reparseBytes(bytes);
  const out = applyChecked(doc, planInsertRows(doc, target(doc), { prototype: 0 })).bytes;
  assert.equal(sectionText(out).match(/linesegarray/g), null);
});

test("거절: 잘못된 인자는 TABLE_BAD_ARG", () => {
  const { doc } = singleTableDoc(gridTable([2000, 3000], 2));
  const t = target(doc);
  const bad = (options: unknown): void => expectCode(() => planInsertRows(doc, t, options as never), "TABLE_BAD_ARG");
  bad({ prototype: 2 });
  bad({ prototype: -1 });
  bad({ prototype: 0.5 });
  bad({});
  bad({ prototype: 0, count: 0 });
  bad({ prototype: 0, count: -2 });
  bad({ prototype: 0, count: 1.5 });
  bad({ prototype: 0, count: 100001 });
  bad({ prototype: 0, position: "middle" });
  bad({ prototype: 0, text: "blank" });
  bad(null);
});

test("거절: 불규칙 격자 TABLE_IRREGULAR, 셀 영역 목록 TABLE_UNSUPPORTED, 높이 기준 TABLE_RELATIVE_SIZE", () => {
  const d4 = loadDoc("D4");
  const broken = listTables(d4).find((x) => !x.regular);
  assert.ok(broken !== undefined);
  expectCode(() => planInsertRows(d4, broken.target, { prototype: 0 }), "TABLE_IRREGULAR");
  const zone = singleTableDoc({ ...gridTable([2000], 2), cellzone: true });
  expectCode(() => planInsertRows(zone.doc, target(zone.doc), { prototype: 0 }), "TABLE_UNSUPPORTED");
  const rel = singleTableDoc({ ...gridTable([2000], 2), heightRelTo: "PERCENT" });
  expectCode(() => planInsertRows(rel.doc, target(rel.doc), { prototype: 0 }), "TABLE_RELATIVE_SIZE");
  // 열 너비가 모순되는 표도 행 삽입은 된다(열 너비를 쓰지 않는다)
  const conflict = singleTableDoc({
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500 },
      { row: 0, col: 1, width: 1000, height: 500 },
      { row: 1, col: 0, width: 1200, height: 500 },
      { row: 1, col: 1, width: 1000, height: 500 },
    ],
  });
  assert.ok(planInsertRows(conflict.doc, target(conflict.doc), { prototype: 0 }).edits.length > 0);
});

test("B3: 실제 시험 문서의 규칙적인 표 전부에 마지막 행을 복제해 넣어도 행 수·주소·불변식이 맞고 검사기 새 오류가 없다", () => {
  let checked = 0;
  for (const name of ["D1", "D2", "D3", "D5", "D6", "D7", "hancom-merged", "hancom/blocks", "hancom/ph-table", "extra/features-picture", "extra/features-rhwp"]) {
    const doc = loadDoc(name);
    for (const info of listTables(doc)) {
      if (!info.regular || info.depth > 0 || info.rowCnt === undefined) continue;
      // 마지막 행에서 시작해 아래로 뻗는 병합은 없다(표가 거기서 끝난다). 위에서 내려오는 병합은 늘려서 받는다.
      const plan = planInsertRows(doc, info.target, { prototype: info.rowCnt - 1, count: 3, extendSpans: true });
      const { doc: after } = applyChecked(doc, plan);
      const now = listTables(after).find((x) => x.ordinal === info.ordinal);
      assert.equal(now?.rowCnt, info.rowCnt + 3, `${name} #${info.ordinal}`);
      assert.equal(now?.regular, true);
      const tbl = outerTableXml(sectionText(after.pkg.bytes), info.topOrdinal ?? 0);
      assert.equal(trs(tbl).length, info.rowCnt + 3);
      checked++;
    }
  }
  assert.ok(checked >= 25, `검사한 표 ${checked}개`);
});

test("planRepeatRows: 원형 행을 count개로 바꾸고 첫 복사본은 원형 id를 그대로 쓴다. rewrite가 복사본마다 내용을 채운다", () => {
  const { doc, bytes: original } = singleTableDoc(richSpec());
  const seen: number[] = [];
  const plan = planRepeatRows(doc, target(doc), {
    row: 1,
    count: 3,
    rewrite: (xml, i) => {
      seen.push(i);
      return xml.replace("<hp:t>1</hp:t>", `<hp:t>행${i + 1}</hp:t>`);
    },
  });
  assert.deepEqual(seen, [0, 1, 2]);
  const { bytes } = applyChecked(doc, plan);
  const tbl = outerTableXml(sectionText(bytes));
  assert.equal(attrIn(tbl, "tbl", "rowCnt"), "5");
  assert.deepEqual(readCells(tbl).filter((c) => c.col === 0 && c.colSpan === 1).map((c) => c.row), [0, 1, 2, 3]);
  const texts = trs(tbl).map((r) => [...r.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|"));
  assert.match(texts[1] ?? "", /^행1\|홍길동\|/);
  assert.match(texts[2] ?? "", /^행2\|홍길동\|/);
  assert.match(texts[3] ?? "", /^행3\|홍길동\|/);
  const now = ids(bytes);
  assert.ok(now.begins.includes("7001"), "첫 복사본은 원형의 누름틀 id를 쓴다");
  assert.equal(now.begins.length, 3);
  assert.deepEqual(duplicates(now.objects), []);
  assert.deepEqual(duplicates(now.marks), []);
  assert.deepEqual(duplicates(now.paragraphs), []);
  // 뒤 행(병합 행)은 4로 밀렸고 표 높이는 원형 행 높이 2개만큼 늘었다
  assert.deepEqual(readCells(tbl).filter((c) => c.row === 4).map((c) => [c.col, c.colSpan]), [[0, 2], [2, 1]]);
  assert.equal(Number(attrIn(tbl, "sz", "height")), Number(attrIn(outerTableXml(sectionText(original)), "sz", "height")) + 2 * 800);
  // count 1은 같은 행 하나(rewrite만 적용)
  const one = applyChecked(doc, planRepeatRows(doc, target(doc), { row: 1, count: 1, rewrite: (xml) => xml.replace("<hp:t>1</hp:t>", "<hp:t>하나</hp:t>") })).bytes;
  assert.equal(attrIn(outerTableXml(sectionText(one)), "tbl", "rowCnt"), "3");
  assert.match(sectionText(one), /<hp:t>하나<\/hp:t>/);
  // 같은 계획 거절 규칙
  expectCode(() => planRepeatRows(doc, target(doc), { row: 1, count: 0 }), "TABLE_BAD_ARG");
  expectCode(() => planRepeatRows(doc, target(doc), { row: 9, count: 1 }), "TABLE_BAD_ARG");
});

test("복제할 범위가 누름틀의 시작과 끝 사이를 자르면 TABLE_SPLITS_FIELD로 거절한다(복제하면 한 시작에 끝이 둘이 된다)", () => {
  const begin = (id: string): string => `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="n" editable="1" dirty="1" fieldid="9${id}"/></hp:ctrl>`;
  const end = (id: string): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="9${id}"/></hp:ctrl>`;
  // 행 0의 셀에서 시작한 누름틀이 행 1의 셀에서 끝난다
  const spec: TableSpec = {
    rowCnt: 2,
    colCnt: 1,
    cells: [
      { row: 0, col: 0, width: 5000, height: 600, paragraphs: [paragraph(`${begin("7001")}<hp:t>가</hp:t>`)] },
      { row: 1, col: 0, width: 5000, height: 600, paragraphs: [paragraph(`<hp:t>나</hp:t>${end("7001")}`)] },
    ],
  };
  const { doc } = singleTableDoc(spec);
  for (const prototype of [0, 1]) expectCode(() => planInsertRows(doc, target(doc), { prototype }), "TABLE_SPLITS_FIELD");
  expectCode(() => planInsertColumns(doc, target(doc), { prototype: 0 }), "TABLE_SPLITS_FIELD");
  expectCode(() => planRepeatRows(doc, target(doc), { row: 0, count: 2 }), "TABLE_SPLITS_FIELD");
  // 한 행이 하나뿐이면(count 1) 복제가 없어 된다
  assert.ok(planRepeatRows(doc, target(doc), { row: 0, count: 1 }).edits.length > 0);
  // 한 문단 안에서 닫히는 누름틀은 복제된다
  const closed = singleTableDoc({ rowCnt: 1, colCnt: 1, cells: [{ row: 0, col: 0, width: 5000, height: 600, paragraphs: [paragraph(`${begin("7002")}<hp:t>값</hp:t>${end("7002")}`)] }] });
  assert.ok(planInsertRows(closed.doc, target(closed.doc), { prototype: 0, text: "keep" }).edits.length > 0);
});
