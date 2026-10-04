import { createFingerprinter, makeLookup } from "../fragment/resources.ts";
import { isTableNode } from "../model/paragraph.ts";
import type { HwpxDocument, ParagraphNode, ResourceItem, SectionModel, TableCell } from "../model/types.ts";
import type { PATTERN_MATCH, PATTERN_PLACES, StudioAnchor, TemplatePattern } from "../template/studio-types.ts";
import type { CellAnchor, LineAnchor, WordAnchor } from "../template/types.ts";
import { attrValue, childEl } from "../xml/tree.ts";
import type { HeadingMarker } from "./anchor-types.ts";
import { linePrintOf, wordPrintAt } from "./anchors.ts";
import { isLabelColon, labelCellRight } from "./candidates.ts";
import { paragraphAtPath, topLevelObjects } from "./doc.ts";
import { firstLook, firstTextCharPr, headingMarkersIn, makeHeadingRangeAnchor, type HeadingOptions, type HeadingRangeDraft } from "./heading.ts";
import { makeCellAnchor } from "./prints.ts";
import { listAtParent, paragraphHash } from "./range.ts";

// 패턴과 같은 유형 일괄 제안(7.10 패턴, #20). 패턴은 앵커를 만들지 않고, 제안은 저장하지 않는다(확인한 제안만 호출자가 앵커로 넣는다).

/** 패턴: 2판 템플릿 `patterns[]`의 형(`TemplatePattern`) 그대로다. */
export type Pattern = TemplatePattern;
export type PatternMatchKey = (typeof PATTERN_MATCH)[number];
export type PatternPlace = (typeof PATTERN_PLACES)[number];

/** 제안의 앵커 초안(id 없음): 제목 범위, 문단, 라벨 뒤 빈 곳, 칸 */
export type SuggestionDraft = HeadingRangeDraft | Omit<LineAnchor, "id"> | Omit<WordAnchor, "id"> | Omit<CellAnchor, "id">;

/** 제안 하나: 맞은 문단의 주소, 글 앞 40자, 글 해시(`rejected`에 넣는 값), 앵커 초안 */
export type Suggestion = { at: { sectionIndex: number; path: number[] }; text: string; sha256: string; draft: SuggestionDraft };

/**
 * `order`: 단계를 세는 서열(`patternOf`와 같게 준다). `exclude`: 이미 템플릿 `anchors[]`에 든 앵커(가리키는 문단·범위·칸을 뺀다).
 * `origin`: 패턴을 만든 문단의 주소(뺀다. 그 문단이 든 칸의 `cell` 초안도 뺀다).
 */
export type SuggestOptions = HeadingOptions & { exclude?: readonly StudioAnchor[]; origin?: { sectionIndex: number; path: number[] } };

/** 글 원문은 앞 40자만 담는다(`line` 지문과 같다). */
const PRINT_TEXT = 40;
/** 기본으로 켠 판정 항목(`marker`는 끌 수 없다) */
const DEFAULT_MATCH: readonly PatternMatchKey[] = ["marker", "bold", "height"];
/** 제목으로 탐지되지 않는 문단(과 라벨 자리의 번호 글자 없는 문단)의 꼴·단계. 제목의 단계(1부터)와 겹치지 않는다. */
const NOT_HEADING: HeadingMarker = { form: "none", level: 0 };
/** `라벨:`의 쌍점(그 뒤는 공백뿐) */
const COLON_TAIL = /[:：]\s*$/u;

// ── 모양 ──────────────────────────────────────────────────────

type ParaLook = { print?: string; align?: string };
type Looks = { char(id: string): string | undefined; para(id: string): ParaLook };
const looksCache = new WeakMap<HwpxDocument, Looks>();

