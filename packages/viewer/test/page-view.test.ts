// 쪽 표시(dom/page-view.ts)를 최소한의 가짜 DOM 위에서 실제 rhwp 문서로 돌려 본다: 쪽 틀·SVG 지연 그리기·배율·강조 표시·클릭·끌기.
// 브라우저에서의 실제 모양 확인은 총괄이 하고, 여기서는 코드 경로가 예외 없이 맞는 값을 내는지만 본다.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPageView, type PickEvent, type ViewMark } from "../src/dom/index.ts";
import { charRect, glyphsAt, hasDocCoords, openDocument, runPosition } from "../src/rhwp/index.ts";
import { P, R, RECT, SUBLIST, SUBP, T, ensureRhwp, readFixture, synth } from "./helpers.ts";

type Listener = (event: never) => void;

class FakeElement {
  tag: string;
  className = "";
  alt = "";
  src = "";
  draggable = true;
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners = new Map<string, Listener[]>();
  classes = new Set<string>();
  classList = { add: (c: string): void => void this.classes.add(c) };
  box = { left: 0, top: 0 };

  constructor(tag: string) {
    this.tag = tag;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  append(...items: FakeElement[]): void {
    this.children.push(...items);
  }

  replaceChildren(...items: FakeElement[]): void {
    this.children = items;
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  getBoundingClientRect(): { left: number; top: number } {
    return this.box;
  }

  fire(type: string, event: object): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event as never);
  }
}

const windowListeners = new Map<string, Listener[]>();
const observed: FakeElement[] = [];
let observerCallback: ((entries: { isIntersecting: boolean; target: FakeElement }[]) => void) | undefined;
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};

before(async () => {
  await ensureRhwp();
  for (const k of ["document", "window", "IntersectionObserver"]) saved[k] = g[k];
  g["document"] = { createElement: (tag: string) => new FakeElement(tag) };
  g["window"] = {
    addEventListener: (type: string, fn: Listener) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
    removeEventListener: (type: string, fn: Listener) => windowListeners.set(type, (windowListeners.get(type) ?? []).filter((x) => x !== fn)),
  };
  g["IntersectionObserver"] = class {
    constructor(cb: typeof observerCallback) {
      observerCallback = cb;
    }
    observe(el: FakeElement): void {
      observed.push(el);
    }
    disconnect(): void {}
  };
});

after(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
});

const fireWindow = (type: string, event: object): void => {
  for (const fn of windowListeners.get(type) ?? []) fn(event as never);
};

test("쪽 틀을 쪽 크기 × 배율로 만들고, 첫 쪽과 보이는 쪽만 SVG를 그린다(blob 주소). 배율을 바꾸면 틀 크기가 따라간다", () => {
  const doc = openDocument(readFixture("D2"));
  const container = new FakeElement("div");
  observed.length = 0;
  const view = createPageView({ container: container as never, doc, scale: 1.5, onPick: () => {} });
  try {
    assert.equal(container.children.length, doc.pageCount());
    assert.ok(container.classes.has("page-view"));
    const info = doc.pageInfo(0);
    const first = container.children[0];
    assert.ok(first !== undefined);
    assert.equal(first.style["width"], `${info.width * 1.5}px`);
    assert.equal(first.style["height"], `${info.height * 1.5}px`);
    assert.match(first.children[0]?.src ?? "", /^blob:/, "첫 쪽은 바로 그린다");
    const second = container.children[1];
    assert.ok(second !== undefined);
    assert.equal(second.children[0]?.src, "", "나머지 쪽은 보이기 전에는 그리지 않는다");
    observerCallback?.([{ isIntersecting: true, target: second }]);
    assert.match(second.children[0]?.src ?? "", /^blob:/);
    view.setScale(0.5);
    assert.equal(first.style["width"], `${info.width * 0.5}px`);
    view.setScale(9); // 상한 200%
    assert.equal(first.style["width"], `${info.width * 2}px`);
  } finally {
    view.destroy();
    doc.free();
  }
});

test("강조 표시: 같은 문단의 글자 구간이 런마다 사각형으로, 배율을 곱한 위치에 놓인다", () => {
  const doc = openDocument(readFixture("hancom/ph-single"));
  const container = new FakeElement("div");
  const view = createPageView({ container: container as never, doc, scale: 1, onPick: () => {} });
  try {
    const first = container.children[0];
    assert.ok(first !== undefined);
    observerCallback?.([{ isIntersecting: true, target: first }]);
    const mark: ViewMark = { id: "m", kind: "placeholder", position: { sectionIndex: 0, paragraphIndex: 1, charOffset: 5 }, endOffset: 21 };
    view.setMarks([mark]);
    const overlay = first.children[1];
    assert.equal(overlay?.children.length, 2, "런 둘에 걸친 구간이므로 사각형 둘");
    const run = doc.pageLayout(0).runs.find((r) => r.text === "사업명: {{");
    assert.ok(run !== undefined);
    assert.equal(overlay?.children[0]?.style["left"], `${run.x + (run.charX[5] ?? 0)}px`);
    assert.equal(overlay?.children[0]?.className, "hl mark-placeholder");
    view.setScale(1.5);
    assert.equal(overlay?.children[0]?.style["left"], `${(run.x + (run.charX[5] ?? 0)) * 1.5}px`);
    // 덮어야 할 글(text)을 주면 쪽 글자 배치가 덮는 글과 맞을 때만 그린다
    view.setMarks([{ ...mark, text: "{{project.name}}" }]);
    assert.equal(overlay?.children.length, 2);
    view.setMarks([{ ...mark, text: "다른 글" }]);
    assert.equal(overlay?.children.length, 0, "글이 다르면(순번이 어긋난 문단) 엉뚱한 글자에 칠하지 않는다");
    view.setMarks([]);
    assert.equal(overlay?.children.length, 0);
  } finally {
    view.destroy();
    doc.free();
  }
});

