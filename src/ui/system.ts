// 화면 쪽에서 커널을 다루는 창구. 커널 Worker를 띄우고, 이벤트를 화면이 구독할 수 있는
// 상태(프로세스 목록, 로그)와 터미널 세션으로 바꿔 준다.
import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { FsEntry, FsRequest, FsResult, KernelCommand, KernelEvent, TraceRecord } from '../kernel/abi.ts'
import { Errno } from '../kernel/errno.ts'
import { forgetHandle, saveHandle, savedHandles } from './handles.ts'
import { formatSize } from './path.ts'
import { mountLimit } from './settings.ts'

export interface Proc {
  pid: number
  ppid: number
  name: string
}

export interface LogLine {
  time: number
  msg: string
  error?: boolean
}

export interface TerminalSession {
  input(text: string): void
  resize(cols: number, rows: number): void
  /** 터미널을 닫는다. 셸과 그 아래 프로세스가 모두 끝난다. */
  close(): void
}

interface SessionState {
  tty: number
  /** 커널이 터미널을 열어 주기 전에 들어온 입력 */
  queued: string
  size: { cols: number; rows: number }
  output(data: Uint8Array): void
  closed(): void
}

const FS_MESSAGES: Record<number, string> = {
  [Errno.NOENT]: '파일이나 폴더를 찾을 수 없습니다.',
  [Errno.EXIST]: '같은 이름이 이미 있습니다.',
  [Errno.NOTDIR]: '폴더가 아닙니다.',
  [Errno.ISDIR]: '폴더는 이렇게 열 수 없습니다.',
  [Errno.INVAL]: '이름이나 위치가 올바르지 않습니다.',
}

export class FsError extends Error {
  errno: number

  constructor(errno: number) {
    super(FS_MESSAGES[errno] ?? `파일 작업에 실패했습니다 (오류 ${errno}).`)
    this.errno = errno
  }
}

/** 연결했거나, 예전에 연결해서 기억하고 있는 로컬 폴더 */
export interface Mount {
  /** /mnt 아래의 이름 */
  name: string
  path: string
  /** connected: 연결됨. remembered: 기억하고 있지만 이번 방문에서는 아직 권한을 받지 않음. */
  state: 'connected' | 'remembered'
  /** 저장 실패 등 사용자가 알아야 할 문제 */
  error?: string
}

/** 권한 확인과 요청은 아직 표준 타입 정의에 없다. */
type PermissionedHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>
}

type MountResult = Extract<KernelEvent, { type: 'mount-result' }>

type DirectoryPicker = (options: object) => Promise<FileSystemDirectoryHandle>

