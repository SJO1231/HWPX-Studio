import { createPageView, createLatest, toPagePoint } from '/packages/viewer/src/dom/index.ts';
import { loadRhwp, openDocument, runPosition, sameParagraph } from '/packages/viewer/src/rhwp/index.ts';

const $ = (selector) => document.querySelector(selector);
const state = {
  session: undefined, kind: 'hwpx', sourceText: '', name: '', paragraphs: [], edits: new Map(), headings: new Map(), blocks: [],
  keys: [], records: 0, index: 0, chosen: undefined, selection: undefined,
  sourceDoc: undefined, resultDoc: undefined, view: undefined, viewMode: 'source', output: undefined,
  busy: false, dirty: false, range: undefined, rangeEditing: undefined, caret: undefined,
  marks: new Map(), invalidations: Promise.resolve(), revision: 0, openTicket: 0,
};
const opens = createLatest(), picks = createLatest(), views = createLatest(), dataLoads = createLatest();
const keyCopies = createLatest(), bodyCopies = createLatest();
const rowElements = new Map();
let resizeFrame, contextRequest = 0;

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
function prefixOf(id) { const level = state.headings.get(id); return level === 1 ? '# ' : level === 2 ? '## ' : ''; }
function displayText(item) { return prefixOf(item.id) + textOf(item); }
function coveredBy(id) {
  const item = paragraph(id); if (!item) return undefined;
  return state.blocks.find((block) => {
    const a = paragraph(block.from), b = paragraph(block.to);
    return a && b && sameParent(a, item) && item.path.at(-1) >= a.path.at(-1) && item.path.at(-1) <= b.path.at(-1);
  });
}
function editable(item) { return Boolean(item?.editable) && !coveredBy(item.id); }
function controls() {
  const available = Boolean(state.session) && !state.busy;
  const item = paragraph(state.chosen), canEdit = available && editable(item);
  for (const id of ['open-document', 'empty-open', 'load-work']) { const button = $('#' + id); if (button) button.disabled = state.busy; }
  for (const id of ['save-work', 'generate', 'open-data', 'load-data-text']) $('#' + id).disabled = !available;
  $('#record-select').disabled = !available || state.records === 0;
  $('#source-view').disabled = !(state.sourceDoc || (state.kind === 'text' && state.session)) || state.busy;
  $('#result-view').disabled = !state.output || state.busy;
  for (const id of ['scale', 'zoom-in', 'zoom-out']) $('#' + id).disabled = !(state.view || (state.kind === 'text' && state.session)) || state.busy;
  $('#copy-body').disabled = state.busy || typeof state.output?.text !== 'string';
  $('#key-select').disabled = !available || !state.keys.some((key) => key.usable);
  for (const button of document.querySelectorAll('[data-action]')) {
    const action = button.dataset.action;
    button.disabled = !(action === 'heading1' || action === 'heading2' || action === 'anchor' ? available && Boolean(item)
      : action === 'copyKey' ? available && Boolean($('#key-select').value)
      : action === 'key' ? canEdit && Boolean($('#key-select').value) : canEdit);
  }
  $('#confirm-block').disabled = !available || !state.range?.from || !state.range?.to;
  $('#block-text').disabled = !state.range?.to || state.busy;
  $('#block-alias').disabled = state.busy;
  $('#cancel-selection').hidden = !state.chosen;
  $('#dirty-state').hidden = !state.dirty;
  const download = $('#download'), downloadable = Boolean(state.output) && !state.busy;
  download.classList.toggle('disabled', !downloadable); download.setAttribute('aria-disabled', String(!downloadable));
  download.tabIndex = downloadable ? 0 : -1;
  if (!downloadable) download.removeAttribute('href'); else download.href = state.output.outputUrl;
  for (const [id, entry] of rowElements) {
    entry.input.readOnly = state.busy || !editable(paragraph(id));
    entry.reset.disabled = state.busy || Boolean(coveredBy(id));
  }
}
async function api(path, body) {
  const response = await fetch('/api/workbench/' + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = result.error;
    throw new Error(result.plain ?? (typeof error === 'string' ? error : error?.message)
      ?? result.message ?? '작업을 마치지 못했습니다.');
  }
  return result;
}
function errorMessage(error) { return error instanceof Error ? error.message : '작업을 마치지 못했습니다.'; }
function hideMenu() { $('#context-menu').hidden = true; contextRequest++; }
function closeMenus(except) {
  for (const menu of document.querySelectorAll('details.menu[open]')) if (menu !== except) menu.open = false;
}
function disposeResult() {
  views.cancel();
  if (state.viewMode === 'result') {
    if (state.kind === 'text') renderTextDocument('source');
    else if (state.sourceDoc) mountDocument(state.sourceDoc, 'source');
  }
  state.resultDoc?.free(); state.resultDoc = undefined;
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
function autosize(input) {
  input.style.height = '0px'; input.style.height = Math.max(34, input.scrollHeight + 2) + 'px';
}
function saveCaret(input, id) { state.caret = {id, start: input.selectionStart, end: input.selectionEnd}; }
function updateRow(id) {
  const item = paragraph(id), entry = rowElements.get(id);
  if (!item || !entry) return;
  const level = state.headings.get(id), block = coveredBy(id);
  entry.article.className = 'paragraph-item' + (state.chosen === id ? ' selected' : '')
    + (level ? ' heading-' + level : '') + (!item.editable ? ' readonly' : '') + (block ? ' covered' : '');
  entry.article.setAttribute('aria-current', state.chosen === id ? 'true' : 'false');
  const number = state.paragraphs.indexOf(item) + 1;
  entry.label.textContent = '문단 ' + number;
  entry.state.textContent = block ? block.alias : state.edits.has(id) ? '편집됨' : level ? '제목 ' + level : !item.editable ? '읽기 전용' : '';
  entry.reset.hidden = !state.edits.has(id) && !state.headings.has(id); entry.reset.disabled = state.busy || Boolean(block);
  entry.input.readOnly = state.busy || !editable(item);
  entry.input.setAttribute('aria-label', '문단 ' + number + (block ? ' · 구간에 포함됨' : !item.editable ? ' · 읽기 전용' : ' 편집'));
  entry.reason.hidden = (item.editable && !block) || state.chosen !== id;
  const reason = block ? '확정한 구간에 포함되어 있습니다.' : !item.editable ? reasonOf(item.reason) : '';
  entry.reason.textContent = reason; entry.state.title = reason; entry.input.title = !item.editable || block ? reason : '';
  if (entry.input.value !== displayText(item)) entry.input.value = displayText(item);
  autosize(entry.input);
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
function renderParagraphs() {
  rowElements.clear(); const container = $('#paragraphs'); container.replaceChildren();
  for (const item of state.paragraphs) {
    const article = document.createElement('article'); article.dataset.id = item.id;
    const meta = document.createElement('div'); meta.className = 'paragraph-meta';
    const label = document.createElement('span'); label.className = 'paragraph-label';
    const marker = document.createElement('span'); marker.className = 'paragraph-state';
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = '되돌리기';
    reset.title = '이 문단의 글과 제목 지정을 원본으로 되돌리기';
    const input = document.createElement('textarea'); input.className = 'paragraph-text'; input.rows = 1; input.spellcheck = false;
    const reason = document.createElement('p'); reason.className = 'paragraph-reason';
    meta.append(label, marker, reset); article.append(meta, input, reason); container.append(article);
    rowElements.set(item.id, {article, input, label, state: marker, reset, reason});
    input.addEventListener('focus', () => { selectRow(item.id, {scroll: false}); saveCaret(input, item.id); });
    for (const event of ['select', 'keyup', 'mouseup']) input.addEventListener(event, () => saveCaret(input, item.id));
    input.addEventListener('input', () => {
      if (state.busy || !editable(item)) return;
      const start = input.selectionStart, end = input.selectionEnd;
      const heading = /^(#{1,2})[ \t]+/.exec(input.value), originalHeading = /^(#{1,2})[ \t]+/.test(item.text);
      let text = input.value;
      if (heading && (!originalHeading || state.headings.has(item.id))) {
        state.headings.set(item.id, heading[1].length); text = text.slice(heading[0].length);
      } else state.headings.delete(item.id);
      if (text === item.text) state.edits.delete(item.id); else state.edits.set(item.id, text);
      changed(); updateRow(item.id); input.setSelectionRange(start, end); saveCaret(input, item.id);
      renderOutline(); status('문단 편집 중 · 적용하면 문서에 반영됩니다.');
    });
    input.addEventListener('contextmenu', (event) => {
      event.preventDefault(); if (state.busy) return;
      hideMenu(); selectRow(item.id, {scroll: false}); saveCaret(input, item.id); showMenu(event.clientX, event.clientY);
    });
    reset.addEventListener('click', () => {
      if (state.busy || coveredBy(item.id)) return;
      state.edits.delete(item.id); state.headings.delete(item.id); changed(); updateRow(item.id); renderOutline();
      status('이 문단의 편집과 제목 지정을 되돌렸습니다.');
    });
    article.addEventListener('click', () => { if (state.chosen !== item.id) selectRow(item.id, {scroll: false}); });
    updateRow(item.id);
  }
  $('#paragraph-count').textContent = state.paragraphs.length ? state.paragraphs.length + '개 문단' : '';
  renderOutline(); renderBlocks();
}
function selectRow(id, options = {}) {
  const item = paragraph(id); if (!item) return false;
  const previous = state.chosen; state.chosen = id; updateRow(previous); updateRow(id);
  $('#selection-info').textContent = '문단 ' + (state.paragraphs.indexOf(item) + 1)
    + (!item.editable ? ' · 직접 글 편집은 제한됩니다.' : coveredBy(id) ? ' · 확정한 구간에 포함됨' : ' 선택');
  if (state.viewMode === 'source') state.view?.setMarks(state.marks.get(id) ?? []);
  if (options.scroll !== false) rowElements.get(id)?.article.scrollIntoView({block: 'nearest'});
  if (state.kind === 'text' && state.viewMode === 'source') highlightTextRow(id);
  if (!options.fromPick) void showRowInSource(id);
  controls(); return true;
}
function clearSelection() {
  picks.cancel(); hideMenu(); const old = state.chosen;
  state.chosen = undefined; state.selection = undefined; state.caret = undefined; updateRow(old); state.view?.setMarks([]);
  highlightTextRow(undefined);
  $('#selection-info').textContent = '문서의 글을 클릭하면 연결된 문단을 선택합니다.'; controls();
}
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
        ? '여러 문단의 구간은 시작 문단과 끝 문단을 따로 선택해주세요.'
        : '이 위치에서는 연결할 문단을 확인할 수 없습니다.');
      return false;
    }
    state.selection = result.location;
    state.marks.set(result.id, marksOf(result.location, result.id));
    selectRow(result.id, {...options, fromPick: true});
    return true;
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
      state.view?.setMarks(marks);
      const position = marks[0]?.position;
      if (position) {
        const page = [...$('#pages').querySelectorAll('.page')].find((entry) => {
          const layout = state.sourceDoc.pageLayout(Number(entry.dataset.page));
          return layout.runs.some((run) => { const at = runPosition(run); return at && sameParagraph(at, position); });
        });
        page?.scrollIntoView({block: 'nearest'});
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
  $('#original-title').textContent = mode === 'source' ? '원본 문서' : '생성 결과';
  $('#source-view').setAttribute('aria-pressed', String(mode === 'source'));
  $('#result-view').setAttribute('aria-pressed', String(mode === 'result'));
  if (mode === 'source' && state.chosen) state.view.setMarks(state.marks.get(state.chosen) ?? []);
  controls();
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
  setBusy(true, '생성 결과를 표시하는 중입니다.');
  try {
    if (state.kind === 'text') renderTextDocument('result');
    else if (state.resultDoc) mountDocument(state.resultDoc, 'result');
    else await openViewer(state.output.outputUrl, 'result', state.openTicket);
    status('생성 결과 · 내려받기로 저장할 수 있습니다.', 'success');
  } catch (error) { status(errorMessage(error), 'error'); }
  finally { setBusy(false); }
}
function updateData(info) {
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
  const keys = $('#key-select'); keys.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '연결할 키'; keys.append(placeholder);
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
  if (!opens.current(ticket)) return;
  picks.cancel(); dataLoads.cancel(); clearSelection(); hideMenu();
  state.view?.destroy(); state.view = undefined;
  state.sourceDoc?.free(); state.sourceDoc = undefined; state.resultDoc?.free(); state.resultDoc = undefined;
  state.session = result.session; state.kind = result.kind ?? 'hwpx'; state.sourceText = result.sourceText ?? '';
  $('#download-label').textContent = state.kind === 'text' ? 'TXT 저장' : 'HWPX 저장';
  state.name = result.name; state.openTicket = ticket; state.paragraphs = result.paragraphs ?? [];
  state.edits = new Map((result.edits ?? []).map((item) => [item.id, item.text]));
  state.headings = new Map((result.headings ?? []).map((item) => [item.id, item.level]));
  state.blocks = (result.blocks ?? []).map((item) => ({...item}));
  state.marks.clear(); state.range = undefined; state.rangeEditing = undefined;
  state.output = undefined; state.viewMode = 'source'; state.dirty = false; state.revision++;
  $('#range-panel').hidden = true; $('#output-info').textContent = ''; $('#data-text').value = '';
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
  if (opens.current(ticket)) status('원본을 열었습니다. 글을 클릭하거나 오른쪽 문단을 편집하세요.');
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
  return {session: state.session, index: state.index, edits: [...state.edits].map(([id, text]) => ({id, text})),
    headings: [...state.headings].map(([id, level]) => ({id, level})), blocks: state.blocks.map((block) => ({...block}))};
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
async function generate() {
  if (!state.session || state.busy) return;
  hideMenu(); closeMenus(); invalidateOutput(); const revision = state.revision, session = state.session;
  setBusy(true, '편집과 데이터를 적용하는 중입니다.');
  try {
    await state.invalidations; const result = await api('generate', snapshot());
    if (revision !== state.revision || session !== state.session) return;
    state.output = result;
    $('#download').download = state.name.replace(/\.(hwpx|txt)$/i, '') + '-결과.' + (state.kind === 'text' ? 'txt' : 'hwpx');
    $('#body-text').value = result.text ?? ''; $('#body-result-panel').hidden = typeof result.text !== 'string';
    $('#body-result').open = state.kind === 'text';
    $('#output-info').textContent = result.changed + '개 편집 · ' + result.filled + '곳 채움';
    try {
      if (state.kind === 'text') renderTextDocument('result');
      else await openViewer(result.outputUrl, 'result', state.openTicket);
    }
    catch (error) {
      if (state.sourceDoc) mountDocument(state.sourceDoc, 'source');
      status('생성은 완료됐지만 화면 표시가 어렵습니다. 내려받기로 확인해주세요. ' + errorMessage(error), 'error'); return;
    }
    const notes = Array.isArray(result.notes) && result.notes.length ? ' · ' + result.notes.join(' · ') : '';
    status('생성 완료 · ' + result.changed + '개 편집, ' + result.filled + '곳 채움' + notes, 'success');
  } catch (error) {
    state.output = undefined; disposeResult(); $('#output-info').textContent = ''; status(errorMessage(error), 'error');
  } finally { setBusy(false); }
}
function sameParent(a, b) {
  return a.sectionIndex === b.sectionIndex && a.path.length === b.path.length
    && a.path.slice(0, -1).every((part, index) => part === b.path[index]);
}
function rangeItems(range) {
  const a = paragraph(range.from), z = paragraph(range.to);
  if (!a || !z || !sameParent(a, z) || a.path.at(-1) > z.path.at(-1)) return [];
  return state.paragraphs.filter((item) => sameParent(a, item)
    && item.path.at(-1) >= a.path.at(-1) && item.path.at(-1) <= z.path.at(-1));
}
function cancelRange() {
  state.range = undefined; state.rangeEditing = undefined; $('#range-panel').hidden = true;
  $('#block-text').value = ''; $('#block-alias').value = ''; controls();
}
function renderRange() {
  $('#range-panel').hidden = !state.range;
  if (!state.range) return;
  const from = state.paragraphs.findIndex((item) => item.id === state.range.from) + 1;
  const to = state.paragraphs.findIndex((item) => item.id === state.range.to) + 1;
  $('#range-info').textContent = state.range.to ? '문단 ' + from + '부터 ' + to + '까지'
    : '문단 ' + from + '에서 시작 · 끝 문단을 선택해주세요.';
  $('#range-note').textContent = state.rangeEditing ? '다시 확정하면 이 구간이 바뀝니다.' : '확정한 뒤 적용됩니다.';
  controls();
}
function startRange(id) {
  const item = paragraph(id); if (!editable(item)) return;
  state.range = {from: id}; state.rangeEditing = undefined;
  $('#block-alias').value = '구간' + (state.blocks.length + 1); $('#block-text').value = '';
  renderRange(); status('구간의 끝 문단을 선택한 뒤 구간 끝을 누르세요.');
}
function endRange(id) {
  if (!state.range?.from) { status('먼저 구간 시작을 지정해주세요.'); return; }
  const from = paragraph(state.range.from), to = paragraph(id);
  if (!to || !from || !sameParent(from, to)) { status('같은 본문 또는 같은 표 칸 안의 문단끼리 선택해주세요.', 'error'); return; }
  const candidate = {from: from.id, to: to.id}, items = rangeItems(candidate);
  if (!items.length) { status('끝 문단은 시작 문단보다 뒤에 있어야 합니다.', 'error'); return; }
  if (items.some((item) => !item.editable || (coveredBy(item.id) && coveredBy(item.id).id !== state.rangeEditing))) {
    status('직접 편집할 수 없는 문단이나 다른 구간이 포함되어 있습니다.', 'error'); return;
  }
  state.range = candidate; $('#block-text').value = items.map((item) => textOf(item)).join('\n');
  renderRange(); $('#block-text').focus(); status('바꿀 글을 확인한 뒤 구간 확정을 눌러주세요.');
}
function confirmRange() {
  if (!state.range?.to || state.busy) return;
  if (rangeItems(state.range).some((item) => state.edits.has(item.id))) {
    status('이 구간의 개별 문단 편집을 되돌린 뒤 구간을 확정해주세요.', 'error'); return;
  }
  const block = {id: state.rangeEditing ?? 'b-' + crypto.randomUUID(), from: state.range.from, to: state.range.to,
    text: $('#block-text').value, alias: $('#block-alias').value.trim() || '구간' + (state.blocks.length + 1)};
  if (state.rangeEditing) state.blocks = state.blocks.map((item) => item.id === state.rangeEditing ? block : item);
  else state.blocks.push(block);
  changed(); cancelRange(); renderBlocks();
  for (const item of state.paragraphs) updateRow(item.id);
  status('구간을 확정했습니다. 적용하면 바뀐 글이 반영됩니다.');
}
function renderBlocks() {
  const list = $('#blocks'); list.replaceChildren(); list.hidden = state.blocks.length === 0;
  for (const block of state.blocks) {
    const chip = document.createElement('div'); chip.className = 'block-chip';
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = block.alias; edit.title = '이 구간의 글 편집';
    edit.addEventListener('click', () => {
      if (state.busy) return;
      state.range = {from: block.from, to: block.to}; state.rangeEditing = block.id;
      $('#block-alias').value = block.alias; $('#block-text').value = block.text; renderRange(); $('#block-text').focus();
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '해제';
    remove.setAttribute('aria-label', block.alias + ' 구간 해제');
    remove.addEventListener('click', () => {
      if (state.busy) return;
      state.blocks = state.blocks.filter((item) => item.id !== block.id); changed();
      if (state.rangeEditing === block.id) cancelRange();
      renderBlocks(); for (const item of state.paragraphs) updateRow(item.id);
      status('구간 지정을 해제했습니다. 원본 글은 그대로 있습니다.');
    });
    chip.append(edit, remove); list.append(chip);
  }
}
function useHeading(id, level) {
  if (!paragraph(id)) return;
  state.headings.set(id, level); changed(); updateRow(id); renderOutline(); status('문단을 제목 ' + level + '로 등록했습니다.');
}
function replaceSelected(value) {
  const id = state.chosen, item = paragraph(id), entry = rowElements.get(id);
  if (!editable(item) || !entry) return;
  const input = entry.input, prefix = prefixOf(id);
  const caret = state.caret?.id === id ? state.caret : {start: input.value.length, end: input.value.length};
  const start = Math.max(prefix.length, caret.start), end = Math.max(start, caret.end);
  input.setRangeText(value, start, end, 'end');
  const text = input.value.slice(prefix.length);
  if (text === item.text) state.edits.delete(id); else state.edits.set(id, text);
  changed(); updateRow(id); input.focus(); input.setSelectionRange(start + value.length, start + value.length); saveCaret(input, id);
}
function insertKey() {
  const key = $('#key-select').value;
  if (!key || !editable(paragraph(state.chosen))) { status('데이터의 키와 편집할 문단을 선택해주세요.'); return; }
  replaceSelected('{{' + key + '}}');
  status('데이터 키를 삽입했습니다. 적용할 때 선택한 행의 값으로 채웁니다.');
}
function makeBold() {
  const id = state.chosen, entry = rowElements.get(id), item = paragraph(id);
  if (!editable(item) || !entry || state.busy) return;
  const caret = state.caret?.id === id ? state.caret : undefined;
  if (!caret || caret.end <= caret.start) { status('굵게 할 글을 먼저 선택해주세요.'); return; }
  const start = Math.max(prefixOf(id).length, caret.start), selected = entry.input.value.slice(start, caret.end);
  const replacement = selected.startsWith('**') && selected.endsWith('**') && selected.length > 4
    ? selected.slice(2, -2) : '**' + selected + '**';
  replaceSelected(replacement); status('선택한 글의 굵기 표시를 바꿨습니다. 적용하면 반영됩니다.');
}
async function copyKey() {
  const key = $('#key-select').value; if (!key || state.busy) return;
  const text = '{{' + key + '}}', session = state.session, revision = state.revision, ticket = keyCopies.begin();
  const current = () => keyCopies.current(ticket) && session === state.session && revision === state.revision && key === $('#key-select').value;
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
  const id = state.chosen, item = paragraph(id); hideMenu();
  if (name === 'copyKey') { void copyKey(); return; }
  if (state.busy || !item) return;
  if (name === 'heading1') useHeading(id, 1);
  else if (name === 'heading2') useHeading(id, 2);
  else if (name === 'bold') makeBold();
  else if (name === 'key') insertKey();
  else if (name === 'anchor') {
    if (state.kind === 'text') renderTextDocument('source'); else if (state.sourceDoc) mountDocument(state.sourceDoc, 'source');
    void showRowInSource(id); status('선택한 문단의 원본 위치를 확인합니다.');
  }
  else if (name === 'rangeStart') startRange(id);
  else if (name === 'rangeEnd') endRange(id);
  else if (name === 'edit' && editable(item)) {
    const input = rowElements.get(id).input, caret = state.caret?.id === id ? state.caret : undefined;
    input.focus(); if (caret) input.setSelectionRange(caret.start, caret.end); status('선택한 문단의 글을 편집하세요.');
  }
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
$('#generate').addEventListener('click', generate);
$('#cancel-selection').addEventListener('click', clearSelection);
$('#cancel-range').addEventListener('click', cancelRange);
$('#confirm-block').addEventListener('click', confirmRange);
$('#key-select').addEventListener('change', () => { $('#copy-fallback').hidden = true; controls(); });
$('#record-select').addEventListener('change', () => {
  if (state.busy) return; state.index = Number($('#record-select').value); changed();
  status((state.index + 1) + '행을 선택했습니다. 적용하면 해당 행의 값으로 채웁니다.');
});
$('#source-view').addEventListener('click', () => {
  if (!state.busy) {
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
  if (event.key === 'Escape') { hideMenu(); closeMenus(); if (state.range) cancelRange(); else clearSelection(); }
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 's') { event.preventDefault(); void saveWork(); }
    else if (event.key === 'Enter') { event.preventDefault(); void generate(); }
    else if (event.key.toLowerCase() === 'b' && document.activeElement?.classList.contains('paragraph-text')) { event.preventDefault(); makeBold(); }
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
  resizeFrame = requestAnimationFrame(() => { for (const entry of rowElements.values()) autosize(entry.input); }); hideMenu();
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
}
function renderTextDocument(mode) {
  state.view?.destroy(); state.view = undefined; state.viewMode = mode;
  const container = $('#pages'); container.classList.remove('page-view'); container.replaceChildren();
  const source = document.createElement('pre'); source.className = 'text-document';
  if (mode === 'result') source.textContent = state.output?.text ?? '';
  else {
    const parts = state.sourceText.split(/(\r\n|\r|\n)/);
    for (let index = 0; index < parts.length; index += 2) {
      const row = state.paragraphs[index / 2], span = document.createElement('span'); span.className = 'text-line';
      if (row) span.dataset.sourceId = row.id;
      span.textContent = parts[index] + (parts[index + 1] ?? ''); source.append(span);
    }
  }
  container.append(source); applyScale(); highlightTextRow(state.chosen);
  $('#original-title').textContent = mode === 'source' ? '원본 문서' : '생성 결과';
  $('#source-view').setAttribute('aria-pressed', String(mode === 'source'));
  $('#result-view').setAttribute('aria-pressed', String(mode === 'result')); controls();
}
function highlightTextRow(id, scroll = false) {
  if (state.kind !== 'text' || state.viewMode !== 'source') return;
  for (const line of $('#pages').querySelectorAll('[data-source-id]')) {
    line.classList.toggle('selected', line.dataset.sourceId === id);
    if (scroll && line.dataset.sourceId === id) line.scrollIntoView({block: 'nearest'});
  }
}
async function selectTextSource(id, context) {
  if (state.busy || state.kind !== 'text' || state.viewMode !== 'source') return false;
  const ticket = picks.begin(), session = state.session;
  try {
    const result = await api('select', {session, id});
    if (!picks.current(ticket) || session !== state.session || (context !== undefined && context !== contextRequest)) return false;
    if (!result.id || result.location.precision === 'none') { clearSelection(); return false; }
    selectRow(result.id, {fromPick: true}); return true;
  } catch (error) {
    if (picks.current(ticket) && session === state.session) { clearSelection(); status(errorMessage(error), 'error'); }
    return false;
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
$('#pages').addEventListener('click', (event) => {
  const line = event.target instanceof Element ? event.target.closest('[data-source-id]') : null;
  if (line) void selectTextSource(line.dataset.sourceId);
});
$('#pages').addEventListener('contextmenu', async (event) => {
  const line = event.target instanceof Element ? event.target.closest('[data-source-id]') : null;
  if (!line) return;
  event.preventDefault(); clearSelection(); const ticket = ++contextRequest;
  if (await selectTextSource(line.dataset.sourceId, ticket)) showMenu(event.clientX, event.clientY);
});