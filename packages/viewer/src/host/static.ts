// 호스트가 브라우저에 주는 정적 파일 가운데 앱이 공유하는 부분. 읽기만 하며 정해 둔 폴더 안으로만 해석한다.
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER_SRC = fileURLToPath(new URL("../", import.meta.url));
const RHWP_ROOT = fileURLToPath(new URL("./", import.meta.resolve("@rhwp/core")));

export type StaticFile = { file: string; type: string; strip: boolean };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

const extOf = (path: string): string => path.slice(path.lastIndexOf("."));

/** `root` 아래의 실제 파일이면 그 절대 경로, 아니면 undefined(경로 탈출·심볼릭 링크 탈출·없는 파일·폴더). */
export function inside(root: string, relative: string): string | undefined {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(resolve(root, relative));
    if (!real.startsWith(realRoot + sep)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** 실제 파일 경로를 응답 형식으로 바꾼다. 허용한 확장자가 아니면 undefined. 확장자가 `.ts`이면 `strip`이 참이다(브라우저로 보내기 전에 타입을 제거한다). */
export function staticFileOf(found: string | undefined): StaticFile | undefined {
  if (found === undefined) return undefined;
  const type = TYPES[extOf(found)];
  return type === undefined ? undefined : { file: found, type, strip: extOf(found) === ".ts" };
}

/** 요청 경로를 디코드하고 이상한 경로(역슬래시·NUL·`.`·`..` 조각)를 거른다. 풀 수 없으면 undefined. */
export function cleanPath(pathname: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (path.includes("\\") || path.includes("\0") || path.split("/").some((p) => p === ".." || p === ".")) return undefined;
  return path;
}

/**
 * 모든 앱이 같은 주소로 받는 파일.
 * - `/packages/viewer/src/<경로>`: 브라우저가 쓰는 부분(`rhwp/`, `dom/`, `map/types.ts`)만. 웹 화면의 상대 import(`../../../packages/viewer/src/...`)가 브라우저에서 이 주소로 풀린다.
 *   엔진을 가져오는 호스트 쪽 코드(`map/`의 나머지, `host/`)는 주지 않는다.
 * - `/vendor/rhwp/<파일>`: 설치된 `@rhwp/core`의 `rhwp.js`·`rhwp_bg.wasm`만
 * 해당하지 않는 경로는 undefined다. `path`는 `cleanPath`를 거친 것이어야 한다.
 */
export function resolveShared(path: string): StaticFile | undefined {
  let found: string | undefined;
  if (path.startsWith("/packages/viewer/src/")) {
    const rel = path.slice("/packages/viewer/src/".length);
    if (rel.startsWith("rhwp/") || rel.startsWith("dom/") || rel === "map/types.ts") found = inside(VIEWER_SRC, rel);
  } else if (path === "/vendor/rhwp/rhwp.js" || path === "/vendor/rhwp/rhwp_bg.wasm") found = inside(RHWP_ROOT, path.slice("/vendor/rhwp/".length));
  return staticFileOf(found);
}
