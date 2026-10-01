// 삽입 방식 M1~M10. 방식마다 같은 입력(쌍·구간·시드)이면 같은 단계를 밟는다(재실행 결정성 검사 V-h가 이를 쓴다).
import { createHash } from "node:crypto";
import {
  HwpxError,
  applyPlan,
  extractFragment,
  openPackage,
  parseDocument,
  planImport,
  type Fragment,
  type FragmentSelection,
  type HwpxDocument,
  type InsertPoint,
} from "../../packages/hwpx-engine/src/index.ts";
import { mergeInherited } from "../../packages/hwpx-engine/src/fill/index.ts";
import type { ImportOptions, InheritedProblems } from "../../packages/hwpx-engine/src/fragment/types.ts";
import { validateDocument, type ValidationReport } from "../../packages/hwpx-engine/src/validate/index.ts";
import { cellPoint, type DocInfo, type WindowPick } from "./docinfo.ts";
import { applyFormats, type FormatStats } from "./formats.ts";
import { hashSeed, makeRng, type Rng } from "./rng.ts";
import {
  verifyDocument,
  verifyStep,
  type Fail,
  type Notes,
  type Origin,
  type Step,
} from "./verify.ts";

export const METHODS = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10"] as const;
export type MethodName = (typeof METHODS)[number];

export type Loaded = { id: string; bytes: Uint8Array; doc: HwpxDocument; baseline: ValidationReport; info: DocInfo };

export type PairCtx = {
  pair: number;
  seed: number;
  src: Loaded;
  win: WindowPick;
  tgt: Loaded;
  /** 연쇄(M8)의 세 번째 문서를 읽어 온다. 호출할 때마다 새로 읽는다. */
  loadThird: () => Loaded;
  /** 쪼개기 비교용: 이 대상에 통째로 넣었을 때 추가되는 자원 수(M1에서 얻은 값) */
  wholeAdded?: number;
};

/** 엔진이 코드와 함께 거절했거나(rejected), 출력은 났는데 검증이 막힌(defect) 경우 */
export class CaseStop extends Error {
  kind: "rejected" | "defect" | "skipped";
  item: string;
  code: string;
  site: string;
  /** 구조적인 세부(어느 목록이 없는지 등). 문서의 글·이름은 담지 않는다. */
  detail: string;
  constructor(kind: CaseStop["kind"], item: string, code: string, site = "", detail = "") {
    super(`${kind}:${item}:${code}`);
    this.kind = kind;
    this.item = item;
    this.code = code;
    this.site = site;
    this.detail = detail;
  }
}

/** 거절 코드의 구조적 세부만 꺼낸다(목록 종류, 접두사·역할 이름). */
function detailOf(e: HwpxError): string {
  if (e.code === "FRAG_NO_LIST") return /대상 header에 (\S+) 목록/.exec(e.message)?.[1] ?? "";
  if (e.code === "FRAG_NS_MISMATCH") {
    const m = /접두사 '([^']*)'.*?'([^']*)' 역할이고 대상에서는 '([^']*)'/.exec(e.message);
    return m === null ? "" : `${m[1]}:${m[2]}->${m[3]}`;
  }
  return "";
}

/** 엔진 소스 안의 오류 발생 위치(`fragment/import.ts:123`). 문서 내용이 아니라 코드 위치다. */
function siteOf(e: unknown): string {
  const stack = e instanceof Error ? (e.stack ?? "") : "";
  const m = /hwpx-engine[\\/]src[\\/]([^:)\s]+):(\d+)/.exec(stack);
  return m === null ? "" : `${m[1]?.replace(/\\/g, "/")}:${m[2]}`;
}

type Phase = "extract" | "plan" | "apply" | "parse" | "format";

function guard<T>(phase: Phase, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CaseStop) throw e;
    if (e instanceof HwpxError) {
      if (phase === "parse") throw new CaseStop("defect", "V-a", e.code, siteOf(e));
      throw new CaseStop("rejected", phase, e.code, siteOf(e), detailOf(e));
    }
    const name = e instanceof Error ? e.name : "Error";
    throw new CaseStop("defect", "exception", `${name}(${phase})`, siteOf(e));
  }
}

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
export const reparse = (bytes: Uint8Array): HwpxDocument => parseDocument(openPackage(bytes));

