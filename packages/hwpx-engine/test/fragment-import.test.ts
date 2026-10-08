import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HwpxError,
  applyPlan,
  collectBodyRefs,
  extractFragment,
  fingerprintResource,
  listFields,
  makeLookup,
  mergePlans,
  parseFragment,
  planImport,
  readArchive,
  readEntry,
  rewriteArchive,
  selectTable,
  serializeFragment,
  compareToBaseline,
  validateDocument,
  walkParagraphs,
  type EditPlan,
  type Fragment,
  type HwpxDocument,
  type InsertPoint,
  type ParagraphNode,
} from "../src/index.ts";
import {
  MINIMAL_HEADER,
  NS_HC,
  NS_HH,
  NS_HP,
  NS_HS,
  buildZip,
  bytesEqual,
  duplicates,
  expandResource,
  formatRefsIn,
  hpTexts,
  instIdsIn,
  loadDoc,
  maskValues,
  mutateEntryText,
  objectIdsIn,
  parseSynthetic,
  readFixture,
  reparse,
  sectionXml,
  sha256Hex,
  utf8,
} from "./helpers.ts";

const SECTION = "Contents/section0.xml";
const HEADER = "Contents/header.xml";
const HPF = "Contents/content.hpf";

const throwsCode = (fn: () => unknown, code: string, label = ""): void =>
  assert.throws(fn, (e: unknown) => e instanceof HwpxError && e.code === code, `${label} ${code}가 나와야 한다`);
const sel = (from: number, to: number, parentPath: number[] = []) => ({ sectionIndex: 0, parentPath, from, to });
const at = (index: number, position: "before" | "after" = "after", parentPath: number[] = []): InsertPoint => ({
  sectionIndex: 0,
  parentPath,
  index,
  position,
});
const endOf = (doc: HwpxDocument): InsertPoint => at((doc.sections[0]?.paragraphs.length ?? 1) - 1);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function listAt(doc: HwpxDocument, parentPath: number[]): ParagraphNode[] {
  let list = doc.sections[0]?.paragraphs ?? [];
  for (let i = 0; i < parentPath.length; i += 2) list = list[parentPath[i] ?? 0]?.subLists[parentPath[i + 1] ?? 0]?.paragraphs ?? [];
  return list;
}

type Run = {
  src: HwpxDocument;
  target: HwpxDocument;
  fragment: Fragment;
  plan: EditPlan;
  bytes: Uint8Array;
  result: HwpxDocument;
  /** 대상 구역 텍스트에서 삽입한 위치 */
  offset: number;
  /** 결과 구역 텍스트에서 삽입된 부분: 삽입 위치(선언이 더해졌다면 그만큼 뒤)부터 대상의 남은 글 앞까지 */
  block: string;
  /** 루트 시작 태그에 더한 네임스페이스 선언의 길이 */
  declLen: number;
  /** 조각의 원본 원문 */
  srcXml: string;
  /** 결과 문서에서 삽입된 문단들(삽입 지점과 같은 목록) */
  inserted: ParagraphNode[];
};

function runDocs(src: HwpxDocument, from: number, to: number, target: HwpxDocument, point: InsertPoint, opts: { fragment?: Fragment; srcParent?: number[] } = {}): Run {
  const selection = sel(from, to, opts.srcParent ?? []);
  const fragment = opts.fragment ?? extractFragment(src, selection);
  const plan = planImport(target, fragment, point);
  const bytes = applyPlan(target.pkg, plan);
  const result = reparse(bytes);
  const anchor = listAt(target, point.parentPath)[point.index];
  assert.ok(anchor !== undefined);
  const offset = point.position === "before" ? anchor.element.start : anchor.element.end;
  const before = target.sections[0]?.text ?? "";
  const after = result.sections[0]?.text ?? "";
  // 루트 시작 태그에 더한 네임스페이스 선언은 삽입 위치보다 앞에서 결과를 밀어낸다
  const declLen = plan.edits.filter((e) => e.entry === SECTION && e.reason.includes("네임스페이스")).reduce((n, e) => n + e.replacement.length, 0);
  const srcList = listAt(src, selection.parentPath);
  const first = point.position === "before" ? point.index : point.index + 1;
  return {
    src,
    target,
    fragment,
    plan,
    bytes,
    result,
    offset,
    declLen,
    block: after.slice(offset + declLen, after.length - (before.length - offset)),
    srcXml: (src.sections[0]?.text ?? "").slice(srcList[from]?.element.start, srcList[to]?.element.end),
    inserted: listAt(result, point.parentPath).slice(first, first + (to - from + 1)),
  };
}

function run(srcName: string, from: number, to: number, targetName: string, point?: InsertPoint): Run {
  const target = loadDoc(targetName);
  return runDocs(loadDoc(srcName), from, to, target, point ?? endOf(target));
}

const textsOf = (ps: ParagraphNode[]): string[] => [...walkParagraphs(ps)].map((p) => p.logicalText);

/**
 * 조각 자원마다 대상에 같은 전개(참조까지 풀어 쓴 모양)를 가진 자원이 있는지로 기대 추가 수를 계산한다.
 * 엔진의 지문과 독립이다. 조각 안에서 같은 모양이 또 나오면 하나로 센다.
 */
function expectedAdded(r: Run): number {
  const known = new Map<string, Set<string>>();
  let added = 0;
  for (const res of r.fragment.resources) {
    const group = `${res.kind}/${res.lang ?? ""}`;
    let set = known.get(group);
    if (set === undefined) {
      set = new Set(
        (r.target.header.resources[res.kind] ?? [])
          .filter((i) => res.kind !== "font" || i.lang === res.lang)
          .map((i) => JSON.stringify(expandResource(r.target, res.kind, i.id, i.lang))),
      );
      known.set(group, set);
    }
    const form = JSON.stringify(expandResource(r.src, res.kind, res.id, res.lang));
    if (set.has(form)) continue;
    set.add(form);
    added++;
  }
  return added;
}

// ── 기준 함수 ───────────────────────────────────────────────────────────

/** F3: 글이 같고, 속성값 밖은 원문 그대로이고, 서식(전개와 지문)이 원본과 같다. */
function assertSameTextAndFormat(r: Run, label: string): void {
  const { selection } = r.fragment.source;
  const srcParagraphs = listAt(r.src, selection.parentPath).slice(selection.from, selection.to + 1);
  assert.equal(r.inserted.length, srcParagraphs.length, `${label}: 삽입된 문단 수`);
  assert.deepEqual(textsOf(r.inserted), r.fragment.texts, `${label}: 결과의 글 = 조각의 texts`);
  assert.deepEqual(textsOf(r.inserted), textsOf(srcParagraphs), `${label}: 결과의 글 = 원본의 글`);
  assert.deepEqual(hpTexts(r.block), hpTexts(r.srcXml), `${label}: hp:t 글`);
  assert.equal(maskValues(r.block), maskValues(r.srcXml), `${label}: 속성값 밖은 원문 그대로`);

  // 서식(독립 기준): 참조마다 대상 자원이 원본 자원과 같은 전개를 가진다.
  // 원본에서 이미 없던 대상(<missing:…>)을 거치는 참조는 대상 문서에 같은 id가 있으면 그 자원을 가리키게 되므로 제외한다.
  const srcRefs = formatRefsIn(r.srcXml);
  const outRefs = formatRefsIn(r.block);
  assert.equal(outRefs.length, srcRefs.length, `${label}: 서식 참조 수`);
  const dangling = new Set<number>();
  for (const [i, s] of srcRefs.entries()) {
    const o = outRefs[i];
    assert.ok(o !== undefined && o.kind === s.kind, `${label}: 참조 종류`);
    const want = expandResource(r.src, s.kind, s.id);
    if (JSON.stringify(want).includes("<missing:")) {
      dangling.add(i);
      continue;
    }
    assert.deepEqual(expandResource(r.result, o.kind, o.id), want, `${label}: ${s.kind} ${s.id} → ${o.id}`);
  }

  // 서식(지문): 결과 문서에서 다시 계산한 지문이 조각의 prints와 같다
  const lookup = makeLookup(r.result);
  const prints: string[] = [];
  for (const p of r.inserted) {
    for (const ref of collectBodyRefs(p.element)) {
      if (ref.kind === "unknown" || ref.kind === "memoShape" || ref.kind === "binaryItem") continue;
      const item = (r.result.header.resources[ref.kind] ?? []).find((x) => x.id === ref.id);
      prints.push(item === undefined ? `missing:${ref.id}` : fingerprintResource(item, lookup));
    }
  }
  assert.equal(prints.length, r.fragment.prints.length, `${label}: prints 수`);
  for (const [i, print] of prints.entries()) {
    if (!dangling.has(i)) assert.equal(print, r.fragment.prints[i], `${label}: ${i}번째 참조의 지문 = prints`);
  }
}

const headerIds = (headerText: string, tag: string): Set<string> =>
  new Set([...headerText.matchAll(new RegExp(`<hh:${tag} id="([^"]*)"`, "g"))].map((m) => m[1] ?? ""));
const missingMessages = (d: HwpxDocument): string[] => d.issues.filter((i) => i.code === "MODEL_REF_MISSING").map((i) => i.message).sort();

/** F4: 삽입한 본문의 서식 참조 대상이 있고, 없는 참조가 늘지 않으며, 개수 속성이 맞다. */
function assertRefsResolve(r: Run, label: string): void {
  const dangling = (xml: string, doc: HwpxDocument): { kind: string; id: string }[] =>
    formatRefsIn(xml).filter((x) => !headerIds(doc.header.text, x.kind).has(x.id));
  // 원본에서 이미 없던 참조는 그대로 따라온다(그 참조는 건드리지 않는다). 그 밖에는 없는 참조가 없다
  assert.equal(dangling(r.block, r.result).length, dangling(r.srcXml, r.src).length, `${label}: 삽입한 본문의 없는 참조`);
  // 모델이 센 없는 참조: 원본에 없던 참조가 생기지 않는다(새로 가져온 자원이 기존의 없던 대상을 채워 줄어드는 것은 허용)
  const before = missingMessages(r.target);
  const after = missingMessages(r.result);
  if (missingMessages(r.src).length === 0) {
    for (const m of after) assert.ok(before.includes(m), `${label}: 새로 생긴 없는 참조 ${m}`);
  } else {
    assert.ok(after.length <= before.length + missingMessages(r.src).length, `${label}: 없는 참조는 원본이 가진 만큼만`);
  }
  // 개수 속성: 추가가 있었던 목록은 실제 개수와 맞고, 그 밖의 목록은 그대로다
  assert.equal(r.result.header.counts.length, r.target.header.counts.length);
  for (const [i, slot] of r.result.header.counts.entries()) {
    const old = r.target.header.counts[i];
    assert.ok(old !== undefined && old.list === slot.list && old.lang === slot.lang, `${label}: 개수 슬롯 순서`);
    if (slot.actual === old.actual) assert.equal(slot.value, old.value, `${label}: ${slot.list} 개수 속성은 그대로`);
    else assert.equal(slot.value, slot.actual, `${label}: ${slot.list} 개수 속성 = 실제 개수`);
  }
}

/** F5: 객체 id·instId 중복이 없다(대상에 원래 중복이 없다는 전제). 대상의 기존 id는 그대로다. */
function assertIdsUnique(r: Run, label: string): void {
  const text = r.result.sections[0]?.text ?? "";
  const before = r.target.sections[0]?.text ?? "";
  assert.deepEqual(duplicates(objectIdsIn(text)), duplicates(objectIdsIn(before)), `${label}: 객체 id 중복`);
  assert.deepEqual(duplicates(instIdsIn(text)), duplicates(instIdsIn(before)), `${label}: instId 중복`);
  for (const id of objectIdsIn(before)) assert.ok(objectIdsIn(text).includes(id), `${label}: 기존 객체 id ${id}`);
}

