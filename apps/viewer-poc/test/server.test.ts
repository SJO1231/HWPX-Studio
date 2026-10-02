// 시험 구현 서버: 프로세스 안에서 띄워 실제 HTTP로 확인한다(정적 파일·API·경로 탈출 차단·위치 변환·채우기).
// V5의 브라우저 없는 부분: 위치 변환 → 앵커 초안 → 채우기 → 결과 바이트를 rhwp로 다시 그린 글자 배치에서 값이 보이는지.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createViewerApp, HOST, PORT, type ViewerApp } from "../src/app.ts";
import { defaultDraftIndex } from "../web/choice.ts";
import type { AnchorDraftJson, FillResponse, LocateResponse, MarksResponse, OpenResponse } from "../src/api-types.ts";
import { FIELD_BEGIN, FIELD_END, P, R, T, ensureRhwp, fixtureNames, readFixture, synth } from "../../../packages/viewer/test/helpers.ts";
import { hasDocCoords, openDocument, runLength, runPosition, type LayoutRun, type ViewerDocument } from "../../../packages/viewer/src/rhwp/index.ts";

let app: ViewerApp;
let base = "";
let port = 0;

before(async () => {
  await ensureRhwp();
  app = createViewerApp();
  await new Promise<void>((resolve) => app.server.listen(0, HOST, resolve));
  port = (app.server.address() as AddressInfo).port;
  base = `http://${HOST}:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
});

// ── 도우미 ────────────────────────────────────────────────────────

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const post = (path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function openFixture(name: string): Promise<OpenResponse> {
  const res = await post("/api/open", { fixture: name });
  assert.equal(res.status, 200, `${name}: ${await res.clone().text()}`);
  return json<OpenResponse>(res);
}

async function bytesOf(session: OpenResponse): Promise<{ bytes: Uint8Array; generation: number }> {
  const res = await fetch(`${base}/api/session/${session.session}/bytes`);
  assert.equal(res.status, 200);
  return { bytes: new Uint8Array(await res.arrayBuffer()), generation: Number(res.headers.get("x-generation")) };
}

/** 세션의 현재 바이트를 rhwp로 연다(브라우저가 하는 일). */
async function viewOf(session: OpenResponse): Promise<ViewerDocument> {
  return openDocument((await bytesOf(session)).bytes);
}

/** 문단의 런 글을 이은 것(한 문단의 화면 글). 표 셀이면 `cell`을 준다. */
function paragraphText(doc: ViewerDocument, para: { paragraphIndex: number; parentParaIndex?: number }, cellIndex?: number): string {
  const out: string[] = [];
  for (let page = 0; page < doc.pageCount(); page++) {
    for (const run of doc.pageLayout(page).runs) {
      if (!hasDocCoords(run) || run.paraIdx !== para.paragraphIndex) continue;
      if (para.parentParaIndex === undefined ? run.cellPath !== undefined : run.parentParaIdx !== para.parentParaIndex || run.cellPath?.[0]?.cellIndex !== cellIndex) continue;
      out.push(run.text);
    }
  }
  return out.join("");
}

function runWith(doc: ViewerDocument, text: string): LayoutRun {
  for (let page = 0; page < doc.pageCount(); page++) {
    const run = doc.pageLayout(page).runs.find((r) => hasDocCoords(r) && r.text.includes(text));
    if (run !== undefined) return run;
  }
  throw new Error(`런 ${text}을(를) 찾지 못했다`);
}

/** 런 안 `text` 첫 글자 위치와 확인할 런(브라우저가 클릭에서 만드는 요청). */
function clickOn(run: LayoutRun, text: string): { position: NonNullable<ReturnType<typeof runPosition>>; shown: { text: string; start: number } } {
  const start = runPosition(run);
  assert.ok(start !== undefined);
  const i = Array.from(run.text).indexOf(Array.from(text)[0] ?? "");
  assert.ok(i >= 0 && i < runLength(run));
  return { position: { ...start, charOffset: start.charOffset + i }, shown: { text: run.text, start: start.charOffset } };
}

const locate = async (session: OpenResponse, body: unknown): Promise<LocateResponse> => json<LocateResponse>(await post(`/api/session/${session.session}/locate`, body));
const marksOf = async (session: OpenResponse): Promise<MarksResponse> => json<MarksResponse>(await fetch(`${base}/api/session/${session.session}/marks`));
const fill = async (session: OpenResponse, anchor: AnchorDraftJson, value: string): Promise<FillResponse> =>
  json<FillResponse>(await post(`/api/session/${session.session}/fill`, { fills: [{ anchor, value }] }));

function rawRequest(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

// ── 바인드·정적 파일 ─────────────────────────────────────────────

test("서버는 127.0.0.1에만 바인드하고 포트는 4173이다", () => {
  assert.equal(HOST, "127.0.0.1");
  assert.equal(PORT, 4173);
  assert.equal((app.server.address() as AddressInfo).address, "127.0.0.1");
  const entry = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");
  assert.match(entry, /server\.listen\(PORT, HOST,/);
});

test("정적 파일: 화면 HTML, 타입 제거된 .ts, rhwp js·wasm", async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(await index.text(), /<script type="module" src="\/app\/main\.ts">/);

  const main = await fetch(`${base}/app/main.ts`);
  assert.equal(main.status, 200);
  assert.match(main.headers.get("content-type") ?? "", /^text\/javascript/);
  const mainText = await main.text();
  assert.ok(mainText.includes("createPageView") && !/\bimport type\b/.test(mainText) && !/: HTMLElement\b/.test(mainText), "타입이 제거돼야 한다");

  const load = await (await fetch(`${base}/packages/viewer/src/rhwp/load.ts`)).text();
  assert.ok(load.includes('from "/vendor/rhwp/rhwp.js"') && !load.includes('"@rhwp/core"'), "맨몸 지정자는 서버가 제공하는 주소로 바뀐다");

  const wasm = await fetch(`${base}/vendor/rhwp/rhwp_bg.wasm`);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  assert.ok((await wasm.arrayBuffer()).byteLength > 1_000_000);
  assert.equal((await fetch(`${base}/vendor/rhwp/rhwp.js`)).status, 200);
});

test("브라우저 모듈 그래프: /app/main.ts에서 시작해 import를 따라가면 전부 200이고, 모두 문법이 맞고, 엔진·node 내장 모듈을 가져오지 않는다", async () => {
  const seen = new Map<string, string>();
  const queue = [`${base}/app/main.ts`];
  while (queue.length > 0) {
    const url = queue.pop() as string;
    if (seen.has(url)) continue;
    const res = await fetch(url);
    assert.equal(res.status, 200, `${url}: ${res.status}`);
    const code = await res.text();
    seen.set(url, code);
    // 정적 `import ... from "x"`·`export ... from "x"`·`import "x"`의 지정자
    for (const m of code.matchAll(/\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)) {
      const spec = m[1] ?? m[2] ?? "";
      assert.ok(spec.startsWith(".") || spec.startsWith("/"), `${url}: 맨몸 지정자 ${spec}`);
      assert.ok(!spec.startsWith("node:"), `${url}: node 내장 모듈 ${spec}`);
      assert.ok(!/hwpx-engine/.test(spec), `${url}: 브라우저 코드가 엔진을 가져온다 ${spec}`);
      queue.push(new URL(spec, url).href);
    }
  }
  assert.ok(seen.size >= 10, `모듈 수 ${seen.size}`);
  for (const [url, code] of seen) {
    if (!url.endsWith(".js") && !url.endsWith(".ts")) continue;
    // 문법 검사(디스크에 쓰지 않고 표준 입력으로)
    const r = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: code, encoding: "utf8" });
    assert.equal(r.status, 0, `${url}: ${r.stderr.slice(0, 300)}`);
  }
  const names = [...seen.keys()].map((u) => new URL(u).pathname);
  assert.ok(names.includes("/vendor/rhwp/rhwp.js") && names.includes("/packages/viewer/src/rhwp/load.ts") && names.includes("/packages/viewer/src/dom/page-view.ts"));
});

test("정적 파일 경로 탈출·허용 목록 밖은 404", async () => {
  for (const path of [
    "/app/../../../package.json",
    "/app/%2e%2e/%2e%2e/package.json",
    "/app/..%5c..%5cpackage.json",
    "/packages/viewer/src/map/locate.ts", // 엔진을 가져오는 호스트 쪽 코드는 브라우저로 주지 않는다
    "/packages/viewer/src/rhwp/../map/locate.ts",
    "/packages/viewer/src/dom/../../package.json",
    "/packages/hwpx-engine/src/index.ts",
    "/vendor/rhwp/package.json",
    "/vendor/rhwp/../../package.json",
    "/node_modules/@rhwp/core/package.json",
  ]) {
    const status = (await fetch(`${base}${path}`)).status;
    assert.equal(status, 404, `${path}: ${status}`);
  }
  // 브라우저가 쓰는 부분은 준다
  assert.equal((await fetch(`${base}/packages/viewer/src/map/types.ts`)).status, 200);
  assert.equal((await fetch(`${base}/packages/viewer/src/dom/page-view.ts`)).status, 200);
});

test("루프백 밖의 Host·다른 출처는 거절한다", async () => {
  assert.equal(await rawRequest("/api/fixtures", { Host: "evil.example" }), 403);
  assert.equal(await rawRequest("/api/fixtures", { Host: `evil.example:${port}` }), 403);
  assert.equal(await rawRequest("/api/fixtures", { Host: `${HOST}:${port}`, Origin: "http://evil.example" }), 403);
  assert.equal(await rawRequest("/api/fixtures", { Host: `${HOST}:${port}`, Origin: base }), 200);
  assert.equal(await rawRequest("/api/fixtures", { Host: `localhost:${port}` }), 200);
});

// ── 문서 열기 ─────────────────────────────────────────────────────

test("문서 열기: 저장소 시험 문서 목록과 이름으로 열기, 바이트가 파일과 같다", async () => {
  const list = await json<{ names: string[] }>(await fetch(`${base}/api/fixtures`));
  assert.deepEqual(list.names, fixtureNames());
  const session = await openFixture("hancom/ph-single");
  assert.deepEqual([session.label, session.sections, session.generation], ["hancom/ph-single", 1, 0]);
  const { bytes, generation } = await bytesOf(session);
  assert.deepEqual(bytes, readFixture("hancom/ph-single"));
  assert.equal(generation, 0);
});

test("문서 열기: 올린 바이트(octet-stream)를 메모리 세션으로 열고, 열 수 없는 바이트는 엔진 코드로 거절한다", async () => {
  const good = readFixture("D2");
  const res = await fetch(`${base}/api/open`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(good) });
  assert.equal(res.status, 200);
  const session = await json<OpenResponse>(res);
  assert.equal(session.label, "올린 파일");
  assert.deepEqual((await bytesOf(session)).bytes, good);

  const bad = await fetch(`${base}/api/open`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array([1, 2, 3, 4]) });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: { code: string } }>(bad)).error.code, /^(PKG|XML|MODEL)_/);
  const empty = await fetch(`${base}/api/open`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(0) });
  assert.equal(empty.status, 400);
});

test("문서 열기: 시험 문서 이름은 fixtures 폴더 안으로만 해석한다(경로 탈출 차단)", async () => {
  const escapes = [
    "../../package",
    "..%2f..%2fpackage",
    "../../../package",
    "hancom/../../../package",
    "hancom/../../hwpx-engine/package",
    "/etc/passwd",
    "C:/Windows/win",
    "C:\\Windows\\win",
    "..\\..\\package",
    "hancom\\ph-single",
    "D1.hwpx",
    "D1\u0000",
    "",
    ".",
    "..",
    "hancom/",
    "hancom",
    "hancom//ph-single",
    "./D1",
    "~/D1",
    "D1 ",
    "%2e%2e/D1",
  ];
  for (const name of escapes) {
    const res = await post("/api/open", { fixture: name });
    assert.ok(res.status === 404 || res.status === 400, `${JSON.stringify(name)} → ${res.status}`);
    assert.ok((await json<{ error?: unknown }>(res)).error !== undefined);
  }
  // 이 저장소의 .hwpx가 아닌 파일(같은 폴더의 해시 목록·출처 문서)도 이름으로 열 수 없다
  assert.equal((await post("/api/open", { fixture: "SHA256SUMS" })).status, 404);
  assert.equal((await post("/api/open", { fixture: "PROVENANCE" })).status, 404);
  assert.equal((await post("/api/open", { fixture: 7 })).status, 400);
  assert.equal((await fetch(`${base}/api/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
});

