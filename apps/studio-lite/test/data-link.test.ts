// #149 데이터 연결 모델: 같은 이름 공유·다른 이름 별칭 → Helper 서식 판 bindings, 지정 자리(word 앵커, #173 한계 1), 업무 건, 견본 값,
// "다시 확인"의 파일 이름 규칙 보존(#173 한계 2), 예시의 "원"(#172).
// 합성 서식(본문·표 칸·머리말에 누름틀·{{키}}·지정 자리 49곳, 같은 키 중복)에 긴 값(여러 문장·줄바꿈·탭·XML 특수문자)의 업무 건 50건:
// 작업창 생성 x2(결정성)와 2판 창구 생성(dryRun·실제)이 같은 글, 검사기 새 오류 0, 원문 불변. 출력은 OS 임시 폴더에만 쓰고 지운다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareToBaseline, compileDocument, generateFromTemplate, openPackage, parseDocument, readCase, readStudioTemplate, validateDocument, walkParagraphs, type StudioTemplate } from '@hwpx-studio/engine';
import { mutateEntryText, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { createWorkbench } from '../src/workbench.ts';
import { createG2B2 } from '../src/g2b-v2.ts';
import { confirmText, g2bTemplate, linkTargets, valueKey, type InputItem } from '../src/input-table.ts';

type Row = { id: string; text: string; editable: boolean };
type Opened = { session: string; paragraphs: Row[]; inputs: { kind: 'clickHere' | 'mailMerge' | 'placeholder'; name: string; row: string; start: number; end: number; usable: boolean }[] };
const texts = (bytes: Uint8Array) => parseDocument(openPackage(bytes)).sections.flatMap(s => [...walkParagraphs(s.paragraphs)].map(p => p.logicalText));
const wrong = (run: () => unknown, code: string) => assert.throws(run, (e: any) => e.code === code, code);
const blank = { index: 0, edits: [] as { id: string; text: string }[], headings: [], blocks: [] };

// 본문 18(짝수 줄: 누름틀 + {{사업명}}, 홀수 줄: 지정할 글, 끝 6줄: {{공고번호}} + {{사업명}}), 표 칸 12(지정할 금액), 머리말 1(지정할 글). 누름틀은 기관명 4·담당자 2.
// 지정 자리는 원래 {{키}}가 없는 줄에 둔다({{키}}가 있는 줄 안의 지정은 preview-parity 시험, #180)
const FIELDS = ['기관명', '담당자', '기관명'];
function linkSource(): Uint8Array {
  const source = readFixture('hancom/header-footer'), s = parseDocument(openPackage(source)).sections[0]!, start = s.paragraphs[0]!.element.end;
  const body = Array.from({ length: 12 }, (_, i) => textPara(i % 2 === 0 ? `본문 ${i} {{${FIELDS[(i / 2) % 3]}}} 사업 {{사업명}}` : `본문 ${i} 사업명: 원래 값 ${i}`))
    .concat(Array.from({ length: 6 }, (_, i) => textPara(`번호 {{공고번호}} 줄 ${i} 사업 {{ 사업명 }}`)));
  const cells = Array.from({ length: 3 }, (_, r) => Array.from({ length: 4 }, (_, c) => `칸 ${r * 4 + c} 금액 1,234,000원`));
  const raw = mutateEntryText(source, s.entryName, x => x.slice(0, start).replace('{{doc.title}}', '머리 공고 기관 HEADER').replace('{{doc.owner}}', 'FOOTER_FIXED')
    + body.join('') + tableParagraph(gridTable([9000, 9000, 9000, 9000], 3, cells, { id: '3960' })) + textPara('OUTSIDE_FIXED') + x.slice(x.lastIndexOf('</hs:sec>')));
  // 짝수 본문 줄의 첫 {{…}}를 엔진으로 누름틀로 만든다
  const targets = [];
  for (const p of walkParagraphs(parseDocument(openPackage(raw)).sections[0]!.paragraphs)) {
    const m = /^본문 (\d+) \{\{([^}]+)\}\}/.exec(p.logicalText);
    if (m && Number(m[1]) % 2 === 0) targets.push({ sectionIndex: 0, path: p.path, start: m[0].indexOf('{{'), end: m[0].length, name: m[2]! });
  }
  const compiled = compileDocument(raw, { mode: 'baseline', anchors: targets });
  assert(compiled.ok && compiled.report.promoted === 6, 'six fields');
  return compiled.output;
}

