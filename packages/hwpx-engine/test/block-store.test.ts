// 블록 저장소 API(엔진 명세 8.8.17, 이슈 #73): 원형 block-proto@1의 출처·판 기록, 범위에서 떼기, 넣을 때 서식 비교 경고, 같은 이름 입력 항목,
// 다시 떼어 새 판, 최신 판·바탕 문서 알림, 업데이트 검사 목록, 무작위 50회(결정성·게이트·검사기 새 오류 0).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPlan,
  extractFragment,
  fingerprintResource,
  HwpxError,
  listFields,
  makeLookup,
  openPackage,
  parseFragment,
  serializeFragment,
  validateDocument,
  walkParagraphs,
  type HwpxDocument,
  type ParagraphNode,
} from "../src/index.ts";
import {
  blockFormatDiffs,
  extractBlock,
  generate,
  generateFromTemplate,
  makeHeadingRangeAnchor,
  makeRangeAnchor,
  planBlockInsert,
  planBlockUpdate,
  reextractBlock,
  type BlockFormatDiff,
  type ExtractedBlock,
  type StudioGenerateResult,
} from "../src/fill/index.ts";
import { parseFragmentXml } from "../src/fill/fragment-fill.ts";
import { findLooseKeys } from "../src/fill/studio-common.ts";
import {
  bindValues,
  checkTemplateUpdates,
  contentSha256,
  planProtoUpdate,
  readBlockProto,
  readDataset,
  readStudioTemplate,
  sha256Hex,
  writeBlockProto,
  type BlockProto,
  type StudioTemplate,
  type Template,
} from "../src/template/index.ts";
import { buildHwpx, bytesEqual, NS_HC, NS_HH, newErrorsAfter, readFixture, readFixtureText, reparse } from "./helpers.ts";
import { caseOf, CLICK_NAMES, loaderOf, manual, MERGE_KEYS, noticeKit, randomText, recordFor, type Blobs, type NoticeKit } from "./generate-v2-helpers.ts";
import { at, HEADINGS, notice, rng } from "./range-helpers.ts";

const AT = "2026-10-06T09:30:00Z";
const meta = (id = "k0000b001", name = "시험 블록") => ({ id, name, at: AT });

let kitCache: NoticeKit | undefined;
const kit = (): NoticeKit => (kitCache ??= noticeKit());

const failure = (f: () => unknown): HwpxError => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아니다: ${String(e)}`);
    return e;
  }
  assert.fail("던지지 않았다");
};

type Ok = Extract<StudioGenerateResult, { ok: true; dryRun: false }>;
function ok(r: StudioGenerateResult): Ok {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code))}`);
  assert.ok(!r.dryRun);
  return r as Ok;
}
const outBytes = (r: Ok): Uint8Array => {
  assert.ok(r.output instanceof Uint8Array);
  return r.output;
};

/** 노티스 키트의 템플릿에서 슬롯 s1의 블록 b1을 이 원형 블록(핀 포함)으로 바꾼다. 원형 핀 검사(lookupProto)를 거친다 */
function templateWith(k: NoticeKit, block: ExtractedBlock): { t: StudioTemplate; blobs: Blobs } {
  const raw = structuredClone(k.raw) as Record<string, any>;
  const sha = contentSha256(block.proto.content);
  const blobs: Blobs = new Map(k.blobs);
  blobs.set(sha, block.blob);
  const b1 = (raw["blocks"] as Record<string, unknown>[]).find((b) => b["id"] === "b1");
  assert.ok(b1 !== undefined);
  b1["content"] = { fragment: sha };
  b1["proto"] = { id: block.proto.id, version: block.proto.version };
  const t = readStudioTemplate(JSON.stringify(raw), {
    hasBlob: (s) => blobs.has(s),
    lookupProto: (id, version) => (id === block.proto.id && version === block.proto.version ? block.proto.content : undefined),
  });
  assert.ok(t.schema === "hwpx-studio/template@2");
  return { t, blobs };
}

/** 저장소 왕복: 원형은 정규 JSON 글로, 덩어리는 바이트로 갔다가 돌아온다 */
function roundTrip(b: ExtractedBlock): { proto: BlockProto; blob: Uint8Array } {
  const json = writeBlockProto(b.proto);
  const proto = readBlockProto(json);
  assert.equal(writeBlockProto(proto), json, "정규 JSON 왕복");
  return { proto, blob: new Uint8Array(b.blob) };
}

// ── 1. block-proto@1 확장: 출처·판 기록(옛 원형 호환) ──────────────────

test("8.8.17 원형: 옛 원형(source·history 없음)은 그대로 읽고, 떼어 낸 원형은 출처·판 기록과 함께 정규 JSON으로 왕복한다", () => {
  for (const name of ["proto-v2.json", "proto-v3.json"]) {
    const p = readBlockProto(readFixtureText(`template-v2/${name}`));
    assert.ok(!("source" in p) && !("history" in p), name);
    assert.deepEqual(readBlockProto(writeBlockProto(p)), p);
  }
  const doc = reparse(notice());
  const b = extractBlock(doc, makeRangeAnchor(doc, 0, [], 18, 21)!, { ...meta(), note: "메모" });
  assert.deepEqual(readBlockProto(writeBlockProto(b.proto)), b.proto);
  assert.equal(b.proto.note, "메모");
  assert.deepEqual(b.proto.history, [{ version: 1, at: AT, change: "첫 저장" }]);
});

