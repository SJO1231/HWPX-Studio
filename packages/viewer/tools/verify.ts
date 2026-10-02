// 전수 대조(V2), 클릭 경로 대조(눌린 점 → 엔진 주소), 시간 측정(V8)의 공용 구현. 시험(`test/`)과 실제 문서 대조 도구(`crosscheck.ts`)가 같이 쓴다.
// 결과에는 문서 이름·글 내용을 넣지 않는다(수량과 사유 코드, 컨트롤 종류 이름만).
import { draftAnchors, generate, openPackage, parseDocument, readDataset, readTemplate, type HwpxDocument, type ParagraphNode } from "../../hwpx-engine/src/index.ts";
import { guideFields } from "../src/map/guides.ts";
import { controlSlots, locateInCell, locatePicked, offsetTable, paragraphAtAddress, toEngineAddress, toRhwpPosition, type EngineAddress, type Located, type PickedPoint, type RhwpPosition, type Unlocated } from "../src/map/index.ts";
import { hasDocCoords, isMarkerRun, MARKER_PARA_MIN, regionBoxes, runLength, runPosition, sameParagraph, openDocument, type LayoutRun, type Pick, type Rect, type ViewerDocument } from "../src/rhwp/index.ts";

export type RunClass = "body" | "cell" | "nested" | "textbox" | "caption";
export const RUN_CLASSES: RunClass[] = ["body", "cell", "nested", "textbox", "caption"];

export type ClassStats = { runs: number; char: number; paragraph: number; none: number; silent: number };

export type DocReport = {
  engine: { ok: boolean; code?: string };
  rhwp: { ok: boolean; code?: string };
  pages: number;
  /**
   * total: 쪽 글자 배치의 런 전부. noCoords: 문서 좌표가 없는 런(번호·글머리표·안내문), marker: 표지값 문단 번호의 런(머리말·꼬리말·각주 본문).
   * checked: 문서 좌표가 있는 런. 그 가운데 엔진 주소로 옮기지 못한 것을 rhwp의 영역 판별로 가려낸 수: headerFooter(머리말·꼬리말 영역),
   * footnote(각주 영역), masterPage(바탕쪽 글 위), outside(본문 문단 수를 넘는 번호 = 미주 등), unreachable(런 한가운데를 눌러도 그 문단이 나오지 않는 글 = 바탕쪽·배경 등). label(문단 번호·글머리표 글의 런: 문단모양에 번호가 있고 런이 문단 처음에서 시작하나 글이 문단 글에 없다)까지 이 여섯은 본문 계열 통계(classes)에서 뺀다. empty: 빈 글 런(checked에 포함). shifted: `char`로 옮겼지만 rhwp가 런의 첫 글자 순번을 개체 수를 덜 센 값으로 낸 런(classes의 char에 포함).
   */
  runs: { total: number; checked: number; noCoords: number; marker: number; empty: number; headerFooter: number; footnote: number; masterPage: number; outside: number; unreachable: number; label: number; shifted: number };
  classes: Record<RunClass, ClassStats>;
  /** `paragraph`·`none`으로 내려간 사유별 수량. 키는 `사유` 또는 `사유|문단의 컨트롤 종류들` */
  reasons: Record<string, number>;
  /** 조용한 불일치 사유별 수량 */
  silentKinds: Record<string, number>;
  oracle: {
    paragraphs: number;
    textBad: number;
    ctrlParagraphs: number;
    /** 컨트롤 개수가 rhwp와 다른 문단(색인 규칙 위반) */
    ctrlBad: number;
    /** 개수는 같고 위치 목록만 다른 문단(참고용. rhwp의 위치 목록이 개체가 이어진 문단에서 어긋난다) */
    ctrlPosDiffer: number;
    tables: number;
    tablesBad: number;
    cellLists: number;
    cellListsBad: number;
    /** rhwp의 경로 API가 받지 않는 경로(캡션 `cellIndex` 65534, 묶음 개체 안 글상자)라 대조하지 못한 수 */
    skipped: number;
    errors: number;
  };
  /** 오라클이 어긋난 문단의 컨트롤 종류 조합별 수량(원인 분석용) */
  oracleKinds: Record<string, number>;
  ms: { rhwpOpen: number; engineOpen: number; layout: number; check: number };
};

export const emptyClassStats = (): ClassStats => ({ runs: 0, char: 0, paragraph: 0, none: 0, silent: 0 });

function emptyReport(): DocReport {
  return {
    engine: { ok: false },
    rhwp: { ok: false },
    pages: 0,
    runs: { total: 0, checked: 0, noCoords: 0, marker: 0, empty: 0, headerFooter: 0, footnote: 0, masterPage: 0, outside: 0, unreachable: 0, label: 0, shifted: 0 },
    classes: { body: emptyClassStats(), cell: emptyClassStats(), nested: emptyClassStats(), textbox: emptyClassStats(), caption: emptyClassStats() },
    reasons: {},
    silentKinds: {},
    oracle: { paragraphs: 0, textBad: 0, ctrlParagraphs: 0, ctrlBad: 0, ctrlPosDiffer: 0, tables: 0, tablesBad: 0, cellLists: 0, cellListsBad: 0, skipped: 0, errors: 0 },
    oracleKinds: {},
    ms: { rhwpOpen: 0, engineOpen: 0, layout: 0, check: 0 },
  };
}

const bump = (m: Record<string, number>, key: string, by = 1): void => {
  m[key] = (m[key] ?? 0) + by;
};
const codeOf = (e: unknown): string => (e !== null && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : "UNKNOWN");

/** 엔진 모델에서 주소가 가리키는 문단. */
export const paragraphAt = paragraphAtAddress;

const kindsOf = (p: ParagraphNode | undefined): string =>
  p === undefined
    ? ""
    : [...new Set(controlSlots(p).map((s) => (s.known ? s.kind : `?${s.kind}`) + (s.width === 1 ? "(1)" : "")))]
        .filter((k) => k !== "secPr" && k !== "colPr")
        .sort()
        .join(",");

/**
 * 오프셋 대응표를 쓰지 않고 엔진 문단의 논리 텍스트를 직접 읽어, 주소에서 시작하는 `n`개 글자를 돌려준다.
 * 객체 자리 글자(U+FFFC)는 건너뛰고(자동 번호는 rhwp가 공백으로 그리므로 공백으로 바꾼다), 칸이 없는 글만 센다.
 */
export function engineTextAt(paragraph: ParagraphNode, offset: number, n: number): string {
  return engineGlyphs(paragraph)
    .filter((g) => g.start >= offset)
    .slice(0, n)
    .map((g) => g.glyph)
    .join("");
}

/**
 * 엔진 문단의 논리 텍스트를 직접 읽어, rhwp가 한 글자로 그리는 글자(대응표를 쓰지 않는다)를 `[start, end)`(UTF-16 오프셋)와 함께 순서대로 돌려준다.
 * 객체 자리 글자(U+FFFC)와 안내문 상태 누름틀의 안내문 글은 건너뛰고, 자동 번호는 공백 한 글자로 센다.
 */
export function engineGlyphs(paragraph: ParagraphNode): { start: number; end: number; glyph: string }[] {
  const cached = glyphCache.get(paragraph);
  if (cached !== undefined) return cached;
  const text = paragraph.logicalText;
  const objectAt = new Map<number, boolean>();
  paragraph.pieces.forEach((piece) => {
    if (piece.kind === "object") objectAt.set(piece.logicalStart, false);
  });
  for (const slot of controlSlots(paragraph)) {
    const piece = paragraph.pieces[slot.host.pieceIndex];
    if (piece !== undefined && slot.kind === "autoNum") objectAt.set(piece.logicalStart, true);
  }
  const guides = guideFields(paragraph);
  const out: { start: number; end: number; glyph: string }[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (guides.some((g) => i >= g.logicalStart && i < g.logicalEnd)) {
      // 안내문 상태 누름틀의 안내문 글은 rhwp의 문단 글에 없다
    } else if (objectAt.has(i)) {
      if (objectAt.get(i) === true) out.push({ start: i, end: i + ch.length, glyph: " " });
    } else {
      out.push({ start: i, end: i + ch.length, glyph: ch });
    }
    i += ch.length;
  }
  glyphCache.set(paragraph, out);
  return out;
}

const glyphCache = new WeakMap<ParagraphNode, { start: number; end: number; glyph: string }[]>();

/** 쪽 글자 배치의 런 가운데 문서 좌표가 있는 것을 엔진 주소로 옮겨 본 결과 */
export type RunCheck = {
  run: LayoutRun;
  pos: RhwpPosition;
  located: Located | Unlocated;
  klass: RunClass;
};

