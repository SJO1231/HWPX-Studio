#!/usr/bin/env python3
"""HWPX 참조 무결성·구조 검사기 (표준 라이브러리만 사용).

기준 6절 "오류 검출"을 구현한다. 검사 영역:
  Package  ZIP CRC, mimetype(첫 항목·무압축), container.xml/content.hpf/header.xml/section*.xml 존재,
           manifest 항목과 실제 항목 대조(BinData 포함), META-INF/manifest.xml(없으면 경고)
  Resource header.xml refList 의 ID 집합에 대해 charPrIDRef/paraPrIDRef/styleIDRef/borderFillIDRef/
           tabPrIDRef/numberingIDRef/outlineShapeIDRef/heading.idRef/nextStyleIDRef/fontRef,
           content.hpf 의 binaryItemIDRef 가 가리키는 대상이 있는지
  Instance 문단 id, 개체(표·도형) id, instId, 필드 id, 북마크 이름의 중복
  구조     fieldBegin<->fieldEnd 짝과 순서, 북마크, 표 중첩 깊이·셀 범위, 모르는 control 요소 목록

종료 코드: 오류(error) 없음 0, 있음 1, 입력 자체를 못 읽으면 2. 경고(warning)는 종료 코드에 영향이 없다.
사용:  python validate_refs.py [--json 출력.json] [--quiet] 파일.hwpx|폴더 ...
가져다 쓰기:  from validate_refs import validate;  validate(경로)  ->  dict
"""
import argparse
import io
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

NONE_VALUES = {"4294967295", "-1"}          # "참조 없음"을 뜻하는 관례값
PLACEHOLDER_PARA_IDS = {"", "0", "2147483648", "4294967295"}  # 한컴이 여러 문단에 같은 값을 쓰는 것으로 알려진 자리값(미검증)

# 속성 이름 -> 대상 ID 공간. (header.xml 과 구역 XML 모두에서 찾는다)
REF_ATTRS = {
    "charPrIDRef": "charPr",
    "paraPrIDRef": "paraPr",
    "styleIDRef": "style",
    "nextStyleIDRef": "style",
    "borderFillIDRef": "borderFill",
    "tabPrIDRef": "tabPr",
    "numberingIDRef": "numbering",
    "outlineShapeIDRef": "numbering",
    "binaryItemIDRef": "binItem",
    "binDataIDRef": "binItem",
}
FONT_LANGS = {"hangul": "HANGUL", "latin": "LATIN", "hanja": "HANJA", "japanese": "JAPANESE",
              "other": "OTHER", "symbol": "SYMBOL", "user": "USER"}

# 개체(표·도형 등) 요소: id/instId 검사 대상
OBJECT_TAGS = {"tbl", "pic", "ole", "container", "equation", "rect", "ellipse", "arc", "polygon", "curve",
               "line", "connectLine", "textart", "video", "chart", "compose", "dutmal", "btn", "radioBtn",
               "checkBtn", "comboBox", "edit", "listBox", "scrollBar"}
RUN_KNOWN = OBJECT_TAGS | {"t", "ctrl", "secPr", "tab", "lineBreak", "fwSpace", "nbSpace", "hyphen"}
CTRL_KNOWN = {"colPr", "pageNum", "pageNumCtrl", "header", "footer", "footNote", "endNote", "autoNum", "newNum",
              "bookmark", "fieldBegin", "fieldEnd", "hiddenComment", "indexmark", "pageHiding"}
T_KNOWN = {"tab", "lineBreak", "fwSpace", "nbSpace", "hyphen", "markpenBegin", "markpenEnd", "titleMark",
           "insertBegin", "insertEnd", "deleteBegin", "deleteEnd"}
TABLE_DEPTH_WARN = 3
STRICT = [False]   # --strict 로 켜면 "한컴이 관대하게 받는" 경고도 오류로 본다


def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def attr_ci(el, name):
    """대소문자 무시로 속성 값을 찾는다(instId/instid 표기 차이 대응)."""
    for k, v in el.attrib.items():
        if local(k).lower() == name.lower():
            return v
    return None


