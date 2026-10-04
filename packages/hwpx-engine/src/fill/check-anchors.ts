import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import type { HwpxDocument } from "../model/types.ts";
import type { MergeFieldAnchor, StudioAnchor } from "../template/studio-types.ts";
import { TEMPLATE_SCHEMA, type Anchor, type CellAnchor, type LineAnchor, type ObjectAnchor, type WordAnchor } from "../template/types.ts";
import type { HeadingForm, HeadingRangeAnchor, RangeAnchor } from "./anchor-types.ts";
import { makeLineAnchor, makeWordAnchor, resolveAnchors, type ResolvedAnchor } from "./anchors.ts";
import { topLevelObjects } from "./doc.ts";
import type { DraftBlock } from "./draft.ts";
import { makeHeadingRangeAnchor } from "./heading.ts";
import { makeCellAnchor, makeObjectAnchor } from "./prints.ts";
import { makeRangeAnchor } from "./range.ts";

// 원본이 바뀐 뒤 템플릿 앵커의 상태표와 재지정(8.8.13). 앵커 해석은 `resolveAnchors`(8.3·7.10)를 그대로 쓴다.

export type AnchorCheckState = "exact" | "relocated" | "changed" | "ambiguous" | "notFound" | "unverified";

/**
 * 새 원본에서 찾은 앵커의 주소(앵커와 같은 필드 이름). `field`·`mergeField`는 이름·키가 곧 주소라 두지 않는다.
 * `headingRange`는 제목 문단 주소(`at`·`index`)에 그 자리에서 다시 센 꼴·단계(`marker`)와 다시 계산한 범위(`from`·`to`)를 더한다.
 */
export type AnchorAddress =
  | Pick<WordAnchor, "kind" | "at" | "start" | "end">
  | Pick<LineAnchor, "kind" | "at">
  | Pick<RangeAnchor, "kind" | "at" | "from" | "to">
  | (Pick<HeadingRangeAnchor, "kind" | "at" | "index" | "marker"> & { from: number; to: number })
  | Pick<CellAnchor, "kind" | "table" | "row" | "col">
  | Pick<ObjectAnchor, "kind" | "objectType" | "sectionIndex" | "ordinal">;

/**
 * 앵커 하나의 상태. `found`는 exact·relocated·unverified일 때 찾은 주소(relocated는 새 주소)다.
 * `issues`: relocated는 `ANCHOR_RELOCATED`, unverified는 `ANCHOR_UNVERIFIED`(경고), changed·ambiguous·notFound는
 * `ANCHOR_CHANGED`·`ANCHOR_AMBIGUOUS`·`ANCHOR_NOT_FOUND`(오류). 문서의 글은 담지 않는다.
 */
export type AnchorCheck = { anchor: string; kind: StudioAnchor["kind"]; state: AnchorCheckState; found?: AnchorAddress; issues: Issue[] };

/** 1판 앵커 꼴로 바꾼다: `mergeField`는 같은 뜻의 `field`(`mergeKey`)다. 나머지는 그대로(선택 `pattern`은 해석이 보지 않는다). */
function asV1(a: StudioAnchor): Anchor {
  if (a.kind !== "mergeField") return a;
  return { id: a.id, kind: "field", mergeKey: a.key, ...(a.occurrence === undefined ? {} : { occurrence: a.occurrence }) };
}

