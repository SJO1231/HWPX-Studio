# 한컴 메일 머지 필드(fieldBegin type="MAILMERGE")가 든 합성 서식을 한컴 오피스(한글) COM 으로 만든다.
# 실행: python tools/com/make_merge_fixtures.py   (한컴 오피스가 설치된 Windows, pywin32 필요)
#
# 만드는 것(tools/com/out/):
#   merge-fields.hwpx   메일 머지 필드(MAILMERGE) 30개 이상, 누름틀(CLICK_HERE)과 `{{경로}}` 자리 10개 이상이 한 문서에 든 합성 공고서 서식.
#                       메일 머지 필드는 본문 문단·표 칸·머리말·꼬리말에 흩어져 있고 같은 키가 여러 번 나오며, 경로 꼴이 아닌 키(공백·괄호)도 있다.
#                       필드는 한컴의 `MailMergeInsert` 동작(FieldCtrl.Command = 키)으로 넣었다. type 을 고쳐 쓰지 않았다.
#                       한컴은 필드 안의 글(표시 글)을 편집하지 못하므로(필드가 한 글자처럼 다뤄진다), 표시 글이 `{{키}}`가 아닌 안내 글 꼴인 필드는
#                       한컴이 저장한 뒤 그 `hp:t` 의 글만 XML 로 바꿔 만든다(필드 몇 개마다 하나. 다시 채운 문서의 꼴이다). 바꾼 문서를 한컴으로 다시 열어 쪽 수를 읽는다.
#   merge-report.json   문서의 구조 수치와 필드 관측(type·name·dirty·editable·매개변수·키·표시 글)
# 한컴의 메일 머지 만들기(도구 - 메일 머지 - 만들기)는 쓰지 않는다. 제품은 XML 처리만 하고 한컴 메일 머지에 기대지 않는다.
# 규칙은 make_fixtures.py 와 같다: 문서 하나씩 작업자 프로세스(60초 한도), 한컴 창 숨김, Quit, 떠 있던 Hwp.exe 불간섭,
# 작성자·최종 저장자는 synthetic 으로.
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path

import make_fixtures as mf

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
ORDER = ["merge-fields"]

# ---- 문서 명세 -------------------------------------------------------------
# 조각: ("t", 글) / ("mm", 키) 메일 머지 필드 / ("mmb", 키) 표시 글을 굵게 한 메일 머지 필드(문단 끝에만) / ("ck", 이름, 안내문) 누름틀(문단·칸 끝에만)
T = lambda s: ("t", s)
M = lambda key: ("mm", key)
MB = lambda key: ("mmb", key)
C = lambda name, guide: ("ck", name, guide)

HEADER = [T("공고번호: "), M("공고번호"), T(" / "), M("사업명")]
FOOTER = [T("기관: "), M("기관명"), T(" / 담당 "), M("담당자"), T(" "), M("연락처")]
BODY = [
    ("p", [T("합성 공고서 서식 (시험용)")]),
    ("p", [T("사업명: "), M("사업명"), T(" 입니다.")]),
    ("p", [T("기관 "), M("기관명"), T(" 은(는) "), M("사업명"), T(" 을(를) 공고합니다.")]),
    ("p", [T("공고번호 "), M("공고번호"), T(", 시행일 "), M("시행일"), T(", 접수기간 "), M("접수기간"), T(".")]),
    ("p", [T("굵게: "), MB("추정가격")]),
    ("p", [T("담당: "), M("담당자"), T(" ("), M("연락처"), T(") 비고 "), M("참고 사항"), T(".")]),
    ("p", [T("계약방법 "), M("계약 방법(수의)"), T(" 이며 장소는 "), M("장소"), T(" 입니다.")]),
    ("p", [T("금액 "), M("추정가격"), T(" / 예정가격 "), M("예정가격"), T(" / 부가세 "), M("부가세"), T(".")]),
    ("p", [T("재공고 "), M("재공고"), T(" 사유 "), M("사유 설명"), T(".")]),
    ("p", [T("성명: "), C("성명", "이름을 입력")]),
    ("p", [T("소속: "), C("소속", "소속 입력")]),
    ("p", [T("{{project.name}} / {{project.start}} ~ {{project.end}}.")]),
    (
        "table",
        6,
        3,
        [
            [T("구분")], [T("내용")], [T("비고")],
            [T("사업명")], [M("사업명")], [M("공고번호")],
            [T("추정가격")], [M("추정가격")], [M("참고 사항")],
            [T("기간")], [M("접수기간")], [M("시행일")],
            [T("기관")], [M("기관명")], [M("담당자")],
            [T("연락처")], [M("연락처")], [M("장소")],
        ],
    ),
    ("p", [T("표 아래 문단. 담당 "), M("담당자"), T(" 확인.")]),
    ("p", [T("{{dates.start}} ~ {{dates.end}} ({{dates.days}}일).")]),
    (
        "table",
        4,
        2,
        [
            [T("이름")], [C("이름", "이름 입력")],
            [T("직위")], [C("직위", "직위 입력")],
            [T("연락처")], [T("{{manager.phone}}")],
            [T("메일")], [T("{{manager.email}}")],
        ],
    ),
    ("p", [T("끝.")]),
]
GUIDE_EVERY = 4  # 문서 순서로 셀 때 4번째마다 하나(1, 5, 9, ...번째)의 표시 글을 안내 글 꼴로 바꾼다
GUIDE_TEXTS = ["(입력 전)", "예전 값 123", "2024-01-01", "미정", "[   ]", "해당 없음", "00,000,000", "홍길동"]


