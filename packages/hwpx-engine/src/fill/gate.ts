import { makeIssue, type Issue } from "../errors.ts";
import { parseDocument } from "../model/document.ts";
import type { InheritedProblems } from "../fragment/types.ts";
import { openPackage } from "../package/open.ts";
import { canonicalJson, sha256Hex } from "../template/hash.ts";
import type { Dataset, FillReport, Template } from "../template/types.ts";
import { compareToBaseline, validateDocument, type ValidationIssue, type ValidationReport } from "../validate/index.ts";
import { executeFillPlan, type ExecuteHooks } from "./execute.ts";
import { explainInherited, noInherited } from "./inherited.ts";
import { buildFillPlan, type FillOptions } from "./plan.ts";
import { verifyChain } from "./verify.ts";

export type GateMode = "baseline" | "strict" | "repair";

export type GenerateOptions = FillOptions & {
  /** 저장 게이트 방식. 기본 `baseline`. */
  mode?: GateMode;
  /** 계획까지만 만들어 보고서를 돌려준다(출력 없음). */
  dryRun?: boolean;
  /**
   * `mode: "repair"`에서 쓸 보정 함수(`src/repair`의 `repairDocument`가 맞는다). 없으면 `FILL_REPAIR_UNAVAILABLE`.
   * 보정한 결과가 이후의 원본이 된다.
   */
  repair?: (bytes: Uint8Array) => { output: Uint8Array; repaired: unknown[] };
  /** 시험 전용 훅: 단계마다 적용 직후 바이트를 바꿔 게이트가 결함을 잡는지 본다. */
  testHooks?: ExecuteHooks;
};

export type ValidationSummary = { errors: number; warnings: number };

/**
 * 상속: 주입한 조각들이 소스에서부터 갖고 있던 문제(조각 안에서 겹치는 id, 소스에서 없던 참조)와, 그로 설명되는 검사기 오류.
 * `baseline`·`repair` 방식은 이 오류를 대상의 새 오류로 세지 않고 경고(`GATE_INHERITED`)로 보고한다. `strict`는 가리지 않고 막는다.
 */
export type InheritedReport = InheritedProblems & { errors: ValidationIssue[] };

export type GenerateReport = {
  mode: GateMode;
  dryRun: boolean;
  /** 채움 계획 보고서(값 원문 없음) */
  plan: FillReport;
  /** 상속한 문제와 그것으로 설명되는 검사 오류(`validation.newErrors`에는 들어 있지 않다) */
  inherited: InheritedReport;
  /** 검사 결과 요약과 기준선 대조(계획 단계에서 막혔으면 비어 있다) */
  validation: {
    before: ValidationSummary;
    after: ValidationSummary;
    newErrors: ValidationIssue[];
    preexisting: ValidationIssue[];
    resolved: ValidationIssue[];
  } | null;
  /** 보정을 적용했다면 그 수 */
  repaired: number | null;
  /** 적용한 단계(주 계획과 조각 주입)와 단계별 편집 수 */
  stages: { label: string; edits: number; additions: number }[];
  /** 값 재읽기로 확인한 누름틀·문단 수 */
  reread: { fields: number; paragraphs: number };
  /** 오류와 경고 전부(계획·단계 확인·검사·원래 있던 오류의 경고 포함) */
  issues: Issue[];
};

export type LedgerAction = { ruleId: string; type: string; anchor: string; targets: number; value?: { length: number; sha256: string } };

/** 결정적인 기록. 시각이 없고 값 원문도 없다(길이와 sha256 앞 8자만). */
export type Ledger = {
  schema: "hwpx-studio/ledger@1";
  mode: GateMode;
  input: { sha256: string; bytes: number };
  /** 보정을 적용했다면 보정한 결과(이후의 원본) */
  repaired?: { sha256: string; notes: number };
  template: { sha256: string };
  dataset: { sha256: string };
  fragments: { key: string; sha256: string }[];
  output: { sha256: string; bytes: number };
  counts: { actions: number; skipped: number; dropped: number; relocated: number; stages: number; edits: number; additions: number };
  expected: Record<string, number>;
  actions: LedgerAction[];
};

export type GenerateResult =
  | { ok: true; dryRun: false; output: Uint8Array; report: GenerateReport; ledger: Ledger }
  | { ok: true; dryRun: true; report: GenerateReport }
  | { ok: false; report: GenerateReport };

const errorsOf = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error");
const summary = (r: ValidationReport): ValidationSummary => ({ errors: r.errors.length, warnings: r.warnings.length });
const toIssue = (v: ValidationIssue, severity: Issue["severity"], prefix = ""): Issue => {
  const issue: Issue = { severity, code: v.code, message: `${prefix}${v.message}${v.count > 1 ? ` (${v.count}건)` : ""}` };
  if (v.where !== undefined) issue.where = v.where;
  return issue;
};

/**
 * 저장 게이트. 열기·파싱·기준선 검사 → `buildFillPlan` → 적용·재파싱 → 검사 → 판정 → 보존 확인 → 값 재읽기 →
 * 전부 통과하면 `{ ok: true, output, report, ledger }`, 아니면 `{ ok: false, report }`(출력 없음).
 *
 * - 방식: `baseline`은 편집이 새로 만든 오류가 0이어야 하고(원래 있던 오류는 경고로 보고), `strict`는 오류가 0이어야 한다.
 *   `repair`는 주입된 보정 함수로 먼저 고친 결과를 원본으로 삼고 그 위에서 `baseline`으로 판정한다.
 * - 입력을 열 수 없으면(`PKG_*`·`XML_*`·`MODEL_*`) `HwpxError`를 던진다.
 * - 같은 입력으로 다시 돌리면 출력 바이트가 같다.
 */
