import type { HwpxDocument, ParagraphNode, SectionModel, SubListNode } from "../../../hwpx-engine/src/index.ts";
import { logicalOffsetAt, noteLabelStarts, offsetTable, rhwpOffsetAt, type OffsetTable } from "./offsets.ts";
import { codePointLength } from "../rhwp/layout.ts";
import { hasNumbering } from "./numbering.ts";
import { controlSlots, type ControlSlot } from "./slots.ts";
import { REASONS, TABLE_CAPTION_CELL, type CellRef, type CellStep, type EngineAddress, type LocateEdge, type Located, type PickedPoint, type RhwpPosition, type Shown, type Unlocated } from "./types.ts";

type Step = { paragraph: ParagraphNode; path: number[]; trail: string[] };
type StepFail = { reason: string; trail: string[] };

/**
 * 컨트롤의 `cellIndex`번째 하위 목록과 그 종류 표지.
 * 표: 셀 순서(`cellIndex`), 표 캡션은 65534. 글상자·그림: 0이면 글상자 글(없으면 캡션), 여럿이면 글상자 순서.
 */
function subListOf(slot: ControlSlot, cellIndex: number): { sub: SubListNode; caption: boolean } | undefined {
  if (slot.cells !== undefined) {
    if (cellIndex === TABLE_CAPTION_CELL) {
      const cap = slot.captions[0];
      return cap === undefined ? undefined : { sub: cap, caption: true };
    }
    const sub = slot.cells[cellIndex]?.subList;
    return sub === undefined || sub === null ? undefined : { sub, caption: false };
  }
  if (cellIndex === TABLE_CAPTION_CELL) {
    const cap = slot.captions[0];
    return cap === undefined ? undefined : { sub: cap, caption: true };
  }
  const box = slot.textboxes[cellIndex];
  if (box !== undefined) return { sub: box, caption: false };
  const cap = cellIndex === 0 && slot.textboxes.length === 0 ? slot.captions[0] : undefined;
  return cap === undefined ? undefined : { sub: cap, caption: true };
}

function descend(cur: ParagraphNode, steps: CellStep[], path: number[]): Step | StepFail {
  let paragraph = cur;
  const trail: string[] = [];
  for (const step of steps) {
    const slots = controlSlots(paragraph);
    const slot = slots[step.controlIndex];
    if (slot === undefined) return { reason: REASONS.controlNotFound, trail };
    // 이 컨트롤이나 그보다 앞의 컨트롤이 규칙에 없는 종류이면 색인을 믿을 수 없다
    if (!slot.known || slots.slice(0, step.controlIndex).some((s) => !s.known)) return { reason: REASONS.controlUnknown, trail };
    if (slot.cells === undefined && slot.textboxes.length === 0 && slot.captions.length === 0) return { reason: REASONS.controlNotContainer, trail };
    // 한 컨트롤에 글상자가 여럿(묶음 개체)이면 rhwp는 어느 글상자의 글이든 `cellIndex`를 0으로 낸다 [실행 관측] — 글상자를 정할 수 없다
    if (slot.cells === undefined && slot.textboxes.length > 1 && step.cellIndex !== TABLE_CAPTION_CELL) return { reason: REASONS.textboxAmbiguous, trail };
    const found = subListOf(slot, step.cellIndex);
    if (found === undefined) return { reason: REASONS.cellNotFound, trail };
    const next = found.sub.paragraphs[step.cellParaIndex];
    if (next === undefined) return { reason: REASONS.cellParagraphNotFound, trail };
    trail.push(found.caption ? `${slot.kind}:caption` : slot.kind);
    path.push(paragraph.subLists.indexOf(found.sub), step.cellParaIndex);
    paragraph = next;
  }
  return { paragraph, path, trail };
}

