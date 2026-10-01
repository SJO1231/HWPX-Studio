// 문서 요약과 구간 고르기. 구역 설정(secPr)이 든 문단을 피한 연속 최상위 문단 구간 가운데 복잡도 점수가 가장 높은 것을 고른다.
import { attrValue, elIs, isTableNode, nsRole, walkElements, type HwpxDocument, type InsertPoint, type ParagraphNode, type XElement } from "../../packages/hwpx-engine/src/index.ts";

/** 최상위 문단 하나의 특징(그 문단과 안쪽 하위 목록 전체) */
export type ParaFeat = {
  /** 구역 설정이 들었거나, 구간이 가를 수 없는 문단(짝이 모호한 누름틀) */
  invalid: boolean;
  secPr: boolean;
  /** 객체 종류(run의 자식과 ctrl의 자식 요소 이름) */
  kinds: string[];
  chars: string[];
  paras: string[];
  depth: number;
  tables: number;
  pics: number;
  fields: number;
  clickHere: number;
  bookmarks: number;
  notes: number;
  boxes: number;
  headerFooter: number;
  elements: number;
  fieldBegins: string[];
  fieldEnds: string[];
};

const PARA_ROLE = "paragraph";

export function paraFeat(p: ParagraphNode): ParaFeat {
  const kinds = new Set<string>();
  const chars = new Set<string>();
  const paras = new Set<string>();
  const feat: ParaFeat = {
    invalid: false,
    secPr: false,
    kinds: [],
    chars: [],
    paras: [],
    depth: 0,
    tables: 0,
    pics: 0,
    fields: 0,
    clickHere: 0,
    bookmarks: 0,
    notes: 0,
    boxes: 0,
    headerFooter: 0,
    elements: 0,
    fieldBegins: [],
    fieldEnds: [],
  };
  for (const el of walkElements(p.element)) {
    feat.elements++;
    const role = nsRole(el.ns);
    if (role !== PARA_ROLE) continue;
    const parent = el.parent;
    if (parent !== null && nsRole(parent.ns) === PARA_ROLE) {
      if (parent.local === "run" && el.local !== "t" && el.local !== "secPr" && el.local !== "ctrl") kinds.add(el.local);
      else if (parent.local === "ctrl" && el.local !== "colPr") kinds.add(el.local);
    }
    switch (el.local) {
      case "secPr":
        feat.secPr = true;
        break;
      case "run": {
        const c = attrValue(el, "charPrIDRef");
        if (c !== undefined) chars.add(c);
        break;
      }
      case "p": {
        const c = attrValue(el, "paraPrIDRef");
        if (c !== undefined) paras.add(c);
        break;
      }
      case "tbl": {
        feat.tables++;
        let depth = 1;
        for (let a = el.parent; a !== null && a !== p.element.parent; a = a.parent) {
          if (elIs(a, PARA_ROLE, "tbl")) depth++;
        }
        feat.depth = Math.max(feat.depth, depth);
        break;
      }
      case "pic":
        feat.pics++;
        break;
      case "fieldBegin": {
        feat.fields++;
        const type = (attrValue(el, "type") ?? "").toUpperCase();
        if (type === "CLICK_HERE") feat.clickHere++;
        if (type === "BOOKMARK") feat.bookmarks++;
        const id = attrValue(el, "id");
        if (id !== undefined) feat.fieldBegins.push(id);
        break;
      }
      case "fieldEnd": {
        const ref = attrValue(el, "beginIDRef");
        if (ref !== undefined) feat.fieldEnds.push(ref);
        break;
      }
      case "bookmark":
        feat.bookmarks++;
        break;
      case "footNote":
      case "endNote":
        feat.notes++;
        break;
      case "drawText":
        feat.boxes++;
        break;
      case "header":
      case "footer":
        if (parent !== null && parent.local === "ctrl") feat.headerFooter++;
        break;
      default:
        break;
    }
  }
  feat.kinds = [...kinds];
  feat.chars = [...chars];
  feat.paras = [...paras];
  feat.invalid = feat.secPr;
  return feat;
}

