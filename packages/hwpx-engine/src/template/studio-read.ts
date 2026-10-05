import { isValidPath } from "./placeholder.ts";
import { fail, int, isObj, list, obj, onlyKeys, parseJson, readAnchor, readCondition, readRule, readTemplate, str } from "./read.ts";
import {
  BLOCK_PROTO_SCHEMA,
  CASE_SCHEMA,
  PATTERN_FORMS,
  PATTERN_MATCH,
  PATTERN_PLACES,
  STUDIO_TEMPLATE_SCHEMA,
  type BlockContent,
  type BlockHistoryEntry,
  type BlockProto,
  type BlockSource,
  type CaseSelection,
  type CellPrint,
  type MergeFieldAnchor,
  type ObjectPrint,
  type ProtoRef,
  type RangeAnchor,
  type RangePrint,
  type StudioAnchor,
  type StudioCase,
  type StudioOptions,
  type StudioReadOptions,
  type StudioTemplate,
  type TemplateBlock,
  type TemplateOrigin,
  type TemplatePattern,
  type TemplateSlot,
  type ValueBinding,
  type ValueDef,
  type ValuePlace,
} from "./studio-types.ts";
import { contentSha256, templateSha256 } from "./studio-write.ts";
import { TEMPLATE_SCHEMA, type Condition, type Rule, type Template } from "./types.ts";

// 2판 템플릿·원형·이번 건 읽기와 검사(엔진 명세 8.8.10). 첫 오류에서 멈추고 HwpxError를 던진다. 아무것도 쓰지 않는다.

type Obj = Record<string, unknown>;

const FIELD = "TPL_FIELD";
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const TEMPLATE_ID_RE = /^t[0-9a-f]{8}$/;
const PROTO_ID_RE = /^k[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-fA-F]{64}$/;
const nfc = (s: string): string => s.normalize("NFC");

// ── 공통 읽기 도우미 ────────────────────────────────────────────

/** JSON의 -0을 0으로 바꾼다. 정규 쓰기는 -0을 0으로 쓰므로, 읽기 → 쓰기 → 읽기가 같게 하려는 것이다. */
function positiveZero(v: unknown): unknown {
  if (Object.is(v, -0)) return 0;
  if (Array.isArray(v)) return v.map(positiveZero);
  if (isObj(v)) {
    for (const key of Object.keys(v)) v[key] = positiveZero(v[key]);
  }
  return v;
}

const readJson = (json: string, what: string): unknown => positiveZero(parseJson(json, "TPL_JSON", what));

function sha(o: Obj, key: string, where: string, code: string = FIELD): string {
  const v = str(o, key, where, code);
  if (!SHA_RE.test(v)) fail(code, `${key}가 sha256(16진 64자)이 아닙니다.`, where);
  return v.toLowerCase();
}

function reqList(o: Obj, key: string, where: string): unknown[] {
  if (o[key] === undefined) fail(FIELD, `필수 필드 ${key}가 없습니다.`, where);
  return list(o, key, where, FIELD);
}

function bool(o: Obj, key: string, where: string, code: string = FIELD): boolean {
  const v = o[key];
  if (typeof v !== "boolean") fail(code, `${key}가 true나 false가 아닙니다.`, where);
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], where: string, code: string = FIELD): T {
  const v = o[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) fail(code, `${key}는 ${allowed.join("·")} 가운데 하나여야 합니다.`, where);
  return v as T;
}

/** 내부 id: 형식이 틀리면 TPL_ID, 문자열이 아니거나 없으면 TPL_FIELD */
function idOf(o: Obj, where: string): string {
  const v = o["id"];
  if (typeof v !== "string") fail(FIELD, "id가 문자열이 아닙니다.", where);
  if (!ID_RE.test(v)) fail("TPL_ID", "id " + JSON.stringify(v) + "의 형식이 올바르지 않습니다(영문자로 시작, 영문·숫자·_·-, 32자 이하).", `${where}.id`);
  return v;
}

/** 자리 키(8.8.3): 앞뒤 공백 없음, 1~80자(코드 포인트), }}와 줄바꿈 없음 */
function checkPlaceKey(key: string, where: string): void {
  if (key !== key.trim()) fail(FIELD, "자리 키는 앞뒤 공백이 없어야 합니다.", where);
  const n = Array.from(key).length;
  if (n < 1 || n > 80) fail(FIELD, `자리 키는 1~80자여야 합니다(${n}자).`, where);
  if (key.includes("}}") || /[\r\n]/.test(key)) fail(FIELD, "자리 키에 }}나 줄바꿈을 넣을 수 없습니다.", where);
}

function checkSchema(root: unknown, family: string, current: string, prefix: string, label: string): Obj {
  if (!isObj(root)) fail("TPL_SCHEMA", `${label}은(는) JSON 객체여야 합니다.`);
  const schema = root["schema"];
  if (typeof schema !== "string") fail("TPL_SCHEMA", "schema가 없습니다.", `${prefix}schema`);
  const m = /^hwpx-studio\/([a-z-]+)@(\d+)$/.exec(schema);
  if (m === null || m[1] !== family) fail("TPL_SCHEMA", `schema ${JSON.stringify(schema)}는 ${label}의 것이 아닙니다.`, `${prefix}schema`);
  if (m[2] !== current) fail("TPL_VERSION", `${family}@${m[2] ?? "?"}은(는) 지원하지 않는 판 번호입니다(지원: @${current}).`, `${prefix}schema`);
  return root;
}

// ── 내용·원형 참조 ──────────────────────────────────────────────

function readContent(v: unknown, where: string): BlockContent {
  const c = obj(v, where, FIELD);
  onlyKeys(c, ["fragment", "text"], where, FIELD);
  if ((c["fragment"] === undefined) === (c["text"] === undefined)) fail(FIELD, "content에는 fragment와 text 가운데 하나만 있어야 합니다.", where);
  if (c["fragment"] !== undefined) return { fragment: sha(c, "fragment", where) };
  return { text: str(c, "text", where, FIELD, false) };
}

function readProtoRef(v: unknown, where: string): ProtoRef {
  const r = obj(v, where, FIELD);
  onlyKeys(r, ["id", "version"], where, FIELD);
  const id = r["id"];
  if (typeof id !== "string") fail(FIELD, "id가 문자열이 아닙니다.", where);
  if (!PROTO_ID_RE.test(id)) fail("TPL_ID", "원형 id " + JSON.stringify(id) + "의 형식이 올바르지 않습니다(k + 16진 8자).", `${where}.id`);
  return { id, version: int(r, "version", where, FIELD, 1) };
}

