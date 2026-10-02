// 눌린 점 아래의 글자 찾기(rhwp/pick.ts)의 순수 기하 판단. rhwp 없이 만든 글자 배치로 시험한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKER_PARA_MIN, caretIndex, classifyPoint, glyphIndexAt, glyphsAt, nearestLineRun, nearestLineRuns, nearestRunOf, type LayoutRun, type PageLayout } from "../src/rhwp/index.ts";

/** 글자 폭이 모두 10인 런. `paraIdx`가 없으면 문서 좌표 없는 런(쪽 번호·안내문 등)이다. */
function run(text: string, x: number, y: number, para?: number, charStart = 0, extra: Partial<LayoutRun> = {}): LayoutRun {
  const n = Array.from(text).length;
  const out: LayoutRun = { text, x, y, w: n * 10, h: 20, charX: Array.from({ length: n + 1 }, (_, i) => i * 10), ...extra };
  if (para !== undefined) {
    out.secIdx = 0;
    out.paraIdx = para;
    out.charStart = charStart;
  }
  return out;
}

test("glyphIndexAt: 글자 사각형 안이면 그 순번, 경계는 오른쪽 글자 것이고 런 맨 끝은 마지막 글자 것이다. 글이 빈 런과 폭 0 글자는 후보가 아니다", () => {
  const r = run("가나다", 100, 50, 0);
  assert.equal(glyphIndexAt(r, 100, 60), 0);
  assert.equal(glyphIndexAt(r, 109.9, 60), 0);
  assert.equal(glyphIndexAt(r, 110, 60), 1, "경계는 오른쪽 글자");
  assert.equal(glyphIndexAt(r, 130, 60), 2, "런의 맨 오른쪽 끝은 마지막 글자");
  assert.equal(glyphIndexAt(r, 130.1, 60), undefined);
  assert.equal(glyphIndexAt(r, 99.9, 60), undefined);
  assert.equal(glyphIndexAt(r, 105, 49.9), undefined, "런의 위");
  assert.equal(glyphIndexAt(r, 105, 70.1), undefined, "런의 아래");
  assert.equal(glyphIndexAt(run("", 100, 50, 0, 0, { w: 500 }), 300, 60), undefined, "빈 런은 아무리 넓어도 후보가 아니다");
  // 폭 0 글자(결합 부호): 앞 글자 사각형 끝과 같은 자리라 오른쪽 글자 것이다
  const zero: LayoutRun = { text: "가\u0301나", x: 0, y: 0, w: 20, h: 20, charX: [0, 10, 10, 20], secIdx: 0, paraIdx: 0, charStart: 0 };
  assert.equal(glyphIndexAt(zero, 5, 5), 0);
  assert.equal(glyphIndexAt(zero, 10, 5), 2, "폭 0 글자는 누를 수 없다");
  // charX가 짧으면(깨진 입력) 후보가 아니다
  assert.equal(glyphIndexAt({ ...r, charX: [0, 10] }, 105, 60), undefined);
});

test("caretIndex: 글자 사각형의 앞쪽 절반이면 글자 앞, 뒤쪽 절반이면 글자 뒤", () => {
  const r = run("가나", 100, 50, 0);
  assert.equal(caretIndex(r, 0, 102), 0);
  assert.equal(caretIndex(r, 0, 104.9), 0);
  assert.equal(caretIndex(r, 0, 105), 1);
  assert.equal(caretIndex(r, 1, 117), 2);
});

test("classifyPoint: 빈 곳·한 글자·머리말 글·좌표 없는 글", () => {
  const layout: PageLayout = { runs: [run("본문", 100, 50, 3, 7), run("머리", 100, 10, MARKER_PARA_MIN + 5), run("- 1 -", 100, 900)] };
  assert.deepEqual(classifyPoint(layout, 500, 500), { kind: "blank" });
  assert.deepEqual(classifyPoint(layout, 80, 60), { kind: "blank" });
  const one = classifyPoint(layout, 112, 60);
  assert.equal(one.kind, "glyph");
  if (one.kind === "glyph") assert.deepEqual([one.run.text, one.glyph, one.caret], ["본문", 1, 1], "두 번째 글자의 앞쪽 절반 = 글자 앞 경계 1");
  const back = classifyPoint(layout, 118, 60);
  assert.equal(back.kind === "glyph" ? back.caret : -1, 2, "뒤쪽 절반 = 글자 뒤 경계");
  const header = classifyPoint(layout, 105, 20);
  assert.equal(header.kind === "marker" ? header.run.text : "", "머리");
  const page = classifyPoint(layout, 105, 910);
  assert.equal(page.kind, "unpositioned");
  assert.equal(page.kind === "unpositioned" ? page.empty : 1, undefined, "앞에 빈 문서 런이 없다");
});

