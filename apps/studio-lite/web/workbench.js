import {viewerLines, lineAt} from '/viewer-lines.js';
import { installBlockLibrary } from '/block-library.js';
import {editorLayout, editorSelection, unitAt, replaceEditorText, groupEditorSelection, editorChange} from '/editor-model.js';
import { createPageView, createLatest, toPagePoint } from '/packages/viewer/src/dom/index.ts';
import {STATUS_LABEL, REL_LABEL, LABEL_MAX, isField, keptStatus, autoKey, repsOf, changedSpan, toOriginal, spanNow, contextOf, contextAround, mergeSaved, nameFromLabel, designated, rankKeys, planConfirm, dropRow, commitConfirm, linkNote, rowAria, itemOf, valueKey, linkTargets} from '/input-table.js';
import {VALUE_TYPES, TYPE_LABEL, suggestType} from '/value-type.js';
import { loadRhwp, openDocument, runPosition, sameParagraph } from '/packages/viewer/src/rhwp/index.ts';
import {FLAG_WAIT, flagRequest, flagRefusal, spanLabel} from '/range-flag.js';

const $ = (selector) => document.querySelector(selector);
const state = {
  placements: [], placementNames: {}, placementWarnings: {},
  outline: [], recommendations: [], reviewHistory: [], samples: {}, tableOpen: false, tableRow: undefined, detailDrafts: new Map(), detailId: undefined, pointer: undefined, currentItem: undefined,
  session: undefined, kind: 'hwpx', sourceText: '', name: '', paragraphs: [], edits: new Map(), headings: new Map(), blocks: [],
  keys: [], records: 0, index: 0, cases: [], typed: {}, chosen: undefined, selection: undefined,
  sourceDoc: undefined, resultDoc: undefined, view: undefined, viewMode: 'source', output: undefined,
  busy: false, dirty: false, caret: undefined,
  comparison: undefined, comparisonText: '', layout: {text: '', units: []}, history: [], future: [],
  marks: new Map(), invalidations: Promise.resolve(), revision: 0, openTicket: 0,
};
const opens = createLatest(), picks = createLatest(), views = createLatest(), dataLoads = createLatest();
const keyCopies = createLatest(), bodyCopies = createLatest(), samples = createLatest();
let resizeFrame, contextRequest = 0;
const blockLibraryUI = installBlockLibrary({selection: blockSelection, session: () => state.session, api, status, beforeOpen: hideMenu, previewPlacement, currentUsage:item=>state.placements.some(p=>p.id===item.protoId||p.id===item.id)?'현재 작업에서 사용 중입니다. 배치를 취소한 뒤 다시 확인하세요.':undefined, onSaved:()=>{const r=state.activeRecommendation;if(r?.kind==='block'){r.status='confirmed';renderRecommendations();}void renderLibraryTab();}});

function status(text, kind = '') {
  $('#status').textContent = text; $('#status').className = kind; $('#status').title = text;
}
function setBusy(value, message) {
  state.busy = value;
  document.body.classList.toggle('busy', value);
  $('.workspace').setAttribute('aria-busy', String(value));
  if (message) status(message);
  controls();
}
function paragraph(id) { return state.paragraphs.find((item) => item.id === id); }
function textOf(item) { return state.edits.get(item.id) ?? item.text; }

function controls() {
  const available=Boolean(state.session)&&!state.busy, item=paragraph(state.chosen), canEdit=available&&item?.editable;
  for(const id of ['open-document','empty-open','load-work']) {const button=$('#'+id);if(button)button.disabled=state.busy;}
  $('#open-comparison').disabled=!available;
  for(const id of ['save-work','generate','open-data','load-data-text']) $('#'+id).disabled=!available;
  $('#record-select').disabled=!available||!state.records;
  $('#txt-result-view').disabled=!state.output||state.busy;$('#source-view').disabled=!available; $('#result-view').disabled=!state.output||state.busy;
  $('#comparison-view').disabled=!available;
  for(const id of ['scale','zoom-in','zoom-out']) $('#'+id).disabled=!available;
  $('#key-select').disabled=!available; $('#make-template').disabled=!available||state.kind!=='hwpx';
  $('#save-g2b-template').disabled=!available||state.kind!=='hwpx';$('#save-profile').disabled=!available||!state.g2bTemplate;
  for(const b of document.querySelectorAll('#profile-list button'))b.disabled=!available||b.dataset.recheck==='true'&&state.kind!=='hwpx';
  $('#copy-body').disabled=state.busy||typeof state.output?.text!=='string';
  $('#copy-body').title=state.busy?'문서 처리가 끝난 뒤 복사하세요.':!state.session?'문서를 먼저 여세요.':!state.output?'현재 업무 건과 편집 내용으로 다시 생성한 뒤 복사하세요.':'';
  $('#document-editor').disabled=!state.session; $('#document-editor').readOnly=state.busy;
  $('#undo').disabled=!available||!state.history.length; $('#redo').disabled=!available||!state.future.length;
  for(const button of document.querySelectorAll('[data-action]')) {
    const name=button.dataset.action;
    // 깃발은 원문에서 누른 점이 있어야 한다(편집 글·목록에서 고른 것은 점이 없다)
    if(name==='flagStart'||name==='flagEnd'){const point=currentPick()?.point;button.disabled=!available||!point||name==='flagEnd'&&!state.flag;button.title=!button.disabled?'':!point?'원문에서 자리를 먼저 누르세요.':'시작 깃발을 먼저 찍으세요.';continue;}
    if(name==='labelPick'){const target=labelTarget();button.disabled=!available||!target;button.textContent='참고 글 지정'+(target?' · '+(target.name.trim()||'이름 없음').slice(0,10):'');
      button.title=target?'선택한 글을 '+(target.name.trim()||'이름 없는')+' 항목의 라벨(참고 글)로 씁니다.':'입력 항목을 지정하거나 표에서 고른 뒤, 라벨로 쓸 다른 글을 고르세요.';continue;}
    button.disabled=name==='copyKey'?!available||!$('#key-select').value.trim():name==='importSelection'?!canEdit||!state.comparisonText:name==='copySelection'?!available:name==='dataDetail'?!available||!(canEdit||state.activeRecommendation?.kind==='input'):!canEdit;
    button.dataset.actionTitle??=button.title;
    button.title=button.disabled?(state.busy?'문서 처리가 끝난 뒤 사용하세요.':!state.session?'문서를 먼저 여세요.':!item?'문서에서 부분을 먼저 고르세요.':!item.editable?'표·개체 또는 보호된 서식이 있는 문단은 직접 편집할 수 없습니다.':name==='importSelection'?'비교 문서에서 가져올 글을 선택하세요.':'입력 항목 이름을 먼저 적으세요.'):button.dataset.actionTitle;
  }
  for(const check of document.querySelectorAll('.rec-line input'))check.disabled=state.busy||check.dataset.confirmed==='true';
  $('#save-checked-blocks').disabled=state.busy||!state.recommendations.some(r=>r.kind==='block'&&r.status==='recommended');
  $('#open-input-table').disabled=!state.session||state.busy;$('#confirm-all').disabled=state.busy;for(const id of ['designate-input','remote-designate'])$('#'+id).disabled=!available;
  for(const b of document.querySelectorAll('#input-rows .ok-button'))b.disabled=state.busy||b.dataset.locked==='true';
  blockLibraryUI.refresh();
  if(state.kind==='text')for(const b of document.querySelectorAll('[data-action=bold],[data-action=group]'))b.disabled=true;
  for(const b of document.querySelectorAll('[data-action="branchDetail"]')){b.disabled=true;b.title='분기점 만들기는 다음 구현 단계에서 지원합니다.';}
  document.body.classList.toggle('has-document',Boolean(state.session));document.body.classList.toggle('text-work',state.kind==='text');document.body.classList.toggle('has-output',Boolean(state.output));
  $('#editor-title').textContent=state.kind==='text'?'TXT 템플릿':'편집';
  $('#copy-body').textContent=state.kind==='text'?'결과 복사':'본문 복사';
  $('#key-select').title=state.kind==='text'?'{{항목}}에 데이터 값을 채웁니다. 구간 표기는 그대로 보존합니다.':'입력 항목 이름';
  $('#save-work').title=state.name?'작업 저장 · '+state.name:'문서를 먼저 여세요.';
  renderSelectionDetail();
  $('#dirty-state').hidden=!state.dirty;
  renderPlacements();
  const download=$('#download'),ready=Boolean(state.output)&&!state.busy;
  download.classList.toggle('disabled',!ready);download.setAttribute('aria-disabled',String(!ready));download.tabIndex=ready?0:-1;
  if(ready)download.href=state.output.outputUrl;else download.removeAttribute('href');
}
async function api(path, body) {
  // '/'로 시작하면 그 주소 그대로(Helper 프로필의 /api/g2b/…), 아니면 작업창 API
  const response = await fetch(path.startsWith('/') ? path : '/api/workbench/' + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = result.error;
    throw Object.assign(new Error((typeof error === 'string' ? error : error?.message) ?? result.plain
      ?? result.message ?? '작업을 마치지 못했습니다.'), {code: result.code});
  }
  return result;
}
function errorMessage(error) { return error instanceof Error ? error.message : '작업을 마치지 못했습니다.'; }
function hideMenu() { $('#context-menu').hidden = true; $('#selection-remote').hidden=true; $('#remote-link-row').hidden=true; contextRequest++; }
function closeMenus(except) {
  for (const menu of document.querySelectorAll('details.menu[open]')) if (menu !== except) menu.open = false;
}
function disposeResult() {
  views.cancel();
  if (state.viewMode === 'result') {
    if (state.kind === 'text') renderTextDocument('source');
    else if (state.sourceDoc) mountDocument(state.sourceDoc, 'source');
  }
  state.resultDoc?.free(); state.resultDoc = undefined;document.body.classList.remove('show-text-preview');
}
function invalidateOutput() {
  state.revision++; state.output = undefined; $('#output-info').textContent = '';
  $('#body-result-panel').hidden = true; $('#body-text').value = '';
  disposeResult(); controls();
  const session = state.session, placements = state.placements.map((p) => ({...p}));
  if (session) state.invalidations = state.invalidations.catch(() => {}).then(async () => {
    if (state.session !== session) return;
    try { await api('invalidate', {session, placements}); }
    catch { if (state.session === session) status('이전 결과를 사용할 수 없습니다. 다시 적용해주세요.', 'error'); }
  });
}
function changed() { state.dirty = true; invalidateOutput(); }
function editorWork() { return {edits:[...state.edits].map(([id,text])=>({id,text})),blocks:state.blocks.map(b=>({...b}))}; }
function historyEntry() { return {...editorWork(),placements:state.placements.map(p=>({...p})),headings:[...state.headings],recs:state.recommendations.map(r=>({...r})),caret:state.caret?{...state.caret}:undefined}; }
function remember() { state.history.push(historyEntry()); if(state.history.length>100)state.history.shift();state.future=[]; }
function setWork(work) {state.edits=new Map(work.edits.map(e=>[e.id,e.text]));state.blocks=work.blocks;if(work.placements)state.placements=work.placements;}
function renderEditor() {
  state.layout=editorLayout(state.paragraphs,editorWork());const input=$('#document-editor');
  if(input.value!==state.layout.text)input.value=state.layout.text;
  input.style.height='0px'; input.style.height=Math.max($('#editor-scroll').clientHeight,input.scrollHeight)+'px';
  const mirror=$('#editor-mirror');mirror.replaceChildren();
  let offset=0;
  const displayUnits=state.kind==='text'?state.layout.text.split('\n').map((text,i)=>{const id=unitAt(state.layout.units,offset)?.id,start=offset;offset+=text.length+1;return {id,from:i,to:i,text,start,end:offset-1};}):state.layout.units;
  for(const unit of displayUnits) {
    const row=paragraph(unit.id),line=document.createElement('div');line.className='editor-unit'+(unit.block?' block-unit':'')+(!row.editable?' readonly-unit':'')+(state.headings.has(unit.id)?' heading-unit':'');line.dataset.id=unit.id;
    const number=document.createElement('button');number.type='button';number.className='line-number';number.textContent=unit.from===unit.to?String(unit.from+1):(unit.from+1)+'–'+(unit.to+1);number.title=(unit.block?'블록 · ':'')+(!row.editable?reasonOf(row.reason):'원본 위치');number.setAttribute('aria-label','원본 '+number.textContent);number.tabIndex=-1;
    number.addEventListener('click',()=>{if(state.kind==='text'){input.focus();input.setSelectionRange(unit.start,unit.end);captureCaret(false);}else selectRow(unit.id,{focus:true});});line.append(number,document.createTextNode(unit.text+'​'));mirror.append(line);
  }
  if(state.kind==='text')$('#paragraph-count').textContent=displayUnits.length+'줄';
  markEditorSelection();controls();
}
function markEditorSelection() {
  const caret=state.caret??{start:0,end:0},chosen=editorSelection(state.layout,caret.start,caret.end);
  for(const line of $('#editor-mirror').children)line.classList.toggle('selected-unit',chosen.some(u=>u.id===line.dataset.id));
  const a=chosen[0],z=chosen.at(-1);if(state.kind==='text'){$('#selection-info').textContent=state.caret?'줄 '+state.layout.text.slice(0,caret.start).split('\n').length:'';return;}$('#selection-info').textContent=a?(state.kind==='text'?'줄 ':'문단 ')+(a.from+1)+(a.from!==z.to?'–'+(z.to+1):''):'';
}
function captureCaret(sync=true) {
  const input=$('#document-editor');state.caret={start:input.selectionStart,end:input.selectionEnd};
  // 편집 창에서 다른 곳을 고르면 고른 입력 항목에서 벗어난다(지정은 새 자리에. 원문 고르기와 같다)
  const active=state.activeRecommendation;if(active?.kind==='input'){const own=itemCaret(active);if(!own||own.start!==state.caret.start||own.end!==state.caret.end)state.activeRecommendation=undefined;}
  const unit=unitAt(state.layout.units,input.selectionStart),old=state.chosen;state.chosen=unit?.id;
  markEditorSelection();controls();if(sync&&state.chosen&&state.chosen!==old)void showRowInSource(state.chosen);
}

