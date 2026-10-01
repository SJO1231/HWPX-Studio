import { makeIssue, type Issue } from "../errors.ts";
import { isTableNode, walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, ObjectNode, ParagraphNode, SectionModel, TableCell, TableNode } from "../model/types.ts";
import type { Anchor, LineAnchor, LinePrint, Template, WordAnchor, WordPrint } from "../template/types.ts";
import { sha256Hex } from "../template/hash.ts";
import { paragraphAtPath, topLevelObjects } from "./doc.ts";
import { collectFields, type FieldTarget } from "./fields.ts";

export const WORD_CONTEXT = 24;
export const LINE_PREFIX = 40;

export type ResolvedAnchor =
  | { kind: "field"; targets: FieldTarget[] }
  | { kind: "word"; section: SectionModel; paragraph: ParagraphNode; start: number; end: number; relocated: boolean }
  | { kind: "line"; section: SectionModel; paragraph: ParagraphNode; relocated: boolean }
  | { kind: "cell"; section: SectionModel; owner: ParagraphNode; table: TableNode; cell: TableCell }
  | { kind: "object"; section: SectionModel; paragraph: ParagraphNode; object: ObjectNode };

export type AnchorResolution = {
  /** 해석에 성공한 앵커(id → 해석). 실패한 앵커는 `issues`에 오류로 있다. */
  anchors: Map<string, ResolvedAnchor>;
  issues: Issue[];
};

// ── 지문 ────────────────────────────────────────────────────────

/** `word` 앵커의 지문: 대상 글과 앞뒤 24자까지의 글. */
export function wordPrintAt(text: string, start: number, end: number): WordPrint {
  return {
    text: text.slice(start, end),
    before: text.slice(Math.max(0, start - WORD_CONTEXT), start),
    after: text.slice(end, end + WORD_CONTEXT),
  };
}

/** `line` 앵커의 지문: 문단 글 앞 40자와 문단 글 전체의 sha256. */
export function linePrintOf(text: string): LinePrint {
  return { text: text.slice(0, LINE_PREFIX), sha256: sha256Hex(text) };
}

const samePrint = (a: WordPrint, b: WordPrint): boolean => a.text === b.text && a.before === b.before && a.after === b.after;

/** 문단 주소의 `line` 앵커 초안을 만든다(문서의 지금 글에서 지문을 뜬다). 문단이 없으면 undefined. */
export function makeLineAnchor(doc: HwpxDocument, id: string, sectionIndex: number, path: number[]): LineAnchor | undefined {
  const section = doc.sections[sectionIndex];
  const paragraph = section === undefined ? undefined : paragraphAtPath(section, path);
  if (paragraph === undefined) return undefined;
  return { id, kind: "line", at: { sectionIndex, path: [...path] }, print: linePrintOf(paragraph.logicalText) };
}

/** 문단 주소와 논리 구간의 `word` 앵커 초안을 만든다. 구간이 문단 글 밖이면 undefined. */
export function makeWordAnchor(doc: HwpxDocument, id: string, sectionIndex: number, path: number[], start: number, end: number): WordAnchor | undefined {
  const section = doc.sections[sectionIndex];
  const paragraph = section === undefined ? undefined : paragraphAtPath(section, path);
  if (paragraph === undefined || start < 0 || end <= start || end > paragraph.logicalText.length) return undefined;
  return { id, kind: "word", at: { sectionIndex, path: [...path] }, start, end, print: wordPrintAt(paragraph.logicalText, start, end) };
}

// ── 해석 ────────────────────────────────────────────────────────

const addr = (path: number[]): string => `[${path.join(", ")}]`;

function relocate<T>(id: string, found: T[], what: string, at: string, issues: Issue[]): T | undefined {
  if (found.length === 1) {
    issues.push(makeIssue("warning", "ANCHOR_RELOCATED", `앵커 ${id}: 주소 ${at}의 ${what}이(가) 지문과 달라 같은 구역에서 지문으로 다시 찾았습니다.`, id));
    return found[0];
  }
  if (found.length === 0) {
    issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${id}: 주소 ${at}의 ${what}이(가) 지문과 다르고 같은 구역에서도 찾지 못했습니다.`, id));
  } else {
    issues.push(makeIssue("error", "ANCHOR_AMBIGUOUS", `앵커 ${id}: 지문과 같은 ${what}이(가) 같은 구역에 ${found.length}곳 있어 하나로 정할 수 없습니다.`, id));
  }
  return undefined;
}

function resolveWord(doc: HwpxDocument, a: WordAnchor, issues: Issue[]): ResolvedAnchor | undefined {
  const section = doc.sections[a.at.sectionIndex];
  if (section === undefined) {
    issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: 구역 ${a.at.sectionIndex}이(가) 없습니다.`, a.id));
    return undefined;
  }
  const paragraph = paragraphAtPath(section, a.at.path);
  if (paragraph !== undefined && a.end <= paragraph.logicalText.length && samePrint(wordPrintAt(paragraph.logicalText, a.start, a.end), a.print)) {
    return { kind: "word", section, paragraph, start: a.start, end: a.end, relocated: false };
  }
  const found: { paragraph: ParagraphNode; start: number }[] = [];
  for (const p of walkParagraphs(section.paragraphs)) {
    for (let s = p.logicalText.indexOf(a.print.text); s >= 0; s = p.logicalText.indexOf(a.print.text, s + 1)) {
      if (samePrint(wordPrintAt(p.logicalText, s, s + a.print.text.length), a.print)) found.push({ paragraph: p, start: s });
    }
  }
  const hit = relocate(a.id, found, "글", addr(a.at.path), issues);
  return hit === undefined
    ? undefined
    : { kind: "word", section, paragraph: hit.paragraph, start: hit.start, end: hit.start + a.print.text.length, relocated: true };
}

