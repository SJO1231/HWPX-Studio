// 2판 템플릿 예시(examples/template-v2/)를 엔진 공개 API로 만든다. 값과 글은 전부 지어낸 것이다.
//
// 실행(저장소 루트에서):
//   node tools/examples/make-template-v2.ts            예시 파일 전부를 처음 모양으로 다시 쓴다(고친 파일도 덮어쓴다). 같은 입력이면 같은 바이트다.
//   node tools/examples/make-template-v2.ts --refresh  고친 notice.hwpx는 그대로 두고, template.json의 source.sha256과 두 슬롯 앵커만 다시 계산한다.
//                                                      제목은 detectHeadings로 다시 찾는다. 바뀐 것이 있으면 template.json의 version을 1 올린다.
//
// 바탕 문서는 엔진 시험 자료 hancom/blocks.hwpx(한컴이 저장한 합성 문서, 작성자 정보는 이미 synthetic)다. 쓰는 곳은 examples/template-v2/뿐이다.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  canonicalStudioJson,
  contentSha256,
  detectHeadings,
  extractFragment,
  generate,
  headingRangeOf,
  HwpxError,
  makeCellAnchor,
  makeHeadingRangeAnchor,
  makeRangeAnchor,
  makeWordAnchor,
  openPackage,
  parseDocument,
  readCase,
  readDataset,
  readStudioTemplate,
  serializeFragment,
  sha256Hex,
  templateSha256,
  type HwpxDocument,
  type Template,
} from "../../packages/hwpx-engine/src/index.ts";

const ROOT = new URL("../../", import.meta.url);
const OUT = new URL("examples/template-v2/", ROOT);
const BASE = new URL("packages/hwpx-engine/test/fixtures/hancom/blocks.hwpx", ROOT);

/** 슬롯 앵커를 다시 찾을 때 쓰는 제목 글(최상위 제목 가운데 이 글이 든 것이 하나여야 한다) */
const HEADING_OF = { qualification: "참가 자격", documents: "제출 서류" } as const;

// ── 문서 만들기 ────────────────────────────────────────────────

/**
 * 바탕 문서(최상위: [0] 제목 / [1..3] 문단 / [4] 3행 3열 표 / [5] 문단)를 고쳐 쓴다.
 * [0]의 글을 `title`로, [1..3]을 `head` 줄들로, 표 칸을 `cells`로, [5]를 `tail` 줄들로 바꾼다. 엔진의 1판 generate 한 번(누락은 keep)이다.
 */
function rewrite(base: Uint8Array, title: string, head: string[], cells: string[][], tail: string[]): Uint8Array {
  const doc = parse(base);
  const first = doc.sections[0]?.paragraphs[0]?.logicalText ?? "";
  const start = first.indexOf("1. 개요");
  const titleAnchor = start < 0 ? undefined : makeWordAnchor(doc, "title", 0, [0], start, first.length);
  const headRange = makeRangeAnchor(doc, 0, [], 1, 3);
  const tailRange = makeRangeAnchor(doc, 0, [], 5, 5);
  if (titleAnchor === undefined || headRange === undefined || tailRange === undefined) throw new Error("바탕 문서의 모양이 예상과 다릅니다.");
  const anchors: unknown[] = [titleAnchor, { id: "head", ...headRange }, { id: "tail", ...tailRange }];
  const rules: unknown[] = [
    { id: "title", do: { type: "fill", anchor: "title", value: { text: title } } },
    { id: "head", do: { type: "insertText", anchor: "head", position: "replace", value: { text: head.join("\n") }, style: "inherit" } },
    { id: "tail", do: { type: "insertText", anchor: "tail", position: "replace", value: { text: tail.join("\n") }, style: "inherit" } },
  ];
  cells.forEach((row, r) =>
    row.forEach((text, c) => {
      const cell = makeCellAnchor(doc, 0, 0, r, c);
      if (cell === undefined) throw new Error(`바탕 문서의 표에 칸 (${r}, ${c})이 없습니다.`);
      anchors.push({ id: `c${r}${c}`, ...cell });
      rules.push({ id: `c${r}${c}`, do: { type: "fill", anchor: `c${r}${c}`, value: { text } } });
    }),
  );
  const template = { schema: "hwpx-studio/template@1", anchors, rules, options: { missing: "keep" } } as Template;
  const result = generate(base, template, readDataset({}), { missing: "keep" });
  if (!result.ok || result.dryRun) throw new Error(`예시 문서를 만들지 못했습니다: ${result.report.issues.map((i) => i.code).join(", ")}`);
  return result.output;
}

