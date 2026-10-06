# hwpx 명령줄 도구 (apps/cli)

HWPX 문서와 Markdown·텍스트 문서를 검사하고 채우는 명령줄 도구다. Node 24만 쓰고 제3자 패키지가 없다. 파일 읽기·쓰기는 이 폴더에만 있고, 엔진(`packages/hwpx-engine`)은 파일을 열지 않는다.

저장소 루트에서 `node apps/cli/src/main.ts <명령> [옵션]`으로 실행한다. 아래 예시는 이를 `hwpx`로 줄여 쓴다. `hwpx --help`가 전체 사용법이다.

## 명령

| 명령 | 한 줄 설명 | 받는 형식 |
| --- | --- | --- |
| `inspect` | 구역·문단·표·누름틀·메일 머지 필드(종류와 키)·`{{}}`·자원 요약. md·txt는 블록·표·코드 블록 수와 `{{}}` 목록 | `.hwpx` `.md` `.txt` |
| `candidates` | 채울 자리 후보 목록(누름틀, `{{}}`, 빈 값 셀, `라벨:` 뒤 빈 곳 등) | `.hwpx` |
| `headings` | 제목 목록(번호 글자 꼴·단계·글 앞 40자. 표 칸 안 포함) | `.hwpx` |
| `fragment extract` | 문단 구간을 조각 JSON으로 뜬다 | `.hwpx` |
| `fragment import` | 조각 JSON을 다른 문서의 문단 앞·뒤나 표 셀 안에 가져온다(저장 게이트 포함) | `.hwpx` |
| `block extract` | 범위·제목 범위를 블록(원형 1판 + 조각 덩어리)으로 떼어 저장소 폴더에 저장한다 | `.hwpx` |
| `block insert` | 저장소의 블록을 다른 문서의 문단 앞·뒤나 범위 자리에 넣는다(저장 게이트 포함, 서식이 다르면 경고만) | `.hwpx` |
| `block list` | 저장소의 블록 목록(id·판·이름·출처·마지막 기록) | — |
| `fill` | 데이터로 `{{}}`·누름틀·메일 머지 필드(키 = 데이터 경로)를 채우고 템플릿 규칙(채움·삭제·삽입·조각 주입·표 설정·표 크기·행 반복)을 적용한다. `.hwpx`는 `--batch`로 데이터 배열의 원소마다 결과 파일을 만든다 | `.hwpx` `.md` `.txt` |
| `table list` | 표마다 위치·행×열·너비·글자처럼 취급·쪽 나눔·제목 행 반복·병합 수를 낸다(글 내용은 없다) | `.hwpx` |
| `table set` | 최상위 표 하나의 설정(글자처럼 취급·쪽 나눔·제목 행 반복)과 크기(너비·비율·열 너비)를 바꾼다(저장 게이트 포함) | `.hwpx` |
| `validate` | 참조 무결성·인스턴스 중복·패키지 구조를 검사한다(`--baseline`으로 원본과 대조) | `.hwpx` |
| `diff` | 두 문서를 항목별로 견주고 수량 증감을 낸다 | `.hwpx` |
| `compile` | `{{}}`를 누름틀로 승격한다(실험: `--experimental` 필수). `--merge-fields to-placeholder`는 메일 머지 필드를 `{{키}}` 글로, `to-field`는 누름틀(이름 = 키)로 바꾼다(`{{}}` 승격은 하지 않고 변환만 한다. 키가 데이터 경로 꼴이 아닌 필드는 그대로 두고 경고) | `.hwpx` |

`.md`·`.txt`는 `inspect`와 `fill`만 받는다. 다른 명령에 주면 종료 코드 2와 안내가 나온다.

## 종료 코드

| 코드 | 뜻 |
| --- | --- |
| 0 | 성공 |
| 1 | 검사·저장 게이트 실패(출력 파일은 만들지 않는다) |
| 2 | 사용법 오류, 읽을 수 없는 입력(없는 파일, 깨진 JSON·템플릿·데이터, ZIP이 아닌 `.hwpx`, UTF-8이 아닌 `.md`·`.txt`) |

## 출력 파일 안전 규칙

