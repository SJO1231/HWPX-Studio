// M1-A·B 실제 문서 표본(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름과 내용은 기록하지 않는다: 보고서에는 경로 해시 앞 10자와 수량만 남긴다. 결과는 tools/stress/out/에만 쓴다.
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/inline-corpus.test.ts
//   HWPX_CORPUS_DIR=<폴더> HWPX_COM=1 node --test packages/hwpx-engine/test/inline-corpus.test.ts   (한컴 표본 10건 열림도)
// 표본 문서마다 누름틀·{{}}·낱말·문단·셀에 줄바꿈·탭이 든 값을 배열 데이터(3건)로 채운다: 게이트 통과, 다시 읽은 글이 값과 같음,
// 문단 수 = 원본 + 계획의 수량 예상(여러 문단에 걸친 누름틀은 문단을 합쳐 줄인다), 검사기 새 오류 0, 결정성. 한컴 표본은 결과를 한컴으로 열어 열림과 쪽 수를 본다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scanCorpus, sameSnapshot, snapshotOf } from "../../../tools/stress/corpus.ts";
import { draftAnchors, generate, generateBatch, listFields, openPackage, parseDocument, validateDocument, walkParagraphs, type BatchRecord, type HwpxDocument, type ParagraphNode } from "../src/index.ts";
import { collectFields, fieldFillBlock, censusOfDoc, type FieldTarget } from "../src/fill/index.ts";
import { lineFillBlock } from "../src/fill/text.ts";
import { paragraphAtPath, siblingsAtPath } from "../src/fill/doc.ts";
import { readTemplate } from "../src/template/index.ts";
import { newErrorsAfter } from "./helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const COM = process.env["HWPX_COM"] === "1";
const OUT_DIR = fileURLToPath(new URL("../../../tools/stress/out/", import.meta.url));
const OPEN_CHECK = fileURLToPath(new URL("../../../tools/com/open_check.py", import.meta.url));
const MAX_BYTES = 3_000_000;
const WANT_DOCS = 60;
const WANT_COM = 10;

/** 값 3건: 줄바꿈 두 줄, CRLF·탭 섞임, 10줄 */
const VALUES = ["첫 줄\n둘째 줄", "하나\r\n둘\t탭\r셋", Array.from({ length: 10 }, (_, i) => `줄 ${i + 1}`).join("\n")];
const norm = (v: string): string => v.replace(/\r\n?/g, "\n");

/** 시드 고정 난수(mulberry32) */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Place =
  | { kind: "field"; anchor: Record<string, unknown>; name: string; occurrence: number }
  | { kind: "line" | "cell"; anchor: Record<string, unknown>; sectionIndex: number; path: number[] }
  | { kind: "word"; anchor: Record<string, unknown>; sectionIndex: number; path: number[]; before: string; after: string }
  | { kind: "placeholder"; sectionIndex: number; path: number[] };

