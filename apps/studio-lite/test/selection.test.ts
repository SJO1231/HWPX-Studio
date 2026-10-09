// #7 #63 분기점: 범위 → 슬롯(원문 그대로), 저장소 블록 후보(원형 판 핀·내용 복사), 경우 표(결정 값 → 블록, 기본 블록), 업무 건마다 직접 고름.
// 판정 표(자동·기본·동률·값 없음·후보 없음·수동 우선)는 Codex 초안 PR #44 `test/selection.test.ts`의 항목을 지금 엔진 공개 API에 맞게 옮긴 것이다.
// 서식 판(Helper)에 슬롯·경우 표가 들어가 2판 창구 UNDECIDED → selections로 풀리고, 작업창 결과 글 = 엔진 generateFromTemplate 글이다. 출력은 OS 임시 폴더에만 쓰고 지운다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareToBaseline, contentSha256, generateFromTemplate, openPackage, parseDocument, readStudioTemplate, validateDocument, walkParagraphs, type StudioTemplate } from '@hwpx-studio/engine';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { createBlockLibrary, extractBlockDraft } from '../src/block-library.ts';
import { createWorkbench } from '../src/workbench.ts';
import { createG2B2 } from '../src/g2b-v2.ts';
import { g2bTemplate } from '../src/input-table.ts';

const texts = (bytes: Uint8Array) => parseDocument(openPackage(bytes)).sections.flatMap(s => [...walkParagraphs(s.paragraphs)].map(p => p.logicalText));
const KEYS = ['사업명', '금액', '담당', '기관', '장소', '기한', '연락처'];
// 대상 문서: 분기점 범위 셋(본문), 그 밖에 {{키}} 수십 곳(같은 키 중복, 표 칸 포함)
const TARGET = buildHwpx([[
  textPara('공고'), textPara('참가자격 원문 {{사업명}}'), textPara('참가자격 둘째 줄'),
  ...Array.from({ length: 24 }, (_, i) => textPara(`본문 ${i} {{${KEYS[i % KEYS.length]}}} 끝`)),
  tableParagraph(gridTable([4000, 4000], 2, [['{{사업명}}', '{{금액}}'], ['{{담당}}', '{{기관}}']], { id: '171' })),
  textPara('제출서류 원문'), textPara('중간 고정 {{장소}}'), textPara('유의사항 원문 {{기한}}'), textPara('끝 고정 {{연락처}}'),
].join('')]);
const SOURCE = buildHwpx([[textPara('블록 원본'), textPara('A 블록 첫 줄 {{사업명}}'), textPara('A 블록 둘째 {{금액}}'), textPara('B 블록 {{사업명}} 다른 문구'), textPara('C 블록 고정 문구'), textPara('D 블록 {{서류명}} 서류')].join('')]);
const UNIQUE: Record<string, string> = { A: 'A 블록 첫 줄', B: 'B 블록', C: 'C 블록 고정 문구', D: 'D 블록' };

function setup() {
  const db = new DatabaseSync(':memory:'), library = createBlockLibrary(db), doc = parseDocument(openPackage(SOURCE));
  const save = (name: string, from: number, to: number) => { const s = library.save(extractBlockDraft(doc, 'src.hwpx', { sectionIndex: 0, parentPath: [], from, to }), name); return { id: s.protoId, version: s.version }; };
  const blocks = { A: save('A 참가자격', 1, 2), B: save('B 참가자격', 3, 3), C: save('C 고정', 4, 4), D: save('D 서류', 5, 5) };
  const app = createWorkbench(library), opened = app.post('/api/workbench/open', { name: 't.hwpx', content: Buffer.from(TARGET).toString('base64') }) as any;
  const row = (text: string) => opened.paragraphs.find((p: any) => p.text.startsWith(text)).id;
  const branches = [
    { id: 's1', name: '참가자격', from: row('참가자격 원문'), to: row('참가자격 둘째'), blocks: [blocks.A, blocks.B, blocks.C], key: '구분', cases: [{ value: '물품', block: blocks.A.id }, { value: '용역', block: blocks.B.id }], fallback: blocks.C.id, picks: {} as Record<string, string> },
    { id: 's2', name: '제출 서류', from: row('제출서류 원문'), to: row('제출서류 원문'), blocks: [blocks.B, blocks.C, blocks.D], key: '구분', cases: [{ value: '물품', block: blocks.D.id }, { value: '공사', block: blocks.C.id }], picks: {} as Record<string, string> },
    { id: 's3', name: '유의사항', from: row('유의사항 원문'), to: row('유의사항 원문'), blocks: [blocks.A, blocks.D], cases: [], picks: {} as Record<string, string> },
  ];
  const work = (extra: Record<string, unknown> = {}) => ({ session: opened.session, index: 0, edits: [], headings: [], blocks: [], branches: structuredClone(branches), ...extra });
  const name = (id: string) => Object.entries(blocks).find(([, b]) => b.id === id)![0];
  return { db, library, blocks, app, opened, branches, work, name };
}
const record = (구분: string, extra: Record<string, unknown> = {}) => ({ 구분, ...Object.fromEntries([...KEYS, '서류명'].map(k => [k, `${k} 값`])), ...extra });

