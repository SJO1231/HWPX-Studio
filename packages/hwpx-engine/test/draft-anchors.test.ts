// 앵커 초안(draftAnchors): 누름틀 안, 낱말, 범위, 문단, 표 셀, 글자 묶음 경계, 객체 자리 포함 거절, 오류.
// 기대값은 fixtures의 원문에서 독립으로 만든다. 만든 앵커는 readTemplate + generate에 그대로 넣어 채움까지 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectFields, draftAnchors, fieldFillBlock, generate, isTableNode, listFields, readTemplate, readDataset, type AnchorDraft, type DraftedAnchor, type HwpxDocument } from "../src/index.ts";
import { buildHwpx, loadDoc, readFixture, reparse, sha256Hex, utf8 } from "./helpers.ts";

const textOf = (doc: HwpxDocument, path: number[]): string => {
  let list = doc.sections[0]?.paragraphs ?? [];
  let found: (typeof list)[number] | undefined;
  for (let n = 0; n < path.length; n++) {
    const i = path[n] ?? 0;
    if (n % 2 === 0) found = list[i];
    else list = found?.subLists[i]?.paragraphs ?? [];
  }
  return found?.logicalText ?? "";
};

/** 초안에 id를 붙여 템플릿으로 읽는다(읽기 검사를 통과해야 한다). */
function templateOf(draft: AnchorDraft, value: string) {
  return readTemplate({
    schema: "hwpx-studio/template@1",
    anchors: [{ id: "a1", ...draft }],
    rules: [{ id: "r1", do: { type: "fill", anchor: "a1", value: { text: value } } }],
    // 문서의 다른 `{{}}` 자리는 데이터가 없으므로 그대로 둔다
    options: { missing: "keep" },
  });
}

function fillWith(bytes: Uint8Array, draft: AnchorDraft, value: string): HwpxDocument {
  const r = generate(bytes, templateOf(draft, value), readDataset({}));
  assert.ok(r.ok && !r.dryRun, `채움이 실패했다: ${JSON.stringify(r.report.issues)}`);
  return reparse((r as Extract<typeof r, { output: Uint8Array }>).output);
}

test("D1: 누름틀 안이면 field가 가장 앞이고, 이어서 낱말·문단 순서다", () => {
  const bytes = readFixture("hancom-field");
  const doc = loadDoc("hancom-field");
  const logical = textOf(doc, [0]);
  const start = logical.indexOf("길"); // 값 `홍길동` 안
  const drafts = draftAnchors(doc, { sectionIndex: 0, path: [0], start });
  assert.deepEqual(drafts[0], { kind: "field", name: "성명", occurrence: 0 });
  assert.deepEqual(
    drafts.map((d) => d.kind),
    ["field", "word", "line"],
  );
  // 낱말은 객체 자리(누름틀 표식)에 막힌 `홍길동`이다
  const word = drafts[1];
  assert.equal(word?.kind, "word");
  assert.equal(logical.slice(word.kind === "word" ? word.start : 0, word.kind === "word" ? word.end : 0), "홍길동");

  // 그대로 템플릿에 넣어 채운다
  const out = fillWith(bytes, drafts[0] as AnchorDraft, "김철수");
  assert.deepEqual(
    listFields(out).map((f) => [f.name, f.valueText]),
    [["성명", "김철수"]],
  );
});

test("D1: 누름틀 밖(라벨 글)이면 field가 없고, 객체 자리가 낱말을 막는다", () => {
  const doc = loadDoc("hancom-field");
  const logical = textOf(doc, [0]);
  const start = logical.indexOf("이름");
  const drafts = draftAnchors(doc, { sectionIndex: 0, path: [0], start });
  assert.ok(drafts.every((d) => d.kind !== "field"));
  const word = drafts.find((d) => d.kind === "word");
  assert.ok(word?.kind === "word");
  // 낱말 `이름:`(객체 자리 글자와 공백을 포함하지 않는다)
  assert.equal(logical.slice(word.start, word.end), "이름:");
  assert.ok(!logical.slice(word.start, word.end).includes("￼"));
});

