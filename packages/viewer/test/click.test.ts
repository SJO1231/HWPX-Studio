// 클릭 경로(화면 좌표 → `ViewerDocument.pick` → 서버의 `locatePicked` → 엔진 주소)가 눌린 글자를 가리키는지 본다.
// 독립 검사: 주소가 가리키는 엔진 글자를, 대응표(`offsetTable`)를 쓰지 않고 엔진 문단의 논리 텍스트를 직접 읽어 눌린 글자와 비교한다
// (글자 사각형의 왼쪽 4분의 1이면 주소 바로 뒤 글자, 오른쪽 4분의 1이면 바로 앞 글자).
// 이 시험들이 막는 결함: 위치를 rhwp의 `hitTest` 글자 순번에서 얻어 겹친 런·빈 칸 런·개체 앞뒤에서 눌린 글자가 아닌 곳을 가리키던 것.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { openPackage, readEntry, rewriteArchive } from "../../hwpx-engine/src/index.ts";
import { paragraphAtAddress, type EngineAddress } from "../src/map/index.ts";
import { openDocument, type LayoutRun, type ViewerDocument } from "../src/rhwp/index.ts";
import { checkClicks, clickAt, engineGlyphs, fillOnce, mergeClickReports, newClickReport, objectsOnlyBetween, paragraphKey, rowParagraphKeys, type ClickReport, type ClickResult } from "../tools/verify.ts";
import { FIELD_BEGIN, FIELD_END, PIC, P, R, RECT, SUBLIST, SUBP, T, TBL, ensureRhwp, fixtureNames, parse, readFixture, synth, syntheticDocs } from "./helpers.ts";

before(ensureRhwp);

/** 런 안 `i`번째 글자 사각형에서 왼쪽(`0.25`)·오른쪽(`0.75`) 4분의 1 지점 */
function spot(run: LayoutRun, i: number, quarter: number): { x: number; y: number } {
  const left = run.x + (run.charX[i] ?? 0);
  const right = run.x + (run.charX[i + 1] ?? 0);
  return { x: left + (right - left) * quarter, y: run.y + run.h / 2 };
}

/** 누른 글자 `i`(런 안 순번)에 대해 `char`로 나온 주소가 정말 그 글자 앞(왼쪽 4분의 1) 또는 뒤(오른쪽 4분의 1)인지 독립으로 확인한다. */
function expectGlyph(doc: ReturnType<typeof parse>, r: ClickResult, run: LayoutRun, i: number, quarter: number, label: string): void {
  assert.equal(r.precision, "char", `${label}: ${r.precision} ${r.reason}`);
  const address = r.address as EngineAddress;
  const paragraph = paragraphAtAddress(doc, address);
  assert.ok(paragraph !== undefined, `${label}: 주소의 문단이 없다`);
  const glyphs = engineGlyphs(paragraph);
  const offset = address.offset ?? 0;
  const found = quarter < 0.5 ? glyphs.find((g) => g.start >= offset) : [...glyphs].reverse().find((g) => g.end <= offset);
  // 눌린 글자와 주소 사이에는 객체 자리 글자(필드 표식)만 끼어야 한다(안내문 글을 건너뛴 주소가 아니다)
  if (found !== undefined) assert.ok(objectsOnlyBetween(paragraph, quarter < 0.5 ? offset : found.end, quarter < 0.5 ? found.start : offset), `${label}: 글자와 주소 사이에 글이 끼었다`);
  assert.equal(found?.glyph, Array.from(run.text)[i], `${label}: 눌린 글자 ${JSON.stringify(Array.from(run.text)[i])}가 아닌 ${JSON.stringify(found?.glyph)} (주소 ${JSON.stringify(address)})`);
}

function withDoc<V>(bytes: Uint8Array, f: (rdoc: ViewerDocument, doc: ReturnType<typeof parse>) => V): V {
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    return f(rdoc, doc);
  } finally {
    rdoc.free();
  }
}

const runWithText = (rdoc: ViewerDocument, page: number, text: string): LayoutRun => {
  const run = rdoc.pageLayout(page).runs.find((r) => r.text === text);
  assert.ok(run !== undefined, `런 ${JSON.stringify(text)}이(가) 없다`);
  return run;
};

/** 문서 하나를 눌러 보고 조용한 불일치·영역 오판이 없는지 확인한다. */
function expectCleanClicks(bytes: Uint8Array, label: string): ClickReport {
  const report = checkClicks(bytes, { pageCap: 10, runCap: 400 });
  assert.ok(report.engine.ok && report.rhwp.ok, `${label}: 열리지 않았다`);
  assert.equal(report.silent, 0, `${label}: 조용한 불일치 ${JSON.stringify(report.silentKinds)}`);
  assert.equal(report.regionBad, 0, `${label}: 영역 오판 ${JSON.stringify(report.regionKinds)}`);
  assert.equal(report.errors, 0, `${label}: 오류`);
  return report;
}

// ── D1: 눌린 글자의 근거는 hitTest가 아니라 점 아래에 그려진 런이다 ──────────────────

