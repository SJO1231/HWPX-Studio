// 블록 단독 미리보기 요청(#75, 뷰어 명세 4절 "블록 단독 미리보기"): 호스트 `previewBlock`의 입력 검사·거절 코드, 엔진과 같은 바이트, 자리 강조 구간이
// rhwp가 그린 쪽의 그 글을 덮는지, 그리고 합성 블록 무작위 50개를 rhwp로 그려 쪽 수·문단 수를 센다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, test } from "node:test";
import { listFields, openPackage, parseDocument, type HwpxDocument } from "../../hwpx-engine/src/index.ts";
import { buildBlockPreviewDocument, extractBlock, generateFromTemplate, makeRangeAnchor, type ExtractedBlock } from "../../hwpx-engine/src/fill/index.ts";
import { hasSecPr, paragraphAtPath } from "../../hwpx-engine/src/fill/doc.ts";
import { listAtParent, splitsField } from "../../hwpx-engine/src/fill/range.ts";
import { sha256Hex, writeBlockProto } from "../../hwpx-engine/src/template/index.ts";
import { caseOf, loaderOf, manual, noticeKit, randomText, recordFor } from "../../hwpx-engine/test/generate-v2-helpers.ts";
import { notice, rng } from "../../hwpx-engine/test/range-helpers.ts";
import { HostError } from "../src/host/errors.ts";
import { PREVIEW_MAX_BLOB, previewBlock, type StoredBlock } from "../src/host/preview.ts";
import type { BlockPreviewResponse, MarkRange } from "../src/host/types.ts";
import { guideRect, openDocument, rangeCover, type ViewerDocument } from "../src/rhwp/index.ts";
import { ensureRhwp, parse, readFixture } from "./helpers.ts";

before(ensureRhwp);

const AT = "2026-10-06T00:00:00Z";
type Range = { parentPath: number[]; from: number; to: number };

function blockOf(doc: HwpxDocument, r: Range, id = "k0000c001"): ExtractedBlock {
  const anchor = makeRangeAnchor(doc, 0, r.parentPath, r.from, r.to);
  assert.ok(anchor !== undefined);
  return extractBlock(doc, anchor, { id, name: "미리보기", at: AT });
}

const extractable = (doc: HwpxDocument, r: Range): boolean => {
  const ps = listAtParent(doc.sections[0]!, r.parentPath)?.slice(r.from, r.to + 1) ?? [];
  return ps.length === r.to - r.from + 1 && !ps.some(hasSecPr) && splitsField(ps) === undefined;
};

const store = (blocks: ExtractedBlock[]): ((id: string) => StoredBlock | undefined) => {
  const byId = new Map(blocks.map((b) => [b.proto.id, { proto: b.proto, blob: b.blob }]));
  return (id) => byId.get(id);
};
const none = (): undefined => undefined;

const hostFailure = (f: () => unknown): HostError => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof HostError, `HostError가 아니다: ${String(e)}`);
    return e;
  }
  assert.fail("던지지 않았다");
};
const status = (f: () => unknown): [number, string] => {
  const e = hostFailure(f);
  return [e.status, e.code];
};

const bytesOf = (r: BlockPreviewResponse): Uint8Array => new Uint8Array(Buffer.from(r.hwpx, "base64"));

/** 쪽마다 그 강조 구간이 덮는 글을 이어 붙인다(구간이 쪽을 넘어가도 된다) */
function coverText(rdoc: ViewerDocument, mark: MarkRange): string {
  let text = "";
  for (let page = 0; page < rdoc.pageCount(); page++) text += rangeCover(rdoc.pageLayout(page), mark.position, mark.position.charOffset, mark.endOffset).text;
  return text;
}

/** 안내문 강조: 어느 쪽에 그 자리의 안내문 사각형이 있는가 */
const guideDrawn = (rdoc: ViewerDocument, mark: MarkRange): boolean =>
  Array.from({ length: rdoc.pageCount() }, (_, page) => page).some((page) => guideRect(rdoc.pageLayout(page), mark.position, mark.position.charOffset, mark.guide ?? "") !== undefined);

// ── 1. 요청과 거절 ────────────────────────────────────────────

