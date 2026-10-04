import { makeIssue } from "../errors.ts";
import type { Fragment } from "../fragment/types.ts";
import { parseDocument } from "../model/document.ts";
import type { HwpxDocument, ParagraphNode } from "../model/types.ts";
import { openPackage } from "../package/open.ts";
import { sha256Hex } from "../template/hash.ts";
import { readDataset } from "../template/read.ts";
import type { StudioCase, StudioTemplate, ValuePlace } from "../template/studio-types.ts";
import { canonicalStudioJson, caseSha256, templateSha256 } from "../template/studio-write.ts";
import { TEMPLATE_SCHEMA, type Anchor, type Template } from "../template/types.ts";
import { compareToBaseline, validateDocument } from "../validate/index.ts";
import type { Move } from "./anchor-types.ts";
import { linePrintOf, resolveAnchors, wordPrintAt, type ResolvedAnchor } from "./anchors.ts";
import { checkAnchors } from "./check-anchors.ts";
import { topLevelObjects } from "./doc.ts";
import { collectFields, fieldRangeIn, type FieldTarget } from "./fields.ts";
import { generate, type GateMode, type GenerateOptions, type GenerateResult, type Ledger } from "./gate.ts";
import { explainInherited, noInherited, splitTolerated } from "./inherited.ts";
import { remapAddress } from "./moves.ts";
import { generateStudioText } from "./generate-studio-text.ts";
import {
  EMPTY_DATASET,
  engineAnchor,
  findLooseKeys,
  finish,
  hasErrors,
  newReport,
  nfc,
  prepare,
  sameList,
  skippedIssue,
  slotApplies,
  unregisteredIssues,
  valueFor,
  type BlobLoader,
  type CoveredPlace,
  type StudioGenerateOptions,
  type StudioGenerateResult,
  type StudioLedger,
} from "./studio-common.ts";
import { fieldKey, refreshPreview, unwrapFields } from "./studio-post.ts";

// 2판 템플릿의 2단계 생성(엔진 명세 8.8.12). 순수 함수다(시계·파일 없음): 같은 입력은 같은 바이트와 같은 원장이다.
// 1단계(구조)는 원본 좌표에서 슬롯 앵커마다 고른 블록으로 교체하고, 2단계(값)는 그 조립본을 다시 파싱해 자리를 찾아 `{text}`로 채운다.
// 두 단계 모두 1판 `generate`(저장 게이트)를 그대로 쓴다.

/**
 * 템플릿으로 문서 하나를 만든다.
 * - 1판 승계 템플릿(`readStudioTemplate`가 돌려준 `template@1`): 기존 `generate` 한 번(데이터는 `readDataset(record)`). 1판 경로와 같은 바이트다(8.8.11).
 * - 2판 `source.kind: "hwpx"`: 원본 대조 → 검사 → 값 → 선택 → 1단계(구조) → 2단계(값) → 후처리(켠 것만) → 원본 대비 누적 검사 → 원장.
 * - 2판 `source.kind: "md"`: 텍스트 어댑터로 같은 순서(원장·후처리 없음). `bytes`는 입력 글의 UTF-8 바이트(BOM 포함)다.
 * 어느 단계든 실패하면 `{ ok: false, report }`이고 출력이 없다. 입력 문서를 열 수 없으면 `HwpxError`를 던진다(`generate`와 같다).
 */
export function generateFromTemplate(bytes: Uint8Array, t: Template, record: Record<string, unknown>, c: StudioCase | undefined, loadBlob: BlobLoader, opts?: GenerateOptions): GenerateResult;
export function generateFromTemplate(bytes: Uint8Array, t: StudioTemplate, record: Record<string, unknown>, c: StudioCase | undefined, loadBlob: BlobLoader, opts?: StudioGenerateOptions): StudioGenerateResult;
export function generateFromTemplate(bytes: Uint8Array, t: StudioTemplate | Template, record: Record<string, unknown>, c: StudioCase | undefined, loadBlob: BlobLoader, opts?: GenerateOptions): GenerateResult | StudioGenerateResult;
export function generateFromTemplate(bytes: Uint8Array, t: StudioTemplate | Template, record: Record<string, unknown>, c: StudioCase | undefined, loadBlob: BlobLoader, opts: GenerateOptions = {}): GenerateResult | StudioGenerateResult {
  if (t.schema === TEMPLATE_SCHEMA) return generate(bytes, t, readDataset(record), opts);
  return t.source.kind === "md" ? generateStudioText(bytes, t, record, c, loadBlob, opts) : generateStudioHwpx(bytes, t, record, c, loadBlob, opts);
}

