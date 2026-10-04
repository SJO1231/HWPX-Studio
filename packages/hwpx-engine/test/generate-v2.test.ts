// 2판 템플릿의 2단계 생성 generateFromTemplate(엔진 명세 8.8.12, 수용 조건 W1·W2·W3·W8). 시험 자료는 합성 공고서와 시험 안에서 만든 실제 해시의 템플릿·덩어리다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listFields, readArchive, readEntry, validateDocument, walkParagraphs, type HwpxDocument, type ParagraphNode } from "../src/index.ts";
import { generate, generateFromTemplate, remapAddress, type Move, type StudioGenerateResult } from "../src/fill/index.ts";
import { canonicalStudioJson, caseSha256, readDataset, readStudioTemplate, readTemplate, sha256Hex, templateSha256, type StudioCase, type StudioTemplate } from "../src/template/index.ts";
import { linePrintOf as textLinePrint, wordPrintAt as textWordPrint } from "../src/text/anchors.ts";
import { parseText } from "../src/text/parse.ts";
import { bytesEqual, newErrorsAfter, readFixture, reparse } from "./helpers.ts";
import {
  caseOf,
  CLICK_NAMES,
  loaderOf,
  manual,
  MERGE_KEYS,
  noticeKit,
  PLACEHOLDER_KEYS,
  randomText,
  recordFor,
  studioOf,
  type NoticeKit,
} from "./generate-v2-helpers.ts";
import { at, dataFor, del, fragOf, inject, insertText, line, longValue, range, rng, tpl } from "./range-helpers.ts";

type Ok = Extract<StudioGenerateResult, { ok: true; dryRun: false }>;

function ok(r: StudioGenerateResult): Ok {
  assert.ok(r.ok, `생성이 실패했다: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error"))}`);
  assert.ok(!r.dryRun);
  return r as Ok;
}
function failCodes(r: StudioGenerateResult): string[] {
  assert.equal(r.ok, false, "생성이 성공해 버렸다");
  assert.ok(!("output" in r), "실패인데 출력이 있다");
  return r.report.issues.filter((i) => i.severity === "error").map((i) => i.code);
}
const out = (r: Ok): Uint8Array => {
  assert.ok(r.output instanceof Uint8Array);
  return r.output;
};
const allTexts = (doc: HwpxDocument): string[] => doc.sections.flatMap((s) => [...walkParagraphs(s.paragraphs)].map((p) => p.logicalText));
const OBJ = /￼/g;
/** 원본 좌표의 문단 주소를 이동표로 옮겨 결과 문서의 문단을 돌려준다 */
function paragraphAt(doc: HwpxDocument, path: number[]): ParagraphNode {
  let list = at(doc.sections, 0).paragraphs;
  for (let i = 0; i < path.length - 1; i += 2) list = at(at(list, at(path, i)).subLists, at(path, i + 1)).paragraphs;
  return at(list, at(path, path.length - 1));
}
function moved(moves: readonly Move[], path: number[]): number[] {
  const m = remapAddress(moves, { sectionIndex: 0, path });
  assert.ok(m !== undefined, `${path.join(",")}가 덮였다`);
  return m.path;
}
const fieldsOf = (doc: HwpxDocument, type: string, key: string) => listFields(doc).filter((f) => f.type === type && (type === "MAILMERGE" ? f.mergeKey === key : f.name === key));
const label = (name: string): string => `값[${name}]`;
const withRaw = (kit: NoticeKit, edit: (raw: Record<string, any>) => void): StudioTemplate => {
  const raw = structuredClone(kit.raw) as Record<string, any>;
  edit(raw);
  return studioOf(raw, kit.blobs);
};

let kitCache: NoticeKit | undefined;
const kit = (): NoticeKit => (kitCache ??= noticeKit());

/** 기본 실행: 금액 6천만(s4 = b8 조각), 중소기업 아님(s1 = b2 글, s3 = b6 빈 글), s2 = b3 조각(수동) */
function baseRun(extra: { unwrap?: boolean; preview?: boolean } = {}) {
  const k = kit();
  const t = extra.unwrap === true || extra.preview === true ? withRaw(k, (raw) => (raw["options"] = { ...raw["options"], unwrapFilled: extra.unwrap === true, refreshPreview: extra.preview === true })) : k.t;
  const record = recordFor(label, { price: 60000000 });
  const c = caseOf(t, record, { selections: { s2: manual(t, "s2", "b3") } });
  return { k, t, record, c, r: generateFromTemplate(k.bytes, t, record, c, loaderOf(k.blobs)) };
}

// ── W1: 승계·결정성·원장 ───────────────────────────────────────

test("W1: 1판 템플릿은 readStudioTemplate(@1) → generateFromTemplate가 generate와 바이트·원장까지 같다", () => {
  const k = kit();
  const doc = k.doc;
  const blocks = reparse(readFixture("hancom/blocks"));
  const next = rng(11);
  const data = dataFor(doc, () => longValue(next, 0, 1200));
  const raw = tpl(
    [range(doc, "a", 18, 21), range(doc, "b", 28, 31), line(doc, "c", [44]), range(doc, "d", 2, 4, [12, 1])],
    [inject("A", "a", fragOf(blocks, 2, 3)), insertText("B", "b", "가 줄\n나 줄 & <참고>"), del("C", "c"), insertText("D", "d", "칸 글")],
  );
  const json = JSON.stringify(raw);
  const v1 = generate(k.bytes, readTemplate(json), readDataset(data));
  const legacy = readStudioTemplate(json);
  assert.equal(legacy.schema, "hwpx-studio/template@1");
  const v2 = generateFromTemplate(k.bytes, legacy, data, undefined, () => undefined);
  assert.ok(v1.ok && !v1.dryRun && v2.ok && !v2.dryRun);
  assert.ok(bytesEqual(v1.output, v2.output));
  assert.equal(JSON.stringify(v1.ledger), JSON.stringify(v2.ledger));
});