test("#75 미리보기 요청: 블록 id·원형+덩어리 두 방식 모두 엔진과 같은 바이트, sha256, 같은 이름 항목 수, 경고만", () => {
  const src = parse(notice());
  const block = blockOf(src, { parentPath: [], from: 1, to: 16 });
  const engine = buildBlockPreviewDocument(block.proto, block.blob);
  const byId = previewBlock({ block: block.proto.id }, store([block]));
  const inline = previewBlock({ proto: JSON.parse(writeBlockProto(block.proto)), blob: Buffer.from(block.blob).toString("base64") }, none);
  assert.deepEqual(bytesOf(byId), engine.bytes);
  assert.deepEqual(bytesOf(inline), engine.bytes);
  assert.equal(byId.sha256, createHash("sha256").update(engine.bytes).digest("hex"));
  assert.deepEqual(byId.fields, engine.fields);
  assert.deepEqual(byId.places.map(({ marks: _m, ...p }) => p), engine.places);
  assert.deepEqual(byId.warnings, engine.issues.filter((i) => i.severity === "warning").map((i) => ({ code: i.code, message: i.message })));
  assert.deepEqual(previewBlock({ block: block.proto.id }, store([block])), byId, "다시 불러도 같다");
});

test("#75 미리보기 거절: 본문 400 BAD_REQUEST·BAD_BLOB, 없는 블록 404, 상한 초과 413(풀기 전), 원형 400 TPL_*, 덩어리·게이트 422", () => {
  const src = parse(readFixture("hancom/blocks"));
  const block = blockOf(src, { parentPath: [], from: 1, to: 3 });
  const blob64 = Buffer.from(block.blob).toString("base64");
  const proto = JSON.parse(writeBlockProto(block.proto)) as Record<string, unknown>;
  assert.deepEqual(status(() => previewBlock(null, none)), [400, "BAD_REQUEST"]);
  assert.deepEqual(status(() => previewBlock([], none)), [400, "BAD_REQUEST"]);
  assert.deepEqual(status(() => previewBlock({}, none)), [400, "BAD_REQUEST"]);
  assert.deepEqual(status(() => previewBlock({ block: 3 }, none)), [400, "BAD_REQUEST"]);
  assert.deepEqual(status(() => previewBlock({ block: "" }, none)), [400, "BAD_REQUEST"]);
  assert.deepEqual(status(() => previewBlock({ block: block.proto.id, blob: blob64 }, store([block]))), [400, "BAD_REQUEST"]);
  assert.deepEqual(status(() => previewBlock({ proto, blob: 7 }, none)), [400, "BAD_REQUEST"]);
  assert.deepEqual(status(() => previewBlock({ proto: "문자열", blob: blob64 }, none)), [400, "BAD_REQUEST"]);
  assert.deepEqual(status(() => previewBlock({ proto, blob: "@@@@" }, none)), [400, "BAD_BLOB"]);
  assert.deepEqual(status(() => previewBlock({ proto, blob: blob64.slice(1) }, none)), [400, "BAD_BLOB"]);
  assert.deepEqual(status(() => previewBlock({ block: "k0000ffff" }, store([block]))), [404, "BLOCK_NOT_FOUND"]);
  // 상한: 저장소 덩어리는 길이로, 본문 덩어리는 base64를 풀기 전에 길이로 거절한다
  assert.deepEqual(status(() => previewBlock({ block: "big" }, () => ({ proto: block.proto, blob: new Uint8Array(PREVIEW_MAX_BLOB + 1) }))), [413, "BLOCK_TOO_LARGE"]);
  assert.deepEqual(status(() => previewBlock({ proto, blob: "A".repeat((PREVIEW_MAX_BLOB / 3 + 1) * 4) }, none)), [413, "BLOCK_TOO_LARGE"]);
  // 원형 읽기 거절(엔진 코드 그대로)
  assert.deepEqual(status(() => previewBlock({ proto: { ...proto, version: 0 }, blob: blob64 }, none)), [400, "TPL_FIELD"]);
  assert.deepEqual(status(() => previewBlock({ proto: { ...proto, extra: 1 }, blob: blob64 }, none)), [400, "TPL_FIELD"]);
  // 미리보기를 만들 수 없음(엔진 코드 그대로)
  const other = Buffer.from(blockOf(src, { parentPath: [], from: 1, to: 2 }).blob).toString("base64");
  assert.deepEqual(status(() => previewBlock({ proto, blob: other }, none)), [422, "TPL_FRAGMENT_MISSING"]);
  const json = JSON.parse(new TextDecoder().decode(block.blob)) as { xml: string };
  json.xml += '<hp:p id="0" paraPrIDRef="777" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"/></hp:p>';
  const broken = new TextEncoder().encode(JSON.stringify(json));
  const brokenProto = { ...block.proto, content: { fragment: sha256Hex(broken) } };
  assert.deepEqual(status(() => previewBlock({ block: "x" }, () => ({ proto: brokenProto, blob: broken }))), [422, "GATE_NEW_ERRORS"]);
});

