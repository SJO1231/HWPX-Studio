// CLI: 메일 머지 필드(MAILMERGE) — inspect가 종류·키를 보이고, fill이 키 = 데이터 경로로 채우며(--dry-run의 필요한 경로에 키 포함), compile --merge-fields가 필드를 {{키}}나 누름틀로 바꾼다.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { listFields, openPackage, parseDocument, walkParagraphs } from "../../../packages/hwpx-engine/src/index.ts";

const FIXTURES = fileURLToPath(new URL("../../../packages/hwpx-engine/test/fixtures/", import.meta.url));
let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "hwpx-merge-"));
  mkdirSync(join(dir, "out"));
  copyFileSync(join(FIXTURES, "merge", "merge-fields.hwpx"), join(dir, "merge.hwpx"));
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
const docOf = (file: string) => parseDocument(openPackage(new Uint8Array(readFileSync(file))));
const OBJ = "￼";
const textsOf = (file: string): string[] => docOf(file).sections.flatMap((s) => [...walkParagraphs(s.paragraphs)].map((q) => q.logicalText.replaceAll(OBJ, "")));

const DATA = {
  사업명: "합성 사업", 기관명: "합성기관", 담당자: "홍길동", 연락처: "02-000-0000", 공고번호: "제2026-0001호", 시행일: "2026-10-04", 접수기간: "2026-10-04 ~ 2026-10-18",
  추정가격: "1,234,500원", 장소: "서울 본관\n3층\t대회의실 & <b>", 예정가격: "1,111,000원", 부가세: "123,450", 재공고: "해당 없음",
  성명: "홍길동", 소속: "기관", 이름: "김철수", 직위: "과장",
  project: { name: "합성 과제", start: "2026-10-04", end: "2026-12-31" }, dates: { start: "2026-10-04", end: "2026-10-18", days: "15" }, manager: { phone: "010-0000-0000", email: "a@example.test" },
};

test("inspect: 필드 목록에 종류(메일머지·누름틀)와 키가 나온다(--json은 type·mergeKey). 값 원문은 없고 길이만", async () => {
  const text = await cli("inspect", p("merge.hwpx"));
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /누름틀·필드 37개/);
  assert.equal([...text.out.matchAll(/\n {2}- \[메일머지\] /g)].length, 33);
  assert.equal([...text.out.matchAll(/\n {2}- \[누름틀\] /g)].length, 4);
  assert.match(text.out, /\[메일머지\] 사업명\[0\] \S+, dirty=0, 값 길이 \d+/);
  assert.match(text.out, /\[메일머지\] 참고 사항\[1\] /, "경로 꼴이 아닌 키도 키로 보인다");
  assert.match(text.out, /\[누름틀\] 성명\[0\] /);
  const j = JSON.parse((await cli("inspect", p("merge.hwpx"), "--json")).out) as { fields: { name: string; type: string; mergeKey?: string; occurrence: number }[] };
  assert.equal(j.fields.filter((f) => f.type === "MAILMERGE").length, 33);
  assert.ok(j.fields.filter((f) => f.type === "MAILMERGE").every((f) => f.name === "" && typeof f.mergeKey === "string"));
  assert.ok(j.fields.filter((f) => f.type === "CLICK_HERE").every((f) => f.mergeKey === undefined));
  assert.deepEqual(j.fields.filter((f) => f.mergeKey === "사업명").map((f) => f.occurrence), [0, 1, 2, 3]);
});

