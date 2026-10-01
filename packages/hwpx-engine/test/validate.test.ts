import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openPackage, parseDocument, readArchive, readEntry, rewriteArchive, walkParagraphs } from "../src/index.ts";
import { compareToBaseline, validateDocument, type ValidationIssue, type ValidationReport } from "../src/validate/index.ts";
import { FIXTURE_NAMES, buildZip, cdRecordOf, mutateEntryText, readFixture, utf8, type RawEntry } from "./helpers.ts";

const SEC = "Contents/section0.xml";
const HDR = "Contents/header.xml";
const HPF = "Contents/content.hpf";
const PREVIEW = "Preview/PrvText.txt";

const HANCOM_NAMES = ["blocks", "field-states", "header-footer", "ph-mixed", "ph-single", "ph-table", "picture"].map((n) => `hancom/${n}`);
const EXTRA_NAMES = ["features-picture", "features-rhwp"].map((n) => `extra/${n}`);
/** 시험 문서 18개: 주 폴더 9 + hancom/ 7 + extra/ 2 */
const ALL_NAMES: string[] = [...FIXTURE_NAMES, ...HANCOM_NAMES, ...EXTRA_NAMES];

/** 8.1절이 더한 검사 4종의 코드. 기존 Python 검사기에는 없으므로 Python 대조에서 뺀다. */
const ADDED_CODES = ["PKG_SECCNT_MISMATCH", "XML_ILLEGAL_CHAR", "PKG_NO_PREVIEW_TEXT", "TBL_ATTR_MISSING"];

// ── 보조 ────────────────────────────────────────────────────────────────

function codeSet(list: ValidationIssue[]): string[] {
  return [...new Set(list.map((i) => i.code))].sort();
}

function total(list: ValidationIssue[], code: string): number {
  return list.filter((i) => i.code === code).reduce((a, i) => a + i.count, 0);
}

function describeReport(r: ValidationReport): string {
  return `오류 ${JSON.stringify(codeSet(r.errors))} 경고 ${JSON.stringify(codeSet(r.warnings))}`;
}

/** 패키지의 파일 항목(디렉터리 항목 제외)을 풀어 낸다. */
function entriesOf(bytes: Uint8Array): RawEntry[] {
  const archive = readArchive(bytes);
  return archive.entries
    .filter((e) => !e.isDirectory)
    .map((e) => ({ name: e.name, data: readEntry(archive, bytes, e.name), method: e.method }));
}

/** Python 쪽 hwpxzip.write_all과 같은 규칙으로 다시 묶는다: mimetype 첫 항목·무압축, 나머지는 압축. */
function rebuild(entries: RawEntry[]): Uint8Array {
  const ordered = [...entries].sort((a, b) => Number(a.name !== "mimetype") - Number(b.name !== "mimetype"));
  return buildZip(ordered.map((e) => ({ name: e.name, data: e.data, method: e.name === "mimetype" ? 0 : 8 })));
}

function editText(entries: RawEntry[], name: string, change: (text: string) => string): void {
  const e = entries.find((x) => x.name === name);
  assert.ok(e !== undefined, `${name} 항목이 없다`);
  const before = new TextDecoder().decode(e.data);
  const after = change(before);
  assert.notEqual(after, before, `변형이 ${name}에 적용되지 않았다`);
  e.data = utf8(after);
}

function dropEntry(entries: RawEntry[], name: string): void {
  const i = entries.findIndex((x) => x.name === name);
  assert.ok(i >= 0, `${name} 항목이 없다`);
  entries.splice(i, 1);
}

/** 한 항목의 텍스트만 바꾼 사본(원래 ZIP 구조 유지) */
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

// ── Python 검사기(오라클) ────────────────────────────────────────────────

const ORACLE = fileURLToPath(new URL("../../../tools/oracle/validate_refs.py", import.meta.url));

function findPython(): string | null {
  for (const exe of ["python", "python3"]) {
    const r = spawnSync(exe, ["--version"], { encoding: "utf8" });
    if (r.error === undefined && r.status === 0) return exe;
  }
  return null;
}

const PYTHON = findPython();
const SKIP_PYTHON = PYTHON === null ? "Python이 없어 건너뜀(미검증)" : false;

type PyIssue = { code: string; msg: string; where: string; count: number };
type PyResult = {
  file: string;
  ok: boolean;
  errors: PyIssue[];
  warnings: PyIssue[];
  stats: {
    zip_entries: number;
    sections: number;
    manifest_items: number;
    ref_checks: Record<string, number>;
    paragraphs: number;
    tables: number;
    table_depth_max: number;
    field_pairs: number;
    bookmarks: number;
    unknown_controls: Record<string, number>;
  };
};