export function generate(bytes: Uint8Array, template: Template, dataset: Dataset, options: GenerateOptions = {}): GenerateResult {
  const mode: GateMode = options.mode ?? "baseline";
  const dryRun = options.dryRun === true;
  const issues: Issue[] = [];
  const report: GenerateReport = {
    mode,
    dryRun,
    plan: { actions: [], skipped: [], dropped: [], relocated: [], kept: [], requiredPaths: [], missingPaths: [], inactiveRules: [], expected: {}, issues: [] },
    inherited: { ...noInherited(), errors: [] },
    validation: null,
    repaired: null,
    stages: [],
    reread: { fields: 0, paragraphs: 0 },
    issues,
  };
  const failed = (): GenerateResult => ({ ok: false, report });

  // 1. 보정(repair 방식), 기준선 검사
  let source = bytes;
  let repairedCount = 0;
  if (mode === "repair") {
    if (options.repair === undefined) {
      issues.push(makeIssue("error", "FILL_REPAIR_UNAVAILABLE", "repair 방식에는 보정 함수(options.repair)가 필요합니다."));
      return failed();
    }
    const result = options.repair(bytes);
    source = result.output;
    repairedCount = result.repaired.length;
    report.repaired = repairedCount;
    const regression = compareToBaseline(validateDocument(bytes), validateDocument(source)).newErrors;
    if (regression.length > 0) {
      for (const v of regression) issues.push(toIssue(v, "error", "보정이 만든 오류: "));
      issues.push(makeIssue("error", "GATE_REPAIR_REGRESSED", "보정이 새 오류를 만들었습니다."));
      return failed();
    }
  }
  const before = validateDocument(source);
  const doc = parseDocument(openPackage(source));

  // 2. 계획
  const built = buildFillPlan(doc, template, dataset, options);
  report.plan = built.report;
  issues.push(...built.report.issues);
  if (errorsOf(built.report.issues).length > 0) return failed();
  if (dryRun) return { ok: true, dryRun: true, report };

  // 3. 적용·재파싱(단계마다 보존·수량·값 재읽기 확인)
  const exec = executeFillPlan(doc, built.plan, options.testHooks);
  issues.push(...exec.issues);
  report.stages = exec.stages.map((s) => ({ label: s.label, edits: s.plan.edits.length, additions: s.plan.additions.length }));
  report.reread = exec.checked;
  report.inherited = { ...exec.inherited, errors: [] };
  if (!exec.ok || exec.output === undefined) return failed();
  const output = exec.output;
  issues.push(...verifyChain(source, output, exec.stages.map((s) => s.plan), "최종 출력"));
  if (errorsOf(issues).length > 0) return failed();

  // 4. 검사와 판정
  const after = validateDocument(output, { strict: mode === "strict" });
  const cmp = compareToBaseline(before, after);
  // 조각이 소스에서부터 갖고 있던 문제로 설명되는 새 오류는 새 오류로 세지 않고 상속으로 따로 보고한다(strict는 가리지 않는다)
  const { explained, unexplained } = mode === "strict" ? { explained: [], unexplained: cmp.newErrors } : explainInherited(cmp.newErrors, exec.inherited);
  report.inherited.errors = explained;
  report.validation = {
    before: summary(before),
    after: summary(after),
    newErrors: unexplained,
    preexisting: cmp.preexisting,
    resolved: cmp.resolved,
  };
  for (const v of cmp.preexisting) issues.push(toIssue(v, "warning", "원래 있던 오류: "));
  for (const v of explained) issues.push(makeIssue("warning", "GATE_INHERITED", `조각이 소스에서 갖고 있던 문제로 설명되는 오류[${v.code}]: ${v.message}${v.count > 1 ? ` (${v.count}건)` : ""}`, v.where));
  if (mode === "strict") {
    if (after.errors.length > 0) {
      for (const v of after.errors) issues.push(toIssue(v, "error"));
      issues.push(makeIssue("error", "GATE_ERRORS", `엄격 방식: 검사 오류가 ${after.errors.length}종 있습니다.`));
    }
  } else if (unexplained.length > 0) {
    for (const v of unexplained) issues.push(toIssue(v, "error", "편집이 만든 오류: "));
    issues.push(makeIssue("error", "GATE_NEW_ERRORS", `기준선 방식: 편집이 새로 만든 오류가 ${unexplained.length}종 있습니다.`));
  }
  if (errorsOf(issues).length > 0) return failed();

  // 5. 원장
  const plan = built.plan;
  const ledger: Ledger = {
    schema: "hwpx-studio/ledger@1",
    mode,
    input: { sha256: sha256Hex(bytes), bytes: bytes.length },
    template: { sha256: sha256Hex(canonicalJson(template)) },
    dataset: { sha256: sha256Hex(canonicalJson(dataset)) },
    fragments: plan.fragmentDigests,
    output: { sha256: sha256Hex(output), bytes: output.length },
    counts: {
      actions: built.report.actions.length,
      skipped: built.report.skipped.length,
      dropped: built.report.dropped.length,
      relocated: built.report.relocated.length,
      stages: exec.stages.length,
      edits: exec.stages.reduce((n, s) => n + s.plan.edits.length, 0),
      additions: exec.stages.reduce((n, s) => n + s.plan.additions.length, 0),
    },
    expected: built.report.expected,
    actions: built.report.actions.map((a) => {
      const x: LedgerAction = { ruleId: a.ruleId, type: a.type, anchor: a.anchor, targets: a.targets };
      if (a.value !== undefined) x.value = a.value;
      return x;
    }),
  };
  if (mode === "repair") ledger.repaired = { sha256: sha256Hex(source), notes: repairedCount };
  return { ok: true, dryRun: false, output, report, ledger };
}
