import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { parseFragment } from "../fragment/json.ts";
import type { Fragment } from "../fragment/types.ts";
import { sha256Hex } from "../template/hash.ts";
import { bindValues } from "../template/studio-bind.ts";
import { selectSlots } from "../template/studio-select.ts";
import type {
  BlockContent,
  BoundValue,
  SlotSelection,
  StudioAnchor,
  StudioCase,
  StudioTemplate,
  TemplateBlock,
  TemplateSlot,
  ValuePlace,
} from "../template/studio-types.ts";
import type { Anchor, Dataset, ReportSkip } from "../template/types.ts";
import type { TextReport } from "../text/types.ts";
import { decodeUtf8 } from "../xml/parse.ts";
import type { Move } from "./anchor-types.ts";
import type { AnchorCheck } from "./check-anchors.ts";
import type { GenerateOptions, GenerateReport, Ledger, ValidationSummary } from "./gate.ts";
import type { ValidationIssue } from "../validate/index.ts";

// 2판 생성(엔진 명세 8.8.12)의 hwpx·md 공통 부분: 결과·보고서·원장의 형, 단계 1~4(원본 대조·검사·값·선택), 슬롯 계획, 느슨한 `{{ }}` 찾기.

/** 조각 덩어리를 내용 해시로 준다(없으면 undefined). 받은 바이트의 sha256이 요청한 해시와 같아야 한다. */
export type BlobLoader = (sha256: string) => Uint8Array | undefined;

/** 2판 생성 옵션. 1판 승계 템플릿은 `generate`에 그대로 넘긴다. 2판은 `fragments`·`allowNothingApplied`를 쓰지 않는다(조각은 `loadBlob`, 단계마다 켬). */
export type StudioGenerateOptions = GenerateOptions;

/** 블록 교체 범위 안에 들어 빠진 자리(오류 아님) */
export type CoveredPlace = { place: string; kind: ValuePlace["kind"]; code: "PLACE_COVERED"; message: string };

/** 값 표의 보고용 사본: 값 원문(`text`·`number`)은 없다 */
export type StudioValueReport = Omit<BoundValue, "text" | "number">;

export type StudioGenerateReport = {
  kind: "hwpx" | "md";
  dryRun: boolean;
  /** 값 표(8.8.4). 값 원문 없음 */
  values: StudioValueReport[];
  /** 슬롯 선택(8.8.8) */
  selections: SlotSelection[];
  /** 앵커 상태(8.8.13, hwpx. md는 빈 목록). 원본 해시가 같으므로 exact·unverified만 생성에 쓴다 */
  anchors: AnchorCheck[];
  /** 1단계(구조) 보고서. 바꿀 슬롯이 없거나 그 앞에서 멈췄으면 null */
  stage1: GenerateReport | TextReport | null;
  /** 2단계(값) 보고서. 채울 자리가 없거나 그 앞에서 멈췄으면 null */
  stage2: GenerateReport | TextReport | null;
  /** 1단계 이동표(7.10, 원본 좌표) */
  moves: Move[];
  /** 블록 교체 범위 안이라 빠진 word·line·cell·순번 자리(`PLACE_COVERED`) */
  dropped: CoveredPlace[];
  /** 두 단계의 건너뜀(`implicit` 제외). 1건이라도 있으면 `FILL_SKIPPED`로 실패한다 */
  skipped: ReportSkip[];
  /** 경고만(`issues`의 일부) */
  warnings: Issue[];
  /** 오류와 경고 전부 */
  issues: Issue[];
  /** 원본 대비 누적 검사(hwpx, 출력이 있을 때) */
  validation: { before: ValidationSummary; after: ValidationSummary; newErrors: ValidationIssue[] } | null;
  /** 후처리(켠 것만): 표식을 푼 필드 수, 미리보기 글을 다시 썼는지 */
  postprocess: { unwrapped: number; preview: boolean };
};

/** 2판 원장: 8.3 원장(두 단계를 합친 것)에 원본 해시, 템플릿 판·정규 JSON 해시, 이번 건 해시, 행 해시를 더한다. 값 원문은 없다. */
export type StudioLedger = Omit<Ledger, "template" | "dataset"> & {
  source: { sha256: string };
  template: { id: string; version: number; sha256: string };
  case?: { sha256: string };
  record: { sha256: string; dataset?: string; version?: number };
};

export type StudioGenerateResult =
  | { ok: true; dryRun: false; output: Uint8Array | string; report: StudioGenerateReport; ledger?: StudioLedger }
  | { ok: true; dryRun: true; report: StudioGenerateReport }
  | { ok: false; report: StudioGenerateReport };

export const EMPTY_DATASET: Dataset = { data: {}, derived: {} };

