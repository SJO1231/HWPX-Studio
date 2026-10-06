import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { extractBlock, blockFragment, listProtoUsage, readStudioTemplate, type StudioTemplate, makeRangeAnchor, parseFragment, serializeFragment, readBlockProto, findPlaceholders, buildBlockPreviewDocument, type BlockProto, type Fragment, type FragmentSelection, type HwpxDocument } from '@hwpx-studio/engine';
import { HostError } from '../../../packages/viewer/src/host/index.ts';
import { plainOf } from './quick-messages.ts';

// SQLite retains the engine proto and its canonical fragment together.
export type BlockDraft = {
  id: string; sourceName: string; sourceHash: string; location: string;
  paragraphCount: number; inputCount: number | null; excerpt: string;
  fragment: Fragment; proto: BlockProto; warnings: string[];
};
type StoredBlock = {
  id: string; protoId: string; name: string; sourceName: string; sourceHash: string; location: string;
  version: number; change: string; createdAt: string; paragraphCount: number; inputCount: number | null;
};
const fail = (code: string, message: string): never => { throw new HostError(400, code, message); };

function previewInputCount(proto: BlockProto, fragment: Fragment): number | null {
  try { return buildBlockPreviewDocument(proto,new TextEncoder().encode(serializeFragment(fragment))).fields.reduce((sum,f)=>sum+f.count,0); }
  catch { return null; } // A rejected preview must not prevent saving the original fragment.
}

function checkName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(name))
    fail('BLOCK_NAME', '블록 이름은 줄바꿈 없이 1~120자로 입력하세요.');
}

export function extractBlockDraft(doc: HwpxDocument, sourceName: string, selection: FragmentSelection): BlockDraft {
  let fragment: Fragment, proto: BlockProto;
  try { const range = makeRangeAnchor(doc, selection); if (!range) return fail('FRAG_SELECTION', '선택 범위를 다시 확인하세요.');
    const extracted = extractBlock(doc, range, {id:'k'+randomBytes(4).toString('hex'),name:'새 블록',at:new Date().toISOString()});
    fragment=extracted.fragment; proto=extracted.proto;
  }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'FRAG_SELECTION';
    return fail(code, plainOf(code) ?? '이 범위를 블록으로 저장할 수 없습니다. 원본은 변경되지 않았습니다.');
  }
  if (Buffer.byteLength(JSON.stringify(fragment)) > 32 * 1024 * 1024)
    return fail('BLOCK_SIZE', '선택한 블록이 너무 큽니다. 더 작은 범위를 선택하세요.');
  const count = selection.to - selection.from + 1;
  const first = fragment.texts.find(t => t.trim())?.replace(/\uFFFC/g, '[표·개체]').trim().slice(0, 40) || '(빈 문단)';
  return {
    id: randomUUID(), sourceName, sourceHash: fragment.source.sha256,
    location: `쪽 미확인 · ${selection.parentPath.length ? '같은 칸 안' : '본문'} · 문단 ${count}개 · ${first}`,
    paragraphCount: count, inputCount: previewInputCount(proto,fragment),
    proto, excerpt: fragment.texts.join('\n').slice(0, 12000), fragment,
    warnings: fragment.issues.map(i => plainOf(i.code) ?? '원문에 확인이 필요한 서식 참조가 있습니다.'),
  };
}

