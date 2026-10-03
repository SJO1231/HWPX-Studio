import { HwpxError } from "../errors.ts";
import type { ValidationReport } from "../validate/index.ts";
import { diffErrors, execute, regressionMessage } from "./plan.ts";
import type { RepairOptions, RepairResult } from "./types.ts";

/** 보정 뒤 보고서에 새 오류(기준 보고서보다 늘어난 오류)가 있으면 `REPAIR_REGRESSION`으로 중단한다. */
export function checkNoRegression(before: ValidationReport, after: ValidationReport): void {
  const { newErrors } = diffErrors(before, after);
  if (newErrors.length > 0) throw new HwpxError("REPAIR_REGRESSION", regressionMessage(newErrors));
}

/**
 * 보정 계획을 적용하고 다시 검사해 결과를 돌려준다. 보정으로 새 오류가 생기면 `REPAIR_REGRESSION`으로 중단한다(출력 없음).
 * ZIP으로 읽을 수 없는 입력은 고칠 것이 없으므로 입력의 복사본과 검사 보고서의 오류를 그대로 돌려준다.
 */
export function repairDocument(bytes: Uint8Array, options: RepairOptions = {}): RepairResult {
  const run = execute(bytes, undefined, options);
  checkNoRegression(run.baseline, run.after);
  return {
    output: run.output,
    repaired: run.plan.repaired,
    unrepaired: run.plan.unrepaired,
    before: run.before,
    after: run.after,
  };
}