/** 구역의 최상위 문단 특징. 누름틀 짝이 모호한 문단은 invalid, 여러 문단에 걸친 누름틀 안쪽에서의 자르기는 forbidCut으로 표시한다. */
export type SectionFeats = { feats: ParaFeat[]; forbidCut: boolean[] };

export function sectionFeats(paragraphs: ParagraphNode[]): SectionFeats {
  const feats = paragraphs.map(paraFeat);
  const n = feats.length;
  const begins = new Map<string, number[]>();
  const ends = new Map<string, number[]>();
  feats.forEach((f, i) => {
    for (const id of f.fieldBegins) (begins.get(id) ?? begins.set(id, []).get(id))?.push(i);
    for (const id of f.fieldEnds) (ends.get(id) ?? ends.set(id, []).get(id))?.push(i);
  });
  const diff = new Array<number>(n + 2).fill(0);
  const ids = new Set([...begins.keys(), ...ends.keys()]);
  for (const id of ids) {
    const b = begins.get(id) ?? [];
    const e = ends.get(id) ?? [];
    const bi = b[0];
    const ei = e[0];
    if (b.length === 1 && e.length === 1 && bi !== undefined && ei !== undefined && bi <= ei) {
      if (bi < ei) {
        diff[bi + 1] = (diff[bi + 1] ?? 0) + 1;
        diff[ei + 1] = (diff[ei + 1] ?? 0) - 1;
      }
    } else {
      for (const i of [...b, ...e]) {
        const f = feats[i];
        if (f !== undefined) f.invalid = true;
      }
    }
  }
  const forbidCut = new Array<boolean>(n + 1).fill(false);
  let run = 0;
  for (let k = 0; k <= n; k++) {
    run += diff[k] ?? 0;
    forbidCut[k] = run > 0;
  }
  return { feats, forbidCut };
}

export type WindowPick = {
  sectionIndex: number;
  from: number;
  to: number;
  len: number;
  score: number;
  /** 길이가 최소 이상인가(문서가 짧으면 false) */
  full: boolean;
  kinds: number;
  charPrs: number;
  paraPrs: number;
  depth: number;
  bonus: number;
  tables: number;
  pics: number;
  fields: number;
  clickHere: number;
  bookmarks: number;
  notes: number;
  boxes: number;
  headerFooter: number;
  elements: number;
};

/** 가산점: 그림·누름틀·책갈피·각주·글상자가 구간에 있으면 종류마다 5점 */
const BONUS_PER_CLASS = 5;
const LEN_STEPS = [30, 50, 80, 120, 160];

function candidateLens(segment: number, min: number, max: number): number[] {
  if (segment < min) return [segment];
  const cap = Math.min(max, segment);
  const set = new Set<number>([min, cap]);
  for (const l of LEN_STEPS) if (l >= min && l <= cap) set.add(l);
  return [...set].sort((a, b) => a - b);
}

function prefix(values: number[]): number[] {
  const out = [0];
  for (const v of values) out.push((out.at(-1) ?? 0) + v);
  return out;
}

