import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPlan, charDelta, compareToBaseline, compileDocument, emptyTemplate, generate, listFields, makeWordAnchor, openPackage,
  parseDocument, planApplyCharFormat, readDataset, readEntry, readTemplate, validateDocument, walkParagraphs,
} from '@hwpx-studio/engine';
import { buildHwpx, mutateEntryText, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { createWorkbench } from '../src/workbench.ts';
import { createApp } from '../src/server.ts';
import type { RhwpPosition } from '../../../packages/viewer/src/map/index.ts';

type Row = { id: string; sectionIndex: number; path: number[]; text: string; editable: boolean; rangeEditable: boolean; reason?: string; position?: RhwpPosition };
type Open = { session: string; paragraphs: Row[]; sourceUrl: string };
type Work = { index: number; edits: {id:string;text:string}[]; headings: {id:string;level:1|2}[]; blocks: {id:string;from:string;to:string;text:string;alias:string}[] };
const blank = (): Work => ({index:0,edits:[],headings:[],blocks:[]});
const api = createWorkbench;
const open = (app:ReturnType<typeof api>, source:Uint8Array):Open => app.post('/api/workbench/open',{name:'synthetic.hwpx',content:Buffer.from(source).toString('base64')}) as Open;
const row = (opened:Open, text:string):Row => {const r=opened.paragraphs.find(p=>p.text===text);assert(r,text);return r;};
const output = (app:ReturnType<typeof api>, session:string) => {const r=app.get('/api/workbench/result',new URLSearchParams({session}));assert(r);return r.body;};
const post = (app:ReturnType<typeof api>, session:string, suffix:string, body:Record<string,unknown>) => app.post('/api/workbench/'+suffix,{session,...body});
const texts = (bytes:Uint8Array) => {const d=parseDocument(openPackage(bytes));return d.sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>p.logicalText));};
const simple = (...paragraphs:string[]) => buildHwpx([textPara('고정 시작')+paragraphs.map(p=>textPara(p)).join('')]);
const wrong = (run:()=>unknown, code:string) => assert.throws(run,(e:any)=>e.code===code);
const outside = (bytes:Uint8Array) => {const d=parseDocument(openPackage(bytes));for(const s of d.sections)for(const p of walkParagraphs(s.paragraphs))if(p.logicalText==='OUTSIDE_FIXED')return s.text.slice(p.element.start,p.element.end);assert.fail('outside missing');};

function denseSource() {
  const source=readFixture('hancom/header-footer'),d=parseDocument(openPackage(source)),s=d.sections[0];
  const start=s.paragraphs[0]!.element.end;
  const body=Array.from({length:12},(_,i)=>textPara('BODY_'+i));
  const cells=Array.from({length:3},(_,r)=>Array.from({length:4},(_,c)=>'CELL_'+(r*4+c)));
  return mutateEntryText(source,s.entryName,x=>x.slice(0,start).replace('{{doc.title}}','HEADER_EDIT').replace('{{doc.owner}}','FOOTER_FIXED')
    +body.join('')+tableParagraph(gridTable([9000,9000,9000,9000],3,cells,{id:'3960'}))
    +textPara('RANGE_START')+textPara('RANGE_END')+textPara('OUTSIDE_FIXED')+x.slice(x.lastIndexOf('</hs:sec>')));
}

test('linked workspace: stable source addresses, immutable copies, safe/read-only paragraph classification',()=>{
  const source=denseSource(),app=api(),opened=open(app,source);
  assert.equal(new Set(opened.paragraphs.map(p=>p.id)).size,opened.paragraphs.length);
  for(const prefix of ['BODY_','CELL_','HEADER_EDIT'])assert(opened.paragraphs.filter(r=>r.text.startsWith(prefix)).every(r=>r.editable));
  assert(opened.paragraphs.some(r=>!r.editable&&r.reason==='WORKBENCH_STRUCTURE_READONLY'));
  const fetched=app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body;
  assert.deepEqual(fetched,source);fetched.fill(0);
  assert.deepEqual(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body),Buffer.from(source));
  const readonly=opened.paragraphs.find(r=>!r.editable)!;
  wrong(()=>post(app,opened.session,'generate',{...blank(),edits:[{id:readonly.id,text:'unsafe'}]}),'WORKBENCH_READONLY');
  wrong(()=>post(app,opened.session,'generate',{...blank(),edits:[{id:'forged',text:'unsafe'}]}),'WORKBENCH_POSITION');
});

