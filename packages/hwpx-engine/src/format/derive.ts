import type { EditPlan } from "../edit/plan.ts";
import { HwpxError } from "../errors.ts";
import { findList, listEdits } from "../fragment/import.ts";
import { createFingerprinter, makeLookup } from "../fragment/resources.ts";
import { parseHeader } from "../model/header.ts";
import type { HwpxDocument, ResourceItem } from "../model/types.ts";
import { tokenize } from "../xml/tokenizer.ts";
import { attrNode, buildTree, childEl, type XElement } from "../xml/tree.ts";
import { applyOp, makeEditEnv, withId, type EditEnv } from "./tree-edit.ts";
import type { DeriveResult, FormatDelta, FormatKind } from "./types.ts";

const KINDS: readonly string[] = ["charPr", "paraPr", "borderFill"];

type Group = {
  /** 지문 → id 목록(문서 순서) */
  byFp: Map<string, string[]>;
  next: number;
  list: XElement;
  items: ResourceItem[];
  pending: string[];
};

/**
 * 서식 자원 파생기. 한 문서에 대해 여러 자원을 한꺼번에 파생할 때 쓴다: 새 id가 서로 겹치지 않고, 같은 모양은 한 자원으로 합쳐진다.
 * `finish()`가 새 자원들을 header 목록 끝에 추가하는 계획을 낸다.
 */
export type Deriver = {
  derive(kind: FormatKind, baseId: string, delta: FormatDelta): { id: string; reused: boolean };
  finish(): EditPlan;
};

export function createDeriver(doc: HwpxDocument): Deriver {
  const { header } = doc;
  const env: EditEnv = makeEditEnv(header.root);
  const lookup = makeLookup(doc);
  const fingerprint = createFingerprinter(lookup);
  const groups = new Map<string, Group>();
  let reusedCount = 0;

  const groupOf = (kind: FormatKind): Group => {
    let group = groups.get(kind);
    if (group !== undefined) return group;
    const list = findList(header, kind, undefined);
    if (list === undefined) throw new HwpxError("FMT_NO_LIST", `header에 ${kind} 목록이 없어 새 자원을 넣을 수 없습니다.`, doc.pkg.headerEntry);
    const items = (header.resources[kind] ?? []).filter((i) => attrNode(i.element, "id") !== undefined);
    const byFp = new Map<string, string[]>();
    let max = -1;
    for (const item of items) {
      const fp = fingerprint(item);
      const ids = byFp.get(fp);
      if (ids === undefined) byFp.set(fp, [item.id]);
      else ids.push(item.id);
      if (/^\d+$/.test(item.id) && Number(item.id) < 4294967295) max = Math.max(max, Number(item.id));
    }
    group = { byFp, next: max + 1, list, items, pending: [] };
    groups.set(kind, group);
    return group;
  };

  /** 파생한 원문을 읽어 지문을 구하기 위해, header의 목록 구조를 흉내 낸 작은 header를 만든다. */
  const parseDerived = (kind: FormatKind, group: Group, text: string): ResourceItem => {
    const refList = childEl(header.root, "head", "refList");
    const mini =
      `<${header.root.qname}${env.decls}>` +
      `<${refList?.qname ?? "refList"}><${group.list.qname}>${text}</${group.list.qname}></${refList?.qname ?? "refList"}>` +
      `</${header.root.qname}>`;
    const model = parseHeader(mini, buildTree(mini, tokenize(mini)));
    const item = model.resources[kind]?.[0];
    if (item === undefined) throw new HwpxError("FMT_PATH", `파생한 ${kind} 원문을 읽지 못했습니다.`);
    return item;
  };

  const derive: Deriver["derive"] = (kind, baseId, delta) => {
    if (!KINDS.includes(kind)) throw new HwpxError("FMT_KIND", `서식 종류 '${String(kind)}'은(는) 지원하지 않습니다(charPr, paraPr, borderFill).`);
    const group = groupOf(kind);
    const base = group.items.find((i) => i.id === baseId);
    if (base === undefined) {
      throw new HwpxError("FMT_BASE_NOT_FOUND", `기준 ${kind} ${baseId}이(가) header에 없습니다.`, doc.pkg.headerEntry);
    }
    const baseText = header.text.slice(base.element.start, base.element.end);
    let text = baseText;
    for (const op of delta) text = applyOp(text, env, op);
    if (text === baseText) {
      reusedCount++;
      return { id: baseId, reused: true };
    }
    const fp = fingerprint(parseDerived(kind, group, text));
    const known = group.byFp.get(fp);
    if (known !== undefined && known.length > 0) {
      reusedCount++;
      return { id: known.includes(baseId) ? baseId : (known[0] ?? baseId), reused: true };
    }
    const id = String(group.next++);
    group.byFp.set(fp, [id]);
    group.pending.push(withId(text, env, id));
    return { id, reused: false };
  };

  const finish = (): EditPlan => {
    const edits: EditPlan["edits"] = [];
    let added = 0;
    for (const [kind, group] of groups) {
      if (group.pending.length === 0) continue;
      added += group.pending.length;
      edits.push(...listEdits(header, doc.pkg.headerEntry, group.list, group.pending, `${kind} 자원 추가(서식 변경)`));
    }
    return { edits, additions: [], summary: { reusedResources: reusedCount, addedResources: added }, issues: [] };
  };

  return { derive, finish };
}

/**
 * 기준 자원을 복제해 `delta`만 적용한 자원을 구한다. 결과의 지문이 대상 문서의 기존 자원과 같으면 그 id를 돌려주고 계획은 비어 있다.
 * 다르면 새 id로 header 목록 끝에 추가하는 계획을 낸다. 같은 요청은 같은 id를 낸다. 기준 자원은 바뀌지 않는다.
 */
export function deriveResource(doc: HwpxDocument, kind: FormatKind, baseId: string, delta: FormatDelta): DeriveResult {
  const deriver = createDeriver(doc);
  const { id, reused } = deriver.derive(kind, baseId, delta);
  return { id, plan: deriver.finish(), reused };
}
