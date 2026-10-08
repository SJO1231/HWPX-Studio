import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara, type TableSpec } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { createWorkbench } from '../src/workbench.ts';
import { colonLabelBefore } from '../src/item-label.ts';
import {
  commitConfirm, contextAround, designated, dropRow, itemOf, labelName, linkNote, planConfirm, rankKeys, refind, rowAria, type InputItem, type ItemLabel,
} from '../src/input-table.ts';

type Row = { id: string; text: string; editable: boolean };
type Opened = { session: string; paragraphs: Row[]; inputs: { kind: string; name: string; row: string; start: number; end: number; label?: ItemLabel }[] };
const open = (app: ReturnType<typeof createWorkbench>, source: Uint8Array) => app.post('/api/workbench/open', { name: 'labels.hwpx', content: Buffer.from(source).toString('base64') }) as Opened;
const post = (app: ReturnType<typeof createWorkbench>, session: string, suffix: string, body: Record<string, unknown>) => app.post('/api/workbench/' + suffix, { session, ...body }) as any;
const wrong = (run: () => unknown, code: string) => assert.throws(run, (e: any) => e.code === code, code);
const L = (text: string, rel: ItemLabel['rel'], distance: number): ItemLabel => ({ text, rel, distance });

// 라벨 판정용 합성 문서: `라벨:` 문단 12곳, 머리 칸 표 10곳(행 병합 2), 제목만 있는 곳 13곳(문장 칸 1), 칸 안 `라벨:` 1곳, 찾은 자리 2곳
const COLON: [string, string, ItemLabel][] = [];
for (let i = 0; i < 3; i++) {
  COLON.push([`사업명: 전산장비 구매 ${i}`, `전산장비 구매 ${i}`, L('사업명', 'colon', 1)]);
  COLON.push([`가. 기관명 : 예시 기관 ${i}`, `예시 기관 ${i}`, L('가. 기관명', 'colon', 1)]);
  COLON.push([`○ 담당: 홍길동${i}, 연락처: 02-123-456${i}`, `02-123-456${i}`, L('연락처', 'colon', 1)]);
  COLON.push([`신청일:  2026. 10. ${i + 1}.`, `2026. 10. ${i + 1}.`, L('신청일', 'colon', 2)]);
}
const TABLE: [string, string][] = [['사업명', '값 A0'], ['금액', '1,234,000원'], ['기관', '값 A1'], ['전화', '02-123-4567'], ['납품 장소', '값 A2'], ['수량', '5개'], ['신청일', '2026. 10. 7.'], ['비고', '없음']];
function labelSource() {
  const spanned: TableSpec = { rowCnt: 2, colCnt: 2, cells: [
    { row: 0, col: 0, rowSpan: 2, width: 9000, height: 2000, text: '담당자' }, { row: 0, col: 1, width: 9000, height: 1000, text: '홍길동' }, { row: 1, col: 1, width: 9000, height: 1000, text: '010-1234-5678' }] };
  return buildHwpx([[
    textPara('1. 사업 개요'), ...COLON.map(([text]) => textPara(text)),
    textPara('2. 표 자리'),
    tableParagraph(gridTable([9000, 9000, 9000, 9000], 4, [0, 2, 4, 6].map(i => [TABLE[i]![0], TABLE[i]![1], TABLE[i + 1]![0], TABLE[i + 1]![1]]))),
    tableParagraph(spanned),
    tableParagraph(gridTable([9000, 9000], 1, [['다음과 같이 신청합니다.', '값 C0']])),
    tableParagraph(gridTable([3000, 9000], 2, [['1', '목적: 예시 목적'], ['계약 금액', '{{계약금액}}']])),
    textPara('3. 기타'), ...Array.from({ length: 12 }, (_, i) => textPara(`예시 값 ${i} 입니다`)),
    textPara('공고일: {{공고일}}'),
  ].join('')]);
}

