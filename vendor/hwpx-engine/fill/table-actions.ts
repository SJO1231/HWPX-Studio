import { mergePlans, type EditPlan, type SpanEdit } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { parseParagraph, walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, ParagraphNode, SectionModel } from "../model/types.ts";
import { makeLookup } from "../fragment/resources.ts";
import type { InheritedProblems } from "../fragment/types.ts";
import { isNoRefOf } from "../fragment/util.ts";
import { collectBodyRefs } from "../model/refs.ts";
import { LINESEG_REASON } from "../table/edit.ts";
import { planRepeatRows } from "../table/rows.ts";
import { readTableGrid } from "../table/grid.ts";
import { planScaleTable, planSetColumnWidths, planSetRowHeights } from "../table/size.ts";
import { planSetCellProps, planSetTableProps } from "../table/props.ts";
import { applySpanEdits } from "../table/edit.ts";
import { declsOf, unwrapXml, wrapXml } from "../table/wrap.ts";
import type { Dataset, MissingPolicy, MixedFormatPolicy, ResizeAction, TablePropsAction } from "../template/types.ts";
import { rowDataset } from "../template/value.ts";
import { attrValue, childEl, childEls, elIs, walkElements, type XElement } from "../xml/tree.ts";
import type { ResolvedAnchor } from "./anchors.ts";
import type { Delta } from "./census.ts";
import { applyRepls, makeMapper } from "./doc.ts";
import { fillPlaceholders, type PlaceholderOutcome } from "./placeholders.ts";

/** 표 연산 계획에서 본문 구역의 편집만(줄 배치 캐시 제거는 `buildFillPlan`이 구역 전체에 대해 따로 낸다). */
function bodyEdits(plan: EditPlan, entry: string): SpanEdit[] {
  return plan.edits.filter((e) => e.entry === entry && e.reason !== LINESEG_REASON);
}

/** 표 액션이 가리키는 표 요소: `object`(표) 앵커나 `cell` 앵커가 든 표 */
export function tableElementOf(anchor: ResolvedAnchor): { section: SectionModel; element: XElement } | undefined {
  if (anchor.kind === "object" && elIs(anchor.object.element, "paragraph", "tbl")) return { section: anchor.section, element: anchor.object.element };
  if (anchor.kind === "cell") return { section: anchor.section, element: anchor.table.element };
  return undefined;
}

/**
 * 같은 계획에서 지워지는 행. `rows`는 지워지는 행의 주소(`rowAddr`), `covers`는 편집 구간이 지워지는 행 안에 드는지 알려 준다.
 * 지워지는 행 안의 편집은 같은 구간을 지우는 편집과 겹치므로(`EDIT_OVERLAP`) 뺀다. 줄 배치 캐시 편집을 빼는 것과 같은 규칙이다.
 */
export type GoneRows = { rows: ReadonlySet<number>; covers: (start: number, end: number) => boolean };

/** 연속한 `[from, to]`에서 `gone`에 든 행을 빼고 남은 연속 구간들 */
function runsWithout(from: number, to: number, gone: ReadonlySet<number>): [number, number][] {
  const runs: [number, number][] = [];
  for (let r = from; r <= to; r++) {
    if (gone.has(r)) continue;
    const last = runs[runs.length - 1];
    if (last !== undefined && last[1] === r - 1) last[1] = r;
    else runs.push([r, r]);
  }
  return runs;
}

/**
 * `tableProps`·`resize` 액션의 편집. 표 연산(`src/table`)이 거절하면 그 `HwpxError`를 그대로 던진다.
 * `targets`는 바뀌는 자리 수(표 설정이면 1, 선택한 셀마다 1, 크기 변경은 1)다.
 * `gone`이 있으면(같은 계획에서 행이 지워지는 표) 지워지는 행만 가리키는 `rowHeights`·`cells` 항목은 버리고(`dropped`에 사유를 돌려준다),
 * 걸친 항목은 남은 행에만 적용하며, 열 너비·비례 조정이 만든 셀 편집 가운데 지워지는 행 안의 것은 뺀다.
 */
