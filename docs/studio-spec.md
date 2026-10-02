# 스튜디오 명세

- 작성일: 2026-10-02
- 이 문서가 소유하는 주제: 스튜디오(화면 앱)의 계약 — 작업 공간 형식, 호스트 API, 화면 조각의 범위와 수용 조건
- 소유하지 않는 주제: 엔진 계약은 [엔진 명세](engine-spec.md), 뷰어와 위치 변환은 [뷰어 명세](viewer-spec.md)
- "결정"은 총괄의 임시 선택이다. 표기: **[확인]** 코드를 읽거나 실행해 확인 / **[미확인]**

## 0. 원칙

1. 호스트(Node)가 문서·템플릿·데이터와 엔진을 갖는다. 화면은 표시와 선택만 하고, 호스트가 준 보기만 그린다.
2. 화면이 보낸 앵커를 믿지 않는다. 호스트가 같은 자리에서 앵커 초안을 다시 만들어 대조한다.
3. 저장 형식은 엔진·CLI 형식 그대로다. 같은 폴더를 CLI로 돌린 결과가 화면의 생성 결과와 바이트까지 같아야 한다.
4. 사용자의 원본 문서는 고치지 않는다. 쓰기는 작업 공간 안에서만, 임시 파일에 쓴 뒤 이름을 바꾸는 방식으로 한다.
5. 화면 모양보다 동작과 정확성이 먼저다. 프레임워크와 번들러를 아직 들이지 않는다.

## 1. 결정 (임시 선택)

| 항목 | 선택 | 근거 | 다시 볼 때 |
| --- | --- | --- | --- |
| 앱 | 새 `apps/studio`. 시험 앱(`apps/viewer-poc`)은 그대로 둔다 | 시험 앱은 "디스크에 쓰지 않음"을 시험으로 지키는 뷰어 회귀 기준이다 | — |
| 공용 코드 | 시험 앱의 위치·초안·강조 로직과 로컬 서버 껍데기를 `packages/viewer/src/host/`로 옮긴다(동작 보존) | 소비자가 둘이 됐다 | — |
| 저장 | JSON 폴더(작업 공간) | 엔진·CLI 형식 그대로, 사람이 읽고 폴더 복사로 백업 | 조각 1,000개 이상이거나 검색이 느려지면 다시 만들 수 있는 색인으로 SQLite |
| 화면 | 프레임워크 없음. 패널마다 모듈, 상태가 바뀌면 그 패널을 다시 그린다 | 시험 앱에서 검증된 방식 | 조건 조립기(S3) 앞에서: 화면 코드 2,000줄 초과, 상태 동기화 결함 반복, 포커스 유지 문제 |
| 통신 | 루프백 HTTP(127.0.0.1). 데스크톱 셸에서도 유지 | 코드 경로가 하나. 미뤄 둔 편집창도 HTTP origin만 받는다 | 셸 단계에서 실행마다 바뀌는 토큰 추가 |

- 이 선택은 [아키텍처 리뷰](architecture-review.md)의 "2차 SQLite"와 [뷰어 명세](viewer-spec.md)의 "데스크톱 셸에서는 IPC"를 대신한다.

## 2. 조각 순서

| # | 이름 | 끝나면 사용자가 할 수 있는 일 | 의존 |
| --- | --- | --- | --- |
| S1 | 매핑 기본 | 자기 hwpx에 JSON 키를 눌러 연결하고, 껐다 켜도 남아 있고, 결과 hwpx를 받는다 | — |
| S2 | 원본 갱신과 자리 점검 | 한컴에서 문서를 고친 뒤 다시 불러와 깨진 연결만 고친다 | S1 |
| S3 | 조건 선택과 삭제·텍스트 삽입 | "계약 유형이 용역이면 이 문단을 지운다" 같은 규칙을 골라서 만든다 | S1 |
| S4 | 데이터 묶음 관리 | 다음 달 데이터를 같은 묶음에 넣고 여러 템플릿에 그대로 쓴다. 파생 값·별칭, 값의 줄바꿈 | S1 |
| S5 | Jev 0단계 추천 | 추천 목록을 훑어 수락만 해서 매핑을 빨리 끝낸다 | S1 |
| S6 | 표 조정 | 품목 배열만큼 행이 늘어나는 표를 만든다. 설정·크기 | S1, S3 |
| S7 | 조각 라이브러리와 주입 | 다른 문서의 조항·표를 서식 그대로, 조건에 따라 넣는다 | S3 |
| S8 | 자동 템플릿 초안 | 빈 양식 하나로 템플릿과 데이터 틀의 초안을 만든다 | S5 |
| S9 | 데스크톱 셸 | 터미널 없이 아이콘으로 쓴다 | S1~ |

