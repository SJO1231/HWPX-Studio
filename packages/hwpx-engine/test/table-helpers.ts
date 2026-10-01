// 표 시험용 합성 문서 만들기와 독립 기준. 엔진의 표 코드(`src/table`)를 쓰지 않고 정규식·문자열로만 만든다.
import { applyPlan, openPackage, parseDocument, readEntry, type EditPlan, type HwpxDocument, type XElement } from "../src/index.ts";
import { MINIMAL_HEADER, buildHwpx, NS_HP } from "./helpers.ts";

export const SEC = "Contents/section0.xml";

export type CellSpec = {
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  width: number;
  height: number;
  /** 셀 안 문단 원문들. 없으면 `text`로 문단 하나를 만든다. */
  paragraphs?: string[];
  text?: string;
  header?: boolean;
  borderFillIDRef?: string;
  name?: string;
};

export type TableSpec = {
  id?: string;
  rowCnt: number;
  colCnt: number;
  width?: number;
  height?: number;
  widthRelTo?: string;
  heightRelTo?: string;
  treatAsChar?: boolean;
  pageBreak?: string;
  repeatHeader?: boolean;
  cellSpacing?: number;
  cells: CellSpec[];
  /** 빼 둘 자식 요소(없는 요소 만들기 시험) */
  omit?: ("pos" | "outMargin" | "inMargin")[];
  cellzone?: boolean;
};

/** 문단 하나. 첫 run에 `inner`(글·객체·컨트롤 원문)를 넣는다. */
export function paragraph(inner: string, id = "0"): string {
  return `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`;
}

export const textPara = (text: string, id = "0"): string => paragraph(text === "" ? "" : `<hp:t>${text}</hp:t>`, id).replace('<hp:run charPrIDRef="0"></hp:run>', '<hp:run charPrIDRef="0"/>');

export const lineSeg = '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="40000" flags="393216"/></hp:linesegarray>';

/** 줄 배치 캐시가 든 문단 */
export const segPara = (text: string, id = "0"): string => textPara(text, id).replace("</hp:p>", `${lineSeg}</hp:p>`);

export function tableXml(spec: TableSpec): string {
  const rows: CellSpec[][] = Array.from({ length: spec.rowCnt }, () => []);
  for (const c of spec.cells) rows[c.row]?.push(c);
  const rowHeight = (r: number): number => Math.max(0, ...(rows[r] ?? []).filter((c) => (c.rowSpan ?? 1) === 1).map((c) => c.height));
  const width = spec.width ?? (rows[0] ?? []).reduce((n, c) => n + c.width, 0);
  const height = spec.height ?? rows.reduce((n, _r, i) => n + rowHeight(i), 0);
  const omit = new Set(spec.omit ?? []);
  const sz = `<hp:sz width="${width}" widthRelTo="${spec.widthRelTo ?? "ABSOLUTE"}" height="${height}" heightRelTo="${spec.heightRelTo ?? "ABSOLUTE"}" protect="0"/>`;
  const pos = omit.has("pos")
    ? ""
    : `<hp:pos treatAsChar="${spec.treatAsChar === true ? 1 : 0}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`;
  const out = omit.has("outMargin") ? "" : '<hp:outMargin left="283" right="283" top="283" bottom="283"/>';
  const inn = omit.has("inMargin") ? "" : '<hp:inMargin left="510" right="510" top="141" bottom="141"/>';
  const zones = spec.cellzone === true ? '<hp:cellzoneList><hp:cellzone startRowAddr="0" startColAddr="0" endRowAddr="0" endColAddr="0" borderFillIDRef="1"/></hp:cellzoneList>' : "";
  const trs = rows
    .map((cells) => {
      const tcs = cells
        .map((c) => {
          const paras = c.paragraphs ?? [textPara(c.text ?? "")];
          return (
            `<hp:tc name="${c.name ?? ""}" header="${c.header === true ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${c.borderFillIDRef ?? "1"}">` +
            `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras.join("")}</hp:subList>` +
            `<hp:cellAddr colAddr="${c.col}" rowAddr="${c.row}"/><hp:cellSpan colSpan="${c.colSpan ?? 1}" rowSpan="${c.rowSpan ?? 1}"/>` +
            `<hp:cellSz width="${c.width}" height="${c.height}"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`
          );
        })
        .join("");
      return `<hp:tr>${tcs}</hp:tr>`;
    })
    .join("");
  return (
    `<hp:tbl id="${spec.id ?? "1001"}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" ` +
    `pageBreak="${spec.pageBreak ?? "CELL"}" repeatHeader="${spec.repeatHeader === true ? 1 : 0}" rowCnt="${spec.rowCnt}" colCnt="${spec.colCnt}" cellSpacing="${spec.cellSpacing ?? 0}" borderFillIDRef="1" noAdjust="0">` +
    `${sz}${pos}${out}${inn}${zones}${trs}</hp:tbl>`
  );
}

