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
  type CellSettingsSpec,
  type InjectAction,
  type InsertStyle,
  type MarginSpec,
  type MissingPolicy,
  type MixedFormatPolicy,
  type Op,
  type Position,
  type RepeatAction,
  type ResizeAction,
  type Rule,
  type TablePropsAction,
  type TableSettingsSpec,
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

// ── 표 액션 ─────────────────────────────────────────────────────

const MAX_UNIT = 2147483647;
const PAGE_BREAKS: readonly string[] = ["CELL", "NONE", "TABLE"];
const HALIGNS: readonly string[] = ["LEFT", "CENTER", "RIGHT"];
const VERT_ALIGNS: readonly string[] = ["TOP", "CENTER", "BOTTOM"];
const LINE_WRAPS: readonly string[] = ["BREAK", "SQUEEZE"];
const IDENT = /^[\p{L}\p{N}_-]+$/u;

function unitOf(v: unknown, what: string, where: string, min = 0): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > MAX_UNIT) fail("TPL_RULE", `${what}이(가) ${min} 이상 ${MAX_UNIT} 이하의 정수가 아닙니다.`, where);
  return v;
}

function boolOf(v: unknown, what: string, where: string): boolean {
  if (typeof v !== "boolean") fail("TPL_RULE", `${what}이(가) true나 false가 아닙니다.`, where);
  return v;
}

function enumOf<T extends string>(v: unknown, what: string, allowed: readonly string[], where: string): T {
  if (typeof v !== "string" || !allowed.includes(v)) fail("TPL_RULE", `${what}은(는) ${allowed.join("·")} 가운데 하나여야 합니다.`, where);
  return v as T;
}

function readMargin(v: unknown, what: string, where: string): MarginSpec {
  const m = obj(v, `${where}.${what}`, "TPL_RULE");
  onlyKeys(m, ["left", "right", "top", "bottom"], `${where}.${what}`, "TPL_RULE");
  const out: MarginSpec = {};
  for (const key of ["left", "right", "top", "bottom"] as const) if (m[key] !== undefined) out[key] = unitOf(m[key], `${what}.${key}`, where);
  if (Object.keys(out).length === 0) fail("TPL_RULE", `${what}에 값이 없습니다.`, where);
  return out;
}

function readTableSettings(v: unknown, where: string): TableSettingsSpec {
  const t = obj(v, `${where}.table`, "TPL_RULE");
  onlyKeys(t, ["treatAsChar", "pageBreak", "repeatHeader", "cellSpacing", "outMargin", "inMargin", "hAlign"], `${where}.table`, "TPL_RULE");
  const out: TableSettingsSpec = {};
  if (t["treatAsChar"] !== undefined) out.treatAsChar = boolOf(t["treatAsChar"], "table.treatAsChar", where);
  if (t["pageBreak"] !== undefined) out.pageBreak = enumOf(t["pageBreak"], "table.pageBreak", PAGE_BREAKS, where);
  if (t["repeatHeader"] !== undefined) out.repeatHeader = boolOf(t["repeatHeader"], "table.repeatHeader", where);
  if (t["cellSpacing"] !== undefined) out.cellSpacing = unitOf(t["cellSpacing"], "table.cellSpacing", where);
  if (t["outMargin"] !== undefined) out.outMargin = readMargin(t["outMargin"], "outMargin", where);
  if (t["inMargin"] !== undefined) out.inMargin = readMargin(t["inMargin"], "inMargin", where);
  if (t["hAlign"] !== undefined) out.hAlign = enumOf(t["hAlign"], "table.hAlign", HALIGNS, where);
  if (Object.keys(out).length === 0) fail("TPL_RULE", "table에 설정이 없습니다.", where);
  return out;
}

function readPair(v: unknown, what: string, where: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) fail("TPL_RULE", `${what}은(는) [시작, 끝] 두 정수여야 합니다.`, where);
  const from = unitOf(v[0], `${what}의 시작`, where);
  const to = unitOf(v[1], `${what}의 끝`, where);
  if (to < from) fail("TPL_RULE", `${what}의 시작이 끝보다 큽니다.`, where);
  return [from, to];
}

