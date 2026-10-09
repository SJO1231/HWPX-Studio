// 분기점 선택 평가(#7). Codex 초안 PR #44의 `selection.ts`에서 이번 건 선택 꼴(case@1 `manual`, 고른 때의 블록 내용 해시)과
// 판정(조건 기본·기본 블록 자동, 동률·값 없음·후보 없음은 막음, 수동 선택 우선)만 현재 엔진 공개 API(`bindValues`·`selectSlots`)로 옮겼다.
// 파일 올리기 화면(`/selection`)·확정(confirm)·이번 건 파일 왕복은 가져오지 않았다(#63·#25).
import { CASE_SCHEMA, bindValues, canonicalStudioJson, contentSha256, selectSlots, sha256Hex, templateSha256, type SlotSelection, type StudioCase, type StudioTemplate } from '@hwpx-studio/engine';

/** 업무 건 한 행(`record`: 연결 키 → 원래 값)과 수동 선택(슬롯 id → 블록 id)으로 슬롯마다 상태를 판정한다(엔진 8.8.8) */
export function selectBranches(t: StudioTemplate, record: Record<string, unknown>, picks: Record<string, string>, row: number): SlotSelection[] {
  const selections: StudioCase['selections'] = {};
  for (const [slot, block] of Object.entries(picks)) {
    const b = t.blocks.find(x => x.id === block);
    // 없는 블록은 내용 해시 없이 넘겨 엔진이 다시 고를 분기(recheck)로 막게 한다(Helper 창구와 같다)
    selections[slot] = { block, basis: 'manual', content: b === undefined ? '' : contentSha256(b.content) };
  }
  const c: StudioCase | undefined = Object.keys(selections).length === 0 ? undefined : {
    schema: CASE_SCHEMA, template: { id: t.id, version: t.version, sha256: templateSha256(t) },
    record: { dataset: 'workbench', version: 1, row, sha256: sha256Hex(canonicalStudioJson(record)) }, selections, valueEdits: {}, blockEdits: {},
  };
  return selectSlots(t, bindValues(t, record, c), c);
}

/** 막힌 까닭의 쉬운 말(엔진 `reason`) */
export const UNDECIDED_REASON: Record<string, string> = {
  tie: '맞는 블록이 여럿', noCandidate: '맞는 경우가 없고 기본 블록도 없음', valueMissing: '결정 값이 이 업무 건에 없음',
  valueRejected: '결정 값을 읽을 수 없음', needConfirm: '확정이 필요함', blockMissing: '고른 블록이 후보에 없음', contentChanged: '고른 블록의 내용이 바뀜',
};
