// M1-A: 값의 줄바꿈·탭. 값의 `\n`은 줄바꿈 요소, 탭은 탭 요소로 `hp:t` 안에 들어가고 문단은 나뉘지 않는다.
// 기대값은 명세(엔진 명세 8.2)에서 만들었다: 게이트 통과, 다시 읽은 논리 글이 (줄바꿈을 `\n`으로 맞춘) 값과 같음,
// 문단 수 불변, 검사기 새 오류 0, 결정성, 제어 문자 거절, md·txt 불변.
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFragment, isTableNode, listFields, openPackage, parseDocument, readArchive, readEntry, serializeFragment, validateDocument, walkParagraphs, type HwpxDocument } from "../src/index.ts";
import { censusOfDoc, generate, type GenerateOptions, type GenerateResult } from "../src/fill/index.ts";
import { checkValueText, emptyTemplate, readDataset, readTemplate, resolveValue, type Template } from "../src/template/index.ts";
import { generateText } from "../src/text/index.ts";
import { MINIMAL_HEADER, NS_HP, NS_HS, buildHwpx, loadDoc, mutateEntryText, newErrorsAfter, readFixture, readFixtureText, reparse, sha256Hex, utf8 } from "./helpers.ts";
import { docOf, gridTable, tableParagraph, textPara } from "./table-helpers.ts";

const SEC = "Contents/section0.xml";

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

const tpl = (spec: { anchors?: unknown[]; rules?: unknown[]; options?: unknown }): Template => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const ds = (data: unknown) => readDataset(data);
const sectionOf = (bytes: Uint8Array): string => new TextDecoder().decode(readEntry(readArchive(bytes), bytes, SEC));
const fillRule = (id: string, anchor: string, value: unknown) => ({ id, do: { type: "fill", anchor, value } });
const lineAnchor = (id: string, path: number[], logical: string) => ({ id, kind: "line", at: { sectionIndex: 0, path }, print: { text: logical.slice(0, 40), sha256: sha256Hex(utf8(logical)) } });
const wordAnchor = (id: string, path: number[], logical: string, target: string) => {
  const start = logical.indexOf(target);
  const end = start + target.length;
  return { id, kind: "word", at: { sectionIndex: 0, path }, start, end, print: { text: target, before: logical.slice(Math.max(0, start - 24), start), after: logical.slice(end, end + 24) } };
};

/** 값의 줄바꿈 방식을 `\n`으로 맞춘 기대 글 */
const norm = (v: string): string => v.replace(/\r\n?/g, "\n");
const count = (xml: string, re: RegExp): number => xml.match(re)?.length ?? 0;
const breaks = (xml: string): number => count(xml, /<hp:lineBreak\/>/g);
const tabs = (xml: string): number => count(xml, /<hp:tab /g);
const occurrences = (text: string, ch: string): number => text.split(ch).length - 1;
/**
 * 글·글자모양·dirty·줄 배치 캐시를 지운 뼈대(`hp:t` 요소는 있든 없든 지우고 자기닫힘 run은 펼친다).
 * 채움 전후의 뼈대가 같으면 글 밖(문단 구조 포함)은 바뀌지 않은 것이다.
 */
const skeleton = (xml: string): string =>
  xml
    .replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "")
    .replace(/<hp:t>[\s\S]*?<\/hp:t>|<hp:t\/>/g, "")
    .replace(/<hp:run charPrIDRef="(\d+)"\/>/g, '<hp:run charPrIDRef="$1"></hp:run>')
    .replace(/charPrIDRef="\d+"/g, 'charPrIDRef=""')
    .replace(/ dirty="\d"/g, "");

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `줄 ${i + 1}`).join("\n");
const VALUES: [string, string][] = [
  ["두 줄", "첫 줄\n둘째 줄"],
  ["CRLF·CR 섞임", "하나\r\n둘\r셋\n넷"],
  ["탭", "앞\t뒤"],
  ["줄바꿈으로 시작", "\n시작"],
  ["줄바꿈으로 끝남", "끝\n"],
  ["줄바꿈만", "\n"],
  ["연속 줄바꿈", "가\n\n나"],
  ["탭만", "\t"],
  ["줄바꿈과 탭과 특수문자", "a<b>&\n\"c\"\t'd'"],
  ["10줄", TEN_LINES],
  ["짝 문자(이모지)", "😀\n😀"],
];

