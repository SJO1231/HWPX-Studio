import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  canonicalStudioJson, compareToBaseline, generateFromTemplate, openPackage, parseDocument,
  remapAddress, sha256Hex, validateDocument, walkParagraphs, writeCase, writeStudioTemplate,
  type ParagraphNode, type StudioCase, type StudioGenerateResult,
} from '@hwpx-studio/engine';
import { caseOf, loaderOf, manual, noticeKit, recordFor, type NoticeKit } from '../../../packages/hwpx-engine/test/generate-v2-helpers.ts';
import { longValue, rng } from '../../../packages/hwpx-engine/test/range-helpers.ts';
import { createLibrary } from '../src/library.ts';

type Library=ReturnType<typeof createLibrary>;
type Generated=Extract<StudioGenerateResult,{ok:true;dryRun:false}>;
const base64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
let kitCache:NoticeKit|undefined;
const kit=()=>kitCache??=noticeKit();
function temporaryLibrary(run:(state:{db:()=>DatabaseSync;library:()=>Library;restart:()=>void})=>void) {
  const directory=mkdtempSync(join(resolve(tmpdir()),'hwpx-library-generate-')),file=join(directory,'synthetic.sqlite');
  let db=new DatabaseSync(file),library=createLibrary(db);
  try {run({db:()=>db,library:()=>library,restart:()=>{db.close();db=new DatabaseSync(file);library=createLibrary(db);}});}
  finally {db.close();assert.equal(dirname(directory),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}
}
function saveTemplate(library:Library,k=kit()) {
  return library.save({template:writeStudioTemplate(k.t),blobs:[k.bytes,...k.blobs.values()].map(base64)});
}
function savedCase(k:NoticeKit,row:Record<string,unknown>,data:{id:string;version:number},index:number,parts:Partial<Pick<StudioCase,'selections'|'valueEdits'|'blockEdits'>>={}) {
  const c=caseOf(k.t,row,{selections:{s2:manual(k.t,'s2','b3')},...parts});
  c.record={dataset:data.id,version:data.version,row:index,sha256:sha256Hex(canonicalStudioJson(row))};
  return c;
}
function generated(result:StudioGenerateResult):Generated {
  assert(result.ok,JSON.stringify(result.report.issues.filter(issue=>issue.severity==='error')));
  assert.equal(result.dryRun,false);return result as Generated;
}
function output(result:Generated):Uint8Array {assert(result.output instanceof Uint8Array);return result.output;}
const direct=(k:NoticeKit,row:Record<string,unknown>,c?:StudioCase)=>generateFromTemplate(k.bytes,k.t,row,c,loaderOf(k.blobs),{mode:'baseline'});
function paragraphAt(bytes:Uint8Array,path:number[]):ParagraphNode {
  let list=parseDocument(openPackage(bytes)).sections[0]!.paragraphs;
  for(let i=0;i<path.length-1;i+=2)list=list[path[i]!]!.subLists[path[i+1]!]!.paragraphs;
  const p=list[path.at(-1)!];assert(p);return p;
}
const allText=(bytes:Uint8Array)=>parseDocument(openPackage(bytes)).sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>p.logicalText)).join('\n');
function snapshot(db:DatabaseSync) {
  return ['studio_template','studio_proto','studio_dataset','studio_blob'].map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all().map(row=>({...row,...('bytes' in row?{bytes:Buffer.from(row.bytes as Uint8Array)}:{})})));
}
function sameAsDirect(actual:Generated,expected:Generated) {
  assert.deepEqual(output(actual),output(expected));assert.deepEqual(actual.report,expected.report);assert.deepEqual(actual.ledger,expected.ledger);
}
function assertNoOutput(result:StudioGenerateResult,expected:string) {
  assert.equal(result.ok,false);assert.equal(Object.hasOwn(result,'output'),false);
  assert(result.report.issues.some(issue=>issue.severity==='error'&&issue.code===expected),JSON.stringify(result.report.issues));
}

