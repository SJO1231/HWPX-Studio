// 과업 C CLI: 여러 문단에 걸친 누름틀을 채우면 문단을 합친 사실을 `경고 [FIELD_PARAGRAPHS_MERGED] …` 줄로 알린다.
// 단건 fill은 보고의 경고를 그대로 내고, --batch는 성공한 건마다 `  경고 [코드] 메시지` 줄을 낸다. 경고는 종료 코드를 바꾸지 않는다.
// 기대값은 과업 명세 C3에서 만들었다(한컴이 저장한 span 시험 문서를 쓴다).
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { listFields, openPackage, parseDocument } from "../../../packages/hwpx-engine/src/index.ts";

const FIXTURES = fileURLToPath(new URL("../../../packages/hwpx-engine/test/fixtures/", import.meta.url));
const MESSAGE = "누름틀 성명이 걸친 문단 3개를 합쳤고 사이의 문단 1개를 지웠습니다(그 안의 표 0개 포함).";

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "hwpx-span-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function workspace(fixture: string): { dir: string; p: (name: string) => string; json: (name: string, value: unknown) => string } {
  const dir = join(root, `w${counter++}`);
  mkdirSync(join(dir, "out"), { recursive: true });
  copyFileSync(join(FIXTURES, `${fixture}.hwpx`), join(dir, "form.hwpx"));
  return {
    dir,
    p: (name) => join(dir, name),
    json: (name, value) => {
      writeFileSync(join(dir, name), JSON.stringify(value));
      return join(dir, name);
    },
  };
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { log: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const load = (file: string) => parseDocument(openPackage(new Uint8Array(readFileSync(file))));
const topTexts = (file: string): string[] => (load(file).sections[0]?.paragraphs ?? []).map((p) => p.logicalText.replaceAll("\uFFFC", ""));

test("C3 CLI fill 단건: 여러 문단에 걸친 누름틀을 채우고(종료 코드 0) 경고 줄로 합친 문단 수를 알린다. 값 원문은 화면에 없다", async () => {
  const w = workspace("span/field-span");
  const r = await cli("fill", w.p("form.hwpx"), "--data", w.json("d.json", { 성명: "새 값" }), "-o", w.p("out/a.hwpx"));
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.split("\n").includes(`경고 [FIELD_PARAGRAPHS_MERGED] ${MESSAGE}`), r.out);
  assert.deepEqual(topTexts(w.p("out/a.hwpx")), ["앞 문단", "성명: 새 값 끝 뒤 글", "뒤 문단"]);
  assert.deepEqual(listFields(load(w.p("out/a.hwpx"))).map((f) => [f.name, f.valueText, f.shape]), [["성명", "새 값", "simple"]]);
  assert.ok(!r.out.includes("새 값"));
});

test("C3 CLI fill --batch: 성공한 건마다 `  경고 [코드] 메시지` 줄이 나오고 종료 코드는 그대로다. 실패한 건과 경고가 없는 문서는 경고 줄이 없다", async () => {
  const w = workspace("span/field-span");
  const data = w.json("list.json", [{ 성명: "가" }, { 성명: "나" }]);
  const r = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("out"));
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("성공 001 "));
  assert.ok(at >= 0);
  assert.equal(lines[at + 1], `  경고 [FIELD_PARAGRAPHS_MERGED] ${MESSAGE}`);
  const second = lines.findIndex((l) => l.startsWith("성공 002 "));
  assert.equal(lines[second + 1], `  경고 [FIELD_PARAGRAPHS_MERGED] ${MESSAGE}`);
  assert.deepEqual(topTexts(join(w.dir, "out", "form-001.hwpx")), ["앞 문단", "성명: 가 끝 뒤 글", "뒤 문단"]);
  assert.deepEqual(topTexts(join(w.dir, "out", "form-002.hwpx")), ["앞 문단", "성명: 나 끝 뒤 글", "뒤 문단"]);

  // 한 건이 실패해도 나머지는 만들고(종료 코드 1), 실패한 건에는 경고 줄이 없다
  const mixed = w.json("mixed.json", [{ 성명: "다" }, {}]);
  const m = await cli("fill", w.p("form.hwpx"), "--data", mixed, "--batch", "-o", w.p("out"), "--overwrite");
  assert.equal(m.code, 1);
  assert.equal(m.out.split("\n").filter((l) => l.includes("경고 [")).length, 1);
  assert.ok(existsSync(join(w.dir, "out", "form-001.hwpx")));

  // 경고가 없는 문서(한 문단 안 누름틀)는 경고 줄이 없다
  const plain = workspace("hancom-field");
  const p = await cli("fill", plain.p("form.hwpx"), "--data", plain.json("d.json", [{ 성명: "가" }]), "--batch", "-o", plain.p("out"));
  assert.equal(p.code, 0, p.err);
  assert.ok(!p.out.includes("경고 ["), p.out);
});

test("C3 CLI fill --batch --report: items[]에 warnings(코드·메시지·anchor)가 있고, 경고가 없는 건과 실패한 건은 빈 배열이다. 값 원문은 없다", async () => {
  const w = workspace("span/field-span");
  const report = w.p("report.json");
  const data = w.json("list.json", [{ 성명: "가나다" }, {}]);
  const r = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("out"), "--report", report);
  assert.equal(r.code, 1, "두 번째 건이 데이터 부족으로 실패");
  const body = JSON.parse(readFileSync(report, "utf8")) as { items: { index: number; ok: boolean; warnings: { code: string; message: string; anchor?: string }[] }[] };
  assert.deepEqual(body.items.map((i) => [i.index, i.ok, i.warnings]), [
    [1, true, [{ code: "FIELD_PARAGRAPHS_MERGED", message: MESSAGE, anchor: "field:성명" }]],
    [2, false, []],
  ]);
  assert.ok(!readFileSync(report, "utf8").includes("가나다"));
  // 경고가 없는 문서는 모든 건이 빈 배열이다
  const plain = workspace("hancom-field");
  const pr = plain.p("report.json");
  assert.equal((await cli("fill", plain.p("form.hwpx"), "--data", plain.json("d.json", [{ 성명: "가" }]), "--batch", "-o", plain.p("out"), "--report", pr)).code, 0);
  assert.deepEqual((JSON.parse(readFileSync(pr, "utf8")) as { items: { warnings: unknown[] }[] }).items.map((i) => i.warnings), [[]]);
});
