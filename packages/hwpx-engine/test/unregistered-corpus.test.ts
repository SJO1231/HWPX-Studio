// 등록 안 된 입력 항목 자리(엔진 명세 8.8.12, #134)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글·값은 기록하지 않는다: 진단에는 경로 해시 앞 10자와 수량만 남긴다.
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/unregistered-corpus.test.ts
// 문서마다 입력 항목(누름틀·메일머지·{{ }})을 세고, 필드가 있는 문서는 ① {{ }}만 등록(값 없음, missing: keep) ② 필드 이름을 하나 걸러 더 등록(긴 값)해
// 생성한다: 미등록 필드는 정책 생략이면 경고(이름별 건수 = 목록), error면 PLACE_UNREGISTERED로 막힘, 성공 결과는 결정적이고 검사기 새 오류 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCorpusFile, sameSnapshot, scanCorpus, snapshotOf } from "../../../tools/stress/corpus.ts";
import { openPackage, parseDocument, validateDocument, type HwpxDocument } from "../src/index.ts";
import { generateFromTemplate, listUnregisteredPlaces, type BlockPreviewPlace, type StudioGenerateResult } from "../src/fill/index.ts";
import { readStudioTemplate, sha256Hex, type StudioTemplate } from "../src/template/index.ts";
import { bytesEqual, newErrorsAfter } from "./helpers.ts";
import { longValue, rng } from "./range-helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;

type Kind = BlockPreviewPlace["kind"];
type Spec = { kind: Kind; name: string };

function templateOf(bytes: Uint8Array, specs: readonly Spec[], options: Record<string, unknown> = {}): StudioTemplate {
  const names = [...new Set(specs.map((s) => s.name))];
  const vid = (name: string): string => `v${names.indexOf(name) + 1}`;
  const raw = {
    schema: "hwpx-studio/template@2",
    id: "t00000134",
    version: 1,
    source: { kind: "hwpx", sha256: sha256Hex(bytes) },
    anchors: [],
    values: names.map((name) => ({ id: vid(name), name, format: "text" })),
    bindings: names.map((name) => ({ value: vid(name), key: name })),
    places: specs.map((s, i) => ({ id: `p${i + 1}`, kind: s.kind, [s.kind === "clickHere" ? "name" : "key"]: s.name, value: vid(s.name) })),
    slots: [],
    blocks: [],
    options: { missing: "keep", ...options },
  };
  const t = readStudioTemplate(JSON.stringify(raw));
  assert.ok(t.schema === "hwpx-studio/template@2");
  return t;
}