test('보관함 생성: 합성 공고 41자리·seeded 50행, 공개 엔진 동치·결정성·새 오류 0',t=>temporaryLibrary(state=>{
  const k=kit(),library=state.library(),sourceBefore=Buffer.from(k.bytes),templateBefore=writeStudioTemplate(k.t);
  const blobsBefore=new Map([...k.blobs].map(([sha,bytes])=>[sha,Buffer.from(bytes)]));
  assert.equal(k.t.places.length,41);assert.equal(k.t.slots.length,4);
  const next=rng(0x2500c0de),prices=[1,60000000,150000000];
  const rows=Array.from({length:50},(_,index)=>{
    const row=recordFor(name=>'SYNTH_'+index+'_'+name+': '+longValue(next,400,700)+'\n여러 문장을 검증합니다. 둘째 문장 & <확인> "인용".\t탭 뒤 문장.',{price:prices[index%3],sme:index%2?'Y':'N'});
    row['사유 설명']=0;row['소속']=index%2===0?false:true;row['공고번호']='00'+String(index).padStart(6,'0');return row;
  });
  assert(rows.every(row=>typeof row['사업명']==='string'&&row['사업명'].length>400));
  saveTemplate(library,k);
  const document=JSON.stringify(rows,null,2),data=library.saveDataset({name:'합성 스트레스 데이터',content:document});
  assert.equal(data.records,50);
  const before=snapshot(state.db()),baseline=validateDocument(k.bytes);
  let gates=0,filled=0,comparisons=0,pairs=0,newErrors=0,headerChecks=0,tableChecks=0,bodyChecks=0;
  for(let index=0;index<rows.length;index++) {
    const row=rows[index]!,block=index%2?'b4':'b3',c=savedCase(k,row,data,index,{selections:{s2:manual(k.t,'s2',block)}});
    const stored=library.saveCase({document:writeCase(c)});
    const a=generated(library.generate(k.t.id,k.t.version,data.id,data.version,index,stored.id));
    const b=generated(library.generate(k.t.id,k.t.version,data.id,data.version,index,stored.id));
    sameAsDirect(a,generated(direct(k,row,c)));comparisons++;sameAsDirect(b,a);pairs++;
    for(const result of [a,b]) {
      const bytes=output(result),errors=compareToBaseline(baseline,validateDocument(bytes)).newErrors;
      assert.deepEqual(result.report.validation?.newErrors,[]);assert.deepEqual(errors,[]);
      assert.equal(result.report.skipped.length,0);assert.equal(result.ledger?.counts.skipped,0);
      assert(result.ledger);
      const applied=result.ledger.actions.filter(action=>action.type==='fill').reduce((count,action)=>count+action.targets,0);
      assert(applied>=30,'주입 대상이 수십 곳이어야 한다');
      assert.equal(result.report.selections.find(s=>s.slot==='s2')?.state,'manual');
      assert.equal(result.report.selections.find(s=>s.slot==='s2')?.block,block);
      assert(paragraphAt(bytes,[0,0,0]).logicalText.startsWith(String(row['낱말 머리말'])));headerChecks++;
      assert.equal(paragraphAt(bytes,[12,2,0]).logicalText,String(row['칸 첫 표']));tableChecks++;
      const mapped=remapAddress(result.report.moves,{sectionIndex:0,path:[44]});assert(mapped);
      assert(paragraphAt(bytes,mapped.path).logicalText.includes(String(row['낱말 범위 뒤'])));bodyChecks++;
      assert(allText(bytes).includes(String(row['공고번호'])),'앞자리 0 보존');
      assert.equal(result.ledger!.record.sha256,sha256Hex(canonicalStudioJson(row)));
      gates++;filled+=applied;newErrors+=errors.length;
    }
  }
  const first=library.dataset(data.id,data.version).records[0]!;assert('dataset' in first);
  assert.equal(first.dataset.data['사유 설명'],0);assert.equal(first.dataset.data['소속'],false);assert.equal(first.dataset.data['공고번호'],'00000000');
  assert.equal(library.dataset(data.id,data.version).document,document);assert.deepEqual(snapshot(state.db()),before);
  assert.deepEqual(Buffer.from(k.bytes),sourceBefore);assert.equal(writeStudioTemplate(k.t),templateBefore);
  assert.deepEqual(Buffer.from(library.source(k.t.id,k.t.version)),sourceBefore);
  for(const [sha,bytes] of blobsBefore){assert.deepEqual(Buffer.from(library.blob(sha)),bytes);assert.deepEqual(Buffer.from(k.blobs.get(sha)!),bytes);}
  assert.equal(gates,100);assert.equal(comparisons,50);assert.equal(pairs,50);assert.equal(newErrors,0);
  assert.equal(headerChecks,100);assert.equal(tableChecks,100);assert.equal(bodyChecks,100);
  t.diagnostic('seed=0x2500c0de; rows=50; registered_places=41; library_gates=100; direct_engine_comparisons=50; deterministic_pairs=50; filled='+filled+'; new_errors=0; header/table/body_checks=100/100/100; source/template/data/blob_unchanged=true');
}));

