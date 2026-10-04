import type { HwpxDocument, ParagraphNode } from "../model/types.ts";
import { attrValue, childEl } from "../xml/tree.ts";
import { HEADING_FORMS, type Heading, type HeadingForm, type HeadingRangeAnchor } from "./anchor-types.ts";
import { listAtParent, paragraphHash, paragraphLists, rangePrintOf, samePrint, type FoundRange, type RangeLocation } from "./range.ts";

// 제목 탐지와 제목 범위 앵커(7.10 `headingRange`). 제목은 문단 글 머리의 번호 글자로 꼴을 정하고, 번호 글자가 없으면 굵기·길이로 본다.
// 단계는 같은 부모(문단 목록) 안에서 실제로 나타난 꼴만 서열대로 빈 단계 없이 센다. 범위는 같은 부모의 연속 문단이라 해석 결과는 `range`와 같다.

/** 지문·결과에 담는 글 길이(`range`·`line` 앵커와 같다) */
const PRINT_TEXT = 40;

/** 앵커 초안: `id`는 템플릿에 넣는 쪽이 정한다. */
export type HeadingRangeDraft = Omit<HeadingRangeAnchor, "id">;

/** `order`: 꼴의 서열(앞이 높은 단계). 빠진 꼴은 그 뒤에 기본 서열대로 붙는다. */
export type HeadingOptions = { order?: readonly HeadingForm[] };

/** 기본 서열: `HEADING_FORMS`의 순서(조문 장 > 절 > 조 > 항 > 호, 숫자+점 다단은 점 수만큼, 기호는 처음 나온 순서만큼 아래) */
const DEFAULT_ORDER: readonly HeadingForm[] = HEADING_FORMS;

// ── 번호 글자 ─────────────────────────────────────────────────

/** 개체 자리 글자(구역 설정·단 설정·표 등이 문단 앞에 있으면 글 앞에 놓인다) */
const OBJ = String.fromCharCode(0xfffc);
/** 글 머리에서 건너뛰는 글자: 공백류와 개체 자리 글자 */
const LEAD = new RegExp(`^[\\s${OBJ}]*`, "u");
/** 번호 글자 뒤에 글이 있는가(공백류·개체 자리 글자만이면 없다) */
const HAS_TEXT = new RegExp(`[^\\s${OBJ}]`, "u");
/** 한글 순서 번호(가·나·다 …). `(주)`·`주)` 같은 약칭·주석 표시를 번호로 읽지 않도록 이 글자만 받는다. */
const HANGUL_SEQ = "가나다라마바사아자차카타파하";
const ARTICLE_KINDS = ["장", "절", "조", "항", "호"];
const ARTICLE = /^제\s*\d+\s*(장|절|조|항|호)(?:\s*의\s*\d+)?/u;
const DIGIT_PARENS = /^\(\s*\d{1,3}\s*\)/u;
const HANGUL_PARENS = new RegExp(`^\\(\\s*[${HANGUL_SEQ}]\\s*\\)`, "u");
const DIGIT_PAREN = /^\d{1,3}\)/u;
const HANGUL_PAREN = new RegExp(`^[${HANGUL_SEQ}]\\)`, "u");
/** 번호 글자(로마 숫자) 뒤의 점 또는 공백. 점 뒤가 숫자이면 번호가 아니다. */
const DOT_OR_SPACE = /^(?:\.(?!\d)|(?=\s))/u;
/**
 * 숫자(1~3자리, 점으로 이은 다단)+점 또는 공백(`1.` `1.1.` `1.1`). 마디 뒤에 점이 하나도 없으면(`3 개월`, `20  .`) 번호가 아니고(`markOf`가 거른다),
 * 점 뒤가 숫자이면(`1.5배`) 번호가 아니다.
 */
