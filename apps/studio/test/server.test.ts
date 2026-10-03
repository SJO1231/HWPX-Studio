// 스튜디오(빠른 생성) 서버: 프로세스 안에서 띄워 실제 HTTP로 확인한다. 시험이 쓰는 폴더는 OS 임시 폴더의 시험 전용 폴더뿐이고 끝나면 지운다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { emptyTemplate, generate, readDataset } from "../../../packages/hwpx-engine/src/index.ts";
import { fileURLToPath } from "node:url";
import { HostError } from "../../../packages/viewer/src/host/index.ts";
import { HOST, PORT } from "../src/app.ts";
import { analyzePlaces } from "../src/quick.ts";
import { openFolder } from "../src/workspace.ts";
import { mixedDoc, readFixture, sandbox } from "./helpers.ts";
import { STAMP, download, enc, generateRun, listFiles, post, postJson, rawGet, rawGetBody, uploadData, uploadTemplate, withApp } from "./server-helpers.ts";

const here = (relative: string): URL => new URL(relative, import.meta.url);

// ── Q6: 바인드·Host·Origin·경로 탈출·본문 한도 ───────────────────

test("Q6: 서버는 127.0.0.1에만 바인드하고 포트는 4174이다(시험 앱 4173과 다르다)", async () => {
  assert.equal(HOST, "127.0.0.1");
  assert.equal(PORT, 4174);
  await withApp(async (c) => {
    assert.equal((c.app.server.address() as { address: string }).address, "127.0.0.1");
  });
  const entry = readFileSync(here("../server.ts"), "utf8");
  assert.match(entry, /app\.server\.listen\(PORT, HOST,/);
  assert.doesNotMatch(entry, /0\.0\.0\.0|listen\(PORT\)/);
});

test("Q6: 루프백 밖의 Host·다른 출처는 거절한다", async () => {
  await withApp(async (c) => {
    const api = "/api/quick/result/00000000-0000-0000-0000-000000000000/0";
    assert.equal(await rawGet(c, api, { Host: "evil.example" }), 403);
    assert.equal(await rawGet(c, api, { Host: `evil.example:${c.port}` }), 403);
    assert.equal(await rawGet(c, api, { Host: `${HOST}:${c.port}`, Origin: "http://evil.example" }), 403);
    assert.equal(await rawGet(c, api, { Host: `${HOST}:${c.port}`, Origin: "null" }), 403);
    // 같은 출처이면 통과(없는 세션이므로 404)
    assert.equal(await rawGet(c, api, { Host: `${HOST}:${c.port}`, Origin: c.base }), 404);
    assert.equal(await rawGet(c, api, { Host: `localhost:${c.port}` }), 404);
    assert.equal(await rawGet(c, "/", { Host: "evil.example" }), 403);
    // 다른 사이트가 POST로 두드려도 막는다
    const res = await fetch(`${c.base}/api/quick/template`, { method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "application/octet-stream" }, body: new Uint8Array([1]) });
    assert.equal(res.status, 403);
  });
});

test("Q6: 껍데기의 거절(Host·Origin·크기)도 { code, message, plain }이고 plain은 쉬운 말이다", async () => {
  await withApp(
    async (c) => {
      const api = "/api/quick/result/00000000-0000-0000-0000-000000000000/0";
      const errorOf = (r: { type: string; text: string }): { code: string; message: string; plain: string } => {
        assert.match(r.type, /^application\/json/);
        return (JSON.parse(r.text) as { error: { code: string; message: string; plain: string } }).error;
      };
      const host = await rawGetBody(c, api, { Host: "evil.example" });
      assert.equal(host.status, 403);
      assert.deepEqual(errorOf(host), { code: "HOST", message: "허용되지 않은 호스트입니다.", plain: `이 주소로는 열 수 없습니다. 브라우저에서 http://127.0.0.1:${c.port} 로 여세요.` });
      const origin = await rawGetBody(c, api, { Host: `${HOST}:${c.port}`, Origin: "http://evil.example" });
      assert.equal(origin.status, 403);
      assert.deepEqual(errorOf(origin), { code: "ORIGIN", message: "허용되지 않은 출처입니다.", plain: "다른 사이트에서 온 요청이라 받지 않았습니다." });
      const big = await post(c, "/api/quick/template", new Uint8Array(1500));
      assert.equal(big.status, 413);
      assert.deepEqual(errorOf({ type: big.headers.get("content-type") ?? "", text: await big.text() }), { code: "TOO_LARGE", message: "본문이 너무 큽니다.", plain: "올린 내용이 너무 큽니다(한도 1 KiB)." });
      // API 밖(정적 파일)의 Host 거절은 글이다
      const page = await rawGetBody(c, "/", { Host: "evil.example" });
      assert.deepEqual([page.status, /^text\/plain/.test(page.type), page.text], [403, true, "허용되지 않은 호스트입니다."]);
    },
    { maxBody: 1024 },
  );
});

test("Q6: 본문이 한도를 넘으면 413을 주고 연결을 닫는다 — 다음 요청은 새 연결로 정상이다", async () => {
  await withApp(
    async (c) => {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      const send = (method: string, path: string, body?: Buffer): Promise<{ status: number; connection: string | undefined; text: string }> =>
        new Promise((resolve, reject) => {
          const headers = body === undefined ? {} : { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) };
          const req = request({ host: HOST, port: c.port, path, method, agent, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (x: Buffer) => chunks.push(x));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, connection: res.headers["connection"], text: Buffer.concat(chunks).toString("utf8") }));
          });
          req.on("error", reject);
          req.end(body);
        });
      try {
        const big = await send("POST", "/api/quick/template", Buffer.alloc(1500));
        assert.equal(big.status, 413);
        assert.match(big.text, /TOO_LARGE/);
        assert.equal(big.connection, "close");
        // 한도의 두 배를 넘게 보내면 서버가 연결을 끊는다(413을 받거나 연결이 끊긴다. 어느 쪽이든 본문은 처리되지 않는다)
        const huge = await send("POST", "/api/quick/template", Buffer.alloc(5000)).catch((e: unknown) => (e as Error).message);
        assert.ok(typeof huge === "string" ? /socket hang up|ECONNRESET|aborted/.test(huge) : huge.status === 413, JSON.stringify(huge));
        const small = await send("POST", "/api/quick/template", Buffer.alloc(0));
        assert.equal(small.status, 400, "한도 안의 요청은 정상 처리된다(빈 파일은 EMPTY_UPLOAD)");
        assert.match(small.text, /EMPTY_UPLOAD/);
      } finally {
        agent.destroy();
      }
    },
    { maxBody: 1024 },
  );
});

