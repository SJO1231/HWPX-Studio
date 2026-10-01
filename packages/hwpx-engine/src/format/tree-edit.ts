import { HwpxError } from "../errors.ts";
import { escapeAttr } from "../xml/chars.ts";
import { tokenize, type XAttr } from "../xml/tokenizer.ts";
import { buildTree, subElements, elIs, nsRole, type XElement } from "../xml/tree.ts";
import { CHILD_ORDER } from "./order.ts";
import type { FormatOp } from "./types.ts";

/**
 * 자원 하나의 원문(문자열)에 서식 변경 연산을 적용한다. 모든 변경은 원문 문자열의 구간 치환이고, 요소를 다시 직렬화하지 않는다.
 * 연산마다 원문을 `<w xmlns...>원문</w>`으로 감싸 다시 읽는다(접두사 해석에 필요한 선언은 header 루트에서 가져온다).
 */
export type EditEnv = {
  /** 감싸는 요소의 시작 태그에 넣는 선언들(` xmlns:hh="..."` 꼴) */
  decls: string;
  /** 네임스페이스 역할 → 접두사(header 루트의 선언에서, 먼저 선언된 것) */
  prefixes: Map<string, string>;
};

export function makeEditEnv(headerRoot: XElement): EditEnv {
  let decls = "";
  const prefixes = new Map<string, string>();
  for (const a of headerRoot.attrs) {
    const isDefault = a.qname === "xmlns";
    if (!isDefault && !a.qname.startsWith("xmlns:")) continue;
    decls += ` ${a.qname}="${escapeAttr(a.value)}"`;
    const role = nsRole(a.value);
    if (!prefixes.has(role)) prefixes.set(role, isDefault ? "" : a.qname.slice(6));
  }
  return { decls, prefixes };
}

type Splice = { start: number; end: number; text: string };

function spliceSpans(full: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) throw new HwpxError("FMT_PATH", "서식 변경 연산의 편집 구간이 겹칩니다.");
    out += full.slice(pos, s.start) + s.text;
    pos = s.end;
  }
  return out + full.slice(pos);
}

type Parsed = { full: string; shift: number; resource: XElement };

function parseResource(text: string, env: EditEnv): Parsed {
  const open = `<w${env.decls}>`;
  const full = `${open}${text}</w>`;
  const wrapper = buildTree(full, tokenize(full));
  const resource = subElements(wrapper)[0];
  if (resource === undefined) throw new HwpxError("FMT_PATH", "자원 원문에 요소가 없습니다.");
  return { full, shift: open.length, resource };
}

/** 연산 결과를 감싸는 요소를 떼어 원문으로 돌려준다. */
function unwrap(p: Parsed, full: string): string {
  return full.slice(p.shift, full.length - "</w>".length);
}

// ── 경로 해석 ───────────────────────────────────────────────────

type Branch = "direct" | "case" | "default";
type Target = { el: XElement; branch: Branch };

const isSwitch = (el: XElement): boolean => elIs(el, "paragraph", "switch");
const isBranchEl = (el: XElement): boolean => elIs(el, "paragraph", "case") || elIs(el, "paragraph", "default");

/** `parent`의 자식 중 이름이 `name`인 것. 조건 분기 요소(`switch`의 `case`·`default`) 안의 것도 모두 찾는다. */
function named(parent: Target, name: string): Target[] {
  const out: Target[] = [];
  const visit = (el: XElement, branch: Branch): void => {
    for (const c of subElements(el)) {
      if (c.local === name && !isSwitch(c) && !isBranchEl(c)) out.push({ el: c, branch });
      else if (isSwitch(c)) {
        for (const b of subElements(c)) if (isBranchEl(b)) visit(b, b.local === "default" ? "default" : "case");
      }
    }
  };
  visit(parent.el, parent.branch);
  return out;
}

function resolve(resource: XElement, path: string[]): Target[] {
  let targets: Target[] = [{ el: resource, branch: "direct" }];
  for (const name of path) targets = targets.flatMap((t) => named(t, name));
  return targets;
}

// ── 검증 ────────────────────────────────────────────────────────

