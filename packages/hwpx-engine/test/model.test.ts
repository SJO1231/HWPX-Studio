import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  collectBodyRefs,
  exportModel,
  isTableNode,
  listFields,
  openPackage,
  parseDocument,
  tokenize,
  buildTree,
  walkParagraphs,
  type FieldInfo,
  type HwpxDocument,
  type ModelJson,
  type ParagraphJson,
  type ParagraphNode,
  type XmlJson,
} from "../src/index.ts";
import {
  FIXTURE_NAMES,
  MINIMAL_HEADER,
  buildHwpx,
  mutateEntryText,
  parseSynthetic,
  readFixture,
  readFixtureText,
  sha256Hex,
} from "./helpers.ts";

const SECTION = "Contents/section0.xml";
const HEADER = "Contents/header.xml";

function load(name: string): HwpxDocument {
  return parseDocument(openPackage(readFixture(name)));
}

function loadMutated(name: string, entry: string, change: (t: string) => string): HwpxDocument {
  return parseDocument(openPackage(mutateEntryText(readFixture(name), entry, change)));
}

function allParagraphs(doc: HwpxDocument): ParagraphNode[] {
  return doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)]);
}

function entryText(name: string, entry: string): string {
  const doc = load(name);
  return entry === HEADER ? doc.header.text : (doc.sections.find((s) => s.entryName === entry)?.text ?? "");
}

const count = (text: string, re: RegExp): number => [...text.matchAll(re)].length;

// ── M1 ──────────────────────────────────────────────────────────────────

const EXPECTED_M1: Record<string, { paragraphs?: number; tables?: number }> = {
  D1: { paragraphs: 61, tables: 2 },
  "hancom-merged": { paragraphs: 91 },
  "hancom-field": { paragraphs: 1 },
};

for (const name of FIXTURE_NAMES) {
  test(`M1 parseDocument가 예외 없이 끝나고 문단 수·표 수가 기대값과 같다: ${name}`, () => {
    const doc = load(name);
    assert.equal(doc.sections.length, 1);
    const text = entryText(name, SECTION);
    // 독립 기준: 원문 정규식으로 센 문단·표 수 (중첩 문단 포함)
    const paragraphs = count(text, /<hp:p[\s>\/]/g);
    const tables = count(text, /<hp:tbl[\s>]/g);
    const all = allParagraphs(doc);
    assert.equal(all.length, paragraphs);
    assert.equal(all.flatMap((p) => p.objects).filter((o) => o.type === "tbl").length, tables);
    assert.equal(
      all.flatMap((p) => p.objects).filter(isTableNode).length,
      tables,
      "type이 tbl인 객체는 모두 표 정보를 갖는다",
    );
    // 명세가 정한 기대값
    const expected = EXPECTED_M1[name];
    if (expected?.paragraphs !== undefined) assert.equal(all.length, expected.paragraphs);
    if (expected?.tables !== undefined) assert.equal(all.flatMap((p) => p.objects).filter((o) => o.type === "tbl").length, expected.tables);
    assert.ok(!doc.issues.some((i) => i.code === "MODEL_UNREACHED_PARAGRAPH"), "모델에 연결되지 않은 문단이 없다");
    // 최상위 문단 수는 구역 루트의 직계 hp:p 수
    assert.equal(doc.sections[0]?.paragraphs.length, doc.sections[0]?.root.children.filter((c) => "local" in c && c.local === "p").length);
  });
}

// ── M2 ──────────────────────────────────────────────────────────────────

/** 정규식만으로 문단별 hp:t 내용을 뽑는다. 문단은 시작 태그 순서(= 문서 순서)로 늘어놓는다. */
function referenceParagraphTexts(sectionText: string): string[] {
  const token = /<hp:p(?=[\s>\/])[^>]*?(\/?)>|<\/hp:p>|<hp:t(?:\s[^>]*[^>\/])?>([\s\S]*?)<\/hp:t>/g;
  const texts: string[] = [];
  const stack: number[] = [];
  for (const m of sectionText.matchAll(token)) {
    const tag = m[0];
    if (tag.startsWith("</hp:p")) {
      stack.pop();
    } else if (tag.startsWith("<hp:p")) {
      texts.push("");
      if (m[1] !== "/") stack.push(texts.length - 1);
    } else {
      const owner = stack[stack.length - 1];
      assert.ok(owner !== undefined, "문단 밖의 hp:t");
      const inner = (m[2] ?? "").replace(/<[^>]*>/g, "");
      texts[owner] += inner.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, body: string) => {
        if (body === "lt") return "<";
        if (body === "gt") return ">";
        if (body === "amp") return "&";
        if (body === "quot") return '"';
        if (body === "apos") return "'";
        return String.fromCodePoint(body.startsWith("#x") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
      });
    }
  }
  return texts;
}

const STRIP = /[￼\t\n  ­]/g;

for (const name of FIXTURE_NAMES) {
  test(`M2 논리 텍스트에서 U+FFFC·인라인 문자를 뺀 것이 hp:t 직접 추출값과 같다: ${name}`, () => {
    const doc = load(name);
    const reference = referenceParagraphTexts(entryText(name, SECTION));
    const model = allParagraphs(doc);
    assert.equal(model.length, reference.length);
    let nonEmpty = 0;
    model.forEach((p, i) => {
      const expected = (reference[i] ?? "").replace(STRIP, "");
      assert.equal(p.logicalText.replace(STRIP, ""), expected, `문단 ${p.path.join("/")}`);
      if (expected !== "") nonEmpty++;
    });
    assert.ok(nonEmpty > 0 || name === "hancom-field", "실제 텍스트가 비교에 쓰였다");
  });
}

// ── 문단·조각·객체 구조 (5.2) ───────────────────────────────────────────

test("5.2 Piece·논리 텍스트: 텍스트·엔티티·인라인·객체·CDATA·여러 run", () => {
  const body =
    `<hp:p paraPrIDRef="0" styleIDRef="0">` +
    `<hp:run charPrIDRef="0"><hp:t>A &amp; B<hp:tab width="1" leader="0" type="1"/>C&#x1F600;<hp:lineBreak/><![CDATA[x<y]]></hp:t>` +
    `<hp:tbl id="7" rowCnt="1" colCnt="1"><hp:tr><hp:tc borderFillIDRef="1"><hp:subList><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="1"><hp:t>cell</hp:t></hp:run></hp:p></hp:subList>` +
    `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>` +
    `<hp:t>tail</hp:t></hp:run>` +
    `<hp:run charPrIDRef="1"><hp:t>second<hp:nbSpace/><hp:fwSpace/><hp:hyphen/><hp:markpenBegin/>x</hp:t></hp:run></hp:p>`;
  const doc = parseSynthetic([body]);
  assert.deepEqual(doc.issues, []);
  const p = doc.sections[0]?.paragraphs[0];
  assert.ok(p !== undefined);
  const text = doc.sections[0]?.text ?? "";

  // 명세의 표에서 손으로 계산한 기대값: [kind, 원문 구간, 논리 시작, 논리 끝, run]
  const tbl = text.slice(text.indexOf("<hp:tbl"), text.indexOf("</hp:tbl>") + "</hp:tbl>".length);
  const expected: [string, string, number, number, number][] = [
    ["text", "A ", 0, 2, 0],
    ["entity", "&amp;", 2, 3, 0],
    ["text", " B", 3, 5, 0],
    ["inline", '<hp:tab width="1" leader="0" type="1"/>', 5, 6, 0],
    ["text", "C", 6, 7, 0],
    ["entity", "&#x1F600;", 7, 9, 0],
    ["inline", "<hp:lineBreak/>", 9, 10, 0],
    ["text", "x<y", 10, 13, 0],
    ["object", tbl, 13, 14, 0],
    ["text", "tail", 14, 18, 0],
    ["text", "second", 18, 24, 1],
    ["inline", "<hp:nbSpace/>", 24, 25, 1],
    ["inline", "<hp:fwSpace/>", 25, 26, 1],
    ["inline", "<hp:hyphen/>", 26, 27, 1],
    ["inline", "<hp:markpenBegin/>", 27, 27, 1],
    ["text", "x", 27, 28, 1],
  ];
  assert.deepEqual(
    p.pieces.map((q) => [q.kind, text.slice(q.start, q.end), q.logicalStart, q.logicalEnd, q.runOrdinal]),
    expected,
  );
  assert.equal(p.logicalText, "A & B\tC😀\nx<y￼tailsecond  ­x");
  for (const q of p.pieces) {
    assert.equal(p.logicalText.length >= q.logicalEnd, true);
  }
  assert.deepEqual(p.runs.map((r) => [r.ordinal, r.charPrIDRef]), [[0, "0"], [1, "1"]]);
  assert.deepEqual(p.attrs, { paraPrIDRef: "0", styleIDRef: "0" });
  assert.equal(p.lineSegArray, undefined);
  assert.deepEqual(p.path, [0]);

  // 객체·표·셀
  assert.equal(p.objects.length, 1);
  const o = p.objects[0];
  assert.ok(o !== undefined && isTableNode(o));
  assert.equal(o.type, "tbl");
  assert.equal(o.id, "7");
  assert.equal(o.instId, undefined);
  assert.equal(o.pieceIndex, 8);
  assert.deepEqual([o.rowCnt, o.colCnt, o.cells.length], [1, 1, 1]);
  const cell = o.cells[0];
  assert.ok(cell !== undefined);
  assert.deepEqual([cell.row, cell.col, cell.rowSpan, cell.colSpan, cell.borderFillIDRef], [0, 0, 1, 1, "1"]);
  assert.equal(cell.subList, p.subLists[0]);
  assert.equal(o.subLists[0], p.subLists[0]);
  assert.equal(p.subLists[0]?.owner, "tc");
  const inner = p.subLists[0]?.paragraphs[0];
  assert.deepEqual(inner?.path, [0, 0, 0]);
  assert.equal(inner?.logicalText, "cell");
});

