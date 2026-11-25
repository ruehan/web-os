// 커널 Worker 진입점. 메인 스레드의 명령을 받고, 프로세스 Worker를 직접 띄운다.
import type { KernelCommand, KernelEvent, SysReq } from './abi.ts'
import { KernelError } from './errno.ts'
import { Kernel } from './kernel.ts'

const emit = (event: KernelEvent) => self.postMessage(event)

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

/** 빌드 때 만들어 둔 초기 파일들(실행 파일과 기본 문서)을 메모리 파일시스템에 올린다. */
async function loadInitrd(): Promise<Initrd> {
  const base = import.meta.env.BASE_URL
  const fetchBytes = async (url: string) => {
    const res = await fetch(base + url)
    if (!res.ok) throw new Error(`failed to load ${url}: HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
  const initrd: Initrd = JSON.parse(new TextDecoder().decode(await fetchBytes('initrd.json')))
  await Promise.all([
    ...initrd.bin.map(async (name) => kernel.fs.writeFile(`/bin/${name}`, await fetchBytes(`bin/${name}.wasm`))),
    ...initrd.files.map(async (path) => {
      const data = await fetchBytes(`rootfs/${path}`)
      kernel.fs.mkdirp(`/${path}`.slice(0, `/${path}`.lastIndexOf('/')))
      kernel.fs.writeFile(`/${path}`, data)
    }),
  ])
  return initrd
}

async function boot(): Promise<void> {
  kernel.log('kernel: booting')
  kernel.log(`kernel: cross-origin isolated = ${self.crossOriginIsolated}`)
  kernel.log('vfs: mounted memfs on /')
  const initrd = await loadInitrd()
  kernel.log(`initrd: ${initrd.bin.length} programs in /bin, ${initrd.files.length} files`)
  kernel.log('kernel: ready')
  emit({ type: 'ready' })
}

self.onmessage = (e: MessageEvent<KernelCommand>) => {
  const cmd = e.data
  try {
    if (cmd.type === 'tty-open') kernel.openTerminal(cmd.cols, cmd.rows)
    else if (cmd.type === 'tty-resize') kernel.ttyResize(cmd.tty, cmd.cols, cmd.rows)
    else if (cmd.type === 'tty-input') kernel.ttyInput(cmd.tty, cmd.text)
    else kernel.kill(cmd.pid)
  } catch (err) {
    if (!(err instanceof KernelError)) throw err
    emit({ type: 'error', msg: err.message })
  }
}

boot().catch((err) => emit({ type: 'error', msg: `boot failed: ${err instanceof Error ? err.message : err}` }))
