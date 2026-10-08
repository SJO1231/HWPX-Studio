// 값 타입(#147, 요구 8.9-2). 화면(형 제거본 `/value-type.js`)·서버·시험이 같은 코드를 쓴다.
// 추천은 `suggestType` 함수 하나다: 지금은 규칙(원문 값 모양 → 이름·라벨 낱말)이고, 요구 8.9-9의 규칙 → n-gram → 임베딩 → AI 순서로 이 함수만 바꿔 끼운다.
// 꾸밈(`decorateValue`)은 작업창 생성에서 확정한 자리의 값에만 쓴다: 금액 쉼표와 "원" 중복 없음(서식에 "원"이 있으면 숫자만),
// 날짜는 원문 서식(없으면 기본 `YYYY. MM. DD.`), 수량은 원문 단위. 전화·식별번호·글은 받은 글 그대로다(숫자로 바꾸지 않으므로 앞자리 0이 남는다).
// 엔진의 표시 형식 계약(#131)과는 별개다.
// 타입 이름은 엔진 값 형식(8.8.4 `text`·`money`)과 G2B Helper 계약의 7종(`text|number|money|percent|date|datetime|boolean`)에서 같은 뜻이면 같은 이름을 쓴다:
// money = 금액, date = 날짜, text = 글. 시각(time)·전화(phone)·수량(quantity)·긴 글(longText)은 화면 추천용이고 Helper 쪽에서는 각각 datetime의 시각 부분·text·number(단위 별도)·text다.

export const VALUE_TYPES = ['money', 'date', 'time', 'phone', 'quantity', 'text', 'longText'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];
export const TYPE_LABEL: Record<ValueType, string> = { money: '금액', date: '날짜', time: '시각', phone: '전화', quantity: '수량', text: '글', longText: '긴 글' };
/** 추천 결과. 수량이면 원문의 단위를 함께 준다 */
export type TypeGuess = { type: ValueType; unit?: string };

/** 이 글자 수를 넘거나 줄바꿈이 있으면 긴 글 */
const LONG = 40;
const MONEY = /^(?:금)?[₩￦]?[-△]?(?:\d{1,3}(?:,\d{3})+|\d+(?=원))(?:\.\d+)?(?:원정?)?$/u;
const DATE = /^(\d{4})(\s*(?:[.\-/]|년)\s*)(\d{1,2})(\s*(?:[.\-/]|월)\s*)(\d{1,2})(\s*(?:\.|일))?(\s*\(\s*[월화수목금토일]\s*\))?$/u;
const TIME = /^(?:(?:오전|오후)\s*)?(?:[01]?\d|2[0-3])\s*(?::\s*[0-5]\d|시(?:\s*[0-5]?\d\s*분)?)$/u;
const PHONE = /^(?:\(?0\d{1,2}\)?[-.\s)]*\d{3,4}[-.\s]\d{4}|01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}|1[5-9]\d{2}-\d{4})$/u;
const QUANTITY = /^-?\d[\d,]*(?:\.\d+)?\s*([가-힣A-Za-z㎏㎡㎥%]{1,4})$/u;
/** 값 모양이 없을 때(빈 글·`{{키}}`·짧은 글) 이름·라벨 낱말로 본다 */
const HINTS: [ValueType, RegExp][] = [
  ['money', /금액|가격|예산|단가|비용|대금|보증금|수수료|요금/u],
  ['phone', /전화|연락처|팩스|휴대폰|핸드폰|fax|tel/iu],
  ['date', /일자|날짜|기한|년월일|마감일|공고일|계약일|시작일|종료일|신청일|^일$/u],
  ['time', /시각|시간/u],
  ['quantity', /수량|개수|인원|건수|부수/u],
];

/** 날짜 원문 모양: 연·월·일 글과 그 사이 글(공백 포함), 끝 글, 요일 괄호 */
function dateShape(text: string) {
  const m = DATE.exec(text.trim());
  if (!m) return undefined;
  const [, y, sep1, mo, sep2, d, end = '', weekday = ''] = m as unknown as string[];
  const s1 = sep1!.trim(), s2 = sep2!.trim();
  // 구분 글은 둘이 같거나 `년`·`월`이고, 끝 글은 `년월` 꼴이면 `일`(또는 없음), 점·줄표 꼴이면 `.`(또는 없음)
  if (!(s1 === s2 || s1 === '년' && s2 === '월') || (s1 === '년' ? !['', '일'].includes(end.trim()) : end.trim() === '일')) return undefined;
  const year = Number(y), month = Number(mo), day = Number(d), at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return undefined;
  return { year, month, day, sep1: sep1!, sep2: sep2!, end, weekday, mo: mo!, d: d! };
}

/**
 * 원문 글(`text`)의 모양으로 타입을 추천한다. 모양이 없으면 `hint`(이름, 없으면 라벨)의 낱말로 본다.
 * 금액(`1,234,000원`·`₩12,000`·`5000원`) · 날짜(`2026. 10. 7.`·`2026-10-07`·`2026년 10월 7일`, 요일 괄호 허용) · 시각(`14:00`·`오후 2시`)
 * · 전화(`02-123-4567`·`010-1234-5678`·`1588-1234`) · 수량(`5개`·`3 명`·`100EA`, 단위를 함께 준다) · 긴 글(40자 넘음·줄바꿈) · 글.
 */
