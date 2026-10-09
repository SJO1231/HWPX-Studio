// Helper 생성 창구 `/api/g2b` 2판(엔진 명세 8.8.14 "`/api/g2b` 2판 계약", 확정 2026-10-09, #133).
// 요청 `{ format: "studio-generate", version: 2, … }`만 여기로 온다. 1판 요청은 `g2b.ts`(1판 다리)가 그대로 처리한다.
// 생성은 엔진 2단계 생성(`generateFromTemplate`)과 값 타입 7종(#131)으로 하고 값은 고치지 않는다.
// 기록에는 요청 번호·지문·서식 id·판·결과·경로·파일 해시만 남긴다(값·파일 바이트는 저장하지 않는다). 메시지에 값 원문을 넣지 않는다.
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import {
  CASE_SCHEMA, VALUE_FORMATS, bindValues, canonicalStudioJson, contentSha256, generateFromTemplate, readStudioTemplate, selectSlots,
  sha256Hex, templateSha256, writeStudioTemplate,
  type BlobLoader, type BoundValue, type Condition, type SlotSelection, type StudioCase, type StudioTemplate, type TemplateSlot, type ValueFormat,
} from '@hwpx-studio/engine';
import { plainOf } from './quick-messages.ts';

export const STUDIO_GENERATE = 'studio-generate';
const MAX_ITEMS = 100;
const NAME_LIMIT = 120;
const DEFAULT_FILE_RULE = '{identity}_{서식명}';

type Warning = { code: string; field?: string; message: string };
type Undecided = { slot: string; reason: string; fields?: string[]; candidates: { block: string; label: string }[] };
type Status = 'success' | 'needs-input' | 'error';
export type Result = {
  itemIndex: number; status: Status; path?: string; reused?: boolean; code?: string; message?: string;
  missingFields?: string[]; invalidFields?: { field: string; type: ValueFormat }[]; undecided?: Undecided[]; warnings?: Warning[];
};
export type Reply = {
  requestId: string; status: Status | 'partial'; warnings: Warning[]; results: Result[];
  summary: { succeeded: number; needsInput: number; failed: number; timings: { itemIndex: number; ms: number }[]; totalMs: number };
};
type Meta = { identity: string[]; stage?: string; recordId?: string };
type Item = { values: Record<string, unknown>; allowEmpty: string[]; selections: Record<string, string>; meta: Meta };
type Column = { key: string; label: string; type: ValueFormat; codes?: unknown; stages?: string[] };
type Request = { requestId: string; profileId: string; dryRun: boolean; types: Record<string, ValueFormat>; items: Item[]; columns?: Column[] };
type Profile = { id: string; label: string; templateId: string; version: number; outputDirectory: string; fileName?: string };

/** 요청 전체 오류(400·409·413·415). 응답은 `{ requestId?, code, message }` */
export class G2B2Error extends Error {
  status: number; code: string; requestId?: string;
  constructor(status: number, code: string, message: string, requestId?: string) { super(message); this.status = status; this.code = code; if (requestId !== undefined) this.requestId = requestId; }
}
export const g2b2Body = (e: G2B2Error) => ({ ...(e.requestId === undefined ? {} : { requestId: e.requestId }), code: e.code, message: e.message });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PROFILE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const FORMATS: readonly string[] = VALUE_FORMATS;
const say = (code: string, detail = '') => plainOf(code) + (detail === '' ? '' : ` ${detail}`);

// ── 요청 읽기 ────────────────────────────────────────────────────

const TOP = ['format', 'version', 'requestId', 'profileId', 'dryRun', 'types', 'items', 'columns'];
const ITEM_KEYS = ['values', 'allowEmpty', 'selections', 'meta'];
const META_KEYS = ['identity', 'stage', 'recordId'];
const COLUMN_KEYS = ['key', 'label', 'type', 'codes', 'stages'];

