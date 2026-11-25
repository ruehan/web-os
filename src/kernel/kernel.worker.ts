// 커널 Worker 진입점. 메인 스레드의 명령을 받고, 프로세스 Worker를 직접 띄운다.
import type { KernelCommand, KernelEvent, SysReq } from './abi.ts'
import { KernelError } from './errno.ts'
import { Kernel } from './kernel.ts'
import { TooLarge, directoryStore, measure, type Dir } from './dirstore.ts'
import { clearOpfs, openOpfs } from './opfs.ts'
import { Persister } from './persist.ts'

/** /home 을 브라우저 저장소와 맞춰 두는 동기화기. 저장소를 쓸 수 없으면 없다. */
let persister: Persister | undefined
/** 연결된 로컬 폴더들. 이름 → 그 폴더(/mnt/<이름>)의 동기화기 */
const mounts = new Map<string, Persister>()

const emit = (event: KernelEvent) => {
  // 파일이 바뀌었다는 알림은 화면뿐 아니라 영구 저장의 신호이기도 하다.
  if (event.type === 'fs-change') {
    persister?.schedule()
    for (const mount of mounts.values()) mount.schedule()
  }
  self.postMessage(event)
}

const kernel: Kernel = new Kernel({
  emit,
  now: () => performance.now(),
  launch(init) {
    const worker = new Worker(new URL('../process/process.worker.ts', import.meta.url), {
      type: 'module',
      name: `pid-${init.pid}`,
    })
    worker.onmessage = (e: MessageEvent<SysReq>) => kernel.syscall(init.pid, e.data)
    worker.onerror = (e) => kernel.crashed(init.pid, e.message)
    worker.postMessage(init)
    return { terminate: () => worker.terminate() }
  },
})

interface Initrd {
  bin: string[]
  files: string[]
}

const PERSISTED = '/home'

/**
 * 지난 방문 때 /home 에 남긴 파일을 되살린다.
 * 돌려주는 값은 "기본 파일을 새로 깔아야 하는가"다 (첫 방문이거나 저장소를 쓸 수 없을 때).
 */
async function restoreHome(): Promise<boolean> {
  try {
    const store = await openOpfs()
    persister = new Persister(kernel.fs, PERSISTED, store)
    persister.onError = (e) => kernel.log(`storage: failed to save: ${e instanceof Error ? e.message : e}`)
    const files = await persister.restore()
    kernel.log(
      store.fresh ? `storage: created persistent ${PERSISTED}` : `storage: restored ${files} files to ${PERSISTED}`,
    )
    return store.fresh
  } catch (e) {
    kernel.log(`storage: unavailable, ${PERSISTED} will not survive a reload (${e instanceof Error ? e.message : e})`)
    return true
  }
}

/**
 * 빌드 때 만들어 둔 초기 파일들(실행 파일과 기본 문서)을 메모리 파일시스템에 올린다.
 * 사용자가 고치거나 지웠을 수 있는 /home 의 기본 파일은 처음 한 번만 깐다.
 */
