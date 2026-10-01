import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  collectBodyRefs,
  extractFragment,
  fingerprintResource,
  makeLookup,
  openPackage,
  parseDocument,
  parseFragment,
  readEntry,
  selectTable,
  serializeFragment,
  type Fragment,
  type HwpxDocument,
  type ResourceItem,
} from "../src/index.ts";
import {
  NS_HC,
  NS_HH,
  buildZip,
  formatRefsIn,
  hpTexts,
  hpfXml,
  loadDoc,
  parseSynthetic,
  readFixture,
  sectionXml,
  sha256Hex,
  utf8,
} from "./helpers.ts";

const throwsCode = (fn: () => unknown, code: string, label = ""): void =>
  assert.throws(fn, (e: unknown) => e instanceof HwpxError && e.code === code, `${label} ${code}가 나와야 한다`);

const sel = (sectionIndex: number, from: number, to: number, parentPath: number[] = []) => ({ sectionIndex, parentPath, from, to });
const sliceOf = (doc: HwpxDocument, from: number, to: number): string => {
  const ps = doc.sections[0]?.paragraphs ?? [];
  return (doc.sections[0]?.text ?? "").slice(ps[from]?.element.start, ps[to]?.element.end);
};
const OBJ = "￼";

// ── 7.2 조각 선택 ───────────────────────────────────────────────────────

test("7.2 selectTable: 구역 최상위 문단에서 n번째 표를 담은 문단 하나를 고른다", () => {
  const d1 = loadDoc("D1");
  // D1의 최상위 표는 문단 9와 11에 있다(문단 8·10은 표 제목)
  assert.deepEqual(selectTable(d1, 0, 0), { selection: sel(0, 9, 9), issues: [] });
  assert.deepEqual(selectTable(d1, 0, 1), { selection: sel(0, 11, 11), issues: [] });
  throwsCode(() => selectTable(d1, 0, 2), "FRAG_SELECTION", "표 서수가 범위 밖");
  throwsCode(() => selectTable(d1, 3, 0), "FRAG_SELECTION", "구역이 없다");
  // D5는 첫 문단에 구역 설정·표 4개의 자리가 있고, 문단 7의 표 id가 1001이다
  const d5 = loadDoc("D5");
  assert.equal(selectTable(d5, 0, 4).selection.from, 7);
  assert.ok(sliceOf(d5, 7, 7).includes('<hp:tbl id="1001"'));
});

test("7.2 selectTable: 그 문단에 표 말고 글이 있으면 경고를 붙인다", () => {
  const merged = loadDoc("hancom-merged");
  // 한컴 합성본의 문단 12는 글 뒤에 표가 있다(글 "마지막 문단입니다…")
  const r = selectTable(merged, 0, 2);
  assert.equal(r.selection.from, 12);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0]?.severity, "warning");
  assert.equal(r.issues[0]?.code, "FRAG_TABLE_PARAGRAPH_TEXT");
  // 표만 있는 문단은 경고가 없다
  assert.deepEqual(selectTable(merged, 0, 0).issues, []);
});

test("7.2 선택이 올바르지 않으면 FRAG_SELECTION이다", () => {
  const d1 = loadDoc("D1");
  const bad: [string, ReturnType<typeof sel>][] = [
    ["from > to", sel(0, 5, 4)],
    ["to가 범위 밖", sel(0, 0, 13)],
    ["음수", sel(0, -1, 2)],
    ["구역 없음", sel(1, 0, 0)],
    ["상위 주소가 홀수 길이", sel(0, 0, 0, [9])],
    ["없는 하위 목록", sel(0, 0, 0, [9, 99])],
    ["문단에 하위 목록이 없다", sel(0, 0, 0, [1, 0])],
    ["하위 목록 안에서 범위 밖", sel(0, 0, 99, [9, 0])],
  ];
  for (const [label, s] of bad) throwsCode(() => extractFragment(d1, s), "FRAG_SELECTION", label);
});

test("7.2 F10 secPr가 든 문단을 선택하면 FRAG_SECTION_PROPS (범위 안에 있어도, 표와 함께 있어도)", () => {
  const cases: [string, HwpxDocument, ReturnType<typeof sel>][] = [
    ["D1 첫 문단", loadDoc("D1"), sel(0, 0, 0)],
    ["D1 범위 안", loadDoc("D1"), sel(0, 0, 3)],
    ["D5 secPr와 표가 한 문단", loadDoc("D5"), sel(0, 0, 0)],
    ["한컴 합성본", loadDoc("hancom-merged"), sel(0, 0, 1)],
    ["한컴 누름틀 문서", loadDoc("hancom/field-states"), sel(0, 0, 2)],
  ];
  for (const [label, doc, s] of cases) {
    assert.throws(
      () => extractFragment(doc, s),
      (e: unknown) => e instanceof HwpxError && e.code === "FRAG_SECTION_PROPS" && e.where === "Contents/section0.xml",
      label,
    );
  }
  // secPr가 없는 범위는 뽑힌다
  assert.doesNotThrow(() => extractFragment(loadDoc("D1"), sel(0, 1, 12)));
});

