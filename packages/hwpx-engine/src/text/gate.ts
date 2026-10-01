import { makeIssue, type Issue } from "../errors.ts";
import { emptyFillReport, type Dataset, type Template } from "../template/index.ts";
import { censusOf, scanPlaceholders } from "./doc.ts";
import { parseText } from "./parse.ts";
import { buildTextPlan } from "./plan.ts";
import type { TextBlock, TextCensus, TextDoc, TextEdit, TextKind, TextOptions, TextPlan, TextReport, TextResult } from "./types.ts";

const errorsOf = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === "error");

/** 편집(원문 좌표, 정렬·비겹침)을 적용한다. */
function applyEdits(text: string, edits: TextEdit[]): string {
  const parts: string[] = [];
  let pos = 0;
  for (const e of edits) {
    parts.push(text.slice(pos, e.start), e.replacement);
    pos = e.end;
  }
  parts.push(text.slice(pos));
  return parts.join("");
}

/** 편집 앞에서 원문 위치가 얼마나 밀리는지(이진 탐색). 끝이 `pos` 이하인 편집들의 길이 변화 합이다. */
function shifter(edits: TextEdit[]): (pos: number) => number {
  const prefix = [0];
  for (const e of edits) prefix.push((prefix[prefix.length - 1] ?? 0) + e.replacement.length - (e.end - e.start));
  return (pos) => {
    let lo = 0;
    let hi = edits.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((edits[mid]?.end ?? Infinity) <= pos) lo = mid + 1;
      else hi = mid;
    }
    return prefix[lo] ?? 0;
  };
}

/** 편집 구간 밖의 글이 원본과 같고 편집 구간의 결과가 계획의 치환과 같은지 본다(`PRESERVE_SPAN`). */
function verifySpans(original: string, output: string, edits: TextEdit[]): Issue[] {
  const bad = (message: string): Issue[] => [makeIssue("error", "PRESERVE_SPAN", message)];
  let from = 0;
  let at = 0;
  for (const e of edits) {
    const gap = original.slice(from, e.start);
    if (!output.startsWith(gap, at)) return bad(`편집 구간 밖의 글이 원본과 다릅니다(원본 오프셋 ${from}~${e.start}).`);
    at += gap.length;
    if (!output.startsWith(e.replacement, at)) return bad(`편집 구간 [${e.start}, ${e.end})의 결과가 계획의 치환과 다릅니다.`);
    at += e.replacement.length;
    from = e.end;
  }
  if (output.slice(at) !== original.slice(from)) return bad(`마지막 편집 뒤의 글이 원본과 다릅니다(원본 오프셋 ${from}~).`);
  return [];
}

const KEYS = ["blocks", "tables", "code", "tableRows"] as const;

function verifyCensus(before: TextCensus, after: TextCensus, delta: TextCensus): Issue[] {
  const issues: Issue[] = [];
  for (const key of KEYS) {
    const want = before[key] + delta[key];
    if (after[key] !== want) {
      issues.push(makeIssue("error", "PRESERVE_CENSUS", `${key} 수량이 예고(${want})와 다릅니다: 실제 ${after[key]} (편집 전 ${before[key]}, 예고한 증감 ${delta[key]}).`));
    }
  }
  return issues;
}

/** 머리행과 칸 수가 다른 행이 있는 표인가 */
const isRagged = (block: TextBlock): boolean => {
  const rows = block.table?.rows ?? [];
  const width = rows[0]?.cells.length ?? 0;
  return rows.some((r) => r.cells.length !== width);
};

/**
 * 출력 검사: 편집 구간 밖 보존 → 수량 → 남은 `{{}}` → md 표의 열 수.
 * - 남은 `{{}}`: 채우기로 한 `{{}}`가 출력에 남아 있으면 `REREAD_TEXT`. 값이나 조각이 가져온 글, 계획이 일부러 남긴 것(`missing: keep` 등)과 코드 블록 안의 것은 세지 않는다.
 * - 열 수: 표의 모든 행이 머리행과 같은 칸 수여야 한다(`VAL_TABLE_COLS`). 원래부터 어긋나 있던 표는 경고다.
 */
