# 한컴 COM 으로 만든 합성 시험 문서

엔진 시험에 쓰는 HWPX 를 한컴 오피스(한글)가 직접 저장하게 해서 만든다. 문서 내용은 전부 지어낸 합성 자료다.
한컴이 글을 여러 run·`hp:t` 로 쪼개는 모양, 안내문 상태 누름틀, 그림이 든 문서의 실제 XML 을 얻으려는 것이 목적이다.

## 만드는 방법

```
python tools/com/make_fixtures.py
```

- 한컴 오피스와 Python 3.12 + pywin32(`HWPFrame.HwpObject` 등록)가 있는 Windows 에서만 돈다.
- 다시 실행하면 같은 문서를 다시 만든다. 한컴이 문서 ID·저장 시각을 새로 적으므로 sha256 은 매번 달라진다.
- 문서마다 작업자 프로세스를 따로 띄우고 60초 안에 끝나지 않으면 그 작업자와 그것이 띄운 `Hwp.exe` 를 종료한 뒤 그 문서를 실패로 기록한다(실패한 문서는 `out/` 에 남기지 않는다).
- 한컴 창은 숨기고, 작업자는 항상 `Quit()` 으로 끝낸다. 시작 전에 이미 떠 있던 `Hwp.exe` 의 PID 는 건드리지 않는다. 새 `Hwp.exe` 가 뜨지 않으면(기존 창에 붙었다면) `Quit()` 없이 멈춘다.
- 사용자 문서 폴더는 열지 않는다. 쓰는 곳은 `tools/com/out/` 와 그림용 임시 폴더(끝나면 지움)뿐이다.
- 각 문서를 저장한 뒤 다시 열어 `PageCount` 를 읽는다. 다시 연 결과가 `manifest.json` 의 `reopen` 이다.

## 산출물 (`out/`)

| 파일 | 내용 | 구역 XML 최상위 문단 |
|---|---|---|
| `ph-single.hwpx` | 서식 변화 없는 `{{...}}` 문단. `사업명: {{project.name}} 입니다.`, `기간: {{project.start}} ~ {{project.end}}` | 3 |
| `ph-mixed.hwpx` | 서식이 바뀌는 `{{project.name}}`, 두 번 나눠 넣은 `{{company.name}}`, 탭이 낀 `{{manager.name}}`·`{{manager.phone}}` | 3 |
| `ph-table.hwpx` | 제목 `신청서` + 3행 2열 표(`{{applicant.name}}`, 빈 칸, `{{note}}`) + `위와 같이 신청합니다.` | 3 (표 문단 포함) |
| `field-states.hwpx` | 누름틀 3개: 안내문 상태 `성명`, 값을 넣은 `소속`(`합성기관`), 안내문 상태 `성명`(같은 이름) | 3 |
| `picture.hwpx` | `그림 앞 문단` / 64x64 PNG 한 장 / `그림 뒤 문단` | 3 |
| `blocks.hwpx` | `1. 개요`… `2. 선택 조항`… 3행 3열 표 … `3. 끝` (조건 삭제·삽입 시험용) | 6 (표 문단 포함) |
| `header-footer.hwpx` | 머리말 `{{doc.title}}`, 본문 2문단, 꼬리말 `{{doc.owner}}` | 2 |
| `manifest.json` | 아래 항목 | |

`manifest.json` 의 문서별 항목: 파일명, 바이트 크기, sha256, `reopen`(열림 여부·쪽 수), ZIP 항목 목록, `BinData` 항목, 구역 XML 수치(`paragraphs`=`<hp:p` 전체 개수, 최상위 문단, run, `hp:t`, `fieldBegin`/`fieldEnd`, 표, 그림, 탭, 머리말, 꼬리말), 의도한 글이 구역 XML 에 있는지(`text_checks`: 원문 그대로 / 문단 안 `hp:t` 를 이어 붙였을 때), 최상위 문단별 run 목록, 문서별 `observations`.
의도한 글과 공백까지 같은지 비교해서 다르면 그 문서를 실패로 기록한다(`exact_text_mismatches`).

## 관측 (한컴 13.0.0.711 에서 저장한 모양)

