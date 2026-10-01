import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  applyPlan,
  readEntry,
  xmlToJson,
  type EditPlan,
  type HwpxDocument,
  type XmlJson,
} from "../src/index.ts";
import {
  charDelta,
  createDeriver,
  deriveResource,
  paraDelta,
  type CharFormat,
  type FormatDelta,
  type FormatKind,
  type ParaFormat,
} from "../src/format/index.ts";
import { MINIMAL_HEADER, loadDoc, parseSynthetic, reparse } from "./helpers.ts";

const HEADER = "Contents/header.xml";

// ── 독립 기준: 엔진의 서식 변경 코드를 쓰지 않고, 다시 파싱한 header의 자원 요소를 직접 읽는다 ──────────────

const local = (name: string): string => name.slice(name.indexOf(":") + 1);
const clone = <T>(x: T): T => structuredClone(x);

function resourceJson(doc: HwpxDocument, kind: string, id: string): XmlJson {
  const item = (doc.header.resources[kind] ?? []).find((i) => i.id === id);
  assert.ok(item !== undefined, `${kind} ${id}이(가) header에 있어야 한다`);
  return xmlToJson(item.element);
}

const withoutId = (j: XmlJson): XmlJson => {
  const copy = clone(j);
  delete copy.attrs["id"];
  return copy;
};

function kid(j: XmlJson, name: string): XmlJson {
  const found = j.children.find((c) => local(c.name) === name);
  assert.ok(found !== undefined, `자식 ${name}이(가) 있어야 한다`);
  return found;
}

/** 이름이 `name`인 후손을 문서 순서로 전부 모은다(조건 분기 안의 것 포함) */
function descendants(j: XmlJson, name: string): XmlJson[] {
  return j.children.flatMap((c) => (local(c.name) === name ? [c, ...descendants(c, name)] : descendants(c, name)));
}

const LANG_ATTRS = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"];
const setAll = (j: XmlJson, value: string): void => {
  for (const l of LANG_ATTRS) j.attrs[l] = value;
};

const throwsCode = (fn: () => unknown, code: string): void =>
  assert.throws(fn, (e: unknown) => e instanceof HwpxError && e.code === code, `${code}가 나와야 한다`);

function applyTo(doc: HwpxDocument, plan: EditPlan): HwpxDocument {
  return reparse(applyPlan(doc.pkg, plan));
}

/** 서식 자원을 파생하고 계획을 적용해 다시 읽는다. */
function derived(doc: HwpxDocument, kind: FormatKind, baseId: string, delta: FormatDelta): { id: string; reused: boolean; after: HwpxDocument; json: XmlJson } {
  const r = deriveResource(doc, kind, baseId, delta);
  const after = applyTo(doc, r.plan);
  return { id: r.id, reused: r.reused, after, json: resourceJson(after, kind, r.id) };
}

// ── R1: 글자모양 ──────────────────────────────────────────────────────

type CharCase = { label: string; spec: CharFormat; expect: (base: XmlJson) => void; /** 문서에 같은 모양이 이미 있어 재사용되는 경우의 id */ reusedId?: string };

