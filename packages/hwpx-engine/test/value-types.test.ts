// 값 타입 7종의 읽기·표시 규칙(엔진 명세 8.8.4, #131, 사용자 결정 2026-10-09): 타입마다 읽기 표(정상·거절), 표시 설정 덮기,
// 자리 바로 뒤 단위 떼기(placeText), 템플릿의 display 읽기 검사, 조건이 쓰는 꾸미기 전 값(selectSlots).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HwpxError } from "../src/errors.ts";
import {
  bindValues,
  placeText,
  readStudioTemplate,
  readTypedValue,
  selectSlots,
  valueUnit,
  writeStudioTemplate,
  type StudioTemplate,
  type ValueDisplay,
  type ValueFormat,
} from "../src/index.ts";

const SHA = "d".repeat(64);

type Ok = [raw: unknown, text: string, normalized: string];

/** 읽기 표 하나: 정상은 표시 글·정규 꼴(·수), 거절은 DATA_FORMAT이고 사유에 타입 이름이 있고 값 원문이 없다 */
function table(format: ValueFormat, ok: Ok[], bad: unknown[], label: string): void {
  for (const [raw, text, normalized] of ok) {
    const r = readTypedValue(format, raw);
    assert.ok(r.ok, `${format} ${JSON.stringify(raw)}: ${r.ok ? "" : r.reason}`);
    assert.equal(r.text, text, `${format} ${JSON.stringify(raw)} 표시`);
    assert.equal(r.normalized, normalized, `${format} ${JSON.stringify(raw)} 정규 꼴`);
    if (format === "number" || format === "money" || format === "percent") assert.equal(r.number, Number(normalized), `${format} ${JSON.stringify(raw)} 수`);
    else assert.equal(r.number, undefined);
  }
  for (const raw of bad) {
    const r = readTypedValue(format, raw);
    assert.ok(!r.ok, `${format} ${JSON.stringify(raw)}: 거절해야 한다`);
    assert.equal(r.code, "DATA_FORMAT", `${format} ${JSON.stringify(raw)}`);
    assert.ok(r.reason.includes(label) && r.reason.includes(`(${format})`), `${format}: 사유에 타입 이름(${r.reason})`);
    const s = String(raw);
    if (s.length >= 3) assert.ok(!r.reason.includes(s), `${format}: 사유에 값 원문 ${s}`);
  }
  assert.ok(ok.length >= 15 && bad.length >= 10, `${format}: 정상 ${ok.length}·거절 ${bad.length}`);
}

test("#131 number: 쉼표(천 단위)·음수 -, 십진 글 그대로(자릿수 보존), 앞자리 0은 떼고, 그 밖은 DATA_FORMAT", () => {
  table(
    "number",
    [
      [0, "0", "0"], [1234, "1,234", "1234"], [-1234, "-1,234", "-1234"], ["1234.50", "1,234.50", "1234.50"], ["1,234.50", "1,234.50", "1234.50"],
      ["007", "7", "7"], ["0.5", "0.5", "0.5"], ["-0", "0", "0"], ["-0.00", "0.00", "0.00"], [" 42 ", "42", "42"], ["1,234,567", "1,234,567", "1234567"],
      [12.25, "12.25", "12.25"], ["123456789012345678901234567890", "123,456,789,012,345,678,901,234,567,890", "123456789012345678901234567890"],
      ["-9,999.999", "-9,999.999", "-9999.999"], [1e20, "100,000,000,000,000,000,000", "100000000000000000000"], ["000.10", "0.10", "0.10"], ["100", "100", "100"],
    ],
    ["1,23", "12,34,567", "1.2.3", "+5", "1e3", ".5", "5.", "１２", "12원", "12%", "△5", "--5", true, Number.NaN, Infinity, 1e21, "abc", "1 234"],
    "수",
  );
});