test("5.2 주소: 하위목록 서수는 문단 안 subList의 문서 순서이고 중첩 표도 이어진다", () => {
  const cell = (inner: string, col: number) =>
    `<hp:tc borderFillIDRef="1"><hp:subList>${inner}</hp:subList><hp:cellAddr colAddr="${col}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`;
  const para = (runInner: string) => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${runInner}</hp:run></hp:p>`;
  const table = (cells: string) => `<hp:tbl id="1" rowCnt="1" colCnt="2"><hp:tr>${cells}</hp:tr></hp:tbl>`;
  const inner = table(cell(para("<hp:t>c0</hp:t>"), 0) + cell(para("<hp:t>c1</hp:t>"), 1));
  const body =
    para("<hp:t>first</hp:t>") +
    para(
      table(cell(para(inner), 0) + cell(para("<hp:t>b</hp:t>") + para("<hp:t>b2</hp:t>"), 1)) +
        table(cell(para("<hp:t>x</hp:t>"), 0)),
    );
  const doc = parseSynthetic([body]);
  const host = doc.sections[0]?.paragraphs[1];
  assert.ok(host !== undefined);
  assert.deepEqual(host.path, [1]);
  assert.equal(host.objects.length, 2);
  assert.deepEqual(host.subLists.map((s) => s.owner), ["tc", "tc", "tc"]);
  // 두 번째 표의 첫 셀 문단은 호스트 문단의 세 번째 subList(서수 2)
  assert.deepEqual(host.subLists[2]?.paragraphs[0]?.path, [1, 2, 0]);
  assert.deepEqual(host.objects[1]?.subLists.map((s) => s.paragraphs[0]?.logicalText), ["x"]);
  assert.deepEqual(host.objects[0]?.subLists.length, 2);
  // 셀 안의 둘째 문단
  assert.deepEqual(host.subLists[1]?.paragraphs.map((q) => q.path), [[1, 1, 0], [1, 1, 1]]);
  // 중첩: 첫 셀의 문단이 가진 표의 첫 셀
  const nested = host.subLists[0]?.paragraphs[0]?.subLists[0]?.paragraphs[0];
  assert.deepEqual(nested?.path, [1, 0, 0, 0, 0]);
  assert.equal(nested?.logicalText, "c0");
  // 선행 순회 순서가 원문 순서와 같다. 객체(표)는 논리 텍스트에서 U+FFFC 한 글자다.
  const order = allParagraphs(doc).map((q) => q.logicalText);
  assert.deepEqual(order, ["first", "￼￼", "￼", "c0", "c1", "b", "b2", "x"]);
});

test("5.2 요소 비교는 접두사가 아니라 (역할, local)이다: 2016·2024 네임스페이스로 쓴 문단", () => {
  const section =
    `<s:sec xmlns:s="http://www.owpml.org/owpml/2024/section" xmlns:q="http://www.owpml.org/owpml/2024/paragraph" xmlns:w="http://www.hancom.co.kr/hwpml/2016/paragraph">` +
    `<q:p paraPrIDRef="0" styleIDRef="0"><w:run charPrIDRef="0"><q:t>ab<w:tab/>c</q:t></w:run></q:p></s:sec>`;
  const doc = parseSynthetic([section], MINIMAL_HEADER, true);
  const p = doc.sections[0]?.paragraphs[0];
  assert.equal(p?.logicalText, "ab\tc");
  assert.deepEqual(p?.pieces.map((x) => x.kind), ["text", "inline", "text"]);
});

test("5.2 하위 목록의 owner: 표 셀, 머리말·꼬리말", () => {
  // 머리말·꼬리말이 든 fixture를 찾는다
  let seen = 0;
  for (const name of FIXTURE_NAMES) {
    const doc = load(name);
    const text = entryText(name, SECTION);
    const owners = allParagraphs(doc)
      .flatMap((p) => p.subLists)
      .map((s) => s.owner);
    assert.equal(owners.filter((o) => o === "tc").length, count(text, /<hp:tc[\s>]/g), `${name}: 셀 수`);
    assert.equal(owners.filter((o) => o === "header").length, count(text, /<hp:header[\s>]/g));
    assert.equal(owners.filter((o) => o === "footer").length, count(text, /<hp:footer[\s>]/g));
    assert.equal(owners.length, count(text, /<hp:subList[\s>]/g), `${name}: 모든 subList가 연결된다`);
    seen += owners.filter((o) => o === "header" || o === "footer").length;
  }
  assert.ok(seen >= 2, "fixtures에 머리말·꼬리말이 있다");
});

test("5.2 표: 행·열 수와 셀 좌표·병합이 원문과 같다", () => {
  for (const name of FIXTURE_NAMES) {
    const doc = load(name);
    const text = entryText(name, SECTION);
    const tables = allParagraphs(doc).flatMap((p) => p.objects).filter(isTableNode);
    // 독립 기준: 원문의 <hp:tbl ...> 여는 태그를 순서대로 읽는다
    const heads = [...text.matchAll(/<hp:tbl\s[^>]*>/g)].map((m) => m[0]);
    assert.equal(tables.length, heads.length);
    tables.forEach((t, i) => {
      const head = heads[i] ?? "";
      assert.equal(t.rowCnt, Number(/rowCnt="(\d+)"/.exec(head)?.[1]));
      assert.equal(t.colCnt, Number(/colCnt="(\d+)"/.exec(head)?.[1]));
      assert.equal(t.id, /\sid="([^"]*)"/.exec(head)?.[1]);
      assert.ok(t.cells.length >= 1);
      for (const c of t.cells) {
        assert.ok(c.row >= 0 && c.row < t.rowCnt && c.col >= 0 && c.col < t.colCnt, `${name}: 셀 좌표`);
        assert.ok(c.subList !== null);
        assert.equal(c.subList.owner, "tc");
      }
    });
    // 셀의 (행,열)·병합 값은 원문 순서의 cellAddr/cellSpan과 같다
    const addrs = [...text.matchAll(/<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"\/><hp:cellSpan colSpan="(\d+)" rowSpan="(\d+)"\/>/g)];
    const cells = tables.flatMap((t) => t.cells);
    // 표가 중첩되면 문서 순서가 달라지므로 집합으로 비교한다
    const key = (a: number[]) => a.join(",");
    assert.deepEqual(
      cells.map((c) => key([c.col, c.row, c.colSpan, c.rowSpan])).sort(),
      addrs.map((m) => key([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])).sort(),
    );
  }
});

test("5.2 D1의 첫 표: 8행 5열, 셀 문단의 주소와 텍스트가 원문 순서와 같다", () => {
  const doc = load("D1");
  const text = entryText("D1", SECTION);
  const hostIndex = doc.sections[0]?.paragraphs.findIndex((p) => p.objects.some((o) => o.type === "tbl")) ?? -1;
  assert.ok(hostIndex >= 0);
  const host = doc.sections[0]?.paragraphs[hostIndex];
  const tbl = host?.objects[0];
  assert.ok(tbl !== undefined && isTableNode(tbl));
  assert.deepEqual([tbl.rowCnt, tbl.colCnt], [8, 5]);
  assert.equal(tbl.cells.length, 40);
  // 독립 기준: 첫 <hp:tbl> 구간을 <hp:tc 단위로 잘라 첫 hp:t 내용을 읽는다
  const start = text.indexOf("<hp:tbl");
  const end = text.indexOf("</hp:tbl>");
  const tcs = text.slice(start, end).split("<hp:tc ").slice(1);
  assert.equal(tcs.length, 40);
  tbl.cells.forEach((cell, k) => {
    const first = /<hp:t>([^<]*)<\/hp:t>/.exec(tcs[k] ?? "")?.[1] ?? "";
    const para = cell.subList?.paragraphs[0];
    assert.deepEqual(para?.path, [hostIndex, k, 0]);
    assert.equal(para?.logicalText, first.replace(/&amp;/g, "&"));
  });
});

test("5.2 hancom-merged: 모든 문단에 조판 캐시(linesegarray)가 있고 문단 id는 고유하지 않다", () => {
  const doc = load("hancom-merged");
  const all = allParagraphs(doc);
  const text = entryText("hancom-merged", SECTION);
  assert.equal(all.filter((p) => p.lineSegArray !== undefined).length, count(text, /<hp:linesegarray[\s>]/g));
  assert.equal(all.filter((p) => p.lineSegArray !== undefined).length, all.length);
  const ids = all.map((p) => p.attrs.id);
  assert.ok(ids.every((id) => id !== undefined));
  assert.ok(new Set(ids).size < ids.length, "id가 겹치는 문단이 있다(주소로 쓰지 않는 이유)");
  // run 수는 원문의 hp:run 수와 같다
  assert.equal(all.reduce((n, p) => n + p.runs.length, 0), count(text, /<hp:run[\s>]/g));
  for (const p of all) assert.equal(p.lineSegArray?.local, "linesegarray");
});

test("5.2 D1: 서식 참조(paraPrIDRef·styleIDRef·charPrIDRef)가 원문과 같다", () => {
  const doc = load("D1");
  const text = entryText("D1", SECTION);
  const all = allParagraphs(doc);
  const heads = [...text.matchAll(/<hp:p\s[^>]*>/g)].map((m) => m[0]);
  assert.equal(heads.length, all.length);
  all.forEach((p, i) => {
    assert.equal(p.attrs.paraPrIDRef, /paraPrIDRef="(\d+)"/.exec(heads[i] ?? "")?.[1]);
    assert.equal(p.attrs.styleIDRef, /styleIDRef="(\d+)"/.exec(heads[i] ?? "")?.[1]);
    assert.equal(p.attrs.id, undefined, "D1 문단에는 id 속성이 없다");
  });
  const runIds = [...text.matchAll(/<hp:run charPrIDRef="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    all.flatMap((p) => p.runs.map((r) => r.charPrIDRef)).sort(),
    runIds.sort(),
  );
});

test("5.2 ObjectNode: id와 instId(instid 표기 포함), 표가 아닌 객체는 표 정보가 없다", () => {
  const body =
    `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">` +
    `<hp:pic id="5" instid="9" zOrder="0"><hp:caption><hp:subList><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>cap</hp:t></hp:run></hp:p></hp:subList></hp:caption></hp:pic>` +
    `<hp:rect id="6" instId="10"/>` +
    `<hp:equation/>` +
    `</hp:run></hp:p>`;
  const p = parseSynthetic([body]).sections[0]?.paragraphs[0];
  assert.ok(p !== undefined);
  assert.deepEqual(
    p.objects.map((o) => [o.type, o.id, o.instId, o.subLists.length, isTableNode(o)]),
    [
      ["pic", "5", "9", 1, false],
      ["rect", "6", "10", 0, false],
      ["equation", undefined, undefined, 0, false],
    ],
  );
  assert.equal(p.subLists[0]?.owner, "caption");
  assert.deepEqual(p.subLists[0]?.paragraphs[0]?.path, [0, 0, 0]);
  assert.equal(p.logicalText, "￼￼￼");
});

