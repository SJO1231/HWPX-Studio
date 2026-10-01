import type { SpanEdit } from "../edit/plan.ts";
import type { ParagraphNode } from "../model/types.ts";
import { escapeAttr, escapeText } from "../xml/chars.ts";
import { attrNode, childEl, childEls, type XElement } from "../xml/tree.ts";
import { prefixOf } from "./doc.ts";
import { span, type Ctx, type Fail } from "./text.ts";

// ── 표 행 삭제 ──────────────────────────────────────────────────

type RowCell = { addr: XElement | undefined; row: number; rowSpan: number };
type RowInfo = { tr: XElement; row: number; cells: RowCell[] };

const toInt = (v: string | undefined, fallback: number): number => (v !== undefined && /^-?\d+$/.test(v) ? Number(v) : fallback);

function readRows(tbl: XElement): RowInfo[] {
  return childEls(tbl, "paragraph", "tr").map((tr, index) => {
    const cells = childEls(tr, "paragraph", "tc").map((tc): RowCell => {
      const addr = childEl(tc, "paragraph", "cellAddr");
      const spanEl = childEl(tc, "paragraph", "cellSpan");
      return {
        addr,
        row: toInt(addr === undefined ? undefined : attrNode(addr, "rowAddr")?.value, index),
        rowSpan: toInt(spanEl === undefined ? undefined : attrNode(spanEl, "rowSpan")?.value, 1),
      };
    });
    return { tr, row: cells[0]?.row ?? index, cells };
  });
}

export type RowDeletion = { edits: SpanEdit[]; trs: XElement[] };

/**
 * 표에서 주소가 `rows`인 행들을 지운다: `tr` 요소 삭제, `rowCnt` 감소, 뒤 행 셀들의 행 주소(`rowAddr`)를 지운 행 수만큼 줄인다.
 * 그 행에 걸친 세로 병합 셀(rowSpan > 1)이 있으면 `FILL_ROW_SPAN`. 모든 행이 지워지면 `allRows`(표째 지워야 한다).
 */
export function planRowDeletes(ctx: Ctx, tbl: XElement, rows: number[]): RowDeletion | { allRows: true } | Fail {
  const infos = readRows(tbl);
  const wanted = [...new Set(rows)].sort((a, b) => a - b);
  const doomed: RowInfo[] = [];
  for (const n of wanted) {
    const info = infos.find((r) => r.row === n);
    if (info === undefined) return { fail: { code: "ANCHOR_NOT_FOUND", message: `표에 행 ${n}이(가) 없습니다.` } };
    if (infos.some((r) => r.cells.some((c) => c.rowSpan > 1 && c.row <= n && n < c.row + c.rowSpan))) {
      return { fail: { code: "FILL_ROW_SPAN", message: `행 ${n}에 걸친 세로 병합 셀이 있어 행을 지울 수 없습니다.` } };
    }
    doomed.push(info);
  }
  if (doomed.length === infos.length) return { allRows: true };

  const edits: SpanEdit[] = doomed.map((r) => span(ctx, r.tr.start, r.tr.end, "", "표 행 삭제"));
  const rowCnt = attrNode(tbl, "rowCnt");
  if (rowCnt !== undefined && /^\d+$/.test(rowCnt.value)) {
    edits.push(span(ctx, rowCnt.valueStart, rowCnt.valueEnd, String(Math.max(0, Number(rowCnt.value) - doomed.length)), "표 rowCnt 감소"));
  }
  const gone = new Set(doomed);
  for (const info of infos) {
    if (gone.has(info)) continue;
    for (const cell of info.cells) {
      const attr = cell.addr === undefined ? undefined : attrNode(cell.addr, "rowAddr");
      const shift = wanted.filter((n) => n < cell.row).length;
      if (attr !== undefined && shift > 0) edits.push(span(ctx, attr.valueStart, attr.valueEnd, String(cell.row - shift), "뒤 행의 행 주소 감소"));
    }
  }
  return { edits, trs: doomed.map((r) => r.tr) };
}

// ── 일반 텍스트 삽입 ────────────────────────────────────────────

/** 한컴이 여러 문단에 같이 쓰는 자리값 문단 id(검사기와 같은 목록) */
const PLACEHOLDER_PARAGRAPH_IDS = new Set(["", "0", "2147483648", "4294967295"]);

export type ParagraphStyle = { paraPrIDRef: string; styleIDRef: string; charPrIDRef: string };

/**
 * 글을 새 문단들로 만든다(줄마다 문단 하나). 문단·run·`hp:t`만 쓴다.
 * 속성은 앵커 문단의 것을 복사하되 `paraPrIDRef`·`styleIDRef`는 `style`로 바꾸고, `id`는 앵커의 값이 자리값이면 그대로·아니면 `0`,
 * `pageBreak`·`columnBreak`는 `0`으로 둔다(새 문단이 쪽·단 나눔을 이어받지 않게). 빈 줄은 한컴이 쓰는 빈 문단 모양(자기닫힘 run)이다.
 */
export function buildParagraphs(anchor: ParagraphNode, lines: string[], style: ParagraphStyle): string {
  const names = new Set<string>();
  const attrs: string[] = [];
  for (const a of anchor.element.attrs) {
    if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) continue;
    names.add(a.qname);
    let value = a.value;
    if (a.qname === "id") value = PLACEHOLDER_PARAGRAPH_IDS.has(a.value) ? a.value : "0";
    else if (a.qname === "pageBreak" || a.qname === "columnBreak") value = "0";
    else if (a.qname === "paraPrIDRef") value = style.paraPrIDRef;
    else if (a.qname === "styleIDRef") value = style.styleIDRef;
    attrs.push(`${a.qname}="${escapeAttr(value)}"`);
  }
  if (!names.has("paraPrIDRef")) attrs.push(`paraPrIDRef="${escapeAttr(style.paraPrIDRef)}"`);
  if (!names.has("styleIDRef")) attrs.push(`styleIDRef="${escapeAttr(style.styleIDRef)}"`);

  const p = anchor.element.qname;
  const prefix = prefixOf(anchor.element);
  const run = `${prefix}run`;
  const t = `${prefix}t`;
  const open = `<${p} ${attrs.join(" ")}>`;
  return lines
    .map((line) =>
      line === ""
        ? `${open}<${run} charPrIDRef="${escapeAttr(style.charPrIDRef)}"/></${p}>`
        : `${open}<${run} charPrIDRef="${escapeAttr(style.charPrIDRef)}"><${t}>${escapeText(line)}</${t}></${run}></${p}>`,
    )
    .join("");
}

/** 값을 줄바꿈(CRLF·CR·LF)마다 나눈다. */
export const splitLines = (value: string): string[] => value.split(/\r\n|\r|\n/);
