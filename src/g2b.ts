import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boundData, checkProject, checkRecords, object, parseCondition } from './core.ts';
import { applyProject } from './hwpx.ts';
import { evaluateCondition } from '../vendor/hwpx-engine/index.ts';
import type { Project } from './model.ts';

type Profile = { id:string; label:string; revisionId:number; outputDirectory:string };
type Item = { fields:Record<string,unknown>; userValues:Record<string,unknown>; children:unknown[]; source?:unknown; identity?:unknown; stage?:unknown };
type Request = { requestId:string; profileId:string; sourceKind:'screen'|'db'; items:Item[] };
type Result = { itemIndex:number; status:'success'|'needs-input'|'error'; path?:string; reused?:boolean; code?:string; message?:string; missingFields?:string[]; conflicts?:string[] };
type Plan = { path:string; sha256:string; output:string };
type ItemRecord = { result?:Result; plan?:Plan };
type StoredRequest = { fingerprint:string; profile_document:string; project_document:string };
const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const message=(e:unknown)=>e instanceof Error?e.message:'문서 생성에 실패했습니다.';
const canonical=(value:any):string=>value===null || typeof value!=='object' ? JSON.stringify(value) : Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
const profileId=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);

export class G2BRequestError extends Error {
  status:number;
  code:string;
  constructor(status:number,code:string,text:string){super(text);this.status=status;this.code=code;}
}
class NeedsInput extends Error {
  code:string;
  details:Pick<Result,'missingFields'|'conflicts'>;
  constructor(code:string,text:string,details:Pick<Result,'missingFields'|'conflicts'>={}){super(text);this.code=code;this.details=details;}
}

function checkRequest(v:any):asserts v is Request {
  if(!object(v) || Object.keys(v).some(k=>!['requestId','profileId','sourceKind','items'].includes(k)) || typeof v.requestId!=='string' || v.requestId.length<1 || v.requestId.length>200 || !profileId(v.profileId) || !['screen','db'].includes(v.sourceKind as string) || !Array.isArray(v.items) || v.items.length<1 || v.items.length>100)
    throw new G2BRequestError(400,'INVALID_REQUEST','요청 ID, 생성 프로필, 데이터 종류와 1~100개 항목을 확인하세요. 프로젝트나 출력 경로는 생성 요청에 넣을 수 없습니다.');
  if(!v.items.every(i=>object(i) && object(i.fields) && object(i.userValues) && Array.isArray(i.children) && Object.keys(i).every(k=>['fields','userValues','children','source','identity','stage'].includes(k))))
    throw new G2BRequestError(400,'INVALID_ITEMS','각 항목에는 fields, userValues 객체와 children 배열이 필요합니다.');
}

// The existing formatter uses Number/toLocaleString. Accept integer won only,
// and check the original decimal syntax before any Number conversion occurs.
function checkMoney(value:unknown,column:string) {
  const text=typeof value==='string'?value.normalize('NFKC').trim().replace(/^금\s*/,'').replace(/원(?:정)?$/,'').replace(/[,\s₩]/g,''):String(value);
  if((typeof value!=='string' && typeof value!=='number') || !/^[+-]?\d+(?:\.0+)?$/.test(text) || (typeof value==='number' && !Number.isSafeInteger(value)))
    throw new NeedsInput('MONEY_PRECISION',`${column}: 이번 연결은 정수 원 금액만 지원합니다. 소수 금액은 문자 필드로 매핑하세요.`);
  const integer=BigInt(text.replace(/\.0+$/,''));
  if(integer>BigInt(Number.MAX_SAFE_INTEGER) || integer<BigInt(-Number.MAX_SAFE_INTEGER))
    throw new NeedsInput('MONEY_PRECISION',`${column}: 정확히 표현할 수 있는 금액 범위를 넘었습니다. 문자 필드로 매핑하세요.`);
}