test("세션: 없는 세션·잘못된 경로·열린 세션 수 상한(오래된 것부터 닫힘)", async () => {
  assert.equal((await fetch(`${base}/api/session/00000000-0000-0000-0000-000000000000/bytes`)).status, 404);
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  const first = await openFixture("hancom/ph-single");
  for (let i = 0; i < 16; i++) await openFixture("hancom/ph-single");
  assert.equal((await fetch(`${base}/api/session/${first.session}/bytes`)).status, 404, "상한(16)을 넘으면 가장 오래된 세션이 닫힌다");
  const last = await openFixture("D1");
  assert.equal((await fetch(`${base}/api/session/${last.session}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/session/${last.session}/bytes`)).status, 404);
});

// ── 위치 변환과 앵커 초안 ─────────────────────────────────────────

test("위치 변환: 낱말을 누르면 엔진 주소와 word 초안(지문 포함)이 나온다", async () => {
  const session = await openFixture("hancom/ph-single");
  const doc = await viewOf(session);
  try {
    const run = runWith(doc, "입니다.");
    const { position, shown } = clickOn(run, "입니다.");
    const r = await locate(session, { from: { position, shown } });
    assert.equal(r.precision, "char");
    assert.deepEqual(r.address, { sectionIndex: 0, path: [1], offset: 22 });
    assert.deepEqual(r.trail, []);
    const word = r.drafts.find((d) => d.anchor.kind === "word");
    assert.ok(word?.anchor.kind === "word");
    assert.deepEqual([word.anchor.start, word.anchor.end, word.anchor.print.text], [22, 26, "입니다."]);
    assert.deepEqual(r.drafts.map((d) => d.anchor.kind), ["word", "line"]);
    assert.equal(defaultDraftIndex(r.drafts), 0);
    assert.ok(word.mark !== undefined && word.mark.endOffset > word.mark.position.charOffset, "강조할 자리가 함께 온다");
  } finally {
    doc.free();
  }
});

