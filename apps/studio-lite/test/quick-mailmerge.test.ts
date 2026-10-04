import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectFields, compareToBaseline, emptyTemplate, generate, isValidPath, listFields,
  openPackage, parseDocument, validateDocument, walkParagraphs,
} from '@hwpx-studio/engine';
import { buildHwpx, mutateEntryText, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { dataFor, longValue, rng } from '../../../packages/hwpx-engine/test/range-helpers.ts';
import { analyzePlaces, generateAll, matchPlaces, parseQuickData } from '../src/quick.ts';

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

test('빠른 생성 MAILMERGE: seeded50행×2회, 41곳 채움·공개 엔진 동치·필드표식 보존·새 오류0',t=>{
  const bytes=source(),before=Buffer.from(bytes),doc=docOf(bytes),fieldsBefore=listFields(doc),places=analyzePlaces(bytes);
  const next=rng(0x2400c0de),rows=Array.from({length:50},(_,index)=>{
    const row=dataFor(doc,path=>'SYNTH_'+index+'_'+path+': '+longValue(next,400,700)+'\n둘째 문장 & <확인> "인용".\t탭 뒤 문장.');
    row['재공고']=0;row['소속']=false;row['공고번호']='00'+String(index).padStart(6,'0');return row;
  });
  assert(rows.every(row=>typeof row['사업명']==='string'&&row['사업명'].length>400));
  const input=encode(rows),inputBefore=Buffer.from(input),data=parseQuickData(input),dataBefore=JSON.stringify(data);
  const first=generateAll(bytes,places,data,'synthetic.hwpx','error'),second=generateAll(bytes,places,data,'synthetic.hwpx','error');
  assert.equal(first.length,50);assert.equal(second.length,50);
  const baseline=validateDocument(bytes),begins=controls(bytes,'begin'),ends=controls(bytes,'end');
  let gates=0,filled=0,engineComparisons=0,pairs=0,controlChecks=0,newErrors=0;
  for(let index=0;index<rows.length;index++) {
    const a=first[index]!,b=second[index]!,record=data.records[index]!;assert('dataset' in record);
    assert(a.view.ok&&a.output,JSON.stringify(a.view.errors));assert(b.view.ok&&b.output,JSON.stringify(b.view.errors));
    assert.deepEqual(a.output,b.output);assert.deepEqual(a.view,b.view);pairs++;
    const expected=generate(bytes,emptyTemplate(),record.dataset,{mode:'baseline',missing:'error'});
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
