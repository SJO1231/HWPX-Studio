// 시험 도우미: 저장소 시험 문서(읽기만)와 합성 문서. 시험이 만드는 파일은 모두 OS 임시 폴더 안에 두고 끝나면 지운다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPackage, readEntry, rewriteArchive } from "../../../packages/hwpx-engine/src/index.ts";
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
