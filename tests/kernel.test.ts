import { afterEach, describe, expect, it } from 'vitest'
import { Errno, KernelError } from '../src/kernel/errno.ts'
import { boot } from './host.ts'

let os: ReturnType<typeof boot>
const start = () => (os = boot())
afterEach(() => os?.shutdown())

describe('processes', () => {
  it('runs a binary with argv and env', async () => {
    const r = await start().run(['hello', 'world'], { USER: 'guest' })
    expect(r.stdout).toBe('Hello from a real WASM process!\nargv = ["hello", "world"]\nUSER = guest\n')
    expect(r.code).toBe(0)
    expect(os.kernel.pids()).toEqual([])
  })

  it('propagates the exit code', async () => {
    expect((await start().run(['exitcode', '42'])).code).toBe(42)
  })

  it('creates, appends, seeks and stats files through syscalls', async () => {
    const r = await start().run(['fsdemo'])
    expect(r.stdout).toBe('first line\nsecond line\nseek(6) -> line\nsize = 23\n')
    expect(r.stderr).toBe('open missing: NotFound\n')
    expect(r.code).toBe(0)
    expect(new TextDecoder().decode(os.kernel.fs.readFile('/tmp/note.txt'))).toBe('first line\nsecond line\n')
  })

  it('rejects missing and invalid executables', () => {
    const { kernel } = start()
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

  it('kill ends a busy process with status 137', async () => {
    const { kernel, events, until } = start()
    const pid = kernel.spawn('/bin/spin', ['spin'])
    await until(() => events.some((e) => e.type === 'stdio'), 'spin output')
    kernel.kill(pid)
    expect(kernel.pids()).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'exit', pid, code: 137 })
    expect(() => kernel.kill(pid)).toThrow(KernelError)
  })

  it('sleep really blocks the process', async () => {
    const t = Date.now()
    const r = await start().sh('sleep 0.3; echo done')
    expect(r.stdout).toBe('done\n')
    expect(Date.now() - t).toBeGreaterThanOrEqual(300)
  })
})

describe('shell', () => {
  it('connects commands with a pipe', async () => {
    expect((await start().sh('echo hello | cat')).stdout).toBe('hello\n')
  })

  it('runs a three-stage pipeline over a file', async () => {
    const r = await start().sh('cat README.md | grep 프로세스 | wc -l')
    expect(r.stdout).toBe('2\n')
    expect(r.code).toBe(0)
  })

  it('stops an endless writer when the reader exits', async () => {
    const r = await start().sh('yes | head -n 3')
    expect(r.stdout).toBe('y\ny\ny\n')
    expect(os.kernel.pids()).toEqual([])
  })

  it('applies backpressure: data larger than the pipe arrives intact', async () => {
    const { kernel, sh } = start()
    const expected = kernel.fs.readFile('/bin/sh').length
    expect(expected).toBeGreaterThan(64 * 1024)
    expect((await sh('cat /bin/sh | cat | wc -c')).stdout).toBe(`${expected}\n`)
  })

  it('redirects input and output', async () => {
    const r = await start().sh('echo a > /tmp/x; echo b >> /tmp/x; cat < /tmp/x')
    expect(r.stdout).toBe('a\nb\n')
    expect(new TextDecoder().decode(os.kernel.fs.readFile('/tmp/x'))).toBe('a\nb\n')
  })

  it('handles ;, && and || with exit codes', async () => {
    const r = await start().sh('false && echo no; false || echo yes; true && echo ok; exitcode 7')
    expect(r.stdout).toBe('yes\nok\n')
    expect(r.code).toBe(7)
  })

  it('expands variables and respects quoting', async () => {
    const r = await start().sh(`A=1; B="x  y"; echo "$A" '$A' \${A}b "$B" \\$A $NOPE "" end; false; echo $?`)
    expect(r.stdout).toBe('1 $A 1b x  y $A  end\n1\n')
  })

  it('passes per-command and exported variables to children', async () => {
    const r = await start().sh('export X=1; env | grep X=; Y=2 env | grep -c Y=2; env | grep -c Y=2; X=3 env | grep X=')
    expect(r.stdout).toBe('X=1\n1\n0\nX=3\n')
  })

  it('reports unknown commands with status 127', async () => {
    const r = await start().sh('nosuch arg')
    expect(r.stderr).toBe('sh: nosuch: command not found\n')
    expect(r.code).toBe(127)
  })

  it('reports syntax errors', async () => {
    const r = await start().sh('echo "oops')
    expect(r.stderr).toBe('sh: syntax error: unterminated quote\n')
    expect(r.code).toBe(2)
  })

  it('cd changes where relative paths resolve, for the shell and its children', async () => {
    const r = await start().sh('cd /tmp && pwd && echo hi > f && cat f && mkdir d && cd d && pwd && cd .. && ls')
    expect(r.stdout).toBe('/tmp\nhi\n/tmp/d\nd\nf\n')
    expect(os.kernel.fs.readFile('/tmp/f').length).toBe(3)
  })

  it('lists, creates and removes directories', async () => {
    const r = await start().sh(
      'mkdir -p /tmp/a/b; touch /tmp/a/f /tmp/a/.hidden; ls /tmp/a; ls -a /tmp/a | wc -l; ls -l /tmp/a; rm /tmp/a; rm -r /tmp/a; ls /tmp',
    )
    expect(r.stdout).toBe('b\nf\n3\nd        0 b\n-        0 f\n')
    expect(r.stderr).toBe('rm: /tmp/a: Is a directory (use -r)\n')
  })

  it('lists many entries across multiple readdir calls', async () => {
    const r = await start().sh('ls /bin | wc -l; ls /bin | head -n 2; ls /bin | tail -n 1')
    expect(r.stdout).toBe('23\ncat\nclear\nyes\n')
  })

  it('runs script files, directly and via sh', async () => {
    const { sh } = start()
    const expected = '안녕하세요, guest 님\n현재 위치: /home/guest\n23\n'
    expect((await sh('sh hello.sh')).stdout).toBe(expected)
    expect((await start().sh('./hello.sh')).stdout).toBe(expected)
  })

  it('runs background jobs without waiting', async () => {
    const r = await start().sh('sleep 0.2 & echo fg')
    expect(r.stdout).toMatch(/^\[\d+\]\nfg\n$/)
  })

  it('grep supports -i -v -n and sets its exit status', async () => {
    const { sh } = start()
    expect((await sh('echo "Rust\ngo\nrusty" | grep -in rust')).stdout).toBe('1:Rust\n3:rusty\n')
    expect((await start().sh('echo "a\nb" | grep -v a; echo x | grep y; echo $?')).stdout).toBe('b\n1\n')
  })

  it('wc counts lines, words and bytes', async () => {
    const r = await start().sh('echo "one two\nthree" > /tmp/w; wc /tmp/w; wc -w < /tmp/w')
    expect(r.stdout).toBe('      2       3      14 /tmp/w\n3\n')
  })
})

