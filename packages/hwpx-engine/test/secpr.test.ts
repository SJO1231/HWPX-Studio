// 구역 설정(secPr) 자식 검사(엔진 명세 8.1, 이슈 #103, 검증 기준 31절).
// 기대값은 한글 2024 COM 실측에서 온다: startNum·visibility가 없으면 한글이 열지 못하고(오류 SEC_PR_INCOMPLETE),
// pagePr가 없으면 열지만 용지 크기 없이 배치해 쪽 수가 크게 달라지며(경고 SEC_PR_PAGE_MISSING),
// 격자·줄 번호·각주·미주·쪽 테두리는 없어도 같은 쪽 수로 연다(보고하지 않음).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareToBaseline, openPackage, readEntry, validateDocument, type ValidationReport } from "../src/index.ts";
import { buildBlockPreviewDocument, extractBlock, makeRangeAnchor } from "../src/fill/index.ts";
import { buildHwpx, mutateEntryText, readFixture, reparse } from "./helpers.ts";
import { rng } from "./range-helpers.ts";

const SEC = "Contents/section0.xml";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** 구역 설정의 자식 종류(한컴 저장본의 순서). pageBorderFill은 한컴 저장본에 셋(BOTH·EVEN·ODD)이다 */
const KINDS = ["grid", "startNum", "visibility", "lineNumberShape", "pagePr", "footNotePr", "endNotePr", "pageBorderFill"];
const OPEN_FAILS = ["startNum", "visibility"];

/** 한컴 오피스가 저장한 시험 자료(시험 폴더). `tools/com/out`은 아래 거짓 양성 시험이 따로 훑는다 */
const HANCOM = [
  "hancom/blocks", "hancom/field-states", "hancom/header-footer", "hancom/ph-mixed", "hancom/ph-single", "hancom/ph-table", "hancom/picture",
  "tables/tables-inline", "tables/tables-merged", "tables/tables-nested", "tables/tables-rich", "inline/inline-breaks", "merge/merge-fields",
  "span/field-span", "span/field-span-filled", "span/field-span-table", "span/field-span-table-filled", "span/field-span-cell", "span/field-span-cell-filled",
  "span/inline-breaks-filled", "hancom-field", "hancom-merged",
];

const codes = (r: ValidationReport, code: string) => [...r.errors, ...r.warnings].filter((i) => i.code === code);
const secPrCodes = (r: ValidationReport) => [...r.errors, ...r.warnings].filter((i) => i.code.startsWith("SEC_PR"));

/** 구역 설정 안에서 그 종류의 자식을 모두 지운다(검사기와 따로, 글 치환으로) */
function dropKinds(bytes: Uint8Array, kinds: string[], entry = SEC): Uint8Array {
  return mutateEntryText(bytes, entry, (text) => {
    const m = /<hp:secPr\b[\s\S]*?<\/hp:secPr>/.exec(text);
    assert.ok(m !== null, "구역 설정이 없다");
    let secPr = m[0];
    for (const k of kinds) secPr = secPr.replace(new RegExp(`<hp:${k}\\b[^>]*?/>|<hp:${k}\\b[^>]*>[\\s\\S]*?</hp:${k}>`, "g"), "");
    return text.slice(0, m.index) + secPr + text.slice(m.index + m[0].length);
  });
}

function previewOfBlocks(): Uint8Array {
  const doc = reparse(readFixture("hancom/blocks"));
  const anchor = makeRangeAnchor(doc, 0, [], 1, 3);
  assert.ok(anchor !== undefined);
  const block = extractBlock(doc, anchor, { id: "k0000a103", name: "구역 설정 시험", at: "2026-10-06T00:00:00Z" });
  return buildBlockPreviewDocument(block.proto, block.blob).bytes;
}

