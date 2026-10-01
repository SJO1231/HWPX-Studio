import type { SpanEdit } from "../edit/plan.ts";
import { HwpxError, makeIssue, type Issue } from "../errors.ts";
import { planImport } from "../fragment/import.ts";
import { paragraphsAt, sectionAt } from "../fragment/select.ts";
import type { Fragment, ImportPlan, InsertPoint } from "../fragment/types.ts";
import { collectPrefixes, missingDeclarations } from "../fragment/util.ts";
import type { HwpxDocument } from "../model/types.ts";
import { escapeAttr } from "../xml/chars.ts";
import { childEls, elIs, walkElements, type XElement } from "../xml/tree.ts";
import { censusOf } from "./census.ts";
import { deleteColumnsEdits, insertColumnsEdits } from "./cols.ts";
import { copyElement } from "./copy.ts";
import { applySpanEdits, resolveTarget, span, type Ctx } from "./edit.ts";
import { makeReissuer, type Reissuer } from "./ids.ts";
import { requireAbsolute, requireGrid } from "./require.ts";
import { checkCount, deleteTrailingRowsEdits, insertRowsEdits } from "./rows.ts";
import type { CopyText, TableTarget } from "./types.ts";
import { declsOf, unwrapXml, wrapXml } from "./wrap.ts";

const bad = (message: string): HwpxError => new HwpxError("TABLE_BAD_ARG", message);

/** 복제할 표의 출처: 같은 문서의 표, 또는 조각 안의 표(`ordinal`번째 표. 문서 순서이고 중첩 표를 센다. 기본 0) */
export type CloneSource = { table: TableTarget } | { fragment: Fragment; ordinal?: number };

export type CloneOptions = {
  /** 새 표의 행 수. 기본은 원형 그대로. 늘리면 마지막 행을 복제하고(위에서 내려오는 병합은 늘린다) 줄이면 뒤 행을 지운다. */
  rows?: number;
  /** 새 표의 열 수. 기본은 원형 그대로. 늘리면 마지막 열을 복제하고 줄이면 뒤 열을 지운다. */
  cols?: number;
  /** `clear`(기본)면 복제한 표를 담은 문단의 모든 글을 비우고, `keep`이면 유지한다 */
  text?: CopyText;
};

/** 표를 담은 문단: 표 → run → p */
function hostOf(table: XElement): XElement {
  const run = table.parent;
  const host = run?.parent ?? null;
  if (run === null || host === null || !elIs(run, "paragraph", "run") || !elIs(host, "paragraph", "p")) {
    throw bad("표가 문단의 run 안에 있지 않아 복제할 수 없습니다.");
  }
  return host;
}

const tablesIn = (el: XElement): XElement[] => [...walkElements(el)].filter((x) => elIs(x, "paragraph", "tbl"));

/** 복사본 원문(문단 하나) 안의 `index`번째 표의 행·열 수를 맞춘 원문 */
function resizeClone(xml: string, decls: ReadonlyMap<string, string>, index: number, want: { rows?: number; cols?: number }, reissue: Reissuer): string {
  let current = xml;
  const load = (): { ctx: Ctx; table: XElement } => {
    const w = wrapXml(current, decls);
    const table = tablesIn(w.root)[index];
    if (table === undefined) throw new HwpxError("TABLE_INTERNAL", "복제본에서 표를 다시 찾지 못했습니다.");
    return { ctx: { entry: "(복제본)", text: w.text }, table };
  };
  const strip = (text: string): string => unwrapXml(text, wrapXml("", decls).offset);

  if (want.rows !== undefined) {
    const { ctx, table } = load();
    // 행 수만 바꾸는 복제는 열 너비를 쓰지 않는다(너비 불규칙인 표도 한다)
    const grid = requireGrid(table, ctx.entry, { structure: true });
    if (want.rows !== grid.rowCnt) {
      requireAbsolute(table, "height", ctx.entry);
      const edits: SpanEdit[] =
        want.rows > grid.rowCnt
          ? insertRowsEdits(ctx, grid, { prototype: grid.rowCnt - 1, count: want.rows - grid.rowCnt, position: "after", text: "keep", extendSpans: true }, reissue).edits
          : deleteTrailingRowsEdits(ctx, grid, grid.rowCnt - want.rows);
      current = strip(applySpanEdits(ctx.text, edits));
    }
  }
  if (want.cols !== undefined) {
    const { ctx, table } = load();
    const grid = requireGrid(table, ctx.entry, { structure: true });
    if (want.cols !== grid.colCnt) {
      // 열 수를 바꾸는 복제는 열 너비가 필요하다(너비 불규칙이면 TABLE_IRREGULAR)
      requireGrid(table, ctx.entry, { widths: true, structure: true });
      requireAbsolute(table, "width", ctx.entry);
      const edits: SpanEdit[] =
        want.cols > grid.colCnt
          ? insertColumnsEdits(ctx, grid, { prototype: grid.colCnt - 1, count: want.cols - grid.colCnt, position: "after", text: "keep" }, reissue).edits
          : deleteColumnsEdits(ctx, grid, Array.from({ length: grid.colCnt - want.cols }, (_, i) => (want.cols ?? 0) + i)).edits;
      current = strip(applySpanEdits(ctx.text, edits));
    }
  }
  return current;
}

