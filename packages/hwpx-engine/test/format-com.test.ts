import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyPlan,
  subElements,
  walkParagraphs,
  type HwpxDocument,
  type ParagraphNode,
} from "../src/index.ts";
import {
  charDelta,
  deriveResource,
  paraDelta,
  planApplyCharFormat,
  planApplyParaFormat,
  type CharFormat,
  type ParaFormat,
} from "../src/format/index.ts";
import { loadDoc, reparse } from "./helpers.ts";

/**
 * R7 한컴 대조(선택 실행). `HWPX_COM=1`일 때만 돈다. 한컴 오피스·Python·pywin32가 있는 Windows에서만 의미가 있다.
 *
 * 문서마다 서식을 적용한 결과를 OS 임시 폴더에 저장하고 `tools/com/read_shape.py`로 한컴에서 열어 그 위치의 글자모양·문단모양을 읽는다.
 * 요청값을 한컴의 수치로 바꾸는 표는 한컴 13으로 직접 값을 바꿔 저장한 문서의 header와 대조해 만들었다(관측):
 *  - 밑줄·취소선 모양 0..15: SOLID, DOT, DASH, DASH_DOT, DASH_DOT_DOT, LONG_DASH, CIRCLE, DOUBLE_SLIM, SLIM_THICK, THICK_SLIM, SLIM_THICK_SLIM, WAVE, DOUBLEWAVE, THICK3D, THICKREV3D, 3D
 *  - 밑줄 위치 1..3: BOTTOM, CENTER, TOP / 외곽선 1..6: SOLID, DOT, THICK, DASH, DASH_DOT, DASH_DOT_DOT / 그림자 1..2: DROP, CONTINUOUS
 *  - 강조점 1..12: DOT_ABOVE, RING_ABOVE, TILDE, CARON, SIDE, COLON, GRAVE_ACCENT, ACUTE_ACCENT, CIRCUMFLEX, MACRON, HOOK_ABOVE, DOT_BELOW
 *  - 정렬 0..5: JUSTIFY, LEFT, RIGHT, CENTER, DISTRIBUTE, DISTRIBUTE_SPACE / 줄 간격 종류 0..3: PERCENT, FIXED, BETWEEN_LINES, AT_LEAST
 *  - 영어 줄 나눔 0..2: KEEP_WORD, HYPHENATION, BREAK_WORD / 한글 줄 나눔 0..1: BREAK_WORD, KEEP_WORD
 *  - 문단 테두리 종류 1..12: SOLID, DOT, DASH, DASH_DOT, DASH_DOT_DOT, LONG_DASH, CIRCLE, DOUBLE_SLIM, SLIM_THICK, THICK_SLIM, SLIM_THICK_SLIM, WAVE
 *    굵기 0..7: 0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5 mm / 배경색은 `FillAttr.WinBrushFaceColor`(BGR) / 탭 정의는 `TabDef.AutoTabLeft·Right`
 *  - 색은 BGR 정수, 크기는 1/100pt, 여백·줄 간격(퍼센트 아님)은 HWPUNIT의 2배(한컴 COM 단위; 저장본의 `default` 갈래 값과 같다)
 *  - 한컴 COM에서 읽는 이름과 쓰는 이름이 다른 항목이 있다(외곽선: 쓰기 `OutLineType`, 읽기 `OutlineType`). 읽기 이름은 `ItemExist`로 확인했다.
 *  - 한컴이 읽지 못해 대조하지 않은 것: 문단 테두리 왼쪽 색(`BorderColorLeft` 항목이 없다), 줄 나눔 기준 `lineWrap`, 취소선 종류(`StrikeOutType`)
 */
const ENABLED = process.env["HWPX_COM"] === "1";
const SCRIPT = fileURLToPath(new URL("../../../tools/com/read_shape.py", import.meta.url));

