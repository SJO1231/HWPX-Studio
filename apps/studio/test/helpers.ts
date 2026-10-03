// 시험 도우미: 저장소 시험 문서(읽기만)와 합성 문서. 시험이 만드는 파일은 모두 OS 임시 폴더 안에 두고 끝나면 지운다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFields, fieldFillBlock, openPackage, parseDocument, readEntry, rewriteArchive } from "../../../packages/hwpx-engine/src/index.ts";
import { FIELD_BEGIN, FIELD_END, P, R, T, fixtureNames, readFixture, synth } from "../../../packages/viewer/test/helpers.ts";

export { fixtureNames, readFixture };

/** 문서의 첫 구역 XML 글을 `change`로 바꾼 사본의 바이트(메모리에서만 만든다). 바꾼 것이 없으면 시험이 틀린 것이므로 던진다. */
export function mutateSection(bytes: Uint8Array, change: (xml: string) => string): Uint8Array {
  const pkg = openPackage(bytes);
  const entry = pkg.sectionEntries[0] ?? "";
  const xml = new TextDecoder().decode(readEntry(pkg.archive, bytes, entry));
  const changed = change(xml);
  if (changed === xml) throw new Error("변형이 구역 XML을 바꾸지 못했다");
  return rewriteArchive(bytes, pkg.archive, { replace: new Map([[entry, new TextEncoder().encode(changed)]]) });
}

/** 누름틀 둘(`성명`, 이름에 공백이 든 `이 름`)과 `{{}}` 둘이 든 합성 문서 */
export function mixedDoc(): Uint8Array {
  return synth([
    P(R(T("성명: ") + FIELD_BEGIN("11", "성명", "1", "이름을 입력") + T("홍길동") + FIELD_END("11"))),
    P(R(T("사업명 {{project.name}} 기간 {{project.start}}"))),
    P(R(T("별칭: ") + FIELD_BEGIN("12", "이 름", "1", "입력") + T("YY") + FIELD_END("12"))),
  ]);
}

/** OS 임시 폴더 안에 이번 시험 전용 폴더를 만든다(`dir`). `remove()`가 지운다. */
export function sandbox(): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "studio-test-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

// ── 여러 문단 누름틀 합성 조각(문서는 `synth`로 만든다) ────────────
// 모양(crossParagraph)만 보면 채울 수 있는 것 같지만 엔진의 fieldFillBlock이 막는 곳과 막지 않는 곳. 막는 일은 데이터와 무관하게 문서만으로 정해진다.

const SEC_PR = '<hp:secPr id="" textDirection="HORIZONTAL"/>';
/** 여러 문단 누름틀: 사이 문단에 구역 설정(secPr)이 있어 엔진이 건너뛴다 */
export const secBetween = (id: string, name: string): string => P(R(FIELD_BEGIN(id, name, "1", "x") + T("앞"))) + P(R(SEC_PR + T("사이"))) + P(R(T("뒤") + FIELD_END(id)));
/** 여러 문단 누름틀 둘이 엇갈린다(바깥 `name`의 구간 안에서 시작한 `other`가 구간 밖에서 끝난다): 둘 다 엔진이 건너뛴다 */
export const crossed = (id: string, name: string, otherId: string, other: string): string =>
  P(R(FIELD_BEGIN(id, name, "1", "x") + T("앞"))) + P(R(FIELD_BEGIN(otherId, other, "1", "x") + T("사이"))) + P(R(T("뒤") + FIELD_END(id))) + P(R(T("끝") + FIELD_END(otherId)));
/** 여러 문단 누름틀: 엔진이 채운다(문단이 합쳐진다) */
export const openCross = (id: string, name: string): string => P(R(FIELD_BEGIN(id, name, "1", "x") + T("앞"))) + P(R(T("뒤") + FIELD_END(id)));

/** 문서의 누름틀마다 엔진의 fieldFillBlock이 준 문구(채울 수 있으면 undefined), 문서 순서 */
export const blockMessages = (bytes: Uint8Array): (string | undefined)[] => collectFields(parseDocument(openPackage(bytes))).map((t) => fieldFillBlock(t)?.message);
