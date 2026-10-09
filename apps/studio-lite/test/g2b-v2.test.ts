// #133 `/api/g2b` 2판 창구(엔진 명세 8.8.14, 확정 2026-10-09): 요청·답장 꼴, 요청 전체 오류 꼴, 값·키·타입·빈 값·분기 규칙,
// 재시도(처리 중·끝남·파일 없음·다른 지문)·dryRun·기록(값 없음)·파일 이름·라벨 사전·순서, 엔진 코드 → 창구 이름.
// 합성 서식(자리 수십 개: 본문·표 칸·머리말·메일머지·누름틀, 같은 키 중복, 공백·괄호·점 키, 분기 하나)에 긴 값으로 무작위 50건·100건 시간.
// 출력은 OS 임시 폴더에만 쓰고 지운다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareToBaseline, generate, listFields, openPackage, parseDocument, readStudioTemplate, validateDocument, walkParagraphs, type StudioTemplate, type ValueFormat } from '@hwpx-studio/engine';
import { findLooseKeys } from '../../../packages/hwpx-engine/src/fill/studio-common.ts';
import { readFixture, reparse } from '../../../packages/hwpx-engine/test/helpers.ts';
import { ds, insertText, KEEP, line, longValue, rng, tpl } from '../../../packages/hwpx-engine/test/range-helpers.ts';
import { createApp } from '../src/server.ts';
import { createG2B2, fileBase, windowCode } from '../src/g2b-v2.ts';
import { g2bTemplate } from '../src/input-table.ts';
import { UNKNOWN_EXPLANATION, plainOf } from '../src/quick-messages.ts';

const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const texts = (bytes: Uint8Array) => parseDocument(openPackage(bytes)).sections.flatMap(s => [...walkParagraphs(s.paragraphs)].map(p => p.logicalText));
const newErrors = (src: Uint8Array, out: Uint8Array) => compareToBaseline(validateDocument(src), validateDocument(out)).newErrors;

// ── 서버 ────────────────────────────────────────────────────────

type Sent = { http: number; body: any };
async function start(database: string) {
  const server = createApp(database); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const raw = (method: string, path: string, body?: string | Buffer, headers: Record<string, string> = {}) => new Promise<Sent>((resolve, reject) => {
    let answered = false;
    const q = httpRequest(base + path, { method, headers }, res => {
      answered = true;
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(Buffer.from(c))); res.on('error', reject);
      res.on('end', () => { try { resolve({ http: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(e); } });
    });
    // 413은 본문을 다 받기 전에 답하므로 그 뒤의 쓰기 오류는 무시한다
    q.on('error', e => { if (!answered) reject(e); }); q.end(body);
  });
  const post = (path: string, value: unknown, origin: string | false = false) => raw('POST', path, JSON.stringify(value), { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) });
  const studio = (path: string, value: unknown) => post(path, value, base);
  const get = (path: string) => raw('GET', path);
  const close = () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return { base, raw, post, studio, get, close };
}
type App = Awaited<ReturnType<typeof start>>;
async function withApp(run: (app: App, root: string) => Promise<void>, database?: string) {
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-')); const app = await start(database ?? join(root, 'test.sqlite'));
  try { await run(app, root); } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

// ── 예시 서식(examples/template-v2: 슬롯 2개, 블록 5개, 조각 1개) ────────

const EX = new URL('../../../examples/template-v2/', import.meta.url);
const NOTICE = {
  template: JSON.parse(readFileSync(new URL('template.json', EX), 'utf8')),
  source: readFileSync(new URL('notice.hwpx', EX)).toString('base64'),
  blobs: Object.fromEntries(readdirSync(new URL('blobs/', EX)).map(f => [f.replace(/\.json$/, ''), readFileSync(new URL(`blobs/${f}`, EX)).toString('base64')])),
};
const NOTICE_SRC = new Uint8Array(readFileSync(new URL('notice.hwpx', EX)));
const DATA: Record<string, unknown> = JSON.parse(readFileSync(new URL('data.json', EX), 'utf8'));
const req = (requestId: string, items: unknown[], extra: Record<string, unknown> = {}) => ({ format: 'studio-generate', version: 2, requestId, profileId: 'notice', items, ...extra });
const item = (values: Record<string, unknown> = DATA, extra: Record<string, unknown> = {}) => ({ values, selections: { '제출 서류': 'b4' }, ...extra });
const without = (key: string, values: Record<string, unknown> = DATA) => Object.fromEntries(Object.entries(values).filter(([k]) => k !== key));
async function setup(app: App, directory: string, profile: Record<string, unknown> = {}) {
  const saved = await app.studio('/api/g2b/templates', NOTICE); assert.equal(saved.http, 200, JSON.stringify(saved.body));
  const p = await app.studio('/api/g2b/profiles', { id: 'notice', label: '입찰 공고', templateId: 't0e5a0001', version: 1, outputDirectory: directory, ...profile });
  assert.equal(p.http, 200, JSON.stringify(p.body));
}
/** 요청 전체 오류 꼴: `{ requestId?, code, message }`만(1판의 `{ error }` 없음) */
function wholeError(r: Sent, http: number, code: string, requestId?: string) {
  assert.equal(r.http, http, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), (requestId === undefined ? ['code', 'message'] : ['code', 'message', 'requestId']).sort());
  assert.equal(r.body.code, code); assert.equal(typeof r.body.message, 'string');
  if (requestId !== undefined) assert.equal(r.body.requestId, requestId);
}
const outputs = (dir: string) => readdirSync(dir).filter(n => n.endsWith('.hwpx')).sort();

test('창구: 서식·프로필 저장은 Studio 화면(Origin)만, 프로필 2판 꼴, Helper(Origin 없음) 생성, 서식 판 불변·원본 해시 대조', async () => {
  await withApp(async (app, root) => {
    assert.equal((await app.post('/api/g2b/templates', NOTICE)).http, 403);
    await setup(app, join(root, 'out'));
    assert.equal((await app.post('/api/g2b/profiles', { id: 'x', label: 'x', templateId: 't0e5a0001', version: 1, outputDirectory: join(root, 'x') })).http, 403);
    const profiles = (await app.get('/api/g2b/profiles')).body.profiles;
    assert.deepEqual(profiles, [{ id: 'notice', label: '입찰 공고', templateId: 't0e5a0001', version: 1, outputDirectory: profiles[0].outputDirectory }]);
    const r = await app.post('/api/g2b/generate', req('first', [item()]));
    assert.equal(r.http, 200); assert.equal(r.body.status, 'success'); assert.deepEqual(r.body.warnings, []);
    assert.deepEqual(Object.keys(r.body).sort(), ['requestId', 'results', 'status', 'summary', 'warnings']);
    assert.deepEqual(Object.keys(r.body.summary).sort(), ['failed', 'needsInput', 'succeeded', 'timings', 'totalMs']);
    assert.equal(r.body.summary.succeeded, 1); assert.equal(r.body.summary.timings.length, 1); assert.equal(typeof r.body.summary.totalMs, 'number');
    const out = new Uint8Array(readFileSync(r.body.results[0].path));
    assert.deepEqual(newErrors(NOTICE_SRC, out), []);
    const all = texts(out).join('\n');
    for (const s of ['가나다 사업', '150,000,000', '홍길동', '법인 인감증명서 1부']) assert(all.includes(s), s);
    assert(!all.includes('{{'));
    assert.equal((await app.post('/api/g2b/generate', req('web', [item()]), 'https://public.example')).http, 403);
    // 서식 판은 바뀌지 않는다: 같은 판을 다른 내용으로 저장하면 409, 같은 내용은 그대로. 원본 해시가 다르면 거절
    assert.equal((await app.studio('/api/g2b/templates', NOTICE)).http, 200);
    wholeError(await app.studio('/api/g2b/templates', { ...NOTICE, template: { ...NOTICE.template, meta: { name: '바뀐 이름' } } }), 409, 'REQUEST_CONFLICT');
    wholeError(await app.studio('/api/g2b/templates', { ...NOTICE, template: { ...NOTICE.template, version: 2 }, source: Buffer.from('다른 원본').toString('base64') }), 400, 'INVALID_REQUEST');
    wholeError(await app.studio('/api/g2b/profiles', { id: 'none', label: '없는 판', templateId: 't0e5a0001', version: 9, outputDirectory: join(root, 'o') }), 400, 'PROFILE_INVALID');
  });
});

