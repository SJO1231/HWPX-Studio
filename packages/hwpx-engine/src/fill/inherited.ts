import type { InheritedDuplicate, InheritedProblems } from "../fragment/types.ts";
import type { ValidationIssue } from "../validate/index.ts";

/** 상속한 문제가 없는 기록 */
export const noInherited = (): InheritedProblems => ({ duplicateIds: [], danglingRefs: [] });

/** 여러 가져오기의 기록을 합친다(같은 (역할, 값)·(종류, id)는 개수를 더한다). */
export function mergeInherited(list: readonly InheritedProblems[]): InheritedProblems {
  const out = noInherited();
  for (const inherited of list) {
    for (const d of inherited.duplicateIds) {
      const found = out.duplicateIds.find((x) => x.role === d.role && x.value === d.value);
      if (found === undefined) out.duplicateIds.push({ ...d });
      else found.count += d.count;
    }
    for (const d of inherited.danglingRefs) {
      const found = out.danglingRefs.find((x) => x.kind === d.kind && x.id === d.id);
      if (found === undefined) out.danglingRefs.push({ ...d });
      else found.count += d.count;
    }
  }
  return out;
}

// 검사기(`validate/structure.ts`·`validate/resources.ts`)가 메시지에 쓰는 id 공간 이름
const SPACE_OF_ROLE: Record<InheritedDuplicate["role"], string> = {
  paragraph: "paragraph id",
  object: "object id (표·도형)",
  inst: "instId",
  fieldBegin: "field id",
};
// 조각의 참조 종류 → 검사기가 메시지에 쓰는 대상 공간 이름(그 밖의 종류는 같은 이름이다)
const SPACE_OF_KIND: Record<string, string> = { binaryItem: "binItem" };

// RES_DANGLING 메시지의 세 모양: 일반 참조, heading의 numbering·bullet 참조, 글꼴 참조. 각각 (id 값, 대상 공간)을 꺼낸다.
const DANGLING_PATTERNS: [RegExp, (m: RegExpExecArray) => [value: string | undefined, space: string | undefined]][] = [
  [/^\w+='(.*)' 가 가리키는 (\w+) 가 없음$/s, (m) => [m[1], m[2]]],
  [/^heading\(type=\w+\)\.idRef='(.*)' 가 가리키는 (\w+) 이 없음$/s, (m) => [m[1], m[2]]],
  [/^fontRef \w+='(.*)' 가 가리키는 글꼴이 \w+ 글꼴 목록에 없음$/s, (m) => [m[1], "font"]],
];

/**
 * 검사기의 새 오류 가운데 조각이 소스에서부터 갖고 있던 문제(`inherited`)로 설명되는 것과 아닌 것을 가른다.
 * 코드와 메시지에 든 id 값을 맞추고, 설명하는 양은 기록의 개수를 넘지 못한다: (코드, id 공간, 값)별로 새 오류의 발생 횟수
 * 증가분이 기록의 개수 이하일 때만 그만큼 설명하고, 넘는 부분은 설명하지 않는다(다른 편집이 만든 같은 오류가 기록에 가려지지 않게).
 * - `INST_DUP_ID`: id 공간(문단·객체·instId·누름틀)과 값이 `duplicateIds`에 있다. 발생 횟수는 메시지의 `xN`(그 값이 나온 횟수)이고,
 *   증가분은 `baseline`(편집 전 검사 오류)의 같은 오류의 `xN`을 뺀 값이다. 한 오류는 쪼갤 수 없어 증가분이 남은 개수를 넘으면 통째로 설명하지 않는다.
 * - `FIELD_MULTI_END`: 시작 id가 같은 누름틀 시작이 조각 안에 둘 이상 있었다(`fieldBegin`의 `duplicateIds`). 발생 횟수는 메시지의 끝 개수다.
 * - `RES_DANGLING`: 대상 종류와 id 값이 `danglingRefs`에 있다. 발생 횟수는 검사기가 센 `count`(같은 위치·메시지의 전후 증가분)이고,
 *   남은 개수보다 많으면 그 오류의 개수를 쪼개 설명되는 만큼만 `explained`에 둔다.
 */
