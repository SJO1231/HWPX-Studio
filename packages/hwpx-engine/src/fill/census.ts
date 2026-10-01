import { makeIssue, type Issue } from "../errors.ts";
import type { HwpxDocument } from "../model/types.ts";
import { newAcc, walkSection } from "../validate/structure.ts";
import { IssueLog, type Census } from "../validate/types.ts";
import type { XElement } from "../xml/tree.ts";

/** 수량의 증감. 필드는 검사기의 `Census`와 같다. */
export type Delta = {
  paragraphs: number;
  tables: number;
  pictures: number;
  fieldPairs: number;
  bookmarks: number;
  binaryItems: number;
  unknownControls: Record<string, number>;
};

export const zeroDelta = (): Delta => ({
  paragraphs: 0,
  tables: 0,
  pictures: 0,
  fieldPairs: 0,
  bookmarks: 0,
  binaryItems: 0,
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
    unknownControls,
  };
}

function censusOfRoots(roots: Iterable<XElement>, entry: string): Census {
  const acc = newAcc();
  const log = new IssueLog();
  for (const root of roots) walkSection(root, entry, log, acc);
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

/** 요소들(자기 자신과 후손)이 차지하는 수량. 검사기의 수량 세는 규칙을 그대로 쓴다. */
export function deltaOfElements(elements: Iterable<XElement>, entry: string, sign: 1 | -1): Delta {
  const c = censusOfRoots(elements, entry);
  return {
    paragraphs: sign * c.paragraphs,
    tables: sign * c.tables,
    pictures: sign * c.pictures,
    fieldPairs: sign * c.fieldPairs,
    bookmarks: sign * c.bookmarks,
    binaryItems: 0,
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

/** 보고서에 싣는 증감: 0이 아닌 항목만. 모르는 컨트롤은 `unknown:<이름>`. */
export function deltaRecord(delta: Delta): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of COUNT_KEYS) if (delta[key] !== 0) out[key] = delta[key];
  for (const [k, v] of Object.entries(delta.unknownControls)) if (v !== 0) out[`unknown:${k}`] = v;
  return out;
}
