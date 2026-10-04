import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { parseFragment } from "../fragment/json.ts";
import type { Fragment } from "../fragment/types.ts";
import { walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, ObjectNode, ParagraphNode, SectionModel, TableNode } from "../model/types.ts";
import { canonicalJson, sha256Hex } from "../template/hash.ts";
import { selectRules } from "../template/rules.ts";
import { declsOf } from "../table/wrap.ts";
import { readTableGrid } from "../table/grid.ts";
import { planRepeatRows } from "../table/rows.ts";
import {
  emptyFillReport,
  type Action,
  type Dataset,
  type FillReport,
  type MissingPolicy,
  type MixedFormatPolicy,
  type Position,
  type Template,
  type ValueDigest,
} from "../template/types.ts";
import { isValidPath } from "../template/placeholder.ts";
import { digestValue, lookupPath, resolvePathValue, resolveValue } from "../template/value.ts";
import type { Move } from "./anchor-types.ts";
import { resolveAnchors, type ResolvedAnchor } from "./anchors.ts";
import { addDelta, deltaOfElements, deltaRecord, scaleDelta, zeroDelta, type Delta } from "./census.ts";
import { applyRepls, groupBy, hasSecPr, siblingsAtPath, type Repl } from "./doc.ts";
import { collectFields, fieldAnchorMatches, fieldFillBlock, fieldRangeIn, planFieldFill, type FieldFill, type FieldTarget } from "./fields.ts";
import { fillFragment } from "./fragment-fill.ts";
import { makeMove } from "./moves.ts";
import { fillPlaceholders } from "./placeholders.ts";
import { splitsField } from "./range.ts";
import { buildParagraphs, planRowDeletes, splitLines } from "./structure.ts";
import { planFitTables, planTableAction, fillRowCopy, inheritedOfRow, rowDataset, tableElementOf, tableLabel, type RepeatStep } from "./table-actions.ts";
import { cellFillBlock, lineFillBlock, planClear, planLineFill, planRangeReplace, span, type Ctx, type TextPlan } from "./text.ts";

export type FillOptions = {
  /** 누락 정책. 템플릿의 `options.missing`보다 앞선다. 기본 `error`. */
  missing?: MissingPolicy;
  /** 글자모양이 갈린 `word`·`{{}}`의 처리. 템플릿의 `options.mixedFormat`보다 앞선다. 기본 `skip`. */
  mixedFormat?: MixedFormatPolicy;
  /** 규칙의 `fragment` 경로 → 조각(객체 또는 JSON 글). 엔진은 파일을 읽지 않으므로 읽는 쪽이 채워 넘긴다. */
  fragments?: Record<string, Fragment | string>;
};

/** 채운 뒤 다시 읽어 확인할 기대값. 위치는 계획이 기준으로 삼은 문서(편집 전)의 오프셋이다. */
export type Expectation =
  | { kind: "field"; entry: string; beginStart: number; name: string; value: string; setsDirty: boolean }
  | { kind: "text"; entry: string; paragraphStart: number; text: string };

/** 주 계획 적용 뒤 하나씩 이어서 적용하는 조각 주입. */
export type InjectStep = {
  ruleId: string;
  anchor: string;
  entry: string;
  /** 앵커 문단 요소의 시작 오프셋(편집 전 문서). range 앵커는 `after`면 끝 문단, 그 밖은 첫 문단이다. */
  paragraphStart: number;
  /** range 앵커의 `replace`: 범위 모든 문단의 시작 오프셋(편집 전 문서). 없으면 `paragraphStart`의 문단 하나를 지운다. */
  rangeStarts?: number[];
  position: Position;
  /** `{{}}`를 채운 조각 */
  fragment: Fragment;
  /** 채운 조각 안 모든 문단의 논리 텍스트 */
  texts: string[];
  /** 조각 최상위 문단 수 */
  topLevel: number;
  /** 이 주입이 더하는 수량(이진 자료 제외). `replace`면 지워지는 앵커 문단의 수량을 뺀 값 */
  delta: Delta;
  /** `replace`일 때 지워지는 앵커 문단의 수량(delta에 이미 반영됨) */
  replacedDelta?: Delta;
};

/**
 * 채움 계획. 주 계획(EditPlan: 채움·삭제·문단 삽입·줄 배치 캐시 제거)은 편집 전 문서의 좌표 하나로 만들고,
 * 조각 주입(`injects`)은 새 id를 서로 겹치지 않게 주려고 주 계획을 적용한 문서에서 하나씩 이어서 만든다.
 */
export type FillPlan = EditPlan & {
  injects: InjectStep[];
  /** 주 계획 적용 뒤 하나씩 이어서 적용하는 행 반복(조각 주입 앞에 한다) */
  repeats: RepeatStep[];
  /** 주 계획 적용 뒤 확인할 기대값 */
  expectations: Expectation[];
  /** 주 계획이 더하는 수량(삭제는 음수, 문단 삽입은 양수) */
  delta: Delta;
  /** 규칙이 쓴 조각의 지문(키는 조각 경로나 `inline:<규칙 id>`) */
  fragmentDigests: { key: string; sha256: string }[];
  /** 이동표(7.10): 문단 구조를 바꾸는 항목마다 문서 순서의 원본 좌표 */
  moves: Move[];
};

/** 채움 보고서에 이동표를 더한 것(`moves`는 `plan.moves`와 같다) */
export type PlanReport = FillReport & { moves: Move[] };

type Range = { entry: string; start: number; end: number };
const within = (outer: Range, inner: Range): boolean => outer.entry === inner.entry && outer.start <= inner.start && inner.end <= outer.end;
const same = (a: Range, b: Range): boolean => a.entry === b.entry && a.start === b.start && a.end === b.end;
const rangeOf = (section: SectionModel, el: { start: number; end: number }): Range => ({ entry: section.entryName, start: el.start, end: el.end });

type Tagged = { edit: SpanEdit; label: string };

type DeleteCand = {
  kind: "paragraph" | "element" | "rows";
  /** 문단·객체 요소·표 요소의 범위 */
  range: Range;
  /** 실제로 지워지는 구간(`rows`는 지워지는 `tr`들) */
  parts: Range[];
  edits: SpanEdit[];
  delta: Delta;
  rules: { ruleId: string; anchor: string }[];
  paragraph?: ParagraphNode;
  section: SectionModel;
};

/** 오류 메시지 앞에 붙일 이름: 규칙은 `규칙 r1`, 문서 안 `{{경로}}` 자리는 그 표기, 암묵 채움의 필드는 `누름틀 이름`·`메일 머지 키`. */
const labelOf = (id: string): string =>
  id.startsWith("{{") ? id : id.startsWith("field:") ? `누름틀 ${id.slice("field:".length)}` : id.startsWith("merge:") ? `메일 머지 ${id.slice("merge:".length)}` : `규칙 ${id}`;

/** 암묵 채움이 맡는 필드: 누름틀(`CLICK_HERE`)과 키가 있는 메일 머지 필드(`MAILMERGE`). 다른 종류의 필드(책갈피·날짜 등)와 키 없는 메일 머지 필드는 채우지 않고 보고에도 넣지 않는다. */
const isImplicitKind = (t: FieldTarget): boolean => t.info.type === "CLICK_HERE" || (t.info.type === "MAILMERGE" && t.info.mergeKey !== undefined);
/** 암묵 채움이 데이터 경로로 보는 값: 누름틀은 이름, 메일 머지 필드는 키. */
const pathOfField = (t: FieldTarget): string => (t.info.type === "MAILMERGE" ? (t.info.mergeKey ?? "") : t.info.name);
/** 암묵 채움의 보고·메시지에 쓰는 자리 이름: 누름틀은 `field:이름`, 메일 머지 필드는 `merge:키`. */
const fieldIdOf = (t: FieldTarget): string => `${t.info.type === "MAILMERGE" ? "merge" : "field"}:${pathOfField(t)}`;
/** 문장 주어로 쓰는 필드 이름(조사 포함): 누름틀은 `누름틀 이름이`, 메일 머지 필드는 키 끝 글자와 상관없는 `메일 머지 필드(키 …)가`. */
const subjectOf = (t: FieldTarget): string => (t.info.type === "MAILMERGE" ? `메일 머지 필드(키 ${pathOfField(t)})가` : `${labelOf(fieldIdOf(t))}이`);
const issueFor = (code: string, message: string, id: string): Issue => makeIssue("error", code, `${labelOf(id)}: ${message}`, id);

function isOnlyObject(par: ParagraphNode, obj: ObjectNode): boolean {
  return par.pieces.every((_, i) => i === obj.pieceIndex);
}

export function loadFragment(
  spec: string | Record<string, unknown>,
  fragments: FillOptions["fragments"],
): { fragment: Fragment; key: string } {
  if (typeof spec === "string") {
    const given = fragments?.[spec];
    if (given === undefined) throw new HwpxError("TPL_FRAGMENT_MISSING", `조각 '${spec}'을(를) 받지 못했습니다(fragments 옵션에 넣어야 합니다).`);
    return { fragment: parseFragment(typeof given === "string" ? given : JSON.stringify(given)), key: spec };
  }
  return { fragment: parseFragment(JSON.stringify(spec)), key: "" };
}

/**
 * 규칙을 평가하고 앵커를 풀어 채움 계획과 보고서를 만든다. 문서를 바꾸지 않는다.
 *
 * 1. 규칙을 순서대로 평가해 참인 것만 남긴다.
 * 2. 삭제 범위 안의 채움·삽입은 버리고 `report.dropped`에 적는다. 같은 자리에 값이 다른 채움이 둘이면 `TPL_CONFLICT`.
 *    누름틀의 구간 치환(`inline`·`crossParagraph`)이 지우는 구간은 규칙을 평가하기 전에 모두 정한다(규칙 순서에 기대지 않는다). 그 안의 암묵 채움(`{{}}`·암묵 누름틀)은
 *    버리고(`dropped`), 그 안을 가리키는 명시 규칙(채움·삽입·주입·표 설정·삭제·행 반복)은 규칙 순서와 상관없이 `TPL_CONFLICT`다.
 *    문단을 합치는 구간 치환의 시작·끝·사이 문단을 앵커로 하는 삽입·주입도 앞뒤 어디든 `TPL_CONFLICT`다.
 * 3. 글이 바뀌는 구역의 줄 배치 캐시 요소를 전부 지우는 편집을 더한다(삭제 범위와 겹치는 것은 뺀다).
 * 4. 보고서: 적용할 액션, 건너뛴 자리와 사유, 필요한 데이터 경로, 다시 찾은 앵커, 예상 수량 증감.
 *
 * 보고서에 오류(`severity: "error"`)가 있으면 계획은 쓰지 않는다.
 */
