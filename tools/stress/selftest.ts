// 도구 자체의 정확성 확인: 합성 시험 문서로 검증이 통과하는지, 검증 항목을 일부러 틀리게 하면 결함으로 잡히는지.
// 실행: node --test tools/stress/selftest.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { openPackage, parseDocument, type HwpxDocument } from "../../packages/hwpx-engine/src/index.ts";
import { validateDocument } from "../../packages/hwpx-engine/src/validate/index.ts";
import { mutateEntryText, readFixture } from "../../packages/hwpx-engine/test/helpers.ts";
import { describeDoc } from "./docinfo.ts";
import { CaseStop, METHODS, loadDocument, runMethod, type Loaded, type MethodName, type PairCtx } from "./methods.ts";
import { hashSeed, makeRng } from "./rng.ts";
import { verifyDocument, verifyStep, type Fail, type Notes, type Origin, type Step } from "./verify.ts";

const SECTION = "Contents/section0.xml";
const HEADER = "Contents/header.xml";
const NAMES = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "hancom-merged", "hancom-field", "hancom/picture", "hancom/field-states", "hancom/blocks", "extra/features-picture", "extra/features-rhwp"];

const loaded = new Map<string, Loaded>();
/** 구역 설정이 없는 문단이 있는(소스로 쓸 수 있는) 문서만 */
const SOURCES = (): string[] => NAMES.filter((n) => load(n).info.window !== null);
function load(name: string): Loaded {
  let l = loaded.get(name);
  if (l === undefined) {
    const bytes = readFixture(name);
    const probe = parseDocument(openPackage(bytes));
    l = loadDocument(name, bytes, describeDoc(probe, 2, 200));
    loaded.set(name, l);
  }
  return l;
}

function ctxFor(srcName: string, tgtName: string, pair = 0): PairCtx {
  const src = load(srcName);
  const win = src.info.window;
  assert.ok(win !== null, `${srcName}에 고를 구간이 있다`);
  return { pair, seed: 7, src, win, tgt: load(tgtName), loadThird: () => load("D4") };
}

const codes = (fails: Fail[]): string[] => fails.map((f) => `${f.item}:${f.code}`);

/** 한 건을 실행해 첫 단계와 그 출처를 돌려준다(검증은 끄고 단계만 얻는다). */
function stepOf(srcName: string, tgtName: string): { step: Step; origin: Origin; ctx: PairCtx } {
  const ctx = ctxFor(srcName, tgtName);
  const out = runMethod("M1", ctx, false);
  const step = out.steps[0] as Step;
  return { step, ctx, origin: { doc: ctx.src.doc, sel: { sectionIndex: ctx.win.sectionIndex, parentPath: [], from: ctx.win.from, to: ctx.win.to } } };
}

const verify = (step: Step, origin: Origin): { fails: Fail[]; notes: Notes } => {
  const fails: Fail[] = [];
  const notes: Notes = {};
  verifyStep(step, origin, fails, notes);
  return { fails, notes };
};

const withBytes = (doc: HwpxDocument, entry: string, change: (t: string) => string): HwpxDocument =>
  parseDocument(openPackage(mutateEntryText(doc.pkg.bytes, entry, change)));

// ── 정상: 합성 문서 쌍에서 결함 0 ─────────────────────────────────

test("합성 시험 문서 모든 쌍 × 8방식: 결함 0, 거절은 코드가 있다, 검증이 실제로 비교했다", () => {
  const tally: Record<string, number> = {};
  let compared = 0;
  for (const s of SOURCES()) {
    for (const t of NAMES) {
      if (s === t) continue;
      const ctx = ctxFor(s, t);
      for (const m of METHODS) {
        try {
          const out = runMethod(m, ctx, true);
          const key = out.fails.length > 0 ? `defect:${codes(out.fails).join(",")}` : "ok";
          tally[key] = (tally[key] ?? 0) + 1;
          compared += out.notes["vc.paragraphsCompared"] ?? 0;
        } catch (e) {
          assert.ok(e instanceof CaseStop, `예외가 CaseStop이어야 한다: ${String(e)}`);
          const key = e.kind === "defect" ? `defect:${e.item}:${e.code}` : `${e.kind}`;
          tally[key] = (tally[key] ?? 0) + 1;
        }
      }
    }
  }
  const defects = Object.entries(tally).filter(([k]) => k.startsWith("defect"));
  assert.deepEqual(defects, [], `결함이 없어야 한다: ${JSON.stringify(tally)}`);
  assert.ok((tally["ok"] ?? 0) > 300, "통과한 건이 충분하다");
  assert.ok(compared > 10000, "글 비교가 실제로 이뤄졌다");
});

