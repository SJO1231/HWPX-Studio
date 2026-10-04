// 제목 범위 시험(heading-range·heading-com·CLI)이 함께 쓰는 시험 문서와 기대 모형.
// 기대값은 명세 7.10 `headingRange`의 규칙(번호 글자 꼴, 기본 서열, 같은 부모 안에서 빈 단계 없는 단계, 다음 같은 단계 이상 제목 앞까지의 범위)을
// 시험이 적어 넣은 문단 목록(어느 문단이 어떤 꼴의 제목인가)에 적용해 세운다. 엔진의 탐지 결과를 기대값으로 옮겨 적지 않는다.
import { generate, type HeadingForm } from "../src/fill/index.ts";
import { readFixture, reparse } from "./helpers.ts";
import { done, ds, fragOf, HEADINGS, inject, insertText, KEEP, line, notice, tpl } from "./range-helpers.ts";

/**
 * 번호 글자 꼴과 같은 꼴 안의 아래 단계(조문: 장 0·절 1·조 2·항 3·호 4, 숫자+점: 점으로 이은 숫자 수 - 1, 나머지 0).
 * 기호(`box`)의 아래 단계는 모형이 목록 안에서 기호(글 머리 글자)가 처음 나온 순서로 정한다(`sub`는 쓰지 않는다).
 */
export type Mark = { form: HeadingForm; sub: number };
/** 모형의 문단 하나: 글(시험이 정한 것. 표 문단·원본 문단은 없을 수 있다), 굵기, 제목이면 그 꼴 */
export type Item = { text?: string; bold: boolean; mark?: Mark };
export type Line = Item & { text: string };

export const H = (form: HeadingForm, sub: number, text: string, bold = false): Line => ({ text, bold, mark: { form, sub } });
export const P = (text: string, bold = false): Line => ({ text, bold });

/** 명세 7.10의 기본 서열 */
export const SPEC_ORDER: readonly HeadingForm[] = ["article", "roman", "digitDot", "hangulDot", "digitParen", "hangulParen", "digitParens", "hangulParens", "circled", "box", "none"];
/** 합성 공고서의 굵은 글자모양(charPr 7, `<hh:bold/>`)으로 넣는 문단 모양 */
export const BOLD = { paraPrIDRef: "0", charPrIDRef: "7", styleIDRef: "0" } as const;

// ── 모형 ──────────────────────────────────────────────────────

/** 서열(`order`에 없는 꼴은 기본 서열대로 뒤에)에서 꼴의 위치 */
export function effectiveOrder(order?: readonly HeadingForm[]): HeadingForm[] {
  const given = (order ?? []).filter((f, i, all) => all.indexOf(f) === i);
  return [...given, ...SPEC_ORDER.filter((f) => !given.includes(f))];
}

/**
 * 한 목록의 제목 단계: 목록에 나타난 (꼴 서열, 아래 단계) 짝을 정렬해 1부터 빈 단계 없이 센다.
 * 기호 제목의 아래 단계는 그 목록에서 기호(글 머리 글자)가 처음 나온 순서다.
 */
export function levelsOf(items: readonly Item[], order?: readonly HeadingForm[]): Map<number, number> {
  const ord = effectiveOrder(order);
  const symbols: string[] = [];
  const subOf = (x: Item): number => {
    if (x.mark?.form !== "box") return x.mark?.sub ?? 0;
    const symbol = (x.text ?? "").trimStart()[0] ?? "";
    if (!symbols.includes(symbol)) symbols.push(symbol);
    return symbols.indexOf(symbol);
  };
  const keyed = items.map((x) => (x.mark === undefined ? undefined : ord.indexOf(x.mark.form) * 100 + subOf(x)));
  const keys = [...new Set(keyed.filter((k): k is number => k !== undefined))].sort((a, b) => a - b);
  const out = new Map<number, number>();
  keyed.forEach((k, i) => {
    if (k !== undefined) out.set(i, keys.indexOf(k) + 1);
  });
  return out;
}

