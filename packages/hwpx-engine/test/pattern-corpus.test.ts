// 패턴(7.10, #20)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글은 기록하지 않는다: 진단에는 경로 해시 앞 10자, 꼴 이름, 수량만 남긴다. 결과 파일을 쓰지 않는다(모두 메모리).
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/pattern-corpus.test.ts
// 문서마다 1단계·2단계 본문 제목(최상위, 번호 글자 있는 꼴) 하나씩으로 패턴을 만들어:
// (1) match = [marker]의 제안 = 그 문서에서 같은 꼴·단계인 본문 제목(표 칸 밖, `라벨:` 꼴 아님) − 원점(주소까지 같음), 초안은 모두 headingRange,
// (2) 기본 match(꼴·단계·굵기·크기)의 제안은 (1)의 부분집합(같은 패턴 수를 보고),
// (3) 제안 하나를 rejected에 넣으면 그 글 해시의 문단만 빠지고 나머지는 그대로, (4) 다시 읽은 문서에서 같은 결과(결정성).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sameSnapshot, scanCorpus, snapshotOf } from "../../../tools/stress/corpus.ts";
import { isTableNode, openPackage, parseDocument, type HwpxDocument } from "../src/index.ts";
import { detectHeadings, patternOf, rejectSuggestion, suggestSimilar, type Heading, type Pattern, type Suggestion } from "../src/fill/index.ts";
import { isLabelColon } from "../src/fill/candidates.ts";
import { paragraphAtPath } from "../src/fill/doc.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;

function parse(bytes: Uint8Array): HwpxDocument | undefined {
  try {
    return parseDocument(openPackage(bytes));
  } catch {
    return undefined;
  }
}

/** 제목이 표 칸 안 목록에 있는가(그 목록이 상위 문단의 표 칸이다) */
function inTableCell(doc: HwpxDocument, h: Heading): boolean {
  if (h.at.parentPath.length === 0) return false;
  const section = doc.sections[h.at.sectionIndex];
  const owner = section === undefined ? undefined : paragraphAtPath(section, h.at.parentPath.slice(0, -1));
  const sub = owner?.subLists[h.at.parentPath[h.at.parentPath.length - 1] ?? -1];
  return owner?.objects.some((o) => isTableNode(o) && o.cells.some((c) => c.subList === sub)) ?? false;
}

const addr = (h: Heading) => ({ sectionIndex: h.at.sectionIndex, path: [...h.at.parentPath, h.index] });
const key = (a: { sectionIndex: number; path: number[] }): string => `${a.sectionIndex}|${a.path.join(",")}`;