test('#7 분기점 판정: 경우 표 값 → 블록(자동), 기본 블록, 맞는 경우 없음·결정 값 없음·조건 없는 후보 여럿은 막고, 직접 고름이 이긴다(경우 표와 다름 표시)', () => {
  const k = setup();
  try {
    const rows = [record('물품'), record('용역'), record('공사'), record('기타'), Object.fromEntries(KEYS.map(x => [x, 'v']))];
    k.app.post('/api/workbench/data', { session: k.opened.session, name: 'd.json', content: JSON.stringify(rows) });
    const states = (index: number, branches = k.branches) => (k.app.post('/api/workbench/branch-state', k.work({ index, branches })) as any).states.map((s: any) => [s.id, s.state, s.block ? k.name(s.block) : s.reason]);
    assert.deepEqual(states(0), [['s1', 'default', 'A'], ['s2', 'default', 'D'], ['s3', 'undecided', 'tie']]);
    assert.deepEqual(states(1), [['s1', 'default', 'B'], ['s2', 'undecided', 'noCandidate'], ['s3', 'undecided', 'tie']]);
    assert.deepEqual(states(2), [['s1', 'fallback', 'C'], ['s2', 'default', 'C'], ['s3', 'undecided', 'tie']]);
    assert.deepEqual(states(3), [['s1', 'fallback', 'C'], ['s2', 'undecided', 'noCandidate'], ['s3', 'undecided', 'tie']]);
    assert.deepEqual(states(4), [['s1', 'undecided', 'valueMissing'], ['s2', 'undecided', 'valueMissing'], ['s3', 'undecided', 'tie']]);
    // 막히면 생성 없음: 분기점 이름과 쉬운 까닭
    assert.throws(() => k.app.post('/api/workbench/generate', k.work({ index: 1 })), (e: any) => e.code === 'SEL_UNDECIDED' && e.message.includes('제출 서류(맞는 경우가 없고 기본 블록도 없음)') && e.message.includes('유의사항(맞는 블록이 여럿)') && !e.message.includes('참가자격('));
    assert.throws(() => k.app.get('/api/workbench/result', new URLSearchParams({ session: k.opened.session })), (e: any) => e.code === 'WORKBENCH_RESULT');
    // 직접 고름: 그 업무 건에만. 경우 표와 다르면 differs
    const picked = structuredClone(k.branches); picked[0]!.picks = { 1: k.blocks.C.id }; picked[1]!.picks = { 1: k.blocks.B.id }; picked[2]!.picks = { 1: k.blocks.D.id };
    const after = (k.app.post('/api/workbench/branch-state', k.work({ index: 1, branches: picked })) as any).states;
    assert.deepEqual(after.map((s: any) => [s.state, k.name(s.block), s.differs ?? false]), [['manual', 'C', true], ['manual', 'B', false], ['manual', 'D', false]]);
    assert(after.every((s: any) => Array.isArray(s.warnings)), '고른 블록마다 넣기 경고 목록(블록 넣기와 같은 판정)');
    assert.deepEqual(states(0, picked)[2], ['s3', 'undecided', 'tie'], '다른 업무 건으로 넘어가지 않는다');
    // 경우 표가 없으면(결정 값 없음) 후보 하나는 fallback, 둘 이상은 직접 고름
    const one = structuredClone(k.branches); one[2]!.blocks = [k.blocks.A];
    assert.deepEqual(states(0, one)[2], ['s3', 'fallback', 'A']);
  } finally { k.db.close(); }
});

