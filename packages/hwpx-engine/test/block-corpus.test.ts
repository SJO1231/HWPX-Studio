// 블록 저장소 API(엔진 명세 8.8.17, #73)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글은 기록하지 않는다: 진단에는 경로 해시 앞 10자, 오류 코드, 수량만 남긴다. 블록 저장소는 OS 임시 폴더에 만들고 끝나면 그 폴더만 지운다.
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/block-corpus.test.ts
// 문서마다 제목 범위 2곳을 블록으로 떼어(extractBlock) 임시 저장소(blocks/<id>/block.json + <sha256>.json)에 쓰고 다시 읽어, 다음 문서의 제목 범위 자리에 넣는다:
// (1) planBlockInsert(그 제목 앞) → applyPlan → 검사기 새 오류 0. 서식 차이는 독립 계산(fingerprintResource)과 같고, 블록 문단을 제자리와 견주면 차이 0. 경고 수를 센다,
// (2) 같은 블록으로 그 제목 범위를 교체(inject replace, 저장 게이트) → 성공·게이트 새 오류 0·검사기 새 오류 0, 같은 입력 두 번 같은 바이트,
// (3) 교체 결과에서 넣은 구간을 다시 떼어 2판(reextractBlock: 판 2·출처 = 결과 해시·기록 2줄) → 그 2판을 세 번째 문서에 넣어 검사기 새 오류 0.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sameSnapshot, scanCorpus, snapshotOf } from "../../../tools/stress/corpus.ts";
import { applyPlan, fingerprintResource, makeLookup, openPackage, parseDocument, validateDocument, type HwpxDocument } from "../src/index.ts";
import { blockFormatDiffs, detectHeadings, extractBlock, generate, headingRangeOf, makeHeadingRangeAnchor, makeRangeAnchor, planBlockInsert, reextractBlock, type Heading } from "../src/fill/index.ts";
import { hasSecPr } from "../src/fill/doc.ts";
import { parseFragmentXml } from "../src/fill/fragment-fill.ts";
import { listAtParent, splitsField } from "../src/fill/range.ts";
import { readBlockProto, readDataset, sha256Hex, writeBlockProto, type BlockProto, type Template } from "../src/template/index.ts";
import { bytesEqual, newErrorsAfter } from "./helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;
const PER_DOC = 2;
const AT = "2026-10-06T00:00:00Z";
const EMPTY = readDataset({});

type Doc = { id: string; bytes: Uint8Array; doc: HwpxDocument };
type Span = { heading: Heading; from: number; to: number };

function open(id: string, bytes: Uint8Array): Doc | undefined {
  try {
    return { id, bytes, doc: parseDocument(openPackage(bytes)) };
  } catch {
    return undefined;
  }
}

/** 최상위 제목 범위 가운데 뗄 수 있는 것: 문단 1 이상, 구역 설정 없음, 누름틀 짝을 자르지 않음, 문단 40개 이하 */
function spans(d: HwpxDocument): Span[] {
  return detectHeadings(d).flatMap((h): Span[] => {
    if (h.at.parentPath.length > 0) return [];
    const r = headingRangeOf(d, h.at, h.index);
    const section = d.sections[h.at.sectionIndex];
    const list = section === undefined ? undefined : listAtParent(section, h.at.parentPath);
    if (r === undefined || list === undefined || r.from < 1 || r.to - r.from >= 40) return [];
    const ps = list.slice(r.from, r.to + 1);
    return ps.some(hasSecPr) || splitsField(ps) !== undefined ? [] : [{ heading: h, from: r.from, to: r.to }];
  });
}

/** 독립 계산용: 문서의 자원 지문(7.4 `fingerprintResource`). 참조 없음은 none, 없는 자원은 missing */
function printOf(doc: HwpxDocument, kind: string, id: string | null): string {
  if (id === null) return "none";
  const lookup = makeLookup(doc);
  const item = lookup.resource(kind, undefined, id);
  return item === undefined ? `missing:${id}` : fingerprintResource(item, lookup);
}

const tpl = (anchors: unknown[], rules: unknown[]): Template => ({ schema: "hwpx-studio/template@1", anchors, rules, options: { missing: "keep" } }) as Template;

