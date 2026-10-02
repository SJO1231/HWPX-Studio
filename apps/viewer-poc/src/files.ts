// 서버가 디스크에서 읽는 것은 두 가지뿐이다: 저장소의 시험 문서(읽기만)와 화면 파일(정적). 둘 다 정해 둔 폴더 안으로만 해석한다.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export const FIXTURE_ROOT = here("../../../packages/hwpx-engine/test/fixtures/");
const WEB_ROOT = here("../web/");
const VIEWER_SRC = here("../../../packages/viewer/src/");
const RHWP_ROOT = fileURLToPath(new URL("./", import.meta.resolve("@rhwp/core")));

/** 시험 문서 이름: 영문·숫자·`.`·`_`·`-`로 된 조각을 `/`로 이은 것. `..`·역슬래시·드라이브 문자·빈 조각은 거절한다. */
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** `root` 아래의 실제 파일이면 그 절대 경로, 아니면 undefined(경로 탈출·심볼릭 링크 탈출·없는 파일·폴더). */
function inside(root: string, relative: string): string | undefined {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(resolve(root, relative));
    if (!real.startsWith(realRoot + sep)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** 저장소 시험 문서 이름(`hancom/header-footer`)을 fixtures 폴더 안의 `.hwpx` 파일 경로로 바꾼다. 폴더 밖이면 undefined. */
export function resolveFixture(name: string): string | undefined {
  if (!NAME.test(name) || name.split("/").some((part) => part === ".." || part === ".")) return undefined;
  return inside(FIXTURE_ROOT, `${name}.hwpx`);
}

/** fixtures 폴더 안의 `.hwpx` 시험 문서 이름(확장자 없이, `/` 구분)을 정렬해 돌려준다. */
export function listFixtures(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`);
      else if (entry.isFile() && entry.name.endsWith(".hwpx")) out.push(`${prefix}${entry.name.slice(0, -5)}`);
    }
  };
  walk(FIXTURE_ROOT.replaceAll("\\", "/"), "");
  return out.filter((n) => NAME.test(n)).sort();
}

export type StaticFile = { file: string; type: string; strip: boolean };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

const extOf = (path: string): string => path.slice(path.lastIndexOf("."));

/**
 * 요청 경로를 화면 파일로 바꾼다.
 * - `/`, `/app/<파일>`: `apps/viewer-poc/web/`
 * - `/packages/viewer/src/<경로>`: 브라우저가 쓰는 부분(`rhwp/`, `dom/`, `map/types.ts`)만. 웹 화면의 상대 import(`../../../packages/viewer/src/...`)가
 *   브라우저에서 이 주소로 풀린다.
 * - `/vendor/rhwp/<파일>`: 설치된 `@rhwp/core`의 `rhwp.js`·`rhwp_bg.wasm`만
 * 확장자가 `.ts`인 파일은 `strip`이 참이다(브라우저로 보내기 전에 타입을 제거한다).
 */
export function resolveStatic(pathname: string): StaticFile | undefined {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (path === "/") path = "/app/index.html";
  if (path.includes("\\") || path.includes("\0") || path.split("/").some((p) => p === ".." || p === ".")) return undefined;

  let found: string | undefined;
  if (path.startsWith("/app/")) found = inside(WEB_ROOT, path.slice(5));
  else if (path.startsWith("/packages/viewer/src/")) {
    const rel = path.slice("/packages/viewer/src/".length);
    if (rel.startsWith("rhwp/") || rel.startsWith("dom/") || rel === "map/types.ts") found = inside(VIEWER_SRC, rel);
  } else if (path === "/vendor/rhwp/rhwp.js" || path === "/vendor/rhwp/rhwp_bg.wasm") found = inside(RHWP_ROOT, path.slice("/vendor/rhwp/".length));
  if (found === undefined) return undefined;
  const type = TYPES[extOf(found)];
  if (type === undefined) return undefined;
  return { file: found, type, strip: extOf(found) === ".ts" };
}