test('보관함 생성: 수동 선택·값/블록 수정은 원본 불변, SQLite 재시작 뒤 생성 복원',t=>temporaryLibrary(state=>{
  const k=kit(),library=state.library(),row=recordFor(name=>'합성 '+name,{price:1,sme:'N'});saveTemplate(library,k);
  const document=JSON.stringify([row]),data=library.saveDataset({name:'합성 재시작 데이터',content:document}),before=snapshot(state.db());
  const next=rng(25),edited='SYNTH_EDIT: '+longValue(next,500,600)+'\n수정 문장 & <확인> "인용".\t탭 끝.';
  const blockText='SYNTH_BLOCK: 이번 건에만 적용되는 계약 문장.\n{{기관명}}\n마지막 문장 & <끝>.';
  const c=savedCase(k,row,data,0,{selections:{s1:manual(k.t,'s1','b1t'),s2:manual(k.t,'s2','b4')},valueEdits:{[k.valueId('기관명')]:edited},blockEdits:{b4:{text:blockText}}});
  const caseBefore=writeCase(c),templateBefore=writeStudioTemplate(k.t),stored=library.saveCase({document:caseBefore});
  const first=generated(library.generate(k.t.id,k.t.version,data.id,data.version,0,stored.id));
  sameAsDirect(first,generated(direct(k,row,c)));
  const manualSelection=first.report.selections.find(s=>s.slot==='s1');
  assert.equal(manualSelection?.block,'b1t');assert.equal(manualSelection?.state,'manual');assert.equal(manualSelection?.differs,true);
  assert.equal(first.report.values.find(value=>value.id===k.valueId('기관명'))?.state,'edited');
  const text=allText(output(first));assert(text.includes(edited));assert.equal(text.split('SYNTH_BLOCK:').length-1,2);
  assert.equal(library.case(stored.id).document,caseBefore);assert.equal(library.case(stored.id).revision,1);
  assert.equal(writeCase(c),caseBefore);assert.equal(writeStudioTemplate(k.t),templateBefore);assert.deepEqual(snapshot(state.db()),before);
  state.restart();const restored=state.library(),after=generated(restored.generate(k.t.id,k.t.version,data.id,data.version,0,stored.id));
  sameAsDirect(after,first);assert.equal(restored.case(stored.id).document,caseBefore);assert.equal(restored.case(stored.id).revision,1);
  assert.equal(restored.dataset(data.id,data.version).document,document);assert.deepEqual(snapshot(state.db()),before);
  const amended={...c,valueEdits:{...c.valueEdits,[k.valueId('기관명')]:edited+'\n추가 정정 문장.'}};
  const revision=restored.saveCase({id:stored.id,document:writeCase(amended)});
  assert.equal(revision.id,stored.id);assert.equal(revision.revision,2);
  const changed=generated(restored.generate(k.t.id,k.t.version,data.id,data.version,0,stored.id));
  sameAsDirect(changed,generated(direct(k,row,amended)));assert.notDeepEqual(output(changed),output(first));assert.deepEqual(snapshot(state.db()),before);
  t.diagnostic('restarted_case_generation=1; case_revision=2; manual_override/valueEdits/blockEdits_restored=true; source/template/dataset_unchanged=true');
}));

