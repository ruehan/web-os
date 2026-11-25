// 창 하나의 틀: 제목 표시줄, 조절 손잡이, 그 안의 앱.
import { For, Show } from 'solid-js'
import type { AppDef } from '../apps/registry.tsx'
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from '../icons.tsx'
import type { System } from '../system.ts'
import { clampMove, detach, resizeRect, snapZone, type Edge, type Rect } from './geometry.ts'
import type { WindowManager, WindowState } from './wm.ts'

const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
/** 이만큼 움직이기 전에는 끌기로 보지 않는다 (클릭과 구분). */
const DRAG_THRESHOLD = 4

interface Gesture {
  px: number
  py: number
  rect: Rect
  moved: boolean
}

export function Window(props: {
  win: WindowState
  app: AppDef
  wm: WindowManager
  system: System
  launch(app: string, args?: Record<string, string>): void
  /** 바탕 화면 영역의 화면상 위치 (포인터 좌표를 바탕 화면 기준으로 바꾸는 데 쓴다) */
  origin: () => { left: number; top: number }
}) {
  const { wm, win } = props
  const frame = () => wm.frame(win)
  const focused = () => wm.focused() === win.id
  let gesture: Gesture | undefined

  /** 포인터를 붙잡고, 손을 뗄 때까지의 움직임을 처리한다. */
  function track(e: PointerEvent, onMove: (dx: number, dy: number, e: PointerEvent) => void, onEnd?: () => void) {
    if (e.button !== 0) return
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    gesture = { px: e.clientX, py: e.clientY, rect: { ...frame() }, moved: false }
    const move = (ev: PointerEvent) => {
      const g = gesture!
      const dx = ev.clientX - g.px
      const dy = ev.clientY - g.py
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      g.moved = true
      onMove(dx, dy, ev)
    }
    const end = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      if (gesture?.moved) onEnd?.()
      gesture = undefined
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }

  function startMove(e: PointerEvent) {
    if ((e.target as Element).closest('button')) return
    track(
      e,
      (dx, dy, ev) => {
        const g = gesture!
        const { left, top } = props.origin()
        const px = ev.clientX - left
        const py = ev.clientY - top
        if (win.mode !== 'normal') {
          // 붙어 있던 창을 끌면 원래 크기로 돌아가 포인터를 따라온다.
          const rect = detach(win.rect, g.rect, g.px - left)
          wm.setRect(win.id, rect)
          wm.setMode(win.id, 'normal')
          g.rect = rect
        }
        wm.setRect(win.id, clampMove({ ...g.rect, x: g.rect.x + dx, y: g.rect.y + dy }, wm.state.desk))
        wm.setSnapPreview(snapZone(px, py, wm.state.desk))
      },
      () => {
        const zone = wm.state.snapPreview
        if (zone) wm.setMode(win.id, zone)
        wm.setSnapPreview(null)
      },
    )
  }

  function startResize(edge: Edge, e: PointerEvent) {
    e.stopPropagation()
    track(e, (dx, dy) => wm.setRect(win.id, resizeRect(gesture!.rect, edge, dx, dy)))
  }

  return (
    <section
      class="window"
      classList={{ focused: focused(), minimized: win.minimized, docked: win.mode !== 'normal' }}
      style={{
        transform: `translate(${frame().x}px, ${frame().y}px)`,
        width: `${frame().w}px`,
        height: `${frame().h}px`,
        // 창 사이에 붙이기 미리보기가 끼어들 수 있도록 한 칸씩 띄운다.
        'z-index': win.z * 2,
      }}
      aria-label={win.title}
      data-app={win.app}
      data-window={win.id}
      onPointerDown={() => wm.focus(win.id)}
      onFocusIn={() => wm.focus(win.id)}
    >
      <header class="titlebar" onPointerDown={startMove} onDblClick={() => wm.toggleMaximize(win.id)}>
        <span class="title-icon">{props.app.icon()}</span>
        <span class="title">{win.title}</span>
        <div class="controls">
          <button aria-label="최소화" onClick={() => wm.minimize(win.id)}>
            <MinimizeIcon />
          </button>
          <button aria-label={win.mode === 'normal' ? '최대화' : '원래 크기로'} onClick={() => wm.toggleMaximize(win.id)}>
            <Show when={win.mode === 'normal'} fallback={<RestoreIcon />}>
              <MaximizeIcon />
            </Show>
          </button>
          <button class="close" aria-label="닫기" onClick={() => wm.requestClose(win.id)}>
            <CloseIcon />
          </button>
        </div>
      </header>
      <div class="window-body">
        <props.app.component
          system={props.system}
          args={win.args}
          focused={focused}
          launch={props.launch}
          guardClose={(guard) => wm.setGuard(win.id, guard)}
          close={() => wm.close(win.id)}
          setTitle={(title) => wm.setTitle(win.id, title)}
        />
      </div>
      <Show when={win.mode === 'normal'}>
        <For each={EDGES}>{(edge) => <div class={`resize ${edge}`} onPointerDown={[startResize, edge]} />}</For>
      </Show>
    </section>
  )
}