/** 문서에서 서로 다른 문단의 자리를 종류별로 하나씩 찾는다(채울 수 있는 것만). */
function findPlaces(doc: HwpxDocument): Place[] {
  const used = new Set<unknown>();
  const places: Place[] = [];
  const fields = collectFields(doc);
  const target = fields.find((t) => fieldFillBlock(t) === undefined && t.info.name !== "");
  // 채울 수 있는 여러 문단 누름틀의 시작 문단~끝 문단 범위(그 안 표의 칸 문단 포함): 이 안의 자리를 가리키는 규칙은 TPL_CONFLICT라 다른 자리로 고르지 않는다
  const merging = fields.filter((t) => t.info.shape === "crossParagraph" && t.endParagraph !== null && fieldFillBlock(t) === undefined);
  const inMergedSpan = (sectionIndex: number, par: ParagraphNode): boolean =>
    merging.some((t) => t.section.index === sectionIndex && par.element.start >= t.paragraph.element.start && par.element.end <= (t.endParagraph?.element.end ?? -1));
  if (target !== undefined) {
    used.add(target.paragraph);
    places.push({ kind: "field", anchor: { id: "f", kind: "field", name: target.info.name, occurrence: target.info.occurrence }, name: target.info.name, occurrence: target.info.occurrence });
  }
  const free = (want: (sectionIndex: number, path: number[], text: string, par: ParagraphNode) => Place | undefined): void => {
    for (const section of doc.sections) {
      for (const par of walkParagraphs(section.paragraphs)) {
        // 글 조각만 든 문단만 고른다(탭·객체가 든 문단은 채움이 그 요소를 남겨 기대 글이 값만이 아니다)
        if (used.has(par) || inMergedSpan(section.index, par) || par.fieldMarks.length > 0 || par.logicalText.length < 4 || !par.pieces.every((x) => x.kind === "text" || x.kind === "entity")) continue;
        const place = want(section.index, par.path, par.logicalText, par);
        if (place !== undefined) {
          used.add(par);
          // 셀 채움은 셀 안의 다른 문단을 비운다: 같은 셀의 문단은 다른 자리로 고르지 않는다
          if (place.kind === "cell") for (const sibling of siblingsAtPath(section, par.path) ?? []) used.add(sibling);
          places.push(place);
          return;
        }
      }
    }
  };
  const draft = (sectionIndex: number, path: number[], kind: string, start?: number) =>
    draftAnchors(doc, { sectionIndex, path, ...(start === undefined ? {} : { start }) }).find((d) => d.kind === kind && d.blocked === undefined);
  const strip = ({ blocked: _b, ...rest }: Record<string, unknown>): Record<string, unknown> => rest;

  free((s, path) => {
    if (path.length !== 3 || path[2] !== 0) return undefined;
    const d = draft(s, path, "cell");
    return d === undefined ? undefined : { kind: "cell", anchor: { id: "c", ...strip(d as Record<string, unknown>) }, sectionIndex: s, path };
  });
  free((s, path, _text, par) => {
    if (path.length !== 1 || lineFillBlock(par) !== undefined) return undefined;
    const d = draft(s, path, "line");
    return d === undefined ? undefined : { kind: "line", anchor: { id: "l", ...strip(d as Record<string, unknown>) }, sectionIndex: s, path };
  });
  free((s, path, text) => {
    const start = text.search(/\S/u);
    const d = start < 0 ? undefined : draft(s, path, "word", start);
    if (d === undefined || d.kind !== "word" || d.end - d.start < 2) return undefined;
    return { kind: "word", anchor: { id: "w", ...strip(d as Record<string, unknown>) }, sectionIndex: s, path, before: text.slice(0, d.start), after: text.slice(d.end) };
  });
  free((s, path, _text, par) => (lineFillBlock(par) === undefined && draft(s, path, "line") !== undefined ? { kind: "placeholder", sectionIndex: s, path } : undefined));
  return places;
}

const count = (xml: string, re: RegExp): number => xml.match(re)?.length ?? 0;
const occurrences = (text: string, ch: string): number => text.split(ch).length - 1;
/** 구역 원문 조각 안의 줄바꿈·탭 요소 수 */
const inlineIn = (xml: string): { breaks: number; tabs: number } => ({ breaks: count(xml, /<(?:\w+:)?lineBreak\s*\/>/g), tabs: count(xml, /<(?:\w+:)?tab\s[^>]*\/>/g) });
function inlineCounts(doc: HwpxDocument): { breaks: number; tabs: number } {
  let breaks = 0;
  let tabs = 0;
  for (const s of doc.sections) {
    const n = inlineIn(s.text);
    breaks += n.breaks;
    tabs += n.tabs;
  }
  return { breaks, tabs };
}
/** 고른 누름틀의 구간 치환(`inline`·`crossParagraph`)이 지우는 구간 안의 줄바꿈·탭 요소 수(채우면 새 값의 요소로 바뀐다) */
function removedInline(t: FieldTarget | undefined): { breaks: number; tabs: number } {
  const from = t?.paragraph.pieces[t.begin.pieceIndex]?.end;
  const to = t?.endParagraph?.pieces[t.end?.pieceIndex ?? -1]?.start;
  if (t === undefined || from === undefined || to === undefined || (t.info.shape !== "inline" && t.info.shape !== "crossParagraph")) return { breaks: 0, tabs: 0 };
  return inlineIn(t.section.text.slice(from, to));
}
/** 문단을 합치는 구간: 같은 목록(`prefix`)의 `i`번 문단부터 `j`번 문단까지가 `i`번 하나로 합쳐진다(`j - i`개가 줄어든다) */
type Merge = { sectionIndex: number; prefix: number[]; i: number; j: number };
function mergeOf(t: FieldTarget | undefined): Merge | undefined {
  const j = t?.endParagraph?.path.at(-1);
  if (t === undefined || t.info.shape !== "crossParagraph" || j === undefined) return undefined;
  return { sectionIndex: t.section.index, prefix: t.paragraph.path.slice(0, -1), i: t.paragraph.path.at(-1) ?? 0, j };
}
/** 원본의 문단 주소가 합친 뒤 문서에서 가지는 주소(합쳐진 구간 뒤의 형제 문단은 줄어든 만큼 앞당겨진다) */
const shiftedPath = (sectionIndex: number, path: number[], merge: Merge | undefined): number[] =>
  merge === undefined || merge.sectionIndex !== sectionIndex
    ? path
    : path.map((v, k) => (k % 2 === 0 && k === merge.prefix.length && merge.j < v && merge.prefix.every((x, n) => x === path[n]) ? v - (merge.j - merge.i) : v));
