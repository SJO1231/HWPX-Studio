import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";
import { createDeriver, type Deriver } from "../format/derive.ts";
import type { FormatDelta, FormatOp } from "../format/types.ts";
import type { HwpxDocument } from "../model/types.ts";
import { attrValue, childEl, type XElement } from "../xml/tree.ts";
import { escapeAttr } from "../xml/chars.ts";
import { lineSegEdits, prefixOf, resolveTarget, setAttrs, span, type Ctx } from "./edit.ts";
import { readTableGrid, type GridCell } from "./grid.ts";
import {
  BORDER_TYPES,
  HALIGNS,
  LINE_WRAPS,
  PAGE_BREAKS,
  VERT_ALIGNS,
  type BorderSpec,
  type CellPropsEntry,
  type CellSettings,
  type Margins,
  type TableSettings,
  type TableTarget,
} from "./types.ts";

const bad = (message: string): HwpxError => new HwpxError("TABLE_BAD_ARG", message);

const MAX_UNIT = 2147483647;
const SIDES = ["left", "right", "top", "bottom"] as const;

function oneOf<T extends string>(what: string, value: unknown, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === value);
  if (found === undefined) throw bad(`${what} ${JSON.stringify(value)}은(는) 쓸 수 있는 값이 아닙니다(${allowed.join(", ")}).`);
  return found;
}

function unit(what: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_UNIT) throw bad(`${what} ${JSON.stringify(value)}은(는) 0 이상의 정수여야 합니다.`);
  return value;
}

function bool(what: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw bad(`${what} ${JSON.stringify(value)}은(는) true나 false여야 합니다.`);
  return value;
}

function margins(what: string, value: unknown): Partial<Margins> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw bad(`${what}은(는) { left, right, top, bottom } 객체여야 합니다.`);
  const out: Partial<Margins> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!SIDES.includes(k as (typeof SIDES)[number])) throw bad(`${what}에 알 수 없는 키 '${k}'가 있습니다(left, right, top, bottom).`);
    out[k as keyof Margins] = unit(`${what}.${k}`, v);
  }
  if (Object.keys(out).length === 0) throw bad(`${what}에 값이 없습니다.`);
  return out;
}

// ── 테두리 ──────────────────────────────────────────────────────

/** `options`에서 파생기를 꺼낸다(없으면 undefined). 객체가 아니거나 파생기가 아니면 `TABLE_BAD_ARG`. */
function deriverOf(options: unknown): Deriver | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null) throw bad("options는 객체여야 합니다.");
  const given = (options as { deriver?: unknown }).deriver;
  if (given === undefined) return undefined;
  const d = given as Partial<Deriver> | null;
  if (typeof d !== "object" || d === null || typeof d.derive !== "function" || typeof d.finish !== "function") throw bad("options.deriver는 파생기여야 합니다.");
  return given as Deriver;
}

/** 테두리 요청을 서식 변경 연산으로 바꾼다. */
function borderDelta(spec: BorderSpec): FormatDelta {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) throw bad("border는 { sides?, type?, width?, color? } 객체여야 합니다.");
  const sides = spec.sides ?? [...SIDES];
  if (!Array.isArray(sides) || sides.length === 0 || sides.some((s) => !SIDES.includes(s))) throw bad("border.sides는 left·right·top·bottom 가운데 하나 이상이어야 합니다.");
  if (spec.type === undefined && spec.width === undefined && spec.color === undefined) throw bad("border에 type·width·color 가운데 하나는 있어야 합니다.");
  const values: [string, string][] = [];
  if (spec.type !== undefined) values.push(["type", oneOf("border.type", spec.type, BORDER_TYPES)]);
  if (spec.width !== undefined) {
    if (typeof spec.width !== "string" || !/^\d+(\.\d+)? mm$/.test(spec.width)) throw bad(`border.width ${JSON.stringify(spec.width)}은(는) '0.12 mm' 꼴이어야 합니다.`);
    values.push(["width", spec.width]);
  }
  if (spec.color !== undefined) {
    if (typeof spec.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(spec.color)) throw bad(`border.color ${JSON.stringify(spec.color)}은(는) '#RRGGBB' 꼴이어야 합니다.`);
    values.push(["color", spec.color.toUpperCase()]);
  }
  const ops: FormatOp[] = [];
  for (const side of new Set(sides)) for (const [name, value] of values) ops.push({ op: "setAttr", path: [`${side}Border`], name, value });
  return ops;
}

/** 테두리를 파생해 새 `borderFillIDRef` 값을 돌려준다. 기준이 없으면 `TABLE_BAD_ARG`. */
function derivedBorder(deriver: Deriver, baseId: string | undefined, spec: BorderSpec, what: string): string {
  if (baseId === undefined) throw bad(`${what}에 borderFillIDRef가 없어 테두리를 복제할 기준이 없습니다.`);
  return deriver.derive("borderFill", baseId, borderDelta(spec)).id;
}

