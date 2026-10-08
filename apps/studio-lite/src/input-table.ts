// 표 보기(#146): 입력 항목 한 줄의 상태·위치·데이터 키를 다루는 순수 함수. 화면(`web/workbench.js`, 형 제거본 `/input-table.js`)과 시험이 같은 코드를 쓴다.
// 위치는 늘 원문 줄 글(`Row.text`) 기준 `[start, end)`다. 확정한 항목만 편집 글에 `{{키}}`로 들어가고, 지정·추천·제외는 글을 바꾸지 않는다(요구 8.8-2).

export type ItemStatus = 'recommended' | 'designated' | 'confirmed' | 'excluded';
export type ItemOrigin = 'user' | 'placeholder' | 'clickHere' | 'mailMerge';
export type ItemType = 'text' | 'amount';
/** 작업 파일에 남기는 입력 항목 한 줄 */
export type InputItem = { row: string; start: number; end: number; name: string; key: string; type: ItemType; status: ItemStatus; origin: ItemOrigin };
export type Span = { start: number; end: number };
type Rep = Span & { key: string };

export const STATUS_LABEL: Record<ItemStatus, string> = { recommended: '추천', designated: '지정', confirmed: '확정', excluded: '제외' };
export const TYPE_LABEL: Record<ItemType, string> = { text: '글', amount: '금액' };
export const ITEM_KEYS = ['row', 'start', 'end', 'name', 'key', 'type', 'status', 'origin'] as const;

// 엔진 `isValidPath`와 같은 규칙(이름(.이름)*, 이름은 글자·숫자·_·-). 브라우저에서 엔진을 불러오지 않으려고 따로 둔다(시험에서 둘을 대조한다)
const KEY = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u;
export const validKey = (key: string): boolean => KEY.test(key);
/** 누름틀·메일머지는 문서의 필드 이름이 곧 데이터 키다. 글을 바꾸지 않고 확정만 한다 */
export const isField = (origin: ItemOrigin): boolean => origin === 'clickHere' || origin === 'mailMerge';
/** 남은 상태(제외를 되돌릴 때): 사용자가 지정한 것은 지정, 문서에서 찾은 것은 추천 */
export const keptStatus = (origin: ItemOrigin): ItemStatus => origin === 'user' ? 'designated' : 'recommended';
const keyText = (key: string) => '{{' + key + '}}';

/** 타입 추천(지금은 글/금액 둘. 7종은 #147). 이름에 금액 낱말이 있거나 원문이 금액 모양이면 금액 */
export function suggestType(name: string, text: string): ItemType {
  if (/금액|가격|예산|단가|비용|대금/.test(name)) return 'amount';
  const t = text.replace(/\s/g, '');
  return /^(?:금)?[₩￦]?(?:\d{1,3}(?:,\d{3})+|\d+(?=원))(?:\.\d+)?원?$/.test(t) ? 'amount' : 'text';
}

/**
 * 이름이 데이터 키와 같으면 키 칸을 자동으로 채운다(R4: 연결 후보. 확정은 따로 ✓). 사용자가 직접 적은 키는 건드리지 않고,
 * 자동으로 채운 키는 이름이 바뀌어 더는 맞지 않으면 비운다.
 */
export function autoKey(name: string, key: string, auto: boolean, keys: readonly string[]): { key: string; auto: boolean } {
  if (key !== '' && !auto) return { key, auto: false };
  const wanted = name.trim();
  if (wanted !== '' && keys.includes(wanted)) return { key: wanted, auto: true };
  return { key: auto ? '' : key, auto: false };
}

/** `[start, end)`마다 `{{키}}`를 넣은 글. 구간은 겹치지 않아야 한다 */
export function applyKeys(text: string, reps: readonly Rep[]): string {
  let out = '', at = 0;
  for (const r of [...reps].sort((a, b) => a.start - b.start)) { out += text.slice(at, r.start) + keyText(r.key); at = r.end; }
  return out + text.slice(at);
}

/** 같은 키의 `{{키}}` 자리(띄어쓰기만 다른 것 포함): 확정해도 글을 바꾸지 않는다 */
export const samePlaceholder = (text: string, key: string): boolean => text.replace(/\s/g, '') === keyText(key);

/** 확정한 항목이 그 줄 글(`text`)에 넣은 `{{키}}`. 누름틀·메일머지와 같은 키의 `{{키}}`는 글을 바꾸지 않으므로 빠진다 */
export function repsOf(items: readonly InputItem[], row: string, text: string): Rep[] {
  return items.filter(i => i.row === row && i.status === 'confirmed' && !isField(i.origin) && !(i.origin === 'placeholder' && samePlaceholder(text.slice(i.start, i.end), i.key)))
    .map(i => ({ start: i.start, end: i.end, key: i.key })).sort((a, b) => a.start - b.start);
}

function diff(before: string, after: string) {
  let start = 0, end = before.length, next = after.length;
  while (start < end && start < next && before[start] === after[start]) start++;
  while (end > start && next > start && before[end - 1] === after[next - 1]) { end--; next--; }
  return { start, end, next };
}
/** 원문에서 바뀐 한 구간(같으면 `undefined`). 서버의 글자 모양 검사가 이 구간을 본다 */
export function changedSpan(original: string, next: string): Span | undefined {
  if (original === next) return undefined;
  const d = diff(original, next);
  return { start: d.start, end: d.end };
}
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end || a.start === b.start;

