// 표 보기(#146): 입력 항목 한 줄의 상태·위치·데이터 키를 다루는 순수 함수. 화면(`web/workbench.js`, 형 제거본 `/input-table.js`)과 시험이 같은 코드를 쓴다.
// 위치는 늘 원문 줄 글(`Row.text`) 기준 `[start, end)`다. 확정한 항목만 편집 글에 `{{키}}`로 들어가고, 지정·추천·제외는 글을 바꾸지 않는다(요구 8.8-2).
// 타입(#147)은 `value-type.ts`, 라벨 찾기(#148)는 서버의 `item-label.ts`가 맡는다. 여기에는 저장 꼴과 화면·시험이 함께 쓰는 계산만 둔다.
import type { ValueType } from './value-type.ts';

export type ItemStatus = 'recommended' | 'designated' | 'confirmed' | 'excluded';
export type ItemOrigin = 'user' | 'placeholder' | 'clickHere' | 'mailMerge';
/** 라벨과 자리의 관계: 같은 행 왼쪽 머리 칸 · 같은 문단 앞의 `라벨:` · 위 제목 · 사용자가 고른 참고 글 */
export type LabelRel = 'rowHeader' | 'colon' | 'heading' | 'manual';
/** 라벨(#148): 글, 관계, 거리(머리 칸은 몇 칸 왼쪽, `라벨:`은 쌍점 뒤부터 자리까지 글자 수, 제목·참고 글은 몇 문단 위·아래) */
export type ItemLabel = { text: string; rel: LabelRel; distance: number };
/**
 * 작업 파일에 남기는 입력 항목 한 줄. `typeSet`은 사용자가 타입을 고른 것(없으면 추천), `before`·`after`는 지정할 때의 앞뒤 글(문단 안, 60자까지).
 */
export type InputItem = {
  row: string; start: number; end: number; name: string; key: string; type: ValueType; typeSet?: boolean;
  label?: ItemLabel; before?: string; after?: string; status: ItemStatus; origin: ItemOrigin;
};
export type Span = { start: number; end: number };
type Rep = Span & { key: string };

export const STATUS_LABEL: Record<ItemStatus, string> = { recommended: '추천', designated: '지정', confirmed: '확정', excluded: '제외' };
export const REL_LABEL: Record<LabelRel, string> = { rowHeader: '행 머리', colon: '앞 글', heading: '제목', manual: '참고 글' };
export const LABEL_RELS = Object.keys(REL_LABEL) as LabelRel[];
export const ITEM_KEYS = ['row', 'start', 'end', 'name', 'key', 'type', 'typeSet', 'label', 'before', 'after', 'status', 'origin'] as const;
/** 앞뒤 글 길이(문단 경계까지) */
export const CONTEXT = 60;
/** 라벨 글 길이(참고 글은 고른 글을 이만큼 자른다) */
export const LABEL_MAX = 80;

// 엔진 `isValidPath`와 같은 규칙(이름(.이름)*, 이름은 글자·숫자·_·-). 브라우저에서 엔진을 불러오지 않으려고 따로 둔다(시험에서 둘을 대조한다)
const KEY = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u;
export const validKey = (key: string): boolean => KEY.test(key);
/** 누름틀·메일머지는 문서의 필드 이름이 곧 데이터 키다. 글을 바꾸지 않고 확정만 한다 */
export const isField = (origin: ItemOrigin): boolean => origin === 'clickHere' || origin === 'mailMerge';
/** 남은 상태(제외를 되돌릴 때): 사용자가 지정한 것은 지정, 문서에서 찾은 것은 추천 */
export const keptStatus = (origin: ItemOrigin): ItemStatus => origin === 'user' ? 'designated' : 'recommended';
const keyText = (key: string) => '{{' + key + '}}';

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
    // 저장한 이름·키·타입·상태와 (있으면) 고른 타입 표시·라벨·앞뒤 글. 옛 작업 파일에 라벨이 없으면 문서에서 찾은 라벨을 그대로 둔다
    const { row: _row, start: _start, end: _end, origin: _origin, ...saved } = s;
    if (found) Object.assign(found, saved);
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

/** 작업 파일에 넣을 꼴: 정해진 칸만, 값이 없는 칸은 뺀다(화면의 보조 값 `id`·`keyAuto` 등은 남기지 않는다) */
export function itemOf(r: InputItem): InputItem {
  const out: Record<string, unknown> = {};
  for (const k of ITEM_KEYS) if (r[k] !== undefined && !(k === 'typeSet' && r[k] === false)) out[k] = r[k];
  return out as InputItem;
}

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** 지정한 글의 앞뒤 글(문단 안, 각 `size`자까지. 개체 자리 표시 `\uFFFC`는 빼고 짝 글자를 가르지 않는다) */
export function contextAround(text: string, start: number, end: number, size = CONTEXT): { before: string; after: string } {
  let from = Math.max(0, start - size), to = Math.min(text.length, end + size);
  if (from > 0 && isLow(text.charCodeAt(from))) from++;
  if (to < text.length && isLow(text.charCodeAt(to))) to--;
  return { before: text.slice(from, start).replaceAll('\uFFFC', ''), after: text.slice(end, to).replaceAll('\uFFFC', '') };
}

