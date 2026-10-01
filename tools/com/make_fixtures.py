# 한컴 오피스(한글)를 COM 으로 자동화해 엔진 시험용 합성 HWPX 를 만든다.
# 실행: python tools/com/make_fixtures.py   (한컴 오피스가 설치된 Windows, pywin32 필요)
#
# 구조
#   - 기본 실행(오케스트레이터)은 문서마다 이 파일을 `--worker <이름>` 으로 다시 실행하고 60초 안에 끝나지 않으면
#     그 작업자와 그 작업자가 띄운 Hwp.exe 만 종료한 뒤 그 문서를 실패로 기록한다.
#   - 작업자는 한컴을 숨긴 채 띄워 문서 하나를 만들고 HWPX 로 저장한 뒤 다시 열어 쪽 수를 읽고 Quit 한다.
#   - 모든 문서가 끝나면 ZIP 을 열어 수치를 세고 tools/com/out/manifest.json 을 쓴다.
# 시작 전에 이미 떠 있던 Hwp.exe 의 PID 는 기록해 두고 건드리지 않는다.
import argparse
import hashlib
import json
import os
import re
import subprocess
import struct
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
DOC_TIMEOUT_SEC = 60
DOCS = ["ph-single", "ph-mixed", "ph-table", "field-states", "picture", "blocks", "header-footer", "tables-merged", "tables-inline", "tables-nested", "tables-rich"]

NS = {
    "hp": "http://www.hancom.co.kr/hwpml/2011/paragraph",
    "hh": "http://www.hancom.co.kr/hwpml/2011/head",
    "hc": "http://www.hancom.co.kr/hwpml/2011/core",
    "opf": "http://www.idpf.org/2007/opf/",
}


def q(prefix, tag):
    return "{%s}%s" % (NS[prefix], tag)


def local(el):
    return el.tag.rsplit("}", 1)[-1]


# ----------------------------------------------------------------------------
# 공통: Hwp.exe 프로세스 목록
# ----------------------------------------------------------------------------
def hwp_pids():
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Hwp.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True)
    return {int(l.split('","')[1]) for l in r.stdout.splitlines() if l.startswith('"Hwp.exe"')}


def kill_pids(pids):
    for p in pids:
        subprocess.run(["taskkill", "/F", "/PID", str(p)], capture_output=True)


def private_strings():
    """산출물에 들어가면 안 되는 문자열(사용자 이름, 임시·작업 폴더 경로). 값은 어디에도 기록하지 않는다."""
    vals = {os.environ.get("USERNAME", ""), Path.home().name, tempfile.gettempdir(), str(HERE), str(HERE.parent.parent)}
    return sorted(v for v in vals if len(v) >= 3)


def scrub_text(s):
    for v in private_strings():
        s = s.replace(v, "<redacted>")
    return s


# ----------------------------------------------------------------------------
# 작업자: COM 으로 문서 만들기
# ----------------------------------------------------------------------------
def ins(hwp, text):
    ps = hwp.HParameterSet.HInsertText
    hwp.HAction.GetDefault("InsertText", ps.HSet)
    ps.Text = text
    hwp.HAction.Execute("InsertText", ps.HSet)


def newline(hwp):
    hwp.HAction.Run("BreakPara")


def set_bold(hwp, on):
    cs = hwp.HParameterSet.HCharShape
    hwp.HAction.GetDefault("CharShape", cs.HSet)
    cs.Bold = 1 if on else 0
    hwp.HAction.Execute("CharShape", cs.HSet)


def make_table(hwp, rows, cols, cells):
    """커서가 있는 빈 문단에 표를 만들고 cells(행 우선, None 은 빈 칸)를 채운 뒤 문서 끝으로 나온다."""
    ps = hwp.HParameterSet.HTableCreation
    hwp.HAction.GetDefault("TableCreate", ps.HSet)
    ps.Rows = rows
    ps.Cols = cols
    ps.WidthType = 0
    ps.HeightType = 0
    if not hwp.HAction.Execute("TableCreate", ps.HSet):
        raise RuntimeError("TableCreate failed")
    for i, text in enumerate(cells):
        if text:
            ins(hwp, text)
        if i < len(cells) - 1:
            hwp.HAction.Run("TableRightCell")
    # 표를 문서 끝 문단에 만들면 한컴이 표 뒤에 빈 문단을 하나 두므로, 거기로 나와서 이어 쓴다.
    hwp.HAction.Run("MoveDocEnd")


