// 뷰어 시험의 공용 도우미: rhwp 초기화, 저장소 시험 문서, 합성 시험 문서(기존 시험 문서의 구역 본문만 바꿔 만든다).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openPackage, parseDocument, readEntry, rewriteArchive, walkParagraphs, type HwpxDocument } from "../../hwpx-engine/src/index.ts";
import type { LocatePoint } from "../src/host/types.ts";
import { toEngineAddress, toRhwpPosition } from "../src/map/index.ts";
import { loadRhwp, openDocument } from "../src/rhwp/index.ts";
import { codePointLength, runPosition } from "../src/rhwp/layout.ts";

export const FIXTURE_DIR = fileURLToPath(new URL("../../hwpx-engine/test/fixtures/", import.meta.url));

/** rhwp를 한 번 초기화한다(Node: wasm 바이트를 넘긴다). */
export async function ensureRhwp(): Promise<void> {
  const wasm = new URL("./rhwp_bg.wasm", import.meta.resolve("@rhwp/core"));
  await loadRhwp({ wasmBytes: readFileSync(wasm) });
}

/** 저장소 시험 문서 이름(확장자 없이, `/` 구분) 전부. */
export function fixtureNames(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}${e.name}/`, `${prefix}${e.name}/`);
      else if (e.isFile() && e.name.endsWith(".hwpx")) out.push(`${prefix}${e.name.slice(0, -5)}`);
    }
  };
  walk(FIXTURE_DIR, "");
  return out.sort();
}

export const readFixture = (name: string): Uint8Array => new Uint8Array(readFileSync(`${FIXTURE_DIR}${name}.hwpx`));

export const parse = (bytes: Uint8Array): HwpxDocument => parseDocument(openPackage(bytes));

// ── 합성 시험 문서 ───────────────────────────────────────────────

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

/**
 * `hancom/ph-single`(한컴이 저장한 합성 문서)의 첫 문단(구역 설정이 든 문단)은 두고 그 뒤 문단들을 `paragraphs`로 바꾼 문서의 바이트.
 * 서식·글꼴 자원은 그 문서의 것을 그대로 쓰므로 rhwp가 정상적으로 연다. 첫 문단 안에 머리말·꼬리말 같은 하위 문단이 들어 있어도 첫 문단의 끝을 깊이로 찾는다.
 */
export function synth(paragraphs: string[], base = "hancom/ph-single"): Uint8Array {
  const bytes = readFixture(base);
  const pkg = openPackage(bytes);
  const name = pkg.sectionEntries[0] ?? "";
  const text = new TextDecoder().decode(readEntry(pkg.archive, bytes, name));
  let depth = 0;
  let firstEnd = -1;
  for (const m of text.matchAll(/<hp:p[ >]|<\/hp:p>/g)) {
    depth += m[0] === "</hp:p>" ? -1 : 1;
    if (depth === 0) {
      firstEnd = m.index + m[0].length;
      break;
    }
  }
  const lastStart = text.lastIndexOf("</hs:sec>");
  return rewriteArchive(bytes, pkg.archive, { replace: new Map([[name, enc(text.slice(0, firstEnd) + paragraphs.join("") + text.slice(lastStart))]]) });
}

export const P = (inner: string): string => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${inner}</hp:p>`;
export const R = (inner: string, charPr = "0"): string => `<hp:run charPrIDRef="${charPr}">${inner}</hp:run>`;
export const T = (s: string): string => `<hp:t>${s}</hp:t>`;

export const PIC = (treatAsChar: "0" | "1"): string =>
  `<hp:pic id="1208941154" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="135199331" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="4800" height="4800"/><hp:curSz width="0" height="0"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="2400" centerY="2400" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="4800" y="0"/><hc:pt2 x="4800" y="4800"/><hc:pt3 x="0" y="4800"/></hp:imgRect><hp:imgClip left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="0" dimheight="0"/><hp:effects/><hp:sz width="4800" widthRelTo="ABSOLUTE" height="4800" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="${treatAsChar}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>`;

