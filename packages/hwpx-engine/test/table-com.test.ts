import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyPlan,
  extractFragment,
  generate,
  listTables,
  planCloneTable,
  planDeleteColumns,
  planInsertColumns,
  planInsertRows,
  planMergeCells,
  planScaleTable,
  planSetColumnWidths,
  planSetTableProps,
  planSplitCell,
  readDataset,
  readTemplate,
  type HwpxDocument,
} from "../src/index.ts";
import { loadDoc, mutateEntryText, readFixture, sha256Hex } from "./helpers.ts";
import { reparseBytes } from "./table-helpers.ts";

/**
 * B4·B5 한컴 대조(선택 실행). `HWPX_COM=1`일 때만 돈다. 한컴 오피스·Python·pywin32(·PyMuPDF)가 있는 Windows에서만 의미가 있다.
 *
 * B4: 엔진이 바꾼 결과를 OS 임시 폴더에 저장하고 `tools/com/read_table.py`로 한컴에서 열어 표 속성(글자처럼 취급, 쪽 나눔, 제목 행 반복, 너비 등)과
 *     셀 주소(행·열 수의 근거)를 읽어 요청과 견준다. 요청한 값에서 기대를 정했다(엔진이 다시 읽은 값이 아니다).
 *     한컴 코드는 엔진이 만든 변형을 한컴으로 열어 관측했다: PageBreak CELL 2·TABLE 1·NONE 0, HorzAlign LEFT 0·CENTER 1·RIGHT 2.
 * B5: 글자처럼 취급 표의 셀에 긴 조각을 넣은 문서를 `fitTable` 유무로 PDF로 저장해 쪽 수와 끝 글 표지를 견준다. PDF는 `tools/com/out/`에 남긴다.
 */
const ENABLED = process.env["HWPX_COM"] === "1";
const SCRIPT = fileURLToPath(new URL("../../../tools/com/read_table.py", import.meta.url));
const OUT_DIR = fileURLToPath(new URL("../../../tools/com/out/", import.meta.url));

const PAGE_BREAK = { CELL: 2, TABLE: 1, NONE: 0 } as const;
const H_ALIGN = { LEFT: 0, CENTER: 1, RIGHT: 2 } as const;
const col = (n: number): string => String.fromCharCode(65 + n);
const uniform = (rows: number, cols: number): string[] => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `${col(c)}${r + 1}`)).flat();

type ReadTable = { props: Record<string, number | null>; cells: { label: string }[] };
type ReadDoc = { name: string; opened: boolean; pages: number | null; timeout: boolean; error: string | null; tables: ReadTable[]; pdf: { saved: boolean; bytes: number; pages: number | null; chars: number | null; markers: Record<string, boolean> | null } | null };

function readAll(dir: string, documents: { name: string; bytes: Uint8Array; pdf?: string; markers?: string[] }[]): ReadDoc[] {
  const spec = join(dir, "spec.json");
  const out = join(dir, "result.json");
  const specDocs = documents.map((d) => {
    const file = join(dir, `${d.name}.hwpx`);
    writeFileSync(file, d.bytes);
    return { name: d.name, file, ...(d.pdf === undefined ? {} : { pdf: d.pdf }), ...(d.markers === undefined ? {} : { markers: d.markers }) };
  });
  writeFileSync(spec, JSON.stringify({ documents: specDocs }));
  let last: ReadDoc[] = [];
  // 다른 작업이 한컴을 함께 쓰면 실행이 끊길 수 있어 최대 3번 시도한다.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync("python", [SCRIPT, "--spec", spec, "--out", out, "--timeout", "60"], { encoding: "utf8", timeout: 60_000 * documents.length + 30_000 });
    assert.equal(r.status, 0, `read_table.py 종료 코드: ${r.stderr}`);
    last = (JSON.parse(readFileSync(out, "utf8")) as { results: ReadDoc[] }).results;
    if (last.every((d) => d.opened && !d.timeout)) return last;
  }
  return last;
}

type Case = {
  name: string;
  /** 원본 문서 */
  base: string;
  make: (doc: HwpxDocument) => Uint8Array;
  /** 한컴이 읽은 표 목록에 대한 기대: 표마다 속성과 셀 라벨 */
  expect: { props?: Record<string, number>; labels: string[] }[];
  /** 쪽 수가 원본보다 최대 몇 쪽까지 늘 수 있는가 */
  maxExtraPages?: number;
};

