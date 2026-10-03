# HWPX Studio lite

- 목적: 같은 Field / Anchor / In Template 모델로 Markdown 및 원본 HWPX를 생성하는 로컬 MVP.
- 먼저 README.md, docs/status.md와 관련 소스를 읽고 실제 흐름을 추적한다.
- Ponytail 원칙: 기존 Core → 표준 라이브러리 → 설치 의존성 순으로 재사용. UI 프레임워크나 서비스는 필요가 확인될 때만 추가한다.
- 엔진은 공통 `packages/hwpx-engine`를 직접 사용한다. 앱 전용 변경은 이 앱에서 해결한다. 삭제한 엔진 복사본의 출처·해시는 `vendor/provenance.json`과 이전 Git 이력에 보존한다. RHWP vendor는 읽기 전용이다.
- RHWP는 열기·렌더·free만 사용한다. 편집·직렬화 API를 호출하지 않는다.
- 추천은 초안이다. Grid 확정 없이 문서 후보를 템플릿에 적용하지 않는다. 변경 시 이전 생성물을 무효화한다.
- 사용자 원본은 덮어쓰지 않는다. 생성 전후 재파싱·검증, 불변 ZIP 항목 보존을 확인한다.
- 조건은 제한된 구문으로 해석한다. eval/Function을 사용하지 않는다. 외부 경로·문서 내용을 신뢰하지 않는다.
- 작업 완료 전 `npm run verify`. UI 변경은 실행 페이지에서 확인. 실패·미검증·한컴 미확인은 docs/status.md에 구분한다.
- 하네스 정본은 `tools/check.mjs`, `test/studio.test.ts`, `docs/status.md`다. 작은 작업마다 계획·역할·보고서 파일을 늘리지 않는다.
- 위임은 사용자가 요청했을 때 파일 소유권과 검사 명령을 지정한다. 같은 파일을 동시에 수정하지 않는다.
- 관리 저장소는 `https://github.com/SJO1231/HWPX-Studio.git`, 작업 브랜치는 `studio-lite`다. 사용자는 Lite 이력 통합 및 이 브랜치의 커밋·관리를 승인했다. Studio main에는 별도 요청 없이 병합·push하지 않는다. 이전 Lite 저장소·작업 폴더는 신규 개발 기준이 아니다.
- 커밋 전 변경 범위와 검증 결과를 확인한다. `data/`, `artifacts/`, 실제 참고자료, 자격증명은 올리지 않는다. 재사용 파일의 바이트·해시를 보존하며 강제 push는 하지 않는다.