test("위치 변환: 확인할 런(shown)이 없거나 글이 다르면 문단 단위로 내려간다", async () => {
  const session = await openFixture("hancom/ph-single");
  const doc = await viewOf(session);
  try {
    const run = runWith(doc, "입니다.");
    const { position, shown } = clickOn(run, "입니다.");
    const noShown = await locate(session, { from: { position } });
    assert.deepEqual([noShown.precision, noShown.reason], ["paragraph", "NO_SHOWN_RUN"]);
    assert.deepEqual(noShown.address, { sectionIndex: 0, path: [1] });
    assert.deepEqual(noShown.drafts.map((d) => d.anchor.kind), ["line"]);
    const wrong = await locate(session, { from: { position, shown: { text: "사업명:", start: shown.start } } });
    assert.deepEqual([wrong.precision, wrong.reason], ["paragraph", "TEXT_MISMATCH"]);
    const foreign = await locate(session, { from: { position, shown: { text: "전혀 다른 글", start: shown.start } } });
    assert.deepEqual([foreign.precision, foreign.reason, foreign.address, foreign.drafts], ["none", "PARAGRAPH_MISMATCH", undefined, []]);
  } finally {
    doc.free();
  }
});

test("위치 변환: 끌기 범위(같은 문단)는 범위 word 초안, 여러 문단은 받지 않는다", async () => {
  const session = await openFixture("hancom/ph-single");
  const doc = await viewOf(session);
  try {
    const run = runWith(doc, "사업명");
    const from = clickOn(run, "사");
    const to = { position: { ...from.position, charOffset: from.position.charOffset + 4 }, shown: from.shown };
    const r = await locate(session, { from, to });
    assert.equal(r.precision, "char");
    assert.deepEqual(r.range, { start: 0, end: 4 });
    const word = r.drafts[0]?.anchor;
    assert.ok(word?.kind === "word" && word.print.text === "사업명:");
    // 두 위치를 뒤집어 보내도 같다
    const swapped = await locate(session, { from: to, to: from });
    assert.deepEqual(swapped.range, r.range);
    // 다른 문단
    const other = runWith(doc, "기간");
    const far = clickOn(other, "기");
    const multi = await locate(session, { from, to: far });
    assert.deepEqual([multi.precision, multi.reason], ["none", "RANGE_PARAGRAPHS_DIFFER"]);
  } finally {
    doc.free();
  }
});

