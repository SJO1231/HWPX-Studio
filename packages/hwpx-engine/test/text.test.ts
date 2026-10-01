// md·txt 어댑터(명세 9절, S4): 블록 모델, 앵커, 액션, 수용 조건 T1~T5, 줄바꿈·BOM 보존, 출력 검사.
// T6(같은 규칙·데이터 묶음을 hwpx와 md에 쓴다)은 text-hwpx.test.ts에 있다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HwpxError } from "../src/errors.ts";
import { checkTextOutput, generateText, parseText, type TextDoc, type TextFragment, type TextKind, type TextOptions, type TextPlan, type TextResult } from "../src/text/index.ts";
import { emptyTemplate, readDataset, readTemplate, type Template } from "../src/template/index.ts";

// ── 도구 ────────────────────────────────────────────────────────

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/text/${name}`, import.meta.url), "utf8");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const sha8 = (s: string): string => sha(s).slice(0, 8);

const tpl = (spec: { anchors?: unknown[]; rules?: unknown[]; options?: unknown } = {}): Template =>
  readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const ds = (data: unknown) => readDataset(data);
const run = (text: string, kind: TextKind, spec: Parameters<typeof tpl>[0], data: unknown, options?: TextOptions): TextResult =>
  generateText(text, kind, tpl(spec), ds(data), options);

type Done = Extract<TextResult, { ok: true; dryRun: false }>;

function done(r: TextResult): Done {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues)}`);
  assert.ok(!r.dryRun);
  return r as Done;
}

function failed(r: TextResult): string[] {
  assert.equal(r.ok, false, "생성이 성공해 버렸다");
  assert.ok(!("output" in r), "실패인데 출력이 있다");
  return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
}

const out = (text: string, kind: TextKind, spec: Parameters<typeof tpl>[0], data: unknown, options?: TextOptions): string => done(run(text, kind, spec, data, options)).output;

/** 시험이 직접 계산하는 앵커 지문: 논리 글(줄바꿈 `\n`) 앞 40자와 sha256 */
const lineAnchor = (id: string, ordinal: number, logical: string) => ({
  id,
  kind: "line",
  at: { sectionIndex: 0, path: [ordinal] },
  print: { text: logical.slice(0, 40), sha256: sha(logical) },
});
const wordAnchor = (id: string, ordinal: number, logical: string, start: number, end: number) => ({
  id,
  kind: "word",
  at: { sectionIndex: 0, path: [ordinal] },
  start,
  end,
  print: { text: logical.slice(start, end), before: logical.slice(Math.max(0, start - 24), start), after: logical.slice(end, end + 24) },
});
const cellAnchor = (id: string, ordinal: number, row: number, col: number) => ({ id, kind: "cell", table: { sectionIndex: 0, ordinal }, row, col });
const fillRule = (id: string, anchor: string, value: unknown, when?: unknown) => ({ id, ...(when === undefined ? {} : { when }), do: { type: "fill", anchor, value } });
const deleteRule = (id: string, anchor: string, when?: unknown, scope?: "row") => ({
  id,
  ...(when === undefined ? {} : { when }),
  do: { type: "delete", anchor, ...(scope === undefined ? {} : { scope }) },
});
const fragmentOf = (...blocks: string[]): TextFragment => ({ schema: "hwpx-studio/text-fragment@1", blocks });
const injectRule = (id: string, anchor: string, position: string, fragment: unknown, when?: unknown) => ({
  id,
  ...(when === undefined ? {} : { when }),
  do: { type: "inject", anchor, position, fragment },
});
const insertRule = (id: string, anchor: string, position: string, value: unknown, when?: unknown) => ({
  id,
  ...(when === undefined ? {} : { when }),
  do: { type: "insertText", anchor, position, value, style: "inherit" },
});

/**
 * 독립 확인: 보고서가 알려 준 편집 구간(원문 좌표, 바뀐 뒤 길이)만 빼면 출력이 원문과 같다.
 * 구현의 적용 코드를 쓰지 않고, 편집 사이의 원문이 출력에 같은 순서로 그대로 있는지 직접 견준다.
 */
function assertOnlyEditsChanged(original: string, output: string, edits: { start: number; end: number; newLength: number }[]): void {
  let from = 0;
  let at = 0;
  for (const e of edits) {
    assert.ok(e.start >= from && e.end >= e.start, `편집이 겹치지 않고 정렬되어 있다: [${e.start}, ${e.end})`);
    const gap = original.slice(from, e.start);
    assert.equal(output.slice(at, at + gap.length), gap, `원본 [${from}, ${e.start})는 그대로여야 한다`);
    at += gap.length + e.newLength;
    from = e.end;
  }
  assert.equal(output.slice(at), original.slice(from), "마지막 편집 뒤의 원문은 그대로여야 한다");
}

const NOTICE = fixture("notice.md");
const MEMO = fixture("memo.txt");
const NOTICE_DATA = {
  project: { name: "알파", start: "2026-01-01", end: "2026-12-31" },
  owner: { name: "김하늘" },
  applicant: { name: "이서연" },
  table: { a: "가", b: "나" },
  opt: "선택",
};

test("시험 자료: fixtures/text는 LF로 저장되어 있고 BOM이 없다", () => {
  for (const name of ["notice.md", "memo.txt", "single.md", "field-states.md", "blocks.md", "ph-table.md"]) {
    const text = fixture(name);
    assert.ok(!text.includes("\r") && !text.startsWith("\uFEFF") && text.endsWith("\n"), name);
  }
});

// ── 블록 모델 ───────────────────────────────────────────────────

const sliceOf = (doc: TextDoc, i: number): string => {
  const b = doc.blocks[i];
  return b === undefined ? "(없음)" : doc.source.slice(b.start, b.end);
};