test('linked workspace: 25 addressed paragraphs in body/cells/header, seeded 50 records x2; literal data, exact locations and ZIP preservation',t=>{
  const source=denseSource(),sourceCopy=Buffer.from(source),app=api(),opened=open(app,source);
  const targets=opened.paragraphs.filter(p=>/^(BODY_|CELL_|HEADER_EDIT)/.test(p.text));
  assert.equal(targets.length,25);
  const sourceDoc=parseDocument(openPackage(source)),baseline=validateDocument(source);
  assert.equal(baseline.errors.length,0);
  let seed=0x5a17c0de;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const records=Array.from({length:50},(_,i)=>({
    value:'VALUE_'+i+'_'+next()+': '+Array.from({length:12},()=>('긴 문장 원본의 위치와 순서를 보존합니다. '+next())).join(' ')+'\n둘째 & <문장> 😀\t탭',
    zero:0,flag:i%2===0?false:true,identifier:'00'+String(next()%1000000).padStart(6,'0'),
    literal:'**문자 그대로** {{다시_치환하지_않음}}',
  }));
  assert(records.every(r=>r.value.length>400));
  const dataBefore=JSON.stringify(records);
  const data=post(app,opened.session,'data',{name:'data.json',content:dataBefore}) as any;
  assert.equal(data.records,50);
  const edits=targets.map(r=>({id:r.id,text:r.text+': {{value}} / {{zero}} / {{flag}} / {{identifier}} / {{literal}}'}));
  const template=emptyTemplate();
  for(const [i,r] of targets.entries()) {
    const id='edit'+i,a=makeWordAnchor(sourceDoc,id,r.sectionIndex,r.path,0,r.text.length);assert(a);template.anchors.push(a);
    template.rules.push({id,do:{type:'fill',anchor:id,value:{text:r.text+': '+records[0]!.value}}});
  }
  const sourcePkg=openPackage(source);
  let generated=0,newErrors=0,filled=0;
  for(let index=0;index<50;index++) {
    const record=records[index]!,expected=(r:Row)=>r.text+': '+record.value+' / 0 / '+String(record.flag)+' / '+record.identifier+' / '+record.literal;
    for(const [i,r] of targets.entries())(template.rules[i]!.do as any).value={text:expected(r)};
    const direct=generate(source,readTemplate(template),readDataset(record),{mode:'baseline',missing:'error'});assert(direct.ok&&!direct.dryRun);
    let first:Uint8Array|undefined;
    for(let repeat=0;repeat<2;repeat++) {
      const result=post(app,opened.session,'generate',{...blank(),index,edits}) as any;
      assert.equal(result.ok,true);assert.equal(result.filled,25);assert.equal(result.changed,25);
      const bytes=output(app,opened.session);assert.deepEqual(bytes,direct.output);
      if(first)assert.deepEqual(bytes,first);else first=bytes;
      const outputDoc=parseDocument(openPackage(bytes));
      for(const r of targets) {
        const p=[...walkParagraphs(outputDoc.sections[r.sectionIndex]!.paragraphs)].find(p=>p.path.length===r.path.length&&p.path.every((n,i)=>n===r.path[i]));
        assert.equal(p?.logicalText,expected(r),'address '+r.id);
      }
      const cmp=compareToBaseline(baseline,validateDocument(bytes));assert.equal(cmp.newErrors.length,0);
      assert.equal(outside(bytes),outside(source));
      const pkg=openPackage(bytes);
      for(const entry of sourcePkg.archive.entries.filter(e=>!sourcePkg.sectionEntries.includes(e.name)&&e.name!=='Preview/PrvText.txt'&&e.name!=='Preview/PrvImage.png'))
        assert.deepEqual(readEntry(pkg.archive,bytes,entry.name),readEntry(sourcePkg.archive,source,entry.name),entry.name);
      generated++;filled+=result.filled;newErrors+=cmp.newErrors.length;
    }
  }
  assert.equal(generated,100);assert.equal(filled,2500);assert.deepEqual(Buffer.from(source),sourceCopy);assert.equal(JSON.stringify(records),dataBefore);
  t.diagnostic('seed=0x5a17c0de; records=50; targets=25; generations=100; direct_pairs=100; deterministic_pairs=50; filled=2500; new_errors='+newErrors+'; source/data unchanged');
});

test('linked workspace: text key and bold are one-pass; data markup stays literal and original paragraph style survives',()=>{
  const source=denseSource(),app=api(),opened=open(app,source);
  const target=row(opened,'BODY_0');assert(target);
  post(app,opened.session,'data',{name:'data.json',content:JSON.stringify({value:'**literal** {{literal}}',zero:0,flag:false})});
  const state={...blank(),edits:[{id:target.id,text:'앞 **{{value}}** 뒤 {{zero}} {{flag}}'}]};
  post(app,opened.session,'generate',state);
  const bytes=output(app,opened.session),d=parseDocument(openPackage(bytes)),s=d.sections[target.sectionIndex]!;
  const p=[...walkParagraphs(s.paragraphs)].find(p=>p.path.every((n,i)=>n===target.path[i])&&p.path.length===target.path.length)!;
  assert.equal(p.logicalText,'앞 **literal** {{literal}} 뒤 0 false');
  assert(p.runs.length>=3,'bold segment split');assert.equal(validateDocument(bytes).errors.length,0);
  const pkg=openPackage(bytes),header=new TextDecoder().decode(readEntry(pkg.archive,bytes,pkg.headerEntry));
  assert.match(header,/<hh:bold\s*\/>/);
  const oldSection=parseDocument(openPackage(source)).sections[target.sectionIndex]!;
  const oldParagraph=[...walkParagraphs(oldSection.paragraphs)].find(p=>p.path.length===target.path.length&&p.path.every((n,i)=>n===target.path[i]))!;
  assert.equal(s.text.slice(p.element.start,p.element.end).match(/paraPrIDRef="([^"]+)"/)?.[1],
    oldSection.text.slice(oldParagraph.element.start,oldParagraph.element.end).match(/paraPrIDRef="([^"]+)"/)?.[1]);
  wrong(()=>post(app,opened.session,'generate',{...blank(),edits:[{id:target.id,text:'**닫히지 않은 굵기'}]}),'WORKBENCH_MARKUP');
  wrong(()=>output(app,opened.session),'WORKBENCH_RESULT');
});