test("위치 변환: 잘못된 입력은 400이다", async () => {
  const session = await openFixture("hancom/ph-single");
  for (const body of [{}, { from: {} }, { from: { position: { sectionIndex: -1, paragraphIndex: 0, charOffset: 0 } } }, { from: { position: { sectionIndex: 0, paragraphIndex: 0, charOffset: 1.5 } } }, { from: { position: { sectionIndex: 0, paragraphIndex: 0, charOffset: 0, cellPath: [] } } }, { from: { position: { sectionIndex: 0, paragraphIndex: 0, charOffset: 0, parentParaIndex: 1, cellPath: [{ controlIndex: "a" }] } } }, { from: { position: { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }, shown: { text: 1 } } }]) {
    const res = await post(`/api/session/${session.session}/locate`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  // 엔진 문단이 없는 위치는 오류가 아니라 `none`
  const missing = await locate(session, { from: { position: { sectionIndex: 3, paragraphIndex: 0, charOffset: 0 } } });
  assert.deepEqual([missing.precision, missing.reason], ["none", "SECTION_NOT_FOUND"]);
});

// ── 강조할 자리 ──────────────────────────────────────────────────

test("강조할 자리: 누름틀(안내문 상태 포함)·{{}}가 엔진의 후보 목록으로 나오고, 쪽 위 구간이 붙는다", async () => {
  const fields = await marksOf(await openFixture("hancom/field-states"));
  const f = fields.marks.filter((m) => m.kind === "field");
  assert.equal(f.length, 3);
  assert.deepEqual(f.map((m) => (m.mark?.guide === undefined ? "값" : "안내문")), ["안내문", "값", "안내문"]);
  assert.ok(f.every((m) => m.mark !== undefined));
  assert.deepEqual(f.map((m) => m.anchor), [
    { kind: "field", name: "성명", occurrence: 0 },
    { kind: "field", name: "소속", occurrence: 0 },
    { kind: "field", name: "성명", occurrence: 1 },
  ]);

  const ph = await marksOf(await openFixture("hancom/ph-single"));
  const holders = ph.marks.filter((m) => m.kind === "placeholder");
  assert.equal(holders.length, 3);
  const first = holders[0];
  assert.ok(first?.anchor.kind === "word" && first.anchor.print.text === "{{project.name}}");
  assert.deepEqual([first.mark?.position.paragraphIndex, first.mark?.position.charOffset, first.mark?.endOffset], [1, 5, 21]);
  assert.equal(first.mark?.text, "{{project.name}}", "화면이 쪽 글자 배치와 맞는지 확인하는 데 쓰는 덮을 글");
});

// ── 채우기(V5의 브라우저 없는 부분) ───────────────────────────────

test("V5: 일반 낱말 — 누른 낱말의 앵커로 채우면 다시 그린 글자 배치에 값이 보이고, 세대가 오른다", async () => {
  const session = await openFixture("hancom/ph-single");
  let doc = await viewOf(session);
  const run = runWith(doc, "입니다.");
  const click = clickOn(run, "입니다.");
  doc.free();
  const located = await locate(session, { from: click });
  const draft = located.drafts[0];
  assert.ok(draft?.anchor.kind === "word");
  const r = await fill(session, draft.anchor, "입니다만");
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.ok && r.generation, 1);
  assert.deepEqual(r.summary.actions, [{ type: "fill", anchor: "a0", targets: 1 }]);
  doc = await viewOf(session);
  try {
    assert.equal(paragraphText(doc, { paragraphIndex: 1 }), "사업명: {{project.name}} 입니다만", "다시 그린 화면에 값이 보인다(문서의 다른 {{}}는 그대로)");
    assert.equal(paragraphText(doc, { paragraphIndex: 2 }), "기간: {{project.start}} ~ {{project.end}}");
  } finally {
    doc.free();
  }
  assert.equal((await bytesOf(session)).generation, 1);
  // 다시 눌러도(새 바이트에서) 같은 문단·낱말이 잡힌다
  const again = await viewOf(session);
  try {
    const run2 = runWith(again, "입니다만");
    const r2 = await locate(session, { from: clickOn(run2, "입니다만") });
    const w2 = r2.drafts[0]?.anchor;
    assert.ok(w2?.kind === "word" && w2.print.text === "입니다만");
  } finally {
    again.free();
  }
});

test("V5: {{}} 자리 — 강조된 자리의 앵커로 채운다", async () => {
  const session = await openFixture("hancom/ph-single");
  const holder = (await marksOf(session)).marks.find((m) => m.kind === "placeholder");
  assert.ok(holder !== undefined);
  const r = await fill(session, holder.anchor, "알파");
  assert.ok(r.ok, JSON.stringify(r));
  const doc = await viewOf(session);
  try {
    assert.equal(paragraphText(doc, { paragraphIndex: 1 }), "사업명: 알파 입니다.");
  } finally {
    doc.free();
  }
});

test("V5: 누름틀 — 안내문을 누르면 field 초안이 첫째로 나오고, 값을 채우면 화면에 값이 보인다. 값이 든 누름틀도 같다", async () => {
  const session = await openFixture("hancom/field-states");
  let doc = await viewOf(session);
  // 안내문(문서 좌표 없이 그려진 런)을 누른다: 브라우저는 안내문이 놓인 자리의 빈 런으로 확인하고, 눌린 글(guide)을 함께 보낸다
  const guide = doc.pageLayout(0).runs.find((r) => !hasDocCoords(r) && r.text === "이름을 입력");
  assert.ok(guide !== undefined);
  const picked = doc.pick(0, guide.x + guide.w / 2, guide.y + guide.h / 2);
  assert.ok(picked.hit.position !== undefined && picked.guide && picked.guideText === "이름을 입력");
  const empty = doc.pageLayout(0).runs.find((r) => hasDocCoords(r) && r.text === "" && r.paraIdx === picked.hit.position?.paragraphIndex && r.charStart === picked.hit.position?.charOffset);
  assert.ok(empty !== undefined);
  doc.free();
  const located = await locate(session, { from: { position: picked.hit.position, shown: picked.shown, guide: picked.guideText } });
  assert.equal(located.precision, "char");
  assert.equal(located.edge, "guide");
  assert.deepEqual(located.drafts[0]?.anchor, { kind: "field", name: "성명", occurrence: 0 });
  const filled = await fill(session, located.drafts[0]?.anchor as AnchorDraftJson, "김철수");
  assert.ok(filled.ok, JSON.stringify(filled));
  doc = await viewOf(session);
  try {
    assert.equal(paragraphText(doc, { paragraphIndex: 0 }), "성명: 김철수", "다시 그린 화면에 값이 보인다");
    // 값이 든 누름틀(소속): 값 글자를 누르면 field 초안
    const value = runWith(doc, "합성기관");
    const r = await locate(session, { from: clickOn(value, "합") });
    assert.deepEqual(r.drafts[0]?.anchor, { kind: "field", name: "소속", occurrence: 0 });
  } finally {
    doc.free();
  }
});

test("V5: 표 셀 — 셀 안 글을 누르면 cell 초안이 있고, 셀을 채우면 화면의 그 셀에 값이 보인다", async () => {
  const session = await openFixture("hancom/ph-table");
  let doc = await viewOf(session);
  const label = runWith(doc, "성명");
  assert.ok(label.cellPath !== undefined);
  const click = clickOn(label, "성");
  doc.free();
  const r = await locate(session, { from: click });
  assert.equal(r.precision, "char");
  assert.deepEqual(r.address, { sectionIndex: 0, path: [1, 0, 0], offset: 0 });
  assert.deepEqual(r.trail, ["tbl"]);
  assert.deepEqual(r.drafts.map((d) => d.anchor.kind), ["word", "line", "cell"]);
  const cell = r.drafts[2]?.anchor;
  assert.deepEqual(cell, { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 0, col: 0 });
  const ok = await fill(session, cell as AnchorDraftJson, "신청인");
  assert.ok(ok.ok, JSON.stringify(ok));
  doc = await viewOf(session);
  try {
    const cellRun = doc.pageLayout(0).runs.find((x) => x.cellPath?.[0]?.cellIndex === 0 && x.text === "신청인");
    assert.ok(cellRun !== undefined, "다시 그린 화면의 그 셀에 값이 보인다");
  } finally {
    doc.free();
  }
});

test("채우기: 저장 게이트가 막거나 건너뛴 자리는 ok:false와 보고서 오류를 주고 세션 바이트는 그대로다", async () => {
  const session = await openFixture("tables/tables-rich");
  const before = await bytesOf(session);
  // 그림이 든 셀(1행 2열)은 채울 수 없다
  const r = await fill(session, { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 2 }, "x");
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.severity === "error"), JSON.stringify(r.issues));
  const after = await bytesOf(session);
  assert.equal(after.generation, before.generation);
  assert.deepEqual(after.bytes, before.bytes);
  // 템플릿이 틀린 앵커는 400과 엔진 코드
  const bad = await post(`/api/session/${session.session}/fill`, { fills: [{ anchor: { kind: "cell", table: { sectionIndex: 0, ordinal: -1 }, row: 0, col: 0 }, value: "x" }] });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: { code: string } }>(bad)).error.code, /^TPL_/);
  // 값에 XML 금지 문자: 게이트가 아니라 값 검사에서 막힌다
  const ctl = await fill(session, { kind: "field", name: "이름", occurrence: 0 }, "a\u0001b");
  assert.equal(ctl.ok, false);
  assert.equal((await post(`/api/session/${session.session}/fill`, { fills: [] })).status, 400);
});