/** 화면이 하는 그대로: 찾은 자리는 추천(키 = 이름), 지정 자리는 이름·키를 적어 확정한다. 담당자 누름틀 하나를 "데이터 연결"로 다른 키에 잇는다(같은 이름 2곳이 함께) */
function linkedWork(opened: Opened) {
  const items: InputItem[] = opened.inputs.map(x => ({ row: x.row, start: x.start, end: x.end, name: x.name.trim(), key: x.usable ? x.name.trim() : '', type: 'text', status: 'recommended', origin: x.kind }));
  const rows = opened.paragraphs, mine: InputItem[] = [];
  // 지정(이름 없이) → 표에서 이름 → 리모컨 "데이터 연결"로 키를 고른다
  const keys = new Map<InputItem, string>();
  const add = (r: Row, text: string, name: string, key: string, type: InputItem['type'] = 'text') => {
    const start = r.text.indexOf(text); assert(start >= 0, text);
    const item: InputItem = { row: r.id, start, end: start + text.length, name, key: '', type, status: 'designated', origin: 'user' };
    mine.push(item); keys.set(item, key);
  };
  for (const r of rows) {
    const odd = /^본문 (\d+) 사업명/.exec(r.text);
    if (odd) { const n = Number(odd[1]), name = ['사업 설명', '계약(납품) 장소', '사업 설명'][((n - 1) / 2) % 3]!; add(r, '원래 값 ' + n, name, name === '사업 설명' ? '설명' : '장소'); }
    if (/^칸 \d+ 금액/.test(r.text)) add(r, '1,234,000원', '추정가격', '추정가격', 'money');
    if (r.text.startsWith('머리 공고')) add(r, '공고 기관', '머리 기관', '기관명');
  }
  items.push(...mine);
  // 데이터 연결: 지정 자리는 이름이 같은 줄이 함께(같은 이름은 같은 값), 담당자 누름틀 하나를 고르면 같은 이름 2곳이 함께 바뀐다
  for (const [item, key] of keys) { const group = linkTargets(items, item, key); assert(Array.isArray(group)); for (const x of group) x.key = key; }
  const field = items.find(x => x.origin === 'clickHere' && x.name === '담당자')!, group = linkTargets(items, field, '담당자_이름');
  assert(Array.isArray(group) && group.length === 2); for (const x of group) x.key = '담당자_이름';
  // 확정(✓ 전체): 지정 자리만 글이 {{키}}가 된다
  const edits: { id: string; text: string }[] = [];
  for (const r of rows) {
    const own = mine.filter(i => i.row === r.id);
    if (!own.length) continue;
    const result = confirmText(r.text, r.text, [], own.map(i => ({ start: i.start, end: i.end, key: i.key })));
    assert('text' in result); edits.push({ id: r.id, text: result.text });
    for (const i of own) i.status = 'confirmed';
  }
  return { items, edits, mine };
}

