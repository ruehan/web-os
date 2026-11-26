// 실행 메뉴: 모든 앱을 이름과 함께 보여 주고, 글자를 쳐서 찾아 실행한다.
// 왼쪽 막대에는 자주 쓰는 앱만 고정해 두고, 나머지는 여기서 연다.
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { LAUNCHABLE as APPS, type AppDef } from '../apps/registry.tsx'
import { showMenu } from '../contextmenu.tsx'
import { PinIcon } from '../icons.tsx'
import { setSettings, settings } from '../settings.ts'

export function Launcher(props: { onLaunch(app: AppDef): void; onClose(): void }) {
  const [query, setQuery] = createSignal('')
  let panel!: HTMLDivElement
  let search!: HTMLInputElement

  const matches = createMemo(() => {
    const q = query().trim().toLowerCase()
    return q ? APPS.filter((app) => app.name.toLowerCase().includes(q) || app.id.includes(q)) : APPS
  })

  const launch = (app: AppDef) => {
    props.onClose()
    props.onLaunch(app)
  }

  const togglePin = (id: string) =>
    setSettings('pins', (pins) => (pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]))

  onMount(() => {
    search.focus()
    // 메뉴 밖을 누르면 닫는다. 메뉴를 연 버튼을 다시 눌렀을 때 닫혔다 곧바로 다시 열리지 않도록 그 버튼은 뺀다.
    const outside = (e: PointerEvent) => {
      const target = e.target as Element
      // 우클릭 메뉴는 이 메뉴 밖에 그려지지만, 이 메뉴에서 띄운 것이므로 밖으로 치지 않는다.
      if (!panel.contains(target) && !target.closest('[data-launcher-button], .context-menu')) props.onClose()
    }
    document.addEventListener('pointerdown', outside, true)
    onCleanup(() => document.removeEventListener('pointerdown', outside, true))
  })

  return (
    <div
      class="launcher"
      ref={panel}
      role="dialog"
      aria-label="앱"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose()
        // 찾은 것 중 첫 번째를 Enter로 바로 연다.
        else if (e.key === 'Enter' && e.target === search && matches()[0]) launch(matches()[0]!)
      }}
    >
      <input
        ref={search}
        class="launcher-search"
        type="search"
        aria-label="앱 찾기"
        placeholder="앱 찾기"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <ul class="launcher-list">
        <For each={matches()} fallback={<li class="launcher-empty">찾는 앱이 없습니다.</li>}>
          {(app) => (
            <li
              class="launcher-item"
              onContextMenu={(e) =>
                showMenu(e, [
                  { label: '열기', onSelect: () => launch(app) },
                  { label: settings.pins.includes(app.id) ? '막대에서 떼기' : '막대에 고정', onSelect: () => togglePin(app.id) },
                ])
              }
            >
              <button class="launcher-app" aria-label={app.name} onClick={() => launch(app)}>
                <span class="launcher-icon">{app.icon()}</span>
                {app.name}
              </button>
              <button
                class="launcher-pin"
                aria-label={`${app.name} 막대에 고정`}
                aria-pressed={settings.pins.includes(app.id)}
                title={settings.pins.includes(app.id) ? '막대에서 떼기' : '막대에 고정'}
                onClick={() => togglePin(app.id)}
              >
                <PinIcon />
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={!query()}>
        <p class="launcher-hint">핀을 누르면 왼쪽 막대에 고정됩니다.</p>
      </Show>
    </div>
  )
}
