import { makeIssue, type Issue } from "../errors.ts";

// 참조 번호 자동 재정렬(엔진 명세 8.8.12): 문단 글만 보고 번호를 바꿀 곳을 계획한다. 문서 형식을 모르는 순수 함수다(8.5).

/** 바꿀 곳 하나: `texts[index]`의 [start, end) 숫자를 `text`로 */
export type RenumberEdit = { index: number; start: number; end: number; text: string };
/** 바꿀 곳(문단 순서·위치 순), 대응 없는 참조 경고(`RENUMBER_UNMATCHED`), 찾은 대상·참조 수 */
export type RenumberPlan = { edits: RenumberEdit[]; issues: Issue[]; targets: number; references: number };

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GAP = "[ \\u00A0\\u3000]*";

/**
 * 글자 꼴(예: "붙임")마다 대상과 참조를 찾아 번호를 다시 매긴다. texts는 문서 순서의 문단 글이다.
 * - 대상: 문단 첫머리(공백·개체 자리 글자 뒤)의 `[P N]`·`<P N>`·`P N.`이고 바로 뒤가 공백이거나 글 끝이다(문단마다 하나).
 * - 참조: 그 밖의 `P N`(앞이 글자·숫자가 아니고, 뒤가 글자·숫자나 `.`·`-`와 숫자(하위 번호)가 아님. 괄호·꺾쇠와 무관).
 * - 대상의 번호를 처음 나온 순서로 1부터 다시 매기고(같은 번호의 대상이 여럿이면 한 번호), 대상과 참조를 같은 대응으로 바꾼다.
 *   대응하는 대상이 없는 참조는 그대로 두고 꼴·번호마다 경고 하나(`RENUMBER_UNMATCHED`, 건수)를 낸다.
 */
export function planRenumber(texts: readonly string[], patterns: readonly string[]): RenumberPlan {
  const edits: RenumberEdit[] = [];
  const issues: Issue[] = [];
  let targets = 0;
  let references = 0;
  for (const pattern of patterns) {
    const p = escape(pattern);
    const head = new RegExp(`^[\\s\\uFFFC]*(?:\\[${p}${GAP}(\\d{1,9})\\]|<${p}${GAP}(\\d{1,9})>|${p}${GAP}(\\d{1,9})\\.)(?=\\s|$)`, "u");
    const mark = new RegExp(`(?<![\\p{L}\\p{N}])${p}${GAP}(\\d{1,9})(?![\\p{L}\\p{N}]|[.\\-]\\p{N})`, "gu");
    const found: { index: number; start: number; end: number; n: number; target: boolean }[] = [];
    texts.forEach((text, index) => {
      const h = head.exec(text);
      // 대상의 세 꼴은 모두 닫는 글자 하나(`]`·`>`·`.`)로 끝나므로 숫자는 그 앞이다
      const headEnd = h === null ? -1 : h[0].length - 1;
      for (const m of text.matchAll(mark)) {
        const digits = m[1] ?? "";
        const end = m.index + m[0].length;
        found.push({ index, start: end - digits.length, end, n: Number(digits), target: end === headEnd });
      }
    });
    const rank = new Map<number, number>();
    for (const f of found) if (f.target && !rank.has(f.n)) rank.set(f.n, rank.size + 1);
    const unmatched = new Map<number, number>();
    for (const f of found) {
      if (f.target) targets++;
      else references++;
      const to = rank.get(f.n);
      if (to === undefined) unmatched.set(f.n, (unmatched.get(f.n) ?? 0) + 1);
      else if (to !== f.n) edits.push({ index: f.index, start: f.start, end: f.end, text: String(to) });
    }
    for (const [n, count] of unmatched) {
      issues.push(makeIssue("warning", "RENUMBER_UNMATCHED", `참조 '${pattern} ${n}' ${count}곳에 대응하는 대상(문단 첫머리의 [${pattern} N]·<${pattern} N>·${pattern} N.)이 없어 번호를 그대로 두었습니다.`, `renumber:${pattern}`));
    }
  }
  edits.sort((a, b) => a.index - b.index || a.start - b.start);
  return { edits, issues, targets, references };
}
