import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareToBaseline, openPackage, parseDocument, readEntry, validateDocument, walkParagraphs } from '@hwpx-studio/engine';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { gridTable, tableParagraph, textPara } from '../../../packages/hwpx-engine/test/table-helpers.ts';
import { editorChange, editorLayout, editorSelection, groupEditorSelection, replaceEditorText, unitAt, type EditorRow, type EditorWork } from '../src/editor-model.ts';
import { createWorkbench } from '../src/workbench.ts';

const rowsOf=(...text:string[]):EditorRow[]=>text.map((text,i)=>({id:'p:0:'+i,text,sectionIndex:0,path:[i],editable:true,rangeEditable:true}));
const blank=():EditorWork=>({edits:[],blocks:[]});
const frozen=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const rowUnit=(rows:EditorRow[],work:EditorWork,id:string)=>{const u=editorLayout(rows,work).units.find(u=>u.id===id);assert(u,id);return u;};
const replaceRow=(rows:EditorRow[],work:EditorWork,id:string,text:string)=>{const u=rowUnit(rows,work,id);return replaceEditorText(rows,work,u.start,u.end,text,'b-new');};

test('continuous editor: Unicode and multiline changes stay on the original row, next row offsets move, and inputs remain unchanged',()=>{
  const rows=rowsOf('앞 e\u0301😀 끝','다음','마지막'),work=blank(),before=frozen({rows,work});
  const old=editorLayout(rows,work),after='앞 e\u0308😄\n붙여넣은 줄 끝\n다음\n마지막',diff=editorChange(old.text,after);
  const changed=replaceEditorText(rows,work,diff.start,diff.end,diff.value,'b-unused'),layout=editorLayout(rows,changed);
  assert.equal(layout.text,after);assert.deepEqual(changed.blocks,[]);
  assert.deepEqual(changed.edits,[{id:rows[0]!.id,text:'앞 e\u0308😄\n붙여넣은 줄 끝'}]);
  assert.equal(layout.units[1]!.id,rows[1]!.id);assert.equal(layout.units[1]!.start,after.indexOf('다음'));
  assert.deepEqual({rows,work},before);
  const reverted=replaceRow(rows,changed,rows[0]!.id,rows[0]!.text);assert.deepEqual(reverted,blank());
  const normalized=editorLayout(rows,{edits:[{id:rows[0]!.id,text:'가\r\n나\r다'}],blocks:[]});
  assert.equal(normalized.text,'가\n나\n다\n다음\n마지막');
});

test('continuous editor: selection and caret boundaries never map invalid offsets to the final row',()=>{
  const rows=rowsOf('first','','last'),work=blank(),layout=editorLayout(rows,work);
  assert.equal(unitAt(layout.units,5)?.id,rows[0]!.id);
  assert.equal(unitAt(layout.units,6)?.id,rows[1]!.id);
  assert.equal(unitAt(layout.units,7)?.id,rows[2]!.id);
  assert.deepEqual(editorSelection(layout,0,6).map(u=>u.id),[rows[0]!.id]);
  assert.deepEqual(editorSelection(layout,6,7).map(u=>u.id),[rows[1]!.id]);
  assert.deepEqual(editorSelection(layout,layout.text.length,layout.text.length).map(u=>u.id),[rows[2]!.id]);
  for(const offset of [-1,NaN,Infinity,0.5,layout.text.length+1]) {
    assert.equal(unitAt(layout.units,offset),undefined);
    assert.deepEqual(editorSelection(layout,offset,offset),[]);
    assert.throws(()=>replaceEditorText(rows,work,offset,offset,'x','b-invalid'),/범위/);
    assert.throws(()=>groupEditorSelection(rows,work,offset,offset,'b-invalid'),/선택/);
  }
  assert.deepEqual(editorSelection(layout,4,2),[]);
  assert.throws(()=>replaceEditorText(rows,work,4,2,'x','b-invalid'),/범위/);
});

