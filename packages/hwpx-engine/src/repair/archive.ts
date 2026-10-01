import { crc32 } from "node:zlib";
import { HwpxError } from "../errors.ts";
import { copyRange, put16, put32, u16 } from "../package/le.ts";
import { readArchive, readEntry, type Archive, type ArchiveEntry } from "../package/zip-read.ts";

const EOCD_SIZE = 22;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const MIMETYPE = "mimetype";

/** `mimetype`이 중앙 디렉터리나 로컬 레코드의 첫 항목이 아니거나 압축돼 있는가. `mimetype`이 없으면 거짓이다(만들어 넣지 않는다). */
export function mimetypeViolation(archive: Archive): boolean {
  const mime = archive.entries.find((e) => e.name === MIMETYPE);
  if (mime === undefined) return false;
  const firstLocal = archive.entries.reduce((a, b) => (b.localStart < a.localStart ? b : a));
  return mime.method !== 0 || archive.entries[0] !== mime || firstLocal !== mime;
}

/**
 * `mimetype`을 첫 항목·무압축으로 두고 나머지는 원래 순서와 원래 압축 방식으로 다시 배열한 새 ZIP을 만든다.
 * 나머지 항목의 로컬 레코드는 원본 바이트 그대로 복사하고, 중앙 디렉터리 레코드는 위치만 고쳐 복사한다.
 * 이미 올바르면 입력의 복사본을 돌려준다. `mimetype`이 없으면 `PKG_MIMETYPE_MISSING`.
 */
export function normalizeArchive(bytes: Uint8Array): Uint8Array {
  const archive = readArchive(bytes);
  const mime = archive.entries.find((e) => e.name === MIMETYPE);
  if (mime === undefined) throw new HwpxError("PKG_MIMETYPE_MISSING", "mimetype 항목이 없어 재배열할 수 없습니다.", MIMETYPE);
  if (!mimetypeViolation(archive)) return copyRange(bytes, 0, bytes.length);

  const order: ArchiveEntry[] = [mime, ...archive.entries.filter((e) => e !== mime)];
  const chunks: Uint8Array[] = [];
  let pos = 0;
  const push = (c: Uint8Array): void => {
    chunks.push(c);
    pos += c.length;
  };

  push(bytes.subarray(0, Math.min(...archive.entries.map((e) => e.localStart))));
  const start = new Map<string, number>();
  const stored = readEntry(archive, bytes, MIMETYPE);
  const storedCrc = crc32(stored);
  for (const e of order) {
    start.set(e.name, pos);
    if (e === mime && e.method !== 0) {
      // 압축된 mimetype은 무압축으로 다시 쓴다. 헤더는 원본을 복사하고 방식·플래그·CRC·크기만 고친다.
      const header = copyRange(bytes, e.localStart, e.dataStart);
      put16(header, 6, u16(header, 6) & ~FLAG_DATA_DESCRIPTOR);
      put16(header, 8, 0);
      put32(header, 14, storedCrc);
      put32(header, 18, stored.length);
      put32(header, 22, stored.length);
      push(header);
      push(stored);
    } else {
      push(bytes.subarray(e.localStart, e.localEnd));
    }
  }

  const cdStart = pos;
  for (const e of order) {
    const rec = copyRange(bytes, e.cdRecord.start, e.cdRecord.end);
    put32(rec, 42, start.get(e.name) ?? 0);
    if (e === mime && e.method !== 0) {
      put16(rec, 8, u16(rec, 8) & ~FLAG_DATA_DESCRIPTOR);
      put16(rec, 10, 0);
      put32(rec, 16, storedCrc);
      put32(rec, 20, stored.length);
      put32(rec, 24, stored.length);
    }
    push(rec);
  }
  const eocd = copyRange(bytes, archive.eocdStart, archive.eocdStart + EOCD_SIZE);
  put32(eocd, 12, pos - cdStart);
  put32(eocd, 16, cdStart);
  push(eocd);
  push(archive.comment);

  const out = new Uint8Array(pos);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
