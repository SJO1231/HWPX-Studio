import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { extractFragment } from "../fragment/extract.ts";
import { planImport } from "../fragment/import.ts";
import { parseFragment, serializeFragment } from "../fragment/json.ts";
import { createFingerprinter, makeLookup, resourceRefs, type FingerprintLookup } from "../fragment/resources.ts";
import { paragraphsAt, resolveSelection, sectionAt } from "../fragment/select.ts";
import type { Fragment, FragmentSelection, ImportOptions, ImportPlan, InsertPoint } from "../fragment/types.ts";
import { parseResource } from "../fragment/units.ts";
import { refsOf } from "../model/header.ts";
import { fieldTypeOf, walkParagraphs } from "../model/paragraph.ts";
import type { HwpxDocument, ParagraphNode, ResourceItem, SectionModel } from "../model/types.ts";
import { sha256Hex } from "../template/hash.ts";
import { planProtoUpdate, unboundKeys } from "../template/studio-proto.ts";
import { readBlockProto } from "../template/studio-read.ts";
import { BLOCK_PROTO_SCHEMA, type BlockProto, type StudioAnchor, type StudioTemplate } from "../template/studio-types.ts";
import { contentSha256, writeBlockProto } from "../template/studio-write.ts";
import { decodeUtf8, encodeUtf8 } from "../xml/parse.ts";
import type { HeadingRangeAnchor, RangeAnchor } from "./anchor-types.ts";
import { checkAnchors, type AnchorAddress } from "./check-anchors.ts";
import { collectFields, type FieldTarget } from "./fields.ts";
import { parseFragmentXml } from "./fragment-fill.ts";
import { fieldSpans } from "./generate-studio.ts";
import { makeRangeAnchor } from "./range.ts";
import { findLooseKeys, nfc } from "./studio-common.ts";

// 블록 저장소 API(엔진 명세 8.8.17, 이슈 #73): 범위에서 블록을 떼어 원형(block-proto@1)과 조각 덩어리로 만들고, 다른 문서에 넣을 계획과
// 서식 차이 경고, 결과 문서에서 다시 떼어 새 판 만들기, 새 원형 판의 전파 검사를 한다. 순수 함수다(시계·파일 없음. 시각은 호출자가 준다).
// 넣는 쪽의 형식 버전·네임스페이스 문맥 맞추기(#69)와 원본 페이지 설정 이식(#70)은 여기서 다루지 않는다. 조각 가져오기(7.5)의 규칙을 그대로 쓴다.

/** 블록을 떼어 낼 범위: `range`·`headingRange` 앵커나 그 초안(7.10). `id`는 보지 않는다. */
export type BlockRange = Omit<RangeAnchor, "id"> | Omit<HeadingRangeAnchor, "id">;

/** 원형 정보: id(`k` + 16진 8자, 저장소가 준다), 이름, 시각(ISO 8601 UTC), 선택 메모, 판 기록의 바뀐 점(없으면 정해진 글) */
export type BlockMeta = { id: string; name: string; at: string; note?: string; change?: string };

/** 떼어 낸 블록: 원형(이 판), 조각, 조각 덩어리(`serializeFragment`의 UTF-8 바이트. 원형의 `content.fragment`가 그 sha256), 경고 */
export type ExtractedBlock = { proto: BlockProto; fragment: Fragment; blob: Uint8Array; issues: Issue[] };

/** 서식 차이 하나: 블록의 최상위 문단 번호(0부터), 속성(문단 모양 `paraPr`·스타일 `style`), 두 쪽의 자원 지문(7.4) */
export type BlockFormatDiff = { paragraph: number; property: "paraPr" | "style"; block: string; target: string };

/** 블록 넣기 계획: 조각 가져오기 계획(7.5)에 서식 차이 목록을 더한 것. `summary.formatDiffParagraphs`는 서식이 다른 블록 문단 수 */
export type BlockInsertPlan = ImportPlan & { formatDiffs: BlockFormatDiff[] };