function renderOutline() {
  const outline = $('#outline'); outline.replaceChildren();
  for (const item of state.paragraphs) {
    const level = state.headings.get(item.id);
    if (!level) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'level-' + level;
    button.textContent = textOf(item).trim() || '(빈 제목)';
    button.addEventListener('click', () => { selectRow(item.id); $('#outline-menu').open = false; });
    outline.append(button);
  }
  $('#outline-menu').hidden = state.headings.size === 0;
}
function renderParagraphs() {renderEditor();if(state.kind!=='text')$('#paragraph-count').textContent=String(state.paragraphs.length||'');renderOutline();}
function selectRow(id,options={}) {
  const unit=state.layout.units.find(u=>state.paragraphs.slice(u.from,u.to+1).some(r=>r.id===id));if(!unit)return false;
  state.detailLibrary=undefined;state.activeRecommendation=undefined;state.chosen=id;state.caret={start:unit.start,end:unit.end};const input=$('#document-editor');input.setSelectionRange(unit.start,unit.end);
  if(options.focus)input.focus({preventScroll:true});
  if(options.scroll!==false)$('#editor-mirror').querySelector('[data-id="'+unit.id+'"]')?.scrollIntoView({block:'nearest'});
  markEditorSelection();highlightTextRow(id);if(!options.fromPick)void showRowInSource(id);controls();return true;
}
function clearSelection(){picks.cancel();hideMenu();state.selection=undefined;state.chosen=undefined;state.caret=undefined;displaySourceMarks([]);$('#selection-info').textContent='';highlightTextRow(undefined);controls();}
/** 지금 선택이 원문에서 누른(끈) 그대로이면 그 기록: 범위 끝 문단, 문단 범위, 누른 점 */
function currentPick(){const p=state.blockPick,c=state.caret;return p&&c&&p.start===c.start&&p.end===c.end?p:undefined;}
/** 시작·끝 깃발(#150): 첫 깃발은 지금 누른 점을 들고 기다린다. 끝 깃발은 두 점을 보내 드래그와 같은 상세로 보인다. 거절이면 첫 깃발은 그대로 */
function startFlag(){const point=currentPick()?.point;if(!point)return;state.flag={session:state.session,start:point,row:state.chosen};displaySourceMarks(state.marks.get(state.chosen)??[]);status(FLAG_WAIT);}
async function endFlag(){
  const request=flagRequest(state.flag,state.session,currentPick()?.point);if(!request)return;
  if(await selectPicked({flags:request.flags})){dropFlag();status('깃발 범위 · '+spanLabel(state.selection.span));}
}
function dropFlag(){if(!state.flag)return;state.flag=undefined;displaySourceMarks(state.chosen?state.marks.get(state.chosen)??[]:[]);}
/** 원문 위 첫 깃발 표식(덧그림만): 누른 글자, 칸의 빈 곳이면 그 문단 첫 글자 */
function flagMarks(){const f=state.flag,p=f&&(f.start.position??paragraph(f.row)?.position);return p?[{id:'flag',kind:'flag',position:p,endOffset:p.charOffset+1}]:[];}

