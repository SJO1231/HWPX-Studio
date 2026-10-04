import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flag, intValue, need, parse, parseAddress, str, type Parsed } from "./args.ts";
import {
  HwpxError,
  censusOfDoc,
  compareToBaseline,
  compileDocument,
  detectHeadings,
  emptyTemplate,
  exportModel,
  extractFragment,
  findCandidates,
  findPlaceholders,
  fragmentPaths,
  generate,
  generateBatch,
  generateFromTemplate,
  generateText,
  listFields,
  listTables,
  makeLineAnchor,
  makeRangeAnchor,
  openPackage,
  parseDocument,
  parseText,
  planBatchNames,
  readArchive,
  readBatchRecords,
  readCase,
  readDataset,
  readEntry,
  readStudioTemplate,
  readTemplate,
  serializeFragment,
  validateDocument,
  walkParagraphs,
  type BatchItem,
  type BatchRecord,
  type FillReport,
  type GateMode,
  type GenerateResult,
  type Issue,
  type MergeFieldsMode,
  type MissingPolicy,
  type StudioGenerateResult,
  type TextKind,
  type TextResult,
} from "./engine.ts";
import { checkOutputPath, InputError, readBytes, readText, readUtf8, UsageError, writeSafely, type Out } from "./io.ts";

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** 입력 파일을 열고 해석한다. 열 수 없으면 `InputError`(종료 코드 2). */
function openDocument(path: string): { bytes: Uint8Array; doc: ReturnType<typeof parseDocument> } {
  const bytes = readBytes(path, "입력 파일");
  try {
    return { bytes, doc: parseDocument(openPackage(bytes)) };
  } catch (e) {
    if (e instanceof HwpxError) throw new InputError(`입력 파일을 열 수 없습니다: ${path} (${e.code}: ${e.message})`);
    throw e;
  }
}

function printIssues(out: Out, issues: Issue[], onlyErrors = false): void {
  for (const i of issues) {
    if (onlyErrors && i.severity !== "error") continue;
    const line = `${i.severity === "error" ? "오류" : "경고"} [${i.code}] ${i.message}`;
    (i.severity === "error" ? out.err : out.log)(line);
  }
}

const modeOf = (p: Parsed, usage: string): GateMode => {
  const mode = str(p, "mode") ?? "baseline";
  if (mode !== "baseline" && mode !== "strict" && mode !== "repair") throw new UsageError(`--mode는 baseline·strict·repair 가운데 하나여야 합니다: ${mode}\n사용법: ${usage}`);
  return mode;
};

/** 확장자로 본 텍스트 문서 형식. `.md`·`.txt`가 아니면 `undefined`. */
const textKindOf = (path: string): TextKind | undefined => (/\.md$/i.test(path) ? "md" : /\.txt$/i.test(path) ? "txt" : undefined);

/** `.hwpx`만 받는 명령에 md·txt를 주면 사용법 오류(종료 코드 2)로 안내한다. */
function rejectText(path: string, command: string): void {
  if (textKindOf(path) !== undefined) throw new UsageError(`${command}은(는) .hwpx 파일만 받습니다(md·txt는 fill과 inspect만 지원합니다): ${path}`);
}

