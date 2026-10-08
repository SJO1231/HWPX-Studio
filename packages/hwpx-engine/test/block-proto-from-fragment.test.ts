// 조각에서 원형 1판 만들기(엔진 명세 8.8.17 `protoFromFragment`, 이슈 #112): 옛 저장소의 조각을 원형으로 옮길 때 덩어리·내용 해시·`keys`가
// `extractBlock`과 같은 규칙인지 본다. 기대 keys는 합성 문서를 만들 때 문단마다 적어 둔 값(명세 8.8.5·8.8.17의 규칙: 느슨한 `{{ 키 }}`, 누름틀·메일머지
// 표시 구간 밖, 하위 목록 포함 문서 순서, NFC로 같은 키는 처음 것만)으로 따로 계산한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findPlaceholders, HwpxError, parseFragment, type HwpxDocument } from "../src/index.ts";
import { buildBlockPreviewDocument, extractBlock, generateFromTemplate, makeHeadingRangeAnchor, makeRangeAnchor, protoFromFragment, type BlockRange } from "../src/fill/index.ts";
import { listAtParent, splitsField } from "../src/fill/range.ts";
import { readBlockProto, readStudioTemplate, sha256Hex, writeBlockProto } from "../src/template/index.ts";
import { buildHwpx, bytesEqual, readFixture, reparse } from "./helpers.ts";
import { at, HEADINGS, notice, rng } from "./range-helpers.ts";
import { paragraph, tableParagraph, textPara, type TableSpec } from "./table-helpers.ts";

const AT = "2026-10-07T09:30:00Z";
const meta = (id = "k0000f112", name = "이관 시험") => ({ id, name, at: AT });

const failure = (f: () => unknown): HwpxError => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof HwpxError, `HwpxError가 아니다: ${String(e)}`);
    return e;
  }
  assert.fail("던지지 않았다");
};

// ── 합성 문서: 문단마다 기대 keys를 함께 적는다 ─────────────────────

const nfd = (s: string): string => s.normalize("NFD");
const nfc = (s: string): string => s.normalize("NFC");
const clickBegin = (id: number, name: string): string => `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="0" zorder="-1" fieldid="627272811" metaTag=""/></hp:ctrl>`;
const clickEnd = (id: number): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="627272811"/></hp:ctrl>`;
const mergeBegin = (id: number, key: string): string =>
  `<hp:ctrl><hp:fieldBegin id="${id}" type="MAILMERGE" name="" editable="0" dirty="0" zorder="-1" fieldid="627928423" metaTag=""><hp:parameters cnt="5" name=""><hp:booleanParam name="Fiexde">1</hp:booleanParam><hp:integerParam name="Prop">8</hp:integerParam><hp:stringParam name="Command">${key}</hp:stringParam><hp:stringParam name="FieldType">USER_DEFINE</hp:stringParam><hp:stringParam name="FieldValue">${key}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`;
const mergeEnd = (id: number): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="627928423"/></hp:ctrl>`;
const merge = (id: number, key: string, shown: string): string => `${mergeBegin(id, key)}<hp:t>${shown}</hp:t>${mergeEnd(id)}`;
const link = (id: number, shown: string): string =>
  `<hp:ctrl><hp:fieldBegin id="${id}" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="${id}" metaTag=""><hp:parameters cnt="1" name=""><hp:stringParam name="Command">https\\://example.com/;1;0;0;</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>${shown}</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}"/></hp:ctrl>`;
const t = (s: string): string => `<hp:t>${s}</hp:t>`;
const LONG = "제출 서류는 원본 1부입니다. 문의는 담당 부서 &amp; 지원 팀으로 하십시오. &lt;참고&gt; 기한을 지키십시오. \"인용\"과 '홑따옴표'. ";

/** 최상위 문단 하나: 원문과 기대 keys(하위 목록 포함 문서 순서). 표 문단은 칸마다 문단별 기대 keys도 둔다 */
type Para = { xml: string; keys: string[]; cells?: string[][][] };

