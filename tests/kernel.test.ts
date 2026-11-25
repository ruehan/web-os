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
    expect(r.stdout).toBe('28\ncat\nclear\nyes\n')
  })

  it('runs script files, directly and via sh', async () => {
    const { sh } = start()
    const expected = '안녕하세요, guest 님\n현재 위치: /home/guest\n28\n'
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

describe('system call tracing', () => {
  /** 추적을 켠 채 명령을 실행하고, 기록을 "프로그램: 호출(인자) 결과" 줄로 돌려준다. */
  async function traced(line: string) {
    const { kernel, events, sh } = start()
    kernel.setTracing(true)
    const run = await sh(line)
    await new Promise((r) => setTimeout(r, 120))
    const records = events.flatMap((e) => (e.type === 'trace' ? e.records : []))
    return { run, records, lines: records.map((r) => `${r.comm}: ${r.call}(${r.args}) ${r.result}`.trimEnd()) }
  }

  it('records what each program asks of the kernel', async () => {
    const { lines } = await traced('echo hi > /tmp/f; cat /tmp/f /nope')
    expect(lines).toContain('sh: open("/tmp/f", CREAT|TRUNC) = 4')
    expect(lines).toContain('sh: spawn("/bin/echo", ["echo", "hi"], stdio=[0,4,2]) = 2')
    expect(lines).toContain('echo: write(1, "hi\\n", 3) = 3')
    expect(lines).toContain('echo: exit(0)')
    expect(lines).toContain('sh: wait(2) = 2 (exit 0)')
    expect(lines).toContain('cat: open("/tmp/f") = 4')
    expect(lines).toContain('cat: read(4, 8192) = 3')
    expect(lines).toContain('cat: open("/nope") = -1 ENOENT')
    expect(lines).toContain('cat: exit(1)')
  })

  it('numbers records in order and marks failures', async () => {
    const { records } = await traced('cat /nope')
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i + 1))
    expect(records.filter((r) => r.error).map((r) => r.result)).toContain('= -1 ENOENT')
    expect(records.every((r) => r.time >= 0 && r.pid > 0)).toBe(true)
  })

  it('reports how long a blocked call waited', async () => {
    const { records } = await traced('sleep 0.3')
    const wait = records.find((r) => r.comm === 'sh' && r.call === 'wait')!
    expect(wait.result).toBe('= 2 (exit 0)')
    // 테스트 환경의 시계는 멈춰 있으므로 값의 크기가 아니라 기록 여부만 본다.
    expect(wait.waited).toBe(0)
    expect(records.find((r) => r.call === 'getpid')!.waited).toBeUndefined()
  })

  it('shows pipes, renames and a writer killed by a closed pipe', async () => {
    const { lines } = await traced('yes | head -n 1; touch /tmp/a; mv /tmp/a /tmp/b')
    expect(lines).toContain('sh: pipe() = [4, 5]')
    expect(lines.some((l) => /^sh: spawn\("\/bin\/yes", \["yes"\], stdio=\[0,5,2\]\) = \d+$/.test(l))).toBe(true)
    expect(lines.some((l) => l.startsWith('yes: write(1, "y\\ny\\n') && l.endsWith('= 종료됨'))).toBe(true)
    expect(lines).toContain('mv: rename("/tmp/a", "/tmp/b") = 0')
  })

  it('escapes binary data and truncates long writes', async () => {
    const { lines } = await traced('cat /bin/true | head -n 0; echo "0123456789012345678901234567890123456789"')
    expect(lines.some((l) => l.startsWith('cat: write(1, "\\x00asm\\x01\\x00\\x00\\x00'))).toBe(true)
    expect(lines).toContain('echo: write(1, "01234567890123456789012345678901"…, 41) = 41')
  })

  it('emits nothing unless tracing is on, and stops when turned off', async () => {
    const { kernel, events, sh } = start()
    await sh('echo quiet')
    await new Promise((r) => setTimeout(r, 120))
    expect(events.some((e) => e.type === 'trace')).toBe(false)

    kernel.setTracing(true)
    kernel.setTracing(false)
    await start().sh('echo quiet')
    expect(events.some((e) => e.type === 'trace')).toBe(false)
  })

  it('caps a flood and reports how many records were dropped', async () => {
    const { kernel, events, sh } = start()
    kernel.setTracing(true)
    await sh('yes | head -n 20000 | wc -l')
    await new Promise((r) => setTimeout(r, 150))
    const batches = events.flatMap((e) => (e.type === 'trace' ? [e] : []))
    expect(batches.every((b) => b.records.length <= 400)).toBe(true)
    const kept = batches.reduce((n, b) => n + b.records.length, 0)
    const dropped = batches.reduce((n, b) => n + b.dropped, 0)
    expect(dropped).toBeGreaterThan(0)
    // 번호는 버린 호출에도 매겨지므로, 남긴 것과 버린 것을 합치면 마지막 번호 이상이 된다.
    const last = batches.at(-1)!.records.at(-1)!
    expect(last.seq).toBeGreaterThan(kept)
    expect(kept + dropped).toBeGreaterThanOrEqual(last.seq)
  })
})

