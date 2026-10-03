const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={p:null,draft:null,docs:[],selected:{},output:null,tab:'template',rev:0,urls:[],templateHtml:''};
let blockDraft=[];
function status(message,error=false){$('#status').textContent=message;$('#status').classList.toggle('error',error);}
async function api(path,body){const r=await fetch(`/api/${path}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw new Error(v.error??'요청에 실패했습니다.');return v;}
function action(fn){return async e=>{try{await fn(e);}catch(err){status(err.message,true);}};}
function changed(){state.rev++;state.output=null;$('#download').disabled=true;$('#saved').textContent='저장 전 변경사항';$('#preview-state').textContent='변경됨 · 데이터를 다시 적용하세요';$('#validation').textContent='';$('#recommendations').replaceChildren();if(state.tab!=='template')showPreview();}
function getProject(){state.p.markdown=$('#editor').value;state.p.name=$('#name').value;state.p.selectedBlocks={...state.selected};state.p.activeRecord=Number($('#record').value);return state.p;}
function saveFile(content,name,type='application/json'){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function bytes64(text){return Uint8Array.from(atob(text),c=>c.charCodeAt(0));}
async function file64(file){const bytes=new Uint8Array(await file.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
function setProject(p){state.p=p;state.draft=null;state.docs=[];state.selected=p.selectedBlocks??{};state.output=null;state.rev++;state.tab='template';render();}

function render(){
  const p=state.p;$('#name').value=p.name;$('#editor').value=p.markdown;
  document.querySelectorAll('[name=mode]').forEach(x=>x.checked=x.value===p.mode);
  $('#editor').readOnly=p.mode==='hwpx';
  $('#editor-hint').textContent=p.mode==='hwpx'?'원본 문서의 위치는 Grid와 Anchor+에서 지정합니다.':'변수와 블록을 배치하고, 데이터를 적용하세요.';
  for(const key of ['insert-field','insert-block','make-block'])$('#'+key).disabled=p.mode==='hwpx';
  $('#native-ranges').disabled=p.mode!=='hwpx';
  $('#download').disabled=!state.output;
  $('#records-json').value=JSON.stringify(p.records,null,2);
  const selected=String(p.activeRecord??0);
  $('#record').innerHTML=p.records.map((r,i)=>`<option value="${i}">${i+1}. ${esc(r.사업명??Object.values(r)[0]??'레코드')}</option>`).join('');
  $('#record').value=selected!=='' && p.records[Number(selected)]?selected:'0';
  recordDetail(); renderGroups();renderGrid();lineNumbers();previewTemplate();
  $('#document-strip').textContent=p.mode==='markdown'?'Main Template · Markdown':`Master · ${p.sources[0]?.name??'HWPX를 추가하세요'}`;
  $('#sources').innerHTML=p.sources.map((s,i)=>`<span class="source-tag">${i===0?'Master · ':''}${esc(s.name)}</span>`).join('')+(p.sources.length?'<button id="clear-docs" class="small">문서 비우기</button>':'');
  $('#clear-docs')?.addEventListener('click',()=>{p.sources=[];p.fields=[];p.ranges=[];state.draft=null;state.docs=[];changed();render();});
  refreshProjects();
}
function recordDetail(){const r=state.p.records[Number($('#record').value)]??{};$('#record-detail').innerHTML=Object.entries(r).map(([k,v])=>`<div class="data-pair"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');}
function renderGroups(){
  const groups=[...new Set(state.p.blocks.map(b=>b.group))];
  $('#groups').innerHTML=groups.map(g=>`<div class="group"><label class="group-label" for="group-${esc(g)}">${esc(g)}<small>${state.p.blocks.filter(b=>b.group===g).length} blocks</small></label><select id="group-${esc(g)}" data-group="${esc(g)}"><option value="">조건으로 자동 선택</option>${state.p.blocks.filter(b=>b.group===g).map(b=>`<option value="${esc(b.id)}" ${state.selected[g]===b.id?'selected':''}>${esc(b.alias)}</option>`).join('')}</select></div>`).join('')||'<p class="muted">Block을 추가해 문구를 나누세요.</p>';
  $('#groups').querySelectorAll('select').forEach(el=>el.addEventListener('change',()=>{state.selected[el.dataset.group]=el.value;changed();}));
}
function renderGrid(){
  const fields=state.draft??state.p.fields;
  const columns=[...new Set(state.p.records.flatMap(r=>Object.keys(r)))];
  $('#grid thead th').innerHTML=`<input type="checkbox" id="select-all" aria-label="모든 후보 선택" ${fields.length && fields.every(f=>f.approved)?'checked':''}>`;
  $('#grid tbody').innerHTML=fields.map((f,i)=>`<tr data-row="${i}"><td><input type="checkbox" data-key="approved" aria-label="${esc(f.name)} 확정 선택" ${f.approved?'checked':''}></td><td><input data-key="name" aria-label="Field 이름" value="${esc(f.name)}"></td><td><select data-key="kind" aria-label="후보 종류">${['field','block','fixed'].map(k=>`<option value="${k}" ${f.kind===k?'selected':''}>${{field:'Field',block:'In Template',fixed:'고정 문구'}[k]}</option>`).join('')}</select></td><td>${f.values.map((v,j)=>`<div class="sample-value"><small>문서 ${j+1}</small>${esc(v||'—')}</div>`).join('')}</td><td><input data-key="column" aria-label="DB Column" list="columns" value="${esc(f.column)}" placeholder="열 이름"></td><td><select data-key="format" aria-label="값 형식"><option value="text" ${f.format==='text'?'selected':''}>문자</option><option value="money" ${f.format==='money'?'selected':''}>금액</option></select></td><td class="evidence">${esc(f.evidence)}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">문서를 추가하면 Field 후보가 여기에 나타납니다.</td></tr>';
  let list=$('#columns');if(!list){list=document.createElement('datalist');list.id='columns';document.body.append(list);}list.innerHTML=columns.map(c=>`<option value="${esc(c)}"></option>`).join('');
  $('#candidate-count').textContent=fields.length?`${fields.length}개 후보 · ${state.draft?'확정 대기':'확정된 설정'}`:'문서의 라벨 · 누름틀 · 가변값을 비교합니다.';
  $('#grid tbody').querySelectorAll('input,select').forEach(el=>el.addEventListener('change',()=>{
    if(!state.draft)state.draft=structuredClone(state.p.fields);
    const f=state.draft[Number(el.closest('tr').dataset.row)];f[el.dataset.key]=el.type==='checkbox'?el.checked:el.value;
    changed();$('#candidate-count').textContent=`${state.draft.length}개 후보 · 확정 대기`;
  }));
  $('#select-all').addEventListener('change',e=>{if(!state.draft)state.draft=structuredClone(state.p.fields);state.draft.forEach(f=>f.approved=e.target.checked);changed();renderGrid();});
}
function lineNumbers(){const ed=$('#editor');$('#line-numbers').textContent=Array.from({length:ed.value.split('\n').length},(_,i)=>i+1).join('\n');$('#line-position').textContent=`Line ${ed.value.slice(0,ed.selectionStart).split('\n').length}`;}
let previewTimer;
async function previewTemplate(){const rev=state.rev;try{const result=await api('markdown',{project:getProject()});if(rev!==state.rev)return;state.templateHtml=result.html;showPreview();}catch(e){status(e.message,true);}}
function showPreview(){
  document.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x.dataset.tab===state.tab)));
  $('#markdown-preview').hidden=state.tab==='hwpx';$('#hwpx-preview').hidden=state.tab!=='hwpx';
  if(state.tab==='template')$('#markdown-preview').innerHTML=state.templateHtml;
  if(state.tab==='data')$('#markdown-preview').innerHTML=state.output?(state.output.html??`<p>${esc(state.output.rendered).replace(/\n/g,'<br>')}</p>`):'<div class="empty">데이터를 적용하면 완성된 문서를 표시합니다.</div>';
  if(state.tab==='hwpx'&&!state.output)$('#hwpx-preview').innerHTML='<div class="empty">데이터를 적용하면 생성된 HWPX를 표시합니다.</div>';
}
let rhwpReady;
async function renderHwpx(base64,rev){
  rhwpReady??=import('/rhwp.js').then(async m=>{await m.default({module_or_path:'/rhwp_bg.wasm'});return m;}).catch(e=>{rhwpReady=null;throw e;});
  const {HwpDocument}=await rhwpReady;if(rev!==state.rev)return;
  const doc=new HwpDocument(bytes64(base64));
  try{
    state.urls.forEach(URL.revokeObjectURL);state.urls=[];const box=$('#hwpx-preview');box.replaceChildren();
    const pages=doc.pageCount();
    for(let i=0;i<Math.min(pages,20);i++){
      const svg=doc.renderPageSvg(i);const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));state.urls.push(url);
      const img=document.createElement('img');img.src=url;img.alt=`생성된 HWPX ${i+1}쪽`;box.append(img);
    }
    if(pages>20)box.append(document.createTextNode(`전체 ${pages}쪽 중 첫 20쪽을 표시합니다.`));
    $('#validation').textContent+=` · RHWP ${pages}쪽 렌더 확인 (한컴 조판과 차이 가능)`;
  } finally {doc.free();}
}
async function analyzeDocs(){
  changed();status('문서 구조와 값 차이를 분석하고 있습니다.');
  const rev=state.rev;const r=await api('analyze',{project:getProject()});if(rev!==state.rev)return;
  state.draft=r.fields;state.docs=r.documents;
  if(!state.p.markdown.trim() || state.p.mode==='hwpx')state.p.markdown=r.documents[0]?.lines.map(l=>l.text).join('\n')??'';
  render();status(`${r.fields.length}개 후보를 찾았습니다. 이름·매핑·종류를 확인하고 Grid를 확정하세요.`);
}
async function refreshProjects(){const current=$('#saved-projects').value;const rows=await api('projects');$('#saved-projects').innerHTML='<option value="">저장한 템플릿 선택</option>'+rows.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('');$('#saved-projects').value=current;const revision=$('#helper-revision').value;$('#helper-revision').innerHTML='<option value="">명시적으로 선택하세요</option>'+rows.map(r=>`<option value="${r.id}">${esc(r.name)} · 저장본 ${r.id}</option>`).join('');$('#helper-revision').value=revision;await refreshHelperProfiles();}
let helperProfiles=[];
async function refreshHelperProfiles(){const current=$('#helper-profiles').value;const result=await api('g2b/profiles');helperProfiles=result.profiles;$('#helper-profiles').innerHTML='<option value="">새 프로필</option>'+helperProfiles.map(p=>`<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.id)})</option>`).join('');$('#helper-profiles').value=current;}
$('#helper-profiles').onchange=()=>{const p=helperProfiles.find(p=>p.id===$('#helper-profiles').value);$('#helper-profile-id').value=p?.id??'';$('#helper-profile-label').value=p?.label??'';$('#helper-output-directory').value=p?.outputDirectory??'';const revision=$('#helper-revision');if(p&&!Array.from(revision.options).some(o=>o.value===String(p.revisionId))){const option=document.createElement('option');option.value=String(p.revisionId);option.textContent=`기존 프로필 저장본 ${p.revisionId}`;revision.append(option);}revision.value=p?String(p.revisionId):'';};
$('#save-helper-profile').onclick=action(async()=>{if(!$('#helper-revision').value)throw new Error('저장된 프로젝트를 명시적으로 선택하세요.');const {profile}=await api('g2b/profiles',{id:$('#helper-profile-id').value.trim(),label:$('#helper-profile-label').value.trim(),revisionId:Number($('#helper-revision').value),outputDirectory:$('#helper-output-directory').value.trim()});await refreshHelperProfiles();$('#helper-profiles').value=profile.id;$('#helper-profile-status').textContent=`${profile.label} · 저장본 ${profile.revisionId} · ${profile.outputDirectory}`;status('Helper 생성 프로필을 저장했습니다. Helper 문서 설정에서 이 프로필을 선택하세요.');});
function insert(text){const ed=$('#editor');ed.setRangeText(text,ed.selectionStart,ed.selectionEnd,'end');getProject();changed();lineNumbers();previewTemplate();ed.focus();}

$('#editor').addEventListener('input',()=>{getProject();changed();lineNumbers();clearTimeout(previewTimer);previewTimer=setTimeout(previewTemplate,220);});
$('#editor').addEventListener('click',lineNumbers);$('#editor').addEventListener('keyup',lineNumbers);$('#editor').addEventListener('scroll',()=>$('#line-numbers').scrollTop=$('#editor').scrollTop);
$('#name').addEventListener('input',()=>{getProject();changed();});
$('#record').addEventListener('change',()=>{state.p.activeRecord=Number($('#record').value);changed();recordDetail();});
document.querySelectorAll('[name=mode]').forEach(el=>el.addEventListener('change',()=>{getProject();state.p.mode=el.value;changed();render();status(el.value==='hwpx'?'원본 HWPX를 첫 번째 문서로 추가하세요. 예시 비교로도 시험할 수 있습니다.':'Markdown 템플릿을 작성하거나 비교 후보를 확정하세요.');}));
document.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click',()=>{state.tab=el.dataset.tab;showPreview();}));
$('#new').onclick=action(async()=>{const p=await api('demo');p.name='새 템플릿';p.markdown='# {{제목}}\n\n{{본문}}';p.blocks=[];p.records=[{제목:'새 문서',본문:'내용을 입력하세요.'}];setProject(p);status('새 템플릿을 시작했습니다. 이전 저장본은 목록에서 다시 열 수 있습니다.');});
$('#save').onclick=action(async()=>{if(state.draft)throw new Error('Grid 수정사항을 먼저 확정하세요.');await api('save',{project:getProject()});$('#saved').textContent='SQLite에 저장됨';await refreshProjects();status('프로젝트와 데이터가 이 PC의 SQLite에 저장되었습니다. 이전 저장 이력도 보관합니다.');});
$('#load').onclick=action(async()=>{if(!$('#saved-projects').value)throw new Error('저장한 템플릿을 선택하세요.');setProject(await api(`project?id=${$('#saved-projects').value}`));status('저장한 프로젝트를 불러왔습니다.');});
$('#export').onclick=()=>saveFile(JSON.stringify(getProject(),null,2),'template.studio.json');
$('#project-file').onchange=action(async e=>{const file=e.target.files[0];if(!file)return;const p=JSON.parse(await file.text());await api('markdown',{project:p});setProject(p);status('프로젝트 JSON을 불러왔습니다.');e.target.value='';});
$('#update-records').onclick=action(async()=>{const r=await api('import-data',{name:'records.json',content:$('#records-json').value});state.p.records=r.records;changed();render();status(`${r.records.length}개 레코드를 반영했습니다.`);});
$('#data-file').onchange=action(async e=>{const f=e.target.files[0];if(!f)return;const r=await api('import-data',{name:f.name,content:/\.xlsx$/i.test(f.name)?await file64(f):await f.text()});state.p.records=r.records;changed();render();if(state.p.sources.length)await analyzeDocs();status(`${r.records.length}개 레코드 입력 완료${/\.xlsx$/i.test(f.name)?' · 첫 번째 시트, 날짜는 Excel 원시값':''}`);e.target.value='';});
$('#documents').onchange=action(async e=>{for(const f of e.target.files){if(f.size>10*1024*1024)throw new Error('문서 하나당 10MB 이내로 선택하세요.');state.p.sources.push({id:crypto.randomUUID(),name:f.name,kind:/\.hwpx$/i.test(f.name)?'hwpx':'md',content:/\.hwpx$/i.test(f.name)?await file64(f):await f.text()});}state.p.fields=[];state.p.ranges=[];await analyzeDocs();e.target.value='';});
$('#example-compare').onclick=action(async()=>{state.p.sources=await api(state.p.mode==='hwpx'?'demo-native':'demo-sources',state.p.mode==='hwpx'?{}:undefined);state.p.fields=[];state.p.ranges=[];state.p.blocks=[];state.p.records=[{사업명:'서버 구매',예정금액:120000000,계약방법:'제한경쟁',납품장소:'본관 전산실'},{사업명:'모니터 구매',예정금액:35000000,계약방법:'일반경쟁',납품장소:'본관 회의실'}];await analyzeDocs();});
$('#confirm').onclick=action(async()=>{if(!state.draft)throw new Error('문서를 분석하거나 Grid를 먼저 수정하세요.');const p=structuredClone(getProject());p.fields=state.draft;state.p=await api('confirm',{project:p});state.draft=null;changed();render();status('Grid를 확정했습니다. 레코드와 Block을 선택한 뒤 데이터를 적용하세요.');});
$('#merge-fields').onclick=action(async()=>{const fields=state.draft??structuredClone(state.p.fields);const chosen=fields.filter(f=>f.approved);if(chosen.length<2)throw new Error('병합할 후보를 2개 이상 체크하세요.');const first=chosen[0];first.targets=chosen.flatMap(f=>f.targets);first.evidence='사용자가 후보 병합 · '+first.evidence;state.draft=fields.filter(f=>!chosen.includes(f)||f===first);changed();renderGrid();status(`선택한 후보를 '${first.name}'으로 병합했습니다. 같은 DB 값으로 채워집니다. Grid를 확정하세요.`);});
$('#schema').onclick=action(async()=>{if(state.draft)throw new Error('Grid를 먼저 확정하세요.');const r=await api('schema',{project:getProject()});if(!Object.keys(r.schema.properties).length)throw new Error('확정된 Field가 없습니다.');saveFile(JSON.stringify(r,null,2),'schema-and-records.json');state.p.records=r.records;changed();render();status('Schema와 샘플 레코드를 내보내고 데이터 선택에 반영했습니다. 저장하면 SQLite에 보관됩니다.');});
$('#apply').onclick=action(async()=>{
  if(state.draft)throw new Error('문서 분석 결과를 Grid에서 먼저 확정하세요.');
  $('#apply').disabled=true;status('블록 적용 · 값 주입 · HWPX 생성 · 검증 중입니다.');
  const rev=state.rev;
  try{const result=await api('apply',{project:getProject(),index:Number($('#record').value),selected:state.selected});if(rev!==state.rev)return;
    state.output=result;state.tab='data';$('#download').disabled=false;$('#preview-state').textContent='적용된 데이터';
    $('#recommendations').innerHTML=result.recommendations.map(r=>`<div class="recommendation"><strong>${esc(r.group)} / ${esc(r.alias)}</strong><small>${esc(r.reason)}</small></div>`).join('');
    $('#validation').textContent=`HWPX 재파싱 완료 · 새 오류 ${result.validation.newErrors} · 기존 오류 ${result.validation.errors} · 경고 ${result.validation.warnings}`;
    showPreview();status('데이터 적용과 HWPX 생성이 완료되었습니다. HWPX 탭에서 실제 출력 형태를 확인하세요.');
    try{await renderHwpx(result.output,rev);}catch(e){if(rev===state.rev){$('#hwpx-preview').textContent=`렌더 실패: ${e.message}`;status('파일 생성·검증은 완료됐지만 HWPX 렌더에 실패했습니다. 다운로드 후 확인하세요.',true);}}
  }finally{$('#apply').disabled=false;}
});
$('#download').onclick=()=>{if(state.output)saveFile(bytes64(state.output.output),`${state.p.name.replace(/[<>:"/\\|?*]/g,'_')}.hwpx`,'application/hwp+zip');};
$('#insert-field').onclick=()=>insert('{{새필드}}');
$('#insert-block').onclick=()=>insert(`[IN_TEMPLATE:${state.p.blocks[0]?.group??'qualification'}]`);
$('#make-block').onclick=action(async()=>{const ed=$('#editor');const text=ed.value.slice(ed.selectionStart,ed.selectionEnd);if(!text)throw new Error('Markdown에서 Block으로 만들 범위를 선택하세요.');const group=`block${state.p.blocks.length+1}`;state.p.blocks.push({id:crypto.randomUUID(),group,alias:'선택한 문단',engine_type:'markdown',condition:'',priority:0,content:text});insert(`[IN_TEMPLATE:${group}]`);renderGroups();status(`선택 범위를 ${group} Block으로 만들었습니다.`);});

function openBlocks(){blockDraft=structuredClone(state.p.blocks);renderBlockEditors();$('#blocks-dialog').showModal();}
function renderBlockEditors(){
  $('#block-editors').innerHTML=blockDraft.map((b,i)=>`<section class="block-editor" data-i="${i}"><div class="block-meta"><label>Group<input data-k="group" value="${esc(b.group)}"></label><label>별칭<input data-k="alias" value="${esc(b.alias)}"></label><label>내용 형식<select data-k="engine_type"><option value="markdown" ${b.engine_type==='markdown'?'selected':''}>Markdown</option><option value="hwpx_fragment" ${b.engine_type==='hwpx_fragment'?'selected':''}>HWPX Fragment</option></select></label><label>우선순위<input data-k="priority" type="number" value="${b.priority}"></label><button class="danger" data-remove="${i}">삭제</button></div><label class="block-condition">조건<input data-k="condition" value="${esc(b.condition)}" placeholder="비워 두면 기본 Block"></label><textarea data-k="content" rows="4" aria-label="${esc(b.alias)} 내용" ${b.engine_type==='hwpx_fragment'?'readonly':''}>${esc(b.content)}</textarea>${b.engine_type==='hwpx_fragment'?`<p>원본 ${esc(state.p.sources.find(s=>s.id===b.sourceId)?.name??'없음')} · 문단 ${b.from??'?'}~${b.to??'?'} · 변경은 Anchor+ 설정에서 등록</p>`:''}</section>`).join('')||'<p class="empty">아직 Block이 없습니다.</p>';
  $('#block-editors').querySelectorAll('[data-k]').forEach(el=>el.onchange=()=>{blockDraft[Number(el.closest('[data-i]').dataset.i)][el.dataset.k]=el.dataset.k==='priority'?Number(el.value):el.value;});
  $('#block-editors').querySelectorAll('[data-remove]').forEach(el=>el.onclick=()=>{blockDraft.splice(Number(el.dataset.remove),1);renderBlockEditors();});
}
$('#edit-blocks').onclick=openBlocks;
$('#add-block').onclick=()=>{state.p.blocks.push({id:crypto.randomUUID(),group:'new_group',alias:'새 블록',engine_type:'markdown',condition:'',priority:0,content:'블록 내용을 작성하세요.'});changed();renderGroups();openBlocks();};
$('#save-blocks').onclick=action(async()=>{const p={...getProject(),blocks:blockDraft};await api('markdown',{project:p});state.p=p;state.selected={};changed();renderGroups();$('#blocks-dialog').close();status('Block과 조건을 반영했습니다.');});
document.querySelectorAll('[data-close]').forEach(el=>el.onclick=()=>el.closest('dialog').close());
function rangeParagraphs(){const d=state.docs.find(d=>d.id===$('#range-source').value);$('#paragraph-list').textContent=d?.paragraphs.map(p=>`${p.number}  ${p.text}`).join('\n')??'HWPX 문서를 추가하세요.';$('#range-list').innerHTML=state.p.ranges.map((r,i)=>`<div>${esc(r.group)} · Master 문단 ${r.from}~${r.to} <button class="small" data-remove-range="${i}">해제</button></div>`).join('');$('#range-list').querySelectorAll('[data-remove-range]').forEach(el=>el.onclick=()=>{state.p.ranges.splice(Number(el.dataset.removeRange),1);changed();rangeParagraphs();});}
$('#native-ranges').onclick=action(async()=>{if(!state.p.sources.some(s=>s.kind==='hwpx'))throw new Error('HWPX 문서를 먼저 불러오세요.');if(!state.docs.length){const r=await api('analyze',{project:getProject()});state.docs=r.documents;}$('#range-source').innerHTML=state.p.sources.filter(s=>s.kind==='hwpx').map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');rangeParagraphs();$('#range-dialog').showModal();});
$('#range-source').onchange=rangeParagraphs;
function rangeInput(){const from=Number($('#range-from').value),to=Number($('#range-to').value),sourceId=$('#range-source').value,group=$('#range-group').value.trim();const doc=state.docs.find(d=>d.id===sourceId);if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to<from||to>doc.paragraphs.length)throw new Error('시작·끝 문단 번호를 확인하세요.');if(!group)throw new Error('Group을 입력하세요.');return{from,to,sourceId,group,id:crypto.randomUUID()};}
$('#capture-range').onclick=action(async()=>{const r=rangeInput();const d=state.docs.find(d=>d.id===r.sourceId);state.p.blocks.push({...r,alias:$('#range-alias').value,engine_type:'hwpx_fragment',condition:'',priority:0,content:d.paragraphs.slice(r.from-1,r.to).map(p=>p.text).join('\n')});changed();renderGroups();status('선택한 원본 범위를 Fragment Block으로 등록했습니다.');});
$('#slot-range').onclick=action(async()=>{const r=rangeInput();if(r.sourceId!==state.p.sources[0]?.id)throw new Error('Anchor+는 Master 문서에 등록하세요.');state.p.ranges.push(r);changed();rangeParagraphs();status('Master의 교체 범위를 Anchor+로 등록했습니다.');});

try{setProject(await api('demo'));status('예시가 준비되었습니다. 레코드와 Block을 선택한 뒤 [데이터 적용]을 누르세요.');}catch(e){status(e.message,true);}
