// 2단계 화면: 터미널 하나와 프로세스 목록.
// 창 관리자와 디자인 시스템은 3단계에서 이 화면을 대체한다.
import { For, onCleanup, onMount } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { KernelCommand, KernelEvent } from '../kernel/abi.ts'
import { Terminal, type TerminalHandle } from './terminal/Terminal.tsx'

type Proc = { pid: number; ppid: number; name: string }

const DIM = '\x1b[90m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

export function App() {
  const [procs, setProcs] = createStore<Proc[]>([])
  let term!: TerminalHandle
  let kernel: Worker | undefined
  let ready = false
  /** 현재 열려 있는 터미널 장치. 0이면 셸이 끝난 상태다. */
  let tty = 0
  let size = { cols: 80, rows: 24 }

  const send = (cmd: KernelCommand) => kernel?.postMessage(cmd)

  function onEvent(ev: KernelEvent) {
    switch (ev.type) {
      case 'klog':
        term.writeText(`${DIM}[${(ev.time / 1000).toFixed(3).padStart(8)}] ${ev.msg}${RESET}\r\n`)
        break
      case 'ready':
        ready = true
        term.writeText('\r\n')
        send({ type: 'tty-open', ...size })
        break
      case 'tty-open':
        tty = ev.tty
        break
      case 'tty-output':
        if (ev.tty === tty) term.write(ev.data)
        break
      case 'tty-close':
        if (ev.tty !== tty) break
        tty = 0
        term.writeText(`\r\n${DIM}[세션이 끝났습니다. 아무 키나 누르면 새 셸을 시작합니다]${RESET}\r\n`)
        break
      case 'spawn':
        setProcs(produce((p) => p.push({ pid: ev.pid, ppid: ev.ppid, name: ev.argv.join(' ') })))
        break
      case 'exit':
        setProcs((p) => p.filter((x) => x.pid !== ev.pid))
        break
      case 'error':
        term.writeText(`${RED}${ev.msg}${RESET}\r\n`)
        break
    }
  }

  function onInput(text: string) {
    if (tty) send({ type: 'tty-input', tty, text })
    else if (ready) send({ type: 'tty-open', ...size })
  }

  function onResize(cols: number, rows: number) {
    size = { cols, rows }
    if (tty) send({ type: 'tty-resize', tty, cols, rows })
  }

  onMount(() => {
    if (!crossOriginIsolated) {
      term.writeText(
        `${RED}이 페이지는 교차 출처 격리 상태가 아니라서 블로킹 시스템 콜을 쓸 수 없습니다. COOP/COEP 헤더를 확인하세요.${RESET}\r\n`,
      )
    }
    kernel = new Worker(new URL('../kernel/kernel.worker.ts', import.meta.url), { type: 'module', name: 'kernel' })
    kernel.onmessage = (e: MessageEvent<KernelEvent>) => onEvent(e.data)
    kernel.onerror = (e) => term.writeText(`${RED}kernel crashed: ${e.message}${RESET}\r\n`)
    term.focus()
    onCleanup(() => kernel?.terminate())
  })

  return (
    <main>
      <header>
        <h1>Web OS</h1>
        <span class="phase">2단계 · 터미널과 셸</span>
      </header>

      <Terminal ref={(h) => (term = h)} onInput={onInput} onResize={onResize} />

      <section class="procs" data-testid="procs">
        <h2>프로세스 {procs.length}개</h2>
        <For each={procs} fallback={<p class="empty">실행 중인 프로세스가 없습니다.</p>}>
          {(p) => (
            <div class="proc">
              <span class="pid">{p.pid}</span>
              <span class="name">{p.name}</span>
              <button onClick={() => send({ type: 'kill', pid: p.pid })}>kill</button>
            </div>
          )}
        </For>
      </section>
    </main>
  )
}
