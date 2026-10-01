import { applyPlan, type EditPlan, type SpanEdit } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { planImport } from "../fragment/import.ts";
import type { ImportOptions, ImportPlan, InheritedProblems } from "../fragment/types.ts";
import { parseDocument } from "../model/document.ts";
import { walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, ParagraphNode } from "../model/types.ts";
import { openPackage } from "../package/open.ts";
import { censusOfDoc, verifyCensus, type Delta } from "./census.ts";
import { mapPos, paragraphAtPath, paragraphIndex, startKey } from "./doc.ts";
import { mergeInherited, noInherited } from "./inherited.ts";
import type { FillPlan, InjectStep } from "./plan.ts";
import { verifyExpectations, verifyPreservation } from "./verify.ts";

export type StageRecord = {
  label: string;
  plan: EditPlan;
  /** 이 단계가 예고한 수량 증감 */
  delta: Delta;
  /** 이 단계를 적용한 결과 바이트 */
  bytes: Uint8Array;
  /** 조각 주입 단계가 조각에서 상속한 문제(주 계획에는 없다) */
  inherited?: InheritedProblems;
};

export type ExecuteHooks = {
  /** 시험 전용: 단계마다 계획을 적용한 직후의 바이트를 바꿔 게이트가 결함을 잡는지 본다. */
  afterApply?: (output: Uint8Array, stage: string) => Uint8Array;
};

export type ExecuteResult = {
  /** 모든 단계와 단계별 확인을 통과했는가 */
  ok: boolean;
  /** 마지막 단계의 결과(ok일 때만) */
  output?: Uint8Array;
  stages: StageRecord[];
  /** 단계별 보존·수량·값 재읽기 오류와 가져오기 경고 */
  issues: Issue[];
  /** 값 재읽기로 확인한 누름틀·문단 수 */
  checked: { fields: number; paragraphs: number };
  /** 주입한 조각들이 소스에서부터 갖고 있던 문제(적용한 단계의 것만 합친다) */
  inherited: InheritedProblems;
};

const fail = (code: string, message: string, where: string): Issue => makeIssue("error", code, `${where}: ${message}`, where);

function listAt(doc: HwpxDocument, sectionIndex: number, parentPath: number[]): ParagraphNode[] | undefined {
  const section = doc.sections[sectionIndex];
  if (section === undefined) return undefined;
  if (parentPath.length === 0) return section.paragraphs;
  const owner = paragraphAtPath(section, parentPath.slice(0, -1));
  return owner?.subLists[parentPath[parentPath.length - 1] ?? -1]?.paragraphs;
}

/** 가져온 조각의 최상위 문단들이 앵커 옆 제자리에 있고, 그 안 모든 문단의 글이 채운 조각의 글과 같은지 본다. */
function verifyInjected(next: HwpxDocument, step: InjectStep, sectionIndex: number, anchorPath: number[]): Issue[] {
  const parentPath = anchorPath.slice(0, -1);
  const index = anchorPath[anchorPath.length - 1] ?? 0;
  const list = listAt(next, sectionIndex, parentPath);
  const from = step.position === "after" ? index + 1 : index;
  const inserted = list?.slice(from, from + step.topLevel) ?? [];
  const texts = inserted.flatMap((p) => [...walkParagraphs([p])].map((q) => q.logicalText));
  const where = `inject:${step.ruleId}`;
  if (inserted.length !== step.topLevel) return [fail("REREAD_TEXT", `가져온 최상위 문단이 ${step.topLevel}개여야 하는데 ${inserted.length}개입니다.`, where)];
  if (texts.length !== step.texts.length) return [fail("REREAD_TEXT", `가져온 문단이 ${step.texts.length}개여야 하는데 ${texts.length}개입니다.`, where)];
  const bad = texts.findIndex((t, i) => t !== step.texts[i]);
  return bad < 0 ? [] : [fail("REREAD_TEXT", `가져온 문단 ${bad}의 글이 조각(채운 뒤)의 글과 다릅니다.`, where)];
}

/**
 * 채움 계획을 적용한다. 주 계획을 먼저 적용하고, 조각 주입은 그 결과 문서에서 하나씩 이어서 계획·적용한다.
 * 단계마다 다시 파싱해 보존 계약(편집 구간 밖 동일)·수량 증감·값 재읽기를 확인하고, 하나라도 어긋나면 거기서 멈춘다.
 * 앵커 문단은 지금까지 단계들의 편집으로 시작 오프셋을 옮겨 새 문서에서 다시 찾는다.
 * `importOptions`는 조각 주입 단계의 `planImport`에 그대로 넘긴다.
 */
