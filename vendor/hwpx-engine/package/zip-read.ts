import { crc32, inflateRawSync } from "node:zlib";
import { HwpxError } from "../errors.ts";
import { copyRange, u16, u32 } from "./le.ts";

export type ArchiveEntry = {
  name: string;
  method: 0 | 8;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localStart: number;
  localEnd: number;
  dataStart: number;
  isDirectory: boolean;
  cdRecord: { start: number; end: number };
};

export type Archive = {
  entries: ArchiveEntry[];
  cdStart: number;
  cdSize: number;
  eocdStart: number;
  /** EOCD 고정부(22바이트) 뒤부터 파일 끝까지. 선언된 주석과 그 뒤의 군더더기를 함께 담는다. */
  comment: Uint8Array;
};

export const LIMITS = {
  entries: 4096,
  entrySize: 256 * 1024 * 1024,
  totalSize: 1024 * 1024 * 1024,
  ratioFloor: 1024 * 1024,
  ratio: 500,
};

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const CD_FIXED = 46;
const LOCAL_FIXED = 30;
/** 범용 플래그의 암호화 관련 비트: bit 0(암호화), bit 6(강한 암호화), bit 13(중앙 디렉터리 암호화). CD 레코드와 로컬 헤더 모두에서 본다. */
const FLAGS_ENCRYPTED = 0x0001 | 0x0040 | 0x2000;

const nameDecoder = new TextDecoder("utf-8", { fatal: true });

function findEocd(bytes: Uint8Array): number {
  const lowest = Math.max(0, bytes.length - EOCD_SIZE - 0xffff);
  for (let p = bytes.length - EOCD_SIZE; p >= lowest; p--) {
    if (u32(bytes, p) === SIG_EOCD && p + EOCD_SIZE + u16(bytes, p + 20) <= bytes.length) return p;
  }
  return -1;
}

