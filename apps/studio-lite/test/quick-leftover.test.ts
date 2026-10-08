// #126: 채우지 못한 {{…}}가 결과에 남으면 누락 정책 error는 실패, keep·empty는 알림(작업창·/quick 같은 판정). Helper 내보내기·생성 요청 JSON을 건마다 라벨–값으로 펼친다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareToBaseline, emptyTemplate, generate, listFields, openPackage, parseDocument, readDataset, validateDocument, walkParagraphs } from '@hwpx-studio/engine';
import { mutateEntryText, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { longValue, rng } from '../../../packages/hwpx-engine/test/range-helpers.ts';
import { gridTable, paragraph, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { analyzePlaces, findLeftovers, generateAll, leftoverIn, matchPlaces, parseQuickData } from '../src/quick.ts';
import { createWorkbench } from '../src/workbench.ts';

const docOf=(bytes:Uint8Array)=>parseDocument(openPackage(bytes));
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const texts=(bytes:Uint8Array)=>docOf(bytes).sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>p.logicalText));

// 합성 서식: 머리말 2·꼬리말 1·본문 24(키 8개 반복)·표 칸 12(키 6개 반복)·메일머지 3(맡는 표시 글 {{키}})에 더해,
// 채우지 못하는 곳 4: 혼합 서식 run 1(`{{혼합.키}}`), 규칙 밖 키 2(`{{추정가격(원)}}`·`{{담당 부서}}`), 이름 규칙 밖 메일머지의 표시 글 1(`{{계약 방법(수의)}}`)
const BODY_KEYS=['사업명','공고번호','기관명','납품기한','담당자','연락처','금액','비고'];
const CELL_KEYS=['품명','규격','수량','단가','합계','납품장소'];
let fieldId=900;
const merge=(key:string,before:string)=>{const id=++fieldId;return paragraph('<hp:t>'+before+'</hp:t><hp:ctrl><hp:fieldBegin id="'+id+'" type="MAILMERGE" name="" editable="0" dirty="0" fieldid="'+(7000+id)+'"><hp:parameters cnt="1" name=""><hp:stringParam name="FieldValue">'+key+'</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>{{'+key+'}}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="'+id+'" fieldid="'+(7000+id)+'"/></hp:ctrl><hp:t> 끝</hp:t>');};
function synthetic() {
  const original=readFixture('hancom/header-footer'),section=docOf(original).sections[0]!,firstEnd=section.paragraphs[0]!.element.end;
  const body=Array.from({length:12},(_,i)=>textPara('본문 '+i+': {{'+BODY_KEYS[i%8]+'}} 그리고 {{'+BODY_KEYS[(i+3)%8]+'}}'));
  const table=gridTable([9000,9000,9000,9000],3,[0,1,2].map(r=>[0,1,2,3].map(c=>'칸 {{'+CELL_KEYS[(r*4+c)%6]+'}}')));
  return mutateEntryText(original,section.entryName,xml=>xml.slice(0,firstEnd).replace('{{doc.title}}','머리 {{사업명}} / {{공고번호}}').replace('{{doc.owner}}','꼬리 {{기관명}}')
    +body.join('')+tableParagraph(table)
    +paragraph('<hp:t>혼합 {{혼합.</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>키}} 뒤</hp:t>')
    +textPara('추정 {{추정가격(원)}} 원')+textPara('부서 {{담당 부서}}')
    +merge('기관명','기관 ')+merge('기관명','다시 기관 ')+merge('공고번호','번호 ')+merge('계약 방법(수의)','방법 ')
    +textPara('구간 {{#붙임}} 표기는 {{/붙임}} 자리가 아님')+xml.slice(xml.lastIndexOf('</hs:sec>')));
}
const KEYS=[...BODY_KEYS,...CELL_KEYS,'혼합'];
const LEFT={count:4,keys:[{key:'혼합.키',count:1},{key:'추정가격(원)',count:1},{key:'담당 부서',count:1},{key:'계약 방법(수의)',count:1}]};
const FILLED=2+1+24+12+3;
/** 모든 키에 긴 가짜 값(여러 문장·줄바꿈·탭·XML 특수문자, 일부는 값 속 중괄호 표기) */
const rowOf=(next:()=>number,i:number)=>Object.fromEntries(KEYS.map((k,j)=>[k,k==='혼합'?{키:'주입 금지 '+i}:'SYN_'+i+'_'+k+': '+longValue(next,200,500)+'\n둘째 문장 & <확인> "인용".\t탭 뒤'+(j%5===0?' 값 속 {{가짜'+j+'}} 표기':'')]));

