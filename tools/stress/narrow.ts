// 결함 사례의 원인 구간을 좁힌다. 캠페인 보고서의 한 건을 같은 시드·같은 쌍으로 다시 돌려, 같은 결함 코드가 나는 가장 짧은 소스 구간을 찾는다.
//
// 실행: node tools/stress/narrow.ts --corpus <폴더> --report <report.json> --case p012-M4 [--code V-b:INST_DUP_ID:paraId]
//
// 출력은 구조만이다: 최소 구간의 문단 서수, 요소 이름·속성 이름의 목록, 검증 코드. 문서의 글·값·이름은 내지 않는다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractFragment } from "../../packages/hwpx-engine/src/index.ts";
import { compareToBaseline, validateDocument } from "../../packages/hwpx-engine/src/validate/index.ts";
import { readCorpusFile, scanCorpus } from "./corpus.ts";
import { describeDoc, type WindowPick } from "./docinfo.ts";
import { CaseStop, loadDocument, runMethod, type Loaded, type MethodName, type PairCtx } from "./methods.ts";

type Report = {
  tool: { seed: number; minParas: number; maxParas: number };
  pairs: { list: { n: number; src: string; tgt: string; third: string; window: WindowPick }[] };
  defects: { case: string; method: string; codes: string[] }[];
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

/** 따옴표 안의 값은 숫자·부호만 남기고 가린다(식별자는 구조 정보지만 글은 아니어야 한다). */
const sanitize = (message: string): string => message.replace(/'([^']*)'/g, (_m, v: string) => (/^[-\d]*$/.test(v) ? `'${v}'` : `'<${v.length}자>'`));

