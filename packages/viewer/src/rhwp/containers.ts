// 쪽 위의 칸·글상자 사각형과 그것이 가리키는 문단 목록. 빈 곳을 눌렀을 때 점을 담은 가장 안쪽 칸·글상자를 찾는 데 쓴다.
// DOM도 rhwp도 직접 부르지 않는 순수 함수다(쪽 렌더 트리·쪽 컨트롤 배치의 JSON과 쪽 글자 배치의 런을 받는다).
//
// 표 칸의 정체(어느 표의 어느 칸인지)는 쪽 렌더 트리가 직접 준 것만 쓴다: `Table` 노드는 표를 담은 문단 번호 `pi`와 그 문단 안 컨트롤 번호 `ci`를 가지고(칸 안 표면 칸 안 문단 번호),
// `Cell` 노드는 시작 행·열을 가진다. 이것을 바깥 표부터 이은 표 경로(`TableStep[]`)가 칸의 식별이다. 그 칸의 엔진 문단은 서버가 엔진 모델의 표·행·열로 찾으므로(`locateInCell`)
// rhwp의 칸 색인(표에 따라 어긋난다)은 쓰지 않고, 표 경로를 묻는 rhwp 함수도 부르지 않는다. 머리말·꼬리말·바탕쪽·각주 영역 안의 표와 글상자 안의 표는 식별하지 않는다
// (그 안의 문서 좌표는 본문과 겹쳐 보인다).
// 글상자는 쪽 컨트롤 배치의 `shape` 항목(사각형, 문단 번호, 컨트롤 번호)과 렌더 트리 `Rect`(`TextBox`를 가진 것)의 사각형이 맞을 때만 식별한다. 칸 안 글상자·묶음 개체 안 글상자·
// 글상자 안의 표는 식별하지 않는다(rhwp가 칸 안 글상자 글에 칸 경로만 붙이는 등 경로를 믿을 수 없다).
import type { CellStep, TableStep } from "../map/types.ts";
import { TABLE_CAPTION_CELL } from "../map/types.ts";
import { hasDocCoords, isRecord, num, rectOf, type LayoutRun, type Rect } from "./layout.ts";

/** 글상자의 문서 위치: 글상자를 담은 최상위 문단 번호와 바깥부터의 경로. 마지막 단계의 `cellParaIndex`는 쓰지 않는다. */
export type ContainerId = { parentPara: number; steps: CellStep[] };

export type Container =
  /** `table`: 렌더 트리의 표 경로(바깥 표부터, 마지막이 이 칸). 식별하지 못했으면 없다 */
  | { rect: Rect; kind: "cell"; table?: TableStep[] }
  /** `id`: 식별하지 못했으면 없다 */
  | { rect: Rect; kind: "textbox"; id?: ContainerId };

export type ContainerSource = {
  /** 쪽 컨트롤 배치(`getPageControlLayout`)의 JSON */
  controls: unknown;
  /** 쪽 글자 배치의 런. 글상자 식별을 검증하는 데만 쓴다(글상자 사각형 안의 글 있는 런이 모두 그 글상자의 것이어야 한다). */
  runs?: readonly LayoutRun[];
};

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

  /** `outer`: 지금 있는 칸까지의 표 경로(식별했으면). `unknown`: 식별하지 못한 칸·본문 밖 영역 안이다. */
  const walk = (node: unknown, outer: TableStep[] | undefined, unknown: boolean, depth: number): void => {
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
      for (const cell of children) {
        if (!isRecord(cell) || cell["type"] !== "Cell") {
          walk(cell, outer, unknown, depth + 1);
          continue;
        }
        const rect = rectOf(cell["bbox"]);
        if (rect === undefined) continue;
        const row = num(cell["row"]);
        const col = num(cell["col"]);
        const grandchildren = Array.isArray(cell["children"]) ? cell["children"] : [];
        if (unknown || pi === undefined || ci === undefined || row === undefined || col === undefined) {
          out.push({ rect, kind: "cell" });
          for (const c of grandchildren) walk(c, undefined, true, depth + 2);
          continue;
        }
        const table = [...(outer ?? []), { paragraph: pi, control: ci, row, col }];
        out.push({ rect, kind: "cell", table });
        for (const c of grandchildren) walk(c, table, false, depth + 2);
      }
      return;
    }
    if (type === "Rect" && bbox !== undefined && children.some((c) => isRecord(c) && c["type"] === "TextBox")) {
      // 글상자: 칸 밖(본문) 글상자만 식별한다
      const shape = !unknown && outer === undefined ? shapes.find((s) => !s.inCell && close(s.rect, bbox)) : undefined;
      const container: Container = { rect: bbox, kind: "textbox" };
      if (shape !== undefined && boxTextMatches(source.runs, bbox, shape.paraIdx, shape.controlIdx)) {
        container.id = { parentPara: shape.paraIdx, steps: [{ controlIndex: shape.controlIdx, cellIndex: 0, cellParaIndex: 0 }] };
      }
      out.push(container);
      // 글상자 안의 표·글상자는 식별하지 않는다
      for (const c of children) walk(c, undefined, true, depth + 1);
      return;
    }
    for (const c of children) walk(c, outer, unknown, depth + 1);
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
  /** 식별한 표 칸. `table`은 렌더 트리의 표 경로(마지막이 이 칸), `rect`는 칸 사각형 */
  | { kind: "cell"; rect: Rect; table: TableStep[] }
  | { kind: "textbox"; id: ContainerId };