type Place = {
  name: string;
  bytes: Uint8Array;
  template: Template;
  /** 값 `v`를 데이터 경로 `v`에 넣는다 */
  data: (v: string) => unknown;
  /** 채운 자리들의 논리 글(출력을 다시 읽는다) */
  reread: (doc: HwpxDocument) => string[];
  /** 기대 글 목록 */
  expected: (v: string) => string[];
  /** 문단 수의 증감(행 반복만 0이 아니다) */
  paraDelta?: number;
  /** 값이 들어가는 자리의 수 */
  places: number;
  /** 생성 옵션. 규칙이 가리키지 않는 이름 있는 누름틀(암묵 채움 대상)이 든 문서는 누락 정책 keep으로 그대로 둔다. */
  options?: GenerateOptions;
};

const fieldValues = (name: string) => (doc: HwpxDocument): string[] => listFields(doc).filter((f) => f.name === name).map((f) => f.valueText);
const paragraphText = (index: number) => (doc: HwpxDocument): string[] => [doc.sections[0]?.paragraphs[index]?.logicalText ?? "<없음>"];

const FIELD_STATES = readFixture("hancom/field-states");
const HOLLOW_FIELD = mutateEntryText(readFixture("hancom-field"), SEC, (x) => x.replace("<hp:t>홍길동</hp:t>", ""));
const SYNTH = docOf([textPara("앞 대상 뒤"), textPara("다음 문단")]);
const REPEAT_DOC = docOf([tableParagraph(gridTable([3000, 3000], 2, [["x", "y"], ["{{p}}", "{{idx}}"]]))]);

const PLACES: Place[] = [
  {
    name: "누름틀(값 있음, dirty=1)",
    bytes: FIELD_STATES,
    template: tpl({ anchors: [{ id: "a", kind: "field", name: "소속" }], rules: [fillRule("r", "a", { path: "v" })] }),
    data: (v) => ({ v }),
    reread: fieldValues("소속"),
    expected: (v) => [norm(v)],
    places: 1,
    options: { missing: "keep" },
  },
  {
    name: "누름틀(안내문 상태, 같은 이름 둘)",
    bytes: FIELD_STATES,
    template: tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }], rules: [fillRule("r", "a", { path: "v" })] }),
    data: (v) => ({ v }),
    reread: fieldValues("성명"),
    expected: (v) => [norm(v), norm(v)],
    places: 2,
    options: { missing: "keep" },
  },
  {
    name: "누름틀(빈 것: 사이에 hp:t 없음)",
    bytes: HOLLOW_FIELD,
    template: tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }], rules: [fillRule("r", "a", { path: "v" })] }),
    data: (v) => ({ v }),
    reread: fieldValues("성명"),
    expected: (v) => [norm(v)],
    places: 1,
  },
  {
    name: "문서 안 {{}}",
    bytes: readFixture("hancom/ph-single"),
    template: emptyTemplate(),
    data: (v) => ({ project: { name: v, start: "S", end: "E" } }),
    reread: (doc) => [...paragraphText(1)(doc), ...paragraphText(2)(doc)],
    expected: (v) => [`사업명: ${norm(v)} 입니다.`, "기간: S ~ E"],
    places: 1,
  },
  {
    name: "낱말(word 앵커)",
    bytes: SYNTH,
    template: tpl({ anchors: [wordAnchor("w", [0], "앞 대상 뒤", "대상")], rules: [fillRule("r", "w", { path: "v" })] }),
    data: (v) => ({ v }),
    reread: paragraphText(0),
    expected: (v) => [`앞 ${norm(v)} 뒤`],
    places: 1,
  },
  {
    name: "문단(line 앵커)",
    bytes: SYNTH,
    template: tpl({ anchors: [lineAnchor("l", [0], "앞 대상 뒤")], rules: [fillRule("r", "l", { path: "v" })] }),
    data: (v) => ({ v }),
    reread: paragraphText(0),
    expected: (v) => [norm(v)],
    places: 1,
  },
  {
    name: "셀(빈 칸, 자기닫힘 run)",
    bytes: readFixture("hancom/ph-table"),
    template: tpl({ anchors: [{ id: "c", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 1 }], rules: [fillRule("r", "c", { path: "v" })] }),
    data: (v) => ({ v, applicant: { name: "홍" }, note: "비" }),
    reread: (doc) => {
      const table = doc.sections[0]?.paragraphs[1]?.objects[0];
      return table !== undefined && isTableNode(table) ? table.cells.map((c) => c.subList?.paragraphs[0]?.logicalText ?? "<없음>") : ["<표 없음>"];
    },
    expected: (v) => ["성명", "홍", "연락처", norm(v), "비고", "비"],
    places: 1,
  },
  {
    name: "행 반복의 값",
    bytes: REPEAT_DOC,
    template: tpl({
      anchors: [{ id: "row", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 0 }],
      rules: [{ id: "r", do: { type: "repeat", anchor: "row", each: { path: "xs" }, as: "p", index: "idx" } }],
    }),
    data: (v) => ({ xs: [v, "다음"] }),
    reread: (doc) => doc.sections[0]?.paragraphs[0]?.subLists.map((s) => s.paragraphs[0]?.logicalText ?? "<없음>") ?? [],
    expected: (v) => ["x", "y", norm(v), "1", "다음", "2"],
    paraDelta: 2,
    places: 1,
  },
];