/** 공고서(notice.hwpx): 번호 제목 7개(1.~5., 가.·나.), 제목 사이 본문, 표 하나, {{키}} 9곳(표 칸 3곳) */
function makeNotice(base: Uint8Array): Uint8Array {
  return rewrite(
    base,
    "{{사업명}} 입찰 공고",
    [
      "다음과 같이 입찰을 공고하오니 많은 참여 바랍니다.",
      "1. 사업 개요",
      "사업명은 {{사업명}}이며, 추정가격은 {{추정가격}}(부가가치세 포함)입니다.",
      "사업 기간은 계약일부터 6개월입니다.",
      "2. 입찰 일정",
      "접수 기간과 문의처는 아래 표와 같습니다.",
    ],
    [
      ["구분", "내용", "비고"],
      ["접수 기간", "{{접수기간}}", "전자 접수만 받음"],
      ["문의처", "{{담당자}}", "{{연락처}}"],
    ],
    [
      "3. 참가 자격",
      "가. 입찰 공고일 현재 관련 법령에 따라 업종을 등록한 업체",
      "나. 최근 3년 안에 비슷한 사업을 수행한 실적이 있는 업체",
      "4. 제출 서류",
      "입찰 참가 신청서 1부",
      "사업자등록증 사본 1부",
      "5. 기타 사항",
      "{{추가안내}}",
      "문의: {{담당자}}({{연락처}})",
    ],
  );
}

/** 조각 블록의 원본(다른 조항 모양: 제목·본문·표·본문). 이 문서는 저장하지 않고 [1..4]를 조각으로 뜬다. */
function makeFragmentBlob(base: Uint8Array): Uint8Array {
  const donor = rewrite(
    base,
    "조각 원본",
    ["3. 참가 자격(공동 수급)", "가. 추정가격이 10억 원 이상이므로 아래 표의 조건을 갖춘 업체끼리 공동으로 참가할 수 있습니다."],
    [
      ["구분", "조건", "확인 서류"],
      ["대표사", "지분 51% 이상", "공동 수급 협정서"],
      ["구성원", "지분 10% 이상", "사업자등록증 사본"],
    ],
    ["나. {{사업명}}의 참가 신청은 대표사가 합니다."],
  );
  return new TextEncoder().encode(serializeFragment(extractFragment(parse(donor), { sectionIndex: 0, parentPath: [], from: 1, to: 4 })));
}

// ── 템플릿·이번 건·데이터 ───────────────────────────────────────

/** 두 슬롯의 앵커: a1 = "참가 자격" 제목의 제목 범위, a2 = "제출 서류" 제목 아래 문단들의 범위(제목 제외) */
function slotAnchors(doc: HwpxDocument): { a1: Record<string, unknown>; a2: Record<string, unknown> } {
  const heads = detectHeadings(doc).filter((h) => h.at.sectionIndex === 0 && h.at.parentPath.length === 0);
  const find = (word: string): number => {
    const hits = heads.filter((h) => h.text.includes(word));
    if (hits.length !== 1) throw new Error(`'${word}'이(가) 든 최상위 제목이 ${hits.length}개입니다(1개여야 합니다). node apps/cli/src/main.ts headings로 제목을 확인하세요.`);
    return hits[0]?.index ?? -1;
  };
  const q = find(HEADING_OF.qualification);
  const a1 = makeHeadingRangeAnchor(doc, 0, [], q);
  const d = find(HEADING_OF.documents);
  const under = headingRangeOf(doc, { sectionIndex: 0, parentPath: [] }, d);
  if (under === undefined || under.to <= d) throw new Error(`'${HEADING_OF.documents}' 제목 아래에 문단이 없습니다.`);
  const a2 = makeRangeAnchor(doc, 0, [], d + 1, under.to);
  if (a1 === undefined || a2 === undefined) throw new Error("슬롯 앵커를 만들지 못했습니다.");
  return { a1: { id: "a1", ...a1 }, a2: { id: "a2", ...a2 } };
}

const TEMPLATE_ID = "t0e5a0001";
const AMOUNT = "v2";
const BLOCK_TEXT = {
  b1: [
    "3. 참가 자격",
    "가. 입찰 공고일 현재 관련 법령에 따라 업종을 등록한 업체",
    "나. 추정가격이 1억 원 이상이므로, 최근 3년 안에 한 건에 5천만 원 이상인 비슷한 사업을 수행한 실적이 있는 업체",
  ],
  b2: [
    "3. 참가 자격",
    "가. 입찰 공고일 현재 관련 법령에 따라 업종을 등록한 업체",
    "나. 추정가격이 1억 원 미만이므로 실적 제한 없이 {{사업명}}에 참가할 수 있습니다.",
  ],
  b4: ["입찰 참가 신청서 1부", "사업자등록증 사본 1부", "법인 인감증명서 1부"],
  b5: ["입찰 참가 신청서 1부", "공동 수급 협정서 1부", "구성원별 사업자등록증 사본 각 1부"],
};

