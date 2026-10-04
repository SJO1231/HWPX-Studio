// 메일 머지 필드(fieldBegin type="MAILMERGE")를 누름틀처럼 채우고 보존한다(이슈 #18).
// 기대값은 과업 명세와 한컴이 만든 합성 서식(fixtures/merge/merge-fields.hwpx: 메일 머지 필드 33개, 누름틀 4개, `{{경로}}` 8곳이 한 문서에 든다)에서 만들었다:
//  - 메일 머지 필드는 `name`이 비어 있고 키는 `hp:parameters`의 `stringParam name="FieldValue"`다. 키가 데이터 경로 꼴이면 "키 = 데이터 경로"로 채우고(같은 키는 전부 같은 값),
//    아니면 MERGE_KEY_NOT_PATH로 건너뛰고 그대로 둔다(오류가 아니다).
//  - 채움은 누름틀과 같은 코드 경로다: 표시 글(`{{키}}`나 안내 글)만 값으로 바뀌고 필드 표식과 `hp:parameters`·type·그 밖의 속성은 그대로이며 `dirty`는 "1"이다.
//  - 필드가 맡는 표시 글 안의 `{{경로}}`는 채우지 않고 dropped로 보고한다. 값은 긴 문장(줄바꿈·탭·XML 특수문자 포함)도 그대로 들어가고 다시 읽으면 같다.
//  - 명시 앵커는 `{ kind: "field", mergeKey }`다(name과 함께 줄 수 없다).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  censusOfDoc,
  draftAnchors,
  emptyTemplate,
  findCandidates,
  generate,
  generateBatch,
  isTableNode,
  listFields,
  readDataset,
  readTemplate,
  validateDocument,
  walkParagraphs,
  type BatchItem,
  type GenerateOptions,
  type GenerateResult,
  type HwpxDocument,
  type Template,
} from "../src/index.ts";
import { fieldHitsOf } from "../src/text/anchors.ts";
import { generateText } from "../src/text/index.ts";
import type { BatchRecord } from "../src/template/index.ts";
import { buildHwpx, mutateEntryText, newErrorsAfter, readFixture, reparse } from "./helpers.ts";

const SEC = "Contents/section0.xml";
const OBJ = "￼";
const FIXTURE = readFixture("merge/merge-fields");

type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;
const done = (r: GenerateResult): Done => {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error").map((i) => [i.code, i.message]))}`);
  assert.ok(!r.dryRun);
  return r as Done;
};
const failedCodes = (r: GenerateResult): string[] => {
  assert.equal(r.ok, false, "생성이 성공해 버렸다");
  assert.ok(!("output" in r), "실패인데 출력이 있다");
  return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
};
const ds = (data: unknown) => readDataset(data);
const tpl = (spec: { anchors?: unknown[]; rules?: unknown[] }): Template => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const plain = (s: string): string => s.replaceAll(OBJ, "");
const allParagraphs = (doc: HwpxDocument) => doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)]);
const merge = (doc: HwpxDocument) => listFields(doc).filter((f) => f.type === "MAILMERGE");
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const sectionOf = (bytes: Uint8Array): string => {
  let text = "";
  mutateEntryText(bytes, SEC, (x) => ((text = x), x + " "));
  return text;
};

// ── 값: 짧은 값과 긴 문장(200~1,000자, 여러 문장, 줄바꿈·탭, 쉼표·괄호·따옴표·&·<·>, 숫자·날짜) ────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ["사업", "공고", "입찰", "계약", "추정", "가격", "기간", "장소", "담당", "기관", "제출", "서류", "접수", "마감", "시행", "안내", "변경", "확인", "조건", "자격"];
const SPECIALS = ["(주)", "A&B", "x<y", "a>b", '"인용"', "'작은따옴표'", "1,234,500원", "2026-10-04", "제3항", "5%", "~", "&amp;", "<b>"];
function sentence(r: () => number): string {
  const n = 3 + Math.floor(r() * 6);
  const parts = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)] ?? "");
  parts.splice(Math.floor(r() * n), 0, SPECIALS[Math.floor(r() * SPECIALS.length)] ?? "");
  return parts.join(" ") + (r() < 0.5 ? "." : ",");
}
/** 길이가 정확히 [min, max] 안의 값. 문장 사이에 공백·줄바꿈·탭이 든다. */
function longValue(r: () => number, min: number, max: number): string {
  const target = min + Math.floor(r() * (max - min + 1));
  let out = "";
  while (out.length < target) {
    out += sentence(r);
    const x = r();
    out += x < 0.12 ? "\n" : x < 0.2 ? "\t" : " ";
  }
  out = out.slice(0, target);
  return /\s$/.test(out) ? `${out.slice(0, -1)}.` : out;
}

const MERGE_KEYS = ["사업명", "기관명", "담당자", "연락처", "공고번호", "시행일", "접수기간", "추정가격", "장소", "예정가격", "부가세", "재공고"] as const;
const CLICK_NAMES = ["성명", "소속", "이름", "직위"] as const;
type Values = {
  merge: Record<(typeof MERGE_KEYS)[number], string>;
  click: Record<(typeof CLICK_NAMES)[number], string>;
  ph: { project: { name: string; start: string; end: string }; dates: { start: string; end: string; days: string }; manager: { phone: string; email: string } };
};
/** 짧은 값과 긴 값이 섞인 데이터. 같은 시드는 같은 데이터다. */
function valuesOf(seed: number): Values {
  const r = rng(seed);
  return {
    merge: {
      사업명: longValue(r, 200, 400),
      기관명: "합성기관",
      담당자: "홍길동",
      연락처: "02-000-0000",
      공고번호: "제2026-0001호",
      시행일: "2026-10-04",
      접수기간: "2026-10-04 ~ 2026-10-18",
      추정가격: "1,234,500원",
      장소: longValue(r, 200, 600),
      예정가격: longValue(r, 250, 500),
      부가세: "123,450",
      재공고: longValue(r, 900, 1000),
    },
    click: { 성명: "홍길동", 소속: longValue(r, 200, 300), 이름: "김철수", 직위: "과장" },
    ph: {
      project: { name: longValue(r, 300, 1000), start: "2026-10-04", end: "2026-12-31" },
      dates: { start: "2026-10-04", end: longValue(r, 200, 250), days: "88" },
      manager: { phone: "010-0000-0000", email: "a&b@example.test" },
    },
  };
}
const dataOf = (v: Values): Record<string, unknown> => ({ ...v.merge, ...v.click, project: v.ph.project, dates: v.ph.dates, manager: v.ph.manager });

const BEFORE = listFields(reparse(FIXTURE));
/** 서식에서 경로 꼴이 아닌 키의 필드(채우지 않고 그대로 두는 것)의 표시 글 */
const NON_PATH = BEFORE.filter((f) => f.type === "MAILMERGE" && f.mergeKey !== undefined && !/^[\p{L}\p{N}_-]+$/u.test(f.mergeKey));
const display = (key: string, occurrence: number): string => NON_PATH.find((f) => f.mergeKey === key && f.occurrence === occurrence)?.valueText ?? `<${key}#${occurrence}없음>`;

