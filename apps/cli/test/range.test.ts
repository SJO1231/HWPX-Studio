// fragment import --range와 fill --template의 range 앵커(7.10). 시험은 임시 폴더의 사본으로만 한다(fixtures는 읽기만 한다).
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { makeRangeAnchor, openPackage, parseDocument } from "../../../packages/hwpx-engine/src/index.ts";

const FIXTURES = fileURLToPath(new URL("../../../packages/hwpx-engine/test/fixtures/", import.meta.url));

let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "hwpx-cli-range-"));
  for (const name of ["hancom/blocks", "tables/tables-rich", "merge/merge-fields"]) copyFileSync(join(FIXTURES, `${name}.hwpx`), join(dir, `${name.replace("/", "-")}.hwpx`));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const p = (name: string): string => join(dir, name);
const texts = (name: string): string[] => parseDocument(openPackage(new Uint8Array(readFileSync(p(name))))).sections[0]?.paragraphs.map((x) => x.logicalText) ?? [];

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { log: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("fragment import --range: 범위의 문단들을 조각으로 바꾸고(종료 코드 0) 보고서에 이동표를 쓴다", async () => {
  const frag = p("rich.json");
  assert.equal((await cli("fragment", "extract", p("tables-tables-rich.hwpx"), "--section", "0", "--from", "1", "--to", "2", "-o", frag)).code, 0);
  const beforeTexts = texts("hancom-blocks.hwpx");
  const r = await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, "--range", "0:2-4", "-o", p("out.hwpx"), "--report", p("out.json"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(texts("out.hwpx"), [...beforeTexts.slice(0, 2), ...texts("tables-tables-rich.hwpx").slice(1, 3), ...beforeTexts.slice(5)]);
  const saved = JSON.parse(readFileSync(p("out.json"), "utf8")) as { ok: boolean; report: { plan: { moves: unknown[] } } };
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.report.plan.moves, [{ sectionIndex: 0, parentPath: [], from: 2, to: 4, count: 2, delta: -1 }]);

  // 표 칸 안(하위 목록)의 범위: --parent로 목록을 고른다
  const cell = await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, "--parent", "4.0", "--range", "0:0-0", "-o", p("cell.hwpx"));
  assert.equal(cell.code, 0, cell.err);
  const cellDoc = parseDocument(openPackage(new Uint8Array(readFileSync(p("cell.hwpx")))));
  assert.equal(cellDoc.sections[0]?.paragraphs[4]?.subLists[0]?.paragraphs.length, 2);
});

test("fragment import --range: 형식 오류·없는 범위·다른 위치 옵션과 함께 쓰면 사용법 오류(2), 구역 설정 문단이 든 범위는 게이트 실패(1). 출력 파일 없음", async () => {
  const frag = p("rich2.json");
  assert.equal((await cli("fragment", "extract", p("tables-tables-rich.hwpx"), "--section", "0", "--from", "1", "--to", "1", "-o", frag)).code, 0);
  const target = p("hancom-blocks.hwpx");
  const usage: string[][] = [
    ["--range", "0:4-3"],
    ["--range", "0-3"],
    ["--range", "0:3"],
    ["--range", "0:3-9"],
    ["--range", "1:0-0"],
    ["--range", "0:1-2", "--section", "0"],
    ["--range", "0:1-2", "--index", "1"],
    ["--range", "0:1-2", "--before"],
    ["--parent", "9.0", "--range", "0:0-0"],
  ];
  for (const [k, extra] of usage.entries()) {
    const out = p(`bad${k}.hwpx`);
    const r = await cli("fragment", "import", target, frag, ...extra, "-o", out);
    assert.equal(r.code, 2, `${extra.join(" ")}: ${r.err}`);
    assert.ok(!existsSync(out));
  }
  const secPr = await cli("fragment", "import", target, frag, "--range", "0:0-1", "-o", p("secpr.hwpx"));
  assert.equal(secPr.code, 1);
  assert.match(secPr.err + secPr.out, /FILL_SECTION_PROPS/);
  assert.ok(!existsSync(p("secpr.hwpx")));
});

