import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  buildTree,
  decodeEntities,
  decodeUtf8,
  elIs,
  encodeUtf8,
  escapeAttr,
  escapeText,
  isEl,
  nsRole,
  openPackage,
  parseDocument,
  readArchive,
  readEntry,
  tokenize,
  walkElements,
  type Token,
  type XElement,
} from "../src/index.ts";
import { FIXTURE_NAMES, bytesEqual, isXmlEntryName, mutateEntryText, readFixture } from "./helpers.ts";

function throwsCode(fn: () => unknown, code: string): HwpxError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아닌 예외: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`${code} 예외가 나야 하는데 정상 종료했다`);
}

function xmlEntries(name: string): { entry: string; bytes: Uint8Array }[] {
  const bytes = readFixture(name);
  const archive = readArchive(bytes);
  return archive.entries
    .filter((e) => !e.isDirectory && isXmlEntryName(e.name))
    .map((e) => ({ entry: e.name, bytes: readEntry(archive, bytes, e.name) }));
}

// ── RT1, RT2 ────────────────────────────────────────────────────────────

for (const name of FIXTURE_NAMES) {
  test(`RT1 토큰이 입력을 빈틈없이 덮고 이어 붙이면 입력과 같다: ${name}`, () => {
    const entries = xmlEntries(name);
    // 독립 기대값: D1~D7은 XML 항목 4개, 한컴이 저장한 문서는 8개
    assert.equal(entries.length, name.startsWith("D") ? 4 : 8);
    for (const { entry, bytes } of entries) {
      const text = decodeUtf8(bytes, entry);
      const tokens = tokenize(text);
      assert.ok(tokens.length > 0);
      let at = 0;
      for (const t of tokens) {
        assert.equal(t.start, at, `${entry}: 토큰 사이에 틈이나 겹침이 있다`);
        assert.ok(t.end > t.start, `${entry}: 빈 토큰`);
        at = t.end;
      }
      assert.equal(at, text.length, `${entry}: 끝까지 덮어야 한다`);
      assert.equal(tokens.map((t) => text.slice(t.start, t.end)).join(""), text);
      for (const t of tokens) {
        const raw = text.slice(t.start, t.end);
        if (t.kind === "start" || t.kind === "empty" || t.kind === "end") {
          assert.ok(raw.startsWith("<") && raw.endsWith(">"));
          assert.equal(raw.endsWith("/>"), t.kind === "empty");
        }
        if (t.kind === "text") assert.ok(!raw.includes("<"));
      }
    }
  });

  test(`RT2 해독 후 다시 부호화하면 원본 바이트와 같다: ${name}`, () => {
    for (const { entry, bytes } of xmlEntries(name)) {
      const text = decodeUtf8(bytes, entry);
      assert.ok(bytesEqual(encodeUtf8(text), bytes), `${entry}: 재부호화한 바이트가 달라졌다`);
    }
  });

  test(`4.2 요소 트리의 구간이 원문과 맞는다: ${name}`, () => {
    for (const { entry, bytes } of xmlEntries(name)) {
      const text = decodeUtf8(bytes, entry);
      const root = buildTree(text, tokenize(text));
      let count = 0;
      for (const el of walkElements(root)) {
        count++;
        assert.ok(text.startsWith(`<${el.qname}`, el.start), `${entry}: ${el.qname} 시작`);
        assert.equal(text[el.openEnd - 1], ">");
        if (el.closeStart === el.end) {
          assert.ok(text.slice(el.start, el.end).endsWith("/>"), "빈 태그");
        } else {
          assert.equal(text.slice(el.closeStart, el.end), `</${el.qname}>`);
        }
        for (const c of el.children) {
          assert.ok(c.start >= el.openEnd && c.end <= el.closeStart, "자식은 안쪽 구간에 있다");
          if (!("local" in c)) assert.equal(text.slice(c.start, c.end), c.raw);
        }
        for (const a of el.attrs) {
          assert.ok(a.nameStart > el.start && a.valueEnd < el.openEnd);
          assert.ok(text.startsWith(a.qname, a.nameStart));
          assert.ok(['"', "'"].includes(text[a.valueStart - 1] ?? ""));
          assert.equal(text[a.valueEnd], text[a.valueStart - 1]);
          assert.equal(decodeEntities(text.slice(a.valueStart, a.valueEnd)), a.value);
        }
      }
      assert.ok(count > 0);
      assert.equal(root.parent, null);
    }
  });
}