function synthetic(): { bytes: Uint8Array; paras: Para[] } {
  let id = 100;
  const next = (): number => ++id;
  const paras: Para[] = [];
  for (let u = 0; u < 30; u++) {
    switch (u % 10) {
      case 0: // 공백 든 키·엄격 키·앞뒤 공백 여러 칸, 긴 글과 XML 특수문자
        paras.push({ xml: textPara(`${u}번 안내: {{ 담당 부서 }}와 {{사업명}}, {{  공고 번호${u % 7}  }} ${LONG.repeat(3)}`), keys: ["담당 부서", "사업명", `공고 번호${u % 7}`] });
        break;
      case 1: { // 누름틀 표시 글 안의 {{ }}는 빼고 밖의 것만
        const f = next();
        paras.push({ xml: paragraph(`${t("앞 ")}${clickBegin(f, "성명")}${t("{{ 성명 }}")}${clickEnd(f)}${t(` 뒤 {{ 연락 처 }} {{ 성명 }}`)}`), keys: ["연락 처", "성명"] });
        break;
      }
      case 2: { // 메일머지 표시 글 안의 {{ }}는 빼고, 같은 이름의 밖 자리는 센다. 하이퍼링크 표시 글 안의 것은 센다
        const m = next();
        const h = next();
        paras.push({ xml: paragraph(`${merge(m, "기관명", "{{기관명}}")}${t(" 그리고 {{ 기관 명칭 }} ")}${link(h, "{{ 링크 키 }}")}${t(" {{기관명}}")}`), keys: ["기관 명칭", "링크 키", "기관명"] });
        break;
      }
      case 3: { // 표: 칸 안 메일머지·누름틀과 칸 문단의 키(하위 목록)
        const m = next();
        const c = next();
        const cellA = [paragraph(merge(m, "담당자", "{{ 담당자 }}")), textPara("칸 {{ 칸 키 }}"), textPara(`{{ 담당 부서 }} 칸 셋 ${LONG}`)];
        const cellB = [paragraph(`${clickBegin(c, "칸 이름")}${t("{{ 칸 이름 }}")}${clickEnd(c)}${t(" {{사업명}} 칸")}`), textPara(`{{ 칸${u} 끝 }}`)];
        const cells = [[[], ["칸 키"], ["담당 부서"]], [["사업명"], [`칸${u} 끝`]]];
        const spec: TableSpec = {
          id: String(7000 + u),
          rowCnt: 1,
          colCnt: 2,
          cells: [
            { row: 0, col: 0, width: 9000, height: 1000, paragraphs: cellA },
            { row: 0, col: 1, width: 9000, height: 1000, paragraphs: cellB },
          ],
        };
        paras.push({ xml: tableParagraph(spec), keys: cells.flat(2), cells });
        break;
      }
      case 4: // NFD로 쓴 같은 키(앞에 NFC가 있으면 빠진다)와 새 키
        paras.push({ xml: textPara(`{{ ${nfd("담당 부서")} }} 다시, {{ ${nfd("새 항목")} }}`), keys: [nfd("담당 부서"), nfd("새 항목")] });
        break;
      case 5: // 자리가 아닌 것: 빈 키, 공백만, 81자. 80자는 자리
        paras.push({ xml: textPara(`{{}} {{ }} {{${"가".repeat(81)}}} 빈 자리, {{${"나".repeat(80)}}}`), keys: ["나".repeat(80)] });
        break;
      case 6: // 줄바꿈이 든 것은 자리가 아니고 탭이 든 것은 자리
        paras.push({ xml: paragraph(t("{{ 줄<hp:lineBreak/>바꿈 }} 와 {{ 탭<hp:tab width=\"0\" leader=\"0\" type=\"1\"/>키 }}")), keys: ["탭\t키"] });
        break;
      case 7: { // 세 문단에 걸친 누름틀: 시작 뒤·끝 앞은 빼고 밖만(사이 문단의 {{ }}는 아래 따로 본다)
        const f = next();
        paras.push({ xml: paragraph(`${t("앞 {{ 앞 키 }} ")}${clickBegin(f, "긴 안내")}${t("{{ 안 첫 }}")}`), keys: ["앞 키"] });
        paras.push({ xml: textPara(`가운데 ${LONG}`), keys: [] });
        paras.push({ xml: paragraph(`${t("{{ 안 셋 }}")}${clickEnd(f)}${t(" 밖 {{ 밖 키 }}")}`), keys: ["밖 키"] });
        break;
      }
      case 8: // XML 특수문자가 든 키와 긴 글 속 반복 키
        paras.push({ xml: textPara(`${LONG.repeat(4)}{{ 비고 &amp; 참고 }} ${LONG}{{ 담당 부서 }} {{ &lt;구분&gt; }}`), keys: ["비고 & 참고", "담당 부서", "<구분>"] });
        break;
      default: // 키 없는 문단
        paras.push({ xml: textPara(`${u}번 일반 문단. ${LONG}`), keys: [] });
    }
  }
  return { bytes: buildHwpx([paras.map((p) => p.xml).join("")]), paras };
}

