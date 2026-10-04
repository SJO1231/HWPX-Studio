import type { SpanEdit } from "../edit/plan.ts";
import type { ParagraphNode } from "../model/types.ts";
import { findPlaceholders } from "../template/placeholder.ts";
import type { Dataset, MissingPolicy, MixedFormatPolicy, ReportDrop, ValueDigest } from "../template/types.ts";
import { digestValue, resolvePathValue } from "../template/value.ts";
import type { Repl } from "./doc.ts";
import { planRangeReplace, type Ctx } from "./text.ts";

export type PlaceholderOutcome = {
  edits: SpanEdit[];
  /** 문단 → 그 문단 논리 텍스트에서 바뀐 구간 */
  repls: Map<ParagraphNode, Repl[]>;
  /** 채운 자리(자리마다 하나) */
  filled: { path: string; digest: ValueDigest }[];
  skipped: { path: string; code: string; message: string; address: number[] }[];
  /** `missing: keep`으로 그대로 둔 자리 수(경로별) */
  kept: Map<string, number>;
  /** 데이터에 없던(또는 null인) 경로와 자리 수 */
  missing: Map<string, number>;
  /** 채울 수 없는 값의 오류(경로·코드별로 한 번) */
  errors: { path: string; code: string; message: string }[];
  /** 삭제·교체·구간 치환으로 사라져 버린 자리 수(경로별) */
  dropped: Map<string, number>;
  /** 메일 머지 필드가 맡는 표시 글 안이라 버린 자리 수(경로별) */
  mergeDisplay: Map<string, number>;
};

/**
 * 문단들에서 `{{경로}}` 표기를 찾아 데이터로 채우는 편집을 만든다(문서 본문과 조각 원문이 같이 쓴다).
 * 표기 하나가 하나의 자리다. 건너뛴 자리는 `skipped`에, 데이터가 없는 자리는 `missing`과 정책(`error`·`empty`·`keep`)에 따라 담는다.
 */
export function fillPlaceholders(
  ctx: Ctx,
  paragraphs: Iterable<ParagraphNode>,
  dataset: Dataset,
  policy: MissingPolicy,
  mixed: MixedFormatPolicy,
  /** 이 문단의 논리 구간 `[start, end)`에 있는 자리를 버리는가와 그 까닭(자리마다 묻는다). 버리지 않으면 undefined. */
  isDropped: (par: ParagraphNode, start: number, end: number) => ReportDrop["kind"] | undefined = () => undefined,
  /** 이 문단의 이 경로 자리는 채우지 않는다(오류도 건너뜀도 아니다. 호출자가 센다). 조건이 거짓인 행 반복의 원소·순번 자리에 쓴다. */
  isExcluded: (par: ParagraphNode, path: string) => boolean = () => false,
): PlaceholderOutcome {
  const out: PlaceholderOutcome = {
    edits: [],
    repls: new Map(),
    filled: [],
    skipped: [],
    kept: new Map(),
    missing: new Map(),
    errors: [],
    dropped: new Map(),
    mergeDisplay: new Map(),
  };
  const seenErrors = new Set<string>();
  const bump = (m: Map<string, number>, key: string): void => void m.set(key, (m.get(key) ?? 0) + 1);

  for (const par of paragraphs) {
    for (const hit of findPlaceholders(par.logicalText)) {
      const drop = isDropped(par, hit.start, hit.end);
      if (drop !== undefined) {
        bump(drop === "covered" ? out.dropped : out.mergeDisplay, hit.path);
        continue;
      }
      if (isExcluded(par, hit.path)) continue;
      const value = resolvePathValue(dataset, hit.path, policy);
      if (value.kind === "error") {
        if (value.code === "DATA_MISSING") bump(out.missing, hit.path);
        const key = `${value.code}\u0000${hit.path}`;
        if (!seenErrors.has(key)) {
          seenErrors.add(key);
          out.errors.push({ path: hit.path, code: value.code, message: value.message });
        }
        continue;
      }
      if (value.kind === "keep") {
        bump(out.missing, hit.path);
        bump(out.kept, hit.path);
        continue;
      }
      if (value.kind === "empty") bump(out.missing, hit.path);
      const text = value.kind === "text" ? value.text : "";
      const plan = planRangeReplace(ctx, par, hit.start, hit.end, text, mixed, `{{${hit.path}}} 채움`);
      if ("skip" in plan) {
        out.skipped.push({ path: hit.path, code: plan.skip.code, message: plan.skip.message, address: par.path });
        continue;
      }
      out.edits.push(...plan.edits);
      const list = out.repls.get(par) ?? [];
      list.push(...plan.repls);
      out.repls.set(par, list);
      out.filled.push({ path: hit.path, digest: digestValue(text) });
    }
  }
  return out;
}
