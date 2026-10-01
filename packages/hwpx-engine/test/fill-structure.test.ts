// 구조 액션(E7 삭제, E8·E9 조각 주입, E13 서식 상속 텍스트 삽입)과 그 거절 규칙.
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFragment, isTableNode, readArchive, readEntry, selectTable, serializeFragment, validateDocument, walkParagraphs, type Fragment, type HwpxDocument } from "../src/index.ts";
import { generate, type GenerateOptions, type GenerateResult } from "../src/fill/index.ts";
import { readDataset, readTemplate, type Template } from "../src/template/index.ts";
import {
  buildHwpx,
  bytesEqual,
  duplicates,
  expandResource,
  formatRefsIn,
  loadDoc,
  mutateEntryText,
  newErrorsAfter,
  objectIdsIn,
  readFixture,
  reparse,
  sha256Hex,
  utf8,
} from "./helpers.ts";

const SEC = "Contents/section0.xml";

type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;

function done(r: GenerateResult): Done {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues)}`);
  assert.ok(!r.dryRun);
  return r as Done;
}

function failed(r: GenerateResult): string[] {
  assert.equal(r.ok, false, "생성이 성공해 버렸다");
  assert.ok(!("output" in r), "실패인데 출력이 있다");
  return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
}

const tpl = (spec: { anchors?: unknown[]; rules?: unknown[]; options?: unknown }): Template =>
  readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const ds = (data: unknown) => readDataset(data);
const text = (bytes: Uint8Array, entry = SEC): string => new TextDecoder().decode(readEntry(readArchive(bytes), bytes, entry));
const topTexts = (doc: HwpxDocument): string[] => doc.sections[0]?.paragraphs.map((p) => p.logicalText) ?? [];
const census = (bytes: Uint8Array) => validateDocument(bytes).census;

const lineAnchor = (id: string, path: number[], logical: string) => ({
  id,
  kind: "line",
  at: { sectionIndex: 0, path },
  print: { text: logical.slice(0, 40), sha256: sha256Hex(utf8(logical)) },
});
const OBJ = "￼";

// hancom/blocks: [0]=1. 개요(secPr) [1]=개요 본문입니다. [2]=2. 선택 조항 [3]=선택 조항 본문입니다. (해당 시) [4]=3×3 표 [5]=3. 끝
const BLOCKS = {
  p0: lineAnchor("p0", [0], `${OBJ}${OBJ}1. 개요`),
  p1: lineAnchor("p1", [1], "개요 본문입니다."),
  p2: lineAnchor("p2", [2], "2. 선택 조항"),
  p3: lineAnchor("p3", [3], "선택 조항 본문입니다. (해당 시)"),
  p5: lineAnchor("p5", [5], "3. 끝"),
  cell: (id: string, row: number, col = 0) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row, col }),
  table: { id: "tbl", kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 0 },
};
const del = (id: string, anchor: string, extra: Record<string, unknown> = {}, when?: unknown) => ({
  id,
  ...(when === undefined ? {} : { when }),
  do: { type: "delete", anchor, ...extra },
});

// ── E7: 조건 삭제 ──────────────────────────────────────────────

test("E7: 조건에 따라 문단을 지운다 — 수량 증감이 계획과 같고 검사를 통과한다", () => {
  const bytes = readFixture("hancom/blocks");
  const t = tpl({
    anchors: [BLOCKS.p2, BLOCKS.p3],
    rules: [del("d1", "p2", {}, { path: "optional", op: "eq", value: false }), del("d2", "p3", {}, { path: "optional", op: "eq", value: false })],
  });
  const before = text(bytes);
  const r = done(generate(bytes, t, ds({ optional: false })));
  assert.deepEqual(topTexts(reparse(r.output)), [`${OBJ}${OBJ}1. 개요`, "개요 본문입니다.", OBJ, "3. 끝"]);
  // 독립 기준: 문단 요소 수(15 → 13)와 예고 수량
  assert.equal(before.match(/<hp:p /g)?.length, 15);
  assert.equal(text(r.output).match(/<hp:p /g)?.length, 13);
  assert.deepEqual(r.report.plan.expected, { paragraphs: -2 });
  assert.equal(census(r.output).paragraphs, census(bytes).paragraphs - 2);
  assert.equal(validateDocument(r.output).errors.length, 0);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.type, a.targets]), [["d1", "delete", 1], ["d2", "delete", 1]]);
  // 지운 문단 밖의 줄 배치 캐시도 모두 지웠다(글이 바뀌는 구역)
  assert.ok(!text(r.output).includes("linesegarray"));

  // 조건이 거짓이면 아무것도 하지 않아 입력과 바이트 동일하다
  assert.ok(bytesEqual(done(generate(bytes, t, ds({ optional: true }))).output, bytes));
});

test("E7: 표 행을 지운다 — rowCnt가 줄고 뒤 행 셀의 행 주소가 1씩 준다", () => {
  const bytes = readFixture("hancom/blocks");
  const t = tpl({ anchors: [BLOCKS.cell("c1", 1)], rules: [del("d", "c1", { scope: "row" })] });
  const r = done(generate(bytes, t, ds({})));
  const xml = text(r.output);
  const table = xml.slice(xml.indexOf("<hp:tbl "), xml.indexOf("</hp:tbl>"));
  assert.match(table, /rowCnt="2" colCnt="3"/);
  assert.equal(table.match(/<hp:tr>/g)?.length, 2);
  assert.deepEqual([...table.matchAll(/rowAddr="(\d+)"/g)].map((m) => m[1]), ["0", "0", "0", "1", "1", "1"]);
  const cells = reparse(r.output).sections[0]?.paragraphs[4]?.objects[0];
  assert.ok(cells !== undefined && isTableNode(cells));
  assert.deepEqual(cells.cells.map((c) => c.subList?.paragraphs[0]?.logicalText), ["구분", "내용", "비고", "B", "나", "-"]);
  assert.deepEqual(r.report.plan.expected, { paragraphs: -3, tableRows: -1, tableCells: -3 });
  assert.equal(census(r.output).tables, 1);
  assert.equal(validateDocument(r.output).errors.length, 0);

  // 첫 행과 마지막 행을 함께: 남은 가운데 행의 주소가 0이 된다
  const two = tpl({ anchors: [BLOCKS.cell("a", 0), BLOCKS.cell("b", 2, 1)], rules: [del("d1", "a", { scope: "row" }), del("d2", "b", { scope: "row" })] });
  const xml2 = text(done(generate(bytes, two, ds({}))).output);
  const table2 = xml2.slice(xml2.indexOf("<hp:tbl "), xml2.indexOf("</hp:tbl>"));
  assert.match(table2, /rowCnt="1"/);
  assert.deepEqual([...table2.matchAll(/rowAddr="(\d+)"/g)].map((m) => m[1]), ["0", "0", "0"]);
});

test("E7: 마지막 남은 행까지 지우면 표를 담은 문단을 지운다", () => {
  const bytes = readFixture("hancom/blocks");
  const rows = [0, 1, 2].map((n) => BLOCKS.cell(`c${n}`, n));
  const t = tpl({ anchors: rows, rules: rows.map((a, n) => del(`d${n}`, a.id, { scope: "row" })) });
  const r = done(generate(bytes, t, ds({})));
  assert.deepEqual(topTexts(reparse(r.output)), [`${OBJ}${OBJ}1. 개요`, "개요 본문입니다.", "2. 선택 조항", "선택 조항 본문입니다. (해당 시)", "3. 끝"]);
  assert.deepEqual(r.report.plan.expected, { paragraphs: -10, tables: -1, tableRows: -3, tableCells: -9 });
  assert.equal(census(r.output).tables, 0);
});

test("E7: object 앵커 — 그 객체만 든 문단이면 문단째, 다른 글이 있으면 객체 요소만 지운다", () => {
  const picture = readFixture("hancom/picture");
  const t = tpl({ anchors: [{ id: "o", kind: "object", objectType: "pic", sectionIndex: 0, ordinal: 0 }], rules: [del("d", "o")] });
  const r = done(generate(picture, t, ds({})));
  assert.deepEqual(r.report.plan.expected, { paragraphs: -1, pictures: -1 });
  assert.equal(census(r.output).pictures, 0);
  assert.equal(reparse(r.output).sections[0]?.paragraphs.length, 2);

  const withText = mutateEntryText(picture, SEC, (x) => x.replace("</hp:pic><hp:t/>", "</hp:pic><hp:t>덧글</hp:t>"));
  const r2 = done(generate(withText, t, ds({})));
  assert.deepEqual(r2.report.plan.expected, { pictures: -1 });
  assert.deepEqual(topTexts(reparse(r2.output)), [`${OBJ}${OBJ}그림 앞 문단`, "덧글", "그림 뒤 문단"]);
  assert.equal(validateDocument(r2.output).errors.length, 0);

  // 표 객체 앵커
  const blocks = readFixture("hancom/blocks");
  const r3 = done(generate(blocks, tpl({ anchors: [BLOCKS.table], rules: [del("d", "tbl")] }), ds({})));
  assert.deepEqual(r3.report.plan.expected, { paragraphs: -10, tables: -1, tableRows: -3, tableCells: -9 });
});

test("E7: 지울 수 없는 경우는 거절한다 — 구역 설정 문단, 마지막 남은 문단, 세로 병합 행", () => {
  const blocks = readFixture("hancom/blocks");
  assert.deepEqual(failed(generate(blocks, tpl({ anchors: [BLOCKS.p0], rules: [del("d", "p0")] }), ds({}))), ["FILL_SECTION_PROPS"]);

  // 같은 부모의 문단을 모두 지우면 마지막 하나는 지울 수 없다
  const two = buildHwpx([["하나", "둘"].map((s) => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${s}</hp:t></hp:run></hp:p>`).join("")]);
  const all = tpl({ anchors: [lineAnchor("a", [0], "하나"), lineAnchor("b", [1], "둘")], rules: [del("d1", "a"), del("d2", "b")] });
  assert.deepEqual(failed(generate(two, all, ds({}))), ["FILL_LAST_PARAGRAPH"]);
  assert.deepEqual(topTexts(reparse(done(generate(two, tpl({ anchors: [lineAnchor("a", [0], "하나")], rules: [del("d1", "a")] }), ds({}))).output)), ["둘"]);

  // 셀 안의 하나뿐인 문단
  const cellOnly = tpl({ anchors: [lineAnchor("c", [4, 0, 0], "구분")].map((a) => a), rules: [del("d", "c")] });
  assert.deepEqual(failed(generate(blocks, cellOnly, ds({}))), ["FILL_LAST_PARAGRAPH"]);

  // 세로 병합 셀이 걸친 행
  const merged = mutateEntryText(blocks, SEC, (x) => x.replace('<hp:cellSpan colSpan="1" rowSpan="1"/>', '<hp:cellSpan colSpan="1" rowSpan="2"/>'));
  for (const row of [0, 1]) {
    const t = tpl({ anchors: [BLOCKS.cell("c", row, 1)], rules: [del("d", "c", { scope: "row" })] });
    assert.deepEqual(failed(generate(merged, t, ds({}))), ["FILL_ROW_SPAN"], `행 ${row}`);
  }
  // 걸치지 않은 행은 지울 수 있다
  const ok = tpl({ anchors: [BLOCKS.cell("c", 2, 1)], rules: [del("d", "c", { scope: "row" })] });
  assert.deepEqual(done(generate(merged, ok, ds({}))).report.plan.expected, { paragraphs: -3, tableRows: -1, tableCells: -3 });
});