for (const place of PLACES) {
  for (const [label, value] of VALUES) {
    test(`A: ${place.name} — ${label}: 게이트 통과, 다시 읽은 글이 값과 같고 문단 수·뼈대·검사기 결과가 그대로이며 결정적이다`, () => {
      const before = reparse(place.bytes);
      const r = done(generate(place.bytes, place.template, ds(place.data(value)), place.options));
      const out = reparse(r.output);
      assert.deepEqual(place.reread(out), place.expected(value), "다시 읽은 논리 글");

      // 줄바꿈 요소·탭 요소의 수가 값과 같고(그 밖의 자리는 그대로), 문단은 나뉘지 않는다
      const xmlBefore = sectionOf(place.bytes);
      const xmlAfter = sectionOf(r.output);
      const v = norm(value);
      assert.equal(breaks(xmlAfter) - breaks(xmlBefore), occurrences(v, "\n") * place.places, "줄바꿈 요소 수");
      assert.equal(tabs(xmlAfter) - tabs(xmlBefore), occurrences(v, "\t") * place.places, "탭 요소 수");
      assert.equal(censusOfDoc(out).paragraphs - censusOfDoc(before).paragraphs, place.paraDelta ?? 0, "문단 수");
      if (place.paraDelta === undefined) assert.equal(skeleton(xmlAfter), skeleton(xmlBefore), "글 밖의 구조");

      // 검사기: 새 오류 0, 게이트가 다시 읽은 자리가 있다
      assert.deepEqual(newErrorsAfter(validateDocument(place.bytes), validateDocument(r.output)), []);
      assert.equal(r.report.validation?.newErrors.length, 0);
      assert.ok(r.report.reread.fields + r.report.reread.paragraphs > 0, "값 재읽기가 있었다");

      // 결정성
      const again = done(generate(place.bytes, place.template, ds(place.data(value)), place.options));
      assert.ok(Buffer.from(again.output).equals(Buffer.from(r.output)), "같은 입력은 같은 바이트");
    });
  }
}

test("A: 요소의 모양은 한컴이 저장한 것과 같다 — 줄바꿈은 속성 없는 빈 요소, 탭은 width·leader·type 속성이 있는 빈 요소", () => {
  const r = done(generate(readFixture("hancom/ph-single"), emptyTemplate(), ds({ project: { name: "가\n나\t다", start: "S", end: "E" } })));
  const xml = sectionOf(r.output);
  assert.ok(xml.includes('<hp:t>사업명: 가<hp:lineBreak/>나<hp:tab width="0" leader="0" type="1"/>다 입니다.</hp:t>'), xml.slice(xml.indexOf("사업명") - 40, xml.indexOf("사업명") + 200));
});

