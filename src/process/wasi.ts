// WASI preview1 구현. WASM 프로그램의 메모리에서 인자를 꺼내 커널 시스템 콜로 바꾸고,
// 결과를 다시 메모리에 써 준다. 정책(파일, 권한, 프로세스)은 전부 커널에 있다.
import { FileType, PAYLOAD_MAX, Sys, type SysReq, type SysRes } from '../kernel/abi'
import { Errno } from '../kernel/errno'

export interface SyscallTransport {
  /** 응답이 올 때까지 멈춘다. */
  call(req: SysReq): SysRes
  /** 응답을 기다리지 않는다 (exit). */
  send(req: SysReq): void
}

/** proc_exit가 WASM 스택을 풀기 위해 던지는 값. */
class ExitSignal {}

const WASI = 'wasi_snapshot_preview1'
const ALL_RIGHTS = 0x1fffffffn
const ABORT_STATUS = 134

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
      v.setUint8(ptr, res.ret ?? FileType.UNKNOWN)
      v.setBigUint64(ptr + 8, ALL_RIGHTS, true)
      v.setBigUint64(ptr + 16, ALL_RIGHTS, true)
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

    proc_exit(code: number): never {
      sys.send({ nr: Sys.exit, args: [code] })
      throw new ExitSignal()
    },
  }

  // 아직 구현하지 않은 WASI 함수는 링크 오류 대신 ENOSYS를 돌려준다.
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {}
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') continue
    const known = imp.module === WASI ? impl[imp.name] : undefined
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
    sys.send({ nr: Sys.exit, args: [ABORT_STATUS] })
  }
}