export function planTableAction(
  doc: HwpxDocument,
  section: SectionModel,
  element: XElement,
  action: TablePropsAction | ResizeAction,
  gone?: GoneRows,
): { edits: SpanEdit[]; targets: number; dropped: string[] } {
  const target = { sectionIndex: section.index, element };
  const dropped: string[] = [];
  const keep = (edits: SpanEdit[]): SpanEdit[] => (gone === undefined ? edits : edits.filter((e) => !gone.covers(e.start, e.end)));
  if (action.type === "tableProps") {
    const edits: SpanEdit[] = [];
    let targets = 0;
    if (action.table !== undefined) {
      edits.push(...bodyEdits(planSetTableProps(doc, target, action.table), section.entryName));
      targets++;
    }
    if (action.cells !== undefined) {
      let entries = action.cells;
      if (gone !== undefined) {
        const rowCnt = readTableGrid(element).rowCnt;
        entries = [];
        action.cells.forEach((entry, i) => {
          const [from, to] = entry.rows;
          // 범위가 표 밖이면 그대로 넘겨 표 연산이 거절하게 한다
          if (!(from >= 0 && from <= to && to < rowCnt)) {
            entries.push(entry);
            return;
          }
          const runs = runsWithout(from, to, gone.rows);
          if (runs.length === 0) dropped.push(`tableProps.cells[${i}]: 가리키는 행이 모두 지워지는 행이라 버렸습니다.`);
          else if (runs.length === 1 && runs[0]?.[0] === from && runs[0]?.[1] === to) entries.push(entry);
          else for (const run of runs) entries.push({ ...entry, rows: [run[0], run[1]] });
        });
      }
      if (entries.length > 0) {
        const plan = planSetCellProps(doc, target, entries);
        edits.push(...bodyEdits(plan, section.entryName));
        targets += plan.summary["editedCells"] ?? 0;
      }
    }
    return { edits: keep(edits), targets, dropped };
  }
  const plans: EditPlan[] = [];
  if (action.columns !== undefined) plans.push(planSetColumnWidths(doc, target, action.columns));
  else if (action.width !== undefined) plans.push(planScaleTable(doc, target, { width: action.width }));
  else if (action.scale !== undefined) plans.push(planScaleTable(doc, target, { scale: action.scale }));
  let heights = action.rowHeights;
  if (heights !== undefined && gone !== undefined) {
    heights = heights.filter((h) => {
      if (!gone.rows.has(h.row)) return true;
      dropped.push(`resize.rowHeights: 행 ${h.row}은(는) 지워지는 행이라 그 항목을 버렸습니다.`);
      return false;
    });
  }
  if (heights !== undefined && heights.length > 0) plans.push(planSetRowHeights(doc, target, heights));
  const merged = plans.reduce((a, b) => mergePlans(a, { ...b, edits: bodyEdits(b, section.entryName) }), { edits: [], additions: [], summary: {}, issues: [] } as EditPlan);
  return { edits: keep(merged.edits), targets: plans.length > 0 ? 1 : 0, dropped };
}

// ── fitTable ────────────────────────────────────────────────────

/** `el`을 감싸는 표들(안쪽부터) */
export function enclosingTables(el: XElement): XElement[] {
  const out: XElement[] = [];
  for (let a = el.parent; a !== null; a = a.parent) if (elIs(a, "paragraph", "tbl")) out.push(a);
  return out;
}

export type FitChange = { table: XElement; changes: string[]; edits: SpanEdit[] };

/**
 * 문단을 감싸는 표들 가운데 잘릴 수 있는 표(글자처럼 취급이거나 `pageBreak`가 `NONE`·`TABLE`)를 쪽을 넘길 수 있게 바꾸는 편집:
 * `treatAsChar`를 0으로, `pageBreak`를 `CELL`로 한다. 바뀌는 항목마다 `changes`에 `이름 이전→이후`로 적는다.
 * `TABLE`(행 단위로만 나눔)도 넣은 것은 한컴 관측 때문이다: 쪽보다 긴 셀 내용을 넣으면 `CELL`만 쪽을 넘겨 끝까지 보이고 `TABLE`은 `NONE`·글자처럼 취급과 같이 잘렸다.
 */