test("W1: 같은 입력을 두 번 생성하면 출력·원장·보고서가 바이트까지 같고, 원장에 원본·템플릿·이번 건·행 해시가 있고 값 원문이 없다", () => {
  const k = kit();
  const next = rng(5);
  const record = recordFor(randomText(next), { price: 150000000, sme: "Y" });
  const c = caseOf(k.t, record, { selections: { s2: manual(k.t, "s2", "b3") }, valueEdits: { [k.valueId("사업명")]: "정정한 사업 이름입니다 & <정정>" } });
  const a = ok(generateFromTemplate(k.bytes, k.t, record, c, loaderOf(k.blobs)));
  const b = ok(generateFromTemplate(k.bytes, k.t, record, c, loaderOf(k.blobs)));
  assert.ok(bytesEqual(out(a), out(b)));
  assert.equal(JSON.stringify(a.ledger), JSON.stringify(b.ledger));
  assert.equal(JSON.stringify(a.report), JSON.stringify(b.report));
  const l = a.ledger;
  assert.ok(l !== undefined);
  assert.equal(l.source.sha256, k.t.source.sha256);
  assert.equal(l.input.sha256, sha256Hex(k.bytes));
  assert.deepEqual(l.template, { id: k.t.id, version: k.t.version, sha256: templateSha256(k.t) });
  assert.deepEqual(l.case, { sha256: caseSha256(c) });
  assert.deepEqual(l.record, { sha256: sha256Hex(canonicalStudioJson(record)), dataset: c.record.dataset, version: c.record.version });
  assert.equal(l.output.sha256, sha256Hex(out(a)));
  assert.equal(l.fragments.length, 3); // b1·b3·b8 조각
  // 값 원문(20자 넘는 것)은 원장·보고서 어디에도 없다
  const dump = JSON.stringify(l) + JSON.stringify(a.report);
  for (const v of Object.values(record)) if (typeof v === "string" && v.length > 20) assert.ok(!dump.includes(v.slice(0, 20)), "값 원문이 원장·보고서에 들어갔다");
  assert.ok(!dump.includes("정정한 사업 이름"));
  // 이번 건 없이도 같은 선택이면 같은 출력(원장의 case·dataset은 없다)
  const noCase = ok(generateFromTemplate(k.bytes, withRaw(k, (raw) => (raw["blocks"] = (raw["blocks"] as { id: string }[]).filter((x) => x.id !== "b4"))), record, undefined, loaderOf(k.blobs)));
  assert.equal(noCase.ledger?.case, undefined);
  assert.deepEqual(Object.keys(noCase.ledger?.record ?? {}), ["sha256"]);
});

test("원장의 행 해시: 같은 행을 키 순서만 바꿔 넘겨도 같고, canonicalStudioJson(행)의 sha256과 같다", () => {
  const k = kit();
  const record = recordFor(label, { price: 60000000 });
  const reversed = Object.fromEntries(Object.entries(record).reverse());
  assert.notEqual(JSON.stringify(reversed), JSON.stringify(record));
  const run = (row: Record<string, unknown>) => ok(generateFromTemplate(k.bytes, k.t, row, caseOf(k.t, record, { selections: { s2: manual(k.t, "s2", "b3") } }), loaderOf(k.blobs)));
  const a = run(record);
  const b = run(reversed);
  assert.equal(a.ledger?.record.sha256, sha256Hex(canonicalStudioJson(record)));
  assert.equal(b.ledger?.record.sha256, a.ledger?.record.sha256);
  assert.equal(canonicalStudioJson(reversed), canonicalStudioJson(record));
  assert.ok(bytesEqual(out(a), out(b)));
});

// ── W8: 이동표·자리 ─────────────────────────────────────────────

test("W8: 이동표로 옮긴 word·line·cell 자리가 교체 범위 앞·뒤·칸 안의 맞는 곳에 채워지고, 범위 안 자리는 PLACE_COVERED(성공)다", () => {
  const { k, r } = baseRun();
  const res = ok(r);
  const moves = res.report.moves;
  assert.deepEqual(
    moves.map((m) => [m.parentPath.join("."), m.from, m.to, m.count]),
    [["12.1", 2, 4, 0], ["", 18, 22, 2], ["", 28, 31, 1], ["", 33, 33, 4], ["", 38, 41, 1]],
  );
  const doc = reparse(out(res));
  // 머리말(교체와 무관), 범위 뒤 본문, 칸 안(교체 범위 앞·뒤)
  assert.ok(paragraphAt(doc, [0, 0, 0]).logicalText.startsWith(label("낱말 머리말")));
  assert.ok(paragraphAt(doc, moved(moves, [44])).logicalText.includes(label("낱말 범위 뒤")));
  assert.equal(paragraphAt(doc, moved(moves, [12, 1, 1])).logicalText, `칸 ${label("낱말 칸 앞")}`);
  assert.equal(paragraphAt(doc, moved(moves, [12, 1, 5])).logicalText, `칸 ${label("낱말 칸 뒤")}`);
  assert.deepEqual(moved(moves, [12, 1, 5]), [12, 1, 2]);
  assert.equal(paragraphAt(doc, moved(moves, [42])).logicalText, label("줄 범위 뒤"));
  // 칸: 복사본 표(서수 2 → 조각 표 둘이 앞에 들어가 서수 4)의 4행 0열, 첫 표 0행 2열
  assert.equal(at(paragraphAt(doc, moved(moves, [58])).subLists, 12).paragraphs[0]?.logicalText, label("칸 복사본"));
  assert.equal(at(paragraphAt(doc, [12]).subLists, 2).paragraphs[0]?.logicalText, label("칸 첫 표"));
  // 범위 안 자리는 빠지고 성공한다
  assert.deepEqual(res.report.dropped.map((d) => [d.kind, d.code]), [["word", "PLACE_COVERED"], ["line", "PLACE_COVERED"]]);
  const texts = allTexts(doc).join("\n");
  assert.ok(!texts.includes(label("낱말 범위 안")) && !texts.includes(label("줄 범위 안")));
  // 범위 밖 본문은 이동표대로 옮겨 그대로 있다({{기관명}}·{{사업명}}만 값으로 바뀐다)
  const original = at(k.doc.sections, 0).paragraphs;
  let checked = 0;
  for (let i = 17; i <= 46; i++) {
    const m = remapAddress(moves, { sectionIndex: 0, path: [i] });
    if (m === undefined || i === 42 || i === 44) continue;
    const expected = at(original, i).logicalText.replace(/\{\{(기관명|사업명)\}\}/g, (_x, key: string) => label(key));
    assert.equal(paragraphAt(doc, m.path).logicalText, expected, `원본 문단 ${i}`);
    checked++;
  }
  assert.equal(checked, 30 - 5 - 4 - 1 - 4 - 2);
  assert.deepEqual(newErrorsAfter(validateDocument(k.bytes), validateDocument(out(res))).map((v) => v.code), []);
  assert.deepEqual(res.report.validation?.newErrors, []);
});