test("8.8.17 실제 공고서: 제목 범위 떼기 → 임시 저장소 왕복 → 다른 공고서에 넣기(계획·게이트 교체)·다시 떼어 2판 → 셋째 공고서에 넣기. 검사기 새 오류 0, 결정성", { skip: SKIP }, (t) => {
  assert.ok(typeof DIR === "string");
  const files = scanCorpus(DIR).filter((f) => f.size <= MAX_BYTES);
  const before = snapshotOf(scanCorpus(DIR));
  const docs: Doc[] = [];
  let unreadable = 0;
  for (const f of files) {
    const d = open(f.id, new Uint8Array(readFileSync(f.abs)));
    if (d === undefined) unreadable++;
    else docs.push(d);
  }
  assert.ok(docs.length >= 10, `읽은 문서 ${docs.length}건`);
  const store = mkdtempSync(join(tmpdir(), "hwpx-block-corpus-"));
  const counts = { blockParagraphs: 0, sameSpotChecks: 0, extracted: 0, rejected: 0, stored: 0, planned: 0, formatWarned: 0, formatDiffParagraphs: 0, replaced: 0, reextracted: 0, placedV2: 0, newErrors: 0 };
  const rejectedCodes: Record<string, number> = {};
  const rows: string[] = [];
  try {
    const all = docs.map((d) => ({ d, spans: spans(d.doc) }));
    for (const [n, { d, spans: mine }] of all.entries()) {
      const target = all[(n + 1) % all.length];
      const third = all[(n + 2) % all.length];
      assert.ok(target !== undefined && third !== undefined);
      const spot = target.spans[0];
      assert.ok(spot !== undefined, `${target.d.id}: 넣을 제목 범위 없음`);
      let made = 0;
      let warned = 0;
      for (const s of mine) {
        if (made >= PER_DOC) break;
        const id = `k${(n * 16 + made).toString(16).padStart(8, "0")}`;
        const draft = makeHeadingRangeAnchor(d.doc, s.heading.at.sectionIndex, s.heading.at.parentPath, s.heading.index);
        assert.ok(draft !== undefined);
        let block;
        try {
          block = extractBlock(d.doc, draft, { id, name: `블록 ${id}`, at: AT });
        } catch (e) {
          const code = e instanceof Error && "code" in e ? String(e.code) : "?";
          rejectedCodes[code] = (rejectedCodes[code] ?? 0) + 1;
          counts.rejected++;
          continue;
        }
        counts.extracted++;
        counts.blockParagraphs += s.to - s.from + 1;
        // 결정성: 다시 떼도 같은 원형·덩어리
        const again = extractBlock(d.doc, draft, { id, name: `블록 ${id}`, at: AT });
        assert.equal(writeBlockProto(again.proto), writeBlockProto(block.proto));
        assert.ok(bytesEqual(again.blob, block.blob));

        // 임시 저장소 왕복
        const folder = join(store, "blocks", id);
        mkdirSync(folder, { recursive: true });
        const sha = sha256Hex(block.blob);
        writeFileSync(join(folder, `${sha}.json`), block.blob);
        writeFileSync(join(folder, "block.json"), writeBlockProto(block.proto));
        const proto: BlockProto = readBlockProto(readFileSync(join(folder, "block.json"), "utf8"));
        const blob = new Uint8Array(readFileSync(join(folder, `${sha}.json`)));
        assert.equal(writeBlockProto(proto), writeBlockProto(block.proto));
        counts.stored++;

        // (1) 넣기 계획: 다음 문서의 제목 앞
        const point = { sectionIndex: spot.heading.at.sectionIndex, parentPath: [], index: spot.from, position: "before" as const };
        const plan = planBlockInsert(target.d.doc, proto, blob, point);
        const placed = applyPlan(target.d.doc.pkg, plan);
        const fresh1 = newErrorsAfter(validateDocument(target.d.bytes), validateDocument(placed));
        counts.newErrors += fresh1.length;
        assert.deepEqual(fresh1.map((v) => v.code), [], `${d.id} → ${target.d.id}: 넣기 새 오류`);
        counts.planned++;
        // 서식 비교의 참·거짓: 독립 계산(원본 문단과 자리 문단의 자원을 fingerprintResource로 견줌)과 같고, 블록 문단을 원래 자리와 견주면 그 문단은 차이가 없다
        const list = listAtParent(d.doc.sections[s.heading.at.sectionIndex]!, [])!;
        const spotPara = listAtParent(target.d.doc.sections[point.sectionIndex]!, [])![point.index]!;
        const want: [number, string][] = [];
        for (let i = s.from; i <= s.to; i++) {
          const src = list[i]!;
          if (printOf(d.doc, "paraPr", src.attrs.paraPrIDRef) !== printOf(target.d.doc, "paraPr", spotPara.attrs.paraPrIDRef)) want.push([i - s.from, "paraPr"]);
          if (printOf(d.doc, "style", src.attrs.styleIDRef) !== printOf(target.d.doc, "style", spotPara.attrs.styleIDRef)) want.push([i - s.from, "style"]);
          const own = blockFormatDiffs(d.doc, block.fragment, { sectionIndex: s.heading.at.sectionIndex, parentPath: [], index: i });
          assert.ok(!own.some((x) => x.paragraph === i - s.from), `${d.id}: 제자리 문단 ${i - s.from}에 서식 차이`);
          counts.sameSpotChecks++;
        }
        assert.deepEqual(plan.formatDiffs.map((x) => [x.paragraph, x.property]), want, `${d.id} → ${target.d.id}: 서식 차이 독립 계산`);
        if (plan.formatDiffs.length > 0) {
          counts.formatWarned++;
          warned++;
          counts.formatDiffParagraphs += plan.summary["formatDiffParagraphs"] ?? 0;
          assert.ok(plan.issues.some((i) => i.code === "BLOCK_FORMAT_DIFFERS"));
        }

        // (2) 제목 범위 교체(저장 게이트), 두 번 같은 바이트
        const anchor = makeHeadingRangeAnchor(target.d.doc, spot.heading.at.sectionIndex, [], spot.heading.index);
        assert.ok(anchor !== undefined);
        const fragment = JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown>;
        const rule = { id: "b", do: { type: "inject", anchor: "slot", position: "replace", fragment } };
        const r1 = generate(target.d.bytes, tpl([{ id: "slot", ...anchor }], [rule]), EMPTY);
        const r2 = generate(target.d.bytes, tpl([{ id: "slot", ...anchor }], [rule]), EMPTY);
        assert.ok(r1.ok && !r1.dryRun && r2.ok && !r2.dryRun, `${d.id} → ${target.d.id}: 교체 ${r1.report.issues.filter((i) => i.severity === "error").map((i) => i.code).join(",")}`);
        assert.ok(bytesEqual(r1.output, r2.output), "결정성");
        assert.deepEqual(r1.report.validation?.newErrors.map((v) => v.code), [], "게이트 새 오류");
        const fresh2 = newErrorsAfter(validateDocument(target.d.bytes), validateDocument(r1.output));
        counts.newErrors += fresh2.length;
        assert.deepEqual(fresh2.map((v) => v.code), [], "교체 검사기 새 오류");
        counts.replaced++;

        // (3) 결과에서 넣은 구간을 다시 떼어 2판 → 셋째 문서에 넣기
        const resultDoc = parseDocument(openPackage(r1.output));
        const top = parseFragmentXml(block.fragment).paragraphs.length;
        const region = makeRangeAnchor(resultDoc, spot.heading.at.sectionIndex, [], spot.from, spot.from + top - 1);
        assert.ok(region !== undefined);
        const v2 = reextractBlock(resultDoc, region, proto, { at: "2026-10-06T01:00:00Z", previous: block.fragment });
        assert.deepEqual([v2.proto.id, v2.proto.version, v2.proto.source?.sha256, v2.proto.history?.length, v2.proto.previous?.version], [id, 2, sha256Hex(r1.output), 2, 1]);
        assert.deepEqual(v2.fragment.texts, block.fragment.texts, "넣은 구간의 글이 블록과 같다");
        counts.reextracted++;
        const thirdSpot = third.spans[0] ?? spot;
        const placed2 = applyPlan(third.d.doc.pkg, planBlockInsert(third.d.doc, v2.proto, v2.blob, { sectionIndex: thirdSpot.heading.at.sectionIndex, parentPath: [], index: thirdSpot.from, position: "before" }));
        const fresh3 = newErrorsAfter(validateDocument(third.d.bytes), validateDocument(placed2));
        counts.newErrors += fresh3.length;
        assert.deepEqual(fresh3.map((v) => v.code), [], "2판 넣기 새 오류");
        counts.placedV2++;
        made++;
      }
      assert.ok(made >= 1, `${d.id}: 뗀 블록 ${made}`);
      rows.push(`${d.id} 블록 ${made} 서식경고 ${warned}`);
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
  const after = snapshotOf(scanCorpus(DIR));
  t.diagnostic(`문서 ${docs.length}건(읽을 수 없음 ${unreadable}): ${JSON.stringify(counts)}, 떼기 거절 코드 ${JSON.stringify(rejectedCodes)}`);
  t.diagnostic(rows.join(" | "));
  t.diagnostic(`문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(counts.replaced >= 30, `교체 ${counts.replaced}회`);
  assert.equal(counts.newErrors, 0);
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
});
