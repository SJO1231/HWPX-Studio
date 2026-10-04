import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import {
  bindValues, canonicalStudioJson, compareToBaseline, generateFromTemplate,
  listFields, openPackage, parseDocument, readStudioTemplate, sha256Hex,
  templateSha256, validateDocument, walkParagraphs, writeStudioTemplate,
  type StudioTemplate, type ValueBinding, type StudioGenerateResult,
} from '@hwpx-studio/engine';
import { caseOf, loaderOf, manual, noticeKit, recordFor, type NoticeKit } from '../../../packages/hwpx-engine/test/generate-v2-helpers.ts';
import { longValue, rng } from '../../../packages/hwpx-engine/test/range-helpers.ts';
import { previewMapping, updateMapping } from '../src/mapping.ts';
import { createApp } from '../src/server.ts';
import { importXlsx, listXlsxSheets } from '../src/core.ts';
import { buildZip } from '../../../packages/hwpx-engine/test/helpers.ts';

const json=(value:unknown)=>JSON.stringify(value);
const docOf=(bytes:Uint8Array)=>parseDocument(openPackage(bytes));
function readT(raw:unknown,k?:NoticeKit):StudioTemplate {
  const t=readStudioTemplate(typeof raw==='string'?raw:json(raw),k?{hasBlob:sha=>k.blobs.has(sha)||sha===sha256Hex(k.bytes)}:undefined);
  assert(t.schema==='hwpx-studio/template@2');return t;
}
function inputOf(k:NoticeKit,data:unknown):Record<string,unknown> {
  return {template:json(k.raw),data:json(data),row:0,protos:[],blobs:[k.bytes,...k.blobs.values()].map(bytes=>Buffer.from(bytes).toString('base64'))};
}
function reject(fn:()=>unknown,code:string) {
  assert.throws(fn,(e:unknown)=>typeof e==='object'&&e!==null&&'code' in e&&e.code===code,'정확한 오류 코드 '+code);
}
function sampleT():StudioTemplate {
  const names=['literal','nested','blank','zero','boolean','identifier','missing','money','alias','unbound'];
  return readT({
    schema:'hwpx-studio/template@2',id:'t6000c0de',version:3,source:{kind:'hwpx',sha256:'d'.repeat(64)},
    anchors:[],values:names.map(id=>({id,name:id,format:id==='money'?'money':'text'})),
    bindings:[
      {value:'literal',key:'contact.phone'}, {value:'nested',path:'contact.phone'},
      {value:'blank',key:'빈 텍스트'}, {value:'zero',key:'수치'}, {value:'boolean',key:'불리언'},
      {value:'identifier',key:'문자번호'}, {value:'missing',key:'미존재'}, {value:'money',key:'금액'},
      {value:'alias',key:'기본 열',aliases:['별칭 열']},
    ],
    places:names.filter(id=>id!=='unbound').map((id,i)=>({id:'p'+i,kind:'placeholder',key:id,value:id})),
    slots:[],blocks:[],options:{missing:'error'},
  });
}
const sampleRow=()=>({'contact.phone':'문자 그대로 점 열',contact:{phone:'중첩 경로 값'},'빈 텍스트':'','수치':0,'불리언':false,'문자번호':'00123','금액':120000000,'별칭 열':'별칭 값'});
const smallInput=(data:unknown=sampleRow()):Record<string,unknown>=>({template:json(sampleT()),data:json(data),row:0});
function changedBinding(t:StudioTemplate,id:string,key:string):ValueBinding[] {
  assert(t.bindings.some(b=>b.value===id));return t.bindings.map(b=>b.value===id?{value:id,key}:structuredClone(b));
}