/** 계약의 요청 꼴을 읽는다. 틀리면 400 `INVALID_REQUEST`. 모르는 항목은 무시하고 최상위 경고 `UNKNOWN_FIELD`(같은 이름은 한 번) */
export function readRequest(raw: unknown): { request: Request; warnings: Warning[] } {
  if (!isObj(raw)) throw new G2B2Error(400, 'INVALID_REQUEST', say('INVALID_REQUEST', '요청은 JSON 객체여야 합니다.'));
  const id = typeof raw['requestId'] === 'string' && raw['requestId'].length >= 1 && raw['requestId'].length <= 200 && !CONTROL.test(raw['requestId']) ? raw['requestId'] : undefined;
  const bad = (detail: string): never => { throw new G2B2Error(400, 'INVALID_REQUEST', say('INVALID_REQUEST', detail), id); };
  const warnings: Warning[] = [];
  const unknown = (o: Record<string, unknown>, known: readonly string[], where: string) => {
    for (const k of Object.keys(o)) {
      if (known.includes(k)) continue;
      const field = `${where}${k}`;
      if (!warnings.some(w => w.field === field)) warnings.push({ code: 'UNKNOWN_FIELD', field, message: say('UNKNOWN_FIELD', `항목: ${field}`) });
    }
  };
  /** 열 이름: 빈 이름·제어 문자 금지, NFC로 맞춘다(괄호·공백·점은 그대로) */
  const key = (k: unknown, where: string): string => {
    if (typeof k !== 'string') return bad(`${where}: 열 이름은 글이어야 합니다.`);
    const n = k.normalize('NFC');
    if (n === '' || CONTROL.test(n)) bad(`${where}: 열 이름은 비어 있거나 제어 문자를 담을 수 없습니다.`);
    return n;
  };
  const keyed = <T>(o: Record<string, unknown>, where: string, value: (v: unknown, k: string) => T): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(o)) {
      const n = key(k, where);
      if (Object.hasOwn(out, n)) bad(`${where}: NFC로 맞추면 같은 열 이름이 둘 있습니다.`);
      out[n] = value(v, n);
    }
    return out;
  };
  const format = (v: unknown, where: string): ValueFormat => typeof v === 'string' && FORMATS.includes(v) ? v as ValueFormat : bad(`${where}: 모르는 타입 이름입니다(text·number·money·percent·date·datetime·boolean).`);

  if (raw['format'] !== STUDIO_GENERATE || raw['version'] !== 2) bad('format은 "studio-generate", version은 2여야 합니다.');
  if (id === undefined) bad('requestId는 제어 문자 없는 1~200자 글이어야 합니다.');
  if (typeof raw['profileId'] !== 'string' || !PROFILE_ID.test(raw['profileId'])) bad('profileId는 영문·숫자·_·- 1~80자여야 합니다.');
  if (raw['dryRun'] !== undefined && typeof raw['dryRun'] !== 'boolean') bad('dryRun은 참거짓이어야 합니다.');
  if (raw['types'] !== undefined && !isObj(raw['types'])) bad('types는 열 이름 → 타입 이름 객체여야 합니다.');
  if (!Array.isArray(raw['items']) || raw['items'].length < 1 || raw['items'].length > MAX_ITEMS) bad(`items는 1~${MAX_ITEMS}개 배열이어야 합니다.`);
  unknown(raw, TOP, '');
  const types = keyed(isObj(raw['types']) ? raw['types'] : {}, 'types', (v, k) => format(v, `types.${k}`));
  const items = (raw['items'] as unknown[]).map((it, i): Item => {
    const at = `items[${i}]`;
    if (!isObj(it) || !isObj(it['values'])) return bad(`${at}: values 객체가 있어야 합니다.`);
    unknown(it, ITEM_KEYS, 'items[].');
    const values = keyed(it['values'], `${at}.values`, v => v);
    const allowEmpty = it['allowEmpty'] === undefined ? [] : Array.isArray(it['allowEmpty']) ? [...new Set(it['allowEmpty'].map(k => key(k, `${at}.allowEmpty`)))] : bad(`${at}.allowEmpty는 열 이름 배열이어야 합니다.`);
    if (it['selections'] !== undefined && !isObj(it['selections'])) bad(`${at}.selections는 분기 이름 → 블록 객체여야 합니다.`);
    const selections = keyed(isObj(it['selections']) ? it['selections'] : {}, `${at}.selections`, v => typeof v === 'string' && v !== '' ? v : bad(`${at}.selections: 블록은 비지 않은 글이어야 합니다.`));
    const meta: Meta = { identity: [] };
    if (it['meta'] !== undefined) {
      const m = it['meta'];
      if (!isObj(m)) return bad(`${at}.meta는 객체여야 합니다.`);
      unknown(m, META_KEYS, 'items[].meta.');
      if (m['identity'] !== undefined) meta.identity = Array.isArray(m['identity']) && m['identity'].length <= 20 && m['identity'].every(p => typeof p === 'string' || typeof p === 'number') ? m['identity'].map(String) : bad(`${at}.meta.identity는 글·수 20개 이하의 배열이어야 합니다.`);
      if (m['stage'] !== undefined) meta.stage = typeof m['stage'] === 'string' ? m['stage'] : bad(`${at}.meta.stage는 글이어야 합니다.`);
      if (m['recordId'] !== undefined) meta.recordId = typeof m['recordId'] === 'string' || typeof m['recordId'] === 'number' ? String(m['recordId']) : bad(`${at}.meta.recordId는 글이나 수여야 합니다.`);
    }
    return { values, allowEmpty, selections, meta };
  });
  let columns: Column[] | undefined;
  if (raw['columns'] !== undefined) {
    if (!Array.isArray(raw['columns'])) bad('columns는 배열이어야 합니다.');
    columns = (raw['columns'] as unknown[]).map((c, i): Column => {
      const at = `columns[${i}]`;
      if (!isObj(c)) return bad(`${at}는 객체여야 합니다.`);
      unknown(c, COLUMN_KEYS, 'columns[].');
      const col: Column = { key: key(c['key'], `${at}.key`), label: typeof c['label'] === 'string' ? c['label'] : bad(`${at}.label은 글이어야 합니다.`), type: format(c['type'], `${at}.type`) };
      if (c['codes'] !== undefined) col.codes = isObj(c['codes']) || Array.isArray(c['codes']) ? c['codes'] : bad(`${at}.codes는 객체나 배열이어야 합니다.`);
      if (c['stages'] !== undefined) col.stages = Array.isArray(c['stages']) && c['stages'].every(s => typeof s === 'string') ? c['stages'] as string[] : bad(`${at}.stages는 글 배열이어야 합니다.`);
      return col;
    });
  }
  return { request: { requestId: id!, profileId: raw['profileId'] as string, dryRun: raw['dryRun'] === true, types, items, ...(columns === undefined ? {} : { columns }) }, warnings };
}

/** 요청 지문: 읽어 맞춘 요청(NFC 키, 모르는 항목 제외)의 정규 JSON 해시. `dryRun`은 넣지 않는다(시험 뒤 같은 번호로 실제 생성) */
export const fingerprintOf = (r: Request): string => sha256Hex(canonicalStudioJson({ ...r, dryRun: undefined }));

// ── 서식 판 해석(판마다 한 번) ──────────────────────────────────

type Plan = {
  t: StudioTemplate; source: Uint8Array; loadBlob: BlobLoader; name: string;
  /** 열 이름(NFC) → 그 열을 읽는 값의 id. 쓰이지 않는 값의 열도 있다(서식 타입은 서식이 정한다) */
  valueOf: Map<string, string>;
  /** 값 id → 열 이름들(key 또는 path, 그다음 별칭) */
  columnsOf: Map<string, string[]>;
  /** 자리·조건이 쓰는 값 id */
  used: Set<string>;
  slotByName: Map<string, TemplateSlot>;
};

