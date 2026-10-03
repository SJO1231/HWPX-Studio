// M1-A 한컴 대조(선택 실행). `HWPX_COM=1`일 때만 돈다. 한컴 오피스·Python·pywin32·PyMuPDF가 있는 Windows에서만 의미가 있다.
// 값에 줄바꿈·탭을 채운 결과를 `tools/com/read_text.py`로 한컴에서 열어 (a) 열림 (b) 누름틀 값을 한컴이 읽는 모양과 한컴이 다시 저장한 XML
// (c) PDF에서 두 줄로 보이는지(글 위치)를 확인한다. 기대는 한컴 저장본(`fixtures/inline/inline-breaks.hwpx`)에서 관측한 것에서 정했다:
//   - 한컴이 줄바꿈(Shift+Enter)을 `<hp:t>` 안의 속성 없는 `<hp:lineBreak/>`로, 탭을 `<hp:tab width leader type/>`로 저장한다.
//   - 한컴의 GetFieldText는 줄바꿈 요소를 아무 글자로도 주지 않고(`첫 줄둘째 줄`) 탭은 `\t`로 준다. 한컴이 직접 만든 줄바꿈 누름틀도 같다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate, isTableNode, listFields, readDataset, readTemplate, type HwpxDocument } from "../src/index.ts";
import { readFixture, reparse } from "./helpers.ts";

const ENABLED = process.env["HWPX_COM"] === "1";
const SCRIPT = fileURLToPath(new URL("../../../tools/com/read_text.py", import.meta.url));
const OUT_DIR = fileURLToPath(new URL("../../../tools/com/out/", import.meta.url));

type Box = { page: number; x0: number; y0: number; x1: number; y1: number } | null;
type ReadDoc = {
  name: string;
  opened: boolean;
  pages: number | null;
  timeout: boolean;
  error: string | null;
  field_text: Record<string, string>;
  resaved: boolean;
  pdf: { saved: boolean; bytes: number; pages: number | null; markers: Record<string, Box> | null } | null;
};
type Spec = { name: string; bytes: Uint8Array; fields?: string[]; markers?: string[]; resave?: boolean };

function readAll(dir: string, documents: Spec[]): ReadDoc[] {
  const specDocs = documents.map((d) => {
    const file = join(dir, `${d.name}.hwpx`);
    writeFileSync(file, d.bytes);
    return {
      name: d.name,
      file,
      ...(d.fields === undefined ? {} : { fields: d.fields }),
      ...(d.resave === true ? { resave: join(dir, `${d.name}.resaved.hwpx`) } : {}),
      ...(d.markers === undefined ? {} : { pdf: join(OUT_DIR, `inline-${d.name}.pdf`), markers: d.markers }),
    };
  });
  const spec = join(dir, "spec.json");
  const out = join(dir, "result.json");
  writeFileSync(spec, JSON.stringify({ documents: specDocs }));
  let last: ReadDoc[] = [];
  // 다른 작업이 한컴을 함께 쓰면 실행이 끊길 수 있어 최대 3번 시도한다.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync("python", [SCRIPT, "--spec", spec, "--out", out, "--timeout", "60"], { encoding: "utf8", timeout: 60_000 * documents.length + 30_000 });
    assert.equal(r.status, 0, `read_text.py 종료 코드: ${r.stderr}`);
    last = (JSON.parse(readFileSync(out, "utf8")) as { results: ReadDoc[] }).results;
    if (last.every((d) => d.opened && !d.timeout)) return last;
  }
  return last;
}

const tpl = (anchors: unknown[], rules: unknown[]) => readTemplate({ schema: "hwpx-studio/template@1", anchors, rules });
const fillRule = (id: string, anchor: string, path: string) => ({ id, do: { type: "fill", anchor, value: { path } } });

function make(fixture: string, template: ReturnType<typeof tpl>, data: unknown): Uint8Array {
  const r = generate(readFixture(fixture), template, readDataset(data));
  assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues.filter((i) => i.severity === "error")));
  return r.output;
}

const FIELD_VALUES = { a: "첫 줄\n둘째 줄", b: "가\t나" };
// 템플릿 없이: 누름틀 이름(성명·소속)이 데이터 경로다(암묵 채움)
const FIELDS_DOC = make("hancom/field-states", tpl([], []), { 성명: FIELD_VALUES.a, 소속: FIELD_VALUES.b });
const PLACEHOLDER_DOC = make("hancom/ph-single", tpl([], []), { project: { name: "첫 줄\r\n둘째 줄", start: "시작", end: "가나다\t라마바" } });
const CELL_DOC = make(
  "hancom/ph-table",
  tpl([{ id: "c", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 1 }], [fillRule("r", "c", "v")]),
  { v: "셀 첫 줄\n셀 둘째 줄", applicant: { name: "홍" }, note: "비" },
);

const paragraphOf = (doc: HwpxDocument, index: number): string => doc.sections[0]?.paragraphs[index]?.logicalText ?? "<없음>";