test('데이터 연결: literal 점·공백 열과 중첩 path 구분, 빈값·0·false·문자번호·누락·별칭은 공개 bindValues와 동치',()=>{
  const template=sampleT(),data=sampleRow(),input=smallInput(data),before=json(input),p=previewMapping(input);
  assert.deepEqual(p.values,bindValues(template,data,undefined));assert.equal(p.rows,1);assert.equal(p.row,0);
  assert.equal(p.values.find(v=>v.id==='literal')?.text,'문자 그대로 점 열');assert.equal(p.values.find(v=>v.id==='nested')?.text,'중첩 경로 값');
  assert.deepEqual(['blank','zero','boolean','identifier'].map(id=>p.values.find(v=>v.id===id)?.text),['','0','false','00123']);
  assert.equal(p.values.find(v=>v.id==='blank')?.state,'empty');assert.equal(p.values.find(v=>v.id==='money')?.text,'120,000,000원');
  assert.equal(p.values.find(v=>v.id==='missing')?.issue?.code,'DATA_MISSING');assert.equal(p.values.find(v=>v.id==='unbound')?.state,'missing');
  assert.equal(p.values.find(v=>v.id==='alias')?.source,'alias');
  assert.deepEqual(p.columns,Object.keys(data));assert.deepEqual(p.locations,template.values.map(v=>({value:v.id,places:template.places.filter(place=>place.value===v.id)})));
  assert.equal(json(input),before);
});

test('데이터 연결: 전체 유효행 열 합집합과 선택행 값, dataset 묶음 derived는 v2 원본 행에 병합하지 않는다',()=>{
  const first=sampleRow(),second={...sampleRow(),'추가 열':'둘째 행 전용','contact.phone':'둘째 행 literal'},rows=[first,null,second];
  const input=smallInput(rows),p=previewMapping(input);assert.equal(p.rows,3);
  assert.deepEqual(p.columns,[...Object.keys(first),'추가 열']);assert.deepEqual(p.values,bindValues(sampleT(),first,undefined));
  const next=previewMapping({...input,row:2});assert.deepEqual(next.values,bindValues(sampleT(),second,undefined));assert.equal(next.row,2);
  reject(()=>previewMapping({...input,row:1}),'DATA_SCHEMA');
  const missing={...sampleRow(),'수치':null};delete (missing as Record<string,unknown>)['contact.phone'];delete (missing as Record<string,unknown>)['불리언'];
  const derived={'수치':900,'contact.phone':'파생값','불리언':true,'파생전용':'추가하지 않을 열'};
  for(const data of [
    {schema:'hwpx-studio/dataset@1',data:missing,derived},
    {schema:'hwpx-studio/dataset@1',data:[missing],derived},
  ]) {
    const source=smallInput(data),before=json(source),view=previewMapping(source);
    assert.deepEqual(view.values,bindValues(sampleT(),missing,undefined));
    assert.equal(view.values.find(v=>v.id==='zero')?.state,'missing');assert.equal(view.values.find(v=>v.id==='literal')?.state,'missing');
    assert.equal(view.values.find(v=>v.id==='boolean')?.state,'missing');assert(!view.columns.includes('파생전용'));assert.equal(json(source),before);
  }
});

test('데이터 연결: 임시 연결은 같은 판·id, update만 새 판과 별도 previous, 저장 JSON의 재입력·다른 데이터 재사용',()=>{
  const input=smallInput({...sampleRow(),'새 열.이름':'수정 연결 값'}),before=json(input),original=previewMapping(input);
  const bindings=changedBinding(original.template,'literal','새 열.이름'),bindingBefore=json(bindings);
  const temporary=previewMapping({...input,bindings});assert.equal(temporary.template.version,original.template.version);assert.equal(temporary.template.id,original.template.id);
  assert.equal(temporary.values.find(v=>v.id==='literal')?.text,'수정 연결 값');assert.equal((temporary as Record<string,unknown>).document,undefined);
  const updated=updateMapping({...input,bindings});
  assert.equal(updated.template.id,original.template.id);assert.equal(updated.template.version,original.template.version+1);
  assert.deepEqual(updated.previous,{version:original.template.version,sha256:templateSha256(original.template)});
  assert.equal(updated.document,writeStudioTemplate(updated.template));assert.equal(updated.document,canonicalStudioJson(updated.template));
  assert.equal(JSON.parse(updated.document).previous,undefined);assert(!updated.document.endsWith('\n'));
  const folder=mkdtempSync(join(tmpdir(),'hwpx-mapping-'));
  try {
    const path=join(folder,'synthetic-template.json');writeFileSync(path,updated.document,'utf8');
    const restored=readT(readFileSync(path,'utf8'));assert.deepEqual(restored,updated.template);
    const newData={...sampleRow(),'새 열.이름':'별도 입력 00123 & <확인>'},again=previewMapping({...input,template:readFileSync(path,'utf8'),data:json([newData]),row:0});
    assert.deepEqual(again.values,bindValues(restored,newData,undefined));assert.equal(again.values.find(v=>v.id==='literal')?.text,newData['새 열.이름']);
    assert.deepEqual(again.locations,original.locations);assert.equal(again.template.version,updated.template.version);
  } finally {
    assert(resolve(folder).startsWith(resolve(tmpdir())+sep)&&basename(folder).startsWith('hwpx-mapping-'));rmSync(folder,{recursive:true,force:true});
  }
  assert.equal(json(input),before);assert.equal(json(bindings),bindingBefore);
});

