// 서식 변경(S2b, 명세 7.7). 기존 서식 자원을 복제해 일부만 바꾸고, 같은 모양이 이미 있으면 그것을 쓴다. 변경은 전부 편집 계획(SpanEdit)이다.
// 오류 코드: FMT_KIND, FMT_BASE_NOT_FOUND, FMT_NO_LIST, FMT_UNKNOWN_CHILD, FMT_NO_PREFIX, FMT_PATH, FMT_BAD_OP, FMT_BAD_VALUE, FMT_FONT_NOT_FOUND,
//          FMT_TARGET, FMT_BAD_RANGE, FMT_NO_BASE, FMT_INTERNAL
export type { CharTarget, DeriveResult, FormatDelta, FormatKind, FormatOp, ParaTarget } from "./types.ts";
export { createDeriver, deriveResource, type Deriver } from "./derive.ts";
export { planApplyCharFormat, planApplyParaFormat } from "./apply.ts";
export {
  charDelta,
  EMPHASIS_MARKS,
  LANGS,
  OUTLINE_TYPES,
  SHADOW_TYPES,
  STRIKEOUT_SHAPES,
  UNDERLINE_SHAPES,
  UNDERLINE_TYPES,
  type CharFormat,
  type Lang,
  type LangValues,
} from "./char.ts";
export { ALIGNS, BREAK_LATIN_WORDS, BREAK_NON_LATIN_WORDS, LINE_SPACING_TYPES, paraDelta, type ParaFormat } from "./para.ts";
export { CHILD_ORDER, type ChildSpec } from "./order.ts";
