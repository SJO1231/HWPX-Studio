// 서버 응답이 실패했을 때 화면에 보일 문장. 웹 화면들과 Node 시험이 같이 쓴다(DOM·엔진을 가져오지 않는다).

/** `{ error: { code, message } }` 본문이면 `코드: 메시지`, 아니면 undefined. */
function errorBody(text: string): string | undefined {
  try {
    const e = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    return typeof e?.code === "string" && typeof e.message === "string" ? `${e.code}: ${e.message}` : undefined;
  } catch {
    return undefined;
  }
}

const BY_STATUS: Record<number, string> = {
  403: "허용되지 않은 호스트·출처입니다",
  404: "없는 주소입니다",
  413: "본문이 너무 큽니다",
  500: "서버 내부 오류입니다",
};

/**
 * 응답 본문이 JSON 오류 형식이 아니어도(서버 앞단의 거절·충돌 등) 상태 코드로 설명한다.
 * `status`가 400 미만이면 성공 응답의 본문이 JSON이 아닌 경우다.
 */
export function failureText(status: number, bodyText: string): string {
  const parsed = errorBody(bodyText);
  if (parsed !== undefined) return parsed;
  if (status < 400) return `HTTP ${status}: 서버 응답이 JSON이 아닙니다.`;
  const snippet = bodyText.trim().slice(0, 80);
  return `HTTP ${status}: ${BY_STATUS[status] ?? "서버가 요청을 처리하지 못했습니다"}${snippet === "" ? "" : ` (${snippet})`}`;
}
