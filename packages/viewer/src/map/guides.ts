import { attrValue, fieldTypeOf, isElement, subElements, type ParagraphNode, type XElement } from "../../../hwpx-engine/src/index.ts";

/**
 * 안내문 상태의 누름틀: rhwp는 시작과 끝 사이의 글이 `Command` 매개변수의 안내문(`Direction:wstring:길이:글`)과 같고
 * `dirty`가 "1"이 아니면 그 글을 문단 글로 세지 않고(글자 순번에 칸이 없다) 좌표 없는 런으로 따로 그린다 [실행 관측].
 * 값을 채웠거나(`dirty="1"`) 안내문과 다른 글이면 보통 글이다. 조건은 `CLICK_HERE` 형식의 누름틀에만 적용된다(종류는 엔진의 `fieldTypeOf`와 같이 대소문자를 무시해 가린다. `clickhere`도 누름틀이다).
 * 시작과 끝 사이에 글이 없으면(`hp:t`가 없거나 빈 `hp:t`) `dirty`와 관계없이 안내문을 그린다 [실행 관측: `dirty="0"`·`"1"` 모두]. 이때 안내문 글 구간은 비어 있고
 * (칸이 없다), 안내문 글 자체는 `text`다.
 */
export type GuideField = {
  beginPiece: number;
  endPiece: number;
  /** 시작과 끝 사이의 글 조각 번호 */
  textPieces: number[];
  /** 안내문 글 구간(엔진 논리 텍스트, UTF-16). 시작과 끝 사이에 글이 없으면 비어 있다(`logicalStart === logicalEnd`) */
  logicalStart: number;
  logicalEnd: number;
  /** `Command`의 안내문 글(쪽 글자 배치의 좌표 없는 런의 글과 같다) */
  text: string;
};

function commandOf(begin: XElement): string | undefined {
  for (const params of subElements(begin)) {
    if (params.local !== "parameters") continue;
    for (const p of subElements(params)) {
      if (p.local === "stringParam" && attrValue(p, "name") === "Command") {
        return p.children.map((c) => (isElement(c) ? "" : c.value)).join("");
      }
    }
  }
  return undefined;
}

const DIRECTION = /Direction:wstring:(\d+):/;

/** `Command` 문자열에서 안내문을 꺼낸다. 없으면 undefined. */
export function guideOf(command: string): string | undefined {
  const m = DIRECTION.exec(command);
  if (m === null) return undefined;
  const from = m.index + m[0].length;
  return command.slice(from, from + Number(m[1]));
}

const cache = new WeakMap<ParagraphNode, GuideField[]>();

/** 문단 안의 안내문 상태 누름틀을 문서 순서로 찾는다. */
export function guideFields(paragraph: ParagraphNode): GuideField[] {
  const hit = cache.get(paragraph);
  if (hit !== undefined) return hit;
  const out: GuideField[] = [];
  for (const begin of paragraph.fieldMarks) {
    if (begin.kind !== "begin" || fieldTypeOf(begin.type) !== "CLICK_HERE") continue;
    const end = paragraph.fieldMarks.find((m) => m.kind === "end" && m.beginIDRef === begin.id && m.pieceIndex > begin.pieceIndex);
    if (end === undefined) continue;
    const command = commandOf(begin.element);
    const guide = command === undefined ? undefined : guideOf(command);
    if (guide === undefined || guide === "") continue;
    const between = paragraph.pieces.slice(begin.pieceIndex + 1, end.pieceIndex);
    if (between.some((p) => p.kind !== "text" && p.kind !== "entity")) continue;
    const first = between[0];
    const last = between[between.length - 1];
    const content = first === undefined || last === undefined ? "" : paragraph.logicalText.slice(first.logicalStart, last.logicalEnd);
    // 글이 있으면 안내문과 같고 `dirty`가 "1"이 아닐 때만, 글이 비어 있으면 언제나 안내문 상태다
    if (content !== "" && (begin.dirty === "1" || content !== guide)) continue;
    const at = paragraph.pieces[begin.pieceIndex]?.logicalEnd ?? 0;
    out.push({
      beginPiece: begin.pieceIndex,
      endPiece: end.pieceIndex,
      textPieces: between.map((_, i) => begin.pieceIndex + 1 + i),
      logicalStart: content === "" ? at : (first?.logicalStart ?? at),
      logicalEnd: content === "" ? at : (last?.logicalEnd ?? at),
      text: guide,
    });
  }
  cache.set(paragraph, out);
  return out;
}
