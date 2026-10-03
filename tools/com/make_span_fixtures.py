# 여러 문단에 걸친 누름틀을 한컴 오피스(한글) COM 으로 만들고, 같은 한컴으로 값을 넣어 저장한 "정답" 문서를 만든다.
# 실행: python tools/com/make_span_fixtures.py [--only 이름,이름]   (한컴 오피스가 설치된 Windows, pywin32 필요)
#
# 만드는 것(tools/com/out/):
#   field-span.hwpx          본문에서 세 문단에 걸친 누름틀 `성명`(누름틀 안에서 Enter 를 친 서식)
#   field-span-table.hwpx    문단·표 문단·문단을 블록으로 잡고 누름틀을 만든 것(사이에 표가 든 누름틀 `성명`)
#   field-span-cell.hwpx     표 칸 안에서 두 문단에 걸친 누름틀 `칸`
#   *-filled.hwpx            위 문서를 한컴이 열어 PutFieldText 로 값을 넣고 저장한 것(엔진 결과의 정답지)
#   inline-breaks-filled.hwpx  packages/.../fixtures/inline/inline-breaks.hwpx 의 누름틀 `줄`·`탭`을 한컴이 다시 채운 것
# 규칙은 make_fixtures.py 와 같다: 문서 하나씩 작업자 프로세스(60초 한도), 한컴 창 숨김, Quit, 떠 있던 Hwp.exe 불간섭,
# 작성자·최종 저장자는 synthetic 으로.
import argparse
import json
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import make_fixtures as mf

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
INLINE_SRC = HERE.parent.parent / "packages" / "hwpx-engine" / "test" / "fixtures" / "inline" / "inline-breaks.hwpx"

VALUES = {"성명": "새 값", "칸": "새 칸 값", "줄": "다시 넣은 값", "탭": "탭 다시"}


def build_field_span(hwp):
    mf.ins(hwp, "앞 문단")
    mf.newline(hwp)
    mf.ins(hwp, "성명: ")
    hwp.CreateField("이름을 입력", "", "성명")
    mf.ins(hwp, "첫 문단")
    mf.newline(hwp)  # 누름틀 안에서 Enter
    mf.ins(hwp, "가운데 문단")
    mf.newline(hwp)
    mf.ins(hwp, "끝 문단")
    hwp.HAction.Run("MoveLineEnd")  # 누름틀 밖으로
    mf.ins(hwp, " 끝 뒤 글")
    mf.newline(hwp)
    mf.ins(hwp, "뒤 문단")


def build_field_span_table(hwp):
    # 문단 0 "앞 문단", 1 "첫 문단", 2 표 문단, 3 "끝 문단 끝 뒤 글", 4 "뒤 문단". 1~3 을 블록으로 잡고 누름틀을 만든다.
    mf.ins(hwp, "앞 문단")
    mf.newline(hwp)
    mf.ins(hwp, "첫 문단")
    mf.newline(hwp)
    mf.table_create(hwp, 1, 2)
    mf.type_cells(hwp, ["칸1", "칸2"])
    hwp.HAction.Run("MoveDocEnd")
    mf.ins(hwp, "끝 문단 끝 뒤 글")
    mf.newline(hwp)
    mf.ins(hwp, "뒤 문단")
    if not hwp.SelectText(1, 0, 3, len("끝 문단")):
        raise RuntimeError("SelectText failed")
    hwp.CreateField("이름을 입력", "", "성명")
    hwp.HAction.Run("Cancel")


def build_field_span_cell(hwp):
    mf.ins(hwp, "표 앞")
    mf.newline(hwp)
    mf.table_create(hwp, 1, 2)
    mf.ins(hwp, "칸: ")
    hwp.CreateField("칸 안내", "", "칸")
    mf.ins(hwp, "칸 첫 문단")
    mf.newline(hwp)
    mf.ins(hwp, "칸 둘째 문단")
    hwp.HAction.Run("MoveLineEnd")
    hwp.HAction.Run("TableRightCell")
    mf.ins(hwp, "옆 칸")
    hwp.HAction.Run("MoveDocEnd")
    mf.ins(hwp, "표 뒤")


