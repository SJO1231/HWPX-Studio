// 빠른 생성의 핵심(명세 4a): 문서에서 자리를 찾고, 데이터와 맞대어 보고, 건마다 엔진으로 만든다.
// HTTP도 파일도 모른다(입력은 바이트, 출력은 바이트와 보고). 값을 읽고 판정하는 일, 누름틀·{{}} 채우기, 파일 이름은 엔진이 한다
// (템플릿 없이 `{{키}}`와 누름틀 이름 = 데이터 경로를 채운다. 건마다 `generateBatch`). 문자 검사는 여기서 다시 구현하지 않는다.
import {
  DATASET_SCHEMA,
  checkValueText,
  buildFillPlan,
  collectFields,
  emptyTemplate,
  fieldFillBlock,
  fieldRangeIn,
  findCandidates,
  findPlaceholders,
  generateBatch,
  isValidPath,
  lookupPath,
  openPackage,
  parseDocument,
  planBatchNames,
  readBatchRecords,
  readDataset,
  resolvePathValue,
  scalarToText,
  walkParagraphs,
  type BatchItem,
  type BatchRecord,
  type Dataset,
  type FieldTarget,
  type HwpxDocument,
  type PlanReport,
  type Template,
} from "@hwpx-studio/engine";
import { HostError, isObj, parseJson } from "../../../packages/viewer/src/host/index.ts";
import type { DataForm, DataKey, Match, MatchState, MissingPolicy, PlacesView, ReportEntry, ResultView, UnfillableShape } from "./quick-types.ts";
import { plainOf } from "./quick-messages.ts";

/** 한 번에 만들 수 있는 건수 */
export const MAX_RECORDS = 1000;
/** 성공 결과 바이트 총합의 한도 */
export const MAX_RESULT_BYTES = 512 * 1024 * 1024;
export const MAX_KEYS = 1000;
export const MAX_CANDIDATES = 200;
const MAX_KEY_DEPTH = 8;

// ── 문서: 자리 목록 ──────────────────────────────────────────────

const CANDIDATE_KINDS = new Set(["emptyCell", "labelColon", "blankMark"]);
/** `unfillable`에 담는 모양의 순서 */
const UNFILLABLE_SHAPES: readonly UnfillableShape[] = ["object", "crossContainer", "unpaired", "crossBlocked"];

type FieldTally = { count: number; mailMerge: number; fillable: number; merging: number; unfillable: Map<UnfillableShape, { count: number; reasons: string[] }> };

/**
 * 문서 바이트를 열어 자리 목록을 만든다. 열 수 없으면 엔진의 `HwpxError`(`PKG_`·`XML_`·`MODEL_`)가 올라온다.
 * 누름틀은 name, 키가 있는 MAILMERGE는 mergeKey로 센다(엔진의 암묵 채움과 같다. 책갈피·날짜·키 없는 메일머지는 목록에 없다).
 * 이름의 `usable`은 엔진이 채우는 기준(`isValidPath`)과 같다. 곳마다 채울 수 있는지는 엔진의 `fieldFillBlock`(`collectFields`의 곳별 판정, 데이터와 무관하다)만 따른다:
 * 막는 사유가 없으면 `fillable`(그 가운데 여러 문단에 걸친 모양 `crossParagraph`는 `merging`에도 센다), 있으면 `unfillable`에 센다. 여러 문단에 걸친 모양인데 막힌 곳은
 * `crossBlocked`이고 엔진이 준 사유 문구를 `reasons`에 담는다. 나머지는 모양(`object`·`crossContainer`·`unpaired`)별로 센다.
 * `{{키}}`는 메일머지가 맡는 표시 글 안의 것을 세지 않는다(엔진 8.3: 키가 경로 꼴이고 채울 수 있는 메일머지는 표시 글 안 `{{}}`를 채우지 않고 필드가 값을 넣는다.
 * 구간은 엔진의 `fieldRangeIn`). 그 밖의 메일머지(키가 경로 꼴이 아니거나 채울 수 없는 모양) 표시 글 안 `{{키}}`는 엔진이 채우므로 센다.
 */
