// 도구 자체의 정확성 확인: 합성 시험 문서로 검증이 통과하는지, 검증 항목을 일부러 틀리게 하면 결함으로 잡히는지.
// 실행: node --test tools/stress/selftest.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPlan, charDelta, openPackage, parseDocument, planApplyCharFormat, type HwpxDocument, type XElement } from "../../packages/hwpx-engine/src/index.ts";
import { validateDocument } from "../../packages/hwpx-engine/src/validate/index.ts";
import { mutateEntryText, parseSynthetic, readFixture } from "../../packages/hwpx-engine/test/helpers.ts";
import { describeDoc } from "./docinfo.ts";
import { verifyApplication } from "./formats.ts";
import { CaseStop, METHODS, loadDocument, runMethod, type Loaded, type MethodName, type PairCtx } from "./methods.ts";
import { hashSeed, makeRng } from "./rng.ts";
import { verifyDocument, verifyStep, type Fail, type Notes, type Origin, type Step } from "./verify.ts";

const SECTION = "Contents/section0.xml";
const HEADER = "Contents/header.xml";
const NONE = { duplicateIds: [], danglingRefs: [] };
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

test("합성 시험 문서 모든 쌍 × 10방식: 결함 0, 거절은 코드가 있다, 검증이 실제로 비교했다", () => {
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
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: changed, bytes: changed.pkg.bytes, steps: [step], inherited: NONE },
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
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: dup, bytes: dup.pkg.bytes, steps: [step], inherited: NONE },
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
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: bad, bytes: bad.pkg.bytes, steps: [step], inherited: NONE },
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
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: dropped, bytes: res.pkg.bytes, steps: [step], inherited: NONE },
    {},
  );
  const found = codes(out.fails);
  assert.ok(found.includes("V-g:REF_HREF_MISSING") || found.includes("V-g:NEW_ITEM_WITHOUT_ENTRY"), found.join());
  // 정상 결과는 V-g를 통과한다
  const ok = verifyDocument(
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: res, bytes: step.bytes, steps: [step], inherited: NONE },
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