function resolveParagraph(section: SectionModel, pos: RhwpPosition): Step | StepFail {
  const steps = pos.cellPath ?? [];
  if (steps.length === 0) {
    const paragraph = section.paragraphs[pos.paragraphIndex];
    return paragraph === undefined ? { reason: REASONS.paragraphNotFound, trail: [] } : { paragraph, path: [pos.paragraphIndex], trail: [] };
  }
  if (pos.parentParaIndex === undefined) return { reason: REASONS.parentMissing, trail: [] };
  const top = section.paragraphs[pos.parentParaIndex];
  if (top === undefined) return { reason: REASONS.paragraphNotFound, trail: [] };
  const found = descend(top, steps, [pos.parentParaIndex]);
  if ("reason" in found) return found;
  // 표 캡션 문단은 `paragraphIndex`를 항상 0으로 낸다(캡션의 둘째 문단에서 관측). 경로의 마지막 단계가 문단 번호를 정한다
  const last = steps[steps.length - 1];
  if (last?.cellIndex !== TABLE_CAPTION_CELL && last?.cellParaIndex !== pos.paragraphIndex) return { reason: REASONS.pathInconsistent, trail: found.trail };
  return found;
}

// 글자 겹침이 그려지는 사설 영역 글자
const isPrivateUse = (cp: number): boolean => (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd);
const privateOnly = (s: string): boolean => s !== "" && [...s].every((c) => isPrivateUse(c.codePointAt(0) ?? 0));

/**
 * 안내문(`guide`)을 누른 빈 런의 순번 `slot`이 가리키는 안내문 상태 누름틀의 경계(`at`). 없으면 undefined.
 * 같은 글의 안내문이 정확히 그 순번에 있으면 그것이다. rhwp는 빈 런의 첫 글자 순번을 앞의 개체(글자처럼 취급 그림 등)를 덜 세어 내기도 하므로,
 * 같은 글의 안내문이 문단에 하나뿐일 때만 순번이 `[at - 앞 개체 수, at]` 안에 들면 그 안내문으로 본다(둘 이상이면 어느 쪽인지 알 수 없어 정확히 같은 순번만 받는다).
 */
function guideSlot(table: OffsetTable, guide: string, slot: number): number | undefined {
  const same = table.guides.filter((g) => g.text === guide);
  const exact = same.find((g) => g.at === slot);
  if (exact !== undefined) return exact.at;
  const only = same.length === 1 ? same[0] : undefined;
  if (only === undefined) return undefined;
  const objects = table.slots.slice(0, only.at).filter((s) => s.shown === "").length;
  return slot >= only.at - objects && slot <= only.at ? only.at : undefined;
}

type Confirmed = { ok: true; /** 런의 첫 글자의 칸 순번(개체를 모두 센 순번) */ start: number } | { ok: false; reason: string; paragraphWrong: boolean };

/** 런에 객체 자리 글자(U+FFFC)가 들어 있는가. rhwp가 개체를 글자처럼 그린 런(개체가 셋 이상 이어질 때 나온다)이며 엔진의 글과 대조할 수 없다. */
const hasObjectChar = (s: string): boolean => s.includes("\ufffc");

/**
 * `shown`(런의 글과 첫 글자의 rhwp 순번)이 문단의 어느 엔진 글자에서 시작하는지 정한다.
 *
 * rhwp의 쪽 글자 배치는 런의 첫 글자 순번을 개체(글자처럼 취급 그림·도형·수식)를 세는 정도가 런마다 다르게 낸다: 같은 글꼴의 글이 개체로 나뉠 때는
 * 앞의 개체를 모두 세지만, 글꼴이나 글자 모양이 바뀐 새 런은 앞 개체를 덜 세거나 세지 않는다 [실행 관측]. 그래서 칸 순번과 정확히 같은지를 보지 않고,
 * 런의 글이 엔진의 글 칸(`chars`)에서 `L`번째부터 그대로 이어지고, 그 안에 개체가 끼지 않고, 순번이 `[L, L + 앞 개체 수]` 안에 있는 자리를 찾는다.
 * 그런 자리가 하나뿐일 때만 정하고, 없으면 글이 다르다는 사유를, 둘 이상이면 `AMBIGUOUS_RUN`을 돌려준다(문단 단위로 내려간다).
 */