test('데이터 연결: 사용 값의 빈 bindings는 거부·미사용 값은 missing, 잘못된 연결·중복·미존재 참조는 공개 코드로 거부',()=>{
  const input=smallInput(),template=sampleT();
  for(const fn of [previewMapping,updateMapping])reject(()=>fn({...input,bindings:[]}),'TPL_UNBOUND_VALUE');
  const unused={...template,places:[]},unusedInput={...input,template:json(unused)};
  const empty=previewMapping({...unusedInput,bindings:[]}),publicEmpty=readT({...unused,bindings:[]});
  assert.deepEqual(empty.values,bindValues(publicEmpty,sampleRow(),undefined));
  assert(empty.values.every(value=>value.state==='missing'&&value.issue?.code==='DATA_MISSING'));
  const saved=updateMapping({...unusedInput,bindings:[]});assert.deepEqual(saved.template.bindings,[]);assert(saved.values.every(v=>v.state==='missing'));
  for(const invalid of [
    null,'문자열',{},[{value:'literal'}],[{value:'literal',key:'a',path:'a'}],
    [{value:'nested',path:'잘못된 경로'}],[{value:'nested',path:'contact.phone',aliases:['a']}],
    [{value:'literal',key:'a',aliases:['a']}],
    [{value:'literal',key:'a'},{value:'literal',key:'b'}],
  ])for(const fn of [previewMapping,updateMapping])reject(()=>fn({...input,bindings:invalid}),'TPL_FIELD');
  for(const fn of [previewMapping,updateMapping]) {
    reject(()=>fn({...input,bindings:[{value:'absent',key:'a'}]}),'TPL_REF');
    reject(()=>fn({...input,bindings:[{value:'literal',key:'a'},{value:'nested',key:'a'}]}),'TPL_KEY_CONFLICT');
  }
  reject(()=>updateMapping(input),'MAPPING_INPUT');
});

test('데이터 연결: 별칭 충돌·객체·금액 형식·제어 문자·빈 key값은 공개 판정의 오류와 누락을 그대로 표시',()=>{
  const base=sampleRow(),cases=[
    {row:{...base,'기본 열':'다른 값'},id:'alias',code:'DATA_ALIAS_CONFLICT'},
    {row:{...base,'수치':{amount:1}},id:'zero',code:'DATA_NOT_SCALAR'},
    {row:{...base,'금액':'120,000,000'},id:'money',code:'DATA_FORMAT'},
    {row:{...base,'contact.phone':'a\u0001b'},id:'literal',code:'VALUE_CONTROL_CHAR'},
  ];
  for(const row of cases) {
    const p=previewMapping(smallInput(row.row));assert.deepEqual(p.values,bindValues(sampleT(),row.row,undefined));assert.equal(p.values.find(v=>v.id===row.id)?.issue?.code,row.code);
  }
  const nullAlias={...base,'기본 열':null},p=previewMapping(smallInput(nullAlias));assert.equal(p.values.find(v=>v.id==='alias')?.source,'alias');
  const empty={...base,'기본 열':'','별칭 열':null},blank=previewMapping(smallInput(empty));assert.equal(blank.values.find(v=>v.id==='alias')?.state,'empty');
});

