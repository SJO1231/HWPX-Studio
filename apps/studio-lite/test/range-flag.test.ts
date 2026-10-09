import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { createWorkbench } from '../src/workbench.ts';
import { createApp } from '../src/server.ts';
import { FLAG_WAIT, flagRefusal, flagRequest, spanLabel } from '../src/range-flag.ts';
import type { RhwpPosition } from '../../../packages/viewer/src/map/index.ts';

type Row = { id: string; sectionIndex: number; path: number[]; text: string; position?: RhwpPosition };
type Opened = { session: string; paragraphs: Row[] };
const app = createWorkbench();
const open = (source: Uint8Array) => app.post('/api/workbench/open', { name: 'synthetic.hwpx', content: Buffer.from(source).toString('base64') }) as Opened;
const select = (session: string, request: unknown) => app.post('/api/workbench/select', { session, request }) as any;
const point = (r: Row) => { assert(r.position, r.text); return { position: r.position, limit: 'paragraph' }; };
const rows = (o: Opened, prefix: string) => o.paragraphs.filter(r => r.text.startsWith(prefix));
// 화면과 같은 흐름: 시작 깃발을 들고(세션과 함께) 끝 깃발에서 본문을 만든다
const flags = (o: Opened, a: Row, b: Row) => { const body = flagRequest({ session: o.session, start: point(a) }, o.session, point(b)); assert(body); return select(o.session, body); };

const body = Array.from({ length: 12 }, (_, i) => 'BODY_' + i), cells = Array.from({ length: 3 }, (_, r) => Array.from({ length: 4 }, (_, c) => 'CELL_' + (r * 4 + c)));
const source = buildHwpx([body.slice(0, 6).map(t => textPara(t)).join('') + tableParagraph(gridTable([9000, 9000, 9000, 9000], 3, cells, { id: '3960' })) + body.slice(6).map(t => textPara(t)).join('')]);

test('#150 flags: wait transitions (start → end, Esc, other document) and plain-language refusals', () => {
  const start = { position: { sectionIndex: 0, paragraphIndex: 3, charOffset: 2 }, shown: { text: 'X', start: 2 } }, end = { cell: { path: [] } };
  assert.deepEqual(flagRequest({ session: 's1', start }, 's1', end), { flags: { start, end } });
  assert.equal(flagRequest(undefined, 's1', end), undefined, 'Esc로 버린 뒤');
  assert.equal(flagRequest({ session: 's1', start }, 's2', end), undefined, '두 깃발 사이에 문서를 다시 열면');
  assert.equal(flagRequest({ session: 's1', start }, 's1', undefined), undefined, '원문에서 누른 점이 없으면');
  assert.match(FLAG_WAIT, /끝 깃발을 찍으세요/); assert.match(FLAG_WAIT, /Esc/);
  for (const reason of ['RANGE_PARAGRAPHS_DIFFER', 'PARAGRAPH_NOT_FOUND', 'CELL_NOT_FOUND', undefined]) {
    const text = flagRefusal(reason);
    assert(/[가-힣]/.test(text) && !/[A-Z_]{4,}/.test(text), text);
  }
  assert.match(flagRefusal('RANGE_PARAGRAPHS_DIFFER'), /표 칸이나 본문/);
  assert.equal(spanLabel({ from: 4, to: 4 }), '문단 1개(문단 전체)'); assert.equal(spanLabel({ from: 2, to: 9 }), '문단 8개');
});

test('#150 flags: 12 body paragraphs x 12 (both orders) match the drag response; same paragraph is one whole paragraph; cell/body crossings refused', () => {
  const opened = open(source), b = rows(opened, 'BODY_'), c = rows(opened, 'CELL_');
  assert.equal(b.length, 12); assert.equal(c.length, 12);
  let same = 0, refused = 0;
  for (const x of b) for (const y of b) {
    const [lo, hi] = x.path[0]! <= y.path[0]! ? [x, y] : [y, x], got = flags(opened, x, y);
    assert.equal(got.id, lo.id); assert.deepEqual(got.location.span, { sectionIndex: 0, parentPath: [], from: lo.path[0], to: hi.path[0] });
    assert.equal(got.location.drafts[0].anchor.kind, 'range');
    if (x === y) { assert.equal(spanLabel(got.location.span), '문단 1개(문단 전체)'); same++; continue; }
    // 드래그(앞 → 뒤)와 같은 응답
    assert.deepEqual(got, select(opened.session, { from: point(lo), to: point(hi) }));
    assert.equal(spanLabel(got.location.span), '문단 ' + (hi.path[0]! - lo.path[0]! + 1) + '개');
  }
  for (const x of b) for (const y of c) for (const [s, e] of [[x, y], [y, x]] as const) {
    const got = flags(opened, s, e);
    assert.equal(got.location.precision, 'none'); assert.equal(got.location.reason, 'RANGE_PARAGRAPHS_DIFFER'); assert.equal(got.id, undefined); refused++;
  }
  for (const x of c) for (const y of c) {
    const got = flags(opened, x, y);
    if (x === y) { assert.equal(spanLabel(got.location.span), '문단 1개(문단 전체)'); same++; }
    else { assert.equal(got.location.reason, 'RANGE_PARAGRAPHS_DIFFER'); refused++; }
  }
  assert.equal(same, 24); assert.equal(refused, 288 + 132);
});

test('#150 flags: a 300-paragraph range (several pages) in one flag pair; the route serves the browser module', async () => {
  const opened = open(buildHwpx([Array.from({ length: 300 }, (_, i) => textPara('긴 범위 문단 ' + i + ' ' + '조항 문장을 이어 씁니다. '.repeat(6))).join('')]));
  const all = rows(opened, '긴 범위'), got = flags(opened, all[299]!, all[0]!);
  assert.deepEqual(got.location.span, { sectionIndex: 0, parentPath: [], from: 0, to: 299 }); assert.equal(spanLabel(got.location.span), '문단 300개');
  const server = createApp(), base = await new Promise<string>(done => server.listen(0, '127.0.0.1', () => done('http://127.0.0.1:' + (server.address() as any).port)));
  try {
    const response = await fetch(base + '/range-flag.js'), text = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /javascript/);
    assert.match(text, /export function flagRequest/); assert.doesNotMatch(text, /: FlagWait/);
  } finally { await new Promise<void>((done, fail) => server.close(e => e ? fail(e) : done())); }
});
