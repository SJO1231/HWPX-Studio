# 한컴 오피스(한글)를 COM 으로 띄워 HWPX 문서의 표 속성·셀 주소를 읽어 JSON 으로 낸다. PDF 로 저장하고 글 표지(marker)가 PDF 에 있는지도 본다.
# 실행: python tools/com/read_table.py --spec 명세.json --out 결과.json [--timeout 60]
#
# 명세 JSON
#   { "documents": [ { "name": "라벨", "file": "문서.hwpx", "pdf": "저장할.pdf"(선택), "markers": ["PDF 안에 있어야 하는 글", ...](선택) } ] }
#
# 결과 JSON: { "hancom_version", "results": [ { "name", "opened", "pages", "timeout", "error",
#     "tables": [ { "props": {...}, "cells": [ { "label": "A1", "col": 0, "row": 0, "list": 2 } ] } ],
#     "pdf": { "saved", "bytes", "pages", "chars", "markers": { 글: 있음 } } } ] }
#   - props 는 표 컨트롤의 속성을 한컴이 읽어 준 값 그대로다: Width·Height(HWPUNIT), TreatAsChar·RepeatHeader(0/1), CellSpacing, 바깥 여백,
#     안 여백(CellMarginLeft), PageBreak(한컴 코드: CELL 2, TABLE 1, NONE 0), HorzAlign(LEFT 0, CENTER 1, RIGHT 2). 코드 표는 엔진이 만든 변형을 열어 관측했다.
#     셀 단위 속성(세로 정렬·셀 여백)은 한컴 COM 으로 읽히지 않아(CellShape 가 표 속성을 돌려준다) 읽지 않는다.
#   - cells 는 한컴의 셀 리스트 순서이고 label 은 상태 표시줄의 셀 주소("(B3)")다. 병합 셀은 왼쪽 위 주소 하나만 있다.
#     표는 같은 표 컨트롤(ParentCtrl 의 인스턴스 id)에 속한 리스트끼리 묶고 중첩 표도 따로 나온다.
#   - 결과에는 파일 경로를 담지 않는다. PDF 글에서는 요청한 marker 가 있는지만 낸다.
#
# 구조는 read_shape.py·open_check.py 와 같다.
#   - 기본 실행(오케스트레이터)은 문서마다 이 파일을 `--worker` 로 다시 실행하고, 제한 시간(기본 60초) 안에 끝나지 않으면
#     그 작업자와 그것이 띄운 Hwp.exe 만 종료한 뒤 그 문서를 실패로 기록한다(대화상자로 멈추는 경우).
#   - 작업자는 한컴 창을 숨긴 채 띄워 문서를 열고 읽은 뒤 항상 Quit 한다. 한 번에 하나만 실행한다(병렬 금지).
#   - 시작 전에 이미 떠 있던 Hwp.exe 의 PID 는 기록해 두고 건드리지 않는다. 창 핸들의 PID 가 시작 전 PID 와 같으면(기존 창에 붙었다면) Quit 하지 않고 멈춘다.
#   - 문서는 읽기만 한다(저장하지 않는다. PDF 는 따로 저장한다).
import argparse
import ctypes
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

DOC_TIMEOUT_SEC = 60
TABLE_ITEMS = [
    "Width", "Height", "TreatAsChar", "PageBreak", "RepeatHeader", "CellSpacing", "HorzAlign", "TextWrap",
    "OutsideMarginLeft", "OutsideMarginRight", "OutsideMarginTop", "OutsideMarginBottom", "CellMarginLeft",
]
LABEL = re.compile(r"^\(([A-Z]+)(\d+)\)")


def hwp_pids():
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Hwp.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True)
    return {int(l.split('","')[1]) for l in r.stdout.splitlines() if l.startswith('"Hwp.exe"')}


