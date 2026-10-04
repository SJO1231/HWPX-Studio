import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import {
  canonicalStudioJson, compareToBaseline, contentSha256, extractFragment,
  generateFromTemplate, listFields, openPackage, parseDocument, readCase, remapAddress, type Move,
  serializeFragment, sha256Hex, templateSha256,
  validateDocument, walkParagraphs,
} from '@hwpx-studio/engine';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { loaderOf, noticeKit, recordFor, type NoticeKit } from '../../../packages/hwpx-engine/test/generate-v2-helpers.ts';
import { longValue, rng } from '../../../packages/hwpx-engine/test/range-helpers.ts';
import { generateSelection, previewSelection } from '../src/selection.ts';
import { createApp } from '../src/server.ts';

const json=(value:unknown)=>JSON.stringify(value);
function request(k:NoticeKit,rows:Record<string,unknown>[],raw:unknown=k.raw):Record<string,unknown> {
  return {template:json(raw),protos:[],blobs:[k.bytes,...k.blobs.values()].map(b=>Buffer.from(b).toString('base64')),data:json(rows),row:0};
}
const record=(price=60000000,sme='N')=>recordFor(name=>'SYNTH_'+name,{price,sme});
function slot(p:ReturnType<typeof previewSelection>,id:string) {
  const s=p.slots.find(s=>s.slot===id);assert(s,'슬롯이 있어야 한다');return s;
}
function rejected(fn:()=>unknown,code:string) {
  assert.throws(fn,(error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code===code,'예상 코드 '+code);
}
const docOf=(bytes:Uint8Array)=>parseDocument(openPackage(bytes));
const allText=(bytes:Uint8Array)=>docOf(bytes).sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>p.logicalText)).join('\n');

function assertZeroScope(k:NoticeKit,output:Uint8Array,moves:readonly Move[],active:boolean) {
  const before=listFields(k.doc).filter(f=>f.mergeKey==='재공고'),after=listFields(docOf(output)).filter(f=>f.mergeKey==='재공고');
  assert.equal(before.length,2,'합성 원본의 범위 밖 재공고2곳');
  assert.equal(after.length,before.length+(active?1:0));
  for(const original of before) {
    const moved=remapAddress(moves,{sectionIndex:original.sectionIndex,path:original.path});assert(moved);
    const preserved=after.filter(f=>f.sectionIndex===moved.sectionIndex&&json(f.path)===json(moved.path));assert.equal(preserved.length,1);
    assert.equal(preserved[0]?.valueText,original.valueText);assert.equal(preserved[0]?.dirty,original.dirty,'where 범위 밖 필드는 채우지 않는다');
  }
  if(active) {
    const own=moves.find(m=>m.sectionIndex===0&&m.parentPath.length===0&&m.from===33&&m.to===33);assert(own&&own.count>0);
    const start=own.from+moves.filter(m=>m!==own&&m.sectionIndex===0&&m.parentPath.length===0&&m.to<own.from).reduce((n,m)=>n+m.delta,0);
    const filled=after.filter(f=>f.sectionIndex===0&&f.path.length===1&&f.path[0]!>=start&&f.path[0]!<start+own.count);
    assert.equal(filled.length,1,'선택 b8 범위의 재공고1곳');assert.equal(filled[0]?.valueText,'0');assert.equal(filled[0]?.dirty,'1');
  }
}

