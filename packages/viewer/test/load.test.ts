// rhwp 초기화 상태: "초기화를 시작했다"와 "끝났다"는 다르다. 끝나기 전·실패한 뒤에는 열지 못해야 한다.
// 이 시험 파일은 자기 프로세스에서 rhwp를 처음 초기화하므로 다른 시험의 초기화에 영향받지 않는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRhwpLoaded, loadRhwp, openDocument, ViewerError } from "../src/rhwp/index.ts";
import { ensureRhwp, readFixture } from "./helpers.ts";

test("초기화가 끝나기 전·실패한 뒤에는 불러온 것으로 보지 않고, 성공해야 불러온 것이 된다", async () => {
  assert.equal(isRhwpLoaded(), false);

  // 쓸 수 없는 wasm: 시작은 했지만 끝나지 않았고(곧 실패한다)
  const failing = loadRhwp({ wasmUrl: "data:application/wasm;base64,AAAA" });
  assert.equal(isRhwpLoaded(), false, "초기화가 진행 중인데 불러온 것으로 보고한다");
  assert.throws(() => openDocument(readFixture("hancom/ph-single")), (e: unknown) => e instanceof ViewerError && e.code === "VIEWER_NOT_LOADED");
  await assert.rejects(failing, (e: unknown) => e instanceof ViewerError);
  assert.equal(isRhwpLoaded(), false, "초기화가 실패했는데 불러온 것으로 보고한다");

  // 실패 뒤에는 다시 시도할 수 있고, 성공해야 불러온 것이 된다
  await ensureRhwp();
  assert.equal(isRhwpLoaded(), true);
  openDocument(readFixture("hancom/ph-single")).free();
});
