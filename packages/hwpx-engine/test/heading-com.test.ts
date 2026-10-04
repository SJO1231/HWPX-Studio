// 제목 범위(7.10 `headingRange`) 결과의 한글 열림(선택 실행). `HWPX_COM=1`일 때만 돈다(한컴 오피스·Python·pywin32가 있는 Windows).
//   HWPX_COM=1 node --test packages/hwpx-engine/test/heading-com.test.ts
// 결과를 OS 임시 폴더에 쓰고 `tools/com/open_check.py`로 연다(한컴은 한 번에 하나, 창 숨김, 끝나면 Quit, 이미 떠 있던 Hwp.exe는 건드리지 않는다).
// 실행 전후의 Hwp.exe 수가 같아야 한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate, generateFromTemplate, makeHeadingRangeAnchor, type HeadingRangeAnchor } from "../src/fill/index.ts";
import { readStudioTemplate, sha256Hex as sha256Text } from "../src/template/index.ts";
import { readFixture, reparse, sha256Hex } from "./helpers.ts";
import { headingDoc, headingIndex } from "./heading-helpers.ts";
import { dataFor, del, done, ds, fragOf, gateClean, inject, insertText, KEEP, longValue, rng, tpl } from "./range-helpers.ts";

const ENABLED = process.env["HWPX_COM"] === "1";
const OPEN_CHECK = fileURLToPath(new URL("../../../tools/com/open_check.py", import.meta.url));

function hwpCount(): number {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq Hwp.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return r.stdout.split(/\r?\n/).filter((l) => l.startsWith('"Hwp.exe"')).length;
}

test("7.10 한글 2024 열림: headingRange 교체·삭제·삽입·2판 슬롯 결과 5건", { skip: !ENABLED && "HWPX_COM=1일 때만 돈다(미검증)" }, () => {
  const { bytes, model } = headingDoc();
  const doc = reparse(bytes);
  const blocks = reparse(readFixture("hancom/blocks"));
  const rich = reparse(readFixture("tables/tables-rich"));
  const next = rng(1919);
  const data = dataFor(doc, () => longValue(next, 150, 600));
  const h = (id: string, index: number, parentPath: number[] = []): HeadingRangeAnchor => {
    const d = makeHeadingRangeAnchor(doc, 0, parentPath, index);
    assert.ok(d !== undefined);
    return { id, ...d };
  };

  const cases: { name: string; run: () => Uint8Array }[] = [
    {
      name: "table-into-heading-range",
      run: () => {
        const r = done(generate(bytes, tpl([h("a", headingIndex(model, "7. 일반"))], [inject("x", "a", fragOf(rich, 1, 1))]), ds(data)));
        gateClean(bytes, r);
        return r.output;
      },
    },
    {
      name: "delete-and-cell-text",
      run: () => {
        const r = done(generate(bytes, tpl([h("a", headingIndex(model, "가. 첫째")), h("c", 6, [12, 1])], [del("x", "a"), insertText("y", "c", "칸 교체 & <글>\n둘째 줄")]), ds({}), KEEP));
        gateClean(bytes, r);
        return r.output;
      },
    },
    {
      name: "before-after",
      run: () => {
        const r = done(
          generate(bytes, tpl([h("a", headingIndex(model, "굵은 짧은")), h("b", headingIndex(model, "제1장"))], [inject("x", "a", fragOf(blocks, 2, 4), "before"), insertText("y", "b", "뒤에 붙인 글 \"인용\"", "after")]), ds({}), KEEP),
        );
        gateClean(bytes, r);
        return r.output;
      },
    },
    {
      name: "many-rules-long-values",
      run: () => {
        const anchors = [h("a", headingIndex(model, "제1조")), h("b", headingIndex(model, "(1)")), h("c", 27), h("d", headingIndex(model, "9. 마지막"))];
        const rules = [inject("A", "a", fragOf(blocks, 2, 4)), insertText("B", "b", "괄호 항목 교체"), del("C", "c"), inject("D", "d", fragOf(rich, 1, 1))];
        const r = done(generate(bytes, tpl(anchors, rules), ds(data)));
        gateClean(bytes, r);
        return r.output;
      },
    },
    {
      name: "studio-slot",
      run: () => {
        const blob = new TextEncoder().encode(JSON.stringify(fragOf(blocks, 2, 4)));
        const sha = sha256Text(blob);
        const t = readStudioTemplate(
          JSON.stringify({
            schema: "hwpx-studio/template@2",
            id: "t0a1b2c3d",
            version: 1,
            source: { kind: "hwpx", sha256: sha256Hex(bytes) },
            anchors: [h("h1", headingIndex(model, "가. 첫째")), h("h2", 6, [12, 1])],
            values: [{ id: "v1", name: "기관", format: "text" }],
            bindings: [{ value: "v1", key: "기관명" }],
            places: [{ id: "p1", kind: "placeholder", key: "기관명", value: "v1" }],
            slots: [{ id: "s1", name: "가", anchors: ["h1"], parent: null }, { id: "s2", name: "칸", anchors: ["h2"], parent: null }],
            blocks: [{ id: "b1", slot: "s1", name: "조각", content: { fragment: sha } }, { id: "b2", slot: "s2", name: "글", content: { text: "칸 교체 {{기관명}}" } }],
            options: { unregistered: "keep" },
          }),
          { hasBlob: (s) => s === sha },
        );
        const r = generateFromTemplate(bytes, t, { 기관명: longValue(next, 200, 400) }, undefined, (s) => (s === sha ? blob : undefined));
        assert.ok(r.ok && !r.dryRun && r.output instanceof Uint8Array, JSON.stringify(r.report.issues));
        return r.output;
      },
    },
  ];

  const dir = mkdtempSync(join(tmpdir(), "hwpx-heading-com-"));
  const before = hwpCount();
  try {
    const files = cases.map((c) => {
      const file = join(dir, `${c.name}.hwpx`);
      writeFileSync(file, c.run());
      return file;
    });
    const out = join(dir, "result.json");
    const r = spawnSync("python", [OPEN_CHECK, "--out", out, ...files], { encoding: "utf8", timeout: 80_000 * files.length });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      hancom_version: string | null;
      hwp_processes_left_by_this_run: number;
      results: { file: string; opened: boolean; pages: number | null; error: string | null }[];
    };
    const summary = report.results.map((x) => ({ file: x.file, opened: x.opened, pages: x.pages, error: x.error }));
    console.log(`한컴 ${report.hancom_version ?? "?"}: ${JSON.stringify(summary)}`);
    assert.equal(report.results.filter((x) => x.opened && (x.pages ?? 0) > 0).length, cases.length, JSON.stringify(summary));
    assert.equal(report.hwp_processes_left_by_this_run, 0);
    assert.equal(hwpCount(), before, "실행 전후 Hwp.exe 수가 같다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
