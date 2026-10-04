import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { canonicalStudioJson, caseSha256, extractFragment, generateFromTemplate, openPackage, parseDocument, serializeFragment, templateSha256, validateDocument, walkParagraphs, writeCase, writeStudioTemplate, type BlockProto, type StudioCase, type StudioGenerateResult, type StudioTemplate } from '@hwpx-studio/engine';
import { manual, noticeKit, recordFor } from '../../../packages/hwpx-engine/test/generate-v2-helpers.ts';
import { newErrorsAfter } from '../../../packages/hwpx-engine/test/helpers.ts';
import { longValue, rng } from '../../../packages/hwpx-engine/test/range-helpers.ts';
import { createLibrary } from '../src/library.ts';

type Library = ReturnType<typeof createLibrary>;
const encode = (s: string) => new TextEncoder().encode(s);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const rowSha = (row: Record<string, unknown>) => sha(encode(canonicalStudioJson(row)));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const code = (run: () => unknown, expected: string, status?: number) => assert.throws(run, (error: any) => error?.code === expected && (status === undefined || error.status === status));
let cached: ReturnType<typeof noticeKit> | undefined;
const kit = () => (cached ??= noticeKit());
const memory = (run: (db: DatabaseSync, library: Library) => void) => {
  const db = new DatabaseSync(':memory:');
  try { run(db, createLibrary(db)); } finally { db.close(); }
};
const snapshot = (db: DatabaseSync) => Object.fromEntries(['studio_blob', 'studio_proto', 'studio_template', 'studio_dataset', 'studio_case'].map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2').all()]));
const baseSnapshot = (db: DatabaseSync) => {
  const { studio_case: _cases, ...base } = snapshot(db);
  return base;
};
function setup(library: Library, content?: string) {
  const k = kit(), raw = structuredClone(k.t);
  const block = raw.blocks.find(b => b.id === 'b4')!;
  const proto: BlockProto = { schema: 'hwpx-studio/block-proto@1', id: 'k00000001', version: 1, name: '합성 계약 원형', content: block.content, keys: ['기관명'] };
  block.proto = { id: proto.id, version: proto.version };
  library.save({ template: JSON.stringify(raw), protos: [JSON.stringify(proto)], blobs: [k.bytes, ...k.blobs.values()].map(base64) });
  const t = library.template(raw.id, 1);
  const row = recordFor(name => '합성 값 ' + name, { price: 120000000, sme: 'Y' });
  const data = library.saveDataset({ content: content ?? JSON.stringify([row]), name: '합성 진행본 데이터' });
  return { k, t, data, row };
}
function caseFor(f: ReturnType<typeof setup>, row = f.row, index = 0): StudioCase {
  return {
    schema: 'hwpx-studio/case@1', template: { id: f.t.id, version: 1, sha256: templateSha256(f.t) },
    record: { dataset: f.data.id, version: f.data.version, row: index, sha256: rowSha(row) },
    selections: { s2: manual(f.t, 's2', 'b4'), s4: { ...manual(f.t, 's4', 'b7'), basis: 'confirmed' } },
    valueEdits: { [f.k.valueId('사업명')]: '이번 건에서 정정한 합성 사업 & <확인>' },
    blockEdits: { b7: { text: '이번 건 전용 합성 블록 {{사업명}}\n{{기관명}}의 정정 내용' } },
  };
}
function output(result: StudioGenerateResult): Uint8Array {
  assert.equal(result.ok, true, JSON.stringify(result.report.issues.filter(i => i.severity === 'error').map(i => i.code)));
  assert.ok(result.ok && !result.dryRun && result.output instanceof Uint8Array);
  return result.output;
}
function generationId(result: ReturnType<Library['generate']>): number {
  assert.ok(result.ok && !result.dryRun && 'generationId' in result);
  assert.ok(Number.isInteger(result.generationId) && result.generationId > 0);
  return result.generationId;
}

test('이번 건: 임시 SQLite 재시작 후 수동 선택·값/블록 정정을 복원하고 같은 HWPX를 생성', () => {
  const directory = mkdtempSync(join(resolve(tmpdir()), 'hwpx-library-case-'));
  let db: DatabaseSync | undefined;
  try {
    const file = join(directory, 'synthetic.sqlite'); db = new DatabaseSync(file);
    let library = createLibrary(db); const f = setup(library), c = caseFor(f), beforeBase = baseSnapshot(db);
    const original = Buffer.from(f.k.bytes), stored = library.saveCase({ document: JSON.stringify(c, null, 2) });
    const before = library.preview(f.t.id, 1, f.data.id, 1, 0, stored.id);
    assert.equal(before.slots.find(s => s.slot === 's2')?.state, 'manual');
    assert.equal(before.slots.find(s => s.slot === 's4')?.state, 'confirmed');
    assert.equal(before.slots.find(s => s.slot === 's4')?.differs, true);
    assert.equal(before.values.find(v => v.id === f.k.valueId('사업명'))?.state, 'edited');
    const generated = library.generate(f.t.id, 1, f.data.id, 1, 0, stored.id), bytes = output(generated);
    const texts = parseDocument(openPackage(bytes)).sections.flatMap(s => [...walkParagraphs(s.paragraphs)].map(p => p.logicalText)).join('\n');
    assert.ok(texts.includes(c.valueEdits[f.k.valueId('사업명')]!));
    assert.ok(texts.includes('이번 건 전용 합성 블록'));
    assert.deepEqual(newErrorsAfter(validateDocument(original), validateDocument(bytes)), []);
    assert.deepEqual(generated.report.validation?.newErrors, []);
    assert.equal(library.case(stored.id).document, writeCase(c));
    assert.equal(library.case(stored.id).sha, caseSha256(c));
    db.close(); db = undefined; db = new DatabaseSync(file); library = createLibrary(db);
    const restored = library.case(stored.id);
    assert.deepEqual(restored.case, c); assert.equal(restored.revision, 1);
    assert.deepEqual(library.cases().map(x => ({ ...x })), [{ id: stored.id, revision: 1, template: f.t.id, templateVersion: 1, dataset: f.data.id, dataVersion: 1, row: 0 }]);
    assert.deepEqual(library.preview(f.t.id, 1, f.data.id, 1, 0, stored.id), before);
    const after = library.generate(f.t.id, 1, f.data.id, 1, 0, stored.id);
    assert.deepEqual(output(after), bytes); assert.deepEqual(after.report, generated.report);
    if (after.ok && !after.dryRun && generated.ok && !generated.dryRun) assert.deepEqual(after.ledger, generated.ledger);
    const direct = generateFromTemplate(f.k.bytes, f.t, f.row, restored.case, hash => library.blob(hash), { mode: 'baseline' });
    assert.deepEqual(output(direct), bytes); assert.deepEqual(direct.report, after.report);
    assert.deepEqual(baseSnapshot(db), beforeBase); assert.deepEqual(Buffer.from(f.k.bytes), original);
  } finally {
    db?.close(); assert.equal(dirname(directory), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true });
  }
});

