import { HwpxError } from "../errors.ts";
import { elIs, walkElements, attrNode, attrValue, type XElement } from "../xml/tree.ts";
import { escapeAttr } from "../xml/chars.ts";
import { applyReps, type Ctx, type Rep } from "./edit.ts";
import type { Reissuer } from "./ids.ts";
import type { CopyText } from "./types.ts";

export type CopyOptions = {
  /** `clear`이면 복사본 안 모든 `hp:t`의 내용(글·엔티티·탭·줄바꿈 등)을 비운다. 구조(표·그림·누름틀 짝)는 그대로다. */
  text: CopyText;
  /** 있으면 복사본의 인스턴스 id와 책갈피 이름을 새로 준다. 원본을 그대로 대신하는 복사본(반복의 첫 행)에는 주지 않는다. */
  reissue: Reissuer | undefined;
  /** 셀 이름(`tc@name`)을 비운다(복사본이 원본과 같은 이름을 갖지 않게) */
  blankCellNames?: boolean;
  /**
   * 복사본이 원본을 남긴 채 하나 더 생기는 복제이면 켠다: 복사 범위가 누름틀의 시작과 끝 사이를 자르면(짝이 범위 안에서 닫히지 않으면)
   * `TABLE_SPLITS_FIELD`로 거절한다. 그대로 복제하면 한 시작에 끝이 둘이 되거나 짝 없는 시작·끝이 생긴다.
   */
  closedFields?: boolean;
};

/**
 * 요소들 안에서 누름틀의 시작과 끝이 서로 짝을 이루는지 본다(같은 id가 겹쳐 열린 것은 안쪽부터 닫힌다). 짝이 닫히지 않으면 `TABLE_SPLITS_FIELD`.
 * `what`은 오류 문구의 동작(복제할·지울)이다. 복제와 삭제가 같이 쓴다: 어느 쪽이든 범위가 누름틀의 시작과 끝 사이를 자르면 한쪽 반이 남는다.
 */
export function assertFieldsClosed(elements: readonly XElement[], what = "복제할"): void {
  const open = new Map<string, number>();
  let strayEnds = 0;
  for (const el of elements) {
    if (elIs(el, "paragraph", "fieldBegin")) {
      const id = attrValue(el, "id") ?? "";
      open.set(id, (open.get(id) ?? 0) + 1);
    } else if (elIs(el, "paragraph", "fieldEnd")) {
      const id = attrValue(el, "beginIDRef") ?? "";
      const n = open.get(id) ?? 0;
      if (n === 0) strayEnds++;
      else open.set(id, n - 1);
    }
  }
  const strayBegins = [...open.values()].reduce((sum, n) => sum + n, 0);
  if (strayBegins > 0 || strayEnds > 0) {
    throw new HwpxError("TABLE_SPLITS_FIELD", `${what} 범위가 누름틀의 시작과 끝 사이를 자릅니다(범위 안에서 짝이 닫히지 않는 시작 ${strayBegins}개, 끝 ${strayEnds}개).`);
  }
}

/**
 * 요소 원문의 복사본을 만든다. 줄 배치 캐시(`linesegarray`)는 뺀다(복사본의 줄 배치는 원본의 것과 다르다).
 * `extra`는 복사본 원문 기준(요소 시작이 0) 추가 치환이다(행·열 주소 등).
 */
export function copyElement(ctx: Ctx, el: XElement, options: CopyOptions, extra: Rep[] = []): string {
  const reps: Rep[] = [...extra];
  const all = [...walkElements(el)];
  if (options.closedFields === true) assertFieldsClosed(all);
  for (const x of all) {
    if (elIs(x, "paragraph", "linesegarray")) {
      reps.push({ start: x.start - el.start, end: x.end - el.start, text: "" });
    } else if (options.text === "clear" && elIs(x, "paragraph", "t") && x.closeStart > x.openEnd) {
      reps.push({ start: x.openEnd - el.start, end: x.closeStart - el.start, text: "" });
    } else if (options.blankCellNames === true && elIs(x, "paragraph", "tc")) {
      const name = attrNode(x, "name");
      if (name !== undefined && name.value !== "") reps.push({ start: name.valueStart - el.start, end: name.valueEnd - el.start, text: escapeAttr("") });
    }
  }
  if (options.reissue !== undefined) reps.push(...options.reissue.reps(all, el.start));
  return applyReps(ctx.text.slice(el.start, el.end), reps);
}