test("#131 money: 금·원·원정·₩·￦·쉼표·공백을 떼고, 음수 - 또는 △, 십진 글 그대로(Number로 바꾸지 않음), 출력 기본 -1,234원", () => {
  table(
    "money",
    [
      [1234, "1,234원", "1234"], ["1,234", "1,234원", "1234"], ["1,234원", "1,234원", "1234"], ["금 1,234원정", "1,234원", "1234"], ["금1,234,000원", "1,234,000원", "1234000"],
      ["₩1,234", "1,234원", "1234"], ["₩ 1,234", "1,234원", "1234"], ["-₩1,234", "-1,234원", "-1234"], ["₩-1,234", "-1,234원", "-1234"], ["△1,234", "-1,234원", "-1234"],
      ["△ 1,234원", "-1,234원", "-1234"], ["1234.50", "1,234.50원", "1234.50"], ["1 234", "1,234원", "1234"], ["007", "7원", "7"], [" 1,000원 ", "1,000원", "1000"],
      ["0원", "0원", "0"], ["-0", "0원", "0"], ["99999999999999999999", "99,999,999,999,999,999,999원", "99999999999999999999"], [-1234, "-1,234원", "-1234"],
      ["금 1,000 원정", "1,000원", "1000"],
      ["￦1,234", "1,234원", "1234"], ["-￦ 1,234원", "-1,234원", "-1234"], ["￦△5", "-5원", "-5"],
    ],
    ["1,23원", "원", "금원", "₩", "+1,234", "1,234달러", "USD 1,234", "1.2.3원", "--1", "△-1", "1,234원원", "일천원", true, Number.NaN, "1e3원", "１,２３４"],
    "금액",
  );
  // 사용 안내(docs/user-guide.md 7절)에 적은 예
  for (const [f, raw, want] of [["money", 1234000, "1,234,000원"], ["money", "1,234,000", "1,234,000원"], ["money", "금 1,234,000원정", "1,234,000원"], ["date", "20261009", "2026. 10. 09."], ["date", "2026-10-09", "2026. 10. 09."], ["date", "2026. 10. 9.", "2026. 10. 09."]] as const) {
    const r = readTypedValue(f, raw);
    assert.ok(r.ok && r.text === want, `${f} ${String(raw)}`);
  }
  // 십진 글은 Number를 거치지 않는다: 2^53 + 1, 소수 끝 0
  const big = readTypedValue("money", "9,007,199,254,740,993원");
  assert.ok(big.ok);
  assert.deepEqual([big.text, big.normalized], ["9,007,199,254,740,993원", "9007199254740993"]);
});

test("#131 percent: 수 또는 12.5%(% 앞 공백 허용), 출력 기본 12.5%", () => {
  table(
    "percent",
    [
      [12.5, "12.5%", "12.5"], ["12.5", "12.5%", "12.5"], ["12.5%", "12.5%", "12.5"], ["12.5 %", "12.5%", "12.5"], [" 12.5% ", "12.5%", "12.5"], ["-3%", "-3%", "-3"],
      ["0%", "0%", "0"], ["100", "100%", "100"], ["1,000%", "1,000%", "1000"], ["007.50%", "7.50%", "7.50"], [0, "0%", "0"], [-0.25, "-0.25%", "-0.25"],
      ["99.999%", "99.999%", "99.999"], ["0.0", "0.0%", "0.0"], [150, "150%", "150"], ["-0%", "0%", "0"],
    ],
    ["%12", "12%%", "12.5.1%", "+3%", "12 퍼센트", "12‰", "abc", true, "1,23%", "△3%", Infinity, "12%5"],
    "백분율",
  );
});

