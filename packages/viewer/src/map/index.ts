export { locatePicked, toEngineAddress, toRhwpPosition, paragraphAtAddress } from "./locate.ts";
export { hasNumbering } from "./numbering.ts";
export { guideFields, guideOf, type GuideField } from "./guides.ts";
export { controlSlots, type ControlSlot } from "./slots.ts";
export { offsetTable, logicalOffsetAt, noteLabelStarts, rhwpOffsetAt, type OffsetSlot, type OffsetTable } from "./offsets.ts";
export {
  REASONS,
  TABLE_CAPTION_CELL,
  type CellStep,
  type EngineAddress,
  type LocateEdge,
  type Located,
  type PickedPoint,
  type RhwpPosition,
  type Shown,
  type Unlocated,
} from "./types.ts";
