import {
  ExitStatus,
  FdFlags,
  FileType,
  OFlags,
  PAYLOAD_MAX,
  Pgid,
  Sys,
  WaitFlags,
  Whence,
  createChannel,
  writeReply,
  type FsRequest,
  type FsResult,
  type KernelEvent,
  type ProcessInit,
  type SysReq,
  type SysRes,
} from './abi.ts'
import { Errno, KernelError } from './errno.ts'
import { Pipe, WaitQueue } from './pipe.ts'
import { describeArgs, describeResult, sysName, type TraceRecord } from './trace.ts'
import { Tty } from './tty.ts'
import { MemFs, type DirNode, type FileNode } from './vfs/memfs.ts'

/**
 * 열린 파일. 자식에게 물려주면 같은 객체를 공유하고(오프셋도 공유),
 * 마지막 참조가 닫힐 때 해제된다.
 */
type OpenFile = { refs: number } & (
  | { kind: 'console' }
  | { kind: 'tty'; tty: Tty }
  | { kind: 'file'; node: FileNode; offset: number; append: boolean }
  | { kind: 'dir'; node: DirNode; preopen?: string }
  | { kind: 'pipe'; pipe: Pipe; end: 'read' | 'write' }
)

interface Process {
  pid: number
  ppid: number
  /** 프로세스 그룹. 파이프라인 하나가 한 그룹이고, Ctrl+C는 그룹 단위로 전달된다. */
  pgid: number
  argv: string[]
  /** 시작 시각 (부팅 후 밀리초) */
  startTime: number
  fds: Map<number, OpenFile>
  channel: SharedArrayBuffer
  handle: ProcessHandle
  tty?: Tty
  /** 터미널을 연 셸. 터미널이 닫히면 세션 전체가 끝난다. */
  sessionLeader: boolean
  children: Set<number>
  /** 종료했지만 아직 wait로 거두지 않은 자식의 종료 코드 */
  zombies: Map<number, number>
  childQ: WaitQueue
  /** 조건을 기다리며 미뤄 둔 시스템 콜 */
  pending?: SysReq
  blockedOn?: WaitQueue
  /** 지금의 시스템 콜이 처음 미뤄진 시각 (추적 기록의 대기 시간 계산용) */
  blockedSince?: number
  /** 시간 제한이 있는 대기의 타이머 */
  timer?: ReturnType<typeof setTimeout>
}

export interface ProcessHandle {
  terminate(): void
}

/** 커널이 바깥 세계(Worker 생성, 이벤트 전달)에 의존하는 부분. */
export interface KernelHost {
  emit(event: KernelEvent): void
  /** 프로세스 실행 컨텍스트를 만든다. 브라우저에서는 Worker다. */
  launch(init: ProcessInit): ProcessHandle
  now(): number
}

/** 시스템 콜을 지금 끝낼 수 없다. 큐가 깨워질 때 처음부터 다시 실행된다. */
class Block {
  queue: WaitQueue
  /** 이 시간(밀리초)이 지나도록 깨워지지 않으면 0을 돌려주며 끝낸다. 없으면 무한정 기다린다. */
  timeout?: number
  constructor(queue: WaitQueue, timeout?: number) {
    this.queue = queue
    this.timeout = timeout
  }
}

/** 시스템 콜 도중 호출한 프로세스가 종료됐다. 응답할 대상이 없다. */
class Gone {}

interface ExecOptions {
  path: string
  argv: string[]
  env: Record<string, string>
  stdio: [OpenFile, OpenFile, OpenFile]
  parent?: Process
  pgid?: number
  tty?: Tty
  sessionLeader?: boolean
}

/** 추적 기록을 묶어 보내는 간격과, 한 번에 보내는 최대 개수 */
const TRACE_FLUSH_MS = 50
const TRACE_BATCH_MAX = 400
/** 파일 변경 알림을 묶어 보내는 간격 */
const FS_NOTIFY_MS = 100
const VERSION = 'Web OS 0.5 (wasm32-wasip1)'
const SHELL = '/bin/sh'
const SHELL_ENV = { USER: 'guest', HOME: '/home/guest', PWD: '/home/guest', PATH: '/bin', TERM: 'webos' }

