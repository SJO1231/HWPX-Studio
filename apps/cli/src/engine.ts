// 엔진 공개 목록. 엔진의 `src/index.ts`는 템플릿·채움 폴더를 내보내지 않으므로 폴더별 index에서 직접 가져온다.
export {
  HwpxError,
  openPackage,
  parseDocument,
  listFields,
  listTables,
  exportModel,
  extractFragment,
  serializeFragment,
  readArchive,
  readEntry,
  walkParagraphs,
  type Issue,
  type FragmentSelection,
  type TableInfo,
} from "../../../packages/hwpx-engine/src/index.ts";
export {
  generate,
  findCandidates,
  compileDocument,
  makeLineAnchor,
  censusOfDoc,
  type GateMode,
  type GenerateResult,
} from "../../../packages/hwpx-engine/src/fill/index.ts";
export {
  readTemplate,
  readDataset,
  emptyTemplate,
  fragmentPaths,
  findPlaceholders,
  type Template,
  type MissingPolicy,
  type FillReport,
} from "../../../packages/hwpx-engine/src/template/index.ts";
export { generateText, parseText, type TextKind, type TextResult } from "../../../packages/hwpx-engine/src/text/index.ts";
export { validateDocument, compareToBaseline } from "../../../packages/hwpx-engine/src/validate/index.ts";