test('#149 data link model: same name shares one link, a confirmed {{key}} refuses a different key, different names become aliases, alias clashes are left out', () => {
  const base = { start: 0, end: 1, type: 'text' as const, origin: 'user' as const };
  const a: InputItem = { ...base, row: 'p:0:0', name: '사업명', key: '', status: 'designated' }, b: InputItem = { ...base, row: 'p:0:1', name: ' 사업명 ', key: '', status: 'designated' };
  const c: InputItem = { ...base, row: 'p:0:2', name: '사업명', key: 'x', status: 'excluded' }, d: InputItem = { ...base, row: 'p:0:3', name: '다른 이름', key: '', status: 'designated' };
  const f: InputItem = { ...base, row: 'p:0:4', name: '사업명', key: '필드', status: 'confirmed', origin: 'clickHere' };
  assert.deepEqual(linkTargets([a, b, c, d, f], a, '공고명'), [a, b, f], 'same name (trimmed) incl. a confirmed field; excluded and other names stay');
  assert.deepEqual(linkTargets([a, b], { ...d, name: '' }, 'k'), [{ ...d, name: '' }], 'no name: only itself');
  const locked = { ...b, status: 'confirmed' as const, key: '사업명' };
  assert.equal(typeof linkTargets([a, locked], a, '공고명'), 'string'); assert(Array.isArray(linkTargets([a, locked], a, '사업명')));
  assert.equal(valueKey({ key: ' k ', name: 'n' }), 'k'); assert.equal(valueKey({ key: '', name: ' n ' }), 'n');
  // 서식 판: 값은 연결 키마다 하나, 이름이 다르면 별칭. 다른 값의 키와 같거나 두 값에 걸친 이름은 별칭에서 뺀다
  const t = g2bTemplate([
    { kind: 'clickHere', name: '공고명', key: '사업명' }, { kind: 'placeholder', name: '사업명' }, { kind: 'mailMerge', name: '기관', key: '기관명' },
    { kind: 'word', name: '계약(납품) 장소', key: '장소', anchor: { id: 'a1' } }, { kind: 'word', name: '금액', key: '추정가격', type: 'money', anchor: { id: 'a2' }, unit: true },
    { kind: 'placeholder', name: '장소2', key: '기관명' }, { kind: 'mailMerge', name: '사업명', key: '장소' }, { kind: 'clickHere', name: '겹침', key: '기관명' }, { kind: 'clickHere', name: '겹침', key: '장소' },
  ], { id: 't00000149', version: 1, name: '연결', sha256: '0'.repeat(64) });
  assert.deepEqual(t.bindings, [
    { value: 'v1', key: '사업명', aliases: ['공고명'] }, { value: 'v2', key: '기관명', aliases: ['기관', '장소2'] }, { value: 'v3', key: '장소', aliases: ['계약(납품) 장소'] }, { value: 'v4', key: '추정가격', aliases: ['금액'] },
  ]);
  assert.deepEqual(t.values.find(v => v.name === '추정가격'), { id: 'v4', name: '추정가격', format: 'money', display: { unit: '원' } });
  assert.deepEqual(t.anchors, [{ id: 'a1' }, { id: 'a2' }]);
  assert.deepEqual(t.places.filter(p => 'anchor' in p), [{ id: 'p4', kind: 'word', value: 'v3', anchor: 'a1' }, { id: 'p5', kind: 'word', value: 'v4', anchor: 'a2' }]);
});

