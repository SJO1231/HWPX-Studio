import type { EditPlan } from "../edit/plan.ts";

/** 파생할 수 있는 서식 자원 종류 */
export type FormatKind = "charPr" | "paraPr" | "borderFill";

/**
 * 서식 변경 연산. `path`는 자원 요소 아래 자식 요소의 local 이름 경로이고 빈 경로는 자원 요소 자신이다.
 * 경로를 따라갈 때 `switch`·`case`·`default`(조건 분기 요소)는 투명하게 지나간다. 같은 이름이 여러 갈래에 있으면 전부에 적용한다.
 *
 * - `setAttr`: 속성값을 정한다. 속성이나 경로 중간의 자식이 없으면 만든다. `defaultBranchValue`가 있으면 `default` 갈래 안의 대상에는 그 값을 쓴다
 *   (한컴 저장본의 여백·줄 간격은 `default` 갈래가 `case` 갈래의 2배 단위로 적혀 있다).
 * - `addChild`: `path`가 가리키는 요소에 자식을 만든다. 같은 이름의 자식이 이미 있으면 새로 만들지 않고 `attrs`만 덮어쓴다.
 * - `removeChild`: `path`가 가리키는 요소에서 그 이름의 자식을 모두 지운다(없으면 아무 일도 하지 않는다).
 * - `removeAttr`: 속성을 지운다(없으면 아무 일도 하지 않는다).
 */
export type FormatOp =
  | { op: "setAttr"; path: string[]; name: string; value: string; defaultBranchValue?: string }
  | { op: "addChild"; path: string[]; name: string; attrs?: Record<string, string> }
  | { op: "removeChild"; path: string[]; name: string }
  | { op: "removeAttr"; path: string[]; name: string };

export type FormatDelta = FormatOp[];

export type DeriveResult = {
  /** 파생 자원의 id(같은 모양이 이미 있으면 그 id) */
  id: string;
  /** 새 자원을 header 목록 끝에 추가하는 계획. 재사용이면 비어 있다. */
  plan: EditPlan;
  /** 대상 문서의 기존 자원을 재사용했는가(기준 자원 자신 포함) */
  reused: boolean;
};

/** 한 문단 안의 논리 텍스트 구간 `[start, end)`(UTF-16 단위) */
export type CharTarget = { sectionIndex: number; path: number[]; start: number; end: number };

/** 문단 주소 */
export type ParaTarget = { sectionIndex: number; path: number[] };