// ── 앵커 ────────────────────────────────────────────────────────

const A = "TPL_ANCHOR";

function readRangeAnchor(a: Obj, where: string): RangeAnchor {
  onlyKeys(a, ["id", "kind", "at", "from", "to", "print", "pattern"], where, A);
  const at = obj(a["at"], `${where}.at`, A);
  onlyKeys(at, ["sectionIndex", "parentPath"], `${where}.at`, A);
  const parentPath = at["parentPath"];
  if (!Array.isArray(parentPath) || parentPath.length % 2 !== 0 || !parentPath.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) {
    fail(A, "parentPath는 [문단, 하위목록, ...] 꼴(짝수 길이, 빈 배열 가능)의 0 이상 정수 배열이어야 합니다.", `${where}.at`);
  }
  const from = int(a, "from", where, A);
  const to = int(a, "to", where, A);
  if (to < from) fail(A, "to가 from보다 작습니다.", where);
  const print = readRangePrint(a["print"], where, A);
  if (print.count !== to - from + 1) fail(A, `print.count(${print.count})가 범위의 문단 수(${to - from + 1})와 다릅니다.`, where);
  return {
    id: str(a, "id", where, A),
    kind: "range",
    at: { sectionIndex: int(at, "sectionIndex", `${where}.at`, A), parentPath: parentPath as number[] },
    from,
    to,
    print,
    ...(a["pattern"] === undefined ? {} : { pattern: str(a, "pattern", where, A) }),
  };
}

/** `range` 지문(7.10): 첫·끝 문단의 글 앞 40자와 글 해시, 문단 수(1 이상), 범위 전체 글 해시. `where`는 지문을 가진 객체의 위치다. */
function readRangePrint(v: unknown, where: string, code: string): RangePrint {
  const print = obj(v, `${where}.print`, code);
  onlyKeys(print, ["first", "last", "count", "sha256"], `${where}.print`, code);
  const end = (key: "first" | "last"): { text: string; sha256: string } => {
    const e = obj(print[key], `${where}.print.${key}`, code);
    onlyKeys(e, ["text", "sha256"], `${where}.print.${key}`, code);
    return { text: str(e, "text", `${where}.print.${key}`, code, false), sha256: sha(e, "sha256", `${where}.print.${key}`, code) };
  };
  const count = int(print, "count", `${where}.print`, code, 1);
  return { first: end("first"), last: end("last"), count, sha256: sha(print, "sha256", `${where}.print`, code) };
}

function readMergeFieldAnchor(a: Obj, where: string): MergeFieldAnchor {
  onlyKeys(a, ["id", "kind", "key", "occurrence", "pattern"], where, A);
  return {
    id: str(a, "id", where, A),
    kind: "mergeField",
    key: str(a, "key", where, A),
    ...(a["occurrence"] === undefined ? {} : { occurrence: int(a, "occurrence", where, A) }),
    ...(a["pattern"] === undefined ? {} : { pattern: str(a, "pattern", where, A) }),
  };
}

function readCellPrint(v: unknown, where: string): CellPrint {
  const p = obj(v, where, A);
  onlyKeys(p, ["rows", "cols", "head", "text"], where, A);
  return { rows: int(p, "rows", where, A, 1), cols: int(p, "cols", where, A, 1), head: sha(p, "head", where, A), text: sha(p, "text", where, A) };
}

function readObjectPrint(v: unknown, where: string): ObjectPrint {
  const p = obj(v, where, A);
  onlyKeys(p, ["objectType", "width", "height", "count"], where, A);
  return {
    objectType: str(p, "objectType", where, A),
    ...(p["width"] === undefined ? {} : { width: int(p, "width", where, A) }),
    ...(p["height"] === undefined ? {} : { height: int(p, "height", where, A) }),
    ...(p["count"] === undefined ? {} : { count: int(p, "count", where, A) }),
  };
}

/** 1판 읽기(`readAnchor`)로 검사하는 종류: 1판 5종과 headingRange(1판도 받는다) */
const V1_KINDS: readonly string[] = ["field", "word", "line", "cell", "object", "headingRange"];

function readStudioAnchor(v: unknown, index: number): StudioAnchor {
  const where = `anchors[${index}]`;
  const a = obj(v, where, A);
  if (typeof a["id"] === "string" && !ID_RE.test(a["id"])) fail("TPL_ID", "id " + JSON.stringify(a["id"]) + "의 형식이 올바르지 않습니다(영문자로 시작, 영문·숫자·_·-, 32자 이하).", `${where}.id`);
  const kind = a["kind"];
  if (kind === "range") return readRangeAnchor(a, where);
  if (kind === "mergeField") return readMergeFieldAnchor(a, where);
  if (typeof kind !== "string" || !V1_KINDS.includes(kind)) fail(A, `알 수 없는 앵커 종류 ${JSON.stringify(kind)}입니다(field·word·line·cell·object·range·headingRange·mergeField).`, where);
  // 1판 5종과 headingRange는 1판 읽기로 검사하고, 2판에서만 받는 pattern(모든 앵커)과 print(cell·object)는 따로 읽는다
  const rest: Obj = { ...a };
  delete rest["pattern"];
  if (kind === "cell" || kind === "object") delete rest["print"];
  const base = readAnchor(rest, index);
  const pat = a["pattern"] === undefined ? {} : { pattern: str(a, "pattern", where, A) };
  switch (base.kind) {
    case "cell":
      return { ...base, ...pat, ...(a["print"] === undefined ? {} : { print: readCellPrint(a["print"], `${where}.print`) }) };
    case "object":
      return { ...base, ...pat, ...(a["print"] === undefined ? {} : { print: readObjectPrint(a["print"], `${where}.print`) }) };
    default:
      return { ...base, ...pat };
  }
}

// ── 패턴(형만) ──────────────────────────────────────────────────