test("5.2 구역 문단에 연결되지 않은 hp:p는 경고로 알린다 (MODEL_UNREACHED_PARAGRAPH)", () => {
  const body =
    `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:foo>` +
    `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>x</hp:t></hp:run></hp:p>` +
    `</hp:foo></hp:run></hp:p>`;
  const doc = parseSynthetic([body]);
  assert.deepEqual(
    doc.issues.map((i) => [i.severity, i.code, i.where]),
    [["warning", "MODEL_UNREACHED_PARAGRAPH", SECTION]],
  );
});

test("5.2 루트 요소가 header는 head, 구역은 sec가 아니면 MODEL_ROOT_ELEMENT", () => {
  const sec = `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"/>`;
  assert.throws(
    () => parseSynthetic(['<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"/>'], MINIMAL_HEADER, true),
    (e: unknown) => e instanceof HwpxError && e.code === "MODEL_ROOT_ELEMENT" && e.where === SECTION,
  );
  assert.throws(
    () => parseSynthetic([sec], '<x:head xmlns:x="urn:other"/>', true),
    (e: unknown) => e instanceof HwpxError && e.code === "MODEL_ROOT_ELEMENT" && e.where === HEADER,
  );
  // 빈 구역은 문단이 없는 정상 문서다
  assert.deepEqual(parseSynthetic([sec], MINIMAL_HEADER, true).sections[0]?.paragraphs, []);
});

// ── M3 ──────────────────────────────────────────────────────────────────

test("M3 hancom-field에서 listFields가 성명·홍길동·dirty 1·simple 하나를 돌려준다", () => {
  const fields = listFields(load("hancom-field"));
  assert.deepEqual(fields, [
    {
      name: "성명",
      type: "CLICK_HERE",
      occurrence: 0,
      sectionIndex: 0,
      path: [0],
      valueText: "홍길동",
      dirty: "1",
      shape: "simple",
    },
  ] satisfies FieldInfo[]);
});

test("5.2 hancom-field: FieldMark의 id·beginIDRef와 ctrl 위치", () => {
  const p = load("hancom-field").sections[0]?.paragraphs[0];
  assert.ok(p !== undefined);
  assert.equal(p.fieldMarks.length, 2);
  const [begin, end] = p.fieldMarks;
  assert.ok(begin !== undefined && end !== undefined);
  assert.equal(begin.kind, "begin");
  assert.equal(begin.id, "1208372794");
  assert.equal(begin.name, "성명");
  assert.equal(begin.type, "CLICK_HERE");
  assert.equal(begin.dirty, "1");
  assert.equal(begin.element.local, "fieldBegin");
  assert.equal(end.kind, "end");
  assert.equal(end.beginIDRef, "1208372794");
  assert.equal(end.id, "627272811");
  assert.equal(end.name, undefined);
  assert.equal(p.pieces[begin.pieceIndex]?.kind, "object");
  assert.ok(p.pieces[begin.pieceIndex]!.end <= p.pieces[end.pieceIndex]!.start);
  assert.deepEqual(p.bookmarks, []);
});

function fieldDoc(change: (t: string) => string): FieldInfo[] {
  return listFields(loadMutated("hancom-field", SECTION, change));
}