test("D2: 낱말 — 시작 글자를 포함한 공백으로 나뉜 덩어리이고, 지문(대상 글·앞뒤 문맥)을 채운다. 채움이 된다", () => {
  const bytes = readFixture("hancom/ph-single");
  const doc = loadDoc("hancom/ph-single");
  const logical = textOf(doc, [1]); // 사업명: {{project.name}} 입니다.
  const from = logical.indexOf("입니다.");
  for (const start of [from, from + 2, from + 3]) {
    // 마지막 값(from + 3 = 마침표)과 낱말 끝 바로 뒤(커서)도 같은 낱말이다
    const drafts = draftAnchors(doc, { sectionIndex: 0, path: [1], start });
    const word = drafts.find((d) => d.kind === "word");
    assert.ok(word?.kind === "word", `start ${start}`);
    assert.deepEqual([word.start, word.end], [from, from + 4]);
    assert.deepEqual(word.print, { text: "입니다.", before: logical.slice(0, from), after: "" });
  }
  const atEnd = draftAnchors(doc, { sectionIndex: 0, path: [1], start: logical.length });
  const endWord = atEnd.find((d) => d.kind === "word");
  assert.ok(endWord?.kind === "word" && endWord.start === from && endWord.end === logical.length);

  const word = draftAnchors(doc, { sectionIndex: 0, path: [1], start: from }).find((d) => d.kind === "word") as AnchorDraft;
  const out = fillWith(bytes, word, "입니다만");
  assert.equal(textOf(out, [1]), "사업명: {{project.name}} 입니다만");
});

test("D2: `{{}}` 표기는 하나의 낱말이다. 공백이면 앞 낱말로 본다", () => {
  const doc = loadDoc("hancom/ph-single");
  const logical = textOf(doc, [1]);
  const open = logical.indexOf("{{");
  const close = logical.indexOf("}}") + 2;
  const inside = draftAnchors(doc, { sectionIndex: 0, path: [1], start: open + 5 }).find((d) => d.kind === "word");
  assert.ok(inside?.kind === "word");
  assert.equal(logical.slice(inside.start, inside.end), "{{project.name}}");
  // 표기 바로 뒤 공백 위치: 앞 낱말(`{{project.name}}`)
  const afterSpace = draftAnchors(doc, { sectionIndex: 0, path: [1], start: close }).find((d) => d.kind === "word");
  assert.ok(afterSpace?.kind === "word");
  assert.equal(logical.slice(afterSpace.start, afterSpace.end), "{{project.name}}");
  // 공백 한가운데(앞뒤가 공백인 위치가 아니라 문단 처음의 객체 자리)는 낱말이 없다
  const doc0 = loadDoc("hancom/ph-single");
  assert.ok(draftAnchors(doc0, { sectionIndex: 0, path: [0], start: 0 }).every((d) => d.kind !== "word"));
});

test("D3: 범위 — 여러 낱말에 걸친 범위가 그대로 word 앵커가 된다", () => {
  const bytes = readFixture("hancom/ph-single");
  const doc = loadDoc("hancom/ph-single");
  const logical = textOf(doc, [1]);
  const start = 0;
  const end = logical.indexOf("}}") + 2;
  const drafts = draftAnchors(doc, { sectionIndex: 0, path: [1], start, end });
  const word = drafts[0];
  assert.ok(word?.kind === "word");
  assert.deepEqual([word.start, word.end], [start, end]);
  assert.equal(word.print.text, "사업명: {{project.name}}");
  const out = fillWith(bytes, word, "프로젝트");
  assert.equal(textOf(out, [1]), "프로젝트 입니다.");
});

test("D4: 문단 — line 앵커의 지문은 글 앞 40자와 글 전체의 sha256이다. 문단이 비어도 만든다", () => {
  const bytes = readFixture("hancom/ph-single");
  const doc = loadDoc("hancom/ph-single");
  const logical = textOf(doc, [2]);
  const drafts = draftAnchors(doc, { sectionIndex: 0, path: [2] });
  assert.deepEqual(
    drafts.map((d) => d.kind),
    ["line"],
  );
  assert.deepEqual(drafts[0], {
    kind: "line",
    at: { sectionIndex: 0, path: [2] },
    print: { text: logical.slice(0, 40), sha256: sha256Hex(utf8(logical)) },
  });
  const out = fillWith(bytes, drafts[0] as AnchorDraft, "한 줄 전체");
  assert.equal(textOf(out, [2]), "한 줄 전체");

  // 빈 셀 문단도 line을 만든다
  const table = loadDoc("hancom/ph-table");
  assert.equal(textOf(table, [1, 3, 0]), "");
  assert.ok(draftAnchors(table, { sectionIndex: 0, path: [1, 3, 0] }).some((d) => d.kind === "line"));
});