test('슬롯 선택: 금액 경계 전·동일·후, fallback·동률·조건 누락을 공개 판정과 같은 기준으로 표시',()=>{
  const k=noticeKit(),before=json(k.raw),table=[
    {price:99999999,state:'fallback',block:'b2'},
    {price:100000000,state:'default',block:'b1'},
    {price:100000001,state:'default',block:'b1'},
  ];
  for(const row of table) {
    const input=request(k,[record(row.price)]),snapshot=json(input),p=previewSelection(input),s=slot(p,'s1');
    assert.deepEqual([s.state,s.block,s.blocked],[row.state,row.block,undefined]);
    assert.deepEqual(readCase(p.case,p.template).selections,{});
    assert.equal(json(input),snapshot);
    assert.deepEqual([slot(p,'s2').state,slot(p,'s2').reason,slot(p,'s2').blocked],['undecided','tie','SEL_UNDECIDED']);
    assert.deepEqual(slot(p,'s2').candidates,['b3','b4']);
  }
  const missing=record();delete missing['추정가격(원)'];
  const p=previewSelection(request(k,[missing]));
  assert.deepEqual([slot(p,'s1').state,slot(p,'s1').reason,slot(p,'s1').blocked],['undecided','valueMissing','SEL_UNDECIDED']);
  const raw=structuredClone(k.t);raw.blocks=raw.blocks.filter(b=>b.id!=='b2'&&b.id!=='b1t');raw.places=raw.places.filter(p=>!('where' in p)||p.where!=='b2');
  const none=previewSelection(request(k,[record(0)],raw));
  assert.deepEqual([slot(none,'s1').state,slot(none,'s1').reason,slot(none,'s1').candidates],['undecided','noCandidate',[]]);
  const tie=structuredClone(k.t),b=structuredClone(tie.blocks.find(b=>b.id==='b1'));assert(b);b.id='tie1';tie.blocks.push(b);
  const equal=previewSelection(request(k,[record(100000000)],tie));
  assert.deepEqual([slot(equal,'s1').state,slot(equal,'s1').reason,slot(equal,'s1').candidates],['undecided','tie',['b1','tie1']]);
  assert.equal(json(k.raw),before);
});

test('슬롯 선택: 수동·기본 확정·clear·직렬화 재입력과 원본 내용 해시 보존',()=>{
  const k=noticeKit(),raw=structuredClone(k.t);raw.options={...raw.options,requireConfirm:true};
  const input=request(k,[record(100000000)],raw),before=json(input);
  const initial=previewSelection(input);
  assert.deepEqual([slot(initial,'s1').state,slot(initial,'s1').reason,slot(initial,'s1').blocked],['default','needConfirm','SEL_UNDECIDED']);
  const confirmed=previewSelection({...input,case:initial.case,action:{slot:'s1',mode:'confirm'}});
  const cc=readCase(confirmed.case,confirmed.template),b1=confirmed.template.blocks.find(b=>b.id==='b1');assert(b1);
  assert.deepEqual(cc.selections.s1,{block:'b1',basis:'confirmed',content:contentSha256(b1.content)});
  assert.deepEqual([slot(confirmed,'s1').state,slot(confirmed,'s1').blocked],['confirmed',undefined]);
  const restored=previewSelection({...input,case:confirmed.case});assert.equal(restored.case,confirmed.case);assert.deepEqual(restored.slots,confirmed.slots);
  const manual=previewSelection({...input,case:confirmed.case,action:{slot:'s1',mode:'manual',block:'b2'}});
  assert.deepEqual([slot(manual,'s1').state,slot(manual,'s1').block,slot(manual,'s1').differs,slot(manual,'s1').candidates],['manual','b2',true,['b1']]);
  const c=readCase(manual.case,manual.template),b2=manual.template.blocks.find(b=>b.id==='b2');assert(b2);
  assert.equal(c.selections.s1?.content,contentSha256(b2.content));
  c.valueEdits[k.valueId('사업명')]='정정 값\n문장 둘 & <확인>';c.blockEdits.b2={text:'이번 건만 바꾼 {{사업명}}'};
  const edited=previewSelection({...input,case:json(c)});
  assert.equal(edited.values.find(v=>v.id===k.valueId('사업명'))?.text,c.valueEdits[k.valueId('사업명')]);
  assert.deepEqual(readCase(edited.case,edited.template).blockEdits,c.blockEdits);
  assert.equal(readCase(edited.case,edited.template).selections.s1?.content,contentSha256(b2.content),'이번 건 편집을 원본 블록 해시로 오인하지 않는다');
  const cleared=previewSelection({...input,case:edited.case,action:{slot:'s1',mode:'clear'}});
  assert.equal(readCase(cleared.case,cleared.template).selections.s1,undefined);
  assert.deepEqual([slot(cleared,'s1').state,slot(cleared,'s1').reason],['default','needConfirm']);
  assert.deepEqual(readCase(cleared.case,cleared.template).blockEdits,c.blockEdits);
  assert.equal(json(input),before);
  const fallbackInput=request(k,[record(0)],raw),fallback=previewSelection({...fallbackInput,action:{slot:'s1',mode:'confirm'}});
  assert.deepEqual([slot(fallback,'s1').state,slot(fallback,'s1').block],['confirmed','b2']);
});

