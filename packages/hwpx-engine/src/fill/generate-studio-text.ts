import { HwpxError, makeIssue } from "../errors.ts";
import type { StudioCase, StudioTemplate, ValuePlace } from "../template/studio-types.ts";
import { TEMPLATE_SCHEMA, type Anchor, type Template } from "../template/types.ts";
import { resolveTextAnchors, wordPrintAt } from "../text/anchors.ts";
import { scanPlaceholders } from "../text/doc.ts";
import { generateText } from "../text/gate.ts";
import { parseText } from "../text/parse.ts";
import type { TextBlock, TextDoc, TextResult } from "../text/types.ts";
import type { Move } from "./anchor-types.ts";
import { makeMove, remapAddress } from "./moves.ts";
import { placeText } from "../template/value-format.ts";
import {
  EMPTY_DATASET,
  engineAnchor,
  findLooseKeys,
  finish,
  hasErrors,
  newReport,
  nfc,
  prepare,
  skippedIssue,
  slotApplies,
  unitsOf,
  unregisteredIssues,
  valueFor,
  type BlobLoader,
  type StudioGenerateOptions,
  type StudioGenerateResult,
} from "./studio-common.ts";

// 2판 md 템플릿의 생성(엔진 명세 8.8.12의 md 줄): 텍스트 어댑터(9절)로 hwpx와 같은 순서를 따른다.
// 슬롯 앵커는 표식 줄(`line`), 블록은 글이다. 원장과 후처리는 없다(후처리 2종은 hwpx 패키지의 것이다).

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Hit = { block: TextBlock; start: number; end: number; key: string };

/** 블록이 들어간 자리(조립본 블록 번호 범위) */
type Region = { block: string; from: number; to: number };