function requestOf(event) {
  const from = event.cell ? {cell: event.cell} : {position: event.hit.position};
  if (!event.cell) {
    if (event.shown) from.shown = event.shown;
    if (event.guide && event.guideText !== undefined) from.guide = event.guideText;
    if (event.trailing) from.trailing = true;
    if (event.limit === 'paragraph') from.limit = 'paragraph';
    if (event.reason) from.reason = event.reason;
  }
  const request = {from};
  if (event.to && !event.cell) {
    request.to = {position: event.to.position};
    if (event.to.shown) request.to.shown = event.to.shown;
    if (event.to.limit === 'paragraph') request.to.limit = 'paragraph';
    if (event.to.reason) request.to.reason = event.to.reason;
  }
  return request;
}
function marksOf(location, id) {
  const drafts = location.drafts ?? [];
  const candidate = drafts.find((draft) => draft.mark && !draft.blocked) ?? drafts.find((draft) => draft.mark);
  return candidate ? [{...candidate.mark, id, kind: 'chosen'}] : [];
}
async function selectPicked(event, options = {}) {
  if (state.busy || !state.session) return false;
  if (state.viewMode !== 'source') {
    clearSelection(); status('위치를 지정하려면 원본 보기로 돌아가주세요.'); return false;
  }
  const ticket = picks.begin(), session = state.session;
  // 끝 깃발(#150)은 두 점을 `{flags}`로 보내고, 응답은 드래그와 같은 흐름으로 보인다
  if (!event.flags && !event.cell && !event.hit.position) {
    clearSelection(); status('이 위치에서는 연결할 문단을 확인할 수 없습니다.'); return false;
  }
  const request = event.flags ? {flags: event.flags} : requestOf(event);
  try {
    const result = await api('select', {session, request});
    if (!picks.current(ticket) || session !== state.session) return false;
    if (!result.id || result.location.precision === 'none') {
      clearSelection();
      status(event.flags ? flagRefusal(result.location.reason) : result.location.reason === 'RANGE_PARAGRAPHS_DIFFER'
        ? '같은 본문이나 표 칸 안의 글을 선택하세요.'
        : '이 위치에서는 연결할 문단을 확인할 수 없습니다.', event.flags ? 'error' : '');
      return false;
    }
    state.activeRecommendation=undefined;state.selection = result.location;
    const span=result.location.span;
    const a=span?state.paragraphs.find(r=>r.sectionIndex===span.sectionIndex&&r.path.length===span.parentPath.length+1&&r.path.at(-1)===span.from&&r.path.slice(0,-1).every((n,i)=>n===span.parentPath[i])):paragraph(result.id);
    const z=span?state.paragraphs.find(r=>r.sectionIndex===span.sectionIndex&&r.path.length===span.parentPath.length+1&&r.path.at(-1)===span.to&&r.path.slice(0,-1).every((n,i)=>n===span.parentPath[i])):a;
    // 여러 문단 범위(드래그·깃발)는 시작부터 끝까지 문단마다 강조한다(블록 후보 강조와 같은 모양)
    const rows=span&&a&&z?state.paragraphs.slice(state.paragraphs.indexOf(a),state.paragraphs.indexOf(z)+1):[];
    state.marks.set(result.id, span?rows.filter(p=>p.position).map(p=>({id:p.id,kind:'selection',position:p.position,endOffset:p.text.length})):marksOf(result.location, result.id));
    displaySourceMarks(state.marks.get(result.id));
    selectRow(result.id, {...options, fromPick: true});
    const first=state.layout.units.find(u=>state.paragraphs.slice(u.from,u.to+1).some(r=>r.id===a?.id)),last=state.layout.units.find(u=>state.paragraphs.slice(u.from,u.to+1).some(r=>r.id===z?.id));
    if(first&&last){
      const word=paragraph(result.id)?.editable?result.location.drafts.find(d=>d.anchor?.kind==='word'&&!d.blocked)?.anchor:undefined;
      const start=first.start+(!span&&!state.edits.has(result.id)&&!first.block&&word?word.start:0),end=span?last.end:first.start+(!state.edits.has(result.id)&&!first.block&&word?word.end:first.text.length);
      state.blockPick={start,end,from:a?.id,to:z?.id,span,point:request.from,blocked:Boolean(event.to&&!span&&(!event.hit.position||!sameParagraph(event.hit.position,event.to.position)))};
      state.caret={start,end};const input=$('#document-editor');input.focus({preventScroll:true});input.setSelectionRange(start,end);markEditorSelection();controls();
    }
    renderSelectionDetail(true);showRemote();return true;
  } catch (error) {
    if (picks.current(ticket) && session === state.session) { clearSelection(); status(errorMessage(error), 'error'); }
    return false;
  }
}
async function showRowInSource(id) {
  if (!state.session || (state.kind !== 'text' && !state.sourceDoc)) return;
  const session = state.session, ticket = picks.begin();
  try {
    const result = await api('select', {session, id});
    if (!picks.current(ticket) || session !== state.session || state.chosen !== id) return;
    const marks = result.location.precision === 'none' ? [] : marksOf(result.location, id);
    state.marks.set(id, marks);
    if (state.kind === 'text') { if (state.viewMode === 'source') highlightTextRow(id, true); return; }
    if (state.viewMode === 'source') {
      displaySourceMarks(marks);
      const position = marks[0]?.position;
      if (position) {
        const page = [...$('#pages').querySelectorAll('.page')].find((entry) => {
          const layout = state.sourceDoc.pageLayout(Number(entry.dataset.page));
          return layout.runs.some((run) => { const at = runPosition(run); return at && sameParagraph(at, position); });
        });
        if(page){const run=state.sourceDoc.pageLayout(Number(page.dataset.page)).runs.find(r=>{const p=runPosition(r);return p&&sameParagraph(p,position);});const sc=$('#page-scroll');sc.scrollTop+=page.getBoundingClientRect().top+(run?.y??0)*Number($('#scale').value)-sc.getBoundingClientRect().top-40;}
      }
    }
  } catch (error) {
    if (picks.current(ticket) && session === state.session) status('원본 위치 확인: ' + errorMessage(error), 'error');
  }
}
function mountDocument(doc, mode) {
  state.view?.destroy(); state.viewMode = mode;
  if (mode !== 'source') state.flag = undefined;
  state.view = createPageView({
    container: $('#pages'), doc, scale: Number($('#scale').value),
    onPick: (event) => { hideMenu(); void selectPicked(event); },
    onError: (error) => status('문서 표시: ' + errorMessage(error), 'error'),
  });
  $('#original-title').textContent = mode === 'source' ? '원문' : '생성 미리 보기';
  $('#comparison-view').setAttribute('aria-pressed','false');
  $('#source-view').setAttribute('aria-pressed', String(mode === 'source'));
  $('#result-view').setAttribute('aria-pressed', String(mode === 'result'));
  if (mode === 'source' && state.chosen) displaySourceMarks(state.marks.get(state.chosen) ?? []);
  requestAnimationFrame(()=>{renderViewerNumbers();renderSourceTags();followHeading();});controls();
}
async function openViewer(url, mode, openTicket) {
  const ticket = views.begin();
  await loadRhwp({wasmUrl: '/vendor/rhwp/rhwp_bg.wasm'});
  const response = await fetch(url);
  if (!response.ok) throw new Error('문서를 표시할 수 없습니다.');
  const doc = openDocument(new Uint8Array(await response.arrayBuffer()));
  if (!opens.current(openTicket) || !views.current(ticket)) { doc.free(); return; }
  state.view?.destroy(); state.view = undefined;
  if (mode === 'source') {
    state.sourceDoc?.free(); state.resultDoc?.free(); state.sourceDoc = doc; state.resultDoc = undefined;
  } else { state.resultDoc?.free(); state.resultDoc = doc; }
  mountDocument(doc, mode);
}
async function showResult() {
  if (!state.output || state.busy) return;
  document.body.classList.add('show-text-preview');setBusy(true, '생성 결과를 표시하는 중입니다.');
  try {
    if (state.kind === 'text') {renderTextDocument('result');}
    else if (state.resultDoc) mountDocument(state.resultDoc, 'result');
    else await openViewer(state.output.outputUrl, 'result', state.openTicket);
    status('생성 결과 · 내려받기로 저장할 수 있습니다.', 'success');
  } catch (error) { status(errorMessage(error), 'error'); }
  finally { setBusy(false); }
}
function updateData(info) {
  state.detailId=undefined;
  state.records = info?.records ?? 0; state.keys = info?.keys ?? []; state.index = info?.index ?? 0; state.cases = info?.cases ?? [];
  $('#data-info').textContent = state.records ? state.records + '개 행 연결됨' : '데이터가 없습니다.';
  const records = $('#record-select'); records.replaceChildren();
  const count = Math.max(1, state.records);
  for (let index = 0; index < count; index++) {
    const option = document.createElement('option'); option.value = String(index);
    option.textContent = state.records ? caseLabel(index) : '견본 값'; records.append(option);
  }
  if (!Number.isInteger(state.index) || state.index < 0 || state.index >= count) state.index = 0;
  records.value = String(state.index);
  const keys = $('#data-keys'); keys.replaceChildren(); $('#key-select').value = '';
  for (const key of state.keys.filter((item) => item.usable)) {
    const option = document.createElement('option'); option.value = key.path; option.textContent = key.path; keys.append(option);
  }
  const preview = $('#data-preview'); preview.replaceChildren();
  if (info?.preview && typeof info.preview === 'object' && !Array.isArray(info.preview)) {
    const label = document.createElement('p'); label.className = 'muted'; label.textContent = '첫 번째 행 미리보기'; preview.append(label);
    for (const [key, value] of Object.entries(info.preview).slice(0, 12)) {
      const pair = document.createElement('div'); pair.className = 'data-pair';
      const name = document.createElement('span'); name.textContent = key;
      const content = document.createElement('span');
      content.textContent = value === null ? '(빈값)' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      pair.append(name, content); preview.append(pair);
    }
    preview.hidden = false;
  } else preview.hidden = true;
  state.samples = {}; applyAutoKeys(); renderInputs(); void loadSample();
  controls();
}
async function installWorkspace(result, ticket) {
  state.detailLibrary=undefined;blockLibraryUI.dispose($('#detail-library-tools'));
  $('#txt-missing').value=result.missing??'error';
  if (!opens.current(ticket)) return;
  picks.cancel(); dataLoads.cancel(); clearSelection(); hideMenu();
  state.view?.destroy(); state.view = undefined;
  state.sourceDoc?.free(); state.sourceDoc = undefined; state.resultDoc?.free(); state.resultDoc = undefined;
  state.session = result.session; state.kind = result.kind ?? 'hwpx'; state.sourceText = result.sourceText ?? '';
  $('#download-label').textContent = state.kind === 'text' ? 'TXT 저장' : 'HWPX 저장';
  state.name = result.name; state.openTicket = ticket; state.paragraphs = result.paragraphs ?? [];
  state.edits = new Map((result.edits ?? []).map((item) => [item.id, item.text]));
  state.headings = new Map((result.headings ?? []).map((item) => [item.id, item.level]));
  state.blockPick = undefined; state.flag = undefined;
  state.typed={...(result.samples??{})};state.g2bTemplate=undefined;$('#g2b-template').textContent='서식 판 없음';
  state.outline=result.outline??[];state.recommendations=[];state.detailDrafts.clear();state.detailId=undefined;state.reviewHistory=[];state.currentItem=undefined;closeTable();
  state.blocks = (result.blocks ?? []).map((item) => ({...item}));
  state.placements=(result.placements??[]).map(p=>({...p}));state.placementNames=result.placementNames??{};state.placementWarnings=result.placementWarnings??{};
  state.marks.clear();
  state.output = undefined; state.viewMode = 'source'; state.dirty = false; state.revision++;
  state.history=[];state.future=[];state.comparison=undefined; $('#output-info').textContent = ''; $('#data-text').value = '';
  $('#document-name').textContent = state.name; $('#document-name').title = state.name;
  renderParagraphs(); updateData(result.dataInfo);
  if (result.index !== undefined) { state.index = result.index; $('#record-select').value = String(result.index); }
  $('#pages').replaceChildren();
  const loading = document.createElement('p'); loading.className = 'editor-empty';
  loading.textContent = '원본 문서를 표시하고 있습니다.'; $('#pages').append(loading);
  try {
    if (state.kind === 'text') { $('#scale').value = '1'; renderTextDocument('source'); }
    else { $('#scale').value = '0.65'; await openViewer(result.sourceUrl, 'source', ticket); }
  }
  catch (error) {
    if (opens.current(ticket)) {
      $('#pages').replaceChildren();
      const note = document.createElement('p'); note.className = 'error-empty'; note.textContent = '원본 표시: ' + errorMessage(error); $('#pages').append(note);
      status('문단은 불러왔지만 원본을 표시하지 못했습니다.', 'error'); return;
    }
  }
  if (opens.current(ticket)) {const dropped=buildReview(result);applyAutoKeys();renderHeadingTree();renderInputs();void loadSample();const notice=[result.notice,dropped?'저장한 입력 항목 '+dropped+'개를 문서에서 찾지 못해 뺐습니다.':''].filter(Boolean).join(' ');status(notice, notice ? 'error' : '');}
}
function base64(bytes) {
  const chunk = 0x8000; let binary = '';
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}
async function openFile(file, restore = false) {
  if (!file || state.busy) return;
  hideMenu(); closeMenus(); const ticket = opens.begin(); picks.cancel(); dataLoads.cancel(); invalidateOutput();
  setBusy(true, restore ? '저장한 작업을 불러오는 중입니다.' : '문서를 여는 중입니다.');
  try {
    const result = restore ? await api('restore', {workspace: await file.text()})
      : await api('open', {name: file.name, content: base64(new Uint8Array(await file.arrayBuffer()))});
    if (opens.current(ticket)) await installWorkspace(result, ticket);
  } catch (error) { if (opens.current(ticket)) status(errorMessage(error), 'error'); }
  finally { if (opens.current(ticket)) setBusy(false); }
}
async function loadData(name, content, expected = {}) {
  if (!state.session || state.busy || (expected.session && expected.session !== state.session)
    || (expected.ticket !== undefined && !dataLoads.current(expected.ticket))) return;
  const session = state.session, ticket = expected.ticket ?? dataLoads.begin();
  if (!expected.invalidated) invalidateOutput();
  setBusy(true, '데이터를 읽는 중입니다.');
  try {
    const result = await api('data', {session, name, content});
    if (!dataLoads.current(ticket) || session !== state.session) return;
    updateData(result); state.dirty = true; const missing = renderKeyNotice(); status(result.records + '개 업무 건을 올렸습니다' + (missing ? ' · 템플릿에만 있는 키 ' + missing + '개(데이터 메뉴)' : '') + '.', missing ? 'warn' : '');
  } catch (error) {
    if (dataLoads.current(ticket) && session === state.session) {
      updateData(undefined); state.dirty = true; $('#copy-fallback').hidden = true;
      status(errorMessage(error), 'error');
    }
  }
  finally { if (dataLoads.current(ticket) && session === state.session) setBusy(false); }
}
function snapshot() {
  return {session: state.session, index: state.index, missing: $('#txt-missing').value, edits: [...state.edits].map(([id, text]) => ({id, text})),
    headings: [...state.headings].map(([id, level]) => ({id, level})), blocks: state.blocks.map((block) => ({...block})),placements:state.placements.map(p=>({...p})),
    inputItems: inputItems().map(itemOf), ...(Object.keys(state.typed).length ? {samples: {...state.typed}} : {})};
}
function saveBlob(content, name) {
  const url = URL.createObjectURL(new Blob([content], {type: 'application/json;charset=utf-8'}));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function saveWork() {
  if (!state.session || state.busy) return;
  closeMenus(); hideMenu(); setBusy(true, '작업 파일을 저장하는 중입니다.');
  try {
    await state.invalidations; const result = await api('save', snapshot());
    saveBlob(result.workspace, result.name); state.dirty = false;
    status('현재 문서와 편집 내용을 작업 파일로 저장했습니다.', 'success');
  } catch (error) { status(errorMessage(error), 'error'); }
  finally { setBusy(false); }
}
async function generate(asTemplate = false, busyMessage = '') {
  if (!state.session || state.busy) return;
  hideMenu(); closeMenus(); invalidateOutput(); const revision = state.revision, session = state.session;
  setBusy(true, busyMessage || (asTemplate ? '누름틀 서식을 만드는 중입니다.' : '편집과 데이터를 적용하는 중입니다.'));
  try {
    await state.invalidations; const result = await api(asTemplate ? 'template' : 'generate', snapshot());
    if (revision !== state.revision || session !== state.session) return;
    state.output = result;
    const textTemplate = state.kind === 'text' && result.template === true;
    $('#download').download = state.name.replace(/\.(hwpx|txt)$/i, '') + (asTemplate ? '-서식.hwpx' : textTemplate ? '-서식.txt' : '-결과.' + (state.kind === 'text' ? 'txt' : 'hwpx'));
    $('#download-label').textContent = asTemplate ? '서식 HWPX 저장' : textTemplate ? '서식 TXT 저장' : state.kind === 'text' ? 'TXT 저장' : 'HWPX 저장';
    $('#body-text').value = result.text ?? ''; $('#body-result-panel').hidden = true;
    $('#body-result').open = state.kind === 'text';
    // HWPX를 '자리 유지'로 만들어 채우지 못한 {{…}}가 남으면 남은 곳 수를 함께 보인다(#126)
    const left = !asTemplate && !textTemplate && result.unresolved ? ' · 남은 자리 ' + result.unresolved + '곳' : '';
    $('#output-info').textContent = asTemplate ? '누름틀 ' + result.promoted + '개 생성' : textTemplate ? '서식 반영 · 미연결 ' + result.unresolved + '곳' : result.changed + '개 편집 · ' + result.filled + '곳 채움' + left;
    try {
      if (state.kind === 'text') {renderTextDocument('result');}
      else await openViewer(result.outputUrl, 'result', state.openTicket);
    }
    catch (error) {
      if (state.sourceDoc) mountDocument(state.sourceDoc, 'source');
      status('생성은 완료됐지만 화면 표시가 어렵습니다. 내려받기로 확인해주세요. ' + errorMessage(error), 'error'); return;
    }
    const notes = Array.isArray(result.notes) && result.notes.length ? ' · ' + result.notes.join(' · ') : '';
    status(asTemplate ? '누름틀 ' + result.promoted + '개를 만들었습니다. 서식 HWPX 저장을 누르세요.' : textTemplate ? '글을 반영했습니다. 미연결 ' + result.unresolved + '곳은 {{키}}로 남겼습니다. 데이터를 연결하면 값을 채울 수 있습니다.' + notes : '생성 완료 · ' + result.changed + '개 편집, ' + result.filled + '곳 채움' + notes, left ? 'warn' : 'success');
  } catch (error) {
    state.output = undefined; disposeResult(); $('#output-info').textContent = ''; status(errorMessage(error), 'error');
  } finally { setBusy(false); }
}
function applyEditorChange(start,end,value) {
  const next=replaceEditorText(state.paragraphs,editorWork(),start,end,value,'b-'+crypto.randomUUID());
  remember();setWork(next);state.caret={start:start+value.length,end:start+value.length};changed();renderEditor();
  const input=$('#document-editor');input.focus();input.setSelectionRange(state.caret.start,state.caret.end);captureCaret(false);
}
function blockSelection() {
  if(state.busy)throw Error('문서 처리가 끝난 뒤 선택하세요.');
  if(!state.session||state.kind!=='hwpx')throw Error('HWPX 원문을 열고 범위를 선택하세요.');
  if(state.viewMode!=='source')throw Error('원본 보기에서 범위를 선택하세요.');
  if(state.activeRecommendation?.kind==='block'&&state.activeRecommendation.status==='excluded')throw Error('제외한 후보입니다. 추천 목록에서 유지에 체크한 뒤 저장하세요.');
  const caret=state.caret;if(!caret)throw Error('원문이나 문단 목록에서 저장할 범위를 선택하세요.');
  const picked=state.blockPick;
  let from,to;
  if(picked&&picked.start===caret.start&&picked.end===caret.end){
    if(picked.blocked)throw Error('선택한 범위의 경계를 확인할 수 없습니다. 같은 본문이나 표 칸 안에서 다시 선택하세요.');
    from=picked.from;to=picked.to;
  }else{const selected=editorSelection(state.layout,caret.start,caret.end);from=state.paragraphs[selected[0]?.from]?.id;to=state.paragraphs[selected.at(-1)?.to]?.id;}
  if(!from||!to)throw Error('저장할 문단을 선택하세요.');
  const a=state.paragraphs.findIndex(p=>p.id===from),z=state.paragraphs.findIndex(p=>p.id===to);
  const ids=new Set(state.paragraphs.slice(Math.min(a,z),Math.max(a,z)+1).map(p=>p.id));
  if([...state.edits.keys()].some(id=>ids.has(id))||state.blocks.some(b=>ids.has(b.from)||ids.has(b.to)))
    throw Error('이 범위에는 편집한 내용이 있습니다. 이번 저장은 원본 범위만 지원합니다.');
  return {from,to};
}
function groupSelection() {
  const caret=state.caret;if(!caret)return;
  const next=groupEditorSelection(state.paragraphs,editorWork(),caret.start,caret.end,'b-'+crypto.randomUUID());
  remember();setWork(next);changed();renderEditor();const input=$('#document-editor');input.focus();input.setSelectionRange(caret.start,caret.end);status('블록으로 묶었습니다.');
}
function resetSelection() {
  const caret=state.caret;if(!caret)return;const chosen=editorSelection(state.layout,caret.start,caret.end);remember();
  const ids=new Set(chosen.flatMap(u=>state.paragraphs.slice(u.from,u.to+1).map(r=>r.id)));
  for(const id of ids){state.edits.delete(id);state.headings.delete(id);}state.blocks=state.blocks.filter(b=>!ids.has(b.from));changed();renderEditor();renderOutline();status('선택한 부분을 원본으로 되돌렸습니다.');
}
function undo(redo=false) {
  const from=redo?state.future:state.history,to=redo?state.history:state.future;if(state.busy||!from.length)return;
  to.push(historyEntry());const previous=from.pop();setWork(previous);state.headings=new Map(previous.headings);if(previous.recs){state.recommendations=previous.recs;state.activeRecommendation=undefined;}state.caret=previous.caret;changed();renderEditor();renderOutline();renderInputs();
  const input=$('#document-editor');input.focus();if(state.caret)input.setSelectionRange(state.caret.start,state.caret.end);status('');
}
function useHeading(id,level){remember();state.headings.set(id,level);changed();renderEditor();renderOutline();}
function replaceSelected(value){const c=state.caret??{start:0,end:0};applyEditorChange(c.start,c.end,value);}
function insertKey(){const key=$('#key-select').value.trim();if(!key||!/^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u.test(key)){ $('#key-select').focus();status('공백 없는 필드 이름을 입력하세요.','error');return;} replaceSelected('{{'+key+'}}');}
function makeBold(){if(state.kind==='text')return;const c=state.caret;if(!c||c.start===c.end)return;const text=state.layout.text.slice(c.start,c.end);replaceSelected(text.startsWith('**')&&text.endsWith('**')?text.slice(2,-2):'**'+text+'**');}

async function copyKey() {
  const key = $('#key-select').value.trim(); if (!key || state.busy) return;
  const text = '{{' + key + '}}', session = state.session, revision = state.revision, ticket = keyCopies.begin();
  const current = () => keyCopies.current(ticket) && session === state.session && revision === state.revision && key === $('#key-select').value.trim();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard');
    await navigator.clipboard.writeText(text);
    if (!current()) return;
    $('#copy-fallback').hidden = true;
    status('키를 복사했습니다. 원하는 곳에 붙여넣고 키 이름을 수정할 수 있습니다.');
  } catch {
    if (!current()) return;
    const input = $('#copy-fallback'); input.value = text; input.hidden = false; input.focus(); input.select();
    status('브라우저가 복사를 허용하지 않았습니다. 선택된 키를 Ctrl+C로 복사해주세요.', 'error');
  }
}
function action(name) {
  if(state.kind==='text'&&['bold','group'].includes(name))return;
  hideMenu();if(state.busy)return;
  try {
    if(name==='inputDetail'){openInputDetail();return;}
    if(name==='dataDetail'){void startLink();return;}
    if(name==='labelPick'){pickLabel();return;}
    if(name==='branchDetail')return;
    if(name==='saveBlock'){void blockLibraryUI.begin();return;}
    if(name==='flagStart'){startFlag();return;}
    if(name==='flagEnd'){void endFlag();return;}
    if(name==='copyKey'){void copyKey();return;}
    if(name==='copySelection'){const c=state.caret;void navigator.clipboard.writeText(state.comparisonText||(c?state.layout.text.slice(c.start,c.end):'')).then(()=>status('복사했습니다.')).catch(()=>status('브라우저가 복사를 허용하지 않았습니다. Ctrl+C를 사용하세요.','error'));return;}
    if(name==='importSelection'){replaceSelected(state.comparisonText);if(state.kind==='text')renderTextDocument('source');return;}
    if(name==='menuKey'){$('#key-select').value=$('#menu-key').value;insertKey();return;}
    if(name==='group')groupSelection();else if(name==='reset')resetSelection();else if(name==='bold')makeBold();else if(name==='key')insertKey();
    else if(name==='heading1'||name==='heading2')useHeading(state.chosen,name==='heading1'?1:2);
    else if(name==='edit'){$('#document-editor').focus();if(state.caret)$('#document-editor').setSelectionRange(state.caret.start,state.caret.end);}
    else if(name==='anchor'){if(state.kind==='text')renderTextDocument('source');else if(state.sourceDoc)mountDocument(state.sourceDoc,'source');void showRowInSource(state.chosen);}
  }catch(error){status(errorMessage(error),'error');}
}