test("E7: 삭제 범위 안의 채움·삽입은 버리고 보고한다(안의 {{}}는 데이터가 없어도 오류가 아니다)", () => {
  const blocks = readFixture("hancom/blocks");
  const t = tpl({
    anchors: [BLOCKS.p3, { id: "w", kind: "word", at: { sectionIndex: 0, path: [3] }, start: 0, end: 2, print: { text: "선택", before: "", after: " 조항 본문입니다. (해당 시)" } }, BLOCKS.cell("c", 1)],
    rules: [
      { id: "f", do: { type: "fill", anchor: "w", value: { text: "x" } } },
      { id: "i", do: { type: "insertText", anchor: "p3", position: "after", value: { text: "새 문단" } } },
      del("d", "p3"),
      { id: "f2", do: { type: "fill", anchor: "c", value: { text: "x" } } },
      del("dr", "c", { scope: "row" }),
    ],
  });
  const r = done(generate(blocks, t, ds({})));
  assert.deepEqual(r.report.plan.dropped.map((d) => d.ruleId).sort(), ["f", "f2", "i"]);
  assert.ok(!topTexts(reparse(r.output)).includes("새 문단"));
  assert.deepEqual(r.report.plan.expected, { paragraphs: -4, tableRows: -1, tableCells: -3 });

  // 지운 문단 안의 {{}}는 데이터가 없어도 DATA_MISSING이 아니다
  const single = readFixture("hancom/ph-single");
  const t2 = tpl({ anchors: [lineAnchor("l", [2], "기간: {{project.start}} ~ {{project.end}}")], rules: [del("d", "l")] });
  const r2 = done(generate(single, t2, ds({ project: { name: "알파" } })));
  assert.deepEqual(topTexts(reparse(r2.output)).slice(1), ["사업명: 알파 입니다."]);
  assert.deepEqual(r2.report.plan.dropped.map((d) => d.anchor).sort(), ["{{project.end}}", "{{project.start}}"]);
  assert.deepEqual(r2.report.plan.missingPaths, []);
});

