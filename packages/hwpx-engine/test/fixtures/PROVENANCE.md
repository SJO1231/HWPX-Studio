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

## `tables/` — 한컴 오피스가 저장한 표 시험 문서 (`tools/com/make_fixtures.py --only tables-merged,tables-inline,tables-nested,tables-rich`로 생성)

기존 시험(`package.test.ts`·`xml.test.ts`)이 `""`, `hancom/`, `extra/`의 문서 수를 고정하므로 표 시험 문서는 따로 이 폴더에 둔다. 해시는 이 폴더의 `SHA256SUMS`에 있다.

- `tables-merged.hwpx`: 4행 3열 표. 가로 병합(첫 행 1·2열)과 세로 병합(3열 2·3행)이 든다. 글자처럼 취급 아님.
- `tables-inline.hwpx`: 글자처럼 취급(`treatAsChar="1"`)인 2행 3열 표. 표 앞뒤에 문단이 있다(셀에 긴 조각을 넣는 시험용).
- `tables-nested.hwpx`: 2행 2열 바깥 표의 한 셀 안에 2행 2열 안쪽 표가 든다(둘 다 글자처럼 취급 아님).
- `tables-rich.hwpx`: 3행 3열 표. 셀 안에 누름틀과 그림이 든다.

한컴은 표 만들기의 마지막 설정을 기억하므로 `글자처럼 취급`을 항상 명시해 만든다. 패키지 메타데이터는 `tools/fixtures/scrub-metadata.ts`로 정리했다.

## `inline/` — 한컴 오피스가 저장한 줄바꿈·탭 문서 (`tools/com/make_fixtures.py --only inline-breaks`로 생성)

값의 줄바꿈·탭을 엔진이 넣는 요소의 모양을 한컴이 저장한 것에서 얻으려고 만들었다. 한컴이 `hp:t` 안에 쓰는 줄바꿈 요소(속성 없음)와 탭 요소(`width`·`leader`·`type`)가 본문 문단, 누름틀 안, 표 칸 안에 있다. 기존 시험이 `""`, `hancom/`, `extra/`의 문서 수를 고정하므로 따로 이 폴더에 둔다. 해시는 이 폴더의 `SHA256SUMS`에 있다.

- `inline-breaks.hwpx`: 문단 7개(`첫 줄`+줄바꿈+`둘째 줄`, 탭이 든 문단 둘, 줄바꿈이 든 누름틀 `줄`, 탭이 든 누름틀 `탭`, 표, `끝`)와 1행 2열 표(첫 칸에 줄바꿈).

패키지 메타데이터는 `tools/fixtures/scrub-metadata.ts`로 정리했다(작성자·최종 저장자를 `synthetic`으로).

## `span/` — 한컴 오피스가 저장한 여러 문단 누름틀 문서와 한컴이 직접 채운 정답 (`tools/com/make_span_fixtures.py`로 생성)

여러 문단에 걸친 누름틀과 줄바꿈·탭 요소가 든 누름틀을 한컴이 어떻게 채우는지 관측하려고 만들었다. `*-filled.hwpx`는 같은 한컴이 원본을 열어 `PutFieldText`로 값을 넣고 저장한 것이라 엔진 결과의 정답지로 쓴다(바이트 동일은 기대하지 않고 문단 수·글·누름틀 값·표 수를 대조한다). 해시는 이 폴더의 `SHA256SUMS`에 있다.

- `field-span.hwpx`: 본문에서 세 문단에 걸친 누름틀 `성명`(누름틀 안에서 Enter를 친 서식. 시작 문단에 "성명: " 접두 글, 끝 표식 뒤에 " 끝 뒤 글"). `field-span-filled.hwpx`: 값 "새 값"을 넣은 결과. 최상위 문단 5 → 3, 글은 "성명: 새 값 끝 뒤 글"로 합쳐진다.
- `field-span-table.hwpx`: 문단·표 문단·문단을 블록으로 잡고 만든 누름틀 `성명`(사이에 1행 2열 표). `field-span-table-filled.hwpx`: 값 "새 값"을 넣은 결과. 최상위 문단 5 → 3, 사이의 표가 사라진다.
- `field-span-cell.hwpx`: 1행 2열 표의 첫 칸 안에서 두 문단에 걸친 누름틀 `칸`. `field-span-cell-filled.hwpx`: 값 "새 칸 값"을 넣은 결과. 칸의 두 문단이 하나로 합쳐진다.
- `inline-breaks-filled.hwpx`: `inline/inline-breaks.hwpx`의 누름틀 `줄`·`탭`을 "다시 넣은 값"·"탭 다시"로 채운 결과. 옛 줄바꿈·탭 요소가 사라지고 값만 남는다.

패키지 메타데이터는 작성자·최종 저장자를 `synthetic`으로 바꿨다. 한컴의 `GetFieldText`는 문단 경계를 CRLF로 주고 줄바꿈 요소는 글자로 주지 않는다.

## `merge/` — 한컴 오피스 13이 저장한 메일 머지 필드 서식 (`tools/com/make_merge_fixtures.py`로 생성)

기존 시험이 `""`, `hancom/`, `extra/`의 문서 수를 고정하므로 따로 이 폴더에 둔다. 해시는 이 폴더의 `SHA256SUMS`에 있다.

- `merge-fields.hwpx`: 합성 공고서 서식. 메일 머지 필드(`fieldBegin type="MAILMERGE"`) 33개(머리말 2·꼬리말 3·본문 28, 같은 키 여러 번, 경로 꼴이 아닌 키 4곳), 누름틀 4개, `{{경로}}` 글 8곳. 필드는 한컴의 `MailMergeInsert` 동작으로 넣었다(type을 고쳐 쓰지 않았다). 표시 글이 안내 글 꼴인 필드 8개는 한컴이 저장한 뒤 그 `hp:t`의 글만 XML로 바꿨다(한컴은 필드 안의 글을 편집하지 못한다). 한컴 13.0.0.711로 다시 열어 쪽 수 1을 확인했다. 모두 지어낸 글이고 실제 업무 문서의 이름·키·값이 아니다.

패키지 메타데이터는 작성자·최종 저장자를 `synthetic`으로 바꿨다.