// ── 2. 강조 구간 ──────────────────────────────────────────────

test("#75 자리 강조: {{}}·메일머지 값은 rhwp가 그린 그 글을 덮고, 안내문 상태 누름틀은 안내문을, 여러 문단 누름틀은 문단마다 구간을 낸다", () => {
  const cases: [string, Range][] = [
    ["", { parentPath: [], from: 1, to: 16 }],
    ["", { parentPath: [12, 1], from: 0, to: 5 }],
    ["hancom/field-states", { parentPath: [], from: 1, to: 2 }],
    ["span/field-span", { parentPath: [], from: 1, to: 4 }],
    ["tables/tables-rich", { parentPath: [], from: 1, to: 2 }],
  ];
  const tally = { places: 0, covered: 0, guides: 0, multi: 0 };
  for (const [name, r] of cases) {
    const src = parse(name === "" ? notice() : readFixture(name));
    const block = blockOf(src, r);
    const res = previewBlock({ block: block.proto.id }, store([block]));
    const bytes = bytesOf(res);
    const doc = parseDocument(openPackage(bytes));
    const guides = new Set(listFields(doc).filter((f) => f.dirty === "0" && f.type === "CLICK_HERE").map((f) => `${f.path.join()}|${f.valueText}`));
    const rdoc = openDocument(bytes);
    try {
      for (const place of res.places) {
        tally.places++;
        assert.ok(place.marks.length >= 1, `${name} ${place.kind} ${place.path.join(",")}: 강조 구간 없음`);
        if (place.endPath !== undefined) {
          tally.multi++;
          assert.equal(place.marks.length, (place.endPath.at(-1) ?? 0) - (place.path.at(-1) ?? 0) + 1, "여러 문단 누름틀은 문단마다");
          continue;
        }
        const mark = place.marks[0]!;
        if (mark.guide !== undefined) {
          tally.guides++;
          assert.ok(guides.has(`${place.path.join()}|${mark.guide}`), "안내문 글 = 그 누름틀의 값 글");
          assert.ok(guideDrawn(rdoc, mark), "rhwp가 그 자리에 안내문을 그렸다");
          continue;
        }
        assert.equal(mark.text, paragraphAtPath(doc.sections[0]!, place.path)?.logicalText.slice(place.start, place.end), "강조 글 = 자리 글");
        assert.equal(coverText(rdoc, mark), mark.text, `${name} ${place.kind} ${place.name}: rhwp가 그린 글`);
        tally.covered++;
      }
    } finally {
      rdoc.free();
    }
  }
  console.log(`# 강조 ${JSON.stringify(tally)}`);
  assert.ok(tally.guides >= 2 && tally.multi >= 1 && tally.covered >= 35, JSON.stringify(tally));
});