/** F9: 대상의 기존 문단·자원 원문이 그대로이고, 바뀐 것은 삽입과 개수 속성뿐이다. */
function assertPreserved(r: Run, label: string): void {
  const before = r.target.sections[0]?.text ?? "";
  // 루트 시작 태그에 더한 네임스페이스 선언(있다면)만 빼면 구역 원문은 삽입 앞뒤가 그대로다
  const decl = r.plan.edits.find((e) => e.entry === SECTION && e.reason.includes("네임스페이스"));
  const full = r.result.sections[0]?.text ?? "";
  const after = decl === undefined ? full : full.slice(0, decl.start) + full.slice(decl.start + decl.replacement.length);
  assert.equal(after.slice(0, r.offset), before.slice(0, r.offset), `${label}: 삽입 앞`);
  assert.equal(after.slice(r.offset + r.block.length), before.slice(r.offset), `${label}: 삽입 뒤`);
  // 문단마다 원문 구간이 결과에 그대로 있고 순서가 같다
  let from = 0;
  for (const p of r.target.sections[0]?.paragraphs ?? []) {
    // 표 셀 안에 넣었다면 그 셀을 가진 문단은 삽입한 만큼 길어진다(앞뒤 비교가 이미 그 문단을 덮는다)
    if (p.element.start < r.offset && r.offset < p.element.end) continue;
    const raw = before.slice(p.element.start, p.element.end);
    const found = after.indexOf(raw, from);
    assert.ok(found >= from, `${label}: 문단 ${p.path.join(".")}의 원문`);
    from = found + raw.length;
  }
  // header: 자원마다 원문이 그대로 있고 순서가 같다
  const hBefore = r.target.header.text;
  const hAfter = r.result.header.text;
  let pos = 0;
  for (const item of Object.values(r.target.header.resources).flat().sort((a, b) => a.element.start - b.element.start)) {
    const raw = hBefore.slice(item.element.start, item.element.end);
    const found = hAfter.indexOf(raw, pos);
    assert.ok(found >= pos, `${label}: 자원 ${item.kind} ${item.id}의 원문`);
    pos = found + raw.length;
  }
  // header: 추가한 자원(목록 끝의 새 항목)을 빼고 개수 속성을 가리면 원본과 같다
  let stripped = hAfter;
  let added = 0;
  for (const [kind, items] of Object.entries(r.result.header.resources)) {
    // 글꼴은 언어별 목록마다 끝에 붙는다
    for (const lang of new Set(items.map((i) => i.lang))) {
      const now = items.filter((i) => i.lang === lang);
      const old = (r.target.header.resources[kind] ?? []).filter((i) => i.lang === lang);
      for (const item of now.slice(old.length)) {
        stripped = stripped.replace(hAfter.slice(item.element.start, item.element.end), "");
        added++;
      }
    }
  }
  assert.equal(added, r.plan.summary["addedResources"], `${label}: 추가된 자원 수`);
  const normalize = (t: string): string =>
    t.replace(/(itemCnt|fontCnt)="\d+"/g, '$1=""').replace(/<(hh:\w+)([^<>]*)><\/\1>/g, "<$1$2/>");
  assert.equal(normalize(stripped), normalize(hBefore), `${label}: header는 자원 추가와 개수 속성 갱신만 다르다`);
  // 다른 항목의 로컬 레코드는 바이트 동일하다
  const a = readArchive(r.target.pkg.bytes);
  const b = readArchive(r.bytes);
  for (const e of a.entries) {
    if ([SECTION, HEADER, HPF].includes(e.name)) continue;
    const o = b.entries.find((x) => x.name === e.name);
    assert.ok(o !== undefined && bytesEqual(r.target.pkg.bytes.subarray(e.localStart, e.localEnd), r.bytes.subarray(o.localStart, o.localEnd)), `${label}: ${e.name}`);
  }
}

// ── F3 ──────────────────────────────────────────────────────────────────

test("F3 D5의 표(id 1001)를 D1 끝 문단 뒤에 가져온다: 다시 파싱되고, 글과 서식 지문이 원본과 같다", () => {
  const d5 = loadDoc("D5");
  const { from, to } = selectTable(d5, 0, 4).selection;
  const target = loadDoc("D1");
  const r = runDocs(d5, from, to, target, endOf(target));
  assert.ok(r.srcXml.includes('<hp:tbl id="1001"'));
  assert.equal(r.result.sections[0]?.paragraphs.length, (target.sections[0]?.paragraphs.length ?? 0) + 1);
  assert.ok(r.block.startsWith("<hp:p "));
  assertSameTextAndFormat(r, "D5 표 → D1");
  // 재사용·추가 수는 독립 기준(전개 비교)과 같다
  assert.equal(r.plan.summary["addedResources"], expectedAdded(r));
  assert.equal(r.plan.summary["reusedResources"], r.fragment.resources.length - expectedAdded(r));
  assert.ok((r.plan.summary["addedResources"] ?? 0) > 0 && (r.plan.summary["reusedResources"] ?? 0) > 0, "재사용도 추가도 일어나는 사례");
  assert.equal(r.result.sections[0]?.paragraphs.at(-1), r.inserted[0], "삽입한 문단이 구역의 마지막이다");
});

test("F3 앞에 넣어도(before) 같은 기준을 만족하고, 삽입 위치는 지정한 문단의 앞이다", () => {
  const d5 = loadDoc("D5");
  const target = loadDoc("D1");
  const r = runDocs(d5, 7, 7, target, at(4, "before"));
  assertSameTextAndFormat(r, "before");
  assert.equal(r.offset, target.sections[0]?.paragraphs[4]?.element.start);
  assert.equal(r.result.sections[0]?.paragraphs[4], r.inserted[0]);
  assert.equal(r.result.sections[0]?.paragraphs[5]?.logicalText, target.sections[0]?.paragraphs[4]?.logicalText);
});

// ── F4 ──────────────────────────────────────────────────────────────────

test("F4 F3 결과에서 모든 본문 참조·자원 참조의 대상이 있다 (없는 참조가 늘지 않는다)", () => {
  const d5 = loadDoc("D5");
  const target = loadDoc("D1");
  const r = runDocs(d5, 7, 7, target, endOf(target));
  assertRefsResolve(r, "D5 표 → D1");
  // D1에는 원래 tabPr 0이 없다는 오류 하나(8곳)가 있다. 새 tabPr은 그 id(0)를 건너뛰므로(7.5 "없는 자원을 가리키던 참조의 id를 건너뛴다")
  // 그 참조는 채워지지 않고 그대로 없는 대상을 가리킨다. 가져오기가 기존 문단의 모양을 바꾸지 않는다
  assert.equal(missingMessages(r.target).length, 1);
  assert.ok(missingMessages(r.target)[0]?.startsWith("tabPr 0이(가) 없는데 8곳"));
  assert.deepEqual(missingMessages(r.result), missingMessages(r.target));
  assert.deepEqual((r.result.header.resources["tabPr"] ?? []).map((t) => t.id).slice(0, 1), ["1"]);
});

test("F4 한컴 문서와 합성 문서 사이에서도 대상이 모두 있다", () => {
  for (const [src, from, to, tgt] of [
    ["hancom-merged", 1, 8, "D1"],
    ["D5", 4, 6, "hancom/blocks"],
    ["D1", 1, 12, "hancom/blocks"],
    ["D1", 1, 12, "D7"],
  ] as const) {
    const r = run(src, from, to, tgt);
    assertRefsResolve(r, `${src} → ${tgt}`);
    assertSameTextAndFormat(r, `${src} → ${tgt}`);
  }
});

// ── F5 ──────────────────────────────────────────────────────────────────

test("F5 F3 결과에서 객체 id 중복이 없다 (D1과 D5에 같은 표 id 1001이 있어 재발급된다)", () => {
  const d5 = loadDoc("D5");
  const target = loadDoc("D1");
  assert.ok(objectIdsIn(target.sections[0]?.text ?? "").includes("1001"), "D1에도 1001이 있다");
  const r = runDocs(d5, 7, 7, target, endOf(target));
  assertIdsUnique(r, "D5 표 → D1");
  assert.equal(objectIdsIn(r.result.sections[0]?.text ?? "").filter((id) => id === "1001").length, 1, "1001은 D1의 표 하나뿐");
  assert.equal(r.plan.summary["reissuedIds"], 1);
  // 새 id는 대상과 조각을 합친 가장 큰 숫자 + 1이다
  const all = [r.target.sections[0]?.text ?? "", r.srcXml].flatMap((t) => [...objectIdsIn(t), ...instIdsIn(t)]).map(Number);
  assert.equal(objectIdsIn(r.block)[0], String(Math.max(...all) + 1));
  assert.equal(objectIdsIn(r.srcXml)[0], "1001");
});

// ── F6 ──────────────────────────────────────────────────────────────────

test("F6 D5의 일반 문단 3개를 D1에 가져온다: F3~F5와 같은 기준 (끝·앞·가운데)", () => {
  const target = loadDoc("D1");
  for (const point of [endOf(target), at(1, "before"), at(5, "after")]) {
    const r = runDocs(loadDoc("D5"), 4, 6, target, point);
    const label = `D5 4~6 → D1 ${point.index}${point.position}`;
    assert.equal(r.inserted.length, 3);
    assert.deepEqual(r.fragment.texts, ["□\t목적", "ㅇ\t결재란과 요약 상자를 포함한 문서 구조 확인", "□\t내용"]);
    assertSameTextAndFormat(r, label);
    assertRefsResolve(r, label);
    assertIdsUnique(r, label);
    assertPreserved(r, label);
    assert.equal(r.plan.summary["addedResources"], expectedAdded(r), label);
    assert.equal(r.plan.summary["reissuedIds"], 0, "개체가 없는 문단은 id 재발급이 없다");
  }
});

// ── F7 ──────────────────────────────────────────────────────────────────

test("F7 같은 조각을 두 번 가져오면 두 번째의 addedResources는 0이다 (header 편집도 없다)", () => {
  const d5 = loadDoc("D5");
  const target = loadDoc("D1");
  for (const [from, to] of [[7, 7], [4, 6], [7, 9]] as const) {
    const fragment = extractFragment(d5, sel(from, to));
    const first = runDocs(d5, from, to, target, endOf(target), { fragment });
    assert.ok((first.plan.summary["addedResources"] ?? 0) > 0);
    const second = runDocs(d5, from, to, first.result, endOf(first.result), { fragment });
    const label = `${from}~${to}`;
    assert.equal(second.plan.summary["addedResources"], 0, label);
    assert.equal(second.plan.summary["reusedResources"], fragment.resources.length, label);
    assert.equal(second.plan.summary["renamedStyles"], 0, label);
    assert.deepEqual(second.plan.edits.filter((e) => e.entry === HEADER), [], `${label}: header를 건드리지 않는다`);
    assert.equal(second.result.header.text, first.result.header.text);
    // 두 번째 삽입의 서식은 첫 번째가 만든 자원을 가리킨다
    assert.deepEqual(formatRefsIn(second.block), formatRefsIn(first.block), label);
    assertSameTextAndFormat(second, `${label} 두 번째`);
    const third = runDocs(d5, from, to, second.result, endOf(second.result), { fragment });
    assert.equal(third.plan.summary["addedResources"], 0, `${label}: 세 번째`);
  }
});

const styleNames = (d: HwpxDocument): string[] => (d.header.resources["style"] ?? []).map((s) => s.element.attrs.find((a) => a.qname === "name")?.value ?? "");

test("F7 스타일 이름이 충돌해 ' (2)'가 붙은 스타일도 다시 가져올 때 재사용된다. 모양이 다른 같은 이름은 (3)이 된다", () => {
  const d5 = loadDoc("D5");
  const target = loadDoc("D1");
  const fragment = extractFragment(d5, sel(4, 6));
  const first = runDocs(d5, 4, 6, target, endOf(target), { fragment });
  // D1의 "바탕글"과 D5의 "바탕글"은 모양(글꼴 참조 등)이 달라 새 스타일이 이름 충돌로 "바탕글 (2)"가 된다
  assert.deepEqual(styleNames(target), ["바탕글"]);
  assert.deepEqual(styleNames(first.result), ["바탕글", "바탕글 (2)"]);
  assert.equal(first.plan.summary["renamedStyles"], 1);
  // 이름이 바뀐 스타일은 원본과 같은 모양이다(이름 접미사만 다르다)
  assertSameTextAndFormat(first, "이름 충돌");
  // 다시 가져오면 재사용된다
  const second = runDocs(d5, 4, 6, first.result, endOf(first.result), { fragment });
  assert.deepEqual(styleNames(second.result), ["바탕글", "바탕글 (2)"]);
  assert.equal(second.plan.summary["addedResources"], 0);
  // 같은 이름의 또 다른 모양(D5의 글자모양 0만 바꿈): 새 스타일은 "바탕글 (3)"
  const changed = reparse(mutateEntryText(readFixture("D5"), HEADER, (t) => t.replace('<hh:charPr id="0" height="1500"', '<hh:charPr id="0" height="1234"')));
  const third = runDocs(changed, 4, 6, first.result, endOf(first.result));
  assert.deepEqual(styleNames(third.result), ["바탕글", "바탕글 (2)", "바탕글 (3)"]);
  assert.equal(third.plan.summary["renamedStyles"], 1);
  assert.equal(new Set(styleNames(third.result)).size, 3);
  assertSameTextAndFormat(third, "(3)");
});

// ── F8 ──────────────────────────────────────────────────────────────────

test("F8 자기 자신에게 가져오기(D1 조각 → D1): 추가 자원 0, 객체 id 재발급", () => {
  const d1 = loadDoc("D1");
  for (const [from, to] of [[9, 9], [11, 11], [1, 12], [9, 11]] as const) {
    const r = runDocs(d1, from, to, d1, endOf(d1));
    const label = `D1 ${from}~${to} → D1`;
    assert.equal(r.plan.summary["addedResources"], 0, label);
    assert.equal(r.plan.summary["reusedResources"], r.fragment.resources.length, label);
    assert.deepEqual(r.plan.edits.filter((e) => e.entry === HEADER), [], label);
    assert.equal(r.result.header.text, d1.header.text);
    assertSameTextAndFormat(r, label);
    assertIdsUnique(r, label);
    assertPreserved(r, label);
    // 표 하나마다 id를 새로 받는다(원본의 표 id가 대상에 이미 있다)
    assert.equal(r.plan.summary["reissuedIds"], (r.srcXml.match(/<hp:tbl[\s>]/g) ?? []).length, label);
  }
  const r = runDocs(d1, 9, 9, d1, endOf(d1));
  assert.deepEqual(objectIdsIn(r.srcXml), ["1001"]);
  assert.ok(!objectIdsIn(r.block).includes("1001"));
});

// ── F9 ──────────────────────────────────────────────────────────────────

test("F9 D1 원래 문단의 원문 구간과 기존 자원 원문이 결과에서 그대로다", () => {
  const target = loadDoc("D1");
  for (const [src, from, to] of [["D5", 4, 6], ["D5", 7, 7], ["D1", 9, 9], ["hancom-merged", 1, 8]] as const) {
    const r = runDocs(loadDoc(src), from, to, target, endOf(target));
    assertPreserved(r, `${src} ${from}~${to} → D1`);
    // 계획의 편집은 삽입(길이 0 또는 자기 닫힘 펼치기)과 개수 속성 값 바꾸기뿐이다
    for (const e of r.plan.edits) {
      assert.ok(e.start === e.end || e.expected === "/>" || /개수 속성/.test(e.reason), `${e.reason}: 삽입 또는 개수 속성 갱신이어야 한다`);
    }
  }
});

