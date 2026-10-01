# 엔진 명세 (1차 슬라이스)

- 작성일: 2026-10-01
- 이 문서가 소유하는 주제: `packages/hwpx-engine`과 `apps/cli`의 계약(자료 구조, 함수 경계, 오류 코드, 수용 조건)
- 소유하지 않는 주제: 결정의 근거는 [아키텍처 리뷰](architecture-review.md), 저장 게이트 정책과 시나리오는 [검증 기준](validation.md), 단계 순서는 [진행 방향](roadmap.md)
- 문서 성격: 총괄의 임시 선택이다. 구현 중 명세와 실제가 충돌하면 구현을 멈추고 보고한다.

## 0. 공통 원칙

1. **자체 구현.** 참고 프로젝트의 코드·함수명·변수명·상수명·주석·파일 구조를 가져오지 않는다. 이 명세가 정한 이름만 쓴다. 런타임 의존성은 0개다(Node 내장 `node:zlib`, `node:crypto`만).
2. **엔진은 파일시스템을 모른다.** 입력과 출력은 `Uint8Array`다. 파일 읽기·쓰기는 `apps/cli`에만 있다.
3. **파서와 작성기를 분리한다.** 작성기는 편집 목록(구간 치환)만 받는다.
4. **수정하지 않은 바이트는 그대로 둔다.** XML을 DOM으로 다시 직렬화하지 않는다. 변경은 원본 문자열의 구간 치환으로만 한다.
5. **모르는 요소를 지우지 않는다.** 해석하지 못하는 요소·속성은 원문 구간으로 보존한다.
6. **오류를 삼키지 않는다.** 모든 실패는 `HwpxError`(코드 포함)로 올린다. 경고는 `Issue` 목록으로 돌려준다.
7. TypeScript strict. Node 24의 타입 제거 실행을 쓰므로 `enum`, `namespace`, 생성자 매개변수 속성을 쓰지 않는다. 상대 import는 `.ts` 확장자를 붙인다.

## 1. 저장소 구조

```
package.json            private, workspaces ["packages/*", "apps/*"], scripts: typecheck, test
tsconfig.base.json      strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, erasableSyntaxOnly,
                        verbatimModuleSyntax, module nodenext, allowImportingTsExtensions, noEmit
packages/hwpx-engine/   이름 @hwpx-studio/engine
  src/errors.ts         HwpxError, Issue
  src/package/          ZIP 읽기·쓰기, HWPX 패키지 열기
  src/xml/              토크나이저, 요소 트리, 문자 처리
  src/model/            문서 모델(자원·본문·주소·논리 텍스트)
  src/store/            모델의 JSON 내보내기
  src/fragment/         조각 추출·가져오기 (S2)
  src/template/         템플릿·데이터 묶음·값 해석 (S3)
  src/fill/             편집 계획·적용·저장 게이트 (S3)
  src/validate/         검사기·기준선·구조 비교 (S3)
  src/index.ts          공개 API
  test/                 *.test.ts, fixtures/
apps/cli/               이름 @hwpx-studio/cli, bin "hwpx"
tools/oracle/           검증용 보조 스크립트(선택 실행)
docs/
```

- 테스트: `node --test "packages/*/test/**/*.test.ts" "apps/*/test/**/*.test.ts"`. 형 검사: `tsc --noEmit`.
- devDependencies는 `typescript`, `@types/node`뿐이다.

## 2. 오류와 경고

```ts
class HwpxError extends Error { code: string; where?: string }
type Issue = { severity: "error" | "warning"; code: string; message: string; where?: string }
```

코드는 `영역_내용` 형식의 대문자다. 영역: `PKG`(패키지·ZIP), `XML`, `MODEL`, `FRAG`, `TPL`(템플릿), `DATA`, `FILL`, `VAL`(검사), `DIFF`.

## 3. S1 — 패키지 (`src/package/`)

### 3.1 ZIP 읽기 `readArchive(bytes): Archive`

- 끝에서부터 EOCD를 찾고, 중앙 디렉터리(CD)를 읽고, 각 항목의 로컬 레코드 위치를 구한다.
- `Archive = { entries: ArchiveEntry[], cdStart, cdSize, eocdStart, comment }`
- `ArchiveEntry = { name, method(0|8), flags, crc32, compressedSize, size, localStart, localEnd, dataStart, isDirectory, cdRecord: {start,end} }`
  - `localEnd`는 다음 레코드의 시작(또는 CD 시작)이다. 데이터 설명자(data descriptor)가 있으면 그 범위에 포함된다.
- `readEntry(archive, bytes, name): Uint8Array`는 압축을 풀고 CRC32를 검사한다.
- 거부(각각 고유 코드): ZIP이 아님 `PKG_NOT_ZIP`(OLE2 서명 `D0 CF 11 E0`이면 `PKG_IS_HWP5`), ZIP64 `PKG_ZIP64`, 암호화 플래그 `PKG_ENCRYPTED`, 여러 디스크 `PKG_MULTI_DISK`, 지원하지 않는 압축 방식 `PKG_METHOD`, CRC 불일치 `PKG_CRC`, 잘린 파일·범위 밖 오프셋 `PKG_TRUNCATED`, 이름 중복 `PKG_DUP_ENTRY`.
- 한도(입력 방어, 넘으면 `PKG_LIMIT`): 항목 4,096개, 항목당 풀린 크기 256MiB, 전체 풀린 크기 1GiB, 1MiB를 넘는 항목의 압축률 500:1. 한도는 CD의 선언값으로 먼저 판정한다.

### 3.2 ZIP 쓰기 `rewriteArchive(bytes, archive, changes): Uint8Array`

- `changes = { replace: Map<name, Uint8Array>, add: { name, data, method }[] }`
- 바꾸지 않는 항목은 로컬 레코드(`localStart`~`localEnd`)를 **원본 바이트 그대로** 복사한다. 순서도 원본 그대로다.
- 바꾸는 항목은 원본 로컬 헤더를 복사한 뒤 CRC32·크기만 고치고, 원본과 같은 압축 방식으로 다시 압축한다. 데이터 설명자 비트(bit 3)는 끄고 크기를 헤더에 쓴다.
- 추가 항목은 기존 로컬 레코드 뒤, CD 앞에 붙인다. 이름은 UTF-8 플래그를 켠다. 시각은 고정값(1980-01-01)이다.
- CD 레코드는 원본 바이트를 복사하고 CRC32·크기·로컬 오프셋만 고친다. EOCD는 CD 위치·크기·항목 수만 고친다.
- `mimetype`은 바꾸거나 추가할 수 없다(`PKG_MIMETYPE_LOCKED`).
- **빈 변경(`replace`·`add` 모두 없음)의 결과는 입력과 바이트 동일해야 한다.**

### 3.3 패키지 열기 `openPackage(bytes): HwpxPackage`

- `mimetype`이 첫 항목인지, 무압축인지, 내용이 `application/hwp+zip`인지 확인한다. 어긋나면 열기는 하되 `Issue`(경고)로 남긴다(실제 한컴 문서에 위반 사례가 있다).
- `META-INF/container.xml`의 rootfile → `Contents/content.hpf`의 manifest·spine을 읽어 `headerEntry`, `sectionEntries[]`(spine 순서)를 정한다. spine에 없는 `Contents/section<N>.xml`이 있으면 번호순(숫자 비교)으로 뒤에 붙이고 경고한다.
- 필수 항목이 없으면 `PKG_MISSING`.
- XML 항목은 UTF-8(치명 모드)로 해독한다. 실패하면 `XML_ENCODING`. BOM은 보존한다.
- `HwpxPackage = { archive, bytes, headerEntry, sectionEntries, manifestItems[{id, href, mediaType}], binaryEntries[], issues }`

## 4. S1 — XML (`src/xml/`)

### 4.1 토크나이저 `tokenize(text): Token[]`

- 토큰은 입력을 빈틈없이 덮는다. 모든 토큰의 원문을 이어 붙이면 입력과 같다.
- `Token = { kind, start, end, name?, attrs? }`
  - `kind`: `bom | decl | pi | comment | cdata | start | end | empty | text`
  - 위치는 해독한 문자열의 UTF-16 오프셋이다.
  - `attrs = { qname, value(해독값), nameStart, valueStart, valueEnd }[]` (`valueStart`~`valueEnd`는 따옴표 안쪽 원문 구간)
- 정형성 검사: 태그 짝, 루트 하나, 속성 중복 없음, 올바른 엔티티 참조, 속성값 안에 `<` 없음. 위반은 `XML_MALFORMED`(줄·열 포함).
- DOCTYPE은 거부한다 `XML_DOCTYPE`. 선언된 인코딩이 UTF-8이 아니면 `XML_ENCODING`.