test("A: CRLF·CR은 LF로 맞춘다 — 출력 바이트와 원장의 값 지문이 LF만 쓴 값과 같다", () => {
  const bytes = readFixture("hancom/ph-single");
  const make = (name: string): Done => done(generate(bytes, emptyTemplate(), ds({ project: { name, start: "S", end: "E" } })));
  const lf = make("a\nb\nc");
  const mixed = make("a\r\nb\rc");
  assert.ok(Buffer.from(lf.output).equals(Buffer.from(mixed.output)));
  assert.deepEqual(mixed.ledger.actions, lf.ledger.actions);
  const x = mixed.ledger.actions.find((a) => a.anchor === "{{project.name}}");
  assert.equal(x?.value?.length, 5, "지문의 길이는 맞춘 글의 것");
});

test("A: 보고서·원장에 값 원문이 없다(줄바꿈이 든 값도)", () => {
  const secret = "극비\n문장\t끝";
  const r = done(generate(readFixture("hancom/ph-single"), emptyTemplate(), ds({ project: { name: secret, start: "S", end: "E" } })));
  const all = JSON.stringify({ report: r.report, ledger: r.ledger });
  for (const word of ["극비", "문장", "끝"]) assert.ok(!all.includes(word), `원문 ${word}이(가) 보고서에 있다`);
});

test("A: 접두사가 hp가 아닌 문서·기본 네임스페이스 문서에서도 그 문서의 접두사로 요소를 만든다", () => {
  const body = (p: string, ns: string): string =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec xmlns:hs="${NS_HS}"${ns}><${p}p id="0" paraPrIDRef="0" styleIDRef="0"><${p}run charPrIDRef="0"><${p}t>가 {{x}} 나</${p}t></${p}run></${p}p></hs:sec>`;
  for (const [prefix, ns] of [["q:", ` xmlns:q="${NS_HP}"`], ["", ` xmlns="${NS_HP}"`]] as const) {
    const bytes = buildHwpx([body(prefix, ns)], MINIMAL_HEADER, true);
    const r = done(generate(bytes, emptyTemplate(), ds({ x: "a\nb\tc" })));
    const xml = sectionOf(r.output);
    assert.ok(xml.includes(`<${prefix}lineBreak/>`) && xml.includes(`<${prefix}tab width="0" leader="0" type="1"/>`), xml);
    assert.ok(!xml.includes("<hp:"), "다른 접두사를 쓰지 않았다");
    assert.equal(reparse(r.output).sections[0]?.paragraphs[0]?.logicalText, "가 a\nb\tc 나");
  }
});

test("A: CDATA 안의 글에도 넣는다(CDATA를 닫고 요소를 넣은 뒤 다시 연다. ]]>가 든 값도)", () => {
  const raw = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec xmlns:hs="${NS_HS}" xmlns:hp="${NS_HP}"><hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t><![CDATA[앞 {{x}} 뒤]]></hp:t></hp:run></hp:p></hs:sec>`;
  const bytes = buildHwpx([raw], MINIMAL_HEADER, true);
  for (const value of ["a\nb]]>c\td", "\n끝", "시작\n"]) {
    const r = done(generate(bytes, emptyTemplate(), ds({ x: value })));
    assert.equal(reparse(r.output).sections[0]?.paragraphs[0]?.logicalText, `앞 ${value} 뒤`);
  }
});

test("A: 엔티티(&amp; 등) 옆의 자리에도 넣는다", () => {
  const bytes = docOf([textPara("앞 &amp; {{x}} &lt; 뒤")]);
  const r = done(generate(bytes, emptyTemplate(), ds({ x: "a\nb" })));
  assert.equal(reparse(r.output).sections[0]?.paragraphs[0]?.logicalText, "앞 & a\nb < 뒤");
});