/** 한컴 저장본(ph-mixed)의 charPr 0: fontRef, ratio, spacing, relSz, offset, underline, strikeout, outline, shadow */
const HANCOM_CHAR_CASES: CharCase[] = [
  { label: "크기 12.5pt", spec: { size: 12.5 }, expect: (b) => void (b.attrs["height"] = "1250") },
  { label: "글자색", spec: { textColor: "#ff0000" }, expect: (b) => void (b.attrs["textColor"] = "#FF0000") },
  { label: "음영색", spec: { shadeColor: "#FFFF00" }, expect: (b) => void (b.attrs["shadeColor"] = "#FFFF00") },
  { label: "진하게", spec: { bold: true }, reusedId: "7", expect: (b) => void b.children.splice(5, 0, { name: "hh:bold", attrs: {}, children: [], text: "" }) },
  { label: "기울임", spec: { italic: true }, expect: (b) => void b.children.splice(5, 0, { name: "hh:italic", attrs: {}, children: [], text: "" }) },
  { label: "장평 150", spec: { ratio: 150 }, expect: (b) => setAll(kid(b, "ratio"), "150") },
  { label: "장평 언어별", spec: { ratio: { hangul: 90, latin: 110 } }, expect: (b) => void Object.assign(kid(b, "ratio").attrs, { hangul: "90", latin: "110" }) },
  { label: "자간 -20", spec: { spacing: -20 }, expect: (b) => setAll(kid(b, "spacing"), "-20") },
  { label: "상대 크기 80", spec: { relSize: 80 }, expect: (b) => setAll(kid(b, "relSz"), "80") },
  { label: "글자 위치 10", spec: { offset: 10 }, expect: (b) => setAll(kid(b, "offset"), "10") },
  {
    label: "밑줄",
    spec: { underline: { type: "CENTER", shape: "DASH", color: "#00ff00" } },
    expect: (b) => void Object.assign(kid(b, "underline").attrs, { type: "CENTER", shape: "DASH", color: "#00FF00" }),
  },
  { label: "취소선", spec: { strikeout: { shape: "DOT", color: "#123456" } }, expect: (b) => void Object.assign(kid(b, "strikeout").attrs, { shape: "DOT", color: "#123456" }) },
  { label: "외곽선", spec: { outline: true }, expect: (b) => void (kid(b, "outline").attrs["type"] = "SOLID") },
  {
    label: "그림자",
    spec: { shadow: { type: "CONTINUOUS", color: "#808080", offsetX: 5, offsetY: 7 } },
    expect: (b) => void Object.assign(kid(b, "shadow").attrs, { type: "CONTINUOUS", color: "#808080", offsetX: "5", offsetY: "7" }),
  },
  { label: "양각", spec: { emboss: true }, expect: (b) => void b.children.push({ name: "hh:emboss", attrs: {}, children: [], text: "" }) },
  { label: "음각", spec: { engrave: true }, expect: (b) => void b.children.push({ name: "hh:engrave", attrs: {}, children: [], text: "" }) },
  { label: "위첨자", spec: { superscript: true }, expect: (b) => void b.children.push({ name: "hh:supscript", attrs: {}, children: [], text: "" }) },
  { label: "아래첨자", spec: { subscript: true }, expect: (b) => void b.children.push({ name: "hh:subscript", attrs: {}, children: [], text: "" }) },
  { label: "강조점", spec: { emphasis: "RING_ABOVE" }, expect: (b) => void (b.attrs["symMark"] = "RING_ABOVE") },
  { label: "커닝", spec: { kerning: true }, expect: (b) => void (b.attrs["useKerning"] = "1") },
  { label: "글꼴 이름(돋움)", spec: { font: "함초롬돋움" }, reusedId: "1", expect: (b) => setAll(kid(b, "fontRef"), "0") },
  { label: "여러 항목 한 번에", spec: { size: 11, bold: true, ratio: 120, underline: { shape: "WAVE" } }, expect: (b) => {
      b.attrs["height"] = "1100";
      b.children.splice(5, 0, { name: "hh:bold", attrs: {}, children: [], text: "" });
      setAll(kid(b, "ratio"), "120");
      Object.assign(kid(b, "underline").attrs, { type: "BOTTOM", shape: "WAVE", color: "#000000" });
    } },
];

test("R1 글자모양: 한컴 저장본에서 delta의 속성만 바뀌고 나머지 속성·자식은 기준과 같다(독립 기준)", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const base = withoutId(resourceJson(doc, "charPr", "0"));
  for (const c of HANCOM_CHAR_CASES) {
    const r = derived(doc, "charPr", "0", charDelta(doc, c.spec));
    assert.equal(r.reused, c.reusedId !== undefined, `${c.label}: ${c.reusedId === undefined ? "새 자원" : "재사용"}이어야 한다`);
    if (c.reusedId !== undefined) assert.equal(r.id, c.reusedId);
    const expected = clone(base);
    c.expect(expected);
    assert.deepEqual(withoutId(r.json), expected, `${c.label}: 파생 자원이 기대와 같아야 한다`);
    // 기준 자원은 그대로
    assert.deepEqual(resourceJson(r.after, "charPr", "0"), resourceJson(doc, "charPr", "0"), `${c.label}: 기준 자원은 바뀌지 않는다`);
  }
});

test("R1 글자모양: 합성 문서(D1)에서도 같다. 없는 자식(underline 등)은 관측한 순서로 만든다", () => {
  const doc = loadDoc("D1");
  const base = withoutId(resourceJson(doc, "charPr", "0"));
  assert.deepEqual(base.children.map((c) => local(c.name)), ["fontRef", "ratio", "spacing", "relSz", "offset"]);
  const r = derived(doc, "charPr", "0", charDelta(doc, { underline: { type: "TOP", shape: "DOT", color: "#0000ff" }, outline: true, shadow: { type: "DROP" }, ratio: 80 }));
  const names = r.json.children.map((c) => local(c.name));
  assert.deepEqual(names, ["fontRef", "ratio", "spacing", "relSz", "offset", "underline", "outline", "shadow"], "관측한 순서(underline → outline → shadow)");
  assert.deepEqual(kid(r.json, "underline").attrs, { type: "TOP", shape: "DOT", color: "#0000FF" });
  assert.deepEqual(kid(r.json, "outline").attrs, { type: "SOLID" });
  assert.deepEqual(kid(r.json, "shadow").attrs, { type: "DROP", color: "#C0C0C0", offsetX: "10", offsetY: "10" });
  const expected = clone(base);
  setAll(kid(expected, "ratio"), "80");
  for (const k of ["fontRef", "ratio", "spacing", "relSz", "offset"]) assert.deepEqual(kid(r.json, k), kid(expected, k), `${k}`);
  assert.equal(r.json.attrs["height"], base.attrs["height"]);
});

