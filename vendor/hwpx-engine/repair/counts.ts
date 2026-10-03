import { attrNode, subElements, walkElements, type XElement } from "../xml/tree.ts";
import { attrEdit, type EntryDoc } from "./entries.ts";
import { emptyPart, type PlanPart, type RepairKind } from "./types.ts";

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

/** 개수를 담은 속성이 숫자이고 실제 수와 다르면 실제 수로 고치는 편집을 더하고 `sink`에 `이름 선언→실제`를 적는다. */
function fix(header: EntryDoc, part: PlanPart, el: XElement, attrName: string, actual: number, label: string, sink: string[]): void {
  const attr = attrNode(el, attrName);
  if (attr === undefined || !/^\d+$/.test(attr.value) || Number(attr.value) === actual) return;
  part.edits.push(attrEdit(header, attr, String(actual), `${label}의 ${attrName}을 실제 수로 고침`));
  sink.push(`${label} ${attr.value}→${actual}`);
}

function note(header: EntryDoc, part: PlanPart, kind: RepairKind, what: string, list: string[]): void {
  if (list.length === 0) return;
  const shown = list.slice(0, 5).join(", ");
  part.notes.push({
    kind,
    entry: header.entry,
    what,
    count: list.length,
    detail: list.length > 5 ? `${shown} 외 ${list.length - 5}건` : shown,
  });
}

/**
 * 자원 목록의 개수 속성(`itemCnt`, 글꼴 언어별 목록의 `fontCnt`, 글꼴 목록의 `itemCnt`)이 실제 수와 다르면 실제 수로 고친다.
 * 선언이 없거나 숫자가 아니면 건드리지 않는다. 구역 수 선언(`secCnt`)은 보이는 내용을 바꿀 수 있어 `planFixSectionCount`가 따로 다룬다.
 */
export function planFixCounts(header: EntryDoc | null): PlanPart {
  const part = emptyPart();
  if (header === null) return part;
  const itemCnt: string[] = [];
  const fontCnt: string[] = [];

  const refList = [...walkElements(header.root)].find((e) => e.local === "refList");
  for (const grp of refList === undefined ? [] : subElements(refList)) {
    if (grp.local === "fontfaces") {
      const faces = subElements(grp).filter((c) => c.local === "fontface");
      fix(header, part, grp, "itemCnt", faces.length, "fontfaces", itemCnt);
      for (const face of faces) {
        fix(header, part, face, "fontCnt", subElements(face).filter((c) => c.local === "font").length, "fontface", fontCnt);
      }
      continue;
    }
    const itemTag = LIST_ITEMS.get(grp.local);
    if (itemTag === undefined) continue;
    fix(header, part, grp, "itemCnt", subElements(grp).filter((c) => c.local === itemTag).length, grp.local, itemCnt);
  }

  note(header, part, "fixCounts", "itemCnt", itemCnt);
  note(header, part, "fixCounts", "fontCnt", fontCnt);
  return part;
}

/**
 * header의 구역 수 선언(`secCnt`)이 실제 구역 수와 다르면 실제 수로 고친다. 선언이 없거나 숫자가 아니면 건드리지 않는다.
 * 실제 구역 수는 검사기와 같이 `Contents/section*.xml` 항목 수다. 한컴은 선언한 수만큼만 구역을 보여 주므로 이 보정은 보이는 내용을 바꾼다.
 */
export function planFixSectionCount(header: EntryDoc | null, sectionCount: number): PlanPart {
  const part = emptyPart();
  if (header === null) return part;
  const secCnt: string[] = [];
  fix(header, part, header.root, "secCnt", sectionCount, "header", secCnt);
  note(header, part, "fixSectionCount", "secCnt", secCnt);
  return part;
}
