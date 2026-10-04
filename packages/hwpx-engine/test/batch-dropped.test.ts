// 여러 건 생성의 건별 결과에 버린 자리(`BatchItem.dropped`)를 싣는다(이슈 #16). 기대값은 총괄 결정(2026-10-04)과 엔진 명세 8.3에서 만들었다:
//  - 여러 문단에 걸친 바깥 누름틀을 채우면 그 구간 안의 안쪽 누름틀·메일 머지 필드·`{{}}`·책갈피가 함께 지워지고, 단건 `generate`는 이것을 `report.plan.dropped`에 적는다.
//  - `generateBatch`의 건마다 같은 형·같은 내용의 `dropped`를 싣는다(실패한 건도 계획이 있으면 싣고, 계획 전에 실패한 건은 빈 배열). 값 원문은 없다.
//  - 항목마다 `kind`가 있다: 실제로 지워진 자리는 `covered`, 메일 머지 필드의 표시 글 안이라 그 필드가 맡는 `{{}}`는 `mergeDisplay`(잃은 것이 아니다).
//    삭제·교체로 지워지는 문단 안이면 메일 머지 필드의 표시 글이어도 `covered`가 앞선다(독립 검증 L2, 2026-10-04).
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyTemplate, generate, generateBatch, listFields, makeLineAnchor, readDataset, readTemplate, validateDocument, type BatchItem, type BatchRecord, type HwpxDocument } from "../src/index.ts";
import { buildHwpx, newErrorsAfter, readFixture, reparse } from "./helpers.ts";
import { tableXml } from "./table-helpers.ts";

const t = (x: string): string => `<hp:t>${x}</hp:t>`;
const para = (inner: string): string => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`;
let nextId = 100;
/** 누름틀 시작·끝 표식(id는 문서 안에서 겹치지 않는다) */
function clickHere(name: string): { begin: string; end: string } {
  const id = String(nextId++);
  return {
    begin: `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="1" zorder="-1" fieldid="${id}9" metaTag=""/></hp:ctrl>`,
    end: `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}9"/></hp:ctrl>`,
  };
}
const field = (name: string, shown = "안내"): string => {
  const f = clickHere(name);
  return f.begin + t(shown) + f.end;
};
const merge = (key: string): string => {
  const id = String(nextId++);
  return (
    `<hp:ctrl><hp:fieldBegin id="${id}" type="MAILMERGE" name="" editable="0" dirty="0" zorder="-1" fieldid="${id}9" metaTag=""><hp:parameters cnt="1" name=""><hp:stringParam name="FieldValue">${key}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>` +
    t("표시") +
    `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}9"/></hp:ctrl>`
  );
};
const bookmark = (name: string): string => `<hp:ctrl><hp:bookmark name="${name}"/></hp:ctrl>`;
/** 여러 문단에 걸친 바깥 누름틀: 첫 문단 끝에서 시작해 사이 문단들을 지나 끝 문단 머리에서 끝난다 */
function span(name: string, inside: string[]): string[] {
  const f = clickHere(name);
  return [para(t("앞 ") + f.begin + t("안내")), ...inside.map(para), para(t("안내") + f.end + t(" 뒤"))];
}

/**
 * 바깥 누름틀 넷(머리말·본문 둘·표 칸)의 구간 안에 안쪽 누름틀·메일 머지 필드·`{{}}`·책갈피가 든 문서. 구간 밖에는 채워지는 누름틀·`{{}}`가 표 칸과 본문에 24곳 있다(같은 이름 여러 곳).
 * 안쪽 자리: 머리말(누름틀 머리안, {{머리키}}), 본문 1(누름틀 안쪽 둘, {{안쪽키}} 둘, 메일 머지 합침키, 책갈피 책1), 본문 2({{둘키}}, 누름틀 안쪽2), 표 칸({{칸안키}}, 누름틀 칸안).
 */
