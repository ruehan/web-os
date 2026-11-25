// 커널 Worker 진입점. 메인 스레드의 명령을 받고, 프로세스 Worker를 직접 띄운다.
import type { KernelCommand, KernelEvent, SysReq } from './abi'
import { KernelError } from './errno'
import { Kernel } from './kernel'

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

async function boot(): Promise<void> {
  kernel.log('kernel: booting')
  kernel.log(`kernel: cross-origin isolated = ${self.crossOriginIsolated}`)
  kernel.log('vfs: mounted memfs on /')

  const base = import.meta.env.BASE_URL
  const names: string[] = await (await fetch(`${base}bin/manifest.json`)).json()
  await Promise.all(
    names.map(async (name) => {
      const res = await fetch(`${base}bin/${name}.wasm`)
      if (!res.ok) throw new Error(`failed to load /bin/${name}: HTTP ${res.status}`)
      kernel.fs.writeFile(`/bin/${name}`, new Uint8Array(await res.arrayBuffer()))
    }),
  )
  kernel.log(`initrd: installed ${names.length} programs in /bin (${names.join(', ')})`)
  kernel.log('kernel: ready')
  emit({ type: 'ready' })
}

self.onmessage = (e: MessageEvent<KernelCommand>) => {
  const cmd = e.data
  try {
    if (cmd.type === 'spawn') kernel.spawn(cmd.path, cmd.argv, cmd.env)
    else kernel.kill(cmd.pid)
  } catch (err) {
    if (!(err instanceof KernelError)) throw err
    emit({ type: 'error', msg: err.message })
  }
}

boot().catch((err) => emit({ type: 'error', msg: `boot failed: ${err instanceof Error ? err.message : err}` }))