/** 데이터 `v`로 채운 서식의 기대 글: 문단별(구역 바로 아래) 글, 두 표의 칸 글, 머리말·꼬리말 글. 서식의 구조에서 직접 만들었다. */
function expected(v: Values) {
  const m = v.merge;
  const c = v.click;
  const p = v.ph;
  return {
    top: [
      "합성 공고서 서식 (시험용)",
      `사업명: ${m.사업명} 입니다.`,
      `기관 ${m.기관명} 은(는) ${m.사업명} 을(를) 공고합니다.`,
      `공고번호 ${m.공고번호}, 시행일 ${m.시행일}, 접수기간 ${m.접수기간}.`,
      `굵게: ${m.추정가격}`,
      `담당: ${m.담당자} (${m.연락처}) 비고 ${display("참고 사항", 0)}.`,
      `계약방법 ${display("계약 방법(수의)", 0)} 이며 장소는 ${m.장소} 입니다.`,
      `금액 ${m.추정가격} / 예정가격 ${m.예정가격} / 부가세 ${m.부가세}.`,
      `재공고 ${m.재공고} 사유 ${display("사유 설명", 0)}.`,
      `성명: ${c.성명}`,
      `소속: ${c.소속}`,
      `${p.project.name} / ${p.project.start} ~ ${p.project.end}.`,
      "",
      `표 아래 문단. 담당 ${m.담당자} 확인.`,
      `${p.dates.start} ~ ${p.dates.end} (${p.dates.days}일).`,
      "",
      "끝.",
    ],
    tableA: [
      ["구분", "내용", "비고"],
      ["사업명", m.사업명, m.공고번호],
      ["추정가격", m.추정가격, display("참고 사항", 1)],
      ["기간", m.접수기간, m.시행일],
      ["기관", m.기관명, m.담당자],
      ["연락처", m.연락처, m.장소],
    ],
    tableB: [
      ["이름", c.이름],
      ["직위", c.직위],
      ["연락처", p.manager.phone],
      ["메일", p.manager.email],
    ],
    header: `공고번호: ${m.공고번호} / ${m.사업명}`,
    footer: `기관: ${m.기관명} / 담당 ${m.담당자} ${m.연락처}`,
  };
}

/** 문서에서 `expected`와 같은 모양으로 읽는다. */
function observed(doc: HwpxDocument) {
  const section = doc.sections[0];
  assert.ok(section !== undefined);
  const tables = section.paragraphs.flatMap((par) => par.objects.filter(isTableNode));
  const grid = (t: (typeof tables)[number]): string[][] => {
    const rows: string[][] = [];
    for (const cell of t.cells) (rows[cell.row] ??= [])[cell.col] = plain(cell.subList?.paragraphs.map((q) => q.logicalText).join("\n") ?? "");
    return rows;
  };
  const texts = allParagraphs(doc).map((q) => plain(q.logicalText));
  return {
    top: section.paragraphs.map((par) => plain(par.logicalText)),
    tableA: grid(tables[0] as (typeof tables)[number]),
    tableB: grid(tables[1] as (typeof tables)[number]),
    header: texts.find((t) => t.startsWith("공고번호: ")) ?? "",
    footer: texts.find((t) => t.startsWith("기관: ")) ?? "",
    tableCount: tables.length,
  };
}

// ── 모델 ────────────────────────────────────────────────────────

test("모델: 서식의 필드 — 메일 머지 33개(머리말 2·꼬리말 3·본문 28)와 누름틀 4개. 메일 머지는 name이 비고 키(mergeKey)·같은 키 안 순번·모양이 나온다", () => {
  const fields = BEFORE;
  assert.equal(fields.length, 37);
  const mm = fields.filter((f) => f.type === "MAILMERGE");
  assert.equal(mm.length, 33);
  assert.deepEqual(fields.filter((f) => f.type === "CLICK_HERE").map((f) => f.name), ["성명", "소속", "이름", "직위"]);
  assert.ok(mm.every((f) => f.name === "" && f.mergeKey !== undefined && f.shape === "simple" && f.dirty === "0"), "한컴이 넣은 메일 머지 필드는 이름이 비고 dirty=0이다");
  assert.ok(fields.filter((f) => f.type === "CLICK_HERE").every((f) => f.mergeKey === undefined), "누름틀은 mergeKey가 없다");
  // 같은 키가 여러 번: 순번은 같은 키 안에서 0부터 문서 순서로 센다
  const byKey = new Map<string, number[]>();
  for (const f of mm) byKey.set(f.mergeKey ?? "", [...(byKey.get(f.mergeKey ?? "") ?? []), f.occurrence]);
  assert.deepEqual(
    [...byKey].map(([k, o]) => [k, o.length]).sort(),
    [["공고번호", 3], ["계약 방법(수의)", 1], ["기관명", 3], ["담당자", 4], ["부가세", 1], ["사업명", 4], ["사유 설명", 1], ["시행일", 2], ["연락처", 3], ["예정가격", 1], ["장소", 2], ["재공고", 1], ["접수기간", 2], ["참고 사항", 2], ["추정가격", 3]].sort(),
  );
  for (const o of byKey.values()) assert.deepEqual(o, o.map((_, i) => i));
  // 머리말·꼬리말의 필드도 문서의 필드다(경로가 구역 최상위 문단이 아니라 하위 목록 안)
  assert.equal(mm.filter((f) => f.path.length > 1 && f.path[0] === 0).length, 5);
  // 표시 글은 `{{키}}`와 안내 글이 섞여 있다(안내 글 8개)
  assert.equal(mm.filter((f) => f.valueText !== `{{${f.mergeKey}}}`).length, 8);
  // 경로 꼴이 아닌 키 4곳(참고 사항 둘, 계약 방법(수의), 사유 설명)
  assert.equal(NON_PATH.length, 4);
});

test("모델: 키가 없는 메일 머지 필드는 mergeKey가 없고, FieldValue만 키로 읽는다(다른 인자·빈 값은 키가 아니다). 순번은 키 있는 필드끼리만 센다", () => {
  const field = (id: number, params: string, name = ""): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" type="MAILMERGE" name="${name}" fieldid="1"><hp:parameters cnt="1" name="">${params}</hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>표시</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="1"/></hp:ctrl>`;
  const click = `<hp:ctrl><hp:fieldBegin id="9" type="CLICK_HERE" name="" fieldid="2"/></hp:ctrl><hp:t>안내</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="9" fieldid="2"/></hp:ctrl>`;
  const body = field(1, `<hp:stringParam name="Command">가</hp:stringParam>`) + field(2, `<hp:stringParam name="FieldValue"></hp:stringParam>`) + field(3, `<hp:stringParam name="FieldValue">키</hp:stringParam>`) + click + field(4, `<hp:stringParam name="FieldValue">키</hp:stringParam>`) + field(5, `<hp:stringParam name="FieldValue">a&amp;b</hp:stringParam>`);
  const doc = reparse(buildHwpx([`<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${body}</hp:run></hp:p>`]));
  assert.deepEqual(listFields(doc).map((f) => [f.type, f.name, f.mergeKey, f.occurrence]), [
    ["MAILMERGE", "", undefined, 0],
    ["MAILMERGE", "", undefined, 1],
    ["MAILMERGE", "", "키", 0],
    ["CLICK_HERE", "", undefined, 2],
    ["MAILMERGE", "", "키", 1],
    ["MAILMERGE", "", "a&b", 0],
  ]);
});