test('continuous editor: deleting a row separator merges only its two source rows and preserves outside edits and blocks',()=>{
  const rows=rowsOf('first','second','third','fourth','last');
  const work:EditorWork={edits:[{id:rows[4]!.id,text:'outside'}],blocks:[{id:'b-outside',from:rows[2]!.id,to:rows[3]!.id,text:'kept\nblock',alias:'보존할 이름'}]};
  const before=frozen(work),layout=editorLayout(rows,work),changed=replaceEditorText(rows,work,layout.units[0]!.end,layout.units[1]!.start,'','b-merge');
  assert.equal(editorLayout(rows,changed).text,'firstsecond\nkept\nblock\noutside');
  assert.deepEqual(changed.blocks.find(b=>b.id==='b-merge'),{id:'b-merge',from:rows[0]!.id,to:rows[1]!.id,text:'firstsecond',alias:'블록'});
  assert.deepEqual(changed.blocks.find(b=>b.id==='b-outside'),work.blocks[0]);assert.deepEqual(changed.edits,work.edits);assert.deepEqual(work,before);
  const merged=rowUnit(rows,changed,rows[0]!.id);
  const next=replaceEditorText(rows,changed,merged.start+5,merged.end,' 새 문장\n둘째 줄','ignored-id');
  assert.equal(next.blocks.find(b=>b.from===rows[0]!.id)!.id,'b-merge');
  assert.equal(editorLayout(rows,next).text,'first 새 문장\n둘째 줄\nkept\nblock\noutside');
});

test('continuous editor: readonly, different sections/cells, noncontiguous addresses and mixed-format grouping remain blocked',()=>{
  const readonly=rowsOf('edit','locked','after');readonly[1]!.editable=false;
  assert.throws(()=>replaceRow(readonly,blank(),readonly[1]!.id,'changed'),/읽기 전용/);
  assert.throws(()=>replaceEditorText(readonly,blank(),4,5,'','blocked'),/읽기 전용/);
  assert.throws(()=>groupEditorSelection(readonly,blank(),0,editorLayout(readonly,blank()).text.length,'blocked'),/읽기 전용/);
  for(const rows of [
    [{...rowsOf('a')[0]!,path:[0,0,0]},{...rowsOf('b')[0]!,id:'p:0:0.1.0',path:[0,1,0]}],
    [{...rowsOf('a')[0]!},{...rowsOf('b')[0]!,id:'p:1:0',sectionIndex:1}],
    [{...rowsOf('a')[0]!},{...rowsOf('b')[0]!,id:'p:0:2',path:[2]}],
  ]) {
    assert.throws(()=>replaceEditorText(rows,blank(),1,2,'','blocked'),/같은 본문이나 표 칸/);
    assert.throws(()=>groupEditorSelection(rows,blank(),0,3,'blocked'),/같은 본문이나 표 칸/);
  }
  const mixed=rowsOf('mixed','next');mixed[0]!.rangeEditable=false;
  assert.equal(replaceRow(mixed,blank(),mixed[0]!.id,'mixed amended').edits[0]!.text,'mixed amended');
  assert.throws(()=>groupEditorSelection(mixed,blank(),0,5,'blocked'),/일부 글/);
  assert.throws(()=>replaceEditorText(mixed,blank(),5,6,'','blocked'),/같은 본문이나 표 칸/);
  const sameCell:EditorRow[]=[{...rowsOf('a')[0]!,path:[0,2,0]},{...rowsOf('b')[0]!,id:'p:0:0.2.1',path:[0,2,1]}];
  assert.equal(editorLayout(sameCell,replaceEditorText(sameCell,blank(),1,2,'','cell-block')).text,'ab');
});