test('데이터 연결 입력: 행 타입·범위·JSON·묶음·원형·base64 오류는 정확한 코드로 거부',()=>{
  const input=smallInput([sampleRow(),sampleRow()]),before=json(input);
  for(const row of [-1,2,0.5,NaN,Infinity,null,false,'',[],{},'0',undefined])reject(()=>previewMapping({...input,row}),'MAPPING_INPUT');
  for(const data of ['{','[]','null','42','"문자열"'])reject(()=>previewMapping({...input,data}),'MAPPING_INPUT');
  reject(()=>previewMapping({...input,data:json({schema:'hwpx-studio/dataset@1',data:[],derived:42})}),'DATA_SCHEMA');
  reject(()=>previewMapping({...input,template:'{'}),'TPL_JSON');reject(()=>previewMapping({...input,protos:['{']}),'TPL_JSON');
  reject(()=>previewMapping({...input,blobs:['!!!']}),'MAPPING_INPUT');reject(()=>previewMapping({...input,blobs:'bad'}),'MAPPING_INPUT');
  reject(()=>previewMapping({...input,protos:'bad'}),'MAPPING_INPUT');assert.equal(json(input),before);
});

test('데이터 연결 원본·조각·원형: 문서 원본 없어도 평가, 참조 조각 누락·다른 원형 내용·깨진 조각은 거부',()=>{
  const k=noticeKit(),data=recordFor(name=>'SYNTH_'+name),input=inputOf(k,[data]),before=json(input);
  const sourceMissing={...input,blobs:[...k.blobs.values()].map(b=>Buffer.from(b).toString('base64'))};
  const p=previewMapping(sourceMissing);assert.deepEqual(p.values,bindValues(k.t,data,undefined));
  reject(()=>previewMapping({...input,blobs:[]}),'TPL_FRAGMENT_MISSING');
  const raw=structuredClone(k.t),block=raw.blocks.find(b=>b.id==='b2');assert(block);block.proto={id:'k6000cafe',version:1};
  const matching={schema:'hwpx-studio/block-proto@1',id:'k6000cafe',version:1,name:'합성 원형',content:structuredClone(block.content),keys:['사업명','담당자 이름','연락처']};
  reject(()=>previewMapping({...input,template:json(raw)}),'TPL_PROTO_MISMATCH');
  const different={...matching,content:{text:'다른 내용'}};
  reject(()=>previewMapping({...input,template:json(raw),protos:[json(different)]}),'TPL_PROTO_MISMATCH');
  reject(()=>previewMapping({...input,template:json(raw),protos:[json(matching),json(different)]}),'MAPPING_INPUT');
  const matched=previewMapping({...input,template:json(raw),protos:[json(matching)]});assert.deepEqual(matched.values,bindValues(raw,data,undefined));
  const broken=new TextEncoder().encode('{}'),sha=sha256Hex(broken),bad=structuredClone(k.t),b1=bad.blocks.find(b=>b.id==='b1');assert(b1);b1.content={fragment:sha};
  reject(()=>previewMapping({...input,template:json(bad),blobs:[...(input.blobs as string[]),Buffer.from(broken).toString('base64')]}),'FRAG_SCHEMA');
  assert.equal(json(input),before);
});