test("되돌리기와 내려받기: reset은 처음 바이트로, download는 지금 바이트를 첨부 파일로 준다", async () => {
  const session = await openFixture("hancom/ph-single");
  const original = (await bytesOf(session)).bytes;
  const doc = await viewOf(session);
  const click = clickOn(runWith(doc, "입니다."), "입니다.");
  doc.free();
  const word = (await locate(session, { from: click })).drafts[0]?.anchor as AnchorDraftJson;
  assert.ok((await fill(session, word, "끝")).ok);
  const dl = await fetch(`${base}/api/session/${session.session}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename="result\.hwpx"$/);
  const downloaded = new Uint8Array(await dl.arrayBuffer());
  assert.deepEqual(downloaded, (await bytesOf(session)).bytes);
  assert.notDeepEqual(downloaded, original);
  // 결과 파일은 엔진이 다시 열 수 있다
  const reopened = await fetch(`${base}/api/open`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(downloaded) });
  assert.equal(reopened.status, 200);

  const reset = await json<OpenResponse>(await post(`/api/session/${session.session}/reset`, {}));
  assert.equal(reset.generation, 2);
  assert.deepEqual((await bytesOf(session)).bytes, original);
});

// ── 구현 점검(정적) ───────────────────────────────────────────────

const sourcesOf = (dir: URL): { name: string; text: string }[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|html|css)$/.test(e.name))
    .map((e) => ({ name: e.name, text: readFileSync(new URL(e.name, dir), "utf8") }));

test("올린 바이트는 디스크에 쓰지 않는다: 서버 코드에 파일 쓰기·이동·삭제 호출이 없다", () => {
  const files = [...sourcesOf(new URL("../src/", import.meta.url)), { name: "server.ts", text: readFileSync(new URL("../server.ts", import.meta.url), "utf8") }];
  assert.ok(files.length >= 6);
  for (const f of files) {
    const code = f.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\b(writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rmSync|rmdirSync|copyFile|copyFileSync|truncate)\b/, `${f.name}: 파일을 쓰거나 지우는 호출이 있다`);
  }
});

test("V7(정적 점검): 화면 코드와 서버가 주는 정적 파일에 외부 주소가 없다", () => {
  const dirs = [new URL("../web/", import.meta.url), new URL("../../../packages/viewer/src/dom/", import.meta.url), new URL("../../../packages/viewer/src/rhwp/", import.meta.url)];
  for (const dir of dirs) {
    for (const f of sourcesOf(dir)) {
      const urls = [...f.text.matchAll(/https?:\/\/[^\s"'`)<>]+/g)].map((m) => m[0]);
      assert.deepEqual(urls, [], `${f.name}에 외부 주소가 있다`);
      assert.doesNotMatch(f.text, /@import|googleapis|cdn\.|unpkg|jsdelivr/i, `${f.name}: 외부 글꼴·CDN 참조`);
    }
  }
});