// ── E8·E9: 조각 주입 ───────────────────────────────────────────

const injectRule = (id: string, anchor: string, position: string, fragment: unknown, when?: unknown) => ({
  id,
  ...(when === undefined ? {} : { when }),
  do: { type: "inject", anchor, position, fragment },
});
const asObject = (f: Fragment): Record<string, unknown> => JSON.parse(serializeFragment(f)) as Record<string, unknown>;

/** 문단 요소 원문에서 서식 참조(글자·문단·스타일·테두리)를 뽑아 자원 전개로 바꾼다(글꼴은 이름까지). 문서가 달라도 같은 모양이면 같다. */
function prints(doc: HwpxDocument, xml: string): string[] {
  return formatRefsIn(xml).map((r) => JSON.stringify([r.kind, expandResource(doc, r.kind, r.id)]));
}
function paragraphXml(doc: HwpxDocument, from: number, to: number): string[] {
  const s = doc.sections[0];
  return (s?.paragraphs.slice(from, to + 1) ?? []).map((p) => s?.text.slice(p.element.start, p.element.end) ?? "");
}

test("E8: 조건에 따라 조각을 주입하고 조각 안 {{}}를 같은 데이터로 채운다 — 조각 동일성 기준", () => {
  const blocks = readFixture("hancom/blocks");
  const sourceDoc = loadDoc("hancom/ph-single");
  const fragment = extractFragment(sourceDoc, { sectionIndex: 0, parentPath: [], from: 1, to: 2 });
  const t = tpl({ anchors: [BLOCKS.p3], rules: [injectRule("r", "p3", "after", asObject(fragment), { path: "contract.type", op: "eq", value: "용역" })] });
  const data = { contract: { type: "용역" }, project: { name: "알파", start: "2026-01-01", end: "2026-12-31" } };
  const r = done(generate(blocks, t, ds(data)));
  const out = reparse(r.output);
  assert.deepEqual(topTexts(out).slice(3, 6), ["선택 조항 본문입니다. (해당 시)", "사업명: 알파 입니다.", "기간: 2026-01-01 ~ 2026-12-31"]);
  assert.equal(topTexts(out).length, 8);
  assert.deepEqual(r.report.plan.expected, { paragraphs: 2 });
  assert.equal(validateDocument(r.output).errors.length, 0);
  // 조각 동일성: 서식 참조의 전개가 소스의 것과 같다
  assert.deepEqual(paragraphXml(out, 4, 5).flatMap((x) => prints(out, x)), paragraphXml(sourceDoc, 1, 2).flatMap((x) => prints(sourceDoc, x)));
  // 조각 안 {{}}가 남지 않는다
  assert.ok(!text(r.output).includes("{{"));
  // 줄 배치 캐시는 조각에서도, 구역에서도 없다
  assert.ok(!text(r.output).includes("linesegarray"));

  // 조건이 거짓이면 주입하지 않는다
  const none = done(generate(blocks, t, ds({ ...data, contract: { type: "물품" } })));
  assert.ok(bytesEqual(none.output, blocks));
});