export function classOf(located: Located | Unlocated, pos: RhwpPosition): RunClass {
  const trail = located.trail;
  if (trail.some((k) => k.endsWith(":caption"))) return "caption";
  if (trail.length > 0) {
    const last = trail[trail.length - 1] ?? "";
    if (last !== "tbl") return "textbox";
    return trail.length === 1 ? "cell" : "nested";
  }
  const depth = pos.cellPath?.length ?? 0;
  if (pos.cellPath?.some((x) => x.cellIndex === 65534) === true) return "caption";
  return depth === 0 ? "body" : depth === 1 ? "cell" : "nested";
}

/** 런 하나를 엔진 주소로 옮긴다(첫 글자 위치, 런의 글로 확인). */
export function locateRun(doc: HwpxDocument, run: LayoutRun): RunCheck | undefined {
  const pos = runPosition(run);
  if (pos === undefined) return undefined;
  const located = toEngineAddress(doc, pos, { text: run.text, start: pos.charOffset });
  return { run, pos, located, klass: classOf(located, pos) };
}

const parseJson = (s: string): unknown => JSON.parse(s);

export function regionOf(rdoc: ViewerDocument, page: number, run: LayoutRun, pos: RhwpPosition, paraCounts: Map<number, number>): "headerFooter" | "footnote" | "masterPage" | "outside" | "unreachable" | undefined {
  {
    let n = paraCounts.get(pos.sectionIndex);
    if (n === undefined) {
      n = rdoc.native.getParagraphCount(pos.sectionIndex);
      paraCounts.set(pos.sectionIndex, n);
    }
    // 본문 문단 수를 넘는 번호(미주 등): 표 셀 안 글이면 그것을 담은 최상위 문단 번호로 본다
    if ((pos.cellPath === undefined ? pos.paragraphIndex : (pos.parentParaIndex ?? 0)) >= n) return "outside";
  }
  try {
    const hit = rdoc.hit(page, run.x + run.w / 2, run.y + run.h / 2);
    if (hit.region === "header" || hit.region === "footer") return "headerFooter";
    if (hit.region === "footnote") return "footnote";
    if (hit.region === "masterpage") return "masterPage";
    // 런의 한가운데를 눌러도 그 문단이 나오지 않으면 클릭으로 닿지 않는 글이다(바탕쪽·배경 등. rhwp가 본문 번호를 붙여 그려 낸다)
    if (hit.position === undefined || !sameParagraph(hit.position, pos)) return "unreachable";
  } catch {
    return undefined;
  }
  return undefined;
}

type Oracle = {
  paragraphText(pos: RhwpPosition): string | undefined;
};

function makeOracle(rdoc: ViewerDocument): Oracle {
  const native = rdoc.native;
  return {
    paragraphText(pos) {
      if (pos.cellPath === undefined) {
        const len = native.getParagraphLength(pos.sectionIndex, pos.paragraphIndex);
        return native.getTextRange(pos.sectionIndex, pos.paragraphIndex, 0, len);
      }
      const path = JSON.stringify(pos.cellPath);
      const len = native.getCellParagraphLengthByPath(pos.sectionIndex, pos.parentParaIndex ?? 0, path);
      return native.getTextInCellByPath(pos.sectionIndex, pos.parentParaIndex ?? 0, path, 0, len);
    },
  };
}

/** 엔진 쪽에서 rhwp의 문단 글(`getTextRange`)에 해당하는 글: 칸마다 rhwp가 그리는 글을 이은 것 */
export function projectedText(paragraph: ParagraphNode): string {
  return offsetTable(paragraph)
    .slots.map((s) => s.shown)
    .join("");
}

/** 엔진 논리 오프셋 `[from, to)` 사이에 객체 자리 글자(U+FFFC) 말고 다른 글자가 없는가. 오프셋이 거꾸로이면 거짓이다. */
export function objectsOnlyBetween(paragraph: ParagraphNode, from: number, to: number): boolean {
  return from <= to && [...paragraph.logicalText.slice(from, to)].every((c) => c === "\ufffc");
}

/** 엔진 문단의 컨트롤이 rhwp 글자 순번(글 글자 수 기준, 글자처럼 취급 개체 칸은 세지 않는다)으로 어디에 있는지 */
export function expectedControlPositions(paragraph: ParagraphNode): number[] {
  const slotsByPiece = new Map<number, number>();
  for (const s of controlSlots(paragraph)) slotsByPiece.set(s.host.pieceIndex, (slotsByPiece.get(s.host.pieceIndex) ?? 0) + 1);
  const autoNumPieces = new Set(controlSlots(paragraph).filter((s) => s.kind === "autoNum").map((s) => s.host.pieceIndex));
  const text = paragraph.logicalText;
  const guidePieces = new Set(guideFields(paragraph).flatMap((g) => g.textPieces));
  const out: number[] = [];
  let pos = 0;
  paragraph.pieces.forEach((piece, pi) => {
    if (guidePieces.has(pi)) return;
    if (piece.kind === "text" || piece.kind === "entity") {
      for (const _ of text.slice(piece.logicalStart, piece.logicalEnd)) pos++;
    } else if (piece.kind === "inline") {
      if (piece.logicalEnd > piece.logicalStart) pos++;
    } else {
      const n = slotsByPiece.get(pi) ?? 0;
      for (let i = 0; i < n; i++) out.push(pos);
      if (autoNumPieces.has(pi)) pos++;
    }
  });
  return out;
}

type Mark = { key: string; pos: RhwpPosition; address: EngineAddress; checkedChars: number; trail: string[] };

/**
 * 문서 하나를 연다. 엔진과 rhwp 모두로 열어 모든 쪽의 문서 좌표 있는 런을 엔진 주소로 옮기고 글을 대조한다(V2).
 * `oracles`를 켜면 rhwp 자신의 글·컨트롤 위치·표 크기와도 대조해 조용한 불일치를 찾는다.
 */