function itemProject(project:Project,item:Item):Project {
  if(!item.children.every(child=>object(child) && typeof child.key==='string' && child.key.length>0 && typeof child.label==='string' && ['items','qualification','other'].includes(child.kind as string) && Array.isArray(child.rows) && child.rows.every(object)))
    throw new NeedsInput('INVALID_CHILDREN','하위 표의 이름·종류와 rows 객체 배열을 확인하세요.');
  if(item.children.some(child=>(child as {rows:unknown[]}).rows.length>0)) throw new NeedsInput('UNSUPPORTED_CHILDREN','반복·하위 데이터는 첫 연결에서 지원하지 않습니다. 단일 값 항목만 선택하세요.');
  try {checkRecords([item.fields,item.userValues]);} catch(e){throw new NeedsInput('INVALID_FIELDS',message(e));}
  const collisions=Object.keys(item.userValues).filter(k=>Object.hasOwn(item.fields,k));
  if(collisions.length) throw new NeedsInput('FIELD_COLLISION','원천 값과 사용자 입력의 이름이 겹칩니다. 이름을 구분한 뒤 다시 요청하세요.',{conflicts:collisions});
  const row={...item.fields,...item.userValues};
  const fields=project.fields.filter(f=>f.approved && f.kind==='field');
  const missing=[...new Set(fields.map(f=>f.column||f.name).filter(k=>!Object.hasOwn(row,k) || row[k]===null))];
  if(missing.length) throw new NeedsInput('MISSING_FIELDS',`필수 데이터 값이 없습니다: ${missing.join(', ')}. 값을 입력하거나 저장된 프로젝트의 Column 매핑을 확인하세요.`,{missingFields:missing});
  // boundData writes Field aliases into the row. Detect alias collisions first.
  const aliasValues=new Map<string,unknown>();
  for(const f of fields) {
    const column=f.column||f.name;
    if(aliasValues.has(f.name) && (project.fields.filter(x=>x.approved && x.kind==='field' && x.name===f.name).some(x=>(x.column||x.name)!==column || x.format!==f.format)))
      throw new NeedsInput('FIELD_COLLISION','저장된 프로젝트에 같은 Field 이름의 서로 다른 Column 매핑이 있습니다.',{conflicts:[f.name]});
    if(column!==f.name && Object.hasOwn(row,f.name)) throw new NeedsInput('FIELD_COLLISION',`${f.name}: Field 이름과 전달 데이터 열이 겹칩니다. Studio에서 Column 매핑을 구분하세요.`,{conflicts:[f.name]});
    aliasValues.set(f.name,row[column]);
    if(f.format==='money') checkMoney(row[column],column);
  }
  const p=structuredClone(project);p.records=[row];
  const mapped=boundData(p,row), conditionData={...mapped};
  for(const f of fields.filter(f=>f.format==='money')) conditionData[f.name]=Number(String(mapped[f.name]).replace(/[,원\s]/g,''));
  const groups=[...new Set(p.mode==='markdown'?[...p.markdown.matchAll(/\[IN_TEMPLATE:([^\]]+)\]/g)].map(m=>m[1]):p.ranges.map(r=>r.group))];
  for(const group of groups) {
    const candidates=p.blocks.filter(b=>b.group===group), selected=p.selectedBlocks?.[group];
    if(selected) {
      if(!candidates.some(b=>b.id===selected)) throw new NeedsInput('BLOCK_SELECTION',`${group}: 저장된 Block 선택을 다시 확인하세요.`);
      continue;
    }
    const conditional=candidates.filter(b=>b.condition.trim()), missingConditions=[...new Set(conditional.flatMap(b=>parseCondition(b.condition).all.map((rule:{path:string})=>rule.path)).filter(key=>!Object.hasOwn(conditionData,key) || conditionData[key]===null || conditionData[key]===''))] as string[];
    if(missingConditions.length) throw new NeedsInput('MISSING_CONDITION_FIELDS',`${group}: 조건 판단에 필요한 데이터가 없습니다: ${missingConditions.join(', ')}. 값을 보완하거나 Studio에서 Block을 직접 선택하세요.`,{missingFields:missingConditions});
    const conditions=conditional.filter(b=>evaluateCondition(parseCondition(b.condition),{data:conditionData,derived:{}}));
    const highest=conditions.length?Math.max(...conditions.map(b=>b.priority)):null;
    const choices=highest===null?candidates.filter(b=>!b.condition.trim()):conditions.filter(b=>b.priority===highest);
    if(choices.length!==1) throw new NeedsInput('BLOCK_SELECTION',`${group}: 적용할 Block이 ${choices.length? '여러 개입니다':'없습니다'}. Studio에서 Block을 명시적으로 선택하고 프로젝트를 저장하세요.`,{conflicts:choices.map(b=>b.id)});
  }
  return p;
}

