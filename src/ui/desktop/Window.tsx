// 창 하나의 틀: 제목 표시줄, 조절 손잡이, 그 안의 앱.
import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js'
import type { AppDef } from '../apps/registry.tsx'
import { showMenu } from '../contextmenu.tsx'
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from '../icons.tsx'
import { DURATION, motion } from '../motion.ts'
import type { System } from '../system.ts'
import { compact } from './compact.ts'
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
  let el!: HTMLElement

  // ───────────── 움직임 ─────────────

  /**
   * opening: 막 열려서 나타나는 중. hidden: 최소화되어 보이지 않는다.
   * minimizing/restoring: 레일의 창 표시 쪽으로 줄어들거나 거기서 커지는 중.
   * 최소화 여부(win.minimized)는 바로 바뀌지만, 화면에서는 움직임이 끝난 뒤에 숨긴다.
   */
  const [phase, setPhase] = createSignal<'opening' | 'shown' | 'minimizing' | 'hidden' | 'restoring'>(
    win.minimized ? 'hidden' : 'opening',
  )
  /** 최대화, 가장자리 붙이기 등으로 자리가 바뀌어 새 자리로 미끄러지는 중인가 */
  const [gliding, setGliding] = createSignal(false)
  /** 제목 표시줄을 잡고 끌고 있는가 */
  const [dragging, setDragging] = createSignal(false)
  let phaseTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => phase() === 'opening' && setPhase('shown'),
    motion(DURATION.open),
  )
  let glideTimer: ReturnType<typeof setTimeout> | undefined
  /** 끌어서 떼어 낼 때처럼, 자리가 바뀌어도 미끄러지면 안 되는 경우 */
  let jump = false
  onCleanup(() => {
    clearTimeout(phaseTimer)
    clearTimeout(glideTimer)
  })

  /** 창이 줄어들어 갈(또는 커져 나올) 곳: 레일에 있는 이 창의 표시 */
  function aimAtTab() {
    const tab = document.querySelector(`[data-tab="${win.id}"]`)
    if (!tab) return
    // 숨겨져 있는 창은 화면에서 크기를 잴 수 없으므로, 창 관리자가 아는 자리로 계산한다.
    const { left, top } = props.origin()
    const from = frame()
    const to = tab.getBoundingClientRect()
    el.style.setProperty('--to-x', `${to.x + to.width / 2 - (left + from.x + from.w / 2)}px`)
    el.style.setProperty('--to-y', `${to.y + to.height / 2 - (top + from.y + from.h / 2)}px`)
  }

  createEffect(
    on(
      () => win.minimized,
      (minimized) => {
        clearTimeout(phaseTimer)
        const wait = motion(DURATION.minimize)
        if (wait === 0) return void setPhase(minimized ? 'hidden' : 'shown')
        if (minimized) {
          aimAtTab()
          setPhase('minimizing')
          phaseTimer = setTimeout(() => setPhase('hidden'), wait)
        } else {
          aimAtTab()
          setPhase('restoring')
          phaseTimer = setTimeout(() => setPhase('shown'), wait)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [win.mode, compact()],
      () => {
        if (jump) return void (jump = false)
        const wait = motion(DURATION.glide)
        if (wait === 0) return
        clearTimeout(glideTimer)
        setGliding(true)
        glideTimer = setTimeout(() => setGliding(false), wait)
      },
      { defer: true },
    ),
  )

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
      setDragging(false)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }

  function startMove(e: PointerEvent) {
    // 좁은 화면에서는 창이 화면 전체를 쓰므로 옮길 수 없다.
    if (compact() || (e.target as Element).closest('button')) return
    track(
      e,
      (dx, dy, ev) => {
        const g = gesture!
        const { left, top } = props.origin()
        const px = ev.clientX - left
        const py = ev.clientY - top
        if (win.mode !== 'normal') {
          // 붙어 있던 창을 끌면 원래 크기로 돌아가 포인터를 따라온다. 손을 따라와야 하므로 미끄러지지 않고 바로 바뀐다.
          jump = true
          const rect = detach(win.rect, g.rect, g.px - left)
          wm.setRect(win.id, rect)
          wm.setMode(win.id, 'normal')
          g.rect = rect
        }
        setDragging(true)
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
      ref={el}
      classList={{
        focused: focused(),
        opening: phase() === 'opening',
        minimized: phase() === 'hidden',
        minimizing: phase() === 'minimizing',
        restoring: phase() === 'restoring',
        closing: win.closing,
        gliding: gliding(),
        dragging: dragging(),
        docked: win.mode !== 'normal',
      }}
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
      <header
        class="titlebar"
        onPointerDown={startMove}
        onDblClick={() => compact() || wm.toggleMaximize(win.id)}
        onContextMenu={(e) =>
          showMenu(e, [
            { label: '최소화', onSelect: () => wm.minimize(win.id) },
            // 좁은 화면에서는 창이 늘 화면 전체를 쓰므로 크기와 자리를 바꾸는 항목이 없다.
            !compact() && {
              label: win.mode === 'max' ? '원래 크기로' : '최대화',
              onSelect: () => wm.setMode(win.id, win.mode === 'max' ? 'normal' : 'max'),
            },
            !compact() && { label: '왼쪽 절반에 붙이기', onSelect: () => wm.setMode(win.id, 'left'), disabled: win.mode === 'left' },
            !compact() && { label: '오른쪽 절반에 붙이기', onSelect: () => wm.setMode(win.id, 'right'), disabled: win.mode === 'right' },
            'separator',
            { label: '닫기', onSelect: () => wm.requestClose(win.id), danger: true },
          ])
        }
      >
        <span class="title-icon">{props.app.icon()}</span>
        <span class="title">{win.title}</span>
        <div class="controls">
          <button aria-label="최소화" onClick={() => wm.minimize(win.id)}>
            <MinimizeIcon />
          </button>
          <Show when={!compact()}>
            <button aria-label={win.mode === 'normal' ? '최대화' : '원래 크기로'} onClick={() => wm.toggleMaximize(win.id)}>
              <Show when={win.mode === 'normal'} fallback={<RestoreIcon />}>
                <MaximizeIcon />
              </Show>
            </button>
          </Show>
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
          onMessage={(receiver) => wm.setReceiver(win.id, receiver)}
          close={() => wm.close(win.id)}
          setTitle={(title) => wm.setTitle(win.id, title)}
        />
      </div>
      <Show when={win.mode === 'normal' && !compact()}>
        <For each={EDGES}>{(edge) => <div class={`resize ${edge}`} onPointerDown={[startResize, edge]} />}</For>
      </Show>
    </section>
  )
}