BUILDERS = {"field-span": build_field_span, "field-span-table": build_field_span_table, "field-span-cell": build_field_span_cell}
# 채움 작업: 이름 -> (원본 파일, 넣을 누름틀 이름들)
FILLS = {
    "field-span-filled": ("field-span.hwpx", ["성명"]),
    "field-span-table-filled": ("field-span-table.hwpx", ["성명"]),
    "field-span-cell-filled": ("field-span-cell.hwpx", ["칸"]),
    "inline-breaks-filled": ("inline-breaks.hwpx", ["줄", "탭"]),
}
ORDER = ["field-span", "field-span-table", "field-span-cell", "field-span-filled", "field-span-table-filled", "field-span-cell-filled", "inline-breaks-filled"]


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
        if name in BUILDERS:
            BUILDERS[name](hwp)
            fields = []
        else:
            src_name, fields = FILLS[name]
            src = OUT / src_name
            if not src.exists():
                raise RuntimeError("source missing: " + src_name)
            if not hwp.Open(str(src), "HWPX", "forceopen:true"):
                raise RuntimeError("Open failed: " + src_name)
            result["before_field_text"] = {n: hwp.GetFieldText(n) for n in fields}
            for n in fields:
                hwp.PutFieldText(n, VALUES[n])
        if not hwp.SaveAs(str(out), "HWPX", ""):
            raise RuntimeError("SaveAs returned False")
        hwp.Clear(1)
        mf.scrub_metadata(out)
        result["reopen_ok"] = bool(hwp.Open(str(out), "HWPX", "forceopen:true"))
        result["page_count"] = hwp.PageCount
        result["reopen_field_list"] = (hwp.GetFieldList(0, 0) or "").split("\x02")
        names = fields or [f for f in result["reopen_field_list"] if f]
        result["reopen_field_text"] = {n: hwp.GetFieldText(n) for n in names}
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


def span_report(path):
    """누름틀마다 시작·끝 표식이 몇 번째 문단(문서 순서, 중첩 포함)에 있는지와 사이에 표 문단이 있는지."""
    with zipfile.ZipFile(path) as zf:
        root = ET.fromstring(zf.read("Contents/section0.xml"))
    parent = {c: p for p in root.iter() for c in p}

    def owner_p(el):
        cur = parent.get(el)
        while cur is not None and mf.local(cur) != "p":
            cur = parent.get(cur)
        return cur

    paras = [p for p in root.iter(mf.q("hp", "p"))]
    index = {p: i for i, p in enumerate(paras)}
    texts = ["".join(mf.own_paragraph_texts(p)) for p in paras]
    begins = {}
    out = []
    for el in root.iter():
        n = mf.local(el)
        if n == "fieldBegin":
            begins[el.get("id")] = el
        elif n == "fieldEnd":
            b = begins.get(el.get("beginIDRef"))
            if b is None:
                continue
            pb, pe = owner_p(b), owner_p(el)
            ib, ie = index.get(pb), index.get(pe)
            between = paras[ib + 1 : ie] if ib is not None and ie is not None and ie > ib else []
            out.append(
                {
                    "name": b.get("name"),
                    "type": b.get("type"),
                    "dirty": b.get("dirty"),
                    "begin_paragraph": ib,
                    "end_paragraph": ie,
                    "paragraphs_between": len(between),
                    "tables_between": sum(1 for p in between for _ in p.iter(mf.q("hp", "tbl"))),
                    "same_parent": parent.get(pb) is parent.get(pe),
                }
            )
    return {"paragraphs": len(paras), "top_level_paragraphs": sum(1 for c in root if mf.local(c) == "p"), "tables": sum(1 for _ in root.iter(mf.q("hp", "tbl"))), "texts": texts, "fields": out}


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
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    protect = {int(x) for x in args.protect.split(",") if x}
    if args.worker:
        return run_worker(args.worker, protect)
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(INLINE_SRC, OUT / "inline-breaks.hwpx")
    before = mf.hwp_pids()
    print("start: Hwp.exe 이미 떠 있던 프로세스 %d개(건드리지 않음)" % len(before))
    only = [x for x in args.only.split(",") if x]
    failures = 0
    report = {}
    for name in only or ORDER:
        t0 = time.time()
        res = run_one(name, before)
        sec = round(time.time() - t0, 1)
        f = OUT / (name + ".hwpx")
        if not res.get("ok") or not f.exists():
            failures += 1
            print("FAIL %-24s %5.1fs  %s" % (name, sec, res.get("error")))
            continue
        rep = span_report(f)
        report[name] = {"reopen": {k: v for k, v in res.items() if k.startswith("reopen") or k in ("page_count", "before_field_text")}, "structure": rep}
        print("ok   %-24s %5.1fs  pages=%s paras=%d tables=%d fields=%s" % (name, sec, res["page_count"], rep["paragraphs"], rep["tables"], json.dumps(rep["fields"], ensure_ascii=False)))
    (OUT / "span-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    left = mf.hwp_pids() - before
    mf.kill_pids(left)
    print("done: 실패 %d개, 남은 Hwp.exe %d개" % (failures, len(left)))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
