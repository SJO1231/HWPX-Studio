// 값 타입 7종의 2단계 생성(엔진 명세 8.8.4·8.8.12, #131): 합성 문서의 자리 수십 개(본문·표 칸·머리말, 같은 키 중복, 메일머지 필드)에
// 7종 값을 섞어 넣고, 자리 바로 뒤에 "원"·"%"가 있으면 단위를 떼 중복이 없는지, 무작위 50회 결정성·게이트·검사기 새 오류 0을 센다. md도 같은 규칙.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listFields, validateDocument, walkParagraphs, type HwpxDocument, type ParagraphNode } from "../src/index.ts";
import { collectFields } from "../src/fill/fields.ts";
import { findLooseKeys } from "../src/fill/studio-common.ts";
import { generate, generateFromTemplate, type StudioGenerateResult } from "../src/fill/index.ts";
import { bindValues, readStudioTemplate, sha256Hex, type StudioTemplate, type ValueDisplay, type ValueFormat } from "../src/template/index.ts";
import { bytesEqual, mutateEntryText, newErrorsAfter, readFixture, reparse } from "./helpers.ts";
import { ds, insertText, KEEP, line, longValue, rng, tpl } from "./range-helpers.ts";

type Ok = Extract<StudioGenerateResult, { ok: true; dryRun: false }>;
function ok(r: StudioGenerateResult): Ok {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  assert.ok(!r.dryRun);
  return r as Ok;
}
const out = (r: Ok): Uint8Array => {
  assert.ok(r.output instanceof Uint8Array);
  return r.output;
};

// ── 합성 문서 ───────────────────────────────────────────────────

const BODY = [
  "1. 추정가격: 금 {{추정가격}}원정(부가세 포함)",
  "2. 추정가격 {{추정가격}}, 예정가격 {{예정가격}}",
  "3. 예정가격은 {{예정가격}} 원입니다.",
  "4. 보증금 {{보증금}}원, 수수료 {{수수료}}원",
  "5. 낙찰 하한율 {{하한율}}% 이상, {{하한율}} %, {{하한율}}",
  "6. 공고일 {{공고일}} / 시행일 {{시행일}} / 마감 {{마감일시}}",
  "7. 수량 {{수량}}개, 단가 {{단가}}원",
  "8. 중소기업 여부: {{중소기업}} / 재입찰: {{재입찰}}",
  "9. 담당 {{담당자}} 연락처 {{연락처}} 공고번호 {{ 공고 번호 }}",
  "10. 설명: {{설명}}",
  "11. 금 {{추정가격}}원 / {{하한율}}％ / {{공고일}} / {{예정가격}}　원",
];
const CELL = ["{{추정가격}}원", "{{하한율}}%", "{{공고일}}", "{{예정가격}}", "{{수량}}"];
const HEAD = ["머리말 공고일 {{공고일}} / 금액 {{추정가격}}원 / 율 {{하한율}}%"];

/**
 * `merge/merge-fields`(메일머지 필드·누름틀·`{{}}`·표 2개)에서 첫 `추정가격` 메일머지 필드 바로 뒤에 "원"을 넣고,
 * 본문 끝에 11문단, 첫 표 칸 [12, 1]에 5문단, 머리말 [0, 0]에 1문단을 더한다(자리는 본문·표 칸·머리말에 분산).
 */
let docCache: Uint8Array | undefined;
function typedDoc(): Uint8Array {
  if (docCache !== undefined) return docCache;
  const end = '<hp:fieldEnd beginIDRef="1211357368" fieldid="627928423"/></hp:ctrl></hp:run><hp:run charPrIDRef="7"><hp:t/></hp:run>';
  const base = mutateEntryText(readFixture("merge/merge-fields"), "Contents/section0.xml", (x) => x.replace(end, end.replace("<hp:t/>", "<hp:t>원</hp:t>")));
  const d0 = reparse(base);
  const r = generate(
    base,
    tpl(
      [line(d0, "end", [16]), line(d0, "cell", [12, 1, 0]), line(d0, "head", [0, 0, 0])],
      [insertText("body", "end", BODY.join("\n"), "after"), insertText("cellp", "cell", CELL.join("\n"), "after"), insertText("headp", "head", HEAD.join("\n"), "after")],
    ),
    ds({}),
    KEEP,
  );
  assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues));
  docCache = r.output;
  return docCache;
}