const UNDERLINE_SHAPES = ["SOLID", "DOT", "DASH", "DASH_DOT", "DASH_DOT_DOT", "LONG_DASH", "CIRCLE", "DOUBLE_SLIM", "SLIM_THICK", "THICK_SLIM", "SLIM_THICK_SLIM", "WAVE", "DOUBLEWAVE", "THICK3D", "THICKREV3D", "3D"];
const OUTLINE = ["NONE", "SOLID", "DOT", "THICK", "DASH", "DASH_DOT", "DASH_DOT_DOT"];
const MARKS = ["NONE", "DOT_ABOVE", "RING_ABOVE", "TILDE", "CARON", "SIDE", "COLON", "GRAVE_ACCENT", "ACUTE_ACCENT", "CIRCUMFLEX", "MACRON", "HOOK_ABOVE", "DOT_BELOW"];
const ALIGNS = ["JUSTIFY", "LEFT", "RIGHT", "CENTER", "DISTRIBUTE", "DISTRIBUTE_SPACE"];
const BREAK_LATIN = ["KEEP_WORD", "HYPHENATION", "BREAK_WORD"];
const BREAK_NON_LATIN = ["BREAK_WORD", "KEEP_WORD"];
const LANG_NAMES = ["Hangul", "Latin", "Hanja", "Japanese", "Other", "Symbol", "User"];

const bgr = (hex: string): number => parseInt(hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3), 16);
const idx = (list: string[], v: string): number => {
  const i = list.indexOf(v);
  assert.ok(i >= 0, v);
  return i;
};
const perLang = (prefix: string, v: number): Record<string, number | string> => Object.fromEntries(LANG_NAMES.map((l) => [prefix + l, v]));

// ── 한컴 위치: 글자 하나 1칸, 탭·컨트롤·개체는 8칸 ─────────────────────────────

function hwpPos(p: ParagraphNode, logical: number): number {
  let pos = 0;
  for (const piece of p.pieces) {
    if (piece.logicalEnd <= logical && piece.logicalEnd > piece.logicalStart) {
      if (piece.kind === "object") {
        const obj = p.objects.find((o) => o.pieceIndex === p.pieces.indexOf(piece));
        pos += obj?.type === "ctrl" ? 8 * Math.max(1, subElements(obj.element).length) : 8;
      } else if (piece.kind === "inline") {
        pos += p.logicalText.slice(piece.logicalStart, piece.logicalEnd) === "\t" ? 8 : piece.logicalEnd - piece.logicalStart;
      } else pos += piece.logicalEnd - piece.logicalStart;
    } else if (piece.logicalStart < logical && logical < piece.logicalEnd) {
      pos += logical - piece.logicalStart;
    }
  }
  return pos;
}

// ── 사례 ──────────────────────────────────────────────────────────────

type CharCase = { name: string; spec: CharFormat; expect: Record<string, number | string> };

