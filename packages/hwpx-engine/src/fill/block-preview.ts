import { applyPlan } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { planImport } from "../fragment/import.ts";
import type { ImportOptions, InsertPoint } from "../fragment/types.ts";
import { parseDocument } from "../model/document.ts";
import type { FieldInfo, HwpxDocument, ParagraphNode } from "../model/types.ts";
import { openPackage } from "../package/open.ts";
import { createHwpxArchive } from "../package/zip-write.ts";
import type { BlockProto } from "../template/studio-types.ts";
import { compareToBaseline, validateDocument, type ValidationReport } from "../validate/index.ts";
import { encodeUtf8 } from "../xml/parse.ts";
import type { BlockPreviewField, BlockPreviewPlace } from "./block-preview-types.ts";
import { blockFragment } from "./block-store.ts";
import { collectFields, fieldRangeIn } from "./fields.ts";
import { fieldSpans } from "./generate-studio.ts";
import { explainInherited } from "./inherited.ts";
import { fieldInput, findLooseKeys, nfc } from "./studio-common.ts";

export type { BlockPreviewField, BlockPreviewPlace, PreviewFieldKind } from "./block-preview-types.ts";

// 블록 단독 미리보기(엔진 명세 8.8.18, 이슈 #75): 저장한 블록(원형 + 조각 덩어리)만으로 빈 바탕 문서에 조각을 넣은 완전한 HWPX 바이트를 메모리에서 만들고,
// 블록 안 입력 항목 자리(`{{ 키 }}`·누름틀·메일머지)의 주소와 같은 이름 항목 수를 함께 낸다. 파일·시계 없음. 같은 입력은 같은 바이트다.

/** 빈 바탕 문서의 형식 버전. 실제 공고서(한글 2024 저장본)가 모두 1.5라 같은 형식으로 둔다(7.66: 1.5 원본의 블록은 단위 변환 없이 들어간다) */
export const PREVIEW_XML_VERSION = "1.5";

/** 블록 미리보기: 미리보기 HWPX 바이트, 같은 이름 항목 수, 자리 주소(문서 순서), 경고(조각 가져오기 경고와 상속 오류 `GATE_INHERITED`) */
export type BlockPreview = { bytes: Uint8Array; fields: BlockPreviewField[]; places: BlockPreviewPlace[]; issues: Issue[] };

// ── 빈 바탕 문서 ───────────────────────────────────────────────

/** 한글 저장본이 header·구역 루트에 선언하는 접두사(조각이 쓰는 접두사가 대상에 이미 같은 역할로 있게) */
const NAMESPACES =
  ' xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph"' +
  ' xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"' +
  ' xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"' +
  ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart"' +
  ' xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
const LANGS = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
const perLang = (value: string): string => LANGS.map((l) => ` ${l.toLowerCase()}="${value}"`).join("");
const border = (side: string): string => `<hh:${side} type="NONE" width="0.1 mm" color="#000000"/>`;

/** 바탕 자원: 글꼴(언어마다 하나), 테두리 1, 글자 모양 0(10pt), 탭 0, 문단 모양 0(여백 0, 줄 간격 160%), 스타일 0(바탕글) */
const HEADER =
  `${XML_DECL}<hh:head${NAMESPACES} version="${PREVIEW_XML_VERSION}" secCnt="1">` +
  `<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>` +
  `<hh:fontfaces itemCnt="${LANGS.length}">${LANGS.map((l) => `<hh:fontface lang="${l}" fontCnt="1"><hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0"/></hh:fontface>`).join("")}</hh:fontfaces>` +
  `<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
  `<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>` +
  `${border("leftBorder")}${border("rightBorder")}${border("topBorder")}${border("bottomBorder")}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill></hh:borderFills>` +
  `<hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1">` +
  `<hh:fontRef${perLang("0")}/><hh:ratio${perLang("100")}/><hh:spacing${perLang("0")}/><hh:relSz${perLang("100")}/><hh:offset${perLang("0")}/></hh:charPr></hh:charProperties>` +
  `<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>` +
  `<hh:paraProperties itemCnt="1"><hh:paraPr id="0" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">` +
  `<hh:align horizontal="JUSTIFY" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>` +
  `<hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin>` +
  `<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr></hh:paraProperties>` +
  `<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>` +
  `</hh:refList></hh:head>`;