export function analyzePlaces(bytes: Uint8Array): PlacesView {
  const doc = parseDocument(openPackage(bytes));

  const tallies = new Map<string, FieldTally>();
  /** 표시 글을 맡는 메일머지 */
  const owners: FieldTarget[] = [];
  for (const target of collectFields(doc)) {
    const f = target.info;
    const key = f.type === "CLICK_HERE" ? f.name : f.type === "MAILMERGE" ? f.mergeKey : undefined;
    if (key === undefined) continue;
    let tally = tallies.get(key);
    if (tally === undefined) {
      tally = { count: 0, mailMerge: 0, fillable: 0, merging: 0, unfillable: new Map() };
      tallies.set(key, tally);
    }
    tally.count++;
    if (f.type === "MAILMERGE") tally.mailMerge++;
    const block = fieldFillBlock(target);
    if (block === undefined) {
      tally.fillable++;
      if (f.shape === "crossParagraph") tally.merging++;
      if (f.type === "MAILMERGE" && isValidPath(key)) owners.push(target);
      continue;
    }
    // 모양이 simple·empty·inline인데 막힌 곳(시작과 끝 표식이 한 조각에 붙어 있음)은 끝 표식을 따로 찾을 수 없는 `unpaired`로 센다
    const shape: UnfillableShape = f.shape === "crossParagraph" ? "crossBlocked" : f.shape === "object" || f.shape === "crossContainer" ? f.shape : "unpaired";
    const slot = tally.unfillable.get(shape) ?? { count: 0, reasons: [] };
    slot.count++;
    if (shape === "crossBlocked" && !slot.reasons.includes(block.message)) slot.reasons.push(block.message);
    tally.unfillable.set(shape, slot);
  }

  const placeholderCounts = new Map<string, number>();
  for (const section of doc.sections) {
    for (const par of walkParagraphs(section.paragraphs)) {
      for (const h of findPlaceholders(par.logicalText)) {
        const owned = owners.some((t) => {
          const r = fieldRangeIn(t, par);
          return r !== undefined && h.start < r.until && h.end > r.from;
        });
        if (!owned) placeholderCounts.set(h.path, (placeholderCounts.get(h.path) ?? 0) + 1);
      }
    }
  }

  const candidates = findCandidates(doc).filter((c) => CANDIDATE_KINDS.has(c.kind));
  return {
    fields: [...tallies].map(([name, t]) => ({
      name,
      count: t.count,
      ...(t.mailMerge ? { mailMerge: t.mailMerge } : {}),
      usable: isValidPath(name),
      fillable: t.fillable,
      merging: t.merging,
      unfillable: UNFILLABLE_SHAPES.flatMap((shape) => {
        const slot = t.unfillable.get(shape);
        return slot === undefined ? [] : [shape === "crossBlocked" ? { shape, count: slot.count, reasons: slot.reasons } : { shape, count: slot.count }];
      }),
    })),
    placeholders: [...placeholderCounts].map(([key, count]) => ({ key, count })),
    candidates: candidates.slice(0, MAX_CANDIDATES).map((c) => ({ kind: c.kind as "emptyCell" | "labelColon" | "blankMark", evidence: c.evidence })),
    candidatesTruncated: candidates.length > MAX_CANDIDATES,
  };
}

// ── 데이터: 건 나누기, 키 목록 ───────────────────────────────────

export type QuickData = { form: DataForm; records: BatchRecord[] };

/**
 * 올린 JSON을 건으로 나눈다(엔진의 `readBatchRecords`): 최상위가 배열이면 원소마다 한 건, 묶음 형식(`hwpx-studio/dataset@1`)의 `data`가 배열이면
 * 원소마다 한 건(`derived`는 공유), 객체이면 한 건이다. 객체가 아닌 원소는 그 건만 `DATA_SCHEMA`로 실패한다.
 * JSON이 아니면 `BAD_JSON`(400), 그 밖의 모양이면 `QUICK_BAD_DATA`, 건이 없거나 너무 많으면 `QUICK_NO_RECORDS`·`QUICK_TOO_MANY_RECORDS`다.
 * 묶음 형식의 `data`·`derived`가 틀리면 엔진의 `DATA_SCHEMA`(`HwpxError`)가 올라온다.
 */