/** `src/repair`의 보정 함수를 동적으로 연결한다. 모듈이 없으면 사용법 오류로 안내한다. */
async function loadRepair(): Promise<(bytes: Uint8Array) => { output: Uint8Array; repaired: unknown[] }> {
  const url = new URL("../../../packages/hwpx-engine/src/repair/index.ts", import.meta.url);
  if (!existsSync(fileURLToPath(url))) {
    throw new UsageError("--mode repair에 필요한 보정 모듈(packages/hwpx-engine/src/repair/index.ts)이 아직 없습니다. baseline 또는 strict를 쓰세요.");
  }
  let mod: { repairDocument?: (bytes: Uint8Array) => { output: Uint8Array; repaired: unknown[] } };
  try {
    mod = (await import(url.href)) as typeof mod;
  } catch (e) {
    throw new UsageError(`보정 모듈을 불러오지 못해 --mode repair를 쓸 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof mod.repairDocument !== "function") throw new UsageError("보정 모듈이 repairDocument를 내보내지 않아 --mode repair를 쓸 수 없습니다.");
  return mod.repairDocument;
}

// ── inspect ─────────────────────────────────────────────────────

/** md·txt 요약: 블록·표·코드 블록 수와 `{{}}` 표기(코드 블록 안의 것은 기본으로 채우지 않으므로 따로 센다). */
function inspectText(file: string, kind: TextKind, p: Parsed, out: Out): number {
  if (str(p, "model") !== undefined) throw new UsageError("--model은 .hwpx에서만 쓸 수 있습니다(md·txt는 모델 JSON이 없습니다).");
  const text = readUtf8(file, "입력 파일");
  const doc = guard(() => parseText(text, kind), file);
  const placeholders = new Map<string, number>();
  let inCode = 0;
  for (const b of doc.blocks) {
    const found = findPlaceholders(b.text);
    if (b.kind === "code") inCode += found.length;
    else for (const h of found) placeholders.set(h.path, (placeholders.get(h.path) ?? 0) + 1);
  }
  const summary = {
    file,
    kind,
    bytes: Buffer.byteLength(text),
    blocks: doc.blocks.length,
    tables: doc.blocks.filter((b) => b.kind === "table").length,
    codeBlocks: doc.blocks.filter((b) => b.kind === "code").length,
    placeholders: [...placeholders].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, count]) => ({ path, count })),
    placeholdersInCode: inCode,
    issues: doc.issues.length,
  };
  if (flag(p, "json")) {
    out.log(json(summary));
    return 0;
  }
  out.log(`파일: ${file} (${summary.bytes}바이트)`);
  out.log(`형식 ${kind}: 블록 ${summary.blocks}개, 표 ${summary.tables}개, 코드 블록 ${summary.codeBlocks}개`);
  out.log(`{{}} 표기 ${summary.placeholders.length}종${summary.placeholders.map((x) => `\n  - ${x.path} x${x.count}`).join("")}`);
  if (inCode > 0) out.log(`코드 블록 안의 {{}} 표기 ${inCode}곳(채우려면 fill --fill-in-code)`);
  printIssues(out, doc.issues);
  return 0;
}

export function inspect(args: string[], out: Out): number {
  const usage = "hwpx inspect <파일> [--json] [--model 출력.json] [--overwrite]   (.md·.txt는 --json만)";
  const p = parse(args, { json: { type: "boolean" }, model: { type: "string" }, overwrite: { type: "boolean" } }, { min: 1, max: 1 }, usage);
  const file = p.positionals[0] ?? "";
  const textKind = textKindOf(file);
  if (textKind !== undefined) return inspectText(file, textKind, p, out);
  const model = str(p, "model");
  if (model !== undefined) checkOutputPath(model, [file], flag(p, "overwrite"));
  const { bytes, doc } = openDocument(file);

  const census = censusOfDoc(doc);
  const placeholders = new Map<string, number>();
  for (const s of doc.sections) {
    for (const par of walkParagraphs(s.paragraphs)) {
      for (const h of findPlaceholders(par.logicalText)) placeholders.set(h.path, (placeholders.get(h.path) ?? 0) + 1);
    }
  }
  const fields = listFields(doc);
  const summary = {
    file,
    bytes: bytes.length,
    sections: doc.sections.length,
    paragraphs: census.paragraphs,
    tables: census.tables,
    pictures: census.pictures,
    binaryItems: census.binaryItems,
    fields: fields.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.mergeKey === undefined ? {} : { mergeKey: f.mergeKey }),
      occurrence: f.occurrence,
      shape: f.shape,
      dirty: f.dirty,
      valueLength: f.valueText.length,
      sectionIndex: f.sectionIndex,
      path: f.path,
    })),
    /** type 속성이 없는 필드 수(종류 `UNKNOWN`. 자리로 세지 않고 채우지 않는다) */
    fieldsWithoutType: fields.filter((f) => f.type === "UNKNOWN").length,
    placeholders: [...placeholders].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, count]) => ({ path, count })),
    resources: Object.fromEntries(Object.entries(doc.header.resources).map(([kind, items]) => [kind, items.length])),
    issues: doc.issues.length,
  };
  if (model !== undefined) writeSafely(model, json(exportModel(doc)), [file], flag(p, "overwrite"));
  if (flag(p, "json")) {
    out.log(json(summary));
    return 0;
  }
  out.log(`파일: ${file} (${bytes.length}바이트)`);
  out.log(`구역 ${summary.sections}개, 문단 ${summary.paragraphs}개, 표 ${summary.tables}개, 그림 ${summary.pictures}개, 이진 항목 ${summary.binaryItems}개`);
  // 종류: 누름틀(CLICK_HERE)·메일머지(MAILMERGE, 이름이 비어 키로 가리킨다)·type 없음(UNKNOWN)·그 밖의 필드는 type 그대로
  const kindOf = (f: { type: string }): string => (f.type === "CLICK_HERE" ? "누름틀" : f.type === "MAILMERGE" ? "메일머지" : f.type === "UNKNOWN" ? "type 없음" : f.type);
  out.log(
    `누름틀·필드 ${summary.fields.length}개${summary.fieldsWithoutType > 0 ? `(type 없음 ${summary.fieldsWithoutType}개는 자리로 세지 않음)` : ""}${summary.fields
      .map((f) => `\n  - [${kindOf(f)}] ${f.mergeKey ?? f.name}[${f.occurrence}] ${f.shape}, dirty=${f.dirty === "" ? "(없음)" : f.dirty}, 값 길이 ${f.valueLength}`)
      .join("")}`,
  );
  out.log(`{{}} 표기 ${summary.placeholders.length}종${summary.placeholders.map((x) => `\n  - ${x.path} x${x.count}`).join("")}`);
  out.log(`자원: ${Object.entries(summary.resources).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (model !== undefined) out.log(`모델 JSON을 저장했습니다: ${model}`);
  return 0;
}

// ── candidates ──────────────────────────────────────────────────

export function candidates(args: string[], out: Out): number {
  const usage = "hwpx candidates <파일> [--json]";
  const p = parse(args, { json: { type: "boolean" } }, { min: 1, max: 1 }, usage);
  const file = p.positionals[0] ?? "";
  rejectText(file, "candidates");
  const { doc } = openDocument(file);
  const found = findCandidates(doc);
  if (flag(p, "json")) {
    out.log(json(found));
    return 0;
  }
  out.log(`후보 자리 ${found.length}개`);
  for (const c of found) out.log(`  [${c.kind}] 구역 ${c.at.sectionIndex} 주소 [${c.at.path.join(", ")}] ${c.evidence}`);
  return 0;
}

// ── headings ────────────────────────────────────────────────────

/**
 * 탐지한 제목(7.10): 한 줄에 `구역:상위주소:문단 번호  단계  꼴  글 앞 40자`(상위 주소는 `문단.하위목록` 짝, 구역 최상위는 `-`).
 * 글은 `Heading.text`(개체 자리 글자를 뺀 앞 40자)에서 줄바꿈·탭을 공백으로 바꿔 한 줄을 지킨다. `--json`은 `detectHeadings` 결과 그대로의 배열.
 */
export function headings(args: string[], out: Out): number {
  const usage = "hwpx headings <파일> [--json]";
  const p = parse(args, { json: { type: "boolean" } }, { min: 1, max: 1 }, usage);
  const file = p.positionals[0] ?? "";
  rejectText(file, "headings");
  const { doc } = openDocument(file);
  const found = detectHeadings(doc);
  if (flag(p, "json")) {
    out.log(json(found));
    return 0;
  }
  out.log(`제목 ${found.length}개`);
  for (const h of found) out.log(`  ${h.at.sectionIndex}:${h.at.parentPath.length === 0 ? "-" : h.at.parentPath.join(".")}:${h.index}  ${h.marker.level}  ${h.marker.form}  ${h.text.replace(/[\r\n\t]/g, " ")}`);
  return 0;
}

// ── fragment ────────────────────────────────────────────────────

function fragmentExtract(args: string[], out: Out): number {
  const usage = "hwpx fragment extract <파일> --section N --from A --to B [--parent 주소] -o 조각.json [--overwrite]";
  const p = parse(
    args,
    { section: { type: "string" }, from: { type: "string" }, to: { type: "string" }, parent: { type: "string" }, output: { type: "string", short: "o" }, overwrite: { type: "boolean" } },
    { min: 1, max: 1 },
    usage,
  );
  const file = p.positionals[0] ?? "";
  rejectText(file, "fragment extract");
  const output = need(p, "output", usage);
  const selection = {
    sectionIndex: intValue(need(p, "section", usage), "section"),
    parentPath: str(p, "parent") === undefined ? [] : parseAddress(str(p, "parent") ?? ""),
    from: intValue(need(p, "from", usage), "from"),
    to: intValue(need(p, "to", usage), "to"),
  };
  checkOutputPath(output, [file], flag(p, "overwrite"));
  const { doc } = openDocument(file);
  try {
    const fragment = extractFragment(doc, selection);
    writeSafely(output, serializeFragment(fragment), [file], flag(p, "overwrite"));
    out.log(`조각을 저장했습니다: ${output} (문단 ${fragment.census.paragraphs}개, 자원 ${fragment.resources.length}개, 이진 자료 ${fragment.binaries.length}개)`);
    printIssues(out, fragment.issues);
    return 0;
  } catch (e) {
    if (!(e instanceof HwpxError)) throw e;
    out.err(`오류 [${e.code}] ${e.message}`);
    return 1;
  }
}

/** 채움 계획 보고서를 사람이 읽을 글로 출력한다(hwpx·md·txt 공통, 값 원문은 없다). */
function printPlan(out: Out, plan: FillReport): void {
  out.log(`액션 ${plan.actions.length}개, 건너뜀 ${plan.skipped.length}, 버림 ${plan.dropped.length}, 재배치 ${plan.relocated.length}, 유지 ${plan.kept.length}종`);
  if (plan.requiredPaths.length > 0) out.log(`필요한 데이터 경로: ${plan.requiredPaths.join(", ")}`);
  if (plan.missingPaths.length > 0) out.log(`데이터에 없던 경로: ${plan.missingPaths.join(", ")}`);
  for (const s of plan.skipped) out.log(`건너뜀 [${s.code}] ${s.ruleId} ${s.anchor}: ${s.message}`);
  const expected = Object.entries(plan.expected);
  if (expected.length > 0) out.log(`예상 수량 증감: ${expected.map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ")}`);
  for (const c of plan.tableChanges) out.log(`표 변경 [${c.ruleId}] ${c.table}: ${c.change}`);
}

/** 생성 결과를 사람이 읽을 글로 출력한다(값 원문은 없다). */
function printResult(out: Out, result: GenerateResult | TextResult): void {
  const r = result.report;
  if ("mode" in r) {
    out.log(`방식: ${r.mode}${r.dryRun ? " (모의 실행)" : ""}`);
    printPlan(out, r.plan);
    const inherited = r.inherited;
    if (inherited.duplicateIds.length + inherited.danglingRefs.length > 0) {
      out.log(
        `상속한 문제(조각이 소스에서 갖고 있던 것): 겹치는 id ${inherited.duplicateIds.length}종, 없는 참조 ${inherited.danglingRefs.length}종, 그로 설명되는 검사 오류 ${inherited.errors.length}종(새 오류로 세지 않음)`,
      );
    }
  } else {
    out.log(`형식: ${r.kind}${r.dryRun ? " (모의 실행)" : ""}`);
    printPlan(out, r.plan);
  }
  printIssues(out, r.issues);
}

async function runGenerate(
  input: string,
  bytes: Uint8Array,
  template: ReturnType<typeof emptyTemplate>,
  dataset: ReturnType<typeof readDataset>,
  options: { mode: GateMode; missing?: MissingPolicy; dryRun: boolean; fragments: Record<string, string>; reissueInternal: boolean },
): Promise<GenerateResult> {
  const call = {
    mode: options.mode,
    dryRun: options.dryRun,
    fragments: options.fragments,
    ...(options.missing === undefined ? {} : { missing: options.missing }),
    ...(options.reissueInternal ? { reissueInternalDuplicates: true } : {}),
    ...(options.mode === "repair" ? { repair: await loadRepair() } : {}),
  };
  try {
    return generate(bytes, template, dataset, call);
  } catch (e) {
    if (e instanceof HwpxError) throw new InputError(`입력 파일을 처리할 수 없습니다: ${input} (${e.code}: ${e.message})`);
    throw e;
  }
}

/** `--range 구역:시작-끝` → 구역 번호와 포함 범위 */
function rangeArg(text: string): { sectionIndex: number; from: number; to: number } {
  const m = /^(\d+):(\d+)-(\d+)$/.exec(text);
  if (m === null || Number(m[2]) > Number(m[3])) throw new UsageError(`--range는 구역:시작-끝 꼴(시작 ≤ 끝, 0부터 세는 문단 번호)이어야 합니다(예: 0:3-7): ${text}`);
  return { sectionIndex: Number(m[1]), from: Number(m[2]), to: Number(m[3]) };
}

async function fragmentImport(args: string[], out: Out): Promise<number> {
  const usage =
    "hwpx fragment import <대상> <조각.json> (--section N --index I [--before] | --range 구역:시작-끝) [--parent 주소] -o 출력.hwpx [--mode baseline|strict|repair] [--reissue-internal] [--report r.json] [--overwrite]";
  const p = parse(
    args,
    {
      section: { type: "string" },
      index: { type: "string" },
      range: { type: "string" },
      parent: { type: "string" },
      before: { type: "boolean" },
      output: { type: "string", short: "o" },
      mode: { type: "string" },
      "reissue-internal": { type: "boolean" },
      report: { type: "string" },
      overwrite: { type: "boolean" },
    },
    { min: 2, max: 2 },
    usage,
  );
  const [target = "", fragmentFile = ""] = p.positionals;
  rejectText(target, "fragment import");
  const output = need(p, "output", usage);
  const rangeText = str(p, "range");
  if (rangeText !== undefined && (str(p, "section") !== undefined || str(p, "index") !== undefined || flag(p, "before"))) {
    throw new UsageError(`--range는 --section·--index·--before와 함께 쓸 수 없습니다.\n사용법: ${usage}`);
  }
  const range = rangeText === undefined ? undefined : rangeArg(rangeText);
  const sectionIndex = range === undefined ? intValue(need(p, "section", usage), "section") : range.sectionIndex;
  const index = range === undefined ? intValue(need(p, "index", usage), "index") : 0;
  const parent = str(p, "parent") === undefined ? [] : parseAddress(str(p, "parent") ?? "");
  const mode = modeOf(p, usage);
  const overwrite = flag(p, "overwrite");
  const reportPath = str(p, "report");
  checkOutputPath(output, [target, fragmentFile], overwrite);
  if (reportPath !== undefined) checkOutputPath(reportPath, [target, fragmentFile, output], overwrite);

  const { bytes, doc } = openDocument(target);
  let fragment: unknown;
  try {
    fragment = JSON.parse(readText(fragmentFile, "조각 파일"));
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError(`조각 파일이 JSON이 아닙니다: ${fragmentFile}`);
  }
  let anchor;
  if (range !== undefined) {
    // 범위 교체: range 앵커(7.10)의 범위 문단들을 지우고 그 자리에 조각을 넣는다
    const draft = makeRangeAnchor(doc, sectionIndex, parent, range.from, range.to);
    if (draft === undefined) throw new UsageError(`구역 ${sectionIndex}의 [${parent.join(", ")}] 목록에 문단 ${range.from}~${range.to}이 없습니다.`);
    anchor = { id: "target", ...draft };
  } else {
    anchor = makeLineAnchor(doc, "target", sectionIndex, [...parent, index]);
    if (anchor === undefined) throw new UsageError(`구역 ${sectionIndex}에 삽입 지점 문단 [${[...parent, index].join(", ")}]이 없습니다.`);
  }
  // 조각 안·문서 안의 `{{}}`는 건드리지 않는다(데이터가 없으므로 누락 정책은 keep)
  const template = readTemplate({
    schema: "hwpx-studio/template@1",
    anchors: [anchor],
    rules: [{ id: "import", do: { type: "inject", anchor: "target", position: range !== undefined ? "replace" : flag(p, "before") ? "before" : "after", fragment } }],
  });
  const result = await runGenerate(target, bytes, template, readDataset({}), { mode, missing: "keep", dryRun: false, fragments: {}, reissueInternal: flag(p, "reissue-internal") });
  return finishGenerate(out, result, output, [target, fragmentFile], overwrite, reportPath);
}

export function fragmentCommand(args: string[], out: Out): Promise<number> | number {
  const [sub, ...rest] = args;
  if (sub === "extract") return fragmentExtract(rest, out);
  if (sub === "import") return fragmentImport(rest, out);
  throw new UsageError("사용법: hwpx fragment extract|import ... (hwpx --help 참고)");
}

// ── fill ────────────────────────────────────────────────────────

function finishGenerate(
  out: Out,
  result: GenerateResult | TextResult,
  output: string | undefined,
  inputs: string[],
  overwrite: boolean,
  reportPath: string | undefined,
): number {
  if (reportPath !== undefined) {
    const body = { ok: result.ok, dryRun: result.ok ? result.dryRun : false, report: result.report, ...("ledger" in result ? { ledger: result.ledger } : {}) };
    writeSafely(reportPath, json(body), inputs, overwrite);
  }
  printResult(out, result);
  if (!result.ok) {
    out.err("검증을 통과하지 못해 출력 파일을 만들지 않았습니다.");
    return 1;
  }
  if (result.dryRun) return 0;
  if (output === undefined) throw new UsageError("-o 출력 경로가 필요합니다.");
  writeSafely(output, result.output, inputs, overwrite);
  out.log(`저장했습니다: ${output} (${typeof result.output === "string" ? Buffer.byteLength(result.output) : result.output.length}바이트)`);
  return 0;
}

export async function fill(args: string[], out: Out): Promise<number> {
  const usage =
    "hwpx fill <파일> --data d.json [--template t.json] -o 출력 [--missing error|empty|keep] [--dry-run] [--report r.json] [--overwrite]\n" +
    "  .hwpx 전용: [--mode baseline|strict|repair] [--reissue-internal]   .md·.txt 전용: [--fill-in-code]\n" +
    "  여러 건(.hwpx, 데이터가 배열): hwpx fill <파일> --data 배열.json --batch -o 폴더 [--name \"{{경로}}\"] [위 옵션]";
  const p = parse(
    args,
    {
      data: { type: "string" },
      template: { type: "string" },
      output: { type: "string", short: "o" },
      mode: { type: "string" },
      missing: { type: "string" },
      "dry-run": { type: "boolean" },
      report: { type: "string" },
      overwrite: { type: "boolean" },
      "reissue-internal": { type: "boolean" },
      "fill-in-code": { type: "boolean" },
      batch: { type: "boolean" },
      name: { type: "string" },
      case: { type: "string" },
      blobs: { type: "string" },
    },
    { min: 1, max: 1 },
    usage,
  );
  const file = p.positionals[0] ?? "";
  const templatePath = str(p, "template");
  // 2판 템플릿(template@2)이면 2단계 생성으로 간다. 1판(@1)·읽을 수 없는 파일은 아래 기존 경로가 그대로 처리한다
  const studioText = templatePath === undefined ? undefined : studioTemplateText(templatePath);
  if (templatePath !== undefined && studioText !== undefined) return fillStudio(p, file, templatePath, studioText, out);
  if (str(p, "case") !== undefined || str(p, "blobs") !== undefined) throw new UsageError(`--case·--blobs는 2판 템플릿(hwpx-studio/template@2)에만 씁니다.\n사용법: ${usage}`);
  const dryRun = flag(p, "dry-run");
  const overwrite = flag(p, "overwrite");
  const textKind = textKindOf(file);
  if (textKind === undefined && !/\.hwpx$/i.test(file)) throw new UsageError(`.hwpx·.md·.txt 파일만 처리합니다: ${file}`);
  if (textKind !== undefined) {
    if (str(p, "mode") !== undefined) throw new UsageError(`--mode는 .hwpx에서만 쓸 수 있습니다(md·txt는 저장 게이트 방식이 없습니다).\n사용법: ${usage}`);
    if (flag(p, "reissue-internal")) throw new UsageError(`--reissue-internal은 .hwpx에서만 쓸 수 있습니다(md·txt 조각에는 id가 없습니다).\n사용법: ${usage}`);
  } else if (flag(p, "fill-in-code")) {
    throw new UsageError(`--fill-in-code는 .md·.txt에서만 쓸 수 있습니다.\n사용법: ${usage}`);
  }
  const batch = flag(p, "batch");
  const nameSpec = str(p, "name");
  if (nameSpec !== undefined && !batch) throw new UsageError(`--name은 --batch와 함께 쓰는 옵션입니다.\n사용법: ${usage}`);
  if (batch && textKind !== undefined) throw new UsageError(`--batch는 .hwpx에서만 쓸 수 있습니다(md·txt는 여러 건 생성이 없습니다).\n사용법: ${usage}`);
  const nameFrom = nameSpec === undefined ? undefined : pathOfNameSpec(nameSpec, usage);
  const dataPath = need(p, "data", usage);
  const output = str(p, "output");
  if (output === undefined && !dryRun) throw new UsageError(`-o ${batch ? "출력 폴더" : "출력 경로"}가 필요합니다(모의 실행은 --dry-run).\n사용법: ${usage}`);
  if (batch && output !== undefined && !dryRun && !(existsSync(resolve(output)) && statSync(resolve(output)).isDirectory())) {
    throw new UsageError(`출력 폴더가 없습니다(--batch의 -o는 있는 폴더여야 합니다): ${output}`);
  }
  const mode = modeOf(p, usage);
  const missingText = str(p, "missing");
  if (missingText !== undefined && missingText !== "error" && missingText !== "empty" && missingText !== "keep") {
    throw new UsageError(`--missing은 error·empty·keep 가운데 하나여야 합니다: ${missingText}`);
  }
  const reportPath = str(p, "report");
  const inputs = [file, dataPath, ...(templatePath === undefined ? [] : [templatePath])];
  if (output !== undefined && !batch) checkOutputPath(output, inputs, overwrite);
  if (reportPath !== undefined && !batch) checkOutputPath(reportPath, [...inputs, ...(output === undefined ? [] : [output])], overwrite);

  // .hwpx는 데이터가 배열(또는 data가 배열인 묶음)이면 여러 건이다: --batch가 있어야 하고, 없으면 쓰는 법을 안내한다
  const dataText = readText(dataPath, "데이터 파일");
  const records = textKind === undefined ? guard(() => readBatchRecords(dataText), dataPath) : undefined;
  if (batch && records === undefined) throw new UsageError(`--batch는 데이터가 배열(또는 data가 배열인 묶음)일 때 쓰는 옵션입니다: ${dataPath}\n사용법: ${usage}`);
  if (!batch && records !== undefined) throw new UsageError(`여러 건 데이터입니다. --batch를 쓰십시오.\n사용법: ${usage}`);
  const data = records === undefined ? ({ dataset: guard(() => readDataset(dataText), dataPath) } as const) : ({ records } as const);
  const template = templatePath === undefined ? emptyTemplate() : guard(() => readTemplate(readText(templatePath, "템플릿 파일")), templatePath);
  // 조각 경로는 템플릿 파일이 있는 폴더 기준이다. 조각 파일도 입력이므로 출력 경로와 같으면 거부한다.
  const fragments: Record<string, string> = {};
  const fragmentFiles: string[] = [];
  for (const path of fragmentPaths(template)) {
    const fragmentFile = resolve(dirname(templatePath ?? "."), path);
    fragmentFiles.push(fragmentFile);
    fragments[path] = readText(fragmentFile, `조각 파일(${path})`);
  }
  const missing: { missing?: MissingPolicy } = missingText === undefined ? {} : { missing: missingText };
  const allInputs = [...inputs, ...fragmentFiles];
  if ("records" in data) {
    const options = { mode, dryRun, fragments, reissueInternal: flag(p, "reissue-internal"), ...missing };
    return await fillBatch({ file, records: data.records, template, nameFrom, folder: output, inputs: allInputs, overwrite, reportPath, options }, out);
  }
  const { dataset } = data;
  if (textKind !== undefined) {
    const text = readUtf8(file, "입력 파일");
    const result = guard(() => generateText(text, textKind, template, dataset, { dryRun, fragments, fillInCode: flag(p, "fill-in-code"), ...missing }), file);
    return finishGenerate(out, result, output, allInputs, overwrite, reportPath);
  }
  const result = await runGenerate(file, readBytes(file, "입력 파일"), template, dataset, { mode, dryRun, fragments, reissueInternal: flag(p, "reissue-internal"), ...missing });
  return finishGenerate(out, result, output, allInputs, overwrite, reportPath);
}

/** 템플릿 파일이 2판 이상(`hwpx-studio/template@N`, N ≠ 1)이면 그 글. 읽을 수 없거나 JSON이 아니거나 1판이면 undefined(기존 경로가 처리한다) */
function studioTemplateText(path: string): string | undefined {
  let text: string;
  let raw: unknown;
  try {
    text = readFileSync(path, "utf8");
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const schema = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)["schema"] : undefined;
  const m = typeof schema === "string" ? /^hwpx-studio\/template@(\d+)$/.exec(schema) : null;
  return m !== null && m[1] !== "1" ? text : undefined;
}

/**
 * `fill --template t2.json`: 2판 템플릿의 2단계 생성(엔진 `generateFromTemplate`, 명세 8.8.12·8.4). 데이터는 한 건(객체)이고, `--case`는 이번 건,
 * `--blobs`는 조각 덩어리를 `<sha256>.json`으로 담은 폴더다(받은 바이트의 해시는 엔진이 대조한다). 덩어리 파일도 입력이라 출력 경로로 덮어쓸 수 없다.
 * 앱과 같은 함수를 같은 인자로 부르므로 같은 바이트를 낸다. 종료 코드: 0 성공, 1 생성·게이트 실패, 2 사용법·읽을 수 없는 입력.
 */
function fillStudio(p: Parsed, file: string, templatePath: string, templateText: string, out: Out): number {
  const usage = "hwpx fill <파일.hwpx|.md> --template t2.json --data 한건.json [--case c.json] [--blobs 폴더] -o 출력 [--dry-run] [--report r.json] [--overwrite]";
  for (const name of ["batch", "name", "mode", "missing", "reissue-internal", "fill-in-code"]) {
    if (p.values[name] !== undefined) throw new UsageError(`--${name}은(는) 2판 템플릿(template@2)과 함께 쓸 수 없습니다.\n사용법: ${usage}`);
  }
  if (!/\.(hwpx|md)$/i.test(file)) throw new UsageError(`2판 템플릿의 원본은 .hwpx나 .md 파일입니다: ${file}\n사용법: ${usage}`);
  const dryRun = flag(p, "dry-run");
  const overwrite = flag(p, "overwrite");
  const dataPath = need(p, "data", usage);
  const output = str(p, "output");
  if (output === undefined && !dryRun) throw new UsageError(`-o 출력 경로가 필요합니다(모의 실행은 --dry-run).\n사용법: ${usage}`);
  const casePath = str(p, "case");
  const blobDir = str(p, "blobs");
  const reportPath = str(p, "report");
  if (blobDir !== undefined && !(existsSync(resolve(blobDir)) && statSync(resolve(blobDir)).isDirectory())) throw new UsageError(`--blobs 폴더가 없습니다: ${blobDir}`);
  /** 덩어리 파일 경로(없으면 undefined) */
  const blobFile = (sha: string): string | undefined => {
    const f = blobDir === undefined ? undefined : join(blobDir, `${sha}.json`);
    return f !== undefined && existsSync(f) && statSync(f).isFile() ? f : undefined;
  };
  const read = guard(() => readStudioTemplate(templateText, { hasBlob: (sha) => blobFile(sha) !== undefined }), templatePath);
  if (read.schema !== "hwpx-studio/template@2") throw new InputError(`${templatePath}: 2판 템플릿이 아닙니다.`);
  const t = read;
  const dataText = readText(dataPath, "데이터 파일");
  if (guard(() => readBatchRecords(dataText), dataPath) !== undefined) throw new UsageError(`2판 템플릿은 데이터 한 건(JSON 객체)만 받습니다(--batch는 쓸 수 없습니다): ${dataPath}\n사용법: ${usage}`);
  const record = guard(() => readDataset(dataText), dataPath).data;
  const c = casePath === undefined ? undefined : guard(() => readCase(readText(casePath, "이번 건 파일"), t), casePath);
  const hashes = new Set([...t.blocks.map((b) => b.content), ...Object.values(c?.blockEdits ?? {})].flatMap((x) => ("fragment" in x ? [x.fragment] : [])));
  const blobFiles = [...hashes].flatMap((sha) => blobFile(sha) ?? []);
  const inputs = [file, dataPath, templatePath, ...(casePath === undefined ? [] : [casePath]), ...blobFiles];
  if (output !== undefined) checkOutputPath(output, inputs, overwrite);
  if (reportPath !== undefined) checkOutputPath(reportPath, [...inputs, ...(output === undefined ? [] : [output])], overwrite);

  const bytes = readBytes(file, "입력 파일");
  const loadBlob = (sha: string): Uint8Array | undefined => {
    const f = blobFile(sha);
    return f === undefined ? undefined : readBytes(f, "조각 덩어리");
  };
  let result: StudioGenerateResult;
  try {
    result = generateFromTemplate(bytes, t, record, c, loadBlob, { dryRun });
  } catch (e) {
    if (e instanceof HwpxError) throw new InputError(`입력 파일을 처리할 수 없습니다: ${file} (${e.code}: ${e.message})`);
    throw e;
  }
  if (reportPath !== undefined) {
    const body = { ok: result.ok, dryRun: result.ok ? result.dryRun : false, report: result.report, ...("ledger" in result && result.ledger !== undefined ? { ledger: result.ledger } : {}) };
    writeSafely(reportPath, json(body), inputs, overwrite);
  }
  printStudio(out, result);
  if (!result.ok) {
    out.err("검증을 통과하지 못해 출력 파일을 만들지 않았습니다.");
    return 1;
  }
  if (result.dryRun) return 0;
  if (output === undefined) throw new UsageError("-o 출력 경로가 필요합니다.");
  writeSafely(output, result.output, inputs, overwrite);
  out.log(`저장했습니다: ${output} (${typeof result.output === "string" ? Buffer.byteLength(result.output) : result.output.length}바이트)`);
  return 0;
}

/** 2판 생성 결과를 사람이 읽을 글로 출력한다(값 원문은 없다). */
function printStudio(out: Out, result: StudioGenerateResult): void {
  const r = result.report;
  out.log(`2판 템플릿 생성(${r.kind})${r.dryRun ? " (모의 실행)" : ""}`);
  for (const s of r.selections) out.log(`슬롯 ${s.slot}: ${s.block ?? "-"} (${s.state}${s.differs === true ? ", 조건과 다름" : ""})`);
  if (r.stage1 !== null) out.log(`1단계(구조): 액션 ${r.stage1.plan.actions.length}개, 이동표 ${r.moves.length}건`);
  if (r.stage2 !== null) out.log(`2단계(값): 액션 ${r.stage2.plan.actions.length}개, 건너뜀 ${r.skipped.length}, 버림 ${r.stage2.plan.dropped.length}`);
  for (const d of r.dropped) out.log(`빠진 자리 [${d.code}] ${d.message}`);
  for (const s of r.skipped) out.log(`건너뜀 [${s.code}] ${s.ruleId} ${s.anchor}: ${s.message}`);
  if (r.postprocess.unwrapped > 0 || r.postprocess.preview) out.log(`후처리: 필드 표식 풀기 ${r.postprocess.unwrapped}개, 미리보기 글 ${r.postprocess.preview ? "다시 씀" : "그대로"}`);
  printIssues(out, r.issues);
}

/** `--name "{{경로}}"`의 경로. 표기 하나가 글 전체여야 한다(앞뒤 공백은 허용). */
function pathOfNameSpec(spec: string, usage: string): string {
  const text = spec.trim();
  const hit = findPlaceholders(text)[0];
  if (hit === undefined || hit.start !== 0 || hit.end !== text.length) {
    throw new UsageError(`--name은 "{{경로}}" 꼴 하나여야 합니다(예: --name "{{id}}"): ${spec}\n사용법: ${usage}`);
  }
  return hit.path;
}

/** 건별 결과 한 줄(보고서의 `items` 원소). 값 원문은 없다(`name`은 `--name` 값에서 온 파일 이름이다). */
type BatchRow = Pick<BatchItem, "index" | "name" | "ok" | "filled" | "skipped" | "warnings" | "dropped" | "errorCodes" | "errors">;

/**
 * `fill --batch`: 데이터가 배열이면 원소마다 결과 파일 하나를 `folder`에 만든다. 건마다 `generate`를 거치고(엔진의 `generateBatch`),
 * 한 건이 실패해도 나머지는 만든다. 하나라도 실패하면 종료 코드 1이다. 이름은 데이터만 보고 미리 정하므로 파일을 만들기 전에
 * 같은 이름의 기존 파일을 한꺼번에 확인한다(`--overwrite` 없이는 거부, 종료 코드 2). 건마다 임시 파일에 쓴 뒤 이름을 바꾼다.
 * `--overwrite`로 다시 돌릴 때 실패한 건의 같은 이름 옛 파일은 지운다(`--dry-run`이면 지우지 않는다).
 */
async function fillBatch(
  c: {
    file: string;
    records: BatchRecord[];
    template: ReturnType<typeof emptyTemplate>;
    nameFrom: string | undefined;
    folder: string | undefined;
    inputs: string[];
    overwrite: boolean;
    reportPath: string | undefined;
    options: { mode: GateMode; missing?: MissingPolicy; dryRun: boolean; fragments: Record<string, string>; reissueInternal: boolean };
  },
  out: Out,
): Promise<number> {
  const { file, records, folder, inputs, overwrite, reportPath, options } = c;
  const { bytes } = openDocument(file); // 열 수 없는 입력 문서는 건의 실패가 아니라 종료 코드 2
  const baseName = basename(file).replace(/\.hwpx$/i, "");
  const names = planBatchNames(records, baseName, c.nameFrom);
  const targets = folder === undefined || options.dryRun ? [] : names.map((name) => join(folder, name));
  for (const target of targets) checkOutputPath(target, inputs, overwrite);
  if (reportPath !== undefined) checkOutputPath(reportPath, [...inputs, ...targets], overwrite);

  const call = {
    mode: options.mode,
    dryRun: options.dryRun,
    fragments: options.fragments,
    ...(options.missing === undefined ? {} : { missing: options.missing }),
    ...(options.reissueInternal ? { reissueInternalDuplicates: true } : {}),
    ...(options.mode === "repair" ? { repair: await loadRepair() } : {}),
    baseName,
    ...(c.nameFrom === undefined ? {} : { nameFrom: c.nameFrom }),
  };
  const rows: BatchRow[] = [];
  for (const item of generateBatch(bytes, c.template, records, call)) {
    // 만든 문서는 바로 쓰고 놓는다(건수가 많아도 문서를 모두 쥐지 않는다)
    if (item.output !== undefined && folder !== undefined) writeSafely(join(folder, item.name), item.output, inputs, overwrite);
    const { index, name, ok, filled, skipped, errorCodes, errors, warnings, dropped } = item;
    rows.push({ index, name, ok, filled, skipped, warnings, dropped, errorCodes, errors });
    const label = `${String(index).padStart(3, "0")} ${name}`;
    if (ok) {
      out.log(`성공 ${label} (채움 ${filled}, 건너뜀 ${skipped.length})`);
      for (const s of skipped) out.log(`  건너뜀 [${s.code}] ${s.anchor}: ${s.message}`);
      for (const w of warnings) out.log(`  경고 [${w.code}] ${w.message}`);
    } else {
      out.err(`실패 ${label}`);
      for (const e of errors) out.err(`  오류 [${e.code}] ${e.message}`);
      // 실패한 건은 파일을 만들지 않으므로, `--overwrite`일 때 전 실행의 같은 이름 파일이 남아 있으면 지운다(입력 파일과 같은 경로는 거부)
      if (overwrite && !options.dryRun && folder !== undefined) {
        const stale = join(folder, name);
        if (existsSync(stale) && statSync(stale).isFile()) {
          checkOutputPath(stale, inputs, true);
          try {
            rmSync(stale);
          } catch (e) {
            throw new InputError(`이전 결과 파일을 지울 수 없습니다: ${stale} (${e instanceof Error ? e.message : String(e)})`);
          }
          out.err(`  이전 결과 파일을 지웠습니다: ${name}`);
        }
      }
    }
  }
  const failed = rows.filter((r) => !r.ok).length;
  if (rows.length === 0) out.log("데이터가 0건이라 만든 파일이 없습니다.");
  out.log(`여러 건 생성: 총 ${rows.length}건, 성공 ${rows.length - failed}, 실패 ${failed}${options.dryRun ? " (모의 실행: 파일을 만들지 않았습니다)" : ""}`);
  if (reportPath !== undefined) {
    const body = { batch: true, ok: failed === 0, dryRun: options.dryRun, total: rows.length, succeeded: rows.length - failed, failed, items: rows };
    writeSafely(reportPath, json(body), [...inputs, ...targets], overwrite);
  }
  return failed > 0 ? 1 : 0;
}

/** 템플릿·데이터를 읽다가 나는 `TPL_*`·`DATA_*` 오류를 읽을 수 없는 입력(종료 코드 2)으로 바꾼다. */
function guard<T>(read: () => T, path: string): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof HwpxError) throw new InputError(`${path}: ${e.code}: ${e.message}`);
    throw e;
  }
}

