// `{{경로}}` 표기: `{{` 공백* 경로 공백* `}}`, 경로는 `이름(.이름)*`, 이름은 글자·숫자·`_`·`-`.

export type Placeholder = {
  /** 문자열 안의 구간 `[start, end)`(여는 `{{`부터 닫는 `}}` 끝까지) */
  start: number;
  end: number;
  path: string;
};

const NAME = String.raw`[\p{L}\p{N}_-]+`;
const PATH = String.raw`${NAME}(?:\.${NAME})*`;
const SOURCE = String.raw`\{\{\s*(${PATH})\s*\}\}`;

/** 문자열에서 `{{경로}}` 표기를 앞에서부터 모두 찾는다. */
export function findPlaceholders(text: string): Placeholder[] {
  const found: Placeholder[] = [];
  const re = new RegExp(SOURCE, "gu");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    found.push({ start: m.index, end: m.index + m[0].length, path: m[1] ?? "" });
  }
  return found;
}

const PATH_ONLY = new RegExp(`^${PATH}$`, "u");

/** 값 경로로 쓸 수 있는 문자열인가(`이름(.이름)*`). */
export function isValidPath(path: string): boolean {
  return PATH_ONLY.test(path);
}