test("RT2 BOM은 보존된다: bom 토큰으로 나오고 재부호화가 바이트 동일", () => {
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0" encoding="UTF-8"?><a>가</a>', "utf8")]);
  const text = decodeUtf8(raw);
  assert.equal(text.charCodeAt(0), 0xfeff);
  const tokens = tokenize(text);
  assert.deepEqual(tokens[0], { kind: "bom", start: 0, end: 1 });
  assert.equal(tokens[1]?.kind, "decl");
  assert.ok(bytesEqual(encodeUtf8(text), raw));
});

// ── RT5: XML 계층의 반례 (fixtures 사본의 항목 텍스트를 바꿔 만든다) ─────────────

function parseMutated(change: (t: string) => string, entry = "Contents/section0.xml", fixture = "D1"): void {
  const bytes = mutateEntryText(readFixture(fixture), entry, change);
  parseDocument(openPackage(bytes));
}

function lineColOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
}

test("RT5 태그가 맞지 않으면 XML_MALFORMED (줄·열 포함)", () => {
  let mutated = "";
  const e = throwsCode(
    () =>
      parseMutated((t) => {
        mutated = t.replace("</hp:run>", "</hp:p>");
        return mutated;
      }),
    "XML_MALFORMED",
  );
  const at = lineColOf(mutated, mutated.indexOf("</hp:p>"));
  assert.ok(e.message.includes(`줄 ${at.line}, 열 ${at.column}`), e.message);
  assert.equal(e.where, `Contents/section0.xml:${at.line}:${at.column}`);
});

test("RT5 잘못된 엔티티는 XML_MALFORMED", () => {
  throwsCode(() => parseMutated((t) => t.replace("&lt;", "&nope;")), "XML_MALFORMED");
  throwsCode(() => parseMutated((t) => t.replace("&amp;앰", "&앰")), "XML_MALFORMED");
  throwsCode(() => parseMutated((t) => t.replace("&lt;", "&lt")), "XML_MALFORMED");
  throwsCode(() => parseMutated((t) => t.replace("&lt;", "&#xZZ;")), "XML_MALFORMED");
  // 속성값 안의 잘못된 참조도 같다
  throwsCode(() => parseMutated((t) => t.replace('styleIDRef="0"', 'styleIDRef="&bad;"')), "XML_MALFORMED");
});

test("RT5 숫자 참조가 허용되지 않는 문자를 가리키면 XML_ILLEGAL_CHAR", () => {
  throwsCode(() => parseMutated((t) => t.replace("&lt;", "&#0;")), "XML_ILLEGAL_CHAR");
  throwsCode(() => parseMutated((t) => t.replace("&lt;", "&#x110000;")), "XML_ILLEGAL_CHAR");
  throwsCode(() => parseMutated((t) => t.replace("&lt;", "&#xD800;")), "XML_ILLEGAL_CHAR");
  // 허용되는 숫자 참조는 통과한다
  parseMutated((t) => t.replace("&lt;", "&#x1F600;&#65;"));
});

test("RT5 DOCTYPE은 XML_DOCTYPE", () => {
  throwsCode(
    () => parseMutated((t) => t.replace("?>\n", '?>\n<!DOCTYPE hs:sec [<!ENTITY x "y">]>\n')),
    "XML_DOCTYPE",
  );
  throwsCode(() => parseMutated((t) => t.replace(/^(<\?xml[^>]*\?>)/, "$1<!DOCTYPE a>"), "Contents/header.xml"), "XML_DOCTYPE");
});

