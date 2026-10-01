import { isTableNode, walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, SectionModel, TableCell, TableNode } from "../model/types.ts";
import type { CellAnchor, FieldAnchor, LineAnchor, WordAnchor } from "../template/types.ts";
import { findPlaceholders } from "../template/placeholder.ts";
import { linePrintOf, wordPrintAt } from "./anchors.ts";
import { contentObjects, topLevelObjects } from "./doc.ts";
import { collectFields } from "./fields.ts";

export type AnchorDraft = Omit<FieldAnchor, "id"> | Omit<WordAnchor, "id"> | Omit<LineAnchor, "id"> | Omit<CellAnchor, "id">;

export type CandidateKind =
  /** 누름틀 */
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

function emptyCellCandidates(section: SectionModel, table: TableNode, out: Candidate[]): void {
  const topOrdinal = topLevelObjects(section, "tbl").findIndex((x) => x.object === table);
  for (const label of table.cells) {
    const text = strip(cellText(label));
    if (text === "" || [...text].length > LABEL_MAX || SENTENCE_END.test(text) || BLANK_CELL.test(text)) continue;
    const right = table.cells.find((c) => c.row === label.row && c.col === label.col + label.colSpan);
    const first = right?.subList?.paragraphs[0];
    if (right === undefined || first === undefined) continue;
    const rightText = cellText(right);
    if (!BLANK_CELL.test(rightText.replace(/\n/g, ""))) continue;
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
      anchor: { kind: "field", name: f.info.name, occurrence: f.info.occurrence },
      evidence: `누름틀 '${f.info.name}'(${f.info.shape}, ${f.info.dirty === "1" ? "값이 있음" : "안내문 상태"})`,
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
      const label = LABEL_COLON.exec(text)?.[1]?.trim();
      if (label !== undefined && [...label].length <= LABEL_MAX && !SENTENCE_END.test(label) && contentObjects(par).length === 0) {
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