export function buildFillPlan(
  doc: HwpxDocument,
  template: Template,
  dataset: Dataset,
  options: FillOptions = {},
): { plan: FillPlan; report: PlanReport } {
  const policy: MissingPolicy = options.missing ?? template.options.missing ?? "error";
  const mixed: MixedFormatPolicy = options.mixedFormat ?? template.options.mixedFormat ?? "skip";
  const report: PlanReport = { ...emptyFillReport(), moves: [] };
  const issues = report.issues;
  const required = new Set<string>();
  const missingPaths = new Set<string>();
  const keptPaths = new Map<string, number>();
  const reportedErrors = new Set<string>();

  const ctxs = new Map<string, Ctx>();
  const ctxOf = (section: SectionModel): Ctx => {
    let ctx = ctxs.get(section.entryName);
    if (ctx === undefined) ctxs.set(section.entryName, (ctx = { entry: section.entryName, text: section.text }));
    return ctx;
  };

  // ── 1. 규칙과 앵커 ──────────────────────────────────────────
  const { active, inactive } = selectRules(template, dataset);
  report.inactiveRules = inactive.map((r) => r.id);
  const resolution = resolveAnchors(doc, template, new Set(active.map((r) => r.do.anchor)));
  issues.push(...resolution.issues);
  for (const i of resolution.issues) if (i.code === "ANCHOR_RELOCATED") report.relocated.push({ anchor: i.where ?? "", message: i.message });
  const anchorOf = (id: string): ResolvedAnchor | undefined => resolution.anchors.get(id);
  /** insertText `replace`의 값이 비거나(`empty`·빈 글) 자리를 그대로 두면(`keep`) 교체를 건너뛴다: 그 문단·범위는 교체되는 범위로 세지 않는다(안의 자리는 채운다) */
  const skipsReplace = (action: Action): boolean => {
    if (action.type !== "insertText" || action.position !== "replace") return false;
    const value = resolveValue(dataset, action.value, policy);
    return value.kind === "keep" || value.kind === "empty" || (value.kind === "text" && value.text === "");
  };

  // ── 1b. range 앵커를 받는 규칙(7.10) ──────────────────────────
  // range 앵커는 inject·insertText·delete만 받는다(다른 액션은 TPL_RULE). 범위를 교체·삭제하는 규칙은 그 범위 전체를 바꾸므로,
  // 겹치는 다른 규칙은 규칙 순서와 상관없이 TPL_CONFLICT다(여러 문단에 걸친 누름틀의 구간 치환과 같은 규칙). 범위 안의 `{{}}`·누름틀 암묵 채움은 `dropped`다.
  type RangeOp = {
    ruleId: string;
    anchor: string;
    resolved: Extract<ResolvedAnchor, { kind: "range" }>;
    /** 첫 문단 시작부터 끝 문단 끝까지 */
    range: Range;
    type: "inject" | "insertText" | "delete";
    position: Position | undefined;
    /** 범위를 지우거나 교체한다(`delete`, `replace`. 값이 비어 교체를 건너뛰는 insertText는 아니다) */
    destructive: boolean;
  };
  const rangeOps: RangeOp[] = [];
  const rangeSkip = new Set<string>();
  for (const rule of active) {
    const action = rule.do;
    const anchor = anchorOf(action.anchor);
    const first = anchor?.kind === "range" ? anchor.paragraphs[0] : undefined;
    const last = anchor?.kind === "range" ? anchor.paragraphs[anchor.paragraphs.length - 1] : undefined;
    if (anchor?.kind !== "range" || first === undefined || last === undefined) continue;
    if (action.type !== "inject" && action.type !== "insertText" && action.type !== "delete") {
      issues.push(issueFor("TPL_RULE", `${action.type}은(는) range 앵커에 쓸 수 없습니다(inject·insertText·delete만 받습니다).`, rule.id));
      rangeSkip.add(rule.id);
      continue;
    }
    if (action.type === "delete" && action.scope !== undefined) {
      issues.push(issueFor("TPL_RULE", "range 앵커의 delete에는 scope를 줄 수 없습니다.", rule.id));
      rangeSkip.add(rule.id);
      continue;
    }
    const position = action.type === "delete" ? undefined : action.position;
    const destructive = action.type === "delete" || (position === "replace" && !skipsReplace(action));
    if (destructive) {
      const verb = action.type === "delete" ? "지울" : "교체할";
      const split = splitsField(anchor.paragraphs);
      if (anchor.paragraphs.some((p) => hasSecPr(p))) {
        issues.push(issueFor("FILL_SECTION_PROPS", `범위 안에 구역 설정(secPr)이 든 문단이 있어 ${verb} 수 없습니다.`, rule.id));
        rangeSkip.add(rule.id);
        continue;
      }
      if (split !== undefined) {
        issues.push(issueFor("FRAG_SPLITS_FIELD", `범위가 누름틀의 시작과 끝 사이를 자릅니다(범위 안에서 짝이 닫히지 않는 시작 ${split.begins}개, 끝 ${split.ends}개). ${verb} 수 없습니다.`, rule.id));
        rangeSkip.add(rule.id);
        continue;
      }
    }
    rangeOps.push({
      ruleId: rule.id,
      anchor: action.anchor,
      resolved: anchor,
      range: { entry: anchor.section.entryName, start: first.element.start, end: last.element.end },
      type: action.type,
      position,
      destructive,
    });
  }
  // 범위끼리: 교체·삭제가 하나라도 끼고 범위가 겹치면 충돌이다. 같은 범위에 교체·삭제가 둘 이상이어도 충돌이다.
  // 같은 범위에 앞·뒤 삽입(before·after)과 교체·삭제가 하나씩이면 허용한다(line 앵커의 앞뒤 삽입과 교체처럼). insertText 교체는 같은 범위의 다른 삽입과 함께 쓸 수 없다.
  const isTextReplace = (o: RangeOp): boolean => o.type === "insertText" && o.destructive;
  for (let j = 0; j < rangeOps.length; j++) {
    const b = rangeOps[j];
    if (b === undefined) continue;
    for (const a of rangeOps.slice(0, j)) {
      if (rangeSkip.has(a.ruleId) || (!a.destructive && !b.destructive)) continue;
      if (!(a.range.entry === b.range.entry && a.range.start < b.range.end && b.range.start < a.range.end)) continue;
      if (same(a.range, b.range) && !(a.destructive && b.destructive) && !isTextReplace(a) && !isTextReplace(b)) continue;
      issues.push(issueFor("TPL_CONFLICT", `규칙 ${a.ruleId}와 같은 범위나 겹치는 range 범위를 바꿉니다.`, b.ruleId));
      rangeSkip.add(b.ruleId);
      break;
    }
  }
  /** 교체·삭제로 바뀌는 range 앵커의 범위(충돌 판정과 암묵 채움 버림에 쓴다) */
  const regs = rangeOps.filter((o) => o.destructive && !rangeSkip.has(o.ruleId));
  /** 규칙 `who`가 range 앵커의 교체·삭제가 바꾸는 범위 `r` 안을 건드리면 TPL_CONFLICT를 내고 true를 돌려준다. */
  const clashRange = (r: Range, who: string): boolean => {
    const reg = regs.find((o) => within(o.range, r));
    if (reg === undefined) return false;
    const key = `conflict\u0000${reg.ruleId}\u0000${who}`;
    if (!reportedErrors.has(key)) {
      reportedErrors.add(key);
      issues.push(
        issueFor("TPL_CONFLICT", `규칙 ${reg.ruleId}가 ${reg.type === "delete" ? "지우는" : "교체하는"} range 범위(구역 ${reg.resolved.section.index}, 문단 ${reg.resolved.from}~${reg.resolved.to}) 안을 건드립니다.`, who),
      );
    }
    return true;
  };
  /** 이동표 항목: 문서 순서로 정렬하려고 구역 안 위치(`at`)와 만든 순서(`seq`)를 함께 둔다. 정렬은 계획 끝에서 하고, 항목은 합치지 않는다(문단 삭제는 문단마다, range 삭제는 범위마다 하나). */
  const moveEntries: { move: Move; at: number; seq: number }[] = [];
  const noteMove = (sectionIndex: number, at: number, parentPath: number[], from: number, to: number, count: number): void => {
    moveEntries.push({ move: makeMove(sectionIndex, parentPath, from, to, count), at, seq: moveEntries.length });
  };

  /** 앵커 문단(들)의 앞·뒤 삽입이나 교체의 이동표 항목. 부모와 번호는 문단 주소에서 읽는다. */
  const noteStructure = (sectionIndex: number, at: number, first: ParagraphNode, last: ParagraphNode, position: Position, count: number): void => {
    const parentPath = first.path.slice(0, -1);
    const from = first.path[first.path.length - 1] ?? 0;
    const to = last.path[last.path.length - 1] ?? from;
    if (position === "before") noteMove(sectionIndex, at, parentPath, from, from - 1, count);
    else if (position === "after") noteMove(sectionIndex, at, parentPath, to + 1, to, count);
    else noteMove(sectionIndex, at, parentPath, from, to, count);
  };

  // 조건이 거짓인 repeat: 원형 행은 그대로 두고 그 안의 원소·순번 자리(`{{item.이름}}`·`{{순번}}`)는 채우지 않는다(`REPEAT_INACTIVE`).
  // 이 용도로만 앵커를 풀기 때문에 풀지 못해도 오류를 내지 않는다.
  type IdleRow = { ruleId: string; anchor: string; range: Range; as: string; index: string | undefined; count: number };
  const idleRows: IdleRow[] = [];
  const idleResolution = resolveAnchors(doc, template, new Set(inactive.filter((r) => r.do.type === "repeat").map((r) => r.do.anchor)));
  for (const rule of inactive) {
    const action = rule.do;
    if (action.type !== "repeat") continue;
    const found = idleResolution.anchors.get(action.anchor);
    const tr = found?.kind === "cell" ? readTableGrid(found.table.element).rows[found.cell.row] : undefined;
    if (found?.kind === "cell" && tr !== undefined) idleRows.push({ ruleId: rule.id, anchor: action.anchor, range: rangeOf(found.section, tr), as: action.as ?? "item", index: action.index, count: 0 });
  }

  const valueError = (ruleId: string, code: string, message: string, path: string | undefined): void => {
    if (code === "DATA_MISSING" && path !== undefined) missingPaths.add(path);
    const key = `${code}\u0000${path ?? ruleId}`;
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    issues.push(issueFor(code, message, ruleId));
  };

  // ── 2a. 삭제 후보 ───────────────────────────────────────────
  const cands: DeleteCand[] = [];
  const pushCand = (cand: DeleteCand): void => {
    const found = cands.find((c) => c.kind === cand.kind && same(c.range, cand.range));
    if (found === undefined) cands.push(cand);
    else found.rules.push(...cand.rules);
  };
  const paragraphDelete = (section: SectionModel, paragraph: ParagraphNode, rule: { ruleId: string; anchor: string }, viaRange = false): void => {
    // range 앵커의 교체·삭제가 바꾸는 범위 안의 다른 규칙의 삭제는 충돌이다(그 범위를 지우는 규칙 자신(`viaRange`)은 제외)
    if (!viaRange && clashRange(rangeOf(section, paragraph.element), rule.ruleId)) return;
    if (hasSecPr(paragraph)) {
      issues.push(issueFor("FILL_SECTION_PROPS", "구역 설정(secPr)이 든 문단은 지울 수 없습니다.", rule.ruleId));
      return;
    }
    const ctx = ctxOf(section);
    pushCand({
      kind: "paragraph",
      range: rangeOf(section, paragraph.element),
      parts: [rangeOf(section, paragraph.element)],
      edits: [span(ctx, paragraph.element.start, paragraph.element.end, "", "문단 삭제")],
      delta: deltaOfElements([paragraph.element], section.entryName, -1),
      rules: [rule],
      paragraph,
      section,
    });
  };
  const objectDelete = (section: SectionModel, paragraph: ParagraphNode, object: ObjectNode, rule: { ruleId: string; anchor: string }): void => {
    if (clashRange(rangeOf(section, object.element), rule.ruleId)) return;
    if (isOnlyObject(paragraph, object)) {
      paragraphDelete(section, paragraph, rule);
      return;
    }
    const ctx = ctxOf(section);
    pushCand({
      kind: "element",
      range: rangeOf(section, object.element),
      parts: [rangeOf(section, object.element)],
      edits: [span(ctx, object.element.start, object.element.end, "", "객체 삭제")],
      delta: deltaOfElements([object.element], section.entryName, -1),
      rules: [rule],
      section,
    });
  };

  type RowReq = { rule: { ruleId: string; anchor: string }; section: SectionModel; owner: ParagraphNode; table: TableNode; row: number };
  const rowReqs: RowReq[] = [];

  // 삭제·교체되는 범위(계획 초입에서 알 수 있는 것): 이 안의 표를 가리키는 행 반복은 데이터를 읽기 전에 버린다
  const doomed: Range[] = [];
  for (const rule of active) {
    const action = rule.do;
    const anchor = anchorOf(action.anchor);
    if (anchor === undefined) continue;
    if (action.type === "delete" && anchor.kind === "line") doomed.push(rangeOf(anchor.section, anchor.paragraph.element));
    else if (action.type === "delete" && anchor.kind === "object") doomed.push(rangeOf(anchor.section, isOnlyObject(anchor.paragraph, anchor.object) ? anchor.paragraph.element : anchor.object.element));
    else if ((action.type === "inject" || action.type === "insertText") && action.position === "replace" && anchor.kind === "line" && !skipsReplace(action)) doomed.push(rangeOf(anchor.section, anchor.paragraph.element));
  }
  const repeatClaims = new Map<string, string>();

  // 행 반복(repeat): 데이터 배열을 읽는다. 0개면 원형 행 삭제와 같고(삭제 규칙을 따른다), 1개 이상이면 주 계획 뒤의 단계로 처리한다.
  // 단계에서 놀라지 않도록 원형 행을 지금 복제해 보고(표 연산의 거절 사유), 복사본마다 `{{}}`를 채워 본다(값 누락·건너뜀·기대 글).
  type RepeatPlan = { ruleId: string; section: SectionModel; step: RepeatStep };
  const repeatPlans: RepeatPlan[] = [];
  const repeatRuleIds = new Set<string>();
  // 원형 행의 범위: 규칙이 실패해도 그 행 안의 `{{item.이름}}`을 문서 안 `{{경로}}`로 채우려 하지 않게(군더더기 오류를 막는다) 교체되는 범위로 센다
  const repeatRows: { ruleId: string; range: Range; active: boolean }[] = [];
  for (const rule of active) {
    const action = rule.do;
    if (action.type !== "repeat") continue;
    const anchor = anchorOf(action.anchor);
    // range 앵커는 1b가 이미 TPL_RULE로 막았다
    if (anchor === undefined || rangeSkip.has(rule.id)) continue;
    if (anchor.kind !== "cell") {
      issues.push(issueFor("TPL_RULE", "repeat의 앵커는 원형 행의 셀을 가리키는 cell 앵커여야 합니다.", rule.id));
      continue;
    }
    const grid = readTableGrid(anchor.table.element);
    const tr = grid.rows[anchor.cell.row];
    if (tr === undefined) {
      issues.push(issueFor("TABLE_IRREGULAR", "원형 행을 찾을 수 없습니다.", rule.id));
      continue;
    }
    const tableRange = rangeOf(anchor.section, anchor.table.element);
    if (clashRange(tableRange, rule.id)) continue;
    if (doomed.some((d) => within(d, tableRange))) {
      report.dropped.push({ ruleId: rule.id, anchor: action.anchor, reason: "표가 삭제·교체되는 범위 안이라 버렸습니다." });
      continue;
    }
    const claimKey = `${anchor.section.entryName}:${tr.start}`;
    const claimed = repeatClaims.get(claimKey);
    if (claimed !== undefined) {
      issues.push(issueFor("TPL_CONFLICT", `규칙 ${claimed}와 같은 원형 행을 반복합니다.`, rule.id));
      continue;
    }
    repeatClaims.set(claimKey, rule.id);
    const repeatRow = { ruleId: rule.id, range: rangeOf(anchor.section, tr), active: false };
    repeatRows.push(repeatRow);
    const path = action.each.path;
    required.add(path);
    const found = lookupPath(dataset, path);
    let items: unknown[];
    if (!found.found || found.value === null) {
      if (policy === "error") {
        valueError(rule.id, "DATA_MISSING", `데이터에 ${path} 값이 없습니다.`, path);
        continue;
      }
      missingPaths.add(path);
      if (policy === "keep") {
        keptPaths.set(path, (keptPaths.get(path) ?? 0) + 1);
        continue;
      }
      items = [];
    } else if (!Array.isArray(found.value)) {
      issues.push(issueFor("DATA_NOT_ARRAY", `데이터의 ${path}는 배열이 아닙니다.`, rule.id));
      continue;
    } else {
      items = found.value;
    }
    const who = { ruleId: rule.id, anchor: action.anchor };
    repeatRuleIds.add(rule.id);
    if (items.length === 0) {
      rowReqs.push({ rule: who, section: anchor.section, owner: anchor.owner, table: anchor.table, row: anchor.cell.row });
      continue;
    }
    try {
      planRepeatRows(doc, { sectionIndex: anchor.section.index, element: anchor.table.element }, { row: anchor.cell.row, count: items.length });
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      issues.push(issueFor(e.code, e.message, rule.id));
      continue;
    }
    repeatRow.active = true; // 원형 행은 단계에서 통째로 바뀐다(다른 규칙의 행 삭제와 겹치면 그쪽을 버린다)
    const as = action.as ?? "item";
    const isAlias = (p: string): boolean => p === as || p.startsWith(`${as}.`) || p === action.index;
    const decls = declsOf(anchor.section.root);
    const rowXml = anchor.section.text.slice(tr.start, tr.end);
    const texts: string[][] = [];
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const filled = fillRowCopy(rowXml, decls, rowDataset(dataset, items, i, as, action.index), policy, mixed);
      texts.push(filled.texts);
      const o = filled.outcome;
      for (const e of o.errors) valueError(rule.id, e.code, `행 반복 {{${e.path}}}: ${e.message}`, e.path);
      for (const p of o.missing.keys()) {
        if (!isAlias(p)) required.add(p);
        missingPaths.add(p);
      }
      for (const f of o.filled) if (!isAlias(f.path)) required.add(f.path);
      for (const [p, n] of o.kept) keptPaths.set(p, (keptPaths.get(p) ?? 0) + n);
      for (const sk of o.skipped) {
        const key = `${sk.code}\u0000${sk.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        report.skipped.push({ ruleId: rule.id, anchor: action.anchor, code: sk.code, message: `행 반복 {{${sk.path}}}: ${sk.message}` });
      }
    }
    const entry = anchor.section.entryName;
    const rowDelta = deltaOfElements([tr], entry, 1);
    const step: RepeatStep = {
      ruleId: rule.id,
      anchor: action.anchor,
      entry,
      rowStart: tr.start,
      items,
      as,
      index: action.index,
      dataset,
      policy,
      mixed,
      texts,
      delta: scaleDelta(rowDelta, items.length - 1),
      inherited: inheritedOfRow(doc, tr, items.length - 1),
    };
    repeatPlans.push({ ruleId: rule.id, section: anchor.section, step });
  }

  for (const rule of active) {
    const action = rule.do;
    if (action.type !== "delete") continue;
    const anchor = anchorOf(action.anchor);
    if (anchor === undefined) continue;
    const who = { ruleId: rule.id, anchor: action.anchor };
    if (anchor.kind === "line") paragraphDelete(anchor.section, anchor.paragraph, who);
    else if (anchor.kind === "object") objectDelete(anchor.section, anchor.paragraph, anchor.object, who);
    else if (anchor.kind === "cell") rowReqs.push({ rule: who, section: anchor.section, owner: anchor.owner, table: anchor.table, row: anchor.cell.row });
    else if (anchor.kind === "range" && !rangeSkip.has(rule.id)) for (const par of anchor.paragraphs) paragraphDelete(anchor.section, par, who, true);
  }
  // 반복해서 바뀌는 원형 행을 지우라는 다른 규칙은 버린다(원형 행은 단계에서 다시 찾아야 한다)
  const activeRows = repeatRows.filter((r) => r.active);
  const effectiveRowReqs = rowReqs.filter((req) => {
    if (clashRange(rangeOf(req.section, req.table.element), req.rule.ruleId)) return false;
    const tr = readTableGrid(req.table.element).rows[req.row];
    if (tr === undefined || repeatRuleIds.has(req.rule.ruleId)) return true;
    const range = rangeOf(req.section, tr);
    if (!activeRows.some((x) => same(x.range, range))) return true;
    report.dropped.push({ ruleId: req.rule.ruleId, anchor: req.rule.anchor, reason: "반복하는 원형 행을 지우는 규칙이라 버렸습니다." });
    return false;
  });
  const tables = groupBy(effectiveRowReqs, (r) => r.table);
  for (const [table, reqs] of tables) {
    const first = reqs[0];
    if (first === undefined) continue;
    const ctx = ctxOf(first.section);
    const result = planRowDeletes(ctx, table.element, reqs.map((r) => r.row));
    const rules = reqs.map((r) => r.rule);
    if ("fail" in result) {
      for (const r of rules) issues.push(issueFor(result.fail.code, result.fail.message, r.ruleId));
    } else if ("allRows" in result) {
      // 마지막 남은 행까지 지우면 표를 담은 문단(그 문단에 표만 있으면 문단째, 아니면 표 요소만)을 지운다
      for (const rule of rules) objectDelete(first.section, first.owner, table, rule);
    } else {
      pushCand({
        kind: "rows",
        range: rangeOf(first.section, table.element),
        parts: result.trs.map((tr) => rangeOf(first.section, tr)),
        edits: result.edits,
        delta: deltaOfElements(result.trs, first.section.entryName, -1),
        rules,
        section: first.section,
      });
    }
  }

  // ── 2a'. `replace` 앵커(삭제 + 삽입) ─────────────────────────
  const replaceRanges: { range: Range; ruleId: string; type: "inject" | "insertText" | "repeat" }[] = [];
  // 반복할 원형 행은 단계에서 통째로 바뀌므로 그 안의 채움·삽입·줄 배치 캐시 제거는 버린다(교체되는 범위로 센다)
  for (const r of repeatRows) replaceRanges.push({ range: r.range, ruleId: r.ruleId, type: "repeat" });
  // range 앵커의 교체는 범위 전체를 교체되는 범위로 센다(그 안의 채움·줄 배치 캐시 제거는 버린다)
  for (const op of regs) if (op.type !== "delete") replaceRanges.push({ range: op.range, ruleId: op.ruleId, type: op.type });
  for (const rule of active) {
    const action = rule.do;
    if ((action.type !== "inject" && action.type !== "insertText") || action.position !== "replace") continue;
    const anchor = anchorOf(action.anchor);
    if (anchor === undefined || anchor.kind !== "line") continue;
    const range = rangeOf(anchor.section, anchor.paragraph.element);
    if (clashRange(range, rule.id) || skipsReplace(action)) continue;
    if (hasSecPr(anchor.paragraph)) {
      issues.push(issueFor("FILL_SECTION_PROPS", "구역 설정(secPr)이 든 문단은 교체할 수 없습니다.", rule.id));
      continue;
    }
    const clash = replaceRanges.find((r) => same(r.range, range));
    if (clash !== undefined) {
      issues.push(issueFor("TPL_CONFLICT", `규칙 ${clash.ruleId}와 같은 문단을 교체합니다.`, rule.id));
      continue;
    }
    replaceRanges.push({ range, ruleId: rule.id, type: action.type });
  }
  // 교체되는 문단 안의 채움은 버린다(삽입 지점인 문단 자신의 앞뒤는 그대로 쓴다)
  const isReplaced = (r: Range): boolean => replaceRanges.some((x) => within(x.range, r));

  // ── 2b. 삭제·교체 범위 안의 삭제는 버린다 ────────────────────────
  const kept: DeleteCand[] = [];
  for (const cand of cands) {
    const outer = cands.find((o) => o !== cand && o.kind !== "rows" && within(o.range, cand.range) && !(cand.kind !== "rows" && same(o.range, cand.range)));
    const replaced = replaceRanges.some((x) => within(x.range, cand.range) && !same(x.range, cand.range));
    if (outer === undefined && !replaced) kept.push(cand);
    else for (const r of cand.rules) report.dropped.push({ ruleId: r.ruleId, anchor: r.anchor, reason: "다른 삭제나 교체의 범위 안이라 버렸습니다." });
  }
  // 마지막 남은 문단은 지울 수 없다(같은 목록의 형제 문단이 모두 지워지면 문서 순서상 마지막 삭제가 막힌다)
  const lists = groupBy(
    kept.flatMap((cand) => {
      const list = cand.kind === "paragraph" && cand.paragraph !== undefined ? siblingsAtPath(cand.section, cand.paragraph.path) : undefined;
      return list === undefined ? [] : [{ list, cand }];
    }),
    (x) => x.list,
  );
  const refused = new Set<DeleteCand>();
  for (const [list, entries] of lists) {
    const group = entries.map((x) => x.cand);
    if (group.length < list.length) continue;
    const last = [...group].sort((a, b) => a.range.start - b.range.start).at(-1);
    if (last === undefined) continue;
    refused.add(last);
    for (const r of last.rules) issues.push(issueFor("FILL_LAST_PARAGRAPH", "그 부모의 마지막 남은 문단은 지울 수 없습니다.", r.ruleId));
  }
  const deletes = kept.filter((c) => !refused.has(c));
  const deleteRanges: Range[] = deletes.flatMap((c) => c.parts);
  // 누름틀의 구간 치환(`inline`·`crossParagraph`)이 바꾸는 구간: 시작 표식 뒤부터 끝 표식 앞까지. 이 안은 삭제되는 범위처럼 다룬다.
  // 구간은 규칙을 평가하기 전에 모두 정해 둔다(3-0: 규칙의 누름틀 채움과 암묵 채움). 그래서 규칙 순서와 상관없이 같은 판정이 나온다.
  type FieldSpanReg = { range: Range; fill: FieldFill; target: FieldTarget; label: string; counted: boolean };
  const fieldSpans: FieldSpanReg[] = [];
  /** 이 범위가 삭제 규칙이 지우는 범위 안인가 */
  const deletedByRule = (r: Range): boolean => deleteRanges.some((d) => within(d, r));
  /** 이 범위가 구간 치환이 지우는 구간 안이면 그 구간 */
  const spanOver = (r: Range): FieldSpanReg | undefined => fieldSpans.find((x) => within(x.range, r));
  /** 문단 `par`의 논리 구간 `[start, end)`이 구간 치환이 지우는 문단 일부(시작 문단의 표식 뒤, 끝 문단의 표식 앞)에 걸치면 그 구간 */
  const goneOver = (par: ParagraphNode, start: number, end: number): FieldSpanReg | undefined =>
    fieldSpans.find((x) => x.fill.span?.gone.some((g) => g.paragraph === par && start < g.until && end > g.from) === true);
  /** 문단 `par`가 문단을 합치는 구간 치환의 시작·끝 문단이거나 그 사이 문단(같은 목록의 형제)이면 그 구간 */
  const blockOver = (section: SectionModel, par: ParagraphNode): FieldSpanReg | undefined =>
    fieldSpans.find((x) => {
      const merge = x.fill.span?.merge;
      if (merge === undefined || x.target.section !== section) return false;
      const first = x.target.paragraph.path;
      const last = merge.endParagraph.path;
      const n = par.path[par.path.length - 1] ?? -1;
      return par.path.length === first.length && par.path.every((v, i) => i === par.path.length - 1 || v === first[i]) && n >= (first[first.length - 1] ?? 0) && n <= (last[last.length - 1] ?? 0);
    });
  const isDeleted = (r: Range): boolean => deletedByRule(r) || spanOver(r) !== undefined;
  /** 명시 규칙 `who`(규칙 id)가 구간 치환 `reg`가 지우는 구간을 건드린다 */
  const clashSpan = (reg: FieldSpanReg, who: string): void => {
    const key = `conflict\u0000${reg.label}\u0000${who}`;
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    issues.push(issueFor("TPL_CONFLICT", `${labelOf(reg.label)}이(가) 지우는 구간(여러 문단에 걸친 누름틀의 사이·끝 문단 등)을 건드립니다.`, who));
  };

  // ── 3. 채움·삽입·주입 ───────────────────────────────────────
  const tagged: Tagged[] = [];
  const touched = new Map<ParagraphNode, { entry: string; repls: Repl[] }>();
  const expectations: Expectation[] = [];
  const noteRepls = (section: SectionModel, par: ParagraphNode, repls: Repl[]): void => {
    const slot = touched.get(par) ?? { entry: section.entryName, repls: [] };
    for (const r of repls) {
      if (!slot.repls.some((x) => x.start === r.start && x.end === r.end && x.text === r.text)) slot.repls.push(r);
    }
    touched.set(par, slot);
  };
  const commit = (label: string, section: SectionModel, plan: TextPlan, par: ParagraphNode): void => {
    for (const edit of plan.edits) tagged.push({ edit, label });
    if (plan.edits.length > 0 || plan.repls.length > 0) noteRepls(section, par, plan.repls);
  };

  // 누름틀 채움을 계획에 싣는다. 구간 치환이면 그 구간을 등록하고(이미 정해 둔 구간이면 그대로) 수량 증감과 경고를 한 번만 더한다.
  // 같은 누름틀을 같은 값으로 채우는 규칙이 둘이어도 편집은 같아서 하나로 합쳐지므로, 수량도 경고도 한 번이다.
  let spanDelta = zeroDelta();
  const fieldSpanRange = (target: FieldTarget, fill: FieldFill): Range | undefined =>
    fill.span === undefined ? undefined : { entry: target.section.entryName, start: fill.span.start, end: fill.span.end };
  const registerSpan = (target: FieldTarget, fill: FieldFill, label: string): FieldSpanReg | undefined => {
    const range = fieldSpanRange(target, fill);
    if (range === undefined) return undefined;
    let reg = fieldSpans.find((x) => same(x.range, range));
    if (reg === undefined) fieldSpans.push((reg = { range, fill, target, label, counted: false }));
    return reg;
  };
  const commitField = (label: string, target: FieldTarget, fill: FieldFill): void => {
    commit(label, target.section, fill, target.paragraph);
    expectations.push({ kind: "field", entry: target.section.entryName, ...fill.check });
    const reg = registerSpan(target, fill, label);
    const sp = fill.span;
    if (reg === undefined || sp === undefined || reg.counted) return;
    reg.counted = true;
    spanDelta = addDelta(spanDelta, sp.delta);
    if (sp.merge !== undefined) {
      const { between, tables } = sp.merge;
      // 끝 문단이 시작 문단에 합쳐지고 사이 문단이 사라진다: 시작 문단 다음부터 끝 문단까지가 0개로 바뀐다
      const startIndex = target.paragraph.path[target.paragraph.path.length - 1] ?? 0;
      const endIndex = sp.merge.endParagraph.path[sp.merge.endParagraph.path.length - 1] ?? startIndex;
      noteMove(target.section.index, target.paragraph.element.end, target.paragraph.path.slice(0, -1), startIndex + 1, endIndex, 0);
      issues.push(
        makeIssue("warning", "FIELD_PARAGRAPHS_MERGED", `${subjectOf(target)} 걸친 문단 ${between + 2}개를 합쳤고 사이의 문단 ${between}개를 지웠습니다(그 안의 표 ${tables}개 포함).`, label),
      );
    }
    // 구간 안에 통째로 들어 함께 지워지는 다른 종류의 필드(하이퍼링크·날짜 등)와 책갈피
    const removed = new Map<string, number>();
    for (const x of sp.removed) removed.set(`${x.kind}:${x.name}`, (removed.get(`${x.kind}:${x.name}`) ?? 0) + 1);
    for (const [anchor, n] of removed) {
      report.dropped.push({ ruleId: "implicit", anchor, reason: `${subjectOf(target)} 지우는 구간 안에 있어 함께 지웠습니다${n > 1 ? `(${n}곳)` : ""}.` });
    }
  };
  /** 이 누름틀이 삭제·교체되는 문단 안인가 */
  const fieldDeleted = (target: FieldTarget): boolean => {
    const r = rangeOf(target.section, target.paragraph.element);
    return deletedByRule(r) || isReplaced(r);
  };
  /** 이 누름틀의 시작 표식이 다른 누름틀의 구간 치환이 지우는 구간 안이면 그 구간 */
  const fieldSpanOver = (target: FieldTarget): FieldSpanReg | undefined => spanOver(rangeOf(target.section, target.begin.element));
  const hasSpan = (target: FieldTarget): boolean => target.info.shape === "inline" || target.info.shape === "crossParagraph";

  // ── 3-0. 구간 치환이 지우는 구간을 규칙보다 먼저 모두 정한다 ──────────────────
  // 규칙 순서에 따라 같은 자리가 어떤 때는 버려지고 어떤 때는 충돌이 되지 않도록, 값이 정해지고 채울 수 있는 누름틀의 구간을 모두 등록해 둔다.
  // 규칙이 가리키는 누름틀(명시)이 먼저이고, 그다음에 이름이 데이터 경로인 누름틀의 암묵 채움이다(문서 순서로 바깥 누름틀이 먼저다).
  // 채움은 규칙 평가(3)와 암묵 채움(3c)이 이 계획을 그대로 쓴다.
  for (const rule of active) {
    const action = rule.do;
    const anchor = action.type === "fill" ? anchorOf(action.anchor) : undefined;
    if (action.type !== "fill" || anchor?.kind !== "field") continue;
    const value = resolveValue(dataset, action.value, policy);
    if (value.kind === "error" || value.kind === "keep") continue;
    for (const target of anchor.targets) {
      if (!hasSpan(target) || fieldDeleted(target)) continue;
      const plan = planFieldFill(ctxOf(target.section), target, value.kind === "text" ? value.text : "", `규칙 ${rule.id}: 채움`);
      if (!("fail" in plan)) registerSpan(target, plan, rule.id);
    }
  }
  const claimed = template.rules.flatMap((rule) => {
    const a = template.anchors.find((x) => x.id === rule.do.anchor);
    return a?.kind === "field" ? [a] : [];
  });
  /** 삭제·교체되는 문단 안이거나 반복할 원형 행 안이거나 다른 누름틀의 구간 치환으로 지워지는 누름틀 */
  const implicitGone = (target: FieldTarget): boolean =>
    fieldDeleted(target) || fieldSpanOver(target) !== undefined || repeatRows.some((x) => within(x.range, rangeOf(target.section, target.paragraph.element)));
  const isClaimed = (target: FieldTarget): boolean => claimed.some((a) => fieldAnchorMatches(a, target.info));
  const allFields = collectFields(doc);
  const implicitTargets = allFields.filter((t) => isImplicitKind(t) && !isClaimed(t));
  const implicitPlans = new Map<FieldTarget, FieldFill>();
  for (const target of implicitTargets) {
    const name = pathOfField(target);
    if (!hasSpan(target) || !isValidPath(name) || fieldFillBlock(target) !== undefined || implicitGone(target)) continue;
    const value = resolvePathValue(dataset, name, policy);
    if (value.kind === "error" || value.kind === "keep") continue;
    const fill = planFieldFill(ctxOf(target.section), target, value.kind === "text" ? value.text : "", `${labelOf(fieldIdOf(target))} 채움`);
    if ("fail" in fill) continue;
    implicitPlans.set(target, fill);
    registerSpan(target, fill, fieldIdOf(target));
  }
  // 메일 머지 필드의 표시 글(`{{키}}`나 옛 값)은 필드 자리가 맡는다: 규칙이 가리키는 필드이거나 암묵 채움이 채울 수 있는 필드면, 그 글 안의 `{{경로}}` 자리는 채우지 않고 버린다(3b).
  const mergeOwned = allFields.filter((t) => t.info.type === "MAILMERGE" && (isClaimed(t) || (isValidPath(pathOfField(t)) && fieldFillBlock(t) === undefined && !implicitGone(t))));
  /** 문단 `par`의 논리 구간 `[start, end)`이 메일 머지 필드가 맡는 표시 글에 걸치는가 */
  const mergeOwnedAt = (par: ParagraphNode, start: number, end: number): boolean =>
    mergeOwned.some((t) => {
      const r = fieldRangeIn(t, par);
      return r !== undefined && start < r.until && end > r.from;
    });

  const insertEdits: SpanEdit[] = [];
  let insertDelta = zeroDelta();
  const injects: InjectStep[] = [];
  const fragmentDigests: { key: string; sha256: string }[] = [];
  const touchedEntries = new Set<string>();

  const explicit: { ruleId: string; type: "fill" | "insertText" | "inject" | "tableProps" | "resize" | "repeat"; anchor: string; targets: number; position?: Position; value?: ValueDigest }[] = [];
  const repeatSteps: RepeatStep[] = [];

  for (const rule of active) {
    const action = rule.do;
    if (action.type === "delete") continue;
    const anchor = anchorOf(action.anchor);
    // range 앵커를 받지 않는 액션과 1b에서 거절한 range 규칙은 이미 오류를 냈다
    if (anchor === undefined || rangeSkip.has(rule.id)) continue;
    const who = { ruleId: rule.id, anchor: action.anchor };

    if (action.type === "tableProps" || action.type === "resize") {
      const target = tableElementOf(anchor);
      if (target === undefined) {
        issues.push(issueFor("TPL_RULE", `${action.type}의 앵커가 표를 가리키지 않습니다.`, rule.id));
        continue;
      }
      const tableRange = rangeOf(target.section, target.element);
      if (clashRange(tableRange, rule.id)) continue;
      const tableOver = spanOver(tableRange);
      if (tableOver !== undefined) {
        clashSpan(tableOver, rule.id);
        continue;
      }
      if (isDeleted(tableRange) || isReplaced(tableRange)) {
        report.dropped.push({ ruleId: rule.id, anchor: action.anchor, reason: "표가 삭제·교체되는 범위 안이라 버렸습니다." });
        continue;
      }
      try {
        // 같은 계획에서 지워지는 행(행 삭제 규칙·원소 0개 행 반복)은 그 안의 편집을 빼고 그 행만 가리키는 항목은 버린다
        const goneAddrs = new Set<number>();
        for (const c of readTableGrid(target.element).cells) if (isDeleted(rangeOf(target.section, c.tr))) goneAddrs.add(c.row);
        const gone = goneAddrs.size === 0 ? undefined : { rows: goneAddrs, covers: (start: number, end: number) => isDeleted({ entry: target.section.entryName, start, end }) };
        const done = planTableAction(doc, target.section, target.element, action, gone);
        for (const reason of done.dropped) report.dropped.push({ ruleId: rule.id, anchor: action.anchor, reason });
        for (const edit of done.edits) tagged.push({ edit, label: rule.id });
        // 편집이 없으면(비율 1, 이미 그 값인 설정) 구역을 바뀐 것으로 치지 않는다: 줄 배치 캐시를 그대로 둔다
        if (done.edits.length > 0) touchedEntries.add(target.section.entryName);
        if (done.targets > 0) explicit.push({ ruleId: rule.id, type: action.type, anchor: action.anchor, targets: done.targets });
      } catch (e) {
        if (!(e instanceof HwpxError)) throw e;
        issues.push(issueFor(e.code, e.message, rule.id));
      }
      continue;
    }

    if (action.type === "repeat") {
      const found = repeatPlans.find((r) => r.ruleId === rule.id);
      if (found !== undefined) {
        repeatSteps.push(found.step);
        touchedEntries.add(found.section.entryName);
        explicit.push({ ruleId: rule.id, type: "repeat", anchor: action.anchor, targets: found.step.items.length });
      }
      continue;
    }

    if (action.type === "fill") {
      const value = resolveValue(dataset, action.value, policy);
      if ("path" in action.value) required.add(action.value.path);
      if (value.kind === "error") {
        valueError(rule.id, value.code, value.message, value.path ?? ("path" in action.value ? action.value.path : undefined));
        continue;
      }
      if (value.kind === "keep") {
        keptPaths.set(value.path, (keptPaths.get(value.path) ?? 0) + 1);
        missingPaths.add(value.path);
        continue;
      }
      if (value.kind === "empty") missingPaths.add(value.path);
      const text = value.kind === "text" ? value.text : "";
      const digest = digestValue(text);
      let targets = 0;
      let droppedCount = 0;
      /** 이 문단(`part`가 있으면 그 논리 구간)은 채우지 않는다: 구간 치환이 지우는 자리면 충돌, 삭제·교체되는 범위면 버린다. */
      const dropIf = (section: SectionModel, par: ParagraphNode, part?: { start: number; end: number }): boolean => {
        const r = rangeOf(section, par.element);
        if (clashRange(r, rule.id)) return true;
        const over = spanOver(r) ?? (part === undefined ? undefined : goneOver(par, part.start, part.end));
        if (over !== undefined) {
          clashSpan(over, rule.id);
          return true;
        }
        if (deletedByRule(r) || isReplaced(r)) {
          droppedCount++;
          return true;
        }
        return false;
      };
      const reason = `규칙 ${rule.id}: 채움`;

      if (anchor.kind === "field") {
        for (const target of anchor.targets) {
          if (clashRange(rangeOf(target.section, target.paragraph.element), rule.id)) continue;
          if (fieldDeleted(target)) {
            droppedCount++;
            continue;
          }
          const over = fieldSpanOver(target);
          if (over !== undefined) {
            clashSpan(over, rule.id);
            continue;
          }
          const plan = planFieldFill(ctxOf(target.section), target, text, reason);
          if ("fail" in plan) {
            issues.push(issueFor(plan.fail.code, plan.fail.message, rule.id));
            continue;
          }
          commitField(rule.id, target, plan);
          targets++;
        }
      } else if (anchor.kind === "word") {
        if (!dropIf(anchor.section, anchor.paragraph, anchor)) {
          const plan = planRangeReplace(ctxOf(anchor.section), anchor.paragraph, anchor.start, anchor.end, text, mixed, reason);
          if ("skip" in plan) {
            report.skipped.push({ ruleId: rule.id, anchor: action.anchor, code: plan.skip.code, message: plan.skip.message });
          } else {
            commit(rule.id, anchor.section, plan, anchor.paragraph);
            targets++;
          }
        }
      } else if (anchor.kind === "line") {
        if (!dropIf(anchor.section, anchor.paragraph)) {
          const block = lineFillBlock(anchor.paragraph);
          if (block !== undefined) {
            issues.push(issueFor(block.code, block.message, rule.id));
          } else {
            const plan = planLineFill(ctxOf(anchor.section), anchor.paragraph, text, reason);
            if ("fail" in plan) issues.push(issueFor(plan.fail.code, plan.fail.message, rule.id));
            else {
              commit(rule.id, anchor.section, plan, anchor.paragraph);
              targets++;
            }
          }
        }
      } else if (anchor.kind === "cell") {
        const paragraphs = anchor.cell.subList?.paragraphs ?? [];
        const first = paragraphs[0];
        const cellBlock = cellFillBlock(paragraphs);
        if (first === undefined) {
          issues.push(issueFor("ANCHOR_NOT_FOUND", "셀에 문단이 없습니다.", rule.id));
        } else if (cellBlock !== undefined) {
          issues.push(issueFor(cellBlock.code, cellBlock.message, rule.id));
        } else if (!paragraphs.some((p) => dropIf(anchor.section, p))) {
          const ctx = ctxOf(anchor.section);
          const plan = planLineFill(ctx, first, text, reason);
          if ("fail" in plan) {
            issues.push(issueFor(plan.fail.code, plan.fail.message, rule.id));
          } else {
            commit(rule.id, anchor.section, plan, first);
            for (const p of paragraphs.slice(1)) commit(rule.id, anchor.section, planClear(ctx, p, reason), p);
            targets++;
          }
        }
      }
      if (droppedCount > 0) report.dropped.push({ ruleId: rule.id, anchor: action.anchor, reason: `삭제·교체되는 범위 안의 자리 ${droppedCount}곳을 버렸습니다.` });
      if (targets > 0) explicit.push({ ruleId: rule.id, type: "fill", anchor: action.anchor, targets, value: digest });
      continue;
    }

    // insertText·inject: 앵커는 line(문단 하나)이나 range(같은 부모의 연속 문단)다. range는 `before`가 첫 문단 앞, `after`가 끝 문단 뒤, `replace`가 범위 전체다.
    if (anchor.kind !== "line" && anchor.kind !== "range") continue;
    const paras = anchor.kind === "range" ? anchor.paragraphs : [anchor.paragraph];
    const firstPar = paras[0];
    const lastPar = paras[paras.length - 1];
    if (firstPar === undefined || lastPar === undefined) continue;
    /** 삽입 지점이 되는 문단: `after`는 끝 문단, 그 밖은 첫 문단 */
    const edgePar = action.position === "after" ? lastPar : firstPar;
    const anchorRange: Range = { entry: anchor.section.entryName, start: firstPar.element.start, end: lastPar.element.end };
    // range 앵커의 교체·삭제가 바꾸는 범위 안의 line 앵커 규칙은 충돌이다(range 앵커끼리는 1b가 판정했다)
    if (anchor.kind === "line" && clashRange(anchorRange, rule.id)) continue;
    // 구간 치환이 지우는 구간 안이거나, 문단을 합치는 구간 치환의 시작·끝·사이 문단이면(앞뒤 어디든) 충돌이다
    const anchorOver = spanOver(anchorRange) ?? paras.map((par) => blockOver(anchor.section, par)).find((x) => x !== undefined);
    if (anchorOver !== undefined) {
      clashSpan(anchorOver, rule.id);
      continue;
    }
    // 앵커 문단(range의 `replace`는 범위 전체, 앞뒤 삽입은 삽입 지점 문단)이 지워지거나, 다른 문단의 교체 범위 안(자기 자신을 교체하는 것은 제외)이면 버린다
    const edgeRange = action.position === "replace" ? anchorRange : rangeOf(anchor.section, edgePar.element);
    if (isDeleted(edgeRange) || replaceRanges.some((x) => within(x.range, edgeRange) && !same(x.range, anchorRange))) {
      report.dropped.push({ ruleId: rule.id, anchor: action.anchor, reason: "앵커 문단이 삭제·교체되는 범위 안이라 버렸습니다." });
      continue;
    }
    if (replaceRanges.some((x) => same(x.range, anchorRange) && x.type === "insertText" && x.ruleId !== rule.id)) {
      issues.push(issueFor("TPL_CONFLICT", `규칙 ${replaceRanges.find((x) => same(x.range, anchorRange))?.ruleId ?? ""}가 insertText로 이 문단을 교체하므로 다른 삽입·주입을 이 문단에 할 수 없습니다.`, rule.id));
      continue;
    }
    const ctx = ctxOf(anchor.section);
    const warnBeforeSecPr = (): void => {
      if (action.position === "before" && hasSecPr(firstPar)) {
        issues.push(makeIssue("warning", "FILL_BEFORE_SECPR", `규칙 ${rule.id}: 구역 설정(secPr)이 든 문단 앞에 넣으면 구역 설정이 첫 문단이 아니게 됩니다.`, rule.id));
      }
    };

    if (action.type === "insertText") {
      const value = resolveValue(dataset, action.value, policy, "paragraphs");
      if ("path" in action.value) required.add(action.value.path);
      if (value.kind === "error") {
        valueError(rule.id, value.code, value.message, value.path ?? ("path" in action.value ? action.value.path : undefined));
        continue;
      }
      if (value.kind === "keep") {
        keptPaths.set(value.path, (keptPaths.get(value.path) ?? 0) + 1);
        missingPaths.add(value.path);
        continue;
      }
      if (value.kind === "empty") missingPaths.add(value.path);
      const text = value.kind === "text" ? value.text : "";
      if (text === "") continue;
      const par = firstPar;
      let style: { paraPrIDRef: string; styleIDRef: string; charPrIDRef: string };
      if (action.style === "inherit") {
        const charPr = par.runs[0]?.charPrIDRef;
        if (charPr === null || charPr === undefined) {
          issues.push(issueFor("FILL_NO_RUN", "앵커 문단에 글자모양을 가진 run이 없어 서식을 이어받을 수 없습니다.", rule.id));
          continue;
        }
        style = { paraPrIDRef: par.attrs.paraPrIDRef ?? "0", styleIDRef: par.attrs.styleIDRef ?? "0", charPrIDRef: charPr };
      } else {
        style = action.style;
        const missing = (
          [
            ["paraPr", style.paraPrIDRef],
            ["charPr", style.charPrIDRef],
            ["style", style.styleIDRef],
          ] as const
        ).filter(([kind, id]) => !(doc.header.resources[kind] ?? []).some((r) => r.id === id));
        if (missing.length > 0) {
          issues.push(issueFor("FILL_STYLE_MISSING", `문서에 없는 서식 참조입니다: ${missing.map(([k, id]) => `${k} ${id}`).join(", ")}.`, rule.id));
          continue;
        }
      }
      const lines = splitLines(text);
      const xml = buildParagraphs(par, lines, style);
      warnBeforeSecPr();
      const at = action.position === "after" ? lastPar.element.end : firstPar.element.start;
      insertEdits.push(span(ctx, at, at, xml, `규칙 ${rule.id}: 문단 삽입`));
      if (action.position === "replace") {
        for (const old of paras) {
          insertEdits.push(span(ctx, old.element.start, old.element.end, "", `규칙 ${rule.id}: 문단 교체`));
          insertDelta = addDelta(insertDelta, deltaOfElements([old.element], anchor.section.entryName, -1));
        }
      }
      insertDelta = { ...insertDelta, paragraphs: insertDelta.paragraphs + lines.length };
      noteStructure(anchor.section.index, at, firstPar, lastPar, action.position, lines.length);
      touchedEntries.add(anchor.section.entryName);
      explicit.push({ ruleId: rule.id, type: "insertText", anchor: action.anchor, targets: lines.length, position: action.position, value: digestValue(text) });
      continue;
    }

    // inject
    let loaded: { fragment: Fragment; key: string };
    try {
      loaded = loadFragment(action.fragment, options.fragments);
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      issues.push(issueFor(e.code, e.message, rule.id));
      continue;
    }
    const key = loaded.key === "" ? `inline:${rule.id}` : loaded.key;
    if (!fragmentDigests.some((d) => d.key === key)) fragmentDigests.push({ key, sha256: sha256Hex(canonicalJson(loaded.fragment)) });
    let filled;
    try {
      filled = fillFragment(loaded.fragment, dataset, policy, mixed);
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      issues.push(issueFor(e.code, `조각을 읽을 수 없습니다: ${e.message}`, rule.id));
      continue;
    }
    for (const e of filled.outcome.errors) valueError(rule.id, e.code, `조각 안 {{${e.path}}}: ${e.message}`, e.path);
    for (const path of filled.outcome.missing.keys()) {
      required.add(path);
      missingPaths.add(path);
    }
    for (const f of filled.outcome.filled) required.add(f.path);
    for (const [path, n] of filled.outcome.kept) keptPaths.set(path, (keptPaths.get(path) ?? 0) + n);
    for (const s of filled.outcome.skipped) {
      report.skipped.push({ ruleId: rule.id, anchor: action.anchor, code: s.code, message: `조각 안 {{${s.path}}}: ${s.message}` });
    }
    if (action.fitTable === "allowBreak") {
      // 삽입 지점을 감싸는 표 가운데 잘릴 수 있는 표를 쪽을 넘길 수 있게 바꾼다(주 계획에서 먼저 적용하므로 가져오기 단계에는 경고가 없다)
      try {
        for (const fit of planFitTables(doc, anchor.section, edgePar.element)) {
          for (const edit of fit.edits) tagged.push({ edit, label: rule.id });
          for (const change of fit.changes) report.tableChanges.push({ ruleId: rule.id, anchor: action.anchor, table: tableLabel(anchor.section, fit.table), change });
          touchedEntries.add(anchor.section.entryName);
        }
      } catch (e) {
        if (!(e instanceof HwpxError)) throw e;
        issues.push(issueFor(e.code, e.message, rule.id));
        continue;
      }
    }
    warnBeforeSecPr();
    let delta = filled.delta;
    let replacedDelta: Delta | undefined;
    if (action.position === "replace") {
      replacedDelta = deltaOfElements(
        paras.map((old) => old.element),
        anchor.section.entryName,
        -1,
      );
      delta = addDelta(delta, replacedDelta);
    }
    const step: InjectStep = {
      ruleId: rule.id,
      anchor: action.anchor,
      entry: anchor.section.entryName,
      paragraphStart: edgePar.element.start,
      position: action.position,
      fragment: filled.fragment,
      texts: filled.texts,
      topLevel: filled.topLevel,
      delta,
    };
    if (anchor.kind === "range" && action.position === "replace") step.rangeStarts = paras.map((old) => old.element.start);
    if (replacedDelta !== undefined) step.replacedDelta = replacedDelta;
    injects.push(step);
    noteStructure(anchor.section.index, action.position === "after" ? lastPar.element.end : firstPar.element.start, firstPar, lastPar, action.position, filled.topLevel);
    touchedEntries.add(anchor.section.entryName);
    explicit.push({ ruleId: rule.id, type: "inject", anchor: action.anchor, targets: filled.topLevel, position: action.position });
  }

  // 주입 순서: 앵커 옆에 하나씩 이어 넣으므로 같은 앵커의 `after`는 규칙 반대 순서로 넣어야 규칙 순서대로 놓이고,
  // `replace`는 앵커 문단을 지우므로 같은 앵커의 앞뒤 주입이 끝난 뒤에 한다.
  const ordered = injects.filter((i) => i.position !== "replace");
  const slots = new Map<string, number[]>();
  ordered.forEach((step, i) => {
    if (step.position === "after") slots.set(`${step.entry}|${step.paragraphStart}`, [...(slots.get(`${step.entry}|${step.paragraphStart}`) ?? []), i]);
  });
  for (const idx of slots.values()) {
    const steps = idx.map((i) => ordered[i]);
    steps.reverse().forEach((step, k) => {
      const at = idx[k];
      if (step !== undefined && at !== undefined) ordered[at] = step;
    });
  }
  injects.splice(0, injects.length, ...ordered, ...injects.filter((i) => i.position === "replace"));

  // ── 3b. 문서 안 `{{경로}}` ──────────────────────────────────
  const implicit = new Map<string, { count: number; value: ValueDigest }>();
  const implicitDropped = new Map<string, number>();
  for (const section of doc.sections) {
    // 반복할 원형 행 안의 `{{}}`는 행 반복이 채운다(여기서는 건드리지 않고 `dropped`로도 세지 않는다)
    const inRepeatRow = (par: ParagraphNode): boolean => repeatRows.some((x) => within(x.range, rangeOf(section, par.element)));
    const outcome = fillPlaceholders(
      ctxOf(section),
      [...walkParagraphs(section.paragraphs)].filter((par) => !inRepeatRow(par)),
      dataset,
      policy,
      mixed,
      (par, start, end) => {
        const r = rangeOf(section, par.element);
        // 문단 전체가 삭제·교체·구간 치환의 구간 안이거나, 구간 치환이 지우는 문단 일부(시작 문단의 표식 뒤, 끝 문단의 표식 앞)에 자리가 걸치거나, 메일 머지 필드가 맡는 표시 글 안이다
        return isDeleted(r) || isReplaced(r) || goneOver(par, start, end) !== undefined || mergeOwnedAt(par, start, end);
      },
      (par, path) => {
        const r = rangeOf(section, par.element);
        const row = idleRows.find((x) => within(x.range, r) && (path === x.as || path.startsWith(`${x.as}.`) || path === x.index));
        if (row === undefined) return false;
        row.count++;
        return true;
      },
    );
    for (const e of outcome.errors) valueError(`{{${e.path}}}`, e.code, e.message, e.path);
    for (const path of outcome.missing.keys()) missingPaths.add(path);
    for (const [path, n] of outcome.kept) keptPaths.set(path, (keptPaths.get(path) ?? 0) + n);
    for (const [path, n] of outcome.dropped) implicitDropped.set(path, (implicitDropped.get(path) ?? 0) + n);
    for (const s of outcome.skipped) {
      report.skipped.push({ ruleId: "implicit", anchor: `{{${s.path}}}`, code: s.code, message: s.message, where: `${section.entryName} [${s.address.join(", ")}]` });
    }
    for (const f of outcome.filled) {
      required.add(f.path);
      implicit.set(f.path, { count: (implicit.get(f.path)?.count ?? 0) + 1, value: f.digest });
    }
    for (const edit of outcome.edits) tagged.push({ edit, label: "{{}}" });
    for (const [par, repls] of outcome.repls) noteRepls(section, par, repls);
  }
  for (const row of idleRows) {
    if (row.count === 0) continue;
    report.skipped.push({ ruleId: row.ruleId, anchor: row.anchor, code: "REPEAT_INACTIVE", message: `조건이 거짓이라 행을 반복하지 않아 원형 행 안의 원소·순번 자리 ${row.count}곳을 채우지 않았습니다.` });
  }
  for (const [path, x] of [...implicit].sort(([a], [b]) => (a < b ? -1 : 1))) {
    report.actions.push({ ruleId: "implicit", type: "fill", anchor: `{{${path}}}`, targets: x.count, value: x.value });
  }
  for (const [path, n] of [...implicitDropped].sort(([a], [b]) => (a < b ? -1 : 1))) {
    report.dropped.push({ ruleId: "implicit", anchor: `{{${path}}}`, reason: `삭제·교체되는 범위나 메일 머지 필드가 맡는 표시 글 안의 자리 ${n}곳을 버렸습니다.` });
  }

  // ── 3c. 누름틀·메일 머지 필드 암묵 채움 ──────────────────────
  // `type="CLICK_HERE"`인 필드(누름틀)와 `type="MAILMERGE"`인 필드(메일 머지 필드)만 대상이다. 책갈피·날짜 같은 다른 종류의 필드는 채우지 않고 보고(`skipped`·`required`·`dropped`)에도 넣지 않는다.
  // 템플릿이 없거나 템플릿에 그 필드를 가리키는 규칙(조건이 거짓인 것도)이 없으면, 이름(메일 머지 필드는 키)이 데이터 경로 문법에 맞는 필드는 "이름 = 데이터 경로"로 채운다
  // (`{{}}`의 암묵 채움과 같은 누락 정책·보고). 같은 이름(키)의 필드는 전부 같은 값이다. 규칙이 가리키는 필드는(type과 무관하게) 그 규칙이 맡는다.
  // 메일 머지 필드는 누름틀과 같은 코드(`fieldFillBlock`·`planFieldFill`·구간 치환)로 채운다. 필드의 매개변수·type·그 밖의 속성은 건드리지 않고(`dirty`는 누름틀과 같게 "1"), 보고에는 `field:` 대신 `merge:`를 쓴다.
  const implicitFields = new Map<string, { count: number; value: ValueDigest }>();
  const implicitFieldDropped = new Map<string, number>();
  const bumpName = (m: Map<string, number>, name: string): void => void m.set(name, (m.get(name) ?? 0) + 1);
  for (const target of implicitTargets) {
    const name = pathOfField(target);
    const id = fieldIdOf(target);
    const merge = target.info.type === "MAILMERGE";
    const where = `${target.section.entryName} [${target.paragraph.path.join(", ")}]`;
    // 다른 누름틀의 구간 치환이 지우는 구간 안의 누름틀은 이름·모양과 상관없이 함께 사라진다
    if (fieldSpanOver(target) !== undefined) {
      bumpName(implicitFieldDropped, id);
      continue;
    }
    if (!isValidPath(name)) {
      if (merge) {
        report.skipped.push({ ruleId: "implicit", anchor: id, code: "MERGE_KEY_NOT_PATH", message: `메일 머지 필드의 키 '${name}'이(가) 데이터 경로(글자·숫자·_·-를 .으로 이은 꼴)가 아니라 채우지 않고 그대로 둡니다.`, where });
      } else {
        report.skipped.push({ ruleId: "implicit", anchor: id, code: "FIELD_NAME_NOT_PATH", message: "누름틀 이름이 데이터 경로(글자·숫자·_·-를 .으로 이은 꼴)가 아니라 채우지 않고 그대로 둡니다.", where });
      }
      continue;
    }
    const block = fieldFillBlock(target);
    if (block !== undefined) {
      report.skipped.push({ ruleId: "implicit", anchor: id, code: block.code, message: `${block.message} 그대로 둡니다.`, where });
      continue;
    }
    // 삭제·교체되는 문단 안이거나 반복할 원형 행 안의 누름틀, 다른 누름틀의 구간 치환으로 지워지는 누름틀은 채우지 않는다
    if (implicitGone(target)) {
      bumpName(implicitFieldDropped, id);
      continue;
    }
    required.add(name);
    const value = resolvePathValue(dataset, name, policy);
    if (value.kind === "error") {
      valueError(id, value.code, value.message, value.path ?? name);
      continue;
    }
    if (value.kind === "keep") {
      keptPaths.set(name, (keptPaths.get(name) ?? 0) + 1);
      missingPaths.add(name);
      continue;
    }
    if (value.kind === "empty") missingPaths.add(name);
    const text = value.kind === "text" ? value.text : "";
    const fill = implicitPlans.get(target) ?? planFieldFill(ctxOf(target.section), target, text, `${labelOf(id)} 채움`);
    if ("fail" in fill) {
      issues.push(issueFor(fill.fail.code, fill.fail.message, id));
      continue;
    }
    commitField(id, target, fill);
    implicitFields.set(id, { count: (implicitFields.get(id)?.count ?? 0) + 1, value: digestValue(text) });
  }
  for (const [id, x] of [...implicitFields].sort(([a], [b]) => (a < b ? -1 : 1))) {
    report.actions.push({ ruleId: "implicit", type: "fill", anchor: id, targets: x.count, value: x.value });
  }
  for (const [id, n] of [...implicitFieldDropped].sort(([a], [b]) => (a < b ? -1 : 1))) {
    report.dropped.push({ ruleId: "implicit", anchor: id, reason: `삭제·교체되는 범위나 반복할 원형 행 안의 ${id.startsWith("merge:") ? "메일 머지 필드" : "누름틀"} ${n}곳을 채우지 않았습니다.` });
  }

  // ── 4. 같은 자리 충돌과 중복 정리 ───────────────────────────
  const edits: SpanEdit[] = [];
  for (const list of groupBy(tagged, (t) => t.edit.entry).values()) {
    const sorted = list
      .map((t, i) => ({ t, i }))
      .sort((a, b) => a.t.edit.start - b.t.edit.start || a.t.edit.end - b.t.edit.end || a.i - b.i)
      .map((x) => x.t);
    let prev: Tagged | undefined;
    for (const cur of sorted) {
      // 글을 같은 글로 바꾸는 편집은 하지 않는다(채울 것이 없으면 바이트가 그대로여야 한다)
      if (cur.edit.replacement === cur.edit.expected) continue;
      if (prev !== undefined) {
        const e = prev.edit;
        const c = cur.edit;
        if (e.start === c.start && e.end === c.end && e.replacement === c.replacement) continue;
        if (c.start < e.end || (c.start === e.start && c.end === e.end)) {
          if (!reportedErrors.has(`conflict\u0000${prev.label}\u0000${cur.label}`)) {
            reportedErrors.add(`conflict\u0000${prev.label}\u0000${cur.label}`);
            issues.push(makeIssue("error", "TPL_CONFLICT", `${prev.label}와 ${cur.label}이(가) 같은 자리를 서로 다른 값으로 바꿉니다.`, cur.label));
          }
          continue;
        }
      }
      edits.push(cur.edit);
      prev = cur;
    }
  }
  for (const d of deletes) edits.push(...d.edits);
  edits.push(...insertEdits);

  // ── 4b. 구간 치환과 삭제·행 반복의 겹침 ────────────────────────
  // 값을 바꾸는 편집끼리의 겹침은 4가 잡았고, 구간 안의 채움·삽입·주입·표 설정은 규칙을 평가할 때 `clashSpan`이 잡았다.
  // 여기서는 구간 치환이 지우는 구간 안(또는 구간 경계를 가로질러)을 건드리는 삭제·행 반복을 잡는다(그대로 두면 적용 단계의 `EDIT_OVERLAP`이나 앵커 유실로 나온다).
  for (const reg of fieldSpans.filter((x) => x.counted)) {
    const { start, end, entry } = reg.range;
    const hits = (e: { start: number; end: number }): boolean => e.start < end && e.end > start;
    for (const d of deletes) {
      if (d.parts.some((part) => part.entry === entry && hits(part))) clashSpan(reg, d.rules[0]?.ruleId ?? "삭제");
    }
    for (const row of repeatRows) if (row.active && row.range.entry === entry && hits(row.range)) clashSpan(reg, row.ruleId);
  }

  // ── 5. 줄 배치 캐시 ─────────────────────────────────────────
  const changed = new Set<string>(touchedEntries);
  for (const e of edits) changed.add(e.entry);
  for (const section of doc.sections) {
    if (!changed.has(section.entryName)) continue;
    for (const par of walkParagraphs(section.paragraphs)) {
      const seg = par.lineSegArray;
      if (seg === undefined || isDeleted(rangeOf(section, seg)) || isReplaced(rangeOf(section, par.element))) continue;
      edits.push(span(ctxOf(section), seg.start, seg.end, "", "줄 배치 캐시 제거"));
    }
  }

  // ── 6. 기대값 ───────────────────────────────────────────────
  // 여러 문단에 걸친 누름틀을 채우면 끝 문단이 시작 문단에 합쳐진다: 합친 문단의 글 = 시작 문단의 글(값으로 바뀐 뒤) + 끝 문단 글의 끝 표식부터 뒤.
  // 끝 문단은 따로 기대하지 않는다(사라진다). 끝 문단이 또 다른 구간 치환의 시작 문단이면 그 합침도 이어서 센다.
  const mergeEnd = new Map<ParagraphNode, { endParagraph: ParagraphNode; endFrom: number }>();
  for (const reg of fieldSpans) {
    const merge = reg.counted ? reg.fill.span?.merge : undefined;
    if (merge !== undefined) mergeEnd.set(reg.target.paragraph, merge);
  }
  const absorbed = new Set([...mergeEnd.values()].map((m) => m.endParagraph));
  const finalText = (par: ParagraphNode): string => {
    const slot = touched.get(par);
    const own = slot === undefined ? par.logicalText : applyRepls(par.logicalText, slot.repls);
    const merge = mergeEnd.get(par);
    return merge === undefined ? own : own + finalText(merge.endParagraph).slice(merge.endFrom);
  };
  for (const [par, slot] of touched) {
    if (absorbed.has(par)) continue;
    if (!isDeleted({ entry: slot.entry, start: par.element.start, end: par.element.end })) {
      expectations.push({ kind: "text", entry: slot.entry, paragraphStart: par.element.start, text: finalText(par) });
    }
  }

  // ── 7. 보고서 ───────────────────────────────────────────────
  for (const x of explicit) {
    const entry: FillReport["actions"][number] = { ruleId: x.ruleId, type: x.type, anchor: x.anchor, targets: x.targets };
    if (x.position !== undefined) entry.position = x.position;
    if (x.value !== undefined) entry.value = x.value;
    report.actions.push(entry);
  }
  for (const d of deletes) {
    for (const r of d.rules) {
      // 원소가 0개인 행 반복은 원형 행 삭제로 처리하지만 보고서에는 `repeat`(0행)로 남긴다
      const type = repeatRuleIds.has(r.ruleId) ? "repeat" : "delete";
      const found = report.actions.find((a) => a.ruleId === r.ruleId && a.type === type);
      if (found === undefined) report.actions.push({ ruleId: r.ruleId, type, anchor: r.anchor, targets: type === "repeat" ? 0 : d.parts.length });
      else if (type === "delete") found.targets += d.parts.length;
    }
  }
  // 이동표: 문단 삭제는 문단마다, range 앵커의 삭제는 범위 하나가 항목 하나다(구조 변경 하나당 항목 하나)
  const rangeDeletes = regs.filter((o) => o.type === "delete");
  for (const d of deletes) {
    const par = d.kind === "paragraph" ? d.paragraph : undefined;
    if (par === undefined || d.rules.some((r) => rangeDeletes.some((o) => o.ruleId === r.ruleId))) continue;
    const index = par.path[par.path.length - 1] ?? 0;
    noteMove(d.section.index, par.element.start, par.path.slice(0, -1), index, index, 0);
  }
  for (const op of rangeDeletes) {
    const { section, parentPath, from, to, paragraphs } = op.resolved;
    if (paragraphs.every((p) => deletes.some((d) => d.paragraph === p))) noteMove(section.index, op.range.start, parentPath, from, to, 0);
  }
  const moves = moveEntries.sort((a, b) => a.move.sectionIndex - b.move.sectionIndex || a.at - b.at || a.seq - b.seq).map((x) => x.move);
  report.moves = moves.map((m) => ({ ...m, parentPath: [...m.parentPath] }));
  let delta = zeroDelta();
  for (const d of deletes) delta = addDelta(delta, d.delta);
  delta = addDelta(delta, insertDelta);
  delta = addDelta(delta, spanDelta);
  let expected = delta;
  for (const step of repeatSteps) expected = addDelta(expected, step.delta);
  for (const step of injects) expected = addDelta(expected, step.delta);
  report.expected = deltaRecord(expected);
  report.requiredPaths = [...required].sort();
  report.missingPaths = [...missingPaths].sort();
  report.kept = [...keptPaths].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, count]) => ({ path, count }));

  const plan: FillPlan = {
    edits,
    additions: [],
    summary: { edits: edits.length, deletes: deletes.length, repeats: repeatSteps.length, injects: injects.length },
    issues: [],
    injects,
    repeats: repeatSteps,
    expectations,
    delta,
    fragmentDigests,
    moves,
  };
  return { plan, report };
}
