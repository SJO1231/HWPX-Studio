import { HwpDocument } from "@rhwp/core";
import { REASONS, TABLE_CAPTION_CELL, type CellStep, type RhwpPosition, type Shown } from "../map/types.ts";
import { toViewerError, ViewerError } from "./errors.ts";
import { buildContainers, containerAt, runInContainer, type ApiCell, type Container } from "./containers.ts";
import { hasDocCoords, insideAny, regionBoxes, runPosition, type LayoutRun, type PageLayout, type RegionBoxes } from "./layout.ts";
import { requireLoaded } from "./load.ts";
import { classifyPoint, nearestLineRun, nearestRunOf } from "./pick.ts";

export type Area = { x: number; y: number; width: number; height: number };

/** `getPageInfo`의 항목 가운데 뷰어가 쓰는 것(쪽 크기는 96 DPI 픽셀) */
export type PageInfo = {
  pageIndex: number;
  width: number;
  height: number;
  sectionIndex: number;
  headerArea: Area;
  footerArea: Area;
};

/** `masterpage`: 바탕쪽 글 위(rhwp가 본문 문단 번호처럼 보이는 좌표를 붙여 두므로 본문과 가려 보고한다). `object`: 표 셀 안의 그림처럼 글자 위치가 아니라 개체를 가리키는 결과(rhwp가 다른 꼴로 준다). 문서 위치는 주지 않는다. */
export type HitRegion = "body" | "cell" | "textbox" | "header" | "footer" | "footnote" | "masterpage" | "object";

export type Hit = {
  region: HitRegion;
  /** 본문·표 셀·글상자에서만 있다. 머리말·꼬리말·각주는 영역만 알려 주고 문서 위치는 주지 않는다(본문 위치로 잘못 나가지 않게) */
  position?: RhwpPosition;
};

/** 눌린 자리가 줄 수 있는 가장 높은 정밀도. `char`: 서버가 글을 확인하면 글자까지, `paragraph`: 문단까지만, `none`: 위치를 내지 않는다(영역만 또는 사유만). */
export type PickLimit = "char" | "paragraph" | "none";

/**
 * 눌린 점 하나의 해석. 글자 위치는 `hitTest`가 아니라 점 아래에 그려진 런에서 얻는다(`pick`).
 * - `limit: "char"`: `hit.position`은 그 런의 문서 좌표에 눌린 자리의 런 안 경계를 더한 위치이고, `shown`은 그 런(글과 첫 글자 순번)이다.
 * - `limit: "paragraph"`: 문단까지만 믿는다(`reason`: 빈 곳은 `NEAREST_LINE`, 같은 문단의 런이 겹치면 `OVERLAPPING_RUNS`).
 * - `limit: "none"`: 위치를 내지 않는다. `reason`이 있으면 `OVERLAPPING_RUNS`(다른 문단의 런이 겹침)·`UNPOSITIONED_TEXT`(문서 좌표 없이 그려진 글)·`NEAREST_UNCONFIRMED`이고,
 *   없으면 머리말·꼬리말·각주·바탕쪽·개체처럼 영역만 알리는 경우다.
 */
export type Pick = {
  hit: Hit;
  shown?: Shown;
  /** 문서 좌표 없이 그려진 안내문 글을 눌렀다(안내문 상태 누름틀 후보). `shown`은 그 자리의 빈 런, `guideText`는 눌린 글 */
  guide: boolean;
  guideText?: string;
  /** 눌린 글자 자신의 rhwp 순번(런의 첫 글자 순번 + 런 안 글자 순번). 강조 표시용. `limit: "char"`일 때만 있다 */
  glyph?: number;
  /** 글자 사각형의 뒤쪽 절반을 눌러 캐럿이 글자 뒤에 놓였다(`position`은 눌린 글자 다음 경계). 서버가 안내문 상태 누름틀 바로 앞 경계를 옮길 때 쓴다 */
  trailing?: boolean;
  limit: PickLimit;
  reason?: string;
};