const tableOf = (doc: HwpxDocument, i = 0) => listTables(doc)[i]?.target as never;
const patched = (doc: HwpxDocument, plan: ReturnType<typeof planInsertRows>): Uint8Array => applyPlan(doc.pkg, plan);

const CASES: Case[] = [
  {
    name: "settings-all",
    base: "hancom/blocks",
    make: (d) => patched(d, planSetTableProps(d, tableOf(d), { treatAsChar: true, pageBreak: "NONE", repeatHeader: false, cellSpacing: 120, hAlign: "CENTER", outMargin: { left: 11, right: 22, top: 33, bottom: 44 }, inMargin: { left: 55 } })),
    expect: [{ props: { TreatAsChar: 1, PageBreak: PAGE_BREAK.NONE, RepeatHeader: 0, CellSpacing: 120, HorzAlign: H_ALIGN.CENTER, OutsideMarginLeft: 11, OutsideMarginRight: 22, OutsideMarginTop: 33, OutsideMarginBottom: 44, CellMarginLeft: 55 }, labels: uniform(3, 3) }],
  },
  {
    name: "settings-table-right",
    base: "hancom/blocks",
    make: (d) => patched(d, planSetTableProps(d, tableOf(d), { pageBreak: "TABLE", hAlign: "RIGHT" })),
    expect: [{ props: { TreatAsChar: 0, PageBreak: PAGE_BREAK.TABLE, RepeatHeader: 1, HorzAlign: H_ALIGN.RIGHT }, labels: uniform(3, 3) }],
  },
  {
    name: "settings-inline-off",
    base: "tables/tables-inline",
    make: (d) => patched(d, planSetTableProps(d, tableOf(d), { treatAsChar: false })),
    expect: [{ props: { TreatAsChar: 0, PageBreak: PAGE_BREAK.CELL }, labels: uniform(2, 3) }],
  },
  {
    name: "scale-half",
    base: "hancom/blocks",
    make: (d) => patched(d, planScaleTable(d, tableOf(d), { scale: 0.5 })),
    expect: [{ props: { Width: 20976, TreatAsChar: 0 }, labels: uniform(3, 3) }],
  },
  {
    name: "columns",
    base: "hancom/blocks",
    make: (d) => patched(d, planSetColumnWidths(d, tableOf(d), [10000, 15000, 5000])),
    expect: [{ props: { Width: 30000 }, labels: uniform(3, 3) }],
  },
  {
    name: "insert-rows",
    base: "hancom/blocks",
    make: (d) => patched(d, planInsertRows(d, tableOf(d), { prototype: 2, count: 3, text: "keep" })),
    expect: [{ props: { Width: 41952 }, labels: uniform(6, 3) }],
  },
  {
    name: "insert-columns",
    base: "hancom/blocks",
    make: (d) => patched(d, planInsertColumns(d, tableOf(d), { prototype: 1, count: 2 })),
    expect: [{ props: { Width: 41952 + 2 * 13984 }, labels: uniform(3, 5) }],
  },
  {
    name: "delete-columns",
    base: "hancom/blocks",
    make: (d) => patched(d, planDeleteColumns(d, tableOf(d), { cols: [1] })),
    expect: [{ props: { Width: 41952 - 13984 }, labels: uniform(3, 2) }],
  },
  {
    name: "merge-block",
    base: "hancom/blocks",
    // 2×2 블록(A1·B1·A2·B2)을 합치면 셀은 A1(병합), C1, C2, A3, B3, C3
    make: (d) => patched(d, planMergeCells(d, tableOf(d), { rows: [0, 1], cols: [0, 1] })),
    expect: [{ labels: ["A1", "C1", "C2", "A3", "B3", "C3"] }],
  },
  {
    name: "split-merged",
    base: "tables/tables-merged",
    make: (d) => patched(d, planSplitCell(d, tableOf(d), { row: 0, col: 0 })),
    expect: [{ labels: ["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "A4", "B4", "C4"] }],
  },
  {
    name: "insert-rows-merged",
    base: "tables/tables-merged",
    make: (d) => patched(d, planInsertRows(d, tableOf(d), { prototype: 3, count: 2 })),
    expect: [{ labels: ["A1", "C1", "A2", "B2", "C2", "A3", "B3", "A4", "B4", "C4", "A5", "B5", "C5", "A6", "B6", "C6"] }],
  },
  {
    name: "extend-spans",
    base: "tables/tables-merged",
    // 세로 병합(C2·C3)이 덮는 행 2를 복제 → 병합이 한 행 늘어 C2·C3·C4, 새 행 3에는 A·B만
    make: (d) => patched(d, planInsertRows(d, tableOf(d), { prototype: 2, extendSpans: true })),
    expect: [{ labels: ["A1", "C1", "A2", "B2", "C2", "A3", "B3", "A4", "B4", "A5", "B5", "C5"] }],
  },
  {
    name: "clone-table",
    base: "tables/tables-merged",
    make: (d) => patched(d, planCloneTable(d, { sectionIndex: 0, parentPath: [], index: 1, position: "after" }, { table: tableOf(d) }, { rows: 3, cols: 2, text: "keep" })),
    // 복제본(3행 2열): 행을 줄여 A4·B4·C4가 사라지고, 열을 줄여 C1·C2(세로 병합)가 사라진다. 첫 행 병합(A1·B1)은 남는다.
    expect: [{ labels: ["A1", "C1", "A2", "B2", "C2", "A3", "B3", "A4", "B4", "C4"] }, { labels: ["A1", "A2", "B2", "A3", "B3"] }],
  },
  {
    name: "nested-rows",
    base: "tables/tables-nested",
    make: (d) => patched(d, planInsertRows(d, tableOf(d, 1), { prototype: 1, count: 2, text: "keep" })),
    expect: [{ labels: uniform(2, 2) }, { labels: uniform(4, 2) }],
  },
  {
    name: "rich-rows",
    base: "tables/tables-rich",
    make: (d) => patched(d, planInsertRows(d, tableOf(d), { prototype: 1, count: 2, text: "keep" })),
    expect: [{ labels: uniform(5, 3) }],
  },
  {
    name: "repeat-generate",
    base: "hancom/blocks",
    make: (d) => {
      const t = readTemplate({
        schema: "hwpx-studio/template@1",
        anchors: [{ id: "row", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 0 }],
        rules: [{ id: "r", do: { type: "repeat", anchor: "row", each: { path: "xs" } } }],
      });
      const r = generate(d.pkg.bytes, t, readDataset({ xs: [1, 2, 3, 4] }));
      assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues.filter((i) => i.severity === "error")));
      return r.output;
    },
    expect: [{ labels: uniform(6, 3) }],
  },
];

test("B4 한컴 대조: 표 속성과 셀 주소를 한컴으로 읽어 요청과 견준다", { skip: !ENABLED && "HWPX_COM=1일 때만 실행한다" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hwpx-table-com-"));
  try {
    const bases = [...new Set(CASES.map((c) => c.base))];
    const baseResults = readAll(dir, bases.map((b) => ({ name: `base-${b.replace("/", "-")}`, bytes: new Uint8Array(readFileSync(new URL(`./fixtures/${b}.hwpx`, import.meta.url))) })));
    const pagesOf = new Map(bases.map((b, i) => [b, baseResults[i]?.pages ?? 0]));
    for (const r of baseResults) assert.ok(r.opened, `${r.name} 원본이 한컴에서 열려야 한다`);

    const made = CASES.map((c) => {
      const bytes = c.make(loadDoc(c.base));
      reparseBytes(bytes);
      return { name: c.name, bytes };
    });
    const results = readAll(dir, made);
    const rows: string[] = [];
    CASES.forEach((c, i) => {
      const r = results[i];
      assert.ok(r !== undefined && r.opened && !r.timeout, `${c.name}: 한컴이 열어야 한다(${r?.error})`);
      assert.equal(r.tables.length, c.expect.length, `${c.name}: 표 수`);
      c.expect.forEach((e, k) => {
        const t = r.tables[k];
        assert.ok(t !== undefined);
        for (const [name, want] of Object.entries(e.props ?? {})) assert.equal(t.props[name], want, `${c.name} 표 ${k}: ${name}`);
        assert.deepEqual(t.cells.map((x) => x.label), e.labels, `${c.name} 표 ${k}: 셀 주소`);
        rows.push(`${c.name}#${k}: ${e.labels.length}셀 ${Object.keys(e.props ?? {}).length}속성`);
      });
      assert.ok((r.pages ?? 0) <= (pagesOf.get(c.base) ?? 0) + (c.maxExtraPages ?? 1), `${c.name}: 쪽 수 ${r.pages}(원본 ${pagesOf.get(c.base)})`);
    });
    // 한컴 대조 결과를 남긴다(값 원문 없음)
    console.log(`B4 한컴 대조 ${CASES.length}건 통과: ${rows.length}개 표`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 긴 조각: 한컴 문서(`hancom/ph-single`)의 서식을 쓰는 문단 141개(좁은 셀에서는 줄바꿈이 많아 열 쪽을 넘는다). 끝 문단의 글을 표지로 쓴다.
 * 줄 간격이 없는 합성 서식(MINIMAL_HEADER)을 쓰면 줄 높이가 0이라 한컴이 줄을 겹쳐 그리므로 한컴 서식을 쓴다.
 */
function longFragment(): { fragment: unknown; marker: string } {
  const marker = "끝마커QZ9";
  const lines = [...Array.from({ length: 140 }, (_, i) => `시험 문장 ${i + 1} 가나다라마바사아자차카타파하 가나다라마바사아자차카타파하 가나다라마바사아자차카타파하`), marker];
  const paragraphsXml = lines.map((t) => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p>`).join("");
  const longDoc = reparseBytes(mutateEntryText(readFixture("hancom/ph-single"), "Contents/section0.xml", (x) => x.replace("</hs:sec>", `${paragraphsXml}</hs:sec>`)));
  return { fragment: JSON.parse(JSON.stringify(extractFragment(longDoc, { sectionIndex: 0, parentPath: [], from: 3, to: 3 + lines.length - 1 }))), marker };
}

test("B5 잘림 해소: 글자처럼 취급 표의 셀에 긴 조각을 넣고 fitTable을 쓰면 한컴 PDF에서 끝까지 보인다", { skip: !ENABLED && "HWPX_COM=1일 때만 실행한다" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hwpx-table-com-"));
  try {
    const doc = loadDoc("tables/tables-inline");
    const { fragment, marker } = longFragment();

    const cell = doc.sections[0]?.paragraphs[1]?.subLists[0]?.paragraphs[0];
    assert.ok(cell !== undefined);
    const anchor = { id: "cell", kind: "line", at: { sectionIndex: 0, path: [1, 0, 0] }, print: { text: cell.logicalText.slice(0, 40), sha256: sha256Hex(new TextEncoder().encode(cell.logicalText)) } };
    const make = (fit: boolean): Uint8Array => {
      const t = readTemplate({ schema: "hwpx-studio/template@1", anchors: [anchor], rules: [{ id: "i", do: { type: "inject", anchor: "cell", position: "after", fragment, ...(fit ? { fitTable: "allowBreak" } : {}) } }] });
      const r = generate(doc.pkg.bytes, t, readDataset({}), { mode: "baseline" });
      assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues.filter((i) => i.severity === "error")));
      return r.output;
    };
    mkdirSync(OUT_DIR, { recursive: true });
    const plainPdf = join(OUT_DIR, "b5-plain.pdf");
    const fitPdf = join(OUT_DIR, "b5-fit.pdf");
    const [orig, plain, fit] = readAll(dir, [
      { name: "b5-orig", bytes: doc.pkg.bytes },
      { name: "b5-plain", bytes: make(false), pdf: plainPdf, markers: [marker] },
      { name: "b5-fit", bytes: make(true), pdf: fitPdf, markers: [marker] },
    ]);
    for (const r of [orig, plain, fit]) assert.ok(r !== undefined && r.opened && !r.timeout, `${r?.name}: 한컴이 열어야 한다(${r?.error})`);
    assert.ok(plain?.pdf?.saved === true && fit?.pdf?.saved === true, "PDF 저장");
    const info = { origPages: orig?.pages, plainPages: plain?.pages, fitPages: fit?.pages, plainChars: plain?.pdf?.chars, fitChars: fit?.pdf?.chars, plainMarker: plain?.pdf?.markers?.[marker], fitMarker: fit?.pdf?.markers?.[marker] };
    console.log(`B5: ${JSON.stringify(info)}`);
    // 고치지 않은 쪽(글자처럼 취급): 셀 안 내용이 쪽 아래에서 잘려 끝 표지가 PDF에 없다
    assert.equal(plain?.pdf?.markers?.[marker], false, "글자처럼 취급 표는 긴 내용을 쪽 밖으로 넘기지 못해 끝이 잘린다");
    // 표를 고친 쪽: 끝 표지가 PDF에 있고, 글자 수·쪽 수가 안 고친 쪽보다 많다
    assert.equal(fit?.pdf?.markers?.[marker], true, "fitTable을 쓰면 끝 글이 PDF에 보여야 한다");
    assert.ok((fit?.pdf?.chars ?? 0) > (plain?.pdf?.chars ?? 0), "글자 수가 늘어야 한다");
    assert.ok((fit?.pages ?? 0) > (plain?.pages ?? 0), "쪽 수가 늘어야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5 보강: 글자처럼 취급이 아닌 표도 pageBreak=TABLE이면 한 셀의 긴 조각이 잘리고, 같은 문서를 pageBreak=CELL로 바꾸면 끝까지 보인다", { skip: !ENABLED && "HWPX_COM=1일 때만 실행한다" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hwpx-table-com-"));
  try {
    const base = loadDoc("tables/tables-merged");
    const info = listTables(base)[0];
    assert.equal(info?.treatAsChar, false, "글자처럼 취급이 아닌 표여야 한다(이 시험의 전제)");
    const { fragment, marker } = longFragment();
    // 표 설정만 다른 두 문서(TABLE, CELL)에 같은 조각을 같은 셀(첫 칸의 문단)에 넣는다. fitTable은 쓰지 않는다
    const make = (pageBreak: "TABLE" | "CELL"): Uint8Array => {
      const doc = reparseBytes(applyPlan(base.pkg, planSetTableProps(base, tableOf(base), { pageBreak })));
      assert.equal(listTables(doc)[0]?.pageBreak, pageBreak);
      const cell = doc.sections[0]?.paragraphs[1]?.subLists[0]?.paragraphs[0];
      assert.ok(cell !== undefined);
      const anchor = { id: "cell", kind: "line", at: { sectionIndex: 0, path: [1, 0, 0] }, print: { text: cell.logicalText.slice(0, 40), sha256: sha256Hex(new TextEncoder().encode(cell.logicalText)) } };
      const t = readTemplate({ schema: "hwpx-studio/template@1", anchors: [anchor], rules: [{ id: "i", do: { type: "inject", anchor: "cell", position: "after", fragment } }] });
      const r = generate(doc.pkg.bytes, t, readDataset({}), { mode: "baseline" });
      assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues.filter((i) => i.severity === "error")));
      return r.output;
    };
    mkdirSync(OUT_DIR, { recursive: true });
    const tablePdf = join(OUT_DIR, "b5-table-break.pdf");
    const cellPdf = join(OUT_DIR, "b5-cell-break.pdf");
    const [orig, byTable, byCell] = readAll(dir, [
      { name: "b5t-orig", bytes: base.pkg.bytes },
      { name: "b5t-table", bytes: make("TABLE"), pdf: tablePdf, markers: [marker] },
      { name: "b5t-cell", bytes: make("CELL"), pdf: cellPdf, markers: [marker] },
    ]);
    for (const r of [orig, byTable, byCell]) assert.ok(r !== undefined && r.opened && !r.timeout, `${r?.name}: 한컴이 열어야 한다(${r?.error})`);
    assert.ok(byTable?.pdf?.saved === true && byCell?.pdf?.saved === true, "PDF 저장");
    const seen = { origPages: orig?.pages, tablePages: byTable?.pages, cellPages: byCell?.pages, tableChars: byTable?.pdf?.chars, cellChars: byCell?.pdf?.chars, tableMarker: byTable?.pdf?.markers?.[marker], cellMarker: byCell?.pdf?.markers?.[marker] };
    console.log(`B5 보강: ${JSON.stringify(seen)}`);
    assert.equal(byTable?.pdf?.markers?.[marker], false, "pageBreak=TABLE: 한 셀이 쪽보다 길면 끝이 잘려 끝 표지가 PDF에 없다");
    assert.equal(byCell?.pdf?.markers?.[marker], true, "같은 문서를 pageBreak=CELL로 바꾸면 끝 글이 PDF에 보인다");
    assert.ok((byCell?.pdf?.chars ?? 0) > (byTable?.pdf?.chars ?? 0), "글자 수가 늘어야 한다");
    assert.ok((byCell?.pages ?? 0) > (byTable?.pages ?? 0), "쪽 수가 늘어야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
