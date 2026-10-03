// M1-A·B CLI: 줄바꿈 값 채움과 여러 건 생성(`fill --batch`). 기대값은 명세(스튜디오 명세 4a)에서 만들었다:
// 원소마다 파일 하나, 이름 규칙, 한 건이 실패해도 나머지는 만들고 종료 코드 1, 출력 폴더는 있어야 하고(없으면 2),
// 같은 이름의 기존 파일은 --overwrite 없이는 거부(2), 배열인데 --batch가 없으면 2, 같은 입력은 같은 바이트, 보고서에 값 원문 없음.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { openPackage, parseDocument, validateDocument } from "../../../packages/hwpx-engine/src/index.ts";

const FIXTURES = fileURLToPath(new URL("../../../packages/hwpx-engine/test/fixtures/", import.meta.url));

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "hwpx-batch-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** 시험마다 새 작업 폴더: 원본 사본 `form.hwpx`(ph-single), 출력 폴더 `out/` */
function workspace(): { dir: string; p: (name: string) => string; out: (name: string) => string; listing: (sub?: string) => string[]; json: (name: string, value: unknown) => string } {
  const dir = join(root, `w${counter++}`);
  mkdirSync(join(dir, "out"), { recursive: true });
  copyFileSync(join(FIXTURES, "hancom", "ph-single.hwpx"), join(dir, "form.hwpx"));
  return {
    dir,
    p: (name) => join(dir, name),
    out: (name) => join(dir, "out", name),
    listing: (sub = "out") => readdirSync(join(dir, sub)).sort(),
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

const rec = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ project: { name, start: "S", end: "E" }, ...extra });
const paragraphs = (file: string): string[] => parseDocument(openPackage(new Uint8Array(readFileSync(file)))).sections[0]?.paragraphs.map((p) => p.logicalText) ?? [];
const bytes = (file: string): Buffer => readFileSync(file);

// ── A: CLI fill로 줄바꿈·탭 데이터가 채워진다 ──────────────────

test("A CLI fill: 줄바꿈·탭이 든 데이터가 채워지고(종료 코드 0) 제어 문자는 거절된다(1, 출력 없음)", async () => {
  const w = workspace();
  const data = w.json("d.json", rec("첫 줄\r\n둘째 줄", { x: 1 }));
  const r = await cli("fill", w.p("form.hwpx"), "--data", data, "-o", w.out("a.hwpx"));
  assert.equal(r.code, 0, r.err);
  assert.equal(paragraphs(w.out("a.hwpx"))[1], "사업명: 첫 줄\n둘째 줄 입니다.");
  assert.equal(validateDocument(new Uint8Array(bytes(w.out("a.hwpx")))).errors.length, 0);
  // 값 원문은 화면에 없다
  assert.ok(!r.out.includes("둘째 줄"));

  const tab = w.json("t.json", { project: { name: "가\t나", start: "S", end: "E" } });
  assert.equal((await cli("fill", w.p("form.hwpx"), "--data", tab, "-o", w.out("t.hwpx"))).code, 0);
  assert.equal(paragraphs(w.out("t.hwpx"))[1], "사업명: 가\t나 입니다.");

  const bad = w.json("b.json", { project: { name: "제어\u0001", start: "S", end: "E" } });
  const failed = await cli("fill", w.p("form.hwpx"), "--data", bad, "-o", w.out("b.hwpx"));
  assert.equal(failed.code, 1);
  assert.match(failed.err, /VALUE_CONTROL_CHAR/);
  assert.ok(!existsSync(w.out("b.hwpx")));
});

// ── B: 여러 건 생성 ────────────────────────────────────────────

