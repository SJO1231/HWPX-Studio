// 저장 게이트: E10 누락 키 정책(G2), E11 원래 오류가 있는 문서(baseline·strict·repair), E12 한컴 저장본 편집,
// G3 결정성, G4 게이트가 결함을 잡는다, 원장.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPlan, extractFragment, listFields, parseDocument, openPackage, readArchive, readEntry, serializeFragment, validateDocument, type HwpxDocument } from "../src/index.ts";
import {
  buildFillPlan,
  censusOfDoc,
  generate,
  verifyCensus,
  verifyChain,
  verifyExpectations,
  verifyPreservation,
  type GenerateOptions,
  type GenerateResult,
} from "../src/fill/index.ts";
import { emptyTemplate, readDataset, readTemplate, type Template } from "../src/template/index.ts";
import { buildHwpx, bytesEqual, loadDoc, mutateEntryText, readFixture, reparse, sha256Hex, utf8 } from "./helpers.ts";

const SEC = "Contents/section0.xml";

type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;

function done(r: GenerateResult): Done {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues)}`);
  assert.ok(!r.dryRun);
  return r as Done;
}

function failed(r: GenerateResult): string[] {
  assert.equal(r.ok, false, "생성이 성공해 버렸다");
  assert.ok(!("output" in r), "실패인데 출력이 있다");
  return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
}

const tpl = (spec: { anchors?: unknown[]; rules?: unknown[]; options?: unknown }): Template =>
  readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const ds = (data: unknown) => readDataset(data);
const text = (bytes: Uint8Array, entry = SEC): string => new TextDecoder().decode(readEntry(readArchive(bytes), bytes, entry));
const paragraphTexts = (doc: HwpxDocument): string[] => doc.sections[0]?.paragraphs.map((p) => p.logicalText) ?? [];
const fillRule = (id: string, anchor: string, value: unknown) => ({ id, do: { type: "fill", anchor, value } });
const lineAnchor = (id: string, path: number[], logical: string) => ({
  id,
  kind: "line",
  at: { sectionIndex: 0, path },
  print: { text: logical.slice(0, 40), sha256: sha256Hex(utf8(logical)) },
});
const OBJ = "￼";

// ── E10: 누락 키 정책(G2) ─────────────────────────────────────

const SINGLE = readFixture("hancom/ph-single");
const PARTIAL = { project: { name: "알파", start: "S" } };

test("E10·G2: missing=error — DATA_MISSING으로 전체 중단, 파일 미생성. 모든 누락 경로를 한 번에 보고하고 값 원문은 담지 않는다", () => {
  const r = generate(SINGLE, emptyTemplate(), ds({ project: { name: "비밀값" } }));
  assert.deepEqual(failed(r), ["DATA_MISSING", "DATA_MISSING"]);
  assert.deepEqual(r.report.plan.missingPaths, ["project.end", "project.start"]);
  assert.ok(!JSON.stringify(r.report).includes("비밀값"));
  assert.equal(r.report.stages.length, 0, "적용 단계에 들어가지 않았다");
});

test("E10·G2: missing=empty는 빈 글로 채우고, keep은 자리를 그대로 두며, 둘 다 보고와 함께 진행한다", () => {
  const empty = done(generate(SINGLE, emptyTemplate(), ds(PARTIAL), { missing: "empty" }));
  assert.deepEqual(paragraphTexts(reparse(empty.output)).slice(1), ["사업명: 알파 입니다.", "기간: S ~ "]);
  assert.deepEqual(empty.report.plan.missingPaths, ["project.end"]);
  assert.deepEqual(empty.report.plan.kept, []);

  const keep = done(generate(SINGLE, emptyTemplate(), ds(PARTIAL), { missing: "keep" }));
  assert.deepEqual(paragraphTexts(reparse(keep.output)).slice(1), ["사업명: 알파 입니다.", "기간: S ~ {{project.end}}"]);
  assert.deepEqual(keep.report.plan.kept, [{ path: "project.end", count: 1 }]);
  assert.deepEqual(keep.report.plan.missingPaths, ["project.end"]);
  assert.ok(text(keep.output).includes("{{project.end}}"));
});

test("E10·G2: 정책은 템플릿 options.missing으로도 정하고, 호출 옵션이 앞선다. null도 없는 값으로 본다", () => {
  const t = tpl({ options: { missing: "empty" } });
  assert.deepEqual(paragraphTexts(reparse(done(generate(SINGLE, t, ds(PARTIAL))).output))[2], "기간: S ~ ");
  assert.deepEqual(paragraphTexts(reparse(done(generate(SINGLE, t, ds(PARTIAL), { missing: "keep" })).output))[2], "기간: S ~ {{project.end}}");
  assert.deepEqual(failed(generate(SINGLE, t, ds(PARTIAL), { missing: "error" })), ["DATA_MISSING"]);
  const withNull = { project: { name: "알파", start: "S", end: null } };
  assert.deepEqual(failed(generate(SINGLE, emptyTemplate(), ds(withNull))), ["DATA_MISSING"]);
});

test("E10·G2: 명시한 fill 규칙도 같은 정책을 따른다(빈 글이면 dirty·글자모양을 건드리지 않는다)", () => {
  const fields = readFixture("hancom/field-states");
  const t = tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }], rules: [fillRule("r", "a", { path: "없는.경로" })] });
  // 소속 누름틀은 규칙이 없어 이름(소속)을 경로로 암묵 채움 대상이다: 같은 값을 데이터에 두어 이 시험이 규칙의 누락 정책만 보게 한다
  const data = ds({ 소속: "합성기관" });
  assert.deepEqual(failed(generate(fields, t, data)), ["DATA_MISSING"]);
  const empty = done(generate(fields, t, data, { missing: "empty" }));
  assert.deepEqual(listFields(reparse(empty.output)).map((f) => [f.valueText, f.dirty]), [["", "0"], ["합성기관", "1"], ["", "0"]]);
  const keep = done(generate(fields, t, data, { missing: "keep" }));
  assert.ok(bytesEqual(keep.output, fields), "keep이면 편집이 없다");
  assert.deepEqual(keep.report.plan.kept, [{ path: "없는.경로", count: 1 }]);
});

test("E10: 객체·배열 값은 DATA_NOT_SCALAR, 금지 문자(제어 문자)가 든 값은 VALUE_CONTROL_CHAR로 거절한다(줄바꿈·탭은 요소로 넣는다: fill-linebreak.test.ts)", () => {
  const base = { project: { name: "알파", start: "S", end: "E" } };
  assert.deepEqual(failed(generate(SINGLE, emptyTemplate(), ds({ project: { ...base.project, end: { a: 1 } } }))), ["DATA_NOT_SCALAR"]);
  assert.deepEqual(failed(generate(SINGLE, emptyTemplate(), ds({ project: { ...base.project, end: ["x"] } }))), ["DATA_NOT_SCALAR"]);
  for (const bad of ["제어\u0001", "\ud800"]) {
    assert.deepEqual(failed(generate(SINGLE, emptyTemplate(), ds({ project: { ...base.project, end: bad } }))), ["VALUE_CONTROL_CHAR"]);
  }
});

// ── E11: 원래 오류가 있는 문서 ─────────────────────────────────

const FEATURES = readFixture("extra/features-picture");

function featuresTemplate(): Template {
  const doc = reparse(FEATURES);
  const last = doc.sections[0]?.paragraphs.length ?? 1;
  const logical = doc.sections[0]?.paragraphs[last - 1]?.logicalText ?? "";
  return tpl({ anchors: [lineAnchor("a", [last - 1], logical)], rules: [fillRule("r", "a", { text: "새 마지막 문단" })] });
}

/** 가짜 보정: 중복된 문단 id의 뒤쪽 것을 새 값으로 바꾼다(실제 보정 모듈 대신 흐름만 확인한다). */
function dedupeParagraphIds(bytes: Uint8Array): { output: Uint8Array; repaired: unknown[] } {
  const xml = text(bytes);
  const ids = [...xml.matchAll(/<hp:p [^>]*?\bid="(\d+)"/g)].map((m) => m[1] ?? "");
  const dup = ids.find((id, i) => id !== "0" && ids.indexOf(id) !== i);
  assert.ok(dup !== undefined, "원본에 중복된 문단 id가 있다");
  let seen = 0;
  const output = mutateEntryText(bytes, SEC, (x) => x.replace(new RegExp(`(<hp:p [^>]*?\\bid=")${dup}(")`, "g"), (_m, a: string, b: string) => (seen++ === 0 ? `${a}${dup}${b}` : `${a}999000111${b}`)));
  return { output, repaired: [{ kind: "reissueIds", count: 1 }] };
}

test("E11: baseline — 원래 있던 오류는 경고로 보고하고 통과한다", () => {
  assert.deepEqual(validateDocument(FEATURES).errors.map((e) => e.code), ["INST_DUP_ID"]);
  const r = done(generate(FEATURES, featuresTemplate(), ds({}), { missing: "keep" })); // 문서의 이름 있는 누름틀은 암묵 채움 대상이라 데이터가 없으면 그대로 둔다
  assert.deepEqual(r.report.validation?.newErrors, []);
  assert.deepEqual(r.report.validation?.preexisting.map((e) => e.code), ["INST_DUP_ID"]);
  assert.ok(r.report.issues.some((i) => i.severity === "warning" && i.code === "INST_DUP_ID" && i.message.startsWith("원래 있던 오류")));
  assert.ok(!r.report.issues.some((i) => i.severity === "error"));
  assert.equal(r.report.mode, "baseline");
  assert.equal(paragraphTexts(reparse(r.output)).at(-1), "새 마지막 문단");
});

test("E11: strict — 원래 오류까지 포함해 오류가 하나라도 있으면 차단하고 출력이 없다", () => {
  const r = generate(FEATURES, featuresTemplate(), ds({}), { mode: "strict", missing: "keep" });
  const codes = failed(r);
  assert.ok(codes.includes("INST_DUP_ID") && codes.includes("GATE_ERRORS"), codes.join());
  assert.ok(codes.includes("RES_DANGLING"), "엄격 방식은 한컴이 받아 주는 위반도 오류로 올린다");
  // 오류가 없는 문서는 strict도 통과한다
  const clean = done(generate(SINGLE, emptyTemplate(), ds({ project: { name: "a", start: "b", end: "c" } }), { mode: "strict" }));
  assert.equal(clean.report.mode, "strict");
});

test("E11: repair — 주입된 보정 함수로 먼저 고친 결과를 원본으로 삼아 통과하고, 원장에 보정 결과를 남긴다", () => {
  const r = done(generate(FEATURES, featuresTemplate(), ds({}), { mode: "repair", repair: dedupeParagraphIds, missing: "keep" }));
  assert.equal(r.report.repaired, 1);
  assert.equal(validateDocument(r.output).errors.length, 0, "재발급 뒤 오류가 없다");
  assert.deepEqual(r.report.validation?.preexisting, []);
  assert.equal(r.ledger.input.sha256, sha256Hex(FEATURES), "원장의 입력 해시는 보정 전 원본의 것");
  assert.equal(r.ledger.repaired?.notes, 1);
  assert.notEqual(r.ledger.repaired?.sha256, r.ledger.input.sha256);
  assert.equal(r.ledger.mode, "repair");
  // 보정 함수가 없으면 FILL_REPAIR_UNAVAILABLE
  assert.deepEqual(failed(generate(FEATURES, featuresTemplate(), ds({}), { mode: "repair" })), ["FILL_REPAIR_UNAVAILABLE"]);
  // 보정이 새 오류를 만들면 거절한다
  const breaking = (bytes: Uint8Array): { output: Uint8Array; repaired: unknown[] } => ({
    output: mutateEntryText(bytes, SEC, (x) => x.replace('<hp:tbl id="1001"', '<hp:tbl id="1002"')),
    repaired: [],
  });
  assert.ok(failed(generate(FEATURES, featuresTemplate(), ds({}), { mode: "repair", repair: breaking, missing: "keep" })).includes("GATE_REPAIR_REGRESSED"));
});

test("E11: baseline이라도 편집이 새 오류를 만들면 GATE_NEW_ERRORS로 막는다(짝 없는 누름틀이 든 조각)", () => {
  const blocks = readFixture("hancom/blocks");
  const fragment = JSON.parse(serializeFragment(extractFragment(loadDoc("hancom/ph-single"), { sectionIndex: 0, parentPath: [], from: 1, to: 1 }))) as { xml: string };
  fragment.xml = fragment.xml.replace(/<\/hp:p>$/, '<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="9" type="CLICK_HERE" name="x" fieldid="1"/></hp:ctrl></hp:run></hp:p>');
  const doc = reparse(blocks);
  const t = tpl({
    anchors: [lineAnchor("a", [5], doc.sections[0]?.paragraphs[5]?.logicalText ?? "")],
    rules: [{ id: "r", do: { type: "inject", anchor: "a", position: "after", fragment } }],
  });
  const codes = failed(generate(blocks, t, ds({}), { missing: "keep" }));
  assert.ok(codes.includes("FIELD_UNPAIRED_BEGIN") && codes.includes("GATE_NEW_ERRORS"), codes.join());
});

// ── E12: 한컴 저장본 편집 ──────────────────────────────────────

test("E12: 한컴 저장본을 편집하면 그 구역의 줄 배치 캐시가 전부 사라지고 다른 항목·수량은 그대로다", () => {
  const bytes = readFixture("hancom-merged");
  const doc = reparse(bytes);
  const index = doc.sections[0]?.paragraphs.findIndex((p, i) => i > 0 && p.objects.length === 0 && p.logicalText.length > 3) ?? -1;
  assert.ok(index > 0);
  const original = text(bytes);
  assert.equal(original.match(/<hp:linesegarray>/g)?.length, 91);
  const t = tpl({ anchors: [lineAnchor("a", [index], doc.sections[0]?.paragraphs[index]?.logicalText ?? "")], rules: [fillRule("r", "a", { text: "편집한 문단" })] });
  const r = done(generate(bytes, t, ds({})));
  const xml = text(r.output);
  assert.ok(!xml.includes("linesegarray"), "캐시가 남았다");
  // 글 밖은 그대로: 글·캐시를 지운 뼈대가 같다
  const skeleton = (x: string): string => x.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "").replace(/<hp:t>[^<]*<\/hp:t>/g, "<hp:t/>");
  assert.equal(skeleton(xml), skeleton(original));
  // 다른 항목은 바이트 동일
  const a = readArchive(bytes);
  const b = readArchive(r.output);
  for (const e of a.entries) {
    if (e.name === SEC) continue;
    const f = b.entries.find((x) => x.name === e.name);
    assert.ok(f !== undefined && bytesEqual(bytes.subarray(e.localStart, e.localEnd), r.output.subarray(f.localStart, f.localEnd)), e.name);
  }
  // 수량 동일
  assert.deepEqual(validateDocument(r.output).census, validateDocument(bytes).census);
  assert.equal(doc.sections[0]?.paragraphs.length, reparse(r.output).sections[0]?.paragraphs.length);
});

test("E12: 편집이 없는 구역의 줄 배치 캐시와 항목은 그대로 둔다(구역이 둘인 문서)", () => {
  const p = (t: string): string =>
    `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run>` +
    '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42000" flags="0"/></hp:linesegarray></hp:p>';
  const bytes = buildHwpx([p("{{a}} 첫째") + p("둘째"), p("셋째") + p("넷째")]);
  const r = done(generate(bytes, emptyTemplate(), ds({ a: "값" })));
  const a = readArchive(bytes);
  const b = readArchive(r.output);
  assert.equal(text(r.output, "Contents/section0.xml").match(/linesegarray/g), null, "편집한 구역은 캐시가 전부 없다");
  assert.equal(text(r.output, "Contents/section1.xml").match(/<hp:linesegarray>/g)?.length, 2, "편집하지 않은 구역은 캐시가 그대로다");
  for (const e of a.entries) {
    if (e.name === "Contents/section0.xml") continue;
    const f = b.entries.find((x) => x.name === e.name);
    assert.ok(f !== undefined && bytesEqual(bytes.subarray(e.localStart, e.localEnd), r.output.subarray(f.localStart, f.localEnd)), e.name);
  }
});

// ── G3: 결정성, 원장 ───────────────────────────────────────────

test("G3: 같은 입력으로 두 번 생성하면 출력 바이트·원장·보고서가 같다(채움·삭제·삽입·주입을 섞어서)", () => {
  const blocks = readFixture("hancom/blocks");
  const doc = reparse(blocks);
  const fragment = JSON.parse(serializeFragment(extractFragment(loadDoc("hancom/ph-single"), { sectionIndex: 0, parentPath: [], from: 1, to: 2 }))) as Record<string, unknown>;
  const anchors = [
    lineAnchor("p1", [1], "개요 본문입니다."),
    lineAnchor("p3", [3], "선택 조항 본문입니다. (해당 시)"),
    { id: "c", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 2, col: 1 },
    { id: "row", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 0 },
  ];
  const rules = [
    fillRule("f", "p1", { path: "memo" }),
    fillRule("g", "c", { path: "memo" }),
    { id: "d", do: { type: "delete", anchor: "row", scope: "row" } },
    { id: "i", do: { type: "insertText", anchor: "p3", position: "before", value: { path: "memo" } } },
    { id: "j", do: { type: "inject", anchor: "p3", position: "after", fragment } },
  ];
  const data = { memo: "메모 값", project: { name: "N", start: "S", end: "E" } };
  const run = (): Done => done(generate(blocks, tpl({ anchors, rules }), ds(data)));
  const a = run();
  const b = run();
  assert.ok(bytesEqual(a.output, b.output));
  assert.equal(JSON.stringify(a.ledger), JSON.stringify(b.ledger));
  assert.equal(JSON.stringify(a.report), JSON.stringify(b.report));
  assert.equal(a.report.stages.length, 2);
  assert.equal(doc.sections.length, 1);
  // 키 순서가 달라도 같은 템플릿이면 원장의 해시가 같다
  const reordered = readTemplate(JSON.parse(JSON.stringify({ rules, anchors, options: {}, schema: "hwpx-studio/template@1" })));
  assert.equal(done(generate(blocks, reordered, ds(data))).ledger.template.sha256, a.ledger.template.sha256);
  // 템플릿·데이터가 다르면 해시가 다르다
  const other = done(generate(blocks, tpl({ anchors, rules }), ds({ ...data, memo: "다른" })));
  assert.notEqual(other.ledger.dataset.sha256, a.ledger.dataset.sha256);
  assert.notEqual(other.ledger.output.sha256, a.ledger.output.sha256);
});

test("원장: 입력·템플릿·데이터·출력 해시와 수량이 있고, 시각이 없으며 값 원문은 길이와 해시 앞 8자뿐이다", () => {
  const data = { project: { name: "비밀 사업명", start: "2026-01-02", end: "끝" } };
  const r = done(generate(SINGLE, emptyTemplate(), ds(data)));
  assert.equal(r.ledger.schema, "hwpx-studio/ledger@1");
  assert.equal(r.ledger.input.sha256, sha256Hex(SINGLE));
  assert.equal(r.ledger.input.bytes, SINGLE.length);
  assert.equal(r.ledger.output.sha256, sha256Hex(r.output));
  assert.equal(r.ledger.output.bytes, r.output.length);
  assert.match(r.ledger.template.sha256, /^[0-9a-f]{64}$/);
  assert.match(r.ledger.dataset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.ledger.mode, "baseline");
  assert.deepEqual([r.ledger.counts.actions, r.ledger.counts.stages], [3, 1]);
  const blob = JSON.stringify([r.ledger, r.report]);
  for (const secret of ["비밀 사업명", "2026-01-02"]) assert.ok(!blob.includes(secret), `값 원문이 있다: ${secret}`);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}/.test(blob), "시각이 있다");
  const name = r.ledger.actions.find((a) => a.anchor === "{{project.name}}");
  assert.deepEqual(name?.value, { length: 6, sha256: sha256Hex(utf8("비밀 사업명")).slice(0, 8) });
});

// ── G4: 게이트가 일부러 넣은 결함을 잡는다 ──────────────────────

const DATA_SINGLE = { project: { name: "알파", start: "S", end: "E" } };

function hook(change: (bytes: Uint8Array) => Uint8Array): GenerateOptions {
  return { testHooks: { afterApply: (bytes) => change(bytes) } };
}

test("G4: 계획 밖 구간을 바꾼 출력은 PRESERVE_SPAN으로 막는다", () => {
  const tampered = hook((b) => mutateEntryText(b, SEC, (x) => x.replace("합성 시험 문서", "합성 시험 문서X")));
  const r = generate(SINGLE, emptyTemplate(), ds(DATA_SINGLE), tampered);
  assert.ok(failed(r).includes("PRESERVE_SPAN"));
  assert.equal(r.report.stages.length, 0);
});

test("G4: 값이 다른 출력은 값 재읽기(REREAD_TEXT)와 계획 대조로 막는다", () => {
  const r = generate(SINGLE, emptyTemplate(), ds(DATA_SINGLE), hook((b) => mutateEntryText(b, SEC, (x) => x.replace("사업명: 알파", "사업명: 베타"))));
  const codes = failed(r);
  assert.ok(codes.includes("REREAD_TEXT") && codes.includes("PRESERVE_SPAN"), codes.join());
  // 누름틀: 값이 다르거나 dirty가 꺼진 출력
  const fields = readFixture("hancom/field-states");
  const t = tpl({ anchors: [{ id: "a", kind: "field", name: "소속" }], rules: [fillRule("r", "a", { text: "값" })] });
  const wrong = generate(fields, t, ds({}), { ...hook((b) => mutateEntryText(b, SEC, (x) => x.replace("<hp:t>값</hp:t>", "<hp:t>갑</hp:t>"))), missing: "keep" });
  assert.ok(failed(wrong).includes("REREAD_FIELD"));
});

test("G4: 수량이 예고와 다른 출력(문단이 사라짐)은 PRESERVE_CENSUS로 막는다", () => {
  const dropParagraph = hook((b) => mutateEntryText(b, SEC, (x) => x.replace(/<hp:p [^>]*><hp:run charPrIDRef="0"><hp:t>기간:[^]*?<\/hp:p>/, "")));
  const codes = failed(generate(SINGLE, emptyTemplate(), ds(DATA_SINGLE), dropParagraph));
  assert.ok(codes.includes("PRESERVE_CENSUS"), codes.join());
});

test("G4: 계획에 없는 항목을 바꾼 출력은 PRESERVE_RECORD_CHANGED로 막는다", () => {
  const r = generate(SINGLE, emptyTemplate(), ds(DATA_SINGLE), hook((b) => mutateEntryText(b, "Contents/header.xml", (x) => x.replace("<hh:head ", "<hh:head data-x=\"1\" "))));
  assert.ok(failed(r).includes("PRESERVE_RECORD_CHANGED"));
});

test("G4: 보존 확인·값 재읽기·수량 대조를 변조한 출력으로 직접 호출해도 각자 잡는다", () => {
  const doc = reparse(SINGLE);
  const { plan, report } = buildFillPlan(doc, emptyTemplate(), ds(DATA_SINGLE));
  assert.equal(report.issues.length, 0);
  const output = applyPlan(doc.pkg, { edits: plan.edits, additions: plan.additions, summary: plan.summary, issues: [] });
  // 변조하지 않은 출력은 통과한다
  assert.deepEqual(verifyPreservation(SINGLE, output, plan), []);
  assert.deepEqual(verifyChain(SINGLE, output, [plan]), []);
  const after = reparse(output);
  assert.deepEqual(verifyExpectations(after, plan.edits, plan.expectations).issues, []);
  assert.deepEqual(verifyCensus(censusOfDoc(doc), censusOfDoc(after), plan.delta), []);

  // 계획 밖 구간 변조
  const outside = mutateEntryText(output, SEC, (x) => x.replace("합성 시험 문서", "합성 시험 문서X"));
  assert.deepEqual(verifyPreservation(SINGLE, outside, plan).map((i) => i.code), ["PRESERVE_SPAN"]);
  // 계획의 치환과 다른 값
  const value = mutateEntryText(output, SEC, (x) => x.replace("사업명: 알파", "사업명: 베타"));
  assert.deepEqual(verifyPreservation(SINGLE, value, plan).map((i) => i.code), ["PRESERVE_SPAN"]);
  const reread = verifyExpectations(reparse(value), plan.edits, plan.expectations);
  assert.deepEqual(reread.issues.map((i) => i.code), ["REREAD_TEXT"]);
  assert.ok(reread.issues.every((i) => !i.message.includes("베타") && !i.message.includes("알파")), "메시지에 값 원문이 있다");
  // 수량 불일치: 문단 하나가 늘어난 출력에 증감 0을 예고
  const extra = mutateEntryText(output, SEC, (x) => x.replace("</hs:sec>", `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>끼어듦</hp:t></hp:run></hp:p></hs:sec>`));
  assert.deepEqual(verifyCensus(censusOfDoc(doc), censusOfDoc(reparse(extra)), plan.delta).map((i) => i.code), ["PRESERVE_CENSUS"]);
  // 항목이 빠진 출력, 손대지 않은 항목의 변조
  const header = mutateEntryText(output, "Contents/header.xml", (x) => x.replace("<hh:head ", "<hh:head data-x=\"1\" "));
  assert.deepEqual(verifyPreservation(SINGLE, header, plan).map((i) => i.code), ["PRESERVE_RECORD_CHANGED"]);
  assert.deepEqual(verifyChain(SINGLE, header, [plan]).map((i) => i.code), ["PRESERVE_RECORD_CHANGED"]);
  // 계획에 없는 추가 항목
  const added = { ...plan, additions: [{ name: "BinData/x.png", data: utf8("x"), method: 0 as const }] };
  assert.ok(verifyPreservation(SINGLE, output, added).some((i) => i.code === "PRESERVE_ENTRY_ORDER"));
  // 다시 읽을 수 없는 출력
  assert.deepEqual(verifyPreservation(SINGLE, utf8("zip 아님"), plan).map((i) => i.code), ["PRESERVE_UNREADABLE"]);
});

test("G4: 게이트가 입력을 열 수 없으면 HwpxError를 던진다(보고서가 아니라 예외)", () => {
  assert.throws(() => generate(utf8("zip 아님"), emptyTemplate(), ds({})), (e: unknown) => e instanceof Error && "code" in e && (e as { code: string }).code === "PKG_NOT_ZIP");
  assert.equal(parseDocument(openPackage(SINGLE)).sections.length, 1);
});
