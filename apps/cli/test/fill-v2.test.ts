// fill --template t2.json(template@2) --case --data --blobs(엔진 명세 8.4·8.8.12). 시험은 임시 폴더의 사본으로만 한다.
// 기대: API(generateFromTemplate)와 같은 바이트·원장, 종료 코드 0 성공·1 생성 실패(출력 없음)·2 사용법·읽을 수 없는 입력, @1 템플릿은 기존 동작 그대로.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { run } from "../src/cli.ts";
import { generateFromTemplate } from "../../../packages/hwpx-engine/src/fill/index.ts";
import { writeCase, writeStudioTemplate } from "../../../packages/hwpx-engine/src/template/index.ts";
import { caseOf, loaderOf, manual, noticeKit, randomText, recordFor, type NoticeKit } from "../../../packages/hwpx-engine/test/generate-v2-helpers.ts";
import { rng } from "../../../packages/hwpx-engine/test/range-helpers.ts";

let root = "";
let kit: NoticeKit;
before(() => {
  root = mkdtempSync(join(tmpdir(), "hwpx-cli-v2-"));
  kit = noticeKit();
});
after(() => rmSync(root, { recursive: true, force: true }));

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { log: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

let counter = 0;
/** 시험마다 새 작업 폴더: 원본 notice.hwpx, 템플릿 t2.json, 덩어리 폴더 blobs/, 데이터 data.json(한 건), 이번 건 case.json */
function workspace(seed = 1) {
  const dir = join(root, `w${counter++}`);
  mkdirSync(join(dir, "blobs"), { recursive: true });
  const p = (name: string): string => join(dir, name);
  writeFileSync(p("notice.hwpx"), kit.bytes);
  writeFileSync(p("t2.json"), writeStudioTemplate(kit.t));
  for (const [sha, bytes] of kit.blobs) writeFileSync(join(dir, "blobs", `${sha}.json`), bytes);
  const record = recordFor(randomText(rng(seed)), { price: 60000000 });
  const c = caseOf(kit.t, record, { selections: { s2: manual(kit.t, "s2", "b3") } });
  writeFileSync(p("data.json"), JSON.stringify(record));
  writeFileSync(p("case.json"), writeCase(c));
  const args = (...extra: string[]): string[] => ["fill", p("notice.hwpx"), "--template", p("t2.json"), "--case", p("case.json"), "--data", p("data.json"), "--blobs", p("blobs"), ...extra];
  return { dir, p, record, c, args };
}

test("W1: CLI의 2판 생성은 API와 같은 바이트·원장이고(보고서에 값 원문 없음), --dry-run은 출력 없이 0", async () => {
  const w = workspace(3);
  const r = await cli(...w.args("-o", w.p("out.hwpx"), "--report", w.p("r.json")));
  assert.equal(r.code, 0, r.err);
  const api = generateFromTemplate(kit.bytes, kit.t, w.record, w.c, loaderOf(kit.blobs));
  assert.ok(api.ok && !api.dryRun);
  assert.ok(Buffer.from(readFileSync(w.p("out.hwpx"))).equals(Buffer.from(api.output as Uint8Array)));
  const saved = JSON.parse(readFileSync(w.p("r.json"), "utf8")) as { ok: boolean; ledger: unknown; report: { selections: unknown[] } };
  assert.equal(saved.ok, true);
  assert.equal(JSON.stringify(saved.ledger), JSON.stringify(api.ledger));
  assert.equal(saved.report.selections.length, 4);
  const text = readFileSync(w.p("r.json"), "utf8") + r.out + r.err;
  for (const v of Object.values(w.record)) if (typeof v === "string" && v.length > 20) assert.ok(!text.includes(JSON.stringify(v).slice(1, 21)), "값 원문이 보고서·화면에 나왔다");
  assert.match(r.out, /2판 템플릿 생성\(hwpx\)/);
  assert.match(r.out, /빠진 자리 \[PLACE_COVERED\]/);

  const dry = await cli(...w.args("--dry-run"));
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /모의 실행/);
  // 같은 입력을 다시 돌리면 같은 바이트(--overwrite)
  assert.equal((await cli(...w.args("-o", w.p("out.hwpx"), "--overwrite"))).code, 0);
  assert.ok(Buffer.from(readFileSync(w.p("out.hwpx"))).equals(Buffer.from(api.output as Uint8Array)));
  // --case 없이: 선택을 전부 계산하므로 s2(조건 없는 블록 둘)가 동률이라 실패(1)
  const noCase = await cli("fill", w.p("notice.hwpx"), "--template", w.p("t2.json"), "--data", w.p("data.json"), "--blobs", w.p("blobs"), "-o", w.p("nc.hwpx"));
  assert.equal(noCase.code, 1);
  assert.match(noCase.err, /SEL_UNDECIDED/);
  assert.ok(!existsSync(w.p("nc.hwpx")));
});