function readPattern(v: unknown, index: number): TemplatePattern {
  const where = `patterns[${index}]`;
  const p = obj(v, where, FIELD);
  onlyKeys(p, ["id", "name", "marker", "char", "para", "place", "match", "rejected"], where, FIELD);
  const id = idOf(p, where);
  const markerObj = obj(p["marker"], `${where}.marker`, FIELD);
  onlyKeys(markerObj, ["form", "level"], `${where}.marker`, FIELD);
  const matchList = reqList(p, "match", where);
  const match = matchList.map((m, i) => {
    if (typeof m !== "string" || !(PATTERN_MATCH as readonly string[]).includes(m)) fail(FIELD, `match[${i}]는 ${PATTERN_MATCH.join("·")} 가운데 하나여야 합니다.`, where);
    return m as (typeof PATTERN_MATCH)[number];
  });
  const out: TemplatePattern = {
    id,
    name: str(p, "name", where, FIELD),
    marker: { form: oneOf(markerObj, "form", PATTERN_FORMS, `${where}.marker`), level: int(markerObj, "level", `${where}.marker`, FIELD, 0) },
    place: oneOf(p, "place", PATTERN_PLACES, where),
    match,
  };
  if (p["char"] !== undefined) {
    const c = obj(p["char"], `${where}.char`, FIELD);
    onlyKeys(c, ["bold", "height", "print"], `${where}.char`, FIELD);
    out.char = {
      ...(c["bold"] === undefined ? {} : { bold: bool(c, "bold", `${where}.char`) }),
      ...(c["height"] === undefined ? {} : { height: int(c, "height", `${where}.char`, FIELD) }),
      ...(c["print"] === undefined ? {} : { print: str(c, "print", `${where}.char`, FIELD) }),
    };
  }
  if (p["para"] !== undefined) {
    const c = obj(p["para"], `${where}.para`, FIELD);
    onlyKeys(c, ["print", "align"], `${where}.para`, FIELD);
    out.para = {
      ...(c["print"] === undefined ? {} : { print: str(c, "print", `${where}.para`, FIELD) }),
      ...(c["align"] === undefined ? {} : { align: str(c, "align", `${where}.para`, FIELD) }),
    };
  }
  if (p["rejected"] !== undefined) {
    out.rejected = list(p, "rejected", where, FIELD).map((r, i) => {
      const w = `${where}.rejected[${i}]`;
      const e = obj(r, w, FIELD);
      onlyKeys(e, ["text", "sha256"], w, FIELD);
      return { text: str(e, "text", w, FIELD, false), sha256: sha(e, "sha256", w) };
    });
  }
  return out;
}

// ── 값·연결·자리 ────────────────────────────────────────────────

function readValue(v: unknown, index: number): ValueDef {
  const where = `values[${index}]`;
  const o = obj(v, where, FIELD);
  onlyKeys(o, ["id", "name", "format"], where, FIELD);
  return { id: idOf(o, where), name: str(o, "name", where, FIELD), format: oneOf(o, "format", ["text", "money"] as const, where) };
}

function readBinding(v: unknown, index: number): ValueBinding {
  const where = `bindings[${index}]`;
  const b = obj(v, where, FIELD);
  onlyKeys(b, ["value", "key", "path", "aliases"], where, FIELD);
  const value = str(b, "value", where, FIELD);
  if ((b["key"] === undefined) === (b["path"] === undefined)) fail(FIELD, "연결에는 key와 path 가운데 하나만 있어야 합니다.", where);
  if (b["path"] !== undefined) {
    if (b["aliases"] !== undefined) fail(FIELD, "aliases는 key 연결에만 쓸 수 있습니다.", where);
    const path = str(b, "path", where, FIELD);
    if (!isValidPath(path)) fail(FIELD, `경로 ${JSON.stringify(path)}가 올바르지 않습니다(이름(.이름)*).`, where);
    return { value, path };
  }
  const key = str(b, "key", where, FIELD);
  if (b["aliases"] === undefined) return { value, key };
  const aliases = list(b, "aliases", where, FIELD).map((x, i) => {
    if (typeof x !== "string" || x === "") fail(FIELD, `aliases[${i}]가 비어 있지 않은 문자열이 아닙니다.`, where);
    return x;
  });
  if (new Set([key, ...aliases]).size !== aliases.length + 1) fail(FIELD, "aliases에 key와 같거나 겹치는 이름이 있습니다.", where);
  return { value, key, aliases };
}

function readPlace(v: unknown, index: number): ValuePlace {
  const where = `places[${index}]`;
  const p = obj(v, where, FIELD);
  const kind = p["kind"];
  const base = { id: idOf(p, where), value: str(p, "value", where, FIELD) };
  const scope = (): { where?: string } => (p["where"] === undefined ? {} : { where: str(p, "where", where, FIELD) });
  const occurrence = (): { occurrence?: number } => (p["occurrence"] === undefined ? {} : { occurrence: int(p, "occurrence", where, FIELD) });
  switch (kind) {
    case "clickHere":
      onlyKeys(p, ["id", "kind", "value", "name", "occurrence", "where"], where, FIELD);
      return { ...base, kind, name: str(p, "name", where, FIELD), ...occurrence(), ...scope() };
    case "mailMerge":
      onlyKeys(p, ["id", "kind", "value", "key", "occurrence", "where"], where, FIELD);
      return { ...base, kind, key: str(p, "key", where, FIELD), ...occurrence(), ...scope() };
    case "placeholder": {
      onlyKeys(p, ["id", "kind", "value", "key", "where"], where, FIELD);
      const key = str(p, "key", where, FIELD);
      checkPlaceKey(key, `${where}.key`);
      return { ...base, kind, key, ...scope() };
    }
    case "word":
    case "line":
    case "cell":
      onlyKeys(p, ["id", "kind", "value", "anchor"], where, FIELD);
      return { ...base, kind, anchor: str(p, "anchor", where, FIELD) };
    default:
      return fail(FIELD, `알 수 없는 자리 종류 ${JSON.stringify(kind)}입니다(clickHere·mailMerge·placeholder·word·line·cell).`, where);
  }
}

// ── 슬롯·블록 ───────────────────────────────────────────────────

function readSlot(v: unknown, index: number): TemplateSlot {
  const where = `slots[${index}]`;
  const s = obj(v, where, FIELD);
  onlyKeys(s, ["id", "name", "anchors", "parent"], where, FIELD);
  const id = idOf(s, where);
  const anchors = reqList(s, "anchors", where).map((x, i) => {
    if (typeof x !== "string" || x === "") fail(FIELD, `anchors[${i}]가 비어 있지 않은 문자열이 아닙니다.`, where);
    return x;
  });
  if (anchors.length === 0) fail(FIELD, "슬롯에는 앵커가 하나 이상 있어야 합니다.", where);
  const parent = s["parent"];
  if (parent !== null && (typeof parent !== "string" || parent === "")) fail(FIELD, "parent는 null이나 블록 id여야 합니다.", where);
  return { id, name: str(s, "name", where, FIELD), anchors, parent };
}