class Report:
    def __init__(self, path):
        self.path = path
        self.errors = []
        self.warnings = []
        self.stats = {}

    @staticmethod
    def _add(lst, code, msg, where):
        for e in lst:  # 같은 내용은 합치고 개수만 센다
            if e["code"] == code and e["msg"] == msg and e["where"] == where:
                e["count"] += 1
                return
        lst.append({"code": code, "msg": msg, "where": where, "count": 1})

    def err(self, code, msg, where=""):
        self._add(self.errors, code, msg, where)

    def warn(self, code, msg, where=""):
        self._add(self.warnings, code, msg, where)

    def as_dict(self):
        return {"file": self.path, "ok": not self.errors, "errors": self.errors,
                "warnings": self.warnings, "stats": self.stats}


def _parse(z, name, rep, cache):
    if name in cache:
        return cache[name]
    try:
        root = ET.fromstring(z.read(name))
    except KeyError:
        root = None
    except ET.ParseError as e:
        rep.err("XML_MALFORMED", f"XML 정형성 오류: {e}", name)
        root = None
    except Exception as e:  # CRC 등 읽기 오류는 이미 패키지 검사에서 보고
        root = None
    cache[name] = root
    return root


# ---------------------------------------------------------------- Package
def check_package(z, rep, cache):
    infos = z.infolist()
    names = [i.filename for i in infos]
    dup = [n for n, c in Counter(names).items() if c > 1]
    for n in dup:
        rep.err("PKG_DUP_ENTRY", "ZIP 항목 이름 중복", n)
    if not infos:
        rep.err("PKG_EMPTY", "ZIP 항목이 없음")
        return set(), {}
    # mimetype
    if infos[0].filename != "mimetype":
        rep.err("PKG_MIMETYPE_ORDER", f"첫 항목이 mimetype 이 아님({infos[0].filename})")
    if "mimetype" in names:
        mi = z.getinfo("mimetype")
        if mi.compress_type != zipfile.ZIP_STORED:
            rep.err("PKG_MIMETYPE_COMPRESSED", "mimetype 이 무압축이 아님")
        try:
            val = z.read("mimetype").decode("ascii", "replace").strip()
            if val != "application/hwp+zip":
                rep.warn("PKG_MIMETYPE_VALUE", f"mimetype 값이 예상과 다름: {val!r}")
        except Exception:
            pass
    else:
        rep.err("PKG_MIMETYPE_MISSING", "mimetype 항목 없음")
    # CRC: 항목마다 끝까지 읽어 본다
    for i in infos:
        if i.is_dir():
            continue
        try:
            with z.open(i) as f:
                while f.read(1 << 16):
                    pass
        except (zipfile.BadZipFile, RuntimeError, OSError, EOFError) as e:
            rep.err("PKG_CRC", f"CRC/읽기 오류: {e}", i.filename)
    nameset = set(names)
    # 필수 항목
    for req in ("META-INF/container.xml", "Contents/content.hpf", "Contents/header.xml"):
        if req not in nameset:
            rep.err("PKG_MISSING", "필수 항목 없음", req)
    sections = sorted(n for n in nameset if n.startswith("Contents/section") and n.lower().endswith(".xml"))
    if not sections:
        rep.err("PKG_MISSING", "Contents/section*.xml 이 하나도 없음")
    if "META-INF/manifest.xml" not in nameset:
        rep.warn("PKG_NO_ODF_MANIFEST", "META-INF/manifest.xml 없음(한컴 저장본에는 있고 kordoc 합성본에는 없음)")
    # 모든 xml 정형성
    for n in sorted(nameset):
        if n.lower().endswith((".xml", ".hpf", ".rdf")):
            _parse(z, n, rep, cache)
    # container.xml
    c = _parse(z, "META-INF/container.xml", rep, cache)
    if c is not None:
        roots = [e.get("full-path") for e in c.iter() if local(e.tag) == "rootfile"]
        if not roots:
            rep.err("PKG_ROOTFILE", "container.xml 에 rootfile 이 없음")
        for r in roots:
            if r not in nameset:
                rep.err("PKG_ROOTFILE", "container.xml rootfile 이 가리키는 항목이 없음", str(r))
    # content.hpf: manifest/spine
    manifest = {}
    hpf = _parse(z, "Contents/content.hpf", rep, cache)
    if hpf is not None:
        for it in hpf.iter():
            if local(it.tag) == "item":
                iid, href = it.get("id"), it.get("href")
                if iid in manifest:
                    rep.err("PKG_MANIFEST_DUP_ID", "manifest item id 중복", str(iid))
                manifest[iid] = href
                if href and not href.startswith(("http:", "https:")) and href not in nameset:
                    (rep.err if href.startswith("BinData/") or href.startswith("Contents/") else rep.warn)(
                        "PKG_MANIFEST_HREF_MISSING", f"manifest item({iid})의 href 항목이 ZIP 에 없음", str(href))
        for ref in hpf.iter():
            if local(ref.tag) == "itemref" and ref.get("idref") not in manifest:
                rep.err("PKG_SPINE_IDREF", "spine itemref 가 manifest 에 없는 id 를 가리킴", str(ref.get("idref")))
        hrefs = set(manifest.values())
        for s in sections:
            if s not in hrefs:
                rep.err("PKG_SECTION_NOT_IN_MANIFEST", "section 파일이 content.hpf manifest 에 없음", s)
        bins_in_zip = {n for n in nameset if n.startswith("BinData/") and not n.endswith("/")}
        for b in sorted(bins_in_zip - hrefs):
            rep.warn("PKG_BINDATA_ORPHAN", "BinData 항목이 manifest 에 없음", b)
    rep.stats["zip_entries"] = len(infos)
    rep.stats["sections"] = len(sections)
    rep.stats["manifest_items"] = len(manifest)
    return set(sections), manifest