export function checkDocument(
  bytes: Uint8Array,
  options: { oracles?: boolean; onSilent?: (kind: string, page: number, run: LayoutRun, check: RunCheck, extra?: string) => void; onFailure?: (f: { page: number; run: LayoutRun; check: RunCheck; paragraph: ParagraphNode | undefined }) => void } = {},
): DocReport {
  const report = emptyReport();
  let doc: HwpxDocument | undefined;
  const t0 = performance.now();
  try {
    doc = parseDocument(openPackage(bytes));
    report.engine.ok = true;
  } catch (e) {
    report.engine.code = codeOf(e);
  }
  report.ms.engineOpen = performance.now() - t0;

  let rdoc: ViewerDocument | undefined;
  const t1 = performance.now();
  try {
    rdoc = openDocument(bytes);
    report.rhwp.ok = true;
  } catch (e) {
    report.rhwp.code = codeOf(e);
  }
  report.ms.rhwpOpen = performance.now() - t1;
  if (doc === undefined || rdoc === undefined) {
    rdoc?.free();
    return report;
  }

  try {
    report.pages = rdoc.pageCount();
    const oracle = options.oracles === true ? makeOracle(rdoc) : undefined;
    const seen = new Map<string, Mark & { hasChar: boolean }>();
    const paraCounts = new Map<number, number>();
    const regionCache = new Map<string, ReturnType<typeof regionOf>>();
    const tiling = new Map<string, number>();
    const duplicates = new Set<string>();
    const tablesChecked = new Set<string>();
    const listsChecked = new Set<string>();

    for (let page = 0; page < report.pages; page++) {
      const t2 = performance.now();
      const layout = rdoc.pageLayout(page);
      report.ms.layout += performance.now() - t2;
      const t3 = performance.now();
      for (const run of layout.runs) {
        report.runs.total++;
        if (!hasDocCoords(run)) {
          if (typeof run.paraIdx === "number" && run.paraIdx >= MARKER_PARA_MIN) report.runs.marker++;
          else report.runs.noCoords++;
          continue;
        }
        if (run.text === "") report.runs.empty++;
        report.runs.checked++;
        const check = locateRun(doc, run);
        if (check === undefined) continue;
        if (check.located.precision === "paragraph" && check.located.reason === "LABEL_RUN") {
          // 문단 번호·글머리표 글의 런: 문단 글이 아니다(문단은 맞다)
          report.runs.label++;
          continue;
        }
        if (check.located.precision !== "char") {
          // 본문이 아닌 영역의 런(머리말·꼬리말 안 표, 각주, 미주)은 문서 좌표가 본문과 겹쳐 보인다. rhwp의 영역 판별로 가려낸다
          // 같은 쪽의 같은 문단은 한 번만 판별한다(런마다 부르면 느리다)
          const rkey = `${page}|${check.pos.sectionIndex}|${check.pos.parentParaIndex ?? -1}|${check.pos.paragraphIndex}|${JSON.stringify(check.pos.cellPath ?? null)}`;
          let region = regionCache.get(rkey);
          if (!regionCache.has(rkey)) {
            region = regionOf(rdoc, page, run, check.pos, paraCounts);
            regionCache.set(rkey, region);
          }
          if (region !== undefined) {
            report.runs[region]++;
            continue;
          }
        }
        const stats = report.classes[check.klass];
        stats.runs++;
        const { located, pos } = check;
        if (located.precision === "none") {
          options.onFailure?.({ page, run, check, paragraph: undefined });
          stats.none++;
          bump(report.reasons, `${located.reason}`);
          continue;
        }
        const paragraph = paragraphAt(doc, located.address);
        if (located.precision === "paragraph") {
          options.onFailure?.({ page, run, check, paragraph });
          stats.paragraph++;
          bump(report.reasons, `${located.reason ?? "?"}|${kindsOf(paragraph)}`);
        } else {
          stats.char++;
          // 조용한 불일치 1: 대응표를 쓰지 않고 엔진 문단을 직접 읽은 글이 런의 글과 다르다
          const offset = located.address.offset ?? 0;
          const composeSlot = paragraph === undefined ? undefined : offsetTable(paragraph).slots[pos.charOffset];
          const composeRun = composeSlot?.private === true && (run.text === composeSlot.composeText || [...run.text].every((c) => (c.codePointAt(0) ?? 0) >= 0xe000));
          if (!composeRun && (paragraph === undefined || engineTextAt(paragraph, offset, runLength(run)) !== run.text)) {
            stats.silent++;
            bump(report.silentKinds, `DIRECT_TEXT|${kindsOf(paragraph)}`);
          }
        }
        // 왕복: 주소를 다시 rhwp 위치로 옮기면 원래 위치여야 한다. 다만 rhwp는 런의 첫 글자 순번을 개체 수를 덜 센 값으로 내기도 하므로(`confirm`의 설명),
        // 되돌린 칸 순번이 더 크고 그 칸의 글이 런의 첫 글자면 순번이 밀린 런으로 따로 센다.
        if (located.precision === "char") {
          const back = toRhwpPosition(doc, located.address);
          if (back === undefined || !sameParagraph(back, pos)) {
            stats.silent++;
            bump(report.silentKinds, "ROUND_TRIP");
          } else if (back.charOffset !== pos.charOffset) {
            const first = Array.from(run.text)[0];
            if (paragraph !== undefined && first !== undefined && back.charOffset > pos.charOffset && offsetTable(paragraph).slots[back.charOffset]?.shown === first) {
              report.runs.shifted++;
            } else {
              stats.silent++;
              bump(report.silentKinds, "ROUND_TRIP");
            }
          }
        }
        const key = JSON.stringify([pos.sectionIndex, pos.parentParaIndex ?? -1, pos.paragraphIndex, pos.cellPath ?? []]);
        // 조용한 불일치 3(타일링): 같은 쪽 같은 문단의 런은 쪽 글자 배치 순서대로 엔진 글에서 겹치지 않고 앞에서 뒤로 놓여야 한다.
        // 런을 엔진 글자에 맞추는 규칙이 틀린 자리를 고르면 이 순서가 깨진다(글꼴·개체로 순번이 어긋난 문단에서 같은 글이 되풀이될 때를 잡는다).
        if (located.precision === "char" && run.text !== "") {
          const isCompose = paragraph !== undefined && offsetTable(paragraph).slots[pos.charOffset]?.private === true;
          if (!isCompose) {
            const tkey = `${page}|${key}`;
            const offset = located.address.offset ?? 0;
            // 표 머리글 반복 등으로 같은 문단이 한 쪽에 두 번 그려진 경우(같은 오프셋·같은 글)는 되풀이로 보고 건너뛴다
            const dup = `${tkey}|${offset}|${run.text}`;
            if (!duplicates.has(dup)) {
              duplicates.add(dup);
              const prev = tiling.get(tkey);
              if (prev !== undefined && offset < prev) {
                stats.silent++;
                bump(report.silentKinds, "TILING");
                options.onSilent?.("TILING", page, run, check, `offset ${offset} < previousEnd ${prev}`);
              }
              tiling.set(tkey, offset + run.text.length);
            }
          }
        }
        const prior = seen.get(key);
        if (prior === undefined) seen.set(key, { key, pos, address: located.address, checkedChars: 0, trail: located.trail, hasChar: located.precision === "char" });
        else if (located.precision === "char") prior.hasChar = true;

        if (oracle !== undefined && pos.cellPath !== undefined) {
          // 표 크기와 칸 안 문단 수 대조: 경로의 단계마다 한 번씩
          const steps = pos.cellPath;
          for (let k = 1; k <= steps.length; k++) {
            const prefix = steps.slice(0, k);
            const listKey = JSON.stringify([pos.sectionIndex, pos.parentParaIndex, prefix]);
            if (listsChecked.has(listKey)) continue;
            listsChecked.add(listKey);
            const owner = paragraphAt(doc, { sectionIndex: pos.sectionIndex, path: located.address.path.slice(0, 2 * (k - 1) + 1) });
            const step = prefix[k - 1];
            const slot = owner === undefined || step === undefined ? undefined : controlSlots(owner)[step.controlIndex];
            if (slot === undefined || step === undefined) continue;
            if (slot.kind === "container" || step.cellIndex === 65534) {
              report.oracle.skipped++;
              continue;
            }
            report.oracle.cellLists++;
            try {
              const native = rdoc.native;
              const parentPara = pos.parentParaIndex ?? 0;
              const count = native.getCellParagraphCountByPath(pos.sectionIndex, parentPara, JSON.stringify(prefix));
              const sub = owner?.subLists[located.address.path[2 * k - 1] ?? -1];
              if (sub === undefined || sub.paragraphs.length !== count) {
                report.oracle.cellListsBad++;
                bump(report.oracleKinds, `CELL_PARA_COUNT|${slot.kind}`);
              }
              if (slot.cells !== undefined) {
                const tableKey = JSON.stringify([pos.sectionIndex, pos.parentParaIndex, prefix.slice(0, k - 1), step.controlIndex]);
                if (!tablesChecked.has(tableKey)) {
                  tablesChecked.add(tableKey);
                  report.oracle.tables++;
                  const path = JSON.stringify([...prefix.slice(0, k - 1), { controlIndex: step.controlIndex, cellIndex: 0, cellParaIndex: 0 }]);
                  const dims = parseJson(native.getTableDimensionsByPath(pos.sectionIndex, parentPara, path)) as { rowCount?: number; colCount?: number; cellCount?: number };
                  const host = slot.host as { rowCnt?: number; colCnt?: number };
                  if (dims.rowCount !== host.rowCnt || dims.colCount !== host.colCnt || dims.cellCount !== slot.cells.length) {
                    report.oracle.tablesBad++;
                    bump(report.oracleKinds, "TABLE_DIMS");
                  }
                }
              }
            } catch (e) {
              report.oracle.errors++;
              bump(report.oracleKinds, `ERROR|cell|${slot.kind}|${String(e).slice(0, 40)}`);
            }
          }
        }
      }
      report.ms.check += performance.now() - t3;
    }

    if (oracle !== undefined) {
      const topChecked = new Set<string>();
      for (const m of seen.values()) {
        const paragraph = paragraphAt(doc, m.address);
        if (paragraph === undefined) continue;
        if (m.trail.some((k) => k === "container" || k.endsWith(":caption"))) {
          report.oracle.skipped++;
          continue;
        }
        report.oracle.paragraphs++;
        try {
          const rhwpText = oracle.paragraphText(m.pos);
          if (rhwpText !== projectedText(paragraph)) {
            report.oracle.textBad++;
            bump(report.oracleKinds, `PARAGRAPH_TEXT|${kindsOf(paragraph)}`);
            if (m.hasChar) bump(report.silentKinds, `ORACLE_TEXT|${kindsOf(paragraph)}`);
          }
        } catch (e) {
          report.oracle.errors++;
          bump(report.oracleKinds, `ERROR|text|${String(e).slice(0, 40)}`);
        }
        if (m.pos.cellPath === undefined && paragraph.fieldMarks.filter((x) => x.kind === "begin").length < 2) {
          // 누름틀이 둘 이상인 문단은 rhwp의 컨트롤 위치 목록이 어긋나므로(두 번째부터 앞 누름틀 끝 위치로 나온다) 대조하지 않는다
          const topKey = `${m.pos.sectionIndex}:${m.pos.paragraphIndex}`;
          if (topChecked.has(topKey)) continue;
          topChecked.add(topKey);
          try {
            const got = parseJson(rdoc.native.getControlTextPositions(m.pos.sectionIndex, m.pos.paragraphIndex)) as number[];
            const want = expectedControlPositions(paragraph);
            report.oracle.ctrlParagraphs++;
            if (got.length !== want.length) {
              // 개수가 다르면 컨트롤 색인 규칙이 틀린 것이다
              report.oracle.ctrlBad++;
              bump(report.oracleKinds, `CONTROL_COUNT|${kindsOf(paragraph)}|${got.length}vs${want.length}`);
            } else if (got.some((v, i) => v !== want[i])) {
              // 위치만 다른 경우: rhwp의 `getControlTextPositions`는 개체가 이어진 문단에서 위치가 어긋나게 나온다(참고용)
              report.oracle.ctrlPosDiffer++;
            }
          } catch {
            report.oracle.errors++;
          }
        }
      }
    }
  } finally {
    rdoc.free();
  }
  return report;
}

