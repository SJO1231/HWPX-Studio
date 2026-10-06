# 한컴 COM 으로 만든 합성 시험 문서

엔진 시험에 쓰는 HWPX 를 한컴 오피스(한글)가 직접 저장하게 해서 만든다. 문서 내용은 전부 지어낸 합성 자료다.
한컴이 글을 여러 run·`hp:t` 로 쪼개는 모양, 안내문 상태 누름틀, 그림이 든 문서의 실제 XML 을 얻으려는 것이 목적이다.

## 만드는 방법

```
python tools/com/make_fixtures.py
```

- 한컴 오피스와 Python 3.12 + pywin32(`HWPFrame.HwpObject` 등록)가 있는 Windows 에서만 돈다.
- 다시 실행하면 같은 문서를 다시 만든다. 한컴이 문서 ID·저장 시각을 새로 적으므로 sha256 은 매번 달라진다.
- 문서마다 작업자 프로세스를 따로 띄우고 60초 안에 끝나지 않으면 그 작업자와 그것이 띄운 `Hwp.exe` 를 종료한 뒤 그 문서를 실패로 기록한다(실패한 문서는 `out/` 에 남기지 않는다).
- 한컴 창은 숨기고, 작업자는 항상 `Quit()` 으로 끝낸다. 시작 전에 이미 떠 있던 `Hwp.exe` 의 PID 는 건드리지 않는다. 새 `Hwp.exe` 가 뜨지 않으면(기존 창에 붙었다면) `Quit()` 없이 멈춘다.
- 사용자 문서 폴더는 열지 않는다. 쓰는 곳은 `tools/com/out/` 와 그림용 임시 폴더(끝나면 지움)뿐이다.
- 각 문서를 저장한 뒤 다시 열어 `PageCount` 를 읽는다. 다시 연 결과가 `manifest.json` 의 `reopen` 이다.

## 산출물 (`out/`)

| 파일 | 내용 | 구역 XML 최상위 문단 |
|---|---|---|
| `ph-single.hwpx` | 서식 변화 없는 `{{...}}` 문단. `사업명: {{project.name}} 입니다.`, `기간: {{project.start}} ~ {{project.end}}` | 3 |
| `ph-mixed.hwpx` | 서식이 바뀌는 `{{project.name}}`, 두 번 나눠 넣은 `{{company.name}}`, 탭이 낀 `{{manager.name}}`·`{{manager.phone}}` | 3 |
| `ph-table.hwpx` | 제목 `신청서` + 3행 2열 표(`{{applicant.name}}`, 빈 칸, `{{note}}`) + `위와 같이 신청합니다.` | 3 (표 문단 포함) |
| `field-states.hwpx` | 누름틀 3개: 안내문 상태 `성명`, 값을 넣은 `소속`(`합성기관`), 안내문 상태 `성명`(같은 이름) | 3 |
| `picture.hwpx` | `그림 앞 문단` / 64x64 PNG 한 장 / `그림 뒤 문단` | 3 |
| `blocks.hwpx` | `1. 개요`… `2. 선택 조항`… 3행 3열 표 … `3. 끝` (조건 삭제·삽입 시험용) | 6 (표 문단 포함) |
| `header-footer.hwpx` | 머리말 `{{doc.title}}`, 본문 2문단, 꼬리말 `{{doc.owner}}` | 2 |
| `tables-merged.hwpx` | `병합 표` + 4행 3열 표(가로 병합 A1·B1, 세로 병합 C2·C3) + `끝` | 3 (표 문단 포함) |
| `tables-inline.hwpx` | `앞 문단` + 글자처럼 취급(`treatAsChar="1"`) 2행 3열 표 + `뒤 문단` | 3 |
| `tables-nested.hwpx` | `중첩 표` + 2행 2열 표(둘째 칸 안에 2행 2열 표) + `끝` | 3 |
| `tables-rich.hwpx` | `풍부한 표` + 3행 3열 표(셀 안에 누름틀 `이름`과 그림) + `끝` | 3 |
| `inline-breaks.hwpx` | 줄바꿈(Shift+Enter)·탭: 본문 문단 3개, 줄바꿈이 든 누름틀 `줄`, 탭이 든 누름틀 `탭`, 1행 2열 표(첫 칸에 줄바꿈), `끝` | 7 (표 문단 포함) |
| `manifest.json` | 아래 항목 | |

