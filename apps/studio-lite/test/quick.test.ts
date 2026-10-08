import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyTemplate, generate, listFields, openPackage, parseDocument, readTemplate, validateDocument, type Dataset } from '@hwpx-studio/engine';
import { draftsFor } from '../../../packages/viewer/src/host/index.ts';
import { locatePicked } from '../../../packages/viewer/src/map/index.ts';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { analyzePlaces, generateAll, matchPlaces, parseQuickData } from '../src/quick.ts';

const P=(inner:string)=>`<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${inner}</hp:p>`;
const R=(inner:string,charPr='0')=>`<hp:run charPrIDRef="${charPr}">${inner}</hp:run>`;
const T=(value:string)=>`<hp:t>${value}</hp:t>`;
const synth=(paragraphs:string[])=>buildHwpx([P(R(T('합성 고정 문단')))+paragraphs.join('')]);
const FIELD_BEGIN=(id:string,name:string,dirty:string,_guide:string)=>`<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="${dirty}" fieldid="${id}9"/></hp:ctrl>`;
const FIELD_END=(id:string)=>`<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}9"/></hp:ctrl>`;

const enc=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
const docOf=(b:Uint8Array)=>parseDocument(openPackage(b));
const lines=(b:Uint8Array)=>docOf(b).sections[0].paragraphs.map(p=>p.logicalText);
const scalarSource=()=>synth([
  P(R(T('금액 {{amount}} 활성 {{active}} 번호 {{id}}'))),
  P(R(FIELD_BEGIN('11','성명','1','이름 안내')+T('원래 이름')+FIELD_END('11'))),
]);

test('Lite 빠른 생성: 자리·대조표 → 건별 생성은 엔진과 바이트 동치, 0·false·앞자리 0 유지',()=>{
  const source=scalarSource(),before=Buffer.from(source),places=analyzePlaces(source);
  const data=parseQuickData(enc([
    {amount:0,active:false,id:'00123',성명:'첫 이름'},
    {amount:120000000,active:true,id:'00007',성명:'둘 이름'},
    {amount:3,active:false,id:'09'},
  ]));
  assert.deepEqual(places.placeholders,[{key:'amount',count:1},{key:'active',count:1},{key:'id',count:1}]);
  assert.deepEqual(places.fields,[{name:'성명',count:1,usable:true,fillable:1,merging:0,unfillable:[]}]);
  const matches=matchPlaces(places,data.records);
  assert.deepEqual(matches.find(m=>m.key==='성명')?.counts,{ok:2,missing:1,notScalar:0,rejected:0});
  assert.equal(matches.find(m=>m.key==='성명')?.state,'missing');
  assert(matches.filter(m=>m.kind==='placeholder').every(m=>m.state==='ok'&&m.counts.ok===3));
  const results=generateAll(source,places,data,'합성.hwpx','error');
  assert.deepEqual(results.map(r=>r.view.ok),[true,true,false]);
  assert.deepEqual(results.map(r=>r.view.name),['합성-001.hwpx','합성-002.hwpx','합성-003.hwpx']);
  for(let i=0;i<2;i++) {
    const record=data.records[i];assert(record&&'dataset' in record);
    const expected=generate(source,emptyTemplate(),record.dataset,{mode:'baseline',missing:'error'});
    assert(expected.ok&&!expected.dryRun);assert.deepEqual(results[i]?.output,expected.output);
    assert.equal(results[i]?.view.filled,4);assert.equal(results[i]?.view.skipped.length,0);
    assert.equal(validateDocument(results[i]!.output!).errors.length,0);
  }
  assert.equal(lines(results[0]!.output!)[1],'금액 0 활성 false 번호 00123');
  assert.equal(lines(results[1]!.output!)[1],'금액 120000000 활성 true 번호 00007');
  assert.equal(listFields(docOf(results[0]!.output!))[0]?.valueText,'첫 이름');
  assert(results[2]?.view.errors.some(e=>e.code==='DATA_MISSING'));assert.equal(results[2]?.output,undefined);
  assert.deepEqual(Buffer.from(source),before);
});