test("#131 date: YYYYMMDD·YYYY-MM-DD·YYYY/MM/DD·YYYY.MM.DD(공백 허용), 달력 검사(윤년), 출력 기본 YYYY. MM. DD.", () => {
  table(
    "date",
    [
      ["20261009", "2026. 10. 09.", "2026-10-09"], ["2026-10-09", "2026. 10. 09.", "2026-10-09"], ["2026/10/09", "2026. 10. 09.", "2026-10-09"],
      ["2026.10.09", "2026. 10. 09.", "2026-10-09"], ["2026. 10. 09.", "2026. 10. 09.", "2026-10-09"], ["2026. 10. 9.", "2026. 10. 09.", "2026-10-09"],
      ["2026-1-5", "2026. 01. 05.", "2026-01-05"], [" 2026 - 10 - 09 ", "2026. 10. 09.", "2026-10-09"], ["2024-02-29", "2024. 02. 29.", "2024-02-29"],
      ["2000-02-29", "2000. 02. 29.", "2000-02-29"], ["2026-12-31", "2026. 12. 31.", "2026-12-31"], ["2026-01-01", "2026. 01. 01.", "2026-01-01"],
      [20261009, "2026. 10. 09.", "2026-10-09"], ["0001-01-01", "0001. 01. 01.", "0001-01-01"], ["9999-12-31", "9999. 12. 31.", "9999-12-31"],
      ["2026 .10 .09", "2026. 10. 09.", "2026-10-09"],
    ],
    ["2026-02-29", "1900-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-09.", "2026-10/09", "26-10-09", "2026109",
      "0000-01-01", "2026년 10월 9일", "2026-10-09 10:00", true, "20261309"],
    "날짜",
  );
});

test("#131 datetime: 날짜 + 공백 또는 T + HH:MM[:SS], 달력·시각 검사, 출력 기본 YYYY. MM. DD. HH:mm(초가 있으면 :ss)", () => {
  table(
    "datetime",
    [
      ["2026-10-09 14:30", "2026. 10. 09. 14:30", "2026-10-09T14:30:00"], ["2026-10-09T14:30", "2026. 10. 09. 14:30", "2026-10-09T14:30:00"],
      ["2026-10-09T14:30:15", "2026. 10. 09. 14:30:15", "2026-10-09T14:30:15"], ["2026-10-09 14:30:15", "2026. 10. 09. 14:30:15", "2026-10-09T14:30:15"],
      ["20261009 09:05", "2026. 10. 09. 09:05", "2026-10-09T09:05:00"], ["2026/10/09 9:05", "2026. 10. 09. 09:05", "2026-10-09T09:05:00"],
      ["2026.10.09 00:00", "2026. 10. 09. 00:00", "2026-10-09T00:00:00"], ["2026. 10. 09. 23:59", "2026. 10. 09. 23:59", "2026-10-09T23:59:00"],
      ["2026. 10. 09. 23:59:59", "2026. 10. 09. 23:59:59", "2026-10-09T23:59:59"], ["2024-02-29 12:00", "2024. 02. 29. 12:00", "2024-02-29T12:00:00"],
      [" 2026-10-09  14:30 ", "2026. 10. 09. 14:30", "2026-10-09T14:30:00"], ["2026-10-09 T 14:30", "2026. 10. 09. 14:30", "2026-10-09T14:30:00"],
      ["2026-1-5 7:00", "2026. 01. 05. 07:00", "2026-01-05T07:00:00"], ["2026-12-31T23:59:59", "2026. 12. 31. 23:59:59", "2026-12-31T23:59:59"],
      ["2000-02-29T00:00:00", "2000. 02. 29. 00:00:00", "2000-02-29T00:00:00"],
    ],
    ["2026-10-09", "2026-10-09 24:00", "2026-10-09 23:60", "2026-10-09 23:59:60", "2026-10-09T14:30Z", "2026-10-09T14:30+09:00", "2026-10-09 14", "2026-10-09 1430",
      "2026-02-30 10:00", "2026-10-0914:30", 20261009, "2026-10-09 14:30:15.5", true, "14:30"],
    "날짜·시각",
  );
});

test("#131 boolean: true/false·Y/N(대소문자 무시)·예/아니오·아니요만, 1/0은 거절, 출력 기본 예·아니오", () => {
  const yes: Ok[] = [true, "true", "TRUE", "True", " true ", "Y", "y", "예", " 예 "].map((raw) => [raw, "예", "true"]);
  const no: Ok[] = [false, "false", "FALSE", "N", "n", "아니오", "False", "아니요", " 아니요 "].map((raw) => [raw, "아니오", "false"]);
  table("boolean", [...yes, ...no], [1, 0, "1", "0", "yes", "no", "네", "참", "거짓", "O", "X", "t", "f"], "참/거짓");
});