`manifest.json` 의 문서별 항목: 파일명, 바이트 크기, sha256, `reopen`(열림 여부·쪽 수), ZIP 항목 목록, `BinData` 항목, 구역 XML 수치(`paragraphs`=`<hp:p` 전체 개수, 최상위 문단, run, `hp:t`, `fieldBegin`/`fieldEnd`, 표, 그림, 탭, 머리말, 꼬리말), 의도한 글이 구역 XML 에 있는지(`text_checks`: 원문 그대로 / 문단 안 `hp:t` 를 이어 붙였을 때), 최상위 문단별 run 목록, 문서별 `observations`.
의도한 글과 공백까지 같은지 비교해서 다르면 그 문서를 실패로 기록한다(`exact_text_mismatches`).

일부만 다시 만들려면 `python tools/com/make_fixtures.py --only tables-merged,tables-inline` 처럼 이름을 준다. 다른 산출물과 `manifest.json`의 다른 항목은 그대로 두고 그 문서의 항목만 바꾼다.
표 문서 네 개는 한컴이 "표 만들기"의 마지막 설정(글자처럼 취급)을 기억하므로 `TableProperties.TreatAsChar`를 항상 명시해서 만든다.
표 문서 네 개를 시험에 쓰려면 `node tools/fixtures/scrub-metadata.ts`로 메타데이터를 정리한 뒤 `packages/hwpx-engine/test/fixtures/tables/`에 복사하고 그 폴더의 `SHA256SUMS`를 갱신한다.

## 누름틀 값과 PDF 글 위치 읽기 (`read_text.py`)

```
python tools/com/read_text.py --spec 명세.json --out 결과.json [--timeout 60]
```

명세는 `{ "documents": [ { "name": "라벨", "file": "문서.hwpx", "fields": ["누름틀 이름"](선택), "resave": "다시 저장할.hwpx"(선택), "pdf": "저장할.pdf"(선택), "markers": ["PDF에서 위치를 찾을 글"](선택) } ] }`다. 문서마다 작업자를 따로 띄우고 60초가 지나면 그 작업자와 그것이 띄운 `Hwp.exe`만 종료한다(`read_table.py`와 같은 구조). 한 번에 하나만 실행한다.
결과는 문서마다 열림·쪽 수, `field_text`(`GetFieldText`가 준 문자열 그대로), `resaved`(한컴이 다른 이름으로 다시 저장했는가), `pdf.markers`(각 글의 쪽과 사각형 `x0 y0 x1 y1`, PDF 포인트, 위쪽이 0. PyMuPDF가 있어야 한다)다. 엔진 시험 `inline-com.test.ts`가 쓴다(`HWPX_COM=1`).

## 줄바꿈·탭 관측 (`inline-breaks`, 한컴 13.0.0.711)

