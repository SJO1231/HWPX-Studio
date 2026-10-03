import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import type { TextBlockKind, TextTableCell, TextTableRow, TextBlock, TextDoc, TextKind, TextLine } from "./types.ts";

// Markdown은 필요한 만큼만 읽는다: 빈 줄로 나뉜 덩어리, 울타리 코드 블록, 파이프 표.
// 목록·인용문·HTML 블록·들여쓴 코드 등은 모두 빈 줄로 나뉜 덩어리(`paragraph`)일 뿐이다.

const isSpace = (c: number): boolean => c === 32 || c === 9;

/** 줄바꿈(`\n`, `\r\n`)으로 줄을 나눈다. 짝 없는 `\r`은 줄바꿈이 아니라 글이다. 마지막 줄바꿈 뒤에 빈 줄을 만들지 않는다. */
function splitLines(src: string, from: number): TextLine[] {
  const lines: TextLine[] = [];
  let pos = from;
  while (pos < src.length) {
    const nl = src.indexOf("\n", pos);
    if (nl < 0) {
      lines.push({ start: pos, end: src.length, eol: "" });
      break;
    }
    const crlf = nl > pos && src.charCodeAt(nl - 1) === 13;
    lines.push({ start: pos, end: crlf ? nl - 1 : nl, eol: crlf ? "\r\n" : "\n" });
    pos = nl + 1;
  }
  return lines;
}

function isBlank(src: string, line: TextLine): boolean {
  for (let i = line.start; i < line.end; i++) if (!isSpace(src.charCodeAt(i))) return false;
  return true;
}

// ── 파이프 표 ───────────────────────────────────────────────────

/**
 * 한 줄을 칸으로 나눈다. 백슬래시는 다음 글자를 감싸므로 `\|`는 구분이 아니다.
 * 맨 앞의 `|`와 맨 뒤의 `|`(그 뒤가 공백뿐일 때)는 구분일 뿐 칸을 만들지 않는다.
 */
export function splitRow(src: string, start: number, end: number): { cells: TextTableCell[]; pipes: number } {
  const bounds: [number, number][] = [];
  let i = start;
  while (i < end && isSpace(src.charCodeAt(i))) i++;
  let segStart = start;
  let pipes = 0;
  if (i < end && src[i] === "|") {
    segStart = i + 1;
    pipes = 1;
    i++;
  }
  for (; i < end; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "|") {
      bounds.push([segStart, i]);
      segStart = i + 1;
      pipes++;
    }
  }
  let tailBlank = true;
  for (let k = segStart; k < end; k++) if (!isSpace(src.charCodeAt(k))) tailBlank = false;
  if (!(pipes > 0 && tailBlank)) bounds.push([segStart, end]);
  const cells = bounds.map(([s, e]): TextTableCell => {
    let cs = s;
    let ce = e;
    while (cs < ce && isSpace(src.charCodeAt(cs))) cs++;
    while (ce > cs && isSpace(src.charCodeAt(ce - 1))) ce--;
    return cs === ce ? { start: s, end: e, contentStart: s, contentEnd: s } : { start: s, end: e, contentStart: cs, contentEnd: ce };
  });
  return { cells, pipes };
}

const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isTableStart(src: string, lines: TextLine[], i: number): boolean {
  const head = lines[i];
  const next = lines[i + 1];
  if (head === undefined || next === undefined) return false;
  const delimiter = src.slice(next.start, next.end);
  if (!delimiter.includes("|") || !DELIMITER_ROW.test(delimiter)) return false;
  const h = splitRow(src, head.start, head.end);
  const d = splitRow(src, next.start, next.end);
  return h.pipes > 0 && h.cells.length > 0 && h.cells.length === d.cells.length;
}

// ── 울타리 코드 블록 ────────────────────────────────────────────

type Fence = { ch: string; len: number };
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/s;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

function openFence(s: string): Fence | undefined {
  const m = FENCE_OPEN.exec(s);
  const run = m?.[1];
  if (run === undefined || (run[0] === "`" && (m?.[2] ?? "").includes("`"))) return undefined;
  return { ch: run[0] ?? "`", len: run.length };
}