# ---------------------------------------------------------------- Resource
def collect_resources(header, rep):
    """header.xml refList 에서 ID 공간별 집합을 만든다."""
    spaces = defaultdict(set)
    fonts = defaultdict(set)
    ref_list = None
    for e in header.iter():
        if local(e.tag) == "refList":
            ref_list = e
            break
    if ref_list is None:
        rep.err("RES_NO_REFLIST", "header.xml 에 refList 가 없음")
        return spaces, fonts
    container_of = {"borderFills": ("borderFill", "borderFill"), "charProperties": ("charPr", "charPr"),
                    "tabProperties": ("tabPr", "tabPr"), "numberings": ("numbering", "numbering"),
                    "bullets": ("bullet", "bullet"), "paraProperties": ("paraPr", "paraPr"),
                    "styles": ("style", "style"), "memoProperties": ("memoPr", "memoPr")}
    for grp in ref_list:
        gname = local(grp.tag)
        if gname == "fontfaces":
            for ff in grp:
                lang = ff.get("lang")
                for f in ff:
                    fid = f.get("id")
                    if fid in fonts[lang]:
                        rep.err("RES_DUP_ID", f"font id 중복 (lang={lang})", str(fid))
                    fonts[lang].add(fid)
            continue
        if gname not in container_of:
            continue
        child_tag, space = container_of[gname]
        n = 0
        for it in grp:
            if local(it.tag) != child_tag:
                continue
            n += 1
            iid = it.get("id")
            if iid is None:
                rep.err("RES_NO_ID", f"{child_tag} 에 id 가 없음")
                continue
            if iid in spaces[space]:
                rep.err("RES_DUP_ID", f"{space} id 중복", str(iid))
            spaces[space].add(iid)
        cnt = grp.get("itemCnt")
        if cnt is not None and cnt.isdigit() and int(cnt) != n:
            rep.warn("RES_ITEMCNT", f"{gname} itemCnt({cnt}) 와 실제 개수({n}) 불일치")
    return spaces, fonts


