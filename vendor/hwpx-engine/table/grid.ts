import { makeIssue, type Issue } from "../errors.ts";
import { attrValue, childEl, childEls, type XElement } from "../xml/tree.ts";

/** 표 셀 하나. 주소·병합·크기는 `cellAddr`·`cellSpan`·`cellSz`에서 읽은 값이다. */
export type GridCell = {
  tc: XElement;
  tr: XElement;
  /** 이 셀이 든 `tr`의 순서(0부터) */
  trIndex: number;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  width: number;
  height: number;
  addr: XElement | undefined;
  span: XElement | undefined;
  size: XElement | undefined;
};

export type TableGrid = {
  table: XElement;
  /** `tr` 요소(문서 순서) */
  rows: XElement[];
  cells: GridCell[];
  /** `rowCnt`·`colCnt` 속성의 선언값. 읽지 못하면 셀이 덮는 범위를 쓴다. */
  rowCnt: number;
  colCnt: number;
  /**
   * 구조 불규칙의 사유. 비어 있으면 구조가 규칙적인 격자다(모든 칸을 셀이 정확히 한 번씩 덮고,
   * `rowCnt`·`colCnt`가 맞고, 셀이 자기 행의 `tr`에 있고, 셀마다 주소·병합·크기가 있다). 구조가 불규칙하면 구조·크기 연산은 모두 거절한다.
   * 구조가 규칙적이어도 열 너비가 모순이면(`widthProblems`) 열 너비가 필요한 연산만 거절한다.
   */
  problems: string[];
  /**
   * 열 경계의 위치(길이 `colCnt + 1`, 맨 왼쪽이 0). 행마다 셀을 왼쪽부터 놓아(위에서 내려온 세로 병합 셀 포함) 누적 합으로 구한다.
   * 어느 행에서도 셀 가장자리가 아닌 경계(병합 셀로만 덮인 열 묶음의 안쪽)는 양옆의 아는 경계 사이를 균등하게 나눈다(나머지는 묶음의 마지막 열).
   * 구조가 규칙적이지 않거나 행끼리 경계 위치가 어긋나면 undefined.
   */
  xBounds: number[] | undefined;
  /**
   * 열 너비 = 이웃 열 경계의 차. `xBounds`가 있고 모든 열이 1 이상일 때만 있다.
   * 열 너비가 필요한 연산(비례 조정·열·병합·분할·열 수를 바꾸는 복제)만 이것을 요구하고, 행 연산·열 너비 지정은 요구하지 않는다.
   */
  widths: number[] | undefined;
  /**
   * 열 너비를 정할 수 없는 사유(너비 불규칙). 구조가 규칙적인데 행끼리 열 경계의 위치를 다르게 말하거나(행마다 셀 너비 합이 다른 경우 포함)
   * 열 너비가 1 미만이 되면 담긴다. 구조가 규칙적이지 않으면 비어 있다(그때는 `problems`가 사유다). 표 `sz@width`와의 차이는 사유가 아니다.
   */
  widthProblems: string[];
  /**
   * 행 높이. 열마다 셀을 위에서부터 놓아 같은 방식으로 행 경계를 구해 차를 낸다. 열끼리 행 경계가 어긋나면(한 행의 셀 높이가 서로 다른 표 등)
   * 행마다 그 행에서 시작하는 rowSpan 1 셀 높이의 최댓값을 쓰고(한컴은 행의 셀 가운데 가장 큰 높이로 그린다) 그런 셀이 없는 행은 걸친 병합 셀의 남는 높이를 균등 분배한다.
   * 구조가 규칙적이지 않으면 undefined.
   */
  heights: number[] | undefined;
  /** 칸 (row, col)을 덮는 셀. 범위 밖이거나 비어 있으면 undefined. 겹치면 문서 순서로 앞선 셀이다. */
  at(row: number, col: number): GridCell | undefined;
};

const INT = /^-?\d+$/;

/** 정수 속성값. 없거나 정수가 아니면 undefined. */
export function intAttr(el: XElement | undefined, name: string): number | undefined {
  if (el === undefined) return undefined;
  const v = attrValue(el, name);
  return v !== undefined && INT.test(v) ? Number(v) : undefined;
}

/** 격자 칸 수의 상한(잘못된 선언값이 큰 배열을 만들지 않게 한다). */
const MAX_SLOTS = 4_000_000;

/**
 * `tbl` 요소의 행×열 격자를 읽는다. 이 함수는 던지지 않는다. 규칙적이지 않은 사유는 `problems`에 담긴다.
 * 구조·크기 연산은 `problems`가 비어 있을 때만 한다(`TABLE_IRREGULAR`).
 */