export function parseQuickData(body: Uint8Array): QuickData {
  const raw = parseJson(body);
  // 글자 하나(JSON 문자열)를 엔진에 넘기면 JSON 본문으로 다시 읽으므로, 객체나 배열이 아니면 여기서 거절한다
  if (!Array.isArray(raw) && !isObj(raw)) throw new HostError(400, "QUICK_BAD_DATA", "데이터는 JSON 객체 하나이거나 객체의 배열이어야 합니다.");
  const batch = readBatchRecords(raw);
  let form: DataForm;
  let records: BatchRecord[];
  if (batch !== undefined) {
    form = Array.isArray(raw) ? "array" : "bundleArray";
    records = batch;
  } else {
    // 배열이면 위에서 건으로 나뉘었으므로 객체 하나다
    form = (raw as Record<string, unknown>)["schema"] === DATASET_SCHEMA ? "bundle" : "object";
    records = [{ dataset: readDataset(raw) }];
  }
  if (records.length === 0) throw new HostError(400, "QUICK_NO_RECORDS", "데이터에 만들 건이 없습니다.");
  if (records.length > MAX_RECORDS) throw new HostError(400, "QUICK_TOO_MANY_RECORDS", `한 번에 ${MAX_RECORDS}건까지 만들 수 있습니다(올린 데이터는 ${records.length}건).`);
  return { form, records };
}

const typeOf = (v: unknown): DataKey["type"] => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : (typeof v as "string" | "number" | "boolean"));

/** 모든 건의 키 경로 목록(객체는 안으로 들어가 점으로 잇고, 배열은 들어가지 않는다). 처음 나온 순서이고 `MAX_KEYS`개까지다. */
export function listKeys(records: readonly BatchRecord[]): { keys: DataKey[]; truncated: boolean } {
  const found = new Map<string, DataKey>();
  let truncated = false;
  const walk = (obj: Record<string, unknown>, prefix: string, parentUsable: boolean, depth: number, seen: Set<string>): void => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      let entry = found.get(path);
      if (entry === undefined) {
        if (found.size >= MAX_KEYS) {
          truncated = true;
          continue;
        }
        // 점이 든 키는 경로로 이으면 다른 키를 가리키게 되므로 쓸 수 없다
        entry = { path, type: typeOf(value), records: 0, usable: parentUsable && isValidPath(key) && !key.includes(".") };
        found.set(path, entry);
      }
      if (!seen.has(path)) {
        seen.add(path);
        entry.records++;
      }
      if (isObj(value) && depth < MAX_KEY_DEPTH) walk(value, path, entry.usable, depth + 1, seen);
    }
  };
  for (const record of records) {
    if (!("dataset" in record)) continue;
    const seen = new Set<string>();
    walk(record.dataset.data, "", true, 1, seen);
    walk(record.dataset.derived, "", true, 1, seen);
  }
  return { keys: [...found.values()], truncated };
}

// ── 대조표 ───────────────────────────────────────────────────────

type Judged = { state: "ok"; multiline: boolean } | { state: Exclude<MatchState, "ok" | "badKey" | "unfillable">; reason?: string };

/**
 * 한 건에서 키 하나의 판정. 엔진이 채울 때 쓰는 값 해석(`resolvePathValue`)의 결과를 그대로 따른다(줄바꿈·탭은 엔진이 받으므로 `ok`이고,
 * 정보로만 `multiline`을 단다). 값 원문은 담지 않는다.
 */
export function judge(dataset: Dataset, key: string): Judged {
  const outcome = resolvePathValue(dataset, key, "error");
  if (outcome.kind === "text") return { state: "ok", multiline: /[\n\r\t]/.test(outcome.text) };
  if (outcome.kind === "error" && outcome.code === "DATA_NOT_SCALAR") return { state: "notScalar" };
  if (outcome.kind === "error" && outcome.code === "VALUE_CONTROL_CHAR") {
    // 사유(예 U+0001)는 엔진의 값 검사가 준다(값 원문은 아니다)
    const found = lookupPath(dataset, key);
    const text = found.found ? scalarToText(found.value) : undefined;
    const reason = text === undefined ? undefined : checkValueText(text);
    return reason === undefined ? { state: "rejected" } : { state: "rejected", reason };
  }
  return { state: "missing" };
}

