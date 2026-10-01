# 한컴 오피스(한글)를 COM 으로 띄워 HWPX 문서의 지정 위치 글자모양·문단모양을 읽어 JSON 으로 낸다.
# 실행: python tools/com/read_shape.py --spec 명세.json --out 결과.json [--timeout 60]
#
# 명세 JSON
#   { "documents": [ { "name": "라벨", "file": "문서.hwpx",
#                      "probes": [ { "id": "a", "list": 0, "para": 2, "charPos": 29 },
#                                  { "id": "b", "listByText": "비고", "para": 0, "charPos": 0 } ] } ] }
#   - list: 한컴의 리스트 번호(본문은 0). listByText: 표 셀 등은 번호를 알 수 없으므로, 그 `para` 번째 문단의 글이 이 값과 같은 리스트를 1번부터 찾는다.
#   - para: 그 리스트 안 문단 순번(0부터).
#   - charPos: 읽을 글자의 한컴 위치. 한컴은 글자 하나를 1칸으로 세되 탭·컨트롤 같은 확장 문자는 8칸으로 센다.
#     캐럿을 charPos+1 에 놓고 읽는다(관측: 캐럿 위치 p 에서 읽히는 글자모양은 위치 p-1 의 글자 것이다).
#
# 결과 JSON: { "hancom_version", "results": [ { "name", "opened", "pages", "timeout", "error", "probes": [ { "id", "ok", "list", "text", "char", "para", "error" } ] } ] }
#   - char·para 는 한컴이 읽어 준 값 그대로다(색은 BGR 정수, 여백·줄 간격은 한컴 단위). 요청값과의 대조는 호출한 쪽이 한다.
#   - 읽을 수 없는 항목은 null 이다. 결과에는 파일 경로를 담지 않는다.
#
# 구조는 make_fixtures.py·open_check.py 와 같다.
#   - 기본 실행(오케스트레이터)은 문서마다 이 파일을 `--worker` 로 다시 실행하고, 제한 시간(기본 60초) 안에 끝나지 않으면
#     그 작업자와 그것이 띄운 Hwp.exe 만 종료한 뒤 그 문서를 실패로 기록한다(대화상자로 멈추는 경우).
#   - 작업자는 한컴 창을 숨긴 채 띄워 문서를 열고 위치마다 읽은 뒤 항상 Quit 한다.
#   - 시작 전에 이미 떠 있던 Hwp.exe 의 PID 는 기록해 두고 건드리지 않는다. 이 작업자가 띄운 Hwp.exe 는 창 핸들로 PID 를 알아내
#     (여러 작업이 한컴을 함께 쓸 수 있으므로 "새로 뜬 것 전부"가 아니라 자기 것만 다룬다) 끝나면 Quit 하고, 남아 있으면 그 PID 만 종료한다.
#     창 핸들의 PID 가 시작 전 PID 와 같으면(기존 창에 붙었다면) Quit 하지 않고 멈춘다.
#   - 문서는 읽기만 한다(저장하지 않는다).
import argparse
import ctypes
import json
import subprocess
import sys
import time
from pathlib import Path

DOC_TIMEOUT_SEC = 60
LANGS = ["Hangul", "Latin", "Hanja", "Japanese", "Other", "Symbol", "User"]

CHAR_ITEMS = (
    ["Height", "Bold", "Italic", "TextColor", "ShadeColor", "SmallCaps", "UseFontSpace", "UseKerning"]
    + ["Ratio" + l for l in LANGS]
    + ["Spacing" + l for l in LANGS]
    + ["Size" + l for l in LANGS]
    + ["Offset" + l for l in LANGS]
    + ["FaceName" + l for l in LANGS]
    + ["UnderlineType", "UnderlineShape", "UnderlineColor", "StrikeOutType", "StrikeOutShape", "StrikeOutColor", "OutlineType"]
    + ["ShadowType", "ShadowColor", "ShadowOffsetX", "ShadowOffsetY", "Emboss", "Engrave", "SuperScript", "SubScript", "DiacSymMark"]
)
PARA_ITEMS = [
    "AlignType", "LeftMargin", "RightMargin", "Indentation", "PrevSpacing", "NextSpacing", "LineSpacingType", "LineSpacing",
    "BreakLatinWord", "BreakNonLatinWord", "SnapToGrid", "Condense", "KeepWithNext", "KeepLinesTogether", "PagebreakBefore", "WidowOrphan",
]
# 문단모양 안의 중첩 셋: (항목 이름, 읽을 하위 항목). 결과에는 `항목.하위` 키로 평평하게 담는다.
BORDER_ITEMS = [
    "BorderTypeLeft", "BorderTypeRight", "BorderTypeTop", "BorderTypeBottom",
    "BorderWidthLeft", "BorderWidthRight", "BorderWidthTop", "BorderWidthBottom",
    "BorderColorLeft", "BorderColorRight", "BorderColorTop", "BorderColorBottom",
]
FILL_ITEMS = ["Type", "WinBrushFaceColor", "WinBrushHatchColor", "WinBrushFaceStyle"]
TAB_ITEMS = ["AutoTabLeft", "AutoTabRight"]


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


def read_set(pset, names):
    """파라미터 셋에서 이름별 값을 읽는다. 읽을 수 없거나 숫자·문자열이 아닌 값(중첩 셋)은 None."""
    out = {}
    for n in names:
        try:
            v = pset.Item(n)
        except Exception:
            v = None
        out[n] = v if isinstance(v, (int, float, str)) or v is None else None
    return out


