// 시작·끝 깃발(#74)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글은 기록하지 않는다: 진단에는 경로 해시 앞 10자와 수량·코드만 남기고, 문서 글이 실패 메시지에 나오지 않도록 참·거짓으로만 비교한다. 결과 파일을 쓰지 않는다.
//   HWPX_CORPUS_DIR=<폴더> node --test packages/viewer/test/flags-corpus.test.ts
// 문서마다 탐지된 제목(detectHeadings) 전부에서 시작 깃발 = 제목 문단의 점, 끝 깃발 = 그 제목 범위(headingRangeOf)의 끝 문단의 점(쪽 글자 배치의 런에서 얻는다. 런이 없으면 문단 처음).
// (1) 초안 일치: 응답이 같은 범위의 range 초안(makeRangeAnchor)과 headingRange 초안(makeHeadingRangeAnchor)이고 두 지문이 같으며, 역순 깃발·같은 점의 끌기(두 문단이 다를 때)와 같다.
//     두 깃발 가운데 하나라도 점이 없으면(머리말·꼬리말·각주처럼 rhwp 위치로 옮길 수 없는 문단) "깃발 불가"로 따로 센다.
// (2) 생성: 문서마다 일치한 제목 범위 가운데 바꾸거나 지울 수 있는 것(구역 설정 문단이 없고 누름틀 짝을 자르지 않음) 4곳을 깃발 초안(range·headingRange 번갈아)으로
//     바꾸기(같은 문서의 다른 제목 범위 조각)·지우기 → 생성 성공, 게이트·검사기 새 오류 0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { sameSnapshot, scanCorpus, snapshotOf } from "../../../tools/stress/corpus.ts";
import {
  detectHeadings,
  extractFragment,
  generate,
  headingRangeOf,
  makeHeadingRangeAnchor,
  makeRangeAnchor,
  openPackage,
  parseDocument,
  readDataset,
  serializeFragment,
  validateDocument,
  type HwpxDocument,
  type Template,
} from "../../hwpx-engine/src/index.ts";
import { hasSecPr } from "../../hwpx-engine/src/fill/doc.ts";
import { listAtParent, splitsField } from "../../hwpx-engine/src/fill/range.ts";
import { newErrorsAfter } from "../../hwpx-engine/test/helpers.ts";
import { locate } from "../src/host/locate.ts";
import type { AnchorDraftJson, LocatePoint, LocateResponse } from "../src/host/types.ts";
import { ensureRhwp, paragraphKey, paragraphPoints } from "./helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;
const PER_DOC = 4;
const EMPTY = readDataset({});
const tpl = (anchors: unknown[], rules: unknown[]): Template => ({ schema: "hwpx-studio/template@1", anchors, rules, options: { missing: "keep" } }) as Template;

/** 깃발로 고른 제목 범위 하나 */
type Picked = { sectionIndex: number; parentPath: number[]; from: number; to: number; response: LocateResponse; /** 부모 목록의 문단 수 */ size: number };

/** 범위를 바꾸거나 지울 수 있는가: 구역 설정 문단이 없고 누름틀 짝을 자르지 않는다 */
function replaceable(doc: HwpxDocument, s: Picked): boolean {
  const section = doc.sections[s.sectionIndex];
  const list = section === undefined ? undefined : listAtParent(section, s.parentPath);
  if (list === undefined) return false;
  const ps = list.slice(s.from, s.to + 1);
  return !ps.some(hasSecPr) && splitsField(ps) === undefined;
}

