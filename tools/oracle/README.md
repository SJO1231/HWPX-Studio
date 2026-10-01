# 검증용 보조 스크립트 (tools/oracle)

선택 실행이다. 엔진 동작에는 필요 없고, 없으면 해당 시험을 건너뛴다(통과가 아니라 미검증이다).

## validate_refs.py

- `hwpx-edit/validate_refs.py`(이 프로젝트의 기존 Python 검사기)의 사본이다. 내용을 고치지 않는다. 원본이 바뀌면 다시 복사한다.
- 표준 라이브러리만 쓰고 파일을 읽기만 한다.
- 실행: `python tools/oracle/validate_refs.py [--strict] [--quiet] [--json 출력.json] 파일.hwpx ...`
  - 종료 코드: 오류 없음 0, 있음 1, ZIP으로 열 수 없는 입력이 있으면 2.
- 쓰는 곳: `packages/hwpx-engine/test/validate.test.ts`
  - V1: 시험 문서 18개(`fixtures/` 9, `fixtures/hancom/` 7, `fixtures/extra/` 2)를 `--strict` 유무로 각각 돌려 TS 검사기와 오류·경고 코드별 개수를 대조한다.
  - V2: 반례 26건을 임시 폴더에 쓰고 같은 방식으로 대조한다.
  - 대조 단위는 코드별 (합쳐진 항목 수, 발생 횟수 합)이다. 8.1절이 더한 검사 4종(`PKG_SECCNT_MISMATCH`, `XML_ILLEGAL_CHAR`, `PKG_NO_PREVIEW_TEXT`, `TBL_ATTR_MISSING`)은 Python에 없으므로 뺀다.
  - 결과 JSON은 OS 임시 폴더에 쓰고 시험이 끝나면 지운다. Python이 없으면 두 시험 모두 건너뛴다.
