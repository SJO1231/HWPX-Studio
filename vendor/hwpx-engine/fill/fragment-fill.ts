import type { SpanEdit } from "../edit/plan.ts";
import { parseParagraph, walkParagraphs } from "../model/paragraph.ts";
import type { ParagraphNode } from "../model/types.ts";
import type { Fragment } from "../fragment/types.ts";
import type { Dataset, MissingPolicy, MixedFormatPolicy } from "../template/types.ts";
import { escapeAttr } from "../xml/chars.ts";
import { tokenize } from "../xml/tokenizer.ts";
import { buildTree, childEls, type XElement } from "../xml/tree.ts";
import { deltaOfElements, type Delta } from "./census.ts";
import { applyRepls, mapPos } from "./doc.ts";
import { fillPlaceholders, type PlaceholderOutcome } from "./placeholders.ts";

export type ParsedFragment = {
  /** 가짜 뿌리 요소로 감싼 전체 텍스트 */
  text: string;
  /** `text` 안에서 조각 원문이 시작하는 오프셋 */
  offset: number;
  root: XElement;
  /** 조각의 최상위 문단들 */
  paragraphs: ParagraphNode[];
};

/** 조각 원문을 접두사 선언을 단 가짜 뿌리 요소로 감싸 읽는다. 구역 파일과 같은 방식으로 문단을 해석할 수 있다. */
export function parseFragmentXml(fragment: Fragment): ParsedFragment {
  const decls = Object.entries(fragment.namespaces)
    .map(([prefix, uri]) => (prefix === "" ? ` xmlns="${escapeAttr(uri)}"` : ` xmlns:${prefix}="${escapeAttr(uri)}"`))
    .join("");
  const open = `<fragmentRoot${decls}>`;
  const text = `${open}${fragment.xml}</fragmentRoot>`;
  const root = buildTree(text, tokenize(text));
  const paragraphs = childEls(root, "paragraph", "p").map((p, i) => parseParagraph(p, [i]));
  return { text, offset: open.length, root, paragraphs };
}

export type FragmentFill = {
  /** `{{}}`를 채운 조각(원본은 바꾸지 않는다) */
  fragment: Fragment;
  outcome: PlaceholderOutcome;
  /** 채운 뒤 조각 안 모든 문단의 논리 텍스트(문서 순서) */
  texts: string[];
  /** 조각 최상위 문단 수 */
  topLevel: number;
  /** 조각이 문서에 더하는 수량(이진 자료 제외) */
  delta: Delta;
};


function applyEdits(text: string, edits: SpanEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const e of sorted) {
    out += text.slice(pos, e.start) + e.replacement;
    pos = e.end;
  }
  return out + text.slice(pos);
}

/**
 * 조각 원문 안의 `{{경로}}`를 데이터로 채운 사본을 만든다. 채우는 규칙은 본문과 같다.
 * 조각의 참조·id·책갈피·줄 배치 구간은 글이 바뀐 만큼 옮긴다(이 구간들은 글 안쪽에 있지 않다).
 */
export function fillFragment(fragment: Fragment, dataset: Dataset, policy: MissingPolicy, mixed: MixedFormatPolicy): FragmentFill {
  const parsed = parseFragmentXml(fragment);
  const all = [...walkParagraphs(parsed.paragraphs)];
  const outcome = fillPlaceholders({ entry: "fragment", text: parsed.text }, all, dataset, policy, mixed);
  const edits = outcome.edits.map((e) => ({ start: e.start - parsed.offset, end: e.end - parsed.offset, replacement: e.replacement }));
  const xml = applyEdits(parsed.text, outcome.edits).slice(parsed.offset, -"</fragmentRoot>".length);
  const move = <T extends { start: number; end: number }>(s: T): T => ({ ...s, start: mapPos(edits, s.start), end: mapPos(edits, s.end) });
  const texts = all.map((p) => applyRepls(p.logicalText, outcome.repls.get(p) ?? []));
  const filled: Fragment = {
    ...fragment,
    xml,
    refs: fragment.refs.map(move),
    instanceIds: fragment.instanceIds.map(move),
    bookmarks: fragment.bookmarks.map(move),
    lineSegSpans: fragment.lineSegSpans.map(move),
    texts,
  };
  return {
    fragment: filled,
    outcome,
    texts,
    topLevel: parsed.paragraphs.length,
    delta: deltaOfElements(parsed.paragraphs.map((p) => p.element), "fragment", 1),
  };
}