test("8.8.17 원형 거부: source·history의 모르는 키·빠진 필드·틀린 형식은 TPL_FIELD(where = block-proto…)", () => {
  const doc = reparse(notice());
  const base = JSON.parse(writeBlockProto(extractBlock(doc, makeRangeAnchor(doc, 0, [], 18, 21)!, meta()).proto)) as Record<string, any>;
  const P = (edit: (p: Record<string, any>) => void): string => {
    const p = structuredClone(base);
    edit(p);
    return JSON.stringify(p);
  };
  const rows: [string, string][] = [
    ["source의 모르는 키", P((p) => (p["source"].file = "x"))],
    ["source.sha256이 해시가 아님", P((p) => (p["source"].sha256 = "abc"))],
    ["selection 빠짐", P((p) => delete p["source"].selection)],
    ["selection.to < from", P((p) => (p["source"].selection.to = 10))],
    ["parentPath 홀수 길이", P((p) => (p["source"].selection.parentPath = [1]))],
    ["print.count가 구간과 다름", P((p) => (p["source"].print.count = 3))],
    ["print.first 빠짐", P((p) => delete p["source"].print.first)],
    ["extractedAt 꼴", P((p) => (p["source"].extractedAt = "2026-10-06 09:30"))],
    ["extractedAt 없는 날짜", P((p) => (p["source"].extractedAt = "2026-13-40T00:00:00Z"))],
    ["history 빈 배열", P((p) => (p["history"] = []))],
    ["history 마지막 판이 version과 다름", P((p) => (p["history"] = [{ version: 2, at: AT, change: "x" }]))],
    ["history 판 번호 오름차순 아님", P((p) => ((p["version"] = 3), (p["history"] = [{ version: 2, at: AT, change: "a" }, { version: 2, at: AT, change: "b" }, { version: 3, at: AT, change: "c" }])))],
    ["history change 빔", P((p) => (p["history"][0].change = ""))],
    ["history 모르는 키", P((p) => (p["history"][0].by = "x"))],
    ["history가 배열 아님", P((p) => (p["history"] = { version: 1 }))],
  ];
  for (const [name, json] of rows) {
    const e = failure(() => readBlockProto(json));
    assert.equal(e.code, "TPL_FIELD", name);
    assert.ok(e.where?.startsWith("block-proto"), `${name}: where ${e.where}`);
  }
});

// ── 2. 떼기 extractBlock ───────────────────────────────────────

test("8.8.17 extractBlock: range·headingRange 범위 → 조각(extractFragment 그대로)·덩어리 해시·keys(필드 표시 구간 밖 {{ }})·출처", () => {
  const bytes = notice();
  const doc = reparse(bytes);
  const heading = makeHeadingRangeAnchor(doc, 0, [], 22);
  assert.ok(heading !== undefined);
  const hb = extractBlock(doc, heading, meta());
  const rb = extractBlock(doc, makeRangeAnchor(doc, 0, [], 22, 26)!, meta());
  // 제목 범위와 같은 구간의 range는 같은 블록이다
  assert.ok(bytesEqual(hb.blob, rb.blob));
  assert.equal(writeBlockProto(hb.proto), writeBlockProto(rb.proto));
  const selection = { sectionIndex: 0, parentPath: [], from: 22, to: 26 };
  assert.equal(serializeFragment(hb.fragment), serializeFragment(extractFragment(doc, selection)));
  assert.equal(contentSha256(hb.proto.content), sha256Hex(hb.blob));
  assert.deepEqual(parseFragment(new TextDecoder().decode(hb.blob)), hb.fragment);
  assert.deepEqual(hb.proto.source, { sha256: sha256Hex(bytes), selection, print: makeRangeAnchor(doc, selection)!.print, extractedAt: AT });
  assert.deepEqual(hb.proto.keys, ["기관명", "사업명"]);
  assert.equal(hb.proto.version, 1);
  // 메일머지 표시 글 안의 {{ }}는 keys에 없다(필드 자리가 맡는다). 칸 안 범위도 같은 규칙
  assert.deepEqual(extractBlock(doc, makeRangeAnchor(doc, 0, [], 47, 62)!, meta()).proto.keys, [
    "project.name", "project.start", "project.end", "dates.start", "dates.end", "dates.days", "manager.phone", "manager.email",
  ]);
  const cell = extractBlock(doc, makeRangeAnchor(doc, 0, [12, 1], 1, 3)!, meta());
  assert.deepEqual(cell.proto.keys, ["담당자"]);
  assert.deepEqual(cell.proto.source?.selection, { sectionIndex: 0, parentPath: [12, 1], from: 1, to: 3 });
  // 결정성: 같은 입력은 같은 원형 JSON·덩어리 바이트
  const again = extractBlock(reparse(notice()), heading, meta());
  assert.ok(bytesEqual(again.blob, hb.blob));
  assert.equal(writeBlockProto(again.proto), writeBlockProto(hb.proto));
});

