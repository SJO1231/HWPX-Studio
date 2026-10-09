// #126: 채우지 못한 {{…}}가 결과에 남으면 누락 정책 error는 실패, keep·empty는 알림(작업창·/quick 같은 판정). #133: Helper 내보내기 파일(생성 요청 2판 꼴)은 항목의 values마다 한 건.
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

test('#133 Helper 내보내기 파일(생성 요청 2판 꼴): 항목의 values마다 한 건, values 없는 항목만 실패, 판·꼴 거절, 옛 두 꼴은 더 읽지 않음, 배열 데이터와 같은 결과',()=>{
  const bytes=synthetic(),places=analyzePlaces(bytes),next=rng(0x133b),rows=[rowOf(next,0),rowOf(next,1),rowOf(next,2)];
  const exported=(items:unknown[],extra:Record<string,unknown>={})=>encode({format:'studio-generate',version:2,requestId:'',profileId:'',types:{금액:'text'},items,columns:[{key:'사업명',label:'사업 이름',type:'text'}],...extra});
  const data=parseQuickData(exported([...rows.map((values,i)=>({values,allowEmpty:[],selections:{},meta:{identity:['X',String(i)]}})),{allowEmpty:[]},'항목 아님']));
  assert.equal(data.form,'helperExport');assert.equal(data.records.length,5);
  assert.deepEqual(data.records.slice(0,3).map(r=>'dataset' in r&&r.dataset.data),rows);
  assert.deepEqual(data.records.slice(3).map(r=>'error' in r&&r.error.code),['DATA_SCHEMA','DATA_SCHEMA']);
  for(const bad of [{version:1},{version:3},{items:{}}])assert.throws(()=>parseQuickData(exported([{values:rows[0]}],bad)),(e:any)=>e.code==='QUICK_BAD_DATA');
  assert.throws(()=>parseQuickData(exported([])),(e:any)=>e.code==='QUICK_NO_RECORDS');
  // PR #143의 옛 두 꼴(g2b-helper-document v1, 1판 생성 요청)은 알아보지 않고 객체 하나(한 건)로 읽는다
  const old=parseQuickData(encode({format:'g2b-helper-document',version:1,source:{pointInfo:{},tables:{목록:rows}}}));
  assert.equal(old.form,'object');assert.equal(old.records.length,1);
  const request=parseQuickData(encode({requestId:'r',profileId:'p',sourceKind:'db',items:rows.map(r=>({fields:r,userValues:{},children:[]}))}));
  assert.equal(request.form,'object');assert.equal(request.records.length,1);
  const plain=generateAll(bytes,places,parseQuickData(encode(rows)),'합성.hwpx','keep'),results=generateAll(bytes,places,data,'합성.hwpx','keep');
  for(let i=0;i<3;i++){assert(results[i]!.view.ok);assert.deepEqual(results[i]!.output,plain[i]!.output);assert.deepEqual(results[i]!.view,plain[i]!.view);}
  assert.deepEqual(results.slice(3).map(r=>[r.view.ok,r.view.errors[0]?.code]),[[false,'DATA_SCHEMA'],[false,'DATA_SCHEMA']]);
});

test('#133 Helper 내보내기 파일 무작위 50건×2회: 결정성·엔진 직접 생성과 같음·남은 4곳 고정·검사기 새 오류 0',t=>{
  const bytes=synthetic(),before=Buffer.from(bytes),baseline=validateDocument(bytes),places=analyzePlaces(bytes),next=rng(0x126c);
  const rows=Array.from({length:50},(_,i)=>rowOf(next,i));
  const data=parseQuickData(encode({format:'studio-generate',version:2,requestId:'seeded-133',profileId:'p',items:rows.map((values,i)=>({values,meta:{identity:[String(i)]}}))}));
  assert.equal(data.form,'helperExport');
  let generated=0,direct=0,pairs=0,newErrors=0,blocked=0;
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
  assert.deepEqual(Buffer.from(bytes),before);
  assert.equal(generated,100);assert.equal(direct,50);assert.equal(pairs,50);assert.equal(blocked,50);assert.equal(newErrors,0);
  t.diagnostic('seed=0x126c; form=helperExport(studio-generate v2); rows=50; places=46(filled 42, leftover 4: mixed run 1, off-rule 2, bad-key mailmerge 1); keep_generations=100; deterministic_pairs=50; direct_equal=50; error_blocked=50; new_errors=0; brace_values_not_counted=true');
});