- **줄바꿈**: Shift+Enter(COM `HAction.Run("BreakLine")`)는 `hp:t`의 자식 `<hp:lineBreak/>`(속성 없음)로 저장된다. run·문단은 나뉘지 않는다. 문단 맨 앞·맨 뒤·연속한 줄바꿈도 같은 `hp:t` 안에 놓인다. 누름틀 안에서는 `fieldBegin` 컨트롤과 `fieldEnd` 컨트롤 사이의 `hp:t` 하나 안에, 표 칸 안에서는 칸 문단의 `hp:t` 안에 있다.
- **탭**: `<hp:tab width="N" leader="0" type="1"/>`, `hp:t`의 자식이다. `width`는 조판이 정한 값이다(`inline-breaks`는 3028·3028·3292, 탐색 때 1092~3456). `ph-mixed`의 탭은 `width="0" leader="0" type="0"`인데, 삽입을 나눠 넣은 문단에서 조판 전에 저장된 모양으로 **추정**한다(`inline-breaks`의 같은 방식 탭은 `type="1"`).
- **`width`·`type`은 읽을 때 쓰이지 않는다**: 엔진이 만든 문서의 탭을 `width="0" type="1"`, `width="0" type="0"`, `width="4000" type="1"`로 바꿔 한컴으로 열면 셋 다 같은 위치(다음 탭 위치)로 그려지고, 한컴이 다시 저장하면 `leader="0" type="1"`과 조판이 정한 `width`로 바뀐다. rhwp는 `type="1"`이면 한컴 PDF와 같은 위치(오차 0.1px)에 그리고 `type="0"`이나 `width="4000"`이면 어긋난다. 그래서 엔진은 `width="0" leader="0" type="1"`로 쓴다.
- **COM으로 줄바꿈을 넣는 법**: `InsertText`의 `"\n"`은 한컴이 지워 버리고(글자도 줄바꿈도 남지 않는다) `"\r\n"`·`"\r"`은 문단을 나눈다. `PutFieldText`도 같다(`"\n"`은 지워지고 `"\r\n"`·`"\r"`은 값이 두 문단에 걸친다). 줄바꿈 요소는 `BreakLine`으로만 만들어진다.
- **한컴이 값을 읽는 모양**: `GetFieldText`는 줄바꿈 요소를 글자로 주지 않는다(`첫 줄둘째 줄`). 탭은 `\t`로 준다. 한컴이 직접 만든 줄바꿈·탭 누름틀도 같다. `SaveAs(..., "TEXT")`도 줄바꿈 요소를 글자로 쓰지 않았다. 그래서 줄바꿈이 보존되는지는 읽기 API가 아니라 다시 저장한 HWPX의 요소와 PDF의 줄 위치로 확인한다.

## 문단모양 대조 (`read_para_props.py`, #69)

```
python tools/com/read_para_props.py --spec 명세.json --out 결과.json [--timeout 60]
```

조각 이식본의 문단 속성을 한컴이 원본과 같게 읽는지 보는 오라클이다. 문서마다 탐침(`id`)을 주면 그 문단의 `ParaShape`(`read_shape.py`의 `PARA_ITEMS` 16개: 들여쓰기·여백·문단 간격·줄 간격 등)를 읽고, 같은 `id`끼리 기준 문서(`baseline`, 없으면 첫 문서)와 값이 다른 항목을 `compare`에 낸다. 작업자·60초 한도·창 숨김·`Quit`·떠 있던 `Hwp.exe` 불간섭은 `read_shape.py`와 같고(도우미를 가져다 쓴다), 한 번에 하나만 실행한다.

- 탐침: `{ "id", "list": 0, "para": N, "textSha"(선택) }`는 본문 N번째 문단(`textSha`를 주면 글 해시도 확인, 다르면 `TEXT_MISMATCH`). `{ "id", "textSha", "para": k }`는 리스트 1번부터 끝까지 훑어 k번째 문단 글의 해시가 같은 리스트(표 칸 등)를 찾는다(없으면 `LIST_NOT_FOUND`, 둘 이상이면 `AMBIGUOUS`).
- 글 해시는 한컴이 블록 저장(TEXT)으로 준 문단 글의 UTF-8 SHA-256 앞 10자다. 명세·결과에 글·경로를 넣지 않는다(결과는 `textLen`·`textSha`만).
- 한컴의 글은 엔진의 논리 텍스트와 다를 수 있다(관측: U+2007 공백 하나가 빠짐). 그런 문단은 한컴 쪽 해시를 쓰거나 `list`+`para`로 준다.
- 관측(한컴 13.0.0.711): `ParaShape`의 여백·간격 값은 `version.xml`의 `xmlVersion`이 1.5면 XML 값의 2배, 1.2면 XML 값 그대로다(스위치가 없는 `hh:margin`도 같다). `hp:switch`는 형식 버전·선언과 무관하게 `hp:case`(HwpUnitChar) 쪽을 읽는다. 근거는 `docs/validation.md` 26절.

