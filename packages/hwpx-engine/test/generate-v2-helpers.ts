// 2판 생성 시험(generate-v2·generate-v2-com·CLI fill-v2)이 함께 쓰는 시험 자료: 합성 공고서(range-helpers의 notice)에 맞춘
// 실제 해시의 2판 템플릿·조각 덩어리·이번 건·데이터 행을 시험 안에서 만든다(파일로 두지 않는다).
import assert from "node:assert/strict";
import { extractFragment, serializeFragment, type HwpxDocument } from "../src/index.ts";
import { makeCellAnchor, makeWordAnchor } from "../src/fill/index.ts";
import { contentSha256, readStudioTemplate, sha256Hex, templateSha256, type BlockContent, type StudioCase, type StudioTemplate } from "../src/template/index.ts";
import { readFixture, reparse } from "./helpers.ts";
import { at, line, longValue, notice, range } from "./range-helpers.ts";

export type Blobs = Map<string, Uint8Array>;
export const loaderOf = (blobs: Blobs) => (sha: string): Uint8Array | undefined => blobs.get(sha);

/** 조각을 떠 덩어리(`hwpx-studio/fragment@1` JSON의 UTF-8 바이트)로 담고 내용 해시를 돌려준다 */
export function blobOf(blobs: Blobs, doc: HwpxDocument, from: number, to: number, parentPath: number[] = []): string {
  const bytes = new TextEncoder().encode(serializeFragment(extractFragment(doc, { sectionIndex: 0, parentPath, from, to })));
  const sha = sha256Hex(bytes);
  blobs.set(sha, bytes);
  return sha;
}

/** 원문 템플릿 객체를 JSON으로 써서 2판 읽기 검사(덩어리 존재 포함)를 거친다 */
export function studioOf(raw: Record<string, unknown>, blobs: Blobs): StudioTemplate {
  const t = readStudioTemplate(JSON.stringify(raw), { hasBlob: (sha) => blobs.has(sha) });
  assert.ok(t.schema === "hwpx-studio/template@2");
  return t;
}

export function caseOf(t: StudioTemplate, record: Record<string, unknown>, parts: Partial<Pick<StudioCase, "selections" | "valueEdits" | "blockEdits">> = {}): StudioCase {
  return {
    schema: "hwpx-studio/case@1",
    template: { id: t.id, version: t.version, sha256: templateSha256(t) },
    record: { dataset: "d0000c0de", version: 1, row: 0, sha256: sha256Hex(JSON.stringify(record)) },
    selections: parts.selections ?? {},
    valueEdits: parts.valueEdits ?? {},
    blockEdits: parts.blockEdits ?? {},
  };
}

export const manual = (t: StudioTemplate, slot: string, block: string): StudioCase["selections"][string] => {
  const b = t.blocks.find((x) => x.id === block);
  assert.ok(b !== undefined && b.slot === slot);
  return { block, basis: "manual", content: contentSha256(b.content) };
};

// ── 합성 공고서용 템플릿 ───────────────────────────────────────

/** 메일 머지 필드 키(합성 공고서의 원본 부분과 복사본에 모두 있다) */
export const MERGE_KEYS = ["기관명", "담당자", "연락처", "공고번호", "사업명", "시행일", "접수기간", "추정가격", "참고 사항", "계약 방법(수의)", "장소", "예정가격", "부가세"];
/** `{{ }}` 자리 키(본문 글·블록 글) */
export const PLACEHOLDER_KEYS = ["project.name", "project.start", "project.end", "dates.start", "dates.end", "dates.days", "manager.phone", "manager.email", "기관명", "사업명", "담당자", "담당자 이름", "연락처"];
export const CLICK_NAMES = ["성명", "소속", "직위"];
/** 낱말·줄·칸 자리의 값 이름 */
export const SPOT_NAMES = ["낱말 머리말", "낱말 범위 뒤", "낱말 범위 안", "낱말 칸 뒤", "낱말 칸 앞", "줄 범위 뒤", "줄 범위 안", "칸 복사본", "칸 첫 표"];
/** 순번·where 자리의 값 이름 */
export const SPECIAL_NAMES = ["사유 설명", "재공고", "이름"];
export const MONEY = new Set(["추정가격", "예정가격"]);

/** 값 이름 → 데이터 열 이름(`추정가격`만 머리글이 다르다) */
export const columnOf = (name: string): string => (name === "추정가격" ? "추정가격(원)" : name);

export type NoticeKit = {
  bytes: Uint8Array;
  doc: HwpxDocument;
  blobs: Blobs;
  /** 수정하기 전의 원문 템플릿 객체(시험이 고쳐 다른 템플릿을 만든다) */
  raw: Record<string, unknown>;
  t: StudioTemplate;
  valueId: (name: string) => string;
  /** 블록 id → 원본 조각의 최상위 문단 글(조각 블록) */
  fragmentTexts: Map<string, string[]>;
};

