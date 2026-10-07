import {readFileSync} from 'node:fs';
import {plainOf} from '../../studio/src/messages.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {openPackage,parseDocument,validateDocument,compareToBaseline,walkParagraphs} from '@hwpx-studio/engine';
import {buildHwpx,MINIMAL_HEADER,mutateEntryText} from '../../../packages/hwpx-engine/test/helpers.ts';
import {textPara,gridTable,tableParagraph} from '../../../packages/hwpx-engine/test/table-helpers.ts';
import {createBlockLibrary,extractBlockDraft} from '../src/block-library.ts';
import {createWorkbench} from '../src/workbench.ts';

test('stored block replacement: 50 records, two targets, one-pass values, restore, immutable source and rejection gates',t=>{
 const db=new DatabaseSync(':memory:');try{
 const source=buildHwpx([textPara('source')+textPara('BLOCK '+Array.from({length:25},()=> '{{value}}').join(' / '))+tableParagraph(gridTable([9000],1,[['CELL {{value}}']],{id:'171'}))]);
 const target=buildHwpx([textPara('target')+textPara('first target')+textPara('middle fixed')+textPara('second target')+textPara('tail fixed')],MINIMAL_HEADER.replace('<hh:paraPr id="0">','<hh:paraPr id="0"><hh:align horizontal="CENTER" vertical="BASELINE"/>'));
 const library=createBlockLibrary(db),draft=extractBlockDraft(parseDocument(openPackage(source)),'source.hwpx',{sectionIndex:0,parentPath:[],from:1,to:2}),stored=library.save(draft,'블록 한 가지'),app=createWorkbench(library);
 const opened=app.post('/api/workbench/open',{name:'target.hwpx',content:Buffer.from(target).toString('base64')}) as any;
 const placements=[1,3].map(n=>({id:stored.id,version:1,from:opened.paragraphs[n].id,to:opened.paragraphs[n].id}));
 const work={session:opened.session,index:0,edits:[],headings:[],blocks:[],placements};
 const preview=app.post('/api/workbench/block-placement-preview',work) as any;assert.equal(preview.name,'블록 한 가지');assert.equal(preview.paragraphs,1);assert(preview.warnings.some((w:string)=>w.includes('서식이 다릅니다')));
 assert.throws(()=>app.get('/api/workbench/result',new URLSearchParams({session:opened.session})),(e:any)=>e.code==='WORKBENCH_RESULT');
 let seed=71;
 for(let i=0;i<50;i++){
   seed=(Math.imul(seed,1664525)+1013904223)>>>0;const value=('긴 값 '+seed+' ').repeat(40)+'\n& < >\t{{value}} **문자**';
   app.post('/api/workbench/data',{session:opened.session,name:'data.json',content:JSON.stringify({value})});
   const result=app.post('/api/workbench/generate',work) as any;assert.equal(result.ok,true);assert.equal(result.filled,52);
   const bytes=app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.body;
   assert.equal(compareToBaseline(validateDocument(target),validateDocument(bytes)).newErrors.length,0);
   const texts=parseDocument(openPackage(bytes)).sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>p.logicalText));
   assert.equal(texts.filter(x=>x==='CELL '+value).length,2);assert(texts.includes('middle fixed')&&texts.includes('tail fixed'));assert(!texts.includes('first target'));
   app.post('/api/workbench/generate',work);assert.deepEqual(app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.body,bytes);
 }
 const edited=app.post('/api/workbench/generate',{...work,edits:[{id:opened.paragraphs[2].id,text:'outside **{{value}}**'}]}) as any;assert.equal(edited.ok,true);assert(edited.text.includes('outside 긴 값'));
 const saved=app.post('/api/workbench/save',work) as any,restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as any;
 const protoId=library.material(stored.id,1).proto.id;assert.deepEqual(restored.placements,placements.map(p=>({...p,id:protoId})));assert(restored.placementWarnings[protoId+':'+placements[0]!.from].length>0);assert.equal(restored.placementNames[protoId],'블록 한 가지');assert.equal((app.post('/api/workbench/generate',{...work,session:restored.session}) as any).filled,52);
 assert.deepEqual(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body),Buffer.from(target));
 for(const bad of [[placements[0],placements[0]],[{...placements[0],version:2}],[{...placements[0],id:'missing'}]]){
   assert.throws(()=>app.post('/api/workbench/generate',{...work,placements:bad}));assert.throws(()=>app.get('/api/workbench/result',new URLSearchParams({session:opened.session})),(e:any)=>e.code==='WORKBENCH_RESULT');
 }
 assert.throws(()=>app.post('/api/workbench/generate',{...work,edits:[{id:placements[0]!.from,text:'overlap'}]}),(e:any)=>e.code==='WORKBENCH_OVERLAP');
 t.diagnostic('records=50; targets=2; keys=52; generations=100; deterministic_pairs=50; new_errors=0; source unchanged');
 }finally{db.close();}
});

