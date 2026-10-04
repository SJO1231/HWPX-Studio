import { escapeAttr, escapeText } from "../xml/chars.ts";

/**
 * 한컴이 만든 누름틀의 `fieldid`. 한컴 13이 저장한 문서에서 누름틀마다 같은 값이었다
 * (`hancom-field.hwpx`, `hancom/field-states.hwpx`의 네 개 모두). 그래서 새 값을 만들지 않고 그대로 쓴다.
 */
export const HANCOM_FIELD_ID = "627272811";

/** 누름틀 시작 요소(`fieldBegin`). 요소·속성 구성은 한컴이 만든 누름틀(`hancom-field.hwpx`)과 같고, 안내문은 이름과 같다. `dirty`는 "1"(글이 값이다). */
export function fieldBeginXml(prefix: string, id: string, name: string): string {
  const direction = name;
  const part1 = `Direction:wstring:${direction.length}:${direction} `;
  const part2 = "HelpState:wstring:0: ";
  const command = `Clickhere:set:${(part1 + part2).length}:${part1}${part2} `;
  const p = prefix;
  return (
    `<${p}fieldBegin id="${id}" type="CLICK_HERE" name="${escapeAttr(name)}" editable="1" dirty="1" zorder="-1" fieldid="${HANCOM_FIELD_ID}" metaTag="">` +
    `<${p}parameters cnt="3" name=""><${p}integerParam name="Prop">9</${p}integerParam>` +
    `<${p}stringParam name="Command" xml:space="preserve">${escapeText(command)}</${p}stringParam>` +
    `<${p}stringParam name="Direction">${escapeText(direction)}</${p}stringParam></${p}parameters></${p}fieldBegin>`
  );
}

/** 누름틀 시작 컨트롤(`ctrl`로 감싼 `fieldBegin`). */
export const beginXml = (prefix: string, id: string, name: string): string => `<${prefix}ctrl>${fieldBeginXml(prefix, id, name)}</${prefix}ctrl>`;

export const endXml = (prefix: string, id: string): string => `<${prefix}ctrl><${prefix}fieldEnd beginIDRef="${id}" fieldid="${HANCOM_FIELD_ID}"/></${prefix}ctrl>`;
