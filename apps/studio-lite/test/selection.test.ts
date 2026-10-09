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
import { g2bTemplate, sameValueCount } from '../src/input-table.ts';
import { branchFlow } from '../src/branch-flow.ts';

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
    { id: 's1', name: '참가자격', from: row('참가자격 원문'), to: row('참가자격 둘째'), blocks: [blocks.A, blocks.B, blocks.C], keys: ['구분'], cases: [{ values: ['물품'], block: blocks.A.id }, { values: ['용역'], block: blocks.B.id }], fallback: blocks.C.id, picks: {} as Record<string, string> },
    { id: 's2', name: '제출 서류', from: row('제출서류 원문'), to: row('제출서류 원문'), blocks: [blocks.B, blocks.C, blocks.D], keys: ['구분'], cases: [{ values: ['물품'], block: blocks.D.id }, { values: ['공사'], block: blocks.C.id }], picks: {} as Record<string, string> },
    { id: 's3', name: '유의사항', from: row('유의사항 원문'), to: row('유의사항 원문'), blocks: [blocks.A, blocks.D], keys: [] as string[], cases: [] as { values: string[]; block: string }[], picks: {} as Record<string, string> },
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
    const ids = (k.app.post('/api/workbench/data', { session: k.opened.session, name: 'd.json', content: JSON.stringify(rows) }) as any).caseIds as string[];
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
    const picked = structuredClone(k.branches); picked[0]!.picks = { [ids[1]!]: k.blocks.C.id }; picked[1]!.picks = { [ids[1]!]: k.blocks.B.id }; picked[2]!.picks = { [ids[1]!]: k.blocks.D.id };
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
    const ids = (k.app.post('/api/workbench/data', { session: k.opened.session, name: 'd.json', content: JSON.stringify([record('물품'), record('용역')]) }) as any).caseIds as string[];
    const picks = structuredClone(k.branches); picks[1]!.picks = { [ids[1]!]: k.blocks.B.id }; picks[2]!.picks = { [ids[0]!]: k.blocks.D.id, [ids[1]!]: k.blocks.A.id };
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
      const rec = record(index ? '용역' : '물품'), at = ids[index]!, selections = Object.fromEntries(picks.flatMap(b => b.picks[at] ? [[b.id, { block: `${b.id}-${b.picks[at]}`, basis: 'manual' as const, content: contentSha256(template.blocks.find(x => x.id === `${b.id}-${b.picks[at]}`)!.content) }]] : []));
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
      const [id] = (k.app.post('/api/workbench/data', { session: k.opened.session, name: 'd.json', content: JSON.stringify([rec]) }) as any).caseIds as string[];
      const branches = structuredClone(k.branches);
      for (const b of branches) if (next(3) === 0 || b.id === 's3' || (b.id === 's2' && !['물품', '공사'].includes(rec.구분))) b.picks = { [id!]: b.blocks[next(b.blocks.length)]!.id };
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

// ── #194 분기점 2차: 경우 표 확장(이름·여러 결정 값 AND), 상호 배타, 참조 번호 재정렬, 업무 건 식별, 흐름도 모델, 같은 값 수(O8) ──
const states194 = (k: ReturnType<typeof setup>, index: number, branches: unknown[], session = k.opened.session) =>
  (k.app.post('/api/workbench/branch-state', { session, index, edits: [], headings: [], blocks: [], branches }) as any).states as any[];
const resultOf = (k: ReturnType<typeof setup>, session = k.opened.session) => k.app.get('/api/workbench/result', new URLSearchParams({ session }))!.body;