// ── table ───────────────────────────────────────────────────────

/** 표 하나를 한 줄로 요약한다(글 내용은 없다). */
function tableLine(t: ReturnType<typeof listTables>[number]): string {
  const yn = (v: boolean | undefined): string => (v === undefined ? "?" : v ? "예" : "아니오");
  const id = t.topOrdinal === undefined ? "-" : `${t.sectionIndex}:${t.topOrdinal}`;
  const nested = t.depth > 0 ? ` (중첩 깊이 ${t.depth}, 설정 대상 아님)` : "";
  return `  ${id.padEnd(5)} 위치 [${t.paragraphPath.join(", ")}]${nested} ${t.rowCnt ?? "?"}행×${t.colCnt ?? "?"}열, 너비 ${t.width ?? "?"}, 글자처럼 취급 ${yn(t.treatAsChar)}, 쪽 나눔 ${t.pageBreak ?? "?"}, 제목 행 반복 ${yn(t.repeatHeader)}, 병합 셀 ${t.mergedCells}개${t.regular ? "" : t.structureRegular ? ", 너비 불규칙(행마다 열 경계가 어긋남: 열 너비가 필요한 조정은 안 됨)" : ", 불규칙 격자"}`;
}

function tableList(args: string[], out: Out): number {
  const usage = "hwpx table list <파일> [--json]";
  const p = parse(args, { json: { type: "boolean" } }, { min: 1, max: 1 }, usage);
  const file = p.positionals[0] ?? "";
  rejectText(file, "table list");
  const { doc } = openDocument(file);
  const tables = listTables(doc);
  if (flag(p, "json")) {
    out.log(
      json(
        tables.map((t) => ({
          section: t.sectionIndex,
          ordinal: t.topOrdinal ?? null,
          documentOrdinal: t.ordinal,
          depth: t.depth,
          paragraphPath: t.paragraphPath,
          rowCnt: t.rowCnt ?? null,
          colCnt: t.colCnt ?? null,
          width: t.width ?? null,
          height: t.height ?? null,
          treatAsChar: t.treatAsChar ?? null,
          pageBreak: t.pageBreak ?? null,
          repeatHeader: t.repeatHeader ?? null,
          mergedCells: t.mergedCells,
          regular: t.regular,
          structureRegular: t.structureRegular,
          widthRegular: t.widthRegular,
        })),
      ),
    );
    return 0;
  }
  out.log(`표 ${tables.length}개 (설정 대상 번호는 구역:순번이고 중첩 표는 -)`);
  for (const t of tables) out.log(tableLine(t));
  return 0;
}