def segs_text(segs):
    return "".join(s[1] if s[0] == "t" else ("{{%s}}" % s[1] if s[0] in ("mm", "mmb") else s[2]) for s in segs)


def spec_keys():
    keys = [s[1] for segs in [HEADER, FOOTER] + [i[1] if i[0] == "p" else None for i in BODY] if segs for s in segs if s[0] in ("mm", "mmb")]
    for item in BODY:
        if item[0] == "table":
            keys += [s[1] for cell in item[3] for s in cell if s[0] in ("mm", "mmb")]
    return keys


def is_path_key(key):
    return re.fullmatch(r"[\w-]+(\.[\w-]+)*", key) is not None


def mail_merge_field(hwp, key):
    """한컴의 메일 머지 필드 넣기(`MailMergeInsert`): 커서 자리에 `{{키}}` 표시의 필드를 만든다."""
    ps = hwp.HParameterSet.HFieldCtrl
    hwp.HAction.GetDefault("MailMergeInsert", ps.HSet)
    ps.Command = key
    if not hwp.HAction.Execute("MailMergeInsert", ps.HSet):
        raise RuntimeError("MailMergeInsert failed: " + key)


def write_segments(hwp, segs):
    for seg in segs:
        kind = seg[0]
        if kind == "t":
            mf.ins(hwp, seg[1])
        elif kind == "mm":
            mail_merge_field(hwp, seg[1])
        elif kind == "mmb":
            mail_merge_field(hwp, seg[1])
            hwp.HAction.Run("MoveSelLeft")  # 방금 넣은 필드 하나(한컴은 필드를 한 글자처럼 다룬다)를 잡아
            mf.set_bold(hwp, True)  # 표시 글을 굵게 한다
            hwp.HAction.Run("Cancel")
            hwp.HAction.Run("MoveLineEnd")
            mf.set_bold(hwp, False)
        elif kind == "ck":
            hwp.CreateField(seg[2], "", seg[1])
            hwp.HAction.Run("MoveLineEnd")  # CreateField 뒤 캐럿은 누름틀 안에 있어 줄 끝으로 나온다
        else:
            raise RuntimeError("unknown segment " + kind)