/** 여러 문서의 보고를 합친다(수량 합). */
export function mergeReports(into: DocReport, from: DocReport): void {
  into.pages += from.pages;
  for (const k of Object.keys(into.runs) as (keyof DocReport["runs"])[]) into.runs[k] += from.runs[k];
  for (const c of RUN_CLASSES) for (const k of Object.keys(into.classes[c]) as (keyof ClassStats)[]) into.classes[c][k] += from.classes[c][k];
  for (const [k, v] of Object.entries(from.reasons)) bump(into.reasons, k, v);
  for (const [k, v] of Object.entries(from.silentKinds)) bump(into.silentKinds, k, v);
  for (const [k, v] of Object.entries(from.oracleKinds)) bump(into.oracleKinds, k, v);
  for (const k of Object.keys(into.oracle) as (keyof DocReport["oracle"])[]) into.oracle[k] += from.oracle[k];
  for (const k of Object.keys(into.ms) as (keyof DocReport["ms"])[]) into.ms[k] += from.ms[k];
}

export const newReport = emptyReport;

/**
 * 조용한 불일치 총수: `char`로 판정했는데 (1) 대응표를 쓰지 않고 엔진 문단을 직접 읽은 글이 런의 글과 다르거나(DIRECT_TEXT),
 * (2) 주소를 rhwp 위치로 되돌리면 처음 위치와 다르거나(ROUND_TRIP), (2b) 같은 쪽 같은 문단의 런이 엔진 글에서 겹치거나 거꾸로 놓이거나(TILING), (3) 그 문단의 글이 rhwp 자신의 문단 글과 다른(ORACLE_TEXT, `oracles`를 켰을 때) 경우.
 */
export function silentTotal(r: DocReport): number {
  return Object.values(r.silentKinds).reduce((n, v) => n + v, 0);
}

// ── V8: 큰 문서의 시간 ───────────────────────────────────────────

export type Timing = {
  bytes: number;
  pages: number;
  /** 밀리초 */
  rhwpOpen: number;
  engineOpen: number;
  svgTotal: number;
  svgPerPage: number;
  layoutTotal: number;
  layoutPerPage: number;
  /** 무작위 쪽·점 `samples`번의 `hitTest`(rhwp 원래 함수) 평균·최대 */
  hitTestAvg: number;
  hitTestMax: number;
  /** 같은 점의 `ViewerDocument.hit`(머리말·꼬리말·각주 판별 포함) 평균·최대 */
  hitAvg: number;
  hitMax: number;
  samples: number;
};

/** 문서를 열어 열기·쪽 그리기(SVG)·글자 배치·클릭 위치(hitTest) 시간을 잰다. 점은 시드 고정 난수다. */
export function measureDocument(bytes: Uint8Array, samples = 200): Timing | undefined {
  const t0 = performance.now();
  let engineMs = Number.NaN;
  try {
    parseDocument(openPackage(bytes));
    engineMs = performance.now() - t0;
  } catch {
    // 엔진이 못 여는 문서도 rhwp 시간은 잰다
  }
  const t1 = performance.now();
  let rdoc: ViewerDocument;
  try {
    rdoc = openDocument(bytes);
  } catch {
    return undefined;
  }
  const rhwpOpen = performance.now() - t1;
  try {
    const pages = rdoc.pageCount();
    const t2 = performance.now();
    for (let p = 0; p < pages; p++) rdoc.pageSvg(p);
    const svgTotal = performance.now() - t2;
    const t3 = performance.now();
    for (let p = 0; p < pages; p++) rdoc.pageLayout(p);
    const layoutTotal = performance.now() - t3;

    let seed = 12345;
    const rand = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const raw: number[] = [];
    const layered: number[] = [];
    for (let i = 0; i < samples; i++) {
      const page = Math.floor(rand() * pages);
      const info = rdoc.pageInfo(page);
      const x = rand() * info.width;
      const y = rand() * info.height;
      const a = performance.now();
      rdoc.native.hitTest(page, x, y);
      raw.push(performance.now() - a);
      const b = performance.now();
      rdoc.hit(page, x, y);
      layered.push(performance.now() - b);
    }
    const avg = (a: number[]): number => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    return {
      bytes: bytes.length,
      pages,
      rhwpOpen,
      engineOpen: engineMs,
      svgTotal,
      svgPerPage: svgTotal / Math.max(1, pages),
      layoutTotal,
      layoutPerPage: layoutTotal / Math.max(1, pages),
      hitTestAvg: avg(raw),
      hitTestMax: Math.max(0, ...raw),
      hitAvg: avg(layered),
      hitMax: Math.max(0, ...layered),
      samples,
    };
  } finally {
    rdoc.free();
  }
}

// ── 클릭 경로 대조(화면 좌표 → `pick` → 엔진 주소) ───────────────────────

/** 눌린 점 하나를 실제 클릭 경로(뷰어 화면의 `pick`, 서버의 `locatePicked`·`locateInCell`)로 엔진 주소까지 옮긴 결과 */
export type ClickResult = {
  pick: Pick;
  precision: "char" | "paragraph" | "none";
  reason?: string;
  address?: EngineAddress;
  trail: string[];
};

/** 쪽 좌표 `(x, y)`를 누른 것으로 보고, 브라우저가 하는 일(`pick`)과 서버가 하는 일(`locatePicked`)을 그대로 따라 엔진 주소를 얻는다. */
export function clickAt(rdoc: ViewerDocument, doc: HwpxDocument, page: number, x: number, y: number): ClickResult {
  const pick = rdoc.pick(page, x, y);
  const position = pick.hit.position;
  // 표 칸의 빈 곳은 위치 없이 칸(`pick.cell`)만 보낼 수 있다(글 있는 줄이 없는 칸)
  if (pick.limit === "none" || (position === undefined && pick.cell === undefined)) {
    const out: ClickResult = { pick, precision: "none", trail: [] };
    if (pick.reason !== undefined) out.reason = pick.reason;
    return out;
  }
  let located: Located | Unlocated;
  if (pick.cell !== undefined) located = locateInCell(doc, pick.cell);
  else if (position === undefined) return { pick, precision: "none", trail: [] };
  else {
    const point: PickedPoint = { position, limit: pick.limit };
    if (pick.trailing === true) point.trailing = true;
    if (pick.shown !== undefined) point.shown = pick.shown;
    if (pick.guideText !== undefined) point.guide = pick.guideText;
    if (pick.reason !== undefined) point.reason = pick.reason;
    located = locatePicked(doc, point);
  }
  const out: ClickResult = { pick, precision: located.precision, trail: located.trail };
  if (located.reason !== undefined) out.reason = located.reason;
  if (located.address !== undefined) out.address = located.address;
  return out;
}

/** 엔진 주소가 가리키는 문단의 열쇠(구역과 경로) */
export const paragraphKey = (address: EngineAddress): string => `${address.sectionIndex}|${address.path.join(".")}`;

/**
 * 독립 기준: 빈 곳의 높이 `y`에서 세로로 가장 가까운 줄(점의 높이를 담는 런이 있으면 그 줄)의 런들이 속한 엔진 문단의 열쇠 집합.
 * `pick`의 줄 고르기(가로 거리, 절반 겹침)를 쓰지 않고, 문서 좌표가 있는 런 가운데 세로 거리가 가장 작은 런들(씨앗)과 세로 범위가 조금이라도 겹치는 런을 모아
 * 런 자신의 좌표·글로 엔진 주소를 얻는다. `paragraph`로 낸 빈 곳은 이 집합 안의 문단이어야 한다.
 */
export function rowParagraphKeys(doc: HwpxDocument, layout: { runs: LayoutRun[] }, y: number, bodyOnly = false): Set<string> {
  const gap = (r: LayoutRun): number => (y < r.y ? r.y - y : y > r.y + r.h ? y - (r.y + r.h) : 0);
  const runs = layout.runs.filter((r) => hasDocCoords(r) && (!bodyOnly || r.cellPath === undefined));
  const nearest = Math.min(...runs.map(gap));
  const seeds = runs.filter((r) => gap(r) <= nearest + 0.5);
  const keys = new Set<string>();
  for (const run of runs) {
    // 높이가 0인 런(글 없는 빈 문단의 런)은 씨앗의 세로 범위 안에 놓이면 그 줄의 런이다
    if (!seeds.some((s) => s === run || Math.min(s.y + s.h, run.y + run.h) > Math.max(s.y, run.y) || (run.h === 0 && run.y >= s.y && run.y <= s.y + s.h))) continue;
    const pos = runPosition(run);
    const located = pos === undefined ? undefined : toEngineAddress(doc, pos, { text: run.text, start: pos.charOffset });
    if (located?.address !== undefined) keys.add(paragraphKey(located.address));
  }
  return keys;
}