test("블록 모델: txt는 줄 하나가 블록이고 빈 줄(공백뿐인 줄 포함)은 blank 블록이다", () => {
  const doc = parseText("메모\n\n둘째 줄\n   \n끝", "txt");
  assert.deepEqual(doc.blocks.map((b) => b.kind), ["paragraph", "blank", "paragraph", "blank", "paragraph"]);
  // 메모[0,2) \n 빈줄[3,3) \n 둘째 줄[4,8) \n 공백[9,12) \n 끝[13,14)
  assert.deepEqual(doc.blocks.map((b) => [b.start, b.end]), [[0, 2], [3, 3], [4, 8], [9, 12], [13, 14]]);
  assert.deepEqual(doc.blocks.map((b) => b.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(doc.lines.map((l) => l.eol), ["\n", "\n", "\n", "\n", ""]);
});

test("블록 모델: txt의 끝 줄바꿈 뒤에는 빈 블록이 생기지 않고, 빈 글은 블록이 없다", () => {
  assert.equal(parseText("a\nb\n", "txt").blocks.length, 2);
  assert.equal(parseText("a\nb", "txt").blocks.length, 2);
  assert.equal(parseText("a\n\n", "txt").blocks.length, 2);
  assert.equal(parseText("", "txt").blocks.length, 0);
  assert.equal(parseText("", "md").blocks.length, 0);
  assert.equal(parseText("\n\n", "md").blocks.length, 0);
});

const MD = "# 제목\n\n문단 첫 줄\n문단 둘째 줄\n\n```js\n코드\n\n코드 둘\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n끝";

test("블록 모델: md는 빈 줄로 나뉜 덩어리가 블록이고, 울타리 코드 블록(안의 빈 줄 포함)과 파이프 표는 한 블록이다", () => {
  const doc = parseText(MD, "md");
  assert.deepEqual(doc.blocks.map((b) => b.kind), ["heading", "paragraph", "code", "table", "paragraph"]);
  assert.deepEqual(
    doc.blocks.map((b, i) => sliceOf(doc, i)),
    ["# 제목", "문단 첫 줄\n문단 둘째 줄", "```js\n코드\n\n코드 둘\n```", "| a | b |\n|---|---|\n| 1 | 2 |", "끝"],
  );
  assert.equal(doc.blocks[1]?.text, "문단 첫 줄\n문단 둘째 줄");
  assert.deepEqual(doc.issues, []);
});

test("블록 모델: 블록 사이의 줄바꿈과 빈 줄은 블록 밖 원문으로 그대로 남는다(앞 BOM 포함)", () => {
  for (const src of [MD, `\uFEFF${MD}\n\n\n`, MD.replace(/\n/g, "\r\n"), "\n\n  \n본문\n\t\n\n둘째\n"]) {
    const doc = parseText(src, "md");
    // 블록 구간과 그 사이 틈으로 원문 전체를 다시 이을 수 있고, 틈에는 줄바꿈·공백뿐이다
    let pos = 0;
    let rebuilt = "";
    for (const b of doc.blocks) {
      const gap = src.slice(pos, b.start);
      assert.match(gap, /^(\uFEFF)?[ \t\r\n]*$/);
      rebuilt += gap + src.slice(b.start, b.end);
      pos = b.end;
    }
    assert.match(src.slice(pos), /^[ \t\r\n]*$/);
    assert.equal(rebuilt + src.slice(pos), src);
  }
  const bom = parseText("\uFEFF# 제목\n\n끝", "md");
  assert.equal(bom.bomLength, 1);
  assert.equal(bom.blocks[0]?.start, 1);
  assert.equal(parseText("# 제목", "md").bomLength, 0);
});

test("블록 모델: 울타리는 같은 글자로 같은 길이 이상이어야 닫히고, 열린 채 끝나면 문서 끝까지 한 블록이며 경고한다", () => {
  const four = parseText("````\n```\n안쪽\n```\n````\n\n뒤", "md");
  assert.deepEqual(four.blocks.map((b) => b.kind), ["code", "paragraph"]);
  assert.equal(sliceOf(four, 0), "````\n```\n안쪽\n```\n````");

  const tilde = parseText("~~~ py\n```\nx\n~~~\n\n뒤", "md");
  assert.deepEqual(tilde.blocks.map((b) => b.kind), ["code", "paragraph"]);
  assert.equal(sliceOf(tilde, 0), "~~~ py\n```\nx\n~~~");

  const open = parseText("앞\n\n```\n코드\n\n계속", "md");
  assert.deepEqual(open.blocks.map((b) => b.kind), ["paragraph", "code"]);
  assert.equal(sliceOf(open, 1), "```\n코드\n\n계속");
  assert.deepEqual(open.issues.map((i) => [i.severity, i.code]), [["warning", "TEXT_FENCE_UNCLOSED"]]);

  // 닫는 울타리 뒤 줄에 빈 줄이 없어도 새 블록이다. 백틱 울타리의 안내 글에 백틱이 있으면 울타리가 아니다
  assert.deepEqual(parseText("```\na\n```\n다음", "md").blocks.map((b) => b.kind), ["code", "paragraph"]);
  assert.deepEqual(parseText("``` a`b\n내용", "md").blocks.map((b) => b.kind), ["paragraph"]);
  // 문단 중간에서 시작한 울타리는 그 덩어리의 글일 뿐이다
  assert.deepEqual(parseText("앞 줄\n```\n코드\n```", "md").blocks.map((b) => b.kind), ["paragraph"]);
});

test("블록 모델: 표는 머리행 + 구분행 + 빈 줄 앞까지의 줄들이고, 칸 수가 다르거나 구분행이 없으면 표가 아니다", () => {
  const doc = parseText("| 구분 | 내용 |\n|:--|--:|\n| a | b |\n| c |\n\n뒤", "md");
  assert.deepEqual(doc.blocks.map((b) => b.kind), ["table", "paragraph"]);
  const rows = doc.blocks[0]?.table?.rows ?? [];
  assert.deepEqual(rows.map((r) => r.cells.length), [2, 2, 1], "구분행은 행으로 세지 않고, 어긋난 행도 표 안에 둔다");
  assert.equal(doc.blocks[0]?.table?.rows[1]?.line, 2);

  assert.deepEqual(parseText("a | b\n--|--\n1 | 2", "md").blocks.map((b) => [b.kind, b.table?.rows.length]), [["table", 2]]);
  assert.deepEqual(parseText("| a | b |\n|---|\n| 1 | 2 |", "md").blocks.map((b) => b.kind), ["paragraph"]);
  assert.deepEqual(parseText("| a | b |\n| 1 | 2 |", "md").blocks.map((b) => b.kind), ["paragraph"]);
  assert.deepEqual(parseText("그냥 글\n| a | b |\n|---|---|", "md").blocks.map((b) => b.kind), ["paragraph"], "덩어리 중간에서는 표가 시작하지 않는다");
  assert.deepEqual(parseText("| a |\n|---|\n\n| b |\n|---|", "md").blocks.map((b) => b.kind), ["table", "table"]);
});

test("블록 모델: 칸의 글 구간은 앞뒤 공백을 뺀 것이고 `\\|`는 칸을 가르지 않는다", () => {
  const src = "|  a \\| b | 둘 |  |\n|---|---|---|\n";
  const doc = parseText(src, "md");
  const cells = doc.blocks[0]?.table?.rows[0]?.cells ?? [];
  assert.deepEqual(cells.map((c) => src.slice(c.contentStart, c.contentEnd)), ["a \\| b", "둘", ""]);
  assert.deepEqual(cells.map((c) => src.slice(c.start, c.end)), ["  a \\| b ", " 둘 ", "  "]);
});

test("블록 모델: 목록·인용문·HTML·들여쓴 코드는 모두 빈 줄로 나뉜 덩어리(paragraph)이고, 제목 줄 뒤에 글이 붙으면 paragraph다", () => {
  const src = "- 가\n- 나\n\n> 인용\n\n<div>html</div>\n\n    들여쓴 코드\n\n# 제목\n본문이 붙음\n\n## 제목만";
  const doc = parseText(src, "md");
  assert.deepEqual(doc.blocks.map((b) => b.kind), ["paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "heading"]);
  assert.deepEqual(parseText("#해시태그", "md").blocks.map((b) => b.kind), ["paragraph"]);
});

test("블록 모델: 줄바꿈은 LF·CRLF·섞임 모두 줄마다 그대로 기록하고, 논리 글에는 \\r이 없다. 짝 없는 \\r은 글이다", () => {
  const mixed = "첫째 줄\r\n둘째 줄\n셋째 줄\r\n";
  const doc = parseText(mixed, "txt");
  assert.deepEqual(doc.lines.map((l) => l.eol), ["\r\n", "\n", "\r\n"]);
  assert.deepEqual(doc.blocks.map((b) => b.text), ["첫째 줄", "둘째 줄", "셋째 줄"]);
  const md = parseText("가\r\n나\r\n\r\n다", "md");
  assert.deepEqual(md.blocks.map((b) => b.text), ["가\n나", "다"]);
  const lone = parseText("앞\r뒤\n", "txt");
  assert.equal(lone.blocks.length, 1);
  assert.equal(lone.blocks[0]?.text, "앞\r뒤");
});

test("블록 모델: UTF-8로 쓸 수 없는 글(짝 없는 서로게이트)은 TEXT_ENCODING으로 거절한다", () => {
  for (const bad of ["\ud800", "가\udc00나"]) {
    assert.throws(() => parseText(bad, "txt"), (e: unknown) => e instanceof HwpxError && e.code === "TEXT_ENCODING");
    assert.throws(() => generateText(bad, "md", emptyTemplate(), ds({})), (e: unknown) => e instanceof HwpxError && e.code === "TEXT_ENCODING");
  }
  assert.equal(parseText("😀 이모지", "txt").blocks.length, 1);
});

test("시험 자료: notice.md는 제목·문단·표·코드 블록 순서의 8개 블록이다", () => {
  const doc = parseText(NOTICE, "md");
  assert.deepEqual(doc.blocks.map((b) => b.kind), ["heading", "paragraph", "paragraph", "heading", "paragraph", "table", "code", "paragraph"]);
  assert.deepEqual(doc.blocks[5]?.table?.rows.map((r) => r.cells.length), [3, 3, 3, 3]);
  const memo = parseText(MEMO, "txt");
  assert.deepEqual(memo.blocks.map((b) => b.kind), ["paragraph", "paragraph", "paragraph", "blank", "paragraph", "paragraph"]);
});

// ── T1: {{}} 채움과 누락 정책 ───────────────────────────────────

test("T1: txt — 줄 안의 {{경로}}를 템플릿 없이 데이터로 채운다", () => {
  const r = done(run(MEMO, "txt", {}, NOTICE_DATA));
  assert.equal(r.output, "메모\n사업명: 알파\n담당: 김하늘\n\n선택 줄: 선택\n마지막 줄\n");
  assert.deepEqual(r.report.plan.requiredPaths, ["opt", "owner.name", "project.name"]);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.anchor, a.targets]), [
    ["implicit", "{{opt}}", 1],
    ["implicit", "{{owner.name}}", 1],
    ["implicit", "{{project.name}}", 1],
  ]);
});

test("T1: md — 제목·문단·표 칸의 {{경로}}를 채우고 코드 블록 안은 그대로 둔다", () => {
  const r = done(run(NOTICE, "md", {}, NOTICE_DATA));
  assert.equal(
    r.output,
    [
      "# 알파 안내",
      "",
      "대상: 이서연 귀하",
      "",
      "기간: 2026-01-01 ~ 2026-12-31",
      "",
      "## 선택 조항",
      "",
      "선택 조항 본문입니다. (해당 시)",
      "",
      "| 구분 | 내용 | 비고 |",
      "|---|---|---|",
      "| A | 가 | - |",
      "| B | 나 | - |",
      "| C | 다 | - |",
      "",
      "```text",
      "코드 안의 {{project.name}}는 그대로 둔다.",
      "",
      "두 번째 줄",
      "```",
      "",
      "끝.",
      "",
    ].join("\n"),
  );
});

test("T1: 표기 안의 공백({{ 경로 }})을 허용하고, 같은 경로의 여러 자리를 모두 채운다", () => {
  assert.equal(out("{{ a.b }} 그리고 {{a.b}}\n{{a-1_x}}", "txt", {}, { a: { b: "값" }, "a-1_x": 7 }), "값 그리고 값\n7");
  assert.equal(out("`{{x}}` {{x}}", "md", {}, { x: "Y" }), "`Y` Y", "md 문단 안의 인라인 코드 표시는 보호하지 않는다(코드 블록만 보호)");
});

const END_MISSING = { ...NOTICE_DATA, project: { name: "알파", start: "2026-01-01" } };

test("T1: 누락 정책 error — 전체 중단, 출력 없음, 누락 경로를 모두 한 번에 보고하고 값 원문은 담지 않는다", () => {
  for (const [text, kind, data] of [
    [NOTICE, "md", { project: { name: "비밀값" } }],
    [MEMO, "txt", { project: { name: "비밀값" } }],
  ] as const) {
    const r = run(text, kind, {}, data);
    assert.ok(failed(r).every((c) => c === "DATA_MISSING"));
    assert.ok(!JSON.stringify(r.report).includes("비밀값"));
    assert.deepEqual(r.report.edits, [], "계획 단계에서 막혔다");
  }
  const md = run(NOTICE, "md", {}, { project: { name: "x" } });
  assert.deepEqual(md.report.plan.missingPaths, ["applicant.name", "project.end", "project.start", "table.a", "table.b"]);
  assert.deepEqual(failed(run(NOTICE, "md", {}, END_MISSING)), ["DATA_MISSING"]);
});

test("T1: 누락 정책 empty — 빈 글로 채우고(표 칸의 칸 수도 그대로), keep — 자리를 그대로 두며 둘 다 보고와 함께 진행한다", () => {
  const empty = done(run(NOTICE, "md", {}, END_MISSING, { missing: "empty" }));
  assert.ok(empty.output.includes("\n기간: 2026-01-01 ~ \n"));
  assert.deepEqual(empty.report.plan.missingPaths, ["project.end"]);
  assert.deepEqual(empty.report.plan.kept, []);
  const noTable = { ...NOTICE_DATA, table: {} };
  const emptyCells = done(run(NOTICE, "md", {}, noTable, { missing: "empty" })).output;
  assert.ok(emptyCells.includes("| A |  | - |\n| B |  | - |\n"));

  const keep = done(run(NOTICE, "md", {}, END_MISSING, { missing: "keep" }));
  assert.ok(keep.output.includes("\n기간: 2026-01-01 ~ {{project.end}}\n"));
  assert.deepEqual(keep.report.plan.kept, [{ path: "project.end", count: 1 }]);
  assert.deepEqual(keep.report.plan.missingPaths, ["project.end"]);
  assert.deepEqual(keep.report.issues, [], "일부러 남긴 {{}}는 검사 오류가 아니다");

  const txtData = { project: { name: "알파" }, owner: { name: "김하늘" } };
  assert.equal(out(MEMO, "txt", {}, txtData, { missing: "empty" }), "메모\n사업명: 알파\n담당: 김하늘\n\n선택 줄: \n마지막 줄\n");
  assert.equal(out(MEMO, "txt", {}, txtData, { missing: "keep" }), "메모\n사업명: 알파\n담당: 김하늘\n\n선택 줄: {{opt}}\n마지막 줄\n");
  assert.deepEqual(failed(run(MEMO, "txt", {}, txtData)), ["DATA_MISSING"]);
});

test("T1: 정책은 템플릿 options.missing으로도 정하고 호출 옵션이 앞선다. null도 없는 값이다", () => {
  const t = { options: { missing: "empty" } };
  assert.equal(out("a{{x}}b", "txt", t, {}), "ab");
  assert.equal(out("a{{x}}b", "txt", t, {}, { missing: "keep" }), "a{{x}}b");
  assert.deepEqual(failed(run("a{{x}}b", "txt", t, {}, { missing: "error" })), ["DATA_MISSING"]);
  assert.deepEqual(failed(run("a{{x}}b", "md", {}, { x: null })), ["DATA_MISSING"]);
  assert.equal(out("a{{x}}b", "md", {}, { x: null }, { missing: "empty" }), "ab");
});

test("T1: 값 변환 — 숫자·불리언은 글로, 객체·배열은 DATA_NOT_SCALAR, 줄바꿈·탭·금지 문자는 VALUE_CONTROL_CHAR", () => {
  assert.equal(out("{{n}} {{b}} {{f}}", "txt", {}, { n: 3, b: true, f: 1.5 }), "3 true 1.5");
  for (const kind of ["txt", "md"] as const) {
    assert.deepEqual(failed(run("{{x}}", kind, {}, { x: { a: 1 } })), ["DATA_NOT_SCALAR"]);
    assert.deepEqual(failed(run("{{x}}", kind, {}, { x: ["a"] })), ["DATA_NOT_SCALAR"]);
    for (const bad of ["두\n줄", "탭\t", "제어\u0001", "\ud800"]) {
      assert.deepEqual(failed(run("{{x}}", kind, {}, { x: bad })), ["VALUE_CONTROL_CHAR"]);
    }
  }
});

test("T1: 보고서에는 값 원문이 없고 길이와 sha256 앞 8자만 있다", () => {
  const secret = "비밀값-ZQ9";
  const r = done(run("값: {{s}}\n", "txt", {}, { s: secret }));
  assert.equal(r.output, `값: ${secret}\n`);
  assert.deepEqual(r.report.plan.actions[0]?.value, { length: secret.length, sha256: sha8(secret) });
  assert.ok(!JSON.stringify(r.report).includes(secret));
  const explicit = done(run("값\n", "txt", { anchors: [lineAnchor("a", 0, "값")], rules: [fillRule("r", "a", { text: secret })] }, {}));
  assert.ok(!JSON.stringify(explicit.report).includes(secret));
  assert.deepEqual(explicit.report.plan.actions[0]?.value, { length: secret.length, sha256: sha8(secret) });
});

test("T1: 값에 {{}} 표기가 있어도 오류가 아니다(넣은 글은 다시 채우지 않는다)", () => {
  const r = done(run("A: {{x}}\n", "txt", {}, { x: "{{y}}" }));
  assert.equal(r.output, "A: {{y}}\n");
});

// ── field 앵커: {{이름}} 표기 ────────────────────────────────────

test("field 앵커: 이름이 같은 {{이름}} 전부(또는 순번 하나)를 규칙의 값으로 채운다. 데이터 경로와 이름이 달라도 된다", () => {
  const text = "성명: {{성명}}\n확인자: {{ 성명 }}\n소속: {{소속}}\n";
  const data = { applicant: { name: "이서연" }, org: "합성기관" };
  const spec = {
    anchors: [{ id: "n", kind: "field", name: "성명" }, { id: "o", kind: "field", name: "소속" }],
    rules: [fillRule("r1", "n", { path: "applicant.name" }), fillRule("r2", "o", { path: "org" })],
  };
  const r = done(run(text, "txt", spec, data));
  assert.equal(r.output, "성명: 이서연\n확인자: 이서연\n소속: 합성기관\n");
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.anchor, a.targets]), [["r1", "n", 2], ["r2", "o", 1]]);

  const second = { anchors: [{ id: "n2", kind: "field", name: "성명", occurrence: 1 }], rules: [fillRule("r", "n2", { text: "둘째" })] };
  assert.equal(out(text, "txt", second, { 소속: "합성기관" }, { missing: "keep" }), "성명: {{성명}}\n확인자: 둘째\n소속: 합성기관\n");
});

test("field 앵커: 규칙의 조건이 거짓이면 그 {{이름}}은 그대로 둔다(암묵 채움으로 넘어가 누락 오류가 되지 않는다)", () => {
  const spec = {
    anchors: [{ id: "n", kind: "field", name: "성명" }],
    rules: [fillRule("r", "n", { path: "applicant.name" }, { path: "applicant.name", op: "exists" })],
  };
  const r = done(run("성명: {{성명}}\n", "txt", spec, {}));
  assert.equal(r.output, "성명: {{성명}}\n");
  assert.deepEqual(r.report.plan.inactiveRules, ["r"]);
});

test("field 앵커: 코드 블록 안에만 있거나 문서에 없으면 ANCHOR_NOT_FOUND이고, 규칙이 거짓이면 찾지도 않는다", () => {
  const spec = (when?: unknown) => ({ anchors: [{ id: "n", kind: "field", name: "성명" }], rules: [fillRule("r", "n", { text: "x" }, when)] });
  assert.deepEqual(failed(run("글\n", "txt", spec(), {})), ["ANCHOR_NOT_FOUND"]);
  assert.deepEqual(failed(run("```\n{{성명}}\n```\n", "md", spec(), {})), ["ANCHOR_NOT_FOUND"]);
  assert.equal(out("```\n{{성명}}\n```\n", "md", spec(), {}, { fillInCode: true }), "```\nx\n```\n");
  assert.equal(out("글\n", "txt", spec({ path: "never", op: "exists" }), {}), "글\n");
});

