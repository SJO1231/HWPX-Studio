// compile --merge-fields(이슈 #18): 메일 머지 필드(MAILMERGE)를 한컴 메일 머지 없이 쓰는 꼴로 바꾼다.
//  - `to-placeholder`: 필드 표식과 표시 글을 지우고 그 자리에 `{{키}}` 글을 둔다(문단·표 구조·글자모양 run은 그대로).
//  - `to-field`: 필드 표식을 누름틀(CLICK_HERE, 이름 = 키)로 고쳐 쓴다. 표시 글은 그대로이고 dirty는 "1"이다.
//  - 키가 데이터 경로 꼴이 아니거나 채울 수 없는 모양(여러 문단에 걸친 필드는 to-placeholder에서 제외)이면 바꾸지 않고 COMPILE_SKIPPED 경고를 낸다. 키 없는 메일 머지 필드는 건드리지 않는다.
//  - 바꾼 문서를 채우면(엔진) 원본 서식을 바로 채운 것과 같은 글이 나온다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { censusOfDoc, compileDocument, emptyTemplate, findPlaceholders, generate, isTableNode, listFields, readDataset, validateDocument, walkParagraphs, type HwpxDocument } from "../src/index.ts";
import { buildHwpx, mutateEntryText, newErrorsAfter, readFixture, reparse } from "./helpers.ts";

const SEC = "Contents/section0.xml";
const OBJ = "￼";
const FIXTURE = readFixture("merge/merge-fields");
const plain = (s: string): string => s.replaceAll(OBJ, "");
const allParagraphs = (doc: HwpxDocument) => doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)]);
const texts = (doc: HwpxDocument): string[] => allParagraphs(doc).map((p) => plain(p.logicalText));
const sectionOf = (bytes: Uint8Array): string => {
  let text = "";
  mutateEntryText(bytes, SEC, (x) => ((text = x), x + " "));
  return text;
};

type Compiled = Extract<ReturnType<typeof compileDocument>, { ok: true }>;
const compiled = (bytes: Uint8Array, mode?: "to-placeholder" | "to-field"): Compiled => {
  const r = compileDocument(bytes, mode === undefined ? {} : { mergeFields: mode });
  assert.ok(r.ok, `승격이 실패했다: ${JSON.stringify(r.report.issues.map((i) => [i.severity, i.code, i.message]))}`);
  return r as Compiled;
};

const BEFORE = listFields(reparse(FIXTURE));
const PATH_KEY = /^[\p{L}\p{N}_-]+$/u;
const pathKeyed = BEFORE.filter((f) => f.type === "MAILMERGE" && PATH_KEY.test(f.mergeKey ?? ""));
const nonPath = BEFORE.filter((f) => f.type === "MAILMERGE" && !PATH_KEY.test(f.mergeKey ?? ""));

// 채우는 데이터(짧은 값 위주, 긴 값 하나)
const DATA = {
  사업명: "합성 사업", 기관명: "합성기관", 담당자: "홍길동", 연락처: "02-000-0000", 공고번호: "제2026-0001호", 시행일: "2026-10-04", 접수기간: "2026-10-04 ~ 2026-10-18",
  추정가격: "1,234,500원", 장소: "서울 (본관) 3층\n대회의실\t&<>", 예정가격: "1,111,000원", 부가세: "123,450", 재공고: "해당 없음",
  성명: "홍길동", 소속: "기관", 이름: "김철수", 직위: "과장",
  project: { name: "합성 과제", start: "2026-10-04", end: "2026-12-31" }, dates: { start: "2026-10-04", end: "2026-10-18", days: "15" }, manager: { phone: "010-0000-0000", email: "a&b@example.test" },
};
const sectionTexts = (bytes: Uint8Array) => {
  const doc = reparse(bytes);
  const section = doc.sections[0];
  assert.ok(section !== undefined);
  const tables = section.paragraphs.flatMap((p) => p.objects.filter(isTableNode));
  return {
    top: section.paragraphs.map((p) => plain(p.logicalText)),
    tables: tables.map((t) => t.cells.map((c) => plain(c.subList?.paragraphs.map((q) => q.logicalText).join("\n") ?? ""))),
    nested: allParagraphs(doc).filter((p) => p.path.length > 1).map((p) => plain(p.logicalText)),
  };
};