export function newReport(kind: "hwpx" | "md", dryRun: boolean): StudioGenerateReport {
  return { kind, dryRun, values: [], selections: [], anchors: [], stage1: null, stage2: null, moves: [], dropped: [], skipped: [], warnings: [], issues: [], validation: null, postprocess: { unwrapped: 0, preview: false } };
}

/** 보고서를 마무리한다(경고 목록을 채운다). */
export function finish<T extends { report: StudioGenerateReport }>(result: T): T {
  result.report.warnings = result.report.issues.filter((i) => i.severity === "warning");
  return result;
}

export const hasErrors = (issues: readonly Issue[]): boolean => issues.some((i) => i.severity === "error");
export const nfc = (s: string): string => s.normalize("NFC");
export const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export type Prepared = {
  values: BoundValue[];
  selections: SlotSelection[];
  /** 내용 해시 → 읽은 조각(hwpx) */
  fragments: Map<string, Fragment>;
};

/** 블록 내용: 이번 건의 `blockEdits`가 있으면 그것 */
const contentOf = (b: TemplateBlock, c: StudioCase | undefined): BlockContent => (c !== undefined && Object.hasOwn(c.blockEdits, b.id) ? (c.blockEdits[b.id] ?? b.content) : b.content);

/**
 * 단계 1~4: 원본 해시 대조(`TPL_SOURCE_MISMATCH`), 중첩 슬롯(`TPL_NESTED`), 조각 덩어리(`TPL_FRAGMENT_MISSING`, hwpx만),
 * 값 확정(`bindValues`), 선택(`selectSlots`, 막는 슬롯마다 `SEL_*`). 실패하면 `report.issues`에 오류를 담고 undefined.
 */
export function prepare(bytes: Uint8Array, t: StudioTemplate, record: Record<string, unknown>, c: StudioCase | undefined, loadBlob: BlobLoader, opts: StudioGenerateOptions, report: StudioGenerateReport): Prepared | undefined {
  const issues = report.issues;
  const got = sha256Hex(bytes);
  if (got !== t.source.sha256) {
    issues.push(
      makeIssue(
        "error",
        "TPL_SOURCE_MISMATCH",
        `원본 문서의 해시(${got.slice(0, 10)})가 템플릿의 source.sha256(${t.source.sha256.slice(0, 10)})과 다릅니다. 원본이 바뀌었으면 앵커를 다시 지정해 새 템플릿 판으로 저장해야 합니다.`,
        "source.sha256",
      ),
    );
    return undefined;
  }
  const nested = t.slots.filter((s) => s.parent !== null);
  if (nested.length > 0) {
    issues.push(makeIssue("error", "TPL_NESTED", `중첩 슬롯(${nested.map((s) => s.id).join("·")})은 예약 기능이라 생성할 수 없습니다.`, `slots.${nested[0]?.id ?? ""}`));
    return undefined;
  }
  const fragments = new Map<string, Fragment>();
  if (t.source.kind === "hwpx") {
    const contents = [...t.blocks.map((b) => ({ where: `blocks.${b.id}`, content: b.content })), ...Object.entries(c?.blockEdits ?? {}).map(([id, content]) => ({ where: `case.blockEdits.${id}`, content }))];
    for (const { where, content } of contents) {
      if (!("fragment" in content) || fragments.has(content.fragment)) continue;
      const sha = content.fragment;
      if (issues.some((i) => i.where === `blob:${sha}`)) continue;
      const blob = loadBlob(sha);
      if (blob === undefined || sha256Hex(blob) !== sha) {
        const why = blob === undefined ? "받지 못했습니다" : "받은 바이트의 해시가 요청한 해시와 다릅니다";
        issues.push(makeIssue("error", "TPL_FRAGMENT_MISSING", `${where}의 조각 덩어리 ${sha.slice(0, 10)}를 ${why}.`, `blob:${sha}`));
        continue;
      }
      try {
        fragments.set(sha, parseFragment(decodeUtf8(blob, `blob:${sha.slice(0, 10)}`)));
      } catch (e) {
        if (!(e instanceof HwpxError)) throw e;
        issues.push(makeIssue("error", e.code, `${where}의 조각 덩어리 ${sha.slice(0, 10)}를 읽을 수 없습니다: ${e.message}`, `blob:${sha}`));
      }
    }
    if (hasErrors(issues)) return undefined;
  }
  const values = bindValues(t, record, c, opts.missing === undefined ? {} : { missing: opts.missing });
  report.values = values.map(({ text: _text, number: _number, ...rest }) => rest);
  const selections = selectSlots(t, values, c);
  report.selections = selections;
  const slotName = new Map(t.slots.map((s) => [s.id, s.name]));
  for (const sel of selections) {
    if (sel.blocked !== undefined) issues.push(makeIssue("error", sel.blocked, `슬롯 ${sel.slot}(${slotName.get(sel.slot) ?? ""}): ${sel.message}`, `slots.${sel.slot}`));
  }
  if (hasErrors(issues)) return undefined;
  return { values, selections, fragments };
}

