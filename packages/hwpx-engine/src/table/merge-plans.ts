import { mergePlans, type EditPlan } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";

const key = (e: EditPlan["edits"][number]): string => `${e.entry}\u0000${e.start}\u0000${e.end}\u0000${e.replacement}`;

/**
 * 표 계획들을 하나로 합친다. 표 계획은 저마다 그 구역의 줄 배치 캐시를 전부 지우므로 같은 구역을 다룬 계획끼리는 같은 편집(같은 구간을 같은 글로 바꾸는 것)이 겹친다.
 * 이 함수는 완전히 같은 편집을 하나로 줄인 뒤 `mergePlans`로 합친다. 서로 다른 편집이 겹치면 `EDIT_OVERLAP`이다.
 */
export function mergeTablePlans(...plans: EditPlan[]): EditPlan {
  const seen = new Set<string>();
  let out: EditPlan = { edits: [], additions: [], summary: {}, issues: [] };
  for (const plan of plans) {
    if (typeof plan !== "object" || plan === null || !Array.isArray(plan.edits) || plan.edits.some((e) => typeof e !== "object" || e === null)) throw new HwpxError("TABLE_BAD_ARG", "plans는 편집 계획(EditPlan)이어야 합니다.");
    const edits = plan.edits.filter((e) => {
      if (e.start === e.end) return true; // 길이 0 삽입은 같은 자리에 여럿일 수 있고 순서가 뜻을 가진다
      const k = key(e);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    out = mergePlans(out, { ...plan, edits });
  }
  return out;
}