test('이번 건: ID 명시 갱신만 진행본 판 증가, ID 없는 저장은 별도 건이며 원형·템플릿·데이터 불변', () => memory((db, library) => {
  const f = setup(library), c = caseFor(f), base = baseSnapshot(db);
  const first = library.saveCase({ document: writeCase(c) });
  const changed = { ...c, valueEdits: { [f.k.valueId('사업명')]: '별도의 합성 정정 값' }, blockEdits: {} };
  const next = library.saveCase({ id: first.id, document: writeCase(changed) });
  assert.deepEqual(next, { id: first.id, revision: 2 }); assert.equal(library.cases().length, 1);
  assert.deepEqual(library.case(first.id).case, changed);
  const second = library.saveCase({ document: writeCase(c) });
  assert.notEqual(second.id, first.id); assert.equal(second.revision, 1); assert.equal(library.cases().length, 2);
  assert.deepEqual(library.case(first.id).case, changed); assert.deepEqual(library.case(second.id).case, c);
  assert.deepEqual(baseSnapshot(db), base);
}));

test('이번 건: 비BMP 키의 코드 포인트 정렬·중첩/배열·-0 정규 행 해시를 사용하고 원시 JSON 보존', () => memory((_db, library) => {
  const row = { ...recordFor(name => '합성 값 ' + name, { price: 120000000, sme: 'Y' }), '\u{10000}': { z: false, a: '000123' }, '\ue000': [0, false, { b: 1, a: 2 }], zero: -0 };
  const reversed = Object.fromEntries(Object.entries(row).reverse());
  const content = '[' + JSON.stringify(reversed).replace('"zero":0', '"zero":-0') + ']';
  const f = setup(library, content), c = caseFor(f, row);
  assert.notEqual(JSON.stringify(row), JSON.stringify(reversed));
  assert.equal(canonicalStudioJson(row), canonicalStudioJson(reversed));
  assert.ok(canonicalStudioJson(row).indexOf('"\ue000"') < canonicalStudioJson(row).indexOf('"\u{10000}"'));
  const raw = library.dataset(f.data.id, 1).records[0]!; assert('dataset' in raw); assert.ok(Object.is(raw.dataset.data.zero, -0));
  assert.equal(library.dataset(f.data.id, 1).document, content);
  const saved = library.saveCase({ document: writeCase(c) });
  assert.equal(library.case(saved.id).case.record.sha256, rowSha({ ...row, zero: 0 }));
  const result = library.generate(f.t.id, 1, f.data.id, 1, 0, saved.id); output(result);
  assert.ok(result.ok && !result.dryRun); assert.equal(result.ledger?.record.sha256, rowSha(row));
}));

