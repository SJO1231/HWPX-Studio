// G5: 명령 8종의 성공 경로와 종료 코드 0·1·2, 실패 시 출력 파일 없음, 출력 파일 안전 규칙.
// 시험은 임시 폴더의 사본으로만 한다(fixtures는 읽기만 한다).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { extractFragment, listFields, openPackage, parseDocument, readArchive, readEntry, serializeFragment, validateDocument } from "../../../packages/hwpx-engine/src/index.ts";
import { parseSynthetic } from "../../../packages/hwpx-engine/test/helpers.ts";

const FIXTURES = fileURLToPath(new URL("../../../packages/hwpx-engine/test/fixtures/", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPAIR_MODULE = fileURLToPath(new URL("../../../packages/hwpx-engine/src/repair/index.ts", import.meta.url));

let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "hwpx-cli-"));
  for (const name of ["hancom/ph-single", "hancom/ph-mixed", "hancom/blocks", "hancom/field-states", "hancom/picture", "extra/features-picture", "D1"]) {
    copyFileSync(join(FIXTURES, `${name}.hwpx`), join(dir, `${name.replace("/", "-")}.hwpx`));
  }
  for (const name of ["notice.md", "memo.txt"]) copyFileSync(join(FIXTURES, "text", name), join(dir, name));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const p = (name: string): string => join(dir, name);
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(p(name)));
const write = (name: string, content: string): string => {
  writeFileSync(p(name), content);
  return p(name);
};
const listing = (): string[] => readdirSync(dir).sort();
const doc = (name: string) => parseDocument(openPackage(read(name)));

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { log: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const DATA = { project: { name: "알파", start: "2026-01-01", end: "2026-12-31" } };

// ── 성공 경로(종료 코드 0) ─────────────────────────────────────

test("G5 inspect: 요약(텍스트·--json)과 --model 저장, 종료 코드 0", async () => {
  const r = await cli("inspect", p("hancom-field-states.hwpx"), "--json");
  assert.equal(r.code, 0, r.err);
  const summary = JSON.parse(r.out) as { sections: number; paragraphs: number; fields: { name: string; shape: string; dirty: string }[]; placeholders: unknown[] };
  assert.equal(summary.sections, 1);
  assert.equal(summary.paragraphs, 3);
  assert.deepEqual(summary.fields.map((f) => [f.name, f.shape, f.dirty]), [["성명", "simple", "0"], ["소속", "simple", "1"], ["성명", "simple", "0"]]);

  const text = await cli("inspect", p("hancom-ph-single.hwpx"));
  assert.equal(text.code, 0);
  assert.match(text.out, /\{\{\}\} 표기 3종/);
  assert.match(text.out, /project\.name x1/);

  const model = p("model.json");
  const withModel = await cli("inspect", p("hancom-ph-single.hwpx"), "--model", model);
  assert.equal(withModel.code, 0, withModel.err);
  const json = JSON.parse(readFileSync(model, "utf8")) as { schemaVersion: number };
  assert.equal(typeof json.schemaVersion, "number");
  // 있는 파일은 --overwrite 없이는 덮어쓰지 않는다
  assert.equal((await cli("inspect", p("hancom-ph-single.hwpx"), "--model", model)).code, 2);
  assert.equal((await cli("inspect", p("hancom-ph-single.hwpx"), "--model", model, "--overwrite")).code, 0);
});

test("G5 candidates: 후보 자리 목록(텍스트·--json), 종료 코드 0", async () => {
  const r = await cli("candidates", p("hancom-ph-single.hwpx"), "--json");
  assert.equal(r.code, 0);
  assert.deepEqual((JSON.parse(r.out) as { kind: string }[]).map((c) => c.kind), ["placeholder", "placeholder", "placeholder"]);
  const t = await cli("candidates", p("hancom-field-states.hwpx"));
  assert.equal(t.code, 0);
  assert.match(t.out, /후보 자리 3개/);
  assert.match(t.out, /\[field\]/);
});

test("G5 fragment extract·import: 조각을 뜨고 다른 문서에 가져온다(게이트 포함), 종료 코드 0", async () => {
  const frag = p("picture-frag.json");
  const ex = await cli("fragment", "extract", p("hancom-picture.hwpx"), "--section", "0", "--from", "1", "--to", "1", "-o", frag);
  assert.equal(ex.code, 0, ex.err);
  assert.match(ex.out, /문단 1개/);
  const saved = JSON.parse(readFileSync(frag, "utf8")) as { schema: string; binaries: unknown[] };
  assert.equal(saved.schema, "hwpx-studio/fragment@1");
  assert.equal(saved.binaries.length, 1);

  const out = p("blocks-with-picture.hwpx");
  const im = await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, "--section", "0", "--index", "3", "-o", out);
  assert.equal(im.code, 0, im.err);
  const result = doc("blocks-with-picture.hwpx");
  assert.equal(result.sections[0]?.paragraphs.length, 7);
  assert.equal(result.sections[0]?.paragraphs[4]?.objects[0]?.type, "pic");
  assert.equal(validateDocument(read("blocks-with-picture.hwpx")).census.pictures, 1);

  // --before: 앵커 문단 앞
  const before = p("blocks-with-picture-before.hwpx");
  assert.equal((await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, "--section", "0", "--index", "3", "--before", "-o", before)).code, 0);
  assert.equal(doc("blocks-with-picture-before.hwpx").sections[0]?.paragraphs[3]?.objects[0]?.type, "pic");

  // 표 셀 안(하위 목록)에도 가져온다: 주소는 [문단, 하위목록] 짝
  const cell = p("blocks-cell.hwpx");
  const inCell = await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, "--section", "0", "--parent", "4.0", "--index", "0", "-o", cell);
  assert.equal(inCell.code, 0, inCell.err);
  assert.equal(doc("blocks-cell.hwpx").sections[0]?.paragraphs[4]?.subLists[0]?.paragraphs.length, 2);
});

