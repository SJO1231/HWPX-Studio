// M1-B: 여러 건 생성(엔진 쪽). 데이터 읽기(`readBatchRecords`), 파일 이름 규칙(`planBatchNames`), 건마다 생성(`generateBatch`).
// 기대값은 명세(스튜디오 명세 4a, 엔진 명세 8.2)에서 만들었다: 원소마다 한 건, 이름 규칙(못 쓰는 문자 `_`, 비면 번호, 중복 `-2`·`-3`),
// 한 건이 실패해도 나머지는 만든다, 같은 입력은 같은 바이트, 값 원문 없음.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generate, generateBatch, planBatchNames, readBatchRecords, readDataset, safeFileStem, sanitizeFileStem, emptyTemplate, type BatchItem, type BatchRecord } from "../src/index.ts";
import { readFixture, reparse } from "./helpers.ts";

const SINGLE = readFixture("hancom/ph-single");
const record = (data: Record<string, unknown>): BatchRecord => ({ dataset: { data, derived: {} } });
const project = (name: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ project: { name, start: "S", end: "E" }, ...extra });
const names = (records: BatchRecord[], base = "form", nameFrom?: string): string[] => planBatchNames(records, base, nameFrom);
const batch = (records: BatchRecord[], extra: Record<string, unknown> = {}): BatchItem[] => [...generateBatch(SINGLE, emptyTemplate(), records, { baseName: "form", ...extra })];
const textOf = (bytes: Uint8Array | undefined): string[] => (bytes === undefined ? [] : (reparse(bytes).sections[0]?.paragraphs.map((p) => p.logicalText) ?? []));

// ── 데이터 읽기 ────────────────────────────────────────────────

test("B 데이터: 최상위 배열은 원소마다 한 건이고, 한 건짜리(객체)는 undefined다", () => {
  const records = readBatchRecords('[{"a":1},{"a":2}]');
  assert.deepEqual(records, [{ dataset: { data: { a: 1 }, derived: {} } }, { dataset: { data: { a: 2 }, derived: {} } }]);
  assert.equal(readBatchRecords('{"a":[1,2]}'), undefined, "배열이 값 안에 있는 객체는 한 건짜리");
  assert.equal(readBatchRecords({ schema: "hwpx-studio/dataset@1", data: { a: 1 } }), undefined, "data가 객체인 묶음은 한 건짜리");
  assert.deepEqual(readBatchRecords("[]"), []);
});

test("B 데이터: 묶음 형식의 data가 배열이면 원소마다 한 건이고 derived는 건마다 같이 쓴다", () => {
  const records = readBatchRecords({ schema: "hwpx-studio/dataset@1", data: [{ a: 1 }, { a: 2 }], derived: { total: 3 } });
  assert.deepEqual(records, [{ dataset: { data: { a: 1 }, derived: { total: 3 } } }, { dataset: { data: { a: 2 }, derived: { total: 3 } } }]);
  assert.equal(readBatchRecords({ schema: "hwpx-studio/dataset@1", data: [] })?.length, 0);
  // schema가 다르면 data라는 키가 있어도 묶음이 아니라 한 건짜리 객체다
  assert.equal(readBatchRecords({ data: [{ a: 1 }] }), undefined);
});

test("B 데이터: 객체가 아닌 원소는 그 건만 DATA_SCHEMA 오류, JSON이 틀리거나 derived가 객체가 아니면 던진다", () => {
  const records = readBatchRecords('[{"a":1}, 5, null, [1], "x"]');
  assert.equal(records?.length, 5);
  assert.ok(records !== undefined && "dataset" in (records[0] as object));
  for (const i of [1, 2, 3, 4]) {
    const r = records?.[i];
    assert.ok(r !== undefined && "error" in r && r.error.code === "DATA_SCHEMA", `${i}번 원소`);
  }
  assert.throws(() => readBatchRecords("[{"), (e: unknown) => (e as { code?: string }).code === "DATA_JSON");
  assert.throws(() => readBatchRecords({ schema: "hwpx-studio/dataset@1", data: [], derived: 3 }), (e: unknown) => (e as { code?: string }).code === "DATA_SCHEMA");
});

// ── 파일 이름 규칙 ─────────────────────────────────────────────

test("B 이름: 기본은 <원본 이름>-<번호 3자리>.hwpx(1부터)이고 1000건 이상이면 번호가 길어진다", () => {
  assert.deepEqual(names([record({}), record({}), record({})]), ["form-001.hwpx", "form-002.hwpx", "form-003.hwpx"]);
  const many = names(Array.from({ length: 1000 }, () => record({})));
  assert.deepEqual([many[8], many[99], many[999]], ["form-009.hwpx", "form-100.hwpx", "form-1000.hwpx"]);
  assert.deepEqual(names([]), []);
});

