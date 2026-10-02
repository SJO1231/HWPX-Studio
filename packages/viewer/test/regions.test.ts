// V4: 머리말·꼬리말·각주를 누르면 본문 위치가 아니라 영역으로 보고된다.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { MARKER_PARA_MIN, hasDocCoords, openDocument, type LayoutRun, type ViewerDocument } from "../src/rhwp/index.ts";
import { FOOTNOTE, P, R, SUBLIST, SUBP, T, TBL, RECT, ensureRhwp, readFixture, synth } from "./helpers.ts";

before(ensureRhwp);

const markerRuns = (doc: ViewerDocument, page: number): LayoutRun[] => doc.pageLayout(page).runs.filter((r) => typeof r.paraIdx === "number" && r.paraIdx >= MARKER_PARA_MIN);
const center = (r: LayoutRun): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];

/** rhwp의 `hitTest`를 그대로 부르면 머리말·꼬리말·각주 자리에서도 본문 문단 위치가 나온다(그래서 전용 함수를 먼저 부른다). */
function rawBodyHit(doc: ViewerDocument, page: number, x: number, y: number): { paragraphIndex: number; sectionIndex: number } {
  return JSON.parse(doc.native.hitTest(page, x, y)) as { paragraphIndex: number; sectionIndex: number };
}

test("V4: 머리말·꼬리말 글을 누르면 영역(header·footer)만 알려 주고 문서 위치는 주지 않는다", () => {
  for (const name of ["hancom/header-footer", "D7"]) {
    const doc = openDocument(readFixture(name));
    try {
      const marks = markerRuns(doc, 0);
      assert.ok(marks.length >= 2, `${name}: 머리말·꼬리말 글이 없다`);
      const regions = new Set<string>();
      for (const run of marks) {
        const [x, y] = center(run);
        const hit = doc.hit(0, x, y);
        regions.add(hit.region);
        assert.ok(hit.region === "header" || hit.region === "footer", `${name}: ${hit.region}`);
        assert.equal(hit.position, undefined, "머리말·꼬리말에서는 본문 위치를 내지 않는다");
        // 새 계약: 클릭 해석(`pick`)도 영역만 알리고 위치를 내지 않는다(한계 none)
        const pick = doc.pick(0, x, y);
        assert.deepEqual([pick.hit.region, pick.hit.position, pick.limit, pick.shown], [hit.region, undefined, "none", undefined]);
        // 대조: 전용 함수 없이 hitTest만 부르면 본문 문단 위치가 나온다
        const raw = rawBodyHit(doc, 0, x, y);
        assert.ok(raw.paragraphIndex >= 0 && raw.paragraphIndex < 1000, "원래의 hitTest는 본문 위치로 폴백한다");
      }
      assert.deepEqual([...regions].sort(), ["footer", "header"], `${name}: 머리말과 꼬리말이 모두 나와야 한다`);
    } finally {
      doc.free();
    }
  }
});

test("V4: 각주 글을 누르면 footnote 영역이다(본문 위치가 아니다)", () => {
  const bytes = synth([P(R(T("앞") + FOOTNOTE("각주 내용") + T("뒤")))]);
  const doc = openDocument(bytes);
  try {
    const note = markerRuns(doc, 0).find((r) => r.text.includes("각주"));
    assert.ok(note !== undefined, "각주 글 런이 없다");
    const [x, y] = center(note);
    const hit = doc.hit(0, x, y);
    assert.equal(hit.region, "footnote");
    assert.equal(hit.position, undefined);
    assert.ok(rawBodyHit(doc, 0, x, y).paragraphIndex >= 0, "원래의 hitTest는 본문 위치를 낸다");
    const pick = doc.pick(0, x, y);
    assert.deepEqual([pick.hit.region, pick.hit.position, pick.limit], ["footnote", undefined, "none"]);
    // 각주 번호 글(`1) `)은 문서 좌표 없이 그려진다: 영역은 각주이고, 위치는 옮기지 않는다(UNPOSITIONED_TEXT)
    const label = doc.pageLayout(0).runs.find((r) => !hasDocCoords(r) && r.text.startsWith("1)"));
    assert.ok(label !== undefined, "각주 번호 글 런이 없다");
    const num = doc.pick(0, label.x + 2, label.y + label.h / 2);
    assert.deepEqual([num.hit.region, num.limit, num.reason, num.hit.position], ["footnote", "none", "UNPOSITIONED_TEXT", undefined]);
  } finally {
    doc.free();
  }
});

