// 세션 저장소와 건수·크기 한도: 열린 수와 바이트 총합이 한도를 넘으면 가장 오래된 것부터 닫고, 방금 연 세션은 남긴다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HostError } from "../../../packages/viewer/src/host/index.ts";
import { MAX_RESULT_BYTES, analyzePlaces, generateAll, parseQuickData } from "../src/quick.ts";
import { MAX_SESSIONS, MAX_SESSION_BYTES, createSessionStore } from "../src/sessions.ts";
import { readFixture } from "./helpers.ts";

const doc = readFixture("hancom/ph-single");
const places = analyzePlaces(doc);

test("세션 수 한도: 기본 4개, 넘으면 가장 오래된 것부터 닫힌다", () => {
  assert.equal(MAX_SESSIONS, 4);
  const store = createSessionStore();
  const first = store.open("a.hwpx", new Uint8Array(doc), places);
  const rest = Array.from({ length: 4 }, () => store.open("b.hwpx", new Uint8Array(doc), places));
  assert.equal(store.size(), 4);
  assert.equal(store.get(first.id), undefined);
  for (const s of rest) assert.ok(store.get(s.id) !== undefined);
});

test("바이트 한도: 원본·데이터·결과 바이트의 합이 한도를 넘으면 오래된 세션부터 닫고, 방금 바뀐 세션은 남긴다", () => {
  assert.equal(MAX_SESSION_BYTES, 768 * 1024 * 1024);
  const one = doc.length;
  const store = createSessionStore(10, one * 3);
  const a = store.open("a", new Uint8Array(doc), places);
  const b = store.open("b", new Uint8Array(doc), places);
  const c = store.open("c", new Uint8Array(doc), places);
  assert.equal(store.size(), 3);
  // b가 결과 바이트를 갖게 되어 총합이 한도를 넘으면 가장 오래된 a가 닫힌다
  b.last = { results: [], files: [new Uint8Array(one)], folder: undefined };
  store.touch(b);
  assert.deepEqual([store.get(a.id), store.get(b.id) === undefined, store.get(c.id) === undefined], [undefined, false, false]);
  // 한 세션이 한도보다 커도 방금 바뀐 세션은 남는다
  c.dataBytes = one * 10;
  store.touch(c);
  assert.deepEqual([store.size(), store.get(b.id), store.get(c.id) === undefined], [1, undefined, false]);
});

test("결과 크기 한도: 건수 × 원본 크기가 한도를 넘을 것 같으면 하나도 만들지 않고 QUICK_TOO_LARGE(413)다", () => {
  const data = parseQuickData(new TextEncoder().encode(JSON.stringify(new Array(600).fill({ project: { name: "a", start: "b", end: "c" } }))));
  const huge = { length: Math.ceil(MAX_RESULT_BYTES / 500) } as unknown as Uint8Array;
  assert.throws(
    () => generateAll(huge, places, data, "x.hwpx", "error"),
    (e: unknown) => e instanceof HostError && e.status === 413 && e.code === "QUICK_TOO_LARGE",
  );
});