/** 파일 경로 목록을 Python 검사기 한 번으로 돌린다. 결과 JSON은 OS 임시 폴더에 쓰고 지운다. */
function runPython(files: string[], strict: boolean): PyResult[] {
  assert.ok(PYTHON !== null);
  const dir = mkdtempSync(join(tmpdir(), "hwpx-validate-"));
  try {
    const out = join(dir, "result.json");
    const args = [ORACLE, ...files, "--quiet", "--json", out, ...(strict ? ["--strict"] : [])];
    const r = spawnSync(PYTHON, args, { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.equal(r.error, undefined, "Python 실행 실패");
    const parsed = JSON.parse(readFileSync(out, "utf8")) as { results: PyResult[] };
    assert.equal(parsed.results.length, files.length);
    return parsed.results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Counts = Record<string, { entries: number; total: number }>;

/** 코드별로 (합쳐진 항목 수, 발생 횟수 합). 추가 검사 4종은 뺀다. */
function countsOf(list: { code: string; count: number }[]): Counts {
  const out: Counts = {};
  for (const i of list) {
    if (ADDED_CODES.includes(i.code)) continue;
    const c = (out[i.code] ??= { entries: 0, total: 0 });
    c.entries++;
    c.total += i.count;
  }
  return out;
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}.hwpx`, import.meta.url));
}

let pyBase: PyResult[] | undefined;
let pyStrict: PyResult[] | undefined;
function pyResults(strict: boolean): PyResult[] {
  if (strict) return (pyStrict ??= runPython(ALL_NAMES.map(fixturePath), true));
  return (pyBase ??= runPython(ALL_NAMES.map(fixturePath), false));
}

// ── V1: Python 검사기와 같은 결과 ─────────────────────────────────────────

ALL_NAMES.forEach((name, index) => {
  test(`V1 Python 검사기와 코드별 개수가 같다: ${name}`, { skip: SKIP_PYTHON }, () => {
    for (const strict of [false, true]) {
      const py = pyResults(strict)[index];
      assert.ok(py !== undefined);
      const ts = validateDocument(readFixture(name), { strict });
      const label = `${name} strict=${strict}`;
      assert.deepEqual(countsOf(ts.errors), countsOf(py.errors), `${label} 오류 코드별 개수`);
      assert.deepEqual(countsOf(ts.warnings), countsOf(py.warnings), `${label} 경고 코드별 개수`);
      // 보조 지표도 같다
      assert.equal(ts.census.paragraphs, py.stats.paragraphs, `${label} 문단 수`);
      assert.equal(ts.census.tables, py.stats.tables, `${label} 표 수`);
      assert.equal(ts.census.fieldPairs, py.stats.field_pairs, `${label} 필드 수`);
      assert.equal(ts.census.bookmarks, py.stats.bookmarks, `${label} 책갈피 수`);
      assert.deepEqual(ts.census.unknownControls, py.stats.unknown_controls, `${label} 모르는 컨트롤`);
      assert.deepEqual(ts.stats.refChecks, py.stats.ref_checks, `${label} 참조 확인 횟수`);
      assert.equal(ts.stats.zipEntries, py.stats.zip_entries);
      assert.equal(ts.stats.sections, py.stats.sections);
      assert.equal(ts.stats.manifestItems, py.stats.manifest_items);
      assert.equal(ts.stats.tableDepthMax, py.stats.table_depth_max);
    }
  });
});

// ── V2: 반례 26건 ───────────────────────────────────────────────────────

const FIELD_RUN =
  '<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="555" type="CLICK_HERE" name="f1" editable="1" dirty="0" zorder="-1" fieldid="1"/></hp:ctrl>' +
  "<hp:t>값</hp:t><hp:ctrl><hp:fieldEnd beginIDRef=\"555\" fieldid=\"1\"/></hp:ctrl></hp:run>";
const IMG =
  '<hp:run charPrIDRef="0"><hp:pic id="9001" zOrder="0"><hc:img xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" binaryItemIDRef="image99" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/></hp:pic></hp:run>';

function dupParaIds(s: string): string {
  const t = s.replace("<hp:p ", '<hp:p id="777" ');
  const i = t.indexOf("<hp:p ", t.indexOf('id="777"') + 10);
  assert.ok(i >= 0);
  return t.slice(0, i) + '<hp:p id="777" ' + t.slice(i + 6);
}

type NegCase = {
  name: string;
  /** null이면 통과해야 하는 대조군. PKG_BINDATA_ORPHAN은 경고만 나오고 오류는 없어야 한다. 그 밖은 이 코드의 오류(severity가 warning이면 경고). */
  expect: string | null;
  severity?: "warning";
  build: () => Uint8Array;
};

/** D1 사본의 항목을 바꿔 다시 묶는다. */
function fromD1(mutate: (entries: RawEntry[]) => void): Uint8Array {
  const entries = entriesOf(readFixture("D1"));
  mutate(entries);
  return rebuild(entries);
}

const secEdit = (change: (s: string) => string) => (): Uint8Array => fromD1((e) => editText(e, SEC, change));
const hdrEdit = (change: (s: string) => string) => (): Uint8Array => fromD1((e) => editText(e, HDR, change));

const NEGATIVE_CASES: NegCase[] = [
  { name: "대조군: 무변형", expect: null, build: () => fromD1(() => {}) },
  { name: "대조군: 짝이 맞는 필드 추가", expect: null, build: secEdit(addBeforeFirstParaEnd(FIELD_RUN)) },
  { name: "존재하지 않는 charPrIDRef", expect: "RES_DANGLING", build: secEdit((s) => s.replace('charPrIDRef="0"', 'charPrIDRef="9999"')) },
  { name: "존재하지 않는 paraPrIDRef", expect: "RES_DANGLING", build: secEdit((s) => s.replace('paraPrIDRef="0"', 'paraPrIDRef="9999"')) },
  { name: "존재하지 않는 styleIDRef", expect: "RES_DANGLING", build: secEdit((s) => s.replace('styleIDRef="0"', 'styleIDRef="77"')) },
  {
    name: "존재하지 않는 borderFillIDRef(표 셀)",
    expect: "RES_DANGLING",
    build: secEdit((s) => s.replace(/(<hp:tc [^>]*borderFillIDRef=")(\d+)/, (_m, head: string) => `${head}88`)),
  },
  { name: "존재하지 않는 binaryItemIDRef", expect: "RES_DANGLING", build: secEdit(addBeforeFirstParaEnd(IMG)) },
  {
    name: "header heading 이 없는 numbering 을 가리킴",
    expect: "RES_DANGLING",
    build: hdrEdit((s) => s.replace('<hh:heading type="NONE" idRef="0" level="0"/>', '<hh:heading type="NUMBER" idRef="42" level="0"/>')),
  },
  { name: "header 에 없는 fontRef", expect: "RES_DANGLING", build: hdrEdit((s) => s.replace('<hh:fontRef hangul="0"', '<hh:fontRef hangul="9"')) },
  { name: "header charPr id 중복", expect: "RES_DUP_ID", build: hdrEdit((s) => s.replace('<hh:charPr id="1"', '<hh:charPr id="0"')) },
  { name: "중복 문단 id", expect: "INST_DUP_ID", build: secEdit(dupParaIds) },
  { name: "중복 표 id", expect: "INST_DUP_ID", build: secEdit((s) => s.replace(/<hp:tbl id="\d+"/g, '<hp:tbl id="424242"')) },
  {
    name: "짝이 없는 fieldEnd",
    expect: "FIELD_UNPAIRED_END",
    build: secEdit(addBeforeFirstParaEnd('<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd beginIDRef="555" fieldid="1"/></hp:ctrl></hp:run>')),
  },
  {
    name: "짝이 없는 fieldBegin",
    expect: "FIELD_UNPAIRED_BEGIN",
    build: secEdit(
      addBeforeFirstParaEnd('<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="556" type="CLICK_HERE" name="f2" fieldid="2"/></hp:ctrl></hp:run>'),
    ),
  },
  {
    name: "fieldEnd 가 fieldBegin 보다 앞",
    expect: "FIELD_ORDER",
    build: secEdit(
      addBeforeFirstParaEnd(
        '<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd beginIDRef="557" fieldid="3"/></hp:ctrl><hp:ctrl><hp:fieldBegin id="557" type="CLICK_HERE" name="f3" fieldid="3"/></hp:ctrl></hp:run>',
      ),
    ),
  },
  {
    name: "중복 북마크 이름",
    expect: "BOOKMARK_DUP",
    build: secEdit(
      addBeforeFirstParaEnd('<hp:run charPrIDRef="0"><hp:ctrl><hp:bookmark name="bm"/></hp:ctrl><hp:ctrl><hp:bookmark name="bm"/></hp:ctrl></hp:run>'),
    ),
  },
  {
    name: "표 셀이 colCnt 를 넘음",
    expect: "TBL_CELL_RANGE",
    build: secEdit((s) => s.replace('<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1"', '<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="99"')),
  },
  { name: "XML 깨짐(닫는 태그 없음)", expect: "XML_MALFORMED", build: secEdit((s) => s.trimEnd().slice(0, -"</hs:sec>".length)) },
  { name: "section 파일 삭제", expect: "PKG_MISSING", build: () => fromD1((e) => dropEntry(e, SEC)) },
  { name: "header.xml 삭제", expect: "PKG_MISSING", build: () => fromD1((e) => dropEntry(e, HDR)) },
  {
    name: "manifest 가 없는 BinData 를 가리킴",
    expect: "PKG_MANIFEST_HREF_MISSING",
    build: () =>
      fromD1((e) =>
        editText(e, HPF, (s) => s.replace("</opf:manifest>", '<opf:item id="img1" href="BinData/image1.png" media-type="image/png"/></opf:manifest>')),
      ),
  },
  {
    name: "BinData 가 manifest 에 없음(경고)",
    expect: "PKG_BINDATA_ORPHAN",
    build: () => fromD1((e) => e.push({ name: "BinData/orphan.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), method: 8 })),
  },
  {
    name: "mimetype 이 압축됨",
    expect: "PKG_MIMETYPE_COMPRESSED",
    build: () => buildZip(entriesOf(readFixture("D1")).map((e) => ({ name: e.name, data: e.data, method: 8 as const }))),
  },
  {
    name: "mimetype 이 첫 항목이 아님",
    expect: "PKG_MIMETYPE_ORDER",
    build: () =>
      buildZip(
        [...entriesOf(readFixture("D1"))]
          .sort((a, b) => Number(a.name === "mimetype") - Number(b.name === "mimetype"))
          .map((e) => ({ name: e.name, data: e.data, method: 0 as const })),
      ),
  },
  {
    name: "ZIP 항목 바이트 훼손(CRC 불일치)",
    expect: "PKG_CRC",
    build: () => {
      const raw = Buffer.from(readFixture("D1"));
      const at = raw.indexOf('textDirection="HORIZONTAL"');
      assert.ok(at >= 0, "D1은 무압축 항목이라 원문이 그대로 보여야 한다");
      raw.write('textDirection="HORIZONTAM"', at);
      return new Uint8Array(raw);
    },
  },
  { name: "ZIP 이 아닌 파일", expect: "PKG_NOT_ZIP", build: () => utf8("not a zip") },
];

test("V2 반례는 Python 반례 스크립트와 같은 26건이다", () => {
  assert.equal(NEGATIVE_CASES.length, 26);
});

function checkCase(c: NegCase): void {
  const r = validateDocument(c.build());
  const detail = describeReport(r);
  if (c.expect === null) {
    assert.deepEqual(r.errors, [], `대조군은 오류가 없어야 한다. ${detail}`);
  } else if (c.expect === "PKG_BINDATA_ORPHAN") {
    assert.ok(codeSet(r.warnings).includes(c.expect), `경고 ${c.expect}가 나와야 한다. ${detail}`);
    assert.deepEqual(r.errors, [], `경고만 나와야 한다. ${detail}`);
  } else if (c.severity === "warning") {
    assert.ok(codeSet(r.warnings).includes(c.expect), `경고 ${c.expect}가 나와야 한다. ${detail}`);
  } else {
    assert.ok(r.errors.length > 0 && codeSet(r.errors).includes(c.expect), `오류 ${c.expect}가 나와야 한다. ${detail}`);
  }
}

NEGATIVE_CASES.forEach((c, i) => {
  test(`V2 반례 ${String(i + 1).padStart(2, "0")} ${c.name}: ${c.expect ?? "통과"}`, () => checkCase(c));
});

// Python 반례 스크립트가 다루지 않는 기존 검사 코드. 같은 방식으로 D1 사본을 변형해 TS의 기대 코드와 Python 결과를 함께 본다.
const nestedTable = (depth: number): string =>
  `<hp:tbl id="${9000 + depth}" rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>` +
  `<hp:subList><hp:p><hp:run>${depth > 1 ? nestedTable(depth - 1) : ""}</hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl>`;
const insertRuns = (xml: string) => secEdit(addBeforeFirstParaEnd(`<hp:run charPrIDRef="0">${xml}</hp:run>`));

const PARITY_CASES: NegCase[] = [
  { name: "ZIP 항목이 없음", expect: "PKG_EMPTY", build: () => buildZip([]) },
  { name: "mimetype 항목 없음", expect: "PKG_MIMETYPE_MISSING", build: () => fromD1((e) => dropEntry(e, "mimetype")) },
  {
    name: "mimetype 값이 다름",
    expect: "PKG_MIMETYPE_VALUE",
    severity: "warning",
    build: () => fromD1((e) => editText(e, "mimetype", () => "application/zip")),
  },
  {
    name: "rootfile 이 없는 항목을 가리킴",
    expect: "PKG_ROOTFILE",
    build: () => fromD1((e) => editText(e, "META-INF/container.xml", (s) => s.replace("Contents/content.hpf", "Contents/other.hpf"))),
  },
  {
    name: "manifest id 중복",
    expect: "PKG_MANIFEST_DUP_ID",
    build: () => fromD1((e) => editText(e, HPF, (s) => s.replace('<opf:item id="section0"', '<opf:item id="header"'))),
  },
  {
    name: "spine 이 없는 id 를 가리킴",
    expect: "PKG_SPINE_IDREF",
    build: () => fromD1((e) => editText(e, HPF, (s) => s.replace('<opf:itemref idref="section0"', '<opf:itemref idref="nope"'))),
  },
  {
    name: "section 파일이 manifest 에 없음",
    expect: "PKG_SECTION_NOT_IN_MANIFEST",
    build: () => fromD1((e) => e.push({ name: "Contents/section1.xml", data: e.find((x) => x.name === SEC)?.data ?? new Uint8Array(0), method: 8 })),
  },
  { name: "secCnt 불일치", expect: "PKG_SECCNT", severity: "warning", build: hdrEdit((s) => s.replace('secCnt="1"', 'secCnt="3"')) },
  { name: "refList 없음", expect: "RES_NO_REFLIST", build: hdrEdit((s) => s.replace(/<(\/?)hh:refList>/g, "<$1hh:refListX>")) },
  { name: "자원에 id 가 없음", expect: "RES_NO_ID", build: hdrEdit((s) => s.replace('<hh:charPr id="1"', "<hh:charPr")) },
  {
    name: "itemCnt 불일치",
    expect: "RES_ITEMCNT",
    severity: "warning",
    build: hdrEdit((s) => s.replace('<hh:charProperties itemCnt="11"', '<hh:charProperties itemCnt="12"')),
  },
  { name: "빈 참조 값", expect: "RES_EMPTY_REF", severity: "warning", build: secEdit((s) => s.replace('styleIDRef="0"', 'styleIDRef=""')) },
  { name: "없는 memoShapeIDRef", expect: "RES_DANGLING", build: secEdit((s) => s.replace('memoShapeIDRef="0"', 'memoShapeIDRef="5"')) },
  { name: "0 이 아닌 tabPrIDRef 는 용인하지 않음", expect: "RES_DANGLING", build: hdrEdit((s) => s.replace('tabPrIDRef="0"', 'tabPrIDRef="1"')) },
  {
    name: "header heading BULLET 이 없는 bullet 을 가리킴",
    expect: "RES_DANGLING",
    build: hdrEdit((s) => s.replace(/<hh:heading type="\w+" idRef="\d+"/, '<hh:heading type="BULLET" idRef="9"')),
  },
  { name: "font id 중복", expect: "RES_DUP_ID", build: hdrEdit((s) => s.replace('<hh:font id="1"', '<hh:font id="0"')) },
  { name: "북마크 이름이 비어 있음", expect: "BOOKMARK_NO_NAME", build: insertRuns('<hp:ctrl><hp:bookmark name=""/></hp:ctrl>') },
  {
    name: "fieldBegin 하나에 fieldEnd 둘",
    expect: "FIELD_MULTI_END",
    build: insertRuns(
      '<hp:ctrl><hp:fieldBegin id="560" type="CLICK_HERE" name="m" fieldid="1"/></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="560" fieldid="1"/></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="560" fieldid="1"/></hp:ctrl>',
    ),
  },
  {
    name: "fieldid 불일치",
    expect: "FIELD_FIELDID_MISMATCH",
    severity: "warning",
    build: insertRuns(
      '<hp:ctrl><hp:fieldBegin id="561" type="CLICK_HERE" name="m" fieldid="1"/></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="561" fieldid="2"/></hp:ctrl>',
    ),
  },
  {
    name: "필드 id 중복",
    expect: "INST_DUP_ID",
    build: insertRuns(
      '<hp:ctrl><hp:fieldBegin id="570" type="CLICK_HERE" name="a" fieldid="1"/></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="570" fieldid="1"/></hp:ctrl>' +
        '<hp:ctrl><hp:fieldBegin id="570" type="CLICK_HERE" name="b" fieldid="1"/></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="570" fieldid="1"/></hp:ctrl>',
    ),
  },
  { name: "instId 중복(대소문자 표기가 달라도)", expect: "INST_DUP_ID", build: insertRuns('<hp:rect id="8001" instId="77"/><hp:rect id="8002" instid="77"/>') },
  {
    name: "객체 id·instId 0 중복",
    expect: "INST_DUP_PLACEHOLDER",
    severity: "warning",
    build: insertRuns('<hp:rect id="0" instId="0"/><hp:rect id="0" instId="0"/>'),
  },
  {
    name: "대조군: 자리값 문단 id 중복은 오류가 아님",
    expect: null,
    build: secEdit((s) => {
      const t = s.replace("<hp:p ", '<hp:p id="0" ');
      const i = t.indexOf("<hp:p ", t.indexOf('id="0"') + 10);
      return t.slice(0, i) + '<hp:p id="0" ' + t.slice(i + 6);
    }),
  },
  { name: "표 rowCnt 불일치", expect: "TBL_ROWCNT", severity: "warning", build: secEdit((s) => s.replace('rowCnt="8"', 'rowCnt="9"')) },
  { name: "표 colCnt 불일치", expect: "TBL_COLCNT", severity: "warning", build: secEdit((s) => s.replace('colCnt="5"', 'colCnt="6"')) },
  { name: "tc 에 cellAddr 가 없음", expect: "TBL_CELL", build: secEdit((s) => s.replace('<hp:cellAddr colAddr="0" rowAddr="0"/>', "")) },
  { name: "표 중첩 깊이 4", expect: "TBL_DEPTH", severity: "warning", build: insertRuns(nestedTable(4)) },
  { name: "모르는 컨트롤", expect: "UNKNOWN_CONTROL", severity: "warning", build: insertRuns("<hp:foo/>") },
];

PARITY_CASES.forEach((c, i) => {
  test(`V2 보강 반례 ${String(i + 1).padStart(2, "0")} ${c.name}: ${c.expect ?? "통과"}`, () => checkCase(c));
});

test("V2 반례(26건 + 보강)의 코드별 개수가 Python 검사기와 같다", { skip: SKIP_PYTHON }, () => {
  const cases = [...NEGATIVE_CASES, ...PARITY_CASES];
  const dir = mkdtempSync(join(tmpdir(), "hwpx-validate-neg-"));
  try {
    const files = cases.map((_, i) => join(dir, `neg_${String(i).padStart(2, "0")}.hwpx`));
    cases.forEach((c, i) => writeFileSync(files[i] ?? "", c.build()));
    for (const strict of [false, true]) {
      const py = runPython(files, strict);
      cases.forEach((c, i) => {
        const ts = validateDocument(readFileSync(files[i] ?? ""), { strict });
        const p = py[i];
        assert.ok(p !== undefined);
        assert.deepEqual(countsOf(ts.errors), countsOf(p.errors), `${c.name} strict=${strict} 오류`);
        assert.deepEqual(countsOf(ts.warnings), countsOf(p.warnings), `${c.name} strict=${strict} 경고`);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── V3: 추가 검사 4종 ────────────────────────────────────────────────────

test("V3 정상 문서 18개에서는 추가 검사 4종이 나오지 않는다", () => {
  for (const name of ALL_NAMES) {
    const r = validateDocument(readFixture(name));
    for (const code of ADDED_CODES) {
      assert.equal(total(r.errors, code) + total(r.warnings, code), 0, `${name}: ${code}`);
    }
  }
});

test("V3 PKG_SECCNT_MISMATCH: header 의 구역 수 선언과 실제 구역 항목 수가 다르면 오류", () => {
  const d1 = readFixture("D1");
  const declaredTwo = validateDocument(withText(d1, HDR, (s) => s.replace('secCnt="1"', 'secCnt="2"')));
  assert.equal(total(declaredTwo.errors, "PKG_SECCNT_MISMATCH"), 1, describeReport(declaredTwo));
  // 기존 Python 검사기의 경고 코드도 그대로 나온다
  assert.equal(total(declaredTwo.warnings, "PKG_SECCNT"), 1);

  // 구역 항목이 하나 더 있는 경우(선언은 1)
  const archive = readArchive(d1);
  const sectionText = readEntry(archive, d1, SEC);
  const extraSection = rewriteArchive(d1, archive, { add: [{ name: "Contents/section1.xml", data: sectionText, method: 8 }] });
  const actualTwo = validateDocument(extraSection);
  assert.equal(total(actualTwo.errors, "PKG_SECCNT_MISMATCH"), 1, describeReport(actualTwo));

  // 정상: 선언과 같거나 숫자가 아닌 선언은 이 코드로 보고하지 않는다
  assert.equal(total(validateDocument(d1).errors, "PKG_SECCNT_MISMATCH"), 0);
  const notNumber = validateDocument(withText(d1, HDR, (s) => s.replace('secCnt="1"', 'secCnt="x"')));
  assert.equal(total(notNumber.errors, "PKG_SECCNT_MISMATCH"), 0);
});

test("V3 XML_ILLEGAL_CHAR: 금지 제어문자는 오류(문자 그대로, 숫자 참조, U+FFFE)", () => {
  const d1 = readFixture("D1");
  for (const [label, insert] of [
    ["문자 그대로", "\u0001"],
    ["숫자 참조", "&#1;"],
    ["U+FFFE", "￾"],
  ] as const) {
    const r = validateDocument(withText(d1, SEC, (s) => s.replace("<hp:t>", `<hp:t>${insert}`)));
    const hit = r.errors.filter((e) => e.code === "XML_ILLEGAL_CHAR");
    assert.equal(hit.length, 1, `${label}: ${describeReport(r)}`);
    assert.equal(hit[0]?.where, SEC);
    // 기존 Python 검사기가 내는 코드도 그대로 낸다
    assert.ok(codeSet(r.errors).includes("XML_MALFORMED"), label);
  }
  // 탭·줄바꿈은 허용 문자다
  const ok = validateDocument(withText(d1, SEC, (s) => s.replace("<hp:t>", "<hp:t>\t\n")));
  assert.equal(total(ok.errors, "XML_ILLEGAL_CHAR"), 0);
});

test("V3 PKG_NO_PREVIEW_TEXT: 미리보기 텍스트 항목이 없으면 경고(오류 아님)", () => {
  for (const [name, otherErrors] of [
    ["D1", []],
    // 한컴 저장본은 container.xml이 미리보기 항목을 rootfile로 올려 두므로, 기존 검사(PKG_ROOTFILE)가 따로 오류를 낸다
    ["hancom-field", ["PKG_ROOTFILE"]],
  ] as const) {
    const entries = entriesOf(readFixture(name));
    dropEntry(entries, PREVIEW);
    const r = validateDocument(rebuild(entries));
    assert.equal(total(r.warnings, "PKG_NO_PREVIEW_TEXT"), 1, `${name}: ${describeReport(r)}`);
    assert.equal(total(r.errors, "PKG_NO_PREVIEW_TEXT"), 0);
    assert.deepEqual(codeSet(r.errors), [...otherErrors], `${name}: 이 검사 자체는 오류를 만들지 않는다`);
    assert.equal(total(validateDocument(readFixture(name)).warnings, "PKG_NO_PREVIEW_TEXT"), 0);
  }
});

test("V3 TBL_ATTR_MISSING: 표의 rowCnt·colCnt 속성이 없으면 오류", () => {
  const d1 = readFixture("D1");
  const noRow = validateDocument(withText(d1, SEC, (s) => s.replace(/ rowCnt="\d+"/, "")));
  assert.equal(total(noRow.errors, "TBL_ATTR_MISSING"), 1, describeReport(noRow));
  assert.match(noRow.errors.find((e) => e.code === "TBL_ATTR_MISSING")?.message ?? "", /rowCnt/);
  const noCol = validateDocument(withText(d1, SEC, (s) => s.replace(/ colCnt="\d+"/, "")));
  assert.equal(total(noCol.errors, "TBL_ATTR_MISSING"), 1, describeReport(noCol));
  assert.match(noCol.errors.find((e) => e.code === "TBL_ATTR_MISSING")?.message ?? "", /colCnt/);
  const neither = validateDocument(withText(d1, SEC, (s) => s.replace(/ rowCnt="\d+" colCnt="\d+"/, "")));
  assert.equal(total(neither.errors, "TBL_ATTR_MISSING"), 2);
  assert.equal(total(validateDocument(d1).errors, "TBL_ATTR_MISSING"), 0);
});

// ── V4: 기준선 비교 ──────────────────────────────────────────────────────

test("V4 compareToBaseline: 원래 있던 오류는 preexisting, 새 결함은 newErrors", () => {
  const original = readFixture("extra/features-picture");
  const before = validateDocument(original);
  assert.deepEqual(codeSet(before.errors), ["INST_DUP_ID"], "시험 문서는 문단 id 중복 오류를 원래 갖고 있다");

  // 편집이 없으면 새 오류도 해결된 오류도 없다
  const same = compareToBaseline(before, validateDocument(original));
  assert.deepEqual(same.newErrors, []);
  assert.deepEqual(same.resolved, []);
  assert.deepEqual(codeSet(same.preexisting), ["INST_DUP_ID"]);

  // 새 결함: 없는 글자모양을 가리키게 한다
  const broken = withText(original, SEC, (s) => s.replace('charPrIDRef="0"', 'charPrIDRef="9999"'));
  const after = validateDocument(broken);
  const cmp = compareToBaseline(before, after);
  assert.deepEqual(codeSet(cmp.newErrors), ["RES_DANGLING"]);
  assert.deepEqual(codeSet(cmp.preexisting), ["INST_DUP_ID"]);
  assert.deepEqual(cmp.resolved, []);

  // 원래 오류를 고치면 resolved
  const fixed = withText(original, SEC, (s) => {
    const first = s.indexOf('id="1444489269"');
    const second = s.indexOf('id="1444489269"', first + 1);
    assert.ok(second > first && first >= 0);
    return s.slice(0, second) + 'id="1444489270"' + s.slice(second + 'id="1444489269"'.length);
  });
  const cmpFixed = compareToBaseline(before, validateDocument(fixed));
  assert.deepEqual(cmpFixed.newErrors, []);
  assert.deepEqual(cmpFixed.preexisting, []);
  assert.deepEqual(codeSet(cmpFixed.resolved), ["INST_DUP_ID"]);
});

test("V4 compareToBaseline: 같은 오류가 늘어난 만큼만 newErrors다", () => {
  const d1 = readFixture("D1");
  const dangling = (n: number): Uint8Array =>
    withText(d1, SEC, (s) => {
      let out = s;
      for (let i = 0; i < n; i++) out = out.replace('charPrIDRef="0"', 'charPrIDRef="9999"');
      return out;
    });
  const before = validateDocument(dangling(1));
  const after = validateDocument(dangling(3));
  assert.equal(total(before.errors, "RES_DANGLING"), 1);
  assert.equal(total(after.errors, "RES_DANGLING"), 3);
  const cmp = compareToBaseline(before, after);
  assert.equal(cmp.newErrors.length, 1);
  assert.equal(cmp.newErrors[0]?.count, 2);
  assert.equal(cmp.preexisting.length, 1);
  assert.equal(cmp.preexisting[0]?.count, 1);
  assert.deepEqual(cmp.resolved, []);
  // 거꾸로 보면 줄어든 만큼이 resolved
  const back = compareToBaseline(after, before);
  assert.deepEqual(back.newErrors, []);
  assert.equal(back.resolved[0]?.count, 2);
});

test("V4 compareToBaseline: 경고는 견주지 않는다", () => {
  const before = validateDocument(readFixture("D1"));
  const after = validateDocument(withText(readFixture("D1"), SEC, (s) => s.replace('charPrIDRef="0"', 'charPrIDRef="9999"')));
  const cmp = compareToBaseline(before, after);
  assert.deepEqual(codeSet(cmp.newErrors), ["RES_DANGLING"]);
  assert.deepEqual(cmp.preexisting, [], "D1은 원래 오류가 없다. 경고(PKG_NO_ODF_MANIFEST 등)는 preexisting에 들어가지 않는다");
});

// ── V5: 깨진 입력은 예외가 아니라 보고서의 오류 ────────────────────────────

test("V5 ZIP 이 아닌 입력", () => {
  for (const bytes of [utf8("not a zip"), new Uint8Array(0), new Uint8Array([0x50, 0x4b]), utf8("<html>hello</html>")]) {
    const r = validateDocument(bytes);
    assert.ok(codeSet(r.errors).includes("PKG_NOT_ZIP"), describeReport(r));
    assert.equal(r.census.paragraphs, 0);
  }
  const hwp5 = new Uint8Array(512);
  hwp5.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const r = validateDocument(hwp5);
  assert.ok(codeSet(r.errors).includes("PKG_NOT_ZIP"));
  assert.ok(codeSet(r.errors).includes("PKG_IS_HWP5"), describeReport(r));
});

test("V5 잘린 파일", () => {
  const d1 = readFixture("D1");
  for (const keep of [d1.length - 1, d1.length - 22, Math.floor(d1.length / 2), 100, 10]) {
    const r = validateDocument(d1.subarray(0, keep));
    assert.ok(r.errors.length > 0, `${keep}바이트만 남긴 파일에 오류가 없다`);
    assert.ok(codeSet(r.errors).includes("PKG_NOT_ZIP"), `${keep}: ${describeReport(r)}`);
  }
  const half = validateDocument(d1.subarray(0, Math.floor(d1.length / 2)));
  assert.ok(codeSet(half.errors).includes("PKG_TRUNCATED"), describeReport(half));
});

test("V5 깨진 XML은 어느 항목이든 XML_MALFORMED(항목 이름 포함)로 나온다", () => {
  const d1 = readFixture("D1");
  const section = validateDocument(withText(d1, SEC, (s) => s.replace("</hs:sec>", "</hs:oops>")));
  const bad = section.errors.find((e) => e.code === "XML_MALFORMED");
  assert.ok(bad !== undefined, describeReport(section));
  assert.equal(bad.where, SEC);
  assert.match(bad.message, /줄 \d+, 열 \d+/);

  const header = validateDocument(withText(d1, HDR, (s) => s.replace("<hh:refList>", "<hh:refList><hh:x>")));
  assert.equal(header.errors.find((e) => e.code === "XML_MALFORMED")?.where, HDR);

  const hpf = validateDocument(withText(d1, HPF, (s) => s.replace("<opf:spine>", "<opf:spine &>")));
  assert.equal(hpf.errors.find((e) => e.code === "XML_MALFORMED")?.where, HPF);
});

test("V5 DOCTYPE과 UTF-8이 아닌 바이트도 보고서의 오류", () => {
  const d1 = readFixture("D1");
  const doctype = validateDocument(withText(d1, HDR, (s) => s.replace("<hh:head", '<!DOCTYPE x [<!ENTITY a "b">]><hh:head')));
  assert.ok(codeSet(doctype.errors).includes("XML_DOCTYPE"), describeReport(doctype));
  assert.ok(codeSet(doctype.errors).includes("XML_MALFORMED"));

  const archive = readArchive(d1);
  const latin1 = rewriteArchive(d1, archive, { replace: new Map([[SEC, new Uint8Array([0x3c, 0x61, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x61, 0x3e])]]) });
  const enc = validateDocument(latin1);
  assert.ok(codeSet(enc.errors).includes("XML_ENCODING"), describeReport(enc));
  assert.equal(enc.errors.find((e) => e.code === "XML_ENCODING")?.where, SEC);
});

test("V5 이름 중복·암호화 플래그처럼 엔진이 열지 않는 ZIP 구조도 보고서의 오류", () => {
  const base = entriesOf(readFixture("D1"));
  const dup = validateDocument(buildZip([...base, ...base.filter((e) => e.name === SEC)]));
  assert.deepEqual(codeSet(dup.errors), ["PKG_DUP_ENTRY"], describeReport(dup));
  assert.equal(dup.errors[0]?.where, SEC);

  const encrypted = Buffer.from(readFixture("D1"));
  const at = cdRecordOf(encrypted, SEC);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(at + 8) | 0x0001, at + 8);
  const enc = validateDocument(encrypted);
  assert.deepEqual(codeSet(enc.errors), ["PKG_ENCRYPTED"], describeReport(enc));
});

test("V5 모델 파싱이 실패하는 문서도 패키지 수준 검사 결과와 수량을 낸다", () => {
  const entries = entriesOf(readFixture("D1"));
  dropEntry(entries, "META-INF/container.xml");
  const bytes = rebuild(entries);
  assert.throws(() => openPackage(bytes), (e: unknown) => e instanceof Error && (e as { code?: string }).code === "PKG_MISSING");
  const r = validateDocument(bytes);
  assert.ok(codeSet(r.errors).includes("PKG_MISSING"), describeReport(r));
  assert.equal(r.census.paragraphs, 61, "모델을 거치지 않고도 구역은 검사한다");
  assert.equal(r.census.tables, 2);
});

test("V5 어떤 손상 입력에서도 예외를 던지지 않는다(잘라 내기·바이트 훼손)", () => {
  for (const name of ["D1", "hancom-merged", "extra/features-picture"]) {
    const bytes = readFixture(name);
    for (let k = 0; k < 40; k++) {
      const r = validateDocument(bytes.subarray(0, Math.floor((bytes.length * k) / 40)));
      assert.ok(r.errors.length > 0, `${name} ${k}/40`);
      assert.ok(!codeSet(r.errors).includes("VAL_INTERNAL"), `${name} ${k}/40: ${JSON.stringify(r.errors)}`);
    }
    let seed = 12345;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let k = 0; k < 60; k++) {
      const damaged = Buffer.from(bytes);
      damaged[next() % damaged.length] = next() & 0xff;
      const r = validateDocument(damaged);
      assert.ok(!codeSet(r.errors).includes("VAL_INTERNAL"), `${name} 훼손 ${k}: ${JSON.stringify(r.errors)}`);
    }
  }
});

// ── 그 밖: strict, census, 결정성 ──────────────────────────────────────────

test("strict: 한컴이 받아 주는 것으로 분류한 경고가 오류로 올라간다", () => {
  const d1 = readFixture("D1");
  const normal = validateDocument(d1);
  assert.deepEqual(normal.errors, []);
  assert.equal(total(normal.warnings, "RES_DANGLING_TOLERATED"), 8);
  const strict = validateDocument(d1, { strict: true });
  assert.equal(total(strict.errors, "RES_DANGLING"), 8, describeReport(strict));
  assert.equal(total(strict.warnings, "RES_DANGLING_TOLERATED"), 0);

  const rhwp = readFixture("extra/features-rhwp");
  const rn = validateDocument(rhwp);
  assert.deepEqual(rn.errors, []);
  assert.equal(total(rn.warnings, "INST_DUP_PLACEHOLDER"), 1);
  assert.equal(total(rn.warnings, "RES_DANGLING_TOLERATED"), 9);
  const rs = validateDocument(rhwp, { strict: true });
  assert.equal(total(rs.errors, "INST_DUP_ID"), 1, describeReport(rs));
  assert.equal(total(rs.errors, "RES_DANGLING"), 9);
  assert.equal(rs.warnings.filter((w) => w.code === "INST_DUP_PLACEHOLDER" || w.code === "RES_DANGLING_TOLERATED").length, 0);
});

test("census: 독립 기준(모델 파싱 결과·명세 기대값)과 같다", () => {
  for (const name of ALL_NAMES) {
    const bytes = readFixture(name);
    const doc = parseDocument(openPackage(bytes));
    let paragraphs = 0;
    let tables = 0;
    let begins = 0;
    for (const sec of doc.sections) {
      for (const p of walkParagraphs(sec.paragraphs)) {
        paragraphs++;
        tables += p.objects.filter((o) => o.type === "tbl").length;
        begins += p.fieldMarks.filter((m) => m.kind === "begin").length;
      }
    }
    const c = validateDocument(bytes).census;
    assert.equal(c.paragraphs, paragraphs, `${name} 문단`);
    assert.equal(c.tables, tables, `${name} 표`);
    assert.equal(c.fieldPairs, begins, `${name} 필드`);
    assert.equal(c.binaryItems, doc.pkg.binaryEntries.length, `${name} 이진 항목`);
  }
  // 명세 6절 M1의 기대값
  assert.deepEqual([validateDocument(readFixture("D1")).census.paragraphs, validateDocument(readFixture("D1")).census.tables], [61, 2]);
  assert.equal(validateDocument(readFixture("hancom-merged")).census.paragraphs, 91);
  assert.equal(validateDocument(readFixture("hancom-field")).census.paragraphs, 1);
  assert.equal(validateDocument(readFixture("hancom-field")).census.fieldPairs, 1);
  const pic = validateDocument(readFixture("hancom/picture")).census;
  assert.deepEqual([pic.pictures, pic.binaryItems], [1, 1]);
  assert.equal(validateDocument(readFixture("hancom/field-states")).census.fieldPairs, 3);
  const feat = validateDocument(readFixture("extra/features-picture")).census;
  assert.deepEqual([feat.pictures, feat.fieldPairs, feat.bookmarks, feat.binaryItems], [1, 1, 1, 1]);
});

test("census: 모르는 컨트롤은 종류별로 센다", () => {
  const bytes = withText(
    readFixture("D1"),
    SEC,
    addBeforeFirstParaEnd(
      '<hp:run charPrIDRef="0"><hp:foo/></hp:run>' +
        '<hp:run charPrIDRef="0"><hp:ctrl><hp:bar/><hp:bar/></hp:ctrl></hp:run>' +
        '<hp:run charPrIDRef="0"><hp:t>x<hp:baz/></hp:t></hp:run>',
    ),
  );
  const r = validateDocument(bytes);
  assert.deepEqual(r.census.unknownControls, { "ctrl/bar": 2, "run/foo": 1, "t/baz": 1 });
  assert.deepEqual(r.errors, []);
  assert.equal(total(r.warnings, "UNKNOWN_CONTROL"), 1);
});

test("같은 입력의 보고서는 같고 입력 바이트를 바꾸지 않는다", () => {
  const bytes = Buffer.from(readFixture("extra/features-picture"));
  const snapshot = Buffer.from(bytes);
  const a = JSON.stringify(validateDocument(bytes));
  const b = JSON.stringify(validateDocument(bytes));
  assert.equal(a, b);
  assert.ok(bytes.equals(snapshot));
});