test("G5 fragment import: 조각이 소스에서 갖고 있던 id 중복·없는 참조는 상속으로 보고하고 통과한다(종료 코드 0). strict는 막는다(1)", async () => {
  // 소스가 이미 가진 문제: 같은 id의 도형 둘, 없는 글자모양 9번
  const run = (id: string, inner: string, ref = "0"): string =>
    `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${ref}">${inner}<hp:t>x</hp:t></hp:run></hp:p>`;
  const src = parseSynthetic([run("11", '<hp:rect id="2"/><hp:rect id="2"/>') + run("12", "", "9")]);
  const frag = write("inherited-frag.json", serializeFragment(extractFragment(src, { sectionIndex: 0, parentPath: [], from: 0, to: 1 })));
  const out = p("blocks-inherited.hwpx");
  const r = await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, "--section", "0", "--index", "3", "-o", out);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /상속한 문제\(조각이 소스에서 갖고 있던 것\): 겹치는 id 1종, 없는 참조 1종, 그로 설명되는 검사 오류 2종/);
  assert.match(r.out, /경고 \[FRAG_INHERITED_DUP\]/);
  assert.match(r.out, /경고 \[GATE_INHERITED\]/);
  assert.equal(validateDocument(read("blocks-inherited.hwpx")).errors.length, 2, "출력 문서에는 소스에서 온 오류가 그대로 있다");

  // strict: 상속한 오류도 막는다. 출력 파일은 만들지 않는다
  const strict = p("blocks-inherited-strict.hwpx");
  const s = await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, "--section", "0", "--index", "3", "-o", strict, "--mode", "strict");
  assert.equal(s.code, 1);
  assert.ok(!existsSync(strict));
});

test("G5 fill: 생성·보고서·모의 실행·누락 정책·템플릿과 조각 경로, 종료 코드 0", async () => {
  const data = write("data.json", JSON.stringify(DATA));
  const out = p("filled.hwpx");
  const report = p("filled-report.json");
  const r = await cli("fill", p("hancom-ph-single.hwpx"), "--data", data, "-o", out, "--report", report);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(doc("filled.hwpx").sections[0]?.paragraphs.map((x) => x.logicalText.replace(/￼/g, "")).slice(1), ["사업명: 알파 입니다.", "기간: 2026-01-01 ~ 2026-12-31"]);
  const saved = JSON.parse(readFileSync(report, "utf8")) as { ok: boolean; ledger: { output: { sha256: string } }; report: unknown };
  assert.equal(saved.ok, true);
  assert.equal(saved.ledger.output.sha256.length, 64);
  // 보고서에 값 원문이 없다
  assert.ok(!readFileSync(report, "utf8").includes("2026-01-01"));

  // 모의 실행: 출력 파일 없이 보고만, 종료 코드 0
  const dry = await cli("fill", p("hancom-ph-single.hwpx"), "--data", data, "--dry-run");
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /모의 실행/);
  assert.match(dry.out, /필요한 데이터 경로: project\.end, project\.name, project\.start/);
  assert.ok(!listing().includes("dry.hwpx"));

  // 누락 정책 empty·keep
  const partial = write("partial.json", JSON.stringify({ project: { name: "N", start: "S" } }));
  assert.equal((await cli("fill", p("hancom-ph-single.hwpx"), "--data", partial, "-o", p("empty.hwpx"), "--missing", "empty")).code, 0);
  assert.equal(doc("empty.hwpx").sections[0]?.paragraphs[2]?.logicalText, "기간: S ~ ");
  const keep = await cli("fill", p("hancom-ph-single.hwpx"), "--data", partial, "-o", p("keep.hwpx"), "--missing", "keep");
  assert.equal(keep.code, 0, keep.err);
  assert.equal(doc("keep.hwpx").sections[0]?.paragraphs[2]?.logicalText, "기간: S ~ {{project.end}}");

  // 템플릿(누름틀 채움 + 조각 경로는 템플릿이 있는 폴더 기준)
  mkdirSync(p("tpl/fragments"), { recursive: true });
  const fragFile = p("tpl/fragments/ph.json");
  assert.equal((await cli("fragment", "extract", p("hancom-ph-single.hwpx"), "--section", "0", "--from", "1", "--to", "1", "-o", fragFile)).code, 0);
  const tpl = write("tpl/t.json", JSON.stringify({
    schema: "hwpx-studio/template@1",
    anchors: [{ id: "a", kind: "field", name: "성명" }],
    rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { path: "name" } } }],
  }));
  const t = await cli("fill", p("hancom-field-states.hwpx"), "--data", write("d2.json", JSON.stringify({ name: "홍길동" })), "--template", tpl, "-o", p("tpl-out.hwpx"));
  assert.equal(t.code, 0, t.err);
  assert.deepEqual(listFields(doc("tpl-out.hwpx")).map((f) => f.valueText), ["홍길동", "합성기관", "홍길동"]);
});

test("G5 fill: 조각 경로를 쓰는 템플릿은 템플릿 폴더 기준으로 조각을 읽는다", async () => {
  const frag = p("tpl/fragments/ph.json");
  const anchorText = "선택 조항 본문입니다. (해당 시)";
  const { createHash } = await import("node:crypto");
  const t = write("tpl/t2.json", JSON.stringify({
    schema: "hwpx-studio/template@1",
    anchors: [{ id: "l", kind: "line", at: { sectionIndex: 0, path: [3] }, print: { text: anchorText, sha256: createHash("sha256").update(anchorText).digest("hex") } }],
    rules: [{ id: "r", do: { type: "inject", anchor: "l", position: "after", fragment: "fragments/ph.json" } }],
  }));
  assert.ok(existsSync(frag));
  const r = await cli("fill", p("hancom-blocks.hwpx"), "--data", write("d3.json", JSON.stringify(DATA)), "--template", t, "-o", p("inject-out.hwpx"));
  assert.equal(r.code, 0, r.err);
  assert.equal(doc("inject-out.hwpx").sections[0]?.paragraphs[4]?.logicalText, "사업명: 알파 입니다.");
  // 조각 파일이 없으면 읽을 수 없는 입력(2)
  rmSync(frag);
  const missing = await cli("fill", p("hancom-blocks.hwpx"), "--data", p("d3.json"), "--template", t, "-o", p("inject-out2.hwpx"));
  assert.equal(missing.code, 2);
  assert.ok(!existsSync(p("inject-out2.hwpx")));
});

test("G5 validate: 검사 통과(0)·--baseline·--json", async () => {
  const ok = await cli("validate", p("hancom-ph-single.hwpx"));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /검사 통과/);
  const filled = p("filled.hwpx");
  const base = await cli("validate", filled, "--baseline", p("hancom-ph-single.hwpx"), "--json");
  assert.equal(base.code, 0);
  const json = JSON.parse(base.out) as { ok: boolean; baseline: { newErrors: unknown[] }; report: { census: { paragraphs: number } } };
  assert.equal(json.ok, true);
  assert.deepEqual(json.baseline.newErrors, []);
  assert.equal(json.report.census.paragraphs, 3);
  // 원래 오류가 있는 문서도 기준선에 자기 자신을 주면 통과한다
  assert.equal((await cli("validate", p("extra-features-picture.hwpx"), "--baseline", p("extra-features-picture.hwpx"))).code, 0);
});