test('#126 남은 자리 판정: 구간 표기 제외·키별 곳 수·처음 나온 순서',()=>{
  assert.deepEqual(findLeftovers(['앞 {{a}} {{ b c }} {{#구간}} {{/구간}} {{a}}','{{}} {{x(원)}}']),{count:5,keys:[{key:'a',count:2},{key:'b c',count:1},{key:'',count:1},{key:'x(원)',count:1}]});
  assert.deepEqual(findLeftovers(['{ {a} } {{a} {a}}']),{count:0,keys:[]});
});

test('#126 /quick 합성 서식: 자리 목록의 규칙 밖 키, 정책 error=실패·keep/empty=알림, 남은 4곳 = 엔진 결과의 {{…}}',()=>{
  const bytes=synthetic(),before=Buffer.from(bytes),baseline=validateDocument(bytes);
  assert.equal(baseline.errors.length,0,JSON.stringify(baseline.errors));
  const places=analyzePlaces(bytes);
  assert.deepEqual(places.offRule,[{key:'추정가격(원)',count:1},{key:'담당 부서',count:1}],'규칙 밖 메일머지의 표시 글 {{…}}는 그 필드가 자리라 따로 세지 않는다');
  assert.equal(places.placeholders.reduce((n,p)=>n+p.count,0),2+1+24+12+1,'머리말·꼬리말·본문·표 칸·혼합 run(맡는 메일머지 표시 글 3곳 제외)');
  assert.deepEqual(places.fields.filter(f=>!f.usable).map(f=>f.name),['계약 방법(수의)']);
  const next=rng(0x126a),data=parseQuickData(encode([rowOf(next,0),rowOf(next,1)]));
  const matches=matchPlaces(places,data.records);
  assert.deepEqual(matches.filter(m=>m.state==='badKey').map(m=>[m.kind,m.key]),[['field','계약 방법(수의)'],['placeholder','추정가격(원)'],['placeholder','담당 부서']]);
  const blocked=generateAll(bytes,places,data,'합성.hwpx','error');
  for(const r of blocked){
    assert.equal(r.view.ok,false);assert.equal(r.output,undefined);assert.equal(r.view.filled,FILLED);
    assert.deepEqual(r.view.leftover,LEFT);assert.deepEqual(r.view.errors.map(e=>e.code),['QUICK_LEFTOVER']);
    assert.equal(r.view.errors[0]!.detail,'남은 자리 4곳: {{혼합.키}} 1곳, {{추정가격(원)}} 1곳, {{담당 부서}} 1곳, {{계약 방법(수의)}} 1곳');
    assert.deepEqual(r.view.skipped.map(s=>s.code).sort(),['FILL_MIXED_FORMAT','MERGE_KEY_NOT_PATH']);
  }
  for(const policy of ['keep','empty'] as const){
    const results=generateAll(bytes,places,data,'합성.hwpx',policy);
    for(const [i,r] of results.entries()){
      assert(r.view.ok&&r.output,JSON.stringify(r.view.errors));assert.equal(r.view.filled,FILLED);assert.deepEqual(r.view.leftover,LEFT);
      assert.deepEqual(r.view.notes.filter(n=>n.code==='QUICK_LEFTOVER_KEPT').map(n=>n.detail),[blocked[i]!.view.errors[0]!.detail]);
      const record=data.records[i]!;assert('dataset' in record);
      const direct=generate(bytes,emptyTemplate(),record.dataset,{missing:policy});assert(direct.ok&&!direct.dryRun);
      assert.deepEqual(r.output,direct.output,'남은 자리 판정은 결과 바이트를 바꾸지 않는다');
      const raw=leftoverIn(r.output),fromValues=texts(r.output).join('\n').match(/\{\{가짜\d+\}\}/g)?.length??0;
      assert(fromValues>0,'값 속 {{…}} 표기가 결과에 그대로 보인다');assert.equal(raw.count-LEFT.count,fromValues,'더 보인 것은 값에서 온 표기뿐이고 남은 자리로 세지 않는다');
      assert.deepEqual(compareToBaseline(baseline,validateDocument(r.output)).newErrors,[]);
    }
  }
  // 키 하나가 빠지면: error는 엔진의 DATA_MISSING 실패, keep은 그 키의 {{…}}도 남은 자리로 센다
  const missing=parseQuickData(encode([{...rowOf(next,2),비고:null}]));
  assert.deepEqual(generateAll(bytes,places,missing,'합성.hwpx','error')[0]!.view.errors.map(e=>e.code),['DATA_MISSING']);
  const kept=generateAll(bytes,places,missing,'합성.hwpx','keep')[0]!,note=places.placeholders.find(p=>p.key==='비고')!.count;
  assert.equal(note,2);assert(kept.view.ok);assert.equal(kept.view.leftover?.count,LEFT.count+note);assert.deepEqual(kept.view.leftover?.keys.find(k=>k.key==='비고'),{key:'비고',count:note});
  assert.deepEqual(Buffer.from(bytes),before);
});

