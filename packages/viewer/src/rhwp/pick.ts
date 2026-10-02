// 눌린 점 아래에 그려진 글자를 찾는다. 글자 위치의 근거는 rhwp의 `hitTest`가 아니라 점 아래에 실제로 그려진 런(쪽 글자 배치의 런)이다:
// `hitTest`는 겹친 런·빈 칸 런·개체 앞뒤에서 눌린 글자가 아닌 곳의 순번을 주기도 한다. DOM도 rhwp도 부르지 않는 순수 함수라 Node에서 시험한다.
import { hasDocCoords, MARKER_PARA_MIN, runLength, runPosition, sameParagraph, type LayoutRun, type PageLayout } from "./layout.ts";

/** 점 아래의 글자 하나: 그 글자가 속한 런과 런 안 글자 순번(0부터) */
export type GlyphHit = { run: LayoutRun; index: number };

/** 머리말·꼬리말·각주 본문 글의 런인가(`paraIdx`가 표지값). */
export const isMarkerRun = (run: LayoutRun): boolean => typeof run.paraIdx === "number" && run.paraIdx >= MARKER_PARA_MIN;

/**
 * 점 `(x, y)`가 런 안 어느 글자의 사각형(`x + charX[i]` ~ `x + charX[i + 1]`, `y` ~ `y + h`)에 드는지. 글이 빈 런과 폭 0 글자는 후보가 아니다.
 * 글자 사이의 경계는 오른쪽 글자 것이고, 런의 맨 오른쪽 끝은 마지막 글자 것이다.
 */
export function glyphIndexAt(run: LayoutRun, x: number, y: number): number | undefined {
  if (run.text === "" || y < run.y || y > run.y + run.h) return undefined;
  const n = runLength(run);
  if (run.charX.length < n + 1) return undefined;
  const rel = x - run.x;
  for (let i = 0; i < n; i++) {
    const a = run.charX[i] ?? 0;
    const b = run.charX[i + 1] ?? a;
    if (b > a && rel >= a && (rel < b || (i === n - 1 && rel === b))) return i;
  }
  return undefined;
}

/** 점 아래에 글자가 있는 런을 모두(쪽 글자 배치 순서대로) 모은다. */
export function glyphsAt(layout: PageLayout, x: number, y: number): GlyphHit[] {
  const out: GlyphHit[] = [];
  for (const run of layout.runs) {
    const index = glyphIndexAt(run, x, y);
    if (index !== undefined) out.push({ run, index });
  }
  return out;
}

/** 글자 사각형 안에서 누른 곳이 앞쪽 절반이면 글자 앞(`index`), 뒤쪽 절반이면 글자 뒤(`index + 1`)의 런 안 경계 순번. */
export function caretIndex(run: LayoutRun, index: number, x: number): number {
  const a = run.x + (run.charX[index] ?? 0);
  const b = run.x + (run.charX[index + 1] ?? 0);
  return x < (a + b) / 2 ? index : index + 1;
}

export type PointClass =
  /** 점 아래에 그려진 글자가 없다(빈 곳·여백·글자 없는 칸) */
  | { kind: "blank" }
  /** 머리말·꼬리말·각주 본문 글자뿐이다(그 런) */
  | { kind: "marker"; run: LayoutRun }
  /** 문서 좌표가 있는 런 하나의 글자. `caret`은 런 안 경계 순번(`glyph` 앞 또는 뒤) */
  | { kind: "glyph"; run: LayoutRun; glyph: number; caret: number }
  /** 글자가 겹친 런이 둘 이상이다. `sameParagraph`: 문서 좌표가 있는 런뿐이고 모두 같은 문단이다. `first`: 그 가운데 첫 문서 좌표 런 */
  | { kind: "overlap"; sameParagraph: boolean; marker: boolean; first?: GlyphHit }
  /** 문서 좌표 없이 그려진 글자 하나(쪽 번호·번호 글·각주 번호·안내문). `empty`는 바로 앞에 놓인 빈 문서 런(안내문 상태 누름틀의 자리 후보) */
  | { kind: "unpositioned"; run: LayoutRun; empty?: LayoutRun };

/** 안내문은 같은 자리의 빈 문서 런 바로 뒤에 그려진다: 좌표 없는 런 `run` 앞쪽에서 가장 가까운 문서 런이 글이 빈 것이면 그것. */
function emptyBefore(layout: PageLayout, run: LayoutRun): LayoutRun | undefined {
  const at = layout.runs.indexOf(run);
  for (let i = at - 1; i >= 0; i--) {
    const prev = layout.runs[i];
    if (prev === undefined || !hasDocCoords(prev)) continue;
    return prev.text === "" ? prev : undefined;
  }
  return undefined;
}