test("D1(a): 넓은 빈 칸 런이 이웃 칸의 글자 위에 겹쳐 있어도, 글자를 누르면 그 글자의 칸이다 (D2 3쪽 ` 추진 배경`)", () => {
  withDoc(readFixture("D2"), (rdoc, doc) => {
    const run = runWithText(rdoc, 2, " 추진 배경");
    const first = spot(run, 0, 0.25);
    // 사실: rhwp의 hitTest는 이 점에서 이웃 칸(빈 칸 런이 덮은 칸)의 문단을 가리킨다 — 이 시험이 막는 결함의 근거
    const raw = rdoc.hit(2, first.x, first.y);
    assert.equal(raw.position?.cellPath?.[0]?.cellIndex, 1, `hitTest가 이웃 칸을 가리키지 않는다: ${JSON.stringify(raw)}`);
    const left = clickAt(rdoc, doc, 2, first.x, first.y);
    expectGlyph(doc, left, run, 0, 0.25, "첫 글자 왼쪽");
    assert.equal(paragraphAtAddress(doc, left.address as EngineAddress)?.logicalText, " 추진 배경", "눌린 칸의 문단");
    assert.equal(left.address?.offset, 0);
    const n = Array.from(run.text).length;
    const end = spot(run, n - 1, 0.75);
    const last = clickAt(rdoc, doc, 2, end.x, end.y);
    expectGlyph(doc, last, run, n - 1, 0.75, "마지막 글자 오른쪽");
    assert.equal(last.address?.offset, n);
    // 빈 칸 런이 덮은 자리 자체(글자 없는 칸)는 글자 위치를 내지 않는다
    const emptyCell = rdoc.pageLayout(2).runs.find((r) => r.text === "" && r.cellPath?.[0]?.cellIndex === 1 && r.parentParaIdx === 22);
    assert.ok(emptyCell !== undefined);
    const blank = clickAt(rdoc, doc, 2, emptyCell.x + 1, emptyCell.y + emptyCell.h / 2);
    assert.notEqual(blank.precision, "char", "글자가 없는 칸을 눌러 글자 위치가 나오면 안 된다");
  });
});

/** 표를 글 앞·뒤에 놓는(글과 겹쳐 그려지는) 높은 표 */
const floatingTable = (wrap: "BEHIND_TEXT" | "IN_FRONT_OF_TEXT"): string =>
  TBL([[SUBP("표 칸 글")]], "0")
    .replace('textWrap="TOP_AND_BOTTOM"', `textWrap="${wrap}"`)
    .replaceAll('height="1000"', 'height="20000"');

for (const wrap of ["BEHIND_TEXT", "IN_FRONT_OF_TEXT"] as const) {
  test(`D1(b): ${wrap} 표(높이 20000)가 뒤 문단 글 위에 깔려도, 본문 글자를 누르면 본문 글자이고 표 칸 글을 누르면 표 칸이다`, () => {
    const bytes = synth([P(R(floatingTable(wrap))), P(R(T("둘째 본문 글"))), P(R(T("셋째 본문 글")))]);
    withDoc(bytes, (rdoc, doc) => {
      const body = runWithText(rdoc, 0, "둘째 본문 글");
      // 사실: hitTest는 본문 글자 위에서 표 칸 문단을 가리킨다
      const probe = spot(body, 1, 0.25);
      const raw = rdoc.hit(0, probe.x, probe.y);
      assert.ok(raw.position?.cellPath !== undefined, `hitTest가 표 칸을 가리키지 않는다: ${JSON.stringify(raw)}`);
      for (const text of ["둘째 본문 글", "셋째 본문 글"]) {
        const run = runWithText(rdoc, 0, text);
        for (let i = 0; i < Array.from(text).length; i++) {
          if (text[i] === " ") continue;
          for (const q of [0.25, 0.75]) {
            const p = spot(run, i, q);
            const r = clickAt(rdoc, doc, 0, p.x, p.y);
            expectGlyph(doc, r, run, i, q, `${wrap} ${text}[${i}] ${q}`);
            assert.equal(r.address?.path.length, 1, "본문 문단이다(표 칸 [..., 0, 0]이 아니다)");
            assert.equal(paragraphAtAddress(doc, r.address as EngineAddress)?.logicalText, text);
          }
        }
      }
      const cell = runWithText(rdoc, 0, "표 칸 글");
      const at = spot(cell, 1, 0.25);
      const inCell = clickAt(rdoc, doc, 0, at.x, at.y);
      expectGlyph(doc, inCell, cell, 1, 0.25, "표 칸 글");
      assert.deepEqual(inCell.address?.path, [1, 0, 0]);
      assert.deepEqual(inCell.trail, ["tbl"]);
      // 도구의 전수 눌러 보기도 조용한 불일치가 없다
      expectCleanClicks(bytes, wrap);
    });
  });
}

const TAB = (type: string): string => `<hp:t><hp:tab width="9000" leader="0" type="${type}"/></hp:t>`;

