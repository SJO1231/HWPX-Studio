# 프로젝트 사실

- 확인일: 2026-10-01
- 이 문서가 소유하는 주제: 실행·검증 명령, 폴더 구조, 위임 역할, Git 규칙
- 소유하지 않는 주제: 계약은 [엔진 명세](engine-spec.md), 상태는 [작업 기록](task-record.md), 순서는 [진행 방향](roadmap.md)

"확인"은 실제로 실행해 관측한 것이다. 아직 실행하지 않은 것은 "예정"으로 적는다.

## 실행 환경

| 항목 | 값 | 근거 |
| --- | --- | --- |
| 운영체제 | Windows 11 | 작업 PC |
| Node.js | 24 이상 | 타입 제거 실행, 내장 `zlib.crc32`·`node:sqlite`. 확인한 버전 24.19 |
| 패키지 관리 | npm workspaces | pnpm·yarn 없음 |
| 엔진 런타임 의존성 | 없음 | [엔진 명세](engine-spec.md) 0절 |
| 뷰어 런타임 의존성 | `@rhwp/core` 0.8.6(MIT, 버전 고정). 고지는 `THIRD_PARTY_NOTICES.md` | [뷰어 명세](viewer-spec.md) 2절 |
| devDependencies | `typescript`, `@types/node` | — |

## 명령

| 목적 | 명령 | 상태 |
| --- | --- | --- |
| 설치 | `npm install` | 확인 |
| 형 검사 | `npm run typecheck` | 확인 |
| 테스트 | `npm test` | 확인 |
| 오라클 포함 테스트 | `HWPX_ORACLES=1 npm test` (rhwp 실행 파일과 Python이 있을 때) | 확인 |
| 실제 문서 보정 집계 | `HWPX_CORPUS_DIR=<폴더> node --test packages/hwpx-engine/test/repair-corpus.test.ts` | 확인 |
| CLI | `node apps/cli/src/main.ts <명령>` (`--help`로 명령 9종. `fill`·`inspect`는 `.hwpx`·`.md`·`.txt`. 표는 `table list`·`table set`). 설명은 `apps/cli/README.md` | 확인 |
| 실제 문서 스트레스 시험 | `node tools/stress/campaign.ts --corpus <폴더> --seed 1 --pairs 150 --oracle-sample 40` | 확인 |
| 실제 문서 표 스트레스 시험 | `node tools/stress/tables.ts --corpus <폴더> --seed 21 --docs 160 --ops 1500 [--prefer-merged-only] [--no-com \| --com-sample 15]` | 확인 |
| 한컴 표 대조 테스트 | `HWPX_COM=1 node --test packages/hwpx-engine/test/table-com.test.ts` | 확인(한컴 13) |
| 뷰어 시험 앱 | `node apps/viewer-poc/server.ts` → `http://127.0.0.1:4173` (`.claude/launch.json`의 `viewer-poc`) | 확인 |
| 뷰어 위치 대조(실제 문서) | `HWPX_CORPUS_DIR=<폴더> node packages/viewer/tools/crosscheck.ts --clicks --after-fill --report tools/stress/out/<이름>.json` | 확인 |
| 한컴으로 열기·PDF | `python tools/com/open_check.py --out 결과.json [--pdf-dir 폴더] 파일...` | 확인(한컴 13) |
| 한컴 시험 문서 다시 만들기 | `python tools/com/make_fixtures.py` | 확인 |

- 한컴 COM을 쓰는 작업은 한 번에 하나만 돌린다. 여러 작업이 동시에 한컴을 띄우면 서로의 실행이 실패한다(확인).

## 폴더 구조

