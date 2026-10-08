// 값 타입 7종의 읽기와 표시(엔진 명세 8.8.4, #131). 형식 중립이다(문서 모델을 모른다).
// 읽기: 데이터의 원래 값(글·수·참거짓)을 타입 규칙으로 읽어 정규 꼴(normalized)을 만든다. 수는 십진 글 그대로 다룬다
// (JavaScript 수로 바꿔 표시하지 않는다. 조건 비교용 수만 따로 만든다).
// 표시: 정규 꼴을 표시 설정(display)으로 글로 만든다. 단위(백분율 기본 %, 금액은 `display.unit`을 줄 때만)는 글 끝에 붙고, 자리 바로 뒤에 같은 단위가 있으면 생성이 뗀다(`placeText`).
// 오류 사유에는 값 원문을 넣지 않는다.

export const VALUE_FORMATS = ["text", "number", "money", "percent", "date", "datetime", "boolean"] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number];

/** 표시 설정(템플릿 `values[].display`). 형식마다 쓸 수 있는 키가 정해져 있다(`DISPLAY_KEYS`). 없는 키는 기본값이다. */
export type ValueDisplay = {
  /** number·money·percent: 정수 부분의 천 단위 쉼표(기본 true) */
  grouping?: boolean;
  /** number·money·percent: 음수 앞의 표시(기본 "-") */
  negative?: "-" | "△";
  /** money·percent: 글 끝에 붙이는 단위(기본 money 없음, percent "%"). 빈 글이면 붙이지 않는다 */
  unit?: string;
  /** date·datetime: 표시 꼴(기본 date `YYYY. MM. DD.`, datetime `YYYY. MM. DD. HH:mm`, 입력에 초가 있으면 `:ss`를 더한다) */
  pattern?: string;
  /** boolean: 참의 글(기본 "예") */
  yes?: string;
  /** boolean: 거짓의 글(기본 "아니오") */
  no?: string;
};

export const DISPLAY_KEYS: Readonly<Record<ValueFormat, readonly (keyof ValueDisplay)[]>> = {
  text: [],
  number: ["grouping", "negative"],
  money: ["grouping", "negative", "unit"],
  percent: ["grouping", "negative", "unit"],
  date: ["pattern"],
  datetime: ["pattern"],
  boolean: ["yes", "no"],
};

const DEFAULT_DATE_PATTERN = "YYYY. MM. DD.";
const DEFAULT_DATETIME_PATTERN = "YYYY. MM. DD. HH:mm";
/** 표시 꼴의 자리 표시: 연 4자리, 월·일·시 2자리(MM·DD·HH)와 앞 0 없는 꼴(M·D·H), 분 mm, 초 ss. 그 밖의 글자는 그대로 나온다 */
const PATTERN_TOKENS = /YYYY|MM|DD|HH|mm|ss|M|D|H/g;
/** 시각 자리 표시(date 꼴에는 쓸 수 없다) */
export const TIME_TOKENS = /HH|H|mm|ss/;

const LABEL: Readonly<Record<ValueFormat, string>> = {
  text: "글(text)",
  number: "수(number)",
  money: "금액(money)",
  percent: "백분율(percent)",
  date: "날짜(date)",
  datetime: "날짜·시각(datetime)",
  boolean: "참/거짓(boolean)",
};

const HINT: Readonly<Record<ValueFormat, string>> = {
  text: "",
  number: "쉼표를 넣을 수 있는 십진수여야 합니다(음수는 -)",
  money: "금·원·원정·₩(￦)·쉼표·공백을 뺀 십진수여야 합니다(음수는 - 또는 △)",
  percent: "십진수 또는 끝에 %를 붙인 십진수여야 합니다(음수는 -)",
  date: "YYYYMMDD·YYYY-MM-DD·YYYY/MM/DD·YYYY.MM.DD 꼴의 달력에 있는 날짜여야 합니다",
  datetime: "날짜 뒤에 공백이나 T와 HH:MM 또는 HH:MM:SS가 오는 달력에 있는 날짜·시각이어야 합니다",
  boolean: "true·false·Y·N·예·아니오·아니요 가운데 하나여야 합니다(1·0은 받지 않습니다)",
};

/**
 * 읽은 값. 성공이면 `text`(기본·설정 표시, 단위 포함), `normalized`(text 밖 형식의 정규 꼴), `number`(number·money·percent의 조건 비교용 수).
 * 빈 값(text 밖 형식의 빈 글·공백뿐인 글)은 `text`가 빈 글이고 `normalized`·`number`가 없다. text 형식의 빈 글도 빈 글이다.
 * 실패이면 코드와 사유(값 원문 없음, 어느 타입으로 읽으려 했는지 포함).
 */
