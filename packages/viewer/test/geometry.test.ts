// V6 시뮬레이션: 배율 50%·100%·150%에서 화면 좌표 → 쪽 좌표 → 클릭 위치가 같은 글자를 가리키고, 강조 사각형이 글자 위에 맞는다.
// (브라우저에서 보는 확인은 총괄이 따로 한다. 여기서는 화면 좌표 변환·런 고르기·강조 사각형 계산을 Node에서 시험한다.)
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { MAX_SCALE, MIN_SCALE, clampScale, toPagePoint, toScreenRect } from "../src/dom/index.ts";
import { caretAt, charRect, glyphsAt, guideRect, hasDocCoords, insideAny, openDocument, rangeCover, rangeRects, regionBoxes, runLength, runPosition, samePosition } from "../src/rhwp/index.ts";
import { ensureRhwp, readFixture, syntheticDocs } from "./helpers.ts";

before(ensureRhwp);

test("배율은 50~200% 안으로 맞춘다", () => {
  assert.equal(MIN_SCALE, 0.5);
  assert.equal(MAX_SCALE, 2);
  assert.equal(clampScale(0.1), 0.5);
  assert.equal(clampScale(9), 2);
  assert.equal(clampScale(1.5), 1.5);
  assert.equal(clampScale(Number.NaN), 1);
});

test("V6: 배율 50%·100%·150%에서 눌린 글자가 같다(쪽 요소의 화면 위치가 어디여도)", () => {
  const origins = [{ left: 0, top: 0 }, { left: 37.5, top: -420.25 }];
  for (const name of ["hancom/ph-single", "hancom/ph-table", "D1", "tables/tables-nested"]) {
    const doc = openDocument(readFixture(name));
    try {
      let checked = 0;
      for (let page = 0; page < doc.pageCount(); page++) {
        const layout = doc.pageLayout(page);
        for (const run of layout.runs) {
          const start = runPosition(run);
          if (start === undefined || run.text === "") continue;
          // 런마다 첫·가운데·마지막 글자만(전부는 V3가 본다)
          const n = runLength(run);
          for (const i of new Set([0, Math.floor(n / 2), n - 1])) {
            const rect = charRect(run, i);
            if (rect.w < 0.5) continue;
            const x = rect.x + rect.w * 0.25;
            const y = rect.y + rect.h / 2;
            if (layout.runs.some((o) => o !== run && x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h)) continue;
            const want = { ...start, charOffset: start.charOffset + i };
            for (const scale of [0.5, 1, 1.5]) {
              for (const box of origins) {
                // 화면에서 그 점을 누른 것으로 본다
                const client = { x: box.left + x * scale, y: box.top + y * scale };
                const point = toPagePoint(client, box, scale);
                assert.ok(Math.abs(point.x - x) < 1e-9 && Math.abs(point.y - y) < 1e-9, "화면 → 쪽 좌표가 되돌아오지 않는다");
                const hit = doc.hit(page, point.x, point.y);
                assert.ok(hit.position !== undefined && samePosition(hit.position, want), `${name} 배율 ${scale}: ${JSON.stringify(hit)} (기대 ${JSON.stringify(want)})`);
                // 확인할 런이 눌린 글자의 런이고, 위치는 그 런의 위치(런 안 글자 순번을 더한 것)다
                const picked = doc.pick(page, point.x, point.y);
                assert.equal(picked.shown?.text, run.text);
                assert.equal(picked.shown?.start, start.charOffset);
                assert.equal(picked.guide, false);
                assert.ok(picked.hit.position !== undefined && samePosition(picked.hit.position, want), `${name} 배율 ${scale}: pick ${JSON.stringify(picked.hit)}`);
              }
            }
            checked++;
          }
        }
      }
      assert.ok(checked > 5, `${name}: 표본이 적다`);
    } finally {
      doc.free();
    }
  }
});

test("V6: 강조 사각형은 글자 위에 맞는다 — 런이 갈라져도 런마다 사각형이 하나이고, 배율을 곱한 사각형의 중심을 되돌리면 글자 사각형 안이다", () => {
  const doc = openDocument(readFixture("hancom/ph-single"));
  try {
    const layout = doc.pageLayout(0);
    // 문단 1: `사업명: {{project.name}} 입니다.` — rhwp는 `{{` 앞에서 런을 가른다(`사업명: {{` 0..7, `project.name}} ` 7..22)
    const para = { sectionIndex: 0, paragraphIndex: 1, charOffset: 5 };
    const first = layout.runs.find((r) => r.text === "사업명: {{");
    const second = layout.runs.find((r) => r.text === "project.name}} ");
    assert.ok(first !== undefined && second !== undefined);
    // `{{project.name}}` = 글자 순번 5..21
    const rects = rangeRects(layout, para, 5, 21);
    assert.equal(rects.length, 2);
    assert.ok(Math.abs((rects[0]?.x ?? 0) - (first.x + (first.charX[5] ?? 0))) < 1e-9);
    assert.ok(Math.abs((rects[0]?.x ?? 0) + (rects[0]?.w ?? 0) - (first.x + (first.charX[7] ?? 0))) < 1e-9, "첫 사각형은 첫 런의 끝까지");
    assert.ok(Math.abs((rects[1]?.x ?? 0) - second.x) < 1e-9, "둘째 사각형은 둘째 런의 처음부터");
    assert.ok(Math.abs((rects[1]?.x ?? 0) + (rects[1]?.w ?? 0) - (second.x + (second.charX[14] ?? 0))) < 1e-9);
    assert.equal(rects[0]?.y, first.y);
    assert.equal(rects[0]?.h, first.h);
    for (const scale of [0.5, 1, 1.5]) {
      for (const r of rects) {
        const s2 = toScreenRect(r, scale);
        const back = toPagePoint({ x: s2.x + s2.w / 2, y: s2.y + s2.h / 2 }, { left: 0, top: 0 }, scale);
        assert.ok(Math.abs(back.x - (r.x + r.w / 2)) < 1e-6 && Math.abs(back.y - (r.y + r.h / 2)) < 1e-6);
        assert.ok(Math.abs(s2.w - r.w * scale) < 1e-9 && Math.abs(s2.h - r.h * scale) < 1e-9);
      }
    }
    // 범위 밖·다른 문단·빈 범위는 사각형이 없다
    assert.deepEqual(rangeRects(layout, { ...para, paragraphIndex: 7 }, 0, 3), []);
    assert.deepEqual(rangeRects(layout, para, 3, 3), []);
    // 캐럿 위치: 글자 경계의 x
    const c = caretAt(layout, para, 9);
    assert.ok(c !== undefined && Math.abs(c.x - (second.x + (second.charX[2] ?? 0))) < 1e-9);
  } finally {
    doc.free();
  }
});

