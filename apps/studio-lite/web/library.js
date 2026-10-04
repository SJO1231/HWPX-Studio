import {createLatest} from '/packages/viewer/src/dom/index.ts';
const $=id=>document.getElementById(id);
const templateReads=createLatest(),previews=createLatest(),historyReads=createLatest();
let templates=[],datasets=[],cases=[],generations=[],selected=null,busy=false,generatedURL=null;
const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
const clear=()=>{$('values').replaceChildren();$('slots').replaceChildren();if(generatedURL)URL.revokeObjectURL(generatedURL);generatedURL=null;$('generated-download').hidden=true;};
function controls(){
  for(const id of ['save-template','save-data','refresh','template-file','proto-files','source-files','data-file','data-name','next-version','saved-template','saved-data','saved-case','case-file','case-blobs','replace-case','save-case','saved-generation'])$(id).disabled=busy;
  $('row').disabled=busy||!$('saved-data').value;
  $('preview').disabled=busy||!selected||!$('saved-data').value;
  $('generate').disabled=$('preview').disabled;
  $('export-template').disabled=busy||!selected;
}
async function api(path,input){
  const r=await fetch('/api/library/'+path,input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{});
  const v=await r.json();if(!r.ok)throw new Error(v.error??'보관함 요청을 처리하지 못했습니다.');return v;
}
const chosen=(items,value)=>items.find(v=>v.id+':'+v.version===value);
function list(node,items,title){const current=node.value;node.replaceChildren(new Option(title,''));for(const v of items)node.add(new Option(v.name+' · '+v.version+'판',v.id+':'+v.version));node.value=current;}
async function refresh(){
  [templates,datasets,cases,generations]=await Promise.all([api('templates'),api('datasets'),api('cases'),api('generations')]);
  list($('saved-template'),templates,'템플릿 선택');list($('saved-data'),datasets,'데이터 선택');
  const current=$('saved-case').value;$('saved-case').replaceChildren(new Option('이번 건 수정 없이',''));
  for(const c of cases){const t=templates.find(t=>t.id===c.template&&t.version===c.templateVersion),d=datasets.find(d=>d.id===c.dataset&&d.version===c.dataVersion);$('saved-case').add(new Option((t?.name??'템플릿')+' '+c.templateVersion+'판 / '+(d?.name??'데이터')+' '+c.dataVersion+'판 '+(c.row+1)+'행 · 건 '+c.id+' / 진행 '+c.revision,String(c.id)));}
  $('saved-case').value=current;
  const saved=$('saved-generation').value;$('saved-generation').replaceChildren(new Option('생성 기록 선택',''));
  for(const g of generations){const t=templates.find(t=>t.id===g.template&&t.version===g.templateVersion);$('saved-generation').add(new Option((t?.name??'템플릿')+' '+(g.row+1)+'행 · 기록 '+g.id,String(g.id)));}
  $('saved-generation').value=saved;controls();
}
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
async function work(fn){if(busy)return;busy=true;previews.cancel();clear();controls();try{await fn();}catch(e){status(e.message,true);}finally{busy=false;controls();}}
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
$('save-case').addEventListener('click',()=>work(async()=>{
  const file=$('case-file').files?.[0];if(!file)throw new Error('이번 건 JSON을 선택하세요.');
  const input={document:await file.text(),blobs:await Promise.all([...$('case-blobs').files].map(async file=>base64(new Uint8Array(await file.arrayBuffer()))))};
  if($('replace-case').checked){if(!$('saved-case').value)throw new Error('갱신할 이번 건을 선택하세요.');input.id=Number($('saved-case').value);}
  const saved=await api('case',input),loaded=await api('case?id='+saved.id);await refresh();
  const c=loaded.case;$('saved-template').value=c.template.id+':'+c.template.version;$('saved-data').value=c.record.dataset+':'+c.record.version;$('saved-case').value=String(saved.id);$('row').value=String(c.record.row+1);$('row').max=String(chosen(datasets,$('saved-data').value)?.records??1);
  await loadTemplate();status('이번 건의 선택과 수정 내용을 따로 보관했습니다.');
}));
$('saved-case').addEventListener('change',()=>{previews.cancel();clear();});
$('saved-template').addEventListener('change',loadTemplate);
$('saved-data').addEventListener('change',()=>{previews.cancel();clear();const d=chosen(datasets,$('saved-data').value);$('row').value='1';$('row').max=String(d?.records??1);controls();});
$('row').addEventListener('input',()=>{previews.cancel();clear();});
$('refresh').addEventListener('click',()=>work(async()=>{selected=null;$('bindings').replaceChildren();$('source-download').hidden=true;$('template-json').value='';await refresh();await loadTemplate();status('저장 목록을 다시 불러왔습니다.');}));
const valueState={bound:'연결됨',edited:'이번 건 수정',missing:'누락',empty:'빈 값',rejected:'사용 불가'};
const slotState={manual:'직접 선택',confirmed:'확정',default:'조건 기본값',fallback:'기본 블록',undecided:'선택 필요',recheck:'재확인 필요',inactive:'비활성'};
$('preview').addEventListener('click',async()=>{
  const t=chosen(templates,$('saved-template').value),d=chosen(datasets,$('saved-data').value);if(!t||!d||busy)return;
  const ticket=previews.begin();clear();
  try{const p=await api('preview?id='+encodeURIComponent(t.id)+'&version='+t.version+'&dataset='+encodeURIComponent(d.id)+'&dataVersion='+d.version+'&row='+(Number($('row').value)-1)+($('saved-case').value?'&case='+encodeURIComponent($('saved-case').value):''));if(!previews.current(ticket))return;
    table($('values'),['항목','상태','값 / 사유'],p.values.map(v=>[v.name,valueState[v.state]??v.state,v.issue?.message??v.text??'']));
    table($('slots'),['블록 그룹','선택 상태','블록 / 사유'],p.slots.map(s=>[selected.slots.find(v=>v.id===s.slot)?.name??s.slot,slotState[s.state]??s.state,(selected.blocks.find(v=>v.id===s.block)?.name??'')+' '+s.message]));status('저장한 연결과 선택을 확인했습니다. 원본 데이터는 그대로입니다.');
  }catch(e){if(previews.current(ticket))status(e.message,true);}
});
async function loadGeneration(){
  const ticket=historyReads.begin();$('generation-download').hidden=true;$('generation-note').textContent='';const id=$('saved-generation').value;if(!id)return;
  try{const g=await api('generation?id='+encodeURIComponent(id));if(!historyReads.current(ticket))return;
    $('generation-note').textContent='템플릿 '+g.templateVersion+'판 / 데이터 '+g.dataVersion+'판 / '+(g.row+1)+'행 · '+(g.caseRevision===null?'이번 건 수정 없음':'이번 건 진행 '+g.caseRevision)+' · '+(g.kind==='hwpx'?'HWPX':'Markdown');
    $('generation-download').href='/api/library/generation?id='+encodeURIComponent(id)+'&output=1';$('generation-download').download='document.'+(g.kind==='hwpx'?'hwpx':'md');$('generation-download').hidden=false;
  }catch(e){if(historyReads.current(ticket))status(e.message,true);}
}
$('saved-generation').addEventListener('change',loadGeneration);
$('generate').addEventListener('click',()=>work(async()=>{
  const t=chosen(templates,$('saved-template').value),d=chosen(datasets,$('saved-data').value);if(!t||!d)throw new Error('템플릿과 데이터를 선택하세요.');
  const request={id:t.id,version:t.version,dataset:d.id,dataVersion:d.version,row:Number($('row').value)-1};if($('saved-case').value)request.case=Number($('saved-case').value);
  const r=await fetch('/api/library/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  if(!r.ok){const error=await r.json();throw new Error((error.code?error.code+': ':'')+error.error);}
  const output=await r.blob();generatedURL=URL.createObjectURL(output);$('generated-download').href=generatedURL;$('generated-download').download=t.id+'.'+(output.type.startsWith('text/')?'md':'hwpx');$('generated-download').hidden=false;await refresh();$('saved-generation').value=r.headers.get('X-Generation-Id');await loadGeneration();status('문서를 생성하고 당시 선택과 출력을 보관했습니다. 내려받아 확인하세요.');
}));
$('export-template').addEventListener('click',()=>{if(!selected)return;const url=URL.createObjectURL(new Blob([JSON.stringify(selected,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='template.json';a.click();URL.revokeObjectURL(url);});
work(refresh);