/** `group`: 묶음 개체(안의 글상자 사각형은 쪽 컨트롤 배치에 없다). 묶음 안 점은 어느 글상자에 드는지 알 수 없어 독립 기준으로 가를 수 없다. */
type Boxed = { kind: "cell" | "shape" | "group"; rect: { x: number; y: number; w: number; h: number }; id?: { paraIdx: number; controlIdx: number } };

/** 쪽 컨트롤 배치(`getPageControlLayout`)의 모든 칸(중첩 표 포함)·글상자(묶음 포함) 사각형. 구현이 쓰는 런 소속(`cellPath`)과 다른 경로다. */
export function controlRects(rdoc: ViewerDocument, page: number): Boxed[] {
  const layout = JSON.parse(rdoc.native.getPageControlLayout(page)) as { controls?: { type?: string; paraIdx?: number; controlIdx?: number; x: number; y: number; w: number; h: number; cells?: { x: number; y: number; w: number; h: number }[] }[] };
  const out: Boxed[] = [];
  const shapes: Boxed[] = [];
  for (const c of layout.controls ?? []) {
    if (c.type === "table") for (const cell of c.cells ?? []) out.push({ kind: "cell", rect: { x: cell.x, y: cell.y, w: cell.w, h: cell.h } });
    else if (c.type === "shape" || c.type === "group") {
      const box: Boxed = { kind: c.type === "group" ? "group" : "shape", rect: { x: c.x, y: c.y, w: c.w, h: c.h } };
      if (c.type === "shape" && typeof c.paraIdx === "number" && typeof c.controlIdx === "number") box.id = { paraIdx: c.paraIdx, controlIdx: c.controlIdx };
      shapes.push(box);
    }
  }
  // 글상자는 글이 든 것만: 쪽 전체를 덮는 바탕 도형 같은 글 없는 도형은 칸·글상자가 아니다. 사각형 안(칸 밖)에 문서 좌표가 있는 글 있는 런의 왼쪽 끝이 놓이면 글이 든 것으로 본다
  const inside = (b: Boxed, run: LayoutRun): boolean => run.x + 0.5 >= b.rect.x && run.x + 0.5 <= b.rect.x + b.rect.w && run.y + run.h / 2 >= b.rect.y && run.y + run.h / 2 <= b.rect.y + b.rect.h;
  const texts = rdoc.pageLayout(page).runs.filter((r) => hasDocCoords(r) && r.cellPath !== undefined && r.text !== "");
  // 칸 위에 떠 있는 글상자의 글은 칸 사각형 안에도 든다. 글상자는 쪽 컨트롤 배치가 준 자기 문단·컨트롤 번호를 가진 글 있는 런이 사각형 안에 있을 때 글이 든 것으로 본다
  for (const s of shapes) {
    const item = s.id;
    if (texts.some((r) => inside(s, r) && r.parentParaIdx === item?.paraIdx && r.cellPath?.length === 1 && r.cellPath[0]?.controlIndex === item?.controlIdx)) out.push(s);
    else if (item === undefined && texts.some((r) => inside(s, r) && !out.some((c) => inside(c, r)))) out.push(s);
  }
  return out;
}

/** 점을 담은 가장 작은 사각형(칸·글상자). 없으면 undefined(본문). */
export function innermostRect(rects: Boxed[], x: number, y: number): Boxed | undefined {
  let best: Boxed | undefined;
  for (const b of rects) {
    if (x < b.rect.x || x > b.rect.x + b.rect.w || y < b.rect.y || y > b.rect.y + b.rect.h) continue;
    if (best === undefined || b.rect.w * b.rect.h < best.rect.w * best.rect.h) best = b;
  }
  return best;
}

/**
 * 독립 기준: 빈 곳에서 `paragraph`로 낸 문단이 맞는가. 맞으면 undefined, 어긋나면 조용한 불일치 사유.
 * - 점이 어느 칸·글상자 사각형에도 들지 않으면(본문) 본문 문단이어야 하고, 점의 높이를 담는(또는 세로로 가장 가까운) 본문 줄의 런이 속한 문단이어야 한다(`BLANK_ROW`).
 * - 점이 칸·글상자 사각형 안이면 칸·글상자 안 문단이어야 하고(`BLANK_BODY_IN_CONTAINER`), 그 사각형 안에 그려진 문서 좌표 런이 속한 문단이어야 한다(`BLANK_CELL`·`BLANK_TEXTBOX`).
 *   표 칸이면 엔진 주소를 rhwp 위치로 되돌려 표 경로로 묻는 칸 사각형이 점을 담는지도 본다(`BLANK_CELL_RECT`).
 */
export function blankParagraphProblem(rdoc: ViewerDocument, doc: HwpxDocument, page: number, rects: Boxed[], x: number, y: number, result: ClickResult, duplicateTables = false): string | undefined {
  const address = result.address;
  if (address === undefined) return undefined;
  const layout = rdoc.pageLayout(page);
  const key = paragraphKey(address);
  const inner = innermostRect(rects, x, y);
  if (inner?.kind === "group") return undefined;
  if (inner === undefined) {
    if (address.path.length !== 1) return "BLANK_CONTAINER_OUTSIDE";
    return rowParagraphKeys(doc, layout, y, true).has(key) ? undefined : "BLANK_ROW";
  }
  if (address.path.length === 1) return "BLANK_BODY_IN_CONTAINER";
  // 눌린 문단이 글을 가졌는데 그 사각형 안에 그 문단의 런(글 있는 것이든 이 쪽에는 빈 조각뿐인 것이든)이 하나도 없으면 어긋난 것이다. 글이 빈 문단은 칸 폭만큼 넓게(칸 밖까지)
  // 그려진 빈 런을 위치로 가를 수 없어 아래 칸 사각형 점검이 맡는다. 사각형 안에 글 있는 런이 하나도 없으면(`nonEmpty`가 0) 이 점검은 건너뛴다
  const keys = new Set<string>();
  let nonEmpty = 0;
  // 눌린 문단을 담은 표(또는 글상자)를 담은 문단의 주소. 같은 표의 런만 증거로 센다: 쪽 끝에서 이어진 표의 칸 사각형은 쪽 밖까지 뻗어 다른 표의 글과 겹칠 수 있다(겹친 다른 표의 글은 이 칸의 증거가 아니다)
  const owner = address.path.slice(0, -2);
  for (const run of layout.runs) {
    if (!hasDocCoords(run) || run.cellPath === undefined) continue;
    // 런의 왼쪽 끝 가운데(칸 폭보다 넓게 그려진 빈 런의 한가운데는 칸 밖일 수 있다)
    const cx = run.x + 0.5;
    const cy = run.y + run.h / 2;
    if (cx < inner.rect.x || cx > inner.rect.x + inner.rect.w || cy < inner.rect.y || cy > inner.rect.y + inner.rect.h) continue;
    const pos = runPosition(run);
    const found = pos === undefined ? undefined : toEngineAddress(doc, pos, { text: run.text, start: pos.charOffset });
    if (found?.address !== undefined && (found.address.sectionIndex !== address.sectionIndex || !owner.every((v, i) => found.address?.path[i] === v))) continue;
    if (found?.address !== undefined) {
      keys.add(paragraphKey(found.address));
      // 칸 안에 그려진 안쪽 표의 글이면 그 표를 담은 바깥 칸 문단들도 이 사각형에 그려진 문단이다(바깥 칸의 빈 곳은 그 문단의 것이다)
      for (let n = found.address.path.length - 2; n >= 1; n -= 2) keys.add(paragraphKey({ sectionIndex: found.address.sectionIndex, path: found.address.path.slice(0, n) }));
    }
    if (run.text !== "") nonEmpty++;
  }
  const located = paragraphAtAddress(doc, address);
  if (located !== undefined && located.logicalText.replaceAll("\ufffc", "") !== "" && nonEmpty > 0 && !keys.has(key)) return inner.kind === "cell" ? "BLANK_CELL" : "BLANK_TEXTBOX";
  if (inner.kind === "cell" && result.trail[result.trail.length - 1] === "tbl") {
    const pos = toRhwpPosition(doc, address);
    const steps = pos?.cellPath;
    const last = steps?.[steps.length - 1];
    if (pos?.parentParaIndex !== undefined && steps !== undefined && last !== undefined) {
      const tablePath = [...steps.slice(0, -1), { controlIndex: last.controlIndex, cellIndex: 0, cellParaIndex: 0 }];
      try {
        const cells = JSON.parse(rdoc.native.getTableCellBboxesByPath(pos.sectionIndex, pos.parentParaIndex, JSON.stringify(tablePath))) as { row: number; col: number; pageIndex?: number; x: number; y: number; w: number; h: number }[];
        // 사각형 응답의 `cellIdx`는 경로의 칸 색인과 다를 수 있으므로(1부터 시작하는 표가 있다) 경로의 칸 색인의 행·열을 칸 정보 함수로 읽어 맞춘다
        const info = JSON.parse(rdoc.native.getCellInfoByPath(pos.sectionIndex, pos.parentParaIndex, JSON.stringify([...steps.slice(0, -1), { controlIndex: last.controlIndex, cellIndex: last.cellIndex, cellParaIndex: 0 }]))) as { row?: number; col?: number };
        // 쪽에 걸친 표는 칸마다 `pageIndex`가 있다(머리 행 반복 등으로 같은 칸이 여러 쪽에 나온다): 이 쪽의 칸만 본다
        const cell = cells.find((c) => c.row === info.row && c.col === info.col && c.pageIndex === page);
        // 같은 표가 한 쪽에 두 번 그려진 쪽(rhwp가 다시 배치한 문서에서 관측)은 이 응답이 앞의 것만 주므로 사각형으로 가를 수 없다
        if (!duplicateTables && cell !== undefined && (x < cell.x - 0.6 || x > cell.x + cell.w + 0.6 || y < cell.y - 0.6 || y > cell.y + cell.h + 0.6)) return "BLANK_CELL_RECT";
      } catch {
        // 표 경로 응답을 못 받는 경우(캡션 등)는 사각형 점검만 건너뛴다
      }
    }
  }
  return undefined;
}