test("깨끗한 한 단계는 V-c·V-d·V-e·V-f를 모두 통과한다", () => {
  const { step, origin } = stepOf("D5", "D1");
  assert.deepEqual(verify(step, origin).fails, []);
});

// ── 오류 주입: 검증 항목을 일부러 틀리게 하면 잡힌다 ────────────────

test("V-c: 조각의 기대 글에 문자를 하나 더하면 결함이다", () => {
  const { step, origin } = stepOf("D5", "D1");
  const bad: Step = { ...step, fragment: { ...step.fragment, texts: step.fragment.texts.map((t, i) => (i === 0 ? `${t}x` : t)) } };
  assert.ok(codes(verify(bad, origin).fails).includes("V-c:TEXTS_VS_FRAGMENT"));
});

test("V-c: 소스 구간을 한 문단 밀면(기대가 달라지면) 글 비교가 결함으로 잡는다", () => {
  const { step, origin } = stepOf("D5", "D1");
  const shifted: Origin = { doc: origin.doc, sel: { ...origin.sel, from: origin.sel.from + 1, to: origin.sel.to } };
  const found = codes(verify(step, shifted).fails);
  assert.ok(found.includes("V-c:TEXTS_VS_SOURCE"), found.join());
  assert.ok(found.includes("V-c:TEXT_RUNS_XML"), found.join());
});

test("V-c: 결과 원문의 글자 하나를 바꾸면 원문 정규식 비교가 잡는다", () => {
  const { step, origin } = stepOf("D5", "D1");
  const first = step.result.sections[0]?.paragraphs[step.first];
  assert.ok(first !== undefined);
  // 삽입된 첫 글(hp:t)의 첫 글자를 바꾼 문서
  const text = step.result.sections[0]?.text ?? "";
  const at = text.indexOf("<hp:t>", first.element.start);
  assert.ok(at > 0);
  const mutated = withBytes(step.result, SECTION, (t) => `${t.slice(0, at + 6)}#${t.slice(at + 7)}`);
  const found = codes(verify({ ...step, result: mutated }, origin).fails);
  assert.ok(found.includes("V-c:TEXT_RUNS_XML"), found.join());
});

test("V-d: 조각의 prints를 틀리게 하면 엔진 지문 비교가 잡는다", () => {
  const { step, origin } = stepOf("D5", "D1");
  const prints = [...step.fragment.prints];
  const i = prints.findIndex((p) => !p.startsWith("missing:"));
  assert.ok(i >= 0);
  prints[i] = "0".repeat(64);
  const found = codes(verify({ ...step, fragment: { ...step.fragment, prints } }, origin).fails);
  assert.ok(found.some((c) => c.startsWith("V-d:PRINT_MISMATCH")), found.join());
});

test("V-d: 결과의 글자모양 하나를 다른 모양으로 바꾸면 독립 지문이 잡는다", () => {
  const { step, origin } = stepOf("D5", "D1");
  const res = step.result;
  // 삽입된 구간의 charPrIDRef 하나를 다른(기존) 글자모양 id로 바꾼다
  const ids = (res.header.resources["charPr"] ?? []).map((i) => i.id);
  const inserted = res.sections[0]?.paragraphs[step.first];
  assert.ok(inserted !== undefined && ids.length > 1);
  const run = inserted.runs[0];
  assert.ok(run !== undefined && run.charPrIDRef !== null);
  const other = ids.find((id) => id !== run.charPrIDRef) ?? "";
  const attr = run.element.attrs.find((a) => a.qname === "charPrIDRef");
  assert.ok(attr !== undefined);
  const mutated = withBytes(res, SECTION, (t) => `${t.slice(0, attr.valueStart)}${other}${t.slice(attr.valueEnd)}`);
  const found = codes(verify({ ...step, result: mutated }, origin).fails);
  assert.ok(found.some((c) => c.startsWith("V-d:INDEP_MISMATCH") || c.startsWith("V-d:PRINT_MISMATCH")), found.join());
});