test("B 배열 3건: 파일 3개(<원본 이름>-001.hwpx …), 건마다 자기 값, 종료 코드 0, 임시 파일이 남지 않는다", async () => {
  const w = workspace();
  const data = w.json("list.json", [rec("가"), rec("나\n둘째 줄"), rec("다")]);
  const r = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("out"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(w.listing(), ["form-001.hwpx", "form-002.hwpx", "form-003.hwpx"]);
  assert.deepEqual(["form-001", "form-002", "form-003"].map((n) => paragraphs(w.out(`${n}.hwpx`))[1]), ["사업명: 가 입니다.", "사업명: 나\n둘째 줄 입니다.", "사업명: 다 입니다."]);
  assert.match(r.out, /여러 건 생성: 총 3건, 성공 3, 실패 0/);
  assert.match(r.out, /성공 001 form-001\.hwpx \(채움 3, 건너뜀 0\)/);
  // 단건 생성과 같은 바이트
  const single = w.json("one.json", rec("나\n둘째 줄"));
  assert.equal((await cli("fill", w.p("form.hwpx"), "--data", single, "-o", w.p("single.hwpx"))).code, 0);
  assert.ok(bytes(w.p("single.hwpx")).equals(bytes(w.out("form-002.hwpx"))));
  assert.equal(w.listing("").some((n) => n.endsWith(".tmp")), false);
});

test("B 배열 1건·0건: 1건은 파일 1개, 0건은 파일 없이 종료 코드 0과 안내", async () => {
  const one = workspace();
  const r1 = await cli("fill", one.p("form.hwpx"), "--data", one.json("d.json", [rec("하나")]), "--batch", "-o", one.p("out"));
  assert.equal(r1.code, 0, r1.err);
  assert.deepEqual(one.listing(), ["form-001.hwpx"]);

  const zero = workspace();
  const r0 = await cli("fill", zero.p("form.hwpx"), "--data", zero.json("d.json", []), "--batch", "-o", zero.p("out"));
  assert.equal(r0.code, 0, r0.err);
  assert.deepEqual(zero.listing(), []);
  assert.match(r0.out, /0건/);
});

test("B 배열 500건: 파일 500개, 첫·끝 건의 값이 맞다", async (t) => {
  const w = workspace();
  const data = w.json("d.json", Array.from({ length: 500 }, (_, i) => rec(`이름 ${i + 1}\n둘째 줄`)));
  const start = performance.now();
  const r = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("out"));
  t.diagnostic(`500건 ${Math.round(performance.now() - start)}ms`);
  assert.equal(r.code, 0, r.err);
  const files = w.listing();
  assert.equal(files.length, 500);
  assert.deepEqual([files[0], files[499]], ["form-001.hwpx", "form-500.hwpx"]);
  assert.equal(paragraphs(w.out("form-500.hwpx"))[1], "사업명: 이름 500\n둘째 줄 입니다.");
  assert.match(r.out, /총 500건, 성공 500, 실패 0/);
});

