import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.ts';
import { demo } from '../src/demo.ts';
import { openPackage, parseDocument, validateDocument, walkParagraphs } from '@hwpx-studio/engine';
import type { Project } from '../src/model.ts';

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const text=(bytes:Uint8Array)=>parseDocument(openPackage(bytes)).sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>p.logicalText)).join('\n');
function project():Project {
  const p=demo();p.name='Helper 합성 시험';p.markdown='# {{사업명}}\n\n{{금액}} / {{식별}} / {{수량}} / {{사용여부}} / {{담당}}';p.blocks=[];
  p.fields=[{id:'amount',name:'금액',column:'원천금액',kind:'field',approved:true,format:'money',values:[],targets:[],evidence:'합성 시험',confidence:1}];
  return p;
}
const item=()=>({fields:{사업명:'조달 시험',원천금액:'123456',식별:'00123',수량:0,사용여부:false},userValues:{담당:'테스트 담당'},children:[],source:{kind:'synthetic'},identity:{key:'00123'},stage:'receipt'});
const body=(requestId:string,items:any[]=[item()])=>({requestId,profileId:'receipt',sourceKind:'db',items});
async function start(database:string) {
  const server=createApp(database);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const send=(method:string,path:string,value?:unknown,origin:string|false=false)=>new Promise<{http:number;body:any}>((resolve,reject)=>{
    const request=httpRequest(base+path,{method,headers:{...(value===undefined?{}:{'Content-Type':'application/json'}),...(origin?{Origin:origin}:{})}},response=>{
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('error',reject);response.on('end',()=>{try{resolve({http:response.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(e){reject(e);}});
    });
    request.on('error',reject);request.end(value===undefined?undefined:JSON.stringify(value));
  });
  const post=(path:string,value:unknown,origin:string|false=base)=>send('POST',path,value,origin);
  const get=(path:string)=>send('GET',path);
  const close=()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  return {base,post,get,close};
}
async function setup(app:Awaited<ReturnType<typeof start>>,directory:string,p=project()) {
  const saved=await app.post('/api/save',{project:p});assert.equal(saved.http,200);
  const profile=await app.post('/api/g2b/profiles',{id:'receipt',label:'접수 합성 문서',revisionId:saved.body.id,outputDirectory:directory});assert.equal(profile.http,200);
  return saved.body.id as number;
}

test('Helper 프로필 → 저장 revision Column 매핑 → scalar HWPX; Native Origin 없음 허용',async()=>{
  const root=mkdtempSync(join(tmpdir(),'studio-g2b-'));const app=await start(join(root,'test.sqlite'));
  try {
    const revisionId=await setup(app,join(root,'output'));
    const profiles=(await app.get('/api/g2b/profiles')).body;
    assert.equal(profiles.profiles[0].revisionId,revisionId);
    const generated=await app.post('/api/g2b/generate',body('scalar'),false);assert.equal(generated.http,200);
    assert.equal(generated.body.status,'success');assert.deepEqual(generated.body.summary,{succeeded:1,needsInput:0,failed:0});
    const path=generated.body.results[0].path;assert.equal(path,join(root,'output',`g2b-${sha('scalar')}-1.hwpx`));
    const bytes=readFileSync(path);assert.equal(validateDocument(bytes).errors.length,0);
    const output=text(bytes);for(const value of ['조달 시험','123,456원','00123','0','false','테스트 담당'])assert(output.includes(value),value);
    assert.equal((await app.post('/api/g2b/profiles',{id:'native-config'},false)).http,403);
    assert.equal((await app.post('/api/g2b/generate',body('web-origin'),'https://public.example')).http,403);
    assert.equal((await app.post('/api/g2b/generate',{...body('bad'),project:project()},false)).http,400);
    assert.equal((await app.post('/api/g2b/generate',{...body('bad-source'),sourceKind:'anything'},false)).http,400);
  } finally {await app.close();rmSync(root,{recursive:true,force:true});}
});

test('같은 요청의 동시·재시작 재시도, 내용 변경 거절, revision snapshot과 유실 파일 복구',async()=>{
  const root=mkdtempSync(join(tmpdir(),'studio-g2b-')), database=join(root,'test.sqlite');let app=await start(database);
  try {
    await setup(app,join(root,'output'));
    const input=body('retry');const [a,b]=await Promise.all([app.post('/api/g2b/generate',input,false),app.post('/api/g2b/generate',input,false)]);
    assert.equal(a.body.status,'success');assert.equal(b.body.results[0].path,a.body.results[0].path);
    const path=a.body.results[0].path, bytes=readFileSync(path);assert.equal(readdirSync(join(root,'output')).filter(n=>n.endsWith('.hwpx')).length,1);
    const changed=item();changed.fields.사업명='다른 값';assert.equal((await app.post('/api/g2b/generate',body('retry',[changed]),false)).http,409);
    const updated=project();updated.markdown='# 프로필 변경 {{사업명}}';await setup(app,join(root,'new-output'),updated);
    await app.close();app=await start(database);
    const replay=await app.post('/api/g2b/generate',input,false);assert.equal(replay.body.results[0].path,path);assert.equal(replay.body.results[0].reused,true);
    assert.deepEqual(readFileSync(path),bytes);
    unlinkSync(path);
    const recovered=await app.post('/api/g2b/generate',input,false);assert.equal(recovered.body.status,'success');assert.deepEqual(readFileSync(path),bytes);
    await app.close();
    // Model a crash after the output was published but before success was journaled.
    const db=new DatabaseSync(database), row=db.prepare('SELECT document FROM g2b_item WHERE request_id=? AND item_index=0').get('retry')!;
    const record=JSON.parse(String(row.document));delete record.result;db.prepare('UPDATE g2b_item SET document=? WHERE request_id=? AND item_index=0').run(JSON.stringify(record),'retry');db.close();
    app=await start(database);
    const interrupted=await app.post('/api/g2b/generate',input,false);assert.equal(interrupted.body.results[0].reused,true);assert.deepEqual(readFileSync(path),bytes);
  } finally {await app.close();rmSync(root,{recursive:true,force:true});}
});

test('기존 출력은 덮어쓰지 않음; 부분 성공과 같은 바이트 계획으로 실패 항목 재시도',async()=>{
  const root=mkdtempSync(join(tmpdir(),'studio-g2b-'));const app=await start(join(root,'test.sqlite'));
  try {
    const directory=join(root,'output');await setup(app,directory);
    const conflict=join(directory,`g2b-${sha('partial')}-1.hwpx`);writeFileSync(conflict,'기존 파일');
    const request=body('partial',[item(),item()]);const first=await app.post('/api/g2b/generate',request,false);
    assert.equal(first.body.status,'partial');assert.deepEqual(first.body.summary,{succeeded:1,needsInput:0,failed:1});assert.equal(readFileSync(conflict,'utf8'),'기존 파일');
    const secondPath=first.body.results[1].path, hash=sha(readFileSync(secondPath));unlinkSync(conflict);
    const retry=await app.post('/api/g2b/generate',request,false);assert.equal(retry.body.status,'success');assert.equal(sha(readFileSync(secondPath)),hash);assert.equal(retry.body.results[1].reused,true);
    assert.equal(readdirSync(directory).filter(n=>n.endsWith('.tmp')).length,0);
  } finally {await app.close();rmSync(root,{recursive:true,force:true});}
});

test('children·값 충돌·필수값 누락·금액 정밀도는 needs-input, 정상 값은 부분 성공',async()=>{
  const root=mkdtempSync(join(tmpdir(),'studio-g2b-'));const app=await start(join(root,'test.sqlite'));
  try {
    await setup(app,join(root,'output'));
    const children={...item(),children:[{key:'items',label:'물품',kind:'items',rows:[{value:'하위'}]}]}, collision={...item(),userValues:{사업명:'겹침'}}, missing={...item(),fields:{사업명:'값 부족'}}, fraction={...item(),fields:{...item().fields,원천금액:'0.100000000000000001'}}, large={...item(),fields:{...item().fields,원천금액:'9007199254740993'}};
    const results=await app.post('/api/g2b/generate',body('needs',[children,collision,missing,fraction,large,item()]),false);
    assert.equal(results.body.status,'partial');assert.deepEqual(results.body.summary,{succeeded:1,needsInput:5,failed:0});
    assert.deepEqual(results.body.results.slice(0,5).map((r:any)=>r.code),['UNSUPPORTED_CHILDREN','FIELD_COLLISION','MISSING_FIELDS','MONEY_PRECISION','MONEY_PRECISION']);
    assert.deepEqual(results.body.results[1].conflicts,['사업명']);assert(results.body.results[2].missingFields.includes('원천금액'));assert(results.body.results[2].message.includes('원천금액'));
    const duplicateAlias={...item(),fields:{...item().fields,금액:'숨겨지면 안 됨'}};
    assert.equal((await app.post('/api/g2b/generate',body('alias',[duplicateAlias]),false)).body.results[0].code,'FIELD_COLLISION');
    const noProfile=await app.post('/api/g2b/generate',{...body('no-profile'),profileId:'unknown'},false);assert.equal(noProfile.body.status,'needs-input');assert.equal(noProfile.body.results[0].code,'MISSING_PROFILE');
  } finally {await app.close();rmSync(root,{recursive:true,force:true});}
});

test('빈 하위 표와 사용하지 않는 빈 필드는 scalar 생성 허용; 잘못된 표·중첩 값은 거절',async()=>{
  const root=mkdtempSync(join(tmpdir(),'studio-g2b-'));const app=await start(join(root,'test.sqlite'));
  try {
    const output=join(root,'output'), p=project();p.markdown+='\n\n구분앞[{{빈텍스트}}]구분뒤';p.fields.push({id:'blank',name:'빈텍스트',column:'원천빈값',kind:'field',approved:true,format:'text',values:[],targets:[],evidence:'빈 값 보존 시험',confidence:1});await setup(app,output,p);
    const blank={...item(),fields:{...item().fields,blank:'',원천빈값:''},children:[{key:'items',label:'물품',kind:'items',rows:[]},{key:'qualification',label:'참가자격',kind:'qualification',rows:[]}]};
    const generated=await app.post('/api/g2b/generate',body('empty-children',[blank]),false);assert.equal(generated.body.status,'success');const rendered=text(readFileSync(generated.body.results[0].path));assert(rendered.includes('조달 시험'));assert(rendered.includes('구분앞[]구분뒤'));assert(!rendered.includes('{{빈텍스트}}'));
    const blankMoney={...blank,fields:{...blank.fields,원천금액:''}};const moneyResponse=await app.post('/api/g2b/generate',body('blank-money',[blankMoney]),false);assert.equal(moneyResponse.body.status,'needs-input');assert.equal(moneyResponse.body.results[0].code,'MONEY_PRECISION');
    const changed={...blank,fields:{...blank.fields,blank:'값 변경'}};assert.equal((await app.post('/api/g2b/generate',body('empty-children',[changed]),false)).http,409);
    const malformed=[null,{}, {key:'bad',label:'잘못된 표',kind:'items',rows:{}}, {key:'bad',label:'잘못된 표',kind:'items',rows:[1]}, {key:'bad',label:'잘못된 표',kind:'unknown',rows:[]}].map(child=>({...item(),children:[child]}));
    const rejected=await app.post('/api/g2b/generate',body('malformed-children',malformed),false);assert.equal(rejected.body.status,'needs-input');assert(rejected.body.results.every((r:any)=>r.code==='INVALID_CHILDREN'));
    const nested={...item(),fields:{...item().fields,sourceFields:{nested:'원천'}}};const nestedResult=await app.post('/api/g2b/generate',body('nested-fields',[nested]),false);assert.equal(nestedResult.body.results[0].code,'INVALID_FIELDS');
    assert.equal(readdirSync(output).filter(n=>n.endsWith('.hwpx')).length,1);
  } finally {await app.close();rmSync(root,{recursive:true,force:true});}
});

test('조건 선택 동률은 보완 요청, 저장된 명시적 Block 선택은 재사용',async()=>{
  const root=mkdtempSync(join(tmpdir(),'studio-g2b-'));const app=await start(join(root,'test.sqlite'));
  try {
    const p=project();p.markdown='# {{사업명}}\n\n[IN_TEMPLATE:group]';p.blocks=['a','b'].map(id=>({id,group:'group',alias:id,engine_type:'markdown',priority:1,condition:'수량=0',content:id==='a'?'첫 번째 선택':'두 번째 선택'}));
    await setup(app,join(root,'output'),p);
    const missingCondition={...item(),fields:Object.fromEntries(Object.entries(item().fields).filter(([key])=>key!=='수량'))};
    const missingResponse=await app.post('/api/g2b/generate',body('missing-condition',[missingCondition]),false);assert.equal(missingResponse.body.results[0].code,'MISSING_CONDITION_FIELDS');assert(missingResponse.body.results[0].message.includes('수량'));
    const blankCondition={...item(),fields:{...item().fields,수량:''}};const blankResponse=await app.post('/api/g2b/generate',body('blank-condition',[blankCondition]),false);assert.equal(blankResponse.body.results[0].code,'MISSING_CONDITION_FIELDS');assert(blankResponse.body.results[0].message.includes('수량'));
    const needs=await app.post('/api/g2b/generate',body('ambiguous'),false);assert.equal(needs.body.results[0].code,'BLOCK_SELECTION');assert.deepEqual(needs.body.results[0].conflicts,['a','b']);
    p.selectedBlocks={group:'b'};await setup(app,join(root,'output'),p);
    const chosen=await app.post('/api/g2b/generate',body('selected'),false);assert.equal(chosen.body.status,'success');assert(text(readFileSync(chosen.body.results[0].path)).includes('두 번째 선택'));
  } finally {await app.close();rmSync(root,{recursive:true,force:true});}
});

test('Helper 회귀: 점이 있는 금액 열의 조건 선택과 실제 출력이 일치한다',async()=>{
  const root=mkdtempSync(join(tmpdir(),'studio-g2b-dotted-')), app=await start(join(root,'test.sqlite'));
  try {
    const p=project();p.fields[0].name='project.amount';p.markdown='{{project.amount}}\n\n[IN_TEMPLATE:pay]';
    p.blocks=[{id:'large',group:'pay',alias:'고액',engine_type:'markdown',priority:1,condition:'project.amount>=100000',content:'분할 지급'},{id:'small',group:'pay',alias:'기본',engine_type:'markdown',priority:0,condition:'',content:'일시 지급'}];
    await setup(app,join(root,'output'),p);
    const result=await app.post('/api/g2b/generate',body('dotted'),false);assert.equal(result.body.status,'success');
    const rendered=text(readFileSync(result.body.results[0].path));assert(rendered.includes('분할 지급'));assert(!rendered.includes('일시 지급'));assert(rendered.includes('123,456원'));
  }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