function readBlock(v: unknown, index: number): TemplateBlock {
  const where = `blocks[${index}]`;
  const b = obj(v, where, FIELD);
  onlyKeys(b, ["id", "slot", "name", "content", "proto", "forkedFrom", "when", "priority"], where, FIELD);
  if (b["proto"] !== undefined && b["forkedFrom"] !== undefined) fail(FIELD, "proto와 forkedFrom은 함께 쓸 수 없습니다.", where);
  const out: TemplateBlock = {
    id: idOf(b, where),
    slot: str(b, "slot", where, FIELD),
    name: str(b, "name", where, FIELD),
    content: readContent(b["content"], `${where}.content`),
  };
  if (b["proto"] !== undefined) out.proto = readProtoRef(b["proto"], `${where}.proto`);
  if (b["forkedFrom"] !== undefined) out.forkedFrom = readProtoRef(b["forkedFrom"], `${where}.forkedFrom`);
  if (b["when"] !== undefined) out.when = readCondition(b["when"], `${where}.when`, 0);
  if (b["priority"] !== undefined) out.priority = int(b, "priority", where, FIELD, Number.NEGATIVE_INFINITY);
  return out;
}

// ── 옵션·출처·메타 ──────────────────────────────────────────────

const OPTION_KEYS = ["missing", "mixedFormat", "unregistered", "requireConfirm", "unwrapFilled", "refreshPreview"];

function readOptions(v: unknown): StudioOptions {
  const o = obj(v, "options", "TPL_OPTIONS");
  onlyKeys(o, OPTION_KEYS, "options", "TPL_OPTIONS");
  const out: StudioOptions = {};
  if (o["missing"] !== undefined) out.missing = oneOf(o, "missing", ["error", "empty", "keep"] as const, "options", "TPL_OPTIONS");
  if (o["mixedFormat"] !== undefined) out.mixedFormat = oneOf(o, "mixedFormat", ["first"] as const, "options", "TPL_OPTIONS");
  if (o["unregistered"] !== undefined) out.unregistered = oneOf(o, "unregistered", ["error", "keep"] as const, "options", "TPL_OPTIONS");
  for (const key of ["requireConfirm", "unwrapFilled", "refreshPreview"] as const) {
    if (o[key] !== undefined) out[key] = bool(o, key, "options", "TPL_OPTIONS");
  }
  return out;
}

function readOrigin(v: unknown): TemplateOrigin {
  const o = obj(v, "origin", FIELD);
  onlyKeys(o, ["kind", "revision"], "origin", FIELD);
  oneOf(o, "kind", ["lite"] as const, "origin");
  const rev = o["revision"];
  const ok = (typeof rev === "number" && Number.isInteger(rev) && rev >= 1) || (typeof rev === "string" && rev !== "");
  if (!ok) fail(FIELD, "revision은 1 이상의 정수나 비어 있지 않은 문자열이어야 합니다.", "origin");
  return { kind: "lite", revision: rev as number | string };
}

/** 조건식의 잎(경로와 연산자)을 모두 모은다. 경로는 값 id다. */
export function conditionLeaves(c: Condition, out: { path: string; op: string }[] = []): { path: string; op: string }[] {
  if ("all" in c) c.all.forEach((x) => conditionLeaves(x, out));
  else if ("any" in c) c.any.forEach((x) => conditionLeaves(x, out));
  else if ("not" in c) conditionLeaves(c.not, out);
  else out.push({ path: c.path, op: c.op });
  return out;
}

// ── 교차 검사 ───────────────────────────────────────────────────

const TOP_KEYS = ["schema", "id", "version", "meta", "source", "anchors", "patterns", "values", "bindings", "places", "slots", "blocks", "rules", "options", "origin"];

/** 슬롯 앵커가 차지하는 문단 구간: 같은 구역·부모 안의 [from, to] */
function slotSpan(a: StudioAnchor): { parent: string; from: number; to: number } | undefined {
  if (a.kind === "range") return { parent: `${a.at.sectionIndex}|${a.at.parentPath.join(",")}`, from: a.from, to: a.to };
  // 제목 범위: 템플릿을 만들 때의 범위(제목 문단부터 지문의 문단 수만큼)
  if (a.kind === "headingRange") return { parent: `${a.at.sectionIndex}|${a.at.parentPath.join(",")}`, from: a.index, to: a.index + a.print.count - 1 };
  if (a.kind === "line") {
    const last = a.at.path[a.at.path.length - 1] ?? 0;
    return { parent: `${a.at.sectionIndex}|${a.at.path.slice(0, -1).join(",")}`, from: last, to: last };
  }
  return undefined;
}

function checkIds(t: StudioTemplate): void {
  const seen = new Map<string, string>();
  const claim = (id: string, where: string): void => {
    const prev = seen.get(id);
    if (prev !== undefined) fail("TPL_ID", `id ${JSON.stringify(id)}가 ${prev}와 겹칩니다(종류와 관계없이 템플릿 안에서 유일해야 합니다).`, `${where}.id`);
    seen.set(id, where);
  };
  t.anchors.forEach((x, i) => claim(x.id, `anchors[${i}]`));
  (t.patterns ?? []).forEach((x, i) => claim(x.id, `patterns[${i}]`));
  t.values.forEach((x, i) => claim(x.id, `values[${i}]`));
  t.places.forEach((x, i) => claim(x.id, `places[${i}]`));
  t.slots.forEach((x, i) => claim(x.id, `slots[${i}]`));
  t.blocks.forEach((x, i) => claim(x.id, `blocks[${i}]`));
}

function checkNames(items: { name: string }[], section: string): void {
  const seen = new Map<string, number>();
  items.forEach((x, i) => {
    const key = nfc(x.name);
    const prev = seen.get(key);
    if (prev !== undefined) fail("TPL_NAME_DUP", `표시 이름 ${JSON.stringify(x.name)}가 ${section}[${prev}]와 겹칩니다(NFC로 비교).`, `${section}[${i}].name`);
    seen.set(key, i);
  });
}