test('요청 전체 오류는 { requestId?, code, message }: 400 형식·모르는 타입 이름·키 규칙·없는 프로필, 409, 413, 415', async () => {
  await withApp(async (app, root) => {
    await setup(app, join(root, 'out'));
    wholeError(await app.raw('POST', '/api/g2b/generate', '{"format":', { 'Content-Type': 'application/json' }), 400, 'INVALID_REQUEST');
    wholeError(await app.raw('POST', '/api/g2b/generate', JSON.stringify(req('t', [item()])), { 'Content-Type': 'text/plain' }), 415, 'INVALID_REQUEST');
    wholeError(await app.raw('POST', '/api/g2b/generate', Buffer.alloc(33 * 1024 * 1024, 0x20), { 'Content-Type': 'application/json' }), 413, 'INVALID_REQUEST');
    wholeError(await app.post('/api/g2b/generate', { ...req('v3', [item()]), version: 3 }), 400, 'INVALID_REQUEST', 'v3');
    wholeError(await app.post('/api/g2b/generate', req('none', [])), 400, 'INVALID_REQUEST', 'none');
    wholeError(await app.post('/api/g2b/generate', req('many', Array.from({ length: 101 }, () => item()))), 400, 'INVALID_REQUEST', 'many');
    wholeError(await app.post('/api/g2b/generate', req('values', [{ selections: {} }])), 400, 'INVALID_REQUEST', 'values');
    wholeError(await app.post('/api/g2b/generate', req('type', [item()], { types: { '사업명': 'string' } })), 400, 'INVALID_REQUEST', 'type');
    wholeError(await app.post('/api/g2b/generate', req('ctype', [item()], { columns: [{ key: '사업명', label: '사업명', type: 'currency' }] })), 400, 'INVALID_REQUEST', 'ctype');
    wholeError(await app.post('/api/g2b/generate', req('empty-key', [item({ ...DATA, '': 'x' })])), 400, 'INVALID_REQUEST', 'empty-key');
    wholeError(await app.post('/api/g2b/generate', req('ctrl-key', [item({ ...DATA, '열\u0007': 'x' })])), 400, 'INVALID_REQUEST', 'ctrl-key');
    wholeError(await app.post('/api/g2b/generate', req('nfc-dup', [item({ ...DATA, ['담당자'.normalize('NFD')]: '다른 값' })])), 400, 'INVALID_REQUEST', 'nfc-dup');
    wholeError(await app.post('/api/g2b/generate', req('allow-ctrl', [item(DATA, { allowEmpty: ['\u0000'] })])), 400, 'INVALID_REQUEST', 'allow-ctrl');
    wholeError(await app.post('/api/g2b/generate', { ...req('np', [item()]), profileId: 'nobody' }), 400, 'UNKNOWN_PROFILE', 'np');
    assert.equal((await app.post('/api/g2b/generate', req('c', [item()]))).http, 200);
    wholeError(await app.post('/api/g2b/generate', req('c', [item({ ...DATA, 담당자: '다른 사람' })])), 409, 'REQUEST_CONFLICT', 'c');
    // 오류 메시지에 값 원문이 없다(키 이름·위치만)
    const secret = await app.post('/api/g2b/generate', req('secret', [item({ ...DATA, '열\u0001': 'SECRET-VALUE' })]));
    assert(!JSON.stringify(secret.body).includes('SECRET-VALUE'));
  });
});

test('값·키·모르는 필드: 서식이 쓰는 열은 스칼라·null만(객체·배열은 그 건 INVALID_FIELDS), 괄호·공백 키 그대로·NFC 비교, 모르는 필드는 무시 + 최상위 UNKNOWN_FIELD 한 번씩', async () => {
  await withApp(async (app, root) => {
    const dir = join(root, 'out'); await setup(app, dir);
    const nfd = Object.fromEntries(Object.entries(DATA).map(([k, v]) => [k.normalize('NFD'), v]));
    const r = await app.post('/api/g2b/generate', req('values', [
      item(nfd, { meta: { identity: ['NFD'] } }),
      item({ ...DATA, 원천목록: ['가', '나'] }),
      item({ ...DATA, '추정 가격(원)': { 값: 1 } }),
      item({ ...DATA, 'a.b': 'x', '사업명.이름': '점은 경로가 아니다', 원천숫자: 7, 원천참거짓: false, 원천없음: null }, { meta: { identity: ['점'] } }),
    ]));
    assert.equal(r.body.status, 'partial'); assert.deepEqual(r.body.warnings, []);
    assert.deepEqual(r.body.results.map((x: any) => [x.status, x.code]), [['success', undefined], ['success', undefined], ['needs-input', 'INVALID_FIELDS'], ['success', undefined]]);
    assert.deepEqual(r.body.results[2].invalidFields, [{ field: '추정 가격(원)', type: 'money' }]);
    assert.deepEqual(readFileSync(r.body.results[0].path), readFileSync(r.body.results[3].path), 'NFD 키·쓰지 않는 열은 결과를 바꾸지 않는다');
    const unknown = await app.post('/api/g2b/generate', { ...req('unknown', [{ ...item(), children: [], meta: { identity: ['u'], foo: 1 } }, { ...item(), children: [{ rows: [] }] }], { columns: [{ key: '사업명', label: '사업명', type: 'text', bar: 1 }] }), sourceKind: 'db' });
    assert.equal(unknown.body.status, 'success');
    assert.deepEqual(unknown.body.warnings.map((w: any) => [w.code, w.field]), [['UNKNOWN_FIELD', 'sourceKind'], ['UNKNOWN_FIELD', 'items[].children'], ['UNKNOWN_FIELD', 'items[].meta.foo'], ['UNKNOWN_FIELD', 'columns[].bar']]);
    assert(unknown.body.results.every((x: any) => x.warnings === undefined));
  });
});

test('타입 우선순위: 서식 타입 → 요청 types → text. 다르면 서식 타입으로 읽고 건별 TYPE_MISMATCH 경고, 서식이 안 쓰는 열은 읽지 않는다', async () => {
  await withApp(async (app, root) => {
    await setup(app, join(root, 'out'));
    const r = await app.post('/api/g2b/generate', req('types', [
      item(DATA, { meta: { identity: ['a'] } }),
      item({ ...DATA, '추정 가격(원)': '1억' }),
      item({ ...DATA, 원천금액: '확인 중' }),
      item({ ...DATA, 원천금액: '1,234원' }, { meta: { identity: ['b'] } }),
      item({ ...DATA, 원천비고: '확인 중' }, { meta: { identity: ['c'] } }),
    ], { types: { '추정 가격(원)': 'text', 원천금액: 'money', '사업명': 'text' } }));
    assert.deepEqual(r.body.warnings, []);
    assert.deepEqual(r.body.results.map((x: any) => x.code ?? x.status), ['success', 'INVALID_FIELDS', 'success', 'success', 'success']);
    assert.deepEqual(r.body.results[1].invalidFields, [{ field: '추정 가격(원)', type: 'money' }], '서식이 money이면 요청의 text를 따르지 않는다');
    for (const x of r.body.results) assert.deepEqual(x.warnings.map((w: any) => [w.code, w.field]), [['TYPE_MISMATCH', '추정 가격(원)']]);
    assert(texts(readFileSync(r.body.results[0].path)).join('\n').includes('150,000,000'), '서식 타입(money)으로 꾸민다');
  });
});

test('빈 값: null·빈 글은 빈 값, allowEmpty에 없으면 MISSING_FIELDS, 없는 열·null도 allowEmpty면 빈 값, 서식이 안 쓰는 열은 무시 + 경고, 읽을 수 없는 값이 먼저', async () => {
  await withApp(async (app, root) => {
    await setup(app, join(root, 'out'));
    const r = await app.post('/api/g2b/generate', req('empty', [
      item({ ...DATA, 담당자: null }),
      item({ ...DATA, 담당자: '' }),
      item(without('담당자'), { allowEmpty: ['담당자'], meta: { identity: ['omit'] } }),
      item({ ...DATA, 담당자: null }, { allowEmpty: ['담당자'], meta: { identity: ['null'] } }),
      item({ ...DATA, 담당자: '' }, { allowEmpty: ['담당자', '원천열'], meta: { identity: ['unused'] } }),
      item({ ...without('담당자'), '추정 가격(원)': 'abc' }),
      item({ ...DATA, '추정 가격(원)': 'abc' }, { allowEmpty: ['추정 가격(원)'] }),
      item({ ...DATA, '추정 가격(원)': '   ' }),
    ]));
    assert.deepEqual(r.body.results.map((x: any) => x.code ?? x.status), ['MISSING_FIELDS', 'MISSING_FIELDS', 'success', 'success', 'success', 'INVALID_FIELDS', 'INVALID_FIELDS', 'MISSING_FIELDS']);
    assert.deepEqual(r.body.results[0].missingFields, ['담당자']); assert.deepEqual(r.body.results[1].missingFields, ['담당자']);
    assert.deepEqual(r.body.results[7].missingFields, ['추정 가격(원)'], 'text 밖 타입은 공백뿐인 글도 빈 값');
    assert.equal(r.body.results[5].missingFields, undefined, '읽을 수 없는 값이 빈 값보다 먼저'); assert.deepEqual(r.body.results[5].invalidFields, [{ field: '추정 가격(원)', type: 'money' }]);
    assert.deepEqual(r.body.results[4].warnings.map((w: any) => [w.code, w.field]), [['ALLOW_EMPTY_UNUSED', '원천열']]);
    assert.equal(r.body.results[2].warnings, undefined);
    const outs = [2, 3, 4].map(i => readFileSync(r.body.results[i].path));
    assert.deepEqual(outs[0], outs[1]); assert.deepEqual(outs[0], outs[2]);
    const all = texts(outs[0]!).join('\n'); assert(!all.includes('{{') && !all.includes('홍길동'));
    assert.equal(r.body.summary.needsInput, 5); assert.equal(r.body.summary.succeeded, 3);
  });
});