describe('terminal', () => {
  it('shows the motd and a prompt, and runs typed commands', async () => {
    const term = await start().terminal()
    expect(term.screen()).toContain('Web OS')
    expect(await term.exec('echo hi')).toBe('hi')
    expect(await term.exec('cd /tmp')).toBe('')
    expect(term.screen().endsWith('guest@webos:/tmp$ ')).toBe(true)
  })

  it('edits the line with backspace, including wide characters', async () => {
    const term = await start().terminal()
    term.type('echo 가나\x7f')
    await term.waitFor('가나')
    expect(term.raw().endsWith('\b\b  \b\b')).toBe(true)
    expect(await term.exec('다x\x7f')).toBe('가다')
  })

  it('Ctrl+C kills the foreground job but not the shell', async () => {
    const term = await start().terminal()
    term.type('spin\r')
    await term.waitFor('spinning... 0s')
    term.type('\x03')
    await term.waitFor('^C\nguest@webos')
    expect(await term.exec('echo $?')).toBe('130')
    expect(os.kernel.pids().length).toBe(1)
  })

  it('Ctrl+C at the prompt discards the line', async () => {
    const term = await start().terminal()
    term.type('echo nope\x03')
    await term.waitFor('nope^C\nguest@webos:~$ ')
    expect(await term.exec('echo ok')).toBe('ok')
  })

  it('a foreground program reads the keyboard until Ctrl+D', async () => {
    const term = await start().terminal()
    term.type('cat\r')
    term.type('hello\r')
    await term.waitFor('hello\nhello\n')
    term.type('\x04')
    await term.waitFor('hello\nhello\nguest@webos:~$ ')
  })

  it('a pipeline reading the keyboard works', async () => {
    const term = await start().terminal()
    term.type('cat | wc -l\r')
    term.type('a\rb\r\x04')
    await term.waitFor('a\nb\n2\nguest@webos')
  })

  it('reports finished background jobs at the next prompt', async () => {
    const term = await start().terminal()
    const out = await term.exec('sleep 0.1 &')
    expect(out).toMatch(/^\[\d+\]$/)
    await new Promise((r) => setTimeout(r, 300))
    expect(await term.exec('true')).toMatch(/^\[\d+\] done \(0\)$/)
  })

  it('Ctrl+D at the prompt ends the session and its processes', async () => {
    const term = await start().terminal()
    await term.exec('spin > /tmp/out &')
    term.type('\x04')
    await term.closed()
    expect(os.kernel.pids()).toEqual([])
  })
})