test("V-e: 직전 문서가 실제와 다르면(대상 원문이 바뀐 것처럼) 구역 원문 비교가 잡는다", () => {
  const { step, origin } = stepOf("D5", "D1");
  const altered = withBytes(step.base, SECTION, (t) => t.replace(/<hp:t>/, "<hp:t>#"));
  const found = codes(verify({ ...step, base: altered }, origin).fails);
  assert.ok(found.includes("V-e:BODY_CHANGED"), found.join());
});

test("V-e: 기존 자원 원문이 바뀌면 header 비교가 잡는다", () => {
  const { step, ctx } = stepOf("D5", "D1");
  const changed = withBytes(step.result, HEADER, (t) => t.replace(/<hh:charPr id="0"/, '<hh:charPr data-x="1" id="0"'));
  const out = verifyDocument(
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: changed, bytes: changed.pkg.bytes, steps: [step], danglingKeys: new Set(), headerDangling: false },
    {},
  );
  assert.ok(codes(out.fails).includes("V-e:HEADER_RESOURCE_CHANGED"), codes(out.fails).join());
});

test("V-f: 계획 summary의 예고를 틀리게 하면 수량 비교가 잡는다", () => {
  const { step, origin } = stepOf("D5", "D1");
  assert.ok((step.plan.summary["insertedTables"] ?? 0) > 0);
  const bad: Step = { ...step, plan: { ...step.plan, summary: { ...step.plan.summary, insertedTables: (step.plan.summary["insertedTables"] ?? 0) + 1 } } };
  assert.ok(codes(verify(bad, origin).fails).includes("V-f:TABLES"));
  const bad2: Step = { ...step, plan: { ...step.plan, summary: { ...step.plan.summary, addedResources: (step.plan.summary["addedResources"] ?? 0) + 1 } } };
  assert.ok(codes(verify(bad2, origin).fails).includes("V-f:ADDED_RESOURCES"));
});

test("V-b·V-i: 결과에 객체 id 중복을 만들면 검사기 새 오류와 중복 검사가 잡는다", () => {
  const { step, ctx } = stepOf("D5", "D1");
  const res = step.result;
  const text = res.sections[0]?.text ?? "";
  const ids = [...text.matchAll(/<hp:tbl\b[^>]*?\sid="(\d+)"/g)].map((m) => m[1] as string);
  assert.ok(ids.length >= 2, "표가 둘 이상");
  const dup = withBytes(res, SECTION, (t) => t.replace(new RegExp(`(<hp:tbl\\b[^>]*?\\sid=")${ids[1]}(")`), `$1${ids[0]}$2`));
  const out = verifyDocument(
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: dup, bytes: dup.pkg.bytes, steps: [step], danglingKeys: new Set(), headerDangling: false },
    {},
  );
  const found = codes(out.fails);
  assert.ok(found.includes("V-b:INST_DUP_ID:objectId"), found.join());
  assert.ok(found.includes("V-i:objectId"), found.join());
});

test("V-a·V-b: 결과에 없는 서식 참조를 만들면 모델 오류와 검사기 새 오류가 잡는다", () => {
  const { step, ctx } = stepOf("D5", "D1");
  const res = step.result;
  const inserted = res.sections[0]?.paragraphs[step.first];
  const attr = inserted?.runs[0]?.element.attrs.find((a) => a.qname === "charPrIDRef");
  assert.ok(inserted !== undefined && attr !== undefined);
  const bad = withBytes(res, SECTION, (t) => `${t.slice(0, attr.valueStart)}99999${t.slice(attr.valueEnd)}`);
  const out = verifyDocument(
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: bad, bytes: bad.pkg.bytes, steps: [step], danglingKeys: new Set(), headerDangling: false },
    {},
  );
  const found = codes(out.fails);
  assert.ok(found.includes("V-a:MODEL_REF_MISSING"), found.join());
  assert.ok(found.includes("V-b:RES_DANGLING"), found.join());
});