test('#149 end to end: 43 places (fields, {{keys}}, designated spans in body/cells/header; duplicates; a field linked to another column) x 50 cases — workbench preview x2 equals the Helper 2판 window, dryRun ok, new errors 0, source unchanged', async t => {
  const source = linkSource(), copy = Buffer.from(source), baseline = validateDocument(source), app = createWorkbench();
  const opened = app.post('/api/workbench/open', { name: 'link.hwpx', content: Buffer.from(source).toString('base64') }) as Opened;
  assert.equal(opened.inputs.length, 24); // 누름틀 6 + {{사업명}} 12 + {{공고번호}} 6
  const { items, edits, mine } = linkedWork(opened);
  assert.equal(mine.length, 19); assert.equal(items.length, 43);
  let seed = 0x149e2e;
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const long = (i: number, k: string) => `${k} ${i}: ` + Array.from({ length: 4 + next(8) }, (_, j) => `긴 문장 ${j}은 값이 여러 문장임을 보인다.`).join(' ') + `\n둘째 줄 & <특수> "따옴표" '홑'\t탭 뒤`;
  const records = Array.from({ length: 50 }, (_, i) => ({ 기관명: long(i, '기관'), 담당자_이름: long(i, '담당'), 사업명: long(i, '사업'), 공고번호: '00' + i, 설명: long(i, '설명'), 장소: long(i, '장소'), 추정가격: String(1000 * (1 + next(900000))) }));
  assert(records.every(r => r.설명.length > 100));
  const info = app.post('/api/workbench/data', { session: opened.session, name: 'cases.json', content: JSON.stringify(records) }) as any;
  // 업무 건 이름: 건마다 값이 다른 첫 열의 값(20자). 첫 열이 모두 같으면 다음 열
  assert.deepEqual(info.cases, records.map(r => r.기관명.replace(/\s+/g, ' ').trim().slice(0, 20)));
  const other = createWorkbench(), o2 = other.post('/api/workbench/open', { name: 'link.hwpx', content: Buffer.from(source).toString('base64') }) as Opened;
  assert.deepEqual((other.post('/api/workbench/data', { session: o2.session, name: 'c.json', content: JSON.stringify([{ 사업: '같음', 성명: '가', 수: 1 }, { 사업: '같음', 성명: '나', 수: 2 }]) }) as any).cases, ['가', '나']);

  // Helper 서식 판: 화면의 "서식 판 저장"과 같은 요청
  const { template, skipped } = app.post('/api/workbench/g2b-template', { session: opened.session, ...blank, edits, inputItems: items }) as any;
  assert.equal(skipped, 0);
  const read = readStudioTemplate(JSON.stringify(template)) as StudioTemplate;
  assert.equal(read.anchors.length, 19); assert.equal(read.places.length, 4 + 19);
  const binding = (key: string) => read.bindings.find(b => 'key' in b && b.key === key);
  assert.deepEqual(binding('담당자_이름'), { value: binding('담당자_이름')!.value, key: '담당자_이름', aliases: ['담당자'] });
  assert.deepEqual((binding('설명') as any).aliases, ['사업 설명']); assert.deepEqual((binding('장소') as any).aliases, ['계약(납품) 장소']);
  assert.deepEqual((binding('기관명') as any).aliases, ['머리 기관']); assert.equal((binding('사업명') as any).aliases, undefined);
  assert.deepEqual(read.values.find(v => v.name === '추정가격'), { id: binding('추정가격')!.value, name: '추정가격', format: 'money', display: { unit: '원' } });

  const root = mkdtempSync(join(tmpdir(), 'studio-link-')), db = new DatabaseSync(join(root, 'g.sqlite'));
  try {
    const g = createG2B2(db), out = join(root, 'out');
    g.saveTemplate({ template, source: Buffer.from(source).toString('base64') });
    g.saveProfile({ id: 'link', label: '연결', templateId: template.id, version: 1, outputDirectory: out });
    const request = (requestId: string, dryRun: boolean) => g.generate({ format: 'studio-generate', version: 2, requestId, profileId: 'link', dryRun, items: records.map(values => ({ values })) });
    const dry = await request('dry', true);
    assert.equal(dry.status, 'success', JSON.stringify(dry.results.find(r => r.status !== 'success'))); assert.deepEqual(dry.warnings, []); assert.equal(readdirSync(out).length, 0);
    const real = await request('real', false);
    assert.equal(real.summary.succeeded, 50); assert.deepEqual(real.warnings, []);
    let newErrors = 0, pairs = 0;
    for (let index = 0; index < 50; index++) {
      let first: Uint8Array | undefined;
      for (let repeat = 0; repeat < 2; repeat++) {
        const r = app.post('/api/workbench/generate', { session: opened.session, ...blank, index, edits, inputItems: items }) as any;
        assert.equal(r.ok, true);
        const bytes = app.get('/api/workbench/result', new URLSearchParams({ session: opened.session }))!.body;
        if (first) { assert.deepEqual(bytes, first); pairs++; } else first = bytes;
        newErrors += compareToBaseline(baseline, validateDocument(bytes)).newErrors.length;
      }
      const helper = new Uint8Array(readFileSync(real.results[index]!.path!));
      newErrors += compareToBaseline(baseline, validateDocument(helper)).newErrors.length;
      const lite = texts(first!), all = lite.join('\n'), rec = records[index]!;
      assert.deepEqual(texts(helper), lite, 'case ' + index);
      for (const v of [rec.기관명, rec.담당자_이름, rec.설명, rec.장소]) assert(all.includes(v.split('\n')[0]!), 'value in place ' + index);
      assert.equal(lite.filter(p => p.endsWith('금액 ' + Number(rec.추정가격).toLocaleString('en-US') + '원')).length, 12, '원 once in every cell');
      assert(!all.includes('{{') && !all.includes('원원'));
    }
    assert.equal(newErrors, 0); assert.equal(pairs, 50); assert.deepEqual(Buffer.from(source), copy);
    assert.deepEqual(app.get('/api/workbench/source', new URLSearchParams({ session: opened.session }))!.body, source);

    // 같은 이름 두 열(필드 이름 열과 연결한 열)에 모두 값이 있으면 작업창도 창구도 막는다(엔진 별칭 규칙)
    const both = { ...records[0]!, 담당자: '겹친 값' };
    app.post('/api/workbench/data', { session: opened.session, name: 'both.json', content: JSON.stringify(both) });
    wrong(() => app.post('/api/workbench/generate', { session: opened.session, ...blank, edits, inputItems: items }), 'DATA_ALIAS_CONFLICT');
    assert.equal((await g.generate({ format: 'studio-generate', version: 2, requestId: 'both', profileId: 'link', dryRun: true, items: [{ values: both }] })).results[0]!.code, 'PROFILE_MAPPING_CONFLICT');

    // "다시 확인"(#173 한계 2): 판만 바꿔 GET 꼴(fileName 없음)로 다시 저장해도 저장된 파일 이름 규칙이 남는다
    g.saveProfile({ id: 'link', label: '연결', templateId: template.id, version: 1, outputDirectory: out, fileName: '{identity}_{서식명}' });
    g.saveTemplate({ template: { ...template, version: 2 }, source: Buffer.from(source).toString('base64') });
    const listed = g.profiles().find(p => p.id === 'link')!;
    assert.equal('fileName' in listed, false);
    g.saveProfile({ ...listed, version: 2 } as any);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT document FROM g2b_profile WHERE id=?').get('link')!['document'])).fileName, '{identity}_{서식명}');
    assert.equal(g.profiles().find(p => p.id === 'link')!.version, 2);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  t.diagnostic(`seed=0x149e2e; places=43 (fields 6, placeholders 18, designated 19); values=${read.values.length}; cases=50; workbench_generations=100; deterministic_pairs=50; helper_items=50 (dryRun 50 + real 50); text_equal=50; new_errors=0; source unchanged`);
});

test('#149 work file keeps links and sample values; with no data the table sample values build the preview (same value typed once for every place)', () => {
  const source = linkSource(), app = createWorkbench();
  const opened = app.post('/api/workbench/open', { name: 'link.hwpx', content: Buffer.from(source).toString('base64') }) as Opened;
  const { items, edits } = linkedWork(opened);
  const samples = { 기관명: '견본 기관 & <값>', 담당자_이름: '견본 담당\n둘째 줄', 사업명: '견본 사업', 공고번호: '007', 설명: '견본 설명', 장소: '견본 장소', 추정가격: '1500000' };
  const saved = app.post('/api/workbench/save', { session: opened.session, ...blank, edits, inputItems: items, samples }) as any;
  const restored = app.post('/api/workbench/restore', { workspace: saved.workspace }) as any;
  assert.deepEqual(restored.inputItems, items); assert.deepEqual(restored.samples, samples); assert.deepEqual(restored.edits, edits);
  assert.equal(restored.dataInfo.records, 0);
  const r = app.post('/api/workbench/generate', { session: restored.session, ...blank, edits, inputItems: items, samples }) as any;
  assert.equal(r.ok, true);
  const all = texts(app.get('/api/workbench/result', new URLSearchParams({ session: restored.session }))!.body).join('\n');
  assert.equal(all.split('견본 담당').length - 1, 2, 'linked field (2 places)'); assert.equal(all.split('금액 1,500,000원').length - 1, 12); assert.equal(all.split('번호 007').length - 1, 6);
  assert.equal(all.split('견본 기관 & <값>').length - 1, 5, '4 fields + header'); assert(!all.includes('{{'));
  // 견본 값이 없는 키는 데이터에 없는 키와 같이 막힌다. 형식이 틀린 견본은 거절
  const { 설명: _gone, ...less } = samples;
  wrong(() => app.post('/api/workbench/generate', { session: restored.session, ...blank, edits, inputItems: items, samples: less }), 'DATA_MISSING');
  wrong(() => app.post('/api/workbench/generate', { session: restored.session, ...blank, edits, inputItems: items, samples: { 설명: 1 } }), 'WORKBENCH_INPUT');
  wrong(() => app.post('/api/workbench/generate', { session: restored.session, ...blank, edits, inputItems: items, samples: { '': 'x' } }), 'WORKBENCH_INPUT');
  // __proto__ 같은 키도 그냥 열이다(전역 객체를 건드리지 않는다)
  wrong(() => app.post('/api/workbench/generate', { session: restored.session, ...blank, edits, inputItems: items, samples: { '__proto__.x': 'y', '__proto__': 'z' } }), 'DATA_MISSING');
  assert.equal(({} as any).x, undefined);
});

test('#172 example template-v2: the amount gets "원" from display.unit exactly once', () => {
  const ex = new URL('../../../examples/template-v2/', import.meta.url), read = (f: string) => readFileSync(new URL(f, ex), 'utf8');
  const t = readStudioTemplate(read('template.json'), { hasBlob: () => true }) as StudioTemplate;
  assert.deepEqual(t.values.find(v => v.name === '추정가격')!.display, { unit: '원' });
  const blobs = new Map(readdirSync(new URL('blobs/', ex)).map(f => [f.replace(/\.json$/, ''), new Uint8Array(readFileSync(new URL('blobs/' + f, ex)))]));
  const r = generateFromTemplate(new Uint8Array(readFileSync(new URL('notice.hwpx', ex))), t, JSON.parse(read('data.json')), readCase(read('case.json'), t), sha => blobs.get(sha));
  assert(r.ok && !r.dryRun && r.output instanceof Uint8Array);
  const all = texts(r.output).join('\n');
  assert.equal(all.split('150,000,000원(부가가치세 포함)').length - 1, 1); assert(!all.includes('원원'));
});
