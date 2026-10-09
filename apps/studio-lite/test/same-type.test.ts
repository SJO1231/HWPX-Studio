// 이것과 같은 것 전부(#151): 같은 유형 제안 창구(엔진 patternOf·suggestSimilar), ✓ 확정의 제목 트리·블록 후보(화면과 같은 코드), 저장·복원.
// 그리고 구조 단계 오류 보고(#203). 기대값은 시험이 적어 넣은 줄 모형(줄마다 번호 모양·글자모양)에서 세우고 엔진·앱의 결과를 옮겨 적지 않는다.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {openPackage,parseDocument} from '@hwpx-studio/engine';
import {buildHwpx,MINIMAL_HEADER} from '../../../packages/hwpx-engine/test/helpers.ts';
import {textPara} from '../../../packages/hwpx-engine/test/table-helpers.ts';
import {plainOf} from '../../studio/src/messages.ts';
import {createBlockLibrary,extractBlockDraft} from '../src/block-library.ts';
import {applySimilar,headingBlocks,relevel} from '../src/branch-flow.ts';
import {createWorkbench} from '../src/workbench.ts';

/** 글자모양: 0 보통(1000), 1 큰 글자(1200, 굵지 않음), 2 굵게(1000) */
const HEADER=MINIMAL_HEADER.replace('<hh:charProperties itemCnt="2">','<hh:charProperties itemCnt="3">')
  .replace('</hh:charProperties>','<hh:charPr id="2" height="1000" borderFillIDRef="1"><hh:fontRef hangul="0"/><hh:bold/></hh:charPr></hh:charProperties>');
/** 번호 모양 6종과 번호 없음. 단계는 목록에 나온 꼴 서열(1. > 가. > (1) > ① > □ > ○, 기호는 먼저 나온 것이 높다) */
type Shape='1.'|'가.'|'(1)'|'①'|'□'|'○'|'none';
type Line={text:string;shape:Shape;char:'0'|'1'|'2'};
const LEVEL:Record<Shape,number>={'1.':1,'가.':2,'(1)':3,'①':4,'□':5,'○':6,none:0};
const HANGUL='가나다라마바사아자차카타';
/** 장 12개. 5장은 굵게, 9장은 큰 글자, 셋째 "다."는 굵게(같은 번호 모양·다른 서식). "입찰 개요"는 번호 없는 큰 글자라 엔진 탐지 밖(제목 아님). 번호처럼 보이는 본문 섞음 */
function model():Line[]{
  const out:Line[]=[];
  for(let k=1;k<=12;k++){
    out.push({text:`${k}. 장 제목 ${k}`,shape:'1.',char:k===5?'2':k===9?'1':'0'});
    out.push({text:`본문 ${k} 문장입니다. ${'세부 사항을 안내합니다. '.repeat(k%3+1)}`,shape:'none',char:'0'});
    out.push({text:`${HANGUL[k-1]}. 소제목 ${k}`,shape:'가.',char:k===3?'2':'0'});
    out.push({text:`(${k}) 세목 ${k}`,shape:'(1)',char:'0'});
    out.push({text:`${String.fromCodePoint(0x2460+k-1)} 동그라미 숫자 ${k}`,shape:'①',char:'0'});
    out.push({text:`□ 네모 항목 ${k}`,shape:'□',char:'0'});
    out.push({text:`○ 동그라미 항목 ${k}`,shape:'○',char:'0'});
    out.push({text:`입찰 개요 ${k}`,shape:'none',char:'1'});
    if(k%4===0)out.push({text:'1.5배 늘어난 수량입니다.',shape:'none',char:'0'},{text:'10. 4.(금) 마감',shape:'none',char:'0'});
  }
  return out;
}
const source=(lines:Line[])=>buildHwpx([lines.map(l=>textPara(l.text).replace('charPrIDRef="0"',`charPrIDRef="${l.char}"`)).join('')],HEADER);
type Opened={session:string;paragraphs:{id:string;sectionIndex:number;path:number[];text:string}[];outline:{id:string;name:string;level:number}[]};
const wrong=(run:()=>unknown,code:string)=>assert.throws(run,(e:any)=>e.code===code);

