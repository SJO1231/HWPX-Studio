// 오프셋 대응: 탭·줄바꿈·대리쌍·글자처럼 취급 개체·누름틀(값 있음/안내문)·자동 번호가 든 문단에서
// 엔진 논리 오프셋(UTF-16)과 rhwp 글자 순번의 대응표가 rhwp의 실제 쪽 글자 배치와 맞는지 본다.
// 기대값은 합성 문서의 원문(손으로 센 값)과 rhwp의 실제 배치(`charStart`)에서 만든다.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { HwpxDocument, ParagraphNode } from "../../hwpx-engine/src/index.ts";
import { controlSlots, hasNumbering, logicalOffsetAt, noteLabelStarts, offsetTable, rhwpOffsetAt, toEngineAddress, toRhwpPosition } from "../src/map/index.ts";
import { hasDocCoords, openDocument, runLength, runPosition, type LayoutRun } from "../src/rhwp/index.ts";
import { openPackage, readEntry, walkParagraphs } from "../../hwpx-engine/src/index.ts";
import { AUTO_NUM, BOOKMARK, CONTAINER, FIELD_BEGIN, FIELD_END, P, PIC, R, RECT, SUBLIST, T, TBL, SUBP, ensureRhwp, fixtureNames, parse, readFixture, synth, syntheticDocs } from "./helpers.ts";

before(ensureRhwp);

const BODY = 1; // 합성 문서의 첫 시험 문단(0번은 구역 설정이 든 문단)

function docOf(paragraph: string): { bytes: Uint8Array; doc: HwpxDocument; p: ParagraphNode; runs: LayoutRun[] } {
  const bytes = synth([P(R(paragraph))]);
  const doc = parse(bytes);
  const rdoc = openDocument(bytes);
  try {
    const runs = rdoc.pageLayout(0).runs.filter((r) => hasDocCoords(r) && r.paraIdx === BODY && r.cellPath === undefined);
    const p = doc.sections[0]?.paragraphs[BODY];
    assert.ok(p !== undefined);
    return { bytes, doc, p, runs };
  } finally {
    rdoc.free();
  }
}

/** 런마다 첫 글자 위치를 엔진 주소로 옮기고, 엔진 논리 텍스트의 그 자리 글이 런의 글과 같은지(객체 자리 글자는 건너뛰고) 본다. */
function eachRunLocated(doc: HwpxDocument, runs: LayoutRun[]): { run: LayoutRun; offset: number }[] {
  return runs.map((run) => {
    const pos = runPosition(run);
    assert.ok(pos !== undefined);
    const located = toEngineAddress(doc, pos, { text: run.text, start: pos.charOffset });
    assert.equal(located.precision, "char", `런 ${JSON.stringify(run.text)}: ${located.reason}`);
    return { run, offset: located.address?.offset ?? -1 };
  });
}

/** 모든 경계 `k`에서 엔진 오프셋으로 갔다가 돌아오면 같은 `k`다(폭 0 객체 앞뒤는 같은 `k`). */
function assertBoundariesRoundTrip(doc: HwpxDocument, p: ParagraphNode, edge: "start" | "end" = "start"): void {
  const t = offsetTable(p);
  for (let k = 0; k <= t.slots.length; k++) {
    const logical = logicalOffsetAt(t, k, edge);
    assert.ok(logical !== undefined, `k=${k}`);
    assert.equal(rhwpOffsetAt(t, logical), k, `k=${k} 논리 ${logical}에서 돌아오지 못했다`);
    const addr = { sectionIndex: 0, path: [BODY], offset: logical };
    assert.equal(toRhwpPosition(doc, addr)?.charOffset, k);
  }
}

test("탭·줄바꿈은 한 칸씩이고, 런의 글자 순번이 대응표와 맞는다", () => {
  const { doc, p, runs } = docOf(`<hp:t>가<hp:tab width="1000" leader="0" type="1"/>나<hp:lineBreak/>다 라</hp:t>`);
  assert.equal(p.logicalText, "가\t나\n다 라");
  const t = offsetTable(p);
  assert.deepEqual(
    t.slots.map((s) => [s.kind, s.shown]),
    [["text", "가"], ["inline", "\t"], ["text", "나"], ["inline", "\n"], ["text", "다"], ["text", " "], ["text", "라"]],
  );
  // rhwp의 실제 배치: 런 `가\t나`는 0, 줄바꿈이 3번을 차지하고 런 `다 라`는 4부터
  assert.deepEqual(runs.map((r) => [r.text, r.charStart]), [["가\t나", 0], ["다 라", 4]]);
  assert.deepEqual(eachRunLocated(doc, runs).map((x) => x.offset), [0, 4]);
  assertBoundariesRoundTrip(doc, p);
});

