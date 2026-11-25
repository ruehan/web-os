// 터미널 화면. 에뮬레이터의 글자 격자를 DOM으로 그리고, 키보드 입력을 바이트 시퀀스로 바꿔 내보낸다.
import { onCleanup, onMount } from 'solid-js'
import { Emulator, type Cell, type Line } from './emulator.ts'

export interface TerminalHandle {
  /** 프로그램 출력 (UTF-8 바이트) */
  write(data: Uint8Array): void
  writeText(text: string): void
  focus(): void
}

const KEYS: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Delete: '\x1b[3~',
}

const BLANK: Cell = { ch: ' ', width: 1, fg: -1, bg: -1, bold: false }
const isPlain = (c: Cell) => c.ch === ' ' && c.bg === -1

export function Terminal(props: {
  onInput: (text: string) => void
  /** 화면에 들어가는 글자 수가 바뀌었다 */
  onResize?: (cols: number, rows: number) => void
  ref?: (handle: TerminalHandle) => void
}) {
  let root!: HTMLDivElement
  let screen!: HTMLDivElement
  let input!: HTMLTextAreaElement
  let probe!: HTMLSpanElement

  const emu = new Emulator(80, 24)
  const decoder = new TextDecoder()
  const rows = new WeakMap<Line, HTMLDivElement>()
  let cursorRow: Line | undefined
  let cell = { w: 8, h: 18 }
  let frame = 0
  let composing = false
  let followOutput = true

  const schedule = () => {
    frame ||= requestAnimationFrame(render)
  }

  function render() {
    frame = 0
    for (const line of emu.removed) {
      rows.get(line)?.remove()
      rows.delete(line)
    }
    emu.removed.length = 0

    // 커서가 떠난 줄과 새로 도착한 줄은 내용이 그대로여도 다시 그려야 한다.
    const current = emu.cursorLine
    if (cursorRow && rows.has(cursorRow)) emu.dirty.add(cursorRow)
    emu.dirty.add(current)
    cursorRow = current

    for (const line of emu.dirty) {
      let el = rows.get(line)
      if (!el) {
        el = document.createElement('div')
        el.className = 'line'
        rows.set(line, el)
        screen.appendChild(el)
      }
      drawLine(el, line, line === current && emu.cursorVisible ? emu.cx : -1)
    }
    emu.dirty.clear()

    // 입력창을 커서 위치에 둬야 한글 조합 창이 제자리에 뜬다.
    const el = rows.get(current)!
    input.style.top = `${el.offsetTop}px`
    input.style.left = `${emu.cx * cell.w}px`
    if (followOutput) root.scrollTop = root.scrollHeight
  }

  function drawLine(el: HTMLDivElement, line: Line, cursor: number) {
    el.textContent = ''
    const cells = line.cells
    let end = cells.length
    while (end > 0 && isPlain(cells[end - 1]!)) end--
    end = Math.max(end, cursor + 1)

    let run: HTMLSpanElement | undefined
    let runStyle = ''
    for (let i = 0; i < end; i++) {
      const c = cells[i] ?? BLANK
      if (c.width === 0) continue
      const atCursor = i === cursor || (c.width === 2 && i + 1 === cursor)
      const style =
        (c.fg >= 0 ? `color:var(--t${c.fg});` : '') +
        (c.bg >= 0 ? `background:var(--t${c.bg});` : '') +
        (c.bold ? 'font-weight:650;' : '')
      // 2칸 글자와 커서는 폭을 고정해야 하므로 각자 요소를 갖고, 나머지는 같은 스타일끼리 묶는다.
      if (c.width === 2 || atCursor || !run || style !== runStyle) {
        run = document.createElement('span')
        if (style) run.style.cssText = style
        if (c.width === 2) run.classList.add('wide')
        if (atCursor) run.classList.add('cursor')
        el.appendChild(run)
        runStyle = style
      }
      run.textContent += c.ch
      if (c.width === 2 || atCursor) run = undefined
    }
  }

  function fit() {
    const box = probe.getBoundingClientRect()
    if (!box.width) return
    cell = { w: box.width / 10, h: box.height }
    const style = getComputedStyle(root)
    const width = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const height = root.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    const cols = Math.max(20, Math.floor(width / cell.w))
    const rows = Math.max(4, Math.floor(height / cell.h))
    if (cols !== emu.cols || rows !== emu.rows) {
      emu.resize(cols, rows)
      props.onResize?.(cols, rows)
    }
    schedule()
  }

  const send = (text: string) => {
    followOutput = true
    props.onInput(text)
    schedule()
  }

  function onKeyDown(e: KeyboardEvent) {
    // 한글 등 조합 중인 키는 조합이 끝난 뒤 한꺼번에 받는다.
    if (e.isComposing || e.keyCode === 229) return
    let seq: string | undefined
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      const code = e.key.toUpperCase().charCodeAt(0)
      // Ctrl+V는 붙여넣기로 남겨 둔다.
      if (code >= 64 && code <= 95 && e.key.toLowerCase() !== 'v') seq = String.fromCharCode(code - 64)
    } else if (!e.metaKey && !e.ctrlKey) {
      seq = KEYS[e.key]
    }
    if (seq === undefined) return
    e.preventDefault()
    send(seq)
  }

  /** 입력창에 쌓인 글자(일반 입력, 붙여넣기, 조합이 끝난 글자)를 꺼내 보낸다. */
  function flushInput() {
    const text = input.value
    input.value = ''
    if (text) send(text.replace(/\r?\n/g, '\r'))
  }

  // 부모의 onMount가 이 컴포넌트의 onMount보다 먼저 실행되므로, 핸들은 생성 시점에 바로 넘긴다.
  props.ref?.({
    write(data) {
      emu.write(decoder.decode(data, { stream: true }))
      schedule()
    },
    writeText(text) {
      emu.write(text)
      schedule()
    },
    focus: () => input.focus({ preventScroll: true }),
  })

  onMount(() => {
    const observer = new ResizeObserver(fit)
    observer.observe(root)
    fit()
    onCleanup(() => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    })
  })

  return (
    <div
      class="terminal"
      ref={root}
      onScroll={() => (followOutput = root.scrollHeight - root.scrollTop - root.clientHeight < cell.h)}
      // 드래그로 글자를 선택한 경우에는 선택을 유지하고, 그냥 클릭했을 때만 입력을 받는다.
      onMouseUp={() => getSelection()?.isCollapsed && input.focus({ preventScroll: true })}
    >
      <div class="screen" ref={screen}>
        <span class="probe" ref={probe} aria-hidden="true">
          0123456789
        </span>
        <textarea
          ref={input}
          aria-label="터미널 입력"
          autocapitalize="off"
          autocomplete="off"
          spellcheck={false}
          rows="1"
          onKeyDown={onKeyDown}
          onInput={() => composing || flushInput()}
          onCompositionStart={() => {
            composing = true
            input.classList.add('composing')
          }}
          onCompositionEnd={() => {
            composing = false
            input.classList.remove('composing')
            flushInput()
          }}
          onFocus={() => root.classList.add('focused')}
          onBlur={() => root.classList.remove('focused')}
        />
      </div>
    </div>
  )
}
