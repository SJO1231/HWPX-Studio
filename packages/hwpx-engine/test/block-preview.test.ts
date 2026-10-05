// 블록 단독 미리보기(엔진 명세 8.8.18, 이슈 #75): 빈 바탕 문서(형식 1.5)에 블록 조각을 넣은 완전한 HWPX 바이트, 저장 게이트, 입력 항목 자리 주소와 같은 이름 항목 수.
// 기대값은 원본 문서에서 따로 센다: 누름틀·메일머지는 원본 `listFields`의 범위 안 필드, `{{ 키 }}`는 범위 안 문단 글의 표기 수에서 필드 값 글 안의 표기 수를 뺀 것.
// 쪽 수·rhwp 문단 수와 호스트 요청은 뷰어 시험(`packages/viewer/test/block-preview.test.ts`)이 본다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  listFields,
  openPackage,
  parseDocument,
  readEntry,
  rewriteArchive,
  serializeFragment,
  validateDocument,
  walkParagraphs,
  type HwpxDocument,
  type ParagraphNode,
} from "../src/index.ts";
import { buildBlockPreviewDocument, extractBlock, generateFromTemplate, makeRangeAnchor, PREVIEW_XML_VERSION, type BlockPreview, type ExtractedBlock } from "../src/fill/index.ts";
import { hasSecPr, paragraphAtPath } from "../src/fill/doc.ts";
import { listAtParent, splitsField } from "../src/fill/range.ts";
import { readBlockProto, sha256Hex, writeBlockProto, type BlockProto } from "../src/template/index.ts";
import { buildHwpx, bytesEqual, MINIMAL_HEADER, readFixture, reparse } from "./helpers.ts";
import { caseOf, loaderOf, manual, noticeKit, randomText, recordFor } from "./generate-v2-helpers.ts";
import { expectedCounts, kindOf } from "./preview-helpers.ts";
import { notice, rng } from "./range-helpers.ts";

const AT = "2026-10-06T00:00:00Z";
const utf8 = new TextDecoder();

type Range = { sectionIndex: number; parentPath: number[]; from: number; to: number };

function blockOf(doc: HwpxDocument, r: Range, id = "k0000a001"): ExtractedBlock {
  const anchor = makeRangeAnchor(doc, r.sectionIndex, r.parentPath, r.from, r.to);
  assert.ok(anchor !== undefined, `범위 앵커 ${JSON.stringify(r)}`);
  return extractBlock(doc, anchor, { id, name: "미리보기 시험", at: AT });
}

/** 범위가 블록으로 뗄 수 있는가: 구역 설정 없음, 누름틀 짝을 자르지 않음 */
function extractable(doc: HwpxDocument, r: Range): boolean {
  const list = listAtParent(doc.sections[r.sectionIndex]!, r.parentPath);
  const ps = list?.slice(r.from, r.to + 1) ?? [];
  return ps.length === r.to - r.from + 1 && !ps.some(hasSecPr) && splitsField(ps) === undefined;
}

const countsOf = (p: BlockPreview): Map<string, number> => new Map(p.fields.map((f) => [`${f.kind}\t${f.name}`, f.count]));

