# HWPX Studio lite

> 2026-10-03 관리 위치 이전: 이 폴더는 복구용 사본이다. 신규 개발·검사·커밋은 `E:/Prodev/HWPX-Studio-studio-lite` 작업 폴더의 `studio-lite` 브랜치에서 수행한다. 앱은 `apps/studio-lite`, 공통 엔진은 `packages/hwpx-engine`이다. Studio main에는 별도 요청 없이 병합하지 않는다. 아래 별도 저장소·vendor 지침은 이전 전 기록이며 새 작업 폴더의 AGENTS.md를 따른다.

- 목적: 같은 Field / Anchor / In Template 모델로 Markdown 및 원본 HWPX를 생성하는 로컬 MVP.
- 먼저 README.md, docs/status.md와 관련 소스를 읽고 실제 흐름을 추적한다.
- Ponytail 원칙: 기존 Core → 표준 라이브러리 → 설치 의존성 순으로 재사용. UI 프레임워크나 서비스는 필요가 확인될 때만 추가한다.
- `vendor/hwpx-engine`는 HWPX Studio의 읽기 전용 스냅샷이다. 변경은 어댑터에서 먼저 해결하고 원본 출처·해시를 유지한다. 기준 프로젝트를 수정하지 않는다.
- RHWP는 열기·렌더·free만 사용한다. 편집·직렬화 API를 호출하지 않는다.
- 추천은 초안이다. Grid 확정 없이 문서 후보를 템플릿에 적용하지 않는다. 변경 시 이전 생성물을 무효화한다.
- 사용자 원본은 덮어쓰지 않는다. 생성 전후 재파싱·검증, 불변 ZIP 항목 보존을 확인한다.
- 조건은 제한된 구문으로 해석한다. eval/Function을 사용하지 않는다. 외부 경로·문서 내용을 신뢰하지 않는다.
- 작업 완료 전 `npm run verify`. UI 변경은 실행 페이지에서 확인. 실패·미검증·한컴 미확인은 docs/status.md에 구분한다.
- 하네스 정본은 `tools/check.mjs`, `test/studio.test.ts`, `docs/status.md`다. 작은 작업마다 계획·역할·보고서 파일을 늘리지 않는다.
- 위임은 사용자가 요청했을 때 파일 소유권과 검사 명령을 지정한다. 같은 파일을 동시에 수정하지 않는다.
- 이 프로젝트의 원격은 `https://github.com/SJO1231/HWPX-Studio-Lite.git`, 기본 브랜치는 `main`이다. 사용자가 이 저장소에서 커밋·관리를 승인했다. 별도 `HWPX-Studio` 저장소와 그 브랜치는 수정하지 않는다.
- 커밋 전 변경 범위와 검증 결과를 확인한다. `data/`, `artifacts/`, 실제 참고자료, 자격증명은 올리지 않는다. 재사용 파일의 바이트·해시를 보존하며 강제 push는 하지 않는다.