- 출력 경로(`-o`, `--report`, `--model`)가 입력(문서, 데이터, 템플릿, 템플릿이 가리키는 조각 파일)과 같으면 거부한다.
- 이미 있는 파일은 `--overwrite` 없이는 거부한다. 출력 폴더가 없어도 거부한다.
- 같은 폴더의 임시 파일에 쓴 뒤 이름을 바꾼다. 실패하면 아무 파일도 남기지 않는다(`--overwrite`로 덮어쓰는 경우에도 이름을 바꾸기 전까지 기존 파일은 그대로다).
- 보고서와 화면 출력에는 값 원문을 넣지 않는다(길이와 해시 앞 8자만).

## 예시

문서 안 `{{project.name}}` 같은 표기를 데이터로 채운다. `data.json`은 `{ "project": { "name": "알파" } }` 같은 일반 JSON이다.

```
hwpx fill form.hwpx --data data.json -o filled.hwpx
hwpx fill form.hwpx --data data.json --dry-run                 # 출력 없이 필요한 데이터 경로만 확인
hwpx fill form.hwpx --data data.json -o filled.hwpx --report report.json
hwpx fill form.hwpx --data data.json -o filled.hwpx --mode strict --missing empty
```

템플릿 없이도 **누름틀**을 채운다: 템플릿이 없거나 템플릿에 그 누름틀을 가리키는 규칙(조건이 거짓인 것도)이 없으면, 이름이 데이터 경로 문법(`이름(.이름)*`, 이름은 글자·숫자·`_`·`-`)에 맞는 누름틀은 "이름 = 데이터 경로"로 채운다(`{{}}`와 같은 자리에서 같은 누락 정책·같은 보고. 같은 이름의 누름틀은 전부 같은 값). 이름이 경로가 아닌 누름틀(공백·기호가 든 이름, 이름이 빈 것)은 `건너뜀 [FIELD_NAME_NOT_PATH]`로 보고하고 그대로 둔다. 채울 수 없는 모양의 누름틀(`FIELD_UNSUPPORTED_SHAPE`)도 암묵 채움에서는 오류가 아니라 건너뜀이다.

채운 자리가 하나도 없으면(적용된 액션 0) 원본 복사본을 내지 않고 `FILL_NOTHING_APPLIED`로 종료 코드 1이다(출력 파일 없음, `--report`는 쓰고 건너뜀 사유가 오류 메시지에 든다). `--batch`에서는 그 건만 실패로 센다. md·txt는 지금처럼 채울 것이 없어도 원문 그대로 낸다.

누락 키는 기본(`--missing error`)이면 종료 코드 1로 멈춘다. `--missing empty`는 빈 글로, `--missing keep`은 자리를 그대로 둔다. `--mode`는 `.hwpx` 전용이고(`baseline` 기본, `strict`, `repair`), `--report`는 게이트가 실패해도 쓴다.

값에 줄바꿈·탭이 있으면 `.hwpx`는 문단을 나누지 않고 글 안에 줄바꿈 요소·탭 요소로 넣는다(`\r\n`·`\r`은 `\n`으로 맞춘다. 한컴이 저장한 줄바꿈·탭과 같은 요소다). 누름틀·`{{}}`·낱말·문단·셀·행 반복의 값에 모두 적용된다. 그 밖의 제어 문자(`U+0000`~`U+001F` 가운데 탭·줄바꿈·`\r` 말고)는 `VALUE_CONTROL_CHAR`로 거절한다. `insertText`는 줄바꿈마다 문단을 나누고 탭은 거절한다. md·txt는 줄바꿈·탭이 든 값을 지금처럼 거절한다.

```
hwpx fill form.hwpx --data data.json -o filled.hwpx        # data.json 값에 "첫 줄\n둘째 줄"이 있어도 된다
```