test("8.8.17 extractBlock 거절: 구역 설정·누름틀 자름·범위 못 찾음·안쪽 변경·잘못된 meta. relocated는 찾은 자리에서 뗀다", () => {
  const doc = reparse(notice());
  assert.equal(failure(() => extractBlock(doc, makeRangeAnchor(doc, 0, [], 0, 2)!, meta())).code, "FRAG_SECTION_PROPS");
  const span = reparse(readFixture("span/field-span"));
  assert.equal(failure(() => extractBlock(span, makeRangeAnchor(span, 0, [], 1, 2)!, meta())).code, "FRAG_SPLITS_FIELD");
  assert.ok(extractBlock(span, makeRangeAnchor(span, 0, [], 1, 3)!, meta()).proto.version === 1);
  const draft = makeRangeAnchor(doc, 0, [], 18, 21)!;
  assert.equal(failure(() => extractBlock(doc, { ...draft, print: { ...draft.print, first: { text: "없는 글", sha256: "0".repeat(64) } } }, meta())).code, "ANCHOR_NOT_FOUND");
  assert.equal(failure(() => extractBlock(doc, { ...draft, print: { ...draft.print, sha256: "0".repeat(64) } }, meta())).code, "ANCHOR_CHANGED");
  assert.equal(failure(() => extractBlock(doc, draft, meta("x1"))).code, "TPL_ID");
  assert.equal(failure(() => extractBlock(doc, draft, meta("k0000b001", ""))).code, "TPL_FIELD");
  assert.equal(failure(() => extractBlock(doc, draft, { ...meta(), at: "어제" })).code, "TPL_FIELD");
  // 앞에 문단 두 개를 넣은 문서에서 옛 범위: relocated 경고와 함께 찾은 자리(+2)에서 뗀다
  const tpl = { schema: "hwpx-studio/template@1", anchors: [{ id: "p", ...makeRangeAnchor(doc, 0, [], 1, 1)! }], rules: [{ id: "i", do: { type: "insertText", anchor: "p", position: "after", value: { text: "끼운 문단\n끼운 둘째" }, style: "inherit" } }], options: {} } as unknown as Template;
  const shifted = generate(notice(), tpl, readDataset({}), { missing: "keep" });
  assert.ok(shifted.ok && !shifted.dryRun);
  const moved = extractBlock(reparse(shifted.output), draft, meta());
  assert.deepEqual(moved.proto.source?.selection, { sectionIndex: 0, parentPath: [], from: 20, to: 23 });
  assert.ok(moved.issues.some((i) => i.code === "ANCHOR_RELOCATED"));
});

// ── 3. 서식 비교: 같은 서식 자리 0건, 다른 서식 자리 전부 ─────────────────

const PARA = { L: `<hh:align horizontal="LEFT"/>`, C: `<hh:align horizontal="CENTER"/>` } as const;
type Shape = { para: "L" | "C"; style: "본문" | "제목" };
/** paraPr 두 개(왼쪽·가운데)와 스타일 두 개(본문 → 왼쪽, 제목 → 가운데)를 순서를 바꿔 둘 수 있는 머리 */
function formatHeader(paras: ("L" | "C")[], styles: ("본문" | "제목")[]): string {
  const paraPr = paras.map((s, id) => `<hh:paraPr id="${id}">${PARA[s]}<hh:heading type="NONE" idRef="0" level="0"/><hh:border borderFillIDRef="1"/></hh:paraPr>`).join("");
  const style = styles
    .map((name, id) => `<hh:style id="${id}" type="PARA" name="${name}" paraPrIDRef="${paras.indexOf(name === "본문" ? "L" : "C")}" charPrIDRef="0" nextStyleIDRef="${id}"/>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head xmlns:hh="${NS_HH}" xmlns:hc="${NS_HC}" version="1.5" secCnt="1"><hh:refList>` +
    `<hh:fontfaces itemCnt="1"><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="x" type="TTF" isEmbedded="0"/></hh:fontface></hh:fontfaces>` +
    `<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0"/></hh:borderFills>` +
    `<hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000" borderFillIDRef="1"><hh:fontRef hangul="0"/></hh:charPr></hh:charProperties>` +
    `<hh:paraProperties itemCnt="2">${paraPr}</hh:paraProperties><hh:styles itemCnt="2">${style}</hh:styles></hh:refList></hh:head>`
  );
}
/** 모양 목록대로 문단을 만든 문서(머리의 id 배치는 문서마다 다르다) */
function formatDoc(paras: ("L" | "C")[], styles: ("본문" | "제목")[], shapes: Shape[], label: string): HwpxDocument {
  const body = shapes
    .map((s, i) => `<hp:p id="${i + 1}" paraPrIDRef="${paras.indexOf(s.para)}" styleIDRef="${styles.indexOf(s.style)}"><hp:run charPrIDRef="0"><hp:t>${label} ${i}</hp:t></hp:run></hp:p>`)
    .join("");
  return reparse(buildHwpx([body], formatHeader(paras, styles)));
}
const SHAPES: Shape[] = [
  { para: "L", style: "본문" },
  { para: "C", style: "제목" },
  { para: "L", style: "제목" },
  { para: "C", style: "본문" },
];