// ── 앵커: line · word · cell · object ───────────────────────────

test("line 앵커: 블록 서수와 글 지문이 맞으면 그 블록의 글 전체를 값으로 바꾼다", () => {
  const spec = { anchors: [lineAnchor("a", 5, "마지막 줄")], rules: [fillRule("r", "a", { path: "owner.name" })] };
  const r = done(run(MEMO, "txt", spec, NOTICE_DATA));
  assert.equal(r.output, "메모\n사업명: 알파\n담당: 김하늘\n\n선택 줄: 선택\n김하늘\n");
  assert.deepEqual(r.report.plan.relocated, []);
  // md: 여러 줄 덩어리도 한 블록이다(논리 글은 \n으로 이은 것)
  const md = "첫째\n둘째\n\n다음\n";
  assert.equal(out(md, "md", { anchors: [lineAnchor("a", 0, "첫째\n둘째")], rules: [fillRule("r", "a", { text: "바뀜" })] }, {}), "바뀜\n\n다음\n");
});

test("line 앵커: 지문이 안 맞으면 문서에서 지문으로 다시 찾는다 — 유일하면 ANCHOR_RELOCATED(경고), 여럿이면 ANCHOR_AMBIGUOUS, 없으면 ANCHOR_NOT_FOUND", () => {
  const text = "가\n나\n다\n나2\n";
  const rule = (a: string) => ({ anchors: [lineAnchor("a", 1, a)], rules: [deleteRule("d", "a")] });
  // 서수 1은 "나"인데 지문은 "다"의 것 → 유일하게 찾아 재배치
  const r = done(run(text, "txt", rule("다"), {}));
  assert.equal(r.output, "가\n나\n나2\n");
  assert.equal(r.report.plan.relocated.length, 1);
  assert.equal(r.report.plan.relocated[0]?.anchor, "a");
  assert.deepEqual(r.report.issues.map((i) => [i.severity, i.code]), [["warning", "ANCHOR_RELOCATED"]]);

  const dup = "다\n가\n나\n다\n";
  assert.deepEqual(failed(run(dup, "txt", rule("다"), {})), ["ANCHOR_AMBIGUOUS"]);
  assert.deepEqual(failed(run(text, "txt", rule("없는 글"), {})), ["ANCHOR_NOT_FOUND"]);
  // 서수가 범위 밖이어도 지문으로 찾는다
  const far = { anchors: [{ ...lineAnchor("a", 0, "다"), at: { sectionIndex: 0, path: [99] } }], rules: [deleteRule("d", "a")] };
  assert.equal(out(text, "txt", far, {}), "가\n나\n나2\n");
  // HWPX 방식의 깊은 주소는 텍스트 문서에 없다 → 지문으로만 찾는다
  const deep = { anchors: [{ ...lineAnchor("a", 0, "다"), at: { sectionIndex: 0, path: [0, 0, 2] } }], rules: [deleteRule("d", "a")] };
  assert.equal(done(run(text, "txt", deep, {})).report.plan.relocated.length, 1);
  // 구역 1은 없다
  const sec = { anchors: [{ ...lineAnchor("a", 0, "가"), at: { sectionIndex: 1, path: [0] } }], rules: [deleteRule("d", "a")] };
  assert.deepEqual(failed(run(text, "txt", sec, {})), ["ANCHOR_NOT_FOUND"]);
});

