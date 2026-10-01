import { makeIssue } from "../errors.ts";
import { escapeAttr } from "../xml/chars.ts";
import type { XAttr } from "../xml/tokenizer.ts";
import { attrValue, elementChildren, walkElements } from "../xml/tree.ts";
import { attrEdit, attrLocal, isNsDecl, HEADER_ENTRY, type EntryDoc } from "./entries.ts";
import { emptyPart, type PlanPart } from "./types.ts";

/** "참조 없음"을 뜻하는 관례값 */
const NONE_VALUES = new Set(["4294967295", "-1"]);

// 서식 자원을 가리키는 속성 → 대상 자원 공간. 이진 자료(binaryItemIDRef 등)와 메모 모양은 서식이 아니므로 돌리지 않는다.
const REF_ATTRS = new Map([
  ["charPrIDRef", "charPr"],
  ["paraPrIDRef", "paraPr"],
  ["styleIDRef", "style"],
  ["nextStyleIDRef", "style"],
  ["borderFillIDRef", "borderFill"],
  ["tabPrIDRef", "tabPr"],
  ["numberingIDRef", "numbering"],
  ["outlineShapeIDRef", "numbering"],
]);

const FONT_LANGS: [string, string][] = [
  ["hangul", "HANGUL"],
  ["latin", "LATIN"],
  ["hanja", "HANJA"],
  ["japanese", "JAPANESE"],
  ["other", "OTHER"],
  ["symbol", "SYMBOL"],
  ["user", "USER"],
];

const LIST_OF = new Map([
  ["borderFills", "borderFill"],
  ["charProperties", "charPr"],
  ["tabProperties", "tabPr"],
  ["numberings", "numbering"],
  ["bullets", "bullet"],
  ["paraProperties", "paraPr"],
  ["styles", "style"],
]);

type Spaces = {
  /** 자원 공간 → id(목록 순서). id가 없는 항목은 뺀다. */
  ids: Map<string, string[]>;
  /** 글꼴 언어 → id */
  fonts: Map<string, string[]>;
};

/** header의 refList에서 자원 공간별 id 목록을 모은다(검사기의 `collectResources`와 같은 규칙). */
function collectSpaces(header: EntryDoc): Spaces {
  const out: Spaces = { ids: new Map(), fonts: new Map() };
  for (const space of LIST_OF.values()) out.ids.set(space, []);
  const refList = [...walkElements(header.root)].find((e) => e.local === "refList");
  for (const grp of refList === undefined ? [] : elementChildren(refList)) {
    if (grp.local === "fontfaces") {
      for (const face of elementChildren(grp)) {
        const lang = attrValue(face, "lang") ?? "";
        const list = out.fonts.get(lang) ?? [];
        out.fonts.set(lang, list);
        for (const f of elementChildren(face)) {
          const id = attrValue(f, "id");
          if (id !== undefined) list.push(id);
        }
      }
      continue;
    }
    const space = LIST_OF.get(grp.local);
    if (space === undefined) continue;
    const list = out.ids.get(space) ?? [];
    for (const it of elementChildren(grp)) {
      const id = attrValue(it, "id");
      if (it.local === space && id !== undefined) list.push(id);
    }
  }
  return out;
}

/** 돌려 보낼 기본 자원의 id. 스타일은 목록의 첫 스타일, 그 밖은 숫자 id가 가장 작은 것. 없으면 undefined. */
function defaultId(space: string, ids: string[]): string | undefined {
  if (space === "style") return ids[0];
  let best: string | undefined;
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue;
    if (best === undefined || Number(id) < Number(best)) best = id;
  }
  return best;
}

type Found = { doc: EntryDoc; attr: XAttr; space: string; label: string };