/** 폴더 선택 창. 지원하지 않는 브라우저에서는 없다. (window에 붙은 채로 불러야 해서 감싸 둔다.) */
const pickDirectory: DirectoryPicker | undefined =
  'showDirectoryPicker' in window
    ? (options) => (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker(options)
    : undefined

export function createSystem() {
  const [procs, setProcs] = createStore<Proc[]>([])
  const [logs, setLogs] = createStore<LogLine[]>([])
  const [ready, setReady] = createSignal(false)
  /** 요청 번호 → 아직 커널의 응답을 기다리는 세션 */
  const opening = new Map<number, SessionState>()
  const sessions = new Map<number, SessionState>()
  let nextRef = 1
  /** 시스템 콜 추적을 보고 있는 창들. 하나라도 있는 동안만 커널이 기록을 보낸다. */
  const tracers = new Set<(records: TraceRecord[], dropped: number) => void>()
  /** 파일시스템이 바뀔 때마다 증가한다. 읽으면 변경을 구독하게 된다. */
  const [fsVersion, setFsVersion] = createSignal(0)
  const fsCalls = new Map<number, { resolve(result: FsResult): void; reject(error: FsError): void }>()
  const [mounts, setMounts] = createStore<Mount[]>([])
  const mountCalls = new Map<number, (result: MountResult) => void>()
  const handles = new Map<string, FileSystemDirectoryHandle>()

  const kernel = new Worker(new URL('../kernel/kernel.worker.ts', import.meta.url), { type: 'module', name: 'kernel' })
  const send = (cmd: KernelCommand) => kernel.postMessage(cmd)
  const log = (line: LogLine) => setLogs(produce((l) => l.push(line)))

  kernel.onerror = (e) => log({ time: performance.now(), msg: `kernel crashed: ${e.message}`, error: true })
  kernel.onmessage = (e: MessageEvent<KernelEvent>) => {
    const ev = e.data
    switch (ev.type) {
      case 'klog':
        return log({ time: ev.time, msg: ev.msg })
      case 'error':
        return log({ time: performance.now(), msg: ev.msg, error: true })
      case 'ready':
        setReady(true)
        return void restoreMounts()
      case 'mount-result':
        mountCalls.get(ev.id)?.(ev)
        return mountCalls.delete(ev.id)
      case 'mount-error':
        return setMounts((m) => m.name === ev.name, 'error', '실제 파일에 저장하지 못했습니다. 폴더가 옮겨졌거나 권한이 취소됐을 수 있습니다.')
      case 'spawn':
        return setProcs(produce((p) => p.push({ pid: ev.pid, ppid: ev.ppid, name: ev.argv.join(' ') })))
      case 'exit':
        return setProcs((p) => p.filter((x) => x.pid !== ev.pid))
      case 'trace':
        return tracers.forEach((listener) => listener(ev.records, ev.dropped))
      case 'storage-reset':
        // 메모리에 남은 파일까지 버리고 첫 방문 상태로 다시 시작한다.
        return location.reload()
      case 'fs-change':
        return setFsVersion((v) => v + 1)
      case 'fs-result': {
        const call = fsCalls.get(ev.id)
        fsCalls.delete(ev.id)
        if (ev.errno !== undefined) return call?.reject(new FsError(ev.errno))
        return call?.resolve(ev.result ?? {})
      }
      case 'tty-open': {
        const session = opening.get(ev.ref)
        if (!session) return send({ type: 'tty-close', tty: ev.tty }) // 응답이 오기 전에 창이 닫혔다
        opening.delete(ev.ref)
        session.tty = ev.tty
        sessions.set(ev.tty, session)
        // 요청을 보낸 뒤에 창 크기가 바뀌었을 수 있다.
        send({ type: 'tty-resize', tty: ev.tty, ...session.size })
        if (session.queued) send({ type: 'tty-input', tty: ev.tty, text: session.queued })
        session.queued = ''
        return
      }
      case 'tty-output':
        return sessions.get(ev.tty)?.output(ev.data)
      case 'tty-close': {
        const session = sessions.get(ev.tty)
        sessions.delete(ev.tty)
        return session?.closed()
      }
    }
  }

  // ───────────── 로컬 폴더 연결 ─────────────

  const mountPath = (name: string) => `/mnt/${name}`

  /** 커널에 연결을 요청하고 결과를 기다린다. 실패하면 사용자에게 보여 줄 문장으로 거부된다. */
  async function attach(name: string, handle: FileSystemDirectoryHandle): Promise<string> {
    const limit = mountLimit()
    const result = await new Promise<MountResult>((resolve) => {
      const id = nextRef++
      mountCalls.set(id, resolve)
      send({ type: 'mount', id, name, handle, maxFiles: limit.maxFiles, maxBytes: limit.maxBytes })
    })
    if (result.ok) {
      setMounts((m) => m.filter((x) => x.name !== name).concat({ name, path: result.path, state: 'connected' }))
      return result.path
    }
    if (result.reason === 'too-large') {
      throw new Error(
        `폴더가 너무 큽니다 (파일 ${result.files.toLocaleString()}개 이상, ${formatSize(result.bytes)} 이상). ` +
          `지금 한도는 ${limit.name}입니다. 전용 폴더를 새로 만들어 연결하거나, 설정에서 한도를 올려 주세요.`,
      )
    }
    throw new Error(`폴더를 연결하지 못했습니다: ${result.msg}`)
  }

  /** 지난 방문 때 연결했던 폴더들을 되살린다. 권한이 남아 있으면 바로 연결하고, 아니면 목록에만 올린다. */
  async function restoreMounts() {
    if (!pickDirectory) return
    try {
      for (const [name, handle] of await savedHandles()) {
        handles.set(name, handle)
        const granted = (await (handle as PermissionedHandle).queryPermission({ mode: 'readwrite' })) === 'granted'
        setMounts((m) => m.concat({ name, path: mountPath(name), state: 'remembered' }))
        if (granted) await attach(name, handle).catch((e) => setMounts((m) => m.name === name, 'error', String(e.message)))
      }
    } catch {
      // 기억해 둔 폴더를 읽지 못해도 나머지 기능에는 지장이 없다.
    }
  }

  const mountApi = {
    /** 이 브라우저가 로컬 폴더 연결을 지원하는가 (데스크톱 Chromium 계열) */
    supported: pickDirectory !== undefined,
    list: mounts,

    /**
     * 폴더 선택 창을 띄워 고른 폴더를 연결하고, 연결된 경로를 돌려준다.
     * 사용자가 선택을 취소하면 null. 반드시 클릭 같은 사용자 동작 안에서 불러야 한다.
     */
    async connect(): Promise<string | null> {
      if (!pickDirectory) throw new Error('이 브라우저는 로컬 폴더 연결을 지원하지 않습니다.')
      let handle: FileSystemDirectoryHandle
      try {
        handle = await pickDirectory({ mode: 'readwrite', id: 'webos-mount' })
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return null
        throw e
      }
      // 이미 알고 있는 폴더를 다시 골랐으면 같은 이름으로 연결한다.
      let name: string | undefined
      for (const [known, saved] of handles) if (await saved.isSameEntry(handle)) name = known
      if (name && mounts.some((m) => m.name === name && m.state === 'connected')) return mountPath(name)
      if (!name) {
        const base = handle.name.replaceAll('/', '_') || '폴더'
        name = base
        for (let n = 2; handles.has(name); n++) name = `${base} ${n}`
      }
      const path = await attach(name, handle)
      handles.set(name, handle)
      await saveHandle(name, handle).catch(() => {})
      return path
    },

    /** 기억해 둔 폴더의 권한을 다시 받아 연결한다. 사용자 동작 안에서 불러야 한다. */
    async reconnect(name: string): Promise<string> {
      const handle = handles.get(name) as PermissionedHandle | undefined
      if (!handle) throw new Error('기억하고 있는 폴더가 아닙니다.')
      if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('폴더를 읽고 쓸 권한을 받지 못했습니다.')
      }
      return attach(name, handle)
    },

    /** 연결을 끊고 잊는다. 실제 폴더와 그 안의 파일은 그대로 남는다. */
    async disconnect(name: string): Promise<void> {
      if (mounts.some((m) => m.name === name && m.state === 'connected')) {
        await new Promise<MountResult>((resolve) => {
          const id = nextRef++
          mountCalls.set(id, resolve)
          send({ type: 'unmount', id, name })
        })
      }
      handles.delete(name)
      await forgetHandle(name).catch(() => {})
      setMounts((m) => m.filter((x) => x.name !== name))
    },
  }

  const fsCall = (request: FsRequest) =>
    new Promise<FsResult>((resolve, reject) => {
      const id = nextRef++
      fsCalls.set(id, { resolve, reject })
      send({ type: 'fs', id, request })
    })

  return {
    procs,
    logs,
    ready,
    fsVersion,
    /** 사용자가 고른 로컬 폴더를 /mnt 아래에 연결한다. */
    mounts: mountApi,
    /** 파일 작업. 경로는 모두 절대 경로이며, 실패하면 FsError로 거부된다. */
    fs: {
      list: async (path: string): Promise<FsEntry[]> => (await fsCall({ op: 'list', path })).entries ?? [],
      read: async (path: string): Promise<Uint8Array> => (await fsCall({ op: 'read', path })).data ?? new Uint8Array(0),
      write: async (path: string, data: Uint8Array) => void (await fsCall({ op: 'write', path, data })),
      mkdir: async (path: string) => void (await fsCall({ op: 'mkdir', path })),
      remove: async (path: string) => void (await fsCall({ op: 'remove', path })),
      rename: async (from: string, to: string) => void (await fsCall({ op: 'rename', from, to })),
    },
    kill: (pid: number) => send({ type: 'kill', pid }),
    /**
     * 모든 프로세스의 시스템 콜을 받아 본다. 돌려주는 함수를 부르면 그만 받는다.
     * 보는 쪽이 없을 때는 커널이 기록하지 않으므로 평소 성능에는 영향이 없다.
     */
    traceSyscalls(listener: (records: TraceRecord[], dropped: number) => void): () => void {
      if (tracers.size === 0) send({ type: 'trace', on: true })
      tracers.add(listener)
      return () => {
        tracers.delete(listener)
        if (tracers.size === 0) send({ type: 'trace', on: false })
      }
    },
    /** 브라우저에 저장된 /home 을 지우고 처음 상태로 다시 시작한다. */
    resetStorage: () => send({ type: 'storage-reset' }),

    /** 새 터미널 장치를 만들고 셸을 띄운다. */
    openTerminal(
      cols: number,
      rows: number,
      handlers: { output(data: Uint8Array): void; closed(): void },
    ): TerminalSession {
      const ref = nextRef++
      const session: SessionState = { tty: 0, queued: '', size: { cols, rows }, ...handlers }
      opening.set(ref, session)
      send({ type: 'tty-open', ref, cols, rows })
      return {
        input(text) {
          if (session.tty) send({ type: 'tty-input', tty: session.tty, text })
          else session.queued += text
        },
        resize(cols, rows) {
          session.size = { cols, rows }
          if (session.tty) send({ type: 'tty-resize', tty: session.tty, cols, rows })
        },
        close() {
          opening.delete(ref)
          if (session.tty) send({ type: 'tty-close', tty: session.tty })
        },
      }
    },

    shutdown: () => kernel.terminate(),
  }
}

export type System = ReturnType<typeof createSystem>
