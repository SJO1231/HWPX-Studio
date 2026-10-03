import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyTemplate, generate, readDataset } from "../src/index.ts";
import { readFixture } from "./helpers.ts";

// 적용된 액션이 0인 생성: 기본은 FILL_NOTHING_APPLIED로 실패하고, allowNothingApplied를 켜면 원본과 같은 결과를 낸다
// (studio-lite가 블록 교체 뒤 채울 자리가 없는 문서에 채움 단계를 돌릴 때 쓴다. CLI·빠른 생성은 켜지 않는다).
test("allowNothingApplied: 채울 자리가 없는 문서는 기본 실패, 옵션을 켜면 성공하고 바이트가 원본과 같다", () => {
  const bytes = readFixture("hancom/picture");
  const data = readDataset({});
  const strict = generate(bytes, emptyTemplate(), data, { missing: "keep" });
  assert.equal(strict.ok, false);
  assert.ok(strict.report.issues.some((i) => i.code === "FILL_NOTHING_APPLIED"));
  const lenient = generate(bytes, emptyTemplate(), data, { missing: "keep", allowNothingApplied: true });
  assert.equal(lenient.ok, true);
  if (!lenient.ok || lenient.dryRun) throw new Error("출력이 있어야 한다");
  assert.deepEqual(Buffer.from(lenient.output), Buffer.from(bytes));
});
