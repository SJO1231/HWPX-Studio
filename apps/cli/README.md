# hwpx 명령줄 도구 (apps/cli)

HWPX 문서와 Markdown·텍스트 문서를 검사하고 채우는 명령줄 도구다. Node 24만 쓰고 제3자 패키지가 없다. 파일 읽기·쓰기는 이 폴더에만 있고, 엔진(`packages/hwpx-engine`)은 파일을 열지 않는다.

저장소 루트에서 `node apps/cli/src/main.ts <명령> [옵션]`으로 실행한다. 아래 예시는 이를 `hwpx`로 줄여 쓴다. `hwpx --help`가 전체 사용법이다.

## 명령

| 명령 | 한 줄 설명 | 받는 형식 |
| --- | --- | --- |
| `inspect` | 구역·문단·표·누름틀·`{{}}`·자원 요약. md·txt는 블록·표·코드 블록 수와 `{{}}` 목록 | `.hwpx` `.md` `.txt` |
| `candidates` | 채울 자리 후보 목록(누름틀, `{{}}`, 빈 값 셀, `라벨:` 뒤 빈 곳 등) | `.hwpx` |
| `fragment extract` | 문단 구간을 조각 JSON으로 뜬다 | `.hwpx` |
| `fragment import` | 조각 JSON을 다른 문서의 문단 앞·뒤나 표 셀 안에 가져온다(저장 게이트 포함) | `.hwpx` |
| `fill` | 데이터로 `{{}}`·누름틀을 채우고 템플릿 규칙(채움·삭제·삽입·조각 주입)을 적용한다 | `.hwpx` `.md` `.txt` |
| `validate` | 참조 무결성·인스턴스 중복·패키지 구조를 검사한다(`--baseline`으로 원본과 대조) | `.hwpx` |
| `diff` | 두 문서를 항목별로 견주고 수량 증감을 낸다 | `.hwpx` |
| `compile` | `{{}}`를 누름틀로 승격한다(실험: `--experimental` 필수) | `.hwpx` |

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

누락 키는 기본(`--missing error`)이면 종료 코드 1로 멈춘다. `--missing empty`는 빈 글로, `--missing keep`은 자리를 그대로 둔다. `--mode`는 `.hwpx` 전용이고(`baseline` 기본, `strict`, `repair`), `--report`는 게이트가 실패해도 쓴다.

Markdown·텍스트도 같은 데이터·템플릿으로 채운다. UTF-8만 받고 BOM과 줄바꿈 방식(LF·CRLF)은 그대로 둔다.

```
hwpx inspect notice.md --json
hwpx fill notice.md --data data.json -o notice-filled.md
hwpx fill notes.txt --data data.json --template template.json -o notes-filled.txt
hwpx fill notice.md --data data.json -o notice-filled.md --fill-in-code   # 코드 블록 안의 {{}}도 채움(기본은 그대로)
```

`--mode`와 `--reissue-internal`은 md·txt에 쓸 수 없고(종료 코드 2), `--fill-in-code`는 md·txt에만 쓴다. 템플릿의 `inject`가 가리키는 조각 파일 경로는 템플릿 파일이 있는 폴더 기준이다(md·txt 조각은 `{ "schema": "hwpx-studio/text-fragment@1", "blocks": [...] }`).

```
hwpx fill form.hwpx --data data.json --template template.json -o filled.hwpx
```

조각을 뜨고 다른 문서에 가져온다. 주소는 구역 번호(`--section`)와 그 목록 안 문단 서수(`--index`)다. 표 셀 안은 `--parent 문단.하위목록`으로 가리킨다.

```
hwpx fragment extract source.hwpx --section 0 --from 3 --to 5 -o fragment.json
hwpx fragment import target.hwpx fragment.json --section 0 --index 2 -o merged.hwpx
hwpx fragment import target.hwpx fragment.json --section 0 --index 2 --before -o merged.hwpx
hwpx fragment import target.hwpx fragment.json --section 0 --index 2 -o merged.hwpx --report import-report.json
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

## 보고서 형식 (`--report`)

JSON 하나: `{ ok, dryRun, report, ledger? }`. `report`는 계획(액션·건너뜀·필요한 데이터 경로)과 검사 결과·경고·오류 코드를, `ledger`는 입력·템플릿·데이터·출력의 해시와 수량을 담는다(HWPX를 만든 경우에만 있다. md·txt에는 없다).
