import { sha256Hex } from "./hash.ts";
import type { BlockContent, BlockProto, StudioCase, StudioTemplate } from "./studio-types.ts";
import type { Template } from "./types.ts";

// 정규 JSON(8.8.2): 키는 코드 포인트순 정렬, 공백·줄바꿈 없음, 배열은 순서 유지, 끝 줄바꿈 없음. 문자열로 돌려주며 UTF-8로 해시한다.

function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i]?.codePointAt(0) ?? 0;
    const q = y[i]?.codePointAt(0) ?? 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort(compareCodePoints);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 템플릿의 정규 JSON. 1판 승계 템플릿(readStudioTemplate가 돌려준 1판 Template)도 같은 규칙으로 쓴다. */
export function writeStudioTemplate(template: StudioTemplate | Template): string {
  return canonical(template);
}

export function writeCase(c: StudioCase): string {
  return canonical(c);
}

export function writeBlockProto(proto: BlockProto): string {
  return canonical(proto);
}

/** 저장 판의 식별과 case.template.sha256·원장이 쓰는 템플릿 해시: 정규 JSON의 sha256(소문자 16진 64자) */
export function templateSha256(template: StudioTemplate | Template): string {
  return sha256Hex(writeStudioTemplate(template));
}

/** 이번 건의 정규 JSON 해시 */
export function caseSha256(c: StudioCase): string {
  return sha256Hex(writeCase(c));
}

/** 블록·원형의 내용 해시: fragment이면 그 해시, text이면 글의 UTF-8 sha256 */
export function contentSha256(content: BlockContent): string {
  return "fragment" in content ? content.fragment : sha256Hex(content.text);
}
