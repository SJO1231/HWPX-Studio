// 공개 API `fieldRangeIn`·`fieldAnchorOf`(명세 8.8.15, 이슈 #24): 앱이 메일 머지 필드가 맡는 표시 글(8.3)을 엔진과 같은 구간으로 가리고,
// 필드 하나를 가리키는 명시 앵커를 엔진과 같은 모양으로 만든다. 판정 규칙(키가 경로 꼴 + `fieldFillBlock` 없음)은 8.3의 암묵 채움과 같다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectFields,
  emptyTemplate,
  fieldAnchorOf,
  fieldFillBlock,
  fieldRangeIn,
  findPlaceholders,
  generate,
  isValidPath,
  openPackage,
  parseDocument,
  readDataset,
  readTemplate,
  resolveAnchors,
  walkParagraphs,
  type FieldTarget,
  type HwpxDocument,
} from "../src/index.ts";
import { buildHwpx, readFixture } from "./helpers.ts";
import { dataFor } from "./range-helpers.ts";

const docOf = (bytes: Uint8Array): HwpxDocument => parseDocument(openPackage(bytes));
/** 8.3: 암묵 채움이 맡는 메일 머지 필드(템플릿 없음) */
const owns = (t: FieldTarget): boolean => t.info.type === "MAILMERGE" && isValidPath(t.info.mergeKey ?? "") && fieldFillBlock(t) === undefined;

/** 문서의 엄격한 `{{경로}}` 자리를 소유된 표시 글 안과 밖으로 나눈다(공개 API만 쓴다) */
function splitHits(doc: HwpxDocument): { inside: number; outside: number } {
  const owned = collectFields(doc).filter(owns);
  let inside = 0;
  let outside = 0;
  for (const s of doc.sections) {
    for (const p of walkParagraphs(s.paragraphs)) {
      for (const h of findPlaceholders(p.logicalText)) {
        const hit = owned.some((t) => {
          const r = fieldRangeIn(t, p);
          return r !== undefined && h.start < r.until && h.end > r.from;
        });
        if (hit) inside++;
        else outside++;
      }
    }
  }
  return { inside, outside };
}

/** 생성 보고의 `{{}}` 채움 수와 버린 `{{}}` 경로(메일 머지 표시 글 `mergeDisplay`, 지워진 구간 `covered`) */
function filledPlaceholders(bytes: Uint8Array): { filled: number; mergeDisplay: string[]; dropped: string[] } {
  const doc = docOf(bytes);
  const r = generate(bytes, emptyTemplate(), readDataset(dataFor(doc, (path) => `합성 ${path}`)), { mode: "baseline", missing: "error" });
  assert.ok(r.ok, JSON.stringify(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code)));
  const plan = r.report.plan;
  return {
    filled: plan.actions.filter((a) => a.type === "fill" && a.anchor.startsWith("{{")).reduce((n, a) => n + a.targets, 0),
    mergeDisplay: plan.dropped.filter((d) => d.kind === "mergeDisplay").map((d) => d.anchor),
    dropped: plan.dropped.filter((d) => d.anchor.startsWith("{{")).map((d) => d.anchor),
  };
}

test("fieldRangeIn: 공개 합성 서식에서 한 문단 필드의 구간 글이 표시 글과 같고, 소유된 표시 글 밖의 {{}}만 엔진이 채운다", () => {
  const bytes = readFixture("merge/merge-fields");
  const doc = docOf(bytes);
  const fields = collectFields(doc);
  let checked = 0;
  for (const t of fields) {
    if (t.endParagraph !== t.paragraph) continue;
    const r = fieldRangeIn(t, t.paragraph);
    assert.ok(r !== undefined && r.from <= r.until);
    assert.equal(t.paragraph.logicalText.slice(r.from, r.until), t.info.valueText);
    checked++;
  }
  assert.equal(checked, fields.length, "합성 서식의 필드는 모두 한 문단 안이다");
  const split = splitHits(doc);
  const engine = filledPlaceholders(bytes);
  assert.equal(split.outside, 8, "공개 합성 서식의 독립 표식은 8곳");
  assert.equal(engine.filled, split.outside, "엔진이 채운 {{}} 수 = 소유된 표시 글 밖의 자리 수");
  assert.ok(split.inside > 0 && engine.mergeDisplay.length > 0);
});