// ── 자식 요소 만들기 ─────────────────────────────────────────────

/** 한컴 저장본(`hancom/ph-table`)의 `pos` 속성. 표에 `pos`가 없을 때 요청한 값을 얹어 만든다. */
const POS_DEFAULTS: Record<string, string> = {
  treatAsChar: "0",
  affectLSpacing: "0",
  flowWithText: "1",
  allowOverlap: "0",
  holdAnchorAndSO: "0",
  vertRelTo: "PARA",
  horzRelTo: "COLUMN",
  vertAlign: "TOP",
  horzAlign: "LEFT",
  vertOffset: "0",
  horzOffset: "0",
};

/** 한컴 저장본에서 관측한 `tbl` 자식 순서: sz, pos, outMargin, caption, inMargin, cellzoneList … */
const BEFORE: Record<string, string[]> = {
  pos: ["sz"],
  outMargin: ["pos", "sz"],
  inMargin: ["caption", "outMargin", "pos", "sz"],
};

function childInsertPoint(table: XElement, name: string): number {
  for (const predecessor of BEFORE[name] ?? []) {
    const found = childEl(table, "paragraph", predecessor);
    if (found !== undefined) return found.end;
  }
  return table.openEnd;
}

type ChildPlan = { edits: SpanEdit[]; insert?: { at: number; text: string; reason: string } };

/** 표의 자식 요소 `name`의 속성을 정한다. 요소가 없으면 `defaults`에 `values`를 얹은 요소를 관측한 자리에 넣는 삽입을 낸다. */
function tableChildPlan(ctx: Ctx, table: XElement, name: string, values: Record<string, string>, defaults: Record<string, string>, reason: string): ChildPlan {
  if (Object.keys(values).length === 0) return { edits: [] };
  const el = childEl(table, "paragraph", name);
  if (el !== undefined) return { edits: setAttrs(ctx, el, values, reason) };
  const merged = { ...defaults, ...values };
  const attrs = Object.entries(merged).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
  return { edits: [], insert: { at: childInsertPoint(table, name), text: `<${prefixOf(table)}${name}${attrs}/>`, reason: `${reason}(${name} 요소 추가)` } };
}

/** 같은 자리에 들어가는 삽입은 한 편집으로 합친다(여럿이 같은 자리면 계획 순서가 곧 요소 순서다). */
function mergeInserts(ctx: Ctx, plans: ChildPlan[]): SpanEdit[] {
  const edits: SpanEdit[] = plans.flatMap((p) => p.edits);
  const byAt = new Map<number, { text: string; reasons: string[] }>();
  for (const p of plans) {
    if (p.insert === undefined) continue;
    const slot = byAt.get(p.insert.at) ?? { text: "", reasons: [] };
    slot.text += p.insert.text;
    slot.reasons.push(p.insert.reason);
    byAt.set(p.insert.at, slot);
  }
  for (const [at, slot] of byAt) edits.push(span(ctx, at, at, slot.text, slot.reasons.join(", ")));
  return edits;
}

const marginValues = (m: Partial<Margins>): Record<string, string> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(v)]));
const ZERO_MARGINS: Record<string, string> = { left: "0", right: "0", top: "0", bottom: "0" };

// ── 계획 마무리 ──────────────────────────────────────────────────

export function finishPlan(doc: HwpxDocument, sectionIndex: number, edits: SpanEdit[], summary: Record<string, number>): EditPlan {
  const section = doc.sections[sectionIndex];
  // 다른 편집이 통째로 바꾸거나 지우는 구간 안의 줄 배치 캐시는 따로 지우지 않는다(구간이 겹치면 안 된다)
  const replaced = edits.filter((e) => e.end > e.start).map((e) => ({ start: e.start, end: e.end }));
  const all = edits.length === 0 || section === undefined ? edits : [...edits, ...lineSegEdits(section, replaced)];
  return { edits: all, additions: [], summary, issues: [] };
}

// ── 표 설정 ─────────────────────────────────────────────────────

/**
 * 표의 설정을 바꾼다: 글자처럼 취급, 쪽 나눔, 제목 행 반복, 가로 정렬, 바깥·안 여백, 셀 간격, 테두리. 요청한 항목만 바뀐다.
 * 속성이 없으면 더하고 있으면 값만 바꾼다. 없는 자식 요소(`pos`, `outMargin`, `inMargin`)는 한컴 저장본의 순서대로 만든다.
 * 테두리는 기준 테두리 자원을 복제한 파생 자원이다(`options.deriver`로 여러 계획이 같은 파생기를 쓰면 새 id가 겹치지 않는다. 그때는 호출자가 `finish()`의 계획을 더한다).
 * 설정은 격자가 불규칙해도 동작한다. 바뀐 것이 있으면 그 구역의 줄 배치 캐시를 전부 지운다.
 */