// ── 암묵 채움: 큰 서식 ─────────────────────────────────────────

test("암묵 채움(짧은 값): 메일 머지 29곳·누름틀 4곳·{{}} 8곳이 한 번에 채워지고, 경로 꼴이 아닌 키 4곳은 건너뛰어 그대로 둔다. 문단·표 구조는 그대로다", () => {
  const v = valuesOf(1);
  for (const k of MERGE_KEYS) if (k !== "사업명" && k !== "장소" && k !== "예정가격" && k !== "재공고") assert.ok(v.merge[k].length < 30);
  const r = done(generate(FIXTURE, emptyTemplate(), ds(dataOf(v))));
  const out = reparse(r.output);
  const want = expected(v);
  const got = observed(out);
  assert.deepEqual(got.top, want.top);
  assert.deepEqual(got.tableA, want.tableA);
  assert.deepEqual(got.tableB, want.tableB);
  assert.equal(got.header, want.header);
  assert.equal(got.footer, want.footer);
  assert.equal(got.tableCount, 2);
  // 필드: 개수·종류·키 그대로. 채운 것은 dirty=1, 건너뛴 4곳은 표시 글·dirty 그대로
  const before = BEFORE;
  const after = listFields(out);
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((f) => [f.type, f.name, f.mergeKey, f.occurrence]), before.map((f) => [f.type, f.name, f.mergeKey, f.occurrence]));
  for (const [i, f] of after.entries()) {
    const b = before[i];
    assert.ok(b !== undefined);
    const skippedOne = NON_PATH.some((n) => n.mergeKey === f.mergeKey && n.occurrence === f.occurrence && f.type === "MAILMERGE");
    if (skippedOne) assert.deepEqual([f.valueText, f.dirty], [b.valueText, b.dirty], "건너뛴 필드는 그대로");
    else assert.equal(f.dirty, "1", `${f.mergeKey ?? f.name}: 채운 필드의 dirty`);
  }
  // 보고: 사용한 데이터 경로, 채운 자리(키별 곳 수), 건너뜀, 표시 글 안 {{}} 버림
  const plan = r.report.plan;
  assert.deepEqual(
    plan.actions.filter((a) => a.anchor.startsWith("merge:")).map((a) => [a.anchor, a.targets]),
    [["공고번호", 3], ["기관명", 3], ["담당자", 4], ["부가세", 1], ["사업명", 4], ["시행일", 2], ["예정가격", 1], ["연락처", 3], ["장소", 2], ["재공고", 1], ["접수기간", 2], ["추정가격", 3]]
      .sort(([a], [b]) => (`merge:${a}` < `merge:${b}` ? -1 : 1))
      .map(([k, n]) => [`merge:${k}`, n]),
  );
  assert.deepEqual(plan.actions.filter((a) => a.anchor.startsWith("field:")).map((a) => [a.anchor, a.targets]).sort(), [["field:성명", 1], ["field:소속", 1], ["field:이름", 1], ["field:직위", 1]].sort());
  assert.equal(plan.actions.filter((a) => a.anchor.startsWith("{{")).length, 8);
  assert.equal(plan.actions.reduce((n, a) => n + a.targets, 0), 41, "29 + 4 + 8");
  assert.deepEqual(plan.requiredPaths, [...MERGE_KEYS, ...CLICK_NAMES, "project.name", "project.start", "project.end", "dates.start", "dates.end", "dates.days", "manager.phone", "manager.email"].sort());
  assert.deepEqual(plan.skipped.map((s) => [s.ruleId, s.anchor, s.code]).sort(), [
    ["implicit", "merge:계약 방법(수의)", "MERGE_KEY_NOT_PATH"],
    ["implicit", "merge:사유 설명", "MERGE_KEY_NOT_PATH"],
    ["implicit", "merge:참고 사항", "MERGE_KEY_NOT_PATH"],
    ["implicit", "merge:참고 사항", "MERGE_KEY_NOT_PATH"],
  ]);
  assert.ok(plan.skipped.every((s) => s.message.includes(s.anchor.slice("merge:".length)) && !s.message.includes("합성기관")), "메시지에 키는 있고 값은 없다");
  // 필드가 맡는 표시 글(`{{키}}`) 안의 {{}}는 채우지 않고 버린다: {{사업명}} 등 경로 꼴 `{{키}}` 표시 글 중 안내 글이 아닌 것
  const keepDisplay = BEFORE.filter((f) => f.type === "MAILMERGE" && f.valueText === `{{${f.mergeKey}}}` && !NON_PATH.includes(f));
  assert.equal(keepDisplay.length, 23, "서식에서 `{{키}}` 표시 글인 경로 꼴 필드(경로 꼴 29개 중 안내 글 6개를 뺀 것)");
  const dropped = new Map(plan.dropped.map((d) => [d.anchor, d.reason]));
  for (const k of new Set(keepDisplay.map((f) => f.mergeKey))) assert.match(dropped.get(`{{${k}}}`) ?? "", /메일 머지 필드가 맡는 표시 글 안의 자리 \d+곳을 버렸습니다/, String(k));
  // 값 재읽기: 채운 필드 33개(메일 머지 29 + 누름틀 4)와 채운 문단
  assert.equal(r.report.reread.fields, 33);
  // 검사기 새 오류 0, 수량(문단·표·필드 쌍·그림) 그대로
  assert.deepEqual(newErrorsAfter(validateDocument(FIXTURE), validateDocument(r.output)), []);
  assert.deepEqual(censusOfDoc(out), censusOfDoc(reparse(FIXTURE)));
  // 같은 입력은 같은 바이트
  assert.ok(bytesEqual(done(generate(FIXTURE, emptyTemplate(), ds(dataOf(v)))).output, r.output));
  // 값 원문은 보고서·원장 어디에도 없다
  assert.ok(!JSON.stringify({ report: r.report, ledger: r.ledger }).includes("합성기관"));
});

test("암묵 채움: 건너뛴 필드(경로 꼴이 아닌 키)의 필드 표식과 인자는 바이트 그대로이고, 채운 필드는 dirty만 바뀐다(type·인자·fieldid·editable 보존)", () => {
  const v = valuesOf(2);
  const r = done(generate(FIXTURE, emptyTemplate(), ds(dataOf(v))));
  const begins = (bytes: Uint8Array): string[] => [...sectionOf(bytes).matchAll(/<hp:fieldBegin [^>]*type="MAILMERGE"[^>]*>[\s\S]*?<\/hp:fieldBegin>/g)].map((m) => m[0]);
  const before = begins(FIXTURE);
  const after = begins(r.output);
  assert.equal(before.length, 33);
  assert.equal(after.length, 33);
  const keyOf = (xml: string): string => /<hp:stringParam name="FieldValue">([^<]*)</.exec(xml)?.[1] ?? "";
  for (const [i, b] of before.entries()) {
    const a = after[i] ?? "";
    assert.equal(a.replace(' dirty="1"', ' dirty="0"'), b, `${keyOf(b)}: dirty 말고는 그대로`);
    if (NON_PATH.some((n) => n.mergeKey === keyOf(b))) assert.equal(a, b, "건너뛴 필드는 바이트 그대로");
    else assert.ok(a.includes(' dirty="1"'), "채운 필드는 dirty=1");
  }
  // 필드 끝 표식도 그대로
  assert.deepEqual([...sectionOf(r.output).matchAll(/<hp:fieldEnd [^>]*\/>/g)].map((m) => m[0]), [...sectionOf(FIXTURE).matchAll(/<hp:fieldEnd [^>]*\/>/g)].map((m) => m[0]));
});