const DIGIT_DOT = /^(\d{1,3}(?:\.\d{1,3})*)(?:\.(?!\d)|(?=\s))/u;
/** 숫자+점 번호 뒤의 글이 `숫자.`로 시작하면(`10. 4.(금)` 같은 날짜) 번호가 아니다 */
const DATE_REST = /^\s*\d+\./u;
const HANGUL_DOT = new RegExp(`^[${HANGUL_SEQ}]\\.`, "u");
/** 기호 머리. `-`·대시·`ㅇ`은 뒤에 공백이 있을 때만(음수·낱말 머리와 구별) */
const BOX = /^(?:[□■○●◇◆▶▷※·◎◈▣▪▫◦•►▸☞★☆◯❍➢➤∙‧・ㆍ]|[-–—ㅇ](?=\s))/u;
/** 로마 숫자 Ⅰ~Ⅻ(유니코드 한 글자) */
const isRoman = (cp: number): boolean => cp >= 0x2160 && cp <= 0x216b;
/** ①~⑳·⑴~⒇, ㉠~㉭·㉮~㉻, ❶~❿·➀~➉ */
const isCircled = (cp: number): boolean => (cp >= 0x2460 && cp <= 0x2487) || (cp >= 0x3260 && cp <= 0x327b) || (cp >= 0x2776 && cp <= 0x2789);
/** 번호 글자 없는 제목의 문장 끝 글자 */
const SENTENCE_END = /[.다요]$/u;

/** 번호 글자의 꼴, 같은 꼴 안의 아래 단계(조문의 장·절·조·항·호, 숫자 다단의 점 수), 기호(`box`), 번호 글자 뒤의 글 */
type Mark = { form: HeadingForm; sub: number; symbol?: string; rest: string };

function markOf(text: string): Mark | undefined {
  const head = text.slice(LEAD.exec(text)?.[0].length ?? 0);
  const after = (form: HeadingForm, m: RegExpExecArray): Mark => ({ form, sub: 0, rest: head.slice(m[0].length) });
  const cp = head.codePointAt(0);
  let m: RegExpExecArray | null;
  if ((m = ARTICLE.exec(head)) !== null) return { form: "article", sub: ARTICLE_KINDS.indexOf(m[1] ?? ""), rest: head.slice(m[0].length) };
  if (cp !== undefined && isRoman(cp) && (m = DOT_OR_SPACE.exec(head.slice(1))) !== null) return { form: "roman", sub: 0, rest: head.slice(1 + m[0].length) };
  if ((m = DIGIT_PARENS.exec(head)) !== null) return after("digitParens", m);
  if ((m = HANGUL_PARENS.exec(head)) !== null) return after("hangulParens", m);
  if ((m = DIGIT_PAREN.exec(head)) !== null) return after("digitParen", m);
  if ((m = HANGUL_PAREN.exec(head)) !== null) return after("hangulParen", m);
  if (cp !== undefined && isCircled(cp)) return { form: "circled", sub: 0, rest: head.slice(1) };
  if ((m = DIGIT_DOT.exec(head)) !== null) {
    const rest = head.slice(m[0].length);
    return m[0].includes(".") && !DATE_REST.test(rest) ? { form: "digitDot", sub: (m[1] ?? "").split(".").length - 1, rest } : undefined;
  }
  if ((m = HANGUL_DOT.exec(head)) !== null) return after("hangulDot", m);
  if ((m = BOX.exec(head)) !== null) return { form: "box", sub: 0, symbol: m[0], rest: head.slice(m[0].length) };
  return undefined;
}

// ── 글자모양 ──────────────────────────────────────────────────

type CharLook = { bold: boolean; height?: number };
const charCache = new WeakMap<HwpxDocument, Map<string, CharLook>>();

/** 글자모양 id → 진하게(`<hh:bold/>` 자식 요소. 한컴은 이 요소만 읽는다)·글자 크기 */
function charLooks(doc: HwpxDocument): Map<string, CharLook> {
  let map = charCache.get(doc);
  if (map !== undefined) return map;
  map = new Map();
  for (const item of doc.header.resources["charPr"] ?? []) {
    const height = attrValue(item.element, "height");
    map.set(item.id, { bold: childEl(item.element, "head", "bold") !== undefined, ...(height !== undefined && /^\d+$/.test(height) ? { height: Number(height) } : {}) });
  }
  charCache.set(doc, map);
  return map;
}

