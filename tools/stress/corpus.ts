// 실제 문서 모음 읽기 전용 접근. 쓰기·이동·삭제 호출이 없다. 이름·경로는 보고하지 않고 식별자(경로 sha256 앞 10자)만 쓴다.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type CorpusFile = {
  /** 모음 폴더 기준 상대 경로의 sha256 앞 10자 */
  id: string;
  /** 바로 위 폴더(상대 경로)의 sha256 앞 10자 */
  folderId: string;
  /** 읽을 때만 쓰는 절대 경로. 보고서·로그에 넣지 않는다. */
  abs: string;
  size: number;
  mtimeMs: number;
  /** 목록 요약용(이름 순서) 상대 경로. 보고하지 않는다. */
  rel: string;
};

export type CorpusSnapshot = {
  hwpxFiles: number;
  totalBytes: number;
  maxMtime: string;
  /** (상대 경로, 크기, 수정 시각)을 정렬해 묶은 sha256. 이름은 남지 않는다. */
  listDigest: string;
};

const sha10 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 10);

function normalizeRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/** `.hwpx` 파일을 모두 모은다(하위 폴더 포함, 심볼릭 링크는 따라가지 않는다). 읽기 전용이다. */
export function scanCorpus(root: string): CorpusFile[] {
  const out: CorpusFile[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".hwpx")) {
        const st = statSync(abs);
        const rel = normalizeRel(root, abs);
        const slash = rel.lastIndexOf("/");
        out.push({
          id: sha10(rel),
          folderId: sha10(slash < 0 ? "." : rel.slice(0, slash)),
          abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
          rel,
        });
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

export function snapshotOf(files: readonly CorpusFile[]): CorpusSnapshot {
  const hash = createHash("sha256");
  let total = 0;
  let max = 0;
  for (const f of files) {
    hash.update(`${f.rel}\u0000${f.size}\u0000${f.mtimeMs}\n`);
    total += f.size;
    max = Math.max(max, f.mtimeMs);
  }
  return {
    hwpxFiles: files.length,
    totalBytes: total,
    maxMtime: files.length === 0 ? "" : new Date(max).toISOString(),
    listDigest: hash.digest("hex"),
  };
}

export function sameSnapshot(a: CorpusSnapshot, b: CorpusSnapshot): boolean {
  return a.hwpxFiles === b.hwpxFiles && a.totalBytes === b.totalBytes && a.maxMtime === b.maxMtime && a.listDigest === b.listDigest;
}

/** 파일 하나가 색인 때와 같은지(크기·수정 시각) 다시 확인한다. */
export function sameStat(f: CorpusFile): boolean {
  const st = statSync(f.abs);
  return st.size === f.size && st.mtimeMs === f.mtimeMs;
}

export function readCorpusFile(f: CorpusFile): Uint8Array {
  return new Uint8Array(readFileSync(f.abs));
}
