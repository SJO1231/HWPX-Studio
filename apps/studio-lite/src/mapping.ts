import {createHash} from 'node:crypto';
import {readStudioTemplate,writeStudioTemplate,templateSha256,readBlockProto,contentSha256,bindValues,readBatchRecords,readDataset,parseFragment,type StudioTemplate,type BlockContent} from '@hwpx-studio/engine';
import {HostError} from '../../../packages/viewer/src/host/index.ts';

function check(ok:unknown,message:string):asserts ok {if(!ok)throw new HostError(400,'MAPPING_INPUT',message);}
const text=(v:unknown)=>{check(typeof v==='string','파일 내용을 확인하세요.');return v;};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function load(input:Record<string,unknown>) {
  check(Array.isArray(input.blobs??[]),'조각 파일 목록을 확인하세요.');check(Array.isArray(input.protos??[]),'원형 파일 목록을 확인하세요.');
  const blobs=new Map<string,Uint8Array>(),protos=new Map<string,BlockContent>();
  for(const raw of (input.blobs??[]) as unknown[]){const encoded=text(raw),bytes=Buffer.from(encoded,'base64');check(bytes.toString('base64')===encoded,'파일 인코딩을 확인하세요.');blobs.set(hash(bytes),bytes);}
  for(const raw of (input.protos??[]) as unknown[]){const p=readBlockProto(text(raw)),key=p.id+':'+p.version,old=protos.get(key);check(old===undefined||contentSha256(old)===contentSha256(p.content),'같은 원형 판의 내용이 다릅니다.');protos.set(key,p.content);}
  const options={hasBlob:(sha:string)=>blobs.has(sha),lookupProto:(id:string,version:number)=>protos.get(id+':'+version)};
  const parsed=readStudioTemplate(text(input.template),options);check(parsed.schema==='hwpx-studio/template@2','2판 템플릿을 선택하세요.');
  const original=parsed as StudioTemplate;
  for(const c of [...protos.values(),...original.blocks.map(b=>b.content)])if('fragment' in c){const bytes=blobs.get(c.fragment);check(bytes,'참조하는 조각 파일을 선택하세요.');parseFragment(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  // 임시 연결과 저장 연결 모두 같은 공개 읽기 계약으로 검사한다.
  const template=input.bindings===undefined?original:readStudioTemplate(writeStudioTemplate({...original,bindings:input.bindings as StudioTemplate['bindings']}),options) as StudioTemplate;
  let raw:unknown;try{raw=JSON.parse(text(input.data));}catch{throw new HostError(400,'MAPPING_INPUT','데이터 JSON을 확인하세요.');}
  check(raw&&typeof raw==='object','데이터는 객체 또는 객체 배열이어야 합니다.');
  const rows=readBatchRecords(raw)??[{dataset:readDataset(raw)}];
  const row=input.row;check(typeof row==='number'&&Number.isInteger(row)&&row>=0&&row<rows.length,'확인할 데이터 행을 선택하세요.');
  const chosen=rows[row]!;if('error' in chosen)throw new HostError(400,chosen.error.code,chosen.error.message);
  const columns=[...new Set(rows.flatMap(r=>'dataset' in r?Object.keys(r.dataset.data):[]))];
  return {original,template,options,data:chosen.dataset.data,row,rows:rows.length,columns};
}
function view(loaded:ReturnType<typeof load>,template=loaded.template) {
  return {template,rows:loaded.rows,row:loaded.row,columns:loaded.columns,values:bindValues(template,loaded.data,undefined),locations:template.values.map(value=>({value:value.id,places:template.places.filter(p=>p.value===value.id)}))};
}
export function previewMapping(input:Record<string,unknown>){return view(load(input));}
export function updateMapping(input:Record<string,unknown>){
  check(input.bindings!==undefined,'저장할 연결을 확인하세요.');const loaded=load(input),version=loaded.original.version;
  check(Number.isSafeInteger(version)&&version<Number.MAX_SAFE_INTEGER,'새 판 번호를 만들 수 없습니다.');
  const template=readStudioTemplate(writeStudioTemplate({...loaded.template,version:version+1}),loaded.options) as StudioTemplate;
  return {...view(loaded,template),document:writeStudioTemplate(template),previous:{version,sha256:templateSha256(loaded.original)}};
}