const DOC = (() => {
  const header =
    `<hp:ctrl><hp:header id="1" applyPageType="BOTH"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="42520" textHeight="4252" hasTextRef="0" hasNumRef="0">` +
    `${span("머리바깥", [field("머리안") + t(" {{머리키}}")]).join("")}</hp:subList></hp:header></hp:ctrl><hp:t/>`;
  const body1 = span("바깥1", [field("안쪽") + t(" {{안쪽키}} ") + merge("합침키") + bookmark("책1"), t("{{안쪽키}} ") + field("안쪽")]);
  const body2 = span("바깥2", [t("{{둘키}}") + field("안쪽2")]);
  const cells = Array.from({ length: 12 }, (_, i) => ({
    row: Math.floor(i / 3),
    col: i % 3,
    width: 3000,
    height: 1000,
    paragraphs: i === 4 ? span("칸바깥", [t("{{칸안키}} ") + field("칸안")]) : [para(i % 2 === 0 ? field(`보통${i % 5}`) : t(`칸 {{보통키${i % 4}}}`))],
  }));
  const plain = Array.from({ length: 13 }, (_, i) => para(i % 2 === 0 ? t("본문 ") + field(`보통${i % 5}`) : t(`본문 {{보통키${i % 4}}} 끝`)));
  return buildHwpx([para(header) + body1.join("") + plain.join("") + para(`${tableXml({ rowCnt: 4, colCnt: 3, cells })}<hp:t/>`) + body2.join("")]);
})();

const KEYS = ["머리바깥", "머리안", "머리키", "바깥1", "안쪽", "안쪽키", "합침키", "바깥2", "둘키", "안쪽2", "칸바깥", "칸안키", "칸안", "보통0", "보통1", "보통2", "보통3", "보통4", "보통키0", "보통키1", "보통키2", "보통키3"];
const INNER = ["bookmark:책1", "field:머리안", "field:안쪽", "field:안쪽2", "field:칸안", "merge:합침키", "{{둘키}}", "{{머리키}}", "{{안쪽키}}", "{{칸안키}}"];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const PARTS = ["공고", "사업", "기간", "(주)", "A&B", "x<y", "a>b", '"인용"', "'따옴표'", "1,234원", "2026-10-04"];
/** 건 `n`의 값: 모든 값이 `값n_` 표지로 시작해 보고서에 원문이 새는지 찾을 수 있다. 길이는 수십~수백 자, 줄바꿈·탭이 든다. */
function recordOf(n: number): BatchRecord {
  const r = rng(n);
  const value = (i: number): string => {
    let out = `값${n}_${i}_`;
    const target = 10 + Math.floor(r() * (r() < 0.3 ? 30 : 500));
    while (out.length < target) out += (PARTS[Math.floor(r() * PARTS.length)] ?? "") + (r() < 0.1 ? "\n" : r() < 0.1 ? "\t" : " ");
    return out.trimEnd();
  };
  return { dataset: { data: Object.fromEntries(KEYS.map((k, i) => [k, value(i)])), derived: {} } };
}
const anchorsOf = (item: BatchItem): string[] => item.dropped.map((d) => d.anchor).sort();
const names = (doc: HwpxDocument): string[] => [...new Set(listFields(doc).map((f) => f.name))].sort();