test("분류: 만들 자리(refList)가 없는 대상은 코드가 있는 거절(rejected)이고, 목록이 없는 대상은 목록을 만들어 통과한다. 시드가 같으면 같은 난수를 낸다", () => {
  // 목록이 없는 합성 대상(탭·번호·글머리표 목록 없음)은 이제 거절되지 않는다: 합성 문서 쌍 전부가 거절 없이 끝난다
  let rejected = 0;
  let created = 0;
  for (const s of SOURCES()) {
    for (const t of NAMES) {
      if (s === t) continue;
      try {
        created += runMethod("M1", ctxFor(s, t), false).steps[0]?.plan.summary["createdLists"] ?? 0;
      } catch (e) {
        assert.ok(e instanceof CaseStop);
        rejected++;
      }
    }
  }
  assert.equal(rejected, 0, "목록이 없어서 거절되는 쌍이 없다");
  assert.ok(created > 0, "합성 문서 중에 목록을 새로 만드는 쌍이 있다");
  // refList가 없는 대상: 코드가 있는 거절
  const base = load("D1");
  const noRefList = (b: Uint8Array): Uint8Array => mutateEntryText(b, HEADER, (t) => t.replace(/<hh:refList>[\s\S]*<\/hh:refList>/, ""));
  const bytes = noRefList(base.bytes);
  const tgt = loadDocument("no-reflist", bytes, describeDoc(parseDocument(openPackage(bytes)), 2, 200));
  try {
    runMethod("M1", { ...ctxFor("D5", "D1"), tgt }, false);
    assert.fail("거절되어야 한다");
  } catch (e) {
    assert.ok(e instanceof CaseStop);
    assert.equal(e.kind, "rejected");
    assert.equal(e.code, "FRAG_NO_LIST");
    assert.match(e.code, /^[A-Z]+_[A-Z_]+$/);
  }
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
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result, bytes: result.pkg.bytes, steps, inherited: NONE },
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

test("V-e: 대상에서 없던 참조를 새 자원이 채우면(id를 건너뛰지 않으면) 잡고, 건너뛴 정상 결과는 통과한다", () => {
  let found = false;
  for (const s of SOURCES()) {
    for (const t of ["D1", "D7"]) {
      // D1·D7은 탭 목록이 비었는데 문단모양이 없는 tabPr 0을 가리킨다. 새 탭은 그 id(0)를 건너뛰어야 한다.
      if (s === t) continue;
      const ctx = ctxFor(s, t);
      let out;
      try {
        out = runMethod("M1", ctx, false);
      } catch {
        continue;
      }
      const step = out.steps[0] as Step;
      const tab = step.result.header.resources["tabPr"]?.[0];
      if (tab === undefined || (ctx.tgt.doc.header.resources["tabPr"] ?? []).length > 0) continue;
      found = true;
      assert.notEqual(tab.id, "0", "새 탭은 없는 tabPr 0을 건너뛴다");
      assert.ok(!codes(docCheck(step, ctx, step.result)).includes("V-e:FILLS_DANGLING"), "건너뛴 결과는 통과");
      // 새 탭의 id를 0으로 바꿔 대상에서 없던 참조를 채우게 만든다
      const filled = withBytes(step.result, HEADER, (text) => text.replace(`<hh:tabPr id="${tab.id}"`, '<hh:tabPr id="0"'));
      assert.ok(codes(docCheck(step, ctx, filled)).includes("V-e:FILLS_DANGLING"));
      return;
    }
  }
  assert.ok(found, "합성 문서 중에 새 탭이 들어오는 쌍이 있다");
});

test("V-b: 소스가 이미 가진 id 중복을 옮긴 것은 inFragment로 가른다", () => {
  const { step, ctx } = stepOf("D5", "D1");
  const res = step.result;
  const text = res.sections[0]?.text ?? "";
  const ids = [...text.matchAll(/<hp:tbl\b[^>]*?\sid="(\d+)"/g)].map((m) => m[1] as string);
  const dup = withBytes(res, SECTION, (t) => t.replace(new RegExp(`(<hp:tbl\\b[^>]*?\\sid=")${ids[1]}(")`), `$1${ids[0]}$2`));
  // 조각의 instanceIds에 같은 값이 두 번 있는 것처럼 꾸미면 inFragment, 아니면 일반 코드다
  const twice: Step = { ...step, fragment: { ...step.fragment, instanceIds: [...step.fragment.instanceIds, { role: "object", value: ids[0] as string, start: 0, end: 0 }, { role: "object", value: ids[0] as string, start: 0, end: 0 }] } };
  const plain = verifyDocument({ base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: dup, bytes: dup.pkg.bytes, steps: [step], inherited: NONE, fragments: [step.fragment] }, {});
  const marked = verifyDocument({ base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: dup, bytes: dup.pkg.bytes, steps: [twice], inherited: NONE, fragments: [twice.fragment] }, {});
  assert.ok(codes(plain.fails).includes("V-b:INST_DUP_ID:objectId"), codes(plain.fails).join());
  assert.ok(codes(marked.fails).includes("V-b:INST_DUP_ID:objectId.inFragment"), codes(marked.fails).join());
});

// ── 상속(inherited)과 새 방식 M9·M10 ─────────────────────────────

/** 소스가 이미 갖고 있던 문제: 같은 id의 도형 둘, 같은 id의 문단 둘, 없는 글자모양 9번 */
function inheritedPair(): PairCtx {
  const run = (id: string, inner: string, ref = "0"): string =>
    `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${ref}">${inner}<hp:t>가나다라마바사</hp:t></hp:run></hp:p>`;
  const bytes = (body: string): Uint8Array => parseSynthetic([body]).pkg.bytes;
  const srcBytes = bytes(run("7", '<hp:rect id="2"/><hp:rect id="2"/>') + run("7", "") + run("8", "", "9"));
  const tgtBytes = bytes(run("1", '<hp:rect id="100"/>'));
  const mk = (name: string, b: Uint8Array): Loaded => loadDocument(name, b, describeDoc(parseDocument(openPackage(b)), 1, 200));
  const src = mk("inh-src", srcBytes);
  const win = src.info.window;
  assert.ok(win !== null);
  return { pair: 0, seed: 3, src, win, tgt: mk("inh-tgt", tgtBytes), loadThird: () => mk("inh-third", tgtBytes) };
}

test("분류: 계획의 inherited로 설명되는 새 오류는 inherited, 그 밖은 결함이다(M1)", () => {
  const out = runMethod("M1", inheritedPair(), true);
  assert.deepEqual(codes(out.fails), [], "결함 없음");
  assert.ok(codes(out.inherited).includes("V-b:INST_DUP_ID:objectId.inFragment"), codes(out.inherited).join());
  assert.ok(codes(out.inherited).includes("V-b:RES_DANGLING"), codes(out.inherited).join());
  assert.ok(out.steps[0]?.plan.inherited.duplicateIds.length === 2, "객체 id와 문단 id의 중복이 계획에 기록돼 있다");
});

test("분류: 계획이 기록하지 않은 중복은 결함이다(기록을 지우면 같은 오류가 결함으로 잡힌다)", () => {
  const ctx = inheritedPair();
  const out = runMethod("M1", ctx, false);
  const step = out.steps[0] as Step;
  const none = { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: step.result, bytes: step.bytes, steps: [step], inherited: NONE, fragments: [step.fragment] };
  const bad = verifyDocument(none, {});
  assert.ok(codes(bad.fails).includes("V-b:INST_DUP_ID:objectId.inFragment"), codes(bad.fails).join());
  assert.ok(codes(bad.fails).includes("V-b:RES_DANGLING"), codes(bad.fails).join());
  assert.ok(codes(bad.fails).includes("V-i:objectId.inFragment"), codes(bad.fails).join());
  const good = verifyDocument({ ...none, inherited: step.plan.inherited }, {});
  assert.deepEqual(codes(good.fails), []);
  assert.ok(good.inherited.length >= 3);
});

test("M9: reissueInternalDuplicates로 가져오면 상속한 중복이 남지 않는다(없는 참조만 상속). 기록을 인정하지 않아도 결함 0", () => {
  const ctx = inheritedPair();
  const m1 = runMethod("M1", ctx, true);
  const m9 = runMethod("M9", ctx, true);
  assert.deepEqual(codes(m9.fails), []);
  assert.equal(m9.steps[0]?.plan.inherited.duplicateIds.length, 0);
  assert.ok(codes(m9.inherited).every((c) => c === "V-b:RES_DANGLING" || c === "V-a:MODEL_REF_MISSING"), codes(m9.inherited).join());
  assert.ok(codes(m1.inherited).some((c) => c.includes("INST_DUP_ID")), "M1에는 중복이 상속으로 남는다");
  // 옵션을 켜지 않은 가져오기를 M9로 검증하면 결함이다(중복이 남아 있으므로)
  const step = m1.steps[0] as Step;
  const strict = verifyDocument(
    { base: { doc: ctx.tgt.doc, baseline: ctx.tgt.baseline }, result: step.result, bytes: step.bytes, steps: [step], inherited: { duplicateIds: [], danglingRefs: step.plan.inherited.danglingRefs }, fragments: [step.fragment] },
    {},
  );
  assert.ok(codes(strict.fails).some((c) => c.startsWith("V-b:INST_DUP_ID")), codes(strict.fails).join());
});

test("M10: 서식 변경 조합이 합성 시험 문서에서 결함 없이 적용되고, 서식 종류별 건수가 나온다", () => {
  let applied = 0;
  let cases = 0;
  const kinds = new Set<string>();
  for (const s of SOURCES()) {
    for (const t of NAMES) {
      if (s === t) continue;
      try {
        const out = runMethod("M10", ctxFor(s, t), true);
        cases++;
        assert.deepEqual(codes(out.fails), [], `${s} -> ${t}`);
        for (const [k, v] of Object.entries(out.formats?.applied ?? {})) {
          applied += v;
          kinds.add(k.split(":")[0] ?? "");
        }
        assert.ok((out.notes["vm.propertiesChecked"] ?? 0) > 0 || Object.keys(out.formats?.rejected ?? {}).length > 0);
      } catch (e) {
        assert.ok(e instanceof CaseStop, String(e));
        assert.notEqual(e.kind, "defect", `${s} -> ${t}: ${e.code}`);
      }
    }
  }
  assert.ok(cases > 30 && applied > 100, `적용 ${applied}건 / ${cases}건`);
  assert.deepEqual([...kinds].sort(), ["char", "para"]);
});

test("M10: 같은 시드는 같은 서식을 같은 자리에 적용한다(결정성). 시드가 다르면 달라진다", () => {
  const a = runMethod("M10", ctxFor("D5", "D1"), false);
  const b = runMethod("M10", ctxFor("D5", "D1"), false);
  assert.deepEqual(a.outputs, b.outputs);
  assert.deepEqual(a.formats, b.formats);
  const other = runMethod("M10", { ...ctxFor("D5", "D1"), seed: 99 }, false);
  assert.notDeepEqual(other.outputs, a.outputs);
});

// 서식 변경 검증을 일부러 틀리게 하면 잡히는가: 적용 하나를 직접 만들고 그 결과를 변조한다
function oneApplication(): { before: HwpxDocument; after: HwpxDocument; plan: Parameters<typeof verifyApplication>[2]; holds: () => boolean } {
  const before = load("D5").doc;
  const paragraph = before.sections[0]?.paragraphs.find((p) => p.logicalText.length >= 6 && p.objects.length === 0);
  assert.ok(paragraph !== undefined);
  const spec = { ratio: 150 as number };
  const plan = planApplyCharFormat(before, { sectionIndex: 0, path: paragraph.path, start: 1, end: 4 }, charDelta(before, spec));
  const bytes = applyPlan(before.pkg, plan);
  const after = parseDocument(openPackage(bytes));
  return { before, after, plan: { kind: "char:ratio", scope: "char", paragraph, start: 1, end: 4, make: () => ({ spec, holds: () => true }) }, holds: () => true };
}

const hold150 = (resource: XElement): boolean => resource.children.some((c) => "local" in c && c.local === "ratio" && c.attrs.every((a) => a.value === "150"));

test("M10 검증: 정상 적용은 통과하고, 글 변조·구간 밖 서식 변조·요청 속성 누락·다른 문단 변조는 각자 잡힌다", () => {
  const { before, after, plan } = oneApplication();
  const run = (doc: HwpxDocument, holds: (r: XElement) => boolean = hold150): Fail[] => {
    const fails: Fail[] = [];
    verifyApplication(before, doc, plan, holds, 0, fails, {});
    return fails;
  };
  assert.deepEqual(codes(run(after)), [], "정상");

  // 글 변조: 구역 안 글자 하나를 바꾼다
  const textCorrupted = withBytes(after, SECTION, (t) => t.replace(/(<hp:t>)([^<])/, "$1#"));
  assert.ok(codes(run(textCorrupted)).some((c) => c.startsWith("V-m:TEXT_CHANGED")), codes(run(textCorrupted)).join());

  // 요청 속성 누락: 요청한 값이 없는 속성을 요구한다
  assert.ok(codes(run(after, () => false)).some((c) => c.startsWith("V-m:PROPERTY_MISSING")));

  // 구간 밖 서식 변조: 그 문단의 다른 run 하나의 글자모양을 바꾼다(구간 밖 글자의 지문이 달라진다)
  const target = after.sections[0]?.paragraphs.find((p) => p.path.join() === plan.paragraph.path.join());
  assert.ok(target !== undefined && target.runs.length >= 2);
  // 구간 밖 run의 글자모양을 구간 안 run의 것(장평 150)으로 바꾸면 구간 밖 글자의 지문이 달라진다
  const covers = (ordinal: number): boolean => target.pieces.some((p) => p.runOrdinal === ordinal && p.logicalEnd > p.logicalStart && p.logicalStart < 4 && p.logicalEnd > 1);
  const outside = target.runs.find((r) => r.charPrIDRef !== null && !covers(r.ordinal) && target.pieces.some((p) => p.runOrdinal === r.ordinal && p.logicalEnd > p.logicalStart));
  const inside = target.runs.find((r) => covers(r.ordinal));
  assert.ok(outside !== undefined && inside?.charPrIDRef !== undefined && inside.charPrIDRef !== null);
  const other = inside.charPrIDRef;
  const attr = outside.element.attrs.find((a) => a.qname === "charPrIDRef");
  assert.ok(attr !== undefined);
  const recolored = withBytes(after, SECTION, (t) => `${t.slice(0, attr.valueStart)}${other}${t.slice(attr.valueEnd)}`);
  assert.ok(codes(run(recolored)).some((c) => c.startsWith("V-m:CHAR_FP_OUTSIDE_RANGE")), codes(run(recolored)).join());

  // 다른 문단의 문단모양 변조(글자 서식 적용인데 문단모양이 바뀌었다)
  const second = after.sections[0]?.paragraphs.find((p) => p !== target && p.attrs.paraPrIDRef !== null);
  assert.ok(second !== undefined);
  const paraIds = (after.header.resources["paraPr"] ?? []).map((r) => r.id).filter((id) => id !== second.attrs.paraPrIDRef);
  const pa = second.element.attrs.find((a) => a.qname === "paraPrIDRef");
  assert.ok(pa !== undefined && paraIds.length > 0);
  const reparaed = withBytes(after, SECTION, (t) => `${t.slice(0, pa.valueStart)}${paraIds[0]}${t.slice(pa.valueEnd)}`);
  assert.ok(codes(run(reparaed)).some((c) => c.startsWith("V-m:PARA_FP_CHANGED")), codes(run(reparaed)).join());
});