/** 기대 keys: 문단들의 keys를 이어 NFC로 같은 것은 처음 것만 */
function expectedKeys(lists: readonly string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of lists.flat()) {
    if (seen.has(nfc(k))) continue;
    seen.add(nfc(k));
    out.push(k);
  }
  return out;
}

/** 이관 전 앱 규칙(엄격 `{{경로}}`만, 조각 글 전체): 이 시험이 그 빈틈을 실제로 지나는지 센다 */
const strictKeys = (texts: readonly string[]): string[] => [...new Set(texts.flatMap((s) => findPlaceholders(s).map((k) => k.path)))];

/** 한 범위: 떼기와 조각에서 만들기(조각 그대로, 저장 글에서 다시 읽은 조각)를 견준다 */
function compare(doc: HwpxDocument, range: BlockRange, id: string): { keys: string[]; strict: string[] } {
  const block = extractBlock(doc, range, meta(id));
  const made = protoFromFragment(block.fragment, { id, name: "이관 시험" });
  const stored = protoFromFragment(parseFragment(new TextDecoder().decode(block.blob)), { id, name: "이관 시험" });
  const { source: _source, history: _history, ...rest } = block.proto;
  assert.deepEqual(made.proto, rest, "출처·판 기록을 뺀 원형이 같다(내용 해시·keys 포함)");
  assert.ok(bytesEqual(made.blob, block.blob), "덩어리 바이트가 같다");
  assert.equal(writeBlockProto(stored.proto), writeBlockProto(made.proto), "저장 글에서 다시 읽은 조각도 같다");
  assert.ok(bytesEqual(stored.blob, block.blob));
  return { keys: made.proto.keys, strict: strictKeys(block.fragment.texts) };
}