- **쪼개짐**: 서식이 같으면 삽입 호출을 나눠도 한 `hp:t` 로 합쳐진다(`{{company.name}}`). 서식이 바뀌면 run 이 나뉜다. `ph-mixed` 의 `{{project.name}}` 은 `<hp:t>사업명: {{project.</hp:t>`(charPr 0) 와 `<hp:t>name}}</hp:t>`(굵게, charPr 7) 두 run 이다. 탭은 `hp:t` 안의 `<hp:tab/>` 요소라서 `담당: {{manager.name}}<hp:tab/>{{manager.phone}}` 이 한 `hp:t` 안에 있다.
- **빈 run 과 빈 `hp:t`**: 첫 문단 첫 run 에는 `secPr`·`colPr` 이 들어 있고 글이 없다. 표·그림·필드 끝에는 `<hp:t/>` 가 붙는다. 빈 표 칸은 `<hp:run charPrIDRef="0"/>` 하나로 `hp:t` 가 없다.
- **누름틀**: `fieldBegin type="CLICK_HERE"`. 안내문 상태는 `dirty="0"` 이고, **`fieldBegin` 과 `fieldEnd` 사이에 안내문이 그대로 `hp:t` 로 들어 있다**(`이름을 입력`, 빨강 기울임 charPr). 값을 `PutFieldText` 로 넣으면 `dirty="1"` 이고 사이 `hp:t` 는 값(`합성기관`, 본문과 같은 charPr)이다. 안내문은 `hp:parameters` 의 `Direction` 과 `Command` 문자열에도 들어 있다. 같은 이름 `성명` 두 개는 `id` 만 다른 별개의 `fieldBegin` 이다. 한컴으로 다시 열어 `GetFieldText("성명")` 은 `""`(안내문 상태), `GetFieldText("소속")` 은 `합성기관`.
- **그림**: `BinData/image1.png`. `Contents/content.hpf` 의 `<opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1" hashkey="..."/>` 로 등록되고, 구역 XML 에서는 `hp:pic` 안 `<hc:img binaryItemIDRef="image1"/>` 가 가리킨다. `hp:pic` 은 `treatAsChar="1"`, `shapeComment` 에 원본 파일 이름이 들어간다(`synthetic-64x64.png`).
- **머리말·꼬리말**: `hp:header`·`hp:footer` 는 첫 문단 첫 글 run 안의 `hp:ctrl` 로 있고, 안의 `hp:subList > hp:p` 에 글이 있다. 적용 쪽은 `applyPageType="BOTH"`.
- **표**: 표가 든 문단은 최상위 문단 하나이고, 표 칸 안 문단은 `hp:tbl > hp:tr > hp:tc > hp:subList > hp:p` 로 중첩된다(그래서 `paragraphs` 는 최상위 문단 수보다 크다).

## 만들면서 알게 된 한컴 COM 동작

- `CreateField` 뒤 캐럿이 누름틀 **안**에 남는다. 그대로 `BreakPara` 나 글 입력을 하면 필드가 문단에 걸쳐 갈라지거나 다음 글이 필드 안으로 들어간다. `MoveLineEnd` 로 줄 끝에 나가야 한다.
- 문단 끝이 ` 입니다` 인 채로 Enter(`BreakPara`)를 치면 한컴이 그 앞 공백을 지운다(`}} 입니다.` → `}}입니다.`). `ph-single` 은 둘째 문단을 Enter 없이 마지막에 채워 공백을 지키게 했다.
- `HeaderFooter` 동작은 머리말을 만들고 편집 상태로 들어가지만 `Type` 항목은 적용 쪽(0 양쪽, 1 짝수, 2 홀수)이고 꼬리말은 고르지 못했다. 꼬리말은 `InsertCtrl("foot")` 으로 만든 뒤 `SetPos` 와 `ParentCtrl` 로 꼬리말 안에 들어가 썼다. 그래서 머리말 문단은 한컴의 머리말 스타일(`paraPrIDRef="9"`, `styleIDRef="14"`)이고 꼬리말 문단은 본문 스타일(0, 0)이다.
- 표를 문서 끝 빈 문단에 만들면 한컴이 표 뒤에 빈 문단을 하나 둔다. `MoveDocEnd` 로 그 문단에 나가 이어 쓴다. 표는 `treatAsChar="0"`(글자처럼 취급 안 함)으로 저장된다.

## 한컴이 저장한 것에서 바꾼 것

한컴은 `Contents/content.hpf` 에 작성자·마지막 저장자로 이 PC 의 사용자 이름을 적는다. 그 두 값(`creator`, `lastsaveby`)만 `synthetic` 으로 바꿔 ZIP 을 다시 묶는다(항목 순서·압축 방식 유지, `mimetype` 은 첫 항목에 무압축). 구역·머리 XML 은 한컴이 저장한 그대로다. 바꾼 뒤 한컴으로 다시 열어 쪽 수를 읽는다. 문서 제목(`opf:title`)은 한컴이 첫 문단 글로 채운 값이다.
스크립트는 사용자 이름·임시 폴더·작업 폴더 경로가 산출물 어느 항목에도 남아 있지 않은지 검사해 `privacy_clean` 으로 기록한다.

## 한계

- 한컴 13.0.0.711 한 가지 버전에서만 만들었다. 버전이 다르면 run 나뉨·`dirty` 등이 다를 수 있다.
- 문서 안 글자 서식은 굵게 하나뿐이다. 글꼴·크기 변화, 필드 안 서식 변화, 머리말·꼬리말 쪽별 적용 같은 모양은 만들지 않았다.
