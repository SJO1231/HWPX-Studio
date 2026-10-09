// 경우 표의 상호 배타 규칙(엔진 명세 8.8.8, TPL_EXCLUSIVE·SEL_EXCLUSIVE)과 참조 번호 자동 재정렬(8.8.12, options.renumber·RENUMBER_UNMATCHED). 사용자 결정 2026-10-02(요구 8.9-12), #196.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HwpxError } from "../src/errors.ts";
import { validateDocument, walkParagraphs, type HwpxDocument } from "../src/index.ts";
import { generate, generateFromTemplate, type StudioGenerateResult } from "../src/fill/index.ts";
import {
  bindValues,
  planRenumber,
  readStudioTemplate,
  selectSlots,
  sha256Hex,
  writeStudioTemplate,
  type RenumberEdit,
  type SlotSelection,
  type StudioCase,
  type StudioTemplate,
} from "../src/template/index.ts";
import { bytesEqual, newErrorsAfter, reparse } from "./helpers.ts";
import { caseOf, loaderOf, manual, noticeKit, randomText, recordFor, studioOf, type NoticeKit } from "./generate-v2-helpers.ts";
import { done, ds, insertText, KEEP, line, rng, top, tpl } from "./range-helpers.ts";

const SHA = "e".repeat(64);