test('슬롯 선택: 같은 판 변경은 TPL_REF, 새 판 조건 변경은 선택 유지·differs, 새 판 내용 변경은 재확인',()=>{
  const k=noticeKit(),input=request(k,[record(100000000)]),chosen=previewSelection({...input,action:{slot:'s1',mode:'manual',block:'b1'}});
  const original=json(chosen.template),raw=structuredClone(chosen.template),block=raw.blocks.find(b=>b.id==='b1');assert(block);
  block.content={text:'개정 내용 {{사업명}}'};
  rejected(()=>previewSelection({...input,template:json(raw),case:chosen.case}),'TPL_REF');
  raw.version++;
  const changed=previewSelection({...input,template:json(raw),case:chosen.case});
  assert.deepEqual([slot(changed,'s1').state,slot(changed,'s1').reason,slot(changed,'s1').blocked],['recheck','contentChanged','SEL_RECHECK']);
  const failed=generateSelection({...input,template:json(raw),case:changed.case});assert(!failed.ok);assert(!('output' in failed));
  assert(failed.report.issues.some(i=>i.code==='SEL_RECHECK'));
  const accepted=previewSelection({...input,template:json(raw),case:changed.case,action:{slot:'s1',mode:'manual',block:'b1'}});
  assert.equal(slot(accepted,'s1').state,'manual');
  assert.equal(readCase(accepted.case,accepted.template).selections.s1?.content,contentSha256(block.content));
  const conditions=structuredClone(chosen.template);conditions.version++;
  const high=conditions.blocks.find(b=>b.id==='b1');assert(high);high.when={path:k.valueId('추정가격'),op:'ge',value:200000000};
  const retained=previewSelection({...input,template:json(conditions),case:chosen.case});
  assert.deepEqual([slot(retained,'s1').state,slot(retained,'s1').block,slot(retained,'s1').differs,slot(retained,'s1').candidates],['manual','b1',true,['b2']]);
  const deleted=structuredClone(chosen.template);deleted.version++;deleted.blocks=deleted.blocks.filter(b=>b.id!=='b1');
  const missing=previewSelection({...input,template:json(deleted),case:chosen.case});
  assert.deepEqual([slot(missing,'s1').state,slot(missing,'s1').reason,slot(missing,'s1').blocked],['recheck','blockMissing','SEL_RECHECK']);
  assert.equal(json(chosen.template),original);
});

test('슬롯 선택: 정규 데이터 묶음·행 식별과 값 0·false·앞자리 0 문자열을 잃지 않는다',()=>{
  const k=noticeKit(),rows=[record(0),record(100000000)];
  rows[0]!['재공고']=0;rows[0]!['소속']=false;rows[0]!['공고번호']='00123';
  const input=request(k,rows),snapshot=json(input),p=previewSelection(input);
  assert.equal(p.rows,2);
  assert.deepEqual(p.record,{dataset:'d'+sha256Hex(canonicalStudioJson(rows)).slice(0,24),version:1,row:0,sha256:sha256Hex(canonicalStudioJson(rows[0]))});
  assert.deepEqual(readCase(p.case,p.template).record,p.record);
  assert.equal(readCase(p.case,p.template).template.sha256,templateSha256(p.template));
  assert.deepEqual(['재공고','소속','공고번호'].map(name=>p.values.find(v=>v.id===k.valueId(name))?.text),['0','false','00123']);
  const reversedRows=rows.map(row=>Object.fromEntries(Object.entries(row).reverse())),equivalent=previewSelection({...input,data:json(reversedRows),case:p.case});
  assert.deepEqual(equivalent.record,p.record);assert.equal(equivalent.case,p.case);
  const second=previewSelection({...input,row:1});assert.equal(second.record.row,1);assert.equal(second.record.sha256,sha256Hex(canonicalStudioJson(rows[1])));
  assert.equal(json(input),snapshot);
});