test("G5 diff: 항목별 동일 여부와 수량 비교, 종료 코드 0", async () => {
  const r = await cli("diff", p("hancom-ph-single.hwpx"), p("filled.hwpx"), "--json");
  assert.equal(r.code, 0, r.err);
  const json = JSON.parse(r.out) as { entries: { name: string; status: string }[]; summary: { changed: number; added: number }; census: { delta: { paragraphs: number } } };
  assert.deepEqual(json.entries.filter((e) => e.status !== "identical").map((e) => e.name), ["Contents/section0.xml"]);
  assert.equal(json.census.delta.paragraphs, 0);
  const same = await cli("diff", p("hancom-ph-single.hwpx"), p("hancom-ph-single.hwpx"));
  assert.equal(same.code, 0);
  assert.match(same.out, /바뀜 0, 추가 0, 삭제 0/);
  const added = JSON.parse((await cli("diff", p("hancom-blocks.hwpx"), p("blocks-with-picture.hwpx"), "--json")).out) as { entries: { name: string; status: string }[]; census: { delta: { pictures: number; binaryItems: number } } };
  assert.ok(added.entries.some((e) => e.status === "added" && e.name.startsWith("BinData/")));
  assert.deepEqual([added.census.delta.pictures, added.census.delta.binaryItems], [1, 1]);
});

test("G5 compile: --experimental 없이는 거부(2), 있으면 {{}}를 누름틀로 승격해 저장(0)", async () => {
  const refused = await cli("compile", p("hancom-ph-single.hwpx"), "-o", p("compiled.hwpx"));
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--experimental/);
  assert.ok(!existsSync(p("compiled.hwpx")));
  const r = await cli("compile", p("hancom-ph-single.hwpx"), "-o", p("compiled.hwpx"), "--experimental");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(listFields(doc("compiled.hwpx")).map((f) => f.name), ["project.name", "project.start", "project.end"]);
  assert.equal((await cli("compile", p("hancom-ph-single.hwpx"), "-o", p("compiled.hwpx"), "--experimental")).code, 2, "이미 있는 출력");
});

test("G5 fill --mode repair: 보정 모듈이 있으면 연결해 쓰고(0), 없으면 안내와 함께 종료 코드 2", async () => {
  const data = p("data.json");
  const t = write("repair-t.json", JSON.stringify({ schema: "hwpx-studio/template@1" }));
  const r = await cli("fill", p("extra-features-picture.hwpx"), "--data", data, "--template", t, "-o", p("repaired.hwpx"), "--mode", "repair", "--missing", "keep");
  if (existsSync(REPAIR_MODULE)) {
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    assert.ok(existsSync(p("repaired.hwpx")));
  } else {
    assert.equal(r.code, 2);
    assert.match(r.err, /보정 모듈/);
    assert.ok(!existsSync(p("repaired.hwpx")));
  }
});

// ── 검사·게이트 실패(종료 코드 1): 출력 파일 없음 ───────────────

test("G5 종료 코드 1: 게이트 실패(누락 키 error·strict·값 재읽기 불가)이면 출력 파일을 만들지 않는다", async () => {
  const before = listing();
  const partial = p("partial.json");
  const missing = await cli("fill", p("hancom-ph-single.hwpx"), "--data", partial, "-o", p("never1.hwpx"));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /DATA_MISSING/);
  assert.match(missing.err, /출력 파일을 만들지 않았습니다/);

  const featuresData = write("fd.json", "{}");
  const tpl = write("features-t.json", JSON.stringify({ schema: "hwpx-studio/template@1" }));
  const strict = await cli("fill", p("extra-features-picture.hwpx"), "--data", featuresData, "--template", tpl, "-o", p("never2.hwpx"), "--mode", "strict");
  assert.equal(strict.code, 1);
  assert.match(strict.err, /GATE_ERRORS/);
  // 기본(baseline)은 같은 문서를 통과시킨다
  const base = await cli("fill", p("extra-features-picture.hwpx"), "--data", featuresData, "--template", tpl, "-o", p("features-out.hwpx"));
  assert.equal(base.code, 0, base.err);
  assert.match(base.out, /원래 있던 오류/);

  // 거절된 문서에 대한 보고서는 남지만(--report) 출력 파일과 임시 파일은 없다
  const rep = p("fail-report.json");
  assert.equal((await cli("fill", p("hancom-ph-single.hwpx"), "--data", partial, "-o", p("never3.hwpx"), "--report", rep)).code, 1);
  assert.equal((JSON.parse(readFileSync(rep, "utf8")) as { ok: boolean }).ok, false);

  const after = listing();
  for (const name of ["never1.hwpx", "never2.hwpx", "never3.hwpx"]) assert.ok(!after.includes(name), name);
  assert.ok(!after.some((n) => n.endsWith(".tmp")), "임시 파일이 남았다");
  assert.deepEqual(after.filter((n) => !before.includes(n)).sort(), ["fail-report.json", "features-out.hwpx", "fd.json", "features-t.json"].sort());

  // fragment import도 게이트 실패이면 파일 없음: 엄격 방식에서 원래 오류가 있는 대상
  const frag = p("picture-frag.json");
  const imp = await cli("fragment", "import", p("extra-features-picture.hwpx"), frag, "--section", "0", "--index", "1", "-o", p("never4.hwpx"), "--mode", "strict");
  assert.equal(imp.code, 1);
  assert.ok(!existsSync(p("never4.hwpx")));
});

test("G5 종료 코드 1: validate는 오류가 있으면 1(원래 오류가 있는 문서, --strict, 기준선 대비 새 오류, ZIP이 아닌 파일)", async () => {
  const bad = await cli("validate", p("extra-features-picture.hwpx"));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /INST_DUP_ID/);
  assert.equal((await cli("validate", p("hancom-ph-single.hwpx"), "--strict")).code, 0);
  assert.equal((await cli("validate", p("extra-features-picture.hwpx"), "--strict", "--baseline", p("extra-features-picture.hwpx"))).code, 1);
  // 깨끗한 기준선과 견주면 이 문서의 오류는 모두 새 오류다
  assert.equal((await cli("validate", p("extra-features-picture.hwpx"), "--baseline", p("hancom-ph-single.hwpx"))).code, 1);
  const notZip = write("not-a-zip.hwpx", "ZIP이 아님");
  const r = await cli("validate", notZip, "--json");
  assert.equal(r.code, 1);
  assert.ok((JSON.parse(r.out) as { report: { errors: { code: string }[] } }).report.errors.some((e) => e.code === "PKG_NOT_ZIP"));
});