/** 지운 종류에 대한 기대: 열지 못하는 자식이 빠지면 오류 하나(빠진 것을 한컴 순서로), 쪽 설정이 빠지면 경고 하나, 나머지는 없음 */
function expectFor(r: ValidationReport, dropped: string[], label: string, where = SEC): void {
  const missing = OPEN_FAILS.filter((k) => dropped.includes(k));
  const err = r.errors.filter((i) => i.code === "SEC_PR_INCOMPLETE");
  if (missing.length === 0) assert.equal(err.length, 0, `${label}: 오류가 없어야 한다`);
  else {
    assert.equal(err.length, 1, `${label}: 오류 하나`);
    assert.equal(err[0]?.where, where);
    assert.equal(err[0]?.message, `구역 설정(secPr)에 ${missing.join("·")} 요소가 없음(한글이 문서를 열지 못함)`, label);
  }
  const warn = r.warnings.filter((i) => i.code === "SEC_PR_PAGE_MISSING");
  assert.equal(warn.length, dropped.includes("pagePr") ? 1 : 0, `${label}: 쪽 설정 경고`);
  if (warn.length > 0) assert.equal(warn[0]?.where, where);
  assert.equal(r.errors.some((i) => i.code === "SEC_PR_PAGE_MISSING") || r.warnings.some((i) => i.code === "SEC_PR_INCOMPLETE"), false, `${label}: 종류(오류·경고)`);
}

test("8.1 SEC_PR_INCOMPLETE: 한컴 저장본에서 자식을 하나씩 빼면 startNum·visibility만 오류, pagePr는 경고, 나머지는 보고 없음(COM 실측과 같은 분류)", () => {
  for (const name of HANCOM) {
    const src = readFixture(name);
    const base = validateDocument(src);
    assert.deepEqual(secPrCodes(base), [], `${name}: 원본`);
    for (const k of KINDS) {
      const bytes = dropKinds(src, [k]);
      const r = validateDocument(bytes);
      expectFor(r, [k], `${name} - ${k}`);
      // 저장 게이트(기준선 비교)가 막는 새 오류는 이 코드뿐이다
      const fresh = compareToBaseline(base, r).newErrors.map((i) => i.code);
      assert.deepEqual(fresh, OPEN_FAILS.includes(k) ? ["SEC_PR_INCOMPLETE"] : [], `${name} - ${k}: 새 오류`);
    }
  }
});

test("8.1 SEC_PR_INCOMPLETE: 둘 다 빠지면 한 항목에 한컴 순서로(startNum·visibility), 엄격 방식도 같다", () => {
  const bytes = dropKinds(readFixture("hancom/picture"), ["visibility", "startNum"]);
  for (const strict of [false, true]) expectFor(validateDocument(bytes, { strict }), ["startNum", "visibility"], `strict=${strict}`);
});

