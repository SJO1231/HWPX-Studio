// CLI fill: 누름틀 암묵 채움(템플릿 없이 이름 = 데이터 경로)과 채운 자리 0건(FILL_NOTHING_APPLIED, 종료 코드 1, 출력 없음).
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { listFields, openPackage, parseDocument } from "../../../packages/hwpx-engine/src/index.ts";

const FIXTURES = fileURLToPath(new URL("../../../packages/hwpx-engine/test/fixtures/", import.meta.url));
let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "hwpx-implicit-"));
  mkdirSync(join(dir, "out"));
  copyFileSync(join(FIXTURES, "hancom", "field-states.hwpx"), join(dir, "fields.hwpx"));
  copyFileSync(join(FIXTURES, "hancom", "blocks.hwpx"), join(dir, "blocks.hwpx"));
  copyFileSync(join(FIXTURES, "hancom", "ph-single.hwpx"), join(dir, "form.hwpx"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const p = (name: string): string => join(dir, name);
const json = (name: string, value: unknown): string => {
  writeFileSync(p(name), JSON.stringify(value));
  return p(name);
};
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { log: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const fieldValues = (file: string): string[] => listFields(parseDocument(openPackage(new Uint8Array(readFileSync(file))))).map((f) => f.valueText);

test("fill: 템플릿 없이 누름틀을 이름 = 데이터 경로로 채운다(줄바꿈 값 포함, 종료 코드 0)", async () => {
  const data = json("d1.json", { 성명: "홍\n길동", 소속: "기관" });
  const r = await cli("fill", p("fields.hwpx"), "--data", data, "-o", p("out/f1.hwpx"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fieldValues(p("out/f1.hwpx")), ["홍\n길동", "기관", "홍\n길동"]);
  assert.match(r.out, /액션 2개/);
  assert.ok(!r.out.includes("길동"), "값 원문이 화면에 없다");
});

test("fill: 데이터에 없는 누름틀 이름은 DATA_MISSING(종료 코드 1, 출력 없음), --missing keep이면 그대로 둔다", async () => {
  const data = json("d2.json", { 성명: "홍" });
  const missing = await cli("fill", p("fields.hwpx"), "--data", data, "-o", p("out/f2.hwpx"));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /DATA_MISSING\] 누름틀 소속/);
  assert.ok(!existsSync(p("out/f2.hwpx")));
  const keep = await cli("fill", p("fields.hwpx"), "--data", data, "-o", p("out/f2k.hwpx"), "--missing", "keep");
  assert.equal(keep.code, 0, keep.err);
  assert.deepEqual(fieldValues(p("out/f2k.hwpx")), ["홍", "합성기관", "홍"]);
});

test("fill: 채운 자리가 0건이면 FILL_NOTHING_APPLIED로 종료 코드 1이고 출력 파일이 없다(보고서는 쓴다, 모의 실행도 1)", async () => {
  const data = json("d3.json", { 관계없는: "키" });
  const report = p("nothing-report.json");
  const r = await cli("fill", p("blocks.hwpx"), "--data", data, "-o", p("out/n.hwpx"), "--report", report);
  assert.equal(r.code, 1);
  assert.match(r.err, /FILL_NOTHING_APPLIED/);
  assert.ok(!existsSync(p("out/n.hwpx")));
  const saved = JSON.parse(readFileSync(report, "utf8")) as { ok: boolean; report: { issues: { code: string }[] } };
  assert.equal(saved.ok, false);
  assert.ok(saved.report.issues.some((i) => i.code === "FILL_NOTHING_APPLIED"));
  assert.equal((await cli("fill", p("blocks.hwpx"), "--data", data, "--dry-run")).code, 1);
  assert.deepEqual(readdirSync(p("out")).filter((n) => n.startsWith("n.")), []);
});

test("fill --batch: 채운 자리가 0건인 건만 실패로 세고(종료 코드 1) 나머지는 만든다", async () => {
  const data = json("d4.json", [
    { project: { name: "가", start: "S", end: "E" } },
    { 다른: "키" },
    { project: { name: "나", start: "S", end: "E" } },
  ]);
  const r = await cli("fill", p("form.hwpx"), "--data", data, "--batch", "--missing", "keep", "-o", p("out"));
  assert.equal(r.code, 1);
  assert.match(r.err, /실패 002 form-002\.hwpx/);
  assert.match(r.err, /FILL_NOTHING_APPLIED/);
  assert.deepEqual(readdirSync(p("out")).filter((n) => n.startsWith("form-")).sort(), ["form-001.hwpx", "form-003.hwpx"]);
});

test("fill .md·.txt는 그대로 — 채울 {{}}가 없어도 원문 그대로 저장한다(종료 코드 0)", async () => {
  writeFileSync(p("plain.txt"), "그냥 글\n둘째 줄\n");
  const r = await cli("fill", p("plain.txt"), "--data", json("d5.json", { a: 1 }), "-o", p("out/plain-out.txt"));
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(p("out/plain-out.txt"), "utf8"), "그냥 글\n둘째 줄\n");
});