test("compile --merge-fields 없이: 메일 머지 필드는 그대로이고(바이트 동일 구간), 표시 글 안의 {{경로}}는 이전처럼 COMPILE_SKIPPED(이미 필드 안)로 보고한다", () => {
  const r = compiled(FIXTURE);
  assert.equal(r.report.mergeConverted, 0);
  assert.equal(r.report.promoted, 8, "본문 {{경로}} 8곳만 누름틀로 승격");
  assert.deepEqual(listFields(reparse(r.output)).filter((f) => f.type === "MAILMERGE").map((f) => [f.mergeKey, f.valueText, f.dirty]), BEFORE.filter((f) => f.type === "MAILMERGE").map((f) => [f.mergeKey, f.valueText, f.dirty]));
  assert.equal(r.report.issues.filter((i) => i.code === "COMPILE_SKIPPED").length, 23, "{{키}}가 표시 글인 경로 꼴 필드 23곳");
});

test("compile to-field: 경로 꼴 키의 메일 머지 필드 29개가 누름틀(이름 = 키, 표시 글 그대로, dirty=1)이 되고, 경로 꼴이 아닌 4개는 그대로이며 경고가 난다. 구조·수량 그대로, 검사기 새 오류 0", () => {
  const r = compiled(FIXTURE, "to-field");
  assert.equal(r.report.mergeConverted, 29);
  assert.equal(r.report.promoted, 8);
  const out = reparse(r.output);
  const after = listFields(out);
  assert.equal(after.length, BEFORE.length + 8, "본문 {{경로}} 8곳이 누름틀로 승격돼 필드가 8개 늘었다");
  assert.equal(after.filter((f) => f.type === "MAILMERGE").length, 4);
  assert.deepEqual(after.filter((f) => f.type === "MAILMERGE").map((f) => [f.mergeKey, f.valueText, f.dirty]), nonPath.map((f) => [f.mergeKey, f.valueText, f.dirty]));
  // 바뀐 필드: 문서 순서 그대로, 이름 = 키, 표시 글(안내 글 포함) 그대로, dirty=1, 모양 그대로
  const keys = new Set(pathKeyed.map((f) => f.mergeKey));
  const converted = after.filter((f) => f.type === "CLICK_HERE" && keys.has(f.name));
  assert.equal(converted.length, 29);
  assert.deepEqual(
    converted.map((f) => [f.name, f.valueText, f.dirty, f.shape, f.mergeKey]),
    pathKeyed.map((f) => [f.mergeKey, f.valueText, "1", f.shape, undefined]),
  );
  // 누름틀 4개(원래)와 승격 8개는 그대로 있다
  assert.equal(after.filter((f) => f.type === "CLICK_HERE").length, 4 + 8 + 29);
  // 시작·끝 표식: 누름틀의 type·fieldid, 안내 Direction = 키. 끝 표식의 fieldid도 누름틀의 것이다
  const xml = sectionOf(r.output);
  assert.match(xml, /<hp:fieldBegin id="\d+" type="CLICK_HERE" name="사업명" editable="1" dirty="1" zorder="-1" fieldid="627272811" metaTag=""><hp:parameters cnt="3" name=""><hp:integerParam name="Prop">9<\/hp:integerParam><hp:stringParam name="Command" xml:space="preserve">Clickhere:set:\d+:Direction:wstring:3:사업명 /);
  assert.ok(!xml.includes('fieldid="627928423"/>') || nonPath.length > 0);
  assert.equal([...xml.matchAll(/<hp:fieldEnd [^>]*fieldid="627928423"\/>/g)].length, 4, "끝 표식은 남은 메일 머지 필드 4개만 옛 fieldid");
  // 건너뛴 4개는 바이트 그대로
  const begins = (bytes: Uint8Array): string[] => [...sectionOf(bytes).matchAll(/<hp:fieldBegin [^>]*type="MAILMERGE"[^>]*>[\s\S]*?<\/hp:fieldBegin>/g)].map((m) => m[0]);
  assert.deepEqual(begins(r.output), begins(FIXTURE).filter((b) => nonPath.some((n) => b.includes(`name="FieldValue">${n.mergeKey}<`))));
  assert.deepEqual(r.report.issues.filter((i) => i.code === "COMPILE_SKIPPED").map((i) => /'([^']*)'/.exec(i.message)?.[1]).sort(), ["계약 방법(수의)", "사유 설명", "참고 사항", "참고 사항"]);
  assert.ok(r.report.issues.filter((i) => i.severity === "warning").every((i) => i.code === "COMPILE_SKIPPED"));
  // 수량·구조
  assert.deepEqual(censusOfDoc(out), { ...censusOfDoc(reparse(FIXTURE)), fieldPairs: 37 + 8 }, "필드 쌍은 승격 8개만큼만 늘고 나머지 수량은 그대로");
  assert.deepEqual(sectionTexts(r.output), sectionTexts(FIXTURE));
  assert.deepEqual(newErrorsAfter(validateDocument(FIXTURE), validateDocument(r.output)), []);
  assert.deepEqual(r.report.newErrors, []);
  // 같은 입력은 같은 바이트, 다시 바꾸면 바꿀 것이 없다
  assert.ok(Buffer.from(compiled(FIXTURE, "to-field").output).equals(Buffer.from(r.output)));
  const again = compiled(r.output, "to-field");
  assert.equal(again.report.mergeConverted, 0);
  assert.equal(again.report.promoted, 0);
});

