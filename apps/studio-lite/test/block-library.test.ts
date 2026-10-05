import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFragment, openPackage, parseDocument } from '@hwpx-studio/engine';
import { buildHwpx, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { createBlockLibrary, extractBlockDraft } from '../src/block-library.ts';
import { createWorkbench } from '../src/workbench.ts';
import { plainOf } from '../src/quick-messages.ts';
import { createApp } from '../src/server.ts';

const content = (source: Uint8Array) => Buffer.from(source).toString('base64');
const open = (app: ReturnType<typeof createWorkbench>, source: Uint8Array) => app.post('/api/workbench/open', {name:'synthetic.hwpx', content:content(source)}) as any;
const wrong = (fn: () => unknown, code: string) => assert.throws(fn, (e:any) => e.code === code);

test('block library: 50 deterministic ranges preserve complete engine fragments in SQLite across restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lite-block-'));
  const source = buildHwpx([textPara('source settings') + Array.from({length:55}, (_, i) => textPara(`제목 ${i} ` + '{{사업명}} '.repeat(30) + '긴 값 &amp; &lt;문구&gt; '.repeat(60))).join('')]);
  const before = Buffer.from(source), doc = parseDocument(openPackage(source));
  const path = join(dir, 'blocks.sqlite'); let db = new DatabaseSync(path);
  try {
    let library = createBlockLibrary(db), seed = 71;
    for (let i=0;i<50;i++) {
      seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
      const from=1+seed%50, selection={sectionIndex:0,parentPath:[],from,to:from+2};
      const draft=extractBlockDraft(doc,'synthetic.hwpx',selection), again=extractBlockDraft(doc,'synthetic.hwpx',selection);
      assert.deepEqual(draft.fragment,extractFragment(doc,selection)); assert.deepEqual(draft.fragment,again.fragment);
      assert.equal(draft.inputCount,90); assert.equal(draft.paragraphCount,3);
      const saved=library.save(draft,'block '+i);assert.equal(saved.version,1);
      assert.equal(library.save(draft,'block '+i).id,saved.id,'retry is idempotent');
      const raw=db.prepare('SELECT fragment FROM lite_block WHERE id=?').get(saved.id)!;
      assert.deepEqual(JSON.parse(String(raw.fragment)),draft.fragment);
    }
    db.close();db=new DatabaseSync(path);library=createBlockLibrary(db);
    assert.equal(library.list().length,50);assert.equal(library.get(library.list()[0]!.id).change,'첫 저장');
    assert.deepEqual(Buffer.from(source),before);
    t.diagnostic('ranges=50; direct/repeated fragment matches=50/50; stored fragment matches=50/50; input marks=4500; restart rows=50; source unchanged');
  } finally { db.close();rmSync(dir,{recursive:true,force:true}); }
});

