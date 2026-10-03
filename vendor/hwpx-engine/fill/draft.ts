import { HwpxError } from "../errors.ts";
import { clusterBoundaries } from "../model/clusters.ts";
import { isTableNode } from "../model/paragraph.ts";
import type { HwpxDocument, ParagraphNode, TableNode } from "../model/types.ts";
import { linePrintOf, wordPrintAt } from "./anchors.ts";
import type { AnchorDraft } from "./candidates.ts";
import { paragraphAtPath, topLevelObjects } from "./doc.ts";
import { collectFields } from "./fields.ts";

/** 앵커 초안을 요청하는 자리. `start`·`end`는 문단 논리 텍스트의 UTF-16 오프셋이다. */
export type DraftRequest = { sectionIndex: number; path: number[]; start?: number; end?: number };

const isSpace = (cp: number): boolean => /\s/u.test(String.fromCodePoint(cp));

/**
 * 글자 단위(UTF-16 오프셋)로 낱말 경계 표시를 만든다: 공백 글자이거나, 폭이 있는 경계 조각(탭·줄바꿈 같은 인라인 요소, 객체 자리 글자)에 속한 글자.
 * `boundaryPiece`는 그 가운데 경계 조각에 속한 글자만 표시한다.
 */
function delimiters(paragraph: ParagraphNode): { delim: boolean[]; boundaryPiece: boolean[] } {
  const text = paragraph.logicalText;
  const delim: boolean[] = new Array<boolean>(text.length).fill(false);
  const boundaryPiece: boolean[] = new Array<boolean>(text.length).fill(false);
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    if (isSpace(cp)) for (let k = 0; k < width; k++) delim[i + k] = true;
    i += width;
  }
  for (const piece of paragraph.pieces) {
    if ((piece.kind === "inline" || piece.kind === "object") && piece.logicalEnd > piece.logicalStart) {
      for (let i = piece.logicalStart; i < piece.logicalEnd; i++) {
        delim[i] = true;
        boundaryPiece[i] = true;
      }
    }
  }
  return { delim, boundaryPiece };
}

function floorBoundary(clusters: Set<number>, at: number): number {
  let i = at;
  while (i > 0 && !clusters.has(i)) i--;
  return i;
}

function ceilBoundary(clusters: Set<number>, at: number, max: number): number {
  let i = at;
  while (i < max && !clusters.has(i)) i++;
  return i;
}

/** 요청한 자리의 `word` 앵커 초안의 구간. 만들 수 없으면 undefined. */
function wordRange(paragraph: ParagraphNode, start: number | undefined, end: number | undefined): { start: number; end: number } | undefined {
  if (start === undefined) return undefined;
  const text = paragraph.logicalText;
  const clusters = clusterBoundaries(paragraph);
  const { delim, boundaryPiece } = delimiters(paragraph);

  if (end !== undefined && end > start) {
    // 범위: 글자 묶음 경계로 넓힌다. 경계 조각(객체 자리·탭·줄바꿈 등)을 포함하면 만들지 않는다.
    const s = floorBoundary(clusters, start);
    const e = ceilBoundary(clusters, end, text.length);
    for (let i = s; i < e; i++) if (boundaryPiece[i] === true) return undefined;
    return { start: s, end: e };
  }

  // 낱말: 시작 글자를 포함한 공백으로 나뉜 덩어리. 그 글자가 공백·경계 조각이면 바로 앞 글자로 본다(낱말 끝에 커서가 놓인 경우).
  let at = start;
  if (at >= text.length || delim[at] === true) at = start - 1;
  if (at < 0 || at >= text.length || delim[at] === true) return undefined;
  let s = at;
  while (s > 0 && delim[s - 1] !== true) s--;
  let e = at + 1;
  while (e < text.length && delim[e] !== true) e++;
  s = floorBoundary(clusters, s);
  e = ceilBoundary(clusters, e, text.length);
  for (let i = s; i < e; i++) if (boundaryPiece[i] === true) return undefined;
  return { start: s, end: e };
}

