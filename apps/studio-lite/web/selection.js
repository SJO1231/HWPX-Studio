import {createLatest} from '/packages/viewer/src/dom/index.ts';
const $=id=>document.getElementById(id);
const latest=createLatest(),caseReads=createLatest(),cases=new Map();
let dataset=null,pendingCase,ready=false,busy=false,importingCase=false,result=null,outputURL=null;
const valueStates={bound:'연결됨',edited:'이번 건 수정',missing:'누락',empty:'빈 값',rejected:'사용 불가'};
const slotStates={manual:'직접 선택',confirmed:'확정',default:'조건 기본값',fallback:'기본 블록',undecided:'선택 필요',recheck:'재확인 필요',inactive:'비활성'};
const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
const row=()=>Number($('row').value)-1;
const caseKey=index=>dataset===null?null:dataset+':'+index;
const currentCase=index=>pendingCase??cases.get(caseKey(index));
function discardOutput(){
  if(outputURL)URL.revokeObjectURL(outputURL);
  outputURL=null;$('download').hidden=true;$('download').removeAttribute('href');
  $('text-output').hidden=true;$('output-text').textContent='';
  $('output-note').textContent='파일 형식에 맞추어 생성합니다.';
}
function controls(){
  for(const id of ['template-file','data-file','proto-files','source-files','case-file','row'])$(id).disabled=busy||(id==='row'&&!$('data-file').files.length);
  $('preview').disabled=busy||importingCase||!$('template-file').files.length||!$('data-file').files.length;
  $('case-file').disabled=busy||!$('template-file').files.length||!$('data-file').files.length;
  $('export-case').disabled=busy||importingCase||!ready||!currentCase(row());
  $('clear-case').disabled=busy||!currentCase(row());
  $('generate').disabled=busy||importingCase||!ready||!!result?.slots.some(s=>s.blocked)||!!result?.template.slots.some(s=>s.parent!==null)||!result?.sourceVerified;
  for(const element of $('slots').querySelectorAll('button,select'))element.disabled=busy||element.dataset.disabled==='true';
}
function invalidate(){
  latest.cancel();ready=false;result=null;discardOutput();
  $('values').replaceChildren();$('slots').replaceChildren();$('template-info').textContent='확인 전';
  $('selection-note').textContent='입력을 변경했습니다. 연결과 기본 블록을 다시 확인하세요.';
  controls();
}
function base64(bytes){
  let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);
}
async function requestInput(){
  const template=$('template-file').files[0],data=$('data-file').files[0],index=row(),saved=currentCase(index);
  if(!template||!data)throw new Error('템플릿과 데이터를 선택하세요.');
  if(!Number.isInteger(index)||index<0)throw new Error('데이터 행은 1 이상의 정수로 지정하세요.');
  const protos=[...$('proto-files').files],sources=[...$('source-files').files];
  const [templateText,dataText,protoTexts,blobs]=await Promise.all([template.text(),data.text(),Promise.all(protos.map(file=>file.text())),Promise.all(sources.map(async file=>base64(new Uint8Array(await file.arrayBuffer()))))]);
  const input={template:templateText,data:dataText,protos:protoTexts,blobs,row:index};if(saved!==undefined)input.case=saved;return input;
}
async function jsonRequest(input){
  const r=await fetch('/api/selection/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  const value=await r.json();if(!r.ok)throw new Error((value.code?value.code+': ':'')+(value.error??'요청을 처리하지 못했습니다.'));return value;
}
function tableValues(values){
  const head=document.createElement('tr');
  for(const text of ['항목','상태','값 / 사유']){const th=document.createElement('th');th.textContent=text;head.append(th);}
  $('values').replaceChildren(head);
  for(const value of values){
    const tr=document.createElement('tr');
    for(const text of [value.name,valueStates[value.state]??value.state,value.issue?.message??value.text??'']){const td=document.createElement('td');td.textContent=text;tr.append(td);}
    $('values').append(tr);
  }
}
function renderSlots(){
  $('slots').replaceChildren();
  for(const selection of result.slots){
    const slot=result.template.slots.find(s=>s.id===selection.slot),blocks=result.template.blocks.filter(b=>b.slot===selection.slot);
    const box=document.createElement('section');box.className='block-editor';
    const heading=document.createElement('h2');heading.textContent=slot?.name??selection.slot;
    const state=document.createElement('p');state.className=selection.blocked?'bad':'ok';state.textContent=slotStates[selection.state]??selection.state;
    const message=document.createElement('p');message.textContent=selection.message;
    box.append(heading,state,message);
    if(selection.differs){const note=document.createElement('p');note.className='warn';note.textContent='조건 기본값과 다른 저장한 선택을 유지하고 있습니다.';box.append(note);}
    const choose=document.createElement('select');choose.setAttribute('aria-label',(slot?.name??selection.slot)+' 블록 선택');const empty=new Option('사용할 블록 직접 선택','');empty.disabled=true;choose.add(empty);
    for(const block of blocks)choose.add(new Option(block.name,block.id));
    choose.value=selection.block??'';choose.disabled=selection.state==='inactive'||slot?.parent!==null;
    const actions=document.createElement('div');actions.className='actions';
    const manual=document.createElement('button');manual.textContent='직접 선택 적용';manual.disabled=choose.disabled;
    manual.addEventListener('click',()=>{if(!choose.value){status('사용할 블록을 선택하세요.',true);return;}preview({slot:selection.slot,mode:'manual',block:choose.value});});
    choose.addEventListener('change',()=>{if(choose.value)preview({slot:selection.slot,mode:'manual',block:choose.value});});
    const confirm=document.createElement('button');confirm.textContent='기본값 확정';confirm.disabled=choose.disabled||!['default','fallback'].includes(selection.state);
    confirm.addEventListener('click',()=>preview({slot:selection.slot,mode:'confirm'}));
    const clear=document.createElement('button');clear.textContent='저장한 선택 해제';clear.disabled=choose.disabled||!['manual','confirmed','recheck'].includes(selection.state);
    clear.addEventListener('click',()=>preview({slot:selection.slot,mode:'clear'}));
    for(const element of [choose,manual,confirm,clear])element.dataset.disabled=String(element.disabled);
    actions.append(manual,confirm,clear);box.append(choose,actions);$('slots').append(box);
  }
  if(!result.slots.length){const p=document.createElement('p');p.className='muted';p.textContent='이 템플릿에는 선택할 블록이 없습니다.';$('slots').append(p);}
  const blocked=result.slots.filter(s=>s.blocked),nested=result.template.slots.some(s=>s.parent!==null);
  $('selection-note').textContent=!result.sourceVerified?'원본이 아직 확인되지 않아 생성할 수 없습니다. 참조하는 원본 파일을 올려 다시 확인하세요.':nested?'중첩 블록은 이번 단계에서 생성할 수 없습니다.':blocked.length?blocked.length+'곳의 선택·재확인이 필요합니다.':'모든 선택을 확인했습니다. 문서를 생성할 수 있습니다.';
}
async function preview(action){
  if(busy)return;const ticket=latest.begin();ready=false;result=null;discardOutput();$('values').replaceChildren();$('slots').replaceChildren();controls();status('연결과 블록 선택을 확인하고 있습니다.');
  try{
    const input=await requestInput();if(!latest.current(ticket))return;if(action)input.action=action;
    const next=await jsonRequest(input);if(!latest.current(ticket))return;
    dataset=next.record.dataset+':'+next.record.version;cases.set(caseKey(next.record.row),next.case);pendingCase=undefined;
    result=next;ready=true;$('row').max=String(next.rows);$('data-info').textContent=next.rows+'행 중 '+(next.record.row+1)+'행을 확인하고 있습니다.';
    $('template-info').textContent=(next.template.meta?.name??'템플릿')+' '+next.template.version+'판';
    tableValues(next.values);renderSlots();controls();status('선택 상태를 확인했습니다. 원본 데이터와 템플릿은 그대로입니다.');
  }catch(e){if(latest.current(ticket)){status(e.message,true);controls();}}
}
function fileChanged(event){
  caseReads.cancel();importingCase=false;
  if(event.target.id==='data-file'){pendingCase=undefined;dataset=null;cases.clear();$('case-file').value='';$('row').value='1';$('row').removeAttribute('max');$('data-info').textContent='새 데이터입니다. 이전 선택을 자동 적용하지 않습니다.';}
  invalidate();status('파일을 변경했습니다. 연결과 기본 블록을 확인하세요.');
}
for(const id of ['template-file','data-file','proto-files','source-files'])$(id).addEventListener('change',fileChanged);
$('row').addEventListener('input',()=>{caseReads.cancel();importingCase=false;pendingCase=undefined;invalidate();status('데이터 행을 변경했습니다. 연결과 기본 블록을 확인하세요.');});
$('case-file').addEventListener('change',async()=>{
  const ticket=caseReads.begin(),file=$('case-file').files[0];importingCase=!!file;pendingCase=undefined;invalidate();if(!file)return;
  status('이번 건 파일을 읽고 있습니다.');
  try{
    const document=await file.text();if(!caseReads.current(ticket))return;const c=JSON.parse(document);
    importingCase=false;pendingCase=document;if(Number.isInteger(c?.record?.row)&&c.record.row>=0)$('row').value=String(c.record.row+1);
    controls();if(!$('preview').disabled)await preview();else status('템플릿과 데이터를 먼저 선택하고 이번 건 파일을 다시 불러오세요.');
  }catch(e){if(caseReads.current(ticket)){importingCase=false;pendingCase=undefined;status(e.message,true);controls();}}
});
$('clear-case').addEventListener('click',()=>{
  caseReads.cancel();importingCase=false;pendingCase=undefined;cases.delete(caseKey(row()));$('case-file').value='';invalidate();status('이 행의 이번 건 선택과 수정을 해제했습니다.');if(!$('preview').disabled)preview();
});
$('preview').addEventListener('click',()=>preview());
$('export-case').addEventListener('click',()=>{
  const document=currentCase(row());if(!ready||document===undefined)return;
  const url=URL.createObjectURL(new Blob([document],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='case.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('generate').addEventListener('click',async()=>{
  if($('generate').disabled)return;const ticket=latest.begin();busy=true;discardOutput();controls();status('선택한 블록으로 문서를 생성하고 있습니다.');
  try{
    const input=await requestInput();if(!latest.current(ticket))return;
    const r=await fetch('/api/selection/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    if(!r.ok){const error=await r.json();throw new Error((error.code?error.code+': ':'')+(error.error??'생성하지 못했습니다.'));}
    const output=await r.blob();if(!latest.current(ticket))return;
    const isText=output.type.startsWith('text/');outputURL=URL.createObjectURL(output);$('download').href=outputURL;$('download').download='document.'+(isText?'md':'hwpx');$('download').hidden=false;
    if(isText){const text=await output.text();if(!latest.current(ticket))return;$('output-text').textContent=text;$('text-output').hidden=false;}
    $('output-note').textContent=isText?'Markdown을 생성했습니다. 아래 표시나 내려받기로 확인하세요.':'HWPX를 생성했습니다. 내려받아 문서를 확인하세요.';
    status('문서를 생성했습니다. 입력이나 선택을 바꾸면 이 생성물은 무효화됩니다.');
  }catch(e){if(latest.current(ticket)){discardOutput();status(e.message,true);}}
  finally{busy=false;controls();}
});
controls();