export function executeFillPlan(doc: HwpxDocument, plan: FillPlan, hooks: ExecuteHooks = {}, importOptions: ImportOptions = {}): ExecuteResult {
  const issues: Issue[] = [];
  const stages: StageRecord[] = [];
  const checked = { fields: 0, paragraphs: 0 };
  const history: SpanEdit[][] = [];
  let cur = doc;
  let census = censusOfDoc(doc);

  const run = (label: string, editPlan: EditPlan, delta: Delta, check: (next: HwpxDocument) => Issue[], inherited?: InheritedProblems): boolean => {
    let bytes: Uint8Array;
    let next: HwpxDocument;
    try {
      bytes = applyPlan(cur.pkg, editPlan);
      if (hooks.afterApply !== undefined) bytes = hooks.afterApply(bytes, label);
      next = parseDocument(openPackage(bytes));
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      issues.push(fail(e.code, e.message, label));
      return false;
    }
    const found = [
      ...verifyPreservation(cur.pkg.bytes, bytes, editPlan, label),
      ...verifyCensus(census, censusOfDoc(next), delta, label),
      ...check(next),
    ];
    issues.push(...found);
    if (found.some((i) => i.severity === "error")) return false;
    history.push(editPlan.edits);
    stages.push(inherited === undefined ? { label, plan: editPlan, delta, bytes } : { label, plan: editPlan, delta, bytes, inherited });
    cur = next;
    census = censusOfDoc(next);
    return true;
  };

  const main: EditPlan = { edits: plan.edits, additions: plan.additions, summary: plan.summary, issues: plan.issues };
  const mainOk = run("main", main, plan.delta, (next) => {
    const r = verifyExpectations(next, plan.edits, plan.expectations, "main");
    checked.fields += r.checked.fields;
    checked.paragraphs += r.checked.paragraphs;
    return r.issues;
  });
  const inheritedOf = (): InheritedProblems => mergeInherited(stages.flatMap((s) => (s.inherited === undefined ? [] : [s.inherited])));
  if (!mainOk) return { ok: false, stages, issues, checked, inherited: noInherited() };

  for (const step of plan.injects) {
    const where = `inject:${step.ruleId}`;
    let start = step.paragraphStart;
    for (const edits of history) start = mapPos(edits.filter((e) => e.entry === step.entry), start);
    const found = paragraphIndex(cur).get(startKey(step.entry, start));
    if (found === undefined) {
      issues.push(fail("INJECT_ANCHOR_LOST", "앞 단계를 적용한 문서에서 앵커 문단을 다시 찾지 못했습니다.", where));
      return { ok: false, stages, issues, checked, inherited: inheritedOf() };
    }
    const { section, paragraph } = found;
    let importPlan: ImportPlan;
    try {
      importPlan = planImport(
        cur,
        step.fragment,
        {
          sectionIndex: section.index,
          parentPath: paragraph.path.slice(0, -1),
          index: paragraph.path[paragraph.path.length - 1] ?? 0,
          position: step.position === "after" ? "after" : "before",
        },
        importOptions,
      );
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      issues.push(fail(e.code, e.message, where));
      return { ok: false, stages, issues, checked, inherited: inheritedOf() };
    }
    if (step.position === "replace") {
      importPlan.edits.push({
        entry: section.entryName,
        start: paragraph.element.start,
        end: paragraph.element.end,
        expected: section.text.slice(paragraph.element.start, paragraph.element.end),
        replacement: "",
        reason: `규칙 ${step.ruleId}: 문단 교체`,
      });
    }
    for (const w of importPlan.issues) issues.push(w);
    const delta: Delta = { ...step.delta, binaryItems: importPlan.summary["addedBinaries"] ?? 0 };
    const ok = run(where, importPlan, delta, (next) => verifyInjected(next, step, section.index, paragraph.path), importPlan.inherited);
    if (!ok) return { ok: false, stages, issues, checked, inherited: inheritedOf() };
  }
  return {
    ok: true,
    output: stages.length === 0 ? doc.pkg.bytes : (stages[stages.length - 1]?.bytes ?? doc.pkg.bytes),
    stages,
    issues,
    checked,
    inherited: inheritedOf(),
  };
}
