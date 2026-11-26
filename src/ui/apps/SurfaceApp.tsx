// 프로세스가 연 창. 여기에 보이는 것은 모두 그 프로세스가 보낸 그리기 명령을 그린 것이고,
// 이 창에서 일어난 마우스·키보드 입력은 그 프로세스에 이벤트로 전해진다.
// 화면 쪽은 프로그램이 무엇인지 모른다. 규약(src/kernel/gui.ts)만 안다.
import { createEffect, onCleanup, onMount } from 'solid-js'
import { GuiEvent, Mod, decodeDrawList, encodeEvent, encodePointer, keyCode, type DrawOp } from '../../kernel/gui.ts'
import { settings } from '../settings.ts'
import type { AppProps } from './registry.tsx'

/** 닫으라고 알린 뒤 이만큼 지나도록 프로세스가 끝나지 않으면 강제로 끝낸다. */
const CLOSE_GRACE_MS = 500

/** 브라우저나 운영체제가 쓰는 키. 프로그램에 전하되 기본 동작은 막지 않는다. */
const isBrowserKey = (e: KeyboardEvent) =>
  /^F\d+$/.test(e.key) || ((e.ctrlKey || e.metaKey) && ['r', 'l', 't', 'w', 'n', 'q'].includes(e.key.toLowerCase())) || (e.metaKey && e.key === 'Tab')

function paint(ctx: CanvasRenderingContext2D, ops: DrawOp[], width: number, height: number, font: string) {
  const box = (x: number, y: number, w: number, h: number, radius: number) => {
    ctx.beginPath()
    if (radius > 0) ctx.roundRect(x, y, w, h, radius)
    else ctx.rect(x, y, w, h)
  }
  for (const op of ops) {
    switch (op.op) {
      case 'clear':
        ctx.fillStyle = op.color
        ctx.fillRect(0, 0, width, height)
        break
      case 'rect':
        ctx.fillStyle = op.color
        box(op.x, op.y, op.w, op.h, op.radius)
        ctx.fill()
        break
      case 'frame':
        // 테두리가 사각형 안쪽에 그려지도록 굵기의 절반만큼 들여 긋는다.
        ctx.strokeStyle = op.color
        ctx.lineWidth = op.width
        box(op.x + op.width / 2, op.y + op.width / 2, op.w - op.width, op.h - op.width, Math.max(0, op.radius - op.width / 2))
        ctx.stroke()
        break
      case 'line':
        if (op.points.length < 4) break
        ctx.strokeStyle = op.color
        ctx.lineWidth = op.width
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.moveTo(op.points[0]!, op.points[1]!)
        for (let i = 2; i < op.points.length; i += 2) ctx.lineTo(op.points[i]!, op.points[i + 1]!)
        ctx.stroke()
        break
      case 'circle':
        ctx.fillStyle = op.color
        ctx.beginPath()
        ctx.arc(op.x, op.y, Math.max(0, op.r), 0, Math.PI * 2)
        ctx.fill()
        break
      case 'text':
        ctx.fillStyle = op.color
        ctx.font = `${op.bold ? 600 : 400} ${op.size}px ${font}`
        ctx.textAlign = op.align
        ctx.textBaseline = 'middle'
        ctx.fillText(op.text, op.x, op.y)
        break
    }
  }
}

