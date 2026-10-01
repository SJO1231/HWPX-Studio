import { makeIssue, type Issue } from "../errors.ts";
import type { HwpxPackage } from "../package/open.ts";
import { walkElements, type XElement } from "../xml/tree.ts";
import type { BodyRef, BodyRefKind, HeaderModel, SectionModel } from "./types.ts";

const BODY_REF_KINDS = new Map<string, BodyRefKind>([
  ["charPrIDRef", "charPr"],
  ["paraPrIDRef", "paraPr"],
  ["styleIDRef", "style"],
  ["borderFillIDRef", "borderFill"],
  ["binaryItemIDRef", "binaryItem"],
  ["outlineShapeIDRef", "numbering"],
]);

// 이름은 IDRef로 끝나지만 자원이 아니라 누름틀 짝(FieldMark)을 가리키는 속성
const FIELD_PAIR_ATTRS = new Set(["beginIDRef"]);

/** 요소와 그 후손 전체에서 자원을 가리키는 속성을 모은다. */
export function collectBodyRefs(element: XElement): BodyRef[] {
  const refs: BodyRef[] = [];
  for (const el of walkElements(element)) {
    for (const attr of el.attrs) {
      const kind = BODY_REF_KINDS.get(attr.qname);
      if (kind !== undefined) {
        refs.push({ kind, id: attr.value, element: el, attr });
      } else if (attr.qname.endsWith("IDRef") && !FIELD_PAIR_ATTRS.has(attr.qname)) {
        refs.push({ kind: "unknown", id: attr.value, element: el, attr });
      }
    }
  }
  return refs;
}

type Tally = { count: number; message: (count: number) => string };

function tally(map: Map<string, Tally>, key: string, message: (count: number) => string): void {
  const t = map.get(key);
  if (t === undefined) map.set(key, { count: 1, message });
  else t.count++;
}

function targetKey(kind: string, lang: string | undefined): string {
  return kind === "font" ? `font:${lang ?? ""}` : kind;
}

/**
 * 모든 BodyRef와 ResourceRef의 대상이 있는지 모아서 Issue로 돌려준다.
 * 같은 파일에서 같은 대상을 가리키는 참조는 한 Issue로 묶는다.
 */
export function checkReferences(pkg: HwpxPackage, header: HeaderModel, sections: SectionModel[]): Issue[] {
  const targets = new Map<string, Set<string>>();
  for (const items of Object.values(header.resources)) {
    for (const item of items) {
      const key = targetKey(item.kind, item.lang);
      let ids = targets.get(key);
      if (ids === undefined) targets.set(key, (ids = new Set()));
      ids.add(item.id);
    }
  }
  targets.set("binaryItem", new Set(pkg.manifestItems.map((m) => m.id)));
  const exists = (kind: string, lang: string | undefined, id: string): boolean =>
    targets.get(targetKey(kind, lang))?.has(id) ?? false;

  const issues: Issue[] = [];
  const missing = new Map<string, Tally>();
  const unknown = new Map<string, Tally>();

  for (const items of Object.values(header.resources)) {
    for (const item of items) {
      for (const ref of item.refs) {
        if (exists(ref.kind, ref.lang, ref.id)) continue;
        const label = ref.lang === undefined ? `${ref.kind} ${ref.id}` : `${ref.kind}(${ref.lang}) ${ref.id}`;
        tally(missing, `${pkg.headerEntry}\u0000${label}`, (n) => `${label}이(가) 없는데 ${n}곳에서 가리킵니다(예: ${item.kind} ${item.id}).`);
      }
    }
  }
  for (const sec of sections) {
    for (const ref of sec.bodyRefs) {
      if (ref.kind === "unknown") {
        const name = ref.attr.qname;
        tally(unknown, `${sec.entryName}\u0000${name}`, (n) => `자원 참조로 해석하지 못한 ${name} 속성이 ${n}곳 있습니다.`);
      } else if (!exists(ref.kind, undefined, ref.id)) {
        const label = `${ref.kind} ${ref.id}`;
        tally(missing, `${sec.entryName}\u0000${label}`, (n) => `${label}이(가) 없는데 ${n}곳에서 가리킵니다.`);
      }
    }
  }
  for (const [key, t] of missing) {
    issues.push(makeIssue("error", "MODEL_REF_MISSING", t.message(t.count), key.slice(0, key.indexOf("\u0000"))));
  }
  for (const [key, t] of unknown) {
    issues.push(makeIssue("warning", "MODEL_UNKNOWN_REF", t.message(t.count), key.slice(0, key.indexOf("\u0000"))));
  }
  return issues;
}
