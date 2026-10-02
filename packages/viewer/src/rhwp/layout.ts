import { TABLE_CAPTION_CELL, type CellStep, type RhwpPosition } from "../map/types.ts";

/** 쪽 글자 배치의 런 하나(`getPageTextLayout`의 항목 가운데 뷰어가 쓰는 것) */
export type LayoutRun = {
  text: string;
  /** 쪽 왼쪽 위가 원점인 96 DPI 픽셀 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 런 `x` 기준 글자 경계. 길이는 유니코드 글자 수 + 1이다(JS 문자열 길이가 아니다) */
  charX: number[];
  secIdx?: number;
  paraIdx?: number;
  charStart?: number;
  parentParaIdx?: number;
  cellPath?: CellStep[];
};

export type PageLayout = { runs: LayoutRun[] };

/** 머리말·꼬리말·각주 런의 `paraIdx`는 이 값 이상인 표지값이다(문서 문단 번호가 아니다). */
export const MARKER_PARA_MIN = 4294960000;

/** 런이 문서 좌표(본문·표 셀·글상자 안의 문단 위치)를 가졌는가. 번호·글머리표·쪽 번호와 머리말·꼬리말·각주 런은 아니다. */
export function hasDocCoords(run: LayoutRun): boolean {
  return (
    typeof run.secIdx === "number" &&
    typeof run.paraIdx === "number" &&
    typeof run.charStart === "number" &&
    run.paraIdx < MARKER_PARA_MIN &&
    (run.cellPath === undefined || typeof run.parentParaIdx === "number")
  );
}

/** 문서 좌표가 있는 런의 첫 글자 위치. 없으면 undefined. */
export function runPosition(run: LayoutRun): RhwpPosition | undefined {
  if (!hasDocCoords(run)) return undefined;
  const pos: RhwpPosition = { sectionIndex: run.secIdx ?? 0, paragraphIndex: run.paraIdx ?? 0, charOffset: run.charStart ?? 0 };
  if (run.cellPath !== undefined && run.cellPath.length > 0) {
    pos.parentParaIndex = run.parentParaIdx ?? 0;
    pos.cellPath = run.cellPath;
  }
  return pos;
}

const sameSteps = (a: CellStep[] | undefined, b: CellStep[] | undefined): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((s, i) => s.controlIndex === y[i]?.controlIndex && s.cellIndex === y[i]?.cellIndex && s.cellParaIndex === y[i]?.cellParaIndex);
};

const inCaption = (p: RhwpPosition): boolean => p.cellPath?.[p.cellPath.length - 1]?.cellIndex === TABLE_CAPTION_CELL;

/** 두 위치가 같은 문단(오프셋은 보지 않는다)인가. 표 캡션은 `paragraphIndex`를 항상 0으로 내므로 경로(`cellPath`)만 본다. */
export function sameParagraph(a: RhwpPosition, b: RhwpPosition): boolean {
  return (
    a.sectionIndex === b.sectionIndex &&
    (inCaption(a) || a.paragraphIndex === b.paragraphIndex) &&
    a.parentParaIndex === b.parentParaIndex &&
    sameSteps(a.cellPath, b.cellPath)
  );
}

export function samePosition(a: RhwpPosition, b: RhwpPosition): boolean {
  return sameParagraph(a, b) && a.charOffset === b.charOffset;
}

/** 런의 글자 수(유니코드 글자 단위). `charX`의 길이는 이 값 + 1이다. */
export function runLength(run: LayoutRun): number {
  let n = 0;
  for (const _ of run.text) n++;
  return n;
}

export type Rect = { x: number; y: number; w: number; h: number };

/** 런 안 `i`번째 글자(0부터)의 사각형. 쪽 픽셀. */
export function charRect(run: LayoutRun, i: number): Rect {
  const left = run.charX[i] ?? 0;
  const right = run.charX[i + 1] ?? left;
  return { x: run.x + left, y: run.y, w: right - left, h: run.h };
}

/**
 * 한 문단 안 글자 순번 구간 `[from, to)`의 사각형들(런마다 하나). 런이 구간과 겹치는 만큼만 잘라 낸다.
 * 캐럿 사각형 함수는 쓰지 않고(각주가 있는 문단에서 어긋난다) 글자 배치의 `x + charX`와 런의 `y/h`로 만든다.
 */
export function rangeRects(layout: PageLayout, para: RhwpPosition, from: number, to: number): Rect[] {
  const out: Rect[] = [];
  for (const run of layout.runs) {
    const start = runPosition(run);
    if (start === undefined || !sameParagraph(start, para)) continue;
    const n = runLength(run);
    const a = Math.max(from, start.charOffset);
    const b = Math.min(to, start.charOffset + n);
    if (a >= b) continue;
    const left = run.charX[a - start.charOffset] ?? 0;
    const right = run.charX[b - start.charOffset] ?? left;
    out.push({ x: run.x + left, y: run.y, w: right - left, h: run.h });
  }
  return out;
}