// ── 사용법 오류·읽을 수 없는 입력(종료 코드 2) ─────────────────

test("G5 종료 코드 2: 사용법 오류 — 알 수 없는 명령·옵션, 빠진 인자, 잘못된 값", async () => {
  const data = p("data.json");
  const input = p("hancom-ph-single.hwpx");
  const cases: string[][] = [
    [],
    ["없는명령"],
    ["inspect"],
    ["inspect", input, "--없는옵션"],
    ["fill", input, "-o", p("x.hwpx")],
    ["fill", input, "--data", data],
    ["fill", input, "--data", data, "-o", p("x.hwpx"), "--mode", "엄격"],
    ["fill", input, "--data", data, "-o", p("x.hwpx"), "--missing", "무시"],
    ["fill", p("data.json"), "--data", data, "-o", p("x.hwpx")],
    ["fragment"],
    ["fragment", "extract", input, "--section", "0", "--from", "1", "-o", p("x.json")],
    ["fragment", "extract", input, "--section", "x", "--from", "1", "--to", "1", "-o", p("x.json")],
    ["fragment", "import", input, p("picture-frag.json"), "--section", "0", "--index", "99", "-o", p("x.hwpx")],
    ["diff", input],
    ["compile", input],
  ];
  for (const argv of cases) {
    const r = await cli(...argv);
    assert.equal(r.code, 2, `${argv.join(" ")} → ${r.code}\n${r.err}`);
    assert.ok(r.err.length > 0);
  }
  assert.ok(!listing().includes("x.hwpx") && !listing().includes("x.md") && !listing().includes("x.json"));
  assert.equal((await cli("--help")).code, 0);
});

test("G5 종료 코드 2: 읽을 수 없는 입력 — 없는 파일, 깨진 JSON·템플릿·데이터, ZIP이 아닌 문서", async () => {
  const input = p("hancom-ph-single.hwpx");
  const ok = p("data.json");
  assert.equal((await cli("inspect", p("없는파일.hwpx"))).code, 2);
  assert.equal((await cli("validate", p("없는파일.hwpx"))).code, 2);
  assert.equal((await cli("fill", p("없는파일.hwpx"), "--data", ok, "-o", p("y.hwpx"))).code, 2);
  assert.equal((await cli("fill", input, "--data", p("없는데이터.json"), "-o", p("y.hwpx"))).code, 2);
  assert.equal((await cli("fill", input, "--data", write("broken.json", "{ 깨짐"), "-o", p("y.hwpx"))).code, 2);
  assert.equal((await cli("fill", input, "--data", ok, "--template", write("bad-t.json", JSON.stringify({ schema: "다른" })), "-o", p("y.hwpx"))).code, 2);
  assert.equal((await cli("fill", input, "--data", ok, "--template", write("bad-t2.json", JSON.stringify({ schema: "hwpx-studio/template@1", rules: [{ id: "r", do: { type: "fill", anchor: "없음", value: { text: "x" } } }] })), "-o", p("y.hwpx"))).code, 2);
  const notZip = p("not-a-zip.hwpx");
  for (const argv of [["inspect", notZip], ["candidates", notZip], ["fragment", "extract", notZip, "--section", "0", "--from", "0", "--to", "0", "-o", p("y.json")], ["compile", notZip, "-o", p("y.hwpx"), "--experimental"], ["diff", notZip, input], ["fill", notZip, "--data", ok, "-o", p("y.hwpx")]]) {
    const r = await cli(...argv);
    assert.equal(r.code, 2, `${argv.join(" ")}\n${r.err}`);
  }
  assert.ok(!listing().some((n) => n.startsWith("y.")));
});

// ── 출력 파일 안전 규칙 ────────────────────────────────────────

test("출력 파일 안전: 입력과 같은 경로 거부, --overwrite 없이는 기존 파일 보존, 임시 파일 후 이름 변경", async () => {
  const input = p("hancom-ph-single.hwpx");
  const data = p("data.json");
  const bytes = read("hancom-ph-single.hwpx");
  // 입력과 같은 경로(다른 표기 포함)
  for (const out of [input, join(dir, ".", "hancom-ph-single.hwpx"), join(dir, "tpl", "..", "hancom-ph-single.hwpx")]) {
    const r = await cli("fill", input, "--data", data, "-o", out);
    assert.equal(r.code, 2, out);
    assert.match(r.err, /입력과 같습니다/);
  }
  if (process.platform === "win32") assert.equal((await cli("fill", input, "--data", data, "-o", input.toUpperCase())).code, 2, "대소문자만 다른 같은 파일");
  assert.deepEqual(read("hancom-ph-single.hwpx"), bytes, "입력이 바뀌지 않았다");
  // 데이터·템플릿 파일을 출력으로 지정해도 거부
  assert.equal((await cli("fill", input, "--data", data, "-o", data)).code, 2);

  // 이미 있는 출력: --overwrite 없이는 거부하고 내용을 보존
  const existing = write("existing.hwpx", "기존 내용");
  const refused = await cli("fill", input, "--data", data, "-o", existing);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--overwrite/);
  assert.equal(readFileSync(existing, "utf8"), "기존 내용");
  // --overwrite면 임시 파일에 쓴 뒤 이름을 바꿔 교체하고 임시 파일이 남지 않는다
  const replaced = await cli("fill", input, "--data", data, "-o", existing, "--overwrite");
  assert.equal(replaced.code, 0, replaced.err);
  assert.ok(validateDocument(read("existing.hwpx")).errors.length === 0);
  assert.ok(!listing().some((n) => n.endsWith(".tmp")));
  // 게이트가 실패하면 --overwrite라도 기존 파일을 건드리지 않는다
  const keep = write("keep-me.hwpx", "그대로");
  assert.equal((await cli("fill", input, "--data", p("partial.json"), "-o", keep, "--overwrite")).code, 1);
  assert.equal(readFileSync(keep, "utf8"), "그대로");
  // 출력 폴더가 없으면 거부하고 아무것도 만들지 않는다
  const noDir = await cli("fill", input, "--data", data, "-o", p("없는폴더/out.hwpx"));
  assert.equal(noDir.code, 2);
  assert.ok(!existsSync(p("없는폴더")));
  // 출력 경로가 폴더이면 거부
  assert.equal((await cli("fill", input, "--data", data, "-o", p("tpl"), "--overwrite")).code, 2);
  // --report도 같은 규칙을 따른다
  assert.equal((await cli("fill", input, "--data", data, "-o", p("rr.hwpx"), "--report", data)).code, 2);
  assert.ok(!existsSync(p("rr.hwpx")));
});