// ── 7.2 누름틀을 자르는 선택 ────────────────────────────────────────────

const fieldBegin = (id: string, name = "n"): string =>
  `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="1"/></hp:ctrl>`;
const fieldEnd = (id: string): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
const fpara = (inner: string, text = "x"): string => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}<hp:t>${text}</hp:t></hp:run></hp:p>`;

test("7.2 FRAG_SPLITS_FIELD: 선택 범위가 누름틀의 시작과 끝 사이를 자르면 거절한다(시작만, 끝만 든 경우 모두)", () => {
  // 문단 0: 시작, 문단 1: 가운데, 문단 2: 끝 (여러 문단에 걸친 누름틀), 문단 3: 한 문단 안에서 닫히는 누름틀, 문단 4: 일반
  const doc = parseSynthetic([fpara(fieldBegin("9")) + fpara("", "가운데") + fpara(fieldEnd("9")) + fpara(fieldBegin("5") + "<hp:t>값</hp:t>" + fieldEnd("5")) + fpara("", "끝")]);
  for (const [label, from, to] of [
    ["시작만(0~1)", 0, 1],
    ["시작만(0~0)", 0, 0],
    ["끝만(1~2)", 1, 2],
    ["끝만(2~3)", 2, 3],
  ] as const) {
    assert.throws(
      () => extractFragment(doc, sel(0, from, to)),
      (e: unknown) => e instanceof HwpxError && e.code === "FRAG_SPLITS_FIELD" && e.where === "Contents/section0.xml",
      label,
    );
  }
  // 시작과 끝이 모두 든 범위, 짝이 범위 안에서 닫히는 누름틀, 누름틀이 없는 범위는 뽑힌다
  for (const [label, from, to] of [
    ["시작~끝 전체(0~2)", 0, 2],
    ["전체", 0, 4],
    ["한 문단 안에서 닫힘(3~3)", 3, 3],
    ["가운데만(1~1)", 1, 1],
    ["일반 문단(4~4)", 4, 4],
  ] as const) {
    const f = extractFragment(doc, sel(0, from, to));
    assert.equal(f.census.paragraphs, to - from + 1, label);
  }
});

test("7.2 FRAG_SPLITS_FIELD: 표 셀 안 문단을 고를 때도 같고, 같은 id가 겹쳐 열린 누름틀은 안쪽부터 닫히는 짝으로 본다", () => {
  const cell = (inner: string): string =>
    `<hp:tbl id="1" rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList>${inner}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`;
  const doc = parseSynthetic([fpara(cell(fpara(fieldBegin("9")) + fpara("", "중간") + fpara(fieldEnd("9")))) ]);
  const inCell = (from: number, to: number) => sel(0, from, to, [0, 0]);
  assert.throws(() => extractFragment(doc, inCell(0, 1)), (e: unknown) => e instanceof HwpxError && e.code === "FRAG_SPLITS_FIELD");
  assert.throws(() => extractFragment(doc, inCell(1, 2)), (e: unknown) => e instanceof HwpxError && e.code === "FRAG_SPLITS_FIELD");
  assert.equal(extractFragment(doc, inCell(0, 2)).census.paragraphs, 3);
  // 표를 담은 바깥 문단 전체는 누름틀이 안에서 닫히므로 뽑힌다
  assert.equal(extractFragment(doc, sel(0, 0, 0)).census.fields, 1);

  // 같은 id 9가 겹쳐 열려도(문서에 이미 있는 중복) 범위 안에서 모두 닫히면 뽑히고, 하나라도 닫히지 않으면 거절한다
  const nested = parseSynthetic([fpara(fieldBegin("9", "a") + fieldBegin("9", "b") + fieldEnd("9") + fieldEnd("9"))]);
  assert.equal(extractFragment(nested, sel(0, 0, 0)).census.fields, 2);
  const open = parseSynthetic([fpara(fieldBegin("9", "a") + fieldBegin("9", "b") + fieldEnd("9"))]);
  throwsCode(() => extractFragment(open, sel(0, 0, 0)), "FRAG_SPLITS_FIELD");
});

// ── 7.3 조각 자료 ───────────────────────────────────────────────────────

test("7.3 D5 표 조각: 원문 그대로, 참조·접두사·수량이 독립 기준과 같다", () => {
  const d5 = loadDoc("D5");
  const f = extractFragment(d5, selectTable(d5, 0, 4).selection);
  const source = sliceOf(d5, 7, 7);
  assert.equal(f.schema, "hwpx-studio/fragment@1");
  assert.equal(f.xml, source);
  assert.equal(f.source.sha256, sha256Hex(readFixture("D5")));
  assert.deepEqual(f.source.selection, sel(0, 7, 7));
  assert.deepEqual(f.prefixes, { hp: "paragraph" });
  // 글: 논리 텍스트에서 개체 문자를 빼고 이은 것이 hp:t 정규식 추출과 같다
  assert.equal(f.texts.join("").replaceAll(OBJ, "").replace(/[\t\n]/g, ""), hpTexts(source).join("").replace(/[\t\n]/g, ""));
  assert.equal(f.texts.length, f.census.paragraphs);
  assert.equal(f.census.tables, [...source.matchAll(/<hp:tbl[\s>]/g)].length);
  assert.deepEqual([f.census.pictures, f.census.fields, f.census.bookmarks], [0, 0, 0]);
  assert.equal(f.census.paragraphs, [...source.matchAll(/<hp:p[\s>]/g)].length);
  // 본문 참조: 정규식으로 센 서식 참조와 종류·id·순서가 같다. 구간은 속성값 자리다
  assert.deepEqual(f.refs.map((r) => ({ kind: r.kind, id: r.id })), formatRefsIn(source));
  for (const r of f.refs) assert.equal(f.xml.slice(r.start, r.end), r.id);
  assert.equal(f.prints.length, f.refs.length);
  // 객체 id
  assert.deepEqual(
    f.instanceIds.filter((x) => x.role === "object").map((x) => x.value),
    [...source.matchAll(/<hp:tbl\b[^>]*?\sid="(\d+)"/g)].map((m) => m[1]),
  );
  for (const x of f.instanceIds) assert.equal(f.xml.slice(x.start, x.end), x.value);
  assert.deepEqual(f.issues, []);
});

test("7.3 의존 닫힘: 본문이 가리키는 자원과 그 자원이 가리키는 자원이 모두 있고, 참조되는 것이 먼저다", () => {
  const d5 = loadDoc("D5");
  const f = extractFragment(d5, selectTable(d5, 0, 4).selection);
  const key = (r: { kind: string; lang?: string; id: string }) => `${r.kind}/${r.lang ?? ""}/${r.id}`;
  const pos = new Map(f.resources.map((r, i) => [key(r), i]));
  assert.equal(pos.size, f.resources.length, "자원이 중복되지 않는다");
  for (const r of f.refs) assert.ok(pos.has(key(r)), `본문 참조 ${key(r)}`);
  for (const [i, res] of f.resources.entries()) {
    assert.equal(res.xml.slice(res.idSpan.start, res.idSpan.end), res.id);
    for (const r of res.refs) {
      assert.equal(res.xml.slice(r.start, r.end), r.id);
      const at = pos.get(key(r));
      assert.ok(at !== undefined, `자원 ${key(res)}의 참조 ${key(r)}`);
      // 자기 자신(스타일의 nextStyleIDRef 등)을 뺀 참조는 앞에 와야 한다(순환이 없는 D5에서)
      if (at !== i) assert.ok(at < i, `${key(r)}이(가) ${key(res)}보다 앞에 와야 한다`);
    }
  }
  // 닫힘: 독립 계산 — 자원 원문에서 *IDRef 속성만 보고 종류별 대상을 따라간다
  const need = new Set(f.refs.map((r) => `${r.kind}/${r.id}`));
  const headerText = d5.header.text;
  const bodyOf = (kind: string, id: string): string => {
    const tag = kind === "charPr" ? "charPr" : kind;
    const m = new RegExp(`<hh:${tag} id="${id}"[\\s\\S]*?</hh:${tag}>|<hh:${tag} id="${id}"[^>]*/>`).exec(headerText);
    return m?.[0] ?? "";
  };
  for (const r of f.refs) {
    if (r.kind === "charPr") {
      for (const m of bodyOf("charPr", r.id).matchAll(/borderFillIDRef="(\d+)"/g)) need.add(`borderFill/${m[1]}`);
    }
    if (r.kind === "style") {
      for (const m of bodyOf("style", r.id).matchAll(/(paraPrIDRef|charPrIDRef|nextStyleIDRef)="(\d+)"/g)) {
        need.add(`${m[1] === "paraPrIDRef" ? "paraPr" : m[1] === "charPrIDRef" ? "charPr" : "style"}/${m[2]}`);
      }
    }
  }
  const have = new Set(f.resources.filter((r) => r.kind !== "font").map((r) => `${r.kind}/${r.id}`));
  for (const n of need) assert.ok(have.has(n), `닫힘에서 ${n}이(가) 빠졌다`);
  // 글꼴: 조각의 charPr마다 7개 언어의 글꼴이 있다
  for (const res of f.resources.filter((r) => r.kind === "charPr")) {
    assert.equal(res.refs.filter((x) => x.kind === "font").length, 7);
  }
});

test("7.3 한컴 합성본 조각에는 줄 배치 캐시 구간이 문단마다 기록된다", () => {
  const merged = loadDoc("hancom-merged");
  const f = extractFragment(merged, sel(0, 1, 3));
  assert.equal(f.lineSegSpans.length, [...f.xml.matchAll(/<hp:linesegarray>/g)].length);
  assert.equal(f.lineSegSpans.length, 3);
  for (const s of f.lineSegSpans) {
    assert.ok(f.xml.slice(s.start, s.end).startsWith("<hp:linesegarray>"));
    assert.ok(f.xml.slice(s.start, s.end).endsWith("</hp:linesegarray>"));
  }
});

test("7.3 표 셀 안 문단도 선택할 수 있다 (parentPath = [문단, 하위목록])", () => {
  const d1 = loadDoc("D1");
  const cell = d1.sections[0]?.paragraphs[9]?.subLists[0]?.paragraphs;
  assert.ok(cell !== undefined && cell.length >= 1);
  const f = extractFragment(d1, sel(0, 0, 0, [9, 0]));
  assert.deepEqual(f.texts, [cell[0]?.logicalText]);
  assert.deepEqual(f.texts, hpTexts(f.xml));
  assert.ok(f.xml.startsWith("<hp:p ") && f.xml.endsWith("</hp:p>"));
  assert.deepEqual(f.source.selection.parentPath, [9, 0]);
});

test("7.3 없는 대상을 가리키는 참조는 FRAG_DANGLING_SOURCE 경고로 남기고 그 참조는 그대로 둔다", () => {
  const d1 = loadDoc("D1");
  // D1의 문단모양은 비어 있는 tabProperties의 tabPr 0을 가리킨다
  const f = extractFragment(d1, sel(0, 1, 1));
  const dangling = f.issues.filter((i) => i.code === "FRAG_DANGLING_SOURCE");
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0]?.severity, "warning");
  assert.ok(dangling[0]?.message.startsWith("tabPr 0이(가) 없는데"), dangling[0]?.message);
  assert.equal(dangling[0]?.where, "Contents/header.xml");
  assert.ok(!f.resources.some((r) => r.kind === "tabPr"));
  for (const r of f.resources.filter((x) => x.kind === "paraPr")) assert.ok(!r.refs.some((x) => x.kind === "tabPr"));
  // 본문의 없는 참조: 문단 하나의 참조를 끊어 만든 합성 문서
  const doc = parseSynthetic([
    '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="9"><hp:t>가</hp:t></hp:run></hp:p>',
  ]);
  const g = extractFragment(doc, sel(0, 0, 0));
  assert.deepEqual(g.refs.map((r) => r.kind).sort(), ["paraPr", "style"]);
  assert.ok(g.issues.some((i) => i.code === "FRAG_DANGLING_SOURCE" && i.message.startsWith("charPr 9이(가) 없는데 1곳")));
  assert.ok(g.prints.includes("missing:9"));
});

test("7.3 그림 조각: 이진 자료가 manifest에서 찾아져 내용과 함께 담긴다", () => {
  const pic = loadDoc("hancom/picture");
  const f = extractFragment(pic, sel(0, 1, 1));
  assert.equal(f.binaries.length, 1);
  const b = f.binaries[0];
  assert.ok(b !== undefined);
  assert.deepEqual([b.itemId, b.href, b.mediaType], ["image1", "BinData/image1.png", "image/png"]);
  const raw = readEntry(pic.pkg.archive, pic.pkg.bytes, "BinData/image1.png");
  assert.equal(b.sha256, sha256Hex(raw));
  assert.deepEqual([...Buffer.from(b.base64, "base64")], [...raw]);
  const binRefs = f.refs.filter((r) => r.kind === "binaryItem");
  assert.deepEqual(binRefs.map((r) => r.id), ["image1"]);
  assert.equal(f.census.pictures, 1);
  // 문단 id(한컴 자리값 0)는 paragraph 역할로, 그림의 id·instid는 객체·인스턴스 id로 문서 순서대로 기록된다
  assert.deepEqual(
    f.instanceIds.map((x) => [x.role, x.value]),
    [["paragraph", "0"], ["object", "1208941154"], ["inst", "135199331"]],
  );
  // 이진 자료가 없는 조각은 binaries가 비어 있다
  assert.deepEqual(extractFragment(pic, sel(0, 2, 2)).binaries, []);
});

test("7.3 문단 id: 조각 안 모든 문단(표 셀 안 포함)의 id가 paragraph 역할로 문서 순서대로 기록되고, id 속성이 없는 문단은 기록하지 않는다", () => {
  const merged = loadDoc("hancom-merged");
  const f = extractFragment(merged, sel(0, 9, 11)); // 표가 든 문단 둘과 그 사이: 셀 안 문단이 많다
  const expected = [...f.xml.matchAll(/<hp:p\b[^>]*?\sid="([^"]*)"/g)].map((m) => m[1]);
  const mine = f.instanceIds.filter((x) => x.role === "paragraph");
  assert.equal(expected.length, f.census.paragraphs, "hancom-merged의 문단은 모두 id가 있다");
  assert.deepEqual(mine.map((x) => x.value), expected);
  for (const x of mine) assert.equal(f.xml.slice(x.start, x.end), x.value);
  // id 속성이 없는 문단만 있는 조각(D1)에는 문단 id가 없다
  const d1 = extractFragment(loadDoc("D1"), sel(0, 1, 12));
  assert.deepEqual(d1.instanceIds.filter((x) => x.role === "paragraph"), []);
  // JSON으로 저장했다가 읽어도 같다(parseFragment가 paragraph 역할을 받아들인다)
  assert.deepEqual(parseFragment(serializeFragment(f)).instanceIds, f.instanceIds);
});

test("7.3 누름틀·책갈피 조각: 시작 id, 끝의 beginIDRef, 책갈피 이름의 구간", () => {
  const fs = loadDoc("hancom/field-states");
  const f = extractFragment(fs, sel(0, 1, 2));
  const begins = f.instanceIds.filter((x) => x.role === "fieldBegin").map((x) => x.value);
  const ends = f.instanceIds.filter((x) => x.role === "fieldEndRef").map((x) => x.value);
  assert.deepEqual(begins, ["1208941123", "1208941124"]);
  assert.deepEqual(ends, begins);
  assert.equal(f.census.fields, 2);
  const fp = loadDoc("extra/features-picture");
  const g = extractFragment(fp, sel(0, 15, 15));
  assert.deepEqual(g.bookmarks.map((b) => b.name), ["bm_test"]);
  assert.equal(g.xml.slice(g.bookmarks[0]?.start, g.bookmarks[0]?.end), "bm_test");
});

// ── 7.4 자원 지문 ───────────────────────────────────────────────────────

const hdr = (lists: string, secCnt = 1): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>` +
  `<hh:head xmlns:hh="${NS_HH}" xmlns:hc="${NS_HC}" version="1.5" secCnt="${secCnt}"><hh:refList>${lists}</hh:refList></hh:head>`;