// ── F11 ─────────────────────────────────────────────────────────────────

test("F11 한컴 저장본(hancom-merged)에서 뽑은 조각을 D1에 가져오면 줄 배치 캐시가 조각에서 제거돼 있다", () => {
  const merged = loadDoc("hancom-merged");
  const target = loadDoc("D1");
  const cache = /<hp:linesegarray[\s>]/g;
  const r = runDocs(merged, 1, 8, target, endOf(target));
  assert.equal((r.srcXml.match(cache) ?? []).length, 8, "원본 조각에는 문단마다 캐시가 있다");
  assert.equal(r.fragment.lineSegSpans.length, 8);
  assert.equal((r.block.match(cache) ?? []).length, 0, "삽입한 부분에 캐시가 없다");
  for (const p of r.inserted) assert.equal(p.lineSegArray, undefined);
  assert.equal(maskValues(r.block), maskValues(r.srcXml), "캐시를 지운 것 말고는 원문 그대로");
  assertSameTextAndFormat(r, "hancom-merged → D1");
  // 표 셀 문단의 캐시도 지운다
  const t = runDocs(merged, 9, 9, target, endOf(target));
  assert.ok((t.srcXml.match(cache) ?? []).length > 1, "표 셀 문단에도 캐시가 있다");
  assert.equal((t.block.match(cache) ?? []).length, 0);
  // 대상의 캐시는 건드리지 않는다
  const hancom = loadDoc("hancom/blocks");
  const into = runDocs(merged, 1, 2, hancom, endOf(hancom));
  assert.equal(((into.result.sections[0]?.text ?? "").match(cache) ?? []).length, ((hancom.sections[0]?.text ?? "").match(cache) ?? []).length);
});

// ── F12 ─────────────────────────────────────────────────────────────────

test("F12 Fragment를 JSON으로 저장했다가 읽어 가져와도 결과가 같다", () => {
  const cases: [string, number, number, string][] = [
    ["D5", 7, 7, "D1"],
    ["D5", 4, 6, "D1"],
    ["hancom-merged", 1, 8, "D1"],
    ["hancom/picture", 1, 1, "D1"],
    ["hancom/picture", 1, 1, "hancom/blocks"],
    ["hancom/field-states", 1, 2, "hancom/blocks"],
    ["extra/features-picture", 14, 16, "D1"],
  ];
  for (const [src, from, to, tgt] of cases) {
    const fragment = extractFragment(loadDoc(src), sel(from, to));
    const viaJson = parseFragment(serializeFragment(fragment));
    const target = loadDoc(tgt);
    const a = planImport(target, fragment, endOf(target));
    const b = planImport(target, viaJson, endOf(target));
    assert.deepEqual(b, a, `${src} → ${tgt}: 계획`);
    assert.ok(bytesEqual(applyPlan(target.pkg, b), applyPlan(target.pkg, a)), `${src} → ${tgt}: 결과 바이트`);
  }
});

// ── F13 ─────────────────────────────────────────────────────────────────

const PICTURE_ITEM = (id: string, href: string): string => `<opf:item id="${id}" href="${href}" media-type="image/png" isEmbeded="1"/>`;

/** F13: 이진 항목이 추가되고, manifest에 등록되고, 본문의 참조가 그 항목을 가리킨다. 등록된 항목을 돌려준다. */
function assertPictureImported(r: Run, label: string): { id: string; href: string } {
  const source = r.src.pkg.manifestItems.find((m) => m.mediaType === "image/png");
  assert.ok(source !== undefined);
  const raw = readEntry(r.src.pkg.archive, r.src.pkg.bytes, source.href);
  const refs = [...r.block.matchAll(/binaryItemIDRef="([^"]*)"/g)].map((m) => m[1] ?? "");
  assert.equal(refs.length, 1, `${label}: 삽입한 그림 참조`);
  const item = r.result.pkg.manifestItems.find((m) => m.id === refs[0]);
  assert.ok(item !== undefined, `${label}: manifest에 ${refs[0]}`);
  assert.equal(item.mediaType, source.mediaType);
  assert.ok(r.result.pkg.binaryEntries.includes(item.href), `${label}: ${item.href} 항목`);
  assert.ok(bytesEqual(readEntry(r.result.pkg.archive, r.bytes, item.href), raw), `${label}: 이진 내용`);
  for (const m of (r.result.sections[0]?.text ?? "").matchAll(/binaryItemIDRef="([^"]*)"/g)) {
    assert.ok(r.result.pkg.manifestItems.some((x) => x.id === m[1]), `${label}: 결과 구역의 참조 ${m[1]}`);
  }
  assert.deepEqual(r.result.issues.filter((i) => i.code.startsWith("PKG_")), r.target.issues.filter((i) => i.code.startsWith("PKG_")), `${label}: 패키지 경고가 늘지 않는다`);
  return item;
}

test("F13 그림 조각: picture.hwpx의 그림 문단을 D1에 가져오면 이진 항목이 추가되고 manifest에 등록되며 참조가 맞다", () => {
  const target = loadDoc("D1");
  assert.equal(target.pkg.binaryEntries.length, 0);
  const r = run("hancom/picture", 1, 1, "D1");
  const item = assertPictureImported(r, "picture → D1");
  assert.deepEqual([item.id, item.href], ["image1", "BinData/image1.png"]);
  assert.equal(r.plan.summary["addedBinaries"], 1);
  assert.equal(r.plan.summary["reusedBinaries"], 0);
  assert.equal(r.plan.additions.length, 1);
  assert.equal(r.result.pkg.archive.entries.length, target.pkg.archive.entries.length + 1);
  // 새 항목은 기존 항목 뒤에 붙는다
  assert.deepEqual(
    r.result.pkg.archive.entries.map((e) => e.name),
    [...target.pkg.archive.entries.map((e) => e.name), "BinData/image1.png"],
  );
  assertPreserved(r, "picture → D1");
  assertSameTextAndFormat(r, "picture → D1");
  assertRefsResolve(r, "picture → D1");
  assertIdsUnique(r, "picture → D1");
  assert.equal(r.plan.summary["reissuedIds"], 0, "D1에는 같은 id가 없다");
  // content.hpf는 manifest 항목 하나가 늘었을 뿐이다
  const before = decode(readEntry(target.pkg.archive, target.pkg.bytes, HPF));
  const after = decode(readEntry(r.result.pkg.archive, r.bytes, HPF));
  const added = PICTURE_ITEM("image1", "BinData/image1.png");
  assert.ok(after.includes(added));
  assert.equal(after.replace(added, ""), before);
  assert.ok(after.indexOf(added) > after.indexOf('id="section0"'), "마지막 항목 뒤에 붙는다");
  assert.ok(after.indexOf(added) < after.indexOf("</opf:manifest>"));
});

test("F13 그림 조각을 한컴 문서(blocks)에 가져온다", () => {
  const target = loadDoc("hancom/blocks");
  const r = run("hancom/picture", 1, 1, "hancom/blocks", at(2, "before"));
  const item = assertPictureImported(r, "picture → blocks");
  assert.equal(item.href, "BinData/image1.png");
  assertSameTextAndFormat(r, "picture → blocks");
  assertRefsResolve(r, "picture → blocks");
  assertPreserved(r, "picture → blocks");
  assert.equal(r.plan.summary["addedResources"], expectedAdded(r));
  assert.equal(r.result.pkg.binaryEntries.length, target.pkg.binaryEntries.length + 1);
  const hpf = decode(readEntry(r.result.pkg.archive, r.bytes, HPF));
  assert.ok(hpf.includes(PICTURE_ITEM("image1", "BinData/image1.png")), "한컴 manifest의 opf 접두사를 따른다");
});

test("F13 같은 그림을 두 번 가져오면 이진 항목은 재사용된다 (두 번째에는 항목·manifest 편집이 없다)", () => {
  for (const tgt of ["D1", "hancom/blocks"]) {
    const src = loadDoc("hancom/picture");
    const fragment = extractFragment(src, sel(1, 1));
    const target = loadDoc(tgt);
    const first = runDocs(src, 1, 1, target, endOf(target), { fragment });
    const second = runDocs(src, 1, 1, first.result, endOf(first.result), { fragment });
    assert.equal(second.plan.summary["addedBinaries"], 0, tgt);
    assert.equal(second.plan.summary["reusedBinaries"], 1, tgt);
    assert.deepEqual(second.plan.additions, []);
    assert.deepEqual(second.plan.edits.filter((e) => e.entry !== SECTION), [], "구역 밖 편집이 없다");
    assert.equal(second.result.pkg.archive.entries.length, first.result.pkg.archive.entries.length);
    const refs = (b: string): string[] => [...b.matchAll(/binaryItemIDRef="([^"]*)"/g)].map((m) => m[1] ?? "");
    assert.deepEqual(refs(second.block), refs(first.block), "두 그림이 같은 항목을 가리킨다");
    assert.equal(refs(second.block).length, 1);
    assertIdsUnique(second, tgt);
    assertPictureImported(second, tgt);
  }
});

test("F13 이진 항목 id가 대상과 겹치고 내용이 다르면 새 id·이름을 준다. 내용이 같으면 id가 달라도 재사용한다", () => {
  const fp = loadDoc("extra/features-picture"); // 그림 BIN0001
  const png = readEntry(fp.pkg.archive, fp.pkg.bytes, "BinData/BIN0001.png");
  // 같은 id(BIN0001)에 내용이 다른 그림을 가진 원본
  const altered = new Uint8Array([...png, 1, 2, 3]);
  const src = reparse(rewriteArchive(fp.pkg.bytes, fp.pkg.archive, { replace: new Map([["BinData/BIN0001.png", altered]]) }));
  const r = runDocs(src, 14, 14, fp, endOf(fp));
  assert.equal(r.plan.summary["addedBinaries"], 1);
  const item = assertPictureImported(r, "id 충돌");
  assert.deepEqual([item.id, item.href], ["BIN0002", "BinData/BIN0002.png"]);
  assert.ok(bytesEqual(readEntry(r.result.pkg.archive, r.bytes, "BinData/BIN0001.png"), png), "기존 이진 항목은 그대로");
  assert.ok(r.block.includes('binaryItemIDRef="BIN0002"'));
  // 내용이 같은 그림(자기 자신)은 같은 id로 재사용한다
  const same = runDocs(fp, 14, 14, fp, endOf(fp));
  assert.equal(same.plan.summary["reusedBinaries"], 1);
  assert.equal(same.plan.summary["addedBinaries"], 0);
  assert.ok(same.block.includes('binaryItemIDRef="BIN0001"'));
  // 내용이 같고 id만 다른 대상: picture.hwpx의 그림을 id "logo"로 가진 문서
  const pic = loadDoc("hancom/picture");
  const hpf = decode(readEntry(pic.pkg.archive, pic.pkg.bytes, HPF));
  const logo = reparse(rewriteArchive(pic.pkg.bytes, pic.pkg.archive, { replace: new Map([[HPF, new TextEncoder().encode(hpf.replace('id="image1"', 'id="logo"'))]]) }));
  assert.ok(logo.pkg.manifestItems.some((m) => m.id === "logo"));
  const dup = runDocs(pic, 1, 1, logo, endOf(logo));
  assert.equal(dup.plan.summary["reusedBinaries"], 1);
  assert.ok(dup.block.includes('binaryItemIDRef="logo"'), "대상의 id로 다시 쓴다");
});

test("F13 그림이 없는 조각은 이진 항목·manifest를 건드리지 않는다", () => {
  const r = run("D5", 4, 6, "hancom/picture");
  assert.deepEqual(r.plan.additions, []);
  assert.deepEqual(r.plan.edits.filter((e) => e.entry === HPF), []);
  assert.equal(r.plan.summary["addedBinaries"], 0);
});

// ── 7.5 4·5항: 누름틀·책갈피·자리값 ──────────────────────────────────────

test("7.5-4 누름틀 문단을 자기 자신에게 가져오면 시작 id와 끝의 beginIDRef가 함께 새 값이 되고 짝이 유지된다", () => {
  const target = loadDoc("hancom/field-states");
  const r = runDocs(target, 1, 2, target, endOf(target));
  const text = r.result.sections[0]?.text ?? "";
  const begins = (t: string): string[] => [...t.matchAll(/<hp:fieldBegin\b[^>]*?\sid="(\d+)"/g)].map((m) => m[1] ?? "");
  const ends = (t: string): string[] => [...t.matchAll(/<hp:fieldEnd\b[^>]*?\sbeginIDRef="(\d+)"/g)].map((m) => m[1] ?? "");
  assert.deepEqual(begins(r.srcXml), ["1208941123", "1208941124"]);
  assert.equal(begins(text).length, 5, "원래 3개 + 새 2개");
  assert.equal(new Set(begins(text)).size, 5, "시작 id가 겹치지 않는다");
  assert.deepEqual(ends(text), begins(text), "문서 순서로 시작과 끝이 같은 id를 가리킨다");
  assert.equal(begins(r.block).length, 2);
  assert.deepEqual(ends(r.block), begins(r.block), "새 누름틀의 짝");
  for (const id of begins(r.block)) assert.ok(!begins(r.srcXml).includes(id) && Number(id) > 1208941124);
  assert.equal(r.plan.summary["reissuedIds"], 2);
  assert.equal((r.block.match(/fieldid="627272811"/g) ?? []).length, 4, "fieldid는 그대로");
  // 모델로 읽어도 짝이 맞고 값·모양이 원본과 같다
  const fields = listFields(r.result);
  assert.deepEqual(fields.map((f) => f.shape), ["simple", "simple", "simple", "simple", "simple"]);
  assert.deepEqual(fields.map((f) => f.name), ["성명", "소속", "성명", "소속", "성명"]);
  assert.deepEqual(fields.map((f) => f.valueText), ["이름을 입력", "합성기관", "이름을 입력", "합성기관", "이름을 입력"]);
  assert.deepEqual(fields.map((f) => f.dirty), ["0", "1", "0", "1", "0"]);
  assertSameTextAndFormat(r, "field self");
  assertIdsUnique(r, "field self");
});

