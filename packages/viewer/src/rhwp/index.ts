export { ViewerError, toViewerError } from "./errors.ts";
export { loadRhwp, isRhwpLoaded, type RhwpSource } from "./load.ts";
export { openDocument, type Area, type Hit, type HitRegion, type PageInfo, type Pick, type PickLimit, type ViewerDocument } from "./document.ts";
export { caretIndex, classifyPoint, glyphIndexAt, glyphsAt, isMarkerRun, nearestLineRun, nearestRunOf, type GlyphHit, type PointClass } from "./pick.ts";
export {
  MARKER_PARA_MIN,
  caretAt,
  guideRect,
  charRect,
  hasDocCoords,
  insideAny,
  regionBoxes,
  rangeCover,
  rangeRects,
  runLength,
  runPosition,
  samePosition,
  sameParagraph,
  type LayoutRun,
  type PageLayout,
  type RegionBoxes,
  type Rect,
} from "./layout.ts";
