// 시작·끝 깃발(#150, 요구 8.4-7, 뷰어 명세 4절 "시작·끝 깃발"). 화면만 첫 깃발을 들고 기다린다(뷰어·호스트는 상태가 없다).
// 브라우저는 /range-flag.js로 받는다(타입만 벗긴다).

/** 눌린 점 하나(뷰어 `LocatePoint`: 위치와 런의 글·한계·사유, 또는 표 칸의 빈 곳 `cell`) */
export type FlagPoint = Record<string, unknown>;
/** 든 첫 깃발. 어느 문서(작업 세션)의 점인지 함께 든다 */
export type FlagWait = { session: string; start: FlagPoint };

export const FLAG_WAIT = '끝 깃발을 찍으세요 · Esc로 취소';

/** 끝 깃발의 `locate` 본문. 든 깃발이 없거나(Esc) 다른 문서의 점이면(문서를 다시 열었으면) 보내지 않는다 */
export function flagRequest(wait: FlagWait | undefined, session: string | undefined, end: FlagPoint | undefined) {
  return wait && end && wait.session === session ? { flags: { start: wait.start, end } } : undefined;
}

/** 깃발 범위를 받지 못한 이유(쉬운 말). 사유 코드는 뷰어 명세 3절 표 */
export function flagRefusal(reason: string | undefined): string {
  return reason === 'RANGE_PARAGRAPHS_DIFFER'
    ? '두 깃발이 서로 다른 표 칸이나 본문에 있어 한 범위로 묶을 수 없습니다. 같은 본문이나 같은 칸 안에 끝 깃발을 다시 찍으세요.'
    : '깃발 자리의 문단을 확인할 수 없습니다. 다른 글에 끝 깃발을 다시 찍으세요.';
}

/** 범위 크기(드래그·깃발이 같은 상세). 두 깃발이 같은 문단이면 그 문단 전체다 */
export function spanLabel(span: { from: number; to: number }): string {
  const count = span.to - span.from + 1;
  return count === 1 ? '문단 1개(문단 전체)' : '문단 ' + count + '개';
}
