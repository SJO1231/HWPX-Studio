import { HwpxError } from "../errors.ts";
import { evaluateCondition } from "./condition.ts";
import { conditionLeaves } from "./studio-read.ts";
import type { BoundValue, SelectionReason, SlotSelection, StudioCase, StudioTemplate, TemplateBlock, TemplateSlot } from "./studio-types.ts";
import { contentSha256 } from "./studio-write.ts";

// 선택 평가와 상태 7종(엔진 명세 8.8.8). 슬롯마다 판정하고 첫 슬롯에서 멈추지 않는다. 순수 함수다.

const ALWAYS_DECIDABLE = new Set(["exists", "empty"]);
const CHOSEN = new Set(["manual", "confirmed", "default", "fallback"]);

const label = (b: TemplateBlock): string => `${b.id}(${b.name})`;
const labels = (bs: TemplateBlock[]): string => bs.map(label).join("·");

type Computed =
  | { state: "default" | "fallback"; block: TemplateBlock; message: string }
  | { state: "undecided"; reason: SelectionReason; candidates: TemplateBlock[]; message: string };

/** 저장 선택이 없을 때의 계산(8.8.8의 3): 조건 값 누락·형식 오류 → 참인 조건 블록의 최고 우선순위 → 조건 없는 블록 하나 */
function compute(blocks: TemplateBlock[], values: Map<string, BoundValue>, data: Record<string, unknown>): Computed {
  const conditioned = blocks.filter((b) => b.when !== undefined);
  const rejected: TemplateBlock[] = [];
  const missing: TemplateBlock[] = [];
  const missingNames = new Set<string>();
  for (const b of conditioned) {
    const leaves = conditionLeaves(b.when ?? { all: [] });
    const paths = [...new Set(leaves.map((l) => l.path))];
    if (paths.some((p) => values.get(p)?.state === "rejected")) {
      rejected.push(b);
      continue;
    }
    for (const p of paths) {
      const v = values.get(p);
      if (v !== undefined && v.state !== "missing") continue;
      // 값이 없는 것이 정상 입력인 참조(exists·empty만 씀)는 판정할 수 있다
      if (leaves.every((l) => l.path !== p || ALWAYS_DECIDABLE.has(l.op))) continue;
      if (!missing.includes(b)) missing.push(b);
      missingNames.add(v?.name ?? p);
    }
  }
  if (rejected.length > 0) {
    return { state: "undecided", reason: "valueRejected", candidates: rejected, message: `블록 ${labels(rejected)}의 조건이 쓰는 값을 데이터에서 읽을 수 없어(형식·별칭 충돌 등) 판정할 수 없습니다.` };
  }
  if (missing.length > 0) {
    return { state: "undecided", reason: "valueMissing", candidates: missing, message: `값 ${[...missingNames].map((n) => `'${n}'`).join("·")}이(가) 데이터에 없어 블록 ${labels(missing)}의 조건을 판정할 수 없습니다.` };
  }
  // 조건 계산이 실패하면(예: matches 입력 글이 한도를 넘음) 던지지 않고 이 슬롯만 판정하지 않는다
  const dataset = { data, derived: {} };
  const truthy: TemplateBlock[] = [];
  const failed: { block: TemplateBlock; error: HwpxError }[] = [];
  for (const b of conditioned) {
    try {
      if (evaluateCondition(b.when ?? { all: [] }, dataset)) truthy.push(b);
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      failed.push({ block: b, error: e });
    }
  }
  if (failed.length > 0) {
    const reasons = failed.map((f) => `${label(f.block)}: ${f.error.code} ${f.error.message}`).join(" / ");
    return { state: "undecided", reason: "valueRejected", candidates: failed.map((f) => f.block), message: `블록 조건을 계산하지 못해 판정할 수 없습니다(${reasons}).` };
  }
  if (truthy.length > 0) {
    const top = Math.max(...truthy.map((b) => b.priority ?? 0));
    const best = truthy.filter((b) => (b.priority ?? 0) === top);
    const first = best[0];
    if (best.length === 1 && first !== undefined) return { state: "default", block: first, message: `조건이 참인 블록 가운데 우선순위가 가장 높은 ${label(first)}을(를) 골랐습니다.` };
    return { state: "undecided", reason: "tie", candidates: best, message: `조건이 참인 블록 ${labels(best)}의 우선순위(${top})가 같아 고를 수 없습니다.` };
  }
  const plain = blocks.filter((b) => b.when === undefined);
  const only = plain[0];
  if (plain.length === 1 && only !== undefined) return { state: "fallback", block: only, message: `참인 조건이 없어 조건 없는 블록 ${label(only)}을(를) 골랐습니다.` };
  if (plain.length > 1) return { state: "undecided", reason: "tie", candidates: plain, message: `참인 조건이 없고 조건 없는 블록 ${labels(plain)}이(가) 여럿이라 고를 수 없습니다.` };
  return { state: "undecided", reason: "noCandidate", candidates: [], message: "참인 조건이 없고 조건 없는 블록도 없어 고를 블록이 없습니다." };
}

/** 조건에서 쓰는 값(8.8.8의 3): 표시 글이 아니라 꾸미기 전 정규 값이다. 빈 값은 빈 글이다 */
function conditionValue(v: BoundValue): unknown {
  switch (v.format) {
    case "number":
    case "money":
    case "percent":
      return v.number ?? "";
    case "date":
    case "datetime":
      return v.normalized ?? "";
    case "boolean":
      return v.normalized === undefined ? "" : v.normalized === "true";
    default:
      return v.text ?? "";
  }
}

