// 창 배치 계산. 상태나 DOM 없이 숫자만 다루므로 단독으로 테스트할 수 있다.

export interface Size {
  w: number
  h: number
}

export interface Rect extends Size {
  x: number
  y: number
}

/** normal 외에는 바탕 화면 크기에 맞춰 자리가 정해진다. */
export type Mode = 'normal' | 'max' | 'left' | 'right'

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const MIN_SIZE: Size = { w: 320, h: 200 }
export const TITLE_HEIGHT = 38
/** 창을 화면 밖으로 끌어내도 다시 잡을 수 있게 남겨 두는 폭 */
const GRAB = 96
const SNAP_EDGE = 10
const GAP = 8

/** 창이 실제로 차지하는 자리 */
export function frameFor(mode: Mode, rect: Rect, desk: Size): Rect {
  const half = (desk.w - GAP * 3) / 2
  const h = desk.h - GAP * 2
  switch (mode) {
    case 'normal':
      return rect
    case 'max':
      return { x: 0, y: 0, w: desk.w, h: desk.h }
    case 'left':
      return { x: GAP, y: GAP, w: half, h }
    case 'right':
      return { x: GAP * 2 + half, y: GAP, w: half, h }
  }
}

/** 창을 끌고 있는 포인터가 화면 가장자리에 닿았을 때 붙일 자리 */
export function snapZone(px: number, py: number, desk: Size): Mode | null {
  if (py <= SNAP_EDGE) return 'max'
  if (px <= SNAP_EDGE) return 'left'
  if (px >= desk.w - SNAP_EDGE) return 'right'
  return null
}

/** 제목 표시줄을 항상 잡을 수 있는 범위로 위치를 제한한다. */
export function clampMove(rect: Rect, desk: Size): Rect {
  return {
    ...rect,
    x: Math.min(desk.w - GRAB, Math.max(GRAB - rect.w, rect.x)),
    y: Math.min(Math.max(0, desk.h - TITLE_HEIGHT), Math.max(0, rect.y)),
  }
}

/** 가장자리를 (dx, dy)만큼 끌었을 때의 새 크기. 최소 크기 아래로는 줄지 않는다. */
export function resizeRect(start: Rect, edge: Edge, dx: number, dy: number): Rect {
  let { x, y, w, h } = start
  if (edge.includes('e')) w = Math.max(MIN_SIZE.w, start.w + dx)
  if (edge.includes('s')) h = Math.max(MIN_SIZE.h, start.h + dy)
  if (edge.includes('w')) {
    w = Math.max(MIN_SIZE.w, start.w - dx)
    x = start.x + start.w - w
  }
  if (edge.includes('n')) {
    // 위쪽은 화면 밖으로 나가면 제목 표시줄을 잡을 수 없으므로 0에서 멈춘다.
    const top = Math.max(0, Math.min(start.y + dy, start.y + start.h - MIN_SIZE.h))
    h = start.y + start.h - top
    y = top
  }
  return { x, y, w, h }
}

/**
 * 붙어 있던 창을 끌어서 떼어 낼 때: 원래 크기로 돌아가되,
 * 포인터가 제목 표시줄의 같은 비율 지점을 계속 잡고 있도록 위치를 정한다.
 */
export function detach(rect: Rect, frame: Rect, px: number): Rect {
  const ratio = (px - frame.x) / frame.w
  return { ...rect, x: px - rect.w * ratio, y: frame.y }
}

const CASCADE_STEP = 36

/**
 * 새 창의 첫 자리. 왼쪽 위 모서리를 조금씩 어긋나게 놓아서, 크기가 다른 창이 겹쳐도
 * 제목 표시줄은 모두 보이게 한다. 화면보다 크면 줄인다.
 */
export function placeNew(index: number, size: Size, desk: Size): Rect {
  const w = Math.min(size.w, Math.max(MIN_SIZE.w, desk.w - GAP * 2))
  const h = Math.min(size.h, Math.max(MIN_SIZE.h, desk.h - GAP * 2))
  const step = (index % 8) * CASCADE_STEP
  const x = Math.max(GAP, Math.min(desk.w * 0.04 + step, desk.w - w - GAP))
  const y = Math.max(GAP, Math.min(desk.h * 0.08 + step, desk.h - h - GAP))
  return { x: Math.round(x), y: Math.round(y), w, h }
}