test("B 묶음 형식: data가 배열이면 여러 건이고 derived는 건마다 같이 쓴다", async () => {
  const w = workspace();
  const data = w.json("d.json", { schema: "hwpx-studio/dataset@1", data: [{ project: { name: "가", start: "S" } }, { project: { name: "나", start: "S" } }], derived: { project: { end: "파생 끝" } } });
  const r = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("out"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(w.listing().map((n) => paragraphs(w.out(n))[2]), ["기간: S ~ 파생 끝", "기간: S ~ 파생 끝"]);
});

test("B --name: 그 원소의 값(문자열·숫자)으로 이름을 짓고, 못 쓰는 문자는 _, 비거나 없으면 번호, 중복이면 -2·-3", async () => {
  const w = workspace();
  const data = w.json("d.json", [
    rec("a", { id: "홍길동" }),
    rec("b", { id: "홍길동" }),
    rec("c", { id: "a/b:c" }),
    rec("d", { id: 7 }),
    rec("e", { id: "" }),
    rec("f"),
    rec("g", { id: "홍길동" }),
    rec("h", { id: "CON" }),
  ]);
  const r = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "--name", "{{id}}", "-o", w.p("out"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(w.listing(), ["7.hwpx", "CON_.hwpx", "a_b_c.hwpx", "form-005.hwpx", "form-006.hwpx", "홍길동-2.hwpx", "홍길동-3.hwpx", "홍길동.hwpx"].sort());
  assert.equal(paragraphs(w.out("홍길동-3.hwpx"))[1], "사업명: g 입니다.");
  assert.equal(paragraphs(w.out("a_b_c.hwpx"))[1], "사업명: c 입니다.");
});

test("B --name 사용법: --batch 없이 --name, {{경로}} 꼴이 아닌 값은 종료 코드 2", async () => {
  const w = workspace();
  const list = w.json("list.json", [rec("가")]);
  assert.equal((await cli("fill", w.p("form.hwpx"), "--data", w.json("one.json", rec("가")), "--name", "{{id}}", "-o", w.p("o.hwpx"))).code, 2);
  for (const bad of ["id", "{{id}}.x", "앞{{id}}", "{{a}}{{b}}", "{{ }}", ""]) {
    const r = await cli("fill", w.p("form.hwpx"), "--data", list, "--batch", "--name", bad, "-o", w.p("out"));
    assert.equal(r.code, 2, `${JSON.stringify(bad)}: ${r.out}${r.err}`);
  }
  assert.deepEqual(w.listing(), []);
  // 공백이 낀 표기는 허용
  assert.equal((await cli("fill", w.p("form.hwpx"), "--data", w.json("l2.json", [rec("가", { id: "x" })]), "--batch", "--name", " {{ id }} ", "-o", w.p("out"))).code, 0);
  assert.deepEqual(w.listing(), ["x.hwpx"]);
});

test("B 한 건이 실패해도 나머지는 만들고 종료 코드 1 — 보고서에 건별 결과, 값 원문 없음", async () => {
  const w = workspace();
  const data = w.json("d.json", [
    rec("비밀가"),
    { project: { name: "비밀누락", start: "S" } },
    5,
    rec("제어\u0001비밀"),
    rec("비밀나\n줄"),
  ]);
  const report = w.p("report.json");
  const r = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("out"), "--report", report);
  assert.equal(r.code, 1);
  assert.deepEqual(w.listing(), ["form-001.hwpx", "form-005.hwpx"]);
  assert.match(r.err, /실패 002 form-002\.hwpx/);
  assert.match(r.err, /\[DATA_MISSING\]/);
  assert.match(r.err, /\[DATA_SCHEMA\]/);
  assert.match(r.err, /\[VALUE_CONTROL_CHAR\]/);
  assert.match(r.out, /총 5건, 성공 2, 실패 3/);

  const body = JSON.parse(readFileSync(report, "utf8")) as { ok: boolean; total: number; succeeded: number; failed: number; items: { index: number; name: string; ok: boolean; filled: number; skipped: unknown[]; errorCodes: string[] }[] };
  assert.deepEqual([body.ok, body.total, body.succeeded, body.failed], [false, 5, 2, 3]);
  assert.deepEqual(body.items.map((i) => [i.index, i.name, i.ok, i.filled, i.errorCodes]), [
    [1, "form-001.hwpx", true, 3, []],
    [2, "form-002.hwpx", false, 0, ["DATA_MISSING"]],
    [3, "form-003.hwpx", false, 0, ["DATA_SCHEMA"]],
    [4, "form-004.hwpx", false, 0, ["VALUE_CONTROL_CHAR"]],
    [5, "form-005.hwpx", true, 3, []],
  ]);
  assert.deepEqual(body.items.map((i) => i.skipped), [[], [], [], [], []]);
  assert.ok(!readFileSync(report, "utf8").includes("비밀"), "보고서에 값 원문이 있다");
  assert.ok(!r.out.includes("비밀") && !r.err.includes("비밀"), "화면에 값 원문이 있다");
});

test("B 모든 건이 실패하면 파일 없이 종료 코드 1이고 보고서는 쓴다", async () => {
  const w = workspace();
  const report = w.p("report.json");
  const r = await cli("fill", w.p("form.hwpx"), "--data", w.json("d.json", [{}, {}]), "--batch", "-o", w.p("out"), "--report", report);
  assert.equal(r.code, 1);
  assert.deepEqual(w.listing(), []);
  assert.equal((JSON.parse(readFileSync(report, "utf8")) as { failed: number }).failed, 2);
});

test("B --missing empty는 누락 건도 만든다(건마다 적용)", async () => {
  const w = workspace();
  const r = await cli("fill", w.p("form.hwpx"), "--data", w.json("d.json", [{ project: { name: "가", start: "S" } }]), "--batch", "--missing", "empty", "-o", w.p("out"));
  assert.equal(r.code, 0, r.err);
  assert.equal(paragraphs(w.out("form-001.hwpx"))[2], "기간: S ~ ");
});

test("B 출력 폴더: 없으면 2, 폴더가 아니면 2, 아무 파일도 만들지 않는다", async () => {
  const w = workspace();
  const data = w.json("d.json", [rec("가")]);
  const missing = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("없는폴더"));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /출력 폴더가 없습니다/);
  assert.ok(!existsSync(w.p("없는폴더")));
  writeFileSync(w.p("file.txt"), "x");
  assert.equal((await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("file.txt"))).code, 2);
  assert.equal((await cli("fill", w.p("form.hwpx"), "--data", data, "--batch")).code, 2, "-o 없음");
  assert.deepEqual(w.listing(), []);
});