export function readTableGrid(table: XElement): TableGrid {
  const problems: string[] = [];
  const rows = childEls(table, "paragraph", "tr");
  const cells: GridCell[] = [];
  let missingParts = 0;
  rows.forEach((tr, trIndex) => {
    for (const tc of childEls(tr, "paragraph", "tc")) {
      const addr = childEl(tc, "paragraph", "cellAddr");
      const span = childEl(tc, "paragraph", "cellSpan");
      const size = childEl(tc, "paragraph", "cellSz");
      const row = intAttr(addr, "rowAddr");
      const col = intAttr(addr, "colAddr");
      const rowSpan = intAttr(span, "rowSpan");
      const colSpan = intAttr(span, "colSpan");
      const width = intAttr(size, "width");
      const height = intAttr(size, "height");
      if (row === undefined || col === undefined || rowSpan === undefined || colSpan === undefined || width === undefined || height === undefined) {
        missingParts++;
        continue;
      }
      cells.push({ tc, tr, trIndex, row, col, rowSpan, colSpan, width, height, addr, span, size });
    }
  });
  if (missingParts > 0) problems.push(`cellAddr·cellSpan·cellSz 값을 읽지 못한 셀 ${missingParts}개`);

  const rowCntAttr = intAttr(table, "rowCnt");
  const colCntAttr = intAttr(table, "colCnt");
  if (rowCntAttr === undefined || colCntAttr === undefined) problems.push("rowCnt·colCnt 속성이 없거나 정수가 아님");
  let maxRow = 0;
  let maxCol = 0;
  for (const c of cells) {
    maxRow = Math.max(maxRow, c.row + c.rowSpan);
    maxCol = Math.max(maxCol, c.col + c.colSpan);
  }
  const rowCnt = rowCntAttr ?? maxRow;
  const colCnt = colCntAttr ?? maxCol;
  if (rowCntAttr !== undefined && rowCntAttr !== rows.length) problems.push(`rowCnt(${rowCntAttr})와 tr 수(${rows.length})가 다름`);
  if (rowCntAttr !== undefined && maxRow !== rowCntAttr && cells.length > 0) problems.push(`rowCnt(${rowCntAttr})와 셀이 덮는 행 수(${maxRow})가 다름`);
  if (colCntAttr !== undefined && maxCol !== colCntAttr && cells.length > 0) problems.push(`colCnt(${colCntAttr})와 셀이 덮는 열 수(${maxCol})가 다름`);

  const slots: (GridCell | undefined)[] = [];
  const inBounds = rowCnt >= 0 && colCnt >= 0 && rowCnt * colCnt <= MAX_SLOTS;
  if (!inBounds) problems.push("표 크기 선언이 격자를 만들기에 너무 큼");
  let overlap = 0;
  let outside = 0;
  let badTr = 0;
  let badSpan = 0;
  if (inBounds) {
    slots.length = rowCnt * colCnt;
    for (const c of cells) {
      if (c.rowSpan < 1 || c.colSpan < 1 || c.row < 0 || c.col < 0) {
        badSpan++;
        continue;
      }
      if (c.row + c.rowSpan > rowCnt || c.col + c.colSpan > colCnt) {
        outside++;
        continue;
      }
      if (c.trIndex !== c.row) badTr++;
      for (let r = c.row; r < c.row + c.rowSpan; r++) {
        for (let k = c.col; k < c.col + c.colSpan; k++) {
          const i = r * colCnt + k;
          if (slots[i] === undefined) slots[i] = c;
          else overlap++;
        }
      }
    }
    let holes = 0;
    for (let i = 0; i < rowCnt * colCnt; i++) if (slots[i] === undefined) holes++;
    if (holes > 0 && outside === 0 && badSpan === 0) problems.push(`어떤 셀도 덮지 않는 칸 ${holes}개`);
  }
  if (badSpan > 0) problems.push(`병합 수나 주소가 올바르지 않은 셀 ${badSpan}개`);
  if (outside > 0) problems.push(`rowCnt×colCnt 밖으로 나가는 셀 ${outside}개`);
  if (overlap > 0) problems.push(`다른 셀과 겹치는 칸 ${overlap}개`);
  if (badTr > 0) problems.push(`자기 행의 tr에 들어 있지 않은 셀 ${badTr}개`);

  const grid: TableGrid = {
    table,
    rows,
    cells,
    rowCnt,
    colCnt,
    problems,
    xBounds: undefined,
    widths: undefined,
    widthProblems: [],
    heights: undefined,
    at: (row, col) => (inBounds && row >= 0 && col >= 0 && row < rowCnt && col < colCnt ? slots[row * colCnt + col] : undefined),
  };
  if (problems.length === 0) {
    const x = columnBounds(grid);
    grid.widthProblems = x.problems;
    if (x.problems.length === 0) {
      grid.xBounds = x.bounds;
      grid.widths = x.bounds.slice(1).map((b, i) => b - (x.bounds[i] ?? 0));
    }
    grid.heights = rowHeightsOf(grid);
  }
  return grid;
}