function makeTemplate(noticeSha: string, anchors: { a1: Record<string, unknown>; a2: Record<string, unknown> }, fragmentSha: string): Record<string, unknown> {
  return {
    schema: "hwpx-studio/template@2",
    id: TEMPLATE_ID,
    version: 1,
    meta: { name: "입찰 공고 예시" },
    source: { kind: "hwpx", sha256: noticeSha },
    anchors: [anchors.a1, anchors.a2],
    values: [
      { id: "v1", name: "사업명", format: "text" },
      { id: AMOUNT, name: "추정가격", format: "money" },
      { id: "v3", name: "접수기간", format: "text" },
      { id: "v4", name: "담당자", format: "text" },
      { id: "v5", name: "연락처", format: "text" },
      { id: "v6", name: "추가안내", format: "text" },
    ],
    bindings: [
      { value: "v1", key: "사업명" },
      { value: AMOUNT, key: "추정 가격(원)", aliases: ["추정가격"] },
      { value: "v3", key: "접수 기간" },
      { value: "v4", key: "담당자" },
      { value: "v5", key: "연락처" },
      { value: "v6", key: "추가 안내" },
    ],
    places: [
      { id: "p1", kind: "placeholder", key: "사업명", value: "v1" },
      { id: "p2", kind: "placeholder", key: "추정가격", value: AMOUNT },
      { id: "p3", kind: "placeholder", key: "접수기간", value: "v3" },
      { id: "p4", kind: "placeholder", key: "담당자", value: "v4" },
      { id: "p5", kind: "placeholder", key: "연락처", value: "v5" },
      { id: "p6", kind: "placeholder", key: "추가안내", value: "v6" },
    ],
    slots: [
      { id: "s1", name: "참가 자격", anchors: ["a1"], parent: null },
      { id: "s2", name: "제출 서류", anchors: ["a2"], parent: null },
    ],
    blocks: [
      { id: "b1", slot: "s1", name: "1억 원 이상", content: { text: BLOCK_TEXT.b1.join("\n") }, when: { path: AMOUNT, op: "ge", value: 100000000 } },
      { id: "b2", slot: "s1", name: "1억 원 미만(조건 없음)", content: { text: BLOCK_TEXT.b2.join("\n") } },
      { id: "b3", slot: "s1", name: "10억 원 이상 공동 수급(표가 든 조각)", content: { fragment: fragmentSha }, when: { path: AMOUNT, op: "ge", value: 1000000000 }, priority: 10 },
      { id: "b4", slot: "s2", name: "기본 서류", content: { text: BLOCK_TEXT.b4.join("\n") } },
      { id: "b5", slot: "s2", name: "공동 수급 서류", content: { text: BLOCK_TEXT.b5.join("\n") } },
    ],
    options: { missing: "error", unregistered: "error" },
  };
}

const DATA = {
  사업명: "가나다 사업",
  "추정 가격(원)": 150000000,
  "접수 기간": "2026. 11. 2.(월) 10:00 ~ 11. 6.(금) 18:00",
  담당자: "홍길동",
  연락처: "02-0000-0000",
  "추가 안내":
    "입찰 참가 신청서는 전자 조달 시스템으로만 받으며, 우편이나 방문 접수는 받지 않습니다. 마감 시각이 지나 도착한 서류는 받지 않습니다.\n" +
    "제출한 서류는 돌려 드리지 않으며, 서류에 거짓으로 적은 사실이 밝혀지면 낙찰을 취소할 수 있습니다.\n" +
    "그 밖에 이 공고에 적지 않은 사항은 관련 규정과 계약 일반 조건을 따르고, 궁금한 점은 아래 문의처로 물어보시기 바랍니다.",
};

function makeCase(templateJson: string, blobs: Set<string>): Record<string, unknown> {
  const t = readTemplateChecked(templateJson, blobs);
  const b4 = t.blocks.find((b) => b.id === "b4");
  if (b4 === undefined) throw new Error("블록 b4가 없습니다.");
  return {
    schema: "hwpx-studio/case@1",
    template: { id: t.id, version: t.version, sha256: templateSha256(t) },
    record: { dataset: "d0e5a0001", version: 1, row: 0, sha256: sha256Hex(canonicalStudioJson(DATA)) },
    selections: { s2: { block: "b4", basis: "manual", content: contentSha256(b4.content) } },
    valueEdits: { v3: "2026. 11. 2.(월) 10:00 ~ 11. 9.(월) 18:00 (기간 연장)" },
    blockEdits: {},
  };
}

// ── 도우미 ────────────────────────────────────────────────────

