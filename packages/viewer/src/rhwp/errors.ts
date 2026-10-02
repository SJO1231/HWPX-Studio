/**
 * 뷰어 계층의 오류. rhwp는 `Error`가 아니라 문자열을 던지므로(`오류코드: XXX`가 들어 있다) 여기서 코드가 있는 오류로 바꾼다.
 * 코드는 `VIEWER_내용` 꼴이다. rhwp가 오류 코드를 주면 문서를 열 때는 `VIEWER_OPEN_<rhwp 코드>`다.
 */
export class ViewerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ViewerError";
    this.code = code;
  }
}

const RHWP_CODE = /오류코드:\s*([A-Z0-9_]+)/;
// 암호 문서는 오류 코드 없이 문장만 던져진다 [실행 관측]
const RHWP_PASSWORD = /비밀번호가 필요한 암호 문서/;

/** rhwp가 던진 값(문자열 또는 Error)을 `ViewerError`로 바꾼다. 이미 `ViewerError`면 그대로 둔다. */
export function toViewerError(thrown: unknown, fallbackCode: string): ViewerError {
  if (thrown instanceof ViewerError) return thrown;
  const message = typeof thrown === "string" ? thrown : thrown instanceof Error ? thrown.message : String(thrown);
  const rhwpCode = RHWP_CODE.exec(message)?.[1];
  if (rhwpCode !== undefined) return new ViewerError(`${fallbackCode}_${rhwpCode}`, message);
  if (RHWP_PASSWORD.test(message)) return new ViewerError(`${fallbackCode}_PASSWORD`, message);
  // WebAssembly 실행 오류(패닉 등)는 문자열이 아니라 Error 객체로 온다
  const code = thrown instanceof Error ? "VIEWER_RHWP_TRAP" : fallbackCode;
  return new ViewerError(code, message);
}
