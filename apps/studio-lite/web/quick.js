import { createPageView, createLatest, defaultDraftIndex } from '/packages/viewer/src/dom/index.ts';
import { loadRhwp, openDocument } from '/packages/viewer/src/rhwp/index.ts';
const $=id=>document.getElementById(id);
const state={session:null,places:null,data:null,assignments:[],selection:null,draft:-1,view:null,doc:null,original:true,busy:false};
const documents=createLatest(),dataLoads=createLatest(),picks=createLatest(),views=createLatest();
const SHAPES={object:'안에 그림·표가 있음',crossContainer:'표 칸 경계를 넘음',unpaired:'끝 표식 없음',crossBlocked:'여러 문단 경계 때문에 채울 수 없음'};
const KINDS={field:'누름틀',word:'낱말 / 선택 범위',cell:'셀',line:'문단 전체'};
const CANDIDATES={emptyCell:'라벨 옆 빈 칸',labelColon:'라벨: 뒤 빈 곳',blankMark:'빈칸 표시'};
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;}
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function failed(e){status(e.message??String(e),true);}
async function api(path,body){const r=await fetch(`/api/quick/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw new Error(`${v.plain??v.error??'요청 실패'}${v.code?` (${v.code})`:''}`);return v;}
function table(node,head,rows){const h=el('thead'),tr=el('tr');head.forEach(t=>tr.append(el('th',t)));h.append(tr);const b=el('tbody');rows.forEach(row=>{const r=el('tr');row.forEach(c=>{const d=el('td');d.append(c instanceof Node?c:String(c));r.append(d);});b.append(r);});node.replaceChildren(h,b);}
function controls(){
  $('quick-document').disabled=state.busy;
  $('quick-data').disabled=!state.session||state.busy;
  $('generate').disabled=!state.data||state.busy;
  $('original').disabled=!state.session||state.busy;
  const draft=state.selection?.location.drafts[state.draft];
  $('assign').disabled=state.busy||!state.original||!draft||!!draft.blocked||!$('mapping').value;
  $('mapping').disabled=state.busy||!state.data;
  $('cancel-selection').disabled=!state.selection;
  document.querySelectorAll('[data-clear]').forEach(b=>b.disabled=state.busy);
}
function invalidate(){ $('results-box').hidden=true;$('results').replaceChildren(); }
function marks(){
  if(!state.original)return;
  const out=state.assignments.filter(a=>a.mark).map(a=>({id:a.id,kind:'assigned',...a.mark}));
  const draft=state.selection?.location.drafts[state.draft];
  if(draft?.mark)out.push({id:'chosen',kind:'chosen',...draft.mark});
  state.view?.setMarks(out);
}
function cancelSelection(){picks.cancel();state.selection=null;state.draft=-1;$('drafts').replaceChildren();$('location').textContent='문서에서 자리를 선택하세요.';marks();controls();}
function showDrafts(response){
  state.selection=response;state.draft=defaultDraftIndex(response.location.drafts)??-1;
  const l=response.location;$('location').textContent=l.address?`구역 ${l.address.sectionIndex} · 문단 [${l.address.path.join(', ')}]${l.address.offset===undefined?'':` · 오프셋 ${l.address.offset}`} · ${l.precision==='char'?'글자 위치':'문단 위치'}${l.reason?` (${l.reason})`:''}`:`선택 위치를 확인하지 못했습니다. ${l.reason??''}`;
  $('drafts').replaceChildren();
  l.drafts.forEach((d,i)=>{const label=el('label');const radio=el('input');radio.type='radio';radio.name='draft';radio.value=String(i);radio.checked=state.draft===i;radio.disabled=!!d.blocked;label.append(radio,el('span',KINDS[d.anchor.kind]??d.anchor.kind));if(d.blocked)label.append(el('small',`주입 차단: ${d.blocked}`));radio.addEventListener('change',()=>{state.draft=i;marks();controls();});$('drafts').append(label);});
  marks();controls();
}
async function onPick(e){
  if(!state.original||state.busy||!state.session)return;
  cancelSelection();const ticket=picks.begin();const session=state.session;
  if(e.limit==='none'||(!e.hit.position&&!e.cell)){$('location').textContent=`이 위치는 지정할 수 없습니다. ${e.reason??''}`;return;}
  const from=e.cell?{cell:e.cell}:{position:e.hit.position};
  if(!e.cell){if(e.shown)from.shown=e.shown;if(e.guide&&e.guideText!==undefined)from.guide=e.guideText;if(e.trailing)from.trailing=true;if(e.limit==='paragraph')from.limit='paragraph';if(e.reason)from.reason=e.reason;}
  const request={from};if(e.to){request.to={position:e.to.position};if(e.to.shown)request.to.shown=e.to.shown;if(e.to.limit==='paragraph')request.to.limit='paragraph';if(e.to.reason)request.to.reason=e.to.reason;}
  $('location').textContent='선택한 위치를 확인하는 중입니다.';
  try{const response=await api('locate',{session,request});if(picks.current(ticket)&&session===state.session)showDrafts(response);}catch(e){if(picks.current(ticket))failed(e);}
}
async function showDocument(url,original,title){
  const ticket=views.begin();cancelSelection();state.original=false;controls();
  await loadRhwp({wasmUrl:'/vendor/rhwp/rhwp_bg.wasm'});
  if(!views.current(ticket))return;
  const r=await fetch(url);if(!r.ok)throw new Error('미리 볼 문서를 찾지 못했습니다.');
  const bytes=new Uint8Array(await r.arrayBuffer());if(!views.current(ticket))return;
  const doc=openDocument(bytes);
  state.view?.destroy();state.doc?.free();state.view=null;state.doc=null;
  try{state.view=createPageView({container:$('pages'),doc,scale:Number($('scale').value),onPick,onError:failed});state.doc=doc;}catch(e){doc.free();throw e;}
  state.original=original;$('viewer-title').textContent=title;marks();controls();
}
const fieldKind=f=>f?.mailMerge?(f.mailMerge===f.count?'메일머지':'누름틀·메일머지'):'누름틀';
function renderPlaces(t){
  $('document-info').textContent=`${t.name} · ${t.bytes.toLocaleString()}바이트`;
  const box=$('places');box.replaceChildren();
  const list=(title,items)=>{box.append(el('h3',`${title} ${items.length}개`));const u=el('ul');items.forEach(text=>u.append(el('li',text)));box.append(items.length?u:el('p','없음','muted'));};
  list('누름틀·메일머지',t.places.fields.map(f=>`${fieldKind(f)} ${f.name||'(이름 없음)'} · ${f.count}곳${f.mailMerge?` (메일머지 ${f.mailMerge} · 누름틀 ${f.count-f.mailMerge})`:''}${f.usable?'':' · 데이터 경로로 쓸 수 없는 이름'}${f.merging?` · ${f.merging}곳은 문단 합침`:''}${f.unfillable.length?` · 채우지 못함: ${f.unfillable.map(u=>`${SHAPES[u.shape]} ${u.count}곳${u.reasons?` (${u.reasons.join(' ')})`:''}`).join(', ')}`:''}`));
  list('{{키}}',t.places.placeholders.map(p=>`{{${p.key}}} · ${p.count}곳`));
  list(`빈칸 후보${t.places.candidatesTruncated?' (앞 200개)':''}`,t.places.candidates.map(c=>`${CANDIDATES[c.kind]}: ${c.evidence}`));
}
function renderAssignments(){
  const box=$('assignments');box.replaceChildren();
  if(!state.assignments.length)box.append(el('p','연결한 자리가 없습니다.','muted'));
  state.assignments.forEach(a=>{const row=el('div');row.append(el('strong',`${KINDS[a.anchor.kind]} → ${a.path}`));const clear=el('button','지정 해제','small');clear.dataset.clear=a.id;
    clear.addEventListener('click',async()=>{state.busy=true;invalidate();cancelSelection();controls();try{const response=await api('clear',{session:state.session,id:a.id});state.assignments=response.assignments;renderAssignments();marks();status('지정을 해제했습니다. 원본 글은 그대로입니다.');}catch(e){failed(e);}finally{state.busy=false;controls();}});row.append(el('br'),clear);box.append(row);});
  controls();
}
function renderData(d){
  $('data-info').textContent=`${d.records}건 · 객체가 아닌 건 ${d.invalidRecords}건${d.truncated?' · 경로 앞 1,000개':''}`;
  const select=$('mapping');select.replaceChildren(el('option','연결할 경로 선택'));select.firstChild.value='';
  d.keys.filter(k=>k.usable&&!['object','array'].includes(k.type)).forEach(k=>{const o=el('option',`${k.path} (${k.type})`);o.value=k.path;select.append(o);});
  $('keys').replaceChildren();d.keys.forEach(k=>$('keys').append(el('p',`${k.path} · ${k.type} · ${k.records}건${k.usable?'':' · 경로 연결 불가'}`)));
  const labels={ok:'데이터 있음',missing:'데이터 없음 / null',notScalar:'객체·배열',rejected:'값 문자 차단',badKey:'데이터 경로로 쓸 수 없는 이름',unfillable:'채울 수 없는 필드'};
  table($('matches'),['자리 / 경로','연결 확인'],d.matches.map(m=>{const field=state.places.fields.find(f=>f.name===m.key);const shape=m.state==='unfillable'?(field?.unfillable??[]).map(u=>SHAPES[u.shape]).join(', '):'';return [`${m.kind==='field'?fieldKind(field):'{{키}}'}: ${m.key}`,`${labels[m.state]}${shape?` (${shape})`:''} · 맞음 ${m.counts.ok} / 누락 ${m.counts.missing}${m.reason?` (${m.reason})`:''}${m.multiline?' · 줄바꿈/탭 유지':''}`];}));
}
function entryList(entries){const ul=el('ul');entries.forEach(e=>{const li=el('li',`${e.place?`[${e.place}] `:''}${e.plain} (${e.code})`);if(e.detail)li.append(el('p',e.detail,'muted'));ul.append(li);});return entries.length?ul:'-';}
function renderResults(g){
  $('results-box').hidden=false;
  const count=g.results.filter(r=>r.ok).length;status(`${g.results.length}건 중 생성 ${count}건 · 실패 ${g.results.length-count}건`,count<g.results.length);
  table($('results'),['건','결과 / 채운 자리','건너뜀','오류','알림','파일'],g.results.map(r=>{const file=el('div');if(r.ok){const link=el('a','내려받기');link.href=`/api/quick/result?session=${g.session}&index=${r.index}`;file.append(link);const view=el('button','미리보기','small');view.addEventListener('click',()=>showDocument(link.href,false,`생성물 · ${r.index+1}번째 건 (읽기 전용)`).catch(failed));file.append(el('br'),view);}return [String(r.index+1),el('span',`${r.ok?'성공':'실패'} · ${r.filled}곳`,r.ok?'ok':'bad'),entryList(r.skipped),entryList(r.errors),entryList(r.notes),file];}));
}
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);}
$('quick-document').addEventListener('change',async()=>{
  const file=$('quick-document').files?.[0];if(!file)return;
  const ticket=documents.begin();dataLoads.cancel();views.cancel();cancelSelection();invalidate();state.session=null;state.data=null;state.assignments=[];
  state.view?.destroy();state.doc?.free();state.view=null;state.doc=null;$('pages').replaceChildren();$('places').replaceChildren();$('matches').replaceChildren();$('keys').replaceChildren();$('quick-data').value='';$('data-info').textContent='JSON 데이터를 선택하세요.';
  $('mapping').replaceChildren(el('option','데이터를 먼저 올리세요'));renderAssignments();controls();status('문서를 읽는 중…');
  try{const content=base64(new Uint8Array(await file.arrayBuffer()));if(!documents.current(ticket))return;const t=await api('template',{content,name:file.name});if(!documents.current(ticket))return;state.session=t.session;state.places=t.places;renderPlaces(t);controls();await showDocument(`/api/quick/source?session=${t.session}`,true,'원본 문서');if(documents.current(ticket))status('문서를 열었습니다. JSON 데이터를 올리세요.');}catch(e){if(documents.current(ticket))failed(e);}
});
$('quick-data').addEventListener('change',async()=>{
  const file=$('quick-data').files?.[0],session=state.session;if(!file||!session||state.busy)return;
  state.busy=true;
  const ticket=dataLoads.begin();state.data=null;invalidate();cancelSelection();controls();status('데이터를 읽는 중…');
  try{const content=await file.text();if(!dataLoads.current(ticket)||session!==state.session)return;const d=await api('data',{session,content});if(!dataLoads.current(ticket)||session!==state.session)return;state.data=d;renderData(d);controls();status('대조표를 확인하고, 필요하면 문서에서 자리를 선택해 연결하세요.');}catch(e){if(dataLoads.current(ticket)&&session===state.session)failed(e);}finally{state.busy=false;controls();}
});
$('assign').addEventListener('click',async()=>{
  if(!state.selection||state.draft<0||state.busy)return;
  const input={session:state.session,selection:state.selection.selection,draft:state.draft,path:$('mapping').value};
  state.busy=true;invalidate();cancelSelection();controls();
  try{const r=await api('assign',input);state.assignments=r.assignments;renderAssignments();marks();status('선택한 엔진 위치에 데이터 경로를 연결했습니다.');}catch(e){failed(e);}finally{state.busy=false;controls();}
});
$('generate').addEventListener('click',async()=>{
  if(!state.data||state.busy)return;
  state.busy=true;invalidate();cancelSelection();controls();status('생성·재검사 중…');
  try{renderResults(await api('generate',{session:state.session,missing:$('missing').value}));}catch(e){failed(e);}finally{state.busy=false;controls();}
});
$('cancel-selection').addEventListener('click',cancelSelection);
document.addEventListener('keydown',e=>{if(e.key==='Escape'){cancelSelection();status('선택을 취소했습니다. 연결한 지정과 원본 글은 유지됩니다.');}});
$('mapping').addEventListener('change',controls);
$('scale').addEventListener('change',()=>state.view?.setScale(Number($('scale').value)));
$('original').addEventListener('click',()=>showDocument(`/api/quick/source?session=${state.session}`,true,'원본 문서').catch(failed));
window.addEventListener('pagehide',()=>{state.view?.destroy();state.doc?.free();});
controls();