// 화면 쪽에서 커널을 다루는 창구. 커널 Worker를 띄우고, 이벤트를 화면이 구독할 수 있는
// 상태(프로세스 목록, 로그)와 터미널 세션으로 바꿔 준다.
import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { KernelCommand, KernelEvent } from '../kernel/abi.ts'

export interface Proc {
  pid: number
  ppid: number
  name: string
}

export interface LogLine {
  time: number
  msg: string
  error?: boolean
}

export interface TerminalSession {
  input(text: string): void
  resize(cols: number, rows: number): void
  /** 터미널을 닫는다. 셸과 그 아래 프로세스가 모두 끝난다. */
  close(): void
}

interface SessionState {
  tty: number
  size: { cols: number; rows: number }
  output(data: Uint8Array): void
  closed(): void
}

export function createSystem() {
  const [procs, setProcs] = createStore<Proc[]>([])
  const [logs, setLogs] = createStore<LogLine[]>([])
  const [ready, setReady] = createSignal(false)
  /** 요청 번호 → 아직 커널의 응답을 기다리는 세션 */
  const opening = new Map<number, SessionState>()
  const sessions = new Map<number, SessionState>()
  let nextRef = 1

  const kernel = new Worker(new URL('../kernel/kernel.worker.ts', import.meta.url), { type: 'module', name: 'kernel' })
  const send = (cmd: KernelCommand) => kernel.postMessage(cmd)
  const log = (line: LogLine) => setLogs(produce((l) => l.push(line)))

  kernel.onerror = (e) => log({ time: performance.now(), msg: `kernel crashed: ${e.message}`, error: true })
  kernel.onmessage = (e: MessageEvent<KernelEvent>) => {
    const ev = e.data
    switch (ev.type) {
      case 'klog':
        return log({ time: ev.time, msg: ev.msg })
      case 'error':
        return log({ time: performance.now(), msg: ev.msg, error: true })
      case 'ready':
        return setReady(true)
      case 'spawn':
        return setProcs(produce((p) => p.push({ pid: ev.pid, ppid: ev.ppid, name: ev.argv.join(' ') })))
      case 'exit':
        return setProcs((p) => p.filter((x) => x.pid !== ev.pid))
      case 'tty-open': {
        const session = opening.get(ev.ref)
        if (!session) return send({ type: 'tty-close', tty: ev.tty }) // 응답이 오기 전에 창이 닫혔다
        opening.delete(ev.ref)
        session.tty = ev.tty
        sessions.set(ev.tty, session)
        // 요청을 보낸 뒤에 창 크기가 바뀌었을 수 있다.
        return send({ type: 'tty-resize', tty: ev.tty, ...session.size })
      }
      case 'tty-output':
        return sessions.get(ev.tty)?.output(ev.data)
      case 'tty-close': {
        const session = sessions.get(ev.tty)
        sessions.delete(ev.tty)
        return session?.closed()
      }
    }
  }

  return {
    procs,
    logs,
    ready,
    kill: (pid: number) => send({ type: 'kill', pid }),

    /** 새 터미널 장치를 만들고 셸을 띄운다. */
    openTerminal(
      cols: number,
      rows: number,
      handlers: { output(data: Uint8Array): void; closed(): void },
    ): TerminalSession {
      const ref = nextRef++
      const session: SessionState = { tty: 0, size: { cols, rows }, ...handlers }
      opening.set(ref, session)
      send({ type: 'tty-open', ref, cols, rows })
      return {
        input(text) {
          if (session.tty) send({ type: 'tty-input', tty: session.tty, text })
        },
        resize(cols, rows) {
          session.size = { cols, rows }
          if (session.tty) send({ type: 'tty-resize', tty: session.tty, cols, rows })
        },
        close() {
          opening.delete(ref)
          if (session.tty) send({ type: 'tty-close', tty: session.tty })
        },
      }
    },

    shutdown: () => kernel.terminate(),
  }
}

export type System = ReturnType<typeof createSystem>