test("D5: 표 셀 — 구역 최상위 표의 셀이면 cell(표 서수, 행, 열)이 마지막에 있다. 채움이 된다", () => {
  const bytes = readFixture("hancom/ph-table");
  const doc = loadDoc("hancom/ph-table");
  // 라벨 `성명`(0행 0열)과 값 칸(0행 1열), 빈 칸(1행 1열)
  const label = draftAnchors(doc, { sectionIndex: 0, path: [1, 0, 0], start: 0 });
  assert.deepEqual(
    label.map((d) => d.kind),
    ["word", "line", "cell"],
  );
  assert.deepEqual(label[2], { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 0, col: 0 });
  const value = draftAnchors(doc, { sectionIndex: 0, path: [1, 1, 0], start: 3 });
  assert.deepEqual(value[value.length - 1], { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 0, col: 1 });
  const row1 = draftAnchors(doc, { sectionIndex: 0, path: [1, 3, 0] });
  assert.deepEqual(row1[row1.length - 1], { kind: "cell", table: { sectionIndex: 0, ordinal: 0 }, row: 1, col: 1 });

  const out = fillWith(bytes, row1[row1.length - 1] as AnchorDraft, "010-0000-0000");
  assert.equal(textOf(out, [1, 3, 0]), "010-0000-0000");
});

test("D5: 병합 표는 셀 주소(행, 열)를 쓰고, 중첩 표 안의 문단에는 cell이 없다", () => {
  const merged = loadDoc("tables/tables-merged");
  // 세로 병합 셀 `세로`: 문서 순서 4번째 셀, 셀 주소는 표의 `cellAddr`다
  const drafts = draftAnchors(merged, { sectionIndex: 0, path: [1, 4, 0], start: 0 });
  const cell = drafts.find((d) => d.kind === "cell");
  assert.ok(cell?.kind === "cell");
  const table = merged.sections[0]?.paragraphs[1]?.objects.find(isTableNode);
  assert.ok(table !== undefined);
  const expected = table.cells[4];
  assert.deepEqual([cell.row, cell.col], [expected?.row, expected?.col]);

  const nested = loadDoc("tables/tables-nested");
  assert.equal(textOf(nested, [1, 1, 0, 0, 0]), "안1");
  const inner = draftAnchors(nested, { sectionIndex: 0, path: [1, 1, 0, 0, 0], start: 0 });
  assert.deepEqual(
    inner.map((d) => d.kind),
    ["word", "line"],
  );
  // 바깥 표의 셀(안쪽 표를 담은 셀 문단)에는 cell이 있다
  const outer = draftAnchors(nested, { sectionIndex: 0, path: [1, 0, 0], start: 0 });
  assert.equal(outer[outer.length - 1]?.kind, "cell");
});

// ── 글자 묶음 경계 ────────────────────────────────────────────────

const SYNTH = (inner: string): HwpxDocument => {
  const bytes = buildHwpx([
    `<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`,
  ]);
  return reparse(bytes);
};

test("D6: 범위가 글자 묶음을 가르면 묶음 경계로 넓힌다(결합 부호, ZWJ 이모지). 채움이 쪼갬 거절 없이 된다", () => {
  const combining = "café ok"; // e + 결합 acute accent: 한 묶음
  const doc = SYNTH(`<hp:t>${combining}</hp:t>`);
  const e = combining.indexOf("é");
  // 묶음 한가운데(e와 결합 부호 사이)에서 끝나는 범위 → 끝이 묶음 끝으로
  const a = draftAnchors(doc, { sectionIndex: 0, path: [0], start: e - 1, end: e + 1 })[0];
  assert.ok(a?.kind === "word");
  assert.deepEqual([a.start, a.end], [e - 1, e + 2]);
  // 묶음 한가운데에서 시작하는 범위 → 시작이 묶음 처음으로
  const b = draftAnchors(doc, { sectionIndex: 0, path: [0], start: e + 1, end: e + 3 })[0];
  assert.ok(b?.kind === "word");
  assert.deepEqual([b.start, b.end], [e, e + 3]);

  const family = "👨‍👩‍👧"; // ZWJ 가족 이모지: UTF-16 8단위, 한 묶음
  assert.equal(family.length, 8);
  const doc2 = SYNTH(`<hp:t>가${family}나</hp:t>`);
  const c = draftAnchors(doc2, { sectionIndex: 0, path: [0], start: 3, end: 6 })[0];
  assert.ok(c?.kind === "word");
  assert.deepEqual([c.start, c.end], [1, 9]);
  assert.equal(c.print.text, family);

  // 넓힌 범위로 채우면 쪼갬 거절(FILL_SPLITS_CLUSTER) 없이 채워진다
  const bytes = buildHwpx([`<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${combining}</hp:t></hp:run></hp:p>`]);
  const out = fillWith(bytes, a, "X");
  assert.equal(textOf(out, [0]), "caX ok");
});

