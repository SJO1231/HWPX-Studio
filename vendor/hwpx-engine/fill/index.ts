export { resolveAnchors, makeLineAnchor, makeWordAnchor, linePrintOf, wordPrintAt, WORD_CONTEXT, LINE_PREFIX, type AnchorResolution, type ResolvedAnchor } from "./anchors.ts";
export { collectFields, type FieldTarget } from "./fields.ts";
export { buildFillPlan, loadFragment, type FillOptions, type FillPlan, type InjectStep, type Expectation } from "./plan.ts";
export { executeFillPlan, type ExecuteHooks, type ExecuteResult, type StageRecord } from "./execute.ts";
export { verifyPreservation, verifyChain, verifyExpectations } from "./verify.ts";
export { censusOfDoc, verifyCensus, type Delta } from "./census.ts";
export { enclosingTables, type RepeatStep, type FitChange } from "./table-actions.ts";
export {
  generate,
  type GateMode,
  type GenerateOptions,
  type GenerateReport,
  type GenerateResult,
  type InheritedReport,
  type Ledger,
  type LedgerAction,
  type ValidationSummary,
} from "./gate.ts";
export { explainInherited, mergeInherited, noInherited, splitTolerated } from "./inherited.ts";
export { planCompile, compileDocument, type CompileTarget, type CompileResult, type CompileReport } from "./compile.ts";
export { findCandidates, type Candidate, type CandidateKind, type AnchorDraft } from "./candidates.ts";
export { draftAnchors, type DraftRequest } from "./draft.ts";
