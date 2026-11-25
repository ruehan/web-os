// 실제 Rust 바이너리를 커널 위에서 돌리는 테스트 환경.
// 커널은 테스트 스레드에서, 각 프로세스는 별도 스레드에서 실행된다.
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { KernelEvent } from '../src/kernel/abi.ts'
import { Kernel } from '../src/kernel/kernel.ts'

const publicDir = new URL('../public/', import.meta.url)
const initrd: { bin: string[]; files: string[] } = JSON.parse(readFileSync(new URL('initrd.json', publicDir), 'utf8'))

const SHELL_ENV = { USER: 'guest', HOME: '/home/guest', PWD: '/home/guest', PATH: '/bin' }
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const PROMPT = /guest@webos:[^\n]*\$ $/

export function boot() {
  const events: KernelEvent[] = []
  const workers = new Set<Worker>()
  let notify = () => {}

  const kernel: Kernel = new Kernel({
    emit(event) {
      events.push(event)
      notify()
    },
    now: () => 0,
    launch(init) {
      const worker = new Worker(new URL('./process.node-worker.ts', import.meta.url))
      workers.add(worker)
      worker.on('message', (req) => kernel.syscall(init.pid, req))
      worker.on('error', (e: Error) => kernel.crashed(init.pid, e.message))
      worker.postMessage(init)
      return {
        terminate() {
          workers.delete(worker)
          void worker.terminate()
        },
      }
    },
  })
  for (const name of initrd.bin) kernel.fs.writeFile(`/bin/${name}`, readFileSync(new URL(`bin/${name}.wasm`, publicDir)))
  for (const path of initrd.files) {
    kernel.fs.mkdirp(`/${path}`.slice(0, `/${path}`.lastIndexOf('/')))
    kernel.fs.writeFile(`/${path}`, readFileSync(new URL(`rootfs/${path}`, publicDir)))
  }

  /** 조건이 참이 될 때까지 커널 이벤트를 기다린다. */
  async function until<T>(check: () => T | undefined | false, what: string, timeout = 4000): Promise<T> {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = check()
      if (value !== undefined && value !== false) return value
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timed out waiting for ${what}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        notify = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }

  const text = (chunks: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(chunks))

  /** 터미널 없이 프로세스 하나를 끝까지 실행한다. */
  async function run(argv: string[], env: Record<string, string> = SHELL_ENV) {
    const pid = kernel.spawn(`/bin/${argv[0]}`, argv, env)
    const exit = await until(
      () => events.find((e) => e.type === 'exit' && e.pid === pid) as { code: number } | undefined,
      `${argv.join(' ')} to exit`,
    )
    // 자식 프로세스도 같은 콘솔을 물려받으므로 pid로 거르지 않는다.
    const out = (fd: number) => text(events.flatMap((e) => (e.type === 'stdio' && e.fd === fd ? [e.data] : [])))
    return { pid, code: exit.code, stdout: out(1), stderr: out(2) }
  }

  /** 셸 명령 한 줄을 실행한다. */
  const sh = (line: string) => run(['sh', '-c', line])

  /** 터미널을 열고 키보드 입력을 흉내 낸다. */
  async function terminal() {
    const id = kernel.openTerminal()
    const raw = () => text(events.flatMap((e) => (e.type === 'tty-output' && e.tty === id ? [e.data] : [])))
    const screen = () => raw().replace(ANSI, '').replaceAll('\r\n', '\n')
    const atPrompt = () => PROMPT.test(screen())
    await until(atPrompt, 'first prompt')
    return {
      id,
      raw,
      screen,
      type: (keys: string) => kernel.ttyInput(id, keys),
      waitFor: (needle: string) => until(() => screen().includes(needle), `"${needle}" on screen`),
      /** 한 줄을 입력하고, 다음 프롬프트가 나올 때까지의 출력을 돌려준다. */
      async exec(line: string) {
        const before = screen().length
        kernel.ttyInput(id, line + '\r')
        await until(() => screen().length > before + line.length && atPrompt(), `prompt after "${line}"`)
        const lines = screen().slice(before).split('\n')
        return lines.slice(1, -1).join('\n')
      },
      closed: () => until(() => events.some((e) => e.type === 'tty-close' && e.tty === id), 'terminal to close'),
    }
  }

  async function shutdown() {
    await Promise.all([...workers].map((w) => w.terminate()))
  }

  return { kernel, events, until, run, sh, terminal, shutdown }
}
