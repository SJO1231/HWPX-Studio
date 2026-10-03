import { applyPlan, type EditPlan, type SpanEdit } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { scanInstanceAttrs } from "../fragment/util.ts";
import { listFields } from "../model/fields.ts";
import { parseDocument } from "../model/document.ts";
import { walkParagraphs } from "../model/paragraph.ts";
import type { FieldMark, HwpxDocument, ParagraphNode, SectionModel } from "../model/types.ts";
import { openPackage } from "../package/open.ts";
import { findPlaceholders } from "../template/placeholder.ts";
import { compareToBaseline, validateDocument, type ValidationIssue } from "../validate/index.ts";
import { walkElements, type XElement } from "../xml/tree.ts";
import { censusOfDoc, verifyCensus, zeroDelta } from "./census.ts";
import { beginXml, endXml } from "./click-here.ts";
import { paragraphAtPath, nsPrefixOf } from "./doc.ts";
import { planMergeConversion, type MergeFieldsMode } from "./merge-convert.ts";
import { span } from "./text.ts";
import { verifyPreservation } from "./verify.ts";

export type { MergeFieldsMode } from "./merge-convert.ts";

/** 승격할 글: 문단 주소와 그 문단 논리 텍스트 안의 구간, 누름틀 이름. */
export type CompileTarget = { sectionIndex: number; path: number[]; start: number; end: number; name: string };

type Found = { section: SectionModel; paragraph: ParagraphNode; start: number; end: number; name: string };

/** 조각 `index`가 같은 문단의 필드 시작과 끝 사이에 있으면 그 필드의 시작 표식(안쪽부터 아니라 문단에서 먼저 시작한 것). 아니면 undefined. */
function insideField(par: ParagraphNode, index: number): FieldMark | undefined {
  return par.fieldMarks.find((begin, i) => {
    if (begin.kind !== "begin") return false;
    const end = par.fieldMarks.slice(i + 1).find((m) => m.kind === "end" && m.beginIDRef === begin.id);
    return end !== undefined && begin.pieceIndex < index && index < end.pieceIndex;
  });
}

/**
 * `{{경로}}` 자리(또는 지정한 구간)를 누름틀로 바꾸는 편집 계획. 이름은 경로(지정한 구간은 `name`)이고, 글은 그대로 두며
 * 시작 요소의 `dirty`는 `"1"`이다. 시작 id는 문서의 인스턴스 id 가운데 가장 큰 값 다음부터 문서 순서대로 준다.
 * 글이 한 `hp:t` 안의 한 덩어리가 아니거나(탭·글자모양 변경으로 갈림, CDATA) 이미 누름틀 안이면 승격하지 않고 `COMPILE_SKIPPED` 경고를 남긴다.
 * `mergeFields`를 주면 메일 머지 필드(키가 있는 것)도 바꾼다(`planMergeConversion`). 그 필드의 표시 글 안의 `{{경로}}`는 그 변환이 맡으므로 따로 승격하지 않고 경고도 내지 않는다.
 */
