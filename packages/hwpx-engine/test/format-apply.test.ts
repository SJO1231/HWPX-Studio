import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  applyPlan,
  compareToBaseline,
  validateDocument,
  walkParagraphs,
  xmlToJson,
  type EditPlan,
  type HwpxDocument,
  type ParagraphNode,
  type XmlJson,
} from "../src/index.ts";
import {
  charDelta,
  deriveResource,
  paraDelta,
  planApplyCharFormat,
  planApplyParaFormat,
  type CharFormat,
  type CharTarget,
  type FormatDelta,
  type ParaFormat,
} from "../src/format/index.ts";
import { MINIMAL_HEADER, loadDoc, parseSynthetic, reparse } from "./helpers.ts";

// ── 독립 기준 ─────────────────────────────────────────────────────────

const local = (name: string): string => name.slice(name.indexOf(":") + 1);
const clone = <T>(x: T): T => structuredClone(x);

const throwsCode = (fn: () => unknown, code: string, label = ""): void =>
  assert.throws(fn, (e: unknown) => e instanceof HwpxError && e.code === code, `${label} ${code}가 나와야 한다`);

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

function descendants(j: XmlJson, name: string): XmlJson[] {
  return j.children.flatMap((c) => (local(c.name) === name ? [c, ...descendants(c, name)] : descendants(c, name)));
}

const LANGS = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"];
const setAll = (j: XmlJson, value: string): void => {
  for (const l of LANGS) j.attrs[l] = value;
};
const flagChild = (name: string): XmlJson => ({ name: `hh:${name}`, attrs: {}, children: [], text: "" });

/** 주소가 가리키는 문단(구역 0 기준) */
function paragraphAt(doc: HwpxDocument, path: number[], sectionIndex = 0): ParagraphNode {
  let list = doc.sections[sectionIndex]?.paragraphs ?? [];
  let found: ParagraphNode | undefined;
  for (let n = 0; n < path.length; n++) {
    const i = path[n] ?? -1;
    if (n % 2 === 0) found = list[i];
    else list = found?.subLists[i]?.paragraphs ?? [];
  }
  assert.ok(found !== undefined, `문단 [${path.join(",")}]이(가) 있어야 한다`);
  return found;
}

/** 논리 텍스트의 글자마다 그 글자를 담은 run의 글자모양 id */
function charIds(doc: HwpxDocument, path: number[], sectionIndex = 0): string[] {
  const p = paragraphAt(doc, path, sectionIndex);
  const out: string[] = [];
  for (const piece of p.pieces) {
    const id = p.runs[piece.runOrdinal]?.charPrIDRef ?? "?";
    for (let i = piece.logicalStart; i < piece.logicalEnd; i++) out.push(id);
  }
  assert.equal(out.length, p.logicalText.length);
  return out;
}

/** run·hp:t 감싸기와 줄 배치 캐시를 걷어 낸 구역 원문. 서식 변경 전후로 이 값이 같아야 한다(쪼개기와 id 바꾸기, 캐시 제거 외에는 원문이 그대로). */
const stripWrap = (xml: string): string =>
  xml
    .replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "")
    .replace(/<\/?hp:run\b[^>]*>/g, "")
    .replace(/<\/?hp:t\b[^>]*>/g, "")
    .replace(/\]\]><!\[CDATA\[/g, ""); // CDATA 구역 가운데에서 쪼개면 구역도 둘로 나뉜다(내용은 같다)

/** 문단 서식 변경 전후 비교용: 문단의 paraPrIDRef 값도 걷어 낸다 */
const stripPara = (xml: string): string => stripWrap(xml).replace(/paraPrIDRef="[^"]*"/g, 'paraPrIDRef=""');

/** 긴 문자열 비교: 다르면 처음 달라지는 위치 주변만 보인다 */
function sameText(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  let i = 0;
  while (i < actual.length && actual[i] === expected[i]) i++;
  assert.fail(`${label}: ${i}번째 글자부터 다르다
실제: ${actual.slice(Math.max(0, i - 60), i + 60)}
기대: ${expected.slice(Math.max(0, i - 60), i + 60)}`);
}

const lineSegCount = (doc: HwpxDocument): number => doc.sections.reduce((n, s) => n + (s.text.match(/<hp:linesegarray>/g)?.length ?? 0), 0);

function allParagraphs(doc: HwpxDocument): ParagraphNode[] {
  return doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)]);
}

function newErrorsAfter(before: HwpxDocument, bytes: Uint8Array): number {
  return compareToBaseline(validateDocument(before.pkg.bytes), validateDocument(bytes)).newErrors.length;
}

type Applied = { plan: EditPlan; bytes: Uint8Array; after: HwpxDocument };

function applyChar(doc: HwpxDocument, target: CharTarget, spec: CharFormat | FormatDelta): Applied {
  const delta = Array.isArray(spec) ? spec : charDelta(doc, spec);
  const plan = planApplyCharFormat(doc, target, delta);
  const bytes = applyPlan(doc.pkg, plan);
  return { plan, bytes, after: reparse(bytes) };
}

/**
 * 구간 적용 결과의 공통 확인: 문단 글 불변, 구간 밖 글자모양 불변, 구간 안 글자의 자원 = 기준 자원 + 기대 변화, 기준 자원 불변,
 * 다른 문단 불변, 원문(쪼개기·id·캐시 외) 불변, 새 오류 0.
 */
function checkRange(label: string, doc: HwpxDocument, r: Applied, target: CharTarget, expect: (base: XmlJson) => void): void {
  const { start, end, path } = target;
  const sectionIndex = target.sectionIndex;
  const beforeP = paragraphAt(doc, path, sectionIndex);
  const afterP = paragraphAt(r.after, path, sectionIndex);
  assert.equal(afterP.logicalText, beforeP.logicalText, `${label}: 문단의 논리 텍스트가 그대로`);

  const was = charIds(doc, path, sectionIndex);
  const now = charIds(r.after, path, sectionIndex);
  for (let i = 0; i < was.length; i++) {
    if (i < start || i >= end) {
      assert.equal(now[i], was[i], `${label}: 구간 밖 ${i}번 글자의 글자모양이 그대로`);
      continue;
    }
    const expected = withoutId(resourceJson(doc, "charPr", was[i] ?? ""));
    expect(expected);
    assert.deepEqual(withoutId(resourceJson(r.after, "charPr", now[i] ?? "")), expected, `${label}: 구간 안 ${i}번 글자의 자원 = 기준 + 변화`);
  }
  // 기준 자원은 그대로
  for (const item of doc.header.resources["charPr"] ?? []) {
    assert.deepEqual(resourceJson(r.after, "charPr", item.id), xmlToJson(item.element), `${label}: 기존 charPr ${item.id}은 그대로`);
  }
  // 다른 문단은 글자모양·문단모양·글이 그대로
  const target0 = JSON.stringify([sectionIndex, path]);
  const oldAll = allParagraphs(doc);
  const newAll = allParagraphs(r.after);
  assert.equal(newAll.length, oldAll.length, `${label}: 문단 수`);
  oldAll.forEach((p, i) => {
    const q = newAll[i];
    assert.ok(q !== undefined);
    assert.equal(q.logicalText, p.logicalText);
    assert.equal(q.attrs.paraPrIDRef, p.attrs.paraPrIDRef);
    if (JSON.stringify([0, p.path]) === target0) return;
    assert.deepEqual(q.runs.map((x) => x.charPrIDRef), p.runs.map((x) => x.charPrIDRef), `${label}: 다른 문단 [${p.path.join(",")}]의 run이 그대로`);
  });
  // 원문: run·t 감싸기와 캐시를 걷어 내면 같다
  sameText(stripWrap(r.after.sections[sectionIndex]?.text ?? ""), stripWrap(doc.sections[sectionIndex]?.text ?? ""), `${label}: 쪼개기·id·캐시 외의 원문이 그대로`);
  assert.equal(r.after.sections[sectionIndex]?.text.includes("<hp:linesegarray>"), false, `${label}: 그 구역의 줄 배치 캐시가 지워진다`);
  assert.equal(newErrorsAfter(doc, r.bytes), 0, `${label}: 검사기 새 오류 0`);
}

