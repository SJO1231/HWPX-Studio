import { HwpxError } from "../errors.ts";
import type { BlockProto, ProtoUpdatePlan, ProtoUsage, ProtoUsageList, StudioTemplate, TemplateNotice } from "./studio-types.ts";

// 블록 원형의 영향 목록과 전파 계획(엔진 명세 8.8.7, #21의 순수 함수 부분). 새 판 만들기(`reextractBlock`)는 엔진, 저장소·화면은 Codex가 한다.

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

/**
 * 원형의 키마다 대상 블록(그 원형을 더 낮은 판으로 고정한 블록)에 적용되는 placeholder 자리가 있고 그 자리의 값에 연결이 있는지 본다.
 * 없는 것 전부를 PROTO_UNBOUND_KEY 오류로 돌려준다(대상 블록 순서, 한 블록 안에서는 원형 keys 순서). planProtoUpdate는 그 첫 오류를 던진다.
 */
export function unboundKeys(t: StudioTemplate, proto: BlockProto): HwpxError[] {
  const bound = new Set(t.bindings.map((x) => x.value));
  const out: HwpxError[] = [];
  for (const b of t.blocks) {
    if (b.proto?.id !== proto.id || b.proto.version >= proto.version) continue;
    for (const key of proto.keys) {
      const ok = t.places.some((p) => p.kind === "placeholder" && nfc(p.key) === nfc(key) && (p.where === undefined || p.where === b.id) && bound.has(p.value));
      if (!ok) {
        out.push(new HwpxError("PROTO_UNBOUND_KEY", `원형 ${proto.id}의 ${proto.version}판이 쓰는 키 '${key}'에 템플릿 ${t.id}의 자리(placeholder)나 값 연결이 없어 블록 ${b.id}에 전파할 수 없습니다.`, `blocks.${b.id}`));
      }
    }
  }
  return out;
}

/**
 * 템플릿 하나에 원형의 새 판을 전파하는 계획(8.8.7). 그 원형을 더 낮은 판으로 고정한 블록의 핀과 내용을 proto로 바꾼 새 템플릿 판(version + 1)을 돌려준다.
 * 분기 블록(forkedFrom)은 대상이 아니다. 바꿀 블록이 없으면 입력의 복사본(판 번호 그대로)과 빈 updated를 돌려준다.
 * 원형의 키 가운데 그 템플릿에 자리나 연결이 없는 것이 있으면 PROTO_UNBOUND_KEY를 던지고 새 판은 없다. 입력 템플릿은 바꾸지 않는다.
 */
export function planProtoUpdate(t: StudioTemplate, proto: BlockProto): ProtoUpdatePlan {
  const targets = t.blocks.filter((b) => b.proto?.id === proto.id && b.proto.version < proto.version);
  const unbound = unboundKeys(t, proto)[0];
  if (unbound !== undefined) throw unbound;
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

/**
 * 템플릿의 "최신 버전 있음" 알림(8.8.17). 자동 교체는 없고 알림만 돌려준다(템플릿을 바꾸지 않는다).
 * - `TPL_SOURCE_CHANGED`: `currentSource`(지금 바탕 문서 바이트의 sha256)를 주었고 템플릿의 `source.sha256`과 다르다. 그대로 생성하면 `TPL_SOURCE_MISMATCH`로 막히므로
 *   재지정(8.8.13)으로 새 템플릿 판을 만들어야 한다.
 * - `BLOCK_NEWER_VERSION`: 원형을 고정(`proto`)한 블록마다, `latestOf(원형 id)`가 핀보다 큰 판을 알려 주면 하나. 저장소가 모르는 원형(undefined)과 분기 블록(`forkedFrom`)은 알리지 않는다.
 * 순서: 바탕 문서 알림, 그다음 블록(템플릿 blocks 순서).
 */
export function checkTemplateUpdates(t: StudioTemplate, latestOf: (protoId: string) => number | undefined, currentSource?: string): TemplateNotice[] {
  const out: TemplateNotice[] = [];
  if (currentSource !== undefined && currentSource.toLowerCase() !== t.source.sha256) {
    const actual = currentSource.toLowerCase();
    out.push({
      code: "TPL_SOURCE_CHANGED",
      template: t.id,
      version: t.version,
      expected: t.source.sha256,
      actual,
      message: `템플릿 ${t.id}(${t.version}판)의 바탕 문서(${t.source.sha256.slice(0, 10)})와 지금 바탕 문서(${actual.slice(0, 10)})가 다릅니다. 최신 버전이 있습니다. 앵커를 다시 확인해 새 템플릿 판으로 저장해야 생성할 수 있습니다.`,
    });
  }
  for (const b of t.blocks) {
    if (b.proto === undefined) continue;
    const latest = latestOf(b.proto.id);
    if (latest === undefined || latest <= b.proto.version) continue;
    out.push({
      code: "BLOCK_NEWER_VERSION",
      template: t.id,
      block: b.id,
      proto: b.proto.id,
      pinned: b.proto.version,
      latest,
      message: `블록 ${b.id}이(가) 쓰는 원형 ${b.proto.id}의 ${b.proto.version}판보다 새 판(${latest}판)이 있습니다. 자동으로 바꾸지 않습니다.`,
    });
  }
  return out;
}