export function planSetTableProps(doc: HwpxDocument, target: TableTarget, props: TableSettings, options: { deriver?: Deriver } = {}): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  if (typeof props !== "object" || props === null) throw bad("props는 객체여야 합니다.");
  const known = ["treatAsChar", "pageBreak", "repeatHeader", "cellSpacing", "outMargin", "inMargin", "hAlign", "border"];
  for (const key of Object.keys(props)) if (!known.includes(key)) throw bad(`알 수 없는 표 설정 '${key}'입니다(${known.join(", ")}).`);
  if (Object.keys(props).length === 0) throw bad("바꿀 설정이 없습니다.");
  const given = deriverOf(options);

  const tableAttrs: Record<string, string> = {};
  const posAttrs: Record<string, string> = {};
  if (props.treatAsChar !== undefined) posAttrs["treatAsChar"] = bool("treatAsChar", props.treatAsChar) ? "1" : "0";
  if (props.hAlign !== undefined) posAttrs["horzAlign"] = oneOf("hAlign", props.hAlign, HALIGNS);
  if (props.pageBreak !== undefined) tableAttrs["pageBreak"] = oneOf("pageBreak", props.pageBreak, PAGE_BREAKS);
  if (props.repeatHeader !== undefined) tableAttrs["repeatHeader"] = bool("repeatHeader", props.repeatHeader) ? "1" : "0";
  if (props.cellSpacing !== undefined) tableAttrs["cellSpacing"] = String(unit("cellSpacing", props.cellSpacing));
  const outMargin = props.outMargin === undefined ? undefined : margins("outMargin", props.outMargin);
  const inMargin = props.inMargin === undefined ? undefined : margins("inMargin", props.inMargin);

  const deriver = given ?? createDeriver(doc);
  if (props.border !== undefined) tableAttrs["borderFillIDRef"] = derivedBorder(deriver, attrValue(table, "borderFillIDRef"), props.border, "표");

  const edits: SpanEdit[] = [
    ...setAttrs(ctx, table, tableAttrs, "표 설정"),
    ...mergeInserts(ctx, [
      tableChildPlan(ctx, table, "pos", posAttrs, POS_DEFAULTS, "표 위치 설정"),
      tableChildPlan(ctx, table, "outMargin", outMargin === undefined ? {} : marginValues(outMargin), ZERO_MARGINS, "표 바깥 여백"),
      tableChildPlan(ctx, table, "inMargin", inMargin === undefined ? {} : marginValues(inMargin), ZERO_MARGINS, "표 안 여백"),
    ]),
  ];

  let derivedPlan: EditPlan | undefined;
  if (given === undefined) derivedPlan = deriver.finish();
  const plan = finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, attributeEdits: edits.length });
  if (derivedPlan !== undefined) {
    plan.edits.push(...derivedPlan.edits);
    plan.summary["addedResources"] = derivedPlan.summary["addedResources"] ?? 0;
    plan.summary["reusedResources"] = derivedPlan.summary["reusedResources"] ?? 0;
  }
  return plan;
}

// ── 셀 설정 ─────────────────────────────────────────────────────

function readCellSettings(props: unknown): CellSettings {
  if (typeof props !== "object" || props === null || Array.isArray(props)) throw bad("props는 객체여야 합니다.");
  const p = props as Record<string, unknown>;
  const known = ["vertAlign", "lineWrap", "header", "margin", "protect", "border"];
  for (const key of Object.keys(p)) if (!known.includes(key)) throw bad(`알 수 없는 셀 설정 '${key}'입니다(${known.join(", ")}).`);
  if (Object.keys(p).length === 0) throw bad("바꿀 셀 설정이 없습니다.");
  const out: CellSettings = {};
  if (p["vertAlign"] !== undefined) out.vertAlign = oneOf("vertAlign", p["vertAlign"], VERT_ALIGNS);
  if (p["lineWrap"] !== undefined) out.lineWrap = oneOf("lineWrap", p["lineWrap"], LINE_WRAPS);
  if (p["header"] !== undefined) out.header = bool("header", p["header"]);
  if (p["protect"] !== undefined) out.protect = bool("protect", p["protect"]);
  if (p["margin"] !== undefined) out.margin = margins("margin", p["margin"]);
  if (p["border"] !== undefined) out.border = p["border"] as BorderSpec;
  return out;
}

function range(what: string, value: unknown): [number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) throw bad(`${what}은(는) [시작, 끝] 두 정수여야 합니다.`);
  const [from, to] = value as unknown[];
  if (typeof from !== "number" || typeof to !== "number" || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw bad(`${what} ${JSON.stringify(value)}은(는) 0 이상이고 시작이 끝보다 크지 않은 정수 쌍이어야 합니다.`);
  }
  return [from, to];
}