const fonts = (...entries: [string, string][]): string =>
  `<hh:fontfaces itemCnt="1"><hh:fontface lang="HANGUL" fontCnt="${entries.length}">` +
  entries.map(([id, face]) => `<hh:font id="${id}" face="${face}" type="TTF" isEmbedded="0"/>`).join("") +
  `</hh:fontface></hh:fontfaces>`;
const borderFill = (id: string, extra = ""): string =>
  `<hh:borderFills itemCnt="1"><hh:borderFill id="${id}" threeD="0" shadow="0" ${extra}/></hh:borderFills>`;
const charPr = (id: string, fontId: string, bf: string, extra = ""): string =>
  `<hh:charPr id="${id}" height="1000" ${extra} borderFillIDRef="${bf}"><hh:fontRef hangul="${fontId}"/></hh:charPr>`;

function items(doc: HwpxDocument, kind: string, id: string, lang?: string): ResourceItem {
  const item = (doc.header.resources[kind] ?? []).find((i) => i.id === id && (lang === undefined || i.lang === lang));
  assert.ok(item !== undefined, `${kind} ${id}`);
  return item;
}
const fp = (doc: HwpxDocument, kind: string, id: string, lang?: string): string =>
  fingerprintResource(items(doc, kind, id, lang), makeLookup(doc));
