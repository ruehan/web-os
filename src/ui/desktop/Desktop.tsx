// 바탕 화면: 왼쪽의 실행 레일과 창들이 놓이는 영역.
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { APPS, appById, type AppDef } from '../apps/registry.tsx'
import type { System } from '../system.ts'
import { frameFor } from './geometry.ts'
import { Window } from './Window.tsx'
import { createWindowManager } from './wm.ts'

export function Desktop(props: { system: System }) {
  const wm = createWindowManager()
  const [now, setNow] = createSignal(new Date())
  let layer!: HTMLDivElement
  let origin = { left: 0, top: 0 }

  function launch(app: AppDef, args: Record<string, string> = {}) {
    // 창을 하나만 띄우는 앱이거나 같은 파일을 이미 열어 둔 경우에는 그 창을 앞으로 가져온다.
    const existing = wm.state.windows.find(
      (w) => w.app === app.id && (app.single || (args.path !== undefined && w.args.path === args.path)),
    )
    if (existing) wm.focus(existing.id)
    else wm.open(app.id, app.name, app.size, args)
  }

  onMount(() => {
    const measure = () => {
      const box = layer.getBoundingClientRect()
      origin = { left: box.left, top: box.top }
      wm.setDesk({ w: box.width, h: box.height })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(layer)
    measure()
    launch(appById('terminal'))
    const clock = setInterval(() => setNow(new Date()), 10_000)
    onCleanup(() => {
      observer.disconnect()
      clearInterval(clock)
    })
  })

  const preview = () => {
    const mode = wm.state.snapPreview
    return mode && frameFor(mode, { x: 0, y: 0, w: 0, h: 0 }, wm.state.desk)
  }
  /** 미리보기는 끌고 있는 창(맨 위) 바로 아래, 나머지 창들 위에 그린다. */
  const previewZ = () => Math.max(0, ...wm.state.windows.map((w) => w.z)) * 2 - 1

  return (
    <div class="desktop">
      <nav class="rail" aria-label="실행">
        <div class="rail-group">
          <For each={APPS}>
            {(app) => (
              <button class="rail-button" aria-label={app.name} title={app.name} onClick={() => launch(app)}>
                {app.icon()}
              </button>
            )}
          </For>
        </div>

        <div class="rail-group rail-windows" aria-label="열린 창">
          <For each={wm.state.windows}>
            {(win) => (
              <button
                class="rail-button window-tab"
                classList={{ active: wm.focused() === win.id, minimized: win.minimized }}
                aria-label={`창: ${win.title}`}
                title={win.title}
                onClick={() => wm.toggle(win.id)}
              >
                {appById(win.app).icon()}
              </button>
            )}
          </For>
        </div>

        <time class="clock">{now().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
      </nav>

      <div class="window-layer" ref={layer}>
        <Show when={preview()}>
          {(box) => (
            <div
              class="snap-preview"
              style={{
                transform: `translate(${box().x}px, ${box().y}px)`,
                width: `${box().w}px`,
                height: `${box().h}px`,
                'z-index': previewZ(),
              }}
            />
          )}
        </Show>
        <For each={wm.state.windows}>
          {(win) => (
            <Window
              win={win}
              app={appById(win.app)}
              wm={wm}
              system={props.system}
              launch={(id, args) => launch(appById(id), args)}
              origin={() => origin}
            />
          )}
        </For>
      </div>
    </div>
  )
}