### 4.2 요소 트리 `buildTree(text, tokens): XElement`

- `XElement = { qname, prefix, local, ns(해석된 URI), attrs, start(여는 태그 시작), openEnd, closeStart, end, children: (XElement | XText)[], parent }`
- `XText = { start, end, raw, value(엔티티 해독) }`
- 네임스페이스는 선언 범위를 따라 해석한다. 요소 비교는 **(네임스페이스 역할, local 이름)**으로 한다. 접두사로 비교하지 않는다.
- HWPX 네임스페이스 역할: `paragraph`, `section`, `head`, `core` 등. 2011 계열(`http://www.hancom.co.kr/hwpml/2011/<역할>`), 2016 확장, 2024 계열(`http://www.owpml.org/owpml/2024/<역할>`)에서 같은 역할이면 같은 것으로 본다.

### 4.3 문자 처리

- `decodeEntities(raw)`: `&lt; &gt; &amp; &quot; &apos;`, 숫자 참조.
- `escapeText(value)`: `&`, `<`, `>`만 바꾼다. `escapeAttr(value)`: 추가로 `"`.
- XML 1.0에서 허용하지 않는 문자가 값에 있으면 `XML_ILLEGAL_CHAR`.

## 5. S1 — 문서 모델 (`src/model/`)

### 5.1 원칙

모델은 **무손실 요소 트리 + 의미 색인**이다. 서식 정보는 하나도 버리지 않는다. 해석한 것은 색인으로, 해석하지 못한 것은 트리의 원문 구간으로 남는다.

### 5.2 `parseDocument(pkg): HwpxDocument`

```ts
type HwpxDocument = {
  pkg: HwpxPackage
  header: HeaderModel
  sections: SectionModel[]
  issues: Issue[]
}
```

**HeaderModel** — `Contents/header.xml`

- `text`, `root: XElement`
- `resources`: 자원 종류별 목록
  - 종류: `font`(언어별: HANGUL, LATIN, HANJA, JAPANESE, OTHER, SYMBOL, USER), `borderFill`, `charPr`, `tabPr`, `numbering`, `bullet`, `paraPr`, `style`, 그리고 refList 안의 그 밖 목록은 `other:<local 이름>`
  - `ResourceItem = { kind, lang?, id, element: XElement, refs: ResourceRef[] }`
  - `ResourceRef = { kind, lang?, id, attr 위치 }` — 이 자원이 가리키는 다른 자원
    - charPr → font(언어별 `fontRef`), borderFill(`borderFillIDRef`)
    - paraPr → tabPr(`tabPrIDRef`), numbering 또는 bullet(`heading`의 `idRef`, `type`에 따라. `OUTLINE`·`NONE`은 참조 아님), borderFill(`border`의 `borderFillIDRef`)
    - style → charPr, paraPr, style(`nextStyleIDRef`)
- `counts`: 각 목록 요소의 `itemCnt` 속성 위치와 값(자원 추가 시 고친다)
- `secCnt` 속성 위치와 값

**SectionModel** — `Contents/section<N>.xml`

- `entryName`, `index`, `text`, `root: XElement`
- `paragraphs: ParagraphNode[]` — 최상위 문단(문서 순서)

**ParagraphNode**

- `element: XElement`, `path: number[]`, `attrs: { paraPrIDRef, styleIDRef, id? }`
- `runs: RunNode[]`, `lineSegArray?: XElement`
- `pieces: Piece[]`, `logicalText: string`
- `subLists: SubListNode[]` — 이 문단에 속한 하위 목록(표 셀, 머리말·꼬리말, 각주, 글상자 등), 문서 순서. `SubListNode = { element, owner(소유 요소의 local 이름), paragraphs: ParagraphNode[] }`

**주소(path)**: `[문단 서수, 하위목록 서수, 문단 서수, ...]`. 최상위 문단 서수는 구역 안 순서다. 하위목록 서수는 그 문단 안에 나타나는 `subList` 요소의 문서 순서다(표에서는 셀 순서와 같다). 문단 `id` 속성은 주소로 쓰지 않는다(실제 문서에서 고유하지 않다).

**RunNode**: `{ element, charPrIDRef, ordinal }`

**Piece** — 문단의 직접 run 안 내용을 문서 순서로 편 것

| kind | 내용 | 논리 텍스트 기여 | 경계 여부 |
| --- | --- | --- | --- |
| `text` | `hp:t` 안의 문자 데이터(엔티티 제외) | 그대로 | 아님 |
| `entity` | 엔티티 참조 하나 | 해독한 문자 | 아님(원자) |
| `inline` | `hp:t`의 자식 요소 (`tab`→`\t`, `lineBreak`→`\n`, `nbSpace`→U+00A0, `fwSpace`→U+2007, `hyphen`→U+00AD, 그 밖은 폭 0) | 표의 문자 | **경계** |
| `object` | run의 자식 중 `hp:t`가 아닌 것(`ctrl`, `tbl`, `pic`, `secPr` 등) | U+FFFC 한 글자 | **경계** |

- 각 Piece는 `{ kind, start, end(원문 구간), logicalStart, logicalEnd, runOrdinal }`을 가진다.
- 논리 텍스트 오프셋은 UTF-16 단위다.

**ObjectNode**: `{ element, type(local 이름), id?, instId?, subLists: SubListNode[] }`

- 표는 추가로 `{ rowCnt, colCnt, cells: { row, col, rowSpan, colSpan, borderFillIDRef, subList }[] }`
- `ctrl` 안의 `fieldBegin`/`fieldEnd`는 `FieldMark = { kind: "begin"|"end", id, name?, type?, dirty?, beginIDRef?, element }`로 문단에 기록한다.
- 책갈피는 `{ name, element }`.

**BodyRef**: 본문 요소가 자원을 가리키는 속성. `{ kind, id, element, attr 위치 }`. 대상: `charPrIDRef`, `paraPrIDRef`, `styleIDRef`, `borderFillIDRef`, `binaryItemIDRef`, `outlineShapeIDRef`(numbering). 그 밖에 이름이 `IDRef`로 끝나는 속성은 `kind: "unknown"`으로 모은다(경고 대상).

`collectBodyRefs(element)`: 요소와 그 후손 전체의 BodyRef를 모은다.

### 5.3 누름틀 조회 `listFields(doc): FieldInfo[]`

- `FieldInfo = { name, type, occurrence(같은 이름 안 순번, 0부터), sectionIndex, path, valueText, dirty, shape }`
- `shape`: `simple`(begin·end가 같은 문단, 사이에 `hp:t`가 하나 이상, 인라인 자식 없음) / `empty`(사이에 `hp:t` 없음) / `inline`(사이에 인라인 자식 있음) / `crossParagraph` / `unpaired`
- `type`이 `HYPERLINK`인 필드는 목록에서 뺀다. 그 밖의 알 수 없는 type은 포함한다.

### 5.4 모델 내보내기 `src/store/` `exportModel(doc): ModelJson`

- JSON으로 저장할 수 있는 형태다(순환 참조 없음).
- 포함: 패키지 항목 목록(이름·크기·방식·sha256), 자원 전부(요소 트리를 `{ name, attrs, children, text }`로), 구역별 문단 트리(주소, 서식 참조, 논리 텍스트, 객체·표·셀·필드·책갈피), 원본 파일 sha256, 모델 스키마 버전.
- 자원 요소 트리는 속성과 자식을 전부 담는다(서식 정보 전부 보존).

## 6. S1 수용 조건

테스트 자료: `packages/hwpx-engine/test/fixtures/`에 아래 9개를 읽기 전용 사본으로 둔다. `SHA256SUMS` 대조 테스트가 변경을 막는다.
`D1.hwpx`~`D7.hwpx`(합성 시험 문서), `hancom-merged.hwpx`(한컴이 저장한 합성 문서, 문단마다 조판 캐시 있음), `hancom-field.hwpx`(한컴이 만든 누름틀 1개).

