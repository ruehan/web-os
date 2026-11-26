// WASI preview1 구현. WASM 프로그램의 메모리에서 인자를 꺼내 커널 시스템 콜로 바꾸고,
// 결과를 다시 메모리에 써 준다. 정책(파일, 권한, 프로세스)은 전부 커널에 있다.
import { ExitStatus, FileType, PAYLOAD_MAX, Sys, type SysReq, type SysRes } from '../kernel/abi.ts'
import { Errno } from '../kernel/errno.ts'

export interface SyscallTransport {
  /** 응답이 올 때까지 멈춘다. */
  call(req: SysReq): SysRes
  /** 응답을 기다리지 않는다 (exit). */
  send(req: SysReq): void
}

/** proc_exit가 WASM 스택을 풀기 위해 던지는 값. */
class ExitSignal {}

const WASI = 'wasi_snapshot_preview1'
const WEBOS = 'webos'
const ALL_RIGHTS = 0x1fffffffn
// 터미널 같은 문자 장치는 탐색(seek/tell) 권한이 없어야 libc의 isatty가 참이 된다.
const TTY_RIGHTS = ALL_RIGHTS & ~((1n << 2n) | (1n << 5n))
const DIRENT_HEADER = 24

export function runWasi(
  module: WebAssembly.Module,
  argv: string[],
  env: Record<string, string>,
  sys: SyscallTransport,
): void {
  let memory!: WebAssembly.Memory
  const view = () => new DataView(memory.buffer)
  const bytes = () => new Uint8Array(memory.buffer)
  const enc = new TextEncoder()
  const readString = (ptr: number, len: number) => new TextDecoder().decode(bytes().subarray(ptr, ptr + len))

  const argBytes = argv.map((a) => enc.encode(a + '\0'))
  const envBytes = Object.entries(env).map(([k, v]) => enc.encode(`${k}=${v}\0`))

  const sizesGet = (list: Uint8Array[], countPtr: number, sizePtr: number) => {
    const v = view()
    v.setUint32(countPtr, list.length, true)
    v.setUint32(sizePtr, list.reduce((n, b) => n + b.length, 0), true)
    return 0
  }
  const listGet = (list: Uint8Array[], ptrs: number, buf: number) => {
    const v = view()
    for (const item of list) {
      v.setUint32(ptrs, buf, true)
      bytes().set(item, buf)
      ptrs += 4
      buf += item.length
    }
    return 0
  }
  const writeFilestat = (ptr: number, res: SysRes) => {
    bytes().fill(0, ptr, ptr + 64)
    const v = view()
    v.setUint8(ptr + 16, res.data?.[0] ?? FileType.UNKNOWN)
    v.setBigUint64(ptr + 24, 1n, true) // nlink
    v.setBigUint64(ptr + 32, BigInt(res.ret ?? 0), true) // size
  }

  const impl: Record<string, (...args: any[]) => number> = {
    args_sizes_get: (countPtr: number, sizePtr: number) => sizesGet(argBytes, countPtr, sizePtr),
    args_get: (ptrs: number, buf: number) => listGet(argBytes, ptrs, buf),
    environ_sizes_get: (countPtr: number, sizePtr: number) => sizesGet(envBytes, countPtr, sizePtr),
    environ_get: (ptrs: number, buf: number) => listGet(envBytes, ptrs, buf),

    clock_time_get(id: number, _precision: bigint, ptr: number) {
      // 0 = 현재 시각, 그 외 = 단조 증가 시계
      const ms = id === 0 ? Date.now() : performance.now()
      view().setBigUint64(ptr, BigInt(Math.round(ms * 1e6)), true)
      return 0
    },

    random_get(ptr: number, len: number) {
      for (let off = 0; off < len; off += 65536) {
        crypto.getRandomValues(bytes().subarray(ptr + off, ptr + Math.min(len, off + 65536)))
      }
      return 0
    },

    sched_yield: () => 0,

    fd_write(fd: number, iovs: number, iovsLen: number, nwrittenPtr: number) {
      let total = 0
      outer: for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovs + i * 8, true)
        const len = view().getUint32(iovs + i * 8 + 4, true)
        for (let off = 0; off < len; ) {
          const chunk = Math.min(len - off, PAYLOAD_MAX)
          // slice로 복사해야 메모리 전체가 아니라 이 구간만 전송된다.
          const res = sys.call({ nr: Sys.write, args: [fd], data: bytes().slice(ptr + off, ptr + off + chunk) })
          if (res.errno) return res.errno
          const n = res.ret ?? 0
          off += n
          total += n
          if (n < chunk) break outer
        }
      }
      view().setUint32(nwrittenPtr, total, true)
      return 0
    },

    fd_read(fd: number, iovs: number, iovsLen: number, nreadPtr: number) {
      let total = 0
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovs + i * 8, true)
        const len = view().getUint32(iovs + i * 8 + 4, true)
        if (len === 0) continue
        const res = sys.call({ nr: Sys.read, args: [fd, len] })
        if (res.errno) return res.errno
        const data = res.data!
        bytes().set(data, ptr)
        total += data.length
        if (data.length < len) break
      }
      view().setUint32(nreadPtr, total, true)
      return 0
    },

    fd_close: (fd: number) => sys.call({ nr: Sys.close, args: [fd] }).errno,

    fd_seek(fd: number, offset: bigint, whence: number, newOffsetPtr: number) {
      const res = sys.call({ nr: Sys.seek, args: [fd, Number(offset), whence] })
      if (res.errno) return res.errno
      view().setBigUint64(newOffsetPtr, BigInt(res.ret ?? 0), true)
      return 0
    },

    fd_fdstat_get(fd: number, ptr: number) {
      const res = sys.call({ nr: Sys.fdstat, args: [fd] })
      if (res.errno) return res.errno
      bytes().fill(0, ptr, ptr + 24)
      const v = view()
      const type = res.ret ?? FileType.UNKNOWN
      const rights = type === FileType.CHAR_DEVICE ? TTY_RIGHTS : ALL_RIGHTS
      v.setUint8(ptr, type)
      v.setBigUint64(ptr + 8, rights, true)
      v.setBigUint64(ptr + 16, rights, true)
      return 0
    },

    fd_filestat_get(fd: number, ptr: number) {
      const res = sys.call({ nr: Sys.filestat, args: [fd] })
      if (res.errno) return res.errno
      writeFilestat(ptr, res)
      return 0
    },

    path_filestat_get(dirfd: number, _flags: number, pathPtr: number, pathLen: number, ptr: number) {
      const res = sys.call({ nr: Sys.pathstat, args: [dirfd], path: readString(pathPtr, pathLen) })
      if (res.errno) return res.errno
      writeFilestat(ptr, res)
      return 0
    },

    fd_prestat_get(fd: number, ptr: number) {
      const res = sys.call({ nr: Sys.prestat, args: [fd] })
      if (res.errno) return res.errno
      const v = view()
      v.setUint32(ptr, 0, true) // 종류: 디렉터리
      v.setUint32(ptr + 4, res.data!.length, true)
      return 0
    },

    fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number) {
      const res = sys.call({ nr: Sys.prestat, args: [fd] })
      if (res.errno) return res.errno
      bytes().set(res.data!.subarray(0, pathLen), pathPtr)
      return 0
    },

    path_open(
      dirfd: number,
      _dirflags: number,
      pathPtr: number,
      pathLen: number,
      oflags: number,
      _rightsBase: bigint,
      _rightsInheriting: bigint,
      fdflags: number,
      fdPtr: number,
    ) {
      const res = sys.call({ nr: Sys.open, args: [dirfd, oflags, fdflags], path: readString(pathPtr, pathLen) })
      if (res.errno) return res.errno
      view().setUint32(fdPtr, res.ret ?? 0, true)
      return 0
    },

    path_create_directory: (dirfd: number, pathPtr: number, pathLen: number) =>
      sys.call({ nr: Sys.mkdir, args: [dirfd], path: readString(pathPtr, pathLen) }).errno,

    path_unlink_file: (dirfd: number, pathPtr: number, pathLen: number) =>
      sys.call({ nr: Sys.unlink, args: [dirfd], path: readString(pathPtr, pathLen) }).errno,

    path_rename(fromFd: number, fromPtr: number, fromLen: number, toFd: number, toPtr: number, toLen: number) {
      const path = `${readString(fromPtr, fromLen)}\0${readString(toPtr, toLen)}`
      return sys.call({ nr: Sys.rename, args: [fromFd, toFd], path }).errno
    },

    path_remove_directory: (dirfd: number, pathPtr: number, pathLen: number) =>
      sys.call({ nr: Sys.rmdir, args: [dirfd], path: readString(pathPtr, pathLen) }).errno,

    fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint, usedPtr: number) {
      let used = 0
      let next = Number(cookie)
      while (used < bufLen) {
        const want = Math.min(bufLen - used, PAYLOAD_MAX)
        const res = sys.call({ nr: Sys.readdir, args: [fd, next, want] })
        if (res.errno) return res.errno
        const data = res.data!
        bytes().set(data, buf + used)
        // 끝까지 읽었거나, 호출자의 버퍼가 가득 찼다 (잘린 항목은 호출자가 다시 요청한다).
        if (data.length < want || want === bufLen - used) {
          used += data.length
          break
        }
        // 채널 용량 때문에 잘린 경우: 온전한 항목까지만 채택하고 이어서 읽는다.
        const dv = new DataView(data.buffer, data.byteOffset, data.length)
        let off = 0
        while (off + DIRENT_HEADER <= data.length) {
          const size = DIRENT_HEADER + dv.getUint32(off + 16, true)
          if (off + size > data.length) break
          next = Number(dv.getBigUint64(off, true))
          off += size
        }
        if (off === 0) break
        used += off
      }
      view().setUint32(usedPtr, used, true)
      return 0
    },

    // 시계 대기만 지원한다 (sleep). 스레드를 실제로 재운다.
    poll_oneoff(subsPtr: number, eventsPtr: number, count: number, neventsPtr: number) {
      const v = view()
      let soonest = -1
      let waitMs = Infinity
      for (let i = 0; i < count; i++) {
        const sub = subsPtr + i * 48
        if (v.getUint8(sub + 8) !== 0) return Errno.NOSYS // 시계 구독이 아님
        let ms = Number(v.getBigUint64(sub + 24, true)) / 1e6
        if (v.getUint16(sub + 40, true) & 1) {
          // 절대 시각
          ms -= v.getUint32(sub + 16, true) === 0 ? Date.now() : performance.now()
        }
        if (ms < waitMs) {
          waitMs = ms
          soonest = sub
        }
      }
      if (soonest < 0) return Errno.INVAL
      if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
      bytes().fill(0, eventsPtr, eventsPtr + 32)
      const out = view()
      out.setBigUint64(eventsPtr, out.getBigUint64(soonest, true), true) // userdata
      out.setUint32(neventsPtr, 1, true)
      return 0
    },

    proc_exit(code: number): never {
      sys.send({ nr: Sys.exit, args: [code] })
      throw new ExitSignal()
    },
  }

  // WASI에 없는 기능(프로세스 생성, 파이프 등)을 위한 자체 확장.
  // 반환값이 음수면 -errno다.
  const webos: Record<string, (...args: any[]) => number> = {
    // 요청 형식: i32 stdin, stdout, stderr, pgid, foreground | u32 argc, envc | (u32 길이 + 바이트) × (경로, 인자들, 환경 변수들)
    spawn(ptr: number, len: number) {
      const v = new DataView(memory.buffer, ptr, len)
      const args = [0, 4, 8, 12, 16].map((off) => v.getInt32(off, true))
      const argc = v.getUint32(20, true)
      const envc = v.getUint32(24, true)
      let off = 28
      const next = () => {
        const n = v.getUint32(off, true)
        const s = readString(ptr + off + 4, n)
        off += 4 + n
        return s
      }
      const path = next()
      const childArgv = Array.from({ length: argc }, next)
      const childEnv: Record<string, string> = {}
      for (let i = 0; i < envc; i++) {
        const pair = next()
        const eq = pair.indexOf('=')
        childEnv[pair.slice(0, eq)] = pair.slice(eq + 1)
      }
      const res = sys.call({ nr: Sys.spawn, args, path, argv: childArgv, env: childEnv })
      return res.errno ? -res.errno : (res.ret ?? 0)
    },

    wait(pid: number, flags: number, statusPtr: number) {
      const res = sys.call({ nr: Sys.wait, args: [pid, flags] })
      if (res.errno) return -res.errno
      const d = res.data!
      if (d.length >= 4) view().setInt32(statusPtr, new DataView(d.buffer, d.byteOffset, 4).getInt32(0, true), true)
      return res.ret ?? 0
    },

    pipe(fdsPtr: number) {
      const res = sys.call({ nr: Sys.pipe, args: [] })
      if (res.errno) return -res.errno
      bytes().set(res.data!.subarray(0, 8), fdsPtr)
      return 0
    },

    setfg: (pgid: number) => -sys.call({ nr: Sys.setfg, args: [pgid] }).errno,
    getpid: () => sys.call({ nr: Sys.getpid, args: [] }).ret ?? 0,
    set_raw: (on: number) => -sys.call({ nr: Sys.ttyraw, args: [on] }).errno,
    poll_input(fd: number, timeoutMs: number) {
      const res = sys.call({ nr: Sys.pollin, args: [fd, timeoutMs] })
      return res.errno ? -res.errno : (res.ret ?? 0)
    },
    winsize(ptr: number) {
      const res = sys.call({ nr: Sys.winsize, args: [] })
      if (res.errno) return -res.errno
      bytes().set(res.data!.subarray(0, 8), ptr)
      return 0
    },
    kill: (pid: number) => -sys.call({ nr: Sys.kill, args: [pid] }).errno,
    gui_open: (titlePtr: number, titleLen: number, w: number, h: number) =>
      -sys.call({ nr: Sys.guiopen, args: [w, h], path: readString(titlePtr, titleLen) }).errno,
    // 메모리의 일부를 가리키는 채로는 보낼 수 없으므로 복사해서 보낸다.
    gui_draw: (ptr: number, len: number) => -sys.call({ nr: Sys.guidraw, args: [], data: bytes().slice(ptr, ptr + len) }).errno,
    gui_event(ptr: number, timeoutMs: number) {
      const res = sys.call({ nr: Sys.guievent, args: [timeoutMs] })
      if (res.errno) return -res.errno
      if (res.ret) bytes().set(res.data!.subarray(0, 16), ptr)
      return res.ret ?? 0
    },
    // 입력 칸의 글을 offset부터 최대 len 바이트 읽는다. 읽은 바이트 수를 돌려주고, 글의 판 번호를 versionPtr에 쓴다.
    gui_text(field: number, offset: number, ptr: number, len: number, versionPtr: number) {
      const res = sys.call({ nr: Sys.guitext, args: [field, offset, Math.min(len, PAYLOAD_MAX)] })
      if (res.errno) return -res.errno
      bytes().set(res.data!, ptr)
      view().setUint32(versionPtr, res.ret ?? 0, true)
      return res.data!.length
    },
    gui_set_text: (field: number, ptr: number, len: number) =>
      -sys.call({ nr: Sys.guisettext, args: [field], data: bytes().slice(ptr, ptr + len) }).errno,
    // 글들의 폭을 잰다. 폭(f32)을 최대 cap개까지 out에 쓰고 그 개수를 돌려준다.
    gui_measure(reqPtr: number, reqLen: number, out: number, cap: number) {
      const res = sys.call({ nr: Sys.guimeasure, args: [], data: bytes().slice(reqPtr, reqPtr + reqLen) })
      if (res.errno) return -res.errno
      const count = Math.min(cap, res.data!.length >> 2)
      bytes().set(res.data!.subarray(0, count * 4), out)
      return count
    },
  }

  // 아직 구현하지 않은 함수는 링크 오류 대신 ENOSYS를 돌려준다.
  const modules: Record<string, Record<string, (...args: any[]) => number>> = { [WASI]: impl, [WEBOS]: webos }
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {}
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') continue
    const known = modules[imp.module]?.[imp.name]
    ;(imports[imp.module] ??= {})[imp.name] = known ?? (() => Errno.NOSYS)
  }

  try {
    const instance = new WebAssembly.Instance(module, imports)
    memory = instance.exports.memory as WebAssembly.Memory
    ;(instance.exports._start as () => void)()
    sys.send({ nr: Sys.exit, args: [0] })
  } catch (e) {
    if (e instanceof ExitSignal) return
    // 트랩(unreachable, 범위 밖 메모리 접근 등)이나 잘못된 바이너리
    const msg = enc.encode(`${argv[0] ?? 'process'}: ${e instanceof Error ? e.message : String(e)}\n`)
    sys.call({ nr: Sys.write, args: [2], data: msg })
    sys.send({ nr: Sys.exit, args: [ExitStatus.ABORT] })
  }
}