export function planCompile(doc: HwpxDocument, anchors?: CompileTarget[], mergeFields?: MergeFieldsMode): EditPlan {
  const issues: Issue[] = [];
  const found: Found[] = [];
  if (anchors === undefined) {
    for (const section of doc.sections) {
      for (const paragraph of walkParagraphs(section.paragraphs)) {
        for (const hit of findPlaceholders(paragraph.logicalText)) found.push({ section, paragraph, start: hit.start, end: hit.end, name: hit.path });
      }
    }
  } else {
    for (const a of anchors) {
      const section = doc.sections[a.sectionIndex];
      const paragraph = section === undefined ? undefined : paragraphAtPath(section, a.path);
      if (section === undefined || paragraph === undefined || a.start < 0 || a.end <= a.start || a.end > paragraph.logicalText.length || a.name === "") {
        issues.push(makeIssue("warning", "COMPILE_SKIPPED", `지정한 구간(구역 ${a.sectionIndex}, 주소 [${a.path.join(", ")}])이 문서에 없어 승격하지 않았습니다.`));
        continue;
      }
      found.push({ section, paragraph, start: a.start, end: a.end, name: a.name });
    }
  }

  let nextId = 1;
  for (const s of doc.sections) {
    for (const x of scanInstanceAttrs(walkElements(s.root))) {
      if (x.role !== "fieldEndRef" && /^\d+$/.test(x.attr.value) && Number(x.attr.value) < 4294967295) nextId = Math.max(nextId, Number(x.attr.value) + 1);
    }
  }

  const edits: SpanEdit[] = [];
  let promoted = 0;
  for (const f of found) {
    const where = `${f.section.entryName} [${f.paragraph.path.join(", ")}]`;
    const pieces = f.paragraph.pieces.filter((p) => p.logicalStart < f.end && p.logicalEnd > f.start && p.logicalEnd > p.logicalStart);
    const piece = pieces[0];
    const inline = f.paragraph.pieces.some((p) => (p.kind === "inline" || p.kind === "object") && p.logicalStart < f.end && p.logicalEnd > f.start);
    const t: XElement | undefined =
      piece === undefined
        ? undefined
        : f.paragraph.runs[piece.runOrdinal]?.element.children.find(
            (c): c is XElement => "local" in c && c.local === "t" && c.start <= piece.start && piece.end <= c.closeStart,
          );
    const text = f.section.text;
    const enclosing = piece === undefined ? undefined : insideField(f.paragraph, f.paragraph.pieces.indexOf(piece));
    if (enclosing !== undefined) {
      if (mergeFields === undefined || enclosing.type !== "MAILMERGE" || enclosing.mergeKey === undefined) {
        issues.push(makeIssue("warning", "COMPILE_SKIPPED", `${where}: 이미 누름틀 안에 있는 자리라 승격하지 않았습니다.`, where));
      }
      continue;
    }
    const cdata = piece !== undefined && piece.start >= 9 && text.startsWith("<![CDATA[", piece.start - 9);
    if (piece === undefined || pieces.length !== 1 || piece.kind !== "text" || inline || t === undefined || cdata || f.start < piece.logicalStart || f.end > piece.logicalEnd) {
      issues.push(makeIssue("warning", "COMPILE_SKIPPED", `${where}: 자리가 한 hp:t 안의 한 덩어리가 아니라 누름틀로 승격하지 않았습니다.`, where));
      continue;
    }
    const id = String(nextId++);
    const prefix = nsPrefixOf(t);
    const open = text.slice(t.start, t.openEnd);
    const close = `</${t.qname}>`;
    const rawStart = piece.start + (f.start - piece.logicalStart);
    const rawEnd = piece.start + (f.end - piece.logicalStart);
    const ctx = { entry: f.section.entryName, text };
    edits.push(span(ctx, rawStart, rawStart, `${close}${beginXml(prefix, id, f.name)}${open}`, `누름틀 승격: ${f.name}`));
    edits.push(span(ctx, rawEnd, rawEnd, `${close}${endXml(prefix, id)}${open}`, `누름틀 승격: ${f.name}`));
    promoted++;
  }
  const merge = mergeFields === undefined ? undefined : planMergeConversion(doc, mergeFields);
  if (merge !== undefined) {
    edits.push(...merge.edits);
    issues.push(...merge.issues);
  }
  return {
    edits,
    additions: [],
    summary: { promotedFields: promoted, skipped: issues.length, mergeConverted: merge?.converted ?? 0, mergePlaceholdersInside: merge?.placeholdersInside ?? 0 },
    issues,
  };
}

export type CompileResult =
  | { ok: true; output: Uint8Array; report: CompileReport }
  | { ok: false; report: CompileReport };

export type CompileReport = {
  mode: "baseline" | "strict";
  /** 누름틀로 승격한 자리 수 */
  promoted: number;
  /** `mergeFields`로 바꾼 메일 머지 필드 수 */
  mergeConverted: number;
  newErrors: ValidationIssue[];
  preexisting: ValidationIssue[];
  issues: Issue[];
};

/**
 * `planCompile`을 저장 게이트 안에서 적용한다: 적용·재파싱·검사·보존 확인·수량 대조(누름틀 +승격 수)·값 재읽기
 * (승격한 이름과 글을 가진 누름틀이 `simple`·`dirty="1"`로 있다). 실험 기능이라 호출하는 쪽(CLI)이 `--experimental`을 요구한다.
 */
