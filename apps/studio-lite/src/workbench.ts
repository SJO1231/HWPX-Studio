import { createHash, randomUUID } from 'node:crypto';
import {
  planBlockInsert, applyPlan, detectHeadings, headingRangeOf, charDelta, checkValueText, collectFields, compareToBaseline, compileDocument, draftAnchors, emptyTemplate, fieldRangeIn, findPlaceholders, generate,
  generateFromTemplate, isValidPath, listUnregisteredPlaces, lookupPath, makeLineAnchor, makeRangeAnchor, makeWordAnchor, openPackage, parseDocument,
  placeText, planApplyCharFormat, readDataset, readStudioTemplate, readTemplate, readTypedValue, remapAddress, resolvePathValue, sanitizeFileStem, validateDocument, valueUnit,
  verifyPreservation, walkParagraphs, type CompileTarget, type Dataset, type HwpxDocument, type StudioTemplate,
} from '@hwpx-studio/engine';
import { HostError, isObj, locate, markOf, resolveDrafts } from '../../../packages/viewer/src/host/index.ts';
import { toRhwpPosition, type RhwpPosition } from '../../../packages/viewer/src/map/index.ts';
import { extractBlockDraft, type BlockDraft, type BlockLibrary } from './block-library.ts';
import { parseCsv } from './core.ts';
import { analyzePlaces, describeLeftover, findLeftovers, leftoverOf, listKeys, parseQuickData, type QuickData } from './quick.ts';
import { CONTEXT, ITEM_KEYS, LABEL_MAX, LABEL_RELS, g2bTemplate, isField, repsOf, spanNow, validKey, type G2BEntry, type InputItem } from './input-table.ts';
import { labelAt } from './item-label.ts';
import { VALUE_TYPES, datePattern, decorateValue } from './value-type.ts';

import { plainOf as plainBlock } from '../../studio/src/messages.ts';
const MAX_SOURCE = 10 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const schema = 'hwpx-studio/lite-workspace@1';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (code: string, message: string): never => { throw new HostError(400, code, message); };
function need(ok: unknown, code = 'WORKBENCH_INPUT'): asserts ok { if (!ok) fail(code, code === 'WORKBENCH_OVERLAP' ? '이미 배치한 범위와 겹칩니다. 겹치지 않는 부분을 선택하세요.' : '입력과 원본 위치를 다시 확인하세요.'); }
type Row = { id: string; sectionIndex: number; path: number[]; text: string; editable: boolean; rangeEditable: boolean; reason?: string; position?: RhwpPosition };
type Edit = { id: string; text: string };
type Heading = { id: string; level: 1 | 2 };
type Block = { id: string; from: string; to: string; text: string; alias: string };
type Placement = {id:string;version:number;from:string;to:string};
type Work = { edits: Edit[]; headings: Heading[]; blocks: Block[]; placements: Placement[]; inputItems: InputItem[]; index: number; missing: "error" | "keep"; samples?: Record<string, string> };
type Session = { workspaceId?: string; kind: 'hwpx' | 'text'; name: string; source: Uint8Array; doc?: HwpxDocument; sourceText?: string; rows: Row[]; headings?: { id: string; name: string }[]; data?: QuickData; dataContent?: string; output?: Uint8Array; blockPreviews?: Map<string, BlockDraft>; pins?: Set<string>; inputs?: Input[] };
const rowId = (section: number, path: number[]) => `p:${section}:${path.join('.')}`;
const sameParent = (a: Row, b: Row) => a.sectionIndex === b.sectionIndex && a.path.length === b.path.length && a.path.slice(0, -1).every((n, i) => n === b.path[i]);
const contains = (a: Row, b: Row, row: Row) => sameParent(a, row) && row.path.at(-1)! >= a.path.at(-1)! && row.path.at(-1)! <= b.path.at(-1)!;
const paragraph = (doc: HwpxDocument, row: Pick<Row, 'sectionIndex' | 'path'>) => [...walkParagraphs(doc.sections[row.sectionIndex]!.paragraphs)].find(p => p.path.length === row.path.length && p.path.every((n, i) => n === row.path[i]));
type Input = { kind: 'clickHere' | 'mailMerge' | 'placeholder'; name: string; row: string; start: number; end: number; usable?: boolean; label?: ReturnType<typeof labelAt> };

/**
 * 추천 목록의 입력 항목 후보(문서 순서): 누름틀(이름 있음)·메일머지(키 있음)와 필드 표시 글 밖의 `{{키}}`. 필드 표시 글 안의 `{{키}}`는 그 필드가 맡으므로
 * 따로 올리지 않는다(엔진 명세 8.8.5. 구간은 엔진의 `fieldRangeIn`). `start`·`end`는 그 줄 글(`Row.text`)의 위치이고, 필드는 시작 문단의 표시 글 구간이다.
 */
