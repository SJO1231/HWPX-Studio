import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { extractFragment, findPlaceholders, listFields, type Fragment, type FragmentSelection, type HwpxDocument } from '@hwpx-studio/engine';
import { HostError } from '../../../packages/viewer/src/host/index.ts';
import { plainOf } from './quick-messages.ts';

// App-local storage of the existing engine fragment, not a new block-proto contract.
export type BlockDraft = {
  id: string; sourceName: string; sourceHash: string; location: string;
  paragraphCount: number; inputCount: number; excerpt: string;
  fragment: Fragment; warnings: string[];
};
type StoredBlock = {
  id: string; name: string; sourceName: string; sourceHash: string; location: string;
  version: number; change: string; createdAt: string; paragraphCount: number; inputCount: number;
};
const fail = (code: string, message: string): never => { throw new HostError(400, code, message); };

export function extractBlockDraft(doc: HwpxDocument, sourceName: string, selection: FragmentSelection): BlockDraft {
  let fragment: Fragment;
  try { fragment = extractFragment(doc, selection); }
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
    excerpt: fragment.texts.join('\n').slice(0, 12000), fragment,
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
    save(draft: BlockDraft, name: unknown) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(name))
        return fail('BLOCK_NAME', '블록 이름은 줄바꿈 없이 1~120자로 입력하세요.');
      const previous = db.prepare('SELECT name FROM lite_block WHERE id = ?').get(draft.id);
      if (previous) {
        if (previous.name !== name.trim()) return fail('BLOCK_ALREADY_SAVED', '이미 저장한 범위입니다. 새 범위를 선택하세요.');
        return this.get(draft.id);
      }
      db.prepare(`INSERT INTO lite_block
        (id,name,source_name,source_hash,location,version,change,created_at,paragraph_count,input_count,excerpt,warnings,fragment)
        VALUES (?,?,?,?,?,1,'첫 저장',?,?,?,?,?,?)`).run(
          draft.id, name.trim(), draft.sourceName, draft.sourceHash, draft.location, new Date().toISOString(),
          draft.paragraphCount, draft.inputCount, draft.excerpt, JSON.stringify(draft.warnings), JSON.stringify(draft.fragment));
      return this.get(draft.id);
    },
  };
}
export type BlockLibrary = ReturnType<typeof createBlockLibrary>;