test('linked workspace: explicit range replacement/deletion; overlap/cross-cell/invalid record do not publish stale results',()=>{
  const source=denseSource(),app=api(),opened=open(app,source),from=row(opened,'RANGE_START'),to=row(opened,'RANGE_END');
  const block={id:'b-range',alias:'구간',from:from.id,to:to.id,text:'첫 문장\n둘째 문장'};
  post(app,opened.session,'generate',{...blank(),blocks:[block]});
  let bytes=output(app,opened.session);assert(texts(bytes).includes('첫 문장'));assert(texts(bytes).includes('둘째 문장'));assert(!texts(bytes).includes('RANGE_START'));assert.equal(outside(bytes),outside(source));
  wrong(()=>post(app,opened.session,'generate',{...blank(),blocks:[block],edits:[{id:from.id,text:'overlap'}]}),'WORKBENCH_OVERLAP');
  wrong(()=>output(app,opened.session),'WORKBENCH_RESULT');
  wrong(()=>post(app,opened.session,'generate',{...blank(),blocks:[block,{...block,id:'b-two'}]}),'WORKBENCH_OVERLAP');
  wrong(()=>post(app,opened.session,'generate',{...blank(),blocks:[{...block,from:row(opened,'CELL_0').id,to:row(opened,'CELL_1').id}]}),'WORKBENCH_RANGE');
  wrong(()=>post(app,opened.session,'generate',{...blank(),index:-1}),'WORKBENCH_RECORD');
  post(app,opened.session,'generate',{...blank(),blocks:[{...block,text:''}]});bytes=output(app,opened.session);
  assert(!texts(bytes).includes('RANGE_START'));assert(!texts(bytes).includes('RANGE_END'));assert.equal(outside(bytes),outside(source));
});

test('linked workspace: work-file restoration checks schema/hash/positions and uses replacement data rather than old values',()=>{
  const source=simple('원래 문장','OUTSIDE_FIXED'),app=api(),opened=open(app,source),id=row(opened,'원래 문장').id;
  post(app,opened.session,'data',{name:'data.csv',content:'value,identifier\n처음,00123'});
  const state={...blank(),edits:[{id,text:'{{value}} / {{identifier}}'}],headings:[{id,level:1 as const}]};
  const saved=post(app,opened.session,'save',state) as {workspace:string;name:string};
  assert.match(saved.name,/workspace\.json$/);const raw=JSON.parse(saved.workspace);
  assert.equal(raw.schema,'hwpx-studio/lite-workspace@1');
  const restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as Open&Work&{dataInfo:any};
  assert.notEqual(restored.session,opened.session);assert.deepEqual(restored.edits,state.edits);assert.deepEqual(restored.headings,state.headings);
  wrong(()=>output(app,restored.session),'WORKBENCH_RESULT');
  post(app,restored.session,'data',{name:'new.json',content:'{"value":0,"identifier":"00007"}'});
  post(app,restored.session,'generate',{...state});
  assert(texts(output(app,restored.session)).includes('0 / 00007'));
  wrong(()=>app.post('/api/workbench/restore',{workspace:{...raw,sha256:'0'.repeat(64)}}),'WORKBENCH_SOURCE_HASH');
  wrong(()=>app.post('/api/workbench/restore',{workspace:{...raw,edits:[{id:'fake',text:'bad'}]}}),'WORKBENCH_POSITION');
  wrong(()=>app.post('/api/workbench/restore',{workspace:{...raw,schema:'future'}}),'WORKBENCH_WORKSPACE');
  wrong(()=>post(app,restored.session,'data',{name:'bad.json',content:'{bad'}),'BAD_JSON');
  wrong(()=>output(app,restored.session),'WORKBENCH_RESULT');
  wrong(()=>post(app,restored.session,'generate',state),'WORKBENCH_DATA_REQUIRED');
  assert.deepEqual(app.get('/api/workbench/source',new URLSearchParams({session:restored.session}))!.body,source);
});