def read_nested(out, pset, name, names, prefix=""):
    """중첩 셋(`name`)의 항목을 `out` 에 `prefix + name.항목` 키로 담는다. 존재하지 않는 항목(ItemExist 가 거짓)은 담지 않는다."""
    try:
        nested = pset.Item(name)
    except Exception:
        return
    for n in names:
        try:
            if nested.ItemExist(n):
                v = nested.Item(n)
                out[prefix + name + "." + n] = v if isinstance(v, (int, float, str)) else None
        except Exception:
            pass


def paragraph_text(hwp, list_id, para):
    """리스트의 `para` 번째 문단 글(탭은 \\t). 읽지 못하면 None. 읽은 뒤 선택은 취소한다."""
    try:
        hwp.SetPos(list_id, para, 0)
        hwp.HAction.Run("MoveSelParaEnd")
        text = hwp.GetTextFile("TEXT", "saveblock")
        hwp.HAction.Run("Cancel")
        if text is None:
            return ""
        return text.rstrip("\r\n")
    except Exception:
        return None


def find_list(hwp, text, para):
    """`para` 번째 문단의 글이 `text` 인 리스트 번호를 1번부터 찾는다. 없으면 None."""
    for list_id in range(1, 129):
        try:
            hwp.SetPos(list_id, para, 0)
            if hwp.GetPos()[0] != list_id:
                return None  # 더 큰 번호는 없는 리스트라 본문으로 돌아간다
        except Exception:
            return None
        if paragraph_text(hwp, list_id, para) == text:
            return list_id
    return None


def read_probe(hwp, probe):
    result = {"id": probe.get("id"), "ok": False, "list": None, "text": None, "char": None, "para": None, "error": None}
    try:
        list_id = probe.get("list", 0)
        if "listByText" in probe:
            list_id = find_list(hwp, probe["listByText"], probe.get("para", 0))
            if list_id is None:
                result["error"] = "LIST_NOT_FOUND"
                return result
        para = probe.get("para", 0)
        result["list"] = list_id
        result["text"] = paragraph_text(hwp, list_id, para)
        hwp.SetPos(list_id, para, probe["charPos"] + 1)
        pos = hwp.GetPos()
        if (pos[0], pos[1]) != (list_id, para):
            result["error"] = "SETPOS_MISMATCH"
            return result
        result["char"] = read_set(hwp.CharShape, CHAR_ITEMS)
        pa = hwp.ParaShape
        result["para"] = read_set(pa, PARA_ITEMS)
        read_nested(result["para"], pa, "BorderFill", BORDER_ITEMS)
        read_nested(result["para"], pa, "TabDef", TAB_ITEMS)
        try:
            read_nested(result["para"], pa.Item("BorderFill"), "FillAttr", FILL_ITEMS, prefix="BorderFill.")
        except Exception:
            pass
        result["ok"] = True
    except Exception as e:
        result["error"] = type(e).__name__
    return result


def run_worker(path, probes, protect):
    """한컴으로 문서 하나를 열어 위치마다 읽고 결과 한 줄(`RESULT:{json}`)을 낸다. 오류 사유는 예외 종류 이름만 적는다."""
    result = {"opened": False, "pages": None, "error": None, "probes": []}
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
            raise RuntimeError("NOT_NEW_PROCESS")  # 기존 한컴 창에 붙었다면 Quit 하지 않고 멈춘다
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
            result["probes"] = [read_probe(hwp, p) for p in probes]
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


def run_one(path, probes, before, timeout):
    cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", path, "--probes", json.dumps(probes, ensure_ascii=False), "--protect", ",".join(map(str, sorted(before)))]
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
        return {"opened": False, "pages": None, "error": "TIMEOUT", "timeout": True, "probes": [], "seconds": round(time.time() - t0, 1)}
    for line in so.decode("utf-8", "replace").splitlines():
        if line.startswith("RESULT:"):
            res = json.loads(line[len("RESULT:"):])
            res["timeout"] = False
            res["seconds"] = round(time.time() - t0, 1)
            return res
    return {"opened": False, "pages": None, "error": "NO_RESULT", "timeout": False, "probes": [], "seconds": round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker")
    ap.add_argument("--probes", default="[]")
    ap.add_argument("--protect", default="")
    ap.add_argument("--spec")
    ap.add_argument("--out")
    ap.add_argument("--timeout", type=int, default=DOC_TIMEOUT_SEC)
    args = ap.parse_args()
    protect = {int(x) for x in args.protect.split(",") if x}
    if args.worker:
        return run_worker(args.worker, json.loads(args.probes), protect)
    if not args.spec or not args.out:
        ap.error("--spec 과 --out 이 필요하다")

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    before = hwp_pids()
    report = {"hwp_pids_before": len(before), "hancom_version": None, "results": []}
    for doc in spec["documents"]:
        # 다른 작업이 한컴을 함께 쓰다 남은 프로세스를 정리하면 이쪽 COM 호출이 끊길 수 있다(com_error·결과 없음). 문서마다 최대 3번 시도한다.
        for attempt in range(3):
            res = run_one(str(Path(doc["file"]).resolve()), doc.get("probes", []), before, args.timeout)
            if res.get("error") not in ("com_error", "NO_RESULT", "NOT_NEW_PROCESS"):
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
    print("read_shape: 문서 %d개 중 열림 %d, 시간 초과 %d, 끝났을 때 새로 떠 있는 Hwp.exe %d개" % (len(report["results"]), ok, sum(1 for r in report["results"] if r.get("timeout")), len(after)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