test("compile to-field → 채움: 바꾼 문서를 채우면 원본 서식을 바로 채운 것과 같은 글이 나오고 필드는 누름틀로 남는다(한컴 메일 머지 없이 쓰는 서식)", () => {
  const direct = generate(FIXTURE, emptyTemplate(), readDataset(DATA));
  assert.ok(direct.ok && !direct.dryRun);
  const r = compiled(FIXTURE, "to-field");
  const filled = generate(r.output, emptyTemplate(), readDataset(DATA));
  assert.ok(filled.ok && !filled.dryRun, JSON.stringify(filled.report.issues));
  assert.deepEqual(sectionTexts(filled.output), sectionTexts(direct.output));
  const after = listFields(reparse(filled.output));
  assert.equal(after.filter((f) => f.type === "CLICK_HERE").length, 41);
  assert.equal(after.filter((f) => f.type === "MAILMERGE").length, 4, "경로 꼴이 아닌 키 4개는 그대로");
  assert.equal(filled.report.reread.fields, 41);
  assert.deepEqual(newErrorsAfter(validateDocument(FIXTURE), validateDocument(filled.output)), []);
});

test("compile to-placeholder: 경로 꼴 키의 메일 머지 필드 29개가 `{{키}}` 글이 되고(안내 글·옛 값은 사라진다), 표식은 지워지고, 4개는 그대로이며 경고가 난다. 문단·표 구조·글자모양 run 그대로", () => {
  const r = compiled(FIXTURE, "to-placeholder");
  assert.equal(r.report.mergeConverted, 29);
  const out = reparse(r.output);
  const after = listFields(out);
  assert.equal(after.filter((f) => f.type === "MAILMERGE").length, 4);
  assert.equal(after.filter((f) => f.type === "CLICK_HERE").length, 4 + 8, "원래 누름틀 4개와 승격 8개");
  // 글: 필드 자리가 `{{키}}`가 됐다(안내 글이었던 자리도)
  const want = sectionTexts(FIXTURE);
  const got = sectionTexts(r.output);
  assert.equal(got.top.length, want.top.length);
  assert.equal(got.top[1], "사업명: {{사업명}} 입니다.", "안내 글(예전 값)이던 자리");
  assert.equal(got.top[3], "공고번호 {{공고번호}}, 시행일 {{시행일}}, 접수기간 {{접수기간}}.");
  assert.equal(got.top[4], "굵게: {{추정가격}}");
  assert.equal(got.top[5], "담당: {{담당자}} ({{연락처}}) 비고 {{참고 사항}}.", "연락처는 안내 글이었다. 경로 꼴이 아닌 참고 사항은 그대로");
  assert.equal(got.top[6], want.top[6], "경로 꼴이 아닌 키(계약 방법(수의))와 장소 — 장소만 바뀌지만 표시 글이 이미 {{장소}}다");
  assert.deepEqual(got.tables[0]?.slice(3, 6), ["사업명", "{{사업명}}", "{{공고번호}}"]);
  assert.ok(texts(out).filter((x) => x.startsWith("기관: ") || x.startsWith("공고번호: ")).every((x) => !x.includes("(입력 전)")), "머리말·꼬리말의 안내 글도 바뀌었다");
  // {{키}} 자리 수 = 앞(필드 표시 글 안 23 + 본문 8 = 31개) − 지운 표시 글 안의 자리 23 + 바꾼 필드 29
  const slots = (doc: HwpxDocument): number => allParagraphs(doc).reduce((n, p) => n + findPlaceholders(p.logicalText).length, 0);
  assert.equal(slots(reparse(FIXTURE)), 23 + 8);
  assert.equal(slots(out), 8 + 29);
  // 건너뛴 4개는 바이트 그대로, 경고 4개
  assert.equal([...sectionOf(r.output).matchAll(/type="MAILMERGE"/g)].length, 4);
  assert.deepEqual(r.report.issues.filter((i) => i.code === "COMPILE_SKIPPED").length, 4);
  // 구조·수량: 문단·표 수는 그대로, 필드 쌍은 바꾼 29개만큼 줄고 승격 8개만큼 늘었다
  const c0 = censusOfDoc(reparse(FIXTURE));
  const c1 = censusOfDoc(out);
  assert.equal(c1.paragraphs, c0.paragraphs);
  assert.equal(c1.tables, c0.tables);
  assert.equal(c1.fieldPairs, c0.fieldPairs - 29 + 8);
  assert.deepEqual(newErrorsAfter(validateDocument(FIXTURE), validateDocument(r.output)), []);
  assert.ok(Buffer.from(compiled(FIXTURE, "to-placeholder").output).equals(Buffer.from(r.output)), "결정성");
});

