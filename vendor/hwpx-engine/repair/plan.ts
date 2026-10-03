import { applyPlan, type EditPlan, type SpanEdit } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import type { HwpxPackage } from "../package/open.ts";
import { readArchive, type Archive } from "../package/zip-read.ts";
import { validateDocument, type ValidationIssue, type ValidationReport } from "../validate/index.ts";
import { mimetypeViolation, normalizeArchive } from "./archive.ts";
import { planRenameBookmarks } from "./bookmarks.ts";
import { planFixCounts, planFixSectionCount } from "./counts.ts";
import { HEADER_ENTRY, loadEntries, spanEdit, type EntryDoc, type Loaded } from "./entries.ts";
import { planReissueIds } from "./ids.ts";
import { planDropStaleLineSeg } from "./lineseg.ts";
import { planFallbackRefs } from "./refs.ts";
import {
  emptyPart,
  resolveOptions,
  type PlanPart,
  type RepairKind,
  type RepairNote,
  type RepairOptions,
  type RepairPlan,
} from "./types.ts";

const KIND_ORDER: RepairKind[] = [
  "reissueIds",
  "fixCounts",
  "fixSectionCount",
  "dropStaleLineSeg",
  "stripIllegalChars",
  "renameBookmarks",
  "fallbackRefs",
  "normalizePackage",
];

/** 계획의 `summary` 키 */
const SUMMARY_KEY: Record<RepairKind, string> = {
  reissueIds: "reissuedIds",
  fixCounts: "fixedCounts",
  fixSectionCount: "fixedSectionCounts",
  dropStaleLineSeg: "droppedLineSegs",
  stripIllegalChars: "strippedChars",
  renameBookmarks: "renamedBookmarks",
  fallbackRefs: "fallbackRefs",
  normalizePackage: "normalizedPackages",
};

/** 금지 문자 지우기: 글 데이터 안의 금지 문자(문자 그대로, 숫자 참조)를 구간 삭제로 낸다. */
function planStripIllegalChars(docs: EntryDoc[], subsumed: (e: SpanEdit) => boolean): PlanPart {
  const part = emptyPart();
  for (const doc of docs) {
    let chars = 0;
    let refs = 0;
    for (const s of doc.strips) {
      const edit = spanEdit(doc, s.start, s.end, "", "XML 금지 문자 제거");
      if (subsumed(edit)) continue;
      part.edits.push(edit);
      chars += s.chars;
      refs += s.refs;
    }
    if (chars + refs > 0) {
      part.notes.push({
        kind: "stripIllegalChars",
        entry: doc.entry,
        what: "control char",
        count: chars + refs,
        detail: `글 데이터 안의 금지 문자 ${chars}개, 금지 문자를 가리키는 숫자 참조 ${refs}개`,
      });
    }
  }
  return part;
}

/** `applyPlan`은 `archive`와 `bytes`만 읽는다. 구조가 온전하지 않은 문서도 보정하므로 `openPackage` 대신 필요한 필드만 채운다. */
function packageFor(bytes: Uint8Array, loaded: Loaded): HwpxPackage {
  return {
    archive: loaded.archive,
    bytes,
    rootfile: "Contents/content.hpf",
    headerEntry: HEADER_ENTRY,
    sectionEntries: loaded.sectionNames,
    manifestItems: [],
    binaryEntries: [],
    issues: [],
  };
}

function isReport(x: unknown): x is ValidationReport {
  return typeof x === "object" && x !== null && "errors" in x && "warnings" in x && "census" in x;
}

/** 입력 정리: `planRepair(bytes, options)`와 `planRepair(bytes, report, options)`를 모두 받는다. */
export function splitArgs(
  second: ValidationReport | RepairOptions | undefined,
  third: RepairOptions | undefined,
): { report: ValidationReport | undefined; options: RepairOptions | undefined } {
  if (isReport(second)) return { report: second, options: third };
  return { report: undefined, options: second ?? third };
}

// 표 구조 오류(TBL_*)의 위치는 표 id를 담는다(`항목 tbl id=값`). id 재발급이 위치를 바꾸므로 비교에서는 id를 뺀다.
const TABLE_ID_IN_WHERE = / tbl id=.*$/;

