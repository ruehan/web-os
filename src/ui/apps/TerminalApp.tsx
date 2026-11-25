import { createEffect, onCleanup, onMount } from 'solid-js'
import type { TerminalSession } from '../system.ts'
import { Terminal, type TerminalHandle } from '../terminal/Terminal.tsx'
import type { AppProps } from './registry.tsx'

/** 창 하나가 터미널 장치 하나와 셸 하나를 갖는다. */
export function TerminalApp(props: AppProps) {
  let term!: TerminalHandle
  let session: TerminalSession | undefined
  let size = { cols: 80, rows: 24 }

  onMount(() => {
    session = props.system.openTerminal(size.cols, size.rows, {
      output: (data) => term.write(data),
      // 셸이 끝나면(exit, Ctrl+D) 창도 닫는다.
      closed: () => props.close(),
    })
  })
  onCleanup(() => session?.close())
  createEffect(() => props.focused() && term.focus())

  return (
    <Terminal
      ref={(handle) => (term = handle)}
      onInput={(text) => session?.input(text)}
      onResize={(cols, rows) => {
        size = { cols, rows }
        session?.resize(cols, rows)
      }}
    />
  )
}