/** 글자 서식 사례: 요청한 값 → 한컴이 읽어야 하는 값 */
const CHAR_CASES: CharCase[] = [
  { name: "크기 14pt", spec: { size: 14 }, expect: { Height: 1400 } },
  { name: "글자색 #2E74B5", spec: { textColor: "#2e74b5" }, expect: { TextColor: bgr("#2E74B5") } },
  { name: "음영색 #FFFF00", spec: { shadeColor: "#FFFF00" }, expect: { ShadeColor: bgr("#FFFF00") } },
  { name: "진하게", spec: { bold: true }, expect: { Bold: 1 } },
  { name: "기울임", spec: { italic: true }, expect: { Italic: 1 } },
  { name: "장평 50", spec: { ratio: 50 }, expect: perLang("Ratio", 50) },
  { name: "장평 200", spec: { ratio: 200 }, expect: perLang("Ratio", 200) },
  { name: "자간 -50", spec: { spacing: -50 }, expect: perLang("Spacing", -50) },
  { name: "자간 50", spec: { spacing: 50 }, expect: perLang("Spacing", 50) },
  { name: "자간 -7(한글만 -20)", spec: { spacing: { hangul: -20, latin: -7 } }, expect: { SpacingHangul: -20, SpacingLatin: -7, SpacingHanja: 0 } },
  { name: "상대 크기 80", spec: { relSize: 80 }, expect: perLang("Size", 80) },
  { name: "글자 위치 20", spec: { offset: 20 }, expect: perLang("Offset", 20) },
  { name: "글자 위치 -30", spec: { offset: -30 }, expect: perLang("Offset", -30) },
  { name: "밑줄 파선 빨강", spec: { underline: { shape: "DASH", color: "#ff0000" } }, expect: { UnderlineType: 1, UnderlineShape: idx(UNDERLINE_SHAPES, "DASH"), UnderlineColor: bgr("#FF0000") } },
  { name: "밑줄 위 물결", spec: { underline: { type: "TOP", shape: "WAVE" } }, expect: { UnderlineType: 3, UnderlineShape: idx(UNDERLINE_SHAPES, "WAVE") } },
  { name: "밑줄 가운데 이중", spec: { underline: { type: "CENTER", shape: "DOUBLE_SLIM", color: "#0000ff" } }, expect: { UnderlineType: 2, UnderlineShape: idx(UNDERLINE_SHAPES, "DOUBLE_SLIM"), UnderlineColor: bgr("#0000FF") } },
  { name: "취소선 점선", spec: { strikeout: { shape: "DOT", color: "#00aa00" } }, expect: { StrikeOutShape: idx(UNDERLINE_SHAPES, "DOT"), StrikeOutColor: bgr("#00AA00") } },
  { name: "취소선 긴 파선", spec: { strikeout: { shape: "LONG_DASH" } }, expect: { StrikeOutShape: idx(UNDERLINE_SHAPES, "LONG_DASH") } },
  { name: "외곽선", spec: { outline: true }, expect: { OutlineType: 1 } },
  { name: "외곽선 파선", spec: { outline: { type: "DASH" } }, expect: { OutlineType: idx(OUTLINE, "DASH") } },
  { name: "그림자 DROP", spec: { shadow: { type: "DROP" } }, expect: { ShadowType: 1 } },
  { name: "그림자 CONTINUOUS 색·간격", spec: { shadow: { type: "CONTINUOUS", color: "#ff0000", offsetX: 5, offsetY: 7 } }, expect: { ShadowType: 2, ShadowColor: bgr("#FF0000"), ShadowOffsetX: 5, ShadowOffsetY: 7 } },
  { name: "양각", spec: { emboss: true }, expect: { Emboss: 1, Engrave: 0 } },
  { name: "음각", spec: { engrave: true }, expect: { Engrave: 1, Emboss: 0 } },
  { name: "위첨자", spec: { superscript: true }, expect: { SuperScript: 1, SubScript: 0 } },
  { name: "아래첨자", spec: { subscript: true }, expect: { SubScript: 1, SuperScript: 0 } },
  { name: "강조점 DOT_ABOVE", spec: { emphasis: "DOT_ABOVE" }, expect: { DiacSymMark: 1 } },
  { name: "강조점 DOT_BELOW", spec: { emphasis: "DOT_BELOW" }, expect: { DiacSymMark: idx(MARKS, "DOT_BELOW") } },
  { name: "커닝", spec: { kerning: true }, expect: { UseKerning: 1 } },
  { name: "글꼴 이름(함초롬돋움)", spec: { font: "함초롬돋움" }, expect: { FaceNameHangul: "함초롬돋움", FaceNameLatin: "함초롬돋움", FaceNameUser: "함초롬돋움" } },
  { name: "여러 항목(크기·진하게·장평·밑줄)", spec: { size: 11, bold: true, ratio: 120, underline: { shape: "SOLID" } }, expect: { Height: 1100, Bold: 1, ...perLang("Ratio", 120), UnderlineType: 1, UnderlineShape: 0 } },
];

