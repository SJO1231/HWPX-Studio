// 독립 검증 재확인에서 나온 것: 결과가 없는 표 액션(비율 1, 이미 그 값인 설정)은 구역을 바뀐 것으로 치지 않는다.
// 기대는 명세 0절(원본 최소 변경)에서 정했다: 편집이 0건이면 줄 배치 캐시도 그대로이고 구역 원문이 원본과 같다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { generate, readDataset, readTemplate } from "../src/index.ts";
import { readFixture } from "./helpers.ts";
import { sectionText } from "./table-helpers.ts";

const tableAnchor = { id: "tbl", kind: "object", objectType: "tbl", sectionIndex: 0, ordinal: 0 };
const tpl = (action: Record<string, unknown>) => readTemplate({ schema: "hwpx-studio/template@1", anchors: [tableAnchor], rules: [{ id: "r", do: { anchor: "tbl", ...action } }] });

test("결과 없는 resize(scale 1)는 구역 원문을 바꾸지 않는다(줄 배치 캐시 유지)", () => {
  const bytes = readFixture("tables/tables-merged");
  const before = sectionText(bytes);
  assert.match(before, /<hp:linesegarray>/, "시험 문서에 줄 배치 캐시가 있어야 한다");
  const r = generate(bytes, tpl({ type: "resize", scale: 1 }), readDataset({}));
  assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues));
  assert.equal(sectionText(r.output), before);
});

test("대조: 실제로 크기를 바꾸는 resize는 줄 배치 캐시를 지운다", () => {
  const bytes = readFixture("tables/tables-merged");
  const r = generate(bytes, tpl({ type: "resize", scale: 0.5 }), readDataset({}));
  assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues));
  assert.doesNotMatch(sectionText(r.output), /<hp:linesegarray>/);
});
