import type { ParagraphNode } from "./types.ts";

// 글자 묶음(grapheme cluster) 나누기. 묶음 규칙은 로케일에 따라 달라지지 않는다.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 문단의 논리 텍스트에서 글자 묶음의 경계(UTF-16 오프셋, 0과 글 길이 포함)를 모은다.
 * 결합 부호(`e` + U+0301), 이모지 ZWJ 묶음, 옛한글 조합 자모 묶음처럼 화면에서 한 글자로 그려지는 것은 한 묶음이다.
 * 묶음은 run·`hp:t` 경계를 가로지른다(서식이 달라도 한 글자로 그려지므로).
 * 폭이 있는 경계 조각(탭·줄바꿈 같은 인라인 요소, 객체 자리 문자)은 각각 하나의 묶음이라 앞뒤 글과 묶이지 않는다.
 */
export function clusterBoundaries(paragraph: ParagraphNode): Set<number> {
  const text = paragraph.logicalText;
  const cuts = new Set<number>([0, text.length]);
  for (const piece of paragraph.pieces) {
    if ((piece.kind === "inline" || piece.kind === "object") && piece.logicalEnd > piece.logicalStart) {
      cuts.add(piece.logicalStart);
      cuts.add(piece.logicalEnd);
    }
  }
  const sorted = [...cuts].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const boundaries = new Set<number>(sorted);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i] ?? 0;
    const to = sorted[i + 1] ?? from;
    for (const segment of segmenter.segment(text.slice(from, to))) boundaries.add(from + segment.index);
  }
  return boundaries;
}