test('이번 건: 깨진 참조·판·행·해시·정정 ID는 거부하며 가져온 덩어리와 부분 행을 남기지 않음', () => memory((db, library) => {
  const f = setup(library), c = caseFor(f), before = snapshot(db), unused = base64(encode('합성 취소 대상 덩어리'));
  const variants: [unknown, string, number?][] = [
    [{ ...c, schema: 'hwpx-studio/case@99' }, 'TPL_VERSION'],
    [{ ...c, template: { ...c.template, id: 't00000099' } }, 'LIBRARY_REFERENCE', 404],
    [{ ...c, template: { ...c.template, version: 99 } }, 'LIBRARY_REFERENCE', 404],
    [{ ...c, template: { ...c.template, sha256: '0'.repeat(64) } }, 'TPL_REF'],
    [{ ...c, record: { ...c.record, dataset: 'd00000099' } }, 'LIBRARY_REFERENCE', 404],
    [{ ...c, record: { ...c.record, version: 99 } }, 'LIBRARY_REFERENCE', 404],
    [{ ...c, record: { ...c.record, row: -1 } }, 'TPL_FIELD'],
    [{ ...c, record: { ...c.record, row: 0.5 } }, 'TPL_FIELD'],
    [{ ...c, record: { ...c.record, row: 1 } }, 'LIBRARY_INPUT', 400],
    [{ ...c, record: { ...c.record, sha256: '0'.repeat(64) } }, 'LIBRARY_INPUT', 400],
    [{ ...c, selections: { s99: c.selections.s2 } }, 'TPL_REF'],
    [{ ...c, selections: { s2: { ...c.selections.s2, block: 'b99' } } }, 'TPL_REF'],
    [{ ...c, valueEdits: { v99: '합성 정정' } }, 'TPL_REF'],
    [{ ...c, blockEdits: { b99: { text: '합성 정정' } } }, 'TPL_REF'],
    [{ ...c, blockEdits: { b7: { fragment: 'a'.repeat(64) } } }, 'LIBRARY_REFERENCE', 404],
  ];
  for (const [raw, expected, status] of variants) {
    code(() => library.saveCase({ document: JSON.stringify(raw), blobs: [unused] }), expected, status);
    assert.deepEqual(snapshot(db), before);
  }
  const invalid = encode('{"schema":"hwpx-studio/fragment@99"}');
  code(() => library.saveCase({ document: writeCase({ ...c, blockEdits: { b7: { fragment: sha(invalid) } } }), blobs: [base64(invalid)] }), 'FRAG_SCHEMA');
  code(() => library.saveCase({ document: '{broken', blobs: [unused] }), 'LIBRARY_INPUT', 400);
  for (const id of [0, -1, 0.5]) code(() => library.saveCase({ id, document: writeCase(c), blobs: [unused] }), 'LIBRARY_INPUT', 400);
  code(() => library.saveCase({ id: 99, document: writeCase(c), blobs: [unused] }), 'LIBRARY_REFERENCE', 404);
  assert.deepEqual(snapshot(db), before);
}));