test("7.5-4 id가 겹치지 않으면 누름틀 id는 그대로다", () => {
  const src = loadDoc("hancom/field-states");
  const target = loadDoc("D1");
  const r = runDocs(src, 1, 2, target, endOf(target));
  assert.equal(r.plan.summary["reissuedIds"], 0);
  assert.ok(r.block.includes('id="1208941123"') && r.block.includes('beginIDRef="1208941123"'));
  assert.deepEqual(listFields(r.result).map((f) => f.name), ["소속", "성명"]);
});

const bookmarkNames = (d: HwpxDocument): string[] => [...(d.sections[0]?.text ?? "").matchAll(/<hp:bookmark\s+name="([^"]*)"/g)].map((m) => m[1] ?? "");

test("7.5-5 책갈피 문단을 자기 자신에게 가져오면 책갈피 이름에 접미사가 붙는다 (_1, _2 …)", () => {
  const target = loadDoc("extra/features-picture");
  assert.deepEqual(bookmarkNames(target), ["bm_test"]);
  const fragment = extractFragment(target, sel(15, 15));
  const first = runDocs(target, 15, 15, target, endOf(target), { fragment });
  assert.deepEqual(bookmarkNames(first.result), ["bm_test", "bm_test_1"]);
  assert.equal(first.plan.summary["renamedBookmarks"], 1);
  const second = runDocs(target, 15, 15, first.result, endOf(first.result), { fragment });
  assert.deepEqual(bookmarkNames(second.result), ["bm_test", "bm_test_1", "bm_test_2"]);
  assert.equal(duplicates(bookmarkNames(second.result)).length, 0);
  assertSameTextAndFormat(first, "bookmark self");
  // 겹치지 않는 대상에서는 이름이 그대로다
  const d1 = loadDoc("D1");
  const other = runDocs(target, 15, 15, d1, endOf(d1), { fragment });
  assert.deepEqual(bookmarkNames(other.result), ["bm_test"]);
  assert.equal(other.plan.summary["renamedBookmarks"], 0);
  // _1이 이미 있으면 다음 번호를 쓴다
  const bm = (name: string): string => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:bookmark name="${name}"/></hp:ctrl></hp:run></hp:p>`;
  const taken = parseSynthetic([bm("x") + bm("x_1")]);
  const r = runDocs(taken, 0, 0, taken, endOf(taken));
  assert.deepEqual(bookmarkNames(r.result), ["x", "x_1", "x_2"]);
});

test("7.5-4 객체 id가 자리값(0)이면 새 값을 받는다. instId도 같고, 대상의 자리값은 건드리지 않는다", () => {
  const body = (id: string, inst: string): string =>
    `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:pic id="${id}" instid="${inst}"><hp:sz width="1" height="1"/></hp:pic></hp:run></hp:p>`;
  const src = parseSynthetic([body("0", "0")]);
  const target = parseSynthetic([body("0", "0") + body("7", "9")]);
  const r = runDocs(src, 0, 0, target, endOf(target));
  assert.equal(r.plan.summary["reissuedIds"], 2);
  assert.deepEqual(objectIdsIn(r.block), ["10"]);
  assert.deepEqual(instIdsIn(r.block), ["11"]);
  assert.deepEqual(objectIdsIn(r.result.sections[0]?.text ?? ""), ["0", "7", "10"]);
});

test("7.5-4 조각 안 자리값(0, 빈 값)의 객체 id·instId는 대상에 같은 값이 없어도 새 값으로 재발급한다(대상과의 충돌 때문이 아니다)", () => {
  // 위 시험은 대상에도 자리값 0이 있어 "대상에 이미 있다"는 갈래로도 바뀐다. 여기서는 대상에 0·빈 값이 없고 id 5·instId 7뿐이다.
  const body = (inner: string): string => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`;
  const pic = (id: string, inst: string): string => `<hp:pic id="${id}" instid="${inst}"><hp:sz width="1" height="1"/></hp:pic>`;
  const rect = (id: string, inst: string): string => `<hp:rect id="${id}" instid="${inst}"/>`;
  const src = parseSynthetic([body(pic("0", "0") + rect("", ""))]);
  const target = parseSynthetic([body(pic("5", "7"))]);
  const targetText = target.sections[0]?.text ?? "";
  assert.ok(!objectIdsIn(targetText).some((v) => v === "0" || v === "") && !instIdsIn(targetText).some((v) => v === "0" || v === ""), "전제: 대상에 자리값이 없다");
  const f = extractFragment(src, sel(0, 0));
  assert.deepEqual(f.instanceIds.map((x) => `${x.role}:${x.value}`), ["object:0", "inst:0", "object:", "inst:"]);

  const r = runDocs(src, 0, 0, target, endOf(target), { fragment: f });
  assert.equal(r.plan.summary["reissuedIds"], 4, "자리값 넷 모두");
  const objects = objectIdsIn(r.block);
  const insts = instIdsIn(r.block);
  assert.equal(objects.length, 2);
  assert.equal(insts.length, 2);
  for (const v of [...objects, ...insts]) assert.ok(/^[1-9]\d*$/.test(v) && Number(v) > 7, `새 값 ${JSON.stringify(v)}: 자리값이 아니고 대상과 조각의 가장 큰 숫자(7)보다 크다`);
  // 객체 id끼리, instId끼리 겹치지 않고 대상의 id와도 겹치지 않는다
  assert.deepEqual(duplicates([...objectIdsIn(r.result.sections[0]?.text ?? "")]), []);
  assert.deepEqual(duplicates([...instIdsIn(r.result.sections[0]?.text ?? "")]), []);
  assert.deepEqual([...new Set([...objects, ...insts])].sort(), ["10", "11", "8", "9"], "대상과 조각을 합친 가장 큰 숫자 + 1부터 차례로");
  assert.ok(objectIdsIn(r.result.sections[0]?.text ?? "").includes("5"), "대상의 기존 id는 그대로");
});

// ── 삽입 지점 ───────────────────────────────────────────────────────────

test("7.5-7 표 셀 안 문단 앞뒤에도 넣을 수 있다 (parentPath = [문단, 하위목록])", () => {
  const d5 = loadDoc("D5");
  const target = loadDoc("D1");
  for (const position of ["before", "after"] as const) {
    const r = runDocs(d5, 4, 4, target, at(0, position, [9, 0]));
    const cell = listAt(r.result, [9, 0]);
    assert.equal(cell.length, listAt(target, [9, 0]).length + 1);
    assert.equal(cell[position === "before" ? 0 : 1]?.logicalText, "□\t목적");
    assert.deepEqual(r.inserted.map((p) => p.logicalText), ["□\t목적"]);
    assert.deepEqual(r.inserted[0]?.path, position === "before" ? [9, 0, 0] : [9, 0, 1]);
    assertPreserved(r, `cell ${position}`);
  }
});

test("7.5 삽입 지점이 올바르지 않으면 FRAG_INSERT_POINT이다", () => {
  const f = extractFragment(loadDoc("D5"), sel(4, 6));
  const target = loadDoc("D1");
  const bad: [string, InsertPoint][] = [
    ["문단 범위 밖", at(13)],
    ["음수", at(-1)],
    ["소수", at(1.5)],
    ["구역 없음", { ...at(0), sectionIndex: 2 }],
    ["상위 주소가 홀수", at(0, "after", [9])],
    ["없는 하위 목록", at(0, "after", [9, 99])],
    ["position이 이상하다", { ...at(0), position: "inside" as unknown as "after" }],
  ];
  for (const [label, p] of bad) throwsCode(() => planImport(target, f, p), "FRAG_INSERT_POINT", label);
});

test("7.5 구역 설정이 든 문단 앞에 넣으면 경고(FRAG_BEFORE_SECPR)가 붙는다", () => {
  const f = extractFragment(loadDoc("D5"), sel(4, 6));
  const target = loadDoc("D1");
  assert.ok(planImport(target, f, at(0, "before")).issues.some((i) => i.code === "FRAG_BEFORE_SECPR" && i.severity === "warning"));
  assert.ok(!planImport(target, f, at(0, "after")).issues.some((i) => i.code === "FRAG_BEFORE_SECPR"));
  assert.ok(!planImport(target, f, at(1, "before")).issues.some((i) => i.code === "FRAG_BEFORE_SECPR"));
});

// ── 7.5-1·2 거절 ────────────────────────────────────────────────────────

test("7.5-1 접두사가 대상 구역에서 다른 역할로 선언돼 있으면 FRAG_NS_MISMATCH이고, 같은 역할이면 통과한다", () => {
  const src = parseSynthetic(['<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>가</hp:t></hp:run></hp:p>']);
  const f = extractFragment(src, sel(0, 0));
  assert.deepEqual(f.prefixes, { hp: "paragraph" });
  assert.deepEqual(f.namespaces, { hp: NS_HP });
  const targetWith = (decl: string): HwpxDocument =>
    parseSynthetic(
      [`<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec xmlns:hs="${NS_HS}" xmlns:hx="${NS_HP}" ${decl}><hx:p paraPrIDRef="0" styleIDRef="0"/></hs:sec>`],
      MINIMAL_HEADER,
      true,
    );
  // 대상의 문단은 hx 접두사를 쓰고, hp는 다른 역할(head)에 묶여 있다
  assert.throws(
    () => planImport(targetWith('xmlns:hp="http://www.hancom.co.kr/hwpml/2011/head"'), f, at(0)),
    (e: unknown) => e instanceof HwpxError && e.code === "FRAG_NS_MISMATCH" && e.message.includes("'hp'") && e.where === SECTION,
  );
  // 같은 2011 URI도, 2024 계열 URI도 같은 역할이면 받는다. 선언을 더하지 않는다
  for (const uri of [NS_HP, "http://www.owpml.org/owpml/2024/paragraph"]) {
    const plan = planImport(targetWith(`xmlns:hp="${uri}"`), f, at(0));
    assert.deepEqual(plan.edits.filter((e) => e.reason.includes("네임스페이스")), [], uri);
  }
});

test("7.5-1 접두사가 대상에 선언돼 있지 않으면 루트 시작 태그에 선언을 더하고, 기본 네임스페이스는 더할 수 없어 거절한다", () => {
  const src = parseSynthetic(['<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>가</hp:t></hp:run></hp:p>']);
  const f = extractFragment(src, sel(0, 0));
  // 대상은 hp 대신 hx를 쓴다(같은 역할)
  const raw = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec xmlns:hs="${NS_HS}" xmlns:hx="${NS_HP}"><hx:p paraPrIDRef="0" styleIDRef="0"/></hs:sec>`;
  const target = parseSynthetic([raw], MINIMAL_HEADER, true);
  const r = runDocs(src, 0, 0, target, endOf(target));
  const decl = ` xmlns:hp="${NS_HP}"`;
  const decls = r.plan.edits.filter((e) => e.reason.includes("네임스페이스"));
  assert.equal(decls.length, 1);
  assert.deepEqual([decls[0]?.start, decls[0]?.end, decls[0]?.replacement], [raw.indexOf("><hx:p"), raw.indexOf("><hx:p"), decl]);
  const after = r.result.sections[0]?.text ?? "";
  assert.equal(after, raw.replace("><hx:p", `${decl}><hx:p`).replace("</hs:sec>", `${r.block}</hs:sec>`));
  assert.equal(r.result.sections[0]?.paragraphs.length, 2, "선언을 더한 결과가 다시 파싱된다");
  assert.deepEqual(r.inserted.map((p) => p.logicalText), ["가"]);
  // 한 번 선언한 뒤에는 더하지 않는다
  assert.deepEqual(planImport(r.result, f, endOf(r.result)).edits.filter((e) => e.reason.includes("네임스페이스")), []);
  // 기본 네임스페이스(접두사 없음)를 쓰는 조각은 대상에 더하지 않고 거절한다
  const plain = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec xmlns:hs="${NS_HS}" xmlns="${NS_HP}"><p paraPrIDRef="0" styleIDRef="0"><run charPrIDRef="0"><t>나</t></run></p></hs:sec>`;
  const dsrc = parseSynthetic([plain], MINIMAL_HEADER, true);
  const df = extractFragment(dsrc, sel(0, 0));
  assert.deepEqual(df.prefixes, { "": "paragraph" });
  throwsCode(() => planImport(loadDoc("D1"), df, at(0)), "FRAG_NS_MISMATCH", "기본 네임스페이스");
  assert.doesNotThrow(() => planImport(dsrc, df, at(0)), "대상도 같은 기본 네임스페이스면 통과한다");
});

test("7.5-1 조각 안에서 스스로 선언한 접두사는 대상에 없어도 된다", () => {
  const body = '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><x:note xmlns:x="urn:x"><x:a/></x:note></hp:run></hp:p>';
  const src = parseSynthetic([body]);
  const f = extractFragment(src, sel(0, 0));
  assert.deepEqual(f.prefixes, { hp: "paragraph" });
  assert.deepEqual(planImport(parseSynthetic([body]), f, at(0)).edits.filter((e) => e.reason.includes("네임스페이스")), []);
});

