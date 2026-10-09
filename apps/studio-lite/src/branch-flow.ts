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
