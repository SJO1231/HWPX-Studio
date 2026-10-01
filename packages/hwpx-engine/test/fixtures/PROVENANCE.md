# 시험 자료 출처

모두 합성 시험 문서다. 실제 업무 문서나 개인 문서가 아니다. 읽기 전용 사본이며 `SHA256SUMS`가 변경을 막는다.

- `D1.hwpx`: 합성 생성기로 만든 시험 문서(긴 문단, 목록, 여러 표, 특수문자).
- `D2.hwpx`: 합성 생성기로 만든 시험 문서.
- `D3.hwpx`: 합성 생성기로 만든 시험 문서.
- `D4.hwpx`: 합성 생성기로 만든 시험 문서.
- `D5.hwpx`: 합성 생성기로 만든 시험 문서.
- `D6.hwpx`: 합성 생성기로 만든 시험 문서.
- `D7.hwpx`: 합성 생성기로 만든 시험 문서.
- `hancom-merged.hwpx`: 합성 문서 둘을 한컴 오피스로 합쳐 저장한 것(문단마다 조판 캐시가 있다).
- `hancom-field.hwpx`: 한컴 오피스로 누름틀 하나를 만든 것(이름 `성명`, 값 `홍길동`).

위 두 한컴 저장본은 패키지 메타데이터의 작성자·최종 저장자 값을 `synthetic`으로 바꿨다(`tools/fixtures/scrub-metadata.ts`, 다른 항목은 바이트 그대로).

## `hancom/` — 한컴 오피스 13이 저장한 합성 문서 (`tools/com/make_fixtures.py`로 생성)

- `ph-single.hwpx`: 한 run 안의 `{{}}` 표기.
- `ph-mixed.hwpx`: 글자 서식이 중간에 바뀌어 `{{project.` / `name}}`으로 run이 갈린 표기, 한 `hp:t`로 합쳐진 표기, 탭을 사이에 둔 표기.
- `ph-table.hwpx`: 3행 2열 표. 라벨 칸과 `{{}}` 칸, 빈 칸(자기닫힘 run).
- `field-states.hwpx`: 누름틀 3개. 안내문 상태(`dirty="0"`) 2개(같은 이름)와 값이 든 것 1개.
- `picture.hwpx`: 그림 1개(`BinData/image1.png`).
- `blocks.hwpx`: 조건 삭제·삽입 시험용 문단들과 3행 3열 표.
- `header-footer.hwpx`: 머리말·꼬리말 안의 `{{}}` 표기.

## `extra/` — 다른 도구가 만든 합성 문서

- `features-picture.hwpx`: 그림·누름틀·책갈피·머리말·표가 든 문서. 머리말 문단 id가 중복된 상태라 검사기 시험에도 쓴다.
- `features-rhwp.hwpx`: 그림·책갈피·머리말·표가 든 문서.
