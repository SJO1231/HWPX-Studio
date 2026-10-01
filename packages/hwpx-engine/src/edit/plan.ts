import { HwpxError, type Issue } from "../errors.ts";
import type { HwpxPackage } from "../package/open.ts";
import { readEntry } from "../package/zip-read.ts";
import { rewriteArchive } from "../package/zip-write.ts";
import { decodeUtf8, encodeUtf8 } from "../xml/parse.ts";

/** 항목 하나의 문자열 구간 치환. 오프셋은 해독한 텍스트의 UTF-16 단위이고 `[start, end)`다. */
export type SpanEdit = {
  entry: string;
  start: number;
  end: number;
  /** 적용 전에 `text.slice(start, end)`와 같아야 하는 원문 */
  expected: string;
  replacement: string;
  reason: string;
};

export type EditPlan = {
  edits: SpanEdit[];
  additions: { name: string; data: Uint8Array; method: 0 | 8 }[];
  /** 예: reusedResources, addedResources, reissuedIds */
  summary: Record<string, number>;
  issues: Issue[];
};

/**
 * 시작 위치순, 같은 시작이면 끝이 이른 것(길이 0 삽입)부터, 그다음은 계획에 실린 순서로 놓는다.
 * 그래서 같은 위치의 삽입은 계획 순서를 지키고, 구간 시작 위치의 삽입은 그 구간 치환보다 앞선다.
 */
function ordered(edits: SpanEdit[]): SpanEdit[] {
  return edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => a.edit.start - b.edit.start || a.edit.end - b.edit.end || a.index - b.index)
    .map((x) => x.edit);
}

function assertNoOverlap(entry: string, sorted: SpanEdit[]): void {
  let prev: SpanEdit | undefined;
  for (const cur of sorted) {
    if (prev !== undefined && cur.start < prev.end) {
      throw new HwpxError(
        "EDIT_OVERLAP",
        `${entry}: 편집 구간이 겹칩니다 [${prev.start}, ${prev.end}) (${prev.reason}) 와 [${cur.start}, ${cur.end}) (${cur.reason})`,
        entry,
      );
    }
    prev = cur;
  }
}

function groupByEntry(edits: SpanEdit[]): Map<string, SpanEdit[]> {
  const groups = new Map<string, SpanEdit[]>();
  for (const edit of edits) {
    const list = groups.get(edit.entry);
    if (list === undefined) groups.set(edit.entry, [edit]);
    else list.push(edit);
  }
  return groups;
}

/** 계획의 편집을 적용한 새 패키지 바이트를 만든다. 편집과 추가가 없으면 입력과 바이트 동일하다. */
export function applyPlan(pkg: HwpxPackage, plan: EditPlan): Uint8Array {
  const replace = new Map<string, Uint8Array>();
  for (const [entry, edits] of groupByEntry(plan.edits)) {
    const text = decodeUtf8(readEntry(pkg.archive, pkg.bytes, entry), entry);
    const sorted = ordered(edits);
    for (const e of sorted) {
      if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.end < e.start || e.end > text.length) {
        throw new HwpxError("EDIT_RANGE", `${entry}: 편집 구간 [${e.start}, ${e.end})이 올바르지 않습니다 (${e.reason}).`, entry);
      }
      if (text.slice(e.start, e.end) !== e.expected) {
        throw new HwpxError("EDIT_STALE", `${entry}: [${e.start}, ${e.end})의 원문이 기대와 다릅니다 (${e.reason}).`, entry);
      }
    }
    assertNoOverlap(entry, sorted);
    let out = "";
    let pos = 0;
    for (const e of sorted) {
      out += text.slice(pos, e.start) + e.replacement;
      pos = e.end;
    }
    replace.set(entry, encodeUtf8(out + text.slice(pos)));
  }
  return rewriteArchive(pkg.bytes, pkg.archive, { replace, add: plan.additions });
}

/** 두 계획을 합친다. 같은 항목에서 구간이 겹치면 `EDIT_OVERLAP`. 요약은 같은 키끼리 더한다. */
export function mergePlans(a: EditPlan, b: EditPlan): EditPlan {
  const edits = [...a.edits, ...b.edits];
  for (const [entry, group] of groupByEntry(edits)) assertNoOverlap(entry, ordered(group));
  const summary: Record<string, number> = { ...a.summary };
  for (const [key, value] of Object.entries(b.summary)) summary[key] = (summary[key] ?? 0) + value;
  return {
    edits,
    additions: [...a.additions, ...b.additions],
    summary,
    issues: [...a.issues, ...b.issues],
  };
}