test("D1(c): 글자처럼 취급 개체 + 오른쪽 탭 + 글자 모양이 다른 한 자리 숫자 런 + 빈 런 — 모든 글자의 왼쪽·오른쪽 4분의 1이 그 글자를 가리킨다", () => {
  const box = RECT(SUBLIST(SUBP("박스")), "1");
  const variants: Record<string, string> = {
    "사각형·탭·숫자·빈 run": P(R(box + TAB("1")) + R(T("5"), "7") + `<hp:run charPrIDRef="0"/>`),
    "사각형·탭·숫자·빈 t": P(R(box + TAB("1")) + R(T("5"), "7") + R(T(""))),
    "글 뒤 사각형·탭·숫자": P(R(T("가") + box + TAB("1")) + R(T("5"), "7") + `<hp:run charPrIDRef="0"/>`),
    "그림·탭·숫자": P(R(PIC("1") + TAB("1")) + R(T("5"), "7") + `<hp:run charPrIDRef="0"/>`),
    "사각형·글·탭·글·숫자": P(R(box + T("가나") + TAB("1") + T("다라")) + R(T("56"), "7") + R(T("나"))),
    "그림 둘 사이 글자 모양 다른 런": P(R(T("가") + PIC("1") + T("나다") + PIC("1") + T("라")) + R(T("마바"), "7") + R(T("사"))),
    "글머리 글 + 글자 모양 다른 숫자 런": P(R(T("○ 가나 ")) + R(T(" 5"), "7")),
  };
  let char = 0;
  for (const [name, paragraph] of Object.entries(variants)) {
    const bytes = synth([paragraph]);
    const report = expectCleanClicks(bytes, name);
    char += report.byKind.glyph.char;
    withDoc(bytes, (rdoc, doc) => {
      // 눌린 글자를 직접 확인한다(검사 도구와 별개로)
      for (const run of rdoc.pageLayout(0).runs) {
        if (run.paraIdx !== 1 || run.text === "") continue;
        for (let i = 0; i < Array.from(run.text).length; i++) {
          if ((run.charX[i + 1] ?? 0) - (run.charX[i] ?? 0) < 0.5) continue;
          for (const q of [0.25, 0.75]) {
            const p = spot(run, i, q);
            const r = clickAt(rdoc, doc, 0, p.x, p.y);
            if (r.precision === "char") expectGlyph(doc, r, run, i, q, `${name} ${JSON.stringify(run.text)}[${i}] ${q}`);
            else assert.ok(r.reason !== undefined, `${name}: char가 아니면 사유가 있어야 한다`);
          }
        }
      }
    });
  }
  assert.ok(char > 40, `눌러 본 글자가 너무 적다: ${char}`);
});

test("D1(d): 긴 문단(줄 배치 정보 없음)에 글자처럼 취급 글상자·그림이 있어도, 둘째 줄의 글자를 누르면 그 글자이고 개체 안 글자와 겹친 글자는 char가 아니다", () => {
  const filler = "가나다라마바사아자차카타파하 ".repeat(6);
  for (const [name, object] of [["글상자", RECT(SUBLIST(SUBP("박스")), "1")], ["그림", PIC("1")]] as const) {
    const bytes = synth([P(R(T(filler) + object + T(filler)))]);
    const report = expectCleanClicks(bytes, name);
    assert.ok(report.byKind.glyph.char > 20, `${name}: ${JSON.stringify(report.byKind)}`);
    if (name === "글상자") {
      // 사실: 둘째 줄 이후의 글자 위에서 rhwp의 hitTest가 글상자 안 문단이나 다른 순번을 가리킨 클릭이 있다(예전 경로가 틀렸을 자리)
      assert.ok(report.hitDisagree.otherParagraph + report.hitDisagree.otherOffset > 0, `hitTest와 다른 클릭이 없다: ${JSON.stringify(report.hitDisagree)}`);
      assert.ok((report.reasons["glyph|OVERLAPPING_RUNS"] ?? 0) > 0, `겹친 글자가 char가 아닌 사유로 나와야 한다: ${JSON.stringify(report.reasons)}`);
    }
    withDoc(bytes, (rdoc, doc) => {
      const long = rdoc.pageLayout(0).runs.filter((r) => r.paraIdx === 1 && r.cellPath === undefined && r.text.length > 20);
      assert.ok(long.length >= 3, `${name}: 줄이 나뉘지 않았다`);
      const second = long[1] as LayoutRun;
      for (const i of [3, 10, 20]) {
        const p = spot(second, i, 0.25);
        const r = clickAt(rdoc, doc, 0, p.x, p.y);
        if (r.precision === "char") expectGlyph(doc, r, second, i, 0.25, `${name} 둘째 줄[${i}]`);
        assert.equal(r.address === undefined || r.address.path.length === 1, true, `${name}: 개체 안 문단 주소가 나왔다 ${JSON.stringify(r.address)}`);
      }
    });
  }
});

// ── D2: 문서 좌표 없이 그려진 글, 빈 곳 ──────────────────────────────

test("D2: 쪽 번호처럼 문서 좌표 없이 그려진 글을 누르면 위치를 옮기지 않는다(UNPOSITIONED_TEXT). 가장 가까운 문단의 글자로 내려가지 않는다", () => {
  withDoc(readFixture("D2"), (rdoc, doc) => {
    const number = runWithText(rdoc, 2, "- 1 -");
    for (const i of [0, 2, 4]) {
      const p = spot(number, i, 0.5);
      const r = clickAt(rdoc, doc, 2, p.x, p.y);
      assert.equal(r.precision, "none", `쪽 번호[${i}]: ${r.precision}`);
      assert.equal(r.reason, "UNPOSITIONED_TEXT");
      assert.equal(r.address, undefined);
    }
  });
});

