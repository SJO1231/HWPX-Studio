# 2판 템플릿 시험 자료 출처

모두 이 저장소에서 직접 지어낸 합성 JSON이다. 실제 문서·사람·기관·업무 정보가 없다. 해시(`sha256`)는 `synthetic:<설명>` 글의 해시이고 실제 원본·조각과 대응하지 않는다.

- `notice.template.json`: 명세 8.8.2 예시 1을 바탕으로 한 2판 템플릿(값 3개, 자리 3개, 슬롯 1개, 원형 2판을 고정한 블록과 글 블록).
- `form.template.json`: 값 31개(쓰이지 않는 값 1개 포함), 자리 41개(본문 `{{}}`·메일머지·누름틀·낱말·줄·셀), 앵커 12개(1판 5종·range·mergeField, cell·object 지문), 패턴 2개, 슬롯 3개, 블록 7개(원형 3판 고정·분기 포함), `origin`이 있는 2판 템플릿.
- `proto-v2.json`, `proto-v3.json`: 명세 8.8.7 예시 2를 바탕으로 한 원형 `k7d20a4e1`의 2판·3판.
- `notice.case.json`: 명세 8.8.9 예시를 바탕으로 한 `notice.template.json`의 이번 건. `template.sha256`은 그 템플릿의 정규 JSON 해시다(`record.sha256`은 합성 행의 해시).
- `legacy-v1.template.json`: 명세 8.2 예시의 1판 템플릿(승계 읽기 시험용).