/** 건 가운데 객체가 아니어서 만들 때 엔진이 `DATA_SCHEMA`로 실패시키는 건수. */
export const countInvalidRecords = (records: readonly BatchRecord[]): number => records.filter((r) => !("dataset" in r)).length;

/**
 * 자리(누름틀 이름·`{{키}}`)마다 모든 건에서 데이터와 맞는지 센다. 키로 쓸 수 없는 누름틀 이름(엔진이 채우지 않는 것)은 `badKey`,
 * 그 이름의 곳이 전부 엔진이 채울 수 없는 누름틀은 `unfillable`이다(둘 다 건수 판정을 하지 않는다. 일부 곳만 채울 수 없는 누름틀은 데이터로 판정한다).
 * 객체가 아닌 건은 판정하지 않고 건수에서 뺀다. 판정할 건이 하나도 없으면 `missing`이다.
 */
export function matchPlaces(places: PlacesView, records: readonly BatchRecord[]): Match[] {
  const one = (kind: Match["kind"], key: string, blocked?: "badKey" | "unfillable"): Match => {
    const counts = { ok: 0, missing: 0, notScalar: 0, rejected: 0 };
    if (blocked !== undefined) return { kind, key, state: blocked, counts, multiline: 0 };
    let first: Judged | undefined;
    let multiline = 0;
    let judged = 0;
    for (const record of records) {
      if (!("dataset" in record)) continue;
      const j = judge(record.dataset, key);
      judged++;
      counts[j.state]++;
      if (j.state === "ok" && j.multiline) multiline++;
      if (first === undefined && j.state !== "ok") first = j;
    }
    const match: Match = { kind, key, state: first?.state ?? (judged === 0 ? "missing" : "ok"), counts, multiline };
    if (first !== undefined && first.state === "rejected" && first.reason !== undefined) match.reason = first.reason;
    return match;
  };
  return [
    ...places.fields.map((f) => one("field", f.name, !f.usable ? "badKey" : f.fillable === 0 ? "unfillable" : undefined)),
    ...places.placeholders.map((p) => one("placeholder", p.key)),
  ];
}

// ── 생성 ─────────────────────────────────────────────────────────

const entry = (code: string, detail?: string, place?: string): ReportEntry => {
  const e: ReportEntry = { code, plain: plainOf(code) };
  if (place !== undefined) e.place = place;
  if (detail !== undefined && detail !== "") e.detail = detail;
  return e;
};

/** 엔진 보고의 앵커(`{{키}}`, `field:이름`, `merge:키`)를 사람이 읽는 자리 이름으로 바꾼다. */
function placeOf(anchor: string): string | undefined {
  if (anchor.startsWith("{{")) return anchor;
  if (anchor.startsWith("field:")) return `누름틀 "${anchor.slice("field:".length)}"`;
  return anchor.startsWith("merge:") ? `메일머지 "${anchor.slice("merge:".length)}"` : undefined;
}

/** 이 건의 계획에서 실제로 값을 넣은(대상이 있는) 채움 액션의 데이터 경로: 암묵 채움은 앵커(`{{키}}`·`field:이름`·`merge:키`), 명시 연결은 규칙의 경로다. */
function filledPaths(plan: PlanReport, template: Template): Set<string> {
  const paths = new Set<string>();
  for (const a of plan.actions) {
    if (a.type !== "fill" || a.targets === 0) continue;
    if (a.ruleId === "implicit") {
      const m = /^\{\{(.+)\}\}$|^(?:field|merge):(.+)$/.exec(a.anchor);
      const path = m?.[1] ?? m?.[2];
      if (path !== undefined) paths.add(path);
      continue;
    }
    const rule = template.rules.find((r) => r.id === a.ruleId);
    if (rule?.do.type === "fill" && "path" in rule.do.value) paths.add(rule.do.value.path);
  }
  return paths;
}

