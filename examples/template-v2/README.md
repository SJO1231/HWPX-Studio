# 조항을 바꿔 넣는 템플릿(2판) 예시

가짜 입찰 공고서 하나로 2판 템플릿을 시험해 보는 예시입니다. 값과 글은 전부 지어낸 것입니다. 지금은 명령줄로만 할 수 있습니다(화면은 다음 단계). 고치기 전에 폴더를 복사해 두거나, 아래 "처음 모양으로 되돌리기"를 쓰세요.

## 파일

| 파일 | 무엇 |
| --- | --- |
| `notice.hwpx` | 원본 공고서. 번호 제목 7개(`1.`~`5.`, `가.`·`나.`), 표 하나, `{{키}}` 9곳(표 칸에 3곳). `3. 참가 자격`과 `4. 제출 서류` 아래가 바뀌는 곳입니다 |
| `template.json` | 템플릿(2판). 값 6개, 연결 6개, 자리 6개, 슬롯 2개, 블록 5개 |
| `case.json` | 이번 건. 슬롯 s2(제출 서류)에 블록 b4를 직접 고르고, 접수기간 값을 이번 건만 고칩니다 |
| `data.json` | 데이터 한 건. 금액은 쉼표 없는 숫자, `추가 안내`는 줄바꿈(`\n`)이 든 긴 글입니다 |
| `blobs/b5ae0148dd….json` | 조각 블록 b3(표가 든 다른 모양의 참가 자격 조항)의 내용. 파일 이름이 내용의 해시라서 고치면 안 됩니다 |

## 말뜻

- **값**: 이름과 형식을 가진 데이터 한 칸입니다(`사업명`, `추정가격` 등). `추정가격`은 금액 형식이라 쉼표가 붙고, `template.json`의 그 값에 `"display": { "unit": "원" }`이 있어 `150,000,000원`으로 들어갑니다. 서식에서 자리 바로 뒤가 이미 `원`이면 숫자만 넣어 `원`이 두 번 나오지 않습니다.
- **연결**(`bindings`): 값이 `data.json`의 어느 열을 읽는지입니다. `추정가격`은 `추정 가격(원)` 열을 읽고, 다른 이름 `추정가격`으로 적힌 열도 받습니다.
- **자리**(`places`): 문서의 `{{키}}`가 어느 값을 받는지입니다.
- **슬롯**: 문서에서 내용을 통째로 바꾸는 곳입니다. s1은 `3. 참가 자격` 제목부터 다음 같은 단계 제목(`4.`) 앞까지, s2는 `4. 제출 서류` 아래 문단들입니다.
- **블록**: 슬롯에 들어갈 내용 한 가지(글 또는 조각)와 고르는 조건입니다.
- **이번 건**(`case.json`): 이 건에서만 쓰는 선택과 고친 값입니다. 템플릿과 데이터는 바꾸지 않습니다.

| 블록 | 슬롯 | 내용 | 언제 들어가나 |
| --- | --- | --- | --- |
| b1 | s1 참가 자격 | 글: 1억 원 이상 조항 | 추정가격이 1억 원 이상일 때 |
| b2 | s1 참가 자격 | 글: 1억 원 미만 조항 | 참인 조건이 없을 때(조건 없음) |
| b3 | s1 참가 자격 | 조각: 공동 수급 조항(표 포함) | 추정가격이 10억 원 이상일 때. 우선순위 10이라 b1보다 먼저 |
| b4 | s2 제출 서류 | 글: 기본 서류 3줄 | `case.json`에서 고를 때 |
| b5 | s2 제출 서류 | 글: 공동 수급 서류 3줄 | `case.json`에서 고를 때 |

`case.json`에서 블록을 고를 때 `content`에 적는 블록 내용 해시(블록 글을 고치면 바뀝니다):

