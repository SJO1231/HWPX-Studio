import { attrNode, elementChildren, walkElements } from "../xml/tree.ts";
import { attrEdit, type EntryDoc } from "./entries.ts";
import { emptyPart, type PlanPart } from "./types.ts";

// refList 안의 목록 요소 → 항목 요소. 검사기(`validate/resources.ts`)가 개수를 확인하는 목록과 같다.
const LIST_ITEMS = new Map([
  ["borderFills", "borderFill"],
  ["charProperties", "charPr"],
  ["tabProperties", "tabPr"],
  ["numberings", "numbering"],
  ["bullets", "bullet"],
  ["paraProperties", "paraPr"],
  ["styles", "style"],
  ["memoProperties", "memoPr"],
]);

/**
 * 자원 목록의 개수 속성(`itemCnt`, 글꼴 언어별 목록의 `fontCnt`, 글꼴 목록의 `itemCnt`)과 header의 구역 수 선언(`secCnt`)이
 * 실제 수와 다르면 실제 수로 고친다. 선언이 없거나 숫자가 아니면 건드리지 않는다.
 * 실제 구역 수는 검사기와 같이 `Contents/section*.xml` 항목 수다.
 */
export function planFixCounts(header: EntryDoc | null, sectionCount: number): PlanPart {
  const part = emptyPart();
  if (header === null) return part;
  const itemCnt: string[] = [];
  const fontCnt: string[] = [];

  const fix = (el: Parameters<typeof attrNode>[0], attrName: string, actual: number, label: string, sink: string[]): void => {
    const attr = attrNode(el, attrName);
    if (attr === undefined || !/^\d+$/.test(attr.value) || Number(attr.value) === actual) return;
    part.edits.push(attrEdit(header, attr, String(actual), `${label}의 ${attrName}을 실제 수로 고침`));
    sink.push(`${label} ${attr.value}→${actual}`);
  };

  const refList = [...walkElements(header.root)].find((e) => e.local === "refList");
  for (const grp of refList === undefined ? [] : elementChildren(refList)) {
    if (grp.local === "fontfaces") {
      const faces = elementChildren(grp).filter((c) => c.local === "fontface");
      fix(grp, "itemCnt", faces.length, "fontfaces", itemCnt);
      for (const face of faces) {
        fix(face, "fontCnt", elementChildren(face).filter((c) => c.local === "font").length, "fontface", fontCnt);
      }
      continue;
    }
    const itemTag = LIST_ITEMS.get(grp.local);
    if (itemTag === undefined) continue;
    fix(grp, "itemCnt", elementChildren(grp).filter((c) => c.local === itemTag).length, grp.local, itemCnt);
  }

  const secCnt: string[] = [];
  fix(header.root, "secCnt", sectionCount, "header", secCnt);

  const note = (what: string, list: string[]): void => {
    if (list.length === 0) return;
    const shown = list.slice(0, 5).join(", ");
    part.notes.push({
      kind: "fixCounts",
      entry: header.entry,
      what,
      count: list.length,
      detail: list.length > 5 ? `${shown} 외 ${list.length - 5}건` : shown,
    });
  };
  note("itemCnt", itemCnt);
  note("fontCnt", fontCnt);
  note("secCnt", secCnt);
  return part;
}