/** 미리보기 계약: 바탕 문서 + 블록, 검사 오류 0, 블록 글 그대로, 자리 주소가 그 글을 가리킴, 같은 이름 수 = 원본에서 센 수 */
function checkPreview(src: HwpxDocument, r: Range, block: ExtractedBlock, p: BlockPreview): HwpxDocument {
  const doc = reparse(p.bytes);
  const v = validateDocument(p.bytes);
  assert.deepEqual(v.errors.map((e) => e.code), [], "미리보기 문서 검사 오류 0");
  const sec = doc.sections[0]!;
  const n = r.to - r.from + 1;
  assert.equal(doc.sections.length, 1);
  assert.equal(sec.paragraphs.length, 1 + n, "바탕 문단 1 + 블록 최상위 문단");
  assert.ok(hasSecPr(sec.paragraphs[0]!) && /^\uFFFC*$/.test(sec.paragraphs[0]!.logicalText), "첫 문단은 구역 설정·단 설정만 담은 문단(글 없음)");
  assert.deepEqual([...walkParagraphs(sec.paragraphs.slice(1))].map((x) => x.logicalText), block.fragment.texts, "블록 글 그대로");
  assert.equal(attrOfVersion(p.bytes), PREVIEW_XML_VERSION);
  // 같은 이름 항목 수
  const want = expectedCounts(src, r);
  assert.deepEqual([...countsOf(p)].sort(), [...want].sort(), "같은 이름 항목 수 = 원본에서 센 수");
  assert.equal(p.places.length, p.fields.reduce((s, f) => s + f.count, 0));
  // 자리 주소: 문서 순서이고, 그 글을 가리킨다
  const fields = listFields(doc).filter((f) => kindOf(f) !== undefined);
  let fi = 0;
  for (const place of p.places) {
    const para = paragraphAtPath(sec, place.path) as ParagraphNode;
    assert.ok(para !== undefined && place.path[0]! >= 1, `자리 문단 ${place.path.join(",")}`);
    if (place.kind === "placeholder") {
      const shown = para.logicalText.slice(place.start, place.end);
      assert.match(shown, /^\{\{.*\}\}$/s);
      assert.equal(shown.slice(2, -2).trim().normalize("NFC"), place.name);
      continue;
    }
    // 필드 자리는 listFields 순서와 같다(같은 문단 안에서는 시작 위치 순)
    const f = fields.find((x, i) => i >= fi && x.path.join() === place.path.join() && kindOf(x) === place.kind && (place.kind === "clickHere" ? x.name : x.mergeKey) === place.name);
    assert.ok(f !== undefined, `필드 자리 ${place.kind} ${place.path.join(",")}`);
    if (f.shape === "crossParagraph") {
      assert.deepEqual(place.endPath, f.endPath);
      const end = paragraphAtPath(sec, place.endPath!)!;
      assert.ok(place.start <= para.logicalText.length && place.end <= end.logicalText.length, "여러 문단 필드 구간");
    } else {
      assert.equal(place.endPath, undefined);
      assert.equal(para.logicalText.slice(place.start, place.end), f.valueText, "필드 값 구간");
    }
  }
  const sorted = [...p.places].sort((a, b) => cmpPath(a.path, b.path) || a.start - b.start);
  assert.deepEqual(p.places, sorted, "문서 순서");
  return doc;
}

function cmpPath(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return a.length - b.length;
}

function attrOfVersion(bytes: Uint8Array): string | undefined {
  const pkg = openPackage(bytes);
  return /xmlVersion="([^"]*)"/.exec(utf8.decode(readEntry(pkg.archive, bytes, "version.xml")))?.[1];
}