test("암묵 채움(긴 값): 200~1,000자 문장(줄바꿈·탭·& < > 따옴표·숫자·날짜)이 값 재읽기와 같고, 문단 수·표 구조·필드 수가 그대로이며, 검사기 새 오류가 없다", () => {
  for (const seed of [11, 12, 13]) {
    const v = valuesOf(seed);
    const lengths = [v.merge.사업명, v.merge.장소, v.merge.재공고, v.click.소속, v.ph.project.name].map((x) => x.length);
    assert.ok(lengths.every((n) => n >= 200 && n <= 1000), `시드 ${seed} 길이 ${lengths.join()}`);
    const longs = [v.merge.사업명, v.merge.장소, v.merge.재공고, v.click.소속, v.ph.project.name];
    assert.ok(longs.some((x) => x.includes("\n")) && longs.some((x) => x.includes("\t")) && longs.some((x) => x.includes("&")), `시드 ${seed}: 줄바꿈·탭·& 포함`);
    const r = done(generate(FIXTURE, emptyTemplate(), ds(dataOf(v))));
    const out = reparse(r.output);
    assert.deepEqual(observed(out), { ...expected(v), tableCount: 2 }, `시드 ${seed}`);
    assert.equal(r.report.reread.fields, 33);
    assert.deepEqual(newErrorsAfter(validateDocument(FIXTURE), validateDocument(r.output)), [], `시드 ${seed}`);
    assert.deepEqual(censusOfDoc(out), censusOfDoc(reparse(FIXTURE)), `시드 ${seed}`);
    assert.equal(allParagraphs(out).length, allParagraphs(reparse(FIXTURE)).length, "문단 수");
    // 줄바꿈·탭이 든 값은 필드 안의 요소로 들어가 문단을 나누지 않는다(필드의 모양이 inline이 된다)
    const shapes = merge(out).filter((f) => !NON_PATH.some((n) => n.mergeKey === f.mergeKey)).map((f) => f.shape);
    assert.ok(shapes.includes("inline") && shapes.includes("simple"), shapes.join());
    // 특수문자는 엔티티로 들어가 XML이 깨지지 않는다(다시 읽은 값이 같다는 것이 곧 그 증거다)
    assert.ok(sectionOf(r.output).includes("&lt;") && sectionOf(r.output).includes("&amp;"), `시드 ${seed}: < 와 & 가 이스케이프됐다`);
    assert.ok(bytesEqual(done(generate(FIXTURE, emptyTemplate(), ds(dataOf(v)))).output, r.output), "결정성");
  }
});

test("재채움: 채운 문서(안내 글·긴 값이 든)를 다른 값으로 두 번 더 채운다 — 옛 값이 남지 않고 필드·구조는 그대로이며, 같은 값으로 다시 채우면 바이트가 같다", () => {
  const v1 = valuesOf(21);
  const first = done(generate(FIXTURE, emptyTemplate(), ds(dataOf(v1)))).output;
  const v2 = valuesOf(22);
  const second = done(generate(first, emptyTemplate(), ds(dataOf(v2))));
  const out2 = reparse(second.output);
  // 필드(메일 머지·누름틀)는 새 값으로 바뀐다. 첫 채움에서 글이 된 본문 `{{경로}}` 8곳은 더 이상 자리가 아니라 첫 값 그대로다
  assert.deepEqual(observed(out2), { ...expected({ ...v2, ph: v1.ph }), tableCount: 2 });
  assert.equal(second.report.reread.fields, 33);
  assert.deepEqual(second.report.plan.requiredPaths, [...MERGE_KEYS, ...CLICK_NAMES].sort());
  // 첫 값의 흔적이 없다
  assert.ok(!allParagraphs(out2).some((p) => p.logicalText.includes(valuesOf(21).merge.재공고.slice(0, 40))));
  // 필드 표식은 여전히 메일 머지 33개와 누름틀 4개(type·키 보존)
  assert.deepEqual(listFields(out2).map((f) => [f.type, f.mergeKey ?? f.name]), BEFORE.map((f) => [f.type, f.mergeKey ?? f.name]));
  // 안내 글·`{{키}}` 표시 글이 없는 문서(첫 채움 뒤)에서는 `{{경로}}`가 없으니 값으로 채울 자리는 필드뿐이다
  const third = done(generate(second.output, emptyTemplate(), ds(dataOf(v2))));
  assert.deepEqual(third.report.plan.requiredPaths, [...MERGE_KEYS, ...CLICK_NAMES].sort());
  assert.ok(bytesEqual(third.output, second.output), "같은 값으로 다시 채우면 바이트가 같다");
  assert.deepEqual(newErrorsAfter(validateDocument(FIXTURE), validateDocument(second.output)), []);
});

test("암묵 채움: 누락 정책 — error는 DATA_MISSING(키마다 하나), empty는 표시 글을 비우고, keep은 그대로 둔다. 경로 꼴이 아닌 키는 데이터가 없어도 오류가 아니다", () => {
  const v = valuesOf(3);
  const { 공고번호, ...rest } = dataOf(v);
  void 공고번호;
  const r = generate(FIXTURE, emptyTemplate(), ds(rest));
  assert.deepEqual(failedCodes(r), ["DATA_MISSING"], "공고번호 하나만 없다");
  assert.match(r.report.issues[0]?.message ?? "", /^메일 머지 공고번호: 데이터에 공고번호 값이 없습니다/);
  assert.deepEqual(r.report.plan.missingPaths, ["공고번호"]);
  const empty = done(generate(FIXTURE, emptyTemplate(), ds(rest), { missing: "empty" }));
  assert.deepEqual(merge(reparse(empty.output)).filter((f) => f.mergeKey === "공고번호").map((f) => f.valueText), ["", "", ""]);
  const keep = done(generate(FIXTURE, emptyTemplate(), ds(rest), { missing: "keep" }));
  assert.deepEqual(merge(reparse(keep.output)).filter((f) => f.mergeKey === "공고번호").map((f) => [f.valueText, f.dirty]), BEFORE.filter((f) => f.mergeKey === "공고번호").map((f) => [f.valueText, f.dirty]));
  assert.deepEqual(keep.report.plan.kept, [{ path: "공고번호", count: 3 }]);
  // 경로 꼴이 아닌 키만 있는 문서: 채울 것이 없으면 FILL_NOTHING_APPLIED이고 건너뜀 사유가 메시지에 있다
  const onlyBad = mutateEntryText(FIXTURE, SEC, (x) => x.replace(/(<hp:stringParam name="FieldValue">)[^<]*</g, "$1a b<"));
  const nothing = generate(onlyBad, emptyTemplate(), ds({}), { missing: "keep" });
  assert.deepEqual(failedCodes(nothing), ["FILL_NOTHING_APPLIED"]);
  assert.match(nothing.report.issues[0]?.message ?? "", /MERGE_KEY_NOT_PATH 33곳/);
});

