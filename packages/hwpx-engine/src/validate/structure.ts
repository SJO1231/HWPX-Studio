import { attrValue, subElements, type XElement } from "../xml/tree.ts";
import type { IssueLog } from "./types.ts";

// 개체(표·도형 등) 요소: id/instId 검사 대상
const OBJECT_TAGS = new Set([
  "tbl", "pic", "ole", "container", "equation", "rect", "ellipse", "arc", "polygon", "curve", "line", "connectLine",
  "textart", "video", "chart", "compose", "dutmal", "btn", "radioBtn", "checkBtn", "comboBox", "edit", "listBox", "scrollBar",
]);
const RUN_KNOWN = new Set([...OBJECT_TAGS, "t", "ctrl", "secPr", "tab", "lineBreak", "fwSpace", "nbSpace", "hyphen"]);
const CTRL_KNOWN = new Set([
  "colPr", "pageNum", "pageNumCtrl", "header", "footer", "footNote", "endNote", "autoNum", "newNum", "bookmark", "fieldBegin",
  "fieldEnd", "hiddenComment", "indexmark", "pageHiding",
]);
const T_KNOWN = new Set([
  "tab", "lineBreak", "fwSpace", "nbSpace", "hyphen", "markpenBegin", "markpenEnd", "titleMark", "insertBegin", "insertEnd",
  "deleteBegin", "deleteEnd",
]);
/** 한컴이 여러 문단에 같은 값을 쓰는 것으로 알려진 자리값(미검증) */
const PLACEHOLDER_PARA_IDS = new Set(["", "0", "2147483648", "4294967295"]);
const TABLE_DEPTH_WARN = 3;

const SPACE_PARA = "paragraph id";
const SPACE_OBJECT = "object id (표·도형)";
const SPACE_INST = "instId";
const SPACE_FIELD = "field id";

type FieldBegin = { id: string | undefined; pos: number; fieldid: string | undefined };
type FieldEnd = { ref: string | undefined; pos: number; fieldid: string | undefined };

/** 구역 XML을 문서 순서로 훑으면서 모은 것 */
export type Acc = {
  paragraphs: number;
  tables: number;
  pictures: number;
  tableDepthMax: number;
  order: number;
  /** ID 공간 → (값, 위치 표시). 공간은 처음 나온 순서를 지킨다. */
  ids: Map<string, [string, string][]>;
  fieldBegin: FieldBegin[];
  fieldEnd: FieldEnd[];
  bookmarks: string[];
  unknown: Map<string, number>;
  placeholderParaIdDups: Record<string, number>;
};

export function newAcc(): Acc {
  return {
    paragraphs: 0,
    tables: 0,
    pictures: 0,
    tableDepthMax: 0,
    order: 0,
    ids: new Map(),
    fieldBegin: [],
    fieldEnd: [],
    bookmarks: [],
    unknown: new Map(),
    placeholderParaIdDups: {},
  };
}

function pushId(acc: Acc, space: string, value: string, where: string): void {
  let list = acc.ids.get(space);
  if (list === undefined) acc.ids.set(space, (list = []));
  list.push([value, where]);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toInt(v: string | undefined): number | undefined {
  return v !== undefined && /^\s*[+-]?\d+\s*$/.test(v) ? Number(v) : undefined;
}

/** instId는 대소문자 표기가 문서마다 달라 대소문자를 가리지 않고 찾는다. */
function instIdOf(el: XElement): string | undefined {
  for (const a of el.attrs) {
    if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) continue;
    if (a.qname.slice(a.qname.lastIndexOf(":") + 1).toLowerCase() === "instid") return a.value;
  }
  return undefined;
}

function firstChild(el: XElement, local: string): XElement | undefined {
  return subElements(el).find((c) => c.local === local);
}