test("B 덮어쓰기: 같은 이름의 기존 파일이 하나라도 있으면 --overwrite 없이는 아무것도 만들지 않고 2, --overwrite면 덮어쓴다", async () => {
  const w = workspace();
  const data = w.json("d.json", [rec("가"), rec("나"), rec("다")]);
  writeFileSync(w.out("form-002.hwpx"), "기존");
  writeFileSync(w.out("other.txt"), "관계없음");
  const refused = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("out"));
  assert.equal(refused.code, 2);
  assert.match(refused.err, /form-002\.hwpx/);
  assert.deepEqual(w.listing(), ["form-002.hwpx", "other.txt"]);
  assert.equal(readFileSync(w.out("form-002.hwpx"), "utf8"), "기존", "기존 파일은 그대로");

  const ok = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "-o", w.p("out"), "--overwrite");
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(w.listing(), ["form-001.hwpx", "form-002.hwpx", "form-003.hwpx", "other.txt"]);
  assert.equal(paragraphs(w.out("form-002.hwpx"))[1], "사업명: 나 입니다.");
  assert.equal(readFileSync(w.out("other.txt"), "utf8"), "관계없음");
});

test("B 입력 보호: 결과 이름이 원본 파일과 같으면 거부(2), 보고서 경로가 결과 파일과 같아도 거부(2)", async () => {
  const w = workspace();
  // 원본(form.hwpx)이 든 폴더에 --name으로 form을 만들려 하면 원본을 덮게 된다
  const data = w.json("d.json", [rec("가", { n: "form" })]);
  const same = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "--name", "{{n}}", "-o", w.dir, "--overwrite");
  assert.equal(same.code, 2);
  assert.match(same.err, /입력과 같습니다/);
  assert.ok(bytes(w.p("form.hwpx")).equals(bytes(join(FIXTURES, "hancom", "ph-single.hwpx"))), "원본은 그대로");

  const clash = await cli("fill", w.p("form.hwpx"), "--data", w.json("d2.json", [rec("가")]), "--batch", "-o", w.p("out"), "--report", w.out("form-001.hwpx"));
  assert.equal(clash.code, 2);
  assert.deepEqual(w.listing(), []);
});