```
b1 961736d7c2d1e595222391dc1f61cc5499a201ad891f6e97bb504ebb76a50709
b2 d7b4226308fc9bf5b1f70fe3e240d4b34d0835210dad647b2eee8b787acccb49
b3 b5ae0148dd80804682829020c23c1deed7aaf74d06cc70389a67ce0aa75bca22
b4 af8938d69c0fa52471532c30eea7943124c1cc777b209469a7c12219c2032b60
b5 e21194476f1dae9a43c08a461993adcea11e49d6ca90f707f473695a06d5a46c
```

## 해 보기

저장소 폴더에서 터미널을 열고 차례로 입력합니다.

1. 제목 보기. 프로그램이 알아본 번호 제목이 나옵니다(`3. 참가 자격`이 0:-:8, 단계 1).

```
node apps/cli/src/main.ts headings examples/template-v2/notice.hwpx
```

2. 만들기. `result.hwpx`와 보고서 `report.json`이 저장소 폴더에 생깁니다.

```
node apps/cli/src/main.ts fill examples/template-v2/notice.hwpx --template examples/template-v2/template.json --case examples/template-v2/case.json --blobs examples/template-v2/blobs --data examples/template-v2/data.json -o result.hwpx --report report.json
```

이렇게 나오면 성공입니다.

```
2판 템플릿 생성(hwpx)
슬롯 s1: b1 (default)
슬롯 s2: b4 (manual)
1단계(구조): 액션 2개, 이동표 2건
2단계(값): 액션 9개, 건너뜀 0, 버림 0
저장했습니다: result.hwpx (16842바이트)
```

3. `result.hwpx`를 한컴에서 열어 봅니다. 다시 만들 때는 명령 끝에 `--overwrite`를 붙입니다(없으면 있는 파일을 덮어쓰지 않고 멈춥니다). 파일 없이 고르는 결과만 보려면 `-o result.hwpx --report report.json` 대신 `--dry-run`을 붙입니다.

## 고쳐 볼 것

- **데이터 값 바꾸기**: 메모장으로 `data.json`을 열어 값을 바꾸고 UTF-8로 저장합니다. 줄바꿈은 `\n`으로 적습니다.
- **금액을 바꿔 블록이 바뀌는 것 보기**: `"추정 가격(원)"`을 `50000000`으로 바꾸면 s1에 b2(fallback), `1200000000`이면 표가 든 b3(default)가 들어갑니다. 쉼표 없이 숫자로 적습니다.
- **수동 선택 바꾸기**: `case.json`의 `"block": "b4"`를 `"b5"`로, `"content"`를 위 목록의 b5 해시로 바꿉니다. 제출 서류 3줄이 공동 수급 서류로 바뀝니다. `"s2": {...}`를 통째로 지우면 고를 수 없어 `SEL_UNDECIDED`로 멈춥니다(조건 없는 블록이 둘이라서).
- **이번 건만 값 고치기**: `case.json`의 `valueEdits`가 `data.json`보다 이깁니다. 지금은 `v3`(접수기간)를 고쳐 둔 상태입니다. 지우면 `data.json`의 값이 들어갑니다.
- **글 블록 문구 바꾸기**: `template.json`의 b1·b2 `"text"`를 고치고 `"version"`을 1 올립니다(아래 주의). 줄마다 문단 하나가 됩니다. 이번 건에서 고른 b4·b5의 글을 템플릿에서 고치면 `SEL_RECHECK`로 멈추므로, 이번 건만 바꾸려면 `case.json`에 `"blockEdits": { "b4": { "text": "첫 줄\n둘째 줄" } }`처럼 적습니다.

## 주의

- **`notice.hwpx`를 한컴에서 고쳐 저장하면** 파일 해시가 달라져 `TPL_SOURCE_MISMATCH`로 막힙니다. 아래를 실행하면 고친 `notice.hwpx`는 그대로 두고 `template.json`의 원본 해시와 두 슬롯의 위치를 다시 계산하며 `"version"`을 1 올립니다. `참가 자격`과 `제출 서류`가 든 번호 제목이 하나씩 있어야 합니다.