// ── 클릭 한계·안내문 글(D1·D2·D4) ─────────────────────────────────

test("위치 변환: 화면이 문단까지만 믿는 점(limit paragraph)은 글을 확인하고도 문단 단위로 내고, 그 사유를 그대로 돌려준다", async () => {
  const session = await openFixture("hancom/ph-single");
  const doc = await viewOf(session);
  try {
    const { position, shown } = clickOn(runWith(doc, "입니다."), "입니다.");
    const r = await locate(session, { from: { position, shown, limit: "paragraph", reason: "NEAREST_LINE" } });
    assert.deepEqual([r.precision, r.reason, r.address], ["paragraph", "NEAREST_LINE", { sectionIndex: 0, path: [1] }]);
    assert.deepEqual(r.drafts.map((d) => d.anchor.kind), ["line"]);
    assert.equal(defaultDraftIndex(r.drafts), 0, "문단 초안만 있으면 기본으로 고른다");
    // 확인할 런의 글이 문단에 없으면 문단 한계여도 none이다(엉뚱한 문단을 내지 않는다)
    const foreign = await locate(session, { from: { position, shown: { text: "전혀 다른 글", start: shown.start }, limit: "paragraph", reason: "NEAREST_LINE" } });
    assert.deepEqual([foreign.precision, foreign.reason], ["none", "PARAGRAPH_MISMATCH"]);
    for (const bad of [{ limit: "word" }, { limit: 1 }, { reason: "lower" }, { reason: 7 }, { guide: true }, { guide: "" }]) {
      const res = await post(`/api/session/${session.session}/locate`, { from: { position, shown, ...bad } });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  } finally {
    doc.free();
  }
});

/** 안내문 상태 누름틀(안내문 "소속 입력")이 글 없이 비어 있는 합성 문서를 올려 연다. */
async function openEmptyGuide(dirty: "0" | "1"): Promise<OpenResponse> {
  const bytes = synth([P(R(T("앞") + FIELD_BEGIN("12", "소속", dirty, "소속 입력") + FIELD_END("12") + T("뒤 글")))]);
  const res = await fetch(`${base}/api/open`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes) });
  assert.equal(res.status, 200);
  return json<OpenResponse>(res);
}

