export { locateInCell, locatePicked, toEngineAddress, toRhwpPosition, paragraphAtAddress } from "./locate.ts";
export { hasNumbering } from "./numbering.ts";
export { guideFields, guideOf, type GuideField } from "./guides.ts";
export { controlSlots, type ControlSlot } from "./slots.ts";
export { offsetTable, logicalOffsetAt, noteLabelStarts, rhwpOffsetAt, type OffsetSlot, type OffsetTable } from "./offsets.ts";
export {
  REASONS,
  TABLE_CAPTION_CELL,
  type CellRef,
  type CellRun,
  type CellStep,
  type EngineAddress,
  type LocateEdge,
  type Located,
  type PickedPoint,
  type RhwpPosition,
  type Shown,
  type TableStep,
  type Unlocated,
} from "./types.ts";