function checkTable(tbl: XElement, fname: string, log: IssueLog): void {
  const rows = subElements(tbl).filter((c) => c.local === "tr");
  const rowAttr = attrValue(tbl, "rowCnt");
  const colAttr = attrValue(tbl, "colCnt");
  const rowCnt = toInt(rowAttr);
  const colCnt = toInt(colAttr);
  const tid = attrValue(tbl, "id") ?? "?";
  const where = `${fname} tbl id=${tid}`;
  if (rowAttr === undefined) log.err("TBL_ATTR_MISSING", "표에 rowCnt 속성이 없음", where);
  if (colAttr === undefined) log.err("TBL_ATTR_MISSING", "표에 colCnt 속성이 없음", where);
  if (rowCnt !== undefined && rowCnt !== rows.length) {
    log.warn("TBL_ROWCNT", `표 rowCnt(${rowCnt}) 와 tr 개수(${rows.length}) 불일치`, where);
  }
  let maxcol = 0;
  for (const tr of rows) {
    for (const tc of subElements(tr)) {
      if (tc.local !== "tc") continue;
      const addr = firstChild(tc, "cellAddr");
      const span = firstChild(tc, "cellSpan");
      if (addr === undefined) {
        log.err("TBL_CELL", "tc 에 cellAddr 가 없음", where);
        continue;
      }
      const ca = toInt(attrValue(addr, "colAddr")) ?? 0;
      const ra = toInt(attrValue(addr, "rowAddr")) ?? 0;
      const cs = span === undefined ? 1 : (toInt(attrValue(span, "colSpan")) ?? 1);
      const rs = span === undefined ? 1 : (toInt(attrValue(span, "rowSpan")) ?? 1);
      maxcol = Math.max(maxcol, ca + cs);
      if (colCnt !== undefined && ca + cs > colCnt) {
        log.err("TBL_CELL_RANGE", `셀(col ${ca}, span ${cs})이 colCnt(${colCnt}) 를 넘음`, where);
      }
      if (rowCnt !== undefined && ra + rs > rowCnt) {
        log.err("TBL_CELL_RANGE", `셀(row ${ra}, span ${rs})이 rowCnt(${rowCnt}) 를 넘음`, where);
      }
    }
  }
  if (colCnt !== undefined && rows.length > 0 && maxcol !== colCnt) {
    log.warn("TBL_COLCNT", `표 colCnt(${colCnt}) 와 셀이 덮는 열 수(${maxcol}) 불일치`, where);
  }
}

/** 구역 XML을 문서 순서로 훑어 인스턴스 ID·필드·책갈피·표 구조를 모은다. */
export function scanSectionBody(root: XElement, fname: string, log: IssueLog, acc: Acc): void {
  const anc: string[] = [];
  const rec = (el: XElement, tdepth: number): void => {
    const tag = el.local;
    if (tag === "p") {
      acc.paragraphs++;
      const pid = attrValue(el, "id");
      if (pid !== undefined) pushId(acc, SPACE_PARA, pid, `${fname} [${anc.slice(-3).join(">")}]`);
    }
    if (tag === "pic") acc.pictures++;
    if (OBJECT_TAGS.has(tag)) {
      const oid = attrValue(el, "id");
      if (oid !== undefined && oid !== "") pushId(acc, SPACE_OBJECT, oid, `${fname} <${tag}>`);
    }
    const inst = instIdOf(el);
    if (inst !== undefined && inst !== "") pushId(acc, SPACE_INST, inst, `${fname} <${tag}>`);

    if (tag === "fieldBegin") {
      const fid = attrValue(el, "id");
      acc.order++;
      acc.fieldBegin.push({ id: fid, pos: acc.order, fieldid: attrValue(el, "fieldid") });
      if (fid !== undefined && fid !== "") pushId(acc, SPACE_FIELD, fid, `${fname} <fieldBegin>`);
      const name = attrValue(el, "name");
      if ((attrValue(el, "type") ?? "").toUpperCase() === "BOOKMARK" && name !== undefined && name !== "") acc.bookmarks.push(name);
    } else if (tag === "fieldEnd") {
      acc.order++;
      acc.fieldEnd.push({ ref: attrValue(el, "beginIDRef"), pos: acc.order, fieldid: attrValue(el, "fieldid") });
    } else if (tag === "bookmark") {
      const nm = attrValue(el, "name");
      if (nm === undefined || nm === "") log.err("BOOKMARK_NO_NAME", "북마크 이름이 비어 있음", fname);
      else acc.bookmarks.push(nm);
    }

    // 모르는 컨트롤
    const known = tag === "run" ? RUN_KNOWN : tag === "ctrl" ? CTRL_KNOWN : tag === "t" ? T_KNOWN : undefined;
    if (known !== undefined) {
      for (const c of subElements(el)) {
        if (!known.has(c.local)) bump(acc.unknown, `${tag}/${c.local}`);
      }
    }

    let depth = tdepth;
    if (tag === "tbl") {
      depth++;
      acc.tables++;
      acc.tableDepthMax = Math.max(acc.tableDepthMax, depth);
      checkTable(el, fname, log);
    }
    anc.push(tag);
    for (const c of subElements(el)) rec(c, depth);
    anc.pop();
  };
  rec(root, 0);
}