export function compileDocument(bytes: Uint8Array, options: { mode?: "baseline" | "strict"; anchors?: CompileTarget[]; mergeFields?: MergeFieldsMode } = {}): CompileResult {
  const mode = options.mode ?? "baseline";
  const issues: Issue[] = [];
  const report: CompileReport = { mode, promoted: 0, mergeConverted: 0, newErrors: [], preexisting: [], issues };
  const before = validateDocument(bytes);
  const doc = parseDocument(openPackage(bytes));
  const plan = planCompile(doc, options.anchors, options.mergeFields);
  issues.push(...plan.issues);
  report.promoted = plan.summary["promotedFields"] ?? 0;
  report.mergeConverted = plan.summary["mergeConverted"] ?? 0;
  const placeholdersInside = plan.summary["mergePlaceholdersInside"] ?? 0;

  let output: Uint8Array;
  let next: HwpxDocument;
  try {
    output = applyPlan(doc.pkg, plan);
    next = parseDocument(openPackage(output));
  } catch (e) {
    if (!(e instanceof HwpxError)) throw e;
    issues.push(makeIssue("error", e.code, e.message));
    return { ok: false, report };
  }
  issues.push(...verifyPreservation(bytes, output, plan, "compile"));
  // 필드 쌍 수: 승격한 만큼 늘고, `to-placeholder`로 바꾼 메일 머지 필드(표식을 지운다)만큼 줄며, `to-field`는 쌍 수를 바꾸지 않는다
  const removedPairs = options.mergeFields === "to-placeholder" ? report.mergeConverted : 0;
  issues.push(...verifyCensus(censusOfDoc(doc), censusOfDoc(next), { ...zeroDelta(), fieldPairs: report.promoted - removedPairs }, "compile"));

  // 값 재읽기: 승격한 자리(편집 구간 안의 이름·글)마다 같은 이름·글의 누름틀이 늘었는지
  const key = (f: { name: string; valueText: string; dirty: string; shape: string }): string => JSON.stringify([f.name, f.valueText, f.dirty, f.shape]);
  const counts = new Map<string, number>();
  for (const f of listFields(next)) counts.set(key(f), (counts.get(key(f)) ?? 0) + 1);
  for (const f of listFields(doc)) counts.set(key(f), (counts.get(key(f)) ?? 0) - 1);
  const grown = [...counts.values()].filter((n) => n > 0).reduce((a, b) => a + b, 0);
  // `to-field`로 바꾼 메일 머지 필드도 같은 꼴(이름 = 키, 글은 표시 글 그대로, dirty="1")의 누름틀로 늘어난다
  const expectedGrown = report.promoted + (options.mergeFields === "to-field" ? report.mergeConverted : 0);
  if (grown !== expectedGrown) {
    issues.push(makeIssue("error", "REREAD_FIELD", `승격한 누름틀이 dirty="1"·원래 글로 ${expectedGrown}개 늘어야 하는데 ${grown}개 늘었습니다.`));
  }
  if (options.mergeFields !== undefined) {
    // 바꾼 메일 머지 필드는 문서에서 그만큼 줄어든다. `to-placeholder`는 표시 글 자리가 `{{키}}` 하나씩으로 바뀐다(자리 수 = 앞 − 지운 표시 글 안의 자리 + 바꾼 필드 수)
    const mergeCount = (d: HwpxDocument): number => listFields(d).filter((f) => f.type === "MAILMERGE" && f.mergeKey !== undefined).length;
    if (mergeCount(doc) - mergeCount(next) !== report.mergeConverted) {
      issues.push(makeIssue("error", "REREAD_FIELD", `바꾼 메일 머지 필드 ${report.mergeConverted}개가 줄어야 하는데 ${mergeCount(doc) - mergeCount(next)}개 줄었습니다.`));
    }
    if (options.mergeFields === "to-placeholder") {
      const slots = (d: HwpxDocument): number => d.sections.reduce((n, s) => n + [...walkParagraphs(s.paragraphs)].reduce((m, p) => m + findPlaceholders(p.logicalText).length, 0), 0);
      const want = slots(doc) - placeholdersInside + report.mergeConverted;
      if (slots(next) !== want) {
        issues.push(makeIssue("error", "REREAD_TEXT", `{{키}} 자리가 ${want}개여야 하는데 ${slots(next)}개입니다.`));
      }
    }
  }

  const after = validateDocument(output, { strict: mode === "strict" });
  const cmp = compareToBaseline(before, after);
  report.newErrors = cmp.newErrors;
  report.preexisting = cmp.preexisting;
  if (mode === "strict" ? after.errors.length > 0 : cmp.newErrors.length > 0) {
    for (const v of mode === "strict" ? after.errors : cmp.newErrors) issues.push(makeIssue("error", v.code, v.message, v.where));
  }
  if (issues.some((i) => i.severity === "error")) return { ok: false, report };
  return { ok: true, output, report };
}
