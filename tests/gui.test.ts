// 화면 통로: 프로세스가 창을 열고, 그리기 명령을 보내고, 입력을 받는다.
// 실제 그림판 바이너리(programs/paint)를 커널 위에서 돌려 확인한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KernelEvent } from '../src/kernel/abi.ts'
import { GuiEvent, Key, Mod, decodeDrawList, encodeEvent, encodePointer, keyCode, type DrawOp } from '../src/kernel/gui.ts'
import { boot } from './host.ts'

type Host = ReturnType<typeof boot>
let host: Host

beforeEach(() => {
  host = boot()
})
afterEach(() => host.shutdown())

type Of<T extends KernelEvent['type']> = Extract<KernelEvent, { type: T }>
const all = <T extends KernelEvent['type']>(type: T, pid: number) =>
  host.events.filter((e): e is Of<T> => e.type === type && 'pid' in e && e.pid === pid)

/** 그림판을 띄우고 첫 화면이 그려질 때까지 기다린다. */
async function openPaint() {
  const pid = host.kernel.launch('/bin/paint', ['paint'])
  await host.until(() => all('gui-draw', pid).length > 0, 'first frame')
  let seen = all('gui-draw', pid).length
  return {
    pid,
    /** 포인터 이벤트의 좌표는 픽셀로 적는다. */
    send: (kind: number, a = 0, b = 0, c = 0) => {
      const pointer = kind >= GuiEvent.pointerDown && kind <= GuiEvent.pointerUp
      host.kernel.guiEvent(pid, pointer ? encodePointer(kind, a, b, c) : encodeEvent(kind, a, b, c))
    },
    /** 다음 화면이 그려지기를 기다려 그 내용을 돌려준다. */
    async frame(): Promise<DrawOp[]> {
      await host.until(() => all('gui-draw', pid).length > seen, 'next frame')
      const frames = all('gui-draw', pid)
      seen = frames.length
      return decodeDrawList(frames.at(-1)!.data)
    },
    latest: () => decodeDrawList(all('gui-draw', pid).at(-1)!.data),
  }
}

const texts = (ops: DrawOp[]) => ops.flatMap((op) => (op.op === 'text' ? [op.text] : []))
const lines = (ops: DrawOp[]) => ops.filter((op) => op.op === 'line')