test("A: 한 문단 안의 여러 자리, 같은 값을 여러 번 — 각각 요소로 들어간다", () => {
  const bytes = docOf([textPara("{{a}} / {{b}} / {{a}}")]);
  const r = done(generate(bytes, emptyTemplate(), ds({ a: "1\n2", b: "3\t4" })));
  assert.equal(reparse(r.output).sections[0]?.paragraphs[0]?.logicalText, "1\n2 / 3\t4 / 1\n2");
  assert.equal(breaks(sectionOf(r.output)), 2);
  assert.equal(tabs(sectionOf(r.output)), 1);
  assert.equal(r.report.reread.paragraphs, 1);
});

test("A: 템플릿 {text} 값의 줄바꿈도 같다", () => {
  const t = tpl({ anchors: [lineAnchor("l", [0], "앞 대상 뒤")], rules: [fillRule("r", "l", { text: "고정\r\n값" })] });
  const r = done(generate(SYNTH, t, ds({})));
  assert.equal(reparse(r.output).sections[0]?.paragraphs[0]?.logicalText, "고정\n값");
});

test("A: 제어 문자는 여전히 VALUE_CONTROL_CHAR로 거절하고 출력이 없다(줄바꿈·탭이 섞여 있어도)", () => {
  const bytes = readFixture("hancom/ph-single");
  for (const bad of ["a\u0001b", "줄\n바꿈\u0000", "\u000B", "\u000C", "\u001F", "탭\t\u0008", "\ud800", "x\u{FFFF}"]) {
    assert.deepEqual(failedCodes(generate(bytes, emptyTemplate(), ds({ project: { name: bad, start: "S", end: "E" } }))), ["VALUE_CONTROL_CHAR"], JSON.stringify(bad));
  }
  const field = tpl({ anchors: [{ id: "a", kind: "field", name: "소속" }], rules: [fillRule("r", "a", { path: "v" })] });
  assert.deepEqual(failedCodes(generate(FIELD_STATES, field, ds({ v: "a\n\u0002b" }), { missing: "keep" })), ["VALUE_CONTROL_CHAR"]);
  // 템플릿의 {text} 값도 같다
  const literal = tpl({ anchors: [lineAnchor("l", [0], "앞 대상 뒤")], rules: [fillRule("r", "l", { text: "x\u0001" })] });
  assert.deepEqual(failedCodes(generate(SYNTH, literal, ds({}))), ["VALUE_CONTROL_CHAR"]);
});

test("A: 값 검사 함수 — 기본은 줄바꿈·탭을 통과시키고 그 밖의 금지 문자는 사유를 돌려준다. insertText 방식은 탭을, md·txt 방식은 둘 다 거절한다", () => {
  assert.equal(checkValueText("a\nb\r\nc\td"), undefined);
  assert.equal(checkValueText("a\u0001"), "U+0001");
  assert.equal(checkValueText("a\u000Bb"), "U+000B");
  assert.equal(checkValueText("a\nb", "paragraphs"), undefined);
  assert.equal(checkValueText("a\tb", "paragraphs"), "U+0009");
  assert.equal(checkValueText("a\nb", "none"), "U+000A");
  assert.equal(checkValueText("a\rb", "none"), "U+000D");
  assert.equal(checkValueText("a\tb", "none"), "U+0009");
  assert.equal(checkValueText("정상 &<> \"'", "none"), undefined);
  const dataset = ds({ v: "a\r\nb\rc" });
  assert.deepEqual(resolveValue(dataset, { path: "v" }, "error"), { kind: "text", text: "a\nb\nc", path: "v" });
  assert.deepEqual(resolveValue(dataset, { path: "v" }, "error", "paragraphs"), { kind: "text", text: "a\r\nb\rc", path: "v" });
  assert.equal(resolveValue(dataset, { path: "v" }, "error", "none").kind, "error");
});

test("A: md·txt 어댑터는 그대로 — 같은 값을 HWPX는 받고 md·txt는 VALUE_CONTROL_CHAR로 거절한다", () => {
  const data = { x: "첫 줄\n둘째 줄" };
  for (const kind of ["md", "txt"] as const) {
    const r = generateText("{{x}}\n", kind, emptyTemplate(), readDataset(data));
    assert.equal(r.ok, false);
    assert.ok(r.report.issues.some((i) => i.code === "VALUE_CONTROL_CHAR"));
  }
  done(generate(SYNTH, tpl({ anchors: [lineAnchor("l", [0], "앞 대상 뒤")], rules: [fillRule("r", "l", { path: "x" })] }), readDataset(data)));
});

