// E6 누름틀 승격(compile)과 G6 후보 자리(findCandidates).
// 한컴에서 열리는지는 이 테스트가 확인하지 못한다(미검증): 구성이 한컴이 만든 누름틀과 같은지만 견준다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listFields, readArchive, readEntry, validateDocument } from "../src/index.ts";
import { compileDocument, findCandidates, generate, planCompile, resolveAnchors, type Candidate } from "../src/fill/index.ts";
import { emptyTemplate, readDataset, readTemplate } from "../src/template/index.ts";
import { buildHwpx, bytesEqual, duplicates, instIdsIn, objectIdsIn, readFixture, reparse } from "./helpers.ts";

const SEC = "Contents/section0.xml";
const text = (bytes: Uint8Array): string => new TextDecoder().decode(readEntry(readArchive(bytes), bytes, SEC));
const tpl = (spec: { anchors?: unknown[]; rules?: unknown[] }) => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });

function ok(bytes: Uint8Array, options?: Parameters<typeof compileDocument>[1]): { output: Uint8Array; promoted: number; issues: { code: string }[] } {
  const r = compileDocument(bytes, options);
  assert.ok(r.ok, `승격이 실패했다: ${JSON.stringify(r.report.issues)}`);
  return { output: r.output, promoted: r.report.promoted, issues: r.report.issues };
}

// ── E6 ─────────────────────────────────────────────────────────

test("E6: {{}}를 누름틀로 승격한다 — 이름은 경로, 글은 그대로, dirty=1, simple, 수량 +승격 수, 검사 통과", () => {
  const bytes = readFixture("hancom/ph-single");
  const r = ok(bytes);
  assert.equal(r.promoted, 3);
  const fields = listFields(reparse(r.output));
  assert.deepEqual(
    fields.map((f) => [f.name, f.valueText, f.dirty, f.shape, f.type]),
    [
      ["project.name", "{{project.name}}", "1", "simple", "CLICK_HERE"],
      ["project.start", "{{project.start}}", "1", "simple", "CLICK_HERE"],
      ["project.end", "{{project.end}}", "1", "simple", "CLICK_HERE"],
    ],
  );
  // 글 자체는 그대로: 누름틀 표식을 빼면 문단 글이 원본과 같다
  const out = reparse(r.output);
  assert.deepEqual(out.sections[0]?.paragraphs.map((p) => p.logicalText.replace(/￼/g, "")), reparse(bytes).sections[0]?.paragraphs.map((p) => p.logicalText.replace(/￼/g, "")));
  const before = validateDocument(bytes);
  const after = validateDocument(r.output);
  assert.equal(after.errors.length, 0);
  assert.equal(after.census.fieldPairs, before.census.fieldPairs + 3);
  assert.equal(after.census.paragraphs, before.census.paragraphs);
  // 시작 id는 겹치지 않고 끝의 beginIDRef가 짝을 이룬다
  const xml = text(r.output);
  const begins = [...xml.matchAll(/<hp:fieldBegin id="(\d+)"/g)].map((m) => m[1] ?? "");
  const ends = [...xml.matchAll(/<hp:fieldEnd beginIDRef="(\d+)"/g)].map((m) => m[1] ?? "");
  assert.deepEqual(begins, ends);
  assert.deepEqual(duplicates([...begins, ...objectIdsIn(xml), ...instIdsIn(xml)]), []);
});

test("E6: 만든 원문은 한컴이 만든 누름틀(hancom/field-states)의 요소·속성 구성과 같다", () => {
  const norm = (s: string): string => s.replace(/="[^"]*"/g, '=""').replace(/>[^<]+</g, "><");
  const ctrlOf = (xml: string, tag: string): string => xml.match(new RegExp(`<hp:ctrl><hp:${tag} [\\s\\S]*?</hp:ctrl>`))?.[0] ?? "";
  const hancom = text(readFixture("hancom/field-states"));
  const ours = text(ok(readFixture("hancom/ph-single")).output);
  assert.equal(norm(ctrlOf(ours, "fieldBegin")), norm(ctrlOf(hancom, "fieldBegin")));
  assert.equal(norm(ctrlOf(ours, "fieldEnd")), norm(ctrlOf(hancom, "fieldEnd")));
  assert.ok(ctrlOf(hancom, "fieldBegin").length > 100 && ctrlOf(ours, "fieldBegin").length > 100);
  // 속성 값: 한컴이 만든 것과 같은 고정값
  assert.match(ours, /<hp:fieldBegin id="\d+" type="CLICK_HERE" name="project\.name" editable="1" dirty="1" zorder="-1" fieldid="627272811" metaTag="">/);
  // Command의 길이 표기는 한컴 저장본에서 관측한 규칙(Direction 뒤 두 항목의 길이 합)과 같다
  const command = (xml: string): string => xml.match(/name="Command" xml:space="preserve">([^<]*)</)?.[1] ?? "";
  for (const xml of [hancom, ours]) {
    const m = /^Clickhere:set:(\d+):(.*)$/s.exec(command(xml));
    assert.ok(m !== null);
    assert.equal(Number(m[1]), (m[2] ?? "").length - 1);
  }
});