test("line 앵커: 줄바꿈 방식과 무관하다 — LF 문서에서 만든 지문이 CRLF 문서에도 맞는다(재배치 없이)", () => {
  const lf = "첫째\n둘째\n\n다음\n";
  const spec = { anchors: [lineAnchor("a", 0, "첫째\n둘째")], rules: [deleteRule("d", "a")] };
  assert.equal(out(lf, "md", spec, {}), "다음\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  const r = done(run(crlf, "md", spec, {}));
  assert.equal(r.output, "다음\r\n");
  assert.deepEqual(r.report.plan.relocated, []);
});

test("word 앵커: 블록 논리 글의 구간과 앞뒤 지문이 맞으면 그 구간만 바꾸고, 어긋나면 지문으로 다시 찾는다", () => {
  const text = "가나다 사업명 라마바\n사아자 사업명 차카타\n";
  const logical = "가나다 사업명 라마바";
  const start = logical.indexOf("사업명");
  const spec = { anchors: [wordAnchor("w", 0, logical, start, start + 3)], rules: [fillRule("r", "w", { path: "p" })] };
  assert.equal(out(text, "txt", spec, { p: "알파" }), "가나다 알파 라마바\n사아자 사업명 차카타\n");

  // 서수가 틀려도(블록 1은 다른 글) 앞뒤 지문으로 유일하게 다시 찾는다
  const moved = { anchors: [{ ...wordAnchor("w", 0, logical, start, start + 3), at: { sectionIndex: 0, path: [1] } }], rules: [fillRule("r", "w", { path: "p" })] };
  const r = done(run(text, "txt", moved, { p: "알파" }));
  assert.equal(r.output, "가나다 알파 라마바\n사아자 사업명 차카타\n");
  assert.equal(r.report.plan.relocated.length, 1);

  // 서수는 틀리고(범위 밖) 앞뒤 글까지 같은 자리가 하나뿐이면 다시 찾고, 둘이면 모호하며, 없으면 찾지 못한다
  const bare = { id: "w", kind: "word", at: { sectionIndex: 0, path: [5] }, start: 0, end: 3, print: { text: "사업명", before: "", after: " 사업명" } };
  const use = (text: string, anchor: unknown) => run(text, "txt", { anchors: [anchor], rules: [fillRule("r", "w", { text: "x" })] }, {});
  assert.equal(done(use("사업명 사업명\n", bare)).output, "x 사업명\n");
  assert.deepEqual(failed(use("사업명 사업명\n사업명 사업명\n", bare)), ["ANCHOR_AMBIGUOUS"]);
  assert.deepEqual(failed(use("다른 글\n", bare)), ["ANCHOR_NOT_FOUND"]);
});

test("word 앵커: 여러 줄 md 블록 안의 구간(줄바꿈 가로지름 포함)도 CRLF 문서에서 원문 좌표로 바뀐다", () => {
  const lf = "첫 줄 끝\n둘째 줄 시작\n\n뒤\n";
  const logical = "첫 줄 끝\n둘째 줄 시작";
  const s = logical.indexOf("끝");
  const e = logical.indexOf("둘째") + 2;
  const spec = { anchors: [wordAnchor("w", 0, logical, s, e)], rules: [fillRule("r", "w", { text: "→" })] };
  assert.equal(out(lf, "md", spec, {}), "첫 줄 → 줄 시작\n\n뒤\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  const r = done(run(crlf, "md", spec, {}));
  assert.equal(r.output, "첫 줄 → 줄 시작\r\n\r\n뒤\r\n");
  assertOnlyEditsChanged(crlf, r.output, r.report.edits);
});

test("cell 앵커: md 표의 행(머리행 0, 데이터 행 1부터)과 열로 찾고, 범위 밖이면 ANCHOR_NOT_FOUND다", () => {
  const spec = (row: number, col: number, ordinal = 0) => ({ anchors: [cellAnchor("c", ordinal, row, col)], rules: [fillRule("r", "c", { text: "Z" })] });
  const text = "| h1 | h2 |\n|---|---|\n| a | b |\n| c | d |\n";
  assert.equal(out(text, "md", spec(0, 1), {}), "| h1 | Z |\n|---|---|\n| a | b |\n| c | d |\n");
  assert.equal(out(text, "md", spec(1, 0), {}), "| h1 | h2 |\n|---|---|\n| Z | b |\n| c | d |\n");
  assert.equal(out(text, "md", spec(2, 1), {}), "| h1 | h2 |\n|---|---|\n| a | b |\n| c | Z |\n");
  for (const [row, col, ordinal] of [[3, 0, 0], [0, 2, 0], [1, 0, 1]] as const) {
    assert.deepEqual(failed(run(text, "md", spec(row, col, ordinal), {})), ["ANCHOR_NOT_FOUND"]);
  }
  // 두 번째 표는 ordinal 1
  const two = `${text}\n| x |\n|---|\n| y |\n`;
  assert.equal(out(two, "md", spec(1, 0, 1), {}), `${text}\n| x |\n|---|\n| Z |\n`);
  // 표가 아닌 블록에는 셀이 없다. txt에는 표가 없다
  assert.deepEqual(failed(run("글\n", "md", spec(0, 0), {})), ["ANCHOR_NOT_FOUND"]);
  assert.deepEqual(failed(run(text, "txt", spec(0, 0), {})), ["ANCHOR_NOT_FOUND"]);
});

test("object 앵커: md 표·코드 블록의 서수로 찾아 블록째 지우고, 그 밖의 종류는 ANCHOR_NOT_FOUND다", () => {
  const text = "앞\n\n| a |\n|---|\n| 1 |\n\n```\n첫 코드\n```\n\n뒤\n\n```\n둘째 코드\n```\n";
  const object = (id: string, objectType: string, ordinal: number, sectionIndex = 0) => ({ anchors: [{ id, kind: "object", objectType, sectionIndex, ordinal }], rules: [deleteRule("d", id)] });
  assert.equal(out(text, "md", object("o", "table", 0), {}), "앞\n\n```\n첫 코드\n```\n\n뒤\n\n```\n둘째 코드\n```\n");
  assert.equal(out(text, "md", object("o", "code", 0), {}), "앞\n\n| a |\n|---|\n| 1 |\n\n뒤\n\n```\n둘째 코드\n```\n");
  assert.equal(out(text, "md", object("o", "code", 1), {}), "앞\n\n| a |\n|---|\n| 1 |\n\n```\n첫 코드\n```\n\n뒤\n");
  for (const bad of [object("o", "code", 2), object("o", "table", 1), object("o", "tbl", 0), object("o", "picture", 0), object("o", "table", 0, 1)]) {
    assert.deepEqual(failed(run(text, "md", bad, {})), ["ANCHOR_NOT_FOUND"]);
  }
});

// ── T2: 조건에 따른 블록 삭제와 텍스트 조각 주입 ────────────────

test("T2: txt — 참인 규칙만 줄을 지우고 조각을 주입하며, 지워지는 줄 안의 {{}}는 누락 오류 없이 버린다", () => {
  const spec = {
    anchors: [lineAnchor("a-owner", 2, "담당: {{owner.name}}"), lineAnchor("a-opt", 4, "선택 줄: {{opt}}")],
    rules: [
      deleteRule("r-del", "a-opt", { path: "opt", op: "empty" }),
      injectRule("r-inj", "a-owner", "after", fragmentOf("[용역] 담당 {{owner.name}}", "수행 기간 {{project.start}}"), { path: "contract.type", op: "eq", value: "용역" }),
    ],
  };
  const base = { project: { name: "알파", start: "2026-01-01" }, owner: { name: "김하늘" } };

  const both = done(run(MEMO, "txt", spec, { ...base, contract: { type: "용역" } }));
  assert.equal(both.output, "메모\n사업명: 알파\n담당: 김하늘\n[용역] 담당 김하늘\n수행 기간 2026-01-01\n\n마지막 줄\n");
  assert.deepEqual(both.report.plan.inactiveRules, []);
  assert.deepEqual(both.report.plan.expected, { blocks: 1 });
  assert.deepEqual(both.report.plan.dropped.map((d) => [d.ruleId, d.anchor]), [["implicit", "{{opt}}"]]);
  assert.deepEqual(both.report.plan.missingPaths, [], "지워진 줄의 {{opt}}는 누락으로 세지 않는다");
  assert.deepEqual(
    both.report.plan.actions.filter((a) => a.ruleId !== "implicit").map((a) => [a.ruleId, a.type, a.targets, a.position]),
    [["r-inj", "inject", 2, "after"], ["r-del", "delete", 1, undefined]],
  );
  assertOnlyEditsChanged(MEMO, both.output, both.report.edits);

  // 조건이 둘 다 거짓: 지우지도 넣지도 않고, 쓰지 않는 조각의 {{project.start}}가 없어도 오류가 아니다
  const none = done(run(MEMO, "txt", spec, { project: { name: "알파" }, owner: { name: "김하늘" }, opt: "x", contract: { type: "물품" } }));
  assert.equal(none.output, "메모\n사업명: 알파\n담당: 김하늘\n\n선택 줄: x\n마지막 줄\n");
  assert.deepEqual(none.report.plan.inactiveRules, ["r-del", "r-inj"]);

  const onlyDelete = done(run(MEMO, "txt", spec, { ...base, contract: { type: "물품" } }));
  assert.equal(onlyDelete.output, "메모\n사업명: 알파\n담당: 김하늘\n\n마지막 줄\n");
  assert.deepEqual(onlyDelete.report.plan.expected, { blocks: -1 });
});

test("T2: md — 조건이 참이면 제목·본문 블록을 지우고(뒤 블록 앞까지) 조각(문단·목록·표)을 넣는다", () => {
  const head = "## 선택 조항";
  const body = "선택 조항 본문입니다. (해당 시)";
  const optionalOff = { path: "terms.optional", op: "eq", value: false };
  const spec = {
    anchors: [lineAnchor("head", 3, head), lineAnchor("body", 4, body), lineAnchor("period", 2, "기간: {{project.start}} ~ {{project.end}}")],
    rules: [
      deleteRule("r1", "head", optionalOff),
      deleteRule("r2", "body", optionalOff),
      injectRule("r3", "period", "after", fragmentOf("### 용역 조항", "- {{owner.name}}가 수행한다.\n- 기간 내 완료", "| 항목 | 값 |\n|---|---|\n| 금액 | {{amount}} |"), {
        path: "contract.type",
        op: "eq",
        value: "용역",
      }),
    ],
  };
  const data = { ...NOTICE_DATA, terms: { optional: false }, contract: { type: "용역" }, amount: "1,000|원" };
  const r = done(run(NOTICE, "md", spec, data));
  assert.equal(
    r.output,
    [
      "# 알파 안내",
      "",
      "대상: 이서연 귀하",
      "",
      "기간: 2026-01-01 ~ 2026-12-31",
      "",
      "### 용역 조항",
      "",
      "- 김하늘가 수행한다.",
      "- 기간 내 완료",
      "",
      "| 항목 | 값 |",
      "|---|---|",
      "| 금액 | 1,000\\|원 |",
      "",
      "| 구분 | 내용 | 비고 |",
      "|---|---|---|",
      "| A | 가 | - |",
      "| B | 나 | - |",
      "| C | 다 | - |",
      "",
      "```text",
      "코드 안의 {{project.name}}는 그대로 둔다.",
      "",
      "두 번째 줄",
      "```",
      "",
      "끝.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(r.report.plan.expected, { blocks: 1, tables: 1, tableRows: 2 });
  assertOnlyEditsChanged(NOTICE, r.output, r.report.edits);

  // 거짓이면 아무것도 지우거나 넣지 않는다(채움만)
  const off = done(run(NOTICE, "md", spec, { ...NOTICE_DATA, terms: { optional: true }, contract: { type: "물품" } }));
  assert.ok(off.output.includes("## 선택 조항\n\n선택 조항 본문입니다. (해당 시)\n\n| 구분"));
  assert.ok(!off.output.includes("용역 조항"));
  assert.deepEqual(off.report.plan.inactiveRules, ["r1", "r2", "r3"]);
});

test("T2: 지우는 구간은 이어진 블록이면 하나로 합치고, 마지막 블록이면 앞 구분까지 지워 끝 줄바꿈을 지킨다", () => {
  const text = "A\n\nB\n\nC\n\nD\n";
  const del = (...ids: number[]) => ({ anchors: ids.map((i) => lineAnchor(`a${i}`, i, "ABCD"[i] ?? "")), rules: ids.map((i) => deleteRule(`d${i}`, `a${i}`)) });
  assert.equal(out(text, "md", del(1), {}), "A\n\nC\n\nD\n");
  assert.equal(out(text, "md", del(0), {}), "B\n\nC\n\nD\n");
  assert.equal(out(text, "md", del(3), {}), "A\n\nB\n\nC\n");
  assert.equal(out(text, "md", del(2, 3), {}), "A\n\nB\n");
  assert.equal(out(text, "md", del(1, 2), {}), "A\n\nD\n");
  assert.equal(out(text, "md", del(0, 1, 2, 3), {}), "\n", "모두 지워도 끝 줄바꿈은 남는다");
  assert.equal(out(text, "md", del(0, 2), {}), "B\n\nD\n");
  // 끝 줄바꿈이 여럿이거나 없을 때도 그대로
  assert.equal(out("A\n\nB\n\n\n", "md", { anchors: [lineAnchor("a", 1, "B")], rules: [deleteRule("d", "a")] }, {}), "A\n\n\n");
  assert.equal(out("A\n\nB", "md", { anchors: [lineAnchor("a", 1, "B")], rules: [deleteRule("d", "a")] }, {}), "A");
  assert.equal(out("a\nb\nc", "txt", { anchors: [lineAnchor("a", 2, "c")], rules: [deleteRule("d", "a")] }, {}), "a\nb");
  assert.equal(out("a\nb\nc\n", "txt", { anchors: [lineAnchor("a", 0, "a")], rules: [deleteRule("d", "a")] }, {}), "b\nc\n");
});

test("T2: 같은 블록을 가리키는 삭제 둘은 한 번만 지우고, 지워진 블록에 대한 채움·삽입은 버린다", () => {
  const text = "가\n나\n다\n";
  const spec = {
    anchors: [lineAnchor("a", 1, "나")],
    rules: [
      deleteRule("d1", "a"),
      deleteRule("d2", "a"),
      fillRule("f", "a", { text: "바꿈" }),
      injectRule("i", "a", "after", fragmentOf("끼움")),
      insertRule("t", "a", "before", { text: "앞" }),
    ],
  };
  const r = done(run(text, "txt", spec, {}));
  assert.equal(r.output, "가\n다\n");
  assert.deepEqual(r.report.plan.dropped.map((d) => [d.ruleId, d.anchor]).sort(), [["f", "a"], ["i", "a"], ["t", "a"]]);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.targets]), [["d1", 1], ["d2", 1]]);
});

// ── 조각 주입·텍스트 삽입의 자리와 모양 ─────────────────────────

test("조각 주입: before·after·replace와 맨 앞·맨 끝, 규칙 순서, 인접한 앞뒤 삽입 (txt)", () => {
  const text = "a\nb\nc\n";
  const on = (id: string, ordinal: number, logical: string) => lineAnchor(id, ordinal, logical);
  const one = (position: string, ordinal = 1, logical = "b", t = text) => out(t, "txt", { anchors: [on("x", ordinal, logical)], rules: [injectRule("r", "x", position, fragmentOf("X"))] }, {});
  assert.equal(one("before"), "a\nX\nb\nc\n");
  assert.equal(one("after"), "a\nb\nX\nc\n");
  assert.equal(one("replace"), "a\nX\nc\n");
  assert.equal(one("before", 0, "a"), "X\na\nb\nc\n");
  assert.equal(one("after", 2, "c"), "a\nb\nc\nX\n", "끝 줄바꿈은 새 마지막 줄 뒤에 남는다");
  assert.equal(one("after", 2, "c", "a\nb\nc"), "a\nb\nc\nX", "끝 줄바꿈이 없던 문서는 없는 채로 둔다");
  assert.equal(one("replace", 2, "c", "a\nb\nc"), "a\nb\nX");

  const twice = (position: string) => ({
    anchors: [on("x", 1, "b")],
    rules: [injectRule("r1", "x", position, fragmentOf("X")), injectRule("r2", "x", position, fragmentOf("Y"))],
  });
  assert.equal(out(text, "txt", twice("after"), {}), "a\nb\nX\nY\nc\n");
  assert.equal(out(text, "txt", twice("before"), {}), "a\nX\nY\nb\nc\n");
  const around = { anchors: [on("p", 0, "a"), on("q", 1, "b")], rules: [injectRule("r1", "p", "after", fragmentOf("P")), injectRule("r2", "q", "before", fragmentOf("Q"))] };
  assert.equal(out(text, "txt", around, {}), "a\nP\nQ\nb\nc\n");
  // 블록 여럿, 줄바꿈이 든 블록(줄 여럿), 끝 줄바꿈이 붙은 블록(줄바꿈 하나는 줄을 끝내는 것일 뿐), 빈 문자열(빈 줄 하나)
  const shape = (...blocks: string[]) => out(text, "txt", { anchors: [on("x", 1, "b")], rules: [injectRule("r", "x", "after", fragmentOf(...blocks))] }, {});
  assert.equal(shape("X", "Y"), "a\nb\nX\nY\nc\n");
  assert.equal(shape("x\ny"), "a\nb\nx\ny\nc\n");
  assert.equal(shape("x\n"), "a\nb\nx\nc\n");
  assert.equal(shape(""), "a\nb\n\nc\n");
  // 교체와 앞뒤 삽입은 함께 쓸 수 있다
  const mix = { anchors: [on("x", 1, "b")], rules: [injectRule("r1", "x", "before", fragmentOf("P")), injectRule("r2", "x", "replace", fragmentOf("X")), injectRule("r3", "x", "after", fragmentOf("Q"))] };
  assert.equal(out(text, "txt", mix, {}), "a\nP\nX\nQ\nc\n");
});

test("조각 주입: md는 블록 사이를 이웃 구분(빈 줄 방식)으로 잇는다 — 위치별, 끝 줄바꿈 없음, 빈 줄 여럿, CRLF", () => {
  const text = "A\n\nB\n\nC\n";
  const at = (position: string, blocks: string[], t = text, ordinal = 1, logical = "B") =>
    out(t, "md", { anchors: [lineAnchor("x", ordinal, logical)], rules: [injectRule("r", "x", position, fragmentOf(...blocks))] }, {});
  assert.equal(at("after", ["X", "Y"]), "A\n\nB\n\nX\n\nY\n\nC\n");
  assert.equal(at("before", ["X", "Y"]), "A\n\nX\n\nY\n\nB\n\nC\n");
  assert.equal(at("replace", ["X", "Y"]), "A\n\nX\n\nY\n\nC\n");
  assert.equal(at("after", ["X"], "A\n\nB"), "A\n\nB\n\nX");
  assert.equal(at("after", ["X"], "A\n\n\n\nB\n", 0, "A"), "A\n\n\n\nX\n\n\n\nB\n", "빈 줄이 여럿이면 그 구분을 따른다");
  assert.equal(at("after", ["x\ny"], "A\r\n\r\nB\r\n", 0, "A"), "A\r\n\r\nx\r\ny\r\n\r\nB\r\n", "블록 안 줄바꿈도 문서의 방식으로");
  assert.equal(at("after", ["X"], "A", 0, "A"), "A\n\nX", "블록이 하나뿐이고 줄바꿈이 없으면 LF와 빈 줄");
  // 코드 블록·표는 통째로 한 블록(코드 안 빈 줄 포함)
  assert.equal(at("after", ["```\na\n\nb\n```"]), "A\n\nB\n\n```\na\n\nb\n```\n\nC\n");
  // 코드 블록 바로 뒤에 빈 줄 없이 붙은 블록이 있으면 새 블록과 그 블록이 한 덩어리가 되지 않게 한다
  const weak = "```\na\n```\nB\n";
  assert.equal(at("after", ["X"], weak, 0, "```\na\n```"), "```\na\n```\n\nX\n\nB\n");
  assert.equal(at("before", ["X"], weak, 1, "B"), "```\na\n```\nX\n\nB\n");
  assert.equal(at("replace", ["X"], weak, 0, "```\na\n```"), "X\n\nB\n");
});

test("조각 주입: 조각 경로는 fragments 옵션에서 찾고(객체나 JSON 글), 없거나 모양이 틀리면 오류다", () => {
  const spec = { anchors: [lineAnchor("x", 0, "A")], rules: [injectRule("r", "x", "after", "fragments/terms.json")] };
  const frag = fragmentOf("X {{v}}");
  assert.equal(out("A\n", "txt", spec, { v: "1" }, { fragments: { "fragments/terms.json": frag } }), "A\nX 1\n");
  assert.equal(out("A\n", "txt", spec, { v: "1" }, { fragments: { "fragments/terms.json": JSON.stringify(frag) } }), "A\nX 1\n");
  assert.deepEqual(failed(run("A\n", "txt", spec, {})), ["TPL_FRAGMENT_MISSING"]);
  const bad = (f: unknown) => failed(run("A\n", "txt", spec, { v: 1 }, { fragments: { "fragments/terms.json": f as string } }));
  assert.deepEqual(bad({ schema: "other", blocks: ["x"] }), ["FRAG_SCHEMA"]);
  assert.deepEqual(bad({ schema: "hwpx-studio/text-fragment@1", blocks: [] }), ["FRAG_SCHEMA"]);
  assert.deepEqual(bad({ schema: "hwpx-studio/text-fragment@1", blocks: [1] }), ["FRAG_SCHEMA"]);
  assert.deepEqual(bad("{ 깨진 JSON"), ["FRAG_SCHEMA"]);
  // 조각 JSON 글을 규칙에 직접 적어도 된다
  const direct = { anchors: [lineAnchor("x", 0, "A")], rules: [injectRule("r", "x", "after", JSON.stringify(frag))] };
  assert.equal(out("A\n", "txt", direct, { v: "1" }), "A\nX 1\n");
  // 내장 객체
  const inline ={ anchors: [lineAnchor("x", 0, "A")], rules: [injectRule("r", "x", "after", { schema: "other", blocks: ["x"] })] };
  assert.deepEqual(failed(run("A\n", "txt", inline, {})), ["FRAG_SCHEMA"]);
});

test("조각 주입: md 조각 블록은 한 덩어리여야 하고, 조각 안 {{}}는 같은 데이터·정책으로 채운다(코드 블록은 기본으로 그대로)", () => {
  const one = (blocks: string[], data: unknown = {}, options?: TextOptions) =>
    run("A\n", "md", { anchors: [lineAnchor("x", 0, "A")], rules: [injectRule("r", "x", "after", fragmentOf(...blocks))] }, data, options);
  assert.deepEqual(failed(one(["첫째\n\n둘째"])), ["FRAG_SCHEMA"]);
  assert.deepEqual(failed(one(["  \n"])), ["FRAG_SCHEMA"]);
  // 조각 안 누락: error → DATA_MISSING, keep → 그대로(검사 오류 아님), empty → 빈 글
  assert.deepEqual(failed(one(["값 {{q}}"])), ["DATA_MISSING"]);
  assert.equal(done(one(["값 {{q}}"], {}, { missing: "keep" })).output, "A\n\n값 {{q}}\n");
  assert.equal(done(one(["값 {{q}}"], {}, { missing: "empty" })).output, "A\n\n값 \n");
  // 코드 블록·표
  const code = "```\n{{q}}\n```";
  assert.equal(done(one([code], { q: "Z" })).output, "A\n\n```\n{{q}}\n```\n");
  assert.equal(done(one([code], { q: "Z" }, { fillInCode: true })).output, "A\n\n```\nZ\n```\n");
  assert.equal(done(one(["| h |\n|---|\n| {{q}} |"], { q: "a|b" })).output, "A\n\n| h |\n|---|\n| a\\|b |\n");
});

test("텍스트 삽입: 값의 줄바꿈은 txt에서는 줄, md에서는 문단 블록이다(빈 줄은 md의 문단 구분이라 건너뛴다)", () => {
  const ins = (text: string, kind: TextKind, position: string, value: unknown, data: unknown = {}, options?: TextOptions, ordinal = 1, logical = "b") =>
    out(text, kind, { anchors: [lineAnchor("x", ordinal, logical)], rules: [insertRule("r", "x", position, value)] }, data, options);
  assert.equal(ins("a\nb\nc\n", "txt", "after", { text: "x\ny" }), "a\nb\nx\ny\nc\n");
  assert.equal(ins("a\nb\nc\n", "txt", "before", { path: "v" }, { v: "x\r\ny" }), "a\nx\ny\nb\nc\n");
  assert.equal(ins("a\r\nb\r\nc\r\n", "txt", "after", { path: "v" }, { v: "x\ny" }), "a\r\nb\r\nx\r\ny\r\nc\r\n", "새 줄은 문서의 줄바꿈 방식으로");
  assert.equal(ins("a\nb\nc\n", "txt", "replace", { text: "x\n\ny" }), "a\nx\n\ny\nc\n", "txt는 값의 빈 줄도 줄이다");
  assert.equal(ins("A\n\nB\n\nC\n", "md", "after", { text: "x\n\ny\nz" }, {}, undefined, 1, "B"), "A\n\nB\n\nx\n\ny\n\nz\n\nC\n");
  assert.equal(ins("A\n\nB\n\nC\n", "md", "replace", { text: "x\ny" }, {}, undefined, 1, "B"), "A\n\nx\n\ny\n\nC\n");
  assert.equal(ins("A\n\nB\n", "md", "before", { text: "x" }, {}, undefined, 0, "A"), "x\n\nA\n\nB\n");
  // 빈 값은 넣을 것이 없다. 누락 정책은 값 경로에 같다
  assert.equal(ins("a\nb\n", "txt", "after", { text: "" }), "a\nb\n");
  assert.equal(ins("A\n\nB\n", "md", "after", { text: " \n " }, {}, undefined, 0, "A"), "A\n\nB\n");
  assert.equal(ins("a\nb\n", "txt", "after", { path: "v" }, {}, { missing: "empty" }), "a\nb\n");
  assert.equal(ins("a\nb\n", "txt", "after", { path: "v" }, {}, { missing: "keep" }), "a\nb\n");
  assert.deepEqual(failed(run("a\nb\n", "txt", { anchors: [lineAnchor("x", 1, "b")], rules: [insertRule("r", "x", "after", { path: "v" })] }, {})), ["DATA_MISSING"]);
  assert.deepEqual(failed(run("a\nb\n", "txt", { anchors: [lineAnchor("x", 1, "b")], rules: [insertRule("r", "x", "after", { path: "v" })] }, { v: "a\tb" })), ["VALUE_CONTROL_CHAR"]);
  assert.deepEqual(failed(run("a\nb\n", "txt", { anchors: [lineAnchor("x", 1, "b")], rules: [insertRule("r", "x", "after", { path: "v" })] }, { v: { a: 1 } })), ["DATA_NOT_SCALAR"]);
  // 보고서: 삽입한 줄 수와 값 지문
  const r = done(run("a\nb\n", "txt", { anchors: [lineAnchor("x", 1, "b")], rules: [insertRule("r", "x", "after", { text: "x\ny" })] }, {}));
  assert.deepEqual(r.report.plan.actions, [{ ruleId: "r", type: "insertText", anchor: "x", targets: 2, position: "after", value: { length: 3, sha256: sha8("x\ny") } }]);
  assert.deepEqual(r.report.plan.expected, { blocks: 2 });
});

test("충돌: 같은 자리를 다른 값으로 바꾸는 둘은 TPL_CONFLICT, 같은 값이면 한 번만 바꾼다. 같은 블록을 둘이 교체해도 TPL_CONFLICT", () => {
  const anchors = [lineAnchor("a", 0, "가")];
  assert.deepEqual(failed(run("가\n", "txt", { anchors, rules: [fillRule("r1", "a", { text: "A" }), fillRule("r2", "a", { text: "B" })] }, {})), ["TPL_CONFLICT"]);
  assert.equal(out("가\n", "txt", { anchors, rules: [fillRule("r1", "a", { text: "A" }), fillRule("r2", "a", { text: "A" })] }, {}), "A\n");
  const two = { anchors, rules: [injectRule("r1", "a", "replace", fragmentOf("X")), insertRule("r2", "a", "replace", { text: "Y" })] };
  assert.deepEqual(failed(run("가\n", "txt", two, {})), ["TPL_CONFLICT"]);
  // 교체되는 블록 안의 채움은 버린다
  const swallowed = { anchors, rules: [injectRule("r1", "a", "replace", fragmentOf("X")), fillRule("r2", "a", { text: "B" })] };
  const r = done(run("가\n", "txt", swallowed, {}));
  assert.equal(r.output, "X\n");
  assert.deepEqual(r.report.plan.dropped.map((d) => d.ruleId), ["r2"]);
  // 명시한 칸 채움과 같은 칸 안 {{}}: 값이 같으면 하나로, 다르면 충돌
  const cell = { anchors: [cellAnchor("c", 0, 1, 0)], rules: [fillRule("r", "c", { path: "v" })] };
  assert.equal(out("| h |\n|---|\n| {{v}} |\n", "md", cell, { v: "Z" }), "| h |\n|---|\n| Z |\n");
  assert.deepEqual(failed(run("| h |\n|---|\n| {{v}} |\n", "md", { anchors: [cellAnchor("c", 0, 1, 0)], rules: [fillRule("r", "c", { text: "Q" })] }, { v: "Z" })), ["TPL_CONFLICT"]);
});

// ── T3: md 표 — 칸 채움, 행 삭제, 열 수 유지 ────────────────────

const TABLE = "| 구분 | 내용 | 비고 |\n|---|---|---|\n| A | 가 | - |\n| B | 나 | - |\n| C | 다 | - |\n";

/** 시험이 직접 세는 칸 수: 줄 앞뒤 파이프를 떼고 `\|`가 아닌 `|`로 나눈다(구현의 파서를 쓰지 않는다) */
const colsOf = (line: string): number => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).length;
};
const tableLines = (md: string): string[] => md.split(/\r?\n/).filter((l) => l.startsWith("|"));
const assertColumns = (md: string, n: number): void => {
  assert.ok(tableLines(md).length > 0);
  for (const line of tableLines(md)) assert.equal(colsOf(line), n, `열 수가 ${n}이어야 한다: ${line}`);
};
const deleteRows = (...rows: number[]) => ({
  anchors: rows.map((r) => cellAnchor(`c${r}`, 0, r, 0)),
  rules: rows.map((r) => deleteRule(`d${r}`, `c${r}`, undefined, "row")),
});

