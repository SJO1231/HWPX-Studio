// 호스트 API가 받는 위치 요청의 입력 검사. 틀린 입력은 `HostError`(400)다.
import type { CellRef, CellStep, PickedPoint, RhwpPosition, Shown } from "../map/index.ts";
import { HostError } from "./errors.ts";

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 2 ** 32;

function parseStep(v: unknown): CellStep {
  if (!isObj(v) || !isInt(v["controlIndex"]) || !isInt(v["cellIndex"]) || !isInt(v["cellParaIndex"])) throw new HostError(400, "BAD_POSITION", "cellPath의 단계가 올바르지 않습니다.");
  return { controlIndex: v["controlIndex"], cellIndex: v["cellIndex"], cellParaIndex: v["cellParaIndex"] };
}

function parsePosition(v: unknown): RhwpPosition {
  if (!isObj(v) || !isInt(v["sectionIndex"]) || !isInt(v["paragraphIndex"]) || !isInt(v["charOffset"])) {
    throw new HostError(400, "BAD_POSITION", "위치는 sectionIndex·paragraphIndex·charOffset(0 이상 정수)을 가져야 합니다.");
  }
  const pos: RhwpPosition = { sectionIndex: v["sectionIndex"], paragraphIndex: v["paragraphIndex"], charOffset: v["charOffset"] };
  if (v["cellPath"] !== undefined) {
    if (!Array.isArray(v["cellPath"]) || v["cellPath"].length === 0 || v["cellPath"].length > 64 || !isInt(v["parentParaIndex"])) {
      throw new HostError(400, "BAD_POSITION", "cellPath는 비어 있지 않은 배열이어야 하고 parentParaIndex가 있어야 합니다.");
    }
    pos.parentParaIndex = v["parentParaIndex"];
    pos.cellPath = v["cellPath"].map(parseStep);
  }
  return pos;
}

function parseShown(v: unknown): Shown | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v) || typeof v["text"] !== "string" || !isInt(v["start"]) || v["text"].length > 100_000) throw new HostError(400, "BAD_SHOWN", "shown은 { text, start }여야 합니다.");
  return { text: v["text"], start: v["start"] };
}

function parseCell(v: unknown): CellRef {
  const steps = isObj(v) ? v["steps"] : undefined;
  if (!isObj(v) || !isInt(v["sectionIndex"]) || !Array.isArray(steps) || steps.length === 0 || steps.length > 16) {
    throw new HostError(400, "BAD_CELL", "cell은 sectionIndex와 비어 있지 않은 steps(표 경로)를 가져야 합니다.");
  }
  const cell: CellRef = {
    sectionIndex: v["sectionIndex"],
    steps: steps.map((s) => {
      if (!isObj(s) || !isInt(s["paragraph"]) || !isInt(s["control"]) || !isInt(s["row"]) || !isInt(s["col"])) {
        throw new HostError(400, "BAD_CELL", "표 경로의 단계는 paragraph·control·row·col(0 이상 정수)을 가져야 합니다.");
      }
      return { paragraph: s["paragraph"], control: s["control"], row: s["row"], col: s["col"] };
    }),
  };
  const runs = v["runs"];
  if (runs !== undefined) {
    if (!Array.isArray(runs) || runs.length > 32) throw new HostError(400, "BAD_CELL", "cell.runs는 32개 이하의 배열이어야 합니다.");
    cell.runs = runs.map((r) => {
      const shown = isObj(r) ? parseShown(r["shown"]) : undefined;
      if (!isObj(r) || shown === undefined) throw new HostError(400, "BAD_CELL", "cell.runs의 항목은 { position, shown }이어야 합니다.");
      return { position: parsePosition(r["position"]), shown };
    });
  }
  return cell;
}

/** 눌린 점 하나: 위치와 확인할 런, 그리고 뷰어 화면이 정한 한계(`limit`·`reason`)와 안내문 글(`guide`). 표 칸의 빈 곳이면 눌린 칸(`cell`, 줄 후보 포함)만 있고 위치는 없다. */
export type ParsedPoint = { point?: PickedPoint; cell?: CellRef };

export function parsePoint(v: unknown): ParsedPoint {
  if (!isObj(v)) throw new HostError(400, "BAD_REQUEST", "위치 항목이 올바르지 않습니다.");
  const parsed: ParsedPoint = {};
  if (v["cell"] !== undefined) parsed.cell = parseCell(v["cell"]);
  // 칸이 있으면 칸만 받는다(줄 후보가 칸 안에 들어 있다): 위치에 딸린 나머지 항목은 뜻이 없다
  if (parsed.cell !== undefined) return parsed;
  const point: PickedPoint = { position: parsePosition(v["position"]) };
  const shown = parseShown(v["shown"]);
  if (shown !== undefined) point.shown = shown;
  const guide = v["guide"];
  if (guide !== undefined) {
    if (typeof guide !== "string" || guide === "" || guide.length > 10_000) throw new HostError(400, "BAD_GUIDE", "guide는 눌린 안내문 글(비어 있지 않은 문자열)이어야 합니다.");
    point.guide = guide;
  }
  const trailing = v["trailing"];
  if (trailing !== undefined) {
    if (typeof trailing !== "boolean") throw new HostError(400, "BAD_TRAILING", "trailing은 불리언이어야 합니다.");
    if (trailing) point.trailing = true;
  }
  const limit = v["limit"];
  if (limit !== undefined) {
    if (limit !== "char" && limit !== "paragraph") throw new HostError(400, "BAD_LIMIT", "limit은 char 또는 paragraph여야 합니다.");
    point.limit = limit;
  }
  const reason = v["reason"];
  if (reason !== undefined) {
    if (typeof reason !== "string" || !/^[A-Z_]{1,64}$/.test(reason)) throw new HostError(400, "BAD_REASON", "reason은 대문자와 밑줄로 된 사유 코드여야 합니다.");
    point.reason = reason;
  }
  parsed.point = point;
  return parsed;
}

/** 요청 본문을 UTF-8 JSON으로 읽는다. 아니면 `BAD_JSON`(400). */
export function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new HostError(400, "BAD_JSON", "본문이 JSON이 아닙니다.");
  }
}