export function createBlockLibrary(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS lite_block (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, source_name TEXT NOT NULL, source_hash TEXT NOT NULL,
    location TEXT NOT NULL, version INTEGER NOT NULL CHECK (version >= 1), change TEXT NOT NULL,
    created_at TEXT NOT NULL, paragraph_count INTEGER NOT NULL, input_count INTEGER NOT NULL,
    excerpt TEXT NOT NULL, warnings TEXT NOT NULL, fragment TEXT NOT NULL
  )`);
  const oldSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='lite_block'").get()!.sql);
  if (/CHECK\s*\(version = 1\)/.test(oldSql)) {
    db.exec('BEGIN');
    try { db.exec('ALTER TABLE lite_block RENAME TO lite_block_old'); db.exec(oldSql.replace(/CHECK\s*\(version = 1\)/, 'CHECK (version >= 1)')); db.exec('INSERT INTO lite_block SELECT * FROM lite_block_old; DROP TABLE lite_block_old; COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.exec('CREATE TABLE IF NOT EXISTS lite_workspace_usage (id TEXT PRIMARY KEY, name TEXT NOT NULL, pins TEXT NOT NULL)');
  const cols=db.prepare('PRAGMA table_info(lite_block)').all();
  if(!cols.some(c=>c.name==='proto'))db.exec('ALTER TABLE lite_block ADD COLUMN proto TEXT');
  const ids=new Set((db.prepare('SELECT proto FROM lite_block WHERE proto IS NOT NULL').all() as {proto:string}[]).map(r=>readBlockProto(r.proto).id));
  for(const row of db.prepare('SELECT id,name,fragment FROM lite_block WHERE proto IS NULL').all() as {id:string;name:string;fragment:string}[]){
    let id: string;do{id='k'+randomBytes(4).toString('hex');}while(ids.has(id));ids.add(id);
    const fragment=parseFragment(row.fragment),blob=serializeFragment(fragment);
    // Legacy rows lack the source range fingerprint. Do not invent extraction metadata.
    const proto=readBlockProto(JSON.stringify({schema:'hwpx-studio/block-proto@1',id,version:1,name:row.name,content:{fragment:createHash('sha256').update(blob).digest('hex')},keys:[...new Set(fragment.texts.flatMap(t=>findPlaceholders(t).map(k=>k.path)))]}));
    db.prepare('UPDATE lite_block SET proto=? WHERE id=? AND proto IS NULL').run(JSON.stringify(proto),row.id);
  }
  db.exec("DROP INDEX IF EXISTS lite_block_proto_id; CREATE UNIQUE INDEX IF NOT EXISTS lite_block_proto_version ON lite_block(json_extract(proto,'$.id'), version)");
  const columns = `id, json_extract(proto,'$.id') AS protoId, name, source_name AS sourceName, source_hash AS sourceHash, location,
    version, change, created_at AS createdAt, paragraph_count AS paragraphCount, input_count AS inputCount`;
  const counts=new Map<string,number|null>();
  function inputCount(id:string):number|null {
    if(!counts.has(id)){
      const row=db.prepare('SELECT proto,fragment FROM lite_block WHERE id=?').get(id) as {proto:string;fragment:string};
      counts.set(id,previewInputCount(readBlockProto(row.proto),parseFragment(row.fragment)));
    }
    return counts.get(id)!;
  }
  return {
    list(query = ''): StoredBlock[] {
      if (typeof query !== 'string' || query.length > 200) return fail('BLOCK_SEARCH', '검색어는 200자 이내로 입력하세요.');
      return (db.prepare(`SELECT ${columns} FROM lite_block b WHERE version = (SELECT MAX(version) FROM lite_block v WHERE json_extract(v.proto,'$.id')=json_extract(b.proto,'$.id')) AND (instr(lower(name),lower(?))>0 OR instr(source_hash,lower(?))>0) ORDER BY created_at DESC, rowid DESC`).all(query,query) as StoredBlock[]).map(row=>({...row,inputCount:inputCount(row.id)}));
    },
    get(id: unknown) {
      if (typeof id !== 'string') throw new HostError(404, 'BLOCK_NOT_FOUND', '저장한 블록을 찾지 못했습니다.');
      const row = db.prepare(`SELECT ${columns}, excerpt, warnings FROM lite_block WHERE id = ? OR json_extract(proto,'$.id') = ? ORDER BY version DESC LIMIT 1`).get(id,id) as (StoredBlock & {excerpt: string; warnings: string}) | undefined;
      if (!row) throw new HostError(404, 'BLOCK_NOT_FOUND', '저장한 블록을 찾지 못했습니다.');
      return { ...row, inputCount:inputCount(row.id), warnings: JSON.parse(row.warnings) as string[] };
    },
    material(id: unknown, version: unknown) {
      const found=this.get(id);
      if (!Number.isInteger(version) || Number(version)<1) return fail('BLOCK_VERSION','블록 판 번호를 확인하세요.');
      const row=db.prepare("SELECT id,proto,fragment FROM lite_block WHERE json_extract(proto,'$.id')=? AND version=?").get(found.protoId,Number(version)) as {id:string;proto:string;fragment:string}|undefined;
      if (!row) return fail('BLOCK_VERSION','이 블록의 요청한 판을 찾지 못했습니다. 저장소에서 다시 고르세요.');
      const item=this.get(row.id),stored=row;
      const proto=readBlockProto(stored.proto),blob=new TextEncoder().encode(serializeFragment(parseFragment(stored.fragment)));
      return {item,proto,blob,fragment:blockFragment(proto,blob)};
    },
    rename(id: unknown, name: unknown) {
      const item=this.get(id);checkName(name);
      db.prepare("UPDATE lite_block SET name=? WHERE json_extract(proto,'$.id')=?").run(name.trim(),item.protoId);
      return this.get(item.protoId);
    },
    usage(id: unknown) {
      const item=this.get(id), latest=this.get(item.protoId).version;
      const templates=new Map<string,StudioTemplate>();
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_revision'").get()) {
        for(const row of db.prepare("SELECT document FROM project_revision WHERE json_extract(document,'$.schema')='hwpx-studio/template@2'").all()) {
          const t=readStudioTemplate(String(row.document));
          if(t.schema==='hwpx-studio/template@2'&&(!templates.has(t.id)||templates.get(t.id)!.version<t.version))templates.set(t.id,t);
        }
      }
      const usages=listProtoUsage([...templates.values()],item.protoId,latest).usages.map(u=>({...u,name:templates.get(u.template)?.meta?.name??u.template,kind:'template'}));
      for(const row of db.prepare('SELECT id,name,pins FROM lite_workspace_usage').all()) {
        const pins=JSON.parse(String(row.pins)) as {id:string;version:number}[];
        for(const version of new Set(pins.filter(p=>p.id===item.protoId).map(p=>p.version)))usages.push({template:String(row.id),version:1,blocks:[],pinned:version,state:version<latest?'behind':'current',name:String(row.name),kind:'workspace'});
      }
      return {proto:item.protoId,latest,usages,templateTracking:templates.size>0};
    },
    saveWorkspace(id: string, name: string, pins: {id:string;version:number}[]) {
      const checked=pins.map(p=>{const {proto}=this.material(p.id,p.version);return {id:proto.id,version:proto.version};});
      db.prepare('INSERT INTO lite_workspace_usage(id,name,pins) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,pins=excluded.pins').run(id,name,JSON.stringify(checked));
    },
    remove(id: unknown, confirmed: unknown) {
      if(confirmed!==true)return fail('BLOCK_CONFIRM','삭제할 블록을 확인해 주세요.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const use=this.usage(id);
        if(use.usages.length)return fail('BLOCK_IN_USE','사용 중이라 삭제할 수 없습니다: '+use.usages.map(u=>u.name+' (판 '+(u.pinned??u.forkedFrom)+')').join(', '));
        db.prepare("DELETE FROM lite_block WHERE json_extract(proto,'$.id')=?").run(use.proto);db.exec('COMMIT');return {deleted:true};
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    save(draft: BlockDraft, name: unknown) {
      checkName(name);
      const previous = db.prepare('SELECT name FROM lite_block WHERE id = ?').get(draft.id);
      if (previous) {
        if (previous.name !== name.trim()) return fail('BLOCK_ALREADY_SAVED', '이미 저장한 범위입니다. 새 범위를 선택하세요.');
        return this.get(draft.id);
      }
      const latest=db.prepare("SELECT MAX(version) AS version FROM lite_block WHERE json_extract(proto,'$.id')=?").get(draft.proto.id)!.version;
      if(draft.proto.version!==Number(latest??0)+1)return fail('BLOCK_VERSION','이전 판 다음 번호로 저장해 주세요. 옛 판은 보존합니다.');
      db.prepare(`INSERT INTO lite_block
        (id,name,source_name,source_hash,location,version,change,created_at,paragraph_count,input_count,excerpt,warnings,fragment,proto)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          draft.id, name.trim(), draft.sourceName, draft.sourceHash, draft.location, draft.proto.version, draft.proto.version===1?'첫 저장':'새 판 저장', new Date().toISOString(),
          draft.paragraphCount, draft.inputCount ?? -1, draft.excerpt, JSON.stringify(draft.warnings), serializeFragment(draft.fragment), JSON.stringify(readBlockProto(JSON.stringify({...draft.proto,name:name.trim()}))));
      return this.get(draft.id);
    },
  };
}
export type BlockLibrary = ReturnType<typeof createBlockLibrary>;