test("R1 글자모양: 중간에 끼는 자식(진하게·기울임)은 underline 앞에 만든다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const both = derived(doc, "charPr", "0", charDelta(doc, { bold: true, italic: true, emboss: true, subscript: true }));
  assert.deepEqual(
    both.json.children.map((c) => local(c.name)),
    ["fontRef", "ratio", "spacing", "relSz", "offset", "italic", "bold", "underline", "strikeout", "outline", "shadow", "emboss", "subscript"],
  );
});

test("R1 글자모양: 양각↔음각, 위첨자↔아래첨자는 서로 배타다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const a = derived(doc, "charPr", "0", charDelta(doc, { emboss: true, superscript: true }));
  const b = derived(a.after, "charPr", a.id, charDelta(a.after, { engrave: true, subscript: true }));
  const names = b.json.children.map((c) => local(c.name));
  assert.ok(names.includes("engrave") && names.includes("subscript"));
  assert.ok(!names.includes("emboss") && !names.includes("supscript"), "앞 서식의 양각·위첨자는 빠진다");
});

test("R1 글자모양: 끄는 요청은 기준을 끈 상태의 한컴 모양(NONE·기본값)으로 만든다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const on = derived(doc, "charPr", "0", charDelta(doc, { underline: { shape: "WAVE", color: "#FF0000" }, strikeout: { shape: "DASH" }, outline: true, shadow: { type: "DROP", color: "#FF0000", offsetX: 3, offsetY: 4 } }));
  const off = derived(on.after, "charPr", on.id, charDelta(on.after, { underline: false, strikeout: false, outline: false, shadow: false }));
  assert.equal(off.reused, true, "끄면 원래(기준 0)와 같은 모양이라 기존 자원을 재사용한다");
  assert.equal(off.id, "0");
});

// ── R1: 진하게·기울임의 표기 형태 ─────────────────────────────────────────

test("R1 진하게·기울임은 자식 요소로 적는다. 속성도 함께 쓰는 합성 문서(D1)에서는 속성도 함께 적고 끌 때 둘 다 지운다", () => {
  const doc = loadDoc("D1");
  // 합성 문서의 진한 글자모양은 `bold="1"` 속성과 <hh:bold/> 요소를 함께 가진다
  const one = resourceJson(doc, "charPr", "1");
  assert.equal(one.attrs["bold"], "1");
  assert.ok(one.children.some((c) => local(c.name) === "bold"));
  const r = derived(doc, "charPr", "0", charDelta(doc, { size: 13, bold: true, italic: true }));
  assert.equal(r.json.attrs["bold"], "1");
  assert.equal(r.json.attrs["italic"], "1");
  assert.deepEqual(r.json.children.map((c) => local(c.name)), ["fontRef", "ratio", "spacing", "relSz", "offset", "italic", "bold"]);
  const off = derived(r.after, "charPr", r.id, charDelta(r.after, { bold: false }));
  assert.ok(!("bold" in off.json.attrs));
  assert.ok(!off.json.children.some((c) => local(c.name) === "bold"));
  assert.equal(off.json.attrs["italic"], "1");
});

test("R1 진하게·기울임: 속성 표기가 없는 문서(한컴 저장본)에서는 속성을 만들지 않는다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const r = derived(doc, "charPr", "0", charDelta(doc, { italic: true }));
  assert.ok(!("italic" in r.json.attrs));
  assert.ok(r.json.children.some((c) => local(c.name) === "italic"));
});

// ── R1: 문단모양 ──────────────────────────────────────────────────────