test("5.3 listFields: shape 다섯 종류", () => {
  // empty: 사이에 hp:t가 없다
  const empty = fieldDoc((t) => t.replace("<hp:t>홍길동</hp:t>", ""));
  assert.deepEqual(empty.map((f) => [f.shape, f.valueText]), [["empty", ""]]);
  // inline: 사이에 인라인 자식이 있다
  const inline = fieldDoc((t) => t.replace("<hp:t>홍길동</hp:t>", '<hp:t>홍<hp:tab width="1" leader="0" type="1"/>길동</hp:t>'));
  assert.deepEqual(inline.map((f) => [f.shape, f.valueText]), [["inline", "홍\t길동"]]);
  // 엔티티가 있어도 simple이다
  const entity = fieldDoc((t) => t.replace("홍길동", "홍&amp;길동"));
  assert.deepEqual(entity.map((f) => [f.shape, f.valueText]), [["simple", "홍&길동"]]);
  // unpaired: fieldEnd가 없다
  const unpaired = fieldDoc((t) => t.replace(/<hp:ctrl><hp:fieldEnd[^>]*\/><\/hp:ctrl>/, ""));
  assert.deepEqual(unpaired.map((f) => [f.shape, f.valueText]), [["unpaired", ""]]);
  // crossParagraph: fieldEnd가 다음 문단에 있다
  const cross = fieldDoc((t) =>
    t.replace(
      /(<hp:ctrl><hp:fieldEnd)/,
      `</hp:run></hp:p><hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">$1`,
    ),
  );
  assert.deepEqual(cross.map((f) => [f.shape, f.path]), [["crossParagraph", [0]]]);
  // 사이에 다른 객체(ctrl)가 끼어도 simple이 아니다
  const objectBetween = fieldDoc((t) => t.replace("<hp:t>홍길동</hp:t>", '<hp:t>홍</hp:t><hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl><hp:t>길동</hp:t>'));
  assert.deepEqual(objectBetween.map((f) => f.shape), ["inline"]);
});

test("5.3 listFields: HYPERLINK는 빼고 알 수 없는 type은 넣는다", () => {
  assert.deepEqual(fieldDoc((t) => t.replace('type="CLICK_HERE"', 'type="HYPERLINK"')), []);
  const other = fieldDoc((t) => t.replace('type="CLICK_HERE"', 'type="SOMETHING_NEW"'));
  assert.deepEqual(other.map((f) => [f.name, f.type, f.shape]), [["성명", "SOMETHING_NEW", "simple"]]);
  const noType = fieldDoc((t) => t.replace(' type="CLICK_HERE"', ""));
  assert.deepEqual(noType.map((f) => [f.name, f.type]), [["성명", ""]]);
});

test("5.3 listFields: 같은 이름은 문서 순서로 occurrence 0부터, 이름이 다르면 따로 센다", () => {
  const fields = fieldDoc((t) => {
    const p = /<hp:p [\s\S]*<\/hp:p>/.exec(t)?.[0] ?? "";
    const second = p.replaceAll("1208372794", "1208372795").replace('id="3121190098"', 'id="3121190099"').replace("홍길동", "김철수");
    const third = p
      .replaceAll("1208372794", "1208372796")
      .replace('id="3121190098"', 'id="3121190100"')
      .replace('name="성명"', 'name="주소"')
      .replace("홍길동", "서울");
    return t.replace(p, p + second + third);
  });
  assert.deepEqual(
    fields.map((f) => [f.name, f.occurrence, f.valueText, f.path, f.shape]),
    [
      ["성명", 0, "홍길동", [0], "simple"],
      ["성명", 1, "김철수", [1], "simple"],
      ["주소", 0, "서울", [2], "simple"],
    ],
  );
});

test("5.3 listFields: 표 셀 안 누름틀의 주소와 dirty 없음", () => {
  const field = (name: string, id: string) =>
    `<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}"/></hp:ctrl><hp:t>v${id}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="9"/></hp:ctrl></hp:run>`;
  const body =
    `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl id="1" rowCnt="1" colCnt="2"><hp:tr>` +
    `<hp:tc borderFillIDRef="1"><hp:subList><hp:p paraPrIDRef="0" styleIDRef="0">${field("a", "11")}</hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>` +
    `<hp:tc borderFillIDRef="1"><hp:subList><hp:p paraPrIDRef="0" styleIDRef="0">${field("b", "12")}</hp:p></hp:subList><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>` +
    `</hp:tr></hp:tbl></hp:run></hp:p>`;
  const fields = listFields(parseSynthetic([body]));
  assert.deepEqual(
    fields.map((f) => [f.name, f.path, f.valueText, f.dirty, f.shape, f.sectionIndex]),
    [
      ["a", [0, 0, 0], "v11", "", "simple", 0],
      ["b", [0, 1, 0], "v12", "", "simple", 0],
    ],
  );
});

