// rhwp의 쪽 글자 배치는 런의 첫 글자 순번(`charStart`)을 개체(글자처럼 취급 그림 등)를 세는 정도가 런마다 다르게 낸다 [실행 관측].
// 런을 엔진 글자에 맞추는 규칙(글이 같고, 개체가 끼지 않고, 순번이 [글자 순번, 글자 순번 + 앞 개체 수] 안인 자리가 하나뿐)이
// 이런 문단에서도 맞는 자리를 고르거나 문단 단위로 내려가는지(조용히 틀리지 않는지) 본다.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { locatePicked, offsetTable, toEngineAddress, toRhwpPosition } from "../src/map/index.ts";
import { hasDocCoords, openDocument, runLength, runPosition, type LayoutRun } from "../src/rhwp/index.ts";
import { engineTextAt } from "../tools/verify.ts";
import { FIELD_BEGIN, FIELD_END, PIC, P, R, T, ensureRhwp, parse, synth } from "./helpers.ts";

before(ensureRhwp);

const BODY = 1;

function runsOf(bytes: Uint8Array): LayoutRun[] {
  const doc = openDocument(bytes);
  try {
    return doc.pageLayout(0).runs.filter((r) => hasDocCoords(r) && r.paraIdx === BODY && r.cellPath === undefined && r.text !== "");
  } finally {
    doc.free();
  }
}

test("그림 뒤에서 글자 모양이 바뀐 런: rhwp는 첫 글자 순번을 그림을 세지 않고 내지만, 런의 글로 엔진 자리를 찾는다", () => {
  const bytes = synth([P(R(PIC("1") + T("가나다")) + R(T("라마바"), "1"))]);
  const doc = parse(bytes);
  const runs = runsOf(bytes);
  // rhwp: 가나다=1(그림 한 개를 센 값), 라마바=3(그림을 세지 않은 글자 순번). 개체를 모두 센 칸 순번이면 라마바는 4다.
  assert.deepEqual(runs.map((r) => [r.text, r.charStart]), [["가나다", 1], ["라마바", 3]]);
  const t = offsetTable(doc.sections[0]?.paragraphs[BODY] as never);
  assert.deepEqual(t.chars.map((c) => [c.slot, c.objBefore]), [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]]);

  const second = runs[1] as LayoutRun;
  const pos = runPosition(second);
  assert.ok(pos !== undefined);
  const at = toEngineAddress(doc, { ...pos, charOffset: pos.charOffset + 1 }, { text: second.text, start: pos.charOffset });
  assert.equal(at.precision, "char", String(at.reason));
  // 논리 텍스트 `￼가나다라마바`: `마`는 6번(0: 그림)
  assert.equal(at.address?.offset, 5);
  assert.equal(doc.sections[0]?.paragraphs[BODY]?.logicalText[5], "마");
  // 주소를 칸 순번으로 되돌리면 개체를 모두 센 순번(5)이다(rhwp의 런 순번 3+1과 다르다)
  assert.equal(toRhwpPosition(doc, at.address as NonNullable<typeof at.address>)?.charOffset, 5);
});

test("같은 글이 허용 구간에 둘 이상이면 AMBIGUOUS_RUN으로 문단 단위로 내려간다(둘 중 하나를 고르지 않는다)", () => {
  // 글꼴이 다른 런이 같은 글자 `가`를 반복: 순번 구간이 겹쳐 하나로 정할 수 없다
  const bytes = synth([P(R(T("가") + PIC("1") + T("가")) + R(T("가"), "1"))]);
  const doc = parse(bytes);
  for (const r of runsOf(bytes)) {
    const pos = runPosition(r);
    assert.ok(pos !== undefined);
    const at = toEngineAddress(doc, pos, { text: r.text, start: pos.charOffset });
    if (at.precision === "char") {
      assert.equal(engineTextAt(doc.sections[0]?.paragraphs[BODY] as never, at.address?.offset ?? -1, runLength(r)), r.text);
    } else {
      assert.equal(at.reason, "AMBIGUOUS_RUN");
    }
  }
});

// ── 무작위 합성 문단(시드 고정) ─────────────────────────────────────

type Item = { k: "t"; s: string } | { k: "pic" } | { k: "bm" } | { k: "tab" };