for (const dirty of ["0", "1"] as const) {
  test(`D4: 글이 없는 안내문 상태 누름틀(dirty=${dirty})의 안내문을 누르면 field 앵커가 나오고, 채우면 값이 보인다. 강조에는 안내문 글이 붙는다`, async () => {
    const session = await openEmptyGuide(dirty);
    let doc = await viewOf(session);
    const guide = doc.pageLayout(0).runs.find((r) => !hasDocCoords(r) && r.text === "소속 입력");
    assert.ok(guide !== undefined, "rhwp가 안내문을 좌표 없는 런으로 그려야 한다");
    // 안내문은 뒤따르는 글 위에 겹쳐 그려진다(rhwp는 안내문 폭만큼 글을 밀지 않는다): 겹친 앞부분은 어느 글자인지 정할 수 없으므로 겹치지 않는 마지막 글자를 누른다
    const lastX = guide.x + (guide.charX[guide.charX.length - 2] ?? 0) + 3;
    const overlapped = doc.pick(0, guide.x + guide.w / 2, guide.y + guide.h / 2);
    assert.deepEqual([overlapped.limit, overlapped.reason], ["none", "OVERLAPPING_RUNS"], "겹친 자리는 누른 글이 안내문인지 뒤 글인지 정할 수 없다");
    const picked = doc.pick(0, lastX, guide.y + guide.h / 2);
    doc.free();
    assert.ok(picked.hit.position !== undefined && picked.guide && picked.guideText === "소속 입력" && picked.limit === "char");
    const located = await locate(session, { from: { position: picked.hit.position, shown: picked.shown, guide: picked.guideText } });
    assert.equal(located.precision, "char");
    assert.equal(located.edge, "guide");
    assert.deepEqual(located.drafts[0]?.anchor, { kind: "field", name: "소속", occurrence: 0 });
    // 다른 글의 안내문이라고 하면 위치를 정할 수 없는 글이다
    const other = await locate(session, { from: { position: picked.hit.position, shown: picked.shown, guide: "다른 안내" } });
    assert.deepEqual([other.precision, other.reason, other.drafts], ["none", "UNPOSITIONED_TEXT", []]);
    // 강조: 안내문이 그려진 사각형을 덮는다
    const mark = (await marksOf(session)).marks.find((m) => m.anchor.kind === "field");
    assert.equal(mark?.mark?.guide, "소속 입력");
    const filled = await fill(session, located.drafts[0]?.anchor as AnchorDraftJson, "김철수");
    assert.ok(filled.ok, JSON.stringify(filled));
    doc = await viewOf(session);
    try {
      assert.equal(paragraphText(doc, { paragraphIndex: 1 }), "앞김철수뒤 글", "다시 그린 화면에 값이 보인다");
    } finally {
      doc.free();
    }
  });
}

test("D2: 쪽 번호처럼 좌표 없이 그려진 글은 화면이 먼저 거르고, 안내문 후보인 척 보내도 같은 자리에 같은 글의 안내문 상태 누름틀이 없으면 서버가 none(UNPOSITIONED_TEXT)으로 거절한다", async () => {
  const session = await openFixture("D2");
  const doc = await viewOf(session);
  try {
    const number = doc.pageLayout(2).runs.find((r) => !hasDocCoords(r) && r.text === "- 1 -");
    assert.ok(number !== undefined);
    const picked = doc.pick(2, number.x + number.w / 2, number.y + number.h / 2);
    assert.deepEqual([picked.limit, picked.reason, picked.hit.position], ["none", "UNPOSITIONED_TEXT", undefined], "앞에 빈 문서 런이 없으면 화면이 먼저 거른다");
    const r = await locate(session, { from: { position: { sectionIndex: 0, paragraphIndex: 33, charOffset: 0 }, shown: { text: "", start: 0 }, guide: "- 1 -" } });
    assert.deepEqual([r.precision, r.reason, r.address], ["none", "UNPOSITIONED_TEXT", undefined]);
  } finally {
    doc.free();
  }
});

// ── D3: 적용된 채움이 없으면 실패다 ───────────────────────────────

test("D3: 글자모양이 다른 run에 걸친 낱말 초안은 blocked로 알리고(초안은 그대로), 채우면 ok:false·FILL_NOTHING_APPLIED로 세션이 그대로다", async () => {
  const session = await openFixture("hancom/ph-mixed");
  const doc = await viewOf(session);
  const click = clickOn(runWith(doc, "{{"), "{");
  doc.free();
  const located = await locate(session, { from: click });
  assert.equal(located.precision, "char");
  assert.deepEqual(located.drafts.map((d) => [d.anchor.kind, d.blocked]), [["word", "FILL_MIXED_FORMAT"], ["line", undefined]]);
  assert.equal(defaultDraftIndex(located.drafts), undefined, "낱말이 막혀도 문단 초안이 기본이 되지 않는다");
  assert.ok(located.drafts.every((d) => !("blocked" in d.anchor)), "blocked는 앵커가 아니라 초안 항목에 붙는다(앵커는 그대로 채울 때 돌려보낸다)");
  const before = await bytesOf(session);
  const word = located.drafts[0]?.anchor as AnchorDraftJson;
  const r = await fill(session, word, "알파");
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.code === "FILL_NOTHING_APPLIED", JSON.stringify(r));
  assert.deepEqual(r.summary.actions, []);
  assert.deepEqual(r.summary.skipped.map((s) => s.code), ["FILL_MIXED_FORMAT"], "건너뜀 사유가 응답에 있다");
  const after = await bytesOf(session);
  assert.equal(after.generation, before.generation, "세대가 오르지 않는다");
  assert.deepEqual(after.bytes, before.bytes);
  // 막히지 않은 초안(문단)은 채워진다
  const line = located.drafts[1]?.anchor as AnchorDraftJson;
  const ok = await fill(session, line, "사업명: 알파");
  assert.ok(ok.ok, JSON.stringify(ok));
});