test("7.5-1 header 쪽 접두사도 확인한다: 추가할 자원의 접두사가 대상 header에서 다른 역할이면 FRAG_NS_MISMATCH, 선언이 없으면 header 루트에 더한다", () => {
  const d5 = loadDoc("D5");
  const f = extractFragment(d5, sel(7, 7));
  assert.ok(f.resources.some((r) => r.prefixes["hc"] === "core"), "D5의 문단모양은 hc 접두사를 쓴다");
  // D1 header의 hc를 core 대신 head 역할에 묶는다(파싱은 된다)
  const rebound = reparse(mutateEntryText(readFixture("D1"), HEADER, (t) => t.replace("hwpml/2011/core", "hwpml/2011/head")));
  assert.throws(
    () => planImport(rebound, f, at(0)),
    (e: unknown) => e instanceof HwpxError && e.code === "FRAG_NS_MISMATCH" && e.where === HEADER,
  );
  assert.doesNotThrow(() => planImport(loadDoc("D1"), f, at(0)));

  // 선언이 없는 경우: hc 요소를 쓰는 테두리를 가진 합성 원본, hc를 선언하지 않은 합성 대상
  const sourceHeader = MINIMAL_HEADER.replace(
    '<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0"/></hh:borderFills>',
    '<hh:borderFills itemCnt="2"><hh:borderFill id="1" threeD="0"/><hh:borderFill id="2" threeD="0"><hc:fillBrush><hc:winBrush faceColor="#FFFF00"/></hc:fillBrush></hh:borderFill></hh:borderFills>',
  );
  assert.notEqual(sourceHeader, MINIMAL_HEADER);
  const src = parseSynthetic(['<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl borderFillIDRef="2"/></hp:run></hp:p>'], sourceHeader);
  const sf = extractFragment(src, sel(0, 0));
  const added = sf.resources.find((r) => r.kind === "borderFill" && r.id === "2");
  assert.deepEqual(added?.prefixes, { hh: "head", hc: "core" });
  const targetHeader = MINIMAL_HEADER.replace(` xmlns:hc="${NS_HC}"`, "");
  assert.ok(!targetHeader.includes("xmlns:hc"));
  const target = parseSynthetic(['<hp:p paraPrIDRef="0" styleIDRef="0"/>'], targetHeader);
  const r = runDocs(src, 0, 0, target, endOf(target));
  assert.equal(r.plan.summary["addedResources"], 1);
  assert.ok(r.result.header.text.startsWith(`<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head xmlns:hh="${NS_HH}" version="1.5" secCnt="1" xmlns:hc="${NS_HC}">`));
  assert.equal(r.result.header.resources["borderFill"]?.length, 2);
  assert.equal(r.result.issues.filter((i) => i.severity === "error").length, 0);
});

test("7.5-2 대상 header에 해당 목록 요소가 없으면 만든다(캠페인에 따른 수정 1). refList가 없을 때만 FRAG_NO_LIST이다", () => {
  const f = extractFragment(loadDoc("D5"), sel(4, 6));
  // 합성 최소 header에는 tabProperties·numberings·bullets가 없고 글꼴은 HANGUL만 있다: 이전에는 이 때문에 거절했다
  const target = parseSynthetic(['<hp:p paraPrIDRef="0" styleIDRef="0"/>']);
  const r = runDocs(loadDoc("D5"), 4, 6, target, endOf(target));
  assert.ok(f.resources.some((x) => x.kind === "tabPr"), "조각이 탭 정의를 쓴다");
  assert.ok(r.result.header.text.includes("<hh:tabProperties itemCnt="), "tabProperties를 만들었다");
  const latin = f.resources.filter((x) => x.kind === "font" && x.lang === "LATIN").length;
  assert.ok(latin > 0, "조각이 LATIN 글꼴을 쓴다");
  assert.equal(r.result.header.resources["font"]?.filter((x) => x.lang === "LATIN").length, latin, "없던 LATIN 글꼴 목록도 만들었다");
  assert.deepEqual(validateDocument(r.bytes).warnings.filter((w) => w.code === "RES_ITEMCNT"), [], "개수 속성이 맞다");
  assertSameTextAndFormat(r, "목록 만들기");
  assert.deepEqual(compareToBaseline(validateDocument(target.pkg.bytes), validateDocument(r.bytes)).newErrors, [], "검사기 새 오류 0");
  assert.doesNotThrow(() => planImport(loadDoc("D1"), f, at(0)));
  // 만들 자리(refList)가 없는 header는 지금처럼 거절한다
  const noRefList = parseSynthetic(['<hp:p paraPrIDRef="0" styleIDRef="0"/>'], MINIMAL_HEADER.replace(/<hh:refList>[\s\S]*<\/hh:refList>/, ""));
  assert.throws(
    () => planImport(noRefList, f, at(0)),
    (e: unknown) => e instanceof HwpxError && e.code === "FRAG_NO_LIST" && e.where === HEADER,
  );
});

test("7.5-2 자기 닫힘 목록(<hh:tabProperties itemCnt=\"0\"/>)은 펼치고 개수를 추가한 만큼으로 한다. 새 id는 없는 tabPr 0을 건너뛰어 1부터 준다", () => {
  const target = loadDoc("D1");
  assert.ok(target.header.text.includes('<hh:tabProperties itemCnt="0"/>'));
  const r = runDocs(loadDoc("D5"), 4, 6, target, endOf(target));
  const tab = r.result.header.text.match(/<hh:tabProperties itemCnt="(\d+)">([\s\S]*?)<\/hh:tabProperties>/);
  assert.ok(tab !== null);
  const tabs = r.result.header.resources["tabPr"] ?? [];
  assert.equal(Number(tab[1]), tabs.length);
  assert.equal([...(tab[2] ?? "").matchAll(/<hh:tabPr /g)].length, tabs.length);
  assert.ok(tabs.length >= 1);
  // 항목이 없던 목록이라 보통은 0부터 주지만, D1의 문단모양 8곳이 없는 tabPr 0을 가리키므로 0은 건너뛴다
  assert.deepEqual(tabs.map((x) => x.id), tabs.map((_, i) => String(i + 1)));
});

// ── 새 id 규칙 ──────────────────────────────────────────────────────────

test("7.5-2 새 자원 id는 그 종류에서 가장 큰 숫자 id + 1부터 차례로 준다 (글꼴은 언어별)", () => {
  const target = loadDoc("D1");
  const r = runDocs(loadDoc("D5"), 7, 7, target, endOf(target));
  for (const kind of ["charPr", "paraPr", "borderFill", "style"]) {
    const before = (target.header.resources[kind] ?? []).map((i) => Number(i.id));
    const after = (r.result.header.resources[kind] ?? []).map((i) => i.id);
    const added = after.slice(before.length).map(Number);
    const base = Math.max(-1, ...before) + 1;
    assert.deepEqual(added, added.map((_, i) => base + i), `${kind}: ${after}`);
    assert.equal(new Set(after).size, after.length, `${kind}: id 중복 없음`);
  }
  for (const lang of ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"]) {
    const ids = (r.result.header.resources["font"] ?? []).filter((f) => f.lang === lang).map((f) => f.id);
    assert.deepEqual(ids, ["0", "1", "2", "3"], lang);
  }
});

// ── 전체 조합 ───────────────────────────────────────────────────────────

const tgtDangles = (d: HwpxDocument): boolean => d.issues.some((i) => i.code === "MODEL_REF_MISSING");

test("조합: 시험 문서 쌍에서 가져온 결과가 다시 열리고 글·서식·참조·id·보존 기준을 만족한다", () => {
  const sources: [string, number, number][] = [
    ["D1", 8, 11],
    ["D2", 11, 16],
    ["D2", 17, 22],
    ["D3", 1, 10],
    ["D4", 21, 30],
    ["D5", 4, 9],
    ["D6", 5, 14],
    ["D7", 1, 5],
    ["hancom-merged", 1, 14],
    ["hancom/blocks", 1, 5],
    ["hancom/ph-table", 1, 2],
    ["extra/features-picture", 9, 17],
  ];
  for (const [src, from, to] of sources) {
    const srcDoc = loadDoc(src);
    const fragment = extractFragment(srcDoc, sel(from, to));
    for (const tgt of ["D1", "D5", "hancom/blocks", "hancom-field"]) {
      const label = `${src}[${from}~${to}] → ${tgt}`;
      const target = loadDoc(tgt);
      const r = runDocs(srcDoc, from, to, target, endOf(target), { fragment });
      assertSameTextAndFormat(r, label);
      assertRefsResolve(r, label);
      assertIdsUnique(r, label);
      assertPreserved(r, label);
      assert.equal(r.plan.summary["addedResources"], expectedAdded(r), label);
      const second = runDocs(srcDoc, from, to, r.result, endOf(r.result), { fragment });
      assert.equal(second.plan.summary["addedBinaries"], 0, `${label}: 두 번째 이진`);
      // 원본에 없는 대상을 가리키는 참조가 있고 대상에 같은 id가 있으면 그 참조가 대상의 자원을 가리키게 되어 지문이 달라진다
      // (명세: 그런 참조는 그대로 둔다). 그 밖의 조각은 두 번째에 자원을 추가하지 않는다
      const adopts = fragment.issues.some((i) => i.code === "FRAG_DANGLING_SOURCE") && !tgtDangles(r.target);
      if (!adopts) assert.equal(second.plan.summary["addedResources"], 0, `${label}: 두 번째 자원`);
    }
  }
});

test("가져오기는 대상 문서·조각 객체·입력 바이트를 바꾸지 않고, 같은 입력이면 같은 계획을 낸다", () => {
  const bytes = readFixture("D1");
  const before = sha256Hex(bytes);
  const target = reparse(bytes);
  const f = extractFragment(loadDoc("D5"), sel(4, 6));
  const snapshot = JSON.stringify(f);
  const headerText = target.header.text;
  const a = planImport(target, f, endOf(target));
  const b = planImport(target, f, endOf(target));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(f), snapshot);
  assert.equal(target.header.text, headerText);
  assert.equal(sha256Hex(bytes), before);
  assert.ok(bytesEqual(applyPlan(target.pkg, a), applyPlan(target.pkg, b)));
});

// ── 그 밖의 경계 ────────────────────────────────────────────────────────