test("compile to-placeholder → 채움: 바꾼 문서를 채우면 원본 서식을 바로 채운 것과 같은 글이 나온다(필드 없이 `{{키}}`만으로 쓰는 서식)", () => {
  const direct = generate(FIXTURE, emptyTemplate(), readDataset(DATA));
  assert.ok(direct.ok && !direct.dryRun);
  const r = compiled(FIXTURE, "to-placeholder");
  const filled = generate(r.output, emptyTemplate(), readDataset(DATA));
  assert.ok(filled.ok && !filled.dryRun, JSON.stringify(filled.report.issues));
  assert.deepEqual(sectionTexts(filled.output), sectionTexts(direct.output));
  assert.equal(listFields(reparse(filled.output)).filter((f) => f.type === "MAILMERGE").length, 4);
  assert.deepEqual(newErrorsAfter(validateDocument(FIXTURE), validateDocument(filled.output)), []);
});

// ── 모양별 ──────────────────────────────────────────────────────

const mmBegin = (id: number, key: string): string =>
  `<hp:ctrl><hp:fieldBegin id="${id}" type="MAILMERGE" name="" editable="0" dirty="0" zorder="-1" fieldid="627928423" metaTag=""><hp:parameters cnt="5" name=""><hp:booleanParam name="Fiexde">1</hp:booleanParam><hp:integerParam name="Prop">8</hp:integerParam><hp:stringParam name="Command">${key}</hp:stringParam><hp:stringParam name="FieldType">USER_DEFINE</hp:stringParam><hp:stringParam name="FieldValue">${key}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`;
const mmEnd = (id: number): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="627928423"/></hp:ctrl>`;
const para = (id: number, runs: string): string => `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0">${runs}</hp:p>`;
const run = (inner: string, charPr = "0"): string => `<hp:run charPrIDRef="${charPr}">${inner}</hp:run>`;
const t = (s: string): string => `<hp:t>${s}</hp:t>`;
const TAB = '<hp:tab width="0" leader="0" type="1"/>';
const doc = (...paras: string[]): Uint8Array => buildHwpx([paras.join("")]);