test("W8: clickHere·mailMerge는 조립본에서 이름·키로 다시 열거해 블록 안까지 채우고, occurrence는 이동표로 옮긴 원본의 그 곳만, where는 그 블록 안만 채운다", () => {
  const { k, r } = baseRun();
  const res = ok(r);
  const moves = res.report.moves;
  const doc = reparse(out(res));
  const before = reparse(k.bytes);
  // 자리 41개가 조립본에서 122곳(머리말·꼬리말·본문·표 칸·조각 안)을 채운다. 원장의 건너뜀은 0
  assert.equal(k.t.places.length, 41);
  assert.equal(res.report.stage2?.plan.actions.reduce((n, a) => n + a.targets, 0), 122);
  assert.equal(res.ledger?.counts.skipped, 0);
  // 메일 머지: 원본·복사본·머리말·꼬리말·조각(b8) 안의 같은 키가 전부 채워진다
  for (const key of MERGE_KEYS) {
    const fields = fieldsOf(doc, "MAILMERGE", key);
    assert.ok(fields.length >= fieldsOf(before, "MAILMERGE", key).length, key);
    const want = key === "추정가격" ? "60,000,000원" : key === "예정가격" ? "98,765원" : label(key);
    for (const f of fields) assert.equal(f.valueText, want, `${key}[${f.occurrence}]`);
  }
  assert.ok(fieldsOf(doc, "MAILMERGE", "담당자").length > fieldsOf(before, "MAILMERGE", "담당자").length, "조각 안의 필드도 채운다");
  // 순번: 원본의 사유 설명 1번(복사본 [54])만, 조각이 앞에 하나 들어가 조립본에서는 2번이다
  const reason = fieldsOf(doc, "MAILMERGE", "사유 설명");
  assert.deepEqual(reason.map((f) => f.valueText), ["해당 없음", "해당 없음", label("사유 설명")]);
  assert.deepEqual(at(reason, 2).path, moved(moves, [54]));
  // where: b8 블록 안의 재공고만
  const again = fieldsOf(doc, "MAILMERGE", "재공고");
  assert.deepEqual(again.map((f) => f.valueText), ["{{재공고}}", label("재공고"), "{{재공고}}"]);
  // 누름틀 이름: 원본의 1번(복사본 표 [61])만. 앞에 조각 표 둘이 이름 누름틀을 더해 조립본에서는 3번이다
  const names = fieldsOf(doc, "CLICK_HERE", "이름");
  assert.deepEqual(names.map((f) => f.valueText), ["이름 입력", "이름 입력", "이름 입력", label("이름")]);
  assert.deepEqual(at(names, 3).path, [...moved(moves, [61]), 1, 0]);
  for (const name of CLICK_NAMES) for (const f of fieldsOf(doc, "CLICK_HERE", name)) assert.equal(f.valueText, label(name));
  // {{ }}: 본문·표 칸·블록 글 안(where b2의 담당자 이름 포함). 누름틀·메일 머지 표시 글 안의 것은 필드가 맡는다
  const texts = allTexts(doc).join("\n");
  for (const key of PLACEHOLDER_KEYS) assert.ok(!texts.includes(`{{${key}}}`), key);
  assert.ok(texts.includes(`문의: ${label("담당자 이름")} (${label("연락처")})`));
});

test("8.8.13 5단계: 정상 템플릿은 앵커 전부 exact, 지문 없는 cell은 성공 + ANCHOR_UNVERIFIED 경고 1(출력 같음), 지문이 틀린 앵커는 그 코드들로 실패(출력 없음)", () => {
  const { k, record, c, r } = baseRun();
  const base = ok(r);
  assert.equal(base.report.anchors.length, k.t.anchors.length);
  assert.deepEqual([...new Set(base.report.anchors.map((x) => x.state))], ["exact"]);
  assert.deepEqual(base.report.warnings, []);
  const run = (edit: (anchors: Record<string, any>[]) => void): StudioGenerateResult => {
    const t = withRaw(k, (raw) => edit(raw["anchors"] as Record<string, any>[]));
    return generateFromTemplate(k.bytes, t, record, { ...c, template: caseOf(t, record).template }, loaderOf(k.blobs));
  };
  const byId = (anchors: Record<string, any>[], id: string): Record<string, any> => {
    const a = anchors.find((x) => x["id"] === id);
    assert.ok(a !== undefined);
    return a;
  };
  const unverified = ok(run((anchors) => delete byId(anchors, "a14")["print"]));
  assert.deepEqual(unverified.report.warnings.map((w) => w.code), ["ANCHOR_UNVERIFIED"]);
  assert.equal(unverified.report.anchors.find((x) => x.anchor === "a14")?.state, "unverified");
  assert.ok(bytesEqual(out(unverified), out(base)));
  const broken = run((anchors) => {
    byId(anchors, "a1")["print"]["sha256"] = "0".repeat(64); // 양 끝은 같고 안쪽 해시가 다름
    byId(anchors, "a7")["print"]["before"] = "없는 앞 글"; // 어디에도 없는 지문
    byId(anchors, "a11")["at"]["path"] = [41]; // 지문은 맞고 주소만 틀림
  });
  assert.deepEqual(failCodes(broken), ["ANCHOR_CHANGED", "ANCHOR_NOT_FOUND", "ANCHOR_RELOCATED"]);
  assert.deepEqual(broken.report.anchors.filter((x) => x.state !== "exact").map((x) => [x.anchor, x.state]), [["a1", "changed"], ["a7", "notFound"], ["a11", "relocated"]]);
  assert.equal(broken.report.stage1, null);
});