test("BatchItem.dropped: 바깥 누름틀 넷의 구간 안에 든 안쪽 누름틀·메일 머지 필드·{{}}·책갈피가 건마다 나오고 단건 generate의 plan.dropped와 같다 — 50건(긴 값), 값 원문 없음, 결정성", () => {
  const records = Array.from({ length: 50 }, (_, i) => recordOf(i + 1));
  const items = [...generateBatch(DOC, emptyTemplate(), records, { baseName: "form" })];
  assert.equal(items.length, 50);
  const baseErrors = validateDocument(DOC);
  for (const [i, item] of items.entries()) {
    const record = records[i] as Extract<BatchRecord, { dataset: unknown }>;
    assert.ok(item.ok, `${item.index}번 건: ${JSON.stringify(item.errors)}`);
    assert.deepEqual(anchorsOf(item), INNER, `${item.index}번 건: 안쪽 자리 전부`);
    assert.ok(item.dropped.every((d) => d.ruleId === "implicit" && d.reason.length > 0 && d.kind === "covered"), "안쪽 자리는 모두 실제로 지워진 자리(covered)다");
    // 같은 이름 둘(안쪽 누름틀·{{안쪽키}})은 한 항목에 곳 수로 센다
    assert.match(item.dropped.find((d) => d.anchor === "field:안쪽")?.reason ?? "", /2곳/);
    assert.match(item.dropped.find((d) => d.anchor === "{{안쪽키}}")?.reason ?? "", /2곳/);
    // 단건 generate의 보고서와 같은 형·같은 내용
    assert.deepEqual(item.dropped, generate(DOC, emptyTemplate(), record.dataset).report.plan.dropped);
    // 값 원문이 결과 항목(문서 바이트 밖) 어디에도 없다
    assert.ok(!JSON.stringify({ ...item, output: undefined }).includes(`값${item.index}_`), `${item.index}번 건: 값 원문 없음`);
    // 결과 문서: 바깥 누름틀과 보통 자리는 채워졌고 안쪽 자리는 없다
    const out = reparse(item.output ?? new Uint8Array());
    assert.deepEqual(names(out), ["머리바깥", "바깥1", "바깥2", "보통0", "보통1", "보통2", "보통3", "보통4", "칸바깥"].sort());
    assert.equal(item.warnings.filter((w) => w.code === "FIELD_PARAGRAPHS_MERGED").length, 4);
    assert.deepEqual(newErrorsAfter(baseErrors, validateDocument(item.output ?? new Uint8Array())), [], `${item.index}번 건: 검사기 새 오류 없음`);
  }
  // 결정성: 같은 입력이면 같은 결과(바이트·dropped)
  const again = [...generateBatch(DOC, emptyTemplate(), records, { baseName: "form" })];
  assert.deepEqual(again.map((x) => x.dropped), items.map((x) => x.dropped));
  assert.ok(again.every((x, i) => Buffer.from(x.output ?? []).equals(Buffer.from(items[i]?.output ?? []))));
});

test("BatchItem.dropped: 계획까지 간 실패 건(누락 키)도 싣고, 계획 전에 실패한 건(객체가 아닌 원소)과 버린 자리가 없는 문서는 빈 배열이다", () => {
  const full = recordOf(7) as Extract<BatchRecord, { dataset: unknown }>;
  const data = { ...(full.dataset.data as Record<string, unknown>) };
  delete data["보통0"];
  const missing: BatchRecord = { dataset: { data, derived: {} } };
  const broken: BatchRecord = { error: { code: "DATA_SCHEMA", message: "객체가 아닌 원소" } };
  const [ok, failed, schema] = [...generateBatch(DOC, emptyTemplate(), [full, missing, broken], { baseName: "form" })];
  assert.deepEqual([ok?.ok, failed?.ok, schema?.ok], [true, false, false]);
  assert.deepEqual(failed?.errorCodes, ["DATA_MISSING"]);
  assert.deepEqual(failed?.dropped, generate(DOC, emptyTemplate(), missing.dataset).report.plan.dropped);
  assert.deepEqual(failed === undefined ? [] : anchorsOf(failed), INNER);
  assert.deepEqual(schema?.dropped, []);
  // 바깥 누름틀이 없는 문서(같은 문서의 보통 자리만)는 버린 자리가 없다
  const plainDoc = buildHwpx([para(field("보통0")) + para(t("{{보통키0}}"))]);
  const [plain] = [...generateBatch(plainDoc, emptyTemplate(), [full], { baseName: "form" })];
  assert.deepEqual([plain?.ok, plain?.dropped], [true, []]);
});

test("BatchItem.dropped kind: 한컴 메일 머지 서식(merge-fields)의 표시 글 안 {{키}}는 필드가 맡는 자리라 모두 mergeDisplay이고 covered는 0이다(건마다 같다)", () => {
  const data = {
    사업명: "가", 기관명: "가", 담당자: "가", 연락처: "가", 공고번호: "가", 시행일: "가", 접수기간: "가", 추정가격: "가", 장소: "가", 예정가격: "가", 부가세: "가", 재공고: "가",
    성명: "가", 소속: "가", 이름: "가", 직위: "가",
    project: { name: "가", start: "가", end: "가" }, dates: { start: "가", end: "가", days: "가" }, manager: { phone: "가", email: "가" },
  };
  const items = [...generateBatch(readFixture("merge/merge-fields"), emptyTemplate(), [0, 1, 2].map((): BatchRecord => ({ dataset: { data, derived: {} } })), { baseName: "form" })];
  for (const item of items) {
    assert.ok(item.ok, JSON.stringify(item.errors));
    assert.equal(item.dropped.length, 12, "경로 꼴 키 12종의 {{키}} 표시 글");
    assert.ok(item.dropped.every((d) => d.kind === "mergeDisplay" && /^\{\{.+\}\}$/.test(d.anchor)));
    assert.equal(item.dropped.filter((d) => d.kind === "covered").length, 0);
  }
});

