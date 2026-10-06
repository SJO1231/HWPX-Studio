// 블록 단독 미리보기(#75)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글은 기록하지 않는다: 진단에는 경로 해시 앞 10자와 수량·코드만 남기고, 문서 글이 실패 메시지에 나오지 않도록 참·거짓으로만 비교한다. 결과 파일을 쓰지 않는다(모두 메모리).
//   HWPX_CORPUS_DIR=<폴더> node --test packages/viewer/test/block-preview-corpus.test.ts
// 블록은 블록 저장소 시험(검증 기준 28절)과 같은 것: 문서마다 최상위 제목 범위 가운데 뗄 수 있는 것 앞의 2곳을 extractBlock으로 뗀다.
// 여기에 문서마다 "본문 전체" 블록 하나(최상위 1번부터 뗄 수 있는 가장 긴 범위)를 더해 여러 쪽·많은 입력 항목도 본다(따로 센다).
// 블록마다 호스트 요청(previewBlock, 블록 id)으로 미리보기를 만들어 (1) 저장 게이트 통과·검사기 오류, (2) 블록 글 그대로, (3) 같은 이름 항목 수 = 원본에서 따로 센 수,
// (4) rhwp로 열고 모든 쪽을 그림·rhwp 문단 수 = 엔진 최상위 문단 수, (5) 자리 강조 구간이 rhwp가 그린 그 글을 덮는 비율, (6) 같은 입력 같은 바이트를 센다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { sameSnapshot, scanCorpus, snapshotOf } from "../../../tools/stress/corpus.ts";
import {
  detectHeadings,
  extractBlock,
  headingRangeOf,
  makeHeadingRangeAnchor,
  makeRangeAnchor,
  openPackage,
  parseDocument,
  validateDocument,
  walkParagraphs,
  type BlockRange,
  type ExtractedBlock,
  type HwpxDocument,
} from "../../hwpx-engine/src/index.ts";
import { hasSecPr } from "../../hwpx-engine/src/fill/doc.ts";
import { listAtParent, splitsField } from "../../hwpx-engine/src/fill/range.ts";
import { expectedCounts } from "../../hwpx-engine/test/preview-helpers.ts";
import { previewBlock, type StoredBlock } from "../src/host/preview.ts";
import type { MarkRange } from "../src/host/types.ts";
import { openDocument, rangeCover, type ViewerDocument } from "../src/rhwp/index.ts";
import { ensureRhwp } from "./helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;
const PER_DOC = 2;
const AT = "2026-10-06T00:00:00Z";

type Span = { sectionIndex: number; index?: number; from: number; to: number };

/** 블록 저장소 시험(28절)과 같은 고르기: 최상위 제목 범위 가운데 문단 1 이상, 구역 설정 없음, 누름틀 짝을 자르지 않음, 문단 40개 이하 */
function spans(d: HwpxDocument): Span[] {
  return detectHeadings(d).flatMap((h): Span[] => {
    if (h.at.parentPath.length > 0) return [];
    const r = headingRangeOf(d, h.at, h.index);
    const section = d.sections[h.at.sectionIndex];
    const list = section === undefined ? undefined : listAtParent(section, h.at.parentPath);
    if (r === undefined || list === undefined || r.from < 1 || r.to - r.from >= 40) return [];
    const ps = list.slice(r.from, r.to + 1);
    return ps.some(hasSecPr) || splitsField(ps) !== undefined ? [] : [{ sectionIndex: h.at.sectionIndex, index: h.index, from: r.from, to: r.to }];
  });
}

/** 본문 전체 블록: 구역 0 최상위 1번부터 뗄 수 있는(구역 설정 없음·누름틀 짝을 자르지 않음) 가장 긴 범위 */
function whole(d: HwpxDocument): Span | undefined {
  const list = d.sections[0]?.paragraphs ?? [];
  for (let to = list.length - 1; to >= 1; to--) {
    const ps = list.slice(1, to + 1);
    if (!ps.some(hasSecPr) && splitsField(ps) === undefined) return { sectionIndex: 0, from: 1, to };
  }
  return undefined;
}

