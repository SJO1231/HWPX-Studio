// 서버가 디스크에서 읽는 것은 두 가지뿐이다: 저장소의 시험 문서(읽기만)와 화면 파일(정적). 둘 다 정해 둔 폴더 안으로만 해석한다.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanPath, inside, resolveShared, staticFileOf, type StaticFile } from "../../../packages/viewer/src/host/index.ts";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export const FIXTURE_ROOT = here("../../../packages/hwpx-engine/test/fixtures/");
const WEB_ROOT = here("../web/");

/** 시험 문서 이름: 영문·숫자·`.`·`_`·`-`로 된 조각을 `/`로 이은 것. `..`·역슬래시·드라이브 문자·빈 조각은 거절한다. */
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

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

export type { StaticFile };

/**
 * 요청 경로를 화면 파일로 바꾼다.
 * - `/`, `/app/<파일>`: `apps/viewer-poc/web/`
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
