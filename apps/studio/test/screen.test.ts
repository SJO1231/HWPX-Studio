// 화면 문구 시험: 브라우저 없이, 요소의 글만 모으는 최소 가짜 DOM과 가짜 fetch로 web/main.ts를 그대로 실행한다.
// 서버가 줄 응답은 quick.ts의 함수 결과(서버 핸들러가 부르는 것과 같다)이고, 여기서는 화면이 그것을 어떤 글로 보이는지만 확인한다. 디스크에 쓰지 않는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataResponse, GenerateResponse, TemplateResponse } from "../src/api-types.ts";
import { plainOf } from "../src/messages.ts";
import { analyzePlaces, generateAll, listKeys, matchPlaces, parseQuickData } from "../src/quick.ts";
import { FIELD_BEGIN, FIELD_END, P, PIC, R, T, TBL, synth } from "../../../packages/viewer/test/helpers.ts";
import { blockMessages, crossed, openCross, readFixture, secBetween } from "./helpers.ts";

class FakeEl {
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  href = "";
  type = "";
  files: { name: string }[] | undefined;
  children: (FakeEl | string)[] = [];
  readonly listeners = new Map<string, (() => void)[]>();
  readonly classList = { toggle: (): void => {} };
  append(...nodes: (FakeEl | string)[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeEl | string)[]): void {
    this.children = nodes;
    this.textContent = "";
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  text(): string {
    return this.textContent + this.children.map((c) => (typeof c === "string" ? c : c.text())).join("");
  }
}

const byId = new Map<string, FakeEl>();
const element = (id: string): FakeEl => {
  let el = byId.get(id);
  if (el === undefined) byId.set(id, (el = new FakeEl()));
  return el;
};

// 서버 응답을 대신하는 가짜 fetch: 지금 올린 문서·데이터로 quick.ts가 만든 응답을 준다
let upload: { bytes: Uint8Array; data: Uint8Array } | undefined;
let analyzed: ReturnType<typeof analyzePlaces> | undefined;
let parsed: ReturnType<typeof parseQuickData> | undefined;
const respond = (path: string): TemplateResponse | DataResponse | GenerateResponse => {
  if (upload === undefined) throw new Error("올린 문서가 없다");
  if (path.startsWith("/api/quick/template")) {
    analyzed = analyzePlaces(upload.bytes);
    return { session: "s", name: "x.hwpx", bytes: upload.bytes.length, places: analyzed };
  }
  if (analyzed === undefined) throw new Error("문서를 먼저 올려야 한다");
  if (path.startsWith("/api/quick/data")) {
    parsed = parseQuickData(upload.data);
    const { keys, truncated } = listKeys(parsed.records);
    return { session: "s", form: parsed.form, records: parsed.records.length, invalidRecords: 0, keys, keysTruncated: truncated, matches: matchPlaces(analyzed, parsed.records) };
  }
  if (parsed === undefined) throw new Error("데이터를 먼저 올려야 한다");
  return { session: "s", results: generateAll(upload.bytes, analyzed, parsed, "x.hwpx", "error").map((g) => g.view), folder: null };
};
Object.assign(globalThis, {
  document: {
    getElementById: element,
    createElement: () => new FakeEl(),
    querySelector: () => ({ value: "error" }),
  },
  fetch: (path: string) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(respond(path))) }),
});
await import(new URL("../web/main.ts", import.meta.url).href);

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const textOf = (node: FakeEl | string | undefined): string => (node === undefined ? "" : typeof node === "string" ? node : node.text());
const childrenOf = (node: FakeEl | string | undefined): (FakeEl | string)[] => (node === undefined || typeof node === "string" ? [] : node.children);

type Screen = { places: string[]; matches: string[][]; results: string[][] };

/** 문서 올리기 → 데이터 올리기 → 생성을 차례로 누르고, 화면에 나온 누름틀 목록·대조표·결과 표를 글로 모은다. */
async function run(bytes: Uint8Array, data: unknown): Promise<Screen> {
  upload = { bytes, data: new TextEncoder().encode(JSON.stringify(data)) };
  analyzed = undefined;
  parsed = undefined;
  element("file-template").files = [{ name: "x.hwpx" }];
  element("file-template").fire("change");
  await settle();
  element("file-data").files = [{ name: "d.json" }];
  element("file-data").fire("change");
  await settle();
  element("generate").fire("click");
  await settle();
  const rows = (table: string): string[][] => childrenOf(childrenOf(element(table))[1]).map((tr) => childrenOf(tr).map(textOf));
  // 자리 목록은 제목(h3)과 목록(ul)이 번갈아 나온다: 첫 목록이 누름틀이다
  const fieldList = childrenOf(element("places").children.find((c) => typeof c !== "string" && c.children.length > 0 && typeof c.children[0] !== "string" && c.children[0]?.text() !== "")).map(textOf);
  return { places: fieldList, matches: rows("matches"), results: rows("results") };
}