function leaves(c: Condition, out: string[] = []): string[] {
  if ('all' in c) for (const x of c.all) leaves(x, out);
  else if ('any' in c) for (const x of c.any) leaves(x, out);
  else if ('not' in c) leaves(c.not, out);
  else out.push(c.path);
  return out;
}

function planOf(t: StudioTemplate, source: Uint8Array, loadBlob: BlobLoader): Plan {
  const valueOf = new Map<string, string>(), columnsOf = new Map<string, string[]>();
  for (const b of t.bindings) {
    const names = ('key' in b ? [b.key, ...(b.aliases ?? [])] : [b.path]).map(n => n.normalize('NFC'));
    columnsOf.set(b.value, names);
    for (const n of names) valueOf.set(n, b.value);
  }
  const used = new Set<string>([...t.places.map(p => p.value), ...t.blocks.flatMap(b => b.when === undefined ? [] : leaves(b.when))]);
  return { t, source, loadBlob, name: t.meta?.name ?? t.id, valueOf, columnsOf, used, slotByName: new Map(t.slots.map(s => [s.name.normalize('NFC'), s])) };
}

// ── 한 건 ────────────────────────────────────────────────────────

/** 빈 값: `null`·`''`, text 밖 타입은 공백뿐인 글도(엔진 8.8.4의 빈 값과 같다) */
const isEmpty = (v: unknown, type: ValueFormat) => v === null || v === '' || (type !== 'text' && typeof v === 'string' && v.trim() === '');
const DATA_INVALID = new Set(['DATA_FORMAT', 'DATA_NOT_SCALAR', 'VALUE_CONTROL_CHAR']);
const RESEND: Record<string, Status> = { MISSING_FIELDS: 'needs-input', INVALID_FIELDS: 'needs-input', UNDECIDED: 'needs-input' };

/** 엔진 코드 → 창구 이름(8.8.14의 대응표) */
export function windowCode(codes: readonly string[]): string {
  if (codes.includes('DATA_ALIAS_CONFLICT')) return 'PROFILE_MAPPING_CONFLICT';
  if (codes.some(c => DATA_INVALID.has(c))) return 'INVALID_FIELDS';
  if (codes.includes('DATA_MISSING')) return 'MISSING_FIELDS';
  if (codes.includes('SEL_UNDECIDED') || codes.includes('SEL_EXCLUSIVE')) return 'UNDECIDED';
  if (codes.some(c => c === 'SEL_RECHECK' || c === 'PLACE_UNREGISTERED' || c.startsWith('TPL_') || c.startsWith('ANCHOR_') || c.startsWith('FRAG_'))) return 'TEMPLATE_RECHECK';
  return 'GENERATION_FAILED';
}

const fail = (itemIndex: number, code: string, detail: string, warnings: Warning[], extra: Partial<Result> = {}): Result =>
  ({ itemIndex, status: RESEND[code] ?? 'error', code, message: say(code, detail), ...extra, ...(warnings.length ? { warnings } : {}) });

type Evaluated = { result: Result } | { record: Record<string, unknown>; c: StudioCase | undefined; warnings: Warning[] };

