# CLAUDE.md

@AGENTS.md

이 파일은 Claude Code의 진입점이다. 공통 행동규칙과 프로젝트 경계(정본 위치, 역할 분담, 참고·의존 규칙, 실제 문서 취급, 한컴·시험, Git·이슈)의 정본은 AGENTS.md이며 Codex 등 다른 Agent도 같은 파일을 읽는다.

- 이 파일에 공통 규칙이나 작업 이력을 중복 작성하지 않는다.
- 필요한 프로젝트 계약과 설치된 Skill만 해당 작업에서 읽는다. Skill 본문·템플릿·출처 조사자료를 전부 시작 컨텍스트에 불러오지 않는다.
- 이 파일을 읽는 행위는 코드 변경·위임·외부 게시에 대한 별도 승인이 아니다.
- Claude 전용 설정: Skill은 `.claude/skills/`에(정본은 `skills/`), 위임 역할(kf-implementer·kf-verifier·kf-checker)의 설정은 `.claude/agents/`에 있다. 구현은 kf-implementer, 독립 검증은 kf-verifier에 위임하고 결과를 직접 재실행해 확인한다.