/**
 * `rangeRects`와 같은 사각형에 더해, 그 사각형들이 덮은 글(런의 글을 구간만큼 잘라 이은 것)을 돌려준다.
 * 호출한 쪽이 기대한 글과 비교해, rhwp의 런 순번이 엔진 글자 순번과 어긋난 문단(개체 뒤에서 글자 모양이 바뀐 런 등)에서 엉뚱한 글자에
 * 강조 표시를 그리지 않게 한다.
 */
export function rangeCover(layout: PageLayout, para: RhwpPosition, from: number, to: number): { rects: Rect[]; text: string } {
  const rects: Rect[] = [];
  let text = "";
  for (const run of layout.runs) {
    const start = runPosition(run);
    if (start === undefined || !sameParagraph(start, para)) continue;
    const n = runLength(run);
    const a = Math.max(from, start.charOffset);
    const b = Math.min(to, start.charOffset + n);
    if (a >= b) continue;
    const left = run.charX[a - start.charOffset] ?? 0;
    const right = run.charX[b - start.charOffset] ?? left;
    rects.push({ x: run.x + left, y: run.y, w: right - left, h: run.h });
    text += Array.from(run.text).slice(a - start.charOffset, b - start.charOffset).join("");
  }
  return { rects, text };
}

/** 한 문단의 글자 순번 `k`의 경계 위치(쪽 픽셀 x, y, 높이). 그 문단의 런 가운데 `k`를 품은 첫 런에서 구한다. */
export function caretAt(layout: PageLayout, para: RhwpPosition, k: number): { x: number; y: number; h: number } | undefined {
  for (const run of layout.runs) {
    const start = runPosition(run);
    if (start === undefined || !sameParagraph(start, para)) continue;
    const i = k - start.charOffset;
    if (i < 0 || i > runLength(run)) continue;
    return { x: run.x + (run.charX[i] ?? 0), y: run.y, h: run.h };
  }
  return undefined;
}

/**
 * 안내문 상태 누름틀의 안내문이 그려진 사각형. rhwp는 안내문을 글자 칸 없이 문서 좌표 없는 런으로 따로 그리며,
 * 그 누름틀 자리에는 글이 빈 런(문서 좌표 있음)이 하나 놓인다. 그 빈 런 바로 뒤에서 `guide` 글인 첫 좌표 없는 런을 찾는다.
 */
export function guideRect(layout: PageLayout, para: RhwpPosition, k: number, guide: string): Rect | undefined {
  const runs = layout.runs;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const start = run === undefined ? undefined : runPosition(run);
    if (run === undefined || start === undefined || run.text !== "" || start.charOffset !== k || !sameParagraph(start, para)) continue;
    for (let j = i + 1; j < runs.length; j++) {
      const next = runs[j];
      if (next !== undefined && !hasDocCoords(next) && next.text === guide) return { x: next.x, y: next.y, w: next.w, h: next.h };
    }
  }
  return undefined;
}

/** 쪽 영역별로 그 안에 그려진 글(`TextRun`)의 사각형 */
export type RegionBoxes = { master: Rect[]; body: Rect[]; header: Rect[]; footer: Rect[]; footnote: Rect[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const AREA_OF_NODE: Record<string, keyof RegionBoxes> = { MasterPage: "master", Body: "body", Header: "header", Footer: "footer", FootnoteArea: "footnote" };

/**
 * 쪽 렌더 트리(`getPageRenderTree`의 JSON)에서 영역(바탕쪽 `MasterPage`, 본문 `Body`, 머리말 `Header`, 꼬리말 `Footer`, 각주 `FootnoteArea`) 안의 글(`TextRun`)이 놓인 사각형을 모은다.
 * 머리말·꼬리말·각주 영역의 글이 빈 `TextRun`은 모으지 않는다(머리말이 비어 있어도 영역 폭만큼 넓은 빈 글 상자가 나와 본문 글을 머리말 글로 오인하게 한다).
 * rhwp는 바탕쪽 글과 머리말·꼬리말 안 표 칸의 글에도 본문과 같은 번호 공간의 문서 좌표를 붙여 쪽 글자 배치와 클릭 위치에 내보내므로(본문 문단·표 칸처럼 보인다),
 * 점 아래의 글이 어느 영역의 것인지 가려내는 데 쓴다.
 */
export function regionBoxes(tree: unknown): RegionBoxes {
  const out: RegionBoxes = { master: [], body: [], header: [], footer: [], footnote: [] };
  const walk = (node: unknown, area: keyof RegionBoxes | undefined, depth: number): void => {
    if (!isRecord(node) || depth > 64) return;
    const type = node["type"];
    const here = area ?? (typeof type === "string" ? AREA_OF_NODE[type] : undefined);
    const bbox = node["bbox"];
    const emptyAside = node["text"] === "" && (here === "header" || here === "footer" || here === "footnote");
    if (type === "TextRun" && here !== undefined && !emptyAside && isRecord(bbox)) {
      const { x, y, w, h } = bbox;
      if (typeof x === "number" && typeof y === "number" && typeof w === "number" && typeof h === "number") out[here].push({ x, y, w, h });
    }
    const children = node["children"];
    if (Array.isArray(children)) for (const c of children) walk(c, here, depth + 1);
  };
  walk(tree, undefined, 0);
  return out;
}

export const insideAny = (rects: Rect[], x: number, y: number): boolean => rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