test('#194 경우 표 확장: 이름 있는 경우·여러 결정 값(AND)을 저장·복원·평가하고, 서식 판 조건(all·any) 엔진 생성 글 = 작업창 글, 입력 검사', () => {
  const k = setup();
  try {
    const rows = [record('물품', { 지역: '서울' }), record('물품', { 지역: '부산' }), record('용역', { 지역: '서울' }), record('용역', { 지역: '부산' }), record('물품')];
    k.app.post('/api/workbench/data', { session: k.opened.session, name: 'd.json', content: JSON.stringify(rows) });
    const and = [{ ...structuredClone(k.branches[0]!), keys: ['구분', '지역'], cases: [{ name: '물품 서울', values: ['물품', '서울'], block: k.blocks.A.id }, { name: '물품 부산', values: ['물품', '부산'], block: k.blocks.B.id }, { values: ['용역', '서울'], block: k.blocks.B.id }] }];
    const st = (index: number) => { const s = states194(k, index, and)[0]; return [s.state, s.block ? k.name(s.block) : s.reason]; };
    assert.deepEqual([0, 1, 2, 3, 4].map(st), [['default', 'A'], ['default', 'B'], ['default', 'B'], ['fallback', 'C'], ['undecided', 'valueMissing']]);
    // 서식 판: 경우 하나는 all, 여럿은 any(all…), 기본 블록은 조건 없음
    const g = k.app.post('/api/workbench/g2b-template', k.work({ branches: and, id: 't0000abcd' })) as any, t = g.template;
    const v = (key: string) => t.bindings.find((b: any) => b.key === key).value, eq = (key: string, value: string) => ({ path: v(key), op: 'eq', value });
    assert.deepEqual(t.blocks.map((b: any) => b.when ?? null), [{ all: [eq('구분', '물품'), eq('지역', '서울')] }, { any: [{ all: [eq('구분', '물품'), eq('지역', '부산')] }, { all: [eq('구분', '용역'), eq('지역', '서울')] }] }, null]);
    const blobs = new Map(Object.entries(g.blobs as Record<string, string>).map(([sha, b64]) => [sha, new Uint8Array(Buffer.from(b64, 'base64'))]));
    const template = readStudioTemplate(JSON.stringify(t), { hasBlob: sha => blobs.has(sha) }) as StudioTemplate;
    for (const index of [0, 1, 3]) {
      const r = k.app.post('/api/workbench/generate', k.work({ index, branches: and })) as any; assert.equal(r.ok, true);
      const engine = generateFromTemplate(TARGET, template, rows[index]!, undefined, sha => blobs.get(sha));
      assert(engine.ok && !engine.dryRun && engine.output instanceof Uint8Array, JSON.stringify(engine.report.issues));
      assert.deepEqual(texts(engine.output), texts(resultOf(k)), `업무 건 ${index}`);
    }
    // 저장·복원(이름·값 순서 그대로)
    const saved = k.app.post('/api/workbench/save', k.work({ branches: and })) as any;
    assert.deepEqual((k.app.post('/api/workbench/restore', { workspace: saved.workspace }) as any).branches, and);
    // 입력 검사: 값 수가 키 수와 다름, 결정 값 넷, 같은 키 둘, key와 keys를 함께, 같은 값들의 경우 둘
    const bad = (change: (b: any) => void, code: string) => { const b = structuredClone(and) as any[]; change(b[0]); assert.throws(() => states194(k, 0, b), (e: any) => e.code === code, code); };
    bad(b => { b.cases[0].values = ['물품']; }, 'WORKBENCH_INPUT');
    bad(b => { b.keys = ['구분', '지역', '사업명', '금액']; }, 'WORKBENCH_INPUT');
    bad(b => { b.keys = ['구분', '구분']; }, 'WORKBENCH_DUPLICATE');
    bad(b => { b.key = '구분'; }, 'WORKBENCH_INPUT');
    bad(b => { b.cases[1].values = ['물품', '서울']; }, 'WORKBENCH_DUPLICATE');
  } finally { k.db.close(); }
});

