import { HwpxError } from "../errors.ts";
import { parseXmlBytes } from "../xml/parse.ts";
import { attrValue, elIs, subElements, type XElement } from "../xml/tree.ts";
import type { HwpxPackage } from "./open.ts";
import { findEntry, readEntry } from "./zip-read.ts";

// 형식 버전(`version.xml`의 xmlVersion)과 단위. 근거는 검증 기준 26절의 한컴 실측이다:
// 여백·간격 값을 xmlVersion 1.5 이상이면 HWPUNIT으로, 그 아래면 그 2배 단위(옛 단위)로 받고, HwpUnitChar 스위치는 형식과 관계없이 `hp:case`로 읽는다.

export const VERSION_ENTRY = "version.xml";
export const HWPUNITCHAR_NS = "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar";

/** 패키지의 형식 버전(`version.xml` 루트의 `xmlVersion`). 항목·속성이 없거나 XML로 읽을 수 없으면 undefined(알 수 없음). */
export function readXmlVersion(pkg: HwpxPackage): string | undefined {
  if (findEntry(pkg.archive, VERSION_ENTRY) === undefined) return undefined;
  try {
    return attrValue(parseXmlBytes(readEntry(pkg.archive, pkg.bytes, VERSION_ENTRY), VERSION_ENTRY).root, "xmlVersion");
  } catch (e) {
    if (e instanceof HwpxError) return undefined;
    throw e;
  }
}

/** 형식 버전이 여백·간격을 HWPUNIT으로 받는 형식(1.5 이상)인가. "주.부"로 읽히지 않으면 undefined. */
export function isUnitCharFormat(version: string | undefined): boolean | undefined {
  const m = version === undefined ? null : /^(\d+)\.(\d+)/.exec(version.trim());
  if (m === null) return undefined;
  const major = Number(m[1]);
  return major > 1 || (major === 1 && Number(m[2]) >= 5);
}

/** `hp:switch`의 `hp:case` 가운데 HwpUnitChar 네임스페이스를 요구하는 것 */
export function unitCharCase(el: XElement): XElement | undefined {
  if (!elIs(el, "paragraph", "switch")) return undefined;
  return subElements(el).find(
    (c) => elIs(c, "paragraph", "case") && c.attrs.some((a) => a.qname.slice(a.qname.indexOf(":") + 1) === "required-namespace" && a.value === HWPUNITCHAR_NS),
  );
}

/** `hp:case` 가운데 하나가 HwpUnitChar 네임스페이스를 요구하는 `hp:switch` */
export function isUnitSwitch(el: XElement): boolean {
  return unitCharCase(el) !== undefined;
}
