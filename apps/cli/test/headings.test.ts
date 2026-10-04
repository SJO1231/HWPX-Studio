// headings 명령과 fill --template의 headingRange 앵커(7.10). 시험은 임시 폴더의 사본으로만 한다(fixtures는 읽기만 한다).
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { extractFragment, makeHeadingRangeAnchor, makeRangeAnchor, openPackage, parseDocument, serializeFragment } from "../../../packages/hwpx-engine/src/index.ts";

const FIXTURES = fileURLToPath(new URL("../../../packages/hwpx-engine/test/fixtures/", import.meta.url));

let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "hwpx-cli-headings-"));
  for (const name of ["hancom/blocks", "tables/tables-rich", "D4"]) copyFileSync(join(FIXTURES, `${name}.hwpx`), join(dir, `${name.replace("/", "-")}.hwpx`));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const p = (name: string): string => join(dir, name);
const docOf = (name: string) => parseDocument(openPackage(new Uint8Array(readFileSync(p(name)))));

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { log: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("headings: 제목마다 '구역:상위주소:문단 번호  단계  꼴  글 앞 40자' 한 줄(종료 코드 0), --json은 배열", async () => {
  // hancom/blocks: 최상위 '1. 개요'(문단 0, 앞에 구역 설정 개체 자리 글자 둘 — 출력에서는 뺀다), '2. 선택 조항'(2), '3. 끝'(5). 표 칸 안 글('가'·'나'·'-')은 번호 뒤 글이 없어 제목이 아니다
  const r = await cli("headings", p("hancom-blocks.hwpx"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.split("\n"), ["제목 3개", "  0:-:0  1  digitDot  1. 개요", "  0:-:2  1  digitDot  2. 선택 조항", "  0:-:5  1  digitDot  3. 끝"]);
  const j = await cli("headings", p("hancom-blocks.hwpx"), "--json");
  assert.equal(j.code, 0);
  const list = JSON.parse(j.out) as { at: { sectionIndex: number; parentPath: number[] }; index: number; marker: { form: string; level: number }; text: string }[];
  assert.equal(list[0]?.text, "1. 개요", "JSON의 text는 Heading.text 그대로(개체 자리 글자를 뺀 앞 40자)");
  assert.deepEqual(list.map((h) => [h.at.parentPath, h.index, h.marker.form, h.marker.level]), [[[], 0, "digitDot", 1], [[], 2, "digitDot", 1], [[], 5, "digitDot", 1]]);
  // 표 칸 안 제목: 상위 주소가 '문단.하위목록'. D4의 칸 [26, 0]은 'Ⅰ.'(로마 숫자, 1단계) 아래 '1.'(숫자+점, 2단계)
  const d4 = await cli("headings", p("D4.hwpx"));
  assert.equal(d4.code, 0);
  const d4Lines = d4.out.split("\n");
  assert.ok(d4Lines.some((l) => /^ {2}0:26\.0:1 {2}1 {2}roman {2}/.test(l)), d4.out);
  assert.ok(d4Lines.some((l) => /^ {2}0:26\.0:2 {2}2 {2}digitDot {2}/.test(l)), d4.out);
  // 탭이 든 제목 글은 공백으로 바꿔 한 줄을 지킨다(D4 문단 30은 '□' 뒤에 탭)
  assert.ok(d4Lines.includes("  0:-:30  1  box  □ 3개 부서 12명"), d4.out);
  assert.ok(d4Lines.every((l) => !l.includes(String.fromCharCode(9)) && !l.includes(String.fromCharCode(0xfffc))));
  // .md·없는 파일·인자 수는 사용법 오류(2)
  writeFileSync(p("x.md"), "# 제목\n");
  assert.equal((await cli("headings", p("x.md"))).code, 2);
  assert.equal((await cli("headings", p("none.hwpx"))).code, 2);
  assert.equal((await cli("headings")).code, 2);
});

test("fill --template: headingRange 앵커의 조각 교체가 같은 범위의 range 앵커와 같은 바이트(종료 코드 0)", async () => {
  const doc = docOf("hancom-blocks.hwpx");
  const heading = makeHeadingRangeAnchor(doc, 0, [], 2);
  assert.ok(heading !== undefined);
  // '2. 선택 조항'의 범위: 다음 같은 단계 제목 '3. 끝'(문단 5) 앞까지 — 사이의 표 문단 4 포함
  const range = makeRangeAnchor(doc, 0, [], 2, 4);
  assert.deepEqual(heading.print, range?.print);
  const rich = docOf("tables-tables-rich.hwpx");
  writeFileSync(p("frag.json"), serializeFragment(extractFragment(rich, { sectionIndex: 0, parentPath: [], from: 1, to: 1 })));
  writeFileSync(p("data.json"), "{}");
  const rules = [{ id: "x", do: { type: "inject", anchor: "a", position: "replace", fragment: "frag.json" } }];
  writeFileSync(p("h.json"), JSON.stringify({ schema: "hwpx-studio/template@1", anchors: [{ id: "a", ...heading }], rules, options: { missing: "keep" } }));
  writeFileSync(p("r.json"), JSON.stringify({ schema: "hwpx-studio/template@1", anchors: [{ id: "a", ...range }], rules, options: { missing: "keep" } }));
  const h = await cli("fill", p("hancom-blocks.hwpx"), "--data", p("data.json"), "--template", p("h.json"), "-o", p("h.hwpx"));
  const r = await cli("fill", p("hancom-blocks.hwpx"), "--data", p("data.json"), "--template", p("r.json"), "-o", p("r.hwpx"));
  assert.equal(h.code, 0, h.err);
  assert.equal(r.code, 0, r.err);
  assert.ok(Buffer.from(readFileSync(p("h.hwpx"))).equals(readFileSync(p("r.hwpx"))));
  assert.deepEqual(
    docOf("h.hwpx").sections[0]?.paragraphs.map((x) => x.logicalText),
    [...doc.sections[0]!.paragraphs.slice(0, 2).map((x) => x.logicalText), rich.sections[0]!.paragraphs[1]!.logicalText, doc.sections[0]!.paragraphs[5]!.logicalText],
  );
});
