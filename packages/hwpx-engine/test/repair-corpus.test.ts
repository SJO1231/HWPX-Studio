import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { repairDocument } from "../src/repair/index.ts";
import { validateDocument, type ValidationIssue } from "../src/validate/index.ts";

// P4(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 해서 기본 보정을 메모리에서 적용한다.
// 쓰기·복사는 하지 않고, 문서 이름과 내용은 기록하지 않는다(수량만 집계한다).
const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;

function* hwpxFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* hwpxFiles(path);
    else if (e.name.toLowerCase().endsWith(".hwpx")) yield path;
  }
}

function byCode(list: ValidationIssue[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of list) out[i.code] = (out[i.code] ?? 0) + i.count;
  return out;
}

function add(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

function sorted(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

test("P4 실제 문서 표본: 원래 오류가 있는 문서에 기본 보정을 적용하면 오류가 줄거나 같고 새 오류는 0", { skip: SKIP }, (t) => {
  assert.ok(typeof DIR === "string");
  let documents = 0;
  let withErrors = 0;
  let exceptions = 0;
  let mutatedInputs = 0;
  let reduced = 0;
  let same = 0;
  let increased = 0;
  let zeroAfter = 0;
  let repairedDocuments = 0;
  const exceptionCodes: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const kindDocuments: Record<string, number> = {};
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};

  for (const file of hwpxFiles(DIR)) {
    documents++;
    const bytes = readFileSync(file);
    if (validateDocument(bytes).errors.length === 0) continue;
    withErrors++;
    const fingerprint = crc32(bytes);
    try {
      const r = repairDocument(bytes);
      const b = byCode(r.before.errors);
      const a = byCode(r.after.errors);
      add(before, b);
      add(after, a);
      const sum = (o: Record<string, number>): number => Object.values(o).reduce((x, y) => x + y, 0);
      if (sum(a) < sum(b)) reduced++;
      else if (sum(a) === sum(b)) same++;
      else increased++;
      if (sum(a) === 0) zeroAfter++;
      if (r.repaired.length > 0) repairedDocuments++;
      for (const k of new Set(r.repaired.map((n) => n.kind))) kindDocuments[k] = (kindDocuments[k] ?? 0) + 1;
      for (const n of r.repaired) kinds[n.kind] = (kinds[n.kind] ?? 0) + n.count;
    } catch (e) {
      exceptions++;
      const code = e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : "(코드 없음)";
      exceptionCodes[code] = (exceptionCodes[code] ?? 0) + 1;
    }
    if (crc32(bytes) !== fingerprint) mutatedInputs++;
  }

  t.diagnostic(
    JSON.stringify({
      documents,
      withErrors,
      repairedDocuments,
      errorsReduced: reduced,
      errorsSame: same,
      errorsIncreased: increased,
      zeroErrorsAfter: zeroAfter,
      exceptions,
      exceptionCodes,
      inputMutated: mutatedInputs,
      repairedByKind: sorted(kinds),
      documentsByKind: sorted(kindDocuments),
      errorsBeforeByCode: sorted(before),
      errorsAfterByCode: sorted(after),
    }),
  );
  assert.equal(exceptions, 0, `보정 중 예외 ${JSON.stringify(exceptionCodes)}`);
  assert.equal(increased, 0, "오류가 늘어난 문서가 없다");
  assert.equal(mutatedInputs, 0, "입력 바이트는 바뀌지 않는다");
  for (const [code, n] of Object.entries(after)) assert.ok(n <= (before[code] ?? 0), `${code}: 보정 뒤 ${n} > 보정 전 ${before[code] ?? 0}`);
});
