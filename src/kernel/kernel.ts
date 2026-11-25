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
  type KernelEvent,
  type ProcessInit,
  type SysReq,
  type SysRes,
} from './abi.ts'
import { Errno, KernelError } from './errno.ts'
import { Pipe, WaitQueue } from './pipe.ts'
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
  constructor(queue: WaitQueue) {
    this.queue = queue
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

  constructor(host: KernelHost) {
    this.host = host
    for (const dir of ['/bin', '/tmp', '/home/guest', '/etc']) this.fs.mkdirp(dir)
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
  openTerminal(): number {
    const id = this.nextTty++
    const tty: Tty = new Tty(id, {
      output: (data) => this.host.emit({ type: 'tty-output', tty: id, data }),
      interrupt: () => this.interrupt(tty),
      readable: () => this.wake(tty.readQ),
    })
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
    this.host.emit({ type: 'tty-open', tty: id, pid: shell.pid })
    return id
  }

  ttyInput(id: number, text: string): void {
    this.ttys.get(id)?.input(text)
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

  /** 시스템 콜 진입점. 응답은 채널에 쓰며, 조건이 안 되면 미뤄 둔다. */
  syscall(pid: number, req: SysReq): void {
    const proc = this.procs.get(pid)
    if (!proc) return
    let res: SysRes
    try {
      res = this.dispatch(proc, req)
    } catch (e) {
      if (e instanceof Gone) return
      if (e instanceof Block) {
        proc.pending = req
        proc.blockedOn = e.queue
        e.queue.pids.add(pid)
        return
      }
      if (!(e instanceof KernelError)) throw e
      res = { errno: e.errno }
    }
    writeReply(proc.channel, res)
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