test('linked workspace HTTP: editor/static routes, same-origin, stable row selection, generated bytes and invalidation',async()=>{
  const server=createApp(),base=await new Promise<string>(done=>server.listen(0,'127.0.0.1',()=>done('http://127.0.0.1:'+(server.address() as any).port)));
  const send=(path:string,input:unknown,origin=base)=>fetch(base+'/api/workbench/'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(input)});
  try {
    for(const path of ['/','/workbench','/workbench.js','/workbench.css','/quick','/template'])assert.equal((await fetch(base+path)).status,200,path);
    const html=await (await fetch(base+'/')).text();assert.match(html,/id="document-file"/);assert.match(html,/id="paragraphs"/);
    const source=simple('원래 문장','OUTSIDE_FIXED');
    assert.equal((await send('open',{name:'synthetic.hwpx',content:Buffer.from(source).toString('base64')},'http://untrusted.invalid')).status,403);
    const response=await send('open',{name:'synthetic.hwpx',content:Buffer.from(source).toString('base64')});assert.equal(response.status,200);
    const opened=await response.json() as Open,id=row(opened,'원래 문장').id;
    const selected=await send('select',{session:opened.session,id});assert.equal(selected.status,200);
    const pick=await selected.json() as any;assert.equal(pick.id,id);assert.equal(pick.location.address.sectionIndex,0);assert.deepEqual(pick.location.address.path,[1]);
    const made=await send('generate',{session:opened.session,...blank(),edits:[{id,text:'바뀐 문장'}]});assert.equal(made.status,200);
    const result=await made.json() as any,download=await fetch(base+result.outputUrl);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition')!,/attachment/);
    assert(texts(new Uint8Array(await download.arrayBuffer())).includes('바뀐 문장'));
    const compiled=await send('template',{session:opened.session,...blank(),edits:[{id,text:'서식 {{title}}'}]});assert.equal(compiled.status,200);
    const fieldResult=await compiled.json() as any;assert.equal(fieldResult.template,true);assert.equal(fieldResult.promoted,1);
    const templateDownload=await fetch(base+fieldResult.outputUrl);assert.equal(templateDownload.headers.get('content-type'),'application/vnd.hancom.hwpx');
    assert.deepEqual(listFields(parseDocument(openPackage(new Uint8Array(await templateDownload.arrayBuffer())))).map(f=>[f.type,f.name,f.valueText]),[['CLICK_HERE','title','{{title}}']]);
    assert.equal((await send('invalidate',{session:opened.session})).status,200);assert.equal((await fetch(base+result.outputUrl)).status,404);
    assert.deepEqual(Buffer.from(await (await fetch(base+opened.sourceUrl)).arrayBuffer()),Buffer.from(source));
  } finally {await new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));}
});

test('linked workspace TXT: no HWPX/COM needed; empty lines, one-pass values, literal punctuation, range and source hash restore',()=>{
  const text='사업명: {{title}}\n\n승인: {{flag}} / 금액: {{zero}} / 번호: {{id}}\n교체 시작\n교체 끝\n원본 **문자**';
  const app=api(),source=new TextEncoder().encode(text);
  const opened=app.post('/api/workbench/open',{name:'synthetic.txt',content:Buffer.from(source).toString('base64')}) as Open&{kind:string};
  assert.equal(opened.kind,'text');assert.equal(opened.paragraphs.length,6);assert(opened.paragraphs.every(r=>r.editable));
  assert.equal(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.type,'text/plain; charset=utf-8');
  post(app,opened.session,'data',{name:'data.json',content:JSON.stringify([{title:'첫째 **literal** {{nested}}',flag:false,zero:0,id:'00123'},{title:'둘째',flag:true,zero:10,id:'00007'}])});
  const state={...blank(),edits:[{id:row(opened,'사업명: {{title}}').id,text:'문서명: **{{title}}**'}],
    headings:[{id:row(opened,'사업명: {{title}}').id,level:1 as const}],
    blocks:[{id:'b-text',from:row(opened,'교체 시작').id,to:row(opened,'교체 끝').id,alias:'승인 본문',text:'추가 **본문**\n줄: {{id}}'}]};
  const made=post(app,opened.session,'generate',state) as any;
  const expected='문서명: **첫째 **literal** {{nested}}**\n\n승인: false / 금액: 0 / 번호: 00123\n추가 **본문**\n줄: 00123\n원본 **문자**';
  assert.equal(made.kind,'text');assert.equal(made.text,expected);
  assert.equal(new TextDecoder().decode(output(app,opened.session)),expected);
  assert.match(app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.name!,/\.txt$/);
  const saved=post(app,opened.session,'save',state) as any;
  const restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as Open&{kind:string};
  assert.equal(restored.kind,'text');
  const next=post(app,restored.session,'generate',{...state,index:1}) as any;
  assert.equal(next.text,'문서명: **둘째**\n\n승인: true / 금액: 10 / 번호: 00007\n추가 **본문**\n줄: 00007\n원본 **문자**');
  assert.deepEqual(app.get('/api/workbench/source',new URLSearchParams({session:restored.session}))!.body,source);
  wrong(()=>post(app,restored.session,'generate',{...state,edits:[...state.edits,{id:state.blocks[0]!.from,text:'overlap'}]}),'WORKBENCH_OVERLAP');
  wrong(()=>output(app,restored.session),'WORKBENCH_RESULT');
  wrong(()=>app.post('/api/workbench/open',{name:'invalid.txt',content:Buffer.from([0xc3,0x28]).toString('base64')}),'WORKBENCH_TEXT');
});

test('linked workspace HTTP TXT: source/result correct media types and clipboard-facing result matches bytes',async()=>{
  const server=createApp(),base=await new Promise<string>(done=>server.listen(0,'127.0.0.1',()=>done('http://127.0.0.1:'+(server.address() as any).port)));
  const send=(path:string,input:unknown)=>fetch(base+'/api/workbench/'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(input)});
  try {
    const source='ERP 본문\n값: {{value}}';
    const response=await send('open',{name:'synthetic.txt',content:Buffer.from(source).toString('base64')});assert.equal(response.status,200);
    const opened=await response.json() as Open;
    const original=await fetch(base+opened.sourceUrl);assert.equal(original.headers.get('content-type'),'text/plain; charset=utf-8');assert.equal(await original.text(),source);
    assert.equal((await send('data',{session:opened.session,name:'data.json',content:'{"value":false}'})).status,200);
    const made=await send('generate',{session:opened.session,...blank()});assert.equal(made.status,200);
    const result=await made.json() as any;assert.equal(result.text,'ERP 본문\n값: false');
    const download=await fetch(base+result.outputUrl);assert.equal(download.headers.get('content-type'),'text/plain; charset=utf-8');assert.equal(await download.text(),result.text);
  }finally {await new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));}
});

