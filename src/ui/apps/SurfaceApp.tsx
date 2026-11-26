// 프로세스가 연 창. 여기에 보이는 것은 모두 그 프로세스가 보낸 그리기 명령을 그린 것이고,
// 이 창에서 일어난 마우스·키보드 입력은 그 프로세스에 이벤트로 전해진다.
// 화면 쪽은 프로그램이 무엇인지 모른다. 규약(src/kernel/gui.ts)만 안다.
import { createEffect, on, onCleanup, onMount } from 'solid-js'
import { GuiEvent, HANDOFF_LIMIT, Mod, PLAYER_UNSUPPORTED, PlayerCommand, decodeDrawList, decodeStyles, encodeEvent, encodePointer, handoffDir, keyCode, styledPieces, type DrawOp, type StyleRange } from '../../kernel/gui.ts'
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

function paint(ctx: CanvasRenderingContext2D, ops: DrawOp[], width: number, height: number, fonts: [string, string], imageAt: (path: string) => HTMLImageElement | undefined) {
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
      case 'overlay': // 위층과의 경계 (아래에서 나눠 그린다)
      case 'pick': // 파일 고르기 창을 띄운다
      case 'copy': // 클립보드에 넣는다
      case 'open': // 새 탭으로 연다
      case 'title': // 창의 제목
      case 'launch': // 파일을 알맞은 앱으로 연다
      case 'player': // 바깥 플레이어는 캔버스 위에 실제 요소로 놓는다
      case 'playerCommand':
        break
      case 'image': {
        const image = imageAt(op.path)
        if (!image || op.w <= 0 || op.h <= 0) break
        try {
          ctx.drawImage(image, op.x, op.y, op.w, op.h)
        } catch {
          // 그릴 수 없는 그림은 건너뛴다.
        }
        break
      }
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
  /** 칸마다의 가장 최근 명령 (어떤 키를 프로그램에 넘길지 등) */
  /** 프로그램이 글에 색을 입힌 칸들: 색 범위와, 그 색으로 글을 보여 주는 층 (입력 칸 바로 아래에 겹쳐 있다) */
  const styles = new Map<number, StyleRange[]>()
  const layers = new Map<number, HTMLDivElement>()
  /** 지금까지 프로그램에 건넨 파일의 수 (이름 앞에 붙이는 순번) */
  let handed = 0
  const fieldOps = new Map<number, FieldOp>()
  /** 방금 줄이 바뀌려 한 칸들 (곧 올 입력이 그 줄바꿈이다) */
  const broke = new Set<number>()
  /** 조합이 확정되기를 기다리고 있는 키 (확정되면 deliver로 프로그램에 전한다) */
  let held: { id: number; deliver(): void; timer: ReturnType<typeof setTimeout> | undefined } | undefined
  /** 칸마다 마지막으로 조합이 확정된 때 */
  const settled = new Map<number, number>()
  /** 조합 중에 이미 프로그램에 전한 키. 브라우저가 같은 키를 곧바로 한 번 더 알리면 그것은 버린다. */
  let echo: { key: string; at: number } | undefined
  /** 방금 Enter를 눌러 줄바꿈을 기다리는 칸들과, 그때 함께 누른 키 */
  const enters = new Map<number, number>()
  /** 칸마다 프로그램에 마지막으로 알린 커서의 화면 자리 */
  const points = new Map<number, [number, number]>()
  /** 칸마다 프로그램에 마지막으로 알린 커서 자리 */
  const carets = new Map<number, [number, number]>()
  let layer!: HTMLDivElement
  /** 입력 칸보다 위에 그리는 캔버스 */
  let top!: HTMLCanvasElement
  const regions: HTMLDivElement[] = []
  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && dark.matches)
  const send = (kind: number, a = 0, b = 0, c = 0) => gui.send(pid, encodeEvent(kind, a, b, c))
  const point = (kind: number, [x, y]: readonly [number, number], c = 0) => gui.send(pid, encodePointer(kind, x, y, c))

  function redraw() {
    if (size.w === 0) return
    const scale = window.devicePixelRatio || 1
    // overlay 명령의 앞은 아래 캔버스에, 뒤는 입력 칸 위의 캔버스에 그린다.
    const split = ops.findIndex((op) => op.op === 'overlay')
    const layers = [
      [canvas, split < 0 ? ops : ops.slice(0, split)],
      [top, split < 0 ? [] : ops.slice(split + 1)],
    ] as const
    for (const [target, list] of layers) {
      const ctx = target.getContext('2d')
      if (!ctx) continue
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      if (target === top) ctx.clearRect(0, 0, size.w, size.h)
      paint(ctx, list, size.w, size.h, fontFamilies(), (path) => gui.image(pid, path))
    }
    // 위층에 그린 것이 있을 때만 위층이 입력을 받는다 (없으면 아래의 입력 칸을 누를 수 있어야 한다).
    top.style.pointerEvents = split < 0 ? 'none' : 'auto'
  }

  /** 창의 크기에 캔버스를 맞추고 프로그램에 알린다. */
  function fit() {
    const [w, h] = [canvas.clientWidth, canvas.clientHeight]
    if (w === 0 || h === 0) return
    const scale = window.devicePixelRatio || 1
    size = { w, h }
    // 화면 배율만큼 촘촘하게 그려서 고해상도 화면에서도 선명하게 한다. 프로그램이 보는 좌표는 그대로다.
    for (const target of [canvas, top]) {
      target.width = Math.round(w * scale)
      target.height = Math.round(h * scale)
    }
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
  function key(e: KeyboardEvent, field?: FieldElement, id?: number) {
    // 글자를 조합하는 중(한글의 마지막 글자 등)에는 브라우저가 키의 이름을 숨기기도 한다. 그때는 자판의 자리로 알아낸다.
    const composing = e.isComposing || e.keyCode === 229
    const name = e.key === 'Process' || e.key === 'Unidentified' ? e.code.replace(/^Numpad/, '') : e.key
    const code = keyCode(name)
    if (code === undefined) return
    // 조합을 확정하면서 이미 전한 키가 곧바로 한 번 더 올 수 있다 (브라우저에 따라). 두 번 전하지 않는다.
    if (!composing && echo && echo.key === name && e.timeStamp - echo.at < 200) {
      echo = undefined
      return e.preventDefault()
    }
    const command = e.ctrlKey || e.metaKey
    if (field && id !== undefined) {
      const op = fieldOps.get(id)
      const single = field instanceof HTMLInputElement
      const grabbed = !single && op?.keys === true && op.grabEnter && ['Enter', 'ArrowUp', 'ArrowDown'].includes(name)
      const asked = grabbed || (!single && op?.keys === true && (name === 'Tab' || name === 'Enter'))
      // 줄바꿈도 하고 프로그램에도 알리는 Enter (프로그램이 막아 달라고 한 때는 빼고)
      const alongside = !command && asked && name === 'Enter' && !op?.grabEnter
      if (composing) {
        // 조합 중의 글자 키는 입력기의 것이다. 칸 대신 프로그램이 받는 키만 따로 다룬다.
        const taken = !command && !alongside && (asked || (single && ['Enter', 'ArrowUp', 'ArrowDown'].includes(name)))
        if (alongside) enters.set(id, modsOf(e))
        if (!taken) return
        // 이 키를 받은 입력기는 곧 조합하던 글자를 확정한다. 그것을 기다렸다가, 확정된 글과 커서 자리를 알린 다음에 키를 전한다.
        // (여기서 조합을 억지로 끝내면 안 된다: 입력기가 제 차례에 같은 글자를 한 번 더 넣는다.)
        e.preventDefault()
        echo = { key: name, at: e.timeStamp }
        const deliver = () => {
          if (held?.deliver !== deliver) return
          clearTimeout(held.timer)
          held = undefined
          if (!field.isConnected) return
          if (texts.get(id) !== field.value) {
            texts.set(id, field.value)
            gui.setText(pid, id, field.value)
            paintLayer(id)
          }
          echo = { key: name, at: performance.now() }
          reportCaret(id, field)
          send(GuiEvent.key, code, modsOf(e))
        }
        held?.deliver()
        // 어떤 브라우저는 확정을 먼저 알리고 키를 나중에 알린다. 방금 확정됐으면 기다릴 것이 없다.
        if (e.timeStamp - (settled.get(id) ?? -1e9) < 60) {
          held = { id, deliver, timer: undefined }
          return deliver()
        }
        // 확정 알림이 오지 않는 경우에도 키가 사라지지는 않게, 잠깐만 기다린다.
        held = { id, deliver, timer: setTimeout(deliver, 150) }
        return
      }
      // 키를 받는 프로그램이 그 순간의 커서 자리를 알고 있도록, 달라졌으면 먼저 알린다.
      reportCaret(id, field)
      if (!command) {
        const free = name === 'Escape' || (single && ['Enter', 'ArrowUp', 'ArrowDown'].includes(name)) || asked
        if (!free) return
        // 알리는 것은 줄바꿈이 글에 들어간 뒤다 (아래 input에서). 그래야 프로그램이 본 글과 순서가 어긋나지 않는다.
        if (alongside) return void enters.set(id, modsOf(e))
      }
    } else if (composing) return
    if (!isBrowserKey(e) && !(field && command && isEditingKey(e))) e.preventDefault()
    send(GuiEvent.key, code, modsOf(e))
  }

  /** 입력 칸의 커서 자리(또는 고른 범위)가 지난번에 알린 것과 다르면 프로그램에 알린다. 자리는 UTF-8 바이트 위치다. */
  function reportCaret(id: number, el: FieldElement) {
    if (document.activeElement !== el) return
    const [from, to] = [el.selectionStart ?? 0, el.selectionEnd ?? 0]
    const bytes = (index: number) => new TextEncoder().encode(el.value.slice(0, index)).length
    const start = bytes(from)
    const end = to === from ? start : bytes(to)
    const last = carets.get(id)
    if (last && last[0] === start && last[1] === end) return
    carets.set(id, [start, end])
    send(GuiEvent.caret, id, start, end)
    reportCaretPoint(id, el)
  }

  /** 프로그램이 물었으면(where), 커서가 창의 어디에 있는지 알린다. */
  function reportCaretPoint(id: number, el: FieldElement) {
    if (!fieldOps.get(id)?.where || document.activeElement !== el) return points.delete(id)
    // 입력 칸은 커서의 자리를 알려 주지 않는다. 같은 모양의 보이지 않는 글 상자에 커서 앞까지의 글을 넣어 그 끝을 잰다.
    const style = getComputedStyle(el)
    const mirror = document.createElement('div')
    Object.assign(mirror.style, {
      position: 'absolute', left: '0', top: '0', visibility: 'hidden', boxSizing: 'border-box',
      width: `${el.clientWidth}px`, font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
      tabSize: style.tabSize, whiteSpace: el instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre', overflowWrap: 'break-word',
    })
    mirror.textContent = el.value.slice(0, el.selectionStart ?? 0)
    const mark = document.createElement('span')
    mark.textContent = '\u200b'
    mirror.append(mark)
    host.append(mirror)
    const x = Math.round(el.offsetLeft + mark.offsetLeft - el.scrollLeft)
    const y = Math.round(el.offsetTop + mark.offsetTop + mark.offsetHeight - el.scrollTop)
    mirror.remove()
    const last = points.get(id)
    if (last && last[0] === x && last[1] === y) return
    points.set(id, [x, y])
    send(GuiEvent.caretAt, id, x, y)
  }

  function makeField(op: FieldOp): FieldElement {
    const el = op.multiline ? document.createElement('textarea') : document.createElement('input')
    el.className = 'surface-field'
    el.spellcheck = false
    el.value = texts.get(op.id) ?? ''
    el.addEventListener('input', (e) => {
      texts.set(op.id, el.value)
      gui.setText(pid, op.id, el.value)
      // 프로그램이 새 색을 보내기 전에도 방금 친 글자가 보이도록, 지금의 색으로 먼저 다시 그린다.
      paintLayer(op.id)
      reportCaret(op.id, el)
      // 방금 친 Enter로 줄이 바뀌었다: 이제 프로그램에 그 Enter를 알린다.
      // (조합 중에 누른 Enter는 조합이 확정되는 입력이 먼저 온다. 줄이 바뀐 입력이 올 때까지 기다린다.)
      const mods = enters.get(op.id)
      const type = (e as InputEvent).inputType
      if (mods !== undefined && (type === 'insertLineBreak' || type === 'insertParagraph' || broke.has(op.id))) {
        enters.delete(op.id)
        send(GuiEvent.key, keyCode('Enter')!, mods)
      }
      broke.delete(op.id)
    })
    // 조합을 확정하며 프로그램에 넘긴 Enter가 줄까지 바꾸지는 않게 한다.
    el.addEventListener('beforeinput', (e) => {
      const type = (e as InputEvent).inputType
      if (type !== 'insertLineBreak' && type !== 'insertParagraph') return
      if (echo?.key === 'Enter' && e.timeStamp - echo.at < 200) e.preventDefault()
      // 조합을 확정하며 줄이 바뀔 때는, 뒤따르는 입력이 "줄바꿈"이 아니라 "조합한 글"이라고만 알려지기도 한다. 여기서 봐 둔다.
      else broke.add(op.id)
    })
    el.addEventListener('keyup', (e) => (e as KeyboardEvent).key === 'Enter' && enters.delete(op.id))
    // 커서만 옮긴 것(방향키, 누르기, 끌어서 고르기)도 알린다. 브라우저마다 알려 주는 이벤트가 달라 여럿을 듣는다.
    for (const type of ['keyup', 'pointerup', 'select', 'selectionchange', 'focus']) el.addEventListener(type, () => reportCaret(op.id, el))
    el.addEventListener('focus', () => {
      lastField = op.id
      send(GuiEvent.fieldFocus, op.id, 1)
    })
    el.addEventListener('blur', () => {
      // 창이 뒤로 간 것은 focus 이벤트로 따로 알린다. 여기서는 창 안에서 다른 곳으로 옮긴 것만 알린다.
      if (document.hasFocus() && props.focused()) send(GuiEvent.fieldFocus, op.id, 0)
    })
    el.addEventListener('compositionend', (e) => {
      settled.set(op.id, e.timeStamp)
      // 확정된 글자가 글에 들어간 뒤에(뒤따르는 input 다음에) 기다리던 키를 전한다.
      if (held?.id === op.id) setTimeout(held.deliver, 0)
    })
    el.addEventListener('keydown', (e) => key(e as KeyboardEvent, el, op.id))
    host.append(el)
    return el
  }

  /**
   * 색을 입힌 칸의 글을 다시 그린다. 입력 칸의 글자는 투명하게 두고(커서와 선택만 보인다),
   * 같은 자리에 겹쳐 놓은 층에 같은 글을 색을 입혀 보여 준다.
   */
  function paintLayer(id: number) {
    const [el, ranges, op] = [fields.get(id), styles.get(id), fieldOps.get(id)]
    let layer = layers.get(id)
    if (!el || !op || !ranges?.length) {
      layer?.remove()
      layers.delete(id)
      el?.classList.remove('styled')
      if (el && op) Object.assign(el.style, { color: op.color, background: op.background, caretColor: '' })
      return
    }
    if (!layer) {
      layers.set(id, (layer = document.createElement('div')))
      layer.className = 'surface-field surface-field-layer'
      layer.setAttribute('aria-hidden', 'true')
      el.before(layer)
      el.addEventListener('scroll', () => {
        const own = layers.get(id)
        if (own) [own.scrollTop, own.scrollLeft] = [el.scrollTop, el.scrollLeft]
      })
    }
    el.classList.add('styled')
    Object.assign(el.style, { color: 'transparent', background: 'transparent', caretColor: op.color })
    Object.assign(layer.style, {
      left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height,
      fontSize: el.style.fontSize, fontFamily: el.style.fontFamily, fontWeight: el.style.fontWeight,
      color: op.color, background: op.background,
    })
    const nodes = styledPieces(el.value, ranges).map((piece) => {
      if (!piece.color) return document.createTextNode(piece.text)
      const span = document.createElement('span')
      span.textContent = piece.text
      span.style.color = piece.color
      if (piece.bold) span.style.fontWeight = '600'
      return span
    })
    // 글이 줄바꿈으로 끝나면 입력 칸에는 빈 줄이 하나 더 보인다. 층에도 그 줄이 있어야 높이가 맞는다.
    layer.replaceChildren(...nodes, document.createTextNode('\n'))
    ;[layer.scrollTop, layer.scrollLeft] = [el.scrollTop, el.scrollLeft]
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
        // 이 요소 위에서의 입력은 그림 위에서의 입력과 똑같이 프로그램에 전한다.
        const own = el
        let pressedAt = -1e9
        own.addEventListener('pointerdown', (e) => {
          pressedAt = e.timeStamp
          pointer.onPointerDown(e)
        })
        own.addEventListener('pointermove', pointer.onPointerMove)
        own.addEventListener('pointerup', pointer.onPointerUp)
        own.addEventListener('pointercancel', pointer.onPointerCancel)
        own.addEventListener('pointerleave', pointer.onPointerLeave)
        own.addEventListener('wheel', pointer.onWheel, { passive: true })
        own.addEventListener('contextmenu', pointer.onContextMenu)
        // 화면 낭독기의 "누르기"는 포인터 없이 click만 온다. 그때는 그 자리를 누른 것으로 전한다.
        own.addEventListener('click', (e) => {
          if (e.timeStamp - pressedAt < 1000) return
          const [x, y] = [Number(own.dataset.x), Number(own.dataset.y)]
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
      // 글로도 넣어 둔다 (보이지는 않는다). 이름표를 읽지 않는 도구도 이 자리의 글을 읽을 수 있다.
      if (el.textContent !== op.label) el.textContent = op.label
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
    // 프로그램이 정한 자리이므로 프로그램은 이미 안다. 다시 알리지 않는다.
    carets.set(op.id, [op.start, op.end])
    if (el instanceof HTMLTextAreaElement) {
      // 긴 줄이 여러 줄로 접히면 줄 번호만으로는 높이를 알 수 없어, 전체 높이의 비율로 어림한다.
      const line = el.value.slice(0, start).split('\n').length - 1
      el.scrollTop = Math.max(0, (line / el.value.split('\n').length) * el.scrollHeight - 30)
    }
  }

  // ───────────── 바깥 플레이어 (유튜브) ─────────────
  //
  // 이 페이지는 다른 출처의 것을 막아 둔 상태라(SharedArrayBuffer를 쓰려면 그래야 한다), 보통의 iframe으로는 유튜브가 뜨지 않는다.
  // 쿠키 없이 여는 iframe(credentialless)은 허용된다. 플레이어와는 유튜브의 IFrame API가 쓰는 메시지 형식으로 이야기한다.

  const YOUTUBE = 'https://www.youtube.com'
  let frame: HTMLIFrameElement | undefined
  /** 플레이어가 준비됐다고 알려 왔는가. 그 전에 시킨 일은 모아 두었다가 준비되면 보낸다. */
  let playerReady = false
  let queued: { func: string; args: unknown[] }[] = []
  let hello: ReturnType<typeof setInterval> | undefined
  /** 프로그램에 마지막으로 알린 상태와 위치 (같은 것을 거듭 알리지 않는다) */
  let told = { state: -2, time: -1, duration: -1 }
  let playerState = -1

  const tell = (func: string, ...args: unknown[]) => {
    if (playerReady) frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), YOUTUBE)
    else queued.push({ func, args })
  }

  function onPlayerMessage(e: MessageEvent) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== YOUTUBE || typeof e.data !== 'string') return
    let message: { event?: string; info?: unknown }
    try {
      message = JSON.parse(e.data)
    } catch {
      return
    }
    if (message.event === 'onReady') {
      playerReady = true
      clearInterval(hello)
      for (const { func, args } of queued.splice(0)) tell(func, ...args)
    } else if (message.event === 'onError') {
      send(GuiEvent.playerError, Number(message.info) || 0)
    } else if (message.event === 'infoDelivery' && message.info && typeof message.info === 'object') {
      const info = message.info as { playerState?: number; currentTime?: number; duration?: number }
      if (typeof info.playerState === 'number') playerState = info.playerState
      const time = typeof info.currentTime === 'number' ? Math.round(info.currentTime * 1000) : told.time
      const duration = typeof info.duration === 'number' && info.duration > 0 ? Math.round(info.duration * 1000) : told.duration
      // 상태가 바뀌면 바로, 위치는 0.5초쯤 나아갔을 때마다 알린다.
      if (playerState === told.state && duration === told.duration && Math.abs(time - told.time) < 450) return
      told = { state: playerState, time, duration }
      send(GuiEvent.player, playerState, Math.max(0, time), Math.max(0, duration))
    }
  }

  /** 그리기 명령에 든 플레이어의 자리에 맞춰 요소를 놓고, 시킨 일을 전한다. */
  function placePlayer() {
    const place = ops.find((op): op is Extract<DrawOp, { op: 'player' }> => op.op === 'player')
    if (!place) {
      frame?.remove()
      frame = undefined
      clearInterval(hello)
      return
    }
    for (const op of ops) {
      if (op.op !== 'playerCommand') continue
      if (!('credentialless' in HTMLIFrameElement.prototype)) {
        // 이 브라우저는 플레이어를 놓을 방법이 없다. 프로그램이 다른 길(유튜브에서 열기)을 안내하게 한다.
        if (op.command === PlayerCommand.load) send(GuiEvent.playerError, PLAYER_UNSUPPORTED)
        continue
      }
      if (op.command === PlayerCommand.load) {
        // 영상의 번호는 프로그램이 준 것이므로, 번호의 꼴이 아니면 받지 않는다.
        if (!/^[\w-]{6,20}$/.test(op.id)) continue
        if (!frame) {
          frame = document.createElement('iframe')
          frame.className = 'surface-player'
          frame.title = '영상 플레이어'
          frame.allow = 'autoplay; encrypted-media; picture-in-picture'
          ;(frame as HTMLIFrameElement & { credentialless: boolean }).credentialless = true
          const query = new URLSearchParams({ enablejsapi: '1', origin: location.origin, playsinline: '1', rel: '0', autoplay: op.value ? '1' : '0' })
          frame.src = `${YOUTUBE}/embed/${op.id}?${query}`
          playerReady = false
          queued = []
          told = { state: -2, time: -1, duration: -1 }
          const own = frame
          // 플레이어가 말을 걸어 주기를 기다린다는 것을, 답이 올 때까지 거듭 알린다.
          frame.addEventListener('load', () => {
            clearInterval(hello)
            hello = setInterval(() => own.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: pid, channel: 'widget' }), YOUTUBE), 250)
          })
          host.append(frame)
        } else {
          told = { state: -2, time: -1, duration: -1 }
          tell(op.value ? 'loadVideoById' : 'cueVideoById', op.id)
        }
      } else if (op.command === PlayerCommand.play) tell('playVideo')
      else if (op.command === PlayerCommand.pause) tell('pauseVideo')
      else if (op.command === PlayerCommand.seek) tell('seekTo', op.value, true)
      else if (op.command === PlayerCommand.volume) tell('setVolume', Math.max(0, Math.min(100, op.value)))
    }
    if (frame) Object.assign(frame.style, { left: `${place.x}px`, top: `${place.y}px`, width: `${place.w}px`, height: `${place.h}px` })
  }

  /**
   * 사용자가 건넨 파일들(고른 것, 끌어다 놓은 것, 붙여 넣은 것)을 프로그램이 읽을 수 있는 곳에 놓고 알린다.
   * 건넨 순서대로 "순번-이름"으로 놓는다.
   */
  async function handOver(files: File[]) {
    if (files.length === 0) return
    const fs = props.system.fs
    const dir = handoffDir(pid)
    let [placed, refused] = [0, 0]
    try {
      await fs.mkdir(dir).catch(() => {}) // 이미 있으면 그대로 쓴다
      for (const file of files) {
        if (file.size > HANDOFF_LIMIT) {
          refused++
          continue
        }
        // 이름에 든 /는 경로로 읽히지 않게 바꾼다.
        const name = (file.name || 'file').replace(/[\/\\]/g, '_')
        await fs.write(`${dir}/${String(handed++).padStart(4, '0')}-${name}`, new Uint8Array(await file.arrayBuffer()))
        placed++
      }
    } finally {
      send(GuiEvent.files, placed, refused)
    }
  }

  /** 프로그램이 파일을 골라 달라고 했다: 브라우저의 파일 고르기 창을 띄운다. */
  function pickFiles(op: Extract<DrawOp, { op: 'pick' }>) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = op.accept
    input.multiple = op.multiple
    input.addEventListener('change', () => void handOver([...(input.files ?? [])]))
    input.click()
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
    const split = ops.findIndex((op) => op.op === 'overlay')
    for (const [id, el] of fields) {
      if (wanted.some((op) => op.id === id && op.multiline === el instanceof HTMLTextAreaElement)) continue
      // 커서가 있던 칸이 사라지면 키 입력이 갈 곳이 없어지므로 그림으로 옮긴다.
      if (document.activeElement === el && props.focused()) canvas.focus({ preventScroll: true })
      el.remove()
      fields.delete(id)
      fieldOps.delete(id)
      carets.delete(id)
      points.delete(id)
      layers.get(id)?.remove()
      layers.delete(id)
    }
    for (const op of wanted) {
      let el = fields.get(op.id)
      if (!el) fields.set(op.id, (el = makeField(op)))
      fieldOps.set(op.id, op)
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
        // overlay 뒤에 놓은 칸은 위층보다도 위에 온다.
        zIndex: split >= 0 && ops.indexOf(op) > split ? '3' : '',
      })
      if (styles.has(op.id)) paintLayer(op.id)
      reportCaretPoint(op.id, el)
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
        placePlayer()
        for (const op of ops) if (op.op === 'select') moveCaret(op)
        const menu = ops.find((op): op is MenuOp => op.op === 'menu')
        if (menu) openMenu(menu)
        const pick = ops.find((op) => op.op === 'pick')
        if (pick?.op === 'pick') pickFiles(pick)
        for (const op of ops) {
          if (op.op === 'copy') void navigator.clipboard?.writeText(op.text).catch(() => {})
          // 이 페이지에 접근할 수 없는 새 탭으로만 연다. 프로그램이 준 주소라도 웹 주소가 아니면 열지 않는다.
          else if (op.op === 'open' && /^(https?:|mailto:)/i.test(op.url)) window.open(op.url, '_blank', 'noopener,noreferrer')
          else if (op.op === 'title') props.setTitle(op.text)
          // 어떤 앱으로 열지는 화면 쪽이 정한다. 지금은 모두 편집기다.
          else if (op.op === 'launch') props.launch('editor', { path: op.path })
        }
      },
      setText(field, text) {
        texts.set(field, text)
        const el = fields.get(field)
        // 같은 글이면 건드리지 않는다 (커서 위치와 조합 중인 글자가 날아가지 않게).
        if (el && el.value !== text) {
          el.value = text
          paintLayer(field)
          // 글을 통째로 바꾸면 커서가 끝으로 간다. 다음에 옮겨질 때 다시 알리도록 기억을 지운다.
          carets.delete(field)
        }
      },
      setStyles(field, data) {
        styles.set(field, decodeStyles(data))
        paintLayer(field)
      },
      closed: () => props.close(),
    })
    if (!detach) return props.close() // 창이 뜨기도 전에 프로세스가 끝났다
    window.addEventListener('message', onPlayerMessage)
    onCleanup(() => {
      window.removeEventListener('message', onPlayerMessage)
      clearInterval(hello)
    })
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

  /** 포인터 입력을 프로그램에 전한다. 아래 캔버스와 위층 캔버스가 같이 쓴다. */
  const pointer = {
    onPointerDown: (e: PointerEvent) => {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      // 위층(입력 칸을 덮는 목록 등)이 떠 있는 동안에는 눌러도 입력 칸의 커서를 그대로 둔다 (그 칸에 글을 치는 중이다).
      const typing = ops.some((op) => op.op === 'overlay') && [...fields.values()].includes(document.activeElement as FieldElement)
      if (typing || e.currentTarget === top) e.preventDefault()
      else {
        canvas.focus({ preventScroll: true })
        lastField = undefined
      }
      point(GuiEvent.pointerDown, at(e), e.button + 256 * (clicksAt(e) - 1))
    },
    onPointerMove: (e: PointerEvent) => {
      // 빠르게 움직이면 브라우저가 여러 위치를 한 번에 묶어 준다. 선이 각지지 않게 모두 전한다.
      for (const step of e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e]) point(GuiEvent.pointerMove, at(step), e.buttons)
    },
    onPointerUp: (e: PointerEvent) => point(GuiEvent.pointerUp, at(e)),
    onPointerCancel: (e: PointerEvent) => point(GuiEvent.pointerUp, at(e)),
    onPointerLeave: (e: PointerEvent) => {
      // 그림에서 그 위의 요소(단추·항목의 자리)로, 또는 그 반대로 옮겨 간 것은 나간 것이 아니다.
      const to = e.relatedTarget
      if (to instanceof Element && host.contains(to) && to.matches('.surface, .surface-region')) return
      send(GuiEvent.pointerLeave)
    },
    onWheel: (e: WheelEvent) => {
      // 줄 단위로 알려 주는 마우스는 한 줄을 대략의 픽셀로 바꾼다.
      const dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 30 : e.deltaY
      if (dy) point(GuiEvent.wheel, at(e), dy)
    },
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
  }

  return (
    <div
      class="surface-host"
      ref={host}
      data-pid={pid}
      // 파일을 창에 끌어다 놓거나 붙여 넣으면 프로그램에 건넨다. (글을 붙여 넣는 것은 입력 칸이 그대로 받는다.)
      onDragOver={(e) => e.dataTransfer?.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        const files = [...(e.dataTransfer?.files ?? [])]
        if (files.length === 0) return
        e.preventDefault()
        void handOver(files)
      }}
      onPaste={(e) => {
        const files = [...(e.clipboardData?.files ?? [])]
        if (files.length === 0) return
        e.preventDefault()
        void handOver(files)
      }}
    >
      <canvas
        class="surface"
        ref={canvas}
        tabindex="0"
        role="application"
        aria-label={props.args.title}
        {...pointer}
        onKeyDown={(e) => key(e)}
      />
      <canvas class="surface surface-top" ref={top} aria-hidden="true" {...pointer} />
      <div class="surface-regions" ref={layer} />
    </div>
  )
}
