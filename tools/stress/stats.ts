// 수량 요약. 값 목록 → 최솟값·중앙값·최댓값 등. 결과에는 수량만 담는다.

export type Dist = { n: number; min: number; median: number; p90: number; max: number; sum: number };

export function dist(values: readonly number[]): Dist {
  if (values.length === 0) return { n: 0, min: 0, median: 0, p90: 0, max: 0, sum: 0 };
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number): number => v[Math.min(v.length - 1, Math.floor(q * (v.length - 1) + 0.5))] ?? 0;
  const round = (x: number): number => Math.round(x * 100) / 100;
  return {
    n: v.length,
    min: round(v[0] ?? 0),
    median: round(at(0.5)),
    p90: round(at(0.9)),
    max: round(v[v.length - 1] ?? 0),
    sum: round(v.reduce((a, b) => a + b, 0)),
  };
}

/** 코드 → 개수 표에 하나 더한다. */
export function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

/** 키 이름순으로 정렬한 사본(보고서를 읽기 좋게) */
export function sortedRecord<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