test('같은 유형 제안: 번호 모양 6종 × 12개와 서식이 다른 같은 모양·번호 없는 큰 글자·본문 — 고른 문단과 꼴·단계·굵기·크기가 같은 문단만(고른 문단 포함, 문서 순서), 원문 불변',t=>{
  const lines=model(),bytes=source(lines),app=createWorkbench(),opened=app.post('/api/workbench/open',{name:'synthetic.hwpx',content:Buffer.from(bytes).toString('base64')}) as Opened;
  const ids=opened.paragraphs.map(p=>p.id),similar=(row:string)=>(app.post('/api/workbench/similar',{session:opened.session,row}) as {rows:string[]}).rows;
  // 전제: 문단 = 모형 줄, 탐지한 제목 = 번호 모양 줄(단계는 모형)
  assert.deepEqual(opened.paragraphs.map(p=>p.text),lines.map(l=>l.text));
  assert.deepEqual(opened.outline.map(h=>[h.id,h.level]),lines.flatMap((l,i)=>l.shape==='none'?[]:[[ids[i],LEVEL[l.shape]]]));
  const look=(l:Line)=>l.shape+'|'+l.char;let groups=0,found=0,right=0,wrongs=0;
  for(const key of new Set(lines.map(look))){
    const expected=lines.flatMap((l,i)=>look(l)===key?[ids[i]!]:[]);
    // 묶음의 첫 줄·가운데 줄 어느 것을 골라도 같다
    for(const pick of new Set([expected[0]!,expected[Math.floor(expected.length/2)]!])){
      const rows=similar(pick);found+=rows.length;right+=rows.filter(r=>expected.includes(r)).length;wrongs+=rows.filter(r=>!expected.includes(r)).length;
      assert.deepEqual(rows,expected,key);
    }
    groups++;
  }
  // 6종 보통 서식 12개씩, 서식이 다른 1. 둘·가. 하나, 번호 없는 큰 글자 12개, 본문 18개
  assert.equal(groups,11);assert.equal(wrongs,0);assert.equal(right,found);
  t.diagnostic(`묶음 ${groups}개 · 찾은 ${found} · 맞은 ${right} · 잘못 ${wrongs}`);
  assert.deepEqual(similar(ids[lines.findIndex(l=>l.text==='1. 장 제목 1')]!).length,10);
  assert.deepEqual(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body,bytes);
  wrong(()=>similar('p:0:9999'),'WORKBENCH_POSITION');
  const txt=app.post('/api/workbench/open',{name:'t.txt',content:Buffer.from('1. 제목').toString('base64')}) as Opened;
  wrong(()=>app.post('/api/workbench/similar',{session:txt.session,row:txt.paragraphs[0]!.id}),'WORKBENCH_SOURCE');
});

