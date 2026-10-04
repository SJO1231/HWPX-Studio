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

코드는 `영역_내용` 형식의 대문자다. 영역: `PKG`(패키지·ZIP), `XML`, `MODEL`, `EDIT`, `FRAG`, `FMT`(서식), `TPL`(템플릿), `DATA`, `FILL`, `VAL`(검사), `REPAIR`, `GATE`, `PRESERVE`, `REREAD`, `TEXT`, `DIFF`, `TABLE`(표 조정).

**2판 템플릿 계약의 영역과 코드** (8.8, 2026-10-04. 근거: 이슈 #4 설계안(독립 설계자) + 총괄 임시 선택. 전부 **[계약]**이고 **[미구현]**이다)

영역 4개를 더한다: `SEL`(선택), `MIG`(lite 이관), `PROTO`(블록 원형), `PLACE`(값 자리). 종류가 "경고"·"보고"가 아니면 오류다. 뜻과 발생 지점은 정본 열의 소절이 정한다. `MIG_*`는 lite 앱의 이관 코드(Codex)가 내고, 이 명세는 이름과 뜻을 소유한다.

| 영역 | 코드 | 종류 | 뜻 | 정본 |
| --- | --- | --- | --- | --- |
| `TPL` | `TPL_VERSION` | 오류 | 지원하지 않는 판 번호(`template@3`·`@0`, `case@2`, `block-proto@2`) | 8.8.10 |
| `TPL` | `TPL_SCHEMA` | 오류 | schema가 없거나 이름이 다르다(1판에도 있는 코드. 2판 형식에도 쓴다) | 8.8.10 |
| `TPL` | `TPL_FIELD` | 오류 | 2판 파일의 모르는 키·빠진 필드·틀린 형식 | 8.8.10 |
| `TPL` | `TPL_ID` | 오류 | id의 형식이 틀렸거나 템플릿 안에서 겹친다(종류 안·종류 사이) | 8.8.3 |
| `TPL` | `TPL_NAME_DUP` | 오류 | 표시 이름이 값끼리 또는 슬롯끼리 겹친다(NFC 비교) | 8.8.3 |
| `TPL` | `TPL_REF` | 오류 | 끊긴 참조(자리의 값·앵커, 슬롯의 앵커, 블록의 슬롯, 조건 경로, 연결의 값, 이번 건의 id) | 8.8.10 |
| `TPL` | `TPL_CYCLE` | 오류 | 슬롯 → 부모 블록 → 슬롯 순환, 자기 부모 | 8.8.6 |
| `TPL` | `TPL_KEY_CONFLICT` | 오류 | 한 키를 두 값에 연결, 같은 종류·같은 키의 자리를 다른 값에 연결 | 8.8.4 |
| `TPL` | `TPL_UNBOUND_VALUE` | 오류 | 쓰이는 값에 연결이 없다 | 8.8.4 |
| `TPL` | `TPL_MIXED_RULES` | 오류 | 1판 `rules[]`와 `slots`·`places`를 함께 썼다 | 8.8.11 |
| `TPL` | `TPL_NESTED` | 오류 | 중첩 슬롯(`parent`가 null이 아님)으로 생성하려 했다(예약) | 8.8.6 |
| `TPL` | `TPL_PROTO_MISMATCH` | 오류 | 블록 내용이 고정한 원형 판의 내용과 다르다 | 8.8.7 |
| `TPL` | `TPL_SOURCE_MISMATCH` | 오류 | 생성 입력 원본의 해시가 `source.sha256`과 다르다 | 8.8.12 |
| `DATA` | `DATA_ALIAS_CONFLICT` | 오류 | 한 값의 키·별칭 둘 이상에 값이 있다 | 8.8.4 |
| `DATA` | `DATA_FORMAT` | 오류 | `money` 값이 정수로 읽히지 않는다 | 8.8.4 |
| `ANCHOR` | `ANCHOR_CHANGED` | 오류 | `range`의 양 끝은 찾았으나 안쪽 해시가 다르다 | 8.8.13 |
| `ANCHOR` | `ANCHOR_UNVERIFIED` | 경고 | 지문 없는 `cell`·`object`(1판 승계). 원본 해시가 같을 때만 쓴다 | 8.8.13 |
| `PLACE` | `PLACE_COVERED` | 보고 | 자리가 블록 교체 범위 안에 들어 `dropped`로 빠졌다(오류 아님) | 8.8.12 |
| `PLACE` | `PLACE_UNREGISTERED` | 오류·경고 | 등록되지 않은 `{{ 키 }}`. `unregistered: error`이면 오류, `keep`이면 경고 | 8.8.12 |
| `FILL` | `FILL_SKIPPED` | 오류 | 2단계(값)에서 건너뜀이 1건이라도 있다 | 8.8.12 |
| `SEL` | `SEL_UNDECIDED` | 오류 | 슬롯 선택이 정해지지 않았다(동률·후보 없음·조건 값 없음·확정 필요) | 8.8.8 |
| `SEL` | `SEL_RECHECK` | 오류 | 저장한 선택을 다시 확인해야 한다(블록 없어짐·내용 변경·상위 변경) | 8.8.8 |
| `PROTO` | `PROTO_UNBOUND_KEY` | 오류 | 원형의 키 가운데 그 템플릿에 자리·연결이 없는 것이 있어 전파를 막는다 | 8.8.7 |
| `MIG` | `MIG_VERSION` | 오류 | lite 프로젝트 `version`이 1이 아니다 | 8.8.14 |
| `MIG` | `MIG_SCHEMA` | 오류 | lite `checkProject`가 실패한다 | 8.8.14 |
| `MIG` | `MIG_NO_MASTER` | 오류 | hwpx 모드인데 원본(첫 소스)이 없거나 열리지 않는다 | 8.8.14 |
| `MIG` | `MIG_PLACE` | 오류 | Master가 아닌 곳을 가리키는 word 대상 | 8.8.14 |
| `MIG` | `MIG_RANGE` | 오류 | 범위가 Master가 아니거나 문서 밖이거나 겹친다 | 8.8.14 |
| `MIG` | `MIG_BLOCK_SOURCE` | 오류 | hwpx 조각 블록의 원본이 없거나 범위 밖이거나 `FRAG_*`로 추출이 실패한다 | 8.8.14 |
| `MIG` | `MIG_BLOCK_RENDER` | 오류 | hwpx 모드의 Markdown 블록을 조각으로 만들지 못한다 | 8.8.14 |
| `MIG` | `MIG_CONDITION` | 오류 | 조건 문자열을 엔진 `Condition`으로 읽지 못한다 | 8.8.14 |
| `MIG` | `MIG_RESULT_DIFF` | 오류 | 옛 경로와 새 경로의 결과 차이가 정책 차이(`MIG_POLICY`)가 아니다. 이관은 아무것도 쓰지 않는다 | 8.8.14 |
| `MIG` | `MIG_DROPPED_DONOR` | 경고 | 두 번째 이후 소스가 조각 추출 말고는 쓰이지 않아 템플릿에 넣지 않았다 | 8.8.14 |
| `MIG` | `MIG_DROPPED_CANDIDATE` | 경고 | 미승인·고정·블록 Field와 후보 부속 정보를 버렸다(수만 보고) | 8.8.14 |
| `MIG` | `MIG_ORPHAN_BLOCK` | 경고 | 범위·표식이 없는 그룹의 블록을 버렸다 | 8.8.14 |
| `MIG` | `MIG_SELECTION` | 경고 | `selectedBlocks`가 가리키는 블록이 없다 | 8.8.14 |
| `MIG` | `MIG_POLICY` | 경고 | lite가 동률·조건 값 누락을 묻지 않고 고른 건(새 경로는 `SEL_UNDECIDED`). 실패로 세지 않고 목록으로 남긴다 | 8.8.14 |

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
- `HwpxPackage = { archive, bytes, rootfile, headerEntry, sectionEntries, manifestItems[{id, href, mediaType}], binaryEntries[], issues }` (`rootfile`은 `content.hpf`의 항목 이름)

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

**BodyRef**: 본문 요소가 자원을 가리키는 속성. `{ kind, id, element, attr 위치 }`. 대상: `charPrIDRef`, `paraPrIDRef`, `styleIDRef`, `borderFillIDRef`, `binaryItemIDRef`, `outlineShapeIDRef`(numbering), `charStyleIDRef`(글자 스타일 → style), 글자 겹침 안 `charPr` 요소의 `prIDRef`(→ charPr). "참조 없음" 관례값(`4294967295`, `-1`)과 빈 값은 참조로 세지 않는다. 그 밖에 이름이 `IDRef`로 끝나는 속성은 `kind: "unknown"`으로 모은다(경고 대상).

`collectBodyRefs(element)`: 요소와 그 후손 전체의 BodyRef를 모은다.

### 5.3 누름틀 조회 `listFields(doc): FieldInfo[]`

- `FieldInfo = { name, type, occurrence(같은 이름 안 순번, 0부터), sectionIndex, path, valueText, dirty, shape }`
- `shape`(2026-10-04 7종): `simple`(begin·end가 같은 문단, 사이에 글이 있고 인라인·객체 조각 없음) / `empty`(사이가 빔) / `inline`(같은 문단, 사이에 탭·줄바꿈 같은 인라인 조각만 있고 객체 없음) / `object`(같은 문단, 사이에 표·그림·중첩 컨트롤 같은 객체 조각이 있음) / `crossParagraph`(끝 표식이 같은 컨테이너의 다른 문단에 있음. `endPath`에 끝 문단 경로) / `crossContainer`(끝 표식이 다른 컨테이너·구역에 있음) / `unpaired`(끝 없음). `crossParagraph`의 `valueText`는 빈 문자열이다.
- `type`이 `HYPERLINK`인 필드는 목록에서 뺀다. 그 밖의 알 수 없는 type은 포함한다. 단, 누름틀 암묵 채움(8.3)과 빠른 생성 화면([스튜디오 명세](studio-spec.md) 4a)은 `type`이 `CLICK_HERE`인 누름틀과 **키가 있는 메일 머지 필드**(`type`이 `MAILMERGE`, `name`은 비어 있고 `parameters`의 `stringParam name="FieldValue"`가 키. `FieldInfo.mergeKey`, 2026-10-04 이슈 #18)만 자리로 다룬다(책갈피·날짜·키 없는 메일 머지 같은 다른 필드는 건드리지도 보고하지도 않는다). 메일 머지 필드의 `occurrence`는 같은 키 안에서 센다.

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
- 시작과 끝 사이에 객체 조각이 낀 누름틀의 shape는 `object`(2026-10-04 전에는 `inline`)이다. `crossParagraph`·`unpaired`의 `valueText`는 빈 문자열이다.
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
- 범위가 누름틀의 시작과 끝 사이를 자르면 `FRAG_SPLITS_FIELD`로 거절한다.
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
  instanceIds: { role: "paragraph" | "object" | "inst" | "fieldBegin" | "fieldEndRef"; value: string; start: number; end: number }[]
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
   - 대상 header에 해당 목록 요소가 없으면 목록을 만든다(7.8의 수정 1). `refList`나 글꼴 목록 전체가 없을 때만 `FRAG_NO_LIST`로 거절한다.
3. **본문 재작성**: 조각 원문의 참조 속성값을 대응표대로 바꾼다. 줄 배치 캐시 구간을 지운다.
4. **인스턴스 id**: 객체 id·instId가 대상에 이미 있거나 자리값(`0`, 빈 값)이면 새 값(대상과 조각을 합친 가장 큰 숫자 + 1부터)을 준다. 필드는 시작 id와 끝의 `beginIDRef`를 함께 바꾼다. 문단 id는 자리값(빈 값, `0`, `2147483648`, `4294967295`)이 아니고 대상에 이미 있을 때만 새 값(문단 id 최댓값 + 1부터, 자리값은 건너뜀)으로 바꾼다.
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

후속 수정(구현·검증 완료, 테스트 414개와 오라클 23개 통과):

- **문단 id**: 조각의 문단 id가 자리값이 아니고 대상에 이미 있으면 새 값으로 바꾼다(같은 문서에 다시 넣을 때 중복 오류가 나던 문제).
- **없는 참조의 id는 건너뛴다**(최종 검증 뒤 변경): 대상에서 없는 자원을 가리키던 id를 새 자원이 차지하면 기존 문단의 모양이 달라질 수 있다(실제 문서 2쌍에서 관측). 그래서 조각 가져오기와 서식 파생 모두 새 id를 줄 때 그런 id를 건너뛴다. 대상의 없는 참조는 그대로 없는 채로 남는다.
- 소스에서 없는 대상을 가리키던 참조는 그대로 옮긴다(`FRAG_DANGLING_SOURCE` 경고). 대상에 같은 id가 있으면 그 자원을 가리키게 된다. 원본이 깨끗하면 생기지 않는다.
- `HwpxPackage`에 rootfile 경로를 둔다.
- 문단 해석에서 객체와 하위 목록의 대응을 한 번의 순회로 만든다(하위 목록 2만 개 문단이 0.1초 안팎).
- 알려진 한계: 이전 형식으로 저장한 조각 JSON에는 문단 id 항목이 없어 재발급이 일어나지 않는다. 조각 안에서만 겹치는 문단 id는 그대로 들어간다. `FRAG_FILLS_DANGLING`은 header 자원만 본다(이진 자료 id는 보지 않는다).
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

**S2b 구현에서 확정한 것 (2026-10-01)** — R1~R7 통과(테스트 55개). 한컴 13으로 결과를 열어 그 위치의 글자모양·문단모양을 읽은 대조 292건이 요청값과 전부 일치했고 쪽 수는 변하지 않았다(선택 실행).

- 적용한 서식: 글자 27종(장평 50·200, 자간 -50·50, 상대 크기, 글자 위치, 강조점, 외곽선, 그림자, 양각, 음각, 위·아래첨자, 취소선·밑줄 모양과 색, 음영색, 크기, 글자색, 커닝, 글꼴), 문단 12종(배분·나눔·가운데 정렬, 줄 간격 4종류, 내어쓰기, 들여쓰기, 여백·앞뒤 간격, 줄 나눔 기준, 탭 정의), 문단 테두리.
- **한컴 저장본의 문단모양은 조건 분기의 두 갈래가 단위가 다르다.** `default` 갈래의 여백·고정 줄 간격 값은 `case` 갈래의 정확히 2배다(관측한 40여 쌍 전부). 퍼센트 줄 간격은 같다. 그래서 `setAttr`에 `defaultBranchValue`(선택)를 두고, 문단 편의 생성기는 두 갈래에 맞는 값을 각각 쓴다. 갈래가 없는 문서의 값은 `case`와 같은 단위다.
- **진하게·기울임 등은 자식 요소로 쓴다.** 한컴은 요소만 읽는다. 속성만 있는 표기(합성 시험 문서 D1~D7의 기울임)는 한컴이 무시한다. 끌 때를 위해 `removeAttr` 연산을 더했다.
- `addChild`는 같은 이름 자식이 있으면 속성만 덮어쓴다(같은 delta를 여러 기준에 쓰기 위해).
- 자식 순서는 시험 문서와 한컴 저장본에서 관측한 정적 표(`order.ts`)를 따른다. 표에 없는 자식은 `FMT_UNKNOWN_CHILD`.
- 끄는 요청은 한컴의 "끈 상태" 값으로 되돌린다. 양각↔음각, 위첨자↔아래첨자는 서로 배타로 다룬다.
- 글자모양이 바뀌지 않는 run은 쪼개지 않는다. 구간 전체가 이미 같은 모양이면 계획이 비어 있다.
- 쪼개기 규칙: 한 글자 엔티티는 가르지 않는다. 구간의 시작·끝이 **글자 묶음** 경계가 아니면 `FMT_BAD_RANGE`다(서로게이트 쌍, 결합 부호, 옛한글 조합 자모, 이모지 묶음. `Intl.Segmenter`로 판정. 탭·객체 자리는 각각 한 묶음). CDATA 가운데에서는 닫고 다시 연다. run 자식 사이에서는 run만 닫는다.
- 줄 배치 캐시는 그 구역 전부를 지운다.
- 문단 테두리를 새로 만들 때는 두 단계다(테두리 파생·적용 → 다시 파싱 → 문단모양이 그것을 가리키게).
- `createDeriver(doc)`: 여러 자원을 한 번에 파생해 새 id가 겹치지 않게 한다. 결과에 `reused`가 있다.
- 추가한 코드: `FMT_KIND`, `FMT_BASE_NOT_FOUND`, `FMT_NO_LIST`, `FMT_UNKNOWN_CHILD`, `FMT_FONT_NOT_FOUND`, `FMT_BAD_VALUE`, `FMT_BAD_OP`, `FMT_PATH`, `FMT_NO_PREFIX`, `FMT_TARGET`, `FMT_BAD_RANGE`, `FMT_NO_BASE`, `FMT_INTERNAL`.
- 지원하지 않는 것: 스타일 파생, 글자 테두리·번호·글머리표·대각선·그라데이션의 편의 생성기(일반 연산으로만 가능).
- 한컴이 읽어 주지 않아 대조하지 못한 것: 문단 테두리 왼쪽 색, 일부 줄 나눔 속성, "끄는" 요청.
- 기준 자원에 없는 참조가 있으면(탭 목록이 빈 합성 문서) 파생 자원도 그 참조를 물려받아 경고가 는다. 오류는 아니다.

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

**첫 캠페인 결과 (2026-10-01, 시드 1, 쌍 150개 × 방식 8가지 = 1,200건)**

실제 문서 659건 중 열린 642건에서, 스타일·글꼴·폴더가 서로 다른 쌍만 뽑았다. 구간 길이는 20~200문단(중앙값 160), 구간마다 표가 있고 절반 이상에 중첩 표·그림·필드가 있었다.

| 분류 | 건수 | 내용 |
| --- | --- | --- |
| 정상 | 942 | 글·서식 지문·대상 불변·수량·이진 자료·결정성 전부 통과 |
| 거절 | 94 | `FRAG_NO_LIST`. 대상 header에 글머리표 목록(92건)이나 탭 목록(2건)이 없음 |
| 상속 | 29 | 소스가 원래 없는 대상을 가리키던 참조를 옮김 |
| 결함 | 58 | 소스가 원래 갖고 있던 id 중복(그리기 묶음 안 개체 43건, 표 셀 안 문단 15건)을 그대로 옮겨 대상에 새 오류로 나타남 |
| 건너뜀 | 77 | 대상에 표가 없음 등 |

- 글 비교 866,727문단, 서식 지문 비교 약 357만 건에서 불일치 0. 코드 없는 예외 0. 같은 조각의 두 번째 가져오기에서 추가 자원 0.
- 오라클 표본 30건(145~200문단, 그림·글상자·중첩 표 포함): rhwp 30/30 파싱, 한컴 13에서 30/30 열림·PDF 저장.
- 실제 문서의 94.5%는 header에 글머리표 목록이 없다. 27.1%는 번호 목록이, 3.4%는 탭 목록이 없다.
- 표 셀 안에 넣은 경우, 표가 "글자처럼 취급"이거나 쪽 나눔이 없으면 한컴의 쪽 수가 거의 늘지 않았다(내용이 잘리는지는 쪽 수만으로 확인하지 못했다).

**캠페인에 따른 수정(확정)**

1. **없는 목록 만들기**: 대상 header에 필요한 자원 목록이 없으면 `FRAG_NO_LIST`로 거절하지 않고 목록 요소를 만든다. 위치는 관측한 목록 순서(글꼴, 테두리, 글자모양, 탭, 번호, 글머리표, 문단모양, 스타일, 그 밖)를 따른다.
2. **상속한 문제는 새 오류가 아니다**: 조각이 소스에서부터 갖고 있던 문제(조각 안에서 겹치는 id, 없는 대상을 가리키는 참조)는 계획의 `inherited`에 기록한다. 저장 게이트는 이것에서 비롯한 오류를 대상의 새 오류로 세지 않고 경고로 보고한다. 기본은 소스 원문 그대로 옮기는 것이다(그리기 묶음 안 개체의 id는 다른 요소가 가리킬 수 있어 함부로 바꾸지 않는다).
3. 선택 기능 `reissueInternalDuplicates`: 조각 안에서 겹치는 문단 id와 객체 id도 새 값으로 바꾼다(기본 끔).
4. 빈 이진 참조(`binaryItemIDRef=""`)는 참조 없음으로 본다.
5. 표 셀 안에 넣을 때 그 표가 "글자처럼 취급"이거나 쪽 나눔이 없으면 `FRAG_CELL_MAY_CLIP` 경고를 낸다. 쪽 나눔이 `TABLE`(행 경계에서만 나뉨)인 표도 같은 경고를 낸다(S5에서 추가. 한컴 PDF에서 잘림을 확인).

**수정 구현과 재실행 결과 (2026-10-01, 같은 시드, 쌍 150개 × 방식 10가지 = 1,500건)**

| 분류 | 첫 실행(8방식) | 재실행(10방식) |
| --- | --- | --- |
| 정상 | 942 | 1,294 |
| 거절 | 94 | 0 |
| 상속 | 29 | 129 |
| 결함 | 58 | 0 |
| 건너뜀 | 77 | 77 |

- 새 방식: M9(조각 안 중복 id까지 재발급해 통째 가져오기), M10(가져온 구간에 서식 변경 적용: 글자 서식 21가지와 문단 서식 15가지를 무작위 구간에 3~8곳, 2~4곳).
- M10: 서식 적용 1,281건(글자 823, 문단 458) 중 거절 0. 문단 글 불변, 구간 밖 서식 지문 불변, 요청 속성 확인 1,717건 통과.
- 목록을 만들어 통과한 건 118건(목록 149개).
- 오라클 표본 40건(M10 8, 셀 안 8, 목록 생성 9 포함): rhwp 40/40 파싱, 한컴 13에서 40/40 열림·PDF 저장. 쪽 수가 줄어든 건 없음.
- 셀 안 삽입에서 `FRAG_CELL_MAY_CLIP` 경고가 난 6건은 200문단을 넣고도 한컴 쪽 수가 0~2쪽만 늘었다. 경고가 없는 2건은 24쪽, 75쪽 늘었다. 경고가 난 경우 내용이 표 밖으로 넘치지 못하는 것으로 보인다(화면 확인은 별도).
- 실제 문서 659건은 시험 전후 변함없음.

구현에서 정한 이름과 모양:

- `planImport`는 `ImportPlan = EditPlan & { inherited }`를 돌려준다. `inherited = { duplicateIds: { role, value, count }[], danglingRefs: { kind, id, count }[] }`. 경고 `FRAG_INHERITED_DUP`.
- 조각에 `dangling`(소스에서 없던 참조의 기록)이 있다. 이전 형식 조각은 빈 목록으로 읽고, 그 경우 게이트는 상속을 설명하지 못해 막는다.
- 게이트는 새 오류 가운데 `inherited`로 설명되는 것(`INST_DUP_ID`, `FIELD_MULTI_END`, `RES_DANGLING`)을 `report.inherited`로 옮기고 경고 `GATE_INHERITED`를 낸다. `strict`에서는 막는다.
- `planImport(…, { reissueInternalDuplicates: true })`. `generate`의 같은 이름 옵션과 CLI의 `--reissue-internal`로 연결돼 있다.
- 계획 `summary`에 `createdLists`가 있다. 새 글머리표·번호의 id는 빈 목록이면 0부터다(한컴이 0번 글머리표를 정상으로 읽는 것을 확인).
- 보정: `fixCounts`는 `itemCnt`·`fontCnt`만, `fixSectionCount`(기본 끔)가 구역 수 선언을 고친다.
- 빈 `binaryItemIDRef`는 조각·모델에서 참조 없음이다. 검사기는 경고 `RES_EMPTY_REF`로 다룬다.

### 7.9 표 조정 (`src/table/`) — S5 (사용자 지시, 2026-10-01)

표는 새로 만들든 기존 것이든 크기와 설정을 함께 갖는다. 조각을 셀에 넣거나 구조가 달라지는 템플릿에서는 표 자체를 조정할 수 있어야 한다.

**실제 문서의 표** (642건, 표 7,037개, 수량 집계): 글자처럼 취급 73%, 쪽 나눔은 셀 단위 70%·없음 29%, 제목 행 반복 92%, 병합이 든 표 38%(셀 수로는 18%), 중첩 표 909개, 셀 세로 정렬 가운데 97%, 최대 261행·65열. 글자처럼 취급 표는 쪽을 넘지 못해 셀에 긴 내용을 넣으면 잘린다(7.8, 검증 기준 10절).

**표의 구성** (한컴 저장본에서 관측)

- `tbl` 속성: `pageBreak`(CELL·NONE·TABLE), `repeatHeader`, `rowCnt`, `colCnt`, `cellSpacing`, `borderFillIDRef`, `textWrap`, `textFlow`, `noAdjust`, `lock`
- `sz`: `width`, `height`(단위 HWPUNIT), 기준(`widthRelTo`·`heightRelTo`), `protect`
- `pos`: `treatAsChar`, `flowWithText`, `allowOverlap`, 세로·가로 기준과 정렬, 오프셋
- `outMargin`, `inMargin`: 바깥 여백, 셀 기본 안 여백
- 선택 요소: `caption`, `cellzoneList`, `label`
- 셀 `tc`: `header`, `hasMargin`, `protect`, `editable`, `borderFillIDRef`, `subList`(`vertAlign`, `lineWrap`), `cellAddr`, `cellSpan`, `cellSz`(`width`, `height`), `cellMargin`

**원칙**: 변경은 구간 치환이다. 새 요소는 기존 것을 복제해 만든다(행은 기존 행, 표는 기존 표). 표와 셀의 수치가 서로 맞아야 한다(행·열 수, 주소, 병합, 열 너비의 합과 표 너비). 글이 있는 구역의 줄 배치 캐시는 지운다.

**연산**

| 단계 | 연산 | 내용 |
| --- | --- | --- |
| 1 설정 | `planSetTableProps` | 글자처럼 취급, 쪽 나눔, 제목 행 반복, 가로 정렬, 바깥·안 여백, 셀 간격, 테두리 |
| 1 설정 | `planSetCellProps` | 세로 정렬, 줄 나눔, 제목 셀, 셀 여백, 테두리(서식 변경의 파생 자원), 보호 |
| 2 크기 | `planSetColumnWidths` | 열 너비 지정. 병합 셀은 걸친 열의 합. 표 너비는 열 합으로 맞춘다 |
| 2 크기 | `planScaleTable` | 표 전체 너비를 비율이나 목표값으로 바꾸고 열을 비례 조정 |
| 2 크기 | `planSetRowHeights` | 행 높이(최소 높이) 지정. 표 높이는 바뀐 만큼만 더하고 뺀다(7.91) |
| 3 구조 | `planInsertRows` | 기존 행을 원형으로 복제해 넣는다(글은 비우거나 유지). 뒤 행 주소·행 수·표 높이 갱신. 세로 병합에 걸리면 병합을 늘리거나 거절 |
| 3 구조 | `planRepeatRows` | 데이터 배열의 원소마다 원형 행을 복제하고 행 안의 `{{}}`를 원소로 채운다(템플릿 액션 `repeat`) |
| 3 구조 | `planInsertColumns`, `planDeleteColumns` | 열 복제·삭제. 열 주소·열 수·너비 갱신 |
| 3 구조 | `planMergeCells`, `planSplitCell` | 병합·분할 |
| 4 새 표 | `planCloneTable` | 문서나 조각의 기존 표를 원형으로 복제해 행·열 수를 맞춘다 |

- 템플릿 액션에 `tableProps`(표·셀 설정), `resize`(열 너비·표 너비), `repeat`(행 반복)을 더한다.
- `inject`에 `fitTable: "allowBreak"`: 삽입 지점을 감싸는 표 가운데 잘릴 수 있는 표(글자처럼 취급이거나, 쪽 나눔이 `NONE` 또는 `TABLE`)를 쪽을 넘길 수 있게 바꾼다(글자처럼 취급 끔, 쪽 나눔 `CELL`). 한 일은 보고서의 `tableChanges`에 남는다. 기본은 바꾸지 않고 경고만 낸다.
- 쪽 나눔 값의 뜻 [확인: 한컴 13 PDF]: `CELL`은 셀 안의 글도 쪽을 넘는다. `TABLE`은 행 경계에서만 나뉘어 한 셀이 쪽보다 길면 잘린다. `NONE`은 나뉘지 않는다.
- 조정으로 표의 위치나 흐름이 달라질 수 있는 설정(글자처럼 취급 등)은 사용자가 고른 경우에만 바꾼다.

**수용 조건**

| ID | 조건 |
| --- | --- |
| B1 | 설정 변경 뒤 다시 파싱하면 요청한 속성만 바뀌고 나머지 원문은 그대로다 |
| B2 | 열 너비 변경 뒤 모든 행에서 셀 너비의 합이 표 너비와 같다(병합 포함). 실제 문서 표 표본에서 불변식이 유지된다 |
| B3 | 행 삽입·반복 뒤 행 수, 셀 주소, 병합 범위가 맞고 검사기 새 오류가 없다. 복제한 행의 서식 참조는 원형과 같다 |
| B4 | 한컴 대조(선택 실행): 결과를 한컴으로 열어 표 속성(글자처럼 취급, 쪽 나눔, 제목 행 반복, 너비)과 행·열 수를 읽으면 요청과 같다. 쪽 수가 터무니없이 변하지 않는다 |
| B5 | 잘림 해소: "글자처럼 취급" 표의 셀에 긴 조각을 넣고 `fitTable: "allowBreak"`를 쓰면 한컴 PDF에서 내용이 끝까지 보인다 |
| B6 | 행 반복: 배열 길이 0·1·여러 개, 병합 셀이 든 원형 행, 제목 행 반복이 켜진 표 |
| B7 | 실제 문서 표 표본(병합·중첩 포함)에 무작위로 설정·크기·행 조작을 적용해 검사기 새 오류 0, 한컴 표본 열림 |

### 7.91 S5 구현에서 확정한 것 (2026-10-01)

구현 상태: 연산 12종, 템플릿 액션 3종과 `fitTable`, CLI `table`, B1~B7 통과. 독립 검증에서 나온 결함을 고친 뒤 재검증에서 수용 판정. 근거는 [검증 기준](validation.md) 11절.

**실제 문서에서 센 것** (표 7,037개): 크기 기준은 가로·세로 전부 절대값. 구조 불규칙 0개, 너비 불규칙 167개(문서 40건). 규칙적인 표 98%. 행별 셀 너비 합이 표 너비와 같은 표 95%. 표 높이가 행 높이 합과 같은 표 65%(표가 더 큰 경우 28%, 작은 경우 5%).

**대상과 격자**

- 대상은 `TableTarget = { sectionIndex, element }`다. 중첩 표도 가리킨다. `listTables(doc)`가 표마다 위치·깊이·행×열·크기·설정·병합 수·규칙성(`structureRegular`, `widthRegular`, 둘 다 참이면 `regular`)을 준다.
- `readTableGrid(table)`가 셀 주소·병합·크기로 격자를 만든다. 불규칙은 두 가지다.
  - **구조 불규칙**(겹침, 빈칸, 행·열 수 불일치, 주소 문제): 크기·구조 연산을 모두 `TABLE_IRREGULAR`로 거절한다.
  - **너비 불규칙**(행마다 열 경계의 위치가 다름): 열 너비가 필요한 연산(비례 조정, 열 삽입·삭제, 병합·분할, 열 수를 바꾸는 복제)만 거절한다. 행 삽입·반복, 행 높이, 열 너비 지정(새 너비를 주므로), 행 수만 바꾸는 복제는 된다.
  - 설정 연산은 격자와 무관하게 동작한다.
- **열 너비는 경계 위치로 구한다**: 각 행에서 셀을 왼쪽부터 놓으면(위에서 내려온 세로 병합 포함) 셀의 양쪽 경계 위치가 누적 합으로 정해진다. 같은 경계를 여러 행이 다르게 말하면 너비 불규칙이다. 어느 행에서도 셀 가장자리가 아닌 경계(병합으로만 덮인 열 묶음의 안쪽)는 양옆의 아는 경계 사이를 균등하게 나눈다. 행 높이도 같은 방식으로 구하되, 어긋나면 거절하지 않고 그 행 셀 높이의 최댓값을 쓴다. (독립 검증에서 나온 결함의 수정: 이전 추정은 병합 셀끼리 모순되는 값을 받아들여 실제 문서의 표 190개에서 분할·열 삭제가 행 너비 합을 깼다.)
- `checkTableGeometry(table)`: 행·열 수, 주소, 병합, 행별 너비 합을 본다(`TABLE_CELL_PARTS`, `TABLE_COUNT`, `TABLE_ADDR`, `TABLE_WIDTH_SUM`). 테스트와 스트레스 도구가 쓴다. 검사기에는 넣지 않았다(실제 문서의 5%가 원래 너비 합이 어긋난다).

**수치 규칙**

- 표의 `sz` 너비·높이는 증감분만 더하고 뺀다. 전체를 다시 계산하지 않으므로, 원래 표 크기와 행·열 합이 어긋난 문서는 그 어긋남이 그대로 남는다(높이는 35%가 어긋나 있어 다시 계산하면 원문이 달라진다).
- 비례 조정은 경계 위치를 조정한다(새 경계 = 반올림(경계 × 비율), 마지막 경계 = 목표 너비). 셀 너비는 끝 경계에서 시작 경계를 뺀 값이라 행별 합이 항상 맞는다. 비율 1이나 현재와 같은 너비는 편집이 없다. 결과 셀 너비가 1 미만이 되는 연산과 높이 1 미만인 셀을 만드는 분할은 `TABLE_BAD_ARG`(행 높이 지정은 0을 받는다).
- 크기 기준이 절대값이 아니면 `TABLE_RELATIVE_SIZE`(실제 문서에는 없었다).

**복제 규칙**

- 행·열 삽입과 원형 복제의 글 처리는 기본이 `clear`다. 행 반복의 복사본은 글을 두고 `{{}}`를 채운다.
- 복제한 범위 안의 객체 id·instId·누름틀 id는 새 값으로, 누름틀 끝의 짝 참조는 새 id로, 책갈피 이름은 접미사를 붙여 바꾼다. 셀 이름(`tc@name`)은 비운다.
- 복제하거나 지우는 범위가 누름틀의 시작과 끝 사이를 자르면 `TABLE_SPLITS_FIELD`(행·열 복제, 열 삭제, 병합).
- 원형 행을 세로 병합이 가로지르면 `TABLE_SPAN_CONFLICT`. `extendSpans`를 주면 위에서 내려오는 병합을 늘린다.
- 병합: 왼쪽 위 셀을 남긴다. 나머지 셀의 문단은 기본으로 그 뒤에 이어 붙인다(`content: "concat"`, 또는 `"first"`). 병합 결과 어느 행에 시작 셀이 하나도 남지 않으면 `TABLE_SPAN_CONFLICT`로 거절한다(빈 행이 있는 표는 한컴이 열지 못한다 [확인]. 한컴처럼 행을 접어 주지는 않는다).
- 분할은 병합 셀을 1×1로 되돌리는 것만 한다. 새 셀은 원 셀의 속성을 복사한다(원 셀이 끊어진 서식 참조를 가졌으면 새 셀도 갖는다. 게이트에서는 상속 문제로 센다). 1×1 셀은 `TABLE_BAD_ARG`.
- 편집한 문단의 줄 배치 캐시를 지운다.

**템플릿 액션** (8.2의 표에 추가)

- `tableProps`의 앵커는 `object`(표: `objectType`이 `tbl`, 또는 Markdown 표를 가리키는 `table`) 또는 `cell`, `resize`의 앵커는 `object`(표)이고, 구역 최상위 표만 가리킨다. 중첩 표는 API로만 다룬다. 템플릿의 `tableProps`에는 테두리가 없다(테두리는 API의 `border`).
- `repeat`: 앵커는 원형 행을 가리키는 `cell`. 행 안의 `{{<as>.이름}}`은 **원소에서만** 찾고(없으면 `options.missing` 정책. `derived`로 넘어가지 않는다), `{{<index>}}`는 1부터의 순번, 그 밖은 전체 데이터에서 찾는다. `as`와 같은 이름의 최상위 키는 원소가 가린다. 길이 0이면 원형 행을 지우고, 그것이 표의 마지막 행이면 표를 담은 문단을 지운다. 배열이 아니면 `DATA_NOT_ARRAY`. 반복 행 안의 `{{}}`는 `repeat`가 맡고 일반 채움에서 빠진다.
- 규칙이 겹칠 때: 같은 행을 지우는 `delete`는 버리고 보고한다. 같은 원형 행에 `repeat`가 둘이면 `TPL_CONFLICT`. 표가 지워지거나 교체되면 그 표의 `repeat`·`tableProps`·`resize`는 버리고 `dropped`에 남긴다. 행 삭제와 표 액션이 같은 표에 있으면, 지워지는 행 안의 편집은 빼고 남은 행에 적용한다(지운 행만 가리키는 항목은 `dropped`).
- 조건이 거짓인 `repeat`: 원형 행을 그대로 둔다. 그 행의 `{{<as>.…}}`와 `{{<index>}}`는 채우지 않고 `skipped`에 `REPEAT_INACTIVE`로 남긴다(오류가 아니다).
- 저장 게이트는 그대로 적용된다. 예상 수량 증감(표 행 `tableRows`, 셀 `tableCells` 포함)이 보고서에 들어가 수량 대조에 쓰인다.
- 편집이 0건인 표 액션(비율 1, 이미 그 값인 설정)은 구역을 바뀐 것으로 치지 않는다. 줄 배치 캐시도 그대로다.
- 오류 코드: `TABLE_NOT_FOUND`, `TABLE_BAD_ARG`, `TABLE_IRREGULAR`, `TABLE_SPAN_CONFLICT`, `TABLE_RELATIVE_SIZE`, `TABLE_UNSUPPORTED`, `TABLE_SPLITS_FIELD`, `TABLE_INTERNAL`, `DATA_NOT_ARRAY`, `REPEAT_ANCHOR_LOST`. 건너뜀 `REPEAT_INACTIVE`. 경고 `TABLE_FRAGMENT_EXTRA`(원형으로 쓴 조각에 표 말고 다른 것이 있음).

**한계**

- 병합이 행 전체를 덮는 경우는 거절한다. 1×1 셀을 더 쪼개지 못한다.
- 채움 단계의 행 삭제(`delete`의 `scope:"row"`, 원소 0개 `repeat`)가 셀을 가로지르는 누름틀을 자르는 경우는 계획 단계에서 잡지 않는다. 저장 게이트가 막는다(출력 없음).
- 머리말·꼬리말 컨트롤이 든 행이나 표를 복제하면 그 컨트롤 id가 복사본에도 같은 값으로 남는다(조각 가져오기도 같다. 실제 문서 3건에서 관측, 한컴은 열었다. 뜻에 미치는 영향은 확인하지 못했다).
- 채움 단계에서 행을 지워도 표의 높이 값은 줄지 않는다(S3b부터의 동작. 한컴은 행 높이로 다시 계산한다).
- 셀 영역 목록(`cellzoneList`)이 있는 표는 구조 연산(행·열 삽입·삭제, 병합·분할)을 `TABLE_UNSUPPORTED`로 거절한다(실제 문서의 표 92개). 설정과 크기 연산은 된다(셀 주소가 바뀌지 않는다).
- 아주 좁은 열(너비 1 등)은 한컴이 넓혀서 그린다. 그런 표는 한컴이 읽은 표 너비가 문서 값과 다르다(실제 문서 1건에서 관측).
- 열 삽입·복제로 표가 쪽 너비를 넘어도 경고하지 않는다.
- 셀 세로 정렬과 셀 여백은 한컴 자동화로 읽을 수 없어 다시 파싱한 값으로만 확인했다.
- 셀보다 넓은 내용의 가로 잘림은 다루지 않는다.

### 7.10 범위 앵커와 패턴 (`src/fill/`) — 2판 템플릿의 앵커 (2026-10-04)

- 근거: 이슈 #4 설계안(독립 설계자) + 총괄 임시 선택. 관련 이슈: #18(메일머지), #19(제목 범위), #20(같은 유형 일괄 앵커).
- 소유: 엔진 = Claude.
- 상태 표기: **[계약]** 이 절에서 정한 것. **[구현 #30]** 2026-10-04 #30에서 구현(`range`·액션·이동표·`cell`/`object` 지문. 검증은 [검증 기준](validation.md) 19절). **[미구현]** 아직 없는 것. 1판 앵커 5종(8.2)과 그 동작은 바꾸지 않고 더하기만 한다.

**범위 앵커 `range`** **[계약]** **[구현 #30]**

```json
{ "id": "a1", "kind": "range", "at": { "sectionIndex": 0, "parentPath": [] }, "from": 18, "to": 21,
  "print": { "first": { "text": "3. 참가자격", "sha256": "<64>" }, "last": { "text": "", "sha256": "<64>" },
             "count": 4, "sha256": "<범위 글 전체 64>" } }
```

- 대상은 같은 부모 안의 연속 문단이다(7.2의 조각 선택과 같은 꼴). `parentPath`가 빈 배열이면 구역 최상위 문단, 아니면 그 주소의 하위 목록(표 셀 등) 안이다. `from`~`to`는 0부터 세는 포함 범위다.
- 지문 `print`: `first`·`last`는 첫·끝 문단의 `{ text(글 앞 40자), sha256(문단 글 해시) }`, `count`는 문단 수, `sha256`은 범위 전체의 글 해시(문단 논리 텍스트를 줄바꿈 하나로 이은 것의 해시)다. 문단 글 해시는 `line` 앵커(8.2)와 같은 방식이다.
- `makeRangeAnchor(doc, selection)`: 7.2의 `FragmentSelection`을 받아 지문까지 채운 앵커 초안을 돌려준다. `makeRangeAnchor(doc, sectionIndex, parentPath, from, to)`도 같다. 초안은 id가 없는 `RangeDraft`(호출자가 id를 붙인다)이고, 범위가 문서에 없으면 `undefined`다. `makeCellAnchor`·`makeObjectAnchor`(아래)도 같은 꼴이다(기존 `makeLineAnchor`·`makeWordAnchor`는 id를 받는다. 통일은 뒤로 미룬다).
- 거절: 범위 안 문단에 구역 설정이 있으면 삭제·교체가 `FILL_SECTION_PROPS`, 부모의 문단을 전부 지우면 `FILL_LAST_PARAGRAPH`(8.3과 같다). 범위가 누름틀의 시작과 끝 사이를 자르면 `FRAG_SPLITS_FIELD`(7.2와 같다).
- 해석은 `resolveAnchors`와 같은 방식이다(`locateRange(doc, a)`가 판정을 돌려준다). 주소의 범위가 `print`와 모두 맞으면 exact다. 안 맞으면 **같은 구역의 모든 문단 목록**(최상위와 표 칸 안 전부)에서 `first`·`last`·`count`·`sha256`이 모두 맞는 범위를 찾는다(같은 부모로 한정하지 않는 이유: 앞에 표가 끼면 칸 안 범위의 `parentPath`가 바뀐다). 한 곳이면 relocated(`ANCHOR_RELOCATED` 경고), 여럿이면 `ANCHOR_AMBIGUOUS`, 없으면 `ANCHOR_NOT_FOUND`다. 전체가 맞는 곳이 없고 첫 문단만 맞을 때, 첫 문단을 포함해 길이 `2×count` 안에서 끝 문단 해시가 찾아지면 changed(`ANCHOR_CHANGED`, 오류)다(count 4면 안쪽 4문단 추가는 changed, 5문단 추가는 notFound). 문단 하나짜리 범위는 changed가 될 수 없다. 한계: 양 끝이 빈 문단인 범위를 통째로 지우면 다른 곳의 빈 문단 두 개 때문에 notFound 대신 changed가 날 수 있다(둘 다 생성을 막는 오류라 결과는 같고 안내만 다르다). 상태 이름과 코드 대응은 8.8.13이 정한다.
- 1판 `readTemplate`도 `range` 앵커를 받는다(더하기. 모양이 틀리면 `TPL_ANCHOR`). 텍스트 어댑터(md·txt, 8.5)에서 `range` 앵커는 `ANCHOR_NOT_FOUND`다.

**range를 받는 액션** **[계약]** **[구현 #30]**

| 액션 | range 앵커의 뜻 |
| --- | --- |
| `inject` | `before`는 범위 첫 문단 앞, `after`는 끝 문단 뒤에 넣는다. `replace`는 범위 전체를 지우고 그 자리에 넣는다(8.3의 "앵커 문단 삭제 + 삽입"을 문단 여럿으로 넓힌 것) |
| `insertText` | `inject`와 같은 위치 규칙. `style: "inherit"`는 범위 첫 문단의 문단모양·스타일과 첫 run의 글자모양을 쓴다 |
| `delete` | 범위의 문단 전부를 지운다. `scope`는 주지 않는다 |
| `fill`·`tableProps`·`resize`·`repeat` | 받지 않는다(`TPL_RULE`) |

- 같은 범위에 `replace`·`delete`가 둘 이상이거나, 범위가 겹치는 range 앵커에 교체·삭제가 있으면 `TPL_CONFLICT`다. 같은 범위에 `insertText`의 `replace`와 다른 삽입(`before`·`after`·`inject before`)을 함께 쓰는 것도 `TPL_CONFLICT`다(글 교체가 범위를 먼저 지워 삽입 자리를 잃는다). `inject`의 `replace`와 `before`·`after`, `insertText`의 `before`·`after`와 `inject replace`는 함께 쓸 수 있다. 같은 범위에 `delete`와 `before`·`after` 삽입을 함께 쓰면 삽입이 `dropped`로 빠지고 생성은 된다(8.3의 2단계 규칙). 같은 경계에 두 삽입(앞 범위의 `after`와 다음 범위의 `before`)이 모이면 출력 순서는 규칙 순서다(line 앵커와 같다). 교체되는 범위 안의 `{{ }}`·누름틀·메일머지 필드 자리는 `dropped`다(교체 값이 비어 교체를 건너뛰면 범위는 남고 그 안의 자리는 정상 채움). 범위와 겹치는 누름틀·표 앵커의 규칙은 `TPL_CONFLICT`다(여러 문단 누름틀의 구간 치환과 같은 규칙, 8.3). 범위 안 표의 칸 채움 규칙은 8.3의 순서대로 `FILL_HAS_OBJECT` 등 칸 검사가 먼저 걸릴 수 있다(어느 쪽이든 출력은 없다).

**이동표 `moves`** **[계약]** **[구현 #30]**

- 보고서(`report.plan`, 형 `PlanReport = FillReport & { moves }`)에 `moves`를 더한다. 항목은 구조 변경 하나당 `{ sectionIndex, parentPath, from, to, count, delta }`이고 문서 순서의 원본 좌표다. 뜻: 그 부모의 `from`~`to` 문단이 `count`개 문단으로 바뀐다. `delta = count − (to − from + 1)`.
  - 삭제는 `count = 0`이다. `range` 교체·삭제는 범위 하나가 항목 하나, `line`·`object` 삭제는 문단마다 항목 하나다.
  - 삽입은 덮이는 문단이 없는 빈 범위(`to = from − 1`)로 적는다. `before`는 앵커 범위 첫 문단 번호를 `from`으로, `after`는 끝 문단 번호 + 1을 `from`으로 쓴다.
  - 여러 문단 누름틀의 합침(8.3 `FIELD_PARAGRAPHS_MERGED`)도 항목이다(시작 + 1 ~ 끝, `count = 0`). 끝 문단 뒤의 글은 실제로는 시작 문단에 합쳐지지만 이동표에서는 덮인 것으로 본다.
- 변환(`remapAddress(moves, address)`): 같은 구역·같은 부모의 문단 번호 `i`는 `i < from`이면 그대로, `i > to`이면 `i + delta`, `from ≤ i ≤ to`이면 덮인 것(주소가 없어짐, `undefined`)이다. 그 문단 아래(표 셀 등) 경로는 단계마다 같은 식으로 옮긴다(그 단계의 상위 주소가 같은 항목만 본다). 항목이 여럿이면 `i`보다 앞에서 끝나는 항목의 `delta`를 모두 더한다.
- 쓰임: 보고용과 8.8.12의 2단계(word·line·cell 자리의 주소를 1단계 뒤 좌표로 옮긴다. 덮인 자리는 `dropped`(`PLACE_COVERED`)). 한 계획 안의 다른 규칙은 원본 좌표로 적용되므로 이동표를 쓰지 않는다.
- 범위(#30에서 확정): 이동표는 **문단 목록의 변경만** 담는다. 표 행 삭제(`delete scope: row`)·행 반복(`repeat`)으로 바뀌는 칸(하위 목록) 번호는 담지 않으므로, `remapAddress`는 그런 표 안의 칸 주소를 옛 번호로 돌려준다. 8.8.12의 2단계(#31)는 행 규칙이 적용된 표 안의 `cell`·`word`·`line` 자리를 이동표로 옮기지 않고 지문(`cell.print`)으로 다시 찾거나, 지문이 없으면 `PLACE_COVERED`로 떨어뜨린다(결정은 #31에서, 필요하면 행 항목을 더한다).

**메일머지 앵커 `mergeField`** (#18) **[계약]** **[미구현]**

- `{ id, kind: "mergeField", key, occurrence? }`. 이름 속성이 빈 메일머지(MAILMERGE) 필드 가운데 FieldValue 인자가 `key`인 것 전부(`occurrence`를 주면 그것만)를 가리킨다. 없으면 `ANCHOR_NOT_FOUND`.
- 필드 안 표시 글(`{{키}}`나 옛 값)은 이 앵커의 자리(`mailMerge`, 8.8.5)가 맡는다. 채움은 필드 표식과 인자를 보존하고 표시 글만 값으로 바꾼다.
- 1판의 누름틀 암묵 채움(8.3)은 이 필드를 건드리지 않는다. 템플릿 없는 빠른 생성은 #18에 따라 키가 경로 꼴이 아니면 건너뜀으로 보고한다.

**제목 범위 `headingRange`** (#19) **[계약: 정의만]** **[미구현]**

- 이름만 예약한다. 뜻: 제목 문단 하나를 가리키면 그 제목부터 같은 단계 이상의 다음 제목 앞까지를 한 범위로 보는 앵커다. 해석 결과는 `range`와 같은 지문을 쓴다.
- 제목 탐지 규칙(번호 글자·굵기·크기·표 안 제목)과 필드는 이슈 #19가 정한다. 그때까지 `readStudioTemplate`는 이 종류를 `TPL_ANCHOR`로 거절한다.
- 같은 탐지 규칙이 `suggestSimilar`의 범위 계산에도 쓰인다(아래 패턴).

**패턴** (#20) **[계약]** **[미구현]**

같은 유형 항목(예: 같은 단계의 제목)을 한꺼번에 제안하는 도구다. 패턴은 앵커를 만들지 않는다. 사용자가 확인한 제안만 앵커가 된다.

| 필드 | 뜻 |
| --- | --- |
| `id`, `name` | 패턴 id(8.8.3), 표시 이름 |
| `marker` | `{ form, level }`. 필수. `form`은 `digitDot`(숫자+점), `hangulDot`(한글 음절+점), `circled`(동그라미 숫자), `paren`(괄호 번호), `box`(네모 기호), `article`(제N조 꼴), `none`(번호 글자 없음). `level`은 1부터의 단계 |
| `char` | `{ bold, height, print }`. 굵기, 글자 크기(HWPUNIT), 글자모양 지문(7.4) |
| `para` | `{ print, align }`. 문단모양 지문, 정렬 |
| `place` | `body`(본문 문단), `cell`(표 셀 안 문단), `labelCell`(짧은 글 라벨 셀), `labelColon`(`라벨:` 꼴 글). 제안은 같은 `place`에서만 한다. 라벨 규칙은 8.3의 후보 자리와 같다 |
| `match[]` | 일치 판정에 쓰는 항목: `marker`·`bold`·`height`·`print`(글자모양 지문)·`paraPrint`(문단모양 지문)·`align`. `marker`는 항상 포함(끌 수 없음). 기본은 `marker`·`bold`·`height`·`print`가 켬이고 `paraPrint`·`align`은 끔. 켜고 끄는 것은 사용자(화면) 몫이고 엔진은 `match`대로만 판정한다 |
| `rejected[]` | 사용자가 해제한 제안의 위치 지문 `{ text, sha256 }`(첫 문단 글 앞 40자와 글 해시). 다시 제안하지 않는다. 판정은 글 해시로 하므로 같은 글은 함께 제외된다 |

- `patternOf(doc, at): Pattern`: 문단 하나(`at`은 `line` 앵커의 주소꼴)에서 패턴을 만든다. 번호 글자는 문단 글의 머리에서 읽고, 굵기·크기·글자모양 지문은 첫 글 run에서, 문단모양 지문·정렬은 문단에서 읽는다. `id`·`name`·`rejected`는 호출자가 채운다.
- `suggestSimilar(doc, pattern): DraftedAnchor[]`: `match`의 켠 항목이 모두 같은 문단을 같은 `place`에서 찾는다. 결과는 앵커 초안(`draftAnchors`와 같은 꼴, id 없음)이고 문서 순서로 결정적이다. `body` 패턴은 `range` 초안(범위 계산은 #19의 제목 탐지 규칙), 그 밖은 그 문단·셀을 가리키는 `line`·`cell` 초안이다. 이미 `anchors[]`에 든 범위와 `rejected`에 든 위치는 뺀다. 제안은 저장하지 않는다.
- 확인한 제안만 id를 받아 `anchors[]`에 들어가고, 그 앵커의 `pattern`이 패턴 id를 가진다. 패턴은 1차에서 템플릿 안(`patterns[]`)에만 둔다(템플릿 사이 공유는 뒤로 미룬다).
- 원본이 바뀌어 앵커를 다시 지정할 때도 같은 패턴의 후보를 보이는 데 쓴다(8.8.13).

**`cell`·`object` 선택 지문** **[계약]** **[구현 #30]**

- 1판의 `cell`·`object` 앵커(8.2)는 서수만 보고 지문이 없다([스튜디오 명세](studio-spec.md) 2절의 S2가 필요한 이유). 선택 필드 `print`를 더한다. 없으면 1판처럼 서수만 보고 상태는 `unverified`다(8.8.13).
- `cell.print = { rows, cols, head, text }`: 표 모양(행 수·열 수), 첫 행 글들의 해시(`head`: 첫 행 칸 글의 배열을 JSON으로 만든 것의 sha256), 그 셀 글의 해시(`text`). `cellPrintOf(table, row, col)`.
- `object.print = { objectType, width?, height?, count? }`: 종류, 크기(HWPUNIT), 수량(표는 셀 수. 그 밖은 생략). `objectPrintOf(object)`.
- `makeCellAnchor(doc, sectionIndex, ordinal, row, col)`·`makeObjectAnchor(doc, objectType, sectionIndex, ordinal)`은 지문을 채운 id 없는 초안을 돌려준다. `draftAnchors`·`findCandidates`의 cell 초안에는 아직 `print`를 넣지 않는다(후속).
- 해석: 서수의 개체가 지문과 맞으면 exact다. 안 맞으면 같은 구역에서 지문이 맞는 개체를 찾는다(유일하면 relocated, 여럿이면 ambiguous, 없으면 notFound). `cell`은 표를 `rows`·`cols`·`head`로 찾은 뒤 `row`·`col`의 셀 글 해시를 대조한다.
- 1판 `readTemplate`도 선택 필드 `print`를 받는다(#30에서 더함. 모양 검사만. 8.8.11). 없는 템플릿의 읽기 결과는 바뀌지 않는다.
- 이 절의 수용 조건은 8.8.16(W5·W7·W8)이 소유한다.

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
| `inject` | `anchor`(line), `position`(`before`·`after`·`replace`), `fragment`(조각 JSON 경로 또는 내장 객체), `fitTable?`(`"allowBreak"`) | 조각을 가져와 넣는다. 조각 안의 `{{}}`도 같은 데이터로 채운다 |
| `tableProps` | `anchor`(표 또는 `cell`), `table?`(`treatAsChar`, `pageBreak`, `repeatHeader`, `cellSpacing`, `outMargin`, `inMargin`, `hAlign`), `cells?`(`[{ rows, cols, props }]`: `vertAlign`, `lineWrap`, `header`, `margin`, `protect`) | 표·셀 설정을 바꾼다(7.9) |
| `resize` | `anchor`(표), `columns` 또는 `width` 또는 `scale` 중 하나, `rowHeights?` | 열 너비·표 너비·행 높이(단위 HWPUNIT) |
| `repeat` | `anchor`(cell: 원형 행), `each`(`{path}`), `as?`(기본 `item`), `index?` | 배열 원소마다 원형 행을 복제하고 채운다 |
| `insertText` | `anchor`(line), `position`, `value`, `style`(`inherit` 또는 `{ paraPrIDRef, charPrIDRef, styleIDRef }`) | 일반 텍스트를 새 문단으로 넣는다. 값의 줄바꿈마다 문단을 나눈다. `inherit`는 앵커 문단의 문단모양·스타일과 첫 run의 글자모양을 쓴다 |

**데이터 묶음**

```json
{ "schema": "hwpx-studio/dataset@1", "data": { }, "derived": { } }
```

- `fill`의 경로는 `data`에서 찾고, 없으면 `derived`에서 찾는다. CLI는 묶음 형식이 아닌 일반 JSON도 받는다(전체를 `data`로 본다).
- 값 변환: 문자열은 그대로, 숫자·불리언은 문자열로. 객체·배열은 `DATA_NOT_SCALAR`. null·없음은 `options.missing`에 따른다: `error`(기본, `DATA_MISSING`으로 전체 중단), `empty`(빈 글), `keep`(자리를 그대로 둠).
- 값의 줄바꿈과 탭(2026-10-03 구현. 사용자 데이터에 줄바꿈이 흔하다):
  - `\r\n`과 `\r`은 `\n`으로 맞춘다. `\n`은 줄바꿈 요소(`lineBreak`), 탭은 탭 요소(`tab`)로 `hp:t` 안에 넣는다. 문단은 나누지 않는다. 요소의 속성 구성은 한컴이 저장한 문서의 것을 따른다.
  - 대상: `fill`(누름틀·낱말·문단·셀), 문서 안 `{{}}`, 행 반복의 값. `insertText`는 지금처럼 줄바꿈마다 문단을 나눈다.
  - 값 재읽기는 논리 텍스트(줄바꿈 요소는 `\n`, 탭 요소는 `\t`)와 맞춘 값이 같아야 한다.
  - 요소의 모양 [확인: 한컴 13 저장본]: 줄바꿈은 `hp:t` 안의 `<hp:lineBreak/>`(속성 없음), 탭은 `<hp:tab width="0" leader="0" type="1"/>`(한컴은 `width`·`type`을 읽을 때 쓰지 않고 다시 저장하면 조판 값으로 바꾼다. rhwp는 `type="1"`이어야 한컴과 같은 자리에 그린다). 접두사는 그 run의 것을 따른다.
  - 한컴의 필드 읽기 API는 줄바꿈 요소를 글자로 주지 않는다(`첫 줄둘째 줄`). 보존 확인은 한컴이 다시 저장한 문서를 엔진이 읽어 `\n`이 남는 것으로 한다.
  - 줄바꿈이 든 값으로 채운 누름틀은 모양이 `inline`이 된다. 2026-10-04부터 `inline`은 다시 채운다(옛 줄바꿈·탭 요소를 옛 값의 일부로 보고 통째로 바꾼다. 8.3). 여러 문단에 걸친 누름틀(`crossParagraph`. 실제 문서의 자리 있는 153건 중 56건)도 같은 날부터 한컴 방식으로 채운다(8.3).
  - 그 밖의 XML 금지 문자(제어 문자)는 지금처럼 `VALUE_CONTROL_CHAR`다.
  - md·txt 어댑터의 규칙은 9절 그대로다(md 표 셀의 줄바꿈은 거부).

### 8.3 채움 규칙 (`src/fill/`) — S3b

**앵커 해석 `resolveAnchors(doc, template)`**

- `field`: 이름이 같은 누름틀 전부(순번을 주면 그것만). 없으면 `ANCHOR_NOT_FOUND`. `{ kind: "field", mergeKey, occurrence? }`는 키가 같은 메일 머지 필드를 가리킨다(2026-10-04). `name`과 `mergeKey`를 함께 주거나 둘 다 없거나 키가 비면 `TPL_ANCHOR`. 규칙이 가리킨 메일 머지 필드는 키가 경로 꼴이 아니어도 규칙이 채운다. md·txt에서 `mergeKey` 앵커는 대상이 없어 `ANCHOR_NOT_FOUND`로 실패한다(무시하지 않는다).
- `word`·`line`: 주소의 문단을 찾고 `print`와 대조한다. 맞으면 exact. 안 맞으면 같은 구역에서 `print`로 다시 찾는다: 유일하면 `ANCHOR_RELOCATED`(경고), 여럿이면 `ANCHOR_AMBIGUOUS`(오류), 없으면 `ANCHOR_NOT_FOUND`(오류).
- `cell`·`object`: 서수로 찾는다. 범위 밖이면 `ANCHOR_NOT_FOUND`.

**자리별 채움**

- **누름틀 암묵 채움**(2026-10-03): 대상은 `type`이 `CLICK_HERE`인 필드(이름 = 데이터 경로)와 **키가 있는 `MAILMERGE` 필드(키 = 데이터 경로, 2026-10-04 이슈 #18)**다(다른 type의 필드는 채우지도 보고하지도 않는다. 독립 검증에서 책갈피 범위 필드가 `DATA_MISSING`으로 생성을 막는 것을 보고 2026-10-03 고침). 메일 머지 필드는 보고 앵커가 `merge:키`이고 키가 경로 꼴이 아니면 건너뜀 `MERGE_KEY_NOT_PATH`(ruleId `implicit`). 필드의 `parameters`·`type`·`fieldid`·`editable`은 바이트 그대로 두고 값이 비어 있지 않으면 `dirty`만 `"1"`로 한다(빈 값은 누름틀과 같이 `dirty`를 건드리지 않는다. 한컴이 다시 저장해도 유지됨을 확인). 모양·구간 치환·건너뜀 조건·경고는 누름틀과 같다. 필드가 맡는(규칙이 가리키거나 암묵 채움이 채울 수 있는) 메일 머지 필드의 표시 글 안 `{{}}`는 placeholder 경로가 채우지 않고 `dropped`로 보고한다. 필드를 못 채우는 경우(키가 경로 꼴 아님, 키 없는 메일 머지 필드 등)에는 전처럼 그 표시 글 안의 `{{}}`를 일반 `{{}}`로 채운다(표시 글이 바뀌고 필드 표식은 남는다). 한컴의 필드 API(`GetFieldList`·`PutFieldText`)는 메일 머지 필드를 보지 못하므로 한컴 대조는 열림·재저장 뒤 재읽기로 한다. 템플릿이 없거나 그 누름틀을 가리키는 `field` 규칙이 없으면, 이름이 데이터 경로 문법에 맞는 누름틀은 "이름 = 경로"로 채운다(`{{}}`의 암묵 규칙과 같은 자리, 같은 누락 정책). 이름이 경로가 아니면 건너뜀 `FIELD_NAME_NOT_PATH`, 채울 수 없는 모양이면 건너뜀 `FIELD_UNSUPPORTED_SHAPE`(오류가 아니다). 이 건너뜀은 `ruleId: "implicit"`로 보고되며, 호출자가 요청하지 않은 자리에 대한 정보다. 구조 변경만 하는 템플릿(inject·delete)을 돌리는 호출자는 `implicit` 건너뜀을 실패로 세지 않는다(2026-10-04 이슈 #3). 같은 이름은 전부 같은 값. 삭제·교체되는 문단과 반복 원형 행 안의 누름틀은 `dropped`.
- **적용된 액션이 0이면 실패**: `FILL_NOTHING_APPLIED`(출력 없음, 메시지에 건너뜀 코드별 건수). CLI도 종료 코드 1. 예외: `generate` 옵션 `allowNothingApplied`를 켜면 실패로 보지 않고 원본과 같은 결과를 낸다(이미 조립한 문서에 채울 자리가 없을 수 있는 studio-lite의 블록 교체 뒤 채움 단계용. CLI·빠른 생성은 켜지 않는다. 2026-10-04 합치기 때 추가).
- 누름틀(shape별): `simple` → 시작과 끝 사이 첫 글 조각에 값을 넣고 나머지 글 조각은 비운다. `empty` → 시작 컨트롤 바로 뒤에 `<접두사:t>값</접두사:t>`를 넣는다. 둘 다 시작 요소의 `dirty`를 `"1"`로 한다(없으면 속성 추가). 안내문과 값을 비교하지 않는다. `object`·`crossContainer`·`unpaired`는 `FIELD_UNSUPPORTED_SHAPE`.
  - **`inline`·`crossParagraph`(2026-10-04, 한컴이 직접 채워 저장한 정답 `test/fixtures/span/`과 대조)**: 시작 표식 조각(`hp:ctrl`)의 끝부터 끝 표식 조각의 시작까지를 한 번의 구간 치환으로 `<접두사:t>값</접두사:t>`로 바꾼다(값이 비면 삭제만). 결과는 시작 run의 여는 태그 + 시작 컨트롤 + 값 + 끝 컨트롤 + 끝 run의 나머지 + 끝 문단의 나머지이고, 시작 run과 끝 run의 여는 태그가 다르면 끝 run을 다시 열어 끝 뒤 글의 글자모양을 지킨다. `crossParagraph`에서는 사이 문단(표 포함)이 사라지고 끝 표식 뒤 글이 첫 문단에 합쳐지며 첫 문단의 속성은 그대로다(한컴과 같다). 건너뜀(`FIELD_UNSUPPORTED_SHAPE`, 사유를 메시지에): 사이·끝 문단에 `secPr`(시작 문단은 표식 뒤에 있을 때만), 구간을 가로질러 짝이 끊기는 다른 필드(모든 type), 구간 경계에 걸친 형광펜·변경 추적 표식(짝 없는 표식이 남게 되는 경우). 지워지는 부분(시작 문단 꼬리·끝 문단 머리·사이 문단)의 표·그림·책갈피·쪽 번호 같은 개체는 한컴처럼 함께 지운다(독립 검증이 한컴 COM으로 확인: 꼬리의 표·책갈피, 머리의 표·쪽 번호가 있어도 한컴은 채우고 지운다). 구간 안에 통째로 든 다른 필드(모든 type)·책갈피는 함께 지우고 `dropped`에 적는다. 구간 안의 `{{}}`와 다른 누름틀의 암묵 채움은 `dropped`. 구간(시작 문단부터 끝 문단까지)을 가리키는 **명시** 규칙(line·cell 채움, insertText, inject, tableProps, 안쪽 누름틀의 명시 채움, 삭제, 행 반복)은 규칙 순서와 무관하게 `TPL_CONFLICT`이고, 시작·끝 문단을 앵커로 쓰는 삽입·주입은 앞뒤 어디든 `TPL_CONFLICT`다(2026-10-04 독립 검증 M1·L2 반영). 수량 예상은 치환 전후 구간을 다시 읽어 센 차이로 `report.expected`에 더한다. `crossParagraph`를 채우면 경고 `FIELD_PARAGRAPHS_MERGED`("누름틀 <이름>이 걸친 문단 N개를 합쳤고 사이의 문단 M개를 지웠습니다(그 안의 표 T개 포함)." T는 지워진 부분 전체의 표 수로, 꼬리·머리의 표도 센다)를 낸다(`generateBatch`의 `BatchItem.warnings`, `--report`의 `items[].warnings`, 단건은 `report.issues`의 severity `warning`). 같은 문단 `inline`은 경고 없음.
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
| `fixCounts` | 자원 목록의 개수 속성(`itemCnt`·`fontCnt`) | 실제 수로 고친다 | 켬 |
| `fixSectionCount` | 구역 수 선언 불일치 | 실제 구역 수로 고친다. **한컴은 선언한 수만큼만 구역을 보여 주므로, 고치면 숨어 있던 구역이 드러나 보이는 내용이 바뀐다**(실제 문서 3건에서 쪽 수가 1쪽씩 늘어남을 확인) | **끔** |
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

**S3c 구현에서 확정한 것 (2026-10-01)** — P1~P5 통과(테스트 43개).

- 실제 문서 659건 집계(읽기 전용, 기본 보정): 원래 오류가 있던 문서 122건 중 72건을 고쳤고 68건이 오류 0이 됐다. 오류가 늘어난 문서 0, 새 오류 0, 예외 0. 종류별: id 재발급 742건(69문서), 개수 속성 4건, 낡은 줄 배치 캐시 1문서, 금지 문자 1문서.
- 남는 오류: 없는 서식 참조 873건(대체를 켜도 대상 목록이 빈 문서가 많아 402건이 남는다), mimetype 순서·압축(재배열을 켜면 23문서가 고쳐진다), 그리고 보정할 수 없는 것(필수 항목 없음, HWPX가 아님, 깨진 XML, 표 셀 범위, 짝 없는 필드).
- 낡은 줄 배치 캐시 판정의 길이 단위: 글은 1칸, 컨트롤·객체·인라인은 8칸, 끝 표지 1칸. 모델의 논리 텍스트 길이(객체 1글자)로 재면 정상 문단을 낡았다고 잘못 판정한다.
- `planRepair`는 계획을 메모리에서 적용해 다시 검사한 뒤 남은 원래 오류를 `unrepaired`로 돌려준다. 새 오류가 생기는 계획이면 `REPAIR_REGRESSION`이다.
- 보정 전후 비교는 표 id를 뺀 키로 한다(표 id를 재발급하면 같은 표 오류가 새 오류로 보이던 문제).
- 금지 문자를 지우면 그동안 읽히지 않아 가려졌던 오류가 드러난다. 이것은 새 오류로 세지 않는다.
- 금지 문자는 글자 데이터와 그것을 가리키는 숫자 참조만 지운다. 태그·속성 안에 있으면 그 항목은 건드리지 않고 보정 불가로 남긴다.
- 없는 참조 대체는 이진 자료 참조와 메모 모양을 건드리지 않는다. 한컴이 받아 주는 경고 분류도 건드리지 않는다.
- 객체 id가 `0`으로 겹치는 경우는 기본으로 두고 `reissueIds: "all"`일 때만 재발급한다.
- 추가한 코드: `REPAIR_REGRESSION`(오류), `REPAIR_FIELD_PAIR`, `REPAIR_NO_DEFAULT`, `REPAIR_ENTRY_SKIPPED`(경고).
- 한컴 확인(2026-10-01): 기본 보정을 적용한 실제 문서 표본 15건을 한컴 13이 모두 열었다(원본을 한컴이 열지 못하던 1건도 보정본은 열렸다). 쪽 수는 14건 중 13건이 같았고, 1쪽 늘어난 1건은 구역 수 선언을 고친 문서였다. 개수 속성만 고친 문서는 쪽 수가 같았다(197쪽). 그래서 구역 수 교정을 기본에서 뺀다.

### 8.36 여러 건 생성 (`src/fill/batch.ts`, 2026-10-03)

- `generateBatch(bytes, template, records, options): Generator<BatchItem>` — 데이터 원소마다 `generate`를 부르고 건별 결과를 내놓는다(한 건이 실패해도 계속). `readBatchRecords(input)`: 최상위 배열 또는 묶음 형식의 `data` 배열을 건 목록으로(`derived`는 공유).
- 이름: `planBatchNames(records, baseName, nameFrom?)`. 기본 `<원본 이름>-<번호 3자리>`, `nameFrom`이 `{{경로}}`이면 그 값(문자열·숫자만. 비면 기본 이름). `safeFileStem(value)`: 금지 문자 `_`, 앞뒤 공백·뒤쪽 `.` 제거, 100 코드 포인트, Windows 장치 이름 뒤 `_`. `sanitizeFileStem(input)`: 폴더 부분과 `.hwpx`를 뗀 뒤 `safeFileStem`, 비면 `문서`. 중복은 대소문자 무시로 `-2`, `-3`.

### 8.4 CLI (`apps/cli`) — S3b

| 명령 | 동작 |
| --- | --- |
| `hwpx inspect <파일> [--json] [--model 출력.json]` | 구역·문단·표·누름틀·`{{}}`·자원 수 요약. `--model`은 모델 JSON 저장 |
| `hwpx candidates <파일> [--json]` | 후보 자리 목록 |
| `hwpx fragment extract <파일> --section N --from A --to B [--parent 주소] -o 조각.json` | 조각 추출 |
| `hwpx fragment import <대상> <조각.json> (--section N --index I [--before] \| --range 구역:시작-끝) [--parent 주소] -o 출력.hwpx` | 조각 가져오기(게이트 포함). `--range`는 그 범위의 문단을 지우고 그 자리에 넣는다(7.10의 `range` 교체. `--section`·`--index`·`--before`와 함께 쓸 수 없다. 2026-10-04 #30) |
| `hwpx fill <파일> --data d.json [--template t.json] -o 출력 [--mode baseline\|strict\|repair] [--missing error\|empty\|keep] [--dry-run] [--report r.json] [--overwrite]` | 생성. 템플릿 없이도 `{{}}`와 누름틀을 채운다 |
| `hwpx fill <파일> --data 배열.json --batch -o <폴더> [--name "{{경로}}"] [--dry-run] [--report r.json] [--overwrite]` | 여러 건 생성(8.36). 한 건이 실패해도 나머지는 만들고 종료 코드 1. 폴더가 없거나 같은 이름 파일이 있으면 2 |
| `hwpx fill <파일> --template t2.json --case c.json --data 한건.json --blobs <폴더> -o 출력 [--report r.json] [--overwrite]` | **[계약]** **[미구현]** 2판 템플릿(`template@2`, 8.8) 생성. `--data`는 한 건(객체), `--case`는 이번 건(`case@1`, 없으면 선택을 전부 계산), `--blobs`는 조각 덩어리를 `<sha256>.json`으로 담은 폴더(받은 바이트의 해시를 대조한다). 앱과 같은 바이트를 낸다(8.8.12). `--template`이 `@1`이면 위 `fill` 동작 그대로이고 `--case`·`--blobs`는 종료 코드 2. 덩어리 파일은 입력이라 출력 경로로 덮어쓸 수 없다. 종료 코드는 아래와 같다 |
| `hwpx validate <파일> [--baseline 원본] [--strict] [--json]` | 검사 |
| `hwpx diff <원본> <결과> [--json]` | 항목별 동일 여부와 수량 비교 |
| `hwpx compile <파일> -o 승격본 --experimental` | `{{}}`를 누름틀로 |
| `compile <원본> -o <출력> --merge-fields to-placeholder\|to-field` | 키가 있는 메일 머지 필드를 `{{키}}` 자리(표식 제거, 표시 글을 `{{키}}` 하나로)나 누름틀(CLICK_HERE, 이름 = 키, `dirty=1`)로 바꾼다. 키가 경로 꼴이 아니거나 채울 수 없는 모양이면 `COMPILE_SKIPPED` 경고. `--merge-fields`가 있으면 `{{}}`를 누름틀로 올리는 기본 승격은 하지 않는다(같은 변환을 두 번 적용하면 두 번째는 변환 0·바이트 동일). 게이트: 필드 쌍 수·값 재읽기·`{{키}}` 수 대조. `CompileReport.mergeConverted`(2026-10-04 #18) |
| `hwpx table list <파일> [--json]` | 표 목록: 위치, 행×열, 너비, 글자처럼 취급, 쪽 나눔, 제목 행 반복, 병합 수. 글 내용은 내지 않는다 |
| `hwpx table set <파일> --table 구역:순번 [--treat-as-char on\|off] [--page-break cell\|none\|table] [--repeat-header on\|off] [--width N \| --scale X \| --columns a,b,c] -o 출력 [--mode …] [--report r.json]` | 최상위 표 하나의 설정·크기 변경(게이트 포함) |

- `fill`은 확장자로 형식을 고른다. `.hwpx`는 저장 게이트를 거치고, `.md`·`.txt`는 텍스트 어댑터(9절)를 거친다. 텍스트 전용 옵션 `--fill-in-code`. 텍스트에는 `--mode`·`--reissue-internal`을 줄 수 없다(종료 코드 2).
- `inspect`도 `.md`·`.txt`를 받는다(블록·표·코드 블록 수와 `{{}}` 목록. 코드 블록 안의 표기는 따로 센다). 그 밖의 명령은 `.hwpx`만 받는다.
- `fill`과 `fragment import`의 `--reissue-internal`: 조각 안에서 겹치는 id도 새 값으로 바꾼다.
- `fragment import --report r.json`: `fill --report`와 같은 게이트 보고서(상속 항목 포함).
- 템플릿이 가리키는 조각 파일은 입력으로 취급해 출력 경로로 덮어쓸 수 없다.
- 텍스트 입력은 UTF-8만 받는다(BOM은 보존). 아니면 종료 코드 2.
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

### 8.7 S3b 구현에서 확정한 것 (2026-10-01)

구현 상태: E1~E13, G1~G6 통과(테스트 98개). 오라클 교차 18건 통과(rhwp 파싱·쪽 수·누름틀 값, Python 검사기 오류 증가 없음). CLI로 만든 8종을 한컴 13이 모두 열었고 쪽 수가 원본과 같았다. 한컴이 저장한 PDF에서 누름틀 값(본문 글자모양), 조건 삭제, 그림 조각 삽입, 표 행 삭제, 셀 채움, 텍스트 삽입을 눈으로 확인했다.

- **적용 방식**: 채움·삭제·행 삭제·텍스트 삽입·줄 배치 캐시 제거는 원본 좌표의 계획 하나로 적용한다. 조각 주입은 그 결과를 다시 파싱해 하나씩 이어서 가져온다(독립 계획은 새 id가 겹치므로 합치지 않는다). 단계마다 보존·수량·값 재읽기를 확인한다.
- **건너뜀과 오류**: 건너뜀(`skipped`)은 `FILL_CROSSES_MARKUP`, `FILL_SPLITS_CLUSTER`(구간 경계가 글자 묶음 가운데), `FILL_MIXED_FORMAT` 셋이다. 그 밖(`FILL_HAS_OBJECT`, `FIELD_UNSUPPORTED_SHAPE`, `FILL_LAST_PARAGRAPH` 등)은 오류로 전체를 막는다.
- 구역 설정과 단 설정만 든 컨트롤은 `FILL_HAS_OBJECT`의 객체로 세지 않는다(한컴 문서의 첫 문단은 항상 이것을 갖는다).
- **누름틀 승격**: `fieldid`는 한컴 저장본에서 관측한 고정값을 쓴다. 시작 id만 문서에서 겹치지 않는 값을 준다. 한컴 13이 승격본을 열고, 필드 목록에서 승격한 이름들을 누름틀로 돌려준다(COM으로 확인). 채운 문서의 누름틀 값도 한컴이 그대로 읽는다.
- `insertText`는 새 문단의 쪽 나눔·단 나눔 속성을 `0`으로 둔다.
- 마지막 남은 행까지 지우면, 표를 담은 문단에 표만 있으면 문단째, 다른 글이 있으면 표 요소만 지운다.
- 조건 비교: 한쪽이 숫자이고 다른 쪽이 숫자로 읽히는 글이면 숫자로 견준다. "숫자로 읽히는 글"은 앞뒤 공백 없는 10진수다(부호·소수점 허용, `1e3` 같은 지수 표기는 글). 경로가 없으면 `ne`와 `empty`는 참, 그 밖은 거짓이다. `data`의 값이 null이면 `derived`를 본다. 빈 `all`은 참, 빈 `any`는 거짓. `length*`는 배열은 원소 수, 문자열은 UTF-16 단위.
- 정규식 조건의 한도: 패턴 200자 초과와 중첩 수량자 형태(`(a+)+` 등)는 템플릿을 읽을 때 `TPL_CONDITION`으로 거절한다. 평가할 글이 10,000자를 넘으면 `TPL_CONDITION`으로 중단한다. 보수적인 휴리스틱이라 무해한 패턴 일부도 거절한다.
- 게이트의 상속 설명에는 개수 상한이 있다: (코드, id 공간, 값)별 오류 증가분이 조각의 상속 기록 개수 이하일 때만 설명하고, 넘는 부분은 새 오류로 막는다.
- 기준선에서 관용 경고(`RES_DANGLING_TOLERATED`)였던 같은 참조가 결과에서 오류(`RES_DANGLING`)로 올라가면 원래 있던 문제로 센다(빈 목록에 항목이 생기면 검사기가 같은 참조를 오류로 올린다). `strict`에서는 막는다.
- `repair` 방식: 보정 결과를 원본으로 삼고 그 위에서 기준선 방식으로 판정한다. 보정이 새 오류를 만들면 `GATE_REPAIR_REGRESSED`.
- 게이트 실패 코드: `GATE_NEW_ERRORS`, `PRESERVE_SPAN`, `PRESERVE_CENSUS`, `PRESERVE_RECORD_CHANGED`, `REREAD_TEXT`, `REREAD_FIELD`.
- 입력을 열 수 없으면 `generate`는 `HwpxError`를 던진다. 게이트 실패는 `{ ok: false, report }`다.
- 같은 문단을 텍스트 삽입으로 교체하면서 그 문단에 다른 삽입·주입을 하는 조합은 `TPL_CONFLICT`다.
- 모의 실행(`--dry-run`)은 계획까지만 만든다. 조각 가져오기 단계의 오류는 실제 실행에서 나온다.
- CLI: `--report`는 게이트가 실패해도 쓴다. `validate`는 ZIP이 아닌 파일이면 종료 코드 1, 읽을 수 없으면 2.
- 알려진 한계: 템플릿의 `source.sha256`은 읽기만 하고 검사하지 않는다(1판. 2판은 `TPL_SOURCE_MISMATCH`로 대조한다. 8.8.12 **[계약]** **[미구현]**). 줄 앵커는 문단 글의 해시가 필요해 손으로 쓰기 어렵다(화면이나 `candidates`가 만들어 주는 것을 전제한다).

### 8.8 템플릿 계약 2판 `hwpx-studio/template@2` (이슈 #4, 2026-10-04)

- 근거: 이슈 #4 설계안(독립 설계자) + 총괄 임시 선택. 결정은 총괄의 임시 선택이며 사용자 확정 요구가 아니다.
- 상태: 이 절의 모든 항목은 **[계약]**(이 절에서 정함)이고 **[미구현]**(2026-10-04 기준)이다.
- 소유: 엔진(읽기·검사·선택 평가·생성·앵커 API·시험 자료) = Claude. 저장 구조(SQLite)와 lite 이관 코드 = Codex(lite 앱, 이슈 #25·#4). 소절 머리에 소유를 한 줄로 적는다.
- 1판 `template@1`(8.2·8.3)의 본문과 동작은 바꾸지 않는다. 2판은 더하기만 한다(8.8.11).
- 앵커·패턴·이동표의 정의는 7.10, 명령행은 8.4의 `fill --template`이다.

**총괄 임시 선택** (설계안 7절의 권고를 모두 채택. 규칙 본문은 소절이 정본이다)

| 항목 | 선택 | 소절 |
| --- | --- | --- |
| 조건식 | 저장은 엔진 `Condition` JSON(path = 값 id). lite 문자열은 화면 입력 문법이고 이관 때 변환 | 8.8.1, 8.8.8 |
| 슬롯당 선택 | 하나 | 8.8.6 |
| 이름 규칙 | id는 저장소가 생성, 표시 이름은 값끼리·슬롯끼리 유일, 자리 키는 2판에서 공백 허용 | 8.8.3 |
| 우선순위 | 우선순위를 유지하고 동률은 `undecided` | 8.8.8 |
| 1판 규칙과 슬롯 | 혼용 금지(`TPL_MIXED_RULES`) | 8.8.11 |
| 연결 위치 | 템플릿 안 별도 절 `bindings[]`, 머리글 차이는 별칭 | 8.8.4 |
| 원형 전파 | 영향 목록을 보인 뒤 템플릿별로 선택. 자동 전파 금지 | 8.8.7 |
| 템플릿 안 원형 수정 | 허용하되 `forkedFrom` 분기, 알림만 | 8.8.7 |
| lite 블록 → 원형 | 이관 때 원형화. 내용 해시가 같으면 같은 원형 | 8.8.14 |
| 패턴 | 번호 유형·단계 필수, 굵기·크기·지문 기본 켬, 1차는 템플릿 안 | 7.10 |
| 메일머지 키 | 2판은 경로 꼴이 아니어도 `key`로 연결 | 8.8.4, 8.8.5 |
| lite 후처리 2종 | 템플릿 `options`로 엔진에 두고 기본 끔. 이관 템플릿만 켬 | 8.8.12 |
| lite Markdown 블록 | hwpx 모드는 이관 때 조각 고정. md 모드는 `content.text` | 8.8.14 |
| `selectedBlocks` | 이관 때 활성 건의 case로. G2B 프로필의 고정 선택 사본은 Codex | 8.8.14 |
| 이관 코드 위치 | lite 앱(Codex). 엔진은 읽기·검사·앵커 API·시험 자료 | 8.8.14 |
| `requireConfirm` | 기본 false | 8.8.2 |

#### 8.8.1 용어와 저장 범위

소유: 엔진 = Claude(계약). 저장 구조 = Codex(이슈 #25).

| 용어 | 뜻 |
| --- | --- |
| 계약 2판 | 사용자가 말한 "계약 v1". 스키마 `hwpx-studio/template@2`. 엔진 1판 `template@1`과 구별한다 |
| 템플릿 | 원본 문서 하나 + 앵커·값·연결·자리·슬롯·블록·패턴. 저장마다 새 판(불변) |
| 값 | 이름과 형식을 가진 데이터 한 칸. 자리 여럿과 조건이 함께 쓴다 |
| 연결 | 값과 데이터 JSON의 열 이름(`key`) 또는 경로(`path`)를 잇는 것 |
| 자리 | 값이 들어갈 곳(누름틀·메일머지 필드·`{{ 키 }}`·낱말·줄·셀) |
| 슬롯 | 문서에서 내용이 바뀌는 곳(앵커 하나 이상). 슬롯마다 블록 하나를 고른다 |
| 블록 | 슬롯에 들어갈 수 있는 내용 한 가지(조각 또는 글)와 선택 조건·우선순위 |
| 원형 | 여러 템플릿이 공유하는 블록 내용. 템플릿 밖의 별도 항목(`block-proto@1`) |
| 이번 건(case) | 한 건의 선택·값 정정·블록 수정(`case@1`). 템플릿·원형을 바꾸지 않는다 |
| 조건식 | 저장은 엔진 `Condition` JSON(8.2, path는 값 id). lite의 문자열 조건은 화면 입력 문법이며 이관·입력 때 변환한다 |

**설계의 전제** **[확인: 설계자가 lite 코드를 읽음, 2026-10-04]**

- lite `Project`(version 1)는 Field 하나가 이름·열·형식·대상·승인을 함께 갖는다. Range는 첫 구역 최상위 문단 번호(1부터)다. Block의 조건은 문자열, 우선순위는 숫자다. `selectedBlocks`와 `records`가 프로젝트 안에 있다. 같은 group의 Range가 여럿이면 모두 같은 블록으로 바꾼다.
- lite의 선택 동작이 둘로 갈린다. `selectBlocks`는 동률·조건 값 누락을 묻지 않고 고르고, G2B 쪽은 `needs-input`으로 막는다. 2판은 막는 쪽을 따른다(8.8.8).
- lite의 생성 순서: 구조 교체(빈 데이터) → 재파싱 → 조립본에서 자리를 다시 찾아 `{text}`로 채움 → 채운 누름틀 풀기 → `Preview/PrvText.txt` 갱신. 2판의 2단계 생성(8.8.12)은 이 검증된 순서를 엔진으로 옮긴 것이다.

**저장 범위**: 범위마다 식별과 변경 방식이 다르고, 한 범위가 다른 범위를 조용히 바꾸지 않는다.

| 범위 | 형식 | 식별 | 바뀌는 방식 | 다른 범위가 바꾸면 안 되는 것 |
| --- | --- | --- | --- | --- |
| 템플릿 | `template@2` | id + version, 정규 JSON sha256 | 저장마다 새 판(불변) | 원형 갱신·데이터·이번 건이 조용히 바꾸지 않는다 |
| 블록 원형(공용) | `block-proto@1` + 내용 덩어리 | id + version, 내용 sha256 | 고치면 새 판. 템플릿에는 전파(새 템플릿 판)로만 | 이번 건 수정·템플릿 분기가 원형을 바꾸지 않는다 |
| 원본 문서 | 바이트 | sha256 | 불변. 갱신은 새 해시 + 재지정(8.8.13)으로 새 템플릿 판 | |
| 이번 건 수정 | `case@1` | case id(템플릿 판·데이터 판·행 고정) | 진행 중 덮어쓰고, 생성 때 원장과 함께 고정 | 원형·템플릿·원본 데이터로 새지 않는다 |
| 원본 데이터 | `dataset@1`(8.2) + 출처(파일 sha256, 시트) | id + version | 가져온 그대로. 다시 가져오면 새 판. xlsx는 시트별, 머리글이 같으면 연결을 재사용 | 값 정정은 `valueEdits`로만 한다 |
| 파생 색인 | 원형 사용처, 앵커 상태 | 재생성 가능 | — | 정본이 아니다 |

- `dataset@1`의 형식은 8.2 그대로다. id·version·출처는 저장소의 메타데이터이고 엔진은 모른다.
- 저장소 제안(설계자 제안이며 계약이 아니다. Codex가 확정): `blob`(sha256 키, 종류, 바이트), `template`, `proto`, `proto_usage`(색인), `dataset`, `case`, `generation`(case별 출력 해시와 원장), `migration`(lite 개정 키, 상태, 보고, 만든 템플릿 판). 기존 `project_revision`은 읽기만 한다.

#### 8.8.2 최상위 필드

소유: 엔진 = Claude(읽기·검사). 판 번호 부여·저장 = Codex.

| 필드 | 뜻 | 필수 | 규칙 |
| --- | --- | --- | --- |
| `schema` | `hwpx-studio/template@2` | 필수 | `@1`은 승계(8.8.11). 다른 번호는 `TPL_VERSION`, 다른 이름은 `TPL_SCHEMA` |
| `id` | 템플릿 id(`t` + 16진 8자, 저장소가 줌) | 필수 | 표시 이름과 무관, 불변 |
| `version` | 저장 판(1부터) | 필수 | 저장된 판은 바꾸지 않고, 고치면 새 판 |
| `meta.name` | 표시 이름 | 선택 | 참조에 쓰지 않는다 |
| `source` | 원본 문서 `{ kind: "hwpx" 또는 "md", sha256 }` | 필수 | 파일 이름·경로는 저장하지 않는다. 생성 때 대조한다(8.8.12) |
| `anchors[]` | 위치 기준. 1판 5종 + `range`(7.10) + `mergeField`(#18) + `headingRange`(#19 예약) | 필수(빈 배열 가능) | `cell`·`object`에 선택 `print`, 모든 앵커에 선택 `pattern`(패턴 id) |
| `patterns[]` | 같은 유형 항목을 일괄 제안하는 패턴(7.10) | 선택 | |
| `values[]` | 값 `{ id, name, format: "text" 또는 "money" }` | 필수 | 값 하나를 자리 여럿과 조건이 함께 쓴다. `money`는 조건에서 숫자, 출력은 `1,234원`(8.8.4) |
| `bindings[]` | JSON 연결 `{ value, key 또는 path, aliases? }` | 쓰이는 값마다 정확히 하나 | `key`는 열 이름 그대로(공백·점 허용), `path`는 중첩 경로. 별칭 둘 이상에 값이 있으면 `DATA_ALIAS_CONFLICT`(8.8.4) |
| `places[]` | 값 자리(8.8.5) | 필수 | 후보 자리는 승인 전에는 넣지 않는다 |
| `slots[]` | 앵커 + `{ id, name, anchors[≥1], parent: null 또는 블록 id }` | 필수 | 앵커가 여럿이면 같은 선택을 여러 곳에 적용한다. `parent`는 중첩 예약(8.8.6) |
| `blocks[]` | 선택지 `{ id, slot, name, content, proto?, forkedFrom?, when?, priority? }` | 필수 | `content`는 `{ fragment: sha256 }` 또는 `{ text }`(`{{키}}` 가능). `proto`가 있으면 그 원형 판의 내용과 같아야 한다(`TPL_PROTO_MISMATCH`, 8.8.7) |
| `rules[]` | 1판 규칙 | 선택 | 승계 전용. `slots`·`places`와 함께 쓰면 `TPL_MIXED_RULES`(8.8.11) |
| `options` | 아래 표 | 선택 | |
| `origin` | 이관 출처 `{ kind: "lite", revision }` | 선택 | 8.8.14 |

필수 배열은 비어 있어도 된다. 모르는 키는 `TPL_FIELD`다.

| 옵션 | 값 | 기본 | 뜻 |
| --- | --- | --- | --- |
| `missing` | `error`·`empty`·`keep` | `error` | 데이터에 값이 없을 때(8.2). 자리를 채울 때만 적용하고, 조건에서의 누락은 8.8.8이 다룬다 |
| `mixedFormat` | `first` | 없음 | 8.3의 같은 이름 옵션. 없으면 글자모양이 다른 run에 걸친 자리는 건너뜀이고 2판 생성은 `FILL_SKIPPED`로 실패한다 |
| `unregistered` | `error`·`keep` | `error` | 등록되지 않은 `{{ 키 }}`의 처리(8.8.12) |
| `requireConfirm` | true·false | false | true이면 `default`·`fallback` 선택도 사용자 확정 전에는 막는다(8.8.8) |
| `unwrapFilled` | true·false | false | 채운 누름틀·메일머지 필드를 풀어 값 글만 남긴다(8.8.12) |
| `refreshPreview` | true·false | false | 결과의 `Preview/PrvText.txt`를 본문 글로 다시 쓴다(8.8.12) |

**정규 JSON**: 키는 코드 포인트순 정렬, 공백·줄바꿈 없음, UTF-8, 배열은 순서 유지, 끝 줄바꿈 없음. 저장 판의 식별과 `case.template.sha256`·원장의 템플릿 해시는 정규 JSON의 sha256(소문자 16진 64자)이다. 읽기 → 정규 쓰기 → 읽기가 같아야 한다(W1).

**예시 1: 템플릿**

```json
{
  "schema": "hwpx-studio/template@2", "id": "t3f9a01c2", "version": 4,
  "meta": { "name": "물품 구매 공고" },
  "source": { "kind": "hwpx", "sha256": "<원본 64자>" },
  "patterns": [
    { "id": "pt1", "name": "1단 제목", "marker": { "form": "digitDot", "level": 1 },
      "char": { "bold": true, "height": 1200, "print": "<글자모양 지문>" }, "place": "body",
      "match": ["marker", "bold", "height"], "rejected": [] }
  ],
  "anchors": [
    { "id": "a1", "kind": "range", "at": { "sectionIndex": 0, "parentPath": [] }, "from": 18, "to": 21,
      "print": { "first": { "text": "3. 참가자격", "sha256": "<64>" }, "last": { "text": "", "sha256": "<64>" },
                 "count": 4, "sha256": "<범위 글 전체 64>" }, "pattern": "pt1" },
    { "id": "a2", "kind": "word", "at": { "sectionIndex": 0, "path": [5] }, "start": 5, "end": 10,
      "print": { "text": "예시 사업", "before": "사업명: ", "after": "" } }
  ],
  "values": [
    { "id": "v1", "name": "사업명", "format": "text" },
    { "id": "v2", "name": "추정가격", "format": "money" },
    { "id": "v3", "name": "중소기업", "format": "text" }
  ],
  "bindings": [
    { "value": "v1", "key": "사업명", "aliases": ["사업 명"] },
    { "value": "v2", "key": "추정가격(원)" },
    { "value": "v3", "path": "bidder.sme" }
  ],
  "places": [
    { "id": "p1", "kind": "placeholder", "key": "사업명", "value": "v1" },
    { "id": "p2", "kind": "mailMerge", "key": "추정가격", "value": "v2" },
    { "id": "p3", "kind": "word", "anchor": "a2", "value": "v1" }
  ],
  "slots": [ { "id": "s1", "name": "참가자격", "anchors": ["a1"], "parent": null } ],
  "blocks": [
    { "id": "b1", "slot": "s1", "name": "직접생산", "priority": 20,
      "proto": { "id": "k7d20a4e1", "version": 2 }, "content": { "fragment": "<원형 v2 내용 64>" },
      "when": { "all": [ { "path": "v3", "op": "eq", "value": true },
                         { "path": "v2", "op": "ge", "value": 100000000 } ] } },
    { "id": "b2", "slot": "s1", "name": "일반", "priority": 0,
      "content": { "text": "{{사업명}}에는 자격을 갖춘 업체가 참가할 수 있습니다." } }
  ],
  "options": { "missing": "error", "unregistered": "error", "requireConfirm": false }
}
```

- `p2`의 `key`(문서 안 메일머지 필드의 FieldValue 인자)와 `v2`에 연결한 데이터 열 이름(`추정가격(원)`)은 서로 다른 것이다.
- `b1`은 원형 `k7d20a4e1`의 2판을 고정해 쓰고, `b2`는 이 템플릿 안의 글 블록이다.

#### 8.8.3 ID·이름·키 규칙

소유: 엔진 = Claude(형식·유일 검사). id 생성·지운 id 재사용 금지 = Codex(저장소).

- 내부 id는 `^[A-Za-z][A-Za-z0-9_-]{0,31}$`이고 템플릿 전체에서 종류와 관계없이 유일하다(`TPL_ID`). 저장소가 접두어 + 번호로 만든다: 앵커 `a`, 패턴 `pt`, 값 `v`, 자리 `p`, 슬롯 `s`, 블록 `b`. 번호는 출현 순서로 결정적이다.
- 지운 id는 다시 쓰지 않는다. 이전 판과 비교해야 알 수 있으므로 저장소가 막는다(엔진은 한 판만 본다).
- 값 id는 조건의 `path`로 쓰이므로 8.2의 경로 이름 규칙(글자·숫자·`_`·`-`)을 만족한다(위 정규식이 보장한다).
- 템플릿 id는 `t` + 16진 8자, 원형 id는 `k` + 16진 8자다(저장소가 줌). 표시 이름과 무관하고 불변이다.
- 표시 이름은 값끼리, 슬롯끼리 각각 유일하다. 유니코드 NFC로 정규화해 비교한다(`TPL_NAME_DUP`). 표시 이름은 참조에 쓰지 않는다. 블록 이름은 유일성을 요구하지 않는다.
- 자리 키는 `{{ }}` 안의 글이다. 앞뒤 공백을 제거하고 1~80자(코드 포인트)이며 `}}`와 줄바꿈을 포함하지 않는다. 2판에서는 8.2의 경로 꼴이 아니어도 된다(공백·점·괄호 허용). 비교는 NFC 정규화 뒤 정확 일치다.
- 키 하나는 값 하나에만 연결한다(`TPL_KEY_CONFLICT`).

#### 8.8.4 값과 연결

소유: 엔진 = Claude.

- 값 `{ id, name, format }`: `text`는 8.2의 값 변환을 따른다(문자열은 그대로, 숫자·불리언은 글, 객체·배열은 `DATA_NOT_SCALAR`). `money`는 정수로 읽히는 값(숫자, 또는 앞뒤 공백 없는 10진 정수 글. 음수 허용)만 받는다. 조건에서는 숫자이고 출력은 천 단위 쉼표와 `원`이다(`1234` → `1,234원`, `-1234` → `-1,234원`). 정수로 읽히지 않으면 `DATA_FORMAT`이다. 허용 범위는 안전 정수(±2⁵³−1)다. `"+5"`·빈 글·`"1,234"`·소수는 `DATA_FORMAT`, `"007"`은 7, `-0`은 0이다(#29 구현 확정).
- 연결 `{ value, key 또는 path, aliases? }`: 값에 데이터 한 칸을 잇는다. 쓰이는 값(자리·조건·블록 글이 가리키는 값)마다 정확히 하나가 있어야 하고, 없으면 `TPL_UNBOUND_VALUE`, 둘 이상이면 `TPL_FIELD`다. 쓰이지 않는 값은 연결이 없어도 된다. `bindings[]`가 없으면 빈 목록으로 읽는다.
  - `key`: 데이터 행(JSON 객체)의 최상위 열 이름 그대로다. 공백·점·괄호가 있어도 된다(점은 경로 구분이 아니다). 엑셀 머리글을 그대로 쓰기 위한 것이다.
  - `path`: 중첩 경로(8.2의 경로 문법).
  - `aliases`: 같은 값의 다른 열 이름(머리글 차이). `key`와 같은 순위로 찾는다.
  - 행에서 `key`와 별칭 가운데 둘 이상에 값(null·없음이 아님. 빈 글은 값이다)이 있으면 `DATA_ALIAS_CONFLICT`다. 하나만 있으면 그것을 쓰고, 없으면 `missing`이다.
  - 한 키(별칭 포함)를 두 값에 연결하면 `TPL_KEY_CONFLICT`다.
- `bindValues(t, record, case, opts)`는 값 표를 돌려준다. 값마다 `{ id, name, format, state, text?, number?, source, issue? }`이고 `state`는 `bound`(행에서 찾음)·`edited`(`valueEdits`가 이김)·`missing`(값 없음)·`empty`(빈 글)·`rejected`(형식·제어 문자 오류)다(8.8.15). 순서: ① 연결로 행에서 찾는다(`source`는 어디서 왔는지: 열 이름·별칭·경로·수정·없음). ② `case.valueEdits[값 id]`가 있으면 그것이 이긴다(원본 행은 바꾸지 않는다. state `edited`). ③ 형식을 적용한다(`money`는 `number`와 `1,234원` 꼴 `text`). ④ 글에 XML 금지 제어 문자가 있으면 `VALUE_CONTROL_CHAR`(8.2). 값 오류(`DATA_FORMAT`·`DATA_NOT_SCALAR`·`DATA_ALIAS_CONFLICT`·`VALUE_CONTROL_CHAR`)는 던지지 않고 `rejected`와 `issue { code, message }`로 남긴다(그 값을 쓰는 자리·조건이 있을 때만 막힌다. 값 원문은 담지 않는다). 값이 없으면 누락 정책과 무관하게 state `missing`이다.
- 누락 정책 `opts.missing`은 그 값을 쓰는 자리를 채울 때만 적용한다. `error`면 `missing` 값의 `issue`가 `DATA_MISSING`(채움 중단), `empty`면 `text`가 빈 글, `keep`이면 `text`가 없어 자리를 그대로 둔다. 조건에서의 누락은 8.8.8이 다룬다.
- 같은 값을 여러 자리가 쓴다. 한 값은 어디서나 같은 글이다.
- 연결은 템플릿 안의 별도 절(`bindings[]`)에 둔다. 데이터 머리글이 달라지면 별칭을 더해 새 템플릿 판으로 저장한다.

#### 8.8.5 자리 종류와 적용 범위

소유: 엔진 = Claude.

| kind | 찾는 법 | 적용 범위 | 비고 |
| --- | --- | --- | --- |
| `clickHere` | `name`(+`occurrence`) | 원본과 선택된 블록 안의 같은 이름 전부. `occurrence`를 주면 원본의 그 곳만 | type이 `CLICK_HERE`인 필드만(8.3) |
| `mailMerge` | `key` = FieldValue 인자 | 같은 키 전부 | 이름 속성이 빈 메일머지 필드(#18). 필드 안 표시 글(`{{키}}`나 옛 값)은 이 자리가 맡는다. 엔진 앵커 `mergeField { key, occurrence? }`(7.10) |
| `placeholder` | `key` | 원본과 선택된 블록의 `{{ 키 }}` 전부 | 누름틀·메일머지 구간 안의 것은 그 필드 자리가 맡는다(8.3의 `dropped` 규칙) |
| `word`·`line`·`cell` | `anchor` | 원본만 | 사용자가 지정한 자리. 블록 교체 범위 안이면 `dropped`(`PLACE_COVERED`) |

- 공통 필드는 `{ id, kind, value, where? }`다. `value`는 값 id다. `where`(블록 id)를 주면 그 블록 안에서만 적용한다(`clickHere`·`mailMerge`·`placeholder`만. 그 블록이 선택되지 않으면 적용할 곳이 없을 뿐 오류가 아니다).
- `{{ 키 }}` 인식(느슨한 찾기): `{{`와 `}}` 사이 글에서 앞뒤 공백을 뺀 것이 키다(8.8.3). 8.2의 `{{경로}}` 문법과 달리 경로 꼴이 아니어도 된다. 한 `{{ }}`가 글자모양이 다른 run에 걸치거나 경계 조각을 가로지르면 8.3의 `FILL_MIXED_FORMAT`·`FILL_CROSSES_MARKUP` 건너뜀이다.
- 같은 종류·같은 키(이름)의 자리를 다른 값에 연결하면 `TPL_KEY_CONFLICT`다.
- `source.kind`가 `md`이면 `clickHere`·`mailMerge`를 쓸 수 없고(`TPL_ANCHOR`), 앵커는 9절의 것을 쓴다.
- 원본에서 찾은 후보 자리(`findCandidates`, 8.3)는 사용자가 승인해야 자리가 된다. 승인 전에는 `places[]`에 넣지 않는다.

#### 8.8.6 슬롯·블록·중첩 예약

소유: 엔진 = Claude.

- 슬롯 `{ id, name, anchors[≥1], parent }`: 앵커는 `range`(여러 문단) 또는 `line`(한 문단. md의 표식 줄 포함)이다. 다른 종류는 `TPL_ANCHOR`다. 앵커가 여럿이면 같은 선택을 모든 곳에 적용한다(lite의 "같은 group의 Range가 여럿이면 모두 같은 블록으로"에 해당). 한 앵커는 한 슬롯에만 속하고, 같은 구역·부모에서 범위가 겹치면 `TPL_CONFLICT`다.
- 슬롯당 선택은 하나다(다중 선택은 1차에서 하지 않는다).
- 블록 `{ id, slot, name, content, proto?, forkedFrom?, when?, priority? }`:
  - `content`: `{ fragment: <sha256> }`(조각 `hwpx-studio/fragment@1` JSON 바이트의 해시. 7.3. 바이트는 `loadBlob`이 준다) 또는 `{ text }`(여러 줄이면 줄마다 문단. `{{ 키 }}` 가능). md 템플릿은 `text`만 쓴다.
  - `when`: 8.2의 `Condition`. `path`는 값 id만 쓴다(아니면 `TPL_REF`). 없으면 조건 없는 블록이다.
  - `priority`: 정수, 기본 0. 조건 있는 블록 사이에서만 쓴다(8.8.8).
  - `proto`·`forkedFrom`: 8.8.7. 둘이 함께 있으면 `TPL_FIELD`다.
- 중첩 예약: `slot.parent`는 `null` 또는 블록 id다. 읽을 때 참조(`TPL_REF`)와 순환(`TPL_CYCLE`: 슬롯 → 부모 블록 → 그 블록의 슬롯 → …, 자기 부모)을 검사한다. null이 아니면 생성은 `TPL_NESTED`로 거절한다. 선택 상태 `inactive`(상위 블록이 선택되지 않은 중첩 슬롯)가 이 예약의 몫이다.

#### 8.8.7 원형 `block-proto@1`

소유: 엔진 = Claude(읽기·영향 목록·전파 계획). 원형 저장·새 판 만들기 = Codex(저장소·화면).

원형은 템플릿 밖의 별도 항목이다. 템플릿의 블록은 원형의 판 번호를 고정(핀)하고, 그 판의 내용을 `content`로 복사해 가진다(원형 없이도 생성할 수 있다).

**예시 2: 공용 블록 원형과 참조** (#21)

```json
{
  "schema": "hwpx-studio/block-proto@1", "id": "k7d20a4e1", "version": 3,
  "name": "참가자격(직접생산)",
  "content": { "fragment": "<v3 내용 64>" },
  "keys": ["사업명"],
  "previous": { "version": 2, "content": "<v2 내용 64>" },
  "note": "규정 개정 반영"
}
```

- `content`는 블록과 같은 꼴이다. "내용 해시"는 `fragment`이면 그 해시, `text`이면 글의 UTF-8 sha256이다. `keys`는 내용에 쓰인 자리 키 목록이다(만드는 쪽이 계산해 넣는다. 엔진의 `readBlockProto`는 형식만 본다). `previous`는 직전 판의 번호와 내용 해시다.
- 핀 검사: 블록에 `proto`가 있으면 그 판의 내용과 블록 `content`가 같아야 한다(`TPL_PROTO_MISMATCH`). 검사는 읽는 쪽이 준 `lookupProto`로 한다(8.8.10). `lookupProto`가 그 판을 찾지 못해도 `TPL_PROTO_MISMATCH`다.

영향 목록 `listProtoUsage(templates, protoId, latest)` 결과:

```json
{ "proto": "k7d20a4e1", "latest": 3, "usages": [
  { "template": "t3f9a01c2", "version": 4, "blocks": ["b1"], "pinned": 2, "state": "behind" },
  { "template": "t0a55e7b9", "version": 7, "blocks": ["b3"], "pinned": 3, "state": "current" },
  { "template": "t81c4d0f6", "version": 2, "blocks": ["b2"], "forkedFrom": 2, "state": "forked" } ] }
```

- `templates`는 읽은 템플릿(각 템플릿의 최신 판), `latest`는 저장소가 아는 원형의 최신 판 번호다. 형식과 무관한 순수 함수다. `state`: `current`(핀 = latest), `behind`(핀 < latest), `forked`(`proto`가 없고 `forkedFrom`만 있음. `forkedFrom`은 갈라진 원형 판 번호).
- 전파: 템플릿별로 골라 `planProtoUpdate(t, proto)`가 새 템플릿 판(`version` + 1, 핀과 내용 갱신)을 계획한다. 고르지 않은 템플릿은 그대로다. 자동 전파는 없다. 원형 `keys` 가운데 그 템플릿에 자리(`placeholder`)나 그 자리의 값 연결이 없는 키가 있으면 막는다(`PROTO_UNBOUND_KEY`, `HwpxError`로 던지고 새 판 없음). 전파로 블록 내용이 바뀌면 그 블록을 저장 선택으로 가진 이번 건은 `recheck`가 된다(8.8.8). 세부(#29 구현 확정): `listProtoUsage`는 핀이 `latest`와 같거나 크면 `current`, 작으면 `behind`, `forkedFrom`만 있으면 `forked`다. `planProtoUpdate`는 핀 판이 원형 판보다 낮은 블록만 갱신하고, 갱신할 블록이 없으면 같은 판의 복사본과 빈 `updated`를 돌려준다. 키 검사는 `where`가 없거나 그 블록을 가리키는 `placeholder` 자리만 센다.
- 분기: 템플릿 안에서 원형 블록을 직접 고치면 `proto`가 빠지고 `forkedFrom: { id, version }`이 남는다. 분기 블록은 전파 대상이 아니고 영향 목록에 알림(`forked`)만 간다. 분기는 저장소·화면이 하고, 어긋난 채 저장된 템플릿은 엔진이 `TPL_PROTO_MISMATCH`로 거절한다.
- 이번 건 수정과 분리: 이번 건에서 고친 블록은 `case.blockEdits`에만 남는다. "원형에 반영"은 별도 명시 동작(원형 새 판)이다.

#### 8.8.8 선택 평가와 상태 7종

소유: 엔진 = Claude. 화면 표시 = [스튜디오 명세](studio-spec.md) 4b.

| 상태 | 저장 위치 | 뜻 | 생성 |
| --- | --- | --- | --- |
| `manual` | 이번 건 | 사용자가 고름 | 쓴다. 조건 결과와 달라도 바꾸지 않고 차이만 표시한다 |
| `confirmed` | 이번 건 | 기본 선택을 사용자가 확정 | 쓴다. 데이터가 바뀌어도 유지하고 차이만 표시한다 |
| `default` | 계산 | 조건 참 블록 중 최고 우선순위 하나 | 쓴다(`requireConfirm`이면 막음) |
| `fallback` | 계산 | 참인 조건이 없고 조건 없는 블록이 하나 | 쓴다(위와 같음) |
| `undecided` | 계산 | 동률, 후보 없음, 조건 값 없음 | 막음 `SEL_UNDECIDED` |
| `recheck` | 계산 | 저장한 선택의 블록이 없어짐·내용 해시 변경(원형 전파 포함)·상위 선택 변경 | 막음 `SEL_RECHECK` |
| `inactive` | 계산 | 상위 블록이 선택되지 않은 중첩 슬롯(예약) | 해당 없음 |

`selectSlots(t, values, case): SlotSelection[]`는 슬롯마다 아래 순서로 판정한다. `values`는 `bindValues`의 값 표다.

1. `slot.parent`가 null이 아니고 그 블록이 선택되지 않았으면 `inactive`(예약).
2. `case.selections[슬롯]`이 있으면: 그 블록이 템플릿에 없거나 저장한 `content` 해시가 블록의 현재 내용 해시와 다르면 `recheck`(`reason`: `blockMissing`·`contentChanged`. 상위 선택 변경은 `parentChanged`). 아니면 `basis`가 `manual`이면 `manual`, `confirmed`이면 `confirmed`다. 조건 결과가 다르면 `differs: true`로 표시만 한다.
3. 저장 선택이 없으면 계산한다. 조건은 8.2의 `evaluateCondition`을 재사용하고, 데이터는 값 표에서 만든 객체 `{ <값 id>: 값 }`다(`money`는 숫자, 그 밖은 글, `missing`은 키 없음. `derived` 없음).
   - 블록의 `when`이 참조하는 값이 `missing`이면 판정할 수 없어 슬롯은 `undecided`다(`reason: valueMissing`). 단, 그 값에 `exists`·`empty`만 쓴 참조는 제외한다(값이 없는 것이 정상 입력이다).
   - 조건 있는 블록 가운데 참인 것이 있으면 최고 `priority` 하나가 `default`다. 최고 우선순위가 동률이면 `undecided`(`reason: tie`).
   - 참인 조건 블록이 없으면 조건 없는 블록이 하나일 때 `fallback`이다. 둘 이상이면 `undecided`(`reason: tie`), 없으면 `undecided`(`reason: noCandidate`).
4. `options.requireConfirm`이 true이면 `default`·`fallback`은 사용자가 확정(`confirmed`로 저장)하기 전까지 막는다(`SEL_UNDECIDED`, `reason: needConfirm`).

세부(#29 구현 확정):
- 블록의 `when`이 참조하는 값이 `rejected`(형식·제어 문자 오류)이면 `undecided`(`reason: valueRejected`). `valueMissing`·`valueRejected`·`tie`는 관련 블록을 `candidates`에 적는다.
- 저장 선택의 블록이 있어도 다른 슬롯 소속이면 `recheck`(`blockMissing`).
- `parentChanged`는 상위 슬롯이 그 블록을 저장 선택으로 가진 채 `recheck`이고 하위에도 저장 선택이 있을 때다. 상위가 다른 블록을 고르면 하위는 `inactive`다. 확정을 기다리는 `default`·`fallback` 상위는 하위 평가에서 선택된 것으로 본다.
- 결과 `SlotSelection`에 막는 코드 `blocked`(`SEL_UNDECIDED`·`SEL_RECHECK`)와 사람이 읽는 `message`(값 원문 없음)가 있다(8.8.15).

- 막는 상태는 슬롯마다 `SEL_*` 오류로 모아서 낸다. 첫 슬롯에서 멈추지 않는다. 생성은 출력이 없다.
- `manual`·`confirmed`는 데이터가 바뀌어도 바꾸지 않는다. 사용자가 다시 고르거나 확정하면 `selections`가 새 내용 해시로 갱신되어 `recheck`가 풀린다.
- 고르지 않은 블록의 글·누름틀은 출력에 없다(8.8.12).
- lite의 `selectBlocks`처럼 동률·조건 값 누락을 묻지 않고 고르는 동작은 2판에 없다. 이관 때의 차이는 `MIG_POLICY`다(8.8.14).

#### 8.8.9 이번 건 `case@1`

소유: 엔진 = Claude(읽기·검사·적용 규칙). 저장·진행 중 덮어쓰기 = Codex.

```json
{ "schema": "hwpx-studio/case@1",
  "template": { "id": "t3f9a01c2", "version": 4, "sha256": "<정규 JSON 64>" },
  "record": { "dataset": "d71c0e5a2", "version": 1, "row": 3, "sha256": "<행 64>" },
  "selections": { "s1": { "block": "b2", "basis": "manual", "content": "<b2 내용 64>" } },
  "valueEdits": { "v1": "예시 사업(정정)" },
  "blockEdits": { "b2": { "text": "{{사업명}}에는 자격을 갖춘 업체가 참가할 수 있습니다(이번 건만)." } } }
```

| 필드 | 뜻 |
| --- | --- |
| `template` | 만든 때의 템플릿 `{ id, version, sha256(정규 JSON) }` |
| `record` | 데이터 `{ dataset, version, row, sha256 }`. `sha256`은 그 행 객체의 정규 JSON 해시(행 해시) |
| `selections` | 슬롯 id → `{ block, basis: "manual" 또는 "confirmed", content }`. `content`는 고른 때의 블록 내용 해시 |
| `valueEdits` | 값 id → 정정한 글. 원본 데이터는 바꾸지 않는다(8.8.4) |
| `blockEdits` | 블록 id → 이번 건만의 내용(블록 `content`와 같은 꼴). 선택된 블록일 때만 쓰인다 |

- `readCase(json, t)`: `t`가 `case.template`과 같은 판(id·version이 같고 해시도 같음)이면 `selections`·`valueEdits`·`blockEdits`의 id가 모두 `t`에 있어야 한다(없으면 `TPL_REF`). id·version은 같은데 해시가 다르면 `TPL_REF`다. id가 다르면 `TPL_REF`다.
- 템플릿의 새 판을 `selectSlots`에 넘기면 이어 쓸 수 있다. 같은 슬롯·블록 id와 내용 해시가 그대로면 선택이 유지되고, 달라진 것은 `recheck`다(8.8.8).
- `blockEdits`·`valueEdits`·`selections`는 원형·템플릿·원본 데이터로 새지 않는다. 생성이 끝나면 원장이 이번 건 해시를 고정한다(8.8.12).

#### 8.8.10 읽기 검사와 오류 코드

소유: 엔진 = Claude.

- `readStudioTemplate(json, opts)`, `readCase(json, t)`, `readBlockProto(json)`. `json`은 문자열이다. 실패하면 `HwpxError`를 던지고 `where`에 JSON 위치(예: `blocks[1].proto`)를 담는다. 첫 오류에서 멈춘다(1판 `readTemplate`과 같다). 아무것도 쓰지 않는다.
- 선택 검사는 호출자가 준 함수로 한다: `opts.lookupProto(id, version)`(원형 판의 내용을 줌, 원형 핀 검사), `opts.hasBlob(sha256)`(덩어리 존재 검사). 주지 않으면 그 검사는 생략하고 생성 때 `generateFromTemplate`가 `loadBlob`으로 확인한다.
- 거부 항목과 코드(표는 항목 목록이다. 검사 순서는 구현이 정하며 한 입력에 여러 결함이 있으면 그중 하나의 코드가 난다. 최상위 결함의 `where`는 `"템플릿"`·`"이번 건"`·`"원형"`이다):

| 거부 항목 | 코드 |
| --- | --- |
| JSON이 아니다 | `TPL_JSON` |
| `schema`가 없다, 이름이 다르다 | `TPL_SCHEMA` |
| 지원하지 않는 번호: `template@3`·`@0`, `case@2`, `block-proto@2` | `TPL_VERSION` |
| 모르는 키, 빠진 필수 필드, 틀린 형식 | `TPL_FIELD`(앵커 안은 `TPL_ANCHOR`, `options` 안은 `TPL_OPTIONS`, `rules` 안은 `TPL_RULE`) |
| id 형식 오류, id 중복(종류 안·종류 사이) | `TPL_ID` |
| 표시 이름 중복(값끼리·슬롯끼리) | `TPL_NAME_DUP` |
| 쓰임에 맞지 않는 앵커 종류·필드(예: `word` 자리가 `clickHere` 앵커를 가리킴, 슬롯 앵커가 `cell`, md에 `mailMerge`) | `TPL_ANCHOR` |
| 끊긴 참조: `place.value`·`place.anchor`, `slot.anchors`, `block.slot`, 조건 경로(값 id가 아님), `binding.value`, 이번 건의 슬롯·블록·값 id, 다른 템플릿을 가리키는 이번 건 | `TPL_REF` |
| 순환: `slot.parent` → 블록 → 슬롯 …, 자기 부모 | `TPL_CYCLE` |
| 한 키(별칭 포함) 또는 같은 `path`를 두 값에 연결, 같은 종류·같은 키의 자리를 다른 값에 연결(`key`와 `path`는 다른 이름 공간이라 교차 검사하지 않는다) | `TPL_KEY_CONFLICT` |
| 두 슬롯의 앵커가 겹친다 | `TPL_CONFLICT` |
| 쓰이는 값에 연결이 없다 | `TPL_UNBOUND_VALUE` |
| 조건 연산자·정규식 한도 위반 | `TPL_CONDITION`(8.7) |
| 1판 `rules[]`와 `slots`·`places`를 함께 씀 | `TPL_MIXED_RULES` |
| 덩어리 해시에 해당하는 덩어리가 없다 | `TPL_FRAGMENT_MISSING` |
| 원형 핀의 내용이 블록 내용과 다르다 | `TPL_PROTO_MISMATCH` |

- 읽을 때 잡지 않고 생성 때 잡는 것: `slot.parent`가 null이 아닌 중첩 슬롯(`TPL_NESTED`, 8.8.6), 원본 해시 불일치(`TPL_SOURCE_MISMATCH`, 8.8.12), 별칭 충돌·형식 오류(`DATA_ALIAS_CONFLICT`·`DATA_FORMAT`, 값 확정 때, 8.8.4).
- `block-proto@1`·`case@1`의 판 번호가 다르면 `TPL_VERSION`, 형식이 틀리면 `TPL_FIELD`다(`where`가 어느 파일 형식인지 알려 준다).
- 해시(sha256)는 소문자 16진 64자로 저장한다. 입력의 대문자는 읽을 때 소문자로 바꾸고, `lookupProto`가 준 해시도 소문자로 비교한다. 정수 필드의 `-0`은 `0`으로 읽는다(쓰기와 왕복이 같도록).

#### 8.8.11 1판 승계

소유: 엔진 = Claude.

- `template@1`의 `readTemplate`·`generate`·CLI 동작은 바꾸지 않는다. 옛 엔진은 `@2`를 `TPL_SCHEMA`로 거절한다(1판 읽기의 기존 동작).
- `readStudioTemplate`는 `@1`을 읽어 `anchors`·`rules`·`options`만 가진 승계 템플릿(1판 `Template` 객체. `readTemplate` 결과와 같다. `slots`·`places` 필드 자체가 없다)으로 돌려준다. 승계 템플릿의 생성은 기존 `generate`(8.3) 한 번이라 1판 경로와 바이트가 같다. `{{경로}}` 암묵 채움(8.3)도 승계 템플릿에서만 유지된다.
- `rules[]`는 승계 전용이다. 2판 템플릿에서 `slots`·`places`와 함께 쓰면 `TPL_MIXED_RULES`다(1차 금지). 2판 템플릿은 암묵 채움을 하지 않고 등록된 자리만 채운다(8.8.12).
- 엔진 내부 `Template`의 앵커에 `range`·`mergeField`를 더한다(더하기만). `range` 앵커와 `cell`·`object`의 선택 `print`는 1판 `readTemplate`도 받는다(#30에서 더함. 7.10). 기존 1판 템플릿의 읽기 결과는 바뀌지 않는다.

#### 8.8.12 컴파일·2단계 생성·게이트·원장·원본 해시

소유: 엔진 = Claude(`generateFromTemplate`, CLI). 호출(앱) = Codex.

`generateFromTemplate(bytes, t, record, case, loadBlob, opts): GenerateResult`의 순서다. 어느 단계든 실패하면 출력이 없다. 순수 함수이고 시계·파일을 모르므로 같은 입력은 같은 바이트다.

1. 원본 대조: `bytes`의 sha256이 `t.source.sha256`과 다르면 `TPL_SOURCE_MISMATCH`다. 이 검사가 앵커 상태(8.8.13)보다 앞선다.
2. 검사: 템플릿·이번 건을 8.8.10대로 읽고, 중첩 슬롯이 있으면 `TPL_NESTED`다. 조각은 `loadBlob(sha256)`으로 가져온다. 없거나 받은 바이트의 해시가 요청과 다르면 `TPL_FRAGMENT_MISSING`이다.
3. 값: `bindValues`(8.8.4). 글이 확정된다.
4. 선택: `selectSlots`(8.8.8). 슬롯이 하나라도 막으면 슬롯마다 `SEL_*`를 모아 내고 끝낸다.
5. 앵커: 원본 해시가 같으면 `checkAnchors`는 exact·unverified만 낸다. 그 밖의 상태는 템플릿이 손상된 것이므로 해당 코드로 막는다.
6. 구조 → 값 두 단계 생성(아래 표).
7. 후처리(켠 것만)와 끝 판정.

**컴파일 규칙** (lite에서 검증된 2단계를 엔진으로)

| 계약 요소 | 1단계: 구조(원본 좌표, 빈 데이터) | 2단계: 값(조립본) |
| --- | --- | --- |
| 슬롯 s의 선택 블록 b(조각) | 슬롯 앵커마다 문서 순서로 `inject { anchor, position: "replace", fragment }`. 내용은 `blockEdits[b]`가 있으면 그것 | — |
| b(글) | `insertText { anchor, "replace", { text }, style: "inherit" }`, 줄마다 문단 | 글 안 `{{키}}`는 `placeholder` 자리가 채운다 |
| 고르지 않은 블록 | 규칙 없음(출력에 없다) | — |
| `word`·`line`·`cell` 자리 | — | 1단계 이동표(7.10)로 주소를 옮긴 뒤 `fill { text }`. 교체 범위 안이면 `dropped`(`PLACE_COVERED`) |
| `clickHere`·`mailMerge` 자리 | — | 조립본에서 이름·키로 다시 열거한다(조각 때문에 순번이 바뀐다). `occurrence`는 이동표로 옮겨 찾는다 |
| `placeholder` 자리 | — | 조립본의 `{{ 키 }}`마다 `word` 앵커를 만들고 `fill { text }` |
| 등록되지 않은 `{{ }}` | — | `unregistered: error`이면 `PLACE_UNREGISTERED`, 출력 없음. `keep`이면 경고를 남기고 그대로 둔다 |
| 값 | 생성 전에 `bindValues`로 글 확정(형식·누락 정책·제어 문자·`valueEdits`) | 규칙은 `{text}`만 쓰고, 데이터 묶음은 비우고 `missing: "keep"` |
| 판정 | 단계마다 `generate` 게이트(`allowNothingApplied`) | 건너뜀이 1건이라도 있으면 실패(`FILL_SKIPPED`). 끝에서 원본 대비 누적 기준선 비교 |

- 1단계와 2단계는 8.3의 `generate`를 그대로 재사용한다. 2단계는 1단계 결과를 다시 파싱한 조립본에서 자리를 찾는다. 1단계에서 `inject`·`insertText`가 쓰는 조각 안의 `{{}}`는 비운 데이터 묶음 때문에 채워지지 않고(`missing: "keep"`), 2단계가 채운다.
- 등록되지 않은 누름틀·메일머지 필드는 손대지 않는다. `{{ }}`의 등록 여부는 `places[]`의 `placeholder`로만 정해진다. 누름틀·메일머지 구간 안의 `{{ }}`는 그 필드 자리가 맡으므로 등록 검사에서 뺀다.
- 건너뜀(`FILL_CROSSES_MARKUP`·`FILL_MIXED_FORMAT` 등)은 `report.skipped`에 남고, 1건이라도 있으면 `FILL_SKIPPED`로 실패한다(메시지에 건너뜀 코드별 건수). `dropped`는 실패가 아니다.
- 원장(`ledger`, 8.3)에 더하는 것: 원본 해시, 템플릿 `{ id, version, 정규 JSON 해시 }`, 이번 건 정규 JSON 해시, 행 해시(와 dataset id·version). 값 원문은 넣지 않는다.
- 후처리 2종(`options`로 켠 것만. 기본 끔. 이관 템플릿만 켠다): `unwrapFilled`는 채운 누름틀·메일머지 필드의 표식을 지워 값 글만 남기고, `refreshPreview`는 `Preview/PrvText.txt`를 결과 본문의 글로 다시 쓴다. 정확한 규칙은 lite의 현재 결과와 대조해 구현할 때 확정한다(8.8.14의 결과 동일 판정이 검사한다).
- `source.kind`가 `md`이면 텍스트 어댑터(9절)로 같은 순서를 따른다. 슬롯 앵커는 표식 줄 `line`, 블록은 `text`다. 결과는 `{ ok, output?, report }`이고 원장은 없다(9.1). `source.sha256`은 입력 문자열의 UTF-8 바이트(BOM 포함) 해시다.
- 원본 해시: `source.sha256`은 원본 문서 바이트의 sha256(소문자 16진 64자)이다. 8.7의 "대조하지 않는다"는 1판의 한계이고 2판은 위 1번에서 대조한다.
- 같은 입력으로 두 번 생성하면 출력과 원장이 바이트까지 같다. CLI(8.4)와 앱의 결과가 같아야 한다.

#### 8.8.13 `checkAnchors`와 재지정

소유: 엔진 = Claude. 재지정 화면 = Codex.

`checkAnchors(doc, t): AnchorCheck[]`는 템플릿(1판 `Template` 또는 `StudioTemplate`. `anchors`만 쓴다)의 앵커마다 `doc`(새 원본)에서의 상태를 돌려준다. `resolveAnchors`(8.3)와 `locateRange`(7.10)를 재사용한다. `field`·`mergeField` 앵커는 이름·키(+`occurrence`)로 찾으므로 exact 또는 notFound뿐이다(`occurrence`는 수만 맞으면 exact다. 앞쪽 필드가 지워져 다른 필드를 가리켜도 알아내지 못한다). **[구현 #32]**(2026-10-04. 검증은 [검증 기준](validation.md) 21절).

| 상태 | 판정 | 코드 | 생성에 쓸 수 있나 | 사용자 |
| --- | --- | --- | --- | --- |
| exact | 주소의 지문 일치 | — | 가능 | — |
| relocated | 같은 구역에서 지문이 한 곳 | `ANCHOR_RELOCATED`(경고) | 가능(경고) | 새 판으로 주소 갱신을 수락 |
| changed | `range`의 양 끝은 찾았으나 안쪽 해시가 다름 | `ANCHOR_CHANGED` | 막음 | 확인 또는 재지정 |
| ambiguous | 지문 일치가 2곳 이상 | `ANCHOR_AMBIGUOUS` | 막음 | 재지정(같은 패턴 후보 표시) |
| notFound | 없음 | `ANCHOR_NOT_FOUND` | 막음 | 재지정 또는 자리 삭제 |
| unverified | 지문 없는 `cell`·`object`(1판 승계)인데 그 서수의 표·개체가 있다 | `ANCHOR_UNVERIFIED`(경고) | 원본 해시가 같을 때만 | 확인 |

- "생성에 쓸 수 있나"는 앵커 상태만 본 판정이다. 원본 해시가 다르면 상태와 무관하게 `TPL_SOURCE_MISMATCH`가 먼저 막는다(8.8.12). 그래서 원본이 바뀐 뒤에는 아래 재지정으로 새 템플릿 판(새 `source.sha256`)을 저장해야 한다.
- 지문: `word`·`line`은 8.2, `range`·`cell`·`object`는 7.10. 지문 없는 `cell`·`object`의 서수 자리가 아예 없으면 unverified가 아니라 notFound다(`resolveAnchors`도 생성을 막는다). `cell`·`object`의 주소는 표·개체 서수라서 앞에 문단만 넣으면 exact이고, 앞에 표·개체를 넣으면 지문 있는 것은 relocated, 없는 것은 unverified다.
- 결과 `AnchorCheck = { anchor, kind, state, found?, issues }`. `found`는 exact·relocated·unverified일 때 다시 찾은 주소(`word`는 `at`·`start`·`end`, `line`은 `at`, `range`는 `at`·`from`·`to`, `cell`은 `table`·`row`·`col`, `object`는 `objectType`·`sectionIndex`·`ordinal`)이고 `field`·`mergeField`에는 없다. `issues`에 문서 글은 넣지 않는다.
- `planRelocation(t, checks): { anchors, changed: string[] } | undefined`: exact가 아닌 앵커가 전부 relocated(또는 unverified)일 때만 같은 id에 새 주소를 넣은 앵커 배열을 돌려준다(지문은 전체 일치라 그대로). changed·ambiguous·notFound가 하나라도 있으면 `undefined`. unverified 앵커는 그대로 둔다(서수만 보고 지문을 만들면 잘못된 표를 확정할 수 있다. 확인은 호출자 몫). 템플릿을 저장하지 않고 입력도 바꾸지 않는다.
- `redraftAnchor(doc, old, draft): { anchor, kindChanged }`: `draftAnchors`([뷰어 명세](viewer-spec.md) 4절)의 초안에 옛 앵커의 `id`·`pattern`을 붙이고(초안의 `id`·`pattern`은 버린다), `range`·`cell`·`object`는 `doc`에서 지문을 다시 뜬다(`make*Anchor`). 종류가 바뀌면 `kindChanged: true`(허용). 옛 앵커가 `mergeField`이고 초안이 키로 가리키는 `field`이면 `mergeField`로 적는다. 초안의 `blocked`는 뺀다. 결과 앵커는 그 종류의 필드만 갖는다. 초안의 주소(문단·낱말 범위·범위·표 서수와 칸·개체 서수)가 문서에 없으면 모든 종류에서 `FILL_DRAFT_ADDRESS`.
- 판정 순서: 주소의 지문이 맞으면 다른 곳에 같은 지문의 복제본이 있어도 exact다(exact가 ambiguous보다 앞선다). 복제가 ambiguous로 나오는 것은 원래 주소가 어긋났을 때다.
- unverified의 정확한 조건: `cell`은 그 서수의 표에 그 (행, 열) 칸까지 있어야 하고, 없으면 notFound다. 지문이 없으므로 표가 끼어들면 다른 표를 가리킨 채 unverified가 될 수 있다(설계대로. 경고로 알리고 확인은 사용자 몫).

**재지정 흐름**

1. `source.sha256`을 새 원본과 대조한다. 같으면 끝이다.
2. 다르면 `checkAnchors`의 상태표를 낸다.
3. `relocated`만 있으면 일괄 갱신을 제안한다.
4. 나머지는 슬롯·자리와 옛 앞뒤 글을 보여 주고 사용자가 새 원본에서 클릭해 다시 지정한다(`draftAnchors`, 앵커 id 유지). 앵커에 `pattern`이 있으면 `suggestSimilar`로 같은 패턴 후보를 함께 보인다.
5. 새 템플릿 판으로 저장한다(앵커·`source.sha256` 갱신).

#### 8.8.14 lite 이관

소유: 이관 코드(`apps/studio-lite/src/migrate.ts`)와 저장 = Codex(이슈 #4·#25). 엔진 = Claude(2판 읽기·검사, 앵커 API, 시험 자료, 이 절의 규칙). 엔진은 lite의 `Project` 형식을 import하지 않는다.

**대응표**

| lite | 2판 | 규칙 |
| --- | --- | --- |
| `version` | — | 1이 아니면 `MIG_VERSION` |
| 프로젝트 전체 | — | lite `checkProject` 실패면 `MIG_SCHEMA` |
| `name` | `meta.name` | |
| `mode: "hwpx"`, `sources[0]` | `source { hwpx, sha256 }`와 원본 덩어리 | hwpx가 아니거나 못 열면 `MIG_NO_MASTER` |
| `mode: "markdown"`, `markdown` | `source { md, sha256 }` | |
| `sources[1..]` | 템플릿에 넣지 않음(조각 추출에만) | 안 쓰이면 경고 `MIG_DROPPED_DONOR` |
| Field(approved, kind field) | `values` + `bindings` | name → 값 이름, column(없으면 name) → `key`, format 그대로 |
| 대상: field 앵커 | `clickHere { name }`, `occurrence` 버림 | lite가 조립 뒤 이름으로 전부 채우므로 |
| 대상: word `{{x}}` | `placeholder { key: x }` | |
| 대상: 그 밖의 word | 앵커(새 id) + `word` 자리 | Master 대상만. 없으면 `MIG_PLACE` |
| md 본문·Markdown 블록의 `{{x}}` | `placeholder` 자리. 같은 이름 값에 연결, 없으면 새 값(`key: x`) | lite의 "직접 작성 블록은 열을 바로 읽음" 보존 |
| fixed·block Field, `approved: false`, values·evidence·confidence | 버림 | 경고 `MIG_DROPPED_CANDIDATE`(수만) |
| `ranges`(group별) | `slot { name: group, anchors: range 앵커들 }` | `from − 1`~`to − 1`, 지문 계산. Master가 아니거나 범위 밖이거나 겹치면 `MIG_RANGE` |
| `[IN_TEMPLATE:g]`(md) | `slot { name: g, anchors: 표식 줄 line 앵커 }` | |
| `blocks` | 원형 v1 + 템플릿 블록(`proto` 고정) | group → slot, alias → name, priority 그대로. 내용이 같으면 같은 원형 |
| hwpx_fragment(sourceId, from, to) | 조각을 추출해 덩어리로 | 원본이 없거나 범위 밖이거나 `FRAG_*`이면 `MIG_BLOCK_SOURCE` |
| markdown 블록(hwpx 모드) | 지금 lite 경로로 조각을 만들어 고정 | 실패하면 `MIG_BLOCK_RENDER`. Markdown 변환 의존 제거(#11)보다 먼저 이관한다 |
| markdown 블록(md 모드) | `content.text` | |
| `condition` 문자열 | `when { all: [ { path: 값 id, op, value } ] }` | 키는 Field 이름을 먼저, 없으면 열(조건 전용 새 값). 못 읽으면 `MIG_CONDITION` |
| 범위·표식이 없는 그룹의 블록 | 버림 | 경고 `MIG_ORPHAN_BLOCK` |
| `records` | `dataset@1 { data: records }` | |
| `activeRecord` + `selectedBlocks` | `case@1 { row, selections: manual }` | 없는 블록이면 경고 `MIG_SELECTION` |

- 새 id는 출현 순서 번호로 결정적으로 만든다. 원형 id·템플릿 id는 저장소가 준다.
- 원형화: lite 블록은 이관 때 원형이 되고(v1), 내용 해시가 같은 블록은 같은 원형을 가리킨다.
- 이관한 템플릿은 후처리 `unwrapFilled`·`refreshPreview`를 켠다(8.8.12). G2B 프로필은 이관 뒤 Codex가 새 템플릿 판으로 옮긴다. `selectedBlocks`에 기대던 고정 선택은 Codex가 고정 선택 사본으로 만든다.

**보존**

- `project_revision` 행과 내보낸 JSON은 읽기만 한다.
- 새 행(덩어리·원형·템플릿·데이터·이번 건·이관 기록)은 한 트랜잭션으로 쓴다. 실패하면 되돌리고 `migration` 행에 코드만 남긴다.
- 이관이 성공하기 전까지 lite는 옛 형식으로 생성한다.

**결과 동일 판정** (레코드마다 옛 경로 `applyProject`와 새 경로를 비교)

| 판정 | 조건 | 처리 |
| --- | --- | --- |
| 가 | 둘 다 실패하고 코드가 대응한다 | 통과 |
| 나 | 둘 다 성공하고 바이트가 같다 | 통과 |
| 다 | 바이트는 다르나 의미가 같다: 문단 글 순서, 서식 지문 열, 표·그림·누름틀 수와 값이 같고, 검사기 새 오류 0 | 통과. 차이를 기록한다 |

- lite가 동률·조건 값 누락을 묻지 않고 고른 건은 새 경로에서 `SEL_UNDECIDED`다. 이것은 실패로 세지 않고 `MIG_POLICY` 목록(레코드·슬롯)으로 남긴다.
- 그 밖의 차이는 `MIG_RESULT_DIFF`이고 이관은 아무것도 쓰지 않는다.

**결정성**: 같은 입력을 두 번 이관하면 JSON과 덩어리의 바이트가 같다.

#### 8.8.15 공개 API

소유: 엔진 = Claude.

| API | 위치 | 뜻 |
| --- | --- | --- |
| `readStudioTemplate`, `readCase`, `readBlockProto` | `src/template/` | 읽기와 검사: 판 번호·id·참조·순환·원형 핀(8.8.10) |
| `writeStudioTemplate`, `writeCase`, `writeBlockProto` | `src/template/` | 정규 JSON 문자열(8.8.2). 해시와 저장의 기준 |
| `bindValues(t, record, case, opts)` | `src/template/` | 연결·별칭·형식·`valueEdits` → 값 표(상태 포함) |
| `selectSlots(t, values, case)` | `src/template/` | 8.8.8의 상태 판정. `evaluateCondition` 재사용 |
| `generateFromTemplate(bytes, t, record, case, loadBlob, opts)` | `src/fill/` | 8.8.12의 2단계 생성·게이트·원장. md는 텍스트 어댑터 |
| `range` 앵커와 `makeRangeAnchor`, 액션의 range 수용, 보고서의 `moves` | `src/fill/` | 7.10. 내부에서 이동표 변환과 느슨한 `{{ }}` 찾기 |
| `checkAnchors(doc, t)`, `planRelocation(t, checks)`, `redraftAnchor(doc, old, draft)` | `src/fill/` | 8.8.13의 상태표·relocated 일괄 갱신 계획·재지정(id 유지). `resolveAnchors`(안에서 `locateRange`)를 재사용하고, `draftAnchors`의 초안을 입력으로 받는다 |
| `patternOf(doc, at)`, `suggestSimilar(doc, pattern)` | `src/fill/` | 7.10(#20. #19의 탐지 규칙에 의존) |
| `listProtoUsage(templates, protoId, latest)`, `planProtoUpdate(t, proto)` | `src/template/` | 8.8.7(#21). 형식과 무관한 순수 함수 |
| CLI `fill --template(@2) --case --blobs <폴더>` | `apps/cli` | 8.4. 앱과 같은 바이트 |

구현 상태(2026-10-04): `read*`·`write*`·해시 도우미(`templateSha256`·`caseSha256`·`contentSha256`)·`bindValues`·`selectSlots`·`listProtoUsage`·`planProtoUpdate`는 #29, `range`·`moves`·`makeRangeAnchor`는 #30(7.10). `checkAnchors`·`planRelocation`·`redraftAnchor`는 #32(`src/fill/check-anchors.ts`). `generateFromTemplate`·CLI `--case --blobs`(#31), 패턴(#20)은 미구현. 정확한 형은 `src/template/studio-types.ts`(와 `src/fill/check-anchors.ts`)가 정본이고 아래는 요지다.

```ts
type ValueState = "bound" | "edited" | "missing" | "empty" | "rejected"
type BoundValue = { id: string; name: string; format: "text" | "money"; state: ValueState; text?: string; number?: number; source: BoundSource; issue?: { code: string; message: string } }
type SelectionState = "manual" | "confirmed" | "default" | "fallback" | "undecided" | "recheck" | "inactive"
type SelectionReason = "tie" | "noCandidate" | "valueMissing" | "valueRejected" | "needConfirm" | "blockMissing" | "contentChanged" | "parentChanged"
type SlotSelection = { slot: string; state: SelectionState; block?: string; reason?: SelectionReason; differs?: boolean; candidates?: string[]; blocked?: "SEL_UNDECIDED" | "SEL_RECHECK"; message: string }
type ProtoUsageList = { proto: string; latest: number; usages: { template: string; version: number; blocks: string[]; pinned?: number; forkedFrom?: number; state: "behind" | "current" | "forked" }[] }
type ProtoUpdatePlan = { template: StudioTemplate; updated: { block: string; from: number; to: number }[] }
type AnchorCheck = { anchor: string; kind: StudioAnchor["kind"]; state: "exact" | "relocated" | "changed" | "ambiguous" | "notFound" | "unverified"; found?: AnchorAddress; issues: Issue[] }
type AnchorAddress = Pick<WordAnchor, "kind" | "at" | "start" | "end"> | Pick<LineAnchor, "kind" | "at"> | Pick<RangeAnchor, "kind" | "at" | "from" | "to"> | Pick<CellAnchor, "kind" | "table" | "row" | "col"> | Pick<ObjectAnchor, "kind" | "objectType" | "sectionIndex" | "ordinal">
```

- 형식 중립 경계(8.5): `src/template/`의 함수는 문서 형식을 모른다(HWPX 모델을 import하지 않는다). HWPX에 묶인 `generateFromTemplate`·`checkAnchors`·`patternOf`·`suggestSimilar`는 `src/fill/`에 둔다.
- 앱(lite)은 위 함수만 부른다. 같은 함수를 CLI도 부르므로 결과 바이트가 같다.

#### 8.8.16 수용 조건

소유: 검사 = 엔진 쪽 독립 검증(Claude 지휘). 앱 쪽 항목 = Codex 시험. 통과 전에는 [미구현]이다. 상태(2026-10-04): W1~W3의 읽기·쓰기·값 연결·선택 평가 부분은 #29에서 통과([검증 기준](validation.md) 20절). W1의 생성 바이트 동일·W2의 `TPL_NESTED`·W3의 출력 항목은 #31, W4의 전파 함수는 #29(저장·화면은 Codex), W7의 `range` 지문은 #30(19절), W7의 상태 판정·일괄 갱신·재지정은 #32(21절. "생성이 막힌다"는 `resolveAnchors`의 기존 동작으로 확인).

| ID | 조건 |
| --- | --- |
| W1 | 저장·복원: 읽기 → 정규 쓰기 → 읽기가 같다. 1판 시험 템플릿을 1판 경로와 2판 경로(승계)로 생성하면 바이트가 같다. 같은 입력을 두 번 생성하면 바이트가 같고 CLI와 앱의 결과가 같다. 재시작 뒤에도 수동 선택과 `valueEdits`가 유지된다(앱) |
| W2 | 거부(정확한 코드, 아무것도 쓰지 않음): id 중복(종류 안·종류 사이), 끊긴 참조(`place.value`·`place.anchor`, `slot.anchors`, `block.slot`, 조건 경로, `binding.value`, 이번 건의 블록, 없는 덩어리 해시, 원형 핀 불일치), 순환(`slot.parent` → 블록 → 슬롯, 자기 부모), 지원하지 않는 번호(`template@3`·`@0`, schema 없음, `case@2`, `block-proto@2`, lite `version` 2), 모르는 키, 쓰임에 맞지 않는 앵커 종류, 한 키를 두 값에, 연결 없는 값, `TPL_MIXED_RULES`, `TPL_NESTED` |
| W3 | 선택(이슈 #7): 금액 경계의 아래·같음·위, 동률, 조건 없는 블록 2개, 조건 값 누락, 데이터가 바뀐 뒤 수동 선택 유지, 블록 삭제·내용 변경 → `recheck`, 고르지 않은 블록의 글·누름틀이 출력에 없다 |
| W4 | 원형(#21): 템플릿 2개가 같은 원형을 참조 → 원형 수정 → 영향 2건, 한쪽만 전파, `blockEdits`가 원형을 바꾸지 않는다, `forked` 표시, 새 키에 연결이 없는 템플릿으로의 전파가 막힌다 |
| W5 | 패턴(#20): 제안이 결정적이다, 해제한 항목은 다시 제안하지 않는다, 저장한 뒤 재현된다 |
| W6 | 이관: lite 시험 프로젝트의 모든 레코드가 8.8.14의 판정을 통과한다, 두 번 이관하면 같다, 거부 코드마다 원본 행 해시가 그대로이고 새 행이 0이다, 쓰는 도중 실패를 주입해도 일부만 남지 않는다, 동률 자료는 `MIG_POLICY`로 나온다 |
| W7 | 원본 변경: 같은 원본이면 exact, 앞에 문단을 삽입하면 relocated, 대상 글을 복제하면 ambiguous이고 생성이 막힌다, 범위 끝 문단을 삭제하면 notFound, 앞에 표를 삽입하면 지문 있는 셀은 다시 찾고 지문 없는 셀은 unverified다 |
| W8 | 생성 규칙(8.8.12): 이동표 변환 뒤 word·line·cell 자리가 맞는 곳에 채워진다, 교체 범위 안의 자리는 `PLACE_COVERED`, 등록되지 않은 `{{ }}`는 `unregistered` 정책대로, 건너뜀 1건이면 `FILL_SKIPPED`이고 출력이 없다, 원본 해시가 다르면 `TPL_SOURCE_MISMATCH`, 후처리 2종은 기본 끔 |

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

### 9.1 S4 구현에서 확정한 것 (2026-10-01)

구현 상태: T1~T6 통과(테스트 84개). 같은 `rules`와 같은 데이터 묶음을 HWPX와 Markdown 양쪽에 적용해 같은 값이 들어가는 것을 확인했다(누락 정책 3종의 결과와 실패 코드, 채움 내역, 지워진 줄의 처리까지 같다).

- md의 빈 줄 덩어리는 블록이 아니라 구분이다. 블록 서수는 비어 있지 않은 블록만 센다. txt는 빈 줄도 블록이다.
- 줄·단어 앵커의 지문은 블록의 논리 글(줄을 `
`으로 이은 것) 기준이다. 줄바꿈 방식이 달라도 같은 앵커를 쓴다.
- 규칙이 가리키는 `{{이름}}`은 그 규칙이 맡고 암묵 채움에서 빠진다.
- 표 값: `|`는 `\|`로, 그 앞의 백슬래시는 두 배로 쓴다. 줄바꿈은 거부한다.
- 표 행을 모두 지우면 머리행만 남는다(머리행 삭제는 거부).
- md 삽입은 이웃의 구분(빈 줄 방식)을 따른다. `insertText`의 `style`은 무시한다.
- 조각: `{ schema: "hwpx-studio/text-fragment@1", blocks: string[] }`.
- 결과: `{ ok, dryRun, output?, report }`. 원장은 없다.
- 추가한 코드: `FILL_TABLE_HEADER`, `VAL_TABLE_COLS`, `VAL_ENCODING`, `TEXT_ENCODING`, `TEXT_FENCE_UNCLOSED`(경고). 원래부터 열 수가 어긋난 표는 경고, 편집이 어긋나게 만든 표는 오류다.
- Markdown 지원 범위: 빈 줄 덩어리, 울타리 코드 블록, 파이프 표, 한 줄 `#` 제목. 목록·인용문·HTML 블록·들여쓴 코드·front matter는 구조를 해석하지 않고 문단으로 다룬다. 목록·인용문 안의 울타리와 인라인 코드는 보호하지 않는다. 값의 Markdown 특수문자는 이스케이프하지 않는다.
- 템플릿과 데이터 묶음은 `readTemplate`·`readDataset`으로 읽은 것을 넘긴다(읽기 함수가 기본 옵션을 채운다).
- 규모: 48,000블록 0.26초.

### 9.2 표 액션 (S5, 2026-10-01)

- `repeat`: Markdown 파이프 표에서 동작한다. 앵커는 `cell`(원형 행). 원소마다 원형 행 줄을 복제하고 `{{<as>.이름}}`, `{{<index>}}`, 전체 경로를 HWPX와 같은 규칙으로 채운다(같은 함수를 쓴다). 길이 0이면 원형 행을 지운다. 머리행은 `FILL_TABLE_HEADER`로 거절한다. 값의 `|`는 이스케이프하고 줄바꿈은 거부한다. 출력에서 반복 행을 다시 읽어 계획과 대조한다. txt에는 표가 없어 앵커 오류가 난다.
- `tableProps`, `resize`: 텍스트 형식에는 표 설정과 크기가 없다. 적용하지 않고 보고서의 `skipped`에 `TEXT_NOT_APPLICABLE`로 남긴다(오류가 아니다. 같은 템플릿을 HWPX와 md에 함께 쓸 수 있다). 조건이 거짓인 규칙은 남기지 않는다.
- `inject`의 `fitTable`은 무시한다.
- 같은 템플릿·데이터를 HWPX와 md에 적용하면 반복 행의 셀 글이 같다(테스트).