test("V4: 본문·표 셀·글상자는 각각 body·cell·textbox 영역과 문서 위치를 준다", () => {
  const bytes = synth([P(R(T("본문 글자") + RECT(SUBLIST(SUBP("글상자 글")), "1") + T(" 뒤"))), P(R(TBL([[SUBP("셀 글자")]], "0")))]);
  const doc = openDocument(bytes);
  try {
    const runs = doc.pageLayout(0).runs.filter(hasDocCoords);
    const seen: Record<string, string> = {};
    for (const run of runs) {
      if (run.text === "") continue;
      const hit = doc.hit(0, run.x + run.w * 0.25 + 0.01, run.y + run.h / 2);
      seen[hit.region] = run.text;
      assert.ok(hit.position !== undefined, `${hit.region}에는 위치가 있어야 한다`);
    }
    assert.ok(seen["body"] !== undefined && seen["cell"] !== undefined && seen["textbox"] !== undefined, JSON.stringify(seen));
  } finally {
    doc.free();
  }
});

test("V4: 머리말·꼬리말 영역은 실제로 머리말·꼬리말이 있을 때만 영역으로 본다(없으면 본문의 가장 가까운 줄)", () => {
  // 머리말이 없는 문서: 영역(여백)을 눌러도 header가 아니다
  const none = openDocument(readFixture("D1"));
  try {
    const info = none.pageInfo(0);
    assert.equal(none.hit(0, info.headerArea.x + 5, info.headerArea.y + info.headerArea.height / 2).region, "body");
    assert.equal(none.hit(0, info.footerArea.x + 5, info.footerArea.y + 5).region, "body");
    // 새 계약: 글자가 없는 곳은 hitTest의 가장 가까운 줄을 문단 단위로만 쓴다(NEAREST_LINE). 점에서 가장 가까운 런의 문단이 아니면 내려놓는다(NEAREST_UNCONFIRMED). 어느 쪽이든 char는 아니다
    for (const p of [{ x: info.headerArea.x + 5, y: info.headerArea.y + info.headerArea.height / 2 }, { x: info.footerArea.x + 5, y: info.footerArea.y + 5 }]) {
      const pick = none.pick(0, p.x, p.y);
      assert.notEqual(pick.limit, "char");
      assert.ok(pick.limit === "paragraph" ? pick.reason === "NEAREST_LINE" && pick.hit.region === "body" : pick.reason === "NEAREST_UNCONFIRMED", JSON.stringify(pick));
    }
  } finally {
    none.free();
  }
  // 머리말·꼬리말이 있는 문서: 영역 안은 영역이다(빈 줄이어도)
  const some = openDocument(readFixture("D7"));
  try {
    const info = some.pageInfo(0);
    assert.equal(some.hit(0, info.headerArea.x + 5, info.headerArea.y + info.headerArea.height / 2).region, "header");
    assert.equal(some.hit(0, info.footerArea.x + 5, info.footerArea.y + 5).region, "footer");
  } finally {
    some.free();
  }
  // 꼬리말 영역과 본문 표가 겹친 문서(머리말·꼬리말 없음): 표 셀 글자를 누르면 영역이 아니라 표 셀이다
  const merged = openDocument(readFixture("hancom-merged"));
  try {
    const cell = merged.pageLayout(0).runs.find((r) => r.cellPath !== undefined && r.text === "Ⅰ");
    assert.ok(cell !== undefined);
    const hit = merged.hit(0, cell.x + 1, cell.y + cell.h / 2);
    assert.equal(hit.region, "cell");
    assert.ok(hit.position !== undefined);
  } finally {
    merged.free();
  }
});
