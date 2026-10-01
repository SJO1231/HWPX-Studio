import { HwpxError } from "../errors.ts";
import type { HwpxDocument } from "../model/types.ts";
import type { FormatDelta, FormatOp } from "./types.ts";

export type Lang = "hangul" | "latin" | "hanja" | "japanese" | "other" | "symbol" | "user";
export const LANGS: readonly Lang[] = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"];

/** 언어 7종에 같은 값 하나, 또는 언어별 값(적은 언어만 바뀐다) */
export type LangValues = number | Partial<Record<Lang, number>>;

// 한컴 13이 저장한 문서에서 관측한 열거값
export const UNDERLINE_TYPES = ["BOTTOM", "CENTER", "TOP"] as const;
export const UNDERLINE_SHAPES = [
  "SOLID", "DOT", "DASH", "DASH_DOT", "DASH_DOT_DOT", "LONG_DASH", "CIRCLE", "DOUBLE_SLIM", "SLIM_THICK", "THICK_SLIM",
  "SLIM_THICK_SLIM", "WAVE", "DOUBLEWAVE", "THICK3D", "THICKREV3D", "3D",
] as const;
export const STRIKEOUT_SHAPES = UNDERLINE_SHAPES.slice(0, 14);
export const OUTLINE_TYPES = ["SOLID", "DOT", "THICK", "DASH", "DASH_DOT", "DASH_DOT_DOT"] as const;
export const SHADOW_TYPES = ["DROP", "CONTINUOUS"] as const;
export const EMPHASIS_MARKS = [
  "DOT_ABOVE", "RING_ABOVE", "TILDE", "CARON", "SIDE", "COLON", "GRAVE_ACCENT", "ACUTE_ACCENT", "CIRCUMFLEX", "MACRON", "HOOK_ABOVE", "DOT_BELOW",
] as const;

export type CharFormat = {
  /** 글자 크기(pt). 10.5 → height 1050 */
  size?: number;
  /** `#RRGGBB` */
  textColor?: string;
  /** `#RRGGBB` 또는 `"none"` */
  shadeColor?: string;
  bold?: boolean;
  italic?: boolean;
  /** `false`면 끈다 */
  underline?: false | { type?: (typeof UNDERLINE_TYPES)[number]; shape?: (typeof UNDERLINE_SHAPES)[number]; color?: string };
  strikeout?: false | { shape?: (typeof STRIKEOUT_SHAPES)[number]; color?: string };
  /** `true`는 `SOLID` */
  outline?: boolean | { type: (typeof OUTLINE_TYPES)[number] };
  shadow?: false | { type?: (typeof SHADOW_TYPES)[number]; color?: string; offsetX?: number; offsetY?: number };
  emboss?: boolean;
  engrave?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  /** 장평(%) 50~200 */
  ratio?: LangValues;
  /** 자간(%) -50~50 */
  spacing?: LangValues;
  /** 상대 크기(%) 10~250 */
  relSize?: LangValues;
  /** 글자 위치(%) -100~100 */
  offset?: LangValues;
  /** 강조점. `"NONE"`이면 끈다 */
  emphasis?: "NONE" | (typeof EMPHASIS_MARKS)[number];
  /** 글꼴 이름. 문자열은 그 이름이 있는 모든 언어에, 객체는 적은 언어에만 적용한다. 없으면 `FMT_FONT_NOT_FOUND` */
  font?: string | Partial<Record<Lang, string>>;
  kerning?: boolean;
};

const bad = (message: string): HwpxError => new HwpxError("FMT_BAD_VALUE", message);

function oneOf<T extends string>(what: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === value);
  if (found === undefined) throw bad(`${what} '${value}'은(는) 관측한 값이 아닙니다(${allowed.join(", ")}).`);
  return found;
}

