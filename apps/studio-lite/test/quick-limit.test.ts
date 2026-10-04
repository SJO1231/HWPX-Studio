import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { openPackage, parseDocument, validateDocument, walkParagraphs } from '@hwpx-studio/engine';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { analyzePlaces, generateAll, parseQuickData } from '../src/quick.ts';

// The module mock is isolated in a child process; production keeps its fixed 512 MiB limit.
test('Lite 결과 용량: 실제 512 MiB 전·동일·초과와 초과 이후 중단, 실패 건 제외, 원본 크기 추정 제거',t=>{
  const code=`
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    const engine=await import('@hwpx-studio/engine');
    let batch;
    mock.module('@hwpx-studio/engine',{namedExports:{...engine,generateBatch:function*(){yield*batch();}}});
    const {generateAll,MAX_RESULT_BYTES}=await import(${JSON.stringify(new URL('../src/quick.ts',import.meta.url).href)});
    assert.equal(MAX_RESULT_BYTES,512*1024*1024);
    const places={fields:[],placeholders:[],candidates:[],candidatesTruncated:false};
    const records=n=>({form:'array',records:Array.from({length:n},()=>({dataset:{data:{},derived:{}}}))});
    const item=(i,output)=>({index:i,name:'limit-'+String(i).padStart(3,'0')+'.hwpx',ok:true,output,filled:1,skipped:[],warnings:[],errorCodes:[],errors:[]});
    let calls=0;
    const shared=new Uint8Array(1024*1024);
    batch=function*(){
      calls++;yield {...item(1,undefined),ok:false,filled:0,errors:[{code:'DATA_MISSING',message:'missing'}]};
      for(let i=2;i<=515;i++){calls++;yield item(i,shared);}
    };
    let results=generateAll(new Uint8Array(1),places,records(515),'limit.hwpx','error');
    assert.equal(results.length,515);
    assert.equal(results[0].view.ok,false);assert(results.slice(1,513).every(r=>r.view.ok));
    assert(results.slice(513).every(r=>!r.view.ok));
    assert.equal(calls,514,'overflow must close the engine iterator before the following record');
    assert.equal(results[0].view.errors[0].code,'DATA_MISSING');
    assert.equal(results.slice(1,513).reduce((n,r)=>n+r.output.byteLength,0),MAX_RESULT_BYTES);
    for(const r of results.slice(513)) {
      assert.equal(r.output,undefined);assert.equal(r.view.filled,0);assert.equal(r.view.notes.length,0);
      assert.equal(r.view.errors[0].code,'QUICK_TOO_LARGE');
    }
    assert.deepEqual(results.map(r=>r.view.name),Array.from({length:515},(_,i)=>'limit-'+String(i+1).padStart(3,'0')+'.hwpx'));
    results=[];
    calls=0;
    batch=function*(){calls++;yield item(1,new Uint8Array(MAX_RESULT_BYTES+1));calls++;yield item(2,new Uint8Array(1));};
    results=generateAll(new Uint8Array(1),places,records(2),'limit.hwpx','error');
    assert.deepEqual(results.map(r=>r.view.ok),[false,false]);assert.equal(calls,1);
    assert(results.every(r=>r.output===undefined&&r.view.errors[0].code==='QUICK_TOO_LARGE'));
    batch=function*(){for(let i=1;i<=33;i++)yield item(i,new Uint8Array(1));};
    results=generateAll(new Uint8Array(16*1024*1024),places,records(33),'limit.hwpx','error');
    assert.equal(results.length,33);assert(results.every(r=>r.view.ok));
    const {createQuick}=await import( ${JSON.stringify(new URL('../src/quick-api.ts',import.meta.url).href)}    );
    const {buildHwpx}=await import(${JSON.stringify(new URL('../../../packages/hwpx-engine/test/helpers.ts',import.meta.url).href)});
    const source=buildHwpx(['<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>{{a}}</hp:t></hp:run></hp:p>']);
    const api=createQuick(),uploaded=api.post('/api/quick/template',{name:'limit.hwpx',content:Buffer.from(source).toString('base64')});
    const session=uploaded.session;
    api.post('/api/quick/data',{session,content:JSON.stringify(Array.from({length:514},()=>({a:'synthetic'})))});
    calls=0;batch=function*(){for(let i=1;i<=514;i++){calls++;yield item(i,shared);}};
    const response=api.post('/api/quick/generate',{session,missing:'error'});
    assert.equal(calls,513);assert.equal(response.results.length,514);
    assert(response.results.slice(0,512).every(r=>r.ok));assert(response.results.slice(512).every(r=>!r.ok));
    assert.equal(api.get('/api/quick/result',new URLSearchParams({session,index:'0'})).body,shared);
    for(const index of ['512','513'])assert.throws(()=>api.get('/api/quick/result',new URLSearchParams({session,index})),e=>e.status===404&&e.code==='QUICK_RESULT');
    assert.throws(()=>api.post('/api/quick/data',{session,content:'[]'}));
    assert.throws(()=>api.get('/api/quick/result',new URLSearchParams({session,index:'0'})),e=>e.status===404&&e.code==='QUICK_RESULT');
    assert.deepEqual(api.get('/api/quick/source',new URLSearchParams({session})).body,source);
    console.log('fixed_limit=536870912; boundary_cases=3; overflow_stops=2; failed_record_bytes=0; estimate_false_rejections=0');
  `;
  const output=execFileSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',code],{cwd:new URL('../../../',import.meta.url),encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
  t.diagnostic(output.trim());
});

test('Lite 결과 용량: derived 300 KiB × 7, seeded 50건의 실제 생성·값 재파싱·새 오류 0',t=>{
  let seed=0x13b17e;
  const keys=Array.from({length:7},(_,i)=>'large'+i);
  const derived=Object.fromEntries(keys.map(key=>{
    const chars=Array.from({length:300*1024},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return String.fromCharCode(33+((seed>>>16)%90));});
    return [key,chars.join('')];
  }));
  const text=(s:string)=>`<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${s}</hp:t></hp:run></hp:p>`;
  const source=buildHwpx([text('합성 고정 문단')+keys.map(key=>text('{{'+key+'}}')).join('')]),before=Buffer.from(source);
  const data=parseQuickData(new TextEncoder().encode(JSON.stringify({schema:'hwpx-studio/dataset@1',data:Array.from({length:50},(_,i)=>({record:i})),derived})));
  const results=generateAll(source,analyzePlaces(source),data,'derived.hwpx','error');
  assert.equal(results.length,50);
  let bytes=0,filled=0;
  for(const r of results) {
    assert(r.view.ok&&r.output,JSON.stringify(r.view.errors));assert.equal(r.view.filled,7);assert.equal(r.view.errors.length,0);
    const doc=parseDocument(openPackage(r.output)),paragraphs=doc.sections.flatMap(s=>[...walkParagraphs(s.paragraphs)]);
    assert.deepEqual(paragraphs.map(p=>p.logicalText),['합성 고정 문단',...keys.map(key=>derived[key])]);
    assert.equal(validateDocument(r.output).errors.length,0);
    bytes+=r.output.length;filled+=r.view.filled;
  }
  assert(bytes>50*source.length,'the source-size estimate must underestimate the actual generated batch');
  assert(bytes<=512*1024*1024);assert.equal(filled,350);assert.deepEqual(Buffer.from(source),before);
  t.diagnostic('seed=0x13b17e; records=50; derived_keys=7; value_bytes=307200; filled=350; new_errors=0; output_bytes='+bytes+'; source_estimate_bytes='+50*source.length);
});
