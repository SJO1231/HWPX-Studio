// 블록 단독 미리보기 요청(#75): 저장한 블록(원형 + 조각 덩어리)으로 엔진이 만든 미리보기 HWPX 바이트와 입력 항목 자리의 강조 구간을 돌려준다.
// 블록 저장소는 부르는 쪽 앱이 갖는다(`loadBlock`). 엔진의 저장 게이트를 통과한 바이트만 돌려준다.
import { createHash } from "node:crypto";
import { buildBlockPreviewDocument, HwpxError, openPackage, parseDocument, readBlockProto, type BlockProto, type BlockPreviewPlace, type HwpxDocument } from "../../../hwpx-engine/src/index.ts";
import { paragraphAtAddress } from "../map/index.ts";
import { HostError } from "./errors.ts";
import { markSpan } from "./marks.ts";
import { isObj } from "./request.ts";
import type { BlockPreviewResponse, MarkRange } from "./types.ts";

/** 조각 덩어리(`fragment@1` JSON의 UTF-8 바이트)의 상한. 넘으면 읽지 않고 `BLOCK_TOO_LARGE`(413)다 */
export const PREVIEW_MAX_BLOB = 32 * 1024 * 1024;

/** 저장소에서 꺼낸 블록 하나: 원형(`block-proto@1`, 읽기 검사를 거친 것)과 그 판의 조각 덩어리 */
export type StoredBlock = { proto: BlockProto; blob: Uint8Array };

/**
 * base64(표준 글자, 길이 4의 배수, 끝의 `=` 패딩 2개까지)인가. 글자 집합 밖의 글자를 한 번 훑어 찾는다
 * (4글자 묶음을 되풀이하는 정규식은 풀린 크기가 약 3.2 MiB를 넘는 글에서 스택을 넘는다).
 */
function isBase64(text: string): boolean {
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return text.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(text.slice(0, text.length - pad));
}

const tooLarge = (): HostError => new HostError(413, "BLOCK_TOO_LARGE", `블록 조각 덩어리가 미리보기 상한(${PREVIEW_MAX_BLOB / 1024 / 1024} MiB)을 넘습니다.`);

/** 요청 본문에서 블록을 꺼낸다: `{ block: id }`는 저장소에서, `{ proto, blob }`은 본문의 원형(JSON 객체)과 덩어리(base64)에서 */
function blockOf(body: unknown, loadBlock: (id: string) => StoredBlock | undefined): StoredBlock {
  if (!isObj(body)) throw new HostError(400, "BAD_REQUEST", "본문은 { block } 또는 { proto, blob }이어야 합니다.");
  const { block, proto, blob } = body;
  if (block !== undefined) {
    if (proto !== undefined || blob !== undefined) throw new HostError(400, "BAD_REQUEST", "block과 proto·blob을 함께 보내지 않습니다.");
    if (typeof block !== "string" || block === "" || block.length > 200) throw new HostError(400, "BAD_REQUEST", "block은 저장한 블록의 id(비어 있지 않은 문자열)여야 합니다.");
    const found = loadBlock(block);
    if (found === undefined) throw new HostError(404, "BLOCK_NOT_FOUND", "저장한 블록을 찾지 못했습니다.");
    if (found.blob.length > PREVIEW_MAX_BLOB) throw tooLarge();
    return found;
  }
  if (!isObj(proto) || typeof blob !== "string") throw new HostError(400, "BAD_REQUEST", "본문은 { block } 또는 { proto, blob }이어야 합니다.");
  // 글자 길이만으로 상한을 넘는 것(base64 4글자 = 3바이트)은 풀지 않는다. 경계는 푼 뒤 실제 바이트 수로 본다(끝 패딩만큼 짧다)
  if (blob.length > Math.ceil(PREVIEW_MAX_BLOB / 3) * 4) throw tooLarge();
  if (!isBase64(blob)) throw new HostError(400, "BAD_BLOB", "blob은 조각 덩어리의 base64여야 합니다.");
  const bytes = new Uint8Array(Buffer.from(blob, "base64"));
  if (bytes.length > PREVIEW_MAX_BLOB) throw tooLarge();
  let read: BlockProto;
  try {
    read = readBlockProto(JSON.stringify(proto));
  } catch (e) {
    if (e instanceof HwpxError) throw new HostError(400, e.code, e.message);
    throw e;
  }
  return { proto: read, blob: bytes };
}

