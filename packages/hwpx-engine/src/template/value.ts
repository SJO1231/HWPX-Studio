import { sha256Hex } from "./hash.ts";
import type { Dataset, MissingPolicy, ValueDigest, ValueSource } from "./types.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type Lookup = { found: true; value: unknown } | { found: false };

function walk(root: unknown, path: string): Lookup {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg) || Number(seg) >= cur.length) return { found: false };
      cur = cur[Number(seg)];
    } else if (isObj(cur) && Object.hasOwn(cur, seg)) {
      cur = cur[seg];
    } else {
      return { found: false };
    }
  }
  return cur === undefined ? { found: false } : { found: true, value: cur };
}

/**
 * `data`에서 경로를 찾고, 없거나 값이 null이면 `derived`에서 찾는다. 배열은 숫자 이름으로 가리킨다.
 * `derived`에도 없으면 `data`의 결과(없음 또는 null)를 그대로 돌려준다.
 */
export function lookupPath(dataset: Dataset, path: string): Lookup {
  const inData = walk(dataset.data, path);
  if (inData.found && inData.value !== null) return inData;
  const inDerived = walk(dataset.derived, path);
  return inDerived.found ? inDerived : inData;
}

// XML 1.0이 허용하지 않는 문자: 제어 문자, U+FFFE·U+FFFF, 짝이 맞지 않는 서로게이트
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const hex = (cp: number | undefined): string => `U+${(cp ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * 글에 넣을 수 없는 문자(XML 금지 문자, 탭, 줄바꿈)가 있으면 사유를 돌려준다. 값 원문은 담지 않는다.
 * `allowNewlines`는 `insertText`처럼 줄바꿈으로 문단을 나누는 값에 쓴다(탭과 그 밖의 금지 문자는 그대로 거절).
 */
export function checkValueText(text: string, allowNewlines = false): string | undefined {
  const bad = text.search(ILLEGAL);
  if (bad >= 0) return hex(text.codePointAt(bad));
  const control = allowNewlines ? text.indexOf("\t") : text.search(/[\t\n\r]/);
  if (control >= 0) return hex(text.codePointAt(control));
  return undefined;
}

/**
 * 행 반복의 원소 하나에 대한 데이터: 원소를 `as` 이름으로, 순번(1부터)을 `index` 이름으로 전체 데이터 위에 얹는다. hwpx 표와 md 표가 같은 규칙을 쓴다.
 * 원소·순번 이름이 가리키는 경로(`as.이름`, `as`, `index`)는 원소·순번에서만 찾는다: 원소에 없다고 `derived`의 같은 이름 항목으로 넘어가지 않고
 * 누락 정책을 따른다. 같은 이름의 최상위 키(`data`·`derived` 둘 다)는 원소·순번이 가린다.
 */
export function rowDataset(base: Dataset, items: readonly unknown[], i: number, as: string, index: string | undefined): Dataset {
  const data: Record<string, unknown> = { ...base.data, [as]: items[i] };
  const derived: Record<string, unknown> = { ...base.derived };
  delete derived[as];
  if (index !== undefined) {
    data[index] = i + 1;
    delete derived[index];
  }
  return { data, derived };
}

export function digestValue(text: string): ValueDigest {
  return { length: text.length, sha256: sha256Hex(text).slice(0, 8) };
}

export type ValueOutcome =
  | { kind: "text"; text: string; path?: string }
  /** 경로가 없거나 null이고 정책이 `empty`라 빈 글을 넣는다 */
  | { kind: "empty"; path: string }
  /** 경로가 없거나 null이고 정책이 `keep`이라 자리를 그대로 둔다 */
  | { kind: "keep"; path: string }
  | { kind: "error"; code: string; message: string; path?: string };

/** 값을 글로 바꾼다. 문자열은 그대로, 숫자·불리언은 문자열로. 그 밖(객체·배열)은 undefined. */
export function scalarToText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function resolvePathValue(dataset: Dataset, path: string, policy: MissingPolicy, allowNewlines = false): ValueOutcome {
  const found = lookupPath(dataset, path);
  if (!found.found || found.value === null) {
    if (policy === "empty") return { kind: "empty", path };
    if (policy === "keep") return { kind: "keep", path };
    return { kind: "error", code: "DATA_MISSING", message: `데이터에 ${path} 값이 없습니다.`, path };
  }
  const text = scalarToText(found.value);
  if (text === undefined) {
    return { kind: "error", code: "DATA_NOT_SCALAR", message: `데이터의 ${path}는 문자열·숫자·불리언이 아닙니다.`, path };
  }
  const bad = checkValueText(text, allowNewlines);
  if (bad !== undefined) {
    return { kind: "error", code: "VALUE_CONTROL_CHAR", message: `데이터의 ${path} 값에 글에 넣을 수 없는 문자 ${bad}가 있습니다.`, path };
  }
  return { kind: "text", text, path };
}

/** 값 출처(`{path}` 또는 `{text}`)를 해석한다. 누락 정책은 `policy`를 따른다. */
export function resolveValue(
  dataset: Dataset,
  source: ValueSource,
  policy: MissingPolicy,
  allowNewlines = false,
): ValueOutcome {
  if ("text" in source) {
    const bad = checkValueText(source.text, allowNewlines);
    return bad === undefined
      ? { kind: "text", text: source.text }
      : { kind: "error", code: "VALUE_CONTROL_CHAR", message: `값에 글에 넣을 수 없는 문자 ${bad}가 있습니다.` };
  }
  return resolvePathValue(dataset, source.path, policy, allowNewlines);
}