export function planFitTables(doc: HwpxDocument, section: SectionModel, paragraph: XElement): FitChange[] {
  const out: FitChange[] = [];
  for (const table of enclosingTables(paragraph)) {
    const pos = childEl(table, "paragraph", "pos");
    const treat = attrValue(table, "treatAsChar") ?? (pos === undefined ? undefined : attrValue(pos, "treatAsChar"));
    const pageBreak = attrValue(table, "pageBreak");
    if (treat !== "1" && pageBreak !== "NONE" && pageBreak !== "TABLE") continue;
    const changes: string[] = [];
    if (treat === "1") changes.push("treatAsChar 1→0");
    if (pageBreak !== "CELL") changes.push(`pageBreak ${pageBreak ?? "(없음)"}→CELL`);
    const plan = planSetTableProps(doc, { sectionIndex: section.index, element: table }, { treatAsChar: false, pageBreak: "CELL" });
    out.push({ table, changes, edits: bodyEdits(plan, section.entryName) });
  }
  return out;
}

/** 보고서에 쓰는 표 식별: 구역 번호와 표 id(문서 내용이 아니다) */
export const tableLabel = (section: SectionModel, table: XElement): string => `구역 ${section.index} 표 id=${attrValue(table, "id") ?? "?"}`;

// ── repeat ──────────────────────────────────────────────────────

/** 주 계획 적용 뒤 하나씩 이어서 적용하는 행 반복 */
export type RepeatStep = {
  ruleId: string;
  anchor: string;
  entry: string;
  /** 원형 행(`tr`) 요소의 시작 오프셋(편집 전 문서) */
  rowStart: number;
  items: unknown[];
  as: string;
  index: string | undefined;
  dataset: Dataset;
  policy: MissingPolicy;
  mixed: MixedFormatPolicy;
  /** 계획 단계에서 복사본마다 `{{}}`를 채워 본 결과: 복사본 안 모든 문단의 논리 텍스트(문서 순서). 값 재읽기의 기대값이다. */
  texts: string[][];
  /** 이 단계가 더하는 수량: 원형 행을 `items.length`개로 바꾸므로 `(개수 - 1) × 행 수량` */
  delta: Delta;
  /** 원형 행이 원래 갖고 있던 문제(없는 서식을 가리키는 참조)를 복제해 늘린 기록. 저장 게이트가 이것으로 설명되는 검사 오류를 새 오류로 세지 않는다. */
  inherited: InheritedProblems;
};

/**
 * 원형 행 안에서 문서에 없는 자원을 가리키는 참조(`RES_DANGLING`의 원인)를 세어, 행을 `copies`번 더 복제할 때 늘어나는 개수로 돌려준다.
 * 조각 가져오기가 소스에서 갖고 있던 문제를 `inherited`로 남기는 것과 같은 방식이다(복제한 행은 원형 행의 문제를 그대로 물려받는다).
 */
export function inheritedOfRow(doc: HwpxDocument, tr: XElement, copies: number): InheritedProblems {
  const out: InheritedProblems = { duplicateIds: [], danglingRefs: [] };
  if (copies <= 0) return out;
  const lookup = makeLookup(doc);
  const counts = new Map<string, { kind: string; id: string; count: number }>();
  for (const ref of collectBodyRefs(tr)) {
    if (ref.kind === "memoShape" || ref.kind === "unknown" || isNoRefOf(ref.kind, ref.id)) continue;
    const missing = ref.kind === "binaryItem" ? lookup.binary(ref.id) === undefined : lookup.resource(ref.kind, undefined, ref.id) === undefined;
    if (!missing) continue;
    const key = `${ref.kind}\u0000${ref.id}`;
    const found = counts.get(key);
    if (found === undefined) counts.set(key, { kind: ref.kind, id: ref.id, count: copies });
    else found.count += copies;
  }
  out.danglingRefs = [...counts.values()];
  return out;
}

export { rowDataset };

export type FilledRow = { xml: string; texts: string[]; outcome: PlaceholderOutcome };

/** 행 원문 복사본 안 `{{}}`를 채운다(본문과 같은 규칙). `decls`는 원문이 쓰는 접두사 선언이다. */
export function fillRowCopy(xml: string, decls: ReadonlyMap<string, string>, dataset: Dataset, policy: MissingPolicy, mixed: MixedFormatPolicy): FilledRow {
  const w = wrapXml(xml, decls);
  const top: ParagraphNode[] = [];
  for (const tr of childEls(w.root, "paragraph", "tr")) {
    for (const tc of childEls(tr, "paragraph", "tc")) {
      const sub = childEl(tc, "paragraph", "subList");
      if (sub !== undefined) childEls(sub, "paragraph", "p").forEach((p, i) => top.push(parseParagraph(p, [i])));
    }
  }
  const all = [...walkParagraphs(top)];
  const outcome = fillPlaceholders({ entry: "row", text: w.text }, all, dataset, policy, mixed);
  const texts = all.map((p) => applyRepls(p.logicalText, outcome.repls.get(p) ?? []));
  return { xml: unwrapXml(applySpanEdits(w.text, outcome.edits), w.offset), texts, outcome };
}

