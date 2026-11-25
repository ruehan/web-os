// 창 관리자의 상태: 어떤 창이 열려 있고, 어디에 있으며, 어느 것이 맨 위인가.
import { batch, createMemo } from 'solid-js'
import { createStore } from 'solid-js/store'
import { DURATION, motion } from '../motion.ts'
import { compact } from './compact.ts'
import { clampMove, frameFor, placeNew, type Mode, type Rect, type Size } from './geometry.ts'

export interface WindowState {
  id: number
  app: string
  title: string
  /** 앱에 넘기는 시작 인자 (예: 열 파일의 경로) */
  args: Record<string, string>
  /** normal 상태일 때의 자리. 최대화하거나 붙여도 유지되어 되돌릴 때 쓴다. */
  rect: Rect
  mode: Mode
  minimized: boolean
  /** 닫히는 움직임이 진행 중이다. 곧 목록에서 사라진다. */
  closing?: boolean
  /** 쌓이는 순서. 클수록 위다. */
  z: number
}

export function createWindowManager() {
  const [state, setState] = createStore({
    windows: [] as WindowState[],
    desk: { w: 1280, h: 720 } as Size,
    /** 창을 끌어 가장자리에 댔을 때 미리 보여 주는 자리 */
    snapPreview: null as Mode | null,
  })
  let nextId = 1
  let topZ = 0
  let opened = 0
  /** 창을 닫아도 되는지 앱에 묻는 함수 (저장하지 않은 변경 확인 등) */
  const guards = new Map<number, () => boolean>()
  /** 다른 곳에서 창의 앱으로 보내는 요청을 받는 함수 (예: 터미널에 실행할 명령) */
  const receivers = new Map<number, (message: string) => void>()

  const find = (id: number) => state.windows.find((w) => w.id === id)
  const update = (id: number, patch: Partial<WindowState>) => setState('windows', (w) => w.id === id, patch)

  /** 최소화되지 않은 창 중 맨 위의 것이 입력을 받는다. */
  const focused = createMemo(() => {
    let top: WindowState | undefined
    for (const w of state.windows) if (!w.minimized && !w.closing && (!top || w.z > top.z)) top = w
    return top?.id ?? 0
  })

  return {
    state,
    focused,
    /** 창이 실제로 차지하는 자리. 좁은 화면에서는 언제나 화면 전체다. */
    frame: (w: WindowState) => frameFor(compact() ? 'max' : w.mode, w.rect, state.desk),

    open(app: string, title: string, size: Size, args: Record<string, string> = {}, side?: 'right'): number {
      const id = nextId++
      let rect = placeNew(opened++, size, state.desk)
      // 오른쪽에 붙여 여는 창은 다른 창을 가리지 않게 화면 오른쪽 가장자리에 둔다.
      if (side === 'right') rect = { ...rect, x: Math.max(8, state.desk.w - rect.w - 24), y: Math.min(rect.y, 48) }
      const win: WindowState = { id, app, title, args, rect, mode: 'normal', minimized: false, z: ++topZ }
      setState('windows', state.windows.length, win)
      return id
    },

    close(id: number) {
      const w = find(id)
      if (!w || w.closing) return
      guards.delete(id)
      receivers.delete(id)
      const remove = () => setState('windows', (ws) => ws.filter((x) => x.id !== id))
      // 사라지는 움직임을 보여 준 뒤에 치운다. 그동안에는 입력을 받지 않고 초점도 다음 창으로 넘어간다.
      const wait = motion(DURATION.close)
      if (wait === 0) return remove()
      update(id, { closing: true })
      setTimeout(remove, wait)
    },

    /** 사용자가 닫기를 눌렀을 때. 앱이 막으면(false) 닫지 않는다. */
    requestClose(id: number) {
      if (guards.get(id)?.() === false) return
      this.close(id)
    },

    setGuard(id: number, guard: () => boolean) {
      guards.set(id, guard)
    },

    setReceiver(id: number, receiver: (message: string) => void) {
      receivers.set(id, receiver)
    },

    /** 창의 앱에 요청을 전달한다. */
    post(id: number, message: string) {
      receivers.get(id)?.(message)
    },

    focus(id: number) {
      const w = find(id)
      if (!w || (w.z === topZ && !w.minimized)) return
      update(id, { z: ++topZ, minimized: false })
    },

    minimize(id: number) {
      update(id, { minimized: true })
    },

    /** 창 목록에서 눌렀을 때: 맨 위에 있으면 접고, 아니면 앞으로 가져온다. */
    toggle(id: number) {
      if (focused() === id) update(id, { minimized: true })
      else this.focus(id)
    },

    setMode(id: number, mode: Mode) {
      update(id, { mode })
    },

    toggleMaximize(id: number) {
      const w = find(id)
      if (w) update(id, { mode: w.mode === 'normal' ? 'max' : 'normal' })
    },

    setRect(id: number, rect: Rect) {
      update(id, { rect })
    },

    setTitle(id: number, title: string) {
      update(id, { title })
    },

    setSnapPreview(mode: Mode | null) {
      if (state.snapPreview !== mode) setState('snapPreview', mode)
    },

    /** 바탕 화면 크기가 바뀌면 화면 밖으로 밀려난 창을 다시 잡을 수 있는 곳으로 옮긴다. */
    setDesk(desk: Size) {
      batch(() => {
        setState('desk', desk)
        for (const w of state.windows) update(w.id, { rect: clampMove(w.rect, desk) })
      })
    },
  }
}

export type WindowManager = ReturnType<typeof createWindowManager>
