// 조각 가져오기 새 id 배정(#115, 엔진 명세 7.5)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글은 기록하지 않는다: 진단에는 내용 sha256 앞 10자와 수량만 남긴다. 결과 파일을 쓰지 않는다(모두 메모리).
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/fragment-dangling-corpus.test.ts
// 무작위 50회: 원본 문서·최상위 문단 범위, 대상 문서·삽입 지점을 고른다. 절반은 범위 안 문단 1~3개의 문단 모양·스타일 참조를
// 원본에 없는 대상의 다음 새 id(또는 그다음 id)로 바꾼 사본(메모리)에서 뗀다(조각이 원본에서부터 없는 자원을 가리키는 경우).
// 시행마다 (1) 같은 입력(다시 읽은 대상, JSON 왕복 조각)이면 같은 바이트, (2) 검사기 새 오류 0(조각이 원본에서부터 가진 없는 참조로 설명되는 것은
// 저장 게이트와 같은 판정으로 뺀다), (3) 조각의 없는 참조 id를 새 자원이 받은 것 0, (4) 없는 참조 기록을 비운 조각(이전 형식 조각, 고치기 전과 같은 id 배정)의
// 결과와 바이트가 다른 것은 그 배정이 겹칠 때뿐이다(참조가 모두 있는 조각은 결과가 같다).
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
  rewriteArchive,
  serializeFragment,
  validateDocument,
  type Fragment,
  type HwpxDocument,
} from "../src/index.ts";
import { explainInherited } from "../src/fill/index.ts";
import { readXmlVersion } from "../src/package/format-version.ts";
import { bytesEqual, newErrorsAfter, utf8 } from "./helpers.ts";
import { at, rng } from "./range-helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;
const TRIALS = 50;

const sha10 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 10);
const open = (b: Uint8Array): HwpxDocument => parseDocument(openPackage(b));
const maxId = (doc: HwpxDocument, kind: string): number => Math.max(-1, ...(doc.header.resources[kind] ?? []).map((r) => Number(r.id)).filter(Number.isInteger));
const hasId = (doc: HwpxDocument, kind: string, id: string): boolean => (doc.header.resources[kind] ?? []).some((r) => r.id === id);

type Edit = [paragraph: number, attr: "paraPrIDRef" | "styleIDRef", value: string];

/** 구역 0 최상위 문단들의 문단 모양·스타일 참조를 바꾼 사본(메모리. 문서 모음에는 쓰지 않는다) */
function withRefs(bytes: Uint8Array, edits: readonly Edit[]): Uint8Array {
  const doc = open(bytes);
  const s = at(doc.sections, 0);
  let text = s.text;
  for (const [i, attr, value] of [...edits].sort((a, b) => b[0] - a[0])) {
    const el = at(s.paragraphs, i).element;
    const tag = text.slice(el.start, el.openEnd);
    const next = tag.replace(new RegExp(`\\b${attr}="[^"]*"`), `${attr}="${value}"`);
    assert.notEqual(next, tag, `문단 ${i}에 ${attr}가 없다`);
    text = text.slice(0, el.start) + next + text.slice(el.openEnd);
  }
  return rewriteArchive(bytes, doc.pkg.archive, { replace: new Map([[s.entryName, utf8(text)]]) });
}

/** 조각의 없는 참조(종류, id) 가운데 대상에 없던 그 id의 자원이 결과에 생긴 것. 글꼴은 조각 기록에 언어가 없어 어느 언어든 센다 */
function carriedOverlaps(fragment: Fragment, target: HwpxDocument, result: HwpxDocument): string[] {
  const keys = (doc: HwpxDocument, kind: string): Set<string> => new Set((doc.header.resources[kind] ?? []).map((x) => `${x.lang ?? ""}|${x.id}`));
  return fragment.dangling
    .filter((d) => {
      const before = keys(target, d.kind);
      return [...keys(result, d.kind)].some((k) => k.endsWith(`|${d.id}`) && !before.has(k));
    })
    .map((d) => `${d.kind} ${d.id}`);
}