test("E8: 조각을 경로로 지정하면 읽는 쪽이 넘긴 조각을 쓰고, 없으면 TPL_FRAGMENT_MISSING. 조각 안 데이터가 없으면 DATA_MISSING", () => {
  const blocks = readFixture("hancom/blocks");
  const fragment = extractFragment(loadDoc("hancom/ph-single"), { sectionIndex: 0, parentPath: [], from: 1, to: 1 });
  const t = tpl({ anchors: [BLOCKS.p3], rules: [injectRule("r", "p3", "before", "fragments/ph.json")] });
  const options: GenerateOptions = { fragments: { "fragments/ph.json": serializeFragment(fragment) } };
  const r = done(generate(blocks, t, ds({ project: { name: "베타" } }), options));
  assert.equal(topTexts(reparse(r.output))[3], "사업명: 베타 입니다.");
  assert.deepEqual(failed(generate(blocks, t, ds({ project: { name: "베타" } }))), ["TPL_FRAGMENT_MISSING"]);
  assert.deepEqual(failed(generate(blocks, t, ds({}), options)), ["DATA_MISSING"]);
  // 조각이 JSON 객체여도 스키마가 틀리면 FRAG_SCHEMA
  const broken = tpl({ anchors: [BLOCKS.p3], rules: [injectRule("r", "p3", "before", { schema: "hwpx-studio/fragment@1" })] });
  assert.deepEqual(failed(generate(blocks, broken, ds({}))), ["FRAG_SCHEMA"]);
  // 누락 정책 keep이면 조각 안 자리도 그대로 둔다
  const kept = done(generate(blocks, t, ds({}), { ...options, missing: "keep" }));
  assert.equal(topTexts(reparse(kept.output))[3], "사업명: {{project.name}} 입니다.");
});

