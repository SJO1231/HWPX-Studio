import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import type { HwpxDocument, ParagraphNode, SectionModel } from "../model/types.ts";
import type { FragmentSelection } from "./types.ts";

const isIndex = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function sectionAt(doc: HwpxDocument, sectionIndex: number, code: string): SectionModel {
  const section = isIndex(sectionIndex) ? doc.sections[sectionIndex] : undefined;
  if (section === undefined) throw new HwpxError(code, `구역 ${sectionIndex}이(가) 없습니다(구역 ${doc.sections.length}개).`);
  return section;
}

/**
 * `parentPath`가 가리키는 하위 목록의 문단들. 빈 배열이면 구역의 최상위 문단이다.
 * 주소는 `[문단 서수, 하위목록 서수, 문단 서수, ...]`에서 하위 목록까지(짝수 길이)다.
 */
export function paragraphsAt(section: SectionModel, parentPath: number[], code: string): ParagraphNode[] {
  if (parentPath.length % 2 !== 0 || !parentPath.every(isIndex)) {
    throw new HwpxError(code, `상위 주소 [${parentPath.join(", ")}]는 [문단, 하위목록, ...] 짝으로 이뤄져야 합니다.`);
  }
  let list = section.paragraphs;
  for (let i = 0; i < parentPath.length; i += 2) {
    const sub = list[parentPath[i] ?? -1]?.subLists[parentPath[i + 1] ?? -1];
    if (sub === undefined) throw new HwpxError(code, `상위 주소 [${parentPath.join(", ")}]가 가리키는 하위 목록이 없습니다.`);
    list = sub.paragraphs;
  }
  return list;
}

/** 선택이 가리키는 구역과 문단들(from~to 포함). */
export function resolveSelection(doc: HwpxDocument, sel: FragmentSelection): { section: SectionModel; paragraphs: ParagraphNode[] } {
  const section = sectionAt(doc, sel.sectionIndex, "FRAG_SELECTION");
  const list = paragraphsAt(section, sel.parentPath, "FRAG_SELECTION");
  if (!isIndex(sel.from) || !isIndex(sel.to) || sel.from > sel.to || sel.to >= list.length) {
    throw new HwpxError("FRAG_SELECTION", `문단 범위 ${sel.from}~${sel.to}가 올바르지 않습니다(목록의 문단 ${list.length}개).`);
  }
  return { section, paragraphs: list.slice(sel.from, sel.to + 1) };
}

/**
 * 구역 안 최상위 문단들에서 `tableOrdinal`번째 표를 담은 문단 하나를 선택으로 돌려준다.
 * 그 문단에 표 말고 글이 있으면 경고를 붙인다.
 */
export function selectTable(
  doc: HwpxDocument,
  sectionIndex: number,
  tableOrdinal: number,
): { selection: FragmentSelection; issues: Issue[] } {
  const section = sectionAt(doc, sectionIndex, "FRAG_SELECTION");
  let seen = 0;
  for (const [index, p] of section.paragraphs.entries()) {
    for (const o of p.objects) {
      if (o.type !== "tbl") continue;
      if (seen++ !== tableOrdinal) continue;
      const issues: Issue[] = [];
      if (p.logicalText.replace(/[￼\s]/g, "") !== "") {
        issues.push(makeIssue("warning", "FRAG_TABLE_PARAGRAPH_TEXT", `표를 담은 문단 ${index}에 표 말고 글이 있습니다.`, section.entryName));
      }
      return { selection: { sectionIndex, parentPath: [], from: index, to: index }, issues };
    }
  }
  throw new HwpxError("FRAG_SELECTION", `구역 ${sectionIndex}에 ${tableOrdinal}번째 표가 없습니다(최상위 표 ${seen}개).`);
}