test('item labels: colon 12 · row header 10 (row span) · heading 13; nearest first (a colon in the cell beats the row header); found places carry labels', t => {
  const app = createWorkbench(), opened = open(app, labelSource()), rows = opened.paragraphs;
  const at = (rowText: string, value: string) => {
    const r = rows.find(x => x.text === rowText);
    assert(r, rowText);
    const start = r.text.lastIndexOf(value);
    return { row: r.id, start, end: start + value.length };
  };
  const ask = (rowText: string, value: string) => post(app, opened.session, 'item-label', at(rowText, value)).label as ItemLabel | undefined;
  const hits = { colon: 0, rowHeader: 0, heading: 0 };
  for (const [text, value, want] of COLON) { assert.deepEqual(ask(text, value), want, text); hits.colon++; }
  // 같은 문단 두 라벨: 앞 값은 앞 라벨
  assert.deepEqual(ask('○ 담당: 홍길동0, 연락처: 02-123-4560', '홍길동0'), L('○ 담당', 'colon', 1));
  for (const [label, value] of TABLE) { assert.deepEqual(ask(value, value), L(label, 'rowHeader', 1), value); hits.rowHeader++; }
  for (const value of ['홍길동', '010-1234-5678']) { assert.deepEqual(ask(value, value), L('담당자', 'rowHeader', 1), value); hits.rowHeader++; }
  // 왼쪽 칸이 문장이면 머리 칸이 아니다 → 위 제목
  const tableRows = rows.findIndex(r => r.text === '2. 표 자리');
  assert.deepEqual(ask('값 C0', '값 C0'), L('2. 표 자리', 'heading', rows.findIndex(r => r.text === '값 C0') - tableRows)); hits.heading++;
  // 칸 안의 `라벨:`이 왼쪽 머리 칸("1")보다 가깝다
  assert.deepEqual(ask('목적: 예시 목적', '예시 목적'), L('목적', 'colon', 1));
  const third = rows.findIndex(r => r.text === '3. 기타');
  for (let i = 0; i < 12; i++) { assert.deepEqual(ask(`예시 값 ${i} 입니다`, `값 ${i}`), L('3. 기타', 'heading', i + 1)); hits.heading++; }
  // 라벨이 없는 곳: 첫 제목 위
  assert.equal(ask('1. 사업 개요', '사업'), undefined);
  // 찾은 자리(문서의 {{키}})도 라벨을 달고 온다
  const found = Object.fromEntries(opened.inputs.map(x => [x.name, x.label]));
  assert.deepEqual(found.계약금액, L('계약 금액', 'rowHeader', 1));
  assert.deepEqual(found.공고일, L('공고일', 'colon', 1));
  // 잘못된 자리
  wrong(() => post(app, opened.session, 'item-label', { row: 'p:9:9', start: 0, end: 1 }), 'WORKBENCH_POSITION');
  wrong(() => post(app, opened.session, 'item-label', { ...at('비고', '비고'), end: 99 }), 'WORKBENCH_POSITION');
  assert(third > 0);
  t.diagnostic(`colon=${hits.colon}/12; rowHeader=${hits.rowHeader}/10; heading=${hits.heading}/13; misses=0`);
});

test('colon labels: only the first place right after `label:` (spaces between), spaced labels, field marks', () => {
  const at = (text: string, value: string, from = 0) => colonLabelBefore(text, text.indexOf(value, from));
  const range = '① 접수 기간: 2026. 1. 5. 09:00 ~ 2026. 1. 9. 18:00';
  assert.deepEqual(at(range, '2026. 1. 5.'), L('① 접수 기간', 'colon', 1));
  for (const v of ['09:00', '2026. 1. 9.', '18:00']) assert.equal(at(range, v), undefined, v + ': not the first place after the colon');
  assert.equal(at('신청인: 홍길동 (예시 주식회사)', '예시 주식회사'), undefined, 'the second value of one label gets none');
  assert.deepEqual(at('개찰 10:00 ~ 마감 시각: 18:00', '18:00'), L('마감 시각', 'colon', 1), 'cut after ~');
  assert.deepEqual(at(' 신  청  기  관:  \uFFFC{{신청기관}}', '{{신청기관}}'), L('신 청 기 관', 'colon', 2), 'spaced label, field mark ignored');
  assert.deepEqual(at(' 품 목 및 규 격:  \uFFFC{{품목}}\uFFFC\uFFFC{{규격}}', '{{품목}}'), L('품 목 및 규 격', 'colon', 2));
  assert.equal(at(' 품 목 및 규 격:  \uFFFC{{품목}}\uFFFC\uFFFC{{규격}}', '{{규격}}'), undefined);
  assert.equal(at('참고: ' + '가'.repeat(41) + ' 값', '값'), undefined, 'text between the colon and the place');
  assert.equal(at('시작 10:00 끝 값', '값'), undefined, 'only time colons');
  assert.equal(at('이 문장은 길게 이어지는 설명입니다: 값', '값'), undefined, 'a sentence is not a label');
  assert.equal(labelName('신 청 기 관'), '신청기관'); assert.equal(labelName('품 목 및 규 격'), '품목및규격'); assert.equal(labelName('① 접수 기간'), '접수 기간');
});

