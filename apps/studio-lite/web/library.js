import {createLatest} from '/packages/viewer/src/dom/index.ts';
const $=id=>document.getElementById(id);
const templateReads=createLatest(),previews=createLatest();
let templates=[],datasets=[],selected=null,busy=false;
const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
const clear=()=>{$('values').replaceChildren();$('slots').replaceChildren();};
function controls(){
  for(const id of ['save-template','save-data','refresh','template-file','proto-files','source-files','data-file','data-name','next-version','saved-template','saved-data'])$(id).disabled=busy;
  $('row').disabled=busy||!$('saved-data').value;
  $('preview').disabled=busy||!selected||!$('saved-data').value;
  $('export-template').disabled=busy||!selected;
}
async function api(path,input){
  const r=await fetch('/api/library/'+path,input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{});
  const v=await r.json();if(!r.ok)throw new Error(v.error??'보관함 요청을 처리하지 못했습니다.');return v;
}
const chosen=(items,value)=>items.find(v=>v.id+':'+v.version===value);
function list(node,items,title){const current=node.value;node.replaceChildren(new Option(title,''));for(const v of items)node.add(new Option(v.name+' · '+v.version+'판',v.id+':'+v.version));node.value=current;}
async function refresh(){[templates,datasets]=await Promise.all([api('templates'),api('datasets')]);list($('saved-template'),templates,'템플릿 선택');list($('saved-data'),datasets,'데이터 선택');controls();}
function table(node,heads,rows){const head=document.createElement('tr');for(const text of heads){const th=document.createElement('th');th.textContent=text;head.append(th);}node.replaceChildren(head);for(const cells of rows){const row=document.createElement('tr');for(const text of cells){const td=document.createElement('td');td.textContent=String(text??'');row.append(td);}node.append(row);}}
function renderBindings(){
  $('bindings').replaceChildren();
  for(const b of selected.bindings){const p=document.createElement('p'),value=selected.values.find(v=>v.id===b.value);p.textContent=(value?.name??b.value)+' ← '+('key'in b?b.key:b.path);$('bindings').append(p);}
  if(!selected.bindings.length){const p=document.createElement('p');p.textContent='연결한 값이 없습니다.';$('bindings').append(p);}
  $('template-json').value=JSON.stringify(selected,null,2);
  const saved=chosen(templates,$('saved-template').value);$('source-download').hidden=false;$('source-download').href='/api/library/source?id='+encodeURIComponent(saved.id)+'&version='+saved.version;$('source-download').download=selected.source.kind==='hwpx'?'source.hwpx':'source.md';
}
async function loadTemplate(){
  const ticket=templateReads.begin();previews.cancel();selected=null;clear();$('bindings').replaceChildren();$('template-json').value='';$('source-download').hidden=true;controls();
  const saved=chosen(templates,$('saved-template').value);if(!saved)return;
  try{const t=await api('template?id='+encodeURIComponent(saved.id)+'&version='+saved.version);if(!templateReads.current(ticket))return;selected=t;renderBindings();status('저장한 템플릿의 연결을 복원했습니다.');controls();}catch(e){if(templateReads.current(ticket))status(e.message,true);}
}
async function work(fn){if(busy)return;busy=true;templateReads.cancel();previews.cancel();clear();controls();try{await fn();}catch(e){status(e.message,true);}finally{busy=false;controls();}}
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);}
$('save-template').addEventListener('click',()=>work(async()=>{
  const template=$('template-file').files?.[0];if(!template)throw new Error('템플릿 JSON을 선택하세요.');
  const protos=await Promise.all([...$('proto-files').files].map(file=>file.text()));
  const blobs=await Promise.all([...$('source-files').files].map(async file=>base64(new Uint8Array(await file.arrayBuffer()))));
  const saved=await api('save',{template:await template.text(),protos,blobs});await refresh();$('saved-template').value=saved.id+':'+saved.version;await loadTemplate();status('템플릿과 참조 파일을 함께 보관했습니다.');
}));
$('save-data').addEventListener('click',()=>work(async()=>{
  const file=$('data-file').files?.[0];if(!file)throw new Error('데이터 JSON을 선택하세요.');
  const input={name:$('data-name').value.trim()||file.name,content:await file.text()};
  if($('next-version').checked){const previous=chosen(datasets,$('saved-data').value);if(!previous)throw new Error('새 판을 추가할 데이터를 선택하세요.');input.id=previous.id;input.version=previous.version;}
  const saved=await api('data',input);await refresh();$('saved-data').value=saved.id+':'+saved.version;$('row').value='1';$('row').max=String(saved.records);status('원본 데이터의 새 저장본을 보관했습니다.');
}));
$('saved-template').addEventListener('change',loadTemplate);
$('saved-data').addEventListener('change',()=>{previews.cancel();clear();const d=chosen(datasets,$('saved-data').value);$('row').value='1';$('row').max=String(d?.records??1);controls();});
$('row').addEventListener('input',()=>{previews.cancel();clear();});
$('refresh').addEventListener('click',()=>work(async()=>{selected=null;$('bindings').replaceChildren();$('source-download').hidden=true;$('template-json').value='';await refresh();await loadTemplate();status('저장 목록을 다시 불러왔습니다.');}));
const valueState={bound:'연결됨',edited:'이번 건 수정',missing:'누락',empty:'빈 값',rejected:'사용 불가'};
const slotState={manual:'직접 선택',confirmed:'확정',default:'조건 기본값',fallback:'기본 블록',undecided:'선택 필요',recheck:'재확인 필요',inactive:'비활성'};
$('preview').addEventListener('click',async()=>{
  const t=chosen(templates,$('saved-template').value),d=chosen(datasets,$('saved-data').value);if(!t||!d||busy)return;
  const ticket=previews.begin();clear();
  try{const p=await api('preview?id='+encodeURIComponent(t.id)+'&version='+t.version+'&dataset='+encodeURIComponent(d.id)+'&dataVersion='+d.version+'&row='+(Number($('row').value)-1));if(!previews.current(ticket))return;
    table($('values'),['항목','상태','값 / 사유'],p.values.map(v=>[v.name,valueState[v.state]??v.state,v.issue?.message??v.text??'']));
    table($('slots'),['블록 그룹','선택 상태','블록 / 사유'],p.slots.map(s=>[selected.slots.find(v=>v.id===s.slot)?.name??s.slot,slotState[s.state]??s.state,(selected.blocks.find(v=>v.id===s.block)?.name??'')+' '+s.message]));status('저장한 연결과 조건을 확인했습니다. 원본 데이터는 그대로입니다.');
  }catch(e){if(previews.current(ticket))status(e.message,true);}
});
$('export-template').addEventListener('click',()=>{if(!selected)return;const url=URL.createObjectURL(new Blob([JSON.stringify(selected,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='template.json';a.click();URL.revokeObjectURL(url);});
work(refresh);