/** 열거값 전부: 밑줄 모양 16, 취소선 모양 14, 외곽선 종류 6, 강조점 12 */
const ENUM_CASES: CharCase[] = [
  ...UNDERLINE_SHAPES.map((s, i): CharCase => ({ name: `밑줄 모양 ${s}`, spec: { underline: { shape: s as "SOLID" } }, expect: { UnderlineType: 1, UnderlineShape: i } })),
  ...UNDERLINE_SHAPES.slice(0, 14).map((s, i): CharCase => ({ name: `취소선 모양 ${s}`, spec: { strikeout: { shape: s as "SOLID" } }, expect: { StrikeOutShape: i } })),
  ...OUTLINE.slice(1).map((s, i): CharCase => ({ name: `외곽선 종류 ${s}`, spec: { outline: { type: s as "SOLID" } }, expect: { OutlineType: i + 1 } })),
  ...MARKS.slice(1).map((s, i): CharCase => ({ name: `강조점 ${s}`, spec: { emphasis: s as "DOT_ABOVE" }, expect: { DiacSymMark: i + 1 } })),
];

type ParaCase = { name: string; spec: ParaFormat; expect: Record<string, number | string> };

const PARA_CASES: ParaCase[] = [
  { name: "배분 정렬", spec: { align: "DISTRIBUTE" }, expect: { AlignType: idx(ALIGNS, "DISTRIBUTE") } },
  { name: "나눔 정렬", spec: { align: "DISTRIBUTE_SPACE" }, expect: { AlignType: idx(ALIGNS, "DISTRIBUTE_SPACE") } },
  { name: "가운데 정렬", spec: { align: "CENTER" }, expect: { AlignType: 3 } },
  { name: "오른쪽 정렬", spec: { align: "RIGHT" }, expect: { AlignType: 2 } },
  { name: "줄 간격 비율 250%", spec: { lineSpacing: { type: "PERCENT", value: 250 } }, expect: { LineSpacingType: 0, LineSpacing: 250 } },
  { name: "줄 간격 고정 14pt", spec: { lineSpacing: { type: "FIXED", value: 1400 } }, expect: { LineSpacingType: 1, LineSpacing: 2800 } },
  { name: "줄 간격 여백만 3pt", spec: { lineSpacing: { type: "BETWEEN_LINES", value: 300 } }, expect: { LineSpacingType: 2, LineSpacing: 600 } },
  { name: "줄 간격 최소 12pt", spec: { lineSpacing: { type: "AT_LEAST", value: 1200 } }, expect: { LineSpacingType: 3, LineSpacing: 2400 } },
  { name: "왼쪽·오른쪽 여백", spec: { marginLeft: 1500, marginRight: 700 }, expect: { LeftMargin: 3000, RightMargin: 1400 } },
  { name: "내어쓰기", spec: { indent: -1500, marginLeft: 1500 }, expect: { Indentation: -3000, LeftMargin: 3000 } },
  { name: "들여쓰기", spec: { indent: 1000 }, expect: { Indentation: 2000 } },
  { name: "문단 앞뒤 간격", spec: { spaceBefore: 400, spaceAfter: 900 }, expect: { PrevSpacing: 800, NextSpacing: 1800 } },
  { name: "줄 나눔 기준", spec: { breakLatinWord: "BREAK_WORD", breakNonLatinWord: "BREAK_WORD" }, expect: { BreakLatinWord: idx(BREAK_LATIN, "BREAK_WORD"), BreakNonLatinWord: idx(BREAK_NON_LATIN, "BREAK_WORD") } },
];

// ── 실행 ──────────────────────────────────────────────────────────────

type Probe = { id: string; list?: number; listByText?: string; para: number; charPos: number };
type Row = { doc: string; what: string; item: string; requested: number | string; read: number | string | null | undefined };
type ProbeResult = { id: string; ok: boolean; error: string | null; char: Record<string, number | string | null> | null; para: Record<string, number | string | null> | null };
type DocResult = { name: string; opened: boolean; pages: number | null; timeout: boolean; error: string | null; probes: ProbeResult[] };

