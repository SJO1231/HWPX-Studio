import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** 사용법 오류(종료 코드 2). */
export class UsageError extends Error {}
/** 읽을 수 없는 입력(종료 코드 2). */
export class InputError extends Error {}

export type Out = {
  log: (line: string) => void;
  err: (line: string) => void;
};

export function readBytes(path: string, what: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (e) {
    throw new InputError(`${what}을(를) 읽을 수 없습니다: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
}

export function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new InputError(`${what}을(를) 읽을 수 없습니다: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * UTF-8 글 파일을 읽는다. BOM은 문자열 맨 앞에 그대로 남기고(`ignoreBOM`), UTF-8이 아니면 `InputError`(종료 코드 2)다.
 * 줄바꿈은 바꾸지 않는다.
 */
export function readUtf8(path: string, what: string): string {
  const bytes = readBytes(path, what);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InputError(`${what}이(가) UTF-8이 아닙니다: ${path}`);
  }
}

/** 실제 경로(링크를 따라간 것). 아직 없는 파일은 부모 폴더의 실제 경로에 이름을 붙인다. */
function realTarget(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync.native(abs);
  const dir = dirname(abs);
  return join(existsSync(dir) ? realpathSync.native(dir) : dir, basename(abs));
}

const sameFile = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * 출력 경로를 미리 확인한다: 입력과 같은 경로는 거부하고, 이미 있으면 `--overwrite` 없이는 거부하고, 부모 폴더가 있어야 한다.
 * 위반하면 `UsageError`(종료 코드 2).
 */
export function checkOutputPath(path: string, inputs: string[], overwrite: boolean): void {
  const target = realTarget(path);
  for (const input of inputs) {
    if (sameFile(target, realTarget(input))) throw new UsageError(`출력 경로가 입력과 같습니다: ${path}`);
  }
  if (!existsSync(dirname(resolve(path)))) throw new UsageError(`출력 폴더가 없습니다: ${dirname(resolve(path))}`);
  if (existsSync(resolve(path))) {
    if (statSync(resolve(path)).isDirectory()) throw new UsageError(`출력 경로가 폴더입니다: ${path}`);
    if (!overwrite) throw new UsageError(`출력 파일이 이미 있습니다(덮어쓰려면 --overwrite): ${path}`);
  }
}

/**
 * 같은 폴더의 임시 파일에 쓴 뒤 이름을 바꾼다. 쓰다가 실패하면 임시 파일을 지우고 아무 파일도 남기지 않는다
 * (`--overwrite`로 덮어쓰는 경우 기존 파일은 이름을 바꾸기 전까지 그대로다).
 */
export function writeSafely(path: string, data: Uint8Array | string, inputs: string[], overwrite: boolean): void {
  checkOutputPath(path, inputs, overwrite);
  const abs = resolve(path);
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, abs);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new InputError(`출력 파일을 쓸 수 없습니다: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
}
