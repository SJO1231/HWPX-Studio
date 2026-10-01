# 한컴 오피스(한글)를 COM 으로 띄워 HWPX 파일 목록을 열어 보고 열림 여부·쪽 수를 JSON 으로 낸다. `--pdf-dir` 을 주면 PDF 로도 저장한다.
# 실행: python tools/com/open_check.py --out 결과.json [--pdf-dir 폴더] [--timeout 60] 파일.hwpx [파일.hwpx ...]
#
# 구조는 make_fixtures.py 와 같다.
#   - 기본 실행(오케스트레이터)은 문서마다 이 파일을 `--worker` 로 다시 실행하고, 제한 시간(기본 60초) 안에 끝나지 않으면
#     그 작업자와 그것이 띄운 Hwp.exe 만 종료한 뒤 그 문서를 실패로 기록한다(대화상자로 멈추는 경우).
#   - 작업자는 한컴 창을 숨긴 채 띄워 문서를 열고 쪽 수를 읽고(옵션: PDF 저장) 항상 Quit 한다.
#   - 시작 전에 이미 떠 있던 Hwp.exe 의 PID 는 기록해 두고 건드리지 않는다. 끝난 뒤 남은(이 실행이 띄운) Hwp.exe 수를 센다.
#   - 시간 초과가 연달아 3번 나면 남은 문서는 열지 않고 중단 사유를 적는다.
# 파일은 읽기만 한다. 결과 JSON 에는 파일 이름(마지막 구성요소)·열림 여부·쪽 수·오류 코드만 담고 경로나 문서 내용은 담지 않는다.
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

DOC_TIMEOUT_SEC = 60
MAX_CONSECUTIVE_TIMEOUTS = 3


def hwp_pids():
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Hwp.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True)
    return {int(l.split('","')[1]) for l in r.stdout.splitlines() if l.startswith('"Hwp.exe"')}


def kill_pids(pids):
    for p in pids:
        subprocess.run(["taskkill", "/F", "/PID", str(p)], capture_output=True)


def run_worker(path, pdf_path, protect):
    """한컴으로 문서 하나를 열어 결과 한 줄(`RESULT:{json}`)을 낸다. 오류 사유는 예외 종류 이름만 적는다(문서 내용이 섞일 수 있어 메시지는 적지 않는다)."""
    result = {"opened": False, "pages": None, "pdf": None, "error": None}
    hwp = None
    owned = False
    try:
        import win32com.client

        hwp = win32com.client.Dispatch("HWPFrame.HwpObject")
        for _ in range(20):
            if hwp_pids() - protect:
                owned = True
                break
            time.sleep(0.5)
        if not owned:
            raise RuntimeError("NOT_NEW_PROCESS")  # 기존 한컴 창에 붙었다면 Quit 하지 않고 멈춘다
        hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        hwp.XHwpWindows.Item(0).Visible = False
        try:
            result["hancom_version"] = str(hwp.Version)
        except Exception:
            pass
        result["opened"] = bool(hwp.Open(path, "HWPX", "forceopen:true"))
        if result["opened"]:
            result["pages"] = int(hwp.PageCount)
            if pdf_path:
                saved = bool(hwp.SaveAs(pdf_path, "PDF", ""))
                size = os.path.getsize(pdf_path) if os.path.exists(pdf_path) else 0
                result["pdf"] = {"saved": saved and size > 0, "bytes": size}
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
        left = hwp_pids() - protect
        kill_pids(left)
        result["killed_leftover_pids"] = len(left)
    sys.stdout.reconfigure(encoding="utf-8")
    print("RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)


def run_one(path, pdf_path, before, timeout):
    cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", path, "--protect", ",".join(map(str, sorted(before)))]
    if pdf_path:
        cmd += ["--pdf", pdf_path]
    t0 = time.time()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        so, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        time.sleep(1)
        kill_pids(hwp_pids() - before)
        proc.communicate()
        return {"opened": False, "pages": None, "pdf": None, "error": "TIMEOUT", "timeout": True, "seconds": round(time.time() - t0, 1)}
    for line in so.decode("utf-8", "replace").splitlines():
        if line.startswith("RESULT:"):
            res = json.loads(line[len("RESULT:"):])
            res["timeout"] = False
            res["seconds"] = round(time.time() - t0, 1)
            return res
    return {"opened": False, "pages": None, "pdf": None, "error": "NO_RESULT", "timeout": False, "seconds": round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker")
    ap.add_argument("--protect", default="")
    ap.add_argument("--pdf", default="")
    ap.add_argument("--out")
    ap.add_argument("--pdf-dir")
    ap.add_argument("--timeout", type=int, default=DOC_TIMEOUT_SEC)
    ap.add_argument("files", nargs="*")
    args = ap.parse_args()
    protect = {int(x) for x in args.protect.split(",") if x}
    if args.worker:
        return run_worker(args.worker, args.pdf, protect)
    if not args.out:
        ap.error("--out 이 필요하다")

    pdf_dir = Path(args.pdf_dir).resolve() if args.pdf_dir else None
    if pdf_dir:
        pdf_dir.mkdir(parents=True, exist_ok=True)
    before = hwp_pids()
    report = {"hwp_pids_before": len(before), "hancom_version": None, "results": [], "aborted": None}
    consecutive = 0
    for f in args.files:
        p = Path(f).resolve()
        if report["aborted"]:
            report["results"].append({"file": p.name, "opened": False, "pages": None, "pdf": None, "error": "SKIPPED_AFTER_TIMEOUTS", "timeout": False, "seconds": 0})
            continue
        pdf_path = str(pdf_dir / (p.stem + ".pdf")) if pdf_dir else ""
        res = run_one(str(p), pdf_path, before, args.timeout)
        if res.get("hancom_version"):
            report["hancom_version"] = res.pop("hancom_version")
        res["file"] = p.name
        report["results"].append(res)
        consecutive = consecutive + 1 if res.get("timeout") else 0
        if consecutive >= MAX_CONSECUTIVE_TIMEOUTS:
            report["aborted"] = "REPEATED_TIMEOUTS"
    left = hwp_pids() - before
    kill_pids(left)
    report["hwp_processes_left_by_this_run"] = len(left)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok = sum(1 for r in report["results"] if r["opened"])
    print("open_check: %d개 중 열림 %d, 시간 초과 %d, 남은 Hwp.exe %d개" % (len(report["results"]), ok, sum(1 for r in report["results"] if r.get("timeout")), len(left)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