function showMenu(x, y) {
  if (!state.chosen) return;
  controls(); const menu = $('#context-menu'); menu.hidden = false; menu.style.left = '0px'; menu.style.top = '0px';
  const box = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) + 'px';
}
$('#pages').addEventListener('contextmenu', async (event) => {
  const page = event.target instanceof Element ? event.target.closest('.page') : null;
  if (!page) return;
  event.preventDefault(); hideMenu();
  if (state.busy || state.viewMode !== 'source' || !state.sourceDoc) {
    clearSelection(); status('위치 지정은 원본 보기에서 사용할 수 있습니다.'); return;
  }
  clearSelection(); const ticket = ++contextRequest, session = state.session;
  try {
    const point = toPagePoint({x: event.clientX, y: event.clientY}, page.getBoundingClientRect(), Number($('#scale').value));
    const pick = state.sourceDoc.pick(Number(page.dataset.page), point.x, point.y);
    const chosen = await selectPicked({...pick, page: Number(page.dataset.page)});
    if (chosen && ticket === contextRequest && session === state.session) showMenu(event.clientX, event.clientY);
  } catch (error) {
    if (ticket === contextRequest && session === state.session) { clearSelection(); status(errorMessage(error), 'error'); }
  }
});
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => action(button.dataset.action));
}
$('#open-document').addEventListener('click', () => $('#document-file').click());
$('#empty-open').addEventListener('click', () => $('#document-file').click());
$('#load-work').addEventListener('click', () => $('#workspace-file').click());
$('#open-data').addEventListener('click', () => $('#data-file').click());
$('#document-file').addEventListener('change', async (event) => { const file = event.target.files[0]; event.target.value = ''; await openFile(file); });
$('#workspace-file').addEventListener('change', async (event) => { const file = event.target.files[0]; event.target.value = ''; await openFile(file, true); });
$('#data-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || !state.session || state.busy) return;
  const session = state.session, ticket = dataLoads.begin();
  invalidateOutput(); setBusy(true, '데이터 파일을 읽는 중입니다.');
  try {
    const content = await file.text();
    if (!dataLoads.current(ticket) || session !== state.session) return;
    setBusy(false);
    await loadData(file.name, content, {session, ticket, invalidated: true});
  } catch (error) {
    if (dataLoads.current(ticket) && session === state.session) status(errorMessage(error), 'error');
  } finally { if (dataLoads.current(ticket) && session === state.session) setBusy(false); }
});
$('#load-data-text').addEventListener('click', () => loadData('data.json', $('#data-text').value));
$('#save-work').addEventListener('click', saveWork);
$('#generate').addEventListener('click', () => generate());
$('#make-template').addEventListener('click', () => generate(true));
$('#cancel-selection').addEventListener('click', clearSelection);
$('#undo').addEventListener('click',()=>undo());
$('#redo').addEventListener('click',()=>undo(true));
$('#key-select').addEventListener('input', () => { $('#copy-fallback').hidden = true; controls(); });
$('#key-select').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); insertKey(); } });
$('#txt-missing').addEventListener('change',()=>{if(!state.busy)changed();});
// 업무 건(#149): 데이터 한 행. 바꾸면 이전 건의 결과는 바로 버리고(내려받기 막힘), 미리 보기 중이면 새 건으로 다시 만든다("갱신 중")
$('#record-select').addEventListener('change', () => {
  if (state.busy) return; const preview = Boolean(state.output) && state.viewMode === 'result';
  state.index = Number($('#record-select').value); changed(); void loadSample();
  if (preview) void generate(false, '갱신 중 · 업무 건 ' + caseLabel(state.index));
  else status('업무 건 ' + caseLabel(state.index) + '을(를) 골랐습니다. 생성하면 이 건의 값으로 채웁니다.');
});
$('#source-view').addEventListener('click', () => {
  if (!state.busy) {
    document.body.classList.remove('show-text-preview');
    if (state.kind === 'text' && state.session) renderTextDocument('source'); else if (state.sourceDoc) mountDocument(state.sourceDoc, 'source');
    status('원본 문서 · 글을 선택해 편집 위치를 확인하세요.');
  }
});
$('#result-view').addEventListener('click', showResult);
$('#scale').addEventListener('change', () => applyScale());
function zoom(direction) {
  const select = $('#scale'), values = [...select.options].map((item) => Number(item.value));
  const current = values.indexOf(Number(select.value)), next = Math.max(0, Math.min(values.length - 1, current + direction));
  select.value = String(values[next]); applyScale();
}
$('#zoom-out').addEventListener('click', () => zoom(-1));
$('#zoom-in').addEventListener('click', () => zoom(1));

// ── Helper 프로필(#173, 엔진 명세 8.8.14의 Studio 화면 전용 API): 열린 문서로 서식 판(template@2)을 저장하고 그 판을 고정한 2판 프로필을 저장·다시 확인·삭제한다 ──
/** 열린 문서의 서식 판(찾은 자리·지정한 자리·데이터 연결은 서버가 묶는다). 저장된 판은 바뀌지 않으므로 1판부터 같은 내용인 판을 찾고, 없으면 처음 빈 판에 저장한다 */
// shortcut: 판을 1판부터 차례로 보내 맞춰 본다(판 수만큼 원본을 올림), 판이 수십 개로 늘면 서버가 다음 판 번호를 알려 주게 한다
async function saveG2BTemplate(id){
  const response=await fetch('/api/workbench/source?session='+encodeURIComponent(state.session));
  if(!response.ok)throw new Error('문서를 다시 올려 주세요.');
  const source=base64(new Uint8Array(await response.arrayBuffer())),{template,skipped}=await api('g2b-template',{...snapshot(),...(id?{id}:{})});
  for(let version=1;;version++){
    try{return {...(await api('/api/g2b/templates',{template:{...template,version},source})).template,skipped};}
    catch(error){if(error.code!=='REQUEST_CONFLICT')throw error;}
  }
}
const skippedNote=t=>t.skipped?' · 빈 구간이라 넣지 못한 지정 '+t.skipped+'곳':'';
async function helperTask(message,run){
  if(state.busy)return;setBusy(true,message);
  try{status(await run(),'success');}catch(error){status(errorMessage(error),'error');}
  finally{setBusy(false);await renderProfiles();}
}
async function renderProfiles(){
  try{
    const {profiles}=await (await fetch('/api/g2b/profiles')).json();
    // shortcut: 1판 프로필은 보이지 않는다(1판 다리 제거 ⑥ 때 함께 사라진다)
    $('#profile-list').replaceChildren(...profiles.filter(p=>typeof p.templateId==='string').map(p=>{
      const recheck=uiNode('button','다시 확인'),remove=uiNode('button','삭제'),where=uiNode('small',p.templateId+' '+p.version+'판 · '+p.outputDirectory+' · '+p.id);
      recheck.type=remove.type='button';recheck.dataset.recheck='true';where.title=where.textContent;
      // GET 꼴(fileName 없음)으로 판만 바꿔 보낸다. 저장된 파일 이름 규칙은 서버가 둔다(#149)
      recheck.onclick=()=>helperTask('서식을 다시 확인하는 중입니다.',async()=>{const t=await saveG2BTemplate(p.templateId);if(t.version===p.version)return p.label+' · 서식이 그대로입니다('+t.version+'판).';await api('/api/g2b/profiles',{...p,version:t.version});return p.label+' · '+p.version+'판에서 '+t.version+'판으로 바꿨습니다.';});
      remove.onclick=()=>{if(window.confirm(p.label+' 프로필을 지울까요?'))void helperTask('프로필을 지우는 중입니다.',async()=>{await api('/api/g2b/profiles/delete',{id:p.id});return p.label+' 프로필을 지웠습니다.';});};
      const li=uiNode('li');li.append(uiNode('strong',p.label),where,recheck,remove);return li;
    }));
  }catch(error){status(errorMessage(error),'error');}
  controls();
}
$('#helper-menu').addEventListener('toggle',()=>{if($('#helper-menu').open)void renderProfiles();});
$('#save-g2b-template').addEventListener('click',()=>helperTask('서식 판을 저장하는 중입니다.',async()=>{
  const t=await saveG2BTemplate();state.g2bTemplate=t;$('#g2b-template').textContent=t.version+'판 · '+t.name;$('#g2b-template').title=t.id+' '+t.version+'판 · '+t.name;
  return '서식 판을 저장했습니다 · '+t.version+'판'+skippedNote(t);
}));
$('#profile-form').addEventListener('submit',event=>{event.preventDefault();const t=state.g2bTemplate;if(!t)return;void helperTask('프로필을 저장하는 중입니다.',async()=>{
  const label=$('#profile-label').value.trim();
  await api('/api/g2b/profiles',{id:'p-'+crypto.randomUUID().slice(0,8),label,templateId:t.id,version:t.version,outputDirectory:$('#profile-folder').value.trim()});
  $('#profile-label').value='';return label+' 프로필을 저장했습니다 · '+t.version+'판';
});});
for (const menu of document.querySelectorAll('details.menu')) menu.addEventListener('toggle', () => { if (menu.open) closeMenus(menu); });
document.addEventListener('pointerdown', (event) => {
  // 리모컨 안을 누르면 닫지 않는다(닫으면 누른 단추의 click이 오지 않는다)
  if (!$('#context-menu').contains(event.target) && !$('#selection-remote').contains(event.target)) hideMenu();
  if (!(event.target instanceof Element) || !event.target.closest('details.menu')) closeMenus();
});
document.addEventListener('keydown', (event) => {
  if ($('#block-library-dialog').open) return;
  if (event.key === 'Escape') { hideMenu(); closeMenus(); clearSelection(); if (state.flag) { dropFlag(); status('시작 깃발을 취소했습니다.'); } }
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 's') { event.preventDefault(); void saveWork(); }
    else if (event.key === 'Enter') { event.preventDefault(); void generate(); }
    else if (event.key.toLowerCase() === 'b' && document.activeElement?.id==='document-editor') { event.preventDefault(); makeBold(); }
    else if (event.key.toLowerCase()==='z' && (document.activeElement?.id==='document-editor'||state.kind==='hwpx'&&!document.activeElement?.matches('input,textarea,[contenteditable=true]'))) {event.preventDefault();undo(event.shiftKey);}
    else if (event.key.toLowerCase()==='g' && document.activeElement?.id==='document-editor') {event.preventDefault();action('group');}
    else if (event.key.toLowerCase() === 'o') { event.preventDefault(); if (!state.busy) $('#document-file').click(); }
  }
  const menu = $('#context-menu');
  if (!menu.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')], current = buttons.indexOf(document.activeElement);
    buttons[(current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }
});
$('#page-scroll').addEventListener('dragover', (event) => { if (!state.busy) event.preventDefault(); });
$('#page-scroll').addEventListener('drop', (event) => {
  event.preventDefault(); const file = event.dataTransfer.files[0];
  if (file && /\.(hwpx|txt)$/i.test(file.name)) void openFile(file);
  else status('HWPX 또는 TXT 문서를 열어주세요.', 'error');
});
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { renderEditor();renderViewerNumbers(); }); hideMenu();
});
window.addEventListener('pagehide', () => {
  opens.cancel(); picks.cancel(); views.cancel(); dataLoads.cancel(); keyCopies.cancel(); bodyCopies.cancel();
  state.view?.destroy(); state.sourceDoc?.free(); state.resultDoc?.free();
});
controls();