export type ViewerDocument = {
  pageCount(): number;
  pageInfo(page: number): PageInfo;
  /** 쪽 SVG(width·height·viewBox는 96 DPI 픽셀) */
  pageSvg(page: number): string;
  /** 쪽 글자 배치. rhwp가 부를 때마다 다시 계산하므로 쪽마다 한 번 받아 보관한다. */
  pageLayout(page: number): PageLayout;
  /**
   * 쪽 좌표(원점 쪽 왼쪽 위, 96 DPI 픽셀)가 가리키는 자리.
   * 머리말·꼬리말·각주는 `hitTest`가 본문으로 폴백하므로 전용 함수(`hitTestHeaderFooter`, `hitTestFootnote`)를 먼저 부른다.
   * (`hitTestInFootnote`는 영역 판별이 아니라 각주가 있는 쪽의 어느 점에서나 가장 가까운 각주 글을 준다.)
   */
  hit(page: number, x: number, y: number): Hit;
  /**
   * 쪽 좌표가 가리키는 글자 자리. 점 아래에 그려진 글자의 런에서 위치를 얻고(`hitTest`의 글자 순번은 쓰지 않는다),
   * 글자가 없는 곳(빈 곳)만 `hitTest`의 가장 가까운 줄을 문단 단위로 쓴다. 영역은 점 아래의 런을 먼저 보고 영역 판별 함수는 런이 없을 때만 부른다.
   */
  pick(page: number, x: number, y: number): Pick;
  /** rhwp 문서 객체(오라클·진단용). 호출한 쪽이 `free()` 뒤에 쓰지 않아야 한다. */
  native: HwpDocument;
  free(): void;
};

function parse(json: string, what: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new ViewerError("VIEWER_JSON", `rhwp의 ${what} 결과가 JSON이 아닙니다.`);
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const area = (v: unknown): Area => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { x: num(o["x"]) ?? 0, y: num(o["y"]) ?? 0, width: num(o["width"]) ?? 0, height: num(o["height"]) ?? 0 };
};

/** `cellPath`의 한 단계. 객체 꼴 `{controlIndex, cellIndex, cellParaIndex}`만 받는다(개체를 가리키는 결과는 `[a, b, c]` 배열 꼴로 온다). */
function stepOf(v: unknown): CellStep | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const controlIndex = num(o["controlIndex"]);
  const cellIndex = num(o["cellIndex"]);
  const cellParaIndex = num(o["cellParaIndex"]);
  return controlIndex === undefined || cellIndex === undefined || cellParaIndex === undefined ? undefined : { controlIndex, cellIndex, cellParaIndex };
}

/** `hitTest` 결과에서 글자 위치를 꺼낸다. 꼴이 맞지 않으면(개체를 가리키는 결과 등) undefined. */
function positionOf(raw: Record<string, unknown>): RhwpPosition | undefined {
  const sectionIndex = num(raw["sectionIndex"]);
  const paragraphIndex = num(raw["paragraphIndex"]);
  const charOffset = num(raw["charOffset"]);
  if (sectionIndex === undefined || paragraphIndex === undefined || charOffset === undefined || raw["innerControlIdx"] !== undefined) return undefined;
  const pos: RhwpPosition = { sectionIndex, paragraphIndex, charOffset };
  const path = raw["cellPath"];
  if (path !== undefined) {
    const steps = Array.isArray(path) ? path.map(stepOf) : [];
    const parent = num(raw["parentParaIndex"]);
    if (steps.length === 0 || parent === undefined || steps.some((x) => x === undefined)) return undefined;
    pos.parentParaIndex = parent;
    pos.cellPath = steps as CellStep[];
  }
  return pos;
}