test("compile to-placeholder 모양: simple·empty·inline·cross-run은 `{{키}}` 한 덩어리가 되고, 여러 문단에 걸친 필드와 경로 꼴이 아닌 키·키 없는 필드는 그대로 둔다(경고)", () => {
  const keyless = `<hp:ctrl><hp:fieldBegin id="90" type="MAILMERGE" name="" fieldid="1"/></hp:ctrl><hp:t>키없음</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="90" fieldid="1"/></hp:ctrl>`;
  const bytes = doc(
    para(1, run(t("앞 ") + mmBegin(10, "단순") + t("옛 값") + mmEnd(10) + t(" 뒤"))),
    para(2, run(t("앞 ") + mmBegin(11, "빈") + mmEnd(11) + t(" 뒤"))),
    para(3, run(t("앞 ") + mmBegin(12, "탭") + `<hp:t>가${TAB}나<hp:lineBreak/>다</hp:t>` + mmEnd(12) + t(" 뒤"))),
    para(4, run(t("앞 ") + mmBegin(13, "런")) + run(t("{{런}}") + mmEnd(13) + t(" 뒤"), "1")),
    para(5, run(t("앞 ") + mmBegin(14, "여럿") + t("안내1"))),
    para(6, run(t("안내2") + mmEnd(14) + t(" 뒤"))),
    para(7, run(t("앞 ") + mmBegin(15, "경로 아님") + t("표시") + mmEnd(15) + t(" 뒤"))),
    para(8, run(t("앞 ") + keyless + t(" 뒤"))),
  );
  const r = compiled(bytes, "to-placeholder");
  assert.equal(r.report.mergeConverted, 4);
  assert.deepEqual(texts(reparse(r.output)), ["앞 {{단순}} 뒤", "앞 {{빈}} 뒤", "앞 {{탭}} 뒤", "앞 {{런}} 뒤", "앞 안내1", "안내2 뒤", "앞 표시 뒤", "앞 키없음 뒤"]);
  assert.deepEqual(listFields(reparse(r.output)).map((f) => [f.mergeKey, f.shape]), [["여럿", "crossParagraph"], ["경로 아님", "simple"], [undefined, "simple"]]);
  const skipped = r.report.issues.filter((i) => i.code === "COMPILE_SKIPPED").map((i) => i.message);
  assert.equal(skipped.length, 2, "키 없는 필드는 경고도 없이 건드리지 않는다");
  assert.ok(skipped.some((m) => m.includes("'여럿'") && m.includes("여러 문단에 걸쳐")));
  assert.ok(skipped.some((m) => m.includes("'경로 아님'")));
  assert.ok(!sectionOf(r.output).includes("<hp:lineBreak") && !sectionOf(r.output).includes("<hp:tab"), "옛 탭·줄바꿈 요소가 없다");
  // cross-run: 글자모양 run(charPr 1)이 그대로 있고 글은 그 run에 들어갔다
  assert.match(sectionOf(r.output), /<hp:run charPrIDRef="1"><hp:t>\{\{런\}\}<\/hp:t><hp:t> 뒤<\/hp:t><\/hp:run>/);
  assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), []);
  // 바꾼 문서는 채워진다
  const filled = generate(r.output, emptyTemplate(), readDataset({ 단순: "S", 빈: "E", 탭: "T", 런: "R" }), { missing: "keep" });
  assert.ok(filled.ok && !filled.dryRun);
  assert.deepEqual(texts(reparse(filled.output)).slice(0, 4), ["앞 S 뒤", "앞 E 뒤", "앞 T 뒤", "앞 R 뒤"]);
});

test("compile to-field 모양: 여러 문단에 걸친 필드도 누름틀로 바뀐다(채울 수 있는 모양이면). 짝 표식이 없는 필드는 그대로 두고 경고한다", () => {
  const bytes = doc(
    para(1, run(t("앞 ") + mmBegin(14, "여럿") + t("안내1"))),
    para(2, run(t("안내2") + mmEnd(14) + t(" 뒤"))),
    para(3, run(t("앞 ") + mmBegin(15, "짝없음") + t("글"))),
  );
  const r = compiled(bytes, "to-field");
  assert.equal(r.report.mergeConverted, 1);
  assert.deepEqual(listFields(reparse(r.output)).map((f) => [f.type, f.name, f.mergeKey, f.shape, f.dirty]), [["CLICK_HERE", "여럿", undefined, "crossParagraph", "1"], ["MAILMERGE", "", "짝없음", "unpaired", "0"]]);
  assert.equal(r.report.issues.filter((i) => i.code === "COMPILE_SKIPPED").length, 1);
  const filled = generate(r.output, emptyTemplate(), readDataset({ 여럿: "값" }));
  assert.ok(filled.ok && !filled.dryRun);
  assert.deepEqual(texts(reparse(filled.output)), ["앞 값 뒤", "앞 글"]);
});