/**
 * 문서나 조각의 기존 표를 원형으로 복제해 `at` 위치에 새 문단으로 넣고 행·열 수를 맞춘다.
 * 새 문단은 원형 표를 담은 문단의 복사본이다(그 문단의 다른 글·객체도 함께 복사되고, `text: "clear"`면 문단 안 모든 글이 빈다).
 * 복사본의 줄 배치 캐시는 빼고, 인스턴스 id와 책갈피 이름은 새로 준다.
 * 조각이 출처면 `planImport`로 자원·이진 자료·id를 대상에 맞춰 가져온 뒤 그 결과에서 표를 담은 문단만 넣는다(조각의 다른 문단은 넣지 않지만
 * 그 서식 자원은 가져온다 — 경고 `TABLE_FRAGMENT_EXTRA`).
 * 원형의 구조가 불규칙하면 `TABLE_IRREGULAR`(행·열 수를 바꿀 때). 열 수를 바꿀 때는 열 너비도 정해져야 한다(너비 불규칙이면 `TABLE_IRREGULAR`). 행 수만 바꾸는 복제는 너비 불규칙이어도 한다.
 * 구역 설정(`secPr`)이 든 문단은 `TABLE_BAD_ARG`.
 */
export function planCloneTable(doc: HwpxDocument, at: InsertPoint, source: CloneSource, options: CloneOptions = {}): ImportPlan {
  if (typeof doc !== "object" || doc === null || !Array.isArray(doc.sections)) throw bad("doc은 문서 모델이어야 합니다.");
  if (typeof at !== "object" || at === null || !Array.isArray(at.parentPath)) throw bad("삽입 지점(at)은 { sectionIndex, parentPath, index, position } 객체여야 합니다.");
  if (typeof source !== "object" || source === null || !("table" in source ? typeof source.table === "object" && source.table !== null : "fragment" in source && typeof source.fragment === "object" && source.fragment !== null)) {
    throw bad("source는 { table } 이나 { fragment } 객체여야 합니다.");
  }
  if (typeof options !== "object" || options === null) throw bad("options는 객체여야 합니다.");
  const rows = options.rows === undefined ? undefined : checkCount("rows", options.rows);
  const cols = options.cols === undefined ? undefined : checkCount("cols", options.cols);
  const text: CopyText = options.text ?? "clear";
  if (text !== "clear" && text !== "keep") throw bad(`text ${JSON.stringify(text)}은(는) clear나 keep이어야 합니다.`);

  const section = sectionAt(doc, at.sectionIndex, "FRAG_INSERT_POINT");
  const siblings = paragraphsAt(section, at.parentPath, "FRAG_INSERT_POINT");
  const anchor = Number.isInteger(at.index) ? siblings[at.index] : undefined;
  if (anchor === undefined || (at.position !== "before" && at.position !== "after")) {
    throw new HwpxError("FRAG_INSERT_POINT", `삽입 지점 ${at.index}(${at.position})이 올바르지 않습니다(목록의 문단 ${siblings.length}개).`);
  }
  const issues: Issue[] = [];
  const reissue = makeReissuer(doc);
  const targetCtx: Ctx = { entry: section.entryName, text: section.text };
  const position = at.position === "before" ? anchor.element.start : anchor.element.end;

  const finalDecls = declsOf(section.root);
  let edits: SpanEdit[];
  let paragraphXml: string;
  let base: Omit<ImportPlan, "edits" | "issues" | "summary">;
  let summary: Record<string, number>;

  if ("table" in source) {
    const { ctx: srcCtx, table } = resolveTarget(doc, source.table);
    const host = hostOf(table);
    if ([...walkElements(host)].some((el) => elIs(el, "paragraph", "secPr"))) throw bad("구역 설정(secPr)이 든 문단의 표는 원형으로 복제할 수 없습니다.");
    const index = tablesIn(host).indexOf(table);
    const copy = copyElement(srcCtx, host, { text, reissue, blankCellNames: true, closedFields: true });
    const sourceSection = doc.sections[source.table.sectionIndex];
    const sourceDecls = sourceSection === undefined ? new Map<string, string>() : declsOf(sourceSection.root);
    for (const [prefix, uri] of sourceDecls) if (!finalDecls.has(prefix)) finalDecls.set(prefix, uri);
    paragraphXml = resizeClone(copy, sourceDecls, index, { ...(rows === undefined ? {} : { rows }), ...(cols === undefined ? {} : { cols }) }, reissue);

    // 접두사: 대상 구역에 같은 역할로 선언돼 있어야 한다(다른 구역에서 복제할 때)
    const used = collectPrefixes(walkElements(host), host.start);
    const missing = missingDeclarations(used.prefixes, used.namespaces, anchor.element.parent, section.entryName, "복제한 표");
    edits = [];
    if (missing.size > 0) {
      const decl = [...missing].map(([prefix, uri]) => ` xmlns:${prefix}="${escapeAttr(uri)}"`).join("");
      const open = section.root.openEnd - 1;
      edits.push(span(targetCtx, open, open, decl, "복제한 표가 쓰는 네임스페이스 접두사 선언 추가"));
    }
    base = { additions: [], inherited: { duplicateIds: [], danglingRefs: [] } };
    summary = {};
  } else {
    const imp = planImport(doc, source.fragment, at);
    const insert = imp.edits.find((e) => e.entry === section.entryName && e.start === position && e.end === position && e.reason.startsWith("조각 삽입"));
    if (insert === undefined) throw new HwpxError("TABLE_INTERNAL", "조각 가져오기 계획에서 삽입 편집을 찾지 못했습니다.");
    // 가져온 원문을 읽는다: 접두사 선언은 대상 구역 루트와 조각의 선언을 합친 것
    const decls = declsOf(section.root);
    for (const [prefix, uri] of Object.entries(source.fragment.namespaces)) if (!decls.has(prefix)) decls.set(prefix, uri);
    for (const [prefix, uri] of decls) finalDecls.set(prefix, uri);
    const w = wrapXml(insert.replacement, decls);
    reissue.observe(walkElements(w.root));
    const found = tablesIn(w.root);
    const ordinal = source.ordinal ?? 0;
    const table = found[ordinal];
    if (table === undefined) throw new HwpxError("TABLE_NOT_FOUND", `조각에 ${ordinal}번째 표가 없습니다(표 ${found.length}개).`);
    const host = hostOf(table);
    if ([...walkElements(host)].some((el) => elIs(el, "paragraph", "secPr"))) throw bad("구역 설정(secPr)이 든 문단의 표는 원형으로 복제할 수 없습니다.");
    const topLevel = childEls(w.root, "paragraph", "p");
    if (topLevel.length !== 1 || topLevel[0] !== host) {
      issues.push(makeIssue("warning", "TABLE_FRAGMENT_EXTRA", `조각의 문단 ${topLevel.length}개 가운데 표를 담은 문단만 넣었습니다(다른 문단의 서식 자원은 가져왔습니다).`, section.entryName));
    }
    const index = tablesIn(host).indexOf(table);
    const copy = copyElement({ entry: section.entryName, text: w.text }, host, { text, reissue: undefined, blankCellNames: true, closedFields: true });
    paragraphXml = resizeClone(copy, decls, index, { ...(rows === undefined ? {} : { rows }), ...(cols === undefined ? {} : { cols }) }, reissue);
    edits = imp.edits.filter((e) => e !== insert);
    base = { additions: imp.additions, inherited: imp.inherited };
    summary = { ...imp.summary };
    issues.push(...imp.issues);
  }

  edits.push(span(targetCtx, position, position, paragraphXml, "표 복제(새 문단)"));
  const census = censusOf(childEls(wrapXml(paragraphXml, finalDecls).root, "paragraph", "p"), section.entryName);
  summary["insertedParagraphs"] = census.paragraphs;
  summary["insertedTables"] = census.tables;
  summary["insertedPictures"] = census.pictures;
  summary["insertedFields"] = census.fieldPairs;
  summary["insertedBookmarks"] = census.bookmarks;
  summary["reissuedIds"] = (summary["reissuedIds"] ?? 0) + reissue.count;
  return { ...base, edits, summary, issues };
}
