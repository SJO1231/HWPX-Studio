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
| 한컴 표 대조 테스트 | `HWPX_COM=1 node --test packages/hwpx-engine/test/table-com.test.ts` | 확인(한글 2024. COM `Version`은 "13") |
| Lite 앱 | `npm run start:lite` → `http://127.0.0.1:4318` (`studio-lite` 브랜치) | 확인(통합 브랜치) |
| Lite 포함 기본 검사 | `npm run verify` | 확인(통합 브랜치) |
| 뷰어 시험 앱 | `node apps/viewer-poc/server.ts` → `http://127.0.0.1:4173` (`.claude/launch.json`의 `viewer-poc`) | 확인 |
| 뷰어 위치 대조(실제 문서) | `HWPX_CORPUS_DIR=<폴더> node packages/viewer/tools/crosscheck.ts --clicks --after-fill --report tools/stress/out/<이름>.json` | 확인 |
| 한컴으로 열기·PDF | `python tools/com/open_check.py --out 결과.json [--pdf-dir 폴더] 파일...` | 확인(한컴 13) |
| 한컴 시험 문서 다시 만들기 | `python tools/com/make_fixtures.py` | 확인 |
| 빠른 생성 예시 서식 다시 만들기 | `python tools/com/make_examples.py` → `examples/quick/*.hwpx` | 확인(한컴 13) |
| 여러 문단 누름틀 정답 문서 다시 만들기 | `python tools/com/make_span_fixtures.py` → `tools/com/out/field-span*.hwpx`, `inline-breaks-filled.hwpx`(한컴이 직접 채운 정답. 사본은 `packages/hwpx-engine/test/fixtures/span/`) | 확인(한컴 13) |

- 한컴 COM을 쓰는 작업은 한 번에 하나만 돌린다. 여러 작업이 동시에 한컴을 띄우면 서로의 실행이 실패한다(확인).

## 폴더 구조

| 경로 | 내용 | Git |
| --- | --- | --- |
| `packages/hwpx-engine/` | 엔진(자체 구현). `src/`와 `test/` | 포함 |
| `apps/cli/` | 명령줄 도구. 파일 입출력은 여기만 | 포함 |
| `packages/viewer/` | 뷰어(rhwp 임베드, 위치 변환). 런타임 의존은 `@rhwp/core` 하나 | 포함 |
| `apps/studio-lite/` | Markdown·원본 HWPX 생성 MVP. 공통 엔진 사용. 상세 상태는 앱의 `docs/status.md` | 포함 |
| `apps/viewer-poc/` | 뷰어 시험 앱(로컬 서버와 웹 화면) | 포함 |
| `apps/studio/` | 빠른 생성 화면과 로컬 서버(`server.ts`, 4174). 사용자 결정(2026-10-04)으로 `apps/studio-lite`에 흡수될 예정 | 포함 |
| `apps/studio-lite/` | 제품 앱의 바탕(사용자 결정 2026-10-04). 비교 Grid·블록·조건·SQLite 저장·Helper 연결. `npm run start:lite` → 4318. 소유: Codex | 포함 |
| `examples/quick/` | 빠른 생성 예시 서식(한컴 저장본)과 데이터(가짜 값). 사용자가 고쳐 시험하는 용도. 순서는 그 폴더의 `README.md` | 포함 |
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
- **수정 사항은 GitHub 이슈로 등록한 뒤 처리한다**(사용자 지시 2026-10-04). 이슈 하나에 결함·보강 하나. 본문은 현상·재현·수정 범위·검증 방법만 적고 개인 경로·실제 문서 이름·대화 인용은 넣지 않는다. 커밋 메시지에 이슈 번호를 적고 끝나면 닫는다.
- 이슈·PR 명령은 `gh` CLI를 쓴다(설치·로그인은 사용자가 한다: `winget install GitHub.cli`, `gh auth login`). 없으면 등록할 이슈 목록을 보고에 적어 두었다가 생기는 대로 등록한다.
- **의존 정책**(사용자 지시 2026-10-04): 런타임 의존은 `@rhwp/core`와 Node 내장만. `apps/studio-lite`의 `kordoc`·`markdown-it`은 제거한다(Markdown→HWPX 생성은 엔진의 문단 삽입·조각으로 대체, Markdown 미리보기는 자체 최소 변환). lite의 `vendor/rhwp` 사본은 공용 뷰어의 `@rhwp/core`로 통일한다. CI에서 런타임 의존 허용 목록을 검사한다(Codex 소유).
- **역할 분담**(사용자 결정 2026-10-04): Claude = 엔진(`packages/hwpx-engine`)·뷰어(`packages/viewer`)·템플릿 모델·정본 문서(`docs/`)·검증·합치기. Codex = 앱(`apps/studio-lite`)·화면·SQLite 저장·데이터 입력·Helper 연결·CI(`.github/`). 서로의 파일을 건드리지 않는다. 엔진 API 변경으로 앱이 깨지면 엔진 옵션으로 흡수하거나 이슈로 넘긴다.
- **가지**: `studio-lite` 가지는 2026-10-04 main에 합쳤고(`6394dbb`) 삭제한다. 이후 가지는 이슈별 작업 가지(`issue-N-주제`)뿐이며 PR 대상은 main이다.
- **단계 운영**(사용자 지시 2026-10-04): 단계마다 마일스톤(목표·범위·제외사항·완료 기준)과 이슈(작업 내용·선행 작업·검사 방법·산출물)를 초안으로 먼저 보이고 기존 것과 중복을 확인한 뒤 등록한다. 첫 화면 검토와 단계 종료 검토는 별도 이슈다. 이슈마다 가지(`issue-N-주제`)와 PR을 만들고, 구현 중 진행 상황과 검사 근거(테스트 수치, 독립 검증 요지)를 이슈·PR에 남긴다. 합치기는 CI 통과와 필요한 독립 검증 뒤에 한다.

## Skill

| 위치 | 내용 |
| --- | --- |
| `skills/` | 정본 6종: `focused-plan`, `root-cause-fix`, `verify-change`, `session-handoff`, `review-boundaries`, `delegate-bounded-task` |
| `.claude/skills/` | 위 6종의 사본 |
| `.claude/agents/` | 위임 역할 3종 |

Skill을 고칠 때는 `skills/`를 고치고 `.claude/skills/`로 다시 복사한다.
