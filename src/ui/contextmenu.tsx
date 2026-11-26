// 우클릭 메뉴. 화면 어디서든 showMenu로 띄우고, 한 번에 하나만 열린다.
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'

export type MenuItem =
  | {
      label: string
      onSelect(): void
      disabled?: boolean
      /** 지우기처럼 되돌릴 수 없는 일 */
      danger?: boolean
    }
  | 'separator'

interface OpenMenu {
  x: number
  y: number
  items: MenuItem[]
  /** 메뉴가 닫힐 때 (고르든 말든) 한 번 불린다. */
  onClose?: () => void
}

const [menu, setMenu] = createSignal<OpenMenu | null>(null)

/**
 * 우클릭한 자리에 메뉴를 띄운다. 브라우저의 기본 메뉴는 막는다.
 * 고를 수 있는 항목이 하나도 없으면 띄우지 않고 기본 메뉴에 맡긴다.
 */
export function showMenu(e: MouseEvent, items: (MenuItem | false | undefined)[]): void {
  const list = items.filter((item): item is MenuItem => !!item)
  // 구분선이 맨 앞·맨 뒤에 오거나 연달아 오지 않게 정리한다.
  const tidy = list.filter((item, i) => item !== 'separator' || (i > 0 && i < list.length - 1 && list[i - 1] !== 'separator'))
  if (!tidy.some((item) => item !== 'separator')) return
  e.preventDefault()
  e.stopPropagation()
  closeMenu()
  setMenu({ x: e.clientX, y: e.clientY, items: tidy })
}

/** 화면의 정해진 자리에 메뉴를 띄운다 (프로세스가 띄워 달라고 한 메뉴). */
export function showMenuAt(x: number, y: number, items: MenuItem[], onClose?: () => void): void {
  closeMenu()
  setMenu({ x, y, items, onClose })
}

export function closeMenu() {
  const open = menu()
  setMenu(null)
  open?.onClose?.()
}

/** 글을 입력하는 칸인가. 이런 곳에서는 브라우저의 기본 메뉴(붙여넣기, 맞춤법 등)가 더 쓸모 있다. */
export const isTextField = (target: EventTarget | null) =>
  target instanceof Element && target.closest('input, textarea, [contenteditable]') !== null

/** 메뉴가 그려지는 자리. 화면에 하나만 둔다. */
export function ContextMenuHost() {
  return <Show when={menu()}>{(open) => <Menu {...open()} />}</Show>
}

function Menu(props: OpenMenu) {
  let panel!: HTMLDivElement
  const [place, setPlace] = createSignal({ left: props.x, top: props.y })
  const buttons = () => [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]

  createEffect(() => {
    // 화면 밖으로 나가지 않도록 크기를 잰 뒤 자리를 고친다.
    const box = panel.getBoundingClientRect()
    setPlace({
      left: Math.max(4, Math.min(props.x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(props.y, window.innerHeight - box.height - 4)),
    })
    buttons()[0]?.focus({ preventScroll: true })
  })

  // 메뉴 밖을 누르거나, 화면이 움직이거나, 다른 창으로 가면 닫는다.
  const outside = (e: Event) => panel.contains(e.target as Node) || closeMenu()
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('wheel', closeMenu, { capture: true, passive: true })
  window.addEventListener('blur', closeMenu)
  window.addEventListener('resize', closeMenu)
  onCleanup(() => {
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('wheel', closeMenu, true)
    window.removeEventListener('blur', closeMenu)
    window.removeEventListener('resize', closeMenu)
  })

  function onKeyDown(e: KeyboardEvent) {
    const list = buttons()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape' || e.key === 'Tab') closeMenu()
    else if (e.key === 'ArrowDown') list[(at + 1) % list.length]?.focus()
    else if (e.key === 'ArrowUp') list[(at - 1 + list.length) % list.length]?.focus()
    else if (e.key === 'Home') list[0]?.focus()
    else if (e.key === 'End') list.at(-1)?.focus()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      class="context-menu"
      ref={panel}
      role="menu"
      style={{ left: `${place().left}px`, top: `${place().top}px` }}
      onKeyDown={onKeyDown}
      // 메뉴 위에서 다시 우클릭해도 브라우저 메뉴가 뜨지 않게 한다.
      onContextMenu={(e) => e.preventDefault()}
    >
      <For each={props.items}>
        {(item) =>
          item === 'separator' ? (
            <div class="menu-separator" role="separator" />
          ) : (
            <button
              role="menuitem"
              classList={{ danger: item.danger }}
              disabled={item.disabled}
              onClick={() => {
                closeMenu()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          )
        }
      </For>
    </div>
  )
}