test('item labels on TXT: colon labels only (no tables or headings)', () => {
  const app = createWorkbench();
  const opened = app.post('/api/workbench/open', { name: 'a.txt', content: Buffer.from('제목\n사업명: 예시 사업\n그냥 줄').toString('base64') }) as Opened;
  const r = opened.paragraphs[1]!, plain = opened.paragraphs[2]!;
  assert.deepEqual(post(app, opened.session, 'item-label', { row: r.id, start: 5, end: r.text.length }).label, L('사업명', 'colon', 1));
  assert.deepEqual(post(app, opened.session, 'item-label', { row: plain.id, start: 3, end: 4 }), {});
});

test('item context and helpers: 60 chars each side within the paragraph, label names, key ranking, re-finding places, status words', () => {
  const long = '가'.repeat(70) + '[값]' + '나'.repeat(70), s = long.indexOf('['), e = s + 3;
  assert.deepEqual(contextAround(long, s, e), { before: '가'.repeat(60), after: '나'.repeat(60) });
  assert.deepEqual(contextAround('사업명: 값', 5, 6), { before: '사업명: ', after: '' }, 'paragraph start and end are the boundary');
  assert.deepEqual(contextAround('a\uFFFCb[x]c\uFFFC', 3, 6), { before: 'ab', after: 'c' });
  const emoji = '😀'.repeat(40) + 'X', ctx = contextAround(emoji, 80, 81);
  assert.equal(ctx.before, '😀'.repeat(30), 'a surrogate pair is never split'); assert.equal(ctx.after, '');
  assert.equal(contextAround('😀😀X', 4, 5, 3).before, '😀', 'a cut inside a pair moves inward');
  for (const [label, name] of [['가. 기관명', '기관명'], ['○ 담당', '담당'], ['1. 사업 개요', '사업 개요'], ['(1) 납품  장소:', '납품 장소'], ['① 금액', '금액'], ['사업명', '사업명'], ['가격', '가격'], ['1인당 금액', '1인당 금액']])
    assert.equal(labelName(label!), name, label);
  // 키 정렬: 이름 같음 → 라벨 같음 → 이름을 품음 → 라벨을 품음 → 나머지, 같은 순위는 타입이 맞는 것 먼저
  const keys = ['비고', '연락처', '담당자.연락처', '계약금액', '금액', '신청일', '사업 금액'];
  assert.deepEqual(rankKeys(keys, { name: '금액' }), ['금액', '계약금액', '사업 금액', '비고', '연락처', '담당자.연락처', '신청일']);
  assert.deepEqual(rankKeys(keys, { name: '', label: '○ 연락처' }).slice(0, 2), ['연락처', '담당자.연락처']);
  const typeOf = (p: string) => (p === '사업 금액' ? 'money' : p === '계약금액' ? 'text' : undefined) as any;
  assert.deepEqual(rankKeys(keys, { name: '금액', type: 'money' }, typeOf).slice(0, 3), ['금액', '사업 금액', '계약금액'], 'same rank: matching type first');
  assert.deepEqual(rankKeys(keys, { name: '' }), keys, 'nothing to go on: original order');
  // 자리 재탐색(다른 문서의 줄에서)
  const other = [{ id: 'a', text: '머리글' }, { id: 'b', text: '사업명: 새 사업 이름 (2027)' }, { id: 'c', text: '금액' }, { id: 'd', text: '9,999원' }, { id: 'e', text: '앞 문장 그대로 새 값 뒤 문장 그대로' }];
  assert.deepEqual(refind(other, { before: '앞 문장 그대로 ', after: ' 뒤 문장 그대로' }), [{ row: 'e', start: 9, end: 12, by: 'context' }]);
  assert.deepEqual(refind(other, { label: L('사업명', 'colon', 1), before: '사업명: ', after: ' (2026)' }), [{ row: 'b', start: 5, end: other[1]!.text.length, by: 'label' }], 'context after differs: label finds it');
  assert.deepEqual(refind(other, { label: L('사업명', 'colon', 1), before: '사업명: ', after: '' }), [{ row: 'b', start: 5, end: other[1]!.text.length, by: 'context' }]);
  assert.deepEqual(refind(other, { label: L('금액', 'rowHeader', 1), before: '', after: '' }), [{ row: 'd', start: 0, end: 6, by: 'label' }]);
  assert.deepEqual(refind(other, { label: L('없는 라벨', 'heading', 2) }), []);
  // 선택 상세의 연결 글(확정한 항목에 "확정 뒤 적용"이 남지 않는다)과 표 줄 읽기 이름
  assert.equal(linkNote('confirmed', '사업명'), '확정 · 사업명');
  assert.equal(linkNote('designated', '사업명'), '연결 후보 · 확정 뒤 적용');
  assert.equal(linkNote(undefined, ''), '연결 전');
  assert.deepEqual(rowAria(''), { ok: '이 줄 확정', keep: '이름 없는 항목 유지' });
  assert.deepEqual(rowAria(' 사업명 '), { ok: '사업명 확정', keep: '사업명 유지' });
  // 화면에서 새로 지정한 항목(workbench.js의 지정): 서버가 찾은 라벨을 달고 라벨에서 이름을 추천(제목 라벨은 이름 없음)
  const at = { row: 'p:0:1', start: 5, end: 9 };
  assert.deepEqual(designated(at, L('가. 사업명', 'colon', 1)), { ...at, name: '사업명', nameAuto: true, key: '', type: 'text', label: L('가. 사업명', 'colon', 1), status: 'designated', origin: 'user' });
  assert.deepEqual([designated(at, L('1. 개요', 'heading', 3)).name, designated(at).label, designated(at).name], ['', undefined, '']);
});