const onOff = (p: Parsed, name: string, usage: string): boolean | undefined => {
  const v = str(p, name);
  if (v === undefined) return undefined;
  if (v !== "on" && v !== "off") throw new UsageError(`--${name}은(는) on이나 off여야 합니다: ${v}\n사용법: ${usage}`);
  return v === "on";
};

async function tableSet(args: string[], out: Out): Promise<number> {
  const usage =
    "hwpx table set <파일> --table 구역:순번 -o 출력.hwpx [--treat-as-char on|off] [--page-break cell|none|table] [--repeat-header on|off] [--width N | --scale X | --columns a,b,c] [--mode baseline|strict|repair] [--report r.json] [--overwrite]";
  const p = parse(
    args,
    {
      table: { type: "string" },
      "treat-as-char": { type: "string" },
      "page-break": { type: "string" },
      "repeat-header": { type: "string" },
      width: { type: "string" },
      scale: { type: "string" },
      columns: { type: "string" },
      output: { type: "string", short: "o" },
      mode: { type: "string" },
      report: { type: "string" },
      overwrite: { type: "boolean" },
    },
    { min: 1, max: 1 },
    usage,
  );
  const file = p.positionals[0] ?? "";
  rejectText(file, "table set");
  const output = need(p, "output", usage);
  const spec = /^(\d+):(\d+)$/.exec(need(p, "table", usage));
  if (spec === null) throw new UsageError(`--table은 구역:순번 꼴이어야 합니다(예: 0:2): ${str(p, "table")}\n사용법: ${usage}`);
  const sectionIndex = Number(spec[1]);
  const ordinal = Number(spec[2]);

  const table: Record<string, unknown> = {};
  const treat = onOff(p, "treat-as-char", usage);
  if (treat !== undefined) table["treatAsChar"] = treat;
  const pageBreak = str(p, "page-break");
  if (pageBreak !== undefined) {
    if (!["cell", "none", "table"].includes(pageBreak)) throw new UsageError(`--page-break는 cell·none·table 가운데 하나여야 합니다: ${pageBreak}\n사용법: ${usage}`);
    table["pageBreak"] = pageBreak.toUpperCase();
  }
  const header = onOff(p, "repeat-header", usage);
  if (header !== undefined) table["repeatHeader"] = header;

  const resize: Record<string, unknown> = {};
  const sizeOptions = ["width", "scale", "columns"].filter((n) => str(p, n) !== undefined);
  if (sizeOptions.length > 1) throw new UsageError(`--width·--scale·--columns는 하나만 줄 수 있습니다(받은 것: ${sizeOptions.map((n) => `--${n}`).join(", ")}).\n사용법: ${usage}`);
  if (str(p, "width") !== undefined) {
    const width = intValue(str(p, "width") ?? "", "width");
    if (width < 1) throw new UsageError(`--width는 1 이상의 정수여야 합니다: ${width}\n사용법: ${usage}`);
    resize["width"] = width;
  }
  if (str(p, "scale") !== undefined) {
    // 10진수만 받는다(`0x2`·`1e3`은 Number가 읽어도 거절한다)
    const text = str(p, "scale") ?? "";
    const scale = /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isFinite(scale) || scale <= 0) throw new UsageError(`--scale은 0보다 큰 10진수여야 합니다: ${text}\n사용법: ${usage}`);
    resize["scale"] = scale;
  }
  if (str(p, "columns") !== undefined) {
    const parts = (str(p, "columns") ?? "").split(",");
    const columns = parts.map((x) => intValue(x.trim(), "columns"));
    if (columns.some((w) => w < 1)) throw new UsageError(`--columns의 열 너비는 모두 1 이상의 정수여야 합니다: ${str(p, "columns")}\n사용법: ${usage}`);
    resize["columns"] = columns;
  }
  if (Object.keys(table).length === 0 && Object.keys(resize).length === 0) throw new UsageError(`바꿀 설정이 없습니다(--treat-as-char, --page-break, --repeat-header, --width, --scale, --columns 가운데 하나 이상).\n사용법: ${usage}`);

  const mode = modeOf(p, usage);
  const overwrite = flag(p, "overwrite");
  const reportPath = str(p, "report");
  checkOutputPath(output, [file], overwrite);
  if (reportPath !== undefined) checkOutputPath(reportPath, [file, output], overwrite);

  const { bytes, doc } = openDocument(file);
  // 템플릿 앵커는 최상위 표(구역 안 서수)만 가리킬 수 있다
  const found = listTables(doc).find((t) => t.sectionIndex === sectionIndex && t.topOrdinal === ordinal);
  if (found === undefined) throw new UsageError(`구역 ${sectionIndex}에 ${ordinal}번째 최상위 표가 없습니다(hwpx table list로 번호를 확인하세요. 중첩 표는 지정할 수 없습니다).`);
  const rules: unknown[] = [];
  if (Object.keys(table).length > 0) rules.push({ id: "table-props", do: { type: "tableProps", anchor: "t", table } });
  if (Object.keys(resize).length > 0) rules.push({ id: "table-resize", do: { type: "resize", anchor: "t", ...resize } });
  let template;
  try {
    template = readTemplate({
      schema: "hwpx-studio/template@1",
      anchors: [{ id: "t", kind: "object", objectType: "tbl", sectionIndex, ordinal }],
      rules,
    });
  } catch (e) {
    // 위에서 걸러지지 않은 값(범위 초과 등)은 템플릿 읽기가 거절한다. 사용법 오류로 알린다(스택 없음).
    if (e instanceof HwpxError) throw new UsageError(`${e.message}\n사용법: ${usage}`);
    throw e;
  }
  // 문서 안 `{{}}`는 건드리지 않는다(데이터가 없으므로 누락 정책은 keep)
  const result = await runGenerate(file, bytes, template, readDataset({}), { mode, missing: "keep", dryRun: false, fragments: {}, reissueInternal: false });
  return finishGenerate(out, result, output, [file], overwrite, reportPath);
}