test('같은 유형 ✓: 체크한 것만 제목 트리에(새 제목은 고른 문단의 단계, 트리에 없으면 1), 뺀 것은 트리에서 빠지고 블록 후보는 고친 트리의 범위. 작업 저장·복원',()=>{
  const lines=model(),app=createWorkbench(),opened=app.post('/api/workbench/open',{name:'synthetic.hwpx',content:Buffer.from(source(lines)).toString('base64')}) as Opened;
  const ids=opened.paragraphs.map(p=>p.id),at=(text:string)=>ids[lines.findIndex(l=>l.text===text)]!,name=(id:string)=>opened.paragraphs.find(p=>p.id===id)!.text.slice(0,40);
  const similar=(row:string)=>(app.post('/api/workbench/similar',{session:opened.session,row}) as {rows:string[]}).rows;
  // ① 탐지 밖 "입찰 개요"(큰 글자) 12개에서 4·8번째를 빼고 ✓ → 10개가 1단계 제목
  const pick=at('입찰 개요 1'),rows=similar(pick);assert.equal(rows.length,12);
  const level=opened.outline.find(h=>h.id===pick)?.level??1,dropped=new Set([rows[3]!,rows[7]!]);
  let outline=applySimilar(ids,opened.outline,rows.map(id=>({id,name:name(id),level,keep:!dropped.has(id)})));
  // ② 탐지한 보통 서식 "1." 10개에서 2장을 빼고 ✓ → 2장은 트리에서 빠진다(이미 제목인 것은 단계 그대로)
  const two=at('2. 장 제목 2'),chapters=similar(at('1. 장 제목 1'));assert.equal(chapters.length,10);
  outline=applySimilar(ids,outline,chapters.map(id=>({id,name:name(id),level:9,keep:id!==two})));
  // 모형: 제목 = 번호 모양 줄(2장 빼고, 단계는 모형) + 남긴 "입찰 개요"(1단계)
  const levels=lines.map((l,i)=>ids[i]===two?0:l.shape!=='none'?LEVEL[l.shape]:l.char==='1'&&!dropped.has(ids[i]!)?1:0);
  assert.deepEqual(outline.map(h=>[h.id,h.level]),levels.flatMap((v,i)=>v?[[ids[i],v]]:[]));
  assert.equal(outline.length,opened.outline.length-1+10);
  // 블록 후보: 제목부터 다음에 나오는 단계가 같거나 높은 제목의 앞까지(모형)
  const blocks=headingBlocks(opened.paragraphs,outline);
  assert.deepEqual(blocks.map(b=>[b.from,b.to,b.paragraphCount]),levels.flatMap((v,i)=>{if(!v)return [];let j=i+1;while(j<levels.length&&!(levels[j]!&&levels[j]!<=v))j++;return [[ids[i],ids[j-1],j-i]];}));
  assert(!blocks.some(b=>b.from===two||dropped.has(b.from)));
  // 1장 범위는 "입찰 개요 1" 앞까지, "입찰 개요 1"은 (2장이 빠져) "입찰 개요 2" 앞까지
  assert.equal(blocks.find(b=>b.from===at('입찰 개요 1'))!.to,ids[lines.findIndex(l=>l.text==='입찰 개요 2')-1]);
  // 저장·복원: 트리는 id·단계로 남고 다시 열면 그대로. 저장한 트리가 없는 작업 파일은 탐지대로
  const work={session:opened.session,index:0,edits:[],headings:[],blocks:[],outline:outline.map(({id,level})=>({id,level}))};
  const saved=app.post('/api/workbench/save',work) as {workspace:string},restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as Opened;
  assert.deepEqual(JSON.parse(saved.workspace).outline,work.outline);assert.deepEqual(restored.outline,work.outline);
  const plain=app.post('/api/workbench/save',{...work,outline:undefined}) as {workspace:string};
  assert.deepEqual((app.post('/api/workbench/restore',{workspace:plain.workspace}) as Opened).outline,opened.outline);
  // 생성은 트리와 관계없다
  assert.equal((app.post('/api/workbench/generate',{...work,missing:'keep'}) as {ok:boolean}).ok,true);
  wrong(()=>app.post('/api/workbench/save',{...work,outline:[...work.outline,work.outline[0]]}),'WORKBENCH_DUPLICATE');
  wrong(()=>app.post('/api/workbench/save',{...work,outline:[{id:'p:0:9999',level:1}]}),'WORKBENCH_POSITION');
  for(const bad of [{id:ids[0],level:0},{id:ids[0],level:1.5},{id:ids[0],level:1,name:'x'},'x'])wrong(()=>app.post('/api/workbench/save',{...work,outline:[bad]}),'WORKBENCH_INPUT');
});