## 표 속성 읽기 (`read_table.py`)

```
python tools/com/read_table.py --spec 명세.json --out 결과.json [--timeout 60]
```

명세는 `{ "documents": [ { "name": "라벨", "file": "문서.hwpx", "pdf": "저장할.pdf"(선택), "markers": ["PDF 안에 있어야 하는 글"](선택) } ] }`다. 문서마다 작업자를 따로 띄우고 60초가 지나면 그 작업자와 그것이 띄운 `Hwp.exe`만 종료한다(`read_shape.py`와 같은 구조). 한 번에 하나만 실행한다.
결과는 문서마다 표 목록(표 컨트롤별)과 `props`(`Width`, `Height`, `TreatAsChar`, `PageBreak`, `RepeatHeader`, `CellSpacing`, `HorzAlign`, 바깥 여백 4개, `CellMarginLeft`), 셀 리스트 순서의 `cells`(상태 표시줄 주소 `(B3)`에서 읽은 `label`, `col`, `row`)이다. `pdf`를 주면 PDF로 저장하고 PyMuPDF가 있으면 쪽 수·글자 수·`markers` 존재 여부를 낸다.

한컴 13에서 엔진이 만든 변형을 열어 관측한 코드: `PageBreak`는 CELL 2·TABLE 1·NONE 0, `HorzAlign`은 LEFT 0·CENTER 1·RIGHT 2, `TreatAsChar`·`RepeatHeader`는 0/1. `hwp.CellShape`는 셀 단위 값이 아니라 표 속성을 돌려주므로 셀의 세로 정렬·여백은 읽지 못한다. 행·열 수는 읽는 항목이 없어, 셀 리스트의 주소 목록(병합 셀은 왼쪽 위 주소 하나)으로 구조를 대조한다.
한컴이 셀이 하나도 시작하지 않는 행(`<hp:tr>`에 `tc`가 없음)이 든 표를 열지 못한다는 것도 이 도구로 확인했다(`OPEN_FALSE`). 한컴 화면은 행 전체를 합치면 그 행을 지운다.
PDF의 글을 읽을 때 주의: 한컴은 잘려 보이지 않는 글도 PDF에 쓰는 경우가 있어(줄 간격이 0인 서식을 쓴 합성 문서) 글자 수만으로 "보임"을 판정하지 않는다. 끝 글 표지(marker)가 있는지와 쪽 수를 함께 본다.

## 관측 (한컴 13.0.0.711 에서 저장한 모양)

- **쪼개짐**: 서식이 같으면 삽입 호출을 나눠도 한 `hp:t` 로 합쳐진다(`{{company.name}}`). 서식이 바뀌면 run 이 나뉜다. `ph-mixed` 의 `{{project.name}}` 은 `<hp:t>사업명: {{project.</hp:t>`(charPr 0) 와 `<hp:t>name}}</hp:t>`(굵게, charPr 7) 두 run 이다. 탭은 `hp:t` 안의 `<hp:tab/>` 요소라서 `담당: {{manager.name}}<hp:tab/>{{manager.phone}}` 이 한 `hp:t` 안에 있다.
- **빈 run 과 빈 `hp:t`**: 첫 문단 첫 run 에는 `secPr`·`colPr` 이 들어 있고 글이 없다. 표·그림·필드 끝에는 `<hp:t/>` 가 붙는다. 빈 표 칸은 `<hp:run charPrIDRef="0"/>` 하나로 `hp:t` 가 없다.
- **누름틀**: `fieldBegin type="CLICK_HERE"`. 안내문 상태는 `dirty="0"` 이고, **`fieldBegin` 과 `fieldEnd` 사이에 안내문이 그대로 `hp:t` 로 들어 있다**(`이름을 입력`, 빨강 기울임 charPr). 값을 `PutFieldText` 로 넣으면 `dirty="1"` 이고 사이 `hp:t` 는 값(`합성기관`, 본문과 같은 charPr)이다. 안내문은 `hp:parameters` 의 `Direction` 과 `Command` 문자열에도 들어 있다. 같은 이름 `성명` 두 개는 `id` 만 다른 별개의 `fieldBegin` 이다. 한컴으로 다시 열어 `GetFieldText("성명")` 은 `""`(안내문 상태), `GetFieldText("소속")` 은 `합성기관`.
- **그림**: `BinData/image1.png`. `Contents/content.hpf` 의 `<opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1" hashkey="..."/>` 로 등록되고, 구역 XML 에서는 `hp:pic` 안 `<hc:img binaryItemIDRef="image1"/>` 가 가리킨다. `hp:pic` 은 `treatAsChar="1"`, `shapeComment` 에 원본 파일 이름이 들어간다(`synthetic-64x64.png`).
- **머리말·꼬리말**: `hp:header`·`hp:footer` 는 첫 문단 첫 글 run 안의 `hp:ctrl` 로 있고, 안의 `hp:subList > hp:p` 에 글이 있다. 적용 쪽은 `applyPageType="BOTH"`.
- **표**: 표가 든 문단은 최상위 문단 하나이고, 표 칸 안 문단은 `hp:tbl > hp:tr > hp:tc > hp:subList > hp:p` 로 중첩된다(그래서 `paragraphs` 는 최상위 문단 수보다 크다).