export function loadDocument(id: string, bytes: Uint8Array, info: DocInfo): Loaded {
  const doc = reparse(bytes);
  return { id, bytes, doc, baseline: validateDocument(bytes), info };
}

// ── 지점 ────────────────────────────────────────────────────────

function endPoint(doc: HwpxDocument): InsertPoint {
  for (let s = doc.sections.length - 1; s >= 0; s--) {
    const n = doc.sections[s]?.paragraphs.length ?? 0;
    if (n > 0) return { sectionIndex: s, parentPath: [], index: n - 1, position: "after" };
  }
  throw new CaseStop("skipped", "target", "NO_PARAGRAPH");
}

/** 문서 하나(가져오기가 끝난 결과)를 검증할 입력. `tail`이 있으면 마지막 단계의 결과 대신 그 문서(서식 변경을 마친 것)를 검증한다. */
type DocCheck = { base: Loaded; steps: Step[]; tail?: { doc: HwpxDocument; bytes: Uint8Array }; strictDuplicates?: boolean };

type Anchor = { s: number; i: number };

/** 구역 설정이 없는 최상위 문단 후보 */
function anchorsOf(tgt: Loaded): Anchor[] {
  const out: Anchor[] = [];
  tgt.info.sections.forEach((sec, s) => sec.secPr.forEach((has, i) => (has ? undefined : out.push({ s, i }))));
  return out;
}

function pointBefore(a: Anchor, shift = 0): InsertPoint {
  return { sectionIndex: a.s, parentPath: [], index: a.i + shift, position: "before" };
}

// ── 단계 ────────────────────────────────────────────────────────

type State = {
  check: boolean;
  fails: Fail[];
  notes: Notes;
  steps: Step[];
  fragments: Fragment[];
};

function extract(doc: HwpxDocument, sel: FragmentSelection): Fragment {
  return guard("extract", () => extractFragment(doc, sel));
}

function runStep(base: HwpxDocument, fragment: Fragment, point: InsertPoint, options?: ImportOptions): Step {
  const plan = guard("plan", () => planImport(base, fragment, point, options));
  const bytes = guard("apply", () => applyPlan(base.pkg, plan));
  const result = guard("parse", () => reparse(bytes));
  return {
    base,
    fragment,
    point,
    plan,
    bytes,
    result,
    first: point.position === "before" ? point.index : point.index + 1,
    count: fragment.source.selection.to - fragment.source.selection.from + 1,
  };
}

function doStep(state: State, base: HwpxDocument, fragment: Fragment, point: InsertPoint, origin: Origin, options?: ImportOptions): Step {
  const step = runStep(base, fragment, point, options);
  state.steps.push(step);
  state.fragments.push(fragment);
  if (state.check) verifyStep(step, origin, state.fails, state.notes);
  return step;
}

// ── 쪼개기 ──────────────────────────────────────────────────────

/** 구간을 2~5개 부분으로 나눈다. 여러 문단에 걸친 누름틀 안쪽에서는 자르지 않는다. 자를 곳이 없으면 undefined */
function splitParts(win: WindowPick, forbidCut: readonly boolean[], rng: Rng): [number, number][] | undefined {
  const cuts: number[] = [];
  for (let c = win.from + 1; c <= win.to; c++) if (forbidCut[c] !== true) cuts.push(c);
  if (cuts.length === 0) return undefined;
  const k = Math.min(rng.range(2, 5), cuts.length + 1);
  const chosen = rng.shuffle(cuts).slice(0, k - 1).sort((a, b) => a - b);
  const bounds = [win.from, ...chosen, win.to + 1];
  return bounds.slice(0, -1).map((from, i) => [from, (bounds[i + 1] ?? win.to + 1) - 1] as [number, number]);
}

// ── 방식 ────────────────────────────────────────────────────────