test("D2: 글자가 없는 곳(빈 곳·여백)을 누르면 char가 아니고, 문단이면 NEAREST_LINE이며 줄 끝 오른쪽 빈 곳은 그 줄의 문단이다", () => {
  withDoc(readFixture("D1"), (rdoc, doc) => {
    const info = rdoc.pageInfo(0);
    const body = rdoc.pageLayout(0).runs.filter((r) => r.paraIdx !== undefined && r.cellPath === undefined && r.text !== "");
    const run = body[1] as LayoutRun;
    for (const p of [
      { x: run.x + run.w + 6, y: run.y + run.h / 2 }, // 줄 끝 오른쪽 빈 곳
      { x: info.width - 5, y: run.y + run.h / 2 }, // 오른쪽 여백
      { x: 4, y: 4 }, // 쪽 모서리
      { x: info.width / 2, y: info.height - 4 },
    ]) {
      const r = clickAt(rdoc, doc, 0, p.x, p.y);
      assert.notEqual(r.precision, "char", `(${p.x}, ${p.y})에서 char가 나왔다`);
      if (r.precision === "paragraph") {
        assert.equal(r.reason, "NEAREST_LINE");
        assert.equal(r.address?.offset, undefined, "문단 단위는 글자 오프셋을 내지 않는다");
      }
    }
    const right = clickAt(rdoc, doc, 0, run.x + run.w + 6, run.y + run.h / 2);
    assert.equal(right.precision, "paragraph");
    assert.equal(right.reason, "NEAREST_LINE");
    assert.equal(paragraphAtAddress(doc, right.address as EngineAddress)?.logicalText.startsWith(run.text.slice(0, 5)), true, "줄 끝 오른쪽 빈 곳 = 그 줄의 문단");
  });
});

// ── 빈 곳: 가장 가까운 줄은 행 우선으로 고른다 ───────────────────────

/** 빈 곳을 눌러 `paragraph`(NEAREST_LINE)가 나왔는지 확인하고 그 엔진 문단 글을 돌려준다. */
function nearestParagraph(rdoc: ViewerDocument, doc: ReturnType<typeof parse>, x: number, y: number, label: string): string {
  const r = clickAt(rdoc, doc, 0, x, y);
  assert.deepEqual([r.precision, r.reason], ["paragraph", "NEAREST_LINE"], `${label}: ${JSON.stringify([r.precision, r.reason])}`);
  assert.equal(r.address?.offset, undefined);
  // 독립 기준: 점의 높이를 담는(또는 세로로 가장 가까운) 줄의 런이 속한 엔진 문단이다
  assert.ok(rowParagraphKeys(doc, rdoc.pageLayout(0), y).has(paragraphKey(r.address as EngineAddress)), `${label}: 같은 줄의 문단이 아니다`);
  return paragraphAtAddress(doc, r.address as EngineAddress)?.logicalText ?? "";
}

test("빈 곳(행 우선): 줄 끝 오른쪽 먼 곳은 더 길게 뻗은 아랫줄이 아니라 같은 높이 줄의 문단이다 (hancom/ph-single 첫 본문 줄, 쪽 x≈400·700)", () => {
  withDoc(readFixture("hancom/ph-single"), (rdoc, doc) => {
    const line = runWithText(rdoc, 0, "입니다.");
    const next = runWithText(rdoc, 0, "기간: {{");
    const lower = runWithText(rdoc, 0, "project.start}} ~ {{project.end}}");
    // 전제: 아랫줄 런이 첫 줄 런보다 오른쪽 끝이 더 멀리 뻗어 있다(평면 거리로 고르면 아랫줄이 뽑힌다)
    assert.ok(lower.x + lower.w > line.x + line.w && next.y > line.y);
    const y = line.y + line.h / 2;
    for (const x of [400, 700]) {
      const text = nearestParagraph(rdoc, doc, x, y, `x=${x}`);
      assert.ok(text.startsWith("사업명:"), `x=${x}: 첫 본문 줄의 문단이 아니다 ${JSON.stringify(text)}`);
    }
    // 아랫줄 높이에서는 아랫줄의 문단이다
    assert.ok(nearestParagraph(rdoc, doc, 700, next.y + next.h / 2, "아랫줄").startsWith("기간:"));
  });
});

