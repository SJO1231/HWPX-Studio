// 화면의 응답 순서·세션 교체 규칙(web/guards.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeReplaced, createLatest } from "../web/guards.ts";

/** 서버 응답을 시험이 원하는 때 돌려주기 위한 약속 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** `main.ts`의 `onPick`이 locate 응답을 반영하는 모양 그대로: 번호표를 받고, 응답이 왔을 때 최근 것일 때만 쓴다 */
function clicker(latest: ReturnType<typeof createLatest>, applied: string[]) {
  return async (label: string, response: Promise<string>): Promise<void> => {
    const ticket = latest.begin();
    const r = await response;
    if (!latest.current(ticket)) return;
    applied.push(`${label}:${r}`);
  };
}

test("리뷰 1: 먼저 누른 점의 응답이 나중에 와도 화면은 마지막으로 누른 점의 응답을 쓴다", async () => {
  const applied: string[] = [];
  const click = clicker(createLatest(), applied);
  const a = deferred<string>();
  const b = deferred<string>();
  const first = click("A", a.promise);
  const second = click("B", b.promise);
  b.resolve("b");
  await second;
  a.resolve("a"); // 늦게 온 A
  await first;
  assert.deepEqual(applied, ["B:b"]);
});

test("리뷰 1: 채우기·문서 교체(cancel) 뒤에 도착한 이전 문서의 응답은 버린다. 그 뒤의 새 요청은 쓴다", async () => {
  const latest = createLatest();
  const applied: string[] = [];
  const click = clicker(latest, applied);
  const old = deferred<string>();
  const pending = click("old", old.promise);
  latest.cancel(); // 문서가 바뀌었다
  old.resolve("x");
  await pending;
  assert.deepEqual(applied, []);
  await click("new", Promise.resolve("y"));
  assert.deepEqual(applied, ["new:y"]);
});

test("리뷰 3: 새 문서를 연 뒤에는 이전 세션을 닫고, 같은 세션을 다시 불러온 경우·이전이 없는 경우는 닫지 않으며, 닫기 실패는 삼킨다", async () => {
  const closed: string[] = [];
  const close = (id: string): Promise<void> => {
    closed.push(id);
    return Promise.resolve();
  };
  await closeReplaced(undefined, "n1", close);
  await closeReplaced("s1", "s1", close); // 채움·되돌리기
  assert.deepEqual(closed, []);
  await closeReplaced("s1", "s2", close);
  assert.deepEqual(closed, ["s1"]);
  await closeReplaced("s2", "s3", () => Promise.reject(new Error("이미 닫힘")));
});