test('#194 상호 배타: 선언한 두 분기점이 함께 경우 표 블록이면 둘 다 막히고(짝 이름의 쉬운 말, 생성 SEL_EXCLUSIVE) 직접 고름(기본 블록)으로 풀린다. 서식 판 exclusive → 2판 UNDECIDED(exclusive) → selections, 같은 값 겹침은 TPL_EXCLUSIVE', async () => {
  const k = setup(), root = mkdtempSync(join(tmpdir(), 'studio-exclusive-'));
  try {
    const rows = [record('물품', { 지역: '서울' }), record('물품', { 지역: '부산' }), record('공사', { 지역: '서울' })];
    const ids = (k.app.post('/api/workbench/data', { session: k.opened.session, name: 'd.json', content: JSON.stringify(rows) }) as any).caseIds as string[];
    const ex = structuredClone(k.branches).slice(0, 2) as any[];
    Object.assign(ex[1], { keys: ['지역'], cases: [{ values: ['서울'], block: k.blocks.D.id }], fallback: k.blocks.C.id, exclusive: ['s1'] });
    const view = (index: number, b = ex) => states194(k, index, b).map(s => [s.state, s.block ? k.name(s.block) : s.reason, s.blocked ?? null]);
    assert.deepEqual(view(0), [['default', 'A', 'SEL_EXCLUSIVE'], ['default', 'D', 'SEL_EXCLUSIVE']]);
    assert.deepEqual(states194(k, 0, ex).map(s => s.why), ['함께 고를 수 없는 제출 서류도 경우 표 블록을 고름', '함께 고를 수 없는 참가자격도 경우 표 블록을 고름']);
    assert.deepEqual(view(1), [['default', 'A', null], ['fallback', 'C', null]]);
    assert.deepEqual(view(2), [['fallback', 'C', null], ['default', 'D', null]], '한쪽이 기본 블록이면 배타가 아니다');
    assert.throws(() => k.app.post('/api/workbench/generate', k.work({ index: 0, branches: ex })), (e: any) => e.code === 'SEL_EXCLUSIVE' && e.message.includes('참가자격(함께 고를 수 없는 제출 서류도 경우 표 블록을 고름)'));
    // 직접 고름: 제출 서류를 기본 블록으로 → 풀림
    const picked = structuredClone(ex); picked[1].picks = { [ids[0]!]: k.blocks.C.id };
    assert.deepEqual(view(0, picked), [['default', 'A', null], ['manual', 'C', null]]);
    assert.equal((k.app.post('/api/workbench/generate', k.work({ index: 0, branches: picked })) as any).ok, true);
    const want = texts(resultOf(k));
    // 서식 판·2판 창구
    const g = k.app.post('/api/workbench/g2b-template', k.work({ branches: ex, id: 't0000abce' })) as any;
    assert.deepEqual(g.template.exclusive, [['s1', 's2']]);
    const g2 = createG2B2(k.db);
    g2.saveTemplate({ template: g.template, source: Buffer.from(TARGET).toString('base64'), blobs: g.blobs });
    g2.saveProfile({ id: 'p-ex', label: '배타', templateId: 't0000abce', version: 1, outputDirectory: root });
    const send = (selections: Record<string, string>) => g2.generate({ format: 'studio-generate', version: 2, requestId: 'x-' + Object.keys(selections).length, profileId: 'p-ex', items: [{ values: rows[0]!, selections, meta: { identity: ['배타' + Object.keys(selections).length] } }] });
    const first = (await send({})).results[0]!;
    assert.equal(first.code, 'UNDECIDED');
    assert.deepEqual(first.undecided!.map(u => [u.slot, u.reason]), [['참가자격', 'exclusive'], ['제출 서류', 'exclusive']]);
    const done = (await send({ '제출 서류': 's2-' + k.blocks.C.id })).results[0]!;
    assert.equal(done.status, 'success', JSON.stringify(done));
    assert.deepEqual(texts(readFileSync(done.path!)), want, '창구 결과 글 = 작업창 글(같은 선택)');
    // 같은 결정 값이 겹치면(둘 다 구분=물품이 조건 블록) 엔진 읽기 거절 → 쉬운 말
    const clash = structuredClone(k.branches).slice(0, 2) as any[]; clash[1].exclusive = ['s1'];
    assert.throws(() => states194(k, 0, clash), (e: any) => e.code === 'TPL_EXCLUSIVE' && e.message.includes('함께 고를 수 없다고 정한 두 분기점'));
    // 입력 검사: 자기 자신·없는 분기점
    assert.throws(() => states194(k, 0, [{ ...ex[0], exclusive: ['s1'] }, ex[1]]), (e: any) => e.code === 'WORKBENCH_INPUT');
    assert.throws(() => states194(k, 0, [ex[0], { ...ex[1], exclusive: ['s9'] }]), (e: any) => e.code === 'WORKBENCH_INPUT');
  } finally { k.db.close(); rmSync(root, { recursive: true, force: true }); }
});