test("#131 text: 원문 그대로(앞자리 0·전화 꼴 보존, 수·참거짓은 글), 정규 꼴 없음", () => {
  const rows: [unknown, string][] = [["007", "007"], ["02-0000-0000", "02-0000-0000"], ["0012-345", "0012-345"], [1234, "1234"], [true, "true"], ["", ""], ["  ", "  "], ["1,234원", "1,234원"]];
  for (const [raw, text] of rows) assert.deepEqual(readTypedValue("text", raw), { ok: true, text }, JSON.stringify(raw));
  for (const raw of [{}, [], null, undefined]) {
    const r = readTypedValue("money", raw);
    assert.ok(!r.ok && r.code === "DATA_NOT_SCALAR");
  }
});

test("#131 빈 값: text 밖 형식의 빈 글·공백뿐인 글은 빈 값(text 빈 글, 정규 꼴·수 없음). null·없음은 bindValues의 누락", () => {
  for (const format of ["number", "money", "percent", "date", "datetime", "boolean"] as const) {
    for (const raw of ["", "   ", "　"]) assert.deepEqual(readTypedValue(format, raw), { ok: true, text: "" }, `${format} ${JSON.stringify(raw)}`);
  }
});

test("#131 표시 설정 덮기: 쉼표·음수 △·단위, 날짜·시각 꼴, 참거짓 글", () => {
  const rows: [ValueFormat, unknown, ValueDisplay, string][] = [
    ["money", -1234, { negative: "△" }, "△1,234원"],
    ["money", "1234567", { grouping: false }, "1234567원"],
    ["money", "1,234", { unit: "" }, "1,234"],
    ["money", "1,234", { unit: "원정" }, "1,234원정"],
    ["money", "-0.50", { negative: "△" }, "△0.50원"],
    ["money", "-0.00", { negative: "△" }, "0.00원"],
    ["number", "1234.50", { grouping: false }, "1234.50"],
    ["number", -5, { negative: "△" }, "△5"],
    ["percent", "12.5", { unit: " %" }, "12.5 %"],
    ["percent", "-12.5%", { unit: "퍼센트", negative: "△" }, "△12.5퍼센트"],
    ["percent", "12.5", { unit: "" }, "12.5"],
    ["date", "2026-10-09", { pattern: "YYYY년 M월 D일" }, "2026년 10월 9일"],
    ["date", "20260105", { pattern: "YYYY-MM-DD" }, "2026-01-05"],
    ["date", "2026.1.5", { pattern: "M/D" }, "1/5"],
    ["datetime", "2026-10-09 09:05", { pattern: "YYYY. M. D. H시 mm분" }, "2026. 10. 9. 9시 05분"],
    ["datetime", "2026-10-09 09:05", { pattern: "YYYY-MM-DD HH:mm:ss" }, "2026-10-09 09:05:00"],
    ["datetime", "2026-10-09 09:05:07", { pattern: "HH:mm" }, "09:05"],
    ["boolean", "Y", { yes: "■", no: "□" }, "■"],
    ["boolean", "N", { yes: "■", no: "□" }, "□"],
    ["boolean", "아니오", { yes: "해당", no: "" }, ""],
  ];
  for (const [format, raw, display, text] of rows) {
    const r = readTypedValue(format, raw, display);
    assert.ok(r.ok, `${format} ${JSON.stringify(display)}`);
    assert.equal(r.text, text, `${format} ${JSON.stringify(display)}`);
  }
  // 표시 설정은 정규 꼴을 바꾸지 않는다
  const a = readTypedValue("money", -1234, { negative: "△", grouping: false, unit: "" });
  const b = readTypedValue("money", -1234);
  assert.ok(a.ok && b.ok && a.normalized === b.normalized && a.number === b.number);
  assert.deepEqual([valueUnit("money"), valueUnit("money", { unit: "" }), valueUnit("percent"), valueUnit("percent", { unit: "퍼센트" }), valueUnit("number"), valueUnit("text")], ["원", undefined, "%", "퍼센트", undefined, undefined]);
});