// ── md·txt와 조각 옵션 (C1~C8) ──────────────────────────────────
// 기대값은 시험 자료(fixtures/text)의 글에서 자리만 직접 바꿔 만든다. 엔진의 출력에 맞춰 정하지 않는다.

const NOTICE = readFileSync(join(FIXTURES, "text/notice.md"), "utf8");
const MEMO = readFileSync(join(FIXTURES, "text/memo.txt"), "utf8");
const TEXT_DATA = {
  project: { name: "알파", start: "2026-01-01", end: "2026-12-31" },
  owner: { name: "김하늘" },
  applicant: { name: "이서연" },
  table: { a: "가", b: "나" },
  opt: "선택",
};
/** notice.md에서 데이터로 채워지는 자리만 바꾼 글(코드 블록 안의 `{{}}`는 그대로) */
const noticeFilled = (text: string): string =>
  text
    .replace("{{project.name}} 안내", "알파 안내")
    .replace("{{applicant.name}}", "이서연")
    .replace("{{project.start}} ~ {{project.end}}", "2026-01-01 ~ 2026-12-31")
    .replace("{{table.a}}", "가")
    .replace("{{table.b}}", "나");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const lineAnchor = (id: string, ordinal: number, logical: string) => ({
  id,
  kind: "line",
  at: { sectionIndex: 0, path: [ordinal] },
  print: { text: logical.slice(0, 40), sha256: sha(logical) },
});
const fileBytes = (path: string): Buffer => readFileSync(path);

test("C1 fill .md·.txt: 채워서 저장한다(종료 코드 0). BOM·CRLF를 그대로 두고, 보고서·화면에 값 원문이 없다", async () => {
  const data = write("text-data.json", JSON.stringify(TEXT_DATA));
  // .md (LF)
  const out = p("notice-out.md");
  const report = p("notice-report.json");
  const r = await cli("fill", p("notice.md"), "--data", data, "-o", out, "--report", report);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(out, "utf8"), noticeFilled(NOTICE));
  assert.match(r.out, /형식: md/);
  const raw = readFileSync(report, "utf8");
  const saved = JSON.parse(raw) as { ok: boolean; dryRun: boolean; report: { kind: string } };
  assert.deepEqual([saved.ok, saved.dryRun, saved.report.kind], [true, false, "md"]);
  for (const value of ["알파", "이서연", "2026-01-01", "2026-12-31"]) assert.ok(!raw.includes(value) && !r.out.includes(value), `값 원문이 새어 나왔다: ${value}`);

  // BOM과 CRLF는 그대로(입력이 BOM이면 출력도 BOM, 줄바꿈은 모두 CRLF)
  write("notice-crlf.md", `﻿${NOTICE.replace(/\n/g, "\r\n")}`);
  const c = await cli("fill", p("notice-crlf.md"), "--data", data, "-o", p("notice-crlf-out.md"));
  assert.equal(c.code, 0, c.err);
  const bytes = fileBytes(p("notice-crlf-out.md"));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM 유지");
  assert.ok(bytes.equals(Buffer.from(`﻿${noticeFilled(NOTICE).replace(/\n/g, "\r\n")}`, "utf8")), "내용과 CRLF 보존");
  assert.equal(bytes.toString("utf8").replace(/\r\n/g, "").includes("\n"), false, "LF만 있는 줄바꿈이 생기지 않았다");

  // .txt
  const t = await cli("fill", p("memo.txt"), "--data", data, "-o", p("memo-out.txt"));
  assert.equal(t.code, 0, t.err);
  assert.equal(readFileSync(p("memo-out.txt"), "utf8"), MEMO.replace("{{project.name}}", "알파").replace("{{owner.name}}", "김하늘").replace("{{opt}}", "선택"));
  assert.match(t.out, /형식: txt/);

  // 확장자는 대소문자를 가리지 않고, --dry-run은 출력 파일 없이 보고만 한다
  write("UPPER.MD", "{{project.name}}\n");
  const dry = await cli("fill", p("UPPER.MD"), "--data", data, "--dry-run");
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /모의 실행/);
  assert.match(dry.out, /필요한 데이터 경로: project\.name/);
  assert.equal((await cli("fill", p("UPPER.MD"), "--data", data, "-o", p("upper-out.md"))).code, 0);
  assert.equal(readFileSync(p("upper-out.md"), "utf8"), "알파\n");

  // --fill-in-code: 코드 블록 안의 {{}}도 채운다(기본은 그대로)
  const code = await cli("fill", p("notice.md"), "--data", data, "-o", p("notice-code.md"), "--fill-in-code");
  assert.equal(code.code, 0, code.err);
  assert.equal(readFileSync(p("notice-code.md"), "utf8"), noticeFilled(NOTICE).replace("코드 안의 {{project.name}}는", "코드 안의 알파는"));

  // 출력 파일 안전 규칙은 텍스트에도 같다
  const same = await cli("fill", p("notice.md"), "--data", data, "-o", p("notice.md"), "--overwrite");
  assert.equal(same.code, 2);
  assert.match(same.err, /입력과 같습니다/);
  assert.equal(readFileSync(p("notice.md"), "utf8"), NOTICE, "입력이 바뀌지 않았다");
  const exists = await cli("fill", p("notice.md"), "--data", data, "-o", out);
  assert.equal(exists.code, 2);
  assert.match(exists.err, /--overwrite/);
  assert.equal((await cli("fill", p("notice.md"), "--data", data, "-o", out, "--overwrite")).code, 0);
  assert.ok(!listing().some((n) => n.endsWith(".tmp")), "임시 파일이 남았다");
});