// ── 필드가 맡는 표시 글 안의 {{}} ──────────────────────────────

test("표시 글 안의 {{경로}}: 일부만 `{{}}`인 안내 글(금 {{추정가격}} 원)도 필드 자리가 맡는다 — 필드가 값으로 채우고 {{}}는 dropped, TPL_CONFLICT·DATA_MISSING이 없다. 필드를 못 채우면 {{}}는 이전처럼 채운다", () => {
  const field = (id: number, key: string, shown: string): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" type="MAILMERGE" name="" editable="0" dirty="0" zorder="-1" fieldid="627928423" metaTag=""><hp:parameters cnt="5" name=""><hp:booleanParam name="Fiexde">1</hp:booleanParam><hp:integerParam name="Prop">8</hp:integerParam><hp:stringParam name="Command">${key}</hp:stringParam><hp:stringParam name="FieldType">USER_DEFINE</hp:stringParam><hp:stringParam name="FieldValue">${key}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>${shown}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="627928423"/></hp:ctrl>`;
  const docOf = (...fields: string[]): Uint8Array => buildHwpx([fields.map((f, i) => `<hp:p id="${i + 1}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>앞 </hp:t>${f}<hp:t> 뒤</hp:t></hp:run></hp:p>`).join("")]);
  // 표시 글에 다른 경로의 {{}}가 든 경우도 필드가 맡는다(그 경로는 데이터에 없어도 된다)
  const r = done(generate(docOf(field(1, "가", "금 {{나}} 원"), field(2, "다", "{{다}}")), emptyTemplate(), ds({ 가: "값1", 다: "값2" })));
  assert.deepEqual(allParagraphs(reparse(r.output)).map((p) => plain(p.logicalText)), ["앞 값1 뒤", "앞 값2 뒤"]);
  assert.deepEqual(r.report.plan.dropped.map((d) => d.anchor).sort(), ["{{나}}", "{{다}}"]);
  assert.deepEqual(r.report.plan.requiredPaths, ["가", "다"]);
  // 키가 경로 꼴이 아니면 필드는 건너뛰고(그대로 둔다), 표시 글 안의 {{}}는 이전처럼 {{}} 규칙이 채운다
  const bad = done(generate(docOf(field(1, "가 나", "금 {{다}} 원"), field(2, "라", "{{라}}")), emptyTemplate(), ds({ 다: "값", 라: "L" })));
  assert.deepEqual(allParagraphs(reparse(bad.output)).map((p) => plain(p.logicalText)), ["앞 금 값 원 뒤", "앞 L 뒤"]);
  assert.deepEqual(bad.report.plan.skipped.map((s) => [s.code, s.anchor]), [["MERGE_KEY_NOT_PATH", "merge:가 나"]]);
});

// ── 명시 앵커 { kind: "field", mergeKey } ──────────────────────

test("템플릿: field 앵커는 name이나 mergeKey 하나로 가리킨다 — 둘을 함께 주거나 둘 다 없거나 mergeKey가 비면 TPL_ANCHOR", () => {
  const code = (anchor: unknown): string | undefined => {
    try {
      readTemplate({ schema: "hwpx-studio/template@1", anchors: [anchor], rules: [] });
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  assert.equal(code({ id: "a", kind: "field", mergeKey: "추정가격" }), undefined);
  assert.equal(code({ id: "a", kind: "field", mergeKey: "추정가격", occurrence: 1 }), undefined);
  assert.equal(code({ id: "a", kind: "field", name: "성명" }), undefined);
  assert.equal(code({ id: "a", kind: "field", name: "성명", mergeKey: "추정가격" }), "TPL_ANCHOR");
  assert.equal(code({ id: "a", kind: "field" }), "TPL_ANCHOR");
  assert.equal(code({ id: "a", kind: "field", mergeKey: "" }), "TPL_ANCHOR");
  assert.equal(code({ id: "a", kind: "field", mergeKey: 3 }), "TPL_ANCHOR");
  assert.equal(code({ id: "a", kind: "field", mergeKey: "x", occurrence: -1 }), "TPL_ANCHOR");
  assert.equal(code({ id: "a", kind: "field", mergeKey: "x", extra: 1 }), "TPL_ANCHOR");
});

test("명시 앵커: mergeKey 앵커가 키가 같은 메일 머지 필드 전부(순번을 주면 그 순번만)를 가리키고, 규칙이 가리킨 필드는 암묵 채움이 맡지 않으며, 그 필드의 표시 글 {{}}는 데이터가 없어도 dropped다", () => {
  const v = valuesOf(4);
  const data = dataOf(v);
  const { 추정가격, ...without } = data;
  void 추정가격;
  const all = tpl({ anchors: [{ id: "a", kind: "field", mergeKey: "추정가격" }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "규칙 값" } } }] });
  // 추정가격은 규칙이 맡는다: 데이터에 없어도 되고(표시 글 {{추정가격}}의 {{}}도 필수가 아니다), 키가 같은 3곳이 전부 규칙 값이다
  const r = done(generate(FIXTURE, all, ds(without)));
  assert.deepEqual(merge(reparse(r.output)).filter((f) => f.mergeKey === "추정가격").map((f) => [f.valueText, f.dirty]), [["규칙 값", "1"], ["규칙 값", "1"], ["규칙 값", "1"]]);
  assert.deepEqual(r.report.plan.actions.filter((a) => a.ruleId === "r").map((a) => [a.anchor, a.targets]), [["a", 3]]);
  assert.ok(!r.report.plan.requiredPaths.includes("추정가격"));
  assert.ok(!r.report.plan.actions.some((a) => a.anchor === "merge:추정가격"), "규칙이 맡은 필드는 암묵 채움 대상이 아니다");
  assert.deepEqual(r.report.plan.missingPaths, []);
  assert.ok(r.report.plan.dropped.some((d) => d.anchor === "{{추정가격}}"), "표시 글 안 {{추정가격}}는 필드가 맡아 dropped");
  // 순번: 사업명의 둘째(순번 1)만. 나머지 사업명은 암묵 채움(데이터)
  const second = tpl({ anchors: [{ id: "a", kind: "field", mergeKey: "사업명", occurrence: 1 }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "둘째" } } }] });
  const r2 = done(generate(FIXTURE, second, ds(data)));
  assert.deepEqual(merge(reparse(r2.output)).filter((f) => f.mergeKey === "사업명").map((f) => f.valueText), [v.merge.사업명, "둘째", v.merge.사업명, v.merge.사업명]);
  // 경로 꼴이 아닌 키도 명시 앵커는 채운다(MERGE_KEY_NOT_PATH는 암묵 채움의 규칙이다). 그 키의 필드 2곳 전부
  const bad = tpl({ anchors: [{ id: "a", kind: "field", mergeKey: "참고 사항" }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { path: "비고" } } }] });
  const r3 = done(generate(FIXTURE, bad, ds({ ...data, 비고: "비고 값\n둘째 줄" })));
  assert.deepEqual(merge(reparse(r3.output)).filter((f) => f.mergeKey === "참고 사항").map((f) => f.valueText), ["비고 값\n둘째 줄", "비고 값\n둘째 줄"]);
  assert.ok(r3.report.plan.requiredPaths.includes("비고"));
  assert.deepEqual(r3.report.plan.skipped.map((s) => s.anchor).sort(), ["merge:계약 방법(수의)", "merge:사유 설명"]);
  // 없는 키·없는 순번은 ANCHOR_NOT_FOUND(메시지에 '키가 같은 메일 머지 필드')
  for (const a of [{ mergeKey: "없는 키" }, { mergeKey: "사업명", occurrence: 9 }]) {
    const miss = generate(FIXTURE, tpl({ anchors: [{ id: "a", kind: "field", ...a }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "x" } } }] }), ds(data));
    assert.deepEqual(failedCodes(miss), ["ANCHOR_NOT_FOUND"]);
    assert.match(miss.report.issues[0]?.message ?? "", /키가 같은 메일 머지 필드(\(순번 9\))?가 문서에 없습니다/);
  }
  // 이름 앵커는 메일 머지 필드를 가리키지 못한다(이름이 비어 있다): 키를 name으로 줘도 찾지 못한다
  assert.deepEqual(failedCodes(generate(FIXTURE, tpl({ anchors: [{ id: "a", kind: "field", name: "추정가격" }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "x" } } }] }), ds(data))), ["ANCHOR_NOT_FOUND"]);
  // 조건이 거짓인 규칙이 가리킨 필드는 암묵 채움도 건드리지 않는다
  const idle = tpl({ anchors: [{ id: "a", kind: "field", mergeKey: "부가세" }], rules: [{ id: "r", when: { path: "x", op: "exists" }, do: { type: "fill", anchor: "a", value: { text: "x" } } }] });
  const r4 = done(generate(FIXTURE, idle, ds(data)));
  assert.deepEqual(merge(reparse(r4.output)).filter((f) => f.mergeKey === "부가세").map((f) => [f.valueText, f.dirty]), BEFORE.filter((f) => f.mergeKey === "부가세").map((f) => [f.valueText, f.dirty]));
});