test("R1 문단모양: 한컴 저장본은 case·default 모든 갈래에 적용하고 default는 case의 2배 단위다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const base = resourceJson(doc, "paraPr", "0");
  assert.equal(descendants(base, "left").length, 2, "case와 default 두 갈래에 left가 있다");
  const spec: ParaFormat = { align: "DISTRIBUTE", lineSpacing: { type: "FIXED", value: 1500 }, marginLeft: 1000, marginRight: 500, indent: -800, spaceBefore: 300, spaceAfter: 200, breakLatinWord: "BREAK_WORD", breakNonLatinWord: "BREAK_WORD" };
  const r = derived(doc, "paraPr", "0", paraDelta(doc, spec));
  assert.equal(r.reused, false);
  const j = r.json;
  assert.equal(kid(j, "align").attrs["horizontal"], "DISTRIBUTE");
  assert.deepEqual(descendants(j, "lineSpacing").map((l) => [l.attrs["type"], l.attrs["value"]]), [["FIXED", "1500"], ["FIXED", "3000"]]);
  assert.deepEqual(descendants(j, "left").map((l) => l.attrs["value"]), ["1000", "2000"]);
  assert.deepEqual(descendants(j, "right").map((l) => l.attrs["value"]), ["500", "1000"]);
  assert.deepEqual(descendants(j, "intent").map((l) => l.attrs["value"]), ["-800", "-1600"]);
  assert.deepEqual(descendants(j, "prev").map((l) => l.attrs["value"]), ["300", "600"]);
  assert.deepEqual(descendants(j, "next").map((l) => l.attrs["value"]), ["200", "400"]);
  assert.equal(kid(j, "breakSetting").attrs["breakLatinWord"], "BREAK_WORD");
  assert.equal(kid(j, "breakSetting").attrs["breakNonLatinWord"], "BREAK_WORD");
  // 나머지는 기준과 같다: 요청하지 않은 속성(unit, 경계 설정의 다른 속성, border, heading 등)
  const expected = clone(withoutId(base));
  kid(expected, "align").attrs["horizontal"] = "DISTRIBUTE";
  Object.assign(kid(expected, "breakSetting").attrs, { breakLatinWord: "BREAK_WORD", breakNonLatinWord: "BREAK_WORD" });
  const branches = (j2: XmlJson): XmlJson[] => descendants(j2, "case").concat(descendants(j2, "default"));
  const [caseB, defB] = branches(expected);
  assert.ok(caseB !== undefined && defB !== undefined);
  for (const [b, k] of [[caseB, 1], [defB, 2]] as const) {
    const margin = kid(b, "margin");
    kid(margin, "left").attrs["value"] = String(1000 * k);
    kid(margin, "right").attrs["value"] = String(500 * k);
    kid(margin, "intent").attrs["value"] = String(-800 * k);
    kid(margin, "prev").attrs["value"] = String(300 * k);
    kid(margin, "next").attrs["value"] = String(200 * k);
    Object.assign(kid(b, "lineSpacing").attrs, { type: "FIXED", value: String(1500 * k) });
  }
  assert.deepEqual(withoutId(j), expected);
});

test("R1 문단모양: 퍼센트 줄 간격은 두 갈래가 같은 값이다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const r = derived(doc, "paraPr", "0", paraDelta(doc, { lineSpacing: { type: "PERCENT", value: 130 } }));
  assert.deepEqual(descendants(r.json, "lineSpacing").map((l) => [l.attrs["type"], l.attrs["value"]]), [["PERCENT", "130"], ["PERCENT", "130"]]);
});

test("R1 문단모양: 합성 문서(D1)는 갈래가 없으므로 case와 같은 단위(HWPUNIT)로 한 번 쓴다", () => {
  const doc = loadDoc("D1");
  const base = resourceJson(doc, "paraPr", "0");
  assert.equal(descendants(base, "case").length, 0);
  const r = derived(doc, "paraPr", "0", paraDelta(doc, { align: "RIGHT", marginLeft: 1200, indent: 600, lineSpacing: { type: "AT_LEAST", value: 2000 } }));
  assert.deepEqual(descendants(r.json, "left").map((l) => l.attrs["value"]), ["1200"]);
  assert.deepEqual(descendants(r.json, "intent").map((l) => l.attrs["value"]), ["600"]);
  assert.deepEqual(descendants(r.json, "lineSpacing").map((l) => [l.attrs["type"], l.attrs["value"]]), [["AT_LEAST", "2000"]]);
  assert.equal(kid(r.json, "align").attrs["horizontal"], "RIGHT");
});

test("R1 문단모양: 테두리·탭 정의 참조는 문서에 있는 자원만 가리킬 수 있다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const r = derived(doc, "paraPr", "0", paraDelta(doc, { borderFillIDRef: "1", tabPrIDRef: "2" }));
  assert.equal(kid(r.json, "border").attrs["borderFillIDRef"], "1");
  assert.equal(r.json.attrs["tabPrIDRef"], "2");
  throwsCode(() => paraDelta(doc, { borderFillIDRef: "99" }), "FMT_BASE_NOT_FOUND");
  throwsCode(() => paraDelta(doc, { tabPrIDRef: "99" }), "FMT_BASE_NOT_FOUND");
});

// ── R1: 테두리 ────────────────────────────────────────────────────────

test("R1 테두리: 일반 연산(setAttr·addChild·removeChild)으로 파생한다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const base = resourceJson(doc, "borderFill", "2");
  const r = derived(doc, "borderFill", "2", [
    { op: "setAttr", path: ["leftBorder"], name: "type", value: "SOLID" },
    { op: "setAttr", path: ["leftBorder"], name: "width", value: "0.4 mm" },
    { op: "setAttr", path: ["leftBorder"], name: "color", value: "#FF0000" },
    { op: "setAttr", path: ["fillBrush", "winBrush"], name: "faceColor", value: "#FFFF99" },
  ]);
  const expected = clone(withoutId(base));
  Object.assign(kid(expected, "leftBorder").attrs, { type: "SOLID", width: "0.4 mm", color: "#FF0000" });
  kid(kid(expected, "fillBrush"), "winBrush").attrs["faceColor"] = "#FFFF99";
  assert.deepEqual(withoutId(r.json), expected);
});