/** 균일 격자 표: 열 너비 `widths`, 행 높이 `height`, 글은 `texts[행][열]` */
export function gridTable(widths: number[], rowCount: number, texts: string[][] = [], extra: Partial<TableSpec> = {}, height = 1000): TableSpec {
  const cells: CellSpec[] = [];
  for (let r = 0; r < rowCount; r++) {
    widths.forEach((w, c) => cells.push({ row: r, col: c, width: w, height, text: texts[r]?.[c] ?? "" }));
  }
  return { rowCnt: rowCount, colCnt: widths.length, cells, ...extra };
}

/** 표 하나를 담은 문단 */
export function tableParagraph(spec: TableSpec, id = "0"): string {
  return paragraph(`${tableXml(spec)}<hp:t/>`, id);
}

/** 합성 HWPX 바이트: 최상위 문단 원문들을 구역에 넣는다. */
export function docOf(body: string[], header = MINIMAL_HEADER): Uint8Array {
  return buildHwpx([body.join("")], header);
}

/** 문서 하나(표 하나를 담은 문단 + 앞뒤 일반 문단)를 만들어 모델까지 돌려준다. */
export function singleTableDoc(spec: TableSpec): { bytes: Uint8Array; doc: HwpxDocument } {
  const bytes = docOf([textPara("앞 문단"), tableParagraph(spec), textPara("뒤 문단")]);
  return { bytes, doc: parseDocument(openPackage(bytes)) };
}

export const reparseBytes = (bytes: Uint8Array): HwpxDocument => parseDocument(openPackage(bytes));

/** 계획을 적용하고 다시 파싱한다. */
export function applyAndParse(doc: HwpxDocument, plan: EditPlan): { bytes: Uint8Array; doc: HwpxDocument } {
  const bytes = applyPlan(doc.pkg, plan);
  return { bytes, doc: reparseBytes(bytes) };
}

export function sectionText(bytes: Uint8Array, entry = SEC): string {
  const pkg = openPackage(bytes);
  return new TextDecoder().decode(readEntry(pkg.archive, bytes, entry));
}

export const stripLineSegs = (xml: string): string => xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");

/** 구역 안 모든 표 요소(문서 순서, 중첩 포함) */
export function tablesOf(doc: HwpxDocument, sectionIndex = 0): XElement[] {
  const out: XElement[] = [];
  const stack: XElement[] = [doc.sections[sectionIndex]?.root as XElement];
  const order: XElement[] = [];
  while (stack.length > 0) {
    const el = stack.pop();
    if (el === undefined) break;
    order.push(el);
    for (let i = el.children.length - 1; i >= 0; i--) {
      const c = el.children[i];
      if (c !== undefined && "local" in c) stack.push(c);
    }
  }
  for (const el of order) if (el.local === "tbl") out.push(el);
  return out;
}