const failure = (f: () => unknown): HwpxError => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아니다: ${String(e)}`);
    return e;
  }
  assert.fail("던지지 않았다");
};

// ── 1. 계약 ──────────────────────────────────────────────────

test("8.8.18 합성 공고서의 본문 블록(1~16, 1~62. 표·누름틀·메일머지·{{}} 같은 키 중복): 값 없음 그대로 미리보기, 검사 오류 0, 자리 수 = 원본에서 센 수", () => {
  const src = reparse(notice());
  for (const [to, least] of [[16, 30], [62, 100]] as const) {
    const r = { sectionIndex: 0, parentPath: [], from: 1, to };
    const block = blockOf(src, r);
    const p = buildBlockPreviewDocument(block.proto, block.blob);
    checkPreview(src, r, block, p);
    // 자리 수십 개: 본문과 표 칸에 나뉘고 같은 키가 여러 번 나온다
    assert.ok(p.places.length >= least, `자리 ${p.places.length}`);
    assert.ok(p.places.some((x) => x.path.length > 1) && p.places.some((x) => x.path.length === 1), "본문·표 칸 모두");
    assert.ok(p.fields.some((f) => f.count >= 2), "같은 이름 중복");
    assert.deepEqual(new Set(p.fields.map((f) => f.kind)), new Set(["placeholder", "clickHere", "mailMerge"]));
    // 같은 입력은 같은 바이트, 원형·덩어리 JSON 왕복도 같다
    const again = buildBlockPreviewDocument(readBlockProto(writeBlockProto(block.proto)), new Uint8Array(block.blob));
    assert.ok(bytesEqual(p.bytes, again.bytes));
    assert.deepEqual(again.places, p.places);
  }
});

test("8.8.18 긴 값이 든 블록: 2판 생성으로 0~1,500자 값(여러 문장·줄바꿈·탭·XML 특수문자)을 채운 문서에서 뗀 블록도 그대로 미리보기가 된다(시드 5개 × 범위 2)", () => {
  const k = noticeKit();
  let longest = 0;
  let places = 0;
  for (const seed of [7501, 7502, 7503, 7504, 7505]) {
    const record = recordFor(randomText(rng(seed)));
    const c = caseOf(k.t, record, { selections: { s1: manual(k.t, "s1", "b1"), s2: manual(k.t, "s2", "b3") } });
    const r = generateFromTemplate(k.bytes, k.t, record, c, loaderOf(k.blobs));
    assert.ok(r.ok && !r.dryRun && r.output instanceof Uint8Array, `생성 ${seed}`);
    const filled = reparse(r.output);
    const list = listAtParent(filled.sections[0]!, [])!;
    for (const range of [{ sectionIndex: 0, parentPath: [], from: 1, to: 16 }, { sectionIndex: 0, parentPath: [], from: 1, to: list.length - 1 }]) {
      if (!extractable(filled, range)) continue;
      const block = blockOf(filled, range);
      const p = buildBlockPreviewDocument(block.proto, block.blob);
      checkPreview(filled, range, block, p);
      places += p.places.length;
      for (const f of listFields(reparse(p.bytes))) longest = Math.max(longest, f.valueText.length);
    }
  }
  console.log(`# 긴 값 블록 자리 ${places}, 가장 긴 필드 값 ${longest}자`);
  assert.ok(longest >= 1000 && places >= 100, `${longest} ${places}`);
});

test("8.8.18 표 칸 안 범위·여러 문단 누름틀·안내문 상태 누름틀·그림 블록도 미리보기가 된다", () => {
  const cases: [string, Range][] = [
    ["", { sectionIndex: 0, parentPath: [12, 1], from: 0, to: 5 }], // 합성 공고서 칸 [12, 1]
    ["span/field-span", { sectionIndex: 0, parentPath: [], from: 1, to: 4 }],
    ["span/field-span-cell", { sectionIndex: 0, parentPath: [], from: 1, to: 2 }],
    ["hancom/field-states", { sectionIndex: 0, parentPath: [], from: 1, to: 2 }],
    ["hancom/picture", { sectionIndex: 0, parentPath: [], from: 1, to: 2 }],
    ["tables/tables-rich", { sectionIndex: 0, parentPath: [], from: 1, to: 2 }],
  ];
  for (const [name, r] of cases) {
    const src = reparse(name === "" ? notice() : readFixture(name));
    const top = listAtParent(src.sections[0]!, r.parentPath)!;
    const range = { ...r, to: Math.min(r.to, top.length - 1) };
    assert.ok(extractable(src, range), `${name} ${JSON.stringify(range)}`);
    const block = blockOf(src, range);
    const p = buildBlockPreviewDocument(block.proto, block.blob);
    checkPreview(src, range, block, p);
    if (name === "span/field-span") {
      // 시작 문단의 "성명: " 뒤부터 끝 문단의 " 끝 뒤 글" 앞까지
      assert.deepEqual(p.places.map((x) => [x.kind, x.name, x.path, x.endPath]), [["clickHere", "성명", [1], [3]]]);
      const sec = reparse(p.bytes).sections[0]!;
      const place = p.places[0]!;
      assert.equal(sec.paragraphs[1]!.logicalText.slice(0, place.start), "성명: \uFFFC", "시작 표식(개체 자리 한 칸)까지");
      assert.equal(sec.paragraphs[3]!.logicalText.slice(place.end), "\uFFFC 끝 뒤 글", "끝 표식부터");
    }
    if (name === "hancom/picture") assert.equal(reparse(p.bytes).pkg.binaryEntries.length, 1, "그림 이진 자료");
  }
});