function inputsOf(s: Session): Input[] {
  const spans = new Map<string, { start: number; end: number }[]>();
  const out: Input[] = [];
  for (const t of s.doc ? collectFields(s.doc) : []) {
    const { type, name, mergeKey, shape, sectionIndex, path } = t.info;
    if (type !== 'CLICK_HERE' && type !== 'MAILMERGE') continue;
    const paragraphs = shape === 'crossParagraph' ? walkParagraphs(t.section.paragraphs) : [t.paragraph];
    for (const p of paragraphs) {
      const r = fieldRangeIn(t, p);
      if (r !== undefined) spans.set(rowId(sectionIndex, p.path), [...(spans.get(rowId(sectionIndex, p.path)) ?? []), { start: r.from, end: r.until }]);
    }
    const key = type === 'CLICK_HERE' ? name : mergeKey;
    if (key === undefined || key === '') continue;
    const first = fieldRangeIn(t, t.paragraph), start = first?.from ?? t.paragraph.pieces[t.begin.pieceIndex]?.logicalEnd ?? 0;
    out.push({ kind: type === 'CLICK_HERE' ? 'clickHere' : 'mailMerge', name: key, row: rowId(sectionIndex, path), start, end: first?.until ?? start, usable: isValidPath(key) });
  }
  for (const r of s.rows) for (const m of r.text.matchAll(/\{\{([^{}#/]+)\}\}/g)) {
    if ((spans.get(r.id) ?? []).some(x => m.index < x.end && m.index + m[0].length > x.start)) continue;
    out.push({ kind: 'placeholder', name: m[1]!, row: r.id, start: m.index, end: m.index + m[0].length, usable: isValidPath(m[1]!.trim()) });
  }
  const order = new Map(s.rows.map((r, i) => [r.id, i]));
  // 찾은 자리마다 가장 가까운 라벨(#148)을 붙인다
  for (const x of out) { const label = labelOf(s, s.rows.find(r => r.id === x.row)!, x.start); if (label) x.label = label; }
  return out.sort((a, b) => (order.get(a.row) ?? 0) - (order.get(b.row) ?? 0) || a.start - b.start);
}
const labelOf = (s: Session, row: Row, start: number) => labelAt(s.doc, s.rows, s.headings ?? [], row, start);

function placementInfo(s:Session,selected:Placement,library:BlockLibrary){
  need(s.doc,'BLOCK_HWPX');
  const stored=library.material(selected.id,selected.version),a=s.rows.find(r=>r.id===selected.from)!;
  const plan=planBlockInsert(s.doc,stored.proto,stored.blob,{sectionIndex:a.sectionIndex,parentPath:a.path.slice(0,-1),index:a.path.at(-1)!,position:'before'});
  return {name:stored.item.name,version:stored.proto.version,paragraphs:s.rows.filter(r=>contains(a,s.rows.find(r=>r.id===selected.to)!,r)).length,warnings:plan.issues.filter(i=>i.severity==='warning').map(i=>plainBlock(i.code)),formatDiffs:plan.formatDiffs.map(d=>({paragraph:d.paragraph+1,property:d.property==='paraPr'?'문단 모양':'스타일'}))};
}

function rowsOf(doc: HwpxDocument): Row[] {
  const rows: Row[] = [];
  for (const s of doc.sections) for (const p of walkParagraphs(s.paragraphs)) {
    need(rows.length < 3000, 'WORKBENCH_DOCUMENT_LIMIT');
    const length = p.logicalText.length;
    const drafts = draftAnchors(doc, { sectionIndex: s.index, path: p.path, ...(length ? { start: 0, end: length } : {}) });
    const draft = drafts.find(d => d.kind === (length ? 'word' : 'line'));
    const reason = p.fieldMarks.length || p.objects.length || p.subLists.length || p.bookmarks.length
      ? 'WORKBENCH_STRUCTURE_READONLY' : draft?.blocked ?? (draft === undefined || !p.runs.length ? 'WORKBENCH_FORMAT_READONLY' : undefined);
    const position = toRhwpPosition(doc, { sectionIndex: s.index, path: p.path, offset: 0 });
    rows.push({ id: rowId(s.index, p.path), sectionIndex: s.index, path: [...p.path], text: p.logicalText,
      editable: reason === undefined || reason === 'FILL_MIXED_FORMAT', rangeEditable: reason === undefined, ...(reason ? { reason } : {}), ...(position ? { position } : {}) });
  }
  return rows;
}

function decodeSource(value: unknown): Uint8Array {
  need(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(MAX_SOURCE / 3) * 4);
  need(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'WORKBENCH_SOURCE');
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  need(bytes.length > 0 && bytes.length <= MAX_SOURCE, 'WORKBENCH_DOCUMENT_LIMIT');
  return bytes;
}
function open(name: unknown, content: unknown): Session {
  need(typeof name === 'string' && name.length <= 500);
  const source = decodeSource(content);
  if (/\.txt$/i.test(name)) {
    let sourceText: string;
    try { sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source); }
    catch { return fail('WORKBENCH_TEXT', 'TXT 파일은 UTF-8 문자로 저장해 주세요.'); }
    need(checkValueText(sourceText) === undefined, 'WORKBENCH_TEXT');
    const lines = sourceText.split(/\r\n|\r|\n/); need(lines.length <= 3000, 'WORKBENCH_DOCUMENT_LIMIT');
    const rows = lines.map((text, i): Row => ({ id: rowId(0, [i]), sectionIndex: 0, path: [i], text, editable: true, rangeEditable: true }));
    return { kind: 'text', name: `${sanitizeFileStem(name.replace(/\.txt$/i, ''))}.txt`, source, sourceText, rows };
  }
  const doc = parseDocument(openPackage(source));
  return { kind: 'hwpx', name: `${sanitizeFileStem(name)}.hwpx`, source, doc, rows: rowsOf(doc) };
}
// shortcut: 업무 건 이름은 건마다 값이 다른 첫 글·수 열(없으면 첫 열)의 값 20자다, 이름 열을 고르게 할 때 올린다(#149 "이름 열 지정")
function caseNames(s: Session): string[] {
  const rows = (s.data?.records ?? []).map(r => 'dataset' in r ? r.dataset.data : {});
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(k => rows.every(r => typeof r[k] === 'string' || typeof r[k] === 'number'));
  const name = keys.find(k => new Set(rows.map(r => r[k])).size > 1) ?? keys[0];
  return rows.map(r => name === undefined ? '' : String(r[name]).replace(/\s+/g, ' ').trim().slice(0, 20));
}
function dataInfo(s: Session) {
  const first = s.data?.records[0];
  return { records: s.data?.records.length ?? 0, keys: s.data ? listKeys(s.data.records).keys : [], preview: first && 'dataset' in first ? first.dataset.data : {}, index: 0, cases: caseNames(s) };
}
function parseData(content: unknown, name: unknown): { data: QuickData; content: string } {
  need(typeof content === 'string' && Buffer.byteLength(content) <= MAX_TEXT && typeof name === 'string');
  const json = /\.csv$/i.test(name) ? JSON.stringify(parseCsv(content)) : content;
  return { data: parseQuickData(new TextEncoder().encode(json)), content: json };
}
function workOf(s: Session, input: Record<string, unknown>): Work {
  need(Array.isArray(input.edits) && input.edits.length <= 500 && Array.isArray(input.headings) && input.headings.length <= 500 && Array.isArray(input.blocks) && input.blocks.length <= 100);
  need(Number.isInteger(input.index) && (input.index as number) >= 0 && (input.index as number) < (s.data?.records.length ?? 1), 'WORKBENCH_RECORD');
  const index = input.index as number;
  if (s.data) need('dataset' in s.data.records[index]!, 'WORKBENCH_RECORD');
  const row = (id: unknown): Row => { need(typeof id === 'string'); const found = s.rows.find(r => r.id === id); need(found, 'WORKBENCH_POSITION'); return found; };
  let size = 0;
  const text = (value: unknown): string => { need(typeof value === 'string' && value.length <= 100000); size += Buffer.byteLength(value); need(size <= MAX_TEXT && checkValueText(value) === undefined, 'WORKBENCH_TEXT'); return value; };
  const edits: Edit[] = input.edits.map(e => { need(isObj(e) && Object.keys(e).every(k => ['id', 'text'].includes(k))); const r = row(e.id); need(r.editable, 'WORKBENCH_READONLY'); return { id: r.id, text: text(e.text) }; });
  const headings: Heading[] = input.headings.map(h => { need(isObj(h) && Object.keys(h).every(k => ['id', 'level'].includes(k)) && (h.level === 1 || h.level === 2)); return { id: row(h.id).id, level: h.level }; });
  const blocks: Block[] = input.blocks.map(b => {
    need(isObj(b) && Object.keys(b).every(k => ['id', 'from', 'to', 'text', 'alias'].includes(k)) && typeof b.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(b.id) && typeof b.alias === 'string' && b.alias.length <= 120);
    const a = row(b.from), z = row(b.to);
    need(sameParent(a, z) && a.path.at(-1)! <= z.path.at(-1)!, 'WORKBENCH_RANGE');
    const selected = s.rows.filter(r => contains(a, z, r));
    need(selected.length === z.path.at(-1)! - a.path.at(-1)! + 1 && selected.every(r => r.rangeEditable), 'WORKBENCH_READONLY');
    return { id: b.id, from: a.id, to: z.id, text: text(b.text), alias: b.alias };
  });
  for (const xs of [edits, headings, blocks]) need(new Set(xs.map(x => x.id)).size === xs.length, 'WORKBENCH_DUPLICATE');
  blocks.forEach((b, i) => {
    const a = row(b.from), z = row(b.to);
    need(!edits.some(e => contains(a, z, row(e.id))), 'WORKBENCH_OVERLAP');
    need(!blocks.slice(i + 1).some(other => contains(a, z, row(other.from)) || contains(row(other.from), row(other.to), a)), 'WORKBENCH_OVERLAP');
  });
  need(input.placements===undefined||Array.isArray(input.placements)&&input.placements.length<=100);
  const placements: Placement[] = (input.placements as unknown[]??[]).map(b=>{
    need(isObj(b)&&Object.keys(b).every(k=>['id','version','from','to'].includes(k))&&typeof b.id==='string'&&b.id.length<=80&&Number.isInteger(b.version)&&(b.version as number)>0);
    const a=row(b.from),z=row(b.to);need(s.kind==='hwpx'&&sameParent(a,z)&&a.path.at(-1)!<=z.path.at(-1)!,'BLOCK_BOUNDARY');
    return {id:b.id,version:b.version as number,from:a.id,to:z.id};
  });
  const occupied=new Set<string>();
  for(const b of [...blocks,...placements]){const a=row(b.from),z=row(b.to);const covered=s.rows.filter(r=>r.sectionIndex===a.sectionIndex&&r.path.length>=a.path.length&&a.path.slice(0,-1).every((n,i)=>r.path[i]===n)&&r.path[a.path.length-1]!>=a.path.at(-1)!&&r.path[a.path.length-1]!<=z.path.at(-1)!);
    for(const r of covered){need(!occupied.has(r.id),'WORKBENCH_OVERLAP');occupied.add(r.id);if(placements.includes(b as Placement))need(!edits.some(e=>e.id===r.id),'WORKBENCH_OVERLAP');}
  }
  need(input.missing === undefined || input.missing === "error" || input.missing === "keep");
  // 견본 값(#149): 데이터 없이 표에 적은 값. 열쇠(데이터 키, 없으면 이름) → 글
  need(input.samples === undefined || isObj(input.samples) && Object.keys(input.samples).length <= 3000);
  const samples = input.samples === undefined ? undefined : Object.fromEntries(Object.entries(input.samples).map(([k, v]) => { need(k.trim() !== '' && k.length <= 500 && typeof v === 'string'); return [text(k), text(v)]; }));
  return { edits, headings, blocks, placements, inputItems: inputItemsOf(input.inputItems, row), index, missing: input.missing ?? "error", ...(samples ? { samples } : {}) };

}

/** 견본 값의 데이터(키의 점은 하위 항목). 프로토타입 없는 객체라 `__proto__` 같은 키도 그냥 열이다 */
function sampleData(samples: Record<string, string>): Dataset {
  const data: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(samples)) {
    const parts = key.split('.'); let at = data;
    for (const p of parts.slice(0, -1)) at = (isObj(at[p]) ? at[p] : at[p] = Object.create(null)) as Record<string, unknown>;
    at[parts.at(-1)!] = value;
  }
  return { data, derived: {} };
}
/**
 * 생성에 쓸 데이터: 고른 업무 건(데이터 행), 데이터가 없으면 표에 적은 견본 값. 데이터 연결(#149): 필드 이름과 다른 데이터 키에 이은 누름틀·메일머지는
 * 그 키의 값을 필드 이름으로 받는다. 엔진 2판 별칭과 같은 규칙이라 필드 이름 열과 연결한 열에 모두 값이 있으면 막는다(`DATA_ALIAS_CONFLICT`).
 */
function datasetOf(s: Session, work: Work): Dataset | undefined {
  const record = s.data?.records[work.index];
  const base = record && 'dataset' in record ? record.dataset : s.data || !work.samples ? undefined : sampleData(work.samples);
  if (!base) return;
  const data = { ...base.data };
  for (const i of work.inputItems) {
    const field = isField(i.origin) && i.status !== 'excluded' && i.key ? s.inputs?.find(x => x.kind === i.origin && x.row === i.row && x.start === i.start && x.end === i.end)?.name : undefined;
    if (field === undefined || field === i.key) continue;
    const value = resolvePathValue(base, i.key, 'error');
    if (value.kind !== 'text') continue;
    if (Object.hasOwn(base.data, field) && base.data[field] != null) fail('DATA_ALIAS_CONFLICT', `'${field}' 필드는 데이터 키 '${i.key}'에 연결했는데 데이터에 '${field}' 값도 있습니다. 한 열만 남기세요.`);
    data[field] = value.text;
  }
  return { data, derived: base.derived };
}

type Shape = (value: string, following: string) => string | undefined;
/**
 * 값 형식(#181): Helper 서식 판(`g2bTemplate`)과 같은 값 표의 금액·날짜 값. 값을 읽는 경로(찾은 자리면 문서의 이름, 지정 자리면 연결한 키 = 확정한 편집 글의 `{{키}}`) →
 * 엔진 형식(8.8.4 `readTypedValue`, 원문 날짜 모양 `display.pattern` 포함)으로 꾸미고 자리 바로 뒤 글로 "원" 단위를 정하는 함수(`placeText`, 읽지 못하는 값이면 undefined).
 * TXT 미리 보기는 자리마다 이 함수를 쓰고, HWPX는 이 값 표가 있으면 값을 `fillValues`(Helper 2판 생성)로 채운다.
 */
function formatsOf(s: Session, items: readonly InputItem[]): Map<string, Shape> {
  const t = g2bTemplate(g2bEntries(s, items).entries, { id: 't', version: 1, name: '', sha256: '' });
  const values = new Map(t.values.map(v => [v.id, v])), keys = new Map(t.bindings.map(b => [b.value, b.key])), out = new Map<string, Shape>();
  for (const p of t.places as { kind: string; value: string; anchor?: string; name?: string; key?: string }[]) {
    const { format, display } = values.get(p.value)! as { format: 'text' | 'money' | 'date'; display?: { unit?: string; pattern?: string } }, path = p.anchor ? keys.get(p.value)! : (p.name ?? p.key)!;
    if (format === 'text' || !isValidPath(path) || out.has(path)) continue;
    out.set(path, (value, following) => {
      const read = readTypedValue(format, value, display);
      return read.ok ? placeText(read.text, valueUnit(format, display), following) : undefined;
    });
  }
  return out;
}
/**
 * 값 단계(#186): 조립본의 `{{키}}`·누름틀·메일머지를 Helper 2판 창구와 같은 엔진 생성(`generateFromTemplate`)으로 자리마다 채운다(금액 "원"은 자리 바로 뒤 글로, 8.8.4).
 * 서식 판은 같은 `g2bTemplate`이고 확정한 지정 자리는 편집 글의 `{{키}}`로, 그 밖의 `{{키}}`·필드(직접 적은 것·블록 안의 것)는 글 값으로 더한다.
 * 데이터는 연결 키(없으면 별칭)의 값을 담은 한 행이다. 엔진이 읽지 못하는 금액·날짜 값(`미정` 등)은 그 값만 글로 넣는다(창구는 `INVALID_FIELDS`).
 */
function fillValues(s: Session, items: readonly InputItem[], bytes: Uint8Array, dataset: Dataset, missing: Work['missing']): { output: Uint8Array; filled: number } {
  const doc = parseDocument(openPackage(bytes));
  const entries = g2bEntries(s, items).entries.flatMap(({ anchor, ...x }): G2BEntry[] => !anchor ? [x] : isValidPath(x.key?.trim() || x.name) ? [{ ...x, kind: 'placeholder', name: x.key?.trim() || x.name }] : []);
  // 문서에서 찾은 자리(목록에서 제외한 것 포함)는 서식 판 그대로 두고, 그 밖의 것만 이름 규칙에 맞으면 더한다
  const seen = new Set([...entries, ...(s.inputs ?? []).map(x => ({ kind: x.kind, name: x.kind === 'placeholder' ? x.name.trim() : x.name }))].map(x => x.kind + '\n' + x.name));
  const add = (kind: G2BEntry['kind'], name: string | undefined) => { if (name && isValidPath(name) && !seen.has(kind + '\n' + name)) { seen.add(kind + '\n' + name); entries.push({ kind, name }); } };
  for (const f of collectFields(doc)) add(f.info.type === 'CLICK_HERE' ? 'clickHere' : 'mailMerge', f.info.type === 'CLICK_HERE' ? f.info.name : f.info.type === 'MAILMERGE' ? f.info.mergeKey : undefined);
  for (const section of doc.sections) for (const p of walkParagraphs(section.paragraphs)) for (const k of findPlaceholders(p.logicalText)) add('placeholder', k.path);
  const t = g2bTemplate(entries, { id: 't00000000', version: 1, name: 'preview', sha256: hash(bytes) }), record: Record<string, unknown> = {};
  for (const b of t.bindings) {
    const found = [b.key, ...(b.aliases ?? [])].map(name => lookupPath(dataset, name)).find(f => f.found && f.value !== null);
    if (!found?.found) continue;
    record[b.key] = found.value;
    const i = t.values.findIndex(v => v.id === b.value), v = t.values[i]! as { id: string; name: string; format: 'text' | 'money' | 'date'; display?: { unit?: string; pattern?: string } };
    if (v.format !== 'text' && !readTypedValue(v.format, found.value, v.display).ok) t.values[i] = { id: v.id, name: v.name, format: 'text' };
  }
  const r = generateFromTemplate(bytes, readStudioTemplate(JSON.stringify({ ...t, options: { unregistered: 'keep' } })) as StudioTemplate, record, undefined, () => undefined, { missing, mode: 'baseline' });
  if (!r.ok || r.dryRun) {
    const lost = [...new Set(r.report.issues.filter(i => i.code === 'DATA_MISSING').map(i => t.bindings.find(b => 'value:' + b.value === i.where)?.key ?? ''))];
    if (lost.length) unlinked(`데이터에 없는 키 ${lost.length}개: ${lost.slice(0, 20).join(', ')}`);
    const code = r.report.issues.find(i => i.severity === 'error')?.code ?? 'WORKBENCH_GENERATE';
    // 서식이 섞이거나 개체에 걸친 {{키}}는 Helper 2판도 채우지 못해 막는다('자리 유지'로 남기지 않는다)
    return fail(code, code === 'FILL_SKIPPED' ? '서식이 섞이거나 개체에 걸친 {{키}} 자리는 채울 수 없어 생성을 막았습니다(Helper 생성도 같습니다). 한컴에서 키 전체를 같은 서식으로 고치세요.' : '입력 값을 채우지 못했습니다. 데이터 항목을 확인하세요.');
  }
  return { output: r.output as Uint8Array, filled: r.report.stage2?.plan.actions.filter(a => a.type === 'fill').reduce((n, a) => n + a.targets, 0) ?? 0 };
}

/**
 * 표 보기의 입력 항목(#146). 생성에는 타입 꾸밈(금액·날짜는 모든 자리, #181)과 누름틀·메일머지의 데이터 연결(#149)에만 쓰고(확정한 항목은 이미 편집 글의 `{{키}}`다) 작업 파일에 남겼다 되살린다.
 * 위치는 원문 줄 글 기준이고, 확정한 항목은 이름이 있고 키가 규칙에 맞아야 한다(누름틀·메일머지는 필드 이름이 키).
 */
function inputItemsOf(value: unknown, row: (id: unknown) => Row): InputItem[] {
  need(value === undefined || Array.isArray(value) && value.length <= 3000);
  const seen = new Set<string>();
  return ((value as unknown[] | undefined) ?? []).map(x => {
    need(isObj(x) && Object.keys(x).every(k => (ITEM_KEYS as readonly string[]).includes(k)));
    const r = row(x.row), { start, end, name, key, typeSet, label, before, after, status, origin } = x;
    // #146 작업 파일의 금액 타입 이름 `amount`는 `money`(엔진 8.8.4·Helper 계약의 이름)로 읽는다
    const type = x.type === 'amount' ? 'money' : x.type;
    need(Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (start as number) <= (end as number) && (end as number) <= r.text.length, 'WORKBENCH_POSITION');
    need(typeof name === 'string' && name.length <= 500 && checkValueText(name) === undefined && typeof key === 'string' && key.length <= 500 && checkValueText(key) === undefined);
    need((VALUE_TYPES as readonly unknown[]).includes(type) && (typeSet === undefined || typeof typeSet === 'boolean') && ['recommended', 'designated', 'confirmed', 'excluded'].includes(status as string) && ['user', 'placeholder', 'clickHere', 'mailMerge'].includes(origin as string));
    // 라벨(#148): 글 1~80자, 관계, 거리. 앞뒤 글은 각 60자까지
    need(label === undefined || isObj(label) && Object.keys(label).length === 3 && typeof label.text === 'string' && label.text.trim() !== '' && label.text.length <= LABEL_MAX && checkValueText(label.text) === undefined
      && (LABEL_RELS as readonly unknown[]).includes(label.rel) && Number.isInteger(label.distance) && (label.distance as number) >= 0 && (label.distance as number) <= 100000);
    for (const side of [before, after]) need(side === undefined || typeof side === 'string' && side.length <= CONTEXT && checkValueText(side) === undefined);
    const item = { row: r.id, start, end, name, key, type, ...(typeSet ? { typeSet } : {}), ...(label === undefined ? {} : { label }), ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), status, origin } as InputItem;
    need(item.status !== 'confirmed' || item.name.trim() !== '' && (isField(item.origin) || validKey(item.key)), 'WORKBENCH_FIELD_NAME');
    const id = `${item.row}:${item.start}:${item.end}:${item.origin}`;
    need(!seen.has(id), 'WORKBENCH_DUPLICATE'); seen.add(id);
    return item;
  });
}

/**
 * Helper 서식 판(#173·#149)의 자리: 문서에서 찾은 누름틀·메일머지·`{{키}}`(추천 목록에서 제외한 것 빼고)와, 표 보기에서 지정·확정하고 이름을 적은 자리(원문 구간의 word 앵커,
 * 빈 문단이면 line 앵커). 구간이 비어 앵커를 만들 수 없는 지정은 넣지 않고 수만 돌려준다.
 */
function g2bEntries(s: Session, items: readonly InputItem[]): { entries: G2BEntry[]; skipped: number } {
  const entries: G2BEntry[] = [];
  let skipped = 0;
  for (const x of s.inputs ?? []) {
    const r = items.find(i => i.origin === x.kind && i.row === x.row && i.start === x.start && i.end === x.end);
    if (r?.status !== 'excluded') entries.push({ kind: x.kind, name: x.kind === 'placeholder' ? x.name.trim() : x.name, ...(r ? { key: r.key, type: r.type } : {}) });
  }
  for (const r of items) {
    if (r.origin !== 'user' || r.status === 'excluded' || !r.name.trim()) continue;
    const row = s.rows.find(x => x.id === r.row)!, id = 'a' + (entries.filter(e => e.anchor).length + 1);
    // TXT에는 앵커가 없다(값 표 `formatsOf`에만 쓴다)
    const anchor = !s.doc ? { id, kind: 'word' as const } : r.start < r.end ? makeWordAnchor(s.doc, id, row.sectionIndex, row.path, r.start, r.end) : row.text === '' ? makeLineAnchor(s.doc, id, row.sectionIndex, row.path) : undefined;
    const original = row.text.slice(r.start, r.end), pattern = datePattern(original);
    if (anchor) entries.push({ kind: anchor.kind, name: r.name.trim(), key: r.key, type: r.type, anchor, unit: /원\s*$/u.test(original), ...(pattern ? { pattern } : {}) });
    else skipped++;
  }
  return { entries, skipped };
}

/** 표 보기 견본 값: 고른 데이터 행에서 쓸 수 있는 키의 값(글로 바꾼 것, 200자까지) */
function sampleOf(s: Session, index: unknown) {
  need(Number.isInteger(index) && (index as number) >= 0 && (index as number) < (s.data?.records.length ?? 0), 'WORKBENCH_RECORD');
  const record = s.data!.records[index as number]!, values: Record<string, string> = {};
  if ('dataset' in record) for (const k of listKeys([record]).keys) {
    if (!k.usable) continue;
    const value = resolvePathValue(record.dataset, k.path, 'error');
    if (value.kind === 'text') values[k.path] = value.text.slice(0, 200);
  }
  return { index, values };
}

// ponytail: this projection only supports **bold** and {{path}}, not Markdown round trips.
/**
 * 타입 꾸밈: 확정해 `{{키}}`로 바꾼 수량 자리의 값 글(원문 단위, #147. 금액·날짜는 `fillValues`·`formatsOf`가 자리마다 맞춘다).
 * 열쇠는 그 `{{키}}`가 지금 편집 글에서 시작하는 위치다.
 */
function decorationsOf(items: readonly InputItem[], row: Row, current: string): Map<number, (value: string) => string | undefined> {
  const out = new Map<number, (value: string) => string | undefined>(), reps = repsOf(items, row.id, row.text);
  for (const i of items) {
    if (i.row !== row.id || i.status !== 'confirmed' || i.type !== 'quantity' || !reps.some(r => r.start === i.start && r.end === i.end)) continue;
    const at = spanNow(row.text, current, reps, i.start, i.end);
    if (at) out.set(at.start, value => decorateValue(i.type, value, row.text.slice(i.start, i.end), row.text.slice(i.end)));
  }
  return out;
}

function projected(input: string, dataset: Dataset | undefined, format = true, keepKeys = false, decorate?: Map<number, (value: string) => string | undefined>) {
  let text = '', bold = false, start = 0, cursor = 0, filled = 0;
  const spans: { start: number; end: number }[] = [];
  const literal = (value: string) => format ? value.replace(/\r\n?/g, '\n') : value;
  for (const match of input.matchAll(format ? /\*\*|\{\{([^{}]+)\}\}/g : /\{\{([^{}]+)\}\}/g)) {
    text += literal(input.slice(cursor, match.index));
    if (match[0] === '**') {
      if (bold && text.length > start) spans.push({ start, end: text.length });
      else start = text.length;
      bold = !bold;
    } else {
      const path = match[1]!.trim(), shape = decorate?.get(match.index);
      // 키를 남기는 두 단계 생성에서도 꾸민 수량 자리는 여기서 넣는다. 다음 단계가 다시 읽을 {{}}가 든 글은 넣지 않는다
      const found = keepKeys && shape && dataset && isValidPath(path) ? resolvePathValue(dataset, path, 'error') : undefined;
      const shaped = found?.kind === 'text' ? shape!(found.text) : undefined;
      if (keepKeys && (shaped === undefined || /[{}]/.test(shaped))) {
        if (!isValidPath(path)) return fail('WORKBENCH_FIELD_NAME', '키에는 글자·숫자·밑줄을 사용하고, 하위 항목은 점으로 구분하세요. {{사업명}}처럼 공백 없는 이름을 넣어 주세요.');
        text += match[0];
      }
      else if (shaped !== undefined) { text += shaped; filled++; }
      else if (!format && (!dataset || !isValidPath(path))) text += match[0];
      else {
        need(isValidPath(path) && dataset, 'WORKBENCH_DATA_REQUIRED');
        // Data is appended literally; its ** and {{}} are never parsed again.
        const value = resolveValue(dataset, path);
        text += shape?.(value) ?? value; filled++;
      }
    }
    cursor = match.index + match[0].length;
  }
  text += literal(input.slice(cursor));
  need(!bold && checkValueText(text) === undefined, 'WORKBENCH_MARKUP');
  return { text, spans, filled };
}
function resolveValue(dataset: Dataset, path: string) {
  const result = resolvePathValue(dataset, path, 'error');
  if (result.kind !== 'text') return fail(result.kind === 'error' ? result.code : 'WORKBENCH_DATA', `데이터에 '${path}' 값이 없습니다. 해당 항목을 추가하거나 필드 이름을 수정하세요.`);
  return result.text;
}

// A mixed-format paragraph keeps every unchanged run. The public draft expands
// grapheme boundaries and rejects a replacement crossing a different style.
function changedRange(doc: HwpxDocument, row: Row, text: string) {
  if (row.text === text) return;
  let start = 0, end = row.text.length, nextEnd = text.length;
  while (start < end && start < nextEnd && row.text[start] === text[start]) start++;
  while (end > start && nextEnd > start && row.text[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
  // Word anchors require a nonempty source span. Include one adjacent cluster
  // for insertion, then put its unchanged text back into the replacement.
  const at = start === end && end === row.text.length ? start - 1 : start;
  const until = start === end && end < row.text.length ? end + 1 : end;
  const draft = draftAnchors(doc, { sectionIndex: row.sectionIndex, path: row.path, start: at, end: until }).find(d => d.kind === 'word');
  if (draft?.kind !== 'word' || draft.blocked) return fail(draft?.blocked ?? 'WORKBENCH_PARTIAL_EDIT', '서식이 같은 글 부분을 한 번에 수정하세요. 서로 다른 서식이나 개체를 가로지르는 수정은 적용하지 않았습니다.');
  return { start: draft.start, end: draft.end, text: row.text.slice(draft.start, start) + text.slice(start, nextEnd) + row.text.slice(end, draft.end) };
}

/** 생성 막기: 데이터에 없는 키(엔진 보고의 `missingPaths`) 또는 결과에 남은 `{{…}}`. 키 이름과 곳 수만 적는다(값 원문 없음) */
const unlinked = (what: string): never => fail('WORKBENCH_UNLINKED', `연결 안 된 입력 자리가 있어 생성을 막았습니다. ${what}. 데이터를 연결하거나 데이터 메뉴의 '연결 안 된 입력 자리'에서 '자리 유지'를 고르세요.`);

// `dataset`을 주면 그 데이터로 만든다(남은 자리를 셀 때 값의 중괄호를 가린 데이터로 다시 만드는 용도)
function build(s: Session, work: Work, makeTemplate = false, library?: BlockLibrary, override?: Dataset) {
  need(s.doc, 'WORKBENCH_SOURCE');
  const dataset = makeTemplate ? undefined : override ?? datasetOf(s, work);
  const row = (id: string) => s.rows.find(r => r.id === id)!;
  const edits = work.edits.filter(e => e.text !== row(e.id).text);
  // 원래 {{키}}가 있는 줄을 고치면(그 줄 안 지정 자리의 확정 포함) 엔진이 그 {{키}}를 따로 채워 편집과 겹친다(#180 TPL_CONFLICT):
  // 블록 배치처럼 구조(편집·블록·배치)를 먼저 만들고 값은 다음 단계에서 한 번 채운다(꾸민 수량 자리는 `projected`가 먼저 넣는다).
  // 금액·날짜 값 표가 있으면(#186) 값 단계는 Helper 2판 창구와 같은 생성(`fillValues`)이라 자리마다 "원"·날짜 모양이 Helper와 같다
  const typed = dataset !== undefined && formatsOf(s, work.inputItems).size > 0;
  const twoStage = work.placements.length > 0 || typed || dataset !== undefined && edits.some(e => findPlaceholders(row(e.id).text).length > 0);
  const compositionData = twoStage ? undefined : dataset;
  const template = emptyTemplate();
  const formats: { row: Row; text: string; spans: { start: number; end: number }[]; block: boolean; keys: ReturnType<typeof findPlaceholders> }[] = [];
  for (const [i, edit] of edits.entries()) {
    const r = row(edit.id), content = projected(edit.text, dataset, true, makeTemplate || twoStage, decorationsOf(work.inputItems, r, edit.text)), id = `edit${i}`;
    const partial = r.rangeEditable ? undefined : changedRange(s.doc, r, content.text);
    if (r.rangeEditable || partial) {
      const a = r.text.length ? makeWordAnchor(s.doc, id, r.sectionIndex, r.path, partial?.start ?? 0, partial?.end ?? r.text.length) : makeLineAnchor(s.doc, id, r.sectionIndex, r.path);
      need(a, 'WORKBENCH_POSITION'); template.anchors.push(a);
      template.rules.push({ id, do: { type: 'fill', anchor: id, value: { text: partial?.text ?? content.text } } });
    }
    // An unchanged source key is not authorisation to promote it, even if the
    // surrounding sentence was edited. Only newly authored key names qualify.
    const originalKeys = new Set(findPlaceholders(r.text).map(k => k.path));
    formats.push({ row: r, ...content, block: false, keys: makeTemplate ? findPlaceholders(content.text).filter(k => !originalKeys.has(k.path)) : [] });
  }
  for (const [i, block] of work.blocks.entries()) {
    const a = row(block.from), z = row(block.to), id = `block${i}`, content = projected(block.text, compositionData, true, makeTemplate || twoStage);
    need(checkValueText(content.text, 'paragraphs') === undefined, 'WORKBENCH_TEXT');
    const anchor = makeRangeAnchor(s.doc, a.sectionIndex, a.path.slice(0, -1), a.path.at(-1)!, z.path.at(-1)!);
    need(anchor, 'WORKBENCH_RANGE'); template.anchors.push({ ...anchor, id });
    template.rules.push({ id, do: content.text === '' ? { type: 'delete', anchor: id } : { type: 'insertText', anchor: id, position: 'replace', value: { text: content.text }, style: 'inherit' } });
    formats.push({ row: a, ...content, block: true, keys: makeTemplate ? findPlaceholders(content.text) : [] });
  }
  for(const [i,placement] of work.placements.entries()){
    need(library,'BLOCK_STORE');const stored=library.material(placement.id,placement.version),a=row(placement.from),z=row(placement.to),id='stored'+i;
    const anchor=makeRangeAnchor(s.doc,a.sectionIndex,a.path.slice(0,-1),a.path.at(-1)!,z.path.at(-1)!);need(anchor,'WORKBENCH_RANGE');
    template.anchors.push({...anchor,id});template.rules.push({id,do:{type:'inject',anchor:id,position:'replace',fragment:stored.fragment as unknown as Record<string,unknown>}});
  }
  const result = generate(s.source, readTemplate(template), compositionData ?? readDataset({}), { missing: compositionData ? work.missing : 'keep', mode: 'baseline', allowNothingApplied: twoStage || !template.rules.length && (!dataset || formats.some(f => f.spans.length)) });
  if (!result.ok || !('output' in result)) {
    if (result.report.plan.missingPaths.length) unlinked(`데이터에 없는 키 ${result.report.plan.missingPaths.length}개: ${result.report.plan.missingPaths.slice(0, 20).join(', ')}`);
    return fail(result.report.issues.find(i => i.severity === 'error')?.code ?? 'WORKBENCH_GENERATE', '문서 생성 검사를 통과하지 못했습니다.');
  }
  need(!result.report.plan.skipped.some(x => x.ruleId !== 'implicit'), 'WORKBENCH_SKIPPED');
  let output = result.output;
  let filled=result.report.plan.actions.filter(a=>a.type==='fill').reduce((n,a)=>n+a.targets,0);
  let formattedDoc = parseDocument(openPackage(output));
  const targets: CompileTarget[] = [];
  const hasBold = formats.some(f => f.spans.length);
  need(!hasBold || !result.report.issues.some(i => i.code === 'FIELD_PARAGRAPHS_MERGED'), 'WORKBENCH_FORMAT_MOVED');
  for (const f of formats) {
    const own = f.block ? result.report.plan.moves.find(m => m.sectionIndex === f.row.sectionIndex && m.from === f.row.path.at(-1) && m.parentPath.length === f.row.path.length - 1 && m.parentPath.every((n, i) => n === f.row.path[i])) : undefined;
    const address = remapAddress(result.report.plan.moves.filter(m => m !== own), { sectionIndex: f.row.sectionIndex, path: f.row.path });
    need(address, 'WORKBENCH_FORMAT_MOVED');
    const lines = f.block ? f.text.split('\n') : [f.text]; let offset = 0;
    if (f.block && f.text === '') continue;
    for (const [i, line] of lines.entries()) {
      const target = { ...address, path: [...address.path] }; target.path[target.path.length - 1]! += i;
      const checked = paragraph(formattedDoc, target);
      need(checked?.logicalText === line, 'WORKBENCH_FORMAT_MOVED');
      for (const span of f.spans) {
        const start = Math.max(0, span.start - offset), end = Math.min(line.length, span.end - offset);
        if (start >= end) continue;
        const pkg = openPackage(output), doc = parseDocument(pkg), p = paragraph(doc, target);
        need(p?.logicalText === line, 'WORKBENCH_FORMAT_MOVED');
        const plan = planApplyCharFormat(doc, { ...target, start, end }, charDelta(doc, { bold: true }));
        const next = applyPlan(pkg, plan);
        need(!verifyPreservation(output, next, plan).some(e => e.severity === 'error'), 'WORKBENCH_PRESERVATION');
        output = next;
        formattedDoc = parseDocument(openPackage(output));
      }
      for (const key of f.keys.filter(k => k.start >= offset && k.end <= offset + line.length)) targets.push({ ...target, start: key.start - offset, end: key.end - offset, name: key.path });
      offset += line.length + 1;
    }
  }
  if (makeTemplate) {
    if (!targets.length) return fail('WORKBENCH_NO_NEW_FIELDS', '수정한 글에 새 {{키}}를 넣어 주세요. 원본에 있던 키는 자동으로 누름틀로 바꾸지 않습니다.');
    if (targets.length !== formats.reduce((count, f) => count + f.keys.length, 0)) return fail('WORKBENCH_TEMPLATE_INCOMPLETE', '줄을 넘는 키는 누름틀로 만들 수 없습니다. {{키}}를 한 줄에 넣어 주세요. 일부만 만든 파일은 저장하지 않았습니다.');
    const compiled = compileDocument(output, { mode: 'baseline', anchors: targets });
    if (!compiled.ok || compiled.report.promoted !== targets.length || compiled.report.issues.some(i => i.code === 'COMPILE_SKIPPED' || i.severity === 'error'))
      return fail('WORKBENCH_TEMPLATE_INCOMPLETE', '누름틀로 만들지 못한 키가 있습니다. 키 전체가 같은 서식 안에 있도록 수정하세요. 일부만 만든 파일은 저장하지 않았습니다.');
    output = compiled.output;
  }
  if(typed&&dataset){const values=fillValues(s,work.inputItems,output,dataset,work.missing);output=values.output;filled+=values.filled;}
  else if(twoStage&&dataset){
    const values=generate(output,emptyTemplate(),dataset,{missing:work.missing,mode:'baseline',allowNothingApplied:true});
    if(!values.ok||!('output' in values)){
      if(values.report.plan.missingPaths.length)unlinked(`데이터에 없는 키 ${values.report.plan.missingPaths.length}개: ${values.report.plan.missingPaths.slice(0,20).join(', ')}`);
      return fail(values.report.issues.find(i=>i.severity==='error')?.code??'WORKBENCH_GENERATE','입력 값을 채우지 못했습니다. 데이터 항목을 확인하세요.');
    }
    output=values.output;filled+=values.report.plan.actions.filter(a=>a.type==='fill').reduce((n,a)=>n+a.targets,0);
  }
  const outputDoc = parseDocument(openPackage(output));
  need(compareToBaseline(validateDocument(s.source), validateDocument(output)).newErrors.length === 0, 'WORKBENCH_VALIDATION');
  const paragraphs = outputDoc.sections.flatMap(section => [...walkParagraphs(section.paragraphs)]);
  return { output, text: paragraphs.map(p => p.logicalText.replaceAll('\uFFFC', '')).join('\n'), filled: makeTemplate ? 0 : filled, changed: edits.length + work.blocks.length + work.placements.length, ...(makeTemplate ? { template: true as const, promoted: targets.length } : {}),
    notes: [...new Set(result.report.issues.filter(i => i.severity === 'warning').map(i => plainBlock(i.code))), ...(work.headings.length ? ['제목 단계는 작업 화면의 표시 정보입니다.'] : []), ...(work.blocks.length ? ['일반 글 블록은 첫 문단의 서식을 상속합니다.'] : []), ...(paragraphs.some(p => p.logicalText.includes('\uFFFC')) ? ['복사용 본문에는 개체 자리 표시를 생략했습니다.'] : [])] };
}

function buildText(s: Session, work: Work) {
  const dataset = datasetOf(s, work), valueFormats = dataset ? formatsOf(s, work.inputItems) : new Map<string, Shape>();
  const separators = [...s.sourceText!.matchAll(/\r\n|\r|\n/g)].map(m => m[0]);
  const edits = new Map(work.edits.filter(e => e.text !== s.rows.find(r => r.id === e.id)!.text).map(e => [e.id, e]));
  let text = '', filled = 0, ranges = 0;
  const left: string[] = [];
  for (let i = 0; i < s.rows.length; i++) {
    const row = s.rows[i]!, block = work.blocks.find(b => b.from === row.id), edit = edits.get(row.id);
    const decorate = edit && !block && dataset ? decorationsOf(work.inputItems, row, edit.text) : undefined;
    const content = (block ? block.text : edit ? edit.text : row.text).replace(/\{\{([^{}]*)\}\}/g, (token, key: string, at: number, line: string) => {
      const path = key.trim();
      if (/^[#/]/.test(path)) { ranges++; return token; }
      const value = dataset && isValidPath(path) ? resolvePathValue(dataset, path, 'error') : undefined;
      // 수량은 확정 자리의 원문 단위, 금액·날짜는 자리마다 바로 뒤 글로(엔진이 읽지 못하는 값은 그대로)
      if (value?.kind === 'text') { filled++; return decorate?.get(at)?.(value.text) ?? valueFormats.get(path)?.(value.text, line.slice(at + token.length)) ?? value.text; }
      left.push(token); return token;
    });
    if (block) i = s.rows.findIndex(r => r.id === block.to);
    if (!block || content !== '') text += content + (separators[i] ?? '');
    need(Buffer.byteLength(text) <= MAX_SOURCE, 'WORKBENCH_RESULT_LIMIT');
  }
  // 남은 자리는 원문·편집 글의 표기만 센다(값은 다시 읽지 않는다). 설명은 HWPX·빠른 생성과 같은 꼴
  const unresolved = left.length;
  if (unresolved && work.missing === 'error') unlinked(describeLeftover(findLeftovers(left)));
  need(checkValueText(text) === undefined, 'WORKBENCH_TEXT');
  return { output: new TextEncoder().encode(text), text, filled, changed: edits.size + work.blocks.length,
    ...(unresolved ? { template: true as const, unresolved } : {}),
    notes: [...(ranges ? [`구간 표기 ${ranges}곳이 결과에 남아 있습니다. 구간 선택은 아직 적용하지 않았습니다.`] : []), ...(work.headings.length ? ['제목 단계는 작업 화면의 표시 정보입니다.'] : [])] };
}

export function createWorkbench(library?: BlockLibrary) {
  const sessions = new Map<string, Session>();
  const sessionOf = (id: unknown) => { const s = typeof id === 'string' ? sessions.get(id) : undefined; if (!s) throw new HostError(404, 'WORKBENCH_SESSION', '문서를 다시 올려 주세요.'); return s; };
  const registered = (s: Session) => {
    s.workspaceId ??= randomUUID();
    const fields = s.kind === 'hwpx' ? analyzePlaces(s.source).fields : [];
    const headings = s.doc ? detectHeadings(s.doc) : [];
    const outline = headings.map(h => ({id:rowId(h.at.sectionIndex,[...h.at.parentPath,h.index]),name:h.text,level:h.marker.level}));
    s.headings = outline;
    const blockCandidates = headings.flatMap(h => {
      const range=headingRangeOf(s.doc!,h.at,h.index);if(!range)return [];
      const from=rowId(h.at.sectionIndex,[...h.at.parentPath,range.from]),to=rowId(h.at.sectionIndex,[...h.at.parentPath,range.to]);
      return [{from,to,name:h.text,paragraphCount:range.to-range.from+1}];
    });
    if (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
    const session = randomUUID(); sessions.set(session, s);
    return {session,kind:s.kind,name:s.name,sourceUrl:`/api/workbench/source?session=${session}`,...(s.sourceText===undefined?{}:{sourceText:s.sourceText}),paragraphs:s.rows,fields,inputs:s.inputs=inputsOf(s),outline,blockCandidates};
  };
  return {
    // Unsaved placements exist only here; block deletion must see every open session.
    inUse(protoId: string): boolean { return [...sessions.values()].some(s => s.pins?.has(protoId)); },
    get(path: string, query: URLSearchParams): { body: Uint8Array; name?: string; type?: string } | undefined {
      if (path !== '/api/workbench/source' && path !== '/api/workbench/result') return;
      const s = sessionOf(query.get('session'));
      const type = s.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/vnd.hancom.hwpx';
      if (path.endsWith('/source')) return { body: s.source.slice(), type };
      if (!s.output) throw new HostError(404, 'WORKBENCH_RESULT', '내려받을 생성물이 없습니다.');
      return { body: s.output.slice(), name: `${sanitizeFileStem(s.name.replace(/\.txt$/i, ''))}-result.${s.kind === 'text' ? 'txt' : 'hwpx'}`, type };
    },
    post(path: string, input: Record<string, unknown>): unknown {
      try {
        if (path === '/api/workbench/open') return registered(open(input.name, input.content));
        if (path === '/api/workbench/compare') {
          const s = open(input.name, input.content);
          return { name: s.name, paragraphs: s.rows };
        }
        if (path === '/api/workbench/restore') {
          need(typeof input.workspace !== 'string' || Buffer.byteLength(input.workspace) <= 20 * 1024 * 1024, 'WORKBENCH_WORKSPACE');
          const raw: unknown = typeof input.workspace === 'string' ? JSON.parse(input.workspace) : input.workspace;
          need(isObj(raw) && raw.schema === schema && (raw.kind === 'text' || raw.kind === 'hwpx') && Object.keys(raw).every(k => ['schema', 'kind', 'name', 'source', 'sha256', 'data', 'edits', 'headings', 'blocks', 'placements', 'inputItems', 'index', 'missing', 'samples', 'workspaceId'].includes(k)), 'WORKBENCH_WORKSPACE');
          const s = open(raw.name, raw.source); need(raw.kind === s.kind, 'WORKBENCH_WORKSPACE'); need(raw.sha256 === hash(s.source), 'WORKBENCH_SOURCE_HASH');
          if (raw.data !== undefined) { const parsed = parseData(raw.data, 'data.json'); s.data = parsed.data; s.dataContent = parsed.content; }
          need(raw.workspaceId===undefined||typeof raw.workspaceId==='string'&&/^[0-9a-f-]{36}$/.test(raw.workspaceId),'WORKBENCH_WORKSPACE');
          s.workspaceId=raw.workspaceId as string|undefined;
          const work = workOf(s, raw);
          // A saved work may outlive a deleted block: open it without that placement and say so.
          const missing=work.placements.filter(p=>{need(library,'BLOCK_STORE');try{p.id=library.material(p.id,p.version).proto.id;return false;}catch(e){if(e instanceof HostError&&e.code==='BLOCK_NOT_FOUND')return true;throw e;}});
          work.placements=work.placements.filter(p=>!missing.includes(p));s.pins=new Set(work.placements.map(p=>p.id));
          return { ...registered(s), ...work, ...(missing.length?{notice:`저장소에서 지워진 블록 ${missing.length}개의 배치를 빼고 열었습니다. 그 범위는 원문 그대로입니다.`}:{}), placementNames:Object.fromEntries(work.placements.map(p=>{need(library,'BLOCK_STORE');return [p.id,library.material(p.id,p.version).item.name];})), placementWarnings:Object.fromEntries(work.placements.map(p=>{need(library,'BLOCK_STORE');return [p.id+':'+p.from,placementInfo(s,p,library).warnings];})), dataInfo: dataInfo(s) };
        }
        const s = sessionOf(input.session);
        if (path === '/api/workbench/block-preview') {
          if (!library) return fail('BLOCK_STORE', '블록 저장소를 사용할 수 없습니다.');
          if (!s.doc || s.kind !== 'hwpx') return fail('BLOCK_HWPX', '이번 블록 저장은 HWPX 원문에서만 지원합니다.');
          const from = s.rows.find(r => r.id === input.from), to = s.rows.find(r => r.id === input.to);
          need(from && to, 'WORKBENCH_POSITION');
          if (!sameParent(from, to)) return fail('BLOCK_BOUNDARY', '표 칸이나 본문 경계를 넘는 범위는 저장할 수 없습니다. 같은 칸 안이나 같은 본문에서 선택하세요.');
          const selection = { sectionIndex: from.sectionIndex, parentPath: from.path.slice(0, -1),
            from: Math.min(from.path.at(-1)!, to.path.at(-1)!), to: Math.max(from.path.at(-1)!, to.path.at(-1)!) };
          const draft = extractBlockDraft(s.doc, s.name, selection);
          s.blockPreviews ??= new Map();
          // One pending extraction per document bounds memory; an older dialog cannot save a newer selection.
          s.blockPreviews.clear(); s.blockPreviews.set(draft.id, draft);
          const { fragment: _fragment, ...preview } = draft;
          return { ...preview, version: 1 };
        }
        if (path === '/api/workbench/block-placement-preview') {
          need(library&&s.doc,'BLOCK_HWPX');const work=workOf(s,input);need(work.placements.length,'WORKBENCH_POSITION');
          const info=placementInfo(s,work.placements.at(-1)!,library);
          build(s,work,false,library);
          return info;
        }
        if (path === '/api/workbench/block-save') {
          if (!library) return fail('BLOCK_STORE', '블록 저장소를 사용할 수 없습니다.');
          const draft = typeof input.previewId === 'string' ? s.blockPreviews?.get(input.previewId) : undefined;
          if (!draft) return fail('BLOCK_PREVIEW', '선택 범위를 다시 확인한 뒤 저장하세요.');
          return library.save(draft, input.name);
        }
        if (path === '/api/workbench/invalidate') {
          delete s.output;
          if (input.placements !== undefined) {
            const list = input.placements as { id: string }[];
            need(Array.isArray(list) && list.length <= 100 && list.every(p => isObj(p) && typeof p.id === 'string'));
            s.pins = new Set(list.map(p => { need(library, 'BLOCK_STORE'); return library.get(p.id).protoId; }));
          }
          return { invalidated: true };
        }
        if (path === '/api/workbench/select') {
          if (input.id !== undefined) {
            const row = s.rows.find(r => r.id === input.id); need(row, 'WORKBENCH_POSITION');
            if (s.kind === 'text') return { id: row.id, location: { precision: 'paragraph', address: { sectionIndex: row.sectionIndex, path: row.path }, trail: [], edge: 'start', drafts: [] } };
            need(s.doc, 'WORKBENCH_SOURCE');
            const anchor = makeLineAnchor(s.doc, 'selected', row.sectionIndex, row.path); need(anchor, 'WORKBENCH_POSITION');
            const mark = markOf(s.doc, anchor, resolveDrafts(s.doc, [anchor])[0]);
            const location = mark ? locate(s.doc, { from: { position: mark.position, limit: 'paragraph' } }) : { precision: 'none', reason: 'WORKBENCH_VIEWER_UNMAPPED', trail: [], edge: 'start', drafts: [] };
            const address = 'address' in location ? location.address : undefined;
            need(address === undefined || rowId(address.sectionIndex, address.path) === row.id, 'WORKBENCH_VIEWER_UNMAPPED');
            return { id: row.id, location };
          }
          need(s.doc, 'WORKBENCH_SOURCE'); const location = locate(s.doc, input.request), address = location.address;
          return { ...(address ? { id: rowId(address.sectionIndex, address.path) } : {}), location };
        }
        if (path === '/api/workbench/sample') return sampleOf(s, input.index);
        if (path === '/api/workbench/g2b-template') {
          need(s.doc && (input.id === undefined || typeof input.id === 'string' && /^t[0-9a-f]{8}$/.test(input.id)));
          const { entries, skipped } = g2bEntries(s, workOf(s, input).inputItems), sha256 = hash(s.source);
          return { template: g2bTemplate(entries, { id: (input.id as string | undefined) ?? 't' + sha256.slice(0, 8), version: 1, name: s.name.replace(/\.hwpx$/i, ''), sha256 }), skipped };
        }
        // 등록 안 된 누름틀·메일머지(#134): 위 서식 판이 맡지 않아 Helper 생성이 채우지 않는 필드(엔진 판정)
        if (path === '/api/workbench/unregistered') return { places: s.doc ? listUnregisteredPlaces(s.doc, g2bTemplate(g2bEntries(s, workOf(s, input).inputItems).entries, { id: 't', version: 1, name: '', sha256: '' }) as unknown as StudioTemplate).filter(p => p.kind !== 'placeholder') : [] };
        if (path === '/api/workbench/item-label') {
          // 지정한 자리의 가장 가까운 라벨(#148): 같은 문단 앞 `라벨:` → 같은 표 행 왼쪽 라벨 칸 → 위 제목
          const row = s.rows.find(r => r.id === input.row); need(row, 'WORKBENCH_POSITION');
          const start = input.start as number, end = input.end as number;
          need(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= row.text.length, 'WORKBENCH_POSITION');
          const label = labelOf(s, row, start);
          return label ? { label } : {};
        }
        if (path === '/api/workbench/check-input') {
          // 표 보기 확정 전 검사: 글자 모양이 섞인 줄은 바뀐 구간이 한 모양 안이어야 생성된다(changedRange와 같은 판정)
          const row = s.rows.find(r => r.id === input.row); need(row, 'WORKBENCH_POSITION');
          const start = input.start as number, end = input.end as number;
          need(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= row.text.length, 'WORKBENCH_POSITION');
          if (!row.editable) return { ok: false, code: row.reason ?? 'WORKBENCH_READONLY' };
          if (s.kind === 'text' || row.rangeEditable) return { ok: true };
          const at = start === end && end === row.text.length ? start - 1 : start, until = start === end && end < row.text.length ? end + 1 : end;
          const draft = at < 0 ? undefined : draftAnchors(s.doc!, { sectionIndex: row.sectionIndex, path: row.path, start: at, end: until }).find(d => d.kind === 'word');
          return draft?.kind === 'word' && !draft.blocked ? { ok: true } : { ok: false, code: draft?.blocked ?? 'WORKBENCH_PARTIAL_EDIT' };
        }
        if (path === '/api/workbench/data') {
          delete s.output; delete s.data; delete s.dataContent;
          const parsed = parseData(input.content, input.name); s.data = parsed.data; s.dataContent = parsed.content;
          return dataInfo(s);
        }
        if (path === '/api/workbench/generate' || path === '/api/workbench/template' || path === '/api/workbench/save') {
          if (!path.endsWith('/save')) delete s.output;
          const makeTemplate = path.endsWith('/template');
          if (makeTemplate && s.kind !== 'hwpx') return fail('WORKBENCH_TEMPLATE_HWPX', '실제 누름틀은 HWPX 문서에서 만들 수 있습니다. TXT에서는 {{키}}를 그대로 사용하세요.');
          const work = workOf(s, input);
          for(const p of work.placements){need(library,'BLOCK_STORE');p.id=library.material(p.id,p.version).proto.id;}
          s.pins=new Set(work.placements.map(p=>p.id));
          if (path.endsWith('/save')) {
            library?.saveWorkspace(s.workspaceId!,s.name,work.placements);
            return { name: `${sanitizeFileStem(s.name.replace(/\.txt$/i, ''))}.workspace.json`, workspace: JSON.stringify({ schema, workspaceId:s.workspaceId, kind: s.kind, name: s.name, source: Buffer.from(s.source).toString('base64'), sha256: hash(s.source), ...(s.dataContent === undefined ? {} : { data: s.dataContent }), ...work }) };
          }
          const result = s.kind === 'text' ? buildText(s, work) : build(s, work, makeTemplate, library);
          let notes = result.notes, unresolved = 'unresolved' in result ? result.unresolved : undefined;
          if (s.kind === 'hwpx' && !makeTemplate) {
            // 결과에 남은 {{…}}(혼합 서식·이름 규칙 밖·자리 유지 등): 기본 정책은 생성 막기, 자리 유지면 알림(빠른 생성과 같은 판정)
            const dataset = datasetOf(s, work);
            const left = leftoverOf(result.output, dataset, masked => { try { return build(s, work, false, library, masked).output; } catch { return undefined; } });
            if (left.count && work.missing === 'error') unlinked(describeLeftover(left));
            if (left.count) { unresolved = left.count; notes = [...notes, `채우지 못한 {{…}} 자리가 결과에 그대로 남았습니다(${describeLeftover(left)})`]; }
          }
          s.output = result.output;
          return { ok: true, kind: s.kind, text: result.text, outputUrl: `/api/workbench/result?session=${input.session}`, filled: result.filled, changed: result.changed, bytes: result.output.length, notes, ...('template' in result && result.template ? { template: true } : {}), ...('promoted' in result ? { promoted: result.promoted } : {}), ...(unresolved === undefined ? {} : { unresolved }) };
        }
        throw new HostError(404, 'WORKBENCH_ROUTE', '없는 작업 요청입니다.');
      } catch (error) {
        if (error instanceof HostError) throw error;
        const code = isObj(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'WORKBENCH_INPUT';
        fail(code, '파일과 입력을 확인하세요. 원본은 변경되지 않았습니다.');
      }
    },
  };
}