/** 첫 글(공백이 아닌 글자가 든 글 조각)이 든 run의 글자모양. 글이 없거나 글자모양을 찾지 못하면 굵지 않음·크기 없음. */
function firstLook(doc: HwpxDocument, p: ParagraphNode): CharLook {
  const piece = p.pieces.find((x) => (x.kind === "text" || x.kind === "entity") && HAS_TEXT.test(p.logicalText.slice(x.logicalStart, x.logicalEnd)));
  const id = piece === undefined ? undefined : p.runs.find((r) => r.ordinal === piece.runOrdinal)?.charPrIDRef;
  return (id === undefined || id === null ? undefined : charLooks(doc).get(id)) ?? { bold: false };
}

// ── 탐지 ──────────────────────────────────────────────────────

/** 문단 하나의 제목 판정(단계 없이). 제목이 아니면 undefined. */
type Raw = { form: HeadingForm; sub: number; symbol?: string } & CharLook;

function classify(doc: HwpxDocument, p: ParagraphNode): Raw | undefined {
  const text = p.logicalText;
  const mark = markOf(text);
  if (mark !== undefined) {
    if (!HAS_TEXT.test(mark.rest)) return undefined;
    return { form: mark.form, sub: mark.sub, ...(mark.symbol === undefined ? {} : { symbol: mark.symbol }), ...firstLook(doc, p) };
  }
  // 번호 글자 없음: 첫 글 run이 굵고, 글(개체 자리 글자를 뺀 것)이 40자 이하이며 문장 끝 글자로 끝나지 않을 때만
  const body = text.split(OBJ).join("").trim();
  if (body === "" || body.length > PRINT_TEXT || SENTENCE_END.test(body)) return undefined;
  const look = firstLook(doc, p);
  return look.bold ? { form: "none", sub: 0, ...look } : undefined;
}

/** 실제로 쓸 서열: 준 꼴(모르는 것·겹친 것은 뺀다) 뒤에 빠진 꼴을 기본 서열대로 */
function orderOf(order: readonly HeadingForm[] | undefined): HeadingForm[] {
  const given = (order ?? []).filter((f, i, all) => DEFAULT_ORDER.includes(f) && all.indexOf(f) === i);
  return [...given, ...DEFAULT_ORDER.filter((f) => !given.includes(f))];
}

type Leveled = Raw & { level: number };

/**
 * 한 문단 목록의 제목(문단 번호 → 판정과 단계). 단계는 목록 안에 나타난 (꼴 서열, 아래 단계) 짝을 빈 단계 없이 1부터 센다.
 * 기호(`box`)의 아래 단계는 그 목록에서 기호마다 처음 나온 순서다(먼저 나온 기호가 높다).
 */
function headingsIn(doc: HwpxDocument, list: readonly ParagraphNode[], order: readonly HeadingForm[]): Map<number, Leveled> {
  const raws = new Map<number, Raw>();
  const symbols: string[] = [];
  list.forEach((p, i) => {
    const r = classify(doc, p);
    if (r === undefined) return;
    if (r.symbol !== undefined) {
      if (!symbols.includes(r.symbol)) symbols.push(r.symbol);
      r.sub = symbols.indexOf(r.symbol);
    }
    raws.set(i, r);
  });
  const keyOf = (r: Raw): number => order.indexOf(r.form) * 1_000_000 + r.sub;
  const keys = [...new Set([...raws.values()].map(keyOf))].sort((a, b) => a - b);
  const out = new Map<number, Leveled>();
  for (const [i, r] of raws) out.set(i, { ...r, level: keys.indexOf(keyOf(r)) + 1 });
  return out;
}

/** 제목 `index`의 범위 끝: 뒤에서 처음 나오는, 단계가 같거나 높은 제목의 앞 문단. 없으면 목록의 끝 문단. */
function rangeEnd(heads: ReadonlyMap<number, Leveled>, length: number, index: number, level: number): number {
  for (let j = index + 1; j < length; j++) {
    const h = heads.get(j);
    if (h !== undefined && h.level <= level) return j - 1;
  }
  return length - 1;
}

