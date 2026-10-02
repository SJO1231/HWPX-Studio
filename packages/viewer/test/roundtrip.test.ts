// V3 왕복: 엔진 주소 → rhwp 위치 → 화면 사각형 → 그 사각형 안을 누름 → 같은 위치.
// 사각형은 글자 배치의 `x + charX`와 런의 `y/h`로 만든다. 글자 사각형의 왼쪽 4분의 1 지점을 누른다(한가운데는 경계가 모호하다: 아래 시험).
// 모든 글자를 누른다(다른 런과 겹친 자리도 뺀 것이 없다): 실제 클릭 경로(`pick` → `locatePicked`)는 같은 주소로 돌아오거나, 글자가 겹친 자리면 char가 아니고 사유(OVERLAPPING_RUNS)가 있다.
// rhwp의 `hitTest` 왕복은 다른 런(빈 칸 런 포함)이 겹치지 않은 점에서만 본다(겹친 자리의 hitTest는 겹친 런 쪽으로 가기도 한다).
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { paragraphAtAddress, toEngineAddress, toRhwpPosition, type RhwpPosition } from "../src/map/index.ts";
import { charRect, glyphsAt, hasDocCoords, openDocument, runLength, runPosition, samePosition, type HitRegion } from "../src/rhwp/index.ts";
import { clickAt } from "../tools/verify.ts";
import { ensureRhwp, fixtureNames, parse, readFixture, syntheticDocs } from "./helpers.ts";

before(ensureRhwp);

type Tally = {
  chars: number;
  centerChecked: number;
  /** 다른 런(빈 칸 런 포함)의 사각형이 겹친 점(hitTest 왕복에서 뺀다) */
  overlapped: number;
  /** 글자가 겹친 점: 클릭 경로가 char가 아니고 OVERLAPPING_RUNS여야 한다 */
  glyphOverlap: number;
  /** 클릭 경로가 `toEngineAddress`와 같은 주소로 돌아온 점 */
  clickSame: number;
  mapBack: number;
  hitSame: number;
  skipped: number;
  centerSame: number;
  centerNext: number;
  centerOther: number;
  regions: Record<string, number>;
};
const emptyTally = (): Tally => ({ chars: 0, centerChecked: 0, overlapped: 0, glyphOverlap: 0, clickSame: 0, mapBack: 0, hitSame: 0, skipped: 0, centerSame: 0, centerNext: 0, centerOther: 0, regions: {} });

function roundTrip(bytes: Uint8Array, label: string, tally: Tally): void {
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    for (let page = 0; page < rdoc.pageCount(); page++) {
      const layout = rdoc.pageLayout(page);
      for (const run of layout.runs) {
        if (!hasDocCoords(run)) continue;
        const start = runPosition(run);
        assert.ok(start !== undefined);
        const chars = Array.from(run.text);
        for (let i = 0; i < chars.length; i++) {
          const rect = charRect(run, i);
          if (rect.w < 0.5) {
            tally.skipped++; // 폭이 없는 글자(결합 부호 등)는 누를 자리가 없다
            continue;
          }
          const px = rect.x + rect.w * 0.25;
          const py = rect.y + rect.h / 2;
          const overlapped = layout.runs.some((o) => o !== run && px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h);
          if (overlapped) tally.overlapped++;
          tally.chars++;
          const pos: RhwpPosition = { ...start, charOffset: start.charOffset + i };
          // 1) rhwp 위치 → 엔진 주소(글 확인 포함)
          const located = toEngineAddress(doc, pos, { text: run.text, start: start.charOffset });
          assert.equal(located.precision, "char", `${label} 쪽 ${page}: ${JSON.stringify(chars[i])} ${located.reason}`);
          // 2) 엔진 주소 → rhwp 위치 (처음 위치와 같아야 한다)
          const back = toRhwpPosition(doc, located.address as NonNullable<typeof located.address>);
          assert.ok(back !== undefined && samePosition(back, pos), `${label} 쪽 ${page}: 주소에서 돌아온 위치가 다르다 ${JSON.stringify([pos, back])}`);
          tally.mapBack++;
          // 3) 화면 사각형 → 클릭 경로 → 같은 주소. 글자가 겹친 점이면 char가 아니고 사유가 있다
          const click = clickAt(rdoc, doc, page, px, py);
          if (glyphsAt(layout, px, py).length > 1) {
            tally.glyphOverlap++;
            assert.notEqual(click.precision, "char", `${label} 쪽 ${page}: 겹친 글자 ${JSON.stringify(chars[i])}가 char로 나왔다`);
            assert.equal(click.reason, "OVERLAPPING_RUNS", `${label} 쪽 ${page}: ${JSON.stringify(click)}`);
          } else {
            assert.equal(click.precision, "char", `${label} 쪽 ${page}: ${JSON.stringify(chars[i])}: ${click.reason}`);
            assert.deepEqual(click.address, located.address, `${label} 쪽 ${page}: ${JSON.stringify(chars[i])}의 클릭 주소가 다르다`);
            tally.clickSame++;
          }
          // 4) 화면 사각형 → hitTest → 같은 위치(다른 런과 겹치지 않은 점에서만)
          if (overlapped) continue;
          const hit = rdoc.hit(page, px, py);
          tally.regions[hit.region] = (tally.regions[hit.region] ?? 0) + 1;
          if (hit.position !== undefined && samePosition(hit.position, pos)) tally.hitSame++;
          else assert.fail(`${label} 쪽 ${page}: ${JSON.stringify(chars[i])}의 사각형을 눌렀는데 ${JSON.stringify(hit)}가 나왔다(기대 ${JSON.stringify(pos)})`);
          // 사각형 한가운데: 경계가 모호하다. rhwp는 오른쪽 경계(다음 순번)를 줄 수 있다
          if (tally.chars % 3 !== 0) continue;
          const center = rdoc.hit(page, rect.x + rect.w / 2, rect.y + rect.h / 2);
          tally.centerChecked++;
          if (center.position !== undefined && samePosition(center.position, pos)) tally.centerSame++;
          else if (center.position !== undefined && samePosition(center.position, { ...pos, charOffset: pos.charOffset + 1 })) tally.centerNext++;
          else tally.centerOther++;
          // 주소의 문단이 실제로 있다
          assert.ok(paragraphAtAddress(doc, located.address as NonNullable<typeof located.address>) !== undefined);
        }
      }
    }
  } finally {
    rdoc.free();
  }
}