test('데이터 연결 생성: seeded50행×2회 바인딩·공개 엔진 동치·41자리·본문/표/머리말·비적용 값 불변·새 오류0',t=>{
  const k=noticeKit(),next=rng(0x6a11cafe),business=k.valueId('사업명'),raw=structuredClone(k.t),block=raw.blocks.find(b=>b.id==='b2');assert(block);
  const proto={schema:'hwpx-studio/block-proto@1',id:'k6000cafe',version:1,name:'합성 일반 원형',content:structuredClone(block.content),keys:['사업명','담당자 이름','연락처']};
  block.proto={id:proto.id,version:proto.version};
  const rows=Array.from({length:50},(_,index)=>{
    const row=recordFor(name=>'SYNTH_'+index+'_'+name+' '+longValue(next,400,700)+'\n둘째 문장 & <확인> "인용".\t셋째 문장.',{price:[0,49999999,50000000,99999999,100000000,100000001][index%6],sme:index%3===0?'Y':'N'});
    row['사업명']='SYNTH_OLD_BUSINESS_'+index;row['새 사업.명']='SYNTH_NEW_BUSINESS_'+index+' '+longValue(next,400,700)+'\n별도 문장 & <확인>.\t탭 뒤 문장.';
    row['부가세']=0;row['소속']=false;row['공고번호']='00'+String(index).padStart(6,'0');return row;
  });
  const bindings=changedBinding(raw,business,'새 사업.명'),input=inputOf(k,rows);input.template=json(raw);input.protos=[json(proto)];
  const inputBefore=json(input),bindingsBefore=json(bindings),sourceBefore=Buffer.from(k.bytes),blobsBefore=[...k.blobs].map(([sha,bytes])=>[sha,Buffer.from(bytes)] as const),baseline=validateDocument(k.bytes);
  const updated=updateMapping({...input,bindings}),expectedT=readStudioTemplate(writeStudioTemplate({...raw,bindings,version:raw.version+1}),{hasBlob:sha=>k.blobs.has(sha),lookupProto:(id,version)=>id===proto.id&&version===proto.version?proto.content:undefined});
  assert(expectedT.schema==='hwpx-studio/template@2');assert.deepEqual(updated.template,expectedT);assert.equal(updated.template.places.length,41);
  let boundChecks=0,gates=0,targets=0,pairs=0,directChecks=0,outsideChecks=0,bodyChecks=0,tableChecks=0,headerChecks=0,newErrors=0;
  for(let index=0;index<rows.length;index++) {
    const row=rows[index]!,request={...input,template:updated.document,row:index},a=previewMapping(request),b=previewMapping(request);
    assert.deepEqual(a,b);assert.deepEqual(a.values,bindValues(expectedT,row,undefined));assert.deepEqual(b.values,bindValues(expectedT,row,undefined));boundChecks+=2;
    assert.equal(a.values.find(v=>v.id===business)?.text,row['새 사업.명']);
    const selected=index%2===0?'b3':'b4',c=caseOf(a.template,row,{selections:{s2:manual(a.template,'s2',selected)}});c.record.sha256=sha256Hex(canonicalStudioJson(row));
    const first=generateFromTemplate(k.bytes,a.template,row,c,loaderOf(k.blobs),{mode:'baseline'}),second=generateFromTemplate(k.bytes,b.template,row,c,loaderOf(k.blobs),{mode:'baseline'});
    assert(first.ok&&!first.dryRun&&first.output instanceof Uint8Array,JSON.stringify(first.report.issues));assert(second.ok&&!second.dryRun&&second.output instanceof Uint8Array,JSON.stringify(second.report.issues));
    assert.deepEqual(first,second);pairs++;
    const direct:StudioGenerateResult=generateFromTemplate(k.bytes,expectedT,row,c,loaderOf(k.blobs),{mode:'baseline'});assert.deepEqual(first,direct);directChecks++;
    const oldCase=caseOf(raw,row,{selections:{s2:manual(raw,'s2',selected)}});oldCase.record.sha256=c.record.sha256;
    const old=generateFromTemplate(k.bytes,raw,row,oldCase,loaderOf(k.blobs),{mode:'baseline'});assert(old.ok&&!old.dryRun&&old.output instanceof Uint8Array,JSON.stringify(old.report.issues));
    const oldFields=listFields(docOf(old.output));
    assert(first.ledger);const fillCount=first.ledger.actions.filter(action=>action.type==='fill').reduce((n,action)=>n+action.targets,0);assert(fillCount>=30);
    for(const result of [first,second]) {
      assert(result.ok&&!result.dryRun&&result.output instanceof Uint8Array);
      const doc=docOf(result.output),fields=listFields(doc),changed=fields.filter(f=>f.mergeKey==='사업명');assert(changed.length>=2);assert(changed.every(f=>f.valueText===row['새 사업.명']));
      const unrelated=(list:typeof fields)=>list.filter(f=>f.mergeKey!=='사업명').map(f=>[f.type,f.name,f.mergeKey,f.occurrence,f.sectionIndex,f.path,f.valueText,f.dirty,f.shape]);
      assert.deepEqual(unrelated(fields),unrelated(oldFields));
      const paragraphs=(bytes:Uint8Array,needle:string)=>docOf(bytes).sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>[p.path,p.logicalText.replaceAll(needle,'SYNTH_BUSINESS_TOKEN')]));
      assert.deepEqual(paragraphs(result.output,row['새 사업.명'] as string),paragraphs(old.output,row['사업명'] as string));outsideChecks++;
      assert(fields.some(f=>f.path.length===1&&f.valueText.length>400));bodyChecks++;
      const tablePaths=doc.sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].flatMap(p=>p.subLists.filter(list=>list.owner==='tc').flatMap(list=>[...walkParagraphs(list.paragraphs)].map(p=>json(p.path)))));
      assert(fields.some(f=>tablePaths.includes(json(f.path))&&f.valueText.length>400));tableChecks++;
      const header=doc.sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].flatMap(p=>p.subLists.filter(list=>list.owner==='header').flatMap(list=>[...walkParagraphs(list.paragraphs)].map(p=>p.logicalText))));
      assert(header.some(text=>text.includes(row['새 사업.명'] as string)));headerChecks++;
      for(const [kind,key,expected] of [['MAILMERGE','부가세','0'],['CLICK_HERE','소속','false'],['MAILMERGE','공고번호',row['공고번호']]] as const) {
        const exact=fields.filter(f=>f.type===kind&&(kind==='MAILMERGE'?f.mergeKey:f.name)===key);assert(exact.length>=1);assert(exact.every(f=>f.valueText===expected));
      }
      const errors=compareToBaseline(baseline,validateDocument(result.output)).newErrors;assert.deepEqual(errors,[]);assert.deepEqual(result.report.validation?.newErrors,[]);
      gates++;targets+=fillCount;newErrors+=errors.length;
    }
  }
  assert.equal(boundChecks,100);assert.equal(gates,100);assert.equal(pairs,50);assert.equal(directChecks,50);assert.equal(outsideChecks,100);
  assert.equal(bodyChecks,100);assert.equal(tableChecks,100);assert.equal(headerChecks,100);assert(targets>=3000);assert.equal(newErrors,0);
  assert.deepEqual(Buffer.from(k.bytes),sourceBefore);for(const [sha,bytes] of blobsBefore)assert.deepEqual(Buffer.from(k.blobs.get(sha)!),bytes);
  assert.equal(json(input),inputBefore);assert.equal(json(bindings),bindingsBefore);
  t.diagnostic('scope=synthetic; seed=0x6a11cafe; declared_places=41; rows=50; bind_comparisons=100; gates=100; fill_targets='+targets+'; direct_engine_comparisons=50; deterministic_pairs=50; outside_target_checks=100; body/table/header_checks=100/100/100; new_errors=0; source/data/template/proto/blobs_unchanged=true; actual_data/UI/SQLite_migration/Hancom=unverified');
});