function confirm(table: OffsetTable, pos: RhwpPosition, shown: Shown): Confirmed {
  const n = codePointLength(shown.text);
  const delta = pos.charOffset - shown.start;
  const range = { ok: false, reason: REASONS.shownRange, paragraphWrong: false } as const;
  if (!Number.isInteger(shown.start) || shown.start < 0) return range;
  const first = table.slots[shown.start];
  // 글자 겹침: 한 칸이 겹친 글(또는 사설 영역 글자) 여러 개로 그려진다
  if (first?.private === true && (shown.text === first.composeText || privateOnly(shown.text))) return delta >= 0 && delta <= 1 ? { ok: true, start: shown.start } : range;
  if (delta < 0 || delta > n) return range;
  if (n === 0) return shown.start <= table.slots.length ? { ok: true, start: shown.start } : { ok: false, reason: REASONS.textMismatch, paragraphWrong: false };
  if (hasObjectChar(shown.text)) return { ok: false, reason: REASONS.objectRun, paragraphWrong: false };

  const run = Array.from(shown.text);
  const chars = table.chars;
  const found: number[] = [];
  for (let l = 0; l + n <= chars.length; l++) {
    const head = chars[l];
    const tail = chars[l + n - 1];
    if (head === undefined || tail === undefined || tail.objBefore !== head.objBefore) continue;
    if (shown.start < l || shown.start > l + head.objBefore) continue;
    let same = true;
    for (let j = 0; j < n; j++) {
      if (table.slots[chars[l + j]?.slot ?? -1]?.shown !== run[j]) {
        same = false;
        break;
      }
    }
    if (same) found.push(head.slot);
  }
  if (found.length === 1) return { ok: true, start: found[0] ?? 0 };
  if (found.length > 1) return { ok: false, reason: REASONS.ambiguousRun, paragraphWrong: false };
  const projected = chars.map((c) => table.slots[c.slot]?.shown ?? "").join("");
  return projected.includes(shown.text)
    ? { ok: false, reason: REASONS.textMismatch, paragraphWrong: false }
    : { ok: false, reason: REASONS.paragraphMismatch, paragraphWrong: true };
}

/**
 * rhwp 위치를 엔진 주소로 옮긴다.
 * - 문단: 본문이면 `path = [paragraphIndex]`, `cellPath`가 있으면 단계마다 컨트롤 색인(`controlSlots`)으로 표 셀·글상자·캡션을 찾아 내려간다.
 * - 확인과 오프셋: `shown`(런의 글과 그 첫 글자의 rhwp 순번)을 주면, 런의 글이 엔진 글의 어느 자리에서 시작하는지 정하고(`confirm`: 글이 같고 순번이
 *   개체 수가 허용하는 구간 안인 자리가 하나뿐일 때) 누른 위치를 그 런 기준으로 옮긴다. 정하지 못하면 글자 위치를 버리고 `precision: "paragraph"`와
 *   사유(`TEXT_MISMATCH`: 글이 다르다, `AMBIGUOUS_RUN`: 같은 글이 허용 구간에 둘 이상, `OBJECT_RUN`: 개체를 글자처럼 그린 런 등)로 내려간다.
 *   런의 글이 문단 글 어디에도 없으면 문단 자체를 믿을 수 없으므로 `precision: "none"`(`PARAGRAPH_MISMATCH`)이다.
 *   `shown`을 주지 않으면 글 확인 없이 rhwp 글자 순번을 대응표(`offsetTable`)로 그대로 옮긴다.
 * - `edge`: 폭 0 객체 자리 글자나 안내문 상태 누름틀이 끼어 있을 때 어느 쪽으로 옮길지(범위의 시작은 `"start"`, 끝은 `"end"`, 안내문을 눌렀으면 `"guide"`).
 * - `guide`: 문서 좌표 없이 그려진 안내문 글을 눌렀다(`pos`·`shown`은 그 자리의 빈 런). 그 자리에 같은 글의 안내문 상태 누름틀이 있을 때만 옮기고,
 *   없으면 그 글은 위치를 정할 수 없는 글이므로 `precision: "none"`(`UNPOSITIONED_TEXT`)이다.
 * - 칸 수를 모르는 개체 뒤, 범위 밖의 위치도 문단으로 내려간다.
 * - 구역은 rhwp와 엔진이 같은 순서(`content.hpf`의 spine)로 세므로 번호를 그대로 쓴다. 구역이나 문단을 찾지 못하면 `precision: "none"`.
 */
