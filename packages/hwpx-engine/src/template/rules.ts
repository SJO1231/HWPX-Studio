import { evaluateCondition } from "./condition.ts";
import type { Dataset, Rule, Template } from "./types.ts";

export type RuleSelection = {
  /** 조건이 참(또는 조건 없음)인 규칙. 템플릿에 적힌 순서 */
  active: Rule[];
  /** 조건이 거짓인 규칙 */
  inactive: Rule[];
};

/** 규칙을 순서대로 평가해 참인 것만 남긴다. `when`이 없으면 항상 참이다. */
export function selectRules(template: Template, dataset: Dataset): RuleSelection {
  const out: RuleSelection = { active: [], inactive: [] };
  for (const rule of template.rules) {
    (rule.when === undefined || evaluateCondition(rule.when, dataset) ? out.active : out.inactive).push(rule);
  }
  return out;
}
