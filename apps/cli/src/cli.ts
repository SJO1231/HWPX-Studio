import { candidates, compile, diff, fill, fragmentCommand, inspect, tableCommand, validate } from "./commands.ts";
import { InputError, UsageError, type Out } from "./io.ts";

export const USAGE = `사용법: hwpx <명령> [옵션]

명령
  inspect <파일> [--json] [--model 출력.json]            구역·문단·표·누름틀·{{}}·자원 요약(.md·.txt는 블록·표·코드 블록·{{}}, --model 없음)
  candidates <파일> [--json]                            채울 자리 후보 목록
  fragment extract <파일> --section N --from A --to B [--parent 주소] -o 조각.json
  fragment import <대상> <조각.json> --section N --index I [--parent 주소] [--before] -o 출력.hwpx
       [--mode baseline|strict|repair] [--reissue-internal] [--report r.json] [--overwrite]
  fill <파일> --data d.json [--template t.json] -o 출력 [--missing error|empty|keep]
       [--dry-run] [--report r.json] [--overwrite]               확장자로 형식을 고른다(.hwpx, .md, .txt)
       .hwpx 전용: [--mode baseline|strict|repair] [--reissue-internal]
       .hwpx 여러 건(데이터가 배열): --batch -o 폴더 [--name "{{경로}}"]   원소마다 <원본 이름>-001.hwpx …
       .md·.txt 전용: [--fill-in-code]
  table list <파일> [--json]                            표마다 위치·행×열·너비·글자처럼 취급·쪽 나눔·제목 행 반복·병합 수(글 내용은 없음)
  table set <파일> --table 구역:순번 -o 출력.hwpx [--treat-as-char on|off] [--page-break cell|none|table]
       [--repeat-header on|off] [--width N | --scale X | --columns a,b,c] [--mode baseline|strict|repair]
       [--report r.json] [--overwrite]                       표 설정·크기 변경(저장 게이트 포함, 최상위 표만)
  validate <파일> [--baseline 원본] [--strict] [--json]  검사
  diff <원본> <결과> [--json]                            항목별 동일 여부와 수량 비교
  compile <파일> -o 승격본 --experimental [--merge-fields to-placeholder|to-field]
                                                        {{}}를 누름틀로(실험). 메일 머지 필드는 {{키}} 글(to-placeholder)이나 누름틀(to-field)로

.md·.txt는 inspect와 fill만 받는다. 나머지 명령은 .hwpx만 받는다.
옵션 --reissue-internal: 조각 안에서 겹치는 id를 새 값으로 바꾼다(기본은 소스 원문 그대로).
종료 코드: 0 성공, 1 검사·게이트 실패, 2 사용법 오류·읽을 수 없는 입력`;

/** 명령줄을 실행하고 종료 코드를 돌려준다. 출력은 `out`으로만 한다. */
export async function run(argv: string[], out: Out): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "inspect":
        return inspect(rest, out);
      case "candidates":
        return candidates(rest, out);
      case "fragment":
        return await fragmentCommand(rest, out);
      case "fill":
        return await fill(rest, out);
      case "table":
        return await tableCommand(rest, out);
      case "validate":
        return validate(rest, out);
      case "diff":
        return diff(rest, out);
      case "compile":
        return compile(rest, out);
      case "help":
      case "--help":
      case "-h":
        out.log(USAGE);
        return 0;
      default:
        out.err(command === undefined ? USAGE : `알 수 없는 명령입니다: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof InputError) {
      out.err(`오류: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