test("fill --dry-run: 필요한 데이터 경로에 메일 머지 키가 들어 있고 건너뜀(MERGE_KEY_NOT_PATH)이 보인다. 파일은 만들지 않는다", async () => {
  const data = json("d1.json", DATA);
  const r = await cli("fill", p("merge.hwpx"), "--data", data, "--dry-run");
  assert.equal(r.code, 0, r.err);
  const line = r.out.split("\n").find((l) => l.startsWith("필요한 데이터 경로:")) ?? "";
  for (const key of ["사업명", "추정가격", "공고번호", "담당자", "연락처"]) assert.ok(line.includes(key), `${key} ∈ ${line}`);
  assert.ok(line.includes("project.name") && line.includes("성명"), "누름틀 이름과 {{}} 경로도 함께");
  assert.equal([...r.out.matchAll(/건너뜀 \[MERGE_KEY_NOT_PATH\]/g)].length, 4);
  assert.match(r.out, /건너뜀 \[MERGE_KEY_NOT_PATH\] implicit merge:참고 사항: 메일 머지 필드의 키 '참고 사항'/);
  assert.match(r.out, /액션 \d+개, 건너뜀 4, 버림 \d+/);
  assert.ok(!r.out.includes("합성기관") && !r.out.includes("1,234,500"), "값 원문이 화면에 없다");
  assert.deepEqual(readdirSync(p("out")), []);
});

test("fill: 메일 머지 필드를 키 = 데이터 경로로 채운다(긴 값·줄바꿈 포함, 종료 코드 0). 필드 수·키는 그대로이고 값 원문이 화면에 없다", async () => {
  const data = json("d2.json", DATA);
  const r = await cli("fill", p("merge.hwpx"), "--data", data, "-o", p("out/f1.hwpx"));
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(p("out/f1.hwpx")));
  const fields = listFields(docOf(p("out/f1.hwpx")));
  assert.equal(fields.filter((f) => f.type === "MAILMERGE").length, 33);
  assert.deepEqual(fields.filter((f) => f.mergeKey === "사업명").map((f) => f.valueText), ["합성 사업", "합성 사업", "합성 사업", "합성 사업"]);
  assert.deepEqual(fields.filter((f) => f.mergeKey === "장소").map((f) => f.valueText), ["서울 본관\n3층\t대회의실 & <b>", "서울 본관\n3층\t대회의실 & <b>"]);
  assert.ok(fields.filter((f) => f.type === "MAILMERGE" && f.mergeKey !== undefined && !/^[\p{L}\p{N}_-]+$/u.test(f.mergeKey)).every((f) => f.dirty === "0"), "경로 꼴이 아닌 키의 필드는 그대로");
  assert.match(r.out, /액션 \d+개, 건너뜀 4/);
  assert.ok(!r.out.includes("합성 사업") && !r.err.includes("합성 사업"));
  // 같은 입력은 같은 바이트
  assert.equal((await cli("fill", p("merge.hwpx"), "--data", data, "-o", p("out/f1b.hwpx"))).code, 0);
  assert.ok(readFileSync(p("out/f1.hwpx")).equals(readFileSync(p("out/f1b.hwpx"))));
  // 다시 채운다(다른 값)
  const again = json("d2b.json", { ...DATA, 사업명: "다른 사업" });
  assert.equal((await cli("fill", p("out/f1.hwpx"), "--data", again, "-o", p("out/f2.hwpx"))).code, 0);
  assert.deepEqual(listFields(docOf(p("out/f2.hwpx"))).filter((f) => f.mergeKey === "사업명").map((f) => f.valueText), ["다른 사업", "다른 사업", "다른 사업", "다른 사업"]);
});

test("fill: 데이터에 없는 메일 머지 키는 DATA_MISSING(종료 코드 1, 출력 없음), --missing keep이면 그 필드는 그대로 둔다", async () => {
  const { 추정가격, ...rest } = DATA;
  void 추정가격;
  const data = json("d3.json", rest);
  const missing = await cli("fill", p("merge.hwpx"), "--data", data, "-o", p("out/m1.hwpx"));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /DATA_MISSING\] 메일 머지 추정가격/);
  assert.ok(!existsSync(p("out/m1.hwpx")));
  const keep = await cli("fill", p("merge.hwpx"), "--data", data, "-o", p("out/m2.hwpx"), "--missing", "keep");
  assert.equal(keep.code, 0, keep.err);
  assert.deepEqual(
    listFields(docOf(p("out/m2.hwpx"))).filter((f) => f.mergeKey === "추정가격").map((f) => f.dirty),
    ["0", "0", "0"],
  );
});