def write_png(path, w=64, h=64, rgb=(70, 130, 180)):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"pHYs", struct.pack(">IIB", 3780, 3780, 1))  # 96 dpi
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    Path(path).write_bytes(png)


def build_ph_single(hwp):
    # 한컴은 문단 끝이 " 입니다" 인 채로 Enter 를 치면 그 앞 공백을 지운다(자동 교정). 둘째 문단은 Enter 를 치지 않도록
    # 빈 문단으로 만들어 두었다가 마지막에 채운다.
    ins(hwp, "합성 시험 문서 (단일 서식)")
    newline(hwp)
    newline(hwp)
    ins(hwp, "기간: {{project.start}} ~ {{project.end}}")
    hwp.HAction.Run("MoveUp")
    ins(hwp, "사업명: {{project.name}} 입니다.")


def build_ph_mixed(hwp):
    # 문단 1: 서식이 중간에서 바뀐다. {{project. 까지 보통, name}} 은 굵게.
    ins(hwp, "사업명: {{project.")
    set_bold(hwp, True)
    ins(hwp, "name}}")
    newline(hwp)
    set_bold(hwp, False)
    # 문단 2: 같은 서식으로 두 번의 삽입 호출에 나눠 넣는다.
    ins(hwp, "회사명: {{company.")
    ins(hwp, "name}}")
    newline(hwp)
    # 문단 3: 탭 문자가 사이에 낀다.
    ins(hwp, "담당: {{manager.name}}")
    ins(hwp, "\t")
    ins(hwp, "{{manager.phone}}")


def build_ph_table(hwp):
    ins(hwp, "신청서")
    newline(hwp)
    make_table(hwp, 3, 2, ["성명", "{{applicant.name}}", "연락처", None, "비고", "{{note}}"])
    ins(hwp, "위와 같이 신청합니다.")


def build_field_states(hwp):
    # CreateField 뒤 커서는 누름틀 안에 남으므로, 줄 끝으로 나와야 다음 문단이 누름틀 밖에서 시작한다.
    ins(hwp, "성명: ")
    hwp.CreateField("이름을 입력", "", "성명")
    hwp.HAction.Run("MoveLineEnd")
    newline(hwp)
    ins(hwp, "소속: ")
    hwp.CreateField("소속 입력", "", "소속")
    hwp.HAction.Run("MoveLineEnd")
    newline(hwp)
    ins(hwp, "확인자 성명: ")
    hwp.CreateField("이름을 입력", "", "성명")
    hwp.PutFieldText("소속", "합성기관")


def build_picture(hwp):
    ins(hwp, "그림 앞 문단")
    newline(hwp)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        png = Path(tmp) / "synthetic-64x64.png"
        write_png(png)
        hwp.InsertPicture(str(png), True, 0)  # 문서에 포함, 원래 크기
    newline(hwp)
    ins(hwp, "그림 뒤 문단")


def build_blocks(hwp):
    ins(hwp, "1. 개요")
    newline(hwp)
    ins(hwp, "개요 본문입니다.")
    newline(hwp)
    ins(hwp, "2. 선택 조항")
    newline(hwp)
    ins(hwp, "선택 조항 본문입니다. (해당 시)")
    newline(hwp)
    make_table(hwp, 3, 3, ["구분", "내용", "비고", "A", "가", "-", "B", "나", "-"])
    ins(hwp, "3. 끝")


def build_header_footer(hwp):
    ins(hwp, "본문 첫째 문단")
    newline(hwp)
    ins(hwp, "본문 둘째 문단")
    # 머리말: HeaderFooter 동작이 머리말을 만들고 편집 상태로 들어간다.
    hwp.HAction.Run("MoveDocBegin")
    ps = hwp.HParameterSet.HHeaderFooter
    hwp.HAction.GetDefault("HeaderFooter", ps.HSet)
    ps.HSet.SetItem("Type", 0)  # 적용 쪽(양쪽). 이 동작으로는 꼬리말을 고를 수 없었다.
    if not hwp.HAction.Execute("HeaderFooter", ps.HSet):
        raise RuntimeError("HeaderFooter failed")
    ins(hwp, "{{doc.title}}")
    hwp.HAction.Run("CloseEx")
    # 꼬리말: InsertCtrl("foot") 은 꼬리말만 만들고 편집 상태로 들어가지 않으므로, 꼬리말의 리스트로 캐럿을 옮긴다.
    hwp.HAction.Run("MoveDocBegin")
    ps = hwp.HParameterSet.HHeaderFooter
    hwp.HAction.GetDefault("HeaderFooter", ps.HSet)
    if hwp.InsertCtrl("foot", ps.HSet) is None:
        raise RuntimeError("InsertCtrl(foot) failed")
    for list_id in range(1, 8):
        hwp.SetPos(list_id, 0, 0)
        parent = hwp.ParentCtrl
        if parent is not None and parent.CtrlID == "foot":
            break
    else:
        raise RuntimeError("could not move the caret into the footer")
    ins(hwp, "{{doc.owner}}")
    hwp.SetPos(0, 0, 0)