describe('a process with a window', () => {
  it('opens a window and draws its whole interface itself', async () => {
    const paint = await openPaint()
    expect(all('gui-open', paint.pid)).toEqual([{ type: 'gui-open', pid: paint.pid, title: '그림판', w: 720, h: 480 }])
    const ops = paint.latest()
    expect(ops[0]).toEqual({ op: 'clear', color: '#ffffff' })
    expect(texts(ops)).toEqual(['되돌리기', '모두 지우기', '저장', '끌어서 그립니다 · Ctrl+Z 되돌리기 · Ctrl+S 저장', '획 0개'])
    // 색 일곱 개와 굵기 세 개가 그려진다.
    expect(ops.filter((op) => op.op === 'circle' && op.r === 9)).toHaveLength(7)
    expect(ops.filter((op) => op.op === 'frame' && op.w === 34)).toHaveLength(3)
  })

  it('is an ordinary process: listed, and its window goes when it is killed', async () => {
    const paint = await openPaint()
    expect((await host.sh('ps')).stdout).toMatch(new RegExp(`^\\s*${paint.pid}\\s.*paint$`, 'm'))
    host.kernel.kill(paint.pid)
    expect(all('gui-close', paint.pid)).toHaveLength(1)
    expect(all('exit', paint.pid)).toEqual([{ type: 'exit', pid: paint.pid, code: 137 }])
    // 끝난 프로세스에 보낸 입력은 조용히 버려진다.
    paint.send(GuiEvent.pointerDown, 100, 100, 0)
  })

  it('waits for input without using the CPU, and redraws for each batch of input', async () => {
    const paint = await openPaint()
    const before = all('gui-draw', paint.pid).length
    await new Promise((r) => setTimeout(r, 150))
    expect(all('gui-draw', paint.pid)).toHaveLength(before)

    paint.send(GuiEvent.resize, 900, 600, 1)
    const ops = await paint.frame()
    // 어두운 테마에서는 도구 막대의 색이 바뀌고, 상태 줄이 새 크기의 아래쪽으로 간다.
    expect(ops).toContainEqual({ op: 'rect', x: 0, y: 0, w: 900, h: 40, radius: 0, color: '#1e2026' })
    expect(ops).toContainEqual({ op: 'rect', x: 0, y: 574, w: 900, h: 26, radius: 0, color: '#1e2026' })
  })

  it('turns dragging into a stroke in the chosen color and width', async () => {
    const paint = await openPaint()
    // 두 번째 색(빨강)과 세 번째 굵기를 고른다. 도구는 왼쪽부터 놓여 있다.
    paint.send(GuiEvent.pointerDown, 10 + 30 + 2 + 15, 20, 0)
    paint.send(GuiEvent.pointerUp, 57, 20)
    await paint.frame()
    const widths = paint.latest().filter((op) => op.op === 'frame' && op.w === 34) as Extract<DrawOp, { op: 'frame' }>[]
    paint.send(GuiEvent.pointerDown, widths[2]!.x + 5, 20, 0)
    paint.send(GuiEvent.pointerUp, widths[2]!.x + 5, 20)
    expect((await paint.frame()).filter((op) => op.op === 'frame' && op.width === 2)).toMatchObject([{ x: widths[2]!.x }])

    paint.send(GuiEvent.pointerDown, 100, 100, 0)
    paint.send(GuiEvent.pointerMove, 150, 120, 1)
    paint.send(GuiEvent.pointerMove, 150.4, 120, 1) // 거의 움직이지 않은 것은 버린다
    paint.send(GuiEvent.pointerMove, 200.5, 180.25, 1) // 픽셀보다 작은 단위까지 전해진다
    paint.send(GuiEvent.pointerUp, 200, 180)
    await host.until(() => texts(paint.latest()).includes('획 1개') && lines(paint.latest())[0]?.points.length === 6, 'the stroke')
    expect(lines(paint.latest())).toEqual([{ op: 'line', color: '#d93a31', width: 12, points: [100, 100, 150, 120, 200.5, 180.25] }])

    // 떼고 난 뒤의 움직임은 그려지지 않는다.
    paint.send(GuiEvent.pointerMove, 300, 300, 0)
    // 누르기만 하면 점이 찍힌다.
    paint.send(GuiEvent.pointerDown, 400, 300, 0)
    paint.send(GuiEvent.pointerUp, 400, 300)
    await host.until(() => texts(paint.latest()).includes('획 2개'), 'the dot')
    expect(paint.latest()).toContainEqual({ op: 'circle', x: 400, y: 300, r: 6, color: '#d93a31' })
    expect(lines(paint.latest())).toHaveLength(1)
  })

  it('undoes with Ctrl+Z and clears with the button', async () => {
    const paint = await openPaint()
    const stroke = (y: number) => {
      paint.send(GuiEvent.pointerDown, 100, y, 0)
      paint.send(GuiEvent.pointerMove, 200, y, 1)
      paint.send(GuiEvent.pointerUp, 200, y)
    }
    stroke(100)
    stroke(200)
    stroke(300)
    await host.until(() => texts(paint.latest()).includes('획 3개'), 'three strokes')
    paint.send(GuiEvent.key, keyCode('z'), Mod.ctrl)
    await host.until(() => texts(paint.latest()).includes('획 2개'), 'undo')
    expect(lines(paint.latest()).map((l) => l.points[1])).toEqual([100, 200])
    // Cmd+Z 도 같다.
    paint.send(GuiEvent.key, keyCode('Z'), Mod.meta | Mod.shift)
    await host.until(() => texts(paint.latest()).includes('획 1개'), 'second undo')
    // 다른 키는 아무 일도 하지 않는다.
    paint.send(GuiEvent.key, keyCode('z'), 0)
    paint.send(GuiEvent.key, Key.Enter, 0)

    stroke(250)
    await host.until(() => texts(paint.latest()).includes('획 2개'), 'another stroke')
    const clear = paint.latest().find((op) => op.op === 'text' && op.text === '모두 지우기') as Extract<DrawOp, { op: 'text' }>
    paint.send(GuiEvent.pointerDown, clear.x, clear.y, 0)
    await host.until(() => texts(paint.latest()).includes('획 0개'), 'clear')
    expect(lines(paint.latest())).toEqual([])
  })

  it('saves the drawing as an SVG file through ordinary file system calls', async () => {
    const paint = await openPaint()
    paint.send(GuiEvent.pointerDown, 100, 140, 0)
    paint.send(GuiEvent.pointerMove, 220, 190, 1)
    paint.send(GuiEvent.pointerUp, 220, 190)
    paint.send(GuiEvent.key, keyCode('s'), Mod.ctrl)
    await host.until(() => texts(paint.latest()).includes('저장했습니다: ~/그림/그림 1.svg'), 'save')
    const svg = new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/그림/그림 1.svg'))
    // 파일의 좌표는 도구 막대 아래의 그림 영역 기준이다 (세로로 40 위).
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="414" viewBox="0 0 720 414">\n' +
        '<rect width="100%" height="100%" fill="#ffffff"/>\n' +
        '<polyline fill="none" stroke="#1c1d20" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" points="100.0,100.0 220.0,150.0"/>\n' +
        '</svg>\n',
    )

    // 다시 저장하면 같은 파일에 덮어쓴다.
    paint.send(GuiEvent.pointerDown, 300, 300, 0)
    paint.send(GuiEvent.pointerUp, 300, 300)
    await host.until(() => texts(paint.latest()).includes('저장하지 않은 변경이 있습니다') || texts(paint.latest()).includes('획 2개'), 'second stroke')
    paint.send(GuiEvent.key, keyCode('s'), Mod.meta)
    await host.until(() => new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/그림/그림 1.svg')).includes('<circle cx="300.0" cy="260.0" r="2.5"'), 'second save')
    expect((await host.sh('ls 그림')).stdout).toBe('그림 1.svg\n')
  })

  it('wraps the tools onto a second row when the window is narrow', async () => {
    const paint = await openPaint()
    paint.send(GuiEvent.resize, 360, 600, 0)
    const ops = await paint.frame()
    expect(ops).toContainEqual({ op: 'rect', x: 0, y: 0, w: 360, h: 80, radius: 0, color: '#f4f5f8' })
    const labels = ops.filter((op) => op.op === 'text' && ['되돌리기', '모두 지우기', '저장'].includes(op.text)) as Extract<DrawOp, { op: 'text' }>[]
    for (const label of labels) {
      expect(label.x).toBeLessThan(360)
      expect(label.y).toBe(60)
    }
  })

  it('exits when asked to close', async () => {
    const paint = await openPaint()
    paint.send(GuiEvent.close)
    await host.until(() => all('exit', paint.pid).length > 0, 'exit')
    expect(all('exit', paint.pid)[0]!.code).toBe(0)
    expect(all('gui-close', paint.pid)).toHaveLength(1)
  })

  it('reports the window calls in the system call trace', async () => {
    host.kernel.setTracing(true)
    const paint = await openPaint()
    paint.send(GuiEvent.pointerDown, 100, 100, 0)
    await paint.frame()
    paint.send(GuiEvent.close)
    await host.until(() => all('exit', paint.pid).length > 0, 'exit')
    await host.until(() => host.events.some((e) => e.type === 'trace' && e.records.some((r) => r.pid === paint.pid && r.call === 'exit')), 'trace')
    const calls = host.events.flatMap((e) => (e.type === 'trace' ? e.records : [])).filter((r) => r.pid === paint.pid && r.call.startsWith('gui'))
    const shown = calls.map((r) => `${r.call}(${r.args}) ${r.result}`.trim())
    expect(shown[0]).toBe('guiopen("그림판", 720x480) = 0')
    expect(shown[1]).toMatch(/^guidraw\(\d+ bytes\) = 0$/)
    expect(shown).toContain('guievent() = pointerDown(100, 100, 0)')
    expect(shown).toContain('guievent(0ms) = 0')
    expect(shown.at(-1)).toBe('guievent() = close(0, 0, 0)')
  })
})

