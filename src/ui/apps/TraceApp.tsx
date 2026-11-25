// 시스템 콜 추적 창. 프로그램이 커널에 보내는 요청이 일어나는 대로 한 줄씩 흐른다.
import { Show, createSignal, onCleanup, onMount } from 'solid-js'
import type { TraceRecord } from '../../kernel/abi.ts'
import type { AppProps } from './registry.tsx'

/** 화면에 남겨 두는 최대 줄 수. 넘치면 오래된 것부터 버린다. */
const KEEP = 2000

/** 걸러 내기에 쓰는, 한 줄 전체를 이어 붙인 글 */
const searchText = (r: TraceRecord) => `${r.pid} ${r.comm} ${r.call}(${r.args}) ${r.result}`.toLowerCase()

export function TraceApp(props: AppProps) {
  const [paused, setPaused] = createSignal(false)
  const [count, setCount] = createSignal(0)
  const [missed, setMissed] = createSignal(0)
  let list!: HTMLDivElement
  let records: TraceRecord[] = []
  let filter = ''
  let shown = 0

  // 줄이 초당 수백 개씩 들어올 수 있어서, 반응형 목록 대신 줄 요소를 직접 붙이고 뗀다.
  function row(r: TraceRecord): HTMLDivElement {
    const el = document.createElement('div')
    el.className = r.error ? 'trace-row error' : 'trace-row'
    const cell = (cls: string, text: string) => {
      const span = document.createElement('span')
      span.className = cls
      span.textContent = text
      el.appendChild(span)
    }
    cell('trace-time', (r.time / 1000).toFixed(3))
    cell('trace-pid', String(r.pid))
    cell('trace-comm', r.comm)
    cell('trace-call', r.call)
    cell('trace-args', `(${r.args})`)
    if (r.result) cell('trace-result', r.result)
    if (r.waited !== undefined) cell('trace-waited', `${(r.waited / 1000).toFixed(2)}초 대기`)
    return el
  }

  const matches = (r: TraceRecord) => !filter || searchText(r).includes(filter)

  function trim() {
    while (shown > KEEP) {
      list.firstElementChild?.remove()
      shown--
    }
    if (records.length > KEEP) records = records.slice(-KEEP)
  }

  function append(incoming: TraceRecord[], dropped: number) {
    if (paused()) return setMissed((n) => n + incoming.length + dropped)
    setMissed((n) => n + dropped)
    // 맨 아래를 보고 있을 때만 새 줄을 따라 내려간다.
    const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 24
    const fragment = document.createDocumentFragment()
    for (const r of incoming) {
      records.push(r)
      if (!matches(r)) continue
      fragment.appendChild(row(r))
      shown++
    }
    list.appendChild(fragment)
    trim()
    setCount(shown)
    if (follow) list.scrollTop = list.scrollHeight
  }

  /** 걸러 내는 조건이 바뀌면 남아 있는 기록으로 목록을 다시 만든다. */
  function redraw() {
    const fragment = document.createDocumentFragment()
    shown = 0
    for (const r of records) {
      if (!matches(r)) continue
      fragment.appendChild(row(r))
      shown++
    }
    list.replaceChildren(fragment)
    setCount(shown)
    list.scrollTop = list.scrollHeight
  }

  function clear() {
    records = []
    setMissed(0)
    redraw()
  }

  onMount(() => onCleanup(props.system.traceSyscalls(append)))

  return (
    <div class="trace">
      <div class="toolbar">
        <input
          class="trace-filter"
          type="search"
          aria-label="걸러 보기"
          placeholder="프로그램 이름, PID, 호출 이름으로 걸러 보기"
          onInput={(e) => {
            filter = e.currentTarget.value.trim().toLowerCase()
            redraw()
          }}
        />
        <button class="tool" aria-pressed={paused()} onClick={() => setPaused((p) => !p)}>
          {paused() ? '계속' : '일시정지'}
        </button>
        <button class="tool" onClick={clear}>
          지우기
        </button>
      </div>

      <div class="trace-list" ref={list} role="log" aria-label="시스템 콜" />
      <Show when={count() === 0}>
        <p class="trace-empty">
          {paused()
            ? '일시정지 중입니다.'
            : '터미널에서 명령을 실행하면, 그 프로그램이 커널에 보내는 요청이 여기에 한 줄씩 나타납니다.'}
        </p>
      </Show>

      <footer class="statusbar">
        <span class="status-name">
          {count()}줄{paused() ? ' · 일시정지' : ''}
        </span>
        <Show when={missed() > 0}>
          <span title="너무 빨리 쏟아지거나 일시정지 중이라 표시하지 않은 호출">{missed()}개 건너뜀</span>
        </Show>
      </footer>
    </div>
  )
}