def table_create(hwp, rows, cols, tac=False):
    """커서가 있는 빈 문단에 표를 만든다(캐럿은 첫 셀). tac 가 참이면 글자처럼 취급."""
    ps = hwp.HParameterSet.HTableCreation
    hwp.HAction.GetDefault("TableCreate", ps.HSet)
    ps.Rows = rows
    ps.Cols = cols
    ps.WidthType = 0
    ps.HeightType = 0
    # 한컴은 표 만들기의 마지막 설정을 기억하므로 글자처럼 취급 여부를 항상 명시한다.
    ps.TableProperties.TreatAsChar = 1 if tac else 0
    if not hwp.HAction.Execute("TableCreate", ps.HSet):
        raise RuntimeError("TableCreate failed")


def type_cells(hwp, texts):
    """캐럿이 있는 셀부터 행 우선으로 글을 넣는다(None 은 건너뜀). 마지막 셀에서 멈춘다."""
    for i, text in enumerate(texts):
        if text:
            ins(hwp, text)
        if i < len(texts) - 1:
            hwp.HAction.Run("TableRightCell")


def merge_from(hwp, list_id, extend):
    """리스트 번호의 셀에서 시작해 `extend`(TableRightCell·TableLowerCell) 방향으로 한 칸 넓힌 블록을 합친다."""
    hwp.SetPos(list_id, 0, 0)
    for act in ["TableCellBlock", "TableCellBlockExtend", extend, "TableMergeCell"]:
        if not hwp.HAction.Run(act):
            raise RuntimeError("%s failed" % act)


def build_tables_merged(hwp):
    # 4행 3열. 가로 병합(A1·B1)과 세로 병합(C2·C3)이 든 표. 한컴이 표를 만들 때 제목 행 반복은 기본으로 켜져 있다.
    ins(hwp, "병합 표")
    newline(hwp)
    table_create(hwp, 4, 3)
    type_cells(hwp, ["신청 내역", None, "비고", "가", "A", "세로", "나", "B", None, "다", "C", "c"])
    merge_from(hwp, 2, "TableRightCell")  # A1 + B1
    merge_from(hwp, 6, "TableLowerCell")  # 병합 뒤 번호가 당겨져 C2 는 리스트 6
    hwp.HAction.Run("MoveDocEnd")
    ins(hwp, "끝")


def build_tables_inline(hwp):
    ins(hwp, "앞 문단")
    newline(hwp)
    table_create(hwp, 2, 3, tac=True)  # 글자처럼 취급
    type_cells(hwp, ["항목", "내용", "비고", "a", "b", "c"])
    hwp.HAction.Run("MoveDocEnd")
    ins(hwp, "뒤 문단")


def build_tables_nested(hwp):
    ins(hwp, "중첩 표")
    newline(hwp)
    table_create(hwp, 2, 2)
    type_cells(hwp, ["바깥1", None, "바깥3", "바깥4"])
    hwp.SetPos(3, 0, 0)  # 바깥 표의 (1행, 2열) 셀에 안쪽 표를 만든다
    table_create(hwp, 2, 2)
    type_cells(hwp, ["안1", "안2", "안3", "안4"])
    hwp.HAction.Run("MoveDocEnd")
    ins(hwp, "끝")


def build_tables_rich(hwp):
    # 셀 안에 누름틀과 그림이 든 표
    ins(hwp, "풍부한 표")
    newline(hwp)
    table_create(hwp, 3, 3)
    type_cells(hwp, ["번호", "이름", "내용", "1"])
    hwp.HAction.Run("TableRightCell")
    hwp.CreateField("이름 입력", "", "이름")
    hwp.HAction.Run("MoveLineEnd")
    hwp.HAction.Run("TableRightCell")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        png = Path(tmp) / "synthetic-64x64.png"
        write_png(png)
        hwp.InsertPicture(str(png), True, 0)
    hwp.HAction.Run("TableRightCell")
    type_cells(hwp, ["2", "둘째"])
    hwp.HAction.Run("MoveDocEnd")
    ins(hwp, "끝")