test('confirm plan (✓): state reflection on the items, edits per row, reasons for the rest; dropping a row after the server check', () => {
  const rows: Record<string, { text: string; current: string; blocked?: string }> = {
    a: { text: '사업명: 원래 값, 금액 1,000원', current: '사업명: 원래 값, 금액 1,000원' },
    b: { text: '표 칸 글', current: '표 칸 글', blocked: '표·개체가 있는 문단입니다.' },
    c: { text: '{{기관}} 그대로', current: '{{기관}} 그대로' },
  };
  const item = (row: string, start: number, end: number, extra: Partial<InputItem & { keyAuto: boolean; nameAuto: boolean }> = {}) =>
    ({ row, start, end, name: '', key: '', type: 'text', status: 'designated', origin: 'user', ...extra }) as InputItem & { keyAuto?: boolean; nameAuto?: boolean };
  const A = rows.a!.text, value = A.indexOf('원래 값'), money = A.indexOf('1,000');
  const a1 = item('a', value, value + 4, { keyAuto: true, nameAuto: true }), a2 = item('a', money, money + 5, { type: 'money' }), b1 = item('b', 0, 2), c1 = item('c', 0, 6, { origin: 'placeholder', status: 'recommended', name: '기관', key: '기관' });
  const ex = item('a', 0, 3, { status: 'excluded' }), field = item('c', 7, 10, { origin: 'clickHere', key: '필드' });
  const all = [a1, a2, b1, c1, ex, field];
  const plan = planConfirm(all, [
    { item: a1, name: '사업명', key: '사업명' }, { item: a2, name: '금액', key: '' }, { item: b1, name: '칸', key: '칸' }, { item: c1, name: '기관', key: '기관' },
    { item: ex, name: '제외', key: '제외' }, { item: field, name: '필드 이름', key: '무시' }, { item: item('a', 21, 22), name: '', key: 'x' }, { item: item('a', 21, 22), name: '키', key: '공백 키' },
  ], id => rows[id]!);
  assert.deepEqual(plan.ready.map(x => [x.item, x.name, x.key]), [[a1, '사업명', '사업명'], [a2, '금액', '금액'], [c1, '기관', '기관'], [field, '필드 이름', '필드']]);
  assert.deepEqual(plan.failed.map(([i, why]) => [all.indexOf(i), why]), [
    [4, '제외한 항목입니다.'], [-1, '이름을 적으세요.'], [-1, '데이터 키에는 글자·숫자·밑줄을 쓰고 하위 항목은 점으로 구분하세요.'], [2, '표·개체가 있는 문단입니다.']]);
  assert.deepEqual([...plan.texts], [['a', '사업명: {{사업명}}, 금액 {{금액}}원']], 'one new text per row; same-key {{기관}} and fields keep the text');
  // 아직 아무 항목도 바뀌지 않았다
  assert.deepEqual(all.map(i => i.status), ['designated', 'designated', 'designated', 'recommended', 'excluded', 'designated']);
  commitConfirm(plan.ready);
  assert.deepEqual(all.map(i => i.status), ['confirmed', 'confirmed', 'designated', 'confirmed', 'excluded', 'confirmed']);
  assert.deepEqual([a1.name, a1.key, a1.keyAuto, a1.nameAuto, a2.key, field.key], ['사업명', '사업명', false, false, '금액', '필드']);
  // 확정한 키를 바꾸려면 되돌려야 한다
  const again = planConfirm(all, [{ item: a1, name: '새 이름', key: '다른키' }, { item: a2, name: '금액 표시', key: '금액' }], id => rows[id]!);
  assert.deepEqual(again.failed.map(([, why]) => why), ['확정한 키는 실행 취소(Ctrl+Z)로 확정을 되돌린 뒤 바꾸세요.']);
  assert.deepEqual(again.ready.map(x => x.name), ['금액 표시']); assert.equal(again.texts.size, 0, 'renaming a confirmed item changes no text');
  // 서버 검사가 거절한 줄은 그 줄의 확정만 빠진다
  const fresh = [item('a', value, value + 4), item('a', money, money + 5)], dropped = planConfirm(fresh, fresh.map((i, n) => ({ item: i, name: 'n' + n, key: 'k' + n })), id => rows[id]!);
  dropRow(dropped, 'a', '글자 모양이 다른 글에 걸쳐 있습니다.');
  assert.deepEqual([dropped.ready.length, dropped.texts.size, dropped.failed.map(([, w]) => w)], [0, 0, ['글자 모양이 다른 글에 걸쳐 있습니다.', '글자 모양이 다른 글에 걸쳐 있습니다.']]);
  // 겹치는 둘
  const overlap = [item('a', value, value + 4), item('a', value + 2, value + 6)];
  assert.deepEqual(planConfirm(overlap, overlap.map((i, n) => ({ item: i, name: 'n', key: 'k' + n })), id => rows[id]!).failed.map(([, w]) => w), ['이미 확정한 입력 항목과 겹칩니다.', '이미 확정한 입력 항목과 겹칩니다.']);
});