function reasonOf(code) {
  if (code === 'WORKBENCH_STRUCTURE_READONLY') return '표·개체·누름틀이 있는 문단은 원본 글을 유지합니다.';
  if (code === 'FILL_MIXED_FORMAT') return '글자 모양이 섞인 문단은 문단 전체 바꾸기를 지원하지 않습니다.';
  if (code === 'FILL_HAS_OBJECT') return '개체가 포함된 문단은 원본 글을 유지합니다.';
  if (code === 'FILL_CROSSES_MARKUP') return '문단 내부의 표시 구조를 유지해야 하므로 직접 편집을 제한합니다.';
  return '원본 서식을 유지하기 위해 이 문단은 직접 편집할 수 없습니다.';
}
function applyScale() {
  if (state.kind === 'text') {
    const text = $('#pages').querySelector('.text-document');
    if (text) text.style.fontSize = 14 * Number($('#scale').value) + 'px';
  } else state.view?.setScale(Number($('#scale').value));
  renderViewerNumbers();renderSourceTags();
}
function renderTextDocument(mode) {
  document.body.classList.toggle('show-comparison',state.kind==='text'&&mode==='comparison');
  if(state.kind==='text'&&mode!=='comparison'){
    state.view?.destroy();state.view=undefined;state.viewMode='source';$('#pages').replaceChildren();document.body.classList.remove('show-text-preview');controls();return;
  }
  state.view?.destroy();state.view=undefined;state.viewMode=mode;
  const container=$('#pages');container.classList.remove('page-view');container.replaceChildren();
  const sheet=document.createElement('div');sheet.className='text-document';
  const lines=mode==='comparison'?state.comparison.paragraphs.map(p=>p.text):mode==='result'?(state.output?.text??'').split(/\r\n|\r|\n/):state.paragraphs.map(r=>r.text);
  lines.forEach((text,index)=>{const line=document.createElement('div');line.className='text-line';
    if(mode==='source')line.dataset.sourceId=state.paragraphs[index].id;
    if(mode==='comparison')line.dataset.comparison=String(index);
    const number=document.createElement('span');number.className='source-number';number.textContent=String(index+1);number.setAttribute('aria-hidden','true');
    const content=document.createElement('span');content.className='source-text';content.textContent=text||'\u200b';line.append(number,content);sheet.append(line);
  });
  container.append(sheet);applyScale();highlightTextRow(state.chosen);
  $('#original-title').textContent=mode==='comparison'?'비교 · '+state.comparison.name:mode==='source'?'원문':'생성 미리 보기';
  for(const [id,value] of [['source-view','source'],['result-view','result'],['comparison-view','comparison']])$('#'+id).setAttribute('aria-pressed',String(mode===value));controls();
}
function highlightTextRow(id,scroll=false) {
  if(state.kind!=='text'||state.viewMode!=='source')return;
  const c=state.caret,selected=c?editorSelection(state.layout,c.start,c.end).flatMap(u=>state.paragraphs.slice(u.from,u.to+1).map(r=>r.id)):[];
  for(const line of $('#pages').querySelectorAll('[data-source-id]')){
    line.classList.toggle('selected',selected.length?selected.includes(line.dataset.sourceId):line.dataset.sourceId===id);
    if(scroll&&line.dataset.sourceId===id)line.scrollIntoView({block:'nearest'});
  }
}
function renderViewerNumbers(){
  for(const old of $('#pages').querySelectorAll('.viewer-number'))old.remove();
  if(state.kind==='text'||state.viewMode!=='source'||!state.sourceDoc)return;
  const scale=Number($('#scale').value);if(!Number.isFinite(scale)||scale<=0)return;
  let offset=0;
  for(const page of $('#pages').querySelectorAll('.page')){
    const lines=viewerLines(JSON.parse(state.sourceDoc.native.getPageRenderTree(Number(page.dataset.page))),offset);
    offset+=lines.length;
    const badge=document.createElement('span');badge.className='viewer-number';badge.hidden=true;badge.setAttribute('aria-hidden','true');page.append(badge);
    page.onpointermove=event=>{const rect=page.getBoundingClientRect(),x=(event.clientX-rect.left)/scale,y=(event.clientY-rect.top)/scale;
      const line=lineAt(lines,x,y);badge.hidden=!line;
      if(line){badge.textContent=String(line.number);badge.style.left='2px';badge.style.top=(line.y*scale)+'px';}
    };
    page.onpointerleave=()=>{badge.hidden=true;};
  }
}

async function copyBody() {
  if (state.busy || typeof state.output?.text !== 'string') return;
  const output = state.output, text = output.text, session = state.session, revision = state.revision, ticket = bodyCopies.begin();
  const current = () => bodyCopies.current(ticket) && session === state.session && revision === state.revision && state.output === output;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard');
    await navigator.clipboard.writeText(text);
    if (!current()) return;
    status('생성한 본문을 복사했습니다. 결재 창에 붙여넣을 수 있습니다.', 'success');
  } catch {
    if (!current()) return;
    $('#body-result-panel').hidden = false; $('#body-result').open = true;
    const input = $('#body-text'); input.value = text; input.focus(); input.select();
    status('브라우저가 복사를 허용하지 않았습니다. 선택된 본문을 Ctrl+C로 복사해주세요.', 'error');
  }
}
$('#copy-body').addEventListener('click', copyBody);

const editor=$('#document-editor');
function typed(){
  if(state.busy||editor.value===state.layout.text)return;
  const caret={start:editor.selectionStart,end:editor.selectionEnd},diff=editorChange(state.layout.text,editor.value);
  try{const next=replaceEditorText(state.paragraphs,editorWork(),diff.start,diff.end,diff.value,'b-'+crypto.randomUUID());remember();setWork(next);state.caret=caret;changed();renderEditor();editor.setSelectionRange(caret.start,caret.end);captureCaret(false);status('');}
  catch(error){renderEditor();const c=state.caret; if(c)editor.setSelectionRange(c.start,c.end);status(errorMessage(error),'error');}
}
editor.addEventListener('input',event=>{if(!event.isComposing)typed();});editor.addEventListener('compositionend',typed);
for(const type of ['mouseup','keyup','select'])editor.addEventListener(type,()=>captureCaret());
editor.addEventListener('contextmenu',event=>{event.preventDefault();captureCaret();state.comparisonText='';$('#menu-key').value=$('#key-select').value;showMenu(event.clientX,event.clientY);});
$('#menu-key').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();action('menuKey');}});
new ResizeObserver(()=>{if(state.session)renderEditor();}).observe($('#editor-scroll'));
new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes].some(n=>n instanceof Element&&(n.classList.contains('page')||n.classList.contains('page-img')))))renderViewerNumbers();}).observe($('#pages'),{childList:true,subtree:true});
function sourceSelection(){
  const selection=window.getSelection();if(!selection||selection.isCollapsed||!selection.anchorNode||!selection.focusNode)return false;
  const line=node=>(node.nodeType===1?node:node.parentElement)?.closest('[data-source-id]');const from=line(selection.anchorNode),to=line(selection.focusNode);
  if(!from||!to)return false;
  const x=state.layout.units.find(u=>state.paragraphs.slice(u.from,u.to+1).some(r=>r.id===from.dataset.sourceId)),y=state.layout.units.find(u=>state.paragraphs.slice(u.from,u.to+1).some(r=>r.id===to.dataset.sourceId));if(!x||!y)return false;
  const first=x.start<=y.start?x:y,last=x.start<=y.start?y:x;state.chosen=first.id;state.caret={start:first.start,end:last.end};editor.setSelectionRange(first.start,last.end);markEditorSelection();highlightTextRow(first.id);controls();return true;
}
$('#pages').addEventListener('mouseup',()=>{if(state.viewMode==='source'&&state.kind==='text')sourceSelection();});
$('#pages').addEventListener('click',event=>{const line=event.target instanceof Element?event.target.closest('[data-source-id]'):null;if(line&&!sourceSelection())selectRow(line.dataset.sourceId,{fromPick:true});});
$('#pages').addEventListener('contextmenu',event=>{
  if(state.viewMode==='comparison'){event.preventDefault();state.comparisonText=window.getSelection()?.toString()||event.target.closest('.text-line')?.querySelector('.source-text')?.textContent||'';showMenu(event.clientX,event.clientY);return;}
  const line=event.target instanceof Element?event.target.closest('[data-source-id]'):null;if(!line)return;event.preventDefault();if(!sourceSelection())selectRow(line.dataset.sourceId,{fromPick:true});state.comparisonText='';$('#menu-key').value=$('#key-select').value;showMenu(event.clientX,event.clientY);
});
$('#open-comparison').addEventListener('click',()=>$('#compare-file').click());
$('#comparison-view').addEventListener('click',()=>{if(state.comparison)renderTextDocument('comparison');else $('#compare-file').click();});
$('#compare-file').addEventListener('change',async event=>{
  const file=event.target.files[0];event.target.value='';if(!file||state.busy)return;const session=state.session;setBusy(true,'비교 문서 여는 중');
  try{const result=await api('compare',{name:file.name,content:base64(new Uint8Array(await file.arrayBuffer()))});if(session!==state.session)return;state.comparison={name:result.name,paragraphs:result.paragraphs};renderTextDocument('comparison');status('');}
  catch(error){status(errorMessage(error),'error');}finally{setBusy(false);}
});