test("dropped kind 판정 순서: 메일 머지 필드가 든 문단을 delete 규칙이 지우면 필드와 표시 글 안 {{키}}가 모두 covered다. 규칙 없이는 {{키}}가 mergeDisplay이고, 필드를 가리키는 규칙의 when이 거짓이어도 mergeDisplay다", () => {
  const mergeShown = (id: string, key: string): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" type="MAILMERGE" name="" editable="0" dirty="0" zorder="-1" fieldid="${id}9" metaTag=""><hp:parameters cnt="1" name=""><hp:stringParam name="FieldValue">${key}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>` +
    t(`{{${key}}}`) +
    `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}9"/></hp:ctrl>`;
  const bytes = buildHwpx([para(t("앞")) + para(t("금 ") + mergeShown("901", "키") + t(" 원")) + para(t("뒤 {{다른}}"))]);
  const kinds = (r: ReturnType<typeof generate>): [string, string][] => r.report.plan.dropped.map((d): [string, string] => [d.anchor, d.kind]).sort();
  const data = readDataset({ 키: "값", 다른: "다른 값" });

  const anchor = makeLineAnchor(reparse(bytes), "p", 0, [1]);
  assert.ok(anchor !== undefined);
  const del = generate(bytes, readTemplate({ schema: "hwpx-studio/template@1", anchors: [anchor], rules: [{ id: "d", do: { type: "delete", anchor: "p" } }] }), data);
  assert.ok(del.ok, JSON.stringify(del.report.issues.map((i) => [i.code, i.message])));
  assert.deepEqual(kinds(del), [["merge:키", "covered"], ["{{키}}", "covered"]]);
  // 지워지는 문단의 메일 머지 필드를 규칙이 가리켜도(조건이 참이든 거짓이든) 표시 글 안 {{키}}는 실제로 지워지는 자리(covered)다
  for (const when of [undefined, { path: "없음", op: "exists" }]) {
    const rules = [{ id: "d", do: { type: "delete", anchor: "p" } }, { id: "f", ...(when === undefined ? {} : { when }), do: { type: "fill", anchor: "a", value: { text: "x" } } }];
    const claimed = generate(bytes, readTemplate({ schema: "hwpx-studio/template@1", anchors: [anchor, { id: "a", kind: "field", mergeKey: "키" }], rules }), data);
    assert.ok(claimed.ok, JSON.stringify(claimed.report.issues.map((i) => [i.code, i.message])));
    assert.ok(claimed.report.plan.dropped.length > 0, String(when));
    assert.deepEqual(claimed.report.plan.dropped.filter((d) => d.anchor === "{{키}}").map((d) => d.kind), ["covered"], `규칙 조건 ${when === undefined ? "참" : "거짓"}`);
    assert.ok(claimed.report.plan.dropped.every((d) => d.kind === "covered"), `규칙 조건 ${when === undefined ? "참" : "거짓"}`);
  }

  const none = generate(bytes, emptyTemplate(), data);
  assert.ok(none.ok);
  assert.deepEqual(kinds(none), [["{{키}}", "mergeDisplay"]]);

  const idle = generate(
    bytes,
    readTemplate({ schema: "hwpx-studio/template@1", anchors: [{ id: "a", kind: "field", mergeKey: "키" }], rules: [{ id: "r", when: { path: "없음", op: "exists" }, do: { type: "fill", anchor: "a", value: { text: "x" } } }] }),
    data,
  );
  assert.ok(idle.ok, JSON.stringify(idle.report.issues.map((i) => [i.code, i.message])));
  assert.deepEqual(kinds(idle), [["{{키}}", "mergeDisplay"]]);
});