function main(): void {
  const corpus = arg("--corpus");
  const reportPath = arg("--report");
  const caseId = arg("--case");
  if (corpus === undefined || reportPath === undefined || caseId === undefined) throw new Error("--corpus, --report, --case가 필요하다");
  const report = JSON.parse(readFileSync(resolve(reportPath), "utf8")) as Report;
  const pairN = Number(/^p(\d+)-/.exec(caseId)?.[1]);
  const method = caseId.slice(caseId.indexOf("-") + 1) as MethodName;
  const pair = report.pairs.list.find((p) => p.n === pairN);
  const defect = report.defects.find((d) => d.case === caseId);
  if (pair === undefined) throw new Error("보고서에 그 쌍이 없다");
  const code = arg("--code") ?? defect?.codes[0];
  if (code === undefined) throw new Error("--code가 필요하다(보고서에 그 결함 건이 없다)");

  const files = new Map(scanCorpus(resolve(corpus)).map((f) => [f.id, f]));
  const make = (id: string): Loaded => {
    const f = files.get(id);
    if (f === undefined) throw new Error("모음에 그 식별자의 문서가 없다");
    const bytes = readCorpusFile(f);
    const probe = loadDocument(id, bytes, undefined as never);
    return loadDocument(id, bytes, describeDoc(probe.doc, report.tool.minParas, report.tool.maxParas));
  };
  const src = make(pair.src);
  const tgt = make(pair.tgt);
  let third: Loaded | undefined;

  const full: WindowPick = { ...(src.info.window as WindowPick), ...pair.window, full: true };
  const sub = (a: number, b: number): WindowPick => ({ ...full, from: a, to: b, len: b - a + 1 });
  const ctxOf = (win: WindowPick): PairCtx => ({
    pair: pair.n,
    seed: report.tool.seed,
    src,
    win,
    tgt,
    loadThird: () => (third ??= make(pair.third)),
  });
  const has = (m: MethodName, win: WindowPick): boolean => {
    try {
      const out = runMethod(m, ctxOf(win), true);
      return [...out.fails, ...out.inherited].some((f) => `${f.item}:${f.code}` === code);
    } catch (e) {
      if (e instanceof CaseStop) return `${e.item}:${e.code}` === code && e.kind === "defect";
      throw e;
    }
  };

  const out: Record<string, unknown> = { case: caseId, code };
  out["reproducesAtFullWindow"] = has(method, full);
  if (out["reproducesAtFullWindow"] !== true) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  // 같은 방식으로 좁히되, 쪼개기 방식은 한 번에 넣는 M1로도 재현되면 M1로 좁힌다.
  const probe: MethodName = (method === "M4" || method === "M5" || method === "M8") && has("M1", full) ? "M1" : method;
  out["probeMethod"] = probe;
  out["sourceBaselineErrors"] = Object.fromEntries([...new Set(src.baseline.errors.map((e) => e.code))].map((c) => [c, src.baseline.errors.filter((e) => e.code === c).reduce((n, e) => n + e.count, 0)]));
  out["targetBaselineErrors"] = Object.fromEntries([...new Set(tgt.baseline.errors.map((e) => e.code))].map((c) => [c, tgt.baseline.errors.filter((e) => e.code === c).reduce((n, e) => n + e.count, 0)]));

  let lo = full.from;
  let hi = full.to;
  let probes = 0;
  const test = (a: number, b: number): boolean => {
    probes++;
    return has(probe, sub(a, b));
  };
  // 1) 문단 하나로 재현되는가
  let single: number | undefined;
  for (let i = lo; i <= hi; i++) {
    if (test(i, i)) {
      single = i;
      break;
    }
  }
  if (single !== undefined) {
    lo = single;
    hi = single;
  } else {
    // 2) 앞쪽·뒤쪽을 한 문단씩 줄인다(이분으로 크게 줄인 뒤 하나씩)
    for (const step of [Math.floor((hi - lo + 1) / 2), Math.floor((hi - lo + 1) / 4), 8, 4, 2, 1]) {
      if (step < 1) continue;
      for (let changed = true; changed; ) {
        changed = false;
        if (hi - lo + 1 > step && test(lo + step, hi)) {
          lo += step;
          changed = true;
        } else if (hi - lo + 1 > step && test(lo, hi - step)) {
          hi -= step;
          changed = true;
        }
      }
    }
  }
  out["minimal"] = { from: lo, to: hi, paragraphs: hi - lo + 1, offsetInWindow: lo - full.from, probes };

  // 최소 구간의 구조: 요소 이름·속성 이름(값은 내지 않는다)
  const win = sub(lo, hi);
  const fragment = extractFragment(src.doc, { sectionIndex: win.sectionIndex, parentPath: [], from: lo, to: hi });
  const tags = new Map<string, { n: number; attrs: Set<string> }>();
  for (const m of fragment.xml.matchAll(/<([\w.:-]+)((?:\s+[\w.:-]+="[^"]*")*)\s*\/?>/g)) {
    const name = m[1] as string;
    const e = tags.get(name) ?? { n: 0, attrs: new Set<string>() };
    e.n++;
    for (const a of (m[2] ?? "").matchAll(/\s+([\w.:-]+)="/g)) e.attrs.add(a[1] as string);
    tags.set(name, e);
  }
  out["fragmentStructure"] = {
    xmlChars: fragment.xml.length,
    census: fragment.census,
    resources: Object.fromEntries([...new Set(fragment.resources.map((r) => r.kind))].map((k) => [k, fragment.resources.filter((r) => r.kind === k).length])),
    binaries: fragment.binaries.length,
    instanceIds: Object.fromEntries(["object", "inst", "fieldBegin", "fieldEndRef"].map((r) => [r, fragment.instanceIds.filter((x) => x.role === r).length])),
    bookmarks: fragment.bookmarks.length,
    issues: fragment.issues.map((i) => i.code),
    elements: Object.fromEntries([...tags].sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([k, v]) => [k, { count: v.n, attributes: [...v.attrs].sort() }])),
  };

  // 최소 구간의 검증 세부(코드와 위치 요소, 값은 가린다)
  try {
    const run = runMethod(probe, ctxOf(win), true);
    const last = run.steps[run.steps.length - 1];
    if (last !== undefined) {
      const cmp = compareToBaseline(tgt.baseline, validateDocument(last.bytes));
      out["validatorNewErrors"] = cmp.newErrors.map((e) => ({ code: e.code, count: e.count, where: sanitize(e.where ?? ""), message: sanitize(e.message) }));
    }
    out["fails"] = run.fails.map((f) => `${f.item}:${f.code}`);
    out["inherited"] = run.inherited.map((f) => `${f.item}:${f.code}`);
  } catch (e) {
    out["stop"] = e instanceof CaseStop ? `${e.kind}:${e.item}:${e.code}${e.site === "" ? "" : ` @ ${e.site}`}` : String(e);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main();
