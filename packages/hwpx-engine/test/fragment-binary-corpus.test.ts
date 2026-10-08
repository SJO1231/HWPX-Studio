// 조각 가져오기 이진 자료 새 항목 id(#157, 엔진 명세 7.5 단계 6)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글은 기록하지 않는다: 진단에는 내용 sha256 앞 10자와 수량만 남긴다. 결과 파일을 쓰지 않는다(모두 메모리).
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/fragment-binary-corpus.test.ts
// 실제 공고서에는 그림이 없어(이진 항목 0) 시험 자료의 그림 문단을 원본 공고서의 무작위 자리에 넣은 사본에서 그 그림을 품은 무작위 범위를 떼어 다른 공고서에 넣는다.
// 대상은 무작위로 준비한다: 같은 id에 내용이 다른 그림을 먼저 넣기(새 id가 필요해진다), 없는 이진 자료를 가리키는 그림을 대상에 넣기(대상 쪽),
// 원본 범위에 넣기(조각 쪽). 넣는 없는 참조의 id는 없는 참조가 없을 때 그 대상이 그 그림에 줄 새 id다(고치기 전 코드의 배정).
// 시행마다 (1) 같은 입력(다시 읽은 대상, JSON 왕복 조각)이면 같은 바이트, (2) 검사기 새 오류 0(조각이 원본에서부터 가진 없는 참조로 설명되는 것은
// 저장 게이트와 같은 판정으로 뺀다), (3) 같은 조각을 결과에 다시 넣으면 그림은 모두 재사용. 끝에서 (4) 새 항목이 없는 참조의 id나 대상 manifest 항목의 이름을 차지한 것 0.
// 없는 이진 자료 참조가 어느 쪽에도 없는 시행의 결과 바이트 요약(sha256 앞 10자)을 진단에 남긴다(고치기 전 코드의 같은 요약과 비교한다).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sameSnapshot, scanCorpus, snapshotOf, readCorpusFile } from "../../../tools/stress/corpus.ts";
import {
  HwpxError,
  applyPlan,
  extractFragment,
  openPackage,
  parseDocument,
  parseFragment,
  planImport,
  readEntry,
  rewriteArchive,
  serializeFragment,
  validateDocument,
  type Fragment,
  type HwpxDocument,
  type InsertPoint,
} from "../src/index.ts";
import { explainInherited } from "../src/fill/index.ts";
import { resourceRefs } from "../src/fragment/resources.ts";
import { bytesEqual, newErrorsAfter, readFixture, utf8 } from "./helpers.ts";
import { at, rng } from "./range-helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;
const TRIALS = 50;

const sha10 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 10);
const open = (b: Uint8Array): HwpxDocument => parseDocument(openPackage(b));
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

// 시험 자료의 그림 문단: 구역 0 최상위 문단 번호, 그 그림의 이진 항목 id와 이름
const PICTURES = [
  { fixture: "hancom/picture", index: 1, id: "image1", href: "BinData/image1.png" },
  { fixture: "extra/features-picture", index: 14, id: "BIN0001", href: "BinData/BIN0001.png" },
] as const;
type Picture = (typeof PICTURES)[number];

/** 시험 자료 사본(메모리)에서 그림 문단 조각을 뗀다. 그림 내용 끝에 바이트를 더하거나(같은 id, 다른 내용), manifest 항목 id를 바꾸고 그림이 `danglingRef`를 가리키게 한다(없는 참조). */
function pictureFragment(pic: Picture, change: { alterContent?: true; danglingRef?: string } = {}): Fragment {
  const bytes = readFixture(pic.fixture);
  const doc = open(bytes);
  const replace = new Map<string, Uint8Array>();
  if (change.alterContent === true) replace.set(pic.href, new Uint8Array([...readEntry(doc.pkg.archive, bytes, pic.href), 1, 2, 3]));
  if (change.danglingRef !== undefined) {
    const hpf = decode(readEntry(doc.pkg.archive, bytes, doc.pkg.rootfile));
    assert.equal(hpf.split(`id="${pic.id}"`).length, 2);
    replace.set(doc.pkg.rootfile, utf8(hpf.replace(`id="${pic.id}"`, `id="unreferenced-picture"`)));
    const section = at(doc.sections, 0);
    assert.equal(section.text.split(`binaryItemIDRef="${pic.id}"`).length, 2);
    replace.set(section.entryName, utf8(section.text.replace(`binaryItemIDRef="${pic.id}"`, `binaryItemIDRef="${change.danglingRef}"`)));
  }
  const src = replace.size === 0 ? doc : open(rewriteArchive(bytes, doc.pkg.archive, { replace }));
  return extractFragment(src, { sectionIndex: 0, parentPath: [], from: pic.index, to: pic.index });
}

const after = (index: number): InsertPoint => ({ sectionIndex: 0, parentPath: [], index, position: "after" });
const anyPoint = (doc: HwpxDocument, r: () => number): InsertPoint => after(Math.floor(r() * at(doc.sections, 0).paragraphs.length));
const importInto = (doc: HwpxDocument, fragment: Fragment, point: InsertPoint): HwpxDocument => open(applyPlan(doc.pkg, planImport(doc, fragment, point)));