const synth = (header: string): HwpxDocument => parseSynthetic([""], header);

test("7.4 같은 모양의 자원은 id·속성 순서·공백·접두사가 달라도 같은 지문이다", () => {
  const a = synth(hdr(fonts(["0", "바탕"]) + borderFill("1") + `<hh:charProperties itemCnt="1">${charPr("0", "0", "1")}</hh:charProperties>`));
  const b = synth(
    hdr(
      // id 다름, 속성 순서 다름, 줄바꿈·들여쓰기 다름, 같은 글꼴을 다른 id로
      fonts(["5", "바탕"]) +
        borderFill("8") +
        `<hh:charProperties itemCnt="1">\n  <hh:charPr borderFillIDRef="8"   height="1000" id="3">\n    <hh:fontRef hangul="5"/>\n  </hh:charPr>\n</hh:charProperties>`,
    ),
  );
  assert.equal(fp(a, "charPr", "0"), fp(b, "charPr", "3"));
  assert.match(fp(a, "charPr", "0"), /^[0-9a-f]{64}$/);
  // 접두사만 다른 header
  const prefixed = synth(
    hdr(fonts(["0", "바탕"]) + borderFill("1") + `<hh:charProperties itemCnt="1">${charPr("0", "0", "1")}</hh:charProperties>`)
      .replaceAll("hh:", "q:")
      .replace(`xmlns:hh=`, `xmlns:q=`),
  );
  assert.equal(fp(prefixed, "charPr", "0"), fp(a, "charPr", "0"));
});