/**
 * 문단의 한 자리(또는 한 범위)를 가리키는 앵커 초안을 후보 순서대로 돌려준다. 템플릿의 `anchors`에 `id`만 더해 그대로 넣을 수 있다.
 *
 * 1. 그 자리가 누름틀 안이면 `field`(이름과 같은 이름 안 순번). 값을 채울 수 있는 모양(`simple`·`empty`)만, 안쪽 누름틀부터.
 * 2. `start`·`end`가 있으면 그 범위의 `word`, `start`만 있으면 그 글자를 포함한 낱말(공백으로 나뉜 덩어리)의 `word`. `print`(대상 글, 앞뒤 문맥)를 채운다.
 *    범위가 글자 묶음(grapheme cluster)을 가르면 묶음 경계로 넓힌다. 객체 자리·탭·줄바꿈 같은 경계 조각을 포함하는 `word`는 만들지 않는다.
 * 3. 문단의 `line`(글 앞 40자와 글 전체 해시).
 * 4. 문단이 구역 최상위 표의 셀 문단(`path`가 `[문단, 하위목록, 문단]`)이면 `cell`(구역 안 표 서수, 행, 열).
 *
 * 주소(구역·문단)가 없거나 `start`·`end`가 문단 글 밖이면 `FILL_DRAFT_ADDRESS`, `end`만 있거나 `end < start`이면 `FILL_DRAFT_RANGE` 오류다.
 */
export function draftAnchors(doc: HwpxDocument, request: DraftRequest): AnchorDraft[] {
  const { sectionIndex, path, start, end } = request;
  const section = doc.sections[sectionIndex];
  const paragraph = section === undefined ? undefined : paragraphAtPath(section, path);
  if (section === undefined || paragraph === undefined) {
    throw new HwpxError("FILL_DRAFT_ADDRESS", `구역 ${sectionIndex}의 문단 [${path.join(", ")}]이(가) 없습니다.`);
  }
  const length = paragraph.logicalText.length;
  const bad = (v: number | undefined): boolean => v !== undefined && (!Number.isInteger(v) || v < 0 || v > length);
  if (bad(start) || bad(end)) {
    throw new HwpxError("FILL_DRAFT_ADDRESS", `구간 [${start ?? ""}, ${end ?? ""}]이(가) 문단 글(길이 ${length}) 밖입니다.`);
  }
  if ((start === undefined && end !== undefined) || (start !== undefined && end !== undefined && end < start)) {
    throw new HwpxError("FILL_DRAFT_RANGE", "end만 있거나 end가 start보다 앞입니다.");
  }

  const at = { sectionIndex, path: [...path] };
  const out: AnchorDraft[] = [];

  // 1. 누름틀
  if (start !== undefined) {
    const to = end ?? start;
    const inside = collectFields(doc)
      .filter((t) => t.paragraph === paragraph && t.end !== null && (t.info.shape === "simple" || t.info.shape === "empty"))
      .map((t) => ({ t, from: paragraph.pieces[t.begin.pieceIndex]?.logicalEnd ?? 0, until: paragraph.pieces[t.end?.pieceIndex ?? 0]?.logicalStart ?? 0 }))
      .filter((f) => f.from <= start && to <= f.until)
      .sort((a, b) => b.from - a.from || a.until - b.until);
    for (const f of inside) out.push({ kind: "field", name: f.t.info.name, occurrence: f.t.info.occurrence });
  }

  // 2. 낱말·범위
  const range = wordRange(paragraph, start, end);
  if (range !== undefined) out.push({ kind: "word", at, start: range.start, end: range.end, print: wordPrintAt(paragraph.logicalText, range.start, range.end) });

  // 3. 문단
  out.push({ kind: "line", at, print: linePrintOf(paragraph.logicalText) });

  // 4. 구역 최상위 표의 셀
  if (path.length === 3) {
    const owner = section.paragraphs[path[0] ?? -1];
    const sub = owner?.subLists[path[1] ?? -1];
    const table = sub === undefined ? undefined : owner?.objects.find((o): o is TableNode => isTableNode(o) && o.cells.some((c) => c.subList === sub));
    if (table !== undefined) {
      const cell = table.cells.find((c) => c.subList === sub);
      const ordinal = topLevelObjects(section, "tbl").findIndex((x) => x.object === table);
      if (cell !== undefined && ordinal >= 0) out.push({ kind: "cell", table: { sectionIndex, ordinal }, row: cell.row, col: cell.col });
    }
  }
  return out;
}