test('#126 Helper JSON 두 꼴: 건마다 평평한 라벨–값, 이름 충돌·판 거절, 배열 데이터와 같은 결과',()=>{
  const bytes=synthetic(),places=analyzePlaces(bytes),next=rng(0x126b),rows=[rowOf(next,0),rowOf(next,1),rowOf(next,2)];
  const split=(row:Record<string,unknown>)=>{const keys=Object.keys(row);return {fields:Object.fromEntries(keys.slice(0,9).map(k=>[k,row[k]])),userValues:Object.fromEntries(keys.slice(9).map(k=>[k,row[k]]))};};
  const exported=parseQuickData(encode({format:'g2b-helper-document',version:1,source:{pointInfo:{areaCd:'00',depth1:'0',depth2:'0'},tables:{목록:rows.slice(0,2),빈표:[]}}}));
  assert.equal(exported.form,'helperExport');assert.deepEqual(exported.records.map(r=>'dataset' in r&&r.dataset.data),rows.slice(0,2));
  const frames=parseQuickData(encode({format:'g2b-helper-document',version:1,source:{frames:[{pointInfo:{},tables:{가:[rows[0]]}},{pointInfo:{},tables:{나:[rows[1],'행 아님']}}]}}));
  assert.deepEqual(frames.records.map(r=>'dataset' in r?r.dataset.data:r.error.code),[rows[0],rows[1],'DATA_SCHEMA']);
  const db=parseQuickData(encode({format:'g2b-helper-document',version:1,source:rows.map(r=>({stage:'contract',identity:['X'],recordId:'r',...split(r),children:[]}))}));
  assert.deepEqual(db.records.map(r=>'dataset' in r&&r.dataset.data),rows);
  const request=parseQuickData(encode({requestId:'synthetic-1',profileId:'p',sourceKind:'screen',items:[...rows.map(r=>({...split(r),children:[]})),{fields:{사업명:'SECRET_A'},userValues:{사업명:'SECRET_B',비고:'SECRET_C'},children:[]},{fields:'아님',userValues:{}}]}));
  assert.equal(request.form,'helperRequest');assert.equal(request.records.length,5);
  assert.deepEqual(request.records.slice(0,3).map(r=>'dataset' in r&&r.dataset.data),rows);
  const clash=request.records[3]!;assert('error' in clash&&clash.error.code==='QUICK_FIELD_COLLISION'&&clash.error.message.includes('사업명')&&!clash.error.message.includes('SECRET'));
  assert('error' in request.records[4]!&&request.records[4].error.code==='DATA_SCHEMA');
  assert.throws(()=>parseQuickData(encode({format:'g2b-helper-document',version:2,source:[]})),(e:any)=>e.code==='QUICK_HELPER_VERSION');
  assert.throws(()=>parseQuickData(encode({format:'g2b-helper-document',version:1,source:{pointInfo:{},tables:{빈표:[]}}})),(e:any)=>e.code==='QUICK_NO_RECORDS');
  assert.equal(parseQuickData(encode({requestId:'x'})).form,'object','items가 없으면 생성 요청이 아니다(기존 동작)');
  const plain=generateAll(bytes,places,parseQuickData(encode(rows)),'합성.hwpx','keep');
  for(const data of [db,request]){
    const results=generateAll(bytes,places,data,'합성.hwpx','keep');
    for(let i=0;i<3;i++){assert(results[i]!.view.ok);assert.deepEqual(results[i]!.output,plain[i]!.output);assert.deepEqual(results[i]!.view,plain[i]!.view);}
  }
  const failed=generateAll(bytes,places,request,'합성.hwpx','keep').slice(3);
  assert.deepEqual(failed.map(r=>[r.view.ok,r.view.errors[0]?.code]),[[false,'QUICK_FIELD_COLLISION'],[false,'DATA_SCHEMA']]);
});