test("8.8.18 형식 버전: 바탕은 1.5, 1.5 원본 블록은 변환 없음, 1.2 원본 블록은 FRAG_UNIT_CONVERTED(7.66, 여백 절반), 버전 모르는 원본은 FRAG_FORMAT_UNKNOWN", () => {
  const r = { sectionIndex: 0, parentPath: [], from: 1, to: 3 };
  const v15 = reparse(readFixture("hancom/blocks"));
  const b15 = blockOf(v15, r);
  const p15 = buildBlockPreviewDocument(b15.proto, b15.blob);
  assert.deepEqual(p15.issues.filter((i) => i.code === "FRAG_UNIT_CONVERTED" || i.code === "FRAG_FORMAT_UNKNOWN"), []);
  // 1.2 합성 문서: 왼쪽 여백 2000(옛 단위)인 문단 모양 → 1.5 바탕에서는 1000
  const header = MINIMAL_HEADER.replace(
    '<hh:paraPr id="0"><hh:heading type="NONE" idRef="0" level="0"/>',
    '<hh:paraPr id="0"><hh:heading type="NONE" idRef="0" level="0"/><hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="2000" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin>',
  );
  const para = (t: string): string => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p>`;
  const plain = buildHwpx([para("첫 문단") + para("들여쓴 {{사업명}}") + para("둘째 {{사업명}}") + para("끝")], header);
  const pkg = openPackage(plain);
  const version = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" xmlVersion="1.2"/>';
  const v12 = reparse(rewriteArchive(plain, pkg.archive, { add: [{ name: "version.xml", data: new TextEncoder().encode(version), method: 8 }] }));
  const b12 = blockOf(v12, r);
  assert.equal(b12.fragment.source.xmlVersion, "1.2");
  const p12 = buildBlockPreviewDocument(b12.proto, b12.blob);
  assert.equal(p12.issues.filter((i) => i.code === "FRAG_UNIT_CONVERTED").length, 1);
  const doc12 = checkPreview(v12, r, b12, p12);
  const used = doc12.sections[0]!.paragraphs[1]!.attrs.paraPrIDRef;
  const xml = utf8.decode(readEntry(doc12.pkg.archive, doc12.pkg.bytes, "Contents/header.xml"));
  const at = xml.indexOf(`<hh:paraPr id="${used}"`);
  assert.ok(at >= 0);
  assert.ok(xml.slice(at, xml.indexOf("</hh:paraPr>", at)).includes('<hc:left value="1000" unit="HWPUNIT"/>'), "왼쪽 여백 2000(옛 단위) → 1000");
  assert.deepEqual(p12.fields, [{ name: "사업명", kind: "placeholder", count: 2 }]);
  const d1 = reparse(readFixture("D1"));
  const rd = { sectionIndex: 0, parentPath: [], from: 1, to: 4 };
  const bd = blockOf(d1, rd);
  const pd = buildBlockPreviewDocument(bd.proto, bd.blob);
  assert.equal(pd.issues.filter((i) => i.code === "FRAG_FORMAT_UNKNOWN").length, 1);
  checkPreview(d1, rd, bd, pd);
});

test("8.8.18 거절: 글 블록·덩어리 해시 불일치 TPL_FRAGMENT_MISSING, 조각 JSON 아님 FRAG_SCHEMA, 게이트 새 오류 GATE_NEW_ERRORS(바이트를 내지 않음)", () => {
  const src = reparse(readFixture("hancom/blocks"));
  const block = blockOf(src, { sectionIndex: 0, parentPath: [], from: 1, to: 3 });
  const textProto: BlockProto = { ...block.proto, content: { text: "글 블록 {{사업명}}" } };
  assert.equal(failure(() => buildBlockPreviewDocument(textProto, block.blob)).code, "TPL_FRAGMENT_MISSING");
  const changed = new Uint8Array(block.blob);
  changed[changed.length - 2] = 0x20;
  assert.equal(failure(() => buildBlockPreviewDocument(block.proto, changed)).code, "TPL_FRAGMENT_MISSING");
  const notFragment = new TextEncoder().encode(JSON.stringify({ schema: "hwpx-studio/other@1" }));
  assert.equal(failure(() => buildBlockPreviewDocument({ ...block.proto, content: { fragment: sha256Hex(notFragment) } }, notFragment)).code, "FRAG_SCHEMA");
  // 덩어리가 상해 조각 원문 끝에 없는 문단 모양을 가리키는 문단이 붙었다(저장소 손상을 흉내): 조각이 소스에서 갖던 문제로 설명되지 않는 새 오류
  const json = JSON.parse(utf8.decode(block.blob)) as { xml: string };
  json.xml += '<hp:p id="0" paraPrIDRef="777" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"/></hp:p>';
  const broken = new TextEncoder().encode(JSON.stringify(json));
  const e = failure(() => buildBlockPreviewDocument({ ...block.proto, content: { fragment: sha256Hex(broken) } }, broken));
  assert.equal(e.code, "GATE_NEW_ERRORS");
  assert.match(e.message, /RES_DANGLING/);
});

// ── 2. 무작위 50회 ────────────────────────────────────────────

test("8.8.18 무작위 50회(합성 공고서 본문·칸 범위와 한컴 저장본): 같은 입력 같은 바이트, 검사 오류 0, 블록 글 그대로, 자리 수 = 원본에서 센 수", () => {
  const sources: { name: string; doc: HwpxDocument }[] = [
    { name: "notice", doc: reparse(notice()) },
    { name: "merge", doc: reparse(readFixture("merge/merge-fields")) },
    { name: "rich", doc: reparse(readFixture("tables/tables-rich")) },
    { name: "blocks", doc: reparse(readFixture("hancom/blocks")) },
    { name: "span", doc: reparse(readFixture("span/field-span")) },
  ];
  const next = rng(7575);
  const stats = { previews: 0, rejectedRanges: 0, places: 0, fields: 0, maxPlaces: 0, cells: 0, warnings: {} as Record<string, number> };
  let i = 0;
  while (stats.previews < 50) {
    assert.ok(i++ < 500, "뗄 수 있는 범위를 충분히 찾지 못했다");
    const s = next() < 0.5 ? sources[0]! : sources[1 + Math.floor(next() * (sources.length - 1))]!; // 절반은 자리가 많은 합성 공고서
    const inCell = s.name === "notice" && next() < 0.5;
    const parentPath = inCell ? [12, 1] : [];
    const list = listAtParent(s.doc.sections[0]!, parentPath)!;
    const lo = inCell ? 0 : 1;
    const from = lo + Math.floor(next() * (list.length - lo));
    const to = Math.min(list.length - 1, from + Math.floor(next() * 20));
    const r = { sectionIndex: 0, parentPath, from, to };
    if (!extractable(s.doc, r)) {
      stats.rejectedRanges++;
      continue;
    }
    const block = blockOf(s.doc, r, `k${(0xb000 + stats.previews).toString(16).padStart(8, "0")}`);
    const proto = readBlockProto(writeBlockProto(block.proto));
    const p = buildBlockPreviewDocument(proto, block.blob);
    const q = buildBlockPreviewDocument(proto, new TextEncoder().encode(serializeFragment(block.fragment)));
    assert.ok(bytesEqual(p.bytes, q.bytes), `결정성 ${s.name} ${JSON.stringify(r)}`);
    checkPreview(s.doc, r, block, p);
    stats.previews++;
    stats.places += p.places.length;
    stats.fields += p.fields.length;
    stats.maxPlaces = Math.max(stats.maxPlaces, p.places.length);
    if (inCell) stats.cells++;
    for (const w of p.issues) stats.warnings[w.code] = (stats.warnings[w.code] ?? 0) + 1;
  }
  console.log(`# 무작위 미리보기 ${JSON.stringify(stats)}`);
  assert.ok(stats.places >= 300 && stats.cells >= 5, JSON.stringify(stats));
});