function coverText(rdoc: ViewerDocument, mark: MarkRange): string {
  let text = "";
  for (let page = 0; page < rdoc.pageCount(); page++) text += rangeCover(rdoc.pageLayout(page), mark.position, mark.position.charOffset, mark.endOffset).text;
  return text;
}

type Tally = {
  blocks: number; rejected: number; previews: number; failed: number; blockParagraphs: number; pages: number; maxPages: number; rhwpParagraphs: number; engineParagraphs: number;
  errorsInPreview: number; inheritedWarnings: number; textSame: number; countsSame: number; places: number; fieldNames: number; sameNameItems: number;
  marks: number; guideMarks: number; covered: number; notCovered: number; unmarked: number; deterministic: number;
  kinds: Record<string, number>; warnings: Record<string, number>; failures: Record<string, number>;
};
const tally = (): Tally => ({
  blocks: 0, rejected: 0, previews: 0, failed: 0, blockParagraphs: 0, pages: 0, maxPages: 0, rhwpParagraphs: 0, engineParagraphs: 0,
  errorsInPreview: 0, inheritedWarnings: 0, textSame: 0, countsSame: 0, places: 0, fieldNames: 0, sameNameItems: 0,
  marks: 0, guideMarks: 0, covered: 0, notCovered: 0, unmarked: 0, deterministic: 0, kinds: {}, warnings: {}, failures: {},
});

/** 범위를 블록으로 떼어 호스트 요청으로 미리보기를 만들고 센다. 떼지 못하면 false */
function measure(doc: HwpxDocument, s: Span, draft: BlockRange, id: string, c: Tally): boolean {
  let block: ExtractedBlock;
  try {
    block = extractBlock(doc, draft, { id, name: `블록 ${id}`, at: AT });
  } catch {
    c.rejected++;
    return false;
  }
  c.blocks++;
  c.blockParagraphs += s.to - s.from + 1;
  const load = (want: string): StoredBlock | undefined => (want === id ? { proto: block.proto, blob: block.blob } : undefined);
  let res;
  try {
    res = previewBlock({ block: id }, load);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String(e.code) : "?";
    c.failures[code] = (c.failures[code] ?? 0) + 1;
    c.failed++;
    return true;
  }
  c.previews++;
  if (previewBlock({ block: id }, load).sha256 === res.sha256) c.deterministic++;
  const bytes = new Uint8Array(Buffer.from(res.hwpx, "base64"));
  const pdoc = parseDocument(openPackage(bytes));
  const top = pdoc.sections[0]!.paragraphs.length;
  c.engineParagraphs += top;
  c.errorsInPreview += validateDocument(bytes).errors.length;
  for (const w of res.warnings) {
    c.warnings[w.code] = (c.warnings[w.code] ?? 0) + 1;
    if (w.code === "GATE_INHERITED") c.inheritedWarnings++;
  }
  if (isDeepStrictEqual([...walkParagraphs(pdoc.sections[0]!.paragraphs.slice(1))].map((p) => p.logicalText), block.fragment.texts)) c.textSame++;
  const got = new Map(res.fields.map((x) => [`${x.kind}\t${x.name}`, x.count]));
  if (isDeepStrictEqual([...got].sort(), [...expectedCounts(doc, { sectionIndex: s.sectionIndex, parentPath: [], from: s.from, to: s.to })].sort())) c.countsSame++;
  c.places += res.places.length;
  c.fieldNames += res.fields.length;
  c.sameNameItems += res.fields.filter((x) => x.count >= 2).reduce((n, x) => n + x.count, 0);
  for (const x of res.fields) c.kinds[x.kind] = (c.kinds[x.kind] ?? 0) + x.count;
  const rdoc = openDocument(bytes);
  try {
    const pages = rdoc.pageCount();
    for (let p = 0; p < pages; p++) assert.ok(rdoc.pageSvg(p).startsWith("<svg"));
    c.pages += pages;
    c.maxPages = Math.max(c.maxPages, pages);
    c.rhwpParagraphs += rdoc.native.getParagraphCount(0);
    for (const place of res.places) {
      if (place.marks.length === 0) c.unmarked++;
      for (const mark of place.marks) {
        c.marks++;
        if (mark.guide !== undefined) c.guideMarks++;
        else if (mark.text !== undefined && coverText(rdoc, mark) === mark.text) c.covered++;
        else c.notCovered++;
      }
    }
  } finally {
    rdoc.free();
  }
  return true;
}

