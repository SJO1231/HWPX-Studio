// 제목 범위(7.10 `headingRange`)의 실제 문서 시험(선택 실행): 환경변수 HWPX_CORPUS_DIR가 가리키는 폴더의 .hwpx를 읽기만 한다(쓰기·이동·삭제 없음).
// 문서 이름·글은 기록하지 않는다: 진단에는 경로 해시 앞 10자와 수량만 남긴다. 결과 파일을 쓰지 않는다(모두 메모리).
//   HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/heading-corpus.test.ts
// 문서마다: (1) "번호 글자 꼴로 시작하는 문단"(시험이 따로 정한 넓은 꼴) 가운데 제목으로 탐지된 비율 70% 이상,
// (2) 제목 범위 2곳 이상을 다른 문서의 같은 꼴 제목 범위 조각으로 교체 → 게이트 통과·검사기 새 오류 0·같은 범위의 range 결과와 바이트 동일(합계 30회 이상),
// (3) 맨 앞 문단 뒤에 문단 2개를 끼운 사본에서 그 앵커들이 relocated(새 주소 = 옛 주소 + 2)로 다시 찾아진다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sameSnapshot, scanCorpus, snapshotOf } from "../../../tools/stress/corpus.ts";
import { extractFragment, openPackage, parseDocument, serializeFragment, validateDocument, walkParagraphs, type HwpxDocument, type ParagraphNode } from "../src/index.ts";
import { checkAnchors, detectHeadings, generate, headingRangeOf, makeHeadingRangeAnchor, makeRangeAnchor, resolveAnchors, type Heading, type HeadingRangeAnchor } from "../src/fill/index.ts";
import { hasSecPr } from "../src/fill/doc.ts";
import { listAtParent, splitsField } from "../src/fill/range.ts";
import { readDataset, type Template } from "../src/template/index.ts";
import { bytesEqual, newErrorsAfter, sha256Hex, utf8 } from "./helpers.ts";

const DIR = process.env["HWPX_CORPUS_DIR"];
const SKIP = DIR === undefined || DIR === "" ? "HWPX_CORPUS_DIR이 없어 건너뜀(미검증)" : false;
const MAX_BYTES = 5_000_000;
const PER_DOC = 2;

/**
 * 시험이 따로 정한 "번호 글자 꼴로 시작하는 문단"(글 머리의 공백·개체 자리 글자를 건너뛴 뒤): 숫자(점 다단)+점·닫는 괄호, 괄호 숫자·한글,
 * 한글 한 글자+점·닫는 괄호, 원·괄호 문자 영역(U+2460~24FF, U+2776~2793, U+3200~32FF), 제N장·절·조·항·호, 기호(□ ■ ○ ● ◇ ◆ ▶ ▷ ※ · - 등).
 * 엔진의 판독기보다 넓다(어느 한글 글자든, 공백 없는 `-`, ➀ 같은 딩뱃 원문자도 센다).
 */
const NUMBERED = /^(?:\d{1,3}(?:\.\d{1,3})*[.)]|\(\s*\d{1,3}\s*\)|[가-힣][.)]|\(\s*[가-힣]\s*\)|[\u2460-\u24ff\u2776-\u2793\u3200-\u32ff]|제\s*\d+\s*[장절조항호]|[□■○●◇◆▶▷※·◎◈▣▪▫◦•►▸☞★☆◯❍➢➤∙‧・ㆍ\-–—])/u;

const tpl = (anchors: unknown[], rules: unknown[]): Template => ({ schema: "hwpx-studio/template@1", anchors, rules, options: { missing: "keep" } }) as Template;
const EMPTY = readDataset({});

type Doc = { id: string; bytes: Uint8Array; doc: HwpxDocument; headings: Heading[] };
type Span = { heading: Heading; from: number; to: number; list: ParagraphNode[] };

function open(id: string, bytes: Uint8Array): Doc | undefined {
  try {
    const doc = parseDocument(openPackage(bytes));
    return { id, bytes, doc, headings: detectHeadings(doc) };
  } catch {
    return undefined;
  }
}

/** 교체할 수 있는 제목 범위: 구역 설정 문단이 없고 누름틀 짝을 자르지 않는다 */
function spans(d: Doc): Span[] {
  return d.headings.flatMap((h): Span[] => {
    const r = headingRangeOf(d.doc, h.at, h.index);
    const section = d.doc.sections[h.at.sectionIndex];
    const list = section === undefined ? undefined : listAtParent(section, h.at.parentPath);
    if (r === undefined || list === undefined) return [];
    const ps = list.slice(r.from, r.to + 1);
    return ps.some(hasSecPr) || splitsField(ps) !== undefined ? [] : [{ heading: h, from: r.from, to: r.to, list }];
  });
}