test("종료 코드 2: @1 템플릿에 --case·--blobs, @2에 배열 데이터·--batch·--mode·--missing, 덩어리 파일을 출력으로, 없는 덩어리(읽기 검사), 없는 --blobs 폴더, 지원하지 않는 판", async () => {
  const w = workspace();
  const out = w.p("out.hwpx");
  const v1 = w.p("t1.json");
  writeFileSync(v1, JSON.stringify({ schema: "hwpx-studio/template@1", anchors: [], rules: [] }));
  const [sha] = [...kit.blobs.keys()];
  assert.ok(sha !== undefined);
  const arrayData = w.p("rows.json");
  writeFileSync(arrayData, JSON.stringify([w.record, w.record]));
  const emptyBlobs = join(w.dir, "empty");
  mkdirSync(emptyBlobs);
  const v3 = w.p("t3.json");
  writeFileSync(v3, writeStudioTemplate(kit.t).replace("hwpx-studio/template@2", "hwpx-studio/template@3"));
  const cases: string[][] = [
    ["fill", w.p("notice.hwpx"), "--template", v1, "--data", w.p("data.json"), "--case", w.p("case.json"), "-o", out],
    ["fill", w.p("notice.hwpx"), "--template", v1, "--data", w.p("data.json"), "--blobs", w.p("blobs"), "-o", out],
    ["fill", w.p("notice.hwpx"), "--template", w.p("t2.json"), "--data", arrayData, "--blobs", w.p("blobs"), "--case", w.p("case.json"), "-o", out],
    w.args("--batch", "-o", w.dir),
    w.args("--mode", "strict", "-o", out),
    w.args("--missing", "keep", "-o", out),
    w.args("-o", join(w.dir, "blobs", `${sha}.json`), "--overwrite"),
    w.args("-o", out, "--report", join(w.dir, "blobs", `${sha}.json`), "--overwrite"),
    ["fill", w.p("notice.hwpx"), "--template", w.p("t2.json"), "--case", w.p("case.json"), "--data", w.p("data.json"), "--blobs", emptyBlobs, "-o", out],
    ["fill", w.p("notice.hwpx"), "--template", w.p("t2.json"), "--case", w.p("case.json"), "--data", w.p("data.json"), "-o", out],
    ["fill", w.p("notice.hwpx"), "--template", w.p("t2.json"), "--case", w.p("case.json"), "--data", w.p("data.json"), "--blobs", join(w.dir, "nope"), "-o", out],
    ["fill", w.p("notice.hwpx"), "--template", v3, "--data", w.p("data.json"), "-o", out],
    w.args(), // -o 없음
  ];
  for (const argv of cases) {
    const r = await cli(...argv);
    assert.equal(r.code, 2, `${argv.slice(2).join(" ")}\n${r.out}\n${r.err}`);
  }
  assert.ok(!existsSync(out));
  assert.ok(Buffer.from(readFileSync(join(w.dir, "blobs", `${sha}.json`))).equals(Buffer.from(kit.blobs.get(sha) ?? [])), "덩어리 파일이 바뀌었다");
  const missing = await cli(...cases[8]!);
  assert.match(missing.err, /TPL_FRAGMENT_MISSING/);
  const version = await cli(...cases[11]!);
  assert.match(version.err, /TPL_VERSION/);
});

