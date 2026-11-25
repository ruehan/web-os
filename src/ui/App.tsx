// 화면의 뿌리. 커널을 띄우고, 준비되면 바탕 화면을 보여 준다.
import { For, Show, onCleanup } from 'solid-js'
import { Desktop } from './desktop/Desktop.tsx'
import { createSystem } from './system.ts'

export function App() {
  // SharedArrayBuffer(블로킹 시스템 콜의 기반)는 교차 출처 격리 상태에서만 쓸 수 있다.
  if (!crossOriginIsolated) {
    return (
      <div class="boot">
        <p class="boot-error">
          이 페이지는 교차 출처 격리 상태가 아니라서 실행할 수 없습니다. 서버의 COOP/COEP 헤더를 확인하세요.
        </p>
      </div>
    )
  }

  const system = createSystem()
  onCleanup(system.shutdown)

  return (
    <Show
      when={system.ready()}
      fallback={
        <div class="boot" data-testid="boot">
          <For each={system.logs}>{(line) => <div classList={{ 'boot-error': line.error }}>{line.msg}</div>}</For>
        </div>
      }
    >
      <Desktop system={system} />
    </Show>
  )
}
