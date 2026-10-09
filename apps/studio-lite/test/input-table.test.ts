import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareToBaseline, isValidPath, openPackage, parseDocument, placeText, readTypedValue, validateDocument, walkParagraphs } from '@hwpx-studio/engine';
import { buildHwpx, mutateEntryText, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { createWorkbench } from '../src/workbench.ts';
import { createApp } from '../src/server.ts';
import {
  applyKeys, autoKey, changedSpan, confirmText, contextOf, isField, keptStatus, keyFor, mergeSaved, repsOf, samePlaceholder, spanNow, toCurrent, toOriginal, validKey, type InputItem,
} from '../src/input-table.ts';
import { suggestType as guess } from '../src/value-type.ts';
const suggestType = (name: string, text: string) => guess(text, name).type;

type Row = { id: string; sectionIndex: number; path: number[]; text: string; editable: boolean };
type Opened = { session: string; paragraphs: Row[]; inputs: { kind: string; name: string; row: string; start: number; end: number }[] };
const blank = { index: 0, edits: [] as { id: string; text: string }[], headings: [], blocks: [] };
const open = (app: ReturnType<typeof createWorkbench>, source: Uint8Array, name = 'synthetic.hwpx') => app.post('/api/workbench/open', { name, content: Buffer.from(source).toString('base64') }) as Opened;
const post = (app: ReturnType<typeof createWorkbench>, session: string, suffix: string, body: Record<string, unknown>) => app.post('/api/workbench/' + suffix, { session, ...body }) as any;
const wrong = (run: () => unknown, code: string) => assert.throws(run, (e: any) => e.code === code, code);
const output = (app: ReturnType<typeof createWorkbench>, session: string) => app.get('/api/workbench/result', new URLSearchParams({ session }))!.body;
const textAt = (bytes: Uint8Array, r: Row) => {
  const s = parseDocument(openPackage(bytes)).sections[r.sectionIndex]!;
  return [...walkParagraphs(s.paragraphs)].find(p => p.path.length === r.path.length && p.path.every((n, i) => n === r.path[i]))?.logicalText;
};

// 본문 12·표 칸 12·머리말 1 = 편집할 수 있는 줄 25(한컴 저장본 머리말·꼬리말 문서 바탕)
function denseSource() {
  const source = readFixture('hancom/header-footer'), d = parseDocument(openPackage(source)), s = d.sections[0]!;
  const start = s.paragraphs[0]!.element.end;
  const body = Array.from({ length: 12 }, (_, i) => textPara('본문 BODY_' + i + ' 사업명: 원래 값 ' + i));
  const cells = Array.from({ length: 3 }, (_, r) => Array.from({ length: 4 }, (_, c) => '칸 CELL_' + (r * 4 + c) + ' 금액 1,234,000원'));
  return mutateEntryText(source, s.entryName, x => x.slice(0, start).replace('{{doc.title}}', '머리 HEADER_EDIT 공고 번호').replace('{{doc.owner}}', 'FOOTER_FIXED')
    + body.join('') + tableParagraph(gridTable([9000, 9000, 9000, 9000], 3, cells, { id: '3960' })) + textPara('OUTSIDE_FIXED') + x.slice(x.lastIndexOf('</hs:sec>')));
}

test('input table model: key rule matches the engine, type and auto-key candidates, status and field rules', () => {
  for (const key of ['사업명', 'a.b', 'value_1', 'x-y', '공고.기관.이름', '', ' a', 'a b', 'a..b', '.a', 'a.', '{{a}}', 'a/b', '😀'])
    assert.equal(validKey(key), isValidPath(key), key);
  assert.equal(suggestType('사업명', '전산장비 구매'), 'text');
  for (const text of ['1,234,000원', '₩ 12,000', '5000원', '금 1,000,000원', '12,345.5']) assert.equal(suggestType('항목', text), 'money', text);
  // #147부터 날짜·전화·수량·시각도 따로 추천한다(표는 value-type 시험). 단위 없는 수는 글
  assert.deepEqual(['2026. 10. 7.', '02-123-4567', '5개', '100', '14:00'].map(t => suggestType('항목', t)), ['date', 'phone', 'quantity', 'text', 'time']);
  assert.equal(suggestType('추정 가격', ''), 'money');
  const keys = ['사업명', '예정금액', 'value'];
  assert.deepEqual(autoKey('사업명', '', false, keys), { key: '사업명', auto: true });
  assert.deepEqual(autoKey(' 사업명 ', '', false, keys), { key: '사업명', auto: true });
  assert.deepEqual(autoKey('사업 이름', '', false, keys), { key: '', auto: false });
  assert.deepEqual(autoKey('사업 이름', '사업명', true, keys), { key: '', auto: false }, 'auto key follows the name');
  assert.deepEqual(autoKey('예정금액', '사업명', false, keys), { key: '사업명', auto: false }, 'typed key is kept');
  assert.deepEqual(autoKey('사업명', '', false, []), { key: '', auto: false }, 'no data, no candidate');
  assert.equal(keptStatus('user'), 'designated'); assert.equal(keptStatus('placeholder'), 'recommended');
  assert(isField('clickHere') && isField('mailMerge') && !isField('placeholder') && !isField('user'));
  assert.equal(keyFor({ origin: 'clickHere', key: '필드' }, '표시 이름', 'other'), '필드');
  assert.equal(keyFor({ origin: 'user', key: '' }, '사업명', ''), '사업명');
  assert.equal(keyFor({ origin: 'user', key: '' }, '표시 이름', 'key_1'), 'key_1');
  assert(samePlaceholder('{{ 사업명 }}', '사업명') && !samePlaceholder('{{사업명}}', '기관명'));
  const long = '앞쪽 글이 아주 길게 이어지는 문장 사업명: 전산장비 구매 그리고 뒤쪽 글', ctx = contextOf(long, 20, 29, 6);
  assert.deepEqual(ctx, { before: '…' + long.slice(14, 20), target: long.slice(20, 29), after: long.slice(29, 35) + '…' });
  assert.deepEqual(contextOf('a\uFFFCb', 0, 3), { before: '', target: 'ab', after: '' });
});

test('input table positions: confirmed keys and free edits map both ways; overlaps and edited spans are refused (seeded 2000 cases)', t => {
  let seed = 0x146a;
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const letters = '가나다라마바사아자차카타파하 ,.:1234567890abc<>&';
  let checked = 0, refused = 0;
  for (let n = 0; n < 2000; n++) {
    const original = Array.from({ length: 10 + next(60) }, () => letters[next(letters.length)]).join('');
    // 겹치지 않는 확정 자리 몇 개와 그 뒤의 새 자리 하나
    const cuts = [...new Set(Array.from({ length: 2 + next(6) }, () => next(original.length + 1)))].sort((a, b) => a - b);
    const spans: { start: number; end: number }[] = [];
    for (let i = 0; i + 1 < cuts.length; i += 2) spans.push({ start: cuts[i]!, end: cuts[i + 1]! });
    if (spans.length < 1) continue;
    const target = spans.pop()!, existing = spans.filter(s => s.start < s.end).map((s, i) => ({ ...s, key: 'k' + i + '.값' }));
    if (target.start === target.end && existing.some(e => e.start === target.start || e.end === target.start)) continue;
    const current = applyKeys(original, existing);
    const result = confirmText(original, current, existing, [{ ...target, key: '새키' }]);
    assert('text' in result, 'confirm ' + n);
    assert.equal(result.text, applyKeys(original, [...existing, { ...target, key: '새키' }]));
    const now = toCurrent(original, current, existing, target.start, target.end)!;
    assert.equal(current.slice(now.start, now.end), original.slice(target.start, target.end));
    assert.deepEqual(toOriginal(original, current, existing, now.start, now.end), target);
    const after = [...existing, { ...target, key: '새키' }];
    assert.equal(result.text.slice(...Object.values(spanNow(original, result.text, after, target.start, target.end)!) as [number, number]), '{{새키}}');
    for (const e of existing) assert.equal(toCurrent(original, current, existing, e.start, e.end), undefined, 'a confirmed key is not a source span');
    if (existing[0]) { assert.deepEqual(confirmText(original, current, existing, [{ ...existing[0], key: 'dup' }]), { fail: 'overlap' }); refused++; }
    // 손으로 고친 곳: 바뀐 구간 밖은 옮기고, 걸치면 거절한다
    const editAt = next(original.length + 1), edited = original.slice(0, editAt) + '#★#' + original.slice(editAt);
    const before = { start: 0, end: Math.min(editAt, 2) }, inside = { start: Math.max(0, editAt - 1), end: Math.min(original.length, editAt + 1) };
    if (before.end > before.start) assert.deepEqual(toCurrent(original, edited, [], before.start, before.end), before);
    if (inside.start < editAt && inside.end > editAt) { assert.equal(toCurrent(original, edited, [], inside.start, inside.end), undefined); assert.deepEqual(confirmText(original, edited, [], [{ ...inside, key: 'x' }]), { fail: 'edited' }); refused++; }
    if (editAt + 2 <= original.length) {
      const tail = { start: editAt + 1, end: editAt + 2 }, moved = toCurrent(original, edited, [], tail.start, tail.end)!;
      assert.equal(edited.slice(moved.start, moved.end), original.slice(tail.start, tail.end));
      assert.deepEqual(toOriginal(original, edited, [], moved.start, moved.end), tail);
      const fixed = confirmText(original, edited, [], [{ ...tail, key: 'x' }]);
      assert('text' in fixed); assert.equal(fixed.text, edited.slice(0, moved.start) + '{{x}}' + edited.slice(moved.end));
    }
    checked++;
  }
  assert(checked > 1500 && refused > 500, `checked=${checked} refused=${refused}`);
  t.diagnostic(`seed=0x146a; cases=2000; checked=${checked}; refused=${refused}`);
});

test('input table restore merge: saved names/keys/statuses land on the same document candidates; user designations come back; missing ones are counted', () => {
  type Rec = InputItem & { id: string };
  const make = (x: InputItem): Rec => ({ ...x, id: x.origin + ':' + x.row + ':' + x.start + ':' + x.end });
  const base = (x: Partial<InputItem>): InputItem => ({ row: 'p:0:1', start: 0, end: 7, name: '사업명', key: '사업명', type: 'text', status: 'recommended', origin: 'placeholder', ...x });
  const candidates = [make(base({})), make(base({ row: 'p:0:2', origin: 'clickHere', name: '기관', key: '기관' }))];
  const saved = [base({ name: '사업 이름', status: 'confirmed' }), base({ row: 'p:0:2', origin: 'clickHere', name: '기관', key: '기관', status: 'excluded' }),
    base({ row: 'p:0:3', start: 2, end: 5, origin: 'user', name: '', key: '', status: 'designated' }), base({ row: 'p:0:9', origin: 'mailMerge' })];
  const { items, dropped } = mergeSaved(candidates, saved, make);
  assert.equal(dropped, 1); assert.equal(items.length, 3);
  assert.deepEqual(items.map(i => [i.name, i.key, i.status, i.origin]), [['사업 이름', '사업명', 'confirmed', 'placeholder'], ['기관', '기관', 'excluded', 'clickHere'], ['', '', 'designated', 'user']]);
  const items2 = [{ ...base({ status: 'confirmed' }) }, { ...base({ row: 'p:0:1', start: 9, end: 12, origin: 'user', key: 'a', status: 'confirmed' }) }];
  assert.deepEqual(repsOf(items2, 'p:0:1', '{{사업명}} 앞 xyz'), [{ start: 9, end: 12, key: 'a' }], 'same-key placeholder does not change text');
});

test('input table work file: 지정(이름 없이)·확정·제외 round-trip; malformed items are refused; old work files still open', () => {
  const source = denseSource(), app = createWorkbench(), opened = open(app, source);
  const rows = opened.paragraphs.filter(r => /BODY_|CELL_|HEADER_EDIT/.test(r.text));
  assert.equal(rows.length, 25); assert(rows.every(r => r.editable));
  const [a, b, c] = rows.filter(r => r.text.includes('BODY_')) as [Row, Row, Row];
  const items: InputItem[] = [
    { row: a.id, start: a.text.indexOf('원래'), end: a.text.length, name: '', key: '', type: 'text', status: 'designated', origin: 'user' },
    { row: b.id, start: b.text.indexOf('원래'), end: b.text.length, name: '사업명', key: '사업명', type: 'text', status: 'confirmed', origin: 'user' },
    { row: c.id, start: 0, end: 2, name: '제외한 곳', key: '', type: 'money', status: 'excluded', origin: 'user' },
  ];
  const edits = [{ id: b.id, text: applyKeys(b.text, [{ start: items[1]!.start, end: items[1]!.end, key: '사업명' }]) }];
  const saved = post(app, opened.session, 'save', { ...blank, edits, inputItems: items });
  const raw = JSON.parse(saved.workspace);
  assert.deepEqual(raw.inputItems, items);
  const restored = app.post('/api/workbench/restore', { workspace: saved.workspace }) as any;
  assert.deepEqual(restored.inputItems, items); assert.deepEqual(restored.edits, edits);
  // 원문은 그대로: 원문 주소의 글이 처음과 같다
  assert.deepEqual(app.get('/api/workbench/source', new URLSearchParams({ session: restored.session }))!.body, source);
  const old = { ...raw }; delete old.inputItems;
  assert.deepEqual((app.post('/api/workbench/restore', { workspace: JSON.stringify(old) }) as any).inputItems, []);
  const bad = (item: Record<string, unknown>, code: string) => wrong(() => app.post('/api/workbench/restore', { workspace: { ...raw, inputItems: [{ ...items[0], ...item }] } }), code);
  bad({ row: 'p:9:99' }, 'WORKBENCH_POSITION');
  bad({ start: 5, end: 4 }, 'WORKBENCH_POSITION');
  bad({ end: a.text.length + 1 }, 'WORKBENCH_POSITION');
  bad({ status: 'approved' }, 'WORKBENCH_INPUT');
  bad({ origin: 'guess' }, 'WORKBENCH_INPUT');
  bad({ type: 'datetime' }, 'WORKBENCH_INPUT');
  bad({ note: 'x' }, 'WORKBENCH_INPUT');
  bad({ name: 'x'.repeat(501) }, 'WORKBENCH_INPUT');
  bad({ status: 'confirmed', name: '', key: 'a' }, 'WORKBENCH_FIELD_NAME');
  bad({ status: 'confirmed', name: '이름', key: '공백 있는 키' }, 'WORKBENCH_FIELD_NAME');
  wrong(() => app.post('/api/workbench/restore', { workspace: { ...raw, inputItems: [items[0], items[0]] } }), 'WORKBENCH_DUPLICATE');
  // #146 작업 파일의 금액 타입 이름(amount)은 money로 읽는다(#147)
  assert.equal((app.post('/api/workbench/restore', { workspace: { ...raw, inputItems: [{ ...items[2], type: 'amount' }] } }) as any).inputItems[0].type, 'money');
  wrong(() => post(app, opened.session, 'generate', { ...blank, inputItems: 'x' }), 'WORKBENCH_INPUT');
  // 생성에는 쓰지 않는다: 지정·제외만 있으면 결과가 원문과 같은 글이다
  post(app, opened.session, 'generate', { ...blank, inputItems: [items[0], items[2]] });
  assert.equal(textAt(output(app, opened.session), a), a.text);
});

test('input table sample values: current record values by usable key; out-of-range and no-data records are refused', () => {
  const app = createWorkbench(), opened = open(app, denseSource());
  wrong(() => post(app, opened.session, 'sample', { index: 0 }), 'WORKBENCH_RECORD');
  post(app, opened.session, 'data', { name: 'data.json', content: JSON.stringify([{ 사업명: '첫째', 금액: 1200, nested: { a: '안쪽' }, 'bad key': 'x', long: '가'.repeat(300) }, { 사업명: '둘째', 금액: 0 }]) });
  const first = post(app, opened.session, 'sample', { index: 0 }), second = post(app, opened.session, 'sample', { index: 1 });
  assert.equal(first.values.사업명, '첫째'); assert.equal(first.values.금액, '1200'); assert.equal(first.values['nested.a'], '안쪽');
  assert.equal(first.values['bad key'], undefined); assert.equal(first.values.long.length, 200);
  assert.deepEqual(second.values, { 사업명: '둘째', 금액: '0' });
  wrong(() => post(app, opened.session, 'sample', { index: 2 }), 'WORKBENCH_RECORD');
  wrong(() => post(app, opened.session, 'sample', { index: -1 }), 'WORKBENCH_RECORD');
});

test('input table end to end: seeded 50 rounds designate dozens of places (body/cells/header, duplicate keys) → name/auto key → confirm → save/restore → generate x2; exact values, determinism, new errors 0, source unchanged', t => {
  const source = denseSource(), sourceCopy = Buffer.from(source), app = createWorkbench(), opened = open(app, source);
  const rows = opened.paragraphs.filter(r => /BODY_|CELL_|HEADER_EDIT/.test(r.text));
  const baseline = validateDocument(source);
  let seed = 0x146e2e;
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const keyPool = ['사업명', '금액', '공고번호', '기관.이름', 'value', 'value', '사업명'];
  const longValue = (i: number) => '값 ' + i + ': ' + Array.from({ length: 10 }, (_, k) => '긴 문장 ' + k + '은 줄바꿈과 탭을 지닌다.').join(' ') + '\n둘째 줄 & <특수> "따옴표" \'홑\'\t탭 😀';
  const records = Array.from({ length: 50 }, (_, i) => ({ 사업명: longValue(i), 금액: String(1000 * i), 공고번호: '00' + i, 기관: { 이름: '기관 ' + longValue(i).slice(0, 80) }, value: 'V' + i }));
  assert(records.every(r => r.사업명.length > 200));
  const info = post(app, opened.session, 'data', { name: 'data.json', content: JSON.stringify(records) });
  const paths = info.keys.filter((k: any) => k.usable).map((k: any) => k.path);
  let generated = 0, places = 0, autoKeys = 0, newErrors = 0, session = opened.session;
  for (let round = 0; round < 50; round++) {
    // 지정: 줄마다 0~2곳(같은 줄 두 곳 포함), 이름 없이
    const items: InputItem[] = [];
    for (const r of rows) {
      const count = next(3), cut = r.text.indexOf(' ', 3);
      const spans = count === 2 ? [{ start: 0, end: 2 }, { start: cut + 1, end: r.text.length }] : count === 1 ? [{ start: cut + 1, end: cut + 1 + next(r.text.length - cut) }] : [];
      for (const s of spans) items.push({ row: r.id, ...s, name: '', key: '', type: 'text', status: 'designated', origin: 'user' });
    }
    // 표에서 이름 적기: 데이터 키와 같은 이름은 키가 자동, 다른 이름은 키를 직접
    for (const item of items) {
      const want = keyPool[next(keyPool.length)]!, display = next(4) === 0 ? want + ' 표시' : want;
      item.name = display; item.type = suggestType(display, '');
      const a = autoKey(display, '', false, paths);
      if (a.auto) { autoKeys++; item.key = a.key; } else { assert.equal(a.key, ''); item.key = want; }
    }
    // ✓ 전체: 줄마다 한꺼번에 {{키}}
    const edits: { id: string; text: string }[] = [];
    for (const r of rows) {
      const mine = items.filter(i => i.row === r.id);
      if (!mine.length) continue;
      const result = confirmText(r.text, r.text, [], mine.map(i => ({ start: i.start, end: i.end, key: i.key })));
      assert('text' in result, 'confirm ' + r.id);
      edits.push({ id: r.id, text: result.text });
      for (const i of mine) i.status = 'confirmed';
    }
    places += items.length;
    // 세션은 8개까지만 남으므로 늘 마지막으로 되살린 작업에서 저장한다(데이터도 작업 파일에 함께 간다)
    const saved = post(app, session, 'save', { ...blank, edits, inputItems: items });
    const restored = app.post('/api/workbench/restore', { workspace: saved.workspace }) as any; session = restored.session;
    assert.deepEqual(restored.inputItems, items); assert.deepEqual(restored.edits, edits);
    const index = next(50), record = records[index]!;
    const value = (key: string) => key === '기관.이름' ? record.기관.이름 : String((record as Record<string, unknown>)[key]);
    let first: Uint8Array | undefined;
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = post(app, restored.session, 'generate', { ...blank, index, edits, inputItems: items });
      assert.equal(result.ok, true); assert.equal(result.filled, edits.length);
      const bytes = output(app, restored.session);
      if (first) assert.deepEqual(bytes, first); else first = bytes;
      for (const r of rows) {
        const mine = items.filter(i => i.row === r.id).sort((x, y) => x.start - y.start);
        // 금액 이름(금액)의 항목은 엔진 값 형식(#181): Helper 서식 판처럼 키마다 첫 지정의 타입, "원"으로 끝나는 지정 글이 있으면 단위 "원"(빈 지정은 서식 판에서 빠진다)
        let expected = '', at = 0;
        for (const i of mine) { expected += r.text.slice(at, i.start) + shown(items, i, value(i.key), rows); at = i.end; }
        assert.equal(textAt(bytes, r), expected + r.text.slice(at), 'round ' + round + ' ' + r.id);
      }
      const cmp = compareToBaseline(baseline, validateDocument(bytes)); newErrors += cmp.newErrors.length;
      generated++;
    }
  }
  assert.equal(newErrors, 0); assert.equal(generated, 100); assert(places > 500, 'places ' + places); assert(autoKeys > 200, 'auto ' + autoKeys);
  assert.deepEqual(Buffer.from(source), sourceCopy);
  t.diagnostic(`seed=0x146e2e; rounds=50; rows=25; places=${places}; auto_keys=${autoKeys}; generations=${generated}; deterministic_pairs=50; new_errors=${newErrors}; source unchanged`);
});