test("C2 fill .md: 누락 키는 error면 종료 코드 1(출력 없음), --missing empty·keep은 성공(0)", async () => {
  const partial = write("text-partial.json", JSON.stringify({ ...TEXT_DATA, project: { name: "알파", start: "2026-01-01" } }));
  const e = await cli("fill", p("notice.md"), "--data", partial, "-o", p("never-text.md"), "--report", p("text-fail-report.json"));
  assert.equal(e.code, 1);
  assert.match(e.err, /DATA_MISSING/);
  assert.match(e.err, /출력 파일을 만들지 않았습니다/);
  assert.ok(!existsSync(p("never-text.md")));
  assert.ok(!listing().some((n) => n.endsWith(".tmp")), "임시 파일이 남았다");
  const saved = JSON.parse(readFileSync(p("text-fail-report.json"), "utf8")) as { ok: boolean };
  assert.equal(saved.ok, false, "게이트가 실패해도 보고서는 쓴다");

  const empty = await cli("fill", p("notice.md"), "--data", partial, "-o", p("text-empty.md"), "--missing", "empty");
  assert.equal(empty.code, 0, empty.err);
  assert.equal(readFileSync(p("text-empty.md"), "utf8"), noticeFilled(NOTICE).replace("2026-01-01 ~ 2026-12-31", "2026-01-01 ~ "));
  const keep = await cli("fill", p("notice.md"), "--data", partial, "-o", p("text-keep.md"), "--missing", "keep");
  assert.equal(keep.code, 0, keep.err);
  assert.equal(readFileSync(p("text-keep.md"), "utf8"), noticeFilled(NOTICE).replace("2026-01-01 ~ 2026-12-31", "2026-01-01 ~ {{project.end}}"));
});

test("C3 사용법(종료 코드 2): 텍스트에 --mode·--reissue-internal, .hwpx에 --fill-in-code, md·txt에 .hwpx 전용 명령", async () => {
  const data = p("text-data.json");
  const md = p("notice.md");
  const hwpx = p("hancom-ph-single.hwpx");
  const cases: { argv: string[]; message: RegExp }[] = [
    { argv: ["fill", md, "--data", data, "-o", p("c3-out.md"), "--mode", "strict"], message: /--mode/ },
    { argv: ["fill", md, "--data", data, "-o", p("c3-out.md"), "--reissue-internal"], message: /--reissue-internal/ },
    { argv: ["fill", p("memo.txt"), "--data", data, "-o", p("c3-out.txt"), "--mode", "baseline"], message: /--mode/ },
    { argv: ["fill", hwpx, "--data", data, "-o", p("c3-out.hwpx"), "--fill-in-code"], message: /--fill-in-code/ },
    { argv: ["inspect", md, "--model", p("c3-model.json")], message: /--model/ },
    { argv: ["validate", md], message: /\.hwpx/ },
    { argv: ["validate", hwpx, "--baseline", md], message: /\.hwpx/ },
    { argv: ["candidates", md], message: /\.hwpx/ },
    { argv: ["diff", md, hwpx], message: /\.hwpx/ },
    { argv: ["diff", hwpx, p("memo.txt")], message: /\.hwpx/ },
    { argv: ["compile", md, "-o", p("c3-out.hwpx"), "--experimental"], message: /\.hwpx/ },
    { argv: ["fragment", "extract", md, "--section", "0", "--from", "0", "--to", "0", "-o", p("c3-frag.json")], message: /\.hwpx/ },
    { argv: ["fragment", "import", p("memo.txt"), p("data.json"), "--section", "0", "--index", "0", "-o", p("c3-out.hwpx")], message: /\.hwpx/ },
  ];
  for (const { argv, message } of cases) {
    const r = await cli(...argv);
    assert.equal(r.code, 2, `${argv.join(" ")} → ${r.code}\n${r.out}`);
    assert.match(r.err, message, argv.join(" "));
  }
  const created = listing().filter((n) => n.startsWith("c3-"));
  assert.deepEqual(created, [], "사용법 오류에서는 아무 파일도 만들지 않는다");
});

test("C4 fill .md 템플릿: 조건에 따른 블록 삭제와 텍스트 조각 주입(조각 경로는 템플릿 폴더 기준, 조각 파일은 입력으로 보호)", async () => {
  mkdirSync(p("tpl-text/fragments"), { recursive: true });
  const fragmentFile = p("tpl-text/fragments/terms.json");
  const fragmentJson = JSON.stringify({ schema: "hwpx-studio/text-fragment@1", blocks: ["### 용역 조항", "- {{owner.name}}가 수행한다.\n- 기간 내 완료"] });
  writeFileSync(fragmentFile, fragmentJson);
  const off = { path: "terms.optional", op: "eq", value: false };
  const template = write("tpl-text/t.json", JSON.stringify({
    schema: "hwpx-studio/template@1",
    anchors: [lineAnchor("head", 3, "## 선택 조항"), lineAnchor("body", 4, "선택 조항 본문입니다. (해당 시)"), lineAnchor("period", 2, "기간: {{project.start}} ~ {{project.end}}")],
    rules: [
      { id: "r1", when: off, do: { type: "delete", anchor: "head" } },
      { id: "r2", when: off, do: { type: "delete", anchor: "body" } },
      { id: "r3", when: { path: "contract.type", op: "eq", value: "용역" }, do: { type: "inject", anchor: "period", position: "after", fragment: "fragments/terms.json" } },
    ],
  }));

  const data = write("text-cond-data.json", JSON.stringify({ ...TEXT_DATA, terms: { optional: false }, contract: { type: "용역" } }));
  const r = await cli("fill", p("notice.md"), "--data", data, "--template", template, "-o", p("tpl-text-out.md"));
  assert.equal(r.code, 0, r.err);
  const expected = noticeFilled(NOTICE)
    .replace("## 선택 조항\n\n선택 조항 본문입니다. (해당 시)\n\n", "")
    .replace("기간: 2026-01-01 ~ 2026-12-31\n\n", "기간: 2026-01-01 ~ 2026-12-31\n\n### 용역 조항\n\n- 김하늘가 수행한다.\n- 기간 내 완료\n\n");
  assert.equal(readFileSync(p("tpl-text-out.md"), "utf8"), expected);

  // 조건이 거짓이면 삭제도 주입도 하지 않는다(채움만)
  const other = write("text-cond-data2.json", JSON.stringify({ ...TEXT_DATA, terms: { optional: true }, contract: { type: "물품" } }));
  assert.equal((await cli("fill", p("notice.md"), "--data", other, "--template", template, "-o", p("tpl-text-out2.md"))).code, 0);
  assert.equal(readFileSync(p("tpl-text-out2.md"), "utf8"), noticeFilled(NOTICE));

  // 조각 파일을 출력으로 지정하면 --overwrite라도 거부하고 조각 파일을 건드리지 않는다
  const clobber = await cli("fill", p("notice.md"), "--data", data, "--template", template, "-o", fragmentFile, "--overwrite");
  assert.equal(clobber.code, 2);
  assert.match(clobber.err, /입력과 같습니다/);
  assert.equal(readFileSync(fragmentFile, "utf8"), fragmentJson);

  // 조각 파일이 없으면 읽을 수 없는 입력(2)
  rmSync(fragmentFile);
  const missing = await cli("fill", p("notice.md"), "--data", data, "--template", template, "-o", p("tpl-text-out3.md"));
  assert.equal(missing.code, 2);
  assert.ok(!existsSync(p("tpl-text-out3.md")));
});