test('linked workspace: changed range paragraph count remaps bold outside and bold across inserted lines',()=>{
  const source=simple('range A','range B','outside old','OUTSIDE_FIXED'),app=api(),opened=open(app,source);
  const state={...blank(),edits:[{id:row(opened,'outside old').id,text:'앞 **바깥 굵기** 뒤'}],
    blocks:[{id:'b-shift',alias:'구간',from:row(opened,'range A').id,to:row(opened,'range B').id,text:'첫 **문장\n둘째** 문장\n셋째 문장'}]};
  post(app,opened.session,'generate',state);
  const bytes=output(app,opened.session),lines=texts(bytes);
  assert.deepEqual(lines,['고정 시작','첫 문장','둘째 문장','셋째 문장','앞 바깥 굵기 뒤','OUTSIDE_FIXED']);
  assert.equal(outside(bytes),outside(source));assert.equal(compareToBaseline(validateDocument(source),validateDocument(bytes)).newErrors.length,0);
  const doc=parseDocument(openPackage(bytes));
  assert(doc.sections[0]!.paragraphs[1]!.runs.length>1);assert(doc.sections[0]!.paragraphs[2]!.runs.length>1);assert(doc.sections[0]!.paragraphs[4]!.runs.length>=3);
});

test('linked workspace TXT: BOM/CRLF and unchanged markup survive no-op and data-only generation; invalidation removes download',()=>{
  const source=Buffer.from('\ufeff원본 **문자**\r\n\r\n값: {{zero}}\r\n'),app=api();
  const opened=app.post('/api/workbench/open',{name:'synthetic.txt',content:source.toString('base64')}) as Open;
  post(app,opened.session,'generate',{...blank(),edits:opened.paragraphs.map(r=>({id:r.id,text:r.text}))});
  assert.deepEqual(Buffer.from(output(app,opened.session)),source);
  post(app,opened.session,'data',{name:'data.json',content:'{"zero":0}'});
  post(app,opened.session,'generate',blank());
  assert.deepEqual(Buffer.from(output(app,opened.session)),Buffer.from('\ufeff원본 **문자**\r\n\r\n값: 0\r\n'));
  post(app,opened.session,'invalidate',{});wrong(()=>output(app,opened.session),'WORKBENCH_RESULT');
  assert.deepEqual(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body),Buffer.from(source));
});

test('linked workspace: exporting work after generation keeps the same downloadable result',()=>{
  const app=api(),opened=open(app,simple('원문'));
  const work={...blank(),edits:[{id:row(opened,'원문').id,text:'새 본문'}]};
  post(app,opened.session,'generate',work);const before=output(app,opened.session);
  const saved=post(app,opened.session,'save',work) as {workspace:string};
  assert.equal(JSON.parse(saved.workspace).edits[0].text,'새 본문');
  assert.deepEqual(output(app,opened.session),before);
});

function mixedSource() {
  let bytes=denseSource();
  const doc=parseDocument(openPackage(bytes));
  const targets=doc.sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].filter(p=>/^(BODY_|CELL_|HEADER_EDIT)/.test(p.logicalText)).map(p=>({sectionIndex:s.index,path:p.path,end:p.logicalText.indexOf('_')+1})));
  for(const target of targets) {
    const pkg=openPackage(bytes),d=parseDocument(pkg);
    bytes=applyPlan(pkg,planApplyCharFormat(d,{...target,start:0},charDelta(d,{bold:true})));
  }
  return bytes;
}

test('linked workspace mixed formatting: a changed span retains adjacent runs; insertion, deletion, Unicode and bold-only edits work; cross-style/range replacement stays blocked',()=>{
  const source=mixedSource(),app=api(),opened=open(app,source),target=row(opened,'BODY_0');
  assert.equal(target.editable,true);assert.equal(target.rangeEditable,false);assert.equal(target.reason,'FILL_MIXED_FORMAT');
  const sourceDoc=parseDocument(openPackage(source)),original=sourceDoc.sections[0]!.paragraphs[target.path[0]!]!;
  const firstRun=sourceDoc.sections[0]!.text.slice(original.runs[0]!.element.start,original.runs[0]!.element.end);
  for(const text of ['BODY_새 문장','BODY_앞0','BODY_0뒤','BODY_','BODY_😀e\u0301','**BODY_**0']) {
    post(app,opened.session,'generate',{...blank(),edits:[{id:target.id,text}]});
    const bytes=output(app,opened.session),doc=parseDocument(openPackage(bytes)),p=doc.sections[0]!.paragraphs[target.path[0]!]!;
    assert.equal(p.logicalText,text.replaceAll('**',''));
    assert.equal(doc.sections[0]!.text.slice(p.runs[0]!.element.start,p.runs[0]!.element.end),firstRun);
    assert.equal(compareToBaseline(validateDocument(source),validateDocument(bytes)).newErrors.length,0);
  }
  for(const text of ['전부 바꿈','BODY새값','BODYX새']) {
    wrong(()=>post(app,opened.session,'generate',{...blank(),edits:[{id:target.id,text}]}),'FILL_MIXED_FORMAT');
    wrong(()=>output(app,opened.session),'WORKBENCH_RESULT');
  }
  post(app,opened.session,'data',{name:'data.json',content:'{"unrelated":1}'});
  post(app,opened.session,'generate',{...blank(),edits:[{id:target.id,text:'BODY_**0**'}]});
  assert(texts(output(app,opened.session)).includes('BODY_0'));
  wrong(()=>post(app,opened.session,'generate',{...blank(),blocks:[{id:'blocked',from:target.id,to:target.id,text:'전체',alias:'범위'}]}),'WORKBENCH_READONLY');
  const unicode=buildHwpx([textPara('앞').replace('</hp:p>','<hp:run charPrIDRef="1"><hp:t>e\u0301😀끝</hp:t></hp:run></hp:p>')]);
  const openedUnicode=open(app,unicode);
  for(const text of ['앞e\u0308😀끝','앞e\u0301😄끝','앞e\u0301😀새끝']) {
    post(app,openedUnicode.session,'generate',{...blank(),edits:[{id:openedUnicode.paragraphs[0]!.id,text}]});
    assert.equal(texts(output(app,openedUnicode.session))[0],text);
  }
  assert.deepEqual(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body,source);
});