export type TypedValue =
  | { ok: true; text: string; normalized?: string; number?: number }
  | { ok: false; code: "DATA_FORMAT" | "DATA_NOT_SCALAR"; reason: string };

type Decimal = { negative: boolean; int: string; frac: string };

// 정수 부분은 쉼표 없는 숫자 또는 천 단위로 바르게 묶은 숫자, 소수 부분은 점 뒤 숫자 1개 이상(ASCII 숫자만)
const DECIMAL = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;
// 금액 앞뒤 표기: 금, 부호(- 또는 △)와 ₩·전각 ￦(어느 쪽이 먼저든), 끝의 원·원정
const MONEY = /^금?(?:([-△])[₩￦]?|[₩￦]([-△])?)?(.*?)(?:원정|원)?$/;
const DATE = /^(\d{4})\s*([-/.])\s*(\d{1,2})\s*\2\s*(\d{1,2})(\s*\.)?$/;
const DATE_COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
const TIME_TAIL = /^(.*?)(?:\s*T\s*|\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function decimalOf(body: string, negative: boolean): Decimal | undefined {
  const m = DECIMAL.exec(body);
  if (m === null) return undefined;
  const int = (m[1] ?? "").replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const frac = m[2] ?? "";
  // -0, -0.00은 부호를 뗀다
  return { negative: negative && /[1-9]/.test(int + frac), int, frac };
}

/** JSON 수: 기본 글 꼴(String)이 십진 꼴일 때만 읽는다(지수 꼴·NaN·무한대는 읽지 못한다). -0은 0 */
function numberDecimal(n: number): Decimal | undefined {
  if (!Number.isFinite(n)) return undefined;
  const s = String(n);
  return s.startsWith("-") ? decimalOf(s.slice(1), true) : decimalOf(s, false);
}

function signed(s: string): Decimal | undefined {
  return s.startsWith("-") ? decimalOf(s.slice(1), true) : decimalOf(s, false);
}

function moneyDecimal(raw: string): Decimal | undefined {
  const m = MONEY.exec(raw.replace(/\s+/g, ""));
  if (m === null) return undefined;
  return decimalOf(m[3] ?? "", (m[1] ?? m[2]) !== undefined);
}

function percentDecimal(raw: string): Decimal | undefined {
  let s = raw.trim();
  if (s.endsWith("%")) s = s.slice(0, -1).trimEnd();
  return signed(s);
}

const daysIn = (y: number, m: number): number => (m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

type DateParts = { y: number; m: number; d: number };
type TimeParts = { h: number; mi: number; s: number; seconds: boolean };

function dateOf(s: string): DateParts | undefined {
  let y: number;
  let mo: number;
  let d: number;
  const c = DATE_COMPACT.exec(s);
  if (c !== null) {
    [y, mo, d] = [Number(c[1]), Number(c[2]), Number(c[3])];
  } else {
    const m = DATE.exec(s);
    // 끝의 점은 점으로 나눈 꼴(2026. 10. 9.)에만 쓴다
    if (m === null || (m[5] !== undefined && m[2] !== ".")) return undefined;
    [y, mo, d] = [Number(m[1]), Number(m[3]), Number(m[4])];
  }
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return undefined;
  return { y, m: mo, d };
}

function dateTimeOf(s: string): { date: DateParts; time: TimeParts } | undefined {
  const m = TIME_TAIL.exec(s);
  if (m === null) return undefined;
  const date = dateOf(m[1] ?? "");
  const h = Number(m[2]);
  const mi = Number(m[3]);
  const sec = m[4] === undefined ? 0 : Number(m[4]);
  if (date === undefined || h > 23 || mi > 59 || sec > 59) return undefined;
  return { date, time: { h, mi, s: sec, seconds: m[4] !== undefined } };
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** 표시 꼴에 날짜(와 시각)를 넣는다 */
function renderPattern(pattern: string, date: DateParts, time?: TimeParts): string {
  return pattern.replace(PATTERN_TOKENS, (t) => {
    switch (t) {
      case "YYYY":
        return pad(date.y, 4);
      case "MM":
        return pad(date.m, 2);
      case "M":
        return String(date.m);
      case "DD":
        return pad(date.d, 2);
      case "D":
        return String(date.d);
      case "HH":
        return pad(time?.h ?? 0, 2);
      case "H":
        return String(time?.h ?? 0);
      case "mm":
        return pad(time?.mi ?? 0, 2);
      default:
        return pad(time?.s ?? 0, 2);
    }
  });
}

function decimalText(v: Decimal, display: ValueDisplay): string {
  let int = v.int;
  if (display.grouping !== false) int = int.replace(/\B(?=(\d{3})+$)/g, ",");
  return `${v.negative ? (display.negative ?? "-") : ""}${int}${v.frac === "" ? "" : `.${v.frac}`}`;
}

/** money·percent의 단위(표시 설정 또는 기본. money는 기본 단위가 없다, 8.8.14). 다른 형식이거나 없거나 빈 글이면 undefined */
export function valueUnit(format: ValueFormat, display: ValueDisplay = {}): string | undefined {
  const unit = format === "money" ? display.unit : format === "percent" ? (display.unit ?? "%") : undefined;
  return unit === "" ? undefined : unit;
}

/**
 * 원래 값 하나를 형식 규칙으로 읽어 표시 글을 만든다(8.8.4). 공개 API(8.8.15).
 * - `raw`가 글·수·참거짓이 아니면 `DATA_NOT_SCALAR`, 형식 규칙에 맞지 않으면 `DATA_FORMAT`(사유에 타입 이름, 값 원문 없음).
 * - text 밖 형식에서 빈 글·공백뿐인 글은 빈 값이다(`text` 빈 글). null·없음은 호출자(`bindValues`)가 누락으로 다룬다.
 * - 글에 넣을 수 없는 제어 문자 검사(`VALUE_CONTROL_CHAR`)는 하지 않는다(`bindValues`가 한다). text 밖 형식의 표시 글은 읽은 숫자와 표시 설정으로만 만든다.
 */
export function readTypedValue(format: ValueFormat, raw: unknown, display: ValueDisplay = {}): TypedValue {
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    return { ok: false, code: "DATA_NOT_SCALAR", reason: `${LABEL[format]}(으)로 읽을 수 없습니다: 글·수·참거짓이 아닙니다` };
  }
  if (format === "text") return { ok: true, text: String(raw) };
  if (typeof raw === "string" && raw.trim() === "") return { ok: true, text: "" };
  const bad: TypedValue = { ok: false, code: "DATA_FORMAT", reason: `${LABEL[format]}(으)로 읽을 수 없습니다: ${HINT[format]}` };
  switch (format) {
    case "number":
    case "money":
    case "percent": {
      const dec =
        typeof raw === "boolean" ? undefined : typeof raw === "number" ? numberDecimal(raw) : format === "money" ? moneyDecimal(raw) : format === "percent" ? percentDecimal(raw) : signed(raw.trim());
      if (dec === undefined) return bad;
      const normalized = `${dec.negative ? "-" : ""}${dec.int}${dec.frac === "" ? "" : `.${dec.frac}`}`;
      return { ok: true, text: `${decimalText(dec, display)}${valueUnit(format, display) ?? ""}`, normalized, number: Number(normalized) };
    }
    case "date": {
      const d = typeof raw === "boolean" ? undefined : dateOf(String(raw).trim());
      if (d === undefined) return bad;
      return { ok: true, text: renderPattern(display.pattern ?? DEFAULT_DATE_PATTERN, d), normalized: `${pad(d.y, 4)}-${pad(d.m, 2)}-${pad(d.d, 2)}` };
    }
    case "datetime": {
      const dt = typeof raw === "string" ? dateTimeOf(raw.trim()) : undefined;
      if (dt === undefined) return bad;
      const { date: d, time } = dt;
      const pattern = display.pattern ?? (time.seconds ? `${DEFAULT_DATETIME_PATTERN}:ss` : DEFAULT_DATETIME_PATTERN);
      return { ok: true, text: renderPattern(pattern, d, time), normalized: `${pad(d.y, 4)}-${pad(d.m, 2)}-${pad(d.d, 2)}T${pad(time.h, 2)}:${pad(time.mi, 2)}:${pad(time.s, 2)}` };
    }
    case "boolean": {
      let b: boolean | undefined;
      if (typeof raw === "boolean") b = raw;
      else if (typeof raw === "string") {
        const s = raw.trim();
        const lower = s.toLowerCase();
        b = lower === "true" || lower === "y" || s === "예" ? true : lower === "false" || lower === "n" || s === "아니오" || s === "아니요" ? false : undefined;
      }
      if (b === undefined) return bad;
      return { ok: true, text: b ? (display.yes ?? "예") : (display.no ?? "아니오"), normalized: b ? "true" : "false" };
    }
  }
}

/**
 * 자리에 넣을 글(8.8.4·8.8.12): 값 글이 단위(percent의 %, money의 display.unit)로 끝나고 자리 바로 뒤 글(스페이스·탭·NBSP·전각 공백을 건너뜀)이
 * 같은 단위로 시작하면 단위를 뗀 글, 아니면 값 글 그대로다. 줄·칸 자리처럼 뒤 글이 없으면 `after`는 빈 글이다.
 */
export function placeText(text: string, unit: string | undefined, after: string): string {
  if (unit === undefined || !text.endsWith(unit)) return text;
  return after.replace(/^[ \t 　]+/, "").startsWith(unit) ? text.slice(0, -unit.length) : text;
}