/** 새 원형 판의 전파 계획과 검사 목록(8.8.17) */
export type BlockUpdatePlan = {
  /** 새 템플릿 판(`planProtoUpdate`). 원형의 키에 자리·연결이 없어(`PROTO_UNBOUND_KEY`) 전파할 수 없으면 없다 */
  template?: StudioTemplate;
  updated: { block: string; from: number; to: number }[];
  /** 자리 못 찾음(`ANCHOR_*`·`PROTO_UNBOUND_KEY`)과 이름 충돌(`BLOCK_NAME_CONFLICT`)은 오류, 입력 항목 사라짐(`BLOCK_KEYS_DROPPED`)·서식 차이(`BLOCK_FORMAT_DIFFERS`)는 경고 */
  issues: Issue[];
  formatDiffs: { block: string; anchor: string; diffs: BlockFormatDiff[] }[];
};

const FIRST_CHANGE = "첫 저장";

/** 원형을 정규 JSON으로 쓰고 다시 읽어 형식을 검사한다(틀리면 `TPL_*`) */
const checked = (proto: BlockProto): BlockProto => readBlockProto(writeBlockProto(proto));

/** 범위를 문서에서 찾는다. exact·relocated만 받고 그 밖은 그 앵커 코드(`ANCHOR_CHANGED`·`ANCHOR_AMBIGUOUS`·`ANCHOR_NOT_FOUND`)로 던진다 */
function locate(doc: HwpxDocument, range: BlockRange): { selection: FragmentSelection; issues: Issue[] } {
  const anchor = { ...range, id: "block" } as StudioAnchor;
  const check = checkAnchors(doc, { anchors: [anchor] })[0];
  const found = check?.found;
  if (check === undefined || (check.state !== "exact" && check.state !== "relocated") || found === undefined || (found.kind !== "range" && found.kind !== "headingRange")) {
    const error = check?.issues.find((i) => i.severity === "error");
    throw new HwpxError(error?.code ?? "ANCHOR_NOT_FOUND", `블록으로 뗄 범위를 문서에서 찾지 못했습니다${error === undefined ? "" : `: ${error.message}`}`);
  }
  return { selection: { sectionIndex: found.at.sectionIndex, parentPath: [...found.at.parentPath], from: found.from, to: found.to }, issues: check.issues };
}

/**
 * 원형의 `keys`(8.8.17): 문단들(하위 목록 포함)의 느슨한 `{{ 키 }}`(8.8.5). 누름틀·메일머지 표시 구간 안의 것은 그 필드 자리가 맡으므로 뺀다. NFC로 같은 키는 처음 것만.
 * `fields`는 그 문단들이 든 문서(또는 조각)의 필드다. `extractBlock`과 `protoFromFragment`가 함께 쓴다.
 */
function placeholderKeys(fields: readonly FieldTarget[], paragraphs: ParagraphNode[]): string[] {
  const spans = fieldSpans(fields);
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const p of walkParagraphs(paragraphs)) {
    const own = spans.get(p) ?? [];
    for (const h of findLooseKeys(p.logicalText)) {
      if (own.some((s) => h.start < s.until && h.end > s.from) || seen.has(nfc(h.key))) continue;
      seen.add(nfc(h.key));
      keys.push(h.key);
    }
  }
  return keys;
}

/**
 * 원형 1판의 뼈대(8.8.7·8.8.17): 덩어리는 `serializeFragment`의 UTF-8 바이트이고 내용 해시는 그 sha256이다. 출처·판 기록은 부르는 쪽이 더한다.
 * `extractBlock`과 `protoFromFragment`가 함께 쓴다.
 */
function firstVersion(fragment: Fragment, keys: string[], meta: Pick<BlockMeta, "id" | "name" | "note">): { proto: BlockProto; blob: Uint8Array } {
  const blob = encodeUtf8(serializeFragment(fragment));
  const proto: BlockProto = {
    schema: BLOCK_PROTO_SCHEMA,
    id: meta.id,
    version: 1,
    name: meta.name,
    content: { fragment: sha256Hex(blob) },
    keys,
    ...(meta.note === undefined ? {} : { note: meta.note }),
  };
  return { proto, blob };
}

/**
 * 범위에서 블록을 떼어 원형 1판과 조각 덩어리를 만든다(8.8.17). 조각은 `extractFragment` 결과 그대로이고(블록 자신의 서식 자원·이진 자료 포함, 7.3),
 * 거절도 조각 계약과 같다(구역 설정 `FRAG_SECTION_PROPS`, 누름틀 자름 `FRAG_SPLITS_FIELD`, 표 칸 경계는 같은 부모의 연속 문단만).
 * 범위가 exact·relocated가 아니면 그 앵커 코드로 던진다. 원형의 `keys`는 범위 안 `{{ 키 }}`(필드 표시 구간 밖), `source`는 원본 해시·찾은 구간·지문·`meta.at`,
 * `history`는 `[{ version: 1, at, change }]`다. `meta`가 형식에 맞지 않으면(`TPL_ID`·`TPL_FIELD`) 던진다.
 */