| ID | 조건 |
| --- | --- |
| RT1 | 모든 XML 항목에서 토큰이 입력을 빈틈없이 덮고, 이어 붙이면 입력과 같다 |
| RT2 | 해독 후 다시 부호화하면 원본 바이트와 같다 |
| RT3 | 빈 변경으로 `rewriteArchive`를 하면 **파일 전체가 바이트 동일**하다 (9개 전부) |
| RT4 | 항목 하나를 같은 내용으로 `replace`하면 모든 항목의 풀린 내용이 같고, 바꾸지 않은 로컬 레코드는 바이트 동일하다 |
| RT5 | 반례가 각자의 코드로 실패한다: ZIP 아님, HWP5 서명, 잘린 파일, CRC 훼손, 암호화 플래그, 태그 불일치, 잘못된 엔티티, DOCTYPE, 속성 중복 |
| M1 | `parseDocument`가 9개 모두에서 예외 없이 끝나고, 문단 수·표 수가 기대값과 같다(D1: 전체 문단 61·표 2, hancom-merged: 전체 문단 91, hancom-field: 전체 문단 1) |
| M2 | 모든 문단의 논리 텍스트에서 U+FFFC와 인라인 문자를 뺀 것이, 독립 기준(테스트 안에서 정규식으로 `hp:t` 내용을 직접 뽑아 해독한 값)과 같다 |
| M3 | `hancom-field.hwpx`에서 `listFields`가 이름 `성명`, 값 `홍길동`, dirty `1`, shape `simple` 하나를 돌려준다 |
| M4 | 자원 수가 header의 `itemCnt`와 같다. D1: charPr 11, paraPr 8, borderFill 2 |
| M5 | 모든 BodyRef와 ResourceRef의 대상이 존재하는지 집계한다. 없는 대상은 예외가 아니라 `Issue`로 낸다 |
| M6 | `exportModel` 결과를 `JSON.stringify` → `JSON.parse`한 뒤에도 자원의 속성 수·문단 수가 같다 |

기대값은 명세와 독립 기준에서 정한다. 구현 출력에 맞춰 기대값을 고치지 않는다.

### 6.1 S1 구현에서 확정한 것 (2026-10-01)

구현 상태: 수용 조건 RT1~RT5, M1~M6 통과(테스트 174개). 구현하면서 명세의 빈틈을 다음과 같이 정했다.

- 교체한 항목은 로컬 헤더와 CD 레코드 양쪽에서 데이터 설명자 비트를 끈다.
- ZIP 구조는 엄격하게 받는다. CD가 EOCD 바로 앞에서 끝나지 않거나 해석하지 못하는 바이트가 있으면 `PKG_TRUNCATED`다.
- 추가한 코드: `PKG_NAME_ENCODING`, `PKG_INFLATE`, `MODEL_ROOT_ELEMENT`(오류), `PKG_MIMETYPE_MISSING`·`PKG_MIMETYPE_POSITION`·`PKG_MIMETYPE_COMPRESSED`·`PKG_MIMETYPE_CONTENT`·`PKG_SECTION_NOT_IN_SPINE`·`PKG_MANIFEST_ITEM`(경고), `MODEL_REF_MISSING`(오류), `MODEL_UNKNOWN_REF`·`MODEL_UNREACHED_PARAGRAPH`(경고).
- XML 중첩은 1,000단계까지다. 넘으면 `XML_MALFORMED`.
- `ParagraphNode`에 `objects`, `fieldMarks`, `bookmarks`가 있고 `SectionModel`에 `bodyRefs`가 있다.
- `FieldMark`: 시작은 `id` 속성을, 끝은 `fieldid` 속성을 `id`에 담는다. 끝의 `beginIDRef`는 따로 둔다. `dirty`는 문자열이다.
- `beginIDRef`는 알 수 없는 참조로 세지 않는다.
- 시작과 끝 사이에 객체 조각이 낀 누름틀의 shape는 `inline`이다. `crossParagraph`·`unpaired`의 `valueText`는 빈 문자열이다.
- 문단모양의 `heading` 참조는 `type`이 `NUMBER`면 numbering, `BULLET`이면 bullet이다.
- header 항목은 manifest에서 `id="header"`이거나 href가 `header.xml`로 끝나는 것이다.
- `escapeText`·`escapeAttr`는 줄바꿈·탭을 바꾸지 않는다. 그런 문자가 든 값은 채움 단계에서 거절한다(`VALUE_CONTROL_CHAR`).
- 남은 일(S2에서 처리): `linkListIDRef`·`linkListNextIDRef`는 자원 참조가 아니므로 알 수 없는 참조에서 뺀다. `memoShapeIDRef`는 메모 모양 목록이 있으면 그 목록을 가리키는 참조로, 없으면 무시한다.
- 관측: 합성 문서 D1·D7은 탭 목록이 비어 있는데 문단모양이 `tabPrIDRef="0"`을 가리킨다. 한컴 저장본에는 패키지 메타데이터에 사용자 이름이 들어가므로 시험 자료는 `tools/fixtures/scrub-metadata.ts`로 치환해 넣는다.

### 6.2 S1 독립 검증 결과와 명세 보강 (2026-10-01)

독립 검증(커밋 `7cc12be`, 시험 문서 18개와 실제 문서 659건)의 결과다.

| 주장 | 결과 |
| --- | --- |
| 빈 변경 재작성은 바이트 동일 | 시험 문서 18/18, 실제 문서 652/652(나머지 7건은 HWP5 서명으로 거부) |
| 교체 시 바꾸지 않은 로컬 레코드는 바이트 동일 | 위반 0(합성 142건, 실제 문서 1,224건) |
| 엔진이 다시 쓴 파일을 한컴이 연다 | 한컴 13에서 20/20 열림, 쪽 수 동일 |
| 토큰이 입력을 빈틈없이 덮는다 | 실제 문서의 XML 항목 5,387/5,387 |
| 논리 텍스트·문단 수가 독립 기준과 같다 | 실제 문서 642건, 문단 306,919개에서 불일치 0 |
| 코드 없는 예외·시간 초과 | 0건(퍼징 40,000건 포함). 열기+해석 중앙값 2.3ms, 최댓값 1.2초 |
| 입력 방어 | ZIP64·암호화·CRC·잘림·한도·압축 폭탄이 각자의 코드로 거부됨 |

발견한 결함과 조치:

| 결함 | 조치 |
| --- | --- |
| 교체 항목의 플래그 상위 바이트가 지워져 UTF-8 이름 표시(bit 11)가 사라짐 | 수정. 교체 항목에서 바꾸는 플래그는 데이터 설명자 비트(bit 3) 하나뿐이다 |
| 한 문단 안에 하위 목록이 수만 개면 해석 시간이 제곱으로 늚 | 수정(객체→하위 목록 대응을 한 번에 만든다) |
| 앞자리 0이 긴 숫자 참조를 거부 | 수정. 자릿수가 아니라 값으로 판정한다 |

명세 보강:

- 3.1: CD 레코드나 로컬 헤더의 플래그에서 bit 0, bit 6, bit 13 중 하나라도 켜져 있으면 `PKG_ENCRYPTED`다.
- 3.3: 필수 항목을 찾지 못했고 항목 이름에 역슬래시가 있으면 `PKG_BACKSLASH_NAMES`로 거부한다(실제 문서에 4건 있었다. 1차는 읽지 않는다).
- 4.1: 선언되지 않은 접두사를 가진 속성은 `XML_MALFORMED`다(`xml:`과 `xmlns` 선언은 예외). 접두사만 다르고 URI가 같은 속성의 중복과 접두사 선언 해제는 검사하지 않는다(알려진 한계).
- 5.2: 원문의 CR은 논리 텍스트에 그대로 둔다(실제 문서에서 영향 0건).
- 실제 문서에서 관측한 거부 사유: HWP5 서명 7, 필수 항목 없음 6(그중 4건은 역슬래시 이름), UTF-8이 아닌 header 3, 금지 문자 1.

## 7. S2 — 편집 계획과 조각

### 7.1 편집 계획 (`src/edit/`)

모든 변경은 편집 계획으로 표현한다. 작성기는 계획만 보고 모델을 모른다.

```ts
type SpanEdit = { entry: string; start: number; end: number; expected: string; replacement: string; reason: string }
type EditPlan = {
  edits: SpanEdit[]                                  // 항목별 문자열 구간 치환 (UTF-16 오프셋)
  additions: { name: string; data: Uint8Array; method: 0 | 8 }[]
  summary: Record<string, number>                    // 예: reusedResources, addedResources, reissuedIds
  issues: Issue[]
}
```

- `applyPlan(pkg, plan): Uint8Array`
  - 항목별로 편집을 시작 위치순으로 정렬한다. 겹치면 `EDIT_OVERLAP`. 길이 0 삽입이 같은 위치에 여럿이면 계획에 실린 순서를 지킨다.
  - 적용 전 `text.slice(start, end) === expected`를 확인한다. 다르면 `EDIT_STALE`.
  - 문자열을 조립해 UTF-8로 부호화하고(원본에 BOM이 있으면 유지) `rewriteArchive`로 쓴다.
  - 편집이 하나도 없으면 입력과 바이트 동일한 결과를 낸다.
- `mergePlans(a, b)`: 두 계획을 합친다. 같은 항목에서 구간이 겹치면 `EDIT_OVERLAP`.

### 7.2 조각 선택