export class Kernel {
  readonly fs = new MemFs()
  private host: KernelHost
  private procs = new Map<number, Process>()
  private nextPid = 1
  private ttys = new Map<number, Tty>()
  private nextTty = 1
  private modules = new WeakMap<FileNode, { version: number; module: WebAssembly.Module }>()
  private notifiedGeneration = 0
  private notifyTimer: ReturnType<typeof setTimeout> | undefined
  /** 바깥 저장소에 연결된 경로와 그 종류 (/proc/mounts 표시용). 연결 자체는 호스트가 관리한다. */
  readonly mounts = new Map<string, string>([['/home', 'opfs']])
  private tracing = false
  private traceBuffer: TraceRecord[] = []
  private traceDropped = 0
  private traceSeq = 0
  private traceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(host: KernelHost) {
    this.host = host
    for (const dir of ['/bin', '/tmp', '/home/guest', '/etc', '/proc', '/mnt']) this.fs.mkdirp(dir)
  }

  log(msg: string): void {
    this.host.emit({ type: 'klog', time: this.host.now(), msg })
  }

  pids(): number[] {
    return [...this.procs.keys()]
  }

  // ───────────── 바깥(메인 스레드, 테스트)에서 부르는 진입점 ─────────────

  /** 터미널에 붙지 않은 프로세스를 띄운다. 출력은 stdio 이벤트로 나간다. */
  spawn(path: string, argv: string[], env: Record<string, string> = {}): number {
    const console: OpenFile = { kind: 'console', refs: 0 }
    return this.exec({ path, argv, env, stdio: [console, console, console] }).pid
  }

  /** 새 터미널 장치를 만들고 거기에 셸을 띄운다. */
  openTerminal(cols = 80, rows = 24, ref = 0): number {
    const id = this.nextTty++
    const tty: Tty = new Tty(id, {
      output: (data) => this.host.emit({ type: 'tty-output', tty: id, data }),
      interrupt: () => this.interrupt(tty),
      readable: () => this.wake(tty.readQ),
    })
    tty.cols = cols
    tty.rows = rows
    const file: OpenFile = { kind: 'tty', tty, refs: 0 }
    const shell = this.exec({
      path: SHELL,
      argv: ['sh'],
      env: SHELL_ENV,
      stdio: [file, file, file],
      tty,
      sessionLeader: true,
    })
    tty.fg = shell.pgid
    this.ttys.set(id, tty)
    this.host.emit({ type: 'tty-open', ref, tty: id, pid: shell.pid })
    return id
  }

  ttyInput(id: number, text: string): void {
    this.ttys.get(id)?.input(text)
  }

  /** 터미널 창이 닫혔다: 셸을 끝내면 그 세션의 프로세스가 모두 정리된다. */
  closeTerminal(id: number): void {
    for (const p of this.procs.values()) {
      if (p.tty?.id === id && p.sessionLeader) return this.reap(p.pid, ExitStatus.HANGUP)
    }
  }

  ttyResize(id: number, cols: number, rows: number): void {
    const tty = this.ttys.get(id)
    if (!tty) return
    tty.cols = cols
    tty.rows = rows
  }

  kill(pid: number): void {
    if (!this.procs.has(pid)) throw new KernelError(Errno.SRCH, `no such process: ${pid}`)
    this.reap(pid, ExitStatus.KILLED)
  }

  /** 프로세스가 시스템 콜 없이 비정상 종료했을 때(Worker 오류 등) 호출한다. */
  crashed(pid: number, reason: string): void {
    if (!this.procs.has(pid)) return
    this.log(`pid ${pid} crashed: ${reason}`)
    this.reap(pid, ExitStatus.ABORT)
  }

  /** 화면 쪽 앱의 파일 작업 요청을 처리한다. 실패하면 KernelError를 던진다. */
  fsRequest(req: FsRequest): FsResult {
    try {
      return this.fsDispatch(req)
    } finally {
      this.notifyFsChange()
    }
  }

