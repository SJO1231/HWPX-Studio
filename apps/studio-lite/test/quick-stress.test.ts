import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareToBaseline, emptyTemplate, openPackage, parseDocument, readTemplate, validateDocument, walkParagraphs } from '@hwpx-studio/engine';
import { draftsFor } from '../../../packages/viewer/src/host/index.ts';
import { locatePicked } from '../../../packages/viewer/src/map/index.ts';
import { mutateEntryText, readFixture } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { analyzePlaces, generateAll, parseQuickData } from '../src/quick.ts';

const BODY_KEYS=['long','repeat','repeat','long','zero','flag','identifier','repeat','long','repeat','long','repeat'];
const CELL_KEYS=['repeat','long','zero','flag','identifier','long','repeat','long','zero','flag','identifier','long'];
const OUTSIDE='바깥 고정 문단';
const CLICK_TEXT='선택: 원래낱말 / 고정꼬리';
function distributedSource() {
  const original=readFixture('hancom/header-footer'),doc=parseDocument(openPackage(original)),section=doc.sections[0];
  const firstEnd=section.paragraphs[0]!.element.end;
  const body=BODY_KEYS.map((key,i)=>textPara(`본문${i}: {{${key}}}`));
  const cells=Array.from({length:3},(_,row)=>Array.from({length:4},(_,col)=>`표${row*4+col}: {{${CELL_KEYS[row*4+col]}}}`));
  const table=tableParagraph(gridTable([9000,9000,9000,9000],3,cells,{id:'3900'}));
  return mutateEntryText(original,section.entryName,xml=>
    xml.slice(0,firstEnd).replace('{{doc.title}}',Array.from({length:6},(_,i)=>`머리말${i}: {{repeat}}`).join(' / ')).replace('{{doc.owner}}','고정 꼬리말')+
    body.join('')+table+textPara(CLICK_TEXT)+textPara(OUTSIDE)+xml.slice(xml.lastIndexOf('</hs:sec>')),
  );
}
function seededRecords() {
  let seed=0x5a17c0de;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const sentence=['여러 문장을 이어 데이터 주입 후 내용의 순서와 공백을 확인합니다.','본문과 표 칸 및 머리말의 동일한 키가 모두 같은 값으로 바뀌어야 합니다.','긴 문장이 있어도 문서의 고정 문구와 문자 서식 자원을 보존합니다.'];
  const long=(tag:string)=>`${tag}: `+Array.from({length:12},()=>sentence[next()%sentence.length]).join(' ')+`\n둘째 문장 & <확인> "인용" > 한글😀.\n셋째 문장\t탭 뒤 값 ${next()}.`;
  return Array.from({length:50},(_,i)=>({
    long:long(`LONG_${i}_${next()}`),repeat:long(`REPEAT_${i}_${next()}`),selected:long(`SELECT_${i}_${next()}`),
    zero:0,flag:i%2===0?false:true,identifier:'00'+String(next()%1000000).padStart(6,'0'),
  }));
}
const paragraphsOf=(bytes:Uint8Array)=>{const doc=parseDocument(openPackage(bytes));return doc.sections.flatMap(section=>[...walkParagraphs(section.paragraphs)].map(p=>({section,p})));};
const outsideXml=(bytes:Uint8Array)=>{const found=paragraphsOf(bytes).find(({p})=>p.logicalText===OUTSIDE);assert(found);return found.section.text.slice(found.p.element.start,found.p.element.end);};

