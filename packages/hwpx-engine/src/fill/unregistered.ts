import type { HwpxDocument } from "../model/types.ts";
import type { StudioTemplate } from "../template/studio-types.ts";
import { inputPlaces, type BlockPreviewPlace } from "./block-preview.ts";
import { fieldInput, nfc } from "./studio-common.ts";

/**
 * 템플릿 `places`에 등록되지 않은 입력 항목 자리(엔진 명세 8.8.12, #134): 이름 있는 누름틀, 키 있는 메일머지, 그 표시 구간 밖의 느슨한 `{{ 키 }}`.
 * 종류·이름(NFC)·주소는 `buildBlockPreviewDocument`의 자리와 같은 형이고 문서 순서다. 등록 판정은 2단계 생성과 같다: 같은 종류·같은 이름(키, NFC)의 자리가 있으면 등록이고,
 * `occurrence`를 준 필드 자리는 그 순번 하나만 맡는다.
 */
// shortcut: 주어진 문서를 블록 교체 전 그대로 본다(`where` 자리는 아무것도 맡지 않고, 슬롯 교체로 사라질 자리도 센다), 고른 블록 기준 목록이 화면에 필요해지면 생성 보고의 자리 목록으로 올린다
export function listUnregisteredPlaces(doc: HwpxDocument, t: StudioTemplate): BlockPreviewPlace[] {
  const places = t.places.filter((p) => !("where" in p) || p.where === undefined);
  return inputPlaces(doc, {
    field: (info) => {
      const input = fieldInput(info);
      return places.some(
        (p) => (p.kind === "clickHere" || p.kind === "mailMerge") && p.kind === input?.kind && nfc(p.kind === "clickHere" ? p.name : p.key) === input.name && (p.occurrence === undefined || p.occurrence === info.occurrence),
      );
    },
    key: (key) => places.some((p) => p.kind === "placeholder" && nfc(p.key) === nfc(key)),
  });
}