/** 언어별 요소(ratio·spacing 등)의 7개 속성을 모두 v로 한다. 기준에 그 요소가 없으면 관측한 위치(fontRef 뒤)에 만든다. */
function langElement(b: XmlJson, name: string, v: string): void {
  let el = b.children.find((c) => local(c.name) === name);
  if (el === undefined) {
    el = { name: `hh:${name}`, attrs: {}, children: [], text: "" };
    const order = ["fontRef", "ratio", "spacing", "relSz", "offset"];
    const at = b.children.findIndex((c) => order.indexOf(local(c.name)) > order.indexOf(name));
    b.children.splice(at < 0 ? b.children.length : at, 0, el);
  }
  setAll(el, v);
}
const setRatio =
  (v: string) =>
  (b: XmlJson): void =>
    langElement(b, "ratio", v);

// ── R4: 구간 적용 ─────────────────────────────────────────────────────

test("R4 한 run 안 문단 한가운데 구간(ph-single): run이 셋으로 쪼개지고 구간 밖은 그대로다", () => {
  const doc = loadDoc("hancom/ph-single");
  const p = paragraphAt(doc, [0]);
  assert.equal(p.runs.length, 2);
  const target: CharTarget = { sectionIndex: 0, path: [0], start: 6, end: 11 };
  const r = applyChar(doc, target, { ratio: 150 });
  checkRange("한가운데", doc, r, target, setRatio("150"));
  const after = paragraphAt(r.after, [0]);
  assert.equal(after.runs.length, p.runs.length + 2, "앞·안·뒤 셋으로");
  assert.equal(r.plan.summary["addedRuns"], 2);
  assert.equal(r.plan.summary["changedRuns"], 1);
  // 구간 안 글은 가운데 run 하나다
  const mid = after.runs[2];
  assert.ok(mid !== undefined);
  const piece = after.pieces.find((x) => x.runOrdinal === 2);
  assert.equal(after.logicalText.slice(piece?.logicalStart, piece?.logicalEnd), p.logicalText.slice(6, 11));
});

test("R4 구간이 run의 앞이나 끝에 닿으면 한쪽만 쪼갠다", () => {
  const doc = loadDoc("hancom/ph-single");
  const p = paragraphAt(doc, [0]);
  const textRun = p.pieces.find((x) => x.runOrdinal === 1);
  assert.ok(textRun !== undefined);
  const head: CharTarget = { sectionIndex: 0, path: [0], start: textRun.logicalStart, end: textRun.logicalStart + 4 };
  const a = applyChar(doc, head, { spacing: -10 });
  checkRange("run 앞쪽", doc, a, head, (b) => setAll(kid(b, "spacing"), "-10"));
  assert.equal(a.plan.summary["addedRuns"], 1);
  const tail: CharTarget = { sectionIndex: 0, path: [0], start: textRun.logicalEnd - 4, end: textRun.logicalEnd };
  const b = applyChar(doc, tail, { spacing: -10 });
  checkRange("run 끝쪽", doc, b, tail, (x) => setAll(kid(x, "spacing"), "-10"));
  assert.equal(b.plan.summary["addedRuns"], 1);
  const whole: CharTarget = { sectionIndex: 0, path: [0], start: textRun.logicalStart, end: textRun.logicalEnd };
  const c = applyChar(doc, whole, { spacing: -10 });
  checkRange("run 전체", doc, c, whole, (x) => setAll(kid(x, "spacing"), "-10"));
  assert.equal(c.plan.summary["addedRuns"], 0, "run 하나가 구간과 같으면 쪼개지 않는다");
});

test("R4 여러 run에 걸친 구간(ph-mixed): run마다 기준이 달라 결과 id가 다르다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const p = paragraphAt(doc, [0]);
  const boundary = p.pieces.find((x) => x.runOrdinal === 2)?.logicalStart;
  assert.ok(boundary !== undefined);
  const target: CharTarget = { sectionIndex: 0, path: [0], start: boundary - 4, end: boundary + 3 };
  const was = charIds(doc, [0]);
  assert.deepEqual([...new Set(was.slice(target.start, target.end))].sort(), ["0", "7"], "구간이 charPr 0과 7 run에 걸친다");
  const r = applyChar(doc, target, { ratio: 150, textColor: "#ff0000" });
  checkRange("여러 run", doc, r, target, (b) => {
    setAll(kid(b, "ratio"), "150");
    b.attrs["textColor"] = "#FF0000";
  });
  const now = charIds(r.after, [0]);
  const inside = now.slice(target.start, target.end);
  assert.equal(new Set(inside).size, 2, "구간 안 글자모양이 둘(기준이 둘이므로)");
  assert.equal(r.plan.summary["changedRuns"], 2);
});

test("R4 탭이 든 문단(ph-mixed): 탭을 가운데 둔 구간, 탭만, 탭 바로 뒤에서 시작하는 구간", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const p = paragraphAt(doc, [2]);
  const tab = p.logicalText.indexOf("\t");
  assert.ok(tab > 0);
  const pieces = p.pieces.map((x) => x.kind);
  assert.deepEqual(pieces, ["text", "inline", "text"], "탭은 hp:t 안의 인라인 조각이다");
  const cases: [string, number, number][] = [
    ["탭 가운데", tab - 3, tab + 4],
    ["탭만", tab, tab + 1],
    ["탭 뒤부터", tab + 1, tab + 6],
    ["탭 앞까지", tab - 5, tab],
    ["문단 전체", 0, p.logicalText.length],
  ];
  for (const [label, start, end] of cases) {
    const target: CharTarget = { sectionIndex: 0, path: [2], start, end };
    const r = applyChar(doc, target, { italic: true, relSize: 80 });
    checkRange(label, doc, r, target, (b) => {
      b.children.splice(5, 0, flagChild("italic"));
      setAll(kid(b, "relSz"), "80");
    });
    // 탭 조각은 쪼개진 hp:t 사이에서도 한 번만 있다
    assert.equal((r.after.sections[0]?.text.match(/<hp:tab /g) ?? []).length, (doc.sections[0]?.text.match(/<hp:tab /g) ?? []).length, `${label}: 탭 개수`);
  }
});

