// 같은 사이트를 여러 탭에서 열어도 한 번에 한 탭만 OS를 돌리게 한다.
//
// 탭마다 파일시스템을 메모리에 따로 올려 쓰고 같은 저장소에 내려쓰기 때문에, 두 탭이 동시에 돌면
// 나중에 저장한 쪽이 다른 쪽의 변경을 덮어쓴다. 그래서 탭 하나만 "사용 중"이 되고, 다른 탭은
// 넘겨받기를 요청할 수 있다. 넘겨줄 때는 저장을 마친 뒤에 물러난다.
import { createSignal } from 'solid-js'

/**
 * checking: 다른 탭이 쓰고 있는지 확인하는 중
 * active: 이 탭이 OS를 돌린다
 * elsewhere: 다른 탭이 쓰고 있다
 * moved: 이 탭에서 쓰다가 다른 탭에 넘겨줬다
 */
export type SessionState = 'checking' | 'active' | 'elsewhere' | 'moved'

const NAME = 'webos-session'
/** 쓰고 있던 탭이 이 시간 안에 물러나지 않으면(멈췄거나 응답이 없으면) 기다리지 않고 가져온다. */
const HANDOVER_TIMEOUT_MS = 3000

export function createSession() {
  const [state, setState] = createSignal<SessionState>('checking')
  // 탭끼리 조율할 수단이 없는 브라우저에서는 예전처럼 그냥 실행한다.
  if (!('locks' in navigator) || !('BroadcastChannel' in window)) {
    setState('active')
    return { state, takeOver() {}, beforeHandover() {} }
  }

  const channel = new BroadcastChannel(NAME)
  /** 자리를 내놓는다 (잠금을 쥐고 있는 동안에만 있다). */
  let release: (() => void) | undefined
  /** 넘겨주기 직전에 할 일: 저장을 마치고 커널을 끈다. */
  let prepare: () => Promise<void> = async () => {}

  /** 잠금을 얻으면 이 탭이 사용 중이 된다. 잠금은 내놓을 때까지(또는 탭이 닫힐 때까지) 쥐고 있는다. */
  const hold = (lock: Lock | null) => {
    if (!lock) return void setState('elsewhere')
    setState('active')
    return new Promise<void>((resolve) => (release = resolve))
  }

  /** 응답이 없다고 판단한 다른 탭이 잠금을 빼앗아 갔다. 두 탭이 함께 도는 일이 없도록 이 탭은 멈춘다. */
  const stolen = () => {
    release = undefined
    setState('moved')
  }

  navigator.locks.request(NAME, { ifAvailable: true }, hold).catch(stolen)

  channel.onmessage = async (e) => {
    if (e.data !== 'takeover' || !release) return
    const done = release
    release = undefined
    await prepare()
    setState('moved')
    done()
  }

  return {
    state,

    /** 넘겨주기 직전에 실행할 정리 작업을 등록한다. */
    beforeHandover(work: () => Promise<void>) {
      prepare = work
    },

    /** 다른 탭에서 쓰던 것을 이 탭으로 가져온다. */
    takeOver() {
      setState('checking')
      channel.postMessage('takeover')
      const waiting = new AbortController()
      const timer = setTimeout(() => waiting.abort(), HANDOVER_TIMEOUT_MS)
      navigator.locks
        .request(NAME, { signal: waiting.signal }, (lock) => {
          clearTimeout(timer)
          return hold(lock)
        })
        // 상대 탭이 응답하지 않으면 잠금을 빼앗는다. 그 탭의 저장되지 않은 변경은 잃을 수 있다.
        .catch((e) => {
          // 기다리다 그만둔 경우에만 빼앗는다. 그 밖의 거부는 이 탭이 쥐고 있던 잠금을 빼앗긴 것이다.
          if (!waiting.signal.aborted) throw e
          return navigator.locks.request(NAME, { steal: true }, hold)
        })
        .catch(stolen)
    },
  }
}
