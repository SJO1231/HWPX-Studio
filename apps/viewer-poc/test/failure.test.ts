// 서버 응답이 JSON이 아니어도 화면이 상태 코드로 설명하는 규칙(web/failure.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { failureText } from "../web/failure.ts";

test("리뷰 10: JSON 오류 본문은 코드와 메시지로, JSON이 아닌 본문은 상태 코드로 설명한다", async () => {
  // 예전 화면은 상태를 보기 전에 res.json()을 불러, 글로 온 403이 상태 코드 없는 구문 오류로 보였다
  await assert.rejects(new Response("허용되지 않은 호스트입니다.", { status: 403 }).json(), SyntaxError);

  assert.equal(failureText(404, JSON.stringify({ error: { code: "SESSION_NOT_FOUND", message: "세션이 없습니다." } })), "SESSION_NOT_FOUND: 세션이 없습니다.");
  const forbidden = failureText(403, "허용되지 않은 호스트입니다.");
  assert.match(forbidden, /403/);
  assert.match(forbidden, /허용되지 않은 호스트/);
  assert.match(failureText(500, ""), /^HTTP 500: 서버 내부 오류/);
  assert.match(failureText(502, "<html>Bad Gateway</html>"), /^HTTP 502: .*Bad Gateway/);
  // 형이 다른 JSON({ error: 글 })도 상태 코드로 설명한다
  assert.match(failureText(400, JSON.stringify({ error: "x" })), /^HTTP 400:/);
  assert.match(failureText(200, "not json"), /^HTTP 200: 서버 응답이 JSON이 아닙니다/);
});