// 참조 번호 재정렬 시험 문서: 분기점 범위 둘(참가자격 둘째 줄까지, [붙임 2] 문단), {{키}} 수십 곳(같은 키 중복·표 칸), 붙임 대상 셋과 참조, 대상 없는 별지 참조
const RTARGET = buildHwpx([[
  textPara('공고 {{사업명}}'), textPara('제출: 붙임 1, 붙임 3 참조'), textPara('참가자격 원문 {{사업명}}'), textPara('참가자격 둘째 줄'),
  ...Array.from({ length: 24 }, (_, i) => textPara(`본문 ${i} {{${KEYS[i % KEYS.length]}}} 끝`)),
  tableParagraph(gridTable([4000, 4000], 2, [['{{사업명}}', '{{금액}}'], ['{{담당}}', '{{기관}}']], { id: '172' })),
  textPara('[붙임 1] 서약서'), textPara('[붙임 2] 위임장'), textPara('[붙임 3] 확인서 {{담당}}'), textPara('끝 (붙임 3) {{연락처}}'), textPara('참고 별지 4'),
].join('')]);
function setupR() {
  const k = setup(), doc = parseDocument(openPackage(RTARGET));
  const at = [...walkParagraphs(doc.sections[0]!.paragraphs)].find(p => p.logicalText.startsWith('[붙임 2]'))!.path[0]!;
  const e = k.library.save(extractBlockDraft(doc, 'r.hwpx', { sectionIndex: 0, parentPath: [], from: at, to: at }), 'E 위임장'), E = { id: e.protoId, version: e.version };
  const opened = k.app.post('/api/workbench/open', { name: 'r.hwpx', content: Buffer.from(RTARGET).toString('base64') }) as any;
  const row = (text: string) => opened.paragraphs.find((p: any) => p.text.startsWith(text)).id;
  const appendix = { id: 's2', name: '붙임 2', from: row('[붙임 2]'), to: row('[붙임 2]'), blocks: [E, k.blocks.C], keys: ['지역'], cases: [{ values: ['서울'], block: k.blocks.C.id }], fallback: E.id, picks: {} as Record<string, string> };
  const rwork = (extra: Record<string, unknown> = {}) => ({ session: opened.session, index: 0, edits: [], headings: [], blocks: [], branches: [structuredClone(appendix)], ...extra });
  return { ...k, E, ropened: opened, rrow: row, appendix, rwork };
}

test('#194 참조 번호 재정렬: 켜면 분기점이 뺀 [붙임 2] 뒤의 대상·참조가 실제 순번으로(서식 판 options.renumber 엔진 글 = 작업창 글), 끄면 그대로, 데이터 없이도, 대응 없는 참조 알림, 저장·복원·입력 검사', () => {
  const k = setupR();
  try {
    const rec = record('물품', { 지역: '서울' });
    k.app.post('/api/workbench/data', { session: k.ropened.session, name: 'd.json', content: JSON.stringify([rec]) });
    const run = (extra: Record<string, unknown>) => { const r = k.app.post('/api/workbench/generate', k.rwork(extra)) as any; assert.equal(r.ok, true); return { r, lines: texts(resultOf(k, k.ropened.session)) }; };
    const on = run({ renumber: ['붙임', '별지'] });
    assert.deepEqual(on.lines.filter(l => /붙임|별지/.test(l)), ['제출: 붙임 1, 붙임 2 참조', '[붙임 1] 서약서', '[붙임 2] 확인서 담당 값', '끝 (붙임 2) 연락처 값', '참고 별지 4']);
    assert(on.lines.includes(UNIQUE.C!) && !on.lines.some(l => l.includes('위임장')), '서울은 C 블록(붙임 2를 뺀다)');
    assert(on.r.notes.includes('참조 번호 3곳을 다시 매겼습니다.') && on.r.notes.some((n: string) => n.includes("'별지 4'")), JSON.stringify(on.r.notes));
    const off = run({});
    assert.deepEqual(off.lines.filter(l => /붙임/.test(l)), ['제출: 붙임 1, 붙임 3 참조', '[붙임 1] 서약서', '[붙임 3] 확인서 담당 값', '끝 (붙임 3) 연락처 값']);
    assert(!off.r.notes.some((n: string) => n.includes('참조 번호')));
    assert.equal(on.r.filled, off.r.filled, '채움 수에 번호는 넣지 않는다');
    // 서식 판: options.renumber, 엔진 2판 생성 글 = 작업창 글
    const g = k.app.post('/api/workbench/g2b-template', k.rwork({ renumber: ['붙임'], id: 't0000abcf' })) as any;
    assert.deepEqual(g.template.options, { renumber: { patterns: ['붙임'] } });
    assert.equal(g.template.exclusive, undefined, '배타 선언이 없으면 키도 없다');
    const blobs = new Map(Object.entries(g.blobs as Record<string, string>).map(([sha, b64]) => [sha, new Uint8Array(Buffer.from(b64, 'base64'))]));
    const engine = generateFromTemplate(RTARGET, readStudioTemplate(JSON.stringify(g.template), { hasBlob: sha => blobs.has(sha) }) as StudioTemplate, rec, undefined, sha => blobs.get(sha));
    assert(engine.ok && !engine.dryRun && engine.output instanceof Uint8Array, JSON.stringify(engine.report.issues));
    assert.deepEqual(texts(engine.output), run({ renumber: ['붙임'] }).lines);
    // 부산이면 붙임 2(E 블록)를 넣어 번호가 그대로다
    k.app.post('/api/workbench/data', { session: k.ropened.session, name: 'd.json', content: JSON.stringify([{ ...rec, 지역: '부산' }]) });
    const keep = run({ renumber: ['붙임'] });
    assert(keep.lines.includes('[붙임 2] 위임장') && keep.lines.includes('[붙임 3] 확인서 담당 값') && !keep.r.notes.some((n: string) => n.includes('참조 번호')));
    // 데이터 없이(견본 값만, 자리 유지): 자리는 그대로, 번호만
    const bare = k.app.post('/api/workbench/open', { name: 'r.hwpx', content: Buffer.from(RTARGET).toString('base64') }) as any;
    const r2 = k.app.post('/api/workbench/generate', { ...k.rwork({ renumber: ['붙임'], missing: 'keep', samples: { 지역: '서울' } }), session: bare.session }) as any;
    assert.equal(r2.ok, true);
    assert(texts(resultOf(k, bare.session)).includes('[붙임 2] 확인서 {{담당}}'));
    // 저장·복원·입력 검사(고를 수 없는 꼴, 같은 꼴 둘, 배열 아님, TXT)
    const saved = k.app.post('/api/workbench/save', k.rwork({ renumber: ['별지', '붙임'] })) as any;
    assert.deepEqual((k.app.post('/api/workbench/restore', { workspace: saved.workspace }) as any).renumber, ['붙임', '별지']);
    for (const renumber of [['부록'], ['붙임', '붙임'], '붙임']) assert.throws(() => k.app.post('/api/workbench/generate', k.rwork({ renumber })), (e: any) => e.code === 'WORKBENCH_INPUT', JSON.stringify(renumber));
    const txt = k.app.post('/api/workbench/open', { name: 'x.txt', content: Buffer.from('[붙임 2] a').toString('base64') }) as any;
    assert.throws(() => k.app.post('/api/workbench/generate', { session: txt.session, index: 0, edits: [], headings: [], blocks: [], renumber: ['붙임'] }), (e: any) => e.code === 'WORKBENCH_INPUT');
  } finally { k.db.close(); }
});

