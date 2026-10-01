import type { Issue } from "../errors.ts";

/** 같은 부모 안의 연속 문단. `parentPath`는 하위 목록의 주소(빈 배열이면 구역 최상위)이고 `from`~`to`는 포함 범위다. */
export type FragmentSelection = { sectionIndex: number; parentPath: number[]; from: number; to: number };

/** 조각 XML(또는 자원 XML) 안 참조 속성값의 구간 */
export type FragmentRef = { kind: string; lang?: string; id: string; start: number; end: number };

export type FragmentResource = {
  kind: string;
  lang?: string;
  id: string;
  /** 자원 요소의 원문 */
  xml: string;
  idSpan: { start: number; end: number };
  refs: FragmentRef[];
  fingerprint: string;
  /** 자원 원문에 쓰인(조각 밖에서 선언된) 접두사 → 네임스페이스 역할 */
  prefixes: Record<string, string>;
  /** 같은 접두사 → 선언된 URI(대상에 선언이 없을 때 더하는 데 쓴다) */
  namespaces: Record<string, string>;
  /** 스타일의 `name` 속성값 구간(스타일 이름 충돌 시 이름을 바꾸는 데 쓴다) */
  nameSpan?: { start: number; end: number };
};

export type FragmentBinary = { itemId: string; href: string; mediaType: string; sha256: string; base64: string };

/** 인스턴스 id의 종류. `paragraph`는 문단(`hp:p`)의 `id` 속성이다(개체 id와는 다른 id 공간). */
export type InstanceIdRole = "object" | "inst" | "fieldBegin" | "fieldEndRef" | "paragraph";

export type Fragment = {
  schema: "hwpx-studio/fragment@1";
  source: { sha256: string; selection: FragmentSelection };
  /** 선택한 문단들의 원문(첫 문단 시작 ~ 마지막 문단 끝) */
  xml: string;
  /** 원문에 쓰인(조각 밖에서 선언된) 접두사 → 네임스페이스 역할 */
  prefixes: Record<string, string>;
  /** 같은 접두사 → 선언된 URI(대상에 선언이 없을 때 더하는 데 쓴다) */
  namespaces: Record<string, string>;
  refs: FragmentRef[];
  /** 의존 닫힘. 참조되는 것이 먼저 온다(순환 참조는 예외) */
  resources: FragmentResource[];
  binaries: FragmentBinary[];
  instanceIds: { role: InstanceIdRole; value: string; start: number; end: number }[];
  bookmarks: { name: string; start: number; end: number }[];
  lineSegSpans: { start: number; end: number }[];
  /** 조각 안 모든 문단의 논리 텍스트(문서 순서) */
  texts: string[];
  /** 조각 안 모든 서식 참조의 지문(문서 순서) */
  prints: string[];
  /** 가져올 때 계획이 예고하는 수량의 근거: 조각 안 문단·표·그림·누름틀·책갈피의 수 */
  census: { paragraphs: number; tables: number; pictures: number; fields: number; bookmarks: number };
  /** 추출하면서 남긴 경고(FRAG_DANGLING_SOURCE 등) */
  issues: Issue[];
};

export type InsertPoint = {
  sectionIndex: number;
  /** 삽입 지점 문단이 든 하위 목록의 주소(빈 배열이면 구역 최상위) */
  parentPath: number[];
  /** 그 목록 안 삽입 지점 문단의 서수 */
  index: number;
  position: "before" | "after";
};