  private fsDispatch(req: FsRequest): FsResult {
    const { fs } = this
    if ('path' in req && isProcPath(req.path.slice(1))) this.refreshProc()
    const parentOf = (path: string) => fs.lookupParent(fs.root, path)
    switch (req.op) {
      case 'list': {
        const dir = fs.lookup(fs.root, req.path)
        if (dir.kind !== 'dir') throw new KernelError(Errno.NOTDIR)
        return {
          entries: [...dir.entries].map(([name, node]) => ({
            name,
            dir: node.kind === 'dir',
            size: node.kind === 'file' ? node.size : node.entries.size,
          })),
        }
      }
      case 'read':
        return { data: fs.readFile(req.path) }
      case 'write':
        fs.writeFile(req.path, req.data)
        return {}
      case 'mkdir': {
        const { dir, name } = parentOf(req.path)
        fs.mkdir(dir, name)
        return {}
      }
      case 'remove': {
        const { dir, name } = parentOf(req.path)
        fs.removeTree(dir, name)
        return {}
      }
      case 'rename': {
        const from = parentOf(req.from)
        const to = parentOf(req.to)
        fs.rename(from.dir, from.name, to.dir, to.name)
        return {}
      }
    }
  }

  /**
   * /proc 의 내용을 지금의 커널 상태로 다시 만든다. 누군가 /proc 아래를 열거나 조회하려 할 때마다 부른다.
   * 이미 열려 있는 파일은 열었을 때의 내용을 그대로 본다.
   */
  private refreshProc(): void {
    const { fs } = this
    const text = (s: string) => new TextEncoder().encode(s)
    fs.quiet(() => {
      fs.mkdirp('/proc').entries.clear()
      fs.writeFile('/proc/version', text(`${VERSION}\n`))
      fs.writeFile('/proc/uptime', text(`${(this.host.now() / 1000).toFixed(2)}\n`))
      const mounts = [...this.mounts].map(([path, kind]) => `${kind} ${path} rw,persistent\n`).join('')
      fs.writeFile('/proc/mounts', text(`memfs / rw\n${mounts}procfs /proc ro\n`))
      for (const p of this.procs.values()) {
        fs.mkdirp(`/proc/${p.pid}`)
        // 조건을 기다리며 시스템 콜에 멈춰 있으면 S, 아니면 R
        const state = p.pending ? 'S (sleeping)' : 'R (running)'
        const fields: [string, string | number][] = [
          ['Name', p.argv[0] ?? ''],
          ['State', state],
          ['Pid', p.pid],
          ['PPid', p.ppid],
          ['Pgid', p.pgid],
          ['Tty', p.tty?.id ?? '-'],
          ['Fds', p.fds.size],
          ['StartTime', (p.startTime / 1000).toFixed(2)],
        ]
        fs.writeFile(`/proc/${p.pid}/status`, text(fields.map(([k, v]) => `${k}:\t${v}\n`).join('')))
        // 리눅스처럼 인자를 NUL 문자로 구분한다.
        fs.writeFile(`/proc/${p.pid}/cmdline`, text(p.argv.map((a) => a + '\0').join('')))
      }
    })
  }