test("8.8.17 protoFromFragment = extractBlock(keys·내용 해시·덩어리): 합성 문서(공백 든 키·누름틀·메일머지·하이퍼링크·표 칸·여러 문단 누름틀·NFD·긴 글) 무작위 60 + 합성 공고서 30", (ctx) => {
  const { bytes, paras } = synthetic();
  const doc = reparse(bytes);
  const top = at(doc.sections, 0).paragraphs;
  assert.equal(top.length, paras.length);
  const tables = paras.flatMap((p, i) => (p.cells === undefined ? [] : [i]));
  const next = rng(112);
  const pick = (n: number): number => Math.floor(next() * n);
  let runs = 0;
  let skipped = 0;
  let strictMissed = 0;
  let spacedKeys = 0;
  let cellRuns = 0;
  while (runs < 60) {
    let range: BlockRange | undefined;
    let want: string[];
    if (runs % 3 === 2) {
      const ti = at(tables, pick(tables.length));
      const c = pick(2);
      const cell = at(at(paras, ti).cells ?? [], c);
      const from = pick(cell.length);
      const to = from + pick(cell.length - from);
      range = makeRangeAnchor(doc, 0, [ti, c], from, to);
      want = expectedKeys(cell.slice(from, to + 1));
      cellRuns++;
    } else {
      const from = pick(paras.length);
      const to = Math.min(paras.length - 1, from + pick(12));
      if (splitsField(top.slice(from, to + 1)) !== undefined) {
        skipped++;
        continue;
      }
      range = makeRangeAnchor(doc, 0, [], from, to);
      want = expectedKeys(paras.slice(from, to + 1).map((p) => p.keys));
    }
    assert.ok(range !== undefined);
    const got = compare(doc, range, `k${(0xf000 + runs).toString(16).padStart(8, "0")}`);
    assert.deepEqual(got.keys, want, `${runs}: 기대 keys`);
    if (got.keys.some((k) => /\s/.test(k))) spacedKeys++;
    if (JSON.stringify(got.strict) !== JSON.stringify(got.keys)) strictMissed++;
    runs++;
  }

  // 합성 공고서(한글 저장본 merge-fields 바탕: 메일머지 표시 글 안의 {{ }}, 표 칸): 본문·칸·제목 범위
  const kit = reparse(notice());
  const list = listAtParent(at(kit.sections, 0), []);
  assert.ok(list !== undefined);
  let noticeRuns = 0;
  let noticeKeys = 0;
  while (noticeRuns < 30) {
    const kind = noticeRuns % 3;
    let range: BlockRange | undefined;
    if (kind === 0) range = makeHeadingRangeAnchor(kit, 0, [], at(HEADINGS, pick(HEADINGS.length)));
    else if (kind === 1) {
      const from = pick(6);
      range = makeRangeAnchor(kit, 0, [12, 1], from, from + pick(6 - from));
    } else {
      const from = 1 + pick(60);
      const to = Math.min(62, from + pick(8));
      if (splitsField(list.slice(from, to + 1)) !== undefined) {
        skipped++;
        continue;
      }
      range = makeRangeAnchor(kit, 0, [], from, to);
    }
    assert.ok(range !== undefined);
    noticeKeys += compare(kit, range, `k${(0xe000 + noticeRuns).toString(16).padStart(8, "0")}`).keys.length;
    noticeRuns++;
  }
  ctx.diagnostic(`합성 ${runs}회(칸 ${cellRuns}, 누름틀 자름 건너뜀 ${skipped}) 일치 ${runs}/${runs}, 공백 든 키가 있는 범위 ${spacedKeys}, 옛 엄격 규칙과 다른 범위 ${strictMissed}; 합성 공고서 ${noticeRuns}회 일치 ${noticeRuns}/${noticeRuns}(keys 합 ${noticeKeys})`);
  assert.ok(cellRuns >= 15 && spacedKeys >= 25, `칸 ${cellRuns}, 공백 키 범위 ${spacedKeys}`);
  assert.ok(strictMissed >= 25, `옛 규칙과 다른 범위 ${strictMissed}`);
  assert.ok(noticeKeys > 0);
});

test("#138 세 문단 넘게 걸친 누름틀·메일머지의 사이 문단(표 칸 포함) {{ }}는 키가 아니다: extractBlock·protoFromFragment keys, 2판 등록 판정, 블록 미리보기 자리", () => {
  const cell: TableSpec = { id: "7138", rowCnt: 1, colCnt: 1, cells: [{ row: 0, col: 0, width: 9000, height: 1000, paragraphs: [textPara("칸 {{ 칸 사이 }}")] }] };
  const bytes = buildHwpx([
    textPara("앞 문단") +
      paragraph(`${t("앞 {{ 앞 키 }} ")}${clickBegin(1, "긴 안내")}${t("{{ 안 첫 }}")}`) +
      textPara(`{{ 안 둘 }} 가운데 ${LONG}`) +
      paragraph(`${t("{{ 안 셋 }}")}${clickEnd(1)}${t(" 밖 {{ 밖 키 }}")}`) +
      paragraph(`${t("머지 앞 ")}${mergeBegin(2, "머지")}${t("{{ 머지 첫 }}")}`) +
      textPara("{{ 머지 사이 }} 하나") +
      tableParagraph(cell) +
      paragraph(`${t("{{ 머지 끝 }}")}${mergeEnd(2)}${t(" 뒤 {{ 끝 키 }}")}`),
  ]);
  const doc = reparse(bytes);
  const outside = ["앞 키", "밖 키", "끝 키"];
  // 떼기·조각에서 만들기
  const range = makeRangeAnchor(doc, 0, [], 1, 7);
  assert.ok(range !== undefined);
  assert.deepEqual(compare(doc, range, "k0000f138").keys, outside);
  const block = extractBlock(doc, range, meta("k0000f138"));
  // 블록 미리보기 자리
  const preview = buildBlockPreviewDocument(block.proto, block.blob);
  assert.deepEqual(
    preview.fields.map((f) => `${f.kind}:${f.name}`),
    ["placeholder:앞 키", "clickHere:긴 안내", "placeholder:밖 키", "mailMerge:머지", "placeholder:끝 키"],
  );
  // 2판 생성의 등록 판정: 표시 구간 밖 {{ }}와 두 필드만 등록해도 PLACE_UNREGISTERED 없이 만든다
  const names = [...outside, "긴 안내", "머지"];
  const raw = {
    schema: "hwpx-studio/template@2",
    id: "t0000f138",
    version: 1,
    source: { kind: "hwpx", sha256: sha256Hex(bytes) },
    anchors: [],
    values: names.map((name, i) => ({ id: `v${i}`, name, format: "text" })),
    bindings: names.map((key, i) => ({ value: `v${i}`, key })),
    places: names.map((key, i) => ({ id: `p${i}`, value: `v${i}`, ...(i < 3 ? { kind: "placeholder", key } : i === 3 ? { kind: "clickHere", name: key } : { kind: "mailMerge", key }) })),
    slots: [],
    blocks: [],
  };
  const tpl = readStudioTemplate(JSON.stringify(raw), { hasBlob: () => false });
  assert.ok(tpl.schema === "hwpx-studio/template@2");
  const r = generateFromTemplate(bytes, tpl, Object.fromEntries(names.map((k) => [k, `${k} 값`])), undefined, () => undefined);
  assert.deepEqual(r.report.issues.filter((i) => i.severity === "error").map((i) => i.code), []);
  assert.ok(r.ok);
});