- 편집창이 붙기 전까지 문서 내용 수정은 한컴에서 한다는 전제는 총괄의 임시 선택이다(사용자가 따로 정한 것이 아니다. [진행 방향](roadmap.md)).
- S1b(S1 바로 뒤, 미구현): 값의 줄바꿈을 줄바꿈 요소로 넣는다(엔진 명세 8.2의 "바꿀 예정"). 사용자의 실제 데이터에 줄바꿈이 흔하다.
- S3에 넣기로 한 것(사용자 결정): 참조 번호 자동 재정렬, 상호 배타 규칙.
- S2가 필요한 이유 **[확인]**: 표 셀·개체 앵커는 서수만 보고 지문이 없다. 원본 앞쪽에 표가 하나 끼면 다른 칸을 경고 없이 채운다. S2 전에는 원본을 고치면 새 템플릿으로 다시 연결해야 한다.

## 3. 작업 공간

```
<작업 공간>/            기본은 사용자 홈의 "HWPX Studio" 폴더(저장소 밖). --workspace로 바꾼다
  workspace.json        { "schema": "hwpx-studio/workspace@1" }  표지
  templates/<tid>/
    project.json        스튜디오 전용 정보
    template.json       hwpx-studio/template@1 (엔진 형식 그대로)
    source.hwpx         올린 원본. 바이트 그대로
  datasets/<did>/
    dataset.json        hwpx-studio/dataset@1 (엔진 형식 그대로)
    info.json           { schema: "hwpx-studio/dataset-info@1", name, createdAt, updatedAt, origin: { fileName, sha256 } }
```

- `project.json`: `{ schema: "hwpx-studio/project@1", name, createdAt, source: { file: "source.hwpx", sha256, bytes, originalName }, dataset: did | null }`
- 표지가 없는 비어 있지 않은 폴더에는 쓰지 않는다.
- 폴더 이름은 생성한 id만 쓴다(`t`·`d` + 16진수 8자). 사용자가 붙인 이름은 JSON 안에만 둔다.
- `template.json`에는 엔진의 `readTemplate`이 받는 키만 쓴다(모르는 키를 거절한다 **[확인]**). 화면 전용 정보는 `project.json`에 둔다. 쓰기 전에 `readTemplate`으로 검사한다. 손으로 쓴 다른 규칙(조건 등)은 보존한다.
- `template.json`의 `source.sha256`은 `source.hwpx`의 해시다. 엔진은 대조하지 않으므로 스튜디오가 열 때 대조한다.
- 데이터 묶음은 템플릿 폴더 밖에 있어 여러 템플릿이 함께 쓴다. 규칙은 데이터 경로만 가리키므로 템플릿을 고쳐도 묶음은 그대로다. 일반 JSON 객체는 `{ schema, data: 원본, derived: {} }`로 감싼다.
- 재현 경로: 아래 명령이 화면의 생성 결과와 같은 바이트를 낸다. 스튜디오는 누락 정책을 따로 넘기지 않고 템플릿의 `options.missing`을 엔진이 읽게 한다.

```
node apps/cli/src/main.ts fill templates/<tid>/source.hwpx --data datasets/<did>/dataset.json --template templates/<tid>/template.json -o out.hwpx
```

## 4. S1 — 매핑 기본

**넣는 것**: 작업 공간, 템플릿 만들기(.hwpx 올리기)·목록·열기, JSON 묶음 불러오기·목록·트리, 누름틀·낱말·문단·셀 앵커의 `fill { path }` 연결·바꾸기·삭제, 연결 목록과 쪽 강조, 누락 정책, 생성(게이트 포함) → 결과 보기·내려받기·오류 표시, 문서 안 `{{}}`와 손으로 쓴 다른 규칙의 읽기 전용 표시.

**빼는 것**: 조건과 다른 액션, 원본 다시 불러오기, 엑셀·CSV·DB, 여러 건, 파생 값 편집, 템플릿·묶음 삭제(파일 탐색기로), 되돌리기, 수리 방식.

**사용자가 하는 일**