test("fieldRangeIn: 여러 문단에 걸친 메일 머지는 시작 꼬리·사이 문단·끝 머리를 맡고, 끝 없는 메일 머지는 구간이 없어 그 안 {{}}를 엔진이 채운다", () => {
  const p = (id: number, inner: string): string => `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`;
  const begin = (id: number, key: string): string =>
    `<hp:ctrl><hp:fieldBegin id="${id}" type="MAILMERGE" name="" editable="1" dirty="0" fieldid="${id}9"><hp:parameters cnt="1" name=""><hp:stringParam name="FieldValue">${key}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`;
  const end = (id: number): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}9"/></hp:ctrl>`;
  const bytes = buildHwpx([
    p(1, `<hp:t>앞 {{바깥}} </hp:t>${begin(1, "기관명")}<hp:t>{{기관명}} 첫 줄</hp:t>`) +
      p(2, "<hp:t>가운데 {{사이}}</hp:t>") +
      p(3, `<hp:t>끝 줄</hp:t>${end(1)}<hp:t> 뒤 {{뒤}}</hp:t>`) +
      p(4, `${begin(2, "담당")}<hp:t>{{담당}} 끝 없음</hp:t>`),
  ]);
  const doc = docOf(bytes);
  const [cross, open] = collectFields(doc);
  assert.ok(cross !== undefined && open !== undefined);
  assert.equal(cross.info.shape, "crossParagraph");
  const paragraphs = [...walkParagraphs(doc.sections[0]!.paragraphs)];
  const [p0, p1, p2, p3] = paragraphs;
  assert.ok(p0 && p1 && p2 && p3);
  const r0 = fieldRangeIn(cross, p0);
  assert.ok(r0 !== undefined);
  assert.equal(p0.logicalText.slice(r0.from, r0.until), "{{기관명}} 첫 줄");
  assert.deepEqual(fieldRangeIn(cross, p1), { from: 0, until: p1.logicalText.length });
  const r2 = fieldRangeIn(cross, p2);
  assert.ok(r2 !== undefined);
  assert.equal(p2.logicalText.slice(r2.from, r2.until), "끝 줄");
  assert.equal(fieldRangeIn(cross, p3), undefined, "필드 밖 문단");
  assert.equal(fieldRangeIn(open, p3), undefined, "끝 표식이 없으면 구간이 없다");
  assert.ok(owns(cross) && !owns(open));
  const split = splitHits(doc);
  assert.deepEqual(split, { inside: 2, outside: 3 });
  const engine = filledPlaceholders(bytes);
  assert.equal(engine.filled, split.outside);
  // 시작 문단의 표시 글은 메일 머지가 맡고(mergeDisplay), 사이 문단은 구간 치환으로 지워진다(covered). 어느 쪽이든 채우지 않는다
  assert.deepEqual(engine.mergeDisplay, ["{{기관명}}"]);
  assert.deepEqual(engine.dropped.sort(), ["{{기관명}}", "{{사이}}"]);
});

test("fieldAnchorOf: 필드마다 만든 명시 앵커가 그 필드 하나로 풀린다(메일 머지는 mergeKey, 누름틀은 name)", () => {
  const doc = docOf(readFixture("merge/merge-fields"));
  let merges = 0;
  let clicks = 0;
  for (const t of collectFields(doc)) {
    if (t.info.mergeKey === undefined && t.info.name === "") continue;
    const anchor = fieldAnchorOf(t.info);
    if (t.info.type === "MAILMERGE") {
      assert.equal(anchor.mergeKey, t.info.mergeKey);
      assert.equal(anchor.name, undefined);
      merges++;
    } else {
      assert.equal(anchor.name, t.info.name);
      clicks++;
    }
    const template = readTemplate({ schema: "hwpx-studio/template@1", anchors: [{ ...anchor, id: "a" }], rules: [] });
    const resolved = resolveAnchors(doc, template);
    assert.deepEqual(resolved.issues, []);
    const found = resolved.anchors.get("a");
    assert.ok(found?.kind === "field");
    const where = (x: FieldTarget): string => `${x.info.type} ${x.info.sectionIndex} ${x.info.path.join(".")} ${x.begin.id}`;
    assert.deepEqual(found.targets.map(where), [where(t)]);
  }
  assert.equal(merges, 33);
  assert.equal(clicks, 4);
});