/** 참조 무결성과 쓰임에 맞는 앵커 종류 */
function checkRefs(t: StudioTemplate): void {
  const anchors = new Map(t.anchors.map((a) => [a.id, a]));
  const patternIds = new Set((t.patterns ?? []).map((p) => p.id));
  const values = new Set(t.values.map((x) => x.id));
  const blocks = new Map(t.blocks.map((b) => [b.id, b]));
  const slots = new Set(t.slots.map((s) => s.id));
  const md = t.source.kind === "md";

  t.anchors.forEach((a, i) => {
    if (a.pattern !== undefined && !patternIds.has(a.pattern)) fail("TPL_REF", `패턴 ${JSON.stringify(a.pattern)}가 patterns에 없습니다.`, `anchors[${i}].pattern`);
    if (md && (a.kind === "mergeField" || a.kind === "range" || a.kind === "headingRange")) fail(A, `md 템플릿에는 ${a.kind} 앵커를 쓸 수 없습니다(표식 줄 line 등 9절의 앵커를 씁니다).`, `anchors[${i}]`);
  });
  const bound = new Set<string>();
  t.bindings.forEach((b, i) => {
    if (!values.has(b.value)) fail("TPL_REF", `연결이 가리키는 값 ${JSON.stringify(b.value)}가 values에 없습니다.`, `bindings[${i}].value`);
    if (bound.has(b.value)) fail(FIELD, `값 ${JSON.stringify(b.value)}에 연결이 둘 이상입니다(값마다 정확히 하나).`, `bindings[${i}].value`);
    bound.add(b.value);
  });
  t.places.forEach((p, i) => {
    if (!values.has(p.value)) fail("TPL_REF", `자리가 가리키는 값 ${JSON.stringify(p.value)}가 values에 없습니다.`, `places[${i}].value`);
    if (p.kind === "clickHere" || p.kind === "mailMerge" || p.kind === "placeholder") {
      if (md && p.kind !== "placeholder") fail(A, `md 템플릿에는 ${p.kind} 자리를 쓸 수 없습니다.`, `places[${i}].kind`);
      if (p.where !== undefined && !blocks.has(p.where)) fail("TPL_REF", `자리의 where ${JSON.stringify(p.where)}가 blocks에 없습니다.`, `places[${i}].where`);
    } else {
      const a = anchors.get(p.anchor);
      if (a === undefined) fail("TPL_REF", `자리가 가리키는 앵커 ${JSON.stringify(p.anchor)}가 anchors에 없습니다.`, `places[${i}].anchor`);
      if (a.kind !== p.kind) fail(A, `${p.kind} 자리는 ${p.kind} 앵커를 가리켜야 합니다(앵커 ${JSON.stringify(p.anchor)}는 ${a.kind}).`, `places[${i}].anchor`);
    }
  });
  t.slots.forEach((s, i) => {
    s.anchors.forEach((id, j) => {
      const a = anchors.get(id);
      if (a === undefined) fail("TPL_REF", `슬롯이 가리키는 앵커 ${JSON.stringify(id)}가 anchors에 없습니다.`, `slots[${i}].anchors[${j}]`);
      if (a.kind !== "range" && a.kind !== "headingRange" && a.kind !== "line") fail(A, `슬롯 앵커는 range·headingRange·line이어야 합니다(앵커 ${JSON.stringify(id)}는 ${a.kind}).`, `slots[${i}].anchors[${j}]`);
    });
    if (s.parent !== null && !blocks.has(s.parent)) fail("TPL_REF", `슬롯의 부모 블록 ${JSON.stringify(s.parent)}가 blocks에 없습니다.`, `slots[${i}].parent`);
  });
  t.blocks.forEach((b, i) => {
    if (!slots.has(b.slot)) fail("TPL_REF", `블록의 슬롯 ${JSON.stringify(b.slot)}가 slots에 없습니다.`, `blocks[${i}].slot`);
    if (md && "fragment" in b.content) fail(FIELD, "md 템플릿의 블록은 text 내용만 쓸 수 있습니다.", `blocks[${i}].content`);
    if (b.when !== undefined) {
      for (const leaf of conditionLeaves(b.when)) {
        if (!values.has(leaf.path)) fail("TPL_REF", `조건의 경로 ${JSON.stringify(leaf.path)}는 값 id가 아닙니다.`, `blocks[${i}].when`);
      }
    }
  });
}

/** slot.parent → 블록 → 그 블록의 슬롯 → ... 순환(자기 부모 포함) */
function checkCycles(t: StudioTemplate): void {
  const blocks = new Map(t.blocks.map((b) => [b.id, b]));
  const slots = new Map(t.slots.map((s) => [s.id, s]));
  t.slots.forEach((s, i) => {
    const seen = new Set([s.id]);
    let cur = s;
    while (cur.parent !== null) {
      const next = slots.get(blocks.get(cur.parent)?.slot ?? "");
      if (next === undefined) return;
      if (seen.has(next.id)) fail("TPL_CYCLE", `슬롯 ${JSON.stringify(s.id)}의 부모 블록이 순환합니다(슬롯 → 부모 블록 → 그 블록의 슬롯 → ...).`, `slots[${i}].parent`);
      seen.add(next.id);
      cur = next;
    }
  });
}

/** 한 앵커는 한 슬롯에만 속하고, 같은 구역·부모에서 최상위 슬롯의 범위가 겹치지 않는다(8.8.6) */
function checkSlotConflicts(t: StudioTemplate): void {
  const anchors = new Map(t.anchors.map((a) => [a.id, a]));
  const owner = new Map<string, string>();
  const spans = new Map<string, { from: number; to: number; anchor: string; where: string }[]>();
  t.slots.forEach((s, i) => {
    s.anchors.forEach((id, j) => {
      const prev = owner.get(id);
      if (prev !== undefined) fail("TPL_CONFLICT", `앵커 ${JSON.stringify(id)}가 슬롯 ${JSON.stringify(prev)}와 ${JSON.stringify(s.id)}에 함께 속합니다.`, `slots[${i}].anchors[${j}]`);
      owner.set(id, s.id);
      const found = anchors.get(id);
      const span = s.parent === null && found !== undefined ? slotSpan(found) : undefined;
      if (span !== undefined) spans.set(span.parent, [...(spans.get(span.parent) ?? []), { from: span.from, to: span.to, anchor: id, where: `slots[${i}].anchors[${j}]` }]);
    });
  });
  for (const group of spans.values()) {
    const sorted = [...group].sort((a, b) => a.from - b.from || a.to - b.to);
    let reach = -1;
    let reachAnchor = "";
    for (const s of sorted) {
      if (s.from <= reach) fail("TPL_CONFLICT", `슬롯 앵커 ${JSON.stringify(reachAnchor)}와 ${JSON.stringify(s.anchor)}의 범위가 겹칩니다.`, s.where);
      if (s.to > reach) {
        reach = s.to;
        reachAnchor = s.anchor;
      }
    }
  }
}