async function previewPlacement(item){
  const range=blockSelection(),placement={id:item.protoId,version:item.version,...range},session=state.session,revision=state.revision;
  const result=await api('block-placement-preview',{...snapshot(),placements:[...state.placements,placement]});
  return {...result,commit(){
    if(session!==state.session||revision!==state.revision)throw Error('문서가 바뀌었습니다. 넣을 범위를 다시 확인하세요.');
    remember();state.placements.push(placement);state.placementNames[placement.id]=item.name;state.placementWarnings[placement.id+':'+placement.from]=result.warnings;changed();renderEditor();void generate();
  }};
}
function renderPlacements(){
  const box=$('#block-placements');box.replaceChildren();box.hidden=!state.placements.length;
  if(!state.placements.length)return;
  const title=document.createElement('strong');title.textContent='배치한 블록 · 생성 결과에만 반영';box.append(title);
  for(const [i,p] of state.placements.entries()){
    const row=document.createElement('div'),label=document.createElement('span'),remove=document.createElement('button');
    label.textContent=(state.placementNames[p.id]??'저장 블록')+' · 판 '+p.version+' · 문단 '+(state.paragraphs.findIndex(r=>r.id===p.from)+1)+'–'+(state.paragraphs.findIndex(r=>r.id===p.to)+1);
    remove.type='button';remove.textContent='배치 취소';remove.disabled=state.busy;remove.onclick=()=>{remember();state.placements.splice(i,1);changed();renderEditor();};row.append(label,remove);box.append(row);for(const message of state.placementWarnings[p.id+':'+p.from]??[]){const note=document.createElement('p');note.className='placement-warning';note.textContent=message;box.append(note);}
  }
}
function uiNode(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function headingOf(id){const index=state.paragraphs.findIndex(p=>p.id===id);return state.outline.filter(h=>state.paragraphs.findIndex(p=>p.id===h.id)<=index).at(-1);}
function renderHeadingTree(){
  const tree=$('#heading-tree');tree.replaceChildren();const parents=[];
  for(const h of state.outline){const d=uiNode('details',undefined,'heading-node');d.dataset.row=h.id;const summary=uiNode('summary',h.name);summary.style.paddingLeft=Math.min(3,Math.max(0,h.level-1))*8+'px';d.append(summary);
    const jump=uiNode('button','원문으로');jump.type='button';jump.onclick=()=>{selectRow(h.id);setCurrentHeading(h.id);};d.append(jump);while(parents.length&&parents.at(-1).level>=h.level)parents.pop();(parents.at(-1)?.node??tree).append(d);parents.push({level:h.level,node:d});
    summary.addEventListener('click',e=>{e.preventDefault();setCurrentHeading(h.id);});
  }
  if(!state.outline.length)tree.append(uiNode('p',state.session?'찾은 제목이 없습니다.':'문서를 열면 제목 흐름이 보입니다.','rail-empty'));
}
function setCurrentHeading(id){const nodes=[...$('#heading-tree').querySelectorAll('.heading-node')],chosen=nodes.find(el=>el.dataset.row===id);for(const el of nodes){const open=el===chosen||Boolean(chosen&&el.contains(chosen));if(el.open!==open)el.open=open;}if(chosen){const root=$('#heading-tree'),r=chosen.getBoundingClientRect(),box=root.getBoundingClientRect();if(r.top<box.top||r.top>box.bottom)root.scrollTop+=r.top-box.top;}}
function followHeading(){
  if(!state.session)return;
  if(state.kind==='text'){const rows=[...$('#editor-mirror').children],top=$('#editor-scroll').getBoundingClientRect().top+40;const row=rows.find(el=>el.getBoundingClientRect().bottom>=top);setCurrentHeading(headingOf(row?.dataset.id)?.id);return;}
  if(state.viewMode!=='source'||!state.sourceDoc)return;
  const top=$('#page-scroll').getBoundingClientRect().top+80,scale=Number($('#scale').value);let current;
  for(const page of $('#pages').querySelectorAll('.page')){const r=page.getBoundingClientRect();if(r.top>top)break;const runs=state.sourceDoc.pageLayout(Number(page.dataset.page)).runs;
    for(const h of state.outline){const pos=paragraph(h.id)?.position;if(!pos)continue;const run=runs.find(v=>{const p=runPosition(v);return p&&sameParagraph(p,pos);});if(run&&r.top+run.y*scale<=top)current=h.id;}
  }
  setCurrentHeading(current??state.outline[0]?.id);
}
/** 입력 항목이 문서에 있는 모양(추천 목록의 보조 표지). 종류 약자(입력·블록·분기·위치)는 그대로 둔다 */
const FORMS={clickHere:'누름틀',mailMerge:'메일머지'};
const inputItems=()=>state.recommendations.filter(r=>r.kind==='input');
const rowOrder=()=>new Map(state.paragraphs.map((p,i)=>[p.id,i]));
/** 입력 항목 한 줄(추천 목록·표 보기·꼬리표가 같은 객체를 본다). 위치는 원문 줄 글 기준 [start, end) */
function itemRec(x,unusable=false){
  const text=paragraph(x.row)?.text??'';
  // 앞뒤 글(#148)은 지정할 때 담는다. 저장한 항목은 저장한 것을 쓴다
  return {...contextAround(text,x.start,x.end),...x,id:x.origin+':'+x.row+':'+x.start+':'+x.end,kind:'input',keyAuto:false,...(isField(x.origin)?{form:x.origin}:{}),...(unusable?{unusable:true}:{}),
    excerpt:(unusable?'이름 규칙 밖 · ':'')+text.slice(Math.max(0,x.start-8),x.end+20).replaceAll('\uFFFC','')};
}
function sortRecs(){const order=rowOrder(),inputs=inputItems().sort((a,b)=>(order.get(a.row)??0)-(order.get(b.row)??0)||a.start-b.start||a.end-b.end);state.recommendations=[...inputs,...state.recommendations.filter(r=>r.kind!=='input')];}
function buildReview(opened){
  // 입력 항목 후보는 서버가 문서 순서로 준다: 누름틀·메일머지(form)와 그 표시 글 밖의 {{키}}. 표시 글 안 {{키}}는 필드가 맡아 따로 오르지 않는다
  const candidates=(opened.inputs??[]).map(x=>{const name=x.kind==='placeholder'?x.name.trim():x.name,span=paragraph(x.row)?.text.slice(x.start,x.end)??'';return itemRec({row:x.row,start:x.start,end:x.end,name,key:x.usable===false?'':name,type:suggestType(span,name||x.label?.text).type,...(x.label?{label:x.label}:{}),status:'recommended',origin:x.kind},x.usable===false);});
  // 다시 연 작업: 저장한 이름·키·타입·상태를 같은 자리의 후보에 얹고, 사용자가 지정한 것은 새 줄로 더한다
  const {items,dropped}=mergeSaved(candidates,opened.inputItems??[],saved=>itemRec(saved));
  state.recommendations=items;
  state.recommendations.push(...(opened.blockCandidates??[]).map((c,i)=>({id:'block:'+i,row:c.from,to:c.to,name:c.name,kind:'block',status:'recommended',excerpt:c.paragraphCount+'문단 · '+(state.paragraphs.slice(state.paragraphs.findIndex(p=>p.id===c.from)+1,state.paragraphs.findIndex(p=>p.id===c.to)+1).find(p=>p.text.trim())?.text.slice(0,60)??'본문 없음')})));
  sortRecs();return dropped;
}
function renderRecommendations(){
  const root=$('#recommendations');root.replaceChildren();const groups=new Map();
  for(const r of state.recommendations){const h=headingOf(r.row),key=h?.id??'document';if(!groups.has(key))groups.set(key,{name:h?.name??'문서',items:[]});groups.get(key).items.push(r);}
  for(const {name,items} of groups.values()){const d=uiNode('details',undefined,'rec-group');d.open=true;d.append(uiNode('summary',name+' · '+items.length));
    for(const r of items){const label=r.name||'(이름 없음)',line=uiNode('div',undefined,'rec-line'+(r.status==='excluded'?' excluded':''));line.dataset.review=r.id;const check=uiNode('input');check.type='checkbox';check.checked=r.status!=='excluded';check.disabled=state.busy||r.status==='confirmed';check.dataset.confirmed=String(r.status==='confirmed');check.setAttribute('aria-label',label+' 유지');check.onchange=()=>reviewChange([r],check.checked?'keep':'excluded');
      const kind=({input:'입력',block:'블록',branch:'분기',place:'위치'})[r.kind],button=uiNode('button',label,r.unusable?'rec-unusable':undefined);button.type='button';button.title=label+' · '+(r.unusable?'이름이 데이터 키 규칙 밖이라 자동으로 채우지 않습니다 · ':'')+r.excerpt;button.onclick=()=>selectRecommendation(r);
      const excerpt=uiNode('span',r.excerpt,'rec-excerpt');excerpt.title=r.excerpt;const form=r.form?[uiNode('span',FORMS[r.form],'form-tag')]:[];line.append(check,uiNode('span',kind,'kind-tag kind-'+r.kind),...form,button,excerpt,uiNode('small',STATUS_LABEL[r.status]));d.append(line);}
    const actions=uiNode('div',undefined,'group-actions');for(const [label,status] of [['묶음 제외','excluded'],['묶음 되돌리기','keep']]){const b=uiNode('button',label);b.type='button';b.onclick=()=>reviewChange(items,status);actions.append(b);}d.append(actions);root.append(d);
  }
  if(!groups.size)root.append(uiNode('p',state.session?'추천 없음 · 원문에서 직접 고를 수 있습니다.':'문서를 열면 추천이 표시됩니다.','rail-empty'));
  $('#review-undo').disabled=state.busy||!state.reviewHistory.length;
  const blocks=state.recommendations.filter(r=>r.kind==='block'),checked=blocks.filter(r=>r.status==='recommended');const save=$('#save-checked-blocks');save.hidden=!blocks.length;save.disabled=state.busy||!checked.length;save.textContent='체크한 블록 '+checked.length+'개 저장';
}
/** 유지/제외 바꾸기. 유지로 되돌리면 사용자가 지정한 것은 지정, 문서에서 찾은 것은 추천이다. 확정한 줄은 바꾸지 않는다 */
function reviewChange(items,next){if(state.busy)return;state.reviewHistory.push(new Map(state.recommendations.map(r=>[r.id,r.status])));for(const r of items)if(r.status!=='confirmed')r.status=next==='keep'?(r.kind==='input'?keptStatus(r.origin):'recommended'):next;if(items.some(r=>r.kind==='input'))touched();renderInputs();controls();}
/** 항목 자리를 편집 글(숨은 편집 창) 위의 선택으로 옮긴다. 확정한 항목은 그 {{키}} 자리다 */
function caretToItem(r){
  const at=r.start===undefined?undefined:itemCaret(r);if(!at)return;
  state.caret=at;$('#document-editor').setSelectionRange(at.start,at.end);markEditorSelection();
}
async function selectRecommendation(r){
  selectRow(r.row);await showRowInSource(r.row);const unit=state.layout.units.find(u=>u.id===r.row);
  if(r.kind==='input')caretToItem(r);
  if(r.kind==='block'&&unit){const end=state.layout.units.find(u=>u.id===r.to);if(end){state.caret={start:unit.start,end:end.end};$('#document-editor').setSelectionRange(unit.start,end.end);state.blockPick={...state.caret,from:r.row,to:r.to,blocked:false};
    const rows=state.paragraphs.slice(state.paragraphs.findIndex(p=>p.id===r.row),state.paragraphs.findIndex(p=>p.id===r.to)+1);state.view?.setMarks(rows.filter(p=>p.position).map(p=>({id:p.id,kind:'selection',position:p.position,endOffset:p.text.length})));}}
  state.activeRecommendation=r;if(r.kind==='input')state.currentItem=r.id;$('#detail-name').value=r.name;state.detailDrafts.set(r.row,{name:r.name,key:r.key??''});renderSelectionDetail(true);if(r.kind==='block'){$('#detail-title').textContent='블록 후보';$('#detail-excerpt').textContent=r.excerpt;$('#confirm-input').hidden=true;}else $('#confirm-input').hidden=false;controls();showRemote();
}
function renderSelectionDetail(force=false){
  if(state.detailLibrary)return;
  blockLibraryUI.dispose($('#detail-library-tools'));$('#detail-library-tools').replaceChildren();
  const row=paragraph(state.chosen);$('#detail-content').dataset.kind=state.activeRecommendation?.kind??'input';$('#detail-form').hidden=!row;$('#confirm-input').hidden=state.activeRecommendation?.kind==='block';
  if(!row){$('#detail-title').textContent='선택 상세';$('#detail-location').textContent='먼저 부분을 고르세요';$('#detail-excerpt').textContent='';return;}
  const detailId=row.id+':'+state.caret?.start+':'+state.caret?.end;if(state.detailId===detailId&&!force)return;
  state.detailId=detailId;const h=headingOf(row.id),active=state.activeRecommendation?.row===row.id?state.activeRecommendation:undefined;$('#detail-title').textContent='입력 항목 편집';$('#detail-location').textContent=(state.kind==='text'?'줄 '+(state.paragraphs.indexOf(row)+1):'쪽 미확인')+' · '+(h?.name??'문서')+(currentPick()?.span?' · '+spanLabel(currentPick().span):'')+(active?.kind==='input'?' · '+STATUS_LABEL[active.status]:'');$('#detail-excerpt').textContent=(state.caret?state.layout.text.slice(state.caret.start,state.caret.end):row.text).slice(0,160);$('#confirm-input').disabled=!(row.editable||active?.kind==='input'&&active.origin!=='user')||state.busy;
  const draft=state.detailDrafts.get(row.id)??{name:active?.name??'',key:active?.key??''};$('#detail-name').value=draft.name;
  // 데이터 키 목록(쓸 수 있는 경로). 항목에 이미 있는 키가 데이터에 없으면 그 키도 고를 수 있게 둔다
  const select=$('#detail-key');select.replaceChildren();const empty=uiNode('option',state.keys.length?'연결할 데이터 항목 선택':'데이터를 먼저 올리세요');empty.value='';select.append(empty);const paths=rankedKeys(active?.kind==='input'?active:undefined);for(const key of draft.key&&!paths.includes(draft.key)?[draft.key,...paths]:paths){const option=uiNode('option',key);option.value=key;select.append(option);}select.value=draft.key;$('#detail-value').textContent=linkNote(active?.kind==='input'?active.status:undefined,draft.key);
}
function openInputDetail(data=false){document.body.classList.remove('detail-collapsed');$('#detail-toggle').textContent='접기';$('#detail-toggle').setAttribute('aria-expanded','true');renderSelectionDetail(true);if(data&&!state.keys.length){$('#data-menu').open=true;$('#load-data-text').focus();}else $(data?'#detail-key':'#detail-name').focus();}
/** 저장할 것이 바뀌었지만 생성 결과는 그대로인 변경(지정·이름·상태) */
function touched(){state.dirty=true;$('#dirty-state').hidden=false;}
function dataPaths(){return state.keys.filter(k=>k.usable).map(k=>k.path);}
/** 이름 = 데이터 키면 키 칸을 자동으로 채운다(확정 전 항목만. 누름틀·메일머지는 필드 이름이 키) */
function applyAutoKeys(){const paths=dataPaths();for(const r of inputItems())if(r.status!=='confirmed'&&!isField(r.origin)){const a=autoKey(r.name,r.key,r.keyAuto,paths);r.key=a.key;r.keyAuto=a.auto;}}
function inRange(list,id){const order=rowOrder(),i=order.get(id);return list.some(b=>i>=order.get(b.from)&&i<=order.get(b.to));}
/** 지금 선택(편집 글 위치)을 원문 줄의 자리로. 한 문단 안, 직접 편집할 수 있는 줄, 확정한 {{키}}·고친 글에 걸치지 않아야 한다 */
function itemSpanFromCaret(){
  const c=state.caret;if(!c)throw Error('원문에서 입력 항목으로 쓸 글을 고르세요.');
  const units=editorSelection(state.layout,c.start,c.end),u=units[0];
  if(units.length!==1||u.block||u.from!==u.to)throw Error('입력 항목은 한 문단 안에서 고르세요.');
  const row=state.paragraphs[u.from];if(!row.editable)throw Error(reasonOf(row.reason));
  const at=toOriginal(row.text,textOf(row),repsOf(inputItems(),row.id,row.text),c.start-u.start,c.end-u.start);
  if(!at)throw Error('이미 확정한 입력 항목이나 고친 글과 겹칩니다. 원문 그대로인 글을 고르세요.');
  return {row:row.id,...at};
}
const MIXED='글자 모양이 다른 글에 걸쳐 있어 이 자리에는 넣을 수 없습니다. 같은 모양의 값 부분만 끌어 고르세요.';
/** 글자 모양이 섞인 줄(HWPX)은 바뀌는 구간이 한 모양 안이어야 생성된다. 서버의 같은 판정으로 미리 본다 */
async function rangeProblem(row,span){
  if(state.kind!=='hwpx'||row.rangeEditable)return;
  const result=await api('check-input',{session:state.session,row:row.id,...span});
  return result.ok?undefined:result.code==='WORKBENCH_STRUCTURE_READONLY'?reasonOf(result.code):MIXED;
}
/** 이름 없이도 지정한다(상태 "지정"). 고른 자리가 이미 목록에 있으면 그 줄을 쓴다 */
async function designate(name=''){
  if(state.busy||!state.session)return;
  let r=state.activeRecommendation?.kind==='input'?state.activeRecommendation:undefined;
  if(!r){const at=itemSpanFromCaret();r=inputItems().find(x=>x.row===at.row&&x.start===at.start&&x.end===at.end);
    if(!r&&inputItems().some(x=>x.row===at.row&&x.status!=='excluded'&&(x.start<at.end&&at.start<x.end||x.start===at.start)))throw Error('이미 지정한 자리와 겹칩니다. 목록에서 그 줄을 고르세요.');
    if(!r){const session=state.session,revision=state.revision;
      // 글자 모양 검사와 가까운 라벨(#148: 같은 문단 앞 "라벨:" → 같은 표 행 왼쪽 라벨 칸 → 위 제목)을 함께 묻는다
      const [problem,found]=await Promise.all([rangeProblem(paragraph(at.row),{start:at.start,end:at.end}),api('item-label',{session,...at}).catch(()=>({}))]);
      if(session!==state.session||revision!==state.revision)return;if(problem)throw Error(problem);
      remember();r=itemRec(designated(at,found.label));retype(r);state.recommendations.push(r);sortRecs();}
    else remember();}
  else remember();
  if(name.trim()){r.name=name.trim();r.nameAuto=false;retype(r);}
  if(r.status!=='confirmed')r.status=r.status==='excluded'?keptStatus(r.origin):r.origin==='user'?'designated':r.status;
  if(!isField(r.origin)&&r.status!=='confirmed'){const a=autoKey(r.name,r.key,r.keyAuto,dataPaths());r.key=a.key;r.keyAuto=a.auto;}
  state.activeRecommendation=r;state.currentItem=r.id;touched();renderInputs();controls();return r;
}
/** 원문 그 자리의 글(항목 위치는 늘 원문 기준) */
const spanText=r=>paragraph(r.row)?.text.slice(r.start,r.end)??'';
/** 타입 다시 추천: 사용자가 고르지 않은 지정 항목만(고른 타입은 추천으로 덮지 않는다, #147) */
function retype(r){if(r.origin==='user'&&!r.typeSet)r.type=suggestType(spanText(r),r.name||r.label?.text||'').type;}
/** 데이터 키 후보를 이 항목에 맞게 정렬(#147·#148): 이름·라벨이 같은 키 먼저, 같은 순위면 타입이 맞는 키(견본 값·키 이름으로 본 타입) */
function rankedKeys(r){const paths=dataPaths();return r?rankKeys(paths,{name:r.name,label:r.label?.text,type:r.type},p=>suggestType(state.samples[p]??'',p).type):paths;}
function orderKeyList(r){$('#data-keys').replaceChildren(...rankedKeys(r).map(p=>{const o=uiNode('option',p);o.value=p;return o;}));}
/** 항목이 지금 편집 글(숨은 편집 창)에서 차지하는 자리 */
function itemCaret(r){
  const unit=state.layout.units.find(u=>u.id===r.row),row=paragraph(r.row);if(!unit||!row)return;
  const clean=o=>row.text.slice(0,o).replaceAll('\uFFFC','').length;
  const at=row.editable?spanNow(row.text,textOf(row),repsOf(inputItems(),row.id,row.text),r.start,r.end):{start:clean(r.start),end:clean(r.end)};
  return at&&{start:unit.start+at.start,end:unit.start+at.end};
}
/** "참고 글 지정" 대상: 지금 항목(마지막으로 지정·고른 입력 항목)이 있고, 고른 글이 그 항목 자기 자리가 아닐 때 */
function labelTarget(){
  const c=state.caret;if(!state.currentItem||!c||!state.chosen)return;const r=inputItems().find(x=>x.id===state.currentItem);if(!r)return;
  const own=state.chosen===r.row?itemCaret(r):undefined;if(own&&own.start===c.start&&own.end===c.end)return;
  return r;
}
/** 참고 글 지정(#148): 고른 글을 지금 항목의 라벨로(관계 "참고 글", 거리는 몇 문단 떨어졌는지). 이름이 비었거나 추천 이름이면 라벨에서 다시 추천 */
function pickLabel(){
  const r=labelTarget();if(!r||state.busy)return;const c=state.caret,flat=t=>t.replaceAll('\uFFFC','').replace(/\s+/g,' ').trim();
  const text=(flat(state.layout.text.slice(c.start,c.end))||flat(paragraph(state.chosen)?.text??'')).slice(0,LABEL_MAX);if(!text)return;
  const order=rowOrder();remember();r.label={text,rel:'manual',distance:Math.abs((order.get(state.chosen)??0)-(order.get(r.row)??0))};
  nameFromLabel(r);retype(r);if(!isField(r.origin)&&r.status!=='confirmed'){const a=autoKey(r.name,r.key,r.keyAuto,dataPaths());r.key=a.key;r.keyAuto=a.auto;}
  hideMenu();touched();renderInputs();controls();status('"'+text+'"을(를) '+(r.name||'이름 없는')+' 항목의 참고 글로 지정했습니다. 원문은 그대로입니다.');
}
/**
 * 확정(✓): 이름과 데이터 키를 정하고, 누름틀·메일머지·같은 키의 {{키}}가 아니면 그 자리 글을 {{키}}로 바꾼 편집을 만든다(원문 탭은 그대로, 생성 결과에만 반영).
 * 줄마다 한꺼번에 바꾸며, 고친 글·블록 범위·서로 다른 글자 모양에 걸치거나 겹치는 줄은 확정하지 않고 이유를 돌려준다. 실행 취소는 한 번에 되돌린다.
 */
async function confirmItems(list){
  if(state.busy||!state.session)return {done:0,failed:[]};
  // 계획(이름·키 검사, 줄마다 {{키}}로 바꾼 새 글)은 시험과 같은 코드(`planConfirm`)다. 직접 편집할 수 없는 줄·블록 범위는 이유와 함께 남긴다
  const plan=planConfirm(inputItems(),list,id=>{const row=paragraph(id);
    return {text:row.text,current:textOf(row),...(!row.editable?{blocked:reasonOf(row.reason)}:inRange(state.blocks,id)||inRange(state.placements,id)?{blocked:'블록으로 바꾼 범위입니다. 블록을 풀거나 배치를 취소한 뒤 확정하세요.'}:{})};});
  // 글자 모양이 섞인 줄: 생성 때와 같이 원문과 새 글의 바뀐 한 구간을 서버에서 검사한다
  const session=state.session,revision=state.revision;
  const problems=await Promise.all([...plan.texts].map(async([id,text])=>{const span=changedSpan(paragraph(id).text,text);return [id,span?await rangeProblem(paragraph(id),span):undefined];}));
  if(session!==state.session||revision!==state.revision)return {done:0,failed:[...plan.failed,...plan.ready.map(x=>[x.item,'문서가 바뀌었습니다. 다시 확정하세요.'])]};
  for(const [id,problem] of problems)if(problem)dropRow(plan,id,problem);
  if(!plan.ready.length)return {done:0,failed:plan.failed};
  remember();
  for(const [id,text] of plan.texts){if(text===paragraph(id).text)state.edits.delete(id);else state.edits.set(id,text);}
  commitConfirm(plan.ready);for(const x of plan.ready)state.detailDrafts.set(x.item.row,{name:x.name,key:x.key});
  if(plan.texts.size){changed();renderEditor();}else touched();
  renderInputs();controls();return {done:plan.ready.length,failed:plan.failed};
}
function reportConfirm(result,one){
  if(one&&result.done)status(one+' 입력 항목을 확정했습니다. 원문은 그대로입니다.','success');
  else if(!result.failed.length)status('입력 항목 '+result.done+'개를 확정했습니다. 원문은 그대로입니다.','success');
  else status((result.done?'확정 '+result.done+'개 · ':'')+'남김 '+result.failed.length+'개 · '+result.failed.slice(0,3).map(([r,why])=>(r.name||'이름 없음')+': '+why).join(' / '),'error');
}
async function confirmInput(name,key){
  try{const r=await designate(name);if(!r)return;const result=await confirmItems([{item:r,name,key:key||r.key}]);reportConfirm(result,result.done?r.name:'');if(result.done)hideMenu();}
  catch(error){status(errorMessage(error),'error');}
}
async function designateOnly(name){
  try{const r=await designate(name);if(!r)return;hideMenu();status(r.status==='confirmed'?'이미 확정한 입력 항목입니다.':(r.name||'이름 없는')+' 입력 항목을 지정했습니다. 원문은 그대로입니다.');if(state.tableOpen)focusTableRow(r,'name');}
  catch(error){status(errorMessage(error),'error');}
}
/** 꼬리표·강조: 지정·확정한 항목. 강조는 원문 글자 구간이 맞을 때만 그린다(글이 다르면 그리지 않는 뷰어 표식) */
const tagged=()=>inputItems().filter(r=>r.status==='confirmed'||r.status==='designated');
function itemMarks(){return tagged().flatMap(r=>{const row=paragraph(r.row),p=row?.position,text=row?.text.slice(r.start,r.end)??'';if(!p||!text||text.includes('\uFFFC'))return [];const at=p.charOffset??0;return [{id:'item:'+r.id,kind:r.status==='confirmed'?'chosen':'range',position:{...p,charOffset:at+r.start},endOffset:at+r.end,text}];});}
function displaySourceMarks(marks=[]){state.view?.setMarks([...itemMarks(),...flagMarks(),...marks]);renderSourceTags();}
function renderSourceTags(){
  for(const el of $('#pages').querySelectorAll('.source-tag,.confirmed-overlay'))el.remove();
  if(state.kind!=='hwpx'||state.viewMode!=='source'||!state.sourceDoc)return;const scale=Number($('#scale').value);
  for(const page of $('#pages').querySelectorAll('.page')){const runs=state.sourceDoc.pageLayout(Number(page.dataset.page)).runs,used=[];
    for(const item of tagged()){const pos=paragraph(item.row)?.position;if(!pos)continue;const run=runs.find(r=>{const p=runPosition(r);return p&&sameParagraph(p,pos);});if(!run)continue;
      const label=(item.name||'이름 없음')+' · '+STATUS_LABEL[item.status],tag=uiNode('button',label,'source-tag'+(item.status==='designated'?' designated-tag':''));tag.type='button';tag.title=label;tag.style.left=run.x*scale+'px';tag.style.top=Math.max(0,run.y*scale-18)+'px';tag.onclick=()=>state.tableOpen?focusTableRow(item,'name'):void selectRecommendation(item);page.append(tag);
      const rect=tag.getBoundingClientRect();if(used.some(r=>r.left<rect.right&&r.right>rect.left&&r.top<rect.bottom&&r.bottom>rect.top)){tag.classList.add('margin-tag');tag.textContent='입력';}used.push(tag.getBoundingClientRect());
    }
  }
}
/** 추천 목록·표 보기·원문 꼬리표를 같은 상태로 다시 그린다 */
function renderInputs(){renderRecommendations();renderInputTable();renderKeyNotice();displaySourceMarks(state.chosen?state.marks.get(state.chosen)??[]:[]);}
let listFrame;
function scheduleList(){cancelAnimationFrame(listFrame);listFrame=requestAnimationFrame(()=>{renderRecommendations();renderSourceTags();});}
async function loadSample(){
  const session=state.session,index=state.index,ticket=samples.begin();
  if(!session||!state.records){state.samples={};renderInputTable();return;}
  try{const result=await api('sample',{session,index});if(!samples.current(ticket)||session!==state.session||index!==state.index)return;state.samples=result.values??{};renderInputTable();}
  catch{if(samples.current(ticket)&&session===state.session){state.samples={};renderInputTable();}}
}
/* 표 보기(크게 보기): 입력 항목 한 줄씩. 이름·키는 바로 적고 Enter/↓로 다음 줄, ✓로 확정. 줄에 들어가면 원문 그 자리로 이동·강조 */
function openTable(){if(!state.session)return;hideMenu();state.tableOpen=true;state.tableRow=undefined;document.body.classList.add('table-open');$('#input-table').hidden=false;renderInputTable();const first=inputItems().find(r=>r.status!=='confirmed'&&r.status!=='excluded')??inputItems()[0];if(first)focusTableRow(first,'name');}
function closeTable(){state.tableOpen=false;state.tableRow=undefined;document.body.classList.remove('table-open');$('#input-table').hidden=true;renderRecommendations();}
function focusTableRow(r,field){const tr=$('#input-rows').querySelector('tr[data-item="'+CSS.escape(r.id)+'"]');const el=tr?.querySelector('[data-field="'+field+'"]');if(el){el.focus();el.scrollIntoView({block:'nearest'});showItem(r);}}
function showItem(r){
  if(state.tableRow===r.id)return;state.tableRow=r.id;
  for(const tr of $('#input-rows').querySelectorAll('tr'))tr.classList.toggle('current',tr.dataset.item===r.id);
  if(!selectRow(r.row))return;caretToItem(r);state.activeRecommendation=r;state.currentItem=r.id;controls();
}
function renderInputTable(){
  if(!state.tableOpen)return;
  const body=$('#input-rows'),active=document.activeElement,focus=body.contains(active)?{id:active.closest('tr')?.dataset.item,field:active.dataset.field,start:active.selectionStart,end:active.selectionEnd}:undefined;
  body.replaceChildren();const items=inputItems(),paths=dataPaths();
  for(const r of items){
    const row=paragraph(r.row),tr=uiNode('tr',undefined,'status-row-'+r.status+(r.id===state.tableRow?' current':''));tr.dataset.item=r.id;
    const aria=rowAria(r.name),keep=uiNode('input',undefined,'item-keep');keep.type='checkbox';keep.checked=r.status!=='excluded';keep.disabled=state.busy||r.status==='confirmed';keep.setAttribute('aria-label',aria.keep);keep.onchange=()=>reviewChange([r],keep.checked?'keep':'excluded');
    // 원문 글: 라벨(#148)과 지정할 때 담은 앞뒤 글(회색). 칸에는 앞뒤 일부만, 전체는 풍선 도움말에
    const span=spanText(r),before=r.before??'',after=r.after??'',ctx=contextOf(before+span+after,before.length,before.length+span.length,16),source=uiNode('span',undefined,'ctx');
    if(r.label){const tag=uiNode('span',(r.label.text.length>14?r.label.text.slice(0,13)+'…':r.label.text)+' · '+REL_LABEL[r.label.rel],'label-tag');tag.title=labelTitle(r.label);source.append(tag,' ');}
    source.append(uiNode('span',ctx.before,'ctx-side'),uiNode('b',ctx.target||'(빈 자리)'),uiNode('span',ctx.after,'ctx-side'));
    source.title=(r.label?labelTitle(r.label)+'\n':'')+before+'['+span.replaceAll('\uFFFC','')+']'+after;
    const name=uiNode('input',undefined,r.nameAuto?'auto':undefined);name.type='text';name.dataset.field='name';name.value=r.name;name.autocomplete='off';name.setAttribute('aria-label','이름');if(r.nameAuto)name.title='라벨에서 온 이름 · 추천(✓로 확정)';
    const key=uiNode('input',undefined,r.keyAuto?'auto':undefined);key.type='text';key.dataset.field='key';key.value=r.key;key.autocomplete='off';key.spellcheck=false;key.setAttribute('list','data-keys');key.setAttribute('aria-label','데이터 키');
    // 누름틀·메일머지는 글을 바꾸지 않으므로 확정한 뒤에도 연결할 데이터 키를 바꿀 수 있다(#149)
    key.readOnly=r.status==='confirmed'&&!isField(r.origin)||r.origin==='placeholder'&&!row?.editable;if(r.keyAuto)key.title='이름과 같은 데이터 키 · 연결 후보';else if(isField(r.origin))key.title=FORMS[r.origin]+' · 연결할 데이터 키';
    key.onfocus=()=>orderKeyList(r);
    name.oninput=()=>{r.name=name.value;r.nameAuto=false;name.classList.remove('auto');name.title='';const a2=rowAria(r.name);ok.setAttribute('aria-label',a2.ok);keep.setAttribute('aria-label',a2.keep);
      retype(r);showType();if(!isField(r.origin)&&r.status!=='confirmed'){const a=autoKey(r.name,r.key,r.keyAuto,paths);if(a.key!==r.key||a.auto!==r.keyAuto){r.key=a.key;r.keyAuto=a.auto;key.value=a.key;key.classList.toggle('auto',a.auto);key.title=a.auto?'이름과 같은 데이터 키 · 연결 후보':'';}}showSample();touched();scheduleList();};
    // 데이터 키(#149): 같은 이름의 항목도 같은 키를 받는다(같은 이름은 같은 값). 다른 줄의 칸은 다음에 표를 다시 그릴 때 보인다
    key.oninput=()=>{const v=key.value.trim(),group=linkTargets(items,r,v);for(const x of typeof group==='string'?[r]:group){x.key=v;x.keyAuto=false;}key.classList.remove('auto');key.title='';showSample();if(isField(r.origin))changed();else touched();};
    // 견본 값: 데이터가 있으면 고른 업무 건의 값, 없으면 직접 적는다(#149, 같은 값의 줄은 함께 바뀐다). 같은 값을 받는 줄이 여럿이면 "같은 값 n곳"
    const vk=valueKey(r),same=r.status==='excluded'||!vk?0:items.filter(x=>x.status!=='excluded'&&valueKey(x)===vk).length,sample=uiNode(state.records?'span':'input',undefined,'sample'),sampleCell=uiNode('span');
    const showSample=()=>{const k=valueKey(r);if(state.records){sample.textContent=sampleText(r);sample.title=sample.textContent;}else{sample.value=state.typed[k]??'';sample.dataset.vk=k;sample.disabled=!k;}};
    if(!state.records){sample.type='text';sample.dataset.field='sample';sample.autocomplete='off';sample.setAttribute('aria-label','견본 값');
      sample.oninput=()=>{const k=sample.dataset.vk;if(sample.value)state.typed[k]=sample.value;else delete state.typed[k];for(const el of body.querySelectorAll('input[data-field=sample]'))if(el!==sample&&el.dataset.vk===k)el.value=sample.value;changed();};}
    showSample();sampleCell.append(sample,...(same>1?[uiNode('small','같은 값 '+same+'곳','same-value')]:[]));
    // 타입(#147): 7종. 추천은 기울임(원문 모양에서), 고른 것은 보통 글씨이고 다시 추천으로 덮지 않는다. 수량은 원문 단위를 함께 보인다
    const type=uiNode('select');type.dataset.field='type';type.setAttribute('aria-label','타입');
    const showType=()=>{const unit=r.type==='quantity'?suggestType(span).unit:undefined;type.replaceChildren(...VALUE_TYPES.map(v=>{const o=uiNode('option',TYPE_LABEL[v]+(v==='quantity'&&unit?' · '+unit:''));o.value=v;return o;}));type.value=r.type;
      type.classList.toggle('auto',!r.typeSet);type.title=(r.typeSet?'고른 타입':'추천 타입 · 원문 모양에서')+(unit?' · 단위 '+unit:'');};
    showType();type.onchange=()=>{r.type=type.value;r.typeSet=true;showType();touched();};
    const ok=uiNode('button','✓','ok-button');ok.type='button';ok.dataset.locked=String(r.status==='confirmed'||r.status==='excluded');ok.disabled=state.busy||ok.dataset.locked==='true';ok.title=r.status==='confirmed'?'확정됨':'확정';ok.setAttribute('aria-label',aria.ok);
    ok.onclick=async()=>{const result=await confirmItems([{item:r,name:r.name,key:r.key}]);reportConfirm(result,result.done?r.name:'');const rows=inputItems(),next=rows.slice(rows.indexOf(r)+1).find(x=>x.status!=='confirmed'&&x.status!=='excluded');if(result.done&&next)focusTableRow(next,'name');};
    const cells=[keep,source,name,key,sampleCell,type,uiNode('span',STATUS_LABEL[r.status],'status-'+r.status),ok];
    for(const cell of cells){const td=uiNode('td');td.append(cell);tr.append(td);}
    body.append(tr);
  }
  if(!items.length){const tr=uiNode('tr'),td=uiNode('td','원문에서 글을 고르고 리모컨의 "지정"을 누르면 여기에 한 줄씩 생깁니다.','rail-empty');td.colSpan=8;tr.append(td);body.append(tr);}
  const count=s=>items.filter(r=>r.status===s).length;$('#input-table-count').textContent=items.length+'개 · 확정 '+count('confirmed')+' · 지정 '+count('designated');
  if(focus?.id){const el=body.querySelector('tr[data-item="'+CSS.escape(focus.id)+'"] [data-field="'+focus.field+'"]');if(el){el.focus({preventScroll:true});if(focus.start!=null&&'setSelectionRange' in el&&el.type==='text')el.setSelectionRange(focus.start,focus.end);}}
}
const DISTANCE_UNIT={rowHeader:'칸 왼쪽',colon:'자 뒤',heading:'문단 위',manual:'문단 떨어짐'};
/** 라벨 풍선 도움말: 라벨 글 · 관계 · 거리 */
function labelTitle(label){return '라벨 "'+label.text+'" · '+REL_LABEL[label.rel]+(label.distance?' · '+label.distance+DISTANCE_UNIT[label.rel]:'');}
function sampleText(r){if(!state.records||!r.key)return '';return state.samples[r.key]??'—';}
/** 업무 건 이름(#149): 번호와 그 행의 첫 값 */
function caseLabel(i){return (i+1)+'건'+(state.cases[i]?' · '+state.cases[i]:'');}
/** 데이터 연결(#149): 고른 입력 항목(없으면 지금 선택을 지정)에 이을 데이터 키를 리모컨의 목록에서 고른다 */
async function startLink(){
  if(!state.keys.length){openInputDetail(true);status('연결할 데이터를 먼저 올리세요.');return;}
  let r;try{r=await designate();}catch(error){status(errorMessage(error),'error');return;}
  if(!r)return;
  const select=$('#remote-link'),paths=rankedKeys(r),none=uiNode('option','고르세요');none.value='';
  select.replaceChildren(none,...paths.map(p=>{const o=uiNode('option',p);o.value=p;return o;}));select.value=paths.includes(r.key)?r.key:'';
  $('#remote-link-row').hidden=false;showRemote();select.focus();try{select.showPicker();}catch{}
}
/** 항목과 같은 이름의 항목을 함께 데이터 키에 잇는다(같은 이름은 같은 값). 표시 이름·위치는 그대로, 원문도 그대로 */
function linkItem(r,key){
  const group=linkTargets(inputItems(),r,key);if(typeof group==='string'){status(group,'error');return;}
  remember();for(const x of group){x.key=key;x.keyAuto=false;}changed();renderInputs();
  status((r.name||'이름 없는')+' 항목을 '+key+'에 연결했습니다'+(group.length>1?' · 같은 이름 '+group.length+'곳':'')+'. 원문은 그대로입니다.','success');
}
$('#remote-link').onchange=()=>{const r=state.activeRecommendation,key=$('#remote-link').value;if(r?.kind==='input'&&key){linkItem(r,key);hideMenu();}};
/** 데이터를 밀어 넣을 때(8.9-7): 템플릿에만 있는 키는 알리고, 데이터에만 있는 키는 펼쳐야 보인다. 템플릿에만 있는 키 수를 돌려준다 */
function renderKeyNotice(){
  const note=$('#key-notice'),extra=$('#data-only'),paths=state.keys.map(k=>k.path),usable=dataPaths();
  const used=[...new Set(inputItems().filter(r=>r.status!=='excluded').map(valueKey).filter(Boolean))],missing=state.records?used.filter(k=>!paths.includes(k)):[],only=state.records?usable.filter(p=>!used.includes(p)):[];
  note.hidden=!missing.length;note.textContent='템플릿에만 있는 키 '+missing.length+'개 · '+missing.slice(0,8).join(', ')+(missing.length>8?' …':'');
  extra.hidden=!only.length;extra.querySelector('summary').textContent='데이터에만 있는 키 '+only.length+'개';extra.querySelector('p').textContent=only.join(', ');
  return missing.length;
}
function showRemote(){if(!state.chosen||state.busy)return;const el=$('#selection-remote');el.hidden=false;$('#remote-name').value=$('#detail-name').value;const p=state.pointer??{x:$('.original-pane').getBoundingClientRect().left+30,y:150};const r=el.getBoundingClientRect();el.style.left=Math.max(8,Math.min(p.x,innerWidth-r.width-8))+'px';el.style.top=Math.max(55,Math.min(p.y+8,innerHeight-r.height-35))+'px';}
let libraryRequest=0;
async function renderLibraryTab(){
  const ticket=++libraryRequest;
  const box=$('#library-items');box.replaceChildren(uiNode('p','불러오는 중','rail-empty'));
  try{const response=await fetch('/api/blocks?q='+encodeURIComponent($('#library-search').value));if(!response.ok)throw Error('블록 저장소를 열지 못했습니다.');const {blocks}=await response.json();if(ticket!==libraryRequest)return;box.replaceChildren();
    for(const item of blocks){const b=uiNode('button',item.name,'library-row');b.type='button';b.append(uiNode('small',`문서 ${item.sourceHash.slice(0,10)} · 판 ${item.version} · 입력 ${item.inputCount??'미확인'}`),uiNode('small',item.change+' · '+new Date(item.createdAt).toLocaleString('ko-KR')));b.onclick=async()=>{try{const response=await fetch('/api/block?id='+encodeURIComponent(item.id));if(!response.ok)throw Error('블록을 열지 못했습니다.');const detail=await response.json();state.detailLibrary=item.id;document.body.classList.remove('detail-collapsed');$('#detail-title').textContent='블록 편집';$('#detail-location').textContent=`${detail.location} · 판 ${detail.version} · 입력 ${detail.inputCount??'미확인'}`;$('#detail-excerpt').textContent='';$('#detail-form').hidden=true;const tools=$('#detail-library-tools');blockLibraryUI.dispose(tools);tools.replaceChildren();const more=uiNode('button','크게 보기');more.onclick=()=>blockLibraryUI.showItem(item.id);tools.append(more);void blockLibraryUI.preview(detail,tools);await blockLibraryUI.manage(detail,tools);}catch(e){status(e.message,'error');}};box.append(b);}
    if(!blocks.length)box.append(uiNode('p',$('#library-search').value.trim()?'검색 결과가 없습니다.':'HWPX 원문에서 범위를 선택하고 ‘블록으로 저장’을 누르세요.','rail-empty'));
  }catch(e){box.replaceChildren(uiNode('p',e.message,'rail-empty'));}
}
$('#library-search').oninput=()=>void renderLibraryTab();
document.addEventListener('block-library-change',()=>void renderLibraryTab());
$('#detail-toggle').onclick=()=>{const collapsed=document.body.classList.toggle('detail-collapsed');$('#detail-toggle').textContent=collapsed?'상세':'접기';$('#detail-toggle').setAttribute('aria-expanded',String(!collapsed));};
for(const name of ['name','key'])$('#detail-'+name).addEventListener('input',()=>{if(state.chosen)state.detailDrafts.set(state.chosen,{name:$('#detail-name').value,key:$('#detail-key').value});});
$('#confirm-input').onclick=()=>confirmInput($('#detail-name').value,$('#detail-key').value);
$('#designate-input').onclick=()=>designateOnly($('#detail-name').value);
// 리모컨: 이름을 치고 Enter면 확정, 이름 없이 Enter나 "지정"이면 지정만(이름은 표 보기에서 한꺼번에)
$('#remote-form').onsubmit=e=>{e.preventDefault();const name=$('#remote-name').value;if(name.trim())confirmInput(name,$('#detail-key').value);else designateOnly('');};
$('#remote-designate').onclick=()=>designateOnly($('#remote-name').value);
$('#remote-close').onclick=hideMenu;
$('#review-undo').onclick=()=>{const old=state.reviewHistory.pop();if(old)for(const r of state.recommendations)if(r.status!=='confirmed'&&old.has(r.id))r.status=old.get(r.id);touched();renderInputs();controls();};
$('#open-input-table').onclick=openTable;$('#close-input-table').onclick=closeTable;
$('#confirm-all').onclick=async()=>{const list=inputItems().filter(r=>r.status==='recommended'||r.status==='designated'),named=list.filter(r=>r.name.trim());if(!list.length){status('확정할 줄이 없습니다.');return;}const result=await confirmItems(named.map(r=>({item:r,name:r.name,key:r.key})));const unnamed=list.length-named.length;reportConfirm({done:result.done,failed:[...result.failed,...(unnamed?[[{name:'이름 없는 줄 '+unnamed+'개'},'이름을 적으면 확정할 수 있습니다.']]:[])]});};
// 표 보기 키보드: 이름·키 칸에서 Enter/↓는 다음 줄 같은 칸, ↑는 윗줄(한글 조합 중에는 넘기지 않는다)
$('#input-rows').addEventListener('keydown',e=>{const field=e.target.dataset?.field;if(!field||e.isComposing||e.keyCode===229)return;const down=e.key==='ArrowDown'||e.key==='Enter'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey,up=e.key==='ArrowUp';if(!down&&!up||field==='type'&&e.key!=='Enter')return;e.preventDefault();e.stopPropagation();const rows=[...$('#input-rows').querySelectorAll('tr[data-item]')],i=rows.indexOf(e.target.closest('tr')),next=rows[i+(up?-1:1)];const el=next?.querySelector('[data-field="'+field+'"]'),r=el&&inputItems().find(x=>x.id===next.dataset.item);if(el){el.focus();el.scrollIntoView({block:'nearest'});if(el.select)el.select();if(r)showItem(r);}});
$('#input-rows').addEventListener('focusin',e=>{const id=e.target.closest('tr')?.dataset.item,r=id&&inputItems().find(x=>x.id===id);if(r)showItem(r);});
$('#input-rows').addEventListener('click',e=>{if(e.target.closest('input,select,button'))return;const id=e.target.closest('tr')?.dataset.item,r=id&&inputItems().find(x=>x.id===id);if(r)focusTableRow(r,'name');});
for(const name of ['document','library'])$('#'+name+'-tab').onclick=()=>{for(const n of ['document','library']){$('#'+n+'-tab').setAttribute('aria-selected',String(n===name));$('#'+n+'-list').hidden=n!==name;}if(name==='library')void renderLibraryTab();};
$('#pages').addEventListener('pointerup',e=>{state.pointer={x:e.clientX,y:e.clientY};});
$('#document-editor').addEventListener('mouseup',e=>{state.pointer={x:e.clientX,y:e.clientY};if(state.caret?.start!==state.caret?.end)showRemote();});
$('#page-scroll').addEventListener('scroll',()=>{hideMenu();followHeading();},{passive:true});
$('#editor-scroll').addEventListener('scroll',followHeading,{passive:true});
$('#block-library-dialog').addEventListener('close',()=>{if(!$('#library-list').hidden)void renderLibraryTab();});
renderHeadingTree();renderRecommendations();

$('#txt-result-view').onclick=()=>showResult();

$('#save-checked-blocks').onclick=async()=>{
  const checked=state.recommendations.filter(r=>r.kind==='block'&&r.status==='recommended');
  if(state.busy||!checked.length||!confirm('체크한 블록 후보 '+checked.length+'개를 이름 그대로 저장할까요? 원문은 바뀌지 않습니다.'))return;
  const session=state.session;hideMenu();setBusy(true,'체크한 블록을 저장하는 중입니다.');renderRecommendations();let saved=0;const errors=[];
  try{for(const r of checked){try{
    const preview=await api('block-preview',{session,from:r.row,to:r.to});
    await api('block-save',{session,previewId:preview.id,name:r.name});r.status='confirmed';saved++;
  }catch(e){errors.push(r.name+': '+errorMessage(e));}}
  }finally{setBusy(false);renderRecommendations();if(!$('#library-list').hidden)await renderLibraryTab();}
  status('블록 '+saved+'개 저장'+(errors.length?' · '+errors.length+'개 저장 못함 · '+errors.join(' / '):''),errors.length?'error':'success');
};
