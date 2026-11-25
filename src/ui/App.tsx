// 1단계용 임시 화면: 커널 로그와 프로세스 출력을 보여 주는 시리얼 콘솔.
// 창 관리자와 디자인 시스템은 3단계에서 이 화면을 대체한다.
import { For, Show, createSignal, onCleanup } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { KernelCommand, KernelEvent } from '../kernel/abi'

type Line = { kind: 'klog' | 'out' | 'err' | 'sys'; text: string }
type Proc = { pid: number; name: string }

const PROGRAMS: { label: string; path: string; argv: string[] }[] = [
  { label: 'hello', path: '/bin/hello', argv: ['hello', 'world'] },
  { label: 'fsdemo', path: '/bin/fsdemo', argv: ['fsdemo'] },
  { label: 'exitcode 42', path: '/bin/exitcode', argv: ['exitcode', '42'] },
  { label: 'spin', path: '/bin/spin', argv: ['spin'] },
]

export function App() {
  const [lines, setLines] = createStore<Line[]>([])
  const [procs, setProcs] = createStore<Proc[]>([])
  const [ready, setReady] = createSignal(false)
  const streams = new Map<string, { decoder: TextDecoder; partial: string }>()
  let logEl!: HTMLDivElement

  const push = (kind: Line['kind'], text: string) => {
    setLines(produce((l) => l.push({ kind, text })))
    queueMicrotask(() => (logEl.scrollTop = logEl.scrollHeight))
  }

  const kernel = new Worker(new URL('../kernel/kernel.worker.ts', import.meta.url), {
    type: 'module',
    name: 'kernel',
  })
  const send = (cmd: KernelCommand) => kernel.postMessage(cmd)
  onCleanup(() => kernel.terminate())

  kernel.onmessage = (e: MessageEvent<KernelEvent>) => {
    const ev = e.data
    switch (ev.type) {
      case 'klog':
        push('klog', `[${(ev.time / 1000).toFixed(3).padStart(8)}] ${ev.msg}`)
        break
      case 'ready':
        setReady(true)
        break
      case 'spawn':
        setProcs(produce((p) => p.push({ pid: ev.pid, name: ev.argv.join(' ') })))
        push('sys', `[${ev.pid}] started: ${ev.argv.join(' ')}`)
        break
      case 'tty': {
        // 프로그램은 한 줄을 여러 번의 write로 나눠 보낼 수 있으므로 줄 단위로 모아서 보여 준다.
        const key = `${ev.pid}:${ev.fd}`
        let stream = streams.get(key)
        if (!stream) streams.set(key, (stream = { decoder: new TextDecoder(), partial: '' }))
        const parts = (stream.partial + stream.decoder.decode(ev.data, { stream: true })).split('\n')
        stream.partial = parts.pop()!
        for (const line of parts) push(ev.fd === 2 ? 'err' : 'out', line)
        break
      }
      case 'exit':
        for (const fd of [1, 2]) {
          const stream = streams.get(`${ev.pid}:${fd}`)
          if (stream?.partial) push(fd === 2 ? 'err' : 'out', stream.partial)
          streams.delete(`${ev.pid}:${fd}`)
        }
        setProcs((p) => p.filter((x) => x.pid !== ev.pid))
        push('sys', `[${ev.pid}] exited with code ${ev.code}`)
        break
      case 'error':
        push('err', ev.msg)
        break
    }
  }
  kernel.onerror = (e) => push('err', `kernel crashed: ${e.message}`)

  return (
    <main>
      <header>
        <h1>Web OS</h1>
        <span class="phase">1단계 · 커널 뼈대</span>
      </header>

      <Show when={!crossOriginIsolated}>
        <p class="warn">
          이 페이지는 교차 출처 격리 상태가 아니라서 블로킹 시스템 콜을 쓸 수 없습니다. COOP/COEP 헤더를 확인하세요.
        </p>
      </Show>

      <section class="bar">
        <For each={PROGRAMS}>
          {(p) => (
            <button disabled={!ready()} onClick={() => send({ type: 'spawn', path: p.path, argv: p.argv, env: { USER: 'guest' } })}>
              {p.label}
            </button>
          )}
        </For>
      </section>

      <div class="log" ref={logEl} data-testid="console">
        <For each={lines}>{(l) => <div class={l.kind}>{l.text || ' '}</div>}</For>
      </div>

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