test("이모지 같은 대리쌍은 한 칸(UTF-16 두 단위), ZWJ 묶음은 글자 순번으로 구성 글자마다 센다", () => {
  const { doc, p, runs } = docOf(T("A😀B가👨‍👩‍👧끝"));
  const text = "A😀B가👨‍👩‍👧끝";
  assert.equal(p.logicalText, text);
  const t = offsetTable(p);
  assert.equal(t.slots.length, 10);
  assert.equal(text.length, 14);
  // 😀는 칸 1개이지만 UTF-16으로 두 단위: 순번 2의 B는 논리 3
  assert.equal(logicalOffsetAt(t, 2), 3);
  assert.equal(rhwpOffsetAt(t, 3), 2);
  assert.equal(rhwpOffsetAt(t, 2), undefined, "대리쌍 한가운데는 경계가 아니다");
  assert.equal(logicalOffsetAt(t, 9), 13, "끝");
  // rhwp: 코드 포인트 하나가 한 칸. `끝`의 charStart는 9
  const last = runs.find((r) => r.text.includes("끝"));
  assert.equal((last?.charStart ?? -1) + Array.from(last?.text ?? "").indexOf("끝"), 9);
  assert.ok(eachRunLocated(doc, runs).every((x) => x.offset >= 0));
  assertBoundariesRoundTrip(doc, p);
});

test("고정폭 공백·붙임표 같은 인라인 문자도 한 칸이다", () => {
  const { doc, p, runs } = docOf(`<hp:t>가<hp:nbSpace/>나<hp:fwSpace/>다<hp:hyphen/>라</hp:t>`);
  assert.equal(p.logicalText, "가 나 다­라");
  assert.equal(offsetTable(p).slots.length, 7);
  assert.deepEqual(runs.map((r) => runLength(r)), [7]);
  assert.equal(eachRunLocated(doc, runs)[0]?.offset, 0);
  assertBoundariesRoundTrip(doc, p);
});

test("글자처럼 취급 그림은 한 칸(논리 텍스트에는 객체 자리 글자 하나), 글자처럼 취급이 아닌 그림·책갈피는 칸이 없다", () => {
  const inline = docOf(T("앞") + PIC("1") + T("가운데") + PIC("1") + T("뒤"));
  assert.equal(inline.p.logicalText, "앞￼가운데￼뒤");
  const ti = offsetTable(inline.p);
  assert.deepEqual(
    ti.slots.map((s) => [s.kind, s.logicalStart]),
    [["text", 0], ["object", 1], ["text", 2], ["text", 3], ["text", 4], ["object", 5], ["text", 6]],
  );
  // rhwp의 실제 배치: 앞=0, (그림=1), 가운데=2, (그림=5), 뒤=6
  assert.deepEqual(inline.runs.map((r) => [r.text, r.charStart]), [["앞", 0], ["가운데", 2], ["뒤", 6]]);
  assert.deepEqual(eachRunLocated(inline.doc, inline.runs).map((x) => x.offset), [0, 2, 6]);
  assertBoundariesRoundTrip(inline.doc, inline.p);

  const floating = docOf(T("앞") + PIC("0") + T("뒤") + BOOKMARK("b1") + T("끝"));
  assert.equal(floating.p.logicalText, "앞￼뒤￼끝");
  const tf = offsetTable(floating.p);
  assert.equal(tf.slots.length, 3);
  // 폭 0 객체 자리 글자 앞뒤: 같은 칸 경계 1이 엔진 오프셋 1(객체 앞)과 2(객체 뒤)에 대응한다
  assert.equal(logicalOffsetAt(tf, 1, "start"), 2);
  assert.equal(logicalOffsetAt(tf, 1, "end"), 1);
  assert.equal(rhwpOffsetAt(tf, 1), 1);
  assert.equal(rhwpOffsetAt(tf, 2), 1);
  assert.equal(logicalOffsetAt(tf, 0, "end"), 0);
  assert.equal(logicalOffsetAt(tf, 3, "start"), 5);
  assert.equal(logicalOffsetAt(tf, 3, "end"), 5);
  assert.ok(eachRunLocated(floating.doc, floating.runs).length > 0);
  assertBoundariesRoundTrip(floating.doc, floating.p, "start");
  assertBoundariesRoundTrip(floating.doc, floating.p, "end");
});