test("안내문(문서 좌표 없이 그려진 글)을 누르면 안내문 후보(guide)이고, 위치는 그 자리의 빈 런이다. 안내문 사각형을 찾는다", () => {
  const doc = openDocument(syntheticDocs()["합성-안내문 누름틀"] as Uint8Array);
  try {
    const layout = doc.pageLayout(0);
    const guide = layout.runs.find((r) => !hasDocCoords(r) && r.text === "소속 입력");
    assert.ok(guide !== undefined);
    const picked = doc.pick(0, guide.x + guide.w / 2, guide.y + guide.h / 2);
    assert.equal(picked.guide, true);
    assert.equal(picked.guideText, "소속 입력");
    assert.equal(picked.limit, "char", "엔진의 안내문 상태 누름틀과 맞는지는 서버가 정한다");
    assert.ok(picked.hit.position !== undefined);
    assert.deepEqual(picked.shown, { text: "", start: picked.hit.position.charOffset }, "확인할 런은 안내문이 놓인 자리의 빈 문서 런이다");
    const under = glyphsAt(layout, guide.x + 1, guide.y + 1);
    assert.deepEqual(under.map((g) => g.run), [guide]);
    const rect = guideRect(layout, picked.hit.position, picked.hit.position.charOffset, "소속 입력");
    assert.deepEqual(rect, { x: guide.x, y: guide.y, w: guide.w, h: guide.h });
    assert.equal(guideRect(layout, picked.hit.position, picked.hit.position.charOffset, "다른 안내"), undefined);
  } finally {
    doc.free();
  }
});

test("강조 구간이 덮는 글: rangeCover는 런마다 잘라 이은 글을 돌려준다", () => {
  const doc = openDocument(readFixture("hancom/ph-single"));
  try {
    const layout = doc.pageLayout(0);
    const para = { sectionIndex: 0, paragraphIndex: 1, charOffset: 5 };
    const cover = rangeCover(layout, para, 5, 21);
    assert.equal(cover.text, "{{project.name}}");
    assert.deepEqual(cover.rects, rangeRects(layout, para, 5, 21));
    assert.deepEqual(rangeCover(layout, para, 3, 3), { rects: [], text: "" });
  } finally {
    doc.free();
  }
});

test("영역별 글의 사각형: 렌더 트리에서 바탕쪽·본문·머리말·꼬리말·각주 노드 아래 TextRun만 모은다", () => {
  const tree = {
    type: "Page",
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    children: [
      { type: "PageBg", bbox: { x: 0, y: 0, w: 100, h: 100 } },
      { type: "MasterPage", bbox: { x: 0, y: 0, w: 100, h: 100 }, children: [{ type: "Group", children: [{ type: "TextBox", children: [{ type: "TextLine", children: [{ type: "TextRun", bbox: { x: 10, y: 10, w: 5, h: 12 }, text: "1" }] }] }] }] },
      { type: "Body", children: [{ type: "Column", children: [{ type: "Table", children: [{ type: "Cell", children: [{ type: "TextLine", children: [{ type: "TextRun", bbox: { x: 40, y: 50, w: 20, h: 10 }, text: "본문" }] }] }] }] }] },
      { type: "Footer", children: [{ type: "TextRun", bbox: { x: 1, y: 90, w: 3, h: 3 }, text: "꼬리" }] },
    ],
  };
  const boxes = regionBoxes(tree);
  assert.deepEqual(boxes.master, [{ x: 10, y: 10, w: 5, h: 12 }]);
  assert.deepEqual(boxes.body, [{ x: 40, y: 50, w: 20, h: 10 }]);
  assert.ok(insideAny(boxes.master, 12, 15) && !insideAny(boxes.master, 50, 55) && insideAny(boxes.body, 50, 55));
  assert.deepEqual(boxes.footer, [{ x: 1, y: 90, w: 3, h: 3 }], "머리말·꼬리말·각주 영역의 글도 모은다");
  // 글이 빈 TextRun(머리말이 비어 있어도 영역 폭만큼 넓게 나온다)은 모으지 않는다
  const withEmpty = regionBoxes({ type: "Page", children: [{ type: "Header", children: [{ type: "TextLine", children: [{ type: "TextRun", bbox: { x: 0, y: 0, w: 600, h: 12 }, text: "" }] }] }] });
  assert.deepEqual(withEmpty.header, []);
  assert.deepEqual([boxes.header, boxes.footnote], [[], []]);
  const empty = { master: [], body: [], header: [], footer: [], footnote: [] };
  assert.deepEqual(regionBoxes(null), empty);
  assert.deepEqual(regionBoxes({ type: "MasterPage", children: "x" }), empty);
});
