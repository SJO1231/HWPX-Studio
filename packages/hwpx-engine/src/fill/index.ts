export { resolveAnchors, makeLineAnchor, makeWordAnchor, linePrintOf, wordPrintAt, WORD_CONTEXT, LINE_PREFIX, type AnchorResolution, type ResolvedAnchor } from "./anchors.ts";
export { collectFields, fieldFillBlock, type FieldTarget } from "./fields.ts";
export { makeRangeAnchor, locateRange, rangePrintOf, type FoundRange, type RangeDraft, type RangeLocation } from "./range.ts";
export { makeCellAnchor, makeObjectAnchor, cellPrintOf, objectPrintOf } from "./prints.ts";
export { remapAddress } from "./moves.ts";
export type { RangeAnchor, RangePrint, ParagraphPrint, CellPrint, ObjectPrint, Move } from "./anchor-types.ts";
export { buildFillPlan, loadFragment, type FillOptions, type FillPlan, type InjectStep, type Expectation, type PlanReport } from "./plan.ts";
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
export { planCompile, compileDocument, type CompileTarget, type CompileResult, type CompileReport, type MergeFieldsMode } from "./compile.ts";
export { generateBatch, planBatchNames, safeFileStem, sanitizeFileStem, type BatchItem, type BatchOptions } from "./batch.ts";
export { findCandidates, type Candidate, type CandidateKind, type AnchorDraft } from "./candidates.ts";
export { draftAnchors, type DraftBlock, type DraftedAnchor, type DraftRequest } from "./draft.ts";
export { generateFromTemplate } from "./generate-studio.ts";
export type { BlobLoader, CoveredPlace, StudioGenerateOptions, StudioGenerateReport, StudioGenerateResult, StudioLedger, StudioValueReport } from "./studio-common.ts";
export { checkAnchors, planRelocation, redraftAnchor, type AnchorAddress, type AnchorCheck, type AnchorCheckState, type RedraftInput } from "./check-anchors.ts";