/**
 * 한 키(별칭 포함)는 값 하나에만, 한 경로(path)도 값 하나에만 연결하고, 같은 종류·같은 키(이름)의 자리는 같은 값에만 연결한다(8.8.3·8.8.5).
 * key와 path는 이름 공간이 달라 서로 견주지 않는다.
 */
function checkKeyConflicts(t: StudioTemplate): void {
  const owner = new Map<string, string>();
  const pathOwner = new Map<string, string>();
  t.bindings.forEach((b, i) => {
    if ("path" in b) {
      const k = nfc(b.path);
      const prev = pathOwner.get(k);
      if (prev !== undefined && prev !== b.value) fail("TPL_KEY_CONFLICT", `경로 ${JSON.stringify(b.path)}가 값 ${JSON.stringify(prev)}와 ${JSON.stringify(b.value)}에 함께 연결됩니다.`, `bindings[${i}]`);
      pathOwner.set(k, b.value);
      return;
    }
    for (const name of [b.key, ...(b.aliases ?? [])]) {
      const k = nfc(name);
      const prev = owner.get(k);
      if (prev !== undefined && prev !== b.value) fail("TPL_KEY_CONFLICT", `열 이름 ${JSON.stringify(name)}가 값 ${JSON.stringify(prev)}와 ${JSON.stringify(b.value)}에 함께 연결됩니다.`, `bindings[${i}]`);
      owner.set(k, b.value);
    }
  });
  const placeOwner = new Map<string, string>();
  t.places.forEach((p, i) => {
    if (p.kind !== "clickHere" && p.kind !== "mailMerge" && p.kind !== "placeholder") return;
    const name = p.kind === "clickHere" ? p.name : p.key;
    const groupKey = `${p.kind}|${nfc(name)}`;
    const prev = placeOwner.get(groupKey);
    if (prev !== undefined && prev !== p.value) {
      fail("TPL_KEY_CONFLICT", `${p.kind} 자리 ${JSON.stringify(name)}가 값 ${JSON.stringify(prev)}와 ${JSON.stringify(p.value)}에 함께 연결됩니다.`, `places[${i}]`);
    }
    placeOwner.set(groupKey, p.value);
  });
}

function checkBound(t: StudioTemplate): void {
  const used = new Set<string>();
  t.places.forEach((p) => used.add(p.value));
  t.blocks.forEach((b) => {
    if (b.when !== undefined) conditionLeaves(b.when).forEach((l) => used.add(l.path));
  });
  const bound = new Set(t.bindings.map((b) => b.value));
  t.values.forEach((v, i) => {
    if (used.has(v.id) && !bound.has(v.id)) fail("TPL_UNBOUND_VALUE", `쓰이는 값 ${JSON.stringify(v.id)}에 연결(bindings)이 없습니다.`, `values[${i}]`);
  });
}

// ── 공개: 템플릿 ────────────────────────────────────────────────

/**
 * 2판 템플릿을 읽고 검사한다(8.8.10). template@1이면 1판 readTemplate로 읽어 1판 Template 그대로 돌려준다(승계).
 * 틀리면 HwpxError(TPL_*)를 던지고 where에 JSON 위치를 담는다. lookupProto·hasBlob을 주면 원형 핀·덩어리 검사도 한다.
 */
export function readStudioTemplate(json: string, opts: StudioReadOptions = {}): StudioTemplate | Template {
  const raw = readJson(json, "템플릿");
  if (isObj(raw) && raw["schema"] === TEMPLATE_SCHEMA) return readTemplate(raw);
  const root = checkSchema(raw, "template", "2", "", "2판 템플릿");
  onlyKeys(root, TOP_KEYS, "템플릿", FIELD);

  const id = root["id"];
  if (typeof id !== "string") fail(FIELD, "id가 문자열이 아닙니다.", "id");
  if (!TEMPLATE_ID_RE.test(id)) fail("TPL_ID", "템플릿 id " + JSON.stringify(id) + "의 형식이 올바르지 않습니다(t + 16진 8자).", "id");
  const version = int(root, "version", "템플릿", FIELD, 1);
  const source = obj(root["source"], "source", FIELD);
  onlyKeys(source, ["kind", "sha256"], "source", FIELD);
  const sourceOut: StudioTemplate["source"] = { kind: oneOf(source, "kind", ["hwpx", "md"] as const, "source"), sha256: sha(source, "sha256", "source") };

  const rawRules = root["rules"] === undefined ? [] : list(root, "rules", "템플릿", "TPL_RULE");
  const rawSlots = reqList(root, "slots", "템플릿");
  const rawPlaces = reqList(root, "places", "템플릿");
  if (rawRules.length > 0 && (rawSlots.length > 0 || rawPlaces.length > 0)) {
    fail("TPL_MIXED_RULES", "1판 rules는 승계 전용이라 slots·places와 함께 쓸 수 없습니다.", "rules");
  }

  const anchors = reqList(root, "anchors", "템플릿").map((v, i) => readStudioAnchor(v, i));
  const t: StudioTemplate = {
    schema: STUDIO_TEMPLATE_SCHEMA,
    id,
    version,
    source: sourceOut,
    anchors,
    values: [],
    bindings: [],
    places: [],
    slots: [],
    blocks: [],
  };
  if (root["meta"] !== undefined) {
    const meta = obj(root["meta"], "meta", FIELD);
    onlyKeys(meta, ["name"], "meta", FIELD);
    t.meta = meta["name"] === undefined ? {} : { name: str(meta, "name", "meta", FIELD, false) };
  }
  if (root["patterns"] !== undefined) t.patterns = list(root, "patterns", "템플릿", FIELD).map((v, i) => readPattern(v, i));
  t.values = reqList(root, "values", "템플릿").map((v, i) => readValue(v, i));
  t.bindings = root["bindings"] === undefined ? [] : list(root, "bindings", "템플릿", FIELD).map((v, i) => readBinding(v, i));
  t.places = rawPlaces.map((v, i) => readPlace(v, i));
  t.slots = rawSlots.map((v, i) => readSlot(v, i));
  t.blocks = reqList(root, "blocks", "템플릿").map((v, i) => readBlock(v, i));
  if (root["rules"] !== undefined) {
    const kinds = new Map(anchors.map((a) => [a.id, a.kind as string]));
    const objectTypes = new Map(anchors.flatMap((a) => (a.kind === "object" ? [[a.id, a.objectType] as [string, string]] : [])));
    const ruleIds = new Set<string>();
    t.rules = rawRules.map((v, i): Rule => {
      const rule = readRule(v, i, kinds, objectTypes);
      if (ruleIds.has(rule.id)) fail("TPL_RULE", `규칙 id ${JSON.stringify(rule.id)}가 겹칩니다.`, `rules[${i}]`);
      ruleIds.add(rule.id);
      return rule;
    });
  }
  if (root["options"] !== undefined) t.options = readOptions(root["options"]);
  if (root["origin"] !== undefined) t.origin = readOrigin(root["origin"]);

  checkIds(t);
  checkNames(t.values, "values");
  checkNames(t.slots, "slots");
  checkRefs(t);
  checkCycles(t);
  checkSlotConflicts(t);
  checkKeyConflicts(t);
  checkBound(t);
  if (opts.hasBlob !== undefined) {
    const has = opts.hasBlob;
    t.blocks.forEach((b, i) => {
      if ("fragment" in b.content && !has(b.content.fragment)) fail("TPL_FRAGMENT_MISSING", `조각 덩어리 ${b.content.fragment.slice(0, 8)}...가 없습니다.`, `blocks[${i}].content`);
    });
  }
  if (opts.lookupProto !== undefined) {
    const lookup = opts.lookupProto;
    t.blocks.forEach((b, i) => {
      if (b.proto === undefined) return;
      const pinned = lookup(b.proto.id, b.proto.version);
      if (pinned === undefined) fail("TPL_PROTO_MISMATCH", `고정한 원형 ${b.proto.id}의 ${b.proto.version}판을 찾을 수 없습니다.`, `blocks[${i}].proto`);
      if (("fragment" in pinned) !== ("fragment" in b.content) || contentSha256(lowerHash(pinned)) !== contentSha256(b.content)) {
        fail("TPL_PROTO_MISMATCH", `블록 내용이 고정한 원형 ${b.proto.id}의 ${b.proto.version}판 내용과 다릅니다.`, `blocks[${i}].content`);
      }
    });
  }
  return t;
}