test("E6: 승격한 문서에 누름틀 이름으로 값을 채우고, 글 안 {{}}도 같은 데이터로 채워진다", () => {
  const compiled = ok(readFixture("hancom/ph-single")).output;
  const t = tpl({
    anchors: [{ id: "a", kind: "field", name: "project.name" }],
    rules: [{ id: "r", do: { type: "fill", anchor: "a", value: { text: "알파" } } }],
  });
  const r = generate(compiled, t, readDataset({}), { missing: "keep" });
  assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues));
  if (r.ok && !r.dryRun) {
    assert.deepEqual(listFields(reparse(r.output)).map((f) => f.valueText), ["알파", "{{project.start}}", "{{project.end}}"]);
  }
  // 템플릿 없이 {{}}만으로도 채워진다(누름틀의 값이 갱신된다)
  const g = generate(compiled, emptyTemplate(), readDataset({ project: { name: "A", start: "B", end: "C" } }));
  assert.ok(g.ok && !g.dryRun);
  if (g.ok && !g.dryRun) assert.deepEqual(listFields(reparse(g.output)).map((f) => [f.valueText, f.dirty]), [["A", "1"], ["B", "1"], ["C", "1"]]);
});

test("E6: 한 덩어리가 아닌 자리는 승격하지 않고 COMPILE_SKIPPED로 보고한다. 표 셀 안 {{}}는 승격한다. 두 번 승격해도 더 바뀌지 않는다", () => {
  const mixed = ok(readFixture("hancom/ph-mixed"));
  assert.equal(mixed.promoted, 3);
  assert.deepEqual(mixed.issues.map((i) => i.code), ["COMPILE_SKIPPED"]);
  assert.deepEqual(listFields(reparse(mixed.output)).map((f) => f.name), ["company.name", "manager.name", "manager.phone"]);

  const table = ok(readFixture("hancom/ph-table"));
  assert.equal(table.promoted, 2);
  assert.deepEqual(listFields(reparse(table.output)).map((f) => [f.name, f.path.join(".")]), [["applicant.name", "1.1.0"], ["note", "1.5.0"]]);

  const again = compileDocument(table.output);
  assert.ok(again.ok);
  if (again.ok) {
    assert.equal(again.report.promoted, 0);
    assert.ok(bytesEqual(again.output, table.output));
    assert.deepEqual(again.report.issues.map((i) => i.code), ["COMPILE_SKIPPED", "COMPILE_SKIPPED"]);
  }
});

test("E6: 지정한 구간(word 앵커)도 이름을 붙여 승격한다. 잘못된 구간은 경고하고 건너뛴다", () => {
  const bytes = readFixture("hancom/blocks");
  const r = ok(bytes, { anchors: [{ sectionIndex: 0, path: [1], start: 0, end: 2, name: "제목" }, { sectionIndex: 0, path: [99], start: 0, end: 1, name: "없음" }] });
  assert.equal(r.promoted, 1);
  assert.deepEqual(r.issues.map((i) => i.code), ["COMPILE_SKIPPED"]);
  assert.deepEqual(listFields(reparse(r.output)).map((f) => [f.name, f.valueText, f.dirty, f.shape]), [["제목", "개요", "1", "simple"]]);
  assert.equal(reparse(r.output).sections[0]?.paragraphs[1]?.logicalText.replace(/￼/g, ""), "개요 본문입니다.");
  // 계획만 만들 때: 편집은 구간마다 둘(앞뒤)이고 편집 계획의 요약에 승격 수가 있다
  const plan = planCompile(reparse(bytes), [{ sectionIndex: 0, path: [1], start: 0, end: 2, name: "제목" }]);
  assert.equal(plan.edits.length, 2);
  assert.equal(plan.summary["promotedFields"], 1);
});

test("E6: 엄격 방식(strict)에서는 원래 오류가 있는 문서의 승격을 막고, 기준선 방식은 통과시킨다", () => {
  const ph = readFixture("extra/features-picture");
  // 이 문서에는 {{}}가 없어 승격할 것이 없다: 편집이 없어 입력과 같다
  const r = ok(ph);
  assert.equal(r.promoted, 0);
  assert.ok(bytesEqual(r.output, ph));
  const strict = compileDocument(ph, { mode: "strict" });
  assert.equal(strict.ok, false);
});

// ── G6: 후보 자리 ──────────────────────────────────────────────

const kinds = (c: Candidate[]): string[] => c.map((x) => x.kind);