describe('/proc', () => {
  it('exposes each process as a directory', async () => {
    const r = await start().sh('ls /proc | head -n 3; cat /proc/1/status; cat /proc/version /proc/mounts')
    expect(r.stdout).toMatch(/^1\n2\n3\n/)
    expect(r.stdout).toContain('Name:\tsh\nState:\tS (sleeping)\nPid:\t1\nPPid:\t0\nPgid:\t1\nTty:\t-\nFds:\t4\n')
    expect(r.stdout).toContain('Web OS 0.5 (wasm32-wasip1)\nmemfs / rw\nopfs /home rw,persistent\nprocfs /proc ro\n')
  })

  it('keeps arguments NUL-separated in cmdline', async () => {
    const { kernel, sh } = start()
    await sh('cat /proc/1/cmdline > /tmp/cmdline')
    expect([...kernel.fs.readFile('/tmp/cmdline')].filter((b) => b === 0).length).toBe(3)
    expect(new TextDecoder().decode(kernel.fs.readFile('/tmp/cmdline')).split('\0')[0]).toBe('sh')
  })

  it('entries disappear when the process exits', async () => {
    const r = await start().sh('sleep 0.2 & cat /proc/2/cmdline | wc -c; sleep 0.4; cat /proc/2/status')
    expect(r.stdout).toMatch(/^\[2\]\n10\n$/)
    expect(r.stderr).toBe('cat: /proc/2/status: No such file or directory\n')
  })

  it('ps lists processes with their parent, state and command', async () => {
    const term = await start().terminal()
    await term.exec('sleep 5 &')
    const out = (await term.exec('ps | cat')).split('\n')
    expect(out[0]).toBe('  PID  PPID STAT TTY COMMAND')
    expect(out[1]).toBe('    1     0 S    1   sh')
    expect(out[2]).toBe('    2     1 R    1   sleep 5')
    expect(out.slice(3).map((l) => l.replace(/^\s+\d+/, ''))).toEqual(['     1 R    1   ps', '     1 S    1   cat'])
  })

  it('reading /proc does not count as a filesystem change', async () => {
    const { kernel, events, until } = start()
    kernel.fsRequest({ op: 'list', path: '/' })
    await until(() => events.some((e) => e.type === 'fs-change'), 'the initial notification')
    const before = events.filter((e) => e.type === 'fs-change').length
    expect(kernel.fsRequest({ op: 'list', path: '/proc' }).entries!.map((e) => e.name)).toEqual(['version', 'uptime', 'mounts'])
    await new Promise((r) => setTimeout(r, 200))
    expect(events.filter((e) => e.type === 'fs-change').length).toBe(before)
  })
})

describe('mv and cp', () => {
  it('renames and moves files and directories', async () => {
    const r = await start().sh(
      'cd /tmp; echo a > one; mkdir d; mv one two; mv two d; ls d; mv d e; cat e/two; touch x; mv x e/two; mv e e/inside; mv nope y',
    )
    expect(r.stdout).toBe('two\na\n')
    expect(r.stderr).toBe('mv: x: File exists\nmv: e: Invalid argument\nmv: nope: No such file or directory\n')
  })

  it('copies files and, with -r, directories', async () => {
    const r = await start().sh(
      'cd /tmp; mkdir -p a/b; echo hi > a/b/f; cp a/b/f g; cat g; cp a c; cp -r a c; cat c/b/f; echo more >> c/b/f; cat a/b/f',
    )
    expect(r.stdout).toBe('hi\nhi\nhi\n')
    expect(r.stderr).toBe('cp: a: Is a directory (use -r)\n')
  })
})