export type MethodOutcome = {
  steps: Step[];
  fails: Fail[];
  inherited: Fail[];
  notes: Notes;
  /** 단계마다 출력 바이트의 sha256(재실행 결정성 비교용) */
  outputs: string[];
  /** 오라클 후보: 최종 문서와 그것이 확장한 원본 문서 */
  /** 최종 문서, 그것이 확장한 원본 문서, 원본에서 최종 문서까지 이어 넣은 단계들 */
  final: { bytes: Uint8Array; base: Loaded; steps: Step[] };
  fragments: Fragment[];
  parts?: number;
  /** M10: 서식 변경을 적용한 종류별 건수와 거절 사유 */
  formats?: FormatStats;
};

const sumKey = (steps: readonly Step[], key: string): number => steps.reduce((n, s) => n + (s.plan.summary[key] ?? 0), 0);

/**
 * 한 건을 실행한다. `check`가 꺼져 있으면 검증은 건너뛰고 출력만 만든다(결정성 재실행).
 * 거절·결함 중단은 CaseStop으로 올라간다.
 */
export function runMethod(name: MethodName, ctx: PairCtx, check: boolean): MethodOutcome {
  const rng = makeRng(hashSeed(`${ctx.seed}:${ctx.pair}:${name}`));
  const state: State = { check, fails: [], notes: {}, steps: [], fragments: [] };
  const { src, win, tgt } = ctx;
  const sel = (from: number, to: number): FragmentSelection => ({ sectionIndex: win.sectionIndex, parentPath: [], from, to });
  const whole = (): Fragment => extract(src.doc, sel(win.from, win.to));
  const originOf = (s: FragmentSelection): Origin => ({ doc: src.doc, sel: s });
  const wholeOrigin = originOf(sel(win.from, win.to));
  let host: { sectionIndex: number; index: number } | undefined;
  let final: Loaded = tgt;
  let finalDoc: Step | undefined;
  let docChecks: DocCheck[] = [];
  let parts: number | undefined;
  let formats: FormatStats | undefined;
  let finalBytes: Uint8Array | undefined;
  const extraOutputs: string[] = [];
  const extraInherited: Fail[] = [];

  switch (name) {
    case "M1": {
      finalDoc = doStep(state, tgt.doc, whole(), endPoint(tgt.doc), wholeOrigin);
      docChecks = [{ base: tgt, steps: [finalDoc] }];
      break;
    }
    case "M2": {
      const anchors = anchorsOf(tgt);
      const point = anchors.length === 0 ? endPoint(tgt.doc) : pointBefore(rng.pick(anchors));
      finalDoc = doStep(state, tgt.doc, whole(), point, wholeOrigin);
      docChecks = [{ base: tgt, steps: [finalDoc] }];
      break;
    }
    case "M3": {
      const s = tgt.doc.sections.findIndex((x) => x.paragraphs.length > 0);
      if (s < 0) throw new CaseStop("skipped", "target", "NO_PARAGRAPH");
      finalDoc = doStep(state, tgt.doc, whole(), { sectionIndex: s, parentPath: [], index: 0, position: "after" }, wholeOrigin);
      docChecks = [{ base: tgt, steps: [finalDoc] }];
      break;
    }
    case "M4":
    case "M5": {
      const forbid = src.info.sections[win.sectionIndex]?.forbidCut ?? [];
      const split = splitParts(win, forbid, rng);
      if (split === undefined) throw new CaseStop("skipped", "source", "NO_SPLIT_POINT");
      parts = split.length;
      const anchors = anchorsOf(tgt);
      const steps: Step[] = [];
      let cur = tgt.doc;
      if (name === "M4") {
        // 같은 위치: 구역 설정이 없는 문단 앞(또는 끝)에서 시작해 부분마다 앞 부분 바로 뒤에 이어 붙인다.
        const anchor = anchors.length === 0 || rng.chance(0.25) ? undefined : rng.pick(anchors);
        let shift = 0;
        for (const [from, to] of split) {
          const point = anchor === undefined ? endPoint(cur) : pointBefore(anchor, shift);
          const step = doStep(state, cur, extract(src.doc, sel(from, to)), point, originOf(sel(from, to)));
          shift += step.count;
          steps.push(step);
          cur = step.result;
        }
      } else {
        // 다른 위치: 서로 다른 지점(구역 설정 없는 문단 앞 또는 끝)에 부분마다 넣는다.
        const pool: (Anchor | "end")[] = [...anchors, "end"];
        const slots = rng.shuffle(pool).slice(0, split.length);
        while (slots.length < split.length) slots.push(rng.pick(pool));
        const placed: { a: Anchor; count: number }[] = [];
        for (const [j, [from, to]] of split.entries()) {
          const slot = slots[j] ?? "end";
          let point: InsertPoint;
          if (slot === "end") point = endPoint(cur);
          else {
            const shift = placed.filter((q) => q.a.s === slot.s && q.a.i <= slot.i).reduce((n, q) => n + q.count, 0);
            point = pointBefore(slot, shift);
          }
          const step = doStep(state, cur, extract(src.doc, sel(from, to)), point, originOf(sel(from, to)));
          if (slot !== "end") placed.push({ a: slot, count: step.count });
          steps.push(step);
          cur = step.result;
        }
      }
      finalDoc = steps[steps.length - 1];
      docChecks = [{ base: tgt, steps }];
      if (check) {
        // 부분들의 합이 통째와 같다
        const joined = steps.flatMap((s) => s.fragment.texts);
        const wholeFrag = extract(src.doc, sel(win.from, win.to));
        if (joined.length !== wholeFrag.texts.length || joined.some((t, i) => t !== wholeFrag.texts[i])) state.fails.push({ item: "V-c", code: "SPLIT_SUM" });
        const c = (k: "paragraphs" | "tables" | "pictures" | "fields" | "bookmarks"): number => steps.reduce((n, s) => n + s.fragment.census[k], 0);
        for (const k of ["paragraphs", "tables", "pictures", "fields", "bookmarks"] as const) {
          if (c(k) !== wholeFrag.census[k]) state.fails.push({ item: "V-f", code: `SPLIT_CENSUS_${k.toUpperCase()}` });
        }
        if (ctx.wholeAdded !== undefined && sumKey(steps, "addedResources") !== ctx.wholeAdded) state.notes["split.addedSumDiffers"] = 1;
      }
      break;
    }
    case "M6": {
      const cell = cellPoint(tgt.doc);
      if (cell === undefined) throw new CaseStop("skipped", "target", "NO_TABLE_CELL");
      host = cell.host;
      finalDoc = doStep(state, tgt.doc, whole(), cell.point, wholeOrigin);
      docChecks = [{ base: tgt, steps: [finalDoc] }];
      break;
    }
    case "M7": {
      const fragment = whole();
      const first = doStep(state, tgt.doc, fragment, endPoint(tgt.doc), wholeOrigin);
      const second = doStep(state, first.result, fragment, endPoint(first.result), wholeOrigin);
      finalDoc = second;
      docChecks = [{ base: tgt, steps: [first, second] }];
      if (check) {
        // 소스에 없는 대상을 가리키는 참조가 있고 대상에 같은 id가 있으면, 처음 가져온 자원이 대상의 자원을 가리키게 되어 지문이 달라진다(명세 7.65).
        const sink = fragment.dangling.length > 0 ? extraInherited : state.fails;
        if ((second.plan.summary["addedResources"] ?? -1) !== 0) sink.push({ item: "V-f", code: "M7_SECOND_ADDED_RESOURCES" });
        if ((second.plan.summary["addedBinaries"] ?? -1) !== 0) sink.push({ item: "V-f", code: "M7_SECOND_ADDED_BINARIES" });
      }
      break;
    }
    case "M8": {
      const anchors = anchorsOf(tgt);
      const point = anchors.length === 0 ? endPoint(tgt.doc) : pointBefore(rng.pick(anchors));
      const first = doStep(state, tgt.doc, whole(), point, wholeOrigin);
      // 삽입된 구간을 B'에서 다시 조각으로 떠 세 번째 문서에 넣는다
      const reselect: FragmentSelection = { sectionIndex: first.point.sectionIndex, parentPath: [], from: first.first, to: first.first + first.count - 1 };
      const second = extract(first.result, reselect);
      const third = ctx.loadThird();
      const step2 = doStep(state, third.doc, second, endPoint(third.doc), wholeOrigin);
      finalDoc = step2;
      final = third;
      docChecks = [
        { base: tgt, steps: [first] },
        { base: third, steps: [step2] },
      ];
      break;
    }
    case "M9": {
      // 조각 안에서 겹치는 id를 첫 등장만 두고 새 값으로 바꾸는 선택 기능. 상속한 중복이 하나도 남지 않아야 한다.
      finalDoc = doStep(state, tgt.doc, whole(), endPoint(tgt.doc), wholeOrigin, { reissueInternalDuplicates: true });
      docChecks = [{ base: tgt, steps: [finalDoc], strictDuplicates: true }];
      if (check && finalDoc.plan.inherited.duplicateIds.length > 0) state.fails.push({ item: "V-f", code: "M9_INHERITED_DUPLICATES_REMAIN" });
      break;
    }
    case "M10": {
      // 통째로 대상 끝에 넣은 뒤, 삽입된 구간의 문단 몇 곳에 글자 서식·문단 서식을 적용한다(적용 -> 다시 파싱 -> 다음 적용).
      const imported = doStep(state, tgt.doc, whole(), endPoint(tgt.doc), wholeOrigin);
      const applied = guard("format", () => applyFormats(imported, rng, check));
      formats = applied.stats;
      const done = Object.values(applied.stats.applied).reduce((n, v) => n + v, 0);
      if (done === 0) {
        const rejected = Object.entries(applied.stats.rejected).sort(([, a], [, b]) => b - a)[0];
        if (rejected !== undefined) throw new CaseStop("rejected", "format", rejected[0]);
        throw new CaseStop("skipped", "source", "NO_FORMAT_TARGET");
      }
      state.fails.push(...applied.fails);
      for (const [k, v] of Object.entries(applied.notes)) state.notes[k] = (state.notes[k] ?? 0) + v;
      extraOutputs.push(...applied.outputs);
      finalDoc = imported;
      finalBytes = applied.bytes;
      docChecks = [{ base: tgt, steps: [imported], tail: { doc: applied.doc, bytes: applied.bytes } }];
      break;
    }
  }

  const inherited: Fail[] = [...extraInherited];
  if (check) {
    for (const dc of docChecks) {
      const last = dc.steps[dc.steps.length - 1];
      if (last === undefined) continue;
      const base = { doc: dc.base.doc, baseline: dc.base.baseline };
      // 상속은 이 문서를 만든 단계들의 계획이 기록한 것만 인정한다. M9는 상속한 중복이 남지 않아야 하므로 중복 기록을 인정하지 않는다.
      const recorded: InheritedProblems = mergeInherited(dc.steps.map((st) => st.plan.inherited));
      const credited: InheritedProblems = dc.strictDuplicates === true ? { duplicateIds: [], danglingRefs: recorded.danglingRefs } : recorded;
      const tail = dc.tail ?? { doc: last.result, bytes: last.bytes };
      const input = { base, result: tail.doc, bytes: tail.bytes, steps: dc.steps, inherited: credited, fragments: dc.steps.map((st) => st.fragment), ...(dc.tail === undefined ? {} : { afterFormat: true }) };
      const out = verifyDocument(host === undefined ? input : { ...input, hostParagraph: host }, state.notes);
      state.fails.push(...out.fails);
      inherited.push(...out.inherited);
    }
  }
  if (finalDoc === undefined) throw new CaseStop("skipped", "method", "NO_STEP");
  const outcome: MethodOutcome = {
    steps: state.steps,
    fails: state.fails,
    inherited,
    notes: state.notes,
    outputs: [...state.steps.map((s) => sha256(s.bytes)), ...extraOutputs],
    final: { bytes: finalBytes ?? finalDoc.bytes, base: final, steps: final === tgt ? state.steps : state.steps.slice(-1) },
    fragments: state.fragments,
  };
  if (parts !== undefined) outcome.parts = parts;
  if (formats !== undefined) outcome.formats = formats;
  return outcome;
}
