// V1(시험 문서 전부 열기)와 V2(전수 대조): 모든 쪽의 문서 좌표 있는 런 → 엔진 주소 → 런의 글 = 엔진 논리 텍스트의 그 자리.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ViewerError, openDocument, toViewerError } from "../src/rhwp/index.ts";
import { RUN_CLASSES, checkDocument, mergeReports, newReport, silentTotal, type DocReport } from "../tools/verify.ts";
import { ensureRhwp, fixtureNames, parse, readFixture, syntheticDocs } from "./helpers.ts";

before(ensureRhwp);

test("V1: 저장소 시험 문서 전부를 rhwp와 엔진 양쪽으로 열고, 못 여는 문서는 없다", () => {
  const names = fixtureNames();
  assert.equal(names.length, 31, "시험 문서 수가 달라졌다(이 시험의 기대 수량을 함께 확인한다)");
  const failures: Record<string, number> = {};
  for (const name of names) {
    const bytes = readFixture(name);
    parse(bytes);
    const doc = openDocument(bytes);
    try {
      assert.ok(doc.pageCount() >= 1, `${name}: 쪽이 없다`);
      const info = doc.pageInfo(0);
      assert.ok(info.width > 0 && info.height > 0);
      assert.ok(doc.pageSvg(0).startsWith("<svg"), `${name}: 쪽 SVG가 아니다`);
    } catch (e) {
      const code = e instanceof ViewerError ? e.code : "UNKNOWN";
      failures[code] = (failures[code] ?? 0) + 1;
    } finally {
      doc.free();
    }
  }
  assert.deepEqual(failures, {}, "못 연 문서의 사유별 수량");
});

test("V1: 열 수 없는 입력은 ViewerError(코드)로 알린다", () => {
  const code = (f: () => unknown): string | undefined => {
    try {
      f();
    } catch (e) {
      return e instanceof ViewerError ? e.code : `비ViewerError:${String(e)}`;
    }
    return undefined;
  };
  assert.equal(code(() => openDocument(new Uint8Array(0))), "VIEWER_OPEN_EMPTY_FILE");
  assert.equal(code(() => openDocument(new Uint8Array([1, 2, 3, 4, 5]))), "VIEWER_OPEN_UNSUPPORTED_FILE_FORMAT");
  const good = readFixture("D1");
  assert.equal(code(() => openDocument(good.slice(0, good.length >> 1))), "VIEWER_OPEN_UNSUPPORTED_FILE_FORMAT");
  // ArrayBuffer는 빈 파일 오류가 나므로 입력 단계에서 거절한다
  assert.equal(code(() => openDocument(good.buffer.slice(0, 10) as unknown as Uint8Array)), "VIEWER_BAD_INPUT");

  // 암호 문서: rhwp는 오류 코드 없이 문장만 던진다(문자열). 코드로 바꿔 알린다
  assert.equal(toViewerError("유효하지 않은 파일: 비밀번호가 필요한 암호 문서입니다 (parse_document_with_password ...)", "VIEWER_OPEN").code, "VIEWER_OPEN_PASSWORD");
  assert.equal(toViewerError("알 수 없는 문장", "VIEWER_OPEN").code, "VIEWER_OPEN");
  assert.equal(toViewerError(new RangeError("unreachable"), "VIEWER_OPEN").code, "VIEWER_RHWP_TRAP");

  const doc = openDocument(good);
  assert.equal(code(() => doc.pageSvg(99)), "VIEWER_PAGE_RANGE");
  assert.equal(code(() => doc.pageLayout(-1)), "VIEWER_PAGE_RANGE");
  doc.free();
  assert.equal(code(() => doc.pageInfo(0)), "VIEWER_CLOSED");
});

/** 보고를 시험 출력에 남기고, 모든 런이 `char`로 옮겨졌는지 본다. */
function expectAllChar(report: DocReport, label: string): void {
  assert.ok(report.engine.ok && report.rhwp.ok, `${label}: 열리지 않았다 ${JSON.stringify([report.engine, report.rhwp])}`);
  for (const c of RUN_CLASSES) {
    const s = report.classes[c];
    assert.equal(s.paragraph, 0, `${label}/${c}: 문단으로 내려간 런 ${JSON.stringify(report.reasons)}`);
    assert.equal(s.none, 0, `${label}/${c}: 옮기지 못한 런 ${JSON.stringify(report.reasons)}`);
    assert.equal(s.silent, 0, `${label}/${c}: 조용한 불일치 ${JSON.stringify(report.silentKinds)}`);
    assert.equal(s.char, s.runs);
  }
  const o = report.oracle;
  assert.equal(o.textBad, 0, `${label}: 문단 글 오라클 ${JSON.stringify(report.oracleKinds)}`);
  assert.equal(o.ctrlBad, 0, `${label}: 컨트롤 개수 오라클 ${JSON.stringify(report.oracleKinds)}`);
  assert.equal(o.tablesBad, 0, `${label}: 표 크기 오라클`);
  assert.equal(o.cellListsBad, 0, `${label}: 칸 안 문단 수 오라클`);
  assert.equal(o.errors, 0, `${label}: 오라클 호출 오류 ${JSON.stringify(report.oracleKinds)}`);
}

test("V2: 시험 문서 전부 — 본문·표 셀·중첩 표 100% char, 조용한 불일치 0, rhwp 자신의 글·컨트롤 수·표 크기와도 일치", (t) => {
  const total = newReport();
  for (const name of fixtureNames()) {
    const r = checkDocument(readFixture(name), { oracles: true });
    expectAllChar(r, name);
    mergeReports(total, r);
  }
  assert.equal(silentTotal(total), 0);
  assert.ok(total.classes.body.runs > 100 && total.classes.cell.runs > 100 && total.classes.nested.runs >= 8, `범주별 수량이 너무 적다: ${JSON.stringify(total.classes)}`);
  t.diagnostic(`시험 문서 30건: ${JSON.stringify(total.classes)} / 런 ${JSON.stringify(total.runs)} / 오라클 ${JSON.stringify(total.oracle)}`);
});

test("V2: 합성 시험 문서(탭·줄바꿈·대리쌍·글자처럼 취급 개체·누름틀·안내문·자동 번호·글상자·캡션·각주) — 모두 char, 글상자·캡션 범주 포함", (t) => {
  const total = newReport();
  for (const [name, bytes] of Object.entries(syntheticDocs())) {
    const r = checkDocument(bytes, { oracles: true });
    expectAllChar(r, name);
    mergeReports(total, r);
  }
  assert.ok(total.classes.textbox.runs >= 2, `글상자 런이 없다: ${JSON.stringify(total.classes)}`);
  assert.ok(total.classes.caption.runs >= 1, `캡션 런이 없다: ${JSON.stringify(total.classes)}`);
  assert.ok(total.classes.cell.runs >= 1);
  t.diagnostic(`합성 문서 ${Object.keys(syntheticDocs()).length}건: ${JSON.stringify(total.classes)} / 런 ${JSON.stringify(total.runs)} / 오라클 ${JSON.stringify(total.oracle)}`);
});