test('분기: 조건 자동 선택, 못 정하면 UNDECIDED와 후보, selections로 풀기(조건과 달라도 수동 선택), 없는 블록은 다시 고르기, 모르는 분기 이름은 경고', async () => {
  await withApp(async (app, root) => {
    await setup(app, join(root, 'out'));
    const r = await app.post('/api/g2b/generate', req('branch', [
      { values: DATA },
      item(DATA, { selections: { '제출 서류': 'b5' }, meta: { identity: ['b5'] } }),
      item(DATA, { selections: { '제출 서류': 'b9' } }),
      item(DATA, { selections: { '제출 서류': 'b4', '참가 자격': 'b2', '없는 분기': 'b1' }, meta: { identity: ['manual'] } }),
      item(DATA, { selections: { '제출 서류': 'b1' } }),
    ]));
    const [auto, b5, missing, manual, other] = r.body.results;
    assert.equal(auto.code, 'UNDECIDED');
    assert.deepEqual(auto.undecided, [{ slot: '제출 서류', reason: 'tie', candidates: [{ block: 'b4', label: '기본 서류' }, { block: 'b5', label: '공동 수급 서류' }] }]);
    assert.equal(b5.status, 'success');
    const b5Text = texts(readFileSync(b5.path)).join('\n'); assert(b5Text.includes('공동 수급 협정서 1부') && !b5Text.includes('법인 인감증명서 1부'));
    assert(b5Text.includes('최근 3년 안에 한 건에 5천만 원 이상'), '참가 자격은 조건(1억 이상)으로 b1');
    assert.equal(missing.code, 'UNDECIDED'); assert.equal(missing.undecided[0].reason, 'blockMissing'); assert.equal(missing.undecided[0].candidates.length, 2);
    assert.equal(other.code, 'UNDECIDED', '다른 분기의 블록은 고를 수 없다');
    assert.equal(manual.status, 'success'); assert.deepEqual(manual.warnings.map((w: any) => [w.code, w.field]), [['SELECTION_UNKNOWN_SLOT', '없는 분기']]);
    assert(texts(readFileSync(manual.path)).join('\n').includes('실적 제한 없이 가나다 사업에 참가할 수 있습니다'), '수동 선택(b2)이 조건(b1)을 이긴다');
  });
});