// ── 모양: inline · crossParagraph · cross-run · empty ─────────

const mmBegin = (id: number, key: string, dirty = "0"): string =>
  `<hp:ctrl><hp:fieldBegin id="${id}" type="MAILMERGE" name="" editable="0" dirty="${dirty}" zorder="-1" fieldid="627928423" metaTag=""><hp:parameters cnt="5" name=""><hp:booleanParam name="Fiexde">1</hp:booleanParam><hp:integerParam name="Prop">8</hp:integerParam><hp:stringParam name="Command">${key}</hp:stringParam><hp:stringParam name="FieldType">USER_DEFINE</hp:stringParam><hp:stringParam name="FieldValue">${key}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`;
const mmEnd = (id: number): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="627928423"/></hp:ctrl>`;
const clickBegin = (id: number, name: string): string => `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="627272811" metaTag=""/></hp:ctrl>`;
const clickEnd = (id: number): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="627272811"/></hp:ctrl>`;
const para = (id: number, runs: string): string => `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0">${runs}</hp:p>`;
const run = (inner: string, charPr = "0"): string => `<hp:run charPrIDRef="${charPr}">${inner}</hp:run>`;
const t = (s: string): string => `<hp:t>${s}</hp:t>`;
const TAB = '<hp:tab width="0" leader="0" type="1"/>';
const texts = (doc: HwpxDocument): string[] => allParagraphs(doc).map((p) => plain(p.logicalText));
const paramsOf = (bytes: Uint8Array): string[] => [...sectionOf(bytes).matchAll(/<hp:parameters[\s\S]*?<\/hp:parameters>/g)].map((m) => m[0]);

test("모양 inline: 탭·줄바꿈이 든 표시 글의 메일 머지 필드는 구간 전체를 값으로 바꾼다(옛 탭·줄바꿈 요소 없음). 필드 표식·인자는 그대로", () => {
  const doc = buildHwpx([para(1, run(t("앞 ") + mmBegin(10, "키") + `<hp:t>가${TAB}나<hp:lineBreak/>다</hp:t>` + mmEnd(10) + t(" 뒤")))]);
  assert.deepEqual(merge(reparse(doc)).map((f) => [f.shape, f.valueText]), [["inline", "가\t나\n다"]]);
  const r = done(generate(doc, emptyTemplate(), ds({ 키: "새 값" })));
  assert.deepEqual(texts(reparse(r.output)), ["앞 새 값 뒤"]);
  assert.deepEqual(merge(reparse(r.output)).map((f) => [f.shape, f.valueText, f.dirty, f.mergeKey]), [["simple", "새 값", "1", "키"]]);
  assert.ok(!sectionOf(r.output).includes("<hp:lineBreak"), "옛 줄바꿈 요소가 없다");
  assert.deepEqual(paramsOf(r.output), paramsOf(doc));
  // 줄바꿈·탭이 든 값을 넣고 다시 채운다(inline → inline)
  const lines = done(generate(doc, emptyTemplate(), ds({ 키: "첫 줄\n둘째\t탭" })));
  assert.deepEqual(merge(reparse(lines.output)).map((f) => [f.shape, f.valueText]), [["inline", "첫 줄\n둘째\t탭"]]);
  const again = done(generate(lines.output, emptyTemplate(), ds({ 키: "x" })));
  assert.deepEqual(texts(reparse(again.output)), ["앞 x 뒤"]);
});

test("모양 empty: 표시 글이 없는 메일 머지 필드는 시작 표식 뒤에 새 글을 넣는다. 값이 비면 그대로 둔다", () => {
  const doc = buildHwpx([para(1, run(t("앞 ") + mmBegin(10, "키") + mmEnd(10) + t(" 뒤")))]);
  assert.deepEqual(merge(reparse(doc)).map((f) => f.shape), ["empty"]);
  const r = done(generate(doc, emptyTemplate(), ds({ 키: "채움" })));
  assert.deepEqual(texts(reparse(r.output)), ["앞 채움 뒤"]);
  assert.deepEqual(merge(reparse(r.output)).map((f) => [f.valueText, f.dirty]), [["채움", "1"]]);
  const blank = done(generate(doc, emptyTemplate(), ds({ 키: "" })));
  assert.deepEqual(merge(reparse(blank.output)).map((f) => [f.valueText, f.dirty]), [["", "0"]], "빈 값은 dirty를 건드리지 않는다(누름틀과 같다)");
});