def window_pid(hwp):
    """COM 으로 얻은 한컴 창의 프로세스 번호."""
    handle = hwp.XHwpWindows.Item(0).WindowHandle
    pid = ctypes.c_ulong()
    ctypes.windll.user32.GetWindowThreadProcessId(ctypes.c_void_p(handle), ctypes.byref(pid))
    return pid.value


def kill_pids(pids):
    for p in pids:
        subprocess.run(["taskkill", "/F", "/PID", str(p)], capture_output=True)


def read_items(pset, names):
    """파라미터 셋에서 이름별 값을 읽는다. 없거나 읽을 수 없으면 None."""
    out = {}
    for n in names:
        try:
            v = pset.Item(n) if pset.ItemExist(n) else None
        except Exception:
            v = None
        out[n] = v if isinstance(v, (int, float, str)) or v is None else None
    return out


def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_tables(hwp):
    """셀 리스트(2번부터)를 차례로 돌며 표 컨트롤별로 묶는다. 한컴은 없는 리스트 번호에서 본문으로 돌아가므로 거기서 멈춘다."""
    tables = []
    by_ctrl = {}
    for list_id in range(1, 4096):
        try:
            hwp.SetPos(list_id, 0, 0)
            if hwp.GetPos()[0] != list_id:
                break
            ki = hwp.KeyIndicator()
            label = LABEL.match(ki[-1] if ki else "")
            if label is None:
                continue  # 표 셀이 아닌 리스트(머리말·각주 등)
            ctrl = hwp.ParentCtrl
            if ctrl is None or ctrl.CtrlID != "tbl":
                continue
            key = ctrl.GetCtrlInstID()
            if key not in by_ctrl:
                by_ctrl[key] = {"props": read_items(ctrl.Properties, TABLE_ITEMS), "cells": []}
                tables.append(by_ctrl[key])
            by_ctrl[key]["cells"].append({"label": label.group(1) + label.group(2), "col": col_index(label.group(1)), "row": int(label.group(2)) - 1, "list": list_id})
        except Exception:
            continue
    return tables


def pdf_info(pdf_path, markers):
    """저장한 PDF 의 쪽 수와 글자 수, 요청한 marker 가 있는지. PyMuPDF 가 없으면 pages·chars·markers 는 None."""
    info = {"saved": os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 0, "bytes": os.path.getsize(pdf_path) if os.path.exists(pdf_path) else 0, "pages": None, "chars": None, "markers": None}
    if not info["saved"]:
        return info
    try:
        import fitz  # PyMuPDF

        with fitz.open(pdf_path) as pdf:
            text = "".join(page.get_text() for page in pdf)
            info["pages"] = len(pdf)
        flat = re.sub(r"\s+", "", text)
        info["chars"] = len(flat)
        info["markers"] = {m: re.sub(r"\s+", "", m) in flat for m in markers}
    except Exception as e:
        info["error"] = type(e).__name__
    return info


