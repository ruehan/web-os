// 화면의 뿌리. 이 탭이 OS를 돌려도 되는지 확인하고, 커널을 띄워 부팅 기록을 보여 준 뒤 바탕 화면으로 넘어간다.
import { For, Match, Show, Switch, createEffect, createSignal, onCleanup } from 'solid-js'
import { Desktop } from './desktop/Desktop.tsx'
import { createSession } from './session.ts'
import { createSystem } from './system.ts'

/** 부팅 기록을 한 줄씩 드러내는 간격. 실제 부팅은 수십 밀리초면 끝나서 그대로는 읽을 수 없다. */
const LINE_INTERVAL_MS = 110
/** 마지막 줄이 나온 뒤 바탕 화면으로 넘어가기까지의 여유 */
const SETTLE_MS = 350

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

  const session = createSession()

  return (
    <Switch>
      <Match when={session.state() === 'active'}>
        <Machine beforeHandover={session.beforeHandover} />
      </Match>
      <Match when={session.state() === 'elsewhere'}>
        <Notice
          title="다른 탭에서 사용 중입니다"
          text="같은 파일을 두 곳에서 고치다 한쪽이 덮어쓰는 일을 막기 위해, 한 번에 한 탭에서만 실행합니다."
          action="이 탭에서 이어 쓰기"
          onAction={session.takeOver}
        />
      </Match>
      <Match when={session.state() === 'moved'}>
        <Notice
          title="다른 탭으로 옮겨 갔습니다"
          text="하던 작업은 저장됐고, 지금은 다른 탭에서 실행 중입니다."
          action="다시 이 탭에서 쓰기"
          onAction={session.takeOver}
        />
      </Match>
    </Switch>
  )
}

function Notice(props: { title: string; text: string; action: string; onAction(): void }) {
  return (
    <div class="boot" role="alertdialog" aria-label={props.title}>
      <div class="boot-inner">
        <p class="boot-mark">{props.title}</p>
        <p class="notice-text">{props.text}</p>
        <button class="tool primary notice-action" onClick={props.onAction}>
          {props.action}
        </button>
      </div>
    </div>
  )
}

/** 커널과 그 위의 화면. 이 탭이 사용 중일 때만 존재한다. */
function Machine(props: { beforeHandover(work: () => Promise<void>): void }) {
  const system = createSystem()
  // 다른 탭에 넘겨줄 때는 저장을 마친 뒤 끄고, 그 밖의 경우(화면 정리)에는 바로 끈다.
  let closed = false
  props.beforeHandover(async () => {
    closed = true
    await system.close()
  })
  onCleanup(() => closed || system.shutdown())

  // 움직임을 줄이도록 설정한 사용자에게는 연출 없이 바로 넘어간다.
  const instant = matchMedia('(prefers-reduced-motion: reduce)').matches
  const [shown, setShown] = createSignal(0)
  const [entered, setEntered] = createSignal(false)
  const failed = () => system.logs.some((line) => line.error)

  const reveal = setInterval(() => setShown((n) => Math.min(n + 1, system.logs.length)), LINE_INTERVAL_MS)
  onCleanup(() => clearInterval(reveal))

  createEffect(() => {
    if (!system.ready() || entered()) return
    if (instant) return void setEntered(true)
    if (shown() < system.logs.length) return
    const timer = setTimeout(() => setEntered(true), SETTLE_MS)
    onCleanup(() => clearTimeout(timer))
  })
  createEffect(() => entered() && clearInterval(reveal))

  /** 기다리지 않고 넘어간다. 커널이 준비되기 전에는 넘어갈 곳이 없다. */
  const skip = () => system.ready() && setEntered(true)
  window.addEventListener('keydown', skip)
  onCleanup(() => window.removeEventListener('keydown', skip))

  return (
    <Show
      when={entered()}
      fallback={
        <div class="boot" data-testid="boot" onPointerDown={skip}>
          <div class="boot-inner">
            <p class="boot-mark">Web OS</p>
            <div class="boot-log" role="log">
              <For each={system.logs.slice(0, instant || failed() ? system.logs.length : shown())}>
                {(line) => (
                  <div classList={{ 'boot-error': line.error }}>
                    <span class="log-time">{(line.time / 1000).toFixed(3).padStart(8)}</span>
                    {line.msg}
                  </div>
                )}
              </For>
            </div>
            <Show when={!failed()}>
              <p class="boot-hint">아무 키나 누르면 바로 시작합니다</p>
            </Show>
          </div>
        </div>
      }
    >
      <Desktop system={system} />
    </Show>
  )
}
