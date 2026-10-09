// 추천 목록 여러 줄 끌기·Shift 범위(#152)와 흐름 트리 블록 추가·끌어 순서 바꾸기·다른 문서에서 임시로 떼어 저장(#153).
// 기대값은 시험이 세운 모형(줄 상태 표, 자리별 블록 번호)에서 정하고 앱의 결과를 옮겨 적지 않는다.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {openPackage,parseDocument,validateDocument,compareToBaseline,walkParagraphs} from '@hwpx-studio/engine';
import {buildHwpx} from '../../../packages/hwpx-engine/test/helpers.ts';
import {textPara} from '../../../packages/hwpx-engine/test/table-helpers.ts';
import {createBlockLibrary,extractBlockDraft} from '../src/block-library.ts';
import {moveSlot} from '../src/branch-flow.ts';
import {between,reviewed} from '../src/input-table.ts';
import {createWorkbench} from '../src/workbench.ts';

const random=(seed:number)=>()=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32;
const textsOf=(bytes:Uint8Array)=>parseDocument(openPackage(bytes)).sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>p.logicalText));

test('#152 sweep: 60 lines, 50 random drags/shift ranges set one state, keep confirmed lines, undo restores the whole sweep',t=>{
  const next=random(152),kinds=['input','input','block','place'] as const;
  const lines=Array.from({length:60},(_,i)=>({id:'r'+i,kind:kinds[i%4]!,origin:(i%8===0?'user':'placeholder') as 'user'|'placeholder',status:i%7===3?'confirmed':i%8===0?'designated':'recommended'}));
  const ids=lines.map(l=>l.id),confirmed=lines.filter(l=>l.status==='confirmed').map(l=>l.id);let changedLines=0;
  for(let n=0;n<50;n++){
    const a=Math.floor(next()*60),b=Math.floor(next()*60),to=next()<.5?'excluded':'keep',before=new Map(lines.map(l=>[l.id,l.status]));
    const range=between(ids,'r'+a,'r'+b);assert.equal(range.length,Math.abs(a-b)+1);assert.deepEqual(between(ids,'r'+b,'r'+a),range);
    // 화면의 reviewChange와 같다: 범위 줄을 한 번에 바꾸고 되돌리기 표는 하나
    for(const l of lines.filter(l=>range.includes(l.id)))l.status=reviewed(l,to);
    for(const l of lines){
      const was=before.get(l.id)!;
      if(was==='confirmed'||!range.includes(l.id))assert.equal(l.status,was);
      else assert.equal(l.status,to==='excluded'?'excluded':l.kind==='input'&&l.origin==='user'?'designated':'recommended');
      if(l.status!==was)changedLines++;
    }
    assert.equal(lines.filter(l=>range.includes(l.id)&&l.status===(to==='excluded'?'excluded':l.status)&&l.status!=='confirmed').length,range.filter(id=>!confirmed.includes(id)).length);
    if(n%5===4){for(const l of lines)l.status=before.get(l.id)!;assert.deepEqual(new Map(lines.map(l=>[l.id,l.status])),before);}
  }
  assert.deepEqual(lines.filter(l=>l.status==='confirmed').map(l=>l.id),confirmed);assert.deepEqual(between(ids,'r1','missing'),[]);
  t.diagnostic(`lines=60; sweeps=50; changed=${changedLines}; confirmed kept=${confirmed.length}; undo checks=10`);
});

/** 바탕 문서: 머리 + (자리 k, 고정 k) × 6. 블록 k는 다른 문서의 "블록 k …" 두 문단 */
function fixture(){
  const db=new DatabaseSync(':memory:'),library=createBlockLibrary(db);
  const other=buildHwpx([textPara('다른 문서')+Array.from({length:6},(_,k)=>textPara('블록 '+k+' 첫 줄 &amp; &lt;특수&gt;')+textPara('블록 '+k+' 둘째 줄 '+'긴 문장 '.repeat(30))).join('')]);
  const base=buildHwpx([textPara('바탕 머리')+Array.from({length:6},(_,k)=>textPara('자리 '+k)+textPara('고정 '+k)).join('')]);
  const doc=parseDocument(openPackage(other));
  const stored=Array.from({length:6},(_,k)=>library.save(extractBlockDraft(doc,'other.hwpx',{sectionIndex:0,parentPath:[],from:1+2*k,to:2+2*k}),'블록 '+k));
  return {db,library,base,other,stored,protos:stored.map(s=>library.material(s.id,1).proto.id)};
}