function addressOf(doc: HwpxDocument, a: StudioAnchor, r: ResolvedAnchor): AnchorAddress | undefined {
  switch (r.kind) {
    case "word":
      return a.kind === "word" ? { kind: "word", at: { sectionIndex: a.at.sectionIndex, path: [...r.paragraph.path] }, start: r.start, end: r.end } : undefined;
    case "line":
      return a.kind === "line" ? { kind: "line", at: { sectionIndex: a.at.sectionIndex, path: [...r.paragraph.path] } } : undefined;
    case "range":
      if (a.kind === "headingRange") {
        // 찾은 자리의 꼴·단계(앵커의 서열로 센다). 해석이 그 자리를 제목으로 찾았으므로 초안이 있다
        const marker = makeHeadingRangeAnchor(doc, a.at.sectionIndex, r.parentPath, r.from, a.order === undefined ? undefined : { order: a.order })?.marker ?? a.marker;
        return { kind: "headingRange", at: { sectionIndex: a.at.sectionIndex, parentPath: [...r.parentPath] }, index: r.from, marker, from: r.from, to: r.to };
      }
      return a.kind === "range" ? { kind: "range", at: { sectionIndex: a.at.sectionIndex, parentPath: [...r.parentPath] }, from: r.from, to: r.to } : undefined;
    case "cell": {
      if (a.kind !== "cell") return undefined;
      const ordinal = topLevelObjects(r.section, "tbl").findIndex((x) => x.object === r.table);
      return { kind: "cell", table: { sectionIndex: a.table.sectionIndex, ordinal }, row: r.cell.row, col: r.cell.col };
    }
    case "object": {
      if (a.kind !== "object") return undefined;
      const ordinal = topLevelObjects(r.section, a.objectType).findIndex((x) => x.object === r.object);
      return { kind: "object", objectType: a.objectType, sectionIndex: a.sectionIndex, ordinal };
    }
    case "field":
      return undefined;
  }
}

const STATE_OF_ERROR: Readonly<Record<string, AnchorCheckState>> = { ANCHOR_CHANGED: "changed", ANCHOR_AMBIGUOUS: "ambiguous", ANCHOR_NOT_FOUND: "notFound" };

/**
 * 템플릿(1판 `Template`이나 2판 `StudioTemplate`. `anchors`만 본다)의 앵커마다 새 원본 `doc`에서의 상태를 템플릿 순서대로 돌려준다(8.8.13).
 * - `field`·`mergeField`: 이름·키(+순번)로 찾으므로 exact 또는 notFound.
 * - `word`·`line`·`range`, 지문(`print`)이 있는 `cell`·`object`: 주소의 지문이 맞으면 exact, 같은 구역에서 지문이 한 곳이면 relocated,
 *   여러 곳이면 ambiguous, 없으면 notFound. `range`는 양 끝만 찾고 안쪽이 다르면 changed(7.10).
 * - `headingRange`: 제목 지문·꼴로 같은 판정을 하고, 제목은 찾았는데 다시 계산한 범위의 지문이 다르면 changed(7.10).
 * - 지문이 없는 `cell`·`object`(1판 승계): 서수의 자리가 있으면 unverified(`ANCHOR_UNVERIFIED` 경고), 없으면 notFound.
 * 앵커 id는 템플릿 안에서 유일해야 한다(`readTemplate`·`readStudioTemplate`가 검사한다).
 */
export function checkAnchors(doc: HwpxDocument, t: { readonly anchors: readonly StudioAnchor[] }): AnchorCheck[] {
  const resolution = resolveAnchors(doc, { schema: TEMPLATE_SCHEMA, anchors: t.anchors.map(asV1), rules: [], options: {} });
  return t.anchors.map((a): AnchorCheck => {
    const issues = resolution.issues.filter((i) => i.where === a.id);
    const error = issues.find((i) => i.severity === "error");
    if (error !== undefined) return { anchor: a.id, kind: a.kind, state: STATE_OF_ERROR[error.code] ?? "notFound", issues };
    const resolved = resolution.anchors.get(a.id);
    const found = resolved === undefined ? undefined : addressOf(doc, a, resolved);
    const base = { anchor: a.id, kind: a.kind, ...(found === undefined ? {} : { found }) };
    if (issues.some((i) => i.code === "ANCHOR_RELOCATED")) return { ...base, state: "relocated", issues };
    if ((a.kind === "cell" || a.kind === "object") && a.print === undefined) {
      const what = a.kind === "cell" ? `표 ${a.table.ordinal}의 행 ${a.row}, 열 ${a.col} 셀` : `${a.ordinal}번째 ${a.objectType} 객체`;
      const warning = makeIssue("warning", "ANCHOR_UNVERIFIED", `앵커 ${a.id}: 지문이 없는 ${a.kind} 앵커(1판)라 서수로만 ${what}을(를) 찾았습니다. 원본이 같을 때만 쓸 수 있습니다.`, a.id);
      return { ...base, state: "unverified", issues: [...issues, warning] };
    }
    return { ...base, state: "exact", issues };
  });
}

