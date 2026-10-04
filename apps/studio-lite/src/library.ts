import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readBlockProto, writeBlockProto, readStudioTemplate, writeStudioTemplate, templateSha256, contentSha256, parseFragment, openPackage, parseDocument, readDataset, readBatchRecords, bindValues, selectSlots, type BlockContent, type StudioTemplate, type BlockProto, type BatchRecord } from '@hwpx-studio/engine';
import { HostError } from '../../../packages/viewer/src/host/index.ts';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const input=(ok:unknown,message:string):void=>{if(!ok)throw new HostError(400,'LIBRARY_INPUT',message);};
const missing=(ok:unknown,message:string):void=>{if(!ok)throw new HostError(404,'LIBRARY_REFERENCE',message);};
const text=(v:unknown):string=>{input(typeof v==='string','파일 내용을 확인하세요.');return v as string;};

/** Immutable contract revisions. Legacy project_revision is neither read nor written here. */
export function createLibrary(db:DatabaseSync) {
  db.exec(`
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
  return {
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
        for(const raw of rawBlobs as unknown[]) {
          const encoded=text(raw),bytes=Buffer.from(encoded,'base64');
          input(bytes.toString('base64')===encoded,'원본 파일 인코딩을 확인하세요.');
          const sha=hash(bytes),old=db.prepare('SELECT bytes FROM studio_blob WHERE sha=?').get(sha);
          if(old)input(Buffer.from(old.bytes as Uint8Array).equals(bytes),'같은 해시의 원본 바이트가 다릅니다.');
          else db.prepare('INSERT INTO studio_blob VALUES(?,?)').run(sha,bytes);
        }
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
    preview(id:string,version:number,dataId:string,dataVersion:number,row:number) {
      const t=template(id,version),d=dataset(dataId,dataVersion);
      input(Number.isInteger(row)&&row>=0&&row<d.records.length,'확인할 데이터 행을 선택하세요.');
      const record=d.records[row]!;
      if('error' in record)throw new HostError(400,record.error.code,record.error.message);
      const values=bindValues(t,record.dataset.data,undefined);
      return {values,slots:selectSlots(t,values,undefined)};
    }
  };
}