test('input table format check: in a mixed-format paragraph only a one-format span may become {{key}}; the check matches generation', () => {
  // 라벨(글자 모양 0)과 값(글자 모양 1)이 한 문단: 값만 고르면 생성되고, 둘에 걸치면 미리 거절된다
  const two = (label: string, value: string) => textPara(label).replace('</hp:p>', '<hp:run charPrIDRef="1"><hp:t>' + value + '</hp:t></hp:run></hp:p>');
  const source = buildHwpx([two('사업명: ', '전산장비 구매') + two('기관: ', '예시 기관') + textPara('한 모양 문단 값') + textPara('OUTSIDE_FIXED')]);
  const app = createWorkbench(), opened = open(app, source);
  const [a, b, plain] = opened.paragraphs as [Row & { rangeEditable: boolean }, Row & { rangeEditable: boolean }, Row & { rangeEditable: boolean }];
  assert.equal(a.rangeEditable, false); assert.equal(plain.rangeEditable, true);
  const check = (r: Row, start: number, end: number) => post(app, opened.session, 'check-input', { row: r.id, start, end });
  const value = a.text.indexOf('전산장비');
  assert.deepEqual(check(a, value, a.text.length), { ok: true });
  assert.deepEqual(check(a, 0, a.text.length), { ok: false, code: 'FILL_MIXED_FORMAT' });
  assert.deepEqual(check(a, value - 2, value + 2), { ok: false, code: 'FILL_MIXED_FORMAT' });
  assert.deepEqual(check(plain, 0, plain.text.length), { ok: true });
  wrong(() => check(a, 3, 2), 'WORKBENCH_POSITION'); wrong(() => check(a, 0, 99), 'WORKBENCH_POSITION');
  post(app, opened.session, 'data', { name: 'data.json', content: JSON.stringify({ 사업명: '새 사업 & <값>', 기관: '새 기관' }) });
  // 같은 판정: 검사가 통과한 구간은 생성되고, 거절한 구간은 생성도 거절된다
  const gen = (r: Row, start: number, end: number, key: string) => () => post(app, opened.session, 'generate', { ...blank, edits: [{ id: r.id, text: applyKeys(r.text, [{ start, end, key }]) }] });
  gen(a, value, a.text.length, '사업명')();
  assert.equal(textAt(output(app, opened.session), a), '사업명: 새 사업 & <값>');
  wrong(gen(a, 0, a.text.length, '사업명'), 'FILL_MIXED_FORMAT');
  // 한 줄에 둘을 확정하면 바뀐 한 구간이 두 모양에 걸친다 → 검사가 미리 거절한다
  const label = { start: 0, end: 3, key: '라벨' }, both = confirmText(b.text, b.text, [], [label, { start: b.text.indexOf('예시'), end: b.text.length, key: '기관' }]);
  assert('text' in both);
  const span = changedSpan(b.text, both.text)!;
  assert.deepEqual(check(b, span.start, span.end), { ok: false, code: 'FILL_MIXED_FORMAT' });
  assert.equal(changedSpan('같음', '같음'), undefined);
  assert.deepEqual(app.get('/api/workbench/source', new URLSearchParams({ session: opened.session }))!.body, source);
});

