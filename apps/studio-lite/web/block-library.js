import {createPageView} from '/packages/viewer/src/dom/index.ts';
import {loadRhwp,openDocument} from '/packages/viewer/src/rhwp/index.ts';
// Store engine fragments and confirm placement before changing the generated result.
export function installBlockLibrary({selection, session, api, status, beforeOpen, previewPlacement, onSaved, currentUsage}) {
  const $ = s => document.querySelector(s), dialog = $('#block-library-dialog');
  const body = $('#block-library-body'), title = $('#block-library-title');
  let busy = false, draft, savedFocus;
  const previews=new Map();
  function dispose(container){for(const [box,cleanup] of previews)if(container.contains(box)){cleanup();previews.delete(box);}}
  const element = (tag, text, className) => {
    const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
    if (className) el.className = className; return el;
  };
  const button = (text, click) => { const b = element('button', text); b.type = 'button'; b.addEventListener('click', click); return b; };
  function open(label) {
    beforeOpen(); title.textContent = label;
    if (!dialog.open) { savedFocus = document.activeElement; dialog.showModal(); }
    dispose(body);body.replaceChildren();
  }
  function close() { if (busy) return; dispose(body);dialog.close(); draft = undefined; savedFocus?.focus({preventScroll: true}); refresh(); }
  $('#block-library-close').addEventListener('click', close);
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  function details(item) {
    const source = element('p', `출처: ${item.sourceName} · 문서 식별 ${item.sourceHash.slice(0, 10)}`);
    body.append(source, element('p', item.location), element('p', `판 ${item.version} · 입력 표시 ${item.inputCount}`));
    for (const warning of item.warnings ?? []) body.append(element('p', warning, 'block-warning'));
    if(item.version)void preview(item,body);
    else body.append(element('h3','원문 일부'),element('pre',item.excerpt,'block-excerpt'));
  }
  async function get(path, data) {
    const response = await fetch(path,data===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}), result = await response.json();
    if (!response.ok) throw Error(result.error || '블록을 불러오지 못했습니다.');
    return result;
  }
  async function preview(item, container) {
    dispose(container);
    const box=element('section',undefined,'block-preview'),note=element('p','블록 미리보기 여는 중입니다.','muted');note.setAttribute('role','status');box.append(note);container.append(box);
    let active=true,view,doc,resize;
    const cleanup=()=>{active=false;resize?.disconnect();view?.destroy();doc?.free();};previews.set(box,cleanup);
    try {
      const result=await get('/api/block/preview?id='+encodeURIComponent(item.id));
      if(!active)return;await loadRhwp({wasmUrl:'/vendor/rhwp/rhwp_bg.wasm'});if(!active)return;
      doc=openDocument(Uint8Array.from(atob(result.hwpx),c=>c.charCodeAt(0)));
      const count=result.fields.reduce((n,f)=>n+f.count,0);note.textContent='블록 단독 미리보기 · 읽기 전용 · 입력 '+count+' · '+doc.pageCount()+'쪽';
      const fields=element('details');fields.append(element('summary','입력 '+count));
      for(const f of result.fields)fields.append(element('p',f.name+' · '+f.count+'곳'));
      if(count)box.append(fields);
      for(const warning of result.warnings)box.append(element('p',warning.message,'block-warning'));
      const pages=element('div',undefined,'page-view block-preview-pages');box.append(pages);
      const width=Math.max(...Array.from({length:doc.pageCount()},(_,i)=>doc.pageInfo(i).width));
      const scale=()=>Math.min(1,Math.max(.25,(pages.clientWidth-20)/width));
      view=createPageView({container:pages,doc,scale:scale(),onPick:()=>{},onError:e=>{note.textContent='미리보기를 표시하지 못했습니다. '+e.message;}});
      view.setMarks(result.places.flatMap((p,i)=>p.marks.map((m,j)=>({...m,id:'block-input-'+i+'-'+j,kind:'input'}))));
      resize=new ResizeObserver(()=>{if(active)view.setScale(scale());});resize.observe(pages);
    }catch(e){cleanup();note.textContent='미리보기를 표시하지 못했습니다. '+e.message;}
  }
  async function manage(item, container) {
    const group=element('section',undefined,'block-management');container.append(group);
    const label=element('label','블록 이름'),input=element('input');input.value=item.name;input.maxLength=120;label.append(input);group.append(label);
    const note=element('p','','block-warning');note.setAttribute('role','status');
    const rename=button('이름 바꾸기',async()=>{
      if(busy)return;busy=true;rename.disabled=true;
      try{await get('/api/block/rename',{id:item.id,name:input.value});item.name=input.value.trim();if(container===body)title.textContent=item.name;note.textContent='이름을 바꿨습니다. 저장한 내용과 옛 판은 그대로입니다.';document.dispatchEvent(new Event('block-library-change'));}
      catch(e){note.textContent=e.message;}finally{busy=false;rename.disabled=false;refresh();}
    });group.append(rename,note);
    try {
      const usage=await get('/api/block/usage?id='+encodeURIComponent(item.id));
      if(!group.isConnected)return;
      for(const u of usage.usages)group.append(element('p',`${u.kind==='workspace'?'저장한 작업':'템플릿'} · ${u.name} · 판 ${u.pinned??u.forkedFrom} · ${{current:'현재 판',behind:'최신 판 있음',forked:'분기됨'}[u.state]}`));
      const current=currentUsage?.(item);
      if(current)group.append(element('p',current));
      const remove=button('삭제',async()=>{
        if(busy)return;
        if(currentUsage?.(item)){note.textContent=currentUsage(item);return;}
        const hint=usage.templateTracking?'': '\n템플릿 분기점 사용처는 아직 추적 전입니다. 저장한 작업의 사용처는 확인했습니다.';
        if(!confirm('“'+item.name+'”의 모든 판을 삭제할까요? 되돌릴 수 없습니다.'+hint))return;
        busy=true;remove.disabled=true;
        try{await get('/api/block/delete',{id:item.id,confirmed:true});dispose(container);for(const box of container.querySelectorAll('.block-preview'))box.remove();group.replaceChildren(element('p','블록을 삭제했습니다.'));document.dispatchEvent(new Event('block-library-change'));if(container===body)await showList();else container.closest('#detail-content')?.querySelector('#detail-excerpt')?.replaceChildren();}
        catch(e){note.textContent=e.message;}finally{busy=false;refresh();}
      });remove.disabled=Boolean(usage.usages.length||current);remove.title=remove.disabled?'사용 중인 블록입니다. 표시된 사용처에서 연결을 먼저 해제하세요.':'';group.append(remove);
    }catch(e){note.textContent='사용처 확인에 실패해 삭제를 막았습니다. '+e.message;}
  }
  async function showItem(id) {
    busy = true;
    try {
      const item = await get('/api/block?id=' + encodeURIComponent(id));
      open(item.name); details(item);await manage(item,body);
      body.append(element('p', `${item.change} · ${new Date(item.createdAt).toLocaleString('ko-KR')}`), button('저장소 목록', showList));
      if(previewPlacement){
        const place=button('선택한 범위에 넣기',async()=>{
          if(busy)return;busy=true;place.disabled=true;
          try{const checked=await previewPlacement(item);open('블록 넣기 확인');
            body.append(element('p',`${checked.name} · 판 ${checked.version} → 선택한 ${checked.paragraphs}개 문단 전체`),element('p','원문은 그대로 두고, 생성 결과에서 이 범위를 바꿉니다.'));
            for(const warning of checked.warnings)body.append(element('p',warning,'placement-warning'));
            for(const diff of checked.formatDiffs)body.append(element('p',`블록 ${diff.paragraph}번째 문단 · ${diff.property} 다름`));
            body.append(button('배치 확정 · 생성 미리 보기',()=>{try{close();checked.commit();}catch(e){status(e.message,'error');}}),button('돌아가기',()=>showItem(item.id)));
          }catch(e){status(e.message,'error');body.append(element('p',e.message,'block-warning'));}
          finally{busy=false;place.disabled=false;}
        });
        try{selection();}catch(e){place.disabled=true;place.title=e.message;body.append(element('p',e.message,'muted'));}
        body.append(place);
      }

    } catch (e) { status(e.message, 'error'); }
    finally { busy = false; refresh(); }
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
      const search=element('input');search.type='search';search.maxLength=200;search.placeholder='이름 또는 출처 검색';search.setAttribute('aria-label','블록 검색');search.oninput=()=>{const q=search.value.toLocaleLowerCase();for(const row of [...table.rows].slice(1))row.hidden=!row.textContent.toLocaleLowerCase().includes(q);};const scroll = element('div', undefined, 'block-list-scroll'); scroll.append(table); body.append(search,scroll);
    } catch (e) { status(e.message, 'error'); }
    finally { busy = false; refresh(); }
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
        finally { busy = false; save.disabled = false; $('#block-library-close').disabled = false; refresh(); }
      });
      save.className = 'primary'; body.append(save); input.focus(); input.select();
    } catch (e) { status(e.message, 'error'); }
    finally { busy = false; refresh(); }
  }
  $('#open-block-library').addEventListener('click', showList);
  $('#save-source-block').addEventListener('click', begin);
  function refresh() {
    let reason = ''; try { selection(); } catch (e) { reason = e.message; }
    for (const el of document.querySelectorAll('#save-source-block,[data-action="saveBlock"]')) {
      el.disabled = Boolean(reason) || busy; el.title = reason || '선택한 문단 전체를 확인한 뒤 저장합니다.';
    }
  }
  return {begin, refresh, manage, showItem, preview, dispose};
}
