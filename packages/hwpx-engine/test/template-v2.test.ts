// 2판 템플릿 계약(엔진 명세 8.8): 읽기·정규 쓰기(W1), 읽기 거부(W2), 원형·이번 건 읽기, 1판 승계.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { HwpxError } from "../src/errors.ts";
import {
  readBlockProto,
  readCase,
  readStudioTemplate,
  readTemplate,
  sha256Hex,
  templateSha256,
  writeBlockProto,
  writeCase,
  writeStudioTemplate,
  type BlockContent,
  type StudioReadOptions,
  type StudioTemplate,
} from "../src/index.ts";

const DIR = new URL("./fixtures/template-v2/", import.meta.url);
const fixtureText = (name: string): string => readFileSync(new URL(name, DIR), "utf8");
const fixture = (name: string): Record<string, any> => JSON.parse(fixtureText(name)) as Record<string, any>;
const SHA = "c".repeat(64);

function studio(json: string, opts?: StudioReadOptions): StudioTemplate {
  const t = readStudioTemplate(json, opts);
  assert.ok(t.schema === "hwpx-studio/template@2", "2판 템플릿이어야 한다");
  return t;
}

function failure(fn: () => unknown): HwpxError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아님: ${String(e)}`);
    return e;
  }
  assert.fail("오류가 나야 한다");
}

/** 객체의 키 순서를 뒤집은 JSON(들여쓰기 포함). 정규 쓰기는 입력의 키 순서·공백과 무관해야 한다. */
function shuffled(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shuffled);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffled(x)]));
  return v;
}

/** 정규 JSON 확인: 공백·줄바꿈 없음, 모든 객체의 키가 코드 포인트순이다 */
function assertCanonical(text: string): void {
  assert.ok(!text.endsWith("\n"), "끝 줄바꿈이 없다");
  assert.equal(text, JSON.stringify(JSON.parse(text)), "공백 없는 JSON이다");
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== "object" || v === null) return;
    const keys = Object.keys(v);
    const sorted = [...keys].sort((a, b) => {
      const x = Array.from(a).map((c) => c.codePointAt(0) ?? 0);
      const y = Array.from(b).map((c) => c.codePointAt(0) ?? 0);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
      return x.length - y.length;
    });
    assert.deepEqual(keys, sorted);
    Object.values(v).forEach(walk);
  };
  walk(JSON.parse(text));
}

// ── W1: 읽기 → 정규 쓰기 → 읽기 ─────────────────────────────────

for (const name of ["notice.template.json", "form.template.json"]) {
  test(`W1 ${name}: 읽기 → 정규 쓰기 → 읽기가 같고, 키 순서·공백이 달라도 정규 JSON과 sha256이 같다`, () => {
    const t = studio(fixtureText(name));
    const out = writeStudioTemplate(t);
    assertCanonical(out);
    const again = studio(out);
    assert.deepEqual(again, t);
    assert.equal(writeStudioTemplate(again), out);
    const other = studio(JSON.stringify(shuffled(fixture(name)), null, 4));
    assert.equal(writeStudioTemplate(other), out);
    assert.equal(templateSha256(other), templateSha256(t));
    assert.equal(templateSha256(t), sha256Hex(out));
    assert.match(templateSha256(t), /^[0-9a-f]{64}$/);
  });
}

test("W1 템플릿 B(자리 41개·값 31개)의 모양을 그대로 읽는다", () => {
  const t = studio(fixtureText("form.template.json"));
  assert.equal(t.places.length, 41);
  assert.equal(t.values.length, 31);
  assert.deepEqual(
    [...new Set(t.places.map((p) => p.kind))].sort(),
    ["cell", "clickHere", "line", "mailMerge", "placeholder", "word"],
  );
  assert.deepEqual(t.anchors.map((a) => a.kind), ["range", "range", "line", "word", "word", "word", "line", "cell", "cell", "mergeField", "field", "object"]);
  assert.deepEqual(t.origin, { kind: "lite", revision: 12 });
  assert.deepEqual(t.blocks.find((b) => b.id === "b6")?.content, { text: "1. 입찰서\n2. 사업자등록증" });
});

test("W1 템플릿 sha256이 고정 값이다(이번 건 자료에 적힌 해시와 같다)", () => {
  const t = studio(fixtureText("notice.template.json"));
  assert.equal(templateSha256(t), fixture("notice.case.json")["template"]["sha256"]);
  assert.equal(templateSha256(t), "044ef8a6b93ba67b64038304fb48e33c7ba35628f5d6f8955689f25f90806ac9");
});

test("W1 이번 건·원형도 읽기 → 정규 쓰기 → 읽기가 같다", () => {
  const t = studio(fixtureText("notice.template.json"));
  const c = readCase(fixtureText("notice.case.json"), t);
  const cOut = writeCase(c);
  assertCanonical(cOut);
  assert.deepEqual(readCase(cOut, t), c);
  assert.equal(writeCase(readCase(JSON.stringify(shuffled(fixture("notice.case.json"))), t)), cOut);
  for (const name of ["proto-v2.json", "proto-v3.json"]) {
    const p = readBlockProto(fixtureText(name));
    const out = writeBlockProto(p);
    assertCanonical(out);
    assert.deepEqual(readBlockProto(out), p);
  }
});

test("W1 1판 템플릿은 승계로 읽고 1판 읽기와 같은 값이며, 정규 쓰기 → 읽기도 같다", () => {
  const text = fixtureText("legacy-v1.template.json");
  const t = readStudioTemplate(text);
  assert.equal(t.schema, "hwpx-studio/template@1");
  assert.deepEqual(t, readTemplate(text));
  assert.ok(!("slots" in t) && !("places" in t), "승계 템플릿은 anchors·rules·options만 가진다");
  assert.deepEqual(readStudioTemplate(writeStudioTemplate(t)), t);
  // 1판 읽기는 2판을 그대로 거절한다(기존 동작)
  assert.equal(failure(() => readTemplate(fixtureText("notice.template.json"))).code, "TPL_SCHEMA");
});

test("W1 원형 핀·덩어리 검사: 맞는 lookupProto·hasBlob을 주면 통과한다", () => {
  const p2 = readBlockProto(fixtureText("proto-v2.json"));
  const p3 = readBlockProto(fixtureText("proto-v3.json"));
  const protos = new Map([[`${p2.id}@${p2.version}`, p2.content], [`${p3.id}@${p3.version}`, p3.content]]);
  const blobs = new Set([p2.content, p3.content].flatMap((c) => ("fragment" in c ? [c.fragment] : [])));
  const opts: StudioReadOptions = { lookupProto: (id, v) => protos.get(`${id}@${v}`), hasBlob: (h) => blobs.has(h) };
  studio(fixtureText("notice.template.json"), opts);
  studio(fixtureText("form.template.json"), opts);
});

test("읽기 허용: 쓰이지 않는 값은 연결이 없어도 되고, 블록 이름은 겹쳐도 되며, md에는 placeholder 자리를 쓸 수 있다", () => {
  const b = fixture("form.template.json");
  assert.ok(!b["bindings"].some((x: any) => x.value === "v31"));
  b["blocks"][1].name = b["blocks"][0].name;
  studio(JSON.stringify(b));
  const md = mdTemplate();
  studio(JSON.stringify(md));
});

test("읽기 허용: key와 path는 이름 공간이 달라 같은 글이어도 서로 다른 값에 연결할 수 있다", () => {
  const t = fixture("notice.template.json");
  t["bindings"][1] = { value: "v2", key: "bidder.sme" };
  const read = studio(JSON.stringify(t));
  assert.deepEqual(read.bindings.map((b) => ("key" in b ? `key:${b.key}` : `path:${b.path}`)), ["key:사업명", "key:bidder.sme", "path:bidder.sme"]);
});

test("읽기: -0은 0으로 읽어 읽기 → 정규 쓰기 → 읽기가 같다", () => {
  const t = fixture("notice.template.json");
  t["blocks"][1].priority = -0;
  t["anchors"][1].at.sectionIndex = -0;
  t["blocks"][0].when.all[1] = { path: "v2", op: "ge", value: -0 };
  const text = JSON.stringify(t).replace('"priority":0', '"priority":-0').replace('"sectionIndex":0,"path"', '"sectionIndex":-0,"path"').replace('"value":0', '"value":-0');
  assert.ok(text.includes('"priority":-0') && text.includes('"sectionIndex":-0') && text.includes('"value":-0'), "입력에 -0이 있다");
  const read = studio(text);
  assert.ok(Object.is(read.blocks[1]?.priority, 0));
  assert.deepEqual(studio(writeStudioTemplate(read)), read);
  const c = fixture("notice.case.json");
  const caseText = JSON.stringify(c).replace('"row":3', '"row":-0');
  const tt = studio(fixtureText("notice.template.json"));
  const rc = readCase(caseText, tt);
  assert.ok(Object.is(rc.record.row, 0));
  assert.deepEqual(readCase(writeCase(rc), tt), rc);
});

test("읽기: lookupProto가 대문자 해시를 돌려줘도 같은 해시면 원형 핀 검사를 통과한다", () => {
  const p2 = readBlockProto(fixtureText("proto-v2.json"));
  assert.ok("fragment" in p2.content);
  const upper: BlockContent = { fragment: p2.content.fragment.toUpperCase() };
  studio(fixtureText("notice.template.json"), { lookupProto: () => upper });
  assert.equal(failure(() => studio(fixtureText("notice.template.json"), { lookupProto: () => ({ fragment: SHA.toUpperCase() }) })).code, "TPL_PROTO_MISMATCH");
});

test("읽기 허용: 중첩 슬롯(parent가 블록 id)은 읽기에서 구조만 검사한다(TPL_NESTED는 생성 때)", () => {
  const t = fixture("notice.template.json");
  t["anchors"].push({ id: "a9", kind: "line", at: { sectionIndex: 0, path: [30] }, print: { text: "", sha256: SHA } });
  t["slots"].push({ id: "s2", name: "세부", anchors: ["a9"], parent: "b2" });
  t["blocks"].push({ id: "b9", slot: "s2", name: "세부 글", content: { text: "세부" } });
  const read = studio(JSON.stringify(t));
  assert.equal(read.slots[1]?.parent, "b2");
});

test("읽기 허용: 2판 템플릿은 slots·places가 비어 있으면 1판 rules를 가질 수 있다", () => {
  const t = fixture("notice.template.json");
  t["places"] = [];
  t["slots"] = [];
  t["blocks"] = [];
  t["anchors"].push({ id: "f1", kind: "field", name: "성명" });
  t["rules"] = [{ id: "r1", do: { type: "fill", anchor: "f1", value: { text: "x" } } }];
  const read = studio(JSON.stringify(t));
  assert.equal(read.rules?.length, 1);
  assert.deepEqual(studio(writeStudioTemplate(read)), read);
});

// ── W2: 거부 표 ──────────────────────────────────────────────────

function mdTemplate(): Record<string, any> {
  return {
    schema: "hwpx-studio/template@2", id: "t00000001", version: 1,
    source: { kind: "md", sha256: SHA },
    anchors: [{ id: "a1", kind: "line", at: { sectionIndex: 0, path: [2] }, print: { text: "[IN_TEMPLATE:참가]", sha256: SHA } }],
    values: [{ id: "v1", name: "사업명", format: "text" }],
    bindings: [{ value: "v1", key: "사업명" }],
    places: [{ id: "p1", kind: "placeholder", key: "사업명", value: "v1" }],
    slots: [{ id: "s1", name: "참가", anchors: ["a1"], parent: null }],
    blocks: [{ id: "b1", slot: "s1", name: "일반", content: { text: "{{사업명}} 참가 안내" } }],
  };
}

type Row = { name: string; code: string; where?: string; make: () => string; opts?: StudioReadOptions };

const A = (edit: (t: Record<string, any>) => void): (() => string) => () => {
  const t = fixture("notice.template.json");
  edit(t);
  return JSON.stringify(t);
};
const B = (edit: (t: Record<string, any>) => void): (() => string) => () => {
  const t = fixture("form.template.json");
  edit(t);
  return JSON.stringify(t);
};
const MD = (edit: (t: Record<string, any>) => void): (() => string) => () => {
  const t = mdTemplate();
  edit(t);
  return JSON.stringify(t);
};
const line = (id: string, p: number): Record<string, unknown> => ({ id, kind: "line", at: { sectionIndex: 0, path: [p] }, print: { text: "", sha256: SHA } });
const range = (id: string, from: number, to: number): Record<string, unknown> => ({
  id, kind: "range", at: { sectionIndex: 0, parentPath: [] }, from, to,
  print: { first: { text: "", sha256: SHA }, last: { text: "", sha256: SHA }, count: to - from + 1, sha256: SHA },
});

const REJECT: Row[] = [
  // JSON·schema·판 번호
  { name: "JSON이 아니다", code: "TPL_JSON", make: () => "{ 깨진" },
  { name: "최상위가 배열", code: "TPL_SCHEMA", make: () => "[]" },
  { name: "schema 없음", code: "TPL_SCHEMA", make: A((t) => delete t["schema"]) },
  { name: "schema 이름이 다름", code: "TPL_SCHEMA", make: A((t) => (t["schema"] = "hwpx-studio/fragment@1")) },
  { name: "schema 접두가 다름", code: "TPL_SCHEMA", make: A((t) => (t["schema"] = "acme/template@2")) },
  { name: "template@3", code: "TPL_VERSION", make: A((t) => (t["schema"] = "hwpx-studio/template@3")) },
  { name: "template@0", code: "TPL_VERSION", make: A((t) => (t["schema"] = "hwpx-studio/template@0")) },
  // 모르는 키·빠진 필드·틀린 형식
  { name: "모르는 최상위 키", code: "TPL_FIELD", make: A((t) => (t["extra"] = 1)) },
  { name: "값의 모르는 키", code: "TPL_FIELD", make: A((t) => (t["values"][0].column = "x")) },
  { name: "values 없음", code: "TPL_FIELD", make: A((t) => delete t["values"]) },
  { name: "slots 없음", code: "TPL_FIELD", make: A((t) => delete t["slots"]) },
  { name: "source 없음", code: "TPL_FIELD", make: A((t) => delete t["source"]) },
  { name: "source에 파일 이름", code: "TPL_FIELD", make: A((t) => (t["source"].name = "a.hwpx")) },
  { name: "version이 글", code: "TPL_FIELD", make: A((t) => (t["version"] = "4")) },
  { name: "version 0", code: "TPL_FIELD", make: A((t) => (t["version"] = 0)) },
  { name: "값 형식이 date", code: "TPL_FIELD", make: A((t) => (t["values"][0].format = "date")) },
  { name: "proto와 forkedFrom을 함께", code: "TPL_FIELD", make: A((t) => (t["blocks"][0].forkedFrom = { id: "k7d20a4e1", version: 1 })) },
  { name: "content에 fragment와 text를 함께", code: "TPL_FIELD", make: A((t) => (t["blocks"][1].content.fragment = SHA)) },
  { name: "content.fragment가 해시가 아님", code: "TPL_FIELD", make: A((t) => (t["blocks"][0].content = { fragment: "fragments/a.json" })) },
  { name: "연결에 key와 path를 함께", code: "TPL_FIELD", make: A((t) => (t["bindings"][0].path = "a.b")) },
  { name: "path 연결에 aliases", code: "TPL_FIELD", make: A((t) => (t["bindings"][2].aliases = ["x"])) },
  { name: "한 값에 연결 둘", code: "TPL_FIELD", make: A((t) => t["bindings"].push({ value: "v1", key: "다른 열" })) },
  { name: "슬롯 앵커가 빈 배열", code: "TPL_FIELD", make: A((t) => (t["slots"][0].anchors = [])) },
  { name: "자리 키에 }}", code: "TPL_FIELD", make: A((t) => (t["places"][0].key = "사업}}명")) },
  { name: "자리 키 앞뒤 공백", code: "TPL_FIELD", make: A((t) => (t["places"][0].key = " 사업명")) },
  { name: "자리 키 81자", code: "TPL_FIELD", make: A((t) => (t["places"][0].key = "가".repeat(81))) },
  { name: "모르는 자리 종류", code: "TPL_FIELD", make: A((t) => (t["places"][0].kind = "bookmark")) },
  { name: "word 자리에 where", code: "TPL_FIELD", make: A((t) => (t["places"][2].where = "b1")) },
  { name: "md 템플릿의 조각 블록", code: "TPL_FIELD", make: MD((t) => (t["blocks"][0].content = { fragment: SHA })) },
  { name: "origin 종류가 다름", code: "TPL_FIELD", make: B((t) => (t["origin"].kind = "hwp")) },
  // 옵션
  { name: "모르는 옵션", code: "TPL_OPTIONS", make: A((t) => (t["options"].fast = true)) },
  { name: "requireConfirm이 글", code: "TPL_OPTIONS", make: A((t) => (t["options"].requireConfirm = "yes")) },
  { name: "missing이 drop", code: "TPL_OPTIONS", make: A((t) => (t["options"].missing = "drop")) },
  // id
  { name: "값 id 형식(숫자로 시작)", code: "TPL_ID", where: "values[0].id", make: A((t) => (t["values"][0].id = "1v")) },
  { name: "값 id에 점", code: "TPL_ID", make: A((t) => (t["values"][0].id = "v.1")) },
  { name: "앵커 id 형식", code: "TPL_ID", where: "anchors[0].id", make: A((t) => (t["anchors"][0].id = "앵커1")) },
  { name: "id 33자", code: "TPL_ID", make: A((t) => (t["slots"][0].id = "s" + "1".repeat(32))) },
  { name: "템플릿 id 형식", code: "TPL_ID", where: "id", make: A((t) => (t["id"] = "T3F9A01C2")) },
  { name: "원형 핀 id 형식", code: "TPL_ID", make: A((t) => (t["blocks"][0].proto.id = "k123")) },
  { name: "id 중복(값끼리)", code: "TPL_ID", make: A((t) => t["values"].push({ id: "v1", name: "다른 값", format: "text" })) },
  { name: "id 중복(블록끼리)", code: "TPL_ID", make: A((t) => (t["blocks"][1].id = "b1")) },
  { name: "id 중복(값과 슬롯)", code: "TPL_ID", where: "slots[0].id", make: A((t) => (t["slots"][0].id = "v1")) },
  { name: "id 중복(앵커와 패턴)", code: "TPL_ID", make: A((t) => (t["patterns"][0].id = "a1")) },
  { name: "id 중복(자리와 블록)", code: "TPL_ID", make: A((t) => (t["blocks"][1].id = "p1")) },
  // 표시 이름
  { name: "값 표시 이름 중복", code: "TPL_NAME_DUP", where: "values[1].name", make: A((t) => (t["values"][1].name = "사업명")) },
  { name: "값 표시 이름 중복(NFC 비교)", code: "TPL_NAME_DUP", make: A((t) => {
    t["values"][0].name = "가격";
    t["values"][1].name = "가격";
  }) },
  { name: "슬롯 표시 이름 중복", code: "TPL_NAME_DUP", make: B((t) => (t["slots"][1].name = "참가자격")) },
  // 앵커 종류
  { name: "모르는 앵커 종류", code: "TPL_ANCHOR", make: A((t) => (t["anchors"][1].kind = "bookmark")) },
  { name: "headingRange(예약)", code: "TPL_ANCHOR", make: A((t) => t["anchors"].push({ id: "a9", kind: "headingRange" })) },
  { name: "range 지문 count가 범위와 다름", code: "TPL_ANCHOR", make: A((t) => (t["anchors"][0].print.count = 3)) },
  { name: "range의 to < from", code: "TPL_ANCHOR", make: A((t) => (t["anchors"][0].to = 10)) },
  { name: "앵커의 모르는 키", code: "TPL_ANCHOR", make: A((t) => (t["anchors"][1].extra = 1)) },
  { name: "word 앵커에 print 외 지문 키", code: "TPL_ANCHOR", make: A((t) => (t["anchors"][1].print.sha256 = SHA)) },
  { name: "field 앵커에 print", code: "TPL_ANCHOR", make: B((t) => (t["anchors"][10].print = { rows: 1 })) },
  { name: "word 자리가 field 앵커를 가리킴", code: "TPL_ANCHOR", where: "places[2].anchor", make: A((t) => {
    t["anchors"].push({ id: "f1", kind: "field", name: "사업명" });
    t["places"][2].anchor = "f1";
  }) },
  { name: "cell 자리가 word 앵커를 가리킴", code: "TPL_ANCHOR", make: B((t) => (t["places"][40].anchor = "a4")) },
  { name: "슬롯 앵커가 cell", code: "TPL_ANCHOR", make: B((t) => (t["slots"][0].anchors = ["a8"])) },
  { name: "슬롯 앵커가 word", code: "TPL_ANCHOR", make: A((t) => (t["slots"][0].anchors = ["a2"])) },
  { name: "md에 mailMerge 자리", code: "TPL_ANCHOR", make: MD((t) => t["places"].push({ id: "p2", kind: "mailMerge", key: "사업명", value: "v1" })) },
  { name: "md에 clickHere 자리", code: "TPL_ANCHOR", make: MD((t) => t["places"].push({ id: "p2", kind: "clickHere", name: "사업명", value: "v1" })) },
  { name: "md에 range 앵커", code: "TPL_ANCHOR", make: MD((t) => t["anchors"].push(range("a2", 5, 6))) },
  // 끊긴 참조
  { name: "place.value", code: "TPL_REF", where: "places[0].value", make: A((t) => (t["places"][0].value = "v9")) },
  { name: "place.anchor", code: "TPL_REF", where: "places[2].anchor", make: A((t) => (t["places"][2].anchor = "a9")) },
  { name: "place.where", code: "TPL_REF", make: A((t) => (t["places"][0].where = "b9")) },
  { name: "slot.anchors", code: "TPL_REF", where: "slots[0].anchors[0]", make: A((t) => (t["slots"][0].anchors = ["a9"])) },
  { name: "slot.parent", code: "TPL_REF", where: "slots[0].parent", make: A((t) => (t["slots"][0].parent = "b9")) },
  { name: "block.slot", code: "TPL_REF", where: "blocks[1].slot", make: A((t) => (t["blocks"][1].slot = "s9")) },
  { name: "조건 경로가 값 id가 아님", code: "TPL_REF", where: "blocks[0].when", make: A((t) => (t["blocks"][0].when.all[0].path = "bidder.sme")) },
  { name: "binding.value", code: "TPL_REF", where: "bindings[0].value", make: A((t) => (t["bindings"][0].value = "v9")) },
  { name: "anchor.pattern", code: "TPL_REF", make: A((t) => (t["anchors"][0].pattern = "pt9")) },
  // 순환
  { name: "자기 부모(슬롯의 부모가 그 슬롯의 블록)", code: "TPL_CYCLE", where: "slots[0].parent", make: A((t) => (t["slots"][0].parent = "b2")) },
  { name: "두 단계 순환(s1 → b3 → s2 → b1 → s1)", code: "TPL_CYCLE", make: A((t) => {
    t["anchors"].push(line("a9", 40));
    t["slots"].push({ id: "s2", name: "둘째", anchors: ["a9"], parent: "b1" });
    t["blocks"].push({ id: "b3", slot: "s2", name: "둘째 글", content: { text: "x" } });
    t["slots"][0].parent = "b3";
  }) },
  // 키
  { name: "한 열 이름을 두 값에", code: "TPL_KEY_CONFLICT", make: A((t) => (t["bindings"][1].key = "사업명")) },
  { name: "별칭이 다른 값의 key", code: "TPL_KEY_CONFLICT", make: A((t) => (t["bindings"][1].aliases = ["사업 명"])) },
  { name: "NFC로 같은 열 이름을 두 값에", code: "TPL_KEY_CONFLICT", make: A((t) => {
    t["bindings"][0].key = "가";
    t["bindings"][1].key = "가";
  }) },
  { name: "같은 placeholder 키를 두 값에", code: "TPL_KEY_CONFLICT", make: A((t) => t["places"].push({ id: "p9", kind: "placeholder", key: "사업명", value: "v3" })) },
  { name: "같은 mailMerge 키를 두 값에", code: "TPL_KEY_CONFLICT", make: A((t) => t["places"].push({ id: "p9", kind: "mailMerge", key: "추정가격", value: "v1" })) },
  { name: "같은 clickHere 이름을 두 값에", code: "TPL_KEY_CONFLICT", make: B((t) => t["places"].push({ id: "p99", kind: "clickHere", name: "사업명", value: "v2" })) },
  { name: "같은 path를 두 값에", code: "TPL_KEY_CONFLICT", where: "bindings[2]", make: A((t) => (t["bindings"][1] = { value: "v2", path: "bidder.sme" })) },
  // 연결 없는 값
  { name: "자리가 쓰는 값에 연결이 없다", code: "TPL_UNBOUND_VALUE", where: "values[0]", make: A((t) => t["bindings"].splice(0, 1)) },
  { name: "조건만 쓰는 값에 연결이 없다", code: "TPL_UNBOUND_VALUE", where: "values[2]", make: A((t) => t["bindings"].splice(2, 1)) },
  // 조건
  { name: "조건 연산자", code: "TPL_CONDITION", make: A((t) => (t["blocks"][0].when.all[0].op = "같다")) },
  { name: "조건 정규식 중첩 수량자", code: "TPL_CONDITION", make: A((t) => (t["blocks"][0].when = { path: "v1", op: "matches", value: "(a+)+" })) },
  // 1판 규칙과 혼용
  { name: "rules와 slots", code: "TPL_MIXED_RULES", make: A((t) => {
    t["places"] = [];
    t["rules"] = [{ id: "r1", do: { type: "fill", anchor: "a2", value: { text: "x" } } }];
  }) },
  { name: "rules와 places", code: "TPL_MIXED_RULES", make: A((t) => {
    t["slots"] = [];
    t["blocks"] = [];
    t["rules"] = [{ id: "r1", do: { type: "fill", anchor: "a2", value: { text: "x" } } }];
  }) },
  // 슬롯 범위
  { name: "한 앵커가 두 슬롯에", code: "TPL_CONFLICT", make: B((t) => (t["slots"][1].anchors = ["a3", "a1"])) },
  { name: "같은 부모에서 슬롯 범위가 겹침", code: "TPL_CONFLICT", where: "slots[1].anchors[0]", make: B((t) => {
    t["anchors"].push(range("a20", 14, 16));
    t["slots"][1].anchors = ["a20"];
  }) },
  { name: "range와 line 슬롯이 겹침", code: "TPL_CONFLICT", where: "slots[1].anchors[0]", make: B((t) => {
    t["anchors"].push(line("a20", 12));
    t["slots"][1].anchors = ["a20"];
  }) },
];

const PINS = new Map<string, BlockContent>([["k7d20a4e1@2", { fragment: fixture("proto-v2.json")["content"]["fragment"] }]]);
const REJECT_WITH_OPTS: Row[] = [
  { name: "없는 덩어리 해시", code: "TPL_FRAGMENT_MISSING", where: "blocks[0].content", make: A(() => {}), opts: { hasBlob: () => false } },
  { name: "원형 핀의 내용이 블록 내용과 다름", code: "TPL_PROTO_MISMATCH", where: "blocks[0].content", make: A((t) => (t["blocks"][0].content.fragment = SHA)), opts: { lookupProto: (id, v) => PINS.get(`${id}@${v}`) } },
  { name: "고정한 원형 판이 없다", code: "TPL_PROTO_MISMATCH", where: "blocks[0].proto", make: A((t) => (t["blocks"][0].proto.version = 9)), opts: { lookupProto: (id, v) => PINS.get(`${id}@${v}`) } },
  { name: "원형은 글, 블록은 조각", code: "TPL_PROTO_MISMATCH", make: A(() => {}), opts: { lookupProto: () => ({ text: "글" }) } },
];

test(`W2 템플릿 거부 표(${REJECT.length + REJECT_WITH_OPTS.length}건): 정확한 코드와 위치, 입력·자료 파일을 바꾸지 않는다`, () => {
  const before = readdirSync(DIR).map((n) => [n, sha256Hex(readFileSync(new URL(n, DIR)))]);
  const codes = new Set<string>();
  for (const row of [...REJECT, ...REJECT_WITH_OPTS]) {
    const json = row.make();
    let result: unknown;
    const e = failure(() => {
      result = readStudioTemplate(json, row.opts);
    });
    assert.equal(e.code, row.code, `${row.name}: ${e.message}`);
    if (row.where !== undefined) assert.equal(e.where, row.where, `${row.name}의 위치`);
    assert.equal(result, undefined, `${row.name}: 돌려준 것이 없다`);
    codes.add(row.code);
  }
  assert.deepEqual([...codes].sort(), [
    "TPL_ANCHOR", "TPL_CONDITION", "TPL_CONFLICT", "TPL_CYCLE", "TPL_FIELD", "TPL_FRAGMENT_MISSING", "TPL_ID", "TPL_JSON", "TPL_KEY_CONFLICT",
    "TPL_MIXED_RULES", "TPL_NAME_DUP", "TPL_OPTIONS", "TPL_PROTO_MISMATCH", "TPL_REF", "TPL_SCHEMA", "TPL_UNBOUND_VALUE", "TPL_VERSION",
  ]);
  assert.deepEqual(readdirSync(DIR).map((n) => [n, sha256Hex(readFileSync(new URL(n, DIR)))]), before);
});

test("W2 원형 거부: 판 번호·schema·id·필드", () => {
  const P = (edit: (p: Record<string, any>) => void): string => {
    const p = fixture("proto-v3.json");
    edit(p);
    return JSON.stringify(p);
  };
  const rows: [string, string, string][] = [
    ["block-proto@2", "TPL_VERSION", P((p) => (p["schema"] = "hwpx-studio/block-proto@2"))],
    ["schema 없음", "TPL_SCHEMA", P((p) => delete p["schema"])],
    ["다른 형식의 schema", "TPL_SCHEMA", P((p) => (p["schema"] = "hwpx-studio/template@2"))],
    ["원형 id 형식", "TPL_ID", P((p) => (p["id"] = "t7d20a4e1"))],
    ["모르는 키", "TPL_FIELD", P((p) => (p["owner"] = "x"))],
    ["keys 없음", "TPL_FIELD", P((p) => delete p["keys"])],
    ["keys에 줄바꿈", "TPL_FIELD", P((p) => (p["keys"] = ["사업\n명"]))],
    ["previous.version이 version 이상", "TPL_FIELD", P((p) => (p["previous"].version = 3))],
    ["content가 비었다", "TPL_FIELD", P((p) => (p["content"] = {}))],
  ];
  for (const [name, expected, json] of rows) {
    const e = failure(() => readBlockProto(json));
    assert.equal(e.code, expected, name);
    assert.ok(e.where === undefined || e.where.startsWith("block-proto"), `${name}: where가 원형 파일을 가리킨다(${e.where})`);
  }
});

test("W2 이번 건 거부: 판 번호·필드·끊긴 참조·다른 템플릿", () => {
  const t = studio(fixtureText("notice.template.json"));
  const C = (edit: (c: Record<string, any>) => void): string => {
    const c = fixture("notice.case.json");
    edit(c);
    return JSON.stringify(c);
  };
  const rows: [string, string, string][] = [
    ["case@2", "TPL_VERSION", C((c) => (c["schema"] = "hwpx-studio/case@2"))],
    ["schema 없음", "TPL_SCHEMA", C((c) => delete c["schema"])],
    ["모르는 키", "TPL_FIELD", C((c) => (c["note"] = "x"))],
    ["basis가 auto", "TPL_FIELD", C((c) => (c["selections"].s1.basis = "auto"))],
    ["content가 해시가 아님", "TPL_FIELD", C((c) => (c["selections"].s1.content = "b2"))],
    ["정정 값이 숫자", "TPL_FIELD", C((c) => (c["valueEdits"].v1 = 3))],
    ["슬롯 id 형식", "TPL_ID", C((c) => (c["selections"] = { "슬롯": c["selections"].s1 }))],
    ["없는 슬롯", "TPL_REF", C((c) => (c["selections"] = { s9: c["selections"].s1 }))],
    ["없는 블록(선택)", "TPL_REF", C((c) => (c["selections"].s1.block = "b9"))],
    ["없는 값(정정)", "TPL_REF", C((c) => (c["valueEdits"] = { v9: "x" }))],
    ["없는 블록(블록 수정)", "TPL_REF", C((c) => (c["blockEdits"] = { b9: { text: "x" } }))],
    ["다른 템플릿", "TPL_REF", C((c) => (c["template"].id = "t0a55e7b9"))],
    ["같은 판 번호, 다른 해시", "TPL_REF", C((c) => (c["template"].sha256 = SHA))],
  ];
  for (const [name, expected, json] of rows) assert.equal(failure(() => readCase(json, t)).code, expected, name);
  // 같은 템플릿의 다른 판: id 검사는 하지 않는다(selectSlots의 recheck가 맡는다)
  const newer = readCase(C((c) => {
    c["template"].version = 3;
    c["template"].sha256 = SHA;
    c["selections"].s1.block = "b9";
  }), t);
  assert.equal(newer.selections["s1"]?.block, "b9");
});