test('슬롯 선택: 선택하지 않은 블록의 문구·누름틀은 결과에 없고, 선택하면 두 앵커에만 삽입',()=>{
  const k=noticeKit(),raw=structuredClone(k.t),inactiveBytes=buildHwpx(['<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>SYNTH_INACTIVE_BLOCK </hp:t><hp:ctrl><hp:fieldBegin id="100" type="CLICK_HERE" name="비활성필드" editable="1" dirty="0" fieldid="1009"/></hp:ctrl><hp:t>원래 값</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="100" fieldid="1009"/></hp:ctrl></hp:run></hp:p>']);
  const blob=new TextEncoder().encode(serializeFragment(extractFragment(docOf(inactiveBytes),{sectionIndex:0,parentPath:[],from:0,to:0}))),sha=sha256Hex(blob);
  k.blobs.set(sha,blob);const b3=raw.blocks.find(b=>b.id==='b3');assert(b3);b3.content={fragment:sha};
  raw.values.push({id:'vinactive',name:'비활성필드',format:'text'});raw.bindings.push({value:'vinactive',key:'비활성필드'});
  raw.places.push({id:'pinactive',kind:'clickHere',name:'비활성필드',value:'vinactive',where:'b3'});
  const row=record(0);row['비활성필드']='SYNTH_SELECTED_VALUE';
  const input=request(k,[row],raw),before=json(input),p=previewSelection({...input,action:{slot:'s2',mode:'manual',block:'b4'}});
  const off=generateSelection({...input,case:p.case});assert(off.ok&&!off.dryRun&&off.output instanceof Uint8Array,JSON.stringify(off.report.issues));
  assert(!allText(off.output).includes('SYNTH_INACTIVE_BLOCK'));assert(!allText(off.output).includes('SYNTH_SELECTED_VALUE'));
  assert(!listFields(docOf(off.output)).some(f=>f.name==='비활성필드'));
  const onP=previewSelection({...input,case:p.case,action:{slot:'s2',mode:'manual',block:'b3'}});
  const on=generateSelection({...input,case:onP.case});assert(on.ok&&!on.dryRun&&on.output instanceof Uint8Array,JSON.stringify(on.report.issues));
  assert.equal(listFields(docOf(on.output)).filter(f=>f.name==='비활성필드'&&f.valueText==='SYNTH_SELECTED_VALUE').length,2);
  assert.equal(allText(on.output).split('SYNTH_INACTIVE_BLOCK').length-1,2);
  assert.deepEqual(compareToBaseline(validateDocument(k.bytes),validateDocument(off.output)).newErrors,[]);
  assert.deepEqual(compareToBaseline(validateDocument(k.bytes),validateDocument(on.output)).newErrors,[]);
  assert.equal(json(input),before);
});

