import { makeIssue, type Issue } from "../errors.ts";
import { sha256Hex, type Anchor, type CellAnchor, type FieldAnchor, type LineAnchor, type LinePrint, type Template, type WordAnchor, type WordPrint } from "../template/index.ts";
import { toOriginal, type Hit } from "./doc.ts";
import type { TextTableCell, TextBlock, TextDoc } from "./types.ts";

// 앵커는 템플릿의 같은 `anchors` 형식이다. `at.path`는 `[블록 서수]` 하나이고 `sectionIndex`는 0뿐이다(문서는 구역이 하나다).

export const WORD_CONTEXT = 24;
export const LINE_PREFIX = 40;

/** `word` 앵커의 지문: 대상 글과 앞뒤 24자까지의 글(블록 논리 글 기준). */
export function wordPrintAt(text: string, start: number, end: number): WordPrint {
  return {
    text: text.slice(start, end),
    before: text.slice(Math.max(0, start - WORD_CONTEXT), start),
    after: text.slice(end, end + WORD_CONTEXT),
  };
}

/** `line` 앵커의 지문: 블록 논리 글 앞 40자와 전체의 sha256. */
export function linePrintOf(text: string): LinePrint {
  return { text: text.slice(0, LINE_PREFIX), sha256: sha256Hex(text) };
}

const samePrint = (a: WordPrint, b: WordPrint): boolean => a.text === b.text && a.before === b.before && a.after === b.after;

export type ResolvedAnchor =
  | { kind: "field"; hits: Hit[] }
  | { kind: "word"; block: TextBlock; start: number; end: number; relocated: boolean }
  | { kind: "line"; block: TextBlock; relocated: boolean }
  | { kind: "cell"; block: TextBlock; row: number; col: number; cell: TextTableCell }
  | { kind: "object"; block: TextBlock };

export type AnchorResolution = {
  /** 해석에 성공한 앵커(id → 해석). 실패한 앵커는 `issues`에 오류로 있다. */
  anchors: Map<string, ResolvedAnchor>;
  issues: Issue[];
};

/** `field` 앵커가 가리키는 `{{이름}}`들: 경로가 이름과 같은 것 전부(순번을 주면 그 순번의 것만). */
export function fieldHitsOf(hits: Hit[], anchor: FieldAnchor): Hit[] {
  const same = hits.filter((h) => h.path === anchor.name);
  if (anchor.occurrence === undefined) return same;
  const one = same[anchor.occurrence];
  return one === undefined ? [] : [one];
}

const noSection = (id: string, index: number): Issue => makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${id}: 구역 ${index}이(가) 없습니다(텍스트 문서는 구역 0 하나입니다).`, id);

function relocate<T>(id: string, found: T[], what: string, at: string, issues: Issue[]): T | undefined {
  if (found.length === 1) {
    issues.push(makeIssue("warning", "ANCHOR_RELOCATED", `앵커 ${id}: 주소 ${at}의 ${what}이(가) 지문과 달라 문서에서 지문으로 다시 찾았습니다.`, id));
    return found[0];
  }
  if (found.length === 0) {
    issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${id}: 주소 ${at}의 ${what}이(가) 지문과 다르고 문서에서도 찾지 못했습니다.`, id));
  } else {
    issues.push(makeIssue("error", "ANCHOR_AMBIGUOUS", `앵커 ${id}: 지문과 같은 ${what}이(가) 문서에 ${found.length}곳 있어 하나로 정할 수 없습니다.`, id));
  }
  return undefined;
}

/**
 * 템플릿의 앵커를 문서에서 찾는다. `only`가 있으면 그 id의 앵커만 해석한다(조건이 거짓인 규칙의 앵커는 찾지 않는다).
 * - `field`: 이름이 같은 `{{이름}}` 전부(순번을 주면 그것만). 없으면 `ANCHOR_NOT_FOUND`.
 * - `line`·`word`: 주소의 블록을 지문과 대조한다. 맞으면 그 자리, 아니면 문서에서 지문으로 다시 찾는다:
 *   유일하면 `ANCHOR_RELOCATED`(경고), 여럿이면 `ANCHOR_AMBIGUOUS`, 없으면 `ANCHOR_NOT_FOUND`(오류).
 * - `cell`·`object`: 서수로 찾는다. 범위 밖이면 `ANCHOR_NOT_FOUND`.
 *
 * `hits`는 문서 안 `{{경로}}` 전부(`scanPlaceholders`)다.
 */