/** 검사기가 `RES_DANGLING` 오류로 내는 서식 참조를 찾는다(한컴이 받아 주는 경고 분류 세 가지는 뺀다). */
function findDangling(docs: EntryDoc[], spaces: Spaces): Found[] {
  const found: Found[] = [];
  const has = (space: string, id: string): boolean => spaces.ids.get(space)?.includes(id) ?? false;
  const tabPrEmpty = (spaces.ids.get("tabPr")?.length ?? 0) === 0;
  for (const doc of docs) {
    const isHeader = doc.entry === HEADER_ENTRY;
    for (const el of walkElements(doc.root)) {
      for (const a of el.attrs) {
        if (isNsDecl(a.qname)) continue;
        const an = attrLocal(a.qname);
        const space = REF_ATTRS.get(an);
        if (space === undefined) continue;
        const v = a.value;
        if (NONE_VALUES.has(v) || v === "" || has(space, v)) continue;
        if (an === "outlineShapeIDRef" && v === "0") continue;
        if (an === "tabPrIDRef" && v === "0" && tabPrEmpty) continue;
        if (el.local === "pageBorderFill" && an === "borderFillIDRef" && v === "0") continue;
        found.push({ doc, attr: a, space, label: an });
      }
      if (!isHeader) continue;
      if (el.local === "heading") {
        const type = attrValue(el, "type");
        const a = el.attrs.find((x) => x.qname === "idRef");
        if (a === undefined || NONE_VALUES.has(a.value)) continue;
        if (type === "OUTLINE" && a.value === "0") continue;
        if ((type === "OUTLINE" || type === "NUMBER") && !has("numbering", a.value)) {
          found.push({ doc, attr: a, space: "numbering", label: "heading idRef" });
        } else if (type === "BULLET" && !has("bullet", a.value)) {
          found.push({ doc, attr: a, space: "bullet", label: "heading idRef" });
        }
      }
      if (el.local === "fontRef") {
        for (const [name, lang] of FONT_LANGS) {
          const a = el.attrs.find((x) => x.qname === name);
          if (a !== undefined && !(spaces.fonts.get(lang)?.includes(a.value) ?? false)) {
            found.push({ doc, attr: a, space: `font:${lang}`, label: "fontRef" });
          }
        }
      }
    }
  }
  return found;
}

/**
 * 없는 서식을 가리키는 참조를 같은 종류의 기본 자원으로 돌린다(스타일은 목록의 첫 스타일, 그 밖은 숫자 id가 가장 작은 것).
 * 문서의 모양이 바뀔 수 있다. 목록이 비어 있어 돌릴 곳이 없으면 고치지 않고 경고로 알린다.
 */
export function planFallbackRefs(header: EntryDoc | null, sections: EntryDoc[]): PlanPart {
  const part = emptyPart();
  if (header === null) return part;
  const spaces = collectSpaces(header);
  const fixed = new Map<string, { entry: string; label: string; to: string; count: number }>();
  const nothing = new Map<string, number>();
  for (const f of findDangling([header, ...sections], spaces)) {
    const ids = f.space.startsWith("font:") ? (spaces.fonts.get(f.space.slice(5)) ?? []) : (spaces.ids.get(f.space) ?? []);
    const to = defaultId(f.space.startsWith("font:") ? "font" : f.space, ids);
    if (to === undefined) {
      nothing.set(f.space, (nothing.get(f.space) ?? 0) + 1);
      continue;
    }
    part.edits.push(attrEdit(f.doc, f.attr, escapeAttr(to), `없는 ${f.label} 참조를 기본 자원으로 돌림`));
    const key = `${f.doc.entry}\u0000${f.label}\u0000${f.space}`;
    const rec = fixed.get(key) ?? { entry: f.doc.entry, label: f.label, to, count: 0 };
    rec.count++;
    fixed.set(key, rec);
  }
  for (const rec of fixed.values()) {
    part.notes.push({ kind: "fallbackRefs", entry: rec.entry, what: rec.label, count: rec.count, detail: `기본 자원 id ${rec.to}로 돌림` });
  }
  for (const [space, count] of nothing) {
    part.issues.push(
      makeIssue("warning", "REPAIR_NO_DEFAULT", `${space.replace("font:", "글꼴 ")} 목록이 비어 있어 없는 참조 ${count}건을 돌릴 곳이 없습니다.`),
    );
  }
  return part;
}