test('슬롯 선택 생성: seeded50행×2회, 41자리·본문/표/머리말·긴 값·엔진 동치·결정성·새 오류0',t=>{
  const k=noticeKit(),next=rng(0x7c0ffee),rows=Array.from({length:50},(_,index)=>{
    const row=recordFor(name=>'SYNTH_'+index+'_'+name+' '+longValue(next,400,700)+'\n둘째 문장 & <확인> "인용".\t셋째 문장.',{price:[0,49999999,50000000,99999999,100000000,100000001][index%6],sme:index%3===0?'Y':'N'});
    row['재공고']=0;row['소속']=false;row['공고번호']='00'+String(index).padStart(6,'0');return row;
  });
  const raw=structuredClone(k.t),b2=raw.blocks.find(b=>b.id==='b2');assert(b2);
  const proto={schema:'hwpx-studio/block-proto@1',id:'k7000cafe',version:1,name:'합성 일반 블록',content:structuredClone(b2.content),keys:['사업명','담당자 이름','연락처']};
  b2.proto={id:proto.id,version:proto.version};
  const input=request(k,rows,raw);input.protos=[json(proto)];
  const inputBefore=json(input),sourceBefore=Buffer.from(k.bytes),blobBefore=[...k.blobs].map(([sha,b])=>[sha,Buffer.from(b)] as const),baseline=validateDocument(k.bytes);
  assert.equal(k.t.places.length,41);
  let gates=0,targets=0,pairs=0,directChecks=0,newErrors=0,bodyChecks=0,tableChecks=0,headerChecks=0,zeroChecks=0;
  for(let row=0;row<rows.length;row++) {
    const selection=previewSelection({...input,row,action:{slot:'s2',mode:'manual',block:row%2===0?'b3':'b4'}});
    const selectedInput={...input,row,case:selection.case},a=generateSelection(selectedInput),b=generateSelection(selectedInput);
    assert(a.ok&&!a.dryRun&&a.output instanceof Uint8Array,JSON.stringify(a.report.issues));
    assert(b.ok&&!b.dryRun&&b.output instanceof Uint8Array,JSON.stringify(b.report.issues));
    assert.deepEqual(a,b);pairs++;
    const direct=generateFromTemplate(k.bytes,selection.template,rows[row]!,readCase(selection.case,selection.template),loaderOf(k.blobs),{mode:'baseline'});
    assert.deepEqual(a,direct);directChecks++;
    assert(a.ledger);const fills=a.ledger.actions.filter(action=>action.type==='fill').reduce((n,action)=>n+action.targets,0);assert(fills>=30,'실제로 채운 위치를 최소30곳 확인');
    for(const result of [a,b]) {
      assert(result.ok&&!result.dryRun&&result.output instanceof Uint8Array);
      assert.deepEqual(result.report.validation?.newErrors,[]);
      const errors=compareToBaseline(baseline,validateDocument(result.output)).newErrors;assert.deepEqual(errors,[]);
      const doc=docOf(result.output),fields=listFields(doc);
      assert(fields.some(f=>f.path.length===1&&f.valueText.length>400));bodyChecks++;
      assert(fields.some(f=>f.path.length>1&&f.valueText.length>400));tableChecks++;
      const header=doc.sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].flatMap(p=>p.subLists.filter(list=>list.owner==='header').flatMap(list=>[...walkParagraphs(list.paragraphs)].map(p=>p.logicalText))));
      assert(header.some(text=>text.includes(rows[row]!['사업명'] as string)));headerChecks++;
      const identifiers=fields.filter(f=>f.mergeKey==='공고번호');assert(identifiers.length>=1);assert(identifiers.every(f=>f.valueText===rows[row]!['공고번호']));
      const booleans=fields.filter(f=>f.name==='소속');assert(booleans.length>=1);assert(booleans.every(f=>f.valueText==='false'));
      const active=slot(selection,'s4').block==='b8';assertZeroScope(k,result.output,result.report.moves,active);if(active)zeroChecks++;
      const project=rows[row]!['사업명'];assert(typeof project==='string'&&project.length>400&&project.includes('\n')&&project.includes('\t')&&project.includes('<확인>'));
      const repeated=fields.filter(f=>f.mergeKey==='사업명');assert(repeated.length>=2);assert(repeated.every(f=>f.valueText===project));
      gates++;targets+=fills;newErrors+=errors.length;
    }
  }
  assert.equal(gates,100);assert.equal(pairs,50);assert.equal(directChecks,50);assert(targets>=3000);assert.equal(newErrors,0);
  assert.equal(bodyChecks,100);assert.equal(tableChecks,100);assert.equal(headerChecks,100);assert.equal(zeroChecks,64);
  assert.deepEqual(Buffer.from(k.bytes),sourceBefore);for(const [sha,bytes] of blobBefore)assert.deepEqual(Buffer.from(k.blobs.get(sha)!),bytes);
  assert.equal(json(input),inputBefore);
  t.diagnostic('scope=synthetic; seed=0x7c0ffee; declared_places=41; rows=50; gates='+gates+'; fill_targets='+targets+'; engine_comparisons='+directChecks+'; deterministic_pairs='+pairs+'; body/table/header_checks=100/100/100; zero_value_checks=64; new_errors='+newErrors+'; source/data/template/proto/blobs_unchanged=true; actual_documents/UI/SQLite=unverified');
});

test('슬롯 선택 입력: 잘못된 행 번호·JSON·원형·인코딩·중첩을 명시적으로 거부',()=>{
  const k=noticeKit(),input=request(k,[record(),record(100000000)]),before=json(input);
  for(const row of [-1,2,0.5,NaN,Infinity,null,false,'',[],{},'0',undefined]) {
    rejected(()=>previewSelection({...input,row}),'SELECTION_INPUT');
  }
  for(const data of ['{','[]','null','42','"문자열"'])rejected(()=>previewSelection({...input,data}),'SELECTION_INPUT');
  rejected(()=>previewSelection({...input,data:'[null]',row:0}),'DATA_SCHEMA');
  rejected(()=>previewSelection({...input,template:'{'}),'TPL_JSON');
  rejected(()=>previewSelection({...input,protos:['{']}),'TPL_JSON');
  rejected(()=>previewSelection({...input,blobs:['!!!']}),'SELECTION_INPUT');
  rejected(()=>previewSelection({...input,action:{slot:'s1',mode:'manual',block:'b4'}}),'SELECTION_INPUT');
  rejected(()=>previewSelection({...input,action:{slot:'s2',mode:'confirm'}}),'SELECTION_INPUT');
  rejected(()=>previewSelection({...input,action:{slot:'missing',mode:'clear'}}),'SELECTION_INPUT');
  const nested=structuredClone(k.t),child=nested.slots.find(s=>s.id==='s3');assert(child);child.parent='b1';
  rejected(()=>previewSelection({...input,template:json(nested)}),'SELECTION_NESTED');
  assert.equal(json(input),before);
});