test('#194 직접 고름은 업무 건 식별(행 해시)에 붙는다: 데이터를 다시 올려 순서가 바뀌어도 같은 건, PR #193 작업 파일(업무 건 번호·key·value)은 열 때 지금 꼴로', () => {
  const k = setup();
  try {
    const [r0, r1, r2] = [record('물품'), record('용역'), record('공사')];
    const load = (rows: unknown[]) => (k.app.post('/api/workbench/data', { session: k.opened.session, name: 'd.json', content: JSON.stringify(rows) }) as any).caseIds as string[];
    const ids = load([r0, r1, r2]);
    assert.equal(new Set(ids).size, 3);
    const br = structuredClone(k.branches); br[2]!.picks = { [ids[1]!]: k.blocks.D.id };
    const s3 = (index: number) => { const s = states194(k, index, br)[2]; return [s.state, s.block ? k.name(s.block) : s.reason]; };
    assert.deepEqual([0, 1, 2].map(s3), [['undecided', 'tie'], ['manual', 'D'], ['undecided', 'tie']]);
    const moved = load([r2, r0, r1]);
    assert.deepEqual(moved, [ids[2], ids[0], ids[1]], '식별은 행 값에서 온다');
    assert.deepEqual([0, 1, 2].map(s3), [['undecided', 'tie'], ['undecided', 'tie'], ['manual', 'D']], '순서가 바뀌어도 용역 건에');
    // 값이 바뀐 행은 다른 건이다(직접 고름이 붙지 않는다)
    load([{ ...r1, 담당: '바뀐 담당' }]);
    assert.deepEqual(s3(0), ['undecided', 'tie']);
    // PR #193 꼴: key·value·업무 건 번호 → keys·values·식별(그 작업 파일의 데이터 행). 결정 값 없이 남은 경우는 버린다
    load([r2, r0, r1]);
    const saved = JSON.parse((k.app.post('/api/workbench/save', k.work({ branches: br })) as any).workspace);
    for (const b of saved.branches) { if (b.keys.length) b.key = b.keys[0]; delete b.keys; for (const c of b.cases) { c.value = c.values[0]; delete c.values; } b.picks = Object.keys(b.picks).length ? { 2: k.blocks.D.id } : {}; }
    saved.branches[2].cases = [{ value: '남은 경우', block: k.blocks.A.id }];
    const restored = (k.app.post('/api/workbench/restore', { workspace: JSON.stringify(saved) }) as any).branches;
    assert.deepEqual(restored.map((b: any) => [b.keys, b.cases.map((c: any) => c.values), b.picks]), [[['구분'], [['물품'], ['용역']], {}], [['구분'], [['물품'], ['공사']], {}], [[], [], { [ids[1]!]: k.blocks.D.id }]]);
    // 견본 값만(데이터 없음)이면 식별은 'sample'
    const bare = k.app.post('/api/workbench/open', { name: 't.hwpx', content: Buffer.from(TARGET).toString('base64') }) as any;
    const one = structuredClone(k.branches).slice(2); one[0]!.from = bare.paragraphs.find((p: any) => p.text.startsWith('유의사항')).id; one[0]!.to = one[0]!.from; one[0]!.picks = { sample: k.blocks.A.id };
    assert.deepEqual(states194(k, 0, one, bare.session).map(s => [s.state, k.name(s.block)]), [['manual', 'A']]);
  } finally { k.db.close(); }
});

