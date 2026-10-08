// 값 타입 7종(엔진 명세 8.8.4, #131)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글·값은 기록하지 않는다: 진단에는 경로 해시 앞 10자와 수량만 남긴다.
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/value-types-corpus.test.ts
// 문서마다 금액(천 단위 쉼표 수 뒤 "원")·백분율(수 뒤 "%")·날짜(YYYY. M. D.) 자리를 낱말 자리로, 그 밖의 한글 낱말 몇 곳을 text·number·datetime·boolean 자리로,
// 메일머지 필드는 키마다 값 하나(바로 뒤가 "원"이면 금액)로 잇는다. 같은 값을 여러 자리가 쓴다.
// 무작위 50회: 7종 원래 값을 섞어 2단계 생성 → 성공·결정성·검사기 새 오류 0, 자리마다 기대 글(단위 뒤 자리는 숫자만), 원·% 중복이 늘지 않음.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCorpusFile, sameSnapshot, scanCorpus, snapshotOf } from "../../../tools/stress/corpus.ts";
import { listFields, openPackage, parseDocument, validateDocument, walkParagraphs, type HwpxDocument, type ParagraphNode } from "../src/index.ts";
import { collectFields } from "../src/fill/fields.ts";
import { generateFromTemplate, makeWordAnchor, type StudioGenerateResult } from "../src/fill/index.ts";
import { bindValues, readStudioTemplate, sha256Hex, type StudioTemplate, type ValueFormat } from "../src/template/index.ts";
import { bytesEqual, newErrorsAfter } from "./helpers.ts";
import { rng } from "./range-helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;
const ROUNDS = 50;

const MONEY = /(?<![0-9,.])[0-9]{1,3}(?:,[0-9]{3})+(?=[ \t]*원)/g;
const PERCENT = /(?<![0-9.,])[0-9]+(?:\.[0-9]+)?(?=[ \t]*%)/g;
const DATE = /(?<![0-9])20[0-9]{2}\. ?[0-9]{1,2}\. ?[0-9]{1,2}\./g;
const WORD = /[가-힣]{2,6}/g;
const OTHER: ValueFormat[] = ["text", "number", "datetime", "boolean"];

const RAW: Record<Exclude<ValueFormat, "text">, unknown[]> = {
  money: [1234000, "1,234,000", "금 1,234,000원정", "₩5,000", "-₩5,000", "△300", "1234.50", "99999999999999999999", "0", "", " 7원 "],
  percent: [12.5, "87.745%", "-3", "100 %", "0.0", ""],
  number: ["1,234", 7, "0.50", "-12", "123456789012345678901234567890"],
  date: ["20261009", "2026-10-09", "2026/1/5", "2026. 10. 9.", "2024-02-29", ""],
  datetime: ["2026-10-09 14:30", "2026-10-09T09:05:07", "20261009 9:05", "2026. 10. 09. 23:59"],
  boolean: [true, false, "Y", "n", "예", "아니오"],
};
const TEXTS = ["007", "02-0000-0000", "가나다 & <참고> \"인용\"", "첫 줄\n둘째 줄\t탭", ""];

type Spot = { section: number; paragraph: ParagraphNode; start: number; end: number; value: string; format: ValueFormat };
type Kit = { id: string; bytes: Uint8Array; t: StudioTemplate; spots: Spot[]; fieldValues: string[]; formats: Map<string, ValueFormat> };

/** 구간이 글자 조각 하나(같은 run) 안에 있어야 섞인 글자모양 건너뜀이 없다 */
function inOnePiece(p: ParagraphNode, start: number, end: number): boolean {
  const pieces = p.pieces.filter((x) => x.logicalEnd > start && x.logicalStart < end);
  return pieces.length > 0 && pieces.every((x) => x.kind === "text" && x.runOrdinal === pieces[0]?.runOrdinal);
}