export function extractBlock(doc: HwpxDocument, range: BlockRange, meta: BlockMeta): ExtractedBlock {
  const { selection, issues } = locate(doc, range);
  const fragment = extractFragment(doc, selection);
  const print = makeRangeAnchor(doc, selection)?.print;
  if (print === undefined) throw new HwpxError("FRAG_SELECTION", "블록 범위의 지문을 만들지 못했습니다.");
  const first = firstVersion(fragment, placeholderKeys(collectFields(doc), resolveSelection(doc, selection).paragraphs), meta);
  const proto: BlockProto = {
    ...first.proto,
    source: { sha256: fragment.source.sha256, selection, print, extractedAt: meta.at },
    history: [{ version: 1, at: meta.at, change: meta.change ?? FIRST_CHANGE }],
  };
  return { proto: checked(proto), fragment, blob: first.blob, issues: [...issues, ...fragment.issues] };
}

/**
 * 조각(예: 옛 저장소에서 옮겨 오는 블록)에서 원형 1판과 조각 덩어리를 만든다(8.8.17). 덩어리·내용 해시와 `keys`는 `extractBlock`과 같은 규칙이다:
 * `keys`는 조각 문단(하위 목록 포함)의 `{{ 키 }}` 가운데 조각 안 누름틀·메일머지 표시 구간 밖의 것이다. 떼어 낸 문서·구간·시각을 모르므로 `source`·`history`는 없다.
 * `meta`가 형식에 맞지 않으면(`TPL_ID`·`TPL_FIELD`) 던진다.
 */
export function protoFromFragment(fragment: Fragment, meta: Pick<BlockMeta, "id" | "name" | "note">): { proto: BlockProto; blob: Uint8Array } {
  const { text, root, paragraphs } = parseFragmentXml(fragment);
  // 필드 짝짓기(`collectFields`)는 구역을 훑는다. 조각 문단을 구역 하나로 본다(참조 목록은 쓰지 않아 비운다)
  const section: SectionModel = { entryName: "fragment", index: 0, text, root, paragraphs, bodyRefs: [] };
  const { proto, blob } = firstVersion(fragment, placeholderKeys(collectFields({ sections: [section] }), paragraphs), meta);
  return { proto: checked(proto), blob };
}

const differing = (a: readonly string[], b: readonly string[]): number => {
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
};

/** 두 조각의 바뀐 점(수량만. 문서 글은 넣지 않는다). `keys`는 두 판의 `{{ 키 }}` 입력 항목 수 */
function describeChange(before: Fragment, after: Fragment, keys: [number, number]): string {
  const parts: string[] = [];
  const count = (label: string, x: number, y: number): void => {
    if (x !== y) parts.push(`${label} ${x}→${y}개`);
  };
  count("문단", before.census.paragraphs, after.census.paragraphs);
  count("표", before.census.tables, after.census.tables);
  count("그림", before.census.pictures, after.census.pictures);
  count("누름틀", before.census.fields, after.census.fields);
  count("입력 항목", keys[0], keys[1]);
  const texts = differing(before.texts, after.texts);
  if (texts > 0) parts.push(`글이 다른 문단 ${texts}개`);
  const prints = differing(before.prints, after.prints);
  if (prints > 0) parts.push(`서식 참조 ${prints}곳 다름`);
  return parts.length === 0 ? "내용 변화 없음" : parts.join(", ");
}

/** 직전 판의 `{{ 키 }}` 가운데 새 판에 없는 것(NFC로 견준다. 직전 판 순서) */
function droppedKeys(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set(after.map(nfc));
  return before.filter((k) => !kept.has(nfc(k)));
}

