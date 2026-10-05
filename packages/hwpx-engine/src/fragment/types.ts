import type { EditPlan } from "../edit/plan.ts";
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
  /** `hp:required-namespace` 값으로 가리키는 URI의 원본 접두사 → URI(조각 밖에서 선언된 것). 없으면 키가 없다(이전 형식 조각도). 명세 7.66 */
  valueNamespaces?: Record<string, string>;
  /** 스타일의 `name` 속성값 구간(스타일 이름 충돌 시 이름을 바꾸는 데 쓴다) */
  nameSpan?: { start: number; end: number };
};

export type FragmentBinary = { itemId: string; href: string; mediaType: string; sha256: string; base64: string };

/** 인스턴스 id의 종류. `paragraph`는 문단(`hp:p`)의 `id` 속성이다(개체 id와는 다른 id 공간). */
export type InstanceIdRole = "object" | "inst" | "fieldBegin" | "fieldEndRef" | "paragraph";

/** 소스에서 이미 없는 대상을 가리키던 참조(FRAG_DANGLING_SOURCE)의 종류·id별 개수. 글꼴은 언어를 구분하지 않는다. */
export type FragmentDangling = { kind: string; id: string; count: number };

export type Fragment = {
  schema: "hwpx-studio/fragment@1";
  /** `xmlVersion`은 원본 `version.xml`의 형식 버전(예: "1.5"). 없는 원본·이전 형식 조각에는 없다(알 수 없음). */
  source: { sha256: string; selection: FragmentSelection; xmlVersion?: string };
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
  /** 소스에서 이미 없는 대상을 가리키던 참조의 구조화된 기록(`issues`의 FRAG_DANGLING_SOURCE와 짝이다). 이전 형식 조각은 빈 목록으로 읽는다. */
  dangling: FragmentDangling[];
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

/** `planImport`의 선택 사항 */
export type ImportOptions = {
  /** 조각 안에서 겹치는 문단 id(자리값 제외)·객체 id·instId·누름틀 시작 id를 첫 등장만 두고 새 값으로 바꾼다. 기본 끔(소스 원문 그대로). */
  reissueInternalDuplicates?: boolean;
};

/** 조각 안에서만 겹치는 id(가져온 뒤에도 남는 것). `count`는 조각 안에서 그 값이 나오는 횟수다. */
export type InheritedDuplicate = { role: Exclude<InstanceIdRole, "fieldEndRef">; value: string; count: number };

/**
 * 조각이 소스에서부터 갖고 있던 문제. 대상과 부딪쳐 재발급한 id는 담지 않는다.
 * 저장 게이트가 이것으로 설명되는 검사 오류를 대상의 새 오류로 세지 않는다.
 */
export type InheritedProblems = { duplicateIds: InheritedDuplicate[]; danglingRefs: FragmentDangling[] };

/** `planImport`의 계획: 편집 계획에 상속한 문제의 기록을 더한 것 */
export type ImportPlan = EditPlan & { inherited: InheritedProblems };