test('legacy fragment migration keeps UUID and payload; proto ID is stable after repeated opens',()=>{
 const db=new DatabaseSync(':memory:');try{let library=createBlockLibrary(db);const doc=parseDocument(openPackage(buildHwpx([textPara('source')+textPara('body')]))),saved=library.save(extractBlockDraft(doc,'legacy.hwpx',{sectionIndex:0,parentPath:[],from:1,to:1}),'legacy');
 const before=db.prepare('SELECT fragment FROM lite_block WHERE id=?').get(saved.id)!.fragment;db.exec('DROP INDEX lite_block_proto_version; ALTER TABLE lite_block DROP COLUMN proto');
 library=createBlockLibrary(db);const first=library.material(saved.id,1);assert.match(first.proto.id,/^k[0-9a-f]{8}$/);assert.equal(first.proto.source,undefined);
 library=createBlockLibrary(db);assert.equal(library.material(saved.id,1).proto.id,first.proto.id);assert.equal(db.prepare('SELECT fragment FROM lite_block WHERE id=?').get(saved.id)!.fragment,before);
 const corrupt={...first.proto,content:{fragment:'0'.repeat(64)}};db.prepare('UPDATE lite_block SET proto=? WHERE id=?').run(JSON.stringify(corrupt),saved.id);assert.throws(()=>library.material(saved.id,1),(e:any)=>e.code==='TPL_FRAGMENT_MISSING');
 }finally{db.close();}
});

test('block placement and generated warnings reuse the shared easy-language table',()=>{
 const db=new DatabaseSync(':memory:');try{
 const source=readFileSync(new URL('../../../examples/quick/template-braces.hwpx',import.meta.url));
 const target=mutateEntryText(source,'version.xml',xml=>xml.replace('xmlVersion="1.5"','xmlVersion="1.4"'));
 const doc=parseDocument(openPackage(source)),index=doc.sections[0]!.paragraphs.findIndex(p=>p.logicalText.includes('위와 같이'));
 assert(index>=0);const library=createBlockLibrary(db),stored=library.save(extractBlockDraft(doc,'example.hwpx',{sectionIndex:0,parentPath:[],from:index,to:index}),'예시 블록'),app=createWorkbench(library);
 const opened=app.post('/api/workbench/open',{name:'example-14.hwpx',content:Buffer.from(target).toString('base64')}) as any;
 const work={session:opened.session,index:0,edits:[],headings:[],blocks:[],placements:[{id:stored.id,version:1,from:opened.paragraphs[index].id,to:opened.paragraphs[index].id}]};
 const preview=app.post('/api/workbench/block-placement-preview',work) as any;
 assert(preview.warnings.includes(plainOf('FRAG_UNIT_CONVERTED')));
 // 데이터 없이 만들면 예시 서식의 {{키}} 7곳이 남으므로 기본 정책(생성 막기)은 막고(#126), 자리 유지로 만든 결과에서 경고 문구를 본다
 assert.throws(()=>app.post('/api/workbench/generate',work),(e:any)=>e.code==='WORKBENCH_UNLINKED'&&e.message.includes('남은 자리 7곳'));
 const result=app.post('/api/workbench/generate',{...work,missing:'keep'}) as any;assert(result.notes.includes(plainOf('FRAG_UNIT_CONVERTED')));assert(!result.notes.join().includes('FRAG_UNIT_CONVERTED'));assert.equal(result.unresolved,7);
 }finally{db.close();}
});