describe('window calls without a window', () => {
  it('a program that never opened one cannot draw', async () => {
    // hello는 창을 열지 않는다. 창이 없는 프로세스에 보낸 입력은 버려진다.
    const pid = host.kernel.spawn('/bin/spin', ['spin'])
    host.kernel.guiEvent(pid, encodeEvent(GuiEvent.close))
    await new Promise((r) => setTimeout(r, 50))
    expect(host.kernel.pids()).toContain(pid)
    host.kernel.kill(pid)
    expect(all('gui-close', pid)).toEqual([])
  })
})

describe('draw lists', () => {
  const bytes = (...parts: (number[] | Float32Array | Uint32Array | Uint8Array)[]) =>
    new Uint8Array(parts.flatMap((p) => [...new Uint8Array(ArrayBuffer.isView(p) ? p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) : new Uint8Array(p).buffer)]))

  it('decodes colors with and without transparency', () => {
    expect(decodeDrawList(bytes([1], Uint32Array.of(0x11223380)))).toEqual([{ op: 'clear', color: '#11223380' }])
    expect(decodeDrawList(bytes([1], Uint32Array.of(0x000a0bff)))).toEqual([{ op: 'clear', color: '#000a0b' }])
  })

  it('decodes text with its alignment and weight', () => {
    const text = new TextEncoder().encode('한글 abc')
    const data = bytes([6], Float32Array.of(10, 20, 13), Uint32Array.of(0xff0000ff), [2 | 4], Uint32Array.of(text.length), text)
    expect(decodeDrawList(data)).toEqual([{ op: 'text', x: 10, y: 20, size: 13, color: '#ff0000', align: 'right', bold: true, text: '한글 abc' }])
  })

  it('rejects truncated or unknown commands instead of drawing garbage', () => {
    expect(() => decodeDrawList(bytes([2], Float32Array.of(1, 2, 3)))).toThrow('ends in the middle')
    expect(() => decodeDrawList(bytes([99]))).toThrow('unknown command 99')
    expect(() => decodeDrawList(bytes([4], Uint32Array.of(0xff), Float32Array.of(1), Uint32Array.of(0xffffffff)))).toThrow('too many points')
    expect(() => decodeDrawList(bytes([6], Float32Array.of(0, 0, 12), Uint32Array.of(0xff), [0], Uint32Array.of(50), [65]))).toThrow('ends in the middle')
    expect(decodeDrawList(new Uint8Array(0))).toEqual([])
  })

  it('maps browser keys to key codes', () => {
    expect(keyCode('a')).toBe(97)
    expect(keyCode('한')).toBe(0xd55c)
    expect(keyCode('😀')).toBe(0x1f600)
    expect(keyCode('Enter')).toBe(Key.Enter)
    expect(keyCode('ArrowLeft')).toBe(Key.ArrowLeft)
    expect(keyCode('Shift')).toBeUndefined()
    expect(keyCode('F5')).toBeUndefined()
  })
})