test("7.5 실제 공고서: 조각 이식 무작위 50회(절반은 대상의 다음 새 id를 가리키는 없는 참조를 넣음) — 결정성, 검사기 새 오류 0, 겹침 0, 겹치지 않는 조각은 결과 불변(#115)", { skip: SKIP }, (t) => {
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
  const r = rng(115);
  const pick = <T,>(xs: readonly T[]): T => at(xs, Math.floor(r() * xs.length));
  const tally = { trials: 0, skippedRanges: 0, sameVersion: 0, injected: 0, injectedRefs: 0, withDangling: 0, addedResources: 0, explainedErrors: 0, overlapsBefore: 0, overlapIdsBefore: 0, changed: 0, unchanged: 0 };
  const started = Date.now();
  while (tally.trials < TRIALS) {
    const src = pick(docs);
    const target = pick(docs);
    const targetDoc = open(target.bytes);
    const src0 = open(src.bytes);
    const n = at(src0.sections, 0).paragraphs.length;
    const from = 1 + Math.floor(r() * (n - 2));
    const to = Math.min(n - 1, from + Math.floor(r() * 30));
    // 절반: 범위 안 문단 1~3개가 원본에 없는 대상의 다음 새 id(또는 그다음)를 가리키게 한다
    const edits: Edit[] = [];
    if (r() < 0.5) {
      const want = 1 + Math.floor(r() * 3);
      for (let k = 0; k < want; k++) {
        const i = from + Math.floor(r() * (to - from + 1));
        const [kind, attr] = r() < 0.5 ? (["paraPr", "paraPrIDRef"] as const) : (["style", "styleIDRef"] as const);
        const id = String(maxId(targetDoc, kind) + 1 + (r() < 0.3 ? 1 : 0));
        if (hasId(src0, kind, id) || edits.some((e) => e[0] === i && e[1] === attr)) continue;
        if (at(src0.sections, 0).paragraphs[i]?.attrs[attr] === null) continue;
        edits.push([i, attr, id]);
      }
    }
    const srcDoc = edits.length === 0 ? src0 : open(withRefs(src.bytes, edits));
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
    const label = `시행 ${tally.trials}(${src.id}[${from}~${to}]${edits.length > 0 ? ` 없는 참조 ${edits.length}` : ""} → ${target.id})`;
    const index = Math.floor(r() * at(targetDoc.sections, 0).paragraphs.length);
    const point = { sectionIndex: 0, parentPath: [], index, position: "after" as const };
    const plan = planImport(targetDoc, fragment, point);
    const out = applyPlan(targetDoc.pkg, plan);
    const result = open(out);
    // (1) 결정성: 다시 읽은 대상·JSON 왕복 조각으로 같은 바이트
    const again = open(target.bytes);
    assert.ok(bytesEqual(applyPlan(again.pkg, planImport(again, parseFragment(serializeFragment(fragment)), point)), out), `${label}: 같은 입력 같은 바이트`);
    // (2) 검사기 새 오류 0(저장 게이트와 같은 판정: 기준선의 관용 경고가 오른 것과 조각이 원본에서부터 가진 문제로 설명되는 것은 뺀다)
    const baseline = validateDocument(target.bytes);
    const explained = explainInherited(newErrorsAfter(baseline, validateDocument(out)), plan.inherited, baseline.errors);
    assert.deepEqual(explained.unexplained.map((i) => `${i.code} ${i.message}`), [], `${label}: 새 오류`);
    // (3) 겹침 0: 조각의 없는 참조 id를 새 자원이 받지 않는다
    assert.deepEqual(carriedOverlaps(fragment, targetDoc, result), [], `${label}: 겹침`);
    // (4) 없는 참조 기록을 비운 조각(고치기 전과 같은 id 배정)과 바이트가 다른 것은 그 배정이 겹칠 때뿐이다
    const legacyOut = applyPlan(targetDoc.pkg, planImport(targetDoc, { ...fragment, dangling: [] }, point));
    const legacyOverlaps = carriedOverlaps(fragment, targetDoc, open(legacyOut));
    const same = bytesEqual(out, legacyOut);
    assert.equal(same, legacyOverlaps.length === 0, `${label}: 기록을 비운 결과와 같음 ${same}, 그 결과의 겹침 ${legacyOverlaps.join(",")}`);
    if (fragment.dangling.length === 0) assert.ok(same, `${label}: 참조가 모두 있는 조각은 결과 불변`);
    if (fragment.source.xmlVersion === readXmlVersion(targetDoc.pkg)) tally.sameVersion++;
    tally.injected += edits.length > 0 ? 1 : 0;
    tally.injectedRefs += edits.length;
    tally.withDangling += fragment.dangling.length > 0 ? 1 : 0;
    tally.addedResources += plan.summary["addedResources"] ?? 0;
    tally.explainedErrors += explained.explained.length;
    tally.overlapsBefore += legacyOverlaps.length > 0 ? 1 : 0;
    tally.overlapIdsBefore += legacyOverlaps.length;
    tally[same ? "unchanged" : "changed"]++;
    tally.trials++;
  }
  const after = snapshotOf(scanCorpus(DIR));
  t.diagnostic(`문서 ${docs.length}건, ${JSON.stringify(tally)}, ${Date.now() - started}ms, 문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(docs.length >= 10, `읽은 문서 ${docs.length}건`);
  assert.ok(tally.injected > 0 && tally.overlapsBefore > 0, "고치기 전 배정이면 겹치는 시행이 들어 있다");
  assert.ok(tally.unchanged > 0, "결과가 같은 시행이 들어 있다");
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
});
