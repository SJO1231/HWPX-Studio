// 2판 생성(8.8.12) 결과의 한글 열림(선택 실행). `HWPX_COM=1`일 때만 돈다(한컴 오피스·Python·pywin32가 있는 Windows).
//   HWPX_COM=1 node --test packages/hwpx-engine/test/generate-v2-com.test.ts
// 결과를 OS 임시 폴더에 쓰고 `tools/com/open_check.py`로 연다(한컴은 한 번에 하나, 창 숨김, 끝나면 Quit, 이미 떠 있던 Hwp.exe는 건드리지 않는다).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateFromTemplate } from "../src/fill/index.ts";
import { caseOf, loaderOf, manual, noticeKit, randomText, recordFor, studioOf } from "./generate-v2-helpers.ts";
import { range, rng } from "./range-helpers.ts";

const ENABLED = process.env["HWPX_COM"] === "1";
const OPEN_CHECK = fileURLToPath(new URL("../../../tools/com/open_check.py", import.meta.url));

/** 떠 있는 Hwp.exe 수 */
function hwpCount(): number {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq Hwp.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return r.stdout.split(/\r?\n/).filter((l) => l.startsWith('"Hwp.exe"')).length;
}

test("8.8.12 한글 2024 열림: 2판 생성 결과 5건", { skip: !ENABLED && "HWPX_COM=1일 때만 돈다(미검증)" }, () => {
  const kit = noticeKit();
  const next = rng(31);
  const run = (price: number, sme: string, s2: string, options: Record<string, unknown> = {}, ranges?: [number, number][]): Uint8Array => {
    const raw = structuredClone(kit.raw) as Record<string, any>;
    raw["options"] = { ...raw["options"], ...options };
    if (ranges !== undefined) {
      const anchors = raw["anchors"] as { id: string }[];
      ranges.forEach(([from, to], i) => anchors.splice(i, 1, range(kit.doc, `a${i + 1}`, from, to)));
    }
    const t = studioOf(raw, kit.blobs);
    const record = recordFor(randomText(next), { price, sme });
    const r = generateFromTemplate(kit.bytes, t, record, caseOf(t, record, { selections: { s2: manual(t, "s2", s2) } }), loaderOf(kit.blobs));
    assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues.filter((i) => i.severity === "error")));
    assert.ok(r.output instanceof Uint8Array);
    return r.output;
  };
  const cases: { name: string; run: () => Uint8Array }[] = [
    { name: "fragments", run: () => run(60000000, "N", "b3") },
    { name: "texts", run: () => run(1, "Y", "b4") },
    { name: "high-price", run: () => run(200000000, "Y", "b3") },
    { name: "postprocess", run: () => run(60000000, "N", "b3", { unwrapFilled: true, refreshPreview: true }) },
    { name: "moved-ranges", run: () => run(120000000, "N", "b4", { unwrapFilled: true }, [[17, 19], [24, 27], [43, 46]]) },
  ];

  const dir = mkdtempSync(join(tmpdir(), "hwpx-v2-com-"));
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
    assert.equal(hwpCount(), before, "실행 전후 Hwp.exe 수가 다르다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
