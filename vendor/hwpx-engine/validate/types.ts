import { makeIssue, type Issue } from "../errors.ts";

/** 같은 (코드, 메시지, 위치)는 한 항목으로 합치고 `count`에 발생 횟수를 담는다. */
export type ValidationIssue = Issue & { count: number };

export type ValidationStats = {
  zipEntries: number;
  sections: number;
  manifestItems: number;
  /** 자원 ID 공간별 개수 */
  resources: Record<string, number>;
  /** 참조 속성 이름별로 대상 존재를 확인한 횟수 */
  refChecks: Record<string, number>;
  tableDepthMax: number;
  /** 자리값으로 보아 중복 오류에서 뺀 문단 id와 그 개수 */
  placeholderParagraphIdDuplicates: Record<string, number>;
};

/** 문서 안 수량. 게이트가 편집 전후의 증감을 대조하는 데 쓴다. */
export type Census = {
  /** 구역 안 모든 `p` 요소(표 셀·머리말 등 하위 목록 포함) */
  paragraphs: number;
  /** 모든 `tbl` 요소(중첩 포함) */
  tables: number;
  /** `pic` 요소 */
  pictures: number;
  /** `fieldBegin` 요소 수. 짝이 맞는지는 별도 오류(FIELD_*)로 낸다 */
  fieldPairs: number;
  /** `bookmark` 요소와 BOOKMARK 형식 `fieldBegin`의 합 */
  bookmarks: number;
  /** ZIP 안 `BinData/` 아래 파일 항목 수 */
  binaryItems: number;
  /** 모르는 컨트롤: `run/이름`, `ctrl/이름`, `t/이름`별 개수 */
  unknownControls: Record<string, number>;
};

export type ValidationReport = {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: ValidationStats;
  census: Census;
};

export type ValidateOptions = {
  /** 한컴이 받아 주는 것으로 분류한 경고(RES_DANGLING_TOLERATED, INST_DUP_PLACEHOLDER)를 오류로 올린다. */
  strict?: boolean;
};

export type BaselineComparison = {
  /** 편집 뒤에 새로 생겼거나 늘어난 오류 */
  newErrors: ValidationIssue[];
  /** 편집 전에도 있던 오류(개수는 전후 중 작은 쪽) */
  preexisting: ValidationIssue[];
  /** 편집 전에는 있었는데 없어졌거나 줄어든 오류 */
  resolved: ValidationIssue[];
};

export function emptyStats(): ValidationStats {
  return {
    zipEntries: 0,
    sections: 0,
    manifestItems: 0,
    resources: {},
    refChecks: {},
    tableDepthMax: 0,
    placeholderParagraphIdDuplicates: {},
  };
}

export function emptyCensus(): Census {
  return { paragraphs: 0, tables: 0, pictures: 0, fieldPairs: 0, bookmarks: 0, binaryItems: 0, unknownControls: {} };
}

/** 오류·경고를 모으면서 같은 내용은 합친다. */
export class IssueLog {
  errors: ValidationIssue[] = [];
  warnings: ValidationIssue[] = [];
  private seen = new Map<string, ValidationIssue>();

  private add(severity: Issue["severity"], code: string, message: string, where: string): void {
    const key = `${severity}\u0000${code}\u0000${message}\u0000${where}`;
    const old = this.seen.get(key);
    if (old !== undefined) {
      old.count++;
      return;
    }
    const issue: ValidationIssue = { ...makeIssue(severity, code, message, where === "" ? undefined : where), count: 1 };
    this.seen.set(key, issue);
    (severity === "error" ? this.errors : this.warnings).push(issue);
  }

  err(code: string, message: string, where = ""): void {
    this.add("error", code, message, where);
  }

  warn(code: string, message: string, where = ""): void {
    this.add("warning", code, message, where);
  }
}