const para = (inner: string): string => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`;

test("7.5 다중 구역: 두 번째 구역에 넣으면 그 구역 항목만 편집하고, id·책갈피 중복은 모든 구역을 대상으로 센다", () => {
  const pic = '<hp:pic id="5" instid="5"><hp:sz width="1" height="1"/></hp:pic>';
  const mark = '<hp:ctrl><hp:bookmark name="m"/></hp:ctrl>';
  const src = parseSynthetic([para(pic) + para(mark)]);
  const target = parseSynthetic([para(pic) + para(mark), para("<hp:t>끝</hp:t>")]);
  const fragment = extractFragment(src, sel(0, 1));
  const plan = planImport(target, fragment, { sectionIndex: 1, parentPath: [], index: 0, position: "after" });
  assert.deepEqual([...new Set(plan.edits.map((e) => e.entry))], ["Contents/section1.xml"], "자원이 모두 같아 header 편집이 없다");
  const out = applyPlan(target.pkg, plan);
  const result = reparse(out);
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[1]?.paragraphs.length, 3);
  const texts = result.sections.map((s) => s.text).join("");
  assert.deepEqual(duplicates(objectIdsIn(texts)), [], "구역을 가로질러 객체 id가 겹치지 않는다");
  assert.deepEqual(duplicates(instIdsIn(texts)), []);
  assert.deepEqual([...texts.matchAll(/<hp:bookmark name="([^"]*)"/g)].map((m) => m[1]), ["m", "m_1"]);
  // 첫 구역의 로컬 레코드는 바이트 동일하다
  const a = readArchive(target.pkg.bytes);
  const b = readArchive(out);
  const e = a.entries.find((x) => x.name === SECTION);
  const o = b.entries.find((x) => x.name === SECTION);
  assert.ok(e !== undefined && o !== undefined && bytesEqual(target.pkg.bytes.subarray(e.localStart, e.localEnd), out.subarray(o.localStart, o.localEnd)));
  throwsCode(() => planImport(target, fragment, { sectionIndex: 2, parentPath: [], index: 0, position: "after" }), "FRAG_INSERT_POINT", "구역 2는 없다");
});

test("7.3 해석하지 못한 *IDRef 속성은 옮기지 않고 FRAG_UNKNOWN_REF 경고를 남긴다. 값은 그대로다", () => {
  const src = parseSynthetic([para('<hp:foo fooIDRef="3"/>')]);
  const f = extractFragment(src, sel(0, 0));
  assert.deepEqual(f.issues.map((i) => [i.code, i.severity]), [["FRAG_UNKNOWN_REF", "warning"]]);
  assert.ok(f.issues[0]?.message.includes("fooIDRef"));
  assert.ok(!f.refs.some((r) => r.id === "3"));
  const target = parseSynthetic([para("<hp:t>x</hp:t>")]);
  const r = runDocs(src, 0, 0, target, endOf(target), { fragment: f });
  assert.ok(r.block.includes('fooIDRef="3"'));
  assert.ok(r.plan.issues.some((i) => i.code === "FRAG_UNKNOWN_REF"), "계획의 경고에도 실린다");
});

test("7.3 manifest에 없는 이진 자료를 가리키는 그림은 FRAG_DANGLING_SOURCE 경고로 남기고 이진 자료는 담지 않는다", () => {
  const body = para('<hp:pic id="1"><hc:img binaryItemIDRef="nope"/></hp:pic>');
  const src = parseSynthetic([sectionXml(body, ` xmlns:hc="${NS_HC}"`)], MINIMAL_HEADER, true);
  const f = extractFragment(src, sel(0, 0));
  assert.deepEqual(f.binaries, []);
  assert.deepEqual(f.refs.filter((r) => r.kind === "binaryItem"), []);
  assert.ok(f.issues.some((i) => i.code === "FRAG_DANGLING_SOURCE" && i.message.startsWith("이진 자료 nope")));
  const target = parseSynthetic([para("<hp:t>x</hp:t>")]);
  const r = runDocs(src, 0, 0, target, endOf(target), { fragment: f });
  assert.ok(r.block.includes('binaryItemIDRef="nope"'), "그 참조는 그대로 둔다");
  assert.deepEqual(r.plan.additions, []);
});

test("7.5 표 셀 안 문단을 구역 최상위로 가져올 수 있다 (조각이 가리키는 서식은 그대로 따라온다)", () => {
  const d1 = loadDoc("D1");
  const r = runDocs(d1, 0, 0, d1, endOf(d1), { srcParent: [9, 0] });
  assert.equal(r.fragment.texts.length, 1);
  assert.deepEqual(r.inserted.map((p) => p.logicalText), r.fragment.texts);
  assert.equal(r.plan.summary["addedResources"], 0);
  assertSameTextAndFormat(r, "cell → top");
  assertPreserved(r, "cell → top");
});

test("7.5 형식이 어긋난 조각은 계획 단계에서도 FRAG_SCHEMA로 거절한다", () => {
  const target = loadDoc("D1");
  const good = extractFragment(loadDoc("D5"), sel(4, 6));
  const clone = (): Fragment => JSON.parse(JSON.stringify(good)) as Fragment;
  const cases: [string, (f: Fragment) => void][] = [
    ["참조 구간이 원문 밖", (f) => void (f.refs[0] && (f.refs[0].end = f.xml.length + 5))],
    ["참조 값이 구간과 다름", (f) => void (f.refs[0] && (f.refs[0].id = "9999"))],
    ["자원 id 구간이 다름", (f) => void (f.resources[0] && (f.resources[0].idSpan = { start: 0, end: 1 }))],
    ["schema", (f) => void ((f as { schema: string }).schema = "x")],
  ];
  for (const [label, change] of cases) {
    const bad = clone();
    change(bad);
    throwsCode(() => planImport(target, bad, endOf(target)), "FRAG_SCHEMA", label);
  }
});

test("7.1 두 가져오기 계획을 합친다: header를 둘 다 고치면 EDIT_OVERLAP, 자원이 모두 재사용되면 합쳐진다", () => {
  const d5 = loadDoc("D5");
  const target = loadDoc("D1");
  const f = extractFragment(d5, sel(4, 6));
  const a = planImport(target, f, at(2));
  const b = planImport(target, f, at(8));
  assert.ok(a.edits.some((e) => e.entry === HEADER));
  throwsCode(() => mergePlans(a, b), "EDIT_OVERLAP", "같은 개수 속성과 같은 목록 끝 삽입");
  // 자원이 이미 있는 대상에서는 header 편집이 없어 합쳐진다
  const first = runDocs(d5, 4, 6, target, endOf(target), { fragment: f });
  const c = planImport(first.result, f, at(2));
  const d = planImport(first.result, f, at(8, "before"));
  assert.deepEqual([...c.edits, ...d.edits].filter((e) => e.entry === HEADER), []);
  const merged = mergePlans(c, d);
  assert.equal(merged.edits.length, 2);
  assert.equal(merged.summary["insertedParagraphs"], 6);
  const result = reparse(applyPlan(first.result.pkg, merged));
  assert.equal(result.sections[0]?.paragraphs.length, (first.result.sections[0]?.paragraphs.length ?? 0) + 6);
});

// ── 문단 id 재발급 ──────────────────────────────────────────────────────

/** 한컴이 여러 문단에 같은 값을 쓰는 자리값(명세 7.5-4). 겹쳐도 오류가 아니다. */
const PARAGRAPH_PLACEHOLDERS = new Set(["", "0", "2147483648", "4294967295"]);
/** 원문에서 `hp:p`의 id 속성값을 문서 순서로 모은다(id가 없는 문단은 건너뛴다). `hp:pic` 등은 걸리지 않는다. */
const paragraphIdsIn = (xml: string): string[] => [...xml.matchAll(/<hp:p\b[^>]*?\sid="([^"]*)"/g)].map((m) => m[1] ?? "");
const realParagraphIds = (ids: string[]): string[] => ids.filter((id) => !PARAGRAPH_PLACEHOLDERS.has(id));
const isNumericParagraphId = (id: string): boolean => /^\d+$/.test(id) && Number(id) < 4294967295;
/** 객체 id·instId·누름틀 시작 id (문단 id와 다른 id 공간) */
const otherIdsIn = (xml: string): string[] => [
  ...objectIdsIn(xml),
  ...instIdsIn(xml),
  ...[...xml.matchAll(/<hp:fieldBegin\b[^>]*?\sid="([^"]*)"/g)].map((m) => m[1] ?? ""),
];
const countChanged = (before: string[], after: string[]): number => before.filter((v, i) => v !== after[i]).length;

test("7.5-4 문단 id: 고유한 id를 가진 문단을 자기 자신에게 가져오면 새 id를 받아 중복이 없다 (hancom-merged)", () => {
  const target = loadDoc("hancom-merged");
  const targetIds = paragraphIdsIn(target.sections[0]?.text ?? "");
  assert.deepEqual(duplicates(realParagraphIds(targetIds)), [], "대상 문서는 자리값만 겹친다");
  const r = runDocs(target, 1, 8, target, endOf(target));
  const srcIds = paragraphIdsIn(r.srcXml);
  const outIds = paragraphIdsIn(r.block);
  assert.ok(realParagraphIds(srcIds).length >= 2, "조각에 고유 id를 가진 문단이 있다");
  assert.ok(srcIds.some((id) => PARAGRAPH_PLACEHOLDERS.has(id)), "조각에 자리값 문단도 있다");
  assert.equal(outIds.length, srcIds.length);

  // 결과 문서 전체에서 자리값 밖의 문단 id는 겹치지 않는다
  assert.deepEqual(duplicates(realParagraphIds(paragraphIdsIn(r.result.sections[0]?.text ?? ""))), []);
  // 대상의 기존 문단 id는 순서까지 그대로다
  assert.deepEqual(paragraphIdsIn(r.result.sections[0]?.text ?? "").slice(0, targetIds.length), targetIds);
  // 새 값은 대상과 조각의 숫자 문단 id 최댓값 + 1부터 문서 순서로 받고, 자리값은 그대로다
  const max = Math.max(...[...targetIds, ...srcIds].filter(isNumericParagraphId).map(Number));
  let next = max + 1;
  srcIds.forEach((id, i) => {
    if (PARAGRAPH_PLACEHOLDERS.has(id)) assert.equal(outIds[i], id, `${i}번째: 자리값은 그대로`);
    else assert.equal(outIds[i], String(next++), `${i}번째: ${id} → 새 id`);
  });
  // summary.reissuedIds = 새로 받은 문단 id 수 + 새로 받은 객체·인스턴스 id 수
  const paragraphsReissued = next - (max + 1);
  assert.equal(paragraphsReissued, realParagraphIds(srcIds).length, "대상에 있는 문단 id는 모두 바뀐다");
  assert.equal(r.plan.summary["reissuedIds"], paragraphsReissued + countChanged(otherIdsIn(r.srcXml), otherIdsIn(r.block)));
  // 글과 서식은 그대로다
  assertSameTextAndFormat(r, "hancom-merged self");
  assertPreserved(r, "hancom-merged self");
});

test("7.5-4 문단 id 규칙: 자리값·대상에 없는 id는 그대로, 겹치는 id는 새 값. 표 셀 안 문단·숫자가 아닌 id·조각 안 같은 id도 각각 새 값", () => {
  const p = (id: string | undefined, inner = "<hp:t>x</hp:t>"): string =>
    `<hp:p${id === undefined ? "" : ` id="${id}"`} paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`;
  const table = (tblId: string, inner: string): string =>
    `<hp:tbl id="${tblId}" rowCnt="1" colCnt="1"><hp:tr><hp:tc borderFillIDRef="1"><hp:subList>${inner}</hp:subList>` +
    `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`;
  const target = parseSynthetic([
    p("10") + p("20") + p("0") + p("4294967295") + p("abc") + p("") + p(undefined) + p(undefined, table("901", p("30"))),
  ]);
  const src = parseSynthetic([
    p("10") + p("11") + p("0") + p("4294967295") + p("abc") + p("20") + p("20") + p(undefined, table("902", p("30"))) + p("") + p(undefined),
  ]);
  const r = runDocs(src, 0, 9, target, endOf(target));
  // 조각의 문단 id(문서 순서, 표 셀 안 포함): 10 11 0 4294967295 abc 20 20 (표 문단 id 없음) 30 ""
  assert.deepEqual(paragraphIdsIn(r.srcXml), ["10", "11", "0", "4294967295", "abc", "20", "20", "30", ""]);
  // 대상과 조각의 숫자 문단 id 최댓값은 30이므로 새 값은 31부터 문서 순서로 준다
  assert.deepEqual(paragraphIdsIn(r.block), ["31", "11", "0", "4294967295", "32", "33", "34", "35", ""]);
  assert.equal(r.plan.summary["reissuedIds"], 5, "객체 id(901·902)는 겹치지 않아 문단 id 다섯 개뿐이다");
  assert.deepEqual(duplicates(realParagraphIds(paragraphIdsIn(r.result.sections[0]?.text ?? ""))), []);
  // 대상의 문단 id는 그대로다
  assert.deepEqual(paragraphIdsIn(r.result.sections[0]?.text ?? "").slice(0, 7), ["10", "20", "0", "4294967295", "abc", "", "30"]);
  assert.deepEqual(r.inserted.map((q) => q.attrs.id), ["31", "11", "0", "4294967295", "32", "33", "34", undefined, "", undefined]);
});

test("7.5-4 문단 id는 객체·인스턴스 id와 따로 센다: 서로의 최댓값에 영향을 주지 않는다", () => {
  const pic = (id: string): string => `<hp:pic id="${id}" instid="${id}"><hp:sz width="1" height="1"/></hp:pic>`;
  const p = (id: string, inner: string): string =>
    `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`;
  const target = parseSynthetic([p("5000", pic("7"))]);
  const src = parseSynthetic([p("5000", pic("7"))]);
  const r = runDocs(src, 0, 0, target, endOf(target));
  assert.deepEqual(paragraphIdsIn(r.block), ["5001"], "문단 id는 문단 id의 최댓값(5000) + 1");
  assert.deepEqual(objectIdsIn(r.block), ["8"], "객체 id는 객체·instId의 최댓값(7) + 1");
  assert.deepEqual(instIdsIn(r.block), ["9"]);
  assert.equal(r.plan.summary["reissuedIds"], 3);
});

test("7.5-4 문단 id 새 값은 자리값을 피한다 (2147483648)", () => {
  const p = (id: string): string => `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>x</hp:t></hp:run></hp:p>`;
  const target = parseSynthetic([p("2147483647")]);
  const src = parseSynthetic([p("2147483647") + p("2147483647")]);
  const r = runDocs(src, 0, 1, target, endOf(target));
  assert.deepEqual(paragraphIdsIn(r.block), ["2147483649", "2147483650"], "2147483648은 건너뛴다");
});

test("7.5-4 문단 id가 4294967294까지 쓰였어도 새 값은 자리값이 아니고 겹치지 않는 숫자다", () => {
  const p = (id: string): string => `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>x</hp:t></hp:run></hp:p>`;
  const target = parseSynthetic([p("4294967294") + p("1")]);
  const src = parseSynthetic([p("4294967294") + p("1")]);
  const r = runDocs(src, 0, 1, target, endOf(target));
  const out = paragraphIdsIn(r.block);
  assert.equal(out.length, 2);
  for (const id of out) {
    assert.match(id, /^\d+$/);
    assert.ok(Number(id) <= 4294967294 && !PARAGRAPH_PLACEHOLDERS.has(id), `새 id ${id}`);
  }
  assert.deepEqual(duplicates(paragraphIdsIn(r.result.sections[0]?.text ?? "")), []);
  assert.equal(r.plan.summary["reissuedIds"], 2);
});

test("7.5-4 같은 조각을 몇 번 가져와도 문단 id는 겹치지 않고, 계획은 조각을 바꾸지 않는다", () => {
  const target = loadDoc("hancom-merged");
  const fragment = extractFragment(target, sel(1, 8));
  const snapshot = JSON.stringify(fragment);
  let doc = target;
  for (let i = 0; i < 3; i++) {
    const r = runDocs(target, 1, 8, doc, endOf(doc), { fragment });
    doc = r.result;
    assert.deepEqual(duplicates(realParagraphIds(paragraphIdsIn(doc.sections[0]?.text ?? ""))), [], `${i + 1}번째`);
  }
  assert.equal(JSON.stringify(fragment), snapshot);
  // JSON으로 저장했다가 읽은 조각도 같은 계획이다
  const again = parseFragment(serializeFragment(fragment));
  assert.deepEqual(planImport(target, again, endOf(target)), planImport(target, fragment, endOf(target)));
});

// ── 없는 참조를 새 자원이 차지하지 않는다 ─────────────────────────────────────
// 새 자원의 id는 "가장 큰 숫자 + 1"이지만, 대상에서 없는 자원을 가리키던 참조의 id(같은 종류)는 건너뛴다.
// 그렇지 않으면 대상의 기존 문단·자원이 새 자원을 가리키게 되어 기존 내용의 모양이 달라질 수 있다.

const fillsOf = (plan: EditPlan) => plan.issues.filter((i) => i.code === "FRAG_FILLS_DANGLING");

test("7.5 D5 표를 D1에 가져오면 D1에서 없던 tabPr 0을 새 탭이 차지하지 않는다: 새 탭은 0이 아닌 id를 받고 D1 기존 참조는 여전히 없는 대상을 가리킨다", () => {
  const d5 = loadDoc("D5");
  const target = loadDoc("D1");
  const { from, to } = selectTable(d5, 0, 4).selection;
  const r = runDocs(d5, from, to, target, endOf(target));
  // 전제: D1에는 tabPr 목록이 비어 있는데 문단모양 8곳이 tabPr 0을 가리킨다
  assert.deepEqual(target.header.resources["tabPr"] ?? [], []);
  assert.ok(missingMessages(target).some((m) => m.startsWith("tabPr 0이(가) 없는데 8곳")));
  // 새 탭이 들어오되 0은 건너뛴다
  const tabIds = (r.result.header.resources["tabPr"] ?? []).map((t) => t.id);
  assert.ok(tabIds.length > 0, "D5 표가 쓰는 탭이 들어온다");
  assert.ok(!tabIds.includes("0"), `새 탭 id ${tabIds.join(",")}`);
  assert.equal(Math.min(...tabIds.map(Number)), 1);
  // 기존 문단의 tabPrIDRef="0"은 여전히 없는 대상을 가리킨다(8곳 그대로)
  assert.ok(missingMessages(r.result).some((m) => m.startsWith("tabPr 0이(가) 없는데 8곳")), missingMessages(r.result).join("|"));
  // 채우는 일이 없으므로 경고도 없다. 계획의 경고는 조각이 가져온 것뿐이다
  assert.deepEqual(fillsOf(r.plan), []);
  assert.deepEqual(r.plan.issues, r.fragment.issues);
  assert.equal(r.plan.summary["addedResources"], expectedAdded(r));
  // 가져온 표의 문단모양이 가리키는 탭은 새 탭이다(전개가 원본과 같다)
  assertSameTextAndFormat(r, "D5 표 → D1");
});

test("7.5 경고가 없는 경우: 한컴 저장본끼리, 자원을 추가하지 않을 때도 FRAG_FILLS_DANGLING은 나오지 않는다", () => {
  const cases: [string, number, number, string][] = [
    ["hancom/picture", 1, 1, "hancom/blocks"],
    ["hancom-merged", 1, 8, "hancom/blocks"],
    ["hancom/ph-table", 1, 1, "hancom/blocks"],
    ["D5", 4, 6, "hancom/blocks"],
    ["D1", 9, 9, "D1"],
    ["D1", 1, 12, "D1"],
  ];
  for (const [src, from, to, tgt] of cases) {
    const r = run(src, from, to, tgt);
    assert.deepEqual(fillsOf(r.plan), [], `${src}[${from}~${to}] → ${tgt}`);
  }
  assert.ok((run("D5", 4, 6, "hancom/blocks").plan.summary["addedResources"] ?? 0) > 0);
  assert.equal(run("D1", 1, 12, "D1").plan.summary["addedResources"], 0);
});

// 글자모양 0만 높이가 다른 원본과, 글자모양 2를 가리키는 문단이 있는(그런 글자모양은 없는) 대상
const FILL_SRC_HEADER = MINIMAL_HEADER.replace('<hh:charPr id="0" height="1000"', '<hh:charPr id="0" height="1500"');
assert.notEqual(FILL_SRC_HEADER, MINIMAL_HEADER);
const charRun = (charPrId: string): string =>
  `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${charPrId}"><hp:t>x</hp:t></hp:run></hp:p>`;