test('block creation: table/cell source, invalid boundaries and stale/forged approvals', () => {
  const db=new DatabaseSync(':memory:');
  try {
    const library=createBlockLibrary(db),app=createWorkbench(library);
    const source=buildHwpx([textPara('settings')+textPara('본문')+tableParagraph(gridTable([9000,9000],1,[['CELL_A','CELL_B']],{id:'7171'}))+textPara('끝')]);
    const opened=open(app,source), rows=opened.paragraphs;
    const a=rows.find((r:any)=>r.text==='CELL_A'),b=rows.find((r:any)=>r.text==='CELL_B'),body=rows.find((r:any)=>r.text==='본문');
    const preview=(from:string,to=from)=>app.post('/api/workbench/block-preview',{session:opened.session,from,to}) as any;
    wrong(()=>preview(a.id,b.id),'BLOCK_BOUNDARY');
    assert.match(plainOf('BLOCK_BOUNDARY'), /같은 칸 안이나 같은 본문/);
    assert.doesNotMatch(plainOf('BLOCK_BOUNDARY'), /BLOCK_BOUNDARY/);
    wrong(()=>preview(body.id,a.id),'BLOCK_BOUNDARY');
    wrong(()=>preview('fake'),'WORKBENCH_POSITION');
    const withSettings=open(app,readFixture('D1'));
    wrong(()=>app.post('/api/workbench/block-preview',{session:withSettings.session,from:withSettings.paragraphs[0].id,to:withSettings.paragraphs[0].id}),'FRAG_SECTION_PROPS');
    const old=preview(a.id),latest=preview(body.id);
    const save=(previewId:string,name:unknown)=>app.post('/api/workbench/block-save',{session:opened.session,previewId,name});
    wrong(()=>save(old.id,'old'),'BLOCK_PREVIEW');wrong(()=>save('fake','fake'),'BLOCK_PREVIEW');
    for(const name of ['', 'x'.repeat(121), 'line\nbreak', {}])wrong(()=>save(latest.id,name),'BLOCK_NAME');
    assert.equal(library.list().length,0);
    save(latest.id,'본문');save(latest.id,'본문');assert.equal(library.list().length,1);
    wrong(()=>save(latest.id,'다른 이름'),'BLOCK_ALREADY_SAVED');
    const other=open(app,source);wrong(()=>app.post('/api/workbench/block-save',{session:other.session,previewId:latest.id,name:'다른 문서'}),'BLOCK_PREVIEW');
    const table=rows.find((r:any)=>r.path.length===1&&r.text.includes('\uFFFC'));assert(table);
    const tableDraft=preview(table.id);save(tableDraft.id,'표 전체');
    const raw=JSON.parse(String(db.prepare('SELECT fragment FROM lite_block WHERE id=?').get(tableDraft.id)!.fragment));
    assert.equal(raw.census.tables,1);assert(raw.texts.includes('CELL_A')&&raw.texts.includes('CELL_B'));
    assert.deepEqual(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body),Buffer.from(source));
  } finally { db.close(); }
});

test('block library keeps picture binaries and resources exactly as extracted', () => {
  const source=readFixture('extra/features-picture'),doc=parseDocument(openPackage(source));
  const db=new DatabaseSync(':memory:');let found=false;
  try {
    const library=createBlockLibrary(db);
    for(const section of doc.sections)for(let i=1;i<section.paragraphs.length;i++) {
      const draft=extractBlockDraft(doc,'picture.hwpx',{sectionIndex:section.index,parentPath:[],from:i,to:i});
      if(!draft.fragment.binaries.length)continue;
      found=true;library.save(draft,'그림 블록');
      const stored=JSON.parse(String(db.prepare('SELECT fragment FROM lite_block WHERE id=?').get(draft.id)!.fragment));
      assert.deepEqual(stored.resources,draft.fragment.resources);assert.deepEqual(stored.binaries,draft.fragment.binaries);
    }
    assert(found,'fixture must exercise binary storage');
  } finally { db.close(); }
});

test('block library HTTP: list/detail persist after server restart; no insertion route', async () => {
  const dir=mkdtempSync(join(tmpdir(),'lite-block-http-')),path=join(dir,'blocks.sqlite');
  let server=createApp(path);
  const listen=async()=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+(server.address() as any).port;};
  const close=()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  try {
    let base=await listen();
    const post=async(route:string,data:unknown)=>{const r=await fetch(base+'/api/workbench/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(r.status,200);return r.json() as Promise<any>;};
    const source=buildHwpx([textPara('settings')+textPara('{{사업명}} · 저장할 문구')]);
    const opened=await post('open',{name:'test.hwpx',content:content(source)}),id=opened.paragraphs[1].id;
    const draft=await post('block-preview',{session:opened.session,from:id,to:id});
    const saved=await post('block-save',{session:opened.session,previewId:draft.id,name:'<안전한 이름>'});
    await close();server=createApp(path);base=await listen();
    const list=await (await fetch(base+'/api/blocks')).json() as any;assert.equal(list.blocks.length,1);
    const item=await (await fetch(base+'/api/block?id='+saved.id)).json() as any;
    assert.equal(item.name,'<안전한 이름>');assert.equal(item.inputCount,1);assert.match(item.excerpt,/저장할 문구/);
    assert.equal('fragment' in item,false);assert.equal((await fetch(base+'/api/block?id=missing')).status,404);
    assert.equal((await fetch(base+'/api/blocks/insert')).status,404);
  } finally { await close();rmSync(dir,{recursive:true,force:true}); }
});
