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
  generate,
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
import type { DataForm, DataKey, Leftover, Match, MatchState, MissingPolicy, PlacesView, ReportEntry, ResultView, UnfillableShape } from "./quick-types.ts";
import { plainOf } from "./quick-messages.ts";

/** 한 번에 만들 수 있는 건수 */
export const MAX_RECORDS = 1000;
/** 성공 결과 바이트 총합의 한도 */
export const MAX_RESULT_BYTES = 512 * 1024 * 1024;
export const MAX_KEYS = 1000;
export const MAX_CANDIDATES = 200;
const MAX_KEY_DEPTH = 8;

// ── 남은 자리 ────────────────────────────────────────────────────

/** 글 속의 `{{…}}` 하나(안쪽 글은 앞뒤 공백을 떼어 키로 본다). 엔진 `findPlaceholders`와 달리 키 꼴을 따지지 않는다 */
const LEFTOVER = /\{\{([^{}]*)\}\}/g;
/** 구간 표기 `{{#이름}}`·`{{/이름}}`(요구 문서 8.8의 4)는 자리가 아니다 */
const isRangeMark = (key: string): boolean => key.startsWith("#") || key.startsWith("/");

/** 글들에 남은 `{{…}}`를 키별로 센다(구간 표기 제외). 작업창과 빠른 생성이 함께 쓰는 판정이다 */
export function findLeftovers(texts: Iterable<string>): Leftover {
  const keys = new Map<string, number>();
  let count = 0;
  for (const text of texts) {
    for (const m of text.matchAll(LEFTOVER)) {
      const key = m[1]!.trim();
      if (isRangeMark(key)) continue;
      keys.set(key, (keys.get(key) ?? 0) + 1);
      count++;
    }
  }
  return { count, keys: [...keys].map(([key, n]) => ({ key, count: n })) };
}

/** HWPX 결과의 모든 문단(본문·표 칸·머리말·꼬리말·글상자)에 남은 `{{…}}` */
export function leftoverIn(bytes: Uint8Array): Leftover {
  const doc = parseDocument(openPackage(bytes));
  return findLeftovers(doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)].map((p) => p.logicalText)));
}

/** 값 속 중괄호를 전각 중괄호로 바꾼 데이터(키는 그대로). 값에서 온 `{{…}}`를 남은 자리로 세지 않으려고 같은 생성을 한 번 더 돌릴 때 쓴다 */
function maskBraces(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/[{}]/g, (c) => (c === "{" ? "｛" : "｝"));
  if (Array.isArray(value)) return value.map(maskBraces);
  return isObj(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskBraces(v)])) : value;
}
const hasBraces = (value: unknown): boolean =>
  typeof value === "string" ? /[{}]/.test(value) : Array.isArray(value) ? value.some(hasBraces) : isObj(value) && Object.values(value).some(hasBraces);

/**
 * 결과에 남은 `{{…}}`. 데이터 값은 글 그대로 들어가므로 값에 중괄호가 있으면 그 글도 결과에 보인다. 그때만(결과에 `{{…}}`가 있고 값에 중괄호가 있을 때)
 * 값의 중괄호를 가린 데이터로 같은 생성(`rerun`)을 한 번 더 돌려 그 결과에서 센다. 다시 돌린 생성이 실패하면 처음 센 것을 쓴다(덜 세지 않는다).
 */
export function leftoverOf(output: Uint8Array, dataset: Dataset | undefined, rerun: (masked: Dataset) => Uint8Array | undefined): Leftover {
  const found = leftoverIn(output);
  if (found.count === 0 || dataset === undefined || !hasBraces(dataset.data) && !hasBraces(dataset.derived)) return found;
  const probe = rerun({ data: maskBraces(dataset.data) as Dataset["data"], derived: maskBraces(dataset.derived) as Dataset["derived"] });
  return probe === undefined ? found : leftoverIn(probe);
}

/** 사람이 읽는 남은 자리 설명(키 이름과 곳 수만. 값 원문은 없다): `남은 자리 4곳: {{a}} 2곳, {{b (원)}} 2곳` */
export function describeLeftover(left: Leftover): string {
  const shown = left.keys.slice(0, 20).map((k) => `{{${k.key}}} ${k.count}곳`).join(", ");
  return `남은 자리 ${left.count}곳: ${shown}${left.keys.length > 20 ? ` 외 ${left.keys.length - 20}개 키` : ""}`;
}

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
 * 키가 경로 꼴이 아닌 `{{…}}`(구간 표기 제외)는 `offRule`에 센다. 엔진이 채우지 않아 결과에 남는 자리다. 목록에 오른 필드의 표시 글 안의 것은 그 필드가 자리이므로 세지 않는다.
 */
