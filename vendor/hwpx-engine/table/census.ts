import type { XElement } from "../xml/tree.ts";
import { newAcc, scanSectionBody } from "../validate/structure.ts";
import { IssueLog } from "../validate/types.ts";

export type TableCensus = { paragraphs: number; tables: number; pictures: number; fieldPairs: number; bookmarks: number; unknownControls: Record<string, number> };

/** 요소들(자기 자신과 후손)이 차지하는 수량. 검사기가 수량을 세는 규칙을 그대로 쓴다. */
export function censusOf(roots: Iterable<XElement>, entry: string): TableCensus {
  const acc = newAcc();
  const log = new IssueLog();
  for (const root of roots) scanSectionBody(root, entry, log, acc);
  return {
    paragraphs: acc.paragraphs,
    tables: acc.tables,
    pictures: acc.pictures,
    fieldPairs: acc.fieldBegin.length,
    bookmarks: acc.bookmarks.length,
    unknownControls: Object.fromEntries(acc.unknown),
  };
}