/** 각주·미주 모양(한글 새 문서의 값. 둘은 구분선 길이·간격·놓는 곳만 다르다) */
const notePr = (tag: string, lineLength: string, between: string, place: string): string =>
  `<hp:${tag}><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="${lineLength}" type="SOLID" width="0.12 mm" color="#000000"/>` +
  `<hp:noteSpacing betweenNotes="${between}" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="${place}" beneathText="0"/></hp:${tag}>`;
const pageBorderFill = (type: string): string =>
  `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;

/**
 * 구역: 구역 설정(A4 세로, 한글 새 문서의 기본 여백)과 단 설정을 담은 빈 문단 하나. 블록은 이 문단 뒤에 들어간다.
 * 구역 설정의 자식은 한글 2024가 새 문서를 저장한 모양 그대로다(감추기·줄 번호·각주·미주·쪽 테두리. `hp:visibility`가 없으면 한글이 열지 못한다).
 * 개요 번호(`outlineShapeIDRef`)만 바탕에 번호 모양이 없어 0(없음)이다.
 */
const SECTION =
  `${XML_DECL}<hs:sec${NAMESPACES}><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">` +
  `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
  `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
  `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
  `<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>` +
  `<hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr>` +
  `${notePr("footNotePr", "-1", "283", "EACH_COLUMN")}${notePr("endNotePr", "14692344", "0", "END_OF_DOCUMENT")}` +
  `${pageBorderFill("BOTH")}${pageBorderFill("EVEN")}${pageBorderFill("ODD")}</hp:secPr>` +
  `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"/></hp:p></hs:sec>`;

