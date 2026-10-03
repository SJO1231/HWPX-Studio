import { HwpxError } from "../errors.ts";
import type { HwpxDocument } from "../model/types.ts";
import type { FormatDelta, FormatOp } from "./types.ts";

// 한컴 13이 저장한 문서에서 관측한 열거값
export const ALIGNS = ["JUSTIFY", "LEFT", "RIGHT", "CENTER", "DISTRIBUTE", "DISTRIBUTE_SPACE"] as const;
export const LINE_SPACING_TYPES = ["PERCENT", "FIXED", "BETWEEN_LINES", "AT_LEAST"] as const;
export const BREAK_LATIN_WORDS = ["KEEP_WORD", "HYPHENATION", "BREAK_WORD"] as const;
export const BREAK_NON_LATIN_WORDS = ["KEEP_WORD", "BREAK_WORD"] as const;

export type ParaFormat = {
  /** 정렬. 배분 정렬은 `DISTRIBUTE`, 나눔 정렬은 `DISTRIBUTE_SPACE` */
  align?: (typeof ALIGNS)[number];
  /** 줄 간격. `PERCENT`의 값은 %, 나머지는 HWPUNIT(1pt = 100) */
  lineSpacing?: { type: (typeof LINE_SPACING_TYPES)[number]; value: number };
  /** 왼쪽 여백(HWPUNIT) */
  marginLeft?: number;
  /** 오른쪽 여백(HWPUNIT) */
  marginRight?: number;
  /** 첫 줄 들여쓰기(양수)·내어쓰기(음수) (HWPUNIT) */
  indent?: number;
  /** 문단 앞 간격(HWPUNIT) */
  spaceBefore?: number;
  /** 문단 뒤 간격(HWPUNIT) */
  spaceAfter?: number;
  /** 줄 나눔 기준: 영어 단어 */
  breakLatinWord?: (typeof BREAK_LATIN_WORDS)[number];
  /** 줄 나눔 기준: 한글(비영어) */
  breakNonLatinWord?: (typeof BREAK_NON_LATIN_WORDS)[number];
  /** 문단 테두리·배경으로 쓸 테두리 자원 id(문서에 있어야 한다) */
  borderFillIDRef?: string;
  /** 탭 정의 id(문서에 있어야 한다) */
  tabPrIDRef?: string;
};

const bad = (message: string): HwpxError => new HwpxError("FMT_BAD_VALUE", message);

function oneOf<T extends string>(what: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === value);
  if (found === undefined) throw bad(`${what} '${value}'은(는) 관측한 값이 아닙니다(${allowed.join(", ")}).`);
  return found;
}

function units(what: string, value: number, min: number): number {
  if (!Number.isInteger(value) || value < min || value > 2147483647 / 2) throw bad(`${what} ${value}은(는) ${min} 이상의 정수여야 합니다.`);
  return value;
}

/**
 * 한컴 저장본의 여백·줄 간격은 `switch`의 `case`(HWPUNIT)와 `default`(그 2배)에 같은 이름으로 들어 있다(관측: 짝 40여 쌍 모두 2배).
 * 그래서 연산에 `defaultBranchValue`를 함께 싣는다. 갈래가 없는 문서(합성 문서)는 `value`를 쓴다.
 */
const dual = (path: string[], name: string, value: number): FormatOp => ({
  op: "setAttr",
  path,
  name,
  value: String(value),
  defaultBranchValue: String(value * 2),
});

function reference(doc: HwpxDocument, kind: "borderFill" | "tabPr", what: string, id: string): string {
  if (!(doc.header.resources[kind] ?? []).some((i) => i.id === id)) {
    throw new HwpxError("FMT_BASE_NOT_FOUND", `${what} ${id}이(가) header에 없습니다.`, doc.pkg.headerEntry);
  }
  return id;
}

/** 문단 서식 요청을 서식 변경 연산으로 바꾼다. 요청에 없는 항목은 연산에 넣지 않는다. */
export function paraDelta(doc: HwpxDocument, spec: ParaFormat): FormatDelta {
  const ops: FormatOp[] = [];
  if (spec.align !== undefined) ops.push({ op: "setAttr", path: ["align"], name: "horizontal", value: oneOf("정렬", spec.align, ALIGNS) });
  if (spec.lineSpacing !== undefined) {
    const type = oneOf("줄 간격 종류", spec.lineSpacing.type, LINE_SPACING_TYPES);
    const value = units("줄 간격 값", spec.lineSpacing.value, 0);
    if (type === "PERCENT" && value > 500) throw bad(`줄 간격 ${value}%은(는) 500%를 넘을 수 없습니다.`);
    ops.push({ op: "setAttr", path: ["lineSpacing"], name: "type", value: type });
    ops.push(type === "PERCENT" ? { op: "setAttr", path: ["lineSpacing"], name: "value", value: String(value) } : dual(["lineSpacing"], "value", value));
  }
  if (spec.marginLeft !== undefined) ops.push(dual(["margin", "left"], "value", units("왼쪽 여백", spec.marginLeft, 0)));
  if (spec.marginRight !== undefined) ops.push(dual(["margin", "right"], "value", units("오른쪽 여백", spec.marginRight, 0)));
  if (spec.indent !== undefined) {
    if (!Number.isInteger(spec.indent) || Math.abs(spec.indent) > 2147483647 / 2) throw bad(`들여쓰기·내어쓰기 ${spec.indent}은(는) 정수여야 합니다.`);
    ops.push(dual(["margin", "intent"], "value", spec.indent));
  }
  if (spec.spaceBefore !== undefined) ops.push(dual(["margin", "prev"], "value", units("문단 앞 간격", spec.spaceBefore, 0)));
  if (spec.spaceAfter !== undefined) ops.push(dual(["margin", "next"], "value", units("문단 뒤 간격", spec.spaceAfter, 0)));
  if (spec.breakLatinWord !== undefined) {
    ops.push({ op: "setAttr", path: ["breakSetting"], name: "breakLatinWord", value: oneOf("영어 줄 나눔", spec.breakLatinWord, BREAK_LATIN_WORDS) });
  }
  if (spec.breakNonLatinWord !== undefined) {
    ops.push({
      op: "setAttr",
      path: ["breakSetting"],
      name: "breakNonLatinWord",
      value: oneOf("한글 줄 나눔", spec.breakNonLatinWord, BREAK_NON_LATIN_WORDS),
    });
  }
  if (spec.borderFillIDRef !== undefined) {
    ops.push({ op: "setAttr", path: ["border"], name: "borderFillIDRef", value: reference(doc, "borderFill", "테두리 자원", spec.borderFillIDRef) });
  }
  if (spec.tabPrIDRef !== undefined) {
    ops.push({ op: "setAttr", path: [], name: "tabPrIDRef", value: reference(doc, "tabPr", "탭 정의", spec.tabPrIDRef) });
  }
  return ops;
}