test("빈 곳(행 우선): 두 줄 사이 줄 간격은 세로로 더 가까운 줄의 문단이고, 쪽 여백은 같은 높이(또는 가장 가까운 줄)의 문단이다", () => {
  withDoc(readFixture("hancom/ph-single"), (rdoc, doc) => {
    const info = rdoc.pageInfo(0);
    const first = runWithText(rdoc, 0, "사업명: {{");
    const second = runWithText(rdoc, 0, "기간: {{");
    const gapTop = first.y + first.h;
    assert.ok(second.y > gapTop + 3, "두 줄 사이에 빈 간격이 있어야 한다");
    assert.ok(nearestParagraph(rdoc, doc, 200, gapTop + 1.2, "윗줄 쪽 간격").startsWith("사업명:"));
    assert.ok(nearestParagraph(rdoc, doc, 200, second.y - 1.2, "아랫줄 쪽 간격").startsWith("기간:"));
    // 왼쪽 여백(같은 높이), 위쪽 여백(첫 줄 위), 아래쪽 여백(마지막 줄 아래)
    assert.ok(nearestParagraph(rdoc, doc, 20, first.y + first.h / 2, "왼쪽 여백").startsWith("사업명:"));
    assert.ok(nearestParagraph(rdoc, doc, 400, 20, "위쪽 여백").includes("합성 시험 문서"), "위쪽 여백 = 첫 줄(구역 설정이 든 문단)");
    assert.ok(nearestParagraph(rdoc, doc, 400, info.height - 20, "아래쪽 여백").startsWith("기간:"));
  });
});

test("빈 곳: 표 칸 안 빈 곳은 그 칸 글의 문단이다 — 같은 높이에 이웃 칸 런이 있어도(행 우선이면 그 런이 뽑힌다) 소속으로 확정한다(R2)", () => {
  const bytes = synth([P(R(TBL([[SUBP("가"), SUBP("나다라마바사아자차카타파하")]], "0")))]);
  withDoc(bytes, (rdoc, doc) => {
    const a = runWithText(rdoc, 0, "가");
    const b = rdoc.pageLayout(0).runs.find((r) => r.text.startsWith("나다"));
    assert.ok(b !== undefined && a.cellPath !== undefined);
    // 첫 칸 글과 같은 높이의 칸 안 빈 곳(글 오른쪽, 칸 경계 가까이)
    const y = a.y + a.h / 2;
    for (const x of [a.x + a.w + 5, b.x - 6]) {
      const text = nearestParagraph(rdoc, doc, x, y, `칸 안 x=${x.toFixed(0)}`);
      assert.equal(text, "가");
    }
    // 둘째 칸의 첫 줄 높이(첫 칸 글은 이 높이를 담지 않는다)에서 첫 칸 안 빈 곳: 같은 높이의 런은 칸 밖(둘째 칸)의 것이다.
    // 행 우선으로만 고르면 그 런이 뽑혀 hitTest(칸 문단)와 달라 none이었다. 이제는 점을 담은 칸의 런만 후보이므로 첫 칸의 문단이다
    const outside = b.y + b.h / 2;
    assert.ok(outside < a.y, "전제: 둘째 칸 첫 줄이 첫 칸 글보다 위에 있다");
    const hit = rdoc.hit(0, a.x + a.w + 20, outside);
    assert.equal(hit.position?.cellPath?.[0]?.cellIndex, 0, "전제: hitTest는 점이 든 첫 칸의 문단을 준다");
    assert.equal(nearestParagraph(rdoc, doc, a.x + a.w + 20, outside, "첫 칸 윗 여백"), "가");
  });
});

test("D5: 표 칸 글을 누르면 표를 담은 본문 문단이 아니라 칸의 문단이다. 글상자 글도 마찬가지다. 표 칸의 빈 곳도 본문 문단으로 내려가지 않는다", () => {
  const bytes = synth([P(R(T("앞 글") + RECT(SUBLIST(SUBP("글상자 안")), "1") + T("뒤 글"))), P(R(TBL([[SUBP("셀 하나"), SUBP("셀 둘")]], "0")))]);
  withDoc(bytes, (rdoc, doc) => {
    for (const text of ["글상자 안", "셀 하나", "셀 둘"]) {
      const run = runWithText(rdoc, 0, text);
      for (let i = 0; i < Array.from(text).length; i++) {
        if (text[i] === " ") continue;
        const p = spot(run, i, 0.25);
        const r = clickAt(rdoc, doc, 0, p.x, p.y);
        expectGlyph(doc, r, run, i, 0.25, `${text}[${i}]`);
        assert.ok((r.address?.path.length ?? 0) >= 3, `${text}: 컨테이너 안 문단이어야 한다 ${JSON.stringify(r.address)}`);
        assert.equal(paragraphAtAddress(doc, r.address as EngineAddress)?.logicalText, text);
      }
    }
    const cell = runWithText(rdoc, 0, "셀 하나");
    const blank = clickAt(rdoc, doc, 0, cell.x + cell.w + 4, cell.y + cell.h / 2);
    assert.notEqual(blank.precision, "char");
    if (blank.precision === "paragraph") {
      assert.equal(blank.address?.path.length, 3, `표 칸 빈 곳이 칸의 문단이 아니다: ${JSON.stringify(blank)}`);
      assert.equal(paragraphAtAddress(doc, blank.address as EngineAddress)?.logicalText, "셀 하나");
    }
  });
});