def build_merge_fields(hwp):
    after_table = False
    for n, item in enumerate(BODY):
        if item[0] == "p":
            if n > 0 and not after_table:
                mf.newline(hwp)
            write_segments(hwp, item[1])
            after_table = False
        else:
            _, rows, cols, cells = item
            mf.newline(hwp)
            mf.table_create(hwp, rows, cols)
            for i, cell in enumerate(cells):
                write_segments(hwp, cell)
                if i < len(cells) - 1:
                    hwp.HAction.Run("TableRightCell")
            hwp.HAction.Run("MoveDocEnd")  # 표 뒤 문단으로 나와 이어 쓴다
            after_table = True
    # 머리말: HeaderFooter 동작이 머리말을 만들고 편집 상태로 들어간다(make_fixtures.build_header_footer 와 같은 방식).
    hwp.HAction.Run("MoveDocBegin")
    ps = hwp.HParameterSet.HHeaderFooter
    hwp.HAction.GetDefault("HeaderFooter", ps.HSet)
    ps.HSet.SetItem("Type", 0)
    if not hwp.HAction.Execute("HeaderFooter", ps.HSet):
        raise RuntimeError("HeaderFooter failed")
    write_segments(hwp, HEADER)
    hwp.HAction.Run("CloseEx")
    # 꼬리말: InsertCtrl("foot") 으로 만든 뒤 꼬리말의 리스트로 캐럿을 옮긴다.
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
    write_segments(hwp, FOOTER)
    hwp.SetPos(0, 0, 0)


def rewrite_entry(path, entry, change):
    """ZIP 의 한 항목 바이트만 바꿔 다시 묶는다(항목 순서·압축 방식·시각 유지)."""
    with zipfile.ZipFile(path) as zin:
        items = [(i, zin.read(i.filename)) for i in zin.infolist()]
    tmp = Path(str(path) + ".tmp")
    with zipfile.ZipFile(tmp, "w") as zout:
        for info, data in items:
            if info.filename == entry:
                data = change(data)
            zi = zipfile.ZipInfo(info.filename, info.date_time)
            zi.compress_type = info.compress_type
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    os.replace(tmp, path)