test('linked workspace real fields: 25 mixed body/cell/header locations plus a 2-line block; 50 seeded work files x2 compile/reopen/fill, exact values, determinism and ZIP preservation',t=>{
  let source=mixedSource();
  const beforeFields=parseDocument(openPackage(source));
  source=mutateEntryText(source,beforeFields.sections[0]!.entryName,x=>x.replace('</hs:sec>',textPara('KEEP {{untouched}}')+textPara('{{existing}}')+'</hs:sec>'));
  const withKeys=parseDocument(openPackage(source)),existing=withKeys.sections[0]!.paragraphs.at(-1)!;
  const oldField=compileDocument(source,{anchors:[{sectionIndex:0,path:existing.path,start:0,end:12,name:'existing'}]});assert(oldField.ok);source=oldField.output;
  const sourceCopy=Buffer.from(source),pkg=openPackage(source),baseline=validateDocument(source),app=api(),opened=open(app,source);
  assert.equal(baseline.errors.length,0);
  const targets=opened.paragraphs.filter(r=>/^(BODY_|CELL_|HEADER_EDIT)/.test(r.text));assert.equal(targets.length,25);assert(targets.every(r=>r.editable&&!r.rangeEditable));
  let seed=0x731bc015,compiled=0,filled=0;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let i=0;i<50;i++) {
    const key='v'+i,value=('긴 문장을 안전한 한 서식 안에 넣습니다. '+random()+' / ').repeat(14)+'\n& < > 😀\t**원래 값** {{literal}}';
    assert(value.length>400);
    const dataset={record:{[key]:value},identifier:'00'+String(random()%1000000).padStart(6,'0'),flag:i%2===0?false:true,existing:'기존 누름틀 값',untouched:'원래 문자 키 값'};
    const dataText=JSON.stringify(dataset);post(app,opened.session,'data',{name:'values.json',content:dataText});
    const state={...blank(),edits:targets.map(r=>({id:r.id,text:r.text.slice(0,r.text.indexOf('_')+1)+'{{record.'+key+'}}'})),
      blocks:[{id:'new-fields',from:row(opened,'RANGE_START').id,to:row(opened,'RANGE_END').id,alias:'작성한 구간',text:'번호 {{identifier}}\n확인 {{flag}}'}]};
    let first:Uint8Array|undefined;
    for(let repeat=0;repeat<2;repeat++) {
      const result=post(app,opened.session,'template',state) as any;assert.equal(result.template,true);assert.equal(result.kind,'hwpx');assert.equal(result.promoted,27);assert.equal(result.filled,0);
      const bytes=output(app,opened.session);if(first)assert.deepEqual(bytes,first);else first=bytes;
      const doc=parseDocument(openPackage(bytes)),fields=listFields(doc);
      assert.equal(fields.length,28);assert(fields.every(f=>f.type==='CLICK_HERE'&&f.dirty==='1'&&f.shape==='simple'));
      assert.equal(fields.filter(f=>f.name==='record.'+key&&f.valueText==='{{record.'+key+'}}').length,25);
      assert.deepEqual(fields.filter(f=>f.name==='existing').map(f=>f.valueText),['{{existing}}']);
      assert.equal(fields.filter(f=>f.name==='untouched').length,0);assert(texts(bytes).includes('KEEP {{untouched}}'));
      assert.equal(compareToBaseline(baseline,validateDocument(bytes)).newErrors.length,0);
      assert.equal(outside(bytes),outside(source));
      const nextPkg=openPackage(bytes);
      for(const entry of pkg.archive.entries.filter(e=>!pkg.sectionEntries.includes(e.name)&&!e.name.startsWith('Preview/')))
        assert.deepEqual(readEntry(nextPkg.archive,bytes,entry.name),readEntry(pkg.archive,source,entry.name),entry.name);
      const reopenedApp=api(),reopened=open(reopenedApp,bytes);
      assert(reopened.paragraphs.filter(r=>r.text.includes('{{record.')).every(r=>!r.editable&&!r.rangeEditable));
      post(reopenedApp,reopened.session,'data',{name:'next.json',content:dataText});
      post(reopenedApp,reopened.session,'generate',blank());
      const final=output(reopenedApp,reopened.session),actual=listFields(parseDocument(openPackage(final)));
      assert.equal(actual.filter(f=>f.name==='record.'+key&&f.valueText===value).length,25);
      assert.deepEqual(actual.filter(f=>f.name==='identifier'||f.name==='flag').map(f=>[f.name,f.valueText]),[['identifier',dataset.identifier],['flag',String(dataset.flag)]]);
      assert.equal(actual.find(f=>f.name==='existing')?.valueText,dataset.existing);
      assert(texts(final).includes('KEEP '+dataset.untouched));
      assert.equal(compareToBaseline(baseline,validateDocument(final)).newErrors.length,0);
      const direct=generate(bytes,emptyTemplate(),readDataset(dataset),{missing:'error',mode:'baseline'});assert(direct.ok&&!direct.dryRun);assert.deepEqual(final,direct.output);
      compiled++;filled+=actual.length;
    }
    const saved=post(app,opened.session,'save',state) as {workspace:string};
    const restoredApp=api(),restored=restoredApp.post('/api/workbench/restore',{workspace:saved.workspace}) as Open;
    post(restoredApp,restored.session,'template',state);assert.deepEqual(output(restoredApp,restored.session),first);
    assert.equal(JSON.stringify(dataset),dataText);
  }
  assert.equal(compiled,100);assert.equal(filled,2800);assert.deepEqual(Buffer.from(source),sourceCopy);
  t.diagnostic('seed=0x731bc015; mixed_targets=25; new_fields=27; templates=100; deterministic_pairs=50; saved_restore_pairs=50; reopen_fill=100; direct_pairs=100; field_values=2800; new_errors=0; source/data/untouched ZIP unchanged');
});

