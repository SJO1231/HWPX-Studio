import { parseArgs } from "node:util";
import { UsageError } from "./io.ts";

export type Parsed = {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
};

type OptionSpec = Record<string, { type: "string" | "boolean"; short?: string }>;

/** `node:util`의 `parseArgs`로 읽고, 알 수 없는 옵션·값 누락은 사용법 오류로 올린다. */
export function parse(args: string[], options: OptionSpec, positionals: { min: number; max: number }, usage: string): Parsed {
  let result;
  try {
    result = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(`${e instanceof Error ? e.message : String(e)}\n사용법: ${usage}`);
  }
  const values = result.values as Parsed["values"];
  const given = result.positionals;
  if (given.length < positionals.min || given.length > positionals.max) {
    throw new UsageError(`인자 개수가 맞지 않습니다.\n사용법: ${usage}`);
  }
  return { values, positionals: given };
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.values[name];
  return typeof v === "string" ? v : undefined;
}

export function need(p: Parsed, name: string, usage: string): string {
  const v = str(p, name);
  if (v === undefined) throw new UsageError(`--${name}이(가) 필요합니다.\n사용법: ${usage}`);
  return v;
}

export const flag = (p: Parsed, name: string): boolean => p.values[name] === true;

export function intValue(text: string, name: string): number {
  if (!/^\d+$/.test(text)) throw new UsageError(`--${name}은(는) 0 이상의 정수여야 합니다: ${text}`);
  return Number(text);
}

/** 하위 목록 주소 `4.3`·`4,3`(문단 서수, 하위목록 서수의 짝) → [4, 3]. */
export function parseAddress(text: string): number[] {
  const parts = text.split(/[.,]/).filter((x) => x !== "");
  if (parts.length === 0 || parts.length % 2 !== 0 || !parts.every((x) => /^\d+$/.test(x))) {
    throw new UsageError(`--parent는 [문단, 하위목록] 짝으로 이뤄진 주소여야 합니다(예: 4.0): ${text}`);
  }
  return parts.map(Number);
}