test("7.10 실제 공고서: 1·2단계 본문 제목 하나의 패턴 → 제안 = 같은 꼴·단계 본문 제목 − 1(match marker), 기본 match는 그 부분집합, rejected 1건 뒤 나머지 유지, 결정성", { skip: SKIP }, (t) => {
  assert.ok(typeof DIR === "string");
  const files = scanCorpus(DIR).filter((f) => f.size <= MAX_BYTES);
  const before = snapshotOf(scanCorpus(DIR));
  let docs = 0;
  let unreadable = 0;
  let checked = 0;
  let rejectChecks = 0;
  let defaultEqual = 0;
  let suggestions = 0;
  const noOrigin = { 1: 0, 2: 0 };
  const rows: string[] = [];
  const started = Date.now();
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(f.abs));
    const doc = parse(bytes);
    if (doc === undefined) {
      unreadable++;
      continue;
    }
    docs++;
    const heads = detectHeadings(doc);
    const colon = (h: Heading): boolean => {
      const section = doc.sections[h.at.sectionIndex];
      const p = section === undefined ? undefined : paragraphAtPath(section, addr(h).path);
      return p !== undefined && isLabelColon(p);
    };
    const body = heads.filter((h) => !inTableCell(doc, h) && !colon(h));
    const cells: string[] = [];
    for (const level of [1, 2] as const) {
      const origin = body.find((h) => h.at.parentPath.length === 0 && h.marker.level === level && h.marker.form !== "none");
      if (origin === undefined) {
        noOrigin[level]++;
        cells.push(`${level}단계 없음`);
        continue;
      }
      const at = addr(origin);
      const p = patternOf(doc, at);
      assert.ok(p !== undefined, `${f.id}: 패턴`);
      assert.deepEqual([p.marker, p.place, p.match], [origin.marker, "body", ["marker", "bold", "height"]], `${f.id}: ${level}단계 패턴의 꼴·자리·기본 match`);
      const markerOnly: Pattern = { ...p, match: ["marker"] };
      const got = suggestSimilar(doc, markerOnly, { origin: at });
      const same = body.filter((h) => h.marker.form === origin.marker.form && h.marker.level === origin.marker.level && key(addr(h)) !== key(at));
      assert.deepEqual(got.map((s) => key(s.at)), same.map((h) => key(addr(h))), `${f.id}: ${level}단계 제안(같은 꼴·단계 ${same.length + 1}개 − 1)`);
      assert.ok(got.every((s) => s.draft.kind === "headingRange"), `${f.id}: 초안 종류`);
      const byDefault = suggestSimilar(doc, p, { origin: at });
      const gotKeys = new Set(got.map((s) => key(s.at)));
      assert.ok(byDefault.every((s) => gotKeys.has(key(s.at))), `${f.id}: 기본 match는 부분집합`);
      if (byDefault.length === got.length) defaultEqual++;
      // 해제 1건: 그 글 해시의 문단만 빠진다
      const first: Suggestion | undefined = got[0];
      if (first !== undefined) {
        const after = suggestSimilar(doc, rejectSuggestion(markerOnly, first), { origin: at });
        const kept = got.filter((s) => s.sha256 !== first.sha256);
        // 실패 메시지에 문서 글이 나오지 않도록 주소·개수만 비교하고, 전체 같음은 참·거짓으로만 본다
        assert.deepEqual(after.map((s) => key(s.at)), kept.map((s) => key(s.at)), `${f.id}: 해제 뒤 나머지 유지`);
        assert.ok(JSON.stringify(after) === JSON.stringify(kept), `${f.id}: 해제 뒤 제안 내용 같음`);
        rejectChecks++;
      }
      // 결정성: 다시 읽은 문서
      const again = parse(bytes);
      assert.ok(again !== undefined);
      const repeat = suggestSimilar(again, markerOnly, { origin: at });
      assert.deepEqual(repeat.map((s) => key(s.at)), got.map((s) => key(s.at)), `${f.id}: 결정성(주소)`);
      assert.ok(JSON.stringify(repeat) === JSON.stringify(got), `${f.id}: 결정성(내용)`);
      checked++;
      suggestions += got.length;
      cells.push(`${level}단계 ${origin.marker.form} 제목 ${same.length + 1}개 → 제안 ${got.length}(기본 match ${byDefault.length})`);
    }
    rows.push(`${f.id}: ${cells.join(", ")}`);
  }
  const after = snapshotOf(scanCorpus(DIR));
  t.diagnostic(`문서 ${docs}건(읽을 수 없음 ${unreadable}), 패턴 ${checked}개(1단계 없음 ${noOrigin[1]}, 2단계 없음 ${noOrigin[2]}), 제안 ${suggestions}개, 기본 match(marker·bold·height)가 '같은 꼴·단계 제목 − 1'과 같은 패턴 ${defaultEqual}/${checked}, 해제 확인 ${rejectChecks}, ${Date.now() - started}ms, 문서 모음 그대로 ${sameSnapshot(before, after)}`);
  for (const r of rows) t.diagnostic(r);
  assert.ok(docs >= 10, `읽은 문서 ${docs}건`);
  assert.ok(checked >= docs, `패턴 ${checked}개`);
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
});