export function resolveTextAnchors(doc: TextDoc, template: Template, only: ReadonlySet<string>, hits: Hit[]): AnchorResolution {
  const anchors = new Map<string, ResolvedAnchor>();
  const issues: Issue[] = [];
  const shaCache = new Map<number, string>();
  const shaOf = (b: TextBlock): string => {
    let sha = shaCache.get(b.index);
    if (sha === undefined) shaCache.set(b.index, (sha = sha256Hex(b.text)));
    return sha;
  };
  let tables: TextBlock[] | undefined;
  let codes: TextBlock[] | undefined;
  const addr = (path: number[]): string => `[${path.join(", ")}]`;
  const blockAt = (path: number[]): TextBlock | undefined => (path.length === 1 ? doc.blocks[path[0] ?? -1] : undefined);

  const resolveLine = (a: LineAnchor): ResolvedAnchor | undefined => {
    if (a.at.sectionIndex !== 0) return void issues.push(noSection(a.id, a.at.sectionIndex));
    const matches = (b: TextBlock): boolean => b.text.slice(0, LINE_PREFIX) === a.print.text && shaOf(b) === a.print.sha256;
    const block = blockAt(a.at.path);
    if (block !== undefined && matches(block)) return { kind: "line", block, relocated: false };
    const hit = relocate(a.id, doc.blocks.filter(matches), "블록", addr(a.at.path), issues);
    return hit === undefined ? undefined : { kind: "line", block: hit, relocated: true };
  };

  const resolveWord = (a: WordAnchor): ResolvedAnchor | undefined => {
    if (a.at.sectionIndex !== 0) return void issues.push(noSection(a.id, a.at.sectionIndex));
    const block = blockAt(a.at.path);
    if (block !== undefined && a.end <= block.text.length && samePrint(wordPrintAt(block.text, a.start, a.end), a.print)) {
      return { kind: "word", block, start: toOriginal(doc, block, a.start), end: toOriginal(doc, block, a.end), relocated: false };
    }
    const found: { block: TextBlock; start: number }[] = [];
    for (const b of doc.blocks) {
      for (let s = b.text.indexOf(a.print.text); s >= 0; s = b.text.indexOf(a.print.text, s + 1)) {
        if (samePrint(wordPrintAt(b.text, s, s + a.print.text.length), a.print)) found.push({ block: b, start: s });
      }
    }
    const hit = relocate(a.id, found, "글", addr(a.at.path), issues);
    return hit === undefined
      ? undefined
      : { kind: "word", block: hit.block, start: toOriginal(doc, hit.block, hit.start), end: toOriginal(doc, hit.block, hit.start + a.print.text.length), relocated: true };
  };

  const resolveCell = (a: CellAnchor): ResolvedAnchor | undefined => {
    if (a.table.sectionIndex !== 0) return void issues.push(noSection(a.id, a.table.sectionIndex));
    tables ??= doc.blocks.filter((b) => b.kind === "table");
    const block = tables[a.table.ordinal];
    const cell = block?.table?.rows[a.row]?.cells[a.col];
    if (block === undefined) return void issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: ${a.table.ordinal}번째 표가 없습니다.`, a.id));
    if (cell === undefined) return void issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: 표 ${a.table.ordinal}에 행 ${a.row}, 열 ${a.col} 칸이 없습니다.`, a.id));
    return { kind: "cell", block, row: a.row, col: a.col, cell };
  };

  const resolveObject = (a: Extract<Anchor, { kind: "object" }>): ResolvedAnchor | undefined => {
    if (a.sectionIndex !== 0) return void issues.push(noSection(a.id, a.sectionIndex));
    if (a.objectType !== "table" && a.objectType !== "code") {
      return void issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: 텍스트 문서의 objectType은 table·code뿐입니다(${a.objectType}).`, a.id));
    }
    tables ??= doc.blocks.filter((b) => b.kind === "table");
    codes ??= doc.blocks.filter((b) => b.kind === "code");
    const block = (a.objectType === "table" ? tables : codes)[a.ordinal];
    if (block === undefined) return void issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: ${a.ordinal}번째 ${a.objectType} 객체가 없습니다.`, a.id));
    return { kind: "object", block };
  };

  for (const a of template.anchors) {
    if (!only.has(a.id)) continue;
    let resolved: ResolvedAnchor | undefined;
    switch (a.kind) {
      case "field": {
        const found = fieldHitsOf(hits, a);
        if (found.length === 0) {
          issues.push(makeIssue("error", "ANCHOR_NOT_FOUND", `앵커 ${a.id}: 이름이 같은 {{${a.name}}}${a.occurrence === undefined ? "" : `(순번 ${a.occurrence})`}이 문서에 없습니다.`, a.id));
        } else {
          resolved = { kind: "field", hits: found };
        }
        break;
      }
      case "word":
        resolved = resolveWord(a);
        break;
      case "line":
        resolved = resolveLine(a);
        break;
      case "cell":
        resolved = resolveCell(a);
        break;
      case "object":
        resolved = resolveObject(a);
        break;
    }
    if (resolved !== undefined) anchors.set(a.id, resolved);
  }
  return { anchors, issues };
}
