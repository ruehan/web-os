// 프로세스가 연 창. 여기에 보이는 것은 모두 그 프로세스가 보낸 그리기 명령을 그린 것이고,
// 이 창에서 일어난 마우스·키보드 입력은 그 프로세스에 이벤트로 전해진다.
// 화면 쪽은 프로그램이 무엇인지 모른다. 규약(src/kernel/gui.ts)만 안다.
import { createEffect, on, onCleanup, onMount } from 'solid-js'
import { GuiEvent, Mod, decodeDrawList, encodeEvent, encodePointer, keyCode, type DrawOp } from '../../kernel/gui.ts'
import { settings } from '../settings.ts'
import { showMenuAt, type MenuItem } from '../contextmenu.tsx'
import { canvasFont, fontFamilies } from '../system.ts'
import type { AppProps } from './registry.tsx'

type FieldOp = Extract<DrawOp, { op: 'field' }>
type RegionOp = Extract<DrawOp, { op: 'region' }>
type MenuOp = Extract<DrawOp, { op: 'menu' }>
type FieldElement = HTMLTextAreaElement | HTMLInputElement

/** 닫으라고 알린 뒤 이만큼 지나도록 프로세스가 끝나지 않으면 강제로 끝낸다. */
const CLOSE_GRACE_MS = 500

/** 브라우저나 운영체제가 쓰는 키. 프로그램에 전하되 기본 동작은 막지 않는다. */
const isBrowserKey = (e: KeyboardEvent) =>
  /^F\d+$/.test(e.key) || ((e.ctrlKey || e.metaKey) && ['r', 'l', 't', 'w', 'n', 'q'].includes(e.key.toLowerCase())) || (e.metaKey && e.key === 'Tab')
/** 입력 칸이 스스로 처리하는 단축키 (복사, 붙여넣기, 되돌리기 등) */
const isEditingKey = (e: KeyboardEvent) => ['c', 'v', 'x', 'z', 'y', 'a'].includes(e.key.toLowerCase())
const modsOf = (e: KeyboardEvent) => (e.shiftKey ? Mod.shift : 0) | (e.ctrlKey ? Mod.ctrl : 0) | (e.altKey ? Mod.alt : 0) | (e.metaKey ? Mod.meta : 0)

function paint(ctx: CanvasRenderingContext2D, ops: DrawOp[], width: number, height: number, fonts: [string, string]) {
  const box = (x: number, y: number, w: number, h: number, radius: number) => {
    ctx.beginPath()
    if (radius > 0) ctx.roundRect(x, y, w, h, radius)
    else ctx.rect(x, y, w, h)
  }
  /** 아직 풀지 않은 clip의 수 */
  let clips = 0
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
        ctx.font = canvasFont(op.size, op, ...fonts)
        ctx.textAlign = op.align
        ctx.textBaseline = 'middle'
        ctx.fillText(op.text, op.x, op.y)
        if (op.strike || op.underline) {
          const w = ctx.measureText(op.text).width
          const left = op.align === 'left' ? op.x : op.align === 'center' ? op.x - w / 2 : op.x - w
          const thick = Math.max(1, op.size / 14)
          if (op.strike) ctx.fillRect(left, op.y - thick / 2, w, thick)
          if (op.underline) ctx.fillRect(left, op.y + op.size * 0.55, w, thick)
        }
        break
      case 'clip':
        ctx.save()
        clips++
        ctx.beginPath()
        ctx.rect(op.x, op.y, op.w, op.h)
        ctx.clip()
        break
      case 'unclip':
        if (clips > 0) {
          ctx.restore()
          clips--
        }
        break
      case 'field': // 입력 칸은 캔버스 위에 실제 요소로 놓는다
      case 'region': // 보이지 않는 요소로 놓는다
      case 'menu': // 시스템의 메뉴로 띄운다
      case 'select': // 입력 칸의 커서를 옮긴다
        break
    }
  }
  // 프로그램이 풀지 않고 끝낸 clip이 다음 그림에 남지 않게 한다.
  while (clips-- > 0) ctx.restore()
}