test("B 사용법: 배열인데 --batch가 없으면 2(안내 문구), 배열이 아닌데 --batch면 2, md·txt에는 --batch를 쓸 수 없다", async () => {
  const w = workspace();
  const list = w.json("list.json", [rec("가")]);
  const noBatch = await cli("fill", w.p("form.hwpx"), "--data", list, "-o", w.p("x.hwpx"));
  assert.equal(noBatch.code, 2);
  assert.match(noBatch.err, /여러 건 데이터입니다\. --batch를 쓰십시오/);
  assert.ok(!existsSync(w.p("x.hwpx")));
  const bundle = w.json("bundle.json", { schema: "hwpx-studio/dataset@1", data: [rec("가")] });
  assert.equal((await cli("fill", w.p("form.hwpx"), "--data", bundle, "-o", w.p("x.hwpx"))).code, 2);

  const notArray = await cli("fill", w.p("form.hwpx"), "--data", w.json("one.json", rec("가")), "--batch", "-o", w.p("out"));
  assert.equal(notArray.code, 2);
  assert.match(notArray.err, /배열/);

  copyFileSync(join(FIXTURES, "text", "notice.md"), w.p("notice.md"));
  const md = await cli("fill", w.p("notice.md"), "--data", list, "--batch", "-o", w.p("out"));
  assert.equal(md.code, 2);
  assert.match(md.err, /--batch는 \.hwpx에서만/);
  // md에 배열 데이터를 주던 지금 동작(DATA_SCHEMA, 종료 코드 2)은 그대로
  const mdArray = await cli("fill", w.p("notice.md"), "--data", list, "-o", w.p("n.md"));
  assert.equal(mdArray.code, 2);
  assert.doesNotMatch(mdArray.err, /--batch를 쓰십시오/);
});

test("B 읽을 수 없는 입력: 깨진 JSON·깨진 원본 문서는 종료 코드 2(파일 없음)", async () => {
  const w = workspace();
  writeFileSync(w.p("broken.json"), "[{");
  assert.equal((await cli("fill", w.p("form.hwpx"), "--data", w.p("broken.json"), "--batch", "-o", w.p("out"))).code, 2);
  writeFileSync(w.p("broken.hwpx"), "ZIP이 아님");
  assert.equal((await cli("fill", w.p("broken.hwpx"), "--data", w.json("d.json", [rec("가")]), "--batch", "-o", w.p("out"))).code, 2);
  assert.deepEqual(w.listing(), []);
});

test("B 결정성: 같은 입력을 두 번 돌리면 모든 파일이 같은 바이트이고 보고서도 같다", async () => {
  const w = workspace();
  mkdirSync(w.p("out2"));
  const data = w.json("d.json", [rec("가", { id: "x" }), rec("나\t다\n라", { id: "x" }), { project: { name: "누락" } }, rec("마", { id: "y" })]);
  const a = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "--name", "{{id}}", "-o", w.p("out"), "--report", w.p("r1.json"));
  const b = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "--name", "{{id}}", "-o", w.p("out2"), "--report", w.p("r2.json"));
  assert.equal(a.code, 1);
  assert.equal(b.code, 1);
  assert.deepEqual(w.listing("out"), w.listing("out2"));
  for (const name of w.listing("out")) assert.ok(bytes(w.out(name)).equals(bytes(w.p(`out2/${name}`))), name);
  assert.ok(bytes(w.p("r1.json")).equals(bytes(w.p("r2.json"))));
  assert.equal(a.out, b.out);
});

