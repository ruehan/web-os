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

/** 브라우저 저장소의 상태 */
export interface StorageStatus {
  /** 이 사이트가 쓰고 있는 양과 쓸 수 있는 한도 (바이트). 브라우저가 알려 주지 않으면 없다. */
  usage?: number
  quota?: number
  /**
   * 브라우저가 이 사이트의 데이터를 임의로 지우지 않기로 했는가.
   * false면 디스크가 부족할 때 통째로 지워질 수 있다. 알 수 없으면 undefined.
   */
  protected?: boolean
}

/** 파일시스템 전체를 함께 저장해 두는 사용자의 로컬 폴더 */
export interface ArchiveStatus {
  /**
   * none: 연결한 폴더가 없다.
   * linked: 연결됨. 바뀐 내용이 폴더에도 저장된다.
   * paused: 예전에 연결했지만 이번 방문에서는 아직 권한을 받지 않았다. 그동안의 변경은 다시 연결할 때 반영된다.
   */
  state: 'none' | 'linked' | 'paused'
  /** 폴더 이름 */
  name?: string
  /** 저장 실패 등 사용자가 알아야 할 문제 */
  error?: string
}

/** 권한 확인과 요청은 아직 표준 타입 정의에 없다. */
type PermissionedHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>
}

type ArchiveResult = Extract<KernelEvent, { type: 'archive-result' }>
type ArchiveMode = Extract<KernelCommand, { type: 'archive-link' }>['mode']

/** 보관 폴더를 고른 결과. needs-choice면 어느 쪽 내용을 살릴지 사용자가 정해야 한다. */
export type LinkOutcome = 'linked' | 'needs-choice' | 'cancelled'

type DirectoryPicker = (options: object) => Promise<FileSystemDirectoryHandle>