/** 글자모양 지문(7.4)과 문단모양 지문·정렬(`align`의 `horizontal`). 처음 물을 때 계산해 둔다. */
function looksOf(doc: HwpxDocument): Looks {
  const cached = looksCache.get(doc);
  if (cached !== undefined) return cached;
  const fingerprint = createFingerprinter(makeLookup(doc));
  const byId = (kind: string): Map<string, ResourceItem> => {
    const map = new Map<string, ResourceItem>();
    for (const item of doc.header.resources[kind] ?? []) if (!map.has(item.id)) map.set(item.id, item);
    return map;
  };
  const chars = byId("charPr");
  const paras = byId("paraPr");
  const charPrints = new Map<string, string | undefined>();
  const paraLooks = new Map<string, ParaLook>();
  const looks: Looks = {
    char(id) {
      if (!charPrints.has(id)) {
        const item = chars.get(id);
        charPrints.set(id, item === undefined ? undefined : fingerprint(item));
      }
      return charPrints.get(id);
    },
    para(id) {
      let look = paraLooks.get(id);
      if (look === undefined) {
        const item = paras.get(id);
        const alignEl = item === undefined ? undefined : childEl(item.element, "head", "align");
        const align = alignEl === undefined ? undefined : attrValue(alignEl, "horizontal");
        look = item === undefined ? {} : { print: fingerprint(item), ...(align === undefined ? {} : { align }) };
        paraLooks.set(id, look);
      }
      return look;
    },
  };
  looksCache.set(doc, looks);
  return looks;
}

/** 문단의 판정 항목 값: 굵기·크기·글자모양 지문은 공백 아닌 첫 글 run에서, 문단모양 지문·정렬은 문단에서 */
type Look = { bold: boolean; height?: number; print?: string; paraPrint?: string; align?: string };

function lookOf(doc: HwpxDocument, p: ParagraphNode): Look {
  const looks = looksOf(doc);
  const { bold, height } = firstLook(doc, p);
  const charId = firstTextCharPr(p);
  const print = charId === undefined ? undefined : looks.char(charId);
  const para = p.attrs.paraPrIDRef === null ? {} : looks.para(p.attrs.paraPrIDRef);
  return {
    bold,
    ...(height === undefined ? {} : { height }),
    ...(print === undefined ? {} : { print }),
    ...(para.print === undefined ? {} : { paraPrint: para.print }),
    ...(para.align === undefined ? {} : { align: para.align }),
  };
}

// ── 자리 ──────────────────────────────────────────────────────

/**
 * 문단 목록의 자리: 표 칸이면 그 칸, 초안이 가리킬 칸(`target`: 라벨 셀이면 8.3 규칙의 오른쪽 값 칸, 아니면 그 칸), 표 서수(구역 최상위 표가 아니면 -1).
 * 표 칸이 아닌 목록(최상위·머리말·글상자 등)은 본문이다.
 */
type ListPlace = { place: "body" } | { place: "cell" | "labelCell"; cell: TableCell; target: TableCell; ordinal: number };

function listPlace(section: SectionModel, parentPath: readonly number[]): ListPlace {
  if (parentPath.length === 0) return { place: "body" };
  const owner = paragraphAtPath(section, parentPath.slice(0, -1));
  const sub = owner?.subLists[parentPath[parentPath.length - 1] ?? -1];
  for (const o of owner?.objects ?? []) {
    if (!isTableNode(o)) continue;
    const cell = o.cells.find((c) => c.subList === sub);
    if (cell === undefined) continue;
    const ordinal = parentPath.length === 2 ? topLevelObjects(section, "tbl").findIndex((x) => x.object === o) : -1;
    const right = labelCellRight(o, cell);
    return right === undefined ? { place: "cell", cell, target: cell, ordinal } : { place: "labelCell", cell, target: right, ordinal };
  }
  return { place: "body" };
}

/** 문단의 자리: 라벨 셀이면 `labelCell`, 아니고 글이 `라벨:` 꼴이면 `labelColon`, 아니면 목록의 자리(`body`·`cell`) */
const placeOf = (ctx: ListPlace, p: ParagraphNode): PatternPlace => (ctx.place !== "labelCell" && isLabelColon(p) ? "labelColon" : ctx.place);