test("T3: 칸 채움 — 명시한 cell 앵커와 칸 안 {{}} 모두 값 안의 |를 \\|로 쓰고 열 수가 그대로다", () => {
  const spec = { anchors: [cellAnchor("c", 0, 1, 1)], rules: [fillRule("r", "c", { path: "v" })] };
  const r = done(run(TABLE, "md", spec, { v: "a|b" }));
  assert.equal(r.output, "| 구분 | 내용 | 비고 |\n|---|---|---|\n| A | a\\|b | - |\n| B | 나 | - |\n| C | 다 | - |\n");
  assertColumns(r.output, 3);
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.type, a.targets]), [["r", "fill", 1]]);

  const implicit = "| a | b |\n|---|---|\n| {{x}} | {{y}} |\n";
  const i = done(run(implicit, "md", {}, { x: "1|2", y: "z" }));
  assert.equal(i.output, "| a | b |\n|---|---|\n| 1\\|2 | z |\n");
  assertColumns(i.output, 2);
  // 값이 이미 `\|`라는 글자를 담아도 칸을 가르지 않는다(백슬래시를 짝맞춰 쓴다)
  const slash = done(run(implicit, "md", {}, { x: "a\\|b", y: "z" }));
  assert.equal(slash.output, "| a | b |\n|---|---|\n| a\\\\\\|b | z |\n");
  assertColumns(slash.output, 2);
  // 표 밖에서는 | 를 그대로 둔다
  assert.equal(out("{{x}}\n", "md", {}, { x: "a|b" }), "a|b\n");
});

test("T3: 칸 값의 줄바꿈은 VALUE_CONTROL_CHAR로 거절하고 출력이 없다", () => {
  const spec = { anchors: [cellAnchor("c", 0, 1, 1)], rules: [fillRule("r", "c", { path: "v" })] };
  assert.deepEqual(failed(run(TABLE, "md", spec, { v: "두\n줄" })), ["VALUE_CONTROL_CHAR"]);
  assert.deepEqual(failed(run(TABLE, "md", spec, { v: "두\r\n줄" })), ["VALUE_CONTROL_CHAR"]);
  assert.deepEqual(failed(run("| a |\n|---|\n| {{x}} |\n", "md", {}, { x: "두\n줄" })), ["VALUE_CONTROL_CHAR"]);
});

test("T3: 빈 칸과 머리행 칸도 채운다(칸 수 유지). 빈 값은 칸을 비운다", () => {
  const text = "| 성명 | 값 |\n|---|---|\n| 연락처 |  |\n| 비고 | 메모 |\n| 끝 ||\n";
  const fill = (row: number, col: number, value: unknown) => out(text, "md", { anchors: [cellAnchor("c", 0, row, col)], rules: [fillRule("r", "c", value)] }, {});
  assert.equal(fill(1, 1, { text: "010-1" }), "| 성명 | 값 |\n|---|---|\n| 연락처 | 010-1 |\n| 비고 | 메모 |\n| 끝 ||\n");
  assert.equal(fill(3, 1, { text: "v" }), "| 성명 | 값 |\n|---|---|\n| 연락처 |  |\n| 비고 | 메모 |\n| 끝 | v |\n");
  assert.equal(fill(0, 0, { text: "이름" }), "| 이름 | 값 |\n|---|---|\n| 연락처 |  |\n| 비고 | 메모 |\n| 끝 ||\n");
  assert.equal(fill(2, 1, { text: "" }), "| 성명 | 값 |\n|---|---|\n| 연락처 |  |\n| 비고 |  |\n| 끝 ||\n");
  assert.equal(fill(1, 1, { text: "" }), text, "빈 칸에 빈 값이면 바꿀 것이 없다");
  for (const [row, col] of [[1, 1], [3, 1], [0, 0], [2, 1]] as const) assertColumns(fill(row, col, { text: "x|y" }), 2);
});

test("T3: 행 삭제 — 한 행, 이어진 행, 끝 행, 떨어진 행, 모든 데이터 행(머리행만 남는다). 열 수와 나머지 줄은 그대로", () => {
  const H = "| 구분 | 내용 | 비고 |\n|---|---|---|\n";
  const del = (...rows: number[]) => done(run(TABLE, "md", deleteRows(...rows), {}));
  assert.equal(del(2).output, `${H}| A | 가 | - |\n| C | 다 | - |\n`);
  assert.equal(del(1, 2).output, `${H}| C | 다 | - |\n`);
  assert.equal(del(2, 3).output, `${H}| A | 가 | - |\n`);
  assert.equal(del(1, 3).output, `${H}| B | 나 | - |\n`);
  assert.equal(del(3).output, `${H}| A | 가 | - |\n| B | 나 | - |\n`);
  assert.equal(del(1, 2, 3).output, H);
  for (const rows of [[2], [1, 2], [2, 3], [1, 3], [3], [1, 2, 3]]) assertColumns(del(...rows).output, 3);
  const r = del(2);
  assert.deepEqual(r.report.plan.expected, { tableRows: -1 });
  assert.deepEqual(r.report.plan.actions.map((a) => [a.ruleId, a.type, a.targets]), [["d2", "delete", 1]]);
  assertOnlyEditsChanged(TABLE, r.output, r.report.edits);
  assert.deepEqual(del(1, 2, 3).report.plan.expected, { tableRows: -3 });
});