export function SurfaceApp(props: AppProps) {
  const gui = props.system.gui
  const pid = Number(props.args.pid)
  let canvas!: HTMLCanvasElement
  /** 마지막으로 받은 그림. 창 크기가 바뀌면 프로그램이 새로 그려 보내기 전까지 이것을 다시 그린다. */
  let ops: DrawOp[] = []
  let size = { w: 0, h: 0 }
  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && dark.matches)
  const send = (kind: number, a = 0, b = 0, c = 0) => gui.send(pid, encodeEvent(kind, a, b, c))
  const point = (kind: number, [x, y]: readonly [number, number], c = 0) => gui.send(pid, encodePointer(kind, x, y, c))

  function redraw() {
    const ctx = canvas.getContext('2d')
    if (!ctx || size.w === 0) return
    const scale = window.devicePixelRatio || 1
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    paint(ctx, ops, size.w, size.h, getComputedStyle(canvas).fontFamily)
  }

  /** 창의 크기에 캔버스를 맞추고 프로그램에 알린다. */
  function fit() {
    const [w, h] = [canvas.clientWidth, canvas.clientHeight]
    if (w === 0 || h === 0) return
    const scale = window.devicePixelRatio || 1
    size = { w, h }
    // 화면 배율만큼 촘촘하게 그려서 고해상도 화면에서도 선명하게 한다. 프로그램이 보는 좌표는 그대로다.
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    redraw()
    send(GuiEvent.resize, w, h, isDark() ? 1 : 0)
  }

  const at = (e: PointerEvent) => {
    const box = canvas.getBoundingClientRect()
    // 창이 나타나는 움직임처럼 확대·축소된 동안에도 프로그램이 보는 좌표로 맞춘다.
    return [((e.clientX - box.left) * size.w) / (box.width || 1), ((e.clientY - box.top) * size.h) / (box.height || 1)] as const
  }

  onMount(() => {
    const detach = gui.attach(pid, {
      draw(data) {
        try {
          ops = decodeDrawList(data)
        } catch {
          return // 형식이 틀린 묶음은 버린다 (프로그램의 버그)
        }
        redraw()
      },
      closed: () => props.close(),
    })
    if (!detach) return props.close() // 창이 뜨기도 전에 프로세스가 끝났다
    const observer = new ResizeObserver(fit)
    observer.observe(canvas)
    dark.addEventListener('change', fit)
    onCleanup(() => {
      detach()
      observer.disconnect()
      dark.removeEventListener('change', fit)
    })

    // 닫기를 누르면 프로그램에 먼저 알려 정리할 틈을 준다. 창은 프로세스가 끝날 때 닫힌다.
    let closing: ReturnType<typeof setTimeout> | undefined
    props.guardClose(() => {
      send(GuiEvent.close)
      closing ??= setTimeout(() => props.system.kill(pid), CLOSE_GRACE_MS)
      return false
    })
    onCleanup(() => clearTimeout(closing))
  })

  // 테마를 바꾸면 프로그램이 색을 맞출 수 있게 알린다.
  createEffect((first: boolean) => {
    settings.theme
    if (!first) fit()
    return false
  }, true)

  createEffect(() => props.focused() && canvas.focus({ preventScroll: true }))

  return (
    <canvas
      class="surface"
      ref={canvas}
      tabindex="0"
      role="application"
      aria-label={props.args.title}
      data-pid={pid}
      onPointerDown={(e) => {
        canvas.setPointerCapture(e.pointerId)
        canvas.focus({ preventScroll: true })
        point(GuiEvent.pointerDown, at(e), e.button)
      }}
      onPointerMove={(e) => {
        // 빠르게 움직이면 브라우저가 여러 위치를 한 번에 묶어 준다. 선이 각지지 않게 모두 전한다.
        for (const step of e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e]) point(GuiEvent.pointerMove, at(step), e.buttons)
      }}
      onPointerUp={(e) => point(GuiEvent.pointerUp, at(e))}
      onPointerCancel={(e) => point(GuiEvent.pointerUp, at(e))}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const code = keyCode(e.key)
        if (code === undefined || e.isComposing) return
        if (!isBrowserKey(e)) e.preventDefault()
        send(GuiEvent.key, code, (e.shiftKey ? Mod.shift : 0) | (e.ctrlKey ? Mod.ctrl : 0) | (e.altKey ? Mod.alt : 0) | (e.metaKey ? Mod.meta : 0))
      }}
    />
  )
}
