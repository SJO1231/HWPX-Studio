import type { StudioCase, StudioTemplate, BoundValue, BoundSource, ValueBinding, ValueDef } from "./studio-types.ts";
import type { MissingPolicy } from "./types.ts";
import { checkValueText, lookupPath, scalarToText } from "./value.ts";

// 값과 연결(엔진 명세 8.8.4): 연결로 행에서 찾고 → valueEdits가 이기고 → 형식을 적용하고 → 제어 문자를 검사한다.
// 오류는 던지지 않고 값마다 state·issue로 남긴다(값을 쓰는 자리·조건이 있을 때만 막히므로). 값 원문은 issue에 담지 않는다.

export type BindOptions = {
  /** 템플릿 options.missing 대신 쓸 누락 정책(예: 미리보기의 keep). 없으면 템플릿의 것, 그것도 없으면 error */
  missing?: MissingPolicy;
};

type Found = { raw: unknown; source: BoundSource } | { missing: true } | { issue: { code: string; message: string } };

const present = (v: unknown): boolean => v !== undefined && v !== null;

/** 연결 하나로 행에서 값을 찾는다. key·별칭 둘 이상에 값(null·없음이 아님. 빈 글은 값)이 있으면 DATA_ALIAS_CONFLICT */
function findInRecord(b: ValueBinding, record: Record<string, unknown>, def: ValueDef): Found {
  if ("path" in b) {
    const found = lookupPath({ data: record, derived: {} }, b.path);
    return found.found && found.value !== null ? { raw: found.value, source: "path" } : { missing: true };
  }
  const names = [b.key, ...(b.aliases ?? [])];
  const hits = names.filter((name) => Object.hasOwn(record, name) && present(record[name]));
  if (hits.length > 1) {
    return { issue: { code: "DATA_ALIAS_CONFLICT", message: `값 '${def.name}'의 열 ${hits.map((h) => JSON.stringify(h)).join("·")}에 값이 함께 있습니다(하나만 있어야 합니다).` } };
  }
  const hit = hits[0];
  if (hit === undefined) return { missing: true };
  return { raw: record[hit], source: hit === b.key ? "key" : "alias" };
}

const INTEGER_TEXT = /^-?[0-9]+$/;

/** money: 정수로 읽히는 값(숫자, 또는 앞뒤 공백 없는 10진 정수 글. 음수 허용)만 받는다. 안전한 정수 범위를 넘으면 거절한다. */
function moneyNumber(raw: unknown): number | undefined {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && INTEGER_TEXT.test(raw)) n = Number(raw);
  else return undefined;
  if (!Number.isSafeInteger(n)) return undefined;
  return n === 0 ? 0 : n; // -0을 0으로
}

/** 1234 → "1,234원", -1234 → "-1,234원" */
function formatMoney(n: number): string {
  const digits = String(Math.abs(n));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return `${n < 0 ? "-" : ""}${out}원`;
}

/**
 * 값 표를 만든다(8.8.4). 값마다 { id, name, format, state, text?, number?, source, issue? }이고 템플릿 values 순서다.
 * - state: bound(행에서 찾음)·edited(valueEdits)·missing(없음)·empty(빈 글)·rejected(별칭 충돌·형식·제어 문자).
 * - missing의 text는 누락 정책을 따른다: error는 issue DATA_MISSING, empty는 빈 글, keep은 text 없음(자리를 그대로 둠).
 * - record는 데이터 행(JSON 객체), c는 이번 건(없으면 valueEdits 없음). 행과 이번 건은 바꾸지 않는다.
 */
export function bindValues(t: StudioTemplate, record: Record<string, unknown>, c: StudioCase | undefined, opts: BindOptions = {}): BoundValue[] {
  const policy: MissingPolicy = opts.missing ?? t.options?.missing ?? "error";
  const bindings = new Map(t.bindings.map((b) => [b.value, b]));
  return t.values.map((def): BoundValue => {
    const base = { id: def.id, name: def.name, format: def.format };
    const edit = c !== undefined && Object.hasOwn(c.valueEdits, def.id) ? c.valueEdits[def.id] : undefined;
    let found: Found;
    if (edit !== undefined) found = { raw: edit, source: "edit" };
    else {
      const b = bindings.get(def.id);
      found = b === undefined ? { missing: true } : findInRecord(b, record, def);
    }
    if ("issue" in found) return { ...base, state: "rejected", source: "none", issue: found.issue };
    if ("missing" in found) {
      if (policy === "empty") return { ...base, state: "missing", source: "none", text: "" };
      if (policy === "keep") return { ...base, state: "missing", source: "none" };
      return { ...base, state: "missing", source: "none", issue: { code: "DATA_MISSING", message: `데이터에 값 '${def.name}'이(가) 없습니다.` } };
    }
    const { raw, source } = found;
    const reject = (code: string, message: string): BoundValue => ({ ...base, state: "rejected", source, issue: { code, message } });
    if (scalarToText(raw) === undefined) return reject("DATA_NOT_SCALAR", `값 '${def.name}'의 데이터가 문자열·숫자·불리언이 아닙니다.`);
    if (def.format === "money") {
      const n = moneyNumber(raw);
      if (n === undefined) return reject("DATA_FORMAT", `값 '${def.name}'(금액)이 정수로 읽히지 않거나 범위를 넘습니다.`);
      return { ...base, state: source === "edit" ? "edited" : "bound", source, text: formatMoney(n), number: n };
    }
    const text = scalarToText(raw) ?? "";
    const bad = checkValueText(text, "inline");
    if (bad !== undefined) return reject("VALUE_CONTROL_CHAR", `값 '${def.name}'에 글에 넣을 수 없는 문자 ${bad}가 있습니다.`);
    const state = source === "edit" ? "edited" : text === "" ? "empty" : "bound";
    return { ...base, state, source, text };
  });
}
