import { findPlaceholders } from "../template/index.ts";
import type { TextBlock, TextCensus, TextDoc } from "./types.ts";

/** 블록 논리 글의 오프셋을 원문 오프셋으로 바꾼다(논리 글은 줄바꿈을 `\n` 한 글자로 센다). */
export function toOriginal(doc: TextDoc, block: TextBlock, off: number): number {
  if (block.firstLine === block.lastLine) return block.start + off;
  let rest = off;
  for (let i = block.firstLine; i <= block.lastLine; i++) {
    const line = doc.lines[i];
    if (line === undefined) break;
    const len = line.end - line.start;
    if (rest <= len) return line.start + rest;
    rest -= len + 1;
  }
  return block.end;
}

/** 새 줄바꿈이 따를 방식: 그 줄의 줄바꿈, 없으면(마지막 줄) 앞쪽의 가장 가까운 것, 문서에 하나도 없으면 `\n`. */
export function eolNear(doc: TextDoc, lineIndex: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    const eol = doc.lines[i]?.eol;
    if (eol !== undefined && eol !== "") return eol;
  }
  for (let i = lineIndex + 1; i < doc.lines.length; i++) {
    const eol = doc.lines[i]?.eol;
    if (eol !== undefined && eol !== "") return eol;
  }
  return "\n";
}

/**
 * 블록 `index` 옆에 새 블록을 넣을 때 블록 사이에 둘 구분(줄바꿈과 빈 줄). 이웃 구분의 방식을 따른다.
 * txt는 줄바꿈 하나, md는 빈 줄을 둔 줄바꿈 둘 이상이다(빈 줄 없이 붙으면 한 덩어리로 합쳐지므로 둘로 늘린다).
 */
export function separatorNear(doc: TextDoc, index: number): string {
  const { blocks, source } = doc;
  const here = blocks[index];
  const next = blocks[index + 1];
  const prev = blocks[index - 1];
  const raw = here === undefined ? "" : next !== undefined ? source.slice(here.end, next.start) : prev !== undefined ? source.slice(prev.end, here.start) : "";
  const eols = raw.match(/\r\n|\n/g) ?? [];
  const eol = eols[0] ?? eolNear(doc, here?.lastLine ?? 0);
  if (doc.kind === "txt") return eol;
  return eols.length >= 2 ? eols.join("") : eol + eol;
}

/** 표 칸에 넣을 값: `|`는 `\|`로 쓴다. `|` 앞의 백슬래시 줄은 짝을 맞추려고 두 배로 쓴다(`\|`라는 글이 칸을 가르지 않게). */
export const escapeCell = (value: string): string => value.replace(/(\\*)\|/g, (_m, slashes: string) => `${slashes}${slashes}\\|`);

export type Hit = {
  block: TextBlock;
  /** 원문 구간 `[start, end)`(여는 `{{`부터 닫는 `}}` 끝까지) */
  start: number;
  end: number;
  path: string;
};

/** 블록 하나의 `{{경로}}` 표기를 원문 좌표로 찾는다. */
export function placeholdersOf(doc: TextDoc, block: TextBlock): Hit[] {
  if (!block.text.includes("{{")) return [];
  return findPlaceholders(block.text).map((p) => ({
    block,
    start: toOriginal(doc, block, p.start),
    end: toOriginal(doc, block, p.end),
    path: p.path,
  }));
}

/** 문서 안 `{{경로}}`를 문서 순서로 모두 찾는다. 코드 블록 안의 것은 `fillInCode`일 때만 센다. */
export function scanPlaceholders(doc: TextDoc, fillInCode: boolean): Hit[] {
  const hits: Hit[] = [];
  for (const block of doc.blocks) {
    if (block.kind === "code" && !fillInCode) continue;
    hits.push(...placeholdersOf(doc, block));
  }
  return hits;
}

export function censusOf(doc: TextDoc): TextCensus {
  const census: TextCensus = { blocks: doc.blocks.length, tables: 0, code: 0, tableRows: 0 };
  for (const b of doc.blocks) {
    if (b.kind === "table") {
      census.tables++;
      census.tableRows += b.table?.rows.length ?? 0;
    } else if (b.kind === "code") {
      census.code++;
    }
  }
  return census;
}
