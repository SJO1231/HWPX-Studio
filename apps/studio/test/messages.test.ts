// Q5: 엔진의 모든 오류·건너뜀 코드에 쉬운 말 설명이 있고, 모르는 코드도 깨지지 않는다.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KNOWN_CODES, UNKNOWN_EXPLANATION, plainOf } from "../src/messages.ts";

const ENGINE_SRC = fileURLToPath(new URL("../../../packages/hwpx-engine/src/", import.meta.url));

/** 코드가 아니라 HWPX 속성 값(선 모양·줄 간격 등)이 문자열로 나오는 상수. 새 상수가 생기면 코드인지 아닌지 가려 여기나 messages.ts에 넣는다. */
const NOT_CODES = new Set([
  "ACUTE_ACCENT", "AT_LEAST", "BETWEEN_LINES", "BREAK_WORD", "CLICK_HERE", "DASH_DOT", "DASH_DOT_DOT", "DISTRIBUTE_SPACE", "DOT_ABOVE", "DOT_BELOW",
  "DOUBLE_SLIM", "GRAVE_ACCENT", "HOOK_ABOVE", "KEEP_WORD", "LONG_DASH", "RING_ABOVE", "SLIM_THICK", "SLIM_THICK_SLIM", "THICK_SLIM",
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** 엔진 소스에서 `"[A-Z]+_[A-Z_]+"` 꼴 글자 상수를 전부 모은다(주석 안의 `백틱` 표기는 따옴표가 아니므로 모이지 않는다). */
function engineLiterals(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources(ENGINE_SRC)) {
    for (const m of readFileSync(file, "utf8").matchAll(/["']([A-Z][A-Z0-9]*_[A-Z0-9_]+)["']/g)) {
      if (!found.has(m[1] as string)) found.set(m[1] as string, file.slice(ENGINE_SRC.length));
    }
  }
  return found;
}

test("Q5: 엔진 소스의 모든 오류·건너뜀 코드가 설명 표에 있다", () => {
  const literals = engineLiterals();
  assert.ok(literals.size >= 150, `엔진에서 모은 상수 ${literals.size}개`);
  const missing = [...literals].filter(([code]) => !NOT_CODES.has(code) && !KNOWN_CODES.includes(code)).map(([code, file]) => `${code} (${file})`);
  assert.deepEqual(missing, [], "새 코드이면 messages.ts에 설명을 더하고, 코드가 아닌 상수이면 이 시험의 NOT_CODES에 넣는다");
  // NOT_CODES는 실제로 엔진에 있는 상수만 담는다(오래된 항목이 쌓이지 않게)
  assert.deepEqual([...NOT_CODES].filter((c) => !literals.has(c)), []);
  assert.deepEqual([...NOT_CODES].filter((c) => KNOWN_CODES.includes(c)), [], "코드가 아닌 상수가 설명 표에 있다");
});

test("Q5: 표의 설명은 모두 비어 있지 않은 한국어 한 문장이고, 코드 이름만 되풀이하지 않는다", () => {
  assert.ok(KNOWN_CODES.length >= 150);
  for (const code of KNOWN_CODES) {
    const text = plainOf(code);
    assert.ok(text.length >= 8, `${code}: 너무 짧다`);
    assert.match(text, /[가-힣]/, `${code}: 한국어가 아니다`);
    assert.ok(!text.includes(code), `${code}: 설명이 코드 이름을 되풀이한다`);
    assert.doesNotMatch(text, /[\n\r]/, `${code}: 한 줄이어야 한다`);
    assert.ok(!text.startsWith(`${code}:`) && !text.includes(UNKNOWN_EXPLANATION), `${code}: 일반 설명으로 때웠다`);
  }
  assert.equal(new Set(KNOWN_CODES).size, KNOWN_CODES.length);
});

test("Q5: 모르는 코드·이상한 값도 깨지지 않고 코드와 일반 설명이 나온다", () => {
  assert.equal(plainOf("NEW_ENGINE_CODE"), `NEW_ENGINE_CODE: ${UNKNOWN_EXPLANATION}`);
  for (const odd of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(plainOf(odd), `${odd}: ${UNKNOWN_EXPLANATION}`, odd);
  for (const odd of [undefined, null, 7, {}, [], "", true]) assert.equal(plainOf(odd), `(코드 없음): ${UNKNOWN_EXPLANATION}`, String(odd));
  const long = plainOf(`X_${"Y".repeat(500)}\n\u0000`);
  assert.ok(long.length < 130 && !/[\u0000-\u001f]/.test(long));
});

test("Q5: 쉬운 말은 값 원문을 모른다 — 같은 코드는 언제나 같은 문장이다", () => {
  assert.equal(plainOf("DATA_MISSING"), plainOf("DATA_MISSING"));
  assert.match(plainOf("DATA_MISSING"), /없습니다/);
  assert.match(plainOf("VALUE_CONTROL_CHAR"), /제어 문자/);
  assert.match(plainOf("FILL_MIXED_FORMAT"), /글자 모양/);
  assert.match(plainOf("PKG_NOT_ZIP"), /\.hwpx/);
});

test("Q5: 채울 수 없는 모양의 누름틀과 {{키}} 충돌의 설명은 원인(줄바꿈·탭·끝 표식 없음·누름틀 안의 {{키}})과 할 일을 말한다", () => {
  const shape = plainOf("FIELD_UNSUPPORTED_SHAPE");
  for (const cause of ["여러 문단", "줄바꿈·탭·그림·표", "끝 표식", "한컴에서"]) assert.ok(shape.includes(cause), cause);
  const conflict = plainOf("TPL_CONFLICT");
  for (const cause of ["누름틀 안에 적힌 {{키}}", "충돌", "한컴에서"]) assert.ok(conflict.includes(cause), cause);
});