test("C5 inspect .md·.txt: 블록·표·코드 블록 수와 {{}} 목록", async () => {
  const md = await cli("inspect", p("notice.md"), "--json");
  assert.equal(md.code, 0, md.err);
  const summary = JSON.parse(md.out) as { kind: string; blocks: number; tables: number; codeBlocks: number; placeholders: { path: string; count: number }[]; placeholdersInCode: number };
  // 제목 2, 문단 3, 표 1, 코드 블록 1, 끝맺음 문단 1 = 블록 8개(빈 줄은 블록이 아니다)
  assert.deepEqual([summary.kind, summary.blocks, summary.tables, summary.codeBlocks], ["md", 8, 1, 1]);
  assert.deepEqual(summary.placeholders, ["applicant.name", "project.end", "project.name", "project.start", "table.a", "table.b"].map((path) => ({ path, count: 1 })));
  assert.equal(summary.placeholdersInCode, 1, "코드 블록 안의 {{project.name}}는 따로 센다");

  const text = await cli("inspect", p("notice.md"));
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /블록 8개, 표 1개, 코드 블록 1개/);
  assert.match(text.out, /\{\{\}\} 표기 6종/);
  assert.match(text.out, /project\.name x1/);
  assert.match(text.out, /코드 블록 안의 \{\{\}\} 표기 1곳/);

  // txt: 줄 하나가 블록이다(빈 줄 포함)
  const txt = JSON.parse((await cli("inspect", p("memo.txt"), "--json")).out) as typeof summary;
  assert.deepEqual([txt.kind, txt.blocks, txt.tables, txt.codeBlocks, txt.placeholdersInCode], ["txt", 6, 0, 0, 0]);
  assert.deepEqual(txt.placeholders, [{ path: "opt", count: 1 }, { path: "owner.name", count: 1 }, { path: "project.name", count: 1 }]);
});

/** 합성 문단 하나(`inner`는 run 안의 개체, `ref`는 글자모양 참조) */
const synthPara = (id: string, inner: string, ref = "0"): string =>
  `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${ref}">${inner}<hp:t>x</hp:t></hp:run></hp:p>`;
const fragmentOf = (...paragraphs: string[]): string =>
  serializeFragment(extractFragment(parseSynthetic([paragraphs.join("")]), { sectionIndex: 0, parentPath: [], from: 0, to: paragraphs.length - 1 }));
type InheritedJson = { duplicateIds: { role: string; value: string; count: number }[]; danglingRefs: { kind: string; id: string; count: number }[]; errors: { code: string }[] };
const inheritedOf = (name: string): InheritedJson => (JSON.parse(readFileSync(p(name), "utf8")) as { report: { inherited: InheritedJson } }).report.inherited;

test("C6 --reissue-internal: 같은 id의 도형 둘이 든 조각은 옵션 없이는 상속 중복으로 보고되고, 옵션을 주면 없다(fragment import·fill, 종료 코드 0)", async () => {
  const frag = write("dup-frag.json", fragmentOf(synthPara("1", '<hp:rect id="2"/><hp:rect id="2"/>')));
  const at = ["--section", "0", "--index", "3"];

  const off = await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, ...at, "-o", p("dup-off.hwpx"), "--report", p("dup-off.json"));
  assert.equal(off.code, 0, off.err);
  assert.deepEqual(inheritedOf("dup-off.json").duplicateIds, [{ role: "object", value: "2", count: 2 }]);
  assert.deepEqual(inheritedOf("dup-off.json").errors.map((e) => e.code), ["INST_DUP_ID"]);
  assert.deepEqual(validateDocument(read("dup-off.hwpx")).errors.map((e) => e.code), ["INST_DUP_ID"]);

  const on = await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, ...at, "-o", p("dup-on.hwpx"), "--report", p("dup-on.json"), "--reissue-internal");
  assert.equal(on.code, 0, on.err);
  assert.deepEqual(inheritedOf("dup-on.json"), { duplicateIds: [], danglingRefs: [], errors: [] });
  assert.ok(!/상속한 문제/.test(on.out), on.out);
  assert.deepEqual(validateDocument(read("dup-on.hwpx")).errors, []);
  assert.equal(doc("dup-on.hwpx").sections[0]?.paragraphs.length, 7, "조각 문단 1개가 앵커 뒤에 들어갔다");
  // 엄격 방식은 상속한 오류를 막지만, 재발급하면 통과한다
  assert.equal((await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, ...at, "-o", p("dup-strict-off.hwpx"), "--mode", "strict")).code, 1);
  assert.ok(!existsSync(p("dup-strict-off.hwpx")));
  const strictOn = await cli("fragment", "import", p("hancom-blocks.hwpx"), frag, ...at, "-o", p("dup-strict-on.hwpx"), "--mode", "strict", "--reissue-internal");
  assert.equal(strictOn.code, 0, `${strictOn.out}\n${strictOn.err}`);

  // fill: 템플릿의 inject에 적용한다
  mkdirSync(p("tpl-dup"), { recursive: true });
  copyFileSync(frag, p("tpl-dup/dup.json"));
  const anchorText = "선택 조항 본문입니다. (해당 시)";
  const template = write("tpl-dup/t.json", JSON.stringify({
    schema: "hwpx-studio/template@1",
    anchors: [lineAnchor("l", 3, anchorText)],
    rules: [{ id: "r", do: { type: "inject", anchor: "l", position: "after", fragment: "dup.json" } }],
  }));
  const none = write("empty-data.json", "{}");
  const fillOff = await cli("fill", p("hancom-blocks.hwpx"), "--data", none, "--template", template, "-o", p("fill-dup-off.hwpx"), "--report", p("fill-dup-off.json"));
  assert.equal(fillOff.code, 0, fillOff.err);
  assert.deepEqual(inheritedOf("fill-dup-off.json").duplicateIds, [{ role: "object", value: "2", count: 2 }]);
  const fillOn = await cli("fill", p("hancom-blocks.hwpx"), "--data", none, "--template", template, "-o", p("fill-dup-on.hwpx"), "--report", p("fill-dup-on.json"), "--reissue-internal");
  assert.equal(fillOn.code, 0, fillOn.err);
  assert.deepEqual(inheritedOf("fill-dup-on.json"), { duplicateIds: [], danglingRefs: [], errors: [] });
  assert.deepEqual(validateDocument(read("fill-dup-on.hwpx")).errors, []);
  assert.equal(doc("fill-dup-on.hwpx").sections[0]?.paragraphs.length, 7);
});