/** 합성 문서: 곳의 모양을 이름마다 달리 둔다 */
const cellField = (id: string, name: string): string => P(R(TBL([[P(R(FIELD_BEGIN(id, name, "1", "x") + T("칸 안")))]], "0"))) + P(R(T("밖") + FIELD_END(id)));
const objectField = (id: string, name: string): string => P(R(FIELD_BEGIN(id, name, "1", "x") + T("앞") + PIC("1") + T("뒤") + FIELD_END(id)));
const openField = (id: string, name: string): string => P(R(FIELD_BEGIN(id, name, "1", "x") + T("끝 없음")));
const crossField = (id: string, name: string): string => P(R(FIELD_BEGIN(id, name, "1", "x") + T("앞"))) + P(R(T("뒤") + FIELD_END(id)));
const simpleField = (id: string, name: string): string => P(R(T("a ") + FIELD_BEGIN(id, name, "1", "x") + T("값") + FIELD_END(id)));

test("화면: 여러 문단에 걸친 누름틀(field-span) — 자리 목록과 대조표가 합침을 알리고, 결과의 알림에 쉬운 말과 엔진 메시지가 나온다", async () => {
  const screen = await run(readFixture("span/field-span"), { 성명: "홍길동" });
  assert.deepEqual(screen.places, ["성명 (1곳) — 그중 1곳은 여러 문단에 걸쳐 있어 채우면 그 사이 문단이 합쳐짐"]);
  assert.deepEqual(screen.matches, [["누름틀", "성명", "데이터 있음 — 여러 문단에 걸쳐 있어 채우면 사이 문단이 합쳐짐"]]);
  const row = screen.results[0] ?? [];
  assert.deepEqual([row[2], row[3], row[4], row[5]], ["성공", "1곳", "-", "-"]);
  assert.match(row[6] ?? "", /^\[누름틀 "성명"\] 이 누름틀은 여러 문단에 걸쳐 있어서 .* 확인해 주세요\. FIELD_PARAGRAPHS_MERGED누름틀 성명이 걸친 문단 3개를 합쳤고/);
  assert.ok((row[6] ?? "").includes(plainOf("FIELD_PARAGRAPHS_MERGED")));

  // 데이터에 없으면 합침 안내 대신 없음이다
  assert.deepEqual((await run(readFixture("span/field-span"), { 다른: "것" })).matches, [["누름틀", "성명", "데이터에 없음"]]);
});

test("화면: 줄바꿈·탭이 든 누름틀(inline-breaks)은 채우는 자리로 보이고 줄바꿈 알림이 붙는다 — 합침 안내는 없다", async () => {
  const screen = await run(readFixture("inline/inline-breaks"), { 줄: "가\n나", 탭: "다" });
  assert.deepEqual(screen.places, ["줄 (1곳)", "탭 (1곳)"]);
  assert.deepEqual(screen.matches, [
    ["누름틀", "줄", "데이터 있음 — 값에 줄바꿈·탭이 있음(그대로 들어감)"],
    ["누름틀", "탭", "데이터 있음"],
  ]);
  assert.match(screen.results[0]?.[6] ?? "", /^\[키 줄\] 값에 줄바꿈·탭이 있어 .*QUICK_MULTILINE$/);
});

test("화면: 채울 수 없는 모양(안에 그림·표, 표 칸 경계를 넘음, 끝 표식 없음)은 자리 목록에 모양별 곳 수로, 대조표에 모양 이름과 할 일로 보인다. 일부만 그렇다면 데이터로 판정하고 합침도 안내한다", async () => {
  const doc = synth([
    objectField("81", "그림"),
    cellField("82", "칸밖"),
    openField("83", "끝없음"),
    objectField("84", "복합"),
    openField("85", "복합"),
    simpleField("86", "혼합"),
    objectField("87", "혼합"),
    crossField("88", "혼합"),
    simpleField("89", "성명"),
  ]);
  const screen = await run(doc, { 그림: "a", 칸밖: "b", 끝없음: "c", 복합: "d", 혼합: "e", 성명: "f" });
  assert.deepEqual(screen.places, [
    "그림 (1곳) — 그중 1곳은 채울 수 없음(안에 그림·표가 있음 1)",
    "칸밖 (1곳) — 그중 1곳은 채울 수 없음(표 칸 경계를 넘음 1)",
    "끝없음 (1곳) — 그중 1곳은 채울 수 없음(끝 표식 없음 1)",
    "복합 (2곳) — 그중 2곳은 채울 수 없음(안에 그림·표가 있음 1, 끝 표식 없음 1)",
    "혼합 (3곳) — 그중 1곳은 채울 수 없음(안에 그림·표가 있음 1) — 그중 1곳은 여러 문단에 걸쳐 있어 채우면 그 사이 문단이 합쳐짐",
    "성명 (1곳)",
  ]);
  const todo = "한컴에서 한 문단 안의 글만 담는 누름틀로 다시 만들어 주세요";
  assert.deepEqual(screen.matches, [
    ["누름틀", "그림", `채울 수 없어 채우지 않음(안에 그림·표가 있음) — ${todo}`],
    ["누름틀", "칸밖", `채울 수 없어 채우지 않음(표 칸 경계를 넘음) — ${todo}`],
    ["누름틀", "끝없음", `채울 수 없어 채우지 않음(끝 표식 없음) — ${todo}`],
    ["누름틀", "복합", `채울 수 없어 채우지 않음(안에 그림·표가 있음/끝 표식 없음) — ${todo}`],
    ["누름틀", "혼합", "데이터 있음 — 여러 문단에 걸쳐 있어 채우면 사이 문단이 합쳐짐"],
    ["누름틀", "성명", "데이터 있음"],
  ]);
  // 결과: 건너뛴 곳은 건너뜀 칸에, 합침은 알림 칸에 나온다
  const row = screen.results[0] ?? [];
  assert.equal(row[2], "성공");
  assert.match(row[4] ?? "", /\[누름틀 "그림"\].*FIELD_UNSUPPORTED_SHAPE/);
  assert.match(row[4] ?? "", /\[누름틀 "칸밖"\].*FIELD_UNSUPPORTED_SHAPE/);
  assert.match(row[6] ?? "", /\[누름틀 "혼합"\] .*FIELD_PARAGRAPHS_MERGED/);
});

