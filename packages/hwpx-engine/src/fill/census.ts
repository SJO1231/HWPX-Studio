import { makeIssue, type Issue } from "../errors.ts";
import type { HwpxDocument } from "../model/types.ts";
import { newAcc, scanSectionBody } from "../validate/structure.ts";
import { IssueLog, type Census } from "../validate/types.ts";
import { elIs, walkElements, type XElement } from "../xml/tree.ts";

/**
 * 수량의 증감. 앞의 필드는 검사기의 `Census`와 같다. `tableRows`·`tableCells`는 표의 행(`tr`)과 셀(`tc`) 수의 증감이다
 * (중첩 표 포함. 검사기 `Census`에는 없어서 이 모듈이 문서에서 따로 세어 확인한다).
 */
export type Delta = {
  paragraphs: number;
  tables: number;
  pictures: number;
  fieldPairs: number;
  bookmarks: number;
  binaryItems: number;
  tableRows: number;
  tableCells: number;
  unknownControls: Record<string, number>;
};

export const zeroDelta = (): Delta => ({
  paragraphs: 0,
  tables: 0,
  pictures: 0,
  fieldPairs: 0,
  bookmarks: 0,
  binaryItems: 0,
  tableRows: 0,
  tableCells: 0,
  unknownControls: {},
});

export function addDelta(a: Delta, b: Delta): Delta {
  const unknownControls = { ...a.unknownControls };
  for (const [k, v] of Object.entries(b.unknownControls)) unknownControls[k] = (unknownControls[k] ?? 0) + v;
  return {
    paragraphs: a.paragraphs + b.paragraphs,
    tables: a.tables + b.tables,
    pictures: a.pictures + b.pictures,
    fieldPairs: a.fieldPairs + b.fieldPairs,
    bookmarks: a.bookmarks + b.bookmarks,
    binaryItems: a.binaryItems + b.binaryItems,
    tableRows: a.tableRows + b.tableRows,
    tableCells: a.tableCells + b.tableCells,
    unknownControls,
  };
}

/** 수량 증감을 `n`배 한다. */
export function scaleDelta(d: Delta, n: number): Delta {
  return {
    paragraphs: d.paragraphs * n,
    tables: d.tables * n,
    pictures: d.pictures * n,
    fieldPairs: d.fieldPairs * n,
    bookmarks: d.bookmarks * n,
    binaryItems: d.binaryItems * n,
    tableRows: d.tableRows * n,
    tableCells: d.tableCells * n,
    unknownControls: Object.fromEntries(Object.entries(d.unknownControls).map(([k, v]) => [k, v * n])),
  };
}

function censusOfRoots(roots: Iterable<XElement>, entry: string): Census {
  const acc = newAcc();
  const log = new IssueLog();
  for (const root of roots) scanSectionBody(root, entry, log, acc);
  return {
    paragraphs: acc.paragraphs,
    tables: acc.tables,
    pictures: acc.pictures,
    fieldPairs: acc.fieldBegin.length,
    bookmarks: acc.bookmarks.length,
    binaryItems: 0,
    unknownControls: Object.fromEntries(acc.unknown),
  };
}

/** 요소들(자기 자신과 후손) 안의 표 행(`tr`)·셀(`tc`) 수(중첩 표 포함) */
export function countRowsCells(roots: Iterable<XElement>): { rows: number; cells: number } {
  let rows = 0;
  let cells = 0;
  for (const root of roots) {
    for (const el of walkElements(root)) {
      if (elIs(el, "paragraph", "tr")) rows++;
      else if (elIs(el, "paragraph", "tc")) cells++;
    }
  }
  return { rows, cells };
}

/** 문서 전체의 표 행·셀 수 */
export function tableCountsOfDoc(doc: HwpxDocument): { rows: number; cells: number } {
  return countRowsCells(doc.sections.map((s) => s.root));
}

/** 요소들(자기 자신과 후손)이 차지하는 수량. 검사기의 수량 세는 규칙을 그대로 쓰고, 표 행·셀은 따로 센다. */
export function deltaOfElements(elements: Iterable<XElement>, entry: string, sign: 1 | -1): Delta {
  const list = [...elements];
  const c = censusOfRoots(list, entry);
  const rc = countRowsCells(list);
  return {
    paragraphs: sign * c.paragraphs,
    tables: sign * c.tables,
    pictures: sign * c.pictures,
    fieldPairs: sign * c.fieldPairs,
    bookmarks: sign * c.bookmarks,
    binaryItems: 0,
    tableRows: sign * rc.rows,
    tableCells: sign * rc.cells,
    unknownControls: Object.fromEntries(Object.entries(c.unknownControls).map(([k, v]) => [k, sign * v])),
  };
}