test("R1 테두리: 채움이 없는 테두리에 채움을 관측한 순서(맨 끝)로 만든다", () => {
  const doc = loadDoc("D1");
  const withoutBrush = (doc.header.resources["borderFill"] ?? []).find((i) => !i.element.children.some((c) => "local" in c && c.local === "fillBrush"));
  assert.ok(withoutBrush !== undefined);
  const r = derived(doc, "borderFill", withoutBrush.id, [
    { op: "addChild", path: [], name: "fillBrush" },
    { op: "addChild", path: ["fillBrush"], name: "winBrush", attrs: { faceColor: "#EEEEEE", hatchColor: "#999999", alpha: "0" } },
  ]);
  const names = r.json.children.map((c) => local(c.name));
  assert.equal(names.at(-1), "fillBrush");
  assert.deepEqual(kid(kid(r.json, "fillBrush"), "winBrush").attrs, { faceColor: "#EEEEEE", hatchColor: "#999999", alpha: "0" });
});

// ── R2: 같은 요청은 같은 id ───────────────────────────────────────────

test("R2 같은 요청을 두 번 하면 같은 id이고, 적용 뒤 다시 요청하면 추가 자원이 0이다", () => {
  for (const name of ["hancom/ph-mixed", "D1", "hancom-merged"]) {
    const doc = loadDoc(name);
    const delta = charDelta(doc, { ratio: 77, relSize: 90, underline: { shape: "WAVE" } });
    const a = deriveResource(doc, "charPr", "0", delta);
    const b = deriveResource(doc, "charPr", "0", delta);
    assert.equal(a.id, b.id, `${name}: 같은 id`);
    assert.equal(a.reused, false);
    assert.deepEqual(a.plan.edits, b.plan.edits, `${name}: 같은 계획`);

    const after = applyTo(doc, a.plan);
    const c = deriveResource(after, "charPr", "0", delta);
    assert.equal(c.id, a.id, `${name}: 적용 뒤에도 같은 id`);
    assert.equal(c.reused, true);
    assert.deepEqual(c.plan.edits, [], `${name}: 추가 자원 0(계획이 비어 있다)`);
    assert.equal(c.plan.summary["addedResources"], 0);
  }
});

test("R2 한 번의 파생기 안에서 같은 요청을 거듭해도 자원은 하나만 추가된다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const deriver = createDeriver(doc);
  const delta = charDelta(doc, { spacing: -33 });
  const ids = [deriver.derive("charPr", "0", delta), deriver.derive("charPr", "0", delta), deriver.derive("charPr", "0", delta)];
  assert.equal(new Set(ids.map((x) => x.id)).size, 1);
  assert.deepEqual(ids.map((x) => x.reused), [false, true, true]);
  const plan = deriver.finish();
  assert.equal(plan.summary["addedResources"], 1);
  assert.equal(plan.edits.filter((e) => e.entry === HEADER && e.replacement.includes("<hh:charPr ")).length, 1);
});

test("R2 서로 다른 기준에서 파생해도 새 id가 겹치지 않고, 결과가 같은 모양이면 한 자원으로 합쳐진다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const deriver = createDeriver(doc);
  // charPr 0(크기 10, 글꼴 1)과 charPr 2(크기 9, 글꼴 0): 같은 delta로 새 자원 둘
  const x = deriver.derive("charPr", "0", charDelta(doc, { ratio: 140 }));
  const y = deriver.derive("charPr", "2", charDelta(doc, { ratio: 140 }));
  assert.notEqual(x.id, y.id);
  // 크기 9·글꼴 0인 2에 "크기 10 + 글꼴 바탕"을 요구하면 0과 같아지고, 거기에 장평 140을 더한 x와 같다
  const z = deriver.derive("charPr", "2", charDelta(doc, { size: 10, font: "함초롬바탕", ratio: 140 }));
  assert.equal(z.id, x.id, "다른 기준에서 같은 모양이 되면 합쳐진다");
  const plan = deriver.finish();
  assert.equal(plan.summary["addedResources"], 2);
  const after = applyTo(doc, plan);
  const ids = (after.header.resources["charPr"] ?? []).map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "id 중복 없음");
  assert.deepEqual(ids.slice(-2), [x.id, y.id]);
  const counts = after.header.counts.find((c) => c.list === "charProperties");
  assert.equal(counts?.value, ids.length, "개수 속성 갱신");
});