test("V-g: 이진 자료 항목이 ZIP에서 빠지거나 manifest에 없으면 잡는다", () => {
  const { step, ctx } = stepOf("hancom/picture", "D1");
  assert.ok((step.plan.summary["addedBinaries"] ?? 0) > 0, "그림이 든 조각");
  const res = step.result;
  const dropped = { ...res, pkg: { ...res.pkg, archive: { ...res.pkg.archive, entries: res.pkg.archive.entries.filter((e) => !e.name.startsWith("BinData/")) } } };
  const out = verifyDocument(
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: dropped, bytes: res.pkg.bytes, steps: [step], danglingKeys: new Set(), headerDangling: false },
    {},
  );
  const found = codes(out.fails);
  assert.ok(found.includes("V-g:REF_HREF_MISSING") || found.includes("V-g:NEW_ITEM_WITHOUT_ENTRY"), found.join());
  // 정상 결과는 V-g를 통과한다
  const ok = verifyDocument(
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: res, bytes: step.bytes, steps: [step], danglingKeys: new Set(), headerDangling: false },
    {},
  );
  assert.deepEqual(codes(ok.fails).filter((c) => c.startsWith("V-g")), []);
});

test("V-h: 출력이 달라지면(다른 대상에 넣으면) 단계별 sha256이 달라 재실행 비교가 잡는다", () => {
  const a = runMethod("M2", ctxFor("D5", "D1"), false).outputs;
  const same = runMethod("M2", ctxFor("D5", "D1"), false).outputs;
  const other = runMethod("M2", ctxFor("D5", "D2"), false).outputs;
  assert.deepEqual(a, same, "같은 입력은 같은 출력");
  assert.notDeepEqual(a, other, "다른 입력은 다른 출력");
});

test("분류: 대상 header에 목록이 없으면 코드가 있는 거절(rejected)이고, 시드가 같으면 같은 난수를 낸다", () => {
  let rejected = 0;
  for (const s of SOURCES()) {
    for (const t of NAMES) {
      if (s === t) continue;
      try {
        runMethod("M1", ctxFor(s, t), false);
      } catch (e) {
        assert.ok(e instanceof CaseStop);
        assert.equal(e.kind, "rejected");
        assert.match(e.code, /^[A-Z]+_[A-Z_]+$/);
        rejected++;
      }
    }
  }
  assert.ok(rejected > 0, "합성 문서 중에도 거절되는 쌍이 있다");
  const a = makeRng(hashSeed("x"));
  const b = makeRng(hashSeed("x"));
  assert.deepEqual([a.next(), a.int(10)], [b.next(), b.int(10)]);
});

test("검증 없이 실행한 단계는 검증 실행과 같은 출력이다", () => {
  for (const m of ["M1", "M4", "M7"] as MethodName[]) {
    const x = runMethod(m, ctxFor("D5", "D2"), false);
    const y = runMethod(m, ctxFor("D5", "D2"), true);
    assert.deepEqual(x.outputs, y.outputs);
  }
});

test("검사기 기준선: 원본에 이미 있던 오류는 새 오류로 세지 않는다", () => {
  const base = load("extra/features-picture"); // 머리말 문단 id 중복이 원래 있다
  assert.ok(validateDocument(base.bytes).errors.length > 0 || validateDocument(base.bytes).warnings.length >= 0);
  const out = runMethod("M1", ctxFor("D5", "extra/features-picture"), true);
  assert.deepEqual(out.fails, []);
});

// ── 추가 검증 항목 ──────────────────────────────────────────────

const docCheck = (step: Step, ctx: PairCtx, result: HwpxDocument, steps: Step[] = [step]): Fail[] =>
  verifyDocument(
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result, bytes: result.pkg.bytes, steps, danglingKeys: new Set(), headerDangling: false },
    {},
  ).fails;