export const SUBP = (text: string): string => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run></hp:p>`;
export const SUBLIST = (inner: string): string =>
  `<hp:subList id="0" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="10000" textHeight="3000" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>`;

/** 글상자(`rect` + `drawText`). 글자처럼 취급이면 문단 글과 겹치지 않는다. */
export const RECT = (inner: string, treatAsChar: "0" | "1" = "1"): string =>
  `<hp:rect id="1100" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="1101" ratio="0"><hp:offset x="0" y="0"/><hp:orgSz width="10000" height="3000"/><hp:curSz width="10000" height="3000"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="5000" centerY="1500" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hp:lineShape color="#000000" width="33" style="SOLID" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="MEDIUM_MEDIUM" tailSz="MEDIUM_MEDIUM" outlineStyle="NORMAL" alpha="0"/><hp:drawText lastWidth="10000" name="" editable="0">${inner}<hp:textMargin left="283" right="283" top="283" bottom="283"/></hp:drawText><hc:pt0 x="0" y="0"/><hc:pt1 x="10000" y="0"/><hc:pt2 x="10000" y="3000"/><hc:pt3 x="0" y="3000"/><hp:sz width="10000" widthRelTo="ABSOLUTE" height="3000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="${treatAsChar}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:rect>`;

export const CAPTION = (side: string, text: string): string =>
  `<hp:caption side="${side}" fullSz="0" width="8504" gap="850" lastWidth="8504"><hp:subList id="0" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${SUBP(text)}</hp:subList></hp:caption>`;

/** 표. `treatAsChar`가 "1"이면 글자처럼 취급(문단 글과 한 줄에 놓인다). `caption`을 주면 표 앞(위)에 캡션을 단다. */
export function TBL(rows: string[][], treatAsChar: "0" | "1" = "0", caption?: string): string {
  const cols = rows[0]?.length ?? 1;
  const trs = rows
    .map(
      (r, ri) =>
        `<hp:tr>${r
          .map(
            (c, ci) =>
              `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1"><hp:subList id="0" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${c}</hp:subList><hp:cellAddr colAddr="${ci}" rowAddr="${ri}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="8000" height="1000"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`,
          )
          .join("")}</hp:tr>`,
    )
    .join("");
  return `<hp:tbl id="1200" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="1" noAdjust="0"><hp:sz width="${8000 * cols}" widthRelTo="ABSOLUTE" height="${1000 * rows.length}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="${treatAsChar}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/>${caption ?? ""}<hp:inMargin left="141" right="141" top="141" bottom="141"/>${trs}</hp:tbl>`;
}

export const FIELD_BEGIN = (id: string, name: string, dirty: "0" | "1", guide: string): string =>
  `<hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}" editable="1" dirty="${dirty}" zorder="-1" fieldid="${id}9" metaTag=""><hp:parameters cnt="3" name=""><hp:integerParam name="Prop">9</hp:integerParam><hp:stringParam name="Command" xml:space="preserve">Clickhere:set:48:Direction:wstring:${[...guide].length}:${guide} HelpState:wstring:0:  </hp:stringParam><hp:stringParam name="Direction">${guide}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`;
export const FIELD_END = (id: string): string => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}9"/></hp:ctrl>`;
export const AUTO_NUM = `<hp:ctrl><hp:autoNum num="1" numType="PICTURE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/></hp:autoNum></hp:ctrl>`;
export const FOOTNOTE = (text: string): string =>
  `<hp:ctrl><hp:footNote number="1" suffixChar=")" instId="2020"><hp:subList id="0" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:autoNum num="1" numType="FOOTNOTE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="1"/></hp:autoNum></hp:ctrl><hp:t> ${text}</hp:t></hp:run></hp:p></hp:subList></hp:footNote></hp:ctrl>`;
export const BOOKMARK = (name: string): string => `<hp:ctrl><hp:bookmark name="${name}"/></hp:ctrl>`;

/** 범주별 시험에 쓰는 합성 문서(이름 → 바이트). 서로 겹치는 개체가 없도록 글자처럼 취급 개체만 쓴다. */
export function syntheticDocs(): Record<string, Uint8Array> {
  return {
    "합성-탭·줄바꿈": synth([P(R(`<hp:t>가<hp:tab width="1000" leader="0" type="1"/>나<hp:lineBreak/>다 라</hp:t>`))]),
    "합성-이모지": synth([P(R(T("A😀B가👨‍👩‍👧끝")))]),
    "합성-고정폭 공백": synth([P(R(`<hp:t>가<hp:nbSpace/>나<hp:fwSpace/>다<hp:hyphen/>라</hp:t>`))]),
    "합성-글자처럼 그림": synth([P(R(T("앞") + PIC("1") + T("가운데") + PIC("1") + T("뒤")))]),
    "합성-글자처럼 아닌 그림": synth([P(R(T("앞") + PIC("0") + T("뒤") + BOOKMARK("b1") + T("끝")))]),
    "합성-누름틀": synth([P(R(T("앞") + FIELD_BEGIN("11", "성명", "1", "이름을 입력") + T("홍길동") + FIELD_END("11") + T("뒤")))]),
    "합성-안내문 누름틀": synth([P(R(T("앞") + FIELD_BEGIN("12", "소속", "0", "소속 입력")) + R(T("소속 입력"), "7") + R(FIELD_END("12") + T("뒤 글")))]),
    "합성-누름틀 둘 뒤 표": synth([P(R(T("앞") + FIELD_BEGIN("1", "가", "1", "x") + T("XY") + FIELD_END("1") + FIELD_BEGIN("2", "나", "1", "x") + T("XY") + FIELD_END("2") + TBL([[SUBP("셀")]], "1")))]),
    "합성-자동 번호": synth([P(R(T("앞") + AUTO_NUM + T("뒤")))]),
    "합성-글상자": synth([P(R(T("앞") + RECT(SUBLIST(SUBP("글상자 안") + SUBP("둘째 줄")), "1") + T("뒤")))]),
    "합성-표 캡션": synth([P(R(TBL([[SUBP("셀")]], "0", CAPTION("TOP", "표 캡션")))), P(R(T("다음 문단")))]),
    "합성-각주": synth([P(R(T("앞") + FOOTNOTE("각주 글") + T("뒤")))]),
  };
}