function kitOf(id: string, bytes: Uint8Array, doc: HwpxDocument, next: () => number): Kit | undefined {
  const spots: Spot[] = [];
  const formats = new Map<string, ValueFormat>();
  const use = (value: string, format: ValueFormat): string => {
    formats.set(value, format);
    return value;
  };
  let others = 0;
  for (const s of doc.sections) {
    for (const p of walkParagraphs(s.paragraphs)) {
      if (p.fieldMarks.length > 0) continue;
      const own: Spot[] = [];
      const add = (re: RegExp, value: (k: number) => string, format: ValueFormat): void => {
        let k = 0;
        for (const m of p.logicalText.matchAll(re)) {
          const start = m.index;
          const end = start + m[0].length;
          if (!inOnePiece(p, start, end) || own.some((o) => start < o.end && end > o.start)) continue;
          own.push({ section: s.index, paragraph: p, start, end, value: use(value(k++), format), format });
        }
      };
      add(MONEY, (k) => `금액${k % 2}`, "money");
      add(PERCENT, () => "율", "percent");
      add(DATE, (k) => `날짜${k % 2}`, "date");
      if (own.length === 0 && others < 12 && next() < 0.3) {
        const m = [...p.logicalText.matchAll(WORD)][0];
        if (m !== undefined && inOnePiece(p, m.index, m.index + m[0].length)) {
          const format = OTHER[others % OTHER.length] as ValueFormat;
          own.push({ section: s.index, paragraph: p, start: m.index, end: m.index + m[0].length, value: use(`기타${format}`, format), format });
          others++;
        }
      }
      spots.push(...own);
    }
  }
  // 메일머지: 키마다 값 하나. 바로 뒤가 "원"인 필드가 있는 키는 금액, 나머지는 7종을 돌려 쓴다
  const fields = collectFields(doc).filter((f) => f.info.type === "MAILMERGE" && f.info.mergeKey !== undefined);
  const keys = [...new Set(fields.map((f) => f.info.mergeKey as string))];
  const after = (f: (typeof fields)[number]): string => {
    const piece = f.end === null ? undefined : f.endParagraph?.pieces[f.end.pieceIndex];
    return piece === undefined || f.endParagraph === null ? "" : f.endParagraph.logicalText.slice(piece.logicalEnd);
  };
  const all: ValueFormat[] = ["text", "number", "money", "percent", "date", "datetime", "boolean"];
  const fieldValues = keys.map((key, i) => use(`필드${i}`, fields.some((f) => f.info.mergeKey === key && /^[ \t]*원/.test(after(f))) ? "money" : (all[i % all.length] as ValueFormat)));
  if (spots.length + keys.length < 10) return undefined;
  const anchors = spots.map((sp, i) => {
    const a = makeWordAnchor(doc, `a${i + 1}`, sp.section, sp.paragraph.path, sp.start, sp.end);
    assert.ok(a !== undefined);
    return a;
  });
  const names = [...formats.keys()];
  const vid = new Map(names.map((n, i) => [n, `v${i + 1}`]));
  const raw = {
    schema: "hwpx-studio/template@2", id: "t00000133", version: 1, source: { kind: "hwpx", sha256: sha256Hex(bytes) }, anchors,
    values: names.map((name) => ({ id: vid.get(name), name, format: formats.get(name), ...(formats.get(name) === "money" ? { display: { unit: "원" } } : {}) })),
    bindings: names.map((name) => ({ value: vid.get(name), key: name })),
    places: [
      ...spots.map((sp, i) => ({ id: `p${i + 1}`, kind: "word", anchor: `a${i + 1}`, value: vid.get(sp.value) })),
      ...keys.map((key, i) => ({ id: `q${i + 1}`, kind: "mailMerge", key, value: vid.get(fieldValues[i] as string) })),
    ],
    slots: [], blocks: [], options: { missing: "error", unregistered: "error" },
  };
  const t = readStudioTemplate(JSON.stringify(raw));
  assert.ok(t.schema === "hwpx-studio/template@2");
  return { id, bytes, t, spots, fieldValues, formats };
}

const UNIT = /^[ \t 　]*(원|%)/;
function expected(text: string, format: ValueFormat, after: string): { text: string; dropped: boolean } {
  const unit = format === "money" ? "원" : format === "percent" ? "%" : undefined;
  const m = UNIT.exec(after);
  return unit !== undefined && text.endsWith(unit) && m?.[1] === unit ? { text: text.slice(0, -1), dropped: true } : { text, dropped: false };
}
const dupCount = (doc: HwpxDocument): number =>
  doc.sections.reduce((n, s) => n + [...walkParagraphs(s.paragraphs)].reduce((k, p) => k + [...p.logicalText.matchAll(/원[ \t]*원|%[ \t]*%/g)].length, 0), 0);
const pathKey = (section: number, path: readonly number[]): string => `${section}:${path.join(",")}`;

