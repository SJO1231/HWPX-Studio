// 빠른 생성 화면과 서버가 주고받는 JSON의 형. 형만 있는 파일이라 브라우저 코드가 `import type`으로 가져온다(엔진을 값으로 가져오지 않는다).
// 값 원문(데이터의 값, 문서의 글 일부 제외)은 어느 응답에도 넣지 않는다. 키 이름과 개수만 나간다.

/** `{ error: { code, message, plain } }`: `message`는 기술적인 설명, `plain`은 쉬운 말 한 문장이다. 서버 껍데기의 거절(Host·Origin·크기)에도 `plain`이 있다. */
export type StudioError = { error: { code: string; message: string; plain?: string } };

export type MissingPolicy = "error" | "empty" | "keep";

// ── POST /api/quick/template ─────────────────────────────────────

/** 후보 종류: 라벨 옆 빈 칸(`emptyCell`), `라벨:` 뒤가 빈 문단(`labelColon`), `(   )`·`____`·`□` 표시(`blankMark`). 표시만 하고 채우지 않는다. */
export type CandidateKind = "emptyCell" | "labelColon" | "blankMark";

/**
 * 엔진이 값을 넣을 수 없는 누름틀의 모양: `crossParagraph` 시작과 끝이 서로 다른 문단에 있음, `inline` 시작과 끝 사이에 줄바꿈·탭·그림·표 같은 것이 끼어 있음
 * (줄바꿈이 든 값으로 한 번 채운 누름틀도 해당), `unpaired` 끝 표식이 없음. 엔진은 이런 누름틀을 `FIELD_UNSUPPORTED_SHAPE`로 건너뛴다.
 */
export type UnfillableShape = "crossParagraph" | "inline" | "unpaired";

export type PlacesView = {
  /**
   * 누름틀(type이 `CLICK_HERE`인 것만. 책갈피 같은 다른 종류의 필드는 넣지 않는다) 이름별 정보.
   * `count`는 그 이름의 곳 수, `usable`이 거짓이면 이름이 데이터 키로 쓸 수 없는 글자(공백·점 등)를 가져 채우지 않는다.
   * `fillable`은 그 가운데 엔진이 채울 수 있는 모양(`simple`·`empty`)인 곳 수, `unfillable`은 나머지를 모양별로 센 것이다(0인 모양은 없다).
   * `count`는 `fillable`과 `unfillable`의 합이다.
   */
  fields: { name: string; count: number; usable: boolean; fillable: number; unfillable: { shape: UnfillableShape; count: number }[] }[];
  /** `{{키}}`별 곳 수 */
  placeholders: { key: string; count: number }[];
  /** 후보 자리(표시만). 많으면 앞의 200개 */
  candidates: { kind: CandidateKind; evidence: string }[];
  candidatesTruncated: boolean;
};

export type TemplateResponse = {
  session: string;
  /** 올린 원본 이름. 결과 파일 이름의 앞부분이 된다 */
  name: string;
  bytes: number;
  places: PlacesView;
};

// ── POST /api/quick/data ─────────────────────────────────────────

/** `object` 객체 하나, `array` 객체 배열, `bundle` 묶음 형식(`data`가 객체), `bundleArray` 묶음 형식(`data`가 배열) */
export type DataForm = "object" | "array" | "bundle" | "bundleArray";

export type DataKey = {
  /** 점으로 이은 경로(`applicant.name`) */
  path: string;
  type: "string" | "number" | "boolean" | "null" | "object" | "array";
  /** 이 키가 있는 건수 */
  records: number;
  /** 자리에 연결할 수 있는 이름인가(공백·점·괄호가 든 키는 거짓) */
  usable: boolean;
};

/**
 * 자리별 판정: `ok` 데이터 있음(값에 줄바꿈·탭이 있어도 엔진이 그대로 넣으므로 `ok`이고 `Match.multiline`으로만 알린다), `missing` 없음(또는 null),
 * `notScalar` 객체·배열이라 못 넣음, `rejected` 값에 넣을 수 없는 문자(XML 금지 제어 문자 등, 엔진의 값 검사가 거절),
 * `badKey` 이름이 데이터 경로로 쓸 수 없는 꼴이라 엔진이 채우지 않는 누름틀,
 * `unfillable` 이름은 쓸 수 있지만 그 이름의 곳이 전부 엔진이 채울 수 없는 모양(`PlacesView.fields[].fillable`이 0)인 누름틀
 */
export type MatchState = "ok" | "missing" | "notScalar" | "rejected" | "badKey" | "unfillable";

export type Match = {
  kind: "field" | "placeholder";
  key: string;
  /**
   * 모든 건이 `ok`이면 `ok`, 아니면 `ok`가 아닌 첫 건의 판정. 객체가 아닌 건(`DataResponse.invalidRecords`)은 판정하지 않는다.
   * 판정할 건이 하나도 없으면 `missing`이다
   */
  state: MatchState;
  /** 건수별 판정(`badKey`·`unfillable`이면 건수가 없다. 객체가 아닌 건은 어느 칸에도 들어가지 않는다) */
  counts: { ok: number; missing: number; notScalar: number; rejected: number };
  /** `rejected`일 때 엔진의 사유(예: `U+0001`). 값 원문은 아니다 */
  reason?: string;
  /** `ok`인 건 가운데 값에 줄바꿈·탭이 든 건수(정보. 엔진이 줄바꿈 요소·탭 요소로 넣는다) */
  multiline: number;
};

export type DataResponse = {
  session: string;
  form: DataForm;
  /** 만들 건수(객체가 아닌 건 포함) */
  records: number;
  /** 건 가운데 객체가 아니어서 만들 때 실패하는 건수(`DATA_SCHEMA`). 대조표의 건수에는 들어가지 않는다 */
  invalidRecords: number;
  keys: DataKey[];
  /** 키가 많아 앞의 1000개만 줬다 */
  keysTruncated: boolean;
  matches: Match[];
};

// ── POST /api/quick/generate ─────────────────────────────────────

/** 건별 보고의 한 줄. `plain`은 쉬운 말, `detail`은 엔진의 기술적 설명(오류는 앞에 자리 이름이 붙어 있다), `place`는 어느 자리인지(알 때만) */
export type ReportEntry = { code: string; plain: string; place?: string; detail?: string };

export type ResultView = {
  /** 건 번호(0부터). 내려받기 주소의 `:index` */
  index: number;
  /** 결과 파일 이름(`<원본 이름>-<번호 3자리>.hwpx`). 실패한 건도 이 이름이 될 파일이다 */
  name: string;
  ok: boolean;
  /** 채운 자리 수 */
  filled: number;
  /** 엔진이 건너뛴 자리와 사유(예: `FIELD_NAME_NOT_PATH`, `FILL_MIXED_FORMAT`) */
  skipped: ReportEntry[];
  errors: ReportEntry[];
  /** 정보(실패·건너뜀이 아니다): 줄바꿈·탭이 든 값이 들어간 자리(`QUICK_MULTILINE`). 성공한 건에만 있다 */
  notes: ReportEntry[];
};

export type GenerateResponse = {
  session: string;
  results: ResultView[];
  /** 결과를 저장한 폴더(작업 공간의 `out/<날짜-시각>`). 저장하지 못했으면 null이고 `saveError`가 사유다 */
  folder: string | null;
  saveError?: { code: string; message: string; plain: string };
};