for (const operation of ['INSERT', 'UPDATE']) test('이번 건: ' + operation + ' 중 저장 실패는 진행본과 새 덩어리 전체 취소', () => memory((db, library) => {
  const f = setup(library), c = caseFor(f), first = library.saveCase({ document: writeCase(c) });
  const before = snapshot(db), changed = { ...c, valueEdits: { [f.k.valueId('사업명')]: '취소할 합성 정정' } };
  db.exec(`CREATE TRIGGER injected_case_failure AFTER ${operation} ON studio_case BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CASE_WRITE_FAILURE'); END;`);
  assert.throws(() => library.saveCase({ ...(operation === 'UPDATE' ? { id: first.id } : {}), document: writeCase(changed), blobs: [base64(encode('합성 취소 덩어리 ' + operation))] }), /SYNTHETIC_CASE_WRITE_FAILURE/);
  assert.deepEqual(snapshot(db), before); assert.deepEqual(library.case(first.id).case, c);
  db.exec('DROP TRIGGER injected_case_failure');
  assert.doesNotThrow(() => library.saveCase({ id: first.id, document: writeCase(changed) }));
}));

test('이번 건: 다른 데이터 판·행·템플릿으로 적용은 거부하고 새 템플릿 내용은 재확인 후에만 생성', () => memory((db, library) => {
  const rows = [recordFor(name => '합성 값 ' + name, { price: 120000000, sme: 'Y' }), recordFor(name => '두 번째 합성 값 ' + name, { price: 80000000 })];
  const f = setup(library, JSON.stringify(rows)), c = caseFor(f, rows[0]), saved = library.saveCase({ document: writeCase(c) });
  const data2 = library.saveDataset({ id: f.data.id, version: 1, content: JSON.stringify(rows), name: '합성 데이터 새 판' });
  const other = { ...f.t, id: 't00000002' }; library.save({ template: writeStudioTemplate(other) });
  code(() => library.preview(f.t.id, 1, f.data.id, 1, 1, saved.id), 'LIBRARY_INPUT', 400);
  code(() => library.generate(f.t.id, 1, f.data.id, data2.version, 0, saved.id), 'LIBRARY_INPUT', 400);
  code(() => library.preview(other.id, 1, f.data.id, 1, 0, saved.id), 'TPL_REF');
  const next = structuredClone(f.t); next.version = 2;
  const b = next.blocks.find(b => b.id === 'b4')!; delete b.proto; b.content = { text: '새 판 합성 계약 {{기관명}}' };
  library.save({ template: writeStudioTemplate(next) });
  const before = snapshot(db), preview = library.preview(f.t.id, 2, f.data.id, 1, 0, saved.id);
  assert.equal(preview.slots.find(s => s.slot === 's2')?.state, 'recheck');
  assert.equal(preview.slots.find(s => s.slot === 's2')?.reason, 'contentChanged');
  const result = library.generate(f.t.id, 2, f.data.id, 1, 0, saved.id);
  assert.equal(result.ok, false); assert.ok(!('output' in result));
  assert.deepEqual(result.report.issues.filter(i => i.severity === 'error').map(i => i.code), ['SEL_RECHECK']);
  assert.deepEqual(snapshot(db), before); assert.deepEqual(library.case(saved.id).case, c);
  assert.equal(library.preview(f.t.id, 1, f.data.id, 1, 0, saved.id).slots.find(s => s.slot === 's2')?.state, 'manual');
  const base = baseSnapshot(db);
  const confirmed: StudioCase = { ...c, template: { id: next.id, version: 2, sha256: templateSha256(next) }, selections: { ...c.selections, s2: { ...manual(next, 's2', 'b4'), basis: 'confirmed' } } };
  const newCase = library.saveCase({ document: writeCase(confirmed) });
  assert.notEqual(newCase.id, saved.id);
  output(library.generate(f.t.id, 2, f.data.id, 1, 0, newCase.id));
  assert.equal(library.case(newCase.id).revision, 1); assert.deepEqual(library.case(saved.id).case, c);
  assert.deepEqual(baseSnapshot(db), base);
}));

