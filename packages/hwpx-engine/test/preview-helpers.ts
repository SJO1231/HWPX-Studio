// 블록 미리보기 시험(엔진·뷰어·실제 문서)이 함께 쓰는 독립 계산: 원본 문서의 범위에서 입력 항목(종류·이름별 수)을 엔진 미리보기와 다른 길로 센다.
// 누름틀·메일머지는 원본 `listFields`의 범위 안 필드, `{{ 키 }}`는 범위 안 문단 글의 표기 수에서 필드 값 글 안의 표기 수를 뺀 것이다.
import { listFields, walkParagraphs, type FieldInfo, type HwpxDocument } from "../src/index.ts";
import { listAtParent } from "../src/fill/range.ts";

export type PreviewRange = { sectionIndex: number; parentPath: number[]; from: number; to: number };

const LOOSE = /\{\{((?:(?!\{\{|\}\})[^\n\r])*)\}\}/g;
/** 글 안의 느슨한 `{{ 키 }}` 표기(키 1~80자) */
export const looseKeys = (text: string): string[] =>
  [...text.matchAll(LOOSE)].map((m) => (m[1] ?? "").trim()).filter((k) => Array.from(k).length >= 1 && Array.from(k).length <= 80).map((k) => k.normalize("NFC"));

/** 경로가 범위 안인가(범위 부모의 그 문단들 또는 그 아래) */
export const inside = (path: readonly number[], r: PreviewRange): boolean =>
  path.length > r.parentPath.length && r.parentPath.every((v, i) => path[i] === v) && (path[r.parentPath.length] ?? -1) >= r.from && (path[r.parentPath.length] ?? -1) <= r.to;

export const kindOf = (f: FieldInfo): string | undefined => (f.type === "CLICK_HERE" && f.name !== "" ? "clickHere" : f.type === "MAILMERGE" && f.mergeKey !== undefined ? "mailMerge" : undefined);

/** 원본 문서에서 따로 센 입력 항목(종류\t이름 → 수) */
export function expectedCounts(doc: HwpxDocument, r: PreviewRange): Map<string, number> {
  const out = new Map<string, number>();
  const add = (key: string, n: number): void => {
    out.set(key, (out.get(key) ?? 0) + n);
    if (out.get(key) === 0) out.delete(key);
  };
  const fields = listFields(doc).filter((f) => f.sectionIndex === r.sectionIndex && inside(f.path, r));
  for (const f of fields) {
    const kind = kindOf(f);
    if (kind !== undefined) add(`${kind}\t${(kind === "clickHere" ? f.name : (f.mergeKey ?? "")).normalize("NFC")}`, 1);
  }
  const list = listAtParent(doc.sections[r.sectionIndex]!, r.parentPath)!;
  for (const p of walkParagraphs(list.slice(r.from, r.to + 1))) for (const k of looseKeys(p.logicalText)) add(`placeholder\t${k}`, 1);
  // 누름틀·메일머지 값 글 안의 표기는 그 필드가 맡는다
  for (const f of fields) if (kindOf(f) !== undefined) for (const k of looseKeys(f.valueText)) add(`placeholder\t${k}`, -1);
  return out;
}