test("종료 코드 1(출력 없음, --report는 쓴다): 원본 해시가 다름, 받은 덩어리의 해시가 다름, 등록되지 않은 {{ }}", async () => {
  const w = workspace();
  const out = w.p("out.hwpx");
  // 원본 해시: 다른 문서
  writeFileSync(w.p("other.hwpx"), readFileSync(new URL("../../../packages/hwpx-engine/test/fixtures/merge/merge-fields.hwpx", import.meta.url)));
  const other = await cli("fill", w.p("other.hwpx"), ...w.args("-o", out, "--report", w.p("r1.json")).slice(2));
  assert.equal(other.code, 1, other.err);
  assert.match(other.err, /TPL_SOURCE_MISMATCH/);
  assert.equal((JSON.parse(readFileSync(w.p("r1.json"), "utf8")) as { ok: boolean }).ok, false);
  // 덩어리 바이트가 해시와 다름(파일은 있다)
  const b3 = kit.t.blocks.find((b) => b.id === "b3");
  assert.ok(b3 !== undefined && "fragment" in b3.content);
  const file = join(w.dir, "blobs", `${b3.content.fragment}.json`);
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(" ")]));
  const tampered = await cli(...w.args("-o", out));
  assert.equal(tampered.code, 1);
  assert.match(tampered.err, /TPL_FRAGMENT_MISSING/);
  writeFileSync(file, kit.blobs.get(b3.content.fragment) ?? new Uint8Array());
  // 등록되지 않은 {{ }}: 이번 건이 고른 블록의 글을 고친다
  const c = caseOf(kit.t, w.record, { selections: w.c.selections, blockEdits: { b8: { text: "끝 {{ 미등록 }}" } } });
  writeFileSync(w.p("case.json"), writeCase(c));
  const unregistered = await cli(...w.args("-o", out));
  assert.equal(unregistered.code, 1);
  assert.match(unregistered.err, /PLACE_UNREGISTERED/);
  assert.ok(!existsSync(out));
});

test("@1 템플릿은 기존 fill 경로 그대로 동작하고, md 원본도 2판 템플릿으로 채운다", async () => {
  const w = workspace();
  const v1 = w.p("t1.json");
  writeFileSync(v1, JSON.stringify({ schema: "hwpx-studio/template@1", anchors: [], rules: [] }));
  const legacy = await cli("fill", w.p("notice.hwpx"), "--template", v1, "--data", w.p("data.json"), "--missing", "keep", "-o", w.p("v1.hwpx"));
  assert.equal(legacy.code, 0, legacy.err);
  assert.doesNotMatch(legacy.out, /2판 템플릿/);

  const md = "# {{ 제목 }}\n\n[슬롯]\n\n끝.\n";
  writeFileSync(w.p("a.md"), md);
  const sha = (await import("node:crypto")).createHash("sha256").update(md).digest("hex");
  const { linePrintOf } = await import("../../../packages/hwpx-engine/src/text/anchors.ts");
  const t = {
    schema: "hwpx-studio/template@2",
    id: "t0000c001",
    version: 1,
    source: { kind: "md", sha256: sha },
    anchors: [{ id: "a1", kind: "line", at: { sectionIndex: 0, path: [1] }, print: linePrintOf("[슬롯]") }],
    values: [{ id: "v1", name: "제목", format: "text" }],
    bindings: [{ value: "v1", key: "제목" }],
    places: [{ id: "p1", kind: "placeholder", key: "제목", value: "v1" }],
    slots: [{ id: "s1", name: "슬롯", anchors: ["a1"], parent: null }],
    blocks: [{ id: "b1", slot: "s1", name: "글", content: { text: "본문 {{제목}}" } }],
  };
  writeFileSync(w.p("md.json"), JSON.stringify(t));
  writeFileSync(w.p("md-data.json"), JSON.stringify({ 제목: "알파" }));
  const r = await cli("fill", w.p("a.md"), "--template", w.p("md.json"), "--data", w.p("md-data.json"), "-o", w.p("b.md"));
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(w.p("b.md"), "utf8"), "# 알파\n\n본문 알파\n\n끝.\n");
});
