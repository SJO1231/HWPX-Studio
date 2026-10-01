import { attrValue, subElements, walkElements, type XElement } from "../xml/tree.ts";
import { HEADER_ENTRY, show } from "./package.ts";
import type { IssueLog } from "./types.ts";

/** "참조 없음"을 뜻하는 관례값 */
const NONE_VALUES = new Set(["4294967295", "-1"]);

/** 속성 이름 → 대상 ID 공간. header와 구역 XML 모두에서 찾는다. */
const REF_ATTRS = new Map([
  ["charPrIDRef", "charPr"],
  ["paraPrIDRef", "paraPr"],
  ["styleIDRef", "style"],
  ["nextStyleIDRef", "style"],
  ["borderFillIDRef", "borderFill"],
  ["tabPrIDRef", "tabPr"],
  ["numberingIDRef", "numbering"],
  ["outlineShapeIDRef", "numbering"],
  ["binaryItemIDRef", "binItem"],
  ["binDataIDRef", "binItem"],
]);

const FONT_LANGS: [string, string][] = [
  ["hangul", "HANGUL"],
  ["latin", "LATIN"],
  ["hanja", "HANJA"],
  ["japanese", "JAPANESE"],
  ["other", "OTHER"],
  ["symbol", "SYMBOL"],
  ["user", "USER"],
];

// refList 안의 목록 요소 → [항목 요소, ID 공간]
const LIST_OF = new Map<string, [string, string]>([
  ["borderFills", ["borderFill", "borderFill"]],
  ["charProperties", ["charPr", "charPr"]],
  ["tabProperties", ["tabPr", "tabPr"]],
  ["numberings", ["numbering", "numbering"]],
  ["bullets", ["bullet", "bullet"]],
  ["paraProperties", ["paraPr", "paraPr"]],
  ["styles", ["style", "style"]],
  ["memoProperties", ["memoPr", "memoPr"]],
]);

export type IdSpaces = {
  spaces: Map<string, Set<string>>;
  /** 글꼴 언어(fontface의 lang 속성) → 글꼴 id. id가 없는 글꼴은 undefined로 담는다. */
  fonts: Map<string | undefined, Set<string | undefined>>;
};

export function emptySpaces(): IdSpaces {
  return { spaces: new Map(), fonts: new Map() };
}

function spaceOf(spaces: IdSpaces, name: string): Set<string> {
  let set = spaces.spaces.get(name);
  if (set === undefined) spaces.spaces.set(name, (set = new Set()));
  return set;
}

/** 속성 이름에서 접두사를 뗀 local 이름 */
function attrLocal(qname: string): string {
  return qname.slice(qname.lastIndexOf(":") + 1);
}

function isNsDecl(qname: string): boolean {
  return qname === "xmlns" || qname.startsWith("xmlns:");
}

/** header의 refList에서 ID 공간별 집합을 만든다. */
export function collectResources(header: XElement, log: IssueLog): IdSpaces {
  const out = emptySpaces();
  const refList = [...walkElements(header)].find((e) => e.local === "refList");
  if (refList === undefined) {
    log.err("RES_NO_REFLIST", "header.xml 에 refList 가 없음");
    return out;
  }
  for (const grp of subElements(refList)) {
    if (grp.local === "fontfaces") {
      for (const ff of subElements(grp)) {
        const lang = attrValue(ff, "lang");
        let ids = out.fonts.get(lang);
        if (ids === undefined) out.fonts.set(lang, (ids = new Set()));
        for (const f of subElements(ff)) {
          const fid = attrValue(f, "id");
          if (ids.has(fid)) log.err("RES_DUP_ID", `font id 중복 (lang=${show(lang)})`, show(fid));
          ids.add(fid);
        }
      }
      continue;
    }
    const known = LIST_OF.get(grp.local);
    if (known === undefined) continue;
    const [childTag, space] = known;
    const ids = spaceOf(out, space);
    let n = 0;
    for (const it of subElements(grp)) {
      if (it.local !== childTag) continue;
      n++;
      const iid = attrValue(it, "id");
      if (iid === undefined) {
        log.err("RES_NO_ID", `${childTag} 에 id 가 없음`);
        continue;
      }
      if (ids.has(iid)) log.err("RES_DUP_ID", `${space} id 중복`, iid);
      ids.add(iid);
    }
    const cnt = attrValue(grp, "itemCnt");
    if (cnt !== undefined && /^\d+$/.test(cnt) && Number(cnt) !== n) {
      log.warn("RES_ITEMCNT", `${grp.local} itemCnt(${cnt}) 와 실제 개수(${n}) 불일치`);
    }
  }
  return out;
}

