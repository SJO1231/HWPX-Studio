import { scanInstanceAttrs } from "../fragment/util.ts";
import type { HwpxDocument } from "../model/types.ts";
import { escapeAttr } from "../xml/chars.ts";
import { attrNode, elIs, walkElements, type XElement } from "../xml/tree.ts";
import type { Rep } from "./edit.ts";

const MAX_ID = 4294967295;
/** 한컴이 여러 문단에 같은 값을 쓰는 자리값 문단 id. 겹쳐도 되므로 바꾸지 않고 새 값으로도 쓰지 않는다(조각 가져오기와 같다). */
const PARAGRAPH_PLACEHOLDERS = new Set(["", "0", "2147483648", "4294967295"]);

const isNumeric = (v: string): boolean => /^\d+$/.test(v) && Number(v) < MAX_ID;

/**
 * 복사본이 쓸 새 인스턴스 id와 책갈피 이름을 주는 상태. 한 계획 안의 복사본이 여럿이어도 서로 겹치지 않는다.
 * 규칙은 조각 가져오기(`planImport`)와 같다: 개체 id·instId·누름틀 시작 id는 대상 문서(와 지금까지 준 값)의 가장 큰 숫자 + 1부터 새 값을 주고
 * (자리값 `0`·빈 값도 새 값을 준다), 누름틀 끝의 `beginIDRef`는 짝인 시작이 받은 값으로 바꾼다. 문단 id는 자리값이 아니면 새 값(문단 id 최댓값 + 1부터,
 * 자리값은 건너뜀)을 준다. 책갈피 이름은 겹치면 `_1`, `_2` …를 붙인다. 복사본은 원본이 문서에 남아 있는 채로 쓰이므로 id는 전부 새로 준다.
 */
export type Reissuer = {
  /** `elements`(복사한 요소와 그 후손)의 id·책갈피 속성값 치환. `base`는 복사한 요소의 시작 오프셋이다. 새로 준 id 수는 `count`에 누적된다. */
  reps(elements: Iterable<XElement>, base: number): Rep[];
  /** 문서 밖에서 가져온 요소들이 쓰는 id·책갈피 이름도 겹치지 않게 기억한다. */
  observe(elements: Iterable<XElement>): void;
  /** 지금까지 새로 준 인스턴스 id 수 */
  readonly count: number;
};

export function makeReissuer(doc: HwpxDocument): Reissuer {
  let max = 0;
  let paragraphMax = 0;
  const paragraphTaken = new Set<string>();
  const bookmarks = new Set<string>();
  let count = 0;

  const observe = (elements: Iterable<XElement>): void => {
    const list = [...elements];
    for (const x of scanInstanceAttrs(list)) {
      if (x.role === "paragraph") {
        paragraphTaken.add(x.attr.value);
        if (isNumeric(x.attr.value)) paragraphMax = Math.max(paragraphMax, Number(x.attr.value));
      } else if (isNumeric(x.attr.value)) {
        max = Math.max(max, Number(x.attr.value));
      }
    }
    for (const el of list) {
      if (elIs(el, "paragraph", "bookmark")) {
        const name = attrNode(el, "name")?.value;
        if (name !== undefined) bookmarks.add(name);
      }
    }
  };
  for (const s of doc.sections) observe(walkElements(s.root));

  let counter = 0;
  const nextId = (): string => {
    counter = Math.max(counter, max) + 1;
    max = counter;
    count++;
    return String(counter);
  };
  let paragraphCounter = paragraphMax + 1;
  const nextParagraphId = (): string => {
    for (;;) {
      if (paragraphCounter >= MAX_ID) paragraphCounter = 1;
      const id = String(paragraphCounter++);
      if (!PARAGRAPH_PLACEHOLDERS.has(id) && !paragraphTaken.has(id)) {
        paragraphTaken.add(id);
        count++;
        return id;
      }
    }
  };

  return {
    observe,
    get count() {
      return count;
    },
    reps(elements, base) {
      const list = [...elements];
      const reps: Rep[] = [];
      const put = (attr: { valueStart: number; valueEnd: number }, text: string): void => {
        reps.push({ start: attr.valueStart - base, end: attr.valueEnd - base, text: escapeAttr(text) });
      };
      const open = new Map<string, string[]>(); // 원래 시작 id → 아직 닫히지 않은 시작이 받은 새 id(문서 순서)
      const latest = new Map<string, string>();
      for (const x of scanInstanceAttrs(list)) {
        if (x.role === "paragraph") {
          if (PARAGRAPH_PLACEHOLDERS.has(x.attr.value)) continue;
          put(x.attr, nextParagraphId());
        } else if (x.role === "fieldEndRef") {
          const next = open.get(x.attr.value)?.pop() ?? latest.get(x.attr.value);
          if (next !== undefined && next !== x.attr.value) put(x.attr, next);
        } else {
          const next = nextId();
          put(x.attr, next);
          if (x.role === "fieldBegin") {
            open.set(x.attr.value, [...(open.get(x.attr.value) ?? []), next]);
            latest.set(x.attr.value, next);
          }
        }
      }
      for (const el of list) {
        if (!elIs(el, "paragraph", "bookmark")) continue;
        const name = attrNode(el, "name");
        if (name === undefined) continue;
        let unique = name.value;
        if (bookmarks.has(unique)) {
          let k = 1;
          while (bookmarks.has(`${name.value}_${k}`)) k++;
          unique = `${name.value}_${k}`;
          put(name, unique);
        }
        bookmarks.add(unique);
      }
      return reps;
    },
  };
}
