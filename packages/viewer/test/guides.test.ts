// 안내문 상태 누름틀 판정(`guideFields`)의 종류 비교는 엔진의 필드 종류 판정(이슈 #12)과 같다: type을 대소문자 무시로 보고 `clickhere`도 누름틀이다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { guideFields } from "../src/map/index.ts";
import { FIELD_BEGIN, FIELD_END, P, R, T, parse, synth } from "./helpers.ts";

test("안내문 판정: 소문자·혼합·밑줄 없는 type(click_here·Click_Here·clickhere)의 누름틀도 대문자 CLICK_HERE와 같은 안내문 결과다. 다른 종류(date)는 안내문이 아니다", () => {
  const paragraphs = [
    P(R(T("가: ") + FIELD_BEGIN("12", "소속", "0", "소속 입력")) + R(T("소속 입력"), "7") + R(FIELD_END("12") + T("뒤"))),
    P(R(T("나: ") + FIELD_BEGIN("13", "성명", "0", "이름 입력") + FIELD_END("13") + T("뒤"))),
  ];
  const guidesOf = (type: string) => {
    const bytes = synth(paragraphs.map((p) => p.replaceAll('type="CLICK_HERE"', `type="${type}"`)));
    return (parse(bytes).sections[0]?.paragraphs ?? []).slice(-2).map((p) => guideFields(p));
  };
  const upper = guidesOf("CLICK_HERE");
  assert.deepEqual(upper.map((g) => g.map((x) => x.text)), [["소속 입력"], ["이름 입력"]], "전제: 대문자 누름틀은 안내문이다");
  for (const type of ["click_here", "Click_Here", "clickhere", "CLICKHERE"]) assert.deepEqual(guidesOf(type), upper, type);
  assert.deepEqual(guidesOf("date"), [[], []]);
});
