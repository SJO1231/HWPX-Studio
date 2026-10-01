import { HwpxError } from "../errors.ts";
import { isValidPath } from "./placeholder.ts";
import { MAX_PATTERN_LENGTH, hasNestedQuantifier } from "./regex.ts";
import {
  CONDITION_OPS,
  DATASET_SCHEMA,
  TEMPLATE_SCHEMA,
  type Action,
  type Anchor,
  type AnchorAt,
  type Condition,
  type Dataset,
  type InsertStyle,
  type MissingPolicy,
  type MixedFormatPolicy,
  type Op,
  type Position,
  type Rule,
  type Template,
  type ValueSource,
} from "./types.ts";

type Obj = Record<string, unknown>;

const MAX_CONDITION_DEPTH = 32;
const POSITIONS: readonly string[] = ["before", "after", "replace"];

function fail(code: string, message: string, where?: string): never {
  throw new HwpxError(code, where === undefined ? message : `${where}: ${message}`, where);
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, where: string, code: string): Obj {
  if (!isObj(v)) fail(code, "객체여야 합니다.", where);
  return v;
}

function onlyKeys(o: Obj, allowed: readonly string[], where: string, code: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) fail(code, `알 수 없는 키 '${key}'가 있습니다.`, where);
  }
}

function str(o: Obj, key: string, where: string, code: string, nonEmpty = true): string {
  const v = o[key];
  if (typeof v !== "string" || (nonEmpty && v === "")) fail(code, `${key}가 ${nonEmpty ? "비어 있지 않은 " : ""}문자열이 아닙니다.`, where);
  return v;
}

function int(o: Obj, key: string, where: string, code: string, min = 0): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) fail(code, `${key}가 ${min} 이상의 정수가 아닙니다.`, where);
  return v;
}