여러 문단에 걸친 누름틀(같은 본문이나 같은 표 칸 안의 서로 다른 문단에 시작·끝 표식이 있는 것)은 한컴처럼 채운다: 값은 첫 문단에 들어가고, 사이 문단(표가 든 문단 포함)과 시작 문단 꼬리·끝 문단 머리의 표·그림·책갈피·쪽 번호 같은 개체는 함께 지워지며, 끝 표식 뒤의 글은 첫 문단에 이어 붙고, 첫 문단의 문단 속성은 그대로다. 합쳐서 지운 문단 수는 `경고 [FIELD_PARAGRAPHS_MERGED]`("누름틀 <이름>이 걸친 문단 N개를 합쳤고 사이의 문단 M개를 지웠습니다(그 안의 표 T개 포함).")로 알린다(종료 코드는 바뀌지 않고, `--batch`에서는 건마다 `  경고 [코드] 메시지` 줄로 나온다). 구간 안에 통째로 든 다른 필드·책갈피도 함께 지워지고 채움 계획의 `버림` 수에 든다. 탭·줄바꿈이 든 누름틀(줄바꿈이 든 값으로 한 번 채운 것 포함)도 안의 글 전체를 새 값으로 바꾼다. 그림·표가 든 누름틀(같은 문단 안), 시작은 표 칸 안이고 끝은 칸 밖인 것처럼 끝 표식이 다른 칸·구역에 있는 누름틀, 지워질 구간에 구역 설정이 있거나 다른 필드의 짝이 끊기거나 형광펜·변경 추적 표식의 짝이 구간 밖으로 이어지는 누름틀은 여전히 건너뛴다(`FIELD_UNSUPPORTED_SHAPE`). 지워지는 구간 안을 가리키는 템플릿 규칙(채움·삽입·주입·표 설정·삭제·행 반복)은 규칙 순서와 상관없이 `TPL_CONFLICT`다.

### 여러 건 만들기 (`--batch`)

데이터 JSON의 최상위가 배열이거나(`[ {...}, {...} ]`) 묶음 형식(`hwpx-studio/dataset@1`)의 `data`가 배열이면 원소마다 결과 파일 하나를 만든다. `--batch`를 주고 `-o`에는 **이미 있는 폴더**를 준다.

```
hwpx fill form.hwpx --data list.json --batch -o results
hwpx fill form.hwpx --data list.json --batch -o results --name "{{id}}" --report batch-report.json
hwpx fill form.hwpx --data list.json --batch --dry-run         # 파일 없이 건별 성공·실패만 본다
```

- 데이터가 배열인데 `--batch`가 없으면 "여러 건 데이터입니다. --batch를 쓰십시오"와 함께 종료 코드 2다. 배열이 아닌데 `--batch`를 주거나 md·txt에 `--batch`를 주어도 2다. 묶음 형식이면 `derived`는 모든 건이 함께 쓴다. 원소가 JSON 객체가 아니면 그 건만 `DATA_SCHEMA`로 실패한다.
- 파일 이름은 기본 `<원본 이름>-<번호 3자리>.hwpx`(`form-001.hwpx`부터). `--name "{{경로}}"`를 주면 그 원소의 값(문자열·숫자)을 쓴다. 표기 하나가 글 전체여야 한다. 파일 이름에 못 쓰는 문자(`< > : " / \ | ? *`와 제어 문자)와 경로 구분자는 `_`로 바꾸고, 앞뒤 공백과 뒤쪽의 `.`은 떼며, 100자까지만 쓰고, Windows 장치 이름(`CON`, `NUL`, `COM1` …)에는 `_`를 붙인다. 값이 없거나 비거나 문자열·숫자가 아니면 기본 이름을 쓴다. 같은 이름(대소문자 무시)이 또 나오면 뒤에 `-2`, `-3`을 붙인다.
- 같은 이름의 파일이 폴더에 있으면 `--overwrite` 없이는 **아무 파일도 만들기 전에** 거부한다(종료 코드 2). 원본·데이터·템플릿 파일과 같은 경로, 보고서와 같은 경로도 거부한다. 건마다 같은 폴더의 임시 파일에 쓴 뒤 이름을 바꾼다.
- 한 건이 실패해도(누락 키, 제어 문자, 게이트 실패) 나머지는 만든다. 실패한 건의 파일은 없고(`--overwrite`로 다시 돌릴 때 전 실행이 남긴 같은 이름의 파일이 있으면 지우고 `이전 결과 파일을 지웠습니다`라고 알린다. `--dry-run`이면 지우지 않는다), 하나라도 실패하면 종료 코드 1이다. 데이터가 0건이면 파일 없이 종료 코드 0이다. 입력 문서를 열 수 없으면 종료 코드 2다.
- `--template`, `--missing`, `--mode`, `--reissue-internal`은 건마다 같게 적용된다. 같은 입력은 같은 바이트(파일도 보고서도)다.
- 건마다 한 줄(`성공 001 form-001.hwpx (채움 3, 건너뜀 0)`, 실패는 오류 코드와 메시지)과 마지막에 요약을 낸다. 값 원문은 없다.
- `--report`는 JSON 하나다: `{ batch, ok, dryRun, total, succeeded, failed, items: [{ index, name, ok, filled, skipped: [{ code, anchor, message }], warnings: [{ code, message, anchor? }], errorCodes, errors: [{ code, message }] }] }`. `filled`는 채움 액션이 채운 자리 수(템플릿의 채움 규칙, 문서 안 `{{}}`, 이름이 데이터 경로인 누름틀의 암묵 채움을 모두 센다), 실패한 건은 0이다. `warnings`는 그 건의 계획 단계 경고(예: 여러 문단에 걸친 누름틀을 채우며 문단을 합친 `FIELD_PARAGRAPHS_MERGED`)이고 없으면 빈 배열이다. 값 원문은 없다(`name`은 `--name` 값에서 온 파일 이름이다).