/** 모든 구역에서 점수가 가장 높은 구간을 고른다. 길이가 최소 이상인 후보가 있으면 그 가운데에서 고른다. */
export function chooseWindow(sections: readonly SectionFeats[], min: number, max: number): WindowPick | null {
  let best: WindowPick | null = null;
  const better = (a: WindowPick, b: WindowPick | null): boolean => b === null || (a.full !== b.full ? a.full : a.score > b.score);

  sections.forEach((sec, sectionIndex) => {
    const { feats, forbidCut } = sec;
    const n = feats.length;
    const pre = {
      tables: prefix(feats.map((f) => f.tables)),
      pics: prefix(feats.map((f) => f.pics)),
      fields: prefix(feats.map((f) => f.fields)),
      clickHere: prefix(feats.map((f) => f.clickHere)),
      bookmarks: prefix(feats.map((f) => f.bookmarks)),
      notes: prefix(feats.map((f) => f.notes)),
      boxes: prefix(feats.map((f) => f.boxes)),
      headerFooter: prefix(feats.map((f) => f.headerFooter)),
      elements: prefix(feats.map((f) => f.elements)),
    };
    const sum = (p: number[], a: number, b: number): number => (p[b + 1] ?? 0) - (p[a] ?? 0);

    let s0 = 0;
    while (s0 < n) {
      if (feats[s0]?.invalid === true) {
        s0++;
        continue;
      }
      let s1 = s0;
      while (s1 + 1 < n && feats[s1 + 1]?.invalid !== true) s1++;
      const segment = s1 - s0 + 1;
      for (const len of candidateLens(segment, min, max)) {
        const kinds = new Map<string, number>();
        const chars = new Map<string, number>();
        const paras = new Map<string, number>();
        const add = (f: ParaFeat, d: 1 | -1): void => {
          for (const [map, keys] of [[kinds, f.kinds], [chars, f.chars], [paras, f.paras]] as const) {
            for (const k of keys) {
              const v = (map.get(k) ?? 0) + d;
              if (v === 0) map.delete(k);
              else map.set(k, v);
            }
          }
        };
        for (let a = s0; a + len - 1 <= s1; a++) {
          const b = a + len - 1;
          if (a === s0) for (let i = a; i <= b; i++) add(feats[i] as ParaFeat, 1);
          else {
            add(feats[a - 1] as ParaFeat, -1);
            add(feats[b] as ParaFeat, 1);
          }
          if (forbidCut[a] === true || forbidCut[b + 1] === true) continue;
          let depth = 0;
          for (let i = a; i <= b; i++) depth = Math.max(depth, feats[i]?.depth ?? 0);
          const classes = [pre.pics, pre.fields, pre.bookmarks, pre.notes, pre.boxes].filter((p) => sum(p, a, b) > 0).length;
          const bonus = classes * BONUS_PER_CLASS;
          const score = kinds.size + chars.size + paras.size + depth + bonus + Math.log(len);
          const pick: WindowPick = {
            sectionIndex,
            from: a,
            to: b,
            len,
            score: Math.round(score * 1000) / 1000,
            full: len >= min,
            kinds: kinds.size,
            charPrs: chars.size,
            paraPrs: paras.size,
            depth,
            bonus,
            tables: sum(pre.tables, a, b),
            pics: sum(pre.pics, a, b),
            fields: sum(pre.fields, a, b),
            clickHere: sum(pre.clickHere, a, b),
            bookmarks: sum(pre.bookmarks, a, b),
            notes: sum(pre.notes, a, b),
            boxes: sum(pre.boxes, a, b),
            headerFooter: sum(pre.headerFooter, a, b),
            elements: sum(pre.elements, a, b),
          };
          if (better(pick, best)) best = pick;
        }
      }
      s0 = s1 + 1;
    }
  });
  return best;
}

// ── 문서 요약 ───────────────────────────────────────────────────

export type DocSummary = {
  sections: number;
  topParas: number;
  tables: number;
  maxTableDepth: number;
  pics: number;
  fields: number;
  clickHere: number;
  bookmarks: number;
  notes: number;
  boxes: number;
  headerFooter: number;
  charPrsUsed: number;
  paraPrsUsed: number;
  charPrsDefined: number;
  paraPrsDefined: number;
  styles: number;
  fonts: number;
  /** 구역 설정이 없는 연속 문단 구간을 고를 수 있는가 */
  hasWindow: boolean;
  /** 첫 표의 첫 셀 안 문단 뒤에 넣을 수 있는가(M6) */
  hasCellTarget: boolean;
  /** header의 refList에 해당 목록 요소가 없다(그 목록의 자원을 가져오려면 목록을 새로 만들어야 한다) */
  lacksBullets: boolean;
  lacksNumberings: boolean;
  lacksTabProperties: boolean;
};

export type DocInfo = {
  summary: DocSummary;
  /** 쌍을 고를 때만 쓰는 메모리 안 집합(보고하지 않는다) */
  styleNames: Set<string>;
  fontNames: Set<string>;
  window: WindowPick | null;
  /** 구역마다: 구역 설정이 든 문단 표시와 자를 수 없는 위치 표시(구간을 쪼갤 때와 삽입 지점을 고를 때 쓴다) */
  sections: { secPr: boolean[]; forbidCut: boolean[] }[];
};