function pyList(wh: string[]): string {
  return [...new Set(wh)].sort().slice(0, 3).join("; ");
}

/** 구역을 가로질러 모은 값으로 ID 중복·책갈피·필드 짝·표 깊이·모르는 컨트롤을 검사한다. */
export function checkInstances(acc: Acc, log: IssueLog, strict: boolean): void {
  for (const [space, items] of acc.ids) {
    const seen = new Map<string, string[]>();
    for (const [v, where] of items) {
      const list = seen.get(v);
      if (list === undefined) seen.set(v, [where]);
      else list.push(where);
    }
    for (const [v, wh] of seen) {
      if (wh.length < 2) continue;
      if (space === SPACE_PARA && PLACEHOLDER_PARA_IDS.has(v)) {
        acc.placeholderParaIdDups[v] = wh.length;
        continue;
      }
      if ((space === SPACE_OBJECT || space === SPACE_INST) && v === "0" && !strict) {
        // 새로 만든 표·그림의 id/instId를 0으로 두는 문서가 있다. 한컴이 열어 저장하면 새 id를 주는 것을 실측해 경고로 분류했다.
        log.warn("INST_DUP_PLACEHOLDER", `${space} '0' 이 ${wh.length}개(미할당 자리값, 한컴 실측: 열고 저장하면 재발급)`, pyList(wh));
        continue;
      }
      log.err("INST_DUP_ID", `${space} 중복: '${v}' x${wh.length}`, pyList(wh));
    }
  }

  const marks = new Map<string, number>();
  for (const nm of acc.bookmarks) bump(marks, nm);
  for (const [nm, n] of marks) {
    if (n > 1) log.err("BOOKMARK_DUP", `북마크 이름 중복: '${nm}' x${n}`);
  }

  // 필드 짝
  const begins = new Map<string | undefined, FieldBegin[]>();
  for (const b of acc.fieldBegin) {
    const list = begins.get(b.id);
    if (list === undefined) begins.set(b.id, [b]);
    else list.push(b);
  }
  const ends = new Map<string | undefined, FieldEnd[]>();
  for (const e of acc.fieldEnd) {
    const list = ends.get(e.ref);
    if (list === undefined) ends.set(e.ref, [e]);
    else list.push(e);
  }
  for (const [ref, list] of ends) {
    const shown = ref === undefined ? "None" : `'${ref}'`;
    const first = begins.get(ref)?.[0];
    if (first === undefined) {
      log.err("FIELD_UNPAIRED_END", `fieldEnd(beginIDRef=${shown}) 에 짝이 되는 fieldBegin 이 없음`);
      continue;
    }
    if (list.length > 1) log.err("FIELD_MULTI_END", `fieldBegin id=${shown} 에 fieldEnd 가 ${list.length}개`);
    for (const e of list) {
      if (e.pos < first.pos) log.err("FIELD_ORDER", `fieldEnd(beginIDRef=${shown}) 가 fieldBegin 보다 앞에 있음`);
      if (first.fieldid !== undefined && e.fieldid !== undefined && first.fieldid !== e.fieldid) {
        log.warn("FIELD_FIELDID_MISMATCH", `id=${shown} 의 fieldBegin.fieldid(${first.fieldid}) 와 fieldEnd.fieldid(${e.fieldid}) 가 다름`);
      }
    }
  }
  for (const fid of begins.keys()) {
    if (!ends.has(fid)) {
      log.err("FIELD_UNPAIRED_BEGIN", `fieldBegin id=${fid === undefined ? "None" : `'${fid}'`} 에 짝이 되는 fieldEnd 가 없음`);
    }
  }

  if (acc.tableDepthMax > TABLE_DEPTH_WARN) {
    log.warn("TBL_DEPTH", `표 중첩 깊이 ${acc.tableDepthMax} (경고 기준 ${TABLE_DEPTH_WARN} 초과)`);
  }
  if (acc.unknown.size > 0) {
    const list = [...acc.unknown].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k} x${v}`);
    log.warn("UNKNOWN_CONTROL", `모르는 control/개체 요소: ${list.join(", ")}`);
  }
}
