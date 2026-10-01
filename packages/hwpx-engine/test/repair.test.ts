import assert from "node:assert/strict";
import { test } from "node:test";
import { openPackage, readArchive, readEntry, type EditPlan } from "../src/index.ts";
import { normalizeArchive, planRepair, repairDocument, type RepairNote, type RepairOptions } from "../src/repair/index.ts";
import { checkNoRegression } from "../src/repair/repair.ts";
import { compareToBaseline, validateDocument, type ValidationIssue, type ValidationReport } from "../src/validate/index.ts";
import { FIXTURE_NAMES, buildZip, bytesEqual, mutateEntryText, readFixture, type RawEntry } from "./helpers.ts";

const SEC = "Contents/section0.xml";
const HDR = "Contents/header.xml";
const HPF = "Contents/content.hpf";

const HANCOM_NAMES = ["blocks", "field-states", "header-footer", "ph-mixed", "ph-single", "ph-table", "picture"].map((n) => `hancom/${n}`);
const EXTRA_NAMES = ["features-picture", "features-rhwp"].map((n) => `extra/${n}`);
const ALL_NAMES: string[] = [...FIXTURE_NAMES, ...HANCOM_NAMES, ...EXTRA_NAMES];

/** 금지 제어문자(XML 1.0이 허용하지 않는 U+0001 등). 소스에 원문 문자를 두지 않으려고 코드로 만든다. */
const CTL = String.fromCharCode(1);
const CTL2 = String.fromCharCode(2);
const CTL3 = String.fromCharCode(3);
const FFFE = String.fromCharCode(0xfffe);

// ── 보조 ────────────────────────────────────────────────────────────────

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function entryText(bytes: Uint8Array, name: string): string {
  return decoder.decode(readEntry(readArchive(bytes), bytes, name));
}

function codes(list: ValidationIssue[]): string[] {
  return [...new Set(list.map((i) => i.code))].sort();
}

function total(list: ValidationIssue[], code: string): number {
  return list.filter((i) => i.code === code).reduce((a, i) => a + i.count, 0);
}