test("RT5 속성 중복은 XML_MALFORMED", () => {
  const e = throwsCode(
    () => parseMutated((t) => t.replace('<hp:p paraPrIDRef="1" styleIDRef="0">', '<hp:p paraPrIDRef="1" styleIDRef="0" paraPrIDRef="2">')),
    "XML_MALFORMED",
  );
  assert.ok(e.message.includes("paraPrIDRef"));
});

test("4.1 그 밖의 정형성 위반은 XML_MALFORMED", () => {
  const cases: [string, (t: string) => string][] = [
    ["루트가 닫히지 않음", (t) => t.replace("</hs:sec>", "")],
    ["루트가 둘", (t) => t + "<hs:sec/>"],
    ["루트 밖 문자", (t) => t + "oops"],
    ["속성값 안의 <", (t) => t.replace('styleIDRef="0"', 'styleIDRef="a<b"')],
    ["속성 사이 공백 없음", (t) => t.replace('paraPrIDRef="1" styleIDRef="0"', 'paraPrIDRef="1"styleIDRef="0"')],
    ["따옴표 없는 속성값", (t) => t.replace('styleIDRef="0"', "styleIDRef=0")],
    ["주석 안의 --", (t) => t.replace("<hp:p ", "<!-- a -- b --><hp:p ")],
    ["CDATA 끝 표식이 문자 데이터에", (t) => t.replace("첫째 문단", "첫째 ]]> 문단")],
    ["선언되지 않은 접두사", (t) => t.replace("<hp:p paraPrIDRef=\"1\"", "<zz:p paraPrIDRef=\"1\"").replace("</hp:p>", "</zz:p>")],
    ["XML 선언이 맨 앞이 아님", (t) => " " + t],
    ["닫는 태그 없는 여는 태그", (t) => t.replace("</hp:t>", "")],
  ];
  for (const [label, change] of cases) {
    const e = throwsCode(() => parseMutated(change), "XML_MALFORMED");
    assert.ok(/줄 \d+, 열 \d+/.test(e.message) || e.message.includes("접두사"), `${label}: ${e.message}`);
  }
});

test("4.1 선언된 인코딩이 UTF-8이 아니거나 바이트가 UTF-8이 아니면 XML_ENCODING", () => {
  throwsCode(() => parseMutated((t) => t.replace('encoding="UTF-8"', 'encoding="EUC-KR"')), "XML_ENCODING");
  // 해독 실패: 한 글자 중간을 끊는다
  const bytes = readFixture("D1");
  const pkg = openPackage(bytes);
  const raw = Buffer.from(readEntry(pkg.archive, bytes, "Contents/section0.xml"));
  const at = raw.indexOf(Buffer.from("첫째"));
  raw[at + 1] = 0x41; // 한글 3바이트 중 둘째 바이트를 ASCII로 바꿔 잘못된 시퀀스를 만든다
  throwsCode(() => decodeUtf8(raw), "XML_ENCODING");
});

test("4.3 XML에서 허용하지 않는 문자는 XML_ILLEGAL_CHAR", () => {
  throwsCode(() => parseMutated((t) => t.replace("첫째", "첫\u0001째")), "XML_ILLEGAL_CHAR");
  throwsCode(() => parseMutated((t) => t.replace("첫째", "첫￾째")), "XML_ILLEGAL_CHAR");
  throwsCode(() => tokenize("<a>\uD800</a>"), "XML_ILLEGAL_CHAR");
  throwsCode(() => escapeText("a\u0000b"), "XML_ILLEGAL_CHAR");
  throwsCode(() => escapeAttr("a\u000Bb"), "XML_ILLEGAL_CHAR");
  throwsCode(() => escapeText("\uDC00"), "XML_ILLEGAL_CHAR");
});

// ── 토크나이저 세부 ─────────────────────────────────────────────────────