1. 앱을 띄우고 `http://127.0.0.1:4174`를 연다.
2. 시작 화면에서 "새 템플릿"(.hwpx와 이름), "데이터 불러오기"(.json과 이름).
3. 템플릿을 연다. 가운데에 쪽, 오른쪽에 데이터 트리·누른 자리·연결 목록.
4. 데이터 묶음을 고른다(템플릿마다 기억). 트리에 키, 값 미리보기, 연결할 수 없는 이유가 보인다.
5. 쪽을 누르거나 끈다. 앵커 초안이 나온다(기본 선택 규칙은 뷰어 명세와 같다).
6. 트리에서 잎을 누르고 [연결]. 바로 저장되고 목록과 강조가 생긴다. 이미 연결된 자리면 바꿀지 묻는다.
7. 연결 목록의 줄을 누르면 그 자리가 강조된다. 줄마다 상태가 붙는다(데이터에 없음, 값에 줄바꿈, 객체·배열, 자리 못 찾음).
8. 누락 정책을 고른다(오류로 멈춤, 빈칸, 그대로 둠).
9. [미리 생성]. 성공하면 결과 쪽과 요약, [내려받기]. 실패하면 오류 코드·설명과 해당 연결 줄 강조.
10. 닫았다 다시 열어도 그대로다. "저장" 버튼은 없다.

**호스트 API** (오류는 `{ error: { code, message } }`)

| 경로 | 요청 → 응답 |
| --- | --- |
| `GET /api/workspace` | → `{ templates[], datasets[] }` |
| `POST /api/templates?name=` | .hwpx 바이트 → `{ id }`. 엔진으로 열리는지 먼저 확인. 실패하면 아무것도 남기지 않는다 |
| `POST /api/datasets?name=` | JSON 바이트 → `{ id }`. 최상위가 객체인 UTF-8 JSON만 |
| `GET /api/datasets/:did/tree` | → `{ nodes: DataNode[], truncated }`. 판정은 엔진의 경로·값 함수로 한다 |
| `GET /api/templates/:tid` | → `TemplateView` |
| `GET /api/templates/:tid/source` | → 원본 바이트(표시용) |
| `POST /api/templates/:tid/locate` | 뷰어 명세의 위치 요청 → 위치 응답 |
| `POST /api/templates/:tid/mappings` | `{ revision, at: { sectionIndex, path, start?, end? }, anchor, path, replace? }` → `TemplateView` |
| `DELETE /api/templates/:tid/mappings/:ruleId?revision=` | → `TemplateView` |
| `PATCH /api/templates/:tid` | `{ revision, dataset?, missing? }` → `TemplateView` |
| `POST /api/templates/:tid/generate` | `{ revision, mode? }` → `{ ok, revision, preview?: { id, bytes }, report }` |
| `GET /api/previews/:pid/bytes`, `/download` | → 바이트 |

```
TemplateView = { id, name, revision, source: { name, sha256 }, sections, dataset: { id, name } | null,
                 missing, mappings: MappingView[], implicit: { path, data, mark? }[],
                 others: { ruleId, type, anchor, hasCondition }[], openIssues: string[] }
MappingView  = { ruleId, anchorId, anchor, path,
                 place: "exact" | "relocated" | "ambiguous" | "notFound",
                 data: "ok" | "missing" | "notScalar" | "controlChar" | "noDataset", preview?, mark? }
DataNode     = { part: "data" | "derived", depth, key, path: string | null, type, preview?, count?,
                 flags: ("badKey" | "controlChar" | "viaArray" | "shadowed")[] }
```

- 바꾸는 요청의 응답은 전체 `TemplateView`다.
- `revision`은 `template.json`과 `project.json` 바이트의 해시 앞 16자다. 낡은 `revision`의 변경은 409(`REVISION_CONFLICT`)다.
- 연결 요청: 호스트가 `at`으로 `draftAnchors`를 다시 불러 같은 초안이 없으면 `DRAFT_STALE`, 있지만 막혔으면 `DRAFT_BLOCKED`, 데이터 경로가 문법에 안 맞으면 `BAD_PATH`. 같은 앵커가 이미 있으면 그 id를 다시 쓰고, 그 앵커에 이미 `fill`이 있으면 `replace` 없이는 409(`MAPPING_EXISTS`)다.
- 새 id는 기존 숫자 접미사의 최댓값 + 1이다(`a12`, `r12`).
- 같은 이름 누름틀은 "이 곳만"(순번 있음)과 "같은 이름 전부"(순번 없음) 두 초안을 보인다.
- 생성 결과는 메모리에만 두고 개수·바이트 한도를 둔다. 보고서에는 값 원문을 넣지 않는다.

**수용 조건**