describe('file requests from the desktop', () => {
  const text = (b?: Uint8Array) => new TextDecoder().decode(b)
  const bytes = (s: string) => new TextEncoder().encode(s)

  it('lists, reads, writes, renames and removes', () => {
    const { kernel } = start()
    const names = (path: string) => kernel.fsRequest({ op: 'list', path }).entries!.map((e) => e.name)
    expect(names('/')).toEqual(['bin', 'tmp', 'home', 'etc', 'proc'])
    expect(kernel.fsRequest({ op: 'list', path: '/home/guest' }).entries).toContainEqual({
      name: 'hello.sh',
      dir: false,
      size: kernel.fs.readFile('/home/guest/hello.sh').length,
    })

    kernel.fsRequest({ op: 'mkdir', path: '/tmp/docs' })
    kernel.fsRequest({ op: 'write', path: '/tmp/docs/a.txt', data: bytes('한글') })
    expect(text(kernel.fsRequest({ op: 'read', path: '/tmp/docs/a.txt' }).data)).toBe('한글')
    kernel.fsRequest({ op: 'write', path: '/tmp/docs/a.txt', data: bytes('x') })
    expect(text(kernel.fsRequest({ op: 'read', path: '/tmp/docs/a.txt' }).data)).toBe('x')

    kernel.fsRequest({ op: 'rename', from: '/tmp/docs/a.txt', to: '/tmp/b.txt' })
    expect(names('/tmp/docs')).toEqual([])
    kernel.fsRequest({ op: 'rename', from: '/tmp/b.txt', to: '/tmp/docs/b.txt' })
    kernel.fsRequest({ op: 'remove', path: '/tmp/docs' })
    expect(names('/tmp')).toEqual([])
  })

  it('reports failures with an errno', () => {
    const { kernel } = start()
    const errno = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return (e as KernelError).errno
      }
    }
    expect(errno(() => kernel.fsRequest({ op: 'list', path: '/nope' }))).toBe(Errno.NOENT)
    expect(errno(() => kernel.fsRequest({ op: 'list', path: '/etc/motd' }))).toBe(Errno.NOTDIR)
    expect(errno(() => kernel.fsRequest({ op: 'read', path: '/tmp' }))).toBe(Errno.ISDIR)
    expect(errno(() => kernel.fsRequest({ op: 'mkdir', path: '/tmp' }))).toBe(Errno.EXIST)
    expect(errno(() => kernel.fsRequest({ op: 'rename', from: '/tmp', to: '/etc' }))).toBe(Errno.EXIST)
    expect(errno(() => kernel.fsRequest({ op: 'rename', from: '/home', to: '/home/guest/x' }))).toBe(Errno.INVAL)
  })

  it('announces changes made by processes, coalescing bursts', async () => {
    const { kernel, events, until, sh } = start()
    const changes = () => events.filter((e) => e.type === 'fs-change').length
    // 부팅 때 올린 초기 파일에 대한 알림이 한 번 나간 뒤로는, 읽기만 해서는 알림이 없다.
    kernel.fsRequest({ op: 'list', path: '/' })
    await until(() => changes() === 1, 'the initial notification')
    kernel.fsRequest({ op: 'read', path: '/etc/motd' })
    await new Promise((r) => setTimeout(r, 200))
    expect(changes()).toBe(1)

    await sh('cd /tmp; touch a b c d e; rm a b')
    await until(() => changes() > 1, 'a change notification')
    await new Promise((r) => setTimeout(r, 250))
    // 파일 일곱 개가 바뀌었지만 알림은 묶여서 나간다.
    expect(changes()).toBeLessThanOrEqual(4)
  })
})

