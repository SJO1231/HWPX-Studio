import { createHash } from "node:crypto";
import { HwpxError } from "../errors.ts";
import type { XAttr } from "../xml/tokenizer.ts";
import { elIs, nsRole, type XElement } from "../xml/tree.ts";
import type { InstanceIdRole } from "./types.ts";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** "참조 없음"을 뜻하는 관례값 */
const NO_REF = new Set(["4294967295", "-1"]);
export function isNoRef(id: string): boolean {
  return NO_REF.has(id);
}

/** 종류까지 보는 "참조 없음": 관례값에 더해, 빈 `binaryItemIDRef`(이진 자료가 없다는 뜻)도 참조가 아니다. 검사기도 빈 값은 오류가 아닌 경고(RES_EMPTY_REF)로 낸다. */
export function isNoRefOf(kind: string, id: string): boolean {
  return NO_REF.has(id) || (kind === "binaryItem" && id === "");
}

export type Rep = { start: number; end: number; text: string };

/** 구간 치환 목록을 적용한다. 구간이 겹치거나 범위를 벗어나면 조각이 일관되지 않은 것이다. */
export function applyReps(text: string, reps: Rep[]): string {
  const sorted = [...reps].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.end < r.start || r.end > text.length) {
      throw new HwpxError("FRAG_SCHEMA", `조각의 구간 [${r.start}, ${r.end})이 겹치거나 범위를 벗어납니다.`);
    }
    out += text.slice(pos, r.start) + r.text;
    pos = r.end;
  }
  return out + text.slice(pos);
}

// ── 네임스페이스 접두사 ───────────────────────────────────────────

function declaredUri(el: XElement, prefix: string): string | undefined {
  const name = prefix === "" ? "xmlns" : `xmlns:${prefix}`;
  return el.attrs.find((a) => a.qname === name)?.value;
}

/** `from`과 그 조상 중 접두사를 선언한 가장 가까운 요소와 URI */
function findDeclaration(from: XElement | null, prefix: string): { element: XElement; uri: string } | undefined {
  for (let el = from; el !== null; el = el.parent) {
    const uri = declaredUri(el, prefix);
    if (uri !== undefined) return { element: el, uri };
  }
  return undefined;
}

/**
 * 요소들(과 속성)이 쓰는 접두사 가운데 `outsideBefore`보다 앞에서 선언된 것을 모은다.
 * `prefixes`는 접두사 → 네임스페이스 역할, `namespaces`는 접두사 → 선언된 URI다.
 * 원문 안에서 스스로 선언한 접두사와 `xml`은 뺀다.
 */
export function collectPrefixes(
  elements: Iterable<XElement>,
  outsideBefore: number,
): { prefixes: Record<string, string>; namespaces: Record<string, string> } {
  const prefixes: Record<string, string> = {};
  const namespaces: Record<string, string> = {};
  const note = (el: XElement, prefix: string): void => {
    if (prefix === "xml" || prefix === "xmlns" || Object.hasOwn(prefixes, prefix)) return;
    const decl = findDeclaration(el, prefix);
    if (decl !== undefined && decl.element.start < outsideBefore) {
      prefixes[prefix] = nsRole(decl.uri);
      namespaces[prefix] = decl.uri;
    }
  };
  for (const el of elements) {
    note(el, el.prefix);
    for (const a of el.attrs) {
      const colon = a.qname.indexOf(":");
      if (colon > 0) note(el, a.qname.slice(0, colon));
    }
  }
  return { prefixes, namespaces };
}

/**
 * `hp:required-namespace`처럼 속성값으로 가리키는 네임스페이스 URI 가운데 `outsideBefore`보다 앞에서 접두사가 선언된 것을
 * 접두사 → URI로 모은다(URI를 선언한 가장 가까운 조상의 접두사). 한컴은 이 선언이 없어도 스위치를 같게 읽는다(검증 기준 26절).
 * 가져온 자원의 표기를 원본과 맞추는 정리 차원에서 쓴다.
 */
