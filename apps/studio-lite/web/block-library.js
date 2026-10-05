// Block extraction/storage only. Insertion, shared values and later revisions are separate work.
export function installBlockLibrary({selection, session, api, status, beforeOpen, onSaved}) {
  const $ = s => document.querySelector(s), dialog = $('#block-library-dialog');
  const body = $('#block-library-body'), title = $('#block-library-title');
  let busy = false, draft, savedFocus;
  const element = (tag, text, className) => {
    const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
    if (className) el.className = className; return el;
  };
  const button = (text, click) => { const b = element('button', text); b.type = 'button'; b.addEventListener('click', click); return b; };
  function open(label) {
    beforeOpen(); title.textContent = label;
    if (!dialog.open) { savedFocus = document.activeElement; dialog.showModal(); }
    body.replaceChildren();
  }
  function close() { if (busy) return; dialog.close(); draft = undefined; savedFocus?.focus({preventScroll: true}); }
  $('#block-library-close').addEventListener('click', close);
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  function details(item) {
    const source = element('p', `출처: ${item.sourceName} · 문서 식별 ${item.sourceHash.slice(0, 10)}`);
    body.append(source, element('p', item.location), element('p', `판 ${item.version} · 입력 표시 ${item.inputCount}`));
    for (const warning of item.warnings ?? []) body.append(element('p', warning, 'block-warning'));
    body.append(element('h3', '원문 일부'), element('pre', item.excerpt, 'block-excerpt'),
      element('p', '원문 일부만 표시합니다. 블록 단독 조판 미리보기는 아직 지원하지 않습니다.', 'muted'));
  }
  async function get(path) {
    const response = await fetch(path), data = await response.json();
    if (!response.ok) throw Error(data.error || '블록을 불러오지 못했습니다.');
    return data;
  }
  async function showItem(id) {
    busy = true;
    try {
      const item = await get('/api/block?id=' + encodeURIComponent(id));
      open(item.name); details(item);
      body.append(element('p', `${item.change} · ${new Date(item.createdAt).toLocaleString('ko-KR')}`), button('저장소 목록', showList));
    } catch (e) { status(e.message, 'error'); }
    finally { busy = false; }
  }
  async function showList() {
    busy = true;
    try {
      const {blocks} = await get('/api/blocks'); open(`블록 저장소 · ${blocks.length}개`);
      if (!blocks.length) { body.append(element('p', 'HWPX 원문에서 범위를 선택하고 ‘블록으로 저장’을 누르세요.')); return; }
      const table = element('table'), head = element('tr');
      for (const text of ['이름', '출처·구간', '판·입력', '바뀐 점', '시각']) head.append(element('th', text));
      table.append(head);
      for (const item of blocks) {
        const tr = element('tr'), name = element('td'); name.append(button(item.name, () => showItem(item.id)));
        tr.append(name, element('td', `문서 ${item.sourceHash.slice(0,10)} · ${item.location}`),
          element('td', `${item.version} · 입력 ${item.inputCount}`), element('td', item.change),
          element('td', new Date(item.createdAt).toLocaleString('ko-KR'))); table.append(tr);
      }
      const scroll = element('div', undefined, 'block-list-scroll'); scroll.append(table); body.append(scroll);
    } catch (e) { status(e.message, 'error'); }
    finally { busy = false; }
  }
  async function begin() {
    if (busy) return;
    let range;
    try { range = selection(); } catch (e) { status(e.message, 'error'); return; }
    const sourceSession = session(); busy = true;
    try {
      const result = await api('block-preview', {session: sourceSession, ...range});
      if (sourceSession !== session()) return;
      draft = {id: result.id, session: sourceSession}; open('선택한 원문을 블록으로 저장');
      const label = element('label', '블록 이름'); label.htmlFor = 'block-save-name';
      const input = element('input'); input.id = 'block-save-name'; input.maxLength = 120;
      input.value = result.excerpt.split('\n').find(t => t.trim())?.slice(0, 60) || '새 블록';
      body.append(label, input, element('p', '선택에 걸친 문단 전체를 원본 서식 그대로 저장합니다. 아래 범위를 확인하세요.', 'muted'));
      details(result);
      const error = element('p', '', 'block-warning'); error.setAttribute('role', 'alert'); body.append(error);
      const save = button('블록 저장', async () => {
        if (busy || !draft) return;
        busy = true; save.disabled = true; $('#block-library-close').disabled = true;
        try {
          if (draft.session !== session()) throw Error('문서가 바뀌었습니다. 범위를 다시 선택하세요.');
          await api('block-save', {session: draft.session, previewId: draft.id, name: input.value});
          draft = undefined; onSaved?.(); await showList(); status('블록을 저장했습니다. 저장소 목록에서 확인하세요.', 'success');
        } catch (e) { error.textContent = e.message; }
        finally { busy = false; save.disabled = false; $('#block-library-close').disabled = false; }
      });
      save.className = 'primary'; body.append(save); input.focus(); input.select();
    } catch (e) { status(e.message, 'error'); }
    finally { busy = false; }
  }
  $('#open-block-library').addEventListener('click', showList);
  $('#save-source-block').addEventListener('click', begin);
  return {begin, refresh() {
    let reason = ''; try { selection(); } catch (e) { reason = e.message; }
    for (const el of document.querySelectorAll('#save-source-block,[data-action="saveBlock"]')) {
      el.disabled = Boolean(reason) || busy; el.title = reason || '선택한 문단 전체를 확인한 뒤 저장합니다.';
    }
  }};
}