test("Q6: 정적 파일 경로 탈출·허용 목록 밖은 404, 화면 파일과 공용 뷰어 코드는 200", async () => {
  await withApp(async (c) => {
    for (const path of [
      "/app/../../../package.json",
      "/app/%2e%2e/%2e%2e/package.json",
      "/app/..%5c..%5cpackage.json",
      "/app/../src/api.ts",
      "/src/api.ts",
      "/server.ts",
      "/packages/viewer/src/map/locate.ts",
      "/packages/viewer/src/host/shell.ts",
      "/packages/viewer/src/rhwp/../map/locate.ts",
      "/packages/viewer/src/dom/../../package.json",
      "/packages/hwpx-engine/src/index.ts",
      "/vendor/rhwp/package.json",
      "/vendor/rhwp/../../package.json",
      "/node_modules/@rhwp/core/package.json",
    ]) {
      assert.equal((await fetch(`${c.base}${path}`)).status, 404, path);
    }
    for (const path of ["/", "/app/main.ts", "/app/style.css", "/packages/viewer/src/dom/page-view.ts", "/packages/viewer/src/map/types.ts", "/vendor/rhwp/rhwp_bg.wasm"]) {
      assert.equal((await fetch(`${c.base}${path}`)).status, 200, path);
    }
    // POST는 API 밖에서 받지 않는다
    assert.equal((await post(c, "/app/main.ts", enc("x"))).status, 405);
  });
});

test("Q6: API의 잘못된 주소·방식·세션 번호", async () => {
  await withApp(async (c) => {
    const get = async (path: string): Promise<[number, string]> => {
      const res = await fetch(`${c.base}${path}`);
      return [res.status, ((await res.json()) as { error: { code: string } }).error.code];
    };
    assert.deepEqual(await get("/api/nothing"), [404, "NOT_FOUND"]);
    assert.deepEqual(await get("/api/quick/template"), [405, "METHOD_NOT_ALLOWED"]);
    assert.deepEqual(await get("/api/quick/generate"), [405, "METHOD_NOT_ALLOWED"]);
    for (const path of [
      "/api/quick/result/00000000-0000-0000-0000-000000000000/0",
      "/api/quick/result/not-a-session/0",
      "/api/quick/result/../../../etc/passwd/0",
    ]) {
      const res = await fetch(`${c.base}${path}`);
      assert.ok([404].includes(res.status), `${path}: ${res.status}`);
    }
    for (const bad of ["x", "../ws", "0".repeat(36), "00000000-0000-0000-0000-00000000000g", ""]) {
      const res = await post(c, `/api/quick/data?session=${encodeURIComponent(bad)}`, enc({ a: 1 }));
      assert.equal(res.status, 404, bad);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "SESSION_NOT_FOUND");
    }
  });
});

// ── 문서 올리기 → 자리 목록 (Q4) ─────────────────────────────────

test("Q4: 문서를 올리면 세션과 자리 목록이 오고, 목록은 엔진 함수 위의 계산(quick.analyzePlaces)과 같다. 오류는 { code, message, plain }", async () => {
  await withApp(async (c) => {
    for (const bytes of [readFixture("hancom/ph-table"), readFixture("hancom/field-states"), mixedDoc()]) {
      const t = await uploadTemplate(c, bytes, "표 문서.hwpx");
      assert.match(t.session, /^[0-9a-f-]{36}$/);
      assert.deepEqual([t.name, t.bytes], ["표 문서.hwpx", bytes.length]);
      assert.deepEqual(t.places, analyzePlaces(bytes));
    }
    const bad = await post(c, "/api/quick/template?name=x.hwpx", new Uint8Array([1, 2, 3, 4]));
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as { error: { code: string; message: string; plain: string } };
    assert.match(body.error.code, /^PKG_/);
    assert.ok(body.error.message.length > 0 && body.error.plain.length > 5 && body.error.plain !== body.error.code);
    const empty = await post(c, "/api/quick/template", new Uint8Array(0));
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as { error: { code: string; plain: string } }).error.code, "EMPTY_UPLOAD");
  });
});

test("Q4: 이름이 없으면 기본 이름, 이름에 폴더 구분자·.. 가 있어도 이름 규칙이 거른다", async () => {
  await withApp(async (c) => {
    const bytes = readFixture("hancom/ph-single");
    const data = { project: { name: "a", start: "b", end: "c" } };
    const unnamed = await post(c, "/api/quick/template", bytes);
    const t0 = (await unnamed.json()) as { name: string; session: string };
    assert.equal(t0.name, "문서.hwpx");
    const evil = await uploadTemplate(c, bytes, "../../밖으로/evil:name?.hwpx");
    await uploadData(c, evil.session, data);
    const run = await generateRun(c, evil.session);
    assert.equal(run.results[0]?.name, "evil_name_-001.hwpx");
    assert.equal((await download(c, evil.session, 0)).status, 200);
  });
});

// ── 데이터 올리기 → 키 목록과 대조표 (Q4) ────────────────────────