test('슬롯 선택 참조: 다른 데이터·행·해시·판과 없는 참조는 거부, 원본 없는 평가는 허용하되 생성 출력 없음',()=>{
  const k=noticeKit(),rows=[record(),record(100000000)],input=request(k,rows),p=previewSelection(input),c=readCase(p.case,p.template),before=json(input);
  rejected(()=>previewSelection({...input,row:1,case:p.case}),'SELECTION_INPUT');
  const changed=structuredClone(rows);changed[0]!['사업명']='다른 입력';
  rejected(()=>previewSelection({...input,data:json(changed),case:p.case}),'SELECTION_INPUT');
  for(const change of [
    {dataset:'d'+ '0'.repeat(24)}, {version:2}, {row:1}, {sha256:'0'.repeat(64)},
  ])rejected(()=>previewSelection({...input,case:json({...c,record:{...c.record,...change}})}),'SELECTION_INPUT');
  rejected(()=>previewSelection({...input,case:json({...c,template:{...c.template,id:'t00000000'}})}),'TPL_REF');
  rejected(()=>previewSelection({...input,case:json({...c,selections:{missing:{block:'b1',basis:'manual',content:contentSha256(k.t.blocks[0]!.content)}}})}),'TPL_REF');
  const noSource={...input,blobs:[...k.blobs.values()].map(b=>Buffer.from(b).toString('base64'))},unverified=previewSelection(noSource);
  assert.equal(unverified.sourceVerified,false);rejected(()=>generateSelection(noSource),'SELECTION_INPUT');
  const badSource=buildHwpx(['<hp:p']),badTemplate=structuredClone(k.t);badTemplate.source.sha256=sha256Hex(badSource);
  rejected(()=>previewSelection({...input,template:json(badTemplate),blobs:[badSource,...k.blobs.values()].map(b=>Buffer.from(b).toString('base64'))}),'XML_MALFORMED');
  rejected(()=>previewSelection({...input,blobs:[Buffer.from(k.bytes).toString('base64')]}),'TPL_FRAGMENT_MISSING');
  const undecided=generateSelection(input);assert(!undecided.ok);assert(!('output' in undecided));assert(undecided.report.issues.some(i=>i.code==='SEL_UNDECIDED'));
  const missing=record();delete missing['사업명'];const missingInput=request(k,[missing]),selected=previewSelection({...missingInput,action:{slot:'s2',mode:'manual',block:'b4'}});
  const failed=generateSelection({...missingInput,case:selected.case});assert(!failed.ok);assert(!('output' in failed));assert(failed.report.issues.some(i=>i.code==='DATA_MISSING'));
  const object=record(),one=previewSelection({...input,data:json(object),row:0});
  assert.equal(one.rows,1);assert.equal(one.record.dataset,'d'+sha256Hex(canonicalStudioJson(object)).slice(0,24));
  assert.equal(one.record.sha256,sha256Hex(canonicalStudioJson(object)));assert(one.sourceVerified);
  assert.equal(json(input),before);
});

async function withServer(run:(base:string)=>Promise<void>) {
  const server=createApp();
  const base=await new Promise<string>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{const address=server.address();assert(address&&typeof address==='object');done('http://127.0.0.1:'+address.port);});});
  try {await run(base);}finally {await new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()));}
}
function post(base:string,path:string,input:unknown):Promise<{status:number;headers:IncomingHttpHeaders;body:Buffer}> {
  const body=Buffer.from(json(input));
  return new Promise((done,fail)=>{
    const req=httpRequest(new URL('/api/selection/'+path,base),{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'Content-Length':body.length}},response=>{
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.once('error',fail);
      response.once('end',()=>done({status:response.statusCode!,headers:response.headers,body:Buffer.concat(chunks)}));
    });req.once('error',fail);req.end(body);
  });
}