/**
 * 판정에 쓰는 꼴·단계: 제목이면 그 꼴·단계, 제목이 아니면 `{ none, 0 }`. 라벨 자리(`labelColon`·`labelCell`)에서 번호 글자 없는 문단은
 * 굵고 짧아 `none` 제목으로 탐지되더라도 `{ none, 0 }`으로 본다(라벨은 목록마다 다른 단계로 갈리지 않게 한다).
 */
const markerFor = (m: HeadingMarker | undefined, place: PatternPlace): HeadingMarker =>
  m === undefined || (m.form === "none" && (place === "labelColon" || place === "labelCell")) ? NOT_HEADING : m;

// ── 패턴 ──────────────────────────────────────────────────────

const isIndex = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * 문단 하나(`at`은 `line` 앵커의 주소꼴)에서 패턴을 만든다. 문단이 없으면 undefined.
 * `marker`는 `detectHeadings`와 같은 판독·단계(같은 부모 안 서열, `opts.order`)이고, 제목으로 탐지되지 않는 문단은 `{ form: "none", level: 0 }`이다
 * (라벨 자리에서 번호 글자 없는 문단도 `{ none, 0 }`. `markerFor`).
 * `char`(굵기·크기·글자모양 지문)는 공백 아닌 첫 글 run에서, `para`(문단모양 지문·정렬)는 문단에서 읽는다. 값이 없는 항목(글이 없는 문단의 크기 등)은 키를 두지 않는다.
 * `place`: 표 칸 안이고 그 칸이 라벨 셀이면 `labelCell`, 글이 `라벨:` 꼴이면 `labelColon`, 그 밖의 표 칸이면 `cell`, 표 칸이 아니면 `body`.
 * `match`는 기본(`marker`·`bold`·`height`. `print`·`paraPrint`·`align`은 끔), `id`·`name`은 빈 글이고 `rejected`는 두지 않는다(호출자가 채운다).
 */
export function patternOf(doc: HwpxDocument, at: { sectionIndex: number; path: number[] }, opts?: HeadingOptions): Pattern | undefined {
  const section = isIndex(at.sectionIndex) ? doc.sections[at.sectionIndex] : undefined;
  const p = section === undefined ? undefined : paragraphAtPath(section, at.path);
  const parentPath = at.path.slice(0, -1);
  const list = section === undefined ? undefined : listAtParent(section, parentPath);
  if (section === undefined || p === undefined || list === undefined) return undefined;
  const place = placeOf(listPlace(section, parentPath), p);
  const marker = markerFor(headingMarkersIn(doc, list, opts)[at.path[at.path.length - 1] ?? -1], place);
  const look = lookOf(doc, p);
  return {
    id: "",
    name: "",
    marker: { ...marker },
    char: { bold: look.bold, ...(look.height === undefined ? {} : { height: look.height }), ...(look.print === undefined ? {} : { print: look.print }) },
    para: { ...(look.paraPrint === undefined ? {} : { print: look.paraPrint }), ...(look.align === undefined ? {} : { align: look.align }) },
    place,
    match: [...DEFAULT_MATCH],
  };
}

// ── 제안 ──────────────────────────────────────────────────────

const keyOf = (sectionIndex: number, path: readonly number[]): string => `${sectionIndex}|${path.join(",")}`;