/** 제목 `i`의 범위: 다음에 나오는 단계가 같거나 높은 제목의 앞 문단까지, 없으면 목록 끝까지 */
export function rangeOfModel(items: readonly Item[], i: number, order?: readonly HeadingForm[]): { from: number; to: number } {
  const levels = levelsOf(items, order);
  const own = levels.get(i);
  if (own === undefined) throw new Error(`모형의 문단 ${i}는 제목이 아니다`);
  for (let j = i + 1; j < items.length; j++) {
    const l = levels.get(j);
    if (l !== undefined && l <= own) return { from: i, to: j - 1 };
  }
  return { from: i, to: items.length - 1 };
}

/** 문서 모형: 최상위 목록과, 제목이 든 하위 목록(키는 `parentPath.join(",")`) */
export type Model = { top: Item[]; lists: Map<string, Item[]> };

export type Expected = { parentPath: number[]; index: number; form: HeadingForm; level: number; text: string; bold: boolean };

/** 모형에서 기대하는 제목(문서 순서: 문단 뒤에 그 문단의 하위 목록) */
export function expectedHeadings(model: Model, order?: readonly HeadingForm[]): Expected[] {
  const out: Expected[] = [];
  const push = (items: readonly Item[], parentPath: number[]): void => {
    const levels = levelsOf(items, order);
    items.forEach((x, i) => {
      const level = levels.get(i);
      if (x.mark !== undefined && level !== undefined) out.push({ parentPath, index: i, form: x.mark.form, level, text: (x.text ?? "").slice(0, 40), bold: x.bold });
      if (parentPath.length === 0) {
        const subs = [...model.lists.keys()]
          .map((k) => k.split(",").map(Number))
          .filter((k) => k.length === 2 && k[0] === i)
          .sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0));
        for (const k of subs) push(model.lists.get(k.join(",")) ?? [], k);
      }
    });
  };
  push(model.top, []);
  return out;
}

// ── 합성 문서 ─────────────────────────────────────────────────

/** 합성 공고서(range-helpers의 `notice`) 최상위 63문단의 모형: 제목은 `HEADINGS`의 `N. 제N장 사업 안내`(숫자+점 단일)뿐이다 */
function noticeTop(): Item[] {
  return Array.from({ length: 63 }, (_, i): Item => {
    const h = HEADINGS.indexOf(i);
    return h < 0 ? { bold: false } : { text: `${h + 1}. 제${h + 1}장 사업 안내`, bold: false, mark: { form: "digitDot", sub: 0 } };
  });
}

/** 표 칸 [12, 1]에 붙이는 문단(원래 6문단 뒤): 숫자+점 둘, 한글+점, 기호 */
export const CELL_LINES: Line[] = [
  H("digitDot", 0, "1. 칸 제목 하나"),
  P("칸 본문 {{담당자}} 내용 & <참고>"),
  H("hangulDot", 0, "가. 칸 소제목"),
  P("칸 본문 둘"),
  H("box", 0, "□ 칸 기호 항목"),
  H("digitDot", 0, "2. 칸 제목 둘"),
  P("칸 본문 셋 {{기관명}}"),
];

