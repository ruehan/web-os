// 바탕 화면: 왼쪽의 실행 레일과 창들이 놓이는 영역.
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { APPS, LAUNCHABLE, appById, type AppDef } from '../apps/registry.tsx'
import type { System } from '../system.ts'
import { ContextMenuHost, showMenu } from '../contextmenu.tsx'
import { AppsIcon } from '../icons.tsx'
import { setSettings, settings } from '../settings.ts'
import { compact } from './compact.ts'
import { Launcher } from './Launcher.tsx'
import { frameFor } from './geometry.ts'
import { Window } from './Window.tsx'
import { createWindowManager } from './wm.ts'

/** 창 제목 표시줄의 높이 (style.css의 --title-height와 같아야 한다) */
const TITLE_HEIGHT = 38

export function Desktop(props: { system: System }) {
  const wm = createWindowManager()
  const [now, setNow] = createSignal(new Date())
  const [menuOpen, setMenuOpen] = createSignal(false)
  /** 막대에 고정된 앱들. 설정에 적힌 순서를 따르고, 없어진 앱의 id는 건너뛴다. */
  const pinned = () => settings.pins.flatMap((id) => LAUNCHABLE.filter((app) => app.id === id))
  let layer!: HTMLDivElement

  /** 첫 방문 때만 안내 창을 띄우기 위한 표시 */
  const WELCOMED = 'webos.welcomed'

  function firstVisit(): boolean {
    try {
      if (localStorage.getItem(WELCOMED)) return false
      localStorage.setItem(WELCOMED, '1')
      return true
    } catch {
      return false // 저장소를 쓸 수 없으면 매번 띄우게 되므로 띄우지 않는다
    }
  }

  function launch(app: AppDef, args: Record<string, string> = {}) {
    // 프로그램인 앱은 프로세스를 띄우기만 한다. 창은 그 프로세스가 열 때 생긴다.
    if (app.exec) {
      // 창을 하나만 띄우는 프로그램이 이미 떠 있으면 그 창을 앞으로 가져온다.
      const running = app.single && wm.state.windows.find((w) => w.app === app.id)
      if (running) return wm.focus(running.id)
      return props.system.run(app.exec, [app.exec.slice(app.exec.lastIndexOf('/') + 1)])
    }
    // 실행할 명령이 딸린 요청은 이미 열려 있는 터미널(맨 위의 것)에 넘긴다.
    if (app.id === 'terminal' && args.run !== undefined) {
      const terminals = wm.state.windows.filter((w) => w.app === 'terminal')
      const top = terminals.reduce<(typeof terminals)[number] | undefined>((a, b) => (!a || b.z > a.z ? b : a), undefined)
      if (top) {
        wm.focus(top.id)
        return wm.post(top.id, args.run)
      }
    }
    // 창을 하나만 띄우는 앱이거나 같은 파일을 이미 열어 둔 경우에는 그 창을 앞으로 가져온다.
    const existing = wm.state.windows.find(
      (w) => w.app === app.id && (app.single || (args.path !== undefined && w.args.path === args.path)),
    )
    if (existing) wm.focus(existing.id)
    else wm.open(app.id, app.name, app.size, args)
  }

  // 프로세스가 창을 열면 그 크기의 창을 만들어 붙인다. 안쪽 크기를 맞추려고 제목 표시줄과 테두리만큼 더한다.
  props.system.gui.onOpen(({ pid, title, w, h }) => {
    // 실행 메뉴에 있는 프로그램이면 그 앱의 창으로 띄운다 (아이콘이 맞고, 하나만 띄우는 앱은 다시 찾을 수 있게).
    const command = props.system.procs.find((p) => p.pid === pid)?.name.split(' ')[0]
    const app = APPS.find((a) => a.exec !== undefined && a.exec.slice(a.exec.lastIndexOf('/') + 1) === command)
    wm.open(app?.id ?? 'surface', title || '프로그램', { w: w + 2, h: h + TITLE_HEIGHT + 2 }, { pid: String(pid), title })
  })

  onMount(() => {
    const measure = () => {
      // 화면에 그려진 크기(getBoundingClientRect)가 아니라 배치상의 크기를 쓴다.
      // 그려진 크기는 나타나는 움직임처럼 요소가 확대·축소되는 동안에는 실제와 다르다.
      wm.setDesk({ w: layer.clientWidth, h: layer.clientHeight })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(layer)
    measure()
    launch(appById('terminal'))
    if (firstVisit()) wm.open('welcome', '시작하기', appById('welcome').size, {}, 'right')
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
    <div class="desktop" classList={{ compact: compact() }}>
      <nav class="rail" aria-label="실행">
        <div class="rail-group">
          <button
            class="rail-button"
            classList={{ active: menuOpen() }}
            data-launcher-button
            aria-label="앱"
            aria-expanded={menuOpen()}
            title="모든 앱"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <AppsIcon />
          </button>
          <For each={pinned()}>
            {(app) => (
              <button
                class="rail-button pinned"
                aria-label={app.name}
                title={app.name}
                onClick={() => launch(app)}
                onContextMenu={(e) =>
                  showMenu(e, [
                    { label: `${app.name} 열기`, onSelect: () => launch(app) },
                    'separator',
                    { label: '막대에서 떼기', onSelect: () => setSettings('pins', (pins) => pins.filter((id) => id !== app.id)) },
                  ])
                }
              >
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
                data-tab={win.id}
                classList={{ active: wm.focused() === win.id, minimized: win.minimized, closing: win.closing }}
                aria-label={`창: ${win.title}`}
                title={win.title}
                onClick={() => wm.toggle(win.id)}
                onContextMenu={(e) =>
                  showMenu(e, [
                    { label: '앞으로 가져오기', onSelect: () => wm.focus(win.id), disabled: wm.focused() === win.id },
                    { label: '최소화', onSelect: () => wm.minimize(win.id), disabled: win.minimized },
                    'separator',
                    { label: '닫기', onSelect: () => wm.requestClose(win.id), danger: true },
                  ])
                }
              >
                {appById(win.app).icon()}
              </button>
            )}
          </For>
        </div>

        <time class="clock">{now().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
      </nav>

      <Show when={menuOpen()}>
        <Launcher onLaunch={(app) => launch(app)} onClose={() => setMenuOpen(false)} />
      </Show>

      <ContextMenuHost />

      <div
        class="window-layer"
        ref={layer}
        // 창이 아닌 빈 바탕을 우클릭했을 때
        onContextMenu={(e) =>
          e.target === e.currentTarget &&
          showMenu(e, [
            { label: '새 터미널', onSelect: () => launch(appById('terminal')) },
            { label: '파일 열기', onSelect: () => launch(appById('files')) },
            { label: '메모 열기', onSelect: () => launch(appById('notes')) },
            'separator',
            { label: '모든 앱…', onSelect: () => setMenuOpen(true) },
            { label: '설정', onSelect: () => launch(appById('settings')) },
          ])
        }
      >
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
        <Show when={props.system.dataLost()}>
          <div class="toast" role="alert">
            <strong>저장해 둔 파일을 찾을 수 없습니다</strong>
            <p>
              예전에 쓰던 내용이 없어 처음 상태로 시작했습니다. 브라우저가 데이터를 지웠을 수 있습니다. 보관 폴더나 백업
              파일이 있으면 설정에서 되살릴 수 있습니다.
            </p>
            <div class="button-row">
              <button
                class="tool primary"
                onClick={() => {
                  props.system.dismissDataLost()
                  launch(appById('settings'))
                }}
              >
                설정 열기
              </button>
              <button class="tool" onClick={props.system.dismissDataLost}>
                닫기
              </button>
            </div>
          </div>
        </Show>
        <For each={wm.state.windows}>
          {(win) => (
            <Window
              win={win}
              app={appById(win.app)}
              wm={wm}
              system={props.system}
              launch={(id, args) => launch(appById(id), args)}
              // 창이 포인터 좌표를 바탕 화면 기준으로 바꿀 때마다 그 순간의 위치를 잰다.
              origin={() => layer.getBoundingClientRect()}
            />
          )}
        </For>
      </div>
    </div>
  )
}
