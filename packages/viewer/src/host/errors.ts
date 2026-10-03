// 호스트 API의 오류. 응답은 `{ error: { code, message } }` JSON이고 `status`는 HTTP 상태 코드다.
export class HostError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