/** 입력 항목이 사라진 새 판의 경고(키 이름만. 값 원문 없음). 막지 않는다 */
function keysDroppedIssue(proto: BlockProto, from: number, dropped: readonly string[], where: string): Issue {
  return makeIssue(
    "warning",
    "BLOCK_KEYS_DROPPED",
    `블록 ${proto.id}의 ${proto.version}판에서 ${from}판의 입력 항목 ${dropped.length}개(${dropped.map((k) => `'${k}'`).join("·")})가 사라졌습니다. 채운 결과 문서에서 다시 뗐다면 이번 건의 값이 공용 블록 글에 들어갔을 수 있으니 확인하세요. 자동으로 막지 않습니다.`,
    where,
  );
}

/**
 * 결과 문서(넣고 고친 문서)의 범위를 다시 떼어 같은 블록의 새 판을 만든다(8.8.17): id 그대로, `version` + 1, `previous`는 직전 판의 번호와 내용 해시,
 * `history`는 직전 판의 기록에 새 줄을 더한 것(직전 판에 기록이 없으면 새 줄만), `source`는 결과 문서의 해시·구간·지문·시각, `keys`는 다시 계산한다.
 * 바뀐 점은 `meta.change`, 없으면 `meta.previous`(직전 판의 조각)와 견준 수량 요약(입력 항목 수 포함), 그것도 없으면 "다시 저장"이다. 이름은 `meta.name`이 없으면 그대로이고, 직전 판의 `note`는 넘기지 않는다(새 판의 메모는 `meta.note`).
 * 직전 판의 `keys` 가운데 새 판에 없는 것이 있으면(채운 결과에서 다시 뗀 경우 등) 경고 `BLOCK_KEYS_DROPPED`(사라진 키 목록)를 `issues`에 더한다. 막지는 않는다.
 */
export function reextractBlock(
  resultDoc: HwpxDocument,
  range: BlockRange,
  proto: BlockProto,
  meta: { at: string; change?: string; previous?: Fragment; name?: string; note?: string },
): ExtractedBlock {
  const next = extractBlock(resultDoc, range, { id: proto.id, name: meta.name ?? proto.name, at: meta.at, ...(meta.note === undefined ? {} : { note: meta.note }) });
  const version = proto.version + 1;
  const change = meta.change ?? (meta.previous === undefined ? "다시 저장" : describeChange(meta.previous, next.fragment, [proto.keys.length, next.proto.keys.length]));
  const out: BlockProto = {
    ...next.proto,
    version,
    previous: { version: proto.version, content: contentSha256(proto.content) },
    history: [...(proto.history ?? []), { version, at: meta.at, change }],
  };
  const dropped = droppedKeys(proto.keys, next.proto.keys);
  const issues = dropped.length === 0 ? next.issues : [...next.issues, keysDroppedIssue(out, proto.version, dropped, `block:${proto.id}`)];
  return { ...next, proto: checked(out), issues };
}

/** 원형의 조각 덩어리를 확인해 읽는다: 글 블록이거나 덩어리의 해시가 `content.fragment`와 다르면 `TPL_FRAGMENT_MISSING`, 조각 JSON이 아니면 `FRAG_SCHEMA` */
export function blockFragment(proto: BlockProto, blob: Uint8Array): Fragment {
  const where = `block:${proto.id}`;
  if (!("fragment" in proto.content)) throw new HwpxError("TPL_FRAGMENT_MISSING", `원형 ${proto.id}의 ${proto.version}판은 글 블록이라 조각 덩어리가 없습니다.`, where);
  const sha = sha256Hex(blob);
  if (sha !== proto.content.fragment) {
    throw new HwpxError("TPL_FRAGMENT_MISSING", `원형 ${proto.id}의 ${proto.version}판 조각 덩어리의 해시(${sha.slice(0, 10)})가 원형 내용(${proto.content.fragment.slice(0, 10)})과 다릅니다.`, where);
  }
  return parseFragment(decodeUtf8(blob, `blob:${sha.slice(0, 10)}`));
}

const CARRIED = "\u0001"; // 조각이 가진 자원·이진 자료를 가리키는 참조 값의 표시(문서의 id와 겹치지 않는다)
const resKey = (kind: string, lang: string | undefined, id: string): string => JSON.stringify([kind, lang ?? "", id]);