test('linked workspace template: preserves source keys/fields, remaps bold block positions, rejects partial compile, malformed names, read-only targets and TXT; failures remove old result',()=>{
  const source=simple('KEEP {{old}}','range A','range B','after','OUTSIDE_FIXED'),app=api(),opened=open(app,source);
  post(app,opened.session,'data',{name:'values.json',content:'{"old":"must stay a key","new":"must stay a key","block":"must stay a key"}'});
  const state={...blank(),edits:[{id:row(opened,'KEEP {{old}}').id,text:'바뀐 앞 {{old}} 뒤 {{new}}'},{id:row(opened,'after').id,text:'뒤 **{{new}}**'}],
    blocks:[{id:'shift',from:row(opened,'range A').id,to:row(opened,'range B').id,alias:'구간',text:'**{{block}}**\n둘째\n셋째'}]};
  const made=post(app,opened.session,'template',state) as any;assert.equal(made.promoted,3);
  const result=output(app,opened.session),fields=listFields(parseDocument(openPackage(result)));
  assert.deepEqual(fields.map(f=>f.name),['new','block','new']);assert.equal(fields.at(-1)!.path[0],5);
  assert(texts(result).map(s=>s.replaceAll('\uFFFC','')).includes('바뀐 앞 {{old}} 뒤 {{new}}'));
  assert.equal(compareToBaseline(validateDocument(source),validateDocument(result)).newErrors.length,0);
  const saved=post(app,opened.session,'save',state) as any;assert.deepEqual(output(app,opened.session),result);
  wrong(()=>app.post('/api/workbench/restore',{workspace:{...JSON.parse(saved.workspace),edits:[{id:'p:99:99',text:'{{new}}'}]}}),'WORKBENCH_POSITION');
  wrong(()=>post(app,opened.session,'template',{...blank(),edits:[{id:row(opened,'KEEP {{old}}').id,text:'앞 {{old}} 뒤'}]}),'WORKBENCH_NO_NEW_FIELDS');
  wrong(()=>output(app,opened.session),'WORKBENCH_RESULT');
  wrong(()=>post(app,opened.session,'template',{...blank(),edits:[{id:row(opened,'after').id,text:'{{bad key}}'}]}),'WORKBENCH_FIELD_NAME');
  wrong(()=>post(app,opened.session,'template',{...blank(),edits:[{id:row(opened,'after').id,text:'{{good}} {{\tsplitKey}}'}]}),'WORKBENCH_TEMPLATE_INCOMPLETE');
  wrong(()=>output(app,opened.session),'WORKBENCH_RESULT');
  wrong(()=>post(app,opened.session,'template',{...blank(),blocks:[{...state.blocks[0]!,text:'{{good}}\n{{\nsplitKey}}'}]}),'WORKBENCH_TEMPLATE_INCOMPLETE');
  wrong(()=>output(app,opened.session),'WORKBENCH_RESULT');
  const fieldsApp=api(),fieldsOpened=open(fieldsApp,result),readonly=fieldsOpened.paragraphs.find(p=>!p.editable&&p.text.includes('{{new}}'))!;assert(readonly);
  wrong(()=>post(fieldsApp,fieldsOpened.session,'template',{...blank(),edits:[{id:readonly.id,text:'{{unsafe}}'}]}),'WORKBENCH_READONLY');
  const txt=app.post('/api/workbench/open',{name:'synthetic.txt',content:Buffer.from('원본').toString('base64')}) as Open;
  post(app,txt.session,'generate',blank());
  wrong(()=>post(app,txt.session,'template',{...blank(),edits:[{id:txt.paragraphs[0]!.id,text:'{{key}}'}]}),'WORKBENCH_TEMPLATE_HWPX');
  wrong(()=>output(app,txt.session),'WORKBENCH_RESULT');
});