test("모양 cross-run: 시작 표식과 표시 글·끝 표식이 다른 run(글자모양이 다름)에 있는 필드 — 값은 표시 글이 있던 run의 글자모양을 지킨다", () => {
  const doc = buildHwpx([para(1, run(t("앞 ") + mmBegin(10, "키")) + run(t("{{키}}") + mmEnd(10) + t(" 뒤"), "1"))]);
  const r = done(generate(doc, emptyTemplate(), ds({ 키: "값" })));
  const xml = sectionOf(r.output);
  assert.match(xml, /<hp:run charPrIDRef="1"><hp:t>값<\/hp:t><hp:ctrl><hp:fieldEnd/, "값이 둘째 run(charPr 1)에 들어갔다");
  assert.deepEqual(texts(reparse(r.output)), ["앞 값 뒤"]);
  assert.equal(r.report.plan.dropped.length, 1, "{{키}}는 필드가 맡는다");
  // 시작 표식과 끝 표식 사이에 run이 하나 더 끼면(안내 글 상태 dirty=0) 그 run의 글자모양은 시작 표식 run의 것으로 바뀐다(누름틀과 같은 규칙)
  const three = buildHwpx([para(1, run(t("앞 ") + mmBegin(10, "키")) + run(t("안내"), "1") + run(mmEnd(10) + t(" 뒤")))]);
  const r3 = done(generate(three, emptyTemplate(), ds({ 키: "값" })));
  assert.match(sectionOf(r3.output), /<hp:run charPrIDRef="0"><hp:t>값<\/hp:t><\/hp:run>/);
});

test("모양 crossParagraph: 여러 문단에 걸친 메일 머지 필드는 값으로 문단이 합쳐지고 FIELD_PARAGRAPHS_MERGED 경고(메일 머지 키)가 한 번 나온다. 인자·표식 보존", () => {
  const doc = buildHwpx([
    [
      para(1, run(t("앞 문단"))),
      para(2, run(t("성명: ") + mmBegin(10, "키") + t("안내1"))),
      para(3, run(t("안내2"))),
      para(4, run(t("안내3") + mmEnd(10) + t(" 끝 뒤 글"))),
      para(5, run(t("뒤 문단"))),
    ].join(""),
  ]);
  assert.deepEqual(merge(reparse(doc)).map((f) => f.shape), ["crossParagraph"]);
  const r = done(generate(doc, emptyTemplate(), ds({ 키: "새 값" })));
  assert.deepEqual(texts(reparse(r.output)), ["앞 문단", "성명: 새 값 끝 뒤 글", "뒤 문단"]);
  const warnings = r.report.issues.filter((i) => i.code === "FIELD_PARAGRAPHS_MERGED");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? "", /^메일 머지 필드\(키 키\)가 걸친 문단 3개를 합쳤고/);
  assert.deepEqual(merge(reparse(r.output)).map((f) => [f.mergeKey, f.shape, f.dirty, f.valueText]), [["키", "simple", "1", "새 값"]]);
  assert.deepEqual(paramsOf(r.output), paramsOf(doc));
  assert.deepEqual(censusOfDoc(reparse(r.output)).paragraphs, censusOfDoc(reparse(doc)).paragraphs - 2);
});

test("구간 안의 메일 머지 필드: 여러 문단에 걸친 누름틀의 구간 안에 든 메일 머지 필드는 함께 사라지고 dropped(merge:키)로 한 번만 보고한다(removed와 겹치지 않는다)", () => {
  const doc = buildHwpx([
    [
      para(1, run(t("성명: ") + clickBegin(20, "성명") + t("안내1"))),
      para(2, run(t("가운데 ") + mmBegin(10, "키") + t("{{키}}") + mmEnd(10))),
      para(3, run(t("안내3") + clickEnd(20) + t(" 끝 뒤"))),
    ].join(""),
  ]);
  const r = done(generate(doc, emptyTemplate(), ds({ 성명: "홍", 키: "K" })));
  assert.deepEqual(texts(reparse(r.output)), ["성명: 홍 끝 뒤"]);
  // 구간 안의 표시 글 `{{키}}`(기존 규칙: 구간 치환이 지우는 구간 안의 {{}})와 필드 자체가 각각 한 번씩
  assert.deepEqual(r.report.plan.dropped.map((d) => [d.ruleId, d.anchor]).sort(), [["implicit", "merge:키"], ["implicit", "{{키}}"]].sort());
  assert.match(r.report.plan.dropped.find((d) => d.anchor === "merge:키")?.reason ?? "", /메일 머지 필드 1곳을 채우지 않았습니다/);
  assert.deepEqual(r.report.plan.requiredPaths, ["성명"]);
});

// ── 값 재읽기 게이트 ────────────────────────────────────────────

const hook = (change: (bytes: Uint8Array) => Uint8Array): GenerateOptions => ({ testHooks: { afterApply: (bytes) => change(bytes) } });

test("값 재읽기 게이트: 메일 머지 필드의 값이 다르거나 dirty가 꺼진 출력은 REREAD_FIELD로 막는다(메시지에 값 원문이 없다)", () => {
  const v = valuesOf(5);
  const data = ds(dataOf(v));
  const wrong = generate(FIXTURE, emptyTemplate(), data, hook((b) => mutateEntryText(b, SEC, (x) => x.replace("<hp:t>합성기관</hp:t>", "<hp:t>합성기관X</hp:t>"))));
  assert.ok(failedCodes(wrong).includes("REREAD_FIELD"));
  assert.ok(wrong.report.issues.every((i) => !i.message.includes("합성기관")), "메시지에 값 원문이 있다");
  const dirty = generate(FIXTURE, emptyTemplate(), data, hook((b) => mutateEntryText(b, SEC, (x) => x.replace('dirty="1"', 'dirty="0"'))));
  assert.ok(failedCodes(dirty).includes("REREAD_FIELD"));
  // 변조가 없으면 통과하고 33곳을 다시 읽었다
  assert.equal(done(generate(FIXTURE, emptyTemplate(), data)).report.reread.fields, 33);
});

// ── 자리 목록: 후보·초안·여러 건 ───────────────────────────────

test("자리: findCandidates·draftAnchors가 메일 머지 필드를 field 자리로 잡고(mergeKey 앵커 초안), 초안을 템플릿에 넣으면 그 한 곳만 규칙이 채운다", () => {
  const doc = reparse(FIXTURE);
  const fieldCandidates = findCandidates(doc).flatMap((c) => (c.kind === "field" && c.anchor.kind === "field" ? [{ anchor: c.anchor, evidence: c.evidence }] : []));
  assert.equal(fieldCandidates.length, 37);
  const merged = fieldCandidates.filter((c) => c.anchor.mergeKey !== undefined);
  assert.equal(merged.length, 33);
  assert.ok(merged.every((c) => c.anchor.name === undefined && c.evidence.startsWith("메일 머지 필드 '")));
  assert.deepEqual(fieldCandidates.filter((c) => c.anchor.mergeKey === undefined).map((c) => c.anchor.name), ["성명", "소속", "이름", "직위"]);
  assert.ok(!merged.some((c) => c.evidence.includes("안내문 상태")), "메일 머지 필드의 근거에 누름틀의 안내문 상태 말이 없다");

  // 셋째 문단(기관명·사업명이 `{{키}}` 표시 글인 문단)에서 사업명 표시 글 가운데를 누른다
  const par = doc.sections[0]?.paragraphs[2];
  assert.ok(par !== undefined);
  const at = par.logicalText.indexOf("{{사업명}}") + 3;
  const drafts = draftAnchors(doc, { sectionIndex: 0, path: [2], start: at, end: at });
  const target = listFields(doc).find((f) => f.mergeKey === "사업명" && f.path.length === 1 && f.path[0] === 2);
  assert.ok(target !== undefined);
  assert.deepEqual(drafts[0], { kind: "field", mergeKey: "사업명", occurrence: target.occurrence });
  // 초안에 id를 달아 템플릿에 넣으면 읽히고, 그 한 곳만 규칙이 채운다
  const t1 = tpl({ anchors: [{ id: "a", ...drafts[0] }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "여기만" } } }] });
  const v = valuesOf(6);
  const r = done(generate(FIXTURE, t1, ds(dataOf(v))));
  const filled = merge(reparse(r.output)).filter((f) => f.mergeKey === "사업명").map((f) => f.valueText);
  assert.equal(filled.filter((x) => x === "여기만").length, 1);
  assert.equal(filled.filter((x) => x === v.merge.사업명).length, 3);
  // 채울 수 없는 모양의 필드는 초안을 만들지 않는다(누름틀과 같다): 끝 표식이 없는 메일 머지 필드
  const unpaired = buildHwpx([para(1, run(t("앞 ") + mmBegin(10, "키") + t("글")))]);
  assert.deepEqual(draftAnchors(reparse(unpaired), { sectionIndex: 0, path: [0], start: 4, end: 4 }).filter((d) => d.kind === "field"), []);
});