test("4.1 토큰 종류·이름·속성 구간", () => {
  const text = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<a x=\'1\' y="&amp;2"><!-- c --><![CDATA[z<]]><?pi data?><b/>t&lt;</a>\n';
  const tokens = tokenize(text);
  assert.deepEqual(
    tokens.map((t) => t.kind),
    ["decl", "text", "start", "comment", "cdata", "pi", "empty", "text", "end", "text"],
  );
  const a = tokens[2] as Token;
  assert.equal(a.name, "a");
  assert.equal(a.attrs?.length, 2);
  const [x, y] = a.attrs ?? [];
  assert.ok(x !== undefined && y !== undefined);
  assert.equal(x.qname, "x");
  assert.equal(x.value, "1");
  assert.equal(text.slice(x.valueStart, x.valueEnd), "1");
  assert.equal(text.slice(x.nameStart, x.nameStart + 1), "x");
  assert.equal(y.value, "&2");
  assert.equal(text.slice(y.valueStart, y.valueEnd), "&amp;2");
  assert.equal(tokens[6]?.name, "b");
  assert.deepEqual(tokens[6]?.attrs, []);
  assert.equal(tokens[8]?.name, "a");
  assert.equal(tokens[8]?.attrs, undefined);
});

test("4.1 빈 문서·루트 없음·태그 안의 공백 변형", () => {
  throwsCode(() => tokenize(""), "XML_MALFORMED");
  throwsCode(() => tokenize("   "), "XML_MALFORMED");
  throwsCode(() => tokenize("<a>"), "XML_MALFORMED");
  throwsCode(() => tokenize("</a>"), "XML_MALFORMED");
  assert.equal(tokenize("<a  x = '1' ></a >").length, 2);
  assert.equal(tokenize("<a/><!--after-->\n").length, 3);
  throwsCode(() => tokenize("<a/><b/>"), "XML_MALFORMED");
  throwsCode(() => tokenize("<a><![CDATA[x</a>"), "XML_MALFORMED");
  throwsCode(() => tokenize('<a x="1" x="2"/>'), "XML_MALFORMED");
  throwsCode(() => tokenize('<a x="1"'), "XML_MALFORMED");
  throwsCode(() => tokenize("<1a/>"), "XML_MALFORMED");
  throwsCode(() => tokenize('<?xml version="2.0"?><a/>'), "XML_MALFORMED");
  throwsCode(() => tokenize('<?xml version="1.0" encoding="UTF-16"?><a/>'), "XML_ENCODING");
  assert.equal(tokenize("<a>한글 이름</a>").length, 3);
  assert.equal(tokenize("<한글:태그 한글='값'/>").length, 1);
});

test("4.1 중첩이 지나치게 깊으면 거부한다", () => {
  throwsCode(() => tokenize("<a>".repeat(1001) + "</a>".repeat(1001)), "XML_MALFORMED");
  assert.equal(tokenize("<a>".repeat(1000) + "</a>".repeat(1000)).length, 2000);
});

test("4.1 큰 입력도 선형 시간에 가깝게 토큰화한다", () => {
  const body = '<a x="1" y="2" z="3">텍스트</a>'.repeat(40000);
  const t0 = performance.now();
  const tokens = tokenize(`<r>${body}</r>`);
  const ms = performance.now() - t0;
  assert.equal(tokens.length, 40000 * 3 + 2);
  assert.ok(ms < 3000, `토큰화에 ${ms}ms가 걸렸다`);
});

// ── 문자 처리 (4.3) ─────────────────────────────────────────────────────

test("4.3 decodeEntities: 5개 이름 참조와 숫자 참조", () => {
  assert.equal(decodeEntities("&lt;&gt;&amp;&quot;&apos;"), `<>&"'`);
  assert.equal(decodeEntities("a&#65;&#x42;&#x1F600;z"), "aAB😀z");
  assert.equal(decodeEntities("no entities"), "no entities");
  assert.equal(decodeEntities("&amp;lt;"), "&lt;", "한 번만 해독한다");
  throwsCode(() => decodeEntities("&nbsp;"), "XML_MALFORMED");
  throwsCode(() => decodeEntities("a & b"), "XML_MALFORMED");
  throwsCode(() => decodeEntities("&constructor;"), "XML_MALFORMED");
  throwsCode(() => decodeEntities("&#1;"), "XML_ILLEGAL_CHAR");
});

