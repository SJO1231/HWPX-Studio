// 서버가 디스크에서 읽는 것은 화면 파일(정적)뿐이다. 정해 둔 폴더 안으로만 해석한다.
import { fileURLToPath } from "node:url";
import { cleanPath, inside, resolveShared, staticFileOf, type StaticFile } from "../../../packages/viewer/src/host/index.ts";

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

export type { StaticFile };

/**
 * 요청 경로를 화면 파일로 바꾼다.
 * - `/`, `/app/<파일>`: `apps/studio/web/`
 * - `/packages/viewer/src/<경로>`, `/vendor/rhwp/<파일>`: 호스트 공용(`resolveShared`)
 * 확장자가 `.ts`인 파일은 `strip`이 참이다(브라우저로 보내기 전에 타입을 제거한다).
 */
export function resolveStatic(pathname: string): StaticFile | undefined {
  let path = cleanPath(pathname);
  if (path === undefined) return undefined;
  if (path === "/") path = "/app/index.html";
  if (path.startsWith("/app/")) return staticFileOf(inside(WEB_ROOT, path.slice(5)));
  return resolveShared(path);
}