test('#194 흐름도 모델: 제목 순서의 세로 흐름에 분기점을 범위 첫 자리에(제목과 같으면 제목 뒤, 제목 앞이면 맨 위), 후보 갈래에 경우 이름·기본 블록·이 업무 건의 블록, 막힌 분기점은 고른 갈래 없음', () => {
  const order = ['p0', 'h1', 'p1', 'h2', 'p2', 'p3', 'h3', 'p4'];
  const outline = [{ id: 'h1', name: '1. 개요', level: 1 }, { id: 'h2', name: '2. 자격', level: 1 }, { id: 'h3', name: '가. 서류', level: 2 }];
  const branches = [
    { id: 's1', name: '참가자격', from: 'h2', blocks: [{ id: 'kA' }, { id: 'kB' }, { id: 'kC' }], keys: ['구분', '지역'], cases: [{ name: '물품 서울', values: ['물품', '서울'], block: 'kA' }, { values: ['용역', '부산'], block: 'kA' }], fallback: 'kC' },
    { id: 's2', name: '제출 서류', from: 'p3', blocks: [{ id: 'kB' }, { id: 'kD' }], keys: ['지역'], cases: [{ values: ['서울'], block: 'kD' }], exclusive: ['s1'] },
    { id: 's3', name: '머리', from: 'p0', blocks: [], keys: [], cases: [] },
  ];
  const states = { s1: { block: 'kA', state: 'default' }, s2: { block: 'kD', state: 'default', blocked: 'SEL_EXCLUSIVE', reason: 'exclusive', why: '함께 고를 수 없는 참가자격도 경우 표 블록을 고름' } };
  const nodes = branchFlow(order, outline, branches, states, id => '블록 ' + id.slice(1));
  assert.deepEqual(nodes.map(n => n.id), ['s3', 'h1', 'h2', 's1', 's2', 'h3']);
  const [s3, , , s1, s2] = nodes as any[];
  assert.deepEqual(s1.options, [
    { block: 'kA', name: '블록 A', cases: ['물품 서울', '구분=용역 · 지역=부산'], fallback: false, chosen: true },
    { block: 'kB', name: '블록 B', cases: [], fallback: false, chosen: false },
    { block: 'kC', name: '블록 C', cases: [], fallback: true, chosen: false }]);
  assert.deepEqual([s1.undecided, s1.state, s1.exclusive], [false, 'default', ['제출 서류']]);
  assert.deepEqual([s2.undecided, s2.reason, s2.options.map((o: any) => o.chosen), s2.exclusive], [true, 'exclusive', [false, false], ['참가자격']]);
  assert.deepEqual([s3.options, s3.undecided, s3.state], [[], false, undefined]);
  assert.deepEqual(branchFlow(order, outline, [], {}, x => x).map(n => n.kind), ['heading', 'heading', 'heading']);
});