/**
 * 문서의 제목을 문서 순서(문단 뒤에 그 문단의 하위 목록)로 돌려준다. 표 칸·머리말 같은 하위 목록 안 문단도 같은 규칙으로 본다(`at.parentPath`가 그 목록 주소).
 * 꼴: `article`(제N장·절·조·항·호, 선택 `의N`), `roman`(Ⅰ~Ⅻ + 점·공백), `digitDot`(`1.` `1.1.` `1.1`. 숫자만(`3 개월`)이나 번호 뒤 글이 `숫자.`(`10. 4.`)이면 아니다), `hangulDot`(`가.`),
 * `digitParen`(`1)`), `hangulParen`(`가)`), `digitParens`(`(1)`), `hangulParens`(`(가)`), `circled`(①~⑳·⑴~⒇·㉠~㉭·㉮~㉻·❶~❿·➀~➉),
 * `box`(□ ■ ○ ● ◇ ◆ ▶ ▷ ※ · 등, `-`·`ㅇ`은 뒤 공백. 기호마다 처음 나온 순서로 한 단계씩 아래), `none`(번호 글자 없이 첫 글 run이 굵고 40자 이하이며 `.`·`다`·`요`로 끝나지 않음).
 * 번호 글자 뒤 글이 비면 제목이 아니다. 글 머리의 공백과 개체 자리 글자는 건너뛴다.
 * 결과의 `text`는 개체 자리 글자를 뺀 글의 앞 40자뿐이다(앵커 지문 `heading.text`는 개체 자리 글자를 포함한 글 앞 40자로 다르다. `sha256`은 같다).
 */
export function detectHeadings(doc: HwpxDocument, opts?: HeadingOptions): Heading[] {
  const order = orderOf(opts?.order);
  const out: Heading[] = [];
  const walk = (sectionIndex: number, list: readonly ParagraphNode[], parentPath: number[]): void => {
    const heads = headingsIn(doc, list, order);
    list.forEach((p, i) => {
      const h = heads.get(i);
      if (h !== undefined) {
        out.push({
          at: { sectionIndex, parentPath: [...parentPath] },
          index: i,
          text: p.logicalText.split(OBJ).join("").slice(0, PRINT_TEXT),
          sha256: paragraphHash(p),
          marker: { form: h.form, level: h.level },
          bold: h.bold,
          ...(h.height === undefined ? {} : { height: h.height }),
        });
      }
      p.subLists.forEach((sub, k) => walk(sectionIndex, sub.paragraphs, [...p.path, k]));
    });
  };
  for (const s of doc.sections) walk(s.index, s.paragraphs, []);
  return out;
}

const isIndex = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

function listOf(doc: HwpxDocument, sectionIndex: number, parentPath: readonly number[]): ParagraphNode[] | undefined {
  const section = isIndex(sectionIndex) ? doc.sections[sectionIndex] : undefined;
  return section === undefined ? undefined : listAtParent(section, parentPath);
}

/** 목록 안 제목 `index`의 판정·단계와 범위 끝. 제목이 아니면 undefined. */
function headingAt(doc: HwpxDocument, list: readonly ParagraphNode[], index: number, order: readonly HeadingForm[]): { heading: Leveled; to: number } | undefined {
  const heads = headingsIn(doc, list, order);
  const h = heads.get(index);
  return h === undefined ? undefined : { heading: h, to: rangeEnd(heads, list.length, index, h.level) };
}

/**
 * 제목 문단 `index`(`at`의 구역·상위 목록 안)의 범위: 그 문단부터, 같은 목록에서 다음에 나오는 단계가 같거나 높은 제목의 앞 문단까지
 * (없으면 목록 끝까지). 사이의 표·개체 문단은 범위에 들고, 칸 안 제목은 다른 목록이라 범위를 끊지 않는다. 그 문단이 제목이 아니거나 주소가 없으면 undefined.
 * 단계는 `opts.order`(없으면 기본 서열)로 센다.
 */
export function headingRangeOf(doc: HwpxDocument, at: { sectionIndex: number; parentPath: number[] }, index: number, opts?: HeadingOptions): { from: number; to: number } | undefined {
  const list = listOf(doc, at.sectionIndex, at.parentPath);
  const found = list === undefined || !isIndex(index) ? undefined : headingAt(doc, list, index, orderOf(opts?.order));
  return found === undefined ? undefined : { from: index, to: found.to };
}