test('Lite 빠른 생성 스트레스: 본문·표·머리말 30곳과 클릭 1곳, seeded 50건 × 2회 결정성·게이트·새 오류 0',t=>{
  const source=distributedSource(),sourceBefore=Buffer.from(source),baseline=validateDocument(source);
  assert.equal(baseline.errors.length,0,JSON.stringify(baseline.errors));
  const places=analyzePlaces(source);
  assert.deepEqual(Object.fromEntries(places.placeholders.map(p=>[p.key,p.count])),{repeat:13,long:8,zero:3,flag:3,identifier:3});
  assert.equal(places.placeholders.reduce((count,p)=>count+p.count,0),30);
  const doc=parseDocument(openPackage(source));
  const picked=locatePicked(doc,{position:{sectionIndex:0,paragraphIndex:14,charOffset:6},shown:{text:CLICK_TEXT,start:0}});
  assert.equal(picked.precision,'char');assert.deepEqual(picked.address,{sectionIndex:0,path:[14],offset:6});
  const draft=draftsFor(doc,picked).find(d=>d.anchor.kind==='word');
  assert(draft&&draft.anchor.kind==='word');assert.equal(draft.anchor.print.text,'원래낱말');assert.equal(draft.blocked,undefined);
  const template=emptyTemplate();template.anchors.push({...draft.anchor,id:'selected'});
  template.rules.push({id:'selected',do:{type:'fill',anchor:'selected',value:{path:'selected'}}});
  const records=seededRecords(),data=parseQuickData(new TextEncoder().encode(JSON.stringify(records)));
  assert(records.every(r=>r.long.length>=400&&r.repeat.length>=400&&r.selected.length>=400));
  const first=generateAll(source,places,data,'stress.hwpx','error',readTemplate(template));
  const second=generateAll(source,places,data,'stress.hwpx','error',readTemplate(template));
  assert.equal(first.length,50);assert.equal(second.length,50);
  let gates=0,filled=0,newErrors=0;
  const originalOutside=outsideXml(source);
  for(let i=0;i<records.length;i++) {
    const record=records[i]!,a=first[i]!,b=second[i]!;
    assert(a.view.ok&&a.output,`첫 생성 ${i}: ${JSON.stringify(a.view.errors)}`);
    assert(b.view.ok&&b.output,`둘째 생성 ${i}: ${JSON.stringify(b.view.errors)}`);
    assert.deepEqual(a.output,b.output,`시드 건 ${i} 출력 비결정적`);
    for(const result of [a,b]) {
      assert(result.output);assert.equal(result.view.filled,31);assert.equal(result.view.skipped.length,0);assert.equal(result.view.errors.length,0);
      const validation=validateDocument(result.output),regression=compareToBaseline(baseline,validation);
      assert.equal(validation.errors.length,0,JSON.stringify(validation.errors));assert.equal(regression.newErrors.length,0,JSON.stringify(regression.newErrors));
      newErrors+=regression.newErrors.length;gates++;filled+=result.view.filled;
      const content=paragraphsOf(result.output).map(({p})=>p.logicalText).join('\n');
      for(const [key,count] of [['repeat',13],['long',8],['selected',1]] as const) {
        const value=record[key],marker=value.slice(0,value.indexOf(':'));
        assert.equal(content.split(marker).length-1,count,`건 ${i} ${key} 중복 위치`);
        assert.equal(content.split(value).length-1,count,`건 ${i} ${key} 줄바꿈·탭·XML 특수문자 전체 값 손실`);
      }
      for(const label of ['본문4: ','표2: ','표8: '])assert(content.includes(label+'0'),`건 ${i} 숫자 0 손실`);
      for(const label of ['본문5: ','표3: ','표9: '])assert(content.includes(label+String(record.flag)),`건 ${i} 불리언 손실`);
      for(const label of ['본문6: ','표4: ','표10: '])assert(content.includes(label+record.identifier),`건 ${i} 앞자리 0 손실`);
      assert.equal(content.split('선택: ').length-1,1);assert(content.includes('선택: '+record.selected+' / 고정꼬리'));
      assert.equal(outsideXml(result.output),originalOutside,`건 ${i} 바깥 문단 변경`);
      assert(!content.includes('{{'));assert(!content.includes('원래낱말'));
    }
  }
  assert.equal(gates,100);assert.equal(filled,3100);assert.equal(newErrors,0);assert.deepEqual(Buffer.from(source),sourceBefore);
  t.diagnostic('seed=0x5a17c0de; records=50; targets=31; deterministic_pairs=50; gates_passed=100; filled=3100; new_errors=0; source_unchanged=true');
});