export function collectValueNamespaces(elements: Iterable<XElement>, outsideBefore: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of elements) {
    for (const a of el.attrs) {
      if (a.qname.slice(a.qname.indexOf(":") + 1) !== "required-namespace") continue;
      for (let at: XElement | null = el; at !== null; at = at.parent) {
        const decl = at.attrs.find((d) => d.qname.startsWith("xmlns:") && d.value === a.value);
        if (decl === undefined) continue;
        if (at.start < outsideBefore) out[decl.qname.slice("xmlns:".length)] = a.value;
        break;
      }
    }
  }
  return out;
}

/** `scope`나 그 조상에 그 접두사나 그 URI의 선언이 이미 있는가 */
export function declaresPrefixOrUri(scope: XElement | null, prefix: string, uri: string): boolean {
  for (let el = scope; el !== null; el = el.parent) {
    if (el.attrs.some((a) => a.qname === `xmlns:${prefix}` || (a.qname.startsWith("xmlns:") && a.value === uri))) return true;
  }
  return false;
}

/**
 * `scope`(새 요소가 놓일 곳의 부모)에서 조각의 접두사를 확인한다.
 * 같은 역할로 선언돼 있으면 통과하고, 다른 역할로 선언돼 있으면 `FRAG_NS_MISMATCH`다.
 * 선언돼 있지 않은 접두사는 루트에 선언을 더해야 하므로 접두사 → URI로 돌려준다(기본 네임스페이스는 더할 수 없어 거절한다).
 */
export function missingDeclarations(
  prefixes: Record<string, string>,
  namespaces: Record<string, string>,
  scope: XElement | null,
  where: string,
  what: string,
): Map<string, string> {
  const missing = new Map<string, string>();
  for (const [prefix, role] of Object.entries(prefixes)) {
    const decl = findDeclaration(scope, prefix);
    if (decl !== undefined) {
      if (nsRole(decl.uri) !== role) {
        throw new HwpxError("FRAG_NS_MISMATCH", `${what}: 접두사 '${prefix}'가 조각에서는 '${role}' 역할이고 대상에서는 '${nsRole(decl.uri)}' 역할입니다.`, where);
      }
      continue;
    }
    const uri = namespaces[prefix];
    if (prefix === "" || uri === undefined) {
      throw new HwpxError("FRAG_NS_MISMATCH", `${what}: 접두사 '${prefix}'(${role})가 대상에서 선언되지 않았고 더할 수 없습니다.`, where);
    }
    missing.set(prefix, uri);
  }
  return missing;
}

// ── 인스턴스 id ─────────────────────────────────────────────────

// 개체(표·도형 등)로 보아 id를 검사하는 요소(paragraph 역할)
const OBJECT_TAGS = new Set([
  "tbl", "pic", "ole", "container", "equation", "rect", "ellipse", "arc", "polygon", "curve", "line", "connectLine",
  "textart", "video", "chart", "compose", "dutmal", "btn", "radioBtn", "checkBtn", "comboBox", "edit", "listBox", "scrollBar",
]);

export type InstanceAttr = { role: InstanceIdRole; element: XElement; attr: XAttr };

/** 요소들에서 개체 id, instId(`instid`), 누름틀 시작 id, 누름틀 끝의 beginIDRef, 문단 id를 문서 순서로 찾는다. */
export function scanInstanceAttrs(elements: Iterable<XElement>): InstanceAttr[] {
  const found: InstanceAttr[] = [];
  for (const el of elements) {
    for (const attr of el.attrs) {
      let role: InstanceIdRole | undefined;
      if (attr.qname === "instId" || attr.qname === "instid") role = "inst";
      else if (attr.qname === "id" && nsRole(el.ns) === "paragraph") {
        if (OBJECT_TAGS.has(el.local)) role = "object";
        else if (el.local === "fieldBegin") role = "fieldBegin";
        else if (el.local === "p") role = "paragraph";
      } else if (attr.qname === "beginIDRef" && elIs(el, "paragraph", "fieldEnd")) role = "fieldEndRef";
      if (role !== undefined) found.push({ role, element: el, attr });
    }
  }
  return found;
}
