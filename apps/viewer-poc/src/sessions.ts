import { randomUUID } from "node:crypto";
import { openPackage, parseDocument, type HwpxDocument } from "../../../packages/hwpx-engine/src/index.ts";

/** 메모리 세션. 문서 바이트는 호스트(이 서버)가 갖고, 디스크에는 쓰지 않는다. */
export type Session = {
  id: string;
  /** 화면에 보이는 이름(저장소 시험 문서 이름 또는 "올린 파일") */
  label: string;
  /** 처음 연 바이트(되돌리기용) */
  original: Uint8Array;
  /** 지금 바이트(채우기 결과가 쌓인다) */
  bytes: Uint8Array;
  doc: HwpxDocument;
  /** 바이트가 바뀔 때마다 1씩 는다(브라우저가 다시 받을 때 확인) */
  generation: number;
};

export type SessionStore = {
  open(label: string, bytes: Uint8Array): Session;
  get(id: string): Session | undefined;
  /** 새 바이트로 바꾸고 세대를 올린다. 바이트는 이미 저장 게이트를 통과한 결과여야 한다. */
  replace(session: Session, bytes: Uint8Array): void;
  reset(session: Session): void;
  close(id: string): boolean;
  size(): number;
};

/** 열려 있는 세션들이 가진 문서 바이트의 총합 한도(기본값) */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;

/** 세션이 메모리에 쥔 문서 바이트(처음 바이트와, 채운 뒤 달라진 지금 바이트) */
const bytesOf = (s: Session): number => s.original.length + (s.bytes === s.original ? 0 : s.bytes.length);

/**
 * 열려 있는 세션이 `limit`개를 넘거나 바이트 총합이 `maxBytes`를 넘으면 가장 오래된 것부터 닫는다(방금 열거나 바꾼 세션은 남긴다).
 * 문서가 열리지 않으면 `HwpxError`가 올라온다.
 */
export function createSessionStore(limit = 16, maxBytes = MAX_SESSION_BYTES): SessionStore {
  const sessions = new Map<string, Session>();
  const trim = (keep: Session): void => {
    let total = 0;
    for (const s of sessions.values()) total += bytesOf(s);
    for (const [id, s] of sessions) {
      if (sessions.size <= limit && total <= maxBytes) break;
      if (s === keep) continue;
      sessions.delete(id);
      total -= bytesOf(s);
    }
  };
  return {
    open(label, bytes) {
      const doc = parseDocument(openPackage(bytes));
      const session: Session = { id: randomUUID(), label, original: bytes, bytes, doc, generation: 0 };
      sessions.set(session.id, session);
      trim(session);
      return session;
    },
    get: (id) => sessions.get(id),
    replace(session, bytes) {
      session.doc = parseDocument(openPackage(bytes));
      session.bytes = bytes;
      session.generation++;
      trim(session);
    },
    reset(session) {
      session.doc = parseDocument(openPackage(session.original));
      session.bytes = session.original;
      session.generation++;
    },
    close: (id) => sessions.delete(id),
    size: () => sessions.size,
  };
}