function countsOf(list: readonly { kind: Kind; name: string }[]): [string, number][] {
  const out = new Map<string, number>();
  for (const p of list) out.set(`${p.kind}:${p.name}`, (out.get(`${p.kind}:${p.name}`) ?? 0) + 1);
  return [...out].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
function reported(r: StudioGenerateResult, severity: "error" | "warning"): [string, number][] {
  return r.report.issues
    .filter((i) => i.code === "PLACE_UNREGISTERED" && i.severity === severity)
    .map((i): [string, number] => [i.where ?? "", Number(/ (\d+)곳/.exec(i.message)?.[1])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

test("#134 실제 공고서: 입력 항목 수, 필드 문서는 {{ }}만 등록·필드 절반 등록으로 생성 → 미등록 필드 경고 = 목록, error면 막힘, 결정성·검사기 새 오류 0", { skip: SKIP }, (ctx) => {
  assert.ok(typeof DIR === "string");
  const before = snapshotOf(scanCorpus(DIR));
  const next = rng(1341);
  const tally = { docs: 0, fieldDocs: 0, generated: 0, unregisteredOnlyKeys: 0, unregisteredHalf: 0, newErrors: 0 };
  for (const f of scanCorpus(DIR).filter((x) => x.size <= MAX_BYTES)) {
    const bytes = readCorpusFile(f);
    let doc: HwpxDocument;
    try {
      doc = parseDocument(openPackage(bytes));
    } catch {
      continue;
    }
    tally.docs++;
    const all = listUnregisteredPlaces(doc, templateOf(bytes, []));
    const count = (kind: Kind): number => all.filter((p) => p.kind === kind).length;
    const line = `${f.id} 누름틀 ${count("clickHere")} 메일머지 ${count("mailMerge")} {{ }} ${count("placeholder")}`;
    const fields = all.filter((p) => p.kind !== "placeholder");
    if (fields.length === 0) {
      ctx.diagnostic(line);
      continue;
    }
    tally.fieldDocs++;
    const keys: Spec[] = [...new Set(all.filter((p) => p.kind === "placeholder").map((p) => p.name))].map((name) => ({ kind: "placeholder", name }));
    // ① {{ }}만 등록(이슈의 재현: 필드가 그대로 남는데 알림이 없던 경우)
    const onlyKeys = templateOf(bytes, keys);
    assert.deepEqual(listUnregisteredPlaces(doc, onlyKeys), fields);
    const warned = generateFromTemplate(bytes, onlyKeys, {}, undefined, () => undefined);
    assert.ok(warned.ok, `${f.id} ①: ${JSON.stringify(warned.report.issues.filter((i) => i.severity === "error").map((i) => i.code))}`);
    assert.deepEqual(reported(warned, "warning"), countsOf(fields), `${f.id} ① 경고`);
    const blocked = generateFromTemplate(bytes, templateOf(bytes, keys, { unregistered: "error" }), {}, undefined, () => undefined);
    assert.equal(blocked.ok, false);
    assert.deepEqual(reported(blocked, "error"), countsOf(fields), `${f.id} ① 막힘`);
    tally.unregisteredOnlyKeys += fields.length;
    // ② 필드 이름을 하나 걸러 더 등록하고 긴 값(0~600자, 여러 문장·줄바꿈·탭·XML 특수문자)으로 채운다
    const names = [...new Set(fields.map((p) => `${p.kind}:${p.name}`))].sort().filter((_, i) => i % 2 === 0);
    const half: Spec[] = names.map((n) => ({ kind: n.slice(0, n.indexOf(":")) as Kind, name: n.slice(n.indexOf(":") + 1) }));
    const t = templateOf(bytes, [...keys, ...half]);
    const left = fields.filter((p) => !names.includes(`${p.kind}:${p.name}`));
    assert.deepEqual(listUnregisteredPlaces(doc, t), left);
    const record = Object.fromEntries(half.map((s) => [s.name, longValue(next, 0, 600)]));
    const r = generateFromTemplate(bytes, t, record, undefined, () => undefined);
    assert.ok(r.ok && !r.dryRun && r.output instanceof Uint8Array, `${f.id} ②: ${JSON.stringify(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code))}`);
    assert.deepEqual(reported(r, "warning"), countsOf(left), `${f.id} ② 경고`);
    const again = generateFromTemplate(bytes, t, record, undefined, () => undefined);
    assert.ok(again.ok && !again.dryRun && again.output instanceof Uint8Array && bytesEqual(again.output, r.output), `${f.id} ② 결정성`);
    const newErrors = newErrorsAfter(validateDocument(bytes), validateDocument(r.output)).length + (r.report.validation?.newErrors.length ?? 0);
    tally.newErrors += newErrors;
    tally.unregisteredHalf += left.length;
    tally.generated++;
    ctx.diagnostic(`${line} | ① 미등록 필드 ${fields.length} ② 등록 이름 ${half.length} 미등록 필드 ${left.length} 새 오류 ${newErrors}`);
  }
  const after = snapshotOf(scanCorpus(DIR));
  ctx.diagnostic(`${JSON.stringify(tally)}, 문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
  assert.ok(tally.docs >= 10 && tally.fieldDocs >= 1, JSON.stringify(tally));
  assert.equal(tally.newErrors, 0);
});
