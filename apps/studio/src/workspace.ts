// 작업 공간(명세 3절 중 이 단계가 쓰는 부분): 표지(`workspace.json`)와 결과 폴더 `out/<날짜-시각>/`.
// 이 파일이 스튜디오에서 디스크에 쓰는 유일한 곳이다. 올린 원본과 데이터는 쓰지 않고, 만든 결과(.hwpx)만 새 폴더 안에 새 파일로 쓴다.
// 임시 파일에 쓴 뒤 이름을 바꾸고, 이미 있는 파일은 덮어쓰지 않는다. 표지가 없는 비어 있지 않은 폴더에는 쓰지 않는다.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { HostError } from "../../../packages/viewer/src/host/index.ts";

export const WORKSPACE_SCHEMA = "hwpx-studio/workspace@1";
const MARKER = "workspace.json";

/** 기본 작업 공간: 사용자 홈의 `HWPX Studio` 폴더(저장소 밖) */
export const defaultWorkspace = (): string => join(homedir(), "HWPX Studio");

const foreign = (): HostError => new HostError(500, "QUICK_WORKSPACE_FOREIGN", "작업 공간 폴더가 비어 있지 않고 표지(workspace.json)도 없어 쓰지 않습니다.");

function writeNew(path: string, bytes: Uint8Array | string): void {
  const tmp = `${path}.part`;
  writeFileSync(tmp, bytes, { flag: "wx" });
  try {
    renameSync(tmp, path);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
}

/** 작업 공간 폴더를 준비한다: 없으면 만들고 표지를 쓴다. 있으면 표지가 있거나 비어 있어야 한다(아니면 `QUICK_WORKSPACE_FOREIGN`). */
export function ensureWorkspace(root: string): void {
  let isDir: boolean | undefined;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = undefined;
  }
  if (isDir === undefined) {
    mkdirSync(root, { recursive: true });
    writeNew(join(root, MARKER), `${JSON.stringify({ schema: WORKSPACE_SCHEMA })}\n`);
    return;
  }
  if (!isDir) throw foreign();
  const names = readdirSync(root);
  if (names.includes(MARKER)) {
    let schema: unknown;
    try {
      schema = (JSON.parse(readFileSync(join(root, MARKER), "utf8")) as { schema?: unknown }).schema;
    } catch {
      throw foreign();
    }
    if (schema !== WORKSPACE_SCHEMA) throw foreign();
    return;
  }
  if (names.length > 0) throw foreign();
  writeNew(join(root, MARKER), `${JSON.stringify({ schema: WORKSPACE_SCHEMA })}\n`);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** 폴더 이름: 지역 시각 `YYYYMMDD-HHmmss` */
export const stampOf = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** `path`가 `root` 안쪽(심볼릭 링크를 풀어서도)의 실제 폴더인가 */
export function isInsideWorkspace(root: string, path: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(path);
    return real.startsWith(realRoot + sep) && statSync(real).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 결과 파일들을 `<작업 공간>/out/<날짜-시각>/`에 저장하고 그 폴더의 경로를 돌려준다(같은 시각이면 `-2`, `-3`…을 붙인다).
 * 파일 이름은 엔진의 이름 규칙(`planBatchNames`)이 만든 것이어야 한다(폴더 구분자가 있으면 거절). 실패하면 이번에 만든 파일과 폴더만 치우고 던진다.
 */
export function saveResults(root: string, files: readonly { name: string; bytes: Uint8Array }[], now: Date = new Date()): string {
  for (const f of files) if (f.name !== basename(f.name) || f.name.includes("\\") || f.name === "") throw new HostError(500, "QUICK_SAVE_FAILED", "결과 파일 이름이 올바르지 않습니다.");
  ensureWorkspace(root);
  const out = join(root, "out");
  mkdirSync(out, { recursive: true });
  if (!isInsideWorkspace(root, out)) throw new HostError(500, "QUICK_SAVE_FAILED", "out 폴더가 작업 공간 밖을 가리킵니다.");
  const stamp = stampOf(now);
  let dir = join(out, stamp);
  for (let n = 2; ; n++) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      dir = join(out, `${stamp}-${n}`);
    }
  }
  const made: string[] = [];
  try {
    for (const f of files) {
      writeNew(join(dir, f.name), f.bytes);
      made.push(join(dir, f.name));
    }
  } catch (e) {
    for (const path of made) unlinkSync(path);
    rmdirSync(dir);
    throw e;
  }
  return dir;
}

/** 폴더를 여는 방법. 시험이 바꿔 끼울 수 있다. */
export type FolderOpener = (folder: string) => Promise<void>;

/** Windows 탐색기로 폴더 하나를 연다. 셸을 거치지 않고 인자 배열로 넘긴다. */
export const openWithExplorer: FolderOpener = (folder) =>
  new Promise((resolve, reject) => {
    if (process.platform !== "win32") return reject(new HostError(501, "QUICK_OPEN_UNSUPPORTED", "폴더 열기는 Windows에서만 지원합니다."));
    const child = spawn("explorer.exe", [folder], { detached: true, stdio: "ignore" });
    child.once("error", () => reject(new HostError(500, "QUICK_OPEN_FAILED", "탐색기를 열지 못했습니다.")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

/** 작업 공간 안의 폴더만 연다. 밖이거나 없으면 `QUICK_NO_FOLDER`(409). */
export async function openFolder(root: string, folder: string, open: FolderOpener): Promise<void> {
  if (!isInsideWorkspace(root, folder)) throw new HostError(409, "QUICK_NO_FOLDER", "작업 공간 안의 결과 폴더가 아닙니다.");
  await open(folder);
}