/** 쪽 컨트롤 배치에 같은 표(같은 `stableIndex`)가 둘 이상 나오는가(같은 표가 한 쪽에 두 번 그려졌다). */
function hasDuplicateTables(rdoc: ViewerDocument, page: number): boolean {
  const layout = JSON.parse(rdoc.native.getPageControlLayout(page)) as { controls?: { type?: string; stableIndex?: number[] }[] };
  const seen = new Set<string>();
  for (const c of layout.controls ?? []) {
    if (c.type !== "table" || c.stableIndex === undefined) continue;
    const key = c.stableIndex.join(".");
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * 쪽 렌더 트리에서 본문이 아닌 영역(바탕쪽·머리말·꼬리말·각주)의 글 상자와 사각형이 같고 본문의 글 상자와는 같지 않은 글 있는 런들.
 * 이런 글은 문서 좌표가 본문 같아 보여도 본문 글이 아니므로, 눌렀을 때 본문·칸·글상자의 위치가 나오면 영역 오판이다(`ASIDE_TEXT_AS_*`).
 */
function asideRunsOf(rdoc: ViewerDocument, page: number): Set<LayoutRun> {
  const boxes = regionBoxes(JSON.parse(rdoc.native.getPageRenderTree(page)));
  const aside = [...boxes.master, ...boxes.header, ...boxes.footer, ...boxes.footnote];
  const same = (a: Rect, r: LayoutRun): boolean => Math.abs(a.x - r.x) <= 0.6 && Math.abs(a.y - r.y) <= 0.6 && Math.abs(a.w - r.w) <= 0.6 && Math.abs(a.h - r.h) <= 0.6;
  return new Set(rdoc.pageLayout(page).runs.filter((r) => r.text !== "" && aside.some((a) => same(a, r)) && !boxes.body.some((b) => same(b, r))));
}

export type PointKind = "glyph" | "blank" | "unpositioned" | "marker";
export const POINT_KINDS: PointKind[] = ["glyph", "blank", "unpositioned", "marker"];

export type KindCounts = { char: number; paragraph: number; none: number };

export type ClickReport = {
  engine: { ok: boolean; code?: string };
  rhwp: { ok: boolean; code?: string };
  pages: number;
  sampledPages: number;
  /** 누른 점 수(종류별). glyph: 글자 사각형의 왼쪽·오른쪽 4분의 1, blank: 어느 런의 사각형 안도 아닌 점, unpositioned: 문서 좌표 없는 글, marker: 머리말·꼬리말·각주 본문 글 */
  presses: Record<PointKind, number>;
  byKind: Record<PointKind, KindCounts>;
  /** 빈 곳 눌림을 점의 출처별로: `near`(글 있는 런 옆·쪽 모서리), `random`(쪽 전체에 고르게), `cell`(표 칸 한가운데) */
  blankBy: { near: KindCounts; random: KindCounts; cell: KindCounts };
  /** 빈 곳 눌림을 점이 든 자리별로(쪽 컨트롤 배치의 가장 작은 칸·글상자 사각형 기준): 본문, 표 칸, 글상자. 표 칸 한가운데(`cell` 출처)는 세지 않는다(이전 보고와 같은 표본으로 견주려고 `blankBy.cell`·`blankCellReasons`로 따로 센다) */
  blankPlaces: { body: KindCounts; cell: KindCounts; textbox: KindCounts };
  /** 빈 곳 `paragraph`·`none`의 사유를 자리별로(키 `자리|사유`). `cell` 출처 눌림은 뺀다 */
  blankPlaceReasons: Record<string, number>;
  /** `cell` 출처(표 칸 한가운데) 눌림의 `paragraph`·`none` 사유(키 사유) */
  blankCellReasons: Record<string, number>;
  /** `paragraph`·`none`의 사유별 수량. 키는 `눌림 종류|사유`(영역만 알리는 `none`은 `REGION`) */
  reasons: Record<string, number>;
  /** 조용한 불일치(`char`인데 틀렸거나, 있어서는 안 되는 자리의 `char`) 사유별 수량 */
  silentKinds: Record<string, number>;
  silent: number;
  /**
   * 영역 오판: (1) 머리말·꼬리말·각주 본문 글을 눌렀는데 본문·표 칸으로 판정(`MARKER_AS_*`), (2) 문서 좌표가 있는 글자를 눌렀는데 머리말·꼬리말·각주·바탕쪽으로만 판정(글자가 겹친 곳은 제외)했지만
   * 그 런 자신의 좌표로 엔진 문단에서 글이 확인되는 경우(`BODY_TEXT_AS_*`: 본문 글을 영역 글로 잘못 본 의심).
   */
  regionBad: number;
  regionKinds: Record<string, number>;
  /** 문서 좌표가 있는 글자를 누른 점의 영역 판정별 수량(`pick`의 영역) */
  glyphRegions: Record<string, number>;
  /** 글자 눌림에서 rhwp의 `hitTest`가 가리킨 위치가 `pick`(런 기준)과 다른 수 — 예전 경로(`hitTest`의 글자 순번을 쓰는)였다면 틀렸을 수 있는 클릭 */
  hitDisagree: { otherOffset: number; otherParagraph: number; noPosition: number; comparedChars: number };
  /** `char` 가운데 사설 영역 글자(겹친 글)라 글자 대조를 건너뛴 수 */
  skipped: number;
  errors: number;
  ms: number;
};

const emptyKinds = (): KindCounts => ({ char: 0, paragraph: 0, none: 0 });

export function newClickReport(): ClickReport {
  return {
    engine: { ok: false },
    rhwp: { ok: false },
    pages: 0,
    sampledPages: 0,
    presses: { glyph: 0, blank: 0, unpositioned: 0, marker: 0 },
    byKind: { glyph: emptyKinds(), blank: emptyKinds(), unpositioned: emptyKinds(), marker: emptyKinds() },
    blankBy: { near: emptyKinds(), random: emptyKinds(), cell: emptyKinds() },
    blankPlaces: { body: emptyKinds(), cell: emptyKinds(), textbox: emptyKinds() },
    blankPlaceReasons: {},
    blankCellReasons: {},
    reasons: {},
    silentKinds: {},
    silent: 0,
    regionBad: 0,
    regionKinds: {},
    glyphRegions: {},
    hitDisagree: { otherOffset: 0, otherParagraph: 0, noPosition: 0, comparedChars: 0 },
    skipped: 0,
    errors: 0,
    ms: 0,
  };
}

export function mergeClickReports(into: ClickReport, from: ClickReport): void {
  into.pages += from.pages;
  into.sampledPages += from.sampledPages;
  for (const k of POINT_KINDS) {
    into.presses[k] += from.presses[k];
    into.byKind[k].char += from.byKind[k].char;
    into.byKind[k].paragraph += from.byKind[k].paragraph;
    into.byKind[k].none += from.byKind[k].none;
  }
  for (const o of ["near", "random", "cell"] as const) for (const k of ["char", "paragraph", "none"] as const) into.blankBy[o][k] += from.blankBy[o][k];
  for (const o of ["body", "cell", "textbox"] as const) for (const k of ["char", "paragraph", "none"] as const) into.blankPlaces[o][k] += from.blankPlaces[o][k];
  for (const [k, v] of Object.entries(from.blankPlaceReasons)) bump(into.blankPlaceReasons, k, v);
  for (const [k, v] of Object.entries(from.blankCellReasons)) bump(into.blankCellReasons, k, v);
  for (const [k, v] of Object.entries(from.reasons)) bump(into.reasons, k, v);
  for (const [k, v] of Object.entries(from.silentKinds)) bump(into.silentKinds, k, v);
  for (const [k, v] of Object.entries(from.regionKinds)) bump(into.regionKinds, k, v);
  for (const [k, v] of Object.entries(from.glyphRegions)) bump(into.glyphRegions, k, v);
  into.silent += from.silent;
  into.regionBad += from.regionBad;
  for (const k of Object.keys(into.hitDisagree) as (keyof ClickReport["hitDisagree"])[]) into.hitDisagree[k] += from.hitDisagree[k];
  into.skipped += from.skipped;
  into.errors += from.errors;
  into.ms += from.ms;
}

/** `origin`(빈 곳만): `near`는 글 있는 런의 오른쪽·위·왼쪽 옆과 쪽 모서리, `random`은 쪽 전체에 고르게 뿌린(시드 고정) 점, `cell`은 표 칸의 한가운데(글이 없는 표의 칸 포함) */
type Press = { kind: PointKind; x: number; y: number; run?: LayoutRun; index?: number; quarter?: number; origin?: "near" | "random" | "cell" };

const isPrivateGlyph = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd);
};