export function suggestType(text: string, hint = ''): TypeGuess {
  // 이름·라벨 낱말은 글자 사이 공백을 빼고 본다(공고서 라벨 `납 품 수 량`)
  const t = text.replaceAll('\uFFFC', '').trim(), compact = t.replace(/\s/g, ''), cue = hint.replace(/\s/g, '');
  // 쉼표로 묶은 수만 있으면(`12,500`) 금액이 기본이고, 이름·라벨이 수량 낱말이면 수량
  if (MONEY.test(compact)) return !/[원₩￦금]/u.test(compact) && HINTS.some(([type, re]) => type === 'quantity' && re.test(cue)) ? { type: 'quantity' } : { type: 'money' };
  if (dateShape(t)) return { type: 'date' };
  if (TIME.test(t)) return { type: 'time' };
  if (PHONE.test(t)) return { type: 'phone' };
  const unit = QUANTITY.exec(t)?.[1];
  if (unit !== undefined && !unit.includes('원')) return { type: 'quantity', unit };
  if ([...t].length > LONG || t.includes('\n')) return { type: 'longText' };
  for (const [type, re] of HINTS) if (re.test(cue)) return { type };
  return { type: 'text' };
}

const NUMBER = /^(\D*?)([-△]\s*)?(\d[\d,]*(?:\.\d+)?)(\D*)$/u;
/** 앞 글 · 부호(`-`·`△`, 뒤 빈칸 허용) · 수(쉼표 뺀 것) · 뒤 글. 수가 하나가 아니거나 쉼표가 세 자리 묶음이 아니면(`1,2,3`) undefined */
function numberParts(text: string) {
  const m = NUMBER.exec(text.replaceAll('\uFFFC', '').trim());
  if (!m || m[3]!.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(m[3]!)) return undefined;
  return { prefix: m[1]!, sign: (m[2] ?? '').trim(), number: m[3]!.replace(/,/g, ''), suffix: m[4]!, comma: m[3]!.includes(',') };
}
/** 천 단위 쉼표(글로만 다룬다. 큰 수·앞자리 0도 안전하다) */
function group(n: string) {
  const [int = '', frac] = n.split('.');
  return int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac === undefined ? '' : '.' + frac);
}
const WEEKDAYS = '일월화수목금토';

/**
 * 확정한 자리에 넣을 값 글을 타입과 원문 모양에 맞춘다. `original`은 그 자리의 원문 글, `following`은 원문에서 자리 바로 뒤 글이다.
 * - 금액·수량: 값이 수 하나(앞뒤 글 허용)일 때만. 금액은 천 단위 쉼표, 수량은 원문 수에 쉼표가 있을 때만 쉼표.
 *   원문이 수 모양이면 원문의 앞 글·뒤 글(`금 `·`원`·`개` 등)을 따르고, 아니면 값의 앞 글·뒤 글을 쓴다.
 *   자리 바로 뒤 원문이 그 뒤 글로 시작하면(`{{금액}}원`) 붙이지 않는다("원"이 두 번 나오지 않는다).
 * - 날짜: 값이 날짜일 때. 원문이 날짜면 그 서식(구분 글·공백·끝 글·0 채움·요일 괄호. 요일은 새 날짜로 다시 센다)을 따르고,
 *   원문에 날짜 서식이 없으면(`{{계약일}}` 등) 기본 `YYYY. MM. DD.`(사용자 결정 2026-10-09: 기본 서식, 서식 설정으로 덮는다)이다.
 * - 그 밖(시각·전화·글·긴 글)과 맞지 않는 값은 받은 그대로 둔다.
 */
export function decorateValue(type: ValueType, value: string, original: string, following: string): string {
  if (type === 'money' || type === 'quantity') {
    const v = numberParts(value);
    if (!v) return value;
    const o = numberParts(original);
    const number = type === 'money' || (o ? o.comma : v.comma) ? group(v.number) : v.number.replace(/^0+(?=\d)/, '');
    // 앞 글·뒤 글은 원문 모양, 부호는 값의 것(`△1234` → `△1,234`)
    const prefix = o ? o.prefix : v.prefix, suffix = o ? o.suffix : v.suffix;
    return prefix + v.sign + number + (suffix.trim() !== '' && following.trimStart().startsWith(suffix.trim()) ? '' : suffix);
  }
  if (type === 'date') {
    const o = dateShape(original), v = dateShape(value) ?? (/^\d{8}$/.test(value.trim()) ? dateShape(value.trim().replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')) : undefined);
    if (!v) return value;
    if (!o) return `${v.year}. ${String(v.month).padStart(2, '0')}. ${String(v.day).padStart(2, '0')}.`;
    const short = (s: string) => s.length === 1, zero = (s: string) => s.length === 2 && s.startsWith('0');
    const pad = zero(o.mo) || zero(o.d) ? true : short(o.mo) || short(o.d) ? false : !/\s|년/.test(o.sep1 + o.sep2);
    const two = (n: number) => pad ? String(n).padStart(2, '0') : String(n);
    const weekday = o.weekday.replace(/[월화수목금토일]/u, WEEKDAYS[new Date(Date.UTC(v.year, v.month - 1, v.day)).getUTCDay()]!);
    // 고른 자리 안의 앞뒤 빈칸은 원문 그대로 둔다
    return /^\s*/u.exec(original)![0] + v.year + o.sep1 + two(v.month) + o.sep2 + two(v.day) + o.end + weekday + /\s*$/u.exec(original)![0];
  }
  return value;
}