/** `exclude` 앵커가 가리키는 문단(range·headingRange는 범위의 문단 전부, line·word는 그 문단, cell은 그 칸의 문단)과 칸. 주소는 앵커에 적힌 것을 쓴다. */
function excludedOf(doc: HwpxDocument, anchors: readonly StudioAnchor[]): { paragraphs: Set<string>; cells: Set<TableCell> } {
  const paragraphs = new Set<string>();
  const cells = new Set<TableCell>();
  const span = (sectionIndex: number, parentPath: readonly number[], from: number, to: number): void => {
    for (let i = from; i <= to; i++) paragraphs.add(keyOf(sectionIndex, [...parentPath, i]));
  };
  for (const a of anchors) {
    if (a.kind === "line" || a.kind === "word") paragraphs.add(keyOf(a.at.sectionIndex, a.at.path));
    else if (a.kind === "range") span(a.at.sectionIndex, a.at.parentPath, a.from, a.to);
    else if (a.kind === "headingRange") span(a.at.sectionIndex, a.at.parentPath, a.index, a.index + a.print.count - 1);
    else if (a.kind === "cell") {
      const section = doc.sections[a.table.sectionIndex];
      const table = section === undefined ? undefined : topLevelObjects(section, "tbl")[a.table.ordinal]?.object;
      const cell = table !== undefined && isTableNode(table) ? table.cells.find((c) => c.row === a.row && c.col === a.col) : undefined;
      if (cell === undefined) continue;
      cells.add(cell);
      for (const p of cell.subList?.paragraphs ?? []) paragraphs.add(keyOf(a.table.sectionIndex, p.path));
    }
  }
  return { paragraphs, cells };
}

/** 패턴의 켠 항목이 모두 같은가(`marker`는 늘 본다) */
function matches(pattern: Pattern, on: ReadonlySet<string>, marker: HeadingMarker, look: () => Look): boolean {
  if (marker.form !== pattern.marker.form || marker.level !== pattern.marker.level) return false;
  if (![...on].some((k) => k !== "marker")) return true;
  const l = look();
  return (
    (!on.has("bold") || l.bold === (pattern.char?.bold ?? false)) &&
    (!on.has("height") || l.height === pattern.char?.height) &&
    (!on.has("print") || l.print === pattern.char?.print) &&
    (!on.has("paraPrint") || l.paraPrint === pattern.para?.print) &&
    (!on.has("align") || l.align === pattern.para?.align)
  );
}

/** `라벨:` 문단의 쌍점 뒤 빈 곳(공백)의 `word` 초안. 쌍점 뒤에 글자가 없으면 `line` 초안. */
function labelColonDraft(sectionIndex: number, p: ParagraphNode): SuggestionDraft {
  const text = p.logicalText;
  const start = (COLON_TAIL.exec(text)?.index ?? text.length) + 1;
  const at = { sectionIndex, path: [...p.path] };
  return start < text.length ? { kind: "word", at, start, end: text.length, print: wordPrintAt(text, start, text.length) } : { kind: "line", at, print: linePrintOf(text) };
}

/**
 * 패턴과 같은 유형의 문단을 같은 `place`에서 찾아 문서 순서로 제안한다(결정적. 문서 순서는 문단 뒤에 그 문단의 하위 목록).
 * 판정: `marker`(꼴·단계 모두. 단계는 `opts.order`로 센다)는 늘, 그 밖은 `match`에 켠 항목만(`bold`·`height`·`align`은 같은 값, `print`·`paraPrint`는 지문 일치).
 * 초안: `body`는 `headingRange`(`makeHeadingRangeAnchor`. 제목으로 탐지되지 않는 문단은 `line`). `cell`은 그 칸, `labelCell`은 라벨의 오른쪽 값 칸
 * (8.3 `emptyCell` 후보와 같은 칸)을 가리키며, 구역 최상위 표면 `cell`(지문 포함. 초안이 칸을 가리키는 경우(최상위 표의 칸, 중첩 표의 라벨 셀)는 한 칸에서 여러 문단이 맞아도 문서 순서로 첫 문단 하나만 제안한다),
 * 중첩 표면 `line`(`cell`은 맞은 문단, `labelCell`은 값 칸의 첫 문단). `labelColon`은 쌍점 뒤 빈 곳의 `word`(쌍점 뒤에 글자가 없으면 `line`).
 * 빼는 것: `opts.origin` 문단(과 그 문단이 든 칸의 `cell` 초안), `opts.exclude` 앵커가 가리키는 문단·범위·칸(라벨 셀은 초안이 가리키는 값 칸으로 본다),
 * `pattern.rejected`의 글 해시와 같은 글의 문단.
 */