test('continuous editor: regrouping and reediting an existing block preserve its ID/alias and remove only overlapping row edits',()=>{
  const rows=rowsOf('A','B','C','D'),work:EditorWork={edits:[{id:rows[3]!.id,text:'outside'}],blocks:[{id:'b-original',from:rows[0]!.id,to:rows[1]!.id,text:'첫 줄\n둘째 줄',alias:'사용자 이름'}]};
  const u=rowUnit(rows,work,rows[0]!.id),grouped=groupEditorSelection(rows,work,u.start+1,u.end-1,'b-should-not-replace');
  assert.deepEqual(grouped,work);
  const changed=replaceEditorText(rows,grouped,u.start,u.end,'새 {{value}}\n둘째','b-ignored');
  assert.equal(changed.blocks[0]!.id,'b-original');assert.equal(changed.blocks[0]!.alias,'사용자 이름');
  const layout=editorLayout(rows,changed),extended=groupEditorSelection(rows,changed,0,layout.units[1]!.end,'b-unused');
  assert.equal(extended.blocks.length,1);assert.equal(extended.blocks[0]!.id,'b-original');assert.equal(extended.blocks[0]!.to,rows[2]!.id);
  assert.deepEqual(extended.edits,work.edits);assert.equal(extended.blocks[0]!.text,'새 {{value}}\n둘째\nC');
});

test('continuous editor: deleted blocks have no phantom lines; a fully deleted projection still has a caret target for typing again',()=>{
  const rows=rowsOf('A','B','C','D'),work:EditorWork={edits:[],blocks:[{id:'b-delete',from:rows[1]!.id,to:rows[2]!.id,text:'',alias:'삭제 구간'}]};
  assert.equal(editorLayout(rows,work).text,'A\nD');assert.deepEqual(editorLayout(rows,work).units.map(u=>u.id),[rows[0]!.id,rows[3]!.id]);
  const all:EditorWork={edits:[],blocks:[{id:'b-all',from:rows[0]!.id,to:rows[3]!.id,text:'',alias:'전체'}]};
  assert.equal(editorLayout(rows,all).text,'');assert.equal(unitAt(editorLayout(rows,all).units,0)?.block,'b-all');
  const retyped=replaceEditorText(rows,all,0,0,'다시 작성','b-unused');
  assert.equal(editorLayout(rows,retyped).text,'다시 작성');assert.equal(retyped.blocks[0]!.id,'b-all');assert.equal(retyped.blocks[0]!.alias,'전체');
  const emptyParagraph=replaceRow(rows,blank(),rows[1]!.id,'');
  assert.equal(editorLayout(rows,emptyParagraph).text,'A\n\nC\nD');assert.equal(emptyParagraph.blocks.length,0);
});

test('continuous editor: readonly object sentinels are hidden only in the projection, preserving source text/IDs, next-row offsets and readonly boundaries',()=>{
  const rows=rowsOf('\uFFFC기관\uFFFC 값\uFFFC','다음 문단','직접 입력한 \uFFFC 문자');rows[0]!.editable=false;
  const before=frozen(rows),layout=editorLayout(rows,blank());
  assert.equal(layout.text,'기관 값\n다음 문단\n직접 입력한 \uFFFC 문자');
  assert.equal(layout.units[0]!.text,'기관 값');assert.equal(layout.units[0]!.id,rows[0]!.id);
  assert.equal(layout.units[1]!.start,'기관 값\n'.length);
  const changed=replaceRow(rows,blank(),rows[1]!.id,'수정 문단');
  assert.deepEqual(changed.edits,[{id:rows[1]!.id,text:'수정 문단'}]);
  assert.equal(editorLayout(rows,changed).text,'기관 값\n수정 문단\n직접 입력한 \uFFFC 문자');
  assert.throws(()=>replaceRow(rows,blank(),rows[0]!.id,'수정'),/읽기 전용/);
  assert.throws(()=>groupEditorSelection(rows,blank(),0,layout.units[1]!.end,'blocked'),/읽기 전용/);
  assert.deepEqual(rows,before);
  const source=buildHwpx([textPara('앞')+tableParagraph(gridTable([9000],1,[['셀 원문']],{id:'8390'}))+textPara('뒤')]);
  const app=createWorkbench(),opened=app.post('/api/workbench/open',{name:'synthetic.hwpx',content:Buffer.from(source).toString('base64')}) as {session:string;paragraphs:EditorRow[]};
  const owner=opened.paragraphs.find(r=>r.text.includes('\uFFFC'));assert(owner&&!owner.editable);
  const sourceRows=frozen(opened.paragraphs),projected=editorLayout(opened.paragraphs,blank());
  assert(!projected.text.includes('\uFFFC'));
  const cell=opened.paragraphs.find(r=>r.text==='셀 원문');assert(cell);
  const work=replaceRow(opened.paragraphs,blank(),cell.id,'셀 수정');
  app.post('/api/workbench/generate',{session:opened.session,index:0,headings:[],...work});
  const bytes=app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.body;
  const doc=parseDocument(openPackage(bytes));
  assert(doc.sections[0]!.paragraphs[1]!.logicalText.includes('\uFFFC'));
  assert.equal(doc.sections[0]!.paragraphs[1]!.objects.length,1);
  assert.equal(compareToBaseline(validateDocument(source),validateDocument(bytes)).newErrors.length,0);
  assert.deepEqual(opened.paragraphs,sourceRows);
  assert.deepEqual(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body),Buffer.from(source));
});