test('이번 건: 기존 ID의 템플릿 판·데이터 판·행 고정, 참조를 바꾸려면 새 ID로 저장', () => memory((db, library) => {
  const row = recordFor(name => '합성 값 ' + name, { price: 120000000, sme: 'Y' });
  const row2 = recordFor(name => '다른 합성 값 ' + name, { price: 80000000 });
  const f = setup(library, JSON.stringify([row, row2])), c = caseFor(f, row), first = library.saveCase({ document: writeCase(c) });
  const t2 = { ...f.t, version: 2 }; library.save({ template: writeStudioTemplate(t2) });
  const otherTemplate = { ...f.t, id: 't00000002' }; library.save({ template: writeStudioTemplate(otherTemplate) });
  const data2 = library.saveDataset({ id: f.data.id, version: 1, content: JSON.stringify([row, row2]), name: '합성 데이터 다음 판' });
  const otherData = library.saveDataset({ content: JSON.stringify([row, row2]), name: '합성 다른 데이터' });
  const variants: StudioCase[] = [
    { ...c, template: { ...c.template, version: 2, sha256: templateSha256(t2) } },
    { ...c, template: { id: otherTemplate.id, version: 1, sha256: templateSha256(otherTemplate) } },
    { ...c, record: { ...c.record, version: data2.version } },
    { ...c, record: { ...c.record, dataset: otherData.id } },
    { ...c, record: { ...c.record, row: 1, sha256: rowSha(row2) } },
  ];
  for (const changed of variants) {
    const before = snapshot(db);
    code(() => library.saveCase({ id: first.id, document: writeCase(changed), blobs: [base64(encode('합성 고정 참조 취소 덩어리'))] }), 'LIBRARY_CASE_RECORD', 409);
    assert.deepEqual(snapshot(db), before); assert.deepEqual(library.case(first.id).case, c);
    const separate = library.saveCase({ document: writeCase(changed) });
    assert.notEqual(separate.id, first.id); assert.equal(separate.revision, 1);
    assert.deepEqual(library.case(separate.id).case, changed);
  }
}));

test('이번 건: 저장 캐시의 문서/해시 변조와 정정 조각 바이트 변조를 거부', () => {
  memory((db, library) => {
    const f = setup(library), c = caseFor(f), saved = library.saveCase({ document: writeCase(c) });
    db.prepare('UPDATE studio_case SET document=? WHERE id=?').run(writeCase({ ...c, valueEdits: {} }), saved.id);
    code(() => library.case(saved.id), 'LIBRARY_INPUT', 400);
    code(() => library.generate(f.t.id, 1, f.data.id, 1, 0, saved.id), 'LIBRARY_INPUT', 400);
  });
  memory((db, library) => {
    const f = setup(library), fragment = [...f.k.blobs.keys()][0]!, c = { ...caseFor(f), blockEdits: { b7: { fragment } } };
    const saved = library.saveCase({ document: writeCase(c) });
    db.prepare('UPDATE studio_blob SET bytes=? WHERE sha=?').run(Buffer.from('합성 변조 바이트'), fragment);
    code(() => library.case(saved.id), 'LIBRARY_INPUT', 400);
    code(() => library.preview(f.t.id, 1, f.data.id, 1, 0, saved.id), 'LIBRARY_INPUT', 400);
  });
  memory((db, library) => {
    const f = setup(library), saved = library.saveCase({ document: writeCase(caseFor(f)) });
    const changed = JSON.stringify([{ ...f.row, syntheticChanged: true }]);
    db.prepare('UPDATE studio_dataset SET document=?,sha=? WHERE id=?').run(changed, sha(encode(changed)), f.data.id);
    code(() => library.case(saved.id), 'LIBRARY_INPUT', 400);
    code(() => library.generate(f.t.id, 1, f.data.id, 1, 0, saved.id), 'LIBRARY_INPUT', 400);
  });
});