test("B 이름: 이름 경로의 값(문자열·숫자)을 쓰고, 없거나 비었거나 문자열·숫자가 아니면 번호로 대체한다", () => {
  const rs = [
    record({ id: "홍길동" }),
    record({ id: 42 }),
    record({ id: "" }),
    record({}),
    record({ id: null }),
    record({ id: true }),
    record({ id: { x: 1 } }),
    record({ id: ["a"] }),
    record({ id: "   " }),
    record({ id: "..." }),
    record({ id: 3.5 }),
  ];
  assert.deepEqual(names(rs, "form", "id"), [
    "홍길동.hwpx",
    "42.hwpx",
    "form-003.hwpx",
    "form-004.hwpx",
    "form-005.hwpx",
    "form-006.hwpx",
    "form-007.hwpx",
    "form-008.hwpx",
    "form-009.hwpx",
    "form-010.hwpx",
    "3.5.hwpx",
  ]);
  // 중첩 경로와 derived, 오류가 난 건(번호)
  const nested: BatchRecord[] = [record({ a: { b: "깊은" } }), { dataset: { data: {}, derived: { a: { b: "파생" } } } }, { error: { code: "DATA_SCHEMA", message: "x" } }];
  assert.deepEqual(names(nested, "form", "a.b"), ["깊은.hwpx", "파생.hwpx", "form-003.hwpx"]);
});