/** 앞에서부터 고르게 `cap`개만 뽑는다(`cap`이 같거나 크면 전부). */
function spread<T>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) {
    const item = items[Math.floor((i * items.length) / cap)];
    if (item !== undefined) out.push(item);
  }
  return out;
}

/** 쪽의 누를 점들: 런마다 첫·가운데·마지막 글자의 왼쪽·오른쪽 4분의 1, 문서 좌표 없는 글, 머리말·꼬리말·각주 글, 빈 곳. */
function pressesOf(layout: { runs: LayoutRun[] }, width: number, height: number, cap: number, seed: number, cells: Rect[] = []): Press[] {
  const out: Press[] = [];
  const runs = layout.runs;
  const docRuns = spread(runs.filter((r) => hasDocCoords(r) && r.text !== ""), cap);
  for (const run of docRuns) {
    const chars = Array.from(run.text);
    const n = chars.length;
    for (const i of new Set([0, n >> 1, n - 1])) {
      const left = run.x + (run.charX[i] ?? 0);
      const right = run.x + (run.charX[i + 1] ?? 0);
      if (right - left < 0.5 || isPrivateGlyph(chars[i] ?? "")) continue;
      for (const quarter of [0.25, 0.75]) out.push({ kind: "glyph", x: left + (right - left) * quarter, y: run.y + run.h / 2, run, index: i, quarter });
    }
  }
  const middleOf = (run: LayoutRun): { x: number; y: number } | undefined => {
    const n = runLength(run);
    for (let i = 0; i < n; i++) {
      const left = run.x + (run.charX[i] ?? 0);
      const right = run.x + (run.charX[i + 1] ?? 0);
      if (right - left >= 0.5) return { x: (left + right) / 2, y: run.y + run.h / 2 };
    }
    return undefined;
  };
  for (const run of spread(runs.filter((r) => !hasDocCoords(r) && !isMarkerRun(r) && r.text !== ""), 12)) {
    const p = middleOf(run);
    if (p !== undefined) out.push({ kind: "unpositioned", ...p, run });
  }
  for (const run of spread(runs.filter((r) => isMarkerRun(r) && r.text !== ""), 8)) {
    const p = middleOf(run);
    if (p !== undefined) out.push({ kind: "marker", ...p, run });
  }
  // 빈 곳: 글이 있는 어느 런의 사각형(`w`와 마지막 글자 경계 가운데 넓은 쪽: 줄 끝 공백은 `w` 밖까지 그려진다) 안도 아닌 점(런 오른쪽 옆·위, 쪽 가장자리)
  const textRuns = runs.filter((r) => r.text !== "");
  const inside = (x: number, y: number): boolean =>
    textRuns.some((r) => x >= r.x && x <= r.x + Math.max(r.w, r.charX[r.charX.length - 1] ?? 0) && y >= r.y && y <= r.y + r.h);
  const candidates: { x: number; y: number }[] = [
    { x: 6, y: 6 },
    { x: width - 6, y: 6 },
    { x: 6, y: height - 6 },
    { x: width - 6, y: height - 6 },
    { x: width / 2, y: 3 },
    { x: width / 2, y: height - 3 },
  ];
  for (const run of spread(runs.filter((r) => hasDocCoords(r) && r.text !== ""), 30)) {
    candidates.push({ x: run.x + run.w + 4, y: run.y + run.h / 2 }, { x: run.x + run.w / 2, y: run.y - 3 }, { x: run.x - 4, y: run.y + run.h / 2 });
  }
  for (const c of candidates) {
    if (c.x >= 0 && c.y >= 0 && c.x <= width && c.y <= height && !inside(c.x, c.y)) out.push({ kind: "blank", x: c.x, y: c.y, origin: "near" });
  }
  // 쪽 전체에 고르게 뿌린 빈 곳(런 옆만 누르면 표 칸의 윗 여백 같은 자리가 많아진다)
  let state = seed;
  const rand = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < 40; i++) {
    const x = rand() * width;
    const y = rand() * height;
    if (!inside(x, y)) out.push({ kind: "blank", x, y, origin: "random" });
  }
  // 표 칸의 한가운데: 글이 없는 표는 런 옆이나 쪽 전체에 뿌린 점으로는 칸을 거의 누르지 못한다
  for (const r of spread(cells, 30)) {
    const x = r.x + r.w / 2;
    const y = r.y + r.h / 2;
    if (!inside(x, y)) out.push({ kind: "blank", x, y, origin: "cell" });
  }
  return out;
}