function readCellEntries(v: unknown, where: string): NonNullable<TablePropsAction["cells"]> {
  if (!Array.isArray(v) || v.length === 0) fail("TPL_RULE", "cells가 비어 있지 않은 배열이 아닙니다.", where);
  return v.map((x, i) => {
    const w = `${where}.cells[${i}]`;
    const c = obj(x, w, "TPL_RULE");
    onlyKeys(c, ["rows", "cols", "props"], w, "TPL_RULE");
    const p = obj(c["props"], `${w}.props`, "TPL_RULE");
    onlyKeys(p, ["vertAlign", "lineWrap", "header", "margin", "protect"], `${w}.props`, "TPL_RULE");
    const props: CellSettingsSpec = {};
    if (p["vertAlign"] !== undefined) props.vertAlign = enumOf(p["vertAlign"], "props.vertAlign", VERT_ALIGNS, w);
    if (p["lineWrap"] !== undefined) props.lineWrap = enumOf(p["lineWrap"], "props.lineWrap", LINE_WRAPS, w);
    if (p["header"] !== undefined) props.header = boolOf(p["header"], "props.header", w);
    if (p["protect"] !== undefined) props.protect = boolOf(p["protect"], "props.protect", w);
    if (p["margin"] !== undefined) props.margin = readMargin(p["margin"], "margin", w);
    if (Object.keys(props).length === 0) fail("TPL_RULE", "props에 설정이 없습니다.", w);
    return { rows: readPair(c["rows"], "rows", w), cols: readPair(c["cols"], "cols", w), props };
  });
}

function readTableProps(a: Obj, where: string, anchor: string): TablePropsAction {
  onlyKeys(a, ["type", "anchor", "table", "cells"], where, "TPL_RULE");
  if (a["table"] === undefined && a["cells"] === undefined) fail("TPL_RULE", "tableProps에는 table이나 cells가 있어야 합니다.", where);
  const out: TablePropsAction = { type: "tableProps", anchor };
  if (a["table"] !== undefined) out.table = readTableSettings(a["table"], where);
  if (a["cells"] !== undefined) out.cells = readCellEntries(a["cells"], where);
  return out;
}

function readResize(a: Obj, where: string, anchor: string): ResizeAction {
  onlyKeys(a, ["type", "anchor", "columns", "width", "scale", "rowHeights"], where, "TPL_RULE");
  const given = ["columns", "width", "scale"].filter((k) => a[k] !== undefined);
  if (given.length > 1) fail("TPL_RULE", `columns·width·scale은 하나만 줄 수 있습니다(받은 것: ${given.join(", ")}).`, where);
  if (given.length === 0 && a["rowHeights"] === undefined) fail("TPL_RULE", "resize에는 columns·width·scale·rowHeights 가운데 하나가 있어야 합니다.", where);
  const out: ResizeAction = { type: "resize", anchor };
  if (a["columns"] !== undefined) {
    const cols = a["columns"];
    if (!Array.isArray(cols) || cols.length === 0) fail("TPL_RULE", "columns가 비어 있지 않은 배열이 아닙니다.", where);
    out.columns = cols.map((c, i) => unitOf(c, `columns[${i}]`, where, 1));
  }
  if (a["width"] !== undefined) out.width = unitOf(a["width"], "width", where, 1);
  if (a["scale"] !== undefined) {
    const scale = a["scale"];
    if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) fail("TPL_RULE", "scale이 0보다 큰 수가 아닙니다.", where);
    out.scale = scale;
  }
  if (a["rowHeights"] !== undefined) {
    const rows = a["rowHeights"];
    if (!Array.isArray(rows) || rows.length === 0) fail("TPL_RULE", "rowHeights가 비어 있지 않은 배열이 아닙니다.", where);
    out.rowHeights = rows.map((x, i) => {
      const w = `${where}.rowHeights[${i}]`;
      const r = obj(x, w, "TPL_RULE");
      onlyKeys(r, ["row", "height"], w, "TPL_RULE");
      return { row: unitOf(r["row"], "row", w), height: unitOf(r["height"], "height", w) };
    });
  }
  return out;
}

function readRepeat(a: Obj, where: string, anchor: string): RepeatAction {
  onlyKeys(a, ["type", "anchor", "each", "as", "index"], where, "TPL_RULE");
  const each = obj(a["each"], `${where}.each`, "TPL_RULE");
  onlyKeys(each, ["path"], `${where}.each`, "TPL_RULE");
  const path = str(each, "path", `${where}.each`, "TPL_RULE");
  if (!isValidPath(path)) fail("TPL_RULE", `경로 '${path}'가 올바르지 않습니다(이름(.이름)*).`, where);
  const out: RepeatAction = { type: "repeat", anchor, each: { path } };
  for (const key of ["as", "index"] as const) {
    if (a[key] === undefined) continue;
    const name = str(a, key, where, "TPL_RULE");
    if (!IDENT.test(name)) fail("TPL_RULE", `${key} '${name}'은(는) 글자·숫자·_·-로 된 이름이어야 합니다.`, where);
    out[key] = name;
  }
  if ((out.as ?? "item") === out.index) fail("TPL_RULE", "as와 index는 서로 다른 이름이어야 합니다.", where);
  return out;
}

const FILL_KINDS = ["field", "word", "line", "cell"];
const DELETE_KINDS = ["line", "object", "cell"];

