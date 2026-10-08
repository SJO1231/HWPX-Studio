import { createHash, randomUUID } from 'node:crypto';
import {
  planBlockInsert, applyPlan, detectHeadings, headingRangeOf, charDelta, checkValueText, collectFields, compareToBaseline, compileDocument, draftAnchors, emptyTemplate, fieldRangeIn, findPlaceholders, generate,
  isValidPath, makeLineAnchor, makeRangeAnchor, makeWordAnchor, openPackage, parseDocument,
  planApplyCharFormat, readDataset, readTemplate, remapAddress, resolvePathValue, sanitizeFileStem, validateDocument,
  verifyPreservation, walkParagraphs, type CompileTarget, type Dataset, type HwpxDocument,
} from '@hwpx-studio/engine';
import { HostError, isObj, locate, markOf, resolveDrafts } from '../../../packages/viewer/src/host/index.ts';
import { toRhwpPosition, type RhwpPosition } from '../../../packages/viewer/src/map/index.ts';
import { extractBlockDraft, type BlockDraft, type BlockLibrary } from './block-library.ts';
import { parseCsv } from './core.ts';
import { analyzePlaces, describeLeftover, findLeftovers, leftoverOf, listKeys, parseQuickData, type QuickData } from './quick.ts';

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
type Work = { edits: Edit[]; headings: Heading[]; blocks: Block[]; placements: Placement[]; index: number; missing: "error" | "keep" };
type Session = { workspaceId?: string; kind: 'hwpx' | 'text'; name: string; source: Uint8Array; doc?: HwpxDocument; sourceText?: string; rows: Row[]; data?: QuickData; dataContent?: string; output?: Uint8Array; blockPreviews?: Map<string, BlockDraft>; pins?: Set<string> };
const rowId = (section: number, path: number[]) => `p:${section}:${path.join('.')}`;
const sameParent = (a: Row, b: Row) => a.sectionIndex === b.sectionIndex && a.path.length === b.path.length && a.path.slice(0, -1).every((n, i) => n === b.path[i]);
const contains = (a: Row, b: Row, row: Row) => sameParent(a, row) && row.path.at(-1)! >= a.path.at(-1)! && row.path.at(-1)! <= b.path.at(-1)!;
const paragraph = (doc: HwpxDocument, row: Pick<Row, 'sectionIndex' | 'path'>) => [...walkParagraphs(doc.sections[row.sectionIndex]!.paragraphs)].find(p => p.path.length === row.path.length && p.path.every((n, i) => n === row.path[i]));
type Input = { kind: 'clickHere' | 'mailMerge' | 'placeholder'; name: string; row: string; start: number; end: number; usable?: boolean };

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
  return out.sort((a, b) => (order.get(a.row) ?? 0) - (order.get(b.row) ?? 0) || a.start - b.start);
}

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
function dataInfo(s: Session) {
  const first = s.data?.records[0];
  return { records: s.data?.records.length ?? 0, keys: s.data ? listKeys(s.data.records).keys : [], preview: first && 'dataset' in first ? first.dataset.data : {}, index: 0 };
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
  return { edits, headings, blocks, placements, index, missing: input.missing ?? "error" };

}