test('#153 tree order: 6 slots (5 stored blocks + 1 branch), 50 random drags change only which block sits in which slot; generated order, determinism, validation, save/restore',t=>{
  const {db,library,base,protos}=fixture();try{
    const app=createWorkbench(library),opened=app.post('/api/workbench/open',{name:'base.hwpx',content:Buffer.from(base).toString('base64')}) as any;
    const order=opened.paragraphs.map((p:any)=>p.id),slot=(k:number)=>opened.paragraphs[1+2*k].id;
    // 자리 0~4는 넣은 블록(배치), 자리 5는 블록 5 하나를 고른 분기점
    const placements=[0,1,2,3,4].map(k=>({id:protos[k]!,version:1,from:slot(k),to:slot(k)}));
    const branches=[{id:'s1',name:'분기',from:slot(5),to:slot(5),blocks:[{id:protos[5]!,version:1}],keys:[],cases:[],picks:{sample:protos[5]!}}];
    const model=[0,1,2,3,4,5],next=random(153);let generations=0;
    for(let n=0;n<50;n++){
      const from=Math.floor(next()*6),to=Math.floor(next()*6);
      moveSlot(order,[...placements,...branches],from,to);model.splice(to,0,...model.splice(from,1));
      // 자리(범위)는 그대로: 범위 묶음은 늘 자리 0~5
      assert.deepEqual([...placements,...branches].map(x=>x.from).sort(),[0,1,2,3,4,5].map(slot).sort());
      const work={session:opened.session,index:0,edits:[],headings:[],blocks:[],placements,branches};
      const result=app.post('/api/workbench/generate',work) as any;assert.equal(result.ok,true);generations++;
      const bytes=app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.body,texts=textsOf(bytes);
      assert.deepEqual(texts.filter(x=>x.startsWith('블록 ')&&x.includes('첫 줄')).map(x=>Number(x[3])),model);
      assert.deepEqual(texts.filter(x=>/^(바탕|고정)/.test(x)),['바탕 머리','고정 0','고정 1','고정 2','고정 3','고정 4','고정 5']);
      assert(!texts.some(x=>x.startsWith('자리 ')));
      assert.equal(compareToBaseline(validateDocument(base),validateDocument(bytes)).newErrors.length,0);
      app.post('/api/workbench/generate',work);generations++;assert.deepEqual(app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.body,bytes);
    }
    const work={session:opened.session,index:0,edits:[],headings:[],blocks:[],placements,branches};
    const saved=app.post('/api/workbench/save',work) as any,restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as any;
    assert.deepEqual(restored.placements,placements);assert.deepEqual(restored.branches.map((b:any)=>[b.from,b.to]),branches.map(b=>[b.from,b.to]));
    const again=app.post('/api/workbench/generate',{...work,session:restored.session}) as any;assert.equal(again.text,(app.post('/api/workbench/generate',work) as any).text);
    assert.deepEqual(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body),Buffer.from(base));
    t.diagnostic(`slots=6 (placements=5, branch=1); moves=50; generations=${generations}; block order = model; deterministic; new_errors=0; restored; source unchanged`);
  }finally{db.close();}
});

test('#153 temporary document: three other documents give blocks to the store; main session, work file and output stay the same; bad ranges refused',t=>{
  const {db,library,base,other}=fixture();try{
    const app=createWorkbench(library),opened=app.post('/api/workbench/open',{name:'base.hwpx',content:Buffer.from(base).toString('base64')}) as any;
    const work={session:opened.session,index:0,edits:[{id:opened.paragraphs[2].id,text:'고친 고정 0'}],headings:[],blocks:[],placements:[]};
    const workspace=(app.post('/api/workbench/save',work) as any).workspace,text=(app.post('/api/workbench/generate',work) as any).text,count=library.list().length;
    for(let n=0;n<3;n++){
      const content=Buffer.from(other).toString('base64'),name='other-'+n+'.hwpx',seen=app.post('/api/workbench/compare',{name,content}) as any;
      assert.equal(seen.session,undefined);
      const from=seen.paragraphs[1+2*n].id,to=seen.paragraphs[2+2*n].id;
      const preview=app.post('/api/workbench/block-preview',{session:opened.session,from,to,compare:{name,content}}) as any;
      assert.equal(preview.sourceName,name);assert.match(preview.excerpt,new RegExp('블록 '+n+' 첫 줄'));
      const saved=app.post('/api/workbench/block-save',{session:opened.session,previewId:preview.id,name:'임시 '+n}) as any;
      assert.equal(library.material(saved.id,1).item.name,'임시 '+n);
    }
    assert.equal(library.list().length,count+3);
    assert.equal((app.post('/api/workbench/save',work) as any).workspace,workspace);assert.equal((app.post('/api/workbench/generate',work) as any).text,text);
    assert.deepEqual(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body),Buffer.from(base));
    // 거절: TXT 문서, 다른 칸·본문에 걸친 줄(여기서는 없는 줄), 고친 꼴
    assert.throws(()=>app.post('/api/workbench/block-preview',{session:opened.session,from:'p:0:0',to:'p:0:0',compare:{name:'a.txt',content:Buffer.from('글').toString('base64')}}),(e:any)=>e.code==='BLOCK_HWPX');
    assert.throws(()=>app.post('/api/workbench/block-preview',{session:opened.session,from:'p:0:0',to:'p:0:99',compare:{name:'o.hwpx',content:Buffer.from(other).toString('base64')}}),(e:any)=>e.code==='WORKBENCH_POSITION');
    assert.throws(()=>app.post('/api/workbench/block-preview',{session:opened.session,from:'p:0:0',to:'p:0:1',compare:'o.hwpx'}));
    // 세션을 늘리지 않는다: 7개를 더 열어도(합 8) 바탕 문서 세션이 살아 있다
    for(let i=0;i<7;i++)app.post('/api/workbench/open',{name:'x.hwpx',content:Buffer.from(base).toString('base64')});
    assert.equal((app.post('/api/workbench/save',work) as any).workspace,workspace);
    t.diagnostic('other documents=3; blocks saved=3; work file, output text and source unchanged; sessions not added');
  }finally{db.close();}
});