test("G4: 공백·탭·줄바꿈만 있는 글 블록은 빈 글로 보아 슬롯 범위를 지운다(이동표 count 0, 문단 수 감소)", () => {
  const { k, record, c, r } = baseRun();
  const base = reparse(out(ok(r)));
  const blank = ok(generateFromTemplate(k.bytes, k.t, record, { ...c, blockEdits: { b2: { text: " \n\t\n" } } }, loaderOf(k.blobs)));
  assert.deepEqual(blank.report.moves.find((m) => m.parentPath.length === 0 && m.from === 18), { sectionIndex: 0, parentPath: [], from: 18, to: 22, count: 0, delta: -5 });
  const doc = reparse(out(blank));
  assert.equal(at(doc.sections, 0).paragraphs.length, at(base.sections, 0).paragraphs.length - 2);
  assert.ok(!allTexts(doc).some((x) => x.trim() === "" && x !== "" && !x.includes("\uFFFC")), "공백뿐인 문단이 들어갔다");
});

// ── W3: 선택 ────────────────────────────────────────────────────

test("W3: 고르지 않은 블록의 글·누름틀·{{}}는 출력에 없고, 고른 블록은 슬롯 앵커마다 들어간다. confirmed는 조건과 달라도 유지된다", () => {
  const k = kit();
  const record = recordFor(label, { price: 1, sme: "Y" });
  const c = caseOf(k.t, record, { selections: { s2: manual(k.t, "s2", "b4") } });
  const res = ok(generateFromTemplate(k.bytes, k.t, record, c, loaderOf(k.blobs)));
  assert.deepEqual(res.report.selections.map((s) => [s.slot, s.state, s.block]), [["s1", "default", "b1t"], ["s2", "manual", "b4"], ["s3", "default", "b5"], ["s4", "fallback", "b7"]]);
  const doc = reparse(out(res));
  const texts = allTexts(doc);
  const joined = texts.join("\n");
  for (const gone of ["에는 자격을 갖춘 업체가", ...(k.fragmentTexts.get("b1") ?? []), "칸 문단 2"]) assert.ok(!joined.includes(gone), gone);
  for (const key of PLACEHOLDER_KEYS) assert.ok(!joined.includes(`{{${key}}}`), key);
  // 조각 블록(b3 표, b8 필드)의 누름틀·필드가 없다: 이름 누름틀과 사유 설명 필드 수가 원본과 같다
  const before = reparse(k.bytes);
  assert.equal(fieldsOf(doc, "CLICK_HERE", "이름").length, fieldsOf(before, "CLICK_HERE", "이름").length);
  assert.equal(fieldsOf(doc, "MAILMERGE", "사유 설명").length, fieldsOf(before, "MAILMERGE", "사유 설명").length);
  // 고른 글 블록: s2는 앵커 둘에 같은 글, 줄마다 문단. {{ 담당자 }}(공백)도 채운다
  assert.equal(texts.filter((x) => x === "일반 계약 조건 \"인용\"").length, 2);
  assert.equal(texts.filter((x) => x === `${label("기관명")} 기준`).length, 2);
  assert.ok(texts.includes(`${label("사업명")} 참가자격: 중소기업 우대 & <확인>`) && texts.includes(`${label("담당자")}에게 문의`));
  assert.ok(texts.includes(`칸 교체 ${label("기관명")}`) && texts.includes("칸 둘째 줄") && texts.includes(`끝 조항 ${label("사업명")}`));
  // confirmed: 조건은 b1t를 고르지만 저장한 b2를 쓴다(차이만 표시)
  const confirmed: StudioCase = { ...c, selections: { ...c.selections, s1: { ...manual(k.t, "s1", "b2"), basis: "confirmed" } } };
  const res2 = ok(generateFromTemplate(k.bytes, k.t, record, confirmed, loaderOf(k.blobs)));
  const s1 = res2.report.selections[0];
  assert.deepEqual([s1?.state, s1?.block, s1?.differs, s1?.candidates], ["confirmed", "b2", true, ["b1t"]]);
  assert.ok(allTexts(reparse(out(res2))).some((x) => x.endsWith("에는 자격을 갖춘 업체가 참가할 수 있습니다.")));
});

test("W3: 막는 슬롯마다 SEL_*를 모아 내고 출력이 없다(동률·확정 필요·저장 선택의 내용 변경)", () => {
  const k = kit();
  const record = recordFor(label, { price: 60000000 });
  // 이번 건이 없으면 s2의 조건 없는 블록 둘이 동률
  assert.deepEqual(failCodes(generateFromTemplate(k.bytes, k.t, record, undefined, loaderOf(k.blobs))), ["SEL_UNDECIDED"]);
  // requireConfirm: 계산한 선택(s1·s3·s4)은 모두 확정을 기다리고, s2의 저장 선택은 내용 해시가 달라 recheck
  const t = withRaw(k, (raw) => (raw["options"] = { ...raw["options"], requireConfirm: true }));
  const stale = caseOf(t, record, { selections: { s2: { ...manual(t, "s2", "b3"), content: sha256Hex("옛 내용") } } });
  const r = generateFromTemplate(k.bytes, t, record, stale, loaderOf(k.blobs));
  assert.deepEqual(failCodes(r), ["SEL_UNDECIDED", "SEL_RECHECK", "SEL_UNDECIDED", "SEL_UNDECIDED"]);
  assert.deepEqual(r.report.issues.map((i) => i.where), ["slots.s1", "slots.s2", "slots.s3", "slots.s4"]);
  assert.equal(r.report.stage1, null);
});