test("E9: 그림 조각을 다른 문서(한컴 저장본·합성 문서)로 — 이진 자료 추가, manifest 등록, 참조가 맞다", () => {
  const source = loadDoc("hancom/picture");
  const fragment = extractFragment(source, { sectionIndex: 0, parentPath: [], from: 1, to: 1 });
  const png = readEntry(source.pkg.archive, source.pkg.bytes, "BinData/image1.png");
  for (const [name, anchorPath, anchorText] of [["hancom/blocks", [3], "선택 조항 본문입니다. (해당 시)"], ["D1", [0], undefined]] as const) {
    const bytes = readFixture(name);
    const target = reparse(bytes);
    const anchorLogical = anchorText ?? target.sections[0]?.paragraphs[0]?.logicalText ?? "";
    const t = tpl({ anchors: [lineAnchor("a", [...anchorPath], anchorLogical)], rules: [injectRule("r", "a", "after", asObject(fragment))] });
    const r = done(generate(bytes, t, ds({})));
    const out = reparse(r.output);
    const added = out.pkg.archive.entries.filter((e) => e.name.startsWith("BinData/") && !target.pkg.archive.entries.some((x) => x.name === e.name));
    assert.equal(added.length, 1, name);
    const addedName = added[0]?.name ?? "";
    assert.ok(bytesEqual(readEntry(out.pkg.archive, r.output, addedName), png), `${name}: 이진 자료 내용`);
    const item = out.pkg.manifestItems.find((m) => m.href === addedName);
    assert.ok(item !== undefined, `${name}: manifest 등록`);
    // 그림의 참조가 새 항목을 가리킨다
    const ref = text(r.output).match(/binaryItemIDRef="([^"]*)"/g)?.map((m) => m.slice(17, -1));
    assert.ok(ref?.includes(item?.id ?? ""), `${name}: binaryItemIDRef`);
    assert.deepEqual(r.report.plan.expected, { paragraphs: 1, pictures: 1 });
    assert.equal(census(r.output).binaryItems, census(bytes).binaryItems + 1);
    assert.deepEqual(duplicates(objectIdsIn(text(r.output))), [], `${name}: 객체 id 중복`);
    const before = validateDocument(bytes);
    const after = validateDocument(r.output);
    assert.deepEqual(newErrorsAfter(before, after), [], `${name}: 새 오류가 없다`);
  }
});

test("E9: 표 조각·문단 조각을 다른 문서로 — 글·서식 지문이 소스와 같고 객체 id가 겹치지 않는다", () => {
  const d5 = loadDoc("D5");
  const tableSel = selectTable(d5, 0, 4).selection; // 문단 7의 표(문단 0의 표는 구역 설정과 같은 문단이라 뜰 수 없다)
  const tableFrag = extractFragment(d5, tableSel);
  const parasFrag = extractFragment(d5, { sectionIndex: 0, parentPath: [], from: 4, to: 6 });
  for (const target of ["hancom/blocks", "D1"]) {
    const bytes = readFixture(target);
    const doc = reparse(bytes);
    const last = (doc.sections[0]?.paragraphs.length ?? 1) - 1;
    const anchor = lineAnchor("a", [last], doc.sections[0]?.paragraphs[last]?.logicalText ?? "");
    for (const [label, fragment, from] of [["표", tableFrag, tableSel.from], ["문단", parasFrag, 4]] as const) {
      const t = tpl({ anchors: [anchor], rules: [injectRule("r", "a", "after", asObject(fragment))] });
      const r = done(generate(bytes, t, ds({})));
      const out = reparse(r.output);
      const n = fragment.texts.length;
      const topCount = fragment.source.selection.to - fragment.source.selection.from + 1;
      const inserted = out.sections[0]?.paragraphs.slice(last + 1, last + 1 + topCount) ?? [];
      assert.equal(inserted.length, topCount, `${target} ${label}`);
      assert.deepEqual([...walkParagraphs(inserted)].map((p) => p.logicalText), fragment.texts, `${target} ${label}: 글`);
      const outXml = inserted.map((p) => out.sections[0]?.text.slice(p.element.start, p.element.end) ?? "");
      assert.deepEqual(outXml.flatMap((x) => prints(out, x)), paragraphXml(d5, from, from + topCount - 1).flatMap((x) => prints(d5, x)), `${target} ${label}: 서식 지문`);
      assert.deepEqual(duplicates(objectIdsIn(text(r.output))), [], `${target} ${label}: 객체 id`);
      assert.equal(r.report.plan.expected["paragraphs"], n);
      assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), [], `${target} ${label}: 새 오류`);
    }
  }
});

