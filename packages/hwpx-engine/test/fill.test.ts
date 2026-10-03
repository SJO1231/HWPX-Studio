// 채움(E1~E5, 앵커 해석, 자리별 채움 규칙). 기대값은 명세와 독립 기준(정규식·fixtures의 원문)에서 만든다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTableNode, listFields, readArchive, readEntry, walkParagraphs, type HwpxDocument } from "../src/index.ts";
import { generate, resolveAnchors, type GenerateOptions, type GenerateResult } from "../src/fill/index.ts";
import { emptyTemplate, readDataset, readTemplate, type Template } from "../src/template/index.ts";
import {
  FIXTURE_NAMES,
  buildHwpx,
  bytesEqual,
  loadDoc,
  mutateEntryText,
  readFixture,
  reparse,
  sha256Hex,
  utf8,
} from "./helpers.ts";

const SEC = "Contents/section0.xml";

export type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;

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

/** 줄 앵커: 지문은 문단의 글에서 독립으로 만든다(앞 40자와 전체 sha256). */
const lineAnchor = (id: string, path: number[], logical: string) => ({
  id,
  kind: "line",
  at: { sectionIndex: 0, path },
  print: { text: logical.slice(0, 40), sha256: sha256Hex(utf8(logical)) },
});

const wordAnchor = (id: string, path: number[], logical: string, target: string, occurrence = 0) => {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = logical.indexOf(target, start + 1);
  const end = start + target.length;
  return {
    id,
    kind: "word",
    at: { sectionIndex: 0, path },
    start,
    end,
    print: { text: target, before: logical.slice(Math.max(0, start - 24), start), after: logical.slice(end, end + 24) },
  };
};

const fillRule = (id: string, anchor: string, value: unknown, when?: unknown) => ({ id, ...(when === undefined ? {} : { when }), do: { type: "fill", anchor, value } });

/** 보존 계약의 ZIP 수준: 항목 이름 순서가 같고 `changed` 밖의 로컬 레코드는 바이트 동일하다. */
function assertOthersIdentical(before: Uint8Array, after: Uint8Array, changed: string[] = [SEC]): void {
  const a = readArchive(before);
  const b = readArchive(after);
  assert.deepEqual(b.entries.map((e) => e.name), a.entries.map((e) => e.name));
  for (const e of a.entries) {
    if (changed.includes(e.name)) continue;
    const f = b.entries.find((x) => x.name === e.name);
    assert.ok(f !== undefined);
    assert.ok(bytesEqual(before.subarray(e.localStart, e.localEnd), after.subarray(f.localStart, f.localEnd)), `${e.name}의 로컬 레코드가 바뀜`);
  }
}

/** 글·글자모양 참조·dirty·줄 배치 캐시를 지운 뼈대. 채움 전후의 뼈대가 같으면 글 밖은 바뀌지 않은 것이다. */
function skeleton(xml: string): string {
  return xml
    .replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "")
    .replace(/<hp:t>[^<]*<\/hp:t>/g, "<hp:t/>")
    .replace(/charPrIDRef="\d+"/g, 'charPrIDRef=""')
    .replace(/ dirty="\d"/g, "");
}

const paragraphTexts = (doc: HwpxDocument): string[] => doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)].map((p) => p.logicalText));

// ── E1 ─────────────────────────────────────────────────────────

test("E1: 채울 것이 없으면 원본 복사본을 내지 않고 FILL_NOTHING_APPLIED로 실패한다(출력 없음, 보고서·건너뜀 사유는 남는다)", () => {
  const names = [...FIXTURE_NAMES, "hancom/blocks", "hancom/picture", "hancom/field-states", "extra/features-picture", "extra/features-rhwp"];
  for (const name of names) {
    const bytes = readFixture(name);
    // 누름틀이 든 문서는 누락 정책 keep으로 자리를 그대로 두게 한다(이름이 경로인 누름틀은 암묵으로 채워지므로)
    const r = generate(bytes, emptyTemplate(), ds({}), { missing: "keep" });
    assert.deepEqual(failed(r), ["FILL_NOTHING_APPLIED"], name);
    assert.deepEqual(r.report.plan.actions, [], name);
    assert.ok(!("ledger" in r), `${name}: 원장이 없다`);
  }
});