test("5.2 책갈피를 문단에 기록한다", () => {
  const body = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:bookmark name="BM_1"/></hp:ctrl><hp:t>x</hp:t><hp:ctrl><hp:bookmark name="BM_2"/></hp:ctrl></hp:run></hp:p>`;
  const p = parseSynthetic([body]).sections[0]?.paragraphs[0];
  assert.deepEqual(p?.bookmarks.map((b) => [b.name, b.element.local]), [["BM_1", "bookmark"], ["BM_2", "bookmark"]]);
  assert.equal(p?.logicalText, "￼x￼");
});

// ── M4 ──────────────────────────────────────────────────────────────────

const LISTS: [string, string, string][] = [
  ["borderFills", "borderFill", "borderFill"],
  ["charProperties", "charPr", "charPr"],
  ["tabProperties", "tabPr", "tabPr"],
  ["numberings", "numbering", "numbering"],
  ["bullets", "bullet", "bullet"],
  ["paraProperties", "paraPr", "paraPr"],
  ["styles", "style", "style"],
];

for (const name of FIXTURE_NAMES) {
  test(`M4 자원 수가 header의 itemCnt와 같다: ${name}`, () => {
    const doc = load(name);
    const text = doc.header.text;
    for (const [list, item, kind] of LISTS) {
      const declared = /* 독립: 원문에서 선언값을 읽는다 */ text.match(new RegExp(`<hh:${list}[^>]*\\sitemCnt="(\\d+)"`))?.[1];
      const itemTags = count(text, new RegExp(`<hh:${item}[\\s>/]`, "g"));
      const modelCount = doc.header.resources[kind]?.length ?? -1;
      if (declared === undefined) {
        assert.equal(itemTags, 0, `${list} 목록이 없으면 항목도 없다`);
        continue;
      }
      assert.equal(modelCount, Number(declared), `${name}: ${kind} 모델 수 대 itemCnt`);
      assert.equal(itemTags, Number(declared), `${name}: ${kind} 원문 항목 수 대 itemCnt`);
    }
    // 글꼴: fontfaces의 itemCnt는 fontface 수, 각 fontface의 fontCnt는 font 수
    const faceCount = count(text, /<hh:fontface[\s>]/g);
    assert.equal(Number(text.match(/<hh:fontfaces[^>]*\sitemCnt="(\d+)"/)?.[1]), faceCount);
    const fontCnts = [...text.matchAll(/<hh:fontface\s[^>]*fontCnt="(\d+)"/g)].map((m) => Number(m[1]));
    assert.equal(fontCnts.reduce((a, b) => a + b, 0), count(text, /<hh:font[\s>]/g));
    assert.equal(doc.header.resources["font"]?.length, count(text, /<hh:font[\s>]/g));
    // 언어별 개수
    for (const m of text.matchAll(/<hh:fontface\s+lang="(\w+)"\s+fontCnt="(\d+)"/g)) {
      assert.equal(doc.header.resources["font"]?.filter((f) => f.lang === m[1]).length, Number(m[2]), `${name}: ${m[1]} 글꼴 수`);
    }
    // counts: 속성 위치와 값
    for (const slot of doc.header.counts) {
      assert.equal(text.slice(slot.attr.valueStart, slot.attr.valueEnd), String(slot.value));
      assert.equal(slot.value, slot.actual, `${name}: ${slot.list} 선언값 대 실제`);
    }
    assert.equal(doc.header.counts.length, 1 + 7 + LISTS.filter(([list]) => text.includes(`<hh:${list} `)).length);
    // secCnt
    const sec = doc.header.secCnt;
    assert.ok(sec !== null);
    assert.equal(text.slice(sec.attr.valueStart, sec.attr.valueEnd), String(sec.value));
    assert.equal(sec.value, doc.pkg.sectionEntries.length);
    assert.equal(sec.element, doc.header.root);
  });
}

test("M4 D1: charPr 11, paraPr 8, borderFill 2", () => {
  const r = load("D1").header.resources;
  assert.equal(r["charPr"]?.length, 11);
  assert.equal(r["paraPr"]?.length, 8);
  assert.equal(r["borderFill"]?.length, 2);
  assert.deepEqual(r["charPr"]?.map((x) => x.id), ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
});

test("5.2 자원: 글꼴은 언어별, 항목은 요소와 id를 가진다", () => {
  const r = load("D1").header.resources;
  const langs = [...new Set(r["font"]?.map((f) => f.lang))];
  assert.deepEqual(langs, ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"]);
  assert.equal(r["font"]?.length, 21);
  const first = r["font"]?.[0];
  assert.equal(first?.element.local, "font");
  assert.equal(first?.element.attrs.find((a) => a.qname === "face")?.value, "함초롬바탕");
  assert.deepEqual(r["numbering"]?.map((n) => n.id), ["1"]);
  assert.deepEqual(r["bullet"], []);
  assert.deepEqual(r["tabPr"], []);
});

test("5.2 ResourceRef: charPr→font·borderFill, paraPr→tabPr·borderFill, style→charPr·paraPr·style", () => {
  const h = load("hancom-field").header;
  const text = h.text;
  const charPr0 = h.resources["charPr"]?.[0];
  assert.deepEqual(
    charPr0?.refs.map((r) => [r.kind, r.lang, r.id, text.slice(r.attr.valueStart, r.attr.valueEnd)]),
    [
      ["font", "HANGUL", "1", "1"],
      ["font", "LATIN", "1", "1"],
      ["font", "HANJA", "1", "1"],
      ["font", "JAPANESE", "1", "1"],
      ["font", "OTHER", "1", "1"],
      ["font", "SYMBOL", "1", "1"],
      ["font", "USER", "1", "1"],
      ["borderFill", undefined, "2", "2"],
    ],
  );
  assert.equal(charPr0?.refs[0]?.element.local, "fontRef");
  assert.equal(charPr0?.refs[7]?.element, charPr0?.element);
  const paraPr = h.resources["paraPr"]?.[0];
  assert.deepEqual(paraPr?.refs.map((r) => r.kind), ["tabPr", "borderFill"]);
  assert.equal(paraPr?.refs[1]?.element.local, "border");
  const style = h.resources["style"]?.[1];
  assert.deepEqual(style?.refs.map((r) => r.kind), ["paraPr", "charPr", "style"]);
  // 원문 속성과 독립 비교: 첫 스타일의 nextStyleIDRef
  const firstStyle = /<hh:style [^>]*>/.exec(text)?.[0] ?? "";
  assert.equal(h.resources["style"]?.[0]?.refs.find((r) => r.kind === "style")?.id, /nextStyleIDRef="(\d+)"/.exec(firstStyle)?.[1]);
});

test("5.2 paraPr의 heading: NUMBER·BULLET만 numbering·bullet 참조, OUTLINE·NONE은 참조 아님", () => {
  const header = (type: string, idRef: string) =>
    MINIMAL_HEADER.replace('<hh:heading type="NONE" idRef="0" level="0"/>', `<hh:heading type="${type}" idRef="${idRef}" level="0"/>`);
  const refsOf = (type: string, idRef: string) =>
    parseSynthetic([""], header(type, idRef)).header.resources["paraPr"]?.[0]?.refs.map((r) => [r.kind, r.id]);
  assert.deepEqual(refsOf("NONE", "5"), [["borderFill", "1"]]);
  assert.deepEqual(refsOf("OUTLINE", "5"), [["borderFill", "1"]]);
  assert.deepEqual(refsOf("NUMBER", "3"), [["numbering", "3"], ["borderFill", "1"]]);
  assert.deepEqual(refsOf("BULLET", "4"), [["bullet", "4"], ["borderFill", "1"]]);
});

test("5.2 refList 안의 그 밖 목록은 other:<목록 이름>", () => {
  const header = MINIMAL_HEADER.replace(
    "</hh:refList>",
    '<hh:memoProperties itemCnt="2"><hh:memoPr id="1" width="1"/><hh:memoPr id="2"/></hh:memoProperties><hh:trackChangeAuthors itemCnt="1"><hh:trackChangeAuthor name="x"/></hh:trackChangeAuthors></hh:refList>',
  );
  const doc = parseSynthetic([""], header);
  assert.deepEqual(doc.header.resources["other:memoProperties"]?.map((x) => x.id), ["1", "2"]);
  assert.deepEqual(doc.header.resources["other:trackChangeAuthors"]?.map((x) => x.id), ["0"], "id가 없으면 목록 안 순번");
  const slot = doc.header.counts.find((c) => c.list === "memoProperties");
  assert.deepEqual([slot?.kind, slot?.value, slot?.actual], ["other:memoProperties", 2, 2]);
});

// ── M5 ──────────────────────────────────────────────────────────────────

const idsOf = (text: string, re: RegExp): Set<string> => new Set([...text.matchAll(re)].map((m) => m[1] ?? ""));
const missing = (referenced: Set<string>, defined: Set<string>): string[] => [...referenced].filter((id) => !defined.has(id)).sort();

function expectedBodyMissing(sectionText: string, headerText: string): string[] {
  const out: string[] = [];
  const pairs: [string, string, string][] = [
    ["charPr", "charPrIDRef", "charPr"],
    ["paraPr", "paraPrIDRef", "paraPr"],
    ["style", "styleIDRef", "style"],
    ["borderFill", "borderFillIDRef", "borderFill"],
    ["numbering", "outlineShapeIDRef", "numbering"],
  ];
  for (const [kind, attr, tag] of pairs) {
    const referenced = idsOf(sectionText, new RegExp(`\\s${attr}="([^"]*)"`, "g"));
    const defined = idsOf(headerText, new RegExp(`<hh:${tag}\\s[^>]*?\\bid="([^"]*)"`, "g"));
    for (const id of missing(referenced, defined)) out.push(`${kind} ${id}`);
  }
  return out.sort();
}

