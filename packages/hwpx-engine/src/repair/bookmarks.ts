import { attrNode, attrValue, walkElements } from "../xml/tree.ts";
import { spanEdit, type EntryDoc } from "./entries.ts";
import { emptyPart, type PlanPart } from "./types.ts";

type Named = { doc: EntryDoc; name: string; end: number };

/**
 * 책갈피 이름이 겹치면 문서 순서에서 뒤의 것에 `_1`, `_2` …를 붙인다. 이미 있는 이름과 겹치지 않는 가장 작은 번호를 쓴다.
 * 책갈피는 `bookmark` 요소와 `type="BOOKMARK"`인 `fieldBegin`이다(검사기와 같다). 이름이 빈 책갈피는 건드리지 않는다.
 * 이름 원문은 그대로 두고 속성값 끝에 접미사만 끼워 넣는다.
 */
export function planRenameBookmarks(sections: EntryDoc[]): PlanPart {
  const part = emptyPart();
  const named: Named[] = [];
  for (const doc of sections) {
    for (const el of walkElements(doc.root)) {
      const attr = attrNode(el, "name");
      if (attr === undefined || attr.value === "") continue;
      const isBookmark =
        el.local === "bookmark" || (el.local === "fieldBegin" && (attrValue(el, "type") ?? "").toUpperCase() === "BOOKMARK");
      if (isBookmark) named.push({ doc, name: attr.value, end: attr.valueEnd });
    }
  }

  const taken = new Set(named.map((n) => n.name));
  const seen = new Set<string>();
  const perEntry = new Map<string, number>();
  for (const n of named) {
    if (!seen.has(n.name)) {
      seen.add(n.name);
      continue;
    }
    let k = 1;
    while (taken.has(`${n.name}_${k}`)) k++;
    taken.add(`${n.name}_${k}`);
    part.edits.push(spanEdit(n.doc, n.end, n.end, `_${k}`, "중복 책갈피 이름에 접미사"));
    perEntry.set(n.doc.entry, (perEntry.get(n.doc.entry) ?? 0) + 1);
  }
  for (const [entry, count] of perEntry) {
    part.notes.push({ kind: "renameBookmarks", entry, what: "bookmark name", count, detail: `이름 뒤에 _번호 접미사를 붙인 책갈피 ${count}개` });
  }
  return part;
}