export const target = (doc: HwpxDocument, index = 0, sectionIndex = 0): { sectionIndex: number; element: XElement } => ({
  sectionIndex,
  element: tablesOf(doc, sectionIndex)[index] as XElement,
});

// ── 독립 기준: 정규식으로 표의 수치 읽기 ─────────────────────────────

/** 가장 바깥 표 하나의 원문(여는 태그부터 대응하는 닫는 태그까지)을 `index`번째 최상위 표에서 잘라낸다. */
export function outerTableXml(section: string, index = 0): string {
  let from = -1;
  for (let i = 0; i <= index; i++) from = section.indexOf("<hp:tbl ", from + 1);
  if (from < 0) throw new Error("표가 없다");
  let depth = 0;
  const re = /<hp:tbl[ >]|<\/hp:tbl>/g;
  re.lastIndex = from;
  for (let m = re.exec(section); m !== null; m = re.exec(section)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return section.slice(from, m.index + m[0].length);
  }
  throw new Error("표가 닫히지 않았다");
}

/** 셀 안(`subList`) 내용을 걷어낸다. 중첩된 `subList`도 깊이를 세어 통째로 걷어낸다. */
export function stripSubLists(xml: string): string {
  let out = "";
  let depth = 0;
  let pos = 0;
  for (const m of xml.matchAll(/<hp:subList\b[^>]*>|<\/hp:subList>/g)) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) {
        out += "<hp:subList/>";
        pos = m.index + m[0].length;
      }
    } else {
      if (depth === 0) out += xml.slice(pos, m.index);
      depth++;
    }
  }
  return out + xml.slice(pos);
}

/** 표 바로 아래 행(`tr`) 원문들. 셀 안 중첩 표의 행은 세지 않는다. */
export function topRows(tbl: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = -1;
  for (const m of tbl.matchAll(/<hp:tr>|<\/hp:tr>/g)) {
    if (m[0] === "<hp:tr>") {
      if (depth === 0) from = m.index;
      depth++;
    } else {
      depth--;
      if (depth === 0) out.push(tbl.slice(from, m.index + m[0].length));
    }
  }
  return out;
}

/** 표 바로 아래 `tr`의 셀(직속) 수치를 정규식으로 읽는다. 중첩 표는 `subList` 안이므로 걷어낸 뒤 센다. */
export function readCells(tbl: string): { row: number; col: number; rowSpan: number; colSpan: number; width: number; height: number }[] {
  const flat = stripSubLists(tbl);
  const out: { row: number; col: number; rowSpan: number; colSpan: number; width: number; height: number }[] = [];
  for (const m of flat.matchAll(/<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"\/><hp:cellSpan colSpan="(\d+)" rowSpan="(\d+)"\/><hp:cellSz width="(\d+)" height="(\d+)"\/>/g)) {
    out.push({ col: Number(m[1]), row: Number(m[2]), colSpan: Number(m[3]), rowSpan: Number(m[4]), width: Number(m[5]), height: Number(m[6]) });
  }
  return out;
}

export const attrIn = (xml: string, tag: string, name: string): string | undefined => new RegExp(`<hp:${tag}\\b[^>]*?\\s${name}="([^"]*)"`).exec(xml)?.[1];

/** 독립 기준: 행마다 그 행을 덮는 셀 너비의 합 */
export function rowWidthSums(tbl: string): number[] {
  const cells = readCells(tbl);
  const rowCnt = Number(attrIn(tbl, "tbl", "rowCnt"));
  const sums: number[] = [];
  for (let r = 0; r < rowCnt; r++) sums.push(cells.filter((c) => c.row <= r && r < c.row + c.rowSpan).reduce((n, c) => n + c.width, 0));
  return sums;
}

export { NS_HP };

// ── 독립 기준: 두 원문의 속성 차이 ───────────────────────────────────

type Node = { name: string; attrs: [string, string][]; children: Node[] };

function parseLoose(xml: string): Node {
  const root: Node = { name: "#root", attrs: [], children: [] };
  const stack: Node[] = [root];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g)) {
    const [, closing, name, attrText, selfClose] = m;
    if (closing === "/") {
      stack.pop();
      continue;
    }
    const attrs = [...(attrText ?? "").matchAll(/([\w:.-]+)="([^"]*)"/g)].map((a): [string, string] => [a[1] ?? "", a[2] ?? ""]);
    const node: Node = { name: name ?? "", attrs, children: [] };
    stack[stack.length - 1]?.children.push(node);
    if (selfClose !== "/") stack.push(node);
  }
  return root;
}