/** 최상위 끝(문단 62 뒤)에 붙이는 문단: 7종 꼴·다단·조문 장/절/조·굵은 제목, 제목이 아닌 것(번호 뒤 빈 글·문장 끝·긴 굵은 글 등) */
export const BLOCK: Line[] = [
  H("article", 0, "제1장 총칙"),
  H("article", 2, "제1조(목적) 이 공고는 {{사업명}}의 참가 절차와 제출 서류를 정하는 것을 목적으로 한다."),
  P("본문: {{기관명}}은 다음과 같이 공고합니다. 세부 사항 & <참고> \"인용\"과 '홑따옴표'."),
  H("article", 2, "제2조(정의) 이 공고에서 쓰는 말의 뜻은 다음과 같다."),
  P("본문 둘: {{담당자}}에게 {{연락처}}로 문의하십시오."),
  H("article", 0, "제2장 참가 자격"),
  H("article", 1, "제1절 일반 자격"),
  H("article", 2, "제3조의2(자격) 참가 자격은 다음과 같다."),
  P("본문 셋 {{project.name}} 기간 {{dates.start}} ~ {{dates.end}}."),
  H("roman", 0, "Ⅰ. 로마 숫자 큰 제목"),
  P("로마 숫자 아래 본문 {{사업명}}."),
  H("roman", 0, "Ⅱ 공백 로마 숫자 제목"),
  H("digitDot", 0, "7. 일반 사항"),
  H("digitDot", 1, "7.1. 세부 사항"),
  H("hangulDot", 0, "가. 첫째 항목 {{담당자}}"),
  P(`가 항목 본문입니다. ${"제출 서류는 원본 1부 & 사본 2부입니다. ".repeat(8)}`),
  H("hangulDot", 0, "나. 둘째 항목"),
  H("digitParens", 0, "(1) 괄호 숫자 항목"),
  H("digitParen", 0, "1) 닫는 괄호 항목"),
  H("hangulParens", 0, "(가) 괄호 한글 항목"),
  H("hangulParen", 0, "가) 닫는 괄호 한글 항목"),
  H("circled", 0, "① 동그라미 숫자 항목"),
  H("circled", 0, "⑴ 괄호 숫자 글자 항목"),
  H("circled", 0, "㉠ 동그라미 자모 항목"),
  H("circled", 0, "㉮ 동그라미 한글 항목"),
  H("circled", 0, "➀ 딩뱃 동그라미 항목"),
  H("circled", 0, "❶ 검은 동그라미 항목"),
  H("box", 0, "□ 네모 기호 항목"),
  H("box", 0, "- 줄표 기호 항목"),
  H("box", 0, "※ 참고 기호 항목"),
  H("box", 0, "◆ 마름모 기호 항목"),
  H("digitDot", 2, "7.1.1. 세세부 사항"),
  H("digitDot", 1, "7.2 점 없는 다단 세부"),
  H("digitDot", 0, "8. 점 번호 항목"),
  H("none", 0, "굵은 짧은 제목", true),
  P("굵은 제목 아래 본문 {{기관명}}."),
  P("굵은 문장으로 끝납니다.", true),
  P("굵은 글이 요로 끝나요", true),
  P("굵은 글이 다로 끝난다", true),
  P("아주 긴 굵은 글: 이 글은 사십 자를 넘도록 길게 이어 쓴 굵은 문단이므로 제목이 아니고 그냥 본문이지", true),
  P("1."),
  P("가.  "),
  P("□"),
  P("(가)"),
  P("제5조"),
  P("1.5배 늘어난 수치를 설명하는 문단"),
  P("(주)한컴 같은 약칭으로 시작하는 문단"),
  P("2024. 10. 4. 날짜로 시작하는 문단"),
  P("Ⅲ."),
  P("I. ASCII 알파벳 I로 시작하는 문단"),
  P("-5도 영하 기온을 적은 문단"),
  P("8 공백 번호 문단(점 없는 숫자)"),
  P("20  .   .   ."),
  P("3 개월 이내 완료"),
  P("10. 4.(금) 18:00까지 제출"),
  H("digitDot", 0, "12. 두 자리 번호 제목"),
  H("digitDot", 0, "9. 마지막 장"),
  P("마지막 본문 하나 {{사업명}}"),
  P("마지막 본문 둘"),
  P("마지막 본문 셋"),
];
/** 표 복사본의 칸(끝)에만 더 붙이는 문단: 그 칸에만 있는 제목 */
export const COPY_CELL_LINES: Line[] = [P("복사본 칸 덧붙인 본문"), H("digitDot", 0, "3. 복사본 칸 제목"), P("복사본 칸 본문")];

