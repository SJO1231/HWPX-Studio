import { HwpxError } from "../errors.ts";
import { attrValue, childEl, type XElement } from "../xml/tree.ts";
import { readTableGrid, type TableGrid } from "./grid.ts";

export type GridNeeds = {
  /** 열 너비가 필요한 연산(비례 조정·열·병합·분할·열 수를 바꾸는 복제). 행끼리 열 경계가 어긋난 표(너비 불규칙)는 거절한다. */
  widths?: boolean;
  /** 셀 영역 목록(`cellzoneList`)이 있는 표는 셀 주소가 바뀌는 연산을 거절한다(영역의 주소를 고치지 않는다). */
  structure?: boolean;
};

/**
 * 격자를 돌려준다. 구조가 불규칙하면 `TABLE_IRREGULAR`, `needs.widths`인데 너비 불규칙이면 `TABLE_IRREGULAR`(사유가 다르다),
 * 셀 영역 목록 때문이면 `TABLE_UNSUPPORTED`.
 */
export function requireGrid(table: XElement, entry: string, needs: GridNeeds = {}): TableGrid {
  const grid = readTableGrid(table);
  if (grid.problems.length > 0) {
    throw new HwpxError("TABLE_IRREGULAR", `표 격자가 규칙적이지 않아 연산할 수 없습니다: ${grid.problems.join("; ")}`, entry);
  }
  if (needs.widths === true && grid.widths === undefined) {
    throw new HwpxError("TABLE_IRREGULAR", `열 너비를 정할 수 없습니다(행끼리 열 경계의 위치가 어긋납니다): ${grid.widthProblems.join("; ")}`, entry);
  }
  if (needs.structure === true && childEl(table, "paragraph", "cellzoneList") !== undefined) {
    throw new HwpxError("TABLE_UNSUPPORTED", "표에 셀 영역 목록(cellzoneList)이 있어 셀 주소가 바뀌는 연산을 지원하지 않습니다.", entry);
  }
  return grid;
}

/**
 * 표 크기 기준이 절대값(`ABSOLUTE`)인지 확인한다. 속성이 없으면 절대값으로 본다.
 * 비율 같은 다른 기준이면 `sz`의 수치가 HWPUNIT이 아니므로 그 방향의 크기를 쓰는 연산은 `TABLE_RELATIVE_SIZE`로 거절한다.
 */
export function requireAbsolute(table: XElement, dimension: "width" | "height", entry: string): void {
  const sz = childEl(table, "paragraph", "sz");
  const basis = sz === undefined ? undefined : attrValue(sz, dimension === "width" ? "widthRelTo" : "heightRelTo");
  if (basis !== undefined && basis !== "ABSOLUTE") {
    throw new HwpxError("TABLE_RELATIVE_SIZE", `표 ${dimension === "width" ? "너비" : "높이"}의 기준이 절대값이 아닙니다(${dimension === "width" ? "widthRelTo" : "heightRelTo"}="${basis}").`, entry);
  }
}