1차의 조각 단위는 **같은 부모 안의 연속 문단**이다. 표·그림은 그것을 담은 문단째로 옮긴다.

```ts
type FragmentSelection = { sectionIndex: number; parentPath: number[]; from: number; to: number }
```

- `parentPath`가 빈 배열이면 구역의 최상위 문단, 아니면 그 주소의 하위 목록(예: 표 셀) 안 문단이다. `from`~`to`는 포함 범위다.
- 범위 안 문단에 구역 설정(`secPr`)이 있으면 `FRAG_SECTION_PROPS`로 거절한다(구역 설정이 든 run을 다루는 것은 1차 범위 밖).
- 편의 함수 `selectTable(doc, sectionIndex, tableOrdinal)`: 그 표를 담은 최상위 문단 하나를 선택으로 돌려준다. 그 문단에 표 말고 글이 있으면 경고를 붙인다.

### 7.3 조각 자료 `extractFragment(doc, selection): Fragment`

```ts
type Fragment = {
  schema: "hwpx-studio/fragment@1"
  source: { sha256: string; selection: FragmentSelection }
  xml: string                       // 선택한 문단들의 원문(첫 문단 시작 ~ 마지막 문단 끝)
  prefixes: Record<string, string>  // 원문에 쓰인 접두사 → 네임스페이스 역할
  refs: { kind: string; lang?: string; id: string; start: number; end: number }[]      // xml 안 참조 속성값 구간
  resources: FragmentResource[]     // 의존 닫힘, 의존 순서(참조되는 것이 먼저)
  binaries: { itemId: string; href: string; mediaType: string; sha256: string; base64: string }[]
  instanceIds: { role: "object" | "inst" | "fieldBegin" | "fieldEndRef"; value: string; start: number; end: number }[]
  bookmarks: { name: string; start: number; end: number }[]
  lineSegSpans: { start: number; end: number }[]
  texts: string[]                   // 조각 안 모든 문단의 논리 텍스트(문서 순서)
  prints: string[]                  // 조각 안 모든 서식 참조의 지문(문서 순서)
}
type FragmentResource = {
  kind: string; lang?: string; id: string; xml: string
  idSpan: { start: number; end: number }
  refs: { kind: string; lang?: string; id: string; start: number; end: number }[]
  fingerprint: string
}
```

- 의존 닫힘: 조각이 가리키는 자원에서 출발해 자원이 가리키는 자원을 끝까지 모은다. 없는 대상을 가리키는 참조는 `FRAG_DANGLING_SOURCE` 경고로 남기고 그 참조는 그대로 둔다.
- 그림의 이진 자료는 `content.hpf`의 manifest에서 찾아 내용과 함께 담는다.
- `Fragment`는 `JSON.stringify`로 저장할 수 있다.

### 7.4 자원 지문 `fingerprintResource(item, lookup): string`

- 자원 요소를 정규 문자열로 만든다: 요소의 local 이름, 속성(이름순 정렬, `id` 제외, 접두사 제외), 자식(문서 순서), 글자 데이터(앞뒤 공백 제거).
- 다른 자원을 가리키는 속성값은 **대상의 지문**으로 바꾼다. 대상이 없으면 `missing:<id>`.
- 글꼴은 언어와 요소 내용(이름·종류 등)으로 지문을 만든다. id는 넣지 않는다.
- 결과는 정규 문자열의 SHA-256(16진)이다. 같은 모양의 자원은 문서가 달라도 같은 지문을 갖는다.
- `prints`의 각 값은 본문 참조가 가리키는 자원의 지문이다.

### 7.5 조각 가져오기 `planImport(target, fragment, at): EditPlan`

```ts
type InsertPoint = { sectionIndex: number; parentPath: number[]; index: number; position: "before" | "after" }
```

1. **접두사 확인**: 조각의 접두사가 대상 구역에서 같은 역할로 선언돼 있어야 한다. 아니면 `FRAG_NS_MISMATCH`.
2. **자원 대응**: 조각 자원을 의존 순서로 본다. 대상에 같은 지문의 자원이 있으면 그 id를 재사용한다. 없으면 새 id(그 종류에서 가장 큰 숫자 id + 1부터)를 주고, 자원 원문의 `id`와 안쪽 참조를 대응표대로 바꿔 대상 header의 해당 목록 끝에 넣는다. 목록의 개수 속성(`itemCnt`, 글꼴은 `fontCnt`)을 갱신한다.
   - 스타일은 이름이 같고 지문이 다르면 새 스타일의 이름에 ` (2)`, ` (3)` …을 붙인다.
   - 대상 header에 해당 목록 요소가 없으면 `FRAG_NO_LIST`로 거절한다.
3. **본문 재작성**: 조각 원문의 참조 속성값을 대응표대로 바꾼다. 줄 배치 캐시 구간을 지운다.
4. **인스턴스 id**: 객체 id·instId가 대상에 이미 있거나 자리값(`0`, 빈 값)이면 새 값(대상과 조각을 합친 가장 큰 숫자 + 1부터)을 준다. 필드는 시작 id와 끝의 `beginIDRef`를 함께 바꾼다. 문단 id는 건드리지 않는다.
5. **책갈피**: 이름이 대상과 겹치면 `_1`, `_2` …를 붙인다.
6. **이진 자료**: 대상에 같은 내용(sha256)의 항목이 있으면 그 id를 재사용한다. 없으면 겹치지 않는 새 id와 항목 이름으로 추가하고 manifest에 등록한다.
7. **삽입**: 삽입 지점 문단의 시작(before) 또는 끝(after)에 재작성한 조각 원문을 넣는다.
8. `summary`에 재사용·추가·재발급 수를 적는다.

- 같은 조각을 같은 대상에 두 번 가져오면 두 번째에는 자원이 전부 재사용돼야 한다.
- 대상 문서의 기존 자원·문단은 바뀌지 않는다(추가와 개수 속성 갱신만).

### 7.6 S2 수용 조건

| ID | 조건 |
| --- | --- |
| F1 | 편집이 없는 계획의 `applyPlan` 결과는 입력과 바이트 동일 |
| F2 | `expected`가 다른 편집은 `EDIT_STALE`, 겹치는 편집은 `EDIT_OVERLAP` |
| F3 | D5의 표(최상위 표 중 하나)를 D1 끝 문단 뒤에 가져오면: 결과가 다시 파싱되고, 조각 문단들의 `texts`가 원본과 같고, `prints`가 원본과 전부 같다 |
| F4 | F3 결과에서 모든 본문 참조·자원 참조의 대상이 있다(없는 참조가 늘지 않는다) |
| F5 | F3 결과에서 객체 id 중복이 없다(D1과 D5에 같은 표 id가 있으므로 재발급돼야 한다) |
| F6 | D5의 일반 문단 3개를 D1에 가져온다. F3~F5와 같은 기준 |
| F7 | 같은 조각을 두 번 가져오면 두 번째의 `addedResources`는 0 |
| F8 | 자기 자신에게 가져오기(D1 조각 → D1): 추가 자원 0, 객체 id 재발급 |
| F9 | D1 원래 문단의 원문 구간과 기존 자원 원문이 결과에서 그대로다 |
| F10 | `secPr`가 든 문단을 선택하면 `FRAG_SECTION_PROPS` |
| F11 | 한컴 저장본(hancom-merged)에서 뽑은 조각을 D1에 가져오면 줄 배치 캐시가 조각에서 제거돼 있다 |
| F12 | `Fragment`를 JSON으로 저장했다가 읽어 가져와도 결과가 같다 |
| F13 | 그림이 든 조각: 이진 자료 항목이 추가되고 manifest에 등록되며 참조가 맞다(시험 자료는 총괄이 제공. 없으면 미검증으로 보고) |

### 7.65 S2 구현에서 확정한 것 (2026-10-01)

구현 상태: F1~F13 통과. 오라클 교차(rhwp 파싱, Python 검사기 오류 증가 없음) 21건 통과.

