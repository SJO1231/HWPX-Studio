// 복제한 행·표 안의 컨트롤 id: 표 복제가 재발급하는 id 종류가 조각 가져오기와 같다(둘 다 같은 id 검색 규칙을 쓴다).
// 머리말·꼬리말 컨트롤의 id는 두 경로 모두 새로 주지 않는다 — 이 시험은 두 경로가 갈라지지 않음을 고정한다(차이를 보고하기 위한 대조).
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPlan, extractFragment, listTables, planCloneTable, planImport } from "../src/index.ts";
import { docOf, paragraph, reparseBytes, sectionText, tableParagraph, textPara, type TableSpec } from "./table-helpers.ts";

const list = `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP">`;
const note = (tag: string, id: string, pid: string, text: string, extra = ""): string =>
  `<hp:ctrl><hp:${tag} ${extra}id="${id}" applyPageType="BOTH">${list}<hp:p id="${pid}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run></hp:p></hp:subList></hp:${tag}></hp:ctrl>`;

function doc() {
  const inner = [
    note("header", "9001", "9002", "머리"),
    note("footer", "9003", "9004", "꼬리"),
    `<hp:ctrl><hp:fieldBegin id="9005" type="CLICK_HERE" name="n" editable="1" dirty="1" fieldid="9105"/></hp:ctrl><hp:t>값</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="9005" fieldid="9105"/></hp:ctrl>`,
    `<hp:ctrl><hp:footNote number="1" instid="9006">${list}<hp:p id="9007" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>각주</hp:t></hp:run></hp:p></hp:subList></hp:footNote></hp:ctrl>`,
  ];
  const spec: TableSpec = { id: "9100", rowCnt: 1, colCnt: 1, cells: [{ row: 0, col: 0, width: 5000, height: 600, paragraphs: [paragraph(`${inner.join("")}<hp:t/>`, "9010")] }] };
  return reparseBytes(docOf([textPara("앞", "9020"), tableParagraph(spec, "9030"), textPara("뒤", "9040")]));
}

/** 요소 이름:id(또는 instid·beginIDRef) 목록(문서 순서) */
const ids = (xml: string): string[] => [...xml.matchAll(/<hp:(\w+)\b[^>]*?\b(?:id|instid|instId|beginIDRef)="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);

test("표 복제가 재발급하는 id 종류는 조각 가져오기와 같다(문단·표·누름틀 시작과 끝·각주 instid), 새 값까지 같다", () => {
  const d = doc();
  const at = { sectionIndex: 0, parentPath: [], index: 2, position: "after" as const };
  const original = ids(sectionText(d.pkg.bytes));
  const cloned = ids(sectionText(applyPlan(d.pkg, planCloneTable(d, at, { table: listTables(d)[0]?.target as never }, { text: "keep" }))));
  const imported = ids(sectionText(applyPlan(d.pkg, planImport(d, extractFragment(d, { sectionIndex: 0, parentPath: [], from: 1, to: 1 }), at))));
  assert.deepEqual(cloned, imported, "두 경로가 같은 종류의 id를 같은 값으로 새로 준다");
  // 새로 생긴 복사본 부분(원본 목록 뒤)에서 재발급되는 종류
  const copy = cloned.slice(original.length); // 원본 목록(뒤 문단 p:9040까지) 뒤의 복사본
  const fresh = (kind: string): boolean => copy.filter((x) => x.startsWith(`${kind}:`)).every((x) => !original.includes(x));
  for (const kind of ["tbl", "fieldBegin", "fieldEnd", "footNote", "p"]) assert.ok(fresh(kind), `${kind} id는 새로 받는다`);
  assert.ok(copy.some((x) => x.startsWith("tbl:")), "복사본에 표가 있다");
  // 누름틀 끝의 짝은 새 시작을 가리킨다
  assert.equal(copy.find((x) => x.startsWith("fieldBegin:"))?.split(":")[1], copy.find((x) => x.startsWith("fieldEnd:"))?.split(":")[1]);
});

test("머리말·꼬리말 컨트롤의 id는 표 복제와 조각 가져오기가 똑같이 그대로 둔다(둘 다 id 검색 규칙에 이 종류가 없다) — 갈라진 곳이 없다는 확인", () => {
  const d = doc();
  const at = { sectionIndex: 0, parentPath: [], index: 2, position: "after" as const };
  const pick = (list: string[]): string[] => list.filter((x) => x.startsWith("header:") || x.startsWith("footer:"));
  const cloned = pick(ids(sectionText(applyPlan(d.pkg, planCloneTable(d, at, { table: listTables(d)[0]?.target as never }, { text: "keep" })))));
  const imported = pick(ids(sectionText(applyPlan(d.pkg, planImport(d, extractFragment(d, { sectionIndex: 0, parentPath: [], from: 1, to: 1 }), at)))));
  assert.deepEqual(cloned, imported);
  assert.deepEqual(cloned, ["header:9001", "footer:9003", "header:9001", "footer:9003"], "원본과 복사본의 머리말·꼬리말 id가 같다(관측)");
});