/** 같은 구역에서 글(해시)이 한 번만 나오는 제목인가(아니면 앞에 문단을 끼운 사본에서 ambiguous가 맞다) */
function unique(d: Doc, h: Heading): boolean {
  const section = d.doc.sections[h.at.sectionIndex];
  if (section === undefined) return false;
  let n = 0;
  for (const p of walkParagraphs(section.paragraphs)) if (sha256Hex(utf8(p.logicalText)) === h.sha256) n++;
  return n === 1;
}

test("7.10 실제 공고서: 번호 글자 문단 탐지율 문서별 70% 이상, 제목 범위를 다른 문서의 같은 꼴 조각으로 교체(게이트·새 오류 0·range와 바이트 동일, 30회 이상), 앞 문단 2개 삽입 뒤 relocated", { skip: SKIP }, (t) => {
  assert.ok(typeof DIR === "string");
  const files = scanCorpus(DIR).filter((f) => f.size <= MAX_BYTES);
  const before = snapshotOf(scanCorpus(DIR));
  const docs: Doc[] = [];
  let unreadable = 0;
  for (const f of files) {
    const d = open(f.id, new Uint8Array(readFileSync(f.abs)));
    if (d === undefined) unreadable++;
    else docs.push(d);
  }
  assert.ok(docs.length >= 10, `읽은 문서 ${docs.length}건`);

  // (1) 탐지율
  const rates: { id: string; numbered: number; detected: number; rate: number }[] = [];
  for (const d of docs) {
    const found = new Set(d.headings.map((h) => `${h.at.sectionIndex}|${[...h.at.parentPath, h.index].join(",")}`));
    let numbered = 0;
    let detected = 0;
    for (const s of d.doc.sections) {
      for (const p of walkParagraphs(s.paragraphs)) {
        if (!NUMBERED.test(p.logicalText.replace(/^[\s\ufffc]*/u, ""))) continue;
        numbered++;
        if (found.has(`${s.index}|${p.path.join(",")}`)) detected++;
      }
    }
    rates.push({ id: d.id, numbered, detected, rate: numbered === 0 ? 1 : detected / numbered });
  }
  t.diagnostic(`탐지율(문서 ${docs.length}건, 읽을 수 없음 ${unreadable}): ${rates.map((r) => `${r.id} ${r.detected}/${r.numbered}=${r.rate.toFixed(3)}`).join(", ")}`);
  for (const r of rates) assert.ok(r.rate >= 0.7, `${r.id}: 탐지율 ${r.rate.toFixed(3)}`);

  // (2) 교체: 문서마다 고유한 제목의 범위 PER_DOC곳(꼴이 서로 다르게, 문서마다 먼저 고르는 꼴을 돌려 가며), 조각은 다른 문서의 같은 꼴 범위
  const all = docs.map((d) => ({ d, spans: spans(d) }));
  let replaced = 0;
  let relocated = 0;
  const forms: Record<string, number> = {};
  const FORMS = ["digitDot", "hangulDot", "digitParen", "hangulParen", "digitParens", "hangulParens", "circled", "box", "roman", "article", "none"];
  for (const [n, { d, spans: mine }] of all.entries()) {
    const picked: Span[] = [];
    const eligible = mine.filter((s) => unique(d, s.heading) && (s.heading.at.parentPath.length > 0 || s.from > 0));
    const prefer = [...FORMS.slice(n % FORMS.length), ...FORMS.slice(0, n % FORMS.length)];
    for (const form of prefer) {
      const s = eligible.find((x) => x.heading.marker.form === form);
      if (s !== undefined && picked.length < PER_DOC) picked.push(s);
    }
    for (const s of eligible) if (picked.length < PER_DOC && !picked.includes(s)) picked.push(s);
    assert.ok(picked.length >= PER_DOC, `${d.id}: 교체할 제목 범위 ${picked.length}곳`);
    const anchors: HeadingRangeAnchor[] = [];
    for (const [k, s] of picked.entries()) {
      const h = s.heading;
      const draft = makeHeadingRangeAnchor(d.doc, h.at.sectionIndex, h.at.parentPath, h.index);
      const rdraft = makeRangeAnchor(d.doc, h.at.sectionIndex, h.at.parentPath, s.from, s.to);
      assert.ok(draft !== undefined && rdraft !== undefined);
      assert.deepEqual(draft.print, rdraft.print, `${d.id}: 범위 지문`);
      const anchor: HeadingRangeAnchor = { id: `h${k}`, ...draft };
      anchors.push(anchor);
      // 다른 문서에서 같은 꼴의 범위 조각(앞 문서부터, 뽑을 수 있는 첫 것)
      let fragment: Record<string, unknown> | undefined;
      for (const other of all) {
        if (other.d === d || fragment !== undefined) continue;
        for (const o of other.spans) {
          if (o.heading.marker.form !== h.marker.form) continue;
          try {
            fragment = JSON.parse(serializeFragment(extractFragment(other.d.doc, { sectionIndex: o.heading.at.sectionIndex, parentPath: o.heading.at.parentPath, from: o.from, to: o.to }))) as Record<string, unknown>;
            break;
          } catch {
            continue;
          }
        }
      }
      assert.ok(fragment !== undefined, `${d.id}: ${h.marker.form} 꼴 조각이 다른 문서에 없다`);
      const rule = { id: "x", do: { type: "inject", anchor: anchor.id, position: "replace", fragment } };
      const rh = generate(d.bytes, tpl([anchor], [rule]), EMPTY);
      const rr = generate(d.bytes, tpl([{ id: anchor.id, ...rdraft }], [rule]), EMPTY);
      assert.ok(rh.ok && !rh.dryRun, `${d.id} ${h.marker.form}: ${rh.report.issues.filter((i) => i.severity === "error").map((i) => i.code).join(",")}`);
      assert.ok(rr.ok && !rr.dryRun);
      assert.deepEqual(rh.report.validation?.newErrors, [], `${d.id}: 게이트 새 오류`);
      assert.deepEqual(newErrorsAfter(validateDocument(d.bytes), validateDocument(rh.output)), [], `${d.id}: 검사기 새 오류`);
      assert.ok(bytesEqual(rh.output, rr.output), `${d.id}: range와 바이트 동일`);
      forms[h.marker.form] = (forms[h.marker.form] ?? 0) + 1;
      replaced++;
    }

    // (3) 맨 앞 문단 뒤에 문단 2개(제목이 아닌 글)를 끼운 사본
    const first = d.doc.sections[0]?.paragraphs[0];
    assert.ok(first !== undefined);
    const lineAnchor = { id: "p0", kind: "line", at: { sectionIndex: 0, path: [0] }, print: { text: first.logicalText.slice(0, 40), sha256: sha256Hex(utf8(first.logicalText)) } };
    const shiftedResult = generate(d.bytes, tpl([lineAnchor], [{ id: "i", do: { type: "insertText", anchor: "p0", position: "after", value: { text: "끼운 문단입니다.\n끼운 둘째 문단입니다." }, style: "inherit" } }]), EMPTY);
    assert.ok(shiftedResult.ok && !shiftedResult.dryRun, `${d.id}: 사본 만들기`);
    const shifted = parseDocument(openPackage(shiftedResult.output));
    const res = resolveAnchors(shifted, tpl(anchors, []));
    const checks = checkAnchors(shifted, { anchors });
    for (const [k, a] of anchors.entries()) {
      // 구역 0의 최상위 제목(번호 1 이상)과, 문단 1 이상에 든 하위 목록의 제목은 두 칸 밀린다. 그 밖(다른 구역, 문단 0의 머리말·표)은 그대로다
      const owner = a.at.parentPath[0];
      const moved = a.at.sectionIndex === 0 && (owner === undefined || owner >= 1);
      const wantAt = !moved ? { parentPath: a.at.parentPath, index: a.index } : owner === undefined ? { parentPath: [], index: a.index + 2 } : { parentPath: [owner + 2, ...a.at.parentPath.slice(1)], index: a.index };
      const c = checks[k];
      assert.equal(c?.state, moved ? "relocated" : "exact", `${d.id}: 앵커 ${a.id}`);
      assert.deepEqual(c?.found && "index" in c.found ? [c.found.at.parentPath, c.found.index] : undefined, [wantAt.parentPath, wantAt.index], `${d.id}: 새 주소`);
      const r = res.anchors.get(a.id);
      assert.ok(r?.kind === "range" && r.relocated === moved);
      if (moved) relocated++;
    }
  }
  const after = snapshotOf(scanCorpus(DIR));
  t.diagnostic(`교체 ${replaced}회(꼴 ${JSON.stringify(forms)}), 앞 문단 2개 삽입 뒤 relocated ${relocated}건, 문서 모음 그대로 ${sameSnapshot(before, after)}`);
  assert.ok(replaced >= 30, `교체 ${replaced}회`);
  assert.ok(relocated >= 30, `relocated ${relocated}건`);
  assert.ok(sameSnapshot(before, after), "읽기 전용: 문서 모음이 바뀌지 않았다");
});