test("E1: 채울 것이 없을 때 건너뜀 사유가 오류 메시지에 든다", () => {
  const bytes = buildHwpx(['<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>가 {{x}}\u{301} 나</hp:t></hp:run></hp:p>']);
  const r = generate(bytes, emptyTemplate(), ds({ x: "값" }));
  assert.deepEqual(failed(r), ["FILL_NOTHING_APPLIED"]);
  assert.match(r.report.issues[0]?.message ?? "", /FILL_SPLITS_CLUSTER 1곳/);
  assert.deepEqual(r.report.plan.skipped.map((s) => s.code), ["FILL_SPLITS_CLUSTER"]);
  // 모의 실행도 같다
  assert.equal(generate(bytes, emptyTemplate(), ds({ x: "값" }), { dryRun: true }).ok, false);
});

test("E1: 모의 실행(dryRun)은 보고서만 돌려주고 출력이 없다", () => {
  const bytes = readFixture("hancom/ph-single");
  const r = generate(bytes, emptyTemplate(), ds({ project: { name: "알파", start: "가", end: "나" } }), { dryRun: true });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.dryRun && !("output" in r));
  assert.deepEqual(r.report.plan.requiredPaths, ["project.end", "project.name", "project.start"]);
  assert.equal(r.report.plan.actions.length, 3);
});

// ── E2 ─────────────────────────────────────────────────────────

const FIELD_TEMPLATE = tpl({
  anchors: [
    { id: "a1", kind: "field", name: "성명" },
    { id: "a2", kind: "field", name: "소속" },
  ],
  rules: [fillRule("r1", "a1", { path: "applicant.name" }), fillRule("r2", "a2", { path: "org" })],
});

test("E2: 누름틀 채움 — 값 재읽기 일치, dirty=1, 안내문 run의 글자모양이 시작 컨트롤 run의 것으로 바뀐다(안내문과 같은 값 포함)", () => {
  const bytes = readFixture("hancom/field-states");
  const original = text(bytes);
  assert.equal(original.match(/charPrIDRef="7"/g)?.length, 2, "원본에는 안내문 run(글자모양 7)이 둘 있다");
  for (const value of ["홍길동", "이름을 입력"]) {
    const r = done(generate(bytes, FIELD_TEMPLATE, ds({ applicant: { name: value }, org: "새 기관" })));
    const out = reparse(r.output);
    assert.deepEqual(
      listFields(out).map((f) => [f.name, f.valueText, f.dirty, f.shape]),
      [["성명", value, "1", "simple"], ["소속", "새 기관", "1", "simple"], ["성명", value, "1", "simple"]],
    );
    // 독립 기준: 정규식으로 시작 컨트롤이 든 run과 값이 든 run의 글자모양을 뽑는다
    const xml = text(r.output);
    const beginRuns = [...xml.matchAll(/<hp:run charPrIDRef="(\d+)">(?:<hp:t>[^<]*<\/hp:t>)?<hp:ctrl><hp:fieldBegin [^>]*name="성명"/g)].map((m) => m[1]);
    const valueRuns = [...xml.matchAll(new RegExp(`<hp:run charPrIDRef="(\\d+)"><hp:t>${value}</hp:t></hp:run>`, "g"))].map((m) => m[1]);
    assert.deepEqual(valueRuns, beginRuns);
    assert.equal(beginRuns.length, 2);
    assert.ok(!xml.includes('charPrIDRef="7"') && !xml.includes('dirty="0"'));
    // 보존 계약: 글·글자모양·dirty·줄 배치 캐시 밖은 그대로
    assert.equal(skeleton(xml), skeleton(original));
    assertOthersIdentical(bytes, r.output);
    assert.ok(r.report.reread.fields === 3, "채운 누름틀 3개를 다시 읽었다");
  }
});

test("E2: 순번을 주면 그 누름틀만 채운다. 이름은 정확히 일치해야 한다", () => {
  const bytes = readFixture("hancom/field-states");
  const t = tpl({ anchors: [{ id: "a", kind: "field", name: "성명", occurrence: 1 }], rules: [fillRule("r", "a", { text: "둘째" })] });
  // 규칙이 가리키지 않는 누름틀(첫째 성명, 소속)은 암묵 채움 대상이다: 데이터가 없으므로 keep으로 그대로 둔다
  const out = reparse(done(generate(bytes, t, ds({}), { missing: "keep" })).output);
  assert.deepEqual(listFields(out).map((f) => [f.valueText, f.dirty]), [["이름을 입력", "0"], ["합성기관", "1"], ["둘째", "1"]]);

  const wrong = tpl({ anchors: [{ id: "a", kind: "field", name: "성명 " }], rules: [fillRule("r", "a", { text: "x" })] });
  assert.deepEqual(failed(generate(bytes, wrong, ds({}), { missing: "keep" })), ["ANCHOR_NOT_FOUND"]);
});