test("8.1 SEC_PR_INCOMPLETE: 합성 문서(줄 번호·쪽 테두리 없음)는 통과하고 visibility를 빼면 오류. 여러 구역이면 그 구역 파일을 가리킨다", () => {
  for (const name of ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "extra/features-picture", "extra/features-rhwp"]) {
    const src = readFixture(name);
    assert.deepEqual(secPrCodes(validateDocument(src)), [], name);
    expectFor(validateDocument(dropKinds(src, ["visibility"])), ["visibility"], `${name} - visibility`);
  }
  const blocks = readFixture("hancom/blocks");
  const text = new TextDecoder().decode(readEntry(openPackage(blocks).archive, blocks, SEC));
  const secPr = /<hp:secPr\b[\s\S]*?<\/hp:secPr>/.exec(text)?.[0] ?? "";
  assert.ok(secPr.includes("<hp:visibility "));
  const para = (s: string) => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${s}<hp:t>글</hp:t></hp:run></hp:p>`;
  const two = buildHwpx([para(secPr), para(secPr), para(secPr)]);
  assert.deepEqual(secPrCodes(validateDocument(two)), []);
  expectFor(validateDocument(dropKinds(two, ["visibility"], "Contents/section1.xml")), ["visibility"], "section1", "Contents/section1.xml");
  // 한 구역 안 구역 설정 둘이 같은 것을 빠뜨리면 한 항목(count 2)
  const twice = buildHwpx([para(secPr.replace(/<hp:visibility\b[^>]*\/>/, "")) + para(secPr.replace(/<hp:visibility\b[^>]*\/>/, ""))]);
  const r = validateDocument(twice);
  assert.deepEqual(codes(r, "SEC_PR_INCOMPLETE").map((i) => i.count), [2]);
});

test("8.8.18 블록 미리보기 빈 바탕(#75)은 검사 오류 0이고, 고치기 전 구역 설정(감추기·줄 번호·각주·미주·쪽 테두리 없음)은 SEC_PR_INCOMPLETE", () => {
  const preview = previewOfBlocks();
  const r = validateDocument(preview);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(secPrCodes(r), []);
  const old = ["visibility", "lineNumberShape", "footNotePr", "endNotePr", "pageBorderFill"];
  expectFor(validateDocument(dropKinds(preview, old)), old, "고치기 전");
  // PR #101 검증: visibility만 있으면 한글이 열었다(줄 번호·각주·미주·쪽 테두리 없음)
  expectFor(validateDocument(dropKinds(preview, old.slice(1))), old.slice(1), "visibility만 있음");
});

test("8.1 SEC_PR_* 무작위 60회(시드 103): 한컴 저장본·합성 문서·미리보기에서 자식 부분집합을 빼면 분류대로, 같은 입력은 같은 보고서, 다른 새 오류 0", (t) => {
  const bases: [string, Uint8Array][] = [...HANCOM.map((n): [string, Uint8Array] => [n, readFixture(n)]), ["D1", readFixture("D1")], ["preview", previewOfBlocks()]];
  const next = rng(103);
  let errors = 0;
  let warnings = 0;
  let silent = 0;
  for (let i = 0; i < 60; i++) {
    const [name, src] = bases[Math.floor(next() * bases.length)]!;
    const dropped = KINDS.filter(() => next() < 0.35);
    if (dropped.length === 0) dropped.push(KINDS[Math.floor(next() * KINDS.length)]!);
    const bytes = dropKinds(src, dropped);
    const r = validateDocument(bytes);
    expectFor(r, dropped, `${i} ${name} - ${dropped.join(",")}`);
    assert.deepEqual(validateDocument(bytes), r, `${i}: 결정성`);
    const fresh = compareToBaseline(validateDocument(src), r).newErrors.map((x) => x.code);
    assert.ok(fresh.every((c) => c === "SEC_PR_INCOMPLETE"), `${i}: 새 오류 ${fresh}`);
    if (fresh.length > 0) errors++;
    else if (codes(r, "SEC_PR_PAGE_MISSING").length > 0) warnings++;
    else silent++;
  }
  t.diagnostic(`오류 ${errors}·경고만 ${warnings}·보고 없음 ${silent}`);
  assert.ok(errors >= 15 && warnings >= 3 && silent >= 3, `오류 ${errors}·경고만 ${warnings}·보고 없음 ${silent}`);
});

/** 저장소의 모든 .hwpx(시험 자료·COM 산출물·예시·lite 견본) */
function repoHwpx(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.toLowerCase().endsWith(".hwpx")) out.push(p);
    }
  };
  for (const d of ["packages/hwpx-engine/test/fixtures", "tools/com/out", "apps/studio-lite/samples", "examples"]) walk(join(ROOT, d));
  return out;
}

test("8.1 거짓 양성 0: 저장소의 모든 .hwpx(한컴 저장본·COM 산출물·합성 자료·예시)에서 SEC_PR_* 코드가 없다", () => {
  const files = repoHwpx();
  const comOut = files.filter((f) => f.includes(join("tools", "com", "out"))).length;
  assert.ok(files.length >= 61 && comOut >= 20, `문서 ${files.length}·COM 산출물 ${comOut}`);
  for (const f of files) assert.deepEqual(secPrCodes(validateDocument(new Uint8Array(readFileSync(f)))), [], f.slice(ROOT.length));
});