/** 슬롯 하나의 적용: 고른 블록, 그 내용(이번 건 수정 반영), 슬롯 앵커(문서 순서) */
export type SlotApply = { slot: TemplateSlot; block: TemplateBlock; content: BlockContent; anchors: StudioAnchor[] };

/** 앵커의 문서 순서 열쇠: 구역 번호 뒤에 문단 주소 */
function orderKey(a: StudioAnchor): number[] {
  if (a.kind === "range") return [a.at.sectionIndex, ...a.at.parentPath, a.from];
  if (a.kind === "headingRange") return [a.at.sectionIndex, ...a.at.parentPath, a.index];
  if (a.kind === "line") return [a.at.sectionIndex, ...a.at.path];
  return [];
}
function compareKeys(x: number[], y: number[]): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return x.length - y.length;
}

/** 슬롯마다(템플릿 순서) 고른 블록과 앵커(문서 순서). 선택은 이미 막힘 없이 정해졌다. */
export function slotApplies(t: StudioTemplate, selections: readonly SlotSelection[], c: StudioCase | undefined): SlotApply[] {
  const anchors = new Map(t.anchors.map((a) => [a.id, a]));
  const blocks = new Map(t.blocks.map((b) => [b.id, b]));
  return t.slots.flatMap((slot) => {
    const block = blocks.get(selections.find((s) => s.slot === slot.id)?.block ?? "");
    if (block === undefined) return [];
    const list = slot.anchors.flatMap((id) => {
      const a = anchors.get(id);
      return a === undefined ? [] : [a];
    });
    return [{ slot, block, content: contentOf(block, c), anchors: list.sort((x, y) => compareKeys(orderKey(x), orderKey(y))) }];
  });
}

/** 2판 앵커에서 1판 엔진이 받는 앵커로(패턴 id를 뗀다). mergeField는 1판 앵커가 아니라 undefined */
export function engineAnchor(a: StudioAnchor): Anchor | undefined {
  if (a.kind === "mergeField") return undefined;
  const { pattern: _pattern, ...rest } = a;
  return rest as Anchor;
}

/** 느슨한 `{{ 키 }}`(8.8.5): `{{`와 `}}` 사이(줄바꿈·`{{`·`}}` 없음) 글의 앞뒤 공백을 뺀 것이 키다. 키가 1~80자(코드 포인트)가 아니면 자리가 아니다. */
export type LooseHit = { start: number; end: number; key: string };
const LOOSE = /\{\{((?:(?!\{\{|\}\})[^\n\r])*)\}\}/g;
export function findLooseKeys(text: string): LooseHit[] {
  const out: LooseHit[] = [];
  for (const m of text.matchAll(LOOSE)) {
    const key = (m[1] ?? "").trim();
    const n = Array.from(key).length;
    if (n >= 1 && n <= 80) out.push({ start: m.index, end: m.index + m[0].length, key });
  }
  return out;
}

/** 값 하나로 채울 수 있나: 오류(`issue`)면 그 오류, 글이 없으면(누락 + keep) keep, 아니면 글 */
export function valueFor(v: BoundValue): { issue: { code: string; message: string } } | { keep: true } | { text: string } {
  if (v.issue !== undefined) return { issue: v.issue };
  return v.text === undefined ? { keep: true } : { text: v.text };
}

/** 등록되지 않은 `{{ }}`의 정책에 따른 이슈(키별 건수) */
export function unregisteredIssues(counts: ReadonlyMap<string, number>, policy: "error" | "keep"): Issue[] {
  return [...counts].map(([key, n]) =>
    makeIssue(
      policy === "error" ? "error" : "warning",
      "PLACE_UNREGISTERED",
      `등록되지 않은 자리 {{ ${key} }} ${n}곳이 있습니다${policy === "error" ? "(템플릿 places에 placeholder 자리로 등록해야 합니다)" : "(unregistered: keep이라 그대로 둡니다)"}.`,
      `{{${key}}}`,
    ),
  );
}

/** 건너뜀(`implicit` 제외)이 있으면 `FILL_SKIPPED`(코드별 건수) */
export function skippedIssue(skipped: readonly ReportSkip[]): Issue | undefined {
  if (skipped.length === 0) return undefined;
  const byCode = new Map<string, number>();
  for (const s of skipped) byCode.set(s.code, (byCode.get(s.code) ?? 0) + 1);
  return makeIssue("error", "FILL_SKIPPED", `건너뛴 자리가 ${skipped.length}곳 있어 출력을 만들지 않았습니다: ${[...byCode].map(([code, n]) => `${code} ${n}곳`).join(", ")}.`);
}