// Linking a fully flushed temporary file publishes it atomically and fails if
// the destination exists. Rename is deliberately avoided because it overwrites.
function saveOutput(plan:Plan):boolean {
  const bytes=Buffer.from(plan.output,'base64');
  if(sha256(bytes)!==plan.sha256) throw new Error('저장된 생성 기록의 파일 해시가 일치하지 않습니다.');
  try {
    if(!lstatSync(plan.path).isFile() || lstatSync(plan.path).isSymbolicLink())throw new Error('출력 위치에 일반 파일이 아닌 항목이 있습니다. 기존 항목은 변경하지 않았습니다.');
    const existing=readFileSync(plan.path);
    if(sha256(existing)!==plan.sha256) throw new Error('같은 이름의 다른 파일이 있습니다. 기존 파일은 덮어쓰지 않았습니다.');
    return true;
  } catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const temporary=join(dirname(plan.path),`.g2b-${randomUUID()}.tmp`);
  let fd:number|undefined;
  try {
    fd=openSync(temporary,'wx');writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;
    try {linkSync(temporary,plan.path);} catch(e) {
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      if(!lstatSync(plan.path).isFile() || lstatSync(plan.path).isSymbolicLink())throw new Error('출력 위치에 일반 파일이 아닌 항목이 있습니다. 기존 항목은 변경하지 않았습니다.');
      if(sha256(readFileSync(plan.path))!==plan.sha256) throw new Error('같은 이름의 다른 파일이 있습니다. 기존 파일은 덮어쓰지 않았습니다.');
      return true;
    }
    return false;
  } finally {
    if(fd!==undefined)closeSync(fd);
    try {unlinkSync(temporary);} catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
}

export function createG2B(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS g2b_profile (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS g2b_request (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, profile_document TEXT NOT NULL, project_document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS g2b_item (request_id TEXT NOT NULL, item_index INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(request_id,item_index));`);
  const flights=new Map<string,Promise<unknown>>();
  const profiles=()=>db.prepare('SELECT document FROM g2b_profile ORDER BY id').all().map(row=>JSON.parse(String(row.document)) as Profile);
  function saveProfile(input:any):Profile {
    if(!object(input) || Object.keys(input).some(k=>!['id','label','revisionId','outputDirectory'].includes(k)) || !profileId(input.id) || typeof input.label!=='string' || !input.label.trim() || input.label.length>120 || !Number.isSafeInteger(input.revisionId) || Number(input.revisionId)<1 || typeof input.outputDirectory!=='string' || !isAbsolute(input.outputDirectory))
      throw new G2BRequestError(400,'INVALID_PROFILE','프로필 ID·이름·저장된 프로젝트와 절대 출력 폴더 경로를 확인하세요.');
    const row=db.prepare('SELECT document FROM project_revision WHERE id=?').get(input.revisionId as number);
    if(!row) throw new G2BRequestError(400,'MISSING_REVISION','선택한 저장 프로젝트가 없습니다. 먼저 프로젝트를 저장하세요.');
    checkProject(JSON.parse(String(row.document)));
    mkdirSync(input.outputDirectory,{recursive:true});
    const outputDirectory=realpathSync(input.outputDirectory);
    if(!statSync(outputDirectory).isDirectory()) throw new G2BRequestError(400,'INVALID_DIRECTORY','출력 경로가 폴더가 아닙니다.');
    const p:Profile={id:input.id,label:input.label.trim(),revisionId:input.revisionId as number,outputDirectory};
    db.prepare('INSERT INTO g2b_profile(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(p.id,JSON.stringify(p));
    return p;
  }
  const getItem=(id:string,index:number):ItemRecord|undefined=>{
    const row=db.prepare('SELECT document FROM g2b_item WHERE request_id=? AND item_index=?').get(id,index);
    return row?JSON.parse(String(row.document)):undefined;
  };
  const putItem=(id:string,index:number,value:ItemRecord)=>db.prepare('INSERT INTO g2b_item(request_id,item_index,document) VALUES (?,?,?) ON CONFLICT(request_id,item_index) DO UPDATE SET document=excluded.document').run(id,index,JSON.stringify(value));
  function response(requestId:string,results:Result[]) {
    const summary={succeeded:results.filter(r=>r.status==='success').length,needsInput:results.filter(r=>r.status==='needs-input').length,failed:results.filter(r=>r.status==='error').length};
    const statuses=new Set(results.map(r=>r.status));
    const status=statuses.size>1?'partial':results[0]?.status??'error';
    return {requestId,status,results,summary};
  }
  async function process(input:Request,fingerprint:string) {
    let stored=db.prepare('SELECT fingerprint,profile_document,project_document FROM g2b_request WHERE request_id=?').get(input.requestId) as StoredRequest|undefined;
    if(stored && stored.fingerprint!==fingerprint)throw new G2BRequestError(409,'REQUEST_CONFLICT','이 요청 ID는 다른 내용으로 사용되었습니다. 새 요청 ID로 보내세요.');
    if(!stored) {
      const profileRow=db.prepare('SELECT document FROM g2b_profile WHERE id=?').get(input.profileId);
      if(!profileRow)return response(input.requestId,input.items.map((_,itemIndex)=>({itemIndex,status:'needs-input',code:'MISSING_PROFILE',message:'Studio의 Helper 연결에서 생성 프로필을 설정하세요.'})));
      const profile=JSON.parse(String(profileRow.document)) as Profile;
      const projectRow=db.prepare('SELECT document FROM project_revision WHERE id=?').get(profile.revisionId);
      if(!projectRow)return response(input.requestId,input.items.map((_,itemIndex)=>({itemIndex,status:'needs-input',code:'MISSING_REVISION',message:'프로필에 지정된 저장 프로젝트가 없습니다. Studio에서 다시 선택하세요.'})));
      db.prepare('INSERT OR IGNORE INTO g2b_request(request_id,fingerprint,profile_document,project_document) VALUES (?,?,?,?)').run(input.requestId,fingerprint,String(profileRow.document),String(projectRow.document));
      stored=db.prepare('SELECT fingerprint,profile_document,project_document FROM g2b_request WHERE request_id=?').get(input.requestId) as StoredRequest;
      if(stored.fingerprint!==fingerprint)throw new G2BRequestError(409,'REQUEST_CONFLICT','이 요청 ID는 다른 내용으로 사용되었습니다. 새 요청 ID로 보내세요.');
    }
    const profile=JSON.parse(stored.profile_document) as Profile, project=JSON.parse(stored.project_document) as Project;
    checkProject(project);
    const results:Result[]=[];
    for(const [itemIndex,item] of input.items.entries()) {
      let record=getItem(input.requestId,itemIndex);
      if(record?.result?.status==='needs-input'){results.push(record.result);continue;}
      try {
        if(!record?.plan) {
          const p=itemProject(project,item);
          let generated;
          try {generated=await applyProject(p,0,p.selectedBlocks??{});} catch(e){throw new NeedsInput('GENERATION_INPUT',message(e));}
          const output=generated.output, path=join(profile.outputDirectory,`g2b-${sha256(input.requestId)}-${itemIndex+1}.hwpx`);
          const plan:Plan={path,sha256:sha256(Buffer.from(output,'base64')),output};
          // A concurrent process may already have journaled a different ZIP byte
          // timestamp. Both use the first committed plan, never overwrite it.
          db.prepare('INSERT OR IGNORE INTO g2b_item(request_id,item_index,document) VALUES (?,?,?)').run(input.requestId,itemIndex,JSON.stringify({plan}));
          record=getItem(input.requestId,itemIndex)!;
        }
        const plan=record.plan!;
        if(realpathSync(profile.outputDirectory)!==profile.outputDirectory || !statSync(profile.outputDirectory).isDirectory())throw new Error('출력 폴더가 이동되거나 변경되었습니다. Studio에서 새 프로필을 설정하세요.');
        const reused=saveOutput(plan), result:Result={itemIndex,status:'success',path:plan.path,reused,message:reused?'기존 요청의 생성 파일을 확인했습니다.':'문서를 생성해 저장했습니다.'};
        putItem(input.requestId,itemIndex,{plan,result});results.push(result);
      } catch(e) {
        const result:Result=e instanceof NeedsInput?{itemIndex,status:'needs-input',code:e.code,message:e.message,...e.details}:{itemIndex,status:'error',code:'OUTPUT_ERROR',message:message(e)};
        if(result.status==='needs-input')putItem(input.requestId,itemIndex,{result});
        // Keep the immutable output plan when publishing failed, for retry.
        results.push(result);
      }
    }
    return response(input.requestId,results);
  }
  function generate(input:any) {
    checkRequest(input);
    const fingerprint=sha256(canonical(input)), flightKey=input.requestId+'\n'+fingerprint;
    if(flights.has(flightKey))return flights.get(flightKey)!;
    const pending=process(input,fingerprint);
    flights.set(flightKey,pending);
    void pending.finally(()=>flights.delete(flightKey)).catch(()=>{});
    return pending;
  }
  return {profiles,saveProfile,generate};
}
