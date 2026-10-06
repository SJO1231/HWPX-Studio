# 한컴 오피스(한글)를 COM 으로 띄워 여러 HWPX 문서의 대응 문단에서 문단모양(들여쓰기·여백·문단 간격·줄 간격 등)을 읽고,
# 기준 문서와 값이 같은지 대조한다. 조각 이식본의 문단 속성을 한컴이 원본과 같게 읽는지 보는 오라클이다(#69).
# 실행: python tools/com/read_para_props.py --spec 명세.json --out 결과.json [--timeout 60]
#
# 명세 JSON
#   { "baseline": "기준 문서 라벨"(선택, 없으면 첫 문서),
#     "documents": [ { "name": "라벨", "file": "문서.hwpx",
#                      "probes": [ { "id": "a", "list": 0, "para": 106, "textSha": "글 해시"(선택) },
#                                  { "id": "b", "textSha": "글 해시", "para": 1 } ] } ] }
#   - list+para: 한컴 리스트 번호(본문은 0)와 그 안 문단 순번(0부터). textSha 를 함께 주면 그 문단 글의 해시가 같은지 확인한다.
#   - list 없이 textSha+para: 표 칸처럼 리스트 번호를 모르는 문단. 리스트 1번부터 끝까지 훑어 `para` 번째 문단 글의 해시가
#     같은 리스트를 찾는다. 없으면 LIST_NOT_FOUND, 둘 이상이면 AMBIGUOUS 로 두고 읽지 않는다.
#   - 글 해시는 한컴이 블록 저장(TEXT)으로 준 문단 글(끝 줄바꿈 제외)의 UTF-8 SHA-256 앞 10자다. 명세·결과에 글 자체를 넣지 않는다.
#   - 같은 id 의 탐침끼리 대조한다(문서마다 위치는 다를 수 있다).
#
# 결과 JSON: { "hancom_version", "baseline", "results": [ { "name", "opened", "pages", "lists", "timeout", "error",
#     "probes": [ { "id", "ok", "list", "para", "textLen", "textSha", "props": {...}, "error" } ] } ],
#     "compare": [ { "name", "id", "same", "diff": { 항목: [기준 값, 이 문서 값] } } ] }
#   - props 는 한컴 ParaShape 가 준 값 그대로다(여백·간격은 한컴 단위, 대조만 하고 환산하지 않는다). 항목은 read_shape.py 의 PARA_ITEMS.
#   - lists 는 훑은 리스트 수(본문 제외)다. 리스트를 찾는 탐침이 없으면 null 이다.
#   - compare 는 기준 문서와 다른 문서에서 둘 다 읽힌(ok) 탐침만 담는다. 결과에는 파일 경로·글을 담지 않는다.
#
# 구조는 read_shape.py 와 같다: 문서마다 작업자를 따로 띄우고 제한 시간(기본 60초)이 지나면 그 작업자와 그것이 띄운 Hwp.exe 만 종료한다.
# 한컴 창은 숨기고 작업자는 항상 Quit 한다. 시작 전에 이미 떠 있던 Hwp.exe 는 건드리지 않는다. 한 번에 하나만 실행한다(병렬 금지).
# 문서는 읽기만 한다(저장하지 않는다).
import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

from read_shape import PARA_ITEMS, hwp_pids, kill_pids, paragraph_text, read_set, window_pid

DOC_TIMEOUT_SEC = 60
MAX_LISTS = 4096


def text_sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]


def text_at(hwp, list_id, para):
    """(list_id, para) 문단의 글. 그 위치가 없으면 None."""
    hwp.SetPos(list_id, para, 0)
    if tuple(hwp.GetPos()[:2]) != (list_id, para):
        return None
    return paragraph_text(hwp, list_id, para)


def count_lists(hwp):
    """본문(0) 밖의 리스트 수. 1번부터 차례로 옮겨 가서 그 리스트로 가지 않는 첫 번호 앞까지 센다."""
    n = 0
    for list_id in range(1, MAX_LISTS):
        hwp.SetPos(list_id, 0, 0)
        if hwp.GetPos()[0] != list_id:
            break
        n = list_id
    return n