/**
 * 이 건에서 줄바꿈·탭이 든 값이 실제로 들어간 자리(키)의 알림. 같은 키의 일부 곳만 건너뛰었어도(다른 종류, 채울 수 없는 모양) 한 곳이라도 채웠으면 알린다.
 * 줄바꿈 값이 있는 건만 엔진의 공개 `buildFillPlan`으로 계획을 다시 세워 실제 채운 액션을 본다(값 원문과 계획은 응답에 넣지 않는다).
 */
function multilineNotes(record: BatchRecord, keys: readonly string[], planOf: (dataset: Dataset) => PlanReport, template: Template): ReportEntry[] {
  if (!("dataset" in record)) return [];
  const multiline = keys.filter((key) => {
    const j = judge(record.dataset, key);
    return j.state === "ok" && j.multiline;
  });
  if (multiline.length === 0) return [];
  const filled = filledPaths(planOf(record.dataset), template);
  return multiline.filter((key) => filled.has(key)).map((key) => entry("QUICK_MULTILINE", undefined, `키 ${key}`));
}

export type Generated = { view: ResultView; output?: Uint8Array };

/** 엔진의 건별 결과(`BatchItem`)를 화면 보고로 바꾼다. 번호는 0부터이고(파일 이름의 번호는 1부터) 값 원문은 담지 않는다. */
function toGenerated(item: BatchItem, multiline: () => ReportEntry[]): Generated {
  const view: ResultView = {
    index: item.index - 1,
    name: item.name,
    ok: item.ok,
    filled: item.filled,
    skipped: item.skipped.map((s) => entry(s.code, s.message, placeOf(s.anchor))),
    errors: item.errors.map((e) => entry(e.code, e.message)),
    notes: item.ok ? [...multiline(), ...item.warnings.map((w) => entry(w.code, w.message, w.anchor === undefined ? undefined : placeOf(w.anchor)))] : [],
  };
  if (!item.ok && view.errors.length === 0) view.errors.push(entry("QUICK_GENERATE_FAILED"));
  return item.ok && item.output !== undefined ? { view, output: item.output } : { view: { ...view, ok: false } };
}

/**
 * 모든 건을 차례로 만든다(엔진의 `generateBatch`: 템플릿 없이 `{{키}}`·누름틀·메일머지를 채우고, 한 건이 실패해도 나머지는 만든다. 이름은 엔진의 `planBatchNames`).
 * 실제 성공 출력 바이트를 누적한다. 한도를 넘는 건부터 실패로 보고하고 이후 엔진 생성을 중단한다.
 */
export function generateAll(source: Uint8Array, places: PlacesView, data: QuickData, fileName: string, missing: MissingPolicy, template: Template = emptyTemplate()): Generated[] {
  const out: Generated[] = [];
  let resultBytes = 0;
  // 줄바꿈 알림을 볼 키: 채울 수 있는 누름틀·메일머지 키, `{{키}}`, 명시 연결의 경로
  const keys = [...new Set([
    ...places.fields.filter((f) => f.usable && f.fillable > 0).map((f) => f.name),
    ...places.placeholders.map((p) => p.key),
    ...template.rules.flatMap((r) => (r.do.type === "fill" && "path" in r.do.value ? [r.do.value.path] : [])),
  ])];
  let doc: HwpxDocument | undefined;
  const planOf = (dataset: Dataset): PlanReport => buildFillPlan((doc ??= parseDocument(openPackage(source))), template, dataset, { missing }).report;
  for (const item of generateBatch(source, template, data.records, { baseName: fileName, missing })) {
    const bytes = item.ok ? item.output?.byteLength ?? 0 : 0;
    if (resultBytes + bytes > MAX_RESULT_BYTES) {
      const names = planBatchNames(data.records, fileName);
      for (let index = item.index - 1; index < data.records.length; index++) {
        out.push({ view: { index, name: names[index]!, ok: false, filled: 0, skipped: [], notes: [],
          errors: [entry("QUICK_TOO_LARGE", `성공 결과 총합이 ${MAX_RESULT_BYTES / 1024 / 1024} MiB를 넘어 이 건부터 만들지 않았습니다.`)] } });
      }
      break;
    }
    resultBytes += bytes;
    const record = data.records[item.index - 1] as BatchRecord;
    out.push(toGenerated(item, () => multilineNotes(record, keys, planOf, template)));
  }
  return out;
}
