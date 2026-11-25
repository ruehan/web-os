// 프로세스 ↔ 커널 시스템 콜 규약.
//
// 요청: 프로세스 Worker가 커널로 postMessage(SysReq).
// 응답: 커널이 프로세스별 SharedArrayBuffer에 결과를 쓰고 Atomics.notify.
//       프로세스는 그동안 Atomics.wait로 실제로 멈춰 있다.

export const Sys = {
  write: 1, // args [fd], data            -> ret 쓴 바이트 수
  read: 2, // args [fd, maxLen]          -> data
  close: 3, // args [fd]
  seek: 4, // args [fd, offset, whence]  -> ret 새 오프셋
  open: 5, // args [dirfd, oflags, fdflags], path -> ret fd
  fdstat: 6, // args [fd]                  -> ret filetype
  filestat: 7, // args [fd]                  -> ret 크기, data [filetype]
  pathstat: 8, // args [dirfd], path         -> ret 크기, data [filetype]
  prestat: 9, // args [fd]                  -> data 미리 열린 디렉터리 경로
  mkdir: 10, // args [dirfd], path
  unlink: 11, // args [dirfd], path
  exit: 12, // args [code]                -> 응답 없음
} as const

export interface SysReq {
  nr: number
  args: number[]
  path?: string
  data?: Uint8Array
}

export interface SysRes {
  errno: number
  ret?: number
  data?: Uint8Array
}

export const FileType = { UNKNOWN: 0, CHAR_DEVICE: 2, DIRECTORY: 3, REGULAR: 4 } as const
export const OFlags = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const
export const FdFlags = { APPEND: 1 } as const
export const Whence = { SET: 0, CUR: 1, END: 2 } as const

// 채널 메모리 배치: i32 state | i32 errno | i64 ret | i32 dataLen | (padding) | payload
const STATE = 0
const ERRNO = 1
const RET_I64 = 1 // BigInt64Array 인덱스 (바이트 8)
const DATA_LEN = 4
const HEADER_BYTES = 24
export const PAYLOAD_MAX = 64 * 1024

const PENDING = 0
const DONE = 1

export function createChannel(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + PAYLOAD_MAX)
}

/** 프로세스 쪽: 요청을 보내기 직전에 호출한다. */
export function armChannel(sab: SharedArrayBuffer): void {
  Atomics.store(new Int32Array(sab, 0, 5), STATE, PENDING)
}

/** 커널 쪽: 결과를 쓰고 프로세스를 깨운다. */
export function writeReply(sab: SharedArrayBuffer, res: SysRes): void {
  const i32 = new Int32Array(sab, 0, 5)
  const data = res.data
  if (data && data.length > PAYLOAD_MAX) throw new Error('syscall reply payload too large')
  i32[ERRNO] = res.errno
  new BigInt64Array(sab, 0, 2)[RET_I64] = BigInt(res.ret ?? 0)
  i32[DATA_LEN] = data ? data.length : 0
  if (data) new Uint8Array(sab, HEADER_BYTES, data.length).set(data)
  Atomics.store(i32, STATE, DONE)
  Atomics.notify(i32, STATE)
}

/** 프로세스 쪽: 응답이 올 때까지 스레드를 멈춘다. */
export function waitReply(sab: SharedArrayBuffer): SysRes {
  const i32 = new Int32Array(sab, 0, 5)
  while (Atomics.load(i32, STATE) === PENDING) Atomics.wait(i32, STATE, PENDING)
  const len = i32[DATA_LEN]!
  return {
    errno: i32[ERRNO]!,
    ret: Number(new BigInt64Array(sab, 0, 2)[RET_I64]!),
    // 다음 시스템 콜이 덮어쓰므로 호출자는 즉시 복사해 써야 한다.
    data: new Uint8Array(sab, HEADER_BYTES, len),
  }
}

/** 프로세스 Worker가 시작될 때 커널에게서 받는 정보. */
export interface ProcessInit {
  pid: number
  module: WebAssembly.Module
  argv: string[]
  env: Record<string, string>
  channel: SharedArrayBuffer
}

/** 커널 → 메인 스레드 이벤트. */
export type KernelEvent =
  | { type: 'klog'; time: number; msg: string }
  | { type: 'ready' }
  | { type: 'spawn'; pid: number; argv: string[] }
  | { type: 'tty'; pid: number; fd: number; data: Uint8Array }
  | { type: 'exit'; pid: number; code: number }
  | { type: 'error'; msg: string }

/** 메인 스레드 → 커널 명령. */
export type KernelCommand =
  | { type: 'spawn'; path: string; argv: string[]; env?: Record<string, string> }
  | { type: 'kill'; pid: number }