test("7.4 모양이 다르면 지문이 다르다: 속성값, 가리키는 자원의 내용, 글꼴 이름·언어", () => {
  const base = (bfExtra: string, face: string, charExtra = ""): HwpxDocument =>
    synth(hdr(fonts(["0", face]) + borderFill("1", bfExtra) + `<hh:charProperties itemCnt="1">${charPr("0", "0", "1", charExtra)}</hh:charProperties>`));
  const ref = fp(base("", "바탕"), "charPr", "0");
  assert.notEqual(fp(base("", "바탕", 'bold="1"'), "charPr", "0"), ref, "자기 속성");
  assert.notEqual(fp(base('centerLine="NONE"', "바탕"), "charPr", "0"), ref, "가리키는 borderFill의 내용");
  assert.notEqual(fp(base("", "돋움"), "charPr", "0"), ref, "가리키는 글꼴의 이름");
  // 글꼴의 언어
  const latin = synth(
    hdr(
      `<hh:fontfaces itemCnt="1"><hh:fontface lang="LATIN" fontCnt="1"><hh:font id="0" face="바탕" type="TTF" isEmbedded="0"/></hh:fontface></hh:fontfaces>` +
        borderFill("1") +
        `<hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000" borderFillIDRef="1"><hh:fontRef latin="0"/></hh:charPr></hh:charProperties>`,
    ),
  );
  assert.notEqual(fp(latin, "charPr", "0"), fp(base("", "바탕", ""), "charPr", "0"));
  // 글꼴 자체의 지문: id는 빼고 언어와 내용으로 만든다
  const f1 = synth(hdr(fonts(["0", "바탕"])));
  const f2 = synth(hdr(fonts(["9", "바탕"])));
  assert.equal(fp(f1, "font", "0", "HANGUL"), fp(f2, "font", "9", "HANGUL"));
  assert.notEqual(fp(f1, "font", "0", "HANGUL"), fp(synth(hdr(fonts(["0", "돋움"]))), "font", "0", "HANGUL"));
  assert.notEqual(fp(f1, "font", "0", "HANGUL"), fp(latin, "font", "0", "LATIN"));
});