async function withServer(run:(base:string)=>Promise<void>) {
  const server=createApp();
  const base=await new Promise<string>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{const address=server.address();assert(address&&typeof address==='object');done('http://127.0.0.1:'+address.port);});});
  try {await run(base);}finally {await new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()));}
}
function postApi(base:string,path:string,input:unknown,origin=base):Promise<{status:number;headers:IncomingHttpHeaders;body:Buffer}> {
  const body=Buffer.from(json(input));
  return new Promise((done,fail)=>{
    const req=httpRequest(new URL('/api/'+path,base),{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'Content-Length':body.length}},response=>{
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.once('error',fail);
      response.once('end',()=>done({status:response.statusCode!,headers:response.headers,body:Buffer.concat(chunks)}));
    });req.once('error',fail);req.end(body);
  });
}

test('데이터 연결 HTTP: 실제 preview/update200·새판 정규JSON 파일 복원·공개 모델 동치와 잘못된 입력/출처 거부',async()=>withServer(async base=>{
  const input=smallInput({...sampleRow(),'새 열.이름':'HTTP 연결 값'}),before=json(input),preview=await postApi(base,'mapping/preview',input);
  assert.equal(preview.status,200);assert(preview.headers['content-type']?.startsWith('application/json'));
  const p=JSON.parse(preview.body.toString('utf8')) as ReturnType<typeof previewMapping>;assert.deepEqual(p,previewMapping(input));
  const bindings=changedBinding(p.template,'literal','새 열.이름'),temporary=await postApi(base,'mapping/preview',{...input,bindings});assert.equal(temporary.status,200);
  const temp=JSON.parse(temporary.body.toString('utf8')) as ReturnType<typeof previewMapping>;assert.equal(temp.template.version,p.template.version);assert.equal(temp.values.find(v=>v.id==='literal')?.text,'HTTP 연결 값');
  const response=await postApi(base,'mapping/update',{...input,bindings});assert.equal(response.status,200);
  const updated=JSON.parse(response.body.toString('utf8')) as ReturnType<typeof updateMapping>;assert.deepEqual(updated,updateMapping({...input,bindings}));
  assert.equal(updated.document,canonicalStudioJson(updated.template));assert.equal(updated.template.version,p.template.version+1);
  assert.deepEqual(updated.previous,{version:p.template.version,sha256:templateSha256(p.template)});assert.equal(JSON.parse(updated.document).previous,undefined);
  const folder=mkdtempSync(join(tmpdir(),'hwpx-mapping-http-'));
  try {
    const path=join(folder,'synthetic-template.json');writeFileSync(path,updated.document,'utf8');
    const publicTemplate=readT(readFileSync(path,'utf8'));assert.deepEqual(publicTemplate,updated.template);
    const data={...sampleRow(),'새 열.이름':'HTTP 재사용 000123'},restore=await postApi(base,'mapping/preview',{...input,template:readFileSync(path,'utf8'),data:json([data]),row:0});
    assert.equal(restore.status,200);const restored=JSON.parse(restore.body.toString('utf8')) as ReturnType<typeof previewMapping>;
    assert.deepEqual(restored.values,bindValues(publicTemplate,data,undefined));assert.equal(restored.values.find(v=>v.id==='literal')?.text,data['새 열.이름']);
    assert.deepEqual(restored.locations,p.locations);
  } finally {
    assert(resolve(folder).startsWith(resolve(tmpdir())+sep)&&basename(folder).startsWith('hwpx-mapping-http-'));rmSync(folder,{recursive:true,force:true});
  }
  for(const [change,code] of [[{row:null},'MAPPING_INPUT'],[{template:'{'},'TPL_JSON']] as const) {
    const bad=await postApi(base,'mapping/preview',{...input,...change});assert.equal(bad.status,400);
    const error=JSON.parse(bad.body.toString('utf8'));assert.equal(error.code,code);assert.equal(error.template,undefined);assert.equal(error.values,undefined);
  }
  const foreign=await postApi(base,'mapping/update',{...input,bindings},'https://example.invalid');assert.equal(foreign.status,403);assert.equal(JSON.parse(foreign.body.toString('utf8')).document,undefined);
  assert.equal(json(input),before);
}));

