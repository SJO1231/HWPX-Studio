// #133 `/api/g2b` 2판 창구의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
//   HWPX_CORPUS_DIR=<폴더> node --test apps/studio-lite/test/g2b-v2-corpus.test.ts
// 문서마다 금액·백분율·날짜 글을 낱말 자리로, 한글 낱말 몇 곳을 text·number·datetime·boolean 자리로, 메일머지 키마다 값 하나를 이어 template@2를 만들고
// 창구에 서식·프로필(출력은 OS 임시 폴더)을 저장한 뒤 생성 요청 50건(건마다 같은 항목 두 번)을 보낸다 → 성공·같은 바이트(재사용)·검사기 새 오류 0·최상위 경고 0.
// 문서 이름·글·값은 기록하지 않는다: 진단에는 경로 해시 앞 10자와 수량만 남긴다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { compareToBaseline, makeWordAnchor, openPackage, parseDocument, readStudioTemplate, sha256Hex, validateDocument, walkParagraphs, type HwpxDocument, type ParagraphNode, type StudioTemplate, type ValueFormat } from '@hwpx-studio/engine';
import { collectFields } from '../../../packages/hwpx-engine/src/fill/fields.ts';
import { readCorpusFile, sameSnapshot, scanCorpus, snapshotOf } from '../../../tools/stress/corpus.ts';
import { longValue, rng } from '../../../packages/hwpx-engine/test/range-helpers.ts';
import { createG2B2 } from '../src/g2b-v2.ts';

const DIR = process.env['HWPX_CORPUS_DIR'];
const SKIP = DIR === undefined || DIR === '' ? 'HWPX_CORPUS_DIR이 없어 건너뜀(미검증)' : false;
const ROUNDS = 50;
const MONEY = /(?<![0-9,.])[0-9]{1,3}(?:,[0-9]{3})+(?=[ \t]*원)/g;
const PERCENT = /(?<![0-9.,])[0-9]+(?:\.[0-9]+)?(?=[ \t]*%)/g;
const DATE = /(?<![0-9])20[0-9]{2}\. ?[0-9]{1,2}\. ?[0-9]{1,2}\./g;
const WORD = /[가-힣]{2,6}/g;
const OTHER: ValueFormat[] = ['text', 'number', 'datetime', 'boolean'];
const RAW: Record<Exclude<ValueFormat, 'text'>, unknown[]> = {
  money: [1234000, '1,234,000', '금 1,234,000원정', '₩5,000', '△300', '1234.50', '99999999999999999999', '0'],
  percent: [12.5, '87.745%', '-3', '100 %'],
  number: ['1,234', 7, '0.50', '-12'],
  date: ['20261009', '2026-10-09', '2026/1/5', '2026. 10. 9.', '2024-02-29'],
  datetime: ['2026-10-09 14:30', '2026-10-09T09:05:07', '20261009 9:05'],
  boolean: [true, false, 'Y', 'n', '예', '아니오'],
};

const inOnePiece = (p: ParagraphNode, start: number, end: number) => {
  const pieces = p.pieces.filter(x => x.logicalEnd > start && x.logicalStart < end);
  return pieces.length > 0 && pieces.every(x => x.kind === 'text' && x.runOrdinal === pieces[0]?.runOrdinal);
};

type Kit = { id: string; bytes: Uint8Array; t: StudioTemplate; words: number; fields: number };
function kitOf(id: string, n: number, bytes: Uint8Array, doc: HwpxDocument, next: () => number): Kit | undefined {
  const formats = new Map<string, ValueFormat>(), spots: { section: number; p: ParagraphNode; start: number; end: number; value: string }[] = [];
  let others = 0;
  for (const s of doc.sections) for (const p of walkParagraphs(s.paragraphs)) {
    if (p.fieldMarks.length > 0) continue;
    const own: typeof spots = [];
    const add = (re: RegExp, value: (k: number) => string, format: ValueFormat) => {
      let k = 0;
      for (const m of p.logicalText.matchAll(re)) {
        const start = m.index, end = start + m[0].length;
        if (!inOnePiece(p, start, end) || own.some(o => start < o.end && end > o.start)) continue;
        const name = value(k++); formats.set(name, format); own.push({ section: s.index, p, start, end, value: name });
      }
    };
    add(MONEY, k => `금액 ${k % 2}`, 'money'); add(PERCENT, () => '율(%)', 'percent'); add(DATE, k => `날짜.${k % 2}`, 'date');
    if (own.length === 0 && others < 12 && next() < 0.3) {
      const m = [...p.logicalText.matchAll(WORD)][0];
      if (m !== undefined && inOnePiece(p, m.index, m.index + m[0].length)) {
        const format = OTHER[others % OTHER.length]!, name = `기타 ${format}`;
        formats.set(name, format); own.push({ section: s.index, p, start: m.index, end: m.index + m[0].length, value: name }); others++;
      }
    }
    spots.push(...own);
  }
  const keys = [...new Set(collectFields(doc).flatMap(f => f.info.type === 'MAILMERGE' && f.info.mergeKey !== undefined ? [f.info.mergeKey] : []))];
  const fieldValue = keys.map((_, i) => { const name = `필드 ${i}`; formats.set(name, (['text', 'number', 'date', 'boolean'] as ValueFormat[])[i % 4]!); return name; });
  if (spots.length + keys.length < 10) return undefined;
  const names = [...formats.keys()], vid = new Map(names.map((x, i) => [x, `v${i + 1}`]));
  const raw = {
    schema: 'hwpx-studio/template@2', id: `t${String(n).padStart(8, '0')}`, version: 1, meta: { name: `실제 서식 ${n}` }, source: { kind: 'hwpx', sha256: sha256Hex(bytes) },
    anchors: spots.map((sp, i) => makeWordAnchor(doc, `a${i + 1}`, sp.section, sp.p.path, sp.start, sp.end)),
    values: names.map(x => ({ id: vid.get(x), name: x, format: formats.get(x) })),
    bindings: names.map(x => ({ value: vid.get(x), key: x })),
    places: [...spots.map((sp, i) => ({ id: `p${i + 1}`, kind: 'word', anchor: `a${i + 1}`, value: vid.get(sp.value) })), ...keys.map((key, i) => ({ id: `q${i + 1}`, kind: 'mailMerge', key, value: vid.get(fieldValue[i]!) }))],
    slots: [], blocks: [], options: { missing: 'error', unregistered: 'error' },
  };
  return { id, bytes, t: readStudioTemplate(JSON.stringify(raw)) as StudioTemplate, words: spots.length, fields: keys.length };
}

