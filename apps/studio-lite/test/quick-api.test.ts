import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyTemplate, generate, openPackage, parseDocument, readTemplate } from '@hwpx-studio/engine';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { createApp } from '../src/server.ts';

const P=(inner:string)=>`<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${inner}</hp:p>`;
const R=(inner:string,charPr='0')=>`<hp:run charPrIDRef="${charPr}">${inner}</hp:run>`;
const T=(value:string)=>`<hp:t>${value}</hp:t>`;
const synth=(paragraphs:string[])=>buildHwpx([P(R(T('합성 고정 문단')))+paragraphs.join('')]);

async function withServer(run:(base:string)=>Promise<void>) {
  const server=createApp();
  const base=await new Promise<string>(done=>server.listen(0,'127.0.0.1',()=>done(`http://127.0.0.1:${(server.address() as any).port}`)));
  try {await run(base);}finally {await new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));}
}
const post=(base:string,path:string,input:unknown)=>fetch(base+'/api/quick/'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(input)});
const upload=async(base:string,bytes:Uint8Array)=>{
  const response=await post(base,'template',{name:'합성.hwpx',content:Buffer.from(bytes).toString('base64')});
  assert.equal(response.status,200);return response.json() as Promise<any>;
};
const request=(paragraphIndex:number,text:string,charOffset=3)=>({from:{position:{sectionIndex:0,paragraphIndex,charOffset},shown:{text,start:0}}});
const originalOf=async(base:string,session:string)=>{
  const response=await fetch(base+'/api/quick/source?session='+encodeURIComponent(session));assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());
};
const resultOf=(base:string,session:string)=>fetch(base+'/api/quick/result?session='+encodeURIComponent(session)+'&index=0');
const paragraphs=(bytes:Uint8Array)=>parseDocument(openPackage(bytes)).sections[0].paragraphs.map(p=>p.logicalText);

async function assignedSource(base:string) {
  const bytes=synth([P(R(T('앞 원래값 뒤'))),P(R(T('바깥 문단 유지')))]),uploaded=await upload(base,bytes);
  const session=uploaded.session as string;
  const data=await post(base,'data',{session,content:JSON.stringify({replacement:'주입값'})});assert.equal(data.status,200);
  const located=await post(base,'locate',{session,request:request(1,'앞 원래값 뒤')});assert.equal(located.status,200);
  const selection=await located.json() as any;
  assert.equal(selection.location.precision,'char');assert.deepEqual(selection.location.address,{sectionIndex:0,path:[1],offset:3});
  const draft=selection.location.drafts.findIndex((d:any)=>d.anchor.kind==='word');assert(draft>=0);
  const assigned=await post(base,'assign',{session,selection:selection.selection,draft,path:'replacement'});assert.equal(assigned.status,200);
  const assignments=(await assigned.json() as any).assignments;
  assert.equal(assignments.length,1);assert.deepEqual(assignments[0].anchor,selection.location.drafts[draft].anchor);
  assert.equal(assignments[0].anchor.print.text,'원래값');
  return {bytes,session,selection,assignments};
}

test('Lite 빠른 생성 HTTP: 뷰어 지정과 엔진 대상 일치, 지정 해제는 문서 내용을 삭제하지 않는다',async()=>withServer(async base=>{
  const {bytes,session,assignments}=await assignedSource(base);
  assert.deepEqual(await originalOf(base,session),Buffer.from(bytes));
  const made=await post(base,'generate',{session,missing:'error'});assert.equal(made.status,200);
  const report=await made.json() as any;assert.equal(report.results.length,1);assert.equal(report.results[0].ok,true);assert.equal(report.results[0].filled,1);
  const downloaded=await resultOf(base,session);assert.equal(downloaded.status,200);
  const output=new Uint8Array(await downloaded.arrayBuffer());
  assert.deepEqual(paragraphs(output),[paragraphs(bytes)[0],'앞 주입값 뒤','바깥 문단 유지']);
  const template=emptyTemplate();template.anchors.push({...assignments[0].anchor,id:'expected'});
  template.rules.push({id:'expected',do:{type:'fill',anchor:'expected',value:{path:'replacement'}}});
  const expected=generate(bytes,readTemplate(template),{data:{replacement:'주입값'},derived:{}},{mode:'baseline',missing:'error'});
  assert(expected.ok&&!expected.dryRun);assert.deepEqual(output,expected.output);
  const cleared=await post(base,'clear',{session,id:assignments[0].id});assert.equal(cleared.status,200);assert.deepEqual(await cleared.json(),{assignments:[]});
  assert.equal((await resultOf(base,session)).status,404);assert.deepEqual(await originalOf(base,session),Buffer.from(bytes));
  const after=await post(base,'generate',{session,missing:'error'});assert.equal(after.status,200);
  const body=await after.json() as any;assert.equal(body.results[0].ok,false);assert(body.results[0].errors.some((e:any)=>e.code==='FILL_NOTHING_APPLIED'));
  assert.equal((await resultOf(base,session)).status,404);assert.deepEqual(await originalOf(base,session),Buffer.from(bytes));
}));

