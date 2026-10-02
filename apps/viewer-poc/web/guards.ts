// 화면이 비동기 응답을 받을 때의 두 규칙. 화면(`main.ts`)과 Node 시험이 같이 쓴다(DOM·엔진을 가져오지 않는다).

/**
 * 가장 최근 요청의 응답만 쓰기 위한 번호표. 요청을 보낼 때 `begin()`으로 번호를 받고, 응답이 왔을 때 `current(번호)`가 참일 때만 화면에 반영한다.
 * 문서를 바꾸거나 채우는 동안에는 `cancel()`로 그때까지 나간 요청의 응답을 모두 버린다.
 */
export type Latest = { begin(): number; cancel(): void; current(ticket: number): boolean };

export function createLatest(): Latest {
  let last = 0;
  return {
    begin: () => ++last,
    cancel: () => void ++last,
    current: (ticket) => ticket === last,
  };
}

/**
 * 새 문서를 연 뒤 닫아야 할 이전 세션을 닫는다. 같은 세션을 다시 불러온 경우(채움·되돌리기)와 이전 세션이 없는 경우는 닫지 않는다.
 * 서버가 이미 닫았거나 닫기에 실패해도 새 문서 표시에는 영향이 없으므로 실패는 삼킨다.
 */
export async function closeReplaced(previous: string | undefined, next: string, close: (id: string) => Promise<unknown>): Promise<void> {
  if (previous === undefined || previous === next) return;
  try {
    await close(previous);
  } catch {
    // 이미 닫힌 세션일 수 있다
  }
}