// ── W2·검사 ─────────────────────────────────────────────────────

test("W8·W2: 원본 해시가 다르면 TPL_SOURCE_MISMATCH, 중첩 슬롯은 TPL_NESTED, 조각이 없거나 해시가 다르면 TPL_FRAGMENT_MISSING(출력 없음)", () => {
  const k = kit();
  const record = recordFor(label, { price: 60000000 });
  const c = caseOf(k.t, record, { selections: { s2: manual(k.t, "s2", "b3") } });
  const load = loaderOf(k.blobs);
  assert.deepEqual(failCodes(generateFromTemplate(readFixture("merge/merge-fields"), k.t, record, c, load)), ["TPL_SOURCE_MISMATCH"]);
  // 바이트 하나만 더해도(ZIP으로 읽기 전에) 대조가 먼저 막는다
  assert.deepEqual(failCodes(generateFromTemplate(new Uint8Array([...k.bytes, 0]), k.t, record, c, load)), ["TPL_SOURCE_MISMATCH"]);

  const nested = withRaw(k, (raw) => {
    raw["anchors"].push(line(k.doc, "a16", [46]));
    raw["slots"].push({ id: "s5", name: "중첩", anchors: ["a16"], parent: "b2" });
    raw["blocks"].push({ id: "b9", slot: "s5", name: "안쪽", content: { text: "안쪽 글" } });
  });
  const rn = generateFromTemplate(k.bytes, nested, record, caseOf(nested, record, { selections: { s2: manual(nested, "s2", "b3") } }), load);
  assert.deepEqual(failCodes(rn), ["TPL_NESTED"]);

  const [b3sha] = [...k.blobs.keys()].filter((sha) => k.t.blocks.some((b) => b.id === "b3" && "fragment" in b.content && b.content.fragment === sha));
  assert.ok(b3sha !== undefined);
  const without = new Map(k.blobs);
  without.delete(b3sha);
  assert.deepEqual(failCodes(generateFromTemplate(k.bytes, k.t, record, c, loaderOf(without))), ["TPL_FRAGMENT_MISSING"]);
  const tampered = new Map(k.blobs);
  tampered.set(b3sha, new Uint8Array([...(k.blobs.get(b3sha) ?? []), 0x20]));
  assert.deepEqual(failCodes(generateFromTemplate(k.bytes, k.t, record, c, loaderOf(tampered))), ["TPL_FRAGMENT_MISSING"]);
  // 이번 건의 블록 수정이 가리키는 조각도 받아야 한다
  const edit = caseOf(k.t, record, { selections: c.selections, blockEdits: { b8: { fragment: "e".repeat(64) } } });
  assert.deepEqual(failCodes(generateFromTemplate(k.bytes, k.t, record, edit, load)), ["TPL_FRAGMENT_MISSING"]);
});

// ── 값 ─────────────────────────────────────────────────────────

test("값: rejected·DATA_MISSING 값을 쓰는 자리는 그 코드로 실패, 쓰는 자리가 덮였거나 고르지 않은 블록 안이면 막지 않는다. 금액은 1,234원 꼴", () => {
  const k = kit();
  const load = loaderOf(k.blobs);
  const run = (edit: (row: Record<string, unknown>) => void, t: StudioTemplate = k.t, sme = "N"): StudioGenerateResult => {
    const record = recordFor(label, { price: 60000000, sme });
    edit(record);
    return generateFromTemplate(k.bytes, t, record, caseOf(t, record, { selections: { s2: manual(t, "s2", "b3") } }), load);
  };
  assert.deepEqual(failCodes(run((row) => (row["예정가격"] = "1,234"))), ["DATA_FORMAT"]);
  assert.deepEqual(failCodes(run((row) => (row["부가세"] = { 값: 1 }))), ["DATA_NOT_SCALAR"]);
  assert.deepEqual(failCodes(run((row) => (row["장소"] = "제어\u0001문자"))), ["VALUE_CONTROL_CHAR"]);
  assert.deepEqual(failCodes(run((row) => delete row["장소"])), ["DATA_MISSING"]);
  // 덮인 낱말 자리의 값, 고르지 않은 블록(b2) 안 자리(where)의 값은 막지 않는다
  ok(run((row) => (row["낱말 범위 안"] = { 값: 1 })));
  ok(run((row) => (row["담당자 이름"] = { 값: 1 }), k.t, "Y"));
  // 누락 정책 empty·keep(템플릿 options.missing)
  const empty = ok(run((row) => delete row["장소"], withRaw(k, (raw) => (raw["options"] = { ...raw["options"], missing: "empty" }))));
  assert.ok(fieldsOf(reparse(out(empty)), "MAILMERGE", "장소").every((f) => f.valueText === ""));
  const keep = ok(run((row) => delete row["장소"], withRaw(k, (raw) => (raw["options"] = { ...raw["options"], missing: "keep" }))));
  assert.ok(fieldsOf(reparse(out(keep)), "MAILMERGE", "장소").every((f) => f.valueText === "{{장소}}"));
  // 금액: 음수, 0이 앞에 붙은 글, 별칭 열
  const money = ok(run((row) => {
    row["예정가격"] = -1234;
    delete row["추정가격(원)"];
    row["추정 가격"] = "007";
  }));
  const doc = reparse(out(money));
  assert.ok(fieldsOf(doc, "MAILMERGE", "예정가격").every((f) => f.valueText === "-1,234원"));
  assert.ok(fieldsOf(doc, "MAILMERGE", "추정가격").every((f) => f.valueText === "7원"));
  // valueEdits가 행보다 이긴다
  const record = recordFor(label, { price: 60000000 });
  const c = caseOf(k.t, record, { selections: { s2: manual(k.t, "s2", "b3") }, valueEdits: { [k.valueId("사업명")]: "정정 사업" } });
  const edited = reparse(out(ok(generateFromTemplate(k.bytes, k.t, record, c, load))));
  assert.ok(fieldsOf(edited, "MAILMERGE", "사업명").every((f) => f.valueText === "정정 사업"));
});