export function toEngineAddress(doc: HwpxDocument, pos: RhwpPosition, shown?: Shown, edge: LocateEdge = "start", guide?: string): Located | Unlocated {
  const section = doc.sections[pos.sectionIndex];
  if (section === undefined) return { precision: "none", reason: REASONS.sectionNotFound, trail: [] };
  const found = resolveParagraph(section, pos);
  if ("reason" in found) return { precision: "none", reason: found.reason, trail: found.trail };

  const address: EngineAddress = { sectionIndex: pos.sectionIndex, path: found.path };
  const down = (reason: string): Located => ({ address, precision: "paragraph", reason, trail: found.trail });
  const table = offsetTable(found.paragraph);

  // 엔진 칸 순번으로 옮긴 누른 위치
  let slot = pos.charOffset;
  // 런이 차지한 칸의 끝(런 시작 + 글자 수). 누른 위치가 아니라 런 전체가 믿을 수 있는 칸 안에 있어야 한다
  let runEnd = slot;
  if (shown !== undefined) {
    const checked = confirm(table, pos, shown);
    if (!checked.ok) {
      if (!checked.paragraphWrong) return down(checked.reason);
      // 런의 글이 문단 글에 없다. 번호 글의 런이면 문단은 맞다: 문단모양의 번호·글머리표(문단 처음에서 시작), 자동 번호 컨트롤 자리,
      // 각주·미주 컨트롤 자리에서 시작하는 런(컨트롤이 그려 낸 번호 글)
      const startSlot = table.slots[shown.start];
      const atAutoNumber = startSlot?.kind === "object" && startSlot.shown === " ";
      const atNote = noteLabelStarts(found.paragraph).some((r) => shown.start >= r.from && shown.start <= r.to);
      if (atAutoNumber || atNote || (shown.start === 0 && hasNumbering(doc, found.paragraph))) return down(REASONS.labelRun);
      return { precision: "none", reason: checked.reason, trail: found.trail };
    }
    slot = checked.start + (pos.charOffset - shown.start);
    runEnd = checked.start + codePointLength(shown.text);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot > table.slots.length) return down(REASONS.offsetOutOfRange);
  const guideAt = guide === undefined ? undefined : guideSlot(table, guide, slot);
  if (guideAt !== undefined) {
    slot = guideAt;
    runEnd = guideAt;
  }
  if (table.untrustedReason !== undefined && (slot > table.trusted || runEnd > table.trusted)) {
    return down(`${REASONS.widthUnknown}:${table.untrustedReason}`);
  }
  if (guide !== undefined && guideAt === undefined) return { precision: "none", reason: REASONS.unpositionedText, trail: found.trail };
  const offset = logicalOffsetAt(table, slot, edge);
  if (offset === undefined) return down(REASONS.offsetOutOfRange);
  return { address: { ...address, offset }, precision: "char", trail: found.trail };
}

/**
 * 눌린 점(뷰어 화면의 `ViewerDocument.pick` 결과)을 엔진 주소로 옮긴다. `toEngineAddress`에 더해:
 * - `shown`(확인할 런)이 없으면 글자 위치를 확인하지 못한 것이므로 문단 단위로 내린다(`NO_SHOWN_RUN`).
 * - `limit: "paragraph"`이면 글을 확인하고도 문단 단위로만 낸다(사유는 `reason`). 엔진 문단 자체가 확인되지 않으면(`PARAGRAPH_MISMATCH`) `none`이다.
 * - `guide`가 있으면 안내문 글을 누른 것이다(`toEngineAddress`의 `guide`).
 * - `trailing`이면 글자 뒤쪽 절반을 눌러 캐럿이 글자 바로 뒤에 놓인 것이다(`edge`가 `start`일 때 `trail`로 옮긴다: 안내문 상태 누름틀 바로 앞 경계는 누름틀 시작 표식 앞).
 */
export function locatePicked(doc: HwpxDocument, point: PickedPoint, edge: LocateEdge = "start"): Located | Unlocated {
  const guide = point.guide;
  const wanted: LocateEdge = guide !== undefined ? "guide" : point.trailing === true && edge === "start" ? "trail" : edge;
  const result = toEngineAddress(doc, point.position, point.shown, wanted, guide);
  if (result.precision === "none") return result;
  const lowered = (reason: string): Located => ({ address: { sectionIndex: result.address.sectionIndex, path: result.address.path }, precision: "paragraph", reason, trail: result.trail });
  if (result.precision === "char" && point.shown === undefined) return lowered("NO_SHOWN_RUN");
  if (point.limit === "paragraph") return lowered(point.reason ?? REASONS.limited);
  return result;
}