/**
 * `checkAnchors`의 상태표로 일괄 갱신할 새 앵커 배열을 만든다(8.8.13 흐름 3). 앵커마다 exact·relocated·unverified일 때만 되고,
 * changed·ambiguous·notFound(또는 상태가 없는 앵커)가 하나라도 있으면 undefined다.
 * relocated 앵커는 같은 id·`pattern`·지문에 새 주소를 넣는다(relocated는 지문이 모두 같은 자리라 지문은 그대로다. `headingRange`는 `at`·`index`와 새 자리에서 다시 센 `marker`를 넣는다). 나머지는 복사본이다.
 * unverified 앵커는 지문을 만들지 않고 그대로 둔다(서수가 맞는지는 사용자가 확인한다). 템플릿 저장과 `source.sha256` 갱신은 호출자 몫이다.
 */
export function planRelocation<A extends StudioAnchor>(t: { readonly anchors: readonly A[] }, checks: readonly AnchorCheck[]): { anchors: A[]; changed: string[] } | undefined {
  const byId = new Map(checks.map((c) => [c.anchor, c]));
  const anchors: A[] = [];
  const changed: string[] = [];
  for (const a of t.anchors) {
    const c = byId.get(a.id);
    if (c === undefined || c.kind !== a.kind) return undefined;
    if (c.state === "relocated" && c.found !== undefined) {
      const found = c.found;
      anchors.push(structuredClone(found.kind === "headingRange" ? { ...a, at: found.at, index: found.index, marker: found.marker } : { ...a, ...found }));
      changed.push(a.id);
    } else if (c.state === "exact" || c.state === "unverified") {
      anchors.push(structuredClone(a));
    } else {
      return undefined;
    }
  }
  return { anchors, changed };
}

type DraftOf<T> = T extends unknown ? Omit<T, "id"> : never;

/** 재지정에 쓰는 초안: `draftAnchors`의 초안(`blocked` 포함), `makeRangeAnchor`·`makeHeadingRangeAnchor`·`makeCellAnchor`·`makeObjectAnchor`의 초안, id 없는 `mergeField`. */
export type RedraftInput = DraftOf<StudioAnchor> & { blocked?: DraftBlock };

const addressMissing = (what: string): HwpxError => new HwpxError("FILL_DRAFT_ADDRESS", `${what}이(가) 문서에 없습니다.`);

/** 제목 문단 주소의 `headingRange` 앵커(단계는 `order`, 없으면 기본 서열로 센다). 문단이 없거나 제목이 아니면 `FILL_DRAFT_ADDRESS`. */
function headingAnchorOf(doc: HwpxDocument, id: string, sectionIndex: number, parentPath: number[], index: number, order: HeadingForm[] | undefined): StudioAnchor {
  const made = makeHeadingRangeAnchor(doc, sectionIndex, parentPath, index, order === undefined ? undefined : { order });
  if (made === undefined) throw addressMissing(`구역 ${sectionIndex}·상위 [${parentPath.join(", ")}]의 제목 문단 ${index}(문단이 없거나 제목이 아닙니다)`);
  return { id, ...made };
}