- **접두사**: 조각이 쓰는 접두사가 대상에서 다른 역할로 선언돼 있을 때만 `FRAG_NS_MISMATCH`다. 선언이 없으면 대상 구역(또는 header) 루트의 시작 태그에 선언을 더한다(그림의 `hc:` 접두사처럼 합성 문서에 선언이 없는 경우가 있다).
- **스타일 지문**: 이름 끝의 ` (n)` 접미사는 지문에서 뗀다. 이름이 충돌해 접미사가 붙은 스타일도 다시 가져올 때 재사용된다. 실제로 `바탕글`은 문서마다 모양이 달라 충돌이 흔하다.
- **의존 확장**: 자원 안의 이진 자료 참조(그림 채우기)와 번호·글머리표의 글자모양 참조도 의존으로 본다. "참조 없음" 관례값은 참조로 세지 않는다.
- **개수 속성**: 추가가 있는 목록은 실제 자식 수 + 추가 수로 쓴다.
- **이진 자료**: manifest에 `<opf:item id href media-type isEmbeded="1"/>`로 등록한다. 압축은 더 작아질 때만 한다.
- `Fragment`에 `namespaces`, `census`, `issues`가 있다. `selectTable`은 `{ selection, issues }`를 돌려준다.
- 계획의 `summary` 키: `reusedResources`, `addedResources`, `reusedBinaries`, `addedBinaries`, `reissuedIds`, `renamedStyles`, `renamedBookmarks`, `insertedParagraphs`, `insertedTables`, `insertedPictures`, `insertedFields`, `insertedBookmarks`.
- 추가한 코드: `EDIT_RANGE`, `FRAG_SELECTION`, `FRAG_INSERT_POINT`, `FRAG_SCHEMA`(오류), `FRAG_UNKNOWN_REF`, `FRAG_TABLE_PARAGRAPH_TEXT`, `FRAG_BEFORE_SECPR`(경고).
- 독립으로 만든 두 가져오기 계획은 합치지 않는다(새 id가 겹친다). 가져오기 → 다시 파싱 → 다음 가져오기 순서로 적용한다.

후속 수정(확정):

- **문단 id**: 조각의 문단 id가 자리값이 아니고 대상에 이미 있으면 새 값으로 바꾼다(같은 문서에 다시 넣을 때 중복 오류가 나던 문제).
- **없는 참조를 채우는 경우 경고**: 대상에서 없는 자원을 가리키던 id를 새 자원이 차지하게 되면(예: 탭 목록이 비었는데 0번을 가리키는 합성 문서) 기존 문단의 모양이 달라질 수 있다. 계획에 `FRAG_FILLS_DANGLING` 경고를 남긴다.
- 소스에서 없는 대상을 가리키던 참조는 그대로 옮긴다(`FRAG_DANGLING_SOURCE` 경고). 대상에 같은 id가 있으면 그 자원을 가리키게 된다. 원본이 깨끗하면 생기지 않는다.
- `HwpxPackage`에 rootfile 경로를 둔다.
- header에 이진 목록(`binDataList`)이 있는 문서는 그 목록을 갱신하지 않는다(한컴 저장본에는 이 목록이 없다. 알려진 한계).

### 7.7 서식 변경 (`src/format/`) — S2b (사용자 지시, 2026-10-01)

기존 서식을 그대로 쓰는 것이 먼저다. 바꿔야 할 때는 **복제해서 일부만 바꾸고, 같은 모양이 이미 있으면 그것을 쓴다.** 서식 자원을 0부터 새로 쓰지 않는다.

- `deriveResource(doc, kind, baseId, delta): { id, plan }`
  - `kind`: `charPr`, `paraPr`, `borderFill`.
  - 기준 자원의 원문을 복제하고 `delta`만 적용한다. 결과의 지문이 대상 문서의 기존 자원과 같으면 그 id를 돌려주고 계획은 비어 있다. 다르면 새 id로 header 목록 끝에 추가하고 개수 속성을 갱신한다.
  - 같은 요청을 두 번 하면 같은 id가 나온다. 기준 자원은 바뀌지 않는다.
- `FormatDelta`: 일반 연산의 목록이다.
  - `{ op: "setAttr", path, name, value }` — `path`는 자원 요소 아래 자식 요소의 local 이름 경로(빈 경로는 자원 요소 자신). 자식이 없으면 만든다(위치는 같은 종류의 다른 자원에서 관측한 자식 순서를 따른다. 관측이 없으면 `FMT_UNKNOWN_CHILD`로 거절).
  - `{ op: "addChild", path, name, attrs? }`, `{ op: "removeChild", path, name }`
- 편의 생성기(글자): 크기, 글자색, 음영색, 진하게, 기울임, 밑줄(종류·모양·색), 취소선(모양·색), 외곽선, 그림자, 양각, 음각, 위첨자, 아래첨자, **장평·자간·상대 크기·글자 위치**(언어 7종에 같은 값 또는 언어별 값), 강조점, 글꼴(이름으로 찾고 없으면 `FMT_FONT_NOT_FOUND`), 커닝.
- 편의 생성기(문단): 정렬, 줄 간격(종류·값), 왼쪽·오른쪽 여백, 들여쓰기·내어쓰기, 문단 앞·뒤 간격, 줄 나눔 기준, 문단 테두리(테두리 자원 참조), 탭 정의 참조.
- 적용
  - `planApplyCharFormat(doc, range, delta)`: `range`는 한 문단 안의 논리 텍스트 구간이다. 구간 경계에서 **run을 쪼갠다**(글 조각 중간이면 `hp:t`와 run을 닫고 같은 속성으로 다시 연다). 구간에 걸친 run마다 "그 run의 글자모양 + delta"로 파생 id를 구해 바꾼다(run마다 기준이 달라 결과 id가 다를 수 있다). 구간이 경계 조각(인라인·객체)을 포함해도 된다(run 단위로 적용).
  - `planApplyParaFormat(doc, 문단 주소들, delta)`: 문단의 `paraPrIDRef`를 파생 id로 바꾼다.
  - 글이 있는 구역의 줄 배치 캐시를 지운다.
- 수용 조건

| ID | 조건 |
| --- | --- |
| R1 | 파생 자원을 다시 파싱하면 delta의 속성이 들어 있고, delta에 없는 속성·자식은 기준과 같다 |
| R2 | 같은 요청을 두 번 하면 같은 id, 추가 자원 0 |
| R3 | 이미 같은 모양의 자원이 있으면 그것을 재사용한다(예: 진하게를 요청했는데 진한 글자모양이 이미 있는 문서) |
| R4 | 구간 적용 시 run이 쪼개지고, 구간 밖 글의 글자모양과 문단의 논리 텍스트는 그대로다 |
| R5 | 드문 서식 20종 이상(장평 50·200, 자간 -50·50, 상대 크기, 글자 위치, 강조점, 외곽선, 그림자, 양각, 음각, 위·아래첨자, 취소선·밑줄 모양, 음영색, 줄 간격 종류 3가지, 문단 테두리, 내어쓰기, 배분 정렬)을 각각 적용해 검사기 새 오류 0 |
| R6 | 여러 서식을 겹쳐 적용(같은 구간에 차례로 3가지)해도 R1·R4가 성립한다 |
| R7 | 한컴 대조(선택 실행): 결과를 한컴으로 열어 그 위치의 글자모양·문단모양을 읽으면 요청한 값과 같다. 쪽 수가 터무니없이 변하지 않는다 |

### 7.8 조각 스트레스 시험 (`tools/stress/`) (사용자 지시, 2026-10-01)

짧고 단순한 구간이 아니라 **길고 복잡한 구간을, 서로 무관한 실제 문서 사이에서** 옮긴다. 결과는 수량과 코드로만 기록한다(문서 이름·내용 기록 금지, 원본 무수정).

- **자료**: 실제 문서 모음에서 열리는 문서 전부. 시드를 고정한 무작위로 소스·대상 쌍을 뽑는다(같은 문서 쌍 제외, 서로 다른 폴더·다른 스타일 체계 우선).
- **구간 고르기**: 소스마다 복잡도 점수(구간 안 객체 종류 수, 서로 다른 글자모양·문단모양 수, 표 중첩 깊이, 그림·누름틀·책갈피·각주·글상자 유무, 문단 수)가 높은 연속 문단 구간을 고른다. 길이는 20~200문단. 구역 설정이 든 문단은 피한다.
- **삽입 방식**(구간마다 전부):
  1. 통째로 대상의 끝에.
  2. 통째로 대상의 중간(무작위 문단 앞)과 맨 앞 본문 문단 뒤에.
  3. **쪼개서**: 구간을 2~5개 부분으로 나눠 순서대로 같은 위치에, 그리고 서로 다른 위치에.
  4. 대상의 표 셀 안에(표가 있을 때).
  5. 같은 조각을 두 번(두 번째는 자원이 전부 재사용돼야 한다).
  6. 연쇄: A의 조각을 B에 넣은 결과에서 다시 조각을 떠 C에 넣는다.
