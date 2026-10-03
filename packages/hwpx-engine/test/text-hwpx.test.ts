// T6: 같은 템플릿 규칙(조건 → 액션)과 같은 데이터 묶음을 hwpx와 md 양쪽에 써서 같은 값이 들어간다(명세 9절).
// 앵커만 형식별로 다시 잡는다. 규칙(`rules`)과 데이터(`dataset`)는 양쪽에 같은 객체를 넘긴다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isTableNode, listFields, type HwpxDocument } from "../src/index.ts";
import { generate, type GenerateResult } from "../src/fill/index.ts";
import { readDataset, readTemplate, type Dataset, type MissingPolicy, type Template } from "../src/template/index.ts";
import { generateText, parseText, type TextResult } from "../src/text/index.ts";
import { readFixture, reparse } from "./helpers.ts";

// ── 도구 ────────────────────────────────────────────────────────

const mdFixture = (name: string): string => readFileSync(new URL(`./fixtures/text/${name}`, import.meta.url), "utf8");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

const tpl = (spec: { anchors?: unknown[]; rules?: unknown[]; options?: unknown }): Template =>
  readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });

const lineAnchor = (id: string, ordinal: number, logical: string) => ({
  id,
  kind: "line",
  at: { sectionIndex: 0, path: [ordinal] },
  print: { text: logical.slice(0, 40), sha256: sha(logical) },
});
const cellAnchor = (id: string, row: number, col: number) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row, col });
const fieldAnchor = (id: string, name: string, occurrence: number) => ({ id, kind: "field", name, occurrence });

/** 양쪽 형식에 같은 규칙·같은 데이터로 돌린 결과 */
type Both = {
  hwpx: Extract<GenerateResult, { ok: true; dryRun: false }>;
  md: Extract<TextResult, { ok: true; dryRun: false }>;
};

/**
 * 같은 `rules`와 `options`로 앵커만 형식별로 다른 템플릿 둘을 만들어, 같은 데이터 묶음을 hwpx 문서와 md 문서에 쓴다.
 * 둘 다 성공해야 한다. 규칙 JSON이 같음을 여기서 확인한다.
 */
function runBoth(
  hwpxFixture: string,
  mdText: string,
  anchors: { hwpx: unknown[]; md: unknown[] },
  rules: unknown[],
  dataset: Dataset,
  options: { missing?: MissingPolicy; template?: unknown } = {},
): Both {
  const forHwpx = tpl({ anchors: anchors.hwpx, rules, ...(options.template === undefined ? {} : { options: options.template }) });
  const forMd = tpl({ anchors: anchors.md, rules, ...(options.template === undefined ? {} : { options: options.template }) });
  assert.deepEqual(forHwpx.rules, forMd.rules, "규칙은 양쪽에 같다");
  assert.deepEqual(forHwpx.options, forMd.options);
  const callOptions: { missing?: MissingPolicy } = options.missing === undefined ? {} : { missing: options.missing };
  const h = generate(readFixture(hwpxFixture), forHwpx, dataset, callOptions);
  assert.ok(h.ok && !h.dryRun, `hwpx 생성 실패: ${JSON.stringify(h.report.issues)}`);
  const m = generateText(mdText, "md", forMd, dataset, callOptions);
  assert.ok(m.ok && !m.dryRun, `md 생성 실패: ${JSON.stringify(m.report.issues)}`);
  return { hwpx: h, md: m };
}

/** hwpx 본문 문단의 글: 컨트롤 표시(￼)를 떼고 빈 것(표만 든 문단)은 뺀다 */
const hwpxTexts = (bytes: Uint8Array): string[] =>
  (reparse(bytes).sections[0]?.paragraphs ?? []).map((p) => p.logicalText.replace(/￼/g, "")).filter((t) => t !== "");

/** hwpx 첫 표의 칸 글(문서 순서) */
function hwpxCells(bytes: Uint8Array): string[] {
  const doc: HwpxDocument = reparse(bytes);
  for (const p of doc.sections[0]?.paragraphs ?? []) {
    for (const o of p.objects) if (isTableNode(o)) return o.cells.map((c) => c.subList?.paragraphs[0]?.logicalText ?? "");
  }
  return [];
}