function paragraphs(seed0: number, count: number): Item[][][] {
  let seed = seed0;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const words = ["가나", "다", "라마바", "사", "AB", "cd", "아자차", "1", "x y", "한글 text 섞임"];
  const out: Item[][][] = [];
  for (let n = 0; n < count; n++) {
    const runs: Item[][] = [];
    for (let r = 0, nr = 1 + Math.floor(rnd() * 5); r < nr; r++) {
      const items: Item[] = [];
      for (let i = 0, ni = Math.floor(rnd() * 5); i < ni; i++) {
        const x = rnd();
        items.push(x < 0.5 ? { k: "t", s: words[Math.floor(rnd() * words.length)] ?? "가" } : x < 0.85 ? { k: "pic" } : x < 0.93 ? { k: "bm" } : { k: "tab" });
      }
      runs.push(items);
    }
    out.push(runs);
  }
  return out;
}

const xmlOf = (m: Item[][]): string =>
  P(
    m
      .map((run, ri) =>
        R(
          run.map((it) => (it.k === "t" ? T(it.s) : it.k === "tab" ? `<hp:t><hp:tab width="1000" leader="0" type="1"/></hp:t>` : it.k === "pic" ? PIC("1") : `<hp:ctrl><hp:bookmark name="b${ri}"/></hp:ctrl>`)).join(""),
          ri % 2 === 0 ? "0" : "1",
        ),
      )
      .join(""),
  );

test("무작위 합성 문단 300개(그림·탭·책갈피·글자 모양 바뀜): char로 옮긴 런은 엔진 글과 모두 같고, 못 옮긴 런은 모호·개체 런(과 개체가 셋 이상 이어진 문단)뿐이다", (t) => {
  const stats = { runs: 0, char: 0, ambiguous: 0, objectRun: 0, anomalous: 0, other: {} as Record<string, number>, shifted: 0 };
  for (const model of paragraphs(20261002, 300)) {
    if (!model.some((r) => r.some((i) => i.k === "t" || i.k === "tab"))) continue;
    const bytes = synth([xmlOf(model)]);
    const doc = parse(bytes);
    const p = doc.sections[0]?.paragraphs[BODY];
    assert.ok(p !== undefined);
    const all = runsOf(bytes);
    // 개체가 셋 이상 이어진 문단에서 rhwp는 개체를 객체 자리 글자(U+FFFC) 런으로 그리고 뒤의 순번도 어긋난다: 그런 문단은 문단으로 내려가도 된다
    const anomalous = all.some((r) => r.text.includes("￼"));
    for (const run of all) {
      const pos = runPosition(run);
      assert.ok(pos !== undefined);
      stats.runs++;
      // 런의 모든 글자 위치에서 확인한다(첫 글자만이 아니라)
      const n = runLength(run);
      for (const delta of new Set([0, Math.floor(n / 2), n])) {
        const at = toEngineAddress(doc, { ...pos, charOffset: pos.charOffset + delta }, { text: run.text, start: pos.charOffset });
        if (delta !== 0) continue;
        if (at.precision === "char") {
          stats.char++;
          const offset = at.address?.offset ?? -1;
          assert.equal(engineTextAt(p, offset, n), run.text, `조용한 불일치: ${JSON.stringify(model)} 런 ${JSON.stringify([run.text, run.charStart])}`);
          const back = toRhwpPosition(doc, at.address as NonNullable<typeof at.address>);
          if (back !== undefined && back.charOffset !== pos.charOffset) stats.shifted++;
        } else if (at.reason === "AMBIGUOUS_RUN") stats.ambiguous++;
        else if (at.reason === "OBJECT_RUN") stats.objectRun++;
        else if (anomalous && (at.reason === "TEXT_MISMATCH" || at.reason === "PARAGRAPH_MISMATCH")) stats.anomalous++;
        else stats.other[String(at.reason)] = (stats.other[String(at.reason)] ?? 0) + 1;
      }
      // 같은 런 안 다른 글자를 눌러도 같은 런에서 한 글자씩 뒤(엔진 글자 순서)다
      if (n >= 2) {
        const a0 = toEngineAddress(doc, pos, { text: run.text, start: pos.charOffset });
        const a1 = toEngineAddress(doc, { ...pos, charOffset: pos.charOffset + 1 }, { text: run.text, start: pos.charOffset });
        if (a0.precision === "char" && a1.precision === "char") {
          const first = Array.from(run.text)[0] ?? "";
          // 두 오프셋 사이의 엔진 글(폭 0 객체 자리 글자는 뺀다)이 런의 첫 글자다
          assert.equal(p.logicalText.slice(a0.address?.offset ?? 0, a1.address?.offset ?? 0).replaceAll("￼", ""), first);
        }
      }
    }
  }
  assert.deepEqual(stats.other, {}, "모호·개체 런 말고는 문단으로 내려가면 안 된다");
  assert.ok(stats.runs > 500, `런이 적다 ${stats.runs}`);
  assert.ok(stats.char / stats.runs > 0.95, `char 비율 ${stats.char}/${stats.runs}`);
  assert.ok(stats.shifted > 50, "순번이 밀린 런이 표본에 있어야 이 시험이 의미가 있다");
  t.diagnostic(`런 ${stats.runs}: char ${stats.char}(그 가운데 순번이 밀린 런 ${stats.shifted}), 모호 ${stats.ambiguous}, 개체 런 ${stats.objectRun}, 개체 연속 문단의 어긋난 런 ${stats.anomalous}`);
});

