// 참조 번호 자동 재정렬(엔진 명세 8.8.12, #196)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글·값은 기록하지 않는다: 진단에는 경로 해시 앞 10자와 수량만 남긴다.
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/renumber-corpus.test.ts
// 문서마다 붙임·별지·표의 대상·참조 수를 세고, 붙임 대상이 둘 이상인 문서는 둘째 대상 문단을 슬롯으로 두어(유지 블록 / 지우는 블록) 재정렬을 켠 생성을 50회 한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCorpusFile, sameSnapshot, scanCorpus, snapshotOf, type CorpusFile } from "../../../tools/stress/corpus.ts";
import { openPackage, parseDocument, validateDocument, walkParagraphs, type HwpxDocument, type ParagraphNode } from "../src/index.ts";
import { generateFromTemplate, makeLineAnchor } from "../src/fill/index.ts";
import { planRenumber, readStudioTemplate, sha256Hex, type StudioTemplate } from "../src/template/index.ts";
import { bytesEqual, newErrorsAfter } from "./helpers.ts";
import { rng } from "./range-helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;
const PATTERNS = ["붙임", "별지", "표"];

type Para = { sectionIndex: number; p: ParagraphNode };
const paragraphsOf = (doc: HwpxDocument): Para[] => doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)].map((p) => ({ sectionIndex: s.index, p })));
const textsOf = (doc: HwpxDocument): string[] => paragraphsOf(doc).map((x) => x.p.logicalText);

/** 둘째 붙임 대상 문단을 슬롯으로: 선택 값이 Y면 원래 글을 다시 넣고(b1), 아니면 지운다(b2) */
function templateOf(bytes: Uint8Array, doc: HwpxDocument, at: Para): StudioTemplate {
  const anchor = makeLineAnchor(doc, "a1", at.sectionIndex, at.p.path);
  assert.ok(anchor !== undefined);
  const raw = {
    schema: "hwpx-studio/template@2",
    id: "t00000196",
    version: 1,
    source: { kind: "hwpx", sha256: sha256Hex(bytes) },
    anchors: [anchor],
    values: [{ id: "v1", name: "선택", format: "text" }],
    bindings: [{ value: "v1", key: "선택" }],
    places: [],
    slots: [{ id: "s1", name: "붙임 하나", anchors: ["a1"], parent: null }],
    blocks: [
      { id: "b1", slot: "s1", name: "유지", content: { text: at.p.logicalText }, when: { path: "v1", op: "eq", value: "Y" } },
      { id: "b2", slot: "s1", name: "빼기", content: { text: "" } },
    ],
    options: { missing: "keep", unregistered: "keep", renumber: { patterns: PATTERNS } },
  };
  const t = readStudioTemplate(JSON.stringify(raw));
  assert.ok(t.schema === "hwpx-studio/template@2");
  return t;
}

test("#196 실제 공고서: 붙임·별지·표의 대상·참조 수, 붙임 대상 하나를 빼는 슬롯으로 재정렬을 켠 생성 50회 → 성공·결정성·검사기 새 오류 0·다시 매길 번호 없음", { skip: SKIP }, (ctx) => {
  assert.ok(typeof DIR === "string");
  const before = snapshotOf(scanCorpus(DIR));
  const tally = { docs: 0, targets: 0, references: 0, unmatched: 0, eligible: 0, generated: 0, dropped: 0, renumbered: 0, newErrors: 0 };
  const eligible: { f: CorpusFile; bytes: Uint8Array; t: StudioTemplate; targets: number; renumbered: number }[] = [];
  for (const f of scanCorpus(DIR).filter((x) => x.size <= MAX_BYTES)) {
    const bytes = readCorpusFile(f);
    let doc: HwpxDocument;
    try {
      doc = parseDocument(openPackage(bytes));
    } catch {
      continue;
    }
    tally.docs++;
    const paras = paragraphsOf(doc);
    const texts = paras.map((x) => x.p.logicalText);
    const counts = PATTERNS.map((p) => {
      const plan = planRenumber(texts, [p]);
      tally.targets += plan.targets;
      tally.references += plan.references;
      tally.unmatched += plan.issues.length;
      return `${p} 대상 ${plan.targets} 참조 ${plan.references} 대응 없음 ${plan.issues.length} 바꿀 곳 ${plan.edits.length}`;
    });
    ctx.diagnostic(`${f.id} ${counts.join(" | ")}`);
    // 개체 자리 글자가 없는 붙임 대상 문단(글 블록으로 다시 넣을 수 있음)이 둘 이상이면 둘째를 슬롯으로
    const heads = paras.filter((x) => planRenumber([x.p.logicalText], ["붙임"]).targets === 1 && !x.p.logicalText.includes("￼"));
    const second = heads[1];
    if (second === undefined) continue;
    const targets = planRenumber(texts, ["붙임"]).targets;
    const renumbered = planRenumber(texts.filter((_, i) => paras[i] !== second), PATTERNS).edits.length;
    eligible.push({ f, bytes, t: templateOf(bytes, doc, second), targets, renumbered });
  }
  tally.eligible = eligible.length;
  assert.ok(eligible.length > 0, "붙임 대상이 둘 이상인 문서가 없다");
  const next = rng(1960);
  const base = new Map<CorpusFile, ReturnType<typeof validateDocument>>();
  for (let round = 0; round < 50; round++) {
    const e = eligible[round % eligible.length]!;
    const keep = next() < 0.5;
    const record = { 선택: keep ? "Y" : "N" };
    const r = generateFromTemplate(e.bytes, e.t, record, undefined, () => undefined);
    assert.ok(r.ok && !r.dryRun && r.output instanceof Uint8Array, `${e.f.id} ${round}회: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code))}`);
    const again = generateFromTemplate(e.bytes, e.t, record, undefined, () => undefined);
    assert.ok(again.ok && !again.dryRun && again.output instanceof Uint8Array && bytesEqual(again.output, r.output), `${e.f.id} ${round}회: 결정성`);
    if (!base.has(e.f)) base.set(e.f, validateDocument(e.bytes));
    const newErrors = newErrorsAfter(base.get(e.f)!, validateDocument(r.output)).length + (r.report.validation?.newErrors.length ?? 0);
    tally.newErrors += newErrors;
    const out = textsOf(parseDocument(openPackage(r.output)));
    assert.deepEqual(planRenumber(out, PATTERNS).edits, [], `${e.f.id} ${round}회: 다시 매길 번호가 남았다`);
    assert.equal(planRenumber(out, ["붙임"]).targets, keep ? e.targets : e.targets - 1, `${e.f.id} ${round}회: 붙임 대상 수`);
    tally.generated++;
    if (!keep) {
      tally.dropped++;
      tally.renumbered += e.renumbered;
    }
  }
  const after = snapshotOf(scanCorpus(DIR));
  ctx.diagnostic(`${JSON.stringify(tally)}, 문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
  assert.ok(tally.docs >= 10 && tally.generated === 50 && tally.dropped > 0, JSON.stringify(tally));
  assert.equal(tally.newErrors, 0);
});
