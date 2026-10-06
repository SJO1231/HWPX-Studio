import { HwpxError, type Issue } from "../errors.ts";
import { decodeEntities } from "../xml/chars.ts";
import type {
  Fragment,
  FragmentBinary,
  FragmentDangling,
  FragmentRef,
  FragmentResource,
  InstanceIdRole,
} from "./types.ts";

export const FRAGMENT_SCHEMA = "hwpx-studio/fragment@1";

const ROLES: readonly string[] = ["object", "inst", "fieldBegin", "fieldEndRef", "paragraph"];

function fail(what: string): never {
  throw new HwpxError("FRAG_SCHEMA", `조각이 올바르지 않습니다: ${what}`);
}

/** 조각을 JSON 문자열로 저장한다. */
export function serializeFragment(fragment: Fragment): string {
  return JSON.stringify(fragment);
}

// ── 읽기: 알 수 없는 JSON을 검사하며 Fragment로 만든다 ─────────────────────

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${path}가 객체가 아닙니다`);
  return v as Obj;
}
function str(o: Obj, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== "string") fail(`${path}.${key}가 문자열이 아닙니다`);
  return v;
}
function int(o: Obj, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(`${path}.${key}가 0 이상의 정수가 아닙니다`);
  return v;
}
function list(o: Obj, key: string, path: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) fail(`${path}.${key}가 배열이 아닙니다`);
  return v;
}
function strMap(o: Obj, key: string, path: string): Record<string, string> {
  const m = obj(o[key], `${path}.${key}`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== "string") fail(`${path}.${key}.${k}가 문자열이 아닙니다`);
    out[k] = v;
  }
  return out;
}
function span(o: Obj, path: string): { start: number; end: number } {
  return { start: int(o, "start", path), end: int(o, "end", path) };
}
function ref(v: unknown, path: string): FragmentRef {
  const o = obj(v, path);
  const out: FragmentRef = { kind: str(o, "kind", path), id: str(o, "id", path), ...span(o, path) };
  if (o["lang"] !== undefined) out.lang = str(o, "lang", path);
  return out;
}

/** JSON 문자열을 조각으로 읽는다. 형식이 틀리면 `FRAG_SCHEMA`. */
export function parseFragment(json: string): Fragment {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fail("JSON으로 읽을 수 없습니다");
  }
  const o = obj(raw, "조각");
  if (o["schema"] !== FRAGMENT_SCHEMA) fail(`schema가 ${FRAGMENT_SCHEMA}가 아닙니다`);

  const source = obj(o["source"], "source");
  const sel = obj(source["selection"], "source.selection");
  const census = obj(o["census"], "census");

  const resources = list(o, "resources", "조각").map((v, i): FragmentResource => {
    const p = `resources[${i}]`;
    const r = obj(v, p);
    const out: FragmentResource = {
      kind: str(r, "kind", p),
      id: str(r, "id", p),
      xml: str(r, "xml", p),
      idSpan: span(obj(r["idSpan"], `${p}.idSpan`), `${p}.idSpan`),
      refs: list(r, "refs", p).map((x, j) => ref(x, `${p}.refs[${j}]`)),
      fingerprint: str(r, "fingerprint", p),
      prefixes: strMap(r, "prefixes", p),
      namespaces: strMap(r, "namespaces", p),
    };
    if (r["lang"] !== undefined) out.lang = str(r, "lang", p);
    if (r["valueNamespaces"] !== undefined) out.valueNamespaces = strMap(r, "valueNamespaces", p);
    if (r["nameSpan"] !== undefined) out.nameSpan = span(obj(r["nameSpan"], `${p}.nameSpan`), `${p}.nameSpan`);
    return out;
  });

  const fragment: Fragment = {
    schema: FRAGMENT_SCHEMA,
    source: {
      sha256: str(source, "sha256", "source"),
      selection: {
        sectionIndex: int(sel, "sectionIndex", "source.selection"),
        parentPath: list(sel, "parentPath", "source.selection").map((n) =>
          typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : fail("source.selection.parentPath가 정수 배열이 아닙니다"),
        ),
        from: int(sel, "from", "source.selection"),
        to: int(sel, "to", "source.selection"),
      },
      // 이전 형식 조각에는 없다(없으면 형식 버전을 알 수 없는 조각으로 읽는다)
      ...(source["xmlVersion"] === undefined ? {} : { xmlVersion: str(source, "xmlVersion", "source") }),
    },
    xml: str(o, "xml", "조각"),
    prefixes: strMap(o, "prefixes", "조각"),
    namespaces: strMap(o, "namespaces", "조각"),
    refs: list(o, "refs", "조각").map((x, i) => ref(x, `refs[${i}]`)),
    resources,
    binaries: list(o, "binaries", "조각").map((v, i): FragmentBinary => {
      const p = `binaries[${i}]`;
      const b = obj(v, p);
      return {
        itemId: str(b, "itemId", p),
        href: str(b, "href", p),
        mediaType: str(b, "mediaType", p),
        sha256: str(b, "sha256", p),
        base64: str(b, "base64", p),
      };
    }),
    instanceIds: list(o, "instanceIds", "조각").map((v, i) => {
      const p = `instanceIds[${i}]`;
      const x = obj(v, p);
      const role = str(x, "role", p);
      if (!ROLES.includes(role)) fail(`${p}.role '${role}'을(를) 알 수 없습니다`);
      return { role: role as InstanceIdRole, value: str(x, "value", p), ...span(x, p) };
    }),
    bookmarks: list(o, "bookmarks", "조각").map((v, i) => {
      const p = `bookmarks[${i}]`;
      const x = obj(v, p);
      return { name: str(x, "name", p), ...span(x, p) };
    }),
    lineSegSpans: list(o, "lineSegSpans", "조각").map((v, i) => span(obj(v, `lineSegSpans[${i}]`), `lineSegSpans[${i}]`)),
    texts: list(o, "texts", "조각").map((t) => (typeof t === "string" ? t : fail("texts가 문자열 배열이 아닙니다"))),
    prints: list(o, "prints", "조각").map((t) => (typeof t === "string" ? t : fail("prints가 문자열 배열이 아닙니다"))),
    // 이전 형식 조각에는 없다(없으면 빈 목록: 상속한 없는 참조를 모르는 채로 읽는다)
    dangling: o["dangling"] === undefined ? [] : list(o, "dangling", "조각").map((v, i): FragmentDangling => {
      const p = `dangling[${i}]`;
      const x = obj(v, p);
      return { kind: str(x, "kind", p), id: str(x, "id", p), count: int(x, "count", p) };
    }),
    census: {
      paragraphs: int(census, "paragraphs", "census"),
      tables: int(census, "tables", "census"),
      pictures: int(census, "pictures", "census"),
      fields: int(census, "fields", "census"),
      bookmarks: int(census, "bookmarks", "census"),
    },
    issues: list(o, "issues", "조각").map((v, i): Issue => {
      const p = `issues[${i}]`;
      const x = obj(v, p);
      const severity = str(x, "severity", p);
      if (severity !== "error" && severity !== "warning") fail(`${p}.severity가 올바르지 않습니다`);
      const out: Issue = { severity, code: str(x, "code", p), message: str(x, "message", p) };
      if (x["where"] !== undefined) out.where = str(x, "where", p);
      return out;
    }),
  };
  validateFragment(fragment);
  return fragment;
}

// ── 일관성 검사 ─────────────────────────────────────────────────

function checkSpan(length: number, s: { start: number; end: number }, what: string): void {
  if (s.start > s.end || s.end > length) fail(`${what}의 구간 [${s.start}, ${s.end})이 원문(길이 ${length})을 벗어납니다`);
}

function checkValueAt(xml: string, s: { start: number; end: number }, value: string, what: string): void {
  checkSpan(xml.length, s, what);
  let raw: string;
  try {
    raw = decodeEntities(xml.slice(s.start, s.end));
  } catch {
    return fail(`${what}의 구간을 해독할 수 없습니다`);
  }
  if (raw !== value) fail(`${what}의 구간 값이 '${value}'와 다릅니다`);
}

/**
 * 구간이 원문 안에 있고 구간의 값이 선언과 같은지, 참조가 조각 안의 자원·이진 자료를 가리키는지 확인한다.
 * 어긋나면 `FRAG_SCHEMA`.
 */
export function validateFragment(f: Fragment): void {
  if (f.schema !== FRAGMENT_SCHEMA) fail(`schema가 ${FRAGMENT_SCHEMA}가 아닙니다`);
  const targets = new Set(f.resources.map((r) => JSON.stringify([r.kind, r.lang ?? "", r.id])));
  const binaryIds = new Set(f.binaries.map((b) => b.itemId));
  const checkRef = (r: FragmentRef, xml: string, what: string): void => {
    checkValueAt(xml, r, r.id, what);
    const known = r.kind === "binaryItem" ? binaryIds.has(r.id) : targets.has(JSON.stringify([r.kind, r.lang ?? "", r.id]));
    if (!known) fail(`${what}이(가) 조각에 없는 ${r.kind} ${r.id}을(를) 가리킵니다`);
  };
  f.refs.forEach((r, i) => checkRef(r, f.xml, `refs[${i}]`));
  f.instanceIds.forEach((x, i) => checkValueAt(f.xml, x, x.value, `instanceIds[${i}]`));
  f.bookmarks.forEach((b, i) => checkValueAt(f.xml, b, b.name, `bookmarks[${i}]`));
  f.lineSegSpans.forEach((s, i) => checkSpan(f.xml.length, s, `lineSegSpans[${i}]`));
  f.resources.forEach((r, i) => {
    checkValueAt(r.xml, r.idSpan, r.id, `resources[${i}].idSpan`);
    r.refs.forEach((x, j) => checkRef(x, r.xml, `resources[${i}].refs[${j}]`));
    if (r.nameSpan !== undefined) checkSpan(r.xml.length, r.nameSpan, `resources[${i}].nameSpan`);
  });
}