test('linked workspace TXT: no-data edits and blocks keep keys; later data fills once and missing keys invalidate old output',()=>{
  const source=Buffer.from('\ufeff원본 **문자**\r\n값: {{value}}\r\n블록 시작\r\n블록 끝\r\n고정 {{flag}}\r\n'),app=api();
  const opened=app.post('/api/workbench/open',{name:'synthetic.txt',content:source.toString('base64')}) as Open;
  const state={...blank(),edits:[{id:row(opened,'값: {{value}}').id,text:'수정 **{{value}}**'}],blocks:[{id:'txt-block',alias:'본문',from:row(opened,'블록 시작').id,to:row(opened,'블록 끝').id,text:'번호 {{id}}\n확인 {{flag}}'}]};
  const made=post(app,opened.session,'generate',state) as any;
  assert.equal(made.template,true);assert.equal(made.unresolved,4);assert.equal(made.filled,0);assert.equal(made.changed,2);
  const expected='\ufeff원본 **문자**\r\n수정 **{{value}}**\r\n번호 {{id}}\n확인 {{flag}}\r\n고정 {{flag}}\r\n';
  assert.equal(made.text,expected);assert.deepEqual(Buffer.from(output(app,opened.session)),Buffer.from(expected));
  const saved=post(app,opened.session,'save',state) as any;
  const restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as Open;
  assert.equal((post(app,restored.session,'generate',state) as any).unresolved,4);
  post(app,restored.session,'data',{name:'data.json',content:JSON.stringify({value:'**literal** {{unparsed}}',id:'00001',flag:false})});
  const filled=post(app,restored.session,'generate',state) as any;
  assert.equal(filled.template,undefined);assert.equal(filled.unresolved,undefined);assert.equal(filled.filled,4);
  assert.equal(filled.text,'\ufeff원본 **문자**\r\n수정 ****literal** {{unparsed}}**\r\n번호 00001\n확인 false\r\n고정 false\r\n');
  post(app,restored.session,'data',{name:'missing.json',content:'{"value":0,"flag":false}'});
  assert.throws(()=>post(app,restored.session,'generate',state),(e:any)=>/id/.test(e.message)&&!e.message.includes('00001'));
  wrong(()=>output(app,restored.session),'WORKBENCH_RESULT');
  assert.match((post(app,opened.session,'generate',{...blank(),edits:[{id:row(opened,'값: {{value}}').id,text:'{{invalid name}}'}]}) as any).text,/\{\{invalid name\}\}/);
  const plain=app.post('/api/workbench/open',{name:'plain.txt',content:Buffer.from('원본').toString('base64')}) as Open;
  const done=post(app,plain.session,'generate',{...blank(),edits:[{id:plain.paragraphs[0]!.id,text:'수정'}]}) as any;
  assert.equal(done.template,undefined);assert.equal(done.text,'수정');assert.equal(done.filled,0);
  assert.deepEqual(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body),source);
});

test('linked workspace viewer positions: body/cell rows round-trip through the selection API; unmapped header/footer stay absent and restored IDs stay stable',()=>{
  const app=api(),source=denseSource(),opened=open(app,source);
  for(const name of ['BODY_0','BODY_6','BODY_11','CELL_0','CELL_5','CELL_11']) {
    const target=row(opened,name);assert(target.position);
    const selected=post(app,opened.session,'select',{request:{from:{position:target.position,limit:'paragraph'}}}) as any;
    assert.equal(selected.id,target.id);assert.deepEqual(selected.location.address,{sectionIndex:target.sectionIndex,path:target.path});
    if(name.startsWith('CELL_')) assert(target.position.cellPath?.length);
    else assert.equal(target.position.parentParaIndex,undefined);
  }
  assert.equal(row(opened,'HEADER_EDIT').position,undefined);assert.equal(row(opened,'FOOTER_FIXED').position,undefined);
  const saved=post(app,opened.session,'save',blank()) as {workspace:string};
  const restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as Open;
  assert.deepEqual(restored.paragraphs,opened.paragraphs);
  post(app,opened.session,'generate',{...blank(),edits:[{id:row(opened,'BODY_0').id,text:'수정된 본문'}]});
  const reopened=open(app,output(app,opened.session));
  assert.deepEqual(row(reopened,'수정된 본문').position,row(opened,'BODY_0').position);
  const txt=app.post('/api/workbench/open',{name:'synthetic.txt',content:Buffer.from('문단\n다음').toString('base64')}) as Open;
  assert(txt.paragraphs.every(r=>r.position===undefined));
});

test('linked workspace viewer positions: the 3000-row opening limit returns display positions without changing IDs',t=>{
  const source=buildHwpx([Array.from({length:3000},(_,i)=>textPara('문단 '+i)).join('')]),app=api();
  const started=performance.now(),opened=open(app,source),elapsed=performance.now()-started;
  assert.equal(opened.paragraphs.length,3000);assert.equal(opened.paragraphs.filter(r=>r.position).length,3000);
  for(const index of [0,1499,2999]) {
    const target=opened.paragraphs[index]!;assert.equal(target.id,'p:0:'+index);
    assert.deepEqual(target.position,{sectionIndex:0,paragraphIndex:index,charOffset:0});
  }
  t.diagnostic('rows=3000; mapped=3000; open_parse_analysis_mapping_ms='+elapsed.toFixed(1));
});