test("B --dry-run: 파일을 만들지 않고 건별 성공·실패와 종료 코드(실패가 있으면 1)만 낸다. -o는 없어도 된다", async () => {
  const w = workspace();
  const okOnly = await cli("fill", w.p("form.hwpx"), "--data", w.json("d.json", [rec("가"), rec("나")]), "--batch", "--dry-run");
  assert.equal(okOnly.code, 0, okOnly.err);
  assert.match(okOnly.out, /총 2건, 성공 2, 실패 0 \(모의 실행/);
  const some = await cli("fill", w.p("form.hwpx"), "--data", w.json("d2.json", [rec("가"), {}]), "--batch", "--dry-run", "-o", w.p("out"), "--report", w.p("r.json"));
  assert.equal(some.code, 1);
  assert.deepEqual(w.listing(), []);
  assert.equal((JSON.parse(readFileSync(w.p("r.json"), "utf8")) as { dryRun: boolean }).dryRun, true);
});

test("B 템플릿과 함께: 건마다 규칙(누름틀 채움)이 적용되고 줄바꿈 값이 들어간다", async () => {
  const w = workspace();
  copyFileSync(join(FIXTURES, "hancom", "field-states.hwpx"), w.p("fields.hwpx"));
  const template = w.json("t.json", {
    schema: "hwpx-studio/template@1",
    anchors: [{ id: "a", kind: "field", name: "소속" }],
    rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { path: "org" } } }],
  });
  const data = w.json("d.json", [{ org: "첫 줄\n둘째 줄" }, { org: "기관" }]);
  const r = await cli("fill", w.p("fields.hwpx"), "--data", data, "--template", template, "--batch", "--missing", "keep", "-o", w.p("out"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(w.listing(), ["fields-001.hwpx", "fields-002.hwpx"]);
  const org = (file: string): string => {
    const doc = parseDocument(openPackage(new Uint8Array(readFileSync(file))));
    return (doc.sections[0]?.paragraphs[1]?.logicalText ?? "").split("￼")[1] ?? "";
  };
  assert.deepEqual([org(w.out("fields-001.hwpx")), org(w.out("fields-002.hwpx"))], ["첫 줄\n둘째 줄", "기관"]);
});

// ── 실패한 건의 옛 결과 파일 ───────────────────────────────────
// 실패한 건은 파일을 만들지 않는다. `--overwrite`로 다시 돌릴 때 전 실행의 같은 이름 파일이 남아 있으면 "실패한 건은 파일이 없다"와 어긋나므로 지운다.
// `--overwrite`가 없으면 같은 이름의 기존 파일 때문에 아무 것도 만들기 전에 거부(2)하므로 아무 파일도 바뀌지 않는다(지금 동작).

test("B --overwrite 재실행: 실패한 건의 옛 파일은 지우고(알림 한 줄), 성공한 건은 새 바이트로 덮는다. 종료 코드 1", async () => {
  const w = workspace();
  const first = await cli("fill", w.p("form.hwpx"), "--data", w.json("d1.json", [rec("가"), rec("나"), rec("다")]), "--batch", "-o", w.p("out"));
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(w.listing(), ["form-001.hwpx", "form-002.hwpx", "form-003.hwpx"]);
  const old = ["form-001.hwpx", "form-002.hwpx", "form-003.hwpx"].map((n) => bytes(w.out(n)));

  // 둘째 건에서 사업명(project.name) 키를 뺀다
  const again = w.json("d2.json", [rec("가2"), { project: { start: "S", end: "E" } }, rec("다2")]);
  const r = await cli("fill", w.p("form.hwpx"), "--data", again, "--batch", "-o", w.p("out"), "--overwrite");
  assert.equal(r.code, 1);
  assert.deepEqual(w.listing(), ["form-001.hwpx", "form-003.hwpx"], "둘째 건의 옛 파일이 없다");
  assert.equal(paragraphs(w.out("form-001.hwpx"))[1], "사업명: 가2 입니다.");
  assert.equal(paragraphs(w.out("form-003.hwpx"))[1], "사업명: 다2 입니다.");
  assert.ok(!bytes(w.out("form-001.hwpx")).equals(old[0] ?? Buffer.alloc(0)) && !bytes(w.out("form-003.hwpx")).equals(old[2] ?? Buffer.alloc(0)), "성공한 건은 새 바이트");
  assert.match(r.err, /실패 002 form-002\.hwpx/);
  assert.match(r.err, /실패 002 form-002\.hwpx[\s\S]*\[DATA_MISSING\][\s\S]*\n {2}이전 결과 파일을 지웠습니다: form-002\.hwpx/);
  assert.equal(r.err.split("이전 결과 파일을 지웠습니다").length - 1, 1, "지운 건만 알린다");
  assert.match(r.out, /총 3건, 성공 2, 실패 1/);
  assert.equal(w.listing("").some((n) => n.endsWith(".tmp")), false);
});