/**
 * 블록 자원을 넣은 뒤의 모양으로 찾는 표(8.8.17): 조각이 가진 자원·이진 자료를 가리키는 참조는 조각 안에서 찾고, 원본에도 없던 것을 가리키는 참조
 * (`FRAG_DANGLING_SOURCE`, 자원 안의 참조 포함. 예: 문단 모양 → 탭)는 가져오기가 id를 그대로 옮기므로(7.5) 대상에서 찾는다. 대상 자원의 참조는 대상 안에서 찾는다.
 * 조각 쪽 참조 값에 표시를 붙여 두 쪽을 가른다. 지문은 참조 값 대신 대상의 지문을 쓰므로 표시는 지문에 남지 않는다.
 */
function insertedLookup(fragment: Fragment, target: FingerprintLookup): FingerprintLookup {
  const carried = new Set(fragment.resources.map((r) => resKey(r.kind, r.lang, r.id)));
  const binaries = new Map(fragment.binaries.map((b) => [b.itemId, b.sha256]));
  const items = new Map<string, ResourceItem>();
  for (const res of fragment.resources) {
    const { element } = parseResource(res.xml, { ...res.valueNamespaces, ...res.namespaces });
    const item: ResourceItem = { kind: res.kind, id: res.id, element, refs: refsOf(res.kind, element) };
    if (res.lang !== undefined) item.lang = res.lang;
    for (const ref of resourceRefs(item)) {
      if (ref.kind === "binaryItem" ? binaries.has(ref.id) : carried.has(resKey(ref.kind, ref.lang, ref.id))) ref.attr.value = CARRIED + ref.attr.value;
    }
    item.refs = refsOf(res.kind, element);
    items.set(resKey(res.kind, res.lang, res.id), item);
  }
  return {
    resource: (kind, lang, id) => (id.startsWith(CARRIED) ? items.get(resKey(kind, lang, id.slice(1))) : target.resource(kind, lang, id)),
    binary: (id) => (id.startsWith(CARRIED) ? binaries.get(id.slice(1)) : target.binary(id)),
  };
}

/**
 * 블록의 최상위 문단마다 문단 모양·스타일의 자원 지문(7.4)을 넣는 자리 문단(`at`의 구역·상위 목록·문단 번호)의 것과 견준다(8.8.17).
 * 다른 것만 돌려준다(블록 문단 순서, 한 문단 안에서 `paraPr` 다음 `style`). 지문은 모양으로 견주므로 문서마다 id가 달라도 같은 모양이면 같다.
 * 참조가 없으면 `none`, 자원이 없으면 `missing:<id>`로 본다. 블록 쪽은 넣은 뒤의 모양으로 본다: 원본에도 없던 자원을 가리키는 참조(`FRAG_DANGLING_SOURCE`,
 * 문단 안이든 자원 안이든)는 가져오기가 그대로 옮기므로 그 id를 대상에서 풀어 지문을 만든다. 자리 문단이 없으면 `FRAG_INSERT_POINT`. 글자 모양은 보지 않는다.
 */
export function blockFormatDiffs(target: HwpxDocument, fragment: Fragment, at: { sectionIndex: number; parentPath: number[]; index: number }): BlockFormatDiff[] {
  const list = paragraphsAt(sectionAt(target, at.sectionIndex, "FRAG_INSERT_POINT"), at.parentPath, "FRAG_INSERT_POINT");
  const spot = list[at.index];
  if (spot === undefined) throw new HwpxError("FRAG_INSERT_POINT", `넣는 자리 문단 ${at.index}이(가) 없습니다(목록의 문단 ${list.length}개).`);
  const lookup = makeLookup(target);
  const fingerprint = createFingerprinter(lookup);
  const targetPrint = (kind: string, id: string | null): string => {
    if (id === null) return "none";
    const item = lookup.resource(kind, undefined, id);
    return item === undefined ? `missing:${id}` : fingerprint(item);
  };
  const want = { paraPr: targetPrint("paraPr", spot.attrs.paraPrIDRef), style: targetPrint("style", spot.attrs.styleIDRef) };
  const inserted = insertedLookup(fragment, lookup);
  const insertedFingerprint = createFingerprinter(inserted);
  const blockPrint = (kind: string, id: string | null): string => {
    if (id === null) return "none";
    const item = inserted.resource(kind, undefined, CARRIED + id) ?? inserted.resource(kind, undefined, id);
    return item === undefined ? `missing:${id}` : insertedFingerprint(item);
  };
  const diffs: BlockFormatDiff[] = [];
  parseFragmentXml(fragment).paragraphs.forEach((p, paragraph) => {
    for (const property of ["paraPr", "style"] as const) {
      const block = blockPrint(property, property === "paraPr" ? p.attrs.paraPrIDRef : p.attrs.styleIDRef);
      if (block !== want[property]) diffs.push({ paragraph, property, block, target: want[property] });
    }
  });
  return diffs;
}