test("#75 긴 값이 든 블록(2판 생성으로 0~1,500자 값을 채운 합성 공고서의 본문 전체): rhwp가 여러 쪽으로 그리고, 값 강조 구간이 그린 글을 덮는다", () => {
  const k = noticeKit();
  const tally = { previews: 0, pages: 0, places: 0, marks: 0, covered: 0, notCovered: 0, onePage: 0, longest: 0 };
  for (const seed of [7511, 7512, 7513]) {
    const record = recordFor(randomText(rng(seed)));
    const c = caseOf(k.t, record, { selections: { s1: manual(k.t, "s1", "b1"), s2: manual(k.t, "s2", "b3") } });
    const r = generateFromTemplate(k.bytes, k.t, record, c, loaderOf(k.blobs));
    assert.ok(r.ok && !r.dryRun && r.output instanceof Uint8Array);
    const filled = parse(r.output);
    const range = { parentPath: [], from: 1, to: filled.sections[0]!.paragraphs.length - 1 };
    assert.ok(extractable(filled, range));
    const block = blockOf(filled, range);
    const res = previewBlock({ block: block.proto.id }, store([block]));
    const rdoc = openDocument(bytesOf(res));
    try {
      tally.previews++;
      tally.pages += rdoc.pageCount();
      assert.equal(rdoc.native.getParagraphCount(0), 1 + range.to - range.from + 1);
      for (const place of res.places) {
        tally.places++;
        tally.longest = Math.max(tally.longest, place.end - place.start);
        assert.ok(place.marks.length >= 1);
        for (const mark of place.marks) {
          tally.marks++;
          if (mark.guide !== undefined) continue; // 채우지 않은 안내문 상태 누름틀(순번 고정 자리 밖)
          assert.ok(mark.text !== undefined && !mark.text.includes("\n"), "값 강조는 줄바꿈에서 나뉜다");
          if (coverText(rdoc, mark) === mark.text) tally.covered++;
          else tally.notCovered++;
          // 화면(page-view)은 쪽마다 견준다: 한 쪽 안에 다 그려진 구간
          if (Array.from({ length: rdoc.pageCount() }, (_, page) => rangeCover(rdoc.pageLayout(page), mark.position, mark.position.charOffset, mark.endOffset).text).includes(mark.text)) tally.onePage++;
        }
      }
    } finally {
      rdoc.free();
    }
  }
  console.log(`# 긴 값 렌더 ${JSON.stringify(tally)}`);
  assert.ok(tally.pages > tally.previews && tally.longest >= 1000 && tally.places >= 100, JSON.stringify(tally));
  assert.equal(tally.notCovered, 0, "강조 글 = rhwp가 그린 글");
});

// ── 3. 무작위 50개를 rhwp로 그리기 ─────────────────────────────

test("#75 합성 블록 무작위 50개(합성 공고서 본문·칸, 한컴 저장본): rhwp로 열고 모든 쪽을 그린다, rhwp 문단 수 = 엔진 최상위 문단 수, 결정성", () => {
  const sources = [parse(notice()), parse(readFixture("merge/merge-fields")), parse(readFixture("tables/tables-rich")), parse(readFixture("hancom/picture")), parse(readFixture("D1")), parse(readFixture("D5"))];
  const next = rng(7576);
  const tally = { blocks: 0, pages: 0, maxPages: 0, rhwpParagraphs: 0, engineParagraphs: 0, places: 0, marks: 0 };
  let tries = 0;
  while (tally.blocks < 50) {
    assert.ok(tries++ < 500);
    const src = next() < 0.5 ? sources[0]! : sources[1 + Math.floor(next() * (sources.length - 1))]!;
    const inCell = src === sources[0] && next() < 0.4;
    const parentPath = inCell ? [12, 1] : [];
    const list = listAtParent(src.sections[0]!, parentPath)!;
    const lo = inCell ? 0 : 1;
    if (list.length <= lo) continue;
    const from = lo + Math.floor(next() * (list.length - lo));
    const r = { parentPath, from, to: Math.min(list.length - 1, from + Math.floor(next() * 60)) };
    if (!extractable(src, r)) continue;
    const block = blockOf(src, r, `k${(0xc100 + tally.blocks).toString(16).padStart(8, "0")}`);
    const res = previewBlock({ block: block.proto.id }, store([block]));
    assert.equal(previewBlock({ block: block.proto.id }, store([block])).sha256, res.sha256, "결정성");
    const bytes = bytesOf(res);
    const top = parseDocument(openPackage(bytes)).sections[0]!.paragraphs.length;
    assert.equal(top, 1 + r.to - r.from + 1);
    const rdoc = openDocument(bytes);
    try {
      const pages = rdoc.pageCount();
      assert.ok(pages >= 1);
      for (let p = 0; p < pages; p++) assert.ok(rdoc.pageSvg(p).startsWith("<svg"), "쪽 SVG");
      assert.equal(rdoc.native.getParagraphCount(0), top, "rhwp 문단 수 = 엔진 최상위 문단 수");
      tally.pages += pages;
      tally.maxPages = Math.max(tally.maxPages, pages);
      tally.rhwpParagraphs += rdoc.native.getParagraphCount(0);
    } finally {
      rdoc.free();
    }
    tally.engineParagraphs += top;
    tally.places += res.places.length;
    tally.marks += res.places.reduce((n, p) => n + p.marks.length, 0);
    tally.blocks++;
  }
  console.log(`# 무작위 렌더 ${JSON.stringify(tally)}`);
  assert.equal(tally.rhwpParagraphs, tally.engineParagraphs);
});