def check_refs(root, fname, spaces, fonts, manifest_ids, rep, counters):
    for e in root.iter():
        tag = local(e.tag)
        # 속성 기반 참조
        for k, v in e.attrib.items():
            an = local(k)
            space = REF_ATTRS.get(an)
            if space is None:
                continue
            counters[an] += 1
            if v in NONE_VALUES:
                continue
            if v == "":
                rep.warn("RES_EMPTY_REF", f"{an} 값이 빈 문자열", f"{fname} <{tag}>")
                continue
            if space == "binItem":
                ok = v in manifest_ids
            else:
                ok = v in spaces[space]
            if not ok and an == "outlineShapeIDRef" and v == "0":
                continue  # 개요 번호 없음 관례
            if not ok and an == "tabPrIDRef" and v == "0" and not spaces["tabPr"] and not STRICT[0]:
                # kordoc 합성본(D1·D7)은 tabProperties 가 비어 있는데 paraPr 가 0 을 쓴다. 한컴이 열어 주는 것을 COM 으로 실측(P4)해 경고로 분류. --strict 면 오류.
                rep.warn("RES_DANGLING_TOLERATED", "tabPrIDRef='0' 인데 tabProperties 가 비어 있음(한컴 실측: 열림)", f"{fname} <{tag}>")
                continue
            if not ok and tag == "pageBorderFill" and an == "borderFillIDRef" and v == "0" and not STRICT[0]:
                # rhwp v0.8.6 이 쪽 테두리 없음을 0 으로 쓴다. 한컴이 열고 저장하면 1 로 고쳐 쓰는 것을 COM 으로 실측해 경고로 분류.
                rep.warn("RES_DANGLING_TOLERATED", "pageBorderFill borderFillIDRef='0'(borderFill id 는 1부터, 한컴 실측: 열림)", f"{fname} <{tag}>")
                continue
            if not ok:
                rep.err("RES_DANGLING", f"{an}={v!r} 가 가리키는 {space} 가 없음", f"{fname} <{tag}>")
        # heading idRef: type 에 따라 numbering 또는 bullet
        if tag == "heading" and fname == "Contents/header.xml":
            htype, idref = e.get("type"), e.get("idRef")
            if htype == "OUTLINE" and idref == "0":
                counters["heading.idRef"] += 1  # 한컴 저장본에서도 OUTLINE 의 idRef 는 0 이다(실측: COM 저장본). numbering id 가 아니다.
            elif htype in ("OUTLINE", "NUMBER") and idref not in NONE_VALUES and idref not in spaces["numbering"]:
                counters["heading.idRef"] += 1
                rep.err("RES_DANGLING", f"heading(type={htype}).idRef={idref!r} 가 가리키는 numbering 이 없음", fname)
            elif htype == "BULLET" and idref not in NONE_VALUES and idref not in spaces["bullet"]:
                counters["heading.idRef"] += 1
                rep.err("RES_DANGLING", f"heading(type=BULLET).idRef={idref!r} 가 가리키는 bullet 이 없음", fname)
            elif htype in ("OUTLINE", "NUMBER", "BULLET"):
                counters["heading.idRef"] += 1
        # 글꼴 참조
        if tag == "fontRef" and fname == "Contents/header.xml":
            for a, lang in FONT_LANGS.items():
                v = e.get(a)
                if v is None:
                    continue
                counters["fontRef"] += 1
                if v not in fonts.get(lang, set()):
                    rep.err("RES_DANGLING", f"fontRef {a}={v!r} 가 가리키는 글꼴이 {lang} 글꼴 목록에 없음", fname)
        # memoShapeIDRef: 0 은 "없음", memoProperties 가 있을 때만 검사
        if tag == "secPr":
            v = e.get("memoShapeIDRef")
            if v not in (None, "0") and v not in NONE_VALUES and v not in spaces["memoPr"]:
                rep.err("RES_DANGLING", f"memoShapeIDRef={v!r} 가 가리키는 memoPr 가 없음", fname)