function readAction(v: unknown, where: string, kinds: Map<string, string>, objectTypes: Map<string, string>): Action {
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
      onlyKeys(a, ["type", "anchor", "position", "fragment", "fitTable"], where, "TPL_RULE");
      need(["line"]);
      const fragment = a["fragment"];
      if (!(typeof fragment === "string" && fragment !== "") && !isObj(fragment)) {
        fail("TPL_RULE", "fragment는 조각 JSON 경로(문자열)나 조각 객체여야 합니다.", where);
      }
      const inject: InjectAction = { type, anchor, position: readPosition(a, where), fragment };
      if (a["fitTable"] !== undefined) {
        if (a["fitTable"] !== "allowBreak") fail("TPL_RULE", "fitTable은 allowBreak만 쓸 수 있습니다.", where);
        inject.fitTable = "allowBreak";
      }
      return inject;
    }
    case "tableProps":
    case "resize":
    case "repeat": {
      need(type === "repeat" ? ["cell"] : type === "resize" ? ["object"] : ["object", "cell"]);
      // hwpx 표는 `tbl`, md 표는 `table`이다. 어느 쪽 문서에 쓸지는 이 읽기 단계가 모르므로 둘 다 받는다(텍스트 문서는 tableProps·resize를 건너뛴다)
      if (kind === "object" && objectTypes.get(anchor) !== "tbl" && objectTypes.get(anchor) !== "table") {
        fail("TPL_RULE", `${type}의 object 앵커는 표(objectType: "tbl", 텍스트 문서는 "table")여야 합니다(앵커 '${anchor}'는 ${objectTypes.get(anchor) ?? "?"}).`, where);
      }
      return type === "tableProps" ? readTableProps(a, where, anchor) : type === "resize" ? readResize(a, where, anchor) : readRepeat(a, where, anchor);
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
      return fail("TPL_RULE", `알 수 없는 액션 종류 ${JSON.stringify(type)}입니다(fill·delete·inject·insertText·tableProps·resize·repeat).`, where);
  }
}

function readRule(v: unknown, index: number, kinds: Map<string, string>, objectTypes: Map<string, string>): Rule {
  const where = `rules[${index}]`;
  const r = obj(v, where, "TPL_RULE");
  onlyKeys(r, ["id", "when", "do"], where, "TPL_RULE");
  const rule: Rule = { id: str(r, "id", where, "TPL_RULE"), do: readAction(r["do"], `${where}.do`, kinds, objectTypes) };
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
  const objectTypes = new Map<string, string>();
  list(root, "anchors", "템플릿", "TPL_ANCHOR").forEach((v, i) => {
    const anchor = readAnchor(v, i);
    if (kinds.has(anchor.id)) fail("TPL_ANCHOR", `앵커 id '${anchor.id}'가 겹칩니다.`, `anchors[${i}]`);
    kinds.set(anchor.id, anchor.kind);
    if (anchor.kind === "object") objectTypes.set(anchor.id, anchor.objectType);
    template.anchors.push(anchor);
  });

  const ruleIds = new Set<string>();
  list(root, "rules", "템플릿", "TPL_RULE").forEach((v, i) => {
    const rule = readRule(v, i, kinds, objectTypes);
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

/** 여러 건 데이터의 한 건: 읽은 데이터 묶음, 또는 그 건을 데이터로 읽을 수 없는 사유 */
export type BatchRecord = { dataset: Dataset } | { error: { code: string; message: string } };

/**
 * 여러 건 데이터를 읽는다: JSON 최상위가 배열이거나 묶음 형식(`schema`가 `hwpx-studio/dataset@1`)의 `data`가 배열이면 원소마다 한 건이다
 * (묶음의 `derived`는 모든 건이 함께 쓴다). 그 밖이면(한 건짜리 데이터) `undefined`다. 원소가 JSON 객체가 아니면 그 건만 `DATA_SCHEMA` 오류다.
 * JSON이 틀렸거나 묶음의 `derived`가 객체가 아니면 `readDataset`처럼 `DATA_*` 오류를 던진다.
 */
export function readBatchRecords(input: unknown): BatchRecord[] | undefined {
  const raw = typeof input === "string" ? parseJson(input, "DATA_JSON", "데이터") : input;
  let items: unknown[];
  let derived: Obj = {};
  if (Array.isArray(raw)) {
    items = raw;
  } else if (isObj(raw) && raw["schema"] === DATASET_SCHEMA && Array.isArray(raw["data"])) {
    items = raw["data"];
    if (raw["derived"] !== undefined) {
      if (!isObj(raw["derived"])) fail("DATA_SCHEMA", "derived가 객체가 아닙니다.");
      derived = raw["derived"];
    }
  } else {
    return undefined;
  }
  return items.map((item, i): BatchRecord =>
    isObj(item) ? { dataset: { data: item, derived } } : { error: { code: "DATA_SCHEMA", message: `${i + 1}번째 건이 JSON 객체가 아닙니다.` } },
  );
}