// ── R3: 같은 모양이 이미 있으면 재사용 ───────────────────────────────────

test("R3 진하게를 요청했는데 진한 글자모양이 이미 있는 한컴 문서에서는 그것을 재사용한다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  // charPr 7은 charPr 0에 <hh:bold/>만 더한 모양이다(독립 확인)
  const zero = withoutId(resourceJson(doc, "charPr", "0"));
  const seven = withoutId(resourceJson(doc, "charPr", "7"));
  assert.deepEqual(seven.children.map((c) => local(c.name)), ["fontRef", "ratio", "spacing", "relSz", "offset", "bold", "underline", "strikeout", "outline", "shadow"]);
  assert.deepEqual({ ...seven, children: seven.children.filter((c) => local(c.name) !== "bold") }, zero);

  const r = deriveResource(doc, "charPr", "0", charDelta(doc, { bold: true }));
  assert.equal(r.id, "7");
  assert.equal(r.reused, true);
  assert.deepEqual(r.plan.edits, []);
  assert.equal(r.plan.summary["addedResources"], 0);
  assert.equal(r.plan.summary["reusedResources"], 1);
  // 이미 진한 글자모양에 진하게를 요청하면 자기 자신
  assert.equal(deriveResource(doc, "charPr", "7", charDelta(doc, { bold: true })).id, "7");
});

test("R3 합성 문서(D1)에서도 진한 글자모양(속성+요소 형태)을 재사용한다", () => {
  const doc = loadDoc("D1");
  const zero = withoutId(resourceJson(doc, "charPr", "0"));
  const one = withoutId(resourceJson(doc, "charPr", "1"));
  const plain = clone(one);
  delete plain.attrs["bold"];
  plain.children = plain.children.filter((c) => local(c.name) !== "bold");
  assert.deepEqual(plain, zero, "charPr 1은 charPr 0에 bold(속성·요소)만 더한 모양");
  const r = deriveResource(doc, "charPr", "0", charDelta(doc, { bold: true }));
  assert.equal(r.id, "1");
  assert.equal(r.reused, true);
  assert.deepEqual(r.plan.edits, []);
});

test("R3 같은 모양이 없으면 새로 만든다(재사용이 아닌 경우의 대조)", () => {
  const doc = loadDoc("hancom/ph-single");
  const bolds = (doc.header.resources["charPr"] ?? []).filter((i) => i.element.children.some((c) => "local" in c && c.local === "bold"));
  assert.equal(bolds.length, 0, "이 문서에는 진한 글자모양이 없다");
  const r = deriveResource(doc, "charPr", "0", charDelta(doc, { bold: true }));
  assert.equal(r.reused, false);
  assert.ok(r.plan.edits.length > 0);
});

test("R3 문단모양도 같은 모양이 있으면 재사용한다(기준 자신으로 되돌리는 요청 포함)", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const one = resourceJson(doc, "paraPr", "1");
  const leftOf1 = descendants(one, "left")[0]?.attrs["value"];
  assert.equal(leftOf1, "1500");
  // 0번(왼쪽 여백 0)에 왼쪽 여백 1500을 요구하면 1번과 같은 모양인가? 1번은 tabPrIDRef 등이 같고 여백만 다르다
  const r = deriveResource(doc, "paraPr", "0", paraDelta(doc, { marginLeft: 1500 }));
  assert.equal(r.reused, true);
  assert.equal(r.id, "1");
  // 기준과 같은 값을 요청하면 기준 자신
  const same = deriveResource(doc, "paraPr", "0", paraDelta(doc, { align: "JUSTIFY", lineSpacing: { type: "PERCENT", value: 160 } }));
  assert.equal(same.id, "0");
  assert.equal(same.reused, true);
});

// ── 계획의 모양: header 추가와 개수 속성만 ────────────────────────────────

test("계획은 header 목록 끝에 추가하는 편집과 개수 속성 갱신 둘뿐이고, 다른 항목은 바이트 그대로다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const r = deriveResource(doc, "charPr", "0", charDelta(doc, { ratio: 91 }));
  assert.equal(r.plan.edits.length, 2);
  assert.ok(r.plan.edits.every((e) => e.entry === HEADER));
  assert.deepEqual(r.plan.additions, []);
  const [add, count] = r.plan.edits;
  assert.ok(add !== undefined && count !== undefined);
  const list = (doc.header.resources["charPr"] ?? []).at(-1);
  assert.equal(add.start, list?.element.end, "목록의 마지막 자식 바로 뒤");
  assert.equal(add.start, add.end);
  assert.equal(count.replacement, "9");

  const bytes = applyPlan(doc.pkg, r.plan);
  const after = reparse(bytes);
  for (const entry of doc.pkg.archive.entries) {
    if (entry.name === HEADER) continue;
    assert.deepEqual(readEntry(after.pkg.archive, bytes, entry.name), readEntry(doc.pkg.archive, doc.pkg.bytes, entry.name), `${entry.name}은 그대로`);
  }
  // header는 새 자원과 개수 숫자 한 글자 외에는 같다
  const before = doc.header.text;
  assert.equal(after.header.text.length, before.length + add.replacement.length);
  assert.equal(after.header.text.replace(add.replacement, "").replace('<hh:charProperties itemCnt="9">', '<hh:charProperties itemCnt="8">'), before);
});