// ── 템플릿 ─────────────────────────────────────────────────────

type Def = { format: ValueFormat; display?: ValueDisplay };
const DEFS: Record<string, Def> = {
  "추정가격": { format: "money" },
  "예정가격": { format: "money", display: { negative: "△" } },
  "보증금": { format: "money", display: { unit: "" } },
  "수수료": { format: "money" },
  "부가세": { format: "money" },
  "단가": { format: "money", display: { grouping: false } },
  "하한율": { format: "percent" },
  "수량": { format: "number" },
  "공고일": { format: "date" },
  "시행일": { format: "date", display: { pattern: "YYYY년 M월 D일" } },
  "마감일시": { format: "datetime" },
  "중소기업": { format: "boolean", display: { yes: "해당", no: "해당 없음" } },
  "재입찰": { format: "boolean" },
  "재공고": { format: "boolean" },
  "project.start": { format: "date" },
  "project.end": { format: "date", display: { pattern: "M/D" } },
  "dates.start": { format: "datetime" },
  "dates.end": { format: "date" },
  "dates.days": { format: "number" },
};
const formatOf = (name: string): Def => DEFS[name] ?? { format: "text" };

function typedTemplate(bytes: Uint8Array): StudioTemplate {
  const doc = reparse(bytes);
  const keys = new Set<string>();
  for (const s of doc.sections) for (const p of walkParagraphs(s.paragraphs)) for (const h of findLooseKeys(p.logicalText)) keys.add(h.key);
  const mergeKeys = [...new Set(listFields(doc).flatMap((f) => (f.type === "MAILMERGE" && f.mergeKey !== undefined ? [f.mergeKey] : [])))];
  const names = [...new Set([...keys, ...mergeKeys])].sort();
  const id = new Map(names.map((n, i) => [n, `v${i + 1}`]));
  const values = names.map((name) => ({ id: id.get(name), name, ...formatOf(name) }));
  let n = 0;
  const places = [
    ...[...keys].sort().map((key) => ({ id: `p${++n}`, kind: "placeholder", key, value: id.get(key) })),
    ...mergeKeys.sort().map((key) => ({ id: `p${++n}`, kind: "mailMerge", key, value: id.get(key) })),
  ];
  const raw = {
    schema: "hwpx-studio/template@2", id: "t00000131", version: 1, meta: { name: "타입 7종(시험)" },
    source: { kind: "hwpx", sha256: sha256Hex(bytes) }, anchors: [],
    values, bindings: names.map((name) => ({ value: id.get(name), key: name })), places, slots: [], blocks: [],
    options: { missing: "error", unregistered: "error" },
  };
  const t = readStudioTemplate(JSON.stringify(raw));
  assert.ok(t.schema === "hwpx-studio/template@2");
  return t;
}

// ── 무작위 값 ───────────────────────────────────────────────────

const RAW: Record<Exclude<ValueFormat, "text">, unknown[]> = {
  money: [1234000, "1,234,000", "금 1,234,000원정", "₩5,000", "-₩5,000", "△300", "1234.50", "99999999999999999999", "0", "", " 7원 ", -1234],
  percent: [12.5, "87.745%", "-3", "100 %", "0.0", ""],
  number: ["1,234", 7, "0.50", "-12", "123456789012345678901234567890", ""],
  date: ["20261009", "2026-10-09", "2026/1/5", "2026. 10. 9.", "2024-02-29", ""],
  datetime: ["2026-10-09 14:30", "2026-10-09T09:05:07", "20261009 9:05", "2026. 10. 09. 23:59"],
  boolean: [true, false, "Y", "n", "예", "아니오", "TRUE"],
};
const TEXTS = ["007", "02-0000-0000", "0012-345", "가나다 & <참고> \"인용\"", ""];