test("#131 placeText: 자리 바로 뒤 글(공백 건너뜀)이 같은 단위로 시작하면 단위를 뗀다. 그 밖은 그대로", () => {
  const rows: [string, string | undefined, string, string][] = [
    ["1,234원", "원", "원", "1,234"],
    ["1,234원", "원", "원정(부가세 포함)", "1,234"],
    ["1,234원", "원", " 원", "1,234"],
    ["1,234원", "원", "　원", "1,234"],
    ["1,234원", "원", "\t원", "1,234"],
    ["1,234원", "원", "입니다", "1,234원"],
    ["1,234원", "원", "", "1,234원"],
    ["1,234원", "원", "\n원", "1,234원"],
    ["12.5%", "%", "%", "12.5"],
    ["12.5%", "%", " % 이상", "12.5"],
    ["12.5%", "%", "퍼센트", "12.5%"],
    ["", "원", "원", ""],
    ["1,234", undefined, "원", "1,234"],
    ["1,234원정", "원정", "원정", "1,234"],
    ["천원", undefined, "원", "천원"],
  ];
  for (const [text, unit, after, want] of rows) assert.equal(placeText(text, unit, after), want, `${text} | ${JSON.stringify(after)}`);
});

// ── 템플릿의 display 읽기 ───────────────────────────────────────

const TYPED_RAW = (values: unknown[]): Record<string, unknown> => ({
  schema: "hwpx-studio/template@2", id: "t00000131", version: 1, source: { kind: "hwpx", sha256: SHA }, anchors: [],
  values, bindings: [], places: [], slots: [], blocks: [],
});

test("#131 템플릿 values[].display: 형식마다 정한 키만 읽고, 정규 쓰기 → 읽기가 같다", () => {
  const values = [
    { id: "v1", name: "금액", format: "money", display: { negative: "△", grouping: false, unit: "" } },
    { id: "v2", name: "날짜", format: "date", display: { pattern: "YYYY년 M월 D일" } },
    { id: "v3", name: "시각", format: "datetime", display: { pattern: "YYYY-MM-DD HH:mm:ss" } },
    { id: "v4", name: "여부", format: "boolean", display: { yes: "■", no: "" } },
    { id: "v5", name: "수량", format: "number", display: { grouping: false } },
    { id: "v6", name: "율", format: "percent", display: { unit: " %" } },
    { id: "v7", name: "글", format: "text" },
    { id: "v8", name: "빈 설정", format: "money", display: {} },
  ];
  const t = readStudioTemplate(JSON.stringify(TYPED_RAW(values)));
  assert.ok(t.schema === "hwpx-studio/template@2");
  assert.deepEqual(t.values, values);
  const again = readStudioTemplate(writeStudioTemplate(t));
  assert.equal(writeStudioTemplate(again), writeStudioTemplate(t));
});

