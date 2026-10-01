import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_NAMES, readFixture, readFixtureText, sha256Hex } from "./helpers.ts";

test("fixtures: SHA256SUMS가 9개 사본의 해시와 일치한다", () => {
  const listed = new Map<string, string>();
  for (const line of readFixtureText("SHA256SUMS").split("\n")) {
    if (line.trim() === "") continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    assert.ok(m !== null, `해석할 수 없는 줄: ${line}`);
    listed.set(m[2] ?? "", m[1] ?? "");
  }
  assert.equal(listed.size, 9);
  for (const name of FIXTURE_NAMES) {
    assert.equal(sha256Hex(readFixture(name)), listed.get(`${name}.hwpx`), `${name}.hwpx`);
  }
});
