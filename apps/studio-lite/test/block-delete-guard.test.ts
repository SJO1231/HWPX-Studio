import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareToBaseline, openPackage, parseDocument, validateDocument, walkParagraphs } from '@hwpx-studio/engine';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { createApp } from '../src/server.ts';

const content = (source: Uint8Array) => Buffer.from(source).toString('base64');
const texts = (bytes: Uint8Array) => parseDocument(openPackage(bytes)).sections.flatMap(s => [...walkParagraphs(s.paragraphs)].map(p => p.logicalText));

test('unsaved placements in open works block API deletion until cleared; saved works stay protected; an old work opens without a deleted block (#111)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lite-open-pin-')), server = createApp(join(dir, 'blocks.sqlite'));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  const call = async (path: string, input?: unknown) => {
    const r = await fetch(base + path, input === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json() as any };
  };
  const post = async (route: string, input: unknown) => { const r = await call('/api/workbench/' + route, input); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const del = (id: string) => call('/api/block/delete', { id, confirmed: true });
  const output = async (url: string) => new Uint8Array(await (await fetch(base + url)).arrayBuffer());
  try {
    // 25 keys in a body paragraph plus one in a table cell: 26 fields per placement.
    const blockSource = buildHwpx([textPara('source') + textPara('BLOCK ' + Array.from({ length: 25 }, () => '{{value}}').join(' / ')) + tableParagraph(gridTable([9000], 1, [['CELL {{value}}']], { id: '171' }))]);
    const target = buildHwpx([textPara('target') + textPara('first target') + textPara('middle fixed') + textPara('second target') + textPara('tail fixed')]);
    const src = await post('open', { name: 'source.hwpx', content: content(blockSource) });
    const a = await post('open', { name: 'target.hwpx', content: content(target) }), b = await post('open', { name: 'target.hwpx', content: content(target) });
    const makeBlock = async (name: string) => { const d = await post('block-preview', { session: src.session, from: 'p:0:1', to: 'p:0:2' }); return post('block-save', { session: src.session, previewId: d.id, name }); };
    const work = (session: string) => ({ session, index: 0, edits: [] as unknown[], headings: [], blocks: [] });
    const place = (protoId: string, rows: string[]) => rows.map(id => ({ id: protoId, version: 1, from: id, to: id }));
    const targets = [['p:0:1', 'p:0:3'], ['p:0:3']];
    const baseline = validateDocument(target);
    let seed = 0x111, refused = 0, released = 0, direct = 0, generations = 0, templates = 0, newErrors = 0;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 50; i++) {
      const value = ('긴 값 ' + next() + ' 첫 문장입니다. 둘째 문장입니다. ').repeat(12) + '\n다음 줄 & <특수> "따옴표"\t탭 {{value}} **굵게**';
      for (const s of [a, b]) await post('data', { session: s.session, name: 'data.json', content: JSON.stringify({ value }) });
      const blk = await makeBlock('예시 블록 ' + i), pinned: string[] = [], made = new Map<string, { input: unknown; bytes: Uint8Array }>();
      for (const [k, s] of [a, b].entries()) {
        const placements = place(blk.protoId, targets[k]!), mode = (next() >>> 16) % 4; // 0 none, 1 generate, 2 placed (invalidate only), 3 template
        if (mode === 0) { await post('invalidate', { session: s.session, placements: [] }); continue; }
        pinned.push(s.session);
        if (mode === 2) { await post('invalidate', { session: s.session, placements }); continue; }
        if (mode === 3) {
          const compiled = await post('template', { ...work(s.session), edits: [{ id: 'p:0:2', text: '중간 {{신규}}' }], placements });
          assert.equal(compiled.promoted, 1); templates++; continue;
        }
        const input = { ...work(s.session), placements }, result = await post('generate', input), bytes = await output(result.outputUrl);
        assert.equal(result.filled, 26 * targets[k]!.length); generations++;
        newErrors += compareToBaseline(baseline, validateDocument(bytes)).newErrors.length;
        assert.equal(texts(bytes).filter(x => x === 'CELL ' + value).length, targets[k]!.length);
        made.set(s.session, { input, bytes });
      }
      let r = await del(blk.id);
      if (pinned.length) {
        refused++;
        assert.equal(r.status, 400); assert.equal(r.body.code, 'BLOCK_IN_USE');
        assert.match(r.body.error, /열린 작업에서 저장 전 배치 중/); assert.doesNotMatch(r.body.error, /[A-Z]{2,}_[A-Z_]+|k[0-9a-f]{8}/);
        assert.equal((await call('/api/block/delete', { id: blk.id })).body.code, 'BLOCK_CONFIRM');
        assert.equal((await call('/api/block/usage?id=' + blk.id)).body.openPlacement, true);
        // Still stored: the open work regenerates the same bytes instead of BLOCK_NOT_FOUND.
        for (const [session, previous] of made) {
          const again = await post('generate', previous.input); generations++;
          assert.deepEqual(await output(again.outputUrl), previous.bytes, session);
        }
        // An invalidate without placements only drops the output; the pins stay.
        await post('invalidate', { session: pinned[0] }); assert.equal((await del(blk.id)).status, 400);
        for (const [j, session] of pinned.entries()) {
          await post('invalidate', { session, placements: [] });
          if (j < pinned.length - 1) assert.equal((await del(blk.id)).status, 400);
        }
        assert.equal((await call('/api/block/usage?id=' + blk.id)).body.openPlacement, false);
        r = await del(blk.id); released++;
      } else direct++;
      assert.equal(r.status, 200); assert.equal(r.body.deleted, true);
      assert.equal((await call('/api/block?id=' + blk.id)).status, 404);
    }
    assert.equal(refused + direct, 50); assert.equal(released, refused); assert(refused > 0 && direct > 0 && templates > 0);

    // A saved work keeps its own protection after the open placements are cleared.
    const kept = await makeBlock('남는 블록'), gone = await makeBlock('지울 블록');
    const both = [...place(gone.protoId, ['p:0:1']), ...place(kept.protoId, ['p:0:3'])];
    await post('generate', { ...work(a.session), placements: both });
    const saved = await post('save', { ...work(a.session), placements: both });
    await post('invalidate', { session: a.session, placements: [] });
    let r = await del(gone.id);
    assert.equal(r.status, 400); assert.equal(r.body.code, 'BLOCK_IN_USE'); assert.match(r.body.error, /target/); assert.doesNotMatch(r.body.error, /열린 작업/);
    // Reopening pins its placements; saving it without one releases that block only.
    const reopened = await post('restore', { workspace: saved.workspace });
    assert.deepEqual(reopened.placements.map((p: any) => p.id), [gone.protoId, kept.protoId]); assert.equal(reopened.notice, undefined);
    await post('save', { ...work(reopened.session), placements: both.slice(1) });
    r = await del(gone.id); assert.equal(r.status, 200);
    // The old work file still names the deleted block: it opens, says so plainly and keeps the other placement.
    const old = await post('restore', { workspace: saved.workspace });
    assert.deepEqual(old.placements.map((p: any) => p.id), [kept.protoId]); assert.deepEqual(Object.keys(old.placementNames), [kept.protoId]);
    assert.match(old.notice, /지워진 블록 1개/); assert.doesNotMatch(old.notice, /[A-Z]{2,}_[A-Z_]+|k[0-9a-f]{8}/);
    const regenerated = await post('generate', { ...work(old.session), placements: old.placements });
    assert.equal(regenerated.filled, 26); newErrors += compareToBaseline(baseline, validateDocument(await output(regenerated.outputUrl))).newErrors.length;
    // The restored session alone still protects the kept block once the saved work lets go.
    await post('save', { ...work(reopened.session), placements: [] });
    r = await del(kept.id); assert.equal(r.status, 400); assert.match(r.body.error, /열린 작업/);
    await post('invalidate', { session: old.session, placements: [] });
    r = await del(kept.id); assert.equal(r.status, 200);
    assert.equal(newErrors, 0);
    t.diagnostic(`rounds=50; refused=${refused}; released=${released}; direct=${direct}; generations=${generations}; templates=${templates}; fields_per_placement=26; new_errors=${newErrors}`);
  } finally { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
});