test("E2: dirty가 이미 1인 누름틀은 글자모양을 건드리지 않고, 빈 값은 dirty·글자모양을 건드리지 않는다", () => {
  const bytes = readFixture("hancom/field-states");
  // 첫 누름틀을 값이 든 상태(dirty=1)로 바꾼 입력: 안내문 run의 글자모양 7은 그대로 남아야 한다
  const dirty = mutateEntryText(bytes, SEC, (x) => x.replace('dirty="0"', 'dirty="1"'));
  const t = tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }], rules: [fillRule("r", "a", { text: "값" })] });
  const xml = text(done(generate(dirty, t, ds({}), { missing: "keep" })).output);
  assert.ok(xml.includes('<hp:run charPrIDRef="7"><hp:t>값</hp:t></hp:run>'), "dirty=1이던 누름틀의 값 run은 글자모양 7 그대로");
  assert.ok(xml.includes('<hp:run charPrIDRef="0"><hp:t>값</hp:t></hp:run>'), "dirty=0이던 두 번째 성명은 글자모양이 시작 run의 것으로");

  // 빈 값: 글만 비우고 dirty와 글자모양은 그대로(안내문 상태 유지)
  const empty = tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }], rules: [fillRule("r", "a", { text: "" })] });
  const out = done(generate(bytes, empty, ds({}), { missing: "keep" }));
  const xmlEmpty = text(out.output);
  assert.equal(xmlEmpty.match(/<hp:run charPrIDRef="7"><hp:t><\/hp:t><\/hp:run>/g)?.length, 2);
  assert.deepEqual(listFields(reparse(out.output)).map((f) => [f.valueText, f.dirty]), [["", "0"], ["합성기관", "1"], ["", "0"]]);
});

test("E2: 시작과 끝 사이에 글이 없는 누름틀(empty)은 시작 컨트롤 바로 뒤에 hp:t를 넣는다. 빈 값이면 아무것도 하지 않는다", () => {
  const bytes = readFixture("hancom-field");
  const hollow = mutateEntryText(bytes, SEC, (x) => x.replace("<hp:t>홍길동</hp:t>", ""));
  assert.equal(listFields(reparse(hollow))[0]?.shape, "empty");
  const t = tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }], rules: [fillRule("r", "a", { path: "n" })] });
  const r = done(generate(hollow, t, ds({ n: "김&이" })));
  const f = listFields(reparse(r.output))[0];
  assert.deepEqual([f?.valueText, f?.dirty, f?.shape], ["김&이", "1", "simple"]);
  assert.ok(text(r.output).includes("</hp:ctrl><hp:t>김&amp;이</hp:t><hp:ctrl><hp:fieldEnd"));
  // 빈 값: 편집이 없어 입력과 바이트 동일
  const none = done(generate(hollow, t, ds({ n: "" })));
  assert.ok(bytesEqual(none.output, hollow));
});

test("E2: 인라인 요소가 낀 누름틀(inline)은 FIELD_UNSUPPORTED_SHAPE로 거절한다", () => {
  const bytes = mutateEntryText(readFixture("hancom-field"), SEC, (x) => x.replace("<hp:t>홍길동</hp:t>", '<hp:t>홍<hp:tab width="0" leader="0" type="0"/>길동</hp:t>'));
  assert.equal(listFields(reparse(bytes))[0]?.shape, "inline");
  const t = tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }], rules: [fillRule("r", "a", { text: "x" })] });
  assert.deepEqual(failed(generate(bytes, t, ds({}))), ["FIELD_UNSUPPORTED_SHAPE"]);
});

// ── E3 ─────────────────────────────────────────────────────────

test("E3: 한 run 안의 {{}} 치환 — 값 일치, 글 밖은 그대로, {{}}가 남지 않는다(특수문자는 이스케이프)", () => {
  const bytes = readFixture("hancom/ph-single");
  const original = text(bytes);
  const r = done(generate(bytes, emptyTemplate(), ds({ project: { name: "A&B <c> \"d\" 'e'", start: 2026, end: true } })));
  const out = reparse(r.output);
  assert.deepEqual(paragraphTexts(out).slice(1), ["사업명: A&B <c> \"d\" 'e' 입니다.", "기간: 2026 ~ true"]);
  const xml = text(r.output);
  assert.ok(xml.includes("A&amp;B &lt;c&gt; \"d\" 'e'"));
  assert.ok(!xml.includes("{{"));
  assert.equal(skeleton(xml), skeleton(original));
  assertOthersIdentical(bytes, r.output);
  // 줄 배치 캐시를 전부 지웠다
  assert.ok(original.includes("<hp:linesegarray>") && !xml.includes("linesegarray"));
  // 보고서·원장에 값 원문이 없다
  const blob = JSON.stringify([r.report, r.ledger]);
  assert.ok(!blob.includes("2026") && !blob.includes("&B") && !blob.includes("true\""), "값 원문이 보고서에 있다");
  assert.ok(r.report.plan.actions.every((a) => a.value === undefined || (typeof a.value.length === "number" && a.value.sha256.length === 8)));
});

