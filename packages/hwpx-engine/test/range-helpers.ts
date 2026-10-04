// 범위 앵커 시험(range-anchor·range-com)이 함께 쓰는 시험 문서와 도우미.
import assert from "node:assert/strict";
import {
  extractFragment,
  findPlaceholders,
  isTableNode,
  isValidPath,
  listFields,
  serializeFragment,
  validateDocument,
  walkParagraphs,
  type HwpxDocument,
  type ParagraphNode,
} from "../src/index.ts";
import { generate, makeLineAnchor, makeRangeAnchor, remapAddress, type GenerateResult, type Move, type RangeAnchor } from "../src/fill/index.ts";
import { readDataset, type Template } from "../src/template/index.ts";
import { newErrorsAfter, readFixture, reparse } from "./helpers.ts";

export type Done = Extract<GenerateResult, { ok: true; dryRun: false }>;

export function done(r: GenerateResult): Done {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  assert.ok(!r.dryRun);
  return r as Done;
}

export function failed(r: GenerateResult): string[] {
  assert.equal(r.ok, false, "생성이 성공해 버렸다");
  assert.ok(!("output" in r), "실패인데 출력이 있다");
  return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
}

export function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  assert.ok(v !== undefined, `${i}번째가 없다`);
  return v;
}

export const tpl = (anchors: unknown[], rules: unknown[], options: Template["options"] = {}): Template => ({ schema: "hwpx-studio/template@1", anchors, rules, options }) as Template;
export const ds = (data: unknown) => readDataset(data);
export const KEEP = { missing: "keep" } as const;
export const OBJ = "￼";

export const top = (doc: HwpxDocument): ParagraphNode[] => at(doc.sections, 0).paragraphs;
export const texts = (ps: readonly ParagraphNode[]): string[] => ps.map((p) => p.logicalText);
export const walkTexts = (ps: ParagraphNode[]): string[] => [...walkParagraphs(ps)].map((p) => p.logicalText);
export const tablesIn = (ps: ParagraphNode[]): number => [...walkParagraphs(ps)].reduce((n, p) => n + p.objects.filter((o) => isTableNode(o)).length, 0);
export const listOf = (doc: HwpxDocument, parentPath: number[]): ParagraphNode[] => {
  let list = top(doc);
  for (let i = 0; i < parentPath.length; i += 2) list = at(at(list, at(parentPath, i)).subLists, at(parentPath, i + 1)).paragraphs;
  return list;
};

export function range(doc: HwpxDocument, id: string, from: number, to: number, parentPath: number[] = [], sectionIndex = 0): RangeAnchor {
  const draft = makeRangeAnchor(doc, sectionIndex, parentPath, from, to);
  assert.ok(draft !== undefined, `범위 ${from}~${to}의 앵커를 만들지 못했다`);
  return { id, ...draft };
}
export function line(doc: HwpxDocument, id: string, path: number[]) {
  const a = makeLineAnchor(doc, id, 0, path);
  assert.ok(a !== undefined);
  return a;
}
export const fragOf = (doc: HwpxDocument, from: number, to: number, parentPath: number[] = []): Record<string, unknown> =>
  JSON.parse(serializeFragment(extractFragment(doc, { sectionIndex: 0, parentPath, from, to }))) as Record<string, unknown>;
export const inject = (id: string, anchor: string, fragment: unknown, position = "replace") => ({ id, do: { type: "inject", anchor, position, fragment } });
export const insertText = (id: string, anchor: string, text: string, position = "replace") => ({ id, do: { type: "insertText", anchor, position, value: { text }, style: "inherit" } });
export const del = (id: string, anchor: string) => ({ id, do: { type: "delete", anchor } });
export const move = (from: number, to: number, count: number, parentPath: number[] = []): Move => ({ sectionIndex: 0, parentPath, from, to, count, delta: count - (to - from + 1) });

/** 게이트의 새 오류 0과 독립 재검사의 새 오류 0 */
export function gateClean(before: Uint8Array, r: Done): void {
  assert.deepEqual(r.report.validation?.newErrors.map((v) => v.code) ?? ["검사 결과 없음"], []);
  assert.deepEqual(newErrorsAfter(validateDocument(before), validateDocument(r.output)).map((v) => v.code), []);
}