/** 서식 차이 경고 하나(문서 글 없음). 자동으로 바꾸지 않는다 */
function formatIssue(proto: BlockProto, total: number, diffs: readonly BlockFormatDiff[], where: string): Issue {
  const paragraphs = new Set(diffs.map((d) => d.paragraph)).size;
  const paraPr = diffs.filter((d) => d.property === "paraPr").length;
  const style = diffs.filter((d) => d.property === "style").length;
  return makeIssue(
    "warning",
    "BLOCK_FORMAT_DIFFERS",
    `서식이 다릅니다, 확인하세요: 블록 ${proto.id}의 문단 ${total}개 가운데 ${paragraphs}개가 넣는 자리 문단과 서식이 다릅니다(문단 모양 ${paraPr}개, 스타일 ${style}개). 자동으로 바꾸지 않습니다.`,
    where,
  );
}

/**
 * 원형의 블록을 대상 문서에 넣는 계획(8.8.17). 조각 가져오기(`planImport`, 7.5)를 그대로 쓰고(블록 서식 유지, 자동 변경 없음),
 * 넣는 자리 문단(`at`)과 블록 문단의 서식이 다르면 `BLOCK_FORMAT_DIFFERS` 경고 하나와 `formatDiffs`(문단·속성별)를 더한다.
 * `summary.formatDiffParagraphs`는 서식이 다른 블록 문단 수다. 덩어리 확인은 `blockFragment`와 같다.
 */
export function planBlockInsert(target: HwpxDocument, proto: BlockProto, blob: Uint8Array, at: InsertPoint, options: ImportOptions = {}): BlockInsertPlan {
  const fragment = blockFragment(proto, blob);
  const plan = planImport(target, fragment, at, options);
  const formatDiffs = blockFormatDiffs(target, fragment, at);
  const paragraphs = new Set(formatDiffs.map((d) => d.paragraph)).size;
  const total = parseFragmentXml(fragment).paragraphs.length;
  return {
    ...plan,
    summary: { ...plan.summary, formatDiffParagraphs: paragraphs },
    issues: paragraphs === 0 ? plan.issues : [...plan.issues, formatIssue(proto, total, formatDiffs, `block:${proto.id}`)],
    formatDiffs,
  };
}

/** 블록 안 입력 항목 이름(NFC): `{{ 키 }}`(원형 `keys`), 누름틀 이름, 메일머지 키 */
function blockNames(proto: BlockProto, fragment: Fragment): string[] {
  const names = new Set(proto.keys.map(nfc));
  for (const p of walkParagraphs(parseFragmentXml(fragment).paragraphs)) {
    for (const m of p.fieldMarks) {
      if (m.kind !== "begin") continue;
      const type = fieldTypeOf(m.type);
      if (type === "CLICK_HERE" && m.name !== undefined && m.name !== "") names.add(nfc(m.name));
      if (type === "MAILMERGE" && m.mergeKey !== undefined) names.add(nfc(m.mergeKey));
    }
  }
  return [...names];
}

/** 슬롯 앵커가 찾은 주소의 첫 문단(넣는 자리 문단) */
function spotOf(found: AnchorAddress): { sectionIndex: number; parentPath: number[]; index: number } | undefined {
  if (found.kind === "range" || found.kind === "headingRange") return { sectionIndex: found.at.sectionIndex, parentPath: [...found.at.parentPath], index: found.from };
  if (found.kind === "line") return { sectionIndex: found.at.sectionIndex, parentPath: found.at.path.slice(0, -1), index: found.at.path[found.at.path.length - 1] ?? -1 };
  return undefined;
}

