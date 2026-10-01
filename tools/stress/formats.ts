// 서식 변경 조합(방식 M10, 엔진 명세 7.8). 통째로 가져온 구간의 문단 몇 곳에 글자 서식(드문 서식 포함)을, 몇 곳에 문단 서식을 적용한다.
// 적용 → 다시 파싱 → 다음 적용 순서이고, 시드를 고정한 난수로 고른다. 건마다 확인하는 것:
//   - 문서 안 모든 문단의 논리 텍스트가 변하지 않는다,
//   - 적용한 구간 밖 글자(와 다른 문단)의 서식 지문이 변하지 않는다(독립 구현 canon.ts의 참조 전개 지문),
//   - 적용한 구간의 run이 요청한 속성을 가진 자원을 가리킨다(자원 요소에서 직접 읽는다. src/format의 계산을 따라 쓰지 않는다).
// `src/format`이 코드가 있는 오류(HwpxError)로 거절하면 그 적용은 거절로 세고(코드별), 다음 적용으로 넘어간다.
import { createHash } from "node:crypto";
import {
  ALIGNS,
  EMPHASIS_MARKS,
  HwpxError,
  LINE_SPACING_TYPES,
  OUTLINE_TYPES,
  STRIKEOUT_SHAPES,
  UNDERLINE_SHAPES,
  UNDERLINE_TYPES,
  applyPlan,
  attrValue,
  charDelta,
  subElements,
  openPackage,
  paraDelta,
  parseDocument,
  planApplyCharFormat,
  planApplyParaFormat,
  walkElements,
  walkParagraphs,
  type CharFormat,
  type HwpxDocument,
  type ParaFormat,
  type ParagraphNode,
  type XElement,
} from "../../packages/hwpx-engine/src/index.ts";
import { makeCanon } from "./canon.ts";
import type { Rng } from "./rng.ts";
import { bump } from "./stats.ts";
import { insertedOf, type Fail, type Notes, type Step } from "./verify.ts";

// ── 서식 종류 ───────────────────────────────────────────────────

type Choice<S> = { spec: S; holds: (resource: XElement) => boolean };

const LANGS = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"];
const COLORS = ["#FF0000", "#00AA00", "#0000FF", "#FFFF00", "#808080", "#800080"];
const kid = (el: XElement, name: string): XElement | undefined => subElements(el).find((c) => c.local === name);
const within = (el: XElement, name: string): XElement[] => [...walkElements(el)].filter((c) => c.local === name);
/** 언어 7종에 같은 값 하나가 적힌 요소(장평·자간·상대 크기·글자 위치) */
const everyLang = (el: XElement | undefined, v: number): boolean => el !== undefined && LANGS.every((l) => attrValue(el, l) === String(v));