function record(t: StudioTemplate, next: () => number): Record<string, unknown> {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const row: Record<string, unknown> = {};
  for (const v of t.values) row[v.name] = v.format === "text" ? (v.name === "설명" || next() < 0.3 ? longValue(next, 0, 1500) : pick(TEXTS)) : pick(RAW[v.format]);
  return row;
}

// ── 기대 글(독립 계산): 자리 바로 뒤가 단위면 뗀다 ────────────────────

const UNIT_AFTER: Partial<Record<ValueFormat, RegExp>> = { money: /^[ \t 　]*원/, percent: /^[ \t 　]*%/ };
function expectedAt(text: string, def: Def, after: string): { text: string; dropped: boolean } {
  const re = UNIT_AFTER[def.format];
  const unit = def.format === "money" ? (def.display?.unit ?? "원") : def.format === "percent" ? (def.display?.unit ?? "%") : "";
  if (re !== undefined && unit !== "" && text.endsWith(unit) && re.test(after)) return { text: text.slice(0, -unit.length), dropped: true };
  return { text, dropped: false };
}

const paragraphs = (doc: HwpxDocument): ParagraphNode[] => doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)]);

type Tally = { places: number; dropped: number; kept: number; fields: number; fieldDropped: number };

/** 출력 문서가 기대와 같은지: 필드 없는 문단의 `{{키}}` 자리는 값 글로, 메일머지 필드는 값 글로. 단위 중복(원원·%%) 0 */
function check(srcBytes: Uint8Array, t: StudioTemplate, row: Record<string, unknown>, output: Uint8Array, tally: Tally, label: string): void {
  const texts = new Map(bindValues(t, row, undefined).map((v) => [v.name, v.text ?? ""]));
  const src = reparse(srcBytes);
  const dst = reparse(output);
  const ps = paragraphs(src);
  const qs = paragraphs(dst);
  assert.equal(qs.length, ps.length, `${label}: 문단 수`);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] as ParagraphNode;
    if (p.fieldMarks.length > 0) continue;
    const hits = findLooseKeys(p.logicalText);
    if (hits.length === 0) continue;
    let want = "";
    let at = 0;
    for (const h of hits) {
      const e = expectedAt(texts.get(h.key) ?? "?", formatOf(h.key), p.logicalText.slice(h.end));
      want += p.logicalText.slice(at, h.start) + e.text;
      at = h.end;
      tally.places++;
      if (e.dropped) tally.dropped++;
      else if (UNIT_AFTER[formatOf(h.key).format] !== undefined) tally.kept++;
    }
    want += p.logicalText.slice(at);
    assert.equal((qs[i] as ParagraphNode).logicalText, want, `${label}: 문단 ${JSON.stringify(p.path)}`);
  }
  // 메일머지 필드: 원본 필드 끝 뒤 글로 기대 글을 정한다(필드 순서는 같다)
  const srcFields = collectFields(src).filter((f) => f.info.type === "MAILMERGE");
  const dstFields = listFields(dst).filter((f) => f.type === "MAILMERGE");
  assert.equal(dstFields.length, srcFields.length);
  srcFields.forEach((f, k) => {
    const key = f.info.mergeKey ?? "";
    const piece = f.end === null ? undefined : f.endParagraph?.pieces[f.end.pieceIndex];
    const after = piece === undefined || f.endParagraph === null ? "" : f.endParagraph.logicalText.slice(piece.logicalEnd);
    const e = expectedAt(texts.get(key) ?? "?", formatOf(key), after);
    assert.equal(dstFields[k]?.valueText, e.text, `${label}: 메일머지 ${k}`);
    tally.fields++;
    if (e.dropped) tally.fieldDropped++;
  });
  for (const q of qs) {
    assert.doesNotMatch(q.logicalText, /원[ \t 　]*원(?!본)/, `${label}: 원 중복`);
    assert.doesNotMatch(q.logicalText, /%[ \t]*%/, `${label}: % 중복`);
  }
}

