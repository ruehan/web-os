import {
  FdFlags,
  FileType,
  OFlags,
  PAYLOAD_MAX,
  Sys,
  Whence,
  createChannel,
  writeReply,
  type KernelEvent,
  type ProcessInit,
  type SysReq,
  type SysRes,
} from './abi'
import { Errno, KernelError } from './errno'
import { MemFs, type DirNode, type FileNode } from './vfs/memfs'

type OpenFile =
  | { kind: 'tty' }
  | { kind: 'file'; node: FileNode; offset: number; append: boolean }
  | { kind: 'dir'; node: DirNode; preopen?: string }

interface Process {
  pid: number
  argv: string[]
  fds: Map<number, OpenFile>
  channel: SharedArrayBuffer
  handle: ProcessHandle
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

const SIGKILL_STATUS = 128 + 9

export class Kernel {
  readonly fs = new MemFs()
  private procs = new Map<number, Process>()
  private nextPid = 1

  constructor(private host: KernelHost) {
    for (const dir of ['/bin', '/tmp', '/home']) this.fs.mkdirp(dir)
  }

  log(msg: string): void {
    this.host.emit({ type: 'klog', time: this.host.now(), msg })
  }

  pids(): number[] {
    return [...this.procs.keys()]
  }

  /** 파일시스템에 있는 WASM 실행 파일을 새 프로세스로 띄운다. */
  spawn(path: string, argv: string[], env: Record<string, string> = {}): number {
    const node = this.fs.lookup(this.fs.root, path)
    if (node.kind !== 'file') throw new KernelError(Errno.ISDIR, `${path}: is a directory`)

    let module: WebAssembly.Module
    try {
      module = new WebAssembly.Module(node.buf.slice(0, node.size))
    } catch {
      throw new KernelError(Errno.NOEXEC, `${path}: not a valid executable`)
    }

    const pid = this.nextPid++
    const channel = createChannel()
    const fds = new Map<number, OpenFile>([
      [0, { kind: 'tty' }],
      [1, { kind: 'tty' }],
      [2, { kind: 'tty' }],
      [3, { kind: 'dir', node: this.fs.root, preopen: '/' }],
    ])
    const proc: Process = { pid, argv, fds, channel, handle: { terminate() {} } }
    this.procs.set(pid, proc)
    this.host.emit({ type: 'spawn', pid, argv })
    proc.handle = this.host.launch({ pid, module, argv, env, channel })
    return pid
  }

  kill(pid: number): void {
    if (!this.procs.has(pid)) throw new KernelError(Errno.SRCH, `no such process: ${pid}`)
    this.reap(pid, SIGKILL_STATUS)
  }

  /** 프로세스가 시스템 콜 없이 비정상 종료했을 때(Worker 오류 등) 호출한다. */
  crashed(pid: number, reason: string): void {
    if (!this.procs.has(pid)) return
    this.log(`pid ${pid} crashed: ${reason}`)
    this.reap(pid, 134)
  }

  private reap(pid: number, code: number): void {
    const proc = this.procs.get(pid)
    if (!proc) return
    this.procs.delete(pid)
    proc.handle.terminate()
    this.host.emit({ type: 'exit', pid, code })
  }

  /** 시스템 콜 진입점. exit를 뺀 모든 호출은 채널에 응답을 쓴다. */
  syscall(pid: number, req: SysReq): void {
    const proc = this.procs.get(pid)
    if (!proc) return
    if (req.nr === Sys.exit) {
      this.reap(pid, req.args[0] ?? 0)
      return
    }
    let res: SysRes
    try {
      res = this.dispatch(proc, req)
    } catch (e) {
      if (!(e instanceof KernelError)) throw e
      res = { errno: e.errno }
    }
    writeReply(proc.channel, res)
  }

  private dispatch(proc: Process, req: SysReq): SysRes {
    const [a0 = 0, a1 = 0, a2 = 0] = req.args
    switch (req.nr) {
      case Sys.write:
        return this.sysWrite(proc, a0, req.data ?? new Uint8Array(0))
      case Sys.read:
        return this.sysRead(proc, a0, a1)
      case Sys.close:
        if (!proc.fds.delete(a0)) throw new KernelError(Errno.BADF)
        return { errno: 0 }
      case Sys.seek:
        return this.sysSeek(proc, a0, a1, a2)
      case Sys.open:
        return this.sysOpen(proc, a0, a1, a2, req.path ?? '')
      case Sys.fdstat:
        return { errno: 0, ret: fileType(this.fd(proc, a0)) }
      case Sys.filestat: {
        const file = this.fd(proc, a0)
        return stat(fileType(file), file.kind === 'file' ? file.node.size : 0)
      }
      case Sys.pathstat: {
        const node = this.fs.lookup(this.dirFd(proc, a0), req.path ?? '')
        return node.kind === 'file'
          ? stat(FileType.REGULAR, node.size)
          : stat(FileType.DIRECTORY, 0)
      }
      case Sys.prestat: {
        const file = this.fd(proc, a0)
        if (file.kind !== 'dir' || file.preopen === undefined) throw new KernelError(Errno.BADF)
        return { errno: 0, data: new TextEncoder().encode(file.preopen) }
      }
      case Sys.mkdir: {
        const { dir, name } = this.fs.lookupParent(this.dirFd(proc, a0), req.path ?? '')
        this.fs.mkdir(dir, name)
        return { errno: 0 }
      }
      case Sys.unlink: {
        const { dir, name } = this.fs.lookupParent(this.dirFd(proc, a0), req.path ?? '')
        this.fs.unlink(dir, name)
        return { errno: 0 }
      }
      default:
        throw new KernelError(Errno.NOSYS)
    }
  }

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

  private sysWrite(proc: Process, fd: number, data: Uint8Array): SysRes {
    const file = this.fd(proc, fd)
    switch (file.kind) {
      case 'tty':
        this.host.emit({ type: 'tty', pid: proc.pid, fd, data })
        return { errno: 0, ret: data.length }
      case 'file': {
        if (file.append) file.offset = file.node.size
        const n = this.fs.write(file.node, file.offset, data)
        file.offset += n
        return { errno: 0, ret: n }
      }
      case 'dir':
        throw new KernelError(Errno.ISDIR)
    }
  }

  private sysRead(proc: Process, fd: number, maxLen: number): SysRes {
    const file = this.fd(proc, fd)
    switch (file.kind) {
      case 'tty':
        // 입력 장치는 2단계(TTY)에서 붙는다. 그때까지 표준 입력은 항상 EOF다.
        return { errno: 0, data: new Uint8Array(0) }
      case 'file': {
        const data = this.fs.read(file.node, file.offset, Math.min(maxLen, PAYLOAD_MAX))
        file.offset += data.length
        return { errno: 0, ret: data.length, data }
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
      file = { kind: 'dir', node }
    } else {
      if (oflags & OFlags.DIRECTORY) throw new KernelError(Errno.NOTDIR)
      if (oflags & OFlags.TRUNC) this.fs.truncate(node)
      file = { kind: 'file', node, offset: 0, append: (fdflags & FdFlags.APPEND) !== 0 }
    }

    let fd = 0
    while (proc.fds.has(fd)) fd++
    proc.fds.set(fd, file)
    return { errno: 0, ret: fd }
  }
}

function fileType(file: OpenFile): number {
  return file.kind === 'tty' ? FileType.CHAR_DEVICE : file.kind === 'dir' ? FileType.DIRECTORY : FileType.REGULAR
}

function stat(type: number, size: number): SysRes {
  return { errno: 0, ret: size, data: Uint8Array.of(type) }
}