test('재시도: 처리 중이면 같은 응답, 끝난 뒤 reused, 재시작 뒤에도, 파일이 없으면 기록된 판으로 같은 경로에, 다른 파일이면 OUTPUT_ERROR, 다른 지문은 409', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-retry-')), database = join(root, 'test.sqlite'), dir = join(root, 'out');
  let app = await start(database);
  try {
    await setup(app, dir);
    const body = req('retry', [item(DATA, { meta: { identity: ['R', '1'] } }), item(DATA, { meta: { identity: ['R', '2'] } }), { values: DATA }]);
    const [a, b] = await Promise.all([app.post('/api/g2b/generate', body), app.post('/api/g2b/generate', body)]);
    assert.deepEqual(a.body, b.body, '처리 중인 같은 요청은 같은 응답(걸린 시간까지)');
    assert.deepEqual(a.body.results.map((x: any) => x.reused), [false, false, undefined]);
    const paths = a.body.results.slice(0, 2).map((x: any) => x.path), bytes = paths.map((p: string) => readFileSync(p));
    assert.equal(outputs(dir).length, 2);
    wholeError(await app.post('/api/g2b/generate', req('retry', [item(DATA, { meta: { identity: ['R', '1'] } })])), 409, 'REQUEST_CONFLICT', 'retry');
    await app.close(); app = await start(database);
    const replay = await app.post('/api/g2b/generate', body);
    assert.deepEqual(replay.body.results.map((x: any) => [x.status, x.path, x.reused]), [['success', paths[0], true], ['success', paths[1], true], ['needs-input', undefined, undefined]]);
    assert.deepEqual(replay.body.results[2], a.body.results[2], '입력 필요 건은 기록한 결과 그대로');
    // 프로필을 새 판으로 바꾼 뒤에도 기록된 판으로 다시 만든다
    const v2 = structuredClone(NOTICE.template); v2.version = 2; v2.blocks.find((x: any) => x.id === 'b4').content.text = '바뀐 판의 서류 목록';
    assert.equal((await app.studio('/api/g2b/templates', { ...NOTICE, template: v2 })).http, 200);
    assert.equal((await app.studio('/api/g2b/profiles', { id: 'notice', label: '입찰 공고', templateId: 't0e5a0001', version: 2, outputDirectory: dir })).http, 200);
    unlinkSync(paths[0]);
    const recovered = await app.post('/api/g2b/generate', body);
    assert.deepEqual(recovered.body.results.map((x: any) => [x.status, x.path, x.reused]), [['success', paths[0], false], ['success', paths[1], true], ['needs-input', undefined, undefined]]);
    assert.deepEqual(readFileSync(paths[0]), bytes[0]);
    const fresh = await app.post('/api/g2b/generate', req('new-version', [item(DATA, { meta: { identity: ['R', '3'] } })]));
    assert(texts(readFileSync(fresh.body.results[0].path)).join('\n').includes('바뀐 판의 서류 목록'), '새 요청은 프로필의 새 판');
    writeFileSync(paths[1], '사용자가 바꾼 파일');
    const blocked = await app.post('/api/g2b/generate', body);
    assert.equal(blocked.body.results[1].code, 'OUTPUT_ERROR'); assert.equal(readFileSync(paths[1], 'utf8'), '사용자가 바꾼 파일', '덮어쓰지 않는다');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('처리 중 표·순서(모듈): 같은 번호·같은 지문은 같은 약속, 다른 지문은 409, 동시 요청은 들어온 순서대로 처리', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-order-')), db = new DatabaseSync(':memory:');
  try {
    const g = createG2B2(db); g.saveTemplate(NOTICE); g.saveProfile({ id: 'notice', label: '공고', templateId: 't0e5a0001', version: 1, outputDirectory: root });
    const body = req('same', [item(DATA, { meta: { identity: ['S'] } }), item(DATA, { meta: { identity: ['T'] } })]);
    const p1 = g.generate(body), p2 = g.generate(structuredClone(body));
    assert.equal(p1, p2);
    assert.throws(() => g.generate(req('same', [item(DATA, { meta: { identity: ['다름'] } })])), (e: any) => e.status === 409 && e.code === 'REQUEST_CONFLICT');
    // 같은 이름(identity)에 다른 내용 세 건을 동시에 보내면 들어온 순서대로 이름이 붙는다
    const done: string[] = [];
    const sends = ['가', '나', '다'].map((who, i) => g.generate(req(`order-${i}`, [item({ ...DATA, 담당자: who }, { meta: { identity: ['같은', '이름'] } })])).then(r => { done.push(`order-${i}`); return r; }));
    const replies = await Promise.all([p1, ...sends]);
    assert.deepEqual(done, ['order-0', 'order-1', 'order-2']);
    assert.deepEqual(replies.slice(1).map(r => r.results[0]!.path!.slice(root.length + 1)), ['같은_이름_입찰 공고 예시.hwpx', '같은_이름_입찰 공고 예시-2.hwpx', '같은_이름_입찰 공고 예시-3.hwpx']);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('dryRun: 파일·기록 없음, path·reused만 빠진 같은 답장, 같은 번호를 나중에 실제 생성에 쓴다', async () => {
  await withApp(async (app, root) => {
    const dir = join(root, 'out'); await setup(app, dir);
    const items = [item(DATA, { meta: { identity: ['D'] } }), { values: DATA }, item({ ...DATA, 담당자: null })];
    const dry = await app.post('/api/g2b/generate', req('dry', items, { dryRun: true, columns: [{ key: '사업명', label: '사업명', type: 'text' }] }));
    assert.deepEqual(outputs(dir), []);
    const db = new DatabaseSync(join(root, 'test.sqlite'));
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM g2b2_request').get()!['n'], 0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM g2b2_item').get()!['n'], 0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM g2b_label_helper').get()!['n'], 0); } finally { db.close(); }
    const real = await app.post('/api/g2b/generate', req('dry', items));
    const strip = (r: any) => ({ ...r, summary: { ...r.summary, timings: r.summary.timings.map((t: any) => t.itemIndex), totalMs: 0 }, results: r.results.map(({ path: _p, reused: _r, ...rest }: any) => rest) });
    assert.deepEqual(strip(dry.body), strip(real.body));
    assert.equal(dry.body.results[0].path, undefined); assert.equal(typeof real.body.results[0].path, 'string');
    assert.deepEqual(outputs(dir), ['D_입찰 공고 예시.hwpx']);
  });
});

test('기록: 요청 번호·지문·서식 id·판·결과·경로·파일 해시만. 값·파일 바이트는 기록에 없다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-ledger-')), database = join(root, 'test.sqlite'), app = await start(database);
  let first: Sent;
  try {
    await setup(app, join(root, 'out'));
    const marked = { ...DATA, 사업명: 'VALUE-MARK-사업', 담당자: 'VALUE-MARK-담당', '추가 안내': 'VALUE-MARK-안내\n둘째 줄', 원천비밀: 'VALUE-MARK-원천' };
    first = await app.post('/api/g2b/generate', req('ledger', [item(marked, { meta: { identity: ['L'] } }), { values: marked }, item({ ...marked, '추정 가격(원)': 'VALUE-MARK-금액' }), item({ ...marked, 연락처: null })]));
    assert.equal(first.body.status, 'partial'); assert(!JSON.stringify(first.body).includes('VALUE-MARK'), '응답 메시지에도 값이 없다');
  } finally { await app.close(); }
  try {
    const db = new DatabaseSync(database);
    try {
      assert.deepEqual(db.prepare('PRAGMA table_info(g2b2_request)').all().map(c => c['name']), ['request_id', 'fingerprint', 'template_id', 'template_version']);
      assert.deepEqual(db.prepare('PRAGMA table_info(g2b2_item)').all().map(c => c['name']), ['request_id', 'item_index', 'status', 'code', 'path', 'sha256', 'result']);
      const rows = db.prepare('SELECT * FROM g2b2_item ORDER BY item_index').all();
      assert.deepEqual(rows.map(x => x['status']), ['success', 'needs-input', 'needs-input', 'needs-input']);
      assert.equal(rows[0]!['sha256'], sha(readFileSync(String(rows[0]!['path']))));
      for (const x of rows) for (const k of Object.keys(JSON.parse(String(x['result'])))) assert(['itemIndex', 'status', 'path', 'reused', 'code', 'message', 'missingFields', 'invalidFields', 'undecided', 'warnings'].includes(k), k);
      // 덩어리 표에는 서식 판의 원본과 조각만 있고 만든 문서는 없다
      const output = readFileSync(first.body.results[0].path);
      assert.deepEqual(db.prepare('SELECT sha256 FROM g2b_blob ORDER BY sha256').all().map(x => x['sha256']), [NOTICE.template.source.sha256, ...Object.keys(NOTICE.blobs)].sort());
      assert(!readFileSync(database).includes(Buffer.from(output.toString('base64').slice(0, 64))), 'DB 파일에 출력 바이트(base64)가 없다');
    } finally { db.close(); }
    assert(!readFileSync(database).includes(Buffer.from('VALUE-MARK')), 'DB 파일에 값이 없다');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('파일 이름: 프로필 규칙, identity가 비면 g2b-<해시>-<순번>, 금지 글자 _·앞뒤 공백·점 제거, 같은 해시는 재사용·다르면 -2, 이름은 첫 처리 때 기록', async () => {
  // 규칙 자체(독립 기대값)
  const meta = (identity: string[], extra = {}) => ({ identity, ...extra });
  assert.equal(fileBase('{identity[0]}_{identity[1]}_{서식명}', meta(['2026-0001', '00']), '입찰 공고', 'r', 0), '2026-0001_00_입찰 공고');
  assert.equal(fileBase('{identity[0]}_{서식명}', meta([]), '입찰 공고', 'req-1', 4), `g2b-${sha('req-1').slice(0, 10)}-5`);
  assert.equal(fileBase('{identity[0]}_{서식명}', meta(['  ']), '입찰 공고', 'req-1', 0), `g2b-${sha('req-1').slice(0, 10)}-1`);
  assert.equal(fileBase('{identity}', meta([' .a<b>c:d"e/f\\g|h?i*j\u0001k. ', '2']), '서식', 'r', 0), 'a_b_c_d_e_f_g_h_i_j_k. _2');
  assert.equal(fileBase('{서식명}', meta(['x']), '. 서식 .', 'r', 0), '서식');
  assert.equal(fileBase('{stage}-{recordId}-{identity[5]}', meta(['x'], { stage: '접수', recordId: '77' }), '서식', 'r', 0), '접수-77-');
  assert.equal(fileBase('{identity}', meta(['CON']), '서식', 'r', 0), 'CON_');
  assert.equal([...fileBase('{identity}', meta(['가'.repeat(300)]), '서식', 'r', 0)].length, 120);
  await withApp(async (app, root) => {
    const dir = join(root, 'out'); await setup(app, dir, { fileName: '{identity[0]}_{identity[1]}_{서식명}' });
    const named = [
      item(DATA, { meta: { identity: ['2026-0001', '00'] } }),
      item(DATA, { meta: { identity: ['2026-0001', '00'] } }),
      item({ ...DATA, 담당자: '다른 담당' }, { meta: { identity: ['2026-0001', '00'] } }),
      item({ ...DATA, 담당자: '또 다른 담당' }, { meta: { identity: ['2026-0001', '00'] } }),
      item(DATA),
      item(DATA, { meta: { identity: ['. a/b', ' 1'] } }),
    ];
    const r = await app.post('/api/g2b/generate', req('names', named));
    const names = r.body.results.map((x: any) => [x.path.slice(dir.length + 1), x.reused]);
    assert.deepEqual(names, [
      ['2026-0001_00_입찰 공고 예시.hwpx', false], ['2026-0001_00_입찰 공고 예시.hwpx', true],
      ['2026-0001_00_입찰 공고 예시-2.hwpx', false], ['2026-0001_00_입찰 공고 예시-3.hwpx', false],
      [`g2b-${sha('names').slice(0, 10)}-5.hwpx`, false], ['a_b_ 1_입찰 공고 예시.hwpx', false],
    ]);
    // 규칙을 바꿔도 끝난 요청은 기록한 이름을 쓴다
    assert.equal((await app.studio('/api/g2b/profiles', { id: 'notice', label: '입찰 공고', templateId: 't0e5a0001', version: 1, outputDirectory: dir, fileName: '새규칙_{identity}' })).http, 200);
    unlinkSync(join(dir, '2026-0001_00_입찰 공고 예시-2.hwpx'));
    const again = await app.post('/api/g2b/generate', req('names', named));
    assert.deepEqual(again.body.results.map((x: any) => x.path), r.body.results.map((x: any) => x.path));
    assert.equal(again.body.results[2].reused, false); assert(existsSync(join(dir, '2026-0001_00_입찰 공고 예시-2.hwpx')));
    assert(!readdirSync(dir).some(n => n.startsWith('새규칙')));
    assert.equal(readdirSync(dir).filter(n => n.endsWith('.tmp')).length, 0);
  });
});

test('columns: 라벨 사전의 Helper 층을 통째로 바꾸고(없으면 그대로, dryRun은 안 바꿈), 다른 저장(학습 층 등)은 바꾸지 않는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-labels-')), db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE studio_learned (template TEXT, label TEXT, key TEXT, type TEXT); INSERT INTO studio_learned VALUES (\'t0e5a0001\', \'사업명\', \'사업명\', \'text\')');
    const g = createG2B2(db); g.saveTemplate(NOTICE); g.saveProfile({ id: 'notice', label: '공고', templateId: 't0e5a0001', version: 1, outputDirectory: root });
    const learned = () => JSON.stringify(db.prepare('SELECT * FROM studio_learned').all());
    const before = learned();
    const A = [{ key: '사업명', label: '사업 이름', type: 'text', stages: ['공고'] }, { key: '추정 가격(원)', label: '추정 가격', type: 'money', codes: { Y: '예' } }];
    const B = [{ key: 'lcnsLmtYn', label: '업종 제한', type: 'boolean' }];
    await g.generate(req('l1', [item(DATA, { meta: { identity: ['1'] } })], { columns: A })); assert.deepEqual(g.labels(), A);
    await g.generate(req('l2', [item(DATA, { meta: { identity: ['2'] } })], { columns: B })); assert.deepEqual(g.labels(), B, '합치지 않고 통째로');
    await g.generate(req('l3', [item(DATA, { meta: { identity: ['3'] } })])); assert.deepEqual(g.labels(), B, 'columns가 없으면 그대로');
    await g.generate(req('l4', [item(DATA)], { columns: A, dryRun: true })); assert.deepEqual(g.labels(), B, 'dryRun은 바꾸지 않는다');
    await g.generate(req('l5', [item(DATA, { meta: { identity: ['5'] } })], { columns: [] })); assert.deepEqual(g.labels(), []);
    assert.equal(learned(), before);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('엔진 코드 → 창구 이름, Studio 설정 원인(연결 겹침·서식 다시 확인·프로필), 1판 프로필은 2판 요청에 PROFILE_INVALID', async () => {
  for (const [codes, want] of [
    [['DATA_MISSING'], 'MISSING_FIELDS'], [['DATA_FORMAT'], 'INVALID_FIELDS'], [['DATA_NOT_SCALAR'], 'INVALID_FIELDS'], [['VALUE_CONTROL_CHAR'], 'INVALID_FIELDS'],
    [['DATA_ALIAS_CONFLICT', 'DATA_FORMAT'], 'PROFILE_MAPPING_CONFLICT'], [['SEL_UNDECIDED'], 'UNDECIDED'], [['SEL_EXCLUSIVE'], 'UNDECIDED'], [['SEL_RECHECK'], 'TEMPLATE_RECHECK'],
    [['TPL_SOURCE_MISMATCH'], 'TEMPLATE_RECHECK'], [['TPL_FRAGMENT_MISSING'], 'TEMPLATE_RECHECK'], [['ANCHOR_NOT_FOUND'], 'TEMPLATE_RECHECK'], [['PLACE_UNREGISTERED'], 'TEMPLATE_RECHECK'],
    [['FRAG_SCHEMA'], 'TEMPLATE_RECHECK'], [['GATE_NEW_ERRORS'], 'GENERATION_FAILED'], [['FILL_SKIPPED'], 'GENERATION_FAILED'], [['PKG_NOT_ZIP'], 'GENERATION_FAILED'],
  ] as const) assert.equal(windowCode(codes), want, codes.join());
  await withApp(async (app, root) => {
    const dir = join(root, 'out'); await setup(app, dir);
    // 연결 겹침: 같은 값의 열(추정 가격(원))과 별칭(추정가격)에 함께 값 → Studio 설정 원인(재전송 불가)
    const both = await app.post('/api/g2b/generate', req('alias', [item({ ...DATA, 추정가격: 1 })]));
    assert.deepEqual([both.body.status, both.body.results[0].code], ['error', 'PROFILE_MAPPING_CONFLICT']);
    assert(both.body.results[0].message.includes('추정 가격(원)') && both.body.results[0].message.includes('추정가격'));
    // 서식 다시 확인: 등록하지 않은 {{연락처}}가 남는 판
    const t3 = structuredClone(NOTICE.template); t3.id = 't0e5a0003'; t3.places = t3.places.filter((p: any) => p.key !== '연락처');
    assert.equal((await app.studio('/api/g2b/templates', { ...NOTICE, template: t3 })).http, 200);
    assert.equal((await app.studio('/api/g2b/profiles', { id: 'recheck', label: '다시 확인', templateId: 't0e5a0003', version: 1, outputDirectory: dir })).http, 200);
    const recheck = await app.post('/api/g2b/generate', { ...req('recheck', [item()]), profileId: 'recheck' });
    assert.deepEqual([recheck.body.status, recheck.body.results[0].code], ['error', 'TEMPLATE_RECHECK']); assert(recheck.body.results[0].message.includes('PLACE_UNREGISTERED · {{연락처}}'));
    // 프로필: 출력 폴더가 사라짐 → 모든 건 PROFILE_INVALID(기록하지 않아 Studio에서 고친 뒤 같은 번호로 다시 보낼 수 있다)
    const gone = join(root, 'gone'); assert.equal((await app.studio('/api/g2b/profiles', { id: 'gone', label: '사라질 폴더', templateId: 't0e5a0001', version: 1, outputDirectory: gone })).http, 200);
    rmSync(gone, { recursive: true });
    const lost = await app.post('/api/g2b/generate', { ...req('lost', [item(), item()]), profileId: 'gone' });
    assert.deepEqual(lost.body.results.map((x: any) => x.code), ['PROFILE_INVALID', 'PROFILE_INVALID']); assert.equal(lost.body.status, 'error');
    // 1판 프로필(저장 프로젝트를 가리킴)은 2판 요청에 쓸 수 없다
    const db = new DatabaseSync(join(root, 'test.sqlite'));
    try { db.prepare('INSERT INTO g2b_profile(id,document) VALUES (?,?)').run('old', JSON.stringify({ id: 'old', label: '1판', revisionId: 1, outputDirectory: dir })); } finally { db.close(); }
    const old = await app.post('/api/g2b/generate', { ...req('old', [item()]), profileId: 'old' });
    assert.equal(old.body.results[0].code, 'PROFILE_INVALID');
    assert.deepEqual((await app.get('/api/g2b/profiles')).body.profiles.find((p: any) => p.id === 'old'), { id: 'old', label: '1판', revisionId: 1, outputDirectory: dir }, '1판 프로필은 1판 꼴 그대로 보인다');
  });
});

// ── 합성 서식: 자리 수십 개와 분기 하나 ──────────────────────────

const BODY = [
  '가. 사업명: {{사업명}} / 공고 번호: {{ 공고 번호 }}',
  '나. 추정가격 금 {{추정가격}}원정, 예정가격 {{예정가격}}',
  '다. 낙찰 하한율 {{하한율}}% / 마감 {{마감일시}} / 공고일 {{공고일}}',
  '라. 담당 {{담당자}} ({{연락처}}) · 기관 {{기관.이름}} · 비고 {{비고 (참고)}}',
  '바. 업종 조항 자리',
  '사. 설명: {{설명}}',
];
const CELL = ['{{추정가격}}원', '{{공고일}}', '{{사업명}}', '{{수량}}개', '{{기관.이름}}'];
const HEAD = ['머리말 {{사업명}} / {{공고일}} / {{ 공고 번호 }}'];
const TYPES: Record<string, ValueFormat> = {
  추정가격: 'money', 예정가격: 'money', 부가세: 'money', 하한율: 'percent', 마감일시: 'datetime', 공고일: 'date', 시행일: 'date', 수량: 'number',
  재공고: 'boolean', 업종제한: 'boolean', 'project.start': 'date', 'project.end': 'date', 'dates.start': 'date', 'dates.end': 'date', 'dates.days': 'number',
};
const RAW: Record<Exclude<ValueFormat, 'text'>, unknown[]> = {
  money: [1234000, '1,234,000', '금 1,234,000원정', '₩5,000', '△300', '1234.50', '99999999999999999999', '0', -1234],
  percent: [12.5, '87.745%', '-3', '100 %', '0.0'],
  number: ['1,234', 7, '0.50', '-12', '123456789012345678901234567890'],
  date: ['20261009', '2026-10-09', '2026/1/5', '2026. 10. 9.', '2024-02-29'],
  datetime: ['2026-10-09 14:30', '2026-10-09T09:05:07', '20261009 9:05', '2026. 10. 09. 23:59'],
  boolean: [true, false, 'Y', 'n', '예', '아니오'],
};

let synthetic: { bytes: Uint8Array; t: StudioTemplate } | undefined;
function syntheticTemplate() {
  if (synthetic !== undefined) return synthetic;
  const base = readFixture('merge/merge-fields'), d0 = reparse(base);
  const built = generate(base, tpl([line(d0, 'end', [16]), line(d0, 'cell', [12, 1, 0]), line(d0, 'head', [0, 0, 0])],
    [insertText('body', 'end', BODY.join('\n'), 'after'), insertText('cellp', 'cell', CELL.join('\n'), 'after'), insertText('headp', 'head', HEAD.join('\n'), 'after')]), ds({}), KEEP);
  assert(built.ok && !built.dryRun);
  const bytes = built.output, doc = reparse(bytes);
  const loose = new Set<string>(), paragraphs = doc.sections.flatMap(s => [...walkParagraphs(s.paragraphs)]);
  for (const p of paragraphs) for (const h of findLooseKeys(p.logicalText)) loose.add(h.key);
  const fields = listFields(doc);
  const merge = [...new Set(fields.flatMap(f => f.type === 'MAILMERGE' && f.mergeKey ? [f.mergeKey] : []))];
  const click = [...new Set(fields.flatMap(f => f.type === 'CLICK_HERE' && f.name ? [f.name] : []))];
  const names = [...new Set([...loose, ...merge, ...click, '업종', '업종제한'])].sort();
  const vid = new Map(names.map((n, i) => [n, `v${i + 1}`]));
  const slotLine = paragraphs.findIndex(p => p.logicalText === '바. 업종 조항 자리');
  let n = 0;
  const raw = {
    schema: 'hwpx-studio/template@2', id: 't00000133', version: 1, meta: { name: '합성 공고(#133)' }, source: { kind: 'hwpx', sha256: sha(bytes) },
    anchors: [{ ...line(doc, 'a1', paragraphs[slotLine]!.path), id: 'a1' }],
    values: names.map(name => ({ id: vid.get(name), name, format: TYPES[name] ?? 'text' })),
    bindings: names.map(name => ({ value: vid.get(name), key: name })),
    places: [
      ...[...loose].sort().map(key => ({ id: `p${++n}`, kind: 'placeholder', key, value: vid.get(key) })),
      { id: `p${++n}`, kind: 'placeholder', key: '업종', value: vid.get('업종'), where: 'b1' },
      ...merge.sort().map(key => ({ id: `p${++n}`, kind: 'mailMerge', key, value: vid.get(key) })),
      ...click.sort().map(name => ({ id: `p${++n}`, kind: 'clickHere', name, value: vid.get(name) })),
    ],
    slots: [{ id: 's1', name: '업종 제한', anchors: ['a1'], parent: null }],
    blocks: [
      { id: 'b1', slot: 's1', name: '업종 제한 있음', content: { text: '바. 업종 제한: {{업종}} 업종을 등록한 업체만 참가할 수 있습니다.' }, when: { path: vid.get('업종제한'), op: 'eq', value: true } },
      { id: 'b2', slot: 's1', name: '업종 제한 없음', content: { text: '바. 업종 제한 없이 누구나 참가할 수 있습니다.' } },
    ],
    options: { missing: 'error', unregistered: 'error' },
  };
  const t = readStudioTemplate(JSON.stringify(raw)) as StudioTemplate;
  synthetic = { bytes, t };
  return synthetic;
}
/** 한 건: 글 열은 긴 값(여러 문장·줄바꿈·탭·XML 특수문자), 타입 열은 7종 원래 값, 그 밖에 서식이 안 쓰는 원천 열 */
function syntheticItem(t: StudioTemplate, next: () => number, i: number) {
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;
  const values: Record<string, unknown> = { 원천_기타: `원천 ${i}`, 원천_숫자: i, 원천_참거짓: i % 2 === 0, 원천_빈값: null };
  for (const v of t.values) values[v.name] = v.format === 'text' ? `${v.name} ${i}: ${longValue(next, 200, 500)}\n둘째 문장 & <확인> "인용".\t탭 뒤` : pick(RAW[v.format]);
  return { values, meta: { identity: [`SYN-${String(i).padStart(3, '0')}`, '00'], stage: '공고', recordId: `rec-${i}` } };
}

test('합성 서식 무작위 50건(요청 하나에 같은 건 두 번 = 100건): 자리 수십 개·긴 값, 결정성(같은 해시라 재사용)·검사기 새 오류 0·최상위 경고 0, 처리 시간', async t => {
  const { bytes, t: template } = syntheticTemplate();
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-syn-')), db = new DatabaseSync(':memory:');
  try {
    const g = createG2B2(db);
    g.saveTemplate({ template: JSON.parse(JSON.stringify(template)), source: Buffer.from(bytes).toString('base64') });
    g.saveProfile({ id: 'syn', label: '합성', templateId: 't00000133', version: 1, outputDirectory: root, fileName: '{identity[0]}_{identity[1]}_{서식명}' });
    const next = rng(0x133a), items = Array.from({ length: 50 }, (_, i) => syntheticItem(template, next, i));
    const types = Object.fromEntries(template.values.map(v => [v.name, v.format]));
    const reply = await g.generate({ format: 'studio-generate', version: 2, requestId: 'syn-100', profileId: 'syn', types: { ...types, 원천_숫자: 'number' }, items: [...items, ...structuredClone(items)] });
    assert.deepEqual(reply.warnings, []); assert.equal(reply.summary.succeeded, 100, JSON.stringify(reply.results.find(r => r.status !== 'success')));
    assert.equal(reply.summary.timings.length, 100);
    const occurrences = texts(bytes).reduce((k, s) => k + findLooseKeys(s).length, 0) + listFields(parseDocument(openPackage(bytes))).length;
    assert(template.places.length >= 40 && occurrences >= 80, `자리 ${template.places.length}개, 곳 ${occurrences}`);
    let checked = 0, errors = 0, b1 = 0, b2 = 0, longValues = 0;
    for (let i = 0; i < 50; i++) {
      const a = reply.results[i]!, again = reply.results[i + 50]!;
      assert.equal(a.reused, false); assert.equal(again.reused, true, '같은 값 → 같은 바이트 → 같은 이름 재사용'); assert.equal(again.path, a.path);
      assert.equal(a.warnings, undefined);
      const out = new Uint8Array(readFileSync(a.path!)), all = texts(out).join('\n');
      const e = newErrors(bytes, out); errors += e.length; assert.deepEqual(e, []);
      assert(!all.includes('{{'), `${i}: 남은 자리`);
      const v = items[i]!.values;
      for (const key of ['사업명', '설명', '기관.이름', '비고 (참고)', '공고 번호', '담당자']) { assert(all.includes(String(v[key])), `${i}: ${key}`); longValues++; }
      for (const f of listFields(parseDocument(openPackage(out))).filter(f => f.type === 'MAILMERGE' && (TYPES[f.mergeKey ?? ''] ?? 'text') === 'text')) assert.equal(f.valueText, v[f.mergeKey!]);
      const flag = ['Y', '예', true].includes(v['업종제한'] as never);
      if (flag) { assert(all.includes(`바. 업종 제한: ${v['업종']} 업종을 등록한`)); b1++; } else { assert(all.includes('바. 업종 제한 없이 누구나')); b2++; }
      checked++;
    }
    assert.equal(outputs(root).length, 50);
    assert.equal(checked, 50); assert.equal(errors, 0); assert(b1 > 0 && b2 > 0);
    t.diagnostic(`seed=0x133a; items=100(50 random x2); values=${template.values.length}; places=${template.places.length}; occurrences=${occurrences}; slot b1/b2=${b1}/${b2}; long_values_checked=${longValues}; new_errors=0; top_warnings=0; reused=50; totalMs=${reply.summary.totalMs}; avgMs=${Math.round(reply.summary.totalMs / 100)}`);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('분기 값: 조건에만 쓰는 열이 비면 UNDECIDED(valueMissing)와 그 열·후보, allowEmpty면 빈 값으로 판정, 확정이 필요한 서식은 needConfirm 후보', async () => {
  const { t } = syntheticTemplate();
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-cond-')), db = new DatabaseSync(':memory:');
  try {
    const g = createG2B2(db), raw = JSON.parse(JSON.stringify(t)), source = Buffer.from(syntheticTemplate().bytes).toString('base64');
    g.saveTemplate({ template: raw, source }); g.saveTemplate({ template: { ...raw, id: 't00000134', options: { ...raw.options, requireConfirm: true } }, source });
    g.saveProfile({ id: 'syn', label: '합성', templateId: 't00000133', version: 1, outputDirectory: root });
    g.saveProfile({ id: 'confirm', label: '확정 필요', templateId: 't00000134', version: 1, outputDirectory: root });
    const base = syntheticItem(t, rng(0x133c), 0).values, rest = Object.fromEntries(Object.entries(base).filter(([k]) => k !== '업종제한'));
    const send = (profileId: string, requestId: string, items: unknown[]) => g.generate({ format: 'studio-generate', version: 2, requestId, profileId, items });
    const r = await send('syn', 'cond', [
      { values: rest }, { values: { ...rest, 업종제한: '' } },
      { values: rest, allowEmpty: ['업종제한'], meta: { identity: ['빈값'] } },
      { values: { ...rest, 업종제한: 'Y' }, selections: { '업종 제한': 'b2' }, meta: { identity: ['수동'] } },
    ]);
    const undecided = { code: 'UNDECIDED', undecided: [{ slot: '업종 제한', reason: 'valueMissing', candidates: [{ block: 'b1', label: '업종 제한 있음' }], fields: ['업종제한'] }] };
    assert.deepEqual(r.results.slice(0, 2).map(x => ({ code: x.code, undecided: x.undecided })), [undecided, undecided]);
    for (const x of r.results.slice(2)) { assert.equal(x.status, 'success'); assert(texts(readFileSync(x.path!)).join('\n').includes('바. 업종 제한 없이 누구나')); }
    const c = await send('confirm', 'confirm', [{ values: { ...rest, 업종제한: 'Y' } }, { values: { ...rest, 업종제한: 'Y' }, selections: { '업종 제한': 'b1' }, meta: { identity: ['확정'] } }]);
    assert.deepEqual(c.results[0]!.undecided, [{ slot: '업종 제한', reason: 'needConfirm', candidates: [{ block: 'b1', label: '업종 제한 있음' }] }]);
    assert.equal(c.results[1]!.status, 'success'); assert(texts(readFileSync(c.results[1]!.path!)).join('\n').includes(`바. 업종 제한: ${rest['업종']} 업종을 등록한`));
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('#196 배타: 함께 고를 수 없는 두 분기가 모두 조건 블록이면 UNDECIDED(exclusive, 결정 열·두 분기의 후보), selections로 한쪽을 기본 블록으로 고르면 성공', async () => {
  const { t, bytes } = syntheticTemplate();
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-excl-')), db = new DatabaseSync(':memory:');
  try {
    const doc = reparse(bytes), raw = JSON.parse(JSON.stringify(t));
    const path = doc.sections[0]!.paragraphs.find(p => p.logicalText === '사. 설명: {{설명}}')!.path;
    const rate = t.values.find(v => v.name === '하한율')!.id;
    raw.id = 't00000196'; raw.anchors.push({ ...line(doc, 'a2', path), id: 'a2' });
    raw.slots.push({ id: 's2', name: '설명 조항', anchors: ['a2'], parent: null });
    raw.blocks.push({ id: 'b3', slot: 's2', name: '하한율 높음', content: { text: '사. 설명: {{설명}} (하한율 높음)' }, when: { path: rate, op: 'ge', value: 80 } }, { id: 'b4', slot: 's2', name: '기본 설명', content: { text: '사. 설명: {{설명}}' } });
    raw.exclusive = [['s1', 's2']];
    const g = createG2B2(db);
    g.saveTemplate({ template: raw, source: Buffer.from(bytes).toString('base64') });
    g.saveProfile({ id: 'excl', label: '배타', templateId: 't00000196', version: 1, outputDirectory: root });
    const values: Record<string, unknown> = { ...syntheticItem(t, rng(0x196), 0).values, 업종제한: 'Y', 하한율: '87.745%' };
    const r = await g.generate({ format: 'studio-generate', version: 2, requestId: 'excl', profileId: 'excl', items: [{ values }, { values, selections: { '설명 조항': 'b4' }, meta: { identity: ['풀기'] } }] });
    assert.deepEqual({ status: r.results[0]!.status, code: r.results[0]!.code, undecided: r.results[0]!.undecided }, {
      status: 'needs-input', code: 'UNDECIDED', undecided: [
        { slot: '업종 제한', reason: 'exclusive', candidates: [{ block: 'b1', label: '업종 제한 있음' }, { block: 'b2', label: '업종 제한 없음' }], fields: ['업종제한'] },
        { slot: '설명 조항', reason: 'exclusive', candidates: [{ block: 'b3', label: '하한율 높음' }, { block: 'b4', label: '기본 설명' }], fields: ['하한율'] },
      ],
    });
    assert.equal(r.results[1]!.status, 'success');
    const all = texts(readFileSync(r.results[1]!.path!)).join('\n');
    assert(all.includes(`바. 업종 제한: ${values['업종']} 업종을 등록한`) && !all.includes('(하한율 높음)'));
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('서식이 안 쓰는 열은 값이 무엇이든(타입과 안 맞는 값·객체·배열) 무시: 성공, 최상위·건별 경고 0', async () => {
  await withApp(async (app, root) => {
    await setup(app, join(root, 'out'));
    const r = await app.post('/api/g2b/generate', req('unused', [item({ ...DATA, 원천금액: '확인 중', 원천날짜: '2월 30일', 원천객체: { a: 1 }, 원천목록: [1, 2] })], { types: { 원천금액: 'money', 원천날짜: 'date' } }));
    assert.equal(r.body.status, 'success'); assert.deepEqual(r.body.warnings, []); assert.equal(r.body.results[0].warnings, undefined);
  });
});

// ── #173 Helper 프로필 화면 ──────────────────────────────────────

const MAILMERGE = readFileSync(new URL('../../../examples/quick/template-mailmerge.hwpx', import.meta.url));
type Found = { kind: 'clickHere' | 'mailMerge' | 'placeholder'; name: string; type?: 'money' };

test('#173 화면 API: 열린 문서로 만든 서식 판 저장(같은 내용은 같은 판, 바뀌면 다음 판), 프로필 저장·목록·판 고정·다시 확인·삭제(Origin 없으면 403), 그 판으로 50건 생성', async () => {
  await withApp(async (app, root) => {
    // 화면이 하는 그대로: 작업창이 찾은 누름틀·메일머지·{{키}}로 template@2를 만든다
    const opened = await app.post('/api/workbench/open', { name: 'mailmerge.hwpx', content: MAILMERGE.toString('base64') });
    const found: Found[] = opened.body.inputs.map((x: Found) => ({ kind: x.kind, name: x.kind === 'placeholder' ? x.name.trim() : x.name }));
    const id = 't' + sha(MAILMERGE).slice(0, 8), source = MAILMERGE.toString('base64');
    const make = (version: number, list = found) => g2bTemplate(list, { id, version, name: '메일머지 예시', sha256: sha(MAILMERGE) });
    const t1 = readStudioTemplate(JSON.stringify(make(1))) as StudioTemplate;
    const names = [...new Set(found.map(x => x.name))];
    assert.equal(found.length, 45); assert.equal(t1.values.length, names.length); assert.equal(t1.places.length, new Set(found.map(x => x.kind + x.name)).size);
    assert(t1.values.every(v => v.format === 'text'));

    for (const [path, body] of [['/api/g2b/templates', { template: make(1), source }], ['/api/g2b/profiles', { id: 'p-1', label: 'x', templateId: id, version: 1, outputDirectory: root }], ['/api/g2b/profiles/delete', { id: 'p-1' }]] as const)
      assert.equal((await app.post(path, body)).http, 403, path);
    assert.deepEqual((await app.studio('/api/g2b/templates', { template: make(1), source })).body, { template: { id, version: 1, name: '메일머지 예시' } });
    assert.equal((await app.studio('/api/g2b/templates', { template: make(1), source })).http, 200);
    const profile = { id: 'p-1', label: '메일머지 공고', templateId: id, version: 1, outputDirectory: join(root, 'out') };
    assert.equal((await app.studio('/api/g2b/profiles', profile)).http, 200);
    const listed = (await app.get('/api/g2b/profiles')).body.profiles;
    assert.deepEqual(listed, [{ ...profile, outputDirectory: listed[0].outputDirectory }]);

    // 그 판으로 Helper(Origin 없음) 50건: 자리 45곳·값 여럿에 긴 값(여러 문장·줄바꿈·탭·XML 특수문자)
    const next = rng(0x173a);
    const items = Array.from({ length: 50 }, (_, i) => ({ values: Object.fromEntries(names.map(n => [n, `${n} ${i}: ${longValue(next, 200, 500)}\n둘째 문장 & <확인> "인용".\t탭 뒤`])) }));
    const r = await app.post('/api/g2b/generate', { format: 'studio-generate', version: 2, requestId: 'mm-50', profileId: 'p-1', items });
    assert.equal(r.http, 200, JSON.stringify(r.body).slice(0, 500)); assert.equal(r.body.summary.succeeded, 50, JSON.stringify(r.body.results[0]).slice(0, 500)); assert.deepEqual(r.body.warnings, []);
    let errors = 0;
    for (const [i, x] of r.body.results.entries()) {
      const bytes = new Uint8Array(readFileSync(x.path)), all = texts(bytes).join('\n');
      errors += newErrors(new Uint8Array(MAILMERGE), bytes).length;
      assert(!all.includes('{{'), `남은 {{ ${i}`);
      for (const n of names) assert(all.includes(`${n} ${i}: `), `${n} ${i}`);
    }
    assert.equal(errors, 0);

    // 서식이 바뀌면(표에서 한 줄 제외·금액 타입) 1판에는 저장되지 않고(409) 다음 판에 저장된다. 프로필은 다시 확인 전까지 1판
    const changed = found.filter(x => x.name !== '사유 설명').map(x => x.name === '추정가격' ? { ...x, type: 'money' as const } : x);
    wholeError(await app.studio('/api/g2b/templates', { template: make(1, changed), source }), 409, 'REQUEST_CONFLICT');
    assert.equal((await app.studio('/api/g2b/templates', { template: make(2, changed), source })).body.template.version, 2);
    assert.equal((readStudioTemplate(JSON.stringify(make(2, changed))) as StudioTemplate).values.find(v => v.name === '추정가격')!.format, 'money');
    assert.equal((await app.get('/api/g2b/profiles')).body.profiles[0].version, 1);
    assert.equal((await app.studio('/api/g2b/profiles', { ...listed[0], version: 2 })).http, 200);
    assert.equal((await app.get('/api/g2b/profiles')).body.profiles[0].version, 2);
    const money = await app.post('/api/g2b/generate', { format: 'studio-generate', version: 2, requestId: 'mm-v2', profileId: 'p-1', items: [{ values: { ...items[0]!.values, 추정가격: 1234000 } }] });
    assert.equal(money.body.status, 'success'); assert(texts(readFileSync(money.body.results[0].path)).join('\n').includes('1,234,000'));

    // 삭제: 목록에서 빠지고, 없는 id는 deleted false, 틀린 id는 400
    assert.deepEqual((await app.studio('/api/g2b/profiles/delete', { id: 'p-1' })).body, { deleted: true });
    assert.deepEqual((await app.get('/api/g2b/profiles')).body.profiles, []);
    assert.deepEqual((await app.studio('/api/g2b/profiles/delete', { id: 'p-1' })).body, { deleted: false });
    wholeError(await app.studio('/api/g2b/profiles/delete', { id: '../x' }), 400, 'INVALID_REQUEST');
  });
});

test('#173 생성 창구의 403·405·내부 예외(500)도 { code, message } 꼴, 내부 예외 메시지에 SQL·경로 없음', async () => {
  await withApp(async (app, root) => {
    await setup(app, join(root, 'out'));
    wholeError(await app.post('/api/g2b/generate', req('web', [item()]), 'https://public.example'), 403, 'INVALID_REQUEST');
    wholeError(await app.raw('PUT', '/api/g2b/generate', JSON.stringify(req('put', [item()])), { 'Content-Type': 'application/json' }), 405, 'INVALID_REQUEST');
    wholeError(await app.get('/api/g2b/generate'), 405, 'INVALID_REQUEST');
    const side = new DatabaseSync(join(root, 'test.sqlite')); side.exec('DROP TABLE g2b2_request'); side.close();
    const r = await app.post('/api/g2b/generate', req('boom', [item()]));
    wholeError(r, 500, 'GENERATION_FAILED');
    assert(!/g2b2_request|SQL|sqlite|[A-Za-z]:[\\/]/i.test(r.body.message), r.body.message);
  });
});

test('#173 /quick·작업창: 판이 다른 Helper 내보내기 파일은 쉬운 말 "판이 다릅니다"(코드 QUICK_BAD_DATA 그대로)', async () => {
  await withApp(async app => {
    const sentence = 'Helper 내보내기 파일 판이 다릅니다(2판만 받습니다).';
    const quick = await app.post('/api/quick/template', { name: 'mailmerge.hwpx', content: MAILMERGE.toString('base64') });
    const opened = await app.post('/api/workbench/open', { name: 'mailmerge.hwpx', content: MAILMERGE.toString('base64') });
    for (const version of [1, 3, null]) {
      const content = JSON.stringify({ format: 'studio-generate', version, items: [{ values: { 사업명: '가' } }] });
      const r = await app.post('/api/quick/data', { session: quick.body.session, content });
      assert.equal(r.http, 400); assert.equal(r.body.code, 'QUICK_BAD_DATA'); assert.equal(r.body.plain, sentence);
      assert.equal((await app.post('/api/workbench/data', { session: opened.body.session, name: 'helper.json', content })).body.error, sentence);
    }
    const r = await app.post('/api/quick/data', { session: quick.body.session, content: JSON.stringify({ format: 'studio-generate', version: 2, items: {} }) });
    assert.equal(r.body.code, 'QUICK_BAD_DATA'); assert.notEqual(r.body.plain, sentence);
  });
});

// ── #134 등록 안 된 누름틀·메일머지 ───────────────────────────────

const LABEL = { mailMerge: '메일머지', clickHere: '누름틀' } as const;
const unregisteredWarning = (kind: keyof typeof LABEL, name: string, n: number) => ({ code: 'PLACE_UNREGISTERED', field: name, message: `${plainOf('PLACE_UNREGISTERED')} (${LABEL[kind]} ${name} ${n}곳)` });
const byField = <T extends { field?: string }>(ws: readonly T[] = []) => [...ws].sort((a, b) => (a.field! < b.field! ? -1 : a.field! > b.field! ? 1 : 0));

test('#134 2판 창구: 서식에 등록 안 된 누름틀·메일머지는 성공 건마다 건별 PLACE_UNREGISTERED(종류·이름·곳 수), 최상위 경고 0, dryRun도 같은 경고, 무작위 50건 원래 글 그대로·새 오류 0', async ctx => {
  const { bytes, t: full } = syntheticTemplate();
  const fields = listFields(parseDocument(openPackage(bytes)));
  const nameOf = (p: any): string => p.kind === 'clickHere' ? p.name : p.key;
  // 종류마다 이름을 하나 걸러 서식에서 뺀다(정책 생략 = 필드는 경고)
  const dropped = (['mailMerge', 'clickHere'] as const).flatMap(kind => full.places.filter(p => p.kind === kind).map(nameOf).sort().filter((_, i) => i % 2 === 1).map(name => ({ kind, name })));
  const count = (kind: 'mailMerge' | 'clickHere', name: string) => fields.filter(f => kind === 'mailMerge' ? f.type === 'MAILMERGE' && f.mergeKey === name : f.type === 'CLICK_HERE' && f.name === name).length;
  const want = byField(dropped.map(d => unregisteredWarning(d.kind, d.name, count(d.kind, d.name))));
  assert(dropped.some(d => d.kind === 'mailMerge') && dropped.some(d => d.kind === 'clickHere') && want.every(w => !w.message.includes(' 0곳')), JSON.stringify(want));
  const raw = { ...JSON.parse(JSON.stringify(full)), id: 't00000135', options: { missing: 'error' } };
  raw.places = raw.places.filter((p: any) => !dropped.some(d => d.kind === p.kind && d.name === nameOf(p)));
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-unreg-')), db = new DatabaseSync(':memory:');
  try {
    const g = createG2B2(db);
    g.saveTemplate({ template: raw, source: Buffer.from(bytes).toString('base64') });
    g.saveProfile({ id: 'unreg', label: '미등록', templateId: 't00000135', version: 1, outputDirectory: root });
    const next = rng(0x134a), items = Array.from({ length: 50 }, (_, i) => syntheticItem(full, next, i));
    const send = (requestId: string, dryRun: boolean) => g.generate({ format: 'studio-generate', version: 2, requestId, profileId: 'unreg', dryRun, items });
    for (const reply of [await send('unreg-dry', true), await send('unreg', false)]) {
      assert.deepEqual(reply.warnings, []); assert.equal(reply.summary.succeeded, 50, JSON.stringify(reply.results.find(r => r.status !== 'success')));
      for (const r of reply.results) { assert.deepEqual(byField(r.warnings), want); assert(!r.warnings!.some(w => w.message.includes(UNKNOWN_EXPLANATION))); }
    }
    const left = (doc: ReturnType<typeof parseDocument>) => listFields(doc).filter(f => dropped.some(d => d.kind === 'mailMerge' ? f.type === 'MAILMERGE' && f.mergeKey === d.name : f.type === 'CLICK_HERE' && f.name === d.name)).map(f => f.valueText);
    const before = left(parseDocument(openPackage(bytes)));
    let errors = 0;
    for (const path of outputs(root)) {
      const out = new Uint8Array(readFileSync(join(root, path)));
      errors += newErrors(bytes, out).length;
      assert.deepEqual(left(parseDocument(openPackage(out))), before, `${path}: 등록 안 된 필드는 원래 글`);
    }
    assert.equal(outputs(root).length, 50); assert.equal(errors, 0);
    ctx.diagnostic(`seed=0x134a; items=50 (dryRun+real); places=${raw.places.length}; unregistered_names=${want.length}; unregistered_places=${dropped.reduce((n, d) => n + count(d.kind, d.name), 0)}; new_errors=0; top_warnings=0`);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('#134 작업창: 추천 목록에서 같은 이름을 모두 제외한 누름틀·메일머지만 "등록 안 됨"({{키}} 제외는 세지 않음), 그 서식 판의 2판 생성 건별 경고와 같은 수', async () => {
  await withApp(async (app, root) => {
    const opened = (await app.post('/api/workbench/open', { name: 'mailmerge.hwpx', content: MAILMERGE.toString('base64') })).body;
    const items = opened.inputs.map((x: any) => ({ row: x.row, start: x.start, end: x.end, name: x.name.trim(), key: x.usable ? x.name.trim() : '', type: 'text', status: 'recommended', origin: x.kind }));
    const out = ['mailMerge:담당자', 'mailMerge:연락처', 'clickHere:성명'], oneOf = items.findIndex((i: any) => i.origin === 'mailMerge' && i.name === '사업명');
    const work = (excluded: (i: any, n: number) => boolean) => ({ session: opened.session, index: 0, edits: [], headings: [], blocks: [], inputItems: items.map((i: any, n: number) => excluded(i, n) ? { ...i, status: 'excluded' } : i) });
    const fieldsOut = (i: any, n: number) => out.includes(`${i.origin}:${i.name}`) || n === oneOf;
    assert.deepEqual((await app.post('/api/workbench/unregistered', work(() => false))).body, { places: [] });
    const listed = (await app.post('/api/workbench/unregistered', work((i, n) => fieldsOut(i, n) || i.name === 'project.name'))).body.places as { kind: string; name: string }[];
    const tally = new Map<string, number>();
    for (const p of listed) tally.set(`${p.kind}:${p.name}`, (tally.get(`${p.kind}:${p.name}`) ?? 0) + 1);
    assert.deepEqual([...tally].sort(), [['clickHere:성명', 1], ['mailMerge:담당자', 4], ['mailMerge:연락처', 3]]);

    // #192: 제외한 {{키}}는 서식 판에 없어 Helper 생성이 막히므로 서식 판을 만들지 않고 키 이름과 함께 알린다
    const keyOut = await app.post('/api/workbench/g2b-template', work((i, n) => fieldsOut(i, n) || i.name === 'project.name'));
    assert.equal(keyOut.http, 400); assert.equal(keyOut.body.code, 'WORKBENCH_UNREGISTERED_KEY'); assert(keyOut.body.error.startsWith('생성 막힘: {{키}} 1개(project.name).'), keyOut.body.error);
    // 같은 제외로 만든 서식 판(화면의 "서식 판 저장")으로 2판 생성 → 건마다 같은 이름·곳 수의 경고
    const { template } = (await app.post('/api/workbench/g2b-template', work(fieldsOut))).body;
    assert.equal((await app.studio('/api/g2b/templates', { template, source: MAILMERGE.toString('base64') })).http, 200);
    assert.equal((await app.studio('/api/g2b/profiles', { id: 'p-134', label: '미등록', templateId: template.id, version: 1, outputDirectory: join(root, 'out') })).http, 200);
    const next = rng(0x134b), names: string[] = template.bindings.map((b: any) => b.key);
    const values = Array.from({ length: 50 }, (_, i) => ({ values: Object.fromEntries(names.map(n => [n, `${n} ${i}: ${longValue(next, 200, 500)}\n둘째 문장 & <확인>.\t탭`])) }));
    const r = await app.post('/api/g2b/generate', { format: 'studio-generate', version: 2, requestId: 'mm-134', profileId: 'p-134', items: values });
    assert.equal(r.body.summary.succeeded, 50, JSON.stringify(r.body.results[0]).slice(0, 400)); assert.deepEqual(r.body.warnings, []);
    const want = byField([...tally].map(([k, n]) => { const [kind, name] = k.split(':') as ['mailMerge' | 'clickHere', string]; return unregisteredWarning(kind, name, n); }));
    for (const x of r.body.results) assert.deepEqual(byField(x.warnings), want);
    assert.equal(r.body.results.reduce((n: number, x: any) => n + newErrors(new Uint8Array(MAILMERGE), new Uint8Array(readFileSync(x.path))).length, 0), 0);
  });
});