test("여러 건(generateBatch): 건마다 메일 머지·누름틀·{{}}가 채워지고 채운 자리 수(41)가 센다. 한 건의 값 오류는 그 건만 실패한다", () => {
  const records: BatchRecord[] = [1, 2, 3].map((s) => ({ dataset: ds(dataOf(valuesOf(30 + s))) }));
  records.push({ dataset: ds({ ...dataOf(valuesOf(40)), 사업명: "a\u0001" }) });
  const items: BatchItem[] = [...generateBatch(FIXTURE, emptyTemplate(), records, { baseName: "merge" })];
  assert.deepEqual(items.map((i) => [i.ok, i.filled]), [[true, 41], [true, 41], [true, 41], [false, 0]]);
  assert.deepEqual(items[3]?.errorCodes, ["VALUE_CONTROL_CHAR"]);
  assert.deepEqual(items[0]?.skipped.map((s) => s.code), ["MERGE_KEY_NOT_PATH", "MERGE_KEY_NOT_PATH", "MERGE_KEY_NOT_PATH", "MERGE_KEY_NOT_PATH"]);
  for (const [i, item] of items.slice(0, 3).entries()) {
    assert.deepEqual(observed(reparse(item.output ?? new Uint8Array())), { ...expected(valuesOf(31 + i)), tableCount: 2 });
  }
});

test("텍스트 문서(md·txt)는 메일 머지 필드가 없다: mergeKey 앵커는 아무것도 가리키지 않고 ANCHOR_NOT_FOUND다", () => {
  assert.deepEqual(fieldHitsOf([], { id: "a", kind: "field", mergeKey: "x" }), []);
  const r = generateText("값: {{x}}\n", "md", tpl({ anchors: [{ id: "a", kind: "field", mergeKey: "x" }], rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "y" } } }] }), ds({ x: "z" }));
  assert.equal(r.ok, false);
  const issue = r.report.issues.find((i) => i.code === "ANCHOR_NOT_FOUND");
  assert.match(issue?.message ?? "", /메일 머지 필드\(mergeKey\)는 HWPX 문서에만 있어/);
});

// ── 한글 2024 확인(선택 실행) ──────────────────────────────────
// `HWPX_COM=1`일 때만 돈다. 한컴 오피스·Python·pywin32가 있는 Windows에서만 의미가 있다. `tools/com/read_text.py`로 엔진 결과를 한컴에서 열어
// (a) 열림·쪽 수 (b) 한컴이 다시 저장한 XML을 엔진이 읽어 값·필드 수·키가 같은지 (c) PDF에 값이 보이는지를 본다.

const ENABLED = process.env["HWPX_COM"] === "1";
const SCRIPT = fileURLToPath(new URL("../../../tools/com/read_text.py", import.meta.url));

test("한글 2024: 채운 큰 서식(긴 값 포함)이 열리고, 한컴이 다시 저장해도 메일 머지 필드 33개·키·값이 그대로이며 PDF에 값이 보인다", { skip: !ENABLED && "HWPX_COM=1일 때만 실행한다" }, (tc) => {
  const dir = mkdtempSync(join(tmpdir(), "hwpx-merge-com-"));
  try {
    const v = valuesOf(7);
    const out = done(generate(FIXTURE, emptyTemplate(), ds(dataOf(v)))).output;
    writeFileSync(join(dir, "filled.hwpx"), out);
    const spec = join(dir, "spec.json");
    const res = join(dir, "result.json");
    writeFileSync(
      spec,
      JSON.stringify({ documents: [{ name: "filled", file: join(dir, "filled.hwpx"), resave: join(dir, "filled.resaved.hwpx"), pdf: join(dir, "filled.pdf"), markers: ["합성기관", "홍길동", "2026-10-04", "1,234,500원", "제2026-0001호"] }] }),
    );
    let last: { opened: boolean; pages: number | null; timeout: boolean; error: string | null; resaved: boolean; pdf: { saved: boolean; markers: Record<string, unknown> | null } | null } | undefined;
    for (let attempt = 0; attempt < 3 && !(last?.opened === true); attempt++) {
      const r = spawnSync("python", [SCRIPT, "--spec", spec, "--out", res, "--timeout", "60"], { encoding: "utf8", timeout: 150_000 });
      assert.equal(r.status, 0, r.stderr);
      last = (JSON.parse(readFileSync(res, "utf8")) as { results: NonNullable<typeof last>[] }).results[0];
    }
    assert.ok(last?.opened === true && !last.timeout, `한컴에서 열려야 한다(${last?.error})`);
    tc.diagnostic(`한컴 쪽 수 ${last.pages}, PDF 글 위치 ${JSON.stringify(Object.fromEntries(Object.entries(last.pdf?.markers ?? {}).map(([k, x]) => [k, x !== null])))}`);
    assert.ok((last.pages ?? 0) >= 1);
    assert.ok(last.resaved, "한컴이 다시 저장해야 한다");
    const again = reparse(new Uint8Array(readFileSync(join(dir, "filled.resaved.hwpx"))));
    // 한컴이 다시 저장해도 메일 머지 필드는 필드로 남는다(33개, 키 그대로). 채운 값은 표시 글에 그대로 있다
    const mm = merge(again);
    assert.equal(mm.length, 33);
    assert.deepEqual(mm.map((f) => f.mergeKey).sort(), BEFORE.filter((f) => f.type === "MAILMERGE").map((f) => f.mergeKey).sort());
    assert.deepEqual(
      mm.filter((f) => f.mergeKey === "사업명").map((f) => f.valueText).sort(),
      merge(reparse(out)).filter((f) => f.mergeKey === "사업명").map((f) => f.valueText).sort(),
    );
    assert.equal(listFields(again).filter((f) => f.type === "CLICK_HERE").length, 4);
    // PDF: 짧은 값이 글로 그려졌다
    const m = last.pdf?.markers;
    assert.ok(m !== null && m !== undefined, "PDF 글 위치를 읽어야 한다(PyMuPDF)");
    for (const key of ["합성기관", "홍길동", "2026-10-04", "1,234,500원", "제2026-0001호"]) assert.ok(m[key] !== null && m[key] !== undefined, `PDF에 ${key}가 있다`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