test("7.4 대상이 없는 참조는 missing:<id>로 취급한다 (id가 다르면 지문이 다르고, 있는 대상과도 다르다)", () => {
  const withBf = (bf: string, present: boolean): HwpxDocument =>
    synth(hdr(fonts(["0", "바탕"]) + (present ? borderFill("1") : "") + `<hh:charProperties itemCnt="1">${charPr("0", "0", bf)}</hh:charProperties>`));
  const missing9 = fp(withBf("9", false), "charPr", "0");
  assert.equal(fp(withBf("9", false), "charPr", "0"), missing9, "같은 누락은 같다");
  assert.notEqual(fp(withBf("8", false), "charPr", "0"), missing9);
  assert.notEqual(fp(withBf("1", true), "charPr", "0"), missing9);
  // 참조 없음 관례값(4294967295)은 참조가 아니라 값 그대로다
  assert.equal(fp(withBf("4294967295", false), "charPr", "0"), fp(withBf("4294967295", true), "charPr", "0"));
});

test("7.4 스타일의 자기 참조·순환 참조에서 끝나고 id에 의존하지 않는다", () => {
  const styles = (rows: string): string =>
    fonts(["0", "바탕"]) +
    borderFill("1") +
    `<hh:charProperties itemCnt="1">${charPr("0", "0", "1")}</hh:charProperties>` +
    `<hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:heading type="NONE" idRef="0" level="0"/></hh:paraPr></hh:paraProperties>` +
    `<hh:styles itemCnt="2">${rows}</hh:styles>`;
  const style = (id: string, next: string, name = "바탕글"): string =>
    `<hh:style id="${id}" type="PARA" name="${name}" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="${next}"/>`;
  // 자기 참조: id와 자기 id가 달라도 같다
  const a = synth(hdr(styles(style("0", "0"))));
  const b = synth(hdr(styles(style("7", "7"))));
  assert.equal(fp(a, "style", "0"), fp(b, "style", "7"));
  // 두 스타일이 서로를 가리킨다(0→1→0). id를 바꿔도 같고, 계산은 끝난다
  const c = synth(hdr(styles(style("0", "1", "가") + style("1", "0", "나"))));
  const d = synth(hdr(styles(style("10", "11", "가") + style("11", "10", "나"))));
  assert.equal(fp(c, "style", "0"), fp(d, "style", "10"));
  assert.equal(fp(c, "style", "1"), fp(d, "style", "11"));
  assert.notEqual(fp(c, "style", "0"), fp(c, "style", "1"), "이름이 다른 스타일은 다르다");
  // 순환 안에서 먼저 계산한 결과가 나중 결과를 오염시키지 않는다(계산 순서와 무관)
  const lookup = makeLookup(c);
  const first = fingerprintResource(items(c, "style", "1"), lookup);
  const second = fingerprintResource(items(c, "style", "0"), lookup);
  assert.equal(first, fp(c, "style", "1"));
  assert.equal(second, fp(c, "style", "0"));
});