test("7.5 본문이 없는 글자모양 2를 가리키면 새 글자모양은 2를 건너뛰어 3을 받고, 그 참조는 여전히 없는 대상이다. 가리키지 않으면 그대로 2를 받는다", () => {
  const src = parseSynthetic([charRun("0")], FILL_SRC_HEADER);
  // 대상의 글자모양은 0·1이라 보통은 새 id가 2다. 본문의 charPr 2(없음)를 새 자원이 채우지 않도록 3을 받는다
  const dangling = parseSynthetic([charRun("0"), charRun("2")]);
  assert.ok(missingMessages(dangling).some((m) => m.startsWith("charPr 2이(가) 없는데 1곳")));
  const r = runDocs(src, 0, 0, dangling, endOf(dangling));
  assert.ok((r.plan.summary["addedResources"] ?? 0) >= 1);
  assert.deepEqual((r.result.header.resources["charPr"] ?? []).map((c) => c.id), ["0", "1", "3"]);
  assert.ok(missingMessages(r.result).some((m) => m.startsWith("charPr 2이(가) 없는데 1곳")), "기존 참조는 채워지지 않았다");
  assert.deepEqual(fillsOf(r.plan), []);
  // 새 글자모양을 가리키는 것은 가져온 문단뿐이다
  assert.deepEqual(attrsOf(r.block, "charPrIDRef"), ["3"]);
  // 대조군: 없는 참조가 다른 id(9)면 새 id는 그대로 2다
  const apart = parseSynthetic([charRun("0"), charRun("9")]);
  const r2 = runDocs(src, 0, 0, apart, endOf(apart));
  assert.deepEqual((r2.result.header.resources["charPr"] ?? []).map((c) => c.id), ["0", "1", "2"]);
  // 대조군: 없는 참조가 없으면 새 id는 2다
  const clean = parseSynthetic([charRun("0")]);
  assert.deepEqual((runDocs(src, 0, 0, clean, endOf(clean)).result.header.resources["charPr"] ?? []).map((c) => c.id), ["0", "1", "2"]);
});

test("7.5 건너뛰는 id는 종류별이다: 본문의 없는 문단모양 1과 header의 없는 테두리 2를 새 자원이 차지하지 않는다", () => {
  // 대상: paraPr 1·borderFill 2가 없는데 문단이 paraPr 1을, 글자모양 1이 borderFill 2를 가리킨다
  const header = MINIMAL_HEADER.replace('<hh:charPr id="1" height="1200" borderFillIDRef="1">', '<hh:charPr id="1" height="1200" borderFillIDRef="2">');
  assert.notEqual(header, MINIMAL_HEADER);
  const target = parseSynthetic(['<hp:p paraPrIDRef="1" styleIDRef="0"><hp:run charPrIDRef="1"><hp:t>y</hp:t></hp:run></hp:p>'], header);
  const missing = missingMessages(target);
  assert.ok(missing.some((m) => m.startsWith("paraPr 1이(가) 없는데")), missing.join("|"));
  assert.ok(missing.some((m) => m.startsWith("borderFill 2이(가) 없는데")), missing.join("|"));
  // 원본: 문단모양 0이 다르고(줄 간격이 있다) 테두리 1도 다른 모양
  const srcHeader = MINIMAL_HEADER
    .replace('<hh:paraPr id="0"><hh:heading', '<hh:paraPr id="0"><hh:align horizontal="CENTER"/><hh:heading')
    .replace('<hh:borderFill id="1" threeD="0"/>', '<hh:borderFill id="1" threeD="1"/>');
  assert.notEqual(srcHeader, MINIMAL_HEADER);
  const src = parseSynthetic(['<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>x</hp:t></hp:run></hp:p>'], srcHeader);
  const r = runDocs(src, 0, 0, target, endOf(target));
  // 새 borderFill은 2를 건너뛰어 3을, 새 paraPr은 1을 건너뛰어 2를 받는다
  assert.deepEqual((r.result.header.resources["borderFill"] ?? []).map((b) => b.id), ["1", "3"]);
  assert.deepEqual((r.result.header.resources["paraPr"] ?? []).map((p) => p.id), ["0", "2"]);
  const after = missingMessages(r.result);
  assert.ok(after.some((m) => m.startsWith("paraPr 1이(가) 없는데")) && after.some((m) => m.startsWith("borderFill 2이(가) 없는데")), after.join("|"));
  assert.deepEqual(fillsOf(r.plan), []);
});

// ── 조각 쪽 없는 참조를 새 자원이 차지하지 않는다(#115) ─────────────────────────
// 원본에서부터 없는 자원을 가리키던 조각의 참조는 id 그대로 옮긴다. 그 id가 대상에도 없을 때 새 자원이 받으면 넣은 문단·자원이 새 자원을 가리키게 된다.
// 원본: 글꼴 0·테두리 1이 대상과 모양이 달라 새 자원이 되고, 글자모양 0은 없는 테두리 2를, 글자모양 1은 없는 글꼴 1(한글)을, 본문은 없는 글자모양 2를 가리킨다.
// 대상(MINIMAL_HEADER)의 다음 새 id는 글꼴 1·테두리 2·글자모양 2라 셋 다 조각의 없는 id와 같다.
const CARRIED_SRC_HEADER = MINIMAL_HEADER.replace('<hh:font id="0" face="x"', '<hh:font id="0" face="y"')
  .replace('<hh:borderFill id="1" threeD="0"/>', '<hh:borderFill id="1" threeD="1"/>')
  .replace('<hh:charPr id="0" height="1000" borderFillIDRef="1"><hh:fontRef hangul="0"/>', '<hh:charPr id="0" height="1500" borderFillIDRef="2"><hh:fontRef hangul="0"/>')
  .replace('<hh:charPr id="1" height="1200" borderFillIDRef="1"><hh:fontRef hangul="0"/>', '<hh:charPr id="1" height="1200" borderFillIDRef="1"><hh:fontRef hangul="1"/>');
const CARRIED_BODY =
  '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>a</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>b</hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>c</hp:t></hp:run></hp:p>';
const idsOf = (doc: HwpxDocument, kind: string): string[] => (doc.header.resources[kind] ?? []).map((x) => x.id);

/** 조각의 없는 참조(종류, id) 가운데 대상에 없던 그 id의 자원이 결과에 생긴 것(넣은 참조가 새 자원을 가리키게 된 것). 글꼴은 한글 목록만 있다 */
function carriedOverlaps(fragment: Fragment, target: HwpxDocument, result: HwpxDocument): string[] {
  const has = (doc: HwpxDocument, kind: string, id: string): boolean => idsOf(doc, kind).includes(id);
  return fragment.dangling.filter((d) => !has(target, d.kind, d.id) && has(result, d.kind, d.id)).map((d) => `${d.kind} ${d.id}`);
}

test("7.5 조각이 원본에도 대상에도 없는 id(본문의 글자모양 2, 자원 안의 테두리 2·글꼴 1)를 가리키고 그 id가 대상의 다음 새 id여도 새 자원은 그 id를 받지 않는다(#115)", () => {
  const src = parseSynthetic([CARRIED_BODY], CARRIED_SRC_HEADER);
  assert.equal(CARRIED_SRC_HEADER.match(/face="y"|threeD="1"|borderFillIDRef="2"|hangul="1"/g)?.length, 4, "원본 header 변형 4곳");
  const target = parseSynthetic([charRun("0")]);
  const r = runDocs(src, 0, 0, target, endOf(target));
  assert.deepEqual(r.fragment.dangling.map((d) => `${d.kind} ${d.id}`).sort(), ["borderFill 2", "charPr 2", "font 1"]);
  // 전제: 대상의 다음 새 id(가장 큰 숫자 + 1)가 조각의 없는 id와 같고, 대상에는 없는 참조가 없다
  assert.deepEqual([idsOf(target, "font"), idsOf(target, "borderFill"), idsOf(target, "charPr")], [["0"], ["1"], ["0", "1"]]);
  assert.deepEqual(missingMessages(target), []);
  // 겹침 0: 새 글꼴·테두리·글자모양은 조각의 없는 id를 건너뛴다
  assert.deepEqual(carriedOverlaps(r.fragment, target, r.result), []);
  assert.deepEqual(idsOf(r.result, "font"), ["0", "2"]);
  assert.deepEqual(idsOf(r.result, "borderFill"), ["1", "3"]);
  assert.deepEqual(idsOf(r.result, "charPr"), ["0", "1", "3", "4"]);
  // 넣은 본문: 글자모양 0·1은 새 자원(3·4)을, 없는 글자모양 2는 그대로 없는 대상을 가리킨다. 자원 안의 없는 참조도 그대로다
  assert.deepEqual(attrsOf(r.block, "charPrIDRef"), ["3", "4", "2"]);
  const after = missingMessages(r.result);
  for (const label of ["charPr 2", "borderFill 2", "font(HANGUL) 1"]) {
    assert.equal(after.filter((m) => m.startsWith(`${label}이(가) 없는데 1곳`)).length, 1, `${label}: ${after.join("|")}`);
  }
  assert.equal(after.length, 3, after.join("|"));
  const plan = planImport(target, r.fragment, endOf(target));
  assert.deepEqual(plan.inherited.danglingRefs, r.fragment.dangling);
  assert.equal(r.plan.summary["addedResources"], expectedAdded(r));
  // JSON 왕복 조각도 같은 계획이다
  assert.deepEqual(planImport(target, parseFragment(serializeFragment(r.fragment)), endOf(target)), plan);
  // 같은 결과에 다시 넣으면 자원은 전부 재사용되고, 없는 참조는 여전히 비어 있다
  const again = runDocs(src, 0, 0, r.result, endOf(r.result), { fragment: r.fragment });
  assert.equal(again.plan.summary["addedResources"], 0);
  assert.deepEqual(carriedOverlaps(r.fragment, r.result, again.result), []);
});