test('continuous editor TXT integration: grouping, multiline edits, work-file restoration and later data apply to the same source rows',()=>{
  const app=createWorkbench(),source=Buffer.from('제목\n첫 문장\n둘째 문장\n고정');
  const opened=app.post('/api/workbench/open',{name:'synthetic.txt',content:source.toString('base64')}) as {session:string;paragraphs:EditorRow[]};
  const rows=opened.paragraphs;
  let work=replaceRow(rows,blank(),rows[0]!.id,'**{{title}}**\n추가 설명');
  const a=rowUnit(rows,work,rows[1]!.id),z=rowUnit(rows,work,rows[2]!.id);work=groupEditorSelection(rows,work,a.start,z.end,'b-body');
  work=replaceRow(rows,work,rows[1]!.id,'번호 {{id}}\n확인 {{flag}}');
  const input={session:opened.session,index:0,headings:[],...work};
  const template=app.post('/api/workbench/generate',input) as any;assert.equal(template.unresolved,3);assert.equal(template.text,'{{title}}\n추가 설명\n번호 {{id}}\n확인 {{flag}}\n고정');
  const saved=app.post('/api/workbench/save',input) as {workspace:string};
  const restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as {session:string;paragraphs:EditorRow[]} & EditorWork;
  assert.deepEqual(restored.edits,work.edits);assert.deepEqual(restored.blocks,work.blocks);
  app.post('/api/workbench/data',{session:restored.session,name:'values.json',content:JSON.stringify({title:'**literal** {{untouched}}',id:'00007',flag:false})});
  const result=app.post('/api/workbench/generate',{...input,session:restored.session}) as any;
  assert.equal(result.text,'**literal** {{untouched}}\n추가 설명\n번호 00007\n확인 false\n고정');assert.equal(result.filled,3);
  assert.deepEqual(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body),source);
});

