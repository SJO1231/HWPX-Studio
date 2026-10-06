import { fieldTypeOf, walkParagraphs } from "./paragraph.ts";
import type { FieldInfo, FieldMark, FieldShape, HwpxDocument, ParagraphNode } from "./types.ts";

type Located = { sectionIndex: number; paragraph: ParagraphNode; mark: FieldMark };
type Pair = { begin: Located; end: Located | null };

function shapeBetween(paragraph: ParagraphNode, begin: FieldMark, end: FieldMark): FieldShape {
  const between = paragraph.pieces.slice(begin.pieceIndex + 1, end.pieceIndex);
  if (between.some((p) => p.kind === "object")) return "object";
  if (between.some((p) => p.kind === "inline")) return "inline";
  return between.some((p) => p.kind === "text" || p.kind === "entity") ? "simple" : "empty";
}

/** 두 문단이 같은 컨테이너(같은 구역의 같은 목록)의 형제인가. 주소는 `[문단, 하위목록, 문단, ...]`이라 마지막 문단 번호만 빼고 같으면 형제다. */
function siblingPaths(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => i === a.length - 1 || v === b[i]);
}

/**
 * 문서의 필드(fieldBegin)를 문서 순서로 나열한다. type이 HYPERLINK인 필드는 뺀다.
 * `type`은 `fieldTypeOf`로 정한 종류다(`CLICK_HERE`·`MAILMERGE`·`HYPERLINK`는 대소문자 무시, type 속성이 없거나 비면 `UNKNOWN`).
 * 메일 머지 필드(`MAILMERGE`)는 `name`이 비어 있어 `mergeKey`(키)를 함께 돌려주고, 순번은 같은 키 안에서 센다.
 */
export function listFields(doc: Pick<HwpxDocument, "sections">): FieldInfo[] {
  // 표식을 문서 순서로 훑으며 end를 그것이 가리키는 열린 begin과 짝짓는다.
  // 같은 id의 begin이 이미 열려 있으면 앞의 것은 짝 없음으로 남는다.
  const open = new Map<string, Pair>();
  const pairs: Pair[] = [];
  for (const section of doc.sections) {
    for (const paragraph of walkParagraphs(section.paragraphs)) {
      for (const mark of paragraph.fieldMarks) {
        const here: Located = { sectionIndex: section.index, paragraph, mark };
        if (mark.kind === "begin") {
          const pair: Pair = { begin: here, end: null };
          pairs.push(pair);
          open.set(mark.id, pair);
        } else if (mark.beginIDRef !== undefined) {
          const pair = open.get(mark.beginIDRef);
          if (pair !== undefined) {
            pair.end = here;
            open.delete(mark.beginIDRef);
          }
        }
      }
    }
  }

  const occurrences = new Map<string, number>();
  const out: FieldInfo[] = [];
  for (const { begin, end } of pairs) {
    const type = fieldTypeOf(begin.mark.type);
    if (type === "HYPERLINK") continue;
    const name = begin.mark.name ?? "";
    const { mergeKey } = begin.mark;
    // 키가 있는 메일 머지 필드는 이름이 아니라 키로 순번을 센다(이름이 없는 누름틀과 섞이지 않게 접두사로 가른다)
    const group = mergeKey === undefined ? `n:${name}` : `m:${mergeKey}`;
    const occurrence = occurrences.get(group) ?? 0;
    occurrences.set(group, occurrence + 1);

    let shape: FieldShape;
    let valueText = "";
    let endPath: number[] | undefined;
    if (end === null) {
      shape = "unpaired";
    } else if (end.paragraph !== begin.paragraph) {
      endPath = end.paragraph.path;
      shape = end.sectionIndex === begin.sectionIndex && siblingPaths(begin.paragraph.path, end.paragraph.path) ? "crossParagraph" : "crossContainer";
    } else {
      const p = begin.paragraph;
      shape = shapeBetween(p, begin.mark, end.mark);
      const from = p.pieces[begin.mark.pieceIndex]?.logicalEnd ?? 0;
      const to = p.pieces[end.mark.pieceIndex]?.logicalStart ?? from;
      valueText = p.logicalText.slice(from, to);
    }
    out.push({
      name,
      type,
      ...(mergeKey === undefined ? {} : { mergeKey }),
      occurrence,
      sectionIndex: begin.sectionIndex,
      path: begin.paragraph.path,
      valueText,
      dirty: begin.mark.dirty ?? "",
      shape,
      ...(endPath === undefined ? {} : { endPath }),
    });
  }
  return out;
}
