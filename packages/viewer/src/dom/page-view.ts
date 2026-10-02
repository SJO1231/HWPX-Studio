// 쪽을 세로로 이어 그리고, 배율·클릭·끌기·강조 표시를 다룬다. 브라우저 전용이다(엔진은 가져오지 않는다. 위치 변환은 호스트가 한다).
// 쪽은 SVG를 `<img>`로 넣어 그린다(문서가 만든 SVG 안의 스크립트·외부 요청이 실행되지 않는다).
import type { RhwpPosition, Shown } from "../map/types.ts";
import type { Hit, Pick, PickLimit, ViewerDocument } from "../rhwp/document.ts";
import { caretAt, guideRect, rangeCover, rangeRects, sameParagraph, samePosition, type PageLayout, type Rect } from "../rhwp/layout.ts";
import { clampScale, toPagePoint, toScreenRect } from "./geometry.ts";

/** 쪽 위에 덧그리는 강조 표시 하나. 같은 문단 안 글자 순번 구간 `[position.charOffset, endOffset)`이다. */
export type ViewMark = {
  id: string;
  /** 스타일 이름(`mark-<kind>` 클래스) */
  kind: string;
  position: RhwpPosition;
  endOffset: number;
  /** 안내문 상태 누름틀: 안내문 글(좌표 없이 그려진 런을 덮는다) */
  guide?: string;
  /** 이 구간이 덮어야 할 글. 주면 쪽 글자 배치에서 구간이 덮는 글과 비교해 다르면 그리지 않는다(순번이 어긋난 문단에서 엉뚱한 글자를 칠하지 않으려고) */
  text?: string;
};

/**
 * 눌림 하나(클릭 또는 끌기). 글자 위치는 점 아래에 그려진 런에서 얻으며(`ViewerDocument.pick`), `limit`이 서버가 낼 수 있는 가장 높은 정밀도다.
 * `limit: "none"`이면 `hit.position`이 없고, 사유가 있으면 `reason`이다(위치를 옮기지 않는다).
 */
export type PickEvent = {
  page: number;
  hit: Hit;
  /** 눌린 위치를 확인할 런(글과 첫 글자 순번) */
  shown?: Shown;
  /** 문서 좌표 없이 그려진 안내문 글을 눌렀다(안내문 상태 누름틀 후보). `guideText`는 눌린 글 */
  guide: boolean;
  guideText?: string;
  /** 눌린 글자 자신의 rhwp 순번(강조용) */
  glyph?: number;
  /** 글자 뒤쪽 절반을 눌렀다(캐럿이 글자 뒤) */
  trailing?: boolean;
  limit: PickLimit;
  reason?: string;
  /** 끌기로 고른 범위의 끝 쪽(같은 문단일 때만) */
  to?: { position: RhwpPosition; shown?: Shown; limit: PickLimit; reason?: string };
};

export type PageViewOptions = {
  container: HTMLElement;
  doc: ViewerDocument;
  scale: number;
  onPick(event: PickEvent): void;
  onError?(error: unknown): void;
};

export type PageView = {
  setScale(scale: number): void;
  /** 문서의 강조 표시(후보 자리, 고른 앵커 등)를 바꾼다. */
  setMarks(marks: ViewMark[]): void;
  destroy(): void;
};

type Slot = {
  index: number;
  width: number;
  height: number;
  wrapper: HTMLDivElement;
  img: HTMLImageElement;
  overlay: HTMLDivElement;
  url?: string;
  rendered: boolean;
};

const DRAG_THRESHOLD = 4;

function rectsOf(layout: PageLayout, mark: ViewMark): Rect[] {
  if (mark.guide !== undefined) {
    const r = guideRect(layout, mark.position, mark.position.charOffset, mark.guide);
    return r === undefined ? [] : [r];
  }
  if (mark.text !== undefined) {
    const cover = rangeCover(layout, mark.position, mark.position.charOffset, mark.endOffset);
    return cover.text === mark.text ? cover.rects : [];
  }
  const rects = rangeRects(layout, mark.position, mark.position.charOffset, mark.endOffset);
  if (rects.length > 0 || mark.endOffset > mark.position.charOffset) return rects;
  // 빈 문단·빈 칸: 캐럿 자리에 얇은 표시
  const c = caretAt(layout, mark.position, mark.position.charOffset);
  return c === undefined ? [] : [{ x: c.x, y: c.y, w: 3, h: c.h }];
}

