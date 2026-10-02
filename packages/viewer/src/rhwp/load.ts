import init, { initSync } from "@rhwp/core";
import { toViewerError, ViewerError } from "./errors.ts";

/**
 * wasm을 어디서 가져오는가. Node는 바이트(`initSync`), 브라우저는 주소(`init`, 서버가 `application/wasm`으로 제공)를 쓴다.
 * 글자 폭 측정 함수는 이 버전에서 필요 없으므로 등록하지 않는다.
 */
export type RhwpSource = { wasmBytes: BufferSource | WebAssembly.Module } | { wasmUrl: string | URL };

let ready: Promise<void> | undefined;

/** rhwp wasm을 한 번 초기화한다. 이미 초기화했으면 같은 결과를 돌려준다(두 번째 인자는 무시). 실패하면 다시 시도할 수 있다. */
export function loadRhwp(source: RhwpSource): Promise<void> {
  if (ready === undefined) {
    const attempt = (async (): Promise<void> => {
      try {
        if ("wasmBytes" in source) initSync({ module: source.wasmBytes });
        else await init({ module_or_path: source.wasmUrl });
      } catch (e) {
        throw toViewerError(e, "VIEWER_INIT");
      }
    })();
    ready = attempt;
    attempt.catch(() => {
      if (ready === attempt) ready = undefined;
    });
  }
  return ready;
}

export function isRhwpLoaded(): boolean {
  return ready !== undefined;
}

export function requireLoaded(): void {
  if (ready === undefined) throw new ViewerError("VIEWER_NOT_LOADED", "rhwp가 초기화되지 않았습니다(loadRhwp를 먼저 부르세요).");
}