test("7.4 스타일 이름 충돌로 붙인 ' (n)' 접미사는 지문에서 뗀다", () => {
  const doc = (name: string): HwpxDocument =>
    synth(
      hdr(
        fonts(["0", "바탕"]) +
          borderFill("1") +
          `<hh:charProperties itemCnt="1">${charPr("0", "0", "1")}</hh:charProperties>` +
          `<hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:heading type="NONE" idRef="0" level="0"/></hh:paraPr></hh:paraProperties>` +
          `<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="${name}" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"/></hh:styles>`,
      ),
    );
  assert.equal(fp(doc("바탕글 (2)"), "style", "0"), fp(doc("바탕글"), "style", "0"));
  assert.equal(fp(doc("바탕글 (12)"), "style", "0"), fp(doc("바탕글"), "style", "0"));
  assert.notEqual(fp(doc("바탕글 (x)"), "style", "0"), fp(doc("바탕글"), "style", "0"));
  assert.notEqual(fp(doc("개요"), "style", "0"), fp(doc("바탕글"), "style", "0"));
});

test("7.4 글자 데이터는 앞뒤 공백을 떼고 비교한다 (번호 모양 문자열)", () => {
  const num = (text: string, attr = "1"): HwpxDocument =>
    synth(hdr(`<hh:numberings itemCnt="1"><hh:numbering id="1" start="0"><hh:paraHead start="${attr}" level="1">${text}</hh:paraHead></hh:numbering></hh:numberings>`));
  assert.equal(fp(num("^1."), "numbering", "1"), fp(num("\n   ^1.  \n"), "numbering", "1"));
  assert.notEqual(fp(num("^1."), "numbering", "1"), fp(num("^2."), "numbering", "1"));
  assert.notEqual(fp(num("^1."), "numbering", "1"), fp(num("^1.", "2"), "numbering", "1"));
});

function withBinaries(header: string, bins: { id: string; href: string; bytes: number[] }[], body = ""): HwpxDocument {
  const hpf = hpfXml([0]).replace(
    "</opf:manifest>",
    bins.map((b) => `<opf:item id="${b.id}" href="${b.href}" media-type="image/png"/>`).join("") + "</opf:manifest>",
  );
  const base = buildZip([
    { name: "mimetype", data: utf8("application/hwp+zip") },
    {
      name: "META-INF/container.xml",
      data: utf8(
        `<?xml version="1.0"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`,
      ),
    },
    { name: "Contents/content.hpf", data: utf8(hpf) },
    { name: "Contents/header.xml", data: utf8(header) },
    { name: "Contents/section0.xml", data: utf8(sectionXml(body)) },
    ...bins.map((b) => ({ name: b.href, data: new Uint8Array(b.bytes) })),
  ]);
  return parseDocument(openPackage(base));
}

test("7.4 자원이 이진 자료를 가리키면(이미지 채우기) 지문에 id 대신 내용 해시가 들어간다", () => {
  const withImg = (binId: string): string =>
    hdr(fonts(["0", "바탕"]) + `<hh:borderFills itemCnt="1"><hh:borderFill id="1"><hc:fillBrush><hc:imgBrush mode="TILE"><hc:img binaryItemIDRef="${binId}" bright="0"/></hc:imgBrush></hc:fillBrush></hh:borderFill></hh:borderFills>`);
  const a = withBinaries(withImg("x1"), [{ id: "x1", href: "BinData/x1.png", bytes: [1, 2, 3] }]);
  const b = withBinaries(withImg("zz"), [{ id: "zz", href: "BinData/other.png", bytes: [1, 2, 3] }]);
  const c = withBinaries(withImg("x1"), [{ id: "x1", href: "BinData/x1.png", bytes: [9, 9, 9] }]);
  const d = withBinaries(withImg("x1"), []);
  assert.equal(fp(a, "borderFill", "1"), fp(b, "borderFill", "1"), "내용이 같으면 id·이름이 달라도 같다");
  assert.notEqual(fp(a, "borderFill", "1"), fp(c, "borderFill", "1"), "내용이 다르면 다르다");
  assert.notEqual(fp(a, "borderFill", "1"), fp(d, "borderFill", "1"), "항목이 없으면 missing");
  // 조각은 이 의존도 이진 자료로 담는다
  const withBody = withBinaries(
    withImg("x1"),
    [{ id: "x1", href: "BinData/x1.png", bytes: [1, 2, 3] }],
    '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tc borderFillIDRef="1"/></hp:run></hp:p>',
  );
  const f = extractFragment(withBody, sel(0, 0, 0));
  assert.deepEqual(f.binaries.map((x) => x.itemId), ["x1"]);
  const bf = f.resources.find((r) => r.kind === "borderFill");
  assert.deepEqual(bf?.refs.map((r) => [r.kind, r.id]), [["binaryItem", "x1"]]);
});