const BULLET = /^(?:[\s○●◎◇◆□■▶▷►※*·•\-–—]|\(?\d{1,2}[.)]|\(?[가-하][.)]|[①-⑳㉠-㉻])+/u;
/** 라벨 글에서 이름으로 쓸 부분: 앞의 글머리표·번호(`1.`·`가)`·`○`)와 끝 쌍점을 걷고 공백을 하나로. 한 글자씩 띄운 라벨(`신 청 기 관`)은 붙인다 */
export function labelName(text: string): string {
  const t = text.replace(BULLET, '').replace(/[:：]\s*$/u, '').replace(/\s+/g, ' ').trim();
  return (/^(?:\S )+\S$/u.test(t) ? t.replace(/ /g, '') : t).slice(0, 40);
}

const norm = (s: string) => s.replace(/\s/g, '').toLowerCase();
/**
 * 데이터 키 후보 정렬(#147·#148): 이름과 같은 키 → 라벨(이름 부분)과 같은 키 → 이름을 품거나 이름에 든 키 → 라벨을 품거나 라벨에 든 키 → 나머지.
 * 같은 순위면 타입이 맞는 키(`keyType`: 견본 값·키 이름으로 추천한 타입)가 먼저, 그다음 원래 순서. 정렬만 하고 고르지는 않는다(R10).
 */
export function rankKeys(paths: readonly string[], want: { name: string; label?: string; type?: ValueType }, keyType?: (path: string) => ValueType | undefined): string[] {
  const name = norm(want.name), label = norm(labelName(want.label ?? ''));
  const near = (a: string, b: string) => a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
  const score = (path: string) => {
    const full = norm(path), last = norm(path.split('.').at(-1) ?? path);
    return name && (full === name || last === name) ? 4 : label && (full === label || last === label) ? 3 : near(last, name) ? 2 : near(last, label) ? 1 : 0;
  };
  return paths.map((p, i) => ({ p, i, s: score(p), t: want.type !== undefined && keyType?.(p) === want.type ? 1 : 0 }))
    .sort((a, b) => b.s - a.s || b.t - a.t || a.i - b.i).map(x => x.p);
}