### 2판 템플릿 (`--template`이 `hwpx-studio/template@2`)

템플릿 파일의 `schema`가 2판이면 `fill`은 2단계로 만든다(엔진의 `generateFromTemplate`, 앱과 같은 함수·같은 바이트): 원본 해시를 템플릿의 `source.sha256`과 대조하고, 슬롯마다 고른 블록(조각·글)으로 슬롯 앵커를 바꾼 뒤(1단계), 그 결과를 다시 읽어 등록한 자리(누름틀·메일 머지 필드·`{{ 키 }}`·낱말·줄·칸)를 값으로 채운다(2단계). `--data`는 한 건(JSON 객체), `--case`는 이번 건(`case@1`: 수동 선택·값 정정·블록 수정. 없으면 선택을 전부 조건으로 계산), `--blobs`는 조각 덩어리를 `<sha256>.json`으로 담은 폴더다. 원본은 `.hwpx`나 `.md`다. 원본 해시가 다르면(`TPL_SOURCE_MISMATCH`), 정해지지 않은 슬롯이 있으면(`SEL_*`), 등록되지 않은 `{{ }}`가 있으면(`PLACE_UNREGISTERED`, 템플릿 `options.unregistered: keep`이면 경고), 건너뛴 자리가 하나라도 있으면(`FILL_SKIPPED`), 템플릿 앵커가 원본에서 지문대로 찾아지지 않으면(`ANCHOR_*`) 종료 코드 1이고 출력 파일이 없다(`--report`는 쓴다). 블록 교체 범위 안의 낱말·줄·칸 자리는 빠지고 `빠진 자리 [PLACE_COVERED]`로 알린다(실패가 아니다). 템플릿·이번 건을 읽을 수 없거나 템플릿 블록이 가리키는 덩어리 파일이 `--blobs` 폴더에 없으면(읽기 단계의 `TPL_FRAGMENT_MISSING`) 종료 코드 2다. 이번 건의 블록 수정(`blockEdits`)이 가리키는 덩어리가 없거나, 어느 덩어리든 받은 바이트의 해시가 파일 이름의 해시와 다르면 생성 단계의 `TPL_FRAGMENT_MISSING`으로 종료 코드 1이고 출력 파일이 없다. 덩어리 파일은 입력이라 출력 경로로 쓸 수 없다. `--batch`·`--name`·`--mode`·`--missing`·`--reissue-internal`·`--fill-in-code`는 2판 템플릿과 함께 쓸 수 없다(2). `--template`이 1판(`@1`)이면 위의 `fill` 그대로이고 `--case`·`--blobs`를 주면 2다.

