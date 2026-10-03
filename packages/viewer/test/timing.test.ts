// V8의 시험 문서 쪽: 시험 문서 중 가장 큰 것의 열기·쪽 그리기·글자 배치·클릭 위치 시간과 rhwp 쪽 수. 시간은 기준이 아니라 기록이다
// (실제 문서 상위 3건은 `tools/crosscheck.ts`가 잰다). 한컴 쪽 수와의 차이는 한컴 COM이 필요해 이 시험에서 재지 않는다.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { openDocument } from "../src/rhwp/index.ts";
import { measureDocument } from "../tools/verify.ts";
import { ensureRhwp, fixtureNames, readFixture } from "./helpers.ts";

before(ensureRhwp);

test("V8: 시험 문서의 rhwp 쪽 수와 가장 큰 문서의 시간 기록", (t) => {
  const rows = fixtureNames().map((name) => {
    const bytes = readFixture(name);
    const doc = openDocument(bytes);
    try {
      return { name, bytes: bytes.length, pages: doc.pageCount() };
    } finally {
      doc.free();
    }
  });
  assert.equal(rows.length, 30);
  t.diagnostic(`rhwp 쪽 수: ${rows.map((r) => `${r.name}=${r.pages}`).join(" ")}`);
  const biggest = [...rows].sort((a, b) => b.pages - a.pages || b.bytes - a.bytes)[0];
  assert.ok(biggest !== undefined);
  const timing = measureDocument(readFixture(biggest.name), 100);
  assert.ok(timing !== undefined);
  for (const v of Object.values(timing)) assert.ok(Number.isFinite(v) || Number.isNaN(v));
  assert.ok(timing.rhwpOpen > 0 && timing.pages === biggest.pages);
  t.diagnostic(`가장 큰 시험 문서(${biggest.name}, ${biggest.bytes}바이트, ${biggest.pages}쪽): ${JSON.stringify(Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, Number(v.toFixed(2))])))}`);
});