test("D5: 글상자 안의 표(글상자 > 표 > 칸) 글을 누르면 글상자 문단이나 표를 담은 문단이 아니라 안쪽 칸의 문단이다", () => {
  const nested = RECT(SUBLIST(P(R(TBL([[SUBP("안쪽 칸")]], "1")))), "1");
  const bytes = synth([P(R(T("앞 글") + nested + T("뒤 글")))]);
  withDoc(bytes, (rdoc, doc) => {
    const run = runWithText(rdoc, 0, "안쪽 칸");
    assert.equal(run.cellPath?.length, 2, "글상자 안의 표 칸은 경로가 둘이다");
    for (let i = 0; i < Array.from(run.text).length; i++) {
      if (run.text[i] === " ") continue;
      const p = spot(run, i, 0.25);
      const r = clickAt(rdoc, doc, 0, p.x, p.y);
      expectGlyph(doc, r, run, i, 0.25, `안쪽 칸[${i}]`);
      assert.equal(r.address?.path.length, 5, `글상자 > 표 > 칸의 문단 주소: ${JSON.stringify(r.address)}`);
      assert.equal(paragraphAtAddress(doc, r.address as EngineAddress)?.logicalText, "안쪽 칸");
    }
    expectCleanClicks(bytes, "글상자 안의 표");
  });
});

// ── D6: 영역 판별은 점 아래의 런을 먼저 본다 ─────────────────────────

test("D6: 머리말 높이 안에 놓인 본문 표 칸 글자는 header가 아니라 표 칸이다. 머리말 글은 그대로 header다", () => {
  const floating = TBL([[SUBP("표 셀 글")]], "0")
    .replace('textWrap="TOP_AND_BOTTOM"', 'textWrap="IN_FRONT_OF_TEXT"')
    .replace('vertRelTo="PARA"', 'vertRelTo="PAPER"')
    .replace('horzRelTo="COLUMN"', 'horzRelTo="PAPER"')
    .replace('vertOffset="0"', 'vertOffset="9400"')
    .replace('horzOffset="0"', 'horzOffset="30000"');
  const bytes = synth([P(R(floating)), P(R(T("본문 글")))], "D7");
  withDoc(bytes, (rdoc, doc) => {
    const cell = runWithText(rdoc, 0, "표 셀 글");
    const info = rdoc.pageInfo(0);
    const mid = cell.y + cell.h / 2;
    assert.ok(mid >= info.headerArea.y && mid <= info.headerArea.y + info.headerArea.height, "표 칸 글이 머리말 높이 안에 있어야 한다");
    // 사실: 머리말·꼬리말 영역 판별 함수만 부르면 이 점은 머리말이다
    assert.equal((JSON.parse(rdoc.native.hitTestHeaderFooter(0, cell.x + 3, mid)) as { hit: boolean }).hit, true);
    const hit = rdoc.hit(0, cell.x + 3, mid);
    assert.equal(hit.region, "cell");
    assert.ok(hit.position !== undefined);
    const r = clickAt(rdoc, doc, 0, cell.x + 3, mid);
    assert.equal(r.pick.hit.region, "cell");
    expectGlyph(doc, r, cell, 0, 0.25, "머리말 높이의 표 칸 글");
    // 머리말 글은 그대로 머리말(영역만, 위치 없음)
    const header = runWithText(rdoc, 0, "머리말 글 ");
    const h = clickAt(rdoc, doc, 0, header.x + 3, header.y + header.h / 2);
    assert.deepEqual([h.pick.hit.region, h.precision, h.pick.hit.position], ["header", "none", undefined]);
  });
});

/** 머리말(또는 꼬리말)의 글 대신 표(칸 글 `머리 칸`·`꼬리 칸`)를 넣은 `D7` 문서. rhwp는 이 표 칸의 글에 본문 표 칸과 같은 모양의 문서 좌표를 붙인다. */
function areaTableDoc(where: "header" | "footer"): Uint8Array {
  const bytes = readFixture("D7");
  const pkg = openPackage(bytes);
  const name = pkg.sectionEntries[0] ?? "";
  const text = new TextDecoder().decode(readEntry(pkg.archive, bytes, name));
  const open = text.indexOf(`<hp:${where} `);
  const listStart = text.indexOf(">", text.indexOf("<hp:subList", open)) + 1;
  const listEnd = text.indexOf("</hp:subList>", listStart);
  const cell = where === "header" ? "머리 칸" : "꼬리 칸";
  const out = text.slice(0, listStart) + P(R(TBL([[SUBP(cell)]], "1"))) + text.slice(listEnd);
  return rewriteArchive(bytes, pkg.archive, { replace: new Map([[name, new TextEncoder().encode(out)]]) });
}

test("D6: 머리말·꼬리말 안 표 칸의 글은 본문 표 칸과 같은 모양의 문서 좌표가 붙어도 header·footer다(위치를 내지 않는다). 본문 표 칸으로 옮기지 않는다", () => {
  for (const [where, text, region] of [["header", "머리 칸", "header"], ["footer", "꼬리 칸", "footer"]] as const) {
    withDoc(areaTableDoc(where), (rdoc, doc) => {
      const run = runWithText(rdoc, 0, text);
      assert.deepEqual([run.paraIdx, run.parentParaIdx, run.cellPath?.length], [0, where === "header" ? 0 : 0, 1], "사실: 본문 문단 0의 표 칸처럼 보이는 좌표가 붙는다");
      for (let i = 0; i < Array.from(text).length; i++) {
        for (const q of [0.25, 0.75]) {
          const p = spot(run, i, q);
          const r = clickAt(rdoc, doc, 0, p.x, p.y);
          assert.deepEqual([r.pick.hit.region, r.precision, r.pick.hit.position, r.address], [region, "none", undefined, undefined], `${where}[${i}] ${q}`);
        }
      }
      const raw = rdoc.hit(0, spot(run, 0, 0.25).x, spot(run, 0, 0.25).y);
      assert.deepEqual([raw.region, raw.position], [region, undefined]);
    });
  }
});

