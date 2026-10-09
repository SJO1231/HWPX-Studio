// 크게 보기 흐름도(#194, 요구 8.4-3, #60 M4): 제목 순서대로 세로 흐름에 분기점을 그 범위가 시작하는 자리에 두고, 후보 블록이 갈라지는 마디로 보인다.
// 화면(`web/workbench.js`, 형 제거본 `/branch-flow.js`)과 시험이 같은 코드를 쓴다.

type Heading = { id: string; name: string; level: number };
type Case = { name?: string; values: string[]; block: string };
type Branch = { id: string; name: string; from: string; blocks: { id: string }[]; keys: string[]; cases: Case[]; fallback?: string; exclusive?: string[] };
/** 서버 `branch-state`의 분기점 하나(이 업무 건) */
type State = { block?: string; state?: string; blocked?: string; why?: string; reason?: string };
export type FlowOption = { block: string; name: string; cases: string[]; fallback: boolean; chosen: boolean };
export type FlowNode =
  | { kind: 'heading'; id: string; name: string; level: number }
  | { kind: 'branch'; id: string; name: string; state?: string; why?: string; reason?: string; undecided: boolean; exclusive: string[]; options: FlowOption[] };

/** 경우 한 줄의 이름: 적은 이름, 없으면 `키=값`을 잇는다 */
export const caseLabel = (keys: readonly string[], c: Case): string => c.name || keys.map((k, i) => `${k}=${c.values[i] ?? ''}`).join(' · ');

/**
 * 흐름도 마디(문서 순서). 제목은 그 자리에, 분기점은 범위 첫 문단 자리에(같은 자리면 제목 뒤) 두고, 분기점마다 후보 블록이 갈래다.
 * 갈래에는 그 블록을 고르는 경우 이름과 기본 블록 여부, 이 업무 건이 실제로 쓰는 블록(`chosen`, 막힌 분기점은 없음)을 단다.
 */
export function branchFlow(order: readonly string[], outline: readonly Heading[], branches: readonly Branch[], states: Readonly<Record<string, State | undefined>>, nameOf: (block: string) => string): FlowNode[] {
  const at = (id: string) => order.indexOf(id);
  const items = [
    ...outline.map(h => ({ pos: at(h.id), rank: 0, node: { kind: 'heading' as const, id: h.id, name: h.name, level: h.level } })),
    ...branches.map(b => {
      const st = states[b.id];
      const exclusive = branches.filter(o => o !== b && (b.exclusive?.includes(o.id) || o.exclusive?.includes(b.id))).map(o => o.name);
      const options = b.blocks.map(x => ({ block: x.id, name: nameOf(x.id), cases: b.cases.filter(c => c.block === x.id).map(c => caseLabel(b.keys, c)), fallback: b.fallback === x.id, chosen: !st?.blocked && st?.block === x.id }));
      return { pos: at(b.from), rank: 1, node: { kind: 'branch' as const, id: b.id, name: b.name, ...(st?.state ? { state: st.state } : {}), ...(st?.why ? { why: st.why } : {}), ...(st?.reason ? { reason: st.reason } : {}), undecided: Boolean(st?.blocked), exclusive, options } };
    }),
  ];
  return items.sort((x, y) => x.pos - y.pos || x.rank - y.rank).map(x => x.node);
}

/**
 * 흐름 트리에서 끌어 순서 바꾸기(#153, 요구 8.3-5 "분기점의 순서로 순서를 정한다"): 넣은 블록·분기점을 문서 순서로 늘어놓고 `from`번째를 `to`번째로 옮긴다.
 * 자리(바탕 문서의 범위)는 그대로이고 항목이 자리를 바꾼다: 새 순서의 k번째 항목이 k번째 범위를 받는다. 원문 글은 옮기지 않는다. 항목의 `from`·`to`를 고쳐 쓴다
 */
export function moveSlot(order: readonly string[], items: readonly { from: string; to: string }[], from: number, to: number): void {
  const at = new Map(order.map((id, i) => [id, i])), sorted = [...items].sort((a, b) => at.get(a.from)! - at.get(b.from)!);
  const ranges = sorted.map(x => [x.from, x.to] as const);
  sorted.splice(to, 0, ...sorted.splice(from, 1));
  sorted.forEach((x, k) => { [x.from, x.to] = ranges[k]!; });
}

// ── 제목 트리(#151 "이것과 같은 것 전부")와 제목별 블록 후보(#78). 블록 후보는 서버가 아니라 여기서 트리로 계산한다(트리를 고칠 수 있으므로) ──
type Row = { id: string; sectionIndex: number; path: readonly number[] };
export type HeadingBlock = { from: string; to: string; name: string; paragraphCount: number };

/**
 * 제목별 블록 후보: 제목 문단부터 같은 문단 목록에서 다음에 나오는 단계가 같거나 높은 제목의 앞 문단까지(없으면 목록 끝).
 * 엔진 `headingRangeOf`와 같은 규칙을 화면의 제목 트리(탐지 + 사용자가 고친 것)에 쓴다. 탐지 그대로면 결과도 엔진과 같다
 */
export function headingBlocks(rows: readonly Row[], outline: readonly Heading[]): HeadingBlock[] {
  const listOf = (r: Row) => r.sectionIndex + ':' + r.path.slice(0, -1).join('.'), lists = new Map<string, Row[]>();
  for (const r of rows) { const k = listOf(r); if (!lists.has(k)) lists.set(k, []); lists.get(k)!.push(r); }
  const byId = new Map(rows.map(r => [r.id, r])), levels = new Map(outline.map(h => [h.id, h.level]));
  return outline.flatMap(h => {
    const a = byId.get(h.id); if (!a) return [];
    const list = lists.get(listOf(a))!, i = list.indexOf(a);
    let j = i + 1;
    while (j < list.length && !((levels.get(list[j]!.id) ?? Infinity) <= h.level)) j++;
    return [{ from: a.id, to: list[j - 1]!.id, name: h.name, paragraphCount: j - i }];
  });
}

/**
 * 같은 유형 ✓(#151): 제안 가운데 체크한(`keep`) 문단은 제목 트리에 두고(이미 제목이면 그 단계 그대로, 아니면 제안의 `level`), 뺀 문단은 트리에서 뺀다.
 * 제안에 없는 제목은 그대로. 문서 순서(`order`)
 */
export function applySimilar(order: readonly string[], outline: readonly Heading[], picks: readonly (Heading & { keep: boolean })[]): Heading[] {
  const touched = new Set(picks.map(p => p.id)), at = new Map(order.map((id, i) => [id, i]));
  const kept = picks.filter(p => p.keep).map(p => outline.find(h => h.id === p.id) ?? { id: p.id, name: p.name, level: p.level });
  return [...outline.filter(h => !touched.has(h.id)), ...kept].sort((a, b) => at.get(a.id)! - at.get(b.id)!);
}