test("8.8.17 서식 비교(참·거짓): 같은 모양 자리는 경고 0건, 다른 모양 자리는 다른 속성 전부. id가 달라도 모양으로 견준다", (t) => {
  const a = formatDoc(["L", "C"], ["본문", "제목"], SHAPES, "가");
  const b = formatDoc(["C", "L"], ["제목", "본문"], [...SHAPES].reverse(), "나");
  const bShapes = [...SHAPES].reverse();
  let same = 0;
  let differ = 0;
  for (let from = 0; from < SHAPES.length; from++) {
    for (let to = from; to < SHAPES.length; to++) {
      const block = extractBlock(a, makeRangeAnchor(a, 0, [], from, to)!, meta());
      for (const [doc, shapes] of [[a, SHAPES], [b, bShapes]] as const) {
        for (let j = 0; j < shapes.length; j++) {
          const spot = at(shapes, j);
          const want: BlockFormatDiff[] = [];
          for (let i = from; i <= to; i++) {
            const s = at(SHAPES, i);
            if (s.para !== spot.para) want.push({ paragraph: i - from, property: "paraPr", block: "", target: "" });
            if (s.style !== spot.style) want.push({ paragraph: i - from, property: "style", block: "", target: "" });
          }
          const plan = planBlockInsert(doc, block.proto, block.blob, { sectionIndex: 0, parentPath: [], index: j, position: "after" });
          assert.deepEqual(plan.formatDiffs.map((d) => [d.paragraph, d.property]), want.map((d) => [d.paragraph, d.property]), `블록 ${from}~${to} → 자리 ${j}`);
          const warnings = plan.issues.filter((i) => i.code === "BLOCK_FORMAT_DIFFERS");
          assert.equal(warnings.length, want.length === 0 ? 0 : 1);
          assert.equal(plan.summary["formatDiffParagraphs"], new Set(want.map((d) => d.paragraph)).size);
          if (want.length === 0) same++;
          else differ++;
          // 자동 변경 없음: 넣은 문단의 문단 모양·스타일은 블록의 것과 같은 모양(가져오기 7.5 그대로)
          const out = reparse(applyPlan(doc.pkg, plan));
          const lookup = makeLookup(out);
          const shapeOf = (p: ParagraphNode): string => {
            const pp = lookup.resource("paraPr", undefined, p.attrs.paraPrIDRef ?? "");
            const st = lookup.resource("style", undefined, p.attrs.styleIDRef ?? "");
            assert.ok(pp !== undefined && st !== undefined);
            return `${fingerprintResource(pp, lookup)}|${fingerprintResource(st, lookup)}`;
          };
          const srcLookup = makeLookup(a);
          for (let i = from; i <= to; i++) {
            const src = at(at(a.sections, 0).paragraphs, i);
            const pp = srcLookup.resource("paraPr", undefined, src.attrs.paraPrIDRef ?? "")!;
            const st = srcLookup.resource("style", undefined, src.attrs.styleIDRef ?? "")!;
            assert.equal(shapeOf(at(at(out.sections, 0).paragraphs, j + 1 + i - from)), `${fingerprintResource(pp, srcLookup)}|${fingerprintResource(st, srcLookup)}`);
          }
        }
      }
    }
  }
  t.diagnostic(`같은 서식 자리 ${same}회(경고 0), 다른 서식 자리 ${differ}회(다른 속성 전부 경고)`);
  assert.ok(same >= 8 && differ >= 70, `같은 서식 ${same}, 다른 서식 ${differ}`);
});

test("8.8.17 서식 비교(독립 대조): 한컴 저장본·합성 문서 사이에서 blockFormatDiffs = 문단마다 fingerprintResource로 견준 결과", (t) => {
  const docs = ["D1", "D2", "D3", "D5", "hancom-merged", "merge/merge-fields"].map((n) => reparse(readFixture(n)));
  const print = (doc: HwpxDocument, kind: string, id: string | null): string => {
    if (id === null) return "none";
    const lookup = makeLookup(doc);
    const item = lookup.resource(kind, undefined, id);
    return item === undefined ? `missing:${id}` : fingerprintResource(item, lookup);
  };
  let compared = 0;
  let warned = 0;
  for (const src of docs) {
    const list = at(src.sections, 0).paragraphs;
    // 구역 설정이 없는 앞쪽 범위 하나(문단 1~3 또는 끝까지)
    const from = 1;
    const to = Math.min(3, list.length - 1);
    let block: ExtractedBlock;
    try {
      block = extractBlock(src, makeRangeAnchor(src, 0, [], from, to)!, meta());
    } catch {
      continue;
    }
    for (const target of docs) {
      at(target.sections, 0).paragraphs.forEach((spot, j) => {
        const want: [number, string][] = [];
        for (let i = from; i <= to; i++) {
          const p = at(list, i);
          if (print(src, "paraPr", p.attrs.paraPrIDRef) !== print(target, "paraPr", spot.attrs.paraPrIDRef)) want.push([i - from, "paraPr"]);
          if (print(src, "style", p.attrs.styleIDRef) !== print(target, "style", spot.attrs.styleIDRef)) want.push([i - from, "style"]);
        }
        const got = blockFormatDiffs(target, block.fragment, { sectionIndex: 0, parentPath: [], index: j });
        assert.deepEqual(got.map((d) => [d.paragraph, d.property]), want);
        compared++;
        if (want.length > 0) warned++;
      });
    }
  }
  t.diagnostic(`대조 ${compared}회, 그 가운데 차이 있음 ${warned}회`);
  assert.ok(compared >= 300 && warned > 0 && warned < compared, `대조 ${compared}, 경고 ${warned}`);
});

test("8.8.17 planBlockInsert: 가져오기 계획(7.5) 그대로 + 서식 차이, 덩어리 확인(해시·글 블록·조각 아님)", () => {
  const doc = reparse(notice());
  const block = extractBlock(doc, makeHeadingRangeAnchor(doc, 0, [], 27)!, meta());
  const target = reparse(readFixture("hancom-merged"));
  const point = { sectionIndex: 0, parentPath: [], index: 5, position: "after" as const };
  const plan = planBlockInsert(target, block.proto, block.blob, point);
  assert.equal(plan.summary["insertedParagraphs"], 5);
  const out = reparse(applyPlan(target.pkg, plan));
  assert.deepEqual(at(out.sections, 0).paragraphs.slice(6, 11).map((p) => p.logicalText), block.fragment.texts.slice(0, 5));
  assert.deepEqual(newErrorsAfter(validateDocument(target.pkg.bytes), validateDocument(out.pkg.bytes)).map((v) => v.code), []);
  assert.deepEqual(plan.formatDiffs, blockFormatDiffs(target, block.fragment, point));
  // 덩어리 확인
  const other = new Uint8Array(block.blob);
  other[other.length - 2] = 0x20;
  assert.equal(failure(() => planBlockInsert(target, block.proto, other, point)).code, "TPL_FRAGMENT_MISSING");
  assert.equal(failure(() => planBlockInsert(target, { ...block.proto, content: { text: "글" } }, block.blob, point)).code, "TPL_FRAGMENT_MISSING");
  const junk = new TextEncoder().encode("{}");
  assert.equal(failure(() => planBlockInsert(target, { ...block.proto, content: { fragment: sha256Hex(junk) } }, junk, point)).code, "FRAG_SCHEMA");
});