test("B --overwrite 없이 재실행: 같은 이름의 기존 파일 때문에 거부(2)하고 옛 파일 셋 모두 그대로다(실패한 건의 옛 파일도 지우지 않는다)", async () => {
  const w = workspace();
  assert.equal((await cli("fill", w.p("form.hwpx"), "--data", w.json("d1.json", [rec("가"), rec("나"), rec("다")]), "--batch", "-o", w.p("out"))).code, 0);
  const names = ["form-001.hwpx", "form-002.hwpx", "form-003.hwpx"];
  const old = names.map((n) => bytes(w.out(n)));

  const again = w.json("d2.json", [rec("가2"), { project: { start: "S", end: "E" } }, rec("다2")]);
  const r = await cli("fill", w.p("form.hwpx"), "--data", again, "--batch", "-o", w.p("out"));
  assert.equal(r.code, 2);
  assert.match(r.err, /출력 파일이 이미 있습니다.*form-001\.hwpx/);
  assert.doesNotMatch(r.err, /지웠습니다/);
  assert.deepEqual(w.listing(), names);
  names.forEach((n, i) => assert.ok(bytes(w.out(n)).equals(old[i] ?? Buffer.alloc(0)), `${n}은 그대로`));
});

test("B --overwrite의 삭제는 실패한 건의 같은 이름 파일뿐이다: 파일이 없으면 알림 없음, 다른 파일은 그대로, --dry-run이면 아무 것도 지우지 않는다", async () => {
  const w = workspace();
  writeFileSync(w.out("other.txt"), "관계없음");
  // 옛 파일이 없는 실패 건: 지울 것도 알릴 것도 없다
  const none = await cli("fill", w.p("form.hwpx"), "--data", w.json("d.json", [rec("가"), {}]), "--batch", "-o", w.p("out"), "--overwrite");
  assert.equal(none.code, 1);
  assert.doesNotMatch(none.err, /지웠습니다/);
  assert.deepEqual(w.listing(), ["form-001.hwpx", "other.txt"]);

  // 이제 둘째 건의 옛 파일을 만들어 두고 --dry-run --overwrite: 지우지 않는다
  writeFileSync(w.out("form-002.hwpx"), "옛 결과");
  const dry = await cli("fill", w.p("form.hwpx"), "--data", w.json("d.json", [rec("가"), {}]), "--batch", "-o", w.p("out"), "--overwrite", "--dry-run");
  assert.equal(dry.code, 1);
  assert.doesNotMatch(dry.err, /지웠습니다/);
  assert.equal(readFileSync(w.out("form-002.hwpx"), "utf8"), "옛 결과");
  assert.equal(readFileSync(w.out("other.txt"), "utf8"), "관계없음");

  // 폴더인 같은 이름은 지우지 않는다(기존 규칙대로 출력 경로가 폴더라 거부, 2)
  rmSync(w.out("form-002.hwpx"));
  mkdirSync(w.out("form-002.hwpx"));
  const dir = await cli("fill", w.p("form.hwpx"), "--data", w.json("d.json", [rec("가"), {}]), "--batch", "-o", w.p("out"), "--overwrite");
  assert.equal(dir.code, 2);
  assert.ok(existsSync(w.out("form-002.hwpx")));
});

test("B --overwrite 입력 보호: 실패한 건의 이름이 원본 파일과 같아도 지우지 않고 거부(2)한다", async () => {
  const w = workspace();
  const data = w.json("d.json", [{ n: "form" }]); // project가 없어 이 건은 실패한다
  const r = await cli("fill", w.p("form.hwpx"), "--data", data, "--batch", "--name", "{{n}}", "-o", w.dir, "--overwrite");
  assert.equal(r.code, 2);
  assert.match(r.err, /입력과 같습니다/);
  assert.ok(bytes(w.p("form.hwpx")).equals(bytes(join(FIXTURES, "hancom", "ph-single.hwpx"))), "원본은 그대로");
});