export function readArchive(bytes: Uint8Array): Archive {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new HwpxError("PKG_IS_HWP5", "OLE2 복합 문서입니다. HWPX가 아니라 HWP 5 형식으로 보입니다.");
  }
  const eocdStart = findEocd(bytes);
  if (eocdStart < 0) {
    if (bytes.length >= 4 && u32(bytes, 0) === SIG_LOCAL) {
      throw new HwpxError("PKG_TRUNCATED", "ZIP 끝 레코드(EOCD)를 찾을 수 없습니다. 파일이 잘린 것으로 보입니다.");
    }
    throw new HwpxError("PKG_NOT_ZIP", "ZIP 파일이 아닙니다.");
  }
  if (eocdStart >= 20 && u32(bytes, eocdStart - 20) === SIG_ZIP64_LOCATOR) {
    throw new HwpxError("PKG_ZIP64", "ZIP64 형식은 지원하지 않습니다.");
  }
  const diskNo = u16(bytes, eocdStart + 4);
  const cdDisk = u16(bytes, eocdStart + 6);
  const entriesHere = u16(bytes, eocdStart + 8);
  const total = u16(bytes, eocdStart + 10);
  const cdSize = u32(bytes, eocdStart + 12);
  const cdStart = u32(bytes, eocdStart + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) {
    throw new HwpxError("PKG_ZIP64", "ZIP64 형식은 지원하지 않습니다.");
  }
  if (diskNo !== 0 || cdDisk !== 0 || entriesHere !== total) {
    throw new HwpxError("PKG_MULTI_DISK", "여러 디스크로 나뉜 ZIP은 지원하지 않습니다.");
  }
  if (total > LIMITS.entries) {
    throw new HwpxError("PKG_LIMIT", `항목이 ${total}개로 한도 ${LIMITS.entries}개를 넘습니다.`);
  }
  if (cdStart + cdSize !== eocdStart) {
    throw new HwpxError(
      "PKG_TRUNCATED",
      `중앙 디렉터리 범위(${cdStart}+${cdSize})가 EOCD 위치(${eocdStart})와 맞지 않습니다.`,
    );
  }

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let totalSize = 0;
  let p = cdStart;
  for (let i = 0; i < total; i++) {
    if (p + CD_FIXED > eocdStart || u32(bytes, p) !== SIG_CD) {
      throw new HwpxError("PKG_TRUNCATED", `중앙 디렉터리 ${i}번째 레코드가 깨졌거나 잘렸습니다.`);
    }
    const flags = u16(bytes, p + 8);
    const rawMethod = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const diskStart = u16(bytes, p + 34);
    const localStart = u32(bytes, p + 42);
    const recordEnd = p + CD_FIXED + nameLen + extraLen + commentLen;
    if (recordEnd > eocdStart) {
      throw new HwpxError("PKG_TRUNCATED", `중앙 디렉터리 ${i}번째 레코드가 범위를 벗어납니다.`);
    }
    let name: string;
    try {
      name = nameDecoder.decode(bytes.subarray(p + CD_FIXED, p + CD_FIXED + nameLen));
    } catch {
      throw new HwpxError("PKG_NAME_ENCODING", `${i}번째 항목 이름이 UTF-8이 아닙니다.`);
    }
    if ((flags & FLAGS_ENCRYPTED) !== 0) {
      throw new HwpxError("PKG_ENCRYPTED", "암호화된 항목은 지원하지 않습니다.", name);
    }
    if (csize === 0xffffffff || size === 0xffffffff || localStart === 0xffffffff) {
      throw new HwpxError("PKG_ZIP64", "ZIP64 형식은 지원하지 않습니다.", name);
    }
    if (diskStart !== 0) {
      throw new HwpxError("PKG_MULTI_DISK", "여러 디스크로 나뉜 ZIP은 지원하지 않습니다.", name);
    }
    if (rawMethod !== 0 && rawMethod !== 8) {
      throw new HwpxError("PKG_METHOD", `지원하지 않는 압축 방식 ${rawMethod}입니다.`, name);
    }
    if (seen.has(name)) throw new HwpxError("PKG_DUP_ENTRY", `항목 이름이 중복됩니다: ${name}`, name);
    seen.add(name);

    if (size > LIMITS.entrySize) {
      throw new HwpxError("PKG_LIMIT", `풀린 크기 ${size}바이트가 항목 한도를 넘습니다.`, name);
    }
    totalSize += size;
    if (totalSize > LIMITS.totalSize) {
      throw new HwpxError("PKG_LIMIT", "풀린 전체 크기가 한도를 넘습니다.", name);
    }
    if (size > LIMITS.ratioFloor && size > csize * LIMITS.ratio) {
      throw new HwpxError("PKG_LIMIT", `압축률이 ${LIMITS.ratio}:1을 넘습니다.`, name);
    }

    entries.push({
      name,
      method: rawMethod,
      flags,
      crc32: crc,
      compressedSize: csize,
      size,
      localStart,
      localEnd: 0,
      dataStart: 0,
      isDirectory: name.endsWith("/"),
      cdRecord: { start: p, end: recordEnd },
    });
    p = recordEnd;
  }
  if (p !== eocdStart) {
    throw new HwpxError("PKG_TRUNCATED", "중앙 디렉터리 뒤에 해석할 수 없는 바이트가 있습니다.");
  }

  // 한도는 위에서 중앙 디렉터리의 선언값만으로 모두 판정했다. 이제 로컬 레코드를 확인한다.
  for (const e of entries) {
    if (e.localStart + LOCAL_FIXED > cdStart || u32(bytes, e.localStart) !== SIG_LOCAL) {
      throw new HwpxError("PKG_TRUNCATED", "로컬 레코드 위치가 범위 밖이거나 서명이 맞지 않습니다.", e.name);
    }
    if ((u16(bytes, e.localStart + 6) & FLAGS_ENCRYPTED) !== 0) {
      throw new HwpxError("PKG_ENCRYPTED", "암호화된 항목은 지원하지 않습니다.", e.name);
    }
    e.dataStart = e.localStart + LOCAL_FIXED + u16(bytes, e.localStart + 26) + u16(bytes, e.localStart + 28);
    if (e.dataStart + e.compressedSize > cdStart) {
      throw new HwpxError("PKG_TRUNCATED", "항목 데이터가 파일 범위를 벗어납니다.", e.name);
    }
  }

  const byLocal = [...entries].sort((a, b) => a.localStart - b.localStart);
  for (let i = 0; i < byLocal.length; i++) {
    const cur = byLocal[i];
    if (cur === undefined) continue;
    const next = byLocal[i + 1];
    cur.localEnd = next === undefined ? cdStart : next.localStart;
    if (cur.localEnd < cur.dataStart + cur.compressedSize) {
      throw new HwpxError("PKG_TRUNCATED", "로컬 레코드 범위가 서로 겹칩니다.", cur.name);
    }
  }

  return { entries, cdStart, cdSize, eocdStart, comment: bytes.subarray(eocdStart + EOCD_SIZE) };
}

export function findEntry(archive: Archive, name: string): ArchiveEntry | undefined {
  return archive.entries.find((e) => e.name === name);
}

/** 항목 내용을 풀어 복사본으로 돌려준다. CRC32를 검사한다. */
export function readEntry(archive: Archive, bytes: Uint8Array, name: string): Uint8Array {
  const entry = findEntry(archive, name);
  if (entry === undefined) throw new HwpxError("PKG_MISSING", `항목이 없습니다: ${name}`, name);
  const stored = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let out: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) {
      throw new HwpxError("PKG_TRUNCATED", "무압축 항목의 두 크기가 다릅니다.", name);
    }
    out = copyRange(stored, 0, stored.length);
  } else {
    try {
      out = inflateRawSync(stored, { maxOutputLength: Math.max(entry.size, 1) });
    } catch (e) {
      throw new HwpxError("PKG_INFLATE", `압축을 풀 수 없습니다: ${e instanceof Error ? e.message : String(e)}`, name);
    }
    if (out.length !== entry.size) {
      throw new HwpxError("PKG_INFLATE", `풀린 크기 ${out.length}가 선언값 ${entry.size}와 다릅니다.`, name);
    }
  }
  if (crc32(out) !== entry.crc32) throw new HwpxError("PKG_CRC", "CRC32가 일치하지 않습니다.", name);
  return out;
}