export function explainInherited(
  errors: readonly ValidationIssue[],
  inherited: InheritedProblems,
  baseline: readonly ValidationIssue[] = [],
): { explained: ValidationIssue[]; unexplained: ValidationIssue[] } {
  // 남은 설명 예산: (코드, id 공간, 값) → 기록의 개수
  const budget = new Map<string, number>();
  const credit = (code: string, space: string, value: string, n: number): void => {
    const key = JSON.stringify([code, space, value]);
    budget.set(key, (budget.get(key) ?? 0) + n);
  };
  for (const d of inherited.duplicateIds) {
    credit("INST_DUP_ID", SPACE_OF_ROLE[d.role], d.value, d.count);
    if (d.role === "fieldBegin") credit("FIELD_MULTI_END", "", d.value, d.count);
  }
  for (const d of inherited.danglingRefs) credit("RES_DANGLING", SPACE_OF_KIND[d.kind] ?? d.kind, d.id, d.count);

  // 편집 전 검사 오류에서 같은 (코드, 공간, 값)의 발생 횟수(메시지에 횟수가 든 오류용)
  const before = (code: string, space: string, value: string): number =>
    Math.max(0, ...baseline.flatMap((b) => {
      const read = occurrenceOf(b);
      return read !== undefined && read.code === code && read.space === space && read.value === value ? [read.occurrences] : [];
    }));

  const explained: ValidationIssue[] = [];
  const unexplained: ValidationIssue[] = [];
  for (const e of errors) {
    const read = occurrenceOf(e);
    if (read === undefined) {
      unexplained.push(e);
      continue;
    }
    const key = JSON.stringify([read.code, read.space, read.value]);
    const left = budget.get(key);
    if (left === undefined) {
      unexplained.push(e);
      continue;
    }
    if (e.code === "RES_DANGLING") {
      // `count`가 이미 같은 위치·메시지의 증가분이다. 남은 개수까지만 설명하고 나머지는 설명하지 않는다.
      const take = Math.min(left, e.count);
      budget.set(key, left - take);
      if (take > 0) explained.push(take === e.count ? e : { ...e, count: take });
      if (take < e.count) unexplained.push({ ...e, count: e.count - take });
    } else {
      const increase = read.occurrences - before(read.code, read.space, read.value);
      if (increase <= left) {
        budget.set(key, left - Math.max(0, increase));
        explained.push(e);
      } else {
        unexplained.push(e);
      }
    }
  }
  return { explained, unexplained };
}

/** 검사 오류가 `explainInherited`의 설명 대상이면 (코드, id 공간, 값)과 발생 횟수를 읽는다. 아니면 undefined. */
function occurrenceOf(e: ValidationIssue): { code: string; space: string; value: string; occurrences: number } | undefined {
  if (e.code === "INST_DUP_ID") {
    const m = /^(.+) 중복: '(.*)' x(\d+)$/s.exec(e.message);
    return m === null ? undefined : { code: e.code, space: m[1] ?? "", value: m[2] ?? "", occurrences: Number(m[3]) };
  }
  if (e.code === "FIELD_MULTI_END") {
    const m = /^fieldBegin id='(.*)' 에 fieldEnd 가 (\d+)개$/s.exec(e.message);
    return m === null ? undefined : { code: e.code, space: "", value: m[1] ?? "", occurrences: Number(m[2]) };
  }
  if (e.code === "RES_DANGLING") {
    for (const [pattern, pick] of DANGLING_PATTERNS) {
      const m = pattern.exec(e.message);
      if (m === null) continue;
      const [value, space] = pick(m);
      return value === undefined || space === undefined ? undefined : { code: e.code, space, value, occurrences: e.count };
    }
  }
  return undefined;
}

/**
 * 새 오류 가운데 기준선에서 한컴이 받아 주는 경고(`RES_DANGLING_TOLERATED`)였던 같은 참조가 오류(`RES_DANGLING`)로 올라온 것을 "원래 있던 문제"로 가른다.
 * 검사기는 "탭 목록이 비었는데 tabPrIDRef=0"을 경고로 두지만 목록에 항목이 생기면 같은 참조를 오류로 올린다. 편집이 만든 문제가 아니므로 새 오류로 세지 않는다.
 * (대상 종류, id 값)이 기준선의 관용 경고와 같아야 하고, 설명하는 양은 그 경고의 발생 횟수를 넘지 못한다(넘는 부분은 `rest`에 남는다).
 */
export function splitTolerated(
  errors: readonly ValidationIssue[],
  baselineWarnings: readonly ValidationIssue[],
): { original: ValidationIssue[]; rest: ValidationIssue[] } {
  // (대상 공간, id 값) → 기준선의 관용 경고 발생 횟수. 경고 메시지는 `<이름>IDRef='<값>'`으로 참조를 밝힌다(tabPrIDRef → tabPr, borderFillIDRef → borderFill).
  const budget = new Map<string, number>();
  for (const w of baselineWarnings) {
    if (w.code !== "RES_DANGLING_TOLERATED") continue;
    const m = /(\w+)IDRef='([^']*)'/.exec(w.message);
    if (m === null) continue;
    const key = JSON.stringify([m[1], m[2]]);
    budget.set(key, (budget.get(key) ?? 0) + w.count);
  }
  const original: ValidationIssue[] = [];
  const rest: ValidationIssue[] = [];
  for (const e of errors) {
    const read = e.code === "RES_DANGLING" ? occurrenceOf(e) : undefined;
    const key = read === undefined ? undefined : JSON.stringify([read.space, read.value]);
    const left = key === undefined ? undefined : budget.get(key);
    if (key === undefined || left === undefined) {
      rest.push(e);
      continue;
    }
    const take = Math.min(left, e.count);
    budget.set(key, left - take);
    if (take > 0) original.push(take === e.count ? e : { ...e, count: take });
    if (take < e.count) rest.push({ ...e, count: e.count - take });
  }
  return { original, rest };
}