test("E3: 머리말·꼬리말 안의 {{}}도 채운다", () => {
  const bytes = readFixture("hancom/header-footer");
  const out = reparse(done(generate(bytes, emptyTemplate(), ds({ doc: { title: "제목", owner: "소유자" } }))).output);
  assert.deepEqual(paragraphTexts(out).filter((t) => t === "제목" || t === "소유자"), ["제목", "소유자"]);
});

// ── E4 ─────────────────────────────────────────────────────────

const MIXED_DATA = { project: { name: "알파" }, company: { name: "회사" }, manager: { name: "홍", phone: "010-1" } };

test("E4: 한 덩어리는 채우고, 글자모양이 갈린 {{}}는 skipped: FILL_MIXED_FORMAT, 탭을 사이에 둔 두 표기는 각각 채운다", () => {
  const bytes = readFixture("hancom/ph-mixed");
  const r = done(generate(bytes, emptyTemplate(), ds(MIXED_DATA)));
  assert.deepEqual(paragraphTexts(reparse(r.output)), ["￼￼사업명: {{project.name}}", "회사명: 회사", "담당: 홍\t010-1"]);
  assert.deepEqual(r.report.plan.skipped.map((s) => [s.code, s.anchor]), [["FILL_MIXED_FORMAT", "{{project.name}}"]]);
  // 갈린 표기는 원문 그대로다
  assert.ok(text(r.output).includes("<hp:t>사업명: {{project.</hp:t></hp:run><hp:run charPrIDRef=\"7\"><hp:t>name}}</hp:t>"));
  assert.ok(r.report.issues.every((i) => i.severity !== "error"));
});

test("E4: mixedFormat \"first\"면 첫 run에 넣고 나머지는 지운다(run과 hp:t 요소는 그대로)", () => {
  const bytes = readFixture("hancom/ph-mixed");
  const r = done(generate(bytes, emptyTemplate(), ds(MIXED_DATA), { mixedFormat: "first" }));
  assert.deepEqual(paragraphTexts(reparse(r.output))[0], "￼￼사업명: 알파");
  const xml = text(r.output);
  assert.ok(xml.includes('<hp:run charPrIDRef="0"><hp:t>사업명: 알파</hp:t></hp:run><hp:run charPrIDRef="7"><hp:t></hp:t></hp:run>'));
  assert.equal(r.report.plan.skipped.length, 0);
  // 템플릿 옵션으로도 같다
  const t = tpl({ options: { mixedFormat: "first" } });
  assert.deepEqual(paragraphTexts(reparse(done(generate(bytes, t, ds(MIXED_DATA))).output))[0], "￼￼사업명: 알파");
});

test("E4: 같은 글자모양의 연속 조각은 run이 갈려 있어도 한 덩어리로 보고 치환한다", () => {
  const bytes = mutateEntryText(readFixture("hancom/ph-mixed"), SEC, (x) => x.replace('<hp:run charPrIDRef="7"><hp:t>name}}', '<hp:run charPrIDRef="0"><hp:t>name}}'));
  const r = done(generate(bytes, emptyTemplate(), ds(MIXED_DATA)));
  assert.equal(r.report.plan.skipped.length, 0);
  assert.equal(paragraphTexts(reparse(r.output))[0], "￼￼사업명: 알파");
  assert.equal(text(r.output).match(/<hp:run /g)?.length, text(bytes).match(/<hp:run /g)?.length, "run 요소를 지우지 않았다");
});

test("E4: 글 사이에 탭이 낀 표기는 치환하지 않고 FILL_CROSSES_MARKUP으로 보고한다", () => {
  const bytes = mutateEntryText(readFixture("hancom/ph-mixed"), SEC, (x) => x.replace("{{manager.name}}<hp:tab", "{{manager.name<hp:tab").replace('type="0"/>{{manager.phone}}', 'type="0"/>}}'));
  const r = done(generate(bytes, emptyTemplate(), ds(MIXED_DATA), { mixedFormat: "first" }));
  assert.deepEqual(r.report.plan.skipped.map((s) => s.code), ["FILL_CROSSES_MARKUP"]);
  assert.equal(paragraphTexts(reparse(r.output))[2], "담당: {{manager.name\t}}");
});