// ponytail: this projection only supports **bold** and {{path}}, not Markdown round trips.
function projected(input: string, dataset: Dataset | undefined, format = true, keepKeys = false) {
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
      const path = match[1]!.trim();
      if (keepKeys) {
        if (!isValidPath(path)) return fail('WORKBENCH_FIELD_NAME', '키에는 글자·숫자·밑줄을 사용하고, 하위 항목은 점으로 구분하세요. {{사업명}}처럼 공백 없는 이름을 넣어 주세요.');
        text += match[0];
      }
      else if (!format && (!dataset || !isValidPath(path))) text += match[0];
      else {
        need(isValidPath(path) && dataset, 'WORKBENCH_DATA_REQUIRED');
        // Data is appended literally; its ** and {{}} are never parsed again.
        text += resolveValue(dataset, path); filled++;
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
  const record = s.data?.records[work.index];
  const dataset = makeTemplate ? undefined : override ?? (record && 'dataset' in record ? record.dataset : undefined);
  const compositionData=work.placements.length?undefined:dataset;
  const template = emptyTemplate();
  const formats: { row: Row; text: string; spans: { start: number; end: number }[]; block: boolean; keys: ReturnType<typeof findPlaceholders> }[] = [];
  const row = (id: string) => s.rows.find(r => r.id === id)!;
  const edits = work.edits.filter(e => e.text !== row(e.id).text);
  for (const [i, edit] of edits.entries()) {
    const r = row(edit.id), content = projected(edit.text, compositionData, true, makeTemplate||work.placements.length>0), id = `edit${i}`;
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
    const a = row(block.from), z = row(block.to), id = `block${i}`, content = projected(block.text, compositionData, true, makeTemplate||work.placements.length>0);
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
  const result = generate(s.source, readTemplate(template), compositionData ?? readDataset({}), { missing: compositionData ? work.missing : 'keep', mode: 'baseline', allowNothingApplied: !template.rules.length && (!dataset || formats.some(f => f.spans.length)) });
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
  if(work.placements.length&&dataset){
    const values=generate(output,emptyTemplate(),dataset,{missing:work.missing,mode:'baseline',allowNothingApplied:true});
    if(!values.ok||!('output' in values)){
      if(values.report.plan.missingPaths.length)unlinked(`데이터에 없는 키 ${values.report.plan.missingPaths.length}개: ${values.report.plan.missingPaths.slice(0,20).join(', ')}`);
      return fail(values.report.issues.find(i=>i.severity==='error')?.code??'WORKBENCH_GENERATE','블록의 입력 값을 채우지 못했습니다. 데이터 항목을 확인하세요.');
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
  const record = s.data?.records[work.index], dataset = record && 'dataset' in record ? record.dataset : undefined;
  const separators = [...s.sourceText!.matchAll(/\r\n|\r|\n/g)].map(m => m[0]);
  const edits = new Map(work.edits.filter(e => e.text !== s.rows.find(r => r.id === e.id)!.text).map(e => [e.id, e]));
  let text = '', filled = 0, ranges = 0;
  const left: string[] = [];
  for (let i = 0; i < s.rows.length; i++) {
    const row = s.rows[i]!, block = work.blocks.find(b => b.from === row.id), edit = edits.get(row.id);
    const content = (block ? block.text : edit ? edit.text : row.text).replace(/\{\{([^{}]*)\}\}/g, (token, key: string) => {
      const path = key.trim();
      if (/^[#/]/.test(path)) { ranges++; return token; }
      const value = dataset && isValidPath(path) ? resolvePathValue(dataset, path, 'error') : undefined;
      if (value?.kind === 'text') { filled++; return value.text; }
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
    const blockCandidates = headings.flatMap(h => {
      const range=headingRangeOf(s.doc!,h.at,h.index);if(!range)return [];
      const from=rowId(h.at.sectionIndex,[...h.at.parentPath,range.from]),to=rowId(h.at.sectionIndex,[...h.at.parentPath,range.to]);
      return [{from,to,name:h.text,paragraphCount:range.to-range.from+1}];
    });
    if (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
    const session = randomUUID(); sessions.set(session, s);
    return {session,kind:s.kind,name:s.name,sourceUrl:`/api/workbench/source?session=${session}`,...(s.sourceText===undefined?{}:{sourceText:s.sourceText}),paragraphs:s.rows,fields,inputs:inputsOf(s),outline,blockCandidates};
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
          need(isObj(raw) && raw.schema === schema && (raw.kind === 'text' || raw.kind === 'hwpx') && Object.keys(raw).every(k => ['schema', 'kind', 'name', 'source', 'sha256', 'data', 'edits', 'headings', 'blocks', 'placements', 'index', 'missing', 'workspaceId'].includes(k)), 'WORKBENCH_WORKSPACE');
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
            const record = s.data?.records[work.index], dataset = record && 'dataset' in record ? record.dataset : undefined;
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