function color(what: string, value: string): string {
  if (!/^#[0-9A-Fa-f]{6}$/.test(value)) throw bad(`${what} '${value}'은(는) #RRGGBB 형식이 아닙니다.`);
  return value.toUpperCase();
}

function int(what: string, value: number, min: number, max: number): string {
  if (!Number.isInteger(value) || value < min || value > max) throw bad(`${what} ${value}은(는) ${min}~${max}의 정수여야 합니다.`);
  return String(value);
}

const set = (path: string[], name: string, value: string): FormatOp => ({ op: "setAttr", path, name, value });
const flag = (name: string, on: boolean): FormatOp =>
  on ? { op: "addChild", path: [], name } : { op: "removeChild", path: [], name };

/** 언어별 속성(`ratio`·`spacing`·`relSz`·`offset`)의 연산들 */
function perLang(element: string, what: string, values: LangValues, min: number, max: number): FormatOp[] {
  const entries: [Lang, number][] =
    typeof values === "number"
      ? LANGS.map((l): [Lang, number] => [l, values])
      : (Object.entries(values) as [Lang, number | undefined][]).flatMap(([l, v]): [Lang, number][] => {
          if (!LANGS.includes(l)) throw bad(`${what}의 언어 '${l}'을(를) 알 수 없습니다.`);
          return v === undefined ? [] : [[l, v]];
        });
  return entries.map(([lang, v]) => set([element], lang, int(`${what}(${lang})`, v, min, max)));
}

/** 문서의 글꼴 목록에서 이름으로 글꼴 id를 찾는다. */
function fontId(doc: HwpxDocument, lang: Lang, face: string): string | undefined {
  const want = lang.toUpperCase();
  return doc.header.resources["font"]?.find((f) => f.lang === want && f.element.attrs.some((a) => a.qname === "face" && a.value === face))?.id;
}

/**
 * 진하게·기울임은 자식 요소(`<hh:bold/>`, `<hh:italic/>`)로 적는다. 한컴 13은 이 요소만 읽는다(속성 `bold="1"`만 있는 글자모양은 진하지 않게 읽었다).
 * 합성 문서 일부는 자식 요소에 더해 같은 이름의 속성(`bold="1"`)도 적는다. 그런 문서(그 이름의 속성이 있는 글자모양이 하나라도 있는 문서)에서는
 * 켤 때 속성도 함께 적어 기존 글자모양과 같은 모양이 되게 하고(재사용), 끌 때는 요소와 속성을 모두 지운다.
 */
function toggle(doc: HwpxDocument, name: "bold" | "italic", on: boolean): FormatOp[] {
  if (!on) return [flag(name, false), { op: "removeAttr", path: [], name }];
  const withAttr = (doc.header.resources["charPr"] ?? []).some((i) => i.element.attrs.some((a) => a.qname === name));
  return withAttr ? [flag(name, true), set([], name, "1")] : [flag(name, true)];
}

/**
 * 글자 서식 요청을 서식 변경 연산으로 바꾼다. 문서는 글꼴 이름 찾기와 진하게·기울임의 표기 형태 판별에 쓴다.
 * 요청에 없는 항목은 연산에 넣지 않는다(기준 글자모양 그대로).
 */
export function charDelta(doc: HwpxDocument, spec: CharFormat): FormatDelta {
  const ops: FormatOp[] = [];
  if (spec.size !== undefined) {
    const height = Math.round(spec.size * 100);
    if (!Number.isFinite(spec.size) || height < 10 || height > 409600) throw bad(`글자 크기 ${spec.size}pt이(가) 올바르지 않습니다.`);
    ops.push(set([], "height", String(height)));
  }
  if (spec.textColor !== undefined) ops.push(set([], "textColor", color("글자색", spec.textColor)));
  if (spec.shadeColor !== undefined) ops.push(set([], "shadeColor", spec.shadeColor === "none" ? "none" : color("음영색", spec.shadeColor)));
  if (spec.bold !== undefined) ops.push(...toggle(doc, "bold", spec.bold));
  if (spec.italic !== undefined) ops.push(...toggle(doc, "italic", spec.italic));

  if (spec.underline === false) {
    ops.push(set(["underline"], "type", "NONE"), set(["underline"], "shape", "SOLID"), set(["underline"], "color", "#000000"));
  } else if (spec.underline !== undefined) {
    const u = spec.underline;
    ops.push(
      set(["underline"], "type", oneOf("밑줄 위치", u.type ?? "BOTTOM", UNDERLINE_TYPES)),
      set(["underline"], "shape", oneOf("밑줄 모양", u.shape ?? "SOLID", UNDERLINE_SHAPES)),
      set(["underline"], "color", color("밑줄 색", u.color ?? "#000000")),
    );
  }
  if (spec.strikeout === false) {
    ops.push(set(["strikeout"], "shape", "NONE"), set(["strikeout"], "color", "#000000"));
  } else if (spec.strikeout !== undefined) {
    const k = spec.strikeout;
    ops.push(
      set(["strikeout"], "shape", oneOf("취소선 모양", k.shape ?? "SOLID", STRIKEOUT_SHAPES)),
      set(["strikeout"], "color", color("취소선 색", k.color ?? "#000000")),
    );
  }
  if (spec.outline !== undefined) {
    const type = spec.outline === false ? "NONE" : spec.outline === true ? "SOLID" : oneOf("외곽선 종류", spec.outline.type, OUTLINE_TYPES);
    ops.push(set(["outline"], "type", type));
  }
  if (spec.shadow === false) {
    ops.push(set(["shadow"], "type", "NONE"), set(["shadow"], "color", "#C0C0C0"), set(["shadow"], "offsetX", "10"), set(["shadow"], "offsetY", "10"));
  } else if (spec.shadow !== undefined) {
    const sh = spec.shadow;
    ops.push(
      set(["shadow"], "type", oneOf("그림자 종류", sh.type ?? "DROP", SHADOW_TYPES)),
      set(["shadow"], "color", color("그림자 색", sh.color ?? "#C0C0C0")),
      set(["shadow"], "offsetX", int("그림자 가로 간격", sh.offsetX ?? 10, -100, 100)),
      set(["shadow"], "offsetY", int("그림자 세로 간격", sh.offsetY ?? 10, -100, 100)),
    );
  }
  // 양각·음각, 위·아래첨자는 서로 배타다
  if (spec.emboss !== undefined) {
    ops.push(flag("emboss", spec.emboss));
    if (spec.emboss) ops.push(flag("engrave", false));
  }
  if (spec.engrave !== undefined) {
    ops.push(flag("engrave", spec.engrave));
    if (spec.engrave) ops.push(flag("emboss", false));
  }
  if (spec.superscript !== undefined) {
    ops.push(flag("supscript", spec.superscript));
    if (spec.superscript) ops.push(flag("subscript", false));
  }
  if (spec.subscript !== undefined) {
    ops.push(flag("subscript", spec.subscript));
    if (spec.subscript) ops.push(flag("supscript", false));
  }
  if (spec.ratio !== undefined) ops.push(...perLang("ratio", "장평", spec.ratio, 50, 200));
  if (spec.spacing !== undefined) ops.push(...perLang("spacing", "자간", spec.spacing, -50, 50));
  if (spec.relSize !== undefined) ops.push(...perLang("relSz", "상대 크기", spec.relSize, 10, 250));
  if (spec.offset !== undefined) ops.push(...perLang("offset", "글자 위치", spec.offset, -100, 100));
  if (spec.emphasis !== undefined) ops.push(set([], "symMark", spec.emphasis === "NONE" ? "NONE" : oneOf("강조점", spec.emphasis, EMPHASIS_MARKS)));
  if (spec.kerning !== undefined) ops.push(set([], "useKerning", spec.kerning ? "1" : "0"));

  if (spec.font !== undefined) {
    const wanted: [Lang, string][] =
      typeof spec.font === "string"
        ? LANGS.map((l): [Lang, string] => [l, spec.font as string])
        : (Object.entries(spec.font) as [Lang, string | undefined][]).flatMap(([l, v]): [Lang, string][] => {
            if (!LANGS.includes(l)) throw bad(`글꼴의 언어 '${l}'을(를) 알 수 없습니다.`);
            return v === undefined ? [] : [[l, v]];
          });
    let found = 0;
    for (const [lang, face] of wanted) {
      const id = fontId(doc, lang, face);
      if (id === undefined) {
        // 이름 하나를 모든 언어에 적용할 때는 그 이름이 없는 언어를 건너뛴다
        if (typeof spec.font === "string") continue;
        throw new HwpxError("FMT_FONT_NOT_FOUND", `${lang.toUpperCase()} 글꼴 '${face}'이(가) 문서의 글꼴 목록에 없습니다.`);
      }
      ops.push(set(["fontRef"], lang, id));
      found++;
    }
    if (found === 0) throw new HwpxError("FMT_FONT_NOT_FOUND", `글꼴 '${typeof spec.font === "string" ? spec.font : JSON.stringify(spec.font)}'이(가) 문서의 글꼴 목록에 없습니다.`);
  }
  return ops;
}