/** 다른 문서에서 찾은 자리: 앞뒤 글이 맞은 곳(`context`) 또는 라벨로 찾은 곳(`label`) */
export type FoundPlace = { row: string; start: number; end: number; by: 'context' | 'label' };
const EDGE = 12;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 자리 재탐색(#148. 화면은 후속): 저장한 앞뒤 글·라벨로 다른 문서의 줄에서 자리를 찾는다. 결과는 문서 순서이고 여럿일 수 있다(고르는 것은 쓰는 쪽).
 * ① 앞 글 끝 12자와 뒤 글 처음 12자 사이(앞 글이 없으면 문단 처음부터, 뒤 글이 없으면 문단 끝까지)
 * ② 라벨이 `라벨:`이면 그 쌍점 뒤(뒤 글이 있으면 그 앞까지) ③ 행 머리면 그 글만 있는 줄에서 `distance`줄 뒤 줄 전체(칸마다 문단 하나일 때 맞는 어림).
 */
export function refind(rows: readonly { id: string; text: string }[], saved: Pick<InputItem, 'label' | 'before' | 'after'>): FoundPlace[] {
  const out: FoundPlace[] = [], b = (saved.before ?? '').slice(-EDGE), a = (saved.after ?? '').slice(0, EDGE);
  const add = (row: string, start: number, end: number, by: FoundPlace['by']) => {
    if (end > start && !out.some(p => p.row === row && p.start === start && p.end === end)) out.push({ row, start, end, by });
  };
  /** 뒤 글 앞까지(앞뒤 글로 찾을 때는 뒤 글이 꼭 맞아야 하고, 라벨로 찾을 때는 없으면 문단 끝까지) */
  const until = (text: string, start: number, strict = true) => { const at = a ? text.indexOf(a, start) : text.length; return at < 0 && !strict ? text.length : at; };
  if (b || a) for (const r of rows) {
    if (!b) { add(r.id, 0, until(r.text, 0), 'context'); continue; }
    for (let i = r.text.indexOf(b); i >= 0; i = r.text.indexOf(b, i + 1)) add(r.id, i + b.length, until(r.text, i + b.length), 'context');
  }
  const label = saved.label;
  if (label?.rel === 'colon') {
    const re = new RegExp(escapeRe(label.text) + '\\s*[:：]\\s*', 'gu');
    for (const r of rows) for (const m of r.text.matchAll(re)) add(r.id, m.index + m[0].length, until(r.text, m.index + m[0].length, false), 'label');
  }
  if (label?.rel === 'rowHeader') rows.forEach((r, i) => {
    const next = rows[i + label.distance];
    if (r.text.replaceAll('\uFFFC', '').trim() === label.text && next) add(next.id, 0, next.text.length, 'label');
  });
  return out;
}

/** 확정할 줄의 원문 글, 지금 편집 글, 바꿀 수 없는 이유(직접 편집할 수 없는 줄·블록 범위) */
export type ConfirmRow = { text: string; current: string; blocked?: string };
/** 확정 계획: 확정할 것, 남길 것(이유), 줄마다 새 편집 글, 줄마다 글을 바꾸는 항목 */
export type ConfirmPlan<T> = { ready: { item: T; name: string; key: string }[]; failed: [T, string][]; texts: Map<string, string>; rows: Map<string, { item: T; name: string; key: string }[]> };
/**
 * 확정(✓)의 계획: 이름·키를 검사하고, 누름틀·메일머지·같은 키의 `{{키}}`가 아니면 줄마다 그 자리 글을 `{{키}}`로 바꾼 새 편집 글을 만든다.
 * 확정할 수 없는 항목은 이유와 함께 `failed`로 남긴다. 항목은 바꾸지 않는다(`commitConfirm`이 바꾼다).
 */
export function planConfirm<T extends InputItem>(all: readonly T[], list: readonly { item: T; name?: string; key?: string }[], rowOf: (id: string) => ConfirmRow): ConfirmPlan<T> {
  const plan: ConfirmPlan<T> = { ready: [], failed: [], texts: new Map(), rows: new Map() };
  for (const x of list) {
    const r = x.item, name = (x.name ?? '').trim(), key = keyFor(r, name, x.key ?? '');
    if (r.status === 'excluded') plan.failed.push([r, '제외한 항목입니다.']);
    else if (!name) plan.failed.push([r, '이름을 적으세요.']);
    else if (!isField(r.origin) && !validKey(key)) plan.failed.push([r, '데이터 키에는 글자·숫자·밑줄을 쓰고 하위 항목은 점으로 구분하세요.']);
    else if (r.status === 'confirmed' && key !== r.key) plan.failed.push([r, '확정한 키는 실행 취소(Ctrl+Z)로 확정을 되돌린 뒤 바꾸세요.']);
    else plan.ready.push({ item: r, name, key });
  }
  for (const x of plan.ready) if (x.item.status !== 'confirmed' && !isField(x.item.origin) && !samePlaceholder(rowOf(x.item.row).text.slice(x.item.start, x.item.end), x.key))
    plan.rows.set(x.item.row, [...(plan.rows.get(x.item.row) ?? []), x]);
  for (const [id, xs] of plan.rows) {
    const row = rowOf(id), targets = new Set(xs.map(x => x.item));
    if (row.blocked) { dropRow(plan, id, row.blocked); continue; }
    const result = confirmText(row.text, row.current, repsOf(all.filter(i => !targets.has(i)), id, row.text), xs.map(x => ({ start: x.item.start, end: x.item.end, key: x.key })));
    if ('fail' in result) dropRow(plan, id, result.fail === 'overlap' ? '이미 확정한 입력 항목과 겹칩니다.' : '고친 글에 걸쳐 원문 위치를 찾을 수 없습니다.');
    else plan.texts.set(id, result.text);
  }
  return plan;
}
/** 한 줄의 글을 바꾸는 확정을 이유와 함께 남긴다(서버의 글자 모양 검사가 거절한 줄 등) */
export function dropRow<T>(plan: ConfirmPlan<T>, row: string, why: string): void {
  for (const x of plan.rows.get(row) ?? []) { plan.failed.push([x.item, why]); plan.ready.splice(plan.ready.indexOf(x), 1); }
  plan.rows.delete(row); plan.texts.delete(row);
}
/** 계획대로 확정한다: 이름·키를 넣고 상태를 확정으로(자동 이름·자동 키 표시는 끈다) */
export function commitConfirm<T extends InputItem>(ready: ConfirmPlan<T>['ready']): void {
  for (const x of ready) Object.assign(x.item, { name: x.name, key: x.key, keyAuto: false, nameAuto: false, status: 'confirmed' });
}

/** 선택 상세의 연결 글: 확정한 항목은 확정한 키, 아니면 연결 후보·연결 전 */
export const linkNote = (status: ItemStatus | undefined, key: string): string =>
  status === 'confirmed' ? '확정 · ' + key : key ? '연결 후보 · 확정 뒤 적용' : '연결 전';
/** 표 한 줄의 읽기 이름(✓ 단추·유지 체크). 이름을 고칠 때마다 다시 단다 */
export const rowAria = (name: string): { ok: string; keep: string } => ({ ok: (name.trim() || '이 줄') + ' 확정', keep: (name.trim() || '이름 없는 항목') + ' 유지' });
