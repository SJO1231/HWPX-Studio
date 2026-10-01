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
 * 코드와 메시지에 든 id 값을 함께 맞춘다: 같은 코드라도 기록에 없는 값의 오류는 설명되지 않는다.
 * - `INST_DUP_ID`: id 공간(문단·객체·instId·누름틀)과 값이 `duplicateIds`에 있다.
 * - `FIELD_MULTI_END`: 시작 id가 같은 누름틀 시작이 조각 안에 둘 이상 있었다(`fieldBegin`의 `duplicateIds`).
 * - `RES_DANGLING`: 대상 종류와 id 값이 `danglingRefs`에 있다.
 */
export function explainInherited(
  errors: readonly ValidationIssue[],
  inherited: InheritedProblems,
): { explained: ValidationIssue[]; unexplained: ValidationIssue[] } {
  const dup = new Set(inherited.duplicateIds.map((d) => JSON.stringify([SPACE_OF_ROLE[d.role], d.value])));
  const fieldDup = new Set(inherited.duplicateIds.filter((d) => d.role === "fieldBegin").map((d) => d.value));
  const dangling = new Set(inherited.danglingRefs.map((d) => JSON.stringify([SPACE_OF_KIND[d.kind] ?? d.kind, d.id])));
  const explains = (e: ValidationIssue): boolean => {
    if (e.code === "INST_DUP_ID") {
      const m = /^(.+) 중복: '(.*)' x\d+$/s.exec(e.message);
      return m !== null && dup.has(JSON.stringify([m[1], m[2]]));
    }
    if (e.code === "FIELD_MULTI_END") {
      const m = /^fieldBegin id='(.*)' 에 fieldEnd 가 \d+개$/s.exec(e.message);
      return m !== null && fieldDup.has(m[1] ?? "");
    }
    if (e.code === "RES_DANGLING") {
      for (const [pattern, pick] of DANGLING_PATTERNS) {
        const m = pattern.exec(e.message);
        if (m === null) continue;
        const [value, space] = pick(m);
        return value !== undefined && space !== undefined && dangling.has(JSON.stringify([space, value]));
      }
    }
    return false;
  };
  const explained: ValidationIssue[] = [];
  const unexplained: ValidationIssue[] = [];
  for (const e of errors) (explains(e) ? explained : unexplained).push(e);
  return { explained, unexplained };
}