test("#74 실제 공고서: 제목 범위 깃발 지정의 초안 일치율(range·headingRange 초안, 역순·끌기와 같음), 깃발 초안으로 바꾸기·지우기 → 게이트·검사기 새 오류 0", { skip: SKIP }, async (t) => {
  assert.ok(typeof DIR === "string");
  await ensureRhwp();
  const files = scanCorpus(DIR).filter((f) => f.size <= MAX_BYTES);
  const before = snapshotOf(scanCorpus(DIR));
  const totals = { docs: 0, unreadable: 0, headings: 0, noPoint: 0, placeable: 0, fromRun: 0, matched: 0, dragCompared: 0, singleParagraph: 0, generated: 0, replaced: 0, deleted: 0 };
  const mismatches: string[] = [];
  const failures: string[] = [];
  const perDoc: string[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(f.abs));
    let doc: HwpxDocument;
    let points: Map<string, LocatePoint[]>;
    try {
      doc = parseDocument(openPackage(bytes));
      points = paragraphPoints(bytes, doc);
    } catch {
      totals.unreadable++;
      continue;
    }
    totals.docs++;
    const headings = detectHeadings(doc);
    const picked: Picked[] = [];
    let docNoPoint = 0;
    for (const h of headings) {
      totals.headings++;
      const span = headingRangeOf(doc, h.at, h.index);
      const { sectionIndex, parentPath } = h.at;
      if (span === undefined) {
        mismatches.push(`${f.id}:${h.marker.form}:NO_RANGE`);
        continue;
      }
      const starts = points.get(paragraphKey(sectionIndex, [...parentPath, span.from]));
      const ends = points.get(paragraphKey(sectionIndex, [...parentPath, span.to]));
      const p = starts?.[0];
      const q = ends?.[ends.length - 1];
      if (p === undefined || q === undefined) {
        totals.noPoint++;
        docNoPoint++;
        continue;
      }
      totals.placeable++;
      // 두 깃발 모두 쪽 글자 배치의 런에서 얻은 점인가(아니면 옮겨지는 런이 없는 문단 처음의 위치)
      if (p.shown !== undefined && q.shown !== undefined) totals.fromRun++;
      const r = locate(doc, { flags: { start: p, end: q } });
      const range = makeRangeAnchor(doc, sectionIndex, parentPath, span.from, span.to);
      const heading = makeHeadingRangeAnchor(doc, sectionIndex, parentPath, h.index);
      const { trail: _trail, ...rest } = r;
      const want = {
        precision: "paragraph",
        address: { sectionIndex, path: [...parentPath, span.from] },
        span: { sectionIndex, parentPath, from: span.from, to: span.to },
        edge: "start",
        drafts: [{ anchor: range }, { anchor: heading }],
      };
      const checks: [string, boolean][] = [
        ["DRAFTS", range !== undefined && heading !== undefined && isDeepStrictEqual(rest, want)],
        ["PRINT", range !== undefined && heading !== undefined && isDeepStrictEqual(range.print, heading.print)],
        ["REVERSED", isDeepStrictEqual(locate(doc, { flags: { start: q, end: p } }), r)],
      ];
      if (span.from === span.to) totals.singleParagraph++;
      else {
        checks.push(["DRAG", isDeepStrictEqual(locate(doc, { from: p, to: q }), r)]);
        totals.dragCompared++;
      }
      const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
      if (bad.length > 0) {
        mismatches.push(`${f.id}:${h.marker.form}:${r.precision}${r.reason === undefined ? "" : `/${r.reason}`}:${bad.join("+")}`);
        continue;
      }
      totals.matched++;
      const section = doc.sections[sectionIndex];
      picked.push({ sectionIndex, parentPath, from: span.from, to: span.to, response: r, size: (section === undefined ? undefined : listAtParent(section, parentPath))?.length ?? 0 });
    }

    // (2) 생성: 바꾸거나 지울 수 있는 일치 범위 가운데 고르게 PER_DOC곳(최상위 0 문단에서 시작하는 범위는 빼고)
    const usable = picked.filter((s) => (s.parentPath.length > 0 || s.from > 0) && replaceable(doc, s));
    const chosen = Array.from({ length: Math.min(PER_DOC, usable.length) }, (_, k) => usable[Math.floor((k * usable.length) / Math.min(PER_DOC, usable.length))]).filter((s): s is Picked => s !== undefined);
    for (const [k, s] of chosen.entries()) {
      const draft = s.response.drafts[k % 2]?.anchor as AnchorDraftJson;
      // 조각은 같은 문서의 다른 제목 범위(뽑을 수 있는 첫 것)
      let fragment: unknown;
      for (const o of usable) {
        if (o === s || fragment !== undefined) continue;
        try {
          fragment = JSON.parse(serializeFragment(extractFragment(doc, { sectionIndex: o.sectionIndex, parentPath: o.parentPath, from: o.from, to: o.to })));
        } catch {
          continue;
        }
      }
      // 지우면 부모 목록이 비는 범위(칸 전체 등)와 조각이 없을 때는 각각 바꾸기·지우기만
      const whole = s.from === 0 && s.to === s.size - 1;
      const replace = fragment !== undefined && (whole || k % 2 === 0);
      if (!replace && whole) continue;
      const rule = replace ? { id: "x", do: { type: "inject", anchor: "a", position: "replace", fragment } } : { id: "x", do: { type: "delete", anchor: "a" } };
      const out = generate(bytes, tpl([{ ...draft, id: "a" }], [rule]), EMPTY);
      if (!out.ok || out.dryRun) {
        failures.push(`${f.id}:${replace ? "replace" : "delete"}:${out.report.issues.filter((i) => i.severity === "error").map((i) => i.code).join(",")}`);
        continue;
      }
      const gate = out.report.validation?.newErrors.map((v) => v.code) ?? ["NO_VALIDATION"];
      const fresh = newErrorsAfter(validateDocument(bytes), validateDocument(out.output)).map((v) => v.code);
      if (gate.length > 0 || fresh.length > 0) failures.push(`${f.id}:${replace ? "replace" : "delete"}:${[...gate, ...fresh].join(",")}`);
      else {
        totals.generated++;
        if (replace) totals.replaced++;
        else totals.deleted++;
      }
    }
    perDoc.push(`${f.id} 제목 ${headings.length}·깃발 불가 ${docNoPoint}·일치 ${picked.length}·생성 ${chosen.length}`);
  }
  const after = snapshotOf(scanCorpus(DIR));
  const rate = totals.placeable === 0 ? 0 : totals.matched / totals.placeable;
  t.diagnostic(`문서별: ${perDoc.join(", ")}`);
  t.diagnostic(`합계 ${JSON.stringify(totals)}, 일치율(깃발을 놓을 수 있는 제목 대비) ${rate.toFixed(4)}, 불일치 ${mismatches.length}건 ${mismatches.slice(0, 20).join(" ")}, 생성 실패 ${failures.length}건 ${failures.slice(0, 20).join(" ")}, 문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(totals.docs >= 10, `읽은 문서 ${totals.docs}건`);
  assert.equal(mismatches.length, 0, `불일치 ${mismatches.length}건`);
  assert.equal(failures.length, 0, `생성 실패·새 오류 ${failures.length}건`);
  assert.ok(totals.generated >= 30, `생성 ${totals.generated}회`);
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
});