/** 묶음 개체(`container`) 안에 글상자(`rect`)를 여럿 둔다. 글자처럼 취급이다. */
export const CONTAINER = (children: string[]): string =>
  `<hp:container id="1500" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="1501"><hp:offset x="0" y="0"/><hp:orgSz width="22000" height="3000"/><hp:curSz width="22000" height="3000"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="11000" centerY="1500" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>${children.join("")}<hp:sz width="22000" widthRelTo="ABSOLUTE" height="3000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:container>`;

/**
 * 구역 설정에 바탕쪽 하나(`Contents/masterpage0.xml`, 양쪽 쪽 모두)를 달아 붙인 문서의 바이트. `paragraphs`는 바탕쪽 안 문단들이다.
 * 바탕쪽 글(문서 좌표 없이 표지값으로 나오는 문단 글, 표 칸·글상자 안의 글은 본문과 같은 번호 공간의 좌표로 나온다)을 시험하는 데 쓴다.
 */
export function withMasterPage(bytes: Uint8Array, paragraphs: string): Uint8Array {
  const pkg = openPackage(bytes);
  const text = (name: string): string => new TextDecoder().decode(readEntry(pkg.archive, bytes, name));
  const sectionName = pkg.sectionEntries[0] ?? "";
  const hpf = text("Contents/content.hpf");
  const namespaces = (/<opf:package ([^>]*?) version=/.exec(hpf)?.[1] ?? "").replace(/xmlns:opf="[^"]*"\s*/, "");
  const master = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hm:masterPage ${namespaces} id="masterpage0" type="BOTH" pageNumber="0" pageDuplicate="0" pageFront="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="42520" textHeight="59528" hasTextRef="0" hasNumRef="0">${paragraphs}</hp:subList></hm:masterPage>`;
  const section = text(sectionName).replace('masterPageCnt="0">', 'masterPageCnt="1">').replace("</hp:secPr>", '<hp:masterPage idRef="masterpage0"/></hp:secPr>');
  const manifest = hpf
    .replace("</opf:manifest>", '<opf:item id="masterpage0" href="Contents/masterpage0.xml" media-type="application/xml"/></opf:manifest>')
    .replace("</opf:spine>", '<opf:itemref idref="masterpage0" linear="no"/></opf:spine>');
  return rewriteArchive(bytes, pkg.archive, {
    replace: new Map([
      [sectionName, enc(section)],
      ["Contents/content.hpf", enc(manifest)],
    ]),
    add: [{ name: "Contents/masterpage0.xml", data: enc(master), method: 8 }],
  });
}

/** 문단 점 목록의 키: 구역 번호와 엔진 주소 `path`(쉼표로 이음) */
export const paragraphKey = (sectionIndex: number, path: readonly number[]): string => `${sectionIndex}|${path.join(",")}`;

/**
 * 문단마다 누를 수 있는 점(키: `paragraphKey`). 쪽 글자 배치의 글 있는 런 가운데 엔진 주소로 글자까지 옮겨지는 런의 첫 글자와 가운데 글자를 누른 점이다.
 * 그런 런이 없는 문단은 문단까지만 옮겨지는 런(번호 글·개체를 그린 런 등)의 같은 점, 그것도 없는 문단(표를 담은 문단·빈 문단 등)은 확인할 런이 없는 문단 처음의 위치다(둘 다 문단 단위로 풀린다).
 * 머리말·꼬리말·각주처럼 rhwp 위치로 옮길 수 없는 문단은 점이 없다.
 */
export function paragraphPoints(bytes: Uint8Array, doc: HwpxDocument): Map<string, LocatePoint[]> {
  const points = new Map<string, LocatePoint[]>();
  const weak = new Map<string, LocatePoint[]>();
  const view = openDocument(bytes);
  try {
    for (let page = 0; page < view.pageCount(); page++) {
      for (const run of view.pageLayout(page).runs) {
        const position = runPosition(run);
        if (position === undefined || run.text === "") continue;
        const shown = { text: run.text, start: position.charOffset };
        const found = toEngineAddress(doc, position, shown);
        if (found.precision === "none") continue;
        const into = found.precision === "char" ? points : weak;
        const key = paragraphKey(found.address.sectionIndex, found.address.path);
        const list = into.get(key) ?? [];
        list.push({ position, shown }, { position: { ...position, charOffset: position.charOffset + (codePointLength(run.text) >> 1) }, shown });
        into.set(key, list);
      }
    }
  } finally {
    view.free();
  }
  for (const [key, list] of weak) if (!points.has(key)) points.set(key, list);
  for (const section of doc.sections) {
    for (const p of walkParagraphs(section.paragraphs)) {
      const key = paragraphKey(section.index, p.path);
      if (points.has(key)) continue;
      const position = toRhwpPosition(doc, { sectionIndex: section.index, path: p.path });
      if (position !== undefined) points.set(key, [{ position }]);
    }
  }
  return points;
}