// 구간 경계가 글자 묶음(grapheme cluster) 한가운데면 치환하지 않고 FILL_SPLITS_CLUSTER로 건너뛴다(FILL_CROSSES_MARKUP이 아니다)
const clusterDoc = (inner: string): Uint8Array =>
  buildHwpx([`<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${inner}</hp:t></hp:run></hp:p>`]);
const JAMO = "\u{1140}\u{1161}\u{11AB}"; // 옛한글 초성+중성+종성: 묶음 하나(논리 텍스트에서 2·3·4번 글자)

test("E4: word 앵커의 경계가 글자 묶음 한가운데면 skipped: FILL_SPLITS_CLUSTER, 묶음 전체를 감싸거나 비껴가면 치환한다", () => {
  const logical = `AB${JAMO}CD`;
  // 건너뛰기만 하면 채운 자리가 없어 FILL_NOTHING_APPLIED로 실패하므로, 둘째 문단을 채우는 규칙을 하나 더 둔다
  const para = (id: string, inner: string): string => `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${inner}</hp:t></hp:run></hp:p>`;
  const bytes = buildHwpx([para("1", logical) + para("2", "기타")]);
  const other = { anchors: [lineAnchor("o", [1], "기타")], rules: [fillRule("ro", "o", { text: "기타 채움" })] };
  const run = (target: string, value = "X") => {
    const t = tpl({ anchors: [wordAnchor("w", [0], logical, target), ...other.anchors], rules: [fillRule("r", "w", { text: value }), ...other.rules] });
    return done(generate(bytes, t, ds({})));
  };
  // 시작이 묶음 가운데, 끝이 묶음 가운데
  for (const target of ["\u{1161}\u{11AB}C", "B\u{1140}\u{1161}", "\u{11AB}", "\u{1140}\u{1161}"]) {
    const r = run(target);
    assert.deepEqual(r.report.plan.skipped.map((s) => [s.ruleId, s.code]), [["r", "FILL_SPLITS_CLUSTER"]], JSON.stringify(target));
    assert.equal(paragraphTexts(reparse(r.output))[0], logical, "건너뛴 자리는 원문 그대로");
  }
  // 묶음 전체, 묶음을 통째로 감싸는 구간, 묶음 앞뒤는 치환한다
  assert.deepEqual(paragraphTexts(reparse(run(JAMO).output))[0], "ABXCD");
  assert.deepEqual(paragraphTexts(reparse(run(`B${JAMO}C`).output))[0], "AXD");
  assert.deepEqual(paragraphTexts(reparse(run("AB").output))[0], `X${JAMO}CD`);
  assert.equal(run(JAMO).report.plan.skipped.length, 0);
  // mixedFormat "first"는 글자모양이 갈린 구간을 허용할 뿐 글자 묶음을 가르는 것까지 허용하지 않는다
  const t = tpl({ anchors: [wordAnchor("w", [0], logical, "\u{1161}\u{11AB}C"), ...other.anchors], rules: [fillRule("r", "w", { text: "X" }), ...other.rules] });
  assert.deepEqual(done(generate(bytes, t, ds({}), { mixedFormat: "first" })).report.plan.skipped.map((s) => s.code), ["FILL_SPLITS_CLUSTER"]);
});

test("E4: {{}} 표기 바로 뒤에 결합 부호가 붙어 끝 경계가 묶음 가운데면 FILL_SPLITS_CLUSTER로 건너뛴다", () => {
  const bytes = clusterDoc("가 {{x}}\u{301} 나 {{y}}");
  const r = done(generate(bytes, emptyTemplate(), ds({ x: "값", y: "와이" })));
  assert.deepEqual(r.report.plan.skipped.map((s) => [s.code, s.anchor]), [["FILL_SPLITS_CLUSTER", "{{x}}"]]);
  assert.equal(paragraphTexts(reparse(r.output))[0], "가 {{x}}\u{301} 나 와이");
});

// ── E5 ─────────────────────────────────────────────────────────