export function generateStudioText(bytes: Uint8Array, t: StudioTemplate, record: Record<string, unknown>, c: StudioCase | undefined, loadBlob: BlobLoader, opts: StudioGenerateOptions): StudioGenerateResult {
  const dryRun = opts.dryRun === true;
  const report = newReport("md", dryRun);
  const issues = report.issues;
  const failed = (): StudioGenerateResult => finish({ ok: false, report });
  const prep = prepare(bytes, t, record, c, loadBlob, opts, report);
  if (prep === undefined) return failed();
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new HwpxError("TEXT_ENCODING", "md 입력을 UTF-8로 읽을 수 없습니다.");
  }
  const doc0 = parseText(text, "md");

  // ── 1단계: 표식 줄을 고른 블록의 글로 교체(빈 글이면 표식 줄을 지운다) ─────
  const applies = slotApplies(t, prep.selections, c);
  const s1: Template = { schema: TEMPLATE_SCHEMA, anchors: [], rules: [], options: {} };
  const owners = new Map<string, { block: string; rule: string }>();
  for (const { block, content, anchors } of applies) {
    if (!("text" in content)) {
      issues.push(makeIssue("error", "TPL_FIELD", `md 템플릿의 블록 ${block.id}은(는) text 내용만 쓸 수 있습니다.`, `blocks.${block.id}`));
      continue;
    }
    for (const a of anchors) {
      const anchor = engineAnchor(a);
      if (anchor === undefined) continue;
      const id = `${block.id}@${a.id}`;
      s1.anchors.push(anchor);
      owners.set(a.id, { block: block.id, rule: id });
      // md는 빈 줄이 블록 구분이라 글이 공백뿐이면 들어갈 블록이 없다: 표식 줄을 지운다
      if (content.text.trim() === "") s1.rules.push({ id, do: { type: "delete", anchor: a.id } });
      else s1.rules.push({ id, do: { type: "insertText", anchor: a.id, position: "replace", value: { text: content.text }, style: "inherit" } });
    }
  }
  if (hasErrors(issues)) return failed();
  let assembled = text;
  const moves: Move[] = [];
  const regions: Region[] = [];
  if (s1.rules.length > 0) {
    const r1 = generateText(text, "md", s1, EMPTY_DATASET, { missing: "keep" });
    report.stage1 = r1.report;
    issues.push(...r1.report.issues);
    if (!r1.ok || r1.dryRun) return failed();
    assembled = r1.output;
    // 이동표: 표식 줄 하나가 블록 N개로 바뀐다(N은 1단계 보고서의 삽입 블록 수, 지우면 0)
    const resolved = resolveTextAnchors(doc0, s1, new Set(owners.keys()), scanPlaceholders(doc0, false)).anchors;
    const placed: { index: number; block: string; count: number }[] = [];
    for (const [anchorId, owner] of owners) {
      const r = resolved.get(anchorId);
      if (r?.kind !== "line") continue;
      const action = r1.report.plan.actions.find((x) => x.ruleId === owner.rule && x.type === "insertText");
      placed.push({ index: r.block.index, block: owner.block, count: action?.targets ?? 0 });
    }
    placed.sort((a, b) => a.index - b.index);
    let shift = 0;
    for (const x of placed) {
      moves.push(makeMove(0, [], x.index, x.index, x.count));
      if (x.count > 0) regions.push({ block: x.block, from: x.index + shift, to: x.index + shift + x.count - 1 });
      shift += x.count - 1;
    }
  }
  report.moves = moves;
  const selected = new Set(applies.map((x) => x.block.id));

  // ── 2단계: 조립본에서 자리를 찾아 `{text}`로 채운다 ───────────────────
  const doc1: TextDoc = assembled === text ? doc0 : parseText(assembled, "md");
  const hits: Hit[] = [];
  for (const b of doc1.blocks) {
    if (b.kind === "code") continue; // 코드 블록 안의 `{{}}`는 채우지 않는다(9절의 기본)
    for (const h of findLooseKeys(b.text)) hits.push({ block: b, ...h });
  }
  const claimed = new Set<Hit>();
  const anchorsById = new Map(t.anchors.map((a) => [a.id, a]));
  const values = new Map(prep.values.map((v) => [v.id, v]));
  const units = unitsOf(t);
  const tables0 = doc0.blocks.filter((b) => b.kind === "table");
  const tables1 = doc1.blocks.filter((b) => b.kind === "table");
  const s2: Template = { schema: TEMPLATE_SCHEMA, anchors: [], rules: [], options: {} };
  const covered = (p: ValuePlace): void => {
    report.dropped.push({ place: p.id, kind: p.kind, code: "PLACE_COVERED", message: `자리 ${p.id}(${p.kind})가 가리키는 곳(앵커)이 블록 교체 범위 안에 들어 빠졌습니다.` });
  };
  const inRegion = (block: string, index: number): boolean => regions.some((r) => r.block === block && index >= r.from && index <= r.to);

  // 자리마다 채울 앵커와 자리 바로 뒤 글(값의 단위를 뗄지 정한다, 8.8.4). 줄·칸 자리는 뒤 글이 없다
  for (const p of t.places) {
    const targets: { anchor: Anchor; after: string }[] = [];
    if (p.kind === "word" || p.kind === "line" || p.kind === "cell") {
      const a = anchorsById.get(p.anchor);
      const anchor = a === undefined ? undefined : engineAnchor(a);
      if (anchor?.kind === "word" || anchor?.kind === "line") {
        const mapped = remapAddress(moves, anchor.at);
        const after = anchor.kind === "word" ? (doc0.blocks.find((b) => b.index === anchor.at.path[0])?.text.slice(anchor.end) ?? "") : "";
        if (mapped === undefined) covered(p);
        else targets.push({ anchor: { ...anchor, id: p.id, at: mapped }, after });
      } else if (anchor?.kind === "cell") {
        const table = tables0[anchor.table.ordinal];
        const mapped = table === undefined ? undefined : remapAddress(moves, { sectionIndex: 0, path: [table.index] });
        if (table === undefined) issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `자리 ${p.id}: ${anchor.table.ordinal}번째 표가 원본에 없습니다.`, p.id));
        else if (mapped === undefined) covered(p);
        else targets.push({ anchor: { ...anchor, id: p.id, table: { sectionIndex: 0, ordinal: tables1.findIndex((b) => b.index === mapped.path[0]) } }, after: "" });
      }
    } else if (p.kind === "placeholder") {
      if (p.where !== undefined && !selected.has(p.where)) continue;
      const want = nfc(p.key);
      let k = 0;
      for (const h of hits) {
        if (nfc(h.key) !== want || (p.where !== undefined && !inRegion(p.where, h.block.index))) continue;
        claimed.add(h);
        const id = `${p.id}@${k++}`;
        targets.push({ anchor: { id, kind: "word", at: { sectionIndex: 0, path: [h.block.index] }, start: h.start, end: h.end, print: wordPrintAt(h.block.text, h.start, h.end) }, after: h.block.text.slice(h.end) });
      }
    }
    // clickHere·mailMerge는 md에 없다(읽기가 TPL_ANCHOR로 막는다)
    if (targets.length === 0) continue;
    const v = values.get(p.value);
    const outcome = v === undefined ? undefined : valueFor(v);
    if (outcome === undefined || "keep" in outcome) continue;
    if ("issue" in outcome) {
      if (!issues.some((i) => i.code === outcome.issue.code && i.where === `value:${p.value}`)) issues.push(makeIssue("error", outcome.issue.code, `자리 ${p.id}: ${outcome.issue.message}`, `value:${p.value}`));
      continue;
    }
    for (const { anchor: a, after } of targets) {
      s2.anchors.push(a);
      s2.rules.push({ id: a.id, do: { type: "fill", anchor: a.id, value: { text: placeText(outcome.text, units.get(p.value), after) } } });
    }
  }
  const unregistered = new Map<string, number>();
  for (const h of hits) if (!claimed.has(h)) unregistered.set(h.key, (unregistered.get(h.key) ?? 0) + 1);
  issues.push(...unregisteredIssues(unregistered, t.options?.unregistered ?? "error"));
  if (hasErrors(issues)) return failed();

  let output = assembled;
  let r2: TextResult | undefined;
  if (s2.rules.length > 0 || dryRun) {
    r2 = generateText(assembled, "md", s2, EMPTY_DATASET, { missing: "keep", dryRun });
    report.stage2 = r2.report;
    issues.push(...r2.report.issues);
  }
  report.skipped = [...(report.stage1?.plan.skipped ?? []), ...(r2?.report.plan.skipped ?? [])].filter((s) => s.ruleId !== "implicit");
  const skipped = skippedIssue(report.skipped);
  if (skipped !== undefined) issues.push(skipped);
  if (r2 !== undefined) {
    if (!r2.ok || hasErrors(issues)) return failed();
    if (r2.dryRun) return finish({ ok: true, dryRun: true, report });
    output = r2.output;
  } else if (hasErrors(issues)) return failed();
  return finish({ ok: true, dryRun: false, output, report });
}