function refListHas(doc: HwpxDocument, list: string): boolean {
  const refList = doc.header.root.children.find((c): c is XElement => "local" in c && c.local === "refList");
  return refList !== undefined && refList.children.some((c) => "local" in c && c.local === list);
}

export function describeDoc(doc: HwpxDocument, min: number, max: number): DocInfo {
  const secFeats = doc.sections.map((s) => sectionFeats(s.paragraphs));
  const used = { chars: new Set<string>(), paras: new Set<string>() };
  const total: Omit<DocSummary, "sections" | "topParas" | "maxTableDepth" | "charPrsUsed" | "paraPrsUsed" | "charPrsDefined" | "paraPrsDefined" | "styles" | "fonts" | "hasWindow" | "hasCellTarget" | "lacksBullets" | "lacksNumberings" | "lacksTabProperties"> = {
    tables: 0,
    pics: 0,
    fields: 0,
    clickHere: 0,
    bookmarks: 0,
    notes: 0,
    boxes: 0,
    headerFooter: 0,
  };
  let maxDepth = 0;
  let topParas = 0;
  for (const sec of secFeats) {
    for (const f of sec.feats) {
      topParas++;
      maxDepth = Math.max(maxDepth, f.depth);
      for (const c of f.chars) used.chars.add(c);
      for (const c of f.paras) used.paras.add(c);
      total.tables += f.tables;
      total.pics += f.pics;
      total.fields += f.fields;
      total.clickHere += f.clickHere;
      total.bookmarks += f.bookmarks;
      total.notes += f.notes;
      total.boxes += f.boxes;
      total.headerFooter += f.headerFooter;
    }
  }
  const styleNames = new Set<string>();
  for (const item of doc.header.resources["style"] ?? []) {
    const name = attrValue(item.element, "name");
    if (name !== undefined) styleNames.add(name);
  }
  const fontNames = new Set<string>();
  for (const item of doc.header.resources["font"] ?? []) {
    const face = attrValue(item.element, "face");
    if (face !== undefined) fontNames.add(face);
  }
  const window = chooseWindow(secFeats, min, max);
  return {
    summary: {
      sections: doc.sections.length,
      topParas,
      ...total,
      maxTableDepth: maxDepth,
      charPrsUsed: used.chars.size,
      paraPrsUsed: used.paras.size,
      charPrsDefined: (doc.header.resources["charPr"] ?? []).length,
      paraPrsDefined: (doc.header.resources["paraPr"] ?? []).length,
      styles: styleNames.size,
      fonts: fontNames.size,
      hasWindow: window !== null,
      hasCellTarget: cellPoint(doc) !== undefined,
      lacksBullets: !refListHas(doc, "bullets"),
      lacksNumberings: !refListHas(doc, "numberings"),
      lacksTabProperties: !refListHas(doc, "tabProperties"),
    },
    styleNames,
    fontNames,
    window,
    sections: secFeats.map((s) => ({ secPr: s.feats.map((f) => f.secPr), forbidCut: s.forbidCut })),
  };
}

/** 대상의 첫 표의 첫 셀 첫 문단 뒤. 표가 없거나 첫 셀에 하위 목록이 없으면 undefined */
export function cellPoint(doc: HwpxDocument): { point: InsertPoint; host: { sectionIndex: number; index: number } } | undefined {
  for (const [s, sec] of doc.sections.entries()) {
    for (const [pi, p] of sec.paragraphs.entries()) {
      const table = p.objects.find(isTableNode);
      if (table === undefined) continue;
      const sub = table.cells[0]?.subList;
      const subIndex = sub === null || sub === undefined ? -1 : p.subLists.indexOf(sub);
      if (sub !== null && sub !== undefined && subIndex >= 0 && sub.paragraphs.length > 0) {
        return {
          point: { sectionIndex: s, parentPath: [pi, subIndex], index: 0, position: "after" },
          host: { sectionIndex: s, index: pi },
        };
      }
    }
  }
  return undefined;
}