test('Lite 빠른 생성 HTTP: 잘못된 교체 데이터는 이전 생성물과 데이터 적용 상태를 무효화한다',async()=>withServer(async base=>{
  const {bytes,session}=await assignedSource(base);
  assert.equal((await post(base,'generate',{session,missing:'error'})).status,200);assert.equal((await resultOf(base,session)).status,200);
  const invalid=await post(base,'data',{session,content:'{broken json'});assert.equal(invalid.status,400);
  assert.equal((await resultOf(base,session)).status,404);assert.deepEqual(await originalOf(base,session),Buffer.from(bytes));
  const noData=await post(base,'generate',{session,missing:'error'});assert.equal(noData.status,400);
  const missing=await post(base,'data',{session,content:JSON.stringify({other:'없는 연결 값'})});assert.equal(missing.status,200);
  const failed=await post(base,'generate',{session,missing:'error'});assert.equal(failed.status,200);
  assert.equal((await failed.json() as any).results[0].ok,false);assert.equal((await resultOf(base,session)).status,404);
  const valid=await post(base,'data',{session,content:JSON.stringify({replacement:0})});assert.equal(valid.status,200);
  const made=await post(base,'generate',{session,missing:'error'});assert.equal(made.status,200);assert.equal((await made.json() as any).results[0].ok,true);
  const output=await resultOf(base,session);assert.equal(output.status,200);assert.equal(paragraphs(new Uint8Array(await output.arrayBuffer()))[1],'앞 0 뒤');
}));

test('Lite 빠른 생성 HTTP: 다른 세션 선택·위조 초안·여러 문단 범위로 임의 자리를 연결하지 않는다',async()=>withServer(async base=>{
  const sourceA=synth([P(R(T('앞 첫째값 뒤'))),P(R(T('다른 문단')))]),sourceB=synth([P(R(T('앞 둘째값 뒤')))]);
  const first=await upload(base,sourceA),second=await upload(base,sourceB);
  assert.notEqual(first.session,second.session);
  const response=await post(base,'locate',{session:first.session,request:request(1,'앞 첫째값 뒤')});assert.equal(response.status,200);
  const selection=await response.json() as any;
  const crossSession=await post(base,'assign',{session:second.session,selection:selection.selection,draft:0,path:'replacement'});assert.equal(crossSession.status,400);
  const forged=await post(base,'assign',{session:second.session,selection:'unissued',draft:0,path:'replacement',anchor:selection.location.drafts[0].anchor});assert.equal(forged.status,400);
  const crossed=await post(base,'locate',{session:first.session,request:{from:request(1,'앞 첫째값 뒤').from,to:request(2,'다른 문단').from}});assert.equal(crossed.status,200);
  const location=await crossed.json() as any;assert.equal(location.location.precision,'paragraph');assert.deepEqual(location.location.span,{sectionIndex:0,parentPath:[],from:1,to:2});assert.equal(location.location.drafts[0].anchor.kind,'range'); // #53: 여러 문단 끌기는 range 초안(fill 규칙은 range를 받지 않아 아래 assign은 400)
  const noDraft=await post(base,'assign',{session:first.session,selection:location.selection,draft:0,path:'replacement'});assert.equal(noDraft.status,400);
  assert.deepEqual(await originalOf(base,first.session),Buffer.from(sourceA));assert.deepEqual(await originalOf(base,second.session),Buffer.from(sourceB));
}));

test('Lite 빠른 생성 HTTP: 엔진이 혼합 서식으로 막은 클릭 초안은 연결하지 않는다',async()=>withServer(async base=>{
  const bytes=synth([P(R(T('{{bad.'))+R(T('value}}'),'1'))]),uploaded=await upload(base,bytes);
  const response=await post(base,'locate',{session:uploaded.session,request:request(1,'{{bad.',2)});assert.equal(response.status,200);
  const selection=await response.json() as any;
  const draft=selection.location.drafts.findIndex((d:any)=>d.anchor.kind==='word'&&d.blocked==='FILL_MIXED_FORMAT');assert(draft>=0);
  const assigned=await post(base,'assign',{session:uploaded.session,selection:selection.selection,draft,path:'replacement'});assert.equal(assigned.status,400);
  assert.deepEqual(await originalOf(base,uploaded.session),Buffer.from(bytes));
}));