/** 해시는 소문자로 비교한다(읽은 블록의 fragment는 이미 소문자다) */
const lowerHash = (c: BlockContent): BlockContent => ("fragment" in c ? { fragment: c.fragment.toLowerCase() } : c);

// ── 공개: 원형 ──────────────────────────────────────────────────

/** 시각: ISO 8601 UTC(`Date.prototype.toISOString`의 꼴, 밀리초는 선택) */
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function time(o: Obj, key: string, where: string): string {
  const v = str(o, key, where, FIELD);
  if (!TIME_RE.test(v) || Number.isNaN(Date.parse(v))) fail(FIELD, `${key}가 ISO 8601 UTC 시각(예: 2026-10-06T09:30:00Z)이 아닙니다.`, where);
  return v;
}

/** 블록의 출처(8.8.17): 원본 해시, 조각 선택 꼴의 구간, 범위 지문(문단 수 = 구간의 문단 수), 떼어 낸 시각 */
function readBlockSource(v: unknown, where: string): BlockSource {
  const o = obj(v, where, FIELD);
  onlyKeys(o, ["sha256", "selection", "print", "extractedAt"], where, FIELD);
  const sw = `${where}.selection`;
  const sel = obj(o["selection"], sw, FIELD);
  onlyKeys(sel, ["sectionIndex", "parentPath", "from", "to"], sw, FIELD);
  const parentPath = sel["parentPath"];
  if (!Array.isArray(parentPath) || parentPath.length % 2 !== 0 || !parentPath.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) {
    fail(FIELD, "parentPath는 [문단, 하위목록, ...] 꼴(짝수 길이, 빈 배열 가능)의 0 이상 정수 배열이어야 합니다.", sw);
  }
  const from = int(sel, "from", sw, FIELD);
  const to = int(sel, "to", sw, FIELD);
  if (to < from) fail(FIELD, "to가 from보다 작습니다.", sw);
  const print = readRangePrint(o["print"], where, FIELD);
  if (print.count !== to - from + 1) fail(FIELD, `print.count(${print.count})가 구간의 문단 수(${to - from + 1})와 다릅니다.`, where);
  return {
    sha256: sha(o, "sha256", where),
    selection: { sectionIndex: int(sel, "sectionIndex", sw, FIELD), parentPath: [...(parentPath as number[])], from, to },
    print,
    extractedAt: time(o, "extractedAt", where),
  };
}

/** 판 기록: 비어 있지 않고, 판 번호가 오름차순이며, 마지막 줄이 원형의 판이다 */
function readHistory(v: unknown, version: number, where: string): BlockHistoryEntry[] {
  if (!Array.isArray(v) || v.length === 0) fail(FIELD, "history는 비어 있지 않은 배열이어야 합니다.", where);
  const out = v.map((x, i): BlockHistoryEntry => {
    const ew = `${where}[${i}]`;
    const e = obj(x, ew, FIELD);
    onlyKeys(e, ["version", "at", "change"], ew, FIELD);
    return { version: int(e, "version", ew, FIELD, 1), at: time(e, "at", ew), change: str(e, "change", ew, FIELD) };
  });
  out.forEach((e, i) => {
    const prev = out[i - 1];
    if (prev !== undefined && e.version <= prev.version) fail(FIELD, "history의 판 번호는 오름차순이어야 합니다.", `${where}[${i}]`);
  });
  if (out[out.length - 1]?.version !== version) fail(FIELD, `history의 마지막 판(${out[out.length - 1]?.version})이 원형의 판(${version})과 다릅니다.`, where);
  return out;
}

/** block-proto@1을 읽는다. 형식만 본다(keys는 만드는 쪽이 계산한다). 판 번호가 다르면 TPL_VERSION. `source`·`history`(8.8.17)는 선택이다. */
export function readBlockProto(json: string): BlockProto {
  const root = checkSchema(readJson(json, "원형"), "block-proto", "1", "block-proto.", "원형");
  const w = "block-proto";
  onlyKeys(root, ["schema", "id", "version", "name", "content", "keys", "previous", "note", "source", "history"], w, FIELD);
  const id = root["id"];
  if (typeof id !== "string") fail(FIELD, "id가 문자열이 아닙니다.", `${w}.id`);
  if (!PROTO_ID_RE.test(id)) fail("TPL_ID", "원형 id " + JSON.stringify(id) + "의 형식이 올바르지 않습니다(k + 16진 8자).", `${w}.id`);
  const version = int(root, "version", w, FIELD, 1);
  const out: BlockProto = {
    schema: BLOCK_PROTO_SCHEMA,
    id,
    version,
    name: str(root, "name", w, FIELD),
    content: readContent(root["content"], `${w}.content`),
    keys: reqList(root, "keys", w).map((k, i) => {
      if (typeof k !== "string") fail(FIELD, `keys[${i}]가 문자열이 아닙니다.`, w);
      checkPlaceKey(k, `${w}.keys[${i}]`);
      return k;
    }),
  };
  if (root["previous"] !== undefined) {
    const p = obj(root["previous"], `${w}.previous`, FIELD);
    onlyKeys(p, ["version", "content"], `${w}.previous`, FIELD);
    const pv = int(p, "version", `${w}.previous`, FIELD, 1);
    if (pv >= version) fail(FIELD, "previous.version은 version보다 작아야 합니다.", `${w}.previous`);
    out.previous = { version: pv, content: sha(p, "content", `${w}.previous`) };
  }
  if (root["note"] !== undefined) out.note = str(root, "note", w, FIELD, false);
  if (root["source"] !== undefined) out.source = readBlockSource(root["source"], `${w}.source`);
  if (root["history"] !== undefined) out.history = readHistory(root["history"], version, `${w}.history`);
  return out;
}