test('이번 건: 새 원시 조각을 정정 덩어리로 저장하고 원본·원형·템플릿을 바꾸지 않음', () => memory((db, library) => {
  const f = setup(library), before = baseSnapshot(db);
  const fragment = encode(serializeFragment(extractFragment(f.k.doc, { sectionIndex: 0, parentPath: [], from: 45, to: 45 })));
  const fragmentSha = sha(fragment); code(() => library.blob(fragmentSha), 'LIBRARY_REFERENCE', 404);
  const c = { ...caseFor(f), blockEdits: { b7: { fragment: fragmentSha } } };
  const saved = library.saveCase({ document: writeCase(c), blobs: [base64(fragment)] });
  assert.deepEqual(library.case(saved.id).case, c); assert.deepEqual(library.blob(fragmentSha), fragment);
  const { studio_blob: _newBlobs, ...after } = baseSnapshot(db), { studio_blob: _oldBlobs, ...original } = before;
  assert.deepEqual(after, original); assert.deepEqual(library.source(f.t.id, 1), f.k.bytes);
  const result = library.generate(f.t.id, 1, f.data.id, 1, 0, saved.id); output(result);
  assert.deepEqual(result.report.validation?.newErrors, []); assert.deepEqual(library.blob(fragmentSha), fragment);
}));

test('생성 기록: 진행본의 후속 정정과 SQLite 재시작에도 생성 당시 판·이번 건·바이트·원장 보존', () => {
  const directory = mkdtempSync(join(resolve(tmpdir()), 'hwpx-library-generation-'));
  let db: DatabaseSync | undefined;
  try {
    const file = join(directory, 'synthetic.sqlite'); db = new DatabaseSync(file);
    let library = createLibrary(db); const f = setup(library), c = caseFor(f), base = baseSnapshot(db);
    const stored = library.saveCase({ document: writeCase(c) });
    const first = library.generate(f.t.id, 1, f.data.id, 1, 0, stored.id), firstId = generationId(first), firstBytes = output(first);
    const snapshot = library.generation(firstId);
    assert.equal(snapshot.template, f.t.id); assert.equal(snapshot.templateVersion, 1); assert.equal(snapshot.templateSha, templateSha256(f.t));
    assert.equal(snapshot.dataset, f.data.id); assert.equal(snapshot.dataVersion, 1); assert.equal(snapshot.row, 0); assert.equal(snapshot.recordSha, rowSha(f.row));
    assert.equal(snapshot.caseId, stored.id); assert.equal(snapshot.caseRevision, 1); assert.equal(snapshot.caseDocument, writeCase(c)); assert.equal(snapshot.caseSha, caseSha256(c));
    assert.equal(snapshot.kind, 'hwpx'); assert.equal(snapshot.outputSha, sha(firstBytes)); assert.deepEqual(snapshot.output, firstBytes);
    assert.ok(first.ok && !first.dryRun); assert.deepEqual(snapshot.ledger, first.ledger); assert.deepEqual(snapshot.report, first.report);
    const changed = { ...c, valueEdits: { [f.k.valueId('사업명')]: '두 번째 진행본의 합성 정정 값' } };
    library.saveCase({ id: stored.id, document: writeCase(changed) });
    const second = library.generate(f.t.id, 1, f.data.id, 1, 0, stored.id), secondId = generationId(second), secondSnapshot = library.generation(secondId);
    assert.notEqual(secondId, firstId); assert.notDeepEqual(output(second), firstBytes);
    assert.equal(secondSnapshot.caseRevision, 2); assert.equal(secondSnapshot.caseDocument, writeCase(changed));
    assert.deepEqual(library.generation(firstId), snapshot); assert.equal(library.generations().length, 2);
    assert.deepEqual(baseSnapshot(db), base);
    db.close(); db = undefined; db = new DatabaseSync(file); library = createLibrary(db);
    assert.deepEqual(library.generation(firstId), snapshot); assert.deepEqual(library.generation(secondId), secondSnapshot);
    assert.equal(library.case(stored.id).revision, 2); assert.equal(library.case(stored.id).document, writeCase(changed));
    assert.deepEqual(library.generations().map(x => Number(x.id)), [secondId, firstId]);
    assert.deepEqual(baseSnapshot(db), base);
  } finally {
    db?.close(); assert.equal(dirname(directory), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true });
  }
});

