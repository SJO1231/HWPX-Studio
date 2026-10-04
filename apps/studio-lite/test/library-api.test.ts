import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { type StudioTemplate } from '@hwpx-studio/engine';
import { createApp } from '../src/server.ts';
import { demo } from '../src/demo.ts';

const source=Buffer.from('{{zero}} {{flag}} {{identifier}} {{flat}} {{nested}}\n合成本文');
const template:StudioTemplate={
  schema:'hwpx-studio/template@2',id:'t00000101',version:1,meta:{name:'합성 HTTP 템플릿'},source:{kind:'md',sha256:createHash('sha256').update(source).digest('hex')},anchors:[],
  values:[{id:'v1',name:'숫자',format:'text'},{id:'v2',name:'불리언',format:'text'},{id:'v3',name:'번호',format:'text'},{id:'v4',name:'평면 키',format:'text'},{id:'v5',name:'중첩 값',format:'text'}],
  bindings:[{value:'v1',key:'zero'},{value:'v2',key:'flag'},{value:'v3',key:'identifier'},{value:'v4',key:'flat.key'},{value:'v5',path:'nested.value'}],
  places:[{id:'p1',kind:'placeholder',key:'zero',value:'v1'},{id:'p2',kind:'placeholder',key:'flag',value:'v2'},{id:'p3',kind:'placeholder',key:'identifier',value:'v3'},{id:'p4',kind:'placeholder',key:'flat',value:'v4'},{id:'p5',kind:'placeholder',key:'nested',value:'v5'}],slots:[],blocks:[],
};
const post=(base:string,path:string,input:unknown,origin=base)=>fetch(base+'/api/library/'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(input)});
const get=(base:string,path:string)=>fetch(base+'/api/library/'+path);
const payload=()=>({template:JSON.stringify(template),blobs:[source.toString('base64')]});
const serve=async(file=':memory:')=>{
  const server=createApp(file);
  const base=await new Promise<string>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>done('http://127.0.0.1:'+(server.address() as any).port));});
  return {base,close:()=>new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()))};
};
const at=(id:string,version=1)=>'id='+id+'&version='+version;

test('보관함 HTTP: 저장 후 서버 종료·재실행에서 연결/원본/데이터 판을 복원하고 기존 프로젝트는 그대로',async()=>{
  const directory=mkdtempSync(join(resolve(tmpdir()),'hwpx-library-http-'));let host:Awaited<ReturnType<typeof serve>>|undefined;
  try{
    const database=join(directory,'synthetic.sqlite');host=await serve(database);
    const legacy=demo();const oldSave=await fetch(host.base+'/api/save',{method:'POST',headers:{'Content-Type':'application/json',Origin:host.base},body:JSON.stringify({project:legacy})});assert.equal(oldSave.status,200);
    const legacyId=(await oldSave.json() as any).id;
    assert.equal((await post(host.base,'save',payload())).status,200);
    const content=JSON.stringify([{zero:0,flag:false,identifier:'000123','flat.key':'평면 값',nested:{value:'중첩 값'}}],null,2);
    const savedResponse=await post(host.base,'data',{name:'합성 원본 행',content});assert.equal(savedResponse.status,200);const data=await savedResponse.json() as any;
    const next=await post(host.base,'data',{name:'합성 새 판',content:'[{"zero":7}]',id:data.id,version:data.version});assert.equal(next.status,200);assert.equal((await next.json() as any).version,2);
    const query='preview?'+at(template.id)+'&dataset='+data.id+'&dataVersion=1&row=0';
    const before=await (await get(host.base,query)).json() as any;assert.deepEqual(before.values.map((v:any)=>v.text),['0','false','000123','평면 값','중첩 값']);
    assert.deepEqual(Buffer.from(await (await get(host.base,'source?'+at(template.id))).arrayBuffer()),source);
    await host.close();host=undefined;host=await serve(database);
    assert.equal((await (await get(host.base,'templates')).json() as any[]).length,1);assert.equal((await (await get(host.base,'datasets')).json() as any[]).length,2);
    assert.deepEqual(await (await get(host.base,query)).json(),before);
    assert.equal((await (await get(host.base,'dataset?'+at(data.id))).json() as any).document,content);
    assert.deepEqual(await (await fetch(host.base+'/api/project?id='+legacyId)).json(),legacy);
    const original=await get(host.base,'source?'+at(template.id));assert.equal(original.status,200);assert.equal(original.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await original.arrayBuffer()),source);
    const page=await fetch(host.base+'/library');assert.equal(page.status,200);assert.match(await page.text(),/템플릿 보관함/);
    assert.equal((await fetch(host.base+'/library.js')).status,200);
  }finally{await host?.close();assert.equal(dirname(directory),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}
});

test('보관함 HTTP: 참조/판 오류를 정확히 거부하고 일부 저장/기존 판 덮어쓰기를 남기지 않는다',async()=>{
  const host=await serve();try{
    const invalid={...template,source:{kind:'md',sha256:'0'.repeat(64)}};
    const broken=await post(host.base,'save',{...payload(),template:JSON.stringify(invalid)});assert.equal(broken.status,404);assert.equal((await broken.json() as any).code,'LIBRARY_REFERENCE');
    assert.deepEqual(await (await get(host.base,'templates')).json(),[]);
    assert.equal((await post(host.base,'save',{template:JSON.stringify(template)})).status,404,'failed import must not leave its blob');
    assert.equal((await post(host.base,'save',payload())).status,200);
    const overwrite=await post(host.base,'save',{template:JSON.stringify({...template,meta:{name:'덮어쓰기'}})});assert.equal(overwrite.status,409);assert.equal((await overwrite.json() as any).code,'LIBRARY_REVISION');
    assert.equal((await (await get(host.base,'template?'+at(template.id))).json() as any).meta.name,template.meta!.name);
    const unsupported=await post(host.base,'save',{template:JSON.stringify({...template,schema:'hwpx-studio/template@99'})});assert.equal(unsupported.status,400);assert.equal((await unsupported.json() as any).code,'TPL_VERSION');
    const badRows=await post(host.base,'data',{name:'합성',content:'null'});assert.equal(badRows.status,400);assert.deepEqual(await (await get(host.base,'datasets')).json(),[]);
    const saved=await (await post(host.base,'data',{name:'합성',content:'[{}]'})).json() as any;
    const badRow=await get(host.base,'preview?'+at(template.id)+'&dataset='+saved.id+'&dataVersion=1&row=-1');assert.equal(badRow.status,400);assert.equal((await badRow.json() as any).code,'LIBRARY_INPUT');
    assert.equal((await get(host.base,'source?'+at(template.id,99))).status,404);
  }finally{await host.close();}
});

test('보관함 HTTP: 다른 출처와 잘못된 입력/경로를 거부하고 로컬 목록은 비어 있다',async()=>{
  const host=await serve();try{
    assert.equal((await post(host.base,'save',payload(),'https://untrusted.example')).status,403);
    assert.equal((await fetch(host.base+'/api/library/templates',{headers:{Origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(host.base+'/api/library/save',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
    assert.equal((await post(host.base,'save',null)).status,400);assert.equal((await post(host.base,'unknown',{})).status,404);
    assert.deepEqual(await (await get(host.base,'templates')).json(),[]);assert.deepEqual(await (await get(host.base,'datasets')).json(),[]);
  }finally{await host.close();}
});
