// 구역 설정(secPr) 자식 검사(엔진 명세 8.1, 이슈 #103)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글은 기록하지 않는다: 진단에는 경로 해시 앞 10자, 오류 코드, 수량만 남긴다. 변형 사본은 메모리에서만 만든다.
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/secpr-corpus.test.ts
// (1) 원본: SEC_PR_* 0(거짓 양성 0), (2) 구역 설정마다 visibility를 뺀 사본: SEC_PR_INCOMPLETE가 그 구역 파일에서 나고 그 밖의 새 오류 0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sameSnapshot, scanCorpus, snapshotOf } from "../../../tools/stress/corpus.ts";
import { compareToBaseline, openPackage, readEntry, validateDocument } from "../src/index.ts";
import { mutateEntryText } from "./helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;

test("8.1 실제 공고서: 원본은 SEC_PR_* 0, visibility를 뺀 사본은 구역마다 SEC_PR_INCOMPLETE 하나·다른 새 오류 0", { skip: SKIP }, () => {
  assert.ok(typeof DIR === "string");
  const files = scanCorpus(DIR);
  const before = snapshotOf(files);
  let documents = 0;
  let sections = 0;
  let secPrs = 0;
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(f.abs));
    const base = validateDocument(bytes);
    const own = [...base.errors, ...base.warnings].filter((i) => i.code.startsWith("SEC_PR"));
    assert.deepEqual(own.map((i) => i.code), [], `${f.id}: 원본`);
    documents++;
    const pkg = openPackage(bytes);
    for (const entry of pkg.sectionEntries) {
      const text = new TextDecoder().decode(readEntry(pkg.archive, bytes, entry));
      const n = (text.match(/<hp:secPr\b/g) ?? []).length;
      sections++;
      secPrs += n;
      if (n === 0) continue;
      const cut = mutateEntryText(bytes, entry, (t) => t.replace(/<hp:visibility\b[^>]*\/>/g, ""));
      const r = validateDocument(cut);
      const fresh = compareToBaseline(base, r).newErrors;
      assert.deepEqual(fresh.map((i) => [i.code, i.where, i.count]), [["SEC_PR_INCOMPLETE", entry, n]], `${f.id} ${entry}`);
    }
  }
  assert.ok(documents > 0);
  console.log(`실제 공고서 ${documents}건, 구역 ${sections}, 구역 설정 ${secPrs}: 원본 SEC_PR_* 0, visibility 뺀 사본 ${secPrs}개 모두 SEC_PR_INCOMPLETE`);
  assert.ok(sameSnapshot(before, snapshotOf(scanCorpus(DIR))), "문서 모음이 바뀌었다");
});