test('#205 제목 단계 올림·내림: 무작위 50번, 블록 후보 = 고친 단계의 범위(모형), 1·99에서 멈춤, 다른 제목·원래 트리 그대로',t=>{
  const lines=model(),app=createWorkbench(),opened=app.post('/api/workbench/open',{name:'synthetic.hwpx',content:Buffer.from(source(lines)).toString('base64')}) as Opened;
  const ids=opened.paragraphs.map(p=>p.id),before=structuredClone(opened.outline),levels=new Map(opened.outline.map(h=>[h.id,h.level]));
  let outline=opened.outline,seed=205,changed=0;const next=()=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32;
  for(let n=0;n<50;n++){
    const h=outline[Math.floor(next()*outline.length)]!,by=next()<.5?-1:1,old=levels.get(h.id)!;
    outline=relevel(outline,h.id,by);levels.set(h.id,Math.min(99,Math.max(1,old+by)));if(levels.get(h.id)!==old)changed++;
    assert.deepEqual(outline.map(x=>[x.id,x.level]),opened.outline.map(x=>[x.id,levels.get(x.id)]));
    // 모형: 제목부터 다음에 나오는 단계가 같거나 높은 제목의 앞까지
    const lv=ids.map(id=>levels.get(id)??0);
    assert.deepEqual(headingBlocks(opened.paragraphs,outline).map(b=>[b.from,b.to,b.paragraphCount]),lv.flatMap((v,i)=>{if(!v)return [];let j=i+1;while(j<lv.length&&!(lv[j]!&&lv[j]!<=v))j++;return [[ids[i],ids[j-1],j-i]];}));
  }
  // 1장 제목을 한 단계 내리면 그 범위가 다음 "가." 소제목 앞까지 줄고, 다시 올리면 원래대로
  const one=opened.outline[0]!,base=headingBlocks(opened.paragraphs,opened.outline)[0]!,down=headingBlocks(opened.paragraphs,relevel(opened.outline,one.id,1))[0]!;
  assert(down.paragraphCount<base.paragraphCount);assert.deepEqual(headingBlocks(opened.paragraphs,relevel(relevel(opened.outline,one.id,1),one.id,-1))[0],base);
  assert.equal(relevel([{id:'a',name:'a',level:1}],'a',-1)[0]!.level,1);assert.equal(relevel([{id:'a',name:'a',level:99}],'a',1)[0]!.level,99);
  assert.deepEqual(opened.outline,before);
  t.diagnostic(`headings=${outline.length}; moves=50; level changes=${changed}; blocks = model`);
});

test('#203 구조 단계 오류(구역 설정 문단을 덮는 블록 넣기)는 데이터 키가 다 있어도 "연결 안 된 자리"가 아니라 그 까닭(FILL_SECTION_PROPS 쉬운 말)으로 알린다',()=>{
  const db=new DatabaseSync(':memory:');try{
    const bytes=readFileSync(new URL('../../../examples/quick/template-braces.hwpx',import.meta.url)),doc=parseDocument(openPackage(bytes));
    assert(doc.sections[0]!.paragraphs[0]!.objects.length>0,'전제: 첫 문단에 구역 설정');
    const index=doc.sections[0]!.paragraphs.findIndex(p=>p.logicalText.includes('위와 같이'));assert(index>0);
    const library=createBlockLibrary(db),stored=library.save(extractBlockDraft(doc,'example.hwpx',{sectionIndex:0,parentPath:[],from:index,to:index}),'예시 블록'),app=createWorkbench(library);
    const opened=app.post('/api/workbench/open',{name:'example.hwpx',content:Buffer.from(bytes).toString('base64')}) as Opened;
    app.post('/api/workbench/data',{session:opened.session,name:'data.json',content:readFileSync(new URL('../../../examples/quick/data-single.json',import.meta.url),'utf8')});
    const work={session:opened.session,index:0,edits:[],headings:[],blocks:[],placements:[{id:stored.id,version:1,from:opened.paragraphs[0]!.id,to:opened.paragraphs[0]!.id}]};
    for(const path of ['generate','block-placement-preview'])assert.throws(()=>app.post('/api/workbench/'+path,work),(e:any)=>e.code==='FILL_SECTION_PROPS'&&e.message===plainOf('FILL_SECTION_PROPS'));
    // 같은 블록을 다른 문단에 넣으면 그대로 생성된다(데이터 키는 다 있다)
    assert.equal((app.post('/api/workbench/generate',{...work,placements:[{...work.placements[0]!,from:opened.paragraphs[index]!.id,to:opened.paragraphs[index]!.id}]}) as {ok:boolean}).ok,true);
  }finally{db.close();}
});