// ── 4. 같은 이름 입력 항목: 블록 안 {{이름}}·누름틀 = 문서의 같은 이름 항목 ─────

test("8.8.17 같은 이름: 블록 안 {{키}}·누름틀·메일머지가 문서의 같은 이름 항목과 같은 값으로 채워진다(bindValues·selectSlots·generateFromTemplate)", (ctx) => {
  const k = kit();
  const source = reparse(readFixture("merge/merge-fields"));
  // 다른 문서(원본 서식)의 문단 1~14: 메일머지 필드·누름틀 성명·소속·표 칸 안 메일머지·{{project.*}}·{{dates.*}}
  const block = extractBlock(source, makeRangeAnchor(source, 0, [], 1, 14)!, meta());
  const { t, blobs } = templateWith(k, block);
  const record = recordFor((name) => `값[${name}]`);
  const c = caseOf(t, record, { selections: { s1: manual(t, "s1", "b1"), s2: manual(t, "s2", "b3") } });
  const r = ok(generateFromTemplate(k.bytes, t, record, c, loaderOf(blobs)));
  const out = reparse(outBytes(r));
  const values = new Map(bindValues(t, record, c).map((v) => [v.name, v.text]));
  const textOf = (name: string): string => {
    const v = values.get(name);
    assert.ok(v !== undefined, name);
    return v;
  };
  const topCount = parseFragmentXml(block.fragment).paragraphs.length;
  assert.equal(topCount, 14); // 문단 1~14
  const inBlock = (path: readonly number[]): boolean => (path[0] ?? -1) >= 18 && (path[0] ?? -1) < 18 + topCount;
  // 누름틀: 같은 이름이면 블록 안과 밖 모두 같은 값
  const fields = listFields(out);
  let blockFields = 0;
  for (const name of CLICK_NAMES) {
    const same = fields.filter((f) => f.type === "CLICK_HERE" && f.name === name);
    assert.ok(same.length > 0, name);
    for (const f of same) assert.equal(f.valueText, textOf(name), `누름틀 ${name}`);
    blockFields += same.filter((f) => inBlock(f.path)).length;
  }
  // 메일머지(MERGE_KEYS에는 순번·where로 좁힌 사유 설명·재공고가 없다)
  for (const key of MERGE_KEYS) {
    const same = fields.filter((f) => f.type === "MAILMERGE" && f.mergeKey === key);
    for (const f of same) assert.equal(f.valueText, textOf(key), `메일머지 ${key}`);
    blockFields += same.filter((f) => inBlock(f.path)).length;
  }
  ctx.diagnostic(`블록 안 필드 ${blockFields}개, 블록 안 {{ }} 키 ${block.proto.keys.length}종, 결과 문서 필드 ${fields.length}개`);
  assert.ok(blockFields >= 15, `블록 안 필드 ${blockFields}`);
  // {{키}}: 결과에 남은 {{ }}가 없고, 블록 자리의 값 개수 = 블록 안 {{키}} 개수, 블록 밖에도 같은 값이 있다
  const all = (d: HwpxDocument): ParagraphNode[] => d.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)]);
  // 남은 {{ }}는 이 블록에 적용되지 않는 메일머지 필드(where가 다른 블록인 재공고, 순번을 고정한 사유 설명)의 표시 글뿐이다
  const left = all(out).flatMap((p) => findLooseKeys(p.logicalText).map((h) => h.key));
  assert.ok(left.every((key) => key === "재공고" || key === "사유 설명"), `남은 {{ }}: ${JSON.stringify(left)}`);
  const blockTexts = at(out.sections, 0).paragraphs.slice(18, 18 + topCount);
  for (const key of block.proto.keys) {
    const want = block.fragment.texts.reduce((sum, text) => sum + findLooseKeys(text).filter((h) => h.key === key).length, 0);
    const count = (ps: ParagraphNode[]): number => ps.reduce((sum, p) => sum + p.logicalText.split(textOf(key)).length - 1, 0);
    assert.equal(count([...walkParagraphs(blockTexts)]), want, `블록 안 {{${key}}}`);
    const outside = all(out).filter((p) => !blockTexts.includes(p) && ![...walkParagraphs(blockTexts)].includes(p));
    assert.ok(count(outside) > 0, `블록 밖 {{${key}}}`);
  }
  assert.deepEqual(r.report.validation?.newErrors.map((v) => v.code), []);
});

// ── 5. 다시 떼기 → 새 판, 6. 알림·업데이트 검사 ──────────────────────