| 경로 | 내용 | Git |
| --- | --- | --- |
| `packages/hwpx-engine/` | 엔진(자체 구현). `src/`와 `test/` | 포함 |
| `apps/cli/` | 명령줄 도구. 파일 입출력은 여기만 | 포함 |
| `packages/viewer/` | 뷰어(rhwp 임베드, 위치 변환). 런타임 의존은 `@rhwp/core` 하나 | 포함 |
| `apps/viewer-poc/` | 뷰어 시험 앱(로컬 서버와 웹 화면) | 포함 |
| `tools/oracle/` | 검증 보조 스크립트(선택 실행) | 포함 |
| `docs/` | 정본 문서 | 포함 |
| `skills/`, `.claude/skills/`, `.claude/agents/` | 작업 체계. `skills/`가 정본이고 `.claude/skills/`는 사본 | 포함 |
| `참고사항.md` | 사용자가 준 편집 기준 원문 | 포함 |
| `hwpx-edit/` | 이전 실측 자료(검사기 원본, 실험 스크립트, 산출물, rhwp 실행 파일). 로컬 전용 | **제외** |
| `참고자료/` 등 실제 문서 | 읽기 전용 시험에만 쓴다 | **제외** |

## 검증 오라클 (로컬 전용, 선택)

| 오라클 | 위치 | 비고 |
| --- | --- | --- |
| rhwp CLI v0.8.6 | `hwpx-edit/.cargo-root/bin/rhwp.exe` 또는 PATH | 없으면 해당 검사를 건너뛰고 "미검증" |
| Python 검사기 | `hwpx-edit/validate_refs.py` | 결과 코드 대조용 |
| python-hwpx | Python 패키지 | 패키지·id 무결성 대조 |
| 한컴 COM | 한컴 오피스가 설치된 Windows | 열림·쪽 수·PDF |

## 위임 역할

| 역할 | 정의 | 모델 | 쓰는 곳 |
| --- | --- | --- | --- |
| 총괄 | 주 세션 | 세션의 모델 | 범위 결정, 명세, 인계문, 통합, 최종 확인 |
| 구현 | `kf-implementer` | sonnet | 명세가 정해진 구현과 수정 |
| 독립 검증 | `kf-verifier` | opus | 보존 계약·데이터 보존·계약 확인 |
| 기계적 점검 | `kf-checker` | haiku | 해시 대조, 링크·형식 확인, 식별자 대조 |
| 조사 | 범용 Agent | sonnet | 원본 저장소 조사 |
| 설계 검토 | Plan Agent | opus | 큰 설계의 독립 검토 |

- 모델 배정은 Claude 전용 설정이다. 공통 지침(AGENTS.md)은 모델 이름을 정하지 않는다.
- 구현 인계문에는 "참고 소스의 코드·식별자·주석을 가져오지 않는다"를 반드시 넣는다.

## Git

- 원격: `https://github.com/SJO1231/HWPX-Studio.git`, 브랜치 `main`.
- **로컬 커밋을 먼저 한다. push는 정제 검토를 거친 뒤에 한다.**
- 커밋 전 점검: 개인 절대 경로, 이메일, 실제 문서의 이름·내용, 실험 산출물, 바이너리가 들어가지 않았는지 본다. 문서의 경로는 저장소 기준 상대 경로로 쓴다.
- `.gitignore`: `node_modules/`, `dist/`, `hwpx-edit/`, `참고자료/`, 임시·검증 데이터, 원장·로그, 로컬 설정.
- 이 저장소 한정 설정: 작성자는 GitHub noreply 주소, `core.autocrlf=false`, `.gitattributes`의 `* -text`.
- `gh` CLI가 없다. PR은 명령으로 만들지 않는다.

## Skill

| 위치 | 내용 |
| --- | --- |
| `skills/` | 정본 6종: `focused-plan`, `root-cause-fix`, `verify-change`, `session-handoff`, `review-boundaries`, `delegate-bounded-task` |
| `.claude/skills/` | 위 6종의 사본 |
| `.claude/agents/` | 위임 역할 3종 |

Skill을 고칠 때는 `skills/`를 고치고 `.claude/skills/`로 다시 복사한다.