const NAME = /^[A-Za-z_][\w.-]*$/;
const ATTR_NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;

function checkName(name: string, what: string): void {
  if (!NAME.test(name)) throw new HwpxError("FMT_BAD_OP", `${what} '${name}'이(가) 요소 이름 형식이 아닙니다.`);
}

function checkAttr(name: string, value: string | undefined): void {
  if (!ATTR_NAME.test(name)) throw new HwpxError("FMT_BAD_OP", `속성 이름 '${name}'이(가) 올바르지 않습니다.`);
  if (value !== undefined && /[\t\r\n]/.test(value)) throw new HwpxError("FMT_BAD_VALUE", `속성 ${name}의 값에 탭·줄바꿈을 쓸 수 없습니다.`);
}

// ── 속성 편집 ───────────────────────────────────────────────────

const attrOf = (el: XElement, name: string): XAttr | undefined => el.attrs.find((a) => a.qname === name);

function setAttrSplice(full: string, el: XElement, name: string, value: string): Splice | undefined {
  const escaped = escapeAttr(value);
  const attr = attrOf(el, name);
  if (attr !== undefined) {
    if (full.slice(attr.valueStart, attr.valueEnd) === escaped) return undefined;
    return { start: attr.valueStart, end: attr.valueEnd, text: escaped };
  }
  const last = el.attrs.at(-1);
  const at = last === undefined ? el.start + 1 + el.qname.length : last.valueEnd + 1;
  return { start: at, end: at, text: ` ${name}="${escaped}"` };
}

function removeAttrSplice(full: string, el: XElement, name: string): Splice | undefined {
  const attr = attrOf(el, name);
  if (attr === undefined) return undefined;
  let start = attr.nameStart;
  while (start > el.start && /\s/.test(full[start - 1] ?? "")) start--;
  return { start, end: attr.valueEnd + 1, text: "" };
}

// ── 자식 만들기 ─────────────────────────────────────────────────

function prefixFor(role: string, parent: XElement, env: EditEnv): string {
  const prefix = nsRole(parent.ns) === role ? parent.prefix : env.prefixes.get(role);
  if (prefix === undefined) throw new HwpxError("FMT_NO_PREFIX", `네임스페이스 역할 '${role}'의 접두사가 header에 선언돼 있지 않습니다.`);
  return prefix === "" ? "" : `${prefix}:`;
}

/** 자식의 관측 순서 위치. 알 수 없으면 -1. `switch`는 첫 갈래 안의 자식들 가운데 가장 앞선 위치를 쓴다. */
function orderIndex(order: { name: string }[], el: XElement): number {
  if (isSwitch(el)) {
    const branch = subElements(el).find(isBranchEl);
    const inner = (branch === undefined ? [] : subElements(branch)).map((c) => order.findIndex((o) => o.name === c.local)).filter((i) => i >= 0);
    return inner.length === 0 ? -1 : Math.min(...inner);
  }
  return order.findIndex((o) => o.name === el.local);
}

function childSplice(full: string, parent: XElement, name: string, attrs: Record<string, string> | undefined, env: EditEnv): Splice {
  const order = CHILD_ORDER[parent.local];
  const spec = order?.find((c) => c.name === name);
  if (order === undefined || spec === undefined) {
    throw new HwpxError("FMT_UNKNOWN_CHILD", `${parent.local} 아래 자식 '${name}'의 위치를 관측한 적이 없어 만들 수 없습니다.`);
  }
  let attrText = "";
  for (const [k, v] of Object.entries(attrs ?? {})) {
    checkAttr(k, v);
    attrText += ` ${k}="${escapeAttr(v)}"`;
  }
  const child = `<${prefixFor(spec.role, parent, env)}${name}${attrText}/>`;

  if (parent.end === parent.openEnd) {
    // `<부모 .../>`는 펼친다
    return { start: parent.openEnd - 2, end: parent.openEnd, text: `>${child}</${parent.qname}>` };
  }
  const idx = order.findIndex((c) => c.name === name);
  const kids = subElements(parent);
  const after = kids.find((c) => orderIndex(order, c) > idx);
  const at = after !== undefined ? after.start : kids.length > 0 ? (kids.at(-1)?.end ?? parent.openEnd) : parent.openEnd;
  return { start: at, end: at, text: child };
}

