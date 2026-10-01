// 시드 고정 난수. 같은 시드와 같은 호출 순서면 같은 값을 낸다.

export type Rng = {
  /** [0, 1) */
  next(): number;
  /** [0, n) 정수 */
  int(n: number): number;
  /** [lo, hi] 정수 */
  range(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
};

/** 문자열 → 32비트 시드(FNV-1a) */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    range: (lo, hi) => lo + int(hi - lo + 1),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error("빈 목록에서 고를 수 없다");
      return items[int(items.length)] as never;
    },
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const tmp = out[i] as never;
        out[i] = out[j] as never;
        out[j] = tmp;
      }
      return out;
    },
  };
}