/**
 * 엔진 주소를 rhwp 위치로 옮긴다. 주소가 가리키는 문단이 표 셀·글상자·캡션 밖(머리말·꼬리말·각주 등)이거나 없으면 undefined.
 * `offset`이 없으면 문단 처음(0)이다. `offset`이 글자 묶음 안쪽(대리쌍 가운데)이거나 대응표를 믿을 수 없는 자리면 undefined.
 */
export function toRhwpPosition(doc: HwpxDocument, address: EngineAddress): RhwpPosition | undefined {
  const section = doc.sections[address.sectionIndex];
  const path = address.path;
  if (section === undefined || path.length === 0 || path.length % 2 === 0) return undefined;
  const top = section.paragraphs[path[0] ?? -1];
  if (top === undefined) return undefined;

  let paragraph = top;
  const cellPath: CellStep[] = [];
  for (let n = 1; n < path.length; n += 2) {
    const sub = paragraph.subLists[path[n] ?? -1];
    const next = sub?.paragraphs[path[n + 1] ?? -1];
    if (sub === undefined || next === undefined) return undefined;
    const slots = controlSlots(paragraph);
    const slot = slots.find((s) => s.subLists.includes(sub));
    if (slot === undefined || !slot.known || slots.slice(0, slot.index).some((s) => !s.known)) return undefined;
    if (slot.cells === undefined && slot.textboxes.length > 1) return undefined;
    let cellIndex: number;
    if (slot.cells !== undefined) cellIndex = sub === slot.captions[0] ? TABLE_CAPTION_CELL : slot.cells.findIndex((c) => c.subList === sub);
    else if (slot.textboxes.includes(sub)) cellIndex = slot.textboxes.indexOf(sub);
    else cellIndex = sub === slot.captions[0] ? 0 : -1;
    if (cellIndex < 0) return undefined;
    cellPath.push({ controlIndex: slot.index, cellIndex, cellParaIndex: path[n + 1] ?? 0 });
    paragraph = next;
  }

  const table = offsetTable(paragraph);
  let charOffset = 0;
  if (address.offset !== undefined) {
    const k = rhwpOffsetAt(table, address.offset);
    if (k === undefined || (table.untrustedReason !== undefined && k > table.trusted)) return undefined;
    charOffset = k;
  }
  if (cellPath.length === 0) return { sectionIndex: address.sectionIndex, paragraphIndex: path[0] ?? 0, charOffset };
  return {
    sectionIndex: address.sectionIndex,
    paragraphIndex: cellPath[cellPath.length - 1]?.cellParaIndex ?? 0,
    charOffset,
    parentParaIndex: path[0] ?? 0,
    cellPath,
  };
}

/** 엔진 주소가 가리키는 문단. 없으면 undefined. */
export function paragraphAtAddress(doc: HwpxDocument, address: EngineAddress): ParagraphNode | undefined {
  const path = address.path;
  if (path.length % 2 === 0) return undefined;
  let paragraph = doc.sections[address.sectionIndex]?.paragraphs[path[0] ?? -1];
  for (let n = 1; n < path.length && paragraph !== undefined; n += 2) {
    paragraph = paragraph.subLists[path[n] ?? -1]?.paragraphs[path[n + 1] ?? -1];
  }
  return paragraph;
}

/**
 * 렌더 트리의 표 경로(`CellRef`: 표를 담은 문단 번호·컨트롤 번호·눌린 칸의 행·열)가 가리키는 엔진 칸. 칸 안 첫 문단 앞까지의 엔진 경로(`prefix`: `[문단, 하위목록, …]`)와 칸의 하위 목록.
 * 칸은 rhwp의 칸 색인이 아니라 엔진 모델의 행·열로 찾는다(rhwp의 칸 색인은 표에 따라 병합 칸 뒤에서 어긋난다).
 */
