import { For } from 'solid-js'
import { showMenu } from '../contextmenu.tsx'
import type { AppProps } from './registry.tsx'

export function ProcessesApp(props: AppProps) {
  const procs = props.system.procs
  return (
    <div class="app-pane" data-testid="procs">
      <p class="app-summary">프로세스 {procs.length}개</p>
      <table class="proc-table">
        <thead>
          <tr>
            <th class="num">PID</th>
            <th class="num">부모</th>
            <th>명령</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <For each={procs}>
            {(p) => (
              <tr
                class="proc"
                onContextMenu={(e) =>
                  showMenu(e, [{ label: `${p.pid}번 프로세스 종료`, onSelect: () => props.system.kill(p.pid), danger: true }])
                }
              >
                <td class="num">{p.pid}</td>
                <td class="num">{p.ppid || '–'}</td>
                <td class="name">{p.name}</td>
                <td class="action">
                  <button class="button" onClick={() => props.system.kill(p.pid)}>
                    종료
                  </button>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}