```
hwpx fill notice.hwpx --template notice.t2.json --data row.json --case row.case.json --blobs blobs -o out.hwpx --report r.json
hwpx fill notice.hwpx --template notice.t2.json --data row.json --case row.case.json --blobs blobs --dry-run   # 출력 없이 선택·자리 보고만
```

Markdown·텍스트도 같은 데이터·템플릿으로 채운다. UTF-8만 받고 BOM과 줄바꿈 방식(LF·CRLF)은 그대로 둔다.

```
hwpx inspect notice.md --json
hwpx fill notice.md --data data.json -o notice-filled.md
hwpx fill notes.txt --data data.json --template template.json -o notes-filled.txt
hwpx fill notice.md --data data.json -o notice-filled.md --fill-in-code   # 코드 블록 안의 {{}}도 채움(기본은 그대로)
```

`--mode`와 `--reissue-internal`은 md·txt에 쓸 수 없고(종료 코드 2), `--fill-in-code`는 md·txt에만 쓴다. 템플릿의 `inject`가 가리키는 조각 파일 경로는 템플릿 파일이 있는 폴더 기준이다(md·txt 조각은 `{ "schema": "hwpx-studio/text-fragment@1", "blocks": [...] }`).

md의 표에는 `repeat`가 된다(`cell` 앵커가 가리키는 행을 배열 원소마다 한 줄로 복제하고 `{{item.이름}}`·순번을 채운다. 0개면 그 행을 지우고, 머리행은 거절한다). `tableProps`·`resize`는 텍스트 문서에 표 설정·크기가 없어 적용하지 않고 `건너뜀 [TEXT_NOT_APPLICABLE]`로만 남는다(오류가 아니라서 같은 템플릿을 `.hwpx`와 `.md`에 함께 쓸 수 있다). `inject`의 `fitTable`은 무시한다.

```
hwpx fill form.hwpx --data data.json --template template.json -o filled.hwpx
```

표를 살피고 바꾼다. `table list`는 표마다 한 줄을 낸다(`구역:순번 위치 [문단 주소] 행×열, 너비, 글자처럼 취급, 쪽 나눔, 제목 행 반복, 병합 셀 수`). 표 안의 글은 출력하지 않는다. `--json`이면 같은 수치를 배열로 낸다. 구역 최상위 문단에 든 표는 `구역:순번`(템플릿 `object` 앵커의 `ordinal`과 같은 번호)이 있고, 다른 표 안에 든 중첩 표는 순번이 `-`(JSON은 `null`)이며 `table set`으로 지정할 수 없다.

```
hwpx table list form.hwpx
hwpx table list form.hwpx --json
hwpx table set form.hwpx --table 0:1 --treat-as-char off --page-break cell --repeat-header on -o out.hwpx
hwpx table set form.hwpx --table 0:1 --scale 0.8 -o out.hwpx          # 표 너비와 열을 0.8배로(합은 정확히 맞는다)
hwpx table set form.hwpx --table 0:1 --width 40000 -o out.hwpx        # 표 너비를 40000 HWPUNIT으로, 열은 비례
hwpx table set form.hwpx --table 0:1 --columns 10000,20000,10000 -o out.hwpx --report r.json
```

`table set`은 내부에서 규칙이 하나나 둘뿐인 템플릿(`tableProps`, `resize`)을 만들어 `fill`과 같은 저장 게이트를 거친다. 그래서 `--mode`(`baseline` 기본, `strict`, `repair`), `--report`, `--overwrite`, 종료 코드(0 성공, 1 게이트 실패, 2 사용법·읽을 수 없는 입력), 출력 덮어쓰기 금지 규칙이 `fill`과 같다. `--width`·`--scale`·`--columns`는 하나만 줄 수 있고(열 수는 표의 `colCnt`와 같아야 한다), 설정 하나도 주지 않으면 사용법 오류다. 문서 안 `{{}}` 표기는 건드리지 않는다. 표의 격자가 불규칙하거나(구조), 행마다 열 경계의 위치가 어긋나(너비 불규칙; `table list`가 "너비 불규칙"으로 알리고 JSON은 `structureRegular`·`widthRegular`를 준다) `--scale`·`--width`가 열 너비를 필요로 하거나, 너비 기준이 절대값이 아니면 게이트가 `TABLE_IRREGULAR`·`TABLE_RELATIVE_SIZE`로 막고 출력 파일을 만들지 않는다(`--columns`는 새 너비를 주므로 너비 불규칙인 표에도 된다). 행 반복·셀 설정 같은 나머지 표 조정은 템플릿 규칙(`tableProps`, `resize`, `repeat`)으로 `fill`에 준다.