function parse(bytes: Uint8Array): HwpxDocument {
  return parseDocument(openPackage(bytes));
}

function readTemplateChecked(json: string, blobs: Set<string>) {
  const t = readStudioTemplate(json, { hasBlob: (sha) => blobs.has(sha) });
  if (t.schema !== "hwpx-studio/template@2") throw new Error("2판 템플릿이 아닙니다.");
  return t;
}

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const file = (name: string): URL => new URL(name, OUT);

function write(name: string, bytes: Uint8Array | string): void {
  writeFileSync(file(name), bytes);
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  console.log(`${name}  ${b.length}바이트  sha256 ${sha256Hex(b).slice(0, 10)}`);
}

/** 템플릿 블록이 가리키는 조각 해시 가운데 blobs 폴더에 파일이 있는 것 */
function blobsOn(raw: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const b of (raw["blocks"] as { content?: { fragment?: string } }[] | undefined) ?? []) {
    const sha = b.content?.fragment;
    if (sha === undefined) continue;
    try {
      if (sha256Hex(new Uint8Array(readFileSync(file(`blobs/${sha}.json`)))) === sha) out.add(sha);
    } catch {
      // 없는 덩어리는 아래 읽기 검사가 TPL_FRAGMENT_MISSING으로 알린다
    }
  }
  return out;
}

// ── 실행 ──────────────────────────────────────────────────────

function build(): void {
  const base = new Uint8Array(readFileSync(BASE));
  const notice = makeNotice(base);
  const blob = makeFragmentBlob(base);
  const fragmentSha = sha256Hex(blob);
  const raw = makeTemplate(sha256Hex(notice), slotAnchors(parse(notice)), fragmentSha);
  const templateJson = pretty(raw);
  const blobs = new Set([fragmentSha]);
  const caseJson = pretty(makeCase(templateJson, blobs));
  readCase(caseJson, readTemplateChecked(templateJson, blobs));
  mkdirSync(file("blobs/"), { recursive: true });
  write("notice.hwpx", notice);
  write(`blobs/${fragmentSha}.json`, blob);
  write("template.json", templateJson);
  write("case.json", caseJson);
  write("data.json", pretty(DATA));
}

function refresh(): void {
  const bytes = new Uint8Array(readFileSync(file("notice.hwpx")));
  let doc: HwpxDocument;
  try {
    doc = parse(bytes);
  } catch (e) {
    throw new Error(`notice.hwpx를 열 수 없습니다(${e instanceof Error ? e.message : String(e)}). 한컴에서 .hwpx로 다시 저장하세요.`);
  }
  const before = readFileSync(file("template.json"), "utf8");
  const raw = JSON.parse(before) as Record<string, unknown>;
  const anchors = slotAnchors(doc);
  const old = (raw["anchors"] as Record<string, unknown>[] | undefined) ?? [];
  for (const id of ["a1", "a2"]) if (!old.some((a) => a["id"] === id)) throw new Error(`template.json에 앵커 ${id}가 없습니다.`);
  const next: Record<string, unknown> = {
    ...raw,
    source: { ...(raw["source"] as Record<string, unknown>), sha256: sha256Hex(bytes) },
    anchors: old.map((a) => (a["id"] === "a1" ? anchors.a1 : a["id"] === "a2" ? anchors.a2 : a)),
  };
  if (canonicalStudioJson(next) === canonicalStudioJson(raw)) {
    console.log("바뀐 것이 없습니다(template.json을 그대로 두었습니다).");
    return;
  }
  next["version"] = Number(raw["version"]) + 1;
  const json = pretty(next);
  readTemplateChecked(json, blobsOn(next));
  write("template.json", json);
  const at = (a: Record<string, unknown>): string => (a["kind"] === "headingRange" ? `제목 문단 ${String(a["index"])}` : `문단 ${String(a["from"])}~${String(a["to"])}`);
  console.log(`원본 해시 ${String((raw["source"] as Record<string, unknown>)["sha256"]).slice(0, 10)} → ${sha256Hex(bytes).slice(0, 10)}, 판 ${String(raw["version"])} → ${String(next["version"])}`);
  console.log(`a1(${HEADING_OF.qualification}): ${at(anchors.a1)}, a2(${HEADING_OF.documents}): ${at(anchors.a2)}`);
}

const args = process.argv.slice(2);
if (args.some((a) => a !== "--refresh")) {
  console.error("사용법: node tools/examples/make-template-v2.ts [--refresh]");
  process.exit(2);
}
try {
  if (args.includes("--refresh")) refresh();
  else build();
} catch (e) {
  console.error(e instanceof HwpxError ? `${e.code}: ${e.message}${e.where === undefined ? "" : ` (${e.where})`}` : e instanceof Error ? e.message : String(e));
  process.exit(1);
}