test('생성 기록: Markdown 출력도 UTF-8 바이트와 판을 보존하며 이번 건·엔진 원장 없음은 null', () => memory((db, library) => {
  const source = encode('합성 문서 {{zero}} / {{flag}}');
  const t: StudioTemplate = {
    schema: 'hwpx-studio/template@2', id: 't00000031', version: 1, source: { kind: 'md', sha256: sha(source) }, anchors: [],
    values: [{ id: 'v1', name: '숫자', format: 'text' }, { id: 'v2', name: '불리언', format: 'text' }],
    bindings: [{ value: 'v1', key: 'zero' }, { value: 'v2', key: 'flag' }],
    places: [{ id: 'p1', kind: 'placeholder', key: 'zero', value: 'v1' }, { id: 'p2', kind: 'placeholder', key: 'flag', value: 'v2' }],
    slots: [], blocks: [], options: { missing: 'error', unregistered: 'error' },
  };
  library.save({ template: writeStudioTemplate(t), blobs: [base64(source)] });
  const row = { zero: 0, flag: false }, data = library.saveDataset({ content: JSON.stringify([row]), name: '합성 Markdown 데이터' });
  const before = baseSnapshot(db), result = library.generate(t.id, 1, data.id, 1, 0), id = generationId(result);
  assert.ok(result.ok && !result.dryRun); assert.equal(result.output, '합성 문서 0 / false');
  const saved = library.generation(id);
  assert.equal(saved.kind, 'md'); assert.equal(saved.caseId, null); assert.equal(saved.caseRevision, null);
  assert.equal(saved.caseDocument, null); assert.equal(saved.caseSha, null); assert.equal(saved.ledger, null);
  assert.equal(saved.templateSha, templateSha256(t)); assert.equal(saved.recordSha, rowSha(row));
  assert.deepEqual(saved.output, encode(result.output)); assert.equal(saved.outputSha, sha(encode(result.output)));
  assert.deepEqual(saved.report, result.report); assert.deepEqual(baseSnapshot(db), before);
}));