test("T3: 행 삭제는 표 앞뒤와 줄바꿈 방식, 끝 줄바꿈 유무를 건드리지 않는다", () => {
  const del = (text: string, ...rows: number[]) => out(text, "md", deleteRows(...rows), {});
  assert.equal(del("| h |\n|---|\n| a |\n| b |", 2), "| h |\n|---|\n| a |");
  assert.equal(del("| h |\n|---|\n| a |\n| b |", 1), "| h |\n|---|\n| b |");
  assert.equal(del("T\n\n| h |\n|---|\n| a |\n| b |\n\n끝\n", 2), "T\n\n| h |\n|---|\n| a |\n\n끝\n");
  assert.equal(del("T\n\n| h |\n|---|\n| a |\n| b |\n\n끝\n", 1), "T\n\n| h |\n|---|\n| b |\n\n끝\n");
  assert.equal(del("| h |\r\n|---|\r\n| a |\r\n| b |\r\n", 1), "| h |\r\n|---|\r\n| b |\r\n");
  assert.equal(del("| h |\r\n|---|\r\n| a |\r\n| b |\r\n", 2), "| h |\r\n|---|\r\n| a |\r\n");
  assert.equal(del("| h |\r\n|---|\n| a |\r\n| b |\n", 2), "| h |\r\n|---|\n| a |\r\n", "지운 행은 자기 줄바꿈과 함께 지워지고 앞 행은 손대지 않는다");
  assert.equal(del("| h |\r\n|---|\n| a |\r\n| b |\n", 1), "| h |\r\n|---|\n| b |\n", "앞 행을 지우면 나머지 줄은 줄마다 원래 줄바꿈 그대로");
  // 두 번째 표의 행
  const two = "| h |\n|---|\n| a |\n\n| x |\n|---|\n| y |\n| z |\n";
  assert.equal(out(two, "md", { anchors: [cellAnchor("c", 1, 1, 0)], rules: [deleteRule("d", "c", undefined, "row")] }, {}), "| h |\n|---|\n| a |\n\n| x |\n|---|\n| z |\n");
});

test("T3: 머리행 삭제는 거부한다(FILL_TABLE_HEADER). 없는 행은 ANCHOR_NOT_FOUND", () => {
  assert.deepEqual(failed(run(TABLE, "md", deleteRows(0), {})), ["FILL_TABLE_HEADER"]);
  assert.deepEqual(failed(run(TABLE, "md", deleteRows(0, 2), {})), ["FILL_TABLE_HEADER"]);
  assert.deepEqual(failed(run(TABLE, "md", deleteRows(4), {})), ["ANCHOR_NOT_FOUND"]);
  // 조건이 거짓이면 머리행을 가리켜도 아무 일 없다
  const off = { anchors: [cellAnchor("h", 0, 0, 0)], rules: [deleteRule("d", "h", { path: "x", op: "exists" }, "row")] };
  assert.equal(out(TABLE, "md", off, {}), TABLE);
});

test("T3: 지워지는 행 안의 채움과 {{}}는 버리고(누락 오류 없음), 지워지는 표의 행 삭제도 버린다", () => {
  const text = "| h | v |\n|---|---|\n| a | {{q}} |\n| b | 2 |\n";
  const r = done(run(text, "md", deleteRows(1), {}));
  assert.equal(r.output, "| h | v |\n|---|---|\n| b | 2 |\n");
  assert.deepEqual(r.report.plan.dropped.map((d) => [d.ruleId, d.anchor]), [["implicit", "{{q}}"]]);

  const spec = {
    anchors: [cellAnchor("c", 0, 1, 1), cellAnchor("r", 0, 1, 0), { id: "t", kind: "object", objectType: "table", sectionIndex: 0, ordinal: 0 }],
    rules: [fillRule("f", "c", { text: "새 값" }), deleteRule("d", "r", undefined, "row")],
  };
  const both = done(run(text, "md", spec, {}));
  assert.equal(both.output, "| h | v |\n|---|---|\n| b | 2 |\n");
  assert.deepEqual(both.report.plan.dropped.map((d) => [d.ruleId, d.anchor]).sort(), [["f", "c"], ["implicit", "{{q}}"]]);

  const gone = { ...spec, rules: [...spec.rules, deleteRule("t", "t")] };
  const none = done(run(`${text}\n끝\n`, "md", gone, {}));
  assert.equal(none.output, "끝\n");
  assert.ok(none.report.plan.dropped.some((d) => d.ruleId === "d"));
  assert.deepEqual(none.report.plan.expected, { blocks: -1, tables: -1, tableRows: -3 });
});

test("T3: word 앵커가 표 안이면 칸 하나 안의 구간만 바꾸고, 칸 경계를 가로지르면 FILL_CROSSES_MARKUP으로 건너뛴다", () => {
  const text = "| h1 | h2 |\n|---|---|\n| 가나 | 다라 |\n";
  const logical = "| h1 | h2 |\n|---|---|\n| 가나 | 다라 |";
  const range = (from: string, to: string) => {
    const start = logical.indexOf(from);
    return [start, logical.indexOf(to) + to.length] as const;
  };
  const word = (a: readonly [number, number]) => ({ anchors: [wordAnchor("w", 0, logical, a[0], a[1])], rules: [fillRule("r", "w", { text: "x|y" })] });
  assert.equal(out(text, "md", word(range("가나", "가나")), {}), "| h1 | h2 |\n|---|---|\n| x\\|y | 다라 |\n");
  const crossing = done(run(text, "md", word(range("나 | 다", "나 | 다")), {}));
  assert.equal(crossing.output, text);
  assert.deepEqual(crossing.report.plan.skipped.map((s) => [s.ruleId, s.code]), [["r", "FILL_CROSSES_MARKUP"]]);
  assert.deepEqual(crossing.report.edits, []);
});

test("T3: 코드 블록·표는 line 앵커로 블록 글을 바꿀 수 없다(FILL_HAS_OBJECT). 삭제·삽입은 된다", () => {
  const text = "앞\n\n| a |\n|---|\n| 1 |\n\n```\n코드\n```\n";
  for (const [ordinal, logical] of [[1, "| a |\n|---|\n| 1 |"], [2, "```\n코드\n```"]] as const) {
    assert.deepEqual(failed(run(text, "md", { anchors: [lineAnchor("a", ordinal, logical)], rules: [fillRule("r", "a", { text: "x" })] }, {})), ["FILL_HAS_OBJECT"]);
  }
  assert.equal(out(text, "md", { anchors: [lineAnchor("a", 1, "| a |\n|---|\n| 1 |")], rules: [injectRule("r", "a", "after", fragmentOf("사이"))] }, {}), "앞\n\n| a |\n|---|\n| 1 |\n\n사이\n\n```\n코드\n```\n");
});

test("T3: 열 수 검사 — 원래 어긋난 표는 경고만(표를 고쳐도), 조각이 어긋난 표를 들여오면 VAL_TABLE_COLS 오류다", () => {
  const ragged = "| a | b |\n|---|---|\n| 1 |\n\n{{x}}\n";
  const plain = done(run(ragged, "md", {}, { x: 7 }));
  assert.equal(plain.output, "| a | b |\n|---|---|\n| 1 |\n\n7\n");
  assert.deepEqual(plain.report.issues.map((i) => [i.severity, i.code]), [["warning", "VAL_TABLE_COLS"]]);
  const edited = done(run(ragged, "md", { anchors: [cellAnchor("c", 0, 1, 0)], rules: [fillRule("r", "c", { text: "Z" })] }, { x: 7 }));
  assert.equal(edited.output, "| a | b |\n|---|---|\n| Z |\n\n7\n");
  assert.deepEqual(edited.report.issues.map((i) => [i.severity, i.code]), [["warning", "VAL_TABLE_COLS"]]);
  // 표 앞에 블록을 넣어 위치가 밀려도 같은 표로 본다
  const shifted = done(run(ragged, "md", { anchors: [lineAnchor("a", 0, "| a | b |\n|---|---|\n| 1 |")], rules: [injectRule("r", "a", "before", fragmentOf("앞 글"))] }, { x: 7 }));
  assert.deepEqual(shifted.report.issues.map((i) => [i.severity, i.code]), [["warning", "VAL_TABLE_COLS"]]);

  const ok = "| a | b |\n|---|---|\n| 1 | 2 |\n";
  const bad = run(ok, "md", { anchors: [lineAnchor("a", 0, "| a | b |\n|---|---|\n| 1 | 2 |")], rules: [injectRule("r", "a", "after", fragmentOf("| h | i |\n|---|---|\n| 하나뿐 |"))] }, {});
  assert.deepEqual(failed(bad), ["VAL_TABLE_COLS"]);
});

// ── T4: 줄바꿈·BOM·끝 줄바꿈 보존, 손대지 않은 블록은 문자 그대로 ───

const optionalOff = { path: "terms.optional", op: "eq", value: false };
const ACTIONS = {
  anchors: [
    lineAnchor("head", 3, "## 선택 조항"),
    lineAnchor("body", 4, "선택 조항 본문입니다. (해당 시)"),
    lineAnchor("period", 2, "기간: {{project.start}} ~ {{project.end}}"),
    cellAnchor("rowB", 0, 2, 0),
    cellAnchor("cellC", 0, 3, 1),
    lineAnchor("end", 7, "끝."),
  ],
  rules: [
    deleteRule("r1", "head", optionalOff),
    deleteRule("r2", "body", optionalOff),
    injectRule("r3", "period", "after", fragmentOf("### 용역 조항", "- {{owner.name}}가 수행한다.\n- 기간 내 완료"), { path: "contract.type", op: "eq", value: "용역" }),
    deleteRule("r4", "rowB", undefined, "row"),
    fillRule("r5", "cellC", { path: "table.a" }),
    insertRule("r6", "end", "after", { path: "memo" }, { path: "memo", op: "exists" }),
  ],
};
const ACTIONS_DATA = { ...NOTICE_DATA, terms: { optional: false }, contract: { type: "용역" }, memo: "추신 하나\n추신 둘" };
const ACTIONS_LF = [
  "# 알파 안내",
  "",
  "대상: 이서연 귀하",
  "",
  "기간: 2026-01-01 ~ 2026-12-31",
  "",
  "### 용역 조항",
  "",
  "- 김하늘가 수행한다.",
  "- 기간 내 완료",
  "",
  "| 구분 | 내용 | 비고 |",
  "|---|---|---|",
  "| A | 가 | - |",
  "| C | 가 | - |",
  "",
  "```text",
  "코드 안의 {{project.name}}는 그대로 둔다.",
  "",
  "두 번째 줄",
  "```",
  "",
  "끝.",
  "",
  "추신 하나",
  "",
  "추신 둘",
  "",
].join("\n");

const toCrlf = (s: string): string => s.replace(/\n/g, "\r\n");
const toMixed = (s: string): string => {
  let n = 0;
  return s.replace(/\n/g, () => (n++ % 2 === 0 ? "\r\n" : "\n"));
};

/** 입력 블록 가운데 편집 구간과 겹치지 않는 것은 원문 그대로(줄바꿈 포함) 출력에 같은 순서로 있어야 한다 */
function assertUntouchedBlocksVerbatim(input: string, kind: TextKind, output: string, edits: { start: number; end: number }[]): number {
  let pos = 0;
  let checked = 0;
  for (const b of parseText(input, kind).blocks) {
    if (edits.some((e) => e.start < b.end && b.start < e.end)) continue;
    const raw = input.slice(b.start, b.end);
    const at = output.indexOf(raw, pos);
    assert.ok(at >= 0, `손대지 않은 블록이 출력에 그대로 있어야 한다: ${JSON.stringify(raw.slice(0, 20))}`);
    pos = at + raw.length;
    checked++;
  }
  return checked;
}

test("T4: 한 템플릿(삭제·조각 주입·표 행 삭제·칸 채움·텍스트 삽입)의 결과 — LF", () => {
  const r = done(run(NOTICE, "md", ACTIONS, ACTIONS_DATA));
  assert.equal(r.output, ACTIONS_LF);
  assert.deepEqual(r.report.plan.inactiveRules, []);
  // 지운 블록 둘, 넣은 블록 넷(조각 둘 + 삽입 문단 둘), 지운 표 행 하나
  assert.deepEqual(r.report.plan.expected, { blocks: 2, tableRows: -1 });
  assertOnlyEditsChanged(NOTICE, r.output, r.report.edits);
});

test("T4: CRLF·BOM·끝 줄바꿈 없음·끝 줄바꿈 여럿에서도 같은 결과이고 새 줄은 문서의 줄바꿈 방식이다", () => {
  const variants: [string, string, string][] = [
    ["CRLF", toCrlf(NOTICE), toCrlf(ACTIONS_LF)],
    ["BOM+LF", `\uFEFF${NOTICE}`, `\uFEFF${ACTIONS_LF}`],
    ["BOM+CRLF", `\uFEFF${toCrlf(NOTICE)}`, `\uFEFF${toCrlf(ACTIONS_LF)}`],
    ["끝 줄바꿈 없음", NOTICE.slice(0, -1), ACTIONS_LF.slice(0, -1)],
    ["끝 줄바꿈 없음 CRLF", toCrlf(NOTICE).slice(0, -2), toCrlf(ACTIONS_LF).slice(0, -2)],
    ["끝 줄바꿈 여럿", `${NOTICE}\n\n`, `${ACTIONS_LF}\n\n`],
    ["끝 줄바꿈 여럿 CRLF", `${toCrlf(NOTICE)}\r\n\r\n`, `${toCrlf(ACTIONS_LF)}\r\n\r\n`],
  ];
  for (const [name, input, expected] of variants) {
    const r = done(run(input, "md", ACTIONS, ACTIONS_DATA));
    assert.equal(r.output, expected, name);
    assertOnlyEditsChanged(input, r.output, r.report.edits);
    assert.ok(assertUntouchedBlocksVerbatim(input, "md", r.output, r.report.edits) >= 2, name);
    assert.equal(r.output.startsWith("\uFEFF"), input.startsWith("\uFEFF"), `${name}: BOM`);
    assert.equal(r.output.lastIndexOf("\uFEFF") > 0, false, `${name}: BOM은 맨 앞 하나뿐`);
    if (input.includes("\r\n")) assert.ok(!/(?<!\r)\n/.test(r.output), `${name}: CRLF 문서에 LF 단독 줄바꿈이 생기면 안 된다`);
    else assert.ok(!r.output.includes("\r"), `${name}: LF 문서에 CR이 생기면 안 된다`);
    const tail = (s: string): string => /(?:\r\n|\n)*$/.exec(s)?.[0] ?? "";
    assert.equal(tail(r.output), tail(input), `${name}: 끝 줄바꿈의 수와 방식`);
  }
});