test("C7 fragment import --report: 게이트 보고서를 쓴다(상속 항목 포함). 게이트가 실패해도 보고서는 쓰고 출력 파일은 없다", async () => {
  // 소스가 이미 가진 문제: 같은 id의 도형 둘, 없는 글자모양 9번
  const frag = write("inherited-frag2.json", fragmentOf(synthPara("11", '<hp:rect id="2"/><hp:rect id="2"/>'), synthPara("12", "", "9")));
  const args = [p("hancom-blocks.hwpx"), frag, "--section", "0", "--index", "3"];
  const out = p("c7-out.hwpx");
  const report = p("c7-report.json");
  const r = await cli("fragment", "import", ...args, "-o", out, "--report", report);
  assert.equal(r.code, 0, r.err);
  const saved = JSON.parse(readFileSync(report, "utf8")) as { ok: boolean; dryRun: boolean; ledger: { output: { sha256: string } }; report: { mode: string; inherited: InheritedJson } };
  assert.deepEqual([saved.ok, saved.dryRun, saved.report.mode], [true, false, "baseline"]);
  assert.equal(saved.ledger.output.sha256.length, 64);
  assert.deepEqual(saved.report.inherited.duplicateIds, [{ role: "object", value: "2", count: 2 }]);
  assert.deepEqual(saved.report.inherited.danglingRefs, [{ kind: "charPr", id: "9", count: 1 }]);
  assert.deepEqual(saved.report.inherited.errors.map((e) => e.code).sort(), ["INST_DUP_ID", "RES_DANGLING"]);
  assert.ok(existsSync(out));

  // 게이트 실패(strict는 상속한 오류도 막는다): 보고서는 쓰고 출력 파일은 없다
  const failedOut = p("c7-strict.hwpx");
  const failedReport = p("c7-strict-report.json");
  const f = await cli("fragment", "import", ...args, "-o", failedOut, "--report", failedReport, "--mode", "strict");
  assert.equal(f.code, 1);
  assert.ok(!existsSync(failedOut));
  assert.ok(!listing().some((n) => n.endsWith(".tmp")), "임시 파일이 남았다");
  const failed = JSON.parse(readFileSync(failedReport, "utf8")) as { ok: boolean; ledger?: unknown; report: { mode: string; inherited: InheritedJson; issues: { code: string }[] } };
  assert.equal(failed.ok, false);
  assert.equal(failed.ledger, undefined);
  assert.equal(failed.report.mode, "strict");
  assert.deepEqual(failed.report.inherited.duplicateIds, [{ role: "object", value: "2", count: 2 }], "strict에서도 상속 항목은 기록한다");
  assert.ok(failed.report.issues.some((i) => i.code === "GATE_ERRORS"));

  // 보고서 경로도 출력 파일 안전 규칙을 따른다
  const same = await cli("fragment", "import", ...args, "-o", p("c7-same.hwpx"), "--report", p("c7-same.hwpx"));
  assert.equal(same.code, 2);
  assert.ok(!existsSync(p("c7-same.hwpx")));
  assert.equal((await cli("fragment", "import", ...args, "-o", p("c7-again.hwpx"), "--report", frag)).code, 2, "입력 파일을 보고서 경로로 쓸 수 없다");
  const before = readFileSync(report, "utf8");
  const exists = await cli("fragment", "import", ...args, "-o", p("c7-again.hwpx"), "--report", report);
  assert.equal(exists.code, 2);
  assert.match(exists.err, /--overwrite/);
  assert.equal(readFileSync(report, "utf8"), before);
  assert.ok(!existsSync(p("c7-again.hwpx")));
  assert.equal((await cli("fragment", "import", ...args, "-o", p("c7-again.hwpx"), "--report", report, "--overwrite")).code, 0);
});

test("C8 UTF-8이 아닌 텍스트 입력은 종료 코드 2(fill·inspect), 출력 파일 없음", async () => {
  const data = p("text-data.json");
  // CP949로 저장한 "A가"와 BOM이 있는 UTF-16 글: 둘 다 UTF-8로 읽을 수 없다
  writeFileSync(p("cp949.txt"), Buffer.from([0x41, 0xb0, 0xa1, 0x0a]));
  writeFileSync(p("utf16.md"), Buffer.from("﻿안녕 {{project.name}}\n", "utf16le"));
  for (const name of ["cp949.txt", "utf16.md"]) {
    const f = await cli("fill", p(name), "--data", data, "-o", p(`c8-${name}`));
    assert.equal(f.code, 2, `${name}\n${f.out}`);
    assert.match(f.err, /UTF-8/);
    assert.ok(!existsSync(p(`c8-${name}`)));
    const i = await cli("inspect", p(name));
    assert.equal(i.code, 2, name);
    assert.match(i.err, /UTF-8/);
    const d = await cli("fill", p(name), "--data", data, "--dry-run");
    assert.equal(d.code, 2, name);
  }
  assert.ok(!listing().some((n) => n.startsWith("c8-") || n.endsWith(".tmp")));
});

// ── 실제 프로세스 ──────────────────────────────────────────────

test("G5 bin 진입점: 실제 프로세스의 종료 코드 0·1·2", () => {
  const exec = (...args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8" });
  const ok = exec("inspect", p("hancom-ph-single.hwpx"), "--json");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal((JSON.parse(ok.stdout) as { sections: number }).sections, 1);
  assert.equal(exec("validate", p("extra-features-picture.hwpx")).status, 1);
  assert.equal(exec("없는명령").status, 2);
  assert.equal(exec("fill", p("hancom-ph-single.hwpx"), "--data", p("data.json"), "-o", p("proc-out.hwpx")).status, 0);
  assert.ok(existsSync(p("proc-out.hwpx")));
  const zip = readArchive(read("proc-out.hwpx"));
  assert.ok(new TextDecoder().decode(readEntry(zip, read("proc-out.hwpx"), "Contents/section0.xml")).includes("알파"));
});