function list(o: Obj, key: string, where: string, code: string): unknown[] {
  const v = o[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(code, `${key}가 배열이 아닙니다.`, where);
  return v;
}

function parseJson(text: string, code: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    return fail(code, `${what}을(를) JSON으로 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 앵커 ────────────────────────────────────────────────────────

function readAt(v: unknown, where: string): AnchorAt {
  const at = obj(v, `${where}.at`, "TPL_ANCHOR");
  onlyKeys(at, ["sectionIndex", "path"], `${where}.at`, "TPL_ANCHOR");
  const path = at["path"];
  if (!Array.isArray(path) || path.length === 0 || path.length % 2 === 0 || !path.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) {
    fail("TPL_ANCHOR", "path는 [문단, 하위목록, 문단, ...] 꼴(홀수 길이)의 0 이상 정수 배열이어야 합니다.", `${where}.at`);
  }
  return { sectionIndex: int(at, "sectionIndex", `${where}.at`, "TPL_ANCHOR"), path: path as number[] };
}

function readAnchor(v: unknown, index: number): Anchor {
  const where = `anchors[${index}]`;
  const a = obj(v, where, "TPL_ANCHOR");
  const id = str(a, "id", where, "TPL_ANCHOR");
  const kind = a["kind"];
  switch (kind) {
    case "field": {
      onlyKeys(a, ["id", "kind", "name", "occurrence"], where, "TPL_ANCHOR");
      const out: Anchor = { id, kind, name: str(a, "name", where, "TPL_ANCHOR") };
      if (a["occurrence"] !== undefined) out.occurrence = int(a, "occurrence", where, "TPL_ANCHOR");
      return out;
    }
    case "word": {
      onlyKeys(a, ["id", "kind", "at", "start", "end", "print"], where, "TPL_ANCHOR");
      const start = int(a, "start", where, "TPL_ANCHOR");
      const end = int(a, "end", where, "TPL_ANCHOR");
      if (end <= start) fail("TPL_ANCHOR", "end가 start보다 커야 합니다.", where);
      const print = obj(a["print"], `${where}.print`, "TPL_ANCHOR");
      onlyKeys(print, ["text", "before", "after"], `${where}.print`, "TPL_ANCHOR");
      return {
        id,
        kind,
        at: readAt(a["at"], where),
        start,
        end,
        print: {
          text: str(print, "text", `${where}.print`, "TPL_ANCHOR"),
          before: str(print, "before", `${where}.print`, "TPL_ANCHOR", false),
          after: str(print, "after", `${where}.print`, "TPL_ANCHOR", false),
        },
      };
    }
    case "line": {
      onlyKeys(a, ["id", "kind", "at", "print"], where, "TPL_ANCHOR");
      const print = obj(a["print"], `${where}.print`, "TPL_ANCHOR");
      onlyKeys(print, ["text", "sha256"], `${where}.print`, "TPL_ANCHOR");
      const sha256 = str(print, "sha256", `${where}.print`, "TPL_ANCHOR");
      if (!/^[0-9a-f]{64}$/i.test(sha256)) fail("TPL_ANCHOR", "print.sha256이 sha256(16진 64자)이 아닙니다.", where);
      return {
        id,
        kind,
        at: readAt(a["at"], where),
        print: { text: str(print, "text", `${where}.print`, "TPL_ANCHOR", false), sha256: sha256.toLowerCase() },
      };
    }
    case "cell": {
      onlyKeys(a, ["id", "kind", "table", "row", "col"], where, "TPL_ANCHOR");
      const table = obj(a["table"], `${where}.table`, "TPL_ANCHOR");
      onlyKeys(table, ["sectionIndex", "ordinal"], `${where}.table`, "TPL_ANCHOR");
      return {
        id,
        kind,
        table: { sectionIndex: int(table, "sectionIndex", `${where}.table`, "TPL_ANCHOR"), ordinal: int(table, "ordinal", `${where}.table`, "TPL_ANCHOR") },
        row: int(a, "row", where, "TPL_ANCHOR"),
        col: int(a, "col", where, "TPL_ANCHOR"),
      };
    }
    case "object": {
      onlyKeys(a, ["id", "kind", "objectType", "sectionIndex", "ordinal"], where, "TPL_ANCHOR");
      return {
        id,
        kind,
        objectType: str(a, "objectType", where, "TPL_ANCHOR"),
        sectionIndex: int(a, "sectionIndex", where, "TPL_ANCHOR"),
        ordinal: int(a, "ordinal", where, "TPL_ANCHOR"),
      };
    }
    default:
      return fail("TPL_ANCHOR", `알 수 없는 앵커 종류 ${JSON.stringify(kind)}입니다(field·word·line·cell·object).`, where);
  }
}

// ── 조건 ────────────────────────────────────────────────────────

const OPS: readonly string[] = CONDITION_OPS;
const NEEDS_VALUE = new Set(["eq", "ne", "gt", "ge", "lt", "le", "contains", "in", "matches", "lengthEq", "lengthGt", "lengthLt"]);

function readCondition(v: unknown, where: string, depth: number): Condition {
  if (depth > MAX_CONDITION_DEPTH) fail("TPL_CONDITION", `조건이 ${MAX_CONDITION_DEPTH}단계보다 깊습니다.`, where);
  const c = obj(v, where, "TPL_CONDITION");
  if ("all" in c || "any" in c) {
    const key = "all" in c ? "all" : "any";
    onlyKeys(c, [key], where, "TPL_CONDITION");
    const items = c[key];
    if (!Array.isArray(items)) fail("TPL_CONDITION", `${key}가 배열이 아닙니다.`, where);
    const parsed = items.map((x, i) => readCondition(x, `${where}.${key}[${i}]`, depth + 1));
    return key === "all" ? { all: parsed } : { any: parsed };
  }
  if ("not" in c) {
    onlyKeys(c, ["not"], where, "TPL_CONDITION");
    return { not: readCondition(c["not"], `${where}.not`, depth + 1) };
  }
  onlyKeys(c, ["path", "op", "value"], where, "TPL_CONDITION");
  const path = str(c, "path", where, "TPL_CONDITION");
  if (!isValidPath(path)) fail("TPL_CONDITION", `경로 '${path}'가 올바르지 않습니다(이름(.이름)*).`, where);
  const op = c["op"];
  if (typeof op !== "string" || !OPS.includes(op)) fail("TPL_CONDITION", `알 수 없는 연산자 ${JSON.stringify(op)}입니다.`, where);
  const value = c["value"];
  if (NEEDS_VALUE.has(op) && value === undefined) fail("TPL_CONDITION", `연산자 ${op}에는 value가 필요합니다.`, where);
  if (op === "in" && !Array.isArray(value)) fail("TPL_CONDITION", "in의 value는 배열이어야 합니다.", where);
  if (op === "matches") {
    if (typeof value !== "string") fail("TPL_CONDITION", "matches의 value는 정규식 문자열이어야 합니다.", where);
    try {
      new RegExp(value);
    } catch {
      fail("TPL_CONDITION", "matches의 value가 올바른 정규식이 아닙니다.", where);
    }
    // 실행 시간을 막는 보수적인 한도(휴리스틱): 긴 패턴과 중첩 수량자 패턴(`(a+)+` 등)은 입력 길이에 지수로 늘어나는 시간을 쓸 수 있다
    if (value.length > MAX_PATTERN_LENGTH) {
      fail("TPL_CONDITION", `matches의 value(정규식)가 ${MAX_PATTERN_LENGTH}자를 넘습니다(${value.length}자).`, where);
    }
    if (hasNestedQuantifier(value)) {
      fail("TPL_CONDITION", "matches의 value에 수량자가 붙은 묶음 안에 다시 수량자가 있습니다(중첩 수량자). 실행 시간이 폭증할 수 있어 거절합니다.", where);
    }
  }
  if (op.startsWith("length") && (typeof value !== "number" || !Number.isFinite(value))) {
    fail("TPL_CONDITION", `${op}의 value는 숫자여야 합니다.`, where);
  }
  const out: Condition = { path, op: op as Op };
  if (value !== undefined) out.value = value;
  return out;
}

// ── 규칙 ────────────────────────────────────────────────────────

function readValueSource(v: unknown, where: string): ValueSource {
  const s = obj(v, where, "TPL_RULE");
  onlyKeys(s, ["path", "text"], where, "TPL_RULE");
  if ((s["path"] === undefined) === (s["text"] === undefined)) fail("TPL_RULE", "value에는 path와 text 가운데 하나만 있어야 합니다.", where);
  if (s["path"] !== undefined) {
    const path = str(s, "path", where, "TPL_RULE");
    if (!isValidPath(path)) fail("TPL_RULE", `경로 '${path}'가 올바르지 않습니다(이름(.이름)*).`, where);
    return { path };
  }
  return { text: str(s, "text", where, "TPL_RULE", false) };
}

function readPosition(a: Obj, where: string): Position {
  const p = a["position"];
  if (typeof p !== "string" || !POSITIONS.includes(p)) fail("TPL_RULE", "position은 before·after·replace 가운데 하나여야 합니다.", where);
  return p as Position;
}

function readStyle(v: unknown, where: string): InsertStyle {
  if (v === undefined || v === "inherit") return "inherit";
  const s = obj(v, `${where}.style`, "TPL_RULE");
  onlyKeys(s, ["paraPrIDRef", "charPrIDRef", "styleIDRef"], `${where}.style`, "TPL_RULE");
  const ref = (key: string): string => {
    const x = s[key];
    if (typeof x === "number" && Number.isInteger(x) && x >= 0) return String(x);
    if (typeof x === "string" && /^\d+$/.test(x)) return x;
    return fail("TPL_RULE", `style.${key}가 0 이상의 정수(또는 숫자 문자열)가 아닙니다.`, where);
  };
  return { paraPrIDRef: ref("paraPrIDRef"), charPrIDRef: ref("charPrIDRef"), styleIDRef: ref("styleIDRef") };
}

const FILL_KINDS = ["field", "word", "line", "cell"];
const DELETE_KINDS = ["line", "object", "cell"];

function readAction(v: unknown, where: string, kinds: Map<string, string>): Action {
  const a = obj(v, where, "TPL_RULE");
  const type = a["type"];
  const anchor = str(a, "anchor", where, "TPL_RULE");
  const kind = kinds.get(anchor);
  if (kind === undefined) fail("TPL_UNKNOWN_ANCHOR", `앵커 '${anchor}'가 템플릿에 없습니다.`, where);
  const need = (allowed: readonly string[]): void => {
    if (!allowed.includes(kind)) fail("TPL_RULE", `${String(type)}는 ${allowed.join("·")} 앵커에만 쓸 수 있습니다(앵커 '${anchor}'는 ${kind}).`, where);
  };
  switch (type) {
    case "fill":
      onlyKeys(a, ["type", "anchor", "value"], where, "TPL_RULE");
      need(FILL_KINDS);
      return { type, anchor, value: readValueSource(a["value"], `${where}.value`) };
    case "delete": {
      onlyKeys(a, ["type", "anchor", "scope"], where, "TPL_RULE");
      need(DELETE_KINDS);
      const scope = a["scope"];
      if (scope !== undefined && scope !== "row") fail("TPL_RULE", "scope는 row만 쓸 수 있습니다.", where);
      if (kind === "cell" && scope !== "row") fail("TPL_RULE", "cell 앵커의 delete에는 scope: \"row\"가 필요합니다.", where);
      if (kind !== "cell" && scope !== undefined) fail("TPL_RULE", "scope는 cell 앵커에만 쓸 수 있습니다.", where);
      return scope === undefined ? { type, anchor } : { type, anchor, scope };
    }
    case "inject": {
      onlyKeys(a, ["type", "anchor", "position", "fragment"], where, "TPL_RULE");
      need(["line"]);
      const fragment = a["fragment"];
      if (!(typeof fragment === "string" && fragment !== "") && !isObj(fragment)) {
        fail("TPL_RULE", "fragment는 조각 JSON 경로(문자열)나 조각 객체여야 합니다.", where);
      }
      return { type, anchor, position: readPosition(a, where), fragment };
    }
    case "insertText":
      onlyKeys(a, ["type", "anchor", "position", "value", "style"], where, "TPL_RULE");
      need(["line"]);
      return {
        type,
        anchor,
        position: readPosition(a, where),
        value: readValueSource(a["value"], `${where}.value`),
        style: readStyle(a["style"], where),
      };
    default:
      return fail("TPL_RULE", `알 수 없는 액션 종류 ${JSON.stringify(type)}입니다(fill·delete·inject·insertText).`, where);
  }
}

function readRule(v: unknown, index: number, kinds: Map<string, string>): Rule {
  const where = `rules[${index}]`;
  const r = obj(v, where, "TPL_RULE");
  onlyKeys(r, ["id", "when", "do"], where, "TPL_RULE");
  const rule: Rule = { id: str(r, "id", where, "TPL_RULE"), do: readAction(r["do"], `${where}.do`, kinds) };
  if (r["when"] !== undefined) rule.when = readCondition(r["when"], `${where}.when`, 0);
  return rule;
}

// ── 공개 ────────────────────────────────────────────────────────

/** 템플릿을 읽고 검사한다. JSON 문자열이나 이미 읽은 객체를 받는다. 틀리면 `TPL_*` 오류. */
export function readTemplate(input: unknown): Template {
  const raw = typeof input === "string" ? parseJson(input, "TPL_JSON", "템플릿") : input;
  const root = obj(raw, "템플릿", "TPL_SCHEMA");
  if (root["schema"] !== TEMPLATE_SCHEMA) fail("TPL_SCHEMA", `schema가 ${TEMPLATE_SCHEMA}가 아닙니다.`);

  const template: Template = { schema: TEMPLATE_SCHEMA, anchors: [], rules: [], options: {} };
  if (root["source"] !== undefined) {
    const source = obj(root["source"], "source", "TPL_SCHEMA");
    template.source = { sha256: str(source, "sha256", "source", "TPL_SCHEMA") };
  }

  const kinds = new Map<string, string>();
  list(root, "anchors", "템플릿", "TPL_ANCHOR").forEach((v, i) => {
    const anchor = readAnchor(v, i);
    if (kinds.has(anchor.id)) fail("TPL_ANCHOR", `앵커 id '${anchor.id}'가 겹칩니다.`, `anchors[${i}]`);
    kinds.set(anchor.id, anchor.kind);
    template.anchors.push(anchor);
  });

  const ruleIds = new Set<string>();
  list(root, "rules", "템플릿", "TPL_RULE").forEach((v, i) => {
    const rule = readRule(v, i, kinds);
    if (ruleIds.has(rule.id)) fail("TPL_RULE", `규칙 id '${rule.id}'가 겹칩니다.`, `rules[${i}]`);
    ruleIds.add(rule.id);
    template.rules.push(rule);
  });

  if (root["options"] !== undefined) {
    const o = obj(root["options"], "options", "TPL_OPTIONS");
    onlyKeys(o, ["missing", "mixedFormat"], "options", "TPL_OPTIONS");
    if (o["missing"] !== undefined) {
      if (o["missing"] !== "error" && o["missing"] !== "empty" && o["missing"] !== "keep") fail("TPL_OPTIONS", "missing은 error·empty·keep 가운데 하나여야 합니다.", "options");
      template.options.missing = o["missing"] as MissingPolicy;
    }
    if (o["mixedFormat"] !== undefined) {
      if (o["mixedFormat"] !== "skip" && o["mixedFormat"] !== "first") fail("TPL_OPTIONS", "mixedFormat은 skip·first 가운데 하나여야 합니다.", "options");
      template.options.mixedFormat = o["mixedFormat"] as MixedFormatPolicy;
    }
  }
  return template;
}

/** 앵커도 규칙도 없는 템플릿. 문서 안 `{{경로}}` 표기만 채울 때 쓴다. */
export function emptyTemplate(): Template {
  return { schema: TEMPLATE_SCHEMA, anchors: [], rules: [], options: {} };
}

/** 규칙이 가리키는 조각 JSON 경로(내장 객체는 뺀다). 파일을 읽는 쪽(CLI)이 미리 읽어 넘길 수 있게 한다. */
export function fragmentPaths(template: Template): string[] {
  const paths = new Set<string>();
  for (const rule of template.rules) {
    if (rule.do.type === "inject" && typeof rule.do.fragment === "string") paths.add(rule.do.fragment);
  }
  return [...paths];
}

/**
 * 데이터 묶음을 읽는다. `schema`가 `hwpx-studio/dataset@1`이면 묶음 형식(`data`, `derived`)이고,
 * 아니면 일반 JSON으로 보고 전체를 `data`로 본다. 틀리면 `DATA_*` 오류.
 */
export function readDataset(input: unknown): Dataset {
  const raw = typeof input === "string" ? parseJson(input, "DATA_JSON", "데이터") : input;
  if (!isObj(raw)) fail("DATA_SCHEMA", "데이터는 JSON 객체여야 합니다.");
  if (raw["schema"] !== DATASET_SCHEMA) return { data: raw, derived: {} };
  const part = (key: "data" | "derived"): Obj => {
    const v = raw[key];
    if (v === undefined) return {};
    if (!isObj(v)) fail("DATA_SCHEMA", `${key}가 객체가 아닙니다.`);
    return v;
  };
  return { data: part("data"), derived: part("derived") };
}
