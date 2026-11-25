import { For, Show, createEffect, onCleanup, onMount } from 'solid-js'
import { compact } from '../desktop/compact.ts'
import type { TerminalSession } from '../system.ts'
import { Terminal, type TerminalHandle } from '../terminal/Terminal.tsx'
import type { AppProps } from './registry.tsx'

/** 휴대폰 키보드에 없는 키들 */
const EXTRA_KEYS: { label: string; name: string; seq: string }[] = [
  { label: 'Tab', name: 'Tab', seq: '\t' },
  { label: '^C', name: 'Ctrl+C', seq: '\x03' },
  { label: '^D', name: 'Ctrl+D', seq: '\x04' },
  { label: '↑', name: '위', seq: '\x1b[A' },
  { label: '↓', name: '아래', seq: '\x1b[B' },
  { label: '←', name: '왼쪽', seq: '\x1b[D' },
  { label: '→', name: '오른쪽', seq: '\x1b[C' },
]

/** 창 하나가 터미널 장치 하나와 셸 하나를 갖는다. */
export function TerminalApp(props: AppProps) {
  let term!: TerminalHandle
  let session: TerminalSession | undefined
  let size = { cols: 80, rows: 24 }

  /** 명령을 대신 입력해 실행한다. 셸이 아직 준비되지 않았어도 입력은 보존된다. */
  const run = (command: string) => {
    session?.input(command + '\r')
    term.focus()
  }

  let disposed = false
  onMount(() => {
    // 터미널 화면이 자기 크기를 잰 다음에 연다. 셸이 처음부터 실제 폭을 알아야
    // 첫 프롬프트의 줄바꿈 계산이 어긋나지 않는다. (화면의 onMount는 이 함수 바로 뒤에 실행된다.)
    queueMicrotask(() => {
      if (disposed) return
      session = props.system.openTerminal(size.cols, size.rows, {
        output: (data) => term.write(data),
        // 셸이 끝나면(exit, Ctrl+D) 창도 닫는다.
        closed: () => props.close(),
      })
      if (props.args.run) run(props.args.run)
    })
  })
  onCleanup(() => {
    disposed = true
    session?.close()
  })
  props.onMessage(run)
  createEffect(() => props.focused() && term.focus())

  return (
    <div class="terminal-app">
      <div class="terminal-host">
        <Terminal
          ref={(handle) => (term = handle)}
          onInput={(text) => session?.input(text)}
          onResize={(cols, rows) => {
            size = { cols, rows }
            session?.resize(cols, rows)
          }}
        />
      </div>
      <Show when={compact()}>
        <div class="term-keys" role="toolbar" aria-label="추가 키">
          <For each={EXTRA_KEYS}>
            {(key) => (
              <button
                aria-label={key.name}
                // 버튼을 눌러도 입력창의 포커스(화면 키보드)가 유지되게 한다.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  session?.input(key.seq)
                  term.focus()
                }}
              >
                {key.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