test('생성 기록: 선택 미확정·데이터 불일치·저장 중 실패에는 추가 기록과 부분 출력 행 없음', () => memory((db, library) => {
  const f = setup(library), c = caseFor(f), stored = library.saveCase({ document: writeCase(c) }), before = snapshot(db);
  const failed = library.generate(f.t.id, 1, f.data.id, 1, 0);
  assert.equal(failed.ok, false); assert.ok(!('output' in failed)); assert.ok(!('generationId' in failed));
  assert.deepEqual(failed.report.issues.filter(i => i.severity === 'error').map(i => i.code), ['SEL_UNDECIDED']);
  assert.equal(library.generations().length, 0);
  code(() => library.generate(f.t.id, 1, f.data.id, 1, 1, stored.id), 'LIBRARY_INPUT', 400);
  assert.equal(library.generations().length, 0); assert.deepEqual(snapshot(db), before);
  db.exec("CREATE TRIGGER injected_generation_failure AFTER INSERT ON studio_generation BEGIN SELECT RAISE(ABORT,'SYNTHETIC_GENERATION_WRITE_FAILURE'); END;");
  assert.throws(() => library.generate(f.t.id, 1, f.data.id, 1, 0, stored.id), /SYNTHETIC_GENERATION_WRITE_FAILURE/);
  assert.equal(library.generations().length, 0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM studio_generation').get()!.n, 0);
  assert.deepEqual(snapshot(db), before); db.exec('DROP TRIGGER injected_generation_failure');
  generationId(library.generate(f.t.id, 1, f.data.id, 1, 0, stored.id)); assert.equal(library.generations().length, 1);
}));

test('생성 기록: 생성 문서와 출력 바이트 해시 변조는 조회 거부', () => {
  memory((db, library) => {
    const f = setup(library), stored = library.saveCase({ document: writeCase(caseFor(f)) });
    const id = generationId(library.generate(f.t.id, 1, f.data.id, 1, 0, stored.id));
    db.prepare('UPDATE studio_generation SET document=? WHERE id=?').run('{}', id);
    code(() => library.generation(id), 'LIBRARY_INPUT', 400);
  });
  memory((db, library) => {
    const f = setup(library), stored = library.saveCase({ document: writeCase(caseFor(f)) });
    const id = generationId(library.generate(f.t.id, 1, f.data.id, 1, 0, stored.id));
    db.prepare('UPDATE studio_generation SET output=? WHERE id=?').run(Buffer.from('합성 변조 출력'), id);
    code(() => library.generation(id), 'LIBRARY_INPUT', 400);
    code(() => library.generation(99), 'LIBRARY_REFERENCE', 404);
    code(() => library.generation(0), 'LIBRARY_INPUT', 400);
  });
});

test('이번 건: 분산된 수십 자리와 긴 값 50회 저장·복원 생성의 결정성·새 오류 0·원본 불변', () => memory((db, library) => {
  const next = rng(250031), rows = Array.from({ length: 50 }, () => recordFor(() => longValue(next, 350, 950), { price: 120000000, sme: 'Y' }));
  const f = setup(library, JSON.stringify(rows)), base = baseSnapshot(db), original = Buffer.from(f.k.bytes), before = validateDocument(original);
  assert.ok(f.t.values.length >= 30 && f.t.places.length >= 40);
  let checks = 0;
  for (let index = 0; index < rows.length; index++) {
    const c = caseFor(f, rows[index]!, index); c.valueEdits = { [f.k.valueId('사업명')]: longValue(next, 350, 950) };
    const saved = library.saveCase({ document: writeCase(c) }); assert.deepEqual(library.case(saved.id).case, c);
    const a = library.generate(f.t.id, 1, f.data.id, 1, index, saved.id), b = library.generate(f.t.id, 1, f.data.id, 1, index, saved.id);
    assert.deepEqual(output(a), output(b)); assert.deepEqual(a.report, b.report);
    assert.ok(a.ok && !a.dryRun && b.ok && !b.dryRun); assert.deepEqual(a.ledger, b.ledger);
    for (const result of [a, b]) {
      assert.ok(result.ledger !== undefined);
      assert.ok(result.ledger.actions.filter(action => action.type === 'fill').reduce((count, action) => count + action.targets, 0) >= 60);
      assert.equal(result.ledger.counts.skipped, 0);
      assert.deepEqual(result.report.validation?.newErrors, []);
      assert.deepEqual(newErrorsAfter(before, validateDocument(output(result))), []);
      assert.equal(result.ledger?.record.sha256, rowSha(rows[index]!));
      const savedOutput = library.generation(generationId(result));
      assert.equal(savedOutput.caseDocument, writeCase(c)); assert.deepEqual(savedOutput.output, output(result));
      checks++;
    }
  }
  assert.equal(checks, 100); assert.equal(library.cases().length, 50); assert.equal(library.generations().length, 100);
  assert.deepEqual(baseSnapshot(db), base); assert.deepEqual(Buffer.from(f.k.bytes), original);
}));