test("클릭: 화면 좌표가 쪽 좌표로 바뀌어 hitTest 위치와 확인할 런이 나온다(배율 50%·100%·150%)", () => {
  const doc = openDocument(readFixture("hancom/ph-single"));
  const run = doc.pageLayout(0).runs.find((r) => r.text === "입니다.");
  assert.ok(run !== undefined);
  const start = runPosition(run);
  assert.ok(start !== undefined);
  const rect = charRect(run, 1);
  for (const scale of [0.5, 1, 1.5]) {
    const container = new FakeElement("div");
    const picks: PickEvent[] = [];
    const view = createPageView({ container: container as never, doc, scale, onPick: (e) => picks.push(e) });
    try {
      const page = container.children[0];
      assert.ok(page !== undefined);
      page.box = { left: 40, top: -300 };
      const x = rect.x + rect.w * 0.25;
      const y = rect.y + rect.h / 2;
      const clientX = 40 + x * scale;
      const clientY = -300 + y * scale;
      page.fire("mousedown", { button: 0, clientX, clientY, currentTarget: page, preventDefault: () => {} });
      fireWindow("mouseup", { clientX, clientY });
      assert.equal(picks.length, 1, `배율 ${scale}`);
      const pick = picks[0];
      assert.equal(pick?.hit.region, "body");
      assert.deepEqual(pick?.hit.position, { ...start, charOffset: start.charOffset + 1 });
      assert.deepEqual(pick?.shown, { text: "입니다.", start: start.charOffset });
      assert.equal(pick?.guide, false);
      assert.equal(pick?.to, undefined);
      // 오른쪽 버튼은 무시한다
      page.fire("mousedown", { button: 2, clientX, clientY, currentTarget: page, preventDefault: () => {} });
      assert.equal(picks.length, 1);
    } finally {
      view.destroy();
    }
  }
  doc.free();
});

test("끌기: 같은 문단 안이면 to가 붙고 강조(selection)가 그려지며, 놓은 뒤에는 지워진다. 문턱 아래 움직임은 클릭이다", () => {
  const doc = openDocument(readFixture("hancom/ph-single"));
  const run = doc.pageLayout(0).runs.find((r) => r.text === "입니다.");
  assert.ok(run !== undefined);
  const from = charRect(run, 0);
  const to = charRect(run, 3);
  const container = new FakeElement("div");
  const picks: PickEvent[] = [];
  const view = createPageView({ container: container as never, doc, scale: 1, onPick: (e) => picks.push(e) });
  try {
    const page = container.children[0];
    assert.ok(page !== undefined);
    observerCallback?.([{ isIntersecting: true, target: page }]);
    const ax = from.x + from.w * 0.25;
    const bx = to.x + to.w * 0.25;
    const y = from.y + from.h / 2;
    page.fire("mousedown", { button: 0, clientX: ax, clientY: y, currentTarget: page, preventDefault: () => {} });
    fireWindow("mousemove", { clientX: bx, clientY: y });
    const overlay = page.children[1];
    assert.ok((overlay?.children.length ?? 0) >= 1 && overlay?.children[0]?.className === "hl mark-selection");
    fireWindow("mouseup", { clientX: bx, clientY: y });
    assert.equal(overlay?.children.length, 0, "놓으면 선택 표시를 지운다");
    assert.equal(picks.length, 1);
    const pick = picks[0];
    assert.ok(pick?.to !== undefined);
    assert.equal(pick.to.position.charOffset - (pick.hit.position?.charOffset ?? 0), 3);
    assert.equal(pick.to.shown?.text, "입니다.");

    // 2px만 움직이면 클릭
    page.fire("mousedown", { button: 0, clientX: ax, clientY: y, currentTarget: page, preventDefault: () => {} });
    fireWindow("mousemove", { clientX: ax + 2, clientY: y });
    fireWindow("mouseup", { clientX: ax + 2, clientY: y });
    assert.equal(picks[1]?.to, undefined);
  } finally {
    view.destroy();
    doc.free();
  }
});