BUILDERS = {
    "ph-single": build_ph_single,
    "ph-mixed": build_ph_mixed,
    "ph-table": build_ph_table,
    "field-states": build_field_states,
    "picture": build_picture,
    "blocks": build_blocks,
    "header-footer": build_header_footer,
    "tables-merged": build_tables_merged,
    "tables-inline": build_tables_inline,
    "tables-nested": build_tables_nested,
    "tables-rich": build_tables_rich,
}


def scrub_metadata(path):
    """한컴이 content.hpf 에 적는 작성자·마지막 저장자(= 이 PC 의 사용자 이름)만 중립 값으로 바꿔 다시 묶는다.
    구역·머리 XML 과 항목 순서·압축 방식은 그대로 둔다."""
    pat = re.compile(rb'(<opf:meta name="(?:creator|lastsaveby)" content="text">)[^<]*(</opf:meta>)')
    with zipfile.ZipFile(path) as zin:
        items = [(i, zin.read(i.filename)) for i in zin.infolist()]
    tmp = Path(str(path) + ".tmp")
    with zipfile.ZipFile(tmp, "w") as zout:
        for info, data in items:
            if info.filename == "Contents/content.hpf":
                data = pat.sub(rb"\1synthetic\2", data)
            zi = zipfile.ZipInfo(info.filename, info.date_time)
            zi.compress_type = info.compress_type
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    os.replace(tmp, path)