/**
 * 원형의 새 판(`proto`, 덩어리 `blob`)을 템플릿 `t`에 전파하는 계획과 검사 목록(8.8.17). 전파 자체는 `planProtoUpdate`(8.8.7)이고 자동 교체는 없다.
 * 대상은 그 원형을 더 낮은 판으로 고정한 블록이다. 대상 블록마다 한 목록으로 검사한다:
 * - 자리 못 찾음: 원형의 키에 자리·연결이 없음(`PROTO_UNBOUND_KEY`, 이때 새 템플릿 판은 없다), 슬롯 앵커를 바탕 문서 `doc`에서 찾지 못함(`ANCHOR_CHANGED`·`ANCHOR_AMBIGUOUS`·`ANCHOR_NOT_FOUND`).
 * - 이름 충돌: 블록 안 입력 항목 이름(`{{ 키 }}`·누름틀 이름·메일머지 키)이 같은데 그 블록에 적용되는 `placeholder`·`clickHere`·`mailMerge` 자리들이 서로 다른 값에 연결됨(`BLOCK_NAME_CONFLICT`).
 * - 서식 차이: 슬롯 앵커의 첫 문단과 블록 문단의 서식이 다름(`BLOCK_FORMAT_DIFFERS` 경고, `formatDiffs`).
 * - 입력 항목 사라짐: 직전 판 원형 `previous`를 주었고 그 `keys` 가운데 새 판에 없는 것이 있음(`BLOCK_KEYS_DROPPED` 경고, `reextractBlock`과 같은 판정).
 * 원형 키의 자리 못 찾음은 없는 키 전부를 담는다. 입력 템플릿은 바꾸지 않는다. 결과를 저장할지 새로 만들지는 호출자(사용자) 몫이다.
 */
export function planBlockUpdate(t: StudioTemplate, proto: BlockProto, blob: Uint8Array, doc: HwpxDocument, previous?: BlockProto): BlockUpdatePlan {
  const fragment = blockFragment(proto, blob);
  const unbound = unboundKeys(t, proto);
  const issues: Issue[] = unbound.map((e) => makeIssue("error", e.code, e.message, e.where));
  const { template, updated } = unbound.length === 0 ? planProtoUpdate(t, proto) : { template: undefined, updated: [] };
  const dropped = previous === undefined ? [] : droppedKeys(previous.keys, proto.keys);
  const targets = t.blocks.filter((b) => b.proto?.id === proto.id && b.proto.version < proto.version);
  const anchors = new Map(t.anchors.map((a) => [a.id, a]));
  const names = blockNames(proto, fragment);
  const total = parseFragmentXml(fragment).paragraphs.length;
  const formatDiffs: BlockUpdatePlan["formatDiffs"] = [];
  for (const b of targets) {
    if (previous !== undefined && dropped.length > 0) issues.push(keysDroppedIssue(proto, previous.version, dropped, `blocks.${b.id}`));
    for (const name of names) {
      const places = t.places.filter((p) => {
        const own = p.kind === "clickHere" ? p.name : p.kind === "placeholder" || p.kind === "mailMerge" ? p.key : undefined;
        return own !== undefined && nfc(own) === name && ("where" in p ? p.where === undefined || p.where === b.id : true);
      });
      const values = [...new Set(places.map((p) => p.value))];
      if (values.length > 1) {
        issues.push(
          makeIssue(
            "error",
            "BLOCK_NAME_CONFLICT",
            `블록 ${b.id}의 입력 항목 '${name}'에 적용되는 자리(${places.map((p) => p.id).join("·")})가 서로 다른 값(${values.join("·")})에 연결되어 있습니다. 같은 이름은 같은 값이어야 합니다.`,
            `blocks.${b.id}`,
          ),
        );
      }
    }
    const slot = t.slots.find((s) => s.id === b.slot);
    for (const id of slot?.anchors ?? []) {
      const anchor = anchors.get(id);
      if (anchor === undefined || slot === undefined) continue;
      const check = checkAnchors(doc, { anchors: [anchor] })[0];
      const spot = check?.found === undefined ? undefined : spotOf(check.found);
      if (check === undefined || spot === undefined || (check.state !== "exact" && check.state !== "relocated")) {
        for (const i of check?.issues.filter((x) => x.severity === "error") ?? []) issues.push(makeIssue("error", i.code, `슬롯 ${slot.id}(블록 ${b.id}): ${i.message}`, `slots.${slot.id}`));
        continue;
      }
      const diffs = blockFormatDiffs(doc, fragment, spot);
      if (diffs.length === 0) continue;
      formatDiffs.push({ block: b.id, anchor: id, diffs });
      issues.push(formatIssue(proto, total, diffs, `slots.${slot.id}`));
    }
  }
  return { ...(template === undefined ? {} : { template }), updated, issues, formatDiffs };
}