test("D6: 낱말(시작만)도 묶음 경계에 맞춘다 — 공백 아닌 결합 부호만 뒤따라도 한 낱말", () => {
  const doc = SYNTH(`<hp:t>ab́ cd</hp:t>`);
  const w = draftAnchors(doc, { sectionIndex: 0, path: [0], start: 2 }).find((d) => d.kind === "word");
  assert.ok(w?.kind === "word");
  assert.deepEqual([w.start, w.end], [0, 3]);
});

// ── 객체 자리 포함 거절 ────────────────────────────────────────────

test("D7: 객체 자리(누름틀 표식)를 포함하는 범위는 word를 만들지 않는다. 탭·줄바꿈을 포함해도 마찬가지", () => {
  const doc = loadDoc("hancom-field");
  const logical = textOf(doc, [0]);
  const obj = logical.indexOf("￼", 2); // 누름틀 시작 표식
  const drafts = draftAnchors(doc, { sectionIndex: 0, path: [0], start: obj - 2, end: obj + 2 });
  assert.ok(drafts.every((d) => d.kind !== "word"));
  assert.ok(drafts.some((d) => d.kind === "line"));

  const tabbed = SYNTH(`<hp:t>가<hp:tab width="1000" leader="0" type="1"/>나 다</hp:t>`);
  const text = textOf(tabbed, [0]);
  assert.equal(text, "가\t나 다");
  const across = draftAnchors(tabbed, { sectionIndex: 0, path: [0], start: 0, end: 3 });
  assert.ok(across.every((d) => d.kind !== "word"));
  // 탭은 낱말을 나눈다: `나` 위치는 `나`만
  const single = draftAnchors(tabbed, { sectionIndex: 0, path: [0], start: 2 }).find((d) => d.kind === "word");
  assert.ok(single?.kind === "word");
  assert.equal(text.slice(single.start, single.end), "나");
});

