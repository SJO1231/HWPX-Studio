// block extract|insert|list(엔진 명세 8.4·8.8.17). 저장소·입력·출력은 모두 임시 폴더에만 둔다(fixtures는 읽기만 한다).
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { makeRangeAnchor, openPackage, parseDocument, validateDocument, compareToBaseline } from "../../../packages/hwpx-engine/src/index.ts";
import { extractBlock } from "../../../packages/hwpx-engine/src/fill/index.ts";
import { readBlockProto, sha256Hex } from "../../../packages/hwpx-engine/src/template/index.ts";

const FIXTURES = fileURLToPath(new URL("../../../packages/hwpx-engine/test/fixtures/", import.meta.url));

let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "hwpx-cli-block-"));
  for (const name of ["hancom/blocks", "merge/merge-fields", "D1"]) copyFileSync(join(FIXTURES, `${name}.hwpx`), join(dir, `${name.replace("/", "-")}.hwpx`));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const p = (name: string): string => join(dir, name);
const docOf = (name: string) => parseDocument(openPackage(new Uint8Array(readFileSync(p(name)))));
const texts = (name: string): string[] => docOf(name).sections[0]?.paragraphs.map((x) => x.logicalText) ?? [];

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { log: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function store(name: string): string {
  const s = p(name);
  mkdirSync(s);
  return s;
}

test("block extract → list → insert: blocks/<id>/block.json(정규 JSON)과 <sha256>.json 덩어리, 엔진 extractBlock과 같은 원형(시각 제외), 게이트 통과", async () => {
  const s = store("store1");
  const src = p("merge-merge-fields.hwpx");
  const r = await cli("block", "extract", src, "--range", "0:1-11", "--name", "가짜 조항", "--store", s, "--id", "k0000beef", "--note", "시험");
  assert.equal(r.code, 0, r.err);
  const folder = join(s, "blocks", "k0000beef");
  const files = readdirSync(folder).sort();
  const proto = readBlockProto(readFileSync(join(folder, "block.json"), "utf8"));
  assert.ok("fragment" in proto.content);
  assert.deepEqual(files, [`${proto.content.fragment}.json`, "block.json"].sort());
  assert.equal(sha256Hex(new Uint8Array(readFileSync(join(folder, `${proto.content.fragment}.json`)))), proto.content.fragment);
  // 엔진 API와 같은 원형(떼어 낸 시각만 다르다)
  const doc = docOf("merge-merge-fields.hwpx");
  const at = proto.source?.extractedAt ?? "";
  const engine = extractBlock(doc, makeRangeAnchor(doc, 0, [], 1, 11)!, { id: "k0000beef", name: "가짜 조항", at, note: "시험" });
  assert.deepEqual(proto, engine.proto);
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const h = await cli("block", "extract", p("hancom-blocks.hwpx"), "--range", "0:2-3", "--name", "둘째", "--store", s);
  assert.equal(h.code, 0, h.err);
  const list = await cli("block", "list", "--store", s);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /k0000beef {2}1판 {2}가짜 조항 {2}출처 [0-9a-f]{10} 0:-:1-11 {2}\S+ {2}첫 저장/);
  assert.match(list.out, /블록 2개$/);
  const listed = JSON.parse((await cli("block", "list", "--store", s, "--json")).out) as { id: string }[];
  assert.equal(listed.length, 2);
  assert.ok(listed.some((b) => b.id === "k0000beef"));

  // 넣기: 같은 한컴 기본 서식이면 서식 경고 없음
  const before = texts("hancom-blocks.hwpx");
  const ins = await cli("block", "insert", p("hancom-blocks.hwpx"), "--store", s, "--block", "k0000beef", "--section", "0", "--index", "1", "-o", p("out1.hwpx"), "--report", p("out1.json"));
  assert.equal(ins.code, 0, ins.err);
  assert.ok(!ins.out.includes("BLOCK_FORMAT_DIFFERS"));
  // 데이터 없이 넣으므로 블록·문서의 {{ }}가 있어도 '데이터에 없던 경로' 줄은 없다(#139)
  assert.match(ins.out, /필요한 데이터 경로: /);
  assert.doesNotMatch(ins.out, /데이터에 없던 경로/);
  assert.deepEqual(texts("out1.hwpx"), [...before.slice(0, 2), ...texts("merge-merge-fields.hwpx").slice(1, 12), ...before.slice(2)]);
  const report = JSON.parse(readFileSync(p("out1.json"), "utf8")) as { ok: boolean; block: { id: string; version: number; formatDiffs: unknown[] } };
  assert.deepEqual([report.ok, report.block.id, report.block.version, report.block.formatDiffs], [true, "k0000beef", 1, []]);
  const newErrors = compareToBaseline(validateDocument(new Uint8Array(readFileSync(p("hancom-blocks.hwpx")))), validateDocument(new Uint8Array(readFileSync(p("out1.hwpx"))))).newErrors;
  assert.deepEqual(newErrors.map((e) => e.code), []);
});

