import { describe, expect, it } from 'vitest'
import { MIN_SIZE, clampMove, detach, frameFor, placeNew, resizeRect, snapZone } from '../src/ui/desktop/geometry.ts'

const desk = { w: 1000, h: 600 }
const rect = { x: 100, y: 80, w: 400, h: 300 }

describe('window geometry', () => {
  it('snaps to halves and to the full desktop', () => {
    expect(frameFor('normal', rect, desk)).toEqual(rect)
    expect(frameFor('max', rect, desk)).toEqual({ x: 0, y: 0, w: 1000, h: 600 })
    const left = frameFor('left', rect, desk)
    const right = frameFor('right', rect, desk)
    expect(left).toEqual({ x: 8, y: 8, w: 488, h: 584 })
    expect(right).toEqual({ x: 504, y: 8, w: 488, h: 584 })
    expect(right.x + right.w).toBe(desk.w - 8)
  })

  it('detects snap zones at the edges', () => {
    expect(snapZone(500, 300, desk)).toBeNull()
    expect(snapZone(500, 4, desk)).toBe('max')
    expect(snapZone(3, 300, desk)).toBe('left')
    expect(snapZone(997, 300, desk)).toBe('right')
    expect(snapZone(2, 2, desk)).toBe('max')
  })

  it('keeps the title bar reachable when moving', () => {
    expect(clampMove({ ...rect, x: -5000, y: -50 }, desk)).toMatchObject({ x: 96 - 400, y: 0 })
    expect(clampMove({ ...rect, x: 5000, y: 5000 }, desk)).toMatchObject({ x: 1000 - 96, y: 600 - 38 })
    expect(clampMove(rect, desk)).toEqual(rect)
  })

  it('resizes from each side without going below the minimum', () => {
    expect(resizeRect(rect, 'se', 50, 20)).toEqual({ x: 100, y: 80, w: 450, h: 320 })
    expect(resizeRect(rect, 'nw', 50, 20)).toEqual({ x: 150, y: 100, w: 350, h: 280 })
    // 왼쪽을 지나치게 밀어도 오른쪽 가장자리는 제자리에 있다.
    const squeezed = resizeRect(rect, 'w', 1000, 0)
    expect(squeezed.w).toBe(MIN_SIZE.w)
    expect(squeezed.x + squeezed.w).toBe(rect.x + rect.w)
    const flat = resizeRect(rect, 'n', 0, 1000)
    expect(flat.h).toBe(MIN_SIZE.h)
    expect(flat.y + flat.h).toBe(rect.y + rect.h)
    // 위쪽은 화면 밖으로 나가지 않는다.
    expect(resizeRect(rect, 'n', 0, -500)).toEqual({ x: 100, y: 0, w: 400, h: 380 })
  })

  it('detaches a snapped window under the pointer', () => {
    const frame = frameFor('max', rect, desk)
    const r = detach(rect, frame, 750)
    expect(r.w).toBe(400)
    expect(r.x).toBe(750 - 300)
    expect(r.y).toBe(0)
  })

  it('places new windows inside the desktop, cascading', () => {
    const a = placeNew(0, { w: 720, h: 460 }, desk)
    const b = placeNew(1, { w: 720, h: 460 }, desk)
    expect([b.x - a.x, b.y - a.y]).toEqual([36, 36])
    expect(a).toMatchObject({ x: 100, y: 48 })
    // 화면 끝에 닿으면 밖으로 나가지 않고 멈춘다.
    const last = placeNew(7, { w: 720, h: 460 }, desk)
    expect(last.x + last.w).toBeLessThanOrEqual(desk.w - 8)
    expect(last.y + last.h).toBeLessThanOrEqual(desk.h - 8)
    const small = placeNew(0, { w: 720, h: 460 }, { w: 400, h: 300 })
    expect(small).toEqual({ x: 8, y: 8, w: 384, h: 284 })
  })
})