def run_worker(path, pdf_path, markers, protect):
    """한컴으로 문서 하나를 열어 표를 읽고 결과 한 줄(`RESULT:{json}`)을 낸다. 오류 사유는 예외 종류 이름만 적는다."""
    result = {"opened": False, "pages": None, "error": None, "tables": [], "pdf": None}
    hwp = None
    owned = False
    pid = None
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        import win32com.client

        hwp = win32com.client.Dispatch("HWPFrame.HwpObject")
        time.sleep(0.5)
        pid = window_pid(hwp)
        print("HWP_PID:%d" % pid, flush=True)  # 시간 초과 때 오케스트레이터가 이 PID 만 종료한다
        if pid in protect:
            raise RuntimeError("NOT_NEW_PROCESS")
        owned = True
        hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        hwp.XHwpWindows.Item(0).Visible = False
        try:
            result["hancom_version"] = str(hwp.Version)
        except Exception:
            pass
        result["opened"] = bool(hwp.Open(path, "HWPX", "forceopen:true"))
        if result["opened"]:
            result["pages"] = int(hwp.PageCount)
            result["tables"] = read_tables(hwp)
            if pdf_path:
                hwp.SaveAs(pdf_path, "PDF", "")
                result["pdf"] = pdf_info(pdf_path, markers)
        else:
            result["error"] = "OPEN_FALSE"
        try:
            hwp.Clear(1)
        except Exception:
            pass
    except Exception as e:
        result["error"] = type(e).__name__ if str(e) != "NOT_NEW_PROCESS" else "NOT_NEW_PROCESS"
    finally:
        if owned:
            try:
                hwp.Quit()
            except Exception as e:
                result["quit_error"] = type(e).__name__
            time.sleep(1)
            left = pid in hwp_pids()
            if left:
                kill_pids({pid})
            result["killed_leftover_pids"] = 1 if left else 0
    print("RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)


def run_one(path, pdf_path, markers, before, timeout):
    cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", path, "--pdf", pdf_path or "", "--markers", json.dumps(markers, ensure_ascii=False), "--protect", ",".join(map(str, sorted(before)))]
    t0 = time.time()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        so, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        so, _ = proc.communicate()
        time.sleep(1)
        for line in so.decode("utf-8", "replace").splitlines():
            if line.startswith("HWP_PID:") and int(line[len("HWP_PID:"):]) not in before:
                kill_pids({int(line[len("HWP_PID:"):])})  # 이 작업자가 띄운 한컴만 종료한다
        return {"opened": False, "pages": None, "error": "TIMEOUT", "timeout": True, "tables": [], "pdf": None, "seconds": round(time.time() - t0, 1)}
    for line in so.decode("utf-8", "replace").splitlines():
        if line.startswith("RESULT:"):
            res = json.loads(line[len("RESULT:"):])
            res["timeout"] = False
            res["seconds"] = round(time.time() - t0, 1)
            return res
    return {"opened": False, "pages": None, "error": "NO_RESULT", "timeout": False, "tables": [], "pdf": None, "seconds": round(time.time() - t0, 1)}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker")
    ap.add_argument("--pdf", default="")
    ap.add_argument("--markers", default="[]")
    ap.add_argument("--protect", default="")
    ap.add_argument("--spec")
    ap.add_argument("--out")
    ap.add_argument("--timeout", type=int, default=DOC_TIMEOUT_SEC)
    args = ap.parse_args()
    protect = {int(x) for x in args.protect.split(",") if x}
    if args.worker:
        return run_worker(args.worker, args.pdf, json.loads(args.markers), protect)
    if not args.spec or not args.out:
        ap.error("--spec 과 --out 이 필요하다")

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    before = hwp_pids()
    report = {"hwp_pids_before": len(before), "hancom_version": None, "results": []}
    for doc in spec["documents"]:
        # 다른 작업이 한컴을 함께 쓰다 남은 프로세스를 정리하면 이쪽 COM 호출이 끊길 수 있다(결과 없음). 문서마다 최대 3번 시도한다.
        for attempt in range(3):
            pdf = str(Path(doc["pdf"]).resolve()) if doc.get("pdf") else ""
            res = run_one(str(Path(doc["file"]).resolve()), pdf, doc.get("markers", []), before, args.timeout)
            if res.get("error") not in ("NO_RESULT", "NOT_NEW_PROCESS"):
                break
            time.sleep(5)
        res["attempts"] = attempt + 1
        if res.get("hancom_version"):
            report["hancom_version"] = res.pop("hancom_version")
        res["name"] = doc.get("name")
        report["results"].append(res)
    after = hwp_pids() - before
    report["hwp_new_processes_at_end"] = len(after)  # 다른 작업이 띄운 것일 수도 있어 종료하지 않고 세기만 한다
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok = sum(1 for r in report["results"] if r["opened"])
    print("read_table: 문서 %d개 중 열림 %d, 시간 초과 %d, 끝났을 때 새로 떠 있는 Hwp.exe %d개" % (len(report["results"]), ok, sum(1 for r in report["results"] if r.get("timeout")), len(after)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