test("B 이름: 파일 이름에 못 쓰는 문자와 경로 구분자는 _로 바꾼다. 경로를 벗어나지 못한다", () => {
  assert.equal(safeFileStem('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(safeFileStem("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeFileStem("C:\\Windows\\x"), "C__Windows_x");
  assert.equal(safeFileStem("줄\n바꿈\t탭\u0001"), "줄_바꿈_탭_");
  assert.equal(safeFileStem("정상 이름 (1)"), "정상 이름 (1)");
  // 앞뒤 공백과 뒤쪽 점은 뗀다(Windows가 조용히 떼는 것). 남는 것이 없으면 빈 글
  assert.equal(safeFileStem("  이름. . "), "이름");
  assert.equal(safeFileStem(".."), "");
  assert.equal(safeFileStem("   "), "");
  assert.equal(safeFileStem(".hidden"), ".hidden");
  // Windows 장치 이름
  for (const reserved of ["CON", "nul", "Com1", "LPT9", "aux", "PRN"]) assert.equal(safeFileStem(reserved), `${reserved}_`);
  assert.equal(safeFileStem("console"), "console");
  // 길이 100자 제한, 서로게이트 쌍 가운데서 자르지 않는다
  assert.equal(safeFileStem("가".repeat(300)).length, 100);
  assert.equal(safeFileStem("a".repeat(99) + "😀😀"), "a".repeat(99) + "😀");
  assert.equal(Array.from(safeFileStem("😀".repeat(150))).length, 100, "코드 포인트 기준");
  assert.ok(!/[\uD800-\uDBFF]$/.test(safeFileStem("a".repeat(99) + "😀")));
  const rs = [record({ n: "x/y" }), record({ n: "CON" })];
  assert.deepEqual(names(rs, "form", "n"), ["x_y.hwpx", "CON_.hwpx"]);
});

test("B 이름: 같은 이름이 또 나오면 -2, -3을 붙인다(대소문자 무시, 번호 이름과 겹쳐도 유일)", () => {
  const rs = [record({ n: "같음" }), record({ n: "같음" }), record({ n: "같음" }), record({ n: "다름" }), record({ n: "같음" })];
  assert.deepEqual(names(rs, "form", "n"), ["같음.hwpx", "같음-2.hwpx", "같음-3.hwpx", "다름.hwpx", "같음-4.hwpx"]);
  assert.deepEqual(names([record({ n: "Abc" }), record({ n: "abc" }), record({ n: "ABC" })], "form", "n"), ["Abc.hwpx", "abc-2.hwpx", "ABC-3.hwpx"]);
  // 첫 건의 이름이 둘째 건의 번호 이름과 같으면 둘째가 비켜 간다
  assert.deepEqual(names([record({ n: "form-002" }), record({})], "form", "n"), ["form-002.hwpx", "form-002-2.hwpx"]);
  // 덧붙인 이름이 이미 쓰인 이름과 겹쳐도 유일하다
  assert.deepEqual(names([record({ n: "a" }), record({ n: "a-2" }), record({ n: "a" })], "form", "n"), ["a.hwpx", "a-2.hwpx", "a-3.hwpx"]);
  const all = names(Array.from({ length: 50 }, (_, i) => record({ n: i % 3 === 0 ? "" : `n${i % 5}` })), "form", "n");
  assert.equal(new Set(all.map((x) => x.toLowerCase())).size, 50, "이름이 모두 다르다");
});


test("B 이름: sanitizeFileStem — 임의의 파일 이름 문자열에서 폴더 부분과 .hwpx를 떼고 안전한 이름 앞부분을 만든다(비면 문서)", () => {
  assert.equal(sanitizeFileStem("보고서.hwpx"), "보고서");
  assert.equal(sanitizeFileStem("양식.HWPX"), "양식");
  assert.equal(sanitizeFileStem("C:\\Users\\me\\내 양식.hwpx"), "내 양식");
  assert.equal(sanitizeFileStem("../../x/y.hwpx"), "y");
  assert.equal(sanitizeFileStem("a:b*c?.hwpx"), "a_b_c_");
  assert.equal(sanitizeFileStem("x.hwpx.hwpx"), "x.hwpx");
  assert.equal(sanitizeFileStem("con.hwpx"), "con_");
  assert.equal(sanitizeFileStem("이름 .hwpx"), "이름");
  for (const empty of ["", "   ", ".hwpx", "...", "a/b/", "..", "\\\\", "/"]) assert.equal(sanitizeFileStem(empty), "문서", JSON.stringify(empty));
  // 길이는 코드 포인트 기준 100
  assert.equal(Array.from(sanitizeFileStem("😀".repeat(150))).length, 100);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(sanitizeFileStem("a".repeat(99) + "😀😀")), "서로게이트 쌍을 가르지 않는다");
  // 어떤 입력이든 결과에 경로 구분자·금지 문자가 없다
  for (const evil of ["../../etc/passwd", "a\u0000b", "<script>.hwpx", "\u202e반전", "x|y"]) assert.ok(!/[<>:"/\\|?*\u0000-\u001F]/.test(sanitizeFileStem(evil)), JSON.stringify(evil));
  // planBatchNames의 원본 이름도 같이 정제한다
  assert.deepEqual(planBatchNames([{ dataset: { data: {}, derived: {} } }], "../evil.hwpx"), ["evil-001.hwpx"]);
  assert.deepEqual(planBatchNames([{ dataset: { data: {}, derived: {} } }], ""), ["문서-001.hwpx"]);
});

// ── 건마다 생성 ────────────────────────────────────────────────

test("B 생성: 배열 3건이면 문서 3개, 건마다 자기 값이 들어가고 이름은 규칙대로이며 단건 생성과 같은 바이트다", () => {
  const rs = [record(project("가", { id: "첫째" })), record(project("나\n둘째 줄", { id: "둘째" })), record(project("다", { id: "첫째" }))];
  const items = batch(rs, { nameFrom: "id" });
  assert.deepEqual(items.map((i) => [i.index, i.name, i.ok]), [[1, "첫째.hwpx", true], [2, "둘째.hwpx", true], [3, "첫째-2.hwpx", true]]);
  assert.deepEqual(items.map((i) => textOf(i.output)[1]), ["사업명: 가 입니다.", "사업명: 나\n둘째 줄 입니다.", "사업명: 다 입니다."]);
  for (const [i, item] of items.entries()) {
    const single = generate(SINGLE, emptyTemplate(), (rs[i] as { dataset: ReturnType<typeof readDataset> }).dataset);
    assert.ok(single.ok && !single.dryRun && Buffer.from(single.output).equals(Buffer.from(item.output ?? new Uint8Array())), `${i + 1}번째가 단건 생성과 같은 바이트`);
    assert.equal(item.filled, 3, "채운 자리: 사업명·시작·끝");
    assert.deepEqual([item.skipped, item.errorCodes, item.errors], [[], [], []]);
  }
});

test("B 생성: 1건·0건. 0건이면 항목이 없다", () => {
  assert.equal(batch([record(project("하나"))]).length, 1);
  assert.deepEqual(batch([]), []);
});

test("B 생성: 한 건이 실패해도 나머지는 만들고, 실패한 건에 오류 코드가 있다(누락 키, 객체가 아닌 원소, 제어 문자)", () => {
  const rs: BatchRecord[] = [
    record(project("가")),
    record({ project: { name: "누락", start: "S" } }),
    { error: { code: "DATA_SCHEMA", message: "3번째 건이 JSON 객체가 아닙니다." } },
    record(project("제어\u0001")),
    record(project("나")),
  ];
  const items = batch(rs);
  assert.deepEqual(items.map((i) => i.ok), [true, false, false, false, true]);
  assert.deepEqual(items.map((i) => i.errorCodes), [[], ["DATA_MISSING"], ["DATA_SCHEMA"], ["VALUE_CONTROL_CHAR"], []]);
  assert.deepEqual(items.map((i) => i.output === undefined), [false, true, true, true, false]);
  assert.deepEqual(items.map((i) => i.name), ["form-001.hwpx", "form-002.hwpx", "form-003.hwpx", "form-004.hwpx", "form-005.hwpx"]);
  assert.deepEqual(items.map((i) => i.filled), [3, 0, 0, 0, 3]);
  assert.ok(items[1]?.errors[0]?.message.includes("project.end"), "오류 메시지에 데이터 경로가 있다");
});

test("B 생성: 누락 정책 옵션은 건마다 적용된다(empty면 누락 건도 만든다)", () => {
  const items = batch([record({ project: { name: "누락", start: "S" } })], { missing: "empty" });
  assert.deepEqual(items.map((i) => i.ok), [true]);
  assert.equal(textOf(items[0]?.output)[2], "기간: S ~ ");
});

test("B 생성: 결정적이다 — 같은 입력이면 같은 바이트·같은 이름·같은 결과", () => {
  const rs = [record(project("가", { id: "a" })), record(project("나\t다", { id: "a" })), record({ id: "b" })];
  const a = batch(rs, { nameFrom: "id" });
  const b = batch(rs, { nameFrom: "id" });
  assert.equal(a.length, b.length);
  for (const [i, x] of a.entries()) {
    const y = b[i];
    assert.ok(y !== undefined);
    assert.deepEqual({ ...x, output: undefined }, { ...y, output: undefined });
    assert.ok(Buffer.from(x.output ?? new Uint8Array()).equals(Buffer.from(y.output ?? new Uint8Array())));
  }
});

test("B 생성: 결과 항목에 값 원문이 없다(오류 메시지·건너뜀 포함). 줄바꿈 값도", () => {
  const items = batch([record(project("극비\n문장")), record({ project: { name: "비밀값", start: "S" } }), record(project("제어\u0001비밀"))]);
  const all = JSON.stringify(items.map((i) => ({ ...i, output: undefined })));
  for (const word of ["극비", "문장", "비밀값", "비밀"]) assert.ok(!all.includes(word), `원문 ${word}이(가) 결과에 있다`);
});

test("B 생성: 모의 실행(dryRun)이면 출력 없이 성공·실패만 낸다", () => {
  const items = batch([record(project("가")), record({ project: { name: "x" } })], { dryRun: true });
  assert.deepEqual(items.map((i) => [i.ok, i.output === undefined]), [[true, true], [false, true]]);
});

test("B 생성: 입력 문서를 열 수 없으면 건의 실패로 나온다(건마다 같은 오류 코드). 값 오류는 던지지 않는다", () => {
  const items = [...generateBatch(new Uint8Array([1, 2, 3]), emptyTemplate(), [record({}), record({})], { baseName: "x" })];
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => !i.ok && i.errorCodes.length === 1 && i.errorCodes[0] !== undefined && /^PKG_/.test(i.errorCodes[0])), JSON.stringify(items.map((i) => i.errorCodes)));
});

test("B 생성: 500건 — 항목 500개가 나오고 건마다 자기 값이다(걸린 시간을 기록한다)", (t) => {
  const rs = Array.from({ length: 500 }, (_, i) => record(project(`이름 ${i + 1}\n둘째 줄`)));
  const start = performance.now();
  let count = 0;
  const seen = new Set<string>();
  for (const item of generateBatch(SINGLE, emptyTemplate(), rs, { baseName: "form" })) {
    count++;
    assert.ok(item.ok, `${item.index}번째 실패: ${JSON.stringify(item.errors)}`);
    seen.add(item.name);
    if (item.index === 1 || item.index === 500) assert.equal(textOf(item.output)[1], `사업명: 이름 ${item.index}\n둘째 줄 입니다.`);
  }
  assert.equal(count, 500);
  assert.equal(seen.size, 500);
  t.diagnostic(`500건 ${Math.round(performance.now() - start)}ms`);
});