export function tableCommand(args: string[], out: Out): Promise<number> | number {
  const [sub, ...rest] = args;
  if (sub === "list") return tableList(rest, out);
  if (sub === "set") return tableSet(rest, out);
  throw new UsageError("사용법: hwpx table list|set ... (hwpx --help 참고)");
}

// ── validate ────────────────────────────────────────────────────

export function validate(args: string[], out: Out): number {
  const usage = "hwpx validate <파일> [--baseline 원본] [--strict] [--json]";
  const p = parse(args, { baseline: { type: "string" }, strict: { type: "boolean" }, json: { type: "boolean" } }, { min: 1, max: 1 }, usage);
  const file = p.positionals[0] ?? "";
  const baselinePath = str(p, "baseline");
  rejectText(file, "validate");
  if (baselinePath !== undefined) rejectText(baselinePath, "validate");
  const strict = flag(p, "strict");
  const report = validateDocument(readBytes(file, "입력 파일"), { strict });
  const comparison = baselinePath === undefined ? undefined : compareToBaseline(validateDocument(readBytes(baselinePath, "기준선 파일")), report);
  const failed = comparison === undefined || strict ? report.errors.length > 0 : comparison.newErrors.length > 0;
  if (flag(p, "json")) {
    out.log(json({ ok: !failed, strict, report, ...(comparison === undefined ? {} : { baseline: comparison }) }));
    return failed ? 1 : 0;
  }
  const line = (i: { code: string; message: string; where?: string; count: number }): string => `[${i.code}] ${i.message}${i.where === undefined ? "" : ` (${i.where})`}${i.count > 1 ? ` x${i.count}` : ""}`;
  out.log(`오류 ${report.errors.length}종, 경고 ${report.warnings.length}종 (${strict ? "엄격" : "기본"})`);
  for (const e of report.errors) out.log(`오류 ${line(e)}`);
  for (const w of report.warnings) out.log(`경고 ${line(w)}`);
  if (comparison !== undefined) {
    out.log(`기준선 대조: 새 오류 ${comparison.newErrors.length}종, 원래 있던 오류 ${comparison.preexisting.length}종, 해소 ${comparison.resolved.length}종`);
    for (const e of comparison.newErrors) out.log(`새 오류 ${line(e)}`);
  }
  out.log(failed ? "검사 실패" : "검사 통과");
  return failed ? 1 : 0;
}