export function analyzePlaces(bytes: Uint8Array): PlacesView {
  const doc = parseDocument(openPackage(bytes));

  const tallies = new Map<string, FieldTally>();
  /** 표시 글을 맡는 메일머지 */
  const owners: FieldTarget[] = [];
  /** 목록에 오르는 필드(이름 있는 누름틀·키 있는 메일머지) */
  const listed: FieldTarget[] = [];
  for (const target of collectFields(doc)) {
    const f = target.info;
    const key = f.type === "CLICK_HERE" ? f.name : f.type === "MAILMERGE" ? f.mergeKey : undefined;
    if (key === undefined) continue;
    listed.push(target);
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
  const offRuleCounts = new Map<string, number>();
  for (const section of doc.sections) {
    for (const par of walkParagraphs(section.paragraphs)) {
      const inside = (fields: readonly FieldTarget[], start: number, end: number): boolean => fields.some((t) => {
        const r = fieldRangeIn(t, par);
        return r !== undefined && start < r.until && end > r.from;
      });
      for (const h of findPlaceholders(par.logicalText)) {
        if (!inside(owners, h.start, h.end)) placeholderCounts.set(h.path, (placeholderCounts.get(h.path) ?? 0) + 1);
      }
      for (const m of par.logicalText.matchAll(LEFTOVER)) {
        const key = m[1]!.trim();
        if (isRangeMark(key) || isValidPath(key) || inside(listed, m.index, m.index + m[0].length)) continue;
        offRuleCounts.set(key, (offRuleCounts.get(key) ?? 0) + 1);
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
    offRule: [...offRuleCounts].map(([key, count]) => ({ key, count })),
    candidates: candidates.slice(0, MAX_CANDIDATES).map((c) => ({ kind: c.kind as "emptyCell" | "labelColon" | "blankMark", evidence: c.evidence })),
    candidatesTruncated: candidates.length > MAX_CANDIDATES,
  };
}

// ── 데이터: 건 나누기, 키 목록 ───────────────────────────────────

export type QuickData = { form: DataForm; records: BatchRecord[] };

/** G2B Helper 내보내기 파일의 꼴 이름: 생성 요청(`/api/g2b` 2판)과 같은 꼴 `{ format, version: 2, items, columns? }`(엔진 명세 8.8.14) */
const HELPER_FORMAT = "studio-generate";

const flat = (data: Record<string, unknown>): BatchRecord => ({ dataset: { data, derived: {} } });

/**
 * 올린 JSON을 건으로 나눈다(엔진의 `readBatchRecords`): 최상위가 배열이면 원소마다 한 건, 묶음 형식(`hwpx-studio/dataset@1`)의 `data`가 배열이면
 * 원소마다 한 건(`derived`는 공유), 객체이면 한 건이다. 객체가 아닌 원소는 그 건만 `DATA_SCHEMA`로 실패한다.
 * G2B Helper 내보내기 파일(`format: "studio-generate"`, 엔진 명세 8.8.14)은 먼저 알아본다: `version`이 2가 아니거나 `items`가 배열이 아니면 `QUICK_BAD_DATA`,
 * `items[]`마다 `values`가 한 건(라벨–값 그대로)이고 `values`가 객체가 아닌 항목은 그 건만 `DATA_SCHEMA`다. `requestId`·`profileId`(비어도 됨)·`allowEmpty`·`selections`·`meta`·`types`·`columns`는 쓰지 않는다.
 * JSON이 아니면 `BAD_JSON`(400), 그 밖의 모양이면 `QUICK_BAD_DATA`, 건이 없거나 너무 많으면 `QUICK_NO_RECORDS`·`QUICK_TOO_MANY_RECORDS`다.
 * 묶음 형식의 `data`·`derived`가 틀리면 엔진의 `DATA_SCHEMA`(`HwpxError`)가 올라온다.
 */
export function parseQuickData(body: Uint8Array): QuickData {
  const raw = parseJson(body);
  // 글자 하나(JSON 문자열)를 엔진에 넘기면 JSON 본문으로 다시 읽으므로, 객체나 배열이 아니면 여기서 거절한다
  if (!Array.isArray(raw) && !isObj(raw)) throw new HostError(400, "QUICK_BAD_DATA", "데이터는 JSON 객체 하나이거나 객체의 배열이어야 합니다.");
  let form: DataForm;
  let records: BatchRecord[];
  if (isObj(raw) && raw["format"] === HELPER_FORMAT) {
    const items = raw["items"];
    if (raw["version"] !== 2 || !Array.isArray(items)) throw new HostError(400, "QUICK_BAD_DATA", `Helper 내보내기 파일은 version 2이고 items 배열이 있어야 합니다(올린 파일은 version ${JSON.stringify(raw["version"] ?? null)}).`);
    form = "helperExport";
    records = items.map((item, i) => (isObj(item) && isObj(item["values"]) ? flat(item["values"]) : { error: { code: "DATA_SCHEMA", message: `${i + 1}번째 Helper 항목에 values 객체가 없습니다.` } }));
  } else {
    const batch = readBatchRecords(raw);
    if (batch !== undefined) {
      form = Array.isArray(raw) ? "array" : "bundleArray";
      records = batch;
    } else {
      // 배열이면 위에서 건으로 나뉘었으므로 객체 하나다
      form = (raw as Record<string, unknown>)["schema"] === DATASET_SCHEMA ? "bundle" : "object";
      records = [{ dataset: readDataset(raw) }];
    }
  }
  if (records.length === 0) throw new HostError(400, "QUICK_NO_RECORDS", form === "helperExport" ? "Helper 내보내기 파일의 items가 비어 있습니다." : "데이터에 만들 건이 없습니다.");
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
 * 자리(누름틀 이름·`{{키}}`)마다 모든 건에서 데이터와 맞는지 센다. 키로 쓸 수 없는 누름틀 이름과 규칙 밖 `{{…}}`(`offRule`. 엔진이 채우지 않는 것)는 `badKey`,
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
    ...places.offRule.map((p) => one("placeholder", p.key, "badKey")),
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
 * 결과에 남은 `{{…}}`에 누락 정책을 적용한다: `error`면 그 건을 실패(`QUICK_LEFTOVER`, 파일 없음)로 바꾸고, 그 밖이면 성공에 알림(`QUICK_LEFTOVER_KEPT`)을 단다.
 * 어느 쪽이든 `leftover`에 키별 곳 수를 남긴다. 채운 곳 수·건너뜀은 그대로 둔다(무엇을 채웠고 왜 남았는지 함께 보이게).
 */
export function applyLeftover(g: Generated, left: Leftover, missing: MissingPolicy): Generated {
  if (left.count === 0 || g.output === undefined) return g;
  const detail = describeLeftover(left);
  if (missing === "error") return { view: { ...g.view, ok: false, notes: [], errors: [entry("QUICK_LEFTOVER", detail)], leftover: left } };
  return { view: { ...g.view, notes: [...g.view.notes, entry("QUICK_LEFTOVER_KEPT", detail)], leftover: left }, output: g.output };
}

/**
 * 모든 건을 차례로 만든다(엔진의 `generateBatch`: 템플릿 없이 `{{키}}`·누름틀·메일머지를 채우고, 한 건이 실패해도 나머지는 만든다. 이름은 엔진의 `planBatchNames`).
 * 성공한 건은 결과에 남은 `{{…}}`를 세어 누락 정책을 적용한다(`applyLeftover`).
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
    const record = data.records[item.index - 1] as BatchRecord;
    const dataset = "dataset" in record ? record.dataset : undefined;
    let g = toGenerated(item, () => multilineNotes(record, keys, planOf, template));
    if (g.output !== undefined) {
      const rerun = (masked: Dataset): Uint8Array | undefined => {
        const probe = generate(source, template, masked, { missing });
        return probe.ok && !probe.dryRun ? probe.output : undefined;
      };
      g = applyLeftover(g, leftoverOf(g.output, dataset, rerun), missing);
    }
    const bytes = g.output?.byteLength ?? 0;
    if (resultBytes + bytes > MAX_RESULT_BYTES) {
      const names = planBatchNames(data.records, fileName);
      for (let index = item.index - 1; index < data.records.length; index++) {
        out.push({ view: { index, name: names[index]!, ok: false, filled: 0, skipped: [], notes: [],
          errors: [entry("QUICK_TOO_LARGE", `성공 결과 총합이 ${MAX_RESULT_BYTES / 1024 / 1024} MiB를 넘어 이 건부터 만들지 않았습니다.`)] } });
      }
      break;
    }
    resultBytes += bytes;
    out.push(g);
  }
  return out;
}