test("classifyPoint: 좌표 없는 글 바로 앞에 빈 문서 런이 있으면 안내문 후보다(그 런을 알려 준다)", () => {
  const empty = run("", 100, 50, 4, 2, { w: 0 });
  const guide = run("이름 입력", 100, 50);
  const layout: PageLayout = { runs: [run("앞", 80, 50, 4, 0), empty, guide] };
  const c = classifyPoint(layout, 110, 60);
  assert.equal(c.kind, "unpositioned");
  assert.equal(c.kind === "unpositioned" ? c.empty : undefined, empty);
  // 앞쪽 가장 가까운 문서 런이 글이 있는 런이면 후보가 아니다
  const c2 = classifyPoint({ runs: [empty, run("글", 300, 50, 4, 5), guide] }, 110, 60);
  assert.equal(c2.kind === "unpositioned" ? c2.empty : "x", undefined);
});

test("classifyPoint: 글자가 겹친 런이 둘 이상이면 overlap — 같은 문단이면 sameParagraph, 다른 문단·좌표 없는 글·머리말 글과 겹치면 아니다", () => {
  const a = run("가나다", 100, 50, 1, 0);
  const sameCell = run("라마", 120, 50, 1, 5);
  const other = run("바사", 120, 50, 2, 0);
  const cellRun = run("아자", 120, 50, 1, 0, { parentParaIdx: 9, cellPath: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] });
  const loose = run("차카", 120, 50);
  const marker = run("타파", 120, 50, MARKER_PARA_MIN);

  const same = classifyPoint({ runs: [a, sameCell] }, 125, 60);
  assert.deepEqual(same.kind === "overlap" ? [same.sameParagraph, same.marker, same.first?.run === a] : [], [true, false, true]);
  const diff = classifyPoint({ runs: [a, other] }, 125, 60);
  assert.deepEqual(diff.kind === "overlap" ? [diff.sameParagraph, diff.marker] : [], [false, false]);
  const cell = classifyPoint({ runs: [a, cellRun] }, 125, 60);
  assert.deepEqual(cell.kind === "overlap" ? cell.sameParagraph : "x", false, "본문 문단과 표 칸 문단은 다른 문단이다");
  const withLoose = classifyPoint({ runs: [a, loose] }, 125, 60);
  assert.deepEqual(withLoose.kind === "overlap" ? [withLoose.sameParagraph, withLoose.first?.run === a] : [], [false, true]);
  const withMarker = classifyPoint({ runs: [a, marker] }, 125, 60);
  assert.deepEqual(withMarker.kind === "overlap" ? [withMarker.sameParagraph, withMarker.marker] : [], [false, true]);
  assert.equal(glyphsAt({ runs: [a, other] }, 125, 60).length, 2);
  // 같은 문단의 빈 런·다른 문단의 빈 런은 겹침이 아니다
  const wideEmpty = run("", 90, 50, 2, 0, { w: 400 });
  assert.equal(classifyPoint({ runs: [wideEmpty, a] }, 125, 60).kind, "glyph");
});

test("nearestLineRun: 행 우선 — 점의 높이를 담는 런이 있으면 그 가운데 가로로 가장 가까운 런. 더 길게 뻗은 아랫줄이 평면 거리로 더 가까워도 뽑히지 않는다", () => {
  const short = run("짧은 줄", 100, 50, 1, 0); // 100..130, 50..70
  const longer = run("아랫줄은 훨씬 더 길다 아랫줄은 훨씬 더 길다", 100, 72, 2, 0); // 100..~320, 72..92
  const layout: PageLayout = { runs: [short, longer] };
  // 점 (310, 60): 평면 거리는 아랫줄(dx 0, dy 12)이 짧은 줄(dx 180)보다 가깝지만 점의 높이는 짧은 줄의 범위 안이다
  assert.equal(nearestLineRun(layout, 310, 60), short);
  assert.equal(nearestLineRun(layout, 700, 60), short, "줄 끝 오른쪽 먼 곳");
  assert.equal(nearestLineRun(layout, 700, 80), longer);
  assert.equal(nearestLineRun({ runs: [] }, 1, 1), undefined);
  // 같은 줄의 런이 여럿이면 가로로 가장 가까운 것
  const left = run("왼쪽", 100, 50, 1, 0);
  const right = run("오른쪽", 400, 50, 3, 0);
  assert.equal(nearestLineRun({ runs: [left, right] }, 150, 60), left);
  assert.equal(nearestLineRun({ runs: [left, right] }, 380, 60), right);
  assert.equal(nearestLineRun({ runs: [left, right] }, 700, 60), right);
  // 문서 좌표 없는 런(쪽 번호 등)과 머리말 글은 줄 후보가 아니다
  assert.equal(nearestLineRun({ runs: [run("- 1 -", 100, 50), run("머리", 100, 50, MARKER_PARA_MIN)] }, 120, 60), undefined);
  // 가로 거리가 같으면(점이 겹친 두 런 안) 런 가운데가 더 가까운 쪽: 칸 폭만큼 넓은 빈 런보다 글이 있는 런
  const wideEmpty = run("", 100, 50, 4, 0, { w: 500 });
  assert.equal(nearestLineRun({ runs: [wideEmpty, left] }, 120, 60), left);
});