test("G6: 누름틀·{{}}·빈 값 셀이 후보 목록에 나온다(시험 문서)", () => {
  const states = findCandidates(reparse(readFixture("hancom/field-states")));
  assert.deepEqual(kinds(states), ["field", "field", "field"]);
  assert.deepEqual(states.map((c) => c.anchor), [
    { kind: "field", name: "성명", occurrence: 0 },
    { kind: "field", name: "소속", occurrence: 0 },
    { kind: "field", name: "성명", occurrence: 1 },
  ]);
  assert.ok(states[0]?.evidence.includes("안내문 상태") && states[1]?.evidence.includes("값이 있음"));

  const single = findCandidates(reparse(readFixture("hancom/ph-single")));
  assert.deepEqual(kinds(single), ["placeholder", "placeholder", "placeholder"]);
  assert.deepEqual(single.map((c) => (c.anchor.kind === "word" ? c.anchor.print.text : "")), ["{{project.name}}", "{{project.start}}", "{{project.end}}"]);

  const table = findCandidates(reparse(readFixture("hancom/ph-table")));
  assert.deepEqual(kinds(table), ["placeholder", "emptyCell", "placeholder"]);
  const empty = table.find((c) => c.kind === "emptyCell");
  assert.deepEqual(empty?.anchor, { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 1 });
  assert.ok(empty?.evidence.includes("연락처") && empty.evidence.includes("비어 있음"));

  // 내용이 있는 표·문단뿐인 문서에는 후보가 없다
  assert.deepEqual(findCandidates(reparse(readFixture("hancom/blocks"))), []);
  assert.deepEqual(findCandidates(reparse(readFixture("hancom-merged"))).map((c) => c.kind).filter((k) => k !== "emptyCell" && k !== "blankMark" && k !== "labelColon"), []);
});

test("G6: 후보의 앵커 초안은 그대로 앵커가 되어 문서에서 같은 자리로 풀린다", () => {
  for (const name of ["hancom/field-states", "hancom/ph-single", "hancom/ph-table"]) {
    const doc = reparse(readFixture(name));
    const candidates = findCandidates(doc);
    const template = tpl({ anchors: candidates.map((c, i) => ({ id: `c${i}`, ...c.anchor })) });
    const { anchors, issues } = resolveAnchors(doc, template);
    assert.deepEqual(issues, [], name);
    assert.equal(anchors.size, candidates.length, name);
    for (const [i, c] of candidates.entries()) {
      const a = anchors.get(`c${i}`);
      assert.equal(a?.kind, c.anchor.kind);
      if (a?.kind === "word") assert.equal(a.relocated, false);
    }
  }
});

test("G6: 빈칸 표시·라벨: 뒤가 빈 경우·밑줄 셀을 찾고, 문장 끝맺음과 내용이 있는 오른쪽 셀은 후보가 아니다", () => {
  const p = (t: string): string => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p>`;
  const cell = (row: number, col: number, t: string): string =>
    `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${p(t)}</hp:subList><hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`;
  const table =
    `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl id="1001" rowCnt="3" colCnt="2" cellSpacing="0" borderFillIDRef="1">` +
    `<hp:tr>${cell(0, 0, "이름")}${cell(0, 1, "___")}</hp:tr>` +
    `<hp:tr>${cell(1, 0, "동의합니다.")}${cell(1, 1, "")}</hp:tr>` +
    `<hp:tr>${cell(2, 0, "주소")}${cell(2, 1, "서울")}</hp:tr>` +
    `</hp:tbl></hp:run></hp:p>`;
  const bytes = buildHwpx([[p("성명:"), p("서명 (   ) 또는 ____"), p("□ 동의함"), p("결론은 다음과 같다:"), p("일반 문장입니다."), table].join("")]);
  const found = findCandidates(reparse(bytes));
  assert.deepEqual(
    found.map((c) => [c.kind, c.at.path.join(".")]),
    [["labelColon", "0"], ["blankMark", "1"], ["blankMark", "1"], ["blankMark", "2"], ["blankMark", "5.1.0"], ["emptyCell", "5.1.0"]],
  );
  assert.ok(found[0]?.evidence.includes("성명:"));
  const marks = found.filter((c) => c.kind === "blankMark" && c.at.path.length === 1).map((c) => (c.anchor.kind === "word" ? c.anchor.print.text : ""));
  assert.deepEqual(marks, ["(   )", "____", "□"]);
  // 라벨 오른쪽이 밑줄뿐인 셀만 후보다(문장 끝맺음 라벨·내용이 있는 셀은 제외)
  const cells = found.filter((c) => c.kind === "emptyCell");
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0]?.anchor, { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 0, col: 1 });
  assert.ok(cells[0]?.evidence.includes("밑줄·괄호뿐"));
});
