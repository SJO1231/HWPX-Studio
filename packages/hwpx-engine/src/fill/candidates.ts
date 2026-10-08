import { isTableNode, walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, ParagraphNode, SectionModel, TableCell, TableNode } from "../model/types.ts";
import type { CellAnchor, FieldAnchor, LineAnchor, WordAnchor } from "../template/types.ts";
import { findPlaceholders } from "../template/placeholder.ts";
import { linePrintOf, wordPrintAt } from "./anchors.ts";
import { contentObjects, topLevelObjects } from "./doc.ts";
import { collectFields, fieldAnchorOf } from "./fields.ts";

export type AnchorDraft = Omit<FieldAnchor, "id"> | Omit<WordAnchor, "id"> | Omit<LineAnchor, "id"> | Omit<CellAnchor, "id">;

export type CandidateKind =
  /** 누름틀·메일 머지 필드 */
  | "field"
  /** `{{경로}}` 표기 */
  | "placeholder"
  /** 짧은 글(라벨)의 오른쪽 셀이 비었거나 밑줄·괄호뿐 */
  | "emptyCell"
  /** `라벨:` 뒤가 빈 문단 */
  | "labelColon"
  /** `(   )`·`____`·`□` 표시 */
  | "blankMark";

export type Candidate = {
  kind: CandidateKind;
  /** 문단 주소(셀이면 오른쪽 셀의 첫 문단) */
  at: { sectionIndex: number; path: number[] };
  /** 앵커 초안(`id`는 쓰는 쪽이 정한다) */
  anchor: AnchorDraft;
  /** 후보로 본 근거(문서의 라벨·표시 글을 담을 수 있다) */
  evidence: string;
};

const LABEL_MAX = 12;
const LABEL_COLON = /^\s*([^:：\s][^:：]*)[:：]\s*$/;
const BLANK_CELL = /^[\s_()（）[\]]*$/;
// 괄호 안이 공백뿐인 `(   )`, 밑줄 세 개 이상, 빈 네모
const BLANK_MARK = /\(\s{2,}\)|（\s{2,}）|_{3,}|[□☐]/gu;
const SENTENCE_END = /[.!?。…]$|[다요]$/u;

const strip = (text: string): string => text.replace(/￼/g, "").trim();
const cellText = (cell: TableCell): string => (cell.subList?.paragraphs ?? []).map((p) => p.logicalText).join("\n");

/** 라벨 글 규칙: 글(개체 자리 글자를 빼고 앞뒤 공백을 걷은 것)이 비지 않고 12자 이하이며 문장 끝맺음·빈칸 모양이 아니다. */
export function isLabelText(text: string): boolean {
  const t = strip(text);
  return t !== "" && [...t].length <= LABEL_MAX && !SENTENCE_END.test(t) && !BLANK_CELL.test(t);
}

/**
 * 라벨 셀 규칙: 셀 글이 라벨 글 규칙(`isLabelText`)에 맞고,
 * 오른쪽 셀(같은 행, 열 + 열 병합)에 문단이 있고 그 글이 비었거나 밑줄·괄호뿐이면 그 오른쪽 셀을 돌려준다. 아니면 undefined.
 */
export function labelCellRight(table: TableNode, label: TableCell): TableCell | undefined {
  if (!isLabelText(cellText(label))) return undefined;
  const right = table.cells.find((c) => c.row === label.row && c.col === label.col + label.colSpan);
  if (right?.subList?.paragraphs[0] === undefined) return undefined;
  return BLANK_CELL.test(cellText(right).replace(/\n/g, "")) ? right : undefined;
}

/** `라벨:` 글 규칙: 글이 `라벨:`(뒤는 공백뿐)이고 라벨이 12자 이하·문장 끝맺음 아니면 그 라벨(앞뒤 공백을 걷은 것). 아니면 undefined. */
export function colonLabel(text: string): string | undefined {
  const label = LABEL_COLON.exec(text)?.[1]?.trim();
  return label !== undefined && [...label].length <= LABEL_MAX && !SENTENCE_END.test(label) ? label : undefined;
}