test("R4 표 셀 안 문단(hancom-merged): 셀 문단의 구간에 적용하고 표와 다른 문단은 그대로다", () => {
  const doc = loadDoc("hancom-merged");
  const cell = allParagraphs(doc).find((q) => q.path.length === 3 && q.logicalText.replace(/￼/g, "").length >= 6);
  assert.ok(cell !== undefined, "셀 안 글이 있는 문단");
  const target: CharTarget = { sectionIndex: 0, path: cell.path, start: 1, end: Math.min(5, cell.logicalText.length) };
  assert.ok(lineSegCount(doc) > 0, "한컴 저장본은 문단마다 줄 배치 캐시가 있다");
  const r = applyChar(doc, target, { bold: true, size: 12 });
  checkRange("표 셀", doc, r, target, (b) => {
    b.attrs["height"] = "1200";
    if (!b.children.some((c) => local(c.name) === "bold")) b.children.splice(b.children.findIndex((c) => local(c.name) === "underline"), 0, flagChild("bold"));
  });
  assert.equal(lineSegCount(r.after), 0);
  assert.ok(r.plan.summary["removedLineSegs"] === lineSegCount(doc));
});

test("R4 합성 문서(D6)의 여러 run 문단(셀 안, run 6개)에서 모든 (시작, 끝) 조합이 성립한다", () => {
  const doc = loadDoc("D6");
  const q = allParagraphs(doc).find((x) => x.path.join(".") === "0.1.0");
  assert.ok(q !== undefined && q.runs.length === 6);
  const len = q.logicalText.length;
  let n = 0;
  for (let start = 0; start < len; start += 3) {
    for (let end = start + 1; end <= len; end += 5) {
      const target: CharTarget = { sectionIndex: 0, path: q.path, start, end };
      const r = applyChar(doc, target, { superscript: true, shadeColor: "#ffff00" });
      checkRange(`D6 [${start},${end})`, doc, r, target, (b) => {
        b.attrs["shadeColor"] = "#FFFF00";
        b.children.push(flagChild("supscript"));
      });
      n++;
    }
  }
  assert.ok(n > 40, `조합 ${n}개`);
});

// ── 합성 문단: 길고 복잡한 문단의 모든 구간 ───────────────────────────────

const COMPLEX_PARAGRAPH =
  `<hp:p id="1" paraPrIDRef="0" styleIDRef="0">` +
  `<hp:run charPrIDRef="0"><hp:t>가나다&amp;라마바<hp:tab width="0" leader="0" type="0"/>사아자</hp:t></hp:run>` +
  `<hp:run charPrIDRef="1"><hp:t>ABC</hp:t><hp:t>DEF&#x1F600;GH</hp:t></hp:run>` +
  `<hp:run charPrIDRef="0"><hp:t><![CDATA[12<34>56]]></hp:t></hp:run>` +
  `<hp:run charPrIDRef="1"><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl><hp:t>차카</hp:t></hp:run>` +
  `<hp:run charPrIDRef="0"/>` +
  `<hp:run charPrIDRef="0"><hp:t>타파<hp:lineBreak/>하</hp:t><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>` +
  `<hp:run charPrIDRef="1"><hp:t>끝<![CDATA[x]]>y&lt;z</hp:t></hp:run>` +
  `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>` +
  `</hp:p>` +
  `<hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>다른 문단</hp:t></hp:run></hp:p>`;

test("R4 길고 복잡한 문단(엔티티·CDATA·탭·줄바꿈·컨트롤·빈 run·여러 hp:t)의 모든 구간 [시작, 끝)에서 성립한다", () => {
  const doc = parseSynthetic([COMPLEX_PARAGRAPH], MINIMAL_HEADER);
  const p = paragraphAt(doc, [0]);
  const len = p.logicalText.length;
  assert.ok(len > 30, `글 길이 ${len}`);
  assert.ok(p.runs.length >= 7);
  const kinds = new Set(p.pieces.map((x) => x.kind));
  assert.deepEqual([...kinds].sort(), ["entity", "inline", "object", "text"]);
  // 이모지 참조(서로게이트 쌍)의 가운데
  const emoji = p.logicalText.indexOf("\u{1F600}");
  assert.ok(emoji > 0);
  let ok = 0;
  let rejected = 0;
  for (let start = 0; start < len; start++) {
    for (let end = start + 1; end <= len; end++) {
      const target: CharTarget = { sectionIndex: 0, path: [0], start, end };
      const splitsEmoji = [start, end].includes(emoji + 1);
      if (splitsEmoji) {
        throwsCode(() => planApplyCharFormat(doc, target, charDelta(doc, { ratio: 120 })), "FMT_BAD_RANGE", `[${start},${end})`);
        rejected++;
        continue;
      }
      const r = applyChar(doc, target, { ratio: 120 });
      checkRange(`[${start},${end})`, doc, r, target, setRatio("120"));
      ok++;
    }
  }
  assert.ok(ok > 400 && rejected > 10, `성립 ${ok}, 거절 ${rejected}`);
});

test("R4 문단 전체 적용은 run을 쪼개지 않고 모든 run의 id만 바꾼다", () => {
  const doc = parseSynthetic([COMPLEX_PARAGRAPH], MINIMAL_HEADER);
  const p = paragraphAt(doc, [0]);
  const target: CharTarget = { sectionIndex: 0, path: [0], start: 0, end: p.logicalText.length };
  const r = applyChar(doc, target, { spacing: 7 });
  checkRange("문단 전체", doc, r, target, (b) => langElement(b, "spacing", "7"));
  assert.equal(r.plan.summary["addedRuns"], 0);
  assert.equal(paragraphAt(r.after, [0]).runs.length, p.runs.length);
  // 빈 run(글이 없는 run)도 구간 안에 낀 것이라 함께 바뀐다
  const empty = paragraphAt(r.after, [0]).runs.find((x) => x.element.openEnd === x.element.end);
  assert.ok(empty !== undefined);
  assert.notEqual(empty.charPrIDRef, "0");
});