# ---------------------------------------------------------------- Instance / 구조
def walk_section(root, fname, rep, acc):
    """구역 XML 을 문서 순서로 훑어 인스턴스 ID·필드·북마크·표 구조를 모은다."""
    def rec(el, tdepth, parent_tag, anc=()):
        tag = local(el.tag)
        if tag == "p":
            acc["p_count"] += 1
            pid = el.get("id")
            if pid is not None:
                acc["ids"]["paragraph id"].append((pid, f"{fname} [{'>'.join(anc[-3:])}]"))
        if tag in OBJECT_TAGS:
            oid = el.get("id")
            if oid is not None and oid != "":
                acc["ids"]["object id (표·도형)"].append((oid, f"{fname} <{tag}>"))
        inst = attr_ci(el, "instId")
        if inst not in (None, ""):
            acc["ids"]["instId"].append((inst, f"{fname} <{tag}>"))
        if tag == "fieldBegin":
            fid = el.get("id")
            acc["order"] += 1
            acc["field_begin"].append((fid, acc["order"], el.get("fieldid"), el.get("type"), el.get("name")))
            if fid not in (None, ""):
                acc["ids"]["field id"].append((fid, f"{fname} <fieldBegin>"))
            if (el.get("type") or "").upper() == "BOOKMARK" and el.get("name"):
                acc["bookmarks"].append(el.get("name"))
        elif tag == "fieldEnd":
            acc["order"] += 1
            acc["field_end"].append((el.get("beginIDRef"), acc["order"], el.get("fieldid")))
        elif tag == "bookmark":
            nm = el.get("name")
            if not nm:
                rep.err("BOOKMARK_NO_NAME", "북마크 이름이 비어 있음", fname)
            else:
                acc["bookmarks"].append(nm)
        # 모르는 control
        if tag == "run":
            for c in el:
                ct = local(c.tag)
                if ct not in RUN_KNOWN:
                    acc["unknown"][f"run/{ct}"] += 1
        if tag == "ctrl":
            for c in el:
                ct = local(c.tag)
                if ct not in CTRL_KNOWN:
                    acc["unknown"][f"ctrl/{ct}"] += 1
        if tag == "t":
            for c in el:
                ct = local(c.tag)
                if ct not in T_KNOWN:
                    acc["unknown"][f"t/{ct}"] += 1
        # 표
        if tag == "tbl":
            tdepth += 1
            acc["tbl_count"] += 1
            acc["tbl_depth_max"] = max(acc["tbl_depth_max"], tdepth)
            check_table(el, fname, rep)
        for c in el:
            rec(c, tdepth, tag, anc + (tag,))
    rec(root, 0, None)


