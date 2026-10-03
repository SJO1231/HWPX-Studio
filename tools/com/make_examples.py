# 빠른 생성의 예시 서식(examples/quick/*.hwpx)을 한컴 오피스(한글) COM 으로 만든다.
# 실행: python tools/com/make_examples.py   (한컴 오피스가 설치된 Windows, pywin32 필요)
#
# make_fixtures.py 의 규칙과 도우미를 그대로 쓴다: 문서 하나씩 작업자 프로세스로 만들고(60초 한도), 한컴 창은 숨기며,
# 끝나면 Quit 하고, 시작 전에 떠 있던 Hwp.exe 는 건드리지 않는다. 저장 뒤 작성자·최종 저장자 값은 synthetic 으로 바꾼다.
# 예시의 값은 전부 가짜다. 사용자가 한컴에서 마음대로 고쳐 시험하는 용도라 시험 fixture 와 섞지 않는다.
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import make_fixtures as mf

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "examples" / "quick"


def field(hwp, hint, name):
    """안내문 상태의 누름틀을 만들고 캐럿을 누름틀 밖(줄 끝)으로 낸다."""
    hwp.CreateField(hint, "", name)
    hwp.HAction.Run("MoveLineEnd")


def build_template_fields(hwp):
    # 누름틀 서식: 제목, 사업명 줄, 4행 2열 표(라벨 | 누름틀), 맺음말, 신청일 줄.
    mf.ins(hwp, "참가 신청서")
    mf.newline(hwp)
    mf.newline(hwp)
    mf.ins(hwp, "사업명: ")
    field(hwp, "사업명을 입력", "사업명")
    mf.newline(hwp)
    mf.table_create(hwp, 4, 2)
    rows = [("성명", "이름을 입력", "성명"), ("소속", "소속을 입력", "소속"), ("연락처", "연락처를 입력", "연락처"), ("신청 사유", "사유를 입력", "신청사유")]
    for i, (label, hint, name) in enumerate(rows):
        mf.ins(hwp, label)
        hwp.HAction.Run("TableRightCell")
        field(hwp, hint, name)
        if i < len(rows) - 1:
            hwp.HAction.Run("TableRightCell")
    hwp.HAction.Run("MoveDocEnd")
    mf.ins(hwp, "위와 같이 신청합니다.")
    mf.newline(hwp)
    mf.ins(hwp, "신청일: ")
    field(hwp, "날짜를 입력", "신청일")


def build_template_braces(hwp):
    # {{키}} 서식: 같은 키를 쓰되 자리를 중괄호 표기로 적는다. 표 칸 안에도 둔다.
    mf.ins(hwp, "{{사업명}} 참가 신청서")
    mf.newline(hwp)
    mf.newline(hwp)
    mf.ins(hwp, "신청인: {{성명}} ({{소속}})")
    mf.newline(hwp)
    mf.ins(hwp, "연락처: {{연락처}}")
    mf.newline(hwp)
    mf.table_create(hwp, 2, 2)
    mf.type_cells(hwp, ["신청 사유", "{{신청사유}}", "비고", "{{비고}}"])
    hwp.HAction.Run("MoveDocEnd")
    mf.ins(hwp, "위와 같이 신청합니다.")
    mf.newline(hwp)
    mf.ins(hwp, "신청일: {{신청일}}")


EXAMPLES = {"template-fields": build_template_fields, "template-braces": build_template_braces}
FIELD_NAMES = {"template-fields": ("사업명", "성명", "소속", "연락처", "신청사유", "신청일")}
TOP = {
    "template-fields": ["참가 신청서", "", "사업명: 사업명을 입력", "", "위와 같이 신청합니다.", "신청일: 날짜를 입력"],
    "template-braces": ["{{사업명}} 참가 신청서", "", "신청인: {{성명}} ({{소속}})", "연락처: {{연락처}}", "", "위와 같이 신청합니다.", "신청일: {{신청일}}"],
}
CELLS = {
    "template-fields": {(0, 0): "성명", (0, 1): "이름을 입력", (1, 0): "소속", (1, 1): "소속을 입력", (2, 0): "연락처", (2, 1): "연락처를 입력", (3, 0): "신청 사유", (3, 1): "사유를 입력"},
    "template-braces": {(0, 0): "신청 사유", (0, 1): "{{신청사유}}", (1, 0): "비고", (1, 1): "{{비고}}"},
}
TOKENS = {"template-braces": ["{{사업명}}", "{{성명}}", "{{소속}}", "{{연락처}}", "{{신청사유}}", "{{비고}}", "{{신청일}}"]}


def patch_fixture_module():
    """make_fixtures 의 작업자·분석 함수가 이 예시 문서를 다루도록 모듈 전역을 바꿔 끼운다."""
    mf.OUT = OUT
    mf.BUILDERS = EXAMPLES
    mf.FIELD_NAMES = FIELD_NAMES
    mf.EXPECTED = {n: [t for t in TOP[n] if t] + list(CELLS[n].values()) for n in EXAMPLES}
    mf.EXPECTED_TOP = TOP
    mf.EXPECTED_CELLS = CELLS
    mf.EXPECTED_HF = {}
    mf.TOKENS = TOKENS


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
        return {"name": name, "ok": False, "error": "timeout %ds (작업자와 새 Hwp.exe 를 종료함)" % mf.DOC_TIMEOUT_SEC}
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
    patch_fixture_module()
    protect = {int(x) for x in args.protect.split(",") if x}
    if args.worker:
        return mf.run_worker(args.worker, protect)

    OUT.mkdir(parents=True, exist_ok=True)
    before = mf.hwp_pids()
    print("start: Hwp.exe 이미 떠 있던 프로세스 %d개(건드리지 않음)" % len(before))
    failures = 0
    for name in EXAMPLES:
        f = OUT / (name + ".hwpx")
        if f.exists():
            f.unlink()
        t0 = time.time()
        res = run_one(name, before)
        sec = round(time.time() - t0, 1)
        if not res.get("ok") or not f.exists():
            if f.exists():
                f.unlink()
            failures += 1
            print("FAIL %-16s %5.1fs  %s" % (name, sec, res.get("error")))
            continue
        entry = mf.analyze(name, f)
        if entry["exact_text_mismatches"]:
            f.unlink()
            failures += 1
            print("FAIL %-16s 의도한 글과 다름: %s" % (name, json.dumps(entry["exact_text_mismatches"], ensure_ascii=False)))
            continue
        fields = res.get("reopen_field_list")
        print(
            "ok   %-16s %5.1fs  pages=%s bytes=%d privacy_clean=%s fields=%s"
            % (name, sec, res["page_count"], entry["bytes"], entry["privacy_clean"], fields if fields is not None else "-")
        )
    left = mf.hwp_pids() - before
    mf.kill_pids(left)
    print("done: 실패 %d개, 남은 Hwp.exe %d개" % (failures, len(left)))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