function readShapes(dir: string, documents: { name: string; file: string; probes: Probe[] }[]): { hancom_version: string | null; results: DocResult[] } {
  const spec = join(dir, "spec.json");
  const out = join(dir, "result.json");
  writeFileSync(spec, JSON.stringify({ documents }));
  let last: { hancom_version: string | null; results: DocResult[] } | undefined;
  // 다른 작업이 한컴을 함께 쓰면(남은 프로세스 정리 등) 실행이 끊길 수 있어 최대 3번 시도한다.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync("python", [SCRIPT, "--spec", spec, "--out", out, "--timeout", "60"], { encoding: "utf8", timeout: 60_000 * documents.length + 30_000 });
    assert.equal(r.status, 0, `read_shape.py 종료 코드: ${r.stderr}`);
    last = JSON.parse(readFileSync(out, "utf8")) as { hancom_version: string | null; results: DocResult[] };
    if (last.results.every((d) => d.opened && !d.timeout)) return last;
  }
  assert.ok(last !== undefined);
  return last;
}

function paragraphAt(doc: HwpxDocument, path: number[]): ParagraphNode {
  let list = doc.sections[0]?.paragraphs ?? [];
  let found: ParagraphNode | undefined;
  for (let n = 0; n < path.length; n++) {
    const i = path[n] ?? -1;
    if (n % 2 === 0) found = list[i];
    else list = found?.subLists[i]?.paragraphs ?? [];
  }
  assert.ok(found !== undefined);
  return found;
}

const rows: Row[] = [];

type Expectation = { probe: Probe; what: string; expect: Record<string, number | string>; kind: "char" | "para" };

/** 글자 서식 사례를 지정한 문단의 겹치지 않는 구간(`len`글자씩, `step`칸 간격)에 차례로 적용한다(적용 → 다시 파싱 → 적용). */
function placeChars(base: HwpxDocument, path: number[], cases: CharCase[], from: number, step: number, tag: string, len = 2): { doc: HwpxDocument; expectations: Expectation[] } {
  let doc = base;
  const starts = cases.map((_, i) => from + i * step);
  cases.forEach((c, i) => {
    const start = starts[i] ?? 0;
    const plan = planApplyCharFormat(doc, { sectionIndex: 0, path, start, end: start + len }, charDelta(doc, c.spec));
    doc = reparse(applyPlan(doc.pkg, plan));
  });
  const p = paragraphAt(doc, path);
  const expectations = cases.map((c, i): Expectation => ({
    probe: { id: `${tag}${i}`, list: 0, para: path[0] ?? 0, charPos: hwpPos(p, starts[i] ?? 0) },
    what: c.name,
    expect: c.expect,
    kind: "char",
  }));
  return { doc, expectations };
}

/** 문단 서식 사례를 문단마다 하나씩(또는 합쳐서) 적용한다. */
function placeParas(base: HwpxDocument, targets: number[], groups: ParaCase[][], tag: string): { doc: HwpxDocument; expectations: Expectation[] } {
  let doc = base;
  const expectations: Expectation[] = [];
  groups.forEach((g, k) => {
    const index = targets[k];
    assert.ok(index !== undefined);
    const merged = Object.assign({}, ...g.map((c) => c.spec)) as ParaFormat;
    const plan = planApplyParaFormat(doc, [{ sectionIndex: 0, path: [index] }], paraDelta(doc, merged));
    doc = reparse(applyPlan(doc.pkg, plan));
    expectations.push({
      probe: { id: `${tag}${k}`, list: 0, para: index, charPos: 1 },
      what: g.map((c) => c.name).join(" + "),
      expect: Object.assign({}, ...g.map((c) => c.expect)) as Record<string, number | string>,
      kind: "para",
    });
  });
  return { doc, expectations };
}

