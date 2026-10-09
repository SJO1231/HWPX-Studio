// 등록 안 된 입력 항목 자리(엔진 명세 8.8.12, #134): `listUnregisteredPlaces`와 2단계 생성의 `unregistered` 정책.
// 문서는 합성 공고서(메일머지·누름틀·{{ }}, 머리말·표 칸)에 누름틀 27개(이름 중복, 표 칸 포함)를 더한 것이다.
// 기대 목록은 입력 항목 전부(`inputPlaces`, #75에서 검증)에서 시험이 고른 등록 이름을 뺀 것으로 따로 계산한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listFields, validateDocument, type FieldInfo, type HwpxDocument } from "../src/index.ts";
import { inputPlaces } from "../src/fill/block-preview.ts";
import { generate, generateFromTemplate, listUnregisteredPlaces, type BlockPreviewPlace, type StudioGenerateResult } from "../src/fill/index.ts";
import { readStudioTemplate, sha256Hex, type StudioTemplate } from "../src/template/index.ts";
import { noticeKit } from "./generate-v2-helpers.ts";
import { bytesEqual, newErrorsAfter, reparse } from "./helpers.ts";
import { done, ds, fragOf, inject, KEEP, line, longValue, notice, rng, tpl } from "./range-helpers.ts";
import { docOf, paragraph, tableParagraph, textPara } from "./table-helpers.ts";