test("Q4: 데이터를 올리면 형식·건수·키 목록·대조표가 오고, 데이터에 없는 키는 missing으로 표시된다. 값 원문은 응답에 없다", async () => {
  await withApp(async (c) => {
    const t = await uploadTemplate(c, readFixture("hancom/ph-single"));
    const secret = "비밀값-7391-XYZ";
    const d = await uploadData(c, t.session, { project: { name: secret, start: "2026", end: null }, 여분: { 키: 1 }, 목록: [secret] });
    assert.deepEqual([d.session, d.form, d.records, d.keysTruncated], [t.session, "object", 1, false]);
    assert.deepEqual(
      d.matches.map((m) => [m.kind, m.key, m.state]),
      [["placeholder", "project.name", "ok"], ["placeholder", "project.start", "ok"], ["placeholder", "project.end", "missing"]],
      "null은 없는 것과 같다",
    );
    assert.deepEqual(d.keys.map((k) => [k.path, k.type]), [["project", "object"], ["project.name", "string"], ["project.start", "string"], ["project.end", "null"], ["여분", "object"], ["여분.키", "number"], ["목록", "array"]]);
    assert.doesNotMatch(JSON.stringify(t) + JSON.stringify(d), new RegExp(secret), "값 원문이 응답에 없다");
    // 다시 올리면 바뀐다
    const again = await uploadData(c, t.session, [{ project: { name: "a", start: "b", end: "c" } }, { project: { name: "a" } }]);
    assert.deepEqual([again.form, again.records], ["array", 2]);
    assert.deepEqual(again.matches.map((m) => [m.key, m.state, m.counts.ok, m.counts.missing]), [["project.name", "ok", 2, 0], ["project.start", "missing", 1, 1], ["project.end", "missing", 1, 1]]);
  });
});

test("Q4: 객체가 아닌 건은 invalidRecords로 알리고 대조표의 건수에서 뺀다 — 채울 수 없는 모양의 누름틀은 unfillable이다", async () => {
  await withApp(async (c) => {
    const t = await uploadTemplate(c, readFixture("hancom/ph-single"));
    const d = await uploadData(c, t.session, [{ project: { name: "a", start: "b", end: "c" } }, 42, { project: { name: "d" } }]);
    assert.deepEqual([d.form, d.records, d.invalidRecords], ["array", 3, 1]);
    assert.deepEqual(d.matches.map((m) => [m.key, m.state, m.counts.ok, m.counts.missing]), [["project.name", "ok", 2, 0], ["project.start", "missing", 1, 1], ["project.end", "missing", 1, 1]]);
    assert.equal((await uploadData(c, t.session, { project: { name: "a" } })).invalidRecords, 0);

    const inline = await uploadTemplate(c, readFixture("inline/inline-breaks"), "줄.hwpx");
    assert.deepEqual(inline.places.fields.map((f) => [f.name, f.fillable, f.unfillable]), [["줄", 0, [{ shape: "inline", count: 1 }]], ["탭", 0, [{ shape: "inline", count: 1 }]]]);
    const matched = await uploadData(c, inline.session, { 줄: "x", 탭: "y" });
    assert.deepEqual(matched.matches.map((m) => [m.kind, m.key, m.state]), [["field", "줄", "unfillable"], ["field", "탭", "unfillable"]]);
  });
});

test("Q4: 데이터 형식 오류는 400과 코드·쉬운 말이다(JSON 아님·객체도 배열도 아님·건 없음)", async () => {
  await withApp(async (c) => {
    const t = await uploadTemplate(c, readFixture("hancom/ph-single"));
    for (const [body, code] of [
      ["{ 깨진", "BAD_JSON"],
      ["3", "QUICK_BAD_DATA"],
      ["[]", "QUICK_NO_RECORDS"],
      ['{"schema":"hwpx-studio/dataset@1","data":5}', "DATA_SCHEMA"],
    ] as const) {
      const res = await post(c, `/api/quick/data?session=${t.session}`, enc(body));
      assert.equal(res.status, 400, body);
      const e = ((await res.json()) as { error: { code: string; plain: string } }).error;
      assert.equal(e.code, code);
      assert.ok(e.plain.length > 5 && !e.plain.startsWith(`${code}:`), `${code}: ${e.plain}`);
    }
    assert.equal((await post(c, `/api/quick/data?session=${t.session}`, new Uint8Array(0))).status, 400);
  });
});

test("세션: 열린 수 상한(4)을 넘으면 가장 오래된 세션이 닫힌다", async () => {
  await withApp(async (c) => {
    const bytes = readFixture("hancom/ph-single");
    const first = await uploadTemplate(c, bytes);
    for (let i = 0; i < 4; i++) await uploadTemplate(c, bytes);
    const res = await post(c, `/api/quick/data?session=${first.session}`, enc({ a: 1 }));
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "SESSION_NOT_FOUND");
  });
});

// ── 생성·내려받기·저장 (Q2, Q3) ──────────────────────────────────

const PH = { project: { name: "알파", start: "2026-01", end: "2027-01" } };

/** 엔진 generate를 직접 불러 얻은 바이트(템플릿 없이 {{}}만 채우는 문서용) */
function direct(bytes: Uint8Array, data: unknown, missing: "error" | "empty" | "keep" = "error"): Uint8Array {
  const r = generate(bytes, emptyTemplate(), readDataset(data), { missing });
  assert.ok(r.ok && !r.dryRun, "엔진 직접 호출이 성공해야 한다");
  return r.output;
}

test("Q3: 객체 하나 → 1건. 내려받은 바이트는 엔진 generate의 결과와 같고, 결과는 작업 공간의 out/<날짜-시각>/에 저장된다. 올린 원본과 데이터는 디스크에 없다", async () => {
  const bytes = readFixture("hancom/ph-single");
  await withApp(async (c) => {
    const t = await uploadTemplate(c, bytes, "계약서 양식.hwpx");
    await uploadData(c, t.session, PH);
    assert.equal(existsSync(c.workspace), false, "올리는 것만으로는 작업 공간을 만들지 않는다");
    const run = await generateRun(c, t.session, "error");
    assert.equal(run.results.length, 1);
    const r = run.results[0];
    assert.deepEqual([r?.index, r?.name, r?.ok, r?.filled, r?.skipped, r?.errors], [0, "계약서 양식-001.hwpx", true, 3, [], []]);
    assert.equal(run.saveError, undefined);
    assert.equal(run.folder, join(c.workspace, "out", STAMP));

    const got = await download(c, t.session, 0);
    assert.equal(got.status, 200);
    assert.deepEqual(got.bytes, direct(bytes, PH));
    assert.equal(got.headers.get("content-type"), "application/hwp+zip");
    const disposition = got.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^attachment; filename="result-001\.hwpx"; filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? ""), "계약서 양식-001.hwpx");

    // 저장된 파일 = 내려받은 바이트, 작업 공간에는 표지와 결과뿐이다
    assert.deepEqual(readFileSync(join(run.folder ?? "", "계약서 양식-001.hwpx")), Buffer.from(got.bytes));
    assert.deepEqual(listFiles(c.dir), [`ws/out/${STAMP}/계약서 양식-001.hwpx`, "ws/workspace.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(c.workspace, "workspace.json"), "utf8")), { schema: "hwpx-studio/workspace@1" });
    // 올린 원본 바이트와 같은 파일은 어디에도 없고, 임시 폴더에는 아무것도 없다
    for (const f of listFiles(c.dir)) assert.notDeepEqual(readFileSync(join(c.dir, f)), Buffer.from(bytes), f);
    assert.deepEqual(listFiles(c.tmp), []);
  });
});