test("새 id는 그 종류의 가장 큰 숫자 id + 1이다(번호가 비어 있어도 채우지 않는다)", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const maxId = Math.max(...(doc.header.resources["charPr"] ?? []).map((i) => Number(i.id)));
  assert.equal(deriveResource(doc, "charPr", "0", charDelta(doc, { ratio: 91 })).id, String(maxId + 1));
  const maxPara = Math.max(...(doc.header.resources["paraPr"] ?? []).map((i) => Number(i.id)));
  assert.equal(deriveResource(doc, "paraPr", "0", paraDelta(doc, { marginLeft: 123 })).id, String(maxPara + 1));
});

// ── 일반 연산과 거절 ──────────────────────────────────────────────────

test("일반 연산: addChild는 같은 이름이 있으면 새로 만들지 않고 속성만 덮어쓴다(멱등)", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const r = derived(doc, "charPr", "7", [{ op: "addChild", path: [], name: "bold", attrs: { note: "x" } }]);
  assert.equal(r.json.children.filter((c) => local(c.name) === "bold").length, 1);
  assert.equal(kid(r.json, "bold").attrs["note"], "x");
  const noop = deriveResource(doc, "charPr", "7", [{ op: "addChild", path: [], name: "bold" }]);
  assert.equal(noop.id, "7");
  assert.equal(noop.reused, true);
});

test("일반 연산: removeChild·removeAttr는 없으면 아무 일도 하지 않는다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const a = deriveResource(doc, "charPr", "0", [{ op: "removeChild", path: [], name: "bold" }, { op: "removeAttr", path: [], name: "nothing" }]);
  assert.equal(a.id, "0");
  const b = derived(doc, "charPr", "7", [{ op: "removeChild", path: [], name: "bold" }]);
  assert.equal(b.id, "0", "진하게를 지우면 0과 같은 모양이라 재사용");
  const c = derived(doc, "charPr", "0", [{ op: "removeAttr", path: [], name: "useKerning" }]);
  assert.ok(!("useKerning" in c.json.attrs));
  assert.equal(c.json.attrs["useFontSpace"], "0");
});

test("일반 연산: 속성이 없으면 시작 태그 끝에 만든다", () => {
  const doc = loadDoc("D1");
  const r = derived(doc, "charPr", "0", [{ op: "setAttr", path: [], name: "memo", value: "a&b<c" }]);
  assert.equal(r.json.attrs["memo"], "a&b<c", "해독한 값이 요청한 값과 같다(이스케이프)");
});

test("관측한 순서가 없는 자식은 FMT_UNKNOWN_CHILD, 알 수 없는 종류·기준·글꼴·값은 각자의 코드로 거절한다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  throwsCode(() => deriveResource(doc, "charPr", "0", [{ op: "addChild", path: [], name: "glow" }]), "FMT_UNKNOWN_CHILD");
  throwsCode(() => deriveResource(doc, "charPr", "0", [{ op: "setAttr", path: ["glow"], name: "x", value: "1" }]), "FMT_UNKNOWN_CHILD");
  throwsCode(() => deriveResource(doc, "charPr", "0", [{ op: "addChild", path: ["underline"], name: "x" }]), "FMT_UNKNOWN_CHILD");
  throwsCode(() => deriveResource(doc, "style" as FormatKind, "0", []), "FMT_KIND");
  throwsCode(() => deriveResource(doc, "charPr", "999", []), "FMT_BASE_NOT_FOUND");
  throwsCode(() => charDelta(doc, { font: "없는글꼴" }), "FMT_FONT_NOT_FOUND");
  throwsCode(() => charDelta(doc, { font: { hangul: "없는글꼴" } }), "FMT_FONT_NOT_FOUND");
  throwsCode(() => charDelta(doc, { ratio: 49 }), "FMT_BAD_VALUE");
  throwsCode(() => charDelta(doc, { ratio: 201 }), "FMT_BAD_VALUE");
  throwsCode(() => charDelta(doc, { spacing: -51 }), "FMT_BAD_VALUE");
  throwsCode(() => charDelta(doc, { spacing: 1.5 }), "FMT_BAD_VALUE");
  throwsCode(() => charDelta(doc, { textColor: "red" }), "FMT_BAD_VALUE");
  throwsCode(() => charDelta(doc, { underline: { shape: "SQUIGGLE" as never } }), "FMT_BAD_VALUE");
  throwsCode(() => charDelta(doc, { emphasis: "STAR" as never }), "FMT_BAD_VALUE");
  throwsCode(() => paraDelta(doc, { align: "MIDDLE" as never }), "FMT_BAD_VALUE");
  throwsCode(() => paraDelta(doc, { lineSpacing: { type: "PERCENT", value: 600 } }), "FMT_BAD_VALUE");
  throwsCode(() => paraDelta(doc, { marginLeft: -1 }), "FMT_BAD_VALUE");
  throwsCode(() => deriveResource(doc, "charPr", "0", [{ op: "setAttr", path: [], name: "x", value: "a\nb" }]), "FMT_BAD_VALUE");
});

