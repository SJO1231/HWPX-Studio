import type { EditPlan, SpanEdit } from "../edit/plan.ts";
import type { Issue } from "../errors.ts";
import type { ValidationReport } from "../validate/index.ts";

export type RepairKind =
  | "reissueIds"
  | "fixCounts"
  | "fixSectionCount"
  | "dropStaleLineSeg"
  | "stripIllegalChars"
  | "renameBookmarks"
  | "fallbackRefs"
  | "normalizePackage";

/**
 * 보정 옵션. `reissueIds`, `fixCounts`, `dropStaleLineSeg`, `stripIllegalChars`, `renameBookmarks`는 기본으로 켜고
 * `fixSectionCount`, `fallbackRefs`, `normalizePackage`는 기본으로 끈다. `reissueIds: "all"`은 객체 id·instId가 `0`으로 겹치는 경우도 재발급한다.
 * `fixCounts`는 자원 목록의 개수 속성(`itemCnt`·`fontCnt`)만 고친다. 구역 수 선언은 `fixSectionCount`가 고치는데, 한컴은 선언한 수만큼만
 * 구역을 보여 주므로 고치면 숨어 있던 구역이 드러나 보이는 내용이 바뀐다(그래서 기본 끔).
 */
export type RepairOptions = {
  reissueIds?: boolean | "all";
  fixCounts?: boolean;
  fixSectionCount?: boolean;
  dropStaleLineSeg?: boolean;
  stripIllegalChars?: boolean;
  renameBookmarks?: boolean;
  fallbackRefs?: boolean;
  normalizePackage?: boolean;
};

export type ResolvedOptions = {
  reissueIds: false | true | "all";
  fixCounts: boolean;
  fixSectionCount: boolean;
  dropStaleLineSeg: boolean;
  stripIllegalChars: boolean;
  renameBookmarks: boolean;
  fallbackRefs: boolean;
  normalizePackage: boolean;
};

export function resolveOptions(options: RepairOptions = {}): ResolvedOptions {
  return {
    reissueIds: options.reissueIds ?? true,
    fixCounts: options.fixCounts ?? true,
    fixSectionCount: options.fixSectionCount ?? false,
    dropStaleLineSeg: options.dropStaleLineSeg ?? true,
    stripIllegalChars: options.stripIllegalChars ?? true,
    renameBookmarks: options.renameBookmarks ?? true,
    fallbackRefs: options.fallbackRefs ?? false,
    normalizePackage: options.normalizePackage ?? false,
  };
}

/**
 * 한 일 하나의 기록. 종류(`kind`)·위치(`entry`, `what`)·건수(`count`)를 담고, 문서의 글·이름 같은 값 원문은 담지 않는다.
 * `detail`에는 id 값·개수·요소 이름 같은 구조 정보만 적는다.
 */
export type RepairNote = {
  kind: RepairKind;
  /** 고친 ZIP 항목 이름 */
  entry: string;
  /** 무엇을 고쳤는가(예: `object id`, `instId`, `field id`, `paragraph id`, `itemCnt`, `secCnt`, `linesegarray`) */
  what: string;
  count: number;
  detail: string;
};

export type RepairPlan = {
  /** 구간 치환 계획. `normalizePackage`는 표현할 수 없으므로 `needsNormalize`로 따로 알린다. */
  plan: EditPlan;
  repaired: RepairNote[];
  /** 계획을 적용한 뒤에도 남는, 보정 전부터 있던 오류 */
  unrepaired: Issue[];
  /** 계획 적용 뒤 `normalizeArchive`로 패키지를 다시 배열해야 한다(`normalizePackage`를 켰고 위반이 있을 때만 참) */
  needsNormalize: boolean;
};

export type RepairResult = {
  output: Uint8Array;
  repaired: RepairNote[];
  unrepaired: Issue[];
  before: ValidationReport;
  after: ValidationReport;
};

/** 보정 종류 하나가 낸 편집·기록·경고 */
export type PlanPart = { edits: SpanEdit[]; notes: RepairNote[]; issues: Issue[] };

export function emptyPart(): PlanPart {
  return { edits: [], notes: [], issues: [] };
}