test("Q2: 배열 N건 → N개 결과(이름 규칙), 한 건이 실패해도 나머지는 만들어 저장하고 건별로 보고한다. 같은 입력은 같은 바이트", async () => {
  const bytes = readFixture("hancom/ph-single");
  const records = [PH, { project: { name: "빠짐", start: "x" } }, { project: { name: "가\u0001", start: "x", end: "y" } }, 7, { project: { name: "마지막", start: "s", end: "e" } }];
  await withApp(async (c) => {
    const t = await uploadTemplate(c, bytes, "양식.hwpx");
    const d = await uploadData(c, t.session, records);
    assert.deepEqual([d.form, d.records], ["array", 5]);
    const run = await generateRun(c, t.session);
    assert.deepEqual(run.results.map((r) => r.name), ["양식-001.hwpx", "양식-002.hwpx", "양식-003.hwpx", "양식-004.hwpx", "양식-005.hwpx"]);
    assert.deepEqual(run.results.map((r) => r.ok), [true, false, false, false, true]);
    assert.deepEqual(run.results.map((r) => r.errors.map((e) => e.code)), [[], ["DATA_MISSING"], ["VALUE_CONTROL_CHAR"], ["DATA_SCHEMA"], []]);
    for (const r of run.results) for (const e of [...r.errors, ...r.skipped]) assert.ok(e.plain.length > 5 && e.plain !== e.code);

    // 성공한 건: 그 건 데이터만으로 엔진을 직접 부른 결과와 같다. 실패한 건: 파일이 없다
    for (const i of [0, 4]) assert.deepEqual((await download(c, t.session, i)).bytes, direct(bytes, records[i]), `건 ${i}`);
    for (const i of [1, 2, 3, 9]) {
      const miss = await download(c, t.session, i);
      assert.equal(miss.status, 404, `건 ${i}`);
    }
    assert.deepEqual(listFiles(c.dir), [`ws/out/${STAMP}/양식-001.hwpx`, `ws/out/${STAMP}/양식-005.hwpx`, "ws/workspace.json"], "저장된 것은 성공한 건뿐이다");

    // 결정성: 다시 만들면 같은 바이트, 폴더는 같은 시각이므로 -2가 붙는다
    const again = await generateRun(c, t.session);
    assert.deepEqual(again.results, run.results);
    assert.equal(again.folder, join(c.workspace, "out", `${STAMP}-2`));
    for (const name of ["양식-001.hwpx", "양식-005.hwpx"]) {
      assert.deepEqual(readFileSync(join(again.folder ?? "", name)), readFileSync(join(run.folder ?? "", name)), name);
    }
  });
});

test("Q3: 누름틀 문서 — 템플릿 없이 엔진이 누름틀 이름 = 데이터 키로 채운다. 내려받은 바이트는 템플릿 없이 엔진을 직접 부른 결과와 같다", async () => {
  const bytes = readFixture("hancom/field-states");
  const data = { 성명: "홍길동", 소속: "한국" };
  await withApp(async (c) => {
    const t = await uploadTemplate(c, bytes, "필드.hwpx");
    const d = await uploadData(c, t.session, data);
    assert.deepEqual(d.matches.map((m) => [m.kind, m.key, m.state]), [["field", "성명", "ok"], ["field", "소속", "ok"]]);
    const run = await generateRun(c, t.session);
    assert.deepEqual([run.results[0]?.ok, run.results[0]?.filled], [true, 3]);
    assert.deepEqual((await download(c, t.session, 0)).bytes, direct(bytes, data));
  });
});