// ── D8: 시험 문서 이름은 목록과 글자 그대로 같을 때만 연다 ──────────

test("D8: 시험 문서 이름은 /api/fixtures의 이름과 대소문자까지 같을 때만 열린다", async () => {
  const list = await json<{ names: string[] }>(await fetch(`${base}/api/fixtures`));
  assert.ok(list.names.includes("D1") && list.names.includes("hancom/ph-single"));
  for (const name of ["d1", "Hancom/ph-single", "HANCOM/PH-SINGLE", "hancom/Ph-Single"]) {
    assert.equal((await post("/api/open", { fixture: name })).status, 404, name);
  }
  for (const name of list.names) assert.equal((await post("/api/open", { fixture: name })).status, 200, name);
});

test("D8: 앱의 package.json은 이 앱이 쓰는 작업공간 패키지와 rhwp를 의존성으로 선언한다", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
  assert.deepEqual(pkg.dependencies, { "@hwpx-studio/engine": "0.0.0", "@hwpx-studio/viewer": "0.0.0", "@rhwp/core": "0.8.6" });
  const viewer = JSON.parse(readFileSync(new URL("../../../packages/viewer/package.json", import.meta.url), "utf8")) as { name: string };
  const engine = JSON.parse(readFileSync(new URL("../../../packages/hwpx-engine/package.json", import.meta.url), "utf8")) as { name: string };
  assert.deepEqual([viewer.name, engine.name], ["@hwpx-studio/viewer", "@hwpx-studio/engine"]);
});

// ── D7: 너무 큰 본문은 413 뒤 연결을 닫는다 ───────────────────────

test("D7: 올린 본문이 한도(64 MiB)를 넘으면 413을 주고 연결을 닫는다 — 같은 연결을 다시 쓰다 ECONNRESET이 나지 않고, 새 연결의 다음 요청은 정상이다", async () => {
  const { Agent } = await import("node:http");
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const send = (method: string, path: string, body?: Buffer): Promise<{ status: number; connection: string | undefined; text: string }> =>
    new Promise((resolve, reject) => {
      const headers = body === undefined ? {} : { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) };
      const req = request({ host: HOST, port, path, method, agent, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, connection: res.headers["connection"], text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(body);
    });
  try {
    const big = await send("POST", "/api/open", Buffer.alloc(64 * 1024 * 1024 + 1024));
    assert.equal(big.status, 413);
    assert.match(big.text, /TOO_LARGE/);
    assert.equal(big.connection, "close", "413 응답은 연결을 닫겠다고 알린다");
    // 같은 에이전트(연결 재사용 시도)로 다음 요청: 새 연결로 정상 응답한다
    const next = await send("GET", "/api/fixtures");
    assert.equal(next.status, 200);
    assert.match(next.text, /ph-single/);
  } finally {
    agent.destroy();
  }
});

test("D7: 세션 저장소는 열린 수 한도에 더해 총 바이트 한도(기본 256 MiB)를 넘으면 가장 오래된 것부터 닫는다. 방금 연 세션은 남긴다", async () => {
  const { createSessionStore, MAX_SESSION_BYTES } = await import("../src/sessions.ts");
  assert.equal(MAX_SESSION_BYTES, 256 * 1024 * 1024);
  const doc = readFixture("hancom/ph-single");
  const one = doc.length;
  // 두 개까지 들어가는 한도
  const store = createSessionStore(16, one * 2 + 10);
  const a = store.open("a", new Uint8Array(doc));
  const b = store.open("b", new Uint8Array(doc));
  assert.equal(store.size(), 2);
  const c = store.open("c", new Uint8Array(doc));
  assert.equal(store.size(), 2, "세 번째를 열면 가장 오래된 a가 닫힌다");
  assert.deepEqual([store.get(a.id), store.get(b.id) === undefined, store.get(c.id) === undefined], [undefined, false, false]);
  // 한 세션이 한도보다 커도 방금 연 세션은 남는다
  const tiny = createSessionStore(16, 10);
  const only = tiny.open("only", new Uint8Array(doc));
  assert.equal(tiny.size(), 1);
  assert.ok(tiny.get(only.id) !== undefined);
  const next = tiny.open("next", new Uint8Array(doc));
  assert.deepEqual([tiny.size(), tiny.get(only.id), tiny.get(next.id) === undefined], [1, undefined, false]);
  // 채움으로 바이트가 늘어 한도를 넘어도 오래된 세션부터 닫는다(채운 세션은 남긴다)
  const grow = createSessionStore(16, one * 3 - 10);
  const g1 = grow.open("g1", new Uint8Array(doc));
  const g2 = grow.open("g2", new Uint8Array(doc));
  grow.replace(g2, new Uint8Array(doc));
  assert.deepEqual([grow.get(g1.id), grow.get(g2.id) === undefined], [undefined, false]);
});