/** 값 규칙·타입·빈 값·분기를 엔진 생성 전에 판정한다. 막히면 건 결과(우선순위: 연결 겹침 → 읽을 수 없는 값 → 빈 값 → 분기) */
function evaluate(p: Plan, item: Item, types: Record<string, ValueFormat>, itemIndex: number): Evaluated {
  const { t } = p;
  const warnings: Warning[] = [];
  const defOf = new Map(t.values.map(v => [v.id, v]));
  const formatOf = (col: string): ValueFormat => { const v = p.valueOf.get(col); return v === undefined ? types[col] ?? 'text' : defOf.get(v)!.format; };
  for (const [col, type] of Object.entries(types)) {
    const v = p.valueOf.get(col);
    if (v !== undefined && defOf.get(v)!.format !== type) warnings.push({ code: 'TYPE_MISMATCH', field: col, message: say('TYPE_MISMATCH', `열: ${col}(요청 ${type}, 서식 ${defOf.get(v)!.format})`) });
  }
  const usedColumn = (col: string) => { const v = p.valueOf.get(col); return v !== undefined && p.used.has(v); };
  for (const col of item.allowEmpty) if (!usedColumn(col)) warnings.push({ code: 'ALLOW_EMPTY_UNUSED', field: col, message: say('ALLOW_EMPTY_UNUSED', `열: ${col}`) });
  const chosen: StudioCase['selections'] = {};
  for (const [name, block] of Object.entries(item.selections)) {
    const slot = p.slotByName.get(name);
    if (slot === undefined) { warnings.push({ code: 'SELECTION_UNKNOWN_SLOT', field: name, message: say('SELECTION_UNKNOWN_SLOT', `분기: ${name}`) }); continue; }
    const b = t.blocks.find(x => x.id === block && x.slot === slot.id);
    // 없는 블록은 내용 해시 없이 넘겨 엔진이 다시 고를 분기(recheck·blockMissing)로 판정하게 한다
    chosen[slot.id] = { block, basis: 'manual', content: b === undefined ? '' : contentSha256(b.content) };
  }

  // 데이터 한 행: 빈 값은 없는 열로 보고, allowEmpty의 열은 빈 글로 넣는다. 서식이 쓰지 않는 열은 값이 무엇이든 읽지 않는다(Helper가 보낸 정상 열)
  const record: Record<string, unknown> = {};
  const invalid: { field: string; type: ValueFormat }[] = [];
  for (const [col, v] of Object.entries(item.values)) {
    const type = formatOf(col);
    if (isEmpty(v, type)) continue;
    record[col] = v;
  }
  const allow = new Set(item.allowEmpty);
  for (const id of p.used) {
    const names = p.columnsOf.get(id) ?? [];
    const allowed = names.find(n => allow.has(n));
    if (allowed !== undefined && !names.some(n => Object.hasOwn(record, n))) record[allowed] = '';
  }
  const c: StudioCase | undefined = Object.keys(chosen).length === 0 ? undefined : {
    schema: CASE_SCHEMA, template: { id: t.id, version: t.version, sha256: templateSha256(t) },
    record: { dataset: 'g2b', version: 1, row: itemIndex, sha256: sha256Hex(canonicalStudioJson(record)) },
    selections: chosen, valueEdits: {}, blockEdits: {},
  };

  const bound = bindValues(t, record, c, { missing: 'error' });
  const byId = new Map(bound.map(v => [v.id, v]));
  /** 이 값의 열 가운데 요청이 보낸 이름(없으면 연결의 첫 이름) */
  const sentName = (id: string) => { const names = p.columnsOf.get(id) ?? [id]; return names.find(n => Object.hasOwn(item.values, n)) ?? names[0]!; };
  const conflicts: string[] = [];
  for (const v of bound) {
    if (!p.used.has(v.id) || v.state !== 'rejected') continue;
    if (v.issue?.code === 'DATA_ALIAS_CONFLICT') conflicts.push(...(p.columnsOf.get(v.id) ?? []).filter(n => Object.hasOwn(record, n)));
    else invalid.push({ field: (p.columnsOf.get(v.id) ?? []).find(n => Object.hasOwn(record, n)) ?? sentName(v.id), type: v.format });
  }
  if (conflicts.length) return { result: fail(itemIndex, 'PROFILE_MAPPING_CONFLICT', `열: ${conflicts.join(', ')}`, warnings) };
  if (invalid.length) return { result: fail(itemIndex, 'INVALID_FIELDS', `열: ${invalid.map(f => `${f.field}(${f.type})`).join(', ')}`, warnings, { invalidFields: invalid }) };

  const selections = selectSlots(t, bound, c);
  const picked = new Set(selections.filter(s => s.block !== undefined && s.blocked === undefined && s.state !== 'recheck').map(s => s.block!));
  const missing: string[] = [];
  for (const place of t.places) {
    if ('where' in place && place.where !== undefined && !picked.has(place.where)) continue;
    const v = byId.get(place.value);
    if (v?.state === 'missing' && !missing.includes(sentName(v.id))) missing.push(sentName(v.id));
  }
  if (missing.length) return { result: fail(itemIndex, 'MISSING_FIELDS', `열: ${missing.join(', ')}`, warnings, { missingFields: missing }) };
  const undecided = selections.flatMap(s => s.blocked === 'SEL_UNDECIDED' || s.blocked === 'SEL_EXCLUSIVE' || (s.state === 'recheck' && s.reason === 'blockMissing') ? [undecidedOf(p, s, byId, sentName)] : []);
  if (undecided.length) return { result: fail(itemIndex, 'UNDECIDED', `분기: ${undecided.map(u => `${u.slot}(${u.reason})`).join(', ')}`, warnings, { undecided }) };
  return { record, c, warnings };
}

/** 정하지 못한 분기: 동률·값 없음·읽을 수 없음은 그 블록들, 확정 필요는 계산된 블록, 후보 없음·없는 블록 선택·배타 위반은 그 분기의 모든 블록 */
function undecidedOf(p: Plan, s: SlotSelection, byId: Map<string, BoundValue>, sentName: (id: string) => string): Undecided {
  const slot = p.t.slots.find(x => x.id === s.slot)!;
  const own = p.t.blocks.filter(b => b.slot === slot.id);
  const reason = s.reason ?? 'noCandidate';
  const ids = reason === 'needConfirm' && s.block !== undefined ? [s.block] : reason !== 'exclusive' && s.candidates?.length ? s.candidates : own.map(b => b.id);
  const candidates = ids.flatMap(id => { const b = own.find(x => x.id === id); return b === undefined ? [] : [{ block: b.id, label: b.name }]; });
  const out: Undecided = { slot: slot.name, reason, candidates };
  if (reason === 'valueMissing') {
    const fields = [...new Set(own.filter(b => ids.includes(b.id) && b.when !== undefined).flatMap(b => leaves(b.when!)).filter(id => byId.get(id)?.state === 'missing').map(sentName))];
    if (fields.length) out.fields = fields;
  }
  // 배타 위반(엔진 8.8.8): 고른 조건 블록이 쓰는 결정 값. 짝 분기도 같은 꼴로 따로 나온다
  const when = reason === 'exclusive' ? own.find(b => b.id === s.block)?.when : undefined;
  if (when !== undefined) out.fields = [...new Set(leaves(when).map(sentName))];
  return out;
}