test("W8: 등록되지 않은 {{ }}는 unregistered: error면 PLACE_UNREGISTERED(출력 없음), keep이면 경고를 남기고 그대로 둔다", () => {
  const k = kit();
  const record = recordFor(label, { price: 1 });
  const c = (t: StudioTemplate) => caseOf(t, record, { selections: { s2: manual(t, "s2", "b3") }, blockEdits: { b7: { text: "끝 {{ 미등록 키 }} 조항" } } });
  const r = generateFromTemplate(k.bytes, k.t, record, c(k.t), loaderOf(k.blobs));
  assert.deepEqual(failCodes(r), ["PLACE_UNREGISTERED"]);
  assert.match(r.report.issues.find((i) => i.code === "PLACE_UNREGISTERED")?.message ?? "", /미등록 키/);
  const t = withRaw(k, (raw) => (raw["options"] = { ...raw["options"], unregistered: "keep" }));
  const res = ok(generateFromTemplate(k.bytes, t, record, c(t), loaderOf(k.blobs)));
  assert.equal(res.report.warnings.filter((w) => w.code === "PLACE_UNREGISTERED").length, 1);
  assert.ok(allTexts(reparse(out(res))).includes("끝 {{ 미등록 키 }} 조항"));
});

test("W8: 2단계 건너뜀이 1건이라도 있으면 FILL_SKIPPED(코드별 건수, 출력 없음). mixedFormat: first면 채운다. 슬롯 없는 템플릿은 2단계만 한다", () => {
  const bytes = readFixture("hancom/ph-mixed");
  const keys = ["project.name", "company.name", "manager.name", "manager.phone"];
  const raw = (options: Record<string, unknown>) => ({
    schema: "hwpx-studio/template@2",
    id: "t0000a001",
    version: 1,
    source: { kind: "hwpx", sha256: sha256Hex(bytes) },
    anchors: [],
    values: keys.map((key, i) => ({ id: `v${i}`, name: key, format: "text" })),
    bindings: keys.map((key, i) => ({ value: `v${i}`, key })),
    places: keys.map((key, i) => ({ id: `p${i}`, kind: "placeholder", key, value: `v${i}` })),
    slots: [],
    blocks: [],
    options,
  });
  const record = Object.fromEntries(keys.map((key) => [key, `${key} 값`]));
  const r = generateFromTemplate(bytes, studioOf(raw({}), new Map()), record, undefined, () => undefined);
  assert.deepEqual(failCodes(r), ["FILL_SKIPPED"]);
  assert.deepEqual(r.report.skipped.map((s) => s.code), ["FILL_MIXED_FORMAT"]);
  assert.match(r.report.issues.find((i) => i.code === "FILL_SKIPPED")?.message ?? "", /FILL_MIXED_FORMAT 1곳/);
  const first = ok(generateFromTemplate(bytes, studioOf(raw({ mixedFormat: "first" }), new Map()), record, undefined, () => undefined));
  assert.equal(first.report.stage1, null);
  assert.ok(allTexts(reparse(out(first))).some((x) => x.includes("project.name 값")));
  // 모의 실행: 같은 판정, 출력 없음
  const dry = generateFromTemplate(bytes, studioOf(raw({ mixedFormat: "first" }), new Map()), record, undefined, () => undefined, { dryRun: true });
  assert.ok(dry.ok && dry.dryRun && !("output" in dry));
  assert.deepEqual(failCodes(generateFromTemplate(bytes, studioOf(raw({}), new Map()), record, undefined, () => undefined, { dryRun: true })), ["FILL_SKIPPED"]);
});

// ── 후처리 ─────────────────────────────────────────────────────

test("후처리: 기본은 끔(필드 표식·미리보기 글 그대로), unwrapFilled는 채운 필드 표식만 지우고 글은 같으며, refreshPreview는 PrvText를 결과 글로 다시 쓴다", () => {
  const PRV = "Preview/PrvText.txt";
  const entry = (bytes: Uint8Array): string => new TextDecoder().decode(readEntry(readArchive(bytes), bytes, PRV));
  const plain = ok(baseRun().r);
  const plainDoc = reparse(out(plain));
  assert.equal(plain.report.postprocess.unwrapped, 0);
  assert.equal(entry(out(plain)), entry(kit().bytes));
  const plainFields = listFields(plainDoc);
  const filled = plainFields.filter((f) => !["{{재공고}}", "해당 없음", "이름 입력"].includes(f.valueText));
  assert.ok(filled.length > 60);

  const both = ok(baseRun({ unwrap: true, preview: true }).r);
  const doc = reparse(out(both));
  assert.equal(both.report.postprocess.unwrapped, filled.length);
  assert.deepEqual(listFields(doc).map((f) => f.valueText).sort(), plainFields.filter((f) => !filled.includes(f)).map((f) => f.valueText).sort());
  const lines = (d: HwpxDocument): string[] => allTexts(d).map((x) => x.replace(OBJ, ""));
  assert.deepEqual(lines(doc), lines(plainDoc));
  assert.equal(entry(out(both)), lines(doc).join("\n"));
  assert.deepEqual(newErrorsAfter(validateDocument(kit().bytes), validateDocument(out(both))).map((v) => v.code), []);
  // 미리보기만 켜면 필드는 그대로
  const pv = ok(baseRun({ preview: true }).r);
  assert.equal(listFields(reparse(out(pv))).length, listFields(plainDoc).length);
  assert.ok(pv.report.postprocess.preview);
});