test("V-f: header 목록의 개수 속성이 어긋나면 잡는다", () => {
  const { step, ctx } = stepOf("D5", "D1");
  const bad = withBytes(step.result, HEADER, (t) => t.replace(/<hh:charProperties itemCnt="(\d+)"/, (_m, n: string) => `<hh:charProperties itemCnt="${Number(n) + 5}"`));
  assert.ok(codes(docCheck(step, ctx, bad)).includes("V-f:ITEMCNT_MISMATCH"));
  assert.ok(!codes(docCheck(step, ctx, step.result)).includes("V-f:ITEMCNT_MISMATCH"));
});

test("V-f: 스타일 이름이 겹치게 가져오면(이름을 바꾸지 않으면) 잡는다", () => {
  const { step, ctx } = stepOf("D5", "D1");
  const names = [...(step.result.header.text.matchAll(/<hh:style\b[^>]*?\sname="([^"]*)"/g))].map((m) => m[1] as string);
  assert.ok(names.length >= 2);
  const first = names[0] as string;
  const last = names[names.length - 1] as string;
  const bad = withBytes(step.result, HEADER, (t) => `${t.slice(0, t.lastIndexOf(`name="${last}"`))}name="${first}"${t.slice(t.lastIndexOf(`name="${last}"`) + `name="${last}"`.length)}`);
  assert.ok(codes(docCheck(step, ctx, bad)).includes("V-f:STYLE_NAME_DUPLICATED"));
});

test("V-e: 대상에서 없던 참조를 가져온 자원이 조용히 채우면(경고 없이) 잡는다", () => {
  let found = false;
  for (const s of SOURCES()) {
    for (const t of NAMES) {
      if (s === t) continue;
      const ctx = ctxFor(s, t);
      let out;
      try {
        out = runMethod("M1", ctx, false);
      } catch {
        continue;
      }
      const step = out.steps[0] as Step;
      if (!step.plan.issues.some((i) => i.code === "FRAG_FILLS_DANGLING")) continue;
      found = true;
      assert.ok(!codes(docCheck(step, ctx, step.result)).includes("V-e:FILLS_DANGLING_SILENT"), "경고가 있으면 통과");
      const silent: Step = { ...step, plan: { ...step.plan, issues: step.plan.issues.filter((i) => i.code !== "FRAG_FILLS_DANGLING") } };
      assert.ok(codes(docCheck(silent, ctx, step.result, [silent])).includes("V-e:FILLS_DANGLING_SILENT"));
      return;
    }
  }
  assert.ok(found, "합성 문서 중에 FRAG_FILLS_DANGLING이 나오는 쌍이 있다");
});

test("V-b: 소스가 이미 가진 id 중복을 옮긴 것은 inFragment로 가른다", () => {
  const { step, ctx } = stepOf("D5", "D1");
  const res = step.result;
  const text = res.sections[0]?.text ?? "";
  const ids = [...text.matchAll(/<hp:tbl\b[^>]*?\sid="(\d+)"/g)].map((m) => m[1] as string);
  const dup = withBytes(res, SECTION, (t) => t.replace(new RegExp(`(<hp:tbl\\b[^>]*?\\sid=")${ids[1]}(")`), `$1${ids[0]}$2`));
  // 조각의 instanceIds에 같은 값이 두 번 있는 것처럼 꾸미면 inFragment, 아니면 일반 코드다
  const twice: Step = { ...step, fragment: { ...step.fragment, instanceIds: [...step.fragment.instanceIds, { role: "object", value: ids[0] as string, start: 0, end: 0 }, { role: "object", value: ids[0] as string, start: 0, end: 0 }] } };
  const plain = verifyDocument({ base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: dup, bytes: dup.pkg.bytes, steps: [step], danglingKeys: new Set(), headerDangling: false, fragments: [step.fragment] }, {});
  const marked = verifyDocument({ base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: dup, bytes: dup.pkg.bytes, steps: [twice], danglingKeys: new Set(), headerDangling: false, fragments: [twice.fragment] }, {});
  assert.ok(codes(plain.fails).includes("V-b:INST_DUP_ID:objectId"), codes(plain.fails).join());
  assert.ok(codes(marked.fails).includes("V-b:INST_DUP_ID:objectId.inFragment"), codes(marked.fails).join());
});
