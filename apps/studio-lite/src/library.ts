import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readCase, writeCase, caseSha256, canonicalStudioJson, generateFromTemplate, readBlockProto, writeBlockProto, readStudioTemplate, writeStudioTemplate, templateSha256, contentSha256, parseFragment, openPackage, parseDocument, readDataset, readBatchRecords, bindValues, selectSlots, type BlockContent, type StudioTemplate, type BlockProto, type BatchRecord, type StudioCase } from '@hwpx-studio/engine';
import { HostError } from '../../../packages/viewer/src/host/index.ts';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const input=(ok:unknown,message:string):void=>{if(!ok)throw new HostError(400,'LIBRARY_INPUT',message);};
const missing=(ok:unknown,message:string):void=>{if(!ok)throw new HostError(404,'LIBRARY_REFERENCE',message);};
const text=(v:unknown):string=>{input(typeof v==='string','파일 내용을 확인하세요.');return v as string;};

/** Immutable contract revisions. Legacy project_revision is neither read nor written here. */
export function createLibrary(db:DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_generation (id INTEGER PRIMARY KEY, document TEXT NOT NULL, sha TEXT NOT NULL, output BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS studio_case (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL, sha TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS studio_blob (sha TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS studio_proto (id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(id,version));
    CREATE TABLE IF NOT EXISTS studio_template (id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY(id,version));
    CREATE TABLE IF NOT EXISTS studio_dataset (id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL, sha TEXT NOT NULL, records INTEGER NOT NULL, PRIMARY KEY(id,version));
  `);
  const blob=(sha:string):Uint8Array=>{
    const row=db.prepare('SELECT bytes FROM studio_blob WHERE sha=?').get(sha);
    missing(row,'참조하는 원본 또는 조각이 없습니다.');
    const bytes=row!.bytes as Uint8Array;
    input(hash(bytes)===sha,'보관된 원본 또는 조각의 해시가 맞지 않습니다.');
    return bytes;
  };
  const hasBlob=(sha:string):boolean=>!!db.prepare('SELECT 1 FROM studio_blob WHERE sha=?').get(sha);
  const content=(c:BlockContent):void=>{if('fragment' in c)parseFragment(new TextDecoder('utf-8',{fatal:true}).decode(blob(c.fragment)));};
  const proto=(id:string,version:number):BlockProto|undefined=>{
    const row=db.prepare('SELECT document FROM studio_proto WHERE id=? AND version=?').get(id,version);
    if(!row)return;
    const p=readBlockProto(row.document as string);input(p.id===id&&p.version===version,'원형의 저장 키와 문서 판이 다릅니다.');content(p.content);return p;
  };
  const source=(t:StudioTemplate):Uint8Array=>{
    const bytes=blob(t.source.sha256);
    if(t.source.kind==='hwpx')parseDocument(openPackage(bytes));
    else new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    return bytes;
  };
  const template=(id:string,version:number):StudioTemplate=>{
    const row=db.prepare('SELECT document,sha FROM studio_template WHERE id=? AND version=?').get(id,version);
    missing(row,'저장한 템플릿 판이 없습니다.');
    const t=readStudioTemplate(row!.document as string,{hasBlob,lookupProto:(id,v)=>proto(id,v)?.content});
    input(t.schema==='hwpx-studio/template@2','이 보관함은 새 템플릿 저장 형식을 사용합니다.');
    const studio=t as StudioTemplate;
    input(studio.id===id&&studio.version===version,'템플릿의 저장 키와 문서 판이 다릅니다.');
    input(templateSha256(studio)===row!.sha,'보관된 템플릿의 해시가 맞지 않습니다.');
    source(studio);
    for(const b of studio.blocks) {
      content(b.content);
      if(b.forkedFrom)missing(proto(b.forkedFrom.id,b.forkedFrom.version),'분리한 블록이 참조하는 원형 판이 없습니다.');
    }
    return studio;
  };
  const checkHistory=(candidate:StudioTemplate):void=>{
    const versions=db.prepare('SELECT version FROM studio_template WHERE id=? AND version<>?').all(candidate.id,candidate.version);
    const history=[candidate,...versions.map(row=>template(candidate.id,Number(row.version)))].sort((a,b)=>a.version-b.version);
    let previous=new Set<string>();const retired=new Set<string>();
    for(const t of history) {
      const ids=new Set([...t.anchors,...(t.patterns??[]),...t.values,...t.places,...t.slots,...t.blocks].map(item=>item.id));
      for(const id of previous)if(!ids.has(id))retired.add(id);
      for(const id of ids)if(retired.has(id))throw new HostError(409,'LIBRARY_ID_REUSED','삭제한 내부 ID는 다시 사용할 수 없습니다. 새 ID로 저장하세요.');
      previous=ids;
    }
  };
  const records=(document:string):BatchRecord[]=>{
    let raw:unknown;try{raw=JSON.parse(document);}catch{throw new HostError(400,'LIBRARY_INPUT','데이터 JSON을 확인하세요.');}
    input(raw!==null&&typeof raw==='object','데이터는 객체 또는 객체 배열이어야 합니다.');
    const batch=readBatchRecords(raw);
    const rows=batch??[{dataset:readDataset(raw)}];
    input(rows.length>0,'데이터에 행이 없습니다.');return rows;
  };
  const dataset=(id:string,version:number)=>{
    const row=db.prepare('SELECT * FROM studio_dataset WHERE id=? AND version=?').get(id,version);
    missing(row,'저장한 데이터 판이 없습니다.');
    const document=row!.document as string;
    input(hash(new TextEncoder().encode(document))===row!.sha,'보관된 데이터의 해시가 맞지 않습니다.');
    return {id,version,name:row!.name as string,document,sha:row!.sha as string,records:records(document)};
  };
  const immutable=(table:'studio_proto'|'studio_template',id:string,version:number,document:string,name?:string,sha?:string)=>{
    const previous=db.prepare(`SELECT document FROM ${table} WHERE id=? AND version=?`).get(id,version);
    if(previous){if(previous.document!==document)throw new HostError(409,'LIBRARY_REVISION','이미 저장한 판은 바꿀 수 없습니다. 새 판으로 저장하세요.');return;}
    if(table==='studio_proto')db.prepare('INSERT INTO studio_proto VALUES(?,?,?)').run(id,version,document);
    else db.prepare('INSERT INTO studio_template VALUES(?,?,?,?,?)').run(id,version,name!,document,sha!);
  };
  const importBlobs=(rawBlobs:unknown):void=>{
    input(Array.isArray(rawBlobs),'원본 파일 목록을 확인하세요.');
    for(const raw of rawBlobs as unknown[]) {
      const encoded=text(raw),bytes=Buffer.from(encoded,'base64');
      input(bytes.toString('base64')===encoded,'원본 파일 인코딩을 확인하세요.');
      const sha=hash(bytes),old=db.prepare('SELECT bytes FROM studio_blob WHERE sha=?').get(sha);
      if(old)input(Buffer.from(old.bytes as Uint8Array).equals(bytes),'같은 해시의 원본 바이트가 다릅니다.');
      else db.prepare('INSERT INTO studio_blob VALUES(?,?)').run(sha,bytes);
    }
  };
  const rowOf=(dataId:string,version:number,row:number):Record<string,unknown>=>{
    const d=dataset(dataId,version);
    input(Number.isInteger(row)&&row>=0&&row<d.records.length,'확인할 데이터 행을 선택하세요.');
    const record=d.records[row]!;
    if('error' in record)throw new HostError(400,record.error.code,record.error.message);
    return record.dataset.data;
  };
  const checkedCase=(document:string):StudioCase=>{
    let raw:unknown;try{raw=JSON.parse(document);}catch{throw new HostError(400,'LIBRARY_INPUT','이번 건 JSON을 확인하세요.');}
    const reference=(raw as any)?.template;
    const t=template(text(reference?.id),Number(reference?.version));
    const c=readCase(document,t),record=rowOf(c.record.dataset,c.record.version,c.record.row);
    input(hash(new TextEncoder().encode(canonicalStudioJson(record)))===c.record.sha256,'이번 건이 참조하는 원본 행의 해시가 맞지 않습니다.');
    for(const edit of Object.values(c.blockEdits))content(edit);
    return c;
  };
  const savedCase=(id:number)=>{
    input(Number.isInteger(id)&&id>0,'저장한 이번 건을 선택하세요.');
    const row=db.prepare('SELECT * FROM studio_case WHERE id=?').get(id);missing(row,'저장한 이번 건이 없습니다.');
    const c=checkedCase(row!.document as string);input(caseSha256(c)===row!.sha,'보관된 이번 건의 해시가 맞지 않습니다.');
    return {id,revision:Number(row!.revision),document:row!.document as string,sha:row!.sha as string,case:c};
  };
  const appliedCase=(t:StudioTemplate,dataId:string,dataVersion:number,row:number,id?:number)=>{
    if(id===undefined)return;
    const c=savedCase(id).case;
    input(c.record.dataset===dataId&&c.record.version===dataVersion&&c.record.row===row,'이번 건에 저장한 데이터 판과 행을 선택하세요.');
    return readCase(writeCase(c),t);
  };
  const generation=(id:number)=>{
    input(Number.isInteger(id)&&id>0,'생성 기록을 선택하세요.');
    const row=db.prepare('SELECT * FROM studio_generation WHERE id=?').get(id);missing(row,'생성 기록이 없습니다.');
    const document=row!.document as string,output=row!.output as Uint8Array;
    input(hash(new TextEncoder().encode(document))===row!.sha,'생성 기록의 해시가 맞지 않습니다.');
    const saved=JSON.parse(document);
    input(hash(output)===saved.outputSha,'생성 출력의 해시가 맞지 않습니다.');
    return {id,...saved,output};
  };
  return {
    generations:()=>db.prepare("SELECT id,json_extract(document,'$.template') AS template,json_extract(document,'$.templateVersion') AS templateVersion,json_extract(document,'$.dataset') AS dataset,json_extract(document,'$.dataVersion') AS dataVersion,json_extract(document,'$.row') AS row,json_extract(document,'$.caseId') AS caseId,json_extract(document,'$.caseRevision') AS caseRevision,json_extract(document,'$.kind') AS kind,json_extract(document,'$.outputSha') AS outputSha FROM studio_generation ORDER BY id DESC").all(),
    generation,
    cases:()=>db.prepare("SELECT id,revision,json_extract(document,'$.template.id') AS template,json_extract(document,'$.template.version') AS templateVersion,json_extract(document,'$.record.dataset') AS dataset,json_extract(document,'$.record.version') AS dataVersion,json_extract(document,'$.record.row') AS row FROM studio_case ORDER BY id DESC").all(),
    case:savedCase,
    saveCase(inputData:Record<string,unknown>) {
      const document=text(inputData.document);
      db.exec('BEGIN IMMEDIATE');
      try {
        importBlobs(inputData.blobs??[]);
        const c=checkedCase(document),previous=inputData.id===undefined?undefined:savedCase(Number(inputData.id));
        if(previous) {
          const old=previous.case;
          if(c.template.id!==old.template.id||c.template.version!==old.template.version||c.record.dataset!==old.record.dataset||c.record.version!==old.record.version||c.record.row!==old.record.row)throw new HostError(409,'LIBRARY_CASE_RECORD','이번 건의 템플릿 판과 데이터 판·행은 바꿀 수 없습니다. 새 건으로 보관하세요.');
        }
        const canonical=writeCase(c),sha=caseSha256(c),revision=(previous?.revision??0)+1;
        const id=previous?.id??Number(db.prepare('INSERT INTO studio_case (revision,document,sha) VALUES(?,?,?)').run(revision,canonical,sha).lastInsertRowid);
        if(previous)db.prepare('UPDATE studio_case SET revision=?,document=?,sha=? WHERE id=?').run(revision,canonical,sha,id);
        db.exec('COMMIT');return {id,revision};
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    generate(id:string,version:number,dataId:string,dataVersion:number,row:number,caseId?:number) {
      const t=template(id,version),record=rowOf(dataId,dataVersion,row),c=appliedCase(t,dataId,dataVersion,row,caseId);
      const result=generateFromTemplate(source(t),t,record,c,sha=>hasBlob(sha)?blob(sha):undefined,{mode:'baseline'});
      if(!result.ok||result.dryRun)return result;
      const output=typeof result.output==='string'?new TextEncoder().encode(result.output):result.output;
      const snapshot={template:id,templateVersion:version,templateSha:templateSha256(t),dataset:dataId,dataVersion,row,recordSha:hash(new TextEncoder().encode(canonicalStudioJson(record))),caseId:caseId??null,caseRevision:caseId===undefined?null:savedCase(caseId).revision,caseDocument:c===undefined?null:writeCase(c),caseSha:c===undefined?null:caseSha256(c),kind:t.source.kind,outputSha:hash(output),ledger:result.ledger??null,report:result.report};
      const document=canonicalStudioJson(snapshot);
      const generationId=Number(db.prepare('INSERT INTO studio_generation (document,sha,output) VALUES(?,?,?)').run(document,hash(new TextEncoder().encode(document)),output).lastInsertRowid);
      return {...result,generationId};
    },
    templates:()=>db.prepare('SELECT id,version,name FROM studio_template ORDER BY name,id,version DESC').all(),
    datasets:()=>db.prepare('SELECT id,version,name,records FROM studio_dataset ORDER BY name,id,version DESC').all(),
    template,
    dataset,
    blob,
    source:(id:string,version:number)=>source(template(id,version)),
    save(inputData:Record<string,unknown>) {
      const document=text(inputData.template);
      const rawProtos=inputData.protos??[],rawBlobs=inputData.blobs??[];
      input(Array.isArray(rawProtos)&&Array.isArray(rawBlobs),'원형과 원본 파일 목록을 확인하세요.');
      db.exec('BEGIN IMMEDIATE');
      try {
        importBlobs(rawBlobs);
        const imported=(rawProtos as unknown[]).map(raw=>readBlockProto(text(raw)));
        for(const p of imported){content(p.content);immutable('studio_proto',p.id,p.version,writeBlockProto(p));}
        for(const p of imported)if(p.previous) {
          const previous=proto(p.id,p.previous.version);
          missing(previous,'원형의 이전 판이 없습니다.');
          input(contentSha256(previous!.content)===p.previous.content,'원형의 이전 내용 해시가 맞지 않습니다.');
        }
        const t=readStudioTemplate(document,{hasBlob,lookupProto:(id,v)=>proto(id,v)?.content});
        input(t.schema==='hwpx-studio/template@2','기존 프로젝트는 기존 저장 화면에서 사용하세요. 이관은 아직 준비 중입니다.');
        const studio=t as StudioTemplate;source(studio);
        for(const b of studio.blocks){content(b.content);if(b.forkedFrom)missing(proto(b.forkedFrom.id,b.forkedFrom.version),'분리한 블록의 원형 판이 없습니다.');}
        checkHistory(studio);
        immutable('studio_template',studio.id,studio.version,writeStudioTemplate(studio),studio.meta?.name??'저장한 템플릿',templateSha256(studio));
        db.exec('COMMIT');return {id:studio.id,version:studio.version};
      } catch(e){db.exec('ROLLBACK');throw e;}
    },
    saveDataset(inputData:Record<string,unknown>) {
      const document=text(inputData.content),rows=records(document);
      const name=text(inputData.name);input(name.length>0&&name.length<=180,'데이터 이름을 확인하세요.');
      const existing=inputData.id===undefined?undefined:dataset(text(inputData.id),Number(inputData.version));
      const id=existing?.id??'d'+randomBytes(4).toString('hex');
      const latest=db.prepare('SELECT MAX(version) AS version FROM studio_dataset WHERE id=?').get(id);
      const version=Number(latest?.version??0)+1;
      db.prepare('INSERT INTO studio_dataset VALUES(?,?,?,?,?,?)').run(id,version,name,document,hash(new TextEncoder().encode(document)),rows.length);
      return {id,version,records:rows.length};
    },
    preview(id:string,version:number,dataId:string,dataVersion:number,row:number,caseId?:number) {
      const t=template(id,version),record=rowOf(dataId,dataVersion,row),c=appliedCase(t,dataId,dataVersion,row,caseId);
      const values=bindValues(t,record,c);
      return {values,slots:selectSlots(t,values,c)};
    }
  };
}
