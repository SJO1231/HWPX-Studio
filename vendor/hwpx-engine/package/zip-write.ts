import { crc32, deflateRawSync } from "node:zlib";
import { HwpxError } from "../errors.ts";
import { copyRange, put16, put32, u16 } from "./le.ts";
import { LIMITS, type Archive, type ArchiveEntry } from "./zip-read.ts";

export type AddedEntry = { name: string; data: Uint8Array; method: 0 | 8 };

export type ArchiveChanges = {
  replace?: Map<string, Uint8Array>;
  add?: AddedEntry[];
};

const LOCAL_FIXED = 30;
const CD_FIXED = 46;
const EOCD_SIZE = 22;
const FIXED_DOS_DATE = 0x0021; // 1980-01-01
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

const encoder = new TextEncoder();

function compress(data: Uint8Array, method: 0 | 8): Uint8Array {
  return method === 8 ? deflateRawSync(data) : data;
}

export function rewriteArchive(bytes: Uint8Array, archive: Archive, changes: ArchiveChanges): Uint8Array {
  const replace = changes.replace ?? new Map<string, Uint8Array>();
  const add = changes.add ?? [];

  const existing = new Map<string, ArchiveEntry>();
  for (const e of archive.entries) existing.set(e.name, e);
  for (const [name, data] of replace) {
    if (name === "mimetype") throw new HwpxError("PKG_MIMETYPE_LOCKED", "mimetype은 바꿀 수 없습니다.", name);
    if (!existing.has(name)) throw new HwpxError("PKG_MISSING", `바꿀 항목이 없습니다: ${name}`, name);
    if (data.length > LIMITS.entrySize) throw new HwpxError("PKG_LIMIT", "항목 크기가 한도를 넘습니다.", name);
  }
  const addedNames = new Set<string>();
  for (const a of add) {
    if (a.name === "mimetype") throw new HwpxError("PKG_MIMETYPE_LOCKED", "mimetype은 추가할 수 없습니다.", a.name);
    if (existing.has(a.name) || addedNames.has(a.name)) {
      throw new HwpxError("PKG_DUP_ENTRY", `이미 있는 이름입니다: ${a.name}`, a.name);
    }
    addedNames.add(a.name);
    if (a.data.length > LIMITS.entrySize) throw new HwpxError("PKG_LIMIT", "항목 크기가 한도를 넘습니다.", a.name);
  }
  if (archive.entries.length + add.length > LIMITS.entries) {
    throw new HwpxError("PKG_LIMIT", `항목이 한도 ${LIMITS.entries}개를 넘습니다.`);
  }

  const chunks: Uint8Array[] = [];
  let pos = 0;
  const push = (c: Uint8Array): void => {
    chunks.push(c);
    pos += c.length;
  };

  const byLocal = [...archive.entries].sort((a, b) => a.localStart - b.localStart);
  const firstLocal = byLocal[0];
  push(bytes.subarray(0, firstLocal === undefined ? archive.cdStart : firstLocal.localStart));

  type Fix = { crc: number; csize: number; size: number };
  const newStart = new Map<string, number>();
  const fixes = new Map<string, Fix>();
  for (const e of byLocal) {
    newStart.set(e.name, pos);
    const replacement = replace.get(e.name);
    if (replacement === undefined) {
      push(bytes.subarray(e.localStart, e.localEnd));
      continue;
    }
    const data = compress(replacement, e.method);
    const fix: Fix = { crc: crc32(replacement), csize: data.length, size: replacement.length };
    fixes.set(e.name, fix);
    const header = copyRange(bytes, e.localStart, e.dataStart);
    // 바꾸는 플래그는 데이터 설명자 비트(bit 3) 하나뿐이다. 16비트 전체를 읽어 나머지(UTF-8 이름 bit 11 등)를 보존한다.
    put16(header, 6, u16(header, 6) & ~FLAG_DATA_DESCRIPTOR);
    put32(header, 14, fix.crc);
    put32(header, 18, fix.csize);
    put32(header, 22, fix.size);
    push(header);
    push(data);
  }

  type AddedRecord = { name: Uint8Array; method: 0 | 8; crc: number; csize: number; size: number; offset: number };
  const added: AddedRecord[] = [];
  for (const a of add) {
    const name = encoder.encode(a.name);
    const data = compress(a.data, a.method);
    const rec: AddedRecord = { name, method: a.method, crc: crc32(a.data), csize: data.length, size: a.data.length, offset: pos };
    const header = new Uint8Array(LOCAL_FIXED + name.length);
    put32(header, 0, 0x04034b50);
    put16(header, 4, 20);
    put16(header, 6, FLAG_UTF8);
    put16(header, 8, a.method);
    put16(header, 10, 0);
    put16(header, 12, FIXED_DOS_DATE);
    put32(header, 14, rec.crc);
    put32(header, 18, rec.csize);
    put32(header, 22, rec.size);
    put16(header, 26, name.length);
    put16(header, 28, 0);
    header.set(name, LOCAL_FIXED);
    push(header);
    push(data);
    added.push(rec);
  }

  const cdStart = pos;
  for (const e of archive.entries) {
    const rec = copyRange(bytes, e.cdRecord.start, e.cdRecord.end);
    put32(rec, 42, newStart.get(e.name) ?? 0);
    const fix = fixes.get(e.name);
    if (fix !== undefined) {
      put16(rec, 8, u16(rec, 8) & ~FLAG_DATA_DESCRIPTOR);
      put32(rec, 16, fix.crc);
      put32(rec, 20, fix.csize);
      put32(rec, 24, fix.size);
    }
    push(rec);
  }
  for (const a of added) {
    const rec = new Uint8Array(CD_FIXED + a.name.length);
    put32(rec, 0, 0x02014b50);
    put16(rec, 4, 20);
    put16(rec, 6, 20);
    put16(rec, 8, FLAG_UTF8);
    put16(rec, 10, a.method);
    put16(rec, 12, 0);
    put16(rec, 14, FIXED_DOS_DATE);
    put32(rec, 16, a.crc);
    put32(rec, 20, a.csize);
    put32(rec, 24, a.size);
    put16(rec, 28, a.name.length);
    put32(rec, 42, a.offset);
    rec.set(a.name, CD_FIXED);
    push(rec);
  }
  const cdSize = pos - cdStart;

  const eocd = copyRange(bytes, archive.eocdStart, archive.eocdStart + EOCD_SIZE);
  const count = archive.entries.length + added.length;
  put16(eocd, 8, count);
  put16(eocd, 10, count);
  put32(eocd, 12, cdSize);
  put32(eocd, 16, cdStart);
  push(eocd);
  push(archive.comment);

  if (pos > 0xffffffff) throw new HwpxError("PKG_LIMIT", "결과 파일이 4GiB를 넘습니다.");
  const out = new Uint8Array(pos);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