test("E9: 주입 위치 — before·after·replace, 같은 앵커의 여러 주입은 규칙 순서, 표 셀 안 주입", () => {
  const blocks = readFixture("hancom/blocks");
  const single = loadDoc("hancom/ph-single");
  const f1 = asObject(extractFragment(single, { sectionIndex: 0, parentPath: [], from: 1, to: 1 }));
  const f2 = asObject(extractFragment(single, { sectionIndex: 0, parentPath: [], from: 2, to: 2 }));
  const data = ds({ project: { name: "N", start: "S", end: "E" } });

  const order = tpl({
    anchors: [BLOCKS.p1],
    rules: [injectRule("a1", "p1", "after", f1), injectRule("a2", "p1", "after", f2), injectRule("b1", "p1", "before", f2), injectRule("b2", "p1", "before", f1)],
  });
  const r = done(generate(blocks, order, data));
  assert.deepEqual(topTexts(reparse(r.output)).slice(1, 7), ["기간: S ~ E", "사업명: N 입니다.", "개요 본문입니다.", "사업명: N 입니다.", "기간: S ~ E", "2. 선택 조항"]);
  assert.deepEqual(r.report.stages.map((s) => s.label), ["main", "inject:a2", "inject:a1", "inject:b1", "inject:b2"]);

  // replace: 앵커 문단이 지워지고 그 자리에 들어간다. 앵커 안의 채움은 버린다
  const replace = tpl({
    anchors: [BLOCKS.p3, { id: "w", kind: "word", at: { sectionIndex: 0, path: [3] }, start: 0, end: 2, print: { text: "선택", before: "", after: " 조항 본문입니다. (해당 시)" } }],
    rules: [injectRule("r", "p3", "replace", f1), { id: "f", do: { type: "fill", anchor: "w", value: { text: "x" } } }],
  });
  const rr = done(generate(blocks, replace, data));
  assert.deepEqual(topTexts(reparse(rr.output)).slice(2, 5), ["2. 선택 조항", "사업명: N 입니다.", OBJ]);
  assert.deepEqual(rr.report.plan.expected, {});
  assert.deepEqual(rr.report.plan.dropped.map((d) => d.ruleId), ["f"]);

  // 표 셀 안(하위 목록) 문단 옆
  const cell = tpl({ anchors: [lineAnchor("c", [4, 0, 0], "구분")], rules: [injectRule("r", "c", "after", f1)] });
  const rc = done(generate(blocks, cell, data));
  const table = reparse(rc.output).sections[0]?.paragraphs[4]?.objects[0];
  assert.ok(table !== undefined && isTableNode(table));
  assert.deepEqual(table.cells[0]?.subList?.paragraphs.map((p) => p.logicalText), ["구분", "사업명: N 입니다."]);
});

test("E9: 새 자원·객체 id가 필요한 조각을 여러 번 넣어도 id가 겹치지 않는다(주입은 단계별로 이어서 적용한다)", () => {
  const d1 = readFixture("D1");
  const d5 = loadDoc("D5");
  const frag = asObject(extractFragment(d5, selectTable(d5, 0, 4).selection));
  const frag2 = asObject(extractFragment(d5, selectTable(d5, 0, 5).selection));
  const doc = reparse(d1);
  const a0 = lineAnchor("a", [0], doc.sections[0]?.paragraphs[0]?.logicalText ?? "");
  const a2 = lineAnchor("b", [2], doc.sections[0]?.paragraphs[2]?.logicalText ?? "");
  const t = tpl({ anchors: [a0, a2], rules: [injectRule("r1", "a", "after", frag), injectRule("r2", "b", "after", frag2), injectRule("r3", "b", "before", frag)] });
  const r = done(generate(d1, t, ds({})));
  assert.deepEqual(duplicates(objectIdsIn(text(r.output))), []);
  assert.equal(census(r.output).tables, census(d1).tables + 3);
  assert.deepEqual(newErrorsAfter(validateDocument(d1), validateDocument(r.output)), []);
  assert.equal(r.report.stages.length, 4);
});

// ── E13: 서식 상속 텍스트 삽입 ─────────────────────────────────

const insertRule = (id: string, anchor: string, position: string, value: unknown, style?: unknown) => ({
  id,
  do: { type: "insertText", anchor, position, value, ...(style === undefined ? {} : { style }) },
});