test("nearestLineRun: 점의 높이를 담는 런이 없으면 세로로 가장 가까운 줄(세로 범위가 절반 넘게 겹치는 런 묶음)에서 가로로 가장 가까운 런", () => {
  const upper = run("윗줄", 100, 50, 1, 0); // 50..70
  const lowerA = run("아랫줄 왼쪽", 100, 90, 2, 0); // 90..110
  const lowerB = run("아랫줄 오른쪽", 400, 92, 3, 0, { h: 16 }); // 92..108(같은 줄, 높이가 다르다)
  const layout: PageLayout = { runs: [upper, lowerA, lowerB] };
  assert.equal(nearestLineRun(layout, 150, 73), upper, "줄 간격에서 윗줄이 더 가깝다");
  assert.equal(nearestLineRun(layout, 150, 87), lowerA, "줄 간격에서 아랫줄이 더 가깝다");
  assert.equal(nearestLineRun(layout, 380, 87), lowerB, "아랫줄의 같은 줄 런 가운데 가로로 가까운 쪽");
  assert.equal(nearestLineRun(layout, 300, 10), upper, "첫 줄 위 여백");
  assert.equal(nearestLineRun(layout, 300, 500), lowerB, "마지막 줄 아래 여백: 그 줄에서 가로로 가까운 런");
  assert.equal(nearestLineRun(layout, 120, 500), lowerA);
});

test("nearestRunOf: 가장 가까운 줄의 런이 rhwp가 가리킨 문단의 것일 때만 그 런을 돌려준다", () => {
  const short = run("짧은 줄", 100, 50, 1, 0);
  const longer = run("아랫줄은 훨씬 더 길다 아랫줄은 훨씬 더 길다", 100, 72, 2, 0);
  const layout: PageLayout = { runs: [short, longer] };
  const para = (paragraphIndex: number) => ({ sectionIndex: 0, paragraphIndex, charOffset: 0 });
  assert.equal(nearestRunOf(layout, para(1), 310, 60), short);
  assert.equal(nearestRunOf(layout, para(2), 310, 60), undefined, "같은 높이 줄이 아닌 문단");
  assert.equal(nearestRunOf(layout, para(2), 310, 82), longer);
  assert.equal(nearestRunOf(layout, para(7), 310, 60), undefined, "그 문단의 런이 쪽에 없다");
});

test("nearestLineRuns: nearestLineRun을 되풀이한 순서(점의 높이를 담는 줄에서 가로로 가까운 런부터, 다음에 세로로 가까운 줄)이고 limit개까지다", () => {
  const layout: PageLayout = {
    runs: [run("가", 0, 100, 0), run("나다", 200, 100, 1), run("라", 0, 140, 2), run("마", 100, 300, 3)],
  };
  const order = (x: number, y: number, limit: number): string[] => nearestLineRuns(layout, x, y, limit).map((r) => r.text);
  // 점(190, 110): 같은 줄의 `나다`(가로 거리 10)가 `가`(180)보다 먼저, 다음 줄 `라`, 마지막 `마`
  assert.deepEqual(order(190, 110, 10), ["나다", "가", "라", "마"]);
  assert.deepEqual(order(190, 110, 2), ["나다", "가"]);
  assert.equal(order(190, 110, 1)[0], nearestLineRun(layout, 190, 110)?.text);
  assert.deepEqual(nearestLineRuns({ runs: [] }, 0, 0, 5), []);
});