// ── 공개: 이번 건 ───────────────────────────────────────────────

function recordOf(v: unknown, where: string, make: (o: Obj) => void): Obj {
  const o = obj(v, where, FIELD);
  make(o);
  return o;
}

/**
 * case@1을 읽고 t와 맞춰 본다(8.8.9). t가 같은 판(id·version이 같고 해시도 같음)이면 selections·valueEdits·blockEdits의 id가 모두 t에 있어야 한다.
 * 다른 템플릿이거나 같은 판 번호인데 해시가 다르면 TPL_REF다. 같은 템플릿의 다른 판이면 id 검사는 하지 않는다(selectSlots의 recheck가 맡는다).
 */
export function readCase(json: string, t: StudioTemplate): StudioCase {
  const root = checkSchema(readJson(json, "이번 건"), "case", "1", "case.", "이번 건");
  const w = "case";
  onlyKeys(root, ["schema", "template", "record", "selections", "valueEdits", "blockEdits"], w, FIELD);
  const tpl = recordOf(root["template"], `${w}.template`, (o) => onlyKeys(o, ["id", "version", "sha256"], `${w}.template`, FIELD));
  const rec = recordOf(root["record"], `${w}.record`, (o) => onlyKeys(o, ["dataset", "version", "row", "sha256"], `${w}.record`, FIELD));
  const out: StudioCase = {
    schema: CASE_SCHEMA,
    template: { id: str(tpl, "id", `${w}.template`, FIELD), version: int(tpl, "version", `${w}.template`, FIELD, 1), sha256: sha(tpl, "sha256", `${w}.template`) },
    record: {
      dataset: str(rec, "dataset", `${w}.record`, FIELD),
      version: int(rec, "version", `${w}.record`, FIELD, 1),
      row: int(rec, "row", `${w}.record`, FIELD),
      sha256: sha(rec, "sha256", `${w}.record`),
    },
    selections: {},
    valueEdits: {},
    blockEdits: {},
  };
  const keyOf = (key: string, where: string): string => {
    if (!ID_RE.test(key)) fail("TPL_ID", "id " + JSON.stringify(key) + "의 형식이 올바르지 않습니다.", where);
    return key;
  };
  if (root["selections"] !== undefined) {
    const sel = obj(root["selections"], `${w}.selections`, FIELD);
    for (const slot of Object.keys(sel)) {
      const where = `${w}.selections.${slot}`;
      const e = obj(sel[slot], where, FIELD);
      onlyKeys(e, ["block", "basis", "content"], where, FIELD);
      const entry: CaseSelection = { block: str(e, "block", where, FIELD), basis: oneOf(e, "basis", ["manual", "confirmed"] as const, where), content: sha(e, "content", where) };
      out.selections[keyOf(slot, where)] = entry;
    }
  }
  if (root["valueEdits"] !== undefined) {
    const edits = obj(root["valueEdits"], `${w}.valueEdits`, FIELD);
    for (const value of Object.keys(edits)) {
      const where = `${w}.valueEdits.${value}`;
      if (typeof edits[value] !== "string") fail(FIELD, "정정한 값은 문자열이어야 합니다.", where);
      out.valueEdits[keyOf(value, where)] = edits[value];
    }
  }
  if (root["blockEdits"] !== undefined) {
    const edits = obj(root["blockEdits"], `${w}.blockEdits`, FIELD);
    for (const block of Object.keys(edits)) {
      const where = `${w}.blockEdits.${block}`;
      out.blockEdits[keyOf(block, where)] = readContent(edits[block], where);
    }
  }
  matchTemplate(out, t);
  return out;
}

function matchTemplate(c: StudioCase, t: StudioTemplate): void {
  if (c.template.id !== t.id) fail("TPL_REF", `이번 건이 다른 템플릿 ${c.template.id}을(를) 가리킵니다(받은 템플릿 ${t.id}).`, "case.template.id");
  if (c.template.version !== t.version) return;
  if (c.template.sha256 !== templateSha256(t)) fail("TPL_REF", "이번 건의 템플릿 해시가 받은 템플릿(같은 판 번호)과 다릅니다.", "case.template.sha256");
  const slots = new Set(t.slots.map((s) => s.id));
  const blocks = new Map(t.blocks.map((b) => [b.id, b]));
  const values = new Set(t.values.map((v) => v.id));
  for (const [slot, e] of Object.entries(c.selections)) {
    if (!slots.has(slot)) fail("TPL_REF", `이번 건의 슬롯 ${slot}이(가) 템플릿에 없습니다.`, `case.selections.${slot}`);
    const block = blocks.get(e.block);
    if (block === undefined) fail("TPL_REF", `이번 건의 블록 ${e.block}이(가) 템플릿에 없습니다.`, `case.selections.${slot}.block`);
    if (block.slot !== slot) fail("TPL_REF", `블록 ${e.block}은(는) 슬롯 ${slot}의 블록이 아닙니다.`, `case.selections.${slot}.block`);
  }
  for (const value of Object.keys(c.valueEdits)) {
    if (!values.has(value)) fail("TPL_REF", `이번 건의 값 ${value}이(가) 템플릿에 없습니다.`, `case.valueEdits.${value}`);
  }
  for (const block of Object.keys(c.blockEdits)) {
    if (!blocks.has(block)) fail("TPL_REF", `이번 건의 블록 ${block}이(가) 템플릿에 없습니다.`, `case.blockEdits.${block}`);
  }
}