/** 쪽의 글자 배치를 보고 `pageCap`개 쪽을 골라 누른다. 쪽당 `runCap`개 런까지. */
export function checkClicks(
  bytes: Uint8Array,
  options: { pageCap?: number; runCap?: number; onSilent?: (kind: string, page: number, x: number, y: number, result: ClickResult) => void } = {},
): ClickReport {
  const report = newClickReport();
  const t0 = performance.now();
  let doc: HwpxDocument | undefined;
  try {
    doc = parseDocument(openPackage(bytes));
    report.engine.ok = true;
  } catch (e) {
    report.engine.code = codeOf(e);
  }
  let rdoc: ViewerDocument | undefined;
  try {
    rdoc = openDocument(bytes);
    report.rhwp.ok = true;
  } catch (e) {
    report.rhwp.code = codeOf(e);
  }
  if (doc === undefined || rdoc === undefined) {
    rdoc?.free();
    report.ms = performance.now() - t0;
    return report;
  }
  let at: { page: number; x: number; y: number; result?: ClickResult } = { page: 0, x: 0, y: 0 };
  const silent = (kind: string): void => {
    report.silent++;
    bump(report.silentKinds, kind);
    if (options.onSilent !== undefined && at.result !== undefined) options.onSilent(kind, at.page, at.x, at.y, at.result);
  };
  const oracle = makeOracle(rdoc);
  try {
    report.pages = rdoc.pageCount();
    const pages = spread(Array.from({ length: report.pages }, (_, i) => i), options.pageCap ?? 30);
    report.sampledPages = pages.length;
    for (const page of pages) {
      const layout = rdoc.pageLayout(page);
      const info = rdoc.pageInfo(page);
      const rects = controlRects(rdoc, page);
      const asideRuns = asideRunsOf(rdoc, page);
      const duplicateTables = hasDuplicateTables(rdoc, page);
      const cellRects = rects.filter((b) => b.kind === "cell").map((b) => b.rect);
      for (const press of pressesOf(layout, info.width, info.height, options.runCap ?? 80, 4242 + page, cellRects)) {
        report.presses[press.kind]++;
        let r: ClickResult;
        try {
          r = clickAt(rdoc, doc, page, press.x, press.y);
        } catch {
          report.errors++;
          continue;
        }
        at = { page, x: press.x, y: press.y, result: r };
        const counts = report.byKind[press.kind];
        counts[r.precision]++;
        if (press.origin !== undefined) report.blankBy[press.origin][r.precision]++;
        if (press.kind === "blank" && press.origin === "cell") {
          if (r.precision !== "char") bump(report.blankCellReasons, r.reason ?? "REGION");
        } else if (press.kind === "blank") {
          const inner = innermostRect(rects, press.x, press.y);
          const place = inner === undefined ? "body" : inner.kind === "cell" ? "cell" : "textbox";
          report.blankPlaces[place][r.precision]++;
          if (r.precision !== "char") bump(report.blankPlaceReasons, `${place}|${r.reason ?? "REGION"}`);
        }
        if (r.precision !== "char") bump(report.reasons, `${press.kind}|${r.reason ?? "REGION"}`);

        // 영역 판별
        const region = r.pick.hit.region;
        if (press.kind === "glyph") {
          bump(report.glyphRegions, region);
          // 겹침(OVERLAPPING_RUNS)은 본문 글이 머리말·각주 글 위에 겹쳐 그려진 곳이라 영역이 둘 다 맞다: 영역만 알린 경우를 본다
          if ((region === "header" || region === "footer" || region === "footnote" || region === "masterpage") && r.reason !== "OVERLAPPING_RUNS") {
            const own = press.run === undefined ? undefined : runPosition(press.run);
            if (press.run !== undefined && own !== undefined && toEngineAddress(doc, own, { text: press.run.text, start: own.charOffset }).precision === "char") {
              report.regionBad++;
              bump(report.regionKinds, `BODY_TEXT_AS_${region}`);
            }
          }
        }
        // 본문 밖 영역(바탕쪽 등)의 글(렌더 트리의 글 상자로 가른다)을 눌렀는데 화면이 본문·칸·글상자의 글자 위치를 냈다(서버가 엔진 문단 글과 맞지 않아 거절해도 화면의 영역 판단은 틀렸다)
        if (press.kind === "glyph" && press.run !== undefined && asideRuns.has(press.run) && r.pick.hit.position !== undefined && (region === "body" || region === "cell" || region === "textbox")) {
          report.regionBad++;
          bump(report.regionKinds, `ASIDE_TEXT_AS_${region}`);
        }
        if (press.kind === "marker" && region !== "header" && region !== "footer" && region !== "footnote") {
          report.regionBad++;
          bump(report.regionKinds, `MARKER_AS_${region}`);
        }
        if (press.kind === "marker" && r.precision !== "none") silent("MARKER_POSITION");

        if (r.precision === "paragraph" && r.address !== undefined) {
          // 문단 단위: 엔진 문단의 글이 rhwp가 가리킨 문단의 글과 같아야 한다(오라클)
          const para = paragraphAtAddress(doc, r.address);
          const pos = r.pick.hit.position;
          // 빈 곳: 점을 담은 칸·글상자 사각형 안의 문단(칸 밖이면 점의 높이를 담는 본문 줄의 문단)이어야 한다
          if (press.kind === "blank") {
            const problem = blankParagraphProblem(rdoc, doc, page, rects, press.x, press.y, r, duplicateTables);
            if (problem !== undefined) silent(problem);
          }
          // 표 칸의 빈 곳(`pick.cell`)은 rhwp의 위치(첫 후보)가 아니라 렌더 트리의 칸(행·열)으로 정한 칸의 문단이라 글 대조 대상이 아니다(위의 칸 점검이 맡는다)
          if (para !== undefined && pos !== undefined && r.pick.cell === undefined && !r.trail.some((k) => k === "container" || k.endsWith(":caption"))) {
            try {
              if (oracle.paragraphText(pos) !== projectedText(para)) silent(`PARAGRAPH_ORACLE|${press.kind}`);
            } catch {
              report.errors++;
            }
          }
        }
        if (r.precision !== "char") continue;

        const paragraph = r.address === undefined ? undefined : paragraphAtAddress(doc, r.address);
        const position = r.pick.hit.position;
        if (r.address === undefined || paragraph === undefined || position === undefined) {
          silent("CHAR_WITHOUT_ADDRESS");
          continue;
        }
        if (press.kind === "blank") silent("BLANK_CHAR");
        if (press.kind === "marker") silent("MARKER_CHAR");
        // 왕복: 주소를 rhwp 위치로 되돌리면 같은 문단이어야 한다
        const back = toRhwpPosition(doc, r.address);
        if (back === undefined || !sameParagraph(back, position)) silent("ROUND_TRIP_PARAGRAPH");

        if (r.pick.guide) {
          // 안내문 글: 엔진 문단에 같은 글의 안내문 상태 누름틀이 있고 주소가 그 안이어야 한다
          const text = r.pick.guideText;
          if (!guideFields(paragraph).some((g) => g.text === text && g.logicalStart === r.address?.offset)) silent("GUIDE_FIELD");
          continue;
        }
        if (press.kind === "unpositioned") silent("UNPOSITIONED_CHAR");
        const shown = r.pick.shown;
        if (shown === undefined || r.pick.glyph === undefined) {
          silent("CHAR_WITHOUT_RUN");
          continue;
        }
        const chars = Array.from(shown.text);
        const glyphIndex = r.pick.glyph - shown.start;
        const caret = position.charOffset - shown.start;
        const pressed = chars[glyphIndex];
        if (pressed === undefined || (caret !== glyphIndex && caret !== glyphIndex + 1)) {
          silent("CHAR_GLYPH_RANGE");
          continue;
        }
        // 의도한 글자: 눌린 글자 사각형의 왼쪽 4분의 1이면 글자 앞, 오른쪽 4분의 1이면 글자 뒤 경계여야 한다
        if (press.kind === "glyph" && press.run !== undefined && press.index !== undefined && press.quarter !== undefined) {
          const start = runPosition(press.run);
          if (start === undefined || shown.text !== press.run.text || shown.start !== start.charOffset || glyphIndex !== press.index) silent("INTENT_RUN");
          else if (caret !== (press.quarter < 0.5 ? press.index : press.index + 1)) silent("INTENT_CARET");
          // 예전 경로(rhwp `hitTest`의 글자 순번)와 비교한 참고 수량
          report.hitDisagree.comparedChars++;
          const raw = rdoc.hit(page, press.x, press.y).position;
          if (raw === undefined) report.hitDisagree.noPosition++;
          else if (!sameParagraph(raw, position)) report.hitDisagree.otherParagraph++;
          else if (raw.charOffset !== position.charOffset) report.hitDisagree.otherOffset++;
        }
        // 글자 겹침(한 칸이 겹친 글 여러 개로 그려진다): 눌린 글은 엔진 글자가 아니라 겹침 컨트롤의 글이므로 글자 대조를 건너뛴다
        if (isPrivateGlyph(pressed) || controlSlots(paragraph).some((s) => s.composeText !== undefined && (s.composeText === shown.text || [...shown.text].every(isPrivateGlyph)))) {
          report.skipped++;
          continue;
        }
        // 대응표를 쓰지 않고 엔진 문단의 글을 직접 읽어, 주소 바로 뒤(또는 바로 앞) 글자가 눌린 글자와 같은지 본다
        const offset = r.address.offset ?? 0;
        const glyphs = engineGlyphs(paragraph);
        const engine = caret === glyphIndex ? glyphs.find((g) => g.start >= offset) : [...glyphs].reverse().find((g) => g.end <= offset);
        if (engine?.glyph !== pressed) silent(`GLYPH|${press.kind}`);
        // 눌린 글자와 주소 사이에는 객체 자리 글자(U+FFFC: 필드 표식 등)만 끼어야 한다. 글자만 찾으면 안내문 상태 누름틀의 안내문 글(글자로 세지 않는다)을 건너뛴 주소도 통과하므로,
        // 주소가 글자 바로 곁(왼쪽 4분의 1이면 글자 바로 앞, 오른쪽이면 바로 뒤)인지 논리 텍스트로 직접 본다
        else if (engine !== undefined && !objectsOnlyBetween(paragraph, caret === glyphIndex ? offset : engine.end, caret === glyphIndex ? engine.start : offset)) silent(`GLYPH_GAP|${press.kind}`);
      }
    }
  } finally {
    rdoc.free();
  }
  report.ms = performance.now() - t0;
  return report;
}

/**
 * 문서의 채울 수 있는 첫 자리를 채워 새 바이트를 얻는다(엔진이 구역의 줄 배치 캐시를 지우므로 rhwp가 다시 배치한다). 채울 자리가 없거나 게이트가 막으면 undefined.
 * 앵커 초안(`draftAnchors`)의 `blocked` 없는 낱말·문단 가운데 첫 것을 쓴다.
 */
export function fillOnce(bytes: Uint8Array, value = "채움값"): Uint8Array | undefined {
  let doc: HwpxDocument;
  try {
    doc = parseDocument(openPackage(bytes));
  } catch {
    return undefined;
  }
  for (const [sectionIndex, section] of doc.sections.entries()) {
    for (const [pi, paragraph] of section.paragraphs.entries()) {
      if (paragraph.logicalText.replaceAll("\ufffc", "").trim() === "") continue;
      let drafts;
      try {
        drafts = draftAnchors(doc, { sectionIndex, path: [pi], start: 0 });
      } catch {
        continue;
      }
      const chosen = drafts.find((d) => d.blocked === undefined && (d.kind === "word" || d.kind === "line"));
      if (chosen === undefined) continue;
      const { blocked: _blocked, ...anchor } = chosen;
      try {
        const template = readTemplate({
          schema: "hwpx-studio/template@1",
          anchors: [{ id: "a0", ...anchor }],
          rules: [{ id: "r0", do: { type: "fill", anchor: "a0", value: { text: value } } }],
          options: { missing: "keep" },
        });
        const result = generate(bytes, template, readDataset({}));
        if (result.ok && !result.dryRun && result.report.plan.actions.length > 0) return (result as Extract<typeof result, { output: Uint8Array }>).output;
      } catch {
        // 다음 자리를 시도한다
      }
    }
  }
  return undefined;
}
