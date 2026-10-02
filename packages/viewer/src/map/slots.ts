import { attrValue, isTableNode, subElements, type ObjectNode, type ParagraphNode, type SubListNode, type TableCell, type XElement } from "../../../hwpx-engine/src/index.ts";

/**
 * rhwp가 문단에서 센 컨트롤 하나. `index`가 rhwp의 컨트롤 색인(`cellPath`의 `controlIndex`)이다.
 * 규칙은 rhwp를 조사해 엔진 원문에서 다시 만든 것이고, 맞는지는 시험(V2)으로 지킨다.
 */
export type ControlSlot = {
  index: number;
  /** 컨트롤 요소의 local 이름(`secPr`, `colPr`, `tbl`, `pic`, `fieldBegin` 등) */
  kind: string;
  /** 규칙에 있는 종류인가. 아니면 색인 계산이 확실하지 않다 */
  known: boolean;
  /** run 직속 객체(`ctrl` 안의 컨트롤이면 그 `ctrl`) */
  host: ObjectNode;
  element: XElement;
  /** rhwp 글자 순번에서 차지하는 칸 수. 알 수 없으면 undefined */
  width: 0 | 1 | undefined;
  /** 이 컨트롤이 소유한 엔진 하위 목록(문서 순서) */
  subLists: SubListNode[];
  /** 표이면 셀(문서 순서 = rhwp의 `cellIndex` 순서) */
  cells?: TableCell[];
  /** 글상자 글이 든 하위 목록(`drawText` 안) */
  textboxes: SubListNode[];
  /** 캡션(`caption` 안) 하위 목록. rhwp는 표 캡션을 `cellIndex` 65534, 그림 캡션을 0으로 센다 */
  captions: SubListNode[];
  /** 글자 겹침처럼 rhwp가 한 칸에 여러 글자(겹친 글, 또는 사설 영역 글자)로 그리는 컨트롤(런 글이 한 칸보다 길다) */
  private?: true;
  /** 글자 겹침의 겹친 글(`composeText`) */
  composeText?: string;
};

// `hp:ctrl`의 자식 가운데 rhwp가 컨트롤 하나로 세는 것. `fieldEnd`는 세지 않는다.
const COUNTED_IN_CTRL = new Set([
  "colPr",
  "header",
  "footer",
  "footNote",
  "endNote",
  "autoNum",
  "hiddenComment",
  "indexmark",
  "fieldBegin",
  "pageHiding",
  "pageNumCtrl",
  "pageNum",
  "bookmark",
  "newNum",
]);
const NOT_COUNTED_IN_CTRL = new Set(["fieldEnd"]);

// run의 직속 자식 가운데 규칙에 있는 것. 글자처럼 취급(`treatAsChar`)이면 글자 순번 한 칸을 차지한다.
const INLINE_ONE_WHEN_TREATED = new Set(["pic", "rect", "ellipse", "line", "arc", "polygon", "curve", "container", "equation", "chart", "ole"]);
const ALWAYS_ZERO = new Set(["secPr", "tbl"]);
// run 직속의 책갈피·형광펜 표시는 rhwp의 컨트롤 목록에 없다 [실행 관측: 컨트롤 개수 대조]
const NOT_A_CONTROL = new Set(["bookmark", "markpenBegin", "markpenEnd"]);
// rhwp가 컨트롤 하나로 세는 것이 확인됐지만(컨트롤 개수 대조: 이 종류가 든 문단에서 개수가 모두 일치) 글자 순번에서 차지하는 칸 수는 모르는 종류:
// 호환 구조(`switch`), 연결선, 글 상자 아닌 양식 개체, 덧말. 색인은 믿고, 이 개체 뒤의 글자 순번은 믿지 않는다.
const COUNTED_WIDTH_UNKNOWN = new Set(["switch", "connectLine", "btn", "checkBtn", "radioBtn", "comboBox", "edit", "dutmal"]);
// 글자 겹침: 한 칸이고, 런에는 사설 영역 글자로 그려진다 [실행 관측]
const ALWAYS_ONE_PRIVATE = new Set(["compose"]);

function treatAsChar(el: XElement): boolean {
  const pos = subElements(el).find((c) => c.local === "pos");
  return pos !== undefined && attrValue(pos, "treatAsChar") === "1";
}

function slotOf(host: ObjectNode, element: XElement, kind: string, inCtrl: boolean): Omit<ControlSlot, "index"> {
  const within = host.subLists.filter((s) => s.element.start >= element.start && s.element.end <= element.end);
  let known = true;
  let width: 0 | 1 | undefined;
  if (inCtrl) {
    if (kind === "autoNum") width = 1;
    else if (COUNTED_IN_CTRL.has(kind)) width = 0;
    else known = false;
  } else if (ALWAYS_ZERO.has(kind)) {
    width = 0;
  } else if (INLINE_ONE_WHEN_TREATED.has(kind)) {
    width = treatAsChar(element) ? 1 : 0;
  } else if (ALWAYS_ONE_PRIVATE.has(kind)) {
    width = 1;
  } else if (COUNTED_WIDTH_UNKNOWN.has(kind)) {
    width = undefined;
  } else {
    known = false;
  }
  const slot: Omit<ControlSlot, "index"> = {
    kind,
    known,
    host,
    element,
    width,
    subLists: within,
    textboxes: within.filter((s) => s.element.parent?.local === "drawText"),
    captions: within.filter((s) => s.element.parent?.local === "caption"),
  };
  if (ALWAYS_ONE_PRIVATE.has(kind)) {
    slot.private = true;
    const text = attrValue(element, "composeText");
    if (text !== undefined) slot.composeText = text;
  }
  if (isTableNode(host) && host.element === element) slot.cells = host.cells;
  return slot;
}

const cache = new WeakMap<ParagraphNode, ControlSlot[]>();

/**
 * 엔진 문단에서 rhwp의 컨트롤 색인 순서를 다시 만든다(XML 등장 순서).
 * 구역 설정(`secPr`) 하나, `hp:ctrl`의 자식 가운데 단 설정·머리말·꼬리말·각주·미주·자동 번호·숨은 설명·찾아보기 표시·
 * 누름틀 시작·감추기·쪽 번호 위치·쪽 번호·책갈피·새 번호 각각 하나(누름틀 끝은 세지 않는다),
 * run 직속의 표·그림·도형·묶음·수식·차트·OLE 등 각각 하나다. 규칙에 없는 종류는 `known: false`로 한 칸을 차지하는 것으로 본다.
 */
export function controlSlots(paragraph: ParagraphNode): ControlSlot[] {
  const hit = cache.get(paragraph);
  if (hit !== undefined) return hit;
  const out: ControlSlot[] = [];
  for (const host of paragraph.objects) {
    if (host.type === "ctrl") {
      for (const child of subElements(host.element)) {
        if (NOT_COUNTED_IN_CTRL.has(child.local)) continue;
        out.push({ index: out.length, ...slotOf(host, child, child.local, true) });
      }
    } else if (!NOT_A_CONTROL.has(host.type)) {
      out.push({ index: out.length, ...slotOf(host, host.element, host.type, false) });
    }
  }
  cache.set(paragraph, out);
  return out;
}