test("A 한컴 대조: 줄바꿈·탭 값을 채운 문서가 한컴에서 열리고, 누름틀 값을 읽는 모양이 한컴이 직접 만든 것과 같고, 다시 저장해도 줄바꿈·탭이 남고, PDF에서 두 줄로 보인다", { skip: !ENABLED && "HWPX_COM=1일 때만 실행한다" }, (t) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "hwpx-inline-com-"));
  try {
    const [native, fields, placeholder, cell] = readAll(dir, [
      { name: "native", bytes: readFixture("inline/inline-breaks"), fields: ["줄", "탭"], resave: true },
      { name: "fields", bytes: FIELDS_DOC, fields: ["성명", "소속"], resave: true },
      { name: "placeholder", bytes: PLACEHOLDER_DOC, markers: ["사업명:", "첫 줄", "둘째 줄", "시작", "가나다", "라마바"], resave: true },
      { name: "cell", bytes: CELL_DOC, markers: ["연락처", "셀 첫 줄", "셀 둘째 줄"], resave: true },
    ]) as [ReadDoc, ReadDoc, ReadDoc, ReadDoc];

    // (a) 열림
    for (const r of [native, fields, placeholder, cell]) {
      assert.ok(r.opened && !r.timeout, `${r.name}이(가) 한컴에서 열려야 한다(${r.error})`);
      assert.equal(r.pages, 1, `${r.name} 쪽 수`);
      assert.ok(r.resaved, `${r.name}을(를) 한컴이 다시 저장해야 한다`);
    }

    // (b) 누름틀 값: 한컴이 직접 만든 줄바꿈·탭 누름틀을 읽는 모양과 엔진이 채운 누름틀을 읽는 모양이 같다
    t.diagnostic(`한컴 GetFieldText(한컴이 만든 줄바꿈 누름틀) = ${JSON.stringify(native.field_text["줄"])}, (탭 누름틀) = ${JSON.stringify(native.field_text["탭"])}`);
    t.diagnostic(`한컴 GetFieldText(엔진이 채운 줄바꿈 누름틀) = ${JSON.stringify(fields.field_text["성명"])}, (탭) = ${JSON.stringify(fields.field_text["소속"])}`);
    assert.equal(fields.field_text["성명"], native.field_text["줄"], "줄바꿈 값을 읽는 모양이 한컴이 만든 것과 같다");
    assert.equal(fields.field_text["소속"], native.field_text["탭"], "탭 값을 읽는 모양이 한컴이 만든 것과 같다");
    assert.ok((native.field_text["탭"] ?? "").includes("\t"), "한컴은 탭을 \t로 준다");
    // 한컴이 다시 저장한 XML을 엔진이 읽으면 줄바꿈·탭이 그대로 남아 있다
    const resaved = (name: string): HwpxDocument => reparse(new Uint8Array(readFileSync(join(dir, `${name}.resaved.hwpx`))));
    assert.deepEqual(listFields(resaved("fields")).map((f) => [f.name, f.valueText]), [["성명", FIELD_VALUES.a], ["소속", FIELD_VALUES.b], ["성명", FIELD_VALUES.a]]);
    assert.equal(paragraphOf(resaved("placeholder"), 1), "사업명: 첫 줄\n둘째 줄 입니다.");
    assert.equal(paragraphOf(resaved("placeholder"), 2), "기간: 시작 ~ 가나다\t라마바");

    // (c) PDF: 둘째 줄은 첫 줄 아래의 줄 처음에서 시작하고, 탭은 한 칸보다 훨씬 넓다
    const m = placeholder.pdf?.markers;
    assert.ok(m !== null && m !== undefined, "PDF 글 위치를 읽어야 한다(PyMuPDF)");
    const [head, first, second, tabLeft, tabRight] = [m["사업명:"], m["첫 줄"], m["둘째 줄"], m["가나다"], m["라마바"]];
    assert.ok(head && first && second && tabLeft && tabRight, JSON.stringify(m));
    assert.ok(second.y0 > first.y0 + 5, `둘째 줄(${second.y0})이 첫 줄(${first.y0}) 아래에 있다`);
    assert.ok(Math.abs(first.y0 - head.y0) < 1.5, "첫 줄은 라벨과 같은 줄이다");
    assert.ok(Math.abs(second.x0 - head.x0) < 1.5, "둘째 줄은 줄 처음에서 시작한다");
    assert.ok(Math.abs(tabRight.y0 - tabLeft.y0) < 1.5 && tabRight.x0 - tabLeft.x1 > 20, `탭이 공백 한 칸보다 넓다(간격 ${tabRight.x0 - tabLeft.x1})`);

    const c = cell.pdf?.markers;
    assert.ok(c !== null && c !== undefined && c["셀 첫 줄"] && c["셀 둘째 줄"], JSON.stringify(c));
    assert.ok(c["셀 둘째 줄"].y0 > c["셀 첫 줄"].y0 + 5 && Math.abs(c["셀 둘째 줄"].x0 - c["셀 첫 줄"].x0) < 1.5, "셀 안에서도 두 줄이다");
    const table = resaved("cell").sections[0]?.paragraphs[1]?.objects[0];
    assert.ok(table !== undefined && isTableNode(table));
    assert.equal(table.cells[3]?.subList?.paragraphs[0]?.logicalText, "셀 첫 줄\n셀 둘째 줄", "한컴이 다시 저장한 칸에도 줄바꿈이 남아 있다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
