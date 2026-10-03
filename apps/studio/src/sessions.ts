import { randomUUID } from "node:crypto";
import type { PlacesView, ResultView } from "./api-types.ts";
import type { QuickData } from "./quick.ts";

/** 마지막 생성의 결과. 바이트는 메모리에 있고, 저장에 성공했으면 폴더 경로도 있다. */
export type LastRun = { results: ResultView[]; files: (Uint8Array | undefined)[]; folder: string | undefined };

/** 메모리 세션: 올린 문서(바이트와 모델), 올린 데이터(건으로 나눈 것), 마지막 생성. 원본과 데이터는 디스크에 쓰지 않는다. */
export type QuickSession = {
  id: string;
  /** 올린 원본 이름. 결과 파일 이름의 앞부분이 된다 */
  fileName: string;
  bytes: Uint8Array;
  /** 문서에서 찾은 자리 목록 */
  places: PlacesView;
  data?: QuickData;
  /** 올린 데이터의 바이트 수(메모리 가늠용) */
  dataBytes: number;
  last?: LastRun;
};

export type SessionStore = {
  open(fileName: string, bytes: Uint8Array, places: PlacesView): QuickSession;
  get(id: string): QuickSession | undefined;
  /** 세션의 메모리가 바뀌었음을 알린다(총합이 한도를 넘으면 가장 오래된 세션부터 닫는다. 방금 바뀐 세션은 남긴다) */
  touch(session: QuickSession): void;
  size(): number;
};

export const MAX_SESSIONS = 4;
export const MAX_SESSION_BYTES = 768 * 1024 * 1024;

const bytesOf = (s: QuickSession): number => s.bytes.length + s.dataBytes + (s.last?.files.reduce((n, f) => n + (f?.length ?? 0), 0) ?? 0);

export function createSessionStore(limit = MAX_SESSIONS, maxBytes = MAX_SESSION_BYTES): SessionStore {
  const sessions = new Map<string, QuickSession>();
  const trim = (keep: QuickSession): void => {
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
    open(fileName, bytes, places) {
      const session: QuickSession = { id: randomUUID(), fileName, bytes, places, dataBytes: 0 };
      sessions.set(session.id, session);
      trim(session);
      return session;
    },
    get: (id) => sessions.get(id),
    touch: trim,
    size: () => sessions.size,
  };
}