test("V3: 시험 문서 전부의 모든 글자 — 주소 왕복과 hitTest 왕복이 100%", (t) => {
  const tally = emptyTally();
  for (const name of fixtureNames()) roundTrip(readFixture(name), name, tally);
  assert.ok(tally.chars > 1500, `글자 표본이 너무 적다: ${tally.chars}`);
  assert.equal(tally.mapBack, tally.chars);
  assert.equal(tally.clickSame + tally.glyphOverlap, tally.chars, "모든 글자는 같은 주소로 돌아오거나 겹침 사유로 char가 아니어야 한다");
  assert.ok(tally.glyphOverlap > 0, "겹친 글자 표본이 있어야 한다(D4 등)");
  assert.equal(tally.hitSame, tally.chars - tally.overlapped);
  t.diagnostic(`시험 문서 22건 글자 ${tally.chars}(폭 없음 ${tally.skipped}): 주소 왕복 ${tally.mapBack}, 클릭 경로 같은 주소 ${tally.clickSame} + 글자 겹침으로 char 아님 ${tally.glyphOverlap}, hitTest 왕복 ${tally.hitSame}(다른 런과 겹친 ${tally.overlapped}는 제외), 영역 ${JSON.stringify(tally.regions)}, 한가운데(표본 ${tally.centerChecked}) → 같은 칸 ${tally.centerSame} / 다음 칸 ${tally.centerNext} / 그 밖 ${tally.centerOther}`);
});

test("V3: 합성 문서(탭·줄바꿈·대리쌍·글자처럼 취급 개체·누름틀·자동 번호·글상자·캡션·각주)도 100%", (t) => {
  const tally = emptyTally();
  for (const [name, bytes] of Object.entries(syntheticDocs())) roundTrip(bytes, name, tally);
  assert.ok(tally.chars > 80);
  assert.equal(tally.clickSame + tally.glyphOverlap, tally.chars);
  assert.equal(tally.hitSame, tally.chars - tally.overlapped);
  for (const region of ["body", "cell", "textbox"] satisfies HitRegion[]) assert.ok((tally.regions[region] ?? 0) > 0, `${region} 영역 표본이 없다 ${JSON.stringify(tally.regions)}`);
  t.diagnostic(`합성 문서 글자 ${tally.chars}(폭 없음 ${tally.skipped}): 주소 왕복 ${tally.mapBack}, hitTest 왕복 ${tally.hitSame}, 영역 ${JSON.stringify(tally.regions)}`);
});

test("V3: 글자의 사각형 한가운데를 누르면 같은 칸 또는 오른쪽 경계(다음 칸)가 나온다 — 그 밖은 없다", () => {
  const tally = emptyTally();
  roundTrip(readFixture("D1"), "D1", tally);
  roundTrip(readFixture("hancom/ph-table"), "ph-table", tally);
  assert.equal(tally.centerOther, 0, JSON.stringify(tally));
  assert.equal(tally.centerSame + tally.centerNext, tally.centerChecked);
  assert.ok(tally.centerChecked > 100);
});

test("V3: 런의 글자 수 = charX 길이 - 1 (대리쌍은 한 글자로 센다)", () => {
  const doc = openDocument(syntheticDocs()["합성-이모지"] as Uint8Array);
  try {
    for (const run of doc.pageLayout(0).runs) assert.equal(run.charX.length, runLength(run) + 1, JSON.stringify(run.text));
  } finally {
    doc.free();
  }
});