test("8.8.17 reextractBlock: 결과 문서에서 다시 떼면 같은 id의 새 판(판 +1, previous, history 추가, 출처 = 결과 문서), 바뀐 점은 수량만", () => {
  const k = kit();
  const v1 = extractBlock(k.doc, makeHeadingRangeAnchor(k.doc, 0, [], 22)!, meta("k0000c0de", "2장 조항"));
  const { t, blobs } = templateWith(k, v1);
  const record = recordFor((name) => `값[${name}] & <확인>`);
  const c = caseOf(t, record, { selections: { s1: manual(t, "s1", "b1"), s2: manual(t, "s2", "b3") } });
  const result = outBytes(ok(generateFromTemplate(k.bytes, t, record, c, loaderOf(blobs))));
  const resultDoc = reparse(result);
  const later = "2026-10-07T10:00:00Z";
  const v2 = reextractBlock(resultDoc, makeRangeAnchor(resultDoc, 0, [], 18, 22)!, v1.proto, { at: later, previous: v1.fragment });
  assert.equal(v2.proto.id, v1.proto.id);
  assert.equal(v2.proto.name, "2장 조항");
  assert.equal(v2.proto.version, 2);
  assert.deepEqual(v2.proto.previous, { version: 1, content: contentSha256(v1.proto.content) });
  assert.equal(v2.proto.source?.sha256, sha256Hex(result));
  assert.equal(v2.proto.source?.extractedAt, later);
  // 채운 결과에서 다시 떼면 {{ }} 입력 항목이 사라진다: 경고 BLOCK_KEYS_DROPPED(사라진 키 목록)와 바뀐 점의 입력 항목 수. 막지는 않는다
  assert.deepEqual(v1.proto.keys, ["기관명", "사업명"]);
  assert.deepEqual(v2.proto.keys, []);
  const dropped = v2.issues.filter((i) => i.code === "BLOCK_KEYS_DROPPED");
  assert.deepEqual(dropped.map((i) => [i.severity, i.where]), [["warning", `block:${v1.proto.id}`]]);
  assert.ok(dropped[0]?.message.includes("입력 항목 2개('기관명'·'사업명')"), dropped[0]?.message);
  assert.ok(!dropped[0]?.message.includes("값["), "경고에 값 원문이 없다");
  const changed = v1.fragment.texts.filter((x, i) => x !== v2.fragment.texts[i]).length;
  assert.equal(changed, 4);
  assert.deepEqual(v2.proto.history, [
    { version: 1, at: AT, change: "첫 저장" },
    { version: 2, at: later, change: `입력 항목 2→0개, 글이 다른 문단 ${changed}개` },
  ]);
  assert.ok(!v2.proto.history?.some((h) => h.change.includes("값[")), "바뀐 점에 값 원문이 없다");
  // 직접 적은 바뀐 점, 기록 없는 옛 원형의 다음 판, 판 3. 키가 줄지 않으면(0 → 0) 경고 없음
  const v3 = reextractBlock(resultDoc, makeRangeAnchor(resultDoc, 0, [], 18, 22)!, v2.proto, { at: later, change: "문구 다듬음", name: "새 이름" });
  assert.deepEqual([v3.proto.version, v3.proto.name, v3.proto.history?.at(-1)?.change, v3.proto.history?.length], [3, "새 이름", "문구 다듬음", 3]);
  assert.ok(!v3.issues.some((i) => i.code === "BLOCK_KEYS_DROPPED"));
  const legacy = readBlockProto(readFixtureText("template-v2/proto-v3.json"));
  const v4 = reextractBlock(k.doc, makeRangeAnchor(k.doc, 0, [], 18, 21)!, legacy, { at: later });
  assert.deepEqual([v4.proto.version, v4.proto.history, v4.proto.previous?.version], [4, [{ version: 4, at: later, change: "다시 저장" }], 3]);
  assert.ok(!("note" in v4.proto));
  // 고치지 않고 다시 떼면 "내용 변화 없음"
  const same = reextractBlock(k.doc, makeHeadingRangeAnchor(k.doc, 0, [], 22)!, v1.proto, { at: later, previous: v1.fragment });
  assert.equal(same.proto.history?.at(-1)?.change, "내용 변화 없음");
  assert.deepEqual([same.proto.keys, same.issues.filter((i) => i.code === "BLOCK_KEYS_DROPPED")], [v1.proto.keys, []], "키가 그대로면 경고 없음");
  // 새 판을 다른 문서에 넣으면 고친 글 그대로 들어간다
  const target = reparse(readFixture("hancom/blocks"));
  const plan = planBlockInsert(target, v2.proto, v2.blob, { sectionIndex: 0, parentPath: [], index: 2, position: "after" });
  const placed = reparse(applyPlan(target.pkg, plan));
  assert.deepEqual(at(placed.sections, 0).paragraphs.slice(3, 8).map((p) => p.logicalText), v2.fragment.texts);
  assert.deepEqual(plan.formatDiffs, [], "같은 한컴 기본 서식");
});

test("8.8.17 checkTemplateUpdates: 새 판이 있으면 BLOCK_NEWER_VERSION, 바탕 문서 해시가 다르면 TPL_SOURCE_CHANGED(생성은 TPL_SOURCE_MISMATCH로 막힘). 자동 교체 없음", () => {
  const k = kit();
  const v1 = extractBlock(k.doc, makeHeadingRangeAnchor(k.doc, 0, [], 22)!, meta("k0000c0de"));
  const { t, blobs } = templateWith(k, v1);
  const before = JSON.stringify(t);
  assert.deepEqual(checkTemplateUpdates(t, () => 1, k.t.source.sha256.toUpperCase()), []);
  assert.deepEqual(checkTemplateUpdates(t, () => undefined), []);
  const notices = checkTemplateUpdates(t, (id) => (id === v1.proto.id ? 3 : undefined), sha256Hex(readFixture("D1")));
  assert.deepEqual(
    notices.map(({ message: _m, ...rest }) => rest),
    [
      { code: "TPL_SOURCE_CHANGED", template: t.id, version: t.version, expected: t.source.sha256, actual: sha256Hex(readFixture("D1")) },
      { code: "BLOCK_NEWER_VERSION", template: t.id, block: "b1", proto: v1.proto.id, pinned: 1, latest: 3 },
    ],
  );
  assert.equal(JSON.stringify(t), before, "템플릿은 그대로");
  // 바탕 문서가 바뀌면 생성은 기존 검사(TPL_SOURCE_MISMATCH)가 막는다
  const record = recordFor((name) => name);
  const c = caseOf(t, record, { selections: { s1: manual(t, "s1", "b1"), s2: manual(t, "s2", "b3") } });
  const r = generateFromTemplate(readFixture("D1"), t, record, c, loaderOf(blobs));
  assert.equal(r.ok, false);
  assert.deepEqual(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code), ["TPL_SOURCE_MISMATCH"]);
});