// ── diff ────────────────────────────────────────────────────────

export function diff(args: string[], out: Out): number {
  const usage = "hwpx diff <원본> <결과> [--json]";
  const p = parse(args, { json: { type: "boolean" } }, { min: 2, max: 2 }, usage);
  const [aPath = "", bPath = ""] = p.positionals;
  rejectText(aPath, "diff");
  rejectText(bPath, "diff");
  const a = readBytes(aPath, "원본 파일");
  const b = readBytes(bPath, "결과 파일");
  let archiveA;
  let archiveB;
  try {
    archiveA = readArchive(a);
    archiveB = readArchive(b);
  } catch (e) {
    if (e instanceof HwpxError) throw new InputError(`파일을 열 수 없습니다: ${e.code}: ${e.message}`);
    throw e;
  }
  const names = [...archiveA.entries.map((e) => e.name), ...archiveB.entries.map((e) => e.name).filter((n) => !archiveA.entries.some((e) => e.name === n))];
  const same = (x: Uint8Array, y: Uint8Array): boolean => x.length === y.length && x.every((v, i) => v === y[i]);
  const entries = names.map((name) => {
    const ea = archiveA.entries.find((e) => e.name === name);
    const eb = archiveB.entries.find((e) => e.name === name);
    if (ea === undefined) return { name, status: "added" as const };
    if (eb === undefined) return { name, status: "removed" as const };
    const content = same(readEntry(archiveA, a, name), readEntry(archiveB, b, name));
    const record = same(a.subarray(ea.localStart, ea.localEnd), b.subarray(eb.localStart, eb.localEnd));
    return { name, status: content ? ("identical" as const) : ("changed" as const), recordIdentical: record };
  });
  const before = validateDocument(a).census;
  const after = validateDocument(b).census;
  const census = {
    before,
    after,
    delta: {
      paragraphs: after.paragraphs - before.paragraphs,
      tables: after.tables - before.tables,
      pictures: after.pictures - before.pictures,
      fieldPairs: after.fieldPairs - before.fieldPairs,
      bookmarks: after.bookmarks - before.bookmarks,
      binaryItems: after.binaryItems - before.binaryItems,
    },
  };
  const summary = {
    identical: entries.filter((e) => e.status === "identical").length,
    changed: entries.filter((e) => e.status === "changed").length,
    added: entries.filter((e) => e.status === "added").length,
    removed: entries.filter((e) => e.status === "removed").length,
  };
  if (flag(p, "json")) {
    out.log(json({ entries, summary, census }));
    return 0;
  }
  out.log(`항목 ${entries.length}개: 같음 ${summary.identical}, 바뀜 ${summary.changed}, 추가 ${summary.added}, 삭제 ${summary.removed}`);
  for (const e of entries) if (e.status !== "identical") out.log(`  ${e.status === "changed" ? "바뀜" : e.status === "added" ? "추가" : "삭제"}: ${e.name}`);
  out.log(`수량 증감: ${Object.entries(census.delta).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ")}`);
  return 0;
}