test("#131 템플릿 values[].display 거절(TPL_FIELD): text에 display, 형식에 없는 키, 틀린 값, 제어 문자·줄바꿈, 길이, date 꼴의 시각 자리 표시", () => {
  const rows: [string, unknown][] = [
    ["text에 display", { format: "text", display: {} }],
    ["money에 pattern", { format: "money", display: { pattern: "YYYY" } }],
    ["date에 unit", { format: "date", display: { unit: "일" } }],
    ["boolean에 grouping", { format: "boolean", display: { grouping: true } }],
    ["number에 unit", { format: "number", display: { unit: "개" } }],
    ["date 꼴에 HH", { format: "date", display: { pattern: "YYYY-MM-DD HH" } }],
    ["date 꼴에 mm", { format: "date", display: { pattern: "YYYY.mm" } }],
    ["negative가 +", { format: "money", display: { negative: "+" } }],
    ["negative가 ▲", { format: "money", display: { negative: "▲" } }],
    ["grouping이 글", { format: "number", display: { grouping: "yes" } }],
    ["unit 줄바꿈", { format: "money", display: { unit: "원\n" } }],
    ["unit 11자", { format: "money", display: { unit: "가".repeat(11) } }],
    ["pattern 빈 글", { format: "date", display: { pattern: "" } }],
    ["pattern 41자", { format: "date", display: { pattern: "Y".repeat(41) } }],
    ["yes 탭", { format: "boolean", display: { yes: "a\tb" } }],
    ["no 제어 문자", { format: "boolean", display: { no: "\u0001" } }],
    ["display가 배열", { format: "money", display: [] }],
    ["display가 글", { format: "money", display: "△" }],
    ["모르는 키", { format: "money", display: { sign: "△" } }],
    ["형식 이름이 7종 밖", { format: "phone" }],
    ["형식 이름 대문자", { format: "Money" }],
  ];
  for (const [name, part] of rows) {
    let err: unknown;
    try {
      readStudioTemplate(JSON.stringify(TYPED_RAW([{ id: "v1", name: "값", ...(part as Record<string, unknown>) }])));
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof HwpxError, `${name}: 거절해야 한다`);
    assert.equal(err.code, "TPL_FIELD", `${name}: ${err.message}`);
    assert.ok(err.where?.startsWith("values[0]"), `${name}: 위치 ${err.where}`);
  }
});

// ── bindValues와 조건 ──────────────────────────────────────────

const FORMATS: ValueFormat[] = ["text", "number", "money", "percent", "date", "datetime", "boolean"];

function typedTemplate(when: Record<string, unknown>[]): StudioTemplate {
  const raw = {
    ...TYPED_RAW(FORMATS.map((f, i) => ({ id: `v${i + 1}`, name: f, format: f }))),
    bindings: FORMATS.map((f, i) => ({ value: `v${i + 1}`, key: f })),
    anchors: [{ id: "a1", kind: "line", at: { sectionIndex: 0, path: [1] }, print: { text: "", sha256: SHA } }],
    slots: [{ id: "s1", name: "조건", anchors: ["a1"], parent: null }],
    blocks: [...when.map((w, i) => ({ id: `b${i + 1}`, slot: "s1", name: `b${i + 1}`, priority: when.length - i, content: { text: `블록 ${i + 1}` }, when: w })), { id: "b0", slot: "s1", name: "없음", content: { text: "기본" } }],
  };
  const t = readStudioTemplate(JSON.stringify(raw));
  assert.ok(t.schema === "hwpx-studio/template@2");
  return t;
}

test("#131 bindValues: 7종의 state·text·normalized·number, DATA_FORMAT 사유에 타입 이름(값 원문 없음), valueEdits도 같은 규칙", () => {
  const t = typedTemplate([]);
  const row = { text: "007", number: "1,234.50", money: "금 1,234,000원정", percent: "12.5%", date: "2026. 10. 9.", datetime: "2026-10-09T14:30", boolean: "Y" };
  const v = bindValues(t, row, undefined);
  assert.deepEqual(
    v.map((x) => [x.format, x.state, x.text, x.normalized, x.number]),
    [
      ["text", "bound", "007", undefined, undefined],
      ["number", "bound", "1,234.50", "1234.50", 1234.5],
      ["money", "bound", "1,234,000원", "1234000", 1234000],
      ["percent", "bound", "12.5%", "12.5", 12.5],
      ["date", "bound", "2026. 10. 09.", "2026-10-09", undefined],
      ["datetime", "bound", "2026. 10. 09. 14:30", "2026-10-09T14:30:00", undefined],
      ["boolean", "bound", "예", "true", undefined],
    ],
  );
  const secret = "비밀값-2026-13-45";
  const bad = bindValues(t, { ...row, date: secret, money: secret }, undefined);
  for (const x of bad.filter((x) => x.format === "date" || x.format === "money")) {
    assert.equal(x.state, "rejected");
    assert.equal(x.issue?.code, "DATA_FORMAT");
    assert.ok(x.issue?.message.includes(`(${x.format})`) && !x.issue.message.includes(secret), x.issue?.message);
  }
  // 빈 글은 empty, null은 missing(누락 정책)
  const empty = bindValues(t, { ...row, money: "", date: "  " }, undefined, { missing: "keep" });
  assert.deepEqual(empty.filter((x) => x.format === "money" || x.format === "date").map((x) => [x.state, x.text]), [["empty", ""], ["empty", ""]]);
  const missing = bindValues(t, { ...row, money: null }, undefined);
  assert.equal(missing.find((x) => x.format === "money")?.issue?.code, "DATA_MISSING");
  // valueEdits도 같은 규칙으로 읽는다
  const c = { schema: "hwpx-studio/case@1" as const, template: { id: t.id, version: 1, sha256: SHA }, record: { dataset: "d00000001", version: 1, row: 0, sha256: SHA }, selections: {}, valueEdits: { v3: "△5,000", v5: "20261231" }, blockEdits: {} };
  const edited = bindValues(t, row, c);
  assert.deepEqual(edited.filter((x) => x.state === "edited").map((x) => [x.text, x.normalized]), [["-5,000원", "-5000"], ["2026. 12. 31.", "2026-12-31"]]);
});