test('보관함 생성: 미확정·누락값·금액 오류·재확인·미등록 자리는 실패하고 output이 없다',t=>temporaryLibrary(state=>{
  const k=kit(),library=state.library();saveTemplate(library,k);
  const valid=recordFor(name=>'합성 '+name,{price:60000000}),missing={...valid},bad={...valid};
  delete missing['장소'];bad['예정가격']='1,234';
  const data=library.saveDataset({name:'합성 실패 데이터',content:JSON.stringify([valid,missing,bad])}),before=snapshot(state.db());
  assertNoOutput(library.generate(k.t.id,k.t.version,data.id,data.version,0),'SEL_UNDECIDED');
  for(const [index,expected] of [[1,'DATA_MISSING'],[2,'DATA_FORMAT']] as const) {
    const row=index===1?missing:bad,c=savedCase(k,row,data,index),stored=library.saveCase({document:writeCase(c)});
    const actual=library.generate(k.t.id,k.t.version,data.id,data.version,index,stored.id);
    assertNoOutput(actual,expected);assert.deepEqual(actual,direct(k,row,c));
  }
  const stale=savedCase(k,valid,data,0);stale.selections.s2={...stale.selections.s2!,content:'0'.repeat(64)};
  const staleStored=library.saveCase({document:writeCase(stale)}),recheck=library.generate(k.t.id,k.t.version,data.id,data.version,0,staleStored.id);
  assertNoOutput(recheck,'SEL_RECHECK');assert.deepEqual(recheck,direct(k,valid,stale));
  const unregistered=savedCase(k,valid,data,0,{blockEdits:{b8:{text:'합성 {{미등록}} 블록'}}});
  const unregisteredStored=library.saveCase({document:writeCase(unregistered)}),failure=library.generate(k.t.id,k.t.version,data.id,data.version,0,unregisteredStored.id);
  assertNoOutput(failure,'PLACE_UNREGISTERED');assert.deepEqual(failure,direct(k,valid,unregistered));assert.deepEqual(snapshot(state.db()),before);
  t.diagnostic('blocked_generation_results=5; failed_results_with_output=0; source/template/dataset/blob_unchanged=true');
}));

test('보관함 생성: 데이터 판·행·해시가 맞지 않는 이번 건 거부와 저장 실패 블롭 취소',()=>temporaryLibrary(state=>{
  const k=kit(),library=state.library(),row=recordFor(name=>'합성 '+name,{price:60000000});saveTemplate(library,k);
  const document=JSON.stringify([row,row]),data=library.saveDataset({name:'합성 참조 데이터',content:document});
  const c=savedCase(k,row,data,0),stored=library.saveCase({document:writeCase(c)});
  assert.throws(()=>library.generate(k.t.id,k.t.version,data.id,data.version,1,stored.id),(error:any)=>error.code==='LIBRARY_INPUT');
  const next=library.saveDataset({name:'합성 참조 데이터',content:document,id:data.id,version:data.version});
  assert.throws(()=>library.generate(k.t.id,k.t.version,data.id,next.version,0,stored.id),(error:any)=>error.code==='LIBRARY_INPUT');
  const wrong={...c,record:{...c.record,sha256:'0'.repeat(64)}},before=snapshot(state.db()),casesBefore=library.cases().length;
  assert.throws(()=>library.saveCase({document:writeCase(wrong),blobs:[base64(new TextEncoder().encode('합성 취소할 블롭'))]}),(error:any)=>error.code==='LIBRARY_INPUT');
  assert.deepEqual(snapshot(state.db()),before);assert.equal(library.cases().length,casesBefore);
  assert.equal(library.dataset(data.id,data.version).document,document);
}));