async function loadInitrd(installHome: boolean): Promise<Initrd> {
  const base = import.meta.env.BASE_URL
  const fetchBytes = async (url: string) => {
    const res = await fetch(base + url)
    if (!res.ok) throw new Error(`failed to load ${url}: HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
  const initrd: Initrd = JSON.parse(new TextDecoder().decode(await fetchBytes('initrd.json')))
  const files = initrd.files.filter((path) => installHome || !`/${path}`.startsWith(`${PERSISTED}/`))
  await Promise.all([
    ...initrd.bin.map(async (name) => kernel.fs.writeFile(`/bin/${name}`, await fetchBytes(`bin/${name}.wasm`))),
    ...files.map(async (path) => {
      const data = await fetchBytes(`rootfs/${path}`)
      kernel.fs.mkdirp(`/${path}`.slice(0, `/${path}`.lastIndexOf('/')))
      kernel.fs.writeFile(`/${path}`, data)
    }),
  ])
  return { bin: initrd.bin, files }
}

async function boot(): Promise<void> {
  kernel.log('kernel: booting')
  kernel.log(`kernel: cross-origin isolated = ${self.crossOriginIsolated}`)
  kernel.log('vfs: mounted memfs on /')
  const installHome = await restoreHome()
  const initrd = await loadInitrd(installHome)
  kernel.log(`initrd: ${initrd.bin.length} programs in /bin, ${initrd.files.length} files`)
  persister?.schedule()
  kernel.log('kernel: ready')
  emit({ type: 'ready' })
}

/** 저장된 파일을 모두 지운다. 진행 중이던 저장이 끝난 뒤에 지워야 다시 생기지 않는다. */
async function resetStorage(): Promise<void> {
  await persister?.stop()
  await clearOpfs()
  emit({ type: 'storage-reset' })
}

/** 미뤄 둔 저장을 지금 모두 끝낸다 (다른 탭에 자리를 넘겨주기 직전 등). */
async function flush(): Promise<void> {
  await persister?.sync()
  for (const mount of mounts.values()) await mount.sync()
  emit({ type: 'flushed' })
}

const MOUNT_ROOT = '/mnt'
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 사용자가 고른 로컬 폴더를 /mnt/<이름> 에 연결한다. */
async function mountLocal(cmd: Extract<KernelCommand, { type: 'mount' }>): Promise<void> {
  const path = `${MOUNT_ROOT}/${cmd.name}`
  const root = cmd.handle as Dir
  try {
    // 통째로 메모리에 올리기 전에 크기부터 확인한다.
    await measure(root, cmd)
    // 로컬 파일은 쓰기 스트림으로 바꿔 쓴다. 닫는 순간 내용이 한꺼번에 교체된다.
    const store = directoryStore(root, async (file, data) => {
      const writable = await file.createWritable()
      await writable.write(data as Uint8Array<ArrayBuffer>)
      await writable.close()
    })
    kernel.fs.mkdirp(path)
    const mount = new Persister(kernel.fs, path, store)
    mount.onError = (e) => {
      kernel.log(`mount: failed to save to ${path}: ${describe(e)}`)
      emit({ type: 'mount-error', name: cmd.name, msg: describe(e) })
    }
    const files = await mount.restore()
    mounts.set(cmd.name, mount)
    kernel.mounts.set(path, 'localdir')
    kernel.log(`mount: local folder "${root.name}" on ${path} (${files} files)`)
    emit({ type: 'mount-result', id: cmd.id, ok: true, path, files })
    emit({ type: 'fs-change' })
  } catch (e) {
    if (e instanceof TooLarge) {
      emit({ type: 'mount-result', id: cmd.id, ok: false, reason: 'too-large', files: e.files, bytes: e.bytes })
    } else {
      emit({ type: 'mount-result', id: cmd.id, ok: false, reason: 'failed', msg: describe(e) })
    }
  }
}

/** 연결을 끊는다. 아직 저장하지 못한 변경을 마저 쓴 뒤, 메모리의 사본만 지운다 (실제 파일은 그대로 남는다). */
async function unmountLocal(cmd: Extract<KernelCommand, { type: 'unmount' }>): Promise<void> {
  const mount = mounts.get(cmd.name)
  const path = `${MOUNT_ROOT}/${cmd.name}`
  if (mount) {
    await mount.sync()
    await mount.stop()
    mounts.delete(cmd.name)
    kernel.mounts.delete(path)
    const parent = kernel.fs.lookup(kernel.fs.root, MOUNT_ROOT)
    if (parent.kind === 'dir' && parent.entries.has(cmd.name)) kernel.fs.removeTree(parent, cmd.name)
    kernel.log(`mount: disconnected ${path}`)
  }
  emit({ type: 'mount-result', id: cmd.id, ok: true, path, files: 0 })
  emit({ type: 'fs-change' })
}

self.onmessage = (e: MessageEvent<KernelCommand>) => {
  const cmd = e.data
  try {
    if (cmd.type === 'tty-open') kernel.openTerminal(cmd.cols, cmd.rows, cmd.ref)
    else if (cmd.type === 'tty-close') kernel.closeTerminal(cmd.tty)
    else if (cmd.type === 'storage-reset') void resetStorage()
    else if (cmd.type === 'trace') kernel.setTracing(cmd.on)
    else if (cmd.type === 'flush') void flush()
    else if (cmd.type === 'mount') void mountLocal(cmd)
    else if (cmd.type === 'unmount') void unmountLocal(cmd)
    else if (cmd.type === 'fs') emit({ type: 'fs-result', id: cmd.id, result: kernel.fsRequest(cmd.request) })
    else if (cmd.type === 'tty-resize') kernel.ttyResize(cmd.tty, cmd.cols, cmd.rows)
    else if (cmd.type === 'tty-input') kernel.ttyInput(cmd.tty, cmd.text)
    else kernel.kill(cmd.pid)
  } catch (err) {
    if (!(err instanceof KernelError)) throw err
    if (cmd.type === 'fs') emit({ type: 'fs-result', id: cmd.id, errno: err.errno })
    else emit({ type: 'error', msg: err.message })
  }
}

boot().catch((err) => emit({ type: 'error', msg: `boot failed: ${err instanceof Error ? err.message : err}` }))