조각을 뜨고 다른 문서에 가져온다. 주소는 구역 번호(`--section`)와 그 목록 안 문단 서수(`--index`)다. 표 셀 안은 `--parent 문단.하위목록`으로 가리킨다. `--range 구역:시작-끝`을 주면 그 범위의 문단들(0부터 세는 포함 범위, 같은 목록 안)을 지우고 그 자리에 조각을 넣는다(범위 교체. `--section`·`--index`·`--before`와 함께 쓸 수 없다). 범위 안에 구역 설정이 든 문단이 있거나 범위가 누름틀을 가운데에서 자르면 게이트가 막는다(종료 코드 1, 출력 없음).

```
hwpx fragment extract source.hwpx --section 0 --from 3 --to 5 -o fragment.json
hwpx fragment import target.hwpx fragment.json --section 0 --index 2 -o merged.hwpx
hwpx fragment import target.hwpx fragment.json --section 0 --index 2 --before -o merged.hwpx
hwpx fragment import target.hwpx fragment.json --section 0 --index 2 -o merged.hwpx --report import-report.json
hwpx fragment import target.hwpx fragment.json --range 0:18-21 -o merged.hwpx                 # 구역 0의 문단 18~21을 조각으로 교체
hwpx fragment import target.hwpx fragment.json --range 0:2-4 --parent 12.1 -o merged.hwpx      # 표 셀 안(문단 12의 하위 목록 1)의 문단 2~4를 교체
```

템플릿(`fill --template`)에서는 같은 일을 `range` 앵커로 한다(`{ "kind": "range", "at": { "sectionIndex": 0, "parentPath": [] }, "from": 18, "to": 21, "print": { ... } }`. 지문 `print`는 엔진의 `makeRangeAnchor`가 채운다). `inject`·`insertText`는 `position: "replace"`(범위 교체)·`"before"`·`"after"`를, `delete`는 범위 삭제를 받는다. 원본에서 범위의 글이 바뀌어 있으면 `ANCHOR_CHANGED`로 막는다. 보고서의 `report.plan.moves`가 교체·삭제·삽입으로 뒤 문단 번호가 얼마나 움직였는지 적는다(항목 `{ sectionIndex, parentPath, from, to, count, delta }`, 원본 좌표).

제목을 찾아 제목 범위 앵커(`headingRange`)를 만든다. `headings`는 제목마다 한 줄(`구역:상위주소:문단 번호  단계  꼴  글 앞 40자`)을 낸다. 상위 주소는 표 칸 같은 하위 목록의 `문단.하위목록`이고 구역 최상위는 `-`다. 꼴은 `article`(제N장·절·조), `roman`(Ⅰ. Ⅱ), `digitDot`(`1.` `1.1.`), `hangulDot`(`가.`), `digitParen`(`1)`), `hangulParen`(`가)`), `digitParens`(`(1)`), `hangulParens`(`(가)`), `circled`(①·⑴·㉠·㉮·❶·➀), `box`(□ ○ ※ `- ` 등), `none`(번호 글자 없이 굵고 짧은 글)이고, 단계는 같은 상위 목록 안에서 이 순서대로 1부터 센다(숫자 다단은 점 수만큼, 기호는 그 목록에서 처음 나온 순서대로 한 단계씩 아래). `--json`이면 엔진의 `detectHeadings` 결과 배열(`at`, `index`, `text`, `sha256`, `marker`, `bold`, `height`)을 그대로 낸다. 템플릿에서는 `{ "kind": "headingRange", "at": { "sectionIndex": 0, "parentPath": [] }, "index": 17, "marker": { ... }, "heading": { ... }, "print": { ... } }` 앵커(엔진의 `makeHeadingRangeAnchor`가 채운다. 기본과 다른 서열로 만들면 그 서열을 `order`에 담는다)가 그 제목부터 같은 단계 이상의 다음 제목 앞까지를 가리키고, `range` 앵커와 같은 액션(`inject`·`insertText`·`delete`)과 같은 결과를 낸다.

