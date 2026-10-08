import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decorateValue, suggestType, TYPE_LABEL, VALUE_TYPES, type ValueType } from '../src/value-type.ts';

// 타입 추천 규칙 표(#147): 타입마다 10개 이상, 경계 사례 포함. [원문 글, 타입, 단위?]
const TABLE: [string, ValueType, string?][] = [
  // 금액: 쉼표 묶음·"원"·화폐 기호·"금"·"원정"·소수·음수
  ['1,234,000원', 'money'], ['₩ 12,000', 'money'], ['5000원', 'money'], ['금 1,000,000원', 'money'], ['12,345.5', 'money'],
  ['1,200', 'money'], ['100원', 'money'], ['-5,000원', 'money'], ['￦3,500', 'money'], ['1,234,000원정', 'money'], ['금1,000원', 'money'], ['0원', 'money'],
  // 날짜: 점·공백, 줄표, 빗금, 년월일, 0 채움, 요일 괄호
  ['2026. 10. 7.', 'date'], ['2026.10.07', 'date'], ['2026-10-07', 'date'], ['2026/10/07', 'date'], ['2026년 10월 7일', 'date'], ['2026년10월7일', 'date'],
  ['2026. 1. 5.', 'date'], ['2026.1.5', 'date'], ['2026. 10. 7.(수)', 'date'], ['2026-02-28', 'date'], ['2024. 2. 29.', 'date'], ['2026. 12. 31', 'date'],
  // 시각
  ['14:00', 'time'], ['9:30', 'time'], ['09:05', 'time'], ['23:59', 'time'], ['0:00', 'time'], ['오후 2시', 'time'], ['오전 10시 30분', 'time'], ['14시 30분', 'time'], ['10시', 'time'], ['14 : 00', 'time'],
  // 전화
  ['02-123-4567', 'phone'], ['031-123-4567', 'phone'], ['010-1234-5678', 'phone'], ['01012345678', 'phone'], ['(02) 123-4567', 'phone'], ['031)123-4567', 'phone'],
  ['1588-1234', 'phone'], ['070-1234-5678', 'phone'], ['02.123.4567', 'phone'], ['010 1234 5678', 'phone'], ['010-0000-0000', 'phone'],
  // 수량(단위 분리)
  ['5개', 'quantity', '개'], ['3 명', 'quantity', '명'], ['100EA', 'quantity', 'EA'], ['2식', 'quantity', '식'], ['1,200부', 'quantity', '부'], ['3개월', 'quantity', '개월'],
  ['10%', 'quantity', '%'], ['30일', 'quantity', '일'], ['2.5kg', 'quantity', 'kg'], ['12건', 'quantity', '건'],
  // 글
  ['홍길동', 'text'], ['예시 주식회사', 'text'], ['전산장비 구매', 'text'], ['100', 'text'], ['123-45-67890', 'text'], ['110111-1234567', 'text'], ['5만원', 'text'],
  ['2026. 13. 1.', 'text'], ['2026. 2. 30.', 'text'], ['24:00', 'text'], ['', 'text'], ['미정', 'text'], ['제3호', 'text'], ['14:00~16:00', 'text'],
  // 긴 글: 40자 넘음·줄바꿈
  ['가'.repeat(41), 'longText'], ['첫째 줄\n둘째 줄', 'longText'], ['이 사업은 예시 기관이 발주하는 전산장비 구매 사업으로 납품 기한은 계약일로부터 30일입니다.', 'longText'],
  ['a'.repeat(41), 'longText'], ['1,234,000원\n(부가세 포함)', 'longText'], ['가\n', 'text'], ['참가 자격: 공고일 현재 해당 업종으로 등록하고 직접 생산 확인을 받은 업체', 'longText'],
  ['😀'.repeat(41), 'longText'], ['입찰 보증금은 입찰 금액의 100분의 5 이상으로 하며 현금 또는 보증서로 납부한다.', 'longText'],
  ['제출 서류: 사업자등록증 사본 1부, 법인 등기부 등본 1부, 인감 증명서 1부', 'longText'], ['한 줄\r\n두 줄', 'longText'], ['가 나\t다\n라', 'longText'],
  ['가'.repeat(40), 'text'], ['😀'.repeat(40), 'text'],
];