test("누름틀: 시작·끝 표식은 칸이 없고 값은 보통 글이다", () => {
  const { doc, p, runs } = docOf(T("앞") + FIELD_BEGIN("11", "성명", "1", "이름을 입력") + T("홍길동") + FIELD_END("11") + T("뒤"));
  assert.equal(p.logicalText, "앞￼홍길동￼뒤");
  const t = offsetTable(p);
  assert.equal(t.slots.map((s) => s.shown).join(""), "앞홍길동뒤");
  assert.equal(logicalOffsetAt(t, 1, "start"), 2, "값 `홍`의 앞");
  assert.equal(logicalOffsetAt(t, 1, "end"), 1, "앞 글자 뒤(시작 표식 앞)");
  assert.equal(logicalOffsetAt(t, 4, "end"), 5, "값 `동` 뒤(끝 표식 앞)");
  assert.equal(logicalOffsetAt(t, 4, "start"), 6, "`뒤`의 앞");
  assert.deepEqual(runs.map((r) => [r.text, r.charStart]), [["앞홍길동뒤", 0]]);
  assertBoundariesRoundTrip(doc, p);
  assertBoundariesRoundTrip(doc, p, "end");
});

test("안내문 상태 누름틀: 안내문 글은 rhwp 글자 칸이 없다. 뒤 글의 순번은 안내문 길이만큼 당겨지고, edge `guide`는 누름틀 안을 가리킨다", () => {
  const { doc, p, runs } = docOf(T("앞") + FIELD_BEGIN("12", "소속", "0", "소속 입력") + T("소속 입력") + FIELD_END("12") + T("뒤 글"));
  assert.equal(p.logicalText, "앞￼소속 입력￼뒤 글");
  const t = offsetTable(p);
  assert.equal(t.slots.map((s) => s.shown).join(""), "앞뒤 글", "안내문은 문단 글에 없다");
  assert.deepEqual(t.guides, [{ at: 1, logicalStart: 2, logicalEnd: 7, text: "소속 입력" }]);
  // 뒤 글 `뒤`는 rhwp 순번 1이지만 엔진 논리 오프셋은 8
  assert.equal(logicalOffsetAt(t, 1, "start"), 8);
  assert.equal(logicalOffsetAt(t, 1, "end"), 1);
  assert.equal(logicalOffsetAt(t, 1, "guide"), 2, "안내문의 시작(누름틀 안)");
  assert.equal(logicalOffsetAt(t, 2, "guide"), 9, "안내문이 없는 경계에서는 start와 같다");
  assert.deepEqual(runs.filter((r) => r.text !== "").map((r) => [r.text, r.charStart]), [["앞뒤 글", 0]]);
  for (const r of eachRunLocated(doc, runs)) assert.ok(r.offset >= 0);
  // 위치를 엔진으로 옮겼다가 돌아오는 왕복(`guide` 포함)
  const back = toRhwpPosition(doc, { sectionIndex: 0, path: [BODY], offset: 3 });
  assert.equal(back?.charOffset, 1, "안내문 글 한가운데의 오프셋도 그 누름틀의 자리(1)로 돌아온다");
  const viaGuide = toEngineAddress(doc, { sectionIndex: 0, paragraphIndex: BODY, charOffset: 1 }, { text: "", start: 1 }, "guide");
  assert.equal(viaGuide.address?.offset, 2);
});