test("머리말을 누르면 영역만 담긴 PickEvent가 나온다(문서 위치 없음)", () => {
  const doc = openDocument(readFixture("D7"));
  const header = doc.pageLayout(0).runs.find((r) => r.text.startsWith("머리말"));
  assert.ok(header !== undefined && !hasDocCoords(header));
  const container = new FakeElement("div");
  const picks: PickEvent[] = [];
  const view = createPageView({ container: container as never, doc, scale: 1, onPick: (e) => picks.push(e) });
  try {
    const page = container.children[0];
    assert.ok(page !== undefined);
    const x = header.x + header.w / 2;
    const y = header.y + header.h / 2;
    page.fire("mousedown", { button: 0, clientX: x, clientY: y, currentTarget: page, preventDefault: () => {} });
    fireWindow("mouseup", { clientX: x, clientY: y });
    assert.equal(picks[0]?.hit.region, "header");
    assert.equal(picks[0]?.hit.position, undefined);
    assert.equal(picks[0]?.shown, undefined);
  } finally {
    view.destroy();
    doc.free();
  }
});

test("겹친 글자 위를 누르면 위치를 내지 않는다(limit none, OVERLAPPING_RUNS) — hitTest가 가리키는 다른 문단으로 가지 않는다", () => {
  const filler = "가나다라마바사아자차카타파하 ".repeat(6);
  const doc = openDocument(synth([P(R(T(filler) + RECT(SUBLIST(SUBP("박스")), "1") + T(filler)))]));
  try {
    const layout = doc.pageLayout(0);
    let spot: { x: number; y: number } | undefined;
    for (const run of layout.runs) {
      if (!hasDocCoords(run) || run.text === "") continue;
      for (let i = 0; i < Array.from(run.text).length && spot === undefined; i++) {
        const r = charRect(run, i);
        const x = r.x + r.w * 0.25;
        const y = r.y + r.h / 2;
        if (glyphsAt(layout, x, y).length > 1) spot = { x, y };
      }
    }
    assert.ok(spot !== undefined, "겹친 글자 점을 찾지 못했다");
    // 사실: rhwp의 hitTest는 이 점에서 위치를 낸다(그 위치를 쓰면 엉뚱한 글자가 된다)
    assert.ok(doc.hit(0, spot.x, spot.y).position !== undefined);
    const container = new FakeElement("div");
    const picks: PickEvent[] = [];
    const view = createPageView({ container: container as never, doc, scale: 1, onPick: (e) => picks.push(e) });
    try {
      const page = container.children[0];
      assert.ok(page !== undefined);
      page.fire("mousedown", { button: 0, clientX: spot.x, clientY: spot.y, currentTarget: page, preventDefault: () => {} });
      fireWindow("mouseup", { clientX: spot.x, clientY: spot.y });
      const pick = picks[0];
      assert.deepEqual([pick?.limit, pick?.reason, pick?.hit.position, pick?.shown, pick?.glyph], ["none", "OVERLAPPING_RUNS", undefined, undefined, undefined]);
    } finally {
      view.destroy();
    }
  } finally {
    doc.free();
  }
});

test("글자가 없는 곳을 누르면 문단까지만(limit paragraph, NEAREST_LINE)이고, 글자 순번(glyph)은 없다. 글자에서 빈 곳으로 끌면 선택 표시를 그리지 않고 to는 문단 한계다", () => {
  const doc = openDocument(readFixture("hancom/ph-single"));
  const run = doc.pageLayout(0).runs.find((r) => r.text === "입니다.");
  assert.ok(run !== undefined);
  const container = new FakeElement("div");
  const picks: PickEvent[] = [];
  const view = createPageView({ container: container as never, doc, scale: 1, onPick: (e) => picks.push(e) });
  try {
    const page = container.children[0];
    assert.ok(page !== undefined);
    observerCallback?.([{ isIntersecting: true, target: page }]);
    const blank = { x: run.x + run.w + 8, y: run.y + run.h / 2 };
    page.fire("mousedown", { button: 0, clientX: blank.x, clientY: blank.y, currentTarget: page, preventDefault: () => {} });
    fireWindow("mouseup", { clientX: blank.x, clientY: blank.y });
    const click = picks[0];
    assert.deepEqual([click?.limit, click?.reason, click?.glyph], ["paragraph", "NEAREST_LINE", undefined]);
    assert.deepEqual(click?.shown?.text, "입니다.", "문단 확인에는 가장 가까운 런을 쓴다");
    assert.equal(click?.hit.position?.charOffset, click?.shown?.start, "위치의 글자 순번은 확인할 런의 처음이다(문단 단위)");

    // 글자(`입`)에서 빈 곳으로 끌기
    const start = charRect(run, 0);
    const sx = start.x + start.w * 0.25;
    const sy = start.y + start.h / 2;
    page.fire("mousedown", { button: 0, clientX: sx, clientY: sy, currentTarget: page, preventDefault: () => {} });
    fireWindow("mousemove", { clientX: blank.x, clientY: blank.y });
    assert.equal(page.children[1]?.children.length, 0, "한쪽 끝이 글자 위가 아니면 선택 표시를 그리지 않는다");
    fireWindow("mouseup", { clientX: blank.x, clientY: blank.y });
    const drag = picks[1];
    assert.deepEqual([drag?.limit, drag?.to?.limit, drag?.to?.reason], ["char", "paragraph", "NEAREST_LINE"]);
  } finally {
    view.destroy();
    doc.free();
  }
});