def _int(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def check_table(tbl, fname, rep):
    rows = [c for c in tbl if local(c.tag) == "tr"]
    row_cnt, col_cnt = _int(tbl.get("rowCnt")), _int(tbl.get("colCnt"))
    tid = tbl.get("id", "?")
    if row_cnt is not None and row_cnt != len(rows):
        rep.warn("TBL_ROWCNT", f"표 rowCnt({row_cnt}) 와 tr 개수({len(rows)}) 불일치", f"{fname} tbl id={tid}")
    maxcol = maxrow = 0
    for tr in rows:
        for tc in (c for c in tr if local(c.tag) == "tc"):
            addr = next((c for c in tc if local(c.tag) == "cellAddr"), None)
            span = next((c for c in tc if local(c.tag) == "cellSpan"), None)
            if addr is None:
                rep.err("TBL_CELL", "tc 에 cellAddr 가 없음", f"{fname} tbl id={tid}")
                continue
            ca, ra = _int(addr.get("colAddr"), 0), _int(addr.get("rowAddr"), 0)
            cs = _int(span.get("colSpan"), 1) if span is not None else 1
            rs = _int(span.get("rowSpan"), 1) if span is not None else 1
            maxcol, maxrow = max(maxcol, ca + cs), max(maxrow, ra + rs)
            if col_cnt is not None and ca + cs > col_cnt:
                rep.err("TBL_CELL_RANGE", f"셀(col {ca}, span {cs})이 colCnt({col_cnt}) 를 넘음", f"{fname} tbl id={tid}")
            if row_cnt is not None and ra + rs > row_cnt:
                rep.err("TBL_CELL_RANGE", f"셀(row {ra}, span {rs})이 rowCnt({row_cnt}) 를 넘음", f"{fname} tbl id={tid}")
    if col_cnt is not None and rows and maxcol != col_cnt:
        rep.warn("TBL_COLCNT", f"표 colCnt({col_cnt}) 와 셀이 덮는 열 수({maxcol}) 불일치", f"{fname} tbl id={tid}")


def check_instances(acc, rep):
    for space, items in acc["ids"].items():
        seen = defaultdict(list)
        for v, where in items:
            seen[v].append(where)
        for v, wh in seen.items():
            if len(wh) < 2:
                continue
            if space == "paragraph id" and v in PLACEHOLDER_PARA_IDS:
                acc["placeholder_para_id_dups"][v] = len(wh)
                continue
            if space in ("object id (표·도형)", "instId") and v == "0" and not STRICT[0]:
                # rhwp v0.8.6 이 새로 만든 표·그림은 id/instid 를 0 으로 둔다. 한컴이 열어 저장하면 새 id 를 부여하는 것을 COM 으로 실측해 경고로 분류.
                rep.warn("INST_DUP_PLACEHOLDER", f"{space} '0' 이 {len(wh)}개(미할당 자리값, 한컴 실측: 열고 저장하면 재발급)", "; ".join(sorted(set(wh))[:3]))
                continue
            rep.err("INST_DUP_ID", f"{space} 중복: {v!r} x{len(wh)}", "; ".join(sorted(set(wh))[:3]))
    # 북마크 이름
    for nm, n in Counter(acc["bookmarks"]).items():
        if n > 1:
            rep.err("BOOKMARK_DUP", f"북마크 이름 중복: {nm!r} x{n}")
    # 필드 짝
    begins = defaultdict(list)
    for fid, pos, fld, typ, name in acc["field_begin"]:
        begins[fid].append((pos, fld, typ))
    ends = defaultdict(list)
    for ref, pos, fld in acc["field_end"]:
        ends[ref].append((pos, fld))
    for ref, lst in ends.items():
        if ref not in begins:
            rep.err("FIELD_UNPAIRED_END", f"fieldEnd(beginIDRef={ref!r}) 에 짝이 되는 fieldBegin 이 없음")
            continue
        if len(lst) > 1:
            rep.err("FIELD_MULTI_END", f"fieldBegin id={ref!r} 에 fieldEnd 가 {len(lst)}개")
        bpos, bfld, _ = begins[ref][0]
        for epos, efld in lst:
            if epos < bpos:
                rep.err("FIELD_ORDER", f"fieldEnd(beginIDRef={ref!r}) 가 fieldBegin 보다 앞에 있음")
            if bfld is not None and efld is not None and bfld != efld:
                rep.warn("FIELD_FIELDID_MISMATCH", f"id={ref!r} 의 fieldBegin.fieldid({bfld}) 와 fieldEnd.fieldid({efld}) 가 다름")
    for fid, lst in begins.items():
        if fid not in ends:
            rep.err("FIELD_UNPAIRED_BEGIN", f"fieldBegin id={fid!r} 에 짝이 되는 fieldEnd 가 없음")
    if acc["tbl_depth_max"] > TABLE_DEPTH_WARN:
        rep.warn("TBL_DEPTH", f"표 중첩 깊이 {acc['tbl_depth_max']} (경고 기준 {TABLE_DEPTH_WARN} 초과)")
    if acc["unknown"]:
        rep.warn("UNKNOWN_CONTROL", "모르는 control/개체 요소: " + ", ".join(f"{k} x{v}" for k, v in sorted(acc["unknown"].items())))


# ---------------------------------------------------------------- 진입점
def validate(path):
    rep = Report(str(path))
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, FileNotFoundError, OSError) as e:
        rep.err("PKG_NOT_ZIP", f"ZIP 으로 열 수 없음: {e}")
        d = rep.as_dict()
        d["unreadable"] = True
        return d
    with z:
        cache = {}
        sections, manifest = check_package(z, rep, cache)
        header = _parse(z, "Contents/header.xml", rep, cache)
        spaces, fonts = (defaultdict(set), defaultdict(set))
        if header is not None:
            spaces, fonts = collect_resources(header, rep)
        manifest_ids = set(manifest.keys())
        counters = Counter()
        acc = {"p_count": 0, "tbl_count": 0, "tbl_depth_max": 0, "order": 0,
               "ids": defaultdict(list), "field_begin": [], "field_end": [], "bookmarks": [],
               "unknown": Counter(), "placeholder_para_id_dups": {}}
        if header is not None:
            check_refs(header, "Contents/header.xml", spaces, fonts, manifest_ids, rep, counters)
        for s in sorted(sections):
            root = _parse(z, s, rep, cache)
            if root is None:
                continue
            check_refs(root, s, spaces, fonts, manifest_ids, rep, counters)
            walk_section(root, s, rep, acc)
        check_instances(acc, rep)
        # secCnt
        if header is not None and header.get("secCnt", "").isdigit() and int(header.get("secCnt")) != len(sections):
            rep.warn("PKG_SECCNT", f"header secCnt({header.get('secCnt')}) 와 section 파일 수({len(sections)}) 불일치")
        rep.stats.update({
            "resources": {k: len(v) for k, v in sorted(spaces.items())},
            "ref_checks": dict(counters),
            "paragraphs": acc["p_count"], "tables": acc["tbl_count"], "table_depth_max": acc["tbl_depth_max"],
            "field_pairs": len(acc["field_begin"]), "bookmarks": len(acc["bookmarks"]),
            "unknown_controls": dict(acc["unknown"]),
            "placeholder_paragraph_id_duplicates": acc["placeholder_para_id_dups"],
        })
    return rep.as_dict()