/** 줄(행 또는 열 방향) 하나를 따라 놓인 셀: 시작 칸, 걸친 칸 수, 그 방향의 크기 */
type Run = { start: number; span: number; size: number };

/**
 * 줄마다 셀을 놓아 경계 위치를 구한다. 줄 하나가 말하는 위치는 누적 합이다. 줄들이 한 경계의 위치를 다르게 말하면 모순이다.
 * 아무 줄도 말하지 않은 경계는 양옆의 아는 경계 사이를 균등하게 나눈다(나머지는 묶음의 마지막 칸).
 * 칸 하나의 크기가 `min` 미만이 되면 모순으로 본다. `what`은 사유 문구(열·행)에 쓴다.
 */
function boundsFrom(count: number, lines: Run[][], what: "열" | "행", min: number): { bounds: number[]; problems: string[] } {
  const pos: (number | undefined)[] = new Array<number | undefined>(count + 1).fill(undefined);
  const said: number[] = new Array<number>(count + 1).fill(-1);
  const problems: string[] = [];
  const line = (i: number): string => `${what === "열" ? "행" : "열"} ${i}`;
  lines.forEach((runs, li) => {
    let acc = 0;
    const put = (index: number, value: number): void => {
      const known = pos[index];
      if (known === undefined) {
        pos[index] = value;
        said[index] = li;
      } else if (known !== value && problems.length === 0) {
        problems.push(`${what} 경계 ${index}의 위치를 ${line(said[index] ?? 0)}은(는) ${known}, ${line(li)}은(는) ${value}(으)로 달리 말합니다`);
      }
    };
    for (const run of runs) {
      put(run.start, acc);
      acc += run.size;
      put(run.start + run.span, acc);
    }
  });
  if (pos[0] === undefined) pos[0] = 0;
  let a = 0;
  for (let b = 1; b <= count; b++) {
    if (pos[b] === undefined) continue;
    const gap = b - a;
    const from = pos[a] ?? 0;
    const width = (pos[b] ?? 0) - from;
    if (gap > 1) {
      const each = Math.floor(width / gap);
      for (let k = 1; k < gap; k++) pos[a + k] = from + each * k;
    }
    a = b;
  }
  const bounds = pos.map((v) => v ?? 0);
  if (problems.length === 0) {
    for (let i = 0; i < count; i++) {
      const size = (bounds[i + 1] ?? 0) - (bounds[i] ?? 0);
      if (size < min) {
        problems.push(`${what} ${i}의 ${what === "열" ? "너비" : "높이"}가 ${min} 미만(${size})입니다`);
        break;
      }
    }
  }
  return { bounds, problems };
}

/** 구조가 규칙적인 격자의 열 경계 */
function columnBounds(grid: TableGrid): { bounds: number[]; problems: string[] } {
  const lines: Run[][] = [];
  for (let r = 0; r < grid.rowCnt; r++) {
    const runs: Run[] = [];
    for (let c = 0; c < grid.colCnt; ) {
      const cell = grid.at(r, c);
      if (cell === undefined) break;
      runs.push({ start: cell.col, span: cell.colSpan, size: cell.width });
      c = cell.col + cell.colSpan;
    }
    lines.push(runs);
  }
  return boundsFrom(grid.colCnt, lines, "열", 1);
}

/** 구조가 규칙적인 격자의 행 높이(경계 방식, 모순이면 행마다 최댓값) */
function rowHeightsOf(grid: TableGrid): number[] {
  const lines: Run[][] = [];
  for (let c = 0; c < grid.colCnt; c++) {
    const runs: Run[] = [];
    for (let r = 0; r < grid.rowCnt; ) {
      const cell = grid.at(r, c);
      if (cell === undefined) break;
      runs.push({ start: cell.row, span: cell.rowSpan, size: cell.height });
      r = cell.row + cell.rowSpan;
    }
    lines.push(runs);
  }
  const y = boundsFrom(grid.rowCnt, lines, "행", 0);
  if (y.problems.length === 0) return y.bounds.slice(1).map((b, i) => b - (y.bounds[i] ?? 0));
  return heightsByRowMax(grid);
}

