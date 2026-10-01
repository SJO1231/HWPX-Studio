// 선택 실행 교차 검증: 환경변수 HWPX_ORACLES=1일 때만 돌고, 도구가 없으면 건너뛴다.
// 가져오기 결과를 OS 임시 폴더에 저장해 외부 도구로 확인하고, 임시 폴더는 테스트가 지운다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyPlan, extractFragment, planImport } from "../src/index.ts";
import { loadDoc } from "./helpers.ts";

const ROOT = new URL("../../../", import.meta.url);
const RHWP = fileURLToPath(new URL("hwpx-edit/.cargo-root/bin/rhwp.exe", ROOT));
const VALIDATOR = fileURLToPath(new URL("hwpx-edit/validate_refs.py", ROOT));

const enabled = process.env["HWPX_ORACLES"] === "1";
const python = enabled && spawnSync("python", ["--version"], { encoding: "utf8" }).status === 0;
const skipRhwp = !enabled ? "HWPX_ORACLES=1일 때만 실행" : existsSync(RHWP) ? false : `rhwp.exe가 없다(${RHWP})`;
const skipPython = !enabled ? "HWPX_ORACLES=1일 때만 실행" : python ? false : "python을 실행할 수 없다";

const tmp = enabled ? mkdtempSync(join(tmpdir(), "hwpx-oracle-")) : "";
after(() => {
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

type Case = { name: string; src: string; from: number; to: number; target: string; inserted: number };

// 가져오기 결과로 만들 문서들. inserted는 삽입한 최상위 문단 수다.
const CASES: Case[] = [
  { name: "d5-table-d1", src: "D5", from: 7, to: 7, target: "D1", inserted: 1 },
  { name: "d5-paragraphs-d1", src: "D5", from: 4, to: 6, target: "D1", inserted: 3 },
  { name: "d1-table-self", src: "D1", from: 9, to: 9, target: "D1", inserted: 1 },
  { name: "merged-d1", src: "hancom-merged", from: 1, to: 8, target: "D1", inserted: 8 },
  { name: "picture-d1", src: "hancom/picture", from: 1, to: 1, target: "D1", inserted: 1 },
  { name: "picture-blocks", src: "hancom/picture", from: 1, to: 1, target: "hancom/blocks", inserted: 1 },
  { name: "field-self", src: "hancom/field-states", from: 1, to: 2, target: "hancom/field-states", inserted: 2 },
  { name: "bookmark-d1", src: "extra/features-picture", from: 15, to: 15, target: "D1", inserted: 1 },
  { name: "features-picture-d1", src: "extra/features-picture", from: 14, to: 14, target: "D1", inserted: 1 },
  { name: "table-hancom", src: "hancom/ph-table", from: 1, to: 1, target: "hancom/blocks", inserted: 1 },
];

/** 가져오기 결과를 임시 폴더에 저장하고 경로를 돌려준다. 대상 원본도 같은 폴더에 사본으로 둔다. */
function write(c: Case): { result: string; original: string; targetParagraphs: number } {
  const src = loadDoc(c.src);
  const target = loadDoc(c.target);
  const fragment = extractFragment(src, { sectionIndex: 0, parentPath: [], from: c.from, to: c.to });
  const plan = planImport(target, fragment, {
    sectionIndex: 0,
    parentPath: [],
    index: (target.sections[0]?.paragraphs.length ?? 1) - 1,
    position: "after",
  });
  const result = join(tmp, `${c.name}.hwpx`);
  const original = join(tmp, `${c.name}.orig.hwpx`);
  writeFileSync(result, applyPlan(target.pkg, plan));
  writeFileSync(original, target.pkg.bytes);
  return { result, original, targetParagraphs: target.sections[0]?.paragraphs.length ?? 0 };
}

type RhwpInfo = { format: string; sections: number; paraCount: number; pageCount: number; warnings: unknown[] };
function rhwpInfo(file: string): { status: number | null; info?: RhwpInfo; stderr: string } {
  const r = spawnSync(RHWP, ["info", file, "--json"], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) return { status: r.status, stderr: r.stderr };
  return { status: 0, info: JSON.parse(r.stdout) as RhwpInfo, stderr: r.stderr };
}

type PyReport = { errors: { code: string; msg: string; where: string; count: number }[]; warnings: unknown[] };
function validate(file: string): PyReport {
  const out = `${file}.json`;
  spawnSync("python", [VALIDATOR, file, "--json", out, "--quiet"], { encoding: "utf8", timeout: 120_000 });
  const parsed = JSON.parse(readFileSync(out, "utf8")) as { results: PyReport[] };
  const report = parsed.results[0];
  assert.ok(report !== undefined);
  return report;
}
const errorCount = (r: PyReport): number => r.errors.length;
const errorTotal = (r: PyReport): number => r.errors.reduce((n, e) => n + e.count, 0);

for (const c of CASES) {
  test(`오라클 rhwp: 가져오기 결과를 종료 코드 0으로 파싱한다 (${c.name})`, { skip: skipRhwp }, () => {
    const { result, original, targetParagraphs } = write(c);
    const before = rhwpInfo(original);
    assert.equal(before.status, 0, `대상 원본: ${before.stderr}`);
    const after = rhwpInfo(result);
    assert.equal(after.status, 0, `결과: ${after.stderr}`);
    assert.equal(after.info?.format, "hwpx");
    assert.equal(after.info?.sections, before.info?.sections);
    // rhwp가 센 최상위 문단 수가 삽입한 만큼 늘었다
    assert.equal(before.info?.paraCount, targetParagraphs);
    assert.equal(after.info?.paraCount, targetParagraphs + c.inserted);
    assert.ok((after.info?.warnings.length ?? 0) <= (before.info?.warnings.length ?? 0), "rhwp 경고가 늘지 않는다");
  });

  test(`오라클 Python 검사기: 오류 수가 대상 원본보다 늘지 않는다 (${c.name})`, { skip: skipPython }, () => {
    const { result, original } = write(c);
    const before = validate(original);
    const after = validate(result);
    assert.ok(errorCount(after) <= errorCount(before), `오류 ${errorCount(before)} → ${errorCount(after)}: ${JSON.stringify(after.errors)}`);
    assert.ok(errorTotal(after) <= errorTotal(before), `오류 합계 ${errorTotal(before)} → ${errorTotal(after)}`);
    // 새 오류 코드·메시지가 없다
    const known = new Set(before.errors.map((e) => `${e.code}|${e.msg}|${e.where}`));
    for (const e of after.errors) assert.ok(known.has(`${e.code}|${e.msg}|${e.where}`), `새 오류 ${e.code} ${e.msg}`);
  });
}

test("오라클 Python 검사기: 문단 id는 건드리지 않으므로 id가 있는 문단을 자기 자신에게 가져오면 문단 id 중복이 센다 (알려진 동작)", { skip: skipPython }, () => {
  const doc = loadDoc("extra/features-picture");
  const fragment = extractFragment(doc, { sectionIndex: 0, parentPath: [], from: 15, to: 15 });
  const plan = planImport(doc, fragment, { sectionIndex: 0, parentPath: [], index: 17, position: "after" });
  const file = join(tmp, "paragraph-id-dup.hwpx");
  const original = join(tmp, "paragraph-id-dup.orig.hwpx");
  writeFileSync(file, applyPlan(doc.pkg, plan));
  writeFileSync(original, doc.pkg.bytes);
  const before = validate(original);
  const after = validate(file);
  const added = after.errors.filter((e) => !before.errors.some((b) => b.code === e.code && b.msg === e.msg && b.where === e.where));
  assert.deepEqual(added.map((e) => e.code), ["INST_DUP_ID"]);
  assert.ok(added[0]?.msg.includes("paragraph id 중복: '705723480'"), added[0]?.msg);
});
