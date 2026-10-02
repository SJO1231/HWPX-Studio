// 쪽 위의 칸·글상자 사각형과 그것이 가리키는 문단 목록(`cellPath` 앞부분). 빈 곳을 눌렀을 때 점을 담은 가장 안쪽 칸·글상자를 찾는 데 쓴다.
// DOM도 rhwp도 직접 부르지 않는 순수 함수다(쪽 렌더 트리·쪽 컨트롤 배치의 JSON과, 표 경로로 칸 사각형을 묻는 함수를 받는다).
//
// 칸의 정체(어느 표의 몇 번째 칸인지)는 rhwp가 직접 준 것만 쓴다:
// - 쪽 렌더 트리의 `Table` 노드는 표를 담은 문단 번호 `pi`와 그 문단 안 컨트롤 번호 `ci`를 가진다(칸 안 표면 칸 안 문단 번호). `Cell` 노드는 행·열만 가진다.
// - 표 경로(`parentPara`, 칸 경로)로 `getTableCellBboxesByPath`를 부르면 칸 색인(`cellIdx`)과 행·열·사각형을 준다. 렌더 트리 칸의 행·열과 사각형이 이 응답과 맞을 때만
//   그 칸을 식별한 것으로 친다. 안 맞거나 응답이 없으면 식별하지 못한 칸이다(그 안의 점은 옮기지 않는다).
// - 글상자는 쪽 컨트롤 배치의 `shape` 항목(사각형, 문단 번호, 컨트롤 번호)과 렌더 트리 `Rect`(`TextBox`를 가진 것)의 사각형이 맞을 때만 식별한다. 칸 안 글상자·묶음 개체 안 글상자·
//   글상자 안의 표는 식별하지 않는다(rhwp가 칸 안 글상자 글에 칸 경로만 붙이는 등 경로를 믿을 수 없다).
import type { CellStep } from "../map/types.ts";
import type { LayoutRun, Rect } from "./layout.ts";

/** 칸·글상자의 문서 위치: 표(또는 글상자)를 담은 최상위 문단 번호와 바깥부터의 경로. 마지막 단계의 `cellParaIndex`는 쓰지 않는다. */
export type ContainerId = { parentPara: number; steps: CellStep[] };

export type Container = {
  rect: Rect;
  kind: "cell" | "textbox";
  /** 식별하지 못했으면 없다 */
  id?: ContainerId;
};

/** `getTableCellBboxesByPath`의 한 칸 */
export type ApiCell = { cellIdx: number; row: number; col: number; x: number; y: number; w: number; h: number };