const bump = (m: Record<string, number>, key: string, n = 1): void => void (m[key] = (m[key] ?? 0) + n);

type DocResult = { id: string; places: string[]; records: number; ok: number; codes: string[]; skipped: string[]; problems: string[]; first?: { original: Uint8Array; output: Uint8Array } };

function processDocument(id: string, bytes: Uint8Array): DocResult | "unreadable" | "noPlaces" {
  let doc: HwpxDocument;
  try {
    doc = parseDocument(openPackage(bytes));
  } catch {
    return "unreadable";
  }
  const places = findPlaces(doc);
  if (places.length === 0) return "noPlaces";
  const result: DocResult = { id, places: places.map((p) => p.kind), records: 0, ok: 0, codes: [], skipped: [], problems: [] };
  const original = validateDocument(bytes);
  const originalParagraphs = censusOfDoc(doc).paragraphs;
  const base = inlineCounts(doc);
  const chosen = places.find((p): p is Extract<Place, { kind: "field" }> => p.kind === "field");
  const chosenTarget = chosen === undefined ? undefined : collectFields(doc).find((x) => x.info.name === chosen.name && x.info.occurrence === chosen.occurrence);
  const removed = removedInline(chosenTarget);
  const merge = mergeOf(chosenTarget);

  // 준비 단계: 문단 하나를 `앞 {{note}} 뒤`로 바꿔 문서 안 {{}} 자리를 만든다
  let source = bytes;
  const holder = places.find((p) => p.kind === "placeholder");
  const lineOfHolder = holder === undefined ? undefined : draftAnchors(doc, { sectionIndex: holder.sectionIndex, path: holder.path }).find((d) => d.kind === "line" && d.blocked === undefined);
  if (holder !== undefined && lineOfHolder !== undefined) {
    const { blocked: _b, ...anchor } = lineOfHolder as Record<string, unknown>;
    const prep = readTemplate({ schema: "hwpx-studio/template@1", anchors: [{ id: "p", ...anchor }], rules: [{ id: "prep", do: { type: "fill", anchor: "p", value: { text: "앞 {{note}} 뒤" } } }] });
    // 실제 문서에 원래 있던 {{}} 표기는 건드리지 않는다(누락 정책 keep)
    const r = generate(bytes, prep, { data: {}, derived: {} }, { missing: "keep" });
    if (r.ok && !r.dryRun) source = r.output;
    else result.problems.push("준비 단계 실패");
  }
  const placeholderActive = source !== bytes;
  const active = places.filter((p) => p.kind !== "placeholder");
  const template = readTemplate({
    schema: "hwpx-studio/template@1",
    anchors: active.map((p, i) => ({ ...("anchor" in p ? p.anchor : {}), id: `a${i}` })),
    rules: active.map((_, i) => ({ id: `r${i}`, do: { type: "fill", anchor: `a${i}`, value: { path: "v" } } })),
  });
  const datasetOf = (v: string) => ({ data: { v, note: v }, derived: {} });
  const records: BatchRecord[] = VALUES.map((v) => ({ dataset: datasetOf(v) }));
  const slots = active.length + (placeholderActive ? 1 : 0);
  // 여러 문단에 걸친 누름틀을 채우면 문단이 합쳐져 줄어든다: 줄어드는 수는 값과 무관하게 계획의 수량 예상이 알려 준다
  const probe = generate(source, template, datasetOf(VALUES[0] ?? ""), { missing: "keep" });
  const expectedParagraphs = probe.ok ? (probe.report.plan.expected["paragraphs"] ?? 0) : 0;

  for (const item of generateBatch(source, template, records, { baseName: "x", missing: "keep" })) {
    result.records++;
    for (const s of item.skipped) result.skipped.push(s.code);
    if (!item.ok || item.output === undefined) {
      result.codes.push(...item.errorCodes);
      result.problems.push(`${item.index}번 건 실패`);
      continue;
    }
    result.ok++;
    const value = VALUES[item.index - 1] ?? "";
    const v = norm(value);
    const out = parseDocument(openPackage(item.output));
    const textAt = (sectionIndex: number, path: number[]): string | undefined => {
      const section = out.sections[sectionIndex];
      return section === undefined ? undefined : paragraphAtPath(section, path)?.logicalText;
    };
    for (const p of places) {
      if (p.kind === "placeholder" && !placeholderActive) continue;
      if (p.kind === "field") {
        const f = listFields(out).find((x) => x.name === p.name && x.occurrence === p.occurrence);
        if (f?.valueText !== v) result.problems.push(`${item.index}번 건 누름틀 값이 다르다`);
      } else {
        const want = p.kind === "word" ? p.before + v + p.after : p.kind === "placeholder" ? `앞 ${v} 뒤` : v;
        if (textAt(p.sectionIndex, shiftedPath(p.sectionIndex, p.path, merge)) !== want) result.problems.push(`${item.index}번 건 ${p.kind} 글이 다르다`);
      }
    }
    if (censusOfDoc(out).paragraphs !== originalParagraphs + expectedParagraphs) result.problems.push(`${item.index}번 건 문단 수가 예상(원본 + 수량 예상)과 다르다`);
    if (newErrorsAfter(original, validateDocument(item.output)).length > 0) result.problems.push(`${item.index}번 건 검사기 새 오류`);
    const now = inlineCounts(out);
    if (now.breaks - base.breaks !== occurrences(v, "\n") * slots - removed.breaks) result.problems.push(`${item.index}번 건 줄바꿈 요소 수`);
    if (now.tabs - base.tabs !== occurrences(v, "\t") * slots - removed.tabs) result.problems.push(`${item.index}번 건 탭 요소 수`);
    if (item.index === 1) {
      result.first = { original: bytes, output: item.output };
      const again = [...generateBatch(source, template, records.slice(0, 1), { baseName: "x", missing: "keep" })][0];
      if (again?.output === undefined || !Buffer.from(again.output).equals(Buffer.from(item.output))) result.problems.push("같은 입력의 결과 바이트가 다르다");
    }
  }
  return result;
}