test('#194 O8 같은 값 수: 블록 안 입력 항목 이름과 같은 값을 받는 문서 항목(데이터 키, 없으면 이름, NFC)만 세고 제외한 항목은 뺀다', () => {
  const items = [
    { name: '사업명', key: '', status: 'recommended' }, { name: '사업 이름', key: '사업명', status: 'confirmed' }, { name: '사업명', key: '', status: 'excluded' },
    { name: '금액', key: '', status: 'designated' }, { name: '사업명', key: '다른키', status: 'confirmed' }, { name: '가', key: '', status: 'recommended' },
  ] as const;
  assert.deepEqual(['사업명', '금액', '다른키', '없음', '가'].map(n => sameValueCount(items, n)), [2, 1, 1, 0, 1]);
});

test('#194 분기점 2차 무작위 50건: 여러 결정 값(AND)·배타·직접 고름·참조 번호 재정렬, 긴 값(줄바꿈·탭·XML 특수 문자)으로 두 번 생성 = 같은 바이트, 붙임 번호 = 실제 순번, 검사기 새 오류 0', t => {
  const k = setupR();
  try {
    let seed = 194; const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const kinds = ['물품', '용역', '공사'], places = ['서울', '부산', '대구'];
    const qual = { id: 's1', name: '참가자격', from: k.rrow('참가자격 원문'), to: k.rrow('참가자격 둘째'), blocks: [k.blocks.A, k.blocks.B, k.blocks.C], keys: ['구분', '지역'], cases: [{ name: '물품 서울', values: ['물품', '서울'], block: k.blocks.A.id }, { values: ['용역', '부산'], block: k.blocks.B.id }, { values: ['물품', '대구'], block: k.blocks.B.id }], fallback: k.blocks.C.id, exclusive: ['s2'], picks: {} as Record<string, string> };
    let pairs = 0, blocked = 0, renumbered = 0, filled = 0;
    for (let i = 0; i < 50; i++) {
      const long = ('긴 값 ' + i + ' & <x> "q" ').repeat(10 + next(30)) + '\n둘째 줄\t탭';
      const rec = record(kinds[next(3)]!, { 지역: places[next(3)], ...Object.fromEntries(KEYS.filter(() => next(2)).map(x => [x, long])) });
      const [id] = (k.app.post('/api/workbench/data', { session: k.ropened.session, name: 'd.json', content: JSON.stringify([rec]) }) as any).caseIds as string[];
      const branches = [structuredClone(qual), structuredClone(k.appendix)];
      if (next(4) === 0) branches[0]!.picks = { [id!]: branches[0]!.blocks[next(3)]!.id };
      let states = states194(k, 0, branches, k.ropened.session);
      if (states.some(s => s.blocked)) { blocked++; assert(states.every(s => s.reason === 'exclusive'), JSON.stringify(states)); branches[1]!.picks = { [id!]: k.E.id }; states = states194(k, 0, branches, k.ropened.session); }
      assert(states.every(s => !s.blocked), JSON.stringify(states));
      const work = { ...k.rwork({ renumber: ['붙임'] }), branches };
      const r = k.app.post('/api/workbench/generate', work) as any; assert.equal(r.ok, true); filled += r.filled;
      const out = resultOf(k, k.ropened.session);
      k.app.post('/api/workbench/generate', work); assert.deepEqual(resultOf(k, k.ropened.session), out); pairs++;
      const lines = texts(out), dropped = states[1].block === k.blocks.C.id;
      if (dropped) renumbered++;
      assert.deepEqual(lines.filter(l => /^\[붙임 \d\]/.test(l)).map(l => l.slice(0, 6)), dropped ? ['[붙임 1]', '[붙임 2]'] : ['[붙임 1]', '[붙임 2]', '[붙임 3]']);
      assert(lines.includes(dropped ? '제출: 붙임 1, 붙임 2 참조' : '제출: 붙임 1, 붙임 3 참조'));
      assert(lines.join('\n').includes(UNIQUE[k.name(states[0].block)]!));
      assert.equal(compareToBaseline(validateDocument(RTARGET), validateDocument(out)).newErrors.length, 0);
    }
    assert(blocked > 0 && renumbered > 0 && renumbered < 50, `blocked=${blocked} renumbered=${renumbered}`);
    t.diagnostic(`records=50; deterministic_pairs=${pairs}; exclusive_blocked=${blocked}; renumbered=${renumbered}; filled=${filled}; new_errors=0`);
  } finally { k.db.close(); }
});