test('슬롯 선택 HTTP: 미리보기의 선택·이번 건 복원과 실제 내려받은 HWPX가 공개 엔진과 동치',async()=>withServer(async base=>{
  const k=noticeKit(),row=record(60000000);row['재공고']=0;row['소속']=false;row['공고번호']='00123';
  const input=request(k,[row]),before=json(input),response=await post(base,'preview',{...input,action:{slot:'s2',mode:'manual',block:'b4'}});
  assert.equal(response.status,200);const p=JSON.parse(response.body.toString('utf8')) as ReturnType<typeof previewSelection>;
  assert.equal(p.sourceVerified,true);assert.deepEqual([slot(p,'s2').state,slot(p,'s2').block],['manual','b4']);
  assert.deepEqual(readCase(p.case,p.template).record,p.record);
  const restore=await post(base,'preview',{...input,case:p.case});assert.equal(restore.status,200);
  const restored=JSON.parse(restore.body.toString('utf8')) as ReturnType<typeof previewSelection>;assert.equal(restored.case,p.case);assert.deepEqual(restored.slots,p.slots);
  const generated=await post(base,'generate',{...input,case:p.case});assert.equal(generated.status,200);
  assert.equal(generated.headers['content-type'],'application/vnd.hancom.hwpx');assert.match(generated.headers['content-disposition']??'',/attachment.*document\.hwpx/);
  const direct=generateFromTemplate(k.bytes,p.template,row,readCase(p.case,p.template),loaderOf(k.blobs),{mode:'baseline'});assert(direct.ok&&!direct.dryRun&&direct.output instanceof Uint8Array);
  assert.deepEqual(generated.body,Buffer.from(direct.output));assert.deepEqual(compareToBaseline(validateDocument(k.bytes),validateDocument(generated.body)).newErrors,[]);
  const fields=listFields(docOf(generated.body)),no=fields.filter(f=>f.name==='소속'),ids=fields.filter(f=>f.mergeKey==='공고번호');
  assertZeroScope(k,generated.body,direct.report.moves,true);assert(no.length>=1&&ids.length>=1);assert(no.every(f=>f.valueText==='false'));assert(ids.every(f=>f.valueText==='00123'));
  assert.equal(json(input),before);
}));

test('슬롯 선택 HTTP: 미확정·동률은422 보고만 반환하고 출력이 없으며, 모두 확정한 뒤에만 내려받기',async()=>withServer(async base=>{
  const k=noticeKit(),raw=structuredClone(k.t);raw.options={...raw.options,requireConfirm:true};
  const input=request(k,[record(60000000)],raw),response=await post(base,'preview',input);assert.equal(response.status,200);
  let p=JSON.parse(response.body.toString('utf8')) as ReturnType<typeof previewSelection>;
  assert.equal(p.slots.filter(s=>s.blocked!==undefined).length,4);
  const failed=await post(base,'generate',{...input,case:p.case});assert.equal(failed.status,422);assert(failed.headers['content-type']?.startsWith('application/json'));assert.equal(failed.headers['content-disposition'],undefined);
  const error=JSON.parse(failed.body.toString('utf8'));assert.equal(error.code,'SEL_UNDECIDED');assert.equal(error.output,undefined);assert.equal(error.report.issues.filter((i:{severity:string})=>i.severity==='error').length,4);
  const selected=await post(base,'preview',{...input,case:p.case,action:{slot:'s2',mode:'manual',block:'b3'}});assert.equal(selected.status,200);p=JSON.parse(selected.body.toString('utf8'));
  for(const slotId of ['s1','s3','s4']) {
    const confirmed=await post(base,'preview',{...input,case:p.case,action:{slot:slotId,mode:'confirm'}});assert.equal(confirmed.status,200);p=JSON.parse(confirmed.body.toString('utf8'));
    assert.equal(slot(p,slotId).state,'confirmed');
  }
  assert(p.slots.every(s=>s.blocked===undefined));const success=await post(base,'generate',{...input,case:p.case});assert.equal(success.status,200);assert.equal(success.headers['content-type'],'application/vnd.hancom.hwpx');
  const direct=generateSelection({...input,case:p.case});assert(direct.ok&&!direct.dryRun&&direct.output instanceof Uint8Array);assert.deepEqual(success.body,Buffer.from(direct.output));
  const wrongRow=await post(base,'preview',{...input,row:null});assert.equal(wrongRow.status,400);assert.equal(JSON.parse(wrongRow.body.toString('utf8')).code,'SELECTION_INPUT');
}));
