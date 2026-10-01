import { HwpxError } from "../errors.ts";
import { readArchive, type Archive } from "../package/zip-read.ts";
import { attrValue } from "../xml/tree.ts";
import { checkPackage, HEADER_ENTRY, parseEntry, PREVIEW_TEXT_ENTRY, type Ctx } from "./package.ts";
import { checkRefs, collectResources, emptySpaces } from "./resources.ts";
import { checkInstances, newAcc, scanSectionBody } from "./structure.ts";
import {
  emptyCensus,
  emptyStats,
  IssueLog,
  type Census,
  type ValidateOptions,
  type ValidationReport,
  type ValidationStats,
} from "./types.ts";

const NOT_A_ZIP = new Set(["PKG_NOT_ZIP", "PKG_IS_HWP5", "PKG_TRUNCATED"]);

function openArchive(bytes: Uint8Array, log: IssueLog): Archive | null {
  try {
    return readArchive(bytes);
  } catch (e) {
    if (!(e instanceof HwpxError)) throw e;
    // 기존 검사기는 ZIP이 아니거나 잘린 파일을 PKG_NOT_ZIP으로 낸다. 엔진이 사유별 코드를 따로 갖는 경우 그 코드도 더한다.
    // 이름 중복·암호화·ZIP64·한도 초과처럼 기존 검사기가 열어 주는 구조는 엔진 코드만 낸다.
    if (NOT_A_ZIP.has(e.code)) log.err("PKG_NOT_ZIP", `ZIP 으로 열 수 없음: ${e.message}`, e.where);
    if (e.code !== "PKG_NOT_ZIP") log.err(e.code, e.message, e.where);
    return null;
  }
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function run(bytes: Uint8Array, strict: boolean, log: IssueLog, stats: ValidationStats, census: Census): void {
  const archive = openArchive(bytes, log);
  if (archive === null) return;
  const ctx: Ctx = { bytes, archive, log, xmlBytes: new Map(), xml: new Map() };
  stats.zipEntries = archive.entries.length;
  census.binaryItems = archive.entries.filter((e) => !e.isDirectory && e.name.startsWith("BinData/")).length;

  const pkg = checkPackage(ctx);
  if (pkg === null) return;
  const { sections, manifest } = pkg;
  stats.sections = sections.length;
  stats.manifestItems = manifest.size;

  const header = parseEntry(ctx, HEADER_ENTRY);
  const idSpaces = header === null ? emptySpaces() : collectResources(header.root, log);
  const manifestIds = new Set(manifest.keys());
  const counters = new Map<string, number>();
  const acc = newAcc();
  if (header !== null) checkRefs(header.root, HEADER_ENTRY, idSpaces, manifestIds, log, counters, strict);
  for (const s of sections) {
    const parsed = parseEntry(ctx, s);
    if (parsed === null) continue;
    checkRefs(parsed.root, s, idSpaces, manifestIds, log, counters, strict);
    scanSectionBody(parsed.root, s, log, acc);
  }
  checkInstances(acc, log, strict);

  if (header !== null) {
    const declared = attrValue(header.root, "secCnt");
    if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) !== sections.length) {
      log.warn("PKG_SECCNT", `header secCnt(${declared}) 와 section 파일 수(${sections.length}) 불일치`);
      log.err("PKG_SECCNT_MISMATCH", `header 의 구역 수 선언(secCnt=${declared}) 과 실제 구역 항목 수(${sections.length}) 가 다름`);
    }
  }
  if (!archive.entries.some((e) => e.name === PREVIEW_TEXT_ENTRY)) {
    log.warn("PKG_NO_PREVIEW_TEXT", `미리보기 텍스트 항목(${PREVIEW_TEXT_ENTRY}) 없음`);
  }

  stats.resources = sortedRecord(new Map([...idSpaces.spaces].map(([k, v]) => [k, v.size])));
  stats.refChecks = sortedRecord(counters);
  stats.tableDepthMax = acc.tableDepthMax;
  stats.placeholderParagraphIdDuplicates = acc.placeholderParaIdDups;
  census.paragraphs = acc.paragraphs;
  census.tables = acc.tables;
  census.pictures = acc.pictures;
  census.fieldPairs = acc.fieldBegin.length;
  census.bookmarks = acc.bookmarks.length;
  census.unknownControls = sortedRecord(acc.unknown);
}

/**
 * 패키지·자원·인스턴스·구조를 검사해 보고서로 돌려준다. 입력이 깨져 있어도 예외를 던지지 않고 보고서의 오류로 낸다.
 * 모델(parseDocument)을 거치지 않고 패키지·XML 계층만 쓰므로 모델 파싱이 실패하는 문서도 검사한다.
 */
export function validateDocument(bytes: Uint8Array, options: ValidateOptions = {}): ValidationReport {
  const log = new IssueLog();
  const stats = emptyStats();
  const census = emptyCensus();
  try {
    run(bytes, options.strict === true, log, stats, census);
  } catch (e) {
    log.err("VAL_INTERNAL", `검사 중 예기치 않은 오류: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { errors: log.errors, warnings: log.warnings, stats, census };
}