test("#131 실제 공고서: 금액·백분율·날짜·낱말·메일머지 자리에 7종 값 무작위 50회 → 성공·결정성·검사기 새 오류 0·단위 뒤 자리 숫자만·중복 0", { skip: SKIP }, (ctx) => {
  assert.ok(typeof DIR === "string");
  const before = snapshotOf(scanCorpus(DIR));
  const next = rng(1310);
  const kits: Kit[] = [];
  for (const f of scanCorpus(DIR).filter((x) => x.size <= MAX_BYTES)) {
    const bytes = readCorpusFile(f);
    let doc: HwpxDocument;
    try {
      doc = parseDocument(openPackage(bytes));
    } catch {
      continue;
    }
    const kit = kitOf(f.id, bytes, doc, next);
    if (kit !== undefined) kits.push(kit);
  }
  assert.ok(kits.length >= 10, `문서 ${kits.length}건`);
  const tally = { rounds: 0, places: 0, wordPlaces: 0, fieldPlaces: 0, dropped: 0, kept: 0, fieldDropped: 0, newErrors: 0, dupBefore: 0, dupAfter: 0 };
  const perDoc = new Map<string, number>();
  for (let round = 0; round < ROUNDS; round++) {
    const kit = kits[round % kits.length] as Kit;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    const row: Record<string, unknown> = {};
    for (const v of kit.t.values) row[v.name] = v.format === "text" ? pick(TEXTS) : pick(RAW[v.format]);
    const run = (): Extract<StudioGenerateResult, { ok: true; dryRun: false }> => {
      const r = generateFromTemplate(kit.bytes, kit.t, row, undefined, () => undefined);
      assert.ok(r.ok && !r.dryRun, `${kit.id} ${round}회: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code))}`);
      return r;
    };
    const r = run();
    const again = run();
    assert.ok(r.output instanceof Uint8Array && again.output instanceof Uint8Array);
    assert.ok(bytesEqual(r.output, again.output) && JSON.stringify(r.ledger) === JSON.stringify(again.ledger), `${kit.id} ${round}회: 결정성`);
    const newErrors = newErrorsAfter(validateDocument(kit.bytes), validateDocument(r.output));
    tally.newErrors += newErrors.length;
    assert.deepEqual(newErrors.map((v) => v.code), [], `${kit.id} ${round}회: 새 오류`);
    const src = parseDocument(openPackage(kit.bytes));
    const dst = parseDocument(openPackage(r.output));
    tally.dupBefore += dupCount(src);
    tally.dupAfter += dupCount(dst);
    assert.equal(dupCount(dst), dupCount(src), `${kit.id} ${round}회: 원·% 중복이 늘었다`);
    // 낱말 자리: 문단마다 원본 글의 구간을 기대 글로 바꾼 것과 같다
    const texts = new Map(bindValues(kit.t, row, undefined).map((v) => [v.name, v.text ?? ""]));
    const dstParagraphs = new Map(dst.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)].map((p) => [pathKey(s.index, p.path), p] as const)));
    const byParagraph = new Map<ParagraphNode, Spot[]>();
    for (const sp of kit.spots) byParagraph.set(sp.paragraph, [...(byParagraph.get(sp.paragraph) ?? []), sp]);
    for (const [p, list] of byParagraph) {
      // 같은 원본 문단 객체를 다시 읽은 문서에서 찾는다(주소가 같다)
      const section = list[0]?.section ?? 0;
      const srcText = p.logicalText;
      let want = "";
      let at = 0;
      for (const sp of [...list].sort((a, b) => a.start - b.start)) {
        const e = expected(texts.get(sp.value) ?? "?", sp.format, srcText.slice(sp.end));
        want += srcText.slice(at, sp.start) + e.text;
        at = sp.end;
        tally.wordPlaces++;
        if (e.dropped) tally.dropped++;
        else if (sp.format === "money" || sp.format === "percent") tally.kept++;
      }
      want += srcText.slice(at);
      assert.equal(dstParagraphs.get(pathKey(section, p.path))?.logicalText, want, `${kit.id} ${round}회: 문단`);
    }
    // 메일머지 필드: 키의 값 글(바로 뒤가 단위면 숫자만)
    const srcFields = collectFields(src).filter((f) => f.info.type === "MAILMERGE" && f.info.mergeKey !== undefined);
    const keys = [...new Set(srcFields.map((f) => f.info.mergeKey as string))];
    const dstFields = listFields(dst).filter((f) => f.type === "MAILMERGE" && f.mergeKey !== undefined);
    assert.equal(dstFields.length, srcFields.length);
    srcFields.forEach((f, k) => {
      const value = kit.fieldValues[keys.indexOf(f.info.mergeKey as string)] as string;
      const piece = f.end === null ? undefined : f.endParagraph?.pieces[f.end.pieceIndex];
      const after = piece === undefined || f.endParagraph === null ? "" : f.endParagraph.logicalText.slice(piece.logicalEnd);
      const e = expected(texts.get(value) ?? "?", kit.formats.get(value) ?? "text", after);
      assert.equal(dstFields[k]?.valueText, e.text, `${kit.id} ${round}회: 메일머지 ${k}`);
      tally.fieldPlaces++;
      if (e.dropped) tally.fieldDropped++;
    });
    tally.rounds++;
    perDoc.set(kit.id, (perDoc.get(kit.id) ?? 0) + 1);
  }
  tally.places = tally.wordPlaces + tally.fieldPlaces;
  const after = snapshotOf(scanCorpus(DIR));
  for (const kit of kits) ctx.diagnostic(`${kit.id} 낱말 자리 ${kit.spots.length}(금액 ${kit.spots.filter((s) => s.format === "money").length}·백분율 ${kit.spots.filter((s) => s.format === "percent").length}·날짜 ${kit.spots.filter((s) => s.format === "date").length}) 메일머지 키 ${kit.fieldValues.length} 값 ${kit.t.values.length} 시행 ${perDoc.get(kit.id) ?? 0}`);
  ctx.diagnostic(`문서 ${kits.length}건, ${JSON.stringify(tally)}, 문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
  assert.ok(tally.dropped > 0 && tally.fieldDropped > 0, JSON.stringify(tally));
});