  /** 파일시스템이 바뀌었으면 화면에 알린다. 연속된 변경은 한 번으로 묶는다. */
  private notifyFsChange(): void {
    if (this.fs.generation === this.notifiedGeneration || this.notifyTimer !== undefined) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      this.notifiedGeneration = this.fs.generation
      this.host.emit({ type: 'fs-change' })
    }, FS_NOTIFY_MS)
  }

  /** 시스템 콜 진입점. 응답은 채널에 쓰며, 조건이 안 되면 미뤄 둔다. */
  syscall(pid: number, req: SysReq): void {
    const proc = this.procs.get(pid)
    if (!proc) return
    this.dispatchSyscall(proc, req)
    this.notifyFsChange()
  }

  private dispatchSyscall(proc: Process, req: SysReq): void {
    const pid = proc.pid
    let res: SysRes
    try {
      res = this.dispatch(proc, req)
    } catch (e) {
      if (e instanceof Gone) {
        // 응답 없이 끝났다: exit이거나, 호출 도중 종료된 경우(끊긴 파이프에 쓰기 등)
        if (this.tracing) this.trace(proc, req, req.nr === Sys.exit ? undefined : { result: '= 종료됨', error: true })
        return
      }
      if (e instanceof Block) {
        proc.pending = req
        proc.blockedOn = e.queue
        proc.blockedSince ??= this.host.now()
        e.queue.pids.add(pid)
        // 깨워졌다가 다시 미뤄진 경우에는 처음 건 타이머를 그대로 둔다 (제한 시간은 처음부터 잰다).
        if (e.timeout !== undefined) proc.timer ??= setTimeout(() => this.timedOut(proc, req), e.timeout)
        return
      }
      if (!(e instanceof KernelError)) throw e
      res = { errno: e.errno }
    }
    this.reply(proc, req, res)
  }

  private reply(proc: Process, req: SysReq, res: SysRes): void {
    clearTimeout(proc.timer)
    proc.timer = undefined
    if (this.tracing) this.trace(proc, req, describeResult(req, res))
    proc.blockedSince = undefined
    writeReply(proc.channel, res)
  }

  /** 제한 시간 안에 조건이 충족되지 않았다: 기다림을 풀고 0을 돌려준다. */
  private timedOut(proc: Process, req: SysReq): void {
    proc.timer = undefined
    if (proc.pending !== req) return
    proc.blockedOn?.pids.delete(proc.pid)
    proc.pending = undefined
    proc.blockedOn = undefined
    this.reply(proc, req, { errno: 0, ret: 0 })
  }

  // ───────────── 시스템 콜 추적 ─────────────

  /** 추적을 켜면 모든 프로세스의 시스템 콜이 trace 이벤트로 나간다. */
  setTracing(on: boolean): void {
    this.tracing = on
    if (on) return
    clearTimeout(this.traceTimer)
    this.traceTimer = undefined
    this.traceBuffer = []
    this.traceDropped = 0
  }

  private trace(proc: Process, req: SysReq, outcome?: { result: string; error: boolean }): void {
    // 번호는 버린 호출에도 매기므로, 번호가 건너뛴 곳이 곧 기록이 빠진 곳이다.
    const seq = ++this.traceSeq
    // 화면이 따라올 수 없을 만큼 쏟아지면 넘치는 만큼은 세기만 한다.
    if (this.traceBuffer.length >= TRACE_BATCH_MAX) this.traceDropped++
    else {
      const now = this.host.now()
      this.traceBuffer.push({
        seq,
        time: now,
        pid: proc.pid,
        comm: proc.argv[0] ?? '',
        call: sysName(req.nr),
        args: describeArgs(req),
        result: outcome?.result ?? '',
        error: outcome?.error ?? false,
        waited: proc.blockedSince === undefined ? undefined : now - proc.blockedSince,
      })
    }
    this.traceTimer ??= setTimeout(() => {
      this.traceTimer = undefined
      const records = this.traceBuffer
      const dropped = this.traceDropped
      this.traceBuffer = []
      this.traceDropped = 0
      this.host.emit({ type: 'trace', records, dropped })
    }, TRACE_FLUSH_MS)
  }

  // ───────────── 프로세스 수명 ─────────────

  private exec(opts: ExecOptions): Process {
    const node = this.fs.lookup(this.fs.root, opts.path)
    if (node.kind !== 'file') throw new KernelError(Errno.ISDIR, `${opts.path}: is a directory`)
    const module = this.compile(node, opts.path)

    const pid = this.nextPid++
    const fds = new Map<number, OpenFile>()
    opts.stdio.forEach((file, fd) => {
      file.refs++
      fds.set(fd, file)
    })
    fds.set(3, { kind: 'dir', node: this.fs.root, preopen: '/', refs: 1 })

    const parent = opts.parent
    const proc: Process = {
      pid,
      ppid: parent?.pid ?? 0,
      pgid: opts.pgid || pid,
      argv: opts.argv,
      startTime: this.host.now(),
      fds,
      channel: createChannel(),
      handle: { terminate() {} },
      tty: opts.tty,
      sessionLeader: opts.sessionLeader ?? false,
      children: new Set(),
      zombies: new Map(),
      childQ: new WaitQueue(),
    }
    this.procs.set(pid, proc)
    parent?.children.add(pid)
    this.host.emit({ type: 'spawn', pid, ppid: proc.ppid, argv: opts.argv })
    proc.handle = this.host.launch({ pid, module, argv: opts.argv, env: opts.env, channel: proc.channel })
    return proc
  }

  private compile(node: FileNode, path: string): WebAssembly.Module {
    const cached = this.modules.get(node)
    if (cached?.version === node.version) return cached.module
    let module: WebAssembly.Module
    try {
      module = new WebAssembly.Module(node.buf.slice(0, node.size))
    } catch {
      throw new KernelError(Errno.NOEXEC, `${path}: not a valid executable`)
    }
    this.modules.set(node, { version: node.version, module })
    return module
  }

  private reap(pid: number, code: number): void {
    const proc = this.procs.get(pid)
    if (!proc) return
    this.procs.delete(pid)
    proc.handle.terminate()
    clearTimeout(proc.timer)
    proc.blockedOn?.pids.delete(pid)
    for (const file of proc.fds.values()) this.release(file)
    proc.fds.clear()

    // 남은 자식은 고아가 되고, 종료해도 거둘 부모가 없으므로 바로 사라진다.
    for (const child of proc.children) {
      const c = this.procs.get(child)
      if (c) c.ppid = 0
    }
    const parent = this.procs.get(proc.ppid)
    if (parent) {
      parent.children.delete(pid)
      parent.zombies.set(pid, code)
      this.wake(parent.childQ)
    }
    this.host.emit({ type: 'exit', pid, code })

    if (proc.sessionLeader && proc.tty) this.hangup(proc.tty)
  }

  /** 셸이 끝나면 그 터미널에 붙어 있던 프로세스를 모두 정리한다. */
  private hangup(tty: Tty): void {
    this.ttys.delete(tty.id)
    for (const p of [...this.procs.values()]) {
      if (p.tty === tty) this.reap(p.pid, ExitStatus.HANGUP)
    }
    this.host.emit({ type: 'tty-close', tty: tty.id })
  }

  /** Ctrl+C: 전경 그룹의 프로세스를 끝낸다. 셸 자신은 살아남아 새 프롬프트를 낸다. */
  private interrupt(tty: Tty): void {
    let shellInForeground = false
    for (const p of [...this.procs.values()]) {
      if (p.tty !== tty || p.pgid !== tty.fg) continue
      if (p.sessionLeader) shellInForeground = true
      else this.reap(p.pid, ExitStatus.INTERRUPT)
    }
    if (shellInForeground) tty.deliver('\n')
  }

  /** 미뤄 둔 시스템 콜을 다시 실행한다. 조건이 여전히 안 되면 다시 큐에 들어간다. */
  private wake(queue: WaitQueue): void {
    const pids = [...queue.pids]
    queue.pids.clear()
    for (const pid of pids) {
      const proc = this.procs.get(pid)
      const req = proc?.pending
      if (!proc || !req) continue
      proc.pending = undefined
      proc.blockedOn = undefined
      this.syscall(pid, req)
    }
  }

  // ───────────── 파일 디스크립터 ─────────────

  private fd(proc: Process, fd: number): OpenFile {
    const file = proc.fds.get(fd)
    if (!file) throw new KernelError(Errno.BADF)
    return file
  }

  private dirFd(proc: Process, fd: number): DirNode {
    const file = this.fd(proc, fd)
    if (file.kind !== 'dir') throw new KernelError(Errno.NOTDIR)
    return file.node
  }

  private install(proc: Process, file: OpenFile): number {
    let fd = 0
    while (proc.fds.has(fd)) fd++
    proc.fds.set(fd, file)
    return fd
  }

  private release(file: OpenFile): void {
    if (--file.refs > 0 || file.kind !== 'pipe') return
    if (file.end === 'read') {
      // 읽을 쪽이 없어졌다: 쓰려고 기다리던 프로세스가 끊김을 알아야 한다.
      if (--file.pipe.readers === 0) this.wake(file.pipe.writeQ)
    } else {
      // 쓸 쪽이 없어졌다: 읽으려고 기다리던 프로세스가 EOF를 받아야 한다.
      if (--file.pipe.writers === 0) this.wake(file.pipe.readQ)
    }
  }

  // ───────────── 시스템 콜 ─────────────

  private dispatch(proc: Process, req: SysReq): SysRes {
    const [a0 = 0, a1 = 0, a2 = 0] = req.args
    const path = req.path ?? ''
    if ((req.nr === Sys.open || req.nr === Sys.pathstat) && isProcPath(path)) this.refreshProc()
    switch (req.nr) {
      case Sys.exit:
        this.reap(proc.pid, a0)
        throw new Gone()
      case Sys.write:
        return this.sysWrite(proc, a0, req.data ?? new Uint8Array(0))
      case Sys.read:
        return this.sysRead(proc, a0, Math.min(a1, PAYLOAD_MAX))
      case Sys.close: {
        const file = this.fd(proc, a0)
        proc.fds.delete(a0)
        this.release(file)
        return { errno: 0 }
      }
      case Sys.seek:
        return this.sysSeek(proc, a0, a1, a2)
      case Sys.open:
        return this.sysOpen(proc, a0, a1, a2, path)
      case Sys.fdstat:
        return { errno: 0, ret: fileType(this.fd(proc, a0)) }
      case Sys.filestat: {
        const file = this.fd(proc, a0)
        return stat(fileType(file), file.kind === 'file' ? file.node.size : 0)
      }
      case Sys.pathstat: {
        const node = this.fs.lookup(this.dirFd(proc, a0), path)
        return node.kind === 'file' ? stat(FileType.REGULAR, node.size) : stat(FileType.DIRECTORY, 0)
      }
      case Sys.prestat: {
        const file = this.fd(proc, a0)
        if (file.kind !== 'dir' || file.preopen === undefined) throw new KernelError(Errno.BADF)
        return { errno: 0, data: new TextEncoder().encode(file.preopen) }
      }
      case Sys.mkdir: {
        const { dir, name } = this.fs.lookupParent(this.dirFd(proc, a0), path)
        this.fs.mkdir(dir, name)
        return { errno: 0 }
      }
      case Sys.unlink: {
        const { dir, name } = this.fs.lookupParent(this.dirFd(proc, a0), path)
        this.fs.unlink(dir, name)
        return { errno: 0 }
      }
      case Sys.rmdir: {
        const { dir, name } = this.fs.lookupParent(this.dirFd(proc, a0), path)
        this.fs.rmdir(dir, name)
        return { errno: 0 }
      }
      case Sys.rename: {
        const [fromPath = '', toPath = ''] = path.split('\0')
        const from = this.fs.lookupParent(this.dirFd(proc, a0), fromPath)
        const to = this.fs.lookupParent(this.dirFd(proc, a1), toPath)
        this.fs.rename(from.dir, from.name, to.dir, to.name)
        return { errno: 0 }
      }
      case Sys.readdir:
        return { errno: 0, data: readdir(this.dirFd(proc, a0), a1, Math.min(a2, PAYLOAD_MAX)) }
      case Sys.spawn:
        return this.sysSpawn(proc, req)
      case Sys.wait:
        return this.sysWait(proc, a0, a1)
      case Sys.pipe: {
        const pipe = new Pipe()
        const r = this.install(proc, { kind: 'pipe', pipe, end: 'read', refs: 1 })
        const w = this.install(proc, { kind: 'pipe', pipe, end: 'write', refs: 1 })
        return { errno: 0, data: new Uint8Array(Uint32Array.of(r, w).buffer) }
      }
      case Sys.setfg:
        if (!proc.tty) throw new KernelError(Errno.NOTTY)
        proc.tty.fg = a0
        return { errno: 0 }
      case Sys.ttyraw:
        if (!proc.tty) throw new KernelError(Errno.NOTTY)
        proc.tty.setRaw(a0 !== 0)
        return { errno: 0 }
      case Sys.winsize:
        if (!proc.tty) throw new KernelError(Errno.NOTTY)
        return { errno: 0, data: new Uint8Array(Uint32Array.of(proc.tty.cols, proc.tty.rows).buffer) }
      case Sys.pollin: {
        const queue = this.readable(proc, this.fd(proc, a0))
        if (!queue) return { errno: 0, ret: 1 }
        if (a1 <= 0) return { errno: 0, ret: 0 }
        throw new Block(queue, a1)
      }
      case Sys.getpid:
        return { errno: 0, ret: proc.pid }
      case Sys.kill:
        if (!this.procs.has(a0)) throw new KernelError(Errno.SRCH)
        this.reap(a0, ExitStatus.TERMINATED)
        if (a0 === proc.pid) throw new Gone()
        return { errno: 0 }
      default:
        throw new KernelError(Errno.NOSYS)
    }
  }

  private sysWrite(proc: Process, fd: number, data: Uint8Array): SysRes {
    const file = this.fd(proc, fd)
    switch (file.kind) {
      case 'console':
        this.host.emit({ type: 'stdio', pid: proc.pid, fd, data })
        return { errno: 0, ret: data.length }
      case 'tty':
        file.tty.write(data)
        return { errno: 0, ret: data.length }
      case 'file': {
        if (file.append) file.offset = file.node.size
        const n = this.fs.write(file.node, file.offset, data)
        file.offset += n
        return { errno: 0, ret: n }
      }
      case 'pipe': {
        if (file.end !== 'write') throw new KernelError(Errno.BADF)
        if (file.pipe.readers === 0) {
          // 읽는 쪽이 없는 파이프에 쓰면 조용히 종료된다 (yes | head 가 끝나는 이유).
          this.reap(proc.pid, ExitStatus.PIPE)
          throw new Gone()
        }
        const n = file.pipe.write(data)
        if (n === 0 && data.length > 0) throw new Block(file.pipe.writeQ)
        this.wake(file.pipe.readQ)
        return { errno: 0, ret: n }
      }
      case 'dir':
        throw new KernelError(Errno.ISDIR)
    }
  }

  /** 지금 읽으면 멈추지 않는가. 멈춘다면 무엇을 기다려야 하는지(대기 큐)를 돌려준다. */
  private readable(proc: Process, file: OpenFile): WaitQueue | undefined {
    if (file.kind === 'tty' && proc.pgid === file.tty.fg && !file.tty.hasInput()) return file.tty.readQ
    if (file.kind === 'pipe' && file.end === 'read' && file.pipe.size === 0 && file.pipe.writers > 0) return file.pipe.readQ
    return undefined
  }

  private sysRead(proc: Process, fd: number, max: number): SysRes {
    const file = this.fd(proc, fd)
    const eof: SysRes = { errno: 0, data: new Uint8Array(0) }
    switch (file.kind) {
      case 'console':
        return eof
      case 'tty': {
        // 배경 프로세스는 키보드 입력을 가로챌 수 없다.
        if (proc.pgid !== file.tty.fg || max === 0) return eof
        const data = file.tty.read(max)
        if (!data) throw new Block(file.tty.readQ)
        return { errno: 0, data }
      }
      case 'file': {
        const data = this.fs.read(file.node, file.offset, max)
        file.offset += data.length
        return { errno: 0, data }
      }
      case 'pipe': {
        if (file.end !== 'read') throw new KernelError(Errno.BADF)
        if (file.pipe.size === 0) {
          if (file.pipe.writers === 0 || max === 0) return eof
          throw new Block(file.pipe.readQ)
        }
        const data = file.pipe.read(max)
        this.wake(file.pipe.writeQ)
        return { errno: 0, data }
      }
      case 'dir':
        throw new KernelError(Errno.ISDIR)
    }
  }

  private sysSeek(proc: Process, fd: number, offset: number, whence: number): SysRes {
    const file = this.fd(proc, fd)
    if (file.kind !== 'file') throw new KernelError(Errno.SPIPE)
    const base =
      whence === Whence.SET ? 0 : whence === Whence.CUR ? file.offset : whence === Whence.END ? file.node.size : NaN
    const next = base + offset
    if (!(next >= 0)) throw new KernelError(Errno.INVAL)
    file.offset = next
    return { errno: 0, ret: next }
  }

  private sysOpen(proc: Process, dirfd: number, oflags: number, fdflags: number, path: string): SysRes {
    const base = this.dirFd(proc, dirfd)
    let node
    try {
      node = this.fs.lookup(base, path)
      if (oflags & OFlags.CREAT && oflags & OFlags.EXCL) throw new KernelError(Errno.EXIST)
    } catch (e) {
      if (!(e instanceof KernelError) || e.errno !== Errno.NOENT || !(oflags & OFlags.CREAT)) throw e
      const { dir, name } = this.fs.lookupParent(base, path)
      node = this.fs.createFile(dir, name)
    }

    let file: OpenFile
    if (node.kind === 'dir') {
      file = { kind: 'dir', node, refs: 1 }
    } else {
      if (oflags & OFlags.DIRECTORY) throw new KernelError(Errno.NOTDIR)
      if (oflags & OFlags.TRUNC) this.fs.truncate(node)
      file = { kind: 'file', node, offset: 0, append: (fdflags & FdFlags.APPEND) !== 0, refs: 1 }
    }
    return { errno: 0, ret: this.install(proc, file) }
  }

  private sysSpawn(proc: Process, req: SysReq): SysRes {
    const [stdin = 0, stdout = 1, stderr = 2, pgid = Pgid.INHERIT, foreground = 0] = req.args
    const stdio: [OpenFile, OpenFile, OpenFile] = [this.fd(proc, stdin), this.fd(proc, stdout), this.fd(proc, stderr)]
    const child = this.exec({
      path: req.path ?? '',
      argv: req.argv ?? [],
      env: req.env ?? {},
      stdio,
      parent: proc,
      pgid: pgid === Pgid.INHERIT ? proc.pgid : pgid,
      tty: proc.tty,
    })
    // 자식이 첫 입력을 읽기 전에 전경 그룹이 정해져 있어야 하므로 생성과 함께 처리한다.
    if (foreground && proc.tty) proc.tty.fg = child.pgid
    return { errno: 0, ret: child.pid }
  }

  private sysWait(proc: Process, pid: number, flags: number): SysRes {
    const target = pid === -1 ? proc.zombies.keys().next().value : pid
    if (target !== undefined && proc.zombies.has(target)) {
      const code = proc.zombies.get(target)!
      proc.zombies.delete(target)
      return { errno: 0, ret: target, data: new Uint8Array(Int32Array.of(code).buffer) }
    }
    const alive = pid === -1 ? proc.children.size > 0 : proc.children.has(pid)
    if (!alive) throw new KernelError(Errno.CHILD)
    if (flags & WaitFlags.NOHANG) return { errno: 0, ret: 0 }
    throw new Block(proc.childQ)
  }
}