def collect_paths(items):
    out = []
    for it in items:
        if os.path.isdir(it):
            out += [os.path.join(it, n) for n in sorted(os.listdir(it)) if n.lower().endswith(".hwpx")]
        else:
            out.append(it)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="HWPX 참조 무결성·구조 검사기")
    ap.add_argument("paths", nargs="+", help=".hwpx 파일 또는 폴더")
    ap.add_argument("--json", help="JSON 결과를 저장할 경로")
    ap.add_argument("--quiet", action="store_true", help="요약 한 줄씩만 출력")
    ap.add_argument("--strict", action="store_true", help="한컴이 받아 주는 것으로 실측된 경고(RES_DANGLING_TOLERATED)도 오류로 처리")
    args = ap.parse_args(argv)
    STRICT[0] = args.strict
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    results = [validate(p) for p in collect_paths(args.paths)]
    summary = {"files": len(results), "passed": sum(r["ok"] for r in results),
               "failed": sum(not r["ok"] for r in results),
               "errors": sum(len(r["errors"]) for r in results), "warnings": sum(len(r["warnings"]) for r in results)}
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "results": results}, f, ensure_ascii=False, indent=1)
    for r in results:
        st = r["stats"]
        print(f"{'PASS' if r['ok'] else 'FAIL'} | {os.path.basename(r['file'])} | 오류 {len(r['errors'])} 경고 {len(r['warnings'])}"
              f" | 문단 {st.get('paragraphs')} 표 {st.get('tables')} (깊이 {st.get('table_depth_max')})")
        if not args.quiet:
            for e in r["errors"]:
                print(f"    [오류 {e['code']}] {e['msg']} {('@ ' + e['where']) if e['where'] else ''}{' x' + str(e['count']) if e['count'] > 1 else ''}")
            for w in r["warnings"]:
                print(f"    [경고 {w['code']}] {w['msg']} {('@ ' + w['where']) if w['where'] else ''}{' x' + str(w['count']) if w['count'] > 1 else ''}")
    print(f"요약: {summary['passed']}/{summary['files']} 통과, 오류 {summary['errors']}, 경고 {summary['warnings']}")
    if any(r.get("unreadable") for r in results):
        return 2
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