function errorKey(i: ValidationIssue): string {
  return JSON.stringify([i.code, i.message, (i.where ?? "").replace(TABLE_ID_IN_WHERE, " tbl id=*")]);
}

function tally(list: ValidationIssue[]): Map<string, { issue: ValidationIssue; count: number }> {
  const out = new Map<string, { issue: ValidationIssue; count: number }>();
  for (const e of list) {
    const key = errorKey(e);
    const old = out.get(key);
    if (old === undefined) out.set(key, { issue: e, count: e.count });
    else old.count += e.count;
  }
  return out;
}

/**
 * 보정 전후의 오류를 (코드, 메시지, 위치)로 견준다. `compareToBaseline`과 같되 표 id를 뺀 위치로 묶는다.
 * `newErrors`는 늘어난 만큼, `preexisting`은 전후에 모두 있던 만큼(보정 뒤의 항목)이다.
 */
export function diffErrors(
  before: ValidationReport,
  after: ValidationReport,
): { newErrors: ValidationIssue[]; preexisting: ValidationIssue[] } {
  const was = tally(before.errors);
  const out: { newErrors: ValidationIssue[]; preexisting: ValidationIssue[] } = { newErrors: [], preexisting: [] };
  for (const [key, { issue, count }] of tally(after.errors)) {
    const old = was.get(key)?.count ?? 0;
    if (count > old) out.newErrors.push({ ...issue, count: count - old });
    if (old > 0) out.preexisting.push({ ...issue, count: Math.min(count, old) });
  }
  return out;
}

export type Run = {
  plan: RepairPlan;
  output: Uint8Array;
  before: ValidationReport;
  after: ValidationReport;
  /**
   * 새 오류를 가리는 기준. 보정 전 보고서이되, 금지 문자 때문에 읽지 못하던 항목을 읽게 되면 그 항목에 원래 있던
   * 오류가 처음 드러난다. 그것은 보정이 만든 오류가 아니므로 금지 문자 지우기만 적용한 문서의 보고서를 기준으로 삼는다.
   */
  baseline: ValidationReport;
  /** 기준보다 새로 생기거나 늘어난 오류 */
  newErrors: ValidationIssue[];
};

/**
 * 계획을 만들고, 메모리에서 적용해 다시 검사한다. 파일은 쓰지 않는다.
 * `unrepaired`는 적용 뒤에도 남는 원래 오류다(실제로 적용해 보고 정하므로 보정이 놓친 것까지 정확히 나온다).
 */