test("옵션: 모의 실행은 1단계를 거쳐 2단계 계획까지(출력 없음), mode strict는 결과 오류 0이면 성공, repair는 보정 함수의 결과를 원본으로 삼고 원장에 남긴다", () => {
  const { k, t, record, c } = baseRun();
  const dry = generateFromTemplate(k.bytes, t, record, c, loaderOf(k.blobs), { dryRun: true });
  assert.ok(dry.ok && dry.dryRun && !("output" in dry));
  assert.ok(dry.report.stage1 !== null && dry.report.stage2 !== null && dry.report.validation === null);
  assert.equal(dry.report.stage2.plan.actions.length, ok(baseRun().r).report.stage2?.plan.actions.length);
  const strict = ok(generateFromTemplate(k.bytes, t, record, c, loaderOf(k.blobs), { mode: "strict" }));
  assert.equal(strict.ledger?.mode, "strict");
  assert.equal(strict.report.validation?.after.errors, 0);
  let calls = 0;
  const repaired = ok(generateFromTemplate(k.bytes, t, record, c, loaderOf(k.blobs), { mode: "repair", repair: (b) => (calls++, { output: b, repaired: [] }) }));
  assert.deepEqual(repaired.ledger?.repaired, { sha256: sha256Hex(k.bytes), notes: 0 });
  assert.ok(calls >= 1);
  assert.ok(bytesEqual(out(repaired), out(ok(baseRun().r))));
});

// ── md ─────────────────────────────────────────────────────────

test("md: 표식 줄 슬롯을 글 블록으로 바꾼 뒤 {{ }}·낱말·칸 자리를 채운다(원장 없음, BOM·CRLF 보존). 해시·미등록·덮임 판정도 같다", () => {
  const md = "﻿# 공고 {{ 제목 }}\r\n\r\n[슬롯:자격]\r\n\r\n본문 {{기관}} 안내.\r\n\r\n[슬롯:끝]\r\n\r\n| 항목 | 값 |\r\n|---|---|\r\n| 기관 | {{기관}} |\r\n\r\n마지막 줄 확인.\r\n";
  const bytes = new TextEncoder().encode(md);
  const doc = parseText(md, "md");
  const blockLine = (id: string, i: number) => ({ id, kind: "line", at: { sectionIndex: 0, path: [i] }, print: textLinePrint(at(doc.blocks, i).text) });
  const last = at(doc.blocks, 5).text;
  const raw = (blocks: unknown[], options: Record<string, unknown> = {}) => ({
    schema: "hwpx-studio/template@2",
    id: "t0000b001",
    version: 1,
    source: { kind: "md", sha256: sha256Hex(bytes) },
    anchors: [
      blockLine("m1", 1),
      blockLine("m2", 3),
      { id: "w1", kind: "word", at: { sectionIndex: 0, path: [5] }, start: last.indexOf("확인"), end: last.indexOf("확인") + 2, print: textWordPrint(last, last.indexOf("확인"), last.indexOf("확인") + 2) },
      { id: "w2", kind: "word", at: { sectionIndex: 0, path: [3] }, start: 0, end: 4, print: textWordPrint(at(doc.blocks, 3).text, 0, 4) },
      { id: "c1", kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 0 },
    ],
    values: [
      { id: "v1", name: "제목", format: "text" },
      { id: "v2", name: "기관", format: "text" },
      { id: "v3", name: "확인 글", format: "text" },
      { id: "v4", name: "칸 글", format: "text" },
    ],
    bindings: [
      { value: "v1", key: "제목" },
      { value: "v2", key: "기관" },
      { value: "v3", key: "확인 글" },
      { value: "v4", key: "칸 글" },
    ],
    places: [
      { id: "p1", kind: "placeholder", key: "제목", value: "v1" },
      { id: "p2", kind: "placeholder", key: "기관", value: "v2" },
      { id: "p3", kind: "word", anchor: "w1", value: "v3" },
      { id: "p4", kind: "word", anchor: "w2", value: "v3" },
      { id: "p5", kind: "cell", anchor: "c1", value: "v4" },
    ],
    slots: [
      { id: "s1", name: "자격", anchors: ["m1"], parent: null },
      { id: "s2", name: "끝", anchors: ["m2"], parent: null },
    ],
    blocks,
    options,
  });
  const blocks = [
    { id: "b1", slot: "s1", name: "자격 글", content: { text: "자격 1 {{기관}}\n자격 2 & <참고>" } },
    { id: "b2", slot: "s2", name: "끝 비움", content: { text: "" } },
  ];
  const record = { 제목: "알파 공고", 기관: "베타 기관", "확인 글": "확인함", "칸 글": "칸 값" };
  const t = studioOf(raw(blocks), new Map());
  const r = ok(generateFromTemplate(bytes, t, record, undefined, () => undefined));
  assert.equal(r.ledger, undefined);
  assert.equal(r.output, "﻿# 공고 알파 공고\r\n\r\n자격 1 베타 기관\r\n\r\n자격 2 & <참고>\r\n\r\n본문 베타 기관 안내.\r\n\r\n| 항목 | 값 |\r\n|---|---|\r\n| 칸 값 | 베타 기관 |\r\n\r\n마지막 줄 확인함.\r\n");
  assert.deepEqual(r.report.moves.map((m) => [m.from, m.to, m.count]), [[1, 1, 2], [3, 3, 0]]);
  assert.deepEqual(r.report.dropped.map((d) => [d.place, d.code]), [["p4", "PLACE_COVERED"]]);
  assert.ok(bytesEqual(new TextEncoder().encode(ok(generateFromTemplate(bytes, t, record, undefined, () => undefined)).output as string), new TextEncoder().encode(r.output as string)));
  // 원본 해시, 미등록 {{ }}
  assert.deepEqual(failCodes(generateFromTemplate(new TextEncoder().encode(md.replace("﻿", "")), t, record, undefined, () => undefined)), ["TPL_SOURCE_MISMATCH"]);
  const extra = [{ ...at(blocks, 0), content: { text: "자격 {{ 없는 키 }}" } }, at(blocks, 1)];
  assert.deepEqual(failCodes(generateFromTemplate(bytes, studioOf(raw(extra), new Map()), record, undefined, () => undefined)), ["PLACE_UNREGISTERED"]);
  const kept = ok(generateFromTemplate(bytes, studioOf(raw(extra, { unregistered: "keep" }), new Map()), record, undefined, () => undefined));
  assert.ok((kept.output as string).includes("자격 {{ 없는 키 }}"));
});