test("R4 글자모양이 바뀌지 않는 run은 건드리지 않는다(이미 같은 모양이면 쪼개지도 않는다)", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const p = paragraphAt(doc, [0]);
  // charPr 7(진하게) run과 그 앞 run에 걸치는 구간에 진하게: 앞 run만 바뀌고 7 run은 그대로
  const boundary = p.pieces.find((x) => x.runOrdinal === 2)?.logicalStart ?? 0;
  const target: CharTarget = { sectionIndex: 0, path: [0], start: boundary - 3, end: boundary + 3 };
  const r = applyChar(doc, target, { bold: true });
  assert.equal(r.plan.summary["changedRuns"], 1);
  assert.equal(r.plan.summary["addedRuns"], 1, "앞 run은 한쪽(시작)만 쪼갠다");
  assert.deepEqual(r.plan.edits.filter((e) => e.entry.endsWith("header.xml")), [], "진하게는 이미 있는 charPr 7을 재사용");
  const now = charIds(r.after, [0]);
  assert.deepEqual([...new Set(now.slice(boundary - 3, boundary + 3))], ["7"]);

  // 모든 run이 이미 같은 모양이면 계획이 비어 있다
  const bold = paragraphAt(doc, [0]).pieces.find((x) => x.runOrdinal === 2);
  assert.ok(bold !== undefined);
  const same = planApplyCharFormat(doc, { sectionIndex: 0, path: [0], start: bold.logicalStart, end: bold.logicalEnd }, charDelta(doc, { bold: true }));
  assert.deepEqual(same.edits, []);
  assert.equal(same.summary["changedRuns"], 0);
});

test("R4 구간 적용의 거절: 길이 0, 범위 밖, 정수 아님, 엔티티·서로게이트 가운데, 없는 문단", () => {
  const doc = parseSynthetic([COMPLEX_PARAGRAPH], MINIMAL_HEADER);
  const len = paragraphAt(doc, [0]).logicalText.length;
  const delta = charDelta(doc, { bold: true });
  const at = (start: number, end: number, path = [0]): CharTarget => ({ sectionIndex: 0, path, start, end });
  throwsCode(() => planApplyCharFormat(doc, at(5, 5), delta), "FMT_BAD_RANGE", "길이 0");
  throwsCode(() => planApplyCharFormat(doc, at(6, 5), delta), "FMT_BAD_RANGE", "거꾸로");
  throwsCode(() => planApplyCharFormat(doc, at(-1, 3), delta), "FMT_BAD_RANGE", "음수");
  throwsCode(() => planApplyCharFormat(doc, at(0, len + 1), delta), "FMT_BAD_RANGE", "범위 밖");
  throwsCode(() => planApplyCharFormat(doc, at(0.5, 3), delta), "FMT_BAD_RANGE", "정수 아님");
  const emoji = paragraphAt(doc, [0]).logicalText.indexOf("\u{1F600}");
  throwsCode(() => planApplyCharFormat(doc, at(emoji + 1, emoji + 4), delta), "FMT_BAD_RANGE", "엔티티 가운데에서 시작");
  throwsCode(() => planApplyCharFormat(doc, at(emoji - 2, emoji + 1), delta), "FMT_BAD_RANGE", "엔티티 가운데에서 끝");
  throwsCode(() => planApplyCharFormat(doc, at(0, 3, [9]), delta), "FMT_TARGET", "없는 문단");
  throwsCode(() => planApplyCharFormat(doc, at(0, 3, [0, 0]), delta), "FMT_TARGET", "짝수 길이 주소");
  throwsCode(() => planApplyCharFormat(doc, { sectionIndex: 3, path: [0], start: 0, end: 2 }, delta), "FMT_TARGET", "없는 구역");
  // 엔티티 전체를 감싸는 구간은 된다
  const ok = applyChar(doc, at(emoji - 1, emoji + 3), { ratio: 130 });
  assert.equal(paragraphAt(ok.after, [0]).logicalText, paragraphAt(doc, [0]).logicalText);
});

test("R4 글 안의 서로게이트 쌍(참조가 아닌 글자 그대로)도 가르지 않는다", () => {
  const doc = parseSynthetic([`<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>가\u{1F600}나다</hp:t></hp:run></hp:p>`], MINIMAL_HEADER);
  const delta = charDelta(doc, { bold: true });
  const at = (start: number, end: number): CharTarget => ({ sectionIndex: 0, path: [0], start, end });
  throwsCode(() => planApplyCharFormat(doc, at(2, 4), delta), "FMT_BAD_RANGE", "쌍 가운데에서 시작");
  throwsCode(() => planApplyCharFormat(doc, at(0, 2), delta), "FMT_BAD_RANGE", "쌍 가운데에서 끝");
  const r = applyChar(doc, at(1, 3), { bold: true });
  checkRange("쌍 전체", doc, r, at(1, 3), (b) => void b.children.push(flagChild("bold")));
});

test("R4 구역 설정(secPr)·컨트롤이 든 첫 문단(D1, ph-mixed, ph-single): 구간이 개체를 포함해도 되고 구역 설정은 그대로다", () => {
  for (const name of ["D1", "hancom/ph-mixed", "hancom/ph-single"]) {
    const doc = loadDoc(name);
    const len = paragraphAt(doc, [0]).logicalText.length;
    const ranges: [number, number][] = [[0, len], [0, 1], [0, 3], [1, 4], [2, 6], [3, len - 2], [len - 4, len]];
    for (const [start, end] of ranges) {
      const target: CharTarget = { sectionIndex: 0, path: [0], start, end };
      const r = applyChar(doc, target, { italic: true, spacing: -5 });
      checkRange(`${name} [${start},${end})`, doc, r, target, (b) => {
        // 기울임은 bold·underline·strikeout 앞에 둔다(없으면 맨 끝)
        const at = b.children.findIndex((c) => ["bold", "underline", "strikeout", "outline", "shadow"].includes(local(c.name)));
        if (!b.children.some((c) => local(c.name) === "italic")) b.children.splice(at < 0 ? b.children.length : at, 0, flagChild("italic"));
        langElement(b, "spacing", "-5");
        if (name === "D1") b.attrs["italic"] = "1";
      });
      assert.equal((r.after.sections[0]?.text.match(/<hp:secPr /g) ?? []).length, (doc.sections[0]?.text.match(/<hp:secPr /g) ?? []).length, "구역 설정은 그대로");
    }
  }
});

test("R4 기준 글자모양이 없는 run은 FMT_BASE_NOT_FOUND, charPrIDRef가 없는 run은 FMT_NO_BASE", () => {
  const dangling = parseSynthetic([`<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="77"><hp:t>abcdef</hp:t></hp:run></hp:p>`], MINIMAL_HEADER);
  throwsCode(() => planApplyCharFormat(dangling, { sectionIndex: 0, path: [0], start: 1, end: 3 }, charDelta(dangling, { bold: true })), "FMT_BASE_NOT_FOUND");
  const none = parseSynthetic([`<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run><hp:t>abcdef</hp:t></hp:run></hp:p>`], MINIMAL_HEADER);
  throwsCode(() => planApplyCharFormat(none, { sectionIndex: 0, path: [0], start: 1, end: 3 }, charDelta(none, { bold: true })), "FMT_NO_BASE");
});

// ── R6: 겹쳐 적용 ─────────────────────────────────────────────────────