test("D8: 주소가 없거나 구간이 문단 글 밖이거나 범위가 거꾸로면 코드 있는 오류다", () => {
  const doc = loadDoc("hancom/ph-single");
  const code = (f: () => unknown): string | undefined => {
    try {
      f();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return undefined;
  };
  assert.equal(code(() => draftAnchors(doc, { sectionIndex: 9, path: [0] })), "FILL_DRAFT_ADDRESS");
  assert.equal(code(() => draftAnchors(doc, { sectionIndex: 0, path: [99] })), "FILL_DRAFT_ADDRESS");
  assert.equal(code(() => draftAnchors(doc, { sectionIndex: 0, path: [1, 0] })), "FILL_DRAFT_ADDRESS");
  assert.equal(code(() => draftAnchors(doc, { sectionIndex: 0, path: [1], start: 9999 })), "FILL_DRAFT_ADDRESS");
  assert.equal(code(() => draftAnchors(doc, { sectionIndex: 0, path: [1], start: 5, end: 2 })), "FILL_DRAFT_RANGE");
  assert.equal(code(() => draftAnchors(doc, { sectionIndex: 0, path: [1], end: 3 })), "FILL_DRAFT_RANGE");
});

test("D9: 만든 모든 앵커는 readTemplate을 통과한다(fixtures 전 문단, 문단 처음·중간·끝 위치)", () => {
  for (const name of ["hancom-field", "hancom/ph-single", "hancom/ph-table", "tables/tables-nested", "tables/tables-merged", "hancom/blocks", "D1"]) {
    const doc = loadDoc(name);
    const section = doc.sections[0];
    assert.ok(section !== undefined);
    const stack = [...section.paragraphs];
    while (stack.length > 0) {
      const p = stack.pop();
      if (p === undefined) break;
      for (const sl of p.subLists) stack.push(...sl.paragraphs);
      const len = p.logicalText.length;
      for (const start of [undefined, 0, Math.floor(len / 2), len]) {
        const drafts = draftAnchors(doc, { sectionIndex: 0, path: p.path, ...(start === undefined ? {} : { start }) });
        assert.ok(drafts.some((d) => d.kind === "line"), `${name} ${p.path.join(".")}: line이 없다`);
        // `blocked`는 템플릿 앵커의 키가 아니다(채울 수 없는 초안에 붙는 알림): 템플릿에 넣을 때는 뺀다
        const anchors = drafts.map(({ blocked: _blocked, ...anchor }, i) => ({ id: `a${i}`, ...anchor }));
        // 앵커 읽기 검사: 초안이 템플릿 형식에 맞아야 한다
        readTemplate({ schema: "hwpx-studio/template@1", anchors, rules: [] });
      }
    }
  }
});

// ── blocked: 채울 수 없는 초안을 알린다 ─────────────────────────────

const BLOCK_CODES = ["FILL_MIXED_FORMAT", "FILL_CROSSES_MARKUP", "FILL_SPLITS_CLUSTER", "FILL_HAS_OBJECT"];

/** 초안 하나로 채워 보고, 적용된 채움 수와 건너뜀·오류 코드를 돌려준다(`blocked`는 템플릿 키가 아니므로 뺀다). */
function tryFill(bytes: Uint8Array, draft: AnchorDraft): { applied: number; codes: Set<string> } {
  const r = generate(bytes, templateOf(draft, "값"), readDataset({}));
  return { applied: r.report.plan.actions.length, codes: new Set([...r.report.plan.skipped.map((s) => s.code), ...r.report.issues.map((i) => i.code)]) };
}

test("D10: 글자모양이 다른 run에 걸친 낱말 초안에는 FILL_MIXED_FORMAT이 붙고, 채워 보면 정말 건너뛴다. 같은 문단의 문단 초안은 그대로다", () => {
  const bytes = readFixture("hancom/ph-mixed");
  const doc = loadDoc("hancom/ph-mixed");
  const first = doc.sections[0]?.paragraphs[0];
  assert.ok(first !== undefined);
  const at = first.logicalText.indexOf("{{");
  const drafts = draftAnchors(doc, { sectionIndex: 0, path: [0], start: at + 2 });
  assert.deepEqual(
    drafts.map((d) => [d.kind, d.blocked]),
    [["word", "FILL_MIXED_FORMAT"], ["line", undefined]],
    "초안은 지우지 않고 알린다",
  );
  assert.ok(!("blocked" in (drafts[1] as object)), "막히지 않은 초안에는 blocked 키가 없다");
  const { blocked: _blocked, ...word } = drafts[0] as AnchorDraft & { blocked?: string };
  const tried = tryFill(bytes, word as AnchorDraft);
  assert.equal(tried.applied, 0);
  assert.ok(tried.codes.has("FILL_MIXED_FORMAT"));
  // 글자모양이 같은 문단의 낱말은 막히지 않는다
  const second = draftAnchors(doc, { sectionIndex: 0, path: [1], start: (doc.sections[0]?.paragraphs[1]?.logicalText.indexOf("{{") ?? 0) + 2 });
  assert.equal(second[0]?.blocked, undefined);
});

test("D10: 객체가 든 문단·셀의 line·cell 초안에는 FILL_HAS_OBJECT이 붙는다", () => {
  const field = loadDoc("hancom-field");
  assert.equal(draftAnchors(field, { sectionIndex: 0, path: [0], start: 0 }).find((d) => d.kind === "line")?.blocked, "FILL_HAS_OBJECT");
  const rich = loadDoc("tables/tables-rich");
  // 그림이 든 칸(1행 2열 = 문단 [1, 5, 0]의 칸)과 누름틀이 든 칸
  for (const path of [[1, 4, 0], [1, 5, 0]]) {
    const drafts = draftAnchors(rich, { sectionIndex: 0, path, start: 0 });
    assert.equal(drafts.find((d) => d.kind === "line")?.blocked, "FILL_HAS_OBJECT", path.join("."));
    assert.equal(drafts.find((d) => d.kind === "cell")?.blocked, "FILL_HAS_OBJECT", path.join("."));
  }
  const plain = draftAnchors(rich, { sectionIndex: 0, path: [1, 0, 0], start: 0 });
  assert.deepEqual(plain.map((d) => [d.kind, d.blocked]), [["word", undefined], ["line", undefined], ["cell", undefined]]);
});

test("D10: blocked는 채움의 판단과 같다 — 모든 문단·위치의 word·line·cell 초안으로 채워 보면, blocked이면 적용 0과 같은 코드의 건너뜀·오류, 아니면 그 코드가 없다", () => {
  let blocked = 0;
  let open = 0;
  for (const name of ["hancom/ph-mixed", "hancom/ph-single", "hancom-field", "tables/tables-rich", "hancom/ph-table", "hancom/blocks"]) {
    const bytes = readFixture(name);
    const doc = loadDoc(name);
    const stack = [...(doc.sections[0]?.paragraphs ?? [])];
    while (stack.length > 0) {
      const p = stack.shift();
      if (p === undefined) break;
      for (const sl of p.subLists) stack.push(...sl.paragraphs);
      const brace = p.logicalText.indexOf("{{");
      const marks = [0, brace < 0 ? 0 : brace + 2, Math.floor(p.logicalText.length / 2)];
      for (const start of new Set(marks)) {
        const drafts: DraftedAnchor[] = draftAnchors(doc, { sectionIndex: 0, path: p.path, start });
        for (const draft of drafts) {
          if (draft.kind === "field") continue;
          const { blocked: why, ...anchor } = draft;
          const tried = tryFill(bytes, anchor as AnchorDraft);
          const label: string = `${name} ${p.path.join(".")}@${start} ${draft.kind}`;
          if (why !== undefined) {
            blocked++;
            assert.equal(tried.applied, 0, `${label}: blocked(${why})인데 적용됐다`);
            assert.ok(tried.codes.has(why), `${label}: blocked ${why}이(가) 채움의 건너뜀·오류에 없다 ${[...tried.codes].join(",")}`);
          } else {
            open++;
            assert.ok(BLOCK_CODES.every((c) => !tried.codes.has(c)), `${label}: blocked가 아닌데 ${[...tried.codes].join(",")}`);
            assert.ok(tried.applied >= 1, `${label}: blocked가 아닌데 적용된 채움이 없다`);
          }
        }
      }
    }
  }
  assert.ok(blocked >= 5 && open >= 30, `표본이 너무 적다: blocked ${blocked}, 열림 ${open}`);
});

test("D11: field 초안은 채움과 같은 판단(fieldFillBlock)을 쓴다 — 채울 수 있는 누름틀만 초안이 나오고, 채울 수 없는 모양이면 초안 자체가 없다(그래서 field 초안에는 blocked가 없다)", () => {
  for (const name of ["hancom/field-states", "hancom-field", "tables/tables-rich"]) {
    const doc = loadDoc(name);
    const targets = collectFields(doc);
    assert.ok(targets.length > 0, name);
    for (const t of targets) {
      assert.equal(fieldFillBlock(t), undefined, `${name} ${t.info.name}`);
      const begin = t.paragraph.pieces[t.begin.pieceIndex];
      const at = (begin?.logicalEnd ?? 0) + 0;
      const drafts = draftAnchors(doc, { sectionIndex: t.info.sectionIndex, path: t.info.path, start: at });
      const field = drafts.find((d) => d.kind === "field" && d.name === t.info.name && d.occurrence === t.info.occurrence);
      assert.ok(field !== undefined, `${name} ${t.info.name}: field 초안이 없다`);
      assert.ok(!("blocked" in field), "field 초안에는 blocked가 없다");
      // 채울 수 없는 모양이면(판단 함수) 초안 조건을 통과하지 못한다
      assert.deepEqual(fieldFillBlock({ ...t, info: { ...t.info, shape: "inline" } })?.code, "FIELD_UNSUPPORTED_SHAPE");
      assert.deepEqual(fieldFillBlock({ ...t, end: null })?.code, "FIELD_UNSUPPORTED_SHAPE");
    }
  }
});
