# 한컴 오피스(한글)를 COM 으로 띄워 HWPX 문서를 열고, 누름틀 값(GetFieldText)과 PDF 안 글의 위치를 읽어 JSON 으로 낸다.
# 값에 줄바꿈·탭을 넣은 문서를 한컴이 어떻게 읽고 그리는지 확인하려고 만들었다(엔진 시험 `inline-com.test.ts`).
# 실행: python tools/com/read_text.py --spec 명세.json --out 결과.json [--timeout 60]
#
# 명세 JSON
#   { "documents": [ { "name": "라벨", "file": "문서.hwpx", "fields": ["누름틀 이름", ...](선택), "resave": "다시 저장할.hwpx"(선택),
#                      "pdf": "저장할.pdf"(선택), "markers": ["PDF 에서 위치를 찾을 글", ...](선택) } ] }
#
# 결과 JSON: { "hancom_version", "results": [ { "name", "opened", "pages", "timeout", "error",
#     "field_text": { 이름: GetFieldText 가 준 문자열 그대로 }, "resaved": 참거짓,
#     "pdf": { "saved", "bytes", "pages", "markers": { 글: { "page", "x0", "y0", "x1", "y1" }(PDF 포인트, 위쪽이 0) 또는 null } } } ] }
#   - GetFieldText 는 한컴이 주는 표현 그대로다(줄바꿈 요소는 아무 글자도 되지 않았고 탭은 \t 였다. 관측 기록은 tools/com/README.md).
#   - 글 위치는 PyMuPDF 의 search_for 첫 결과다. PyMuPDF 가 없으면 markers 는 null 이다.
#   - 결과에는 파일 경로를 담지 않는다.
#
# 구조는 read_table.py 와 같다: 문서마다 작업자를 따로 띄우고 제한 시간(기본 60초)이 지나면 그 작업자와 그것이 띄운 Hwp.exe 만 종료한다.
# 한컴 창은 숨기고 작업자는 항상 Quit 한다. 시작 전에 이미 떠 있던 Hwp.exe 는 건드리지 않는다. 한 번에 하나만 실행한다(병렬 금지).
# 문서는 읽기만 한다(`resave` 를 줄 때만 다른 이름으로 저장한다).
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from read_table import hwp_pids, kill_pids, window_pid

DOC_TIMEOUT_SEC = 60


def pdf_info(pdf_path, markers):
    """저장한 PDF 의 쪽 수와 marker 글의 위치(첫 결과). PyMuPDF 가 없으면 pages·markers 는 None."""
    size = os.path.getsize(pdf_path) if os.path.exists(pdf_path) else 0
    info = {"saved": size > 0, "bytes": size, "pages": None, "markers": None}
    if size == 0:
        return info
    try:
        import fitz  # PyMuPDF

        with fitz.open(pdf_path) as pdf:
            info["pages"] = len(pdf)
            found = {}
            for m in markers:
                found[m] = None
                for number, page in enumerate(pdf, start=1):
                    rects = page.search_for(m)
                    if rects:
                        r = rects[0]
                        found[m] = {"page": number, "x0": round(r.x0, 2), "y0": round(r.y0, 2), "x1": round(r.x1, 2), "y1": round(r.y1, 2)}
                        break
            info["markers"] = found
    except Exception as e:
        info["error"] = type(e).__name__
    return info


def run_worker(spec_doc, protect):
    """한컴으로 문서 하나를 열어 읽고 결과 한 줄(`RESULT:{json}`)을 낸다. 오류 사유는 예외 종류 이름만 적는다."""
    result = {"opened": False, "pages": None, "error": None, "field_text": {}, "resaved": False, "pdf": None}
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
        result["opened"] = bool(hwp.Open(spec_doc["file"], "HWPX", "forceopen:true"))
        if result["opened"]:
            result["pages"] = int(hwp.PageCount)
            result["field_text"] = {n: hwp.GetFieldText(n) for n in spec_doc.get("fields", [])}
            if spec_doc.get("resave"):
                result["resaved"] = bool(hwp.SaveAs(spec_doc["resave"], "HWPX", ""))
            if spec_doc.get("pdf"):
                hwp.SaveAs(spec_doc["pdf"], "PDF", "")
                result["pdf"] = pdf_info(spec_doc["pdf"], spec_doc.get("markers", []))
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


def run_one(spec_doc, before, timeout):
    cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", json.dumps(spec_doc, ensure_ascii=False), "--protect", ",".join(map(str, sorted(before)))]
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
        return {"opened": False, "pages": None, "error": "TIMEOUT", "timeout": True, "field_text": {}, "resaved": False, "pdf": None, "seconds": round(time.time() - t0, 1)}
    for line in so.decode("utf-8", "replace").splitlines():
        if line.startswith("RESULT:"):
            res = json.loads(line[len("RESULT:"):])
            res["timeout"] = False
            res["seconds"] = round(time.time() - t0, 1)
            return res
    return {"opened": False, "pages": None, "error": "NO_RESULT", "timeout": False, "field_text": {}, "resaved": False, "pdf": None, "seconds": round(time.time() - t0, 1)}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker")
    ap.add_argument("--protect", default="")
    ap.add_argument("--spec")
    ap.add_argument("--out")
    ap.add_argument("--timeout", type=int, default=DOC_TIMEOUT_SEC)
    args = ap.parse_args()
    protect = {int(x) for x in args.protect.split(",") if x}
    if args.worker:
        return run_worker(json.loads(args.worker), protect)
    if not args.spec or not args.out:
        ap.error("--spec 과 --out 이 필요하다")

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    before = hwp_pids()
    report = {"hwp_pids_before": len(before), "hancom_version": None, "results": []}
    for doc in spec["documents"]:
        item = {k: (str(Path(v).resolve()) if k in ("file", "resave", "pdf") and v else v) for k, v in doc.items()}
        # 다른 작업이 한컴을 함께 쓰다 남은 프로세스를 정리하면 이쪽 COM 호출이 끊길 수 있다(결과 없음). 문서마다 최대 3번 시도한다.
        for attempt in range(3):
            res = run_one(item, before, args.timeout)
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
    print("read_text: 문서 %d개 중 열림 %d, 시간 초과 %d, 끝났을 때 새로 떠 있는 Hwp.exe %d개" % (len(report["results"]), ok, sum(1 for r in report["results"] if r.get("timeout")), len(after)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
