# HWPX Studio lite

Markdown과 원본 HWPX를 같은 Field / In Template 개념으로 다루는 로컬 MVP입니다. Node.js 24.19 이상, Windows x64 기준입니다.

관리 저장소는 [SJO1231/HWPX-Studio](https://github.com/SJO1231/HWPX-Studio/tree/studio-lite)이며 작업 브랜치는 `studio-lite`입니다. 이 앱은 `apps/studio-lite`에 있고 공통 `packages/hwpx-engine`를 직접 사용합니다. Studio main에는 병합하지 않았습니다. 사용자 DB·실제 참고자료·시험 산출물은 Git에 포함하지 않으며 `samples/`에는 합성 시험 문서만 포함합니다.

현재 코드 리뷰에서 발견한 미수정 결함 5개가 남아 있습니다. 테스트 통과는 업무용 완성 판정이 아닙니다. 상세 내용은 [검증 상태](docs/status.md), 검토 요청과 개선 순서는 [설계자 검토 의뢰서](docs/architect-review-brief.md)를 참조하세요.

## 실행

저장소 루트에서 `npm run start:lite`, 또는 이 앱 폴더에서 `start.cmd`를 실행하거나:

```powershell
npm start
```

[http://127.0.0.1:4318](http://127.0.0.1:4318)을 엽니다. 포트 변경은 `$env:PORT=4319` 후 실행합니다. 서버 종료는 실행 콘솔에서 Ctrl+C입니다.

새 PC에서는 저장소 루트에서 `npm ci --ignore-scripts`를 실행합니다. 생성과 미리보기에 한컴 설치, Python, 모델 다운로드가 필요하지 않습니다. 개발 검사기는 TypeScript가 제공하는 플랫폼별 선택 의존성으로 현재 운영체제·CPU에 맞는 실행 파일을 사용합니다. TypeScript 실행에 필요하므로 설치 시 `--omit=optional`을 사용하지 않습니다.

## 1분 체험

1. 기본 예시에서 **데이터 적용**을 누릅니다.
2. 오른쪽 **Template / Data / HWPX**를 전환합니다. HWPX 탭은 실제 생성 바이트를 RHWP로 렌더합니다.
3. 다른 레코드 또는 Block을 선택하고 다시 적용합니다. 조건보다 사용자 선택을 우선합니다.
4. **HWPX 다운로드** 또는 **저장**을 누릅니다. 저장은 템플릿·원본 사본·데이터·선택을 `data/studio.sqlite`에 새 이력으로 보관합니다.

## 문서를 비교해 템플릿 만들기

1. **예시 비교** 또는 **문서 추가**로 MD/TXT/HWPX를 2개 이상 넣습니다. 첫 번째가 Master입니다.
2. JSON/CSV/XLSX 데이터를 불러옵니다. 비교 샘플 문서 A/B와 데이터 행 A/B는 같은 순서여야 값 매핑이 의미가 있습니다.
3. Grid에서 이름, Field / In Template / 고정 문구, DB Column, 문자/금액을 수정합니다.
4. 적용할 후보를 체크하고 **Grid 확정**을 누릅니다. 분석은 기존 문서에 바로 적용되지 않습니다.
5. 같은 값을 쓸 후보는 체크한 뒤 **선택 병합**, 이후 **Grid 확정**합니다. 병합한 모든 위치에 첫 후보의 매핑 값을 넣습니다.
6. **Schema · 샘플 DB**는 확정 Field에서 JSON Schema와 레코드를 추출해 내려받고, 데이터 선택에 반영합니다. 이후 저장하면 SQLite에 보관됩니다.

## 두 모드

| 모드 | 편집과 생성 | 용도 |
|---|---|---|
| 최소 서식 보전형 | Markdown → Block → 값 주입 → Kordoc HWPX | 제목, 문단, 목록, 간단한 표 |
| 원본 서식 보전형 | Master 사본 → Fragment → Field → Unwrap → 기존 Core 검증 | 기존 표·스타일·자원 보전 |

Markdown 문법:

```markdown
# {{사업명}}
계약금액: {{계약금액}}

[IN_TEMPLATE:qualification]
```

**블록 · 조건 편집**에서 Group, 별칭, 우선순위, 조건, Markdown을 편집합니다. 예: `중소기업=true AND 직접생산=true`. `= != > >= < <=`와 AND를 지원합니다. 큰 우선순위를 먼저 평가하며 빈 조건은 기본 Block입니다. 코드 실행이나 임의 JavaScript는 지원하지 않습니다.

Markdown 편집기에서 글을 선택하고 **선택 → Block**을 누르면 그 범위를 별도 Block으로 분리합니다. 왼쪽 번호는 Markdown 소스 줄이며 HWPX의 시각적 줄 번호가 아닙니다.

원본 서식형의 **Anchor+ 설정**:

1. HWPX 원본을 선택하고 시작~끝 문단 번호를 지정합니다(첫 구역, 1부터, 양 끝 포함).
2. **Fragment로 등록**하면 표·자원 의존성이 포함된 원본 범위를 Block으로 사용합니다.
3. Master에서 **Master Anchor+ 등록**을 누르면 그 범위를 같은 Group의 선택된 Block으로 교체합니다.
4. 다른 문서에서 가져온 자원은 기존 Core가 ID를 재매핑합니다. 겹친 범위, 불명확한 Anchor, 미지원 구조는 출력하지 않고 이유를 표시합니다.

## 현재 범위

- Jev는 **로컬 규칙 기반 0단계**입니다. 누름틀·라벨·다문서 값 차이·정규화 값 일치·조건식을 근거로 후보를 제안합니다. LLM/임베딩을 이용한 의미 검증은 연결하지 않았습니다.
- 비교는 누름틀/placeholder 이름, `라벨: 값`, 간단한 인접 표 셀 중심입니다. 임의 레이아웃 사이의 완전한 구조 정렬은 하지 않습니다.
- DB는 프로젝트 내 레코드를 SQLite에 JSON으로 보관합니다. 외부 SQL 서버 연결이나 관계형 DDL 생성은 없습니다.
- XLSX는 첫 시트, 단순 셀 값·저장된 수식 결과를 읽습니다. 날짜 서식 변환·수식 재계산·병합 셀 확장은 하지 않습니다. JSON은 단일 값 열로 된 객체 배열입니다.
- XLSX 첫 시트는 통합문서의 표시 순서를 따릅니다. 헤더 없는 열의 데이터, 오류 셀, 잘못된 공유 문자열은 버리지 않고 오류로 알립니다. 빈 금액은 0원으로 바꾸지 않습니다.
- 원본 Fragment/Anchor+ UI는 첫 구역의 연속 본문 문단을 지원합니다. 표 안 일부 구간, 첫 문단의 구역 설정을 포함한 조각, 복잡한 누름틀은 거절할 수 있습니다.
- 하나의 `{{Field}}` 안에서 글자 서식이 바뀌는 원본은 생성을 차단합니다. 해당 Field의 글자 서식을 원본에서 통일한 뒤 다시 분석하세요.
- HWPX 미리보기는 RHWP 읽기 전용입니다. 한컴과 쪽 나눔/글꼴이 같다는 보증은 없으며 최종 제출본은 한컴에서 확인해야 합니다.
- 완전한 WYSIWYG, MD↔HWPX 완전 왕복, 중첩 In Template, 배열 행 반복, 모든 HWPX 호환은 범위 밖입니다.
- 최대 20개 문서, 문서당 UI 업로드 10MB, HTTP 요청 32MB, 레코드 5,000행, 미리보기 첫 20쪽입니다.

## 하네스

```powershell
npm run verify
```

구문 검사 → TypeScript 검사 → 공통 엔진 연결·RHWP 7파일 해시 및 읽기 전용 경계 → 실행 시험 순서입니다. Helper 연결과 복합 회귀를 포함한 34개 테스트가 실행됩니다. `test/studio.test.ts`가 생성한 HWPX와 SVG 및 `complex-results.json`은 `artifacts/`에 남습니다. `complex-md-project.json` 또는 `complex-native-project.json`을 화면의 **가져오기**로 열면 복합 시험을 직접 재현할 수 있습니다. 개발 규칙은 `AGENTS.md`, 검증 상태와 다음 작업은 `docs/status.md` 한 곳에 둡니다.

로컬 참고자료의 공고서를 별도로 시험하려면:

```powershell
$env:HWPX_CORPUS_DIR=(Resolve-Path '..\DocWeave\참고자료').Path # 실제 자료 위치에 맞게 변경
node --test --test-name-pattern='참고자료 공고서' test/studio.test.ts
Remove-Item Env:HWPX_CORPUS_DIR
```

하위 폴더의 `공고서*.hwpx`를 이름 중간 일치로 찾고 SHA-256으로 중복을 제외합니다. 일반값·0원·긴 문자열과 참가자격 Fragment 교체를 시험합니다. Grid 확정은 시험 코드에서 모의 수행하며 실제 업무 템플릿 승인이 아닙니다. 원본과 사용자 DB는 수정하지 않습니다. 최신 결과 폴더는 `artifacts/notice-simulation-latest.txt`, 파일별 결과는 해당 폴더의 `report.json`입니다. 시험 통과에는 생성 차단도 포함되므로 **passed / rejected / failed**를 따로 확인하세요.

코드 구조는 `src/core.ts`(모델 흐름·비교·조건·매핑), `src/hwpx.ts`(두 엔진 연결), `src/server.ts`(HTTP·SQLite), `web/`(공통 UI), 저장소의 `packages/hwpx-engine/`(공통 Core)입니다.

재사용 판단·원본 출처·미검증 사항은 [구현 및 검증 기록](docs/status.md), 외부 코드 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참조하세요.