test('continuous editor HWPX integration: 32 body/cell locations, seeded 50 model edit sequences x2 generate; multiline, grouping, merging, literal values and source preservation',t=>{
  const body=Array.from({length:20},(_,i)=>textPara('B_'+i)).join('');
  const cells=Array.from({length:3},(_,r)=>Array.from({length:4},(_,c)=>'C_'+(r*4+c)));
  const source=buildHwpx([body+tableParagraph(gridTable([9000,9000,9000,9000],3,cells,{id:'8319'}))+textPara('OUTSIDE_FIXED')]);
  const sourceCopy=Buffer.from(source),baseline=validateDocument(source),pkg=openPackage(source),app=createWorkbench();
  const opened=app.post('/api/workbench/open',{name:'synthetic.hwpx',content:Buffer.from(source).toString('base64')}) as {session:string;paragraphs:EditorRow[]};
  const rows=opened.paragraphs,targets=rows.filter(r=>/^[BC]_/.test(r.text));assert.equal(targets.length,32);assert.equal(baseline.errors.length,0);
  const find=(name:string)=>{const r=rows.find(r=>r.text===name);assert(r);return r;};
  let seed=0x401bbabe,generated=0;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let iteration=0;iteration<50;iteration++) {
    const data={value:('검증할 긴 문장 '+random()+' & < > ').repeat(22)+'\n두번째 줄 😀 **literal** {{literal}}',tabValue:'탭\t'+random(),id:'00'+String(random()%1000000).padStart(6,'0'),flag:iteration%2===0?false:true};
    assert(data.value.length>400);const dataBefore=JSON.stringify(data);
    let work=blank();
    for(const r of targets)work=replaceRow(rows,work,r.id,r.text+'-'+iteration+': {{value}}');
    work=replaceRow(rows,work,find('B_0').id,'**요청 {{value}}**\n번호 {{id}}\n{{tabValue}}');
    let a=rowUnit(rows,work,find('B_1').id),z=rowUnit(rows,work,find('B_3').id);
    work=groupEditorSelection(rows,work,a.start,z.end,'b-selected');
    work=replaceRow(rows,work,find('B_1').id,'블록 {{id}}\n확인 {{flag}}');
    a=rowUnit(rows,work,find('B_1').id);work=groupEditorSelection(rows,work,a.start,a.end,'b-do-not-change');
    assert.equal(work.blocks.find(b=>b.from===find('B_1').id)!.id,'b-selected');
    a=rowUnit(rows,work,find('B_4').id);z=rowUnit(rows,work,find('B_5').id);
    work=replaceEditorText(rows,work,a.end,z.start,'','b-merge');
    work=replaceRow(rows,work,find('B_6').id,'');
    const expected=editorLayout(rows,work).text.replaceAll('**','').replace(/\{\{(value|id|flag|tabValue)\}\}/g,(_,key:keyof typeof data)=>String(data[key])).replaceAll('\uFFFC','');
    app.post('/api/workbench/data',{session:opened.session,name:'values.json',content:dataBefore});
    let first:Uint8Array|undefined;
    for(let repeat=0;repeat<2;repeat++) {
      const result=app.post('/api/workbench/generate',{session:opened.session,index:0,headings:[],...work}) as any;
      assert.equal(result.text,expected);assert.equal(result.text.split(data.value).length-1,28);
      const bytes=app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.body;
      if(first)assert.deepEqual(bytes,first);else first=bytes;
      const doc=parseDocument(openPackage(bytes));assert.equal(compareToBaseline(baseline,validateDocument(bytes)).newErrors.length,0);
      assert.equal([...walkParagraphs(doc.sections[0]!.paragraphs)].at(-1)!.logicalText,'OUTSIDE_FIXED');
      const next=openPackage(bytes);
      for(const entry of pkg.archive.entries.filter(e=>!pkg.sectionEntries.includes(e.name)&&e.name!==pkg.headerEntry&&!e.name.startsWith('Preview/')))
        assert.deepEqual(readEntry(next.archive,bytes,entry.name),readEntry(pkg.archive,source,entry.name),entry.name);
      generated++;
    }
    // insertText blocks intentionally reject tabs; inline paragraph edits above
    // retain them. Do not conceal this public-engine boundary by dropping tabs.
    assert.throws(()=>app.post('/api/workbench/generate',{session:opened.session,index:0,headings:[],...work,blocks:work.blocks.map(b=>b.id==='b-merge'?{...b,text:'{{tabValue}}'}:b)}),(e:any)=>e.code==='WORKBENCH_TEXT');
    assert.throws(()=>app.get('/api/workbench/result',new URLSearchParams({session:opened.session})),(e:any)=>e.code==='WORKBENCH_RESULT');
    assert.equal(JSON.stringify(data),dataBefore);
  }
  assert.equal(generated,100);assert.deepEqual(Buffer.from(source),sourceCopy);
  t.diagnostic('seed=0x401bbabe; source_targets=32; model_sequences=50; generations=100; deterministic_pairs=50; expected_text_matches=100; literal_value_occurrences=2800; new_errors=0; source/data/untouched ZIP unchanged');
});