| ID | 조건 |
| --- | --- |
| U1 | .hwpx를 올리면 `templates/<tid>/`에 세 파일이 생긴다: `source.hwpx`(올린 바이트와 같음), `template.json`(`readTemplate` 통과, `source.sha256` = 원본 해시, 앵커·규칙 0), `project.json`. 열 수 없는 파일은 엔진 오류 코드로 거절되고 폴더·임시 파일이 남지 않는다 |
| U2 | 일반 JSON 객체는 `{ schema, data, derived: {} }`로, 묶음 형식은 그대로 저장되며 `readDataset` 결과가 올린 것과 같다. 객체가 아니거나 UTF-8 JSON이 아니면 거절하고 아무것도 남기지 않는다 |
| U3 | 트리에서 경로가 있는 모든 잎은 엔진의 경로 조회 값과 같다. 쓸 수 없는 키(공백·점 등), 객체·배열, 줄바꿈·탭 든 값, 배열을 거치는 경로, `data`가 가린 `derived` 키에 표시가 붙는다 |
| U4 | 누름틀·`{{}}`·낱말(끌기 범위 포함)·셀·문단을 각각 눌러 연결하면 앵커 1개와 `fill { path }` 규칙 1개가 더해진다. 응답의 목록과 다시 읽은 파일이 같고, 쪽 강조가 누른 글을 덮는다 |
| U5 | 위조·낡은 앵커는 `DRAFT_STALE`, 막힌 초안은 `DRAFT_BLOCKED`, 문법에 안 맞는 경로는 `BAD_PATH`, 같은 자리 재연결은 `replace` 없이는 `MAPPING_EXISTS`. 어느 경우에도 파일이 바뀌지 않는다 |
| U6 | 서버를 다시 띄워도 연결·강조·고른 묶음·누락 정책이 같다. 연결을 지우면 규칙과, 다른 규칙이 쓰지 않는 앵커가 함께 사라진다 |
| U7 | 생성 결과가 게이트를 통과하고, 연결한 자리마다 rhwp 글자 배치에서 데이터 값이 읽힌다. 내려받은 파일은 같은 폴더를 CLI `fill`로 돌린 결과와 바이트가 같다 |
| U8 | 데이터에 없는 경로(오류 정책), 줄바꿈 든 값, 겹치는 두 연결이면 출력이 없고, 화면은 코드와 해당 연결 줄을 보인다. 빈칸·그대로 둠 정책은 엔진 명세대로다. 조용히 일부만 채우는 경우가 없다 |
| U9 | 어떤 작업 뒤에도 원본 해시가 두 JSON의 값과 같다. 낡은 `revision`의 변경은 409이고 파일이 그대로다. 쓰기 도중 실패를 주입해도 이전 `template.json`이 남고 임시 파일이 없다. id·이름으로 작업 공간 밖을 읽거나 쓸 수 없고, 표지 없는 비어 있지 않은 폴더에는 쓰지 않는다 |
| U10 | 루프백에만 바인드하고 Host·Origin을 검사하며 외부 요청이 0이다. 화면 모듈이 엔진·Node 내장 모듈을 가져오지 않는다. 시험 앱·엔진·뷰어 테스트와 형 검사가 전부 통과한다 |

**독립 검증이 볼 것**: CLI와의 바이트 동치(무작위 연결 집합), 브라우저에서 실제로 눌러 연결한 자리에 표식 값이 그려지는지, 위조 입력, 트리와 엔진 경로 조회의 대조, 파일 시스템 실패 주입과 경로 탈출, 값 누출, 응답 순서, 한컴 열림 표본.

## 5. 알려진 한계 (S1)

- 데이터 값의 줄바꿈·탭은 S1b에서 엔진이 줄바꿈·탭 요소로 넣게 바꾼다(그 전에는 생성 전체가 멈춘다 **[확인]**). 스튜디오는 엔진의 값 검사 결과를 그대로 따른다.
- 데이터 경로의 이름은 글자·숫자·`_`·`-`만 된다 **[확인]**. 공백·점·괄호가 든 키(엑셀 머리글 등)는 별칭(S4) 전까지 연결할 수 없다.
- 원본을 한컴에서 고치면 S2 전에는 새 템플릿으로 다시 연결해야 한다.
- 그림·도형, 머리말·꼬리말·각주 안, 여러 문단에 걸친 선택은 연결할 수 없다([뷰어 명세](viewer-spec.md)).
- 큰 문서를 생성하는 동안 화면 응답이 멈춘다(호스트가 한 스레드다).

## 6. 사용자에게 물은 것

| 질문 | 답 (2026-10-02) | 영향 |
| --- | --- | --- |
| 실제 데이터의 꼴 | JSON으로 받아 DB에 넣어 둔 데이터다. 값에 줄바꿈이 제법 있다. 어떻게 넘길지는 모르겠다고 함 | 줄바꿈 처리를 S1 바로 뒤로 당김(S1b). 넘기는 방법은 견본 한 건이나 DB 종류를 받은 뒤 정한다. S1은 JSON 파일 불러오기 |
| 연결한 자리를 누름틀로 바꾼 사본을 원본으로 써도 되는가 | 답 대기 | S2의 설계 |
| 혼자 한 PC에서 쓰는가, 공유 폴더에서 여러 사람이 쓰는가 | 답 대기 | 저장 방식, 동시 편집 |
