import { For, createEffect } from 'solid-js'
import type { AppProps } from './registry.tsx'

/** 커널이 부팅하면서 남긴 기록 */
export function LogApp(props: AppProps) {
  let pane!: HTMLDivElement
  const logs = props.system.logs
  createEffect(() => {
    void logs.length
    pane.scrollTop = pane.scrollHeight
  })
  return (
    <div class="app-pane log-pane" ref={pane} data-testid="klog">
      <For each={logs}>
        {(line) => (
          <div classList={{ 'log-line': true, error: line.error }}>
            <span class="log-time">{(line.time / 1000).toFixed(3).padStart(8)}</span>
            {line.msg}
          </div>
        )}
      </For>
    </div>
  )
}
