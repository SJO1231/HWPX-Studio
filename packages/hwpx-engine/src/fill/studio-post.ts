import { applyPlan, type SpanEdit } from "../edit/plan.ts";
import { makeIssue, type Issue } from "../errors.ts";
import { parseDocument } from "../model/document.ts";
import { walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument } from "../model/types.ts";
import { openPackage } from "../package/open.ts";
import { readArchive } from "../package/zip-read.ts";
import { rewriteArchive } from "../package/zip-write.ts";
import { compareToBaseline, validateDocument } from "../validate/index.ts";
import { subElements } from "../xml/tree.ts";
import { collectFields, type FieldTarget } from "./fields.ts";

// 2판 생성의 후처리 2종(엔진 명세 8.8.12). 템플릿 `options`로 켠 것만 하고 기본은 끈다. studio-lite의 생성 결과와 같게 한다:
// 채운 필드의 표식을 지워 값 글만 남기고, 미리보기 글(`Preview/PrvText.txt`)을 결과 본문 글로 다시 쓴다.

const PREVIEW_ENTRY = "Preview/PrvText.txt";
const OBJECT_CHAR = /￼/g;

/** 문서의 모든 문단(머리말·표 칸 포함, 문서 순서) 글. 개체 자리 글자(U+FFFC)는 뺀다. */
export function documentLines(doc: HwpxDocument): string[] {
  return doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)].map((p) => p.logicalText.replace(OBJECT_CHAR, "")));
}

/** 필드의 식별 열쇠(구역, 시작 표식 id, 종류). 채움은 시작 표식을 그대로 두므로 채우기 전후에 같다. */
export const fieldKey = (t: FieldTarget): string => `${t.section.index}|${t.begin.id}|${t.info.type}`;

/**
 * 채운 필드(`keys`는 `fieldKey`)의 시작·끝 표식을 지워 값 글만 남긴다. 표식만 든 컨트롤(`hp:ctrl`)은 통째로, 아니면 표식 요소만 지운다.
 * 표식을 지운 문단의 줄 배치 캐시도 지운다(글자 위치가 바뀐다). 끝 표식이 같은 문단에 없는 필드(채운 뒤에는 생기지 않는다)는 `FIELD_UNSUPPORTED_SHAPE`.
 * 지운 뒤 다시 읽어 문서 글(개체 자리 글자 제외)이 같고, 검사기 새 오류가 없고, 그 필드가 남지 않았는지 확인한다. 어긋나면 출력이 없다.
 */
export function unwrapFields(bytes: Uint8Array, keys: ReadonlySet<string>): { output?: Uint8Array; count: number; issues: Issue[] } {
  const doc = parseDocument(openPackage(bytes));
  const targets = collectFields(doc).filter((t) => keys.has(fieldKey(t)));
  if (targets.length === 0) return { output: bytes, count: 0, issues: [] };
  const edits: SpanEdit[] = [];
  const add = (entry: string, text: string, start: number, end: number, reason: string): void => {
    if (!edits.some((e) => e.entry === entry && e.start === start)) edits.push({ entry, start, end, expected: text.slice(start, end), replacement: "", reason });
  };
  for (const t of targets) {
    if (t.end === null || t.endParagraph !== t.paragraph || !["simple", "empty", "inline"].includes(t.info.shape)) {
      return { count: 0, issues: [makeIssue("error", "FIELD_UNSUPPORTED_SHAPE", `채운 필드(${t.info.type}) 하나의 끝 표식이 같은 문단에 없어 표식을 풀 수 없습니다.`)] };
    }
    const { entryName, text } = t.section;
    for (const mark of [t.begin, t.end]) {
      const parent = mark.element.parent;
      const whole = parent !== null && parent.local === "ctrl" && subElements(parent).length === 1 ? parent : mark.element;
      add(entryName, text, whole.start, whole.end, "채운 필드의 표식 풀기");
    }
    const seg = t.paragraph.lineSegArray;
    if (seg !== undefined) add(entryName, text, seg.start, seg.end, "줄 배치 캐시 제거");
  }
  const output = applyPlan(doc.pkg, { edits, additions: [], summary: { unwrapped: targets.length }, issues: [] });
  const after = parseDocument(openPackage(output));
  const issues: Issue[] = [];
  if (JSON.stringify(documentLines(after)) !== JSON.stringify(documentLines(doc))) issues.push(makeIssue("error", "REREAD_TEXT", "필드 표식을 푼 뒤 문서 글이 달라졌습니다."));
  const regression = compareToBaseline(validateDocument(bytes), validateDocument(output)).newErrors;
  if (regression.length > 0) issues.push(makeIssue("error", "GATE_NEW_ERRORS", `필드 표식을 푼 뒤 검사 오류가 새로 생겼습니다(${regression.map((v) => v.code).join(", ")}).`));
  const left = collectFields(after).filter((t) => keys.has(fieldKey(t))).length;
  if (left > 0) issues.push(makeIssue("error", "REREAD_FIELD", `표식을 풀어야 할 필드 ${left}개가 남았습니다.`));
  return issues.length > 0 ? { count: 0, issues } : { output, count: targets.length, issues };
}

/** `Preview/PrvText.txt`가 있으면 결과 문서의 글(문단마다 한 줄, UTF-8)로 바꾼다. 다른 항목은 그대로다. 없으면 입력 그대로다. */
export function refreshPreview(bytes: Uint8Array): { output: Uint8Array; refreshed: boolean } {
  const archive = readArchive(bytes);
  if (!archive.entries.some((e) => e.name === PREVIEW_ENTRY)) return { output: bytes, refreshed: false };
  const text = documentLines(parseDocument(openPackage(bytes))).join("\n");
  return { output: rewriteArchive(bytes, archive, { replace: new Map([[PREVIEW_ENTRY, new TextEncoder().encode(text)]]) }), refreshed: true };
}