test("8.8.17 planBlockUpdate: 새 판 전파(planProtoUpdate) + 자리 못 찾음·이름 충돌·서식 차이를 한 목록으로", () => {
  const k = kit();
  const v1 = extractBlock(k.doc, makeHeadingRangeAnchor(k.doc, 0, [], 22)!, meta("k0000c0de"));
  const { t, blobs } = templateWith(k, v1);
  const v2 = reextractBlock(k.doc, makeHeadingRangeAnchor(k.doc, 0, [], 27)!, v1.proto, { at: AT });
  // 정상: 새 템플릿 판, 오류 0, 같은 서식이라 경고 0
  const good = planBlockUpdate(t, v2.proto, v2.blob, k.doc);
  assert.equal(good.template?.version, t.version + 1);
  assert.deepEqual(good.updated, [{ block: "b1", from: 1, to: 2 }]);
  assert.deepEqual(good.issues, []);
  const b1 = good.template?.blocks.find((b) => b.id === "b1");
  assert.deepEqual([b1?.proto, b1?.content], [{ id: v1.proto.id, version: 2 }, v2.proto.content]);
  // 자리 못 찾음(키): 템플릿에 자리가 없는 키 → PROTO_UNBOUND_KEY, 새 판 없음
  const unbound = planBlockUpdate(t, { ...v2.proto, keys: [...v2.proto.keys, "없는 키"] }, v2.blob, k.doc);
  assert.equal(unbound.template, undefined);
  assert.deepEqual(unbound.issues.map((i) => [i.severity, i.code]), [["error", "PROTO_UNBOUND_KEY"]]);
  // 없는 키 2개 → 이슈 2개(키마다 하나). planProtoUpdate는 그대로 첫 키에서 던진다
  const twoMissing = { ...v2.proto, keys: [...v2.proto.keys, "없는 키", "없는 둘째 키"] };
  const unbound2 = planBlockUpdate(t, twoMissing, v2.blob, k.doc);
  assert.equal(unbound2.template, undefined);
  assert.deepEqual(unbound2.issues.map((i) => [i.severity, i.code, i.where]), [["error", "PROTO_UNBOUND_KEY", "blocks.b1"], ["error", "PROTO_UNBOUND_KEY", "blocks.b1"]]);
  assert.ok(unbound2.issues[0]?.message.includes("'없는 키'") && unbound2.issues[1]?.message.includes("'없는 둘째 키'"));
  const thrown = failure(() => planProtoUpdate(t, twoMissing));
  assert.deepEqual([thrown.code, thrown.message, thrown.where], ["PROTO_UNBOUND_KEY", unbound2.issues[0]?.message, "blocks.b1"]);
  // 자리 못 찾음(앵커): 슬롯 범위가 없는 바탕 문서
  const other = reparse(readFixture("hancom/blocks"));
  const lost = planBlockUpdate(t, v2.proto, v2.blob, other);
  assert.deepEqual(lost.issues.map((i) => [i.severity, i.code, i.where]), [["error", "ANCHOR_NOT_FOUND", "slots.s1"]]);
  // 이름 충돌: 블록의 키 '사업명'을 누름틀 자리가 다른 값에 연결
  const raw = JSON.parse(JSON.stringify(t)) as Record<string, any>;
  (raw["places"] as unknown[]).push({ id: "p99", kind: "clickHere", name: "사업명", value: k.valueId("성명") });
  const clash = readStudioTemplate(JSON.stringify(raw)) as StudioTemplate;
  const conflict = planBlockUpdate(clash, v2.proto, v2.blob, k.doc);
  assert.deepEqual(conflict.issues.map((i) => [i.severity, i.code]), [["error", "BLOCK_NAME_CONFLICT"]]);
  assert.ok(conflict.template !== undefined, "충돌을 알려도 새 판 계획은 낸다(저장은 사용자 선택)");
  // 서식 차이: 다른 서식의 블록(D3 문단 1~3)으로 갱신
  const d3 = reparse(readFixture("D3"));
  const foreign = reextractBlock(d3, makeRangeAnchor(d3, 0, [], 1, 3)!, v1.proto, { at: AT });
  const styled = planBlockUpdate(t, foreign.proto, foreign.blob, k.doc);
  assert.deepEqual(styled.issues.map((i) => [i.severity, i.code, i.where]), [["warning", "BLOCK_FORMAT_DIFFERS", "slots.s1"]]);
  assert.deepEqual(styled.formatDiffs.map((f) => [f.block, f.anchor]), [["b1", "a1"]]);
  assert.deepEqual(styled.formatDiffs[0]?.diffs, blockFormatDiffs(k.doc, foreign.fragment, { sectionIndex: 0, parentPath: [], index: 18 }));
  assert.ok(styled.template !== undefined);
  // 입력 항목 사라짐: 직전 판(previous)을 주면 reextractBlock과 같은 판정. 키가 그대로면 경고 없음
  assert.deepEqual(planBlockUpdate(t, v2.proto, v2.blob, k.doc, v1.proto).issues, []);
  const record = recordFor((name) => `값[${name}]`);
  const c = caseOf(t, record, { selections: { s1: manual(t, "s1", "b1"), s2: manual(t, "s2", "b3") } });
  const resultDoc = reparse(outBytes(ok(generateFromTemplate(k.bytes, t, record, c, loaderOf(blobs)))));
  const filled = reextractBlock(resultDoc, makeRangeAnchor(resultDoc, 0, [], 18, 22)!, v1.proto, { at: AT });
  const keysGone = planBlockUpdate(t, filled.proto, filled.blob, k.doc, v1.proto);
  assert.deepEqual(keysGone.issues.map((i) => [i.severity, i.code, i.where]), [["warning", "BLOCK_KEYS_DROPPED", "blocks.b1"]]);
  assert.ok(keysGone.issues[0]?.message.includes("'기관명'·'사업명'"), keysGone.issues[0]?.message);
  assert.ok(keysGone.template !== undefined, "경고만 하고 막지 않는다");
  assert.deepEqual(planBlockUpdate(t, filled.proto, filled.blob, k.doc).issues, [], "직전 판을 주지 않으면 보지 않는다");
});