test("7.4 같은 모양의 자원은 문서가 달라도 같은 지문이다 (D1·D5·한컴 문서의 글꼴과 테두리)", () => {
  const d1 = loadDoc("D1");
  const d5 = loadDoc("D5");
  // D1과 D5의 글꼴 0은 같은 모양이다
  for (const lang of ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"]) {
    assert.equal(fp(d1, "font", "0", lang), fp(d5, "font", "0", lang), lang);
  }
  // 한 문서 안에서도 내용이 같은 두 자원(D1의 charPr 0과 9)은 같다
  assert.equal(fp(d1, "charPr", "0"), fp(d1, "charPr", "9"));
  assert.notEqual(fp(d1, "charPr", "0"), fp(d1, "charPr", "1"), "굵게 다름");
  assert.notEqual(fp(d1, "borderFill", "1"), fp(d1, "borderFill", "2"));
  // 같은 자원의 지문은 호출마다 같다
  assert.equal(fp(d5, "paraPr", "11"), fp(d5, "paraPr", "11"));
});

// ── 7.3 prints ──────────────────────────────────────────────────────────

test("7.3 prints는 본문 참조가 가리키는 자원의 지문이다 (문서 순서)", () => {
  const d5 = loadDoc("D5");
  const f = extractFragment(d5, sel(0, 4, 6));
  const lookup = makeLookup(d5);
  const expected: string[] = [];
  for (const p of d5.sections[0]?.paragraphs.slice(4, 7) ?? []) {
    for (const r of collectBodyRefs(p.element)) {
      const item = (d5.header.resources[r.kind] ?? []).find((i) => i.id === r.id);
      assert.ok(item !== undefined);
      expected.push(fingerprintResource(item, lookup));
    }
  }
  assert.deepEqual(f.prints, expected);
  assert.equal(f.prints.length, formatRefsIn(f.xml).length);
});

// ── 직렬화(F12 앞단) ────────────────────────────────────────────────────

test("7.3 조각은 JSON으로 저장했다가 읽으면 같다", () => {
  const fixtures: [string, number, number, number[]?][] = [
    ["D5", 7, 7],
    ["D1", 1, 12],
    ["hancom/picture", 1, 1],
    ["hancom/field-states", 1, 2],
    ["extra/features-picture", 13, 17],
  ];
  for (const [name, from, to, parent] of fixtures) {
    const f = extractFragment(loadDoc(name), sel(0, from, to, parent));
    const text = serializeFragment(f);
    assert.deepEqual(parseFragment(text), f, name);
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(f)));
    assert.equal(serializeFragment(parseFragment(text)), text, "다시 저장해도 같은 문자열");
  }
});

test("7.3 parseFragment는 형식이 틀린 JSON을 FRAG_SCHEMA로 거절한다", () => {
  const good = extractFragment(loadDoc("hancom/picture"), sel(0, 1, 1));
  const mutate = (change: (o: Record<string, unknown>) => void): string => {
    const copy = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    change(copy);
    return JSON.stringify(copy);
  };
  const first = <T>(o: unknown, key: string): T => (o as Record<string, T[]>)[key]?.[0] as T;
  const cases: [string, string][] = [
    ["JSON이 아님", "{not json"],
    ["객체가 아님", "[]"],
    ["schema 다름", mutate((o) => (o["schema"] = "hwpx-studio/fragment@2"))],
    ["xml이 문자열이 아님", mutate((o) => (o["xml"] = 5))],
    ["refs가 배열이 아님", mutate((o) => (o["refs"] = {}))],
    ["필드 누락", mutate((o) => delete o["census"])],
    ["role을 모름", mutate((o) => ((first<Record<string, unknown>>(o, "instanceIds"))["role"] = "weird"))],
    ["구간이 원문 밖", mutate((o) => ((first<Record<string, unknown>>(o, "refs"))["end"] = 99999999))],
    ["구간의 값이 id와 다름", mutate((o) => ((first<Record<string, unknown>>(o, "refs"))["id"] = "다른것"))],
    ["참조가 조각에 없는 자원을 가리킴", mutate((o) => ((o["resources"] as unknown[]).length = 0))],
    ["이진 참조의 이진 자료가 없음", mutate((o) => (o["binaries"] = []))],
    ["음수 구간", mutate((o) => ((first<Record<string, unknown>>(o, "lineSegSpans"))["start"] = -1))],
    ["issues의 severity", mutate((o) => (o["issues"] = [{ severity: "info", code: "X", message: "m" }]))],
  ];
  for (const [label, text] of cases) throwsCode(() => parseFragment(text), "FRAG_SCHEMA", label);
  // 좋은 조각은 읽힌다
  const frag: Fragment = parseFragment(JSON.stringify(good));
  assert.deepEqual(frag, good);
});

// ── 조각 추출이 원본을 바꾸지 않는다 ────────────────────────────────────

test("7.3 추출은 문서 모델과 원본 바이트를 바꾸지 않는다", () => {
  const bytes = readFixture("D5");
  const before = sha256Hex(bytes);
  const doc = parseDocument(openPackage(bytes));
  const textBefore = doc.sections[0]?.text;
  const f1 = extractFragment(doc, sel(0, 4, 6));
  const f2 = extractFragment(doc, sel(0, 4, 6));
  assert.deepEqual(f1, f2, "같은 입력이면 같은 조각");
  assert.equal(sha256Hex(bytes), before);
  assert.equal(doc.sections[0]?.text, textBefore);
});