const xlsxXml=(rows:string)=>'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows+'</sheetData></worksheet>';
const xlsxInline=(cell:string,text:string)=>'<c r="'+cell+'" t="inlineStr"><is><t>'+text+'</t></is></c>';
function retryWorkbook(malformed=false) {
  const files=['sheet9.xml','sheet7.xml','sheet2.xml'],names=['SYNTH_GUIDE','SYNTH_INVALID','SYNTH_VALID'];
  const book='<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+names.map((name,i)=>'<sheet name="'+name+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>';
  const relations='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+files.map((file,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/'+file+'"/>').join('')+'</Relationships>';
  const xml=[
    xlsxXml('<row r="1">'+xlsxInline('A1','안내')+'</row><row r="2">'+xlsxInline('A2','SYNTH_GUIDE_VALUE')+'</row>'),
    xlsxXml('<row r="1">'+xlsxInline('A1','중복')+xlsxInline('B1','중복')+'</row><row r="2">'+xlsxInline('A2','첫 값')+xlsxInline('B2','둘째 값')+'</row>'),
    xlsxXml('<row r="1">'+xlsxInline('A1','수치')+xlsxInline('B1','불리언')+xlsxInline('C1','문자번호')+xlsxInline('D1','빈 텍스트')+'</row><row r="2"><c r="A2"><v>0</v></c><c r="B2" t="b"><v>0</v></c>'+xlsxInline('C2','000123')+'<c r="D2"/></row>'),
  ];
  const entries=[{name:'xl/workbook.xml',text:malformed?'<workbook':book},{name:'xl/_rels/workbook.xml.rels',text:relations},...files.map((file,i)=>({name:'xl/worksheets/'+file,text:xml[i]!}))];
  return buildZip(entries.map(entry=>({name:entry.name,data:new TextEncoder().encode(entry.text),method:8 as const})));
}