/** 행 높이(`TableGrid.heights`). 구조가 규칙적이지 않으면 undefined. */
export function rowHeights(grid: TableGrid): number[] | undefined {
  return grid.heights;
}

/**
 * 열끼리 행 경계가 어긋날 때의 행 높이. 그 행에서 시작하는 rowSpan 1 셀들의 `cellSz@height` 가운데 가장 큰 값이다.
 * 그런 셀이 없는 행은 그 행을 걸친 병합 셀의 높이에서 아는 행의 높이를 뺀 나머지를 모르는 행에 균등 분배한다(나머지는 마지막 행).
 */
function heightsByRowMax(grid: TableGrid): number[] {
  const heights: (number | undefined)[] = new Array<number | undefined>(grid.rowCnt).fill(undefined);
  for (const c of grid.cells) {
    if (c.rowSpan !== 1) continue;
    heights[c.row] = Math.max(heights[c.row] ?? 0, c.height);
  }
  const spanning = grid.cells.filter((c) => c.rowSpan > 1).sort((a, b) => a.rowSpan - b.rowSpan);
  for (const c of spanning) {
    const unknown: number[] = [];
    let sum = 0;
    for (let k = c.row; k < c.row + c.rowSpan; k++) {
      const h = heights[k];
      if (h === undefined) unknown.push(k);
      else sum += h;
    }
    if (unknown.length === 0) continue;
    const rest = Math.max(0, c.height - sum);
    const each = Math.floor(rest / unknown.length);
    unknown.forEach((k, i) => {
      heights[k] = i === unknown.length - 1 ? rest - each * (unknown.length - 1) : each;
    });
  }
  return heights.map((h) => h ?? 0);
}

/**
 * 표의 불변식을 검사한다(테스트와 스트레스가 쓴다. 검사기 `src/validate`에는 넣지 않는다). 전부 오류 등급이다.
 * - `TABLE_CELL_PARTS`: 셀의 cellAddr·cellSpan·cellSz 누락
 * - `TABLE_COUNT`: rowCnt·colCnt 속성과 tr 수·셀이 덮는 범위
 * - `TABLE_ADDR`: 셀 주소의 범위·유일성, 병합 겹침, 빈 칸, 자기 행의 tr
 * - `TABLE_WIDTH_SUM`: (1) 행마다 그 행을 덮는 셀을 왼쪽부터 놓아 구한 열 경계의 위치가 행끼리 같아야 한다(행마다 셀 너비 합이 같고 병합 셀 경계가 서로 맞아야 한다),
 *   열 너비가 1 이상이어야 한다. (2) 그 합이 표 `sz@width`와 같아야 한다. 원본이 이 관계를 만족하지 않았다면 호출자가
 *   원본의 같은 검사 결과와 견줘 새로 생긴 것만 본다.
 */
export function checkTableGeometry(table: XElement): Issue[] {
  const issues: Issue[] = [];
  const grid = readTableGrid(table);
  const where = `tbl id=${attrValue(table, "id") ?? "?"}`;
  const add = (code: string, message: string): void => void issues.push(makeIssue("error", code, message, where));
  for (const p of grid.problems) {
    if (p.startsWith("cellAddr")) add("TABLE_CELL_PARTS", p);
    else if (p.startsWith("rowCnt") || p.startsWith("colCnt")) add("TABLE_COUNT", p);
    else add("TABLE_ADDR", p);
  }
  // 열 경계가 모순이면 행마다 셀 너비 합이 다르다는 같은 사정이므로 표 너비와의 대조는 하지 않는다(위반 하나만 보고한다)
  for (const p of grid.widthProblems.slice(0, 1)) add("TABLE_WIDTH_SUM", p);
  const width = intAttr(childEl(table, "paragraph", "sz"), "width");
  if (width !== undefined && grid.cells.length > 0 && grid.problems.length === 0 && grid.widthProblems.length === 0) {
    for (let r = 0; r < grid.rowCnt; r++) {
      const seen = new Set<GridCell>();
      let sum = 0;
      for (let c = 0; c < grid.colCnt; c++) {
        const cell = grid.at(r, c);
        if (cell !== undefined && !seen.has(cell)) {
          seen.add(cell);
          sum += cell.width;
        }
      }
      if (sum !== width) {
        add("TABLE_WIDTH_SUM", `행 ${r}의 셀 너비 합 ${sum}이(가) 표 너비 ${width}와 다름`);
        break;
      }
    }
  }
  return issues;
}