test("E5: 셀 앵커로 빈 칸(자기닫힘 run)을 채운다 — 값 일치, 셀 서식 불변", () => {
  const bytes = readFixture("hancom/ph-table");
  const original = text(bytes);
  assert.ok(original.includes('<hp:run charPrIDRef="0"/>'));
  const t = tpl({
    anchors: [{ id: "c", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 1 }],
    rules: [fillRule("r", "c", { path: "contact" })],
  });
  const r = done(generate(bytes, t, ds({ contact: "010-1234-5678", applicant: { name: "홍" }, note: "비" })));
  const xml = text(r.output);
  assert.ok(xml.includes('<hp:run charPrIDRef="0"><hp:t>010-1234-5678</hp:t></hp:run>'));
  assert.ok(!xml.includes('<hp:run charPrIDRef="0"/>'));
  // 셀 서식 불변: 값 run을 자기닫힘으로 되돌리고 뼈대를 견주면 `{{}}` 칸의 글만 다르다
  const restored = xml.replace('<hp:run charPrIDRef="0"><hp:t>010-1234-5678</hp:t></hp:run>', '<hp:run charPrIDRef="0"/>');
  assert.equal(skeleton(restored).replace(/<hp:run charPrIDRef=""\/>/g, "<R/>"), skeleton(original).replace(/<hp:run charPrIDRef=""\/>/g, "<R/>"));
  const tcs = (x: string): string[] => [...x.matchAll(/<hp:tc [^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(tcs(xml), tcs(original));
  const table = reparse(r.output).sections[0]?.paragraphs[1]?.objects[0];
  assert.ok(table !== undefined && isTableNode(table));
  assert.deepEqual(table.cells.map((c) => c.subList?.paragraphs[0]?.logicalText), ["성명", "홍", "연락처", "010-1234-5678", "비고", "비"]);
});

test("E5: 글이 든 셀도 채우고, 셀 안 문단이 여럿이면 첫 문단만 채우고 나머지 문단의 글은 비운다", () => {
  const bytes = readFixture("extra/features-picture");
  // 세 번째 최상위 표의 (0,0) 셀에는 문단이 둘 있다(r0c0, r0c1)
  const t = tpl({
    anchors: [{ id: "c", kind: "cell", table: { sectionIndex: 0, ordinal: 2 }, row: 0, col: 0 }],
    rules: [fillRule("r", "c", { text: "병합 셀" })],
  });
  const r = done(generate(bytes, t, ds({}), { missing: "keep" })); // 문서의 이름 있는 누름틀은 암묵 채움 대상이라 데이터가 없으면 그대로 둔다
  const out = reparse(r.output);
  const cell = out.sections[0]?.paragraphs.flatMap((p) => p.objects).filter((o) => o.type === "tbl")[2];
  assert.ok(cell !== undefined && isTableNode(cell));
  assert.deepEqual(cell.cells[0]?.subList?.paragraphs.map((p) => p.logicalText), ["병합 셀", ""]);
  assert.equal(cell.cells[0]?.subList?.paragraphs.length, 2, "문단은 지우지 않는다");
  // 원래 있던 오류(문단 id 중복)는 기준선이라 막지 않고 경고로 보고한다
  assert.ok(r.report.issues.some((i) => i.severity === "warning" && i.code === "INST_DUP_ID"));
});

test("셀·줄 채움: 객체가 든 문단·셀은 FILL_HAS_OBJECT, 구역 설정만 든 문단은 채울 수 있다", () => {
  const blocks = readFixture("hancom/blocks");
  const tableCell = tpl({ anchors: [{ id: "c", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 0, col: 0 }], rules: [fillRule("r", "c", { text: "x" })] });
  // 셀에는 객체가 없어 채워진다
  done(generate(blocks, tableCell, ds({})));
  const holder = tpl({ anchors: [lineAnchor("l", [4], "￼")], rules: [fillRule("r", "l", { text: "x" })] });
  assert.deepEqual(failed(generate(blocks, holder, ds({}))), ["FILL_HAS_OBJECT"]);
  // 누름틀 컨트롤이 든 문단
  const fields = readFixture("hancom/field-states");
  const withField = tpl({ anchors: [lineAnchor("l", [1], "소속: ￼합성기관￼")], rules: [fillRule("r", "l", { text: "x" })] });
  assert.deepEqual(failed(generate(fields, withField, ds({}), { missing: "keep" })), ["FILL_HAS_OBJECT"]);
  // 구역 설정(secPr)·단 설정(colPr)만 든 첫 문단은 글을 바꿀 수 있다
  const first = tpl({ anchors: [lineAnchor("l", [0], "￼￼1. 개요")], rules: [fillRule("r", "l", { text: "새 제목" })] });
  assert.equal(paragraphTexts(reparse(done(generate(blocks, first, ds({}))).output))[0], "￼￼새 제목");
});

test("줄 채움: 첫 글 조각에 값을 넣고 나머지 글 조각을 비운다(탭 같은 인라인은 남는다). 빈 문단은 hp:t를 만들어 넣는다", () => {
  const mixed = readFixture("hancom/ph-mixed");
  const t = tpl({ anchors: [lineAnchor("l", [2], "담당: {{manager.name}}\t{{manager.phone}}")], rules: [fillRule("r", "l", { text: "새 글" })] });
  const r = done(generate(mixed, t, ds({}), { missing: "keep" }));
  assert.equal(paragraphTexts(reparse(r.output))[2], "새 글\t");

  // 빈 문단: run 안에 hp:t가 없다
  const empty = buildHwpx(['<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="1"/></hp:p>']);
  const te = tpl({ anchors: [lineAnchor("l", [0], "")], rules: [fillRule("r", "l", { text: "채움" })] });
  const out = done(generate(empty, te, ds({})));
  assert.ok(text(out.output).includes('<hp:run charPrIDRef="1"><hp:t>채움</hp:t></hp:run>'));
  // hp:t만 있는 빈 문단
  const hollow = buildHwpx(['<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>']);
  assert.ok(text(done(generate(hollow, te, ds({}))).output).includes('<hp:run charPrIDRef="0"><hp:t>채움</hp:t></hp:run>'));
});

// ── 앵커 해석 ──────────────────────────────────────────────────

test("앵커: word 앵커 — 주소와 지문이 맞으면 그 자리, 앵커 범위만 바꾼다", () => {
  const bytes = readFixture("hancom/blocks");
  const t = tpl({ anchors: [wordAnchor("w", [1], "개요 본문입니다.", "본문")], rules: [fillRule("r", "w", { text: "내용" })] });
  const r = done(generate(bytes, t, ds({})));
  assert.equal(paragraphTexts(reparse(r.output))[1], "개요 내용입니다.");
  assert.equal(r.report.plan.relocated.length, 0);
});

test("앵커: 주소의 글이 지문과 다르면 같은 구역에서 지문으로 다시 찾고(ANCHOR_RELOCATED 경고), 여럿이면 ANCHOR_AMBIGUOUS, 없으면 ANCHOR_NOT_FOUND", () => {
  const bytes = readFixture("hancom/blocks");
  // 주소가 틀린 word 앵커: 지문(앞뒤 글 포함)은 [1]에만 맞는다("본문"은 [3]에도 있지만 앞뒤가 다르다)
  const moved = tpl({ anchors: [{ ...wordAnchor("w", [1], "개요 본문입니다.", "본문"), at: { sectionIndex: 0, path: [2] } }], rules: [fillRule("r", "w", { text: "내용" })] });
  const r = done(generate(bytes, moved, ds({})));
  assert.deepEqual(r.report.issues.map((i) => i.code), ["ANCHOR_RELOCATED"]);
  assert.equal(r.report.plan.relocated.length, 1);
  assert.equal(paragraphTexts(reparse(r.output))[1], "개요 내용입니다.");

  // 줄 앵커의 재배치
  const lineMoved = tpl({ anchors: [{ ...lineAnchor("l", [0], "3. 끝"), at: { sectionIndex: 0, path: [0] } }], rules: [fillRule("r", "l", { text: "끝맺음" })] });
  const r2 = done(generate(bytes, lineMoved, ds({})));
  assert.deepEqual(r2.report.issues.map((i) => i.code), ["ANCHOR_RELOCATED"]);
  assert.equal(paragraphTexts(reparse(r2.output)).at(-1), "끝맺음");

  // 같은 문단이 둘: 모호
  const dup = buildHwpx([["반복 문장", "다른 문장", "반복 문장"].map((s) => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${s}</hp:t></hp:run></hp:p>`).join("")]);
  const ambiguous = tpl({ anchors: [{ ...lineAnchor("l", [1], "반복 문장") }], rules: [fillRule("r", "l", { text: "x" })] });
  assert.deepEqual(failed(generate(dup, ambiguous, ds({}))), ["ANCHOR_AMBIGUOUS"]);

  // 없음
  const gone = tpl({ anchors: [lineAnchor("l", [1], "없는 문단")], rules: [fillRule("r", "l", { text: "x" })] });
  assert.deepEqual(failed(generate(bytes, gone, ds({}))), ["ANCHOR_NOT_FOUND"]);
  const wordGone = tpl({ anchors: [wordAnchor("w", [1], "없는 글 요소", "글")], rules: [fillRule("r", "w", { text: "x" })] });
  assert.deepEqual(failed(generate(bytes, wordGone, ds({}))), ["ANCHOR_NOT_FOUND"]);
});

test("앵커: cell·object는 서수로 찾고 범위 밖이면 ANCHOR_NOT_FOUND. 조건이 거짓인 규칙의 앵커는 찾지 않는다", () => {
  const bytes = readFixture("hancom/blocks");
  for (const anchor of [
    { id: "a", kind: "cell", table: { sectionIndex: 0, ordinal: 1 }, row: 0, col: 0 },
    { id: "a", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 3, col: 0 },
    { id: "a", kind: "cell", table: { sectionIndex: 5, ordinal: 0 }, row: 0, col: 0 },
  ]) {
    assert.deepEqual(failed(generate(bytes, tpl({ anchors: [anchor], rules: [fillRule("r", "a", { text: "x" })] }), ds({}))), ["ANCHOR_NOT_FOUND"]);
  }
  const object = { id: "o", kind: "object", objectType: "pic", sectionIndex: 0, ordinal: 0 };
  const del = { id: "d", do: { type: "delete", anchor: "o" } };
  assert.deepEqual(failed(generate(bytes, tpl({ anchors: [object], rules: [del] }), ds({}))), ["ANCHOR_NOT_FOUND"]);
  // 조건이 거짓이면 앵커를 찾지 않으므로 ANCHOR_NOT_FOUND가 아니다(적용된 것이 없어 FILL_NOTHING_APPLIED로 끝난다)
  const guarded = tpl({ anchors: [object], rules: [{ ...del, when: { path: "x", op: "eq", value: 1 } }] });
  const idle = generate(bytes, guarded, ds({ x: 2 }));
  assert.deepEqual(failed(idle), ["FILL_NOTHING_APPLIED"]);
  assert.deepEqual(idle.report.plan.inactiveRules, ["d"]);

  const doc = loadDoc("hancom/blocks");
  const found = resolveAnchors(doc, tpl({ anchors: [{ id: "c", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 2, col: 1 }] }));
  assert.deepEqual([...found.anchors.keys()], ["c"]);
  assert.equal(found.anchors.get("c")?.kind, "cell");
});

test("충돌: 같은 자리에 값이 다른 채움이 둘이면 TPL_CONFLICT, 같은 값이면 하나로 합친다", () => {
  const bytes = readFixture("hancom/blocks");
  const anchors = [wordAnchor("w", [1], "개요 본문입니다.", "본문"), lineAnchor("l", [1], "개요 본문입니다.")];
  const conflict = tpl({ anchors, rules: [fillRule("r1", "w", { text: "가" }), fillRule("r2", "w", { text: "나" })] });
  assert.deepEqual(failed(generate(bytes, conflict, ds({}))), ["TPL_CONFLICT"]);
  const same = tpl({ anchors, rules: [fillRule("r1", "w", { text: "가" }), fillRule("r2", "w", { text: "가" })] });
  assert.equal(paragraphTexts(reparse(done(generate(bytes, same, ds({}))).output))[1], "개요 가입니다.");
  // 줄 채움과 그 안의 글 범위 채움도 겹친다
  const overlap = tpl({ anchors, rules: [fillRule("r1", "w", { text: "가" }), fillRule("r2", "l", { text: "나" })] });
  assert.deepEqual(failed(generate(bytes, overlap, ds({}))), ["TPL_CONFLICT"]);
});

test("같은 글로 바꾸는 채움은 편집이 아니다 — 바이트가 그대로이고 줄 배치 캐시도 지우지 않는다", () => {
  const bytes = readFixture("hancom/blocks");
  const t = tpl({ anchors: [lineAnchor("l", [1], "개요 본문입니다.")], rules: [fillRule("r", "l", { text: "개요 본문입니다." })] });
  const r = done(generate(bytes, t, ds({})));
  assert.ok(bytesEqual(r.output, bytes));
  assert.equal(r.ledger.counts.edits, 0);
  // 누름틀도 같은 값이고 이미 dirty=1이면 편집이 없다
  const fields = readFixture("hancom/field-states");
  const same = tpl({ anchors: [{ id: "a", kind: "field", name: "소속" }], rules: [fillRule("r", "a", { text: "합성기관" })] });
  assert.ok(bytesEqual(done(generate(fields, same, ds({}), { missing: "keep" })).output, fields));
});