test("D4: 시작과 끝 사이에 글이 없는 누름틀도 안내문 상태다 — 구간은 비어 있고 안내문 글은 text, edge `guide`는 누름틀 안이다", () => {
  // rhwp는 글이 비면 `dirty`가 0이든 1이든 안내문을 좌표 없는 런으로 따로 그린다 [실행 관측: 같은 문서의 쪽 글자 배치]
  for (const dirty of ["0", "1"] as const) {
    const { doc, p, runs } = docOf(T("앞") + FIELD_BEGIN("12", "소속", dirty, "소속 입력") + FIELD_END("12") + T("뒤 글"));
    assert.equal(p.logicalText, "앞￼￼뒤 글");
    const t = offsetTable(p);
    assert.equal(t.slots.map((s) => s.shown).join(""), "앞뒤 글");
    assert.deepEqual(t.guides, [{ at: 1, logicalStart: 2, logicalEnd: 2, text: "소속 입력" }], `dirty=${dirty}`);
    assert.deepEqual(runs.filter((r) => r.text !== "").map((r) => [r.text, r.charStart]), [["앞뒤 글", 0]]);
    assert.equal(logicalOffsetAt(t, 1, "guide"), 2, "누름틀 안(시작 표식 바로 뒤)");
    assert.equal(logicalOffsetAt(t, 1, "start"), 3, "guide가 아니면 끝 표식 뒤의 다음 글자 앞");
    const viaGuide = toEngineAddress(doc, { sectionIndex: 0, paragraphIndex: BODY, charOffset: 1 }, { text: "", start: 1 }, "guide", "소속 입력");
    assert.equal(viaGuide.address?.offset, 2);
    assert.equal(viaGuide.precision, "char");
    // 같은 자리에 같은 글의 안내문이 아니면 위치를 정할 수 없는 글이다
    const other = toEngineAddress(doc, { sectionIndex: 0, paragraphIndex: BODY, charOffset: 1 }, { text: "", start: 1 }, "guide", "다른 안내문");
    assert.deepEqual([other.precision, other.reason], ["none", "UNPOSITIONED_TEXT"]);
    const elsewhere = toEngineAddress(doc, { sectionIndex: 0, paragraphIndex: BODY, charOffset: 0 }, { text: "", start: 0 }, "guide", "소속 입력");
    assert.deepEqual([elsewhere.precision, elsewhere.reason], ["none", "UNPOSITIONED_TEXT"]);
  }
  // 값이 든 누름틀(글이 안내문과 같지 않다)과, 글이 안내문과 같아도 `dirty="1"`이면 안내문 상태가 아니다
  const filled = docOf(T("앞") + FIELD_BEGIN("12", "소속", "1", "소속 입력") + T("소속 입력") + FIELD_END("12") + T("뒤 글"));
  assert.deepEqual(offsetTable(filled.p).guides, []);
});

test("자동 번호는 rhwp가 공백 한 칸으로 남긴다(런의 글에 공백으로 들어 있다)", () => {
  const { doc, p, runs } = docOf(T("앞") + AUTO_NUM + T("뒤"));
  assert.equal(p.logicalText, "앞￼뒤");
  const t = offsetTable(p);
  assert.deepEqual(t.slots.map((s) => [s.kind, s.shown]), [["text", "앞"], ["object", " "], ["text", "뒤"]]);
  assert.deepEqual(runs.map((r) => [r.text, r.charStart]), [["앞 뒤", 0]]);
  assert.equal(eachRunLocated(doc, runs)[0]?.offset, 0);
  assertBoundariesRoundTrip(doc, p);
});

test("글자 겹침은 한 칸이고, 런에는 겹친 글이 한 칸보다 길게 그려져도 확인에 통과한다", () => {
  const COMPOSE = `<hp:compose circleType="SHAPE_CIRCLE" charSz="-3" composeType="SPREAD" charPrCnt="2" composeText="가나"><hp:charPr prIDRef="0"/><hp:charPr prIDRef="0"/></hp:compose>`;
  const { doc, p, runs } = docOf(T("앞") + COMPOSE + T("뒤"));
  assert.equal(p.logicalText, "앞￼뒤");
  const t = offsetTable(p);
  assert.deepEqual(t.slots.map((s) => [s.kind, s.private === true, s.composeText]), [["text", false, undefined], ["object", true, "가나"], ["text", false, undefined]]);
  // rhwp: 앞=0, 글자 겹침=1(런 `가나`는 글자 둘이지만 한 칸), 뒤=2
  assert.deepEqual(runs.map((r) => [r.text, r.charStart]), [["앞", 0], ["가나", 1], ["뒤", 2]]);
  assert.deepEqual(eachRunLocated(doc, runs).map((x) => x.offset), [0, 1, 2]);
  // 겹친 글과 다른 글이 같은 자리에 나오면 거절한다
  const wrong = toEngineAddress(doc, { sectionIndex: 0, paragraphIndex: BODY, charOffset: 1 }, { text: "다라", start: 1 });
  assert.equal(wrong.precision, "none");
});

