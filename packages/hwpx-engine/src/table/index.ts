// 표 조정(S5, 명세 7.9). 표의 설정·크기·구조를 편집 계획(SpanEdit)으로 바꾼다. 문서를 직접 바꾸지 않고 적용은 `applyPlan`이 한다.
// 오류 코드: TABLE_NOT_FOUND, TABLE_BAD_ARG, TABLE_IRREGULAR, TABLE_SPAN_CONFLICT, TABLE_RELATIVE_SIZE, TABLE_UNSUPPORTED, TABLE_SPLITS_FIELD, TABLE_INTERNAL
// 경고 코드: TABLE_FRAGMENT_EXTRA
// 불변식 검사 오류 코드(checkTableGeometry): TABLE_CELL_PARTS, TABLE_COUNT, TABLE_ADDR, TABLE_WIDTH_SUM
export type {
  BorderSpec,
  CellPropsEntry,
  CellSelection,
  CellSettings,
  CopyText,
  Margins,
  Side,
  TableSettings,
  TableTarget,
} from "./types.ts";
export { BORDER_TYPES, HALIGNS, LINE_WRAPS, PAGE_BREAKS, VERT_ALIGNS } from "./types.ts";
export { readTableGrid, rowHeights, checkTableGeometry, intAttr, type GridCell, type TableGrid } from "./grid.ts";
export { listTables, type TableInfo } from "./find.ts";
export { planSetTableProps, planSetCellProps } from "./props.ts";
export { planSetColumnWidths, planScaleTable, planSetRowHeights, scaleWidths, scaleBounds } from "./size.ts";
export { planInsertRows, planRepeatRows, type InsertRowsOptions, type RepeatRowsOptions } from "./rows.ts";
export { planInsertColumns, planDeleteColumns, type InsertColumnsOptions } from "./cols.ts";
export { planMergeCells, planSplitCell, type MergeOptions } from "./merge.ts";
export { planCloneTable, type CloneOptions, type CloneSource } from "./clone.ts";
export { mergeTablePlans } from "./merge-plans.ts";
export { LINESEG_REASON } from "./edit.ts";