test("fill --template: range 앵커 템플릿(조각 교체·삭제·글 교체·표 칸 안 범위)을 읽어 채우고 보고서에 이동표를 쓴다", async () => {
  assert.equal((await cli("fragment", "extract", p("tables-tables-rich.hwpx"), "--section", "0", "--from", "1", "--to", "1", "-o", p("rich-frag.json"))).code, 0);
  const input = p("merge-merge-fields.hwpx");
  const doc = parseDocument(openPackage(new Uint8Array(readFileSync(input))));
  const anchor = (id: string, from: number, to: number, parentPath: number[] = []) => ({ id, ...makeRangeAnchor(doc, 0, parentPath, from, to) });
  const template = {
    schema: "hwpx-studio/template@1",
    anchors: [anchor("a", 1, 3), anchor("b", 9, 11), anchor("c", 13, 14), anchor("d", 0, 0, [12, 1])],
    rules: [
      { id: "C", do: { type: "insertText", anchor: "c", position: "replace", value: { text: "새 글 1\n새 글 2" }, style: "inherit" } },
      { id: "A", do: { type: "inject", anchor: "a", position: "replace", fragment: "rich-frag.json" } },
      { id: "B", do: { type: "delete", anchor: "b" } },
      { id: "D", do: { type: "insertText", anchor: "d", position: "replace", value: { text: "칸 글" }, style: "inherit" } },
    ],
  };
  writeFileSync(p("range-template.json"), JSON.stringify(template));
  writeFileSync(p("empty.json"), "{}");
  const before = texts("merge-merge-fields.hwpx");
  const r = await cli("fill", input, "--data", p("empty.json"), "--template", p("range-template.json"), "--missing", "keep", "-o", p("filled.hwpx"), "--report", p("filled.json"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(texts("filled.hwpx"), [before[0], ...texts("tables-tables-rich.hwpx").slice(1, 2), ...before.slice(4, 9), before[12], "새 글 1", "새 글 2", ...before.slice(15)]);
  const out = parseDocument(openPackage(new Uint8Array(readFileSync(p("filled.hwpx")))));
  assert.deepEqual(out.sections[0]?.paragraphs[7]?.subLists[1]?.paragraphs.map((x) => x.logicalText), ["칸 글"]);
  const saved = JSON.parse(readFileSync(p("filled.json"), "utf8")) as { ok: boolean; report: { plan: { moves: unknown[] } } };
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.report.plan.moves, [
    { sectionIndex: 0, parentPath: [], from: 1, to: 3, count: 1, delta: -2 },
    { sectionIndex: 0, parentPath: [], from: 9, to: 11, count: 0, delta: -3 },
    { sectionIndex: 0, parentPath: [12, 1], from: 0, to: 0, count: 1, delta: 0 },
    { sectionIndex: 0, parentPath: [], from: 13, to: 14, count: 2, delta: 0 },
  ]);

  // 읽기 오류(지문의 문단 수가 범위와 다름, range에 fill)는 사용법·입력 오류(2), 겹치는 교체·삭제는 계획 오류(1). 출력 파일 없음
  const cases: { name: string; change: (t: typeof template) => unknown; code: number; pattern: RegExp }[] = [
    { name: "count", change: (t) => ({ ...t, anchors: [{ ...t.anchors[0], to: 4 }, ...t.anchors.slice(1)] }), code: 2, pattern: /TPL_ANCHOR/ },
    { name: "fill", change: (t) => ({ ...t, rules: [{ id: "F", do: { type: "fill", anchor: "a", value: { text: "x" } } }] }), code: 2, pattern: /TPL_RULE/ },
    { name: "overlap", change: (t) => ({ ...t, anchors: [...t.anchors, anchor("e", 3, 5)], rules: [...t.rules, { id: "E", do: { type: "delete", anchor: "e" } }] }), code: 1, pattern: /TPL_CONFLICT/ },
  ];
  for (const c of cases) {
    writeFileSync(p(`bad-${c.name}.json`), JSON.stringify(c.change(template)));
    const bad = await cli("fill", input, "--data", p("empty.json"), "--template", p(`bad-${c.name}.json`), "--missing", "keep", "-o", p(`bad-${c.name}.hwpx`));
    assert.equal(bad.code, c.code, `${c.name}: ${bad.err}`);
    assert.match(bad.err + bad.out, c.pattern);
    assert.ok(!existsSync(p(`bad-${c.name}.hwpx`)));
  }
});