test("R6 같은 구간에 세 가지를 차례로(적용 → 다시 파싱 → 적용) 겹쳐도 R1·R4가 성립한다", () => {
  let doc = loadDoc("hancom/ph-mixed");
  const original = doc;
  const target: CharTarget = { sectionIndex: 0, path: [1], start: 5, end: 12 };
  const steps: { spec: CharFormat; expect: (b: XmlJson) => void }[] = [
    { spec: { bold: true }, expect: (b) => void b.children.splice(5, 0, flagChild("bold")) },
    {
      spec: { ratio: 120, textColor: "#ff0000" },
      expect: (b) => {
        setAll(kid(b, "ratio"), "120");
        b.attrs["textColor"] = "#FF0000";
      },
    },
    { spec: { underline: { shape: "WAVE", color: "#0000ff" } }, expect: (b) => void Object.assign(kid(b, "underline").attrs, { type: "BOTTOM", shape: "WAVE", color: "#0000FF" }) },
  ];
  const applied: ((b: XmlJson) => void)[] = [];
  let runs = paragraphAt(doc, [1]).runs.length;
  for (const [i, step] of steps.entries()) {
    const r = applyChar(doc, target, step.spec);
    applied.push(step.expect);
    // 이 단계의 결과 = 직전 문서의 기준 + 이 단계의 변화
    checkRange(`R6 ${i + 1}단계`, doc, r, target, step.expect);
    // 처음 문서의 기준 + 지금까지 모든 변화(독립 기준)
    const was = charIds(original, [1]);
    const now = charIds(r.after, [1]);
    for (let k = target.start; k < target.end; k++) {
      const expected = withoutId(resourceJson(original, "charPr", was[k] ?? ""));
      for (const f of applied) f(expected);
      assert.deepEqual(withoutId(resourceJson(r.after, "charPr", now[k] ?? "")), expected, `R6 ${i + 1}단계 ${k}번 글자: 처음 기준 + 누적 변화`);
    }
    const after = paragraphAt(r.after, [1]).runs.length;
    assert.ok(after >= runs, "run 수는 줄지 않는다");
    if (i > 0) assert.equal(after, runs, "같은 구간이라 두 번째부터는 더 쪼개지지 않는다");
    runs = after;
    doc = r.after;
  }
  assert.equal(paragraphAt(doc, [1]).runs.length, 3);
});

test("R6 겹치는 두 구간을 차례로 적용하면 겹친 부분에 둘 다 있다", () => {
  const doc0 = loadDoc("hancom/ph-single");
  const p0 = paragraphAt(doc0, [0]);
  const first = p0.pieces.find((x) => x.runOrdinal === 1)?.logicalStart ?? 0;
  const a: CharTarget = { sectionIndex: 0, path: [0], start: first + 2, end: first + 11 };
  const b: CharTarget = { sectionIndex: 0, path: [0], start: first + 6, end: first + 15 };
  const r1 = applyChar(doc0, a, { bold: true });
  checkRange("첫 구간", doc0, r1, a, (x) => x.children.splice(5, 0, flagChild("bold")));
  const r2 = applyChar(r1.after, b, { italic: true });
  checkRange("둘째 구간", r1.after, r2, b, (x) => x.children.splice(5, 0, flagChild("italic")));

  const ids = charIds(r2.after, [0]);
  const names = (i: number): string => resourceJson(r2.after, "charPr", ids[i] ?? "").children.map((c) => local(c.name)).filter((n) => n === "bold" || n === "italic").join("+");
  const text = paragraphAt(r2.after, [0]).logicalText;
  for (let i = 0; i < text.length; i++) {
    const inA = i >= a.start && i < a.end;
    const inB = i >= b.start && i < b.end;
    const want = [inB ? "italic" : "", inA ? "bold" : ""].filter(Boolean).join("+");
    assert.equal(names(i), want, `${i}번 글자의 굵기·기울임`);
  }
  // 쪼개진 run 수: 원래 2개 + 구간 경계 4곳(2, 6, 11, 15)
  assert.equal(paragraphAt(r2.after, [0]).runs.length, p0.runs.length + 4);
});

// ── R5: 드문 서식 20종 이상 ───────────────────────────────────────────

type RareChar = { name: string; spec: CharFormat; check: (j: XmlJson, after: HwpxDocument) => void };

const hasChild = (j: XmlJson, name: string): boolean => j.children.some((c) => local(c.name) === name);

const RARE_CHAR: RareChar[] = [
  { name: "장평 50", spec: { ratio: 50 }, check: (j) => assert.deepEqual(Object.values(kid(j, "ratio").attrs), Array(7).fill("50")) },
  { name: "장평 200", spec: { ratio: 200 }, check: (j) => assert.deepEqual(Object.values(kid(j, "ratio").attrs), Array(7).fill("200")) },
  { name: "자간 -50", spec: { spacing: -50 }, check: (j) => assert.deepEqual(Object.values(kid(j, "spacing").attrs), Array(7).fill("-50")) },
  { name: "자간 50", spec: { spacing: 50 }, check: (j) => assert.deepEqual(Object.values(kid(j, "spacing").attrs), Array(7).fill("50")) },
  { name: "상대 크기 10", spec: { relSize: 10 }, check: (j) => assert.equal(kid(j, "relSz").attrs["hangul"], "10") },
  { name: "상대 크기 250", spec: { relSize: 250 }, check: (j) => assert.equal(kid(j, "relSz").attrs["user"], "250") },
  { name: "글자 위치 -100", spec: { offset: -100 }, check: (j) => assert.equal(kid(j, "offset").attrs["latin"], "-100") },
  { name: "글자 위치 100(한글만)", spec: { offset: { hangul: 100 } }, check: (j) => assert.equal(kid(j, "offset").attrs["hangul"], "100") },
  { name: "강조점 DOT_ABOVE", spec: { emphasis: "DOT_ABOVE" }, check: (j) => assert.equal(j.attrs["symMark"], "DOT_ABOVE") },
  { name: "강조점 DOT_BELOW", spec: { emphasis: "DOT_BELOW" }, check: (j) => assert.equal(j.attrs["symMark"], "DOT_BELOW") },
  { name: "외곽선", spec: { outline: true }, check: (j) => assert.equal(kid(j, "outline").attrs["type"], "SOLID") },
  { name: "외곽선 점선", spec: { outline: { type: "DASH_DOT" } }, check: (j) => assert.equal(kid(j, "outline").attrs["type"], "DASH_DOT") },
  { name: "그림자 DROP", spec: { shadow: { type: "DROP" } }, check: (j) => assert.equal(kid(j, "shadow").attrs["type"], "DROP") },
  { name: "그림자 CONTINUOUS 색·간격", spec: { shadow: { type: "CONTINUOUS", color: "#ff0000", offsetX: -5, offsetY: 20 } }, check: (j) => assert.deepEqual(kid(j, "shadow").attrs, { type: "CONTINUOUS", color: "#FF0000", offsetX: "-5", offsetY: "20" }) },
  { name: "양각", spec: { emboss: true }, check: (j) => assert.ok(hasChild(j, "emboss") && !hasChild(j, "engrave")) },
  { name: "음각", spec: { engrave: true }, check: (j) => assert.ok(hasChild(j, "engrave") && !hasChild(j, "emboss")) },
  { name: "위첨자", spec: { superscript: true }, check: (j) => assert.ok(hasChild(j, "supscript") && !hasChild(j, "subscript")) },
  { name: "아래첨자", spec: { subscript: true }, check: (j) => assert.ok(hasChild(j, "subscript") && !hasChild(j, "supscript")) },
  { name: "취소선 DASH", spec: { strikeout: { shape: "DASH", color: "#336699" } }, check: (j) => assert.deepEqual(kid(j, "strikeout").attrs, { shape: "DASH", color: "#336699" }) },
  { name: "취소선 이중", spec: { strikeout: { shape: "DOUBLE_SLIM" } }, check: (j) => assert.equal(kid(j, "strikeout").attrs["shape"], "DOUBLE_SLIM") },
  { name: "밑줄 WAVE", spec: { underline: { shape: "WAVE" } }, check: (j) => assert.deepEqual(kid(j, "underline").attrs, { type: "BOTTOM", shape: "WAVE", color: "#000000" }) },
  { name: "밑줄 위(TOP)·3D", spec: { underline: { type: "TOP", shape: "THICK3D", color: "#00aa00" } }, check: (j) => assert.deepEqual(kid(j, "underline").attrs, { type: "TOP", shape: "THICK3D", color: "#00AA00" }) },
  { name: "음영색", spec: { shadeColor: "#FFFF00" }, check: (j) => assert.equal(j.attrs["shadeColor"], "#FFFF00") },
  { name: "글자 크기 7.5pt", spec: { size: 7.5 }, check: (j) => assert.equal(j.attrs["height"], "750") },
  { name: "글자색", spec: { textColor: "#2e74b5" }, check: (j) => assert.equal(j.attrs["textColor"], "#2E74B5") },
  { name: "커닝", spec: { kerning: true }, check: (j) => assert.equal(j.attrs["useKerning"], "1") },
  {
    name: "글꼴 이름",
    spec: { font: "함초롬돋움" },
    check: (j, d) => {
      for (const lang of LANGS) {
        const want = (d.header.resources["font"] ?? []).find((f) => f.lang === lang.toUpperCase() && f.element.attrs.some((a) => a.qname === "face" && a.value === "함초롬돋움"))?.id;
        assert.ok(want !== undefined);
        assert.equal(kid(j, "fontRef").attrs[lang], want, `${lang} 글꼴 id`);
      }
    },
  },
];