/**
 * 슬롯마다 선택 상태를 판정한다(8.8.8). values는 bindValues의 값 표, c는 이번 건(없으면 저장 선택 없음). 결과는 템플릿 slots 순서다.
 * 조건의 데이터는 값 표에서 만든 { 값 id: 값 }이다(꾸미기 전 정규 값: number·money·percent는 수, date·datetime은 정규 꼴 글, boolean은 참거짓,
 * text는 글, 빈 값은 빈 글, missing·rejected는 키 없음).
 * 막는 상태는 blocked(SEL_UNDECIDED·SEL_RECHECK)로 표시하고 던지지 않는다.
 */
export function selectSlots(t: StudioTemplate, values: readonly BoundValue[], c: StudioCase | undefined): SlotSelection[] {
  const byId = new Map(values.map((v) => [v.id, v]));
  const data: Record<string, unknown> = {};
  for (const v of values) {
    if (v.state === "missing" || v.state === "rejected") continue;
    data[v.id] = conditionValue(v);
  }
  const blocks = new Map(t.blocks.map((b) => [b.id, b]));
  const slotBlocks = (s: TemplateSlot): TemplateBlock[] => t.blocks.filter((b) => b.slot === s.id);
  const slots = new Map(t.slots.map((s) => [s.id, s]));
  const requireConfirm = t.options?.requireConfirm === true;
  const done = new Map<string, SlotSelection>();

  const judge = (s: TemplateSlot): SlotSelection => {
    const memo = done.get(s.id);
    if (memo !== undefined) return memo;
    const saved = c !== undefined && Object.hasOwn(c.selections, s.id) ? c.selections[s.id] : undefined;

    // 1. 중첩 슬롯: 상위 블록이 선택되지 않았으면 inactive(예약). 확정을 기다리는 default·fallback도 선택으로 본다.
    //    상위가 그 블록을 저장한 채 다시 확인 대상(recheck)이면 하위의 저장 선택도 다시 확인한다.
    if (s.parent !== null) {
      const parentBlock = blocks.get(s.parent);
      const parentSlot = parentBlock === undefined ? undefined : slots.get(parentBlock.slot);
      const up = parentSlot === undefined ? undefined : judge(parentSlot);
      if (up !== undefined && up.state === "recheck" && up.block === s.parent && saved !== undefined) {
        return finish(s, { slot: s.id, state: "recheck", block: saved.block, reason: "parentChanged", blocked: "SEL_RECHECK", message: `상위 슬롯 ${up.slot}의 선택을 다시 확인해야 해서 이 슬롯의 저장한 선택도 다시 확인해야 합니다.` });
      }
      const selected = up !== undefined && up.block === s.parent && CHOSEN.has(up.state);
      if (!selected) return finish(s, { slot: s.id, state: "inactive", message: `상위 블록 ${s.parent}이(가) 선택되지 않아 이 슬롯은 쓰이지 않습니다.` });
    }

    const own = slotBlocks(s);
    const computed = compute(own, byId, data);

    // 2. 저장한 선택(manual·confirmed): 블록이 없어졌거나 내용 해시가 다르면 recheck. 조건 결과가 달라도 바꾸지 않고 differs만 표시한다.
    if (saved !== undefined) {
      const b = blocks.get(saved.block);
      if (b === undefined || b.slot !== s.id) {
        return finish(s, { slot: s.id, state: "recheck", block: saved.block, reason: "blockMissing", blocked: "SEL_RECHECK", message: `저장한 선택의 블록 ${saved.block}이(가) 이 슬롯에 없습니다. 다시 골라야 합니다.` });
      }
      if (contentSha256(b.content) !== saved.content) {
        return finish(s, { slot: s.id, state: "recheck", block: saved.block, reason: "contentChanged", blocked: "SEL_RECHECK", message: `저장한 선택의 블록 ${label(b)}의 내용이 바뀌었습니다. 다시 확인해야 합니다.` });
      }
      const out: SlotSelection = { slot: s.id, state: saved.basis, block: b.id, message: saved.basis === "manual" ? `사용자가 고른 블록 ${label(b)}을(를) 씁니다.` : `사용자가 확정한 블록 ${label(b)}을(를) 씁니다.` };
      if (computed.state !== "undecided" && computed.block.id !== b.id) {
        out.differs = true;
        out.candidates = [computed.block.id];
        out.message += ` 조건으로는 ${label(computed.block)}이(가) 골라집니다.`;
      }
      return finish(s, out);
    }

    // 3. 계산. 4. requireConfirm이면 default·fallback은 확정 전까지 막는다.
    if (computed.state === "undecided") {
      return finish(s, { slot: s.id, state: "undecided", reason: computed.reason, candidates: computed.candidates.map((b) => b.id), blocked: "SEL_UNDECIDED", message: computed.message });
    }
    if (requireConfirm) {
      return finish(s, { slot: s.id, state: computed.state, block: computed.block.id, reason: "needConfirm", blocked: "SEL_UNDECIDED", message: `${computed.message} 이 템플릿은 확정이 필요해 사용자가 확정하기 전에는 생성할 수 없습니다.` });
    }
    return finish(s, { slot: s.id, state: computed.state, block: computed.block.id, message: computed.message });
  };

  const finish = (s: TemplateSlot, sel: SlotSelection): SlotSelection => {
    done.set(s.id, sel);
    return sel;
  };

  return t.slots.map((s) => judge(s));
}