const inRange = (n: number, r: [number, number] | undefined): boolean => r === undefined || (r[0] <= n && n <= r[1]);

/**
 * 셀의 설정을 바꾼다: 세로 정렬, 줄 나눔, 제목 셀, 셀 여백, 테두리(파생 자원), 보호. 셀은 주소(`rowAddr`, `colAddr`)가 `rows`·`cols` 범위(양 끝 포함)에 드는 것이다.
 * `entries`는 차례로 적용하고 같은 셀의 같은 설정은 뒤의 것이 이긴다. 설정은 격자가 불규칙해도 동작한다(주소를 읽을 수 있는 셀만 고를 수 있다).
 * 셀 여백을 정하면 `tc@hasMargin`을 켠다. 선택에 맞는 셀이 하나도 없으면 `TABLE_BAD_ARG`.
 */
export function planSetCellProps(doc: HwpxDocument, target: TableTarget, entries: CellPropsEntry[], options: { deriver?: Deriver } = {}): EditPlan {
  const { ctx, table } = resolveTarget(doc, target);
  if (!Array.isArray(entries) || entries.length === 0) throw bad("entries는 비어 있지 않은 배열이어야 합니다.");
  const given = deriverOf(options);
  const grid = readTableGrid(table);
  const picked = new Map<GridCell, CellSettings>();
  for (const [i, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw bad(`entries[${i}]는 { rows?, cols?, props } 객체여야 합니다.`);
    const rows = range(`entries[${i}].rows`, entry.rows);
    const cols = range(`entries[${i}].cols`, entry.cols);
    const props = readCellSettings(entry.props);
    for (const cell of grid.cells) {
      if (inRange(cell.row, rows) && inRange(cell.col, cols)) picked.set(cell, { ...(picked.get(cell) ?? {}), ...props });
    }
  }
  if (picked.size === 0) throw bad("선택한 범위에 셀이 없습니다.");

  const deriver = given ?? createDeriver(doc);
  const inMargin = childEl(table, "paragraph", "inMargin");
  const edits: SpanEdit[] = [];
  for (const [cell, props] of picked) {
    const tcAttrs: Record<string, string> = {};
    if (props.header !== undefined) tcAttrs["header"] = props.header ? "1" : "0";
    if (props.protect !== undefined) tcAttrs["protect"] = props.protect ? "1" : "0";
    if (props.border !== undefined) tcAttrs["borderFillIDRef"] = derivedBorder(deriver, attrValue(cell.tc, "borderFillIDRef"), props.border, "셀");
    if (props.margin !== undefined) tcAttrs["hasMargin"] = "1";
    edits.push(...setAttrs(ctx, cell.tc, tcAttrs, "셀 설정"));

    const subAttrs: Record<string, string> = {};
    if (props.vertAlign !== undefined) subAttrs["vertAlign"] = props.vertAlign;
    if (props.lineWrap !== undefined) subAttrs["lineWrap"] = props.lineWrap;
    if (Object.keys(subAttrs).length > 0) {
      const sub = childEl(cell.tc, "paragraph", "subList");
      if (sub === undefined) throw new HwpxError("TABLE_IRREGULAR", `셀 (${cell.row}, ${cell.col})에 subList가 없어 세로 정렬·줄 나눔을 정할 수 없습니다.`, ctx.entry);
      edits.push(...setAttrs(ctx, sub, subAttrs, "셀 설정"));
    }

    if (props.margin !== undefined) {
      const el = childEl(cell.tc, "paragraph", "cellMargin");
      const values = marginValues(props.margin);
      if (el !== undefined) {
        edits.push(...setAttrs(ctx, el, values, "셀 여백"));
      } else {
        const base: Record<string, string> = {};
        for (const side of SIDES) base[side] = inMargin === undefined ? "0" : (attrValue(inMargin, side) ?? "0");
        const attrs = Object.entries({ ...base, ...values }).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
        const after = childEl(cell.tc, "paragraph", "cellSz") ?? childEl(cell.tc, "paragraph", "cellSpan") ?? childEl(cell.tc, "paragraph", "cellAddr");
        const at = after === undefined ? cell.tc.openEnd : after.end;
        edits.push(span(ctx, at, at, `<${prefixOf(table)}cellMargin${attrs}/>`, "셀 여백(cellMargin 요소 추가)"));
      }
    }
  }
  const plan = finishPlan(doc, target.sectionIndex, edits, { editedTables: 1, editedCells: picked.size });
  if (given === undefined) {
    const derivedPlan = deriver.finish();
    plan.edits.push(...derivedPlan.edits);
    plan.summary["addedResources"] = derivedPlan.summary["addedResources"] ?? 0;
    plan.summary["reusedResources"] = derivedPlan.summary["reusedResources"] ?? 0;
  }
  return plan;
}