type Span = { path: number[]; from: number; until: number };

/** 문단 안 구간을 줄바꿈(`\n`)에서 나눈다(rhwp는 줄바꿈을 글자로 그리지 않아 덮을 글이 어긋난다). 나눈 조각이 모두 비면 그대로 둔다 */
function splitAtBreaks(doc: HwpxDocument, sectionIndex: number, s: Span): Span[] {
  const text = paragraphAtAddress(doc, { sectionIndex, path: s.path })?.logicalText ?? "";
  const pieces: Span[] = [];
  let from = s.from;
  for (let i = s.from; i <= s.until; i++) {
    if (i < s.until && text[i] !== "\n") continue;
    if (i > from) pieces.push({ path: s.path, from, until: i });
    from = i + 1;
  }
  return pieces.length === 0 ? [s] : pieces;
}

/**
 * 자리 하나의 강조 구간: 한 문단이면 그 구간, 끝 표식이 다른 문단(같은 목록)이면 시작 문단의 뒷부분·사이 문단 전체·끝 문단의 앞부분이다.
 * 값 글에 줄바꿈이 있으면 줄바꿈마다 나눈다. 옮길 수 없는 구간은 뺀다.
 */
function marksOf(doc: HwpxDocument, place: BlockPreviewPlace): MarkRange[] {
  const field = place.kind !== "placeholder";
  const spans: Span[] = [];
  if (place.endPath === undefined) spans.push({ path: place.path, from: place.start, until: place.end });
  else {
    const parent = place.path.slice(0, -1);
    const first = place.path[place.path.length - 1] ?? 0;
    const last = place.endPath[place.endPath.length - 1] ?? 0;
    for (let i = first; i <= last; i++) {
      const path = [...parent, i];
      const length = paragraphAtAddress(doc, { sectionIndex: place.sectionIndex, path })?.logicalText.length ?? 0;
      spans.push({ path, from: i === first ? place.start : 0, until: i === last ? place.end : length });
    }
  }
  const out: MarkRange[] = [];
  for (const s of spans.flatMap((x) => splitAtBreaks(doc, place.sectionIndex, x))) {
    const mark = markSpan(doc, { sectionIndex: place.sectionIndex, path: s.path, from: s.from, until: s.until, guideOf: field }, true);
    if (mark !== undefined) out.push(mark);
  }
  return out;
}

/**
 * 블록 미리보기 요청(`BlockPreviewRequest`)을 푼다. 저장소 블록 id(`loadBlock`이 찾는다) 또는 원형과 덩어리를 받아 엔진의 `buildBlockPreviewDocument`로
 * 미리보기 바이트를 만들고(저장 게이트 통과분만), 입력 항목 자리마다 쪽 위 강조 구간(`marks`)을 붙인다. 본문이 틀리면 400, 없는 블록 404, 상한 초과 413,
 * 원형 읽기 거절은 400(엔진 코드 그대로), 미리보기를 만들 수 없으면(덩어리 해시 불일치·조각 아님·게이트 새 오류) 422(엔진 코드 그대로)의 `HostError`다.
 */
export function previewBlock(body: unknown, loadBlock: (id: string) => StoredBlock | undefined): BlockPreviewResponse {
  const { proto, blob } = blockOf(body, loadBlock);
  let preview;
  try {
    preview = buildBlockPreviewDocument(proto, blob);
  } catch (e) {
    if (e instanceof HwpxError) throw new HostError(422, e.code, e.message);
    throw e;
  }
  const doc = parseDocument(openPackage(preview.bytes));
  return {
    hwpx: Buffer.from(preview.bytes).toString("base64"),
    sha256: createHash("sha256").update(preview.bytes).digest("hex"),
    fields: preview.fields,
    places: preview.places.map((p) => ({ ...p, marks: marksOf(doc, p) })),
    warnings: preview.issues.filter((i) => i.severity === "warning").map((i) => ({ code: i.code, message: i.message })),
  };
}
