import { makeIssue } from "../errors.ts";
import type { XAttr } from "../xml/tokenizer.ts";
import { attrNode, walkElements, type XElement } from "../xml/tree.ts";
import { attrEdit, attrLocal, isNsDecl, type EntryDoc } from "./entries.ts";
import { emptyPart, type PlanPart } from "./types.ts";

// 검사기(`validate/structure.ts`)가 객체로 보아 id를 세는 요소. 검사기와 같은 목록이어야 보정이 검사 결과와 맞는다.
const OBJECT_TAGS = new Set([
  "tbl", "pic", "ole", "container", "equation", "rect", "ellipse", "arc", "polygon", "curve", "line", "connectLine",
  "textart", "video", "chart", "compose", "dutmal", "btn", "radioBtn", "checkBtn", "comboBox", "edit", "listBox", "scrollBar",
]);
/** 한컴이 여러 문단에 같은 값을 쓰는 자리값. 검사기도 이 값의 문단 id 중복은 오류로 세지 않는다. */
const PLACEHOLDER_PARA_IDS = new Set(["", "0", "2147483648", "4294967295"]);
/** 새 id의 시작을 정할 때 세지 않는 값의 하한. 자리값(2147483648, 4294967295)이 큰 수로 끼는 문서가 있다. */
const ID_CEILING = 2 ** 31;

type Space = "paragraph" | "object" | "inst" | "field";
const LABEL: Record<Space, string> = { paragraph: "paragraph id", object: "object id", inst: "instId", field: "field id" };

type Occurrence = { space: Space; value: string; attr: XAttr; doc: EntryDoc };
type FieldEnd = { attr: XAttr; doc: EntryDoc };

/** instId는 대소문자 표기가 문서마다 달라 대소문자를 가리지 않고 찾는다(검사기와 같다). */
function instAttr(el: XElement): XAttr | undefined {
  return el.attrs.find((a) => !isNsDecl(a.qname) && attrLocal(a.qname).toLowerCase() === "instid");
}

/**
 * 객체 id·instId·누름틀 시작 id 중복과 자리값이 아닌 문단 id 중복을 고친다.
 * 문서 순서(구역 번호 순서, 구역 안은 문서 순서)에서 첫 등장은 두고 뒤의 것에 새 값(문서 숫자 id 최댓값 + 1부터)을 준다.
 * 누름틀은 짝인 끝의 `beginIDRef`를 함께 바꾼다. 시작·끝 짝을 정할 수 없는 중복은 건드리지 않는다.
 * 객체·instId가 `0`으로 겹치는 경우는 `all`일 때만 고친다.
 */
export function planReissueIds(sections: EntryDoc[], mode: true | "all"): PlanPart {
  const part = emptyPart();
  const occurrences: Occurrence[] = [];
  const beginIndex = new Map<XAttr, Occurrence>();
  type Event = { kind: "begin"; occ: Occurrence } | { kind: "end"; ref: string; end: FieldEnd };
  const events: Event[] = [];

  for (const doc of sections) {
    for (const el of walkElements(doc.root)) {
      const tag = el.local;
      const add = (space: Space, attr: XAttr | undefined, allowEmpty: boolean): Occurrence | undefined => {
        if (attr === undefined || (!allowEmpty && attr.value === "")) return undefined;
        const occ: Occurrence = { space, value: attr.value, attr, doc };
        occurrences.push(occ);
        return occ;
      };
      if (tag === "p") add("paragraph", attrNode(el, "id"), true);
      if (OBJECT_TAGS.has(tag)) add("object", attrNode(el, "id"), false);
      add("inst", instAttr(el), false);
      if (tag === "fieldBegin") {
        const occ = add("field", attrNode(el, "id"), false);
        if (occ !== undefined) {
          beginIndex.set(occ.attr, occ);
          events.push({ kind: "begin", occ });
        }
      } else if (tag === "fieldEnd") {
        const attr = attrNode(el, "beginIDRef");
        if (attr !== undefined) events.push({ kind: "end", ref: attr.value, end: { attr, doc } });
      }
    }
  }

  // 누름틀 시작·끝 짝: 같은 id를 가진 열린 시작을 쌓아 두고 끝이 나오면 가장 안쪽(나중에 연) 시작과 맺는다.
  const open = new Map<string, Occurrence[]>();
  const endOf = new Map<Occurrence, FieldEnd>();
  const unpaired = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "begin") {
      const stack = open.get(ev.occ.value);
      if (stack === undefined) open.set(ev.occ.value, [ev.occ]);
      else stack.push(ev.occ);
    } else {
      const begin = open.get(ev.ref)?.pop();
      if (begin === undefined) unpaired.add(ev.ref);
      else endOf.set(begin, ev.end);
    }
  }
  for (const [value, stack] of open) if (stack.length > 0) unpaired.add(value);

  // 새 id의 출발점: 문서의 숫자 id 최댓값 + 1. 이미 쓰인 값은 건너뛴다.
  const used = new Set<string>();
  let max = 0;
  for (const occ of occurrences) {
    used.add(occ.value);
    if (/^\d+$/.test(occ.value)) {
      const n = Number(occ.value);
      if (n < ID_CEILING && n > max) max = n;
    }
  }
  let counter = max;
  const nextId = (): string => {
    do {
      counter++;
    } while (used.has(String(counter)));
    const id = String(counter);
    used.add(id);
    return id;
  };

  const seen = new Set<string>();
  const done = new Map<string, { count: number; changes: string[] }>();
  let skippedFields = 0;
  for (const occ of occurrences) {
    const key = `${occ.space}\u0000${occ.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    if (occ.space === "paragraph" && PLACEHOLDER_PARA_IDS.has(occ.value)) continue;
    if ((occ.space === "object" || occ.space === "inst") && occ.value === "0" && mode !== "all") continue;
    const end = occ.space === "field" ? endOf.get(occ) : undefined;
    if (occ.space === "field" && (end === undefined || unpaired.has(occ.value))) {
      skippedFields++;
      continue;
    }
    const next = nextId();
    part.edits.push(attrEdit(occ.doc, occ.attr, next, `중복 ${LABEL[occ.space]} 재발급`));
    if (end !== undefined) part.edits.push(attrEdit(end.doc, end.attr, next, "재발급한 누름틀 시작 id에 맞춰 끝의 beginIDRef 변경"));
    const group = `${occ.doc.entry}\u0000${occ.space}`;
    const rec = done.get(group) ?? { count: 0, changes: [] };
    rec.count++;
    rec.changes.push(`${occ.value}→${next}`);
    done.set(group, rec);
  }

  for (const [group, rec] of done) {
    const [entry = "", space = ""] = group.split("\u0000");
    const shown = rec.changes.slice(0, 5).join(", ");
    part.notes.push({
      kind: "reissueIds",
      entry,
      what: LABEL[space as Space],
      count: rec.count,
      detail: rec.changes.length > 5 ? `${shown} 외 ${rec.changes.length - 5}건` : shown,
    });
  }
  if (skippedFields > 0) {
    part.issues.push(
      makeIssue("warning", "REPAIR_FIELD_PAIR", `중복된 누름틀 시작 id ${skippedFields}건은 시작·끝 짝을 정할 수 없어 고치지 않았습니다.`),
    );
  }
  return part;
}