test('work file: type choice, label, before/after round-trip; malformed ones are refused; old items still open', () => {
  const app = createWorkbench(), opened = open(app, labelSource()), rows = opened.paragraphs;
  const r = rows.find(x => x.text.startsWith('사업명: 전산장비 구매 0'))!, h = rows.find(x => x.text === '예시 값 3 입니다')!;
  const items: InputItem[] = [
    { row: r.id, start: 5, end: r.text.length, name: '사업명', key: '사업명', type: 'text', label: L('사업명', 'colon', 1), ...contextAround(r.text, 5, r.text.length), status: 'designated', origin: 'user' },
    { row: h.id, start: 3, end: 6, name: '', key: '', type: 'money', typeSet: true, label: L('예시 값 3 입니다의 앞', 'manual', 2), ...contextAround(h.text, 3, 6), status: 'designated', origin: 'user' },
  ];
  const saved = post(app, opened.session, 'save', { index: 0, edits: [], headings: [], blocks: [], inputItems: items.map(itemOf) });
  assert.deepEqual(JSON.parse(saved.workspace).inputItems, items);
  const restored = app.post('/api/workbench/restore', { workspace: saved.workspace }) as any;
  assert.deepEqual(restored.inputItems, items);
  const bad = (extra: Record<string, unknown>, code = 'WORKBENCH_INPUT') => wrong(() => app.post('/api/workbench/restore', { workspace: { ...JSON.parse(saved.workspace), inputItems: [{ ...items[0], ...extra }] } }), code);
  bad({ type: 'currency' }); bad({ type: 'number' }); bad({ typeSet: 'yes' }); bad({ label: { text: '', rel: 'colon', distance: 0 } }); bad({ label: { text: 'x', rel: 'guess', distance: 0 } });
  bad({ label: { text: 'x', rel: 'colon', distance: -1 } }); bad({ label: { text: 'x', rel: 'colon', distance: 0, extra: 1 } }); bad({ label: { text: 'x'.repeat(81), rel: 'manual', distance: 0 } });
  bad({ label: 'x' }); bad({ before: 'x'.repeat(61) }); bad({ after: 5 }); bad({ after: 'a\u0001' });
  assert.deepEqual(itemOf({ ...items[0]!, typeSet: false, id: 'x', keyAuto: true } as InputItem), items[0], 'screen-only fields and typeSet:false are not saved');
});