- **서식 변경과의 조합**: 가져온 조각의 일부 구간에 7.7의 서식 변경(드문 서식 포함)을 적용한다.
- **검증**(건마다): 다시 파싱됨, 검사기 기준선 대비 새 오류 0, 조각 문단의 논리 텍스트와 서식 지문이 소스와 같음(쪼갠 경우 합이 통째와 같음), 대상의 기존 구간 원문 불변, 수량 증감이 예고와 같음, 이진 자료 정합, 같은 입력 재실행 시 같은 출력.
- **오라클**(표본): rhwp 파싱 성공과 쪽 수, 한컴 COM 열림·쪽 수·PDF 저장. 표본은 실패 위험이 큰 것(그림·누름틀·중첩 표·글상자 포함) 위주로 30건 이상.
- **실패 처리**: 실패는 코드별로 집계한다. 거절(실패 닫힘)과 결함(잘못된 출력)을 구분한다. 결함은 최소 재현 자료를 합성 문서로 만들어 회귀 테스트에 넣고 원인을 고친 뒤 캠페인을 다시 돌린다.
- **통과 기준**: 결함 0. 거절은 사유별 수량과 함께 보고하고, 거절률이 높은 사유는 지원 범위에 넣을지 검토한다.

## 8. S3 — 검사·채움·템플릿·CLI

### 8.1 검사기 (`src/validate/`) — S3a

`hwpx-edit/validate_refs.py`(이 프로젝트의 기존 Python 검사기)를 TypeScript로 옮긴다. 엔진의 패키지·XML 계층 위에서 동작한다.

- `validateDocument(bytes, options): ValidationReport`
  - `ValidationReport = { errors: Issue[], warnings: Issue[], stats, census }`
  - `options.strict`: 한컴이 받아 주는 것으로 분류한 경고를 오류로 올린다.
- 검사 항목과 코드, 오류·경고 분류, 자리값 처리는 Python 검사기와 **같아야 한다**(같은 프로젝트의 자산이므로 코드 이름을 그대로 쓴다).
- 추가 검사(새 코드):
  - `PKG_SECCNT_MISMATCH`: header의 구역 수 선언과 실제 구역 항목 수가 다르다(오류).
  - `XML_ILLEGAL_CHAR`: XML 1.0 금지 제어문자가 있다(오류).
  - `PKG_NO_PREVIEW_TEXT`: 미리보기 텍스트 항목이 없다(경고).
  - `TBL_ATTR_MISSING`: 표의 `rowCnt`·`colCnt` 속성이 없다(오류).
- `census`: 문단·표·그림·필드 짝·책갈피·이진 항목·모르는 컨트롤(종류별)의 수.
- `compareToBaseline(before, after): { newErrors, preexisting, resolved }` — 오류를 (코드, 메시지, 위치)로 묶어 개수 차이를 낸다.
- 수용 조건:

| ID | 조건 |
| --- | --- |
| V1 | 시험 문서 9개의 오류·경고 코드 집합(코드별 개수)이 Python 검사기 결과와 같다(Python이 있을 때 실행해 대조, 없으면 미검증 보고) |
| V2 | Python 쪽 반례 스크립트(`hwpx-edit/poc/negative_tests.py`)의 26개 반례를 테스트 안에서 재현해 같은 코드로 실패한다 |
| V3 | 추가 검사 4종이 각자의 반례에서 실패하고 정상 문서에서는 나오지 않는다 |
| V4 | `compareToBaseline`: 원래 있던 오류는 `preexisting`, 편집으로 생긴 오류는 `newErrors` |
| V5 | 깨진 입력(ZIP 아님 등)은 예외가 아니라 보고서의 오류로 돌려준다 |

**S3a 구현에서 확정한 것 (2026-10-01)** — V1~V5 통과(검사기 테스트 93개, Python 검사기와 시험 문서 18개 전부 일치).

- Python 검사기가 내던 코드는 그대로 내고, 엔진 고유 코드는 그 위에 더한다. XML을 읽지 못하면 `XML_MALFORMED`와 함께 사유 코드(`XML_ILLEGAL_CHAR`·`XML_ENCODING`·`XML_DOCTYPE`)를 낸다.
- 구역 수 불일치는 경고 `PKG_SECCNT`(기존)와 오류 `PKG_SECCNT_MISMATCH`(추가)를 함께 낸다.
- 엔진이 열지 않는 ZIP 구조(이름 중복, 암호화, ZIP64, 한도 초과)는 그 코드만 내고 나머지 검사를 멈춘다.
- `--strict`에서 `RES_DANGLING_TOLERATED`는 `RES_DANGLING`으로, `INST_DUP_PLACEHOLDER`는 `INST_DUP_ID`로 바뀐다.
- 같은 (코드, 메시지, 위치)는 한 항목으로 합치고 `count`를 둔다. 일부 메시지에 개수가 들어 있어, 같은 중복이 늘어나면 기준선 비교에서 새 오류와 해소된 오류가 한 쌍으로 나온다(게이트 판정은 같다).
- 한컴 저장본은 `container.xml`이 미리보기 텍스트를 rootfile로 올려 둔다. 미리보기 항목을 빼면 `PKG_NO_PREVIEW_TEXT`(경고)와 별개로 `PKG_ROOTFILE`(오류)이 난다.
- `census.fieldPairs`는 필드 시작 요소의 수다. `census.binaryItems`는 `BinData/` 아래 항목 수다.

### 8.2 템플릿과 데이터 (`src/template/`) — S3b

**템플릿 `template.json`**

```json
{
  "schema": "hwpx-studio/template@1",
  "source": { "sha256": "원본 해시" },
  "anchors": [
    { "id": "a1", "kind": "field", "name": "성명" },
    { "id": "a2", "kind": "word", "at": { "sectionIndex": 0, "path": [3] }, "start": 5, "end": 12,
      "print": { "text": "대상 글", "before": "앞 24자", "after": "뒤 24자" } },
    { "id": "a3", "kind": "line", "at": { "sectionIndex": 0, "path": [7] }, "print": { "text": "문단 글 앞 40자", "sha256": "문단 글 해시" } },
    { "id": "a4", "kind": "cell", "table": { "sectionIndex": 0, "ordinal": 1 }, "row": 2, "col": 1 },
    { "id": "a5", "kind": "object", "objectType": "tbl", "sectionIndex": 0, "ordinal": 0 }
  ],
  "rules": [
    { "id": "r1", "do": { "type": "fill", "anchor": "a1", "value": { "path": "applicant.name" } } },
    { "id": "r2", "when": { "path": "contract.type", "op": "eq", "value": "용역" },
      "do": { "type": "inject", "anchor": "a3", "position": "after", "fragment": "fragments/service-terms.json" } },
    { "id": "r3", "when": { "not": { "path": "attachments", "op": "exists" } },
      "do": { "type": "delete", "anchor": "a5" } }
  ],
  "options": { "missing": "error" }
}
```

- 문서 안의 `{{경로}}` 표기는 템플릿 없이도 동작한다. 엔진이 암묵적인 `word` 앵커와 `fill` 규칙으로 취급한다. 문법: `{{` 공백* 경로 공백* `}}`, 경로는 `이름(.이름)*`, 이름은 글자·숫자·`_`·`-`.
- `table.ordinal`과 `object.ordinal`은 구역 안 최상위 문단들에서 그 종류가 나타나는 순서다(중첩 표는 `at` 주소로 가리킨다. 1차는 최상위만).

**조건**

```
Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition }
          | { path: string, op: Op, value?: unknown }
Op = "exists" | "empty" | "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "contains" | "in" | "matches" | "lengthEq" | "lengthGt" | "lengthLt"
```

- `exists`: 경로가 있고 null이 아니다. `empty`: 없거나 null이거나 빈 문자열·빈 배열이다.
- 비교는 양쪽이 숫자면 숫자로, 아니면 문자열로 한다. `in`의 `value`는 배열이다. `matches`의 `value`는 정규식 문자열이다. `length*`는 배열·문자열 길이다.
- `when`이 없으면 항상 참이다. 조건은 데이터만 보고 판정한다.

**액션**

| type | 필드 | 동작 |
| --- | --- | --- |
| `fill` | `anchor`, `value`(`{path}` 또는 `{text}`) | 앵커 자리의 글을 값으로 바꾼다 |
| `delete` | `anchor`, `scope?`(`row`) | `line`: 문단 삭제. `object`: 그 객체만 든 문단이면 문단째, 아니면 객체 요소만 삭제. `cell`+`scope:"row"`: 표 행 삭제 |
| `inject` | `anchor`(line), `position`(`before`·`after`·`replace`), `fragment`(조각 JSON 경로 또는 내장 객체) | 조각을 가져와 넣는다. 조각 안의 `{{}}`도 같은 데이터로 채운다 |
| `insertText` | `anchor`(line), `position`, `value`, `style`(`inherit` 또는 `{ paraPrIDRef, charPrIDRef, styleIDRef }`) | 일반 텍스트를 새 문단으로 넣는다. 값의 줄바꿈마다 문단을 나눈다. `inherit`는 앵커 문단의 문단모양·스타일과 첫 run의 글자모양을 쓴다 |