/**
 * 제목 문단의 `headingRange` 앵커 초안(꼴·단계, 제목 지문, 범위 지문 포함). 제목이 아니거나 주소가 없으면 undefined.
 * `opts.order`로 센 서열이 기본 서열과 다르면 그 서열(빠진 꼴까지 채운 전체)을 `order`에 담는다.
 */
export function makeHeadingRangeAnchor(doc: HwpxDocument, sectionIndex: number, parentPath: number[], index: number, opts?: HeadingOptions): HeadingRangeDraft | undefined {
  const list = listOf(doc, sectionIndex, parentPath);
  const order = orderOf(opts?.order);
  const found = list === undefined || !isIndex(index) ? undefined : headingAt(doc, list, index, order);
  const p = list?.[index];
  if (list === undefined || found === undefined || p === undefined) return undefined;
  const custom = order.some((f, i) => f !== DEFAULT_ORDER[i]);
  return {
    kind: "headingRange",
    at: { sectionIndex, parentPath: [...parentPath] },
    index,
    marker: { form: found.heading.form, level: found.heading.level },
    heading: { text: p.logicalText.slice(0, PRINT_TEXT), sha256: paragraphHash(p) },
    print: rangePrintOf(list.slice(index, found.to + 1)),
    ...(custom ? { order } : {}),
  };
}

/**
 * 제목 범위 앵커를 문서에서 찾는다(판정은 `locateRange`와 같은 꼴. 단계는 앵커의 `order`, 없으면 기본 서열로 센다).
 * 주소의 문단이 제목 지문(글 앞 40자·글 해시)과 꼴이 맞으면 범위를 다시 계산해 `print`와 대조한다: 같으면 exact, 다르면 changed.
 * 주소에 없으면 같은 구역의 모든 문단 목록에서 제목 지문과 꼴이 맞는 제목을 찾는다. 한 곳이면 범위를 다시 계산해 대조한다(같으면 relocated, 다르면 changed).
 * 여러 곳이면 곳마다 범위를 다시 계산해 `print`가 맞는 곳이 하나뿐일 때 그곳이 relocated이고, 둘 이상 맞거나 하나도 맞지 않으면 ambiguous다. 없으면 notFound.
 */
export function locateHeadingRange(doc: HwpxDocument, a: HeadingRangeAnchor): RangeLocation {
  const section = doc.sections[a.at.sectionIndex];
  if (section === undefined) return { state: "notFound", noSection: true };
  const order = orderOf(a.order);
  const isHeading = (p: ParagraphNode | undefined): boolean =>
    p !== undefined && paragraphHash(p) === a.heading.sha256 && p.logicalText.slice(0, PRINT_TEXT) === a.heading.text && classify(doc, p)?.form === a.marker.form;
  const rangeAt = (list: ParagraphNode[], parentPath: number[], index: number): FoundRange | undefined => {
    const found = headingAt(doc, list, index, order);
    return found === undefined ? undefined : { section, parentPath, from: index, to: found.to, paragraphs: list.slice(index, found.to + 1) };
  };
  const fits = (found: FoundRange | undefined): found is FoundRange => found !== undefined && samePrint(rangePrintOf(found.paragraphs), a.print);

  const own = listAtParent(section, a.at.parentPath);
  if (own !== undefined && isIndex(a.index) && isHeading(own[a.index])) {
    const found = rangeAt(own, [...a.at.parentPath], a.index);
    return fits(found) ? { state: "exact", found } : { state: "changed" };
  }

  const hits: (FoundRange | undefined)[] = [];
  for (const list of paragraphLists(section.paragraphs)) {
    const parentPath = list[0]?.path.slice(0, -1) ?? [];
    list.forEach((p, i) => {
      if (isHeading(p)) hits.push(rangeAt(list, parentPath, i));
    });
  }
  if (hits.length === 0) return { state: "notFound", noSection: false };
  const matching = hits.filter(fits);
  const only = matching[0];
  if (matching.length === 1 && only !== undefined) return { state: "relocated", found: only };
  return hits.length === 1 ? { state: "changed" } : { state: "ambiguous", count: hits.length };
}