const clickBegin = (id: number, name: string): string => `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="627272811" metaTag=""/></hp:ctrl>`;
const clickEnd = (id: number): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="627272811"/></hp:ctrl>`;

let sourceCache: Uint8Array | undefined;
/** 합성 공고서 + 누름틀 27개(문단 12개에 2개씩, 표 칸에 3개. 이름 9개가 겹친다)와 표 칸의 {{ 칸 키 }} */
function source(): Uint8Array {
  if (sourceCache !== undefined) return sourceCache;
  let id = 9000;
  const click = (name: string): string => {
    const f = ++id;
    return `${clickBegin(f, name)}<hp:t>${name} 안내</hp:t>${clickEnd(f)}`;
  };
  const body = Array.from({ length: 12 }, (_, i) => paragraph(`<hp:t>추가 ${i}: </hp:t>${click(`항목${i % 6}`)}<hp:t> 그리고 &amp; &lt;끝&gt; </hp:t>${click(`항목${(i + 3) % 8}`)}`));
  const cell = (col: number, paragraphs: string[]) => ({ row: 0, col, width: 9000, height: 1000, paragraphs });
  body.push(tableParagraph({ id: "7134", rowCnt: 1, colCnt: 2, cells: [cell(0, [paragraph(click("칸 항목")), paragraph(click("항목1"))]), cell(1, [paragraph(click("칸 항목")), textPara("칸 {{ 칸 키 }}")])] }));
  const extra = reparse(docOf(body));
  const base = notice();
  sourceCache = done(generate(base, tpl([line(reparse(base), "end", [62])], [inject("more", "end", fragOf(extra, 0, body.length - 1), "after")]), ds({}), KEEP)).output;
  return sourceCache;
}

type Kind = BlockPreviewPlace["kind"];
type Spec = { kind: Kind; name: string; occurrence?: number };
const KINDS: Kind[] = ["clickHere", "mailMerge", "placeholder"];
const label = (p: { kind: Kind; name: string }): string => `${p.kind}:${p.name}`;
const nfc = (s: string): string => s.normalize("NFC");

/** 자리 명세로 2판 템플릿(값은 이름마다 하나, text). 정책은 `options`로 준다 */
function templateOf(bytes: Uint8Array, specs: readonly Spec[], options: Record<string, unknown> = {}): StudioTemplate {
  const names = [...new Set(specs.map((s) => s.name))];
  const vid = (name: string): string => `v${names.indexOf(name) + 1}`;
  const raw = {
    schema: "hwpx-studio/template@2",
    id: "t00000134",
    version: 1,
    meta: { name: "미등록 자리(시험)" },
    source: { kind: "hwpx", sha256: sha256Hex(bytes) },
    anchors: [],
    values: names.map((name) => ({ id: vid(name), name, format: "text" })),
    bindings: names.map((name) => ({ value: vid(name), key: name })),
    places: specs.map((s, i) => ({ id: `p${i + 1}`, kind: s.kind, [s.kind === "clickHere" ? "name" : "key"]: s.name, value: vid(s.name), ...(s.occurrence === undefined ? {} : { occurrence: s.occurrence }) })),
    slots: [],
    blocks: [],
    options: { missing: "error", ...options },
  };
  const t = readStudioTemplate(JSON.stringify(raw));
  assert.ok(t.schema === "hwpx-studio/template@2");
  return t;
}

/** 종류별 이름(NFC, 정렬) */
const namesOf = (all: readonly BlockPreviewPlace[], kind: Kind): string[] => [...new Set(all.filter((p) => p.kind === kind).map((p) => p.name))].sort();
/** 기대 미등록: 입력 항목 전부에서 등록 이름(종류별, NFC)을 뺀 것 */
const expectedOf = (all: readonly BlockPreviewPlace[], specs: readonly Spec[]): BlockPreviewPlace[] => all.filter((p) => !specs.some((s) => s.kind === p.kind && nfc(s.name) === p.name));
/** 종류:이름 → 건수 */
function countsOf(list: readonly { kind: Kind; name: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of list) out.set(label(p), (out.get(label(p)) ?? 0) + 1);
  return out;
}
/** 생성 보고의 PLACE_UNREGISTERED: 종류:이름 → 메시지의 건수 */
function reported(r: StudioGenerateResult, severity: "error" | "warning"): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of r.report.issues.filter((x) => x.code === "PLACE_UNREGISTERED" && x.severity === severity)) {
    const where = i.where ?? "";
    out.set(where.startsWith("{{") ? `placeholder:${where.slice(2, -2)}` : where, Number(/ (\d+)곳/.exec(i.message)?.[1]));
  }
  return out;
}
const sorted = (m: Map<string, number>): [string, number][] => [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const inputKind = (f: FieldInfo): Kind | undefined => (f.type === "CLICK_HERE" && f.name !== "" ? "clickHere" : f.type === "MAILMERGE" && f.mergeKey !== undefined ? "mailMerge" : undefined);
const fieldName = (f: FieldInfo): string => nfc(f.type === "MAILMERGE" ? (f.mergeKey ?? "") : f.name);

function setup(): { bytes: Uint8Array; doc: HwpxDocument; all: BlockPreviewPlace[] } {
  const bytes = source();
  const doc = reparse(bytes);
  return { bytes, doc, all: inputPlaces(doc) };
}

test("#134 목록: 누름틀·메일머지·{{ }} 각 수십 개(머리말·표 칸·본문, 같은 이름 중복) 중 일부만 등록하면 나머지를 종류·이름·주소와 함께 문서 순서로 돌려준다", () => {
  const { bytes, doc, all } = setup();
  for (const kind of KINDS) assert.ok(all.filter((p) => p.kind === kind).length >= 30, `${kind} ${all.filter((p) => p.kind === kind).length}개`);
  assert.ok(all.some((p) => p.path[0] === 0 && p.path.length > 1), "머리말 자리");
  assert.ok(all.some((p) => p.kind === "clickHere" && p.path.length > 2), "표 칸 누름틀");
  // 필드 열거는 문서 모델(listFields)의 종류·이름별 수와 같다
  const modelCounts = countsOf(listFields(doc).flatMap((f) => (inputKind(f) === undefined ? [] : [{ kind: inputKind(f) as Kind, name: fieldName(f) }])));
  assert.deepEqual(sorted(countsOf(all.filter((p) => p.kind !== "placeholder"))), sorted(modelCounts));
  // 종류마다 이름을 하나 걸러 등록(종류의 첫 이름은 NFD로 적어 NFC 비교를 본다)
  const specs: Spec[] = KINDS.flatMap((kind) => namesOf(all, kind).filter((_, i) => i % 2 === 0).map((name, i) => ({ kind, name: i === 0 ? name.normalize("NFD") : name })));
  assert.ok(specs.some((s) => s.name !== nfc(s.name)), "NFD로 적은 이름");
  const got = listUnregisteredPlaces(doc, templateOf(bytes, specs));
  assert.deepEqual(got, expectedOf(all, specs));
  for (const kind of KINDS) assert.ok(got.filter((p) => p.kind === kind).length >= 10, `미등록 ${kind}`);
  assert.ok(got.some((p) => p.path[0] === 0 && p.path.length > 1) && got.some((p) => p.path.length > 2), "머리말·표 칸의 미등록");
  // 아무것도 등록하지 않으면 전부, 전부 등록하면 없음
  assert.deepEqual(listUnregisteredPlaces(doc, templateOf(bytes, [{ kind: "placeholder", name: "없는 키" }])), all);
  assert.deepEqual(listUnregisteredPlaces(doc, templateOf(bytes, KINDS.flatMap((kind) => namesOf(all, kind).map((name) => ({ kind, name }))))), []);
  // occurrence를 준 필드 자리는 그 순번 하나만 맡는다(순번은 0부터)
  const target = listFields(doc).find((f) => f.type === "CLICK_HERE" && f.name === "항목1" && f.occurrence === 2);
  assert.ok(target !== undefined);
  const key = (p: BlockPreviewPlace): string => `${p.sectionIndex}:${p.path.join(".")}:${p.start}`;
  const one = new Set(listUnregisteredPlaces(doc, templateOf(bytes, [...specs.filter((s) => s.name !== "항목1"), { kind: "clickHere", name: "항목1", occurrence: 2 }])).filter((p) => p.kind === "clickHere" && p.name === "항목1").map(key));
  const every = all.filter((p) => p.kind === "clickHere" && p.name === "항목1");
  assert.equal(one.size, every.length - 1);
  assert.deepEqual(every.filter((p) => !one.has(key(p))).map((p) => p.path), [target.path]);
});

test("#134 목록: where 자리는 원본에서 아무것도 맡지 않고(블록 교체 전 기준), occurrence 자리는 그 순번만 — 2판 생성 시험 템플릿", () => {
  const k = noticeKit();
  const got = listUnregisteredPlaces(k.doc, k.t);
  // 이 템플릿은 재공고를 where 자리(b8)로만, 사유 설명(메일머지)·이름(누름틀)을 순번 1로만 등록했다
  const want = listFields(k.doc)
    .filter((f) => (f.type === "MAILMERGE" && (f.mergeKey === "재공고" || (f.mergeKey === "사유 설명" && f.occurrence !== 1))) || (f.type === "CLICK_HERE" && f.name === "이름" && f.occurrence !== 1))
    .map((f) => `${f.type === "MAILMERGE" ? "mailMerge" : "clickHere"}:${f.mergeKey ?? f.name}@${f.path.join(".")}`);
  assert.ok(want.length >= 4 && want.some((w) => w.startsWith("mailMerge:사유 설명")) && want.some((w) => w.startsWith("clickHere:이름")));
  assert.deepEqual(got.map((p) => `${label(p)}@${p.path.join(".")}`).sort(), [...want].sort());
});

test("#134 생성: 정책 생략이면 미등록 누름틀·메일머지는 경고(종류·이름·건수)이고 그대로 둔다. error면 PLACE_UNREGISTERED로 막고(출력 없음), keep·모의 실행도 같은 경고. {{ }}는 생략이어도 막는다", () => {
  const { bytes, doc, all } = setup();
  const specs: Spec[] = [
    ...namesOf(all, "placeholder").map((name) => ({ kind: "placeholder" as const, name })),
    ...(["clickHere", "mailMerge"] as const).flatMap((kind) => namesOf(all, kind).filter((_, i) => i % 2 === 1).map((name) => ({ kind, name }))),
  ];
  const record = Object.fromEntries([...new Set(specs.map((s) => s.name))].map((name) => [name, `${name} 값 & <확인>`]));
  const want = countsOf(expectedOf(all, specs));
  assert.ok(want.size >= 10 && [...want.keys()].every((w) => !w.startsWith("placeholder:")));
  const gen = (options: Record<string, unknown>, dryRun = false): StudioGenerateResult => generateFromTemplate(bytes, templateOf(bytes, specs, options), record, undefined, () => undefined, { dryRun });

  const r = gen({});
  assert.ok(r.ok && !r.dryRun, JSON.stringify(r.report.issues.filter((i) => i.severity === "error")));
  assert.deepEqual(sorted(reported(r, "warning")), sorted(want));
  assert.deepEqual(r.report.validation?.newErrors, []);
  assert.ok(r.output instanceof Uint8Array);
  assert.deepEqual(newErrorsAfter(validateDocument(bytes), validateDocument(r.output)), []);
  // 등록한 필드는 값, 미등록 필드는 원래 글 그대로
  const before = listFields(doc).filter((f) => inputKind(f) !== undefined);
  const after = listFields(reparse(r.output)).filter((f) => inputKind(f) !== undefined);
  assert.equal(after.length, before.length);
  before.forEach((f, i) => {
    const kind = inputKind(f) as Kind;
    const registered = specs.some((s) => s.kind === kind && s.name === fieldName(f));
    assert.equal(after[i]?.valueText, registered ? record[fieldName(f)] : f.valueText, `${kind} ${i}`);
  });

  const blocked = gen({ unregistered: "error" });
  assert.equal(blocked.ok, false);
  assert.ok(!("output" in blocked));
  assert.deepEqual(sorted(reported(blocked, "error")), sorted(want));
  assert.deepEqual([...new Set(blocked.report.issues.filter((i) => i.severity === "error").map((i) => i.code))], ["PLACE_UNREGISTERED"]);

  const kept = gen({ unregistered: "keep" });
  assert.ok(kept.ok && !kept.dryRun && kept.output instanceof Uint8Array);
  assert.deepEqual(sorted(reported(kept, "warning")), sorted(want));
  assert.ok(bytesEqual(kept.output, r.output));

  const dry = gen({}, true);
  assert.ok(dry.ok && dry.dryRun);
  assert.deepEqual(sorted(reported(dry, "warning")), sorted(want));

  // 생략 정책에서 {{ }} 하나를 빼면 그 {{ }}만 오류(필드는 여전히 경고)
  const dropped = namesOf(all, "placeholder")[0] as string;
  const r2 = generateFromTemplate(bytes, templateOf(bytes, specs.filter((s) => !(s.kind === "placeholder" && s.name === dropped))), record, undefined, () => undefined);
  assert.equal(r2.ok, false);
  assert.deepEqual([...reported(r2, "error").keys()], [`placeholder:${dropped}`]);
  assert.deepEqual(sorted(reported(r2, "warning")), sorted(want));
});

test("#134 무작위 50회(시드 고정): 종류마다 등록 이름·정책·긴 값(0~1,500자)을 바꿔도 목록 = 기대, 생성 판정 = 정책, 결정성, 검사기 새 오류 0", (ctx) => {
  const { bytes, doc, all } = setup();
  const next = rng(1340);
  const before = validateDocument(bytes);
  const tally = { rounds: 0, generated: 0, blocked: 0, unregistered: 0, newErrors: 0 };
  for (let round = 0; round < 50; round++) {
    const specs: Spec[] = KINDS.flatMap((kind) => namesOf(all, kind).filter(() => next() < 0.5).map((name) => ({ kind, name })));
    const policy = (["omit", "keep", "error"] as const)[Math.floor(next() * 3)];
    const t = templateOf(bytes, specs, policy === "omit" ? {} : { unregistered: policy });
    const want = expectedOf(all, specs);
    assert.deepEqual(listUnregisteredPlaces(doc, t), want, `${round}회 목록`);
    tally.rounds++;
    tally.unregistered += want.length;
    const record = Object.fromEntries([...new Set(specs.map((s) => s.name))].map((name) => [name, longValue(next, 0, 1500)]));
    const r = generateFromTemplate(bytes, t, record, undefined, () => undefined);
    // 막는 것: error면 미등록 전부, 생략이면 {{ }}만(필드는 경고). keep은 막지 않는다
    const blocking = policy === "error" ? want : policy === "omit" ? want.filter((p) => p.kind === "placeholder") : [];
    const warned = want.filter((p) => !blocking.includes(p));
    assert.deepEqual(sorted(reported(r, "error")), sorted(countsOf(blocking)), `${round}회 오류`);
    assert.deepEqual(sorted(reported(r, "warning")), sorted(countsOf(warned)), `${round}회 경고`);
    if (blocking.length > 0) {
      assert.equal(r.ok, false, `${round}회`);
      assert.ok(!("output" in r));
      tally.blocked++;
      continue;
    }
    assert.ok(r.ok && !r.dryRun && r.output instanceof Uint8Array, `${round}회: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code))}`);
    const again = generateFromTemplate(bytes, t, record, undefined, () => undefined);
    assert.ok(again.ok && !again.dryRun && again.output instanceof Uint8Array && bytesEqual(again.output, r.output) && JSON.stringify(again.ledger) === JSON.stringify(r.ledger), `${round}회 결정성`);
    tally.newErrors += newErrorsAfter(before, validateDocument(r.output)).length + (r.report.validation?.newErrors.length ?? 0);
    tally.generated++;
  }
  ctx.diagnostic(`자리 ${all.length}(누름틀 ${all.filter((p) => p.kind === "clickHere").length}·메일머지 ${all.filter((p) => p.kind === "mailMerge").length}·{{ }} ${all.filter((p) => p.kind === "placeholder").length}), ${JSON.stringify(tally)}`);
  assert.equal(tally.newErrors, 0, JSON.stringify(tally));
  assert.ok(tally.generated >= 10 && tally.blocked >= 10, JSON.stringify(tally));
});
