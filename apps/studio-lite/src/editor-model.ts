// Plain-text projection; source addresses remain stable when visible lines move.
export type EditorRow = {id:string; text:string; sectionIndex:number; path:number[]; editable:boolean; rangeEditable?:boolean};
export type EditorWork = {edits:{id:string;text:string}[]; blocks:{id:string;from:string;to:string;text:string;alias:string}[]};
export type EditorUnit = {id:string; from:number; to:number; start:number; end:number; text:string; block?:string; alias?:string};
export function editorLayout(rows:EditorRow[], work:EditorWork) {
  const units:EditorUnit[]=[]; const edits=new Map(work.edits.map(e=>[e.id,e.text])); let text='';
  let deleted:EditorUnit|undefined;
  for(let i=0;i<rows.length;i++) {
    const row=rows[i]!,block=work.blocks.find(b=>b.from===row.id),from=i;
    if(block) { const to=rows.findIndex(r=>r.id===block.to); if(to<i)throw Error('블록 위치를 확인하세요.'); i=to; }
    const original=block?.text??edits.get(row.id)??row.text;
    // Object sentinels describe source structure, not printable body text.
    // Readonly rows keep their original IDs/text; only the projection omits them.
    const value=(row.editable?original:original.replaceAll('\uFFFC','')).replace(/\r\n?|\n/g,'\n');
    // The generation API deletes an empty block. Do not show a phantom line;
    // retain one empty caret target only when the entire projection is empty.
    if(block&&value==='') {deleted??={id:row.id,from,to:i,start:0,end:0,text:'',block:block.id,alias:block.alias};continue;}
    if(units.length)text+='\n';
    const start=text.length; text+=value;
    units.push({id:row.id,from,to:i,start,end:text.length,text:value,...(block?{block:block.id,alias:block.alias}:{})});
  }
  if(!units.length&&deleted)units.push(deleted);
  return {text,units};
}
export function unitAt(units:EditorUnit[], offset:number) {
  return Number.isInteger(offset)&&offset>=0?units.find(u=>offset>=u.start&&offset<=u.end):undefined;
}
export function editorSelection(layout:ReturnType<typeof editorLayout>, start:number, end:number) {
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>layout.text.length)return [];
  const first=unitAt(layout.units,start),last=unitAt(layout.units,Math.max(start,end-1));
  return first&&last?layout.units.filter(u=>u.from>=first.from&&u.to<=last.to):[];
}
function checkRange(rows:EditorRow[], from:number,to:number) {
  const selected=rows.slice(from,to+1),a=selected[0]!;
  if(!selected.every(r=>r.editable))throw Error('읽기 전용 내용이 포함되어 있습니다.');
  if(from===to)return;
  if(!selected.every((r,i)=>r.rangeEditable!==false&&r.sectionIndex===a.sectionIndex&&r.path.length===a.path.length&&r.path.slice(0,-1).every((n,j)=>n===a.path[j])&&r.path.at(-1)===a.path.at(-1)!+i))
    throw Error('같은 본문이나 표 칸 안에서 서식이 단순한 줄끼리 선택하세요.');
}
export function replaceEditorText(rows:EditorRow[], work:EditorWork, start:number,end:number,value:string,id:string) : EditorWork {
  const layout=editorLayout(rows,work),a=unitAt(layout.units,start),z=unitAt(layout.units,end);
  if(!a||!z||start<0||end<start||end>layout.text.length)throw Error('편집 범위를 확인하세요.');
  checkRange(rows,a.from,z.to);
  const text=layout.text.slice(a.start,start)+value+layout.text.slice(end,z.end);
  if(a===z&&!a.block) {
    const edits=work.edits.filter(e=>e.id!==a.id);
    if(text!==rows[a.from]!.text)edits.push({id:a.id,text});
    return {edits,blocks:work.blocks.map(b=>({...b}))};
  }
  const removed=new Set(rows.slice(a.from,z.to+1).map(r=>r.id));
  const previous=work.blocks.find(b=>b.id===a.block);
  return {edits:work.edits.filter(e=>!removed.has(e.id)),blocks:[...work.blocks.filter(b=>!removed.has(b.from)),{
    id:previous?.id??id,from:a.id,to:rows[z.to]!.id,text,alias:previous?.alias??'블록',
  }]};
}
export function groupEditorSelection(rows:EditorRow[],work:EditorWork,start:number,end:number,id:string):EditorWork {
  const layout=editorLayout(rows,work),selected=editorSelection(layout,start,end),a=selected[0],z=selected.at(-1);
  if(!a||!z||start===end)throw Error('묶을 글을 선택하세요.');
  checkRange(rows,a.from,z.to);
  if(!rows.slice(a.from,z.to+1).every(r=>r.rangeEditable!==false))throw Error('이 줄은 일부 글만 수정할 수 있습니다.');
  const removed=new Set(rows.slice(a.from,z.to+1).map(r=>r.id));
  const previous=work.blocks.find(b=>b.id===a.block);
  return {edits:work.edits.filter(e=>!removed.has(e.id)),blocks:[...work.blocks.filter(b=>!removed.has(b.from)),{
    id:previous?.id??id,from:a.id,to:rows[z.to]!.id,text:layout.text.slice(a.start,z.end),alias:previous?.alias??'블록',
  }]};
}
// ponytail: a single contiguous diff keeps typing/paste/IME on the native textarea.
export function editorChange(before:string,after:string) {
  let start=0,end=before.length,next=after.length;
  while(start<end&&start<next&&before[start]===after[start])start++;
  while(end>start&&next>start&&before[end-1]===after[next-1]){end--;next--;}
  return {start,end,value:after.slice(start,next)};
}