/** 점 아래에 무엇이 그려졌는지 가른다(영역 판별·엔진 확인 이전의 순수한 기하 판단). */
export function classifyPoint(layout: PageLayout, x: number, y: number): PointClass {
  const hits = glyphsAt(layout, x, y);
  const only = hits[0];
  if (only === undefined) return { kind: "blank" };
  if (hits.length === 1) {
    const { run, index } = only;
    if (isMarkerRun(run)) return { kind: "marker", run };
    if (!hasDocCoords(run)) {
      const empty = emptyBefore(layout, run);
      return empty === undefined ? { kind: "unpositioned", run } : { kind: "unpositioned", run, empty };
    }
    return { kind: "glyph", run, glyph: index, caret: caretIndex(run, index, x) };
  }
  const docs = hits.filter((h) => hasDocCoords(h.run));
  const first = docs[0];
  const marker = hits.some((h) => isMarkerRun(h.run));
  const same =
    first !== undefined &&
    docs.length === hits.length &&
    docs.every((h) => {
      const a = runPosition(first.run);
      const b = runPosition(h.run);
      return a !== undefined && b !== undefined && sameParagraph(a, b);
    });
  return first === undefined ? { kind: "overlap", sameParagraph: false, marker } : { kind: "overlap", sameParagraph: same, marker, first };
}

/** 런의 가로 범위 오른쪽 끝(글자 경계가 `w` 밖까지 뻗은 런이 있다: 줄 끝 공백) */
const rightOf = (run: LayoutRun): number => run.x + Math.max(run.w, run.charX[run.charX.length - 1] ?? 0);
/** 점에서 런의 세로 범위까지 거리(범위 안이면 0) */
const gapY = (run: LayoutRun, y: number): number => (y < run.y ? run.y - y : y > run.y + run.h ? y - (run.y + run.h) : 0);
/** 점에서 런의 가로 범위까지 거리(범위 안이면 0) */
const gapX = (run: LayoutRun, x: number): number => (x < run.x ? run.x - x : x > rightOf(run) ? x - rightOf(run) : 0);

/**
 * 빈 곳에서 점에 가장 가까운 줄의 런(행 우선). 문서 좌표가 있는 런(빈 런 포함)만 본다.
 * 점의 세로 위치를 세로 범위에 담는 런이 있으면 그 가운데에서, 없으면 세로로 가장 가까운 줄(그 런과 세로 범위가 절반 넘게 겹치는 런 묶음)에서
 * 가로로 가장 가까운 런을 고른다. 가로 거리가 같으면 점에서 런 가운데가 더 가까운 쪽이다(칸 폭만큼 넓은 빈 런보다 글이 있는 런).
 * 평면 거리로 고르면 더 길게 뻗은 아랫줄의 런이 뽑혀 같은 높이 줄의 문단을 놓친다.
 */
export function nearestLineRun(layout: PageLayout, x: number, y: number): LayoutRun | undefined {
  const runs = layout.runs.filter(hasDocCoords);
  let row = runs.filter((r) => gapY(r, y) === 0);
  if (row.length === 0) {
    let seed: LayoutRun | undefined;
    for (const r of runs) if (seed === undefined || gapY(r, y) < gapY(seed, y)) seed = r;
    if (seed === undefined) return undefined;
    const top = seed.y;
    const bottom = seed.y + seed.h;
    row = runs.filter((r) => Math.min(bottom, r.y + r.h) - Math.max(top, r.y) >= 0.5 * Math.min(seed.h, r.h));
  }
  let best: LayoutRun | undefined;
  let bestKey: [number, number] = [Infinity, Infinity];
  for (const r of row) {
    const key: [number, number] = [gapX(r, x), Math.abs((r.x + rightOf(r)) / 2 - x)];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = r;
      bestKey = key;
    }
  }
  return best;
}

/** `nearestLineRun`의 순서로 가까운 줄의 런을 `limit`개까지(가장 가까운 것부터) 모은다. 같은 줄 안에서는 가로로 가까운 런이 먼저다. */
export function nearestLineRuns(layout: PageLayout, x: number, y: number, limit: number): LayoutRun[] {
  const out: LayoutRun[] = [];
  let rest = layout.runs;
  while (out.length < limit) {
    const run = nearestLineRun({ runs: rest }, x, y);
    if (run === undefined) break;
    out.push(run);
    rest = rest.filter((r) => r !== run);
  }
  return out;
}

/**
 * 빈 곳을 눌렀을 때 rhwp의 `hitTest`가 가리킨 문단(`para`)이 정말 점에서 가장 가까운 줄(`nearestLineRun`)의 문단인지 확인하고, 그 런을 돌려준다.
 * 가장 가까운 줄의 런이 `para`의 것이 아니면 undefined(`hitTest`의 문단을 믿을 수 없다).
 */
export function nearestRunOf(layout: PageLayout, para: Parameters<typeof sameParagraph>[0], x: number, y: number): LayoutRun | undefined {
  const run = nearestLineRun(layout, x, y);
  const pos = run === undefined ? undefined : runPosition(run);
  return run !== undefined && pos !== undefined && sameParagraph(pos, para) ? run : undefined;
}