test("컨트롤 색인: 구역 설정·단 설정·누름틀 시작(끝은 세지 않음)·표 순서로 센 색인이 rhwp의 `controlIndex`와 같다", () => {
  const bytes = synth([
    P(R(T("앞") + FIELD_BEGIN("1", "가", "1", "x") + T("XY") + FIELD_END("1") + FIELD_BEGIN("2", "나", "1", "x") + T("XY") + FIELD_END("2") + TBL([[SUBP("셀")]], "1"))),
  ]);
  const doc = parse(bytes);
  assert.deepEqual(controlSlots(doc.sections[0]?.paragraphs[0] as ParagraphNode).map((s) => s.kind), ["secPr", "colPr"]);
  const p = doc.sections[0]?.paragraphs[BODY] as ParagraphNode;
  assert.deepEqual(controlSlots(p).map((s) => [s.index, s.kind]), [[0, "fieldBegin"], [1, "fieldBegin"], [2, "tbl"]]);
  const rdoc = openDocument(bytes);
  try {
    const cell = rdoc.pageLayout(0).runs.find((r) => r.cellPath !== undefined && r.text === "셀");
    assert.equal(cell?.cellPath?.[0]?.controlIndex, 2, "rhwp도 표를 2번 컨트롤로 센다");
  } finally {
    rdoc.free();
  }
});

test("엔진 문단이나 구역이 없으면 `precision: none`, 글이 다르면 문단 단위로 내려간다(조용히 틀린 위치를 쓰지 않는다)", () => {
  const { doc } = docOf(T("가나다"));
  const none = toEngineAddress(doc, { sectionIndex: 5, paragraphIndex: 0, charOffset: 0 });
  assert.equal(none.precision, "none");
  assert.equal(none.reason, "SECTION_NOT_FOUND");
  assert.equal(toEngineAddress(doc, { sectionIndex: 0, paragraphIndex: 99, charOffset: 0 }).reason, "PARAGRAPH_NOT_FOUND");
  // 런의 글이 엔진의 그 자리 글과 다르면 TEXT_MISMATCH(문단 단위), 문단 어디에도 없으면 PARAGRAPH_MISMATCH(주소 없음)
  const pos = { sectionIndex: 0, paragraphIndex: BODY, charOffset: 1 };
  const wrong = toEngineAddress(doc, pos, { text: "나다", start: 0 });
  assert.equal(wrong.precision, "paragraph");
  assert.equal(wrong.reason, "TEXT_MISMATCH");
  assert.deepEqual(wrong.address, { sectionIndex: 0, path: [BODY] });
  const foreign = toEngineAddress(doc, pos, { text: "라마", start: 0 });
  assert.equal(foreign.precision, "none");
  assert.equal(foreign.reason, "PARAGRAPH_MISMATCH");
  const ok = toEngineAddress(doc, pos, { text: "가나다", start: 0 });
  assert.deepEqual([ok.precision, ok.address?.offset], ["char", 1]);
  // 클릭 위치가 보여 준 런 밖이면 거절
  assert.equal(toEngineAddress(doc, { ...pos, charOffset: 5 }, { text: "가나다", start: 0 }).reason, "SHOWN_OUT_OF_RANGE");
});

