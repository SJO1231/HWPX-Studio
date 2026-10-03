import { walkParagraphs } from "./paragraph.ts";
import type { FieldInfo, FieldMark, FieldShape, HwpxDocument, ParagraphNode } from "./types.ts";

type Located = { sectionIndex: number; paragraph: ParagraphNode; mark: FieldMark };
type Pair = { begin: Located; end: Located | null };

function shapeBetween(paragraph: ParagraphNode, begin: FieldMark, end: FieldMark): FieldShape {
  const between = paragraph.pieces.slice(begin.pieceIndex + 1, end.pieceIndex);
  if (between.some((p) => p.kind === "inline" || p.kind === "object")) return "inline";
  return between.some((p) => p.kind === "text" || p.kind === "entity") ? "simple" : "empty";
}

/** 문서의 누름틀(fieldBegin)을 문서 순서로 나열한다. type이 HYPERLINK인 필드는 뺀다. */
export function listFields(doc: HwpxDocument): FieldInfo[] {
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
    const type = begin.mark.type ?? "";
    if (type === "HYPERLINK") continue;
    const name = begin.mark.name ?? "";
    const occurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, occurrence + 1);

    let shape: FieldShape;
    let valueText = "";
    if (end === null) {
      shape = "unpaired";
    } else if (end.paragraph !== begin.paragraph) {
      shape = "crossParagraph";
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
      occurrence,
      sectionIndex: begin.sectionIndex,
      path: begin.paragraph.path,
      valueText,
      dirty: begin.mark.dirty ?? "",
      shape,
    });
  }
  return out;
}