/**
 * 두 구역 원문의 차이를 요소 구조와 속성으로 비교한다(줄 배치 캐시는 먼저 뺀다). 구조(요소 이름·개수·순서)가 다르면 `structural`이다.
 * 같은 구조에서 속성값이 다른 곳은 `요소경로@속성: 이전→이후`로 모은다. 글 내용은 보지 않는다.
 */
export function attrDiff(before: string, after: string): { structural: boolean; diffs: string[] } {
  const a = parseLoose(stripLineSegs(before));
  const b = parseLoose(stripLineSegs(after));
  const diffs: string[] = [];
  let structural = false;
  const walk = (x: Node, y: Node, path: string): void => {
    if (x.name !== y.name || x.children.length !== y.children.length) {
      structural = true;
      return;
    }
    const names = new Set([...x.attrs.map((p) => p[0]), ...y.attrs.map((p) => p[0])]);
    for (const n of names) {
      const v = x.attrs.find((p) => p[0] === n)?.[1];
      const w = y.attrs.find((p) => p[0] === n)?.[1];
      if (v !== w) diffs.push(`${path}@${n}: ${v ?? "(없음)"}→${w ?? "(없음)"}`);
    }
    x.children.forEach((c, i) => {
      const d = y.children[i];
      if (d !== undefined) walk(c, d, `${path}/${c.name}[${i}]`);
    });
  };
  walk(a, b, "");
  return { structural, diffs };
}

// ── 편집 계약 확인 ────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { checkTableGeometry, validateDocument, type Issue } from "../src/index.ts";
import { verifyPreservation } from "../src/fill/index.ts";
import { newErrorsAfter } from "./helpers.ts";

/** 문서의 모든 표에서 `checkTableGeometry`가 낸 오류 코드를 표 순서대로 모은다. */
export function geometryCodes(doc: HwpxDocument): string[][] {
  return doc.sections.flatMap((_s, i) => tablesOf(doc, i)).map((t) => checkTableGeometry(t).map((x: Issue) => x.code));
}

/**
 * 계획을 적용하고 공통 계약을 확인한다: 보존 계약(편집 구간 밖 원문 동일), 다시 파싱됨, 검사기 새 오류 0,
 * 표 불변식이 원본보다 나빠지지 않음. 적용 결과를 돌려준다.
 */
export function applyChecked(doc: HwpxDocument, plan: EditPlan): { bytes: Uint8Array; doc: HwpxDocument } {
  const bytes = applyPlan(doc.pkg, plan);
  const issues = verifyPreservation(doc.pkg.bytes, bytes, plan);
  assert.deepEqual(issues.map((i) => `${i.code} ${i.message}`), []);
  const after = reparseBytes(bytes);
  assert.deepEqual(newErrorsAfter(validateDocument(doc.pkg.bytes), validateDocument(bytes)).map((e) => `${e.code} ${e.message}`), []);
  const before = geometryCodes(doc);
  const now = geometryCodes(after);
  now.forEach((codes, i) => {
    for (const code of codes) assert.ok(before[i]?.includes(code) === true || before[i] === undefined, `표 ${i}에 새 불변식 위반 ${code}`);
  });
  return { bytes, doc: after };
}