test("7.5 조각의 없는 참조 기록이 없는 이전 형식 조각(dangling 키 없음)은 그 id를 알 수 없어 건너뛰지 못한다(알려진 한계, #115)", () => {
  const src = parseSynthetic([CARRIED_BODY], CARRIED_SRC_HEADER);
  const target = parseSynthetic([charRun("0")]);
  const json = JSON.parse(serializeFragment(extractFragment(src, sel(0, 0)))) as Record<string, unknown>;
  delete json["dangling"];
  const legacy = parseFragment(JSON.stringify(json));
  assert.deepEqual(legacy.dangling, []);
  const r = runDocs(src, 0, 0, target, endOf(target), { fragment: legacy });
  // 같은 원본에서 뗀 기록으로 세면 세 id 모두 새 자원이 받는다(이 사례가 실제로 겹치는 사례라는 확인이기도 하다)
  const recorded = { ...legacy, dangling: extractFragment(src, sel(0, 0)).dangling };
  assert.deepEqual(carriedOverlaps(recorded, target, r.result).sort(), ["borderFill 2", "charPr 2", "font 1"]);
});

// ── rootfile ────────────────────────────────────────────────────────────

test("7.5-6 이진 자료 등록은 container.xml이 가리키는 패키지 문서(pkg.rootfile)에 한다: 이름이 content.hpf가 아니어도 된다", () => {
  const original = loadDoc("hancom/blocks");
  const moved = "Package/main.hpf";
  const zip = buildZip(
    original.pkg.archive.entries
      .filter((e) => !e.isDirectory)
      .map((e) => {
        let data = readEntry(original.pkg.archive, original.pkg.bytes, e.name);
        if (e.name === "META-INF/container.xml") data = utf8(decode(data).replace(`full-path="${HPF}"`, `full-path="${moved}"`));
        return { name: e.name === HPF ? moved : e.name, data, method: e.name === "mimetype" ? (0 as const) : (8 as const) };
      }),
  );
  const target = reparse(zip);
  assert.equal(target.pkg.rootfile, moved);
  assert.ok(target.pkg.archive.entries.every((e) => e.name !== HPF));
  const r = runDocs(loadDoc("hancom/picture"), 1, 1, target, endOf(target));
  assert.deepEqual(r.plan.edits.filter((e) => e.reason.includes("manifest")).map((e) => e.entry), [moved]);
  assertPictureImported(r, "picture → 옮긴 rootfile");
  assert.ok(decode(readEntry(r.result.pkg.archive, r.bytes, moved)).includes(PICTURE_ITEM("image1", "BinData/image1.png")));
  assert.equal(r.result.pkg.rootfile, moved);
});

// ── 본문 참조 종류 보강: hp:t의 charStyleIDRef(글자 스타일), hp:compose 안 charPr의 prIDRef(글자모양) ──────────────
// 근거(실제 문서 모음 642건 집계): hp:t의 charStyleIDRef 799곳(13건)은 전부 type="CHAR"인 스타일의 id였고,
// hp:compose 안 charPr의 prIDRef는 "참조 없음"을 뺀 156곳(13건)이 전부 글자모양 id였다(문단모양은 154곳, 테두리는 142곳만 맞았다).
// 이 시험의 문서는 합성이고, 기대는 "그 참조가 가리키는 자원의 전개(참조까지 푼 모양)가 소스와 같다"는 것이다.

// 글자모양 7(높이 1700)과, 그것을 쓰는 글자 스타일 5가 더 있는 원본 header
const SRC7_HEADER = MINIMAL_HEADER.replace('<hh:charProperties itemCnt="2">', '<hh:charProperties itemCnt="3">')
  .replace("</hh:charProperties>", '<hh:charPr id="7" height="1700" borderFillIDRef="1"><hh:fontRef hangul="0"/></hh:charPr></hh:charProperties>')
  .replace('<hh:styles itemCnt="1">', '<hh:styles itemCnt="2">')
  .replace("</hh:styles>", '<hh:style id="5" type="CHAR" name="강조" paraPrIDRef="0" charPrIDRef="7" nextStyleIDRef="5"/></hh:styles>');
assert.notEqual(SRC7_HEADER, MINIMAL_HEADER);
const CHAR_STYLE_BODY = '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t charStyleIDRef="5">강조 글</hp:t></hp:run></hp:p>';
const COMPOSE_BODY =
  '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:compose circleType="SHAPE_CIRCLE" charSz="-3" composeType="SPREAD" composeText="가나" charPrCnt="1"><hp:charPr prIDRef="7"/></hp:compose></hp:run></hp:p>';
const END_BODY = '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>끝</hp:t></hp:run></hp:p>';

const attrsOf = (block: string, name: string): string[] => [...block.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1] ?? "");

test("5.2 본문 참조 분류: hp:t의 charStyleIDRef는 스타일, hp:compose 안 charPr의 prIDRef는 글자모양이고, 다른 *IDRef는 계속 unknown이다", () => {
  const doc = parseSynthetic(
    [
      CHAR_STYLE_BODY +
        COMPOSE_BODY +
        '<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:foo prIDRef="3"/><hp:checkBtn borderTypeIDRef="4"/><hp:ctrl charStyleIDRef="5"/></hp:run></hp:p>',
    ],
    SRC7_HEADER,
  );
  const refs = doc.sections[0]?.bodyRefs ?? [];
  const named = (attr: string): string[] => refs.filter((r) => r.attr.qname === attr).map((r) => `${r.element.local}:${r.kind}:${r.id}`);
  assert.deepEqual(named("charStyleIDRef"), ["t:style:5", "ctrl:style:5"]);
  assert.deepEqual(named("prIDRef"), ["charPr:charPr:7", "foo:unknown:3"], "prIDRef는 charPr 요소에서만 글자모양이다(근거가 그 요소뿐)");
  assert.deepEqual(named("borderTypeIDRef"), ["checkBtn:unknown:4"], "값이 테두리 id 집합에 들어맞지 않아 대상을 정하지 못했다");
});

test("5.2 모델의 참조 확인: 없는 스타일·글자모양을 가리키는 charStyleIDRef·prIDRef는 MODEL_REF_MISSING이고, 있으면 조용하다", () => {
  const broken = parseSynthetic([CHAR_STYLE_BODY.replace('"5"', '"9"') + COMPOSE_BODY.replace('"7"', '"8"')], SRC7_HEADER);
  assert.deepEqual(missingMessages(broken), ["charPr 8이(가) 없는데 1곳에서 가리킵니다.", "style 9이(가) 없는데 1곳에서 가리킵니다."]);
  assert.deepEqual(broken.issues.filter((i) => i.code === "MODEL_UNKNOWN_REF"), []);
  const fine = parseSynthetic([CHAR_STYLE_BODY + COMPOSE_BODY], SRC7_HEADER);
  assert.deepEqual(missingMessages(fine), []);
  assert.deepEqual(fine.issues.filter((i) => i.code === "MODEL_UNKNOWN_REF"), []);
  // "참조 없음"(4294967295, -1)은 실제 문서의 compose에서 prIDRef 값의 90%다: 없는 대상으로 세지 않는다(검사기와 같다)
  const none = parseSynthetic([COMPOSE_BODY.replace('"7"', '"4294967295"') + COMPOSE_BODY.replace('"7"', '"-1"')], SRC7_HEADER);
  assert.deepEqual(missingMessages(none), []);
});

const CHAR_STYLE_TARGETS: [string, string][] = [
  ["대상에 그 스타일이 없다", MINIMAL_HEADER],
  [
    "대상에 같은 id의 다른 모양 스타일이 있다",
    MINIMAL_HEADER.replace('<hh:styles itemCnt="1">', '<hh:styles itemCnt="2">').replace(
      "</hh:styles>",
      '<hh:style id="5" type="PARA" name="다른" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="5"/></hh:styles>',
    ),
  ],
];

for (const [name, header] of CHAR_STYLE_TARGETS) {
  test(`7.5 charStyleIDRef(hp:t): ${name} — 가져온 뒤 참조가 가리키는 스타일의 전개가 소스와 같다`, () => {
    const src = parseSynthetic([CHAR_STYLE_BODY], SRC7_HEADER);
    const target = parseSynthetic([END_BODY], header);
    const f = extractFragment(src, sel(0, 0));
    assert.ok(f.refs.some((r) => r.kind === "style" && r.id === "5"), "본문 참조에 charStyleIDRef가 든다");
    assert.ok(f.resources.some((r) => r.kind === "style" && r.id === "5") && f.resources.some((r) => r.kind === "charPr" && r.id === "7"), "자원 의존 닫힘에 스타일과 그 글자모양이 든다");
    assert.equal(f.prints.length, f.refs.length, "지문은 참조마다 하나다");
    assert.deepEqual(f.issues.filter((i) => i.code === "FRAG_UNKNOWN_REF"), []);
    const r = runDocs(src, 0, 0, target, endOf(target), { fragment: f });
    const [ref] = attrsOf(r.block, "charStyleIDRef");
    assert.ok(ref !== undefined);
    assert.deepEqual(expandResource(r.result, "style", ref), expandResource(src, "style", "5"), `결과의 style ${ref}`);
    assert.ok(!missingMessages(r.result).some((m) => m.startsWith("style")), "없는 스타일을 가리키지 않는다");
    assert.equal(r.plan.summary["addedResources"], 2, "글자 스타일과 그 글자모양이 새로 들어온다");
    // 대상의 기존 스타일 원문은 그대로다
    for (const s of target.header.resources["style"] ?? []) assert.ok(r.result.header.text.includes(target.header.text.slice(s.element.start, s.element.end)));
  });
}

test("7.5 charStyleIDRef(hp:t) 대조군: 대상에 같은 모양의 스타일이 다른 id로 있으면 그것을 재사용한다(자원 추가 0)", () => {
  const header = MINIMAL_HEADER.replace('<hh:charProperties itemCnt="2">', '<hh:charProperties itemCnt="3">')
    .replace("</hh:charProperties>", '<hh:charPr id="4" height="1700" borderFillIDRef="1"><hh:fontRef hangul="0"/></hh:charPr></hh:charProperties>')
    .replace('<hh:styles itemCnt="1">', '<hh:styles itemCnt="2">')
    .replace("</hh:styles>", '<hh:style id="3" type="CHAR" name="강조" paraPrIDRef="0" charPrIDRef="4" nextStyleIDRef="3"/></hh:styles>');
  const src = parseSynthetic([CHAR_STYLE_BODY], SRC7_HEADER);
  const target = parseSynthetic([END_BODY], header);
  const r = runDocs(src, 0, 0, target, endOf(target));
  assert.equal(r.plan.summary["addedResources"], 0);
  assert.deepEqual(attrsOf(r.block, "charStyleIDRef"), ["3"]);
  assert.deepEqual(expandResource(r.result, "style", "3"), expandResource(src, "style", "5"));
});

const COMPOSE_TARGETS: [string, string][] = [
  ["대상에 그 글자모양이 없다", MINIMAL_HEADER],
  [
    "대상에 같은 id의 다른 모양 글자모양이 있다",
    MINIMAL_HEADER.replace('<hh:charProperties itemCnt="2">', '<hh:charProperties itemCnt="3">').replace(
      "</hh:charProperties>",
      '<hh:charPr id="7" height="900" borderFillIDRef="1"><hh:fontRef hangul="0"/></hh:charPr></hh:charProperties>',
    ),
  ],
];

for (const [name, header] of COMPOSE_TARGETS) {
  test(`7.5 prIDRef(hp:compose의 charPr): ${name} — 가져온 뒤 참조가 가리키는 글자모양의 전개가 소스와 같다`, () => {
    const src = parseSynthetic([COMPOSE_BODY], SRC7_HEADER);
    const target = parseSynthetic([END_BODY], header);
    const f = extractFragment(src, sel(0, 0));
    assert.ok(f.refs.some((r) => r.kind === "charPr" && r.id === "7"), "본문 참조에 prIDRef가 든다");
    assert.ok(f.resources.some((r) => r.kind === "charPr" && r.id === "7"));
    assert.equal(f.prints.length, f.refs.length);
    assert.deepEqual(f.issues.filter((i) => i.code === "FRAG_UNKNOWN_REF"), []);
    const r = runDocs(src, 0, 0, target, endOf(target), { fragment: f });
    const [ref] = attrsOf(r.block, "prIDRef");
    assert.ok(ref !== undefined);
    assert.deepEqual(expandResource(r.result, "charPr", ref), expandResource(src, "charPr", "7"), `결과의 charPr ${ref}`);
    assert.ok(!missingMessages(r.result).some((m) => m.startsWith("charPr")), "없는 글자모양을 가리키지 않는다");
  });
}

test("7.3 여전히 unknown인 참조(borderTypeIDRef)가 든 조각은 FRAG_UNKNOWN_REF 경고를 내고, 문구는 '번역하지 않고 원래 값 그대로 옮긴다'고 사실대로 말한다", () => {
  const src = parseSynthetic(
    ['<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:checkBtn borderTypeIDRef="4"/><hp:t charStyleIDRef="5">x</hp:t></hp:run></hp:p>'],
    SRC7_HEADER,
  );
  const f = extractFragment(src, sel(0, 0));
  const unknown = f.issues.filter((i) => i.code === "FRAG_UNKNOWN_REF");
  assert.equal(unknown.length, 1, JSON.stringify(f.issues));
  assert.ok(unknown[0]?.message.includes("borderTypeIDRef"));
  assert.ok(unknown[0]?.message.includes("번역하지 않고 원래 값 그대로 옮깁니다"), unknown[0]?.message);
  assert.ok(!unknown[0]?.message.includes("옮기지 않습니다"), "옛 문구('조각이 옮기지 않습니다')는 사실과 다르다");
  const target = parseSynthetic([END_BODY]);
  const r = runDocs(src, 0, 0, target, endOf(target), { fragment: f });
  assert.deepEqual(attrsOf(r.block, "borderTypeIDRef"), ["4"], "값은 그대로 옮긴다");
});
