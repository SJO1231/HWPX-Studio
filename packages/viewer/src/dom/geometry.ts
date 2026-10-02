// 화면 좌표와 쪽 좌표 사이의 변환, 배율. DOM을 건드리지 않는 순수 함수라 Node에서도 시험한다. 눌린 자리의 글자 찾기는 `rhwp/pick.ts`에 있다.
import type { Rect } from "../rhwp/layout.ts";

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 2;

/** 배율을 50~200% 안으로 맞춘다. */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 화면 좌표(`clientX`, `clientY`)를 쪽 좌표(96 DPI 픽셀, 쪽 왼쪽 위가 원점)로 바꾼다. `box`는 쪽 요소의 화면 위치다. */
export function toPagePoint(client: { x: number; y: number }, box: { left: number; top: number }, scale: number): { x: number; y: number } {
  return { x: (client.x - box.left) / scale, y: (client.y - box.top) / scale };
}

/** 쪽 사각형을 화면(쪽 요소 안 CSS 픽셀) 사각형으로 바꾼다. */
export function toScreenRect(rect: Rect, scale: number): Rect {
  return { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale };
}
