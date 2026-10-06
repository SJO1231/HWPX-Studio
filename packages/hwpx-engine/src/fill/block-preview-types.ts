// 블록 단독 미리보기(8.8.18)의 결과 형. 문서 모델을 가져오지 않아 뷰어 호스트의 공용 형(`packages/viewer/src/host/types.ts`)이 브라우저 코드와 함께 참조한다.

/** 입력 항목의 종류(8.8.5의 자리 종류 이름): `{{ 키 }}`, 누름틀(`CLICK_HERE`, 이름), 메일머지(키) */
export type PreviewFieldKind = "placeholder" | "clickHere" | "mailMerge";

/** 같은 종류·같은 이름(NFC) 입력 항목의 수. 블록 안에서 처음 나온 순서 */
export type BlockPreviewField = { name: string; kind: PreviewFieldKind; count: number };

/**
 * 미리보기 문서 안 입력 항목 자리 하나. `path`는 엔진 주소(구역 안 문단 경로), `start`·`end`는 그 문단 논리 텍스트의 UTF-16 오프셋이다.
 * `{{ 키 }}`는 여는 `{{`부터 닫는 `}}` 끝까지, 누름틀·메일머지는 시작·끝 표식 사이(값 글)다. 끝 표식이 다른 문단에 있으면 `endPath`가 그 문단이고 `end`는 그 문단의 오프셋이다.
 * 끝 표식을 찾을 수 없는 필드(짝 없음·다른 칸)는 `end` = `start`다.
 */
export type BlockPreviewPlace = { kind: PreviewFieldKind; name: string; sectionIndex: number; path: number[]; start: number; end: number; endPath?: number[] };