// ── 무작위 50회: 떼기 → 저장 → 넣기(2판 생성), 결정성·게이트·검사기 새 오류 0 ─────────

test("8.8.17 무작위 50회: 범위(본문·칸·제목)를 떼어 저장·복원 → 자리 41개 템플릿의 슬롯에 넣어 긴 값(0~1,500자)으로 생성 + 다른 문서에 넣기. 같은 입력 같은 바이트, 게이트·검사기 새 오류 0", (t) => {
  const k = kit();
  const next = rng(73);
  const other = readFixture("hancom-merged");
  const otherDoc = reparse(other);
  const otherCount = at(otherDoc.sections, 0).paragraphs.length;
  const pick = (n: number): number => Math.floor(next() * n);
  let runs = 0;
  let filled = 0;
  let blockFields = 0;
  let longest = 0;
  let formatWarnings = 0;
  const kinds: Record<string, number> = {};
  const run = (range: Parameters<typeof extractBlock>[1], record: Record<string, unknown>, index: number) => {
    const block = extractBlock(k.doc, range, meta("k0000d00d", "무작위 블록"));
    const stored = roundTrip(block);
    const { t, blobs } = templateWith(k, { ...block, proto: stored.proto, blob: stored.blob });
    const c = caseOf(t, record, { selections: { s1: manual(t, "s1", "b1"), s2: manual(t, "s2", "b3") } });
    const r = ok(generateFromTemplate(k.bytes, t, record, c, loaderOf(blobs)));
    const point = { sectionIndex: 0, parentPath: [], index, position: "after" as const };
    const plan = planBlockInsert(otherDoc, stored.proto, stored.blob, point);
    const placed = applyPlan(otherDoc.pkg, plan);
    return { block, r, plan, placed, json: writeBlockProto(stored.proto) };
  };
  while (runs < 50) {
    const kind = ["heading", "body", "cell"][pick(3)] ?? "body";
    let range;
    if (kind === "heading") range = makeHeadingRangeAnchor(k.doc, 0, [], at(HEADINGS, pick(HEADINGS.length)));
    else if (kind === "cell") {
      const from = pick(6);
      range = makeRangeAnchor(k.doc, 0, [12, 1], from, from + pick(6 - from));
    } else {
      const from = 1 + pick(60);
      range = makeRangeAnchor(k.doc, 0, [], from, Math.min(62, from + pick(8)));
    }
    assert.ok(range !== undefined);
    const record = recordFor(randomText(next), { price: pick(2) === 0 ? 1234 : 60000000, sme: pick(2) === 0 ? "Y" : "N" });
    for (const v of Object.values(record)) if (typeof v === "string") longest = Math.max(longest, v.length);
    const index = pick(otherCount);
    const a = run(range, record, index);
    const b = run(range, record, index);
    // 결정성: 원형 JSON·덩어리·생성 결과·넣기 결과가 바이트까지 같다
    assert.equal(a.json, b.json);
    assert.ok(bytesEqual(a.block.blob, b.block.blob));
    assert.ok(bytesEqual(outBytes(a.r), outBytes(b.r)));
    assert.ok(bytesEqual(a.placed, b.placed));
    // 게이트·검사기 새 오류 0
    assert.deepEqual(a.r.report.validation?.newErrors.map((v) => v.code), [], `${runs}: 게이트`);
    assert.deepEqual(newErrorsAfter(validateDocument(k.bytes), validateDocument(outBytes(a.r))).map((v) => v.code), [], `${runs}: 생성 검사기`);
    assert.deepEqual(newErrorsAfter(validateDocument(other), validateDocument(a.placed)).map((v) => v.code), [], `${runs}: 넣기 검사기`);
    // 넣은 글은 블록의 글 그대로(최상위 문단 글과 안쪽 문단 글 모두)
    const placedDoc = reparse(a.placed);
    const top = parseFragmentXml(a.block.fragment).paragraphs;
    const inserted = at(placedDoc.sections, 0).paragraphs.slice(index + 1, index + 1 + top.length);
    assert.deepEqual(inserted.map((p) => p.logicalText), top.map((p) => p.logicalText));
    assert.deepEqual([...walkParagraphs(inserted)].map((p) => p.logicalText), a.block.fragment.texts);
    filled += a.r.report.stage2?.plan.actions.length ?? 0;
    blockFields += a.block.fragment.census.fields;
    if (a.plan.formatDiffs.length > 0) formatWarnings++;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    runs++;
  }
  t.diagnostic(`실행 ${runs}회(${JSON.stringify(kinds)}), 2단계 채움 액션 ${filled}, 블록 안 필드 ${blockFields}, 가장 긴 값 ${longest}자, 다른 문서 넣기 서식 경고 ${formatWarnings}회`);
  assert.ok(filled >= 50 * 30, `채운 자리 ${filled}`);
  assert.ok(blockFields > 0 && longest >= 1000, `블록 안 필드 ${blockFields}, 가장 긴 값 ${longest}`);
  assert.ok(Object.keys(kinds).length === 3, JSON.stringify(kinds));
  assert.ok(formatWarnings > 0, "다른 문서에 넣으면 서식 차이 경고가 나는 경우가 있다");
});