/** 요소 하나가 가리키는 참조를 검사한다. header와 구역 XML 모두에 쓴다. */
export function checkRefs(
  root: XElement,
  fname: string,
  idSpaces: IdSpaces,
  manifestIds: Set<string | undefined>,
  log: IssueLog,
  counters: Map<string, number>,
  strict: boolean,
): void {
  const count = (name: string): void => {
    counters.set(name, (counters.get(name) ?? 0) + 1);
  };
  const isHeader = fname === HEADER_ENTRY;
  const numbering = spaceOf(idSpaces, "numbering");
  const bullet = spaceOf(idSpaces, "bullet");
  const tabPr = spaceOf(idSpaces, "tabPr");
  const memoPr = spaceOf(idSpaces, "memoPr");

  for (const e of walkElements(root)) {
    const tag = e.local;
    for (const a of e.attrs) {
      if (isNsDecl(a.qname)) continue;
      const an = attrLocal(a.qname);
      const space = REF_ATTRS.get(an);
      if (space === undefined) continue;
      const v = a.value;
      count(an);
      if (NONE_VALUES.has(v)) continue;
      if (v === "") {
        log.warn("RES_EMPTY_REF", `${an} 값이 빈 문자열`, `${fname} <${tag}>`);
        continue;
      }
      const ok = space === "binItem" ? manifestIds.has(v) : spaceOf(idSpaces, space).has(v);
      if (!ok && an === "outlineShapeIDRef" && v === "0") continue; // 개요 번호 없음 관례
      if (!ok && an === "tabPrIDRef" && v === "0" && tabPr.size === 0 && !strict) {
        // 합성 문서(D1·D7)는 tabProperties가 비어 있는데 paraPr가 0을 쓴다. 한컴이 열어 주는 것을 실측해 경고로 분류했다. strict면 오류.
        log.warn("RES_DANGLING_TOLERATED", "tabPrIDRef='0' 인데 tabProperties 가 비어 있음(한컴 실측: 열림)", `${fname} <${tag}>`);
        continue;
      }
      if (!ok && tag === "pageBorderFill" && an === "borderFillIDRef" && v === "0" && !strict) {
        // 쪽 테두리 없음을 0으로 쓰는 문서가 있다. 한컴이 열고 저장하면 1로 고쳐 쓰는 것을 실측해 경고로 분류했다.
        log.warn("RES_DANGLING_TOLERATED", "pageBorderFill borderFillIDRef='0'(borderFill id 는 1부터, 한컴 실측: 열림)", `${fname} <${tag}>`);
        continue;
      }
      if (!ok) log.err("RES_DANGLING", `${an}='${v}' 가 가리키는 ${space} 가 없음`, `${fname} <${tag}>`);
    }

    // heading idRef: type에 따라 numbering 또는 bullet
    if (tag === "heading" && isHeader) {
      const htype = attrValue(e, "type");
      const idref = attrValue(e, "idRef");
      const none = idref !== undefined && NONE_VALUES.has(idref);
      if (htype === "OUTLINE" && idref === "0") {
        count("heading.idRef"); // OUTLINE의 idRef는 한컴 저장본에서도 0이다. numbering id가 아니다.
      } else if ((htype === "OUTLINE" || htype === "NUMBER") && !none && !(idref !== undefined && numbering.has(idref))) {
        count("heading.idRef");
        log.err("RES_DANGLING", `heading(type=${htype}).idRef='${show(idref)}' 가 가리키는 numbering 이 없음`, fname);
      } else if (htype === "BULLET" && !none && !(idref !== undefined && bullet.has(idref))) {
        count("heading.idRef");
        log.err("RES_DANGLING", `heading(type=BULLET).idRef='${show(idref)}' 가 가리키는 bullet 이 없음`, fname);
      } else if (htype === "OUTLINE" || htype === "NUMBER" || htype === "BULLET") {
        count("heading.idRef");
      }
    }

    // 글꼴 참조
    if (tag === "fontRef" && isHeader) {
      for (const [a, lang] of FONT_LANGS) {
        const v = attrValue(e, a);
        if (v === undefined) continue;
        count("fontRef");
        if (!(idSpaces.fonts.get(lang)?.has(v) ?? false)) {
          log.err("RES_DANGLING", `fontRef ${a}='${v}' 가 가리키는 글꼴이 ${lang} 글꼴 목록에 없음`, fname);
        }
      }
    }

    // memoShapeIDRef: 0은 "없음". 목록에 없으면 오류
    if (tag === "secPr") {
      const v = attrValue(e, "memoShapeIDRef");
      if (v !== undefined && v !== "0" && !NONE_VALUES.has(v) && !memoPr.has(v)) {
        log.err("RES_DANGLING", `memoShapeIDRef='${v}' 가 가리키는 memoPr 가 없음`, fname);
      }
    }
  }
}
