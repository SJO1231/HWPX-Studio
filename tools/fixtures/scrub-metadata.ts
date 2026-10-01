// 시험 문서의 패키지 메타데이터에서 작성자·최종 저장자 값을 "synthetic"으로 바꾼다.
// 사용: node tools/fixtures/scrub-metadata.ts <입력.hwpx> <출력.hwpx>
// 한컴은 저장할 때 Contents/content.hpf 에 Windows 사용자 이름을 적는다. 시험 자료를 저장소에 넣기 전에 지운다.
import { readFileSync, writeFileSync } from "node:fs";
import { readArchive, readEntry, rewriteArchive } from "../../packages/hwpx-engine/src/index.ts";

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("usage: node tools/fixtures/scrub-metadata.ts <input.hwpx> <output.hwpx>");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(input));
const archive = readArchive(bytes);
const entryName = "Contents/content.hpf";
const before = new TextDecoder("utf-8", { fatal: true }).decode(readEntry(archive, bytes, entryName));
let changed = 0;
const after = before.replace(
  /(<opf:meta\s+name="(?:creator|lastsaveby)"[^>]*>)([^<]*)(<\/opf:meta>)/g,
  (_all, open: string, _value: string, close: string) => {
    changed += 1;
    return `${open}synthetic${close}`;
  },
);
const result =
  after === before
    ? bytes
    : rewriteArchive(bytes, archive, { replace: new Map([[entryName, new TextEncoder().encode(after)]]), add: [] });
writeFileSync(output, result);
console.log(JSON.stringify({ input: input.split(/[\/]/).pop(), metaReplaced: changed, bytesBefore: bytes.length, bytesAfter: result.length }));