function resolveCell(doc: HwpxDocument, ref: CellRef): { prefix: number[]; trail: string[]; sub: SubListNode } | StepFail {
  const section = doc.sections[ref.sectionIndex];
  if (section === undefined) return { reason: REASONS.sectionNotFound, trail: [] };
  const prefix: number[] = [];
  const trail: string[] = [];
  let sub: SubListNode | undefined;
  for (const step of ref.steps) {
    const owner = (sub === undefined ? section.paragraphs : sub.paragraphs)[step.paragraph];
    if (owner === undefined) return { reason: REASONS.paragraphNotFound, trail };
    const slots = controlSlots(owner);
    const slot = slots[step.control];
    if (slot === undefined) return { reason: REASONS.controlNotFound, trail };
    if (!slot.known || slots.slice(0, step.control).some((s) => !s.known)) return { reason: REASONS.controlUnknown, trail };
    if (slot.cells === undefined) return { reason: REASONS.controlNotContainer, trail };
    const cell = slot.cells.find((c) => c.row === step.row && c.col === step.col);
    if (cell?.subList == null) return { reason: REASONS.cellNotFound, trail };
    prefix.push(step.paragraph, owner.subLists.indexOf(cell.subList));
    trail.push(slot.kind);
    sub = cell.subList;
  }
  return sub === undefined ? { reason: REASONS.cellNotFound, trail } : { prefix, trail, sub };
}

/**
 * 빈 곳을 누른 표 칸의 문단. 칸(`cell`)은 렌더 트리의 표 경로로, 엔진 모델의 표·행·열에서 찾는다.
 * - 칸 안 줄 후보(`cell.runs`, 점에 가까운 줄부터)를 차례로 `locatePicked`로 엔진 문단에 옮겨 보고, 그 문단이 위에서 찾은 칸 안의 문단인 첫 후보를 쓴다. `paragraph`(`NEAREST_LINE`).
 *   후보가 칸 안 안쪽 표·글상자의 글이면(엔진 주소가 칸 문단보다 깊다) 그것을 담은 칸 문단이 칸의 줄이다.
 *   - 글이 빈 후보는 확인할 글이 없다: 다른 칸의 문단으로 옮겨지거나 옮겨지지 않으면 건너뛴다(rhwp가 폭이 좁은 빈 칸의 빈 런을 이웃 칸 자리에 그리는 것이 관측됐다).
 *   - 글 있는 후보는 글이 증거다: 엔진 문단의 글과 달라 옮겨지지 않으면(`none`) 그 결과를, 다른 칸의 문단으로 옮겨지면 `none`(`CELL_MISMATCH`)을 낸다 —
 *     렌더 트리의 칸(행·열)과 그 사각형 안에 그려진 글의 칸이 다르면 칸과 글의 위치가 어긋난 표이므로 더 먼 줄이나 칸의 첫 문단으로 바꾸지 않는다.
 * - 이 칸의 후보가 없으면(글이 없는 표, 후보가 모두 글이 빈 다른 칸의 런) 그 칸의 첫 문단이다. `paragraph`(`NEAREST_LINE`).
 */
export function locateInCell(doc: HwpxDocument, cell: CellRef): Located | Unlocated {
  const found = resolveCell(doc, cell);
  if ("reason" in found) return { precision: "none", reason: found.reason, trail: found.trail };
  const { prefix, trail, sub } = found;
  for (const run of cell.runs ?? []) {
    const located = locatePicked(doc, { position: run.position, shown: run.shown, limit: "paragraph", reason: REASONS.nearestLine });
    const text = run.shown.text !== "";
    if (located.precision === "none") {
      if (text) return located;
      continue;
    }
    const path = located.address.path;
    if (located.address.sectionIndex === cell.sectionIndex && path.length > prefix.length && prefix.every((v, i) => path[i] === v)) {
      if (path.length === prefix.length + 1) return located;
      // 칸 문단 안 안쪽 표·글상자의 글: 그것을 담은 칸 문단
      return { address: { sectionIndex: cell.sectionIndex, path: path.slice(0, prefix.length + 1) }, precision: "paragraph", reason: REASONS.nearestLine, trail };
    }
    if (text) return { precision: "none", reason: REASONS.cellMismatch, trail: located.trail };
  }
  if (sub.paragraphs[0] === undefined) return { precision: "none", reason: REASONS.cellParagraphNotFound, trail };
  return { address: { sectionIndex: cell.sectionIndex, path: [...prefix, 0] }, precision: "paragraph", reason: REASONS.nearestLine, trail };
}