/** 점 `(x, y)`를 담은 가장 안쪽 칸·글상자. 후보 가운데 가장 작은 것이 나머지 모두 안에 들어 있어야 한다. */
export function containerAt(containers: readonly Container[], x: number, y: number): ContainerHit {
  const around = containers.filter((c) => x >= c.rect.x && x <= c.rect.x + c.rect.w && y >= c.rect.y && y <= c.rect.y + c.rect.h);
  if (around.length === 0) return { kind: "none" };
  let inner = around[0] as Container;
  for (const c of around) if (area(c.rect) < area(inner.rect)) inner = c;
  if (!around.every((c) => holds(c.rect, inner.rect))) return { kind: "unknown" };
  if (inner.kind === "cell") return inner.table === undefined ? { kind: "unknown" } : { kind: "cell", rect: inner.rect, table: inner.table };
  return inner.id === undefined ? { kind: "unknown" } : { kind: "textbox", id: inner.id };
}

/** 런이 글상자 `id`에 속하는가: 같은 부모 문단, 같은 깊이, 단계마다 컨트롤·칸 색인이 같고 바깥 단계는 칸 안 문단 번호도 같다. */
export function runInContainer(run: LayoutRun, id: ContainerId): boolean {
  const path = run.cellPath;
  if (path === undefined || run.parentParaIdx !== id.parentPara || path.length !== id.steps.length) return false;
  return id.steps.every((s, i) => {
    const p = path[i];
    return p !== undefined && p.controlIndex === s.controlIndex && p.cellIndex === s.cellIndex && (i === id.steps.length - 1 || p.cellParaIndex === s.cellParaIndex);
  });
}

/**
 * 표 경로 `table`의 칸 안(칸 안 문단과 그 안의 안쪽 표·글상자)에 속한 런들: 문서 좌표가 있고, 같은 최상위 문단이며, 칸 경로가 `table`만큼은 단계마다 표 컨트롤 번호가 같고
 * 바깥 단계의 칸 안 문단 번호가 안쪽 표를 담은 문단 번호(`paragraph`)와 같고(표 캡션 런은 아니다), 런의 왼쪽 끝이 칸 사각형 `rect` 안에 드는 것. 칸 색인은 보지 않는다
 * (rhwp의 칸 번호는 표에 따라 행·열과 어긋나므로 칸은 사각형으로 가리고, 서버가 행·열로 맞대어 본다). 칸 경로가 `table`보다 긴 런은 이 칸의 문단 안 안쪽 표·글상자의 글이다:
 * 칸에 안쪽 표만 보이는 쪽(칸이 쪽을 넘어 이어질 때)에서 그 표를 담은 문단이 칸의 줄이다.
 * 칸 위에 떠 있는 글상자의 글은 컨트롤 번호가 달라 들지 않는다. 오른쪽 가장자리 1.5픽셀 안에서 시작하는 런도 뺀다(이웃 칸의 글이 자기 칸 왼쪽 가장자리보다 1픽셀 왼쪽에서 시작하는 것이 관측됐다).
 */
export function runsInCell(runs: readonly LayoutRun[], table: readonly TableStep[], rect: Rect): LayoutRun[] {
  return runs.filter((run) => {
    const path = run.cellPath;
    if (!hasDocCoords(run) || path === undefined || run.parentParaIdx !== table[0]?.paragraph || path.length < table.length) return false;
    if (path[table.length - 1]?.cellIndex === TABLE_CAPTION_CELL) return false;
    return table.every((s, i) => path[i]?.controlIndex === s.control && (i === table.length - 1 || path[i]?.cellParaIndex === table[i + 1]?.paragraph)) && leftInside(run, { ...rect, w: rect.w - 1.5 });
  });
}