def read_probe(hwp, probe, lists, cache):
    out = {"id": probe.get("id"), "ok": False, "list": None, "para": probe.get("para", 0), "textLen": None, "textSha": None, "props": None, "error": None}
    try:
        para = out["para"]
        if "list" in probe:
            list_id = probe["list"]
            text = text_at(hwp, list_id, para)
            if text is None:
                out["error"] = "SETPOS_MISMATCH"
                return out
        else:
            hits = []
            for list_id in range(1, lists + 1):
                key = (list_id, para)
                if key not in cache:
                    t = text_at(hwp, list_id, para)
                    cache[key] = None if t is None else text_sha(t)
                if cache[key] == probe["textSha"]:
                    hits.append(list_id)
            if not hits:
                out["error"] = "LIST_NOT_FOUND"
                return out
            if len(hits) > 1:
                out["error"] = "AMBIGUOUS"
                out["candidates"] = len(hits)
                return out
            list_id = hits[0]
            text = text_at(hwp, list_id, para)
        out["list"] = list_id
        out["textLen"] = len(text)
        out["textSha"] = text_sha(text)
        if probe.get("textSha") and out["textSha"] != probe["textSha"]:
            out["error"] = "TEXT_MISMATCH"
            return out
        hwp.SetPos(list_id, para, 0)
        out["props"] = read_set(hwp.ParaShape, PARA_ITEMS)
        out["ok"] = True
    except Exception as e:
        out["error"] = type(e).__name__
    return out


def run_worker(path, probes, protect):
    """한컴으로 문서 하나를 열어 탐침마다 읽고 결과 한 줄(`RESULT:{json}`)을 낸다. 오류 사유는 예외 종류 이름만 적는다."""
    result = {"opened": False, "pages": None, "lists": None, "error": None, "probes": []}
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
            search = any("list" not in p for p in probes)
            lists = count_lists(hwp) if search else 0
            result["lists"] = lists if search else None
            cache = {}
            result["probes"] = [read_probe(hwp, p, lists, cache) for p in probes]
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
    cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", path, "--probes", json.dumps(probes), "--protect", ",".join(map(str, sorted(before)))]
    t0 = time.time()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    failed = {"opened": False, "pages": None, "lists": None, "probes": []}
    try:
        so, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        so, _ = proc.communicate()
        time.sleep(1)
        for line in so.decode("utf-8", "replace").splitlines():
            if line.startswith("HWP_PID:") and int(line[len("HWP_PID:"):]) not in before:
                kill_pids({int(line[len("HWP_PID:"):])})  # 이 작업자가 띄운 한컴만 종료한다
        return {**failed, "error": "TIMEOUT", "timeout": True, "seconds": round(time.time() - t0, 1)}
    for line in so.decode("utf-8", "replace").splitlines():
        if line.startswith("RESULT:"):
            res = json.loads(line[len("RESULT:"):])
            res["timeout"] = False
            res["seconds"] = round(time.time() - t0, 1)
            return res
    return {**failed, "error": "NO_RESULT", "timeout": False, "seconds": round(time.time() - t0, 1)}


def compare(results, baseline):
    """기준 문서와 다른 문서의 같은 id 탐침에서 값이 다른 항목을 모은다."""
    base = next((r for r in results if r["name"] == baseline), None)
    if base is None:
        return []
    base_props = {p["id"]: p["props"] for p in base["probes"] if p["ok"]}
    rows = []
    for r in results:
        if r is base:
            continue
        for p in r["probes"]:
            if not p["ok"] or p["id"] not in base_props:
                continue
            b = base_props[p["id"]]
            diff = {k: [b.get(k), v] for k, v in p["props"].items() if b.get(k) != v}
            rows.append({"name": r["name"], "id": p["id"], "same": not diff, "diff": diff})
    return rows


def main():
    sys.stdout.reconfigure(encoding="utf-8")
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
    baseline = spec.get("baseline") or spec["documents"][0]["name"]
    before = hwp_pids()
    report = {"hwp_pids_before": len(before), "hancom_version": None, "baseline": baseline, "results": []}
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
    report["compare"] = compare(report["results"], baseline)
    after = hwp_pids() - before
    report["hwp_new_processes_at_end"] = len(after)  # 다른 작업이 띄운 것일 수도 있어 종료하지 않고 세기만 한다
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok = sum(1 for r in report["results"] if r["opened"])
    print("read_para_props: 문서 %d개 중 열림 %d, 시간 초과 %d, 끝났을 때 새로 떠 있는 Hwp.exe %d개" % (len(report["results"]), ok, sum(1 for r in report["results"] if r.get("timeout")), len(after)))
    for r in report["results"]:
        if r["name"] == baseline:
            continue
        rows = [c for c in report["compare"] if c["name"] == r["name"]]
        print("  %s: 읽은 탐침 %d/%d, 기준과 같음 %d" % (r["name"], sum(1 for p in r["probes"] if p["ok"]), len(r["probes"]), sum(1 for c in rows if c["same"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