test('#7 분기점 생성·저장·복원·서식 판: 고른 블록 글만 결과에, 원문 그대로, 서식 판에 슬롯·경우 표, 작업창 글 = 엔진 generateFromTemplate 글, 2판 창구 UNDECIDED → selections', async () => {
  const k = setup(), root = mkdtempSync(join(tmpdir(), 'studio-branch-'));
  try {
    k.app.post('/api/workbench/data', { session: k.opened.session, name: 'd.json', content: JSON.stringify([record('물품'), record('용역')]) });
    const picks = structuredClone(k.branches); picks[1]!.picks = { 1: k.blocks.B.id }; picks[2]!.picks = { 0: k.blocks.D.id, 1: k.blocks.A.id };
    const generated = (index: number) => { const r = k.app.post('/api/workbench/generate', k.work({ index, branches: picks })) as any; assert.equal(r.ok, true); return k.app.get('/api/workbench/result', new URLSearchParams({ session: k.opened.session }))!.body; };
    const want: Record<number, string[]> = { 0: ['A', 'D', 'D'], 1: ['B', 'B', 'A'] };
    for (const index of [0, 1]) {
      const out = generated(index), lines = texts(out), body = lines.join('\n');
      // 범위 원문은 빠지고 고른 블록 글이 그 자리에, 고르지 않은 블록 글은 없다. 바깥 글과 값은 그대로 채운다
      for (const gone of ['참가자격 원문', '참가자격 둘째', '제출서류 원문', '유의사항 원문']) assert(!body.includes(gone), gone);
      for (const x of ['A', 'B', 'C', 'D']) assert.equal(body.includes(UNIQUE[x]!), want[index]!.includes(x), `${index} ${x}`);
      assert(lines.includes('중간 고정 장소 값') && lines.includes('끝 고정 연락처 값') && !body.includes('{{'));
      assert(lines[lines.indexOf('중간 고정 장소 값') - 1]!.includes(UNIQUE[want[index]![1]!]!), '제출 서류 자리 그대로');
      assert.equal(compareToBaseline(validateDocument(TARGET), validateDocument(out)).newErrors.length, 0);
    }
    assert.deepEqual(Buffer.from(k.app.get('/api/workbench/source', new URLSearchParams({ session: k.opened.session }))!.body), Buffer.from(TARGET), '원문 그대로');
    // 작업 파일 왕복
    const saved = k.app.post('/api/workbench/save', k.work({ branches: picks })) as any, restored = k.app.post('/api/workbench/restore', { workspace: saved.workspace }) as any;
    assert.deepEqual(restored.branches, picks);
    // 저장소에 없는 후보(다른 저장소에서 열기)는 빼고, 그 블록을 가리키던 경우·기본·직접 고름도 빼고 연다
    const other = new DatabaseSync(':memory:');
    try {
      const away = createWorkbench(createBlockLibrary(other)).post('/api/workbench/restore', { workspace: saved.workspace }) as any;
      assert.deepEqual(away.branches.map((b: any) => [b.blocks.length, b.cases.length, b.fallback ?? null, Object.keys(b.picks).length]), [[0, 0, null, 0], [0, 0, null, 0], [0, 0, null, 0]]);
      assert.match(away.notice, /지워진 블록 8개를 분기점 후보에서 뺐습니다/);
    } finally { other.close(); }
    // 저장 전·저장 뒤에도 후보 블록은 지울 수 없다(사용 중)
    assert.throws(() => k.library.remove(k.blocks.A.id, true), (e: any) => e.code === 'BLOCK_IN_USE');

    // 서식 판(Helper): 슬롯 3, 블록 id = 분기점-원형, 경우 표는 when(in)·기본 블록은 조건 없음, 블록 핀·내용 복사, 덩어리
    const g = k.app.post('/api/workbench/g2b-template', k.work({ branches: picks, id: 't0000abcd' })) as any, t = g.template;
    assert.deepEqual(t.slots.map((s: any) => [s.id, s.name, s.anchors]), [['s1', '참가자격', ['s1-r']], ['s2', '제출 서류', ['s2-r']], ['s3', '유의사항', ['s3-r']]]);
    const v = t.bindings.find((b: any) => b.key === '구분').value;
    assert.deepEqual(t.blocks.filter((b: any) => b.slot === 's1').map((b: any) => [k.name(b.proto.id), b.when ?? null]), [['A', { path: v, op: 'in', value: ['물품'] }], ['B', { path: v, op: 'in', value: ['용역'] }], ['C', null]]);
    assert.deepEqual(t.blocks.filter((b: any) => b.slot === 's2').map((b: any) => b.when.value), [[], ['공사'], ['물품']]);
    assert(t.blocks.filter((b: any) => b.slot === 's3').every((b: any) => b.when === undefined));
    for (const b of t.blocks) { assert.equal(b.id, `${b.slot}-${b.proto.id}`); assert.deepEqual(b.content, k.library.material(b.proto.id, b.proto.version).proto.content); assert(g.blobs[b.content.fragment]); }
    const blobs = new Map(Object.entries(g.blobs as Record<string, string>).map(([sha, b64]) => [sha, new Uint8Array(Buffer.from(b64, 'base64'))]));
    const template = readStudioTemplate(JSON.stringify(t), { hasBlob: sha => blobs.has(sha) }) as StudioTemplate;
    // 같은 업무 건·같은 선택으로 엔진 2판 생성 글 = 작업창 글
    for (const index of [0, 1]) {
      const rec = record(index ? '용역' : '물품'), selections = Object.fromEntries(picks.flatMap(b => b.picks[index] ? [[b.id, { block: `${b.id}-${b.picks[index]}`, basis: 'manual' as const, content: contentSha256(template.blocks.find(x => x.id === `${b.id}-${b.picks[index]}`)!.content) }]] : []));
      const c = { schema: 'hwpx-studio/case@1' as const, template: { id: template.id, version: 1, sha256: '' }, record: { dataset: 'd', version: 1, row: index, sha256: '' }, selections, valueEdits: {}, blockEdits: {} };
      const engine = generateFromTemplate(TARGET, template, rec, c, sha => blobs.get(sha));
      assert(engine.ok && !engine.dryRun && engine.output instanceof Uint8Array, JSON.stringify(engine.report.issues));
      assert.deepEqual(texts(engine.output), texts(generated(index)));
    }

    // 2판 창구: 저장 → 프로필 → 용역(제출 서류·유의사항을 못 정함) UNDECIDED → 같은 슬롯 이름·블록 id로 selections → 성공
    const g2 = createG2B2(k.db), source = Buffer.from(TARGET).toString('base64');
    g2.saveTemplate({ template: { ...t, version: 1 }, source, blobs: g.blobs });
    g2.saveProfile({ id: 'p-branch', label: '분기', templateId: 't0000abcd', version: 1, outputDirectory: root });
    // 블록에만 있는 입력 항목(D의 {{서류명}})은 그 블록이 골라졌을 때만 쓰는 자리(where)라, D를 고르지 않은 건은 그 값 없이도 된다
    assert.deepEqual(t.places.filter((p: any) => p.key === '서류명').map((p: any) => p.where), ['s2-' + k.blocks.D.id, 's3-' + k.blocks.D.id]);
    const { 서류명: _unused, ...values } = record('용역') as Record<string, unknown>;
    const send = (selections: Record<string, string>) => g2.generate({ format: 'studio-generate', version: 2, requestId: 'r-' + Object.keys(selections).length, profileId: 'p-branch', items: [{ values, selections, meta: { identity: ['분기' + Object.keys(selections).length] } }] });
    const first = (await send({})).results[0]!;
    assert.equal(first.code, 'UNDECIDED');
    assert.deepEqual(first.undecided!.map(u => [u.slot, u.reason, u.candidates.map(c => c.block)]), [['제출 서류', 'noCandidate', ['s2-' + k.blocks.B.id, 's2-' + k.blocks.C.id, 's2-' + k.blocks.D.id]], ['유의사항', 'tie', ['s3-' + k.blocks.A.id, 's3-' + k.blocks.D.id]]]);
    const done = (await send({ '제출 서류': 's2-' + k.blocks.B.id, 유의사항: 's3-' + k.blocks.A.id })).results[0]!;
    assert.equal(done.status, 'success', JSON.stringify(done));
    assert.deepEqual(texts(readFileSync(done.path!)), texts(generated(1)), '창구 결과 글 = 작업창 글(같은 선택)');
  } finally { k.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('#7 분기점 무작위 50건: 업무 건 값(긴 글·줄바꿈·탭·XML 특수 문자)·직접 고름을 바꿔 두 번 생성 = 같은 바이트, 고른 블록 글, 검사기 새 오류 0', t => {
  const k = setup();
  try {
    let seed = 7; const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const kinds = ['물품', '용역', '공사', '기타'], ids = Object.values(k.blocks);
    let pairs = 0, filled = 0;
    for (let i = 0; i < 50; i++) {
      const long = ('긴 값 ' + i + ' & <x> "q" ').repeat(20 + next(20)) + '\n둘째 줄\t탭';
      const rec = record(kinds[next(4)]!, Object.fromEntries(KEYS.filter(() => next(2)).map(x => [x, long])));
      k.app.post('/api/workbench/data', { session: k.opened.session, name: 'd.json', content: JSON.stringify([rec]) });
      const branches = structuredClone(k.branches);
      for (const b of branches) if (next(3) === 0 || b.id === 's3' || (b.id === 's2' && !['물품', '공사'].includes(rec.구분))) b.picks = { 0: b.blocks[next(b.blocks.length)]!.id };
      const states = (k.app.post('/api/workbench/branch-state', k.work({ branches })) as any).states;
      assert(states.every((s: any) => s.block), JSON.stringify(states));
      const r = k.app.post('/api/workbench/generate', k.work({ branches })) as any; assert.equal(r.ok, true); filled += r.filled;
      const out = k.app.get('/api/workbench/result', new URLSearchParams({ session: k.opened.session }))!.body;
      k.app.post('/api/workbench/generate', k.work({ branches })); assert.deepEqual(k.app.get('/api/workbench/result', new URLSearchParams({ session: k.opened.session }))!.body, out); pairs++;
      const body = texts(out).join('\n');
      for (const s of states) assert(body.includes(UNIQUE[k.name(s.block)]!), s.block);
      for (const x of ids) if (!states.some((s: any) => s.block === x.id)) assert(!body.includes(UNIQUE[k.name(x.id)]!));
      assert.equal(compareToBaseline(validateDocument(TARGET), validateDocument(out)).newErrors.length, 0);
    }
    t.diagnostic(`branches=3; candidates=3·3·2; records=50; deterministic_pairs=${pairs}; filled=${filled}; new_errors=0`);
  } finally { k.db.close(); }
});

test('#7 분기점 입력 검사: 겹침·같은 이름·후보 밖 블록·TXT는 거절, 서식 판 함수는 분기점이 없으면 전과 같다', () => {
  const k = setup();
  try {
    const bad = (change: (b: any[]) => void, code: string) => { const b = structuredClone(k.branches) as any[]; change(b); assert.throws(() => k.app.post('/api/workbench/branch-state', k.work({ branches: b })), (e: any) => e.code === code, code); };
    bad(b => { b[1].name = '참가자격'; }, 'WORKBENCH_DUPLICATE');
    bad(b => { b[1].from = b[0].from; b[1].to = b[0].to; }, 'WORKBENCH_OVERLAP');
    bad(b => { b[0].fallback = k.blocks.D.id; }, 'WORKBENCH_INPUT');
    bad(b => { b[1].picks = { 0: k.blocks.A.id }; }, 'WORKBENCH_INPUT');
    bad(b => { b[0].cases.push({ value: '물품', block: k.blocks.B.id }); }, 'WORKBENCH_DUPLICATE');
    assert.throws(() => k.app.post('/api/workbench/branch-state', k.work({ placements: [{ ...k.blocks.A, from: k.branches[2]!.from, to: k.branches[2]!.to }] })), (e: any) => e.code === 'WORKBENCH_OVERLAP');
    assert.throws(() => k.app.post('/api/workbench/branch-state', k.work({ edits: [{ id: k.branches[0]!.from, text: '고침' }] })), (e: any) => e.code === 'WORKBENCH_OVERLAP');
    const txt = k.app.post('/api/workbench/open', { name: 'x.txt', content: Buffer.from('a\nb').toString('base64') }) as any;
    assert.throws(() => k.app.post('/api/workbench/branch-state', { session: txt.session, index: 0, edits: [], headings: [], blocks: [], branches: [{ id: 's1', name: 'x', from: txt.paragraphs[0].id, to: txt.paragraphs[1].id, blocks: [] }] }), (e: any) => e.code === 'BLOCK_BOUNDARY');
    assert.deepEqual((k.app.post('/api/workbench/branch-state', k.work({ branches: [] })) as any).states, []);
    const plain = g2bTemplate([{ kind: 'placeholder', name: '사업명' }], { id: 't1', version: 1, name: 'n', sha256: 'x' });
    assert.deepEqual([plain.slots, plain.blocks, plain.anchors], [[], [], []]);
  } finally { k.db.close(); }
});
