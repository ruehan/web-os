// 커널 Worker 진입점. 메인 스레드의 명령을 받고, 프로세스 Worker를 직접 띄운다.
import type { KernelCommand, KernelEvent, SysReq } from './abi.ts'
import { KernelError } from './errno.ts'
import { Kernel } from './kernel.ts'
import { clearOpfs, openOpfs } from './opfs.ts'
import { Persister } from './persist.ts'

/** /home 을 브라우저 저장소와 맞춰 두는 동기화기. 저장소를 쓸 수 없으면 없다. */
let persister: Persister | undefined

const emit = (event: KernelEvent) => {
  // 파일이 바뀌었다는 알림은 화면뿐 아니라 영구 저장의 신호이기도 하다.
  if (event.type === 'fs-change') persister?.schedule()
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

self.onmessage = (e: MessageEvent<KernelCommand>) => {
  const cmd = e.data
  try {
    if (cmd.type === 'tty-open') kernel.openTerminal(cmd.cols, cmd.rows, cmd.ref)
    else if (cmd.type === 'tty-close') kernel.closeTerminal(cmd.tty)
    else if (cmd.type === 'storage-reset') void resetStorage()
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
