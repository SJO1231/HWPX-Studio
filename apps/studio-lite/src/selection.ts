import { createHash } from 'node:crypto';
import { readStudioTemplate, readBlockProto, readCase, writeCase, templateSha256, contentSha256, canonicalStudioJson, bindValues, selectSlots, readDataset, readBatchRecords, parseFragment, parseDocument, openPackage, generateFromTemplate, type StudioTemplate, type StudioCase, type BlockContent } from '@hwpx-studio/engine';
import { HostError } from '../../../packages/viewer/src/host/index.ts';

const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
function check(ok:unknown,message:string):asserts ok {if(!ok)throw new HostError(400,'SELECTION_INPUT',message);}
const text=(raw:unknown)=>{check(typeof raw==='string','파일 내용을 확인하세요.');return raw;};
const list=(raw:unknown)=>{check(Array.isArray(raw),'원본·원형 파일 목록을 확인하세요.');return raw as unknown[];};

function inputOf(input:Record<string,unknown>) {
  const blobs=new Map<string,Uint8Array>();
  for(const raw of list(input.blobs??[])) {
    const encoded=text(raw),bytes=Buffer.from(encoded,'base64');check(bytes.toString('base64')===encoded,'파일 인코딩을 확인하세요.');blobs.set(hash(bytes),bytes);
  }
  const protos=new Map<string,BlockContent>();
  for(const raw of list(input.protos??[])) {
    const p=readBlockProto(text(raw)),key=p.id+':'+p.version,old=protos.get(key);
    check(old===undefined||contentSha256(old)===contentSha256(p.content),'같은 원형 판의 내용이 다릅니다.');protos.set(key,p.content);
  }
  const parsed=readStudioTemplate(text(input.template),{hasBlob:sha=>blobs.has(sha),lookupProto:(id,version)=>protos.get(id+':'+version)});
  check(parsed.schema==='hwpx-studio/template@2','2판 템플릿을 선택하세요.');const template=parsed as StudioTemplate;
  if(template.slots.some(s=>s.parent!==null))throw new HostError(400,'SELECTION_NESTED','이번 화면은 1단 앵커+만 지원합니다.');
  const content=(c:BlockContent)=>{if('fragment' in c){const bytes=blobs.get(c.fragment);check(bytes,'참조하는 조각 파일을 선택하세요.');parseFragment(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}};
  for(const c of protos.values())content(c);for(const b of template.blocks)content(b.content);
  let raw:unknown;try{raw=JSON.parse(text(input.data));}catch{throw new HostError(400,'SELECTION_INPUT','데이터 JSON을 확인하세요.');}
  check(raw&&typeof raw==='object','데이터는 객체 또는 객체 배열이어야 합니다.');
  const rows=readBatchRecords(raw)??[{dataset:readDataset(raw)}];
  const row=input.row;check(typeof row==="number"&&Number.isInteger(row)&&row>=0&&row<rows.length,'확인할 데이터 행을 선택하세요.');
  const chosen=rows[row]!;if('error' in chosen)throw new HostError(400,chosen.error.code,chosen.error.message);
  const data=chosen.dataset.data;
  // 파일 소비 경로의 외부 데이터 참조. SQLite 보관 번호나 판을 추측하지 않는다.
  const record={dataset:'d'+hash(canonicalStudioJson(raw)).slice(0,24),version:1,row,sha256:hash(canonicalStudioJson(data))};
  const currentTemplate={id:template.id,version:template.version,sha256:templateSha256(template)};
  let c:StudioCase=input.case===undefined?{schema:'hwpx-studio/case@1',template:currentTemplate,record,selections:{},valueEdits:{},blockEdits:{}}:readCase(text(input.case),template);
  check(c.record.dataset===record.dataset&&c.record.version===record.version&&c.record.row===record.row&&c.record.sha256===record.sha256,'이번 건에 저장한 데이터 파일과 행을 선택하세요.');
  for(const edit of Object.values(c.blockEdits))content(edit);
  if(input.action!==undefined) {
    const action=input.action;check(action&&typeof action==='object'&&!Array.isArray(action),'선택 동작을 확인하세요.');const a=action as Record<string,unknown>;
    const slot=text(a.slot);check(template.slots.some(s=>s.id===slot),'선택할 앵커+를 확인하세요.');
    if(a.mode==='clear')delete c.selections[slot];
    else {
      let blockId:string;
      if(a.mode==='manual')blockId=text(a.block);
      else {
        check(a.mode==='confirm','선택 동작을 확인하세요.');const computed=selectSlots(template,bindValues(template,data,c),c).find(s=>s.slot===slot);
        check(computed&&(computed.state==='default'||computed.state==='fallback')&&computed.block,'확정할 조건 기본값이 없습니다. 직접 선택하거나 데이터를 확인하세요.');blockId=computed.block;
      }
      const block=template.blocks.find(b=>b.id===blockId&&b.slot===slot);check(block,'이 앵커+의 블록을 선택하세요.');
      c.selections[slot]={block:block.id,basis:a.mode==='manual'?'manual':'confirmed',content:contentSha256(block.content)};
    }
    // 명시적으로 편집한 이번 건은 현재 판에 대조한다. 사라진 참조를 조용히 지우지 않는다.
    c=readCase(writeCase({...c,template:currentTemplate}),template);
  }
  const source=blobs.get(template.source.sha256);
  if(source){if(template.source.kind==='hwpx')parseDocument(openPackage(source));else new TextDecoder('utf-8',{fatal:true}).decode(source);}
  const values=bindValues(template,data,c),slots=selectSlots(template,values,c);
  return {template,values,slots,case:writeCase(c),record,rows:rows.length,sourceVerified:source!==undefined,data,c,source,blobs};
}

export function previewSelection(input:Record<string,unknown>) {
  const {data,c,source,blobs,...view}=inputOf(input);return view;
}
export function generateSelection(input:Record<string,unknown>) {
  const loaded=inputOf(input);check(loaded.source,'템플릿의 원본 문서 파일을 선택하세요.');
  return generateFromTemplate(loaded.source,loaded.template,loaded.data,loaded.c,sha=>loaded.blobs.get(sha),{mode:'baseline'});
}