test("#131 2단계 생성: 자리 수십 개(본문·표 칸·머리말·메일머지, 같은 키 중복)에 7종 값 → 단위 뒤 자리는 숫자만, 그 밖은 기본 표시", () => {
  const bytes = typedDoc();
  const t = typedTemplate(bytes);
  assert.ok(t.places.length >= 40, `자리 ${t.places.length}개`);
  const row: Record<string, unknown> = {};
  for (const v of t.values) row[v.name] = v.format === "text" ? "글" : (RAW[v.format][0] as unknown);
  row["예정가격"] = -1234;
  const r = ok(generateFromTemplate(bytes, t, row, undefined, () => undefined));
  const tally: Tally = { places: 0, dropped: 0, kept: 0, fields: 0, fieldDropped: 0 };
  check(bytes, t, row, out(r), tally, "고정");
  // 직접 확인: 원정·공백 원·전각 공백 원·% 앞·전각 ％은 뗌 대상이 아님
  const texts = paragraphs(reparse(out(r))).map((p) => p.logicalText);
  for (const s of [
    "1. 추정가격: 금 1,234,000원정(부가세 포함)",
    "2. 추정가격 1,234,000원, 예정가격 △1,234원",
    "3. 예정가격은 △1,234 원입니다.",
    "11. 금 1,234,000원 / 12.5%％ / 2026. 10. 09. / △1,234　원",
    "1,234,000원",
    "12.5%",
    "머리말 공고일 2026. 10. 09. / 금액 1,234,000원 / 율 12.5%",
  ]) assert.ok(texts.includes(s), `없음: ${s}`);
  // 메일머지: 바로 뒤에 "원"을 넣은 필드는 숫자만, 표 칸의 같은 키 필드는 단위까지
  const merge = listFields(reparse(out(r))).filter((f) => f.type === "MAILMERGE" && f.mergeKey === "추정가격").map((f) => f.valueText);
  assert.deepEqual(merge, ["1,234,000", "1,234,000원", "1,234,000원"]);
  assert.ok(tally.dropped >= 10 && tally.kept >= 5 && tally.fieldDropped === 1, JSON.stringify(tally));
  assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(out(r))).map((v) => v.code), []);
});

test("#131 2단계 생성 무작위 50회(시드 고정): 7종 원래 값·긴 글(0~1,500자)을 섞어도 성공, 결정성, 검사기 새 오류 0, 단위 중복 0", (ctx) => {
  const bytes = typedDoc();
  const t = typedTemplate(bytes);
  const base = validateDocument(bytes);
  const next = rng(131);
  const tally: Tally = { places: 0, dropped: 0, kept: 0, fields: 0, fieldDropped: 0 };
  for (let round = 0; round < 50; round++) {
    const row = record(t, next);
    const r = ok(generateFromTemplate(bytes, t, row, undefined, () => undefined));
    const again = ok(generateFromTemplate(bytes, t, row, undefined, () => undefined));
    assert.ok(bytesEqual(out(r), out(again)) && JSON.stringify(r.ledger) === JSON.stringify(again.ledger), `${round}회: 결정성`);
    assert.deepEqual(newErrorsAfter(base, validateDocument(out(r))).map((v) => v.code), [], `${round}회: 새 오류`);
    assert.equal(r.report.skipped.length, 0);
    check(bytes, t, row, out(r), tally, `${round}회`);
  }
  ctx.diagnostic(`자리 ${t.places.length}개, 값 ${t.values.length}개, 50회 합계 ${JSON.stringify(tally)}`);
  assert.ok(tally.places >= 50 * 40 && tally.dropped >= 50 * 8 && tally.fields >= 50 * 20, JSON.stringify(tally));
});