/** 루트 기준 상대 경로가 /proc 또는 그 아래를 가리키는가 */
function isProcPath(path: string): boolean {
  return path === 'proc' || path.startsWith('proc/')
}

function fileType(file: OpenFile): number {
  switch (file.kind) {
    case 'tty':
      return FileType.CHAR_DEVICE
    case 'dir':
      return FileType.DIRECTORY
    case 'file':
      return FileType.REGULAR
    // 콘솔은 출력을 수집하는 통로일 뿐 터미널이 아니다 (프로그램이 색상 등을 쓰지 않아야 한다).
    case 'console':
    case 'pipe':
      return FileType.UNKNOWN
  }
}

function stat(type: number, size: number): SysRes {
  return { errno: 0, ret: size, data: Uint8Array.of(type) }
}

const DIRENT_HEADER = 24

/** cookie번째 항목부터 WASI dirent 형식으로 나열한다. maxLen에서 잘리며, 잘린 항목은 다음 호출에서 다시 읽는다. */
function readdir(dir: DirNode, cookie: number, maxLen: number): Uint8Array {
  const out = new Uint8Array(maxLen)
  const enc = new TextEncoder()
  let used = 0
  let index = 0
  for (const [name, node] of dir.entries) {
    if (index++ < cookie) continue
    if (used >= maxLen) break
    const nameBytes = enc.encode(name)
    const entry = new Uint8Array(DIRENT_HEADER + nameBytes.length)
    const ev = new DataView(entry.buffer)
    ev.setBigUint64(0, BigInt(index), true) // d_next
    ev.setBigUint64(8, BigInt(node.ino), true) // d_ino
    ev.setUint32(16, nameBytes.length, true) // d_namlen
    ev.setUint8(20, node.kind === 'dir' ? FileType.DIRECTORY : FileType.REGULAR) // d_type
    entry.set(nameBytes, DIRENT_HEADER)
    const take = Math.min(entry.length, maxLen - used)
    out.set(entry.subarray(0, take), used)
    used += take
  }
  return out.subarray(0, used)
}