export function checkTextOutput(doc: TextDoc, plan: TextPlan, output: string, fillInCode = false): { issues: Issue[]; reread: TextReport["reread"] } {
  const reread = { placeholders: 0, tables: 0 };
  if (!output.isWellFormed()) return { issues: [makeIssue("error", "VAL_ENCODING", "출력에 UTF-8로 쓸 수 없는 문자(짝이 맞지 않는 서로게이트)가 있습니다.")], reread };
  const preserved = verifySpans(doc.source, output, plan.edits);
  if (preserved.length > 0) return { issues: preserved, reread };

  const kind = doc.kind;
  const after = parseText(output, kind);
  const issues = verifyCensus(censusOf(doc), censusOf(after), plan.delta);
  const shift = shifter(plan.edits);
  const place = (pos: number): number => pos + shift(pos);

  // 편집이 출력에 넣은 글 구간(값·조각)
  let moved = 0;
  const spans = plan.edits.flatMap((e) => {
    const start = e.start + moved;
    moved += e.replacement.length - (e.end - e.start);
    return e.replacement.length > 0 ? [{ start, end: start + e.replacement.length }] : [];
  });
  const left = new Set(plan.leaves.map(place));
  const found = scanPlaceholders(after, fillInCode);
  let k = 0;
  for (const h of found) {
    while (k < spans.length && (spans[k]?.end ?? 0) <= h.start) k++;
    if (k < spans.length && (spans[k]?.start ?? 0) < h.end) continue;
    if (!left.has(h.start)) issues.push(makeIssue("error", "REREAD_TEXT", `채우기로 한 {{${h.path}}}이(가) 출력에 남아 있습니다(출력 오프셋 ${h.start}).`, `offset ${h.start}`));
  }
  reread.placeholders = found.length;

  if (kind === "md") {
    const before = new Set(doc.blocks.filter((b) => b.kind === "table" && isRagged(b)).map((b) => place(b.start)));
    for (const b of after.blocks) {
      if (b.kind !== "table") continue;
      reread.tables++;
      if (!isRagged(b)) continue;
      const old = before.has(b.start);
      issues.push(makeIssue(old ? "warning" : "error", "VAL_TABLE_COLS", `${old ? "원래 열 수가 맞지 않던 표: " : ""}표(블록 ${b.index})에 머리행과 칸 수가 다른 행이 있습니다(바깥 파이프가 없는 표의 첫·끝 칸을 비우면 칸이 줄어듭니다).`, `block ${b.index}`));
    }
  }
  return { issues, reread };
}

/**
 * md·txt 문서를 같은 템플릿 규칙·데이터 묶음으로 채운다(명세 9절). 계획 → 적용 → 검사 → 결과.
 *
 * - 입력과 출력은 문자열이다. 줄바꿈 방식(LF·CRLF, 섞여 있으면 줄마다)·BOM·파일 끝 줄바꿈은 편집하지 않은 원문 그대로 남는다.
 * - 오류가 있으면 `{ ok: false, report }`이고 출력이 없다. `dryRun`이면 계획까지만 만들어 `{ ok: true, dryRun: true, report }`를 돌려준다.
 * - 입력에 UTF-8로 쓸 수 없는 문자가 있으면 `TEXT_ENCODING`(`HwpxError`)을 던진다.
 * - 같은 입력으로 다시 돌리면 출력이 같다. 보고서에는 값 원문이 없다(길이와 해시 앞 8자).
 */
export function generateText(text: string, kind: TextKind, template: Template, dataset: Dataset, options: TextOptions = {}): TextResult {
  const dryRun = options.dryRun === true;
  const issues: Issue[] = [];
  const report: TextReport = { kind, dryRun, plan: emptyFillReport(), edits: [], reread: { placeholders: 0, tables: 0 }, issues };
  const failed = (): TextResult => ({ ok: false, report });

  const doc = parseText(text, kind);
  issues.push(...doc.issues);

  // 계획
  const built = buildTextPlan(doc, template, dataset, options);
  report.plan = built.report;
  issues.push(...built.report.issues);
  if (errorsOf(issues).length > 0) return failed();
  report.edits = built.plan.edits.map((e) => ({ start: e.start, end: e.end, newLength: e.replacement.length, label: e.label }));
  if (dryRun) return { ok: true, dryRun: true, report };

  // 적용과 검사
  let output = applyEdits(text, built.plan.edits);
  output = options.testHooks?.afterApply?.(output) ?? output;
  const checked = checkTextOutput(doc, built.plan, output, options.fillInCode === true);
  report.reread = checked.reread;
  issues.push(...checked.issues);
  if (errorsOf(issues).length > 0) return failed();
  return { ok: true, dryRun: false, output, report };
}
