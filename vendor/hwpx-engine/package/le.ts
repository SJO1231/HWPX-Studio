// 리틀 엔디언 정수 읽기·쓰기. 범위를 벗어난 접근은 호출한 쪽이 먼저 걸러낸다.

export function u16(b: Uint8Array, p: number): number {
  return (b[p] ?? 0) | ((b[p + 1] ?? 0) << 8);
}

export function u32(b: Uint8Array, p: number): number {
  return ((b[p] ?? 0) | ((b[p + 1] ?? 0) << 8) | ((b[p + 2] ?? 0) << 16) | ((b[p + 3] ?? 0) << 24)) >>> 0;
}

export function put16(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff;
  b[p + 1] = (v >>> 8) & 0xff;
}

export function put32(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff;
  b[p + 1] = (v >>> 8) & 0xff;
  b[p + 2] = (v >>> 16) & 0xff;
  b[p + 3] = (v >>> 24) & 0xff;
}

/** 바이트 구간의 복사본. 입력이 Buffer여도 원본과 메모리를 공유하지 않는다. */
export function copyRange(b: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start);
  out.set(b.subarray(start, end));
  return out;
}