/** 폴더 선택 창. 지원하지 않는 브라우저에서는 없다. (window에 붙은 채로 불러야 해서 감싸 둔다.) */
const pickDirectory: DirectoryPicker | undefined =
  'showDirectoryPicker' in window
    ? (options) => (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker(options)
    : undefined

/** 이 브라우저에서 OS를 쓴 적이 있다는 표시 */
const SEEN = 'webos.seen'
const LAST_BACKUP = 'webos.lastBackup'

// 브라우저 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 조용히 넘어간다.
function readNumber(key: string): number | undefined {
  try {
    const value = Number(localStorage.getItem(key) ?? NaN)
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function remember(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {}
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {}
}

export function createSystem() {
  const [procs, setProcs] = createStore<Proc[]>([])
  const [logs, setLogs] = createStore<LogLine[]>([])
  const [ready, setReady] = createSignal(false)
  /** 요청 번호 → 아직 커널의 응답을 기다리는 세션 */
  const opening = new Map<number, SessionState>()
  const sessions = new Map<number, SessionState>()
  let nextRef = 1
  /** 시스템 콜 추적을 보고 있는 창들. 하나라도 있는 동안만 커널이 기록을 보낸다. */
  /** flush 응답을 기다리는 쪽 */
  let flushed: (() => void) | undefined
  const tracers = new Set<(records: TraceRecord[], dropped: number) => void>()
  /** 파일시스템이 바뀔 때마다 증가한다. 읽으면 변경을 구독하게 된다. */
  const [fsVersion, setFsVersion] = createSignal(0)
  const fsCalls = new Map<number, { resolve(result: FsResult): void; reject(error: FsError): void }>()
  const [archive, setArchive] = createStore<ArchiveStatus>({ state: 'none' })
  const [storage, setStorage] = createStore<StorageStatus>({})
  /** 예전에 쓴 흔적은 있는데 저장된 것이 없어 처음 상태로 시작했다 (브라우저가 데이터를 지웠을 가능성) */
  const [dataLost, setDataLost] = createSignal(false)
  const [lastBackup, setLastBackup] = createSignal<number | undefined>(readNumber(LAST_BACKUP))
  const backupCalls = new Map<number, { resolve(data: Uint8Array): void; reject(error: Error): void }>()
  const archiveCalls = new Map<number, (result: ArchiveResult) => void>()
  /** 연결했거나 기억하고 있는 보관 폴더 */
  let archiveHandle: FileSystemDirectoryHandle | undefined
  /** 방금 골랐지만 어느 쪽 내용을 살릴지 아직 정하지 않은 폴더 */
  let chosenHandle: FileSystemDirectoryHandle | undefined

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
        // 이 브라우저에서 쓴 적이 있는데 저장된 것이 없다면, 사용자가 모르는 사이에 지워진 것이다.
        if (ev.fresh && readNumber(SEEN) !== undefined) setDataLost(true)
        // 저장된 상태에서 시작한 적이 있어야 "쓰던 브라우저"다. 첫 방문만으로는 표시하지 않는다
        // (첫 저장이 끝나기 전에 닫혔다가 다시 열린 경우를 유실로 오해하지 않기 위해).
        if (ev.persistent && !ev.fresh) remember(SEEN, Date.now())
        setReady(true)
        return void restoreArchive()
      case 'backup-data':
        backupCalls.get(ev.id)?.resolve(ev.data)
        return backupCalls.delete(ev.id)
      case 'backup-failed': {
        const limit = mountLimit()
        const message =
          ev.reason === 'too-large'
            ? `백업이 너무 큽니다. 지금 한도는 ${limit.name}입니다. 위에서 한도를 올릴 수 있습니다.`
            : 'Web OS의 백업 파일이 아니거나 파일이 손상됐습니다.'
        backupCalls.get(ev.id)?.reject(new Error(message))
        return backupCalls.delete(ev.id)
      }
      case 'archive-result':
        archiveCalls.get(ev.id)?.(ev)
        return archiveCalls.delete(ev.id)
      case 'archive-error':
        return setArchive('error', '보관 폴더에 저장하지 못했습니다. 폴더가 옮겨졌거나 권한이 취소됐을 수 있습니다.')
      case 'spawn':
        return setProcs(produce((p) => p.push({ pid: ev.pid, ppid: ev.ppid, name: ev.argv.join(' ') })))
      case 'exit':
        return setProcs((p) => p.filter((x) => x.pid !== ev.pid))
      case 'trace':
        return tracers.forEach((listener) => listener(ev.records, ev.dropped))
      case 'flushed':
        return flushed?.()
      case 'restart':
        // 저장된 내용이 통째로 바뀌었다. 메모리에 남은 것을 버리고 저장소에서 다시 시작한다.
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

  // ───────────── 저장소 보호 ─────────────

  /** 사용량과 보호 여부를 다시 읽는다. */
  async function refreshStorage() {
    try {
      const [estimate, kept] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted()])
      setStorage({ usage: estimate.usage, quota: estimate.quota, protected: kept })
    } catch {
      // 저장소 정보를 알려 주지 않는 브라우저에서는 비워 둔다.
    }
  }

  /**
   * 브라우저에 "이 사이트의 데이터를 임의로 지우지 말라"고 요청한다. 허용됐으면 true.
   * 브라우저가 사용 빈도, 북마크, 설치 여부 등으로 스스로 판단하거나(Chrome, Safari) 사용자에게 묻는다(Firefox).
   */
  async function protectStorage(): Promise<boolean> {
    try {
      await navigator.storage.persist()
    } catch {
      // 지원하지 않으면 그대로 둔다.
    }
    await refreshStorage()
    return storage.protected === true
  }

  // Firefox는 이 요청에 권한 창을 띄운다. 페이지를 열자마자 창이 뜨면 거슬리므로,
  // 묻지 않고 판단하는 브라우저에서만 미리 요청하고 Firefox에서는 설정의 버튼으로 요청한다.
  if (navigator.userAgent.includes('Firefox')) void refreshStorage()
  else void protectStorage()

  // ───────────── 보관 폴더 ─────────────

  const ARCHIVE_KEY = 'archive'

  /** 커널에 보관 폴더 작업을 요청하고 결과를 기다린다. 실패하면 사용자에게 보여 줄 문장으로 거부된다. */
  async function requestArchive(handle: FileSystemDirectoryHandle, mode: ArchiveMode): Promise<'ok' | 'needs-choice'> {
    const limit = mountLimit()
    const result = await new Promise<ArchiveResult>((resolve) => {
      const id = nextRef++
      archiveCalls.set(id, resolve)
      send({ type: 'archive-link', id, handle, mode, maxFiles: limit.maxFiles, maxBytes: limit.maxBytes })
    })
    if (result.ok) return 'ok'
    switch (result.reason) {
      case 'needs-choice':
        return 'needs-choice'
      case 'not-empty':
        throw new Error('빈 폴더를 골라 주세요. 다른 파일이 들어 있는 폴더는 내용이 섞이거나 지워질 수 있어 받지 않습니다.')
      case 'too-large':
        throw new Error(
          `폴더가 너무 큽니다 (파일 ${result.files.toLocaleString()}개 이상, ${formatSize(result.bytes)} 이상). ` +
            `지금 한도는 ${limit.name}입니다. 아래에서 한도를 올릴 수 있습니다.`,
        )
      case 'failed':
        throw new Error(`폴더를 연결하지 못했습니다: ${result.msg}`)
    }
  }

  /** 연결을 확정한다: 상태를 바꾸고, 다음 방문 때 다시 고르지 않도록 폴더를 기억해 둔다. */
  async function linked(handle: FileSystemDirectoryHandle) {
    archiveHandle = handle
    chosenHandle = undefined
    setArchive({ state: 'linked', name: handle.name, error: undefined })
    await saveHandle(ARCHIVE_KEY, handle).catch(() => {})
  }

  /** 지난 방문 때 연결한 보관 폴더를 다시 잇는다. 권한이 남아 있지 않으면 사용자가 눌러 줄 때까지 기다린다. */
  async function restoreArchive() {
    if (!pickDirectory) return
    try {
      const handle = (await savedHandles()).get(ARCHIVE_KEY)
      if (!handle) return
      archiveHandle = handle
      setArchive({ state: 'paused', name: handle.name })
      if ((await (handle as PermissionedHandle).queryPermission({ mode: 'readwrite' })) !== 'granted') return
      await requestArchive(handle, 'attach')
      await linked(handle)
    } catch (e) {
      setArchive('error', e instanceof Error ? e.message : String(e))
    }
  }

  const archiveApi = {
    /** 이 브라우저가 로컬 폴더를 다룰 수 있는가 (데스크톱 Chromium 계열) */
    supported: pickDirectory !== undefined,
    status: archive,

    /**
     * 폴더 선택 창을 띄워 보관 폴더를 고른다. 반드시 클릭 같은 사용자 동작 안에서 불러야 한다.
     * 빈 폴더면 지금 내용을 내보내며 연결하고, 예전에 쓰던 보관 폴더면 needs-choice를 돌려준다.
     */
    async pick(): Promise<LinkOutcome> {
      if (!pickDirectory) throw new Error('이 브라우저는 로컬 폴더를 다룰 수 없습니다.')
      let handle: FileSystemDirectoryHandle
      try {
        handle = await pickDirectory({ mode: 'readwrite', id: 'webos-archive' })
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
        throw e
      }
      if ((await requestArchive(handle, 'auto')) === 'needs-choice') {
        chosenHandle = handle
        return 'needs-choice'
      }
      await linked(handle)
      return 'linked'
    },

    /**
     * 예전 보관 폴더를 골랐을 때의 선택.
     *  - export: 지금 브라우저의 내용으로 폴더를 덮어쓴다.
     *  - import: 폴더의 내용을 불러온다. 지금 브라우저의 내용은 사라지고 페이지가 다시 열린다.
     */
    async resolve(choice: 'export' | 'import' | 'cancel'): Promise<void> {
      const handle = chosenHandle
      chosenHandle = undefined
      if (!handle || choice === 'cancel') return
      if (choice === 'import') {
        // 다시 열린 뒤에 이어서 연결되도록 먼저 기억해 둔다.
        await saveHandle(ARCHIVE_KEY, handle).catch(() => {})
        try {
          await requestArchive(handle, 'import')
        } catch (e) {
          await forgetHandle(ARCHIVE_KEY).catch(() => {})
          throw e
        }
        return
      }
      await requestArchive(handle, 'export')
      await linked(handle)
    },

    /** 기억해 둔 보관 폴더의 권한을 다시 받아 잇는다. 사용자 동작 안에서 불러야 한다. */
    async resume(): Promise<void> {
      const handle = archiveHandle as PermissionedHandle | undefined
      if (!handle) return
      if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('폴더를 읽고 쓸 권한을 받지 못했습니다.')
      }
      await requestArchive(handle, 'attach')
      await linked(handle)
    },

    /** 연결을 끊고 잊는다. 폴더와 그 안의 파일은 그대로 남는다. */
    async unlink(): Promise<void> {
      if (archive.state === 'linked') {
        await new Promise<ArchiveResult>((resolve) => {
          const id = nextRef++
          archiveCalls.set(id, resolve)
          send({ type: 'archive-unlink', id })
        })
      }
      archiveHandle = undefined
      await forgetHandle(ARCHIVE_KEY).catch(() => {})
      setArchive({ state: 'none', name: undefined, error: undefined })
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
    /** 브라우저 저장소의 사용량과 보호 여부 */
    storage: { status: storage, refresh: refreshStorage, protect: protectStorage },
    /** 파일시스템 전체를 함께 저장해 두는 사용자의 로컬 폴더 */
    archive: archiveApi,
    dataLost,
    dismissDataLost: () => setDataLost(false),
    /** 파일시스템 전체를 파일 하나로 내보내고 되살린다. 어느 브라우저에서나 된다. */
    backup: {
      /** 마지막으로 백업 파일을 내려받은 시각 (밀리초). 없으면 undefined. */
      last: lastBackup,

      /** tar 형식의 백업 묶음을 만든다. */
      export(): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
          const id = nextRef++
          backupCalls.set(id, { resolve, reject })
          send({ type: 'backup-export', id })
        })
      },

      /** 사용자가 백업 파일을 실제로 내려받았음을 기록한다. */
      markSaved() {
        remember(LAST_BACKUP, Date.now())
        setLastBackup(Date.now())
      },

      /**
       * 백업 묶음의 내용으로 지금 내용을 통째로 바꾼다. 성공하면 페이지가 다시 열리므로 돌아오지 않고,
       * 받을 수 없는 파일이면 이유와 함께 거부된다 (그때 지금 내용은 그대로다).
       */
      import(data: Uint8Array): Promise<never> {
        const limit = mountLimit()
        return new Promise<never>((_, reject) => {
          const id = nextRef++
          backupCalls.set(id, { resolve() {}, reject })
          send({ type: 'backup-import', id, data, maxFiles: limit.maxFiles, maxBytes: limit.maxBytes })
        })
      },
    },
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
    /**
     * 브라우저에 저장된 내용을 지우고 처음 상태로 다시 시작한다.
     * 보관 폴더와의 연결도 끊는다 (그대로 두면 다음에 폴더의 예전 내용이 되살아난다). 폴더의 파일은 남는다.
     */
    async resetStorage() {
      // 일부러 지우는 것이므로, 다음에 "데이터가 사라졌다"고 알리지 않게 한다.
      forget(SEEN)
      await archiveApi.unlink().catch(() => {})
      send({ type: 'storage-reset' })
    },

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

    /** 저장을 마친 뒤 커널을 끈다. 커널이 응답하지 않아도 잠시 뒤에는 끈다. */
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        flushed = resolve
        setTimeout(resolve, 2000)
        send({ type: 'flush' })
      })
      kernel.terminate()
    },
  }
}

export type System = ReturnType<typeof createSystem>