/** 엔진 생성. 실패하면 창구 이름으로 옮긴 건 결과 */
function produce(p: Plan, e: Extract<Evaluated, { record: unknown }>, itemIndex: number, dryRun: boolean): { result: Result } | { output?: Uint8Array } {
  let r;
  try { r = generateFromTemplate(p.source, p.t, e.record, e.c, p.loadBlob, { dryRun, missing: 'error' }); }
  catch (err) { return { result: fail(itemIndex, 'GENERATION_FAILED', `(엔진: ${(err as { code?: string }).code ?? '예외'})`, e.warnings) }; }
  if (!r.ok) {
    const issues = r.report.issues.filter(i => i.severity === 'error');
    const codes = [...new Set(issues.map(i => i.code))];
    const code = windowCode(codes);
    const fields = [...new Set(issues.filter(i => i.where?.startsWith('value:')).map(i => (p.columnsOf.get(i.where!.slice(6)) ?? [i.where!.slice(6)])[0]!))];
    const extra: Partial<Result> = code === 'MISSING_FIELDS' ? { missingFields: fields } : code === 'INVALID_FIELDS' ? { invalidFields: fields.map(f => ({ field: f, type: p.t.values.find(v => v.id === p.valueOf.get(f))?.format ?? 'text' })) } : {};
    return { result: fail(itemIndex, code, `(엔진: ${codes.join(', ')})`, e.warnings, extra) };
  }
  // 등록 안 된 자리(#134)는 그 건의 경고로(최상위 warnings는 정상 요청에서 비어 있어야 한다). 이 건의 경고 목록에 더한다
  e.warnings.push(...r.report.warnings.filter(w => w.code === 'PLACE_UNREGISTERED').map(unregistered));
  return r.dryRun ? {} : { output: r.output as Uint8Array };
}

const FIELD_KIND: Record<string, string> = { clickHere: '누름틀', mailMerge: '메일머지' };
/** 엔진 경고(8.8.12): `where`는 `clickHere:이름`·`mailMerge:키`·`{{키}}`, 곳 수는 메시지의 "N곳" */
function unregistered(w: { code: string; message: string; where?: string }): Warning {
  const where = w.where ?? '', at = where.indexOf(':'), kind = FIELD_KIND[where.slice(0, at)];
  const name = kind === undefined ? where.slice(2, -2) : where.slice(at + 1), n = / (\d+)곳/.exec(w.message)?.[1];
  return { code: w.code, field: name, message: say(w.code, `(${kind ?? '{{키}}'} ${name}${n === undefined ? '' : ` ${n}곳`})`) };
}

// ── 파일 이름·저장 ───────────────────────────────────────────────