test("글꼴은 이름으로 찾는다: 문자열은 그 이름이 있는 모든 언어에, 객체는 적은 언어에만 적용한다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const all = derived(doc, "charPr", "0", charDelta(doc, { font: "함초롬돋움" }));
  for (const l of LANG_ATTRS) assert.equal(kid(all.json, "fontRef").attrs[l], "0");
  const some = derived(doc, "charPr", "0", charDelta(doc, { font: { hangul: "함초롬돋움" } }));
  assert.equal(kid(some.json, "fontRef").attrs["hangul"], "0");
  assert.equal(kid(some.json, "fontRef").attrs["latin"], "1", "적지 않은 언어는 기준 그대로");
});

test("기준 자원과 문서는 바뀌지 않는다(deriveResource는 모델을 건드리지 않는다)", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const before = doc.header.text;
  const bytesBefore = Buffer.from(doc.pkg.bytes).toString("base64");
  deriveResource(doc, "charPr", "0", charDelta(doc, { ratio: 150, bold: true }));
  deriveResource(doc, "paraPr", "0", paraDelta(doc, { marginLeft: 700 }));
  assert.equal(doc.header.text, before);
  assert.equal(Buffer.from(doc.pkg.bytes).toString("base64"), bytesBefore);
});

test("header에 그 종류의 목록이 없으면 FMT_NO_LIST로 거절한다", () => {
  const header = MINIMAL_HEADER.replace(/<hh:borderFills[\s\S]*?<\/hh:borderFills>/, "");
  assert.ok(!header.includes("borderFills"));
  const doc = parseSynthetic(["<hp:p id=\"1\" paraPrIDRef=\"0\" styleIDRef=\"0\"><hp:run charPrIDRef=\"0\"><hp:t>abc</hp:t></hp:run></hp:p>"], header);
  throwsCode(() => deriveResource(doc, "borderFill", "1", [{ op: "setAttr", path: [], name: "threeD", value: "1" }]), "FMT_NO_LIST");
  // 있는 목록은 된다(최소 header의 charPr는 fontRef만 가진다)
  const ok = deriveResource(doc, "charPr", "0", charDelta(doc, { ratio: 80 }));
  assert.equal(ok.reused, false);
  assert.deepEqual(derivedKids(doc, ok.plan), ["fontRef", "ratio"]);
});

/** 계획을 적용한 문서의 마지막 charPr의 자식 이름들 */
function derivedKids(doc: HwpxDocument, plan: EditPlan): string[] {
  const after = applyTo(doc, plan);
  const last = (after.header.resources["charPr"] ?? []).at(-1);
  assert.ok(last !== undefined);
  return xmlToJson(last.element).children.map((c) => local(c.name));
}

test("일반 연산 setAttr는 defaultBranchValue가 없으면 case·default 모든 갈래에 같은 값을 쓴다(heading처럼 갈래마다 따로 든 요소도)", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const a = derived(doc, "paraPr", "0", [{ op: "setAttr", path: ["margin", "left"], name: "value", value: "777" }]);
  assert.deepEqual(descendants(a.json, "left").map((l) => l.attrs["value"]), ["777", "777"]);

  // heading이 switch 안(case·default 각각)에 든 문단모양을 시험 문서에서 찾는다
  const names = ["hancom/blocks", "hancom/field-states", "hancom/header-footer", "hancom-merged", "hancom/ph-table", "hancom/picture"];
  let tested = 0;
  for (const name of names) {
    const d = loadDoc(name);
    const item = (d.header.resources["paraPr"] ?? []).find((i) => descendants(xmlToJson(i.element), "heading").length === 2);
    if (item === undefined) continue;
    const r = derived(d, "paraPr", item.id, [{ op: "setAttr", path: ["heading"], name: "level", value: "5" }]);
    assert.deepEqual(descendants(r.json, "heading").map((h) => h.attrs["level"]), ["5", "5"], name);
    tested++;
  }
  assert.ok(tested > 0, "heading이 switch 안에 든 문단모양이 있는 시험 문서가 있어야 한다");
});