/** md 문서의 표가 아닌 블록 글(제목 표시 `#`는 뗀다) */
const mdTexts = (text: string): string[] =>
  parseText(text, "md")
    .blocks.filter((b) => b.kind !== "table")
    .map((b) => b.text.replace(/^#+ /, ""));

/** md 첫 표의 칸 글(머리행 포함, `\|`는 `|`로 되돌린다) */
function mdCells(text: string): string[] {
  const table = parseText(text, "md").blocks.find((b) => b.kind === "table");
  return (table?.table?.rows ?? []).flatMap((r) => r.cells.map((c) => text.slice(c.contentStart, c.contentEnd).replace(/\\\|/g, "|")));
}

const hwpxLogical = (fixture: string, ordinal: number): string => reparse(readFixture(fixture)).sections[0]?.paragraphs[ordinal]?.logicalText ?? "";
const mdLogical = (text: string, ordinal: number): string => parseText(text, "md").blocks[ordinal]?.text ?? "";

const SINGLE_MD = mdFixture("single.md");
const SINGLE_DATA = readDataset({ project: { name: "알파", start: "2026-01-01", end: "2026-12-31" } });
const sameActions = (a: Both): void => assert.deepEqual(a.hwpx.report.plan.actions, a.md.report.plan.actions);

// ── T6: 템플릿 없이 문서 안 {{}} ─────────────────────────────────

test("T6: ph-single.hwpx와 같은 글의 md — 문서 안 {{}}에 같은 값이 들어가고 보고서의 채움 내역도 같다", () => {
  const both = runBoth("hancom/ph-single", SINGLE_MD, { hwpx: [], md: [] }, [], SINGLE_DATA);
  assert.deepEqual(hwpxTexts(both.hwpx.output), ["합성 시험 문서 (단일 서식)", "사업명: 알파 입니다.", "기간: 2026-01-01 ~ 2026-12-31"]);
  assert.deepEqual(mdTexts(both.md.output), hwpxTexts(both.hwpx.output));
  sameActions(both);
  assert.deepEqual(both.hwpx.report.plan.requiredPaths, both.md.report.plan.requiredPaths);
  assert.deepEqual(both.hwpx.report.plan.missingPaths, both.md.report.plan.missingPaths);
});

test("T6: 누락 정책 error·empty·keep이 양쪽에서 같다(실패 코드, 채운 글, 남긴 자리 보고)", () => {
  const partial = readDataset({ project: { name: "알파", start: "2026-01-01" } });
  const forHwpx = tpl({});
  // error: 양쪽 모두 DATA_MISSING으로 중단하고 출력이 없다
  const h = generate(readFixture("hancom/ph-single"), forHwpx, partial);
  const m = generateText(SINGLE_MD, "md", forHwpx, partial);
  assert.ok(!h.ok && !m.ok);
  assert.ok(!("output" in h) && !("output" in m));
  const codes = (issues: { severity: string; code: string }[]): string[] => issues.filter((i) => i.severity === "error").map((i) => i.code);
  assert.deepEqual(codes(h.report.issues), codes(m.report.issues));
  assert.deepEqual(h.report.plan.missingPaths, m.report.plan.missingPaths);
  assert.deepEqual(m.report.plan.missingPaths, ["project.end"]);

  for (const missing of ["empty", "keep"] as const) {
    const both = runBoth("hancom/ph-single", SINGLE_MD, { hwpx: [], md: [] }, [], partial, { missing });
    assert.deepEqual(mdTexts(both.md.output), hwpxTexts(both.hwpx.output), missing);
    assert.deepEqual(both.hwpx.report.plan.kept, both.md.report.plan.kept, missing);
    assert.deepEqual(both.hwpx.report.plan.missingPaths, both.md.report.plan.missingPaths, missing);
  }
  const keep = runBoth("hancom/ph-single", SINGLE_MD, { hwpx: [], md: [] }, [], partial, { missing: "keep" });
  assert.equal(mdTexts(keep.md.output)[2], "기간: 2026-01-01 ~ {{project.end}}");
  const empty = runBoth("hancom/ph-single", SINGLE_MD, { hwpx: [], md: [] }, [], partial, { missing: "empty" });
  assert.equal(mdTexts(empty.md.output)[2], "기간: 2026-01-01 ~ ");
  // 정책을 템플릿 options.missing으로 정해도 양쪽이 같다
  const viaTemplate = runBoth("hancom/ph-single", SINGLE_MD, { hwpx: [], md: [] }, [], partial, { template: { missing: "empty" } });
  assert.deepEqual(mdTexts(viaTemplate.md.output), hwpxTexts(viaTemplate.hwpx.output));
});

test("T6: 값 변환 오류도 양쪽에서 같다(객체 값 DATA_NOT_SCALAR, 제어 문자 VALUE_CONTROL_CHAR). 줄바꿈·탭은 HWPX만 받는다(md·txt는 거절)", () => {
  for (const [value, code] of [[{ a: 1 }, "DATA_NOT_SCALAR"], ["제어\u0001", "VALUE_CONTROL_CHAR"]] as const) {
    const data = readDataset({ project: { name: "알파", start: "2026-01-01", end: value } });
    const h = generate(readFixture("hancom/ph-single"), tpl({}), data);
    const m = generateText(SINGLE_MD, "md", tpl({}), data);
    assert.ok(!h.ok && !m.ok);
    assert.deepEqual(h.report.issues.map((i) => i.code), [code]);
    assert.deepEqual(m.report.issues.map((i) => i.code), [code]);
  }
});

// ── T6: 조건에 따라 줄 지우기 ────────────────────────────────────

test("T6: 같은 규칙으로 '값이 없을 때만 줄을 지운다' — 앵커만 형식별로 다르고, 지워진 줄의 {{}}는 양쪽에서 누락 오류가 아니다", () => {
  const anchors = {
    hwpx: [lineAnchor("a-period", 2, hwpxLogical("hancom/ph-single", 2))],
    md: [lineAnchor("a-period", 2, mdLogical(SINGLE_MD, 2))],
  };
  const rules = [{ id: "r-del", when: { path: "project.end", op: "empty" }, do: { type: "delete", anchor: "a-period" } }];

  // 종료일이 있으면 규칙이 거짓: 지우지 않고 채운다
  const present = runBoth("hancom/ph-single", SINGLE_MD, anchors, rules, SINGLE_DATA);
  assert.deepEqual(hwpxTexts(present.hwpx.output).slice(1), ["사업명: 알파 입니다.", "기간: 2026-01-01 ~ 2026-12-31"]);
  assert.deepEqual(mdTexts(present.md.output), hwpxTexts(present.hwpx.output));
  assert.deepEqual(present.hwpx.report.plan.inactiveRules, ["r-del"]);
  assert.deepEqual(present.md.report.plan.inactiveRules, ["r-del"]);
  sameActions(present);

  // 종료일이 없으면 규칙이 참: 그 줄이 없어지고, 줄 안의 {{project.start}}·{{project.end}}는 버려진다
  const absent = readDataset({ project: { name: "알파", start: "2026-01-01" } });
  const gone = runBoth("hancom/ph-single", SINGLE_MD, anchors, rules, absent);
  assert.deepEqual(hwpxTexts(gone.hwpx.output).slice(1), ["사업명: 알파 입니다."]);
  assert.deepEqual(mdTexts(gone.md.output), hwpxTexts(gone.hwpx.output));
  assert.deepEqual(gone.hwpx.report.plan.inactiveRules, []);
  assert.deepEqual(gone.md.report.plan.inactiveRules, []);
  const pairs = (b: Both): string[] => [b.hwpx, b.md].map((x) => x.report.plan.dropped.map((d) => `${d.ruleId}|${d.anchor}`)).flat().sort();
  assert.deepEqual(pairs(gone), ["implicit|{{project.end}}", "implicit|{{project.end}}", "implicit|{{project.start}}", "implicit|{{project.start}}"]);
  sameActions(gone);
  assert.deepEqual(gone.hwpx.report.plan.expected, { paragraphs: -1 });
  assert.deepEqual(gone.md.report.plan.expected, { blocks: -1 });
});

// ── T6: 누름틀과 {{이름}} ────────────────────────────────────────

test("T6: field 앵커 — hwpx 누름틀과 md {{성명}}에 같은 규칙·같은 앵커 객체로 같은 값이 들어간다", () => {
  const fields = [fieldAnchor("n0", "성명", 0), fieldAnchor("n1", "성명", 1)];
  const rules = [
    { id: "r0", do: { type: "fill", anchor: "n0", value: { path: "applicant.name" } } },
    { id: "r1", do: { type: "fill", anchor: "n1", value: { path: "checker.name" } } },
  ];
  const data = readDataset({ applicant: { name: "김철수" }, checker: { name: "이영희" } });
  const mdText = mdFixture("field-states.md");
  // 규칙이 가리키지 않는 소속 누름틀은 hwpx가 이름을 경로로 암묵 채움하므로 누락 정책 keep으로 그대로 둔다(md는 그대로)
  const both = runBoth("hancom/field-states", mdText, { hwpx: fields, md: fields }, rules, data, { missing: "keep" });

  const hwpxValues = listFields(reparse(both.hwpx.output)).map((f) => f.valueText);
  assert.deepEqual(hwpxValues, ["김철수", "합성기관", "이영희"]);
  const mdValues = mdTexts(both.md.output).map((t) => t.slice(t.indexOf(": ") + 2));
  assert.deepEqual(mdValues, hwpxValues);
  sameActions(both);

  // 값이 없으면 양쪽 모두 같은 정책(empty)으로 빈 글
  // (소속은 hwpx가 이름을 경로로 암묵 채우므로 같은 값을 데이터에 둔다)
  const partial = readDataset({ applicant: { name: "김철수" }, 소속: "합성기관" });
  const empty = runBoth("hancom/field-states", mdText, { hwpx: fields, md: fields }, rules, partial, { missing: "empty" });
  assert.deepEqual(listFields(reparse(empty.hwpx.output)).map((f) => f.valueText), ["김철수", "합성기관", ""]);
  assert.deepEqual(mdTexts(empty.md.output).map((t) => t.slice(t.indexOf(": ") + 2)), ["김철수", "합성기관", ""]);
  assert.deepEqual(empty.hwpx.report.plan.missingPaths, empty.md.report.plan.missingPaths);

  // 조건이 거짓인 규칙은 양쪽에서 그 자리를 건드리지 않는다
  const guarded = [{ ...rules[0], when: { path: "applicant.name", op: "eq", value: "다른 사람" } }, rules[1]];
  const skipped = runBoth("hancom/field-states", mdText, { hwpx: fields, md: fields }, guarded, readDataset({ applicant: { name: "김철수" }, checker: { name: "이영희" }, 소속: "합성기관" }));
  assert.deepEqual(listFields(reparse(skipped.hwpx.output)).map((f) => f.valueText), ["이름을 입력", "합성기관", "이영희"]);
  assert.equal(mdTexts(skipped.md.output)[0], "성명: {{성명}}");
  assert.deepEqual(skipped.hwpx.report.plan.inactiveRules, ["r0"]);
  assert.deepEqual(skipped.md.report.plan.inactiveRules, ["r0"]);
});

// ── T6: 표 ──────────────────────────────────────────────────────

test("T6: 표 — 같은 규칙으로 선택 조항 삭제·행 삭제·칸 채움(blocks.hwpx / blocks.md). 칸 앵커는 형식과 무관하게 같다", () => {
  const mdText = mdFixture("blocks.md");
  const cells = [cellAnchor("a-rowB", 2, 0), cellAnchor("a-fill", 1, 1)];
  const anchors = {
    hwpx: [lineAnchor("a-head", 2, hwpxLogical("hancom/blocks", 2)), lineAnchor("a-body", 3, hwpxLogical("hancom/blocks", 3)), ...cells],
    md: [lineAnchor("a-head", 2, mdLogical(mdText, 2)), lineAnchor("a-body", 3, mdLogical(mdText, 3)), ...cells],
  };
  const rules = [
    { id: "r1", when: { path: "terms.optional", op: "eq", value: false }, do: { type: "delete", anchor: "a-head" } },
    { id: "r2", when: { path: "terms.optional", op: "eq", value: false }, do: { type: "delete", anchor: "a-body" } },
    { id: "r3", when: { path: "terms.rowB", op: "eq", value: false }, do: { type: "delete", anchor: "a-rowB", scope: "row" } },
    { id: "r4", do: { type: "fill", anchor: "a-fill", value: { path: "table.a" } } },
  ];

  const on = runBoth("hancom/blocks", mdText, anchors, rules, readDataset({ terms: { optional: false, rowB: false }, table: { a: "가나" } }));
  assert.deepEqual(hwpxTexts(on.hwpx.output), ["1. 개요", "개요 본문입니다.", "3. 끝"]);
  assert.deepEqual(mdTexts(on.md.output), ["1. 개요", "개요 본문입니다.", "3. 끝"]);
  assert.deepEqual(hwpxCells(on.hwpx.output), ["구분", "내용", "비고", "A", "가나", "-"]);
  assert.deepEqual(mdCells(on.md.output), hwpxCells(on.hwpx.output));
  assert.deepEqual(on.hwpx.report.plan.inactiveRules, []);
  assert.deepEqual(on.md.report.plan.inactiveRules, []);
  sameActions(on);

  // 조건이 모두 거짓이면 칸 채움만 일어난다
  const off = runBoth("hancom/blocks", mdText, anchors, rules, readDataset({ terms: { optional: true, rowB: true }, table: { a: "가나" } }));
  assert.deepEqual(hwpxCells(off.hwpx.output), ["구분", "내용", "비고", "A", "가나", "-", "B", "나", "-"]);
  assert.deepEqual(mdCells(off.md.output), hwpxCells(off.hwpx.output));
  assert.deepEqual(mdTexts(off.md.output), ["1. 개요", "개요 본문입니다.", "2. 선택 조항", "선택 조항 본문입니다. (해당 시)", "3. 끝"]);
  assert.deepEqual(hwpxTexts(off.hwpx.output), mdTexts(off.md.output));
  assert.deepEqual(off.hwpx.report.plan.inactiveRules, ["r1", "r2", "r3"]);
  assert.deepEqual(off.md.report.plan.inactiveRules, ["r1", "r2", "r3"]);
  sameActions(off);

  // 머리행(행 0) 삭제는 hwpx에서는 되지만 md에서는 거부한다: 형식 차이는 앵커 해석에만 있고, 값 규칙은 같다
  const header = [{ id: "r", do: { type: "delete", anchor: "a-head-row", scope: "row" } }];
  const md = generateText(mdText, "md", tpl({ anchors: [cellAnchor("a-head-row", 0, 0)], rules: header }), readDataset({}));
  assert.ok(!md.ok);
  assert.deepEqual(md.report.issues.map((i) => i.code), ["FILL_TABLE_HEADER"]);
});

test("T6: 표 칸의 빈 칸·{{}} 칸 — ph-table.hwpx와 ph-table.md에 같은 값이 들어간다(값 안의 |는 md에서 \\|로 쓰고 값은 같다)", () => {
  const mdText = mdFixture("ph-table.md");
  const cell = [cellAnchor("a-contact", 1, 1)];
  const rules = [{ id: "r", do: { type: "fill", anchor: "a-contact", value: { path: "contact" } } }];
  const data = readDataset({ applicant: { name: "홍길동" }, note: "비고|메모", contact: "010-1234-5678" });
  const both = runBoth("hancom/ph-table", mdText, { hwpx: cell, md: cell }, rules, data);
  assert.deepEqual(hwpxCells(both.hwpx.output), ["성명", "홍길동", "연락처", "010-1234-5678", "비고", "비고|메모"]);
  assert.deepEqual(mdCells(both.md.output), hwpxCells(both.hwpx.output));
  assert.deepEqual(hwpxTexts(both.hwpx.output).filter((t) => t === "위와 같이 신청합니다."), ["위와 같이 신청합니다."]);
  assert.ok(both.md.output.includes("| 비고 | 비고\\|메모 |"), "md 원문에서는 | 를 \\|로 쓴다");
  assert.ok(both.md.output.includes("| 연락처 | 010-1234-5678 |"));
  sameActions(both);
});

// ── T6: 텍스트 삽입 ─────────────────────────────────────────────

test("T6: insertText — 값의 줄바꿈이 hwpx에서는 문단, md에서는 문단 블록이 되어 같은 글이 들어간다", () => {
  const mdText = mdFixture("blocks.md");
  const anchors = {
    hwpx: [lineAnchor("a-body", 1, hwpxLogical("hancom/blocks", 1))],
    md: [lineAnchor("a-body", 1, mdLogical(mdText, 1))],
  };
  const rules = [{ id: "r", when: { path: "memo", op: "exists" }, do: { type: "insertText", anchor: "a-body", position: "after", value: { path: "memo" }, style: "inherit" } }];
  const data = readDataset({ memo: "첫째\n둘째\n셋째" });
  const both = runBoth("hancom/blocks", mdText, anchors, rules, data);
  const expected = ["1. 개요", "개요 본문입니다.", "첫째", "둘째", "셋째", "2. 선택 조항", "선택 조항 본문입니다. (해당 시)"];
  assert.deepEqual(hwpxTexts(both.hwpx.output).slice(0, 7), expected);
  assert.deepEqual(mdTexts(both.md.output).slice(0, 7), expected);
  assert.deepEqual(both.hwpx.report.plan.actions, both.md.report.plan.actions);
  assert.deepEqual(both.hwpx.report.plan.expected, { paragraphs: 3 });
  assert.deepEqual(both.md.report.plan.expected, { blocks: 3 });

  // 값이 없으면 조건이 거짓이라 양쪽 모두 아무것도 넣지 않는다: md는 그대로 낸다(md·txt 동작 유지). hwpx는 적용된 액션이 없어 FILL_NOTHING_APPLIED로 실패한다
  const forNone = tpl({ anchors: anchors.hwpx, rules });
  const noneHwpx = generate(readFixture("hancom/blocks"), forNone, readDataset({}));
  assert.ok(!noneHwpx.ok && noneHwpx.report.issues.some((i) => i.code === "FILL_NOTHING_APPLIED"));
  assert.deepEqual(noneHwpx.report.plan.inactiveRules, ["r"]);
  const noneMd = generateText(mdText, "md", tpl({ anchors: anchors.md, rules }), readDataset({}));
  assert.ok(noneMd.ok && !noneMd.dryRun);
  assert.deepEqual(mdTexts(noneMd.output).slice(0, 3), ["1. 개요", "개요 본문입니다.", "2. 선택 조항"]);
  assert.deepEqual(noneMd.report.plan.inactiveRules, ["r"]);
});

test("T6: 같은 입력으로 두 번 돌리면 양쪽 출력이 같다. 두 보고서 모두 값 원문을 담지 않는다", () => {
  const secret = "비밀값-T6";
  const data = readDataset({ project: { name: secret, start: "S", end: "E" } });
  const a = runBoth("hancom/ph-single", SINGLE_MD, { hwpx: [], md: [] }, [], data);
  const b = runBoth("hancom/ph-single", SINGLE_MD, { hwpx: [], md: [] }, [], data);
  assert.equal(a.md.output, b.md.output);
  assert.deepEqual(Buffer.from(a.hwpx.output), Buffer.from(b.hwpx.output));
  assert.ok(!JSON.stringify(a.hwpx.report).includes(secret));
  assert.ok(!JSON.stringify(a.md.report).includes(secret));
  assert.ok(mdTexts(a.md.output)[1]?.includes(secret));
});
