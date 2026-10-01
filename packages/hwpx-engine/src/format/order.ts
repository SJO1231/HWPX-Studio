/**
 * 서식 자원의 자식 요소 순서. 새 자식을 만들 때 이 순서를 따라 자리를 정하고, 여기에 없는 자식은 만들지 않는다(`FMT_UNKNOWN_CHILD`).
 *
 * 출처(전부 관측): `test/fixtures`의 문서 18개의 header와, 한컴 13이 서식을 적용해 저장한 시험 문서.
 * - charPr: fontRef, ratio, spacing, relSz, offset, italic, bold, underline, strikeout, outline, shadow, emboss, engrave, supscript, subscript.
 *   (italic부터 subscript까지 전부를 켜서 저장한 글자모양 하나에서 이 순서를 확인했다)
 * - paraPr: align, heading, breakSetting, autoSpacing, margin, lineSpacing, border (한컴 저장본은 heading과 margin·lineSpacing이 `switch`로 감싸져 있다)
 * - borderFill: slash, backSlash, leftBorder, rightBorder, topBorder, bottomBorder, diagonal, fillBrush(core)
 * - margin: intent, left, right, prev, next (core)
 * - fillBrush: winBrush 또는 gradation (core, 둘 중 하나)
 */
export type ChildSpec = { name: string; role: string };

const head = (...names: string[]): ChildSpec[] => names.map((name) => ({ name, role: "head" }));
const core = (...names: string[]): ChildSpec[] => names.map((name) => ({ name, role: "core" }));

export const CHILD_ORDER: Record<string, ChildSpec[]> = {
  charPr: head(
    "fontRef",
    "ratio",
    "spacing",
    "relSz",
    "offset",
    "italic",
    "bold",
    "underline",
    "strikeout",
    "outline",
    "shadow",
    "emboss",
    "engrave",
    "supscript",
    "subscript",
  ),
  paraPr: head("align", "heading", "breakSetting", "autoSpacing", "margin", "lineSpacing", "border"),
  borderFill: [
    ...head("slash", "backSlash", "leftBorder", "rightBorder", "topBorder", "bottomBorder", "diagonal"),
    ...core("fillBrush"),
  ],
  margin: core("intent", "left", "right", "prev", "next"),
  fillBrush: core("winBrush", "gradation"),
};