export function createPageView(options: PageViewOptions): PageView {
  const { container, doc, onPick } = options;
  let scale = clampScale(options.scale);
  let marks: ViewMark[] = [];
  let preview: ViewMark | undefined;
  let destroyed = false;
  const slots: Slot[] = [];
  const fail = (e: unknown): void => (options.onError === undefined ? console.error(e) : options.onError(e));

  container.replaceChildren();
  container.classList.add("page-view");

  const place = (slot: Slot): void => {
    slot.wrapper.style.width = `${slot.width * scale}px`;
    slot.wrapper.style.height = `${slot.height * scale}px`;
  };

  const drawOverlay = (slot: Slot): void => {
    if (!slot.rendered) return;
    const layout = doc.pageLayout(slot.index);
    slot.overlay.replaceChildren();
    for (const mark of preview === undefined ? marks : [...marks, preview]) {
      for (const r of rectsOf(layout, mark)) {
        const s = toScreenRect(r, scale);
        const div = document.createElement("div");
        div.className = `hl mark-${mark.kind}`;
        div.dataset["mark"] = mark.id;
        div.style.left = `${s.x}px`;
        div.style.top = `${s.y}px`;
        div.style.width = `${s.w}px`;
        div.style.height = `${s.h}px`;
        slot.overlay.appendChild(div);
      }
    }
  };

  const render = (slot: Slot): void => {
    if (slot.rendered || destroyed) return;
    try {
      const svg = doc.pageSvg(slot.index);
      slot.url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      slot.img.src = slot.url;
      slot.rendered = true;
      drawOverlay(slot);
    } catch (e) {
      fail(e);
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const slot = slots[Number((entry.target as HTMLElement).dataset["page"])];
        if (slot !== undefined) render(slot);
      }
    },
    { root: null, rootMargin: "800px 0px" },
  );

  for (let i = 0; i < doc.pageCount(); i++) {
    const info = doc.pageInfo(i);
    const wrapper = document.createElement("div");
    wrapper.className = "page";
    wrapper.dataset["page"] = String(i);
    const img = document.createElement("img");
    img.className = "page-img";
    img.alt = `${i + 1}쪽`;
    img.draggable = false;
    const overlay = document.createElement("div");
    overlay.className = "page-overlay";
    wrapper.append(img, overlay);
    container.appendChild(wrapper);
    const slot: Slot = { index: i, width: info.width, height: info.height, wrapper, img, overlay, rendered: false };
    place(slot);
    slots.push(slot);
    observer.observe(wrapper);
  }

  // 첫 쪽은 바로 그린다. 창이 가려져 그리기 프레임이 돌지 않으면 보임 알림이 오지 않는데, 그때도 첫 쪽은 준비돼 있어야 한다.
  if (slots[0] !== undefined) render(slots[0]);

  // ── 클릭·끌기 ──────────────────────────────────────────────

  const pickAt = (slot: Slot, clientX: number, clientY: number): Pick => {
    const box = slot.wrapper.getBoundingClientRect();
    const point = toPagePoint({ x: clientX, y: clientY }, box, scale);
    return doc.pick(slot.index, point.x, point.y);
  };

  const onDown = (down: MouseEvent): void => {
    if (down.button !== 0) return;
    const slot = slots[Number((down.currentTarget as HTMLElement).dataset["page"])];
    if (slot === undefined) return;
    down.preventDefault();
    let start: Pick;
    try {
      start = pickAt(slot, down.clientX, down.clientY);
    } catch (e) {
      fail(e);
      return;
    }
    let moved = false;

    const onMove = (move: MouseEvent): void => {
      if (!moved && Math.hypot(move.clientX - down.clientX, move.clientY - down.clientY) < DRAG_THRESHOLD) return;
      moved = true;
      // 범위는 두 끝이 모두 글자까지 믿을 수 있는 런 위일 때만 그린다(빈 곳·겹친 곳은 글자 순번이 다른 기준이다)
      const from = start.limit === "char" && !start.guide ? start.hit.position : undefined;
      if (from === undefined) return;
      try {
        const now = pickAt(slot, move.clientX, move.clientY);
        const to = now.limit === "char" && !now.guide ? now.hit.position : undefined;
        if (to === undefined || !sameParagraph(from, to)) {
          preview = undefined;
        } else {
          const a = Math.min(from.charOffset, to.charOffset);
          const b = Math.max(from.charOffset, to.charOffset);
          preview = { id: "drag", kind: "selection", position: { ...from, charOffset: a }, endOffset: b };
        }
        drawOverlay(slot);
      } catch (e) {
        fail(e);
      }
    };

    const onUp = (up: MouseEvent): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      preview = undefined;
      drawOverlay(slot);
      try {
        const event: PickEvent = { page: slot.index, hit: start.hit, guide: start.guide, limit: start.limit };
        if (start.shown !== undefined) event.shown = start.shown;
        if (start.guideText !== undefined) event.guideText = start.guideText;
        if (start.glyph !== undefined) event.glyph = start.glyph;
        if (start.trailing === true) event.trailing = true;
        if (start.reason !== undefined) event.reason = start.reason;
        if (moved && !start.guide) {
          const end = pickAt(slot, up.clientX, up.clientY);
          // 끝이 글자 위가 아니면(문단 한계) 글자 순번이 다른 기준이라 같은 위치인지 비교하지 않는다
          if (end.hit.position !== undefined && start.hit.position !== undefined && !end.guide && (end.limit !== "char" || !samePosition(end.hit.position, start.hit.position))) {
            event.to = { position: end.hit.position, limit: end.limit };
            if (end.shown !== undefined) event.to.shown = end.shown;
            if (end.reason !== undefined) event.to.reason = end.reason;
          }
        }
        onPick(event);
      } catch (e) {
        fail(e);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  for (const slot of slots) slot.wrapper.addEventListener("mousedown", onDown);

  return {
    setScale(next) {
      scale = clampScale(next);
      for (const slot of slots) {
        place(slot);
        drawOverlay(slot);
      }
    },
    setMarks(next) {
      marks = next;
      for (const slot of slots) drawOverlay(slot);
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      for (const slot of slots) {
        if (slot.url !== undefined) URL.revokeObjectURL(slot.url);
      }
      container.replaceChildren();
    },
  };
}