test("누락 정책: 오류로 멈춤(기본)·빈칸·그대로 둠이 엔진 결과와 같다. 정책이 틀리거나 데이터가 없으면 거절한다", async () => {
  const bytes = readFixture("hancom/ph-single");
  const partial = { project: { name: "알파", start: "2026" } };
  await withApp(async (c) => {
    const t = await uploadTemplate(c, bytes, "x.hwpx");
    const noData = await postJson(c, "/api/quick/generate", { session: t.session });
    assert.equal(noData.status, 409);
    assert.equal(((await noData.json()) as { error: { code: string } }).error.code, "QUICK_NO_DATA");
    await uploadData(c, t.session, partial);

    const byDefault = await generateRun(c, t.session);
    assert.deepEqual(byDefault.results[0]?.errors.map((e) => e.code), ["DATA_MISSING"]);
    assert.match(byDefault.results[0]?.errors[0]?.detail ?? "", /project[.]end/, "엔진 메시지가 어느 키인지 밝힌다");
    assert.equal(byDefault.folder, null, "만든 결과가 없으면 저장하지 않는다");
    assert.equal(byDefault.saveError, undefined);
    assert.equal(existsSync(c.workspace), false, "저장할 것이 없으면 작업 공간도 만들지 않는다");

    const empty = await generateRun(c, t.session, "empty");
    assert.deepEqual([empty.results[0]?.ok, empty.results[0]?.filled], [true, 3]);
    assert.deepEqual((await download(c, t.session, 0)).bytes, direct(bytes, partial, "empty"));

    const keep = await generateRun(c, t.session, "keep");
    assert.deepEqual([keep.results[0]?.ok, keep.results[0]?.filled, keep.results[0]?.skipped.map((s) => s.code)], [true, 2, []]);
    assert.deepEqual((await download(c, t.session, 0)).bytes, direct(bytes, partial, "keep"));

    for (const bad of ["abort", 3, null, ["error"]]) {
      const res = await postJson(c, "/api/quick/generate", { session: t.session, missing: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await post(c, "/api/quick/generate", enc("{ 깨진"), "application/json")).status, 400);
    assert.equal((await postJson(c, "/api/quick/generate", [1])).status, 400);
    assert.equal((await postJson(c, "/api/quick/generate", { session: "x" })).status, 404);
  });
});

test("저장 실패는 생성을 막지 않는다: 표지 없는 비어 있지 않은 폴더에는 쓰지 않고(saveError), 결과는 내려받을 수 있다", async () => {
  const bytes = readFixture("hancom/ph-single");
  await withApp(async (c) => {
    mkdirSync(c.workspace);
    writeFileSync(join(c.workspace, "내-자료.txt"), "사용자 파일");
    const before = listFiles(c.dir);
    const t = await uploadTemplate(c, bytes);
    await uploadData(c, t.session, PH);
    const run = await generateRun(c, t.session);
    assert.equal(run.results[0]?.ok, true);
    assert.equal(run.folder, null);
    assert.equal(run.saveError?.code, "QUICK_WORKSPACE_FOREIGN");
    assert.ok((run.saveError?.plain.length ?? 0) > 10);
    assert.deepEqual(listFiles(c.dir), before, "그 폴더는 그대로다");
    assert.equal((await download(c, t.session, 0)).status, 200);
    // 폴더 열기는 저장된 폴더가 없으므로 거절한다
    assert.equal((await postJson(c, "/api/quick/open-folder", { session: t.session })).status, 409);
    assert.deepEqual(c.opened, []);
  });
});

test("작업 공간: 비어 있는 폴더·표지가 있는 폴더에는 쓰고(기존 파일은 그대로), 표지가 깨진 폴더에는 쓰지 않는다", async () => {
  const bytes = readFixture("hancom/ph-single");
  await withApp(async (c) => {
    mkdirSync(c.workspace);
    const t = await uploadTemplate(c, bytes, "양식.hwpx");
    await uploadData(c, t.session, PH);
    const first = await generateRun(c, t.session);
    assert.equal(first.saveError, undefined, "빈 폴더는 쓴다");
    assert.deepEqual(listFiles(c.workspace), [`out/${STAMP}/양식-001.hwpx`, "workspace.json"]);
    // 표지가 있으면 이미 있는 다른 파일 옆에도 쓴다
    writeFileSync(join(c.workspace, "templates.txt"), "기존");
    const second = await generateRun(c, t.session);
    assert.equal(second.saveError, undefined);
    assert.equal(readFileSync(join(c.workspace, "templates.txt"), "utf8"), "기존");
    // 표지가 망가지면 쓰지 않는다
    writeFileSync(join(c.workspace, "workspace.json"), "{ 깨진");
    const third = await generateRun(c, t.session);
    assert.equal(third.saveError?.code, "QUICK_WORKSPACE_FOREIGN");
    assert.equal(readFileSync(join(c.workspace, "workspace.json"), "utf8"), "{ 깨진", "표지를 고쳐 쓰지 않는다");
    writeFileSync(join(c.workspace, "workspace.json"), JSON.stringify({ schema: "다른/표지@9" }));
    assert.equal((await generateRun(c, t.session)).saveError?.code, "QUICK_WORKSPACE_FOREIGN");
  });
});

test("폴더 열기: 마지막 생성이 저장한 작업 공간 안의 폴더 하나만 연다. 경로는 요청에서 받지 않는다", async () => {
  const bytes = readFixture("hancom/ph-single");
  await withApp(async (c) => {
    const t = await uploadTemplate(c, bytes);
    await uploadData(c, t.session, PH);
    const before = await postJson(c, "/api/quick/open-folder", { session: t.session });
    assert.equal(before.status, 409);
    assert.equal(((await before.json()) as { error: { code: string; plain: string } }).error.code, "QUICK_NO_FOLDER");
    const run = await generateRun(c, t.session);
    // 요청에 폴더 경로를 실어 보내도 쓰지 않는다
    const res = await postJson(c, "/api/quick/open-folder", { session: t.session, folder: "C:/Windows", path: "/etc" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { opened: true });
    assert.deepEqual(c.opened, [run.folder]);
    assert.ok((run.folder ?? "").startsWith(join(c.workspace, "out")));
    assert.equal((await post(c, "/api/quick/open-folder", enc("x"), "application/json")).status, 400);
    assert.equal((await fetch(`${c.base}/api/quick/open-folder`)).status, 405);
  });
});

test("폴더 열기 실패는 쉬운 말 오류로 알린다. 작업 공간 밖의 폴더는 열지 않는다", async () => {
  const bytes = readFixture("hancom/ph-single");
  await withApp(
    async (c) => {
      const t = await uploadTemplate(c, bytes);
      await uploadData(c, t.session, PH);
      await generateRun(c, t.session);
      const res = await postJson(c, "/api/quick/open-folder", { session: t.session });
      assert.equal(res.status, 500);
      const e = ((await res.json()) as { error: { code: string; plain: string } }).error;
      assert.deepEqual([e.code, e.plain.length > 5], ["QUICK_OPEN_FAILED", true]);
      let called = 0;
      const open = (): Promise<void> => Promise.resolve(void called++);
      await assert.rejects(openFolder(c.workspace, c.dir, open), { code: "QUICK_NO_FOLDER" });
      await assert.rejects(openFolder(c.workspace, join(c.workspace, "없는 폴더"), open), { code: "QUICK_NO_FOLDER" });
      await assert.rejects(openFolder(c.workspace, join(c.workspace, "workspace.json"), open), { code: "QUICK_NO_FOLDER" });
      assert.equal(called, 0);
    },
    { opener: () => Promise.reject(new HostError(500, "QUICK_OPEN_FAILED", "탐색기를 열지 못했습니다.")) },
  );
});

// ── 합성 문서(누름틀 + {{}} + 나쁜 누름틀 이름)와 값의 거절 ───────

test("HTTP로 보는 보고서: 데이터 경로가 아닌 이름의 누름틀은 엔진이 건너뜀(FIELD_NAME_NOT_PATH), 거절되는 값(U+0001)은 그 건만 실패, 줄바꿈은 정보, 값 원문은 응답 어디에도 없다", async () => {
  const bytes = mixedDoc();
  const secret = "비밀값-4242-ABC";
  await withApp(async (c) => {
    const t = await uploadTemplate(c, bytes, "혼합.hwpx");
    assert.deepEqual(t.places.fields, [
      { name: "성명", count: 1, usable: true, fillable: 1, unfillable: [] },
      { name: "이 름", count: 1, usable: false, fillable: 1, unfillable: [] },
    ]);
    const d = await uploadData(c, t.session, [
      { 성명: secret, project: { name: "알파", start: "1" } },
      { 성명: `${secret}\u0001`, project: { name: "알파", start: "1" } },
      { 성명: "셋째", project: { name: { 객체: secret }, start: "1" } },
      { 성명: "줄\n바꿈", project: { name: "알파", start: "1" } },
    ]);
    assert.deepEqual(d.matches.map((m) => [m.key, m.state, m.reason, m.multiline]), [
      ["성명", "rejected", "U+0001", 1],
      ["이 름", "badKey", undefined, 0],
      ["project.name", "notScalar", undefined, 0],
      ["project.start", "ok", undefined, 0],
    ]);
    assert.deepEqual(d.matches[0]?.counts, { ok: 3, missing: 0, notScalar: 0, rejected: 1 });
    const run = await generateRun(c, t.session);
    assert.deepEqual(run.results.map((r) => r.ok), [true, false, false, true]);
    assert.deepEqual(run.results[0]?.skipped.map((s) => [s.code, s.place]), [["FIELD_NAME_NOT_PATH", '누름틀 "이 름"']]);
    assert.deepEqual(run.results[1]?.errors.map((e) => e.code), ["VALUE_CONTROL_CHAR"]);
    assert.deepEqual(run.results[2]?.errors.map((e) => e.code), ["DATA_NOT_SCALAR"]);
    assert.deepEqual(run.results[3]?.notes.map((n) => [n.code, n.place]), [["QUICK_MULTILINE", "키 성명"]]);
    assert.deepEqual(run.results[3]?.errors, []);
    assert.deepEqual(run.results[0]?.notes, []);
    // 값 원문은 업로드·생성 응답 어디에도 없다
    assert.doesNotMatch(JSON.stringify([t, d, run]), new RegExp(secret));
    // 내려받은 첫 건에는 값이 들어 있다(원문은 파일에만 있다)
    const got = await download(c, t.session, 0);
    assert.equal(got.status, 200);
    assert.deepEqual(got.bytes, direct(bytes, { 성명: secret, project: { name: "알파", start: "1" } }));
  });
});

// ── 정적 점검: 디스크 쓰기, 외부 주소, 안전한 호출 ───────────────

const sourcesOf = (dir: URL, ext = /\.(ts|html|css)$/): { name: string; text: string }[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && ext.test(e.name))
    .map((e) => ({ name: e.name, text: readFileSync(new URL(e.name, dir), "utf8") }));

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const WRITE_CALL = /\b(writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|symlink|symlinkSync|link|linkSync|utimes|chmod|chown)\b/;

test("Q3(정적 점검): 디스크에 쓰는 호출은 workspace.ts에만 있고, 거기서도 작업 공간 폴더 안의 새 파일·폴더뿐이다", () => {
  const files = [
    ...sourcesOf(here("../src/")),
    ...sourcesOf(here("../../../packages/viewer/src/host/")),
    { name: "server.ts", text: readFileSync(here("../server.ts"), "utf8") },
  ];
  assert.ok(files.length >= 14);
  for (const f of files) {
    if (f.name === "workspace.ts") continue;
    assert.doesNotMatch(withoutComments(f.text), WRITE_CALL, `${f.name}: 파일을 쓰거나 지우는 호출이 있다`);
  }
  const ws = withoutComments(readFileSync(here("../src/workspace.ts"), "utf8"));
  const used = new Set([...ws.matchAll(new RegExp(WRITE_CALL.source, "g"))].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ["mkdirSync", "renameSync", "rmdirSync", "unlinkSync", "writeFileSync"]);
  // 모든 쓰기는 새 파일(`wx`)이거나, 방금 만든 폴더 안·표지 경로(join)다. 덮어쓰기 플래그가 없다
  for (const m of ws.matchAll(/writeFileSync\(([^)]*)\)/g)) assert.match(m[1] ?? "", /\{ flag: "wx" \}/, m[0]);
  assert.doesNotMatch(ws, /flag: "(w|a|r\+)"/);
  // 시험 앱·작업 공간 밖을 가리키는 저장소 경로를 쓰지 않는다
  for (const f of files) assert.doesNotMatch(withoutComments(f.text), /\btmpdir\b|mkdtemp/, `${f.name}: 임시 폴더를 쓴다`);
});

test("Q3(정적 점검): 폴더 열기는 셸 없이 spawn에 인자 배열로 넘기는 호출 하나뿐이다", () => {
  const files = [...sourcesOf(here("../src/")), { name: "server.ts", text: readFileSync(here("../server.ts"), "utf8") }];
  const calls: string[] = [];
  for (const f of files) {
    const code = withoutComments(f.text);
    assert.doesNotMatch(code, /(?<![.\w])(exec|execSync|execFile|execFileSync|fork|spawnSync)\s*\(/, `${f.name}: 다른 프로세스 호출`);
    assert.doesNotMatch(code, /shell\s*:/, `${f.name}: shell 옵션`);
    for (const m of code.matchAll(/\bspawn\s*\(([^)]*)\)/g)) calls.push(`${f.name}: ${m[1]}`);
  }
  assert.equal(calls.length, 1, calls.join(" | "));
  assert.match(calls[0] ?? "", /^workspace\.ts: "explorer\.exe", \[folder\], \{ detached: true, stdio: "ignore" \}$/);
});

test("Q3(정적 점검): 화면 코드와 서버가 주는 정적 파일에 외부 주소가 없고, 화면은 innerHTML·eval·인라인 스타일을 쓰지 않는다", () => {
  const dirs = [here("../web/"), here("../../../packages/viewer/src/dom/"), here("../../../packages/viewer/src/rhwp/")];
  for (const dir of dirs) {
    for (const f of sourcesOf(dir)) {
      const urls = [...f.text.matchAll(/https?:\/\/[^\s"'`)<>]+/g)].map((m) => m[0]);
      assert.deepEqual(urls, [], `${f.name}에 외부 주소가 있다`);
      assert.doesNotMatch(f.text, /@import|googleapis|cdn\.|unpkg|jsdelivr|\/\/[a-z0-9.-]+\.(com|net|org|io|kr)\b/i, `${f.name}: 외부 글꼴·CDN 참조`);
    }
  }
  for (const f of sourcesOf(here("../web/"))) {
    const code = withoutComments(f.text);
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setAttribute\(\s*["']style/, `${f.name}: 위험한 DOM·코드 호출`);
    if (f.name.endsWith(".html")) assert.doesNotMatch(f.text, /\sstyle=|\son[a-z]+=|<style|<script(?![^>]*\ssrc=)/i, `${f.name}: 인라인 스크립트·스타일(CSP가 막는다)`);
  }
  // 개인 절대경로를 적지 않는다
  for (const f of [...sourcesOf(here("../src/")), ...sourcesOf(here("../web/")), ...sourcesOf(here("../test/"))]) {
    assert.doesNotMatch(f.text, /[A-Za-z]:[/\u005c](Users|Prodev)/, `${f.name}: 개인 절대경로`);
  }
});

test("앱의 package.json은 작업공간 패키지와 rhwp만 의존성으로 선언한다(새 의존성 없음)", () => {
  const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { name: string; dependencies?: Record<string, string>; devDependencies?: unknown };
  assert.equal(pkg.name, "@hwpx-studio/studio");
  assert.deepEqual(pkg.dependencies, { "@hwpx-studio/engine": "0.0.0", "@hwpx-studio/viewer": "0.0.0", "@rhwp/core": "0.8.6" });
  assert.equal(pkg.devDependencies, undefined);
});

// ── 화면 파일: 모듈 그래프, CSP ──────────────────────────────────

test("정적 파일: 첫 화면 HTML과 CSP, 타입이 제거된 main.ts", async () => {
  await withApp(async (c) => {
    const index = await fetch(`${c.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
    const csp = index.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /https?:|\*/, "외부 출처를 허용하지 않는다");
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");
    assert.match(await index.text(), /<script type="module" src="\/app\/main\.ts">/);
    const main = await fetch(`${c.base}/app/main.ts`);
    assert.equal(main.status, 200);
    assert.match(main.headers.get("content-type") ?? "", /^text\/javascript/);
    const text = await main.text();
    assert.ok(text.includes("createPageView") && !/\bimport type\b/.test(text) && !/: HTMLElement\b/.test(text), "타입이 제거돼야 한다");
    const load = await (await fetch(`${c.base}/packages/viewer/src/rhwp/load.ts`)).text();
    assert.ok(load.includes('from "/vendor/rhwp/rhwp.js"') && !load.includes('"@rhwp/core"'));
  });
});

test("브라우저 모듈 그래프: /app/main.ts에서 import를 따라가면 전부 200이고 문법이 맞고, 엔진·호스트 코드·node 내장 모듈을 가져오지 않는다", async () => {
  await withApp(async (c) => {
    const seen = new Map<string, string>();
    const queue = [`${c.base}/app/main.ts`];
    while (queue.length > 0) {
      const url = queue.pop() as string;
      if (seen.has(url)) continue;
      const res = await fetch(url);
      assert.equal(res.status, 200, `${url}: ${res.status}`);
      const code = await res.text();
      seen.set(url, code);
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
      // 문법 검사(디스크에 쓰지 않고 표준 입력으로)
      const r = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: code, encoding: "utf8" });
      assert.equal(r.status, 0, `${url}: ${r.stderr.slice(0, 300)}`);
    }
    const names = [...seen.keys()].map((u) => new URL(u).pathname);
    assert.ok(names.includes("/app/main.ts") && names.includes("/vendor/rhwp/rhwp.js") && names.includes("/packages/viewer/src/dom/page-view.ts"));
    assert.deepEqual(names.filter((n) => n.includes("/host/") || n.includes("/api") || n.includes("/quick") || n.includes("/workspace") || n.includes("/messages")), [], "호스트 쪽 코드는 화면으로 가지 않는다");
    // 화면 모듈의 정적 import 목록에는 값으로 가져오는 앱 코드가 없다(api-types는 형만이라 제거된다)
    assert.ok(!names.some((n) => n.startsWith("/app/") && n !== "/app/main.ts"));
  });
});

test("화면 연결: main.ts가 찾는 요소 id가 index.html에 모두 있고, 서버 API 주소가 서버의 경로와 같다", () => {
  const html = readFileSync(here("../web/index.html"), "utf8");
  const main = readFileSync(here("../web/main.ts"), "utf8");
  const wanted = [...main.matchAll(/\$<[A-Za-z]+>\("([a-z-]+)"\)/g)].map((m) => m[1] as string);
  assert.ok(wanted.length >= 15, `찾는 요소 ${wanted.length}개`);
  const ids = new Set([...html.matchAll(/\sid="([a-z-]+)"/g)].map((m) => m[1]));
  assert.deepEqual(wanted.filter((id) => !ids.has(id)), [], "index.html에 없는 요소");
  assert.equal(new Set(wanted).size, wanted.length, "같은 요소를 두 번 찾는다");
  // 화면이 부르는 주소는 서버가 받는 주소뿐이다
  const api = readFileSync(here("../src/api.ts"), "utf8");
  for (const m of main.matchAll(/["'`](\/api\/[a-z/-]+)/g)) {
    const path = (m[1] as string).replace(/\/$/, "");
    assert.ok(api.includes(`"${path}"`) || path === "/api/quick/result", `${path}: 서버에 없는 주소`);
  }
  assert.match(main, /name="missing"\]:checked/);
  assert.match(html, /name="missing" value="error" checked/);
  for (const value of ["error", "empty", "keep"]) assert.ok(html.includes(`value="${value}"`), value);
});

test("미리보기(Node 쪽 확인): 내려받은 결과를 기존 뷰어(rhwp)가 열고, 쪽 글자 배치에 채운 값이 보인다 — 건마다 자기 값이다", async () => {
  const { ensureRhwp } = await import("../../../packages/viewer/test/helpers.ts");
  const { openDocument } = await import("../../../packages/viewer/src/rhwp/index.ts");
  await ensureRhwp();
  await withApp(async (c) => {
    const t = await uploadTemplate(c, readFixture("hancom/ph-single"), "미리보기.hwpx");
    await uploadData(c, t.session, [PH, { project: { name: "둘째사업", start: "s", end: "e" } }]);
    const run = await generateRun(c, t.session);
    assert.deepEqual(run.results.map((r) => r.ok), [true, true]);
    for (const [i, name] of [[0, "알파"], [1, "둘째사업"]] as const) {
      const got = await download(c, t.session, i);
      const doc = openDocument(got.bytes);
      try {
        const text = Array.from({ length: doc.pageCount() }, (_, p) => doc.pageLayout(p).runs.map((r) => r.text).join("")).join("");
        assert.ok(text.includes(name), `건 ${i}: ${name}`);
        assert.ok(!text.includes("{{"), `건 ${i}: 채우지 못한 {{}}가 남았다`);
      } finally {
        doc.free();
      }
    }
  });
});

// ── CLI 동치: 템플릿 없이 CLI가 만든 결과와 같은 바이트·같은 이름 ─────

const CLI = fileURLToPath(here("../../cli/src/main.ts"));

function runCli(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

test("CLI 동치: 한 건은 `fill`, 여러 건은 `fill --batch`(템플릿 없이)와 바이트·파일 이름이 같고, out/ 폴더의 파일도 같다 — {{}} 문서와 누름틀 문서, 줄바꿈 값, 실패한 건 포함", async () => {
  const box = sandbox(); // CLI의 입력과 출력은 이 시험 전용 OS 임시 폴더에만 둔다
  try {
    const cases: [string, string, unknown][] = [
      ["hancom/ph-single", "계약 양식.hwpx", PH],
      ["hancom/field-states", "필드 양식.hwpx", { 성명: "홍길동", 소속: "한국" }],
      ["hancom/field-states", "줄바꿈.hwpx", { 성명: "홍\n길동", 소속: "한국" }],
      ["hancom/ph-single", "여러 건.hwpx", [PH, { project: { name: "빠짐", start: "x" } }, { project: { name: "둘째\n줄", start: "s", end: "e" } }, 7]],
      ["hancom/field-states", "필드 여러 건.hwpx", { schema: "hwpx-studio/dataset@1", data: [{ 성명: "가", 소속: "A" }, { 성명: "나" }, { 성명: "다", 소속: "C" }], derived: { 소속: "기본" } }],
    ];
    let n = 0;
    for (const [fixture, fileName, data] of cases) {
      n++;
      const src = join(box.dir, `src${n}`, fileName);
      mkdirSync(join(box.dir, `src${n}`));
      writeFileSync(src, readFixture(fixture));
      const dataPath = join(box.dir, `data${n}.json`);
      writeFileSync(dataPath, JSON.stringify(data));
      const batch = Array.isArray(data) || (data as { data?: unknown }).data instanceof Array;
      const cliOut = join(box.dir, `out${n}`);
      if (batch) mkdirSync(cliOut);
      const cli = batch ? runCli(["fill", src, "--data", dataPath, "--batch", "-o", cliOut]) : runCli(["fill", src, "--data", dataPath, "-o", join(cliOut)]);

      await withApp(async (c) => {
        const t = await uploadTemplate(c, readFixture(fixture), fileName);
        await uploadData(c, t.session, data);
        const run = await generateRun(c, t.session, "error");
        const okNames = run.results.filter((r) => r.ok).map((r) => r.name);
        // CLI의 종료 코드: 하나라도 실패하면 1, 모두 성공하면 0
        assert.equal(cli.status, run.results.every((r) => r.ok) ? 0 : 1, `${fileName}: CLI 종료 코드 ${cli.status} ${cli.stderr.slice(0, 200)}`);
        if (batch) {
          assert.deepEqual(readdirSync(cliOut).sort(), [...okNames].sort(), `${fileName}: 결과 파일 이름`);
          for (const r of run.results.filter((x) => x.ok)) {
            const mine = (await download(c, t.session, r.index)).bytes;
            assert.deepEqual(mine, new Uint8Array(readFileSync(join(cliOut, r.name))), `${fileName}: ${r.name}`);
            assert.deepEqual(new Uint8Array(readFileSync(join(run.folder ?? "", r.name))), mine, `${fileName}: out/ ${r.name}`);
          }
        } else {
          // 한 건: CLI는 -o 경로의 파일 하나를 만든다(스튜디오는 같은 바이트를 <원본 이름>-001.hwpx로 준다)
          assert.equal(run.results[0]?.name, `${fileName.replace(".hwpx", "")}-001.hwpx`);
          const mine = (await download(c, t.session, 0)).bytes;
          assert.deepEqual(mine, new Uint8Array(readFileSync(cliOut)), `${fileName}: 한 건 바이트`);
          assert.deepEqual(new Uint8Array(readFileSync(join(run.folder ?? "", run.results[0]?.name ?? ""))), mine);
        }
      });
    }
  } finally {
    box.remove();
  }
});
