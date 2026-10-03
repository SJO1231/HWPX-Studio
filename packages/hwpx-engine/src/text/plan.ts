import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import {
  digestValue,
  emptyFillReport,
  findPlaceholders,
  lookupPath,
  resolvePathValue,
  resolveValue,
  rowDataset,
  selectRules,
  type Dataset,
  type FillReport,
  type MissingPolicy,
  type Template,
  type ValueDigest,
} from "../template/index.ts";
import { fieldHitsOf, resolveTextAnchors } from "./anchors.ts";
import { censusOf, escapeCell, eolNear, scanPlaceholders, separatorNear } from "./doc.ts";
import { parseText, splitRow } from "./parse.ts";
import { TEXT_FRAGMENT_SCHEMA, type TextBlockKind, type TextTableCell, type TextBlock, type TextCensus, type TextDoc, type TextEdit, type TextOptions, type TextPlan, type TextRepeat } from "./types.ts";

type Who = { ruleId: string; anchor: string };
/** `rank`: 같은 자리의 편집 순서(앞 삽입 0 < 채움·교체·삭제 1 < 뒤 삽입 2). 빈 줄 하나를 사이에 둔 앞·뒤 삽입이 교체와 뒤섞이지 않게 한다. */
type Tagged = TextEdit & { seq: number; rank: number; block?: number };
/** 문서에 새로 들어가는 블록 하나(원문과 그 종류·표 행 수) */
type Inserted = { text: string; kind: TextBlockKind; rows: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SPLIT_LINES = /\r\n|\r|\n/;

/**
 * 규칙의 `fragment`를 읽는다: 조각 경로(`fragments` 옵션에서 찾는다. 엔진은 파일을 읽지 않는다), 조각 객체, 또는 조각 JSON 글.
 * 틀리면 `TPL_FRAGMENT_MISSING`·`FRAG_SCHEMA`를 던진다. 조각 블록 글 목록을 돌려준다.
 */
export function loadTextFragment(spec: string | Record<string, unknown>, fragments: TextOptions["fragments"]): string[] {
  let raw: unknown = spec;
  if (typeof spec === "string") {
    const given = fragments?.[spec] ?? (spec.trimStart().startsWith("{") ? spec : undefined);
    if (given === undefined) throw new HwpxError("TPL_FRAGMENT_MISSING", `조각 '${spec}'을(를) 받지 못했습니다(fragments 옵션에 넣어야 합니다).`);
    raw = given;
    if (typeof given === "string") {
      try {
        raw = JSON.parse(given);
      } catch {
        throw new HwpxError("FRAG_SCHEMA", "텍스트 조각을 JSON으로 읽을 수 없습니다.");
      }
    }
  }
  if (!isObj(raw) || raw["schema"] !== TEXT_FRAGMENT_SCHEMA) throw new HwpxError("FRAG_SCHEMA", `텍스트 조각의 schema가 ${TEXT_FRAGMENT_SCHEMA}가 아닙니다.`);
  const blocks = raw["blocks"];
  if (!Array.isArray(blocks) || blocks.length === 0 || !blocks.every((x) => typeof x === "string")) {
    throw new HwpxError("FRAG_SCHEMA", "텍스트 조각의 blocks는 비어 있지 않은 문자열 배열이어야 합니다.");
  }
  return blocks as string[];
}

/** 표 칸 하나에 값을 넣는 편집. 글이 있는 칸은 그 글만, 빈 칸은 앞뒤 공백을 두고 넣는다. 빈 칸에 빈 값이면 편집이 없다. */
function cellEdit(cell: TextTableCell, text: string): { start: number; end: number; replacement: string } | undefined {
  const value = escapeCell(text);
  if (cell.contentStart < cell.contentEnd) return { start: cell.contentStart, end: cell.contentEnd, replacement: value };
  return value === "" ? undefined : { start: cell.start, end: cell.end, replacement: ` ${value} ` };
}

const group = <K, V>(map: Map<K, V[]>, key: K, value: V): void => void map.set(key, [...(map.get(key) ?? []), value]);

/** 정렬된 서수들을 이어진 구간 `[처음, 끝]`으로 묶는다. */
function runsOf(sorted: number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[1] + 1 === n) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

/**
 * 규칙을 평가하고 앵커를 풀어 편집 계획과 보고서를 만든다. 문서를 바꾸지 않는다.
 *
 * 1. 규칙을 순서대로 평가해 참인 것만 남긴다(`src/template`). `tableProps`·`resize`는 텍스트 문서에 표 설정·크기가 없어 앵커를 풀지 않고
 *    `report.skipped`에 `TEXT_NOT_APPLICABLE`로 남긴다(오류가 아니다). `inject`의 `fitTable`은 읽되 쓰지 않는다(조각 주입은 그대로 한다).
 * 2. 삭제·교체되는 블록 안의 채움·삽입은 버리고 `report.dropped`에 적는다. 같은 자리를 다르게 바꾸는 편집이 둘이면 `TPL_CONFLICT`.
 *    `repeat`는 md 표의 원형 행(앵커 칸이 든 줄)을 배열 원소 수만큼 복제한다. 0개면 원형 행 삭제와 같고, 머리행은 `FILL_TABLE_HEADER`로 거절한다.
 * 3. 문서 안 `{{경로}}`는 템플릿 없이도 채운다. 코드 블록 안의 것은 `fillInCode`일 때만, `field` 앵커가 가리키는 것은 그 규칙이 맡는다.
 * 4. 보고서: 적용할 액션, 건너뛴 자리와 사유, 필요한 데이터 경로, 다시 찾은 앵커, 예상 수량 증감.
 *
 * 보고서에 오류(`severity: "error"`)가 있으면 계획은 쓰지 않는다.
 */
export function buildTextPlan(doc: TextDoc, template: Template, dataset: Dataset, options: TextOptions = {}): { plan: TextPlan; report: FillReport } {
  const policy: MissingPolicy = options.missing ?? template.options.missing ?? "error";
  const fillInCode = options.fillInCode === true;
  const report = emptyFillReport();
  const issues = report.issues;
  const required = new Set<string>();
  const missingPaths = new Set<string>();
  const keptPaths = new Map<string, number>();
  const reportedErrors = new Set<string>();
  const leaves: number[] = [];
  const delta: TextCensus = { blocks: 0, tables: 0, code: 0, tableRows: 0 };
  const tagged: Tagged[] = [];
  const push = (start: number, end: number, replacement: string, label: string, rank = 1, block?: number): void => {
    const edit: Tagged = { start, end, replacement, label, seq: tagged.length, rank };
    if (block !== undefined) edit.block = block;
    tagged.push(edit);
  };
  /**
   * 채운 뒤 블록 수가 바뀔 수 있는 블록이면 그 서수(채움 편집에 달아 둔다): md 문단·제목(글이 통째로 비거나 한 줄이 비면 블록이 없어지거나 나뉜다),
   * txt 줄(줄바꿈 없는 마지막 줄이 비면 줄이 없어진다).
   */
  const proseBlock = (b: TextBlock): number | undefined => (doc.kind === "txt" || b.kind === "paragraph" || b.kind === "heading" ? b.index : undefined);
  /** 블록 안의 채움 편집을 적용한 블록 글 */
  const filledText = (block: TextBlock, list: Tagged[]): string => {
    let text = "";
    let pos = block.start;
    for (const t of [...list].sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (t.start < pos) continue;
      text += doc.source.slice(pos, t.start) + t.replacement;
      pos = t.end;
    }
    return text + doc.source.slice(pos, block.end);
  };
  const count = (b: { kind: TextBlockKind; rows: number }, sign: 1 | -1): void => {
    delta.blocks += sign;
    if (b.kind === "table") {
      delta.tables += sign;
      delta.tableRows += sign * b.rows;
    } else if (b.kind === "code") {
      delta.code += sign;
    }
  };
  const infoOf = (b: TextBlock): { kind: TextBlockKind; rows: number } => ({ kind: b.kind, rows: b.table?.rows.length ?? 0 });
  const bump = (m: Map<string, number>, key: string): void => void m.set(key, (m.get(key) ?? 0) + 1);

  const labelOf = (id: string): string => (id.startsWith("{{") ? id : `규칙 ${id}`);
  const issueFor = (code: string, message: string, id: string): Issue => makeIssue("error", code, `${labelOf(id)}: ${message}`, id);
  const valueError = (ruleId: string, code: string, message: string, path: string | undefined): void => {
    if (code === "DATA_MISSING" && path !== undefined) missingPaths.add(path);
    const key = `${code}\u0000${path ?? ruleId}`;
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    issues.push(issueFor(code, message, ruleId));
  };

  // ── 1. 규칙과 앵커 ──────────────────────────────────────────
  const { active, inactive } = selectRules(template, dataset);
  report.inactiveRules = inactive.map((r) => r.id);
  const hits = scanPlaceholders(doc, fillInCode);
  // 텍스트 문서에는 표의 설정·크기가 없다. 같은 템플릿을 hwpx와 md에 함께 쓸 수 있게 오류가 아니라 건너뜀으로 남기고, 그 규칙만 가리키는 앵커는 풀지 않는다.
  const notApplicable = new Set<string>();
  for (const rule of active) {
    const action = rule.do;
    if (action.type !== "tableProps" && action.type !== "resize") continue;
    notApplicable.add(rule.id);
    report.skipped.push({ ruleId: rule.id, anchor: action.anchor, code: "TEXT_NOT_APPLICABLE", message: `텍스트 문서에는 표의 설정·크기가 없어 ${action.type} 규칙을 적용하지 않았습니다.` });
  }
  const resolution = resolveTextAnchors(doc, template, new Set(active.filter((r) => !notApplicable.has(r.id)).map((r) => r.do.anchor)), hits);
  issues.push(...resolution.issues);
  for (const i of resolution.issues) if (i.code === "ANCHOR_RELOCATED") report.relocated.push({ anchor: i.where ?? "", message: i.message });
  const anchorOf = (id: string) => resolution.anchors.get(id);

  // 조건이 거짓인 repeat: 원형 행은 그대로 두고 그 안의 원소·순번 자리(`{{item.이름}}`·`{{순번}}`)는 채우지 않는다(`REPEAT_INACTIVE`).
  // 이 용도로만 앵커를 풀기 때문에 풀지 못해도 오류를 내지 않는다.
  type IdleRow = { ruleId: string; anchor: string; lineIndex: number; as: string; index: string | undefined; count: number };
  const idleRows: IdleRow[] = [];
  const idleAnchors = new Set(inactive.filter((r) => r.do.type === "repeat").map((r) => r.do.anchor));
  if (idleAnchors.size > 0) {
    const idle = resolveTextAnchors(doc, template, idleAnchors, hits);
    for (const rule of inactive) {
      const action = rule.do;
      if (action.type !== "repeat") continue;
      const found = idle.anchors.get(action.anchor);
      const lineIndex = found?.kind === "cell" ? found.block.table?.rows[found.row]?.line : undefined;
      if (lineIndex !== undefined) idleRows.push({ ruleId: rule.id, anchor: action.anchor, lineIndex, as: action.as ?? "item", index: action.index, count: 0 });
    }
  }

  // ── 2a. 삭제 후보(블록·표 행)와 교체 ─────────────────────────
  const blockDeletes = new Map<number, Who[]>();
  const rowDeletes = new Map<number, Map<number, Who[]>>();
  for (const rule of active) {
    const action = rule.do;
    if (action.type !== "delete") continue;
    const anchor = anchorOf(action.anchor);
    if (anchor === undefined) continue;
    const who = { ruleId: rule.id, anchor: action.anchor };
    if (anchor.kind === "line" || anchor.kind === "object") {
      group(blockDeletes, anchor.block.index, who);
    } else if (anchor.kind === "cell") {
      if (anchor.row === 0) {
        issues.push(issueFor("FILL_TABLE_HEADER", "표의 머리행은 지울 수 없습니다.", rule.id));
        continue;
      }
      const rows = rowDeletes.get(anchor.block.index) ?? new Map<number, Who[]>();
      group(rows, anchor.row, who);
      rowDeletes.set(anchor.block.index, rows);
    }
  }

  const replaced = new Map<number, string>();
  const clashed = new Set<string>();
  for (const rule of active) {
    const action = rule.do;
    if ((action.type !== "inject" && action.type !== "insertText") || action.position !== "replace") continue;
    const anchor = anchorOf(action.anchor);
    if (anchor === undefined || anchor.kind !== "line" || blockDeletes.has(anchor.block.index)) continue;
    const clash = replaced.get(anchor.block.index);
    if (clash !== undefined) {
      issues.push(issueFor("TPL_CONFLICT", `규칙 ${clash}와 같은 블록을 교체합니다.`, rule.id));
      clashed.add(rule.id);
    } else {
      replaced.set(anchor.block.index, rule.id);
    }
  }

  // ── 2a'. 행 반복(repeat) 선처리 ──────────────────────────────
  // 데이터 배열을 읽는다. 0개면 원형 행 삭제 요청으로 넘기고(삭제 규칙을 따른다), 1개 이상이면 아래 2d에서 복제한다.
  type RepeatPlan = { ruleId: string; anchor: string; lineIndex: number; items: unknown[]; as: string; index: string | undefined };
  const repeatPlans: RepeatPlan[] = [];
  const repeatRuleIds = new Set<string>();
  /** 반복 규칙이 맡는 원형 행의 줄 번호(규칙이 실패해도): 그 줄 안의 `{{}}`는 문서 안 `{{경로}}` 채움에서 뺀다 */
  const repeatLines = new Set<number>();
  /** 블록 서수 → 1개 이상으로 반복하는 행 번호 */
  const repeating = new Map<number, Set<number>>();
  const repeatClaimed = new Map<number, string>();
  for (const rule of active) {
    const action = rule.do;
    if (action.type !== "repeat") continue;
    const anchor = anchorOf(action.anchor);
    if (anchor === undefined || anchor.kind !== "cell") continue;
    const lineIndex = anchor.block.table?.rows[anchor.row]?.line;
    const line = lineIndex === undefined ? undefined : doc.lines[lineIndex];
    if (lineIndex === undefined || line === undefined) continue;
    repeatLines.add(lineIndex);
    if (anchor.row === 0) {
      issues.push(issueFor("FILL_TABLE_HEADER", "표의 머리행은 반복할 수 없습니다.", rule.id));
      continue;
    }
    if (blockDeletes.has(anchor.block.index) || replaced.has(anchor.block.index)) {
      report.dropped.push({ ruleId: rule.id, anchor: action.anchor, reason: "삭제·교체되는 블록 안이라 버렸습니다." });
      continue;
    }
    const clash = repeatClaimed.get(lineIndex);
    if (clash !== undefined) {
      issues.push(issueFor("TPL_CONFLICT", `규칙 ${clash}와 같은 원형 행을 반복합니다.`, rule.id));
      continue;
    }
    repeatClaimed.set(lineIndex, rule.id);
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
        bump(keptPaths, path);
        // 행을 그대로 두므로 그 안의 `{{}}`도 남긴다(출력 검사가 남은 `{{}}`로 세지 않게)
        for (const p of findPlaceholders(doc.source.slice(line.start, line.end))) leaves.push(line.start + p.start);
        continue;
      }
      items = [];
    } else if (!Array.isArray(found.value)) {
      issues.push(issueFor("DATA_NOT_ARRAY", `데이터의 ${path}는 배열이 아닙니다.`, rule.id));
      continue;
    } else {
      items = found.value;
    }
    repeatRuleIds.add(rule.id);
    const who = { ruleId: rule.id, anchor: action.anchor };
    if (items.length === 0) {
      const rows = rowDeletes.get(anchor.block.index) ?? new Map<number, Who[]>();
      group(rows, anchor.row, who);
      rowDeletes.set(anchor.block.index, rows);
      continue;
    }
    repeatPlans.push({ ruleId: rule.id, anchor: action.anchor, lineIndex, items, as: action.as ?? "item", index: action.index });
    const rows = repeating.get(anchor.block.index) ?? new Set<number>();
    rows.add(anchor.row);
    repeating.set(anchor.block.index, rows);
  }
  // 반복해서 바뀌는 원형 행을 지우라는 다른 규칙은 버린다(원형 행은 통째로 바뀐다)
  for (const [blockIndex, rows] of rowDeletes) {
    for (const [row, whos] of rows) {
      if (repeating.get(blockIndex)?.has(row) !== true) continue;
      for (const w of whos) report.dropped.push({ ruleId: w.ruleId, anchor: w.anchor, reason: "반복하는 원형 행을 지우는 규칙이라 버렸습니다." });
      rows.delete(row);
    }
  }

  // 삭제·교체되는 블록 안의 표 행 삭제는 버린다
  const deletedRows = new Map<number, number[]>();
  for (const [blockIndex, rows] of rowDeletes) {
    if (blockDeletes.has(blockIndex) || replaced.has(blockIndex)) {
      for (const who of [...rows.values()].flat()) report.dropped.push({ ruleId: who.ruleId, anchor: who.anchor, reason: "삭제·교체되는 블록 안이라 버렸습니다." });
    } else {
      deletedRows.set(blockIndex, [...rows.keys()].sort((a, b) => a - b));
    }
  }

  const inDeletedRow = (b: TextBlock, pos: number): boolean => {
    for (const r of deletedRows.get(b.index) ?? []) {
      const line = doc.lines[b.table?.rows[r]?.line ?? -1];
      if (line !== undefined && line.start <= pos && pos <= line.end) return true;
    }
    return false;
  };
  /** 이 자리가 반복할 원형 행 안인가(그 안의 `{{}}`는 반복 규칙이 채운다) */
  const inRepeatRow = (pos: number): boolean => {
    for (const i of repeatLines) {
      const line = doc.lines[i];
      if (line !== undefined && line.start <= pos && pos <= line.end) return true;
    }
    return false;
  };
  /** 이 자리가 삭제·교체되는 범위 안인가 */
  const isGone = (b: TextBlock, pos: number): boolean => blockDeletes.has(b.index) || replaced.has(b.index) || inDeletedRow(b, pos) || inRepeatRow(pos);
  const valueFor = (b: TextBlock, text: string): string => (b.kind === "table" ? escapeCell(text) : text);

  const explicit: FillReport["actions"] = [];

  // ── 2b. 채움 ────────────────────────────────────────────────
  for (const rule of active) {
    const action = rule.do;
    if (action.type !== "fill") continue;
    const anchor = anchorOf(action.anchor);
    if (anchor === undefined) continue;
    const label = `규칙 ${rule.id}: 채움`;
    const value = resolveValue(dataset, action.value, policy, "none");
    if ("path" in action.value) required.add(action.value.path);
    if (value.kind === "error") {
      valueError(rule.id, value.code, value.message, value.path ?? ("path" in action.value ? action.value.path : undefined));
      continue;
    }
    if (value.kind === "keep") {
      bump(keptPaths, value.path);
      missingPaths.add(value.path);
      if (anchor.kind === "field") for (const h of anchor.hits) leaves.push(h.start);
      continue;
    }
    if (value.kind === "empty") missingPaths.add(value.path);
    const text = value.kind === "text" ? value.text : "";
    let targets = 0;
    let droppedCount = 0;
    const dropped = (b: TextBlock, pos: number): boolean => {
      if (!isGone(b, pos)) return false;
      droppedCount++;
      return true;
    };

    if (anchor.kind === "field") {
      for (const h of anchor.hits) {
        if (dropped(h.block, h.start)) continue;
        push(h.start, h.end, valueFor(h.block, text), label, 1, proseBlock(h.block));
        targets++;
      }
    } else if (anchor.kind === "word") {
      const { block } = anchor;
      if (!dropped(block, anchor.start)) {
        const cells = block.table?.rows.flatMap((r) => r.cells) ?? [];
        if (block.kind === "table" && !cells.some((c) => c.start <= anchor.start && anchor.end <= c.end)) {
          report.skipped.push({ ruleId: rule.id, anchor: action.anchor, code: "FILL_CROSSES_MARKUP", message: "범위가 표의 칸 경계(`|`)나 줄을 가로질러 치환하지 않았습니다." });
        } else {
          push(anchor.start, anchor.end, valueFor(block, text), label, 1, proseBlock(block));
          targets++;
        }
      }
    } else if (anchor.kind === "line") {
      const { block } = anchor;
      if (!dropped(block, block.start)) {
        if (block.kind === "code" || block.kind === "table") {
          issues.push(issueFor("FILL_HAS_OBJECT", "코드 블록·표는 블록 글을 값으로 바꿀 수 없습니다(word·cell 앵커를 쓰십시오).", rule.id));
        } else {
          push(block.start, block.end, text, label, 1, proseBlock(block));
          targets++;
        }
      }
    } else if (anchor.kind === "cell") {
      if (!dropped(anchor.block, anchor.cell.start)) {
        const edit = cellEdit(anchor.cell, text);
        if (edit !== undefined) push(edit.start, edit.end, edit.replacement, label);
        targets++;
      }
    }
    if (droppedCount > 0) report.dropped.push({ ruleId: rule.id, anchor: action.anchor, reason: `삭제·교체되는 범위 안의 자리 ${droppedCount}곳을 버렸습니다.` });
    if (targets > 0) explicit.push({ ruleId: rule.id, type: "fill", anchor: action.anchor, targets, value: digestValue(text) });
  }

  // ── 2c. 조각 주입·텍스트 삽입 ───────────────────────────────

  /** 블록 밖에서 만든 글(조각 블록) 안의 `{{경로}}`를 같은 데이터로 채운다. 채우는 규칙은 본문과 같다. */
  const fillStandalone = (text: string, kind: TextBlockKind, ruleId: string): string => {
    if (kind === "code" && !fillInCode) return text;
    let out = "";
    let pos = 0;
    for (const h of findPlaceholders(text)) {
      required.add(h.path);
      const value = resolvePathValue(dataset, h.path, policy, "none");
      if (value.kind === "error") {
        valueError(ruleId, value.code, `조각 안 {{${h.path}}}: ${value.message}`, h.path);
        continue;
      }
      if (value.kind === "keep") {
        bump(keptPaths, h.path);
        missingPaths.add(h.path);
        continue;
      }
      if (value.kind === "empty") missingPaths.add(h.path);
      const filled = value.kind === "text" ? value.text : "";
      out += text.slice(pos, h.start) + (kind === "table" ? escapeCell(filled) : filled);
      pos = h.end;
    }
    return out + text.slice(pos);
  };
  const plainBlock = (text: string): Inserted => ({ text, kind: text.trim() === "" ? "blank" : "paragraph", rows: 0 });
  const mdBlock = (text: string): Inserted | undefined => {
    const parsed = parseText(text, "md").blocks;
    const block = parsed[0];
    return parsed.length === 1 && block !== undefined ? { text: block.text, kind: block.kind, rows: block.table?.rows.length ?? 0 } : undefined;
  };

  for (const rule of active) {
    const action = rule.do;
    if ((action.type !== "inject" && action.type !== "insertText") || clashed.has(rule.id)) continue;
    const anchor = anchorOf(action.anchor);
    if (anchor === undefined || anchor.kind !== "line") continue;
    const block = anchor.block;
    if (blockDeletes.has(block.index)) {
      report.dropped.push({ ruleId: rule.id, anchor: action.anchor, reason: "앵커 블록이 삭제되는 범위 안이라 버렸습니다." });
      continue;
    }
    const eol = eolNear(doc, block.lastLine);
    const inserted: Inserted[] = [];
    let digest: ValueDigest | undefined;

    if (action.type === "insertText") {
      const value = resolveValue(dataset, action.value, policy, "paragraphs");
      if ("path" in action.value) required.add(action.value.path);
      if (value.kind === "error") {
        valueError(rule.id, value.code, value.message, value.path ?? ("path" in action.value ? action.value.path : undefined));
        continue;
      }
      if (value.kind === "keep") {
        bump(keptPaths, value.path);
        missingPaths.add(value.path);
        continue;
      }
      if (value.kind === "empty") missingPaths.add(value.path);
      const text = value.kind === "text" ? value.text : "";
      if (text === "") continue;
      digest = digestValue(text);
      // 값의 줄바꿈: txt는 줄마다 한 줄, md는 줄마다 한 문단 블록(빈 줄은 문단 구분이라 건너뛴다)
      const lines = text.split(SPLIT_LINES).filter((l) => doc.kind === "txt" || l.trim() !== "");
      for (const line of lines) {
        const one = doc.kind === "txt" ? plainBlock(line) : mdBlock(line);
        if (one !== undefined) inserted.push(one);
      }
      if (inserted.length === 0) continue;
    } else {
      let fragmentBlocks: string[];
      try {
        fragmentBlocks = loadTextFragment(action.fragment, options.fragments);
      } catch (e) {
        if (!(e instanceof HwpxError)) throw e;
        issues.push(issueFor(e.code, e.message, rule.id));
        continue;
      }
      let failed = false;
      for (const [i, raw] of fragmentBlocks.entries()) {
        try {
          if (doc.kind === "txt") {
            const lines = raw.split(SPLIT_LINES);
            if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
            for (const line of lines) inserted.push(plainBlock(fillStandalone(line, "paragraph", rule.id)));
          } else {
            const parsed = mdBlock(raw);
            const filled = parsed === undefined ? undefined : mdBlock(fillStandalone(parsed.text, parsed.kind, rule.id));
            if (filled === undefined) throw new HwpxError("FRAG_SCHEMA", `조각 블록 ${i}이(가) 한 블록이 아닙니다(빈 줄 없는 한 덩어리, 코드 블록·표는 통째로 써야 합니다).`);
            inserted.push({ ...filled, text: filled.text.replace(/\n/g, eol) });
          }
        } catch (e) {
          if (!(e instanceof HwpxError)) throw e;
          issues.push(issueFor(e.code, e.message, rule.id));
          failed = true;
          break;
        }
      }
      if (failed) continue;
    }

    const texts = inserted.map((b) => b.text);
    const sep = separatorNear(doc, block.index);
    const label = `규칙 ${rule.id}: ${action.type === "inject" ? "조각 주입" : "텍스트 삽입"}`;
    // md에서 코드 블록 바로 뒤에 빈 줄 없이 붙은 블록이 있으면(닫는 울타리 뒤 줄바꿈 하나), 새 블록과 그 뒤 블록이 한 덩어리가 되지 않게 줄바꿈을 하나 더한다
    const next = doc.blocks[block.index + 1];
    const weak = doc.kind === "md" && next !== undefined && (doc.source.slice(block.end, next.start).match(/\r\n|\n/g)?.length ?? 0) < 2;
    const tail = weak ? eol : "";
    if (action.position === "before") {
      push(block.start, block.start, texts.join(sep) + sep, label, 0);
    } else if (action.position === "after") {
      push(block.end, block.end, sep + texts.join(sep) + tail, label, 2);
    } else {
      push(block.start, block.end, texts.join(sep) + tail, label);
      count(infoOf(block), -1);
    }
    for (const b of inserted) count(b, 1);
    const entry: FillReport["actions"][number] = { ruleId: rule.id, type: action.type, anchor: action.anchor, targets: inserted.length, position: action.position };
    if (digest !== undefined) entry.value = digest;
    explicit.push(entry);
  }

  // ── 2d. 행 반복 ─────────────────────────────────────────────
  // 원형 행 줄을 원소마다 한 줄씩 채운 복사본으로 바꾼다. 값은 표 칸 규칙(`|` 이스케이프, 줄바꿈 거부)을 따르고, 행 안의 `{{}}`는 hwpx 표와 같은 규칙으로 채운다:
  // 원소는 `as` 이름(기본 `item`), 순번은 `index` 이름(1부터), 그 밖의 경로는 전체 데이터에서 읽는다.
  const repeats: TextRepeat[] = [];
  for (const rp of repeatPlans) {
    const line = doc.lines[rp.lineIndex];
    if (line === undefined) continue;
    const rowText = doc.source.slice(line.start, line.end);
    const eol = line.eol !== "" ? line.eol : eolNear(doc, rp.lineIndex);
    const isAlias = (p: string): boolean => p === rp.as || p.startsWith(`${rp.as}.`) || p === rp.index;
    const slots = findPlaceholders(rowText);
    const copies: string[] = [];
    for (let i = 0; i < rp.items.length; i++) {
      const scope = rowDataset(dataset, rp.items, i, rp.as, rp.index);
      let out = "";
      let pos = 0;
      for (const h of slots) {
        const value = resolvePathValue(scope, h.path, policy, "none");
        if (value.kind === "error") {
          valueError(rp.ruleId, value.code, `행 반복 {{${h.path}}}: ${value.message}`, h.path);
          continue;
        }
        if (value.kind === "keep") {
          bump(keptPaths, h.path);
          missingPaths.add(h.path);
          continue;
        }
        if (value.kind === "empty") missingPaths.add(h.path);
        if (!isAlias(h.path)) required.add(h.path);
        out += rowText.slice(pos, h.start) + escapeCell(value.kind === "text" ? value.text : "");
        pos = h.end;
      }
      copies.push(out + rowText.slice(pos));
    }
    push(line.start, line.end, copies.join(eol), `규칙 ${rp.ruleId}: 행 반복`);
    delta.tableRows += rp.items.length - 1;
    repeats.push({ start: line.start, rows: copies.map((c) => splitRow(c, 0, c.length).cells.map((x) => c.slice(x.contentStart, x.contentEnd))) });
    explicit.push({ ruleId: rp.ruleId, type: "repeat", anchor: rp.anchor, targets: rp.items.length });
  }

  // ── 3. 문서 안 `{{경로}}` ───────────────────────────────────
  // `field` 앵커가 가리키는 자리는 그 규칙이 맡는다(규칙이 거짓이면 그대로 둔다). 나머지는 경로를 데이터에서 찾아 채운다.
  const referenced = new Set(template.rules.map((r) => r.do.anchor));
  const activeIds = new Set(active.map((r) => r.do.anchor));
  const claimed = new Set<number>();
  for (const a of template.anchors) {
    if (a.kind !== "field" || !referenced.has(a.id)) continue;
    for (const h of fieldHitsOf(hits, a)) {
      claimed.add(h.start);
      if (!activeIds.has(a.id)) leaves.push(h.start);
    }
  }
  const implicit = new Map<string, { count: number; value: ValueDigest }>();
  const implicitDropped = new Map<string, number>();
  for (const h of hits) {
    if (claimed.has(h.start)) continue;
    if (inRepeatRow(h.start)) continue; // 반복 규칙이 채운다(원소 이름 `{{item.이름}}`은 전체 데이터에 없다)
    if (isGone(h.block, h.start)) {
      bump(implicitDropped, h.path);
      continue;
    }
    const idle = idleRows.find((x) => {
      const line = doc.lines[x.lineIndex];
      return line !== undefined && line.start <= h.start && h.start <= line.end && (h.path === x.as || h.path.startsWith(`${x.as}.`) || h.path === x.index);
    });
    if (idle !== undefined) {
      idle.count++;
      leaves.push(h.start); // 채우지 않고 그대로 두므로 남은 `{{}}` 검사에서 뺀다
      continue;
    }
    const value = resolvePathValue(dataset, h.path, policy, "none");
    if (value.kind === "error") {
      valueError(`{{${h.path}}}`, value.code, value.message, h.path);
      continue;
    }
    if (value.kind === "keep") {
      bump(keptPaths, h.path);
      missingPaths.add(h.path);
      leaves.push(h.start);
      continue;
    }
    if (value.kind === "empty") missingPaths.add(h.path);
    const text = value.kind === "text" ? value.text : "";
    required.add(h.path);
    push(h.start, h.end, valueFor(h.block, text), `{{${h.path}}} 채움`, 1, proseBlock(h.block));
    implicit.set(h.path, { count: (implicit.get(h.path)?.count ?? 0) + 1, value: digestValue(text) });
  }
  for (const row of idleRows) {
    if (row.count === 0) continue;
    report.skipped.push({ ruleId: row.ruleId, anchor: row.anchor, code: "REPEAT_INACTIVE", message: `조건이 거짓이라 행을 반복하지 않아 원형 행 안의 원소·순번 자리 ${row.count}곳을 채우지 않았습니다.` });
  }
  const byPath = <T>([a]: [string, T], [b]: [string, T]): number => (a < b ? -1 : a > b ? 1 : 0);
  for (const [path, x] of [...implicit].sort(byPath)) report.actions.push({ ruleId: "implicit", type: "fill", anchor: `{{${path}}}`, targets: x.count, value: x.value });
  for (const [path, n] of [...implicitDropped].sort(byPath)) report.dropped.push({ ruleId: "implicit", anchor: `{{${path}}}`, reason: `삭제·교체되는 범위 안의 자리 ${n}곳을 버렸습니다.` });
  report.actions.push(...explicit);

  // ── 4. 삭제 편집 ────────────────────────────────────────────
  // txt: 채움으로 글이 모두 빈 줄은 줄바꿈을 잃으면 사라진다. 끝 줄 삭제가 앞 줄의 줄바꿈을 지울지 정할 때 쓴다.
  const emptied = new Set<number>();
  if (doc.kind === "txt") {
    const byBlock = new Map<number, Tagged[]>();
    for (const t of tagged) if (t.block !== undefined) group(byBlock, t.block, t);
    for (const [i, list] of byBlock) {
      const b = doc.blocks[i];
      if (b !== undefined && filledText(b, list) === "") emptied.add(i);
    }
  }
  const deleteTargets = new Map<string, { anchor: string; targets: number }>();
  const noteDelete = (whos: Who[]): void => {
    for (const w of whos) {
      const found = deleteTargets.get(w.ruleId);
      if (found === undefined) deleteTargets.set(w.ruleId, { anchor: w.anchor, targets: 1 });
      else found.targets++;
    }
  };
  /**
   * 이어진 줄 `[firstLine, lastLine]`을 지우는 구간. 줄바꿈이 있는 끝 줄은 그 줄바꿈과 함께 지운다(앞 줄은 손대지 않는다).
   * 끝 줄에 줄바꿈이 없으면(파일 끝) 앞 줄의 줄바꿈까지 지워 "끝 줄바꿈 없음"을 지킨다. 앞 줄이 글자 없는 빈 줄(채우면 비는 줄 포함)이면 그 줄이 사라지므로 줄바꿈을 둔다.
   */
  const lineRun = (firstLine: number, lastLine: number): [number, number] | undefined => {
    const first = doc.lines[firstLine];
    const last = doc.lines[lastLine];
    const before = doc.lines[firstLine - 1];
    if (first === undefined || last === undefined) return undefined;
    if (last.eol !== "") return [first.start, last.end + last.eol.length];
    return before !== undefined && before.end > before.start && !emptied.has(firstLine - 1) ? [before.end, last.end] : [first.start, last.end];
  };
  // 이어진 블록은 한 구간으로 지운다. txt는 줄을 지운다. md는 뒤에 블록이 있으면 (처음 블록 시작 ~ 뒤 블록 시작), 끝까지 지우면 (앞 블록 끝 ~ 마지막 블록 끝)이다.
  const blocks = doc.blocks;
  for (const [a, b] of runsOf([...blockDeletes.keys()].sort((x, y) => x - y))) {
    const first = blocks[a];
    const last = blocks[b];
    const after = blocks[b + 1];
    const before = blocks[a - 1];
    if (first === undefined || last === undefined) continue;
    const span: [number, number] | undefined = doc.kind === "txt" ? lineRun(first.firstLine, last.lastLine) : [after !== undefined || before === undefined ? first.start : before.end, after !== undefined ? after.start : last.end];
    if (span === undefined) continue;
    push(span[0], span[1], "", `규칙 ${blockDeletes.get(a)?.[0]?.ruleId ?? ""}: 블록 삭제`);
    for (let i = a; i <= b; i++) {
      const blk = blocks[i];
      if (blk !== undefined) count(infoOf(blk), -1);
      noteDelete(blockDeletes.get(i) ?? []);
    }
  }
  // 표 행은 줄이므로 `lineRun`으로 지운다(머리행은 지우지 않으므로 앞 줄이 항상 있다)
  for (const [blockIndex, rows] of deletedRows) {
    const table = blocks[blockIndex]?.table;
    if (table === undefined) continue;
    for (const [a, b] of runsOf(rows)) {
      const span = lineRun(table.rows[a]?.line ?? -1, table.rows[b]?.line ?? -1);
      if (span === undefined) continue;
      push(span[0], span[1], "", `규칙 ${rowDeletes.get(blockIndex)?.get(a)?.[0]?.ruleId ?? ""}: 표 행 삭제`);
      delta.tableRows -= b - a + 1;
      for (let r = a; r <= b; r++) noteDelete(rowDeletes.get(blockIndex)?.get(r) ?? []);
    }
  }
  // 원소가 0개인 행 반복은 원형 행 삭제로 처리하지만 보고서에는 `repeat`(0행)로 남긴다
  for (const [ruleId, x] of deleteTargets) {
    const repeated = repeatRuleIds.has(ruleId);
    report.actions.push({ ruleId, type: repeated ? "repeat" : "delete", anchor: x.anchor, targets: repeated ? 0 : x.targets });
  }

  // ── 5. 같은 자리 충돌과 중복 정리 ───────────────────────────
  const edits: TextEdit[] = [];
  const kept: Tagged[] = [];
  let prev: Tagged | undefined;
  for (const cur of [...tagged].sort((a, b) => a.start - b.start || a.end - b.end || a.rank - b.rank || a.seq - b.seq)) {
    if (prev !== undefined && cur.start < prev.end) {
      const twin = cur.start === prev.start && cur.end === prev.end && cur.replacement === prev.replacement;
      if (!twin && !reportedErrors.has(`conflict\u0000${prev.label}\u0000${cur.label}`)) {
        reportedErrors.add(`conflict\u0000${prev.label}\u0000${cur.label}`);
        issues.push(makeIssue("error", "TPL_CONFLICT", `${prev.label}와 ${cur.label}이(가) 같은 자리를 서로 다른 값으로 바꿉니다.`, cur.label));
      }
      continue;
    }
    edits.push({ start: cur.start, end: cur.end, replacement: cur.replacement, label: cur.label });
    kept.push(cur);
    prev = cur;
  }

  // 채움이 md 블록 글을 통째로 비우거나(블록이 없어진다) 한 줄을 비우면(블록이 둘로 나뉜다), txt의 줄바꿈 없는 마지막 줄을 비우면(줄이 없어진다) 블록 수가 바뀐다.
  // 채운 블록 글을 다시 읽어 예상 수량에 반영한다.
  const filled = new Map<number, Tagged[]>();
  for (const t of kept) if (t.block !== undefined) group(filled, t.block, t);
  for (const [blockIndex, list] of filled) {
    const block = doc.blocks[blockIndex];
    if (block === undefined) continue;
    // txt 줄은 줄바꿈을 붙여 읽어야 빈 줄이 줄로 남는다(줄바꿈 없는 마지막 줄만 비면 사라진다)
    const eol = doc.kind === "txt" ? (doc.lines[block.lastLine]?.eol ?? "") : "";
    const text = filledText(block, list) + eol;
    if (!text.isWellFormed()) continue; // 출력 검사가 VAL_ENCODING으로 막는다
    // txt: 비어 버린 마지막 줄도 그 뒤에 새 줄이 붙으면(이 줄 뒤 삽입) 줄로 남는다
    if (doc.kind === "txt" && text === "" && kept.some((t) => t.start === block.end && t.end === block.end)) continue;
    const after = censusOf(parseText(text, doc.kind));
    delta.blocks += after.blocks - 1;
    delta.tables += after.tables;
    delta.code += after.code;
    delta.tableRows += after.tableRows;
  }

  // ── 6. 보고서 ───────────────────────────────────────────────
  for (const key of ["blocks", "tables", "code", "tableRows"] as const) if (delta[key] !== 0) report.expected[key] = delta[key];
  report.requiredPaths = [...required].sort();
  report.missingPaths = [...missingPaths].sort();
  report.kept = [...keptPaths].sort(byPath).map(([path, n]) => ({ path, count: n }));
  const plan: TextPlan = { edits, delta, leaves };
  if (repeats.length > 0) plan.repeats = repeats;
  return { plan, report };
}