/** 문서 본문·header가 가리키는데 manifest에 없는 이진 자료 id */
function danglingBinaryIds(doc: HwpxDocument): Set<string> {
  const known = new Set(doc.pkg.manifestItems.map((m) => m.id));
  const refs = [
    ...Object.values(doc.header.resources).flatMap((items) => items.flatMap((item) => resourceRefs(item).filter((x) => x.kind === "binaryItem").map((x) => x.id))),
    ...doc.sections.flatMap((s) => s.bodyRefs.filter((x) => x.kind === "binaryItem" && x.id !== "").map((x) => x.id)),
  ];
  return new Set(refs.filter((id) => !known.has(id)));
}

/** 그 대상이 그 그림에 줄 새 항목 id(재사용이면 undefined). 없는 참조가 없는 대상에서 부르면 고치기 전 코드와 같은 배정이다 */
function newItemIdFor(doc: HwpxDocument, fragment: Fragment): string | undefined {
  const edit = planImport(doc, fragment, after(0)).edits.find((e) => e.reason === "manifest에 이진 자료 항목 등록");
  return edit === undefined ? undefined : /\bid="([^"]*)"/.exec(edit.replacement)?.[1];
}

test("7.5-6 실제 공고서: 그림 든 조각 이식 무작위 50회(대상·조각에 다음 새 항목 id를 가리키는 없는 이진 자료 참조를 넣음) — 결정성, 검사기 새 오류 0, 재사용, 겹침 0(#157)", { skip: SKIP }, (t) => {
  assert.ok(typeof DIR === "string");
  const files = scanCorpus(DIR).filter((f) => f.size <= MAX_BYTES);
  const before = snapshotOf(scanCorpus(DIR));
  const docs = files.flatMap((f) => {
    const bytes = readCorpusFile(f);
    try {
      const doc = open(bytes);
      const pictures = doc.pkg.manifestItems.filter((m) => m.href.startsWith("BinData/")).length;
      return doc.sections[0] !== undefined && doc.sections[0].paragraphs.length > 3 ? [{ id: sha10(bytes), bytes, pictures }] : [];
    } catch {
      return [];
    }
  });
  const r = rng(157);
  const pick = <T,>(xs: readonly T[]): T => at(xs, Math.floor(r() * xs.length));
  const tally = {
    trials: 0, skippedRanges: 0, corpusPictures: docs.reduce((n, d) => n + d.pictures, 0), paragraphs: 0, pictures: 0,
    altTarget: 0, targetInjected: 0, fragmentInjected: 0, addedBinaries: 0, reusedBinaries: 0, reuseAgain: 0, explainedErrors: 0,
    captured: 0, capturedNames: 0, clean: 0,
  };
  const captured: string[] = [];
  const cleanDigest = createHash("sha256");
  const started = Date.now();
  while (tally.trials < TRIALS) {
    const src = pick(docs);
    const tgt = pick(docs);
    const pic = pick(PICTURES);
    const plain = pictureFragment(pic);
    // 대상 준비: 절반은 같은 id에 내용이 다른 그림을 먼저 넣는다
    let target = open(tgt.bytes);
    const alt = r() < 0.5;
    if (alt) target = importInto(target, pictureFragment(pic, { alterContent: true }), anyPoint(target, r));
    // 없는 참조가 없을 때의 배정(고치기 전 코드와 같다)
    const next = newItemIdFor(target, plain);
    assert.ok(next !== undefined, "내용이 다른 그림만 있으므로 새 항목이 필요하다");
    // 원본: 공고서의 무작위 자리 뒤에 그림 문단을 넣는다(q). 조각 쪽 없는 참조는 그 뒤에 넣는다(원본 manifest에 없는 id일 때만)
    const a0 = open(src.bytes);
    const q = 1 + Math.floor(r() * at(a0.sections, 0).paragraphs.length);
    let srcDoc = importInto(a0, plain, after(q - 1));
    const injectFragment = r() < 0.5 && !srcDoc.pkg.manifestItems.some((m) => m.id === next);
    if (injectFragment) srcDoc = importInto(srcDoc, pictureFragment(pic, { danglingRef: next }), after(q));
    // 대상 쪽 없는 참조
    const injectTarget = r() < 0.5;
    if (injectTarget) target = importInto(target, pictureFragment(pic, { danglingRef: next }), anyPoint(target, r));
    const targetBytes = target.pkg.bytes;
    // 그림 문단(들)을 품은 무작위 범위
    const n = at(srcDoc.sections, 0).paragraphs.length;
    const last = injectFragment ? q + 1 : q;
    const from = Math.max(1, q - Math.floor(r() * 11));
    const to = Math.min(n - 1, last + Math.floor(r() * 11));
    let fragment: Fragment;
    try {
      fragment = extractFragment(srcDoc, { sectionIndex: 0, parentPath: [], from, to });
    } catch (e) {
      if (e instanceof HwpxError && (e.code === "FRAG_SECTION_PROPS" || e.code === "FRAG_SPLITS_FIELD")) {
        tally.skippedRanges++;
        continue;
      }
      throw e;
    }
    const label = `시행 ${tally.trials}(${src.id}[${from}~${to}] 그림 ${pic.id}${injectFragment ? ` 조각 쪽 ${next}` : ""} → ${tgt.id}${alt ? " 다른 내용" : ""}${injectTarget ? ` 대상 쪽 ${next}` : ""})`;
    assert.equal(fragment.binaries.length, 1, `${label}: 조각의 그림`);
    assert.equal(fragment.dangling.some((d) => d.kind === "binaryItem"), injectFragment, `${label}: 조각 쪽 없는 참조`);
    assert.equal(danglingBinaryIds(target).has(next), injectTarget, `${label}: 대상 쪽 없는 참조`);
    const point = anyPoint(target, r);
    const plan = planImport(target, fragment, point);
    const out = applyPlan(target.pkg, plan);
    const result = open(out);
    // (1) 결정성: 다시 읽은 대상·JSON 왕복 조각으로 같은 바이트
    const again = open(targetBytes);
    assert.ok(bytesEqual(applyPlan(again.pkg, planImport(again, parseFragment(serializeFragment(fragment)), point)), out), `${label}: 같은 입력 같은 바이트`);
    // (2) 검사기 새 오류 0(저장 게이트와 같은 판정)
    const baseline = validateDocument(targetBytes);
    const explained = explainInherited(newErrorsAfter(baseline, validateDocument(out)), plan.inherited, baseline.errors);
    assert.deepEqual(explained.unexplained.map((i) => `${i.code} ${i.message}`), [], `${label}: 새 오류`);
    // (3) 같은 조각을 결과에 다시 넣으면 그림은 모두 재사용된다
    const second = planImport(result, fragment, point);
    assert.deepEqual([second.summary["addedBinaries"], second.summary["reusedBinaries"], second.additions.length], [0, fragment.binaries.length, 0], `${label}: 다시 넣기`);
    // (4) 겹침: 새 항목이 없는 참조(조각·대상)의 id나 대상 manifest 항목의 이름을 차지했는가(끝에서 0을 확인한다)
    const carried = new Set([...danglingBinaryIds(target), ...fragment.dangling.flatMap((d) => (d.kind === "binaryItem" ? [d.id] : []))]);
    const known = new Set(target.pkg.manifestItems.map((m) => m.id));
    const hrefs = new Set(target.pkg.manifestItems.map((m) => m.href.toLowerCase()));
    const added = result.pkg.manifestItems.filter((m) => !known.has(m.id));
    const hit = added.filter((m) => carried.has(m.id)).map((m) => m.id);
    if (hit.length > 0) captured.push(`${label}: ${hit.join(",")}`);
    tally.captured += hit.length;
    tally.capturedNames += added.filter((m) => hrefs.has(m.href.toLowerCase())).length;
    if (carried.size === 0) {
      cleanDigest.update(out);
      tally.clean++;
    }
    tally.paragraphs += fragment.census.paragraphs;
    tally.pictures += fragment.census.pictures;
    tally.altTarget += alt ? 1 : 0;
    tally.targetInjected += injectTarget ? 1 : 0;
    tally.fragmentInjected += injectFragment ? 1 : 0;
    tally.addedBinaries += plan.summary["addedBinaries"] ?? 0;
    tally.reusedBinaries += plan.summary["reusedBinaries"] ?? 0;
    tally.reuseAgain += second.summary["reusedBinaries"] ?? 0;
    tally.explainedErrors += explained.explained.length;
    tally.trials++;
  }
  const afterSnapshot = snapshotOf(scanCorpus(DIR));
  t.diagnostic(`문서 ${docs.length}건, ${JSON.stringify(tally)}, 없는 참조가 없는 시행 결과 요약 ${cleanDigest.digest("hex").slice(0, 10)}, ${Date.now() - started}ms, 문서 모음 그대로 ${sameSnapshot(before, afterSnapshot)}`);
  for (const c of captured) t.diagnostic(`겹침 ${c}`);
  assert.ok(docs.length >= 10, `읽은 문서 ${docs.length}건`);
  assert.ok(tally.targetInjected > 0 && tally.fragmentInjected > 0 && tally.clean > 0, "대상 쪽·조각 쪽 없는 참조를 넣은 시행과 없는 참조가 없는 시행이 모두 들어 있다");
  assert.deepEqual(captured, [], "새 항목이 없는 참조의 id를 차지하지 않는다");
  assert.equal(tally.capturedNames, 0, "새 항목이 대상 manifest 항목의 이름을 차지하지 않는다");
  assert.ok(sameSnapshot(before, afterSnapshot), "읽기 전용: 문서 모음이 바뀌지 않았다");
});