function expectClean(c: Tally, label: string): void {
  assert.equal(c.failed, 0, `${label}: 미리보기 실패`);
  assert.equal(c.previews, c.blocks);
  assert.equal(c.deterministic, c.previews, `${label}: 결정성`);
  assert.equal(c.textSame, c.previews, `${label}: 블록 글 그대로`);
  assert.equal(c.countsSame, c.previews, `${label}: 같은 이름 항목 수 = 원본에서 센 수`);
  assert.equal(c.rhwpParagraphs, c.engineParagraphs, `${label}: rhwp 문단 수 = 엔진 최상위 문단 수`);
  assert.equal(c.errorsInPreview, 0, `${label}: 미리보기 문서 검사 오류`);
}

test("#75 실제 공고서: 블록 저장소 시험과 같은 블록(과 본문 전체 블록)을 미리보기로 만들어 rhwp로 그린다. 게이트 통과, 블록 글 그대로, 같은 이름 항목 수, 결정성", { skip: SKIP }, async (t) => {
  assert.ok(typeof DIR === "string");
  await ensureRhwp();
  const before = snapshotOf(scanCorpus(DIR));
  const files = scanCorpus(DIR).filter((f) => f.size <= MAX_BYTES);
  const headings = tally();
  const wholes = tally();
  let docs = 0;
  let unreadable = 0;
  const rows: string[] = [];
  for (const f of files) {
    let doc: HwpxDocument;
    try {
      doc = parseDocument(openPackage(new Uint8Array(readFileSync(f.abs))));
    } catch {
      unreadable++;
      continue;
    }
    docs++;
    let made = 0;
    for (const s of spans(doc)) {
      if (made >= PER_DOC) break;
      const draft = makeHeadingRangeAnchor(doc, s.sectionIndex, [], s.index ?? -1);
      assert.ok(draft !== undefined);
      if (measure(doc, s, draft, `k${(docs * 16 + made).toString(16).padStart(8, "0")}`, headings)) made++;
    }
    const w = whole(doc);
    const draft = w === undefined ? undefined : makeRangeAnchor(doc, w.sectionIndex, [], w.from, w.to);
    if (w !== undefined && draft !== undefined) measure(doc, w, draft, `k${(docs * 16 + 15).toString(16).padStart(8, "0")}`, wholes);
    rows.push(`${f.id} 제목 블록 ${made}, 본문 전체 ${w === undefined ? 0 : w.to - w.from + 1}문단`);
  }
  const after = snapshotOf(scanCorpus(DIR));
  t.diagnostic(`문서 ${docs}건(읽을 수 없음 ${unreadable})`);
  t.diagnostic(`제목 블록: ${JSON.stringify(headings)}`);
  t.diagnostic(`본문 전체 블록: ${JSON.stringify(wholes)}`);
  t.diagnostic(rows.join(" | "));
  t.diagnostic(`문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(docs >= 10, `읽은 문서 ${docs}`);
  assert.ok(headings.blocks >= 30, `블록 ${headings.blocks}`);
  expectClean(headings, "제목 블록");
  expectClean(wholes, "본문 전체 블록");
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
});
