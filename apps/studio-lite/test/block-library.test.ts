import {plainOf as blockMessage} from '../../studio/src/messages.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBlockPreviewDocument, serializeFragment, reextractBlock, makeRangeAnchor, extractFragment, openPackage, parseDocument, findPlaceholders, readBlockProto, blockFragment } from '@hwpx-studio/engine';
import { buildHwpx, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, paragraph, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
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


test('library management: immutable old versions, search/rename, latest template pins and workspace deletion protection survive restart',()=>{
 const db=new DatabaseSync(':memory:');try{
 let lib=createBlockLibrary(db);const doc=parseDocument(openPackage(buildHwpx([textPara('source')+textPara('body')])));
 const draft=extractBlockDraft(doc,'synthetic.hwpx',{sectionIndex:0,parentPath:[],from:1,to:1}),first=lib.save(draft,'첫 이름');
 const oldBlob=lib.material(first.id,1).blob.slice(),oldProto=JSON.stringify(lib.material(first.id,1).proto);
 const next=reextractBlock(doc,makeRangeAnchor(doc,0,[],1,1)!,draft.proto,{at:'2026-10-06T01:00:00Z',change:'두번째 판'});
 lib.save({...draft,id:'second-row',proto:next.proto,fragment:next.fragment},'둘째 이름');
 assert.equal(lib.list().length,1);assert.equal(lib.list()[0]!.version,2);assert.equal(lib.material(draft.proto.id,1).proto.version,1);
 lib.rename(first.id,'새 이름');assert.equal(lib.list('새 이름').length,1);assert.equal(lib.list('없는 이름').length,0);assert.equal(lib.list(first.sourceHash.slice(0,8)).length,1);
 assert.deepEqual(lib.material(first.id,1).blob,oldBlob);assert.equal(JSON.stringify(lib.material(first.id,1).proto),oldProto);
 assert.throws(()=>lib.remove(first.id,false),(e:any)=>e.code==='BLOCK_CONFIRM');
 db.exec('CREATE TABLE project_revision(id INTEGER PRIMARY KEY,name TEXT,document TEXT)');
 const t=JSON.parse(readFileSync(new URL('../../../packages/hwpx-engine/test/fixtures/template-v2/form.template.json',import.meta.url),'utf8'));t.meta={name:'예시 템플릿'};
 for(const b of t.blocks){if(b.proto)b.proto={id:draft.proto.id,version:2};if(b.forkedFrom)b.forkedFrom={id:draft.proto.id,version:1};}
 const insert=db.prepare('INSERT INTO project_revision(name,document) VALUES (?,?)');insert.run('예시 템플릿',JSON.stringify(t));
 assert.deepEqual(lib.usage(first.id).usages.map(u=>u.state),['current','forked']);assert.throws(()=>lib.remove(first.id,true),/예시 템플릿/);
 t.version++;for(const b of t.blocks){delete b.proto;delete b.forkedFrom;}insert.run('예시 템플릿',JSON.stringify(t));assert.equal(lib.usage(first.id).usages.length,0);
 lib.saveWorkspace('example-work','예시 저장 작업',[{id:first.id,version:1}]);lib=createBlockLibrary(db);
 assert.equal(lib.usage(first.id).usages[0]!.state,'behind');assert.throws(()=>lib.remove(first.id,true),/예시 저장 작업/);
 lib.saveWorkspace('example-work','예시 저장 작업',[]);lib.remove(first.id,true);assert.equal(lib.list().length,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lite_block').get()!.n,0);
 }finally{db.close();}
});

test('saved workspaces normalize legacy UUID pins to proto IDs and only their own later save releases usage',()=>{
 const db=new DatabaseSync(':memory:');try{
 const lib=createBlockLibrary(db),src=buildHwpx([textPara('source')+textPara('body')]),doc=parseDocument(openPackage(src));
 const stored=lib.save(extractBlockDraft(doc,'synthetic.hwpx',{sectionIndex:0,parentPath:[],from:1,to:1}),'예시 블록'),app=createWorkbench(lib),opened=open(app,src);
 const work={session:opened.session,index:0,edits:[],headings:[],blocks:[],placements:[{id:stored.id,version:1,from:opened.paragraphs[1].id,to:opened.paragraphs[1].id}]};
 const saved=app.post('/api/workbench/save',work) as any,raw=JSON.parse(saved.workspace);assert.match(raw.placements[0].id,/^k[0-9a-f]{8}$/);assert.equal(lib.usage(stored.id).usages.length,1);
 const other=open(app,src);app.post('/api/workbench/save',{...work,session:other.session});assert.equal(lib.usage(stored.id).usages.length,2);
 const restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as any;app.post('/api/workbench/save',{...work,session:restored.session,placements:[]});assert.equal(lib.usage(stored.id).usages.length,1);assert.throws(()=>lib.remove(stored.id,true),/사용 중/);
 }finally{db.close();}
});


test('stored block preview HTTP uses viewer host bytes/marks, keeps source/proto intact and rejects unknown blocks',async()=>{
 const server=createApp();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+(server.address() as any).port;
 try {
 const post=async(path:string,input:unknown)=>{const r=await fetch(base+'/api/workbench/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(r.status,200);return r.json() as Promise<any>;};
 const source=readFileSync(new URL('../../../examples/quick/template-braces.hwpx',import.meta.url)),opened=await post('open',{name:'example.hwpx',content:content(source)});
 const selected=opened.paragraphs.find((p:any)=>p.text.includes('신청인:'));
 const draft=await post('block-preview',{session:opened.session,from:selected.id,to:selected.id}),stored=await post('block-save',{session:opened.session,previewId:draft.id,name:'예시 입력 블록'});
 const response=await fetch(base+'/api/block/preview?id='+stored.id);assert.equal(response.status,200);const preview=await response.json() as any;
 assert(preview.fields.some((f:any)=>f.name==='성명'));assert(preview.places.some((p:any)=>p.marks.length));
 const doc=parseDocument(openPackage(Buffer.from(preview.hwpx,'base64')));assert(doc.sections.some(s=>s.paragraphs.some(p=>p.logicalText.includes('{{성명}}'))));
 const again=await(await fetch(base+'/api/block/preview?id='+stored.id)).json() as any;assert.equal(again.hwpx,preview.hwpx);
 assert.deepEqual(Buffer.from(await(await fetch(base+opened.sourceUrl)).arrayBuffer()),source);
 const missing=await fetch(base+'/api/block/preview?id=missing');assert.equal(missing.status,404);assert.equal((await missing.json() as any).plain,'저장한 블록을 찾지 못했습니다.');
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('block preview rejection gives a plain sentence without codes or ids; input count becomes unknown, not invented',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lite-block-reject-')),path=join(dir,'blocks.sqlite');
 const server=createApp(path);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+(server.address() as any).port;
 try {
 const post=async(route:string,input:unknown)=>{const r=await fetch(base+'/api/workbench/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(r.status,200);return r.json() as Promise<any>;};
 const source=readFileSync(new URL('../../../examples/quick/template-braces.hwpx',import.meta.url)),opened=await post('open',{name:'example.hwpx',content:content(source)});
 const selected=opened.paragraphs.find((p:any)=>p.text.includes('신청인:'));
 const draft=await post('block-preview',{session:opened.session,from:selected.id,to:selected.id}),stored=await post('block-save',{session:opened.session,previewId:draft.id,name:'거절 예시'});
 const db=new DatabaseSync(path);try{const row=db.prepare('SELECT proto FROM lite_block WHERE id=?').get(stored.id) as {proto:string},proto=JSON.parse(row.proto);proto.content.fragment='0'.repeat(64);db.prepare('UPDATE lite_block SET proto=? WHERE id=?').run(JSON.stringify(proto),stored.id);}finally{db.close();}
 const response=await fetch(base+'/api/block/preview?id='+stored.id),body=await response.json() as any;
 assert(response.status>=400);assert.equal(body.code,'TPL_FRAGMENT_MISSING');assert.equal(body.plain,blockMessage('TPL_FRAGMENT_MISSING'));
 assert.doesNotMatch(body.plain,/[A-Z]{2,}_[A-Z_]+|block:|k[0-9a-f]{8}/);
 const restarted=createApp(path);await new Promise<void>(r=>restarted.listen(0,'127.0.0.1',r));
 try{const list=await(await fetch('http://127.0.0.1:'+(restarted.address() as any).port+'/api/blocks')).json() as any;assert.equal(list.blocks[0].inputCount,null);}
 finally{await new Promise<void>(r=>restarted.close(()=>r()));}
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

test('library input counts match preview and exclude placeholders inside mailmerge display text, including old rows',()=>{
  const db=new DatabaseSync(':memory:');try{
    const doc=parseDocument(openPackage(readFixture('merge/merge-fields')));
    const draft=extractBlockDraft(doc,'example.hwpx',{sectionIndex:0,parentPath:[],from:1,to:doc.sections[0]!.paragraphs.length-1});
    const preview=buildBlockPreviewDocument(draft.proto,new TextEncoder().encode(serializeFragment(draft.fragment)));
    const expected=preview.fields.reduce((sum,f)=>sum+f.count,0);
    assert(preview.fields.some(f=>f.kind==='mailMerge'));
    assert.equal(draft.inputCount,expected);
    const library=createBlockLibrary(db),stored=library.save(draft,'메일머지 예시');
    db.prepare('UPDATE lite_block SET input_count=999 WHERE id=?').run(stored.id);
    const reopened=createBlockLibrary(db);
    assert.equal(reopened.list()[0]!.inputCount,expected);assert.equal(reopened.get(stored.id).inputCount,expected);
  }finally{db.close();}
});

test('legacy rows: migration uses the engine proto rule (spaced keys, field display excluded); already migrated rows only get keys recounted; idempotent; ids, versions and pins kept',ctx=>{
  const mm=(id:number,key:string,shown:string)=>`<hp:ctrl><hp:fieldBegin id="${id}" type="MAILMERGE" name="" editable="0" dirty="0" zorder="-1" fieldid="627928423" metaTag=""><hp:parameters cnt="5" name=""><hp:booleanParam name="Fiexde">1</hp:booleanParam><hp:integerParam name="Prop">8</hp:integerParam><hp:stringParam name="Command">${key}</hp:stringParam><hp:stringParam name="FieldType">USER_DEFINE</hp:stringParam><hp:stringParam name="FieldValue">${key}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>${shown}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="627928423"/></hp:ctrl>`;
  const click=(id:number,name:string,shown:string)=>`<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="627272811" metaTag=""/></hp:ctrl><hp:t>${shown}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="627272811"/></hp:ctrl>`;
  const long='제출 서류는 원본 1부입니다. 문의: 담당 부서 &amp; 지원 팀. &lt;참고&gt; 기한을 지키십시오. '.repeat(4);
  const body=Array.from({length:40},(_,i)=>[
    textPara(`${i}. {{ 담당 부서 }} 안내 {{사업명}} {{  공고 번호${i%5}  }} ${long}`),
    paragraph(mm(100+i,'기관명','{{기관명}}')+`<hp:t> 그리고 {{ 기관 명칭 }}</hp:t>`),
    paragraph(click(200+i,'성명','{{ 성명 }}')+`<hp:t> 뒤 {{ 연락 처 }} {{성명}}</hp:t>`),
    tableParagraph(gridTable([9000,9000],1,[[`칸 {{ 칸 키 ${i%3} }}`,'{{사업명}} 칸']],{id:String(7000+i)})),
    textPara(`{{ ${'담당 부서'.normalize('NFD')} }} 다시 {{ ${'새 항목'.normalize('NFD')} }}`),
  ][i%5]!);
  const doc=parseDocument(openPackage(buildHwpx([textPara('settings')+body.join('')])));
  const db=new DatabaseSync(':memory:');
  try {
    let lib=createBlockLibrary(db);
    const insert=db.prepare(`INSERT INTO lite_block (id,name,source_name,source_hash,location,version,change,created_at,paragraph_count,input_count,excerpt,warnings,fragment,proto)
      VALUES (?,?,'synthetic.hwpx',?,'본문',1,'첫 저장','2026-10-01T00:00:00.000Z',?,-1,'','[]',?,?)`);
    const strict=(texts:string[])=>[...new Set(texts.flatMap(t=>findPlaceholders(t).map(k=>k.path)))];
    const engineKeys=new Map<string,string[]>(),fresh:string[]=[],old:string[]=[];
    let seed=112;
    for(let i=0;i<60;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const from=1+seed%38,to=from+(seed>>>8)%3,draft=extractBlockDraft(doc,'synthetic.hwpx',{sectionIndex:0,parentPath:[],from,to});
      const text=serializeFragment(draft.fragment),row='legacy-'+i;engineKeys.set(row,draft.proto.keys);
      if(i%2===0){insert.run(row,'옛 블록 '+i,draft.sourceHash,to-from+1,text,null);fresh.push(row);continue;}
      // A row migrated by the pre-#112 app: strict keys only, no source.
      const id='k'+(0xa000+i).toString(16).padStart(8,'0');
      const proto=readBlockProto(JSON.stringify({schema:'hwpx-studio/block-proto@1',id,version:1,name:'옛 블록 '+i,content:{fragment:createHash('sha256').update(text).digest('hex')},keys:strict(draft.fragment.texts)}));
      insert.run(row,'옛 블록 '+i,draft.sourceHash,to-from+1,text,JSON.stringify(proto));old.push(row);
    }
    const before=new Map((db.prepare('SELECT id,proto FROM lite_block WHERE proto IS NOT NULL').all() as {id:string;proto:string}[]).map(r=>[r.id,JSON.parse(r.proto)]));
    const pins=old.slice(0,10).map(r=>({id:before.get(r).id,version:1}));
    lib.saveWorkspace('work-112','예시 작업',pins);
    const pinRow=JSON.stringify(db.prepare('SELECT * FROM lite_workspace_usage').all());
    lib=createBlockLibrary(db);
    const rows=new Map((db.prepare('SELECT id,proto FROM lite_block').all() as {id:string;proto:string}[]).map(r=>[r.id,readBlockProto(r.proto)]));
    let match=0,spaced=0,gap=0;
    for(const [row,keys] of engineKeys){
      const proto=rows.get(row)!;
      assert.deepEqual(proto.keys,keys,row);match++;
      if(keys.some(k=>/\s/.test(k)))spaced++;
      assert.equal('source' in proto||'history' in proto,false);
      blockFragment(proto,new TextEncoder().encode(String(db.prepare('SELECT fragment FROM lite_block WHERE id=?').get(row)!.fragment))); // throws if the content hash no longer matches the stored fragment
    }
    for(const row of old){
      const was=before.get(row),now=rows.get(row)!;
      if(JSON.stringify(was.keys)!==JSON.stringify(now.keys))gap++;
      assert.deepEqual({...now,keys:was.keys},was,'only keys change: id, version, name and content stay');
    }
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM lite_workspace_usage').all()),pinRow);
    for(const p of pins){assert.equal(lib.material(p.id,1).proto.version,1);assert.equal(lib.usage(p.id).usages[0]!.state,'current');}
    const snapshot=JSON.stringify(db.prepare('SELECT * FROM lite_block ORDER BY id').all());
    createBlockLibrary(db);createBlockLibrary(db);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM lite_block ORDER BY id').all()),snapshot,'running the migration again changes nothing');
    ctx.diagnostic(`rows ${engineKeys.size} (new ${fresh.length}, migrated before #112 ${old.length}); engine keys match ${match}/${engineKeys.size}; rows with spaced keys ${spaced}; recounted ${gap}/${old.length}; pins ${pins.length} kept; second and third run identical`);
    assert.equal(match,60);assert(spaced>=25&&gap>=10,`spaced ${spaced}, recounted ${gap}`);
  } finally { db.close(); }
});