test("M1 실제 문서 표본: 누름틀·{{}}·낱말·문단·셀에 줄바꿈·탭 값을 배열 데이터로 채운다 — 게이트 통과, 글 일치, 문단 수 = 원본 + 수량 예상, 검사기 새 오류 0, 결정성", { skip: SKIP }, (t) => {
  assert.ok(typeof DIR === "string");
  const files = scanCorpus(DIR);
  const before = snapshotOf(files);
  const random = rng(1);
  const order = files.filter((f) => f.size <= MAX_BYTES).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j] as (typeof order)[number], order[i] as (typeof order)[number]];
  }

  const kinds: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const problems: Record<string, number> = {};
  const ids: string[] = [];
  const samples: { id: string; output: Uint8Array; original: Uint8Array }[] = [];
  let tried = 0;
  let unreadable = 0;
  let noPlaces = 0;
  let records = 0;
  let ok = 0;
  const start = performance.now();
  for (const f of order) {
    if (ids.length >= WANT_DOCS) break;
    tried++;
    const bytes = new Uint8Array(readFileSync(f.abs));
    const r = processDocument(f.id, bytes);
    if (r === "unreadable") unreadable++;
    else if (r === "noPlaces") noPlaces++;
    else {
      ids.push(r.id);
      records += r.records;
      ok += r.ok;
      for (const k of r.places) bump(kinds, k);
      for (const c of r.codes) bump(failures, c);
      for (const c of r.skipped) bump(skipped, c);
      for (const p of r.problems) bump(problems, p.replace(/^\d+번 건 /, ""));
      if (r.first !== undefined && samples.length < WANT_COM) samples.push({ id: r.id, output: r.first.output, original: r.first.original });
    }
  }
  const after = snapshotOf(scanCorpus(DIR));
  const report = {
    kind: "inline-corpus",
    seed: 1,
    corpus: { hwpxFiles: before.hwpxFiles, listDigest: before.listDigest.slice(0, 10), unchangedAfterRun: sameSnapshot(before, after) },
    tried,
    unreadable,
    noPlaces,
    documents: ids.length,
    records,
    ok,
    placeKinds: kinds,
    failureCodes: failures,
    skippedCodes: skipped,
    problems,
    sampleIds: ids,
    seconds: Math.round((performance.now() - start) / 100) / 10,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "inline-corpus.json"), `${JSON.stringify(report, null, 2)}\n`);
  t.diagnostic(`문서 ${ids.length}건(시도 ${tried}, 읽을 수 없음 ${unreadable}, 자리 없음 ${noPlaces}), 건 ${records}, 통과 ${ok}, 자리 ${JSON.stringify(kinds)}, 건너뜀 ${JSON.stringify(skipped)}, 문제 ${JSON.stringify(problems)}`);

  // 모음이 30건보다 작으면 모음 전부(3MB 이하)가 표본이어야 한다(#118: 지금 모음은 16건)
  const want = Math.min(30, order.length);
  assert.ok(ids.length >= want, `표본 문서가 ${want}건 이상이어야 한다(${ids.length})`);
  assert.ok(report.corpus.unchangedAfterRun, "읽기 전용: 문서 모음이 바뀌지 않았다");
  assert.deepEqual(failures, {}, "게이트 실패 코드");
  assert.deepEqual(problems, {}, "다시 읽은 글·문단 수(수량 예상)·검사기·결정성 문제");
  assert.equal(ok, records, "모든 건이 게이트를 통과했다");

  // 한컴 표본: 결과를 한컴으로 열어 열림과 쪽 수를 본다(원본도 같이 열어 쪽 수를 견준다. 문서는 임시 폴더에 복사해 연다)
  if (!COM) {
    t.diagnostic("한컴 표본은 HWPX_COM=1일 때만 돈다(미검증)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hwpx-inline-corpus-"));
  try {
    const result = join(dir, "result.json");
    const original = join(dir, "original.json");
    const outFiles = samples.map((s, i) => {
      const name = join(dir, `sample-${String(i + 1).padStart(2, "0")}.hwpx`);
      writeFileSync(name, s.output);
      return name;
    });
    const origFiles = samples.map((s, i) => {
      const name = join(dir, `orig-${String(i + 1).padStart(2, "0")}.hwpx`);
      writeFileSync(name, s.original);
      return name;
    });
    type Opened = { results: { file: string; opened: boolean; pages: number | null; timeout: boolean }[] };
    const open = (files: string[], out: string): Opened => {
      const r = spawnSync("python", [OPEN_CHECK, "--out", out, ...files], { encoding: "utf8", timeout: 80_000 * files.length });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(out, "utf8")) as Opened;
    };
    const opened = open(outFiles, result);
    const originals = open(origFiles, original);
    assert.equal(opened.results.length, samples.length);
    assert.ok(samples.length >= WANT_COM, `한컴 표본이 ${WANT_COM}건이어야 한다(${samples.length})`);
    const pageDiffs = opened.results.map((r, i) => (r.pages ?? -1) - (originals.results[i]?.pages ?? -1));
    const com = { samples: samples.length, opened: opened.results.filter((r) => r.opened).length, originalsOpened: originals.results.filter((r) => r.opened).length, pageDiffs };
    writeFileSync(join(OUT_DIR, "inline-corpus-com.json"), `${JSON.stringify({ ...com, sampleIds: samples.map((s) => s.id) }, null, 2)}\n`);
    t.diagnostic(`한컴 표본 ${JSON.stringify(com)}`);
    assert.equal(com.opened, samples.length, "결과가 모두 한컴에서 열려야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
