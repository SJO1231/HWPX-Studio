import type { ParagraphNode } from "../../../hwpx-engine/src/index.ts";
import { guideFields } from "./guides.ts";
import { controlSlots } from "./slots.ts";
import type { LocateEdge } from "./types.ts";

/** rhwp 글자 순번 한 칸. 순번은 `OffsetTable.slots`의 색인이다. */
export type OffsetSlot = {
  /** 이 칸이 가리키는 엔진 논리 텍스트 구간(UTF-16) */
  logicalStart: number;
  logicalEnd: number;
  kind: "text" | "inline" | "object";
  /** 글자 겹침 칸: 런에는 겹친 글(또는 사설 영역 글자)이 한 칸보다 길게 그려진다 */
  private?: true;
  composeText?: string;
  /** rhwp가 쪽 글자 배치의 런 글에 그 칸으로 넣는 글. 글자·탭·줄바꿈은 그 글자, 자동 번호는 공백, 글자처럼 취급 개체는 빈 문자열 */
  shown: string;
};

export type OffsetTable = {
  slots: OffsetSlot[];
  /** 앞에서부터 이 칸 수까지는 믿을 수 있다(전체이면 `slots.length`). 그 뒤 칸의 순번은 알 수 없는 개체 때문에 어긋날 수 있다 */
  trusted: number;
  /** `trusted`가 `slots.length`보다 작은 사유 */
  untrustedReason?: string;
  /** 문단 논리 텍스트의 길이 */
  logicalLength: number;
  /**
   * 글을 내는 칸(글자·탭·줄바꿈·자동 번호의 공백)만 순서대로 모은 목록. `slot`은 `slots`의 색인, `objBefore`는 그 앞에 있는 글자처럼 취급 개체(칸 폭 1,
   * 글을 내지 않는 칸)의 수다. rhwp의 쪽 글자 배치는 런의 첫 글자 순번(`charStart`)을 `slot - objBefore`(개체를 세지 않은 글자 순번)와
   * `slot`(개체를 모두 센 칸 순번) 사이의 값으로 내며(런 나뉨에 따라 다르다) 이 구간이 런을 엔진 글자에 맞추는 근거다 [실행 관측: 무작위 합성 문서 수천 런].
   */
  chars: { slot: number; objBefore: number }[];
  /**
   * 안내문 상태 누름틀의 안내문 글 구간. rhwp는 이 글을 문단 글로 세지 않으므로 칸이 없다.
   * `at`은 그 누름틀이 놓인 rhwp 글자 순번(경계)이다. `text`는 안내문 글이다(시작과 끝 사이에 글이 없으면 구간은 비어 있다).
   */
  guides: { at: number; logicalStart: number; logicalEnd: number; text: string }[];
};

const cache = new WeakMap<ParagraphNode, OffsetTable>();

/**
 * 엔진 논리 오프셋(UTF-16)과 rhwp 글자 순번의 대응표를 문단의 조각을 차례로 훑어 만든다.
 * - 글 조각: 유니코드 글자 하나가 한 칸(대리쌍도 한 칸). 단, 안내문 상태 누름틀의 안내문 글은 칸이 없다.
 * - 탭·줄바꿈·고정폭 공백·붙임표 같은 인라인 요소: 한 칸. 글을 내지 않는 인라인 요소(`markpenBegin` 등)는 칸이 없다.
 * - 객체 조각: 그 안의 컨트롤들의 칸 수를 더한 만큼. 0이면 칸이 없고(엔진 쪽에는 객체 자리 글자 하나가 남는다), 1이면 한 칸이다.
 *   칸 수를 모르거나 2 이상인 객체를 만나면 그 앞까지만 `trusted`로 친다.
 */
export function offsetTable(paragraph: ParagraphNode): OffsetTable {
  const hit = cache.get(paragraph);
  if (hit !== undefined) return hit;

  const widthByPiece = new Map<number, { width: number; unknown: string | undefined; autoNum: boolean; private: boolean; composeText?: string }>();
  for (const slot of controlSlots(paragraph)) {
    const cur = widthByPiece.get(slot.host.pieceIndex) ?? { width: 0, unknown: undefined, autoNum: false, private: false };
    if (slot.width === undefined) cur.unknown ??= slot.kind;
    else cur.width += slot.width;
    if (slot.kind === "autoNum") cur.autoNum = true;
    if (slot.private === true) cur.private = true;
    if (slot.composeText !== undefined) cur.composeText = slot.composeText;
    widthByPiece.set(slot.host.pieceIndex, cur);
  }

  const text = paragraph.logicalText;
  const guidePieces = new Set<number>();
  const guideAt = new Map<number, number>();
  const guideList = guideFields(paragraph);
  for (const g of guideList) {
    for (const pi of g.textPieces) guidePieces.add(pi);
    guideAt.set(g.beginPiece, guideList.indexOf(g));
  }
  const guides: OffsetTable["guides"] = [];
  const slots: OffsetSlot[] = [];
  let trusted: number | undefined;
  let untrustedReason: string | undefined;
  const distrust = (reason: string): void => {
    if (trusted === undefined) {
      trusted = slots.length;
      untrustedReason = reason;
    }
  };

  paragraph.pieces.forEach((piece, pi) => {
    const guide = guideAt.get(pi);
    if (guide !== undefined) {
      const g = guideList[guide];
      if (g !== undefined) guides.push({ at: slots.length, logicalStart: g.logicalStart, logicalEnd: g.logicalEnd, text: g.text });
    }
    if (guidePieces.has(pi)) return;
    if (piece.kind === "text" || piece.kind === "entity") {
      let at = piece.logicalStart;
      for (const ch of text.slice(piece.logicalStart, piece.logicalEnd)) {
        slots.push({ logicalStart: at, logicalEnd: at + ch.length, kind: "text", shown: ch });
        at += ch.length;
      }
    } else if (piece.kind === "inline") {
      if (piece.logicalEnd > piece.logicalStart) {
        slots.push({
          logicalStart: piece.logicalStart,
          logicalEnd: piece.logicalEnd,
          kind: "inline",
          shown: text.slice(piece.logicalStart, piece.logicalEnd),
        });
      }
    } else {
      const w = widthByPiece.get(pi) ?? { width: 0, unknown: undefined, autoNum: false, private: false };
      if (w.unknown !== undefined) distrust(w.unknown);
      else if (w.width > 1) distrust("WIDTH_MANY");
      else if (w.width === 1) {
        const slot: OffsetSlot = { logicalStart: piece.logicalStart, logicalEnd: piece.logicalEnd, kind: "object", shown: w.autoNum ? " " : "" };
        if (w.private) slot.private = true;
        if (w.composeText !== undefined) slot.composeText = w.composeText;
        slots.push(slot);
      }
    }
  });

  const chars: OffsetTable["chars"] = [];
  let objects = 0;
  slots.forEach((s, i) => {
    if (s.shown !== "") chars.push({ slot: i, objBefore: objects });
    else objects++;
  });
  const table: OffsetTable = { slots, trusted: trusted ?? slots.length, logicalLength: text.length, guides, chars };
  if (untrustedReason !== undefined) table.untrustedReason = untrustedReason;
  cache.set(paragraph, table);
  return table;
}