test('데이터 연결 HTTP: XLSX 목록200→기본 둘째 헤더거부400→셋째 수동선택200·타입보존·잘못된ZIP/XML거부',async()=>withServer(async base=>{
  const bytes=retryWorkbook(),before=Buffer.from(bytes),input={name:'synthetic.xlsx',content:Buffer.from(bytes).toString('base64')},snapshot=json(input);
  const listed=await postApi(base,'xlsx-sheets',input);assert.equal(listed.status,200);
  const sheets=listXlsxSheets(bytes);assert.equal(sheets.length,3);assert.deepEqual(JSON.parse(listed.body.toString('utf8')),{sheets});
  const failed=await postApi(base,'import-data',input);assert.equal(failed.status,400);assert.equal(JSON.parse(failed.body.toString('utf8')).records,undefined);
  const retryList=await postApi(base,'xlsx-sheets',input);assert.equal(retryList.status,200);assert.deepEqual(JSON.parse(retryList.body.toString('utf8')),{sheets});
  const third=await postApi(base,'import-data',{...input,sheetIndex:2});assert.equal(third.status,200);
  const result=JSON.parse(third.body.toString('utf8')) as ReturnType<typeof importXlsx>;assert.deepEqual(result,importXlsx(bytes,2));
  assert.deepEqual(result.records,[{수치:0,불리언:false,문자번호:'000123','빈 텍스트':''}]);assert.equal(result.selectedSheet,2);assert.deepEqual(result.sheets,sheets);assert.deepEqual(result.warnings,[]);
  const mapped=await postApi(base,'mapping/preview',smallInput(result.records));assert.equal(mapped.status,200);
  const values=(JSON.parse(mapped.body.toString('utf8')) as ReturnType<typeof previewMapping>).values;
  assert.deepEqual(['zero','boolean','identifier','blank'].map(id=>values.find(v=>v.id===id)?.text),['0','false','000123','']);
  const guide=await postApi(base,'import-data',{...input,sheetIndex:0});assert.equal(guide.status,400);assert.equal(JSON.parse(guide.body.toString('utf8')).records,undefined);
  for(const [content,code] of [[new TextEncoder().encode('SYNTH_NOT_ZIP'),'PKG_NOT_ZIP'],[retryWorkbook(true),'XML_MALFORMED']] as const) {
    const response=await postApi(base,'xlsx-sheets',{name:'synthetic.xlsx',content:Buffer.from(content).toString('base64')});assert.equal(response.status,400);
    const error=JSON.parse(response.body.toString('utf8'));assert.equal(error.code,code);assert.equal(error.sheets,undefined);
  }
  const wrongType=await postApi(base,'xlsx-sheets',{...input,name:'synthetic.json'});assert.equal(wrongType.status,400);assert.equal(JSON.parse(wrongType.body.toString('utf8')).sheets,undefined);
  assert.deepEqual(Buffer.from(bytes),before);assert.equal(json(input),snapshot);
}));