/** 이동표대로 옮긴 원본 문단(범위 밖)마다 결과 문서의 같은 글이 있는가(`expect`는 원본 주소의 기대 글) */
export function remapHolds(moves: readonly Move[], beforeList: readonly string[], afterDoc: HwpxDocument, parentPath: number[] = [], expect: (i: number) => string = (i) => at(beforeList, i)): number {
  let covered = 0;
  beforeList.forEach((_, i) => {
    const mapped = remapAddress(moves, { sectionIndex: 0, path: [...parentPath, i] });
    if (mapped === undefined) {
      covered++;
      return;
    }
    const after = texts(listOf(afterDoc, mapped.path.slice(0, -1)));
    assert.equal(after[at(mapped.path, mapped.path.length - 1)], expect(i), `원본 문단 ${i} → ${mapped.path.join(",")}`);
  });
  return covered;
}

// ── 시험 문서 ──────────────────────────────────────────────────

export const HEADINGS = [17, 22, 27, 32, 37, 42];
/**
 * 합성 공고서(시험용): `merge/merge-fields`(한글 2024 저장본, 메일 머지 필드·누름틀·`{{}}`·표 2개) 뒤에 번호 제목 6개와 본문 24문단을 붙이고,
 * 앞부분(문단 1~16) 복사본을 그 뒤에 붙이고, 첫 표의 칸 [12, 1]에 문단 5개를 더한다. 엔진의 insertText·inject로 만든다.
 * 최상위 63문단: [0]=구역 설정, [1..16]=원본, [17..46]=제목(17·22·27·32·37·42)과 본문(그 뒤 4개씩), [47..62]=복사본. 칸 [12, 1]은 6문단.
 */
let noticeCache: Uint8Array | undefined;
export function notice(): Uint8Array {
  if (noticeCache !== undefined) return noticeCache;
  const source = readFixture("merge/merge-fields");
  const d0 = reparse(source);
  const lines: string[] = [];
  for (let h = 1; h <= 6; h++) {
    lines.push(`${h}. 제${h}장 사업 안내`);
    for (let b = 1; b <= 4; b++) lines.push(`${h}-${b}. 본문 ${h}장 ${b}절: {{기관명}}이 {{사업명}}을 안내합니다. ${"세부 사항 & <참고>. ".repeat(b)}`);
  }
  const cellLines = ["칸 문단 1", "칸 문단 2 {{담당자}}", "칸 문단 3", "칸 문단 4", "칸 문단 5"];
  const step1 = done(
    generate(
      source,
      tpl([line(d0, "end", [16]), line(d0, "cell", [12, 1, 0])], [insertText("body", "end", lines.join("\n"), "after"), insertText("cellp", "cell", cellLines.join("\n"), "after")]),
      ds({}),
      KEEP,
    ),
  );
  const d1 = reparse(step1.output);
  const step2 = done(generate(step1.output, tpl([line(d1, "end", [46])], [inject("copy", "end", fragOf(d0, 1, 16), "after")]), ds({}), KEEP));
  noticeCache = step2.output;
  return noticeCache;
}

// ── 값 ────────────────────────────────────────────────────────

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const PIECES = ["공고 내용을 안내합니다.", "제출 서류는 원본 1부입니다.", "문의: 담당 부서 & 지원 팀.", "<참고> 기한을 지키십시오.", "\"인용\"과 '홑따옴표'.", "\n", "\t", "추가 설명 문장이 이어집니다."];
export function longValue(next: () => number, min: number, max: number): string {
  const n = min + Math.floor(next() * (max - min));
  let s = "";
  while (s.length < n) s += `${PIECES[Math.floor(next() * PIECES.length)] ?? ""} `;
  return s.slice(0, n);
}

/** 문서의 모든 자리(`{{경로}}`, 누름틀 이름, 경로 꼴 메일 머지 키)에 값을 준 데이터 */
export function dataFor(doc: HwpxDocument, value: (path: string) => string): Record<string, unknown> {
  const paths = new Set<string>();
  for (const s of doc.sections) for (const p of walkParagraphs(s.paragraphs)) for (const x of findPlaceholders(p.logicalText)) paths.add(x.path);
  for (const f of listFields(doc)) {
    const key = f.type === "MAILMERGE" ? f.mergeKey : f.name;
    if (key !== undefined && isValidPath(key)) paths.add(key);
  }
  const data: Record<string, unknown> = {};
  for (const path of [...paths].sort()) {
    const parts = path.split(".");
    let o = data;
    for (const k of parts.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
    o[at(parts, parts.length - 1)] = value(path);
  }
  return data;
}