**데이터 묶음**

```json
{ "schema": "hwpx-studio/dataset@1", "data": { }, "derived": { } }
```

- `fill`의 경로는 `data`에서 찾고, 없으면 `derived`에서 찾는다. CLI는 묶음 형식이 아닌 일반 JSON도 받는다(전체를 `data`로 본다).
- 값 변환: 문자열은 그대로, 숫자·불리언은 문자열로. 객체·배열은 `DATA_NOT_SCALAR`. null·없음은 `options.missing`에 따른다: `error`(기본, `DATA_MISSING`으로 전체 중단), `empty`(빈 글), `keep`(자리를 그대로 둠).
- 값에 XML 금지 문자나 줄바꿈·탭이 있으면 `VALUE_CONTROL_CHAR`(`insertText`의 줄바꿈은 예외).

### 8.3 채움 규칙 (`src/fill/`) — S3b

**앵커 해석 `resolveAnchors(doc, template)`**

- `field`: 이름이 같은 누름틀 전부(순번을 주면 그것만). 없으면 `ANCHOR_NOT_FOUND`.
- `word`·`line`: 주소의 문단을 찾고 `print`와 대조한다. 맞으면 exact. 안 맞으면 같은 구역에서 `print`로 다시 찾는다: 유일하면 `ANCHOR_RELOCATED`(경고), 여럿이면 `ANCHOR_AMBIGUOUS`(오류), 없으면 `ANCHOR_NOT_FOUND`(오류).
- `cell`·`object`: 서수로 찾는다. 범위 밖이면 `ANCHOR_NOT_FOUND`.

**자리별 채움**

- 누름틀(shape별): `simple` → 시작과 끝 사이 첫 글 조각에 값을 넣고 나머지 글 조각은 비운다. `empty` → 시작 컨트롤 바로 뒤에 `<접두사:t>값</접두사:t>`를 넣는다. 둘 다 시작 요소의 `dirty`를 `"1"`로 한다(없으면 속성 추가). 안내문과 값을 비교하지 않는다. `inline`·`crossParagraph`·`unpaired`는 `FIELD_UNSUPPORTED_SHAPE`.
  - **안내문 상태**(`dirty`가 `"1"`이 아님) [확인: 한컴 13 저장본]: 시작 컨트롤, 안내문 글, 끝 컨트롤이 서로 다른 run에 있고 안내문 run은 안내문용 글자모양(빨강·기울임)을 쓴다. 값을 넣을 때 시작 run과 끝 run 사이에 있는 run들의 `charPrIDRef`를 **시작 컨트롤이 든 run의 값**으로 바꾼다(한컴이 값을 넣었을 때의 결과와 같은 글자모양). 빈 값을 넣는 경우에는 `dirty`와 글자모양을 건드리지 않는다.
  - 채운 뒤 `listFields`의 `valueText`가 넣은 값과 같아야 한다(값 재읽기).
- 자기닫힘 run(`<hp:run charPrIDRef="0"/>`, 한컴의 빈 셀·빈 문단 모양)에 글을 넣을 때는 `<hp:run charPrIDRef="0"><접두사:t>값</접두사:t></hp:run>`로 펼친다.
- `word`와 `{{}}`: 범위 안에 경계 조각(inline·object)이 있으면 치환하지 않고 `skipped: FILL_CROSSES_MARKUP`. 범위가 글자모양이 다른 run들에 걸치면 `skipped: FILL_MIXED_FORMAT`(옵션 `mixedFormat: "first"`면 첫 run에 넣는다). 통과하면 범위의 첫 글 조각에 값을 넣고 나머지 겹친 구간은 지운다. run·`hp:t` 요소는 지우지 않는다.
- `line`(fill): 문단에 객체 조각이 있으면 `FILL_HAS_OBJECT`. 없으면 첫 글 조각에 값을 넣고 나머지 글 조각을 비운다. 글 조각이 없으면 첫 run 안에 `hp:t`를 넣는다.
- `cell`: 셀 안에 객체가 있으면 `FILL_HAS_OBJECT`. 첫 문단을 `line` 방식으로 채우고 나머지 문단의 글은 비운다.
- 값은 `escapeText`로 넣는다.

**구조 액션**

- 문단 삭제: 그 부모의 마지막 남은 문단이면 `FILL_LAST_PARAGRAPH`. 구역 설정이 든 문단이면 `FILL_SECTION_PROPS`.
- 표 행 삭제: 그 행에 걸친 세로 병합(rowSpan > 1) 셀이 있으면 `FILL_ROW_SPAN`. 행 요소를 지우고 표의 `rowCnt`를 줄이고 뒤 행 셀들의 행 주소를 1씩 줄인다. 마지막 남은 행이면 표를 담은 문단 삭제로 바꾼다.
- `inject`: `planImport`를 쓴다. 조각 원문 안의 `{{}}`는 같은 데이터로 채워서 넣는다. `replace`는 앵커 문단 삭제 + 그 자리에 삽입이다.
- `insertText`: 새 문단 원문을 만들어 넣는다(문단·run·`hp:t`만. 속성은 `paraPrIDRef`, `styleIDRef`, `charPrIDRef`와 대상 문서가 문단에 쓰는 나머지 속성을 앵커 문단에서 복사, `id`는 앵커 문단의 값이 자리값이면 그대로·아니면 자리값 `0`).

**계획 조립 `buildFillPlan(doc, template, dataset, options): { plan, report }`**

1. 규칙을 순서대로 평가해 참인 것만 남긴다.
2. 삭제 범위 안의 채움·삽입은 버리고 `report.dropped`에 적는다. 같은 자리에 값이 다른 채움이 둘이면 `TPL_CONFLICT`.
3. 글이 바뀌는 구역(채움·삽입·삭제가 있는 구역)의 줄 배치 캐시 요소를 전부 지우는 편집을 더한다(삭제 범위와 겹치는 것은 뺀다).
4. `report`: 적용할 액션 목록, 건너뛴 자리와 사유, 필요한 데이터 경로 목록, 재배치된 앵커, 예상 수량 증감.

**저장 게이트 `generate(bytes, template, dataset, options): GenerateResult`**

1. 열기·파싱·기준선 검사. `mode: "repair"`면 먼저 수리 계획(중복 객체 id·instId 재발급, 중복 필드 짝 id 재발급)을 적용하고 그 결과를 원본으로 삼는다.
2. `buildFillPlan`. 오류가 있으면 여기서 끝낸다(출력 없음). `dryRun`이면 보고서만 돌려준다.
3. `applyPlan` → 다시 파싱 → 검사.
4. 판정: `baseline`은 새 오류 0, `strict`는 오류 0.
5. 보존 확인: 손대지 않은 항목의 로컬 레코드 바이트 동일, 손댄 XML은 편집 구간 밖의 글이 원본과 동일(계획의 오프셋으로 구간을 나눠 비교), 수량 증감이 보고서의 예상과 같음.
6. 값 재읽기: 채운 누름틀의 값, 채운 문단·셀의 논리 텍스트가 예상과 같은지, 채운 `{{}}`가 남아 있지 않은지 확인한다.
7. 전부 통과하면 `{ ok: true, output, report, ledger }`. 아니면 `{ ok: false, report }`이고 출력은 없다.
- `ledger`: 입력 해시, 템플릿 해시, 데이터 해시, 출력 해시, 방식, 수량, 시각 없이 결정적인 내용만. 값 원문은 넣지 않는다(길이와 해시 앞 8자).
- 같은 입력으로 다시 돌리면 출력 바이트가 같아야 한다.

**누름틀 승격 `planCompile(doc, anchors?)`**

- `{{경로}}` 자리(또는 지정한 `word` 앵커)를 누름틀로 바꾼다. 이름은 경로다. 값 글은 그대로 둔다.
- 만드는 원문은 한컴이 만든 누름틀(`hancom-field.hwpx`)의 요소·속성 구성을 따른다. 시작 id와 `fieldid`는 문서에서 겹치지 않는 값을 결정적으로 준다.
- 한컴에서 열리는지 확인되기 전에는 CLI에서 `--experimental`을 요구한다.

**후보 자리 `findCandidates(doc)`** (Jev의 입력. 1차는 탐지만)

- 누름틀, `{{}}`, 짧은 글(12자 이하, 문장 끝맺음 아님)의 오른쪽 셀이 비었거나 밑줄·괄호뿐인 경우, `라벨:` 뒤가 빈 경우, `(   )`·`____`·`□` 표시.
- 결과는 앵커 초안과 근거 문자열의 목록이다.

### 8.35 오류 보정 (`src/repair/`) — S3c (사용자 지시, 2026-10-01)