## 만들면서 알게 된 한컴 COM 동작

- `CreateField` 뒤 캐럿이 누름틀 **안**에 남는다. 그대로 `BreakPara` 나 글 입력을 하면 필드가 문단에 걸쳐 갈라지거나 다음 글이 필드 안으로 들어간다. `MoveLineEnd` 로 줄 끝에 나가야 한다.
- 문단 끝이 ` 입니다` 인 채로 Enter(`BreakPara`)를 치면 한컴이 그 앞 공백을 지운다(`}} 입니다.` → `}}입니다.`). `ph-single` 은 둘째 문단을 Enter 없이 마지막에 채워 공백을 지키게 했다.
- `HeaderFooter` 동작은 머리말을 만들고 편집 상태로 들어가지만 `Type` 항목은 적용 쪽(0 양쪽, 1 짝수, 2 홀수)이고 꼬리말은 고르지 못했다. 꼬리말은 `InsertCtrl("foot")` 으로 만든 뒤 `SetPos` 와 `ParentCtrl` 로 꼬리말 안에 들어가 썼다. 그래서 머리말 문단은 한컴의 머리말 스타일(`paraPrIDRef="9"`, `styleIDRef="14"`)이고 꼬리말 문단은 본문 스타일(0, 0)이다.
- 표를 문서 끝 빈 문단에 만들면 한컴이 표 뒤에 빈 문단을 하나 둔다. `MoveDocEnd` 로 그 문단에 나가 이어 쓴다. 표는 `treatAsChar="0"`(글자처럼 취급 안 함)으로 저장된다.

## 한컴이 저장한 것에서 바꾼 것

한컴은 `Contents/content.hpf` 에 작성자·마지막 저장자로 이 PC 의 사용자 이름을 적는다. 그 두 값(`creator`, `lastsaveby`)만 `synthetic` 으로 바꿔 ZIP 을 다시 묶는다(항목 순서·압축 방식 유지, `mimetype` 은 첫 항목에 무압축). 구역·머리 XML 은 한컴이 저장한 그대로다. 바꾼 뒤 한컴으로 다시 열어 쪽 수를 읽는다. 문서 제목(`opf:title`)은 한컴이 첫 문단 글로 채운 값이다.
스크립트는 사용자 이름·임시 폴더·작업 폴더 경로가 산출물 어느 항목에도 남아 있지 않은지 검사해 `privacy_clean` 으로 기록한다.

## 메일 머지 필드 서식 (`make_merge_fixtures.py`, 한컴 13.0.0.711)

```
python tools/com/make_merge_fixtures.py
```

`merge-fields.hwpx`(+ `merge-report.json`)를 만든다. 사본은 `packages/hwpx-engine/test/fixtures/merge/`다. 규칙은 `make_fixtures.py`와 같다(문서 하나씩 작업자 프로세스, 60초 한도, 창 숨김, `Quit`, 떠 있던 `Hwp.exe` 불간섭). 다시 실행하면 한컴이 문서 ID를 새로 적어 sha256이 달라지므로 사본과 `SHA256SUMS`를 함께 갱신해야 한다.