test("T4: 줄바꿈이 섞인 문서 — 손대지 않은 줄은 줄마다 원래 줄바꿈 그대로이고, 새 줄은 이웃 줄바꿈을 따른다", () => {
  const input = toMixed(NOTICE);
  assert.ok(input.includes("\r\n") && /(?<!\r)\n/.test(input));
  const r = done(run(input, "md", ACTIONS, ACTIONS_DATA));
  assertOnlyEditsChanged(input, r.output, r.report.edits);
  assert.ok(assertUntouchedBlocksVerbatim(input, "md", r.output, r.report.edits) >= 2);
  // 값·조각 글자만 빼고 보면 같은 글이다(줄바꿈 방식을 무시하고 견준다)
  assert.equal(r.output.replace(/\r\n/g, "\n"), ACTIONS_LF);
  // 편집 구간 앞의 첫 4줄은 입력과 바이트 동일하다
  const firstEdit = r.report.edits[0];
  assert.ok(firstEdit !== undefined);
  assert.equal(r.output.slice(0, firstEdit.start), input.slice(0, firstEdit.start));
});

test("T4: 편집이 없으면 출력이 입력과 같고 편집 구간도 없다(BOM·CRLF·섞임·끝 줄바꿈 없음 모두)", () => {
  // 조건이 거짓이고 {{}}는 모두 keep이라 편집이 없다
  const spec = { anchors: [lineAnchor("a", 0, "# {{project.name}} 안내")], rules: [deleteRule("d", "a", { path: "never", op: "exists" })] };
  for (const input of [NOTICE, toCrlf(NOTICE), `\uFEFF${toCrlf(NOTICE)}`, toMixed(NOTICE), NOTICE.slice(0, -1), `${NOTICE}\n\n\n`]) {
    const r = done(run(input, "md", spec, {}, { missing: "keep" }));
    assert.equal(r.output, input);
    assert.deepEqual(r.report.edits, []);
  }
  // 채울 자리가 없는 문서는 그대로
  for (const input of ["", "\n", "\uFEFF", "\uFEFF가\r\n나", "가\n\n\n나\n", "가\r\n나\r\n"]) {
    for (const kind of ["md", "txt"] as const) {
      const r = done(run(input, kind, {}, {}));
      assert.equal(r.output, input, `${kind}: ${JSON.stringify(input)}`);
      assert.deepEqual(r.report.edits, []);
    }
  }
});

test("T4: BOM — 맨 앞 블록을 지우거나 앞에 넣어도 BOM은 그대로 맨 앞이다", () => {
  const text = "\uFEFF# 제목\n\n본문\n";
  assert.equal(out(text, "md", { anchors: [lineAnchor("a", 0, "# 제목")], rules: [deleteRule("d", "a")] }, {}), "\uFEFF본문\n");
  assert.equal(out(text, "md", { anchors: [lineAnchor("a", 0, "# 제목")], rules: [injectRule("r", "a", "before", fragmentOf("앞"))] }, {}), "\uFEFF앞\n\n# 제목\n\n본문\n");
  assert.equal(out(text, "md", { anchors: [lineAnchor("a", 0, "# 제목")], rules: [fillRule("r", "a", { text: "새 제목" })] }, {}), "\uFEFF새 제목\n\n본문\n");
  assert.equal(out("\uFEFF가\r\n나\r\n", "txt", { anchors: [lineAnchor("a", 0, "가")], rules: [insertRule("r", "a", "before", { text: "머리" })] }, {}), "\uFEFF머리\r\n가\r\n나\r\n");
});

test("T4: txt — 줄마다 줄바꿈이 다른 문서도 지운 줄·넣은 줄 말고는 그대로", () => {
  const input = "가\r\n나\n다\r\n라\n마";
  const spec = { anchors: [lineAnchor("a", 1, "나"), lineAnchor("b", 3, "라")], rules: [deleteRule("d", "a"), injectRule("i", "b", "after", fragmentOf("끼움"))] };
  const r = done(run(input, "txt", spec, {}));
  assert.equal(r.output, "가\r\n다\r\n라\n끼움\n마");
  assertOnlyEditsChanged(input, r.output, r.report.edits);
});

test("T4: 같은 입력은 같은 출력·같은 보고서이고, 입력 템플릿·데이터는 바뀌지 않는다", () => {
  const template = tpl(ACTIONS);
  const dataset = ds(ACTIONS_DATA);
  const before = structuredClone({ template, dataset });
  const a = generateText(NOTICE, "md", template, dataset);
  const b = generateText(NOTICE, "md", template, dataset);
  assert.deepEqual(a, b);
  assert.deepEqual({ template, dataset }, before);
  assert.equal(done(a).output, ACTIONS_LF);
});

// ── T5: 코드 블록 안의 {{}} ────────────────────────────────────

const FENCED = ["{{x}} 밖", "", "```", "백틱 {{x}}", "```", "", "~~~", "물결 {{x}}", "~~~", "", "````", "```", "넷 {{x}}", "```", "````", "", "   ```", "들여쓴 {{x}}", "   ```", "", "끝 {{x}}", ""].join("\n");

test("T5: 코드 블록(``` · ~~~ · 더 긴 울타리 · 세 칸 이내 들여쓰기) 안의 {{}}는 기본으로 그대로 둔다", () => {
  const r = done(run(FENCED, "md", {}, { x: "7" }));
  assert.equal(
    r.output,
    ["7 밖", "", "```", "백틱 {{x}}", "```", "", "~~~", "물결 {{x}}", "~~~", "", "````", "```", "넷 {{x}}", "```", "````", "", "   ```", "들여쓴 {{x}}", "   ```", "", "끝 7", ""].join("\n"),
  );
  assert.deepEqual(r.report.plan.actions.map((a) => [a.anchor, a.targets]), [["{{x}}", 2]]);
  assert.deepEqual(r.report.issues, []);
  assertOnlyEditsChanged(FENCED, r.output, r.report.edits);
});

test("T5: 코드 블록 안에만 있는 {{}}는 데이터가 없어도 누락 오류가 아니다", () => {
  const text = "```\n{{q}}\n```\n\n~~~\n{{r.s}}\n~~~\n";
  const r = done(run(text, "md", {}, {}));
  assert.equal(r.output, text);
  assert.deepEqual(r.report.plan.missingPaths, []);
  assert.deepEqual(r.report.plan.requiredPaths, []);
});

test("T5: fillInCode: true면 코드 블록 안도 채운다(표 칸이 아니므로 |는 그대로)", () => {
  const r = done(run(FENCED, "md", {}, { x: "a|b" }, { fillInCode: true }));
  assert.equal(r.output, ["a|b 밖", "", "```", "백틱 a|b", "```", "", "~~~", "물결 a|b", "~~~", "", "````", "```", "넷 a|b", "```", "````", "", "   ```", "들여쓴 a|b", "   ```", "", "끝 a|b", ""].join("\n"));
  assert.deepEqual(r.report.plan.actions.map((a) => [a.anchor, a.targets]), [["{{x}}", 6]]);
  // 누락 정책도 코드 안 자리에 같게 적용된다
  assert.deepEqual(failed(run("```\n{{q}}\n```\n", "md", {}, {}, { fillInCode: true })), ["DATA_MISSING"]);
  assert.equal(out("```\n{{q}}\n```\n", "md", {}, {}, { fillInCode: true, missing: "keep" }), "```\n{{q}}\n```\n");
});

test("T5: 닫히지 않은 울타리는 문서 끝까지 코드(경고). 4칸 들여쓴 울타리와 txt는 코드가 아니다", () => {
  const open = done(run("앞 {{x}}\n\n```\n안 {{x}}\n\n뒤 {{x}}\n", "md", {}, { x: "1" }));
  assert.equal(open.output, "앞 1\n\n```\n안 {{x}}\n\n뒤 {{x}}\n");
  assert.deepEqual(open.report.issues.map((i) => [i.severity, i.code]), [["warning", "TEXT_FENCE_UNCLOSED"]]);
  assert.equal(out("    ```\n{{x}}\n    ```\n", "md", {}, { x: "1" }), "    ```\n1\n    ```\n");
  assert.equal(out("```\n{{x}}\n```\n", "txt", {}, { x: "1" }), "```\n1\n```\n", "txt에는 코드 블록이 없다");
});

test("T5: 명시한 word 앵커는 코드 블록 안 글도 바꾼다. 블록 글 전체(line)는 코드 블록이면 거절한다", () => {
  const text = "```\n값 XYZ 끝\n```\n";
  const logical = "```\n값 XYZ 끝\n```";
  const start = logical.indexOf("XYZ");
  assert.equal(out(text, "md", { anchors: [wordAnchor("w", 0, logical, start, start + 3)], rules: [fillRule("r", "w", { text: "ABC" })] }, {}), "```\n값 ABC 끝\n```\n");
  assert.deepEqual(failed(run(text, "md", { anchors: [lineAnchor("a", 0, logical)], rules: [fillRule("r", "a", { text: "x" })] }, {})), ["FILL_HAS_OBJECT"]);
});

// ── 조건 조합 ───────────────────────────────────────────────────

test("조건 조합: all·any·not를 섞은 다중 조건으로 삭제·주입·행 삭제·칸 채움·텍스트 삽입을 한 템플릿에서 고른다", () => {
  const all = (...c: unknown[]) => ({ all: c });
  const spec = {
    anchors: ACTIONS.anchors,
    rules: [
      deleteRule("r1", "head", all(optionalOff, { not: { path: "contract.type", op: "eq", value: "물품" } })),
      deleteRule("r2", "body", all(optionalOff, { not: { path: "contract.type", op: "eq", value: "물품" } })),
      injectRule("r3", "period", "after", fragmentOf("### 용역 조항", "- {{owner.name}}가 수행한다.\n- 기간 내 완료"), {
        any: [{ path: "contract.type", op: "in", value: ["용역", "공사"] }, { path: "force", op: "exists" }],
      }),
      deleteRule("r4", "rowB", { not: { path: "table.keepB", op: "exists" } }, "row"),
      fillRule("r5", "cellC", { path: "table.a" }),
      insertRule("r6", "end", "after", { path: "memo" }, { path: "memo", op: "lengthGt", value: 0 }),
    ],
  };
  const a = done(run(NOTICE, "md", spec, ACTIONS_DATA));
  assert.equal(a.output, ACTIONS_LF);
  assert.deepEqual(a.report.plan.inactiveRules, []);

  // 전부 거짓: 칸 채움(조건 없음)만 일어난다
  const none = done(run(NOTICE, "md", spec, { ...NOTICE_DATA, terms: { optional: true }, contract: { type: "물품" }, table: { a: "가", b: "나", keepB: true } }));
  assert.deepEqual(none.report.plan.inactiveRules, ["r1", "r2", "r3", "r4", "r6"]);
  assert.ok(none.output.includes("| B | 나 | - |\n| C | 가 | - |\n"));
  assert.ok(none.output.includes("## 선택 조항\n\n선택 조항 본문입니다. (해당 시)"));
  assert.ok(!none.output.includes("용역"));
  assert.ok(none.output.endsWith("끝.\n"));

  // 일부만 참: 물품 계약이면 선택 조항을 지우지 않고, 별도 force가 있으면 조각이 들어간다
  const mid = done(run(NOTICE, "md", spec, { ...ACTIONS_DATA, contract: { type: "물품" }, force: true, memo: "" }));
  assert.deepEqual(mid.report.plan.inactiveRules, ["r1", "r2", "r6"]);
  assert.ok(mid.output.includes("### 용역 조항"));
  assert.ok(mid.output.includes("## 선택 조항"));
  assert.ok(!mid.output.includes("| B |"));
  assert.ok(mid.output.endsWith("끝.\n"));
});

// ── 출력 검사 ───────────────────────────────────────────────────

test("검사: 편집 구간 밖을 바꾼 출력은 PRESERVE_SPAN으로 막고 출력이 없다(적용 직후 변조)", () => {
  const hook = (change: (o: string) => string) => run("가 {{x}}\n나\n", "txt", {}, { x: "1" }, { testHooks: { afterApply: change } });
  assert.deepEqual(failed(hook((o) => o.replace("나", "다"))), ["PRESERVE_SPAN"]);
  assert.deepEqual(failed(hook((o) => o.replace("가 1", "가 2"))), ["PRESERVE_SPAN"]);
  assert.deepEqual(failed(hook((o) => `${o}덧붙임`)), ["PRESERVE_SPAN"]);
  assert.deepEqual(failed(hook((o) => o.replace(/\n/g, "\r\n"))), ["PRESERVE_SPAN"]);
  assert.equal(done(hook((o) => o)).output, "가 1\n나\n");
});

