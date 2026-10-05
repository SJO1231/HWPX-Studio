// 조각 단위 변환 시험(7.66)의 기준: 한컴이 읽는 값 모형. 엔진의 변환 코드와 독립이다.
// 근거는 한컴 실측(검증 기준 26·27절): HwpUnitChar 스위치는 형식과 관계없이 case를 읽고, 여백·비율 아닌 줄 간격·탭 위치는
// xmlVersion 1.5 이상이면 XML 값의 2배(옛 단위), 미만이면 XML 값 그대로 받는다. 글자 단위(CHAR)·비율 줄 간격은 그대로다.
import assert from "node:assert/strict";
import { walkElements, walkParagraphs, type HwpxDocument, type ParagraphNode, type XElement } from "../src/index.ts";

export const UNITCHAR = "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar";

export const isUnitSwitch = (el: XElement): boolean =>
  el.local === "switch" && el.children.some((c) => "local" in c && c.local === "case" && c.attrs.some((a) => a.qname.endsWith("required-namespace") && a.value === UNITCHAR));

type Slot = [name: string, kind: string, value: number];

function slotOf(x: XElement): Slot | undefined {
  const attr = (name: string): string | undefined => x.attrs.find((a) => a.qname === name)?.value;
  const kind = attr("unit") === "CHAR" ? "CHAR" : "HWP";
  if (x.parent?.local === "margin") return [x.local, kind, Number(attr("value"))];
  if (x.local === "lineSpacing") return [`ls:${attr("type")}`, attr("type") === "PERCENT" ? "PCT" : kind, Number(attr("value"))];
  if (x.local === "tabItem") return ["tab", kind, Number(attr("pos"))];
  return undefined;
}

/** 자원 요소에서 한컴이 읽는 단위 값 목록. HwpUnitChar 스위치는 case만 본다. */
export function readSlots(el: XElement): Slot[] {
  const out: Slot[] = [];
  const skip = new Set<XElement>();
  for (const x of walkElements(el)) {
    if (x.parent !== null && skip.has(x.parent)) {
      skip.add(x);
      continue;
    }
    if (isUnitSwitch(x)) for (const c of x.children) if ("local" in c && c.local === "default") skip.add(c);
    const slot = slotOf(x);
    if (slot !== undefined) out.push(slot);
  }
  return out;
}

/** HwpUnitChar 스위치 밖(case·default 어디에도 없는) 단위 값 */
export function readSlotsOutside(el: XElement): Slot[] {
  const inside = new Set<XElement>();
  for (const x of walkElements(el)) if ((x.parent !== null && inside.has(x.parent)) || isUnitSwitch(x)) inside.add(x);
  return [...walkElements(el)].filter((x) => !inside.has(x)).flatMap((x) => {
    const slot = slotOf(x);
    return slot === undefined ? [] : [slot];
  });
}

/** 문단의 문단모양(과 그 탭)에서 한컴이 보여 주는 값(옛 단위). `unitChar`는 문서 형식이 1.5 이상인가. `raw`는 XML 값이다. */
export function shownOf(doc: HwpxDocument, p: ParagraphNode, unitChar: boolean): { slots: Slot[]; raw: number[] } {
  const id = p.element.attrs.find((a) => a.qname === "paraPrIDRef")?.value;
  const pp = (doc.header.resources["paraPr"] ?? []).find((r) => r.id === id);
  assert.ok(pp !== undefined, `paraPr ${id}`);
  const tabId = pp.element.attrs.find((a) => a.qname === "tabPrIDRef")?.value;
  const tab = (doc.header.resources["tabPr"] ?? []).find((r) => r.id === tabId);
  const all = [...readSlots(pp.element), ...(tab === undefined ? [] : readSlots(tab.element))];
  return { slots: all.map(([n, k, v]) => [n, k, k === "HWP" && unitChar ? 2 * v : v]), raw: all.map(([, , v]) => v) };
}

/** 최상위 문단 `from`부터 `n`개와 그 안(표 칸 등)의 문단을 문서 순서로 */
export function top(doc: HwpxDocument, from: number, n: number): ParagraphNode[] {
  const list = doc.sections[0]?.paragraphs.slice(from, from + n) ?? [];
  assert.equal(list.length, n, `최상위 문단 ${from}~${from + n - 1}`);
  return [...walkParagraphs(list)];
}

/**
 * 가져온 문단마다 원본과 결과에서 한컴이 보여 주는 값을 대조한다. 1.2 → 1.5에서 홀수 값은 1 차이를 허용하고(1.5에서 표현할 수 없다),
 * 1.5 → 1.2에서 case의 글자 단위 자리(결과에서 default의 HWPUNIT 값이 된 것)는 값을 보지 않는다.
 * `roundingSlack`을 켜면 1.5 → 1.2에서 1 차이(한컴 저장본의 default가 case의 2배에서 반올림으로 1 어긋난 곳)를 허용하고 그 수를 센다.
 */
export function assertShownSame(
  src: HwpxDocument,
  srcParas: ParagraphNode[],
  srcUnit: boolean,
  out: HwpxDocument,
  outParas: ParagraphNode[],
  outUnit: boolean,
  label: string,
  roundingSlack = false,
): { compared: number; slack: number } {
  assert.equal(outParas.length, srcParas.length, `${label}: 문단 수`);
  let compared = 0;
  let slack = 0;
  srcParas.forEach((sp, i) => {
    const a = shownOf(src, sp, srcUnit);
    const b = shownOf(out, outParas[i] as ParagraphNode, outUnit);
    assert.deepEqual(b.slots.map(([name]) => name), a.slots.map(([name]) => name), `${label}: 문단 ${i} 자리 이름`);
    a.slots.forEach(([name, kind, value], j) => {
      const got = b.slots[j] as Slot;
      if (srcUnit && !outUnit && kind === "CHAR" && got[1] === "HWP") return;
      compared++;
      const odd = Math.abs(a.raw[j] ?? 0) % 2 === 1;
      if (!srcUnit && outUnit && kind === "HWP" && odd) {
        assert.ok(Math.abs(got[2] - value) <= 1 && got[1] === kind, `${label}: 문단 ${i} ${name} ${value} → ${got[2]}(홀수 1 차이 허용)`);
      } else if (roundingSlack && srcUnit && !outUnit && kind === "HWP" && got[1] === kind && Math.abs(got[2] - value) === 1) {
        slack++;
      } else {
        assert.deepEqual(got, [name, kind, value], `${label}: 문단 ${i} ${name}`);
      }
    });
  });
  return { compared, slack };
}