/** 글자 서식. 이름 앞 `rare:`는 명세 7.7이 드문 서식으로 꼽은 것이다(장평·자간·강조점·외곽선·첨자·밑줄·취소선 모양·음영색, 언어별 값, 밑줄 끄기). */
const CHAR_KINDS: [string, (rng: Rng) => Choice<CharFormat>][] = [
  ["rare:ratio", (r) => { const v = r.pick([50, 75, 125, 200]); return { spec: { ratio: v }, holds: (p) => everyLang(kid(p, "ratio"), v) }; }],
  ["rare:spacing", (r) => { const v = r.pick([-50, -10, 10, 50]); return { spec: { spacing: v }, holds: (p) => everyLang(kid(p, "spacing"), v) }; }],
  ["relSize", (r) => { const v = r.pick([60, 80, 120, 200]); return { spec: { relSize: v }, holds: (p) => everyLang(kid(p, "relSz"), v) }; }],
  ["offset", (r) => { const v = r.pick([-30, -10, 10, 30]); return { spec: { offset: v }, holds: (p) => everyLang(kid(p, "offset"), v) }; }],
  ["rare:emphasis", (r) => { const v = r.pick(EMPHASIS_MARKS); return { spec: { emphasis: v }, holds: (p) => attrValue(p, "symMark") === v }; }],
  ["rare:outline", (r) => { const type = r.pick(OUTLINE_TYPES); return { spec: { outline: { type } }, holds: (p) => { const o = kid(p, "outline"); return o !== undefined && attrValue(o, "type") === type; } }; }],
  ["rare:superscript", () => ({ spec: { superscript: true }, holds: (p) => kid(p, "supscript") !== undefined && kid(p, "subscript") === undefined })],
  ["rare:subscript", () => ({ spec: { subscript: true }, holds: (p) => kid(p, "subscript") !== undefined && kid(p, "supscript") === undefined })],
  [
    "rare:underlineShape",
    (r) => {
      const type = r.pick(UNDERLINE_TYPES);
      const shape = r.pick(UNDERLINE_SHAPES);
      const color = r.pick(COLORS);
      return { spec: { underline: { type, shape, color } }, holds: (p) => { const u = kid(p, "underline"); return u !== undefined && attrValue(u, "type") === type && attrValue(u, "shape") === shape && attrValue(u, "color") === color; } };
    },
  ],
  [
    "rare:strikeoutShape",
    (r) => {
      const shape = r.pick(STRIKEOUT_SHAPES);
      const color = r.pick(COLORS);
      return { spec: { strikeout: { shape, color } }, holds: (p) => { const k = kid(p, "strikeout"); return k !== undefined && attrValue(k, "shape") === shape && attrValue(k, "color") === color; } };
    },
  ],
  ["rare:shadeColor", (r) => { const v = r.pick(COLORS); return { spec: { shadeColor: v }, holds: (p) => attrValue(p, "shadeColor") === v }; }],
  ["bold", () => ({ spec: { bold: true }, holds: (p) => kid(p, "bold") !== undefined })],
  ["italic", () => ({ spec: { italic: true }, holds: (p) => kid(p, "italic") !== undefined })],
  ["textColor", (r) => { const v = r.pick(COLORS); return { spec: { textColor: v }, holds: (p) => attrValue(p, "textColor") === v }; }],
  ["size", (r) => { const v = r.pick([8, 9, 12, 14, 20]); return { spec: { size: v }, holds: (p) => attrValue(p, "height") === String(v * 100) }; }],
  [
    "shadow",
    (r) => {
      const type = r.pick(["DROP", "CONTINUOUS"] as const);
      const color = r.pick(COLORS);
      return { spec: { shadow: { type, color } }, holds: (p) => { const s = kid(p, "shadow"); return s !== undefined && attrValue(s, "type") === type && attrValue(s, "color") === color; } };
    },
  ],
  ["emboss", () => ({ spec: { emboss: true }, holds: (p) => kid(p, "emboss") !== undefined && kid(p, "engrave") === undefined })],
  ["engrave", () => ({ spec: { engrave: true }, holds: (p) => kid(p, "engrave") !== undefined && kid(p, "emboss") === undefined })],
  ["kerning", () => ({ spec: { kerning: true }, holds: (p) => attrValue(p, "useKerning") === "1" })],
  ["rare:underlineOff", () => ({ spec: { underline: false }, holds: (p) => { const u = kid(p, "underline"); return u !== undefined && attrValue(u, "type") === "NONE"; } })],
  ["rare:ratioPerLang", (r) => { const v = r.pick([60, 150]); return { spec: { ratio: { hangul: v, latin: v } }, holds: (p) => { const e = kid(p, "ratio"); return e !== undefined && attrValue(e, "hangul") === String(v) && attrValue(e, "latin") === String(v); } }; }],
];

/** 문단 서식: 정렬 6가지, 줄 간격 종류 4가지, 내어쓰기·들여쓰기, 왼쪽·오른쪽 여백, 문단 앞·뒤 간격 */
const PARA_KINDS: [string, (rng: Rng) => Choice<ParaFormat>][] = [
  ...ALIGNS.map((a): [string, (rng: Rng) => Choice<ParaFormat>] => [`align:${a}`, () => ({ spec: { align: a }, holds: (p) => attrValue(kid(p, "align") ?? p, "horizontal") === a && kid(p, "align") !== undefined })]),
  ...LINE_SPACING_TYPES.map((type): [string, (rng: Rng) => Choice<ParaFormat>] => [
    `lineSpacing:${type}`,
    (r) => {
      const value = type === "PERCENT" ? r.pick([80, 130, 160, 200]) : r.pick([1000, 1500, 2000]);
      return {
        spec: { lineSpacing: { type, value } },
        holds: (p) => {
          const all = within(p, "lineSpacing");
          return all.length > 0 && all.every((e) => attrValue(e, "type") === type) && all.some((e) => attrValue(e, "value") === String(value));
        },
      };
    },
  ]),
  ["indent", (r) => { const v = r.pick([-3000, -1500, 1500, 3000]); return { spec: { indent: v }, holds: (p) => within(p, "intent").some((e) => attrValue(e, "value") === String(v)) }; }],
  ["marginLeft", (r) => { const v = r.pick([0, 2000, 4000, 8000]); return { spec: { marginLeft: v }, holds: (p) => within(p, "left").some((e) => attrValue(e, "value") === String(v)) }; }],
  ["marginRight", (r) => { const v = r.pick([0, 2000, 4000, 8000]); return { spec: { marginRight: v }, holds: (p) => within(p, "right").some((e) => attrValue(e, "value") === String(v)) }; }],
  ["spaceBefore", (r) => { const v = r.pick([0, 500, 1000, 2000]); return { spec: { spaceBefore: v }, holds: (p) => within(p, "prev").some((e) => attrValue(e, "value") === String(v)) }; }],
  ["spaceAfter", (r) => { const v = r.pick([0, 500, 1000, 2000]); return { spec: { spaceAfter: v }, holds: (p) => within(p, "next").some((e) => attrValue(e, "value") === String(v)) }; }],
];