// ── compile ─────────────────────────────────────────────────────

export function compile(args: string[], out: Out): number {
  const usage = "hwpx compile <파일> -o 승격본 --experimental [--merge-fields to-placeholder|to-field] [--overwrite]   (--merge-fields는 메일 머지 필드 변환만 하고 {{}} 승격은 하지 않는다)";
  const p = parse(
    args,
    { output: { type: "string", short: "o" }, experimental: { type: "boolean" }, "merge-fields": { type: "string" }, overwrite: { type: "boolean" } },
    { min: 1, max: 1 },
    usage,
  );
  const mergeText = str(p, "merge-fields");
  if (mergeText !== undefined && mergeText !== "to-placeholder" && mergeText !== "to-field") {
    throw new UsageError(`--merge-fields는 to-placeholder(필드를 {{키}} 글로)나 to-field(필드를 누름틀로)여야 합니다: ${mergeText}\n사용법: ${usage}`);
  }
  const mergeFields: MergeFieldsMode | undefined = mergeText;
  const file = p.positionals[0] ?? "";
  rejectText(file, "compile");
  if (!flag(p, "experimental")) {
    throw new UsageError(`compile은 실험 기능입니다(한컴에서 열리는지 확인되기 전). --experimental을 붙여야 합니다.\n사용법: ${usage}`);
  }
  const output = need(p, "output", usage);
  checkOutputPath(output, [file], flag(p, "overwrite"));
  const bytes = readBytes(file, "입력 파일");
  let result;
  try {
    result = compileDocument(bytes, mergeFields === undefined ? {} : { mergeFields });
  } catch (e) {
    if (e instanceof HwpxError) throw new InputError(`입력 파일을 처리할 수 없습니다: ${file} (${e.code}: ${e.message})`);
    throw e;
  }
  printIssues(out, result.report.issues);
  if (!result.ok) {
    out.err("검증을 통과하지 못해 출력 파일을 만들지 않았습니다.");
    return 1;
  }
  writeSafely(output, result.output, [file], flag(p, "overwrite"));
  if (mergeFields === undefined) out.log(`누름틀 ${result.report.promoted}개로 승격해 저장했습니다: ${output} (${basename(output)})`);
  else out.log(`메일 머지 필드 ${result.report.mergeConverted}개를 ${mergeFields === "to-field" ? "누름틀(이름 = 키)로" : "{{키}} 글로"} 바꿔 저장했습니다: ${output} (${basename(output)})`);
  return 0;
}
