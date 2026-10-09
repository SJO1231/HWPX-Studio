// #180 #181 작업창 미리 보기 = Helper 2판 창구 글: 원문 {{키}}·누름틀의 금액·날짜와 지정 자리 날짜를 엔진 값 형식(8.8.4)으로 꾸미고,
// 원래 {{키}}가 있는 줄 안의 다른 글을 지정·확정해도 미리 보기가 막히지 않는다(TPL_CONFLICT 없음). 출력은 OS 임시 폴더에만 쓰고 지운다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareToBaseline, compileDocument, generateFromTemplate, openPackage, parseDocument, readStudioTemplate, validateDocument, walkParagraphs, type StudioTemplate } from '@hwpx-studio/engine';
import { buildHwpx, mutateEntryText, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { createWorkbench } from '../src/workbench.ts';
import { createG2B2 } from '../src/g2b-v2.ts';
import { confirmText, type InputItem } from '../src/input-table.ts';

type Row = { id: string; text: string };
type Opened = { session: string; paragraphs: Row[]; inputs: { kind: InputItem['origin']; name: string; row: string; start: number; end: number; usable: boolean }[] };
const texts = (bytes: Uint8Array) => parseDocument(openPackage(bytes)).sections.flatMap(s => [...walkParagraphs(s.paragraphs)].map(p => p.logicalText));
const blank = { index: 0, edits: [] as { id: string; text: string }[], headings: [], blocks: [] };
const TYPES: Record<string, InputItem['type']> = { 계약일: 'date', 금액: 'money', 추정가격: 'money', 보증금: 'money' };

/** 표에서 하는 그대로: 찾은 자리는 추천(키 = 이름, 타입은 표에서 고른 것), 지정 자리는 이름·키·타입을 적어 확정한다(줄마다 한꺼번에 {{키}}) */
function work(opened: Opened, picks: { row: (text: string) => boolean; text: (text: string) => string; key: string; type: InputItem['type'] }[]) {
  const items: InputItem[] = opened.inputs.map(x => ({ row: x.row, start: x.start, end: x.end, name: x.name.trim(), key: x.name.trim(), type: TYPES[x.name.trim()] ?? 'text', status: 'recommended', origin: x.kind }));
  const edits: { id: string; text: string }[] = [];
  for (const r of opened.paragraphs) {
    const own: InputItem[] = [];
    for (const p of picks) if (p.row(r.text)) {
      const value = p.text(r.text), start = r.text.indexOf(value); assert(start >= 0, value);
      own.push({ row: r.id, start, end: start + value.length, name: p.key, key: p.key, type: p.type, status: 'confirmed', origin: 'user' });
    }
    if (!own.length) continue;
    const result = confirmText(r.text, r.text, [], own.map(i => ({ start: i.start, end: i.end, key: i.key })));
    assert('text' in result); edits.push({ id: r.id, text: result.text }); items.push(...own);
  }
  return { items, edits };
}

test('#180 #181 #186 confirm sentences: source {{date}}·{{money}} read like the Helper window, a designated date keeps the source shape (2026. 1. 5. → 2027. 1. 5., 2025. 12. 31. → 2027. 01. 05.), and a span on a {{key}} line no longer hits TPL_CONFLICT', () => {
  const source = buildHwpx([[textPara('계약일 {{계약일}}'), textPara('금액 {{금액}}원'), textPara('공고일: 2026. 1. 5.'), textPara('사업 {{사업명}} 담당 홍길동'), textPara('마감일: 2025. 12. 31.')].join('')]);
  const app = createWorkbench(), opened = app.post('/api/workbench/open', { name: 'p.hwpx', content: Buffer.from(source).toString('base64') }) as Opened;
  const { items, edits } = work(opened, [
    { row: t => t.startsWith('공고일'), text: () => '2026. 1. 5.', key: '공고일', type: 'date' },
    { row: t => t.startsWith('사업'), text: () => '홍길동', key: '담당자', type: 'text' },
    { row: t => t.startsWith('마감일'), text: () => '2025. 12. 31.', key: '마감일', type: 'date' },
  ]);
  assert.deepEqual(edits.map(e => e.text), ['공고일: {{공고일}}', '사업 {{사업명}} 담당 {{담당자}}', '마감일: {{마감일}}']);
  const record = { 계약일: '2027-1-15', 금액: 1234000, 공고일: '20270105', 사업명: '사업 & <값>', 담당자: '담당 A', 마감일: '2027-01-05' };
  app.post('/api/workbench/data', { session: opened.session, name: 'd.json', content: JSON.stringify(record) });
  const r = app.post('/api/workbench/generate', { session: opened.session, ...blank, edits, inputItems: items }) as any;
  assert.equal(r.ok, true);
  const lite = texts(app.get('/api/workbench/result', new URLSearchParams({ session: opened.session }))!.body);
  // 원문 모양이 없는 {{계약일}}은 기본 YYYY. MM. DD., 지정 날짜는 원문 모양(한 자리 → M. D., 두 자리 → MM. DD.)
  assert.deepEqual(lite, ['계약일 2027. 01. 15.', '금액 1,234,000원', '공고일: 2027. 1. 5.', '사업 사업 & <값> 담당 담당 A', '마감일: 2027. 01. 05.']);
  // Helper가 쓰는 것과 같은 서식 판·엔진 2판 생성
  const { template } = app.post('/api/workbench/g2b-template', { session: opened.session, ...blank, edits, inputItems: items }) as any;
  assert.deepEqual(template.values.filter((v: any) => v.format === 'date').map((v: any) => [v.name, v.display?.pattern]), [['계약일', undefined], ['공고일', 'YYYY. M. D.'], ['마감일', 'YYYY. MM. DD.']]);
  const helper = generateFromTemplate(source, readStudioTemplate(JSON.stringify(template)) as StudioTemplate, record, undefined, () => undefined);
  assert(helper.ok && !helper.dryRun && helper.output instanceof Uint8Array, JSON.stringify(helper.report.issues));
  assert.deepEqual(texts(helper.output), lite);
  // 타입이 글이면(옛 작업 파일) 값 그대로
  app.post('/api/workbench/generate', { session: opened.session, ...blank, edits, inputItems: items.map(i => ({ ...i, type: 'text' })) });
  assert.deepEqual(texts(app.get('/api/workbench/result', new URLSearchParams({ session: opened.session }))!.body).slice(0, 3), ['계약일 2027-1-15', '금액 1234000원', '공고일: 20270105']);
  // 읽을 수 없는 날짜는 그대로 둔다(Helper는 INVALID_FIELDS)
  app.post('/api/workbench/data', { session: opened.session, name: 'd.json', content: JSON.stringify({ ...record, 계약일: '미정' }) });
  app.post('/api/workbench/generate', { session: opened.session, ...blank, edits, inputItems: items });
  assert.equal(texts(app.get('/api/workbench/result', new URLSearchParams({ session: opened.session }))!.body)[0], '계약일 미정');
});

/** 두 곳의 `{{금액}}`을 누름틀(이름 금액)로 바꾼 문서 */
function moneyFields(raw: Uint8Array): Uint8Array {
  const targets = [...walkParagraphs(parseDocument(openPackage(raw)).sections[0]!.paragraphs)].flatMap(p => {
    const at = p.logicalText.indexOf('{{금액}}');
    return at < 0 ? [] : [{ sectionIndex: 0, path: p.path, start: at, end: at + '{{금액}}'.length, name: '금액' }];
  });
  const compiled = compileDocument(raw, { mode: 'baseline', anchors: targets });
  assert(compiled.ok && compiled.report.promoted === 2, 'two fields');
  return compiled.output;
}

test('#186 "원" per place: one money key at found places whose next text differs ("원" or not), with a designated amount ending in "원" — preview = Helper, 원원 0, missing 원 0 (2 synthetic cases)', () => {
  // ① {{키}}: 뒤가 "원"인 자리가 먼저(고치기 전: 둘째 자리 "원" 빠짐) ② 누름틀: 뒤가 "원"이 아닌 자리가 먼저(고치기 전: 둘째 자리 원원)
  const cases: [string, Uint8Array][] = [
    ['{{키}}', buildHwpx([[textPara('앞 {{금액}}원 끝'), textPara('뒤 {{금액}} 끝'), textPara('지정 5,000원')].join('')])],
    ['누름틀', moneyFields(buildHwpx([[textPara('뒤 {{금액}} 끝'), textPara('앞 {{금액}}원 끝'), textPara('지정 5,000원')].join('')]))],
  ];
  for (const [label, source] of cases) {
    const app = createWorkbench(), opened = app.post('/api/workbench/open', { name: 'won.hwpx', content: Buffer.from(source).toString('base64') }) as Opened;
    assert.equal(opened.inputs.filter(x => x.name === '금액').length, 2, label);
    const { items, edits } = work(opened, [{ row: t => t.startsWith('지정'), text: () => '5,000원', key: '금액', type: 'money' }]);
    const record = { 금액: 1234000 };
    app.post('/api/workbench/data', { session: opened.session, name: 'd.json', content: JSON.stringify(record) });
    assert.equal((app.post('/api/workbench/generate', { session: opened.session, ...blank, edits, inputItems: items }) as any).ok, true);
    const lite = texts(app.get('/api/workbench/result', new URLSearchParams({ session: opened.session }))!.body);
    assert.deepEqual(lite.map(p => p.replaceAll('\uFFFC', '')).sort(), ['뒤 1,234,000원 끝', '앞 1,234,000원 끝', '지정 1,234,000원'], label);
    const { template } = app.post('/api/workbench/g2b-template', { session: opened.session, ...blank, edits, inputItems: items }) as any;
    const helper = generateFromTemplate(source, readStudioTemplate(JSON.stringify(template)) as StudioTemplate, record, undefined, () => undefined);
    assert(helper.ok && !helper.dryRun && helper.output instanceof Uint8Array, JSON.stringify(helper.report.issues));
    assert.deepEqual(texts(helper.output), lite, label);
    assert.deepEqual(app.get('/api/workbench/source', new URLSearchParams({ session: opened.session }))!.body, source);
  }
});

// 본문 12(계약일·담당 / 금액·추정가격 / 공고일·비고: 원래 {{키}}가 있는 줄 9개에 지정 자리), 누름틀 보증금 3, 표 칸 12(추정가격 "원" 6·마감일 6), 머리말 1(공고일)
function paritySource(): Uint8Array {
  const source = readFixture('hancom/header-footer'), s = parseDocument(openPackage(source)).sections[0]!, start = s.paragraphs[0]!.element.end;
  const body = Array.from({ length: 12 }, (_, i) => textPara([`본문 ${i} 계약일 {{계약일}} 담당 원래 담당 ${i}`, `본문 ${i} 금액 {{금액}}원 추정 {{추정가격}}원`, `본문 ${i} 공고일 2026. 1. 5. 비고 {{비고}}`][i % 3]!))
    .concat(Array.from({ length: 3 }, (_, i) => textPara(`보증 ${i} {{보증금}}`)));
  const cells = Array.from({ length: 3 }, (_, r) => Array.from({ length: 4 }, (_, c) => (r * 4 + c) % 2 ? `칸 ${r * 4 + c} 마감 2026. 2. 3.` : `칸 ${r * 4 + c} 추정 1,234,000원`));
  const raw = mutateEntryText(source, s.entryName, x => x.slice(0, start).replace('{{doc.title}}', '머리 공고일 2026. 3. 4.').replace('{{doc.owner}}', 'FOOTER_FIXED')
    + body.join('') + tableParagraph(gridTable([9000, 9000, 9000, 9000], 3, cells, { id: '3960' })) + textPara('OUTSIDE_FIXED') + x.slice(x.lastIndexOf('</hs:sec>')));
  const targets = [];
  for (const p of walkParagraphs(parseDocument(openPackage(raw)).sections[0]!.paragraphs)) {
    const m = /^보증 \d+ (\{\{보증금\}\})/.exec(p.logicalText);
    if (m) targets.push({ sectionIndex: 0, path: p.path, start: m.index + m[0].indexOf('{{'), end: m[0].length, name: '보증금' });
  }
  const compiled = compileDocument(raw, { mode: 'baseline', anchors: targets });
  assert(compiled.ok && compiled.report.promoted === 3, 'three fields');
  return compiled.output;
}

test('#180 #181 #186 end to end: 40 places (fields, {{keys}}, designated spans on {{key}} lines, cells, header; duplicates; long values) x 50 cases — workbench preview x2 equals the Helper 2판 window text, dryRun ok, new errors 0, source unchanged', async t => {
  const source = paritySource(), copy = Buffer.from(source), baseline = validateDocument(source), app = createWorkbench();
  const opened = app.post('/api/workbench/open', { name: 'parity.hwpx', content: Buffer.from(source).toString('base64') }) as Opened;
  const { items, edits } = work(opened, [
    { row: t => /^본문 \d+ 계약일/.test(t), text: t => /원래 담당 \d+/.exec(t)![0], key: '담당자', type: 'text' },
    { row: t => /^본문 \d+ 공고일/.test(t) || t.startsWith('머리 공고일'), text: t => /\d{4}\. \d\. \d\./.exec(t)![0], key: '공고일', type: 'date' },
    { row: t => /^칸 \d+ 추정/.test(t), text: () => '1,234,000원', key: '추정가격', type: 'money' },
    { row: t => /^칸 \d+ 마감/.test(t), text: () => '2026. 2. 3.', key: '마감일', type: 'date' },
  ]);
  const found = opened.inputs.length, mine = items.length - found;
  assert.equal(found, 4 + 8 + 4 + 3); // {{계약일}} 4 + {{금액}}·{{추정가격}} 8 + {{비고}} 4 + 보증금 누름틀 3
  assert.equal(mine, 4 + 4 + 1 + 6 + 6);
  assert.equal(edits.filter(e => /\{\{(계약일|금액|비고)\}\}/.test(e.text)).length, 8, 'designated spans on lines that already had {{key}}');
  let seed = 0x180181;
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const two = (n: number) => String(n).padStart(2, '0'), won = new Intl.NumberFormat('en-US');
  const date = () => { const y = 2020 + next(20), m = 1 + next(12), d = 1 + next(28); return { raw: [`${y}-${m}-${d}`, `${y}.${two(m)}.${two(d)}`, `${y}${two(m)}${two(d)}`, `${y}/${m}/${d}`][next(4)]!, shown: `${y}. ${two(m)}. ${two(d)}.`, short: `${y}. ${m}. ${d}.` }; };
  const money = () => { const n = next(2_000_000_000); return { raw: [n, String(n), won.format(n) + '원', '₩' + n][next(4)]!, shown: won.format(n) }; };
  const long = (i: number, k: string) => `${k} ${i}: ` + Array.from({ length: 4 + next(8) }, (_, j) => `긴 문장 ${j}은 값이 여러 문장임을 보인다.`).join(' ') + `\n둘째 줄 & <특수> "따옴표" '홑'\t탭 뒤`;
  const cases = Array.from({ length: 50 }, (_, i) => ({ 계약일: date(), 공고일: date(), 마감일: date(), 금액: money(), 추정가격: money(), 보증금: money(), 담당자: long(i, '담당'), 비고: long(i, '비고') }));
  const records = cases.map(c => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' ? v : v.raw])));
  app.post('/api/workbench/data', { session: opened.session, name: 'cases.json', content: JSON.stringify(records) });

  const { template, skipped } = app.post('/api/workbench/g2b-template', { session: opened.session, ...blank, edits, inputItems: items }) as any;
  assert.equal(skipped, 0);
  const root = mkdtempSync(join(tmpdir(), 'studio-parity-')), db = new DatabaseSync(join(root, 'g.sqlite'));
  try {
    const g = createG2B2(db), out = join(root, 'out');
    g.saveTemplate({ template, source: Buffer.from(source).toString('base64') });
    g.saveProfile({ id: 'parity', label: '같은 글', templateId: template.id, version: 1, outputDirectory: out });
    const request = (requestId: string, dryRun: boolean) => g.generate({ format: 'studio-generate', version: 2, requestId, profileId: 'parity', dryRun, items: records.map(values => ({ values })) });
    const dry = await request('dry', true);
    assert.equal(dry.status, 'success', JSON.stringify(dry.results.find(r => r.status !== 'success'))); assert.equal(readdirSync(out).length, 0);
    const real = await request('real', false);
    assert.equal(real.summary.succeeded, 50);
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
      const lite = texts(first!), all = lite.join('\n'), c = cases[index]!;
      assert.deepEqual(texts(helper), lite, 'case ' + index);
      assert.equal(lite.filter(p => p.includes(`계약일 ${c.계약일.shown} 담당 ${c.담당자.split('\n')[0]}`)).length, 4);
      assert.equal(lite.filter(p => p.includes(`금액 ${c.금액.shown}원 추정 ${c.추정가격.shown}원`)).length, 4, '"원" once after {{money}}');
      assert.equal(lite.filter(p => p.endsWith(`추정 ${c.추정가격.shown}원`)).length, 4 + 6, 'designated amount keeps one "원"');
      // 지정 날짜는 원문 모양(`2026. 1. 5.`·`2026. 2. 3.` → 월·일 한 자리, #186), 원문 모양이 없는 {{계약일}}은 기본 꼴
      assert.equal(lite.filter(p => p.includes(`공고일 ${c.공고일.short}`)).length, 4 + 1);
      assert.equal(lite.filter(p => p.endsWith(`마감 ${c.마감일.short}`)).length, 6);
      assert.equal(lite.filter(p => /^보증 \d \uFFFC/.test(p) && p.endsWith(` \uFFFC${c.보증금.shown}\uFFFC`)).length, 3, 'field');
      assert(!all.includes('{{') && !all.includes('원원'));
    }
    assert.equal(newErrors, 0); assert.equal(pairs, 50); assert.deepEqual(Buffer.from(source), copy);
    assert.deepEqual(app.get('/api/workbench/source', new URLSearchParams({ session: opened.session }))!.body, source);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  t.diagnostic(`seed=0x180181; places=${found + mine} (found ${found}, designated ${mine}); spans_on_key_lines=8; cases=50; workbench_generations=100; deterministic_pairs=50; helper_items=50 (dryRun 50 + real 50); text_equal=50; new_errors=0; source unchanged`);
});