/** 구역 항목 이름과 시작 오프셋으로 `tr` 요소를 찾는다. */
export function locateRow(doc: HwpxDocument, entry: string, start: number): { section: SectionModel; tr: XElement; table: XElement } | undefined {
  const section = doc.sections.find((s) => s.entryName === entry);
  if (section === undefined) return undefined;
  for (const el of walkElements(section.root)) {
    if (el.start === start && elIs(el, "paragraph", "tr") && el.parent !== null && elIs(el.parent, "paragraph", "tbl")) return { section, tr: el, table: el.parent };
  }
  return undefined;
}

/** 행 반복 단계의 편집 계획. 원형 행을 못 찾으면 `INJECT_ANCHOR_LOST`와 같은 사정이라 `HwpxError("REPEAT_ANCHOR_LOST")`. */
export function planRepeatStep(doc: HwpxDocument, step: RepeatStep, start: number): EditPlan {
  const found = locateRow(doc, step.entry, start);
  if (found === undefined) throw new HwpxError("REPEAT_ANCHOR_LOST", "앞 단계를 적용한 문서에서 원형 행을 다시 찾지 못했습니다.", `repeat:${step.ruleId}`);
  const row = readTableGrid(found.table).rows.indexOf(found.tr);
  const decls = declsOf(found.section.root);
  return planRepeatRows(doc, { sectionIndex: found.section.index, element: found.table }, {
    row,
    count: step.items.length,
    rewrite: (xml, i) => fillRowCopy(xml, decls, rowDataset(step.dataset, step.items, i, step.as, step.index), step.policy, step.mixed).xml,
  });
}

/** 반복으로 생긴 행들이 계획 단계에서 채워 본 글과 같은지 다시 읽어 확인한다(값 재읽기). `newStart`는 적용 뒤 첫 행의 시작 오프셋이다. */
export function verifyRepeat(next: HwpxDocument, step: RepeatStep, newStart: number): Issue[] {
  const where = `repeat:${step.ruleId}`;
  const found = locateRow(next, step.entry, newStart);
  if (found === undefined) return [makeIssue("error", "REREAD_TEXT", "반복한 첫 행을 출력에서 다시 찾지 못했습니다.", where)];
  const rows = childEls(found.table, "paragraph", "tr");
  const at = rows.indexOf(found.tr);
  const mine = rows.slice(at, at + step.items.length);
  if (mine.length !== step.items.length) return [makeIssue("error", "REREAD_TEXT", `반복한 행이 ${step.items.length}개여야 하는데 ${mine.length}개입니다.`, where)];
  const issues: Issue[] = [];
  mine.forEach((tr, i) => {
    const top: ParagraphNode[] = [];
    for (const tc of childEls(tr, "paragraph", "tc")) {
      const sub = childEl(tc, "paragraph", "subList");
      if (sub !== undefined) childEls(sub, "paragraph", "p").forEach((p, k) => top.push(parseParagraph(p, [k])));
    }
    const texts = [...walkParagraphs(top)].map((p) => p.logicalText);
    const want = step.texts[i] ?? [];
    const bad = texts.length !== want.length ? -2 : texts.findIndex((t, k) => t !== want[k]);
    if (bad !== -1) {
      issues.push(makeIssue("error", "REREAD_TEXT", bad === -2 ? `반복한 ${i + 1}번째 행의 문단이 ${want.length}개여야 하는데 ${texts.length}개입니다.` : `반복한 ${i + 1}번째 행의 문단 ${bad}의 글이 기대와 다릅니다(기대 길이 ${want[bad]?.length ?? 0}, 읽은 길이 ${texts[bad]?.length ?? 0}).`, where));
    }
  });
  return issues;
}

/** 이 단계가 만든 편집으로 원형 행 시작 위치가 어디로 옮겨졌는지 */
export function movedStart(plan: EditPlan, entry: string, start: number): number {
  return makeMapper(plan.edits.filter((e) => e.entry === entry))(start);
}