// ── 한글 2024 확인(선택 실행) ──────────────────────────────────

const ENABLED = process.env["HWPX_COM"] === "1";
const SCRIPT = fileURLToPath(new URL("../../../tools/com/read_text.py", import.meta.url));

test("한글 2024: 바꾼 서식(to-field·to-placeholder)이 열리고, 한컴이 다시 저장해도 누름틀·필드 수가 맞으며, to-field의 누름틀은 한컴이 이름으로 읽고, PDF에 `{{키}}`가 보인다", { skip: !ENABLED && "HWPX_COM=1일 때만 실행한다" }, (tc) => {
  const dir = mkdtempSync(join(tmpdir(), "hwpx-merge-compile-com-"));
  try {
    const toField = compiled(FIXTURE, "to-field").output;
    const toPlaceholder = compiled(FIXTURE, "to-placeholder").output;
    writeFileSync(join(dir, "field.hwpx"), toField);
    writeFileSync(join(dir, "placeholder.hwpx"), toPlaceholder);
    const spec = join(dir, "spec.json");
    const res = join(dir, "result.json");
    writeFileSync(
      spec,
      JSON.stringify({
        documents: [
          { name: "field", file: join(dir, "field.hwpx"), fields: ["사업명", "기관명", "project.name"], resave: join(dir, "field.resaved.hwpx") },
          { name: "placeholder", file: join(dir, "placeholder.hwpx"), resave: join(dir, "placeholder.resaved.hwpx"), pdf: join(dir, "placeholder.pdf"), markers: ["{{사업명}}", "{{기관명}}", "{{참고 사항}}"] },
        ],
      }),
    );
    type Row = { name: string; opened: boolean; pages: number | null; timeout: boolean; error: string | null; resaved: boolean; field_text: Record<string, string>; pdf: { markers: Record<string, unknown> | null } | null };
    let rows: Row[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = spawnSync("python", [SCRIPT, "--spec", spec, "--out", res, "--timeout", "60"], { encoding: "utf8", timeout: 200_000 });
      assert.equal(r.status, 0, r.stderr);
      rows = (JSON.parse(readFileSync(res, "utf8")) as { results: Row[] }).results;
      if (rows.every((x) => x.opened && !x.timeout)) break;
    }
    for (const row of rows) {
      assert.ok(row.opened && !row.timeout, `${row.name}이(가) 한컴에서 열려야 한다(${row.error})`);
      assert.ok((row.pages ?? 0) >= 1 && row.resaved, row.name);
    }
    const [field, placeholder] = rows as [Row, Row];
    tc.diagnostic(`한컴 GetFieldText(to-field) = ${JSON.stringify(field.field_text)}`);
    // to-field: 한컴이 이름(사업명)으로 누름틀을 읽는다. 첫 번째 `사업명` 누름틀(꼬리말·머리말을 거친 문서 순서)의 표시 글이다
    assert.ok((field.field_text["사업명"] ?? "") !== "" || (field.field_text["기관명"] ?? "") !== "", "한컴이 누름틀 값을 읽었다");
    assert.equal(field.field_text["project.name"], "{{project.name}}");
    const resavedField = listFields(reparse(new Uint8Array(readFileSync(join(dir, "field.resaved.hwpx")))));
    assert.equal(resavedField.filter((f) => f.type === "CLICK_HERE").length, 41);
    assert.equal(resavedField.filter((f) => f.type === "MAILMERGE").length, 4);
    // to-placeholder: 한컴이 다시 저장한 문서에도 `{{키}}` 글과 남은 메일 머지 필드 4개가 있다. PDF에 `{{사업명}}`이 그려진다
    const resavedPh = reparse(new Uint8Array(readFileSync(join(dir, "placeholder.resaved.hwpx"))));
    assert.equal(listFields(resavedPh).filter((f) => f.type === "MAILMERGE").length, 4);
    assert.ok(texts(resavedPh).some((x) => x.includes("{{사업명}}")));
    const m = placeholder.pdf?.markers;
    assert.ok(m !== null && m !== undefined && m["{{사업명}}"] !== null, "PDF에 {{사업명}}이 있다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
