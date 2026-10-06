import {viewerLines, lineAt} from '/viewer-lines.js';
import { installBlockLibrary } from '/block-library.js';
import {editorLayout, editorSelection, unitAt, replaceEditorText, groupEditorSelection, editorChange} from '/editor-model.js';
import { createPageView, createLatest, toPagePoint } from '/packages/viewer/src/dom/index.ts';
import { loadRhwp, openDocument, runPosition, sameParagraph } from '/packages/viewer/src/rhwp/index.ts';

const $ = (selector) => document.querySelector(selector);
const state = {
  placements: [], placementNames: {}, placementWarnings: {},
  outline: [], recommendations: [], reviewHistory: [], labels: [], detailDrafts: new Map(), detailId: undefined, pointer: undefined,
  session: undefined, kind: 'hwpx', sourceText: '', name: '', paragraphs: [], edits: new Map(), headings: new Map(), blocks: [],
  keys: [], records: 0, index: 0, chosen: undefined, selection: undefined,
  sourceDoc: undefined, resultDoc: undefined, view: undefined, viewMode: 'source', output: undefined,
  busy: false, dirty: false, caret: undefined,
  comparison: undefined, comparisonText: '', layout: {text: '', units: []}, history: [], future: [],
  marks: new Map(), invalidations: Promise.resolve(), revision: 0, openTicket: 0,
};
const opens = createLatest(), picks = createLatest(), views = createLatest(), dataLoads = createLatest();
const keyCopies = createLatest(), bodyCopies = createLatest();
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
  $('#copy-body').disabled=state.busy||typeof state.output?.text!=='string';
  $('#document-editor').disabled=!state.session; $('#document-editor').readOnly=state.busy;
  $('#undo').disabled=!available||!state.history.length; $('#redo').disabled=!available||!state.future.length;
  for(const button of document.querySelectorAll('[data-action]')) {
    const name=button.dataset.action;
    button.disabled=name==='copyKey'?!available||!$('#key-select').value.trim():name==='importSelection'?!canEdit||!state.comparisonText:name==='copySelection'?!available:!canEdit;
    button.dataset.actionTitle??=button.title;
    button.title=button.disabled?(state.busy?'문서 처리가 끝난 뒤 사용하세요.':!state.session?'문서를 먼저 여세요.':!item?'문서에서 부분을 먼저 고르세요.':!item.editable?'표·개체 또는 보호된 서식이 있는 문단은 직접 편집할 수 없습니다.':name==='importSelection'?'비교 문서에서 가져올 글을 선택하세요.':'입력 항목 이름을 먼저 적으세요.'):button.dataset.actionTitle;
  }
  for(const check of document.querySelectorAll('.rec-line input'))check.disabled=state.busy||check.dataset.confirmed==='true';
  $('#save-checked-blocks').disabled=state.busy||!state.recommendations.some(r=>r.kind==='block'&&r.status==='recommended');
  blockLibraryUI.refresh();
  if(state.kind==='text')for(const b of document.querySelectorAll('[data-action=bold],[data-action=group],[data-action=heading1],[data-action=heading2]'))b.disabled=true;
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
  const response = await fetch('/api/workbench/' + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = result.error;
    throw new Error((typeof error === 'string' ? error : error?.message) ?? result.plain
      ?? result.message ?? '작업을 마치지 못했습니다.');
  }
  return result;
}
function errorMessage(error) { return error instanceof Error ? error.message : '작업을 마치지 못했습니다.'; }
function hideMenu() { $('#context-menu').hidden = true; $('#selection-remote').hidden=true; contextRequest++; }
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
  const session = state.session;
  if (session) state.invalidations = state.invalidations.catch(() => {}).then(async () => {
    if (state.session !== session) return;
    try { await api('invalidate', {session}); }
    catch { if (state.session === session) status('이전 결과를 사용할 수 없습니다. 다시 적용해주세요.', 'error'); }
  });
}
function changed() { state.dirty = true; invalidateOutput(); }
function editorWork() { return {edits:[...state.edits].map(([id,text])=>({id,text})),blocks:state.blocks.map(b=>({...b}))}; }
function historyEntry() { return {...editorWork(),placements:state.placements.map(p=>({...p})),headings:[...state.headings],labels:state.labels.map(l=>({...l})),caret:state.caret?{...state.caret}:undefined}; }
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
  if (!event.cell && !event.hit.position) {
    clearSelection(); status('이 위치에서는 연결할 문단을 확인할 수 없습니다.'); return false;
  }
  try {
    const result = await api('select', {session, request: requestOf(event)});
    if (!picks.current(ticket) || session !== state.session) return false;
    if (!result.id || result.location.precision === 'none') {
      clearSelection();
      status(result.location.reason === 'RANGE_PARAGRAPHS_DIFFER'
        ? '같은 본문이나 표 칸 안의 글을 선택하세요.'
        : '이 위치에서는 연결할 문단을 확인할 수 없습니다.');
      return false;
    }
    state.activeRecommendation=undefined;state.selection = result.location;
    state.marks.set(result.id, marksOf(result.location, result.id));
    displaySourceMarks(state.marks.get(result.id));
    selectRow(result.id, {...options, fromPick: true});
    const span=result.location.span;
    const a=span?state.paragraphs.find(r=>r.sectionIndex===span.sectionIndex&&r.path.length===span.parentPath.length+1&&r.path.at(-1)===span.from&&r.path.slice(0,-1).every((n,i)=>n===span.parentPath[i])):paragraph(result.id);
    const z=span?state.paragraphs.find(r=>r.sectionIndex===span.sectionIndex&&r.path.length===span.parentPath.length+1&&r.path.at(-1)===span.to&&r.path.slice(0,-1).every((n,i)=>n===span.parentPath[i])):a;
    const first=state.layout.units.find(u=>state.paragraphs.slice(u.from,u.to+1).some(r=>r.id===a?.id)),last=state.layout.units.find(u=>state.paragraphs.slice(u.from,u.to+1).some(r=>r.id===z?.id));
    if(first&&last){
      const word=paragraph(result.id)?.editable?result.location.drafts.find(d=>d.anchor?.kind==='word'&&!d.blocked)?.anchor:undefined;
      const start=first.start+(!span&&!state.edits.has(result.id)&&!first.block&&word?word.start:0),end=span?last.end:first.start+(!state.edits.has(result.id)&&!first.block&&word?word.end:first.text.length);
      state.blockPick={start,end,from:a?.id,to:z?.id,blocked:Boolean(event.to&&!span&&(!event.hit.position||!sameParagraph(event.hit.position,event.to.position)))};
      state.caret={start,end};const input=$('#document-editor');input.focus({preventScroll:true});input.setSelectionRange(start,end);markEditorSelection();controls();
    }
    renderSelectionDetail();showRemote();return true;
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
  state.records = info?.records ?? 0; state.keys = info?.keys ?? []; state.index = info?.index ?? 0;
  $('#data-info').textContent = state.records ? state.records + '개 행 연결됨' : '데이터가 없습니다.';
  const records = $('#record-select'); records.replaceChildren();
  const count = Math.max(1, state.records);
  for (let index = 0; index < count; index++) {
    const option = document.createElement('option'); option.value = String(index);
    option.textContent = state.records ? (index + 1) + '행' : '데이터 없음'; records.append(option);
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
  controls();
}
async function installWorkspace(result, ticket) {
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
  state.blockPick = undefined;
  state.outline=result.outline??[];state.recommendations=[];state.labels=[];state.detailDrafts.clear();state.detailId=undefined;state.reviewHistory=[];
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
  if (opens.current(ticket)) {buildReview(result);renderHeadingTree();renderRecommendations();status('');}
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
    updateData(result); state.dirty = true; status(result.records + '개 데이터 행을 연결했습니다. 사용할 행과 키를 선택하세요.');
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
    headings: [...state.headings].map(([id, level]) => ({id, level})), blocks: state.blocks.map((block) => ({...block})),placements:state.placements.map(p=>({...p}))};
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
async function generate(asTemplate = false) {
  if (!state.session || state.busy) return;
  hideMenu(); closeMenus(); invalidateOutput(); const revision = state.revision, session = state.session;
  setBusy(true, asTemplate ? '누름틀 서식을 만드는 중입니다.' : '편집과 데이터를 적용하는 중입니다.');
  try {
    await state.invalidations; const result = await api(asTemplate ? 'template' : 'generate', snapshot());
    if (revision !== state.revision || session !== state.session) return;
    state.output = result;
    const textTemplate = state.kind === 'text' && result.template === true;
    $('#download').download = state.name.replace(/\.(hwpx|txt)$/i, '') + (asTemplate ? '-서식.hwpx' : textTemplate ? '-서식.txt' : '-결과.' + (state.kind === 'text' ? 'txt' : 'hwpx'));
    $('#download-label').textContent = asTemplate ? '서식 HWPX 저장' : textTemplate ? '서식 TXT 저장' : state.kind === 'text' ? 'TXT 저장' : 'HWPX 저장';
    $('#body-text').value = result.text ?? ''; $('#body-result-panel').hidden = true;
    $('#body-result').open = state.kind === 'text';
    $('#output-info').textContent = asTemplate ? '누름틀 ' + result.promoted + '개 생성' : textTemplate ? '서식 반영 · 미연결 ' + result.unresolved + '곳' : result.changed + '개 편집 · ' + result.filled + '곳 채움';
    try {
      if (state.kind === 'text') {renderTextDocument('result');}
      else await openViewer(result.outputUrl, 'result', state.openTicket);
    }
    catch (error) {
      if (state.sourceDoc) mountDocument(state.sourceDoc, 'source');
      status('생성은 완료됐지만 화면 표시가 어렵습니다. 내려받기로 확인해주세요. ' + errorMessage(error), 'error'); return;
    }
    const notes = Array.isArray(result.notes) && result.notes.length ? ' · ' + result.notes.join(' · ') : '';
    status(asTemplate ? '누름틀 ' + result.promoted + '개를 만들었습니다. 서식 HWPX 저장을 누르세요.' : textTemplate ? '글을 반영했습니다. 미연결 ' + result.unresolved + '곳은 {{키}}로 남겼습니다. 데이터를 연결하면 값을 채울 수 있습니다.' + notes : '생성 완료 · ' + result.changed + '개 편집, ' + result.filled + '곳 채움' + notes, 'success');
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
  to.push(historyEntry());const previous=from.pop();setWork(previous);state.headings=new Map(previous.headings);state.labels=previous.labels??[];renderSourceTags();state.caret=previous.caret;changed();renderEditor();renderOutline();
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
  if(state.kind==='text'&&['bold','group','heading1','heading2'].includes(name))return;
  hideMenu();if(state.busy)return;
  try {
    if(name==='inputDetail'||name==='dataDetail'){openInputDetail(name==='dataDetail');return;}
    if(name==='branchDetail')return;
    if(name==='saveBlock'){void blockLibraryUI.begin();return;}
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
$('#record-select').addEventListener('change', () => {
  if (state.busy) return; state.index = Number($('#record-select').value); changed();
  status((state.index + 1) + '행을 선택했습니다. 적용하면 해당 행의 값으로 채웁니다.');
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
for (const menu of document.querySelectorAll('details.menu')) menu.addEventListener('toggle', () => { if (menu.open) closeMenus(menu); });
document.addEventListener('pointerdown', (event) => {
  if (!$('#context-menu').contains(event.target)) hideMenu();
  if (!(event.target instanceof Element) || !event.target.closest('details.menu')) closeMenus();
});
document.addEventListener('keydown', (event) => {
  if ($('#block-library-dialog').open) return;
  if (event.key === 'Escape') { hideMenu(); closeMenus(); clearSelection(); }
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 's') { event.preventDefault(); void saveWork(); }
    else if (event.key === 'Enter') { event.preventDefault(); void generate(); }
    else if (event.key.toLowerCase() === 'b' && document.activeElement?.id==='document-editor') { event.preventDefault(); makeBold(); }
    else if (event.key.toLowerCase()==='z' && document.activeElement?.id==='document-editor') {event.preventDefault();undo(event.shiftKey);}
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
function buildReview(opened){
  state.recommendations=state.paragraphs.flatMap(p=>[...p.text.matchAll(/\{\{([^{}#/]+)\}\}/g)].map(m=>({id:p.id+':'+m.index,row:p.id,name:m[1],start:m.index,end:m.index+m[0].length,kind:'input',status:'recommended',excerpt:p.text.slice(Math.max(0,m.index-8),m.index+m[0].length+20)})));
  state.recommendations.push(...(opened.blockCandidates??[]).map((c,i)=>({id:'block:'+i,row:c.from,to:c.to,name:c.name,kind:'block',status:'recommended',excerpt:c.paragraphCount+'문단 · '+(state.paragraphs.slice(state.paragraphs.findIndex(p=>p.id===c.from)+1,state.paragraphs.findIndex(p=>p.id===c.to)+1).find(p=>p.text.trim())?.text.slice(0,60)??'본문 없음')})));
}
function renderRecommendations(){
  const root=$('#recommendations');root.replaceChildren();const groups=new Map();
  for(const r of state.recommendations){const h=headingOf(r.row),key=h?.id??'document';if(!groups.has(key))groups.set(key,{name:h?.name??'문서',items:[]});groups.get(key).items.push(r);}
  for(const {name,items} of groups.values()){const d=uiNode('details',undefined,'rec-group');d.open=true;d.append(uiNode('summary',name+' · '+items.length));
    for(const r of items){const line=uiNode('div',undefined,'rec-line'+(r.status==='excluded'?' excluded':''));line.dataset.review=r.id;const check=uiNode('input');check.type='checkbox';check.checked=r.status!=='excluded';check.disabled=state.busy||r.status==='confirmed';check.dataset.confirmed=String(r.status==='confirmed');check.setAttribute('aria-label',r.name+' 유지');check.onchange=()=>reviewChange([r],check.checked?'recommended':'excluded');
      const kind=({input:'입력',block:'블록',branch:'분기',place:'위치'})[r.kind],button=uiNode('button',r.name);button.type='button';button.title=r.name+' · '+r.excerpt;button.onclick=()=>selectRecommendation(r);
      const excerpt=uiNode('span',r.excerpt,'rec-excerpt');excerpt.title=r.excerpt;line.append(check,uiNode('span',kind,'kind-tag kind-'+r.kind),button,excerpt,uiNode('small',r.status==='confirmed'?'확정':r.status==='excluded'?'제외':'추천'));d.append(line);}
    const actions=uiNode('div',undefined,'group-actions');for(const [label,status] of [['묶음 제외','excluded'],['묶음 되돌리기','recommended']]){const b=uiNode('button',label);b.type='button';b.onclick=()=>reviewChange(items,status);actions.append(b);}d.append(actions);root.append(d);
  }
  if(!groups.size)root.append(uiNode('p',state.session?'추천 없음 · 원문에서 직접 고를 수 있습니다.':'문서를 열면 추천이 표시됩니다.','rail-empty'));
  $('#review-undo').disabled=state.busy||!state.reviewHistory.length;
  const blocks=state.recommendations.filter(r=>r.kind==='block'),checked=blocks.filter(r=>r.status==='recommended');const save=$('#save-checked-blocks');save.hidden=!blocks.length;save.disabled=state.busy||!checked.length;save.textContent='체크한 블록 '+checked.length+'개 저장';
}
function reviewChange(items,status){if(state.busy)return;state.reviewHistory.push(state.recommendations.map(r=>r.status));for(const r of items)if(r.status!=='confirmed')r.status=status;renderRecommendations();controls();}
async function selectRecommendation(r){
  selectRow(r.row);await showRowInSource(r.row);const unit=state.layout.units.find(u=>u.id===r.row);
  if(unit&&r.start!==undefined){state.caret={start:unit.start+r.start,end:unit.start+r.end};$('#document-editor').setSelectionRange(state.caret.start,state.caret.end);}
  if(r.kind==='block'&&unit){const end=state.layout.units.find(u=>u.id===r.to);if(end){state.caret={start:unit.start,end:end.end};$('#document-editor').setSelectionRange(unit.start,end.end);state.blockPick={...state.caret,from:r.row,to:r.to,blocked:false};
    const rows=state.paragraphs.slice(state.paragraphs.findIndex(p=>p.id===r.row),state.paragraphs.findIndex(p=>p.id===r.to)+1);state.view?.setMarks(rows.filter(p=>p.position).map(p=>({id:p.id,kind:'selection',position:p.position,endOffset:p.text.length})));}}
  state.activeRecommendation=r;$('#detail-name').value=r.name;state.detailDrafts.set(r.row,{name:r.name,key:r.name});renderSelectionDetail(true);if(r.kind==='block'){$('#detail-title').textContent='블록 후보';$('#detail-excerpt').textContent=r.excerpt;$('#confirm-input').hidden=true;}else $('#confirm-input').hidden=false;controls();showRemote();
}
function renderSelectionDetail(force=false){
  if(state.detailLibrary)return;
  $('#detail-library-tools').replaceChildren();
  const row=paragraph(state.chosen);$('#detail-content').dataset.kind=state.activeRecommendation?.kind??'input';$('#detail-form').hidden=!row;$('#confirm-input').hidden=state.activeRecommendation?.kind==='block';
  if(!row){$('#detail-title').textContent='선택 상세';$('#detail-location').textContent='먼저 부분을 고르세요';$('#detail-excerpt').textContent='';return;}
  const detailId=row.id+':'+state.caret?.start+':'+state.caret?.end;if(state.detailId===detailId&&!force)return;
  state.detailId=detailId;const h=headingOf(row.id);$('#detail-title').textContent='입력 항목 편집';$('#detail-location').textContent=(state.kind==='text'?'줄 '+(state.paragraphs.indexOf(row)+1):'쪽 미확인')+' · '+(h?.name??'문서');$('#detail-excerpt').textContent=(state.caret?state.layout.text.slice(state.caret.start,state.caret.end):row.text).slice(0,160);$('#confirm-input').disabled=!row.editable||state.busy;
  const draft=state.detailDrafts.get(row.id)??{name:state.activeRecommendation?.row===row.id?state.activeRecommendation.name:'',key:''};$('#detail-name').value=draft.name;
  const select=$('#detail-key');select.replaceChildren();const empty=uiNode('option',state.keys.length?'연결할 데이터 항목 선택':'데이터를 먼저 올리세요');empty.value='';select.append(empty);for(const key of state.keys){const option=uiNode('option',key);option.value=key;select.append(option);}select.value=draft.key;$('#detail-value').textContent=draft.key?'연결 후보 · 확정 뒤 적용':'연결 전';
}
function openInputDetail(data=false){document.body.classList.remove('detail-collapsed');$('#detail-toggle').textContent='접기';$('#detail-toggle').setAttribute('aria-expanded','true');renderSelectionDetail(true);if(data&&!state.keys.length){$('#data-menu').open=true;$('#load-data-text').focus();}else $(data?'#detail-key':'#detail-name').focus();}
function confirmInput(name,key){
  if(!name.trim()||!state.caret)return;
  const row=state.chosen,marks=(state.marks.get(row)??[]).map(m=>({...m}));$('#key-select').value=key||name;const old=state.revision;insertKey();if(state.revision===old)return;
  state.labels.push({row,name,key:key||name,marks});state.detailDrafts.set(row,{name,key:key||name});
  const r=state.activeRecommendation?.row===row?state.activeRecommendation:undefined;if(r)r.status='confirmed';else state.recommendations.push({id:crypto.randomUUID(),row,name,kind:'input',status:'confirmed',excerpt:paragraph(row).text.slice(0,40)});
  renderRecommendations();displaySourceMarks();hideMenu();status(name+' 입력 항목을 확정했습니다. 원문은 그대로입니다.');
}
function displaySourceMarks(marks=[]){state.view?.setMarks([...state.labels.flatMap(l=>l.marks),...marks]);renderSourceTags();}
function renderSourceTags(){
  for(const el of $('#pages').querySelectorAll('.source-tag,.confirmed-overlay'))el.remove();
  if(state.kind!=='hwpx'||state.viewMode!=='source'||!state.sourceDoc)return;const scale=Number($('#scale').value);
  for(const page of $('#pages').querySelectorAll('.page')){const runs=state.sourceDoc.pageLayout(Number(page.dataset.page)).runs,used=[];
    for(const label of state.labels){const pos=label.marks[0]?.position;if(!pos)continue;const run=runs.find(r=>{const p=runPosition(r);return p&&sameParagraph(p,pos);});if(!run)continue;
      const tag=uiNode('button',label.name+' · 확정','source-tag');tag.type='button';tag.title=label.name+' · 확정';tag.style.left=run.x*scale+'px';tag.style.top=Math.max(0,run.y*scale-18)+'px';tag.onclick=()=>selectRow(label.row);page.append(tag);
      const rect=tag.getBoundingClientRect();if(used.some(r=>r.left<rect.right&&r.right>rect.left&&r.top<rect.bottom&&r.bottom>rect.top)){tag.classList.add('margin-tag');tag.textContent='입력';}used.push(tag.getBoundingClientRect());
    }
  }
}
function showRemote(){if(!state.chosen||state.busy)return;const el=$('#selection-remote');el.hidden=false;$('#remote-name').value=$('#detail-name').value;const p=state.pointer??{x:$('.original-pane').getBoundingClientRect().left+30,y:150};const r=el.getBoundingClientRect();el.style.left=Math.max(8,Math.min(p.x,innerWidth-r.width-8))+'px';el.style.top=Math.max(55,Math.min(p.y+8,innerHeight-r.height-35))+'px';}
let libraryRequest=0;
async function renderLibraryTab(){
  const ticket=++libraryRequest;
  const box=$('#library-items');box.replaceChildren(uiNode('p','불러오는 중','rail-empty'));
  try{const response=await fetch('/api/blocks?q='+encodeURIComponent($('#library-search').value));if(!response.ok)throw Error('블록 저장소를 열지 못했습니다.');const {blocks}=await response.json();if(ticket!==libraryRequest)return;box.replaceChildren();
    for(const item of blocks){const b=uiNode('button',item.name,'library-row');b.type='button';b.append(uiNode('small',`문서 ${item.sourceHash.slice(0,10)} · 판 ${item.version} · 입력 ${item.inputCount}`),uiNode('small',item.change+' · '+new Date(item.createdAt).toLocaleString('ko-KR')));b.onclick=async()=>{try{const response=await fetch('/api/block?id='+encodeURIComponent(item.id));if(!response.ok)throw Error('블록을 열지 못했습니다.');const detail=await response.json();state.detailLibrary=item.id;document.body.classList.remove('detail-collapsed');$('#detail-title').textContent='블록 편집';$('#detail-location').textContent=`${detail.location} · 판 ${detail.version} · 입력 ${detail.inputCount}`;$('#detail-excerpt').textContent=detail.excerpt;$('#detail-form').hidden=true;const tools=$('#detail-library-tools');tools.replaceChildren();const more=uiNode('button','크게 보기');more.onclick=()=>blockLibraryUI.showItem(item.id);tools.append(more);await blockLibraryUI.manage(detail,tools);}catch(e){status(e.message,'error');}};box.append(b);}
    if(!blocks.length)box.append(uiNode('p',$('#library-search').value.trim()?'검색 결과가 없습니다.':'HWPX 원문에서 범위를 선택하고 ‘블록으로 저장’을 누르세요.','rail-empty'));
  }catch(e){box.replaceChildren(uiNode('p',e.message,'rail-empty'));}
}
$('#library-search').oninput=()=>void renderLibraryTab();
document.addEventListener('block-library-change',()=>void renderLibraryTab());
$('#detail-toggle').onclick=()=>{const collapsed=document.body.classList.toggle('detail-collapsed');$('#detail-toggle').textContent=collapsed?'상세':'접기';$('#detail-toggle').setAttribute('aria-expanded',String(!collapsed));};
for(const name of ['name','key'])$('#detail-'+name).addEventListener('input',()=>{if(state.chosen)state.detailDrafts.set(state.chosen,{name:$('#detail-name').value,key:$('#detail-key').value});});
$('#confirm-input').onclick=()=>confirmInput($('#detail-name').value,$('#detail-key').value);
$('#remote-form').onsubmit=e=>{e.preventDefault();confirmInput($('#remote-name').value,$('#detail-key').value);};
$('#remote-close').onclick=hideMenu;
$('#review-undo').onclick=()=>{const old=state.reviewHistory.pop();if(old)state.recommendations.forEach((r,i)=>{if(r.status!=='confirmed')r.status=old[i]??r.status;});renderRecommendations();controls();};
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