test('#133 실제 공고서: 문서마다 template@2 → 창구 생성 50건(건마다 두 번) → 성공·같은 바이트·검사기 새 오류 0·최상위 경고 0', { skip: SKIP }, async ctx => {
  assert.ok(typeof DIR === 'string');
  const before = snapshotOf(scanCorpus(DIR)), next = rng(1330);
  const kits: Kit[] = [];
  for (const f of scanCorpus(DIR).filter(x => x.size <= 5_000_000)) {
    const bytes = readCorpusFile(f);
    let doc: HwpxDocument;
    try { doc = parseDocument(openPackage(bytes)); } catch { continue; }
    const kit = kitOf(f.id, kits.length + 1, bytes, doc, next);
    if (kit !== undefined) kits.push(kit);
  }
  assert.ok(kits.length >= 10, `문서 ${kits.length}건`);
  const root = mkdtempSync(join(tmpdir(), 'studio-g2b2-corpus-')), db = new DatabaseSync(':memory:');
  const tally = { rounds: 0, generated: 0, reused: 0, newErrors: 0, topWarnings: 0, places: 0, totalMs: 0 };
  try {
    const g = createG2B2(db);
    for (const k of kits) {
      g.saveTemplate({ template: JSON.parse(JSON.stringify(k.t)), source: Buffer.from(k.bytes).toString('base64') });
      g.saveProfile({ id: k.t.id, label: k.t.meta!.name!, templateId: k.t.id, version: 1, outputDirectory: join(root, k.t.id) });
    }
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;
    for (let round = 0; round < ROUNDS; round++) {
      const k = kits[round % kits.length]!;
      const values: Record<string, unknown> = { 원천_기타: `원천 ${round}` };
      for (const v of k.t.values) values[v.name] = v.format === 'text' ? `${longValue(next, 100, 400)}\n둘째 줄 & <확인>\t탭` : pick(RAW[v.format]);
      const one = { values, meta: { identity: [`R${round}`] } };
      const reply = await g.generate({ format: 'studio-generate', version: 2, requestId: `corpus-${round}`, profileId: k.t.id, types: Object.fromEntries(k.t.values.map(v => [v.name, v.format])), items: [one, structuredClone(one)] });
      tally.topWarnings += reply.warnings.length; tally.totalMs += reply.summary.totalMs;
      assert.equal(reply.status, 'success', `${k.id} ${round}회: ${JSON.stringify(reply.results.map(r => r.code))}`);
      const [a, b] = reply.results;
      assert.equal(b!.reused, true, `${k.id} ${round}회: 같은 항목은 같은 바이트`); assert.equal(b!.path, a!.path);
      const out = new Uint8Array(readFileSync(a!.path!));
      const errors = compareToBaseline(validateDocument(k.bytes), validateDocument(out)).newErrors;
      tally.newErrors += errors.length;
      assert.deepEqual(errors.map(e => e.code), [], `${k.id} ${round}회: 새 오류`);
      tally.rounds++; tally.generated += 2; tally.reused++; tally.places += k.t.places.length;
    }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  const after = snapshotOf(scanCorpus(DIR));
  for (const k of kits) ctx.diagnostic(`${k.id} 낱말 자리 ${k.words} 메일머지 키 ${k.fields} 값 ${k.t.values.length}`);
  ctx.diagnostic(`문서 ${kits.length}건, ${JSON.stringify({ ...tally, totalMs: Math.round(tally.totalMs) })}, 문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(sameSnapshot(before, after), '읽기 전용: 문서 모음이 바뀌지 않았다');
  assert.equal(tally.topWarnings, 0); assert.equal(tally.newErrors, 0); assert.equal(tally.rounds, ROUNDS);
});