test('value type rules: 7 kinds by the shape of the original text (table: each kind 10+ with boundaries); hints only when there is no shape', () => {
  assert.deepEqual([...VALUE_TYPES], ['money', 'date', 'time', 'phone', 'quantity', 'text', 'longText']);
  assert.deepEqual(VALUE_TYPES.map(t => TYPE_LABEL[t]), ['금액', '날짜', '시각', '전화', '수량', '글', '긴 글']);
  const counts = new Map<ValueType, number>();
  for (const [text, type, unit] of TABLE) {
    assert.deepEqual(suggestType(text), unit === undefined ? { type } : { type, unit }, JSON.stringify(text));
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  for (const t of VALUE_TYPES) assert((counts.get(t) ?? 0) >= 10, t);
  // 확인 문장 2
  assert.deepEqual(['1,234,000원', '2026. 10. 7.', '14:00', '02-123-4567', '5개'].map(t => suggestType(t)),
    [{ type: 'money' }, { type: 'date' }, { type: 'time' }, { type: 'phone' }, { type: 'quantity', unit: '개' }]);
  // 모양이 없을 때만 이름·라벨 낱말을 본다(모양이 이긴다)
  assert.equal(suggestType('', '추정 가격').type, 'money');
  assert.equal(suggestType('△5,000원').type, 'money', 'a △ negative amount');
  assert.equal(suggestType('{{계약일자}}', '계약일자').type, 'date');
  assert.equal(suggestType('미정', '담당자 연락처').type, 'phone');
  assert.equal(suggestType('', '납품 수량').type, 'quantity');
  assert.equal(suggestType('', '개찰 시각').type, 'time');
  assert.equal(suggestType('홍길동', '금액').type, 'money', 'short text without a shape takes the hint');
  assert.equal(suggestType('2026. 10. 7.', '금액').type, 'date', 'shape wins over the hint');
  assert.equal(suggestType('가'.repeat(41), '금액').type, 'longText');
  assert.equal(suggestType('사업명', '성명').type, 'text');
  // 쉼표로 묶은 수만 있으면 금액, 이름·라벨이 수량이면 수량(글자 사이를 띄운 라벨 포함). 원·₩이 있으면 늘 금액
  assert.deepEqual([suggestType('12,500'), suggestType('12,500', '납 품 수 량'), suggestType('12,500원', '수량'), suggestType('', '계 약 예 산')].map(g => g.type), ['money', 'quantity', 'money', 'money']);
  assert.equal(suggestType('A\uFFFC1,000원').type, 'text', 'object marks stay in the text');
  assert.equal(suggestType('\uFFFC1,000원').type, 'money', 'a leading object mark is ignored');
});

test('value type rules: seeded 140 synthetic values (7 kinds x 20) are recommended as generated', t => {
  let seed = 0x147a;
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const pick = <T>(xs: readonly T[]) => xs[next(xs.length)]!;
  const digits = (n: number) => Array.from({ length: n }, (_, i) => String(i === 0 ? 1 + next(9) : next(10))).join('');
  const comma = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const two = (n: number) => String(n).padStart(2, '0');
  const make: Record<ValueType, () => [string, string?]> = {
    money: () => [pick(['', '금 ', '₩', '₩ ']) + comma(digits(4 + next(6))) + pick(['원', '', '원정'])],
    date: () => { const y = 2000 + next(40), m = 1 + next(12), d = 1 + next(28); return [pick([`${y}. ${m}. ${d}.`, `${y}.${two(m)}.${two(d)}`, `${y}-${two(m)}-${two(d)}`, `${y}년 ${m}월 ${d}일`, `${y}/${m}/${d}`])]; },
    time: () => { const h = next(24), m = next(60); return [pick([`${h}:${two(m)}`, `${two(h)}:${two(m)}`, `${h}시 ${m}분`, `${h}시`, `${pick(['오전', '오후'])} ${1 + next(11)}시`])]; },
    phone: () => [pick([`0${2 + next(5)}-${digits(3)}-${digits(4)}`, `010-${digits(4)}-${digits(4)}`, `010${digits(8)}`, `(02) ${digits(3)}-${digits(4)}`, `15${digits(2)}-${digits(4)}`])],
    quantity: () => { const unit = pick(['개', '명', '부', '식', 'EA', '건', '대', '권']); return [`${comma(digits(1 + next(4)))}${pick(['', ' '])}${unit}`, unit]; },
    text: () => [pick(['홍길동', '예시 주식회사', '전산장비 구매', '서울특별시 예시구', '해당 없음', '참가 신청서', '가나다라'])],
    longText: () => [Array.from({ length: 4 + next(4) }, () => pick(['이 사업은', '예시 기관이', '발주하는', '납품 조건은', '계약서에 따른다.'])).join(' ') + '\n' + '추가 설명'],
  };
  let n = 0;
  for (const type of VALUE_TYPES) for (let i = 0; i < 20; i++) {
    const [text, unit] = make[type]();
    assert.deepEqual(suggestType(text), unit === undefined ? { type } : { type, unit }, `${type} ${JSON.stringify(text)}`); n++;
  }
  assert.equal(n, 140);
  t.diagnostic(`seed=0x147a; values=${n}; mismatches=0`);
});

test('value decoration: amount commas and no doubled 원, date in the original shape, quantity unit; phone/id/text untouched', () => {
  // 금액: 쉼표, 원문 수 모양의 앞뒤 글(원·금)을 따르고, 자리 뒤가 "원"이면 붙이지 않는다(확인 문장 4)
  assert.equal(decorateValue('money', '1234000', '1,234,000원', ''), '1,234,000원');
  assert.equal(decorateValue('money', '1234000', '1,234,000', '원 (부가세 포함)'), '1,234,000');
  assert.equal(decorateValue('money', '1234000원', '1,234,000', '원'), '1,234,000', 'value 원 + following 원 → once');
  assert.equal(decorateValue('money', '1234000원', '{{금액}}', '원'), '1,234,000');
  assert.equal(decorateValue('money', '1234000원', '{{금액}}', ''), '1,234,000원', 'no 원 in the source: the value keeps its own');
  assert.equal(decorateValue('money', '1234000', '{{금액}}', ' 원'), '1,234,000');
  assert.equal(decorateValue('money', '2000000', '금 1,000,000원', ''), '금 2,000,000원');
  assert.equal(decorateValue('money', '₩2,000,000', '1,000원정', ''), '2,000,000원정');
  assert.equal(decorateValue('money', '-1234', '1,000원', ''), '-1,234원');
  assert.equal(decorateValue('money', '007', '1,000', ''), '7');
  assert.equal(decorateValue('money', '0', '1,000원', ''), '0원');
  assert.equal(decorateValue('money', '12345678901234567890', '1원', ''), '12,345,678,901,234,567,890원', 'big numbers stay exact');
  assert.equal(decorateValue('money', '1234.5', '1원', ''), '1,234.5원');
  for (const v of ['미정', '', '1,000원 및 2,000원', '2026-10-07', '약 일천만원']) assert.equal(decorateValue('money', v, '1,000원', ''), v, v);
  // 부호는 값의 것을 지킨다(원문 앞 글로 덮지 않음, 부호 뒤 빈칸은 붙인다)
  assert.equal(decorateValue('money', '△1234', '1,000원', ''), '△1,234원');
  assert.equal(decorateValue('money', '- 1234', '금 1,000원', ''), '금 -1,234원');
  assert.equal(decorateValue('money', '1,2,3', '1,000원', ''), '1,2,3', 'commas that are not groups of three: left as given');
  // 날짜: 원문의 구분 글·공백·끝 글·0 채움·요일(새 날짜로 다시 셈)(확인 문장 5)
  const d = (value: string, original: string) => decorateValue('date', value, original, '');
  assert.equal(d('2026-11-02', '2026. 10. 7.'), '2026. 11. 2.');
  assert.equal(d('2026. 1. 5.', '2026-10-07'), '2026-01-05');
  assert.equal(d('2026-11-02', '2026.10.15'), '2026.11.02', 'both two-digit, compact → zero padded');
  assert.equal(d('2026-11-02', '2026. 10. 15.'), '2026. 11. 2.', 'both two-digit, spaced → not padded');
  assert.equal(d('2026-01-05', '2026년 10월 7일'), '2026년 1월 5일');
  assert.equal(d('2026-11-02', '2026년10월07일'), '2026년11월02일');
  assert.equal(d('2026-11-02', '2026. 10. 7.(수)'), '2026. 11. 2.(월)');
  assert.equal(d('2026-10-07', '2026/1/5'), '2026/10/7');
  assert.equal(d('2026-11-02', ' 2026. 10. 7. '), ' 2026. 11. 2. ', 'spaces inside the chosen place stay');
  assert.equal(d('20261102', '2026. 10. 7.'), '2026. 11. 2.');
  assert.equal(d('2026년 11월 2일', '2026-10-07'), '2026-11-02');
  for (const [v, o] of [['2026-02-30', '2026. 10. 7.'], ['다음 달', '2026. 10. 7.'], ['2026-11-02 10:00', '2026. 10. 7.'], ['다음 달', '{{계약일}}']]) assert.equal(d(v!, o!), v, `${v} / ${o}`);
  // 원문에 날짜 서식이 없으면 기본 YYYY. MM. DD.(사용자 결정 2026-10-09)
  assert.equal(d('2026-11-02', '{{계약일}}'), '2026. 11. 02.');
  assert.equal(d('2026년 1월 5일', ''), '2026. 01. 05.');
  assert.equal(d('20261231', '미정'), '2026. 12. 31.');
  // 수량: 원문 단위, 자리 뒤가 단위면 붙이지 않음, 원문 수에 쉼표가 있을 때만 쉼표
  assert.equal(decorateValue('quantity', '7', '5개', ''), '7개');
  assert.equal(decorateValue('quantity', '7', '5', '개'), '7');
  assert.equal(decorateValue('quantity', '1200', '3 명', ''), '1200 명');
  assert.equal(decorateValue('quantity', '1200', '1,000부', ''), '1,200부');
  assert.equal(decorateValue('quantity', '7개', '{{수량}}', '개'), '7');
  assert.equal(decorateValue('quantity', '많음', '5개', ''), '많음');
  // 전화·식별번호·시각·글: 받은 글 그대로(앞자리 0 보존, 확인 문장 6)
  for (const type of ['phone', 'text', 'longText', 'time'] as const)
    for (const v of ['02-123-4567', '0212345678', '010-0000-0000', '0101011234567', '007', '14:00', '1234000'])
      assert.equal(decorateValue(type, v, '02-999-9999', '원'), v, `${type} ${v}`);
});