test("화면: 모양은 여러 문단이지만 엔진이 건너뛰는 곳(crossBlocked)은 합친다고 알리지 않고 채울 수 없다고 엔진의 사유와 함께 보인다. 채울 수 있는 여러 문단 곳만 합침으로 안내한다", async () => {
  const doc = synth([secBetween("161", "구역"), crossed("162", "바깥", "163", "안쪽"), openCross("164", "열림"), simpleField("165", "성명")]);
  const [secMsg, crossA, crossB] = blockMessages(doc);
  assert.ok(secMsg !== undefined && crossA !== undefined && crossB !== undefined);
  const screen = await run(doc, { 구역: "a", 바깥: "b", 안쪽: "c", 열림: "d", 성명: "e" });
  const label = "여러 문단에 걸쳐 있는데 사이 문단의 구역 설정, 엇갈린 누름틀, 경계에 걸친 강조 표식 때문에 채울 수 없음";
  assert.deepEqual(screen.places, [
    `구역 (1곳) — 그중 1곳은 채울 수 없음(${label} 1 (${secMsg}))`,
    `바깥 (1곳) — 그중 1곳은 채울 수 없음(${label} 1 (${crossA}))`,
    `안쪽 (1곳) — 그중 1곳은 채울 수 없음(${label} 1 (${crossB}))`,
    "열림 (1곳) — 그중 1곳은 여러 문단에 걸쳐 있어 채우면 그 사이 문단이 합쳐짐",
    "성명 (1곳)",
  ]);
  const todo = "한컴에서 한 문단 안의 글만 담는 누름틀로 다시 만들어 주세요";
  assert.deepEqual(screen.matches, [
    ["누름틀", "구역", `채울 수 없어 채우지 않음(${label} (${secMsg})) — ${todo}`],
    ["누름틀", "바깥", `채울 수 없어 채우지 않음(${label} (${crossA})) — ${todo}`],
    ["누름틀", "안쪽", `채울 수 없어 채우지 않음(${label} (${crossB})) — ${todo}`],
    ["누름틀", "열림", "데이터 있음 — 여러 문단에 걸쳐 있어 채우면 사이 문단이 합쳐짐"],
    ["누름틀", "성명", "데이터 있음"],
  ]);
  // 결과: 막힌 세 곳은 건너뜀(엔진의 사유가 함께), 채운 두 곳은 성공이고 합침은 알림에 나온다
  const row = screen.results[0] ?? [];
  assert.deepEqual([row[2], row[3], row[5]], ["성공", "2곳", "-"]);
  for (const name of ["구역", "바깥", "안쪽"]) assert.match(row[4] ?? "", new RegExp(`\[누름틀 "${name}"\].*FIELD_UNSUPPORTED_SHAPE`));
  assert.ok((row[4] ?? "").includes(secMsg) && (row[4] ?? "").includes(crossA));
  assert.match(row[6] ?? "", /^\[누름틀 "열림"\] .*FIELD_PARAGRAPHS_MERGED/);

  // 곳이 전부 막힌 문서: 미리 알린 그대로 건너뛰고, 채운 자리가 없어 실패한다
  const only = await run(synth([secBetween("166", "구역")]), { 구역: "a" });
  assert.deepEqual(only.matches, [["누름틀", "구역", `채울 수 없어 채우지 않음(${label} (${secMsg})) — ${todo}`]]);
  const failed = only.results[0] ?? [];
  assert.deepEqual([failed[2], failed[3]], ["실패", "0곳"]);
  assert.match(failed[4] ?? "", /\[누름틀 "구역"\].*FIELD_UNSUPPORTED_SHAPE/);
  assert.match(failed[5] ?? "", /FILL_NOTHING_APPLIED/);
});
