// 실제 Rust 바이너리를 커널 위에서 돌려 보는 통합 테스트.
// Worker 대신 같은 스레드에서 실행하지만, 시스템 콜은 브라우저와 똑같이
// 공유 메모리 채널을 거친다.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { armChannel, waitReply, type KernelEvent, type ProcessInit } from '../src/kernel/abi'
import { Errno, KernelError } from '../src/kernel/errno'
import { Kernel } from '../src/kernel/kernel'
import { runWasi } from '../src/process/wasi'

const binDir = new URL('../public/bin/', import.meta.url)
const programs: string[] = JSON.parse(readFileSync(new URL('manifest.json', binDir), 'utf8'))

function boot() {
  const events: KernelEvent[] = []
  const launched: ProcessInit[] = []
  const kernel = new Kernel({
    emit: (e) => events.push(e),
    now: () => 0,
    launch(init) {
      launched.push(init)
      return { terminate() {} }
    },
  })
  for (const name of programs) {
    kernel.fs.writeFile(`/bin/${name}`, readFileSync(new URL(`${name}.wasm`, binDir)))
  }

  const run = (argv: string[], env: Record<string, string> = {}) => {
    const pid = kernel.spawn(`/bin/${argv[0]}`, argv, env)
    const init = launched.pop()!
    runWasi(init.module, init.argv, init.env, {
      call(req) {
        armChannel(init.channel)
        kernel.syscall(pid, req)
        return waitReply(init.channel)
      },
      send: (req) => kernel.syscall(pid, req),
    })
    const out = (fd: number) =>
      events
        .filter((e) => e.type === 'tty' && e.pid === pid && e.fd === fd)
        .map((e) => new TextDecoder().decode((e as { data: Uint8Array }).data))
        .join('')
    const exit = events.find((e) => e.type === 'exit' && e.pid === pid) as { code: number } | undefined
    return { pid, stdout: out(1), stderr: out(2), code: exit?.code }
  }

  return { kernel, events, run }
}

describe('kernel running real WASI binaries', () => {
  it('runs hello with argv and env', () => {
    const { run, kernel } = boot()
    const r = run(['hello', 'world'], { USER: 'guest' })
    expect(r.stdout).toBe('Hello from a real WASM process!\nargv = ["hello", "world"]\nUSER = guest\n')
    expect(r.code).toBe(0)
    expect(kernel.pids()).toEqual([])
  })

  it('propagates the exit code', () => {
    const { run } = boot()
    expect(run(['exitcode', '42']).code).toBe(42)
  })

  it('creates, appends, seeks and stats files through syscalls', () => {
    const { run, kernel } = boot()
    const r = run(['fsdemo'])
    expect(r.stdout).toBe('first line\nsecond line\nseek(6) -> line\nsize = 23\n')
    expect(r.stderr).toBe('open missing: NotFound\n')
    expect(r.code).toBe(0)
    expect(new TextDecoder().decode(kernel.fs.readFile('/tmp/note.txt'))).toBe('first line\nsecond line\n')
  })

  it('assigns increasing pids and keeps files across processes', () => {
    const { run, kernel } = boot()
    const a = run(['fsdemo'])
    const b = run(['hello'])
    expect(b.pid).toBe(a.pid + 1)
    expect(kernel.fs.readFile('/tmp/note.txt').length).toBe(23)
  })

  it('rejects missing and invalid executables', () => {
    const { kernel } = boot()
    kernel.fs.writeFile('/bin/garbage', new TextEncoder().encode('not wasm'))
    const errno = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return (e as KernelError).errno
      }
    }
    expect(errno(() => kernel.spawn('/bin/nope', ['nope']))).toBe(Errno.NOENT)
    expect(errno(() => kernel.spawn('/bin/garbage', ['garbage']))).toBe(Errno.NOEXEC)
    expect(errno(() => kernel.spawn('/bin', ['bin']))).toBe(Errno.ISDIR)
    expect(kernel.pids()).toEqual([])
  })

  it('kill reaps the process with status 137', () => {
    const { kernel, events } = boot()
    const pid = kernel.spawn('/bin/spin', ['spin'])
    expect(kernel.pids()).toEqual([pid])
    kernel.kill(pid)
    expect(kernel.pids()).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'exit', pid, code: 137 })
    expect(() => kernel.kill(pid)).toThrow(KernelError)
  })
})