describe('terminal', () => {
  it('shows the motd and a prompt, and runs typed commands', async () => {
    const term = await start().terminal()
    expect(term.screen()).toContain('Web OS')
    expect(await term.exec('echo hi')).toBe('hi')
    expect(await term.exec('cd /tmp')).toBe('')
    expect(term.lastLine()).toBe('guest@webos:/tmp$')
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

  it('a foreground program reads the keyboard line by line, with editing, until Ctrl+D', async () => {
    const term = await start().terminal()
    term.type('cat\r')
    term.type('가나\x7f다x\x7f\r')
    await term.waitFor('가다\n가다')
    term.type('\x04')
    await term.waitForLine('guest@webos:~$')
  })

  it('a pipeline reading the keyboard works', async () => {
    const term = await start().terminal()
    term.type('cat | wc -l\r')
    term.type('a\rb\r\x04')
    await term.waitFor('a\nb\n2\nguest@webos')
  })

  it('keys typed while a command runs are not lost', async () => {
    const term = await start().terminal()
    term.type('sleep 0.3\r')
    term.type('echo late')
    await term.waitForLine('guest@webos:~$ echo late')
    expect(await term.exec('')).toBe('late')
  })

  it('reports finished background jobs at the next prompt', async () => {
    const term = await start().terminal()
    expect(await term.exec('sleep 0.1 &')).toMatch(/^\[\d+\]$/)
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

describe('line editor', () => {
  const LEFT = '\x1b[D'
  const RIGHT = '\x1b[C'
  const UP = '\x1b[A'
  const DOWN = '\x1b[B'
  const HOME = '\x1b[H'
  const END = '\x1b[F'
  const DELETE = '\x1b[3~'
  const P = 'guest@webos:~$'

  it('moves the cursor and inserts or deletes in the middle of the line', async () => {
    const term = await start().terminal()
    term.type('echo ac' + LEFT + 'b')
    await os.until(
      () => term.lastLine() === `${P} echo abc` && term.emu.cx === P.length + 1 + 'echo ab'.length,
      'inserted character with the cursor right after it',
    )
    term.type(HOME + DELETE + 'E' + END + '!' + LEFT + LEFT + '\x7f' + RIGHT + RIGHT + '?')
    await term.waitForLine(`${P} Echo ac!?`)
    term.type('\x15echo ok')
    await term.waitForLine(`${P} echo ok`)
    expect(await term.exec('')).toBe('ok')
  })

  it('Ctrl+A, Ctrl+E, Ctrl+K and Ctrl+W edit the line', async () => {
    const term = await start().terminal()
    term.type('one two three\x17\x17')
    await term.waitForLine(`${P} one`)
    term.type('\x15echo junk\x01' + RIGHT + RIGHT + RIGHT + RIGHT + '\x0b')
    await term.waitForLine(`${P} echo`)
    term.type(' x\x01\x05y')
    await term.waitForLine(`${P} echo xy`)
    expect(await term.exec('')).toBe('xy')
  })

  it('handles wide characters when moving and deleting', async () => {
    const term = await start().terminal()
    term.type('echo 가나다' + LEFT + '\x7f' + LEFT + '라')
    await os.until(
      () => term.lastLine() === `${P} echo 라가다` && term.emu.cx === P.length + 1 + 'echo '.length + 2,
      'edited line with the cursor after the inserted character',
    )
    expect(await term.exec('')).toBe('라가다')
  })

  it('recalls earlier commands with the arrow keys and keeps the draft', async () => {
    const term = await start().terminal()
    await term.exec('echo one')
    await term.exec('echo two')
    await term.exec('echo two')
    term.type('dra' + UP)
    await term.waitForLine(`${P} echo two`)
    term.type(UP)
    await term.waitForLine(`${P} echo one`)
    term.type(UP + DOWN + DOWN)
    await term.waitForLine(`${P} dra`)
    term.type(UP + UP + '!')
    await term.waitForLine(`${P} echo one!`)
    expect(await term.exec('')).toBe('one!')
  })

  it('Ctrl+C abandons the line without running it', async () => {
    const term = await start().terminal()
    term.type('echo nope\x03')
    await term.waitFor(`${P} echo nope^C\n${P}`)
    expect(await term.exec('echo ok')).toBe('ok')
    term.type(UP)
    await term.waitForLine(`${P} echo ok`)
  })

  it('redraws correctly when the line wraps across rows', async () => {
    const term = await start().terminal(30, 10)
    const text = 'echo 0123456789abcdefghij가나다라마'
    term.type(text)
    await term.waitFor('마')
    const rowsBefore = term.screen().split('\n').length
    term.type(HOME + RIGHT + RIGHT + RIGHT + RIGHT + RIGHT + 'X')
    await term.waitFor('X0123')
    // 줄 처음으로 돌아가 한 글자를 넣어도 프롬프트 줄이 중복으로 그려지지 않는다.
    expect(term.screen().split('\n').length).toBe(rowsBefore)
    expect(term.screen().split(P).length).toBe(2)
    term.type(END)
    // 출력도 화면 폭에서 줄이 넘어가므로 이어 붙여 비교한다.
    expect((await term.exec('')).replace('\n', '')).toBe('X0123456789abcdefghij가나다라마')
  })

  it('handles a line that ends exactly at the right edge', async () => {
    const term = await start().terminal(30, 10)
    const fill = 'x'.repeat(30 - (P.length + 1) - 'echo '.length)
    term.type('echo ' + fill)
    await term.waitFor(fill)
    expect([term.emu.cx, term.lastLine()]).toEqual([0, `${P} echo ${fill}`])
    term.type('y')
    await term.waitFor(fill + '\ny')
    term.type('\x7f')
    await os.until(() => term.screen().endsWith(fill) && term.emu.cx === 0, 'cursor back on the fresh row')
    expect(await term.exec('')).toBe(fill)
  })

  it('completes command names', async () => {
    const term = await start().terminal()
    term.type('exitc\t')
    await os.until(() => term.lastLine() === `${P} exitcode` && term.emu.cx === `${P} exitcode `.length, 'completed name')
    term.type('3')
    await term.waitForLine(`${P} exitcode 3`)
    await term.exec('')
    expect(await term.exec('echo $?')).toBe('3')
  })

  it('completes file and directory names, including after a pipe', async () => {
    const term = await start().terminal()
    term.type('cat REA\t')
    await term.waitForLine(`${P} cat README.md`)
    term.type('| gr\t')
    await term.waitForLine(`${P} cat README.md | grep`)
    term.type('-c 프로세스')
    await term.waitForLine(`${P} cat README.md | grep -c 프로세스`)
    expect(await term.exec('')).toBe('2')

    term.type('ls /ho\t')
    await term.waitForLine(`${P} ls /home/`)
    term.type('gu\t')
    await term.waitForLine(`${P} ls /home/guest/`)
    term.type('\x15ls ~/he\t')
    await term.waitForLine(`${P} ls ~/hello.sh`)
  })

  it('fills in the common prefix, then lists the candidates', async () => {
    const term = await start().terminal()
    await term.exec('cd /tmp && touch alpha-one alpha-two beta')
    term.type('ls al\t')
    await term.waitForLine('guest@webos:/tmp$ ls alpha-')
    term.type('\t')
    await term.waitFor('alpha-one  alpha-two\nguest@webos:/tmp$ ls alpha-')
    term.type('t\t')
    await term.waitForLine('guest@webos:/tmp$ ls alpha-two')
  })

  it('accepts several pasted lines at once', async () => {
    const term = await start().terminal()
    term.type('echo a\recho b\recho c')
    await term.waitForLine(`${P} echo c`)
    expect(term.screen()).toContain(`${P} echo a\na\n${P} echo b\nb\n${P} echo c`)
  })

  it('does not overwrite output that lacks a trailing newline', async () => {
    const term = await start().terminal(40, 10)
    expect(await term.exec('echo -n partial')).toBe('partial%')
    expect(await term.exec('echo full')).toBe('full')
    // 화면 폭을 정확히 채운 출력 뒤에도 빈 줄이나 표시가 끼지 않는다.
    const row = 'x'.repeat(40)
    os.kernel.fs.writeFile('/tmp/line', new TextEncoder().encode(row + '\n'))
    os.kernel.fs.writeFile('/tmp/open', new TextEncoder().encode(row))
    expect(await term.exec('cat /tmp/line')).toBe(row)
    // 줄바꿈 없이 화면 끝에서 딱 끝난 경우에는 표시 없이 다음 줄에 프롬프트가 온다.
    expect(await term.exec('cat /tmp/open')).toBe(row)
    expect(term.screen()).not.toContain('\n\n\n')
  })

  it('Ctrl+L clears the screen and keeps the line', async () => {
    const term = await start().terminal()
    await term.exec('echo something')
    term.type('echo kept\x0c')
    await os.until(() => term.screen() === `${P} echo kept`, 'cleared screen with the line kept')
    expect(term.emu.cy).toBe(0)
  })
})

describe('waiting for input with a time limit', () => {
  it('top refreshes on its own while no key is pressed', async () => {
    const term = await start().terminal(60, 12)
    term.type('top\r')
    await term.waitFor('프로세스 2개')
    // 그사이 다른 터미널에서 프로세스가 생기면 다음 갱신 때 나타난다.
    os.kernel.spawn('/bin/spin', ['spin'])
    await os.until(() => term.screen().includes('프로세스 3개') && term.screen().includes('spin'), 'top to show the new process', 3000)
    term.type('q')
    await term.waitForLine('guest@webos:~$')
  })

  it('a pending wait is cancelled when the process is killed', async () => {
    const term = await start().terminal(60, 12)
    term.type('top\r')
    await term.waitFor('프로세스 2개')
    const top = os.kernel.pids().at(-1)!
    os.kernel.kill(top)
    await term.waitForLine('guest@webos:~$')
    // 죽은 프로세스의 타이머가 나중에 터져도 문제가 없어야 한다.
    await new Promise((r) => setTimeout(r, 1200))
    expect(await term.exec('echo ok')).toBe('ok')
  })
})

describe('full-screen programs', () => {
  const UP = '\x1b[A'
  const DOWN = '\x1b[B'
  const ESC = '\x1b'
  const P = 'guest@webos:~$'

  describe('top', () => {
    it('takes over the screen and gives it back on exit', async () => {
      const term = await start().terminal(60, 12)
      await term.exec('echo before')
      const before = term.screen()

      term.type('top\r')
      await term.waitFor('COMMAND')
      expect(term.emu.alternate).toBe(true)
      expect(term.emu.cursorVisible).toBe(false)
      const rows = term.emu.screenText()
      expect(rows[0]).toMatch(/^가동 \d+초 · 프로세스 2개 \(실행 1, 대기 1\)$/)
      expect(rows[2]).toBe('  PID  PPID S TTY     TIME COMMAND')
      expect(rows[3]).toMatch(/^\s+1\s+0 S 1\s+[\d.]+ sh$/)
      expect(rows[4]).toMatch(/^\s+\d+\s+1 R 1\s+[\d.]+ top$/)
      expect(rows.at(-1)).toBe('↑↓ 선택   x 선택한 프로세스 종료   q 나가기')
      // 머리줄은 화면 폭 전체가 반전되어 있다.
      expect(term.emu.lines[2]!.cells.filter((c) => c.inverse).length).toBe(60)

      term.type('q')
      await term.waitForLine(P)
      expect(term.emu.alternate).toBe(false)
      expect(term.emu.cursorVisible).toBe(true)
      expect(term.screen()).toBe(`${before} top\n${P}`)
    })

    it('selects with the arrow keys and kills the selected process', async () => {
      const term = await start().terminal(60, 12)
      await term.exec('sleep 30 &')
      term.type('top\r')
      await term.waitFor('sleep 30')
      const selected = () => term.emu.lines.findIndex((l, i) => i > 2 && l.cells.some((c) => c.inverse))
      // 처음에는 top 자신이 선택되어 있다.
      await os.until(() => term.emu.screenText()[selected()]?.endsWith('top'), 'top to be selected')

      term.type(UP)
      await os.until(() => term.emu.screenText()[selected()]?.endsWith('sleep 30'), 'sleep to be selected')
      term.type('x')
      await term.waitFor('번 프로세스(sleep 30)를 종료했습니다.')
      await os.until(() => !term.screen().includes('TIME COMMAND\n') || !/sleep 30$/m.test(term.emu.screenText().slice(3, -1).join('\n')), 'sleep to leave the list')
      term.type('q')
      await term.waitForLine(P)
      expect(os.kernel.pids().length).toBe(1)
    })

    it('prints once when its output is not a terminal', async () => {
      const r = await start().sh('top | cat')
      const lines = r.stdout.split('\n')
      expect(lines[0]).toMatch(/^가동 \d+초 · 프로세스 3개/)
      expect(lines[1]).toBe('  PID  PPID S TTY     TIME COMMAND')
      expect(lines.slice(2, 5).map((l) => l.split(/\s+/).at(-1))).toEqual(['cat', 'cat', 'cat'].map((_, i) => ['top | cat', 'top', 'cat'][i]!.split(' ').at(-1)))
      expect(r.stdout).not.toContain('\x1b')
    })
  })

  describe('vi', () => {
    /** vi를 띄우고 화면이 그려질 때까지 기다린다. */
    async function vi(args = '', cols = 40, rows = 10) {
      const term = await start().terminal(cols, rows)
      term.type(`vi ${args}\r`)
      await os.until(() => term.emu.alternate && term.emu.screenText().some((l) => l.startsWith('~') || l.length > 0), 'vi to draw')
      const status = () => term.emu.screenText().at(-2)!
      const bottom = () => term.emu.screenText().at(-1)!
      const body = () => term.emu.screenText().slice(0, -2)
      const press = async (keys: string, until: () => boolean, what: string) => {
        term.type(keys)
        await os.until(until, what)
      }
      const file = (path: string) => new TextDecoder().decode(os.kernel.fs.readFile(path))
      return { term, status, bottom, body, press, file }
    }

    it('opens a file and shows it with a status line', async () => {
      const { term, status, bottom, body } = await vi('hello.sh')
      await os.until(() => bottom().includes('hello.sh'), 'the open message')
      expect(body()[0]).toBe('# 셸 스크립트 예제')
      expect(body()[1]).toBe('NAME=${USER}')
      expect(body().at(-1)).toBe('~')
      expect(status()).toMatch(/^ hello\.sh\s+1:1 {2}5줄$/)
      expect(bottom()).toBe('"hello.sh" 5줄')
      expect([term.emu.cx, term.emu.cy]).toEqual([0, 0])
      expect(term.emu.cursorVisible).toBe(true)
    })

    it('inserts text, saves and quits back to the shell', async () => {
      const { term, status, bottom, press, file } = await vi('/tmp/new.txt')
      await os.until(() => bottom() === '"/tmp/new.txt" [새 파일]', 'the new-file message')

      await press('i', () => bottom() === '-- 입력 --', 'insert mode')
      await press('첫 줄\r둘째 줄', () => term.emu.screenText()[1] === '둘째 줄', 'typed text')
      expect(status()).toMatch(/new\.txt \[\+\]\s+2:5 {2}2줄$/)
      // 2칸 글자 뒤에 커서가 정확히 놓인다.
      expect([term.emu.cx, term.emu.cy]).toEqual([7, 1])

      await press(ESC, () => bottom() === '', 'normal mode')
      await press(':w\r', () => bottom().includes('저장'), 'the save message')
      expect(bottom()).toBe('"/tmp/new.txt" 2줄, 19바이트 저장')
      expect(file('/tmp/new.txt')).toBe('첫 줄\n둘째 줄\n')
      expect(status()).not.toContain('[+]')

      term.type(':q\r')
      await term.waitForLine(P)
      expect(term.emu.alternate).toBe(false)
      expect(await term.exec('cat /tmp/new.txt')).toBe('첫 줄\n둘째 줄')
    })

    it('moves, deletes, copies, pastes and undoes in normal mode', async () => {
      os = boot()
      os.kernel.fs.writeFile('/tmp/t', new TextEncoder().encode('one two three\nsecond\nthird\n'))
      const term = await os.terminal(40, 10)
      term.type('vi /tmp/t\r')
      const body = () => term.emu.screenText().slice(0, 3)
      const cursor = () => [term.emu.cx, term.emu.cy]
      const at = (x: number, y: number) => () => cursor().join() === `${x},${y}`
      await os.until(() => term.emu.alternate && body()[2] === 'third', 'vi to draw')
      const press = async (keys: string, until: () => boolean, what: string) => {
        term.type(keys)
        await os.until(until, what)
      }

      await press('w', at(4, 0), 'w to reach "two"')
      await press('w', at(8, 0), 'w to reach "three"')
      await press('b', at(4, 0), 'b to return to "two"')
      await press('$', at(12, 0), '$ to reach the end')
      await press('0', at(0, 0), '0 to reach the start')
      await press('G', at(0, 2), 'G to reach the last line')
      await press('gg', at(0, 0), 'gg to reach the first line')
      await press('jl', at(1, 1), 'j and l to move')

      await press('x', () => body()[1] === 'scond', 'x to delete a character')
      await press('dd', () => body().join('|') === 'one two three|third|~', 'dd to delete the line')
      await press('p', () => body().join('|') === 'one two three|third|scond', 'p to paste it below')
      await press('ggyyP'.replace('P', 'p'), () => term.emu.screenText()[1] === 'one two three', 'yy and p to duplicate')
      await press('u', () => term.emu.screenText().slice(0, 3).join('|') === 'one two three|third|scond', 'u to undo the paste')
      await press('uuu', () => body().join('|') === 'one two three|second|third', 'u to undo everything')
      await press('u', () => term.emu.screenText().at(-1) === '더 되돌릴 것이 없습니다', 'the nothing-to-undo message')

      // 되돌리기는 커서도 그때 자리로 돌려놓으므로, 첫 줄로 올라간 뒤 이어서 고친다.
      await press('ggA!' + ESC + 'ofour' + ESC, () => term.emu.screenText().slice(0, 2).join('|') === 'one two three!|four', 'A and o')
      await press('Ozero' + ESC, () => term.emu.screenText().slice(0, 3).join('|') === 'one two three!|zero|four', 'O')
      await press(':wq\r', () => !term.emu.alternate, 'vi to exit')
      expect(new TextDecoder().decode(os.kernel.fs.readFile('/tmp/t'))).toBe('one two three!\nzero\nfour\nsecond\nthird\n')
    })

    it('joins and splits lines while inserting', async () => {
      os = boot()
      os.kernel.fs.writeFile('/tmp/t', new TextEncoder().encode('abcd\nef\n'))
      const term = await os.terminal(40, 10)
      term.type('vi /tmp/t\r')
      const text = () => term.emu.screenText().slice(0, 3).join('|')
      await os.until(() => term.emu.alternate && text() === 'abcd|ef|~', 'vi to draw')
      term.type('lli\r')
      await os.until(() => text() === 'ab|cd|ef', 'Enter to split the line')
      term.type('\x7f')
      await os.until(() => text() === 'abcd|ef|~', 'Backspace to join it again')
      term.type('\tX' + ESC + ':wq\r')
      await os.until(() => !term.emu.alternate, 'vi to exit')
      expect(new TextDecoder().decode(os.kernel.fs.readFile('/tmp/t'))).toBe('ab\tXcd\nef\n')
    })

    it('searches forward and wraps around', async () => {
      const { term, bottom, press } = await vi('README.md', 60, 12)
      await os.until(() => bottom().includes('README.md'), 'the open message')
      const cursorLine = () => term.emu.screenText()[term.emu.cy]!
      await press('/프로세스', () => bottom() === '/프로세스', 'the search prompt')
      await press('\r', () => cursorLine().includes('프로세스') && bottom() === '', 'the first match')
      const first = term.emu.cy
      await press('n', () => term.emu.cy !== first || bottom() !== '', 'the next match')
      await press('nnnn', () => bottom() === '끝까지 찾아 처음부터 다시 찾았습니다', 'the wrap-around message')
      await press('/없는말\r', () => bottom() === '찾을 수 없습니다: 없는말', 'the not-found message')
      term.type(':q\r')
      await term.waitForLine(P)
    })

    it('scrolls to keep the cursor visible, vertically and horizontally', async () => {
      os = boot()
      const long = 'x'.repeat(30) + '한글' + 'y'.repeat(30)
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
      os.kernel.fs.writeFile('/tmp/t', new TextEncoder().encode([long, ...lines].join('\n') + '\n'))
      const term = await os.terminal(20, 8)
      term.type('vi /tmp/t\r')
      await os.until(() => term.emu.alternate && term.emu.screenText()[1] === 'line 1', 'vi to draw')

      term.type('$')
      await os.until(() => term.emu.screenText()[0] === 'y'.repeat(20), 'the view to follow the cursor right')
      expect(term.emu.cx).toBe(19)
      term.type('0')
      await os.until(() => term.emu.screenText()[0] === 'x'.repeat(20), 'the view to return left')

      term.type('G')
      await os.until(() => term.emu.screenText().slice(0, 6).at(-1) === 'line 30', 'the view to follow the cursor down')
      expect(term.emu.screenText()[0]).toBe('line 25')
      term.type(':3\r')
      await os.until(() => term.emu.screenText()[0] === 'line 2', 'jumping to a line number')
      term.type(':q\r')
      await os.until(() => !term.emu.alternate, 'vi to exit')
    })

    it('refuses to quit with unsaved changes unless forced', async () => {
      const { term, bottom, press, file } = await vi('hello.sh')
      await press('dd', () => term.emu.screenText()[0] === 'NAME=${USER}', 'dd')
      await press(':q\r', () => bottom().startsWith('저장하지 않은 변경이 있습니다'), 'the warning')
      expect(term.emu.alternate).toBe(true)
      await press(':nope\r', () => bottom() === '모르는 명령입니다: nope', 'the unknown-command message')
      term.type(':q!\r')
      await term.waitForLine(P)
      expect(file('/home/guest/hello.sh')).toMatch(/^# 셸 스크립트 예제\n/)
    })

    it('saves under a new name and needs one for an unnamed buffer', async () => {
      const { term, bottom, press, file } = await vi('', 80)
      await press('ihi' + ESC + ':w\r', () => bottom() === '파일 이름이 없습니다 (:w 이름)', 'the missing-name message')
      await press(':w /tmp/named.txt\r', () => bottom().includes('저장'), 'the save message')
      expect(file('/tmp/named.txt')).toBe('hi\n')
      await press(':w /nowhere/x\r', () => bottom().includes('저장하지 못했습니다'), 'the failure message')
      expect(bottom()).toBe('"/nowhere/x" 에 저장하지 못했습니다: No such file or directory')
      term.type(':q\r')
      await term.waitForLine(P)
    })

    it('Escape cancels a command, and Backspace on an empty prompt leaves it', async () => {
      const { bottom, press } = await vi('hello.sh')
      await press(':wq', () => bottom() === ':wq', 'the prompt')
      await press(ESC, () => bottom() === '', 'Escape to cancel')
      await press(':x', () => bottom() === ':x', 'the prompt again')
      await press('\x7f', () => bottom() === ':', 'Backspace to erase')
      await press('\x7f', () => bottom() === '', 'Backspace to leave the prompt')
    })

    it('will not start without a terminal', async () => {
      const r = await start().sh('echo | vi')
      expect(r.stderr).toBe('vi: 터미널에서만 실행할 수 있습니다\n')
      expect(r.code).toBe(1)
    })
  })

  it('the shell restores the terminal after a full-screen program is killed', async () => {
    const term = await start().terminal(60, 12)
    await term.exec('echo before')
    term.type('vi\r')
    await os.until(() => term.emu.alternate, 'vi to take over the screen')
    os.kernel.kill(os.kernel.pids().at(-1)!)
    await term.waitForLine(P)
    expect(term.emu.alternate).toBe(false)
    expect(term.emu.cursorVisible).toBe(true)
    expect(term.screen()).toContain('before')
    // 키 단위 입력 모드로 남아 있지 않아서, 다음 프로그램이 평소처럼 줄 단위로 입력받는다.
    term.type('cat\r')
    term.type('ab\x7fc\r')
    await term.waitFor('ac\nac')
    term.type('\x04')
    await term.waitForLine(P)
  })
})