```
hwpx headings notice.hwpx
hwpx headings notice.hwpx --json
```

`--report`는 `hwpx fill --report`와 같은 게이트 보고서다. 조각이 소스에서부터 갖고 있던 문제(겹치는 id, 소스에서 이미 없던 참조)는 새 오류로 세지 않고 보고서의 `report.inherited`에 적는다. 이런 조각 안의 겹치는 id를 새 값으로 바꾸려면 `--reissue-internal`을 준다(`fragment import`와 `.hwpx`의 `fill`에서 쓴다. 템플릿의 `inject`에 적용된다. 기본은 소스 원문 그대로다).

```
hwpx fragment import target.hwpx fragment.json --section 0 --index 2 -o merged.hwpx --reissue-internal
hwpx fill form.hwpx --data data.json --template template.json -o filled.hwpx --reissue-internal
```

검사와 비교:

```
hwpx validate filled.hwpx --baseline form.hwpx    # 원본에 없던 새 오류만 실패로 본다
hwpx validate filled.hwpx --strict --json
hwpx diff form.hwpx filled.hwpx
hwpx candidates form.hwpx --json
```

### 블록 저장소 (`block`)

문서에서 범위를 정해 블록으로 떼어 저장소 폴더에 모으고, 다른 문서에 넣는다(엔진 명세 8.8.17). 저장소는 이미 있는 폴더를 `--store`로 준다.

```
hwpx headings notice.hwpx                                                 # 제목 문단 번호 확인
hwpx block extract notice.hwpx --heading 0:17 --name "참가자격" --store store   # 제목 범위를 블록으로
hwpx block extract notice.hwpx --range 0:18-21 --name "계약 조건" --store store --id k0a1b2c3d
hwpx block list --store store
hwpx block insert other.hwpx --store store --block k0a1b2c3d --section 0 --index 5 -o out.hwpx
hwpx block insert other.hwpx --store store --block k0a1b2c3d --range 0:7-9 -o out.hwpx --report r.json
```

- 저장소 폴더: `blocks/<블록 id>/block.json`(최신 판 원형, 정규 JSON)과 `blocks/<블록 id>/<sha256>.json`(조각 덩어리). 블록 폴더는 `fill --blobs`의 덩어리 폴더로도 쓸 수 있다.
- `extract`: `--range 구역:시작-끝`이나 `--heading 구역:문단`(제목 문단) 하나를 준다. 표 칸 안 범위는 `--parent`. id를 주지 않으면 무작위로 만들고, 같은 id의 블록이 있으면 종료 코드 2다. 원형에는 출처(원본 해시·구간·지문·떼어 낸 시각)와 판 기록(`첫 저장`)이 들어간다. 구역 설정 문단·누름틀을 자르는 범위는 종료 코드 1이다.
- `insert`: 블록 덩어리의 해시를 대조하고(다르면 2), 넣는 자리 문단과 블록 문단의 문단 모양·스타일이 다르면 `서식 차이:` 줄과 `경고 [BLOCK_FORMAT_DIFFERS]`를 내고 그대로 넣는다(자동으로 바꾸지 않는다. 종료 코드는 바뀌지 않는다). 출력은 `fragment import`와 같은 저장 게이트를 거친다. `--report`에는 `block: { id, version, formatDiffs }`가 더해진다.
- `list`: 읽을 수 없는 블록이 있으면 종료 코드 1이다. `--json`은 원형 배열을 낸다.

## 보고서 형식 (`--report`)

JSON 하나: `{ ok, dryRun, report, ledger? }`. `report`는 계획(액션·건너뜀·필요한 데이터 경로, 그리고 범위 교체·삭제·삽입으로 문단 번호가 움직인 이동표 `plan.moves`)과 검사 결과·경고·오류 코드를, `ledger`는 입력·템플릿·데이터·출력의 해시와 수량을 담는다(HWPX를 만든 경우에만 있다. md·txt에는 없다).