test("#131 selectSlots: 조건은 꾸미기 전 값으로 비교한다(수는 수, 날짜·시각은 정규 꼴 글, 참거짓은 참거짓, 빈 값은 빈 글)", () => {
  const base = { text: "가", number: "7", money: "1,234,000원", percent: "12.5%", date: "2026. 10. 9.", datetime: "2026-10-09 14:30", boolean: "Y" };
  const cases: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    ["금액 ge 1백만", base, { path: "v3", op: "ge", value: 1000000 }, "b1"],
    ["금액 lt 1백만", base, { path: "v3", op: "lt", value: 1000000 }, "b0"],
    ["소수 금액 gt 1234", { ...base, money: "1,234.5" }, { path: "v3", op: "gt", value: 1234 }, "b1"],
    ["△ 음수 금액 lt 0", { ...base, money: "△300" }, { path: "v3", op: "lt", value: 0 }, "b1"],
    ["백분율 ge 10", base, { path: "v4", op: "ge", value: 10 }, "b1"],
    ["수 eq 7(글 7.0)", { ...base, number: "7.0" }, { path: "v2", op: "eq", value: 7 }, "b1"],
    ["날짜 ge 2026-10-01", base, { path: "v5", op: "ge", value: "2026-10-01" }, "b1"],
    ["날짜 lt 2026-10-01", base, { path: "v5", op: "lt", value: "2026-10-01" }, "b0"],
    ["날짜 eq(다른 꼴 입력)", { ...base, date: "20261009" }, { path: "v5", op: "eq", value: "2026-10-09" }, "b1"],
    ["시각 lt 15시", base, { path: "v6", op: "lt", value: "2026-10-09T15:00:00" }, "b1"],
    ["참거짓 eq true(Y)", base, { path: "v7", op: "eq", value: true }, "b1"],
    ["참거짓 eq true(아니오)", { ...base, boolean: "아니오" }, { path: "v7", op: "eq", value: true }, "b0"],
    ["참거짓 eq false(N)", { ...base, boolean: "n" }, { path: "v7", op: "eq", value: false }, "b1"],
    ["빈 금액은 empty", { ...base, money: "" }, { path: "v3", op: "empty" }, "b1"],
    ["빈 금액은 ge 0이 아니다", { ...base, money: "" }, { path: "v3", op: "ge", value: 0 }, "b0"],
  ];
  for (const [name, row, when, want] of cases) {
    const t = typedTemplate([when]);
    const sel = selectSlots(t, bindValues(t, row, undefined), undefined);
    assert.equal(sel[0]?.block, want, `${name}: ${sel[0]?.message}`);
  }
  // 읽지 못하는 값을 조건이 쓰면 판정하지 않는다
  const t = typedTemplate([{ path: "v5", op: "ge", value: "2026-01-01" }]);
  const sel = selectSlots(t, bindValues(t, { ...base, date: "2026-02-30" }, undefined), undefined);
  assert.deepEqual([sel[0]?.state, sel[0]?.reason], ["undecided", "valueRejected"]);
});
