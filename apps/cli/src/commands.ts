import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flag, intValue, need, parse, parseAddress, str, type Parsed } from "./args.ts";
import {
  HwpxError,
  censusOfDoc,
  compareToBaseline,
  compileDocument,
  emptyTemplate,
  exportModel,
  extractFragment,
  findCandidates,
  findPlaceholders,
  fragmentPaths,
  generate,
  generateText,
  listFields,
  listTables,
  makeLineAnchor,
  openPackage,
  parseDocument,
  parseText,
  readArchive,
  readDataset,
  readEntry,
  readTemplate,
  serializeFragment,
  validateDocument,
  walkParagraphs,
  type FillReport,
  type GateMode,
  type GenerateResult,
  type Issue,
  type MissingPolicy,
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
  const summary = {
    file,
    bytes: bytes.length,
    sections: doc.sections.length,
    paragraphs: census.paragraphs,
    tables: census.tables,
    pictures: census.pictures,
    binaryItems: census.binaryItems,
    fields: listFields(doc).map((f) => ({
      name: f.name,
      occurrence: f.occurrence,
      shape: f.shape,
      dirty: f.dirty,
      valueLength: f.valueText.length,
      sectionIndex: f.sectionIndex,
      path: f.path,
    })),
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
  out.log(`누름틀 ${summary.fields.length}개${summary.fields.map((f) => `\n  - ${f.name}[${f.occurrence}] ${f.shape}, dirty=${f.dirty === "" ? "(없음)" : f.dirty}, 값 길이 ${f.valueLength}`).join("")}`);
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

async function fragmentImport(args: string[], out: Out): Promise<number> {
  const usage =
    "hwpx fragment import <대상> <조각.json> --section N --index I [--parent 주소] [--before] -o 출력.hwpx [--mode baseline|strict|repair] [--reissue-internal] [--report r.json] [--overwrite]";
  const p = parse(
    args,
    {
      section: { type: "string" },
      index: { type: "string" },
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
  const sectionIndex = intValue(need(p, "section", usage), "section");
  const index = intValue(need(p, "index", usage), "index");
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
  const anchor = makeLineAnchor(doc, "target", sectionIndex, [...parent, index]);
  if (anchor === undefined) throw new UsageError(`구역 ${sectionIndex}에 삽입 지점 문단 [${[...parent, index].join(", ")}]이 없습니다.`);
  // 조각 안·문서 안의 `{{}}`는 건드리지 않는다(데이터가 없으므로 누락 정책은 keep)
  const template = readTemplate({
    schema: "hwpx-studio/template@1",
    anchors: [anchor],
    rules: [{ id: "import", do: { type: "inject", anchor: "target", position: flag(p, "before") ? "before" : "after", fragment } }],
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
    "  .hwpx 전용: [--mode baseline|strict|repair] [--reissue-internal]   .md·.txt 전용: [--fill-in-code]";
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
    },
    { min: 1, max: 1 },
    usage,
  );
  const file = p.positionals[0] ?? "";
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
  const dataPath = need(p, "data", usage);
  const output = str(p, "output");
  if (output === undefined && !dryRun) throw new UsageError(`-o 출력 경로가 필요합니다(모의 실행은 --dry-run).\n사용법: ${usage}`);
  const mode = modeOf(p, usage);
  const missingText = str(p, "missing");
  if (missingText !== undefined && missingText !== "error" && missingText !== "empty" && missingText !== "keep") {
    throw new UsageError(`--missing은 error·empty·keep 가운데 하나여야 합니다: ${missingText}`);
  }
  const templatePath = str(p, "template");
  const reportPath = str(p, "report");
  const inputs = [file, dataPath, ...(templatePath === undefined ? [] : [templatePath])];
  if (output !== undefined) checkOutputPath(output, inputs, overwrite);
  if (reportPath !== undefined) checkOutputPath(reportPath, [...inputs, ...(output === undefined ? [] : [output])], overwrite);

  const dataset = guard(() => readDataset(readText(dataPath, "데이터 파일")), dataPath);
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
  if (textKind !== undefined) {
    const text = readUtf8(file, "입력 파일");
    const result = guard(() => generateText(text, textKind, template, dataset, { dryRun, fragments, fillInCode: flag(p, "fill-in-code"), ...missing }), file);
    return finishGenerate(out, result, output, allInputs, overwrite, reportPath);
  }
  const result = await runGenerate(file, readBytes(file, "입력 파일"), template, dataset, { mode, dryRun, fragments, reissueInternal: flag(p, "reissue-internal"), ...missing });
  return finishGenerate(out, result, output, allInputs, overwrite, reportPath);
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
  const usage = "hwpx compile <파일> -o 승격본 --experimental [--overwrite]";
  const p = parse(args, { output: { type: "string", short: "o" }, experimental: { type: "boolean" }, overwrite: { type: "boolean" } }, { min: 1, max: 1 }, usage);
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
    result = compileDocument(bytes);
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
  out.log(`누름틀 ${result.report.promoted}개로 승격해 저장했습니다: ${output} (${basename(output)})`);
  return 0;
}
