// 조건 `matches`의 정규식을 읽을 때(템플릿)와 평가할 때(입력 글) 막는 한도. 정규식 엔진의 되돌아가기(backtracking)가
// 중첩 수량자 패턴에서 입력 길이에 지수로 늘어나는 시간을 쓰는 것(`^(a+)+$`에 27글자가 6초)을 막으려는 것이다.

/** 패턴 길이 한도(글자 수). 읽을 때 넘으면 거절한다. */
export const MAX_PATTERN_LENGTH = 200;

/** 평가할 때 보는 입력 글의 한도(UTF-16 단위). 넘으면 거짓이 아니라 오류로 중단한다. */
export const MAX_MATCH_INPUT = 10_000;

type Quantifier = { /** 반복 횟수가 정해져 있지 않다(`*`, `+`, `{n,}`, `{n,m}`(m > n)) */ variable: boolean; length: number };

/** `at`에서 시작하는 수량자(`*`, `+`, `{n}`, `{n,}`, `{n,m}`). 수량자가 아니면 undefined. `?`는 한 번 이하라 세지 않는다. */
function quantifierAt(pattern: string, at: number): Quantifier | undefined {
  const c = pattern[at];
  if (c === "*" || c === "+") return { variable: true, length: 1 };
  if (c !== "{") return undefined;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at, at + 24));
  if (m === null) return undefined; // 수량자 모양이 아닌 `{`는 글자 그대로다
  const variable = m[2] !== undefined && (m[3] === "" || Number(m[3]) > Number(m[1]));
  return { variable, length: m[0].length };
}

/**
 * 수량자가 붙은 묶음 안에 다시 가변 반복 수량자가 있는 중첩 수량자 형태(`(a+)+`, `(a*)*`, `(a+)*`, `(a{2,})+`, `((ab)+c)+` 등)인지 본다.
 * 묶음마다 "안에 가변 반복이 있는가"를 세고, 묶음이 닫힌 뒤 가변 수량자가 붙었을 때 안에 가변 반복이 있으면 중첩이다.
 * 가변 반복이 든 묶음은 수량자가 없어도 바깥 묶음 입장에서는 안에 가변 반복이 있는 것이다. 이스케이프(`\(`)와 문자 클래스(`[+*]`) 안의 기호는 보지 않는다.
 *
 * 보수적인 휴리스틱이다: 폭증하지 않는 일부 패턴(`^(a+b)+$`처럼 안쪽 반복이 바깥 반복과 겹치지 않는 것)도 거절하고,
 * 선택지가 겹치는 형태(`(a|a)+`, `(a|aa)+`)처럼 수량자가 중첩되지 않았지만 폭증하는 패턴은 잡지 못한다.
 * 정상 패턴을 막지 않도록 고정 횟수(`{3}`)와 `?`는 반복으로 세지 않는다.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const open: boolean[] = []; // 열린 묶음마다: 안에 가변 반복이 있는가
  const markEnclosing = (): void => {
    if (open.length > 0) open[open.length - 1] = true;
  };
  let inClass = false;
  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
    } else if (inClass) {
      if (c === "]") inClass = false;
      i++;
    } else if (c === "[") {
      inClass = true;
      i++;
    } else if (c === "(") {
      open.push(false);
      i++;
    } else if (c === ")") {
      const inner = open.pop() ?? false;
      const q = quantifierAt(pattern, i + 1);
      if (inner && q?.variable === true) return true;
      if (inner || q?.variable === true) markEnclosing();
      i += 1 + (q?.length ?? 0);
    } else {
      const q = quantifierAt(pattern, i);
      if (q?.variable === true) markEnclosing();
      i += q?.length ?? 1;
    }
  }
  return false;
}