/** 문서 전체의 수량(검사기 보고서의 `census`와 같은 값). */
export function censusOfDoc(doc: HwpxDocument): Census {
  let acc = zeroDelta();
  for (const s of doc.sections) acc = addDelta(acc, deltaOfElements([s.root], s.entryName, 1));
  return {
    paragraphs: acc.paragraphs,
    tables: acc.tables,
    pictures: acc.pictures,
    fieldPairs: acc.fieldPairs,
    bookmarks: acc.bookmarks,
    binaryItems: doc.pkg.archive.entries.filter((e) => !e.isDirectory && e.name.startsWith("BinData/")).length,
    unknownControls: Object.fromEntries(Object.entries(acc.unknownControls).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

export function applyDelta(census: Census, delta: Delta): Census {
  const unknownControls: Record<string, number> = { ...census.unknownControls };
  for (const [k, v] of Object.entries(delta.unknownControls)) unknownControls[k] = (unknownControls[k] ?? 0) + v;
  for (const [k, v] of Object.entries(unknownControls)) if (v === 0) delete unknownControls[k];
  return {
    paragraphs: census.paragraphs + delta.paragraphs,
    tables: census.tables + delta.tables,
    pictures: census.pictures + delta.pictures,
    fieldPairs: census.fieldPairs + delta.fieldPairs,
    bookmarks: census.bookmarks + delta.bookmarks,
    binaryItems: census.binaryItems + delta.binaryItems,
    unknownControls,
  };
}

const COUNT_KEYS = ["paragraphs", "tables", "pictures", "fieldPairs", "bookmarks", "binaryItems"] as const;

/** 편집 전 수량에 예고한 증감을 더한 값과 실제 수량이 같은지 본다. 다르면 `PRESERVE_CENSUS` 오류. */
export function verifyCensus(before: Census, after: Census, delta: Delta, where?: string): Issue[] {
  const expected = applyDelta(before, delta);
  const issues: Issue[] = [];
  for (const key of COUNT_KEYS) {
    if (expected[key] !== after[key]) {
      issues.push(
        makeIssue("error", "PRESERVE_CENSUS", `${key} 수량이 예고(${expected[key]})와 다릅니다: 실제 ${after[key]} (편집 전 ${before[key]}, 예고한 증감 ${delta[key]}).`, where),
      );
    }
  }
  for (const key of new Set([...Object.keys(expected.unknownControls), ...Object.keys(after.unknownControls)])) {
    const e = expected.unknownControls[key] ?? 0;
    const a = after.unknownControls[key] ?? 0;
    if (e !== a) issues.push(makeIssue("error", "PRESERVE_CENSUS", `모르는 컨트롤 ${key} 수량이 예고(${e})와 다릅니다: 실제 ${a}.`, where));
  }
  return issues;
}

/** 표 행·셀 수가 예고(편집 전 수 + 증감)와 같은지 본다. 다르면 `PRESERVE_CENSUS` 오류. */
export function verifyTableCounts(before: { rows: number; cells: number }, after: { rows: number; cells: number }, delta: Delta, where?: string): Issue[] {
  const issues: Issue[] = [];
  const check = (name: "tableRows" | "tableCells", was: number, now: number): void => {
    if (was + delta[name] !== now) {
      issues.push(makeIssue("error", "PRESERVE_CENSUS", `${name} 수량이 예고(${was + delta[name]})와 다릅니다: 실제 ${now} (편집 전 ${was}, 예고한 증감 ${delta[name]}).`, where));
    }
  };
  check("tableRows", before.rows, after.rows);
  check("tableCells", before.cells, after.cells);
  return issues;
}

/** 보고서에 싣는 증감: 0이 아닌 항목만. 표 행·셀은 `tableRows`·`tableCells`, 모르는 컨트롤은 `unknown:<이름>`. */
export function deltaRecord(delta: Delta): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of COUNT_KEYS) if (delta[key] !== 0) out[key] = delta[key];
  if (delta.tableRows !== 0) out["tableRows"] = delta.tableRows;
  if (delta.tableCells !== 0) out["tableCells"] = delta.tableCells;
  for (const [k, v] of Object.entries(delta.unknownControls)) if (v !== 0) out[`unknown:${k}`] = v;
  return out;
}
