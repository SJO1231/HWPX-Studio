// 선택 실행 교차 검증: 환경변수 HWPX_ORACLES=1일 때만 돌고, 도구가 없으면 건너뛴다(통과가 아니라 미검증).
// 생성 결과를 OS 임시 폴더에 저장해 외부 도구로 확인하고, 임시 폴더는 테스트가 지운다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractFragment, serializeFragment } from "../src/index.ts";
import { compileDocument, generate, makeLineAnchor } from "../src/fill/index.ts";
import { emptyTemplate, readDataset, readTemplate, type Template } from "../src/template/index.ts";
import { loadDoc, readFixture } from "./helpers.ts";

const ROOT = new URL("../../../", import.meta.url);
const RHWP = fileURLToPath(new URL("hwpx-edit/.cargo-root/bin/rhwp.exe", ROOT));
const VALIDATOR = fileURLToPath(new URL("tools/oracle/validate_refs.py", ROOT));

const enabled = process.env["HWPX_ORACLES"] === "1";
const python = enabled && spawnSync("python", ["--version"], { encoding: "utf8" }).status === 0;
const skipRhwp = !enabled ? "HWPX_ORACLES=1일 때만 실행" : existsSync(RHWP) ? false : `rhwp.exe가 없다(${RHWP})`;
const skipPython = !enabled ? "HWPX_ORACLES=1일 때만 실행" : python ? false : "python을 실행할 수 없다";

const tmp = enabled ? mkdtempSync(join(tmpdir(), "hwpx-fill-oracle-")) : "";
after(() => {
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

const tpl = (spec: { anchors?: unknown[]; rules?: unknown[] }): Template => readTemplate({ schema: "hwpx-studio/template@1", anchors: [], rules: [], ...spec });
const fillRule = (id: string, anchor: string, value: unknown) => ({ id, do: { type: "fill", anchor, value } });

type Case = { name: string; source: string; make: () => Uint8Array; fieldValues?: string[]; paraDelta: number };

function lineAnchor(source: string, id: string, index: number): unknown {
  return makeLineAnchor(loadDoc(source), id, 0, [index]);
}

function produce(source: string, template: Template, data: unknown, options = {}): Uint8Array {
  const r = generate(readFixture(source), template, readDataset(data), options);
  assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues));
  return (r as { output: Uint8Array }).output;
}

const CASES: Case[] = [
  {
    name: "e3-placeholders",
    source: "hancom/ph-single",
    make: () => produce("hancom/ph-single", emptyTemplate(), { project: { name: "알파", start: "2026-01-01", end: "2026-12-31" } }),
    paraDelta: 0,
  },
  {
    name: "e2-fields",
    source: "hancom/field-states",
    make: () =>
      produce("hancom/field-states", tpl({ anchors: [{ id: "a", kind: "field", name: "성명" }, { id: "b", kind: "field", name: "소속" }], rules: [fillRule("r", "a", { path: "n" }), fillRule("s", "b", { path: "o" })] }), { n: "홍길동", o: "새 기관" }),
    fieldValues: ["홍길동", "새 기관", "홍길동"],
    paraDelta: 0,
  },
  {
    name: "e7-delete",
    source: "hancom/blocks",
    make: () =>
      produce(
        "hancom/blocks",
        tpl({ anchors: [lineAnchor("hancom/blocks", "p2", 2), lineAnchor("hancom/blocks", "p3", 3), { id: "c", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 0 }], rules: [{ id: "d1", do: { type: "delete", anchor: "p2" } }, { id: "d2", do: { type: "delete", anchor: "p3" } }, { id: "d3", do: { type: "delete", anchor: "c", scope: "row" } }] }),
        {},
      ),
    paraDelta: -2,
  },
  {
    name: "e8-inject",
    source: "hancom/blocks",
    make: () => {
      const fragment = JSON.parse(serializeFragment(extractFragment(loadDoc("hancom/ph-single"), { sectionIndex: 0, parentPath: [], from: 1, to: 2 }))) as Record<string, unknown>;
      return produce("hancom/blocks", tpl({ anchors: [lineAnchor("hancom/blocks", "p3", 3)], rules: [{ id: "i", do: { type: "inject", anchor: "p3", position: "after", fragment } }] }), { project: { name: "N", start: "S", end: "E" } });
    },
    paraDelta: 2,
  },
  {
    name: "e9-picture",
    source: "hancom/blocks",
    make: () => {
      const fragment = JSON.parse(serializeFragment(extractFragment(loadDoc("hancom/picture"), { sectionIndex: 0, parentPath: [], from: 1, to: 1 }))) as Record<string, unknown>;
      return produce("hancom/blocks", tpl({ anchors: [lineAnchor("hancom/blocks", "p3", 3)], rules: [{ id: "i", do: { type: "inject", anchor: "p3", position: "after", fragment } }] }), {});
    },
    paraDelta: 1,
  },
  {
    name: "e13-insertText",
    source: "hancom/blocks",
    make: () => produce("hancom/blocks", tpl({ anchors: [lineAnchor("hancom/blocks", "p1", 1)], rules: [{ id: "i", do: { type: "insertText", anchor: "p1", position: "after", value: { path: "memo" } } }] }), { memo: "첫째\n둘째\n셋째" }),
    paraDelta: 3,
  },
  {
    name: "e12-merged",
    source: "hancom-merged",
    make: () => produce("hancom-merged", tpl({ anchors: [lineAnchor("hancom-merged", "a", 8)], rules: [fillRule("r", "a", { text: "편집한 문단" })] }), {}),
    paraDelta: 0,
  },
  {
    name: "e6-compile",
    source: "hancom/ph-table",
    make: () => {
      const r = compileDocument(readFixture("hancom/ph-table"));
      assert.ok(r.ok);
      return (r as { output: Uint8Array }).output;
    },
    fieldValues: ["{{applicant.name}}", "{{note}}"],
    paraDelta: 0,
  },
];