/** `BLOCK`에서 그 줄 뒤에 표를 넣는 줄 번호: 칸 [12, 1]에 제목이 든 표의 복사본, `tables/tables-rich`의 표 */
export const COPY_AFTER = 15;
export const RICH_AFTER = 35;

/** 줄들을 굵기가 같은 연속 묶음마다 insertText 규칙 하나로(같은 앵커 뒤 삽입은 규칙 순서대로 놓인다) */
export function insertLines(prefix: string, anchor: string, lines: readonly Line[]): unknown[] {
  const groups: Line[][] = [];
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0]?.bold === l.bold) last.push(l);
    else groups.push([l]);
  }
  return groups.map((g, k) =>
    g[0]?.bold === true
      ? { id: `${prefix}${k}`, do: { type: "insertText", anchor, position: "after", value: { text: g.map((l) => l.text).join("\n") }, style: BOLD } }
      : insertText(`${prefix}${k}`, anchor, g.map((l) => l.text).join("\n"), "after"),
  );
}

/**
 * 제목 시험 문서: 합성 공고서(자리 수십 개, 표 4개) 뒤에 `BLOCK`을 붙이고, 칸 [12, 1]에 `CELL_LINES`를 붙이고,
 * `BLOCK[COPY_AFTER]` 뒤에 문단 12(칸 제목이 든 표)의 복사본을, `BLOCK[RICH_AFTER]` 뒤에 `tables/tables-rich`의 표를 넣고, 복사본의 칸 끝에 `COPY_CELL_LINES`를 붙인다.
 * 칸 [12, 1]의 제목은 복사본 칸에도 있다(같은 지문이 두 곳). 엔진의 insertText·inject로 만든다.
 */
let docCache: { bytes: Uint8Array; model: Model } | undefined;
export function headingDoc(): { bytes: Uint8Array; model: Model } {
  if (docCache !== undefined) return docCache;
  const base = notice();
  const d0 = reparse(base);
  const step1 = done(generate(base, tpl([line(d0, "end", [62]), line(d0, "cell", [12, 1, 5])], [...insertLines("b", "end", BLOCK), insertText("c", "cell", CELL_LINES.map((l) => l.text).join("\n"), "after")]), ds({}), KEEP));
  const d1 = reparse(step1.output);
  const rich = fragOf(reparse(readFixture("tables/tables-rich")), 1, 1);
  const step2 = done(
    generate(step1.output, tpl([line(d1, "copy", [63 + COPY_AFTER]), line(d1, "rich", [63 + RICH_AFTER])], [inject("tc", "copy", fragOf(d1, 12, 12), "after"), inject("tr", "rich", rich, "after")]), ds({}), KEEP),
  );
  const copyAt = 63 + COPY_AFTER + 1;
  const cell: Item[] = [...Array.from({ length: 6 }, (): Item => ({ bold: false })), ...CELL_LINES];
  const d2 = reparse(step2.output);
  const step3 = done(generate(step2.output, tpl([line(d2, "cc", [copyAt, 1, cell.length - 1])], [insertText("cc", "cc", COPY_CELL_LINES.map((l) => l.text).join("\n"), "after")]), ds({}), KEEP));
  const top: Item[] = [...noticeTop()];
  BLOCK.forEach((l, j) => {
    top.push(l);
    if (j === COPY_AFTER || j === RICH_AFTER) top.push({ bold: false });
  });
  docCache = { bytes: step3.output, model: { top, lists: new Map([["12,1", cell], [`${copyAt},1`, [...cell, ...COPY_CELL_LINES]]]) } };
  return docCache;
}

/** 모형의 최상위 목록에서 글이 `text`로 시작하는 제목의 번호 */
export function headingIndex(model: Model, text: string): number {
  const i = model.top.findIndex((x) => x.mark !== undefined && x.text?.startsWith(text) === true);
  if (i < 0) throw new Error(`모형에 '${text}' 제목이 없다`);
  return i;
}
