import { randomUUID } from 'node:crypto';
import { openPackage, parseDocument, emptyTemplate, readTemplate, isValidPath, type HwpxDocument, type Template } from '@hwpx-studio/engine';
import { HostError, locate, type LocateResponse } from '../../../packages/viewer/src/host/index.ts';
import { analyzePlaces, parseQuickData, listKeys, countInvalidRecords, matchPlaces, generateAll, type QuickData, type Generated } from './quick.ts';
import type { PlacesView, MissingPolicy } from './quick-types.ts';

type Assignment = { id: string; path: string; draft: LocateResponse['drafts'][number] };
type Session = { source: Uint8Array; name: string; doc: HwpxDocument; places: PlacesView; data?: QuickData; selections: Map<string,LocateResponse>; assignments: Assignment[]; results: Generated[] };
const fail = (ok: unknown, code: string, message: string): void => { if (!ok) throw new HostError(400,code,message); };

/** Existing quick-generation APIs, with an explicit, temporary viewer selection. No source file is written. */
export function createQuick() {
  const sessions=new Map<string,Session>();
  const sessionOf=(id: unknown):Session=>{
    const s=typeof id==='string'?sessions.get(id):undefined;
    if(!s)throw new HostError(404,'QUICK_SESSION','문서를 다시 올려 주세요.');
    return s;
  };
  const assignmentsOf=(s:Session)=>s.assignments.map(a=>({id:a.id,path:a.path,anchor:a.draft.anchor,mark:a.draft.mark}));
  return {
    get(path: string, query: URLSearchParams): { body: Uint8Array; name?: string } | undefined {
      if(path!=='/api/quick/source' && path!=='/api/quick/result')return;
      const s=sessionOf(query.get('session'));
      if(path==='/api/quick/source')return {body:s.source};
      const raw=query.get('index');
      const index=raw!==null && /^(0|[1-9]\d*)$/.test(raw)?Number(raw):-1;
      const r=s.results[index];
      if(!r?.output || !r.view.ok)throw new HostError(404,'QUICK_RESULT','내려받을 생성물이 없습니다.');
      return {body:r.output,name:r.view.name};
    },
    post(path: string, input: Record<string,unknown>): unknown {
      if(path==='/api/quick/template') {
        fail(typeof input.content==='string' && typeof input.name==='string','QUICK_FILE','HWPX 파일을 선택하세요.');
        const source=new Uint8Array(Buffer.from(input.content as string,'base64'));
        const doc=parseDocument(openPackage(source));
        const places=analyzePlaces(source);
        const session=randomUUID();
        const name=(input.name as string).split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,180) || 'document.hwpx';
        if(sessions.size>=8)sessions.delete(sessions.keys().next().value!);
        sessions.set(session,{source,name,doc,places,selections:new Map(),assignments:[],results:[]});
        return {session,name,bytes:source.length,places};
      }
      const s=sessionOf(input.session);
      if(path==='/api/quick/data') {
        // Invalidate before parsing: a rejected replacement must not leave an older batch downloadable.
        s.results=[]; delete s.data;
        fail(typeof input.content==='string','QUICK_BAD_DATA','JSON 데이터를 선택하세요.');
        s.data=parseQuickData(new TextEncoder().encode(input.content as string));
        return {session:input.session,form:s.data.form,records:s.data.records.length,invalidRecords:countInvalidRecords(s.data.records),...listKeys(s.data.records),matches:matchPlaces(s.places,s.data.records)};
      }
      if(path==='/api/quick/locate') {
        const location=locate(s.doc,input.request);
        const selection=randomUUID();
        if(s.selections.size>=32)s.selections.delete(s.selections.keys().next().value!);
        s.selections.set(selection,location);
        return {selection,location};
      }
      if(path==='/api/quick/assign') {
        const location=typeof input.selection==='string'?s.selections.get(input.selection):undefined;
        const draft=Number.isInteger(input.draft)?location?.drafts[input.draft as number]:undefined;
        fail(draft && !draft.blocked,'QUICK_SELECTION','선택한 위치를 다시 확인하세요.');
        fail(typeof input.path==='string' && isValidPath(input.path),'QUICK_PATH','연결할 데이터 경로를 선택하세요.');
        const id=randomUUID();
        // Validate with the engine; the browser never supplies an anchor object.
        const a={id,path:input.path as string,draft:draft!};
        const template=emptyTemplate();
        template.anchors=[{...a.draft.anchor,id}];
        template.rules=[{id,do:{type:'fill',anchor:id,value:{path:a.path}}}];
        readTemplate(template);
        fail(s.assignments.length<200,'QUICK_SELECTION_LIMIT','클릭 지정은 200개까지 연결할 수 있습니다.');
        s.assignments.push(a);s.results=[];
        return {assignments:assignmentsOf(s)};
      }
      if(path==='/api/quick/clear') {
        fail(typeof input.id==='string' && s.assignments.some(a=>a.id===input.id),'QUICK_SELECTION','해제할 지정을 선택하세요.');
        s.assignments=s.assignments.filter(a=>a.id!==input.id);s.results=[];
        return {assignments:assignmentsOf(s)};
      }
      if(path==='/api/quick/generate') {
        s.results=[];
        fail(s.data,'QUICK_NO_DATA','생성할 JSON 데이터를 먼저 선택하세요.');
        fail(['error','keep','empty'].includes(input.missing as string),'QUICK_POLICY','누락 처리 방법을 선택하세요.');
        const template:Template=emptyTemplate();
        template.anchors=s.assignments.map(a=>({...a.draft.anchor,id:a.id}));
        template.rules=s.assignments.map(a=>({id:a.id,do:{type:'fill',anchor:a.id,value:{path:a.path}}}));
        s.results=generateAll(s.source,s.places,s.data!,s.name,input.missing as MissingPolicy,readTemplate(template));
        return {session:input.session,results:s.results.map(r=>r.view),folder:null};
      }
      throw new HostError(404,'QUICK_ROUTE','없는 빠른 생성 요청입니다.');
    }
  };
}