test("A: insertText는 그대로 — 줄바꿈마다 문단을 나누고(요소를 쓰지 않는다) 탭은 거절한다", () => {
  const t = tpl({
    anchors: [lineAnchor("l", [0], "앞 대상 뒤")],
    rules: [{ id: "r", do: { type: "insertText", anchor: "l", position: "after", value: { path: "v" }, style: "inherit" } }],
  });
  const r = done(generate(SYNTH, t, ds({ v: "가\r\n나\n다" })));
  const out = reparse(r.output);
  assert.deepEqual(out.sections[0]?.paragraphs.map((p) => p.logicalText), ["앞 대상 뒤", "가", "나", "다", "다음 문단"]);
  assert.equal(breaks(sectionOf(r.output)), 0);
  assert.deepEqual(failedCodes(generate(SYNTH, t, ds({ v: "가\t나" }))), ["VALUE_CONTROL_CHAR"]);
});

test("A: 조각 주입 안의 {{}}도 줄바꿈 값을 요소로 채운다(채운 조각의 글을 게이트가 다시 읽는다)", () => {
  const blocks = readFixture("hancom/blocks");
  const fragment = extractFragment(loadDoc("hancom/ph-single"), { sectionIndex: 0, parentPath: [], from: 1, to: 1 });
  const t = tpl({
    anchors: [lineAnchor("p", [3], "선택 조항 본문입니다. (해당 시)")],
    rules: [{ id: "r", do: { type: "inject", anchor: "p", position: "after", fragment: JSON.parse(serializeFragment(fragment)) } }],
  });
  const r = done(generate(blocks, t, ds({ project: { name: "첫 줄\r\n둘째\t셋째" } })));
  const out = reparse(r.output);
  assert.equal(out.sections[0]?.paragraphs[4]?.logicalText, "사업명: 첫 줄\n둘째\t셋째 입니다.");
  assert.equal(censusOfDoc(out).paragraphs - censusOfDoc(reparse(blocks)).paragraphs, 1, "조각의 문단 하나만 늘었다");
  assert.deepEqual(newErrorsAfter(validateDocument(blocks), validateDocument(r.output)), []);
});

test("A: 한 번 채운 문서를 다시 채울 수 있다 — 줄바꿈이 든 {{}} 값을 채운 문서의 다른 자리가 채워진다", () => {
  const bytes = docOf([textPara("{{a}}"), textPara("{{b}}")]);
  const first = done(generate(bytes, emptyTemplate(), ds({ a: "1\n2" }), { missing: "keep" }));
  const second = done(generate(first.output, emptyTemplate(), ds({ b: "3\n4" }), { missing: "keep" }));
  assert.deepEqual(reparse(second.output).sections[0]?.paragraphs.map((p) => p.logicalText), ["1\n2", "3\n4"]);
});

test("A: strict 방식·누락 정책 empty에서도 줄바꿈 값이 같다. 모의 실행도 오류가 아니다", () => {
  const data = ds({ project: { name: "a\nb", start: "S", end: "E" } });
  const options: GenerateOptions[] = [{ mode: "strict" }, { missing: "empty" }, { mixedFormat: "first" }];
  for (const o of options) {
    const r = generate(readFixture("hancom/ph-single"), emptyTemplate(), data, o);
    // strict는 원래 있던 오류가 있으면 막을 수 있어 통과 여부는 따지지 않고, 통과하면 값이 같아야 한다
    if (r.ok && !r.dryRun) assert.equal(reparse(r.output).sections[0]?.paragraphs[1]?.logicalText, "사업명: a\nb 입니다.");
    else assert.ok(o.mode === "strict", JSON.stringify(o));
  }
  const dry = generate(readFixture("hancom/ph-single"), emptyTemplate(), data, { dryRun: true });
  assert.ok(dry.ok && dry.dryRun);
});