const CONTENT_HPF =
  `${XML_DECL}<opf:package${NAMESPACES} version="" unique-identifier="" id=""><opf:metadata><opf:title/><opf:language>ko</opf:language></opf:metadata>` +
  `<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest>` +
  `<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;

const CONTAINER =
  `${XML_DECL}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles>` +
  `<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`;

const VERSION =
  `${XML_DECL}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="${PREVIEW_XML_VERSION}" application="HWPX Studio" appVersion="0"/>`;

const MANIFEST = `${XML_DECL}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`;

let blank: { bytes: Uint8Array; report: ValidationReport } | undefined;

/** 빈 바탕 문서의 바이트와 그 검사 결과(게이트의 기준선). 처음 부를 때 한 번 만든다 */
function blankDocument(): { bytes: Uint8Array; report: ValidationReport } {
  if (blank !== undefined) return blank;
  const entry = (name: string, text: string) => ({ name, data: encodeUtf8(text), method: 8 as const });
  const bytes = createHwpxArchive([
    entry("version.xml", VERSION),
    entry("Contents/header.xml", HEADER),
    entry("Contents/section0.xml", SECTION),
    entry("Contents/content.hpf", CONTENT_HPF),
    entry("META-INF/container.xml", CONTAINER),
    entry("META-INF/manifest.xml", MANIFEST),
  ]);
  blank = { bytes, report: validateDocument(bytes) };
  return blank;
}

// ── 입력 항목 자리 ─────────────────────────────────────────────

/** 문서의 입력 항목 자리 전부(문서 순서): 누름틀(이름 있음)·메일머지(키 있음)와 그 표시 구간 밖의 느슨한 `{{ 키 }}`(8.8.5·8.8.17과 같은 범위). `skip`이 참인 필드·키는 뺀다(#134 미등록 목록) */
export function inputPlaces(doc: HwpxDocument, skip?: { field: (info: FieldInfo) => boolean; key: (key: string) => boolean }): BlockPreviewPlace[] {
  const fields = collectFields(doc);
  const places: BlockPreviewPlace[] = [];
  for (const f of fields) {
    const input = fieldInput(f.info);
    if (input === undefined || skip?.field(f.info) === true) continue;
    const { kind, name } = input;
    const first = fieldRangeIn(f, f.paragraph);
    const start = first?.from ?? f.paragraph.pieces[f.begin.pieceIndex]?.logicalEnd ?? 0;
    const place: BlockPreviewPlace = { kind, name, sectionIndex: f.info.sectionIndex, path: [...f.info.path], start, end: start };
    if (f.endParagraph !== null && f.endParagraph !== f.paragraph) {
      place.endPath = [...f.endParagraph.path];
      place.end = fieldRangeIn(f, f.endParagraph)?.until ?? 0;
    } else if (first !== undefined) place.end = first.until;
    places.push(place);
  }
  const spans = fieldSpans(fields);
  const walk = (sectionIndex: number, list: readonly ParagraphNode[]): void => {
    for (const p of list) {
      const own = spans.get(p) ?? [];
      for (const h of findLooseKeys(p.logicalText)) {
        if (!own.some((s) => h.start < s.until && h.end > s.from) && skip?.key(h.key) !== true) places.push({ kind: "placeholder", name: nfc(h.key), sectionIndex, path: [...p.path], start: h.start, end: h.end });
      }
      for (const sub of p.subLists) walk(sectionIndex, sub.paragraphs);
    }
  };
  for (const s of doc.sections) walk(s.index, s.paragraphs);
  const order = (a: BlockPreviewPlace, b: BlockPreviewPlace): number => {
    if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex;
    for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) if (a.path[i] !== b.path[i]) return (a.path[i] ?? 0) - (b.path[i] ?? 0);
    return a.path.length !== b.path.length ? a.path.length - b.path.length : a.start - b.start;
  };
  return places.sort(order);
}

/** 자리를 종류·이름(NFC)별로 센다(처음 나온 순서) */
function countFields(places: readonly BlockPreviewPlace[]): BlockPreviewField[] {
  const out = new Map<string, BlockPreviewField>();
  for (const p of places) {
    const key = `${p.kind}\u0000${p.name}`;
    const found = out.get(key);
    if (found === undefined) out.set(key, { name: p.name, kind: p.kind, count: 1 });
    else found.count++;
  }
  return [...out.values()];
}

// ── 미리보기 ───────────────────────────────────────────────────

/**
 * 블록 단독 미리보기(8.8.18): 원형의 조각 덩어리(`blockFragment`로 확인: 글 블록·해시 불일치 `TPL_FRAGMENT_MISSING`, 조각 JSON이 아니면 `FRAG_SCHEMA`)를
 * 엔진이 가진 빈 바탕 문서(형식 1.5, A4)의 첫 문단(구역 설정) 뒤에 `planImport`(7.5, 단위 변환 7.66 포함)로 넣어 완전한 HWPX 바이트를 만든다.
 * 저장 게이트(기준선 방식, 8.3): 바탕 문서 대비 검사기 새 오류 가운데 조각이 소스에서 갖고 있던 문제(`inherited`)로 설명되지 않는 것이 하나라도 있으면
 * `GATE_NEW_ERRORS`로 던진다. 설명되는 것은 경고 `GATE_INHERITED`로 `issues`에 담는다. `options`는 `planImport`의 옵션 그대로다.
 * 블록 최상위 문단은 미리보기 문서 구역 0의 최상위 1번부터다. 자리 주소와 같은 이름 항목 수는 결과 문서를 다시 읽어 센다.
 */
export function buildBlockPreviewDocument(proto: BlockProto, blob: Uint8Array, options: ImportOptions = {}): BlockPreview {
  const fragment = blockFragment(proto, blob);
  const base = blankDocument();
  const target = parseDocument(openPackage(base.bytes));
  const at: InsertPoint = { sectionIndex: 0, parentPath: [], index: 0, position: "after" };
  const plan = planImport(target, fragment, at, options);
  const bytes = applyPlan(target.pkg, plan);
  const { newErrors } = compareToBaseline(base.report, validateDocument(bytes));
  const { explained, unexplained } = explainInherited(newErrors, plan.inherited, base.report.errors);
  if (unexplained.length > 0) {
    const codes = [...new Set(unexplained.map((v) => v.code))].join(", ");
    throw new HwpxError("GATE_NEW_ERRORS", `블록 ${proto.id}의 ${proto.version}판 미리보기 문서에 새 검사 오류가 ${unexplained.length}종 있어 만들지 않았습니다(${codes}).`, `block:${proto.id}`);
  }
  const issues = [
    ...plan.issues,
    ...explained.map((v) => makeIssue("warning", "GATE_INHERITED", `조각이 소스에서 갖고 있던 문제로 설명되는 오류[${v.code}]: ${v.message}${v.count > 1 ? ` (${v.count}건)` : ""}`, v.where)),
  ];
  const places = inputPlaces(parseDocument(openPackage(bytes)));
  return { bytes, fields: countFields(places), places, issues };
}