type RarePara = { name: string; spec: ParaFormat; hancomOnly?: boolean; check: (j: XmlJson, hancom: boolean) => void };
const values = (j: XmlJson, name: string): string[] => descendants(j, name).map((x) => x.attrs["value"] ?? "");

const RARE_PARA: RarePara[] = [
  { name: "배분 정렬", spec: { align: "DISTRIBUTE" }, check: (j) => assert.equal(kid(j, "align").attrs["horizontal"], "DISTRIBUTE") },
  { name: "나눔 정렬", spec: { align: "DISTRIBUTE_SPACE" }, check: (j) => assert.equal(kid(j, "align").attrs["horizontal"], "DISTRIBUTE_SPACE") },
  { name: "가운데 정렬", spec: { align: "CENTER" }, check: (j) => assert.equal(kid(j, "align").attrs["horizontal"], "CENTER") },
  { name: "줄 간격 비율 250%", spec: { lineSpacing: { type: "PERCENT", value: 250 } }, check: (j) => assert.deepEqual(descendants(j, "lineSpacing").map((x) => [x.attrs["type"], x.attrs["value"]]), descendants(j, "lineSpacing").map(() => ["PERCENT", "250"])) },
  { name: "줄 간격 고정값", spec: { lineSpacing: { type: "FIXED", value: 1400 } }, check: (j, h) => assert.deepEqual(values(j, "lineSpacing"), h ? ["1400", "2800"] : ["1400"]) },
  { name: "줄 간격 여백만 지정", spec: { lineSpacing: { type: "BETWEEN_LINES", value: 300 } }, check: (j, h) => assert.deepEqual(values(j, "lineSpacing"), h ? ["300", "600"] : ["300"]) },
  { name: "줄 간격 최소", spec: { lineSpacing: { type: "AT_LEAST", value: 1200 } }, check: (j, h) => assert.deepEqual(values(j, "lineSpacing"), h ? ["1200", "2400"] : ["1200"]) },
  { name: "내어쓰기", spec: { indent: -1500, marginLeft: 1500 }, check: (j, h) => {
      assert.deepEqual(values(j, "intent"), h ? ["-1500", "-3000"] : ["-1500"]);
      assert.deepEqual(values(j, "left"), h ? ["1500", "3000"] : ["1500"]);
    } },
  { name: "들여쓰기", spec: { indent: 1000 }, check: (j, h) => assert.deepEqual(values(j, "intent"), h ? ["1000", "2000"] : ["1000"]) },
  { name: "오른쪽 여백·문단 간격", spec: { marginRight: 700, spaceBefore: 400, spaceAfter: 900 }, check: (j, h) => {
      assert.deepEqual(values(j, "right"), h ? ["700", "1400"] : ["700"]);
      assert.deepEqual(values(j, "prev"), h ? ["400", "800"] : ["400"]);
      assert.deepEqual(values(j, "next"), h ? ["900", "1800"] : ["900"]);
    } },
  { name: "줄 나눔 기준", spec: { breakLatinWord: "HYPHENATION", breakNonLatinWord: "BREAK_WORD" }, check: (j) => assert.deepEqual([kid(j, "breakSetting").attrs["breakLatinWord"], kid(j, "breakSetting").attrs["breakNonLatinWord"]], ["HYPHENATION", "BREAK_WORD"]) },
  { name: "탭 정의 참조(합성 문서는 탭 목록이 비어 있다)", spec: { tabPrIDRef: "1" }, hancomOnly: true, check: (j) => assert.equal(j.attrs["tabPrIDRef"], "1") },
];

const RARE_DOCS: { name: string; charPath: number[]; start: number; end: number; hancom: boolean }[] = [
  { name: "D1", charPath: [1], start: 4, end: 30, hancom: false },
  { name: "hancom/ph-mixed", charPath: [1], start: 3, end: 15, hancom: true },
];

test("R5 드문 글자 서식 20종 이상을 각각 적용해도 검사기 새 오류가 0이고 요청한 값이 들어 있다", () => {
  assert.ok(RARE_CHAR.length >= 20);
  for (const d of RARE_DOCS) {
    const doc = loadDoc(d.name);
    for (const c of RARE_CHAR) {
      const target: CharTarget = { sectionIndex: 0, path: d.charPath, start: d.start, end: d.end };
      const r = applyChar(doc, target, c.spec);
      const ids = new Set(charIds(r.after, d.charPath).slice(d.start, d.end));
      assert.equal(ids.size, 1, `${d.name} ${c.name}: 한 run이라 구간 안 글자모양이 하나`);
      const id = [...ids][0] ?? "";
      assert.notEqual(id, charIds(doc, d.charPath)[d.start], `${d.name} ${c.name}: 글자모양이 바뀐다`);
      c.check(resourceJson(r.after, "charPr", id), r.after);
      assert.equal(newErrorsAfter(doc, r.bytes), 0, `${d.name} ${c.name}: 새 오류 0`);
      assert.equal(paragraphAt(r.after, d.charPath).logicalText, paragraphAt(doc, d.charPath).logicalText);
    }
  }
});