// ── 리뷰 13: 그림 뒤 안내문 상태 누름틀 ─────────────────────────────

const GUIDE = "소속 입력";
const guideField = (id: string): string => FIELD_BEGIN(id, `필드${id}`, "0", GUIDE) + FIELD_END(id);

/** 안내문 상태 누름틀들의 안내문을 차례로 눌러(겹치지 않는 마지막 글자) 서버가 하는 대로 엔진 주소로 옮긴 결과 */
function guideClicks(para: string): { located: ReturnType<typeof locatePicked>; expected: number }[] {
  const bytes = synth([para]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const paragraph = doc.sections[0]?.paragraphs[BODY];
    assert.ok(paragraph !== undefined);
    const guides = offsetTable(paragraph).guides;
    const runs = rdoc.pageLayout(0).runs.filter((r) => !hasDocCoords(r) && r.text === GUIDE);
    assert.equal(runs.length, guides.length, "안내문마다 좌표 없는 런이 하나씩 그려진다");
    return runs.map((run, i) => {
      const picked = rdoc.pick(0, run.x + (run.charX[run.charX.length - 2] ?? 0) + 3, run.y + run.h / 2);
      assert.ok(picked.guide && picked.hit.position !== undefined && picked.limit === "char", `${i}번째 안내문을 눌렀다`);
      const located = locatePicked(doc, { position: picked.hit.position, ...(picked.shown === undefined ? {} : { shown: picked.shown }), guide: picked.guideText ?? "" }, "guide");
      return { located, expected: guides[i]?.logicalStart ?? -1 };
    });
  } finally {
    rdoc.free();
  }
}

test("리뷰 13: 글자처럼 취급 그림 뒤의 안내문 상태 누름틀 — 같은 글의 안내문이 문단에 하나뿐이면, rhwp가 그림을 덜 센 빈 런 순번이어도 그 안내문으로 옮긴다", () => {
  for (const [label, para] of [
    ["그림, 앞, 안내문", P(R(PIC("1") + T("앞") + guideField("12") + T("뒤 글")))],
    ["그림, 안내문", P(R(PIC("1") + guideField("12") + T("뒤 글")))],
    ["앞, 그림, 안내문", P(R(T("앞") + PIC("1") + guideField("12") + T("뒤 글")))],
    ["그림 둘, 안내문", P(R(PIC("1") + PIC("1") + guideField("12") + T("뒤 글")))],
    ["글자 모양이 다른 런들", P(R(PIC("1")) + R(T("앞"), "1") + R(guideField("12") + T("뒤 글")))],
  ] as const) {
    const [one] = guideClicks(para);
    assert.ok(one !== undefined);
    assert.equal(one.located.precision, "char", `${label}: ${String(one.located.reason)}`);
    assert.equal(one.located.address?.offset, one.expected, label);
  }
});

test("리뷰 13: 같은 글의 안내문 상태 누름틀이 둘 이상이면 순번 구간만으로 고르지 않는다 — 맞는 안내문이거나 문단 밖으로 거절(none)이고, 다른 안내문으로 옮기지 않는다", () => {
  for (const para of [
    P(R(PIC("1") + guideField("1") + T("중간") + guideField("2") + T("끝"))),
    P(R(PIC("1") + T("가") + guideField("1") + guideField("2") + T("끝"))),
  ]) {
    for (const { located, expected } of guideClicks(para)) {
      if (located.precision === "none") assert.equal(located.reason, "UNPOSITIONED_TEXT");
      else assert.equal(located.address?.offset, expected, "다른 안내문으로 조용히 옮겼다");
    }
  }
});