// ── 지문 ────────────────────────────────────────────────────────

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

type Fingerprints = {
  /** 글자(논리 텍스트 오프셋)마다 그 글자가 속한 run의 글자모양 지문 */
  chars: string[];
  para: string;
  style: string;
};

/** 독립 구현(canon.ts)이 참조까지 전개한 문자열의 해시로 문단의 서식 지문을 만든다. */
function fingerprinter(doc: HwpxDocument): (p: ParagraphNode) => Fingerprints {
  const canon = makeCanon(doc);
  const memo = new Map<string, string>();
  const fp = (kind: string, id: string | null): string => {
    if (id === null) return "none";
    const key = `${kind}:${id}`;
    let v = memo.get(key);
    if (v === undefined) memo.set(key, (v = sha(canon.bodyRef(kind, id))));
    return v;
  };
  return (p) => {
    const chars = new Array<string>(p.logicalText.length).fill("");
    for (const piece of p.pieces) {
      const f = fp("charPr", p.runs[piece.runOrdinal]?.charPrIDRef ?? null);
      for (let i = piece.logicalStart; i < piece.logicalEnd; i++) chars[i] = f;
    }
    return { chars, para: fp("paraPr", p.attrs.paraPrIDRef), style: fp("style", p.attrs.styleIDRef) };
  };
}

const allParagraphs = (doc: HwpxDocument): ParagraphNode[] => doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)]);

// ── 적용 ────────────────────────────────────────────────────────

export type FormatStats = {
  /** 적용한 서식 종류별 건수(`char:<종류>`, `para:<종류>`) */
  applied: Record<string, number>;
  /** 계획이 비어(이미 같은 모양) 바뀐 것이 없던 적용 */
  noop: number;
  /** 거절 코드별 건수 */
  rejected: Record<string, number>;
  /** 서식 종류·거절 코드별 건수 */
  rejectedByKind: Record<string, number>;
};

export type FormatOutcome = {
  doc: HwpxDocument;
  bytes: Uint8Array;
  /** 적용마다 출력 바이트의 sha256(재실행 결정성 비교용) */
  outputs: string[];
  stats: FormatStats;
  fails: Fail[];
  notes: Notes;
};

export type Plan = { kind: string; scope: "char" | "para"; paragraph: ParagraphNode; start: number; end: number; make: (rng: Rng) => Choice<CharFormat> | Choice<ParaFormat> };

const note = (notes: Notes, key: string, by = 1): void => {
  notes[key] = (notes[key] ?? 0) + by;
};

/**
 * 가져온 구간(`step`의 결과 문서에서 삽입된 최상위 문단들과 그 안의 문단들)에서 글자 서식 3~8곳, 문단 서식 2~4곳을 고른다.
 * `check`가 꺼져 있으면 확인 없이 적용만 한다(재실행 결정성 비교용).
 */
export function applyFormats(step: Step, rng: Rng, check: boolean): FormatOutcome {
  const sectionIndex = step.point.sectionIndex;
  const stats: FormatStats = { applied: {}, noop: 0, rejected: {}, rejectedByKind: {} };
  const fails: Fail[] = [];
  const notes: Notes = {};
  const outputs: string[] = [];

  // 대상 고르기(가져온 구간 안, 구조적으로 안전한 순서로 고른다)
  const inserted = [...walkParagraphs(insertedOf(step))];
  const charPool = rng.shuffle(inserted.filter((p) => p.logicalText.length > 0 && p.runs.length > 0));
  const paraPool = rng.shuffle(inserted);
  const plans: Plan[] = [];
  for (const p of charPool.slice(0, rng.range(3, 8))) {
    const len = p.logicalText.length;
    const whole = rng.chance(0.2);
    const start = whole ? 0 : rng.int(len);
    const end = whole ? len : start + 1 + rng.int(len - start);
    const [kind, make] = rng.pick(CHAR_KINDS);
    plans.push({ kind: `char:${kind}`, scope: "char", paragraph: p, start, end, make });
  }
  for (const p of paraPool.slice(0, rng.range(2, 4))) {
    const [kind, make] = rng.pick(PARA_KINDS);
    plans.push({ kind: `para:${kind}`, scope: "para", paragraph: p, start: 0, end: 0, make });
  }

  let doc = step.result;
  let bytes = step.bytes;
  for (const plan of plans) {
    const path = plan.paragraph.path;
    const picked = plan.make(rng);
    let nextBytes: Uint8Array;
    try {
      const edit =
        plan.scope === "char"
          ? planApplyCharFormat(doc, { sectionIndex, path, start: plan.start, end: plan.end }, charDelta(doc, picked.spec as CharFormat))
          : planApplyParaFormat(doc, [{ sectionIndex, path }], paraDelta(doc, picked.spec as ParaFormat));
      if (edit.edits.length === 0 && edit.additions.length === 0) stats.noop++;
      nextBytes = applyPlan(doc.pkg, edit);
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      bump(stats.rejected, e.code);
      bump(stats.rejectedByKind, `${plan.kind}:${e.code}`);
      continue;
    }
    const next = parseDocument(openPackage(nextBytes));
    bump(stats.applied, plan.kind);
    outputs.push(createHash("sha256").update(nextBytes).digest("hex"));
    if (check) verifyApplication(doc, next, plan, picked.holds, sectionIndex, fails, notes);
    doc = next;
    bytes = nextBytes;
  }
  return { doc, bytes, outputs, stats, fails, notes };
}

