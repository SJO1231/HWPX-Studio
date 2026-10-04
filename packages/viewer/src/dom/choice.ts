// 앵커 초안 목록의 기본 선택 규칙. 웹 화면들과 Node 시험이 같이 쓴다(DOM·엔진을 가져오지 않는다).
import type { DraftView } from "../host/types.ts";

/**
 * 기본으로 고를 초안의 순번. 고르지 않으면 undefined.
 * - 누름틀·낱말·셀 초안이 하나라도 있으면 그 가운데 채울 수 있는(`blocked` 없는) 첫 초안이다. 전부 막혔으면 문단(`line`) 초안이 막히지 않았어도 고르지 않는다 —
 *   문단 채움은 문단 글 전체를 바꾸므로 낱말·셀 초안이 막혔다고 대신 기본값이 되어서는 안 된다.
 * - 문단 초안만 있을 때(빈 곳을 눌렀거나 문단 정밀도)는 막히지 않았으면 그것이다.
 * - 여러 문단에 걸친 끌기의 범위(`range`) 초안이 막히지 않았으면 위 규칙보다 먼저 그것이다(제목 범위 `headingRange`보다 앞).
 */
export function defaultDraftIndex(drafts: readonly Pick<DraftView, "anchor" | "blocked">[]): number | undefined {
  const range = drafts.findIndex((d) => d.blocked === undefined && d.anchor.kind === "range");
  if (range >= 0) return range;
  const hasSpecific = drafts.some((d) => d.anchor.kind !== "line");
  const at = drafts.findIndex((d) => d.blocked === undefined && (!hasSpecific || d.anchor.kind !== "line"));
  return at < 0 ? undefined : at;
}