test("E13: insertText inherit — 삽입 문단의 서식 참조가 앵커 영역과 같고, 줄바꿈마다 문단을 나눈다", () => {
  for (const [name, path] of [["hancom/blocks", [1]], ["extra/features-picture", [2]], ["D1", [3]]] as const) {
    const bytes = readFixture(name);
    const before = reparse(bytes);
    const anchor = before.sections[0]?.paragraphs[path[0]];
    assert.ok(anchor !== undefined);
    const t = tpl({ anchors: [lineAnchor("a", [...path], anchor.logicalText)], rules: [insertRule("r", "a", "after", { path: "memo" })] });
    const r = done(generate(bytes, t, ds({ memo: "첫 줄\r\n둘째 줄\n\n넷째 &줄" })));
    const out = reparse(r.output);
    const inserted = out.sections[0]?.paragraphs.slice(path[0] + 1, path[0] + 5) ?? [];
    assert.deepEqual(inserted.map((p) => p.logicalText), ["첫 줄", "둘째 줄", "", "넷째 &줄"], name);
    for (const p of inserted) {
      assert.equal(p.attrs.paraPrIDRef, anchor.attrs.paraPrIDRef, `${name}: 문단모양`);
      assert.equal(p.attrs.styleIDRef, anchor.attrs.styleIDRef, `${name}: 스타일`);
      assert.equal(p.runs[0]?.charPrIDRef, anchor.runs[0]?.charPrIDRef, `${name}: 글자모양`);
      assert.equal(p.runs.length, 1);
    }
    assert.deepEqual(r.report.plan.expected, { paragraphs: 4 }, name);
    assert.equal(census(r.output).paragraphs, census(bytes).paragraphs + 4);
    assert.equal(validateDocument(r.output).errors.length, validateDocument(bytes).errors.length, `${name}: 오류가 늘지 않는다`);
    // 새 문단 원문은 문단·run·hp:t뿐이다(빈 줄은 자기닫힘 run)
    const xml = text(r.output);
    assert.ok(xml.includes("<hp:t>넷째 &amp;줄</hp:t></hp:run></hp:p>"));
    assert.match(xml, /<hp:run charPrIDRef="\d+"\/><\/hp:p>/);
  }
});

test("E13: 문단 속성 복사 — id는 자리값이면 그대로·아니면 0, 쪽 나눔은 이어받지 않는다. before·replace도 된다", () => {
  const blocks = mutateEntryText(readFixture("hancom/blocks"), SEC, (x) => x.replace('<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>개요 본문입니다.', '<hp:p id="777" paraPrIDRef="0" styleIDRef="0" pageBreak="1" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>개요 본문입니다.'));
  const t = tpl({ anchors: [BLOCKS.p1, BLOCKS.p3], rules: [insertRule("a", "p1", "before", { text: "앞" }), insertRule("b", "p3", "after", { text: "뒤" })] });
  const xml = text(done(generate(blocks, t, ds({}))).output);
  assert.ok(xml.includes('<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>앞</hp:t></hp:run></hp:p><hp:p id="777"'), "id가 자리값이 아니면 0, pageBreak는 0");
  assert.ok(xml.includes("<hp:t>뒤</hp:t></hp:run></hp:p>"));

  const merged = readFixture("hancom-merged");
  const doc = reparse(merged);
  const hit = doc.sections[0]?.paragraphs.findIndex((p) => p.attrs.id === "4294967295") ?? -1;
  assert.ok(hit >= 0, "자리값 id(4294967295) 문단이 있다");
  const anchor = doc.sections[0]?.paragraphs[hit];
  const tm = tpl({ anchors: [lineAnchor("a", [hit], anchor?.logicalText ?? "")], rules: [insertRule("r", "a", "before", { text: "새" })] });
  const outDoc = reparse(done(generate(merged, tm, ds({}))).output);
  assert.equal(outDoc.sections[0]?.paragraphs[hit]?.attrs.id, "4294967295");

  // replace: 앵커 문단 자리에 새 문단
  const rep = tpl({ anchors: [BLOCKS.p3], rules: [insertRule("r", "p3", "replace", { text: "교체" })] });
  const rr = done(generate(readFixture("hancom/blocks"), rep, ds({})));
  assert.deepEqual(topTexts(reparse(rr.output)).slice(2, 5), ["2. 선택 조항", "교체", OBJ]);
  assert.deepEqual(rr.report.plan.expected, {});
});

test("E13: 서식을 직접 지정할 수 있고, 없는 서식 참조·금지 문자는 거절한다. 구역 설정 문단 앞 삽입은 경고한다", () => {
  const blocks = readFixture("hancom/blocks");
  const doc = reparse(blocks);
  const ok = tpl({ anchors: [BLOCKS.p1], rules: [insertRule("r", "p1", "after", { text: "지정" }, { paraPrIDRef: "2", charPrIDRef: "1", styleIDRef: "0" })] });
  const p = reparse(done(generate(blocks, ok, ds({}))).output).sections[0]?.paragraphs[2];
  assert.deepEqual([p?.attrs.paraPrIDRef, p?.attrs.styleIDRef, p?.runs[0]?.charPrIDRef, p?.logicalText], ["2", "0", "1", "지정"]);
  assert.ok(doc.header.resources["paraPr"]?.some((r) => r.id === "2"));

  const missing = tpl({ anchors: [BLOCKS.p1], rules: [insertRule("r", "p1", "after", { text: "x" }, { paraPrIDRef: "999", charPrIDRef: "0", styleIDRef: "0" })] });
  assert.deepEqual(failed(generate(blocks, missing, ds({}))), ["FILL_STYLE_MISSING"]);
  const tab = tpl({ anchors: [BLOCKS.p1], rules: [insertRule("r", "p1", "after", { text: "a\tb" })] });
  assert.deepEqual(failed(generate(blocks, tab, ds({}))), ["VALUE_CONTROL_CHAR"]);
  const before0 = tpl({ anchors: [BLOCKS.p0], rules: [insertRule("r", "p0", "before", { text: "x" })] });
  const w = done(generate(blocks, before0, ds({})));
  assert.ok(w.report.issues.some((i) => i.severity === "warning" && i.code === "FILL_BEFORE_SECPR"));
});

