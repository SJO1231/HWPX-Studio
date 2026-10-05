// 조각 단위 변환(7.66, #69 ②)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글은 기록하지 않는다: 진단에는 내용 sha256 앞 10자와 수량만 남긴다. 결과 파일을 쓰지 않는다(모두 메모리).
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/fragment-units-corpus.test.ts
// 무작위 50회: 원본 문서·최상위 문단 범위, 대상 문서(그대로 또는 메모리에서 version.xml만 1.2로 바꾼 사본)·삽입 지점을 고르고
// (1) 같은 입력(조각 JSON 왕복 포함)이면 같은 바이트, (2) 검사기 새 오류 0, (3) 형식이 갈리면 변환·FRAG_UNIT_CONVERTED, 같으면 변환 없음,
// (4) 대상이 1.2이면 결과의 HwpUnitChar 스위치 수가 대상 것 그대로, (5) 가져온 문단(표 칸 포함)마다 한컴이 보여 줄 값이 원본과 같음
// (한컴 저장본의 default가 case의 2배에서 1 어긋난 곳은 1 차이로 세어 보고), (6) 같은 조각을 다시 넣으면 추가 자원 0.
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
  walkElements,
  type Fragment,
  type HwpxDocument,
} from "../src/index.ts";
import { bytesEqual, newErrorsAfter } from "./helpers.ts";
import { assertShownSame, isUnitSwitch, top } from "./units-helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;
const TRIALS = 50;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const sha10 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 10);
const open = (b: Uint8Array): HwpxDocument => parseDocument(openPackage(b));
const unitSwitches = (doc: HwpxDocument): number => [...walkElements(doc.header.root)].filter(isUnitSwitch).length;

/** 메모리에서 version.xml의 xmlVersion만 바꾼 사본(대상 형식 1.2를 만들려는 것. 문서 모음에는 쓰지 않는다) */
function withXmlVersion(bytes: Uint8Array, version: string): Uint8Array {
  const pkg = openPackage(bytes);
  const text = new TextDecoder().decode(readEntry(pkg.archive, bytes, "version.xml"));
  const next = text.replace(/xmlVersion="[^"]*"/, `xmlVersion="${version}"`);
  assert.notEqual(next, text);
  return rewriteArchive(bytes, pkg.archive, { replace: new Map([["version.xml", new TextEncoder().encode(next)]]) });
}

test("7.66 실제 공고서: 조각 이식 무작위 50회(대상 1.5·1.2) — 결정성, 검사기 새 오류 0, 변환·경고, 한컴이 보여 줄 값, 재사용", { skip: SKIP }, (t) => {
  assert.ok(typeof DIR === "string");
  const files = scanCorpus(DIR).filter((f) => f.size <= MAX_BYTES);
  const before = snapshotOf(scanCorpus(DIR));
  const docs = files.flatMap((f) => {
    const bytes = readCorpusFile(f);
    try {
      const doc = open(bytes);
      return doc.sections[0] !== undefined && doc.sections[0].paragraphs.length > 3 ? [{ id: sha10(bytes), bytes }] : [];
    } catch {
      return [];
    }
  });
  const r = rng(6902);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const tally = { trials: 0, skippedRanges: 0, toLegacy: 0, sameFormat: 0, convertedWarnings: 0, convertedResources: 0, addedResources: 0, compared: 0, roundingSlack: 0, paragraphs: 0 };
  const started = Date.now();
  while (tally.trials < TRIALS) {
    const src = pick(docs);
    const target = pick(docs);
    const legacy = r() < 0.5;
    const srcDoc = open(src.bytes);
    const n = srcDoc.sections[0]?.paragraphs.length ?? 0;
    const from = 1 + Math.floor(r() * (n - 2));
    const to = Math.min(n - 1, from + Math.floor(r() * 30));
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
    const label = `시행 ${tally.trials}(${src.id}[${from}~${to}] → ${target.id}${legacy ? " 1.2" : ""})`;
    const targetBytes = legacy ? withXmlVersion(target.bytes, "1.2") : target.bytes;
    const targetDoc = open(targetBytes);
    const index = Math.floor(r() * (targetDoc.sections[0]?.paragraphs.length ?? 1));
    const at = { sectionIndex: 0, parentPath: [], index, position: "after" as const };
    const plan = planImport(targetDoc, fragment, at);
    const out = applyPlan(targetDoc.pkg, plan);
    // (1) 결정성: 다시 읽은 대상·JSON 왕복 조각으로 같은 바이트
    const again = open(targetBytes);
    assert.ok(bytesEqual(applyPlan(again.pkg, planImport(again, parseFragment(serializeFragment(fragment)), at)), out), `${label}: 같은 입력 같은 바이트`);
    // (2) 검사기 새 오류 0
    assert.deepEqual(newErrorsAfter(validateDocument(targetBytes), validateDocument(out)).map((i) => i.code), [], label);
    // (3) 변환·경고
    const codes = plan.issues.map((i) => i.code);
    const converted = plan.summary["convertedResources"] ?? 0;
    assert.equal(fragment.source.xmlVersion, "1.5", `${label}: 원본 형식`);
    if (legacy) {
      assert.ok(converted > 0, `${label}: 1.5 → 1.2 변환`);
      assert.equal(codes.filter((c) => c === "FRAG_UNIT_CONVERTED").length, 1, label);
      tally.toLegacy++;
    } else {
      assert.equal(converted, 0, label);
      tally.sameFormat++;
    }
    assert.ok(!codes.includes("FRAG_FORMAT_UNKNOWN"), label);
    // (4) 1.2 대상에는 스위치가 늘지 않는다
    const result = open(out);
    if (legacy) assert.equal(unitSwitches(result), unitSwitches(targetDoc), `${label}: HwpUnitChar 스위치 수`);
    // (5) 한컴이 보여 줄 값
    const count = to - from + 1;
    const shown = assertShownSame(srcDoc, top(srcDoc, from, count), true, result, top(result, index + 1, count), !legacy, label, true);
    tally.compared += shown.compared;
    tally.roundingSlack += shown.slack;
    tally.paragraphs += top(srcDoc, from, count).length;
    // (6) 다시 넣으면 전부 재사용
    const second = planImport(result, fragment, { ...at, index: 0 });
    assert.equal(second.summary["addedResources"], 0, `${label}: 두 번째 추가 자원`);
    tally.convertedWarnings += codes.filter((c) => c === "FRAG_UNIT_CONVERTED").length;
    tally.convertedResources += converted;
    tally.addedResources += plan.summary["addedResources"] ?? 0;
    tally.trials++;
  }
  const after = snapshotOf(scanCorpus(DIR));
  t.diagnostic(`문서 ${docs.length}건, ${JSON.stringify(tally)}, ${Date.now() - started}ms, 문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(docs.length >= 10, `읽은 문서 ${docs.length}건`);
  assert.ok(tally.toLegacy > 0 && tally.sameFormat > 0, "두 대상 형식 모두 시험");
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
});