test("R5 드문 문단 서식(줄 간격 3종·내어쓰기·배분 정렬 등)을 각각 적용해도 검사기 새 오류가 0이고 요청한 값이 들어 있다", () => {
  assert.ok(RARE_PARA.length >= 12);
  for (const d of RARE_DOCS) {
    const doc = loadDoc(d.name);
    for (const c of RARE_PARA) {
      if (c.hancomOnly === true && !d.hancom) continue;
      const target = { sectionIndex: 0, path: d.charPath };
      const plan = planApplyParaFormat(doc, [target], paraDelta(doc, c.spec));
      const bytes = applyPlan(doc.pkg, plan);
      const after = reparse(bytes);
      const id = paragraphAt(after, d.charPath).attrs.paraPrIDRef ?? "";
      assert.notEqual(id, paragraphAt(doc, d.charPath).attrs.paraPrIDRef, `${d.name} ${c.name}: 문단모양이 바뀐다`);
      c.check(resourceJson(after, "paraPr", id), d.hancom);
      assert.equal(newErrorsAfter(doc, bytes), 0, `${d.name} ${c.name}: 새 오류 0`);
    }
  }
});

test("R5 문단 테두리: 테두리 자원을 파생해 적용한 뒤(적용 → 다시 파싱) 문단이 그것을 가리킨다", () => {
  for (const name of ["D1", "hancom/ph-mixed"]) {
    const doc = loadDoc(name);
    const baseBorder = paragraphAt(doc, [1]).attrs.paraPrIDRef === null ? "" : (resourceJson(doc, "paraPr", paragraphAt(doc, [1]).attrs.paraPrIDRef ?? "").children.find((c) => local(c.name) === "border")?.attrs["borderFillIDRef"] ?? "");
    const border = deriveResource(doc, "borderFill", baseBorder, [
      ...(["leftBorder", "rightBorder", "topBorder", "bottomBorder"] as const).flatMap((side) => [
        { op: "setAttr" as const, path: [side], name: "type", value: "SOLID" },
        { op: "setAttr" as const, path: [side], name: "width", value: "0.4 mm" },
        { op: "setAttr" as const, path: [side], name: "color", value: "#336699" },
      ]),
    ]);
    assert.equal(border.reused, false);
    const doc2 = reparse(applyPlan(doc.pkg, border.plan));
    const plan = planApplyParaFormat(doc2, [{ sectionIndex: 0, path: [1] }], paraDelta(doc2, { borderFillIDRef: border.id }));
    const bytes = applyPlan(doc2.pkg, plan);
    const after = reparse(bytes);
    const paraId = paragraphAt(after, [1]).attrs.paraPrIDRef ?? "";
    const j = resourceJson(after, "paraPr", paraId);
    assert.equal(kid(j, "border").attrs["borderFillIDRef"], border.id);
    const fill = resourceJson(after, "borderFill", border.id);
    assert.equal(kid(fill, "leftBorder").attrs["type"], "SOLID");
    assert.equal(newErrorsAfter(doc, bytes), 0, `${name}: 새 오류 0`);
    // 요청하지 않은 문단모양 속성은 기준과 같다
    const expected = withoutId(resourceJson(doc2, "paraPr", paragraphAt(doc2, [1]).attrs.paraPrIDRef ?? ""));
    kid(expected, "border").attrs["borderFillIDRef"] = border.id;
    assert.deepEqual(withoutId(j), expected);
  }
});

// ── 문단 서식 적용 ────────────────────────────────────────────────────

test("문단 서식: 지정한 문단만 바뀌고(여러 개·표 셀 안 포함) 글과 다른 문단은 그대로이며 줄 배치 캐시가 지워진다", () => {
  const doc = loadDoc("hancom-merged");
  const cell = allParagraphs(doc).find((q) => q.path.length === 3 && q.logicalText.length > 3);
  assert.ok(cell !== undefined);
  const targets = [
    { sectionIndex: 0, path: [1] },
    { sectionIndex: 0, path: [2] },
    { sectionIndex: 0, path: cell.path },
    { sectionIndex: 0, path: [1] }, // 중복은 한 번만
  ];
  const plan = planApplyParaFormat(doc, targets, paraDelta(doc, { align: "RIGHT", marginLeft: 2000, lineSpacing: { type: "PERCENT", value: 200 } }));
  assert.equal(plan.summary["changedParagraphs"], 3);
  const bytes = applyPlan(doc.pkg, plan);
  const after = reparse(bytes);
  const changed = new Set(["1", "2", cell.path.join(".")]);
  const newAll = allParagraphs(after);
  allParagraphs(doc).forEach((p, i) => {
    const q = newAll[i];
    assert.ok(q !== undefined);
    assert.equal(q.logicalText, p.logicalText);
    assert.deepEqual(q.runs.map((r) => r.charPrIDRef), p.runs.map((r) => r.charPrIDRef));
    if (!changed.has(p.path.join("."))) {
      assert.equal(q.attrs.paraPrIDRef, p.attrs.paraPrIDRef, `문단 ${p.path.join(".")}은 그대로`);
      return;
    }
    const base = withoutId(resourceJson(doc, "paraPr", p.attrs.paraPrIDRef ?? ""));
    const now = withoutId(resourceJson(after, "paraPr", q.attrs.paraPrIDRef ?? ""));
    kid(base, "align").attrs["horizontal"] = "RIGHT";
    const branches = [...descendants(base, "case"), ...descendants(base, "default")];
    if (branches.length === 0) {
      kid(kid(base, "margin"), "left").attrs["value"] = "2000";
      Object.assign(kid(base, "lineSpacing").attrs, { type: "PERCENT", value: "200" });
    }
    branches.forEach((b, k) => {
      if (b.children.some((c) => local(c.name) === "margin")) kid(kid(b, "margin"), "left").attrs["value"] = String(2000 * (k + 1));
      if (b.children.some((c) => local(c.name) === "lineSpacing")) Object.assign(kid(b, "lineSpacing").attrs, { type: "PERCENT", value: "200" });
    });
    assert.deepEqual(now, base, `문단 ${p.path.join(".")}: 기준 + 변화`);
  });
  sameText(stripPara(after.sections[0]?.text ?? ""), stripPara(doc.sections[0]?.text ?? ""), "문단 서식: 문단모양 id와 캐시 외의 원문이 그대로");
  assert.equal(lineSegCount(after), 0);
  assert.equal(newErrorsAfter(doc, bytes), 0);
});