test('Lite 빠른 생성: 공용 뷰어 클릭 초안이 선택한 낱말만 채우고 바깥 문단·원본은 유지',()=>{
  const source=synth([P(R(T('앞 유지값 뒤'))),P(R(T('바깥 문단은 유지')))]),before=Buffer.from(source),doc=docOf(source);
  const picked=locatePicked(doc,{position:{sectionIndex:0,paragraphIndex:1,charOffset:3},shown:{text:'앞 유지값 뒤',start:0}});
  assert.equal(picked.precision,'char');assert.deepEqual(picked.address,{sectionIndex:0,path:[1],offset:3});
  const draft=draftsFor(doc,picked).find(d=>d.anchor.kind==='word');
  assert(draft&&draft.anchor.kind==='word');assert.equal(draft.blocked,undefined);assert.equal(draft.anchor.print.text,'유지값');
  const template=emptyTemplate();template.anchors.push({...draft.anchor,id:'picked-word'});
  template.rules.push({id:'picked-fill',do:{type:'fill',anchor:'picked-word',value:{path:'replacement'}}});
  const data=parseQuickData(enc({replacement:'교체값'}));
  const result=generateAll(source,analyzePlaces(source),data,'클릭.hwpx','error',readTemplate(template))[0];
  assert(result?.view.ok&&result.output);assert.equal(result.view.filled,1);
  assert.deepEqual(lines(result.output),[lines(source)[0],'앞 교체값 뒤','바깥 문단은 유지']);
  const unchangedXml=(bytes:Uint8Array,index:number)=>{const s=docOf(bytes).sections[0],p=s.paragraphs[index]!;return s.text.slice(p.element.start,p.element.end).replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g,'');};
  assert.equal(unchangedXml(result.output,0),unchangedXml(source,0));assert.equal(unchangedXml(result.output,2),unchangedXml(source,2));
  const expected=generate(source,readTemplate(template),(data.records[0] as {dataset:Dataset}).dataset,{mode:'baseline',missing:'error'});
  assert(expected.ok&&!expected.dryRun);assert.deepEqual(result.output,expected.output);
  assert.deepEqual(Buffer.from(source),before,'클릭 지정은 원본 내용 수정이 아니다');
});

test('Lite 빠른 생성: 혼합 서식 자리는 건너뛰고 결과에 남으므로 실패 처리면 실패(#126), 원래 글 유지면 정상 자리만 채우고 알림',()=>{
  const source=synth([P(R(T('{{broken.'))+R(T('value}}'),'1')),P(R(T('정상 {{ok}}')))]);
  const data=parseQuickData(enc({broken:{value:'주입 금지'},ok:'새 값'}));
  const blocked=generateAll(source,analyzePlaces(source),data,'혼합.hwpx','error')[0];
  assert(blocked&&!blocked.view.ok);assert.equal(blocked.output,undefined);
  assert.deepEqual(blocked.view.leftover,{count:1,keys:[{key:'broken.value',count:1}]});
  assert.deepEqual(blocked.view.errors.map(e=>[e.code,e.detail]),[['QUICK_LEFTOVER','남은 자리 1곳: {{broken.value}} 1곳']]);
  assert(blocked.view.skipped.some(s=>s.code==='FILL_MIXED_FORMAT'),'왜 남았는지(건너뜀)는 실패에도 남긴다');
  const result=generateAll(source,analyzePlaces(source),data,'혼합.hwpx','keep')[0];
  assert(result?.view.ok&&result.output);assert.equal(result.view.filled,1);
  assert(result.view.skipped.some(s=>s.code==='FILL_MIXED_FORMAT'));
  assert.deepEqual(result.view.notes.filter(n=>n.code==='QUICK_LEFTOVER_KEPT').map(n=>n.detail),['남은 자리 1곳: {{broken.value}} 1곳']);
  assert.equal(lines(result.output)[1],'{{broken.value}}');assert.equal(lines(result.output)[2],'정상 새 값');
  assert(!lines(result.output).join('\n').includes('주입 금지'));
});

test('Lite 빠른 생성: 끝 표식 없는 누름틀은 건너뛰고 사유·내용 유지',()=>{
  const source=synth([P(R(FIELD_BEGIN('21','막힌자리','1','안내')+T('원래 값'))),P(R(T('정상 {{ok}}')))]);
  const places=analyzePlaces(source),data=parseQuickData(enc({막힌자리:'주입 금지',ok:'새 값'}));
  assert.deepEqual(places.fields,[{name:'막힌자리',count:1,usable:true,fillable:0,merging:0,unfillable:[{shape:'unpaired',count:1}]}]);
  assert.equal(matchPlaces(places,data.records).find(m=>m.key==='막힌자리')?.state,'unfillable');
  const result=generateAll(source,places,data,'미지원.hwpx','error')[0];
  assert(result?.view.ok&&result.output);assert.equal(result.view.filled,1);
  assert(result.view.skipped.some(s=>s.code==='FIELD_UNSUPPORTED_SHAPE'));
  assert.deepEqual(listFields(docOf(result.output)),listFields(docOf(source)));assert.equal(lines(result.output)[1],lines(source)[1]);assert(!lines(result.output).join('\n').includes('주입 금지'));
});