function resolveLine(doc: HwpxDocument, a: LineAnchor, issues: Issue[]): ResolvedAnchor | undefined {
  const section = doc.sections[a.at.sectionIndex];
  if (section === undefined) {
    issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: 구역 ${a.at.sectionIndex}이(가) 없습니다.`, a.id));
    return undefined;
  }
  const matches = (p: ParagraphNode): boolean => {
    const print = linePrintOf(p.logicalText);
    return print.text === a.print.text && print.sha256 === a.print.sha256;
  };
  const paragraph = paragraphAtPath(section, a.at.path);
  if (paragraph !== undefined && matches(paragraph)) return { kind: "line", section, paragraph, relocated: false };
  const found = [...walkParagraphs(section.paragraphs)].filter(matches);
  const hit = relocate(a.id, found, "문단", addr(a.at.path), issues);
  return hit === undefined ? undefined : { kind: "line", section, paragraph: hit, relocated: true };
}

function resolveCell(doc: HwpxDocument, a: Extract<Anchor, { kind: "cell" }>, issues: Issue[]): ResolvedAnchor | undefined {
  const section = doc.sections[a.table.sectionIndex];
  const owner = section === undefined ? undefined : topLevelObjects(section, "tbl")[a.table.ordinal];
  if (section === undefined || owner === undefined || !isTableNode(owner.object)) {
    issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: 구역 ${a.table.sectionIndex}에 ${a.table.ordinal}번째 표가 없습니다.`, a.id));
    return undefined;
  }
  const table = owner.object;
  const cell = table.cells.find((c) => c.row === a.row && c.col === a.col);
  if (cell === undefined) {
    issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: 표 ${a.table.ordinal}에 행 ${a.row}, 열 ${a.col} 셀이 없습니다.`, a.id));
    return undefined;
  }
  return { kind: "cell", section, owner: owner.paragraph, table, cell };
}

function resolveObject(doc: HwpxDocument, a: Extract<Anchor, { kind: "object" }>, issues: Issue[]): ResolvedAnchor | undefined {
  const section = doc.sections[a.sectionIndex];
  const hit = section === undefined ? undefined : topLevelObjects(section, a.objectType)[a.ordinal];
  if (section === undefined || hit === undefined) {
    issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: 구역 ${a.sectionIndex}에 ${a.ordinal}번째 ${a.objectType} 객체가 없습니다.`, a.id));
    return undefined;
  }
  return { kind: "object", section, paragraph: hit.paragraph, object: hit.object };
}

/**
 * 템플릿의 앵커를 문서에서 찾는다. `only`가 있으면 그 id의 앵커만 해석한다(조건이 거짓인 규칙의 앵커는 찾지 않는다).
 * - `field`: 이름이 같은 누름틀 전부(순번을 주면 그것만). 없으면 `ANCHOR_NOT_FOUND`.
 * - `word`·`line`: 주소의 문단을 지문과 대조한다. 맞으면 그 자리, 아니면 같은 구역에서 지문으로 다시 찾는다:
 *   유일하면 `ANCHOR_RELOCATED`(경고), 여럿이면 `ANCHOR_AMBIGUOUS`, 없으면 `ANCHOR_NOT_FOUND`(오류).
 * - `cell`·`object`: 서수로 찾는다. 범위 밖이면 `ANCHOR_NOT_FOUND`.
 */
export function resolveAnchors(doc: HwpxDocument, template: Template, only?: ReadonlySet<string>): AnchorResolution {
  const anchors = new Map<string, ResolvedAnchor>();
  const issues: Issue[] = [];
  let fields: FieldTarget[] | undefined;
  for (const a of template.anchors) {
    if (only !== undefined && !only.has(a.id)) continue;
    let resolved: ResolvedAnchor | undefined;
    switch (a.kind) {
      case "field": {
        fields ??= collectFields(doc);
        const targets = fields.filter((f) => f.info.name === a.name && (a.occurrence === undefined || f.info.occurrence === a.occurrence));
        if (targets.length === 0) {
          issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: 이름이 같은 누름틀${a.occurrence === undefined ? "" : `(순번 ${a.occurrence})`}이 문서에 없습니다.`, a.id));
        } else {
          resolved = { kind: "field", targets };
        }
        break;
      }
      case "word":
        resolved = resolveWord(doc, a, issues);
        break;
      case "line":
        resolved = resolveLine(doc, a, issues);
        break;
      case "cell":
        resolved = resolveCell(doc, a, issues);
        break;
      case "object":
        resolved = resolveObject(doc, a, issues);
        break;
    }
    if (resolved !== undefined) anchors.set(a.id, resolved);
  }
  return { anchors, issues };
}