test("E9: 대상 문서의 원래 문단·자원은 그대로다(문단 원문은 줄 배치 캐시만 없고, header의 기존 자원 원문은 모두 남는다)", () => {
  const d5 = loadDoc("D5");
  const frag = asObject(extractFragment(d5, selectTable(d5, 0, 4).selection));
  const bytes = readFixture("hancom/blocks");
  const doc = reparse(bytes);
  const t = tpl({ anchors: [lineAnchor("a", [3], "선택 조항 본문입니다. (해당 시)")], rules: [injectRule("r", "a", "after", frag)] });
  const r = done(generate(bytes, t, ds({})));
  const strip = (x: string): string => x.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");
  const outText = strip(text(r.output));
  let pos = 0;
  for (const p of doc.sections[0]?.paragraphs ?? []) {
    const original = strip(doc.sections[0]?.text.slice(p.element.start, p.element.end) ?? "");
    const at = outText.indexOf(original, pos);
    assert.ok(at >= pos, `원래 문단 [${p.path.join(", ")}]가 순서대로 남아 있지 않다`);
    pos = at + original.length;
  }
  const out = reparse(r.output);
  let added = 0;
  for (const kind of ["charPr", "paraPr", "borderFill", "style", "tabPr"]) {
    for (const item of doc.header.resources[kind] ?? []) {
      const raw = doc.header.text.slice(item.element.start, item.element.end);
      assert.ok(out.header.text.includes(raw), `${kind} ${item.id}의 원문이 바뀌었다`);
    }
    added += (out.header.resources[kind]?.length ?? 0) - (doc.header.resources[kind]?.length ?? 0);
  }
  assert.ok(added > 0, "D5의 표는 한컴 문서에 없는 서식을 더한다");
});

test("E9: 누름틀·책갈피가 든 조각은 id와 이름이 재발급돼 짝 오류·중복이 없다", () => {
  const states = loadDoc("hancom/field-states");
  const fieldFrag = asObject(extractFragment(states, { sectionIndex: 0, parentPath: [], from: 1, to: 2 }));
  const fields = readFixture("hancom/field-states");
  const t = tpl({ anchors: [lineAnchor("a", [2], "확인자 성명: \uFFFC이름을 입력\uFFFC")], rules: [injectRule("r", "a", "after", fieldFrag)] });
  const r = done(generate(fields, t, ds({})));
  const xml = text(r.output);
  const begins = [...xml.matchAll(/<hp:fieldBegin id="(\d+)"/g)].map((m) => m[1] ?? "");
  const ends = [...xml.matchAll(/<hp:fieldEnd beginIDRef="(\d+)"/g)].map((m) => m[1] ?? "");
  assert.equal(begins.length, 5);
  assert.deepEqual(duplicates(begins), []);
  assert.deepEqual([...ends].sort(), [...begins].sort(), "시작·끝 짝");
  assert.deepEqual(r.report.plan.expected, { paragraphs: 2, fieldPairs: 2 });

  const features = readFixture("extra/features-picture");
  const fdoc = reparse(features);
  const idx = fdoc.sections[0]?.paragraphs.findIndex((p) => p.bookmarks.length > 0) ?? -1;
  assert.ok(idx >= 0, "책갈피가 든 문단이 있다");
  const bookFrag = asObject(extractFragment(fdoc, { sectionIndex: 0, parentPath: [], from: idx, to: idx }));
  const last = (fdoc.sections[0]?.paragraphs.length ?? 1) - 1;
  const tb = tpl({ anchors: [lineAnchor("a", [last], fdoc.sections[0]?.paragraphs[last]?.logicalText ?? "")], rules: [injectRule("r", "a", "after", bookFrag)] });
  const rb = done(generate(features, tb, ds({})));
  const names = [...text(rb.output).matchAll(/<hp:bookmark name="([^"]*)"/g)].map((m) => m[1] ?? "");
  assert.equal(names.length, 2);
  assert.deepEqual(duplicates(names), []);
  assert.deepEqual(rb.report.plan.expected, { paragraphs: 1, bookmarks: 1 });
});