/** 한 번 적용한 결과(`after`)를 적용 전(`before`)과 견준다. */
export function verifyApplication(
  before: HwpxDocument,
  after: HwpxDocument,
  plan: Plan,
  holds: (resource: XElement) => boolean,
  sectionIndex: number,
  fails: Fail[],
  notes: Notes,
): void {
  const fail = (code: string): void => void fails.push({ item: "V-m", code: `${code}:${plan.kind}` });
  // 모든 문단의 논리 텍스트가 그대로다(대상의 기존 문단 포함)
  const a = allParagraphs(before);
  const b = allParagraphs(after);
  if (a.length !== b.length) {
    fail("PARAGRAPH_COUNT");
    return;
  }
  if (a.some((p, i) => p.logicalText !== b[i]?.logicalText)) fail("TEXT_CHANGED");
  else note(notes, "vm.paragraphsTextCompared", a.length);

  // 서식 지문: 적용한 구간 밖 글자와 다른 문단은 그대로, 요청하지 않은 종류(글자 서식이면 문단모양, 문단 서식이면 글자모양)도 그대로
  const fa = fingerprinter(before);
  const fb = fingerprinter(after);
  const target = paragraphAtPath(after, sectionIndex, plan.paragraph.path);
  let compared = 0;
  for (const [i, p] of a.entries()) {
    const q = b[i];
    if (q === undefined) continue;
    const x = fa(p);
    const y = fb(q);
    const isTarget = q === target;
    compared++;
    if (x.style !== y.style) fail("STYLE_CHANGED");
    if (plan.scope === "char" || !isTarget) {
      if (x.para !== y.para) fail("PARA_FP_CHANGED");
    }
    if (plan.scope === "para" || !isTarget) {
      if (x.chars.length !== y.chars.length || x.chars.some((c, k) => c !== y.chars[k])) fail("CHAR_FP_CHANGED");
    } else if (x.chars.some((c, k) => (k < plan.start || k >= plan.end) && c !== y.chars[k])) {
      fail("CHAR_FP_OUTSIDE_RANGE");
    }
  }
  note(notes, "vm.paragraphsFingerprintCompared", compared);

  // 요청한 속성: 적용한 구간의 run(글자) 또는 그 문단(문단)이 가리키는 자원이 속성을 가졌다
  if (target === undefined) {
    fail("TARGET_LOST");
    return;
  }
  if (plan.scope === "char") {
    const items = after.header.resources["charPr"] ?? [];
    const runs = new Set(target.pieces.filter((p) => p.logicalEnd > p.logicalStart && p.logicalStart < plan.end && p.logicalEnd > plan.start).map((p) => p.runOrdinal));
    if (runs.size === 0) fail("NO_COVERED_RUN");
    for (const ordinal of runs) {
      const id = target.runs[ordinal]?.charPrIDRef;
      const item = items.find((r) => r.id === id);
      if (item === undefined || !holds(item.element)) fail("PROPERTY_MISSING");
      else note(notes, "vm.propertiesChecked");
    }
  } else {
    const item = (after.header.resources["paraPr"] ?? []).find((r) => r.id === target.attrs.paraPrIDRef);
    if (item === undefined || !holds(item.element)) fail("PROPERTY_MISSING");
    else note(notes, "vm.propertiesChecked");
  }
}

function paragraphAtPath(doc: HwpxDocument, sectionIndex: number, path: number[]): ParagraphNode | undefined {
  const section = doc.sections[sectionIndex];
  let list = section?.paragraphs ?? [];
  let found: ParagraphNode | undefined;
  for (let n = 0; n < path.length; n++) {
    const i = path[n] ?? -1;
    if (n % 2 === 0) {
      found = list[i];
      if (found === undefined) return undefined;
    } else {
      const sub = found?.subLists[i];
      if (sub === undefined) return undefined;
      list = sub.paragraphs;
    }
  }
  return found;
}