/** 1단계에서 블록이 들어간 자리(조립본 좌표): 블록 id, 구역, 상위 목록, 문단 번호 범위 */
type Region = { block: string; sectionIndex: number; parentPath: number[]; from: number; to: number };

const inRegion = (regions: readonly Region[], block: string, sectionIndex: number, path: readonly number[]): boolean =>
  regions.some((r) => {
    const i = path[r.parentPath.length];
    return r.block === block && r.sectionIndex === sectionIndex && i !== undefined && r.parentPath.every((v, k) => path[k] === v) && i >= r.from && i <= r.to;
  });

/** 슬롯 앵커(원본에서 푼 자리)와 이동표로 조립본에서 블록이 차지한 자리를 구한다 */
function blockRegions(resolved: ReadonlyMap<string, ResolvedAnchor>, owners: ReadonlyMap<string, string>, moves: readonly Move[]): Region[] {
  const regions: Region[] = [];
  for (const [anchorId, block] of owners) {
    const r = resolved.get(anchorId);
    let at: { sectionIndex: number; parentPath: number[]; from: number; to: number } | undefined;
    if (r?.kind === "range") at = { sectionIndex: r.section.index, parentPath: r.parentPath, from: r.from, to: r.to };
    else if (r?.kind === "line") {
      const last = r.paragraph.path[r.paragraph.path.length - 1] ?? 0;
      at = { sectionIndex: r.section.index, parentPath: r.paragraph.path.slice(0, -1), from: last, to: last };
    }
    if (at === undefined) continue;
    const { sectionIndex, parentPath, from, to } = at;
    const same = moves.filter((m) => m.sectionIndex === sectionIndex && sameList(m.parentPath, parentPath));
    const own = same.find((m) => m.from === from && m.to === to);
    if (own === undefined || own.count === 0) continue;
    const shift = same.filter((m) => m !== own && m.to < from).reduce((n, m) => n + m.delta, 0);
    const owner = parentPath.length === 0 ? [] : remapAddress(moves, { sectionIndex, path: parentPath.slice(0, -1) })?.path;
    if (owner === undefined) continue;
    const newParent = parentPath.length === 0 ? [] : [...owner, parentPath[parentPath.length - 1] ?? 0];
    regions.push({ block, sectionIndex, parentPath: newParent, from: from + shift, to: from + shift + own.count - 1 });
  }
  return regions;
}

/** 누름틀·메일머지 필드의 표시 구간(문단별). 그 안의 `{{ }}`는 필드 자리가 맡는다 */
function fieldSpans(fields: readonly FieldTarget[]): Map<ParagraphNode, { from: number; until: number }[]> {
  const out = new Map<ParagraphNode, { from: number; until: number }[]>();
  for (const f of fields) {
    if (f.info.type !== "CLICK_HERE" && f.info.type !== "MAILMERGE") continue;
    const paragraphs = new Set<ParagraphNode>([f.paragraph, ...(f.endParagraph === null ? [] : [f.endParagraph])]);
    for (const p of paragraphs) {
      const r = fieldRangeIn(f, p);
      if (r !== undefined) out.set(p, [...(out.get(p) ?? []), r]);
    }
  }
  return out;
}

type Hit = { sectionIndex: number; paragraph: ParagraphNode; start: number; end: number; key: string };

/** 조립본의 느슨한 `{{ 키 }}` 전부(누름틀·메일머지 표시 구간 안의 것은 뺀다, 문서 순서) */
function placeholderHits(doc: HwpxDocument, fields: readonly FieldTarget[]): Hit[] {
  const spans = fieldSpans(fields);
  const hits: Hit[] = [];
  const walk = (sectionIndex: number, list: readonly ParagraphNode[]): void => {
    for (const p of list) {
      const own = spans.get(p) ?? [];
      for (const h of findLooseKeys(p.logicalText)) {
        if (!own.some((s) => h.start < s.until && h.end > s.from)) hits.push({ sectionIndex, paragraph: p, start: h.start, end: h.end, key: h.key });
      }
      for (const sub of p.subLists) walk(sectionIndex, sub.paragraphs);
    }
  };
  for (const s of doc.sections) walk(s.index, s.paragraphs);
  return hits;
}

