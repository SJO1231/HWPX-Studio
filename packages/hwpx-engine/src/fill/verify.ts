import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import type { HwpxDocument } from "../model/types.ts";
import { readArchive, readEntry, type Archive } from "../package/zip-read.ts";
import { decodeUtf8 } from "../xml/parse.ts";
import { groupBy, makeMapper, paragraphIndex, startKey } from "./doc.ts";
import { collectFields } from "./fields.ts";
import type { Expectation } from "./plan.ts";

type Additions = { name: string; data: Uint8Array }[];

/** 항목 이름 순서, 손대지 않은 항목의 로컬 레코드, 추가 항목의 내용을 확인한다. */
function checkArchive(
  a: Archive,
  b: Archive,
  before: Uint8Array,
  after: Uint8Array,
  editedEntries: ReadonlySet<string>,
  additions: Additions,
  err: (code: string, message: string, at?: string) => void,
): void {
  const want = [...a.entries.map((e) => e.name), ...additions.map((x) => x.name)];
  const got = b.entries.map((e) => e.name);
  if (want.length !== got.length || want.some((n, i) => n !== got[i])) {
    err("PRESERVE_ENTRY_ORDER", `항목 이름 순서가 계획과 다릅니다(기대 ${want.length}개, 실제 ${got.length}개).`);
  }
  for (const entry of a.entries) {
    if (editedEntries.has(entry.name)) continue;
    const other = b.entries.find((x) => x.name === entry.name);
    if (other === undefined) {
      err("PRESERVE_RECORD_CHANGED", "손대지 않은 항목이 출력에 없습니다.", entry.name);
      continue;
    }
    const x = before.subarray(entry.localStart, entry.localEnd);
    const y = after.subarray(other.localStart, other.localEnd);
    if (x.length !== y.length || !x.every((v, i) => v === y[i])) {
      err("PRESERVE_RECORD_CHANGED", "손대지 않은 항목의 로컬 레코드가 바이트 동일하지 않습니다.", entry.name);
    }
  }
  for (const add of additions) {
    const found = b.entries.find((x) => x.name === add.name);
    let same = false;
    if (found !== undefined) {
      const data = readEntry(b, after, add.name);
      same = data.length === add.data.length && data.every((v, i) => v === add.data[i]);
    }
    if (!same) err("PRESERVE_ADDITION", "추가 항목의 내용이 계획과 다릅니다.", add.name);
  }
}

function openBoth(before: Uint8Array, after: Uint8Array): { a: Archive; b: Archive } | HwpxError {
  try {
    return { a: readArchive(before), b: readArchive(after) };
  } catch (e) {
    if (e instanceof HwpxError) return e;
    throw e;
  }
}

/**
 * 편집을 적용한 출력이 계획이 허락한 것만 바꿨는지 확인한다(보존 계약).
 * - 항목 이름 순서가 같고, 추가된 항목은 계획의 `additions`뿐이다.
 * - 계획에 편집이 없는 항목은 로컬 레코드가 바이트 동일하다.
 * - 편집이 있는 항목은 계획의 오프셋으로 나눈 구간 밖의 글이 원본과 같고, 구간 안은 계획의 치환과 같다.
 * - 추가 항목의 내용이 계획의 것과 같다.
 */
export function verifyPreservation(
  before: Uint8Array,
  after: Uint8Array,
  plan: Pick<EditPlan, "edits" | "additions">,
  where?: string,
): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, message: string, at?: string): void => void issues.push(makeIssue("error", code, message, at ?? where));
  const opened = openBoth(before, after);
  if (opened instanceof HwpxError) return [makeIssue("error", "PRESERVE_UNREADABLE", `ZIP을 읽을 수 없습니다: ${opened.message}`, where)];
  const { a, b } = opened;

  const edited = groupBy(plan.edits, (e) => e.entry);
  checkArchive(a, b, before, after, new Set(edited.keys()), plan.additions, err);

  for (const [entry, edits] of edited) {
    let inText: string;
    let outText: string;
    try {
      inText = decodeUtf8(readEntry(a, before, entry), entry);
      outText = decodeUtf8(readEntry(b, after, entry), entry);
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      err("PRESERVE_SPAN", `항목을 읽을 수 없습니다: ${e.message}`, entry);
      continue;
    }
    const sorted = edits.map((e, i) => ({ e, i })).sort((x, y) => x.e.start - y.e.start || x.e.end - y.e.end || x.i - y.i).map((x) => x.e);
    let pos = 0;
    let outPos = 0;
    let bad = false;
    for (const e of sorted) {
      const gap = inText.slice(pos, e.start);
      if (outText.slice(outPos, outPos + gap.length) !== gap) {
        err("PRESERVE_SPAN", `편집 구간 밖의 글이 원본과 다릅니다(원본 오프셋 ${pos}~${e.start}).`, entry);
        bad = true;
        break;
      }
      outPos += gap.length;
      if (outText.slice(outPos, outPos + e.replacement.length) !== e.replacement) {
        err("PRESERVE_SPAN", `편집 구간 [${e.start}, ${e.end})의 결과가 계획의 치환과 다릅니다.`, entry);
        bad = true;
        break;
      }
      outPos += e.replacement.length;
      pos = e.end;
    }
    if (!bad && outText.slice(outPos) !== inText.slice(pos)) {
      err("PRESERVE_SPAN", `마지막 편집 뒤의 글이 원본과 다릅니다(원본 오프셋 ${pos}~).`, entry);
    }
  }

  return issues;
}