/** 문서 바이트를 rhwp로 연다. 열지 못하면 `ViewerError`(`VIEWER_OPEN_<rhwp 코드>`). */
export function openDocument(bytes: Uint8Array): ViewerDocument {
  requireLoaded();
  if (!(bytes instanceof Uint8Array)) throw new ViewerError("VIEWER_BAD_INPUT", "문서는 Uint8Array로만 열 수 있습니다(ArrayBuffer는 빈 파일 오류가 난다).");
  let doc: HwpDocument;
  try {
    doc = new HwpDocument(bytes);
  } catch (e) {
    throw toViewerError(e, "VIEWER_OPEN");
  }
  let freed = false;
  const layouts = new Map<number, PageLayout>();
  const boxes = new Map<number, RegionBoxes>();
  const trees = new Map<number, unknown>();
  const containerLists = new Map<number, Container[]>();
  const call = <T>(f: () => T): T => {
    if (freed) throw new ViewerError("VIEWER_CLOSED", "이미 닫은 문서입니다.");
    try {
      return f();
    } catch (e) {
      throw toViewerError(e, "VIEWER_RHWP_CALL");
    }
  };
  const count = call(() => doc.pageCount());
  const sections = new Map<number, number>();
  const pageSection = (page: number): number => {
    let s = sections.get(page);
    if (s === undefined) {
      s = num((parse(call(() => doc.getPageInfo(page)), "쪽 정보") as Record<string, unknown>)["sectionIndex"]) ?? 0;
      sections.set(page, s);
    }
    return s;
  };
  const checkPage = (page: number): void => {
    if (!Number.isInteger(page) || page < 0 || page >= count) throw new ViewerError("VIEWER_PAGE_RANGE", `쪽 ${page}이(가) 없습니다(쪽 수 ${count}).`);
  };

  const layoutOf = (page: number): PageLayout => {
    let layout = layouts.get(page);
    if (layout === undefined) {
      const o = parse(call(() => doc.getPageTextLayout(page)), "쪽 글자 배치") as { runs?: PageLayout["runs"] };
      layout = { runs: Array.isArray(o.runs) ? o.runs : [] };
      // rhwp는 표 캡션 런의 구역 번호를 항상 0으로 낸다(0번 구역 밖의 표 캡션에서 관측). 쪽은 한 구역에 속하므로 쪽의 구역으로 바로잡는다.
      const sec = pageSection(page);
      for (const run of layout.runs) if (run.cellPath?.some((s) => s.cellIndex === TABLE_CAPTION_CELL) === true) run.secIdx = sec;
      layouts.set(page, layout);
    }
    return layout;
  };
  /**
   * 머리말·꼬리말·각주 본문 글 위의 점이 어느 영역인지(그 글이 있으므로 머리말·꼬리말이 실제로 있다).
   * 글이 영역 밖으로 넘쳐 영역 판별 함수가 못 잡으면 렌더 트리의 영역별 글 사각형으로 가린다.
   */
  const markerRegion = (page: number, x: number, y: number): HitRegion | undefined => {
    const hf = parse(call(() => doc.hitTestHeaderFooter(page, x, y)), "머리말·꼬리말 위치") as { hit?: boolean; isHeader?: boolean };
    if (hf.hit === true) return hf.isHeader === true ? "header" : "footer";
    const fn = parse(call(() => doc.hitTestFootnote(page, x, y)), "각주 영역") as { hit?: boolean };
    return fn.hit === true ? "footnote" : outsideBody(page, x, y);
  };
  /** 위의 `markerRegion`을 점에서, 못 정하면 그 글 런 자신의 사각형 한가운데에서 다시 본다(런의 글자 경계가 사각형 밖까지 뻗은 런이 있다). */
  const markerRegionOf = (page: number, run: LayoutRun, x: number, y: number): HitRegion | undefined =>
    markerRegion(page, x, y) ?? markerRegion(page, run.x + run.w / 2, run.y + run.h / 2);
  /**
   * 영역 판별 함수로 본 머리말·꼬리말·각주 영역. 머리말·꼬리말 영역은 비어 있어도(머리말이 없어도) hit로 나오고 본문과 겹칠 수 있으므로,
   * 실제로 머리말·꼬리말이 있을 때만 영역으로 본다.
   */
  const footerRegion = (page: number, x: number, y: number): HitRegion | undefined => {
    const hf = parse(call(() => doc.hitTestHeaderFooter(page, x, y)), "머리말·꼬리말 위치") as { hit?: boolean; isHeader?: boolean; sectionIndex?: number; applyTo?: number };
    if (hf.hit === true) {
      const exists = parse(call(() => doc.getHeaderFooter(hf.sectionIndex ?? 0, hf.isHeader === true, hf.applyTo ?? 0)), "머리말·꼬리말") as { exists?: boolean };
      if (exists.exists === true) return hf.isHeader === true ? "header" : "footer";
    }
    const fn = parse(call(() => doc.hitTestFootnote(page, x, y)), "각주 영역") as { hit?: boolean };
    return fn.hit === true ? "footnote" : undefined;
  };
  /**
   * 점 아래에 그려진 글이 본문이 아닌 영역(바탕쪽·머리말·꼬리말·각주)의 글인가(렌더 트리의 영역별 글 사각형으로 가린다). 본문 글 위면 undefined다.
   * rhwp는 바탕쪽 글과 머리말·꼬리말 안 표 칸의 글에도 본문 문단·표 칸 같은 문서 좌표를 붙이므로, 글자 위치만으로는 본문과 가를 수 없다.
   */
  const outsideBody = (page: number, x: number, y: number): HitRegion | undefined => {
    let region = boxes.get(page);
    if (region === undefined) {
      region = regionBoxes(treeOf(page));
      boxes.set(page, region);
    }
    if (insideAny(region.body, x, y)) return undefined;
    if (insideAny(region.header, x, y)) return "header";
    if (insideAny(region.footer, x, y)) return "footer";
    if (insideAny(region.footnote, x, y)) return "footnote";
    if (insideAny(region.master, x, y)) return "masterpage";
    return undefined;
  };

  const treeOf = (page: number): unknown => {
    let tree = trees.get(page);
    if (tree === undefined) {
      tree = parse(call(() => doc.getPageRenderTree(page)), "쪽 렌더 트리");
      trees.set(page, tree);
    }
    return tree;
  };
  /** 쪽 위의 칸·글상자 사각형과 그 문단 위치(`containers.ts`). 표 칸 식별은 rhwp의 표 경로 칸 사각형 응답과 맞대어 본다. */
  const containersOf = (page: number): Container[] => {
    let list = containerLists.get(page);
    if (list === undefined) {
      const section = pageSection(page);
      list = buildContainers(treeOf(page), {
        controls: parse(call(() => doc.getPageControlLayout(page)), "쪽 컨트롤 배치"),
        runs: layoutOf(page).runs,
        tableCells(parentPara, path) {
          const raw = parse(call(() => doc.getTableCellBboxesByPath(section, parentPara, JSON.stringify(path))), "표 칸 사각형");
          if (!Array.isArray(raw)) return undefined;
          const boxes = (raw as unknown[]).filter((c): c is ApiCell => typeof c === "object" && c !== null && typeof (c as ApiCell).cellIdx === "number");
          // 칸 사각형 응답의 `cellIdx`는 경로(`cellPath`)의 칸 색인과 다를 수 있다(병합 칸이 있는 표에서 1부터 시작하는 것이 관측됐다). 경로의 칸 색인은
          // 칸 정보 함수(`getCellInfoByPath`)가 같은 색인에 주는 행·열로 직접 잇는다: 색인 0, 1, 2…의 행·열을 읽어 사각형 응답의 행·열과 맞춘다.
          const last = path[path.length - 1];
          if (last === undefined) return undefined;
          const byPosition = new Map<string, number>();
          for (let k = 0; k <= boxes.length + 8; k++) {
            let info: unknown;
            try {
              info = parse(call(() => doc.getCellInfoByPath(section, parentPara, JSON.stringify([...path.slice(0, -1), { controlIndex: last.controlIndex, cellIndex: k, cellParaIndex: 0 }]))), "칸 정보");
            } catch {
              break;
            }
            const row = (info as { row?: unknown }).row;
            const col = (info as { col?: unknown }).col;
            if (typeof row === "number" && typeof col === "number") byPosition.set(`${row}:${col}`, k);
          }
          const out: ApiCell[] = [];
          for (const b of boxes) {
            const k = byPosition.get(`${b.row}:${b.col}`);
            if (k !== undefined) out.push({ ...b, cellIdx: k });
          }
          return out;
        },
      });
      containerLists.set(page, list);
    }
    return list;
  };

  const hitAt = (page: number, x: number, y: number): Hit => {
    // 영역은 점 아래의 런을 먼저 본다. 머리말·꼬리말·각주 영역 판별은 본문 표 칸이 머리말 높이와 겹쳐도 영역으로 나오므로(본문 글자를 눌러도 header),
    // 본문 문서 좌표 런 위에서는 부르지 않는다.
    const under = classifyPoint(layoutOf(page), x, y);
    if (under.kind === "marker") {
      const region = markerRegionOf(page, under.run, x, y);
      if (region !== undefined) return { region };
    }
    const onBody = under.kind === "glyph" || (under.kind === "overlap" && !under.marker && under.first !== undefined);
    if (!onBody) {
      const region = footerRegion(page, x, y);
      if (region !== undefined) return { region };
    }
    // 문서 좌표가 있는 글이라도 바탕쪽·머리말·꼬리말·각주 안의 글이면 그 영역이다(본문 좌표와 겹쳐 보인다)
    const outside = outsideBody(page, x, y);
    if (outside !== undefined && (onBody || outside === "masterpage")) return { region: outside };
    const raw = parse(call(() => doc.hitTest(page, x, y)), "위치") as Record<string, unknown>;
    const position = positionOf(raw);
    if (position === undefined) return { region: "object" };
    if (position.cellPath?.some((s) => s.cellIndex === TABLE_CAPTION_CELL) === true) position.sectionIndex = pageSection(page);
    const kind: HitRegion = position.cellPath === undefined ? "body" : raw["isTextBox"] === true ? "textbox" : "cell";
    return { region: kind, position };
  };

  return {
    pageCount: () => count,
    pageInfo(page) {
      checkPage(page);
      const o = parse(call(() => doc.getPageInfo(page)), "쪽 정보") as Record<string, unknown>;
      return {
        pageIndex: num(o["pageIndex"]) ?? page,
        width: num(o["width"]) ?? 0,
        height: num(o["height"]) ?? 0,
        sectionIndex: num(o["sectionIndex"]) ?? 0,
        headerArea: area(o["headerArea"]),
        footerArea: area(o["footerArea"]),
      };
    },
    pageSvg(page) {
      checkPage(page);
      return call(() => doc.renderPageSvg(page));
    },
    pageLayout(page) {
      checkPage(page);
      return layoutOf(page);
    },
    hit(page, x, y) {
      checkPage(page);
      return hitAt(page, x, y);
    },
    pick(page, x, y) {
      checkPage(page);
      const layout = layoutOf(page);
      const under = classifyPoint(layout, x, y);
      const none = (region: HitRegion, reason?: string): Pick => ({ hit: { region }, guide: false, limit: "none", ...(reason === undefined ? {} : { reason }) });
      const where = (): HitRegion => footerRegion(page, x, y) ?? "body";
      switch (under.kind) {
        case "marker":
          return none(markerRegionOf(page, under.run, x, y) ?? hitAt(page, x, y).region);
        case "overlap": {
          if (under.marker) return none(markerRegion(page, x, y) ?? where(), REASONS.overlappingRuns);
          const first = under.first;
          const start = first === undefined ? undefined : runPosition(first.run);
          if (first === undefined || start === undefined) return none(where(), REASONS.overlappingRuns);
          const outside = outsideBody(page, x, y);
          if (outside !== undefined) return none(outside);
          const region: HitRegion = start.cellPath === undefined ? "body" : "cell";
          if (!under.sameParagraph) return none(region, REASONS.overlappingRuns);
          return { hit: { region, position: start }, shown: { text: first.run.text, start: start.charOffset }, guide: false, limit: "paragraph", reason: REASONS.overlappingRuns };
        }
        case "unpositioned": {
          const empty = under.empty === undefined ? undefined : runPosition(under.empty);
          if (empty === undefined) return none(where(), REASONS.unpositionedText);
          const outside = outsideBody(page, x, y);
          if (outside !== undefined) return none(outside, REASONS.unpositionedText);
          const region: HitRegion = empty.cellPath === undefined ? "body" : "cell";
          return { hit: { region, position: empty }, shown: { text: "", start: empty.charOffset }, guide: true, guideText: under.run.text, limit: "char" };
        }
        case "glyph": {
          const outside = outsideBody(page, x, y);
          if (outside !== undefined) return none(outside);
          const start = runPosition(under.run);
          if (start === undefined) return none(where());
          const position: RhwpPosition = { ...start, charOffset: start.charOffset + under.caret };
          const region: HitRegion = start.cellPath === undefined ? "body" : "cell";
          const pick: Pick = { hit: { region, position }, shown: { text: under.run.text, start: start.charOffset }, guide: false, glyph: start.charOffset + under.glyph, limit: "char" };
          if (under.caret > under.glyph) pick.trailing = true;
          return pick;
        }
        case "blank": {
          // 글자가 없는 곳: rhwp가 가리킨 가장 가까운 줄의 문단을, 점에서 가장 가까운 런이 그 문단의 것일 때만 문단 단위로 쓴다
          const near = hitAt(page, x, y);
          if (near.position === undefined) return none(near.region);
          // 점을 담은 가장 안쪽 칸·글상자를 먼저 찾는다. 칸·글상자 안이면 줄 후보는 그 칸에 속한 런뿐이고(`hitTest`와 달라도 소속으로 확정한다),
          // 칸 밖이면 본문 런뿐이다(이때만 `hitTest`가 가리킨 문단과 같은지 확인한다). 어느 칸인지 정할 수 없으면 옮기지 않는다.
          const where = containerAt(containersOf(page), x, y);
          if (where.kind === "unknown") return none(near.region, REASONS.nearestUnconfirmed);
          if (where.kind === "in") {
            const id = where.container.id;
            const inside = nearestLineRun({ runs: layout.runs.filter((r) => hasDocCoords(r) && runInContainer(r, id)) }, x, y);
            const first = inside === undefined ? undefined : runPosition(inside);
            const region: HitRegion = where.container.kind === "textbox" ? "textbox" : "cell";
            if (inside === undefined || first === undefined) return none(region, REASONS.nearestUnconfirmed);
            return { hit: { region, position: first }, shown: { text: inside.text, start: first.charOffset }, guide: false, limit: "paragraph", reason: REASONS.nearestLine };
          }
          const run = nearestRunOf({ runs: layout.runs.filter((r) => r.cellPath === undefined) }, near.position, x, y);
          const start = run === undefined ? undefined : runPosition(run);
          if (run === undefined || start === undefined) return none(near.region, REASONS.nearestUnconfirmed);
          return { hit: { region: near.region, position: { ...near.position, charOffset: start.charOffset } }, shown: { text: run.text, start: start.charOffset }, guide: false, limit: "paragraph", reason: REASONS.nearestLine };
        }
      }
    },
    native: doc,
    free() {
      if (!freed) {
        freed = true;
        layouts.clear();
        boxes.clear();
        trees.clear();
        containerLists.clear();
        doc.free();
      }
    },
  };
}