def run_worker(name, protect):
    result = {"name": name, "ok": False}
    out = OUT / (name + ".hwpx")
    hwp = None
    owned = False
    try:
        import win32com.client

        if out.exists():
            out.unlink()
        hwp = win32com.client.Dispatch("HWPFrame.HwpObject")
        for _ in range(20):
            if hwp_pids() - protect:
                owned = True
                break
            time.sleep(0.5)
        if not owned:
            raise RuntimeError("Dispatch did not start a new Hwp.exe (attached to an existing instance?); stopped without Quit")
        hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        hwp.XHwpWindows.Item(0).Visible = False
        try:
            result["hancom_version"] = str(hwp.Version)
        except Exception:
            pass
        BUILDERS[name](hwp)
        if not hwp.SaveAs(str(out), "HWPX", ""):
            raise RuntimeError("SaveAs returned False")
        hwp.Clear(1)
        scrub_metadata(out)
        result["reopen_ok"] = bool(hwp.Open(str(out), "HWPX", "forceopen:true"))
        result["page_count"] = hwp.PageCount
        if name == "field-states":
            result["reopen_field_list"] = (hwp.GetFieldList(0, 0) or "").split("\x02")
            result["reopen_field_text"] = {n: hwp.GetFieldText(n) for n in ("성명", "소속")}
        hwp.Clear(1)
        result["ok"] = result["reopen_ok"]
        if not result["reopen_ok"]:
            result["error"] = "reopen failed"
    except Exception as e:
        result["error"] = scrub_text(repr(e))
    finally:
        if owned:
            try:
                hwp.Quit()
            except Exception as e:
                result["quit_error"] = scrub_text(repr(e))
        time.sleep(1)
        left = hwp_pids() - protect
        kill_pids(left)
        result["killed_leftover_pids"] = len(left)
    sys.stdout.reconfigure(encoding="utf-8")
    print("RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)


# ----------------------------------------------------------------------------
# 분석: ZIP·구역 XML 수치와 관측
# ----------------------------------------------------------------------------
def render_t(t):
    """hp:t 의 글. 탭은 \\t, 줄바꿈은 \\n, 그 밖의 표지 요소는 글자 없이 건너뛴다."""
    s = t.text or ""
    for c in t:
        n = local(c)
        s += "\t" if n == "tab" else "\n" if n == "lineBreak" else ""
        s += c.tail or ""
    return s


def bold_map(zf):
    root = ET.fromstring(zf.read("Contents/header.xml"))
    return {cp.get("id"): cp.find(q("hh", "bold")) is not None for cp in root.iter(q("hh", "charPr"))}


def para_desc(p, bolds):
    """문단의 run 별 내용. 글은 문자열, 글이 아닌 요소는 {"el": 요소이름} 으로 적는다(secPr·colPr 은 생략)."""
    runs, text = [], ""
    for r in p.findall(q("hp", "run")):
        content = []
        for c in r:
            n = local(c)
            if n == "t":
                content.append(render_t(c))
                text += content[-1]
            elif n == "ctrl":
                content.extend({"el": local(k)} for k in c if local(k) != "colPr")
            elif n != "secPr":
                content.append({"el": n})
        runs.append({"charPrIDRef": r.get("charPrIDRef"), "bold": bolds.get(r.get("charPrIDRef")), "content": content})
    return {"text": text, "runs": runs}


def own_paragraph_texts(p):
    """문단 p 에 직접 속한 hp:t 글(중첩된 표·머리말 안의 문단은 제외)."""
    return [render_t(t) for r in p.findall(q("hp", "run")) for t in r.findall(q("hp", "t"))]


def token_report(root, token):
    pieces = []
    in_single = False
    for p in root.iter(q("hp", "p")):
        ts = own_paragraph_texts(p)
        if token in "".join(ts):
            pieces.append(ts)
            in_single = in_single or any(token in t for t in ts)
    return {"in_single_t": in_single, "paragraphs_t_texts": pieces}


def charpr_info(zf, ids):
    root = ET.fromstring(zf.read("Contents/header.xml"))
    return {
        cp.get("id"): {"textColor": cp.get("textColor"), "children": [local(c) for c in cp]}
        for cp in root.iter(q("hh", "charPr"))
        if cp.get("id") in ids
    }


def field_report(root, zf):
    parent = {c: p for p in root.iter() for c in p}
    fields, open_ = [], {}
    for el in root.iter():
        n = local(el)
        if n == "fieldBegin":
            params = {pr.get("name"): (pr.text or "") for pr in el.iter() if local(pr) in ("stringParam", "integerParam")}
            rec = {
                "name": el.get("name"),
                "type": el.get("type"),
                "dirty": el.get("dirty"),
                "editable": el.get("editable"),
                "params": params,
                "t_between": [],
            }
            fields.append(rec)
            open_[el.get("id")] = rec
        elif n == "t":
            run = parent.get(el)
            for rec in open_.values():
                rec["t_between"].append({"text": render_t(el), "charPrIDRef": run.get("charPrIDRef") if run is not None else None})
        elif n == "fieldEnd":
            open_.pop(el.get("beginIDRef"), None)
    used = {t["charPrIDRef"] for rec in fields for t in rec["t_between"]}
    info = charpr_info(zf, used)
    for rec in fields:
        for t in rec["t_between"]:
            t["charPr"] = info.get(t["charPrIDRef"])
        rec["has_t_between"] = any(t["text"] != "" for t in rec["t_between"])
        rec["has_t_element_between"] = len(rec["t_between"]) > 0
    return fields


def table_report(root, bolds):
    tables = []
    for tbl in root.iter(q("hp", "tbl")):
        cells = []
        for tc in tbl.iter(q("hp", "tc")):
            addr = tc.find(q("hp", "cellAddr"))
            cells.append(
                {
                    "row": int(addr.get("rowAddr")),
                    "col": int(addr.get("colAddr")),
                    "header": tc.get("header"),
                    "paragraphs": [para_desc(p, bolds) for p in tc.iter(q("hp", "p"))],
                }
            )
        tables.append({"rowCnt": tbl.get("rowCnt"), "colCnt": tbl.get("colCnt"), "cells": cells})
    return tables


def header_footer_report(root, bolds):
    res = []
    for kind in ("header", "footer"):
        for el in root.iter(q("hp", kind)):
            res.append({"kind": kind, "applyPageType": el.get("applyPageType"), "paragraphs": [para_desc(p, bolds) for p in el.iter(q("hp", "p"))]})
    return res


def picture_report(root, zf):
    hpf = ET.fromstring(zf.read("Contents/content.hpf"))
    items = [dict(i.attrib) for i in hpf.iter(q("opf", "item")) if i.get("href", "").startswith("BinData/")]
    pics = []
    for pic in root.iter(q("hp", "pic")):
        img = pic.find(q("hc", "img"))
        sz, org, pos = pic.find(q("hp", "sz")), pic.find(q("hp", "orgSz")), pic.find(q("hp", "pos"))
        pics.append(
            {
                "binaryItemIDRef": img.get("binaryItemIDRef") if img is not None else None,
                "sz": dict(sz.attrib) if sz is not None else None,
                "orgSz": dict(org.attrib) if org is not None else None,
                "treatAsChar": pos.get("treatAsChar") if pos is not None else None,
                "shapeComment": [l for l in (pic.findtext(q("hp", "shapeComment")) or "").splitlines() if l.strip()],
            }
        )
    return {"content_hpf_bindata_items": items, "pics": pics}


EXPECTED = {
    "ph-single": ["{{project.name}}", "{{project.start}}", "{{project.end}}"],
    "ph-mixed": ["{{project.name}}", "{{company.name}}", "{{manager.name}}", "{{manager.phone}}"],
    "ph-table": ["신청서", "성명", "{{applicant.name}}", "연락처", "비고", "{{note}}", "위와 같이 신청합니다."],
    "field-states": ["성명: ", "소속: ", "확인자 성명: ", "합성기관", "이름을 입력", "소속 입력"],
    "picture": ["그림 앞 문단", "그림 뒤 문단"],
    "blocks": ["1. 개요", "개요 본문입니다.", "2. 선택 조항", "선택 조항 본문입니다. (해당 시)", "구분", "내용", "비고", "A", "가", "B", "나", "3. 끝"],
    "header-footer": ["{{doc.title}}", "{{doc.owner}}", "본문 첫째 문단", "본문 둘째 문단"],
    "tables-merged": ["병합 표", "신청 내역", "비고", "가", "A", "세로", "나", "B", "다", "C", "c", "끝"],
    "tables-inline": ["앞 문단", "항목", "내용", "비고", "a", "b", "c", "뒤 문단"],
    "tables-nested": ["중첩 표", "바깥1", "바깥3", "바깥4", "안1", "안2", "안3", "안4", "끝"],
    "tables-rich": ["풍부한 표", "번호", "이름", "내용", "1", "2", "둘째", "끝"],
}
# 의도한 글과 정확히 같은지(공백 포함) 비교하는 기준. 한컴이 입력 중에 글을 고치는 경우를 잡으려는 것이다.
EXPECTED_TOP = {  # 구역 바로 아래 문단들의 글(표·그림·머리말·꼬리말이 든 문단은 자기 글이 없으므로 "")
    "ph-single": ["합성 시험 문서 (단일 서식)", "사업명: {{project.name}} 입니다.", "기간: {{project.start}} ~ {{project.end}}"],
    "ph-mixed": ["사업명: {{project.name}}", "회사명: {{company.name}}", "담당: {{manager.name}}\t{{manager.phone}}"],
    "ph-table": ["신청서", "", "위와 같이 신청합니다."],
    "field-states": ["성명: 이름을 입력", "소속: 합성기관", "확인자 성명: 이름을 입력"],
    "picture": ["그림 앞 문단", "", "그림 뒤 문단"],
    "blocks": ["1. 개요", "개요 본문입니다.", "2. 선택 조항", "선택 조항 본문입니다. (해당 시)", "", "3. 끝"],
    "header-footer": ["본문 첫째 문단", "본문 둘째 문단"],
    "tables-merged": ["병합 표", "", "끝"],
    "tables-inline": ["앞 문단", "", "뒤 문단"],
    "tables-nested": ["중첩 표", "", "끝"],
    "tables-rich": ["풍부한 표", "", "끝"],
}
EXPECTED_CELLS = {  # (행, 열) -> 글
    "ph-table": {(0, 0): "성명", (0, 1): "{{applicant.name}}", (1, 0): "연락처", (1, 1): "", (2, 0): "비고", (2, 1): "{{note}}"},
    "blocks": {(0, 0): "구분", (0, 1): "내용", (0, 2): "비고", (1, 0): "A", (1, 1): "가", (1, 2): "-", (2, 0): "B", (2, 1): "나", (2, 2): "-"},
    # 병합 셀은 왼쪽 위 주소 하나만 있다: (0,0)은 A1·B1, (1,2)는 C2·C3을 덮는다
    "tables-merged": {(0, 0): "신청 내역", (0, 2): "비고", (1, 0): "가", (1, 1): "A", (1, 2): "세로", (2, 0): "나", (2, 1): "B", (3, 0): "다", (3, 1): "C", (3, 2): "c"},
    "tables-inline": {(0, 0): "항목", (0, 1): "내용", (0, 2): "비고", (1, 0): "a", (1, 1): "b", (1, 2): "c"},
}
EXPECTED_HF = {"header-footer": {"header": ["{{doc.title}}"], "footer": ["{{doc.owner}}"]}}
TOKENS = {
    "ph-single": ["{{project.name}}", "{{project.start}}", "{{project.end}}"],
    "ph-mixed": ["{{project.name}}", "{{company.name}}", "{{manager.name}}", "{{manager.phone}}"],
    "ph-table": ["{{applicant.name}}", "{{note}}"],
    "header-footer": ["{{doc.title}}", "{{doc.owner}}"],
}


def analyze(name, path):
    data = path.read_bytes()
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        raw = zf.read("Contents/section0.xml")
        bolds = bold_map(zf)
        root = ET.fromstring(raw)
        text = raw.decode("utf-8")
        private = private_strings()
        privacy_clean = all(
            s.encode("utf-8") not in zf.read(n) and s.encode("utf-16le") not in zf.read(n) for n in names for s in private
        )
        count = lambda tag: sum(1 for _ in root.iter(q("hp", tag)))
        all_paras = list(root.iter(q("hp", "p")))
        joined = ["".join(own_paragraph_texts(p)) for p in all_paras]
        entry = {
            "file": path.name,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "zip_entries": names,
            "bindata_entries": [n for n in names if n.startswith("BinData/")],
            "section0": {
                "paragraphs": len(re.findall(r"<hp:p[ >]", text)),
                "top_level_paragraphs": sum(1 for c in root if local(c) == "p"),
                "runs": count("run"),
                "text_nodes": count("t"),
                "field_begin": count("fieldBegin"),
                "field_end": count("fieldEnd"),
                "tables": count("tbl"),
                "pictures": count("pic"),
                "tabs": count("tab"),
                "headers": count("header"),
                "footers": count("footer"),
            },
            "text_checks": {
                s: {"in_raw_section_xml": s in text, "in_joined_paragraph_text": any(s in j for j in joined)} for s in EXPECTED[name]
            },
            "top_level_paragraphs_detail": [para_desc(p, bolds) for p in root if local(p) == "p"],
            "privacy_clean": privacy_clean,
        }
        obs = {}
        if name in TOKENS:
            obs["placeholders"] = {t: token_report(root, t) for t in TOKENS[name]}
        if name == "ph-mixed":
            obs["summary"] = {
                "{{project.name}}": "한 hp:t 안에 통째로 있음" if obs["placeholders"]["{{project.name}}"]["in_single_t"] else "여러 hp:t 로 쪼개짐",
                "{{company.name}}": "한 hp:t 안에 통째로 있음" if obs["placeholders"]["{{company.name}}"]["in_single_t"] else "여러 hp:t 로 쪼개짐",
                "{{manager.name}}{탭}{{manager.phone}}": "탭은 hp:t 안의 hp:tab 요소" if entry["section0"]["tabs"] else "탭 요소 없음",
            }
        if name == "field-states":
            obs["fields"] = field_report(root, zf)
        if name in ("ph-table", "blocks") or name in EXPECTED_CELLS:
            obs["tables"] = table_report(root, bolds)
        if name == "header-footer":
            obs["header_footer"] = header_footer_report(root, bolds)
        if name == "picture":
            obs.update(picture_report(root, zf))
        entry["observations"] = obs
        mismatches = []
        top = [para_desc(p, bolds)["text"] for p in root if local(p) == "p"]
        if top != EXPECTED_TOP[name]:
            mismatches.append({"what": "top_level_paragraph_texts", "expected": EXPECTED_TOP[name], "actual": top})
        if name in EXPECTED_CELLS:
            cells = {(c["row"], c["col"]): "\n".join(p["text"] for p in c["paragraphs"]) for t in obs["tables"] for c in t["cells"]}
            if cells != EXPECTED_CELLS[name]:
                mismatches.append({"what": "table_cell_texts", "expected": {"%d,%d" % k: v for k, v in EXPECTED_CELLS[name].items()}, "actual": {"%d,%d" % k: v for k, v in cells.items()}})
        if name in EXPECTED_HF:
            hf = {}
            for rec in obs["header_footer"]:
                hf.setdefault(rec["kind"], []).extend(p["text"] for p in rec["paragraphs"])
            if hf != EXPECTED_HF[name]:
                mismatches.append({"what": "header_footer_texts", "expected": EXPECTED_HF[name], "actual": hf})
        entry["exact_text_mismatches"] = mismatches
    return entry


# ----------------------------------------------------------------------------
# 오케스트레이터
# ----------------------------------------------------------------------------
def run_one(name, before):
    cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", name, "--protect", ",".join(map(str, sorted(before)))]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        so, se = proc.communicate(timeout=DOC_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        time.sleep(1)
        kill_pids(hwp_pids() - before)
        proc.communicate()
        return {"name": name, "ok": False, "error": "timeout %ds (작업자와 새 Hwp.exe 를 종료함)" % DOC_TIMEOUT_SEC}
    for line in so.decode("utf-8", "replace").splitlines():
        if line.startswith("RESULT:"):
            return json.loads(line[len("RESULT:"):])
    return {"name": name, "ok": False, "error": "no RESULT; exit=%s; stderr=%s" % (proc.returncode, scrub_text(se.decode("utf-8", "replace")[-300:]))}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker")
    ap.add_argument("--protect", default="")
    ap.add_argument("--only", default="", help="쉼표로 나눈 문서 이름만 다시 만든다(다른 산출물과 manifest 항목은 그대로 둔다)")
    args = ap.parse_args()
    protect = {int(x) for x in args.protect.split(",") if x}
    if args.worker:
        return run_worker(args.worker, protect)

    OUT.mkdir(parents=True, exist_ok=True)
    before = hwp_pids()
    print("start: Hwp.exe 이미 떠 있던 프로세스 %d개(건드리지 않음)" % len(before))
    only = [x for x in args.only.split(",") if x]
    for name in only:
        if name not in BUILDERS:
            ap.error("알 수 없는 문서: %s" % name)
    manifest = {"generator": "tools/com/make_fixtures.py", "hancom_version": None, "documents": [], "failures": []}
    for name in only or DOCS:
        f = OUT / (name + ".hwpx")
        if f.exists():
            f.unlink()
        t0 = time.time()
        res = run_one(name, before)
        sec = round(time.time() - t0, 1)
        if res.get("hancom_version"):
            manifest["hancom_version"] = res["hancom_version"]
        if not res.get("ok") or not f.exists():
            if f.exists():
                f.unlink()
            manifest["failures"].append({"file": name + ".hwpx", "error": res.get("error", "unknown")})
            print("FAIL %-14s %5.1fs  %s" % (name, sec, res.get("error")))
            continue
        entry = analyze(name, f)
        if entry["exact_text_mismatches"]:
            f.unlink()
            manifest["failures"].append({"file": name + ".hwpx", "error": "text mismatch", "detail": entry["exact_text_mismatches"]})
            print("FAIL %-14s 의도한 글과 다름: %s" % (name, json.dumps(entry["exact_text_mismatches"], ensure_ascii=False)))
            continue
        entry["reopen"] = {"ok": res["reopen_ok"], "page_count": res["page_count"]}
        for k in ("reopen_field_list", "reopen_field_text"):
            if k in res:
                entry["reopen"][k[len("reopen_"):]] = res[k]
        manifest["documents"].append(entry)
        print("ok   %-14s %5.1fs  pages=%s bytes=%d" % (name, sec, res["page_count"], entry["bytes"]))
    left = hwp_pids() - before
    kill_pids(left)
    manifest["hwp_processes_left_by_this_run"] = len(left)
    if only and (OUT / "manifest.json").exists():
        # 일부만 다시 만들었으면 이번 항목을 기존 manifest 에 합친다(다른 문서의 항목은 그대로)
        old = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
        kept = [d for d in old.get("documents", []) if d["file"][: -len(".hwpx")] not in only]
        manifest["documents"] = kept + manifest["documents"]
        manifest["hancom_version"] = manifest["hancom_version"] or old.get("hancom_version")
    manifest["privacy_clean"] = all(d["privacy_clean"] for d in manifest["documents"])
    manifest["note"] = "content.hpf 의 creator·lastsaveby(작성 PC 사용자 이름)만 'synthetic' 으로 바꿔 다시 묶었다. 그 밖은 한컴이 저장한 그대로다."
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("manifest: %d개 문서, 실패 %d개, 남은 Hwp.exe %d개" % (len(manifest["documents"]), len(manifest["failures"]), len(left)))
    return 0 if not manifest["failures"] else 1


if __name__ == "__main__":
    sys.exit(main())