/**
 * 채운 값을 다시 읽어 확인한다(값 재읽기). `edits`는 기대값의 위치(편집 전 오프셋)를 `doc`의 위치로 옮기는 데 쓴다.
 * 누름틀은 값과 `dirty`를, 채운 문단은 논리 텍스트 전체를 견준다. 오류 메시지에 값 원문은 담지 않는다.
 */
export function verifyExpectations(
  doc: HwpxDocument,
  edits: SpanEdit[],
  expectations: Expectation[],
  where?: string,
): { issues: Issue[]; checked: { fields: number; paragraphs: number } } {
  const issues: Issue[] = [];
  const checked = { fields: 0, paragraphs: 0 };
  const paragraphs = paragraphIndex(doc);
  const fields = new Map(collectFields(doc).map((f) => [startKey(f.section.entryName, f.begin.element.start), f]));
  const mappers = new Map([...groupBy(edits, (e) => e.entry)].map(([entry, list]) => [entry, makeMapper(list)]));

  for (const x of expectations) {
    const moved = (p: number): number => mappers.get(x.entry)?.(p) ?? p;
    if (x.kind === "field") {
      checked.fields++;
      const f = fields.get(startKey(x.entry, moved(x.beginStart)));
      if (f === undefined) {
        issues.push(makeIssue("error", "REREAD_FIELD", `채운 누름틀 '${x.name}'을(를) 출력에서 다시 찾지 못했습니다.`, where));
      } else if (f.info.valueText !== x.value) {
        issues.push(
          makeIssue("error", "REREAD_FIELD", `누름틀 '${x.name}'의 값이 넣으려던 값과 다릅니다(기대 길이 ${x.value.length}, 읽은 길이 ${f.info.valueText.length}).`, where),
        );
      } else if (x.setsDirty && f.info.dirty !== "1") {
        issues.push(makeIssue("error", "REREAD_FIELD", `누름틀 '${x.name}'의 dirty가 "1"이 아닙니다.`, where));
      }
    } else {
      checked.paragraphs++;
      const p = paragraphs.get(startKey(x.entry, moved(x.paragraphStart)));
      if (p === undefined) {
        issues.push(makeIssue("error", "REREAD_TEXT", "채운 문단을 출력에서 다시 찾지 못했습니다.", where));
      } else if (p.paragraph.logicalText !== x.text) {
        issues.push(
          makeIssue("error", "REREAD_TEXT", `문단 [${p.paragraph.path.join(", ")}]의 글이 기대와 다릅니다(기대 길이 ${x.text.length}, 읽은 길이 ${p.paragraph.logicalText.length}).`, where),
        );
      }
    }
  }
  return { issues, checked };
}

/**
 * 여러 단계를 거친 최종 출력을 원본과 견준다: 항목 이름 순서(원본 + 단계들이 더한 항목), 어느 단계에서도 편집이 없던 항목의
 * 로컬 레코드가 원본과 바이트 동일, 추가 항목의 내용. 편집이 있던 항목의 구간 비교는 단계마다 `verifyPreservation`이 한다.
 */
export function verifyChain(before: Uint8Array, after: Uint8Array, plans: Pick<EditPlan, "edits" | "additions">[], where?: string): Issue[] {
  const opened = openBoth(before, after);
  if (opened instanceof HwpxError) return [makeIssue("error", "PRESERVE_UNREADABLE", `ZIP을 읽을 수 없습니다: ${opened.message}`, where)];
  const issues: Issue[] = [];
  const edited = new Set(plans.flatMap((p) => p.edits.map((e) => e.entry)));
  checkArchive(opened.a, opened.b, before, after, edited, plans.flatMap((p) => p.additions), (code, message, at) => void issues.push(makeIssue("error", code, message, at ?? where)));
  return issues;
}