// ── 무작위 ─────────────────────────────────────────────────────

test("무작위 60회(시드 고정): 블록 선택·범위 위치·값 길이(0~1,500자)·후처리를 바꿔도 성공, 결정성, 검사기 새 오류 0, 이동표 정합, 범위 밖 글 보존", () => {
  const k = kit();
  const base = validateDocument(k.bytes);
  const original = at(k.doc.sections, 0).paragraphs;
  const next = rng(2024);
  const pick = <T>(list: readonly T[]): T => at(list, Math.floor(next() * list.length));
  let covered = 0;
  let checked = 0;
  for (let round = 0; round < 60; round++) {
    // 본문 17~46에서 서로 겹치지 않고 줄 33(s4)을 피하는 범위 셋, 칸 [12, 1]에서 범위 하나
    const spans: [number, number][] = [];
    while (spans.length < 3) {
      const from = 17 + Math.floor(next() * 28);
      const to = Math.min(46, from + Math.floor(next() * 4));
      if (from <= 33 && 33 <= to) continue;
      if (spans.some(([a, b]) => from <= b && a <= to)) continue;
      spans.push([from, to]);
    }
    const cellFrom = 1 + Math.floor(next() * 5);
    const cellTo = cellFrom + Math.floor(next() * (6 - cellFrom));
    const unwrap = next() < 0.5;
    const preview = next() < 0.5;
    const t = withRaw(k, (raw) => {
      const anchors = raw["anchors"] as { id: string }[];
      const replace = (id: string, a: unknown): void => void anchors.splice(anchors.findIndex((x) => x.id === id), 1, a as { id: string });
      replace("a1", range(k.doc, "a1", ...at(spans, 0)));
      replace("a2", range(k.doc, "a2", ...at(spans, 1)));
      replace("a3", range(k.doc, "a3", ...at(spans, 2)));
      replace("a4", range(k.doc, "a4", cellFrom, cellTo, [12, 1]));
      raw["options"] = { ...raw["options"], unwrapFilled: unwrap, refreshPreview: preview };
    });
    const record = recordFor(randomText(next), { price: pick([1, 60000000, 120000000]), sme: pick(["Y", "N"]) });
    const c = caseOf(t, record, { selections: { s2: manual(t, "s2", pick(["b3", "b4"])) }, ...(next() < 0.3 ? { blockEdits: { b7: { text: `끝 {{사업명}} 수정 ${round}` } } } : {}) });
    const r = ok(generateFromTemplate(k.bytes, t, record, c, loaderOf(k.blobs)));
    const again = ok(generateFromTemplate(k.bytes, t, record, c, loaderOf(k.blobs)));
    assert.ok(bytesEqual(out(r), out(again)) && JSON.stringify(r.ledger) === JSON.stringify(again.ledger), `${round}회: 결정성`);
    const doc = reparse(out(r));
    assert.deepEqual(newErrorsAfter(base, validateDocument(out(r))).map((v) => v.code), [], `${round}회: 새 오류`);
    // 이동표: 슬롯 앵커마다 항목 하나, 문서 순서
    const moves = r.report.moves;
    assert.equal(moves.length, 5);
    assert.deepEqual(moves.filter((m) => m.parentPath.length === 0).map((m) => m.from), [...spans.map(([a]) => a), 33].sort((a, b) => a - b));
    // 범위 밖 최상위 문단(필드·자리가 없는 것)은 옮긴 자리에 같은 글(본문 {{기관명}}·{{사업명}}은 값)
    for (let i = 1; i < original.length; i++) {
      const m = remapAddress(moves, { sectionIndex: 0, path: [i] });
      const text = at(original, i).logicalText;
      if (m === undefined) {
        covered++;
        continue;
      }
      if (text.includes("￼") || [11, 14, 42, 44, 57, 60, 19, 22].includes(i)) continue;
      const expected = text.replace(/\{\{(기관명|사업명)\}\}/g, (_x, key: string) => String(record[key]));
      assert.equal(paragraphAt(doc, m.path).logicalText, expected, `${round}회: 원본 문단 ${i}`);
      checked++;
    }
    // 덮인 자리는 PLACE_COVERED, 나머지 낱말·줄 자리는 채워졌다
    const coveredPlaces = new Set(r.report.dropped.map((d) => d.place));
    for (const [place, path, name] of [["p34", [44], "낱말 범위 뒤"], ["p35", [19], "낱말 범위 안"], ["p38", [42], "줄 범위 뒤"], ["p39", [22], "줄 범위 안"]] as const) {
      const m = remapAddress(moves, { sectionIndex: 0, path: [...path] });
      assert.equal(m === undefined, coveredPlaces.has(place), `${round}회: ${place}`);
      if (m !== undefined) assert.ok(paragraphAt(doc, m.path).logicalText.includes(String(record[name])), `${round}회: ${place} 값`);
    }
    if (unwrap) assert.ok(r.report.postprocess.unwrapped > 0);
    assert.equal(r.report.postprocess.preview, preview);
  }
  assert.ok(covered > 60 && checked > 1000, `덮인 문단 ${covered}, 확인한 문단 ${checked}`);
});