- **내용**: 메일 머지 필드(`MAILMERGE`) 33개(머리말 2·꼬리말 3·본문 28, 같은 키가 여러 번, 경로 꼴이 아닌 키 4곳), 누름틀 4개, `{{경로}}` 글 8곳이 한 문서에 든다. 본문 문단과 두 표(6행 3열, 4행 2열)의 칸에 흩어져 있다. 문서의 구조와 필드 관측은 `merge-report.json`.
- **필드를 넣는 법**: 한컴의 메일 머지 필드 넣기에 해당하는 동작은 `MailMergeInsert`(파라미터 세트 `FieldCtrl`)다. `HParameterSet.HFieldCtrl.Command`에 키를 넣어 `Execute`하면 `fieldBegin type="MAILMERGE" name="" editable="0" dirty="0"`와 매개변수 `Fiexde`(sic)·`Prop=8`·`Command`·`FieldType=USER_DEFINE`·`FieldValue`(둘 다 키)가 저장되고, 표시 글은 `{{키}}`다. 실제 업무 서식의 구조와 같다(`fieldid`도 같은 값). `InsertFieldTemplate`(필드 입력)의 `TemplateType`은 0 누름틀·1 사용자 정보·2 문서 요약·3 날짜·4 경로만 있고 메일 머지는 없다.
- **한컴이 못 하는 것**: 메일 머지 필드는 한컴 필드 API에 보이지 않는다(`GetFieldList`는 빈 글, `FieldExist`는 거짓, `PutFieldText`는 아무 일도 안 한다). 필드 안의 글(표시 글)도 편집할 수 없다(`editable="0"`: 캐럿 이동·선택이 필드 전체를 한 글자처럼 다룬다). 그래서 표시 글이 `{{키}}`가 아닌 안내 글 꼴(예전 값)인 필드 8개는 한컴이 저장한 뒤 그 `hp:t`의 글만 XML로 바꿔 만들었다(`apply_guides`: 문서 순서로 1·5·9…번째. 엔진이 한 번 채운 문서의 꼴과 같다). 바꾼 문서는 한컴으로 다시 열어 쪽 수를 읽었다.
- **쓰지 않은 것**: 한컴의 메일 머지 만들기(`MailMergeGenerate`, 도구 - 메일 머지 - 만들기)는 쓰지 않는다. 제품은 XML 처리만 한다(사용자 결정 2026-10-04). 탐색에서 알게 된 것만 적는다: 자료 종류는 `Input`(1 한/글 파일, 3 DBF), 출력은 `Output=2`(파일)로 되고, DBF·한셀은 "주소록 레코드 선택" 창이 떠서 이 창에 Enter를 보내야 끝난다. 결과 문서에는 메일 머지 필드가 남지 않고 값이 글로 풀려 있다.
- **엔진 결과를 한컴으로 확인**: 엔진이 이 서식을 채운 문서와 `compile --merge-fields`로 바꾼 문서를 `read_text.py`로 한컴에서 열어 값·필드 수·PDF 글을 확인하는 시험이 있다(`HWPX_COM=1 node --test --test-concurrency=1 packages/hwpx-engine/test/fill-merge.test.ts packages/hwpx-engine/test/fill-merge-compile.test.ts`, 한 번에 하나씩). 한컴은 `dirty="1"`로 채운 메일 머지 필드를 그대로 열고 다시 저장해도 필드·키·`dirty`를 유지한다.

## 한계

- 한컴 13.0.0.711 한 가지 버전에서만 만들었다. 버전이 다르면 run 나뉨·`dirty` 등이 다를 수 있다.
- 문서 안 글자 서식은 굵게 하나뿐이다. 글꼴·크기 변화, 필드 안 서식 변화, 머리말·꼬리말 쪽별 적용 같은 모양은 만들지 않았다.