function expectedHeaderMissing(headerText: string): string[] {
  const out: string[] = [];
  const defined = (tag: string) => idsOf(headerText, new RegExp(`<hh:${tag}\\s[^>]*?\\bid="([^"]*)"`, "g"));
  const check = (kind: string, referenced: Set<string>, ids: Set<string>) => {
    for (const id of missing(referenced, ids)) out.push(`${kind} ${id}`);
  };
  check("tabPr", idsOf(headerText, /\stabPrIDRef="([^"]*)"/g), defined("tabPr"));
  check("borderFill", idsOf(headerText, /\sborderFillIDRef="([^"]*)"/g), defined("borderFill"));
  check("paraPr", idsOf(headerText, /<hh:style\s[^>]*?\sparaPrIDRef="([^"]*)"/g), defined("paraPr"));
  check("charPr", idsOf(headerText, /<hh:style\s[^>]*?\scharPrIDRef="([^"]*)"/g), defined("charPr"));
  check("style", idsOf(headerText, /\snextStyleIDRef="([^"]*)"/g), defined("style"));
  // 글꼴: 언어별 정의와 fontRef의 언어별 값
  const fontIds = new Map<string, Set<string>>();
  for (const m of headerText.matchAll(/<hh:fontface\s+lang="(\w+)"[^>]*>([\s\S]*?)<\/hh:fontface>/g)) {
    fontIds.set(m[1] ?? "", idsOf(m[2] ?? "", /<hh:font\s[^>]*?\bid="([^"]*)"/g));
  }
  for (const m of headerText.matchAll(/<hh:fontRef\s([^>]*)\/>/g)) {
    for (const a of (m[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)) {
      const lang = (a[1] ?? "").toUpperCase();
      if (!(fontIds.get(lang)?.has(a[2] ?? "") ?? false)) out.push(`font(${lang}) ${a[2]}`);
    }
  }
  // 헤더 안 참조는 (종류, id)로 중복을 없앤다
  return [...new Set(out)].sort();
}

const issueTargets = (issues: { code: string; where?: string; message: string }[], where: string): string[] =>
  issues
    .filter((i) => i.code === "MODEL_REF_MISSING" && i.where === where)
    .map((i) => /^([^\s]+(?:\([A-Z]+\))? \S+?)이\(가\) 없는데/.exec(i.message)?.[1] ?? i.message)
    .map((s) => s.replace(/^font\(/, "font(")) // 글꼴은 "font(LANG) id" 형식 그대로 둔다
    .sort();

for (const name of FIXTURE_NAMES) {
  test(`M5 없는 참조 대상은 예외 없이 Issue로 모은다: ${name}`, () => {
    const doc = load(name);
    const sectionText = entryText(name, SECTION);
    assert.deepEqual(issueTargets(doc.issues, SECTION), expectedBodyMissing(sectionText, doc.header.text), "본문 참조");
    assert.deepEqual(issueTargets(doc.issues, HEADER), expectedHeaderMissing(doc.header.text), "header 안 참조");
    for (const i of doc.issues.filter((x) => x.code === "MODEL_REF_MISSING")) assert.equal(i.severity, "error");
    // IDRef로 끝나지만 자원이 아닌 속성은 unknown으로 모아 경고한다(문서마다 개수는 원문에서 센다)
    const unknownNames = [...new Set([...sectionText.matchAll(/\s(\w*IDRef)="/g)].map((m) => m[1] ?? ""))].filter(
      (n) =>
        ![
          "charPrIDRef",
          "paraPrIDRef",
          "styleIDRef",
          "borderFillIDRef",
          "binaryItemIDRef",
          "outlineShapeIDRef",
          "memoShapeIDRef",
          "beginIDRef",
          "linkListIDRef",
          "linkListNextIDRef",
        ].includes(n),
    );
    const warned = doc.issues.filter((i) => i.code === "MODEL_UNKNOWN_REF").map((i) => /해석하지 못한 (\w+) 속성이 (\d+)곳/.exec(i.message));
    assert.deepEqual(warned.map((m) => m?.[1]).sort(), unknownNames.sort());
    for (const m of warned) {
      assert.equal(Number(m?.[2]), count(sectionText, new RegExp(`\\s${m?.[1]}="`, "g")));
    }
    for (const i of doc.issues.filter((x) => x.code === "MODEL_UNKNOWN_REF")) assert.equal(i.severity, "warning");
  });
}

test("M5 D1과 D7에는 header 안에 실제로 없는 대상이 있다: tabPr 0 (8곳)", () => {
  for (const name of ["D1", "D7"]) {
    const issues = load(name).issues.filter((i) => i.code === "MODEL_REF_MISSING");
    assert.equal(issues.length, 1, name);
    assert.equal(issues[0]?.where, HEADER);
    assert.ok(issues[0]?.message.startsWith("tabPr 0이(가) 없는데 8곳"), issues[0]?.message);
  }
  // 그 밖의 fixtures는 깨끗하다
  for (const name of ["D2", "D3", "D4", "D5", "D6", "hancom-merged", "hancom-field"]) {
    assert.deepEqual(load(name).issues.filter((i) => i.code === "MODEL_REF_MISSING"), [], name);
  }
});

test("M5 본문 참조를 끊으면 예외가 아니라 Issue다 (charPr·paraPr·style·borderFill·numbering·binaryItem)", () => {
  const cases: [string, string, (t: string) => string, string][] = [
    ["charPr", "D2", (t) => t.replace('charPrIDRef="0"', 'charPrIDRef="99"'), "charPr 99"],
    ["paraPr", "D2", (t) => t.replace('paraPrIDRef="0"', 'paraPrIDRef="98"'), "paraPr 98"],
    ["style", "D2", (t) => t.replace('styleIDRef="0"', 'styleIDRef="97"'), "style 97"],
    ["borderFill", "D2", (t) => t.replace('borderFillIDRef="1"', 'borderFillIDRef="96"'), "borderFill 96"],
    ["numbering", "D2", (t) => t.replace('outlineShapeIDRef="1"', 'outlineShapeIDRef="95"'), "numbering 95"],
    ["binaryItem", "D2", (t) => t.replace("<hp:grid ", '<hp:grid binaryItemIDRef="image9" '), "binaryItem image9"],
  ];
  for (const [label, name, change, target] of cases) {
    const doc = loadMutated(name, SECTION, change);
    const hits = doc.issues.filter((i) => i.code === "MODEL_REF_MISSING");
    assert.equal(hits.length, 1, `${label}: ${JSON.stringify(doc.issues)}`);
    assert.equal(hits[0]?.where, SECTION);
    assert.ok(hits[0]?.message.startsWith(`${target}이(가) 없는데 1곳`), hits[0]?.message);
    // 모델은 여전히 완전하다
    assert.ok(allParagraphs(doc).length > 0);
  }
});

test("M5 빈 binaryItemIDRef는 참조 없음이다(없는 참조로 세지 않는다). 비어 있지 않은 없는 id는 지금처럼 센다", () => {
  const empty = loadMutated("D2", SECTION, (t) => t.replace("<hp:grid ", '<hp:grid binaryItemIDRef="" '));
  assert.deepEqual(empty.issues.filter((i) => i.code === "MODEL_REF_MISSING"), []);
  assert.deepEqual(empty.issues.filter((i) => i.code === "MODEL_UNKNOWN_REF"), []);
  const missing = loadMutated("D2", SECTION, (t) => t.replace("<hp:grid ", '<hp:grid binaryItemIDRef="image9" '));
  assert.equal(missing.issues.filter((i) => i.code === "MODEL_REF_MISSING").length, 1);
});

test("M5 binaryItemIDRef의 대상은 manifest 항목 id다", () => {
  const ok = loadMutated("D2", SECTION, (t) => t.replace("<hp:grid ", '<hp:grid binaryItemIDRef="section0" '));
  assert.deepEqual(ok.issues.filter((i) => i.code === "MODEL_REF_MISSING"), []);
});

test("M5 header 안 참조를 끊으면 Issue다 (font·borderFill·tabPr·style·paraPr·charPr)", () => {
  const cases: [(t: string) => string, string][] = [
    [(t) => t.replace('<hh:fontRef hangul="1"', '<hh:fontRef hangul="9"'), "font(HANGUL) 9"],
    [(t) => t.replace('borderFillIDRef="2"', 'borderFillIDRef="77"'), "borderFill 77"],
    [(t) => t.replace(/tabPrIDRef="\d+"/, 'tabPrIDRef="66"'), "tabPr 66"],
    [(t) => t.replace(/nextStyleIDRef="\d+"/, 'nextStyleIDRef="55"'), "style 55"],
    [(t) => t.replace(/(<hh:style [^>]*)\sparaPrIDRef="\d+"/, '$1 paraPrIDRef="44"'), "paraPr 44"],
    [(t) => t.replace(/(<hh:style [^>]*)\scharPrIDRef="\d+"/, '$1 charPrIDRef="33"'), "charPr 33"],
  ];
  for (const [change, target] of cases) {
    const doc = loadMutated("hancom-field", HEADER, change);
    const hits = doc.issues.filter((i) => i.code === "MODEL_REF_MISSING");
    assert.equal(hits.length, 1, `${target}: ${JSON.stringify(doc.issues)}`);
    assert.equal(hits[0]?.where, HEADER);
    assert.ok(hits[0]?.message.startsWith(`${target}이(가) 없는데`), hits[0]?.message);
  }
});

test("M5 ResourceRef: heading의 numbering·bullet 대상도 확인한다", () => {
  const header = (type: string, idRef: string) =>
    MINIMAL_HEADER.replace('<hh:heading type="NONE" idRef="0" level="0"/>', `<hh:heading type="${type}" idRef="${idRef}" level="0"/>`);
  const targets = (type: string, id: string) =>
    parseSynthetic([""], header(type, id)).issues.filter((i) => i.code === "MODEL_REF_MISSING").map((i) => i.message.split("이(가)")[0]);
  assert.deepEqual(targets("NUMBER", "3"), ["numbering 3"]);
  assert.deepEqual(targets("BULLET", "4"), ["bullet 4"]);
  assert.deepEqual(targets("OUTLINE", "9"), []);
  assert.deepEqual(targets("NONE", "9"), []);
  assert.deepEqual(parseSynthetic([""]).issues, [], "합성 최소 문서는 깨끗하다");
});

test("5.2 collectBodyRefs: 요소와 후손 전체, 종류별 분류, 누름틀 짝 속성은 제외", () => {
  const doc = load("hancom-field");
  const sec = doc.sections[0];
  assert.ok(sec !== undefined);
  const refs = collectBodyRefs(sec.root);
  const text = sec.text;
  const byKind = (k: string) => refs.filter((r) => r.kind === k).length;
  assert.equal(byKind("charPr"), count(text, /\scharPrIDRef="/g));
  assert.equal(byKind("paraPr"), count(text, /\sparaPrIDRef="/g));
  assert.equal(byKind("style"), count(text, /\sstyleIDRef="/g));
  assert.equal(byKind("borderFill"), count(text, /\sborderFillIDRef="/g));
  assert.equal(byKind("numbering"), count(text, /\soutlineShapeIDRef="/g));
  // 알 수 없는 참조는 없다: memoShapeIDRef는 메모 모양 참조(memoShape)다
  assert.deepEqual(refs.filter((r) => r.kind === "unknown").map((r) => r.attr.qname), []);
  assert.deepEqual(refs.filter((r) => r.kind === "memoShape").map((r) => r.attr.qname), ["memoShapeIDRef"]);
  assert.ok(!refs.some((r) => r.attr.qname === "beginIDRef"));
  for (const r of refs) assert.equal(text.slice(r.attr.valueStart, r.attr.valueEnd), r.id);
  // 일부 요소만 주면 그 후손만 센다
  const p = sec.paragraphs[0]?.element;
  assert.ok(p !== undefined);
  assert.equal(collectBodyRefs(p).length, refs.length);
  const run = sec.paragraphs[0]?.runs[1]?.element;
  assert.ok(run !== undefined);
  assert.deepEqual(collectBodyRefs(run).map((r) => r.kind), ["charPr"]);
  assert.deepEqual(collectBodyRefs(tokenizeRoot('<a x="1" fooIDRef="2"><b charPrIDRef="3"/></a>')).map((r) => [r.kind, r.id]), [["unknown", "2"], ["charPr", "3"]]);
});

function tokenizeRoot(xml: string) {
  return buildTree(xml, tokenize(xml));
}

test("5.2 linkListIDRef·linkListNextIDRef는 알 수 없는 참조가 아니다 (하위 목록의 연결 속성)", () => {
  const sub = '<hp:subList linkListIDRef="0" linkListNextIDRef="0"><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"/></hp:p></hp:subList>';
  const doc = parseSynthetic([`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl>${sub}</hp:tbl></hp:run></hp:p>`]);
  const refs = collectBodyRefs(doc.sections[0]?.root ?? tokenizeRoot("<a/>"));
  assert.deepEqual(refs.filter((r) => r.kind === "unknown"), []);
  assert.deepEqual(doc.issues.filter((i) => i.code === "MODEL_UNKNOWN_REF"), []);
  // 다른 IDRef는 그대로 알 수 없는 참조다
  assert.deepEqual(collectBodyRefs(tokenizeRoot('<a linkListIDRef="1" fooIDRef="2"/>')).map((r) => [r.kind, r.id]), [["unknown", "2"]]);
});

test("5.2 memoShapeIDRef: 메모 모양 목록이 있으면 대상을 확인하고, 없거나 값이 '없음'이면 무시한다", () => {
  const sec = (id: string) => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:secPr memoShapeIDRef="${id}"/></hp:run></hp:p>`;
  const withList = MINIMAL_HEADER.replace(
    "</hh:refList>",
    '<hh:memoProperties itemCnt="1"><hh:memoPr id="1" width="15591"/></hh:memoProperties></hh:refList>',
  );
  const missing = (doc: HwpxDocument) => doc.issues.filter((i) => i.code === "MODEL_REF_MISSING").map((i) => i.message.split("이(가)")[0]);
  // 목록이 있고 대상이 있다
  assert.deepEqual(missing(parseSynthetic([sec("1")], withList)), []);
  // 목록이 있는데 대상이 없다
  assert.deepEqual(missing(parseSynthetic([sec("9")], withList)), ["memoShape 9"]);
  // '없음' 값(0)은 목록이 있어도 확인하지 않는다
  assert.deepEqual(missing(parseSynthetic([sec("0")], withList)), []);
  // 목록이 없으면 무시한다
  const none = parseSynthetic([sec("9")]);
  assert.deepEqual(missing(none), []);
  assert.deepEqual(none.issues.filter((i) => i.code === "MODEL_UNKNOWN_REF"), []);
  // BodyRef 종류는 memoShape다
  assert.deepEqual(collectBodyRefs(none.sections[0]?.root ?? tokenizeRoot("<a/>")).filter((r) => r.kind === "memoShape").map((r) => r.id), ["9"]);
});

// ── M6 ──────────────────────────────────────────────────────────────────

function countAttrs(node: XmlJson): number {
  return Object.keys(node.attrs).length + node.children.reduce((n, c) => n + countAttrs(c), 0);
}

function countParagraphs(ps: ParagraphJson[]): number {
  return ps.reduce((n, p) => n + 1 + p.subLists.reduce((m, s) => m + countParagraphs(s.paragraphs), 0), 0);
}

const WRAPPERS = /^hh:(refList|fontfaces|fontface|borderFills|charProperties|tabProperties|numberings|bullets|paraProperties|styles)$/;

/** 원문에서 refList 안의 모든 속성을 센다. 목록 감싸개 요소의 속성은 뺀다(자원 항목이 아니다). */
function referenceResourceAttrCount(headerText: string): number {
  const start = headerText.indexOf("<hh:refList");
  const end = headerText.indexOf("</hh:refList>");
  const region = headerText.slice(start, end);
  let total = 0;
  for (const tag of region.matchAll(/<([\w:]+)((?:\s+[\w:.-]+="[^"]*")*)\s*\/?>/g)) {
    if (WRAPPERS.test(tag[1] ?? "")) continue;
    total += count(tag[2] ?? "", /\s[\w:.-]+="[^"]*"/g);
  }
  return total;
}

for (const name of FIXTURE_NAMES) {
  test(`M6 exportModel은 JSON 왕복 뒤에도 자원의 속성 수·문단 수가 같다: ${name}`, () => {
    const doc = load(name);
    const model = exportModel(doc);
    const json = JSON.stringify(model); // 순환 참조가 있으면 여기서 던진다
    const back = JSON.parse(json) as ModelJson;
    assert.deepEqual(back, model, "JSON 왕복 뒤 구조가 같다");

    const attrsOf = (m: ModelJson) =>
      Object.values(m.header.resources).reduce((n, items) => n + items.reduce((k, it) => k + countAttrs(it.tree), 0), 0);
    assert.equal(attrsOf(back), attrsOf(model));
    // 독립 기준: 원문 정규식으로 센 자원 항목 속성 수
    assert.equal(attrsOf(back), referenceResourceAttrCount(doc.header.text));
    assert.ok(attrsOf(back) > 100);

    const paragraphsOf = (m: ModelJson) => m.sections.reduce((n, s) => n + countParagraphs(s.paragraphs), 0);
    assert.equal(paragraphsOf(back), paragraphsOf(model));
    assert.equal(paragraphsOf(back), count(entryText(name, SECTION), /<hp:p[\s>\/]/g), "원문의 hp:p 수");
    assert.equal(paragraphsOf(back), allParagraphs(doc).length);
  });
}

test("5.4 exportModel: 원본 sha256·패키지 항목 목록·스키마 버전", () => {
  for (const name of FIXTURE_NAMES) {
    const bytes = readFixture(name);
    const doc = parseDocument(openPackage(bytes));
    const m = exportModel(doc);
    assert.equal(m.schemaVersion, 1);
    assert.deepEqual(m.source, { size: bytes.length, sha256: sha256Hex(bytes) });
    const listed = new Map(readFixtureText("SHA256SUMS").split("\n").map((l) => l.trim().split(/\s+/)).map(([h, n]) => [n, h]));
    assert.equal(m.source.sha256, listed.get(`${name}.hwpx`), "SHA256SUMS와 같다");
    assert.equal(m.entries.length, doc.pkg.archive.entries.length);
    for (const e of m.entries) {
      const entry = doc.pkg.archive.entries.find((x) => x.name === e.name);
      assert.ok(entry !== undefined);
      assert.equal(e.size, entry.size);
      assert.equal(e.method, entry.method);
      assert.match(e.sha256, /^[0-9a-f]{64}$/);
    }
    const mime = m.entries.find((e) => e.name === "mimetype");
    assert.equal(mime?.sha256, sha256Hex(new TextEncoder().encode("application/hwp+zip")));
    for (const e of m.entries.filter((x) => x.name.endsWith("/"))) {
      assert.equal(e.size, 0, "디렉터리 항목은 크기 0");
      assert.equal(e.sha256, sha256Hex(new Uint8Array(0)));
    }
  }
});

test("5.4 exportModel: 자원 트리는 속성·자식·텍스트를 모두 담는다", () => {
  const doc = load("hancom-field");
  const m = exportModel(doc);
  const charPr = m.header.resources["charPr"]?.[0];
  assert.ok(charPr !== undefined);
  assert.equal(charPr.tree.name, "hh:charPr");
  assert.deepEqual(Object.keys(charPr.tree.attrs), ["id", "height", "textColor", "shadeColor", "useFontSpace", "useKerning", "symMark", "borderFillIDRef"]);
  assert.deepEqual(charPr.tree.children.map((c) => c.name), ["hh:fontRef", "hh:ratio", "hh:spacing", "hh:relSz", "hh:offset", "hh:underline", "hh:strikeout", "hh:outline", "hh:shadow"]);
  assert.equal(charPr.tree.children[0]?.attrs["hangul"], "1");
  assert.equal(charPr.refs.length, 8);
  // 글꼴은 언어를 가진다
  assert.deepEqual([...new Set(m.header.resources["font"]?.map((f) => f.lang))], ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"]);
  // 텍스트 노드가 있는 자원: 합성 header의 memoPr 안 문자 데이터
  const withText = MINIMAL_HEADER.replace("</hh:refList>", "<hh:memoProperties itemCnt=\"1\"><hh:memoPr id=\"1\">글 &amp; 값</hh:memoPr></hh:memoProperties></hh:refList>");
  const mm = exportModel(parseSynthetic([""], withText));
  assert.equal(mm.header.resources["other:memoProperties"]?.[0]?.tree.text, "글 & 값");
  // 구역 쪽
  const p = m.sections[0]?.paragraphs[0];
  assert.deepEqual(p?.fields.map((f) => [f.kind, f.name, f.beginIDRef]), [["begin", "성명", undefined], ["end", undefined, "1208372794"]]);
  assert.equal(p?.logicalText.includes("홍길동"), true);
  assert.equal(m.header.secCnt, 1);
});

test("5.4 exportModel: 표·셀·하위 목록 위치를 색인으로 내보낸다", () => {
  const doc = load("D1");
  const m = exportModel(doc);
  const host = m.sections[0]?.paragraphs.find((p) => p.objects.some((o) => o.type === "tbl"));
  assert.ok(host !== undefined);
  const tbl = host.objects[0];
  assert.deepEqual([tbl?.table?.rowCnt, tbl?.table?.colCnt, tbl?.table?.cells.length], [8, 5, 40]);
  assert.deepEqual(tbl?.table?.cells.map((c) => c.subList), Array.from({ length: 40 }, (_, i) => i));
  assert.equal(host.subLists.length, 40);
  assert.equal(host.subLists[0]?.owner, "tc");
  assert.deepEqual(host.subLists[3]?.paragraphs[0]?.path, [...host.path, 3, 0]);
});

// ── 객체 → 하위 목록 대응 ─────────────────────────────────────────────────

/** 대응의 정의(독립 기준): 객체 요소의 원문 구간 안에 통째로 든 하위 목록이 그 객체의 것이다. */
function expectedSubLists(p: ParagraphNode, object: ParagraphNode["objects"][number]): ParagraphNode["subLists"] {
  return p.subLists.filter((s) => s.element.start >= object.element.start && s.element.end <= object.element.end);
}

test("5.2 객체의 subLists는 객체 구간 안에 든 하위 목록이다 (fixtures 전체의 모든 문단·객체)", () => {
  let objects = 0;
  let withSubLists = 0;
  for (const name of [...FIXTURE_NAMES, "hancom/blocks", "hancom/header-footer", "hancom/picture", "extra/features-picture"]) {
    for (const p of allParagraphs(load(name))) {
      for (const o of p.objects) {
        const expected = expectedSubLists(p, o);
        assert.equal(o.subLists.length, expected.length, `${name} ${p.path.join(".")}`);
        o.subLists.forEach((s, i) => assert.equal(s, expected[i], `${name} ${p.path.join(".")} ${i}번째`));
        objects++;
        if (o.subLists.length > 0) withSubLists++;
      }
    }
  }
  assert.ok(objects >= 50 && withSubLists >= 10, `fixtures에 객체 ${objects}개, 하위 목록을 가진 객체 ${withSubLists}개`);
});

test("5.2 객체의 subLists: 하위 목록이 없는 객체, 객체 밖 하위 목록, run 바로 아래의 하위 목록", () => {
  const sl = (t: string) =>
    `<hp:subList><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p></hp:subList>`;
  const body =
    `<hp:p paraPrIDRef="0" styleIDRef="0">` +
    `<hp:run charPrIDRef="0"><hp:ctrl/><hp:ctrl>${sl("a")}${sl("b")}</hp:ctrl><hp:t>x</hp:t><hp:ctrl><hp:foo>${sl("c")}</hp:foo></hp:ctrl></hp:run>` +
    `<hp:run charPrIDRef="0">${sl("d")}<hp:ctrl/></hp:run>` +
    `<hp:extra>${sl("loose")}</hp:extra>` +
    `</hp:p>`;
  const p = parseSynthetic([body]).sections[0]?.paragraphs[0];
  assert.ok(p !== undefined);
  const texts = (subLists: ParagraphNode["subLists"]): string[] => subLists.map((s) => s.paragraphs[0]?.logicalText ?? "");
  assert.deepEqual(texts(p.subLists), ["a", "b", "c", "d", "loose"]);
  assert.equal(p.objects.length, 5); // ctrl, ctrl, ctrl, subList(d), ctrl
  assert.deepEqual(p.objects.map((o) => texts(o.subLists)), [[], ["a", "b"], ["c"], ["d"], []]);
  p.objects.forEach((o) => assert.deepEqual(o.subLists, expectedSubLists(p, o)));
});

// ── 문단 해석의 시간: 한 문단 안의 하위 목록 수에 선형이다 ──────────────────

/** 한 문단에 `<hp:ctrl><hp:subList><hp:p/></hp:subList></hp:ctrl>`가 n개 든 합성 문서의 패키지. */
function manySubListsPackage(n: number): ReturnType<typeof openPackage> {
  const ctrl = "<hp:ctrl><hp:subList><hp:p/></hp:subList></hp:ctrl>";
  const body = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${ctrl.repeat(n)}</hp:run></hp:p>`;
  return openPackage(buildHwpx([body]));
}

/** parseDocument 소요 시간(ms)의 최솟값. 실행 잡음(GC 등)을 줄이려고 여러 번 잰 값 가운데 가장 작은 것을 쓴다. */
function bestParseMs(pkg: ReturnType<typeof openPackage>, runs: number): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    parseDocument(pkg);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

test("5.2 한 문단에 하위 목록이 2만 개여도 해석이 제한 시간 안에 끝나고 모델이 맞다", () => {
  const n = 20_000;
  const pkg = manySubListsPackage(n);
  const t0 = performance.now();
  const doc = parseDocument(pkg);
  const ms = performance.now() - t0;
  const p = doc.sections[0]?.paragraphs[0];
  assert.ok(p !== undefined);
  assert.equal(p.objects.length, n);
  assert.equal(p.subLists.length, n);
  // 객체 i의 하위 목록은 i번째 하위 목록 하나뿐이다
  for (const i of [0, 1, 777, n - 2, n - 1]) {
    assert.equal(p.objects[i]?.subLists.length, 1, `객체 ${i}`);
    assert.equal(p.objects[i]?.subLists[0], p.subLists[i], `객체 ${i}`);
  }
  assert.ok(p.objects.every((o) => o.subLists.length === 1));
  assert.ok(ms < 1500, `parseDocument(하위 목록 ${n}개)가 ${ms.toFixed(0)}ms 걸렸다(기준 1500ms)`);
});

test("5.2 한 문단의 하위 목록 수를 2배로 늘려도 해석 시간은 3배를 넘지 않는다 (선형)", () => {
  const small = manySubListsPackage(20_000);
  const large = manySubListsPackage(40_000);
  parseDocument(small); // 예열
  const tSmall = bestParseMs(small, 3);
  const tLarge = bestParseMs(large, 3);
  assert.ok(tLarge < 3 * tSmall, `2만 개 ${tSmall.toFixed(0)}ms → 4만 개 ${tLarge.toFixed(0)}ms (${(tLarge / tSmall).toFixed(1)}배)`);
});