test('input table HTTP: the browser module is the same code after type stripping', async () => {
  const server = createApp(), base = await new Promise<string>(done => server.listen(0, '127.0.0.1', () => done('http://127.0.0.1:' + (server.address() as any).port)));
  const dir = mkdtempSync(join(tmpdir(), 'lite-input-table-'));
  try {
    const response = await fetch(base + '/input-table.js');
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /javascript/);
    const file = join(dir, 'input-table.mjs'); writeFileSync(file, await response.text());
    const served = await import(pathToFileURL(file).href);
    assert.equal(served.applyKeys('사업명: 원래', [{ start: 5, end: 7, key: '사업명' }]), '사업명: {{사업명}}');
    assert.deepEqual(served.confirmText('ab cd', 'ab cd', [], [{ start: 3, end: 5, key: 'k' }]), { text: 'ab {{k}}' });
    assert.deepEqual(served.autoKey('사업명', '', false, ['사업명']), { key: '사업명', auto: true });
    assert.equal(served.validKey('a b'), false);
    assert.equal(served.rankKeys(['a', '금액'], { name: '금액' })[0], '금액');
    // 타입 모듈(#147)도 형만 지운 같은 코드다
    const types = await fetch(base + '/value-type.js');
    assert.equal(types.status, 200); assert.match(types.headers.get('content-type') ?? '', /javascript/);
    const typeFile = join(dir, 'value-type.mjs'); writeFileSync(typeFile, await types.text());
    const typed = await import(pathToFileURL(typeFile).href);
    assert.deepEqual(typed.suggestType('5개'), { type: 'quantity', unit: '개' });
    assert.equal(typed.decorateValue('quantity', '1200', '1,000부', ''), '1,200부');
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

// 타입 꾸밈(#147)용 합성 문서: 본문 12·표 칸 12·머리말 1 = 25줄에 금액·날짜(세 모양)·수량·전화·글이 섞여 있다(한컴 저장본 머리말·꼬리말 문서 바탕)
const TYPED_BODY = ['#번 금액 1,234,000원, 신청일 2026. 10. 7., 수량 5개', '#번 연락처 02-123-4567, 담당 홍길동, 일자 2026-10-07', '#번 계약 2026년 10월 7일 금 2,500,000원 (부가세 포함)'];
const TYPED_CELLS = ['칸 금액 1,234,000원', '칸 2026. 10. 7.', '칸 5개 · 02-123-4567', '칸 2026-10-07 홍길동'];
function typedSource() {
  const source = readFixture('hancom/header-footer'), d = parseDocument(openPackage(source)), s = d.sections[0]!;
  const start = s.paragraphs[0]!.element.end;
  const body = Array.from({ length: 12 }, (_, i) => textPara(TYPED_BODY[i % 3]!.replace('#', String(i))));
  const cells = Array.from({ length: 3 }, (_, r) => Array.from({ length: 4 }, (_, c) => TYPED_CELLS[(r + c) % 4]!));
  return mutateEntryText(source, s.entryName, x => x.slice(0, start).replace('{{doc.title}}', '머리 금액 1,234,000원 · 2026. 10. 7.').replace('{{doc.owner}}', 'FOOTER_FIXED')
    + body.join('') + tableParagraph(gridTable([9000, 9000, 9000, 9000], 3, cells, { id: '3960' })) + textPara('OUTSIDE_FIXED') + x.slice(x.lastIndexOf('</hs:sec>')));
}
/** 지정 자리 값의 기대 글: 금액은 Helper 서식 판과 같은 값 표로 엔진 형식(키마다 첫 지정의 타입, "원"으로 끝나는 지정 글이 하나라도 있으면 단위 "원", 빈 지정은 빠진다) */
function shown(items: readonly InputItem[], i: InputItem, value: string, rows: readonly Row[]): string {
  const rowText = (x: InputItem) => rows.find(r => r.id === x.row)!.text, placed = items.filter(x => x.start < x.end && x.status !== 'excluded' && x.name.trim());
  if (placed.find(x => x.key === i.key)?.type !== 'money') return value;
  const unit = placed.some(x => x.key === i.key && /원\s*$/u.test(rowText(x).slice(x.start, x.end))) ? '원' : undefined, t = readTypedValue('money', value, unit ? { unit } : {});
  return t.ok ? placeText(t.text, unit, rowText(i).slice(i.end)) : value;
}
const PLACES: [RegExp, 'money' | 'date' | 'quantity' | 'phone' | 'text'][] = [
  [/\d{1,3}(?:,\d{3})+원/g, 'money'], [/\d{4}(?:\. \d{1,2}\. \d{1,2}\.|-\d{2}-\d{2}|년 \d{1,2}월 \d{1,2}일)/g, 'date'], [/\d+개/g, 'quantity'], [/0\d{1,2}-\d{3,4}-\d{4}/g, 'phone'], [/홍길동/g, 'text'],
];

test('type decoration end to end: seeded 50 rounds over 25 rows (body/cells/header) — amount commas with one 원, dates in the engine form (#181), units, phones as given; determinism, new errors 0, source unchanged', t => {
  const source = typedSource(), sourceCopy = Buffer.from(source), baseline = validateDocument(source);
  const app = createWorkbench(), opened = open(app, source);
  const rows = opened.paragraphs.filter(r => r.editable && PLACES.some(([re]) => new RegExp(re.source).test(r.text)));
  assert.equal(rows.length, 25);
  let seed = 0x147d;
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const won = new Intl.NumberFormat('en-US');
  const two = (n: number) => String(n).padStart(2, '0');
  let places = 0, generated = 0, newErrors = 0, session = opened.session;
  const counts: Record<string, number> = {};
  for (let round = 0; round < 50; round++) {
    const items: InputItem[] = [], data: Record<string, unknown> = {}, expected = new Map<string, { start: number; end: number; text: string }[]>();
    for (const r of rows) {
      const spans: { start: number; end: number; key: string; text: string; type: InputItem['type'] }[] = [];
      for (const [re, type] of PLACES) for (const m of r.text.matchAll(re)) {
        if (next(10) < 3) continue;
        // 금액은 "원"까지 고르거나 수만 고른다(그러면 자리 바로 뒤가 "원")
        const withWon = type !== 'money' || next(2) === 0, start = m.index, end = start + m[0].length - (withWon ? 0 : 1), key = `${type}_${places}`;
        let value: unknown, text: string;
        if (type === 'money') { const n = 1 + next(2_000_000_000); value = [n, String(n), n + '원'][next(3)]; text = won.format(n) + (withWon ? '원' : ''); }
        else if (type === 'date') {
          const y = 2020 + next(20), mo = 1 + next(12), da = 1 + next(28);
          value = [`${y}-${two(mo)}-${two(da)}`, `${y}.${mo}.${da}`, `${y}년 ${mo}월 ${da}일`, `${y}${two(mo)}${two(da)}`][next(4)];
          // 엔진 날짜 형식(Helper와 같은 YYYY. MM. DD.). 엔진이 읽지 못하는 꼴(`2026년 1월 5일`)은 받은 그대로
          text = (value as string).includes('년') ? value as string : `${y}. ${two(mo)}. ${two(da)}.`;
        } else if (type === 'quantity') { const k = 1 + next(5000); value = String(k); text = k + '개'; }
        else if (type === 'phone') { value = ['0' + (2 + next(6)) + '-' + (100 + next(900)) + '-' + (1000 + next(9000)), '010' + String(next(1e8)).padStart(8, '0'), '0212345678'][next(3)]; text = value as string; }
        else { value = '김' + next(100) + ' & <값> ' + 'ㄱ'.repeat(next(200)); text = value as string; }
        // 타입은 원문 모양으로 추천한 그대로(사람이 고르지 않음)
        const guessType = guess(r.text.slice(start, end)).type;
        assert.equal(guessType, type, `${type} ${r.text.slice(start, end)}`);
        data[key] = value; spans.push({ start, end, key, text, type: guessType }); places++; counts[type] = (counts[type] ?? 0) + 1;
      }
      for (const sp of spans) items.push({ row: r.id, start: sp.start, end: sp.end, name: sp.key, key: sp.key, type: sp.type, status: 'confirmed', origin: 'user' });
      expected.set(r.id, spans);
    }
    const edits: { id: string; text: string }[] = [];
    for (const r of rows) {
      const mine = items.filter(i => i.row === r.id);
      if (!mine.length) continue;
      const result = confirmText(r.text, r.text, [], mine.map(i => ({ start: i.start, end: i.end, key: i.key })));
      assert('text' in result); edits.push({ id: r.id, text: result.text });
    }
    post(app, session, 'data', { name: 'data.json', content: JSON.stringify(data) });
    const saved = post(app, session, 'save', { ...blank, edits, inputItems: items });
    const restored = app.post('/api/workbench/restore', { workspace: saved.workspace }) as any; session = restored.session;
    let first: Uint8Array | undefined;
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = post(app, session, 'generate', { ...blank, edits, inputItems: items });
      assert.equal(result.ok, true);
      const bytes = output(app, session);
      if (first) assert.deepEqual(bytes, first); else first = bytes;
      for (const r of rows) {
        let want = '', at = 0;
        for (const sp of [...expected.get(r.id)!].sort((x, y) => x.start - y.start)) { want += r.text.slice(at, sp.start) + sp.text; at = sp.end; }
        const got = textAt(bytes, r);
        assert.equal(got, want + r.text.slice(at), `round ${round} ${r.id}`);
        assert(!got!.includes('원원'), 'no doubled 원');
      }
      newErrors += compareToBaseline(baseline, validateDocument(bytes)).newErrors.length; generated++;
    }
  }
  assert.equal(newErrors, 0); assert.equal(generated, 100); assert(places > 1500, 'places ' + places);
  assert.deepEqual(Buffer.from(source), sourceCopy);
  t.diagnostic(`seed=0x147d; rounds=50; rows=25; places=${places} (${Object.entries(counts).map(([k, v]) => k + ' ' + v).join(', ')}); generations=${generated}; deterministic_pairs=50; new_errors=${newErrors}; source unchanged`);
});

test('type decoration: the confirm sentences (1234000 → 1,234,000원 once; date in the engine form like Helper, #181; leading zeros stay), a user-chosen type, TXT too, and only places confirmed in the workbench', () => {
  const source = buildHwpx([[textPara('금액: 1,000원'), textPara('계약 금액 5,000,000 원정'), textPara('신청일: 2026. 10. 7.'), textPara('전화: 02-123-4567'), textPara('식별: 0101011234567'), textPara('원래 자리 {{총액}}원'), textPara('그대로 2026-10-07')].join('')]);
  const app = createWorkbench(), opened = open(app, source), [money, money2, date, phone, id, holder, plainDate] = opened.paragraphs as Row[];
  const item = (r: Row, value: string, key: string, type: InputItem['type'], extra: Partial<InputItem> = {}): InputItem => {
    const start = r.text.indexOf(value);
    return { row: r.id, start, end: start + value.length, name: key, key, type, status: 'confirmed', origin: 'user', ...extra };
  };
  const items = [item(money!, '1,000원', '금액', 'money'), item(money2!, '5,000,000', '계약금액', 'money'), item(date!, '2026. 10. 7.', '신청일', 'date'), item(phone!, '02-123-4567', '전화', 'phone'), item(id!, '0101011234567', '식별', 'text'),
    // 사람이 글로 바꾼 날짜: 꾸미지 않는다
    item(plainDate!, '2026-10-07', '일자', 'text', { typeSet: true })];
  const edits = (opened.paragraphs as Row[]).filter(r => items.some(i => i.row === r.id)).map(r => {
    const mine = items.filter(i => i.row === r.id), result = confirmText(r.text, r.text, [], mine.map(i => ({ start: i.start, end: i.end, key: i.key })));
    assert('text' in result); return { id: r.id, text: result.text };
  });
  post(app, opened.session, 'data', { name: 'data.json', content: JSON.stringify({ 금액: 1234000, 계약금액: '7000000원', 신청일: '2026-11-02', 전화: '0212345678', 식별: '0101011234567', 일자: '2026-11-02', 총액: 1234000 }) });
  post(app, opened.session, 'generate', { ...blank, edits, inputItems: items });
  const out = output(app, opened.session);
  assert.deepEqual([money, money2, date, phone, id, holder, plainDate].map(r => textAt(out, r!)),
    ['금액: 1,234,000원', '계약 금액 7,000,000 원정', '신청일: 2026. 11. 02.', '전화: 0212345678', '식별: 0101011234567', '원래 자리 1234000원', '그대로 2026-11-02']);
  // 같은 편집인데 타입이 글이면(옛 작업 파일 포함) 값 그대로
  post(app, opened.session, 'generate', { ...blank, edits, inputItems: items.map(i => ({ ...i, type: 'text' })) });
  assert.equal(textAt(output(app, opened.session), money!), '금액: 1234000');
  // TXT
  const txt = app.post('/api/workbench/open', { name: 'a.txt', content: Buffer.from('금액: 1,000원\n날짜 2026년 10월 7일 마감\n수량 3 명').toString('base64') }) as Opened;
  const [l1, l2, l3] = txt.paragraphs as Row[];
  const titems = [item(l1!, '1,000', '금액', 'money'), item(l2!, '2026년 10월 7일', '날짜', 'date'), item(l3!, '3 명', '수량', 'quantity')];
  const tedits = titems.map(i => { const r = (txt.paragraphs as Row[]).find(x => x.id === i.row)!, res = confirmText(r.text, r.text, [], [{ start: i.start, end: i.end, key: i.key }]); assert('text' in res); return { id: r.id, text: res.text }; });
  post(app, txt.session, 'data', { name: 'data.json', content: JSON.stringify({ 금액: '2500000원', 날짜: '2026-01-05', 수량: 12 }) });
  assert.equal(post(app, txt.session, 'generate', { ...blank, edits: tedits, inputItems: titems }).text, '금액: 2,500,000원\n날짜 2026. 01. 05. 마감\n수량 12 명');
});