/** `path`의 중간 요소가 없으면 빈 요소로 만든다. */
function ensurePath(text: string, env: EditEnv, path: string[]): string {
  let cur = text;
  for (let i = 0; i < path.length; i++) {
    const name = path[i] ?? "";
    checkName(name, "경로의 요소");
    for (let guard = 0; ; guard++) {
      const p = parseResource(cur, env);
      const lacking = resolve(p.resource, path.slice(0, i)).filter((t) => named(t, name).length === 0);
      if (lacking.length === 0) break;
      if (guard > 0) throw new HwpxError("FMT_PATH", `경로 '${path.join("/")}'의 '${name}'을(를) 만들지 못했습니다.`);
      cur = unwrap(p, spliceSpans(p.full, lacking.map((t) => childSplice(p.full, t.el, name, undefined, env))));
    }
  }
  return cur;
}

// ── 연산 ────────────────────────────────────────────────────────

function pickValue(op: Extract<FormatOp, { op: "setAttr" }>, t: Target): string {
  return t.branch === "default" && op.defaultBranchValue !== undefined ? op.defaultBranchValue : op.value;
}

export function applyOp(text: string, env: EditEnv, op: FormatOp): string {
  for (const name of op.path) checkName(name, "경로의 요소");
  switch (op.op) {
    case "setAttr": {
      checkAttr(op.name, op.value);
      if (op.defaultBranchValue !== undefined) checkAttr(op.name, op.defaultBranchValue);
      const ready = ensurePath(text, env, op.path);
      const p = parseResource(ready, env);
      const splices: Splice[] = [];
      for (const t of resolve(p.resource, op.path)) {
        const s = setAttrSplice(p.full, t.el, op.name, pickValue(op, t));
        if (s !== undefined) splices.push(s);
      }
      return unwrap(p, spliceSpans(p.full, splices));
    }
    case "addChild": {
      checkName(op.name, "자식 요소");
      const ready = ensurePath(text, env, op.path);
      const p = parseResource(ready, env);
      const splices: Splice[] = [];
      for (const parent of resolve(p.resource, op.path)) {
        const existing = named(parent, op.name);
        if (existing.length === 0) {
          splices.push(childSplice(p.full, parent.el, op.name, op.attrs, env));
          continue;
        }
        for (const [k, v] of Object.entries(op.attrs ?? {})) {
          checkAttr(k, v);
          for (const t of existing) {
            const s = setAttrSplice(p.full, t.el, k, v);
            if (s !== undefined) splices.push(s);
          }
        }
      }
      return unwrap(p, spliceSpans(p.full, splices));
    }
    case "removeChild": {
      checkName(op.name, "자식 요소");
      const p = parseResource(text, env);
      const splices = resolve(p.resource, op.path).flatMap((parent) =>
        named(parent, op.name).map((t): Splice => ({ start: t.el.start, end: t.el.end, text: "" })),
      );
      return unwrap(p, spliceSpans(p.full, splices));
    }
    case "removeAttr": {
      checkAttr(op.name, undefined);
      const p = parseResource(text, env);
      const splices: Splice[] = [];
      for (const t of resolve(p.resource, op.path)) {
        const s = removeAttrSplice(p.full, t.el, op.name);
        if (s !== undefined) splices.push(s);
      }
      return unwrap(p, spliceSpans(p.full, splices));
    }
    default:
      throw new HwpxError("FMT_BAD_OP", `알 수 없는 서식 변경 연산입니다: ${JSON.stringify(op)}`);
  }
}

/** 자원 원문의 시작 태그에서 `id` 속성값을 `newId`로 바꾼다. */
export function withId(text: string, env: EditEnv, newId: string): string {
  const p = parseResource(text, env);
  const s = setAttrSplice(p.full, p.resource, "id", newId);
  return s === undefined ? text : unwrap(p, spliceSpans(p.full, [s]));
}