// ── 전수 눌러 보기 ───────────────────────────────────────────────

test("시험 문서 전부와 합성 문서: 눌러 본 모든 점에서 조용한 불일치 0, 영역 오판 0, 빈 곳·머리말 글에서 char 0", (t) => {
  const total = newClickReport();
  const docs: [string, Uint8Array][] = fixtureNames().map((n) => [n, readFixture(n)]);
  for (const [n, b] of Object.entries(syntheticDocs())) docs.push([n, b]);
  for (const [name, bytes] of docs) {
    const r = checkClicks(bytes, { pageCap: 50, runCap: 400 });
    assert.equal(r.silent, 0, `${name}: ${JSON.stringify(r.silentKinds)}`);
    assert.equal(r.regionBad, 0, `${name}: ${JSON.stringify(r.regionKinds)}`);
    assert.equal(r.errors, 0, name);
    mergeClickReports(total, r);
  }
  assert.ok(total.presses.glyph > 3000 && total.presses.blank > 800, JSON.stringify(total.presses));
  assert.equal(total.byKind.blank.char, 0);
  assert.equal(total.byKind.marker.char, 0);
  t.diagnostic(`누른 점 ${JSON.stringify(total.presses)}; 결과 ${JSON.stringify(total.byKind)}; 사유 ${JSON.stringify(total.reasons)}; hitTest와 다른 글자 클릭 ${JSON.stringify(total.hitDisagree)}`);
});

test("채움 뒤 다시 그려진 문서(엔진이 줄 배치 정보를 지운 구역): 눌러 본 모든 점에서 조용한 불일치 0, 영역 오판 0", (t) => {
  const total = newClickReport();
  let filled = 0;
  const names = fixtureNames();
  for (const name of names) {
    const out = fillOnce(readFixture(name));
    if (out === undefined) continue;
    filled++;
    const r = checkClicks(out, { pageCap: 50, runCap: 400 });
    assert.ok(r.engine.ok && r.rhwp.ok, `${name}: 채운 문서가 열리지 않는다`);
    assert.equal(r.silent, 0, `${name}: ${JSON.stringify(r.silentKinds)}`);
    assert.equal(r.regionBad, 0, `${name}: ${JSON.stringify(r.regionKinds)}`);
    mergeClickReports(total, r);
  }
  assert.ok(filled >= 15, `채운 문서가 너무 적다: ${filled}/${names.length}`);
  assert.ok(total.presses.glyph > 2000, JSON.stringify(total.presses));
  t.diagnostic(`채운 문서 ${filled}/${names.length}건: 누른 점 ${JSON.stringify(total.presses)}; 결과 ${JSON.stringify(total.byKind)}; 사유 ${JSON.stringify(total.reasons)}; hitTest와 다른 글자 클릭 ${JSON.stringify(total.hitDisagree)}`);
});

// ── R1: 안내문 상태 누름틀 바로 앞 글자의 오른쪽 절반 ────────────────

/** 문단 `para`의 런 가운데 글이 `text`인 런과 그 마지막 글자 번호 */
function lastGlyph(rdoc: ViewerDocument, para: number, text: string): { run: LayoutRun; i: number } {
  const run = rdoc.pageLayout(0).runs.find((r) => r.paraIdx === para && r.cellPath === undefined && r.text === text);
  assert.ok(run !== undefined, `런 ${JSON.stringify(text)}이(가) 없다`);
  return { run, i: Array.from(run.text).length - 1 };
}

test("R1: 안내문 상태 누름틀 바로 앞 글자의 오른쪽 절반을 누르면 캐럿은 누름틀 시작 표식 앞(누름틀 밖, 앞 글자 바로 뒤)이다 — hancom/field-states `성명: `", () => {
  const bytes = readFixture("hancom/field-states");
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const { run, i } = lastGlyph(rdoc, 0, "성명: ");
    const p = doc.sections[0]?.paragraphs[0];
    assert.ok(p !== undefined);
    const begin = p.logicalText.indexOf("성명: ") + "성명: ".length; // 앞 글자(공백) 바로 뒤 = 누름틀 시작 표식 앞
    const right = spot(run, i, 0.75);
    const r = clickAt(rdoc, doc, 0, right.x, right.y);
    assert.equal(r.precision, "char");
    assert.equal(r.address?.offset, begin, `누름틀 시작 표식 앞이어야 한다(문단 글 ${JSON.stringify(p.logicalText)})`);
    expectGlyph(doc, r, run, i, 0.75, "성명: 마지막 글자 오른쪽");
    // 왼쪽 절반은 글자 앞(안내문과 무관)
    const left = spot(run, i, 0.25);
    assert.equal(clickAt(rdoc, doc, 0, left.x, left.y).address?.offset, begin - 1);
  } finally {
    rdoc.free();
  }
});