test("4.3 escapeText는 & < >만, escapeAttr는 추가로 \"만 바꾼다", () => {
  assert.equal(escapeText(`a&b<c>d"e'f`), `a&amp;b&lt;c&gt;d"e'f`);
  assert.equal(escapeAttr(`a&b<c>d"e'f`), `a&amp;b&lt;c&gt;d&quot;e'f`);
  assert.equal(escapeText("한글 😀 \t\n\r"), "한글 😀 \t\n\r");
  // 왕복: 이스케이프한 값은 해독하면 원래 값이다
  const v = `x&y<z>"w"'😀`;
  assert.equal(decodeEntities(escapeAttr(v)), v);
  assert.equal(decodeEntities(escapeText(v)), v);
});

// ── 요소 트리와 네임스페이스 (4.2) ───────────────────────────────────────

test("4.2 접두사가 달라도 (역할, local)이 같으면 같은 요소다 (2011·2016·2024 계열)", () => {
  const text =
    '<x:p xmlns:x="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:y="http://www.owpml.org/owpml/2024/paragraph" xmlns:z="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:o="http://www.hancom.co.kr/hwpml/2011/head">' +
    "<y:p/><z:p/><o:p/><x:q/></x:p>";
  const root = buildTree(text, tokenize(text));
  const kids = root.children.filter((c): c is XElement => "local" in c);
  assert.equal(kids.length, 4);
  assert.equal(root.prefix, "x");
  assert.equal(root.ns, "http://www.hancom.co.kr/hwpml/2011/paragraph");
  assert.ok(isEl(root, "paragraph", "p"));
  assert.ok(elIs(kids[0] as XElement, "paragraph", "p"), "2024 계열");
  assert.ok(elIs(kids[1] as XElement, "paragraph", "p"), "2016 확장");
  assert.ok(!elIs(kids[2] as XElement, "paragraph", "p"), "local이 같아도 역할이 다르면 다른 요소");
  assert.ok(elIs(kids[2] as XElement, "head", "p"));
  assert.ok(!elIs(kids[3] as XElement, "paragraph", "p"));
  assert.equal(nsRole("http://www.hancom.co.kr/hwpml/2011/section"), "section");
  assert.equal(nsRole("http://www.owpml.org/owpml/2024/head"), "head");
  assert.equal(nsRole("urn:other"), "urn:other");
});

test("4.2 네임스페이스는 선언 범위를 따르고 기본 네임스페이스도 해석한다", () => {
  const text = '<a xmlns="urn:one"><b xmlns="urn:two"><c/></b><d/><e xmlns=""><f/></e></a>';
  const root = buildTree(text, tokenize(text));
  const by = (name: string) => [...walkElements(root)].find((e) => e.local === name) as XElement;
  assert.equal(by("a").ns, "urn:one");
  assert.equal(by("b").ns, "urn:two");
  assert.equal(by("c").ns, "urn:two");
  assert.equal(by("d").ns, "urn:one", "b의 선언은 b 안에서만 유효하다");
  assert.equal(by("f").ns, "", "빈 기본 네임스페이스는 이름공간 없음");
  assert.equal(by("c").parent, by("b"));
});

test("4.2 텍스트 노드는 원문과 해독값을 함께 갖는다 (CDATA 포함)", () => {
  const text = "<a>x&amp;y<![CDATA[<&>]]>z</a>";
  const root = buildTree(text, tokenize(text));
  const kids = root.children;
  assert.equal(kids.length, 3);
  assert.deepEqual(
    kids.map((k) => ("raw" in k ? [k.raw, k.value] : null)),
    [
      ["x&amp;y", "x&y"],
      ["<![CDATA[<&>]]>", "<&>"],
      ["z", "z"],
    ],
  );
});