const RULE_TOKEN = /^(?:identity|identity\[\d{1,2}\]|서식명|stage|recordId)$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 파일 이름(확장자 빼고): 프로필 규칙. identity가 비면 `g2b-<요청 번호 해시 10자>-<순번>`. 금지 글자는 `_`, 앞뒤 공백·점은 지운다 */
export function fileBase(rule: string, meta: Meta, templateName: string, requestId: string, itemIndex: number): string {
  const fallback = `g2b-${sha256Hex(requestId).slice(0, 10)}-${itemIndex + 1}`;
  if (!meta.identity.some(x => x.trim() !== '')) return fallback;
  const raw = rule.replace(/\{([^{}]*)\}/g, (_, token: string) => {
    const at = /^identity\[(\d+)\]$/.exec(token);
    return at ? meta.identity[Number(at[1])] ?? '' : token === 'identity' ? meta.identity.join('_') : token === '서식명' ? templateName : token === 'stage' ? meta.stage ?? '' : token === 'recordId' ? meta.recordId ?? '' : '';
  });
  const trim = (s: string) => s.replace(/^[\s.]+|[\s.]+$/gu, '');
  let name = trim([...trim(raw.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_'))].slice(0, NAME_LIMIT).join(''));
  if (RESERVED.test(name)) name += '_';
  return name === '' ? fallback : name;
}

/** 덮어쓰지 않는 저장: 다 쓴 임시 파일을 새 이름에 링크한다. 같은 이름이 있으면 해시가 같을 때만 그것을 쓴다 */
function publish(path: string, bytes: Uint8Array, sha: string): 'written' | 'same' | 'other' {
  const existing = (): 'same' | 'other' | undefined => {
    try { const st = lstatSync(path); return !st.isFile() ? 'other' : sha256Hex(readFileSync(path)) === sha ? 'same' : 'other'; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  };
  const found = existing();
  if (found !== undefined) return found;
  const temporary = join(dirname(path), `.g2b-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx'); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, path); return 'written'; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; return existing() ?? 'other'; }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}

/** 저장 실패 사유: 파일 체계 오류는 코드만(메시지에는 경로·이름이 들어가므로 넣지 않는다) */
const outputReason = (e: unknown) => { const code = (e as NodeJS.ErrnoException | null)?.code; return typeof code === 'string' ? `(${code})` : e instanceof Error ? e.message : ''; };

/** 첫 처리의 이름 정하기: 같은 이름이 해시가 같으면 재사용, 다르면 `-2`·`-3`… */
function place(directory: string, base: string, bytes: Uint8Array, sha: string): { path: string; reused: boolean } {
  for (let n = 1; n <= 999; n++) {
    const path = join(directory, `${n === 1 ? base : `${base}-${n}`}.hwpx`);
    const outcome = publish(path, bytes, sha);
    if (outcome !== 'other') return { path, reused: outcome === 'same' };
  }
  throw new Error('같은 이름의 다른 파일이 너무 많습니다.');
}

// ── 창구 ─────────────────────────────────────────────────────────

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const ms = (from: number) => Math.round((performance.now() - from) * 10) / 10;

export function createG2B2(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS g2b_profile (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS g2b_template (id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY (id, version));
    CREATE TABLE IF NOT EXISTS g2b_blob (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS g2b2_request (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, template_id TEXT NOT NULL, template_version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS g2b2_item (request_id TEXT NOT NULL, item_index INTEGER NOT NULL, status TEXT NOT NULL, code TEXT, path TEXT, sha256 TEXT, result TEXT NOT NULL, PRIMARY KEY (request_id, item_index));
    CREATE TABLE IF NOT EXISTS g2b_label_helper (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL);`);
  const blob = (sha: string): Uint8Array | undefined => { const row = db.prepare('SELECT bytes FROM g2b_blob WHERE sha256=?').get(sha); return row === undefined ? undefined : new Uint8Array(row['bytes'] as Uint8Array); };
  const plans = new Map<string, Plan>();
  /** 저장된 서식 판(판은 바뀌지 않으므로 한 번 읽어 둔다) */
  function plan(id: string, version: number): Plan | undefined {
    const k = `${id}@${version}`;
    if (!plans.has(k)) {
      const row = db.prepare('SELECT document FROM g2b_template WHERE id=? AND version=?').get(id, version);
      if (row === undefined) return undefined;
      const t = readStudioTemplate(String(row['document'])) as StudioTemplate;
      const source = blob(t.source.sha256);
      if (source === undefined) return undefined;
      plans.set(k, planOf(t, source, blob));
    }
    return plans.get(k);
  }

  /** 서식 판 저장(Studio 화면 전용): `{ template, source: base64, blobs?: { sha256: base64 } }`. 저장된 판은 바꾸지 않는다 */
  function saveTemplate(input: unknown) {
    const bad = (detail: string): never => { throw new G2B2Error(400, 'INVALID_REQUEST', say('INVALID_REQUEST', detail)); };
    if (!isObj(input) || Object.keys(input).some(k => !['template', 'source', 'blobs'].includes(k)) || typeof input['source'] !== 'string' || (input['blobs'] !== undefined && !isObj(input['blobs'])))
      return bad('{ template, source(base64), blobs? }를 보내 주세요.');
    const blobs = new Map<string, Uint8Array>();
    for (const [sha, b64] of Object.entries((input['blobs'] ?? {}) as Record<string, unknown>)) {
      const bytes = typeof b64 === 'string' ? Buffer.from(b64, 'base64') : bad('덩어리는 base64 글이어야 합니다.');
      if (sha256Hex(bytes) !== sha.toLowerCase()) bad('덩어리의 해시가 이름과 다릅니다.');
      blobs.set(sha.toLowerCase(), bytes);
    }
    let t;
    try { t = readStudioTemplate(typeof input['template'] === 'string' ? input['template'] : JSON.stringify(input['template']), { hasBlob: sha => blobs.has(sha) || blob(sha) !== undefined }); }
    catch (e) { return bad(`서식을 읽지 못했습니다(엔진: ${(e as { code?: string }).code ?? '예외'}).`); }
    if (t.schema !== 'hwpx-studio/template@2' || t.source.kind !== 'hwpx') return bad('hwpx 원본의 서식 2판(template@2)만 저장합니다.');
    const source = Buffer.from(input['source'], 'base64');
    if (sha256Hex(source) !== t.source.sha256) bad('원본 문서의 해시가 서식의 source.sha256과 다릅니다.');
    const document = writeStudioTemplate(t);
    const old = db.prepare('SELECT document FROM g2b_template WHERE id=? AND version=?').get(t.id, t.version);
    if (old !== undefined && String(old['document']) !== document) throw new G2B2Error(409, 'REQUEST_CONFLICT', say('REQUEST_CONFLICT', '같은 서식 판이 다른 내용으로 이미 저장되어 있습니다. 새 판 번호로 저장하세요.'));
    db.exec('BEGIN IMMEDIATE');
    try {
      const put = db.prepare('INSERT OR IGNORE INTO g2b_blob(sha256,bytes) VALUES (?,?)');
      put.run(t.source.sha256, source);
      for (const [sha, bytes] of blobs) put.run(sha, bytes);
      db.prepare('INSERT OR IGNORE INTO g2b_template(id,version,document) VALUES (?,?,?)').run(t.id, t.version, document);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { template: { id: t.id, version: t.version, name: t.meta?.name ?? t.id } };
  }

  const profileRow = (id: string) => { const row = db.prepare('SELECT document FROM g2b_profile WHERE id=?').get(id); return row === undefined ? undefined : JSON.parse(String(row['document'])) as Record<string, unknown>; };

  /** 2판 프로필 저장(Studio 화면 전용): 서식 판 고정, 출력 폴더는 절대 경로, 파일 이름 규칙은 선택 */
  function saveProfile(input: unknown): Profile {
    const bad = (code: string, detail: string): never => { throw new G2B2Error(400, code, say(code, detail)); };
    if (!isObj(input) || Object.keys(input).some(k => !['id', 'label', 'templateId', 'version', 'outputDirectory', 'fileName'].includes(k))) return bad('INVALID_REQUEST', '{ id, label, templateId, version, outputDirectory, fileName? }를 보내 주세요.');
    const { id, label, templateId, version, outputDirectory, fileName } = input;
    if (typeof id !== 'string' || !PROFILE_ID.test(id)) bad('INVALID_REQUEST', '프로필 id는 영문·숫자·_·- 1~80자여야 합니다.');
    if (typeof label !== 'string' || !label.trim() || label.length > 120 || CONTROL.test(label)) bad('INVALID_REQUEST', '프로필 이름은 줄바꿈 없이 1~120자여야 합니다.');
    if (typeof templateId !== 'string' || !Number.isSafeInteger(version) || (version as number) < 1) bad('INVALID_REQUEST', '서식 id와 판 번호를 확인하세요.');
    if (fileName !== undefined && (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 200 || [...fileName.matchAll(/\{([^{}]*)\}/g)].some(m => !RULE_TOKEN.test(m[1]!))))
      bad('INVALID_REQUEST', '파일 이름 규칙에는 {identity}·{identity[0]}·{서식명}·{stage}·{recordId}만 쓸 수 있습니다.');
    if (plan(templateId as string, version as number) === undefined) bad('PROFILE_INVALID', '저장된 서식 판이 없습니다. 서식을 먼저 저장하세요.');
    if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)) return bad('INVALID_REQUEST', '출력 폴더는 절대 경로여야 합니다.');
    mkdirSync(outputDirectory, { recursive: true });
    const directory = realpathSync(outputDirectory);
    if (!statSync(directory).isDirectory()) bad('PROFILE_INVALID', '출력 경로가 폴더가 아닙니다.');
    // fileName을 빼고 보내면 같은 id에 저장된 규칙을 둔다(화면의 "다시 확인"은 GET 꼴로 판만 바꿔 보낸다, #149)
    const rule = fileName ?? profileRow(id as string)?.['fileName'];
    const profile: Profile = { id: id as string, label: (label as string).trim(), templateId: templateId as string, version: version as number, outputDirectory: directory, ...(typeof rule === 'string' ? { fileName: rule } : {}) };
    db.prepare('INSERT INTO g2b_profile(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(profile.id, JSON.stringify(profile));
    return profile;
  }

  /** 프로필 지우기(Studio 화면 전용, #173). 끝난 요청의 기록·서식 판은 그대로라 재시도는 기록된 판으로 답한다 */
  function deleteProfile(input: unknown) {
    if (!isObj(input) || typeof input['id'] !== 'string' || !PROFILE_ID.test(input['id'])) throw new G2B2Error(400, 'INVALID_REQUEST', say('INVALID_REQUEST', '{ id }를 보내 주세요.'));
    return { deleted: db.prepare('DELETE FROM g2b_profile WHERE id=?').run(input['id']).changes > 0 };
  }

  /** `GET /api/g2b/profiles`: 2판 프로필은 `{ id, label, templateId, version, outputDirectory }`, 1판 프로필은 저장한 그대로(1판 다리) */
  const profiles = () => db.prepare('SELECT document FROM g2b_profile ORDER BY id').all().map(row => {
    const p = JSON.parse(String(row['document'])) as Record<string, unknown>;
    return typeof p['templateId'] === 'string' ? { id: p['id'], label: p['label'], templateId: p['templateId'], version: p['version'], outputDirectory: p['outputDirectory'] } : p;
  });

  const labels = (): Column[] => { const row = db.prepare('SELECT document FROM g2b_label_helper WHERE id=1').get(); return row === undefined ? [] : JSON.parse(String(row['document'])); };

  /** 프로필에서 생성 준비: 2판 서식 판·출력 폴더. 못 쓰면 `PROFILE_INVALID`의 설명 */
  function setup(profile: Record<string, unknown>): { plan: Plan; directory: string; rule: string } | string {
    if (typeof profile['templateId'] !== 'string') return '2판 서식이 지정되지 않은 프로필입니다.';
    const p = plan(profile['templateId'], profile['version'] as number);
    if (p === undefined) return '프로필의 서식 판이 저장되어 있지 않습니다.';
    const directory = String(profile['outputDirectory']);
    try { if (realpathSync(directory) !== directory || !statSync(directory).isDirectory()) return '출력 폴더가 옮겨졌거나 바뀌었습니다.'; }
    catch { return '출력 폴더가 없습니다.'; }
    return { plan: p, directory, rule: typeof profile['fileName'] === 'string' ? profile['fileName'] : DEFAULT_FILE_RULE };
  }

  function reply(requestId: string, warnings: Warning[], results: Result[], timings: { itemIndex: number; ms: number }[], started: number): Reply {
    const count = (s: Status) => results.filter(r => r.status === s).length;
    const statuses = new Set(results.map(r => r.status));
    return { requestId, status: statuses.size > 1 ? 'partial' : results[0]!.status, warnings, results, summary: { succeeded: count('success'), needsInput: count('needs-input'), failed: count('error'), timings, totalMs: ms(started) } };
  }

  type Stored = { item_index: number; status: string; path: string | null; sha256: string | null; result: string };
  /** 성공 건: 메시지 없음. 시험(dryRun)은 `path`·`reused`만 빠진 같은 꼴이다 */
  const success = (itemIndex: number, warnings: Warning[], extra: Partial<Result> = {}): Result => ({ itemIndex, status: 'success', ...extra, ...(warnings.length ? { warnings } : {}) });

  /** 첫 처리(또는 시험). 기록은 끝난 뒤 한 번에 쓴다(값·바이트 없음). 저장 실패 건도 정한 경로·해시를 기록해 재시도가 같은 경로에 쓴다 */
  async function first(request: Request, fingerprint: string, warnings: Warning[], started: number): Promise<Reply> {
    const profile = profileRow(request.profileId);
    if (profile === undefined) throw new G2B2Error(400, 'UNKNOWN_PROFILE', say('UNKNOWN_PROFILE', `프로필: ${request.profileId}`), request.requestId);
    if (request.columns !== undefined && !request.dryRun)
      db.prepare('INSERT INTO g2b_label_helper(id,document) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(JSON.stringify(request.columns));
    const ready = setup(profile);
    const results: Result[] = [], timings: { itemIndex: number; ms: number }[] = [], files: { path?: string; sha256?: string }[] = [];
    for (const [i, item] of request.items.entries()) {
      if (i > 0) await tick();
      const t0 = performance.now();
      const file: { path?: string; sha256?: string } = {};
      let result: Result;
      if (typeof ready === 'string') result = fail(i, 'PROFILE_INVALID', ready, []);
      else {
        const e = evaluate(ready.plan, item, request.types, i);
        const made = 'result' in e ? e : produce(ready.plan, e, i, request.dryRun);
        if ('result' in made) result = made.result;
        else {
          const ew = 'warnings' in e ? e.warnings : [];
          if (made.output === undefined) result = success(i, ew);
          else {
            file.sha256 = sha256Hex(made.output);
            const base = fileBase(ready.rule, item.meta, ready.plan.name, request.requestId, i);
            try {
              const at = place(ready.directory, base, made.output, file.sha256);
              file.path = at.path;
              result = success(i, ew, { path: at.path, reused: at.reused });
            } catch (err) {
              file.path = join(ready.directory, `${base}.hwpx`);
              result = fail(i, 'OUTPUT_ERROR', outputReason(err), ew);
            }
          }
        }
      }
      results.push(result); files.push(file); timings.push({ itemIndex: i, ms: ms(t0) });
    }
    if (!request.dryRun && typeof ready !== 'string') {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO g2b2_request(request_id,fingerprint,template_id,template_version) VALUES (?,?,?,?)').run(request.requestId, fingerprint, ready.plan.t.id, ready.plan.t.version);
        const put = db.prepare('INSERT INTO g2b2_item(request_id,item_index,status,code,path,sha256,result) VALUES (?,?,?,?,?,?,?)');
        for (const r of results) put.run(request.requestId, r.itemIndex, r.status, r.code ?? null, files[r.itemIndex]!.path ?? null, files[r.itemIndex]!.sha256 ?? null, JSON.stringify(r));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    return reply(request.requestId, warnings, results, timings, started);
  }

  /**
   * 끝난 요청의 재시도: 경로를 기록한 건은 기록된 경로·해시로 확인해 같으면 `reused: true`, 파일이 없으면 기록된 서식 판으로 같은 경로에 다시 만든다
   * (다른 파일이 있으면 덮어쓰지 않고 `OUTPUT_ERROR`). 경로가 없는 건(입력 필요·생성 실패)은 같은 값·같은 판이라 기록한 결과 그대로다.
   */
  async function again(request: Request, stored: { template_id: string; template_version: number }, warnings: Warning[], started: number): Promise<Reply> {
    const rows = new Map((db.prepare('SELECT item_index,status,path,sha256,result FROM g2b2_item WHERE request_id=?').all(request.requestId) as unknown as Stored[]).map(r => [r.item_index, r]));
    const p = plan(stored.template_id, stored.template_version);
    const results: Result[] = [], timings: { itemIndex: number; ms: number }[] = [];
    for (const [i, item] of request.items.entries()) {
      if (i > 0) await tick();
      const t0 = performance.now();
      const row = rows.get(i)!;
      const recorded = JSON.parse(row.result) as Result;
      const ew = recorded.warnings ?? [];
      let result = recorded;
      const path = row.path;
      if (path !== null) {
        let state: 'same' | 'other' | 'missing';
        try { state = row.sha256 !== null && lstatSync(path).isFile() && sha256Hex(readFileSync(path)) === row.sha256 ? 'same' : 'other'; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; state = 'missing'; }
        if (state === 'same') result = success(i, ew, { path, reused: true });
        else if (state === 'other') result = fail(i, 'OUTPUT_ERROR', '기록된 경로에 다른 파일이 있습니다. 기존 파일은 덮어쓰지 않았습니다.', ew);
        else if (p === undefined) result = fail(i, 'PROFILE_INVALID', '기록된 서식 판이 저장되어 있지 않습니다.', ew);
        else {
          const e = evaluate(p, item, request.types, i);
          const made = 'result' in e ? e : produce(p, e, i, false);
          if ('result' in made) result = made.result;
          else {
            const out = made.output!, hash = sha256Hex(out);
            try {
              const outcome = publish(path, out, hash);
              result = outcome === 'other' ? fail(i, 'OUTPUT_ERROR', '기록된 경로에 다른 파일이 있습니다. 기존 파일은 덮어쓰지 않았습니다.', ew) : success(i, ew, { path, reused: outcome === 'same' });
              if (result.status === 'success') db.prepare('UPDATE g2b2_item SET status=?,code=NULL,sha256=?,result=? WHERE request_id=? AND item_index=?').run('success', hash, JSON.stringify(result), request.requestId, i);
            } catch (err) { result = fail(i, 'OUTPUT_ERROR', outputReason(err), ew); }
          }
        }
      }
      results.push(result); timings.push({ itemIndex: i, ms: ms(t0) });
    }
    return reply(request.requestId, warnings, results, timings, started);
  }

  // 동시 요청은 순서대로(한 줄 대기열). 같은 번호·같은 지문이 처리 중이면 그 응답을 같이 받는다(진행 중 표). 시험(dryRun)은 표·기록을 쓰지 않는다
  let line: Promise<unknown> = Promise.resolve();
  const flights = new Map<string, { fingerprint: string; reply: Promise<Reply> }>();
  const conflict = (requestId: string) => new G2B2Error(409, 'REQUEST_CONFLICT', say('REQUEST_CONFLICT'), requestId);

  function generate(raw: unknown): Promise<Reply> {
    const { request, warnings } = readRequest(raw);
    const fingerprint = fingerprintOf(request);
    if (!request.dryRun) {
      const flight = flights.get(request.requestId);
      if (flight !== undefined) { if (flight.fingerprint === fingerprint) return flight.reply; throw conflict(request.requestId); }
    }
    const run = async (): Promise<Reply> => {
      const started = performance.now();
      if (!request.dryRun) {
        const stored = db.prepare('SELECT fingerprint,template_id,template_version FROM g2b2_request WHERE request_id=?').get(request.requestId) as { fingerprint: string; template_id: string; template_version: number } | undefined;
        if (stored !== undefined) {
          if (stored.fingerprint !== fingerprint) throw conflict(request.requestId);
          return again(request, stored, warnings, started);
        }
      }
      return first(request, fingerprint, warnings, started);
    };
    const pending = line.then(run);
    line = pending.catch(() => undefined);
    if (!request.dryRun) {
      flights.set(request.requestId, { fingerprint, reply: pending });
      void pending.finally(() => flights.delete(request.requestId)).catch(() => {});
    }
    return pending;
  }

  return { generate, profiles, saveProfile, deleteProfile, saveTemplate, labels };
}
export type G2B2 = ReturnType<typeof createG2B2>;