function describe(r: ValidationReport): string {
  return `오류 ${JSON.stringify(codes(r.errors))} 경고 ${JSON.stringify(codes(r.warnings))}`;
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** 한 XML 항목의 텍스트만 바꾼 사본(파일로 저장하지 않는다) */
function withText(bytes: Uint8Array, entry: string, change: (text: string) => string): Uint8Array {
  return mutateEntryText(bytes, entry, change);
}

function addBeforeFirstParaEnd(xml: string): (s: string) => string {
  return (s) => {
    const i = s.indexOf("</hp:p>");
    assert.ok(i >= 0);
    return s.slice(0, i) + xml + s.slice(i);
  };
}

/** 첫 문단 끝에 run 하나를 더한다. */
const addRun = (inner: string) => addBeforeFirstParaEnd(`<hp:run charPrIDRef="0">${inner}</hp:run>`);

function field(id: string, name: string, fieldid = "1"): string {
  return (
    `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="${fieldid}"/></hp:ctrl>` +
    `<hp:t>값</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${fieldid}"/></hp:ctrl>`
  );
}

const bookmark = (name: string): string => `<hp:ctrl><hp:bookmark name="${name}"/></hp:ctrl>`;

function entriesOf(bytes: Uint8Array): RawEntry[] {
  const archive = readArchive(bytes);
  return archive.entries
    .filter((e) => !e.isDirectory)
    .map((e) => ({ name: e.name, data: readEntry(archive, bytes, e.name), method: e.method }));
}

const D1 = readFixture("D1");
const MERGED = readFixture("hancom-merged");

/** 구역 원문에서 문단·객체·instId·누름틀 시작의 숫자 id를 모은다(보정 코드와 독립인 정규식). */
function numericIds(sectionText: string): number[] {
  const out: number[] = [];
  const tags = "p|tbl|pic|ole|container|equation|rect|ellipse|arc|polygon|curve|line|connectLine|textart|video|chart|fieldBegin";
  for (const m of sectionText.matchAll(new RegExp(`<hp:(?:${tags})\\b[^>]*?\\sid="(\\d+)"`, "g"))) out.push(Number(m[1]));
  for (const m of sectionText.matchAll(/\s(?:instId|instid)="(\d+)"/g)) out.push(Number(m[1]));
  return out;
}

/** 보정 종류 하나의 P1 판정: 사라져야 하는 코드가 처음엔 있고 보정 뒤엔 없으며, 새 오류도 새 경고도 없다. */
function assertFixed(
  bytes: Uint8Array,
  options: RepairOptions,
  gone: { code: string; severity: "error" | "warning" }[],
  /** 읽을 수 없던 항목을 읽게 되면 그 항목의 경고가 처음 보인다(예: header의 한컴 허용 경고). 그런 경우에만 켠다. */
  allowNewWarnings = false,
) {
  const r = repairDocument(bytes, options);
  for (const { code, severity } of gone) {
    const pick = (rep: ValidationReport): ValidationIssue[] => (severity === "error" ? rep.errors : rep.warnings);
    assert.ok(total(pick(r.before), code) > 0, `보정 전에 ${code}가 있어야 한다. ${describe(r.before)}`);
    assert.equal(total(pick(r.after), code), 0, `보정 뒤에 ${code}가 사라져야 한다. ${describe(r.after)}`);
  }
  assert.deepEqual(compareToBaseline(r.before, r.after).newErrors, [], "새 오류가 생기면 안 된다");
  const beforeWarn = new Set(codes(r.before.warnings));
  if (!allowNewWarnings) for (const c of codes(r.after.warnings)) assert.ok(beforeWarn.has(c), `새 경고 ${c}`);
  return r;
}

// ── P1: 보정 종류마다 결함을 넣어 고친다 ──────────────────────────────────

test("P1 reissueIds: 중복 객체 id(표)는 첫 등장을 두고 뒤의 것에 최댓값 + 1부터 준다", () => {
  const bytes = withText(D1, SEC, (s) => s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"'));
  const max = Math.max(...numericIds(entryText(bytes, SEC)));
  const r = assertFixed(bytes, {}, [{ code: "INST_DUP_ID", severity: "error" }]);
  const ids = [...entryText(r.output, SEC).matchAll(/<hp:tbl id="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["424242", String(max + 1)]);
  assert.deepEqual(r.repaired.map((n) => [n.kind, n.what, n.count]), [["reissueIds", "object id", 1]]);
});

test("P1 reissueIds: 중복 instId(대소문자 표기가 달라도)", () => {
  const bytes = withText(D1, SEC, addRun('<hp:rect id="8001" instId="77"/><hp:rect id="8002" instid="77"/><hp:rect id="8003" instId="77"/>'));
  const max = Math.max(...numericIds(entryText(bytes, SEC)));
  const r = assertFixed(bytes, {}, [{ code: "INST_DUP_ID", severity: "error" }]);
  const out = entryText(r.output, SEC);
  assert.deepEqual([...out.matchAll(/\s(?:instId|instid)="(\d+)"/g)].map((m) => m[1]), ["77", String(max + 1), String(max + 2)]);
  // 객체 id는 서로 달랐으므로 그대로다
  assert.deepEqual([...out.matchAll(/<hp:rect id="(\d+)"/g)].map((m) => m[1]), ["8001", "8002", "8003"]);
  assert.deepEqual(r.repaired.map((n) => [n.what, n.count]), [["instId", 2]]);
});

test("P1 reissueIds: 중복 누름틀 시작 id는 끝의 beginIDRef를 함께 바꾼다(첫 누름틀은 그대로)", () => {
  const bytes = withText(D1, SEC, addRun(field("570", "a") + field("570", "b")));
  const max = Math.max(...numericIds(entryText(bytes, SEC)));
  const r = assertFixed(bytes, {}, [{ code: "INST_DUP_ID", severity: "error" }, { code: "FIELD_MULTI_END", severity: "error" }]);
  const out = entryText(r.output, SEC);
  assert.deepEqual(
    [...out.matchAll(/<hp:fieldBegin id="(\d+)"[^>]*name="(\w)"/g)].map((m) => [m[2], m[1]]),
    [["a", "570"], ["b", String(max + 1)]],
  );
  assert.deepEqual([...out.matchAll(/beginIDRef="(\d+)"/g)].map((m) => m[1]), ["570", String(max + 1)]);
});

test("P1 reissueIds: 겹쳐 열린 같은 id의 누름틀은 안쪽 시작이 먼저 닫히는 짝으로 맺는다", () => {
  const nested =
    '<hp:ctrl><hp:fieldBegin id="580" type="CLICK_HERE" name="outer" fieldid="1"/></hp:ctrl>' +
    '<hp:ctrl><hp:fieldBegin id="580" type="CLICK_HERE" name="inner" fieldid="2"/></hp:ctrl><hp:t>값</hp:t>' +
    '<hp:ctrl><hp:fieldEnd beginIDRef="580" fieldid="2"/></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="580" fieldid="1"/></hp:ctrl>';
  const bytes = withText(D1, SEC, addRun(nested));
  const max = Math.max(...numericIds(entryText(bytes, SEC)));
  const r = assertFixed(bytes, {}, [{ code: "INST_DUP_ID", severity: "error" }]);
  const out = entryText(r.output, SEC);
  // 바깥(첫 시작)은 580 그대로, 안쪽(뒤의 시작)과 그 끝(fieldid 2)이 새 id
  assert.match(out, new RegExp(`name="inner"[^>]*/></hp:ctrl><hp:t>값</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${max + 1}" fieldid="2"/>`));
  assert.match(out, /<hp:fieldEnd beginIDRef="580" fieldid="1"\/>/);
});

test("P1 reissueIds: 시작·끝 짝을 정할 수 없는 중복 누름틀은 건드리지 않고 알린다", () => {
  const bytes = withText(
    D1,
    SEC,
    addRun(
      '<hp:ctrl><hp:fieldBegin id="571" type="CLICK_HERE" name="a" fieldid="1"/></hp:ctrl>' +
        '<hp:ctrl><hp:fieldBegin id="571" type="CLICK_HERE" name="b" fieldid="1"/></hp:ctrl>' +
        '<hp:ctrl><hp:fieldEnd beginIDRef="571" fieldid="1"/></hp:ctrl>',
    ),
  );
  assert.ok(total(validateDocument(bytes).errors, "INST_DUP_ID") > 0);
  const plan = planRepair(bytes);
  assert.deepEqual(plan.plan.edits, []);
  assert.deepEqual(plan.plan.issues.map((i) => i.code), ["REPAIR_FIELD_PAIR"]);
  assert.ok(plan.unrepaired.some((i) => i.code === "INST_DUP_ID"));
  assert.ok(bytesEqual(repairDocument(bytes).output, bytes));
});

test("P1 reissueIds: 자리값이 아닌 문단 id 중복(머리말 안 문단 id가 실제로 겹친 시험 문서와 인위적 반례)", () => {
  const r = assertFixed(readFixture("extra/features-picture"), {}, [{ code: "INST_DUP_ID", severity: "error" }]);
  assert.deepEqual(r.repaired.map((n) => [n.kind, n.what, n.count]), [["reissueIds", "paragraph id", 1]]);

  const injected = withText(D1, SEC, (s) => {
    const t = s.replace("<hp:p ", '<hp:p id="777" ');
    const i = t.indexOf("<hp:p ", t.indexOf('id="777"') + 10);
    return t.slice(0, i) + '<hp:p id="777" ' + t.slice(i + 6);
  });
  const max = Math.max(...numericIds(entryText(injected, SEC)));
  const fixed = assertFixed(injected, {}, [{ code: "INST_DUP_ID", severity: "error" }]);
  assert.deepEqual([...entryText(fixed.output, SEC).matchAll(/<hp:p id="(\d+)"/g)].map((m) => m[1]), ["777", String(max + 1)]);
});

test("P1 reissueIds: 자리값 문단 id(0, 4294967295 등)의 중복은 건드리지 않는다", () => {
  const bytes = withText(D1, SEC, (s) => {
    const t = s.replace("<hp:p ", '<hp:p id="0" ');
    const i = t.indexOf("<hp:p ", t.indexOf('id="0"') + 10);
    return t.slice(0, i) + '<hp:p id="0" ' + t.slice(i + 6);
  });
  assert.deepEqual(planRepair(bytes).plan.edits, []);
  // 한컴 저장본은 모든 문단이 같은 자리값을 쓴다
  assert.ok(count(entryText(MERGED, SEC), /<hp:p id="4294967295"/g) > 50);
  assert.deepEqual(planRepair(MERGED, { reissueIds: "all" }).plan.edits, []);
});

test("P1 reissueIds: 객체 id·instId가 0으로 겹치는 경우는 기본으로 두고 all일 때만 재발급한다", () => {
  const bytes = readFixture("extra/features-rhwp");
  assert.ok(total(validateDocument(bytes).warnings, "INST_DUP_PLACEHOLDER") > 0);

  const byDefault = repairDocument(bytes);
  assert.deepEqual(byDefault.repaired, []);
  assert.ok(total(byDefault.after.warnings, "INST_DUP_PLACEHOLDER") > 0);
  assert.ok(bytesEqual(byDefault.output, bytes));

  const all = repairDocument(bytes, { reissueIds: "all" });
  assert.equal(total(all.after.warnings, "INST_DUP_PLACEHOLDER"), 0);
  assert.deepEqual(compareToBaseline(all.before, all.after).newErrors, []);
  assert.deepEqual(validateDocument(all.output, { strict: true }).errors.filter((e) => e.code === "INST_DUP_ID"), []);
  assert.ok(all.repaired.some((n) => n.kind === "reissueIds" && n.what === "object id"));
  // 처음 `0`은 그대로 남는다
  assert.equal(count(entryText(all.output, SEC), /<hp:(?:tbl|pic|rect|container)\b[^>]*?\sid="0"/g), 1);
});

test("P1 fixCounts: 자원 목록 itemCnt, 글꼴 목록·언어별 개수, 구역 수 선언", () => {
  const itemCnt = withText(D1, HDR, (s) => s.replace('<hh:charProperties itemCnt="11"', '<hh:charProperties itemCnt="12"'));
  const a = assertFixed(itemCnt, {}, [{ code: "RES_ITEMCNT", severity: "warning" }]);
  assert.match(entryText(a.output, HDR), /<hh:charProperties itemCnt="11"/);
  assert.deepEqual(a.repaired.map((n) => [n.kind, n.entry, n.what, n.count]), [["fixCounts", HDR, "itemCnt", 1]]);

  const fontCnt = withText(D1, HDR, (s) =>
    s.replace('<hh:fontface lang="LATIN" fontCnt="3"', '<hh:fontface lang="LATIN" fontCnt="9"').replace('<hh:fontfaces itemCnt="7"', '<hh:fontfaces itemCnt="5"'),
  );
  const b = repairDocument(fontCnt);
  const headerOut = entryText(b.output, HDR);
  assert.match(headerOut, /<hh:fontface lang="LATIN" fontCnt="3"/);
  assert.match(headerOut, /<hh:fontfaces itemCnt="7"/);
  assert.deepEqual(b.repaired.map((n) => [n.what, n.count]), [["itemCnt", 1], ["fontCnt", 1]]);
  assert.ok(bytesEqual(b.output, repairDocument(b.output).output), "고친 뒤에는 더 고칠 것이 없다");

  const secCnt = withText(D1, HDR, (s) => s.replace('secCnt="1"', 'secCnt="3"'));
  const c = assertFixed(secCnt, {}, [{ code: "PKG_SECCNT_MISMATCH", severity: "error" }, { code: "PKG_SECCNT", severity: "warning" }]);
  assert.match(entryText(c.output, HDR), /secCnt="1"/);

  // 구역 항목이 실제로 둘이면 선언을 2로 맞춘다
  const extra = buildZip([...entriesOf(D1), { name: "Contents/section1.xml", data: readEntry(readArchive(D1), D1, SEC), method: 8 }]);
  const d = repairDocument(extra);
  assert.match(entryText(d.output, HDR), /secCnt="2"/);
  assert.equal(total(d.after.errors, "PKG_SECCNT_MISMATCH"), 0);
});

test("P1 fixCounts: 숫자가 아닌 선언은 건드리지 않는다", () => {
  const bytes = withText(D1, HDR, (s) => s.replace('secCnt="1"', 'secCnt="x"').replace('<hh:styles itemCnt="1"', '<hh:styles itemCnt="many"'));
  assert.deepEqual(planRepair(bytes).plan.edits, []);
});

/** hancom-merged의 첫 문단(여러 줄)의 글을 짧게 줄여 줄 배치 캐시가 글 밖을 가리키게 한다. */
const STALE = withText(MERGED, SEC, (s) => s.replace(/(<hp:t>)첫째 문단입니다[^<]*(<\/hp:t>)/, "$1짧음$2"));

test("P1 dropStaleLineSeg: 글이 줄어 줄 시작 위치가 글 밖을 가리키면 그 구역의 캐시를 전부 지운다", () => {
  assert.equal(count(entryText(STALE, SEC), /<hp:linesegarray>/g), 91);
  const r = repairDocument(STALE);
  assert.equal(count(entryText(r.output, SEC), /linesegarray/g), 0);
  assert.equal(count(entryText(r.output, SEC), /<hp:p /g), 91, "문단은 그대로");
  assert.deepEqual(r.repaired.map((n) => [n.kind, n.entry, n.what, n.count]), [["dropStaleLineSeg", SEC, "linesegarray", 91]]);
  assert.deepEqual(compareToBaseline(r.before, r.after).newErrors, []);
  assert.deepEqual(r.after.errors, []);
  // 글은 그대로다
  const texts = (t: string): string[] => [...t.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1] ?? "");
  assert.deepEqual(texts(entryText(r.output, SEC)), texts(entryText(STALE, SEC)));
});

test("P1 dropStaleLineSeg: 개체·탭이 든 문단과 끝 표지 뒤에서 시작하는 줄은 낡은 캐시가 아니다(오탐 없음)", () => {
  // 한컴 저장본 전부(캐시가 있는 문단 수백 개)는 계획이 비어 있다
  for (const name of ["hancom-merged", ...HANCOM_NAMES, "extra/features-rhwp"]) {
    assert.deepEqual(planRepair(readFixture(name)).plan.edits, [], name);
  }
  // 둘째 문단을 글 7자로 줄이고 그 문단의 줄 배치 캐시를 "0에서 시작하는 줄 + pos에서 시작하는 줄"로 바꾼다.
  const seven = (pos: number, ctrl = ""): Uint8Array =>
    withText(MERGED, SEC, (s) =>
      s.replace(
        /(<hp:run charPrIDRef="\d+">)<hp:t>첫째 문단입니다[^<]*<\/hp:t>(<\/hp:run>)<hp:linesegarray>(<hp:lineseg [^>]*\/>)[\s\S]*?<\/hp:linesegarray>/,
        (_m, run: string, close: string, first: string) =>
          `${run}${ctrl}<hp:t>일곱글자입니다</hp:t>${close}<hp:linesegarray>${first}${first.replace('textpos="0"', `textpos="${pos}"`)}</hp:linesegarray>`,
      ),
    );
  // 글 7자일 때 줄 시작은 끝 표지 뒤인 8까지 한컴이 실제로 쓰는 값이다. 9는 벗어난다.
  assert.deepEqual(planRepair(seven(7)).plan.edits, []);
  assert.deepEqual(planRepair(seven(8)).plan.edits, []);
  assert.equal(planRepair(seven(9)).plan.edits.length, 91);
  // 개체(컨트롤)는 글 길이로는 한 글자지만 위치로는 8칸이다. 글 7자 + 컨트롤 1개의 위치 범위는 16까지다.
  const ctrl = '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>';
  assert.deepEqual(planRepair(seven(16, ctrl)).plan.edits, []);
  assert.equal(planRepair(seven(17, ctrl)).plan.edits.length, 91);
});

test("P1 stripIllegalChars: 글 데이터 안의 금지 문자(문자 그대로, 숫자 참조, U+FFFE)를 지운다", () => {
  for (const [label, insert] of [
    ["문자 그대로", CTL],
    ["숫자 참조", "&#1;"],
    ["U+FFFE", FFFE],
    ["여럿", `${CTL2}&#x0B;${CTL3}`],
  ] as const) {
    const bytes = withText(D1, SEC, (s) => s.replace("<hp:t>", `<hp:t>${insert}`));
    const r = assertFixed(bytes, {}, [{ code: "XML_ILLEGAL_CHAR", severity: "error" }, { code: "XML_MALFORMED", severity: "error" }]);
    assert.equal(entryText(r.output, SEC), entryText(D1, SEC), `${label}: 글은 원문 그대로`);
    assert.deepEqual(r.repaired.map((n) => [n.kind, n.entry, n.what]), [["stripIllegalChars", SEC, "control char"]], label);
  }
  // header의 글 데이터(요소 사이)도 같다
  const header = withText(D1, HDR, (s) => s.replace("<hh:refList>", `<hh:refList>${CTL}`));
  const h = assertFixed(header, {}, [{ code: "XML_ILLEGAL_CHAR", severity: "error" }], true);
  assert.equal(entryText(h.output, HDR), entryText(D1, HDR));
});

test("P1 stripIllegalChars: 주석 안의 숫자 참조는 금지 문자가 아니고, 태그·속성 안의 금지 문자는 지우지 않는다", () => {
  const comment = withText(D1, SEC, (s) => s.replace("<hp:t>", "<!-- &#1; --><hp:t>"));
  assert.deepEqual(validateDocument(comment).errors, []);
  assert.deepEqual(planRepair(comment).plan.edits, []);

  const inAttr = withText(D1, HDR, (s) => s.replace('<hh:font id="0" face="', `<hh:font id="0" face="${CTL}`));
  const plan = planRepair(inAttr);
  assert.deepEqual(plan.plan.edits, []);
  assert.ok(plan.unrepaired.some((i) => i.code === "XML_ILLEGAL_CHAR"));
  assert.ok(plan.plan.issues.some((i) => i.code === "REPAIR_ENTRY_SKIPPED" && i.where === HDR));
  assert.ok(bytesEqual(repairDocument(inAttr).output, inAttr));

  // 같은 항목의 글 데이터와 속성에 함께 있으면 어느 쪽도 지우지 않는다(일부만 지워서는 문서가 읽히지 않는다)
  const both = withText(inAttr, HDR, (s) => s.replace("<hh:refList>", `<hh:refList>${CTL}`));
  assert.deepEqual(planRepair(both).plan.edits, []);
  assert.ok(planRepair(both).unrepaired.some((i) => i.code === "XML_ILLEGAL_CHAR"));
});

test("P1 stripIllegalChars: 같은 항목의 다른 보정과 함께 해도 위치가 어긋나지 않는다", () => {
  // 금지 문자가 여러 곳에 있는 구역에서 표 id 중복과 책갈피 중복을 함께 고친다
  const defect = (s: string): string =>
    addRun(bookmark("bm") + bookmark("bm"))(s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"').replace(/<hp:t>/g, `<hp:t>${CTL}`));
  const bytes = withText(D1, SEC, defect);
  const text = entryText(bytes, SEC);
  assert.ok(count(text, new RegExp(CTL, "g")) > 3);
  const max = Math.max(...numericIds(text));
  // 금지 문자 때문에 검사기가 구역을 읽지 못하므로 처음에는 그 오류만 보인다. 보정 뒤에는 오류가 없다.
  assert.deepEqual(codes(validateDocument(bytes).errors), ["XML_ILLEGAL_CHAR", "XML_MALFORMED"]);
  const r = repairDocument(bytes);
  assert.deepEqual(r.after.errors, []);
  assert.deepEqual(new Set(r.repaired.map((n) => n.kind)), new Set(["stripIllegalChars", "reissueIds", "renameBookmarks"]));
  // 기대 결과: 금지 문자만 빠지고, 뒤의 표 id와 뒤의 책갈피 이름만 바뀐다
  let tbl = 0;
  let bm = 0;
  const expected = text
    .replaceAll(CTL, "")
    .replace(/<hp:tbl id="424242"/g, (m) => (tbl++ === 0 ? m : `<hp:tbl id="${max + 1}"`))
    .replace(/<hp:bookmark name="bm"/g, (m) => (bm++ === 0 ? m : '<hp:bookmark name="bm_1"'));
  assert.equal(entryText(r.output, SEC), expected);
});

test("P1 stripIllegalChars: 금지 문자 때문에 가려져 있던 오류가 드러나도 새 오류로 세지 않는다", () => {
  const bytes = withText(D1, SEC, (s) => s.replace("<hp:t>", `<hp:t>${CTL}`).replace('charPrIDRef="0"', 'charPrIDRef="9999"'));
  assert.equal(total(validateDocument(bytes).errors, "RES_DANGLING"), 0, "검사기가 구역을 읽지 못해 없는 참조가 보이지 않는다");
  const r = repairDocument(bytes); // REPAIR_REGRESSION 없이 끝난다
  assert.deepEqual(r.repaired.map((n) => n.kind), ["stripIllegalChars"]);
  assert.equal(total(r.after.errors, "XML_ILLEGAL_CHAR"), 0);
  assert.equal(total(r.after.errors, "RES_DANGLING"), 1);
  assert.ok(r.unrepaired.some((i) => i.code === "RES_DANGLING"), "드러난 원래 오류는 보정하지 못한 오류로 남는다");
  assert.deepEqual(planRepair(bytes).plan.issues.filter((i) => i.code === "REPAIR_REGRESSION"), []);
});

test("P1 stripIllegalChars: 줄 배치 캐시 안의 금지 문자는 캐시를 지울 때 함께 사라진다(겹침 없음)", () => {
  const bytes = withText(STALE, SEC, (s) => s.replace("<hp:linesegarray>", `<hp:linesegarray>${CTL}`));
  const r = assertFixed(bytes, {}, [{ code: "XML_ILLEGAL_CHAR", severity: "error" }]);
  assert.equal(count(entryText(r.output, SEC), /linesegarray/g), 0);
  assert.ok(!r.repaired.some((n) => n.kind === "stripIllegalChars"), "캐시 삭제가 포함하는 금지 문자는 따로 세지 않는다");
});

test("P1 renameBookmarks: 뒤의 중복 이름에 _1, _2 접미사(이미 있는 이름과 겹치지 않게)", () => {
  const bytes = withText(D1, SEC, addRun(bookmark("bm") + bookmark("bm") + bookmark("bm_1") + bookmark("bm") + bookmark("other")));
  const r = assertFixed(bytes, {}, [{ code: "BOOKMARK_DUP", severity: "error" }]);
  assert.deepEqual([...entryText(r.output, SEC).matchAll(/<hp:bookmark name="([^"]*)"/g)].map((m) => m[1]), ["bm", "bm_2", "bm_1", "bm_3", "other"]);
  assert.deepEqual(r.repaired.map((n) => [n.kind, n.what, n.count]), [["renameBookmarks", "bookmark name", 2]]);

  // BOOKMARK 형식의 누름틀 시작도 같은 이름 공간이다
  const mixed = withText(
    D1,
    SEC,
    addRun(
      bookmark("x") +
        '<hp:ctrl><hp:fieldBegin id="601" type="BOOKMARK" name="x" fieldid="1"/></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="601" fieldid="1"/></hp:ctrl>',
    ),
  );
  const m = assertFixed(mixed, {}, [{ code: "BOOKMARK_DUP", severity: "error" }]);
  assert.match(entryText(m.output, SEC), /<hp:fieldBegin id="601" type="BOOKMARK" name="x_1"/);
});

test("P1 renameBookmarks: 이름이 빈 책갈피는 고치지 않고 오류로 남긴다", () => {
  const bytes = withText(D1, SEC, addRun(bookmark("")));
  const r = repairDocument(bytes);
  assert.deepEqual(r.repaired, []);
  assert.ok(r.unrepaired.some((i) => i.code === "BOOKMARK_NO_NAME"));
});

test("P1 fallbackRefs(켰을 때): 없는 서식 참조를 같은 종류의 기본 자원으로 돌린다", () => {
  const dangling = withText(D1, SEC, (s) =>
    s
      .replace('charPrIDRef="0"', 'charPrIDRef="9999"')
      .replace('paraPrIDRef="0"', 'paraPrIDRef="9998"')
      .replace('styleIDRef="0"', 'styleIDRef="77"')
      .replace(/(<hp:tc [^>]*borderFillIDRef=")(\d+)/, (_m, head: string) => `${head}88`),
  );
  assert.ok(total(validateDocument(dangling).errors, "RES_DANGLING") >= 4);
  const header = entryText(dangling, HDR);
  const minId = (tag: string): string =>
    String(Math.min(...[...header.matchAll(new RegExp(`<hh:${tag} id="(\\d+)"`, "g"))].map((m) => Number(m[1]))));
  const firstStyle = /<hh:style id="(\d+)"/.exec(header)?.[1] ?? "";
  const r = assertFixed(dangling, { fallbackRefs: true }, [{ code: "RES_DANGLING", severity: "error" }]);
  // 기대 결과: 네 곳만 바뀐다(글자·문단모양·테두리는 숫자 id가 가장 작은 것, 스타일은 목록의 첫 스타일)
  const expected = entryText(dangling, SEC)
    .replace('charPrIDRef="9999"', `charPrIDRef="${minId("charPr")}"`)
    .replace('paraPrIDRef="9998"', `paraPrIDRef="${minId("paraPr")}"`)
    .replace('styleIDRef="77"', `styleIDRef="${firstStyle}"`)
    .replace('borderFillIDRef="88"', `borderFillIDRef="${minId("borderFill")}"`);
  assert.equal(entryText(r.output, SEC), expected);
  assert.ok(r.repaired.every((n) => n.kind === "fallbackRefs"));
  assert.deepEqual(new Set(r.repaired.map((n) => n.what)), new Set(["charPrIDRef", "paraPrIDRef", "styleIDRef", "borderFillIDRef"]));
});

test("P1 fallbackRefs(켰을 때): 스타일은 숫자 id가 가장 작은 것이 아니라 목록의 첫 스타일로 돌린다", () => {
  const style = (id: string): string =>
    `<hh:style id="${id}" type="PARA" name="s${id}" engName="s" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>`;
  const bytes = withText(
    withText(D1, HDR, (s) => s.replace(/<hh:styles itemCnt="1">/, `<hh:styles itemCnt="3">${style("9")}${style("4")}`)),
    SEC,
    (s) => s.replace('styleIDRef="0"', 'styleIDRef="77"'),
  );
  assert.deepEqual(codes(validateDocument(bytes).errors), ["RES_DANGLING"]);
  const r = repairDocument(bytes, { fallbackRefs: true });
  assert.equal(count(entryText(r.output, SEC), /styleIDRef="9"/g), 1, "첫 스타일(id 9)이다. 가장 작은 id(0)나 4가 아니다");
  assert.deepEqual(r.after.errors, []);
});

test("P1 fallbackRefs(켰을 때): header 안의 글꼴·번호 참조", () => {
  const bytes = withText(D1, HDR, (s) =>
    s
      .replace('<hh:fontRef hangul="0"', '<hh:fontRef hangul="9"')
      .replace('<hh:heading type="NONE" idRef="0" level="0"/>', '<hh:heading type="NUMBER" idRef="42" level="0"/>'),
  );
  const header = entryText(bytes, HDR);
  const r = assertFixed(bytes, { fallbackRefs: true }, [{ code: "RES_DANGLING", severity: "error" }]);
  const out = entryText(r.output, HDR);
  const hangulFonts = /<hh:fontface lang="HANGUL"[^>]*>([\s\S]*?)<\/hh:fontface>/.exec(header)?.[1] ?? "";
  const hangulMin = Math.min(...[...hangulFonts.matchAll(/<hh:font id="(\d+)"/g)].map((m) => Number(m[1])));
  assert.ok(out.includes(`<hh:fontRef hangul="${hangulMin}"`));
  const numberingMin = Math.min(...[...header.matchAll(/<hh:numbering id="(\d+)"/g)].map((m) => Number(m[1])));
  assert.ok(out.includes(`type="NUMBER" idRef="${numberingMin}"`));
  assert.deepEqual(new Set(r.repaired.map((n) => n.what)), new Set(["fontRef", "heading idRef"]));
});

test("P1 fallbackRefs(켰을 때): 돌릴 자원이 없으면 고치지 않고 알린다", () => {
  const noStyles = withText(D1, HDR, (s) => s.replace(/<hh:styles[\s\S]*?<\/hh:styles>/, '<hh:styles itemCnt="0"/>'));
  const plan = planRepair(noStyles, { fallbackRefs: true });
  assert.ok(plan.plan.issues.some((i) => i.code === "REPAIR_NO_DEFAULT"));
  assert.ok(plan.unrepaired.some((i) => i.code === "RES_DANGLING"));
  assert.deepEqual(plan.repaired.filter((n) => n.kind === "fallbackRefs"), []);
});

test("P1 fallbackRefs: 한컴이 받아 주는 경고 분류(탭 0번, 쪽 테두리 0번)와 이진 자료 참조는 돌리지 않는다", () => {
  // D1은 탭 목록이 비었는데 문단모양이 0번을 가리킨다(경고 RES_DANGLING_TOLERATED)
  assert.ok(total(validateDocument(D1).warnings, "RES_DANGLING_TOLERATED") > 0);
  assert.deepEqual(planRepair(D1, { fallbackRefs: true }).plan.edits, []);
  const pic = withText(
    D1,
    SEC,
    addRun(
      '<hp:pic id="9001" zOrder="0"><hc:img xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" binaryItemIDRef="image99" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/></hp:pic>',
    ),
  );
  const r = planRepair(pic, { fallbackRefs: true });
  assert.deepEqual(r.plan.edits, []);
  assert.ok(r.unrepaired.some((i) => i.code === "RES_DANGLING"));
});

/** 한컴 저장본의 항목을 뽑아 다시 묶는다(순서와 압축 방식을 바꿀 수 있다). */
function rebuild(bytes: Uint8Array, order: (names: string[]) => string[], method: (e: RawEntry) => 0 | 8 = (e) => e.method ?? 0): Uint8Array {
  const entries = entriesOf(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  return buildZip(
    order(entries.map((e) => e.name)).map((n) => {
      const e = byName.get(n) as RawEntry;
      return { name: e.name, data: e.data, method: method(e) };
    }),
  );
}
const identity = (names: string[]): string[] => names;
const mimeLast = (names: string[]): string[] => [...names.filter((n) => n !== "mimetype"), "mimetype"];
const mimeCompressed = (e: RawEntry): 0 | 8 => (e.name === "mimetype" ? 8 : (e.method ?? 0));

/** 항목 이름 → 로컬 레코드 바이트 */
function localRecords(bytes: Uint8Array): Map<string, Uint8Array> {
  return new Map(readArchive(bytes).entries.map((e) => [e.name, bytes.subarray(e.localStart, e.localEnd)]));
}

test("P1 normalizePackage(켰을 때): mimetype 압축·순서 위반을 새 ZIP으로 고친다", () => {
  const cases = [
    ["압축", rebuild(MERGED, identity, mimeCompressed), ["PKG_MIMETYPE_COMPRESSED"]],
    ["순서", rebuild(MERGED, mimeLast), ["PKG_MIMETYPE_ORDER"]],
    ["둘 다", rebuild(MERGED, mimeLast, mimeCompressed), ["PKG_MIMETYPE_COMPRESSED", "PKG_MIMETYPE_ORDER"]],
  ] as const;
  for (const [label, bytes, expected] of cases) {
    assert.deepEqual(codes(validateDocument(bytes).errors), expected, label);
    const plan = planRepair(bytes, { normalizePackage: true });
    assert.equal(plan.needsNormalize, true, label);
    assert.deepEqual(plan.plan.edits, [], label);
    assert.deepEqual(plan.unrepaired, [], label);
    const r = assertFixed(bytes, { normalizePackage: true }, expected.map((code) => ({ code, severity: "error" as const })));
    assert.deepEqual(r.repaired.map((n) => [n.kind, n.entry]), [["normalizePackage", "mimetype"]], label);
    assert.deepEqual(r.after.errors, [], label);
    const archive = readArchive(r.output);
    assert.equal(archive.entries[0]?.name, "mimetype", label);
    assert.equal(archive.entries[0]?.method, 0, label);
    assert.deepEqual(openPackage(r.output).issues.map((i) => i.code).filter((c) => c.startsWith("PKG_MIMETYPE")), [], label);
  }
});

test("P1 normalizeArchive: 나머지 항목은 원래 순서·원래 압축 방식·원본 레코드 바이트 그대로", () => {
  const original = rebuild(MERGED, mimeLast, mimeCompressed);
  const out = normalizeArchive(original);
  const a = readArchive(original).entries;
  const b = readArchive(out).entries;
  const rest = a.filter((e) => e.name !== "mimetype");
  assert.deepEqual(b.map((e) => e.name), ["mimetype", ...rest.map((e) => e.name)]);
  assert.deepEqual(b.map((e) => e.method), [0, ...rest.map((e) => e.method)]);
  assert.ok(new Set(rest.map((e) => e.method)).size > 1, "시험 자료에 압축 방식이 섞여 있다");
  const before = localRecords(original);
  const after = localRecords(out);
  for (const e of rest) assert.ok(bytesEqual(before.get(e.name) as Uint8Array, after.get(e.name) as Uint8Array), `${e.name}의 로컬 레코드`);
  const archiveIn = readArchive(original);
  const archiveOut = readArchive(out);
  for (const e of a) assert.ok(bytesEqual(readEntry(archiveIn, original, e.name), readEntry(archiveOut, out, e.name)), `${e.name}의 풀린 내용`);
  assert.equal(new TextDecoder().decode(readEntry(archiveOut, out, "mimetype")), "application/hwp+zip");
});

test("P1 normalizeArchive: 이미 올바르면 입력과 바이트 동일, mimetype이 없으면 PKG_MIMETYPE_MISSING", () => {
  for (const name of ALL_NAMES) {
    const bytes = readFixture(name);
    assert.ok(bytesEqual(normalizeArchive(bytes), bytes), name);
  }
  const noMime = rebuild(MERGED, (names) => names.filter((n) => n !== "mimetype"));
  assert.throws(() => normalizeArchive(noMime), { code: "PKG_MIMETYPE_MISSING" });
  const r = repairDocument(noMime, { normalizePackage: true });
  assert.ok(r.unrepaired.some((i) => i.code === "PKG_MIMETYPE_MISSING"));
  assert.ok(bytesEqual(r.output, noMime));
});

test("P1 대조군: 정상 문서는 계획이 비어 있고 출력이 입력과 바이트 동일(옵션을 모두 켜도)", () => {
  const everything: RepairOptions = {
    reissueIds: true,
    fixCounts: true,
    dropStaleLineSeg: true,
    stripIllegalChars: true,
    renameBookmarks: true,
    fallbackRefs: true,
    normalizePackage: true,
  };
  for (const name of ALL_NAMES) {
    if (name === "extra/features-picture") continue; // 문단 id 중복이 실제로 있는 문서(위에서 따로 본다)
    const bytes = readFixture(name);
    for (const options of [{}, everything]) {
      const plan = planRepair(bytes, options);
      assert.deepEqual(plan.plan.edits, [], name);
      assert.deepEqual(plan.plan.additions, [], name);
      assert.deepEqual(plan.plan.summary, {}, name);
      assert.deepEqual(plan.repaired, [], name);
      assert.equal(plan.needsNormalize, false, name);
      const r = repairDocument(bytes, options);
      assert.ok(bytesEqual(r.output, bytes), `${name}: 출력이 입력과 바이트 동일`);
      assert.deepEqual(r.repaired, [], name);
    }
  }
});

test("P1 보고서를 인자로 받는 형태와 받지 않는 형태의 계획이 같다", () => {
  const bytes = withText(D1, SEC, (s) => s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"'));
  const report = validateDocument(bytes);
  const a = planRepair(bytes);
  const b = planRepair(bytes, report);
  const c = planRepair(bytes, report, { fixCounts: false });
  assert.ok(a.plan.edits.length > 0);
  assert.deepEqual(b.plan.edits, a.plan.edits);
  assert.deepEqual(b.repaired, a.repaired);
  assert.deepEqual(c.plan.edits, a.plan.edits);
});

test("P1 보정 옵션을 끄면 그 보정은 하지 않는다", () => {
  const dup = withText(D1, SEC, (s) => s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"'));
  const off = planRepair(dup, { reissueIds: false });
  assert.deepEqual(off.plan.edits, []);
  assert.ok(off.unrepaired.some((i) => i.code === "INST_DUP_ID"));
  const bm = withText(D1, SEC, addRun(bookmark("bm") + bookmark("bm")));
  assert.deepEqual(planRepair(bm, { renameBookmarks: false }).plan.edits, []);
  assert.ok(planRepair(bm).plan.edits.length > 0);
  assert.deepEqual(planRepair(withText(D1, HDR, (s) => s.replace('secCnt="1"', 'secCnt="3"')), { fixCounts: false }).plan.edits, []);
  assert.deepEqual(planRepair(STALE, { dropStaleLineSeg: false }).plan.edits, []);
  const illegal = withText(D1, SEC, (s) => s.replace("<hp:t>", `<hp:t>${CTL}`));
  const noStrip = planRepair(illegal, { stripIllegalChars: false });
  assert.deepEqual(noStrip.plan.edits, []);
  assert.ok(noStrip.unrepaired.some((i) => i.code === "XML_ILLEGAL_CHAR"));
});

test("P1 읽을 수 없는 입력은 예외 없이 오류를 그대로 돌려준다", () => {
  for (const bytes of [new TextEncoder().encode("not a zip"), new Uint8Array(0), readFixture("D1").subarray(0, 100)]) {
    const r = repairDocument(bytes);
    assert.ok(bytesEqual(r.output, bytes));
    assert.deepEqual(r.repaired, []);
    assert.ok(r.unrepaired.some((i) => i.code === "PKG_NOT_ZIP"));
    assert.equal(planRepair(bytes).plan.edits.length, 0);
  }
});

test("P1 REPAIR_REGRESSION: 보정 뒤 새 오류가 생기면 예외로 중단한다", () => {
  const good = validateDocument(D1);
  const bad = validateDocument(withText(D1, SEC, (s) => s.replace('charPrIDRef="0"', 'charPrIDRef="9999"')));
  assert.throws(
    () => checkNoRegression(good, bad),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "REPAIR_REGRESSION" && /RES_DANGLING/.test(e.message),
  );
  // 오류가 줄거나 같으면 통과한다
  checkNoRegression(bad, good);
  checkNoRegression(bad, bad);
});

test("P1 표 id를 재발급해도 같은 표의 구조 오류는 새 오류로 세지 않는다(예외 없이 unrepaired로 남는다)", () => {
  // 두 번째 표의 셀 주소를 지워 TBL_CELL을 만들고 두 표의 id를 겹치게 한다. 보정이 두 번째 표의 id를 바꾸면 오류의 위치(표 id)도 바뀐다.
  const bytes = withText(D1, SEC, (s) => {
    const t = s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"');
    const cell = '<hp:cellAddr colAddr="0" rowAddr="0"/>';
    const i = t.lastIndexOf(cell);
    return t.slice(0, i) + t.slice(i + cell.length);
  });
  const before = validateDocument(bytes);
  assert.deepEqual(codes(before.errors), ["INST_DUP_ID", "TBL_CELL"]);
  const r = repairDocument(bytes);
  assert.deepEqual(r.unrepaired.map((i) => i.code), ["TBL_CELL"]);
  assert.notEqual(r.unrepaired[0]?.where, before.errors.find((e) => e.code === "TBL_CELL")?.where, "위치의 표 id가 바뀌었다");
  assert.deepEqual(codes(r.after.errors), ["TBL_CELL"]);
});

// ── P2: 보정하지 않는 부분의 바이트 ──────────────────────────────────────

/** 보정하지 않은 항목의 로컬 레코드는 바이트 동일하고, 보정한 XML은 편집 구간 밖이 원문 그대로다. */
function assertUntouchedOutsideEdits(input: Uint8Array, output: Uint8Array, plan: EditPlan, small = true): void {
  const a = readArchive(input);
  const b = readArchive(output);
  assert.deepEqual(b.entries.map((e) => e.name), a.entries.map((e) => e.name), "항목 이름 순서 동일");
  assert.deepEqual(b.entries.map((e) => e.method), a.entries.map((e) => e.method), "압축 방식 동일");
  const edited = new Set(plan.edits.map((e) => e.entry));
  assert.ok(edited.size > 0);
  const before = localRecords(input);
  const after = localRecords(output);
  for (const e of a.entries) {
    if (edited.has(e.name)) continue;
    assert.ok(bytesEqual(before.get(e.name) as Uint8Array, after.get(e.name) as Uint8Array), `${e.name}의 로컬 레코드는 바이트 동일해야 한다`);
  }
  for (const entry of edited) {
    const original = entryText(input, entry);
    const edits = plan.edits.filter((e) => e.entry === entry).sort((x, y) => x.start - y.start || x.end - y.end);
    let expected = "";
    let pos = 0;
    let changedLength = 0;
    for (const e of edits) {
      assert.equal(original.slice(e.start, e.end), e.expected, "expected는 원문과 같다");
      expected += original.slice(pos, e.start) + e.replacement;
      pos = e.end;
      changedLength += e.end - e.start + e.replacement.length;
    }
    expected += original.slice(pos);
    assert.equal(entryText(output, entry), expected, `${entry}: 편집 구간 밖은 원문 그대로`);
    if (small) assert.ok(changedLength < original.length / 10, `${entry}: 바뀐 글자 수가 작다(재직렬화가 아니다)`);
  }
}

test("P2 보정한 XML은 편집 구간 밖이 원문 그대로이고 손대지 않은 항목은 로컬 레코드가 바이트 동일", () => {
  const sectionDefect = (s: string): string =>
    addRun(field("570", "a") + field("570", "b"))(s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"'));
  const bytes = withText(withText(D1, SEC, sectionDefect), HDR, (s) =>
    s.replace('secCnt="1"', 'secCnt="4"').replace('<hh:charProperties itemCnt="11"', '<hh:charProperties itemCnt="3"'),
  );
  const plan = planRepair(bytes);
  assert.deepEqual([...new Set(plan.plan.edits.map((e) => e.entry))].sort(), [HDR, SEC]);
  const r = repairDocument(bytes);
  assertUntouchedOutsideEdits(bytes, r.output, plan.plan);
  // 편집 구간은 속성값 안쪽 숫자 한 덩어리씩이다(요소를 다시 쓰지 않는다)
  for (const e of plan.plan.edits) assert.match(e.expected, /^\d+$/);
  assert.ok(bytesEqual(readEntry(readArchive(r.output), r.output, HPF), readEntry(readArchive(bytes), bytes, HPF)));
});

test("P2 줄 배치 캐시 삭제·금지 문자 삭제·책갈피 접미사도 편집 구간 밖은 원문 그대로", () => {
  const bytes = withText(STALE, SEC, (s) => addRun(bookmark("bm") + bookmark("bm"))(s.replace("<hp:t>짧음", `<hp:t>짧${CTL}음`)));
  const plan = planRepair(bytes);
  const r = repairDocument(bytes);
  assertUntouchedOutsideEdits(bytes, r.output, plan.plan, false); // 캐시 91개를 지우므로 바뀐 글자 수는 크다
  assert.deepEqual(codes(r.after.errors), []);
  assert.deepEqual(new Set(r.repaired.map((n) => n.kind)), new Set(["dropStaleLineSeg", "stripIllegalChars", "renameBookmarks"]));
});

test("P2 normalizePackage를 켜면 항목 내용·순서·압축 방식은 그대로이고 mimetype만 다시 쓴다", () => {
  const bytes = rebuild(MERGED, identity, mimeCompressed);
  const r = repairDocument(bytes, { normalizePackage: true });
  const a = readArchive(bytes);
  const b = readArchive(r.output);
  assert.deepEqual(b.entries.map((e) => e.name), a.entries.map((e) => e.name));
  assert.deepEqual(b.entries.map((e) => e.method), a.entries.map((e) => (e.name === "mimetype" ? 0 : e.method)));
  const before = localRecords(bytes);
  const after = localRecords(r.output);
  for (const e of a.entries) {
    if (e.name !== "mimetype") assert.ok(bytesEqual(before.get(e.name) as Uint8Array, after.get(e.name) as Uint8Array), e.name);
  }
});

test("P2 보정한 문서를 한 번 더 보정해도 바뀌지 않고, 같은 입력에서는 같은 출력이 나온다", () => {
  const bytes = withText(D1, SEC, (s) =>
    addRun(field("570", "a") + field("570", "b") + bookmark("bm") + bookmark("bm"))(s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"')),
  );
  const once = repairDocument(bytes);
  const twice = repairDocument(once.output);
  assert.ok(bytesEqual(twice.output, once.output));
  assert.deepEqual(twice.repaired, []);
  assert.ok(bytesEqual(repairDocument(bytes).output, once.output));
});

// ── P3: 기본 설정에서 fallbackRefs·normalizePackage는 동작하지 않는다 ─────────

test("P3 기본 설정에서 fallbackRefs는 동작하지 않고 없는 참조는 unrepaired로 돌려준다", () => {
  const bytes = withText(D1, SEC, (s) => s.replace('charPrIDRef="0"', 'charPrIDRef="9999"').replace('styleIDRef="0"', 'styleIDRef="77"'));
  const plan = planRepair(bytes);
  assert.deepEqual(plan.plan.edits, []);
  assert.deepEqual(plan.repaired, []);
  assert.equal(total(plan.unrepaired as ValidationIssue[], "RES_DANGLING"), 2);
  const r = repairDocument(bytes);
  assert.ok(bytesEqual(r.output, bytes));
  assert.equal(total(r.after.errors, "RES_DANGLING"), 2);
  // 켜면 동작한다
  const on = repairDocument(bytes, { fallbackRefs: true });
  assert.equal(total(on.after.errors, "RES_DANGLING"), 0);
  assert.ok(!bytesEqual(on.output, bytes));
});

test("P3 기본 설정에서 normalizePackage는 동작하지 않고 mimetype 위반은 unrepaired로 돌려준다", () => {
  const bytes = rebuild(MERGED, mimeLast, mimeCompressed);
  const plan = planRepair(bytes);
  assert.equal(plan.needsNormalize, false);
  assert.deepEqual(plan.plan.edits, []);
  assert.deepEqual(plan.repaired, []);
  assert.deepEqual(codes(plan.unrepaired as ValidationIssue[]), ["PKG_MIMETYPE_COMPRESSED", "PKG_MIMETYPE_ORDER"]);
  const r = repairDocument(bytes);
  assert.ok(bytesEqual(r.output, bytes));
  assert.deepEqual(codes(r.after.errors), ["PKG_MIMETYPE_COMPRESSED", "PKG_MIMETYPE_ORDER"]);
  assert.deepEqual(repairDocument(bytes, { normalizePackage: true }).after.errors, []);
});

test("P3 기본 설정은 id만 고치고 없는 참조는 보고만 한다", () => {
  const bytes = withText(D1, SEC, (s) => s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"').replace('charPrIDRef="0"', 'charPrIDRef="9999"'));
  const r = repairDocument(bytes);
  assert.deepEqual(new Set(r.repaired.map((n) => n.kind)), new Set(["reissueIds"]));
  assert.equal(total(r.after.errors, "INST_DUP_ID"), 0);
  assert.equal(total(r.after.errors, "RES_DANGLING"), 1, "없는 참조는 기본으로 두고 보고만 한다");
  assert.deepEqual(r.unrepaired.map((i) => i.code), ["RES_DANGLING"]);
});

// ── P5: 보고서 ──────────────────────────────────────────────────────────

const SECRET_NAME = "비밀책갈피이름";
const SECRET_TEXT = "민감한본문내용";
const SECRET_FIELD = "누름틀이름";

test("P5 보고서에는 종류·위치·건수가 있고 문서의 글·이름 원문은 없다", () => {
  const sectionDefect = (s: string): string =>
    addRun(
      bookmark(SECRET_NAME) + bookmark(SECRET_NAME) + field("570", SECRET_FIELD) + field("570", SECRET_FIELD) + `<hp:t>${SECRET_TEXT}${CTL}</hp:t>`,
    )(s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"'));
  const bytes = withText(withText(D1, SEC, sectionDefect), HDR, (s) => s.replace('secCnt="1"', 'secCnt="3"'));
  const plan = planRepair(bytes);
  const r = repairDocument(bytes);
  assert.deepEqual(plan.repaired, r.repaired);

  assert.deepEqual(new Set(r.repaired.map((n) => n.kind)), new Set(["reissueIds", "fixCounts", "stripIllegalChars", "renameBookmarks"]));
  for (const n of r.repaired as RepairNote[]) {
    assert.match(n.entry, /^(Contents\/(header|section\d+)\.xml|mimetype)$/, "위치: ZIP 항목 이름");
    assert.ok(n.what.length > 0);
    assert.ok(Number.isInteger(n.count) && n.count > 0, "건수");
    assert.ok(n.detail.length > 0);
  }
  // 건수: 표 id 1 + 누름틀 id 1 = 재발급 2, 책갈피 1, 금지 문자 1, 구역 수 1
  const sum = (kind: string, what: string): number => r.repaired.filter((n) => n.kind === kind && n.what === what).reduce((a, n) => a + n.count, 0);
  assert.equal(sum("reissueIds", "object id") + sum("reissueIds", "field id"), 2);
  assert.equal(sum("renameBookmarks", "bookmark name"), 1);
  assert.equal(sum("stripIllegalChars", "control char"), 1);
  assert.equal(sum("fixCounts", "secCnt"), 1);
  assert.deepEqual(plan.plan.summary, { reissuedIds: 2, fixedCounts: 1, strippedChars: 1, renamedBookmarks: 1 });

  // 값 원문(책갈피·누름틀 이름, 본문 글)은 어디에도 없다
  const dump = JSON.stringify({ repaired: r.repaired, unrepaired: r.unrepaired, summary: plan.plan.summary, issues: plan.plan.issues });
  for (const secret of [SECRET_NAME, SECRET_TEXT, SECRET_FIELD]) assert.ok(!dump.includes(secret), `보고서에 ${secret} 원문이 있다`);
  // id 값(숫자)은 상세에 남는다
  assert.match(r.repaired.find((n) => n.what === "object id")?.detail ?? "", /^\d+→\d+$/);
});

test("P5 보정하지 못한 오류는 unrepaired에 코드와 함께 남는다", () => {
  const bytes = withText(D1, SEC, (s) => s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"').replace(/<hp:cellAddr colAddr="0" rowAddr="0"\/>/, ""));
  const r = repairDocument(bytes);
  assert.deepEqual(r.unrepaired.map((i) => i.code), ["TBL_CELL"]);
  assert.ok(r.unrepaired.every((i) => i.severity === "error" && typeof i.message === "string"));
  assert.deepEqual(codes(r.after.errors), ["TBL_CELL"]);
  assert.deepEqual(r.repaired.map((n) => n.kind), ["reissueIds"]);
});

test("P5 깨진 XML·필수 항목 없음·필드 짝 오류는 보정하지 않고 unrepaired로 돌려준다", () => {
  const broken = withText(D1, SEC, (s) => s.trimEnd().slice(0, -"</hs:sec>".length));
  const rb = repairDocument(broken);
  assert.ok(rb.unrepaired.some((i) => i.code === "XML_MALFORMED"));
  assert.ok(bytesEqual(rb.output, broken));

  const noHeader = buildZip(entriesOf(D1).filter((e) => e.name !== HDR));
  assert.ok(repairDocument(noHeader).unrepaired.some((i) => i.code === "PKG_MISSING"));

  const unpaired = withText(D1, SEC, addRun('<hp:ctrl><hp:fieldBegin id="556" type="CLICK_HERE" name="f2" fieldid="2"/></hp:ctrl>'));
  const r = repairDocument(unpaired);
  assert.deepEqual(r.repaired, []);
  assert.ok(r.unrepaired.some((i) => i.code === "FIELD_UNPAIRED_BEGIN"));
  assert.ok(bytesEqual(r.output, unpaired));
});