/**
 * rhwp 글자 순번 `k`(칸 사이의 경계, 0..칸 수)를 엔진 논리 오프셋으로 옮긴다.
 * 칸 사이에 객체 자리 글자(rhwp에서는 폭 0)가 끼어 있으면 두 가지 오프셋이 가능하다.
 * `edge: "start"`(기본)는 다음 칸의 글자 바로 앞(객체 자리 글자를 건너뛴 뒤), `"end"`는 앞 칸의 글자 바로 뒤(객체 자리 글자 앞)다.
 * `edge: "guide"`는 경계 `k`에 안내문 상태 누름틀이 있을 때 그 안내문 글의 시작(누름틀 안)이다(rhwp는 안내문을 글자 칸 없이 따로 그리므로,
 * 안내문을 눌렀다는 것을 호출한 쪽이 알려 줄 때 쓴다). 그런 누름틀이 없으면 `"start"`와 같다.
 * `edge: "trail"`은 글자 사각형의 뒤쪽 절반을 눌러 캐럿이 그 글자 바로 뒤에 놓인 경우다: 경계 `k`에 안내문 상태 누름틀이 있으면 누름틀 시작 표식 앞(누름틀 밖, 앞 글자 바로 뒤)이고,
 * 없으면 `"start"`와 같다(값이 든 누름틀·다른 객체 경계의 동작은 바꾸지 않는다). 안내문 뒤 글자의 앞쪽 절반(`"start"`)은 누름틀 끝 표식 뒤다.
 * 범위를 벗어나면 undefined.
 */
export function logicalOffsetAt(table: OffsetTable, k: number, edge: LocateEdge = "start"): number | undefined {
  const n = table.slots.length;
  if (!Number.isInteger(k) || k < 0 || k > n) return undefined;
  if (edge === "guide") {
    const g = table.guides.find((x) => x.at === k);
    if (g !== undefined) return g.logicalStart;
  }
  if (edge === "trail" && table.guides.some((x) => x.at === k)) return k === 0 ? 0 : table.slots[k - 1]?.logicalEnd;
  if (edge === "start" || edge === "guide" || edge === "trail") return k === n ? table.logicalLength : table.slots[k]?.logicalStart;
  return k === 0 ? 0 : table.slots[k - 1]?.logicalEnd;
}

/**
 * 엔진 논리 오프셋을 rhwp 글자 순번으로 옮긴다. 칸 안쪽(대리쌍 가운데 등)이거나 범위 밖이면 undefined.
 * 폭 0 객체 자리 글자의 앞과 뒤는 같은 순번이 된다.
 */
export function rhwpOffsetAt(table: OffsetTable, logical: number): number | undefined {
  if (!Number.isInteger(logical) || logical < 0 || logical > table.logicalLength) return undefined;
  // logicalEnd <= logical 인 칸의 수를 이진 탐색으로 센다
  let lo = 0;
  let hi = table.slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((table.slots[mid]?.logicalEnd ?? Infinity) <= logical) lo = mid + 1;
    else hi = mid;
  }
  const next = table.slots[lo];
  if (next !== undefined && next.logicalStart < logical) return undefined;
  return lo;
}

/**
 * 각주·미주 컨트롤이 놓인 자리의 rhwp 글자 순번 구간들. rhwp는 각주·미주의 번호 글(`6) ` 같은 것)을 그 컨트롤이 놓인 문단의 문서 좌표로 그린다
 * [실행 관측: 미주가 쪽 아래에 놓일 때]. 구간은 `[개체를 세지 않은 글자 순번, 개체를 모두 센 칸 순번]`이다(런마다 개체를 세는 정도가 달라서).
 */
export function noteLabelStarts(paragraph: ParagraphNode): { from: number; to: number }[] {
  const table = offsetTable(paragraph);
  const out: { from: number; to: number }[] = [];
  for (const slot of controlSlots(paragraph)) {
    if (slot.kind !== "footNote" && slot.kind !== "endNote") continue;
    const at = paragraph.pieces[slot.host.pieceIndex]?.logicalStart ?? 0;
    const to = table.slots.filter((s) => s.logicalStart < at).length;
    const from = table.chars.filter((c) => (table.slots[c.slot]?.logicalStart ?? 0) < at).length;
    out.push({ from, to });
  }
  return out;
}
