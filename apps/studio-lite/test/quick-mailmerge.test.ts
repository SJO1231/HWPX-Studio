import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectFields, compareToBaseline, emptyTemplate, generate, isValidPath, listFields,
  openPackage, parseDocument, validateDocument, walkParagraphs,
} from '@hwpx-studio/engine';
import { buildHwpx, mutateEntryText, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { dataFor, longValue, rng } from '../../../packages/hwpx-engine/test/range-helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { analyzePlaces, generateAll, matchPlaces, parseQuickData } from '../src/quick.ts';
import { createWorkbench } from '../src/workbench.ts';

const source=()=>readFixture('merge/merge-fields');
const docOf=(bytes:Uint8Array)=>parseDocument(openPackage(bytes));
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
function controls(bytes:Uint8Array,kind:'begin'|'end') {
  const doc=docOf(bytes);
  return doc.sections.flatMap(section=>[...walkParagraphs(section.paragraphs)].flatMap(p=>p.fieldMarks.filter(mark=>mark.kind===kind).map(mark=>section.text.slice(mark.element.start,mark.element.end))));
}
const pureClicks=[
  {name:'성명',count:1,usable:true,fillable:1,merging:0,unfillable:[]},
  {name:'소속',count:1,usable:true,fillable:1,merging:0,unfillable:[]},
  {name:'이름',count:1,usable:true,fillable:1,merging:0,unfillable:[]},
  {name:'직위',count:1,usable:true,fillable:1,merging:0,unfillable:[]},
];

test('빠른 생성 MAILMERGE: 공개 33/4/8 fixture의 15메일머지 키·33곳 노출, 기존 클릭 행 불변',()=>{
  const bytes=source(),fields=listFields(docOf(bytes)),places=analyzePlaces(bytes),merges=fields.filter(f=>f.type==='MAILMERGE');
  assert.equal(merges.length,33);assert.equal(fields.filter(f=>f.type==='CLICK_HERE').length,4);
  const mergeKeys=new Set(merges.map(f=>f.mergeKey));assert.equal(mergeKeys.size,15);
  const merged=places.fields.filter(f=>f.mailMerge!==undefined);
  assert.equal(merged.length,15);assert.equal(merged.reduce((n,f)=>n+f.mailMerge!,0),33);
  assert.equal(places.fields.reduce((n,f)=>n+f.count,0),37);
  assert.deepEqual(places.fields.filter(f=>f.mailMerge===undefined),pureClicks);
  for(const row of merged) {
    const expected=merges.filter(f=>f.mergeKey===row.name).length;
    assert.equal(row.mailMerge,expected);assert.equal(row.count,expected);
    assert.equal(row.usable,isValidPath(row.name));assert.equal(row.fillable,expected);
  }
  const data=parseQuickData(encode(dataFor(docOf(bytes),()=> '합성 값'))),matches=matchPlaces(places,data.records);
  assert.equal(matches.filter(m=>m.kind==='field').length,19);
  assert.equal(matches.filter(m=>m.kind==='field'&&m.state==='badKey').length,3);
  assert(matches.filter(m=>m.kind==='field'&&m.state!=='badKey').every(m=>m.state==='ok'&&m.counts.ok===1));
  assert(places.fields.every(f=>f.name!==''),'빈 name 대신 MAILMERGE 키로 노출해야 한다');
  // 메일머지가 맡는 표시 글 안의 {{키}}는 다시 세지 않는다(엔진이 채우는 독립 표식 8곳만 남는다)
  assert.equal(places.placeholders.reduce((n,p)=>n+p.count,0),8);
});

test('빠른 생성 MAILMERGE: 같은 키의 클릭·메일머지 곳 수 병합과 키 없는/다른 필드 제외',()=>{
  const original=source(),doc=docOf(original),click=collectFields(doc).find(f=>f.info.type==='CLICK_HERE');assert(click);
  const xml=click.section.text.slice(click.begin.element.start,click.begin.element.end);
  assert(xml.includes('name="성명"'));
  const mixed=mutateEntryText(original,click.section.entryName,text=>text.slice(0,click.begin.element.start)+xml.replace('name="성명"','name="기관명"')+text.slice(click.begin.element.end));
  const merged=analyzePlaces(mixed).fields.find(f=>f.name==='기관명');assert(merged);
  const count=listFields(docOf(mixed)).filter(f=>f.type==='MAILMERGE'&&f.mergeKey==='기관명').length;
  assert.equal(merged.mailMerge,count);assert.equal(merged.count,count+1);assert.equal(merged.fillable,count+1);
  assert.equal(analyzePlaces(mixed).fields.filter(f=>f.name==='기관명').length,1);
  const make=(id:number,type:string,name:string,parameter='')=>'<hp:p id="'+id+'" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="'+id+'" type="'+type+'" name="'+name+'" editable="1" dirty="0" fieldid="'+id+'9">'+parameter+'</hp:fieldBegin></hp:ctrl><hp:t>합성 표시글</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="'+id+'" fieldid="'+id+'9"/></hp:ctrl></hp:run></hp:p>';
  const bytes=buildHwpx([make(1,'MAILMERGE','')+make(2,'DATE','숨긴 필드')+make(3,'CLICK_HERE','정상')+make(4,'MAILMERGE','','<hp:parameters><hp:stringParam name="FieldValue">bad key</hp:stringParam></hp:parameters>')]);
  const visible=analyzePlaces(bytes).fields;
  assert.equal(visible.length,2);assert(!visible.some(f=>f.name===''||f.name==='숨긴 필드'));
  assert.deepEqual(visible.find(f=>f.name==='정상'),{name:'정상',count:1,usable:true,fillable:1,merging:0,unfillable:[]});
  assert.deepEqual(visible.find(f=>f.name==='bad key'),{name:'bad key',count:1,usable:false,fillable:1,merging:0,unfillable:[],mailMerge:1});
});

// 이름 규칙 밖 메일머지 가운데 표시 글이 `{{키}}`인 2곳은 채우지 않아 결과에 남는다(#126): 실패 처리면 건마다 실패, 원래 글 유지면 41곳 채움 + 알림
const FIXTURE_LEFTOVER={count:2,keys:[{key:'참고 사항',count:1},{key:'계약 방법(수의)',count:1}]};

test('빠른 생성 MAILMERGE: seeded50행×2회, 41곳 채움·공개 엔진 동치·필드표식 보존·새 오류0',t=>{
  const bytes=source(),before=Buffer.from(bytes),doc=docOf(bytes),fieldsBefore=listFields(doc),places=analyzePlaces(bytes);
  const next=rng(0x2400c0de),rows=Array.from({length:50},(_,index)=>{
    const row=dataFor(doc,path=>'SYNTH_'+index+'_'+path+': '+longValue(next,400,700)+'\n둘째 문장 & <확인> "인용".\t탭 뒤 문장.');
    row['재공고']=0;row['소속']=false;row['공고번호']='00'+String(index).padStart(6,'0');return row;
  });
  assert(rows.every(row=>typeof row['사업명']==='string'&&row['사업명'].length>400));
  const input=encode(rows),inputBefore=Buffer.from(input),data=parseQuickData(input),dataBefore=JSON.stringify(data);
  const blocked=generateAll(bytes,places,data,'synthetic.hwpx','error');
  assert(blocked.every(r=>!r.view.ok&&r.output===undefined&&r.view.filled===41&&r.view.errors.length===1&&r.view.errors[0]!.code==='QUICK_LEFTOVER'));
  assert(blocked.every(r=>JSON.stringify(r.view.leftover)===JSON.stringify(FIXTURE_LEFTOVER)&&r.view.errors[0]!.detail==='남은 자리 2곳: {{참고 사항}} 1곳, {{계약 방법(수의)}} 1곳'));
  const first=generateAll(bytes,places,data,'synthetic.hwpx','keep'),second=generateAll(bytes,places,data,'synthetic.hwpx','keep');
  assert.equal(first.length,50);assert.equal(second.length,50);
  const baseline=validateDocument(bytes),begins=controls(bytes,'begin'),ends=controls(bytes,'end');
  let gates=0,filled=0,engineComparisons=0,pairs=0,controlChecks=0,newErrors=0;
  for(let index=0;index<rows.length;index++) {
    const a=first[index]!,b=second[index]!,record=data.records[index]!;assert('dataset' in record);
    assert(a.view.ok&&a.output,JSON.stringify(a.view.errors));assert(b.view.ok&&b.output,JSON.stringify(b.view.errors));
    assert.deepEqual(a.output,b.output);assert.deepEqual(a.view,b.view);pairs++;
    assert.deepEqual(a.view.leftover,FIXTURE_LEFTOVER);assert.deepEqual(a.view.notes.filter(n=>n.code==='QUICK_LEFTOVER_KEPT').length,1);
    const expected=generate(bytes,emptyTemplate(),record.dataset,{mode:'baseline',missing:'keep'});
    assert(expected.ok&&!expected.dryRun);assert.deepEqual(a.output,expected.output);engineComparisons++;
    assert.equal(expected.report.plan.actions.filter(action=>action.anchor.startsWith('{{')).reduce((n,action)=>n+action.targets,0),8,'공개 fixture의 독립 표식8곳 기준');
    for(const result of [a,b]) {
      assert(result.output);assert.equal(result.view.filled,41,'메일머지29+클릭4+독립표식8');
      const skips=result.view.skipped.filter(s=>s.code==='MERGE_KEY_NOT_PATH');
      assert.equal(skips.length,4);
      assert(skips.every(s=>s.plain.includes('메일머지')&&s.plain.includes('키')&&!s.plain.includes('MERGE_KEY')));
      assert(skips.every(s=>s.place?.includes('메일머지')));
      const after=listFields(docOf(result.output));assert.equal(after.length,37);
      assert.deepEqual(after.map(f=>[f.type,f.name,f.mergeKey,f.occurrence]),fieldsBefore.map(f=>[f.type,f.name,f.mergeKey,f.occurrence]));
      assert.deepEqual(controls(result.output,'end'),ends);
      assert.deepEqual(controls(result.output,'begin').map(xml=>xml.replace(/\bdirty="[^"]*"/g,'dirty="0"')),begins);
      for(const f of after) {
        const original=fieldsBefore.find(before=>before.type===f.type&&before.name===f.name&&before.mergeKey===f.mergeKey&&before.occurrence===f.occurrence);assert(original);
        if(f.type==='MAILMERGE'&&!isValidPath(f.mergeKey!)){assert.equal(f.valueText,original.valueText);assert.equal(f.dirty,original.dirty);}
        else assert.equal(f.dirty,'1');
      }
      assert.equal(after.find(f=>f.mergeKey==='재공고')?.valueText,'0');
      assert.equal(after.find(f=>f.name==='소속')?.valueText,'false');
      assert(after.filter(f=>f.mergeKey==='공고번호').every(f=>f.valueText===rows[index]!['공고번호']));
      assert(after.filter(f=>f.mergeKey==='사업명').every(f=>f.valueText===rows[index]!['사업명']),'같은 키의 반복 위치에 전체 긴 값 보존');
      const errors=compareToBaseline(baseline,validateDocument(result.output)).newErrors;assert.deepEqual(errors,[]);
      gates++;filled+=result.view.filled;controlChecks+=after.length;newErrors+=errors.length;
    }
  }
  assert.equal(gates,100);assert.equal(filled,4100);assert.equal(engineComparisons,50);assert.equal(pairs,50);assert.equal(controlChecks,3700);assert.equal(newErrors,0);
  assert.deepEqual(Buffer.from(bytes),before);assert.deepEqual(Buffer.from(input),inputBefore);assert.equal(JSON.stringify(data),dataBefore);
  t.diagnostic('scope=public_fixture_only; seed=0x2400c0de; MAILMERGE=33; CLICK_HERE=4; standalone_placeholders=8; rows=50; gates=100; direct_comparisons=50; deterministic_pairs=50; filled=4100; field_control_checks=3700; new_errors=0; source/data_unchanged=true; actual_30/16/26=unverified; quick_owned_placeholder_filter=unverified');
});

const syntheticField=(id:number,type:'CLICK_HERE'|'MAILMERGE',key:string,paired:boolean)=>{
  const parameters=type==='MAILMERGE'?'<hp:parameters cnt="1" name=""><hp:stringParam name="FieldValue">'+key+'</hp:stringParam></hp:parameters>':'';
  return '<hp:p id="'+id+'" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>앞 </hp:t><hp:ctrl><hp:fieldBegin id="'+id+'" type="'+type+'" name="'+(type==='CLICK_HERE'?key:'')+'" editable="1" dirty="0" fieldid="'+id+'9">'+parameters+'</hp:fieldBegin></hp:ctrl><hp:t>원래 표시글</hp:t>'+(paired?'<hp:ctrl><hp:fieldEnd beginIDRef="'+id+'" fieldid="'+id+'9"/></hp:ctrl>':'')+'<hp:t> 뒤</hp:t></hp:run></hp:p>';
};

for(const type of ['CLICK_HERE','MAILMERGE'] as const) {
  test('빠른 생성 MAILMERGE: 같은 키 '+type+' 정상1·끝 없는 메일머지1의 일부 채움도 줄바꿈 안내 보존',()=>{
    const bytes=buildHwpx([syntheticField(1,type,'같은키',true)+syntheticField(2,'MAILMERGE','같은키',false)]);
    const before=Buffer.from(bytes),places=analyzePlaces(bytes),input=encode({같은키:'첫째 줄\n둘째 줄\t셋째 & <확인>'}),inputBefore=Buffer.from(input),data=parseQuickData(input);
    const row=places.fields.find(f=>f.name==='같은키');assert(row);
    assert.equal(row.count,2);assert.equal(row.mailMerge,type==='MAILMERGE'?2:1);assert.equal(row.fillable,1);
    assert.deepEqual(row.unfillable,[{shape:'unpaired',count:1}]);
    const result=generateAll(bytes,places,data,'synthetic.hwpx','error')[0];assert(result?.view.ok&&result.output,JSON.stringify(result?.view.errors));
    const record=data.records[0];assert(record&&'dataset' in record);
    const direct=generate(bytes,emptyTemplate(),record.dataset,{mode:'baseline',missing:'error'});assert(direct.ok&&!direct.dryRun);
    assert.deepEqual(result.output,direct.output);assert.equal(result.view.filled,1);
    assert.equal(result.view.skipped.length,1);assert.equal(result.view.skipped[0]?.code,'FIELD_UNSUPPORTED_SHAPE');
    assert.equal(result.view.skipped[0]?.place,'메일머지 "같은키"');
    const after=listFields(docOf(result.output)),filled=after.find(f=>f.path[0]===0),blocked=after.find(f=>f.path[0]===1);
    assert(filled&&blocked);assert.equal(filled.valueText,'첫째 줄\n둘째 줄\t셋째 & <확인>');assert.equal(filled.dirty,'1');
    const originalBlocked=listFields(docOf(bytes)).find(f=>f.path[0]===1);assert(originalBlocked);
    assert.equal(blocked.valueText,originalBlocked.valueText);assert.equal(blocked.dirty,originalBlocked.dirty);
    assert.deepEqual(compareToBaseline(validateDocument(bytes),validateDocument(result.output)).newErrors,[]);
    assert.deepEqual(Buffer.from(bytes),before);assert.deepEqual(Buffer.from(input),inputBefore);
    assert.deepEqual(result.view.notes.filter(note=>note.code==='QUICK_MULTILINE').map(note=>note.place),['키 같은키'],'같은 키의 한 곳은 실제로 채웠으므로 건너뜀 때문에 줄바꿈 안내를 지우지 않는다');
  });
}

// 실제 공고서 모양을 합성으로 옮긴 회귀(#24): 메일머지 30곳(본문 12·표 칸 12·머리말 6, 같은 키 반복)의 표시 글이 `{{키}}`이고 그 가운데 4곳은 키가 이름 규칙 밖이다.
// 표시 글 안 `{{키}}`를 자리로 다시 세지 않아 "목록에 보인 채울 곳 수 = 실제 채운 곳 수"이고, 이름 규칙 밖 4곳은 건별 건너뜀(메일머지 자리 이름 포함)으로 남는다.
const MM_BODY=['공고번호','사업명','사업명','기관명','납품 장소','계약방법','담당자','연락처','금액','금액','납품기한','공고번호'];
const MM_CELLS=['품명','규격','수량','단가','금액(원)','납품기한','품명','규격','수량','단가','사업명','기관명'];
const MM_HEADER=['공고번호','사업명','담당 부서','기관명','계약 방법','연락처'];
const mmCtrl=(id:number,key:string)=>({
  begin:'<hp:ctrl><hp:fieldBegin id="'+id+'" type="MAILMERGE" name="" editable="0" dirty="0" zorder="-1" fieldid="'+(7000+id)+'" metaTag=""><hp:parameters cnt="2" name=""><hp:stringParam name="Command">'+key+'</hp:stringParam><hp:stringParam name="FieldValue">'+key+'</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>',
  end:'<hp:ctrl><hp:fieldEnd beginIDRef="'+id+'" fieldid="'+(7000+id)+'"/></hp:ctrl>',
});
/** `{{키}}` 표시 글을 든 메일머지를 `<hp:t>` 안에 끼우는 원문(앞뒤 글은 같은 run) */
const mmInline=(id:number,key:string,before:string,after=' 끝')=>{const c=mmCtrl(id,key);return before+'</hp:t>'+c.begin+'<hp:t>{{'+key+'}}</hp:t>'+c.end+'<hp:t>'+after;};
function realShapedSource() {
  const original=readFixture('hancom/header-footer'),section=docOf(original).sections[0]!;
  const firstEnd=section.paragraphs[0]!.element.end;
  let id=500;
  const body=MM_BODY.map((key,i)=>textPara(mmInline(++id,key,'본문'+i+': ')));
  const table=gridTable([9000,9000,9000,9000],3,[]);
  table.cells.forEach((cell,i)=>{cell.paragraphs=[textPara(mmInline(++id,MM_CELLS[i]!,'칸'+i+' '))];});
  const header=MM_HEADER.map((key,i)=>mmInline(++id,key,'머리'+i+' ','')).join(' / ');
  return mutateEntryText(original,section.entryName,xml=>
    xml.slice(0,firstEnd).replace('{{doc.title}}',header).replace('{{doc.owner}}','고정 꼬리말')+
    body.join('')+tableParagraph(table)+textPara('비고 {{비고}} 와 다시 {{비고}}')+textPara('바깥 고정 문단')+xml.slice(xml.lastIndexOf('</hs:sec>')),
  );
}

test('빠른 생성 MAILMERGE: 표시 글이 {{키}}인 메일머지 30곳을 {{키}}로 다시 세지 않고, 목록의 채울 곳 수와 seeded 50건×2회 실제 채움 수가 같다',t=>{
  const bytes=realShapedSource(),before=Buffer.from(bytes),baseline=validateDocument(bytes);
  assert.equal(baseline.errors.length,0,JSON.stringify(baseline.errors));
  const fieldsBefore=listFields(docOf(bytes));
  assert.equal(fieldsBefore.filter(f=>f.type==='MAILMERGE').length,30);
  const places=analyzePlaces(bytes);
  assert.equal(places.fields.reduce((n,f)=>n+f.count,0),30);
  assert.equal(places.fields.reduce((n,f)=>n+(f.mailMerge??0),0),30,'전부 메일머지로 센다(누름틀 0곳)');
  assert.deepEqual(places.placeholders,[{key:'비고',count:2}],'메일머지 표시 글 안 {{키}} 30곳은 세지 않는다');
  const bad=places.fields.filter(f=>!f.usable);
  assert.deepEqual(bad.map(f=>f.name).sort(),['계약 방법','금액(원)','납품 장소','담당 부서']);
  const listed=places.fields.filter(f=>f.usable).reduce((n,f)=>n+f.fillable,0)+places.placeholders.reduce((n,p)=>n+p.count,0);
  assert.equal(listed,28);
  assert.deepEqual(places.offRule,[],'이름 규칙 밖 메일머지의 표시 글 {{키}}는 그 필드가 자리이므로 규칙 밖 {{…}}로 따로 세지 않는다');

  const next=rng(0x24f1e1d5),keys=places.fields.filter(f=>f.usable).map(f=>f.name);
  const rows=Array.from({length:50},(_,i)=>{
    const row:Record<string,unknown>={비고:'비고 '+i+' '+longValue(next,200,400)};
    for(const key of keys)row[key]='SYN_'+i+'_'+key+': '+longValue(next,300,600)+'\n둘째 문장 & <확인> "인용" > 끝.\t탭 뒤 '+i;
    row['수량']=0;row['단가']=false;row['공고번호']='00'+String(i).padStart(6,'0');
    return row;
  });
  const input=encode(rows),inputBefore=Buffer.from(input),data=parseQuickData(input);
  const matches=matchPlaces(places,data.records);
  assert.equal(matches.filter(m=>m.kind==='field'&&m.state==='ok').length,keys.length);
  assert.equal(matches.filter(m=>m.kind==='field'&&m.state==='badKey').length,4);
  // 이름 규칙 밖 4곳은 표시 글 `{{키}}`가 결과에 남는다(#126): 실패 처리면 건마다 실패(26곳 채운 뒤 남은 4곳), 원래 글 유지면 성공 + 알림
  const shapedLeftover={count:4,keys:['담당 부서','계약 방법','납품 장소','금액(원)'].map(key=>({key,count:1}))};
  const blocked=generateAll(bytes,places,data,'shaped.hwpx','error');
  assert(blocked.every(r=>!r.view.ok&&r.output===undefined&&r.view.errors.map(e=>e.code).join()==='QUICK_LEFTOVER'));
  assert(blocked.every(r=>JSON.stringify(r.view.leftover)===JSON.stringify(shapedLeftover)),JSON.stringify(blocked[0]?.view.leftover));
  const first=generateAll(bytes,places,data,'shaped.hwpx','keep'),second=generateAll(bytes,places,data,'shaped.hwpx','keep');
  let filled=0,skips=0,newErrors=0,direct=0;
  for(let i=0;i<rows.length;i++){
    const a=first[i]!,b=second[i]!,record=data.records[i]!;assert('dataset' in record);
    assert(a.view.ok&&a.output,JSON.stringify(a.view.errors));
    assert.deepEqual(a.output,b.output);assert.deepEqual(a.view,b.view);
    assert.deepEqual(a.view.leftover,shapedLeftover);
    const expected=generate(bytes,emptyTemplate(),record.dataset,{mode:'baseline',missing:'keep'});
    assert(expected.ok&&!expected.dryRun);assert.deepEqual(a.output,expected.output);direct++;
    assert.equal(a.view.filled,listed,'목록의 채울 곳 수 = 실제 채운 곳 수');
    const notPath=a.view.skipped.filter(s=>s.code==='MERGE_KEY_NOT_PATH');
    assert.equal(notPath.length,4);assert.equal(a.view.skipped.length,4);
    assert(notPath.every(s=>s.place?.startsWith('메일머지 "')));
    const multiline=[...keys,'비고'].filter(k=>/[\n\r\t]/.test(String(rows[i]![k])));
    assert(multiline.length>=9);
    assert.deepEqual(a.view.notes.filter(n=>n.code==='QUICK_MULTILINE').map(n=>n.place).sort(),multiline.map(k=>'키 '+k).sort());
    const after=listFields(docOf(a.output));
    assert.deepEqual(after.map(f=>[f.type,f.mergeKey,f.occurrence]),fieldsBefore.map(f=>[f.type,f.mergeKey,f.occurrence]));
    for(const f of after)if(!isValidPath(f.mergeKey!))assert.equal(f.valueText,'{{'+f.mergeKey+'}}');
    assert(after.filter(f=>f.mergeKey==='사업명').every(f=>f.valueText===rows[i]!['사업명']));
    assert.equal(after.find(f=>f.mergeKey==='수량')?.valueText,'0');assert.equal(after.find(f=>f.mergeKey==='단가')?.valueText,'false');
    const errors=compareToBaseline(baseline,validateDocument(a.output)).newErrors;assert.deepEqual(errors,[]);
    filled+=a.view.filled;skips+=notPath.length;newErrors+=errors.length;
  }
  assert.equal(filled,1400);assert.equal(skips,200);assert.equal(newErrors,0);assert.equal(direct,50);
  assert.deepEqual(Buffer.from(bytes),before);assert.deepEqual(Buffer.from(input),inputBefore);
  t.diagnostic('seed=0x24f1e1d5; mailmerge=30 (body12/cell12/header6, key_not_path=4); placeholders_listed=2; display_placeholders_not_listed=26; rows=50x2; filled=1400; skipped=200; direct=50; new_errors=0');
});

// 작업창 추천 목록(#24): 서버가 주는 입력 항목 후보에 메일머지·누름틀이 오르고, 필드 표시 글 안 {{키}}는 따로 오르지 않는다(엔진 8.8.5). TXT는 전처럼 {{키}}만.
type Input={kind:'clickHere'|'mailMerge'|'placeholder';name:string;row:string;start:number;end:number;usable?:boolean};
type Opened={paragraphs:{id:string;text:string}[];inputs:Input[]};
const openIn=(name:string,bytes:Uint8Array)=>createWorkbench().post('/api/workbench/open',{name,content:Buffer.from(bytes).toString('base64')}) as Opened;

test('작업창 추천 후보: 공개 합성 서식은 메일머지 33·누름틀 4·독립 {{키}} 8, 필드 후보의 위치 글이 표시 글과 같다',()=>{
  const bytes=source(),opened=openIn('merge.hwpx',bytes),fields=listFields(docOf(bytes));
  const count=(kind:Input['kind'])=>opened.inputs.filter(x=>x.kind===kind).length;
  assert.deepEqual([count('mailMerge'),count('clickHere'),count('placeholder')],[33,4,8]);
  const text=(x:Input)=>{const r=opened.paragraphs.find(p=>p.id===x.row);assert(r,x.row);return r.text.slice(x.start,x.end);};
  const shown=opened.inputs.filter(x=>x.kind!=='placeholder');
  assert.deepEqual(shown.map(text).sort(),fields.filter(f=>f.type==='MAILMERGE'||f.type==='CLICK_HERE').map(f=>f.valueText).sort());
  assert.deepEqual(shown.filter(x=>x.usable===false).map(x=>x.name).sort(),fields.filter(f=>f.type==='MAILMERGE'&&!isValidPath(f.mergeKey!)).map(f=>f.mergeKey!).sort());
  for(const x of opened.inputs.filter(i=>i.kind==='placeholder'))
    assert(!shown.some(f=>f.row===x.row&&x.start<f.end&&x.end>f.start),'필드 표시 글 안 {{키}}는 따로 오르지 않는다');
  const order=new Map(opened.paragraphs.map((p,i)=>[p.id,i]));
  assert(opened.inputs.every((x,i,a)=>i===0||order.get(a[i-1]!.row)!<order.get(x.row)!||order.get(a[i-1]!.row)===order.get(x.row)&&a[i-1]!.start<=x.start),'문서 순서');
});

test('작업창 추천 후보: 실제 공고서 모양(메일머지 30곳·표시 글 {{키}})은 메일머지 30·{{키}} 2로 겹치지 않고, TXT는 {{키}}만 전처럼',()=>{
  const opened=openIn('shaped.hwpx',realShapedSource());
  assert.equal(opened.inputs.filter(x=>x.kind==='mailMerge').length,30);
  assert.deepEqual(opened.inputs.filter(x=>x.kind==='placeholder').map(x=>x.name),['비고','비고']);
  assert.equal(opened.inputs.filter(x=>x.usable===false).length,4);
  const txt=openIn('plain.txt',new TextEncoder().encode('제목 {{사업명}}\n{{#붙임}}\n금액 {{ 금액 }} 끝\n{{/붙임}}'));
  assert.deepEqual(txt.inputs.map(x=>[x.kind,x.name,x.row,x.start]),[['placeholder','사업명','p:0:0',3],['placeholder',' 금액 ','p:0:2',3]]);
});