검출과 보정을 함께 간다. 보정은 항목별로 켜고 끌 수 있고, 한 일은 전부 보고서에 남긴다. 보정 뒤 다시 검사한다.

`planRepair(bytes, report, options): { plan, repaired: RepairNote[], unrepaired: Issue[] }`

| 보정 | 대상 오류 | 방법 | 기본 |
| --- | --- | --- | --- |
| `reissueIds` | 객체 id·instId 중복, 필드 시작 id 중복 | 첫 등장은 두고 뒤의 것에 새 값. 필드는 끝의 `beginIDRef`를 함께 바꾼다 | 켬 |
| `fixCounts` | 자원 목록의 개수 속성(`itemCnt`·`fontCnt`), 구역 수 선언 불일치 | 실제 수로 고친다 | 켬 |
| `dropStaleLineSeg` | 줄 배치 캐시가 문단 글 길이 밖을 가리킴 | 그 구역의 캐시를 지운다 | 켬 |
| `stripIllegalChars` | XML 금지 제어문자 | 그 문자를 지운다(글 안에서만) | 켬 |
| `renameBookmarks` | 책갈피 이름 중복 | 뒤의 것에 접미사 | 켬 |
| `fallbackRefs` | 없는 서식을 가리키는 참조 | 같은 종류의 기본 자원(스타일은 첫 스타일, 그 밖은 id가 가장 작은 것)으로 돌린다. **문서의 모양이 바뀔 수 있다** | **끔** |
| `normalizePackage` | mimetype 순서·압축 위반 | 항목을 다시 배열해 새로 쓴다(바이트 보존 대상에서 벗어난다) | **끔** |

- 보정하지 못하는 것(필드 짝이 안 맞음, 표 셀 범위 오류, 깨진 XML, 필수 항목 없음)은 `unrepaired`로 돌려준다.
- 수용 조건

| ID | 조건 |
| --- | --- |
| P1 | 보정 종류마다 결함을 넣은 문서에서 해당 오류가 사라지고 다른 새 오류가 생기지 않는다 |
| P2 | 보정하지 않는 부분의 바이트는 그대로다(`normalizePackage` 제외) |
| P3 | 기본 설정에서 `fallbackRefs`·`normalizePackage`는 동작하지 않는다 |
| P4 | 원래 오류가 있는 실제 문서 표본에 보정을 적용해 검사기 오류가 줄고, 한컴에서 열린다(선택 실행) |
| P5 | 보정 보고서에 무엇을 어디서 몇 건 고쳤는지 남는다. 값 원문은 남기지 않는다 |

### 8.4 CLI (`apps/cli`) — S3b

| 명령 | 동작 |
| --- | --- |
| `hwpx inspect <파일> [--json] [--model 출력.json]` | 구역·문단·표·누름틀·`{{}}`·자원 수 요약. `--model`은 모델 JSON 저장 |
| `hwpx candidates <파일> [--json]` | 후보 자리 목록 |
| `hwpx fragment extract <파일> --section N --from A --to B [--parent 주소] -o 조각.json` | 조각 추출 |
| `hwpx fragment import <대상> <조각.json> --section N --index I [--parent 주소] [--before] -o 출력.hwpx` | 조각 가져오기(게이트 포함) |
| `hwpx fill <파일> --data d.json [--template t.json] -o 출력 [--mode baseline\|strict\|repair] [--missing error\|empty\|keep] [--dry-run] [--report r.json] [--overwrite]` | 생성 |
| `hwpx validate <파일> [--baseline 원본] [--strict] [--json]` | 검사 |
| `hwpx diff <원본> <결과> [--json]` | 항목별 동일 여부와 수량 비교 |
| `hwpx compile <파일> -o 승격본 --experimental` | `{{}}`를 누름틀로 |

- 종료 코드: 0 성공, 1 검사·게이트 실패, 2 사용법 오류·읽을 수 없는 입력.
- 출력 경로가 입력과 같으면 거부한다. 출력이 이미 있으면 `--overwrite` 없이는 거부한다. 임시 파일에 쓰고 이름을 바꾼다. 실패하면 아무 파일도 남기지 않는다.
- 보고서에는 값 원문을 넣지 않는다.

### 8.5 형식 중립 경계

`src/template/`의 다음은 문서 형식을 모른다(HWPX 모델을 import하지 않는다): 데이터 묶음 읽기, 값 해석·변환, 조건 평가, 규칙 선별, `{{}}` 문법 인식(문자열에서), 누락 정책, 보고서 자료 구조. HWPX에 묶인 것(앵커 해석, 자리별 채움, 구조 액션, 게이트)은 `src/fill/`에 둔다. md·txt 어댑터(9절)는 `src/template/`만 공유한다.

### 8.6 S3b 수용 조건

[검증 기준](validation.md) 8절의 E1~E13을 테스트로 만든다. 추가:

| ID | 조건 |
| --- | --- |
| G1 | 조건 평가: 연산자 14종 각각의 참·거짓 사례, `all`·`any`·`not` 조합 |
| G2 | `missing` 세 정책이 각각 명세대로 동작한다. `error`일 때 출력 없음 |
| G3 | 같은 입력으로 두 번 생성하면 출력 바이트가 같다 |
| G4 | 게이트가 일부러 넣은 결함을 잡는다: 계획 밖 구간을 바꾼 출력, 값이 다른 재읽기, 수량 불일치 |
| G5 | CLI: 명령 8종의 성공 경로와 종료 코드 0·1·2, 실패 시 출력 파일 없음 |
| G6 | 후보 자리: 시험 문서에서 누름틀·`{{}}`·빈 값 셀이 목록에 나온다 |

- 앵커 5종: `field`, `word`, `line`, `object`, `cell`.
- 템플릿 `template.json`: `anchors[]`, `rules[]`(조건 and/or/not·존재·같음·비교, 액션 `fill`·`delete`·`inject`·`insertText`).
- 데이터 묶음: `dataset.json`(원천)과 `derived/`(파생)로 템플릿과 독립이다.
- 누름틀 채움: 이름 정확 일치, 안내문과 비교하지 않고 치환, `dirty="1"`.
- 텍스트 치환: 같은 글자모양의 연속 조각만 한 덩어리로 본다. 경계를 가로지르면 `skipped`로 보고한다.
- 텍스트가 바뀐 구역은 조판 캐시(`linesegarray`)를 전부 지운다.
- 검사기: 참조 무결성·인스턴스 중복·패키지·구조 검사, 기준선/엄격/수리 세 방식, 구조 비교.
- CLI: `inspect`, `candidates`, `fragment extract|import`, `compile`, `fill`, `validate`, `diff`.

## 9. S4 — md·txt 어댑터 (`src/text/`)

HWPX가 우선이다. md·txt는 같은 규칙·데이터 계층(8.2의 조건·액션·데이터 묶음)을 쓰는 최소 어댑터로 둔다.

- 입력과 출력은 UTF-8 문자열이다. 줄바꿈 방식(LF·CRLF)과 BOM을 보존한다.
- 블록: txt는 줄 하나가 블록이다. md는 빈 줄로 나뉜 덩어리가 블록이고, 울타리 코드 블록과 파이프 표는 한 블록으로 본다.
- 앵커: `field`(`{{이름}}` 표기), `line`(블록 서수 + 글 지문), `word`(블록 안 문자 구간 + 지문), `cell`(md 파이프 표의 행·열), `object`(md 표·코드 블록의 서수).
- 액션: `fill`, `delete`(블록·표 행), `inject`(텍스트 조각: 문자열 블록 목록), `insertText`. 조건 평가와 값 해석은 형식 중립 계층을 그대로 쓴다.
- 코드 블록 안의 `{{}}`는 기본으로 채우지 않는다(옵션으로 허용).
- 검사: 남은 `{{}}`(채우기로 한 것), md 표의 열 수 일치.
- 함수: `generateText(text, kind: "md" | "txt", template, dataset, options): { ok, output?, report }`
- CLI: `hwpx fill`이 확장자로 형식을 고른다(`.hwpx`, `.md`, `.txt`).

| ID | 수용 조건 |
| --- | --- |
| T1 | txt·md에서 `{{}}` 채움, 누락 정책 3종 |
| T2 | 조건에 따른 블록 삭제와 텍스트 조각 주입 |
| T3 | md 표 셀 채움과 행 삭제, 열 수 유지 |
| T4 | 줄바꿈 방식과 BOM 보존, 손대지 않은 블록은 문자 그대로 |
| T5 | 코드 블록 안 `{{}}`는 기본으로 그대로 |
| T6 | 같은 템플릿 규칙·데이터 묶음을 hwpx와 md 양쪽에 써서 같은 값이 들어간다 |