/**
 * 합성 공고서(최상위 63문단, 칸 [12, 1]에 6문단)에 맞춘 2판 템플릿: 값 38개, 자리 41개(메일머지 15·누름틀 4·`{{ }}` 13·낱말 5·줄 2·칸 2. 머리말·꼬리말·표 칸·본문에 분산, 조립본에서 필드 대상 80여 곳),
 * 슬롯 4개(범위 하나 / 범위 둘 / 표 칸 안 범위 / 줄), 블록 9개(조각 3·글 6, 조건·우선순위·조건 없는 블록).
 * - s1(18~22): b1 조각(추정가격 ≥ 1억, 우선 10) · b1t 글(중소기업 = Y, 우선 5) · b2 글(조건 없음)
 * - s2(28~31, 38~41): b3 조각(표·그림·누름틀 `이름`) · b4 글. 둘 다 조건 없음이라 이번 건에서 골라야 한다
 * - s3(칸 [12, 1]의 2~4): b5 글(중소기업 = Y) · b6 빈 글(조건 없음, 범위를 지운다)
 * - s4(줄 33): b8 조각(메일머지 필드 문단 4개, 추정가격 ≥ 5천만) · b7 글(조건 없음)
 */
export function noticeKit(): NoticeKit {
  const bytes = notice();
  const doc = reparse(bytes);
  const blobs: Blobs = new Map();
  const blocksDoc = reparse(readFixture("hancom/blocks"));
  const richDoc = reparse(readFixture("tables/tables-rich"));
  const mergeDoc = reparse(readFixture("merge/merge-fields"));
  const fragB1 = blobOf(blobs, blocksDoc, 2, 3);
  const fragB3 = blobOf(blobs, richDoc, 1, 1);
  const fragB8 = blobOf(blobs, mergeDoc, 5, 8);
  const fragmentTexts = new Map([
    ["b1", blocksDoc.sections[0]!.paragraphs.slice(2, 4).map((p) => p.logicalText)],
    ["b3", richDoc.sections[0]!.paragraphs.slice(1, 2).map((p) => p.logicalText)],
    ["b8", mergeDoc.sections[0]!.paragraphs.slice(5, 9).map((p) => p.logicalText)],
  ]);

  const names = [...new Set([...MERGE_KEYS, ...PLACEHOLDER_KEYS, ...CLICK_NAMES, ...SPOT_NAMES, ...SPECIAL_NAMES, "중소기업"])];
  const ids = new Map(names.map((n, i) => [n, `v${i + 1}`]));
  const valueId = (name: string): string => {
    const id = ids.get(name);
    assert.ok(id !== undefined, name);
    return id;
  };
  const values = names.map((name) => ({ id: valueId(name), name, format: MONEY.has(name) ? "money" : "text" }));
  const bindings = names.map((name) =>
    name === "중소기업" ? { value: valueId(name), path: "bidder.sme" } : name === "추정가격" ? { value: valueId(name), key: columnOf(name), aliases: ["추정 가격"] } : { value: valueId(name), key: columnOf(name) },
  );

  const word = (id: string, path: number[], text: string) => {
    const p = [...doc.sections[0]!.paragraphs];
    let list = p;
    for (let i = 0; i < path.length - 1; i += 2) list = at(at(list, at(path, i)).subLists, at(path, i + 1)).paragraphs;
    const par = at(list, at(path, path.length - 1));
    const start = par.logicalText.indexOf(text);
    assert.ok(start >= 0, `${path.join(",")}에 '${text}'가 없다`);
    const a = makeWordAnchor(doc, id, 0, path, start, start + text.length);
    assert.ok(a !== undefined);
    return a;
  };
  const cell = (id: string, ordinal: number, row: number, col: number) => {
    const a = makeCellAnchor(doc, 0, ordinal, row, col);
    assert.ok(a !== undefined);
    return { id, ...a };
  };
  const anchors = [
    { ...range(doc, "a1", 18, 22), pattern: "pt1" },
    range(doc, "a2", 28, 31),
    range(doc, "a3", 38, 41),
    range(doc, "a4", 2, 4, [12, 1]),
    line(doc, "a5", [33]),
    word("a6", [0, 0, 0], "기관: "),
    word("a7", [44], "안내합니다."),
    word("a8", [19], "안내합니다."),
    word("a9", [12, 1, 5], "문단 5"),
    word("a10", [12, 1, 1], "문단 1"),
    line(doc, "a11", [42]),
    line(doc, "a12", [22]),
    cell("a13", 2, 4, 0),
    cell("a14", 0, 0, 2),
    { id: "a15", kind: "mergeField", key: "사유 설명", occurrence: 1 },
  ];
  const place = (id: string, body: Record<string, unknown>, value: string) => ({ id, ...body, value: valueId(value) });
  let n = 0;
  const pid = (): string => `p${++n}`;
  const places = [
    ...MERGE_KEYS.map((key) => place(pid(), { kind: "mailMerge", key }, key)),
    place(pid(), { kind: "mailMerge", key: "사유 설명", occurrence: 1 }, "사유 설명"),
    place(pid(), { kind: "mailMerge", key: "재공고", where: "b8" }, "재공고"),
    ...CLICK_NAMES.map((name) => place(pid(), { kind: "clickHere", name }, name)),
    place(pid(), { kind: "clickHere", name: "이름", occurrence: 1 }, "이름"),
    ...PLACEHOLDER_KEYS.map((key) => place(pid(), { kind: "placeholder", key, ...(key === "담당자 이름" ? { where: "b2" } : {}) }, key)),
    place(pid(), { kind: "word", anchor: "a6" }, "낱말 머리말"),
    place(pid(), { kind: "word", anchor: "a7" }, "낱말 범위 뒤"),
    place(pid(), { kind: "word", anchor: "a8" }, "낱말 범위 안"),
    place(pid(), { kind: "word", anchor: "a9" }, "낱말 칸 뒤"),
    place(pid(), { kind: "word", anchor: "a10" }, "낱말 칸 앞"),
    place(pid(), { kind: "line", anchor: "a11" }, "줄 범위 뒤"),
    place(pid(), { kind: "line", anchor: "a12" }, "줄 범위 안"),
    place(pid(), { kind: "cell", anchor: "a13" }, "칸 복사본"),
    place(pid(), { kind: "cell", anchor: "a14" }, "칸 첫 표"),
  ];
  const sme = valueId("중소기업");
  const price = valueId("추정가격");
  const raw: Record<string, unknown> = {
    schema: "hwpx-studio/template@2",
    id: "t5a5e0c31",
    version: 1,
    meta: { name: "합성 공고(시험)" },
    source: { kind: "hwpx", sha256: sha256Hex(bytes) },
    patterns: [{ id: "pt1", name: "본문 범위", marker: { form: "digitDot", level: 1 }, place: "body", match: ["marker"] }],
    anchors,
    values,
    bindings,
    places,
    slots: [
      { id: "s1", name: "참가자격", anchors: ["a1"], parent: null },
      { id: "s2", name: "계약 조건", anchors: ["a3", "a2"], parent: null },
      { id: "s3", name: "칸 내용", anchors: ["a4"], parent: null },
      { id: "s4", name: "끝 조항", anchors: ["a5"], parent: null },
    ],
    blocks: [
      { id: "b1", slot: "s1", name: "선택 조항", priority: 10, content: { fragment: fragB1 }, when: { path: price, op: "ge", value: 100000000 } },
      { id: "b1t", slot: "s1", name: "중소기업", priority: 5, content: { text: "{{사업명}} 참가자격: 중소기업 우대 & <확인>\n{{ 담당자 }}에게 문의" }, when: { path: sme, op: "eq", value: "Y" } },
      { id: "b2", slot: "s1", name: "일반", content: { text: "{{사업명}}에는 자격을 갖춘 업체가 참가할 수 있습니다.\n문의: {{담당자 이름}} ({{연락처}})" } },
      { id: "b3", slot: "s2", name: "표 조건", content: { fragment: fragB3 } },
      { id: "b4", slot: "s2", name: "글 조건", content: { text: "일반 계약 조건 \"인용\"\n{{기관명}} 기준\n셋째 줄" } },
      { id: "b5", slot: "s3", name: "칸 글", content: { text: "칸 교체 {{기관명}}\n칸 둘째 줄" }, when: { path: sme, op: "eq", value: "Y" } },
      { id: "b6", slot: "s3", name: "칸 비움", content: { text: "" } },
      { id: "b7", slot: "s4", name: "끝 글", content: { text: "끝 조항 {{사업명}}" } },
      { id: "b8", slot: "s4", name: "끝 필드", content: { fragment: fragB8 }, when: { path: price, op: "ge", value: 50000000 } },
    ],
    // unregistered 생략: 미등록 {{ }}는 막고 where·occurrence 시험용으로 일부러 남긴 누름틀·메일머지는 경고만(#134. "error"라고 적으면 필드도 막는다)
    options: { missing: "error" },
  };
  return { bytes, doc, blobs, raw, t: studioOf(raw, blobs), valueId, fragmentTexts };
}

/** 모든 값 이름에 값을 준 데이터 행(금액은 정수, 그 밖은 `text(name)`) */
export function recordFor(text: (name: string) => string, extra: { price?: number; sme?: string } = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const name of [...new Set([...MERGE_KEYS, ...PLACEHOLDER_KEYS, ...CLICK_NAMES, ...SPOT_NAMES, ...SPECIAL_NAMES])]) {
    row[columnOf(name)] = MONEY.has(name) ? (name === "추정가격" ? (extra.price ?? 1234) : 98765) : text(name);
  }
  row["bidder"] = { sme: extra.sme ?? "N" };
  return row;
}

/** 무작위 값(0~1,500자, 여러 문장·줄바꿈·탭·XML 특수문자) */
export const randomText = (next: () => number) => (_name: string): string => longValue(next, 0, 1500);

/** 블록 내용의 정규 사본(시험에서 blockEdits를 만들 때) */
export const textContent = (text: string): BlockContent => ({ text });