def apply_guides(data):
    """문서 순서로 센 메일 머지 필드 가운데 1, 5, 9, ...번째의 표시 글(`{{키}}`)을 안내 글로 바꾼다."""
    pat = re.compile(r'(<hp:fieldBegin[^>]*type="MAILMERGE"[^>]*>.*?</hp:fieldBegin></hp:ctrl>)<hp:t>(\{\{[^<]*\}\})</hp:t>', re.S)
    counter = {"i": -1, "guided": 0}

    def sub(m):
        counter["i"] += 1
        if counter["i"] % GUIDE_EVERY != 1:
            return m.group(0)
        guide = GUIDE_TEXTS[counter["guided"] % len(GUIDE_TEXTS)]
        counter["guided"] += 1
        return m.group(1) + "<hp:t>" + guide + "</hp:t>"

    out = pat.sub(sub, data.decode("utf-8"))
    if counter["guided"] == 0:
        raise RuntimeError("no guide replaced")
    return out.encode("utf-8")


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
            if mf.hwp_pids() - protect:
                owned = True
                break
            time.sleep(0.5)
        if not owned:
            raise RuntimeError("Dispatch did not start a new Hwp.exe; stopped without Quit")
        hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        hwp.XHwpWindows.Item(0).Visible = False
        try:
            result["hancom_version"] = str(hwp.Version)
        except Exception:
            pass
        build_merge_fields(hwp)
        if not hwp.SaveAs(str(out), "HWPX", ""):
            raise RuntimeError("SaveAs returned False")
        hwp.Clear(1)
        rewrite_entry(out, "Contents/section0.xml", apply_guides)
        mf.scrub_metadata(out)
        result["reopen_ok"] = bool(hwp.Open(str(out), "HWPX", "forceopen:true"))
        result["page_count"] = hwp.PageCount
        hwp.Clear(1)
        result["ok"] = result["reopen_ok"]
    except Exception as e:
        result["error"] = mf.scrub_text(repr(e))
    finally:
        if owned:
            try:
                hwp.Quit()
            except Exception as e:
                result["quit_error"] = mf.scrub_text(repr(e))
        time.sleep(1)
        left = mf.hwp_pids() - protect
        mf.kill_pids(left)
        result["killed_leftover_pids"] = len(left)
    sys.stdout.reconfigure(encoding="utf-8")
    print("RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)


def field_records(root):
    """필드마다 type·name·dirty·editable, 매개변수 이름→값, 키(FieldValue), 표시 글, 자리(body·header·footer)를 문서 순서로."""
    parent = {c: p for p in root.iter() for c in p}

    def area(el):
        cur = parent.get(el)
        while cur is not None:
            n = mf.local(cur)
            if n in ("header", "footer"):
                return n
            cur = parent.get(cur)
        return "body"

    fields, open_ = [], {}
    for el in root.iter():
        n = mf.local(el)
        if n == "fieldBegin":
            params = {pr.get("name"): (pr.text or "") for pr in el.iter() if mf.local(pr) in ("stringParam", "integerParam", "booleanParam")}
            rec = {"type": el.get("type"), "name": el.get("name"), "dirty": el.get("dirty"), "editable": el.get("editable"), "params": params, "key": params.get("FieldValue"), "display": "", "area": area(el), "begin_run": parent[parent[el]].get("charPrIDRef")}
            fields.append(rec)
            open_[el.get("id")] = rec
        elif n == "t":
            for rec in open_.values():
                rec["display"] += mf.render_t(el)
        elif n == "fieldEnd":
            open_.pop(el.get("beginIDRef"), None)
    return fields


def analyze(path):
    data = path.read_bytes()
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        sections = [n for n in names if re.fullmatch(r"Contents/section\d+\.xml", n)]
        roots = {n: ET.fromstring(zf.read(n)) for n in sections}
        root = roots["Contents/section0.xml"]
        private = mf.private_strings()
        privacy_clean = all(s.encode("utf-8") not in zf.read(n) and s.encode("utf-16le") not in zf.read(n) for n in names for s in private)
        top = ["".join(mf.own_paragraph_texts(p)) for p in root if mf.local(p) == "p"]
        tables = []
        for tbl in root.iter(mf.q("hp", "tbl")):
            cells = {}
            for tc in tbl.iter(mf.q("hp", "tc")):
                addr = tc.find(mf.q("hp", "cellAddr"))
                cells[(int(addr.get("rowAddr")), int(addr.get("colAddr")))] = "\n".join("".join(mf.own_paragraph_texts(p)) for p in tc.iter(mf.q("hp", "p")))
            tables.append(cells)
        fields = [f for n in sections for f in field_records(roots[n])]
        merge = [f for f in fields if f["type"] == "MAILMERGE"]
        guided = [f for f in merge if f["display"] != "{{%s}}" % f["key"]]
        # `{{경로}}` 자리: 명세의 글 조각(`t`)에 든 것만 센다(메일 머지 필드의 표시 글 `{{키}}`는 필드가 맡는다)
        all_segs = [s for item in BODY for s in (item[1] if item[0] == "p" else [x for cell in item[3] for x in cell])]
        placeholders = sum(len(re.findall(r"\{\{[\w.-]+\}\}", s[1])) for s in all_segs if s[0] == "t")
        entry = {
            "file": path.name,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "sections": len(sections),
            "top_level_paragraphs": len(top),
            "paragraph_texts": top,
            "tables": [{"rows": 1 + max(r for r, _ in c), "cols": 1 + max(k for _, k in c), "cell_texts": {"%d,%d" % rc: v for rc, v in sorted(c.items())}} for c in tables],
            "counts": {
                "mailmerge_fields": len(merge),
                "mailmerge_in_header": sum(1 for f in merge if f["area"] == "header"),
                "mailmerge_in_footer": sum(1 for f in merge if f["area"] == "footer"),
                "mailmerge_in_body": sum(1 for f in merge if f["area"] == "body"),
                "mailmerge_not_path_key": sum(1 for f in merge if not is_path_key(f["key"] or "")),
                "mailmerge_guide_display": len(guided),
                "click_here": sum(1 for f in fields if f["type"] == "CLICK_HERE"),
                "placeholders": placeholders,
            },
            "fields": fields,
            "privacy_clean": privacy_clean,
        }
        # 의도한 내용과 견준다: 본문 필드는 문서 순서로 명세의 조각과 짝지어 키·종류를 맞추고, 글은 표시 글(`{{키}}` 또는 안내 글)을 넣어 만든 기대와 같아야 한다.
        mismatches = []
        body = iter([f for f in fields if f["area"] == "body"])
        expected_top, expected_tables = [], []

        def text_of(segs):
            out = ""
            for s in segs:
                if s[0] == "t":
                    out += s[1]
                else:
                    rec = next(body, None)
                    want = ("MAILMERGE", s[1]) if s[0] in ("mm", "mmb") else ("CLICK_HERE", s[1])
                    if rec is None or (rec["type"], rec["key"] if rec["type"] == "MAILMERGE" else rec["name"]) != want:
                        mismatches.append({"what": "field_order", "expected": list(want), "actual": None if rec is None else [rec["type"], rec["key"] or rec["name"]]})
                        return out
                    out += rec["display"]
            return out

        for item in BODY:
            if item[0] == "p":
                expected_top.append(text_of(item[1]))
            else:
                expected_top.append("")
                cells = {}
                for i, cell in enumerate(item[3]):
                    cells[(i // item[2], i % item[2])] = text_of(cell)
                expected_tables.append(cells)
        if top != expected_top:
            mismatches.append({"what": "top_level_paragraph_texts", "expected": expected_top, "actual": top})
        if tables != expected_tables:
            mismatches.append({"what": "table_cell_texts"})
        hf = {"header": segs_text(HEADER), "footer": segs_text(FOOTER)}
        for area_name, segs in (("header", HEADER), ("footer", FOOTER)):
            keys = [f["key"] for f in merge if f["area"] == area_name]
            if keys != [s[1] for s in segs if s[0] == "mm"]:
                mismatches.append({"what": area_name + "_keys", "expected": [s[1] for s in segs if s[0] == "mm"], "actual": keys})
        if Counter(f["key"] for f in merge) != Counter(spec_keys()):
            mismatches.append({"what": "merge_keys"})
        c = entry["counts"]
        if c["mailmerge_fields"] < 30 or c["mailmerge_not_path_key"] < 2 or c["click_here"] + c["placeholders"] < 10 or c["mailmerge_in_header"] < 1 or c["mailmerge_in_footer"] < 1 or c["mailmerge_guide_display"] < 1:
            mismatches.append({"what": "scale", "counts": c})
        entry["exact_text_mismatches"] = mismatches
    return entry


def run_one(name, before):
    cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", name, "--protect", ",".join(map(str, sorted(before)))]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        so, se = proc.communicate(timeout=mf.DOC_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        time.sleep(1)
        mf.kill_pids(mf.hwp_pids() - before)
        proc.communicate()
        return {"name": name, "ok": False, "error": "timeout %ds" % mf.DOC_TIMEOUT_SEC}
    for line in so.decode("utf-8", "replace").splitlines():
        if line.startswith("RESULT:"):
            return json.loads(line[len("RESULT:"):])
    return {"name": name, "ok": False, "error": "no RESULT; exit=%s; stderr=%s" % (proc.returncode, mf.scrub_text(se.decode("utf-8", "replace")[-300:]))}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker")
    ap.add_argument("--protect", default="")
    args = ap.parse_args()
    protect = {int(x) for x in args.protect.split(",") if x}
    if args.worker:
        return run_worker(args.worker, protect)
    OUT.mkdir(parents=True, exist_ok=True)
    before = mf.hwp_pids()
    print("start: Hwp.exe 이미 떠 있던 프로세스 %d개(건드리지 않음)" % len(before))
    failures = 0
    report = {}
    for name in ORDER:
        t0 = time.time()
        res = run_one(name, before)
        sec = round(time.time() - t0, 1)
        f = OUT / (name + ".hwpx")
        if not res.get("ok") or not f.exists():
            failures += 1
            print("FAIL %-22s %5.1fs  %s" % (name, sec, res.get("error")))
            continue
        entry = analyze(f)
        if entry["exact_text_mismatches"]:
            failures += 1
            print("FAIL %-22s 의도한 내용과 다름: %s" % (name, json.dumps(entry["exact_text_mismatches"], ensure_ascii=False)[:1500]))
            continue
        report[name] = {"hancom_version": res.get("hancom_version"), "reopen": {"ok": res["reopen_ok"], "page_count": res["page_count"]}, "structure": entry}
        print("ok   %-22s %5.1fs  pages=%s top=%d tables=%d counts=%s" % (name, sec, res["page_count"], entry["top_level_paragraphs"], len(entry["tables"]), json.dumps(entry["counts"])))
    (OUT / "merge-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    left = mf.hwp_pids() - before
    mf.kill_pids(left)
    print("done: 실패 %d개, 남은 Hwp.exe %d개" % (failures, len(left)))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