test('#126 Helper JSON 무작위 50건×2회: 두 꼴 결정성·엔진 직접 생성과 같음·남은 4곳 고정·검사기 새 오류 0',t=>{
  const bytes=synthetic(),before=Buffer.from(bytes),baseline=validateDocument(bytes),places=analyzePlaces(bytes),next=rng(0x126c);
  const rows=Array.from({length:50},(_,i)=>rowOf(next,i));
  const items=rows.map(row=>{const keys=Object.keys(row).sort(()=>next()-0.5),cut=Math.floor(next()*keys.length);return {fields:Object.fromEntries(keys.slice(0,cut).map(k=>[k,row[k]])),userValues:Object.fromEntries(keys.slice(cut).map(k=>[k,row[k]])),children:[]};});
  const forms=[
    parseQuickData(encode({format:'g2b-helper-document',version:1,source:{pointInfo:{},tables:{목록:rows}}})),
    parseQuickData(encode({requestId:'seeded-126',profileId:'p',sourceKind:'db',items})),
  ];
  let generated=0,direct=0,pairs=0,newErrors=0,blocked=0;
  for(const data of forms){
    const first=generateAll(bytes,places,data,'seeded.hwpx','keep'),second=generateAll(bytes,places,data,'seeded.hwpx','keep');
    const strict=generateAll(bytes,places,data,'seeded.hwpx','error');
    for(let i=0;i<50;i++){
      const a=first[i]!,b=second[i]!,record=data.records[i]!;assert('dataset' in record);
      assert(a.view.ok&&a.output,JSON.stringify(a.view.errors));assert.deepEqual(a.output,b.output);assert.deepEqual(a.view,b.view);pairs++;
      assert.deepEqual(a.view.leftover,LEFT);assert.equal(a.view.filled,FILLED);
      const expected=generate(bytes,emptyTemplate(),readDataset(rows[i]),{missing:'keep'});assert(expected.ok&&!expected.dryRun);assert.deepEqual(a.output,expected.output);direct++;
      assert.equal(listFields(docOf(a.output)).find(f=>f.mergeKey==='기관명')?.valueText,rows[i]!['기관명']);
      const errors=compareToBaseline(baseline,validateDocument(a.output)).newErrors;assert.deepEqual(errors,[]);newErrors+=errors.length;
      assert(!strict[i]!.view.ok&&strict[i]!.output===undefined&&JSON.stringify(strict[i]!.view.leftover)===JSON.stringify(LEFT));blocked++;
      generated+=2;
    }
  }
  assert.deepEqual(Buffer.from(bytes),before);
  assert.equal(generated,200);assert.equal(direct,100);assert.equal(pairs,100);assert.equal(blocked,100);assert.equal(newErrors,0);
  t.diagnostic('seed=0x126c; forms=2(export,request); rows=50; places=46(filled 42, leftover 4: mixed run 1, off-rule 2, bad-key mailmerge 1); keep_generations=200; deterministic_pairs=100; direct_equal=100; error_blocked=100; new_errors=0; brace_values_not_counted=true');
});

