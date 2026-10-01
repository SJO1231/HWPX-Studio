// CLI `hwpx table list|set` (종료 코드 0/1/2, 출력 덮어쓰기 금지, 게이트 보고서). 시험은 임시 폴더의 사본으로만 한다.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../../../apps/cli/src/cli.ts";
import { listTables, openPackage, parseDocument, validateDocument } from "../src/index.ts";
import { docOf, gridTable, tableParagraph, textPara, tableXml, paragraph, type TableSpec } from "./table-helpers.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "hwpx-table-cli-"));
  for (const name of ["hancom/blocks", "D2", "D4"]) copyFileSync(join(FIXTURES, `${name}.hwpx`), join(dir, `${name.replace("/", "-")}.hwpx`));
  const nested = gridTable([1000], 1, [["안"]], { id: "6001" });
  const outer: TableSpec = { id: "5001", rowCnt: 1, colCnt: 1, cells: [{ row: 0, col: 0, width: 5000, height: 600, paragraphs: [textPara("앞"), paragraph(`${tableXml(nested)}<hp:t/>`)] }] };
  writeFileSync(join(dir, "nested.hwpx"), docOf([textPara("제목"), tableParagraph(outer)]));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const p = (name: string): string => join(dir, name);
const listing = (): string[] => readdirSync(dir).sort();
const doc = (name: string) => parseDocument(openPackage(new Uint8Array(readFileSync(p(name)))));

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { log: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("table list: 표마다 위치·행×열·너비·글자처럼 취급·쪽 나눔·제목 행 반복·병합 수를 낸다(글 내용은 없다)", async () => {
  const r = await cli("table", "list", p("hancom-blocks.hwpx"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /표 1개/);
  assert.match(r.out, /0:0 +위치 \[4\] 3행×3열, 너비 41952, 글자처럼 취급 아니오, 쪽 나눔 CELL, 제목 행 반복 예, 병합 셀 0개/);
  assert.ok(!/구분|내용|비고/.test(r.out), "표 안 글을 출력하지 않는다");

  const j = await cli("table", "list", p("D2.hwpx"), "--json");
  assert.equal(j.code, 0);
  const rows = JSON.parse(j.out) as { section: number; ordinal: number | null; rowCnt: number; colCnt: number; treatAsChar: boolean; mergedCells: number; depth: number }[];
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.slice(0, 2).map((x) => [x.section, x.ordinal, x.rowCnt, x.colCnt, x.treatAsChar, x.mergedCells]), [[0, 0, 3, 3, true, 3], [0, 1, 1, 7, true, 0]]);
  assert.ok(!j.out.includes("텍스트") && !/"text"/.test(j.out));

  // 중첩 표는 순번이 null(설정 대상 아님)로 나온다
  const n = JSON.parse((await cli("table", "list", p("nested.hwpx"), "--json")).out) as { ordinal: number | null; depth: number }[];
  assert.deepEqual(n.map((x) => [x.ordinal, x.depth]), [[0, 0], [null, 1]]);
  assert.match((await cli("table", "list", p("nested.hwpx"))).out, /중첩 깊이 1, 설정 대상 아님/);
});

test("table set: 설정과 크기를 게이트를 거쳐 적용하고 출력과 보고서를 쓴다(종료 코드 0)", async () => {
  const r = await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0:0", "--treat-as-char", "on", "--page-break", "none", "--repeat-header", "off", "--scale", "0.5", "-o", p("set1.hwpx"), "--report", p("set1.json"));
  assert.equal(r.code, 0, r.err);
  const t = listTables(doc("set1.hwpx"))[0];
  assert.equal(t?.treatAsChar, true);
  assert.equal(t?.pageBreak, "NONE");
  assert.equal(t?.repeatHeader, false);
  assert.equal(t?.width, 20976);
  assert.equal(validateDocument(new Uint8Array(readFileSync(p("set1.hwpx")))).errors.length, 0);
  const report = JSON.parse(readFileSync(p("set1.json"), "utf8")) as { ok: boolean; report: { plan: { actions: { type: string; targets: number }[] }; mode: string }; ledger: { output: { sha256: string } } };
  assert.equal(report.ok, true);
  assert.deepEqual(report.report.plan.actions.map((a) => [a.type, a.targets]), [["tableProps", 1], ["resize", 1]]);
  assert.equal(report.report.mode, "baseline");
  assert.match(report.ledger.output.sha256, /^[0-9a-f]{64}$/);

  // 열 너비 지정, 너비 지정
  const cols = await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0:0", "--columns", "10000,10000,10000", "-o", p("set2.hwpx"));
  assert.equal(cols.code, 0, cols.err);
  assert.equal(listTables(doc("set2.hwpx"))[0]?.width, 30000);
  const width = await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0:0", "--width", "9001", "-o", p("set3.hwpx"), "--mode", "strict");
  assert.equal(width.code, 0, width.err);
  assert.equal(listTables(doc("set3.hwpx"))[0]?.width, 9001);
  // 같은 입력은 같은 출력
  const again = await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0:0", "--width", "9001", "-o", p("set3b.hwpx"), "--mode", "strict");
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(readFileSync(p("set3b.hwpx")), readFileSync(p("set3.hwpx")));
});

test("table set: 게이트 실패는 종료 코드 1이고 출력 파일이 없다. 보고서는 쓴다", async () => {
  const before = listing();
  const r = await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0:0", "--columns", "1,2", "-o", p("bad.hwpx"), "--report", p("bad.json"));
  assert.equal(r.code, 1);
  assert.match(r.err, /TABLE_BAD_ARG/);
  assert.ok(!existsSync(p("bad.hwpx")));
  const report = JSON.parse(readFileSync(p("bad.json"), "utf8")) as { ok: boolean; report: { issues: { code: string }[] } };
  assert.equal(report.ok, false);
  assert.ok(report.report.issues.some((i) => i.code === "TABLE_BAD_ARG"));
  assert.deepEqual(listing(), [...before, "bad.json"].sort());

  // 불규칙 표(D4 #4)는 TABLE_IRREGULAR
  const irregular = listTables(doc("D4.hwpx")).find((x) => !x.regular);
  const ir = await cli("table", "set", p("D4.hwpx"), "--table", `0:${irregular?.topOrdinal}`, "--scale", "2", "-o", p("irr.hwpx"));
  assert.equal(ir.code, 1);
  assert.match(ir.err, /TABLE_IRREGULAR/);
  assert.ok(!existsSync(p("irr.hwpx")));
});

test("table set: 사용법 오류와 읽을 수 없는 입력은 종료 코드 2다", async () => {
  const base = ["table", "set", p("hancom-blocks.hwpx"), "--table", "0:0", "-o", p("usage.hwpx")];
  const codes = async (...extra: string[]): Promise<number> => (await cli(...base, ...extra)).code;
  assert.equal(await codes(), 2, "바꿀 설정이 없다");
  assert.equal(await codes("--treat-as-char", "maybe"), 2);
  assert.equal(await codes("--page-break", "always"), 2);
  assert.equal(await codes("--repeat-header", "1"), 2);
  assert.equal(await codes("--width", "10", "--scale", "2"), 2, "크기 지정은 하나만");
  assert.equal(await codes("--width", "10", "--columns", "1,2,3"), 2);
  assert.equal(await codes("--width", "-5"), 2);
  assert.equal(await codes("--width", "1.5"), 2);
  assert.equal(await codes("--scale", "0"), 2);
  assert.equal(await codes("--scale", "abc"), 2);
  assert.equal(await codes("--columns", "1,x,3"), 2);
  assert.equal(await codes("--treat-as-char", "on", "--mode", "fast"), 2);
  assert.equal((await cli("table", "set", p("hancom-blocks.hwpx"), "--treat-as-char", "on", "-o", p("usage.hwpx"))).code, 2, "--table이 필요하다");
  assert.equal((await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0", "--treat-as-char", "on", "-o", p("usage.hwpx"))).code, 2, "구역:순번 꼴");
  assert.equal((await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0:5", "--treat-as-char", "on", "-o", p("usage.hwpx"))).code, 2, "없는 표");
  assert.equal((await cli("table", "set", p("nested.hwpx"), "--table", "0:1", "--treat-as-char", "on", "-o", p("usage.hwpx"))).code, 2, "중첩 표는 지정할 수 없다");
  assert.equal((await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0:0", "--treat-as-char", "on")).code, 2, "-o가 필요하다");
  assert.equal((await cli("table", "set", p("missing.hwpx"), "--table", "0:0", "--treat-as-char", "on", "-o", p("usage.hwpx"))).code, 2, "없는 파일");
  assert.equal((await cli("table", "set", p("notes.md"), "--table", "0:0", "--treat-as-char", "on", "-o", p("usage.hwpx"))).code, 2, "md는 받지 않는다");
  assert.equal((await cli("table", "list")).code, 2);
  assert.equal((await cli("table", "list", p("missing.hwpx"))).code, 2);
  assert.equal((await cli("table", "sort", p("hancom-blocks.hwpx"))).code, 2);
  assert.equal((await cli("table")).code, 2);
  assert.ok(!existsSync(p("usage.hwpx")));
});

test("table set: 출력이 입력과 같거나 이미 있으면 거부하고(--overwrite 없이) 입력은 그대로다", async () => {
  const input = p("hancom-blocks.hwpx");
  const original = readFileSync(input);
  assert.equal((await cli("table", "set", input, "--table", "0:0", "--treat-as-char", "on", "-o", input, "--overwrite")).code, 2, "입력과 같은 경로");
  assert.deepEqual(readFileSync(input), original);
  assert.equal((await cli("table", "set", input, "--table", "0:0", "--treat-as-char", "on", "-o", p("set1.hwpx"))).code, 2, "이미 있는 출력");
  assert.equal((await cli("table", "set", input, "--table", "0:0", "--treat-as-char", "off", "-o", p("set1.hwpx"), "--overwrite")).code, 0);
  assert.equal(listTables(doc("set1.hwpx"))[0]?.treatAsChar, false);
  // 보고서 경로가 입력이나 출력과 같으면 거부
  assert.equal((await cli("table", "set", input, "--table", "0:0", "--treat-as-char", "on", "-o", p("r.hwpx"), "--report", p("r.hwpx"))).code, 2);
  assert.ok(!existsSync(p("r.hwpx")));
  assert.deepEqual(readFileSync(input), original);
});

test("table set: 문서 안 {{}} 표기를 건드리지 않는다(데이터가 없어도 실패하지 않는다)", async () => {
  writeFileSync(p("ph.hwpx"), docOf([textPara("{{project.name}}"), tableParagraph(gridTable([2000, 2000], 1, [["{{a}}", "b"]]))]));
  const r = await cli("table", "set", p("ph.hwpx"), "--table", "0:0", "--treat-as-char", "on", "-o", p("ph-out.hwpx"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(doc("ph-out.hwpx").sections[0]?.paragraphs[0]?.logicalText, "{{project.name}}");
});

test("L2: table set의 잘못된 숫자 인자는 사용법 오류(종료 코드 2, 스택 없음, 출력 파일 없음)다 — 10진수만 받는다", async () => {
  const before = listing();
  const bad = async (...opts: string[]): Promise<void> => {
    const r = await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0:0", ...opts, "-o", p("l2.hwpx"));
    assert.equal(r.code, 2, `${opts.join(" ")}: 종료 코드 ${r.code}\n${r.err}`);
    assert.ok(!/내부 오류|\n\s+at /.test(r.err), `스택이 나오면 안 된다: ${r.err}`);
    assert.match(r.err, /--(width|columns|scale)/, opts.join(" "));
    assert.deepEqual(listing(), before, `${opts.join(" ")}: 출력 파일이 생기면 안 된다`);
  };
  await bad("--width", "0");
  await bad("--columns", "0,1,1");
  await bad("--columns", "1,0,1");
  await bad("--width", "0x10");
  await bad("--width", "1e3");
  await bad("--width", "1.5");
  await bad("--width", "-5");
  await bad("--columns", "0x2,1,1");
  await bad("--scale", "0x2");
  await bad("--scale", "1e3");
  await bad("--scale", "0");
  await bad("--scale", "-1");
  await bad("--scale", "abc");
  await bad("--scale", "");
  // 올바른 십진 값은 그대로 된다
  const ok = await cli("table", "set", p("hancom-blocks.hwpx"), "--table", "0:0", "--scale", ".5", "-o", p("l2-ok.hwpx"));
  assert.equal(ok.code, 0, ok.err);
});

test("H1(CLI): 행끼리 열 경계가 어긋난 표는 table list가 너비 불규칙으로 알리고(JSON은 structureRegular·widthRegular), --scale은 게이트가 막고 --columns는 된다", async () => {
  const spec: TableSpec = {
    id: "8101",
    rowCnt: 2,
    colCnt: 2,
    cells: [
      { row: 0, col: 0, width: 1000, height: 500, text: "a" },
      { row: 0, col: 1, width: 1000, height: 500, text: "b" },
      { row: 1, col: 0, width: 1200, height: 500, text: "c" },
      { row: 1, col: 1, width: 1000, height: 500, text: "d" },
    ],
  };
  writeFileSync(p("width-irregular.hwpx"), docOf([textPara("제목"), tableParagraph(spec)]));
  const list = await cli("table", "list", p("width-irregular.hwpx"));
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /너비 불규칙/);
  assert.ok(!/불규칙 격자/.test(list.out));
  const json = JSON.parse((await cli("table", "list", p("width-irregular.hwpx"), "--json")).out) as { regular: boolean; structureRegular: boolean; widthRegular: boolean }[];
  assert.deepEqual(json.map((x) => [x.regular, x.structureRegular, x.widthRegular]), [[false, true, false]]);
  const before = listing();
  const scale = await cli("table", "set", p("width-irregular.hwpx"), "--table", "0:0", "--scale", "2", "-o", p("wi-scale.hwpx"));
  assert.equal(scale.code, 1, scale.err + scale.out);
  assert.deepEqual(listing(), before, "게이트가 막으면 출력 파일이 없다");
  const columns = await cli("table", "set", p("width-irregular.hwpx"), "--table", "0:0", "--columns", "1500,2500", "-o", p("wi-columns.hwpx"));
  assert.equal(columns.code, 0, columns.err + columns.out);
  assert.equal(listTables(doc("wi-columns.hwpx"))[0]?.regular, true);
});
