# HWPX Studio lite (apps/studio-lite)

공통 규칙과 프로젝트 경계(정본 위치, 역할 분담, 참고·의존 규칙, 실제 문서 취급, 한컴·시험, Git·이슈)는 저장소 루트의 [AGENTS.md](../../AGENTS.md)를 따른다. 이 파일은 이 앱에만 해당하는 사실을 적는다.

- 위치·소유: 제품 앱의 바탕이다(사용자 결정 2026-10-04). 소유는 Codex(앱·화면·SQLite 저장·데이터 입력·Helper 연결·CI). 공통 엔진 `packages/hwpx-engine`·뷰어 `packages/viewer`·`docs/`는 Claude 소유이며 여기서 수정하지 않는다. 필요한 엔진 변경은 이슈로 요청한다.
- 가지: `studio-lite` 가지는 main에 합쳐졌고 삭제됐다(2026-10-04). 작업은 이슈마다 `issue-N-주제` 가지를 main에서 따고 PR을 main으로 낸다.
- 실행·검사: 저장소 루트에서 `npm run start:lite`(http://127.0.0.1:4318), 필수 검사 `npm run verify`(형 검사·시험·`tools/check.mjs`). UI 변경은 실행 화면에서 확인한다. 구현·검증 상태의 정본은 [docs/status.md](docs/status.md)다.
- 엔진 사용: 공통 엔진을 직접 쓴다(스냅샷 복사 금지). 블록 교체 뒤 채울 자리가 없을 수 있는 채움 단계는 `generate`의 `allowNothingApplied`를 켠다(`src/hwpx.ts`).
- RHWP는 열기·렌더·free만 쓴다. 편집·직렬화 API를 호출하지 않는다. `vendor/rhwp` 사본은 공용 뷰어의 `@rhwp/core`로 통일할 예정이다(이슈).
- 의존: `kordoc`·`markdown-it`은 제거 대상이다(사용자 지시 2026-10-04). Markdown→HWPX는 엔진의 문단 삽입·조각으로, 미리보기는 자체 최소 변환으로 바꾼다. 새 의존은 사용자 승인 없이 넣지 않는다.
- 추천은 초안이다. Grid 확정 없이 후보를 템플릿에 적용하지 않는다. 변경 시 이전 생성물을 무효화한다. 사용자 원본은 덮어쓰지 않고, 생성 전후 재파싱·검증과 불변 ZIP 항목 보존을 확인한다.
- 조건은 제한된 구문으로 해석한다. eval/Function을 쓰지 않는다. 외부 경로·문서 내용을 신뢰하지 않는다.
- 데이터 입력: 사용자 데이터 견본(xlsx)은 2번째 시트부터 데이터다(`parseXlsx`의 첫 시트 고정은 바꿔야 한다. 이슈).
- `data/`, `artifacts/`, 실제 참고자료, 자격증명은 Git에 올리지 않는다. 작은 작업마다 계획·역할·보고서 파일을 늘리지 않는다.