function closesFence(s: string, fence: Fence): boolean {
  const run = FENCE_CLOSE.exec(s)?.[1];
  return run !== undefined && run[0] === fence.ch && run.length >= fence.len;
}

// ── 읽기 ────────────────────────────────────────────────────────

/**
 * 원문을 블록으로 나눈다. 문서를 바꾸지 않고, 블록 사이의 줄바꿈·빈 줄은 블록 구간 밖의 원문으로 그대로 남는다.
 *
 * - txt: 줄 하나가 블록이다(공백뿐인 줄은 `blank`).
 * - md: 빈 줄로 나뉜 덩어리가 블록이다. 덩어리가 울타리(``` 또는 ~~~)로 시작하면 닫는 울타리(없으면 문서 끝)까지가 한 `code` 블록이고,
 *   머리행 + 구분행(`|---|`) + 이어지는 줄들(빈 줄 앞까지)은 한 `table` 블록이다. 그 밖에는 한 줄짜리 `#` 제목이 `heading`, 나머지는 `paragraph`다.
 * - 줄바꿈은 `\n`·`\r\n`이고 섞여 있어도 줄마다 그대로 둔다. 맨 앞 BOM은 블록 밖이다.
 * - 짝이 맞지 않는 서로게이트가 있으면 UTF-8로 쓸 수 없으므로 `TEXT_ENCODING`을 던진다.
 */
export function parseText(text: string, kind: TextKind): TextDoc {
  if (!text.isWellFormed()) throw new HwpxError("TEXT_ENCODING", "글에 UTF-8로 쓸 수 없는 문자(짝이 맞지 않는 서로게이트)가 있습니다.");
  const bomLength = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lines = splitLines(text, bomLength);
  const blocks: TextBlock[] = [];
  const issues: Issue[] = [];
  const lineText = (i: number): string => {
    const l = lines[i];
    return l === undefined ? "" : text.slice(l.start, l.end);
  };
  const push = (kindOf: TextBlockKind, first: number, last: number, extra?: { table: TextBlock["table"] }): void => {
    const a = lines[first];
    const b = lines[last];
    if (a === undefined || b === undefined) return;
    const logical = first === last ? text.slice(a.start, a.end) : lines.slice(first, last + 1).map((l) => text.slice(l.start, l.end)).join("\n");
    const block: TextBlock = { index: blocks.length, kind: kindOf, start: a.start, end: b.end, firstLine: first, lastLine: last, text: logical };
    if (extra?.table !== undefined) block.table = extra.table;
    blocks.push(block);
  };

  if (kind === "txt") {
    lines.forEach((l, i) => push(isBlank(text, l) ? "blank" : "paragraph", i, i));
    return { kind, source: text, bomLength, lines, blocks, issues };
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || isBlank(text, line)) {
      i++;
      continue;
    }
    const fence = openFence(lineText(i));
    if (fence !== undefined) {
      let j = i + 1;
      while (j < lines.length && !closesFence(lineText(j), fence)) j++;
      if (j >= lines.length) {
        issues.push(makeIssue("warning", "TEXT_FENCE_UNCLOSED", `블록 ${blocks.length}: 코드 울타리가 닫히지 않아 문서 끝까지를 코드 블록으로 봅니다.`, `block ${blocks.length}`));
        j = lines.length - 1;
      }
      push("code", i, j);
      i = j + 1;
      continue;
    }
    const isTable = isTableStart(text, lines, i);
    let j = i + (isTable ? 2 : 1);
    while (j < lines.length && !isBlank(text, lines[j] as TextLine)) j++;
    const last = j - 1;
    if (isTable) {
      const rows: TextTableRow[] = [i, ...Array.from({ length: last - i - 1 }, (_, k) => i + 2 + k)].map((li) => {
        const l = lines[li] as TextLine;
        return { line: li, cells: splitRow(text, l.start, l.end).cells };
      });
      push("table", i, last, { table: { rows } });
    } else {
      push(i === last && HEADING.test(lineText(i)) ? "heading" : "paragraph", i, last);
    }
    i = last + 1;
  }
  return { kind, source: text, bomLength, lines, blocks, issues };
}