function sumLedgers(list: readonly Ledger[]): Pick<Ledger, "counts" | "expected" | "actions"> {
  const counts = { actions: 0, skipped: 0, dropped: 0, relocated: 0, stages: 0, edits: 0, additions: 0 };
  const expected: Record<string, number> = {};
  for (const l of list) {
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += l.counts[k];
    for (const [k, v] of Object.entries(l.expected)) expected[k] = (expected[k] ?? 0) + v;
  }
  return { counts, expected, actions: list.flatMap((l) => l.actions) };
}

/** 2판 hwpx 생성 */
function generateStudioHwpx(bytes: Uint8Array, t: StudioTemplate, record: Record<string, unknown>, c: StudioCase | undefined, loadBlob: BlobLoader, opts: StudioGenerateOptions): StudioGenerateResult {
  const dryRun = opts.dryRun === true;
  const report = newReport("hwpx", dryRun);
  const issues = report.issues;
  const failed = (): StudioGenerateResult => finish({ ok: false, report });
  const prep = prepare(bytes, t, record, c, loadBlob, opts, report);
  if (prep === undefined) return failed();
  const origDoc = parseDocument(openPackage(bytes));

  // ── 5. 앵커: 원본 해시가 같으므로 exact·unverified만 쓴다. 그 밖의 상태는 템플릿이 손상된 것이라 그 코드들로 막는다 ──
  report.anchors = checkAnchors(origDoc, t);
  for (const check of report.anchors) {
    if (check.state === "exact") continue;
    if (check.state === "unverified") issues.push(...check.issues);
    else issues.push(...check.issues.map((i) => ({ ...i, severity: "error" as const })));
  }
  if (hasErrors(issues)) return failed();
  const mode: GateMode = opts.mode ?? "baseline";
  const later: GateMode = mode === "strict" ? "strict" : "baseline";
  const common: GenerateOptions = {
    ...(opts.reissueInternalDuplicates === true ? { reissueInternalDuplicates: true } : {}),
    ...(opts.testHooks === undefined ? {} : { testHooks: opts.testHooks }),
  };
  let firstStage = true;
  const modeOptions = (): GenerateOptions => {
    const m = firstStage ? mode : later;
    const out: GenerateOptions = { mode: m };
    if (m === "repair" && opts.repair !== undefined) out.repair = opts.repair;
    firstStage = false;
    return out;
  };
  const ledgers: Ledger[] = [];

  // ── 1단계: 구조(원본 좌표, 빈 데이터 묶음, missing: keep) ───────────────
  const applies = slotApplies(t, prep.selections, c);
  const s1: Template = { schema: TEMPLATE_SCHEMA, anchors: [], rules: [], options: {} };
  const fragments: Record<string, Fragment> = {};
  const owners = new Map<string, string>(); // 슬롯 앵커 id → 블록 id
  for (const { block, content, anchors } of applies) {
    for (const a of anchors) {
      const anchor = engineAnchor(a);
      if (anchor === undefined) continue;
      s1.anchors.push(anchor);
      owners.set(a.id, block.id);
      const id = `${block.id}@${a.id}`;
      if ("fragment" in content) {
        const key = `blob:${content.fragment}`;
        const fragment = prep.fragments.get(content.fragment);
        if (fragment !== undefined) fragments[key] = fragment;
        s1.rules.push({ id, do: { type: "inject", anchor: a.id, position: "replace", fragment: key } });
      } else if (content.text.trim() === "") {
        // 빈 글 블록(공백·탭·줄바꿈뿐): 슬롯 자리를 비운다(insertText의 빈 값은 교체를 건너뛰어 원래 글이 남으므로 지운다)
        s1.rules.push({ id, do: { type: "delete", anchor: a.id } });
      } else {
        s1.rules.push({ id, do: { type: "insertText", anchor: a.id, position: "replace", value: { text: content.text }, style: "inherit" } });
      }
    }
  }
  let assembled = bytes;
  let moves: Move[] = [];
  let inherited = noInherited();
  if (s1.rules.length > 0) {
    const r1 = generate(bytes, s1, EMPTY_DATASET, { ...common, ...modeOptions(), missing: "keep", allowNothingApplied: true, fragments });
    report.stage1 = r1.report;
    issues.push(...r1.report.issues);
    if (!r1.ok || r1.dryRun) return failed();
    assembled = r1.output;
    moves = r1.report.plan.moves;
    inherited = { duplicateIds: r1.report.inherited.duplicateIds, danglingRefs: r1.report.inherited.danglingRefs };
    ledgers.push(r1.ledger);
  }
  report.moves = moves;
  const regions = blockRegions(resolveAnchors(origDoc, s1).anchors, owners, moves);
  const selected = new Set(applies.map((x) => x.block.id));

  // ── 2단계: 값(조립본을 다시 파싱해 자리를 찾는다) ─────────────────────
  const doc2 = assembled === bytes ? origDoc : parseDocument(openPackage(assembled));
  const fields0 = collectFields(origDoc);
  const fields2 = collectFields(doc2);
  const hits = placeholderHits(doc2, fields2);
  const claimed = new Set<Hit>();
  const anchorsById = new Map(t.anchors.map((a) => [a.id, a]));
  const placeAnchors = new Map<string, Anchor>();
  for (const p of t.places) {
    if (p.kind !== "word" && p.kind !== "line" && p.kind !== "cell") continue;
    const a = anchorsById.get(p.anchor);
    const anchor = a === undefined ? undefined : engineAnchor(a);
    if (anchor !== undefined) placeAnchors.set(anchor.id, anchor);
  }
  // 이 앵커들은 5단계에서 exact·unverified로 확인했다(같은 이슈를 두 번 담지 않는다)
  const origResolved = resolveAnchors(origDoc, { schema: TEMPLATE_SCHEMA, anchors: [...placeAnchors.values()], rules: [], options: {} });

  const s2: Template = { schema: TEMPLATE_SCHEMA, anchors: [], rules: [], options: t.options?.mixedFormat === undefined ? {} : { mixedFormat: t.options.mixedFormat } };
  const filledFields = new Set<string>();
  const values = new Map(prep.values.map((v) => [v.id, v]));
  const covered = (p: ValuePlace, what: string): void => {
    report.dropped.push({ place: p.id, kind: p.kind, code: "PLACE_COVERED", message: `자리 ${p.id}(${p.kind})가 가리키는 곳(${what})이 블록 교체 범위 안에 들어 빠졌습니다.` });
  };
  const notFound = (p: ValuePlace, message: string): void => void issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `자리 ${p.id}: ${message}`, p.id));

  /** 필드 자리의 대상: 조립본의 필드(종류·이름 또는 키). occurrence가 있으면 원본의 그 필드를 이동표로 옮겨 찾는다 */
  const fieldTargets = (p: Extract<ValuePlace, { kind: "clickHere" | "mailMerge" }>): FieldTarget[] | undefined => {
    const type = p.kind === "clickHere" ? "CLICK_HERE" : "MAILMERGE";
    const want = nfc(p.kind === "clickHere" ? p.name : p.key);
    const matches = (f: FieldTarget): boolean => f.info.type === type && nfc(p.kind === "clickHere" ? f.info.name : (f.info.mergeKey ?? "")) === want;
    if (p.occurrence === undefined) {
      return fields2.filter((f) => matches(f) && (p.where === undefined || inRegion(regions, p.where, f.section.index, f.paragraph.path)));
    }
    const orig = fields0.find((f) => matches(f) && f.info.occurrence === p.occurrence);
    if (orig === undefined) {
      notFound(p, `${p.kind === "clickHere" ? "이름이" : "키가"} 같은 필드의 순번 ${p.occurrence}이(가) 원본에 없습니다.`);
      return undefined;
    }
    const mapped = remapAddress(moves, { sectionIndex: orig.section.index, path: orig.paragraph.path });
    if (mapped === undefined) {
      covered(p, `순번 ${p.occurrence} 필드`);
      return [];
    }
    const nth = fields0.filter((f) => matches(f) && f.section === orig.section && f.paragraph === orig.paragraph).indexOf(orig);
    const found = fields2.filter((f) => matches(f) && f.section.index === mapped.sectionIndex && sameList(f.paragraph.path, mapped.path))[nth];
    if (found === undefined) {
      notFound(p, `순번 ${p.occurrence} 필드를 조립본에서 다시 찾지 못했습니다.`);
      return undefined;
    }
    return p.where === undefined || inRegion(regions, p.where, found.section.index, found.paragraph.path) ? [found] : [];
  };

  /** word·line·cell 자리: 원본에서 푼 자리를 이동표로 옮긴 조립본의 앵커(덮였으면 null) */
  const movedAnchor = (p: Extract<ValuePlace, { kind: "word" | "line" | "cell" }>, id: string): Anchor | null | undefined => {
    const r = origResolved.anchors.get(p.anchor);
    if (r === undefined) return undefined; // 원본에서 풀지 못함(오류는 이미 담겼다)
    if (r.kind === "word" || r.kind === "line") {
      const mapped = remapAddress(moves, { sectionIndex: r.section.index, path: r.paragraph.path });
      if (mapped === undefined) return null;
      return r.kind === "word"
        ? { id, kind: "word", at: mapped, start: r.start, end: r.end, print: wordPrintAt(r.paragraph.logicalText, r.start, r.end) }
        : { id, kind: "line", at: mapped, print: linePrintOf(r.paragraph.logicalText) };
    }
    if (r.kind !== "cell") return undefined;
    // 표는 최상위 문단에 든 표의 서수로 가리킨다: 표를 담은 문단을 옮기고, 그 문단 안에서 몇 번째 표인지로 조립본의 서수를 정한다(1단계는 행을 바꾸지 않는다)
    const sectionIndex = r.section.index;
    const mapped = remapAddress(moves, { sectionIndex, path: r.owner.path });
    if (mapped === undefined) return null;
    const nth = topLevelObjects(r.section, "tbl").filter((x) => x.paragraph === r.owner).findIndex((x) => x.object === r.table);
    const section2 = doc2.sections[sectionIndex];
    const list = section2 === undefined ? [] : topLevelObjects(section2, "tbl");
    const at = list.filter((x) => sameList(x.paragraph.path, mapped.path))[nth];
    const ordinal = at === undefined ? -1 : list.indexOf(at);
    if (ordinal < 0) {
      notFound(p, "표를 조립본에서 다시 찾지 못했습니다.");
      return undefined;
    }
    return { id, kind: "cell", table: { sectionIndex, ordinal }, row: r.cell.row, col: r.cell.col };
  };

  for (const p of t.places) {
    const targets: Anchor[] = [];
    const fieldKeys: string[] = [];
    if (p.kind === "word" || p.kind === "line" || p.kind === "cell") {
      const a = movedAnchor(p, p.id);
      if (a === null) covered(p, "앵커");
      else if (a !== undefined) targets.push(a);
    } else if (p.kind === "clickHere" || p.kind === "mailMerge") {
      if (p.where !== undefined && !selected.has(p.where)) continue;
      for (const [k, f] of (fieldTargets(p) ?? []).entries()) {
        const id = `${p.id}@${k}`;
        targets.push(p.kind === "clickHere" ? { id, kind: "field", name: f.info.name, occurrence: f.info.occurrence } : { id, kind: "field", mergeKey: f.info.mergeKey ?? "", occurrence: f.info.occurrence });
        fieldKeys.push(fieldKey(f));
      }
    } else if (p.kind === "placeholder") {
      if (p.where !== undefined && !selected.has(p.where)) continue;
      const want = nfc(p.key);
      let k = 0;
      for (const h of hits) {
        if (nfc(h.key) !== want || (p.where !== undefined && !inRegion(regions, p.where, h.sectionIndex, h.paragraph.path))) continue;
        claimed.add(h);
        const id = `${p.id}@${k++}`;
        targets.push({ id, kind: "word", at: { sectionIndex: h.sectionIndex, path: [...h.paragraph.path] }, start: h.start, end: h.end, print: wordPrintAt(h.paragraph.logicalText, h.start, h.end) });
      }
    }
    if (targets.length === 0) continue;
    const v = values.get(p.value);
    const outcome = v === undefined ? undefined : valueFor(v);
    if (outcome === undefined) continue;
    if ("issue" in outcome) {
      if (!issues.some((i) => i.code === outcome.issue.code && i.where === `value:${p.value}`)) issues.push(makeIssue("error", outcome.issue.code, `자리 ${p.id}: ${outcome.issue.message}`, `value:${p.value}`));
      continue;
    }
    if ("keep" in outcome) continue;
    for (const a of targets) {
      s2.anchors.push(a);
      s2.rules.push({ id: a.id, do: { type: "fill", anchor: a.id, value: { text: outcome.text } } });
    }
    for (const key of fieldKeys) filledFields.add(key);
  }
  // 등록되지 않은 `{{ }}`: 어느 placeholder 자리도 맡지 않은 것(누름틀·메일머지 표시 구간 안의 것은 이미 뺐다)
  const unregistered = new Map<string, number>();
  for (const h of hits) if (!claimed.has(h)) unregistered.set(h.key, (unregistered.get(h.key) ?? 0) + 1);
  issues.push(...unregisteredIssues(unregistered, t.options?.unregistered ?? "error"));
  if (hasErrors(issues)) return failed();

  let output = assembled;
  let r2: GenerateResult | undefined;
  if (s2.rules.length > 0 || dryRun) {
    r2 = generate(assembled, s2, EMPTY_DATASET, {
      ...common,
      ...modeOptions(),
      missing: "keep",
      allowNothingApplied: true,
      dryRun,
      ...(opts.mixedFormat === undefined ? {} : { mixedFormat: opts.mixedFormat }),
    });
    report.stage2 = r2.report;
    issues.push(...r2.report.issues);
  }
  // 건너뜀이 1건이라도 있으면 실패(`implicit`은 요청하지 않은 자리의 정보라 세지 않는다. 2판은 암묵 채움을 하지 않는다)
  report.skipped = [...(report.stage1?.plan.skipped ?? []), ...(r2?.report.plan.skipped ?? [])].filter((s) => s.ruleId !== "implicit");
  const skipped = skippedIssue(report.skipped);
  if (skipped !== undefined) issues.push(skipped);
  if (r2 !== undefined) {
    if (!r2.ok || hasErrors(issues)) return failed();
    if (r2.dryRun) return finish({ ok: true, dryRun: true, report });
    output = r2.output;
    ledgers.push(r2.ledger);
  } else if (hasErrors(issues)) return failed();

  // ── 후처리(켠 것만) ──────────────────────────────────────────
  if (t.options?.unwrapFilled === true && filledFields.size > 0) {
    const un = unwrapFields(output, filledFields);
    issues.push(...un.issues);
    if (un.output === undefined) return failed();
    output = un.output;
    report.postprocess.unwrapped = un.count;
  }
  if (t.options?.refreshPreview === true) {
    const pv = refreshPreview(output);
    output = pv.output;
    report.postprocess.preview = pv.refreshed;
  }

  // ── 끝 판정: 원본 대비 누적 기준선(검사기 새 오류 0) ─────────────────
  const origin = mode === "repair" && opts.repair !== undefined ? opts.repair(bytes).output : bytes;
  const before = validateDocument(origin);
  const after = validateDocument(output, { strict: mode === "strict" });
  const cmp = compareToBaseline(before, after);
  const rest = mode === "strict" ? cmp.newErrors : splitTolerated(cmp.newErrors, before.warnings).rest;
  const newErrors = mode === "strict" ? rest : explainInherited(rest, inherited, before.errors).unexplained;
  report.validation = { before: { errors: before.errors.length, warnings: before.warnings.length }, after: { errors: after.errors.length, warnings: after.warnings.length }, newErrors };
  if (mode === "strict" && after.errors.length > 0) issues.push(makeIssue("error", "GATE_ERRORS", `엄격 방식: 결과에 검사 오류가 ${after.errors.length}종 있습니다.`));
  if (mode !== "strict" && newErrors.length > 0) issues.push(makeIssue("error", "GATE_NEW_ERRORS", `원본 대비 새로 생긴 검사 오류가 ${newErrors.length}종 있습니다(${newErrors.map((v) => v.code).join(", ")}).`));
  if (hasErrors(issues)) return failed();

  // ── 원장 ─────────────────────────────────────────────────────
  const first = ledgers[0];
  const sum = sumLedgers(ledgers);
  sum.counts.dropped += report.dropped.length;
  sum.counts.skipped = report.skipped.length; // 단계 원장의 건너뜀에는 요청하지 않은 자리(implicit)의 정보가 섞여 있다
  const ledger: StudioLedger = {
    schema: "hwpx-studio/ledger@1",
    mode,
    input: { sha256: sha256Hex(bytes), bytes: bytes.length },
    source: { sha256: t.source.sha256 },
    template: { id: t.id, version: t.version, sha256: templateSha256(t) },
    // 행 해시: 행 객체의 정규 JSON(8.8.2) sha256
    record: { sha256: sha256Hex(canonicalStudioJson(record)), ...(c === undefined ? {} : { dataset: c.record.dataset, version: c.record.version }) },
    fragments: first?.fragments ?? [],
    output: { sha256: sha256Hex(output), bytes: output.length },
    ...sum,
  };
  if (c !== undefined) ledger.case = { sha256: caseSha256(c) };
  if (first?.repaired !== undefined) ledger.repaired = first.repaired;
  return finish({ ok: true, dryRun: false, output, report, ledger });
}