test("fill --batch: 건마다 메일 머지 필드를 채운다(파일 3개)", async () => {
  const data = json("d4.json", [DATA, { ...DATA, 사업명: "둘째" }, { ...DATA, 사업명: "셋째" }]);
  mkdirSync(p("out/batch"));
  const r = await cli("fill", p("merge.hwpx"), "--data", data, "--batch", "-o", p("out/batch"));
  assert.equal(r.code, 0, r.err);
  const names = readdirSync(p("out/batch")).sort();
  assert.deepEqual(names, ["merge-001.hwpx", "merge-002.hwpx", "merge-003.hwpx"]);
  assert.deepEqual(listFields(docOf(p("out/batch/merge-002.hwpx"))).filter((f) => f.mergeKey === "사업명").map((f) => f.valueText), ["둘째", "둘째", "둘째", "둘째"]);
});

test("compile --merge-fields to-field: 메일 머지 필드 29개를 누름틀(이름 = 키)로 바꿔 저장한다. 4개는 그대로(경고). 바꾼 파일을 fill로 채울 수 있다", async () => {
  const r = await cli("compile", p("merge.hwpx"), "-o", p("out/c1.hwpx"), "--experimental", "--merge-fields", "to-field");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /메일 머지 필드 29개를 누름틀\(이름 = 키\)로 바꿨습니다/);
  assert.equal([...r.out.matchAll(/COMPILE_SKIPPED/g)].length, 4, r.out);
  const fields = listFields(docOf(p("out/c1.hwpx")));
  assert.equal(fields.filter((f) => f.type === "MAILMERGE").length, 4);
  assert.equal(fields.filter((f) => f.type === "CLICK_HERE" && f.name === "사업명").length, 4);
  const filled = await cli("fill", p("out/c1.hwpx"), "--data", json("d5.json", DATA), "-o", p("out/c1f.hwpx"));
  assert.equal(filled.code, 0, filled.err);
  assert.ok(textsOf(p("out/c1f.hwpx")).includes("사업명: 합성 사업 입니다."));
});

test("compile --merge-fields to-placeholder: 메일 머지 필드 29개를 {{키}} 글로 바꿔 저장한다. 4개는 그대로(경고). 바꾼 파일을 fill로 채울 수 있다", async () => {
  const r = await cli("compile", p("merge.hwpx"), "-o", p("out/c2.hwpx"), "--experimental", "--merge-fields", "to-placeholder");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /메일 머지 필드 29개를 \{\{키\}\} 글로 바꿨습니다/);
  assert.ok(textsOf(p("out/c2.hwpx")).includes("사업명: {{사업명}} 입니다."), "안내 글이던 자리가 {{키}}가 됐다");
  assert.equal(listFields(docOf(p("out/c2.hwpx"))).filter((f) => f.type === "MAILMERGE").length, 4);
  const filled = await cli("fill", p("out/c2.hwpx"), "--data", json("d6.json", DATA), "-o", p("out/c2f.hwpx"));
  assert.equal(filled.code, 0, filled.err);
  assert.ok(textsOf(p("out/c2f.hwpx")).includes("사업명: 합성 사업 입니다."));
});

test("compile: --merge-fields 없이는 메일 머지 필드를 건드리지 않고, 값이 to-placeholder·to-field가 아니면 사용법 오류(종료 코드 2, 출력 없음)", async () => {
  const plain = await cli("compile", p("merge.hwpx"), "-o", p("out/c3.hwpx"), "--experimental");
  assert.equal(plain.code, 0, plain.err);
  assert.equal(listFields(docOf(p("out/c3.hwpx"))).filter((f) => f.type === "MAILMERGE").length, 33);
  assert.doesNotMatch(plain.out, /메일 머지 필드 \d+개를/);
  const bad = await cli("compile", p("merge.hwpx"), "-o", p("out/c4.hwpx"), "--experimental", "--merge-fields", "아무거나");
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--merge-fields는 to-placeholder/);
  assert.ok(!existsSync(p("out/c4.hwpx")));
  assert.equal((await cli("compile", p("merge.hwpx"), "-o", p("out/c5.hwpx"), "--merge-fields", "to-field")).code, 2, "--experimental 없이는 쓰지 않는다");
});