test("A: 파서는 한컴이 저장한 줄바꿈·탭 요소를 \n·\t로 읽는다(합성 문서)", () => {
  const bytes = docOf([`<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>가<hp:lineBreak/>나<hp:tab width="2764" leader="0" type="1"/>다</hp:t></hp:run></hp:p>`]);
  assert.equal(parseDocument(openPackage(bytes)).sections[0]?.paragraphs[0]?.logicalText, "가\n나\t다");
});

// 한컴 저장본에서 관측한 모양(tools/com/make_fixtures.py --only inline-breaks, 한컴 13.0.0.711)과 엔진이 만드는 모양을 견준다.
test("A: 한컴이 저장한 줄바꿈·탭 요소(inline/inline-breaks)와 엔진이 만드는 요소의 이름·속성·위치가 같다", () => {
  const bytes = readFixture("inline/inline-breaks");
  const listed = new Map(readFixtureText("inline/SHA256SUMS").split("\n").filter((l) => l.trim() !== "").map((l) => l.trim().split(/\s+/)).map(([h, n]) => [n, h]));
  assert.equal(sha256Hex(bytes), listed.get("inline-breaks.hwpx"));

  // 한컴의 모양: 줄바꿈은 속성 없는 빈 요소, 탭은 width·leader·type 속성(leader 0, type 1), 둘 다 hp:t 안에 있다
  const native = sectionOf(bytes);
  assert.deepEqual([...new Set(native.match(/<hp:lineBreak[^>]*>/g))], ["<hp:lineBreak/>"]);
  const nativeTabs = native.match(/<hp:tab [^>]*>/g) ?? [];
  assert.equal(nativeTabs.length, 3);
  for (const el of nativeTabs) assert.match(el, /^<hp:tab width="\d+" leader="0" type="1"\/>$/);
  const doc = reparse(bytes);
  const inline = doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)]).flatMap((p) => p.pieces.filter((x) => x.kind === "inline"));
  assert.equal(inline.length, 6, "탭 3개와 줄바꿈 3개가 hp:t의 자식 요소로 읽힌다");
  // 누름틀 안의 줄바꿈: 시작 컨트롤과 끝 컨트롤 사이의 hp:t 하나 안에 요소가 있다. 값 재읽기(valueText)는 \n·\t를 준다
  assert.match(native, /<\/hp:ctrl><hp:t>첫 줄<hp:lineBreak\/>둘째 줄<\/hp:t><hp:ctrl><hp:fieldEnd/);
  assert.deepEqual(listFields(doc).map((f) => [f.name, f.shape, f.valueText]), [["줄", "inline", "첫 줄\n둘째 줄"], ["탭", "inline", "가\t나"]]);
  assert.deepEqual(doc.sections[0]?.paragraphs.map((p) => p.logicalText).slice(0, 3), ["\uFFFC\uFFFC첫 줄\n둘째 줄", "가\t나", "다\t라"]); // 첫 문단은 구역·단 설정이 든 컨트롤 둘로 시작한다

  // 엔진이 만든 모양: 같은 위치(누름틀 안, 본문, 표 칸), 같은 요소 이름, 같은 속성 이름·순서, 같은 leader·type
  const field = tpl({ anchors: [{ id: "a", kind: "field", name: "소속" }], rules: [fillRule("r", "a", { path: "v" })] });
  const filled = done(generate(FIELD_STATES, field, ds({ v: "첫 줄\n둘째 줄" }), { missing: "keep" }));
  assert.match(sectionOf(filled.output), /<\/hp:ctrl><hp:t>첫 줄<hp:lineBreak\/>둘째 줄<\/hp:t><hp:ctrl><hp:fieldEnd/);
  const tabbed = done(generate(readFixture("hancom/ph-single"), emptyTemplate(), ds({ project: { name: "가\t나", start: "S", end: "E" } })));
  const engineTab = (sectionOf(tabbed.output).match(/<hp:tab [^>]*>/) ?? [""])[0];
  const names = (el: string): string[] => [...el.matchAll(/ (\w+)="/g)].map((m) => m[1] ?? "");
  assert.deepEqual(names(engineTab), names(nativeTabs[0] ?? ""));
  assert.match(engineTab, /leader="0" type="1"\/>$/);
});