test("문단 서식: 같은 모양이 이미 있으면 재사용하고(추가 자원 0), 이미 같은 문단은 건드리지 않는다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const plan = planApplyParaFormat(doc, [{ sectionIndex: 0, path: [0] }], paraDelta(doc, { marginLeft: 1500 }));
  assert.equal(plan.summary["addedResources"], 0, "paraPr 1이 이미 그 모양이다");
  const after = reparse(applyPlan(doc.pkg, plan));
  assert.equal(paragraphAt(after, [0]).attrs.paraPrIDRef, "1");
  const same = planApplyParaFormat(doc, [{ sectionIndex: 0, path: [0] }], paraDelta(doc, { align: "JUSTIFY" }));
  assert.deepEqual(same.edits, []);
});

test("문단 서식의 거절: 대상 없음, 없는 문단, 기준 문단모양 없음", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const delta = paraDelta(doc, { align: "LEFT" });
  throwsCode(() => planApplyParaFormat(doc, [], delta), "FMT_TARGET", "빈 목록");
  throwsCode(() => planApplyParaFormat(doc, [{ sectionIndex: 0, path: [9] }], delta), "FMT_TARGET", "없는 문단");
  throwsCode(() => planApplyParaFormat(doc, [{ sectionIndex: 4, path: [0] }], delta), "FMT_TARGET", "없는 구역");
  const noRef = parseSynthetic([`<hp:p id="1" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>abc</hp:t></hp:run></hp:p>`], MINIMAL_HEADER);
  throwsCode(() => planApplyParaFormat(noRef, [{ sectionIndex: 0, path: [0] }], delta), "FMT_NO_BASE");
});

test("글자 서식과 문단 서식을 한 문서에 이어 적용한다(각 단계 사이에 다시 파싱)", () => {
  let doc = loadDoc("D1");
  const before = doc;
  const c = applyChar(doc, { sectionIndex: 0, path: [1], start: 10, end: 40 }, { ratio: 90, underline: { shape: "DASH" } });
  doc = c.after;
  const plan = planApplyParaFormat(doc, [{ sectionIndex: 0, path: [1] }], paraDelta(doc, { align: "CENTER", indent: 800 }));
  const bytes = applyPlan(doc.pkg, plan);
  const after = reparse(bytes);
  assert.equal(newErrorsAfter(before, bytes), 0);
  assert.equal(paragraphAt(after, [1]).logicalText, paragraphAt(before, [1]).logicalText);
  const ids = charIds(after, [1]);
  assert.equal(new Set(ids.slice(10, 40)).size, 1);
  assert.equal(resourceJson(after, "charPr", ids[10] ?? "").children.find((x) => local(x.name) === "underline")?.attrs["shape"], "DASH");
  const para = resourceJson(after, "paraPr", paragraphAt(after, [1]).attrs.paraPrIDRef ?? "");
  assert.equal(kid(para, "align").attrs["horizontal"], "CENTER");
});

test("서식 변경은 문서 모델과 입력 바이트를 바꾸지 않는다", () => {
  const doc = loadDoc("hancom/ph-mixed");
  const bytes = Buffer.from(doc.pkg.bytes).toString("base64");
  const text = doc.sections[0]?.text;
  planApplyCharFormat(doc, { sectionIndex: 0, path: [1], start: 2, end: 9 }, charDelta(doc, { ratio: 150 }));
  planApplyParaFormat(doc, [{ sectionIndex: 0, path: [1] }], paraDelta(doc, { align: "LEFT" }));
  assert.equal(Buffer.from(doc.pkg.bytes).toString("base64"), bytes);
  assert.equal(doc.sections[0]?.text, text);
});

// ── 시험 문서 전체에서 무작위(시드 고정) 구간·서식 ──────────────────────────

const ALL_FIXTURES = [
  "D1", "D2", "D3", "D4", "D5", "D6", "D7", "hancom-merged", "hancom-field",
  "hancom/blocks", "hancom/field-states", "hancom/header-footer", "hancom/ph-mixed", "hancom/ph-single", "hancom/ph-table", "hancom/picture",
  "extra/features-picture", "extra/features-rhwp",
];

test("시험 문서 18개 전부: 문단·구간·서식을 시드 고정으로 뽑아 적용해도 글이 그대로이고 새 오류가 없다(글자·문단 서식)", () => {
  let seed = 20261001;
  const rand = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  let charRuns = 0;
  let paraRuns = 0;
  for (const name of ALL_FIXTURES) {
    const doc = loadDoc(name);
    const paragraphs = allParagraphs(doc).filter((p) => p.logicalText.replace(/\uFFFC/g, "").length >= 2);
    assert.ok(paragraphs.length > 0, name);
    for (let k = 0; k < 12; k++) {
      const p = paragraphs[rand(paragraphs.length)];
      assert.ok(p !== undefined);
      const len = p.logicalText.length;
      // 서로게이트·엔티티 가운데는 거절되므로 그 경우는 거절을 확인한다
      const start = rand(len);
      const end = start + 1 + rand(len - start);
      const target: CharTarget = { sectionIndex: 0, path: p.path, start, end };
      const c = RARE_CHAR[rand(RARE_CHAR.length)];
      assert.ok(c !== undefined);
      const delta = charDelta(doc, c.spec);
      let plan: EditPlan;
      try {
        plan = planApplyCharFormat(doc, target, delta);
      } catch (e) {
        assert.ok(e instanceof HwpxError && ["FMT_BAD_RANGE", "FMT_BASE_NOT_FOUND"].includes(e.code), `${name} ${p.path.join(".")} [${start},${end}): ${String(e)}`);
        continue;
      }
      const bytes = applyPlan(doc.pkg, plan);
      const after = reparse(bytes);
      assert.equal(paragraphAt(after, p.path).logicalText, p.logicalText, `${name} ${c.name}: 글이 그대로`);
      assert.equal(newErrorsAfter(doc, bytes), 0, `${name} ${p.path.join(".")} [${start},${end}) ${c.name}: 새 오류 0`);
      const was = charIds(doc, p.path);
      const now = charIds(after, p.path);
      for (let i = 0; i < len; i++) if (i < start || i >= end) assert.equal(now[i], was[i], `${name}: 구간 밖 ${i}`);
      charRuns++;
    }
    for (let k = 0; k < 6; k++) {
      const p = paragraphs[rand(paragraphs.length)];
      assert.ok(p !== undefined);
      const c = RARE_PARA[rand(RARE_PARA.length)];
      assert.ok(c !== undefined);
      if (c.hancomOnly === true && (doc.header.resources["tabPr"] ?? []).length < 2) continue;
      const plan = planApplyParaFormat(doc, [{ sectionIndex: 0, path: p.path }], paraDelta(doc, c.spec));
      const bytes = applyPlan(doc.pkg, plan);
      const after = reparse(bytes);
      assert.equal(paragraphAt(after, p.path).logicalText, p.logicalText);
      assert.equal(newErrorsAfter(doc, bytes), 0, `${name} ${p.path.join(".")} ${c.name}: 새 오류 0`);
      paraRuns++;
    }
  }
  assert.ok(charRuns > 150 && paraRuns > 60, `글자 ${charRuns}건, 문단 ${paraRuns}건`);
});