test("8.8.17 protoFromFragment: 1판·출처·판 기록 없음·메모, 정규 JSON 왕복, 같은 입력 같은 결과, 그림 든 조각, 잘못된 meta는 TPL_ID·TPL_FIELD", () => {
  const doc = reparse(notice());
  const range = makeRangeAnchor(doc, 0, [], 22, 26);
  assert.ok(range !== undefined);
  const block = extractBlock(doc, range, meta());
  const made = protoFromFragment(block.fragment, { id: "k0000f112", name: "이관 시험", note: "옛 저장소" });
  assert.deepEqual(
    [made.proto.schema, made.proto.version, made.proto.note, "source" in made.proto, "history" in made.proto, "previous" in made.proto],
    ["hwpx-studio/block-proto@1", 1, "옛 저장소", false, false, false],
  );
  assert.deepEqual(made.proto.keys, ["기관명", "사업명"]);
  assert.deepEqual(readBlockProto(writeBlockProto(made.proto)), made.proto);
  const again = protoFromFragment(structuredClone(block.fragment), { id: "k0000f112", name: "이관 시험", note: "옛 저장소" });
  assert.equal(writeBlockProto(again.proto), writeBlockProto(made.proto));
  assert.ok(bytesEqual(again.blob, made.blob));

  // 그림(이진 자료)이 든 조각도 덩어리·해시가 떼기와 같다
  const pic = reparse(readFixture("extra/features-picture"));
  let pictures = 0;
  for (const section of pic.sections) {
    for (let i = 1; i < section.paragraphs.length; i++) {
      const r = makeRangeAnchor(pic, section.index, [], i, i);
      if (r === undefined || splitsField(section.paragraphs.slice(i, i + 1)) !== undefined) continue;
      let b;
      try {
        b = extractBlock(pic, r, meta());
      } catch {
        continue; // 구역 설정 문단 등 뗄 수 없는 문단
      }
      if (b.fragment.binaries.length === 0) continue;
      const p = protoFromFragment(b.fragment, { id: "k0000f112", name: "이관 시험" });
      assert.deepEqual([p.proto.content, p.proto.keys], [b.proto.content, b.proto.keys]);
      assert.ok(bytesEqual(p.blob, b.blob));
      pictures++;
    }
  }
  assert.ok(pictures > 0, "그림 든 조각을 지나야 한다");

  for (const [m, code] of [
    [{ id: "x1", name: "이름" }, "TPL_ID"],
    [{ id: "k0000f112", name: "" }, "TPL_FIELD"],
  ] as const) {
    assert.equal(failure(() => protoFromFragment(block.fragment, m)).code, code);
  }
});
