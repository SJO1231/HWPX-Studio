import {createLatest} from '/packages/viewer/src/dom/index.ts';
const $=id=>document.getElementById(id);
const requests=createLatest(),templateLoads=createLatest(),dataLoads=createLatest();
const drafts=new Map();
let templateDocument=null,dataDocument=null,view=null,savedDocument=null,xlsx=null,changed=false,ready=false,pending=false,loadingTemplate=false,loadingData=false;
const states={bound:'연결됨',edited:'이번 건 수정',missing:'누락',empty:'빈 값',rejected:'사용 불가'};
const kinds={clickHere:'누름틀',mailMerge:'메일 머지',placeholder:'{{키}}',word:'낱말',line:'문단',cell:'표 칸'};
const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
function controls(){
  const loaded=templateDocument!==null&&dataDocument!==null&&!loadingTemplate&&!loadingData;
  $('row').disabled=dataDocument===null||loadingData;
  $('xlsx-sheet').disabled=loadingData||xlsx===null;
  $('preview').disabled=!loaded||pending;
  $('update').disabled=!loaded||pending||!view||!changed;
  $('export').disabled=!ready||changed||savedDocument===null||pending;
}
function invalidate(){
  requests.cancel();pending=false;ready=false;
  for(const cell of $('mapping-rows').querySelectorAll('[data-value]'))cell.textContent='변경됨 · 다시 확인하세요.';
  $('mapping-note').textContent='입력을 변경했습니다. 연결표를 다시 확인하세요.';
  controls();
}
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);}
async function api(path,input){
  const r=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  const value=await r.json();if(!r.ok)throw new Error((value.code?value.code+': ':'')+(value.error??'요청을 처리하지 못했습니다.'));return value;
}
function inputBindings(){
  const bindings=[];
  for(const [value,draft] of drafts){
    if(draft.mode==='none')continue;
    const binding={value,[draft.mode]:draft.entry};
    if(draft.mode==='key'&&draft.aliases!==undefined)binding.aliases=draft.aliases.filter(alias=>alias!==draft.entry);
    bindings.push(binding);
  }
  return bindings;
}
async function requestInput(){
  if(templateDocument===null||dataDocument===null)throw new Error('템플릿과 데이터를 먼저 올리세요.');
  const row=Number($('row').value)-1;if(!Number.isInteger(row)||row<0)throw new Error('행 번호는 1 이상의 정수로 입력하세요.');
  const template=templateDocument,data=dataDocument,bindings=view?inputBindings():undefined;
  const protoFiles=[...$('proto-files').files],sourceFiles=[...$('source-files').files];
  const [protos,blobs]=await Promise.all([Promise.all(protoFiles.map(file=>file.text())),Promise.all(sourceFiles.map(async file=>base64(new Uint8Array(await file.arrayBuffer()))))]);
  const input={template,data,row,protos,blobs};if(bindings!==undefined)input.bindings=bindings;return input;
}
function placesText(value){
  const places=view.locations.find(location=>location.value===value)?.places??[];
  if(!places.length)return '적용 위치 없음';
  return places.map(place=>{
    const key=place.name??place.key??place.mergeKey;
    const label=(kinds[place.kind]??place.kind)+(key===undefined?'':' · '+key);
    if(['word','line','cell'].includes(place.kind)){
      const anchor=view.template.anchors.find(anchor=>anchor.id===place.anchor);
      let address='앵커 정보 없음';
      if(anchor?.kind==='word'||anchor?.kind==='line')address='구역 '+(anchor.at.sectionIndex+1)+' · 문단 경로 ['+anchor.at.path.join(', ')+']'+(anchor.kind==='word'?' · 글 위치 '+anchor.start+'~'+anchor.end+' (끝 제외)':'');
      if(anchor?.kind==='cell')address='구역 '+(anchor.table.sectionIndex+1)+' · '+(anchor.table.ordinal+1)+'번째 표 · '+(anchor.row+1)+'행 '+(anchor.col+1)+'열';
      return label+' · 원본의 지정 위치 ('+place.anchor+')\n'+address;
    }
    const block=place.where===undefined?null:view.template.blocks.find(block=>block.id===place.where);
    const occurrence=place.occurrence===undefined?'':' · 같은 키 중 '+(place.occurrence+1)+'번째';
    return label+occurrence+' · '+(place.where===undefined?'원본·선택 블록의 같은 키':(block?.name??place.where)+' 블록만');
  }).join('\n');
}
function render(){
  $('template-info').textContent=(view.template.meta?.name??'템플릿')+' '+view.template.version+'판';
  $('row').max=String(view.rows);$('data-info').textContent=view.rows+'행 중 '+(view.row+1)+'행을 확인하고 있습니다.';
  $('columns').replaceChildren();$('column-list').replaceChildren();
  for(const column of view.columns){const option=document.createElement('option');option.value=column;$('columns').append(option);const p=document.createElement('p');p.textContent=column;$('column-list').append(p);}
  if(!view.columns.length){const p=document.createElement('p');p.className='muted';p.textContent='데이터의 원본 열이 없습니다.';$('column-list').append(p);}
  $('mapping-rows').replaceChildren();
  for(const value of view.template.values){
    const binding=view.template.bindings.find(binding=>binding.value===value.id);
    const draft={mode:binding===undefined?'none':('key' in binding?'key':'path'),entry:binding?.key??binding?.path??'',aliases:binding?.aliases};
    drafts.set(value.id,draft);
    const tr=document.createElement('tr'),name=document.createElement('td'),connection=document.createElement('td'),current=document.createElement('td'),locations=document.createElement('td');
    const label=document.createElement('strong');label.textContent=value.name;const format=document.createElement('small');format.textContent=value.format==='money'?'금액':'글자';name.append(label,format);
    const mode=document.createElement('select');mode.setAttribute('aria-label',value.name+' 연결 방식');
    for(const [key,text] of [['none','연결 없음'],['key','원본 열 이름 그대로'],['path','JSON 중첩 경로']])mode.add(new Option(text,key));
    mode.value=draft.mode;
    const entry=document.createElement('input');entry.type='text';entry.value=draft.entry;entry.setAttribute('aria-label',value.name+' 데이터 연결');entry.setAttribute('list','columns');
    const aliases=document.createElement('small');
    const modeNote=()=>{entry.disabled=mode.value==='none';entry.placeholder=mode.value==='path'?'예: 항목.금액':'원본 열 이름';if(mode.value==='key')entry.setAttribute('list','columns');else entry.removeAttribute('list');aliases.textContent=mode.value==='key'&&draft.aliases?.some(alias=>alias!==draft.entry)?'기존 다른 열 이름도 유지: '+draft.aliases.filter(alias=>alias!==draft.entry).join(' · '):mode.value==='path'?'점은 JSON 안쪽 경로를 구분합니다.':'공백과 점이 있는 열 이름도 그대로 연결합니다.';};
    const edit=()=>{draft.mode=mode.value;draft.entry=entry.value;changed=true;invalidate();modeNote();status('연결을 수정했습니다. 확인한 뒤 새 판으로 보관하세요.');};
    mode.addEventListener('change',edit);entry.addEventListener('input',edit);modeNote();connection.append(mode,entry,aliases);
    current.dataset.value=value.id;const bound=view.values.find(bound=>bound.id===value.id);
    if(bound){const state=document.createElement('small');state.textContent=states[bound.state]??bound.state;current.textContent=bound.issue?.message??bound.text??'';current.append(state);}else current.textContent='확인할 값 없음';
    locations.textContent=placesText(value.id);locations.style.whiteSpace='pre-wrap';
    tr.append(name,connection,current,locations);$('mapping-rows').append(tr);
  }
  if(!view.template.values.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=4;td.className='empty';td.textContent='이 템플릿에는 연결할 값 항목이 없습니다.';tr.append(td);$('mapping-rows').append(tr);}
  $('mapping-note').textContent=changed?'변경한 연결을 임시로 확인했습니다. 새 판 보관을 눌러 파일로 저장하세요.':'현재 템플릿의 연결을 확인했습니다. 원본 데이터는 그대로입니다.';
}
async function evaluate(update=false){
  const ticket=requests.begin();pending=true;ready=false;controls();status(update?'새 연결을 검증해 템플릿 새 판을 만들고 있습니다.':'원본 열과 연결·적용 위치를 확인하고 있습니다.');
  try{
    const input=await requestInput();if(!requests.current(ticket))return;
    const next=await api('mapping/'+(update?'update':'preview'),input);if(!requests.current(ticket))return;
    view=next;drafts.clear();
    if(update){templateDocument=next.document;savedDocument=next.document;changed=false;$('revision-note').textContent='이전 '+next.previous.version+'판에서 '+next.template.version+'판으로 연결만 변경했습니다. 원본 파일은 그대로이며 새 파일을 내려받아 보관하세요.';}
    ready=true;pending=false;render();controls();status(update?'새 템플릿 판을 확인했습니다. JSON을 내려받아 보관하세요.':'현재 행의 연결과 적용 위치를 확인했습니다.');
  }catch(e){if(requests.current(ticket)){pending=false;ready=false;status(e.message,true);controls();}}
}
$('template-file').addEventListener('change',async()=>{
  const ticket=templateLoads.begin(),file=$('template-file').files[0];loadingTemplate=!!file;templateDocument=null;view=null;savedDocument=null;drafts.clear();changed=false;
  invalidate();$('mapping-rows').replaceChildren();$('template-info').textContent='템플릿 확인 전';$('revision-note').textContent='새 템플릿을 확인한 뒤 연결을 수정하세요.';
  if(!file){loadingTemplate=false;controls();return;}
  status('템플릿 파일을 읽고 있습니다.');
  try{const document=await file.text();if(!templateLoads.current(ticket))return;templateDocument=document;loadingTemplate=false;controls();status('템플릿을 불러왔습니다. 데이터를 올리고 연결표를 확인하세요.');}
  catch(e){if(templateLoads.current(ticket)){loadingTemplate=false;status(e.message,true);controls();}}
});
function showXlsx(){
  $('xlsx-options').hidden=xlsx===null;$('data-warnings').replaceChildren();if(xlsx===null)return;
  $('xlsx-sheet').replaceChildren();
  for(const sheet of xlsx.sheets.filter(sheet=>xlsx.sheets.length===1||sheet.index>0)){$('xlsx-sheet').add(new Option((sheet.index+1)+'. '+sheet.name,String(sheet.index)));}
  $('xlsx-sheet').value=String(xlsx.selectedSheet);
  for(const warning of xlsx.warnings){const li=document.createElement('li');li.textContent=warning;$('data-warnings').append(li);}
}
async function loadData(file,sheetIndex){
  const ticket=dataLoads.begin();loadingData=true;dataDocument=null;invalidate();$('data-warnings').replaceChildren();$('columns').replaceChildren();$('column-list').replaceChildren();$('data-info').textContent=sheetIndex===undefined?'데이터 파일을 읽고 있습니다.':(sheetIndex+1)+'번째 시트를 읽고 있습니다.';status('데이터 파일을 읽고 있습니다.');
  try{
    const isXlsx=/\.xlsx$/i.test(file.name),isCsv=/\.csv$/i.test(file.name);
    const content=isXlsx?base64(new Uint8Array(await file.arrayBuffer())):await file.text();if(!dataLoads.current(ticket))return;
    if(isXlsx||isCsv){
      if(isXlsx){
        const listing=await api('xlsx-sheets',{name:file.name,content});if(!dataLoads.current(ticket))return;
        xlsx={file,sheets:listing.sheets,selectedSheet:sheetIndex??(listing.sheets.length>1?1:0),warnings:[]};showXlsx();controls();
      }
      const input={name:file.name,content};if(sheetIndex!==undefined)input.sheetIndex=sheetIndex;
      const imported=await api('import-data',input);if(!dataLoads.current(ticket))return;
      dataDocument=JSON.stringify(imported.records);xlsx=isXlsx?{file,sheets:imported.sheets,selectedSheet:imported.selectedSheet,warnings:imported.warnings??[]}:null;
    }else{dataDocument=content;xlsx=null;}
    loadingData=false;$('row').value='1';$('row').removeAttribute('max');showXlsx();controls();
    $('data-info').textContent=xlsx?(xlsx.selectedSheet+1)+'번째 시트 데이터를 불러왔습니다.':'데이터를 불러왔습니다. 연결표에서 값을 확인하세요.';
    status('데이터 입력을 마쳤습니다. 연결표를 다시 확인하세요.');
  }catch(e){if(dataLoads.current(ticket)){loadingData=false;dataDocument=null;xlsx=xlsx?.file===file?{...xlsx,selectedSheet:sheetIndex??xlsx.selectedSheet,warnings:[]}:null;showXlsx();$('data-info').textContent=xlsx?'이 시트를 읽지 못했습니다. 다른 데이터 시트를 선택하세요.':'데이터를 읽지 못했습니다. 파일을 다시 선택하세요.';status(e.message,true);controls();}}
}
$('data-file').addEventListener('change',()=>{
  const file=$('data-file').files[0];dataLoads.cancel();loadingData=false;xlsx=null;showXlsx();
  if(file)loadData(file);else{dataDocument=null;invalidate();$('data-info').textContent='데이터 파일을 선택하세요.';}
});
$('xlsx-sheet').addEventListener('change',()=>{if(xlsx)loadData(xlsx.file,Number($('xlsx-sheet').value));});
for(const id of ['proto-files','source-files'])$(id).addEventListener('change',()=>{invalidate();status('참조 파일을 변경했습니다. 연결표를 다시 확인하세요.');});
$('row').addEventListener('input',()=>{invalidate();status('데이터 행을 변경했습니다. 연결표를 다시 확인하세요.');});
$('preview').addEventListener('click',()=>evaluate());
$('update').addEventListener('click',()=>evaluate(true));
$('export').addEventListener('click',()=>{
  if($('export').disabled||savedDocument===null)return;
  const url=URL.createObjectURL(new Blob([savedDocument],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='template.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
controls();