/** `가: [안내문]뒤` 합성 문서(안내문 "소속 입력")들: 안내문이 별도 런으로 그려지는 것과 글 없이 비어 있는 것 */
const guideDocs = (): Record<string, Uint8Array> => ({
  "안내문 글 런": synth([P(R(T("가: ") + FIELD_BEGIN("12", "소속", "0", "소속 입력")) + R(T("소속 입력"), "7") + R(FIELD_END("12") + T("뒤")))]),
  "글 없는 누름틀": synth([P(R(T("가: ") + FIELD_BEGIN("12", "소속", "0", "소속 입력") + FIELD_END("12") + T("뒤")))]),
});

test("R1: `가: [안내문]뒤` — 공백의 오른쪽 절반은 누름틀 시작 표식 앞, `뒤`의 왼쪽 절반은 끝 표식 뒤", () => {
  for (const [name, bytes] of Object.entries(guideDocs())) {
    const doc = parse(bytes);
    const rdoc = openDocument(bytes);
    try {
      const p = doc.sections[0]?.paragraphs[1];
      assert.ok(p !== undefined);
      const begin = p.logicalText.indexOf("가: ") + "가: ".length;
      const end = p.logicalText.lastIndexOf("\ufffc") + 1; // 끝 표식 바로 뒤
      const runs = rdoc.pageLayout(0).runs.filter((r) => r.paraIdx === 1 && r.cellPath === undefined && r.text !== "");
      // 앞 글 런(`가: ` 또는 합쳐진 `가: 뒤`)의 공백, 뒤 글자 `뒤`
      const front = runs.find((r) => r.text.startsWith("가: "));
      assert.ok(front !== undefined, name);
      const space = spot(front, 2, 0.75);
      const a = clickAt(rdoc, doc, 0, space.x, space.y);
      assert.equal(a.precision, "char", name);
      assert.equal(a.address?.offset, begin, `${name}: 공백 오른쪽 절반 → 시작 표식 앞`);
      const after = runs.find((r) => r.text === "뒤") ?? front;
      const i = Array.from(after.text).indexOf("뒤");
      const k = spot(after, i, 0.25);
      const b = clickAt(rdoc, doc, 0, k.x, k.y);
      assert.equal(b.precision, "char", name);
      assert.equal(b.address?.offset, end, `${name}: 뒤 왼쪽 절반 → 끝 표식 뒤`);
    } finally {
      rdoc.free();
    }
  }
});

test("R1 회귀: 값이 든 누름틀(안내문 아님) 경계의 동작은 그대로다 — 앞 글자 오른쪽은 누름틀 값 시작, 값 끝 글자 오른쪽은 끝 표식 뒤", () => {
  const bytes = synth([P(R(T("앞") + FIELD_BEGIN("11", "성명", "1", "이름을 입력") + T("홍길동") + FIELD_END("11") + T("뒤")))]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const run = rdoc.pageLayout(0).runs.find((r) => r.paraIdx === 1 && r.text === "앞홍길동뒤");
    assert.ok(run !== undefined);
    const p = doc.sections[0]?.paragraphs[1];
    assert.equal(p?.logicalText, "앞\ufffc홍길동\ufffc뒤");
    const offsets = (i: number, q: number): number | undefined => {
      const at = spot(run, i, q);
      return clickAt(rdoc, doc, 0, at.x, at.y).address?.offset;
    };
    assert.equal(offsets(0, 0.75), 2, "앞 오른쪽 → 값 시작(표식 뒤)");
    assert.equal(offsets(1, 0.25), 2);
    assert.equal(offsets(3, 0.75), 6, "동 오른쪽 → 끝 표식 뒤");
    assert.equal(offsets(4, 0.25), 6);
  } finally {
    rdoc.free();
  }
});

test("R1 도구: 글자와 주소 사이에 객체 자리 글자 말고 다른 글(안내문 글)이 끼면 조용한 불일치로 센다 — 안내문 앞 글자의 오른쪽 4분의 1을 눌러 본 클릭 경로 대조가 이를 잡는다", () => {
  const bytes = readFixture("hancom/field-states");
  const p = parse(bytes).sections[0]?.paragraphs[0];
  assert.ok(p !== undefined);
  const begin = p.logicalText.indexOf("성명: ") + "성명: ".length;
  assert.equal(objectsOnlyBetween(p, begin, begin), true);
  assert.equal(objectsOnlyBetween(p, begin, begin + 1), true, "시작 표식 하나");
  assert.equal(objectsOnlyBetween(p, begin, p.logicalText.length), false, "안내문 글과 끝 표식을 지난 오프셋");
  assert.equal(objectsOnlyBetween(p, begin + 1, begin), false, "거꾸로");
  // 도구는 글자 곁 점검을 하고, 시험 문서 전부에서 이를 통과한다(위 시험이 고친 뒤의 동작)
  const r = checkClicks(bytes, { pageCap: 5, runCap: 400 });
  assert.equal(r.silent, 0, JSON.stringify(r.silentKinds));
  for (const [name, doc] of Object.entries(guideDocs())) assert.equal(checkClicks(doc, { pageCap: 5, runCap: 400 }).silent, 0, name);
});