function write(c: Case): { result: string; original: string } {
  const result = join(tmp, `${c.name}.hwpx`);
  const original = join(tmp, `${c.name}.orig.hwpx`);
  writeFileSync(result, c.make());
  writeFileSync(original, readFixture(c.source));
  return { result, original };
}

type RhwpInfo = { format: string; sections: number; paraCount: number; pageCount: number; warnings: unknown[] };
function rhwpInfo(file: string): { status: number | null; info?: RhwpInfo; stderr: string } {
  const r = spawnSync(RHWP, ["info", file, "--json"], { encoding: "utf8", timeout: 120_000 });
  return r.status === 0 ? { status: 0, info: JSON.parse(r.stdout) as RhwpInfo, stderr: r.stderr } : { status: r.status, stderr: r.stderr };
}
function rhwpFields(file: string): string[] {
  const r = spawnSync(RHWP, ["fields", file, "--json"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return (JSON.parse(r.stdout) as { fields: { value: string }[] }).fields.map((f) => f.value);
}

type PyReport = { errors: { code: string; msg: string; where: string; count: number }[] };
function validate(file: string): PyReport {
  const out = `${file}.json`;
  spawnSync("python", [VALIDATOR, file, "--json", out, "--quiet"], { encoding: "utf8", timeout: 120_000 });
  const results = (JSON.parse(readFileSync(out, "utf8")) as { results: PyReport[] }).results;
  const report = results[0];
  assert.ok(report !== undefined);
  return report;
}

for (const c of CASES) {
  test(`오라클 rhwp: 생성 결과를 종료 코드 0으로 파싱하고 쪽·문단 수가 맞는다 (${c.name})`, { skip: skipRhwp }, () => {
    const { result, original } = write(c);
    const before = rhwpInfo(original);
    assert.equal(before.status, 0, before.stderr);
    const after = rhwpInfo(result);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.info?.format, "hwpx");
    assert.equal(after.info?.sections, before.info?.sections);
    assert.equal(after.info?.paraCount, (before.info?.paraCount ?? 0) + c.paraDelta);
    assert.ok((after.info?.warnings.length ?? 0) <= (before.info?.warnings.length ?? 0), "rhwp 경고가 늘지 않는다");
    if (c.name === "e12-merged" || c.name === "e3-placeholders" || c.name === "e2-fields") {
      assert.equal(after.info?.pageCount, before.info?.pageCount, "쪽 수가 같다");
    }
  });

  test(`오라클 Python 검사기: 오류 수가 원본보다 늘지 않는다 (${c.name})`, { skip: skipPython }, () => {
    const { result, original } = write(c);
    const before = validate(original);
    const after = validate(result);
    assert.ok(after.errors.length <= before.errors.length, `오류 ${before.errors.length} → ${after.errors.length}: ${JSON.stringify(after.errors)}`);
    const total = (r: PyReport): number => r.errors.reduce((n, e) => n + e.count, 0);
    assert.ok(total(after) <= total(before), `오류 합계 ${total(before)} → ${total(after)}`);
  });

  if (c.fieldValues !== undefined) {
    const expected = c.fieldValues;
    test(`오라클 rhwp: fields가 채운 누름틀 값을 보여 준다 (${c.name})`, { skip: skipRhwp }, () => {
      const { result } = write(c);
      assert.deepEqual(rhwpFields(result), expected);
    });
  }
}