/** 초안을 `doc`에 대어 그 종류의 필드만 가진 앵커를 만든다. 문서에서 뜨는 지문(word·line·range·headingRange·cell·object)은 `doc`에서 다시 뜬다. 주소가 없으면 `FILL_DRAFT_ADDRESS`. */
function anchorOf(doc: HwpxDocument, id: string, d: DraftOf<StudioAnchor>): StudioAnchor {
  const occurrence = (o: number | undefined) => (o === undefined ? {} : { occurrence: o });
  switch (d.kind) {
    case "field":
      return { id, kind: "field", ...(d.mergeKey !== undefined ? { mergeKey: d.mergeKey } : d.name !== undefined ? { name: d.name } : {}), ...occurrence(d.occurrence) };
    case "mergeField":
      return { id, kind: "mergeField", key: d.key, ...occurrence(d.occurrence) };
    case "word": {
      const made = makeWordAnchor(doc, id, d.at.sectionIndex, d.at.path, d.start, d.end);
      if (made === undefined) throw addressMissing(`구역 ${d.at.sectionIndex}의 문단 [${d.at.path.join(", ")}]의 글 구간 ${d.start}~${d.end}`);
      return made;
    }
    case "line": {
      const made = makeLineAnchor(doc, id, d.at.sectionIndex, d.at.path);
      if (made === undefined) throw addressMissing(`구역 ${d.at.sectionIndex}의 문단 [${d.at.path.join(", ")}]`);
      return made;
    }
    case "range": {
      const made = makeRangeAnchor(doc, d.at.sectionIndex, d.at.parentPath, d.from, d.to);
      if (made === undefined) throw addressMissing(`구역 ${d.at.sectionIndex}·상위 [${d.at.parentPath.join(", ")}]의 문단 ${d.from}~${d.to}`);
      return { id, ...made };
    }
    case "headingRange":
      return headingAnchorOf(doc, id, d.at.sectionIndex, d.at.parentPath, d.index, d.order);
    case "cell": {
      const made = makeCellAnchor(doc, d.table.sectionIndex, d.table.ordinal, d.row, d.col);
      if (made === undefined) throw addressMissing(`구역 ${d.table.sectionIndex}의 표 ${d.table.ordinal}의 행 ${d.row}, 열 ${d.col} 셀`);
      return { id, ...made };
    }
    case "object": {
      const made = makeObjectAnchor(doc, d.objectType, d.sectionIndex, d.ordinal);
      if (made === undefined) throw addressMissing(`구역 ${d.sectionIndex}의 ${d.ordinal}번째 ${d.objectType} 객체`);
      return { id, ...made };
    }
  }
}

/**
 * 새 원본에서 다시 지정한 초안을 옛 앵커 자리에 넣는다(8.8.13 흐름 4). 결과 앵커의 `id`와 `pattern`은 옛 앵커의 것이다
 * (초안의 `id`·`pattern`·`blocked`와 그 종류에 없는 키는 버린다. 옛 앵커에 `pattern`이 없으면 키를 두지 않는다).
 * 주소를 `doc`에 대어 보고 지문을 다시 뜬다(`makeWordAnchor`·`makeLineAnchor`·`makeRangeAnchor`·`makeCellAnchor`·`makeObjectAnchor`.
 * `draftAnchors`의 cell 초안에는 지문이 없다). 옛 앵커가 `mergeField`이고 초안이 키로 가리키는 `field`이면 `mergeField`로 적는다.
 * 옛 앵커가 `headingRange`이고 초안이 `line`(제목 문단 클릭)이면 그 문단을 제목으로 하는 `headingRange`로 적는다(옛 앵커의 `order`로 센다.
 * 그 문단이 제목이 아니면 `FILL_DRAFT_ADDRESS`). `headingRange` 초안은 초안의 `order`로 다시 뜬다.
 * 종류가 옛 앵커와 달라도 받고 `kindChanged`가 true다. `anchor`는 그대로 템플릿의 `anchors[]`에 넣을 수 있다.
 * 초안의 주소(문단, word의 글 구간, 범위, 제목 문단, 셀, 객체)가 `doc`에 없으면 `FILL_DRAFT_ADDRESS`.
 */
export function redraftAnchor(doc: HwpxDocument, old: StudioAnchor, draft: RedraftInput): { anchor: StudioAnchor; kindChanged: boolean } {
  const next: DraftOf<StudioAnchor> =
    old.kind === "mergeField" && draft.kind === "field" && draft.mergeKey !== undefined
      ? ({ kind: "mergeField", key: draft.mergeKey, ...(draft.occurrence === undefined ? {} : { occurrence: draft.occurrence }) } satisfies Omit<MergeFieldAnchor, "id">)
      : draft;
  const made =
    old.kind === "headingRange" && next.kind === "line"
      ? headingAnchorOf(doc, old.id, next.at.sectionIndex, next.at.path.slice(0, -1), next.at.path[next.at.path.length - 1] ?? -1, old.order)
      : anchorOf(doc, old.id, next);
  const anchor: StudioAnchor = old.pattern === undefined ? made : { ...made, pattern: old.pattern };
  return { anchor, kindChanged: anchor.kind !== old.kind };
}