test("block insert: 서식이 다른 자리면 경고와 차이 목록만 내고(자동 변경 없음) 종료 코드 0. --range는 범위를 블록으로 바꾼다", async () => {
  const s = store("store2");
  assert.equal((await cli("block", "extract", p("D1.hwpx"), "--range", "0:2-4", "--name", "D1 조항", "--store", s, "--id", "k0000d001")).code, 0);
  const r = await cli("block", "insert", p("hancom-blocks.hwpx"), "--store", s, "--block", "k0000d001", "--range", "0:2-3", "-o", p("out2.hwpx"), "--report", p("out2.json"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /서식 차이: 블록 문단 1의 문단 모양/);
  assert.match(r.out, /경고 \[BLOCK_FORMAT_DIFFERS\] 서식이 다릅니다, 확인하세요/);
  const report = JSON.parse(readFileSync(p("out2.json"), "utf8")) as { block: { formatDiffs: { paragraph: number; property: string }[] } };
  assert.ok(report.block.formatDiffs.length > 0);
  // 출력 줄의 문단 번호는 1부터(화면과 같다, #139), 보고서는 0부터 그대로
  const shown = [...r.out.matchAll(/서식 차이: 블록 문단 (\d+)의/g)].map((m) => Number(m[1]));
  assert.deepEqual(shown, report.block.formatDiffs.map((d) => d.paragraph + 1));
  assert.ok(report.block.formatDiffs.some((d) => d.paragraph === 0));
  const before = texts("hancom-blocks.hwpx");
  assert.deepEqual(texts("out2.hwpx"), [...before.slice(0, 2), ...texts("D1.hwpx").slice(2, 5), ...before.slice(4)]);
});

test("block 종료 코드: 사용법·저장소·입력 오류는 2, 조각 계약 거절은 1. 실패하면 블록 폴더·출력 파일이 남지 않는다", async () => {
  const s = store("store3");
  const src = p("hancom-blocks.hwpx");
  const usage: string[][] = [
    ["block", "extract", src, "--range", "0:1-2", "--name", "x"],
    ["block", "extract", src, "--range", "0:1-2", "--name", "x", "--store", p("없는 폴더")],
    ["block", "extract", src, "--range", "0:1-2", "--heading", "0:1", "--name", "x", "--store", s],
    ["block", "extract", src, "--name", "x", "--store", s],
    ["block", "extract", src, "--range", "0:1-2", "--store", s],
    ["block", "extract", src, "--range", "0:1-99", "--name", "x", "--store", s],
    ["block", "extract", src, "--heading", "0:1", "--name", "x", "--store", s],
    ["block", "extract", src, "--range", "0:1-2", "--name", "x", "--store", s, "--id", "K12"],
    ["block", "extract", src, "--range", "0:1-2", "--name", "", "--store", s, "--id", "k00000001"],
    ["block", "extract", p("없는.hwpx"), "--range", "0:1-2", "--name", "x", "--store", s],
    ["block", "insert", src, "--store", s, "--block", "k0000ffff", "--section", "0", "--index", "1", "-o", p("x.hwpx")],
    ["block", "insert", src, "--store", s, "--block", "nope", "--section", "0", "--index", "1", "-o", p("x.hwpx")],
    ["block", "list"],
    ["block", "move"],
  ];
  for (const argv of usage) {
    const r = await cli(...argv);
    assert.equal(r.code, 2, `${argv.join(" ")}: ${r.err}`);
  }
  assert.ok(!existsSync(join(s, "blocks")) || readdirSync(join(s, "blocks")).length === 0, "실패한 떼기는 블록 폴더를 남기지 않는다");
  // 같은 id 두 번 → 2
  assert.equal((await cli("block", "extract", src, "--range", "0:1-2", "--name", "x", "--store", s, "--id", "k00000002")).code, 0);
  assert.equal((await cli("block", "extract", src, "--range", "0:2-3", "--name", "y", "--store", s, "--id", "k00000002")).code, 2);
  // 구역 설정 문단이 든 범위 → 1(조각 계약)
  const secpr = await cli("block", "extract", src, "--range", "0:0-1", "--name", "x", "--store", s, "--id", "k00000003");
  assert.equal(secpr.code, 1);
  assert.match(secpr.err, /FRAG_SECTION_PROPS/);
  assert.ok(!existsSync(join(s, "blocks", "k00000003")));
  // 덩어리가 바뀌면(해시 불일치) 넣기는 2, 출력 없음
  const folder = join(s, "blocks", "k00000002");
  const blob = readdirSync(folder).find((f) => f !== "block.json") ?? "";
  writeFileSync(join(folder, blob), readFileSync(join(folder, blob), "utf8").replace("hwpx-studio/fragment@1", "hwpx-studio/fragment@1 "));
  const bad = await cli("block", "insert", src, "--store", s, "--block", "k00000002", "--section", "0", "--index", "1", "-o", p("bad.hwpx"));
  assert.equal(bad.code, 2);
  assert.match(bad.err, /TPL_FRAGMENT_MISSING/);
  assert.ok(!existsSync(p("bad.hwpx")));
  // 읽을 수 없는 블록이 있으면 list는 1
  mkdirSync(join(s, "blocks", "k0000aaaa"));
  writeFileSync(join(s, "blocks", "k0000aaaa", "block.json"), "{}");
  const listed = await cli("block", "list", "--store", s);
  assert.equal(listed.code, 1);
  assert.match(listed.err, /읽을 수 없는 블록 k0000aaaa: TPL_SCHEMA/);
});
