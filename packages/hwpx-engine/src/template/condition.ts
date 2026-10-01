import { HwpxError } from "../errors.ts";
import { MAX_MATCH_INPUT } from "./regex.ts";
import type { Condition, Dataset } from "./types.ts";
import { lookupPath } from "./value.ts";

// 규칙: 경로가 없거나 null이면 `exists`는 거짓, `empty`는 참, `ne`는 `eq`의 부정이라 참, 나머지 연산자는 거짓이다.

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

// 숫자로 읽히는 글: 선행·후행 공백이 없는 10진수(부호·소수점 허용). 지수 표기(`1e3`)·16진수·쉼표·단위는 숫자가 아니다.
const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && NUMERIC_TEXT.test(v)) return Number(v);
  return undefined;
}

/**
 * 두 값을 견준다(음수·0·양수). 양쪽이 숫자면 숫자로 견준다. 한쪽이 숫자이고 다른 쪽이 숫자로 읽히는 글이어도
 * 숫자로 견준다. 그 밖에는 문자열로 견준다(양쪽이 글이면 글자 순서). 견줄 수 없는 값(null·객체·배열)은 undefined.
 */
function compare(a: unknown, b: unknown): number | undefined {
  if (!isScalar(a) || !isScalar(b)) return undefined;
  if (typeof a === "number" || typeof b === "number") {
    const x = asNumber(a);
    const y = asNumber(b);
    if (x !== undefined && y !== undefined) return x < y ? -1 : x > y ? 1 : 0;
  }
  const s = String(a);
  const t = String(b);
  return s < t ? -1 : s > t ? 1 : 0;
}

const equals = (a: unknown, b: unknown): boolean => compare(a, b) === 0;

// 문자열 길이는 UTF-16 단위(`String.prototype.length`)다. 배열은 원소 수.
function lengthOf(v: unknown): number | undefined {
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.length;
  return undefined;
}

function isEmpty(found: boolean, v: unknown): boolean {
  return !found || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function leaf(c: { path: string; op: string; value?: unknown }, dataset: Dataset): boolean {
  const found = lookupPath(dataset, c.path);
  const v = found.found ? found.value : undefined;
  const present = found.found && v !== null;
  const arg = c.value;
  switch (c.op) {
    case "exists":
      return present;
    case "empty":
      return isEmpty(found.found, v);
    case "eq":
      return present && equals(v, arg);
    case "ne":
      return !(present && equals(v, arg));
    case "gt":
      return present && (compare(v, arg) ?? NaN) > 0;
    case "ge":
      return present && (compare(v, arg) ?? NaN) >= 0;
    case "lt":
      return present && (compare(v, arg) ?? NaN) < 0;
    case "le":
      return present && (compare(v, arg) ?? NaN) <= 0;
    case "contains":
      if (typeof v === "string") return isScalar(arg) && v.includes(String(arg));
      if (Array.isArray(v)) return v.some((x) => equals(x, arg));
      return false;
    case "in":
      return present && Array.isArray(arg) && arg.some((x) => equals(v, x));
    case "matches": {
      if (!(present && isScalar(v) && typeof arg === "string")) return false;
      const input = String(v);
      // 정규식 실행 시간을 막는다: 입력 글이 한도를 넘으면 거짓으로 넘기지 않고 오류로 중단한다(패턴은 읽을 때 걸러진다)
      if (input.length > MAX_MATCH_INPUT) {
        throw new HwpxError("TPL_CONDITION", `matches 조건의 입력 글이 ${MAX_MATCH_INPUT}자를 넘어 평가하지 않습니다(${input.length}자).`);
      }
      return new RegExp(arg).test(input);
    }
    case "lengthEq":
    case "lengthGt":
    case "lengthLt": {
      const n = lengthOf(v);
      if (n === undefined || typeof arg !== "number") return false;
      return c.op === "lengthEq" ? n === arg : c.op === "lengthGt" ? n > arg : n < arg;
    }
    default:
      return false;
  }
}

/** 조건을 데이터만 보고 판정한다. 읽을 때(`readTemplate`) 걸러 내므로 모양이 틀린 조건은 오지 않는다고 본다. */
export function evaluateCondition(condition: Condition, dataset: Dataset): boolean {
  if ("all" in condition) return condition.all.every((c) => evaluateCondition(c, dataset));
  if ("any" in condition) return condition.any.some((c) => evaluateCondition(c, dataset));
  if ("not" in condition) return !evaluateCondition(condition.not, dataset);
  return leaf(condition, dataset);
}