export function suggestSimilar(doc: HwpxDocument, pattern: Pattern, opts?: SuggestOptions): Suggestion[] {
  const on = new Set<string>(pattern.match);
  const rejected = new Set((pattern.rejected ?? []).map((r) => r.sha256));
  const excluded = excludedOf(doc, opts?.exclude ?? []);
  const origin = opts?.origin === undefined ? undefined : keyOf(opts.origin.sectionIndex, opts.origin.path);
  const originList = opts?.origin === undefined ? undefined : keyOf(opts.origin.sectionIndex, opts.origin.path.slice(0, -1));
  const seenCells = new Set<TableCell>();
  const out: Suggestion[] = [];

  const walk = (section: SectionModel, list: readonly ParagraphNode[], parentPath: number[]): void => {
    const ctx = listPlace(section, parentPath);
    const markers = headingMarkersIn(doc, list, opts);
    const listKey = keyOf(section.index, parentPath);
    list.forEach((p, i) => {
      const place = placeOf(ctx, p);
      if (place === pattern.place && matches(pattern, on, markerFor(markers[i], place), () => lookOf(doc, p))) {
        const key = keyOf(section.index, p.path);
        /** 초안이 칸을 가리키는 제안(최상위 표의 칸, 중첩 표의 라벨 셀): 칸마다 하나만 낸다 */
        const perCell = ctx.place === "body" || pattern.place === "labelColon" || (ctx.ordinal < 0 && ctx.place !== "labelCell") ? undefined : ctx;
        const asCell = perCell !== undefined && perCell.ordinal >= 0;
        /** 중첩 표의 라벨 셀: 값 칸의 첫 문단을 가리키는 `line` 초안 */
        const valueLine = perCell !== undefined && !asCell ? perCell.target.subList?.paragraphs[0] : undefined;
        const first = perCell === undefined || !seenCells.has(perCell.cell);
        if (perCell !== undefined) seenCells.add(perCell.cell);
        const skip =
          !first ||
          key === origin ||
          excluded.paragraphs.has(key) ||
          rejected.has(paragraphHash(p)) ||
          (valueLine !== undefined && excluded.paragraphs.has(keyOf(section.index, valueLine.path))) ||
          (perCell !== undefined && (listKey === originList || excluded.cells.has(perCell.target)));
        if (!skip) {
          const at = { sectionIndex: section.index, path: [...p.path] };
          let draft: SuggestionDraft | undefined;
          if (pattern.place === "labelColon") draft = labelColonDraft(section.index, p);
          else if (pattern.place === "body") draft = makeHeadingRangeAnchor(doc, section.index, parentPath, i, opts?.order === undefined ? undefined : { order: opts.order });
          else if (asCell) draft = makeCellAnchor(doc, section.index, perCell.ordinal, perCell.target.row, perCell.target.col);
          else if (valueLine !== undefined) draft = { kind: "line", at: { sectionIndex: section.index, path: [...valueLine.path] }, print: linePrintOf(valueLine.logicalText) };
          out.push({ at, text: p.logicalText.slice(0, PRINT_TEXT), sha256: paragraphHash(p), draft: draft ?? { kind: "line", at, print: linePrintOf(p.logicalText) } });
        }
      }
      p.subLists.forEach((sub, k) => walk(section, sub.paragraphs, [...p.path, k]));
    });
  };
  for (const s of doc.sections) walk(s, s.paragraphs, []);
  return out;
}

/** 제안 하나를 해제한 새 패턴: `rejected`에 그 제안의 `{ text, sha256 }`을 더한다(같은 해시가 이미 있으면 더하지 않는다). 입력은 바꾸지 않는다. */
export function rejectSuggestion(pattern: Pattern, suggestion: Pick<Suggestion, "text" | "sha256">): Pattern {
  const next = structuredClone(pattern);
  const rejected = next.rejected ?? [];
  if (!rejected.some((r) => r.sha256 === suggestion.sha256)) rejected.push({ text: suggestion.text, sha256: suggestion.sha256 });
  return { ...next, rejected };
}
