import type { BaselineComparison, ValidationIssue, ValidationReport } from "./types.ts";

function keyOf(i: ValidationIssue): string {
  return `${i.code}\u0000${i.message}\u0000${i.where ?? ""}`;
}

/** 오류를 (코드, 메시지, 위치)로 묶어 합친 개수를 낸다. */
function tally(errors: ValidationIssue[]): Map<string, { issue: ValidationIssue; count: number }> {
  const out = new Map<string, { issue: ValidationIssue; count: number }>();
  for (const e of errors) {
    const old = out.get(keyOf(e));
    if (old === undefined) out.set(keyOf(e), { issue: e, count: e.count });
    else old.count += e.count;
  }
  return out;
}

/**
 * 편집 전후의 오류를 견준다. 같은 (코드, 메시지, 위치)에서 전보다 늘어난 만큼이 newErrors,
 * 전후에 모두 있던 만큼(둘 중 작은 개수)이 preexisting, 줄어든 만큼이 resolved다. 경고는 견주지 않는다.
 */
export function compareToBaseline(before: ValidationReport, after: ValidationReport): BaselineComparison {
  const was = tally(before.errors);
  const now = tally(after.errors);
  const result: BaselineComparison = { newErrors: [], preexisting: [], resolved: [] };
  for (const [key, { issue, count }] of now) {
    const old = was.get(key)?.count ?? 0;
    if (count > old) result.newErrors.push({ ...issue, count: count - old });
    if (old > 0) result.preexisting.push({ ...issue, count: Math.min(count, old) });
  }
  for (const [key, { issue, count }] of was) {
    const cur = now.get(key)?.count ?? 0;
    if (count > cur) result.resolved.push({ ...issue, count: count - cur });
  }
  return result;
}
