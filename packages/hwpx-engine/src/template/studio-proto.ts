import { HwpxError } from "../errors.ts";
import type { BlockProto, ProtoUpdatePlan, ProtoUsage, ProtoUsageList, StudioTemplate, TemplateBlock } from "./studio-types.ts";

// 블록 원형의 영향 목록과 전파 계획(엔진 명세 8.8.7, #21의 순수 함수 부분). 저장·새 판 번호 부여는 저장소(Codex)가 한다.

/**
 * 원형 protoId를 쓰는 곳을 템플릿마다 모은다. templates는 읽은 템플릿(각 템플릿의 최신 판), latest는 저장소가 아는 원형의 최신 판 번호다.
 * 핀(proto)은 고정한 판마다 한 항목(current: 핀 = latest, behind: 핀 < latest), 분기(forkedFrom만 있음)는 갈라진 판마다 한 항목(forked)이다.
 * 순서는 templates 순서, 한 템플릿 안에서는 핀 판 번호순 다음 분기 판 번호순, 블록은 템플릿 blocks 순서다.
 */
export function listProtoUsage(templates: readonly StudioTemplate[], protoId: string, latest: number): ProtoUsageList {
  const usages: ProtoUsage[] = [];
  for (const t of templates) {
    const pinned = new Map<number, string[]>();
    const forked = new Map<number, string[]>();
    for (const b of t.blocks) {
      if (b.proto?.id === protoId) pinned.set(b.proto.version, [...(pinned.get(b.proto.version) ?? []), b.id]);
      else if (b.proto === undefined && b.forkedFrom?.id === protoId) forked.set(b.forkedFrom.version, [...(forked.get(b.forkedFrom.version) ?? []), b.id]);
    }
    for (const [version, blocks] of [...pinned].sort(([a], [b]) => a - b)) {
      usages.push({ template: t.id, version: t.version, blocks, pinned: version, state: version < latest ? "behind" : "current" });
    }
    for (const [version, blocks] of [...forked].sort(([a], [b]) => a - b)) {
      usages.push({ template: t.id, version: t.version, blocks, forkedFrom: version, state: "forked" });
    }
  }
  return { proto: protoId, latest, usages };
}

const nfc = (s: string): string => s.normalize("NFC");

/** 원형의 키마다 그 블록에 적용되는 placeholder 자리가 있고 그 자리의 값에 연결이 있는지 본다. 없으면 PROTO_UNBOUND_KEY */
function checkKeys(t: StudioTemplate, proto: BlockProto, b: TemplateBlock): void {
  const bound = new Set(t.bindings.map((x) => x.value));
  for (const key of proto.keys) {
    const ok = t.places.some((p) => p.kind === "placeholder" && nfc(p.key) === nfc(key) && (p.where === undefined || p.where === b.id) && bound.has(p.value));
    if (!ok) {
      throw new HwpxError("PROTO_UNBOUND_KEY", `원형 ${proto.id}의 ${proto.version}판이 쓰는 키 '${key}'에 템플릿 ${t.id}의 자리(placeholder)나 값 연결이 없어 블록 ${b.id}에 전파할 수 없습니다.`, `blocks.${b.id}`);
    }
  }
}

/**
 * 템플릿 하나에 원형의 새 판을 전파하는 계획(8.8.7). 그 원형을 더 낮은 판으로 고정한 블록의 핀과 내용을 proto로 바꾼 새 템플릿 판(version + 1)을 돌려준다.
 * 분기 블록(forkedFrom)은 대상이 아니다. 바꿀 블록이 없으면 입력의 복사본(판 번호 그대로)과 빈 updated를 돌려준다.
 * 원형의 키 가운데 그 템플릿에 자리나 연결이 없는 것이 있으면 PROTO_UNBOUND_KEY를 던지고 새 판은 없다. 입력 템플릿은 바꾸지 않는다.
 */
export function planProtoUpdate(t: StudioTemplate, proto: BlockProto): ProtoUpdatePlan {
  const targets = t.blocks.filter((b) => b.proto?.id === proto.id && b.proto.version < proto.version);
  for (const b of targets) checkKeys(t, proto, b);
  const next = structuredClone(t);
  if (targets.length === 0) return { template: next, updated: [] };
  const updated: ProtoUpdatePlan["updated"] = [];
  next.version = t.version + 1;
  for (const b of next.blocks) {
    if (b.proto === undefined || !targets.some((x) => x.id === b.id)) continue;
    updated.push({ block: b.id, from: b.proto.version, to: proto.version });
    b.proto = { id: proto.id, version: proto.version };
    b.content = structuredClone(proto.content);
  }
  return { template: next, updated };
}