test("문단 번호·글머리표가 있는 문단모양: 머리 번호 글의 런은 문단 글이 아니므로 LABEL_RUN(문단은 맞다)이다", () => {
  // 독립 기준: header.xml 원문에서 paraPr별 heading type을 정규식으로 읽는다
  let numbered = 0;
  let plain = 0;
  let first: { doc: ReturnType<typeof parse>; index: number } | undefined;
  for (const name of fixtureNames()) {
    const bytes = readFixture(name);
    const pkg = openPackage(bytes);
    const header = new TextDecoder().decode(readEntry(pkg.archive, bytes, pkg.headerEntry));
    const byId = new Map<string, boolean>();
    for (const m of header.matchAll(/<[a-z]+:paraPr id="(\d+)"[\s\S]*?<\/[a-z]+:paraPr>/g)) {
      byId.set(m[1] ?? "", [...m[0].matchAll(/<[a-z]+:heading type="(\w+)"/g)].some((h) => h[1] !== "NONE"));
    }
    const doc = parse(bytes);
    for (const sec of doc.sections) {
      for (const p of walkParagraphs(sec.paragraphs)) {
        const want = byId.get(p.attrs.paraPrIDRef ?? "") ?? false;
        assert.equal(hasNumbering(doc, p), want, `${name} ${p.path.join(".")}`);
        if (want) {
          numbered++;
          if (first === undefined && p.path.length === 1 && sec.index === 0) first = { doc, index: p.path[0] ?? 0 };
        } else plain++;
      }
    }
  }
  assert.ok(plain > 100 && numbered >= 1 && first !== undefined, `표본: 번호 있음 ${numbered}, 없음 ${plain}`);

  // 번호가 있는 문단에서 문단 글에 없는 런이 문단 처음에서 시작하면 LABEL_RUN(문단 주소는 있다), 문단 중간이면 PARAGRAPH_MISMATCH(주소 없음)
  const label = toEngineAddress(first.doc, { sectionIndex: 0, paragraphIndex: first.index, charOffset: 0 }, { text: "가) ", start: 0 });
  assert.deepEqual([label.precision, label.reason, label.address], ["paragraph", "LABEL_RUN", { sectionIndex: 0, path: [first.index] }]);
  const middle = toEngineAddress(first.doc, { sectionIndex: 0, paragraphIndex: first.index, charOffset: 4 }, { text: "가) ", start: 4 });
  assert.deepEqual([middle.precision, middle.reason], ["none", "PARAGRAPH_MISMATCH"]);
  // 번호가 없는 문단은 같은 런이어도 PARAGRAPH_MISMATCH
  const doc = parse(readFixture("hancom/ph-single"));
  const plain0 = toEngineAddress(doc, { sectionIndex: 0, paragraphIndex: 1, charOffset: 0 }, { text: "가) ", start: 0 });
  assert.deepEqual([plain0.precision, plain0.reason], ["none", "PARAGRAPH_MISMATCH"]);
});

test("각주·미주 컨트롤 자리에서 시작하는 번호 글 런은 LABEL_RUN이다(문단은 맞다)", () => {
  const bytes = syntheticDocs()["합성-각주"] as Uint8Array;
  const doc = parse(bytes);
  const p = doc.sections[0]?.paragraphs[BODY];
  assert.ok(p !== undefined);
  assert.equal(p.logicalText, "앞￼뒤");
  // 각주 컨트롤은 `앞` 다음(글자 순번 1)에 놓인다
  assert.deepEqual(noteLabelStarts(p), [{ from: 1, to: 1 }]);
  const pos = { sectionIndex: 0, paragraphIndex: BODY, charOffset: 1 };
  const label = toEngineAddress(doc, pos, { text: "1) ", start: 1 });
  assert.deepEqual([label.precision, label.reason, label.address], ["paragraph", "LABEL_RUN", { sectionIndex: 0, path: [BODY] }]);
  // 컨트롤 자리가 아닌 곳에서 시작하는 모르는 글은 문단 자체를 믿을 수 없다
  const other = toEngineAddress(doc, { ...pos, charOffset: 0 }, { text: "1) ", start: 0 });
  assert.deepEqual([other.precision, other.reason], ["none", "PARAGRAPH_MISMATCH"]);
});

test("묶음 개체 안의 글상자가 여럿이면 rhwp가 어느 글상자의 글이든 같은 경로를 내므로 글상자를 정하지 않는다(TEXTBOX_AMBIGUOUS)", () => {
  const bytes = synth([P(R(T("앞") + CONTAINER([RECT(SUBLIST(SUBP("가나다")), "0"), RECT(SUBLIST(SUBP("라마바")), "0")]) + T("뒤")))]);
  const doc = parse(bytes);
  const p = doc.sections[0]?.paragraphs[BODY];
  assert.ok(p !== undefined);
  const container = controlSlots(p).find((s) => s.kind === "container");
  assert.equal(container?.textboxes.length, 2);
  const rdoc = openDocument(bytes);
  try {
    const inside = rdoc.pageLayout(0).runs.filter((r) => hasDocCoords(r) && r.cellPath !== undefined && r.text !== "");
    assert.ok(inside.length >= 2, "글상자 글 런이 있어야 한다");
    for (const run of inside) {
      const pos = runPosition(run);
      assert.ok(pos !== undefined);
      const at = toEngineAddress(doc, pos, { text: run.text, start: pos.charOffset });
      // 어느 글상자인지 정할 수 없으므로 한 글상자의 글로 조용히 정하지 않는다
      assert.notEqual(at.precision, "char", JSON.stringify([run.text, run.cellPath]));
      assert.equal(at.reason, "TEXTBOX_AMBIGUOUS");
    }
  } finally {
    rdoc.free();
  }
});
