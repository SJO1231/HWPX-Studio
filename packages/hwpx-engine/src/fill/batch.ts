import { HwpxError } from "../errors.ts";
import type { BatchRecord } from "../template/read.ts";
import { lookupPath } from "../template/value.ts";
import { generate, type GenerateOptions } from "./gate.ts";

/** 파일 이름 앞부분의 최대 길이(코드 포인트 수). 긴 값이 경로 길이 한도를 넘기지 않게 한다. */
const MAX_STEM = 100;

/** 사용자가 문서를 가리킬 수 없을 때(이름이 비었을 때) 쓰는 이름 */
const UNNAMED = "문서";

/** 파일 이름으로 쓸 수 없는 문자: 제어 문자와 `< > : " / \ | ? *`(경로 구분자 포함) */
const FORBIDDEN = /[\u0000-\u001F<>:"/\\|?*]/g;

/** Windows가 장치 이름으로 보는 이름(확장자가 붙어도 장치다) */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 값 하나를 파일 이름의 앞부분(확장자 없는 이름)으로 바꾼다. 쓸 수 없는 문자와 경로 구분자는 `_`로, 앞뒤 공백과 뒤쪽의 `.`은 뗀다.
 * 길이는 코드 포인트 100개까지, Windows 장치 이름(`con`, `nul`, `com1` 등)에는 `_`를 붙인다. 쓸 만한 글이 남지 않으면 빈 글이다.
 */
export function safeFileStem(value: string): string {
  let stem = value.replace(FORBIDDEN, "_").trim().replace(/[. ]+$/, "");
  const points = Array.from(stem);
  if (points.length > MAX_STEM) stem = points.slice(0, MAX_STEM).join("").replace(/[. ]+$/, "");
  return RESERVED.test(stem) ? `${stem}_` : stem;
}

/**
 * 브라우저·사용자가 준 임의의 파일 이름 문자열을 안전한 이름 앞부분으로 만든다(결과 파일 이름은 이 앞에 확장자 `.hwpx`를 붙여 쓴다).
 * 폴더 부분(`/`·`\`로 나뉜 앞쪽)과 끝의 `.hwpx`(대소문자 무시)를 떼고 `safeFileStem`을 거친다. 비면 `문서`다. 경로를 벗어나는 글(`..` 등)은 남지 않는다.
 */
export function sanitizeFileStem(input: string): string {
  const last = input.split(/[\\/]/).pop() ?? "";
  return safeFileStem(last.replace(/\.hwpx$/i, "")) || UNNAMED;
}

/**
 * 여러 건 생성의 결과 파일 이름(`.hwpx` 포함)을 건 순서대로 정한다. 기본은 `<baseName>-<번호 3자리>.hwpx`(번호는 1부터, `baseName`은 `sanitizeFileStem`을 거친다).
 * `nameFrom`(데이터 경로)을 주면 그 건의 값(문자열·숫자)을 쓰되 `safeFileStem`을 거치고, 값이 없거나 비면 기본 이름을 쓴다.
 * 같은 이름(대소문자 무시)이 이미 나왔으면 뒤에 `-2`, `-3`…을 붙인다. 데이터만 보고 정하므로 생성이 실패한 건도 이름이 있다.
 */
export function planBatchNames(records: readonly BatchRecord[], baseName: string, nameFrom?: string): string[] {
  const used = new Set<string>();
  const base = sanitizeFileStem(baseName);
  return records.map((record, i) => {
    const numbered = `${base}-${String(i + 1).padStart(3, "0")}`;
    let stem = numbered;
    if (nameFrom !== undefined && "dataset" in record) {
      const found = lookupPath(record.dataset, nameFrom);
      const value = found.found && (typeof found.value === "string" || typeof found.value === "number") ? String(found.value) : "";
      stem = safeFileStem(value) || numbered;
    }
    let candidate = stem;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}`;
    used.add(candidate.toLowerCase());
    return `${candidate}.hwpx`;
  });
}

export type BatchOptions = GenerateOptions & {
  /** 원본 이름(확장자 없이). 기본 파일 이름 `<baseName>-<번호>.hwpx`의 앞부분이다. */
  baseName: string;
  /** 파일 이름을 정할 값의 데이터 경로. 없으면 번호로 정한다. */
  nameFrom?: string;
};

/** 한 건의 결과. 값 원문은 담지 않는다(오류 메시지도 경로·코드·길이만 쓴다). */
export type BatchItem = {
  /** 건 번호(1부터) */
  index: number;
  /** 결과 파일 이름(`.hwpx` 포함). 실패한 건도 정해 둔다. */
  name: string;
  ok: boolean;
  /** 만든 문서. 성공했고 모의 실행이 아닐 때만 있다. */
  output?: Uint8Array;
  /** 채운 자리 수: 채움(`fill`) 액션이 바꾼 자리의 합(템플릿의 채움 규칙, 문서 안 `{{}}`의 암묵 채움, 누름틀의 암묵 채움). 실패한 건은 0이다. */
  filled: number;
  /** 건너뛴 자리 */
  skipped: { code: string; anchor: string; message: string }[];
  /** 실패한 건의 오류 코드(중복 없이, 처음 나온 순서) */
  errorCodes: string[];
  /** 실패한 건의 오류(코드와 메시지) */
  errors: { code: string; message: string }[];
};

/**
 * 건마다 `generate`를 부르는 얇은 반복이다. 한 건이 실패해도(데이터 오류·게이트 실패) 나머지를 계속하고, 건마다 `BatchItem`을 하나씩 내놓는다
 * (만든 문서를 모두 쥐고 있지 않도록 제너레이터로 둔다). 입력 문서를 열 수 없는 문제는 건의 실패가 아니라 건마다 같은 `HwpxError`로 나온다.
 * 같은 입력이면 같은 결과 바이트·같은 이름이다.
 */
export function* generateBatch(bytes: Uint8Array, template: Parameters<typeof generate>[1], records: readonly BatchRecord[], options: BatchOptions): Generator<BatchItem> {
  const { baseName, nameFrom, ...generateOptions } = options;
  const names = planBatchNames(records, baseName, nameFrom);
  for (const [i, record] of records.entries()) {
    const base = { index: i + 1, name: names[i] ?? "", filled: 0, skipped: [] };
    if ("error" in record) {
      yield { ...base, ok: false, errorCodes: [record.error.code], errors: [record.error] };
      continue;
    }
    let result: ReturnType<typeof generate>;
    try {
      result = generate(bytes, template, record.dataset, generateOptions);
    } catch (e) {
      if (!(e instanceof HwpxError)) throw e;
      yield { ...base, ok: false, errorCodes: [e.code], errors: [{ code: e.code, message: e.message }] };
      continue;
    }
    const plan = result.report.plan;
    const skipped = plan.skipped.map((s) => ({ code: s.code, anchor: s.anchor, message: s.message }));
    if (result.ok) {
      const filled = plan.actions.filter((a) => a.type === "fill").reduce((n, a) => n + a.targets, 0);
      yield { ...base, ok: true, ...(result.dryRun ? {} : { output: result.output }), filled, skipped, errorCodes: [], errors: [] };
    } else {
      const errors = result.report.issues.filter((x) => x.severity === "error").map((x) => ({ code: x.code, message: x.message }));
      yield { ...base, ok: false, skipped, errorCodes: [...new Set(errors.map((x) => x.code))], errors };
    }
  }
}
