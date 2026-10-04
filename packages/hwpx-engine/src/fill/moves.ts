import type { AnchorAt } from "../template/types.ts";
import type { Move } from "./anchor-types.ts";

// 이동표(7.10): 구조 변경이 문단 번호를 어떻게 옮기는지. 좌표는 모두 편집 전(원본) 문서의 것이다.

/** 이동표 항목을 만든다. `count`는 `from`~`to` 문단이 바뀌어 생기는 문단 수이고, 삽입은 `to = from - 1`이다. */
export function makeMove(sectionIndex: number, parentPath: number[], from: number, to: number, count: number): Move {
  return { sectionIndex, parentPath: [...parentPath], from, to, count, delta: count - (to - from + 1) };
}

const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 문단 주소(원본 좌표)를 구조 변경 뒤의 주소로 옮긴다. 같은 구역의 같은 부모(원본 좌표)에 속한 항목만 보고,
 * 번호 `i`는 `i < from`이면 그대로, `i > to`이면 `i + delta`, `from ≤ i ≤ to`이면 덮인 것이다. 항목이 여럿이면 `i`보다 앞에서 끝나는 항목의 `delta`를 모두 더한다.
 * 문단 아래(표 칸 등)의 경로는 각 단계의 번호를 같은 식으로 옮긴다. 주소 자신이나 그 위 문단이 덮이면 `undefined`다(주소가 없어짐).
 * `path`는 `[문단, 하위목록, 문단, ...]`(홀수 길이)이다.
 */
export function remapAddress(moves: readonly Move[], address: AnchorAt): AnchorAt | undefined {
  const path = [...address.path];
  for (let level = 0; level < address.path.length; level += 2) {
    const parent = address.path.slice(0, level); // 원본 좌표의 상위 주소
    const i = address.path[level] ?? 0;
    let shift = 0;
    for (const m of moves) {
      if (m.sectionIndex !== address.sectionIndex || !sameList(m.parentPath, parent)) continue;
      if (i >= m.from && i <= m.to) return undefined;
      if (i > m.to) shift += m.delta;
    }
    path[level] = i + shift;
  }
  return { sectionIndex: address.sectionIndex, path };
}