/** `라벨:` 규칙: 글이 `라벨:` 글 규칙(`colonLabel`)에 맞고 문단에 내용 개체가 없다. */
export function isLabelColon(par: ParagraphNode): boolean {
  return colonLabel(par.logicalText) !== undefined && contentObjects(par).length === 0;
}

function emptyCellCandidates(section: SectionModel, table: TableNode, out: Candidate[]): void {
  const topOrdinal = topLevelObjects(section, "tbl").findIndex((x) => x.object === table);
  for (const label of table.cells) {
    const right = labelCellRight(table, label);
    const first = right?.subList?.paragraphs[0];
    if (right === undefined || first === undefined) continue;
    const text = strip(cellText(label));
    const rightText = cellText(right);
    const at = { sectionIndex: section.index, path: [...first.path] };
    const anchor: AnchorDraft =
      topOrdinal >= 0
        ? { kind: "cell", table: { sectionIndex: section.index, ordinal: topOrdinal }, row: right.row, col: right.col }
        : { kind: "line", at, print: linePrintOf(first.logicalText) };
    out.push({ kind: "emptyCell", at, anchor, evidence: `라벨 '${text}'의 오른쪽 셀이 ${strip(rightText) === "" ? "비어 있음" : "밑줄·괄호뿐"}` });
  }
}

/**
 * 채울 자리 후보를 찾는다(탐지만 한다). 누름틀, `{{경로}}`, 짧은 글의 오른쪽 빈 셀, `라벨:` 뒤가 빈 경우, `(   )`·`____`·`□` 표시.
 * 결과는 문서 순서이고, 앵커 초안과 근거 문자열을 담는다.
 */
export function findCandidates(doc: HwpxDocument): Candidate[] {
  const out: Candidate[] = [];
  for (const f of collectFields(doc)) {
    out.push({
      kind: "field",
      at: { sectionIndex: f.info.sectionIndex, path: [...f.info.path] },
      anchor: fieldAnchorOf(f.info),
      evidence: f.info.mergeKey === undefined ? `누름틀 '${f.info.name}'(${f.info.shape}, ${f.info.dirty === "1" ? "값이 있음" : "안내문 상태"})` : `메일 머지 필드 '${f.info.mergeKey}'(${f.info.shape})`,
    });
  }
  for (const section of doc.sections) {
    for (const par of walkParagraphs(section.paragraphs)) {
      const text = par.logicalText;
      const at = { sectionIndex: section.index, path: [...par.path] };
      const holders = findPlaceholders(text);
      for (const h of holders) {
        out.push({
          kind: "placeholder",
          at,
          anchor: { kind: "word", at, start: h.start, end: h.end, print: wordPrintAt(text, h.start, h.end) },
          evidence: `{{${h.path}}} 표기`,
        });
      }
      for (const m of text.matchAll(BLANK_MARK)) {
        const start = m.index;
        const end = start + m[0].length;
        if (holders.some((h) => start < h.end && end > h.start)) continue;
        out.push({
          kind: "blankMark",
          at,
          anchor: { kind: "word", at, start, end, print: wordPrintAt(text, start, end) },
          evidence: `빈칸 표시 '${m[0]}'(앞 글: '${text.slice(Math.max(0, start - 12), start)}')`,
        });
      }
      if (isLabelColon(par)) {
        out.push({ kind: "labelColon", at, anchor: { kind: "line", at, print: linePrintOf(text) }, evidence: `라벨 '${text.trim()}' 뒤가 비어 있음` });
      }
      for (const o of par.objects) if (isTableNode(o)) emptyCellCandidates(section, o, out);
    }
  }
  const rank: Record<CandidateKind, number> = { field: 0, placeholder: 1, blankMark: 2, labelColon: 3, emptyCell: 4 };
  const key = (c: Candidate): number[] => [c.at.sectionIndex, ...c.at.path];
  const cmp = (a: number[], b: number[]): number => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? -1) - (b[i] ?? -1);
      if (d !== 0) return d;
    }
    return 0;
  };
  return out
    .map((c, i) => ({ c, i }))
    .sort((x, y) => cmp(key(x.c), key(y.c)) || rank[x.c.kind] - rank[y.c.kind] || x.i - y.i)
    .map((x) => x.c);
}