test("#131 2단계 생성: 읽지 못하는 값을 쓰는 자리가 있으면 DATA_FORMAT으로 막고(출력 없음) 메시지에 타입 이름이 있고 값 원문이 없다", () => {
  const bytes = typedDoc();
  const t = typedTemplate(bytes);
  const row: Record<string, unknown> = {};
  for (const v of t.values) row[v.name] = v.format === "text" ? "글" : (RAW[v.format][0] as unknown);
  for (const [name, bad, label] of [["추정가격", "1,23원", "money"], ["공고일", "2026-02-30", "date"], ["중소기업", "참이에요", "boolean"], ["하한율", "12%%", "percent"], ["마감일시", "2026-10-09", "datetime"], ["수량", "1,2,3", "number"]] as const) {
    const r = generateFromTemplate(bytes, t, { ...row, [name]: bad }, undefined, () => undefined);
    assert.equal(r.ok, false, name);
    assert.ok(!("output" in r));
    const errors = r.report.issues.filter((i) => i.severity === "error");
    assert.deepEqual([...new Set(errors.map((i) => i.code))], ["DATA_FORMAT"], name);
    assert.ok(errors.every((i) => i.message.includes(`(${label})`) && !i.message.includes(String(bad))), JSON.stringify(errors));
  }
  // 1·0은 참거짓이 아니다
  const one = generateFromTemplate(bytes, t, { ...row, "중소기업": 1 }, undefined, () => undefined);
  assert.deepEqual(one.ok ? [] : one.report.issues.filter((i) => i.severity === "error").map((i) => i.code), ["DATA_FORMAT"]);
});

test("#131 md 생성: {{키}} 뒤 원·%·낱말 자리 뒤 원은 단위를 떼고, 그 밖은 기본 표시", () => {
  const text = "# 공고\n\n금 {{금액}}원정, 다시 {{금액}}.\n\n하한율 {{율}}% / {{율}}\n\n일자 {{일자}} 여부 {{여부}}\n\n총액 1,000원 입니다.\n";
  const bytes = new TextEncoder().encode(text);
  const doc = text.split("\n\n");
  const blockIndex = doc.findIndex((b) => b.startsWith("총액"));
  const start = (doc[blockIndex] ?? "").indexOf("1,000");
  const raw = {
    schema: "hwpx-studio/template@2", id: "t00000132", version: 1, source: { kind: "md", sha256: sha256Hex(bytes) },
    anchors: [{ id: "a1", kind: "word", at: { sectionIndex: 0, path: [blockIndex] }, start, end: start + 5, print: { text: "1,000", before: "총액 ", after: "원 입니다." } }],
    values: [
      { id: "v1", name: "금액", format: "money" }, { id: "v2", name: "율", format: "percent" }, { id: "v3", name: "일자", format: "date", display: { pattern: "YYYY년 M월 D일" } },
      { id: "v4", name: "여부", format: "boolean" }, { id: "v5", name: "총액", format: "money", display: { negative: "△" } },
    ],
    bindings: [{ value: "v1", key: "금액" }, { value: "v2", key: "율" }, { value: "v3", key: "일자" }, { value: "v4", key: "여부" }, { value: "v5", key: "총액" }],
    places: [
      { id: "p1", kind: "placeholder", key: "금액", value: "v1" }, { id: "p2", kind: "placeholder", key: "율", value: "v2" }, { id: "p3", kind: "placeholder", key: "일자", value: "v3" },
      { id: "p4", kind: "placeholder", key: "여부", value: "v4" }, { id: "p5", kind: "word", anchor: "a1", value: "v5" },
    ],
    slots: [], blocks: [],
  };
  const t = readStudioTemplate(JSON.stringify(raw));
  assert.ok(t.schema === "hwpx-studio/template@2");
  const r = ok(generateFromTemplate(bytes, t, { "금액": "1,234,000", "율": 12.5, "일자": "20261009", "여부": "n", "총액": "-₩2,000" }, undefined, () => undefined));
  assert.equal(r.output, "# 공고\n\n금 1,234,000원정, 다시 1,234,000원.\n\n하한율 12.5% / 12.5%\n\n일자 2026년 10월 9일 여부 아니오\n\n총액 △2,000원 입니다.\n");
});