export function SurfaceApp(props: AppProps) {
  const gui = props.system.gui
  const pid = Number(props.args.pid)
  let host!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  /** 마지막으로 받은 그림. 창 크기가 바뀌면 프로그램이 새로 그려 보내기 전까지 이것을 다시 그린다. */
  let ops: DrawOp[] = []
  let size = { w: 0, h: 0 }
  /** 지금 놓여 있는 입력 칸들과, 프로그램이나 사용자가 정한 그 글 */
  const fields = new Map<number, FieldElement>()
  const texts = new Map<number, string>()
  /** 이 창에서 마지막으로 커서가 있던 입력 칸. 창이 다시 앞으로 오면 거기로 돌아간다. */
  let lastField: number | undefined
  let layer!: HTMLDivElement
  const regions: HTMLDivElement[] = []
  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && dark.matches)
  const send = (kind: number, a = 0, b = 0, c = 0) => gui.send(pid, encodeEvent(kind, a, b, c))
  const point = (kind: number, [x, y]: readonly [number, number], c = 0) => gui.send(pid, encodePointer(kind, x, y, c))

  function redraw() {
    const ctx = canvas.getContext('2d')
    if (!ctx || size.w === 0) return
    const scale = window.devicePixelRatio || 1
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    paint(ctx, ops, size.w, size.h, fontFamilies())
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

  /** 같은 자리를 연달아 누른 횟수 (두 번 누르기를 프로그램이 알 수 있게) */
  let lastDown = { time: -1e9, x: 0, y: 0, button: -1, count: 0 }
  function clicksAt(e: PointerEvent): number {
    const again = e.timeStamp - lastDown.time < 400 && e.button === lastDown.button && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6
    lastDown = { time: e.timeStamp, x: e.clientX, y: e.clientY, button: e.button, count: again ? Math.min(lastDown.count + 1, 3) : 1 }
    return lastDown.count
  }

  const at = (e: MouseEvent) => {
    const box = canvas.getBoundingClientRect()
    // 창이 나타나는 움직임처럼 확대·축소된 동안에도 프로그램이 보는 좌표로 맞춘다.
    // 창이 뜬 직후, 아직 크기를 재기 전에 누를 수도 있으므로 그때그때의 크기를 쓴다.
    return [((e.clientX - box.left) * canvas.clientWidth) / (box.width || 1), ((e.clientY - box.top) * canvas.clientHeight) / (box.height || 1)] as const
  }

  /**
   * 프로그램에 전할 키인지 보고 전한다. 입력 칸에서는 글자를 칸이 받으므로 단축키와,
   * 칸이 쓰지 않는 키(Esc, 한 줄짜리 칸의 Enter와 위·아래)만 전한다.
   */
  function key(e: KeyboardEvent, field?: FieldElement) {
    const code = keyCode(e.key)
    if (code === undefined || e.isComposing) return
    const command = e.ctrlKey || e.metaKey
    if (field && !command) {
      const free = e.key === 'Escape' || (field instanceof HTMLInputElement && ['Enter', 'ArrowUp', 'ArrowDown'].includes(e.key))
      if (!free) return
    }
    if (!isBrowserKey(e) && !(field && command && isEditingKey(e))) e.preventDefault()
    send(GuiEvent.key, code, modsOf(e))
  }

  function makeField(op: FieldOp): FieldElement {
    const el = op.multiline ? document.createElement('textarea') : document.createElement('input')
    el.className = 'surface-field'
    el.spellcheck = false
    el.value = texts.get(op.id) ?? ''
    el.addEventListener('input', () => {
      texts.set(op.id, el.value)
      gui.setText(pid, op.id, el.value)
    })
    el.addEventListener('focus', () => {
      lastField = op.id
      send(GuiEvent.fieldFocus, op.id, 1)
    })
    el.addEventListener('blur', () => {
      // 창이 뒤로 간 것은 focus 이벤트로 따로 알린다. 여기서는 창 안에서 다른 곳으로 옮긴 것만 알린다.
      if (document.hasFocus() && props.focused()) send(GuiEvent.fieldFocus, op.id, 0)
    })
    el.addEventListener('keydown', (e) => key(e as KeyboardEvent, el))
    host.append(el)
    return el
  }

  /** 그림의 단추·항목 자리에 보이지 않는 요소를 맞춰 놓는다 (화면 낭독기와 자동 검사가 이것을 본다). */
  function placeRegions() {
    const wanted = ops.filter((op): op is RegionOp => op.op === 'region')
    while (regions.length > wanted.length) regions.pop()!.remove()
    wanted.forEach((op, i) => {
      let el = regions[i]
      if (!el) {
        regions.push((el = document.createElement('div')))
        el.className = 'surface-region'
        // 화면 낭독기로 "누르기"를 하면 그 자리를 누른 것으로 전한다.
        el.addEventListener('click', () => {
          const [x, y] = [Number(el!.dataset.x), Number(el!.dataset.y)]
          point(GuiEvent.pointerDown, [x, y], 0)
          point(GuiEvent.pointerUp, [x, y])
        })
        layer.append(el)
      }
      const state = op.role === 'button' ? 'aria-pressed' : op.role === 'checkbox' ? 'aria-checked' : 'aria-selected'
      for (const name of ['aria-pressed', 'aria-checked', 'aria-selected']) {
        if (name !== state || (op.role === 'button' && !op.on) || op.role === 'link') el.removeAttribute(name)
        else el.setAttribute(name, String(op.on))
      }
      el.setAttribute('role', op.role)
      el.setAttribute('aria-label', op.label)
      if (op.disabled) el.setAttribute('aria-disabled', 'true')
      else el.removeAttribute('aria-disabled')
      el.dataset.x = String(op.x + op.w / 2)
      el.dataset.y = String(op.y + op.h / 2)
      Object.assign(el.style, { left: `${op.x}px`, top: `${op.y}px`, width: `${Math.max(0, op.w)}px`, height: `${Math.max(0, op.h)}px` })
    })
  }

  /** 프로그램이 정한 자리로 입력 칸의 커서를 옮긴다. 자리는 UTF-8 바이트 위치로 온다. */
  function moveCaret(op: Extract<DrawOp, { op: 'select' }>) {
    const el = fields.get(op.id)
    if (!el) return
    const bytes = new TextEncoder().encode(el.value)
    const index = (at: number) => new TextDecoder().decode(bytes.subarray(0, Math.min(at, bytes.length))).length
    const [start, end] = [index(op.start), index(op.end)]
    lastField = op.id
    if (props.focused()) el.focus({ preventScroll: true })
    el.setSelectionRange(start, end)
    if (el instanceof HTMLTextAreaElement) {
      // 긴 줄이 여러 줄로 접히면 줄 번호만으로는 높이를 알 수 없어, 전체 높이의 비율로 어림한다.
      const line = el.value.slice(0, start).split('\n').length - 1
      el.scrollTop = Math.max(0, (line / el.value.split('\n').length) * el.scrollHeight - 30)
    }
  }

  /** 프로그램이 띄워 달라고 한 메뉴를 시스템의 메뉴로 띄우고, 고른 것을 알린다. */
  function openMenu(op: MenuOp) {
    const box = canvas.getBoundingClientRect()
    let chosen = false
    const items: MenuItem[] = op.items.map((item, i) =>
      item.separator
        ? 'separator'
        : {
            label: item.label,
            disabled: item.disabled,
            danger: item.danger,
            onSelect: () => {
              chosen = true
              send(GuiEvent.menu, i)
            },
          },
    )
    // 고르면 닫힘이 먼저, 고름이 나중에 불린다. 고르지 않고 닫은 것만 -1로 알린다.
    showMenuAt(box.left + op.x, box.top + op.y, items, () => queueMicrotask(() => chosen || send(GuiEvent.menu, -1)))
  }

  /** 그리기 명령에 든 입력 칸들을 실제 요소로 맞춘다: 새 칸은 만들고, 빠진 칸은 치우고, 자리와 모양을 고친다. */
  function placeFields() {
    const wanted = ops.filter((op): op is FieldOp => op.op === 'field')
    for (const [id, el] of fields) {
      if (wanted.some((op) => op.id === id && op.multiline === el instanceof HTMLTextAreaElement)) continue
      // 커서가 있던 칸이 사라지면 키 입력이 갈 곳이 없어지므로 그림으로 옮긴다.
      if (document.activeElement === el && props.focused()) canvas.focus({ preventScroll: true })
      el.remove()
      fields.delete(id)
    }
    for (const op of wanted) {
      let el = fields.get(op.id)
      if (!el) fields.set(op.id, (el = makeField(op)))
      el.setAttribute('aria-label', op.label)
      el.placeholder = op.placeholder
      Object.assign(el.style, {
        left: `${op.x}px`,
        top: `${op.y}px`,
        width: `${op.w}px`,
        height: `${op.h}px`,
        fontSize: `${op.size}px`,
        color: op.color,
        background: op.background,
        fontFamily: op.mono ? 'var(--mono)' : '',
        fontWeight: op.bold ? '600' : '',
        // 한 줄짜리 칸은 글이 세로 가운데에 오게 한다.
        lineHeight: op.multiline ? '' : `${op.h}px`,
      })
      // 프로그램은 커서를 옮기고 싶은 그림에만 focus를 켜서 보낸다 (파일을 새로 열었을 때 등).
      if (op.focus) {
        lastField = op.id
        if (props.focused()) {
          el.focus({ preventScroll: true })
          if (op.select) el.select()
        }
      }
    }
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
        placeFields()
        placeRegions()
        for (const op of ops) if (op.op === 'select') moveCaret(op)
        const menu = ops.find((op): op is MenuOp => op.op === 'menu')
        if (menu) openMenu(menu)
      },
      setText(field, text) {
        texts.set(field, text)
        const el = fields.get(field)
        // 같은 글이면 건드리지 않는다 (커서 위치와 조합 중인 글자가 날아가지 않게).
        if (el && el.value !== text) el.value = text
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
  createEffect(on(() => settings.theme, fit, { defer: true }))

  // 창이 앞으로 오면 커서를 돌려주고, 프로그램에도 알린다 (그사이 바뀐 것을 다시 읽을 기회).
  createEffect(
    on(props.focused, (focused, was) => {
      if (focused) (fields.get(lastField ?? -1) ?? canvas).focus({ preventScroll: true })
      if (was !== undefined) send(GuiEvent.focus, focused ? 1 : 0)
    }),
  )

  return (
    <div class="surface-host" ref={host} data-pid={pid}>
      <canvas
        class="surface"
        ref={canvas}
        tabindex="0"
        role="application"
        aria-label={props.args.title}
        onPointerDown={(e) => {
          canvas.setPointerCapture(e.pointerId)
          canvas.focus({ preventScroll: true })
          lastField = undefined
          point(GuiEvent.pointerDown, at(e), e.button + 256 * (clicksAt(e) - 1))
        }}
        onPointerMove={(e) => {
          // 빠르게 움직이면 브라우저가 여러 위치를 한 번에 묶어 준다. 선이 각지지 않게 모두 전한다.
          for (const step of e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e]) point(GuiEvent.pointerMove, at(step), e.buttons)
        }}
        onPointerUp={(e) => point(GuiEvent.pointerUp, at(e))}
        onPointerCancel={(e) => point(GuiEvent.pointerUp, at(e))}
        onPointerLeave={() => send(GuiEvent.pointerLeave)}
        onWheel={(e) => {
          // 줄 단위로 알려 주는 마우스는 한 줄을 대략의 픽셀로 바꾼다.
          const dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 30 : e.deltaY
          if (dy) point(GuiEvent.wheel, at(e), dy)
        }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => key(e)}
      />
      <div class="surface-regions" ref={layer} />
    </div>
  )
}