test("R7 한컴 대조: 글자·문단 서식을 적용한 결과를 한컴으로 열어 그 위치의 값을 읽으면 요청한 값과 같다", { skip: ENABLED ? false : "HWPX_COM=1일 때만 실행한다(한컴 오피스·Python·pywin32 필요)" }, () => {
  const py = spawnSync("python", ["--version"], { encoding: "utf8" });
  assert.equal(py.status, 0, "python이 있어야 한다");
  const dir = mkdtempSync(join(tmpdir(), "hwpx-format-r7-"));
  try {
    const documents: { name: string; file: string; probes: Probe[] }[] = [];
    const expectations = new Map<string, Expectation>();
    const originals: { name: string; bytes: Uint8Array }[] = [];
    const addDoc = (name: string, doc: HwpxDocument, original: HwpxDocument, list: Expectation[]): void => {
      const file = join(dir, `${name}-after.hwpx`);
      writeFileSync(file, doc.pkg.bytes);
      documents.push({ name: `${name}-after`, file, probes: list.map((x) => x.probe) });
      for (const x of list) expectations.set(`${name}-after#${x.probe.id}`, x);
      originals.push({ name: `${name}-original`, bytes: original.pkg.bytes });
    };
    const pick = (...ns: number[]): ParaCase[] => ns.map((n) => PARA_CASES[n] as ParaCase);

    // 1) 합성 문서(D1): 글자 서식 사례 전부를 긴 문단 [1]에, 문단 서식 사례를 목록 문단 13개에 하나씩
    {
      const base = loadDoc("D1");
      const chars0 = placeChars(base, [1], CHAR_CASES, 4, 2, "c");
      const enums = placeChars(chars0.doc, [1], ENUM_CASES, 4 + CHAR_CASES.length * 2 + 2, 1, "e", 1);
      const chars = { doc: enums.doc, expectations: [...chars0.expectations, ...enums.expectations] };
      const tops = (base.sections[0]?.paragraphs ?? []).map((p, i) => ({ p, i })).filter(({ p, i }) => i !== 1 && p.subLists.length === 0 && p.logicalText.replace(/￼/g, "").length >= 1);
      const groups = [pick(0, 11), pick(1, 12), pick(2, 4), pick(3, 5), pick(6), pick(7), pick(8), pick(9), pick(10)];
      assert.ok(tops.length >= groups.length);
      const paras = placeParas(chars.doc, tops.slice(0, groups.length).map((x) => x.i), groups, "p");
      addDoc("D1", paras.doc, base, [...chars.expectations, ...paras.expectations]);
    }

    // 2) 한컴 저장본(ph-mixed): 문단 [1]에 7개, 탭이 든 문단 [2]의 탭 앞 6개·탭 뒤 6개, 탭을 걸친 구간
    {
      const base = loadDoc("hancom/ph-mixed");
      const a = placeChars(base, [1], CHAR_CASES.slice(0, 7), 0, 3, "a");
      const tab = paragraphAt(a.doc, [2]).logicalText.indexOf("\t");
      assert.equal(tab, 20);
      const b = placeChars(a.doc, [2], CHAR_CASES.slice(13, 19), 1, 3, "b");
      const c = placeChars(b.doc, [2], CHAR_CASES.slice(19, 25), tab + 3, 2, "c");
      const across = planApplyCharFormat(c.doc, { sectionIndex: 0, path: [2], start: tab - 1, end: tab + 2 }, charDelta(c.doc, { bold: true, underline: { shape: "WAVE" } }));
      const doc = reparse(applyPlan(c.doc.pkg, across));
      const p2 = paragraphAt(doc, [2]);
      const wave = { Bold: 1, UnderlineType: 1, UnderlineShape: idx(UNDERLINE_SHAPES, "WAVE") };
      const tabExpectations: Expectation[] = [
        { probe: { id: "t0", list: 0, para: 2, charPos: hwpPos(p2, tab - 1) }, what: "탭 바로 앞 글자(탭 걸친 구간)", expect: wave, kind: "char" },
        { probe: { id: "t1", list: 0, para: 2, charPos: hwpPos(p2, tab + 1) - 1 }, what: "탭 자신(탭 걸친 구간)", expect: wave, kind: "char" },
        { probe: { id: "t2", list: 0, para: 2, charPos: hwpPos(p2, tab + 1) }, what: "탭 바로 뒤 글자(탭 걸친 구간)", expect: wave, kind: "char" },
        { probe: { id: "t3", list: 0, para: 2, charPos: hwpPos(p2, tab + 2) }, what: "구간 바로 밖(탭 뒤 둘째 글자)", expect: { Bold: 0, UnderlineType: 0 }, kind: "char" },
      ];
      const paras = placeParas(doc, [0, 1, 2], pick(0, 2, 1).map((x) => [x]), "q");
      // 문단 테두리·탭 정의: 테두리 자원을 파생해 적용한 뒤(적용 → 다시 파싱) 문단 [1]이 그것을 가리키게 한다
      const sides = ["leftBorder", "rightBorder", "topBorder", "bottomBorder"];
      const border = deriveResource(paras.doc, "borderFill", "2", [
        ...sides.flatMap((s, k) => [
          { op: "setAttr" as const, path: [s], name: "type", value: k === 0 ? "DASH" : "SOLID" },
          { op: "setAttr" as const, path: [s], name: "width", value: k === 0 ? "0.5 mm" : "0.4 mm" },
          { op: "setAttr" as const, path: [s], name: "color", value: k === 0 ? "#FF0000" : "#0000FF" },
        ]),
        { op: "setAttr" as const, path: ["fillBrush", "winBrush"], name: "faceColor", value: "#FFFF99" },
      ]);
      const withBorder = reparse(applyPlan(paras.doc.pkg, border.plan));
      const bordered = reparse(applyPlan(withBorder.pkg, planApplyParaFormat(withBorder, [{ sectionIndex: 0, path: [1] }], paraDelta(withBorder, { borderFillIDRef: border.id, tabPrIDRef: "1" }))));
      const borderExpectation: Expectation = {
        probe: { id: "border", list: 0, para: 1, charPos: 1 },
        what: "문단 테두리·탭 정의(왼쪽 DASH 0.5mm, 나머지 SOLID 0.4mm 파랑, 배경 #FFFF99, 자동 탭 왼쪽)",
        expect: {
          AlignType: 3,
          "BorderFill.BorderTypeLeft": 3,
          "BorderFill.BorderTypeRight": 1,
          "BorderFill.BorderTypeTop": 1,
          "BorderFill.BorderTypeBottom": 1,
          "BorderFill.BorderWidthLeft": 7,
          "BorderFill.BorderWidthRight": 6,
          "BorderFill.BorderWidthTop": 6,
          "BorderFill.BorderWidthBottom": 6,
          "BorderFill.BorderColorRight": bgr("#0000FF"),
          "BorderFill.BorderColorTop": bgr("#0000FF"),
          "BorderFill.BorderColorBottom": bgr("#0000FF"),
          "BorderFill.FillAttr.WinBrushFaceColor": bgr("#FFFF99"),
          "TabDef.AutoTabLeft": 1,
          "TabDef.AutoTabRight": 0,
        },
        kind: "para",
      };
      addDoc("ph-mixed", bordered, base, [...a.expectations, ...b.expectations, ...c.expectations, ...tabExpectations, ...paras.expectations.filter((x) => x.probe.id !== "q1"), borderExpectation]);
    }

    // 3) 한컴 저장본의 문단 서식(case/default 갈래가 있는 문단모양): blocks
    {
      const base = loadDoc("hancom/blocks");
      const tops = (base.sections[0]?.paragraphs ?? []).map((p, i) => ({ p, i })).filter(({ p }) => p.logicalText.replace(/￼/g, "").length >= 3 && p.objects.every((o) => o.type !== "tbl"));
      assert.ok(tops.length >= 4);
      const paras = placeParas(base, tops.slice(0, 4).map((x) => x.i), [pick(2, 5, 11), pick(0, 7, 8), pick(1, 6, 9), pick(3, 4, 10, 12)], "g");
      addDoc("blocks", paras.doc, base, paras.expectations);
    }

    // 4) 표 셀 안 문단(ph-table): 셀 "{{note}}"의 글자·문단 서식
    {
      const base = loadDoc("hancom/ph-table");
      const cell = [...walkParagraphs(base.sections[0]?.paragraphs ?? [])].find((p) => p.path.length === 3 && p.logicalText === "{{note}}");
      assert.ok(cell !== undefined);
      let doc = reparse(applyPlan(base.pkg, planApplyCharFormat(base, { sectionIndex: 0, path: cell.path, start: 2, end: 6 }, charDelta(base, { size: 15, textColor: "#aa0000", italic: true, spacing: -10 }))));
      doc = reparse(applyPlan(doc.pkg, planApplyParaFormat(doc, [{ sectionIndex: 0, path: cell.path }], paraDelta(doc, { align: "CENTER", lineSpacing: { type: "FIXED", value: 1600 } }))));
      const at = (id: string, charPos: number, what: string, expect: Record<string, number | string>, kind: "char" | "para"): Expectation => ({ probe: { id, listByText: "{{note}}", para: 0, charPos }, what, expect, kind });
      addDoc("ph-table", doc, base, [
        at("in", 3, "표 셀 안 구간", { Height: 1500, TextColor: bgr("#AA0000"), Italic: 1, ...perLang("Spacing", -10) }, "char"),
        at("out", 0, "표 셀 구간 밖(앞)", { Italic: 0, Height: 1000 }, "char"),
        at("para", 0, "표 셀 문단", { AlignType: 3, LineSpacingType: 1, LineSpacing: 3200 }, "para"),
      ]);
    }

    for (const o of originals) {
      const file = join(dir, `${o.name}.hwpx`);
      writeFileSync(file, o.bytes);
      documents.push({ name: o.name, file, probes: [] });
    }

    const report = readShapes(dir, documents);
    console.log(`R7 한컴 ${report.hancom_version ?? "?"}`);
    const pages = new Map(report.results.map((r) => [r.name, r.pages]));
    const failures: string[] = [];
    for (const res of report.results) {
      assert.ok(res.opened && !res.timeout, `${res.name}: 한컴에서 열려야 한다(${res.error ?? "시간 초과"})`);
      if (res.name.endsWith("-original")) continue;
      const before = pages.get(res.name.replace(/-after$/, "-original")) ?? res.pages ?? 1;
      const now = res.pages ?? 1;
      console.log(`R7 ${res.name}: 열림, 쪽 수 ${before} → ${now}`);
      assert.ok(Math.abs(now - before) <= Math.max(1, Math.ceil(before * 0.5)), `${res.name}: 쪽 수가 크게 바뀌었다 ${before} → ${now}`);
      for (const pr of res.probes) {
        const exp = expectations.get(`${res.name}#${pr.id}`);
        assert.ok(exp !== undefined);
        if (!pr.ok) {
          failures.push(`${res.name} ${exp.what}: 읽기 실패 ${pr.error}`);
          continue;
        }
        const got = exp.kind === "char" ? pr.char : pr.para;
        for (const [item, requested] of Object.entries(exp.expect)) {
          const read = got?.[item];
          rows.push({ doc: res.name, what: exp.what, item, requested, read });
          if (read !== requested) failures.push(`${res.name} ${exp.what} ${item}: 요청 ${requested} / 한컴 ${read}`);
        }
      }
    }
    for (const r of rows) console.log(`R7 | ${r.doc} | ${r.what} | ${r.item} | 요청 ${r.requested} | 한컴 ${r.read} | ${r.read === r.requested ? "일치" : "불일치"}`);
    console.log(`R7 대조 ${rows.length}건 중 불일치 ${failures.length}건`);
    assert.deepEqual(failures, [], `한컴이 읽은 값이 요청과 다르다:\n${failures.join("\n")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
