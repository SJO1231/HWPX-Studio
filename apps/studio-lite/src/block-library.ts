import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { extractBlock, blockFragment, makeRangeAnchor, parseFragment, serializeFragment, readBlockProto, findPlaceholders, listFields, type BlockProto, type Fragment, type FragmentSelection, type HwpxDocument } from '@hwpx-studio/engine';
import { HostError } from '../../../packages/viewer/src/host/index.ts';
import { plainOf } from './quick-messages.ts';

// SQLite retains the engine proto and its canonical fragment together.
export type BlockDraft = {
  id: string; sourceName: string; sourceHash: string; location: string;
  paragraphCount: number; inputCount: number; excerpt: string;
  fragment: Fragment; proto: BlockProto; warnings: string[];
};
type StoredBlock = {
  id: string; name: string; sourceName: string; sourceHash: string; location: string;
  version: number; change: string; createdAt: string; paragraphCount: number; inputCount: number;
};
const fail = (code: string, message: string): never => { throw new HostError(400, code, message); };

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
    paragraphCount: count, inputCount: listFields(doc).filter(f => f.sectionIndex === selection.sectionIndex && ['CLICK_HERE','MAILMERGE'].includes(f.type) && selection.parentPath.every((v,i) => f.path[i] === v) && f.path.length > selection.parentPath.length && f.path[selection.parentPath.length]! >= selection.from && f.path[selection.parentPath.length]! <= selection.to).length + fragment.texts.reduce((n, t) => n + findPlaceholders(t).length, 0),
    proto, excerpt: fragment.texts.join('\n').slice(0, 12000), fragment,
    warnings: fragment.issues.map(i => plainOf(i.code) ?? '원문에 확인이 필요한 서식 참조가 있습니다.'),
  };
}

export function createBlockLibrary(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS lite_block (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, source_name TEXT NOT NULL, source_hash TEXT NOT NULL,
    location TEXT NOT NULL, version INTEGER NOT NULL CHECK (version = 1), change TEXT NOT NULL,
    created_at TEXT NOT NULL, paragraph_count INTEGER NOT NULL, input_count INTEGER NOT NULL,
    excerpt TEXT NOT NULL, warnings TEXT NOT NULL, fragment TEXT NOT NULL
  )`);
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
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS lite_block_proto_id ON lite_block(json_extract(proto,'$.id'))");
  const columns = `id, name, source_name AS sourceName, source_hash AS sourceHash, location,
    version, change, created_at AS createdAt, paragraph_count AS paragraphCount, input_count AS inputCount`;
  return {
    list(): StoredBlock[] { return db.prepare(`SELECT ${columns} FROM lite_block ORDER BY created_at DESC, rowid DESC`).all() as StoredBlock[]; },
    get(id: unknown) {
      if (typeof id !== 'string') throw new HostError(404, 'BLOCK_NOT_FOUND', '저장한 블록을 찾지 못했습니다.');
      const row = db.prepare(`SELECT ${columns}, excerpt, warnings FROM lite_block WHERE id = ?`).get(id) as (StoredBlock & {excerpt: string; warnings: string}) | undefined;
      if (!row) throw new HostError(404, 'BLOCK_NOT_FOUND', '저장한 블록을 찾지 못했습니다.');
      return { ...row, warnings: JSON.parse(row.warnings) as string[] };
    },
    material(id: unknown, version: unknown) {
      const item=this.get(id);if(version!==item.version)return fail('BLOCK_VERSION','이 블록의 요청한 판을 찾지 못했습니다. 저장소에서 다시 고르세요.');
      const stored=db.prepare('SELECT proto,fragment FROM lite_block WHERE id=?').get(item.id) as {proto:string;fragment:string};
      const proto=readBlockProto(stored.proto),blob=new TextEncoder().encode(serializeFragment(parseFragment(stored.fragment)));
      return {item,proto,blob,fragment:blockFragment(proto,blob)};
    },
    save(draft: BlockDraft, name: unknown) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(name))
        return fail('BLOCK_NAME', '블록 이름은 줄바꿈 없이 1~120자로 입력하세요.');
      const previous = db.prepare('SELECT name FROM lite_block WHERE id = ?').get(draft.id);
      if (previous) {
        if (previous.name !== name.trim()) return fail('BLOCK_ALREADY_SAVED', '이미 저장한 범위입니다. 새 범위를 선택하세요.');
        return this.get(draft.id);
      }
      db.prepare(`INSERT INTO lite_block
        (id,name,source_name,source_hash,location,version,change,created_at,paragraph_count,input_count,excerpt,warnings,fragment,proto)
        VALUES (?,?,?,?,?,1,'첫 저장',?,?,?,?,?,?,?)`).run(
          draft.id, name.trim(), draft.sourceName, draft.sourceHash, draft.location, new Date().toISOString(),
          draft.paragraphCount, draft.inputCount, draft.excerpt, JSON.stringify(draft.warnings), serializeFragment(draft.fragment), JSON.stringify(readBlockProto(JSON.stringify({...draft.proto,name:name.trim()}))));
      return this.get(draft.id);
    },
  };
}
export type BlockLibrary = ReturnType<typeof createBlockLibrary>;