function failure(fn: () => unknown): HwpxError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아님: ${String(e)}`);
    return e;
  }
  assert.fail("오류가 나야 한다");
}

// ── 상호 배타: 문서 없이 읽기·선택 평가 ─────────────────────────────

const anchorLine = (id: string, p: number): Record<string, unknown> => ({ id, kind: "line", at: { sectionIndex: 0, path: [p] }, print: { text: "", sha256: SHA } });

/** 슬롯 넷(s1·s2: 업체 구분 in, s3: 금액 ≥ 1억, s4: 지역 eq), 슬롯마다 조건 블록 하나와 조건 없는 기본 블록 하나 */
function raw(extra: Record<string, unknown> = {}, when: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "hwpx-studio/template@2",
    id: "t0000e0c1",
    version: 1,
    source: { kind: "hwpx", sha256: SHA },
    anchors: [anchorLine("a1", 1), anchorLine("a2", 2), anchorLine("a3", 3), anchorLine("a4", 4)],
    values: [
      { id: "v1", name: "업체 구분", format: "text" },
      { id: "v2", name: "금액", format: "money" },
      { id: "v3", name: "지역", format: "text" },
    ],
    bindings: [
      { value: "v1", key: "업체 구분" },
      { value: "v2", key: "금액" },
      { value: "v3", key: "지역" },
    ],
    places: [],
    slots: [1, 2, 3, 4].map((n) => ({ id: `s${n}`, name: `분기 ${n}`, anchors: [`a${n}`], parent: null })),
    blocks: [
      { id: "b1", slot: "s1", name: "중소", content: { text: "중소 조항" }, when: when["b1"] ?? { path: "v1", op: "in", value: ["중소기업", "소기업"] } },
      { id: "b1d", slot: "s1", name: "기본", content: { text: "기본 1" } },
      { id: "b2", slot: "s2", name: "대기업", content: { text: "대기업 조항" }, when: when["b2"] ?? { path: "v1", op: "in", value: ["대기업", "중견기업"] } },
      { id: "b2d", slot: "s2", name: "기본", content: { text: "기본 2" } },
      { id: "b3", slot: "s3", name: "고액", content: { text: "고액 조항" }, when: when["b3"] ?? { path: "v2", op: "ge", value: 100000000 } },
      { id: "b3d", slot: "s3", name: "기본", content: { text: "기본 3" } },
      { id: "b4", slot: "s4", name: "지역 제한", content: { text: "지역 조항" }, when: when["b4"] ?? { path: "v3", op: "eq", value: "서울" } },
      { id: "b4d", slot: "s4", name: "기본", content: { text: "기본 4" } },
    ],
    ...extra,
  };
}
function make(r: Record<string, unknown>): StudioTemplate {
  const t = readStudioTemplate(JSON.stringify(r));
  assert.ok(t.schema === "hwpx-studio/template@2");
  return t;
}
function caseFor(t: StudioTemplate, selections: StudioCase["selections"] = {}): StudioCase {
  return { schema: "hwpx-studio/case@1", template: { id: t.id, version: t.version, sha256: SHA }, record: { dataset: "d00000001", version: 1, row: 0, sha256: SHA }, selections, valueEdits: {}, blockEdits: {} };
}
function judge(t: StudioTemplate, row: Record<string, unknown>, c?: StudioCase): Map<string, SlotSelection> {
  return new Map(selectSlots(t, bindValues(t, row, c, { missing: "keep" }), c).map((s) => [s.slot, s]));
}

test("배타 읽기: 같은 값의 eq·in 조건 값이 겹치면 TPL_EXCLUSIVE, 끊긴 슬롯은 TPL_REF, 모양이 틀리면 TPL_FIELD", () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["in과 in의 값이 겹침", raw({ exclusive: [["s1", "s2"]] }, { b2: { path: "v1", op: "in", value: ["소기업", "대기업"] } }), "TPL_EXCLUSIVE", "exclusive[0]"],
    ["eq와 in의 값이 같음", raw({ exclusive: [["s4", "s3"], ["s2", "s1"]] }, { b1: { path: "v1", op: "eq", value: "중견기업" } }), "TPL_EXCLUSIVE", "exclusive[1]"],
    ["수와 숫자 글은 조건 평가처럼 같은 값", raw({ exclusive: [["s3", "s4"]] }, { b3: { path: "v3", op: "in", value: [1, 2] }, b4: { path: "v3", op: "eq", value: "2" } }), "TPL_EXCLUSIVE", "exclusive[0]"],
    ["없는 슬롯", raw({ exclusive: [["s1", "s9"]] }), "TPL_REF", "exclusive[0]"],
    ["같은 슬롯 둘", raw({ exclusive: [["s1", "s1"]] }), "TPL_FIELD", "exclusive[0]"],
    ["슬롯 셋", raw({ exclusive: [["s1", "s2", "s3"]] }), "TPL_FIELD", "exclusive[0]"],
    ["배열이 아님", raw({ exclusive: { s1: "s2" } }), "TPL_FIELD", "템플릿"],
  ];
  for (const [name, r, code, where] of cases) {
    const e = failure(() => make(r));
    assert.equal(e.code, code, name);
    assert.equal(e.where, where, name);
  }
  // 메시지에는 슬롯·블록·값 id와 겹친 수만 있다(조건 값 원문 없음)
  const e = failure(() => make(cases[0]![1]));
  assert.match(e.message, /s1·s2의 블록 b1·b2가 같은 값 v1의 겹치는 조건 값 1개/);
  assert.doesNotMatch(e.message, /소기업/);
});

test("배타 읽기 통과: 값이 겹치지 않음·값이 다름·크기 비교는 읽기에서 막지 않고, 정규 쓰기와 왕복이 같다. 선언이 없으면 이전과 같은 결과", () => {
  for (const r of [raw({ exclusive: [["s1", "s2"]] }), raw({ exclusive: [["s1", "s4"], ["s2", "s4"]] }), raw({ exclusive: [["s1", "s3"]] }), raw({ exclusive: [] })]) {
    const t = make(r);
    assert.deepEqual(make(JSON.parse(writeStudioTemplate(t))), t);
  }
  const plain = make(raw());
  assert.equal(plain.exclusive, undefined);
  assert.ok(!writeStudioTemplate(plain).includes("exclusive"), "선언이 없으면 정규 JSON(해시)도 그대로");
  const row = { "업체 구분": "중소기업", 금액: "200,000,000", 지역: "서울" };
  // 선언이 없으면 모두 조건 블록을 골라도 막지 않는다
  assert.deepEqual([...judge(plain, row).values()].map((s) => [s.block, s.state, s.blocked]), [["b1", "default", undefined], ["b2d", "fallback", undefined], ["b3", "default", undefined], ["b4", "default", undefined]]);
});

test("배타 평가: 실제 업무 건에서 두 슬롯이 함께 조건 블록을 고르면 두 슬롯 다 SEL_EXCLUSIVE(상태는 그대로, 사유 exclusive). 수동 선택도 같다", () => {
  const t = make(raw({ exclusive: [["s1", "s3"], ["s2", "s4"]] }));
  // ① 중소기업·2억: s1 b1과 s3 b3이 함께 조건 블록 → 둘 다 막힘, s2·s4는 그대로
  const a = judge(t, { "업체 구분": "중소기업", 금액: "200,000,000", 지역: "부산" });
  for (const id of ["s1", "s3"]) {
    const s = a.get(id)!;
    assert.deepEqual([s.state, s.reason, s.blocked], ["default", "exclusive", "SEL_EXCLUSIVE"], id);
    assert.match(s.message, /배타 선언/);
  }
  assert.equal(a.get("s1")!.block, "b1");
  assert.match(a.get("s1")!.message, /슬롯 s3과\(와\)는 .* 조건 블록 b3\(고액\)/);
  assert.equal(a.get("s2")!.blocked, undefined);
  assert.equal(a.get("s4")!.blocked, undefined);
  // ② 서로 다른 값(업체 구분·지역)으로도: 대기업·서울
  const b = judge(t, { "업체 구분": "대기업", 금액: "1", 지역: "서울" });
  assert.deepEqual(["s2", "s4"].map((id) => b.get(id)!.blocked), ["SEL_EXCLUSIVE", "SEL_EXCLUSIVE"]);
  assert.deepEqual(["s1", "s3"].map((id) => b.get(id)!.blocked), [undefined, undefined]);
  // ③ 수동 선택: s3을 고액 조항으로 직접 고르고 s1은 조건으로 b1 → 막힘(수동의 상태는 manual 그대로)
  const c = caseFor(t, { s3: { block: "b3", basis: "manual", content: sha256Hex("고액 조항") } });
  const m = judge(t, { "업체 구분": "소기업", 금액: "5", 지역: "부산" }, c);
  assert.deepEqual([m.get("s3")!.state, m.get("s3")!.blocked, m.get("s1")!.blocked], ["manual", "SEL_EXCLUSIVE", "SEL_EXCLUSIVE"]);
  // ④ requireConfirm으로 확정을 기다리는 선택도 배타가 먼저 보인다
  const rc = make(raw({ exclusive: [["s1", "s3"]], options: { requireConfirm: true } }));
  const w = judge(rc, { "업체 구분": "중소기업", 금액: "200,000,000", 지역: "부산" });
  assert.deepEqual([w.get("s1")!.reason, w.get("s1")!.blocked, w.get("s2")!.reason], ["exclusive", "SEL_EXCLUSIVE", "needConfirm"]);
});

test("배타 평가 통과: 한쪽만 조건 블록·둘 다 기본 블록·수동으로 기본 블록을 고르면 막지 않는다. 판정하지 못한 슬롯은 원래 사유 그대로", () => {
  const t = make(raw({ exclusive: [["s1", "s3"], ["s2", "s4"]] }));
  const pass = (row: Record<string, unknown>, c?: StudioCase): void => {
    const all = [...judge(t, row, c).values()];
    assert.deepEqual(all.filter((s) => s.blocked !== undefined).map((s) => s.slot), [], JSON.stringify(row));
    assert.ok(all.every((s) => s.reason !== "exclusive"));
  };
  pass({ "업체 구분": "중소기업", 금액: "5", 지역: "부산" }); // s1만 조건 블록
  pass({ "업체 구분": "일반", 금액: "1", 지역: "부산" }); // 모두 기본 블록
  pass({ "업체 구분": "대기업", 금액: "300,000,000", 지역: "대구" }); // s2·s3 조건 블록이지만 서로 배타가 아니다
  pass({ "업체 구분": "중소기업", 금액: "200,000,000", 지역: "서울" }, caseFor(t, { s3: { block: "b3d", basis: "manual", content: sha256Hex("기본 3") } })); // 수동으로 기본 블록
  // 값이 없어 판정하지 못한 슬롯은 undecided(valueMissing) 그대로이고 짝 슬롯은 막히지 않는다
  const u = judge(t, { 금액: "200,000,000", 지역: "부산" });
  assert.deepEqual([u.get("s1")!.reason, u.get("s1")!.blocked, u.get("s3")!.blocked], ["valueMissing", "SEL_UNDECIDED", undefined]);
});

// ── 참조 번호 재정렬: 순수 함수 ────────────────────────────────────

const applyEdits = (texts: readonly string[], edits: readonly RenumberEdit[]): string[] =>
  texts.map((text, i) =>
    edits
      .filter((e) => e.index === i)
      .reverse()
      .reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), text),
  );
const renumbered = (texts: string[], patterns = ["붙임", "별지", "표"]): string[] => applyEdits(texts, planRenumber(texts, patterns).edits);

test("재정렬: 블록이 빠져 [붙임 1~3]이 [붙임 1·3]이 되면 대상·참조를 [붙임 1~2]로, 순서가 바뀌면 순서대로, 같은 번호의 목록·쪽 제목은 함께 바꾼다", () => {
  assert.deepEqual(renumbered(["[붙임 1] 신청서", "[붙임 3] 계획서", "본문: [붙임 1]과 [붙임 3]을 내고 (붙임 3 참조) 합니다."]), [
    "[붙임 1] 신청서",
    "[붙임 2] 계획서",
    "본문: [붙임 1]과 [붙임 2]을 내고 (붙임 2 참조) 합니다.",
  ]);
  // 순서가 바뀜: 나온 순서대로 1부터
  assert.deepEqual(renumbered(["참조 <별지 1>·<별지 2>", "<별지 2> 서약서", "<별지 1> 신청서"]), ["참조 <별지 2>·<별지 1>", "<별지 1> 서약서", "<별지 2> 신청서"]);
  // 목록(붙임 N.)과 쪽 제목([붙임 N])이 같은 번호를 쓰면 한 번호로 본다
  assert.deepEqual(renumbered(["붙임 1. 신청서 1부.", "붙임 4. 계획서 1부.", "", "[붙임 1]", "[붙임 4]", "<표 2> 일정", "(표 2 참조)"]), [
    "붙임 1. 신청서 1부.",
    "붙임 2. 계획서 1부.",
    "",
    "[붙임 1]",
    "[붙임 2]",
    "<표 1> 일정",
    "(표 1 참조)",
  ]);
  // 대상은 문단 첫머리(공백·개체 자리 글자 뒤)이고 뒤가 공백·글 끝일 때만. 꼴마다 따로 센다
  const plan = planRenumber(["  ￼<붙임 2>", "\t붙임 5. 서약서", "[붙임 9]를 작성합니다.", "<표 7>"], ["붙임", "표"]);
  assert.deepEqual([plan.targets, plan.references], [3, 1]);
  assert.deepEqual(applyEdits(["  ￼<붙임 2>", "\t붙임 5. 서약서", "[붙임 9]를 작성합니다.", "<표 7>"], plan.edits), ["  ￼<붙임 1>", "\t붙임 2. 서약서", "[붙임 9]를 작성합니다.", "<표 1>"]);
});

test("재정렬: 대응 없는 참조는 그대로 두고 꼴·번호마다 RENUMBER_UNMATCHED 경고(건수). 번호가 아닌 것(별표 1·표 3개·붙임1을·표 1.2·표 1-1)은 건드리지 않는다. 같은 입력은 같은 결과", () => {
  const texts = ["[붙임 1] 신청서", "[붙임 3] 계획서", "해당자는 [붙임 2]와 (붙임 2 참조), 또 [별지 4]."];
  const plan = planRenumber(texts, ["붙임", "별지"]);
  assert.deepEqual(applyEdits(texts, plan.edits), ["[붙임 1] 신청서", "[붙임 2] 계획서", "해당자는 [붙임 2]와 (붙임 2 참조), 또 [별지 4]."]);
  assert.deepEqual(
    plan.issues.map((i) => [i.severity, i.code, i.where, /'(.+)' (\d+)곳/.exec(i.message)?.slice(1)]),
    [
      ["warning", "RENUMBER_UNMATCHED", "renumber:붙임", ["붙임 2", "2"]],
      ["warning", "RENUMBER_UNMATCHED", "renumber:별지", ["별지 4", "1"]],
    ],
  );
  const noise = ["<표 2> 일정", "별표 1, 표 3개, 붙임1을, 표 1.2, 표 1-1, 도표 2, 표2"];
  assert.deepEqual(renumbered(noise), ["<표 1> 일정", "별표 1, 표 3개, 붙임1을, 표 1.2, 표 1-1, 도표 2, 표1"]);
  assert.deepEqual(planRenumber(texts, ["붙임", "별지"]), plan);
  assert.deepEqual(planRenumber(["[붙임 1] 그대로", "[붙임 1]"], ["붙임"]).edits, []);
  // 꼴에 정규식 글자가 있어도 글자 그대로 찾는다
  assert.deepEqual(renumbered(["[A.B 3] 첫째", "A.B 3 참조, AxB 3"], ["A.B"]), ["[A.B 1] 첫째", "A.B 1 참조, AxB 3"]);
});

test("재정렬 옵션 읽기: 꼴 목록 형식이 틀리면 TPL_OPTIONS, md 템플릿에는 쓸 수 없다. 맞으면 왕복이 같다", () => {
  const withOpt = (renumber: unknown, kind = "hwpx"): Record<string, unknown> => ({ ...raw(), source: { kind, sha256: SHA }, ...(kind === "md" ? { anchors: [], slots: [], blocks: [] } : {}), options: { renumber } });
  for (const bad of [{}, { patterns: [] }, { patterns: ["붙임 "] }, { patterns: ["붙임1"] }, { patterns: ["붙임", "붙임"] }, { patterns: ["열한글자가넘는긴꼴이름"] }, { patterns: [3] }, { patterns: ["붙임"], extra: true }, ["붙임"]]) {
    const e = failure(() => make(withOpt(bad)));
    assert.equal(e.code, "TPL_OPTIONS", JSON.stringify(bad));
  }
  assert.equal(failure(() => make(withOpt({ patterns: ["붙임"] }, "md"))).code, "TPL_OPTIONS");
  const t = make(withOpt({ patterns: ["붙임", "별지", "<표>"] }));
  assert.deepEqual(t.options?.renumber, { patterns: ["붙임", "별지", "<표>"] });
  assert.deepEqual(make(JSON.parse(writeStudioTemplate(t))), t);
});

// ── 2단계 생성: 합성 공고서 + 붙임 ──────────────────────────────────

/** 합성 공고서(63문단) 뒤에 붙임 목록·대상을 붙인 문서와, 그 [붙임 2] 문단을 슬롯 s5로 둔 템플릿(중소기업이면 b9, 아니면 b10이 지운다) */
const ATTACH = [
  "제출 서류: [붙임 1]과 [붙임 3]을 내고, 해당자는 (붙임 2 참조). 일정은 <표 1>과 같습니다. 담당 {{담당자}}",
  "[붙임 1] 입찰참가신청서 {{사업명}}",
  "[붙임 2] 중소기업 확인서",
  "[붙임 3] 사업계획서",
  "<표 1> 일정표",
  "끝. [붙임 3]의 서식은 별표 1과 다릅니다.",
];
type AttachKit = NoticeKit & { attached: Uint8Array; attachedDoc: HwpxDocument };
let attachCache: AttachKit | undefined;
function attachKit(): AttachKit {
  if (attachCache !== undefined) return attachCache;
  const k = noticeKit();
  const r = done(generate(k.bytes, tpl([line(k.doc, "end", [62])], [insertText("att", "end", ATTACH.join("\n"), "after")]), ds({}), KEEP));
  attachCache = { ...k, attached: r.output, attachedDoc: reparse(r.output) };
  return attachCache;
}
function attachTemplate(k: AttachKit, options: Record<string, unknown> = { renumber: { patterns: ["붙임", "표"] } }, edit: (raw: Record<string, any>) => void = () => {}): StudioTemplate {
  const r = structuredClone(k.raw) as Record<string, any>;
  r["source"] = { kind: "hwpx", sha256: sha256Hex(k.attached) };
  r["anchors"].push(line(k.attachedDoc, "a16", [65]));
  r["slots"].push({ id: "s5", name: "붙임 2", anchors: ["a16"], parent: null });
  r["blocks"].push(
    { id: "b9", slot: "s5", name: "중소기업 확인서", content: { text: "[붙임 2] 중소기업 확인서 {{기관명}}" }, when: { path: k.valueId("중소기업"), op: "eq", value: "Y" } },
    { id: "b10", slot: "s5", name: "없음", content: { text: "" } },
  );
  r["options"] = { ...r["options"], ...options };
  edit(r);
  return studioOf(r, k.blobs);
}
type Ok = Extract<StudioGenerateResult, { ok: true; dryRun: false }>;
function ok(r: StudioGenerateResult): Ok {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  assert.ok(!r.dryRun && r.output instanceof Uint8Array);
  return r as Ok;
}
const tail = (r: Ok, n: number): string[] => top(reparse(r.output as Uint8Array)).slice(-n).map((p) => p.logicalText);
const label = (name: string): string => `값[${name}]`;

test("생성: 붙임 2가 빠지면 대상·참조를 [붙임 1~2]로 다시 매기고(숫자만, 서식 그대로), 대응 없는 (붙임 2 참조)는 그대로 두고 경고. 채움과 같은 문단에서도 함께 된다", () => {
  const k = attachKit();
  const t = attachTemplate(k);
  const record = recordFor(label, { price: 1234, sme: "N" });
  const c = caseOf(t, record, { selections: { s2: manual(t, "s2", "b4") } });
  const r = ok(generateFromTemplate(k.attached, t, record, c, loaderOf(k.blobs)));
  assert.deepEqual(tail(r, 5), [
    "제출 서류: [붙임 1]과 [붙임 2]을 내고, 해당자는 (붙임 2 참조). 일정은 <표 1>과 같습니다. 담당 값[담당자]",
    "[붙임 1] 입찰참가신청서 값[사업명]",
    "[붙임 2] 사업계획서",
    "<표 1> 일정표",
    "끝. [붙임 2]의 서식은 별표 1과 다릅니다.",
  ]);
  assert.deepEqual(r.report.warnings.filter((w) => w.code === "RENUMBER_UNMATCHED").map((w) => [w.where, /'(.+)' (\d+)곳/.exec(w.message)?.slice(1)]), [["renumber:붙임", ["붙임 2", "1"]]]);
  assert.deepEqual(r.report.validation?.newErrors, []);
  // 서식 불변: 번호를 바꾼 문단의 문단 모양·글자 모양 참조가 원본 문단과 같다
  const before = top(k.attachedDoc).slice(-6);
  const after = top(reparse(r.output as Uint8Array)).slice(-5);
  for (const [i, j] of [[0, 0], [3, 2], [5, 4]] as const) {
    assert.equal(after[j]!.attrs.paraPrIDRef, before[i]!.attrs.paraPrIDRef);
    assert.deepEqual(after[j]!.runs.map((x) => x.charPrIDRef), before[i]!.runs.map((x) => x.charPrIDRef), `문단 ${i}`);
  }
  // 고른 블록이 [붙임 2]를 다시 넣으면 번호가 맞아 바꿀 것이 없다
  const recordY = recordFor(label, { price: 1234, sme: "Y" });
  const y = ok(generateFromTemplate(k.attached, t, recordY, caseOf(t, recordY, { selections: { s2: manual(t, "s2", "b4") } }), loaderOf(k.blobs)));
  assert.deepEqual(tail(y, 6).slice(1, 4), ["[붙임 1] 입찰참가신청서 값[사업명]", "[붙임 2] 중소기업 확인서 값[기관명]", "[붙임 3] 사업계획서"]);
  assert.equal(y.report.warnings.filter((w) => w.code === "RENUMBER_UNMATCHED").length, 0);
});

test("생성: 옵션이 없으면 번호를 건드리지 않고 경고도 없다. 바꿀 번호가 없으면 옵션을 켜도 출력 바이트가 같다", () => {
  const k = attachKit();
  const on = attachTemplate(k);
  const off = attachTemplate(k, {});
  assert.equal(off.options?.renumber, undefined);
  const recordN = recordFor(label, { price: 1234, sme: "N" });
  const n = ok(generateFromTemplate(k.attached, off, recordN, caseOf(off, recordN, { selections: { s2: manual(off, "s2", "b3") } }), loaderOf(k.blobs)));
  assert.deepEqual(tail(n, 5).slice(2, 5), ["[붙임 3] 사업계획서", "<표 1> 일정표", "끝. [붙임 3]의 서식은 별표 1과 다릅니다."]);
  assert.ok(n.report.issues.every((i) => !i.code.startsWith("RENUMBER")));
  const recordY = recordFor(label, { price: 200000000, sme: "Y" });
  const outs = [on, off].map((t) => ok(generateFromTemplate(k.attached, t, recordY, caseOf(t, recordY, { selections: { s2: manual(t, "s2", "b3") } }), loaderOf(k.blobs))).output as Uint8Array);
  assert.ok(bytesEqual(outs[0]!, outs[1]!), "바꿀 번호가 없으면 같은 바이트");
  // 바꿀 번호가 줄 자리와 겹치면 2단계가 TPL_CONFLICT로 막는다(자리끼리 겹침과 같은 규칙)
  const clash = attachTemplate(k, undefined, (r) => {
    r["anchors"].push(line(k.attachedDoc, "a17", [66]));
    r["places"].push({ id: "p99", kind: "line", anchor: "a17", value: k.valueId("사업명") });
  });
  const failed = generateFromTemplate(k.attached, clash, recordN, caseOf(clash, recordN, { selections: { s2: manual(clash, "s2", "b3") } }), loaderOf(k.blobs));
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.report.issues.filter((i) => i.severity === "error").map((i) => i.code), ["TPL_CONFLICT"]);
});

test("생성: 배타 위반이면 SEL_EXCLUSIVE로 출력 없이 막고, 위반이 없거나 수동으로 기본 블록을 고르면 생성한다. 읽기에서 같은 값이 겹치면 TPL_EXCLUSIVE", () => {
  const k = attachKit();
  // s1(추정가격 ≥ 1억 b1 / 중소기업 b1t)과 s4(추정가격 ≥ 5천만 b8): 크기 비교라 읽기는 통과
  const t = attachTemplate(k, {}, (r) => (r["exclusive"] = [["s1", "s4"]]));
  const run = (price: number, s4?: string): StudioGenerateResult => {
    const record = recordFor(label, { price, sme: "N" });
    return generateFromTemplate(k.attached, t, record, caseOf(t, record, { selections: { s2: manual(t, "s2", "b4"), ...(s4 === undefined ? {} : { s4: manual(t, "s4", s4) }) } }), loaderOf(k.blobs));
  };
  const blocked = run(200000000);
  assert.equal(blocked.ok, false);
  assert.ok(!("output" in blocked));
  assert.deepEqual(blocked.report.issues.filter((i) => i.severity === "error").map((i) => [i.code, i.where]), [["SEL_EXCLUSIVE", "slots.s1"], ["SEL_EXCLUSIVE", "slots.s4"]]);
  assert.equal(blocked.report.stage1, null);
  ok(run(60000000)); // s4만 조건 블록
  ok(run(1234)); // 둘 다 기본 블록
  ok(run(200000000, "b7")); // 수동으로 s4의 기본 블록
  // s1의 b1t(중소기업 = Y)와 s5의 b9(중소기업 = Y)는 같은 값으로 함께 골라진다
  const e = failure(() => attachTemplate(k, {}, (r) => (r["exclusive"] = [["s5", "s1"]])));
  assert.deepEqual([e.code, e.where], ["TPL_EXCLUSIVE", "exclusive[0]"]);
});

test("무작위 50회(시드 고정): 재정렬을 켠 2단계 생성(자리 41곳·같은 키 중복·0~1,500자 값·블록 선택)이 성공, 결정성, 검사기 새 오류 0, 결과는 다시 매길 번호가 없다", (ctx) => {
  const k = attachKit();
  const t = attachTemplate(k);
  const base = validateDocument(k.attached);
  const next = rng(196);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const tally = { dropped: 0, kept: 0 };
  for (let round = 0; round < 50; round++) {
    const sme = pick(["Y", "N"]);
    const record = recordFor(randomText(next), { price: pick([1, 60000000, 120000000]), sme });
    const c = caseOf(t, record, { selections: { s2: manual(t, "s2", pick(["b3", "b4"])) } });
    const r = ok(generateFromTemplate(k.attached, t, record, c, loaderOf(k.blobs)));
    const again = ok(generateFromTemplate(k.attached, t, record, c, loaderOf(k.blobs)));
    assert.ok(bytesEqual(r.output as Uint8Array, again.output as Uint8Array) && JSON.stringify(r.ledger) === JSON.stringify(again.ledger), `${round}회: 결정성`);
    assert.deepEqual(newErrorsAfter(base, validateDocument(r.output as Uint8Array)).map((v) => v.code), [], `${round}회: 새 오류`);
    const doc = reparse(r.output as Uint8Array);
    const texts = doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)].map((p) => p.logicalText));
    assert.deepEqual(planRenumber(texts, ["붙임", "표"]).edits, [], `${round}회: 다시 매길 번호가 남았다`);
    const end = top(doc).slice(sme === "Y" ? -6 : -5).map((p) => p.logicalText);
    const unmatched = r.report.warnings.filter((w) => w.code === "RENUMBER_UNMATCHED").length;
    if (sme === "Y") {
      assert.deepEqual([end[2]?.slice(0, 8), end[3], unmatched], ["[붙임 2] 중", "[붙임 3] 사업계획서", 0], `${round}회`);
      tally.kept++;
    } else {
      assert.ok(end[0]?.startsWith("제출 서류: [붙임 1]과 [붙임 2]을 내고, 해당자는 (붙임 2 참조).") && end[2] === "[붙임 2] 사업계획서" && unmatched === 1, `${round}회`);
      tally.dropped++;
    }
  }
  ctx.diagnostic(JSON.stringify(tally));
  assert.ok(tally.dropped >= 10 && tally.kept >= 10, JSON.stringify(tally));
});