test("검사: 출력 검사를 직접 부른다 — 수량(PRESERVE_CENSUS), 남은 {{}}(REREAD_TEXT), 표 열 수(VAL_TABLE_COLS), 인코딩(VAL_ENCODING)", () => {
  const zero = { blocks: 0, tables: 0, code: 0, tableRows: 0 };
  const plan = (edits: TextPlan["edits"], leaves: number[] = [], delta = zero): TextPlan => ({ edits, delta, leaves });
  const codes = (doc: TextDoc, p: TextPlan, output: string, fillInCode = false) => checkTextOutput(doc, p, output, fillInCode).issues.map((i) => `${i.severity}:${i.code}`);

  // 수량: 계획이 블록을 하나 더하는데 예고는 0
  const txt = parseText("a\nb\n", "txt");
  const insert = { start: 3, end: 3, replacement: "\nc", label: "삽입" };
  assert.deepEqual(codes(txt, plan([insert]), "a\nb\nc\n"), ["error:PRESERVE_CENSUS"]);
  assert.deepEqual(codes(txt, plan([insert], [], { ...zero, blocks: 1 }), "a\nb\nc\n"), []);

  // 남은 {{}}: 계획이 아무것도 안 했는데 출력에 {{}}가 있다
  const left = parseText("a {{x}}\n", "txt");
  assert.deepEqual(codes(left, plan([]), "a {{x}}\n"), ["error:REREAD_TEXT"]);
  assert.deepEqual(codes(left, plan([], [2]), "a {{x}}\n"), [], "일부러 남긴 자리");
  const fenced = parseText("```\n{{x}}\n```\n", "md");
  assert.deepEqual(codes(fenced, plan([]), "```\n{{x}}\n```\n"), [], "코드 블록 안은 세지 않는다");
  assert.deepEqual(codes(fenced, plan([]), "```\n{{x}}\n```\n", true), ["error:REREAD_TEXT"]);
  // 편집이 넣은 글(값) 안의 {{}}는 세지 않는다. 앞쪽 편집으로 밀린 자리도 일부러 남긴 자리로 알아본다
  const shifted = parseText("가 {{x}} 나 {{y}}\n", "txt");
  const first = { start: 0, end: 1, replacement: "가나다라", label: "채움" };
  assert.deepEqual(codes(shifted, plan([first], [shifted.source.indexOf("{{y}}")]), "가나다라 {{x}} 나 {{y}}\n"), ["error:REREAD_TEXT"], "{{x}}는 남으면 안 된다");
  assert.deepEqual(codes(shifted, plan([{ start: 2, end: 7, replacement: "{{z}}", label: "채움" }], [shifted.source.indexOf("{{y}}")]), "가 {{z}} 나 {{y}}\n"), []);

  // 표 열 수: 계획이 행을 같은 수의 행 그대로 두면서 칸을 하나 줄였다
  const table = parseText("| a | b |\n|---|---|\n| 1 | 2 |\n", "md");
  const cut = { start: 20, end: 29, replacement: "| 1 |", label: "칸 줄임" };
  assert.equal(table.source.slice(cut.start, cut.end), "| 1 | 2 |");
  assert.deepEqual(codes(table, plan([cut]), "| a | b |\n|---|---|\n| 1 |\n"), ["error:VAL_TABLE_COLS"]);
  const old = parseText("| a | b |\n|---|---|\n| 1 |\n", "md");
  assert.deepEqual(codes(old, plan([]), old.source), ["warning:VAL_TABLE_COLS"]);

  // 인코딩
  const lone = { start: 0, end: 0, replacement: "\ud800", label: "깨진 글" };
  assert.deepEqual(codes(txt, plan([lone]), "\ud800a\nb\n"), ["error:VAL_ENCODING"]);
});

test("검사: 조각이 열어 둔 코드 울타리가 뒤 블록을 삼키면 PRESERVE_CENSUS로 막는다", () => {
  const spec = { anchors: [lineAnchor("a", 0, "A")], rules: [injectRule("r", "a", "after", fragmentOf("```js"))] };
  assert.deepEqual(failed(run("A\n\nB\n", "md", spec, {})), ["PRESERVE_CENSUS"]);
  // 같은 줄이 txt에서는 그냥 줄이다
  assert.equal(out("A\nB\n", "txt", spec, {}), "A\n```js\nB\n");
});

test("검사: 짝 없는 서로게이트를 낳는 word 구간은 VAL_ENCODING으로 막는다", () => {
  const text = "😀 이모지\n";
  const half = { id: "w", kind: "word", at: { sectionIndex: 0, path: [0] }, start: 0, end: 1, print: { text: "\ud83d", before: "", after: "\ude00 이모지" } };
  assert.deepEqual(failed(run(text, "txt", { anchors: [half], rules: [fillRule("r", "w", { text: "x" })] }, {})), ["VAL_ENCODING"]);
});

test("모의 실행: 계획까지만 만들고 출력이 없다. 오류가 있으면 모의 실행도 실패한다", () => {
  const dry = run(NOTICE, "md", ACTIONS, ACTIONS_DATA, { dryRun: true });
  assert.ok(dry.ok && dry.dryRun);
  assert.ok(!("output" in dry));
  const real = done(run(NOTICE, "md", ACTIONS, ACTIONS_DATA));
  assert.deepEqual(dry.report.plan, real.report.plan);
  assert.deepEqual(dry.report.edits, real.report.edits);
  assert.equal(dry.report.dryRun, true);
  assert.equal(real.report.dryRun, false);
  const missing = failed(run(NOTICE, "md", ACTIONS, {}, { dryRun: true }));
  assert.ok(missing.length > 0 && missing.every((c) => c === "DATA_MISSING"));
});

// ── 규모 ────────────────────────────────────────────────────────

/** 블록 n개짜리 md: 문단({{}} 둘), 열 번째마다 표, 스무 번째마다 지울 문단과 텍스트 삽입 앵커 */
function bigDoc(n: number): { text: string; spec: { anchors: unknown[]; rules: unknown[] }; deleted: number; inserted: number } {
  const blocks: string[] = [];
  const anchors: unknown[] = [];
  const rules: unknown[] = [];
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < n; i++) {
    if (i % 10 === 9) {
      blocks.push(`| 번호 | 값 |\n|---|---|\n| ${i} | {{v.x}} |`);
    } else {
      const text = `항목 ${i}: {{v.x}} 와 {{v.y}}`;
      blocks.push(text);
      if (i % 20 === 5) {
        anchors.push(lineAnchor(`d${i}`, i, text));
        rules.push(deleteRule(`rd${i}`, `d${i}`));
        deleted++;
      } else if (i % 20 === 7) {
        anchors.push(lineAnchor(`t${i}`, i, text));
        rules.push(insertRule(`rt${i}`, `t${i}`, "after", { text: `삽입 ${i}\n둘째` }));
        inserted += 2;
      }
    }
  }
  return { text: `${blocks.join("\n\n")}\n`, spec: { anchors, rules }, deleted, inserted };
}

test("규모: 블록 수천 개에서 시간이 블록 수에 대략 비례한다(제곱이 아니다)", () => {
  const best = (n: number): number => {
    const { text, spec } = bigDoc(n);
    const template = tpl(spec);
    const dataset = ds({ v: { x: "값", y: "또" } });
    let min = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const r = generateText(text, "md", template, dataset);
      min = Math.min(min, performance.now() - t0);
      assert.ok(r.ok, JSON.stringify(r.report.issues.slice(0, 2)));
    }
    return min;
  };
  best(1000); // 예열
  const small = best(3000);
  const large = best(12000);
  // 블록 수가 4배: 비례하면 4배 안팎, 제곱이면 16배. 잡음을 넉넉히 봐서 10배 미만을 요구한다.
  assert.ok(large < Math.max(small * 10, 50), `3000블록 ${small.toFixed(1)}ms, 12000블록 ${large.toFixed(1)}ms: 비례가 아니다`);
});

test("규모: 큰 문서의 결과가 맞다(채움·삭제·삽입·표 칸 수량)", () => {
  const n = 2000;
  const { text, spec, deleted, inserted } = bigDoc(n);
  const r = done(run(text, "md", spec, { v: { x: "X|1", y: "Y" } }));
  const doc = parseText(r.output, "md");
  assert.equal(doc.blocks.length, n - deleted + inserted);
  assert.deepEqual(r.report.plan.expected, { blocks: inserted - deleted });
  assert.ok(!/\{\{/.test(r.output));
  assert.ok(r.output.startsWith("항목 0: X|1 와 Y\n\n항목 1: X|1 와 Y\n\n"));
  assert.ok(r.output.includes("| 9 | X\\|1 |"));
  assert.ok(!r.output.includes("항목 5:"), "5번째(지움)");
  assert.ok(r.output.includes("항목 7: X|1 와 Y\n\n삽입 7\n\n둘째\n\n항목 8:"));
  assertOnlyEditsChanged(text, r.output, r.report.edits);
  assert.ok(r.report.edits.length > 2000);
});

test("경고: 닫히지 않은 코드 울타리 경고는 보고서에 남고 생성은 계속된다", () => {
  const r = done(run("```\n끝나지 않음\n", "md", {}, {}));
  assert.equal(r.output, "```\n끝나지 않음\n");
  assert.deepEqual(r.report.issues.map((i) => i.code), ["TEXT_FENCE_UNCLOSED"]);
});

test("검사: md 문단이 {{}} 하나뿐이고 값이 비면 블록이 없어지고(예고 -1), 여러 줄 문단의 한 줄이 비면 둘로 나뉜다(예고 +1). txt는 그대로", () => {
  const empty = { missing: "empty" } as const;
  const gone = done(run("A\n\n{{x}}\n\nB\n", "md", {}, {}, empty));
  assert.equal(gone.output, "A\n\n\n\nB\n");
  assert.deepEqual(gone.report.plan.expected, { blocks: -1 });
  // 줄 앵커로 빈 값을 채워도 같다. 공백뿐인 값도 같다
  const viaLine = done(run("A\n\n글\n\nB\n", "md", { anchors: [lineAnchor("a", 1, "글")], rules: [fillRule("r", "a", { text: "" })] }, {}));
  assert.equal(viaLine.output, "A\n\n\n\nB\n");
  assert.deepEqual(viaLine.report.plan.expected, { blocks: -1 });
  assert.equal(done(run("A\n\n{{x}}\n\nB\n", "md", {}, { x: "  " })).output, "A\n\n  \n\nB\n");

  const split = done(run("A\n{{x}}\nB\n", "md", {}, {}, empty));
  assert.equal(split.output, "A\n\nB\n");
  assert.deepEqual(split.report.plan.expected, { blocks: 1 });
  // 첫 줄이나 끝 줄이 비면 블록 수는 그대로다
  const head = done(run("{{x}}\nB\n", "md", {}, {}, empty));
  assert.equal(head.output, "\nB\n");
  assert.deepEqual(head.report.plan.expected, {});

  const txt = done(run("a\n{{x}}\nb\n", "txt", {}, {}, empty));
  assert.equal(txt.output, "a\n\nb\n");
  assert.deepEqual(txt.report.plan.expected, {});
  assertOnlyEditsChanged("A\n{{x}}\nB\n", split.output, split.report.edits);
});

test("검사: 값이 코드 울타리를 여는 글이면 뒤 블록을 삼키므로 PRESERVE_CENSUS로 막는다", () => {
  assert.deepEqual(failed(run("A\n\n{{x}}\n\nB\n", "md", {}, { x: "```" })), ["PRESERVE_CENSUS"]);
  assert.equal(done(run("A\n\n{{x}}\n\nB\n", "txt", {}, { x: "```" })).output, "A\n\n```\n\nB\n");
});

test("검사: txt 줄바꿈 없는 끝 줄이 {{}} 하나뿐이고 값이 비면 그 줄은 없어진다(예고 -1). 끝 줄 삭제는 비는 앞 줄을 지우지 않는다", () => {
  const empty = { missing: "empty" } as const;
  const gone = done(run("가\n{{x}}", "txt", {}, {}, empty));
  assert.equal(gone.output, "가\n");
  assert.deepEqual(gone.report.plan.expected, { blocks: -1 });
  // 끝 줄바꿈이 있으면 빈 줄로 남는다
  assert.equal(out("가\n{{x}}\n", "txt", {}, {}, empty), "가\n\n");
  // 이 줄 뒤에 줄을 넣으면 줄이 남는다
  const after = { anchors: [lineAnchor("a", 1, "{{x}}")], rules: [injectRule("r", "a", "after", fragmentOf("뒤"))] };
  assert.equal(out("가\n{{x}}", "txt", after, {}, empty), "가\n\n뒤");
  // 끝 줄 삭제: 앞 줄이 채우면 비는 줄이어도 그 줄은 남는다(줄바꿈을 지우지 않는다). 앞 줄에 글이 있으면 끝 줄바꿈 없음을 지킨다
  const dropLast = { anchors: [lineAnchor("a", 2, "끝")], rules: [deleteRule("d", "a")] };
  assert.equal(out("가\n{{x}}\n끝", "txt", dropLast, {}, empty), "가\n\n");
  assert.equal(out("가\n나\n끝", "txt", dropLast, {}), "가\n나");
});