```
node tools/examples/make-template-v2.ts --refresh
```

- **`template.json`을 손으로 고쳤으면 `"version"`을 1 올립니다.** 안 올리면 `case.json`이 기억하는 템플릿과 달라 `TPL_REF`(종료 코드 2)로 막힙니다.
- **처음 모양으로 되돌리기**: 아래는 예시 파일 다섯 개를 처음 모양으로 다시 씁니다. 고친 내용은 사라집니다.

```
node tools/examples/make-template-v2.ts
```

## 보고서(`report.json`)에서 볼 곳

- `report.selections`: 슬롯마다 고른 블록과 이유입니다. `default`는 조건이 참, `fallback`은 조건 없는 블록, `manual`은 `case.json`이 고름, `undecided`·`recheck`는 막힘입니다.
- `report.values`: 값마다 `bound`(데이터에서 읽음), `edited`(이번 건에서 고침), `missing`(없음) 같은 상태입니다. 값 원문은 적지 않습니다.
- `report.moves`: 슬롯을 바꾸면서 문단 번호가 움직인 표입니다. `{"from":12,"to":13,"count":3,"delta":1}`은 원본 문단 12~13(2개)이 3개로 바뀌어 그 뒤 번호가 1씩 늘었다는 뜻입니다.
- `report.dropped`: 블록이 덮어서 빠진 자리입니다(`PLACE_COVERED`, 실패 아님). 이 예시에서는 비어 있습니다.
- `report.issues`: 오류·경고입니다. 화면에도 `오류 [코드] 설명`으로 나옵니다.

| 코드 | 뜻 | 할 일 |
| --- | --- | --- |
| `TPL_SOURCE_MISMATCH` | `notice.hwpx`가 템플릿을 만든 때와 다릅니다 | `--refresh`를 실행합니다 |
| `TPL_REF` | `case.json`이 기억하는 템플릿 판이나 블록·슬롯 id가 맞지 않습니다 | `template.json`의 `"version"`을 1 올리거나 id를 확인합니다 |
| `SEL_UNDECIDED` | 슬롯에 넣을 블록을 고를 수 없습니다(조건 없는 블록이 둘인데 선택이 없음, 금액이 없거나 숫자로 읽히지 않음) | `case.json`에서 고르거나, 금액을 쉼표 없는 숫자로 고칩니다 |
| `SEL_RECHECK` | `case.json`이 고른 블록의 글이 바뀌었습니다 | `content`를 새 해시로 바꾸거나 `blockEdits`를 씁니다 |
| `DATA_MISSING` | 자리에 넣을 값이 `data.json`에 없습니다 | 그 열을 더합니다 |
| `PLACE_UNREGISTERED` | `notice.hwpx`에 템플릿에 없는 `{{키}}`가 있습니다 | `template.json`의 `places`에 자리를 더하고 `"version"`을 올립니다 |
| `TPL_FRAGMENT_MISSING` | `blobs` 폴더의 조각 파일이 없거나 바뀌었습니다 | 처음 모양으로 되돌립니다 |
| `ANCHOR_NOT_FOUND` 등 `ANCHOR_` | 슬롯 위치를 원본에서 찾지 못했습니다 | `--refresh`를 실행합니다 |

자리·데이터의 일반 규칙은 [사용 안내](../../docs/user-guide.md), 명령줄 전체는 [`apps/cli/README.md`](../../apps/cli/README.md)에 있습니다.

## 출처

`node tools/examples/make-template-v2.ts`가 엔진 시험 자료 `hancom/blocks.hwpx`(한컴이 저장한 합성 문서, 작성자 정보는 `synthetic`)를 엔진으로 고쳐 만듭니다. 두 번 실행해도 같은 바이트가 나옵니다.