export type ContainerSource = {
  /** 쪽 컨트롤 배치(`getPageControlLayout`)의 JSON */
  controls: unknown;
  /**
   * 쪽 글자 배치의 런. 칸·글상자 식별을 검증하는 데만 쓴다: 칸 사각형 안에 그려진 글 있는 런의 `cellPath`가 식별한 칸 색인과 다르면(rhwp의 표 칸 응답 번호와 런의 칸 번호가
   * 어긋난 표가 있다: 병합 칸이 있는 표에서 한 칸씩 밀린 것이 관측됐다) 그 표의 칸은 모두 식별하지 못한 것으로 친다. 검증할 글 있는 런이 하나도 없어도 식별하지 않는다.
   */
  runs?: readonly LayoutRun[];
  /** 표 경로의 칸 사각형들. 모르면 undefined */
  tableCells(parentPara: number, path: CellStep[]): ApiCell[] | undefined;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function rectOf(v: unknown): Rect | undefined {
  if (!isRecord(v)) return undefined;
  const x = num(v["x"]);
  const y = num(v["y"]);
  const w = num(v["w"]);
  const h = num(v["h"]);
  return x === undefined || y === undefined || w === undefined || h === undefined ? undefined : { x, y, w, h };
}

/** 런의 왼쪽 끝 가운데 점이 사각형 안에 드는가(글자 폭보다 넓게 그려진 빈 런의 한가운데는 칸 밖일 수 있어 왼쪽 끝으로 본다). */
const leftInside = (run: LayoutRun, r: Rect): boolean => run.x + 0.5 >= r.x && run.x + 0.5 <= r.x + r.w && run.y + run.h / 2 >= r.y && run.y + run.h / 2 <= r.y + r.h;

/** 글상자 사각형 안의 글 있는 런이 모두 (문단 `para`, 컨트롤 `control`)의 글상자 하나를 가리키고, 그런 런이 하나 이상 있는가. */
function boxTextMatches(runs: readonly LayoutRun[] | undefined, rect: Rect, para: number, control: number): boolean {
  if (runs === undefined) return false;
  let verified = 0;
  for (const run of runs) {
    if (run.cellPath === undefined || run.text === "" || !leftInside(run, rect)) continue;
    if (run.parentParaIdx !== para || run.cellPath.length !== 1 || run.cellPath[0]?.controlIndex !== control) return false;
    verified++;
  }
  return verified > 0;
}

const close = (a: Rect, b: Rect, tol = 1): boolean => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;

/** 본문이 아닌 영역의 노드: 그 안의 표·글상자는 문서 좌표가 본문과 겹쳐 보이므로 식별하지 않는다. */
const ASIDE = new Set(["Header", "Footer", "MasterPage", "FootnoteArea"]);

type Ctx = {
  /** 이 칸을 담은 표까지의 경로(바깥 칸 단계의 `cellParaIndex`는 채워져 있다) */
  outer: CellStep[];
  parentPara: number;
  /** 이 칸의 표 컨트롤 번호와 칸 색인 */
  controlIndex: number;
  cellIdx: number;
};

/** 쪽 렌더 트리와 쪽 컨트롤 배치에서 칸·글상자 사각형을 모은다(바깥에서 안쪽 순서). */
export function buildContainers(tree: unknown, source: ContainerSource): Container[] {
  const out: Container[] = [];
  const shapes: { rect: Rect; paraIdx: number; controlIdx: number; inCell: boolean }[] = [];
  if (isRecord(source.controls) && Array.isArray(source.controls["controls"])) {
    for (const c of source.controls["controls"]) {
      if (!isRecord(c) || c["type"] !== "shape") continue;
      const rect = rectOf(c);
      const paraIdx = num(c["paraIdx"]);
      const controlIdx = num(c["controlIdx"]);
      if (rect !== undefined && paraIdx !== undefined && controlIdx !== undefined) shapes.push({ rect, paraIdx, controlIdx, inCell: c["cellIdx"] !== undefined });
    }
  }

  /** `ctx`: 지금 있는 칸(식별했으면). `unknown`: 식별하지 못한 칸·본문 밖 영역 안이다. */
  const walk = (node: unknown, ctx: Ctx | undefined, unknown: boolean, depth: number): void => {
    if (!isRecord(node) || depth > 64) return;
    const type = node["type"];
    const bbox = rectOf(node["bbox"]);
    const children = Array.isArray(node["children"]) ? node["children"] : [];
    if (typeof type === "string" && ASIDE.has(type)) {
      for (const c of children) walk(c, undefined, true, depth + 1);
      return;
    }
    if (type === "Table") {
      const pi = num(node["pi"]);
      const ci = num(node["ci"]);
      let steps: CellStep[] | undefined;
      let parentPara: number | undefined;
      if (!unknown && pi !== undefined && ci !== undefined) {
        if (ctx === undefined) {
          steps = [];
          parentPara = pi;
        } else {
          steps = [...ctx.outer, { controlIndex: ctx.controlIndex, cellIndex: ctx.cellIdx, cellParaIndex: pi }];
          parentPara = ctx.parentPara;
        }
      }
      let api: ApiCell[] | undefined;
      if (steps !== undefined && parentPara !== undefined && ci !== undefined) {
        try {
          api = source.tableCells(parentPara, [...steps, { controlIndex: ci, cellIndex: 0, cellParaIndex: 0 }]);
        } catch {
          api = undefined;
        }
      }
      type Planned = { node: Record<string, unknown>; rect: Rect; cellIdx?: number };
      const planned: Planned[] = [];
      for (const cell of children) {
        if (!isRecord(cell) || cell["type"] !== "Cell") {
          walk(cell, ctx, unknown, depth + 1);
          continue;
        }
        const rect = rectOf(cell["bbox"]);
        if (rect === undefined) continue;
        const row = num(cell["row"]);
        const col = num(cell["col"]);
        const found = steps === undefined ? undefined : api?.find((a) => a.row === row && a.col === col && close(rect, a));
        planned.push(found === undefined ? { node: cell, rect } : { node: cell, rect, cellIdx: found.cellIdx });
      }
      // 칸 사각형 안의 글 있는 런이 식별한 칸 색인과 어긋나면(또는 검증할 런이 없으면) 이 표의 칸은 모두 식별하지 않는다
      let trusted = steps !== undefined && parentPara !== undefined && ci !== undefined;
      if (trusted && source.runs !== undefined) {
        let verified = 0;
        for (const p of planned) {
          if (p.cellIdx === undefined) continue;
          for (const run of source.runs) {
            const path = run.cellPath;
            if (path === undefined || run.text === "" || run.parentParaIdx !== parentPara || path.length !== (steps?.length ?? 0) + 1 || !leftInside(run, p.rect)) continue;
            const last = path[path.length - 1];
            const outerSame = (steps ?? []).every((s, i) => path[i]?.controlIndex === s.controlIndex && path[i]?.cellIndex === s.cellIndex && path[i]?.cellParaIndex === s.cellParaIndex);
            if (!outerSame || last === undefined || last.controlIndex !== ci) continue;
            if (last.cellIndex !== p.cellIdx) trusted = false;
            else verified++;
          }
        }
        if (verified === 0) trusted = false;
      } else if (source.runs === undefined) trusted = false;
      for (const p of planned) {
        const grandchildren = Array.isArray(p.node["children"]) ? p.node["children"] : [];
        if (!trusted || p.cellIdx === undefined || steps === undefined || parentPara === undefined || ci === undefined) {
          out.push({ rect: p.rect, kind: "cell" });
          for (const c of grandchildren) walk(c, undefined, true, depth + 2);
          continue;
        }
        out.push({ rect: p.rect, kind: "cell", id: { parentPara, steps: [...steps, { controlIndex: ci, cellIndex: p.cellIdx, cellParaIndex: 0 }] } });
        const inner: Ctx = { outer: steps, parentPara, controlIndex: ci, cellIdx: p.cellIdx };
        for (const c of grandchildren) walk(c, inner, false, depth + 2);
      }
      return;
    }
    if (type === "Rect" && bbox !== undefined && children.some((c) => isRecord(c) && c["type"] === "TextBox")) {
      // 글상자: 칸 밖(본문) 글상자만 식별한다
      const shape = !unknown && ctx === undefined ? shapes.find((s) => !s.inCell && close(s.rect, bbox)) : undefined;
      const container: Container = { rect: bbox, kind: "textbox" };
      if (shape !== undefined && boxTextMatches(source.runs, bbox, shape.paraIdx, shape.controlIdx)) {
        container.id = { parentPara: shape.paraIdx, steps: [{ controlIndex: shape.controlIdx, cellIndex: 0, cellParaIndex: 0 }] };
      }
      out.push(container);
      // 글상자 안의 표·글상자는 식별하지 않는다
      for (const c of children) walk(c, undefined, true, depth + 1);
      return;
    }
    for (const c of children) walk(c, ctx, unknown, depth + 1);
  };
  walk(tree, undefined, false, 0);
  return out;
}

const area = (r: Rect): number => r.w * r.h;
const holds = (outer: Rect, inner: Rect, tol = 0.6): boolean =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;

export type ContainerHit =
  /** 점이 어느 칸·글상자에도 들지 않는다(본문) */
  | { kind: "none" }
  /** 점을 담은 가장 안쪽 칸·글상자를 식별하지 못했거나, 서로 포개지 않은 사각형이 겹쳐 있어 하나로 정할 수 없다 */
  | { kind: "unknown" }
  | { kind: "in"; container: Container & { id: ContainerId } };

/** 점 `(x, y)`를 담은 가장 안쪽 칸·글상자. 후보 가운데 가장 작은 것이 나머지 모두 안에 들어 있어야 한다. */
export function containerAt(containers: readonly Container[], x: number, y: number): ContainerHit {
  const around = containers.filter((c) => x >= c.rect.x && x <= c.rect.x + c.rect.w && y >= c.rect.y && y <= c.rect.y + c.rect.h);
  if (around.length === 0) return { kind: "none" };
  let inner = around[0] as Container;
  for (const c of around) if (area(c.rect) < area(inner.rect)) inner = c;
  if (!around.every((c) => holds(c.rect, inner.rect))) return { kind: "unknown" };
  return inner.id === undefined ? { kind: "unknown" } : { kind: "in", container: { ...inner, id: inner.id } };
}

/** 런이 칸·글상자 `id`에 속하는가: 같은 부모 문단, 같은 깊이, 단계마다 컨트롤·칸 색인이 같고 바깥 단계는 칸 안 문단 번호도 같다. */
export function runInContainer(run: LayoutRun, id: ContainerId): boolean {
  const path = run.cellPath;
  if (path === undefined || run.parentParaIdx !== id.parentPara || path.length !== id.steps.length) return false;
  return id.steps.every((s, i) => {
    const p = path[i];
    return p !== undefined && p.controlIndex === s.controlIndex && p.cellIndex === s.cellIndex && (i === id.steps.length - 1 || p.cellParaIndex === s.cellParaIndex);
  });
}
