// 범위 앵커(7.10) 결과의 한글 열림(선택 실행). `HWPX_COM=1`일 때만 돈다(한컴 오피스·Python·pywin32가 있는 Windows).
//   HWPX_COM=1 node --test packages/hwpx-engine/test/range-com.test.ts
// 결과를 OS 임시 폴더에 쓰고 `tools/com/open_check.py`로 연다(한컴은 한 번에 하나, 창 숨김, 끝나면 Quit, 이미 떠 있던 Hwp.exe는 건드리지 않는다).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate } from "../src/fill/index.ts";
import { readFixture, reparse } from "./helpers.ts";
import { dataFor, del, done, ds, fragOf, gateClean, inject, insertText, KEEP, longValue, notice, range, rng, tpl } from "./range-helpers.ts";

const ENABLED = process.env["HWPX_COM"] === "1";
const OPEN_CHECK = fileURLToPath(new URL("../../../tools/com/open_check.py", import.meta.url));

test("7.10 한글 2024 열림: range 교체·삭제 결과 6건", { skip: !ENABLED && "HWPX_COM=1일 때만 돈다(미검증)" }, () => {
  const base = notice();
  const doc = reparse(base);
  const blocksBytes = readFixture("hancom/blocks");
  const blocks = reparse(blocksBytes);
  const rich = reparse(readFixture("tables/tables-rich"));
  const merged = reparse(readFixture("tables/tables-merged"));
  const spanBytes = readFixture("span/field-span");
  const span = reparse(spanBytes);
  const next = rng(30);
  const data = dataFor(doc, () => longValue(next, 150, 600));

  const cases: { name: string; run: () => Uint8Array }[] = [
    {
      name: "multi",
      run: () => {
        const t = tpl(
          [range(doc, "a", 2, 4), range(doc, "b", 18, 21), range(doc, "c", 33, 40), range(doc, "d", 47, 50), range(doc, "e", 2, 5, [12, 1])],
          [inject("D", "d", fragOf(rich, 1, 1)), del("A", "a"), insertText("C", "c", "씨 1\n씨 2\n씨 3"), inject("B", "b", fragOf(blocks, 3, 4)), del("E", "e")],
        );
        const r = done(generate(base, t, ds({}), KEEP));
        gateClean(base, r);
        return r.output;
      },
    },
    {
      name: "long-range-data",
      run: () => {
        const r = done(generate(base, tpl([range(doc, "r", 25, 44)], [inject("x", "r", fragOf(rich, 1, 1))]), ds(data)));
        gateClean(base, r);
        return r.output;
      },
    },
    {
      name: "in-cell",
      run: () => {
        const r = done(generate(base, tpl([range(doc, "r", 1, 4, [12, 1])], [inject("x", "r", fragOf(blocks, 3, 4))]), ds({}), KEEP));
        gateClean(base, r);
        return r.output;
      },
    },
    {
      name: "blocks-heading-range",
      run: () => {
        const r = done(generate(blocksBytes, tpl([range(blocks, "r", 3, 4)], [inject("x", "r", fragOf(merged, 1, 1))]), ds({}), KEEP));
        gateClean(blocksBytes, r);
        return r.output;
      },
    },
    {
      name: "text-and-delete",
      run: () => {
        const r = done(generate(base, tpl([range(doc, "a", 5, 14), range(doc, "b", 47, 52)], [insertText("A", "a", "첫 줄 & <글>\n둘째 줄 \"인용\""), del("B", "b")]), ds(data)));
        gateClean(base, r);
        return r.output;
      },
    },
    {
      name: "field-span-range",
      run: () => {
        const r = done(generate(spanBytes, tpl([range(span, "r", 1, 3)], [insertText("x", "r", "구간 교체")]), ds({}), KEEP));
        gateClean(spanBytes, r);
        return r.output;
      },
    },
  ];

  const dir = mkdtempSync(join(tmpdir(), "hwpx-range-com-"));
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