test('#126 #190 작업창 HWPX: 같은 합성 서식에서 남은 자리는 기본 정책이면 막고 자리 유지면 알림, 데이터에 없는 키는 키 이름과 함께 막음, 혼합 서식 {{키}}는 정책과 관계없이 막음',()=>{
  const bytes=synthetic(),app=createWorkbench();
  const opened=app.post('/api/workbench/open',{name:'synthetic.hwpx',content:Buffer.from(bytes).toString('base64')}) as any;
  const work={session:opened.session,index:0,edits:[],headings:[],blocks:[]};
  assert.deepEqual(opened.inputs.filter((x:any)=>x.usable===false).map((x:any)=>x.name.trim()).sort(),['계약 방법(수의)','담당 부서','추정가격(원)'].sort());
  const next=rng(0x126d),row=rowOf(next,0);
  app.post('/api/workbench/data',{session:opened.session,name:'helper.json',content:JSON.stringify({format:'studio-generate',version:2,requestId:'',profileId:'',items:[{values:row}]})});
  // #190: 값 단계는 늘 Helper 2판과 같은 생성이다. 규칙 밖 이름도 서식 판의 키라 데이터에 없으면 키 이름과 함께 막고, 혼합 서식 {{키}}는 자리 유지여도 막는다(키 이름과 곳 수)
  assert.throws(()=>app.post('/api/workbench/generate',work),(e:any)=>e.code==='WORKBENCH_UNLINKED'&&e.message.includes('데이터에 없는 키 3개: 추정가격(원), 담당 부서, 계약 방법(수의)')&&!e.message.includes('SYN_'));
  assert.throws(()=>app.get('/api/workbench/result',new URLSearchParams({session:opened.session})),(e:any)=>e.code==='WORKBENCH_RESULT');
  const items=opened.inputs.map((x:any)=>({row:x.row,start:x.start,end:x.end,name:x.name.trim(),key:x.usable?x.name.trim():'',type:'text',status:x.name.trim()==='혼합.키'?'excluded':'recommended',origin:x.kind}));
  // 금액 값 표가 없을 때(입력 항목 없음·글)와 있을 때(금액 타입) 같은 판정
  for(const type of [undefined,'text','money'])assert.throws(()=>app.post('/api/workbench/generate',{...work,missing:'keep',...(type?{inputItems:items.map((i:any)=>({...i,status:'recommended',type:i.name==='금액'?type:'text'}))}:{})}),(e:any)=>e.code==='FILL_SKIPPED'&&e.message.includes('{{키}} 자리 1곳(혼합.키)')&&!e.message.includes('SYN_'));
  // 혼합 서식 {{키}}를 추천 목록에서 제외하면 서식 판에 없는 자리라 그대로 남는다(남은 자리 알림)
  const kept=app.post('/api/workbench/generate',{...work,missing:'keep',inputItems:items}) as any;
  assert.equal(kept.ok,true);assert.equal(kept.unresolved,4);assert.equal(kept.filled,FILLED);assert(kept.notes.some((n:string)=>n.includes('남은 자리 4곳')));
  const out=app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.body;
  const direct=generate(bytes,emptyTemplate(),readDataset(row),{missing:'keep',mode:'baseline'});assert(direct.ok&&!direct.dryRun);assert.deepEqual(out,direct.output);
  assert.deepEqual(compareToBaseline(validateDocument(bytes),validateDocument(out)).newErrors,[]);
  app.post('/api/workbench/data',{session:opened.session,name:'missing.json',content:JSON.stringify([{...row,비고:null}])});
  assert.throws(()=>app.post('/api/workbench/generate',work),(e:any)=>e.code==='WORKBENCH_UNLINKED'&&e.message.includes('데이터에 없는 키 4개: 비고, 추정가격(원)'));
  const partial=app.post('/api/workbench/generate',{...work,missing:'keep',inputItems:items}) as any;assert.equal(partial.unresolved,4+2,'비고 {{…}} 2곳이 더 남는다');
  assert.deepEqual(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body,bytes);
});

test('#133 예시 파일: Helper 내보내기 예시(평평한 값)는 같은 값의 배열 데이터와 같은 결과, 점 경로 {{…}} 8곳은 값이 없어 실패 처리면 실패·원래 글 유지면 33곳 + 남은 10곳',()=>{
  const read=(name:string)=>new Uint8Array(readFileSync(new URL('../../../examples/quick/'+name,import.meta.url)));
  const bytes=read('template-mailmerge.hwpx'),places=analyzePlaces(bytes);
  const file=JSON.parse(new TextDecoder().decode(read('data-helper-export.json')));
  assert.equal(file.format,'studio-generate');assert.equal(file.version,2);
  for(const it of file.items)for(const v of Object.values(it.values))assert(v===null||typeof v!=='object','값은 글자·숫자·참거짓·null만');
  const data=parseQuickData(read('data-helper-export.json'));assert.equal(data.form,'helperExport');assert.equal(data.records.length,2);
  const plain=generateAll(bytes,places,parseQuickData(encode(file.items.map((it:any)=>it.values))),'template-mailmerge.hwpx','keep');
  // data-mailmerge.json(중첩 값)은 41곳을 채우고 2곳이 남는다. 평평한 예시에는 project·dates·manager가 없어 그 점 경로 {{…}} 8곳이 더 남는다
  const nested=places.placeholders.filter(p=>/^(project|dates|manager)\./.test(p.key)).reduce((n,p)=>n+p.count,0);assert.equal(nested,8);
  const kept=generateAll(bytes,places,data,'template-mailmerge.hwpx','keep');
  for(let i=0;i<2;i++){assert(kept[i]!.view.ok);assert.deepEqual(kept[i]!.output,plain[i]!.output);assert.equal(kept[i]!.view.filled,41-nested);assert.equal(kept[i]!.view.leftover?.count,2+nested);}
  const blocked=generateAll(bytes,places,data,'template-mailmerge.hwpx','error');
  assert(blocked.every(r=>!r.view.ok&&r.output===undefined));
});