/**
 * 원문 구간이 지금 편집 글에서 어디인지. 지금 글이 "원문 + 확정한 `{{키}}`"와 같으면 그 길이 차이만큼 민다.
 * 그 밖의 편집이 있으면 바뀐 한 구간 밖(앞·뒤)일 때만 옮기고, 바뀐 곳·확정한 자리에 걸치면 `undefined`(위치를 믿을 수 없다).
 */
export function toCurrent(original: string, current: string, reps: readonly Rep[], start: number, end: number): Span | undefined {
  if (reps.some(r => overlaps(r, { start, end }))) return undefined;
  if (applyKeys(original, reps) === current) {
    const shift = reps.filter(r => r.end <= start).reduce((n, r) => n + keyText(r.key).length - (r.end - r.start), 0);
    return { start: start + shift, end: end + shift };
  }
  const d = diff(original, current);
  if (end <= d.start && (start < end || start < d.start)) return { start, end };
  if (start >= d.end && (start < end || start > d.end)) return { start: start + d.next - d.end, end: end + d.next - d.end };
  return undefined;
}

/** `toCurrent`의 반대: 지금 편집 글의 구간 → 원문 구간. 확정한 `{{키}}`나 바뀐 곳에 걸치면 `undefined` */
export function toOriginal(original: string, current: string, reps: readonly Rep[], start: number, end: number): Span | undefined {
  if (applyKeys(original, reps) === current) {
    let shift = 0;
    for (const r of [...reps].sort((a, b) => a.start - b.start)) {
      const at = r.start + shift, until = at + keyText(r.key).length;
      if (overlaps({ start: at, end: until }, { start, end })) return undefined;
      if (until <= start) shift += keyText(r.key).length - (r.end - r.start);
    }
    return { start: start - shift, end: end - shift };
  }
  const d = diff(original, current);
  if (end <= d.start && (start < end || start < d.start)) return { start, end };
  if (start >= d.next && (start < end || start > d.next)) return { start: start - d.next + d.end, end: end - d.next + d.end };
  return undefined;
}

/**
 * 한 줄에서 `targets`를 확정할 때의 새 편집 글. 이미 확정한 `{{키}}`(`existing`)와 겹치거나 서로 겹치면 `overlap`,
 * 손으로 고친 곳에 걸쳐 원문 위치를 찾을 수 없으면 `edited`. 같은 키로 이미 `{{키}}`인 자리는 글이 그대로다.
 */
export function confirmText(original: string, current: string, existing: readonly Rep[], targets: readonly Rep[]): { text: string } | { fail: 'overlap' | 'edited' } {
  const all = [...existing, ...targets].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < all.length; i++) if (overlaps(all[i - 1]!, all[i]!)) return { fail: 'overlap' };
  if (applyKeys(original, existing) === current) return { text: applyKeys(original, all) };
  let text = current;
  for (const t of [...targets].sort((a, b) => b.start - a.start)) {
    const at = toCurrent(original, current, existing, t.start, t.end);
    if (!at) return { fail: 'edited' };
    text = text.slice(0, at.start) + keyText(t.key) + text.slice(at.end);
  }
  return { text };
}

/** 표 보기의 원문 글: 지정한 글과 앞뒤 일부(개체 자리 표시 `\uFFFC`는 뺀다) */
export function contextOf(text: string, start: number, end: number, around = 14): { before: string; target: string; after: string } {
  const clean = (s: string) => s.replaceAll('\uFFFC', '');
  const from = Math.max(0, start - around), to = Math.min(text.length, end + around);
  return { before: (from > 0 ? '…' : '') + clean(text.slice(from, start)), target: clean(text.slice(start, end)), after: clean(text.slice(end, to)) + (to < text.length ? '…' : '') };
}

/** 저장한 항목을 다시 연 문서의 후보에 얹는다. 문서에서 찾은 후보는 같은 자리·같은 출처로 맞추고, 사용자가 지정한 것은 새 줄로 더한다 */
export function mergeSaved<T extends InputItem>(candidates: T[], saved: readonly InputItem[], make: (item: InputItem) => T): { items: T[]; dropped: number } {
  const items = [...candidates];
  let dropped = 0;
  for (const s of saved) {
    if (s.origin === 'user') { items.push(make(s)); continue; }
    const found = items.find(c => c.origin === s.origin && c.row === s.row && c.start === s.start && c.end === s.end);
    if (found) Object.assign(found, { name: s.name, key: s.key, type: s.type, status: s.status });
    else dropped++;
  }
  return { items, dropped };
}

/** 확정에 쓸 키: 누름틀·메일머지는 필드 이름(문서에 있는 그대로) 고정, 나머지는 적은 키(비면 이름) */
export function keyFor(item: Pick<InputItem, 'origin' | 'key'>, name: string, key: string): string {
  return isField(item.origin) ? item.key : (key.trim() || name.trim());
}

/** 항목이 지금 편집 글에서 차지하는 구간. 확정해 `{{키}}`로 바뀐 항목은 그 `{{키}}` 자리다 */
export function spanNow(original: string, current: string, reps: readonly Rep[], start: number, end: number): Span | undefined {
  const own = reps.find(r => r.start === start && r.end === end);
  if (!own) return toCurrent(original, current, reps, start, end);
  if (applyKeys(original, reps) !== current) return undefined;
  const at = start + reps.filter(r => r !== own && r.end <= start).reduce((n, r) => n + keyText(r.key).length - (r.end - r.start), 0);
  return { start: at, end: at + keyText(own.key).length };
}