export function execute(bytes: Uint8Array, report: ValidationReport | undefined, rawOptions: RepairOptions | undefined): Run {
  const opts = resolveOptions(rawOptions);
  const before = report ?? validateDocument(bytes);
  const emptyPlan = (): EditPlan => ({ edits: [], additions: [], summary: {}, issues: [] });

  let archive: Archive;
  try {
    archive = readArchive(bytes);
  } catch (e) {
    // ZIP으로 읽을 수 없는 입력은 보정할 것이 없다. 검사 보고서의 오류가 그대로 남는다.
    if (!(e instanceof HwpxError)) throw e;
    const unrepaired: Issue[] = [...before.errors];
    return {
      plan: { plan: emptyPlan(), repaired: [], unrepaired, needsNormalize: false },
      output: new Uint8Array(bytes),
      before,
      after: before,
      baseline: before,
      newErrors: [],
    };
  }

  const loaded = loadEntries(bytes, archive, opts.stripIllegalChars);
  const parts: PlanPart[] = [];
  if (opts.reissueIds !== false) parts.push(planReissueIds(loaded.sections, opts.reissueIds));
  if (opts.fixCounts) parts.push(planFixCounts(loaded.header));
  if (opts.fixSectionCount) parts.push(planFixSectionCount(loaded.header, loaded.sectionNames.length));
  if (opts.dropStaleLineSeg) parts.push(planDropStaleLineSeg(loaded.sections));
  if (opts.renameBookmarks) parts.push(planRenameBookmarks(loaded.sections));
  if (opts.fallbackRefs) parts.push(planFallbackRefs(loaded.header, loaded.sections));

  // 줄 배치 캐시 요소를 통째로 지우는 구간 안의 금지 문자는 따로 지울 필요가 없다(겹치면 EDIT_OVERLAP).
  const deletions = parts.flatMap((p) => p.edits).filter((e) => e.replacement === "" && e.end > e.start);
  const subsumed = (edit: SpanEdit): boolean =>
    deletions.some((d) => d.entry === edit.entry && d.start <= edit.start && edit.end <= d.end);
  const stripDocs = [loaded.header, ...loaded.sections].filter((d): d is EntryDoc => d !== null);
  const strip = opts.stripIllegalChars ? planStripIllegalChars(stripDocs, subsumed) : emptyPart();
  parts.push(strip);

  const needsNormalize = opts.normalizePackage && mimetypeViolation(archive);
  const repaired: RepairNote[] = parts.flatMap((p) => p.notes);
  if (needsNormalize) {
    repaired.push({
      kind: "normalizePackage",
      entry: "mimetype",
      what: "package order",
      count: 1,
      detail: "mimetype을 첫 항목·무압축으로 두고 나머지 항목은 원래 순서와 압축 방식으로 다시 배열",
    });
  }
  repaired.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  const issues: Issue[] = parts.flatMap((p) => p.issues);
  for (const s of loaded.skipped) {
    issues.push(makeIssue("warning", "REPAIR_ENTRY_SKIPPED", `읽을 수 없어 보정하지 않았습니다(${s.reason}).`, s.entry));
  }
  const summary: Record<string, number> = {};
  for (const n of repaired) summary[SUMMARY_KEY[n.kind]] = (summary[SUMMARY_KEY[n.kind]] ?? 0) + n.count;
  const plan: EditPlan = { edits: parts.flatMap((p) => p.edits), additions: [], summary, issues };

  const pkg = packageFor(bytes, loaded);
  let output: Uint8Array;
  if (plan.edits.length === 0 && !needsNormalize) {
    output = new Uint8Array(bytes);
  } else {
    output = applyPlan(pkg, plan);
    if (needsNormalize) output = normalizeArchive(output);
  }
  const changed = plan.edits.length > 0 || needsNormalize;
  const after = changed ? validateDocument(output) : before;

  // 금지 문자 지우기가 있으면 그것만 적용한 문서를 기준으로 삼는다(다른 보정이 없으면 그 결과가 곧 최종 문서다).
  let baseline = before;
  if (strip.edits.length > 0) {
    const stripOnly = plan.edits.length === strip.edits.length && !needsNormalize;
    baseline = stripOnly ? after : validateDocument(applyPlan(pkg, { ...plan, edits: strip.edits }));
  }
  const cmp = diffErrors(baseline, after);
  return {
    plan: { plan, repaired, unrepaired: cmp.preexisting, needsNormalize },
    output,
    before,
    after,
    baseline,
    newErrors: cmp.newErrors,
  };
}

/**
 * 검사기가 잡은 오류 중 안전하게 고칠 수 있는 것을 구간 치환 계획으로 만든다.
 * `planRepair(bytes, options)` 또는 `planRepair(bytes, report, options)`로 부른다. 보고서를 주면 그것을 보정 전 검사 결과로 쓴다.
 * 계획을 메모리에 적용해 다시 검사하므로 `unrepaired`는 적용 뒤에도 남는 원래 오류다. 새 오류가 생기는 계획이면
 * `plan.issues`에 오류 `REPAIR_REGRESSION`을 더한다(`repairDocument`는 예외로 중단한다).
 */
export function planRepair(
  bytes: Uint8Array,
  reportOrOptions?: ValidationReport | RepairOptions,
  maybeOptions?: RepairOptions,
): RepairPlan {
  const { report, options } = splitArgs(reportOrOptions, maybeOptions);
  const run = execute(bytes, report, options);
  if (run.newErrors.length > 0) run.plan.plan.issues.push(makeIssue("error", "REPAIR_REGRESSION", regressionMessage(run.newErrors)));
  return run.plan;
}

export function regressionMessage(newErrors: ValidationIssue[]): string {
  return `보정 뒤 새 오류가 생겼습니다: ${newErrors.map((e) => `${e.code} x${e.count}`).join(", ")}`;
}