test('#126 작업창 HWPX: 같은 합성 서식에서 남은 자리는 기본 정책이면 막고 자리 유지면 알림, 데이터에 없는 키는 키 이름과 함께 막음',()=>{
  const bytes=synthetic(),app=createWorkbench();
  const opened=app.post('/api/workbench/open',{name:'synthetic.hwpx',content:Buffer.from(bytes).toString('base64')}) as any;
  const work={session:opened.session,index:0,edits:[],headings:[],blocks:[]};
  assert.deepEqual(opened.inputs.filter((x:any)=>x.usable===false).map((x:any)=>x.name.trim()).sort(),['계약 방법(수의)','담당 부서','추정가격(원)'].sort());
  const next=rng(0x126d),row=rowOf(next,0);
  app.post('/api/workbench/data',{session:opened.session,name:'helper.json',content:JSON.stringify({format:'g2b-helper-document',version:1,source:{pointInfo:{},tables:{목록:[row]}}})});
  assert.throws(()=>app.post('/api/workbench/generate',work),(e:any)=>e.code==='WORKBENCH_UNLINKED'&&e.message.includes('남은 자리 4곳: {{혼합.키}} 1곳, {{추정가격(원)}} 1곳, {{담당 부서}} 1곳, {{계약 방법(수의)}} 1곳')&&!e.message.includes('SYN_'));
  assert.throws(()=>app.get('/api/workbench/result',new URLSearchParams({session:opened.session})),(e:any)=>e.code==='WORKBENCH_RESULT');
  const kept=app.post('/api/workbench/generate',{...work,missing:'keep'}) as any;
  assert.equal(kept.ok,true);assert.equal(kept.unresolved,4);assert.equal(kept.filled,FILLED);assert(kept.notes.some((n:string)=>n.includes('남은 자리 4곳')));
  const out=app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.body;
  const direct=generate(bytes,emptyTemplate(),readDataset(row),{missing:'keep',mode:'baseline'});assert(direct.ok&&!direct.dryRun);assert.deepEqual(out,direct.output);
  assert.deepEqual(compareToBaseline(validateDocument(bytes),validateDocument(out)).newErrors,[]);
  app.post('/api/workbench/data',{session:opened.session,name:'missing.json',content:JSON.stringify([{...row,비고:null}])});
  assert.throws(()=>app.post('/api/workbench/generate',work),(e:any)=>e.code==='WORKBENCH_UNLINKED'&&e.message.includes('데이터에 없는 키 1개: 비고'));
  const partial=app.post('/api/workbench/generate',{...work,missing:'keep'}) as any;assert.equal(partial.unresolved,4+2,'비고 {{…}} 2곳이 더 남는다');
  assert.deepEqual(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body,bytes);
});

test('#126 예시 파일: Helper 내보내기·생성 요청 예시는 data-mailmerge.json과 같은 결과, 실패 처리면 남은 2곳으로 실패·원래 글 유지면 41곳 + 알림',()=>{
  const read=(name:string)=>new Uint8Array(readFileSync(new URL('../../../examples/quick/'+name,import.meta.url)));
  const bytes=read('template-mailmerge.hwpx'),places=analyzePlaces(bytes);
  const plain=generateAll(bytes,places,parseQuickData(read('data-mailmerge.json')),'template-mailmerge.hwpx','keep');
  for(const [name,form] of [['data-helper-export.json','helperExport'],['data-helper-request.json','helperRequest']] as const){
    const data=parseQuickData(read(name));assert.equal(data.form,form);assert.equal(data.records.length,2);
    const kept=generateAll(bytes,places,data,'template-mailmerge.hwpx','keep');
    for(let i=0;i<2;i++){assert(kept[i]!.view.ok);assert.equal(kept[i]!.view.filled,41);assert.deepEqual(kept[i]!.output,plain[i]!.output);assert.equal(kept[i]!.view.leftover?.count,2);}
    const blocked=generateAll(bytes,places,data,'template-mailmerge.hwpx','error');
    assert.deepEqual(blocked.map(r=>[r.view.ok,r.view.errors[0]?.detail]),[[false,'남은 자리 2곳: {{참고 사항}} 1곳, {{계약 방법(수의)}} 1곳'],[false,'남은 자리 2곳: {{참고 사항}} 1곳, {{계약 방법(수의)}} 1곳']]);
  }
});
