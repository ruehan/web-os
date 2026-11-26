// 프로세스 ↔ 커널 시스템 콜 규약.
//
// 요청: 프로세스 Worker가 커널로 postMessage(SysReq).
// 응답: 커널이 프로세스별 SharedArrayBuffer에 결과를 쓰고 Atomics.notify.
//       프로세스는 그동안 Atomics.wait로 실제로 멈춰 있다. 커널이 응답을 미루면
//       (빈 파이프 읽기, 자식 종료 대기 등) 프로세스는 그만큼 멈춰 있게 된다.

import type { TraceRecord } from './trace.ts'

export type { TraceRecord }

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
  readdir: 13, // args [fd, cookie, maxLen]  -> data WASI dirent 나열 (maxLen에서 잘림)
  rmdir: 14, // args [dirfd], path
  // 여기부터는 WASI에 없는 자체 확장 ("webos" 임포트 모듈)
  spawn: 15, // args [stdin, stdout, stderr, pgid, foreground], path, argv, env -> ret pid
  wait: 16, // args [pid | -1, flags]     -> ret pid (NOHANG이고 없으면 0), data i32 종료 코드
  pipe: 17, //                            -> data u32 읽기 fd, u32 쓰기 fd
  setfg: 18, // args [pgid]                터미널의 전경 프로세스 그룹 지정
  getpid: 19, //                            -> ret pid
  kill: 20, // args [pid]
  ttyraw: 21, // args [0 | 1]              터미널을 키 단위 입력 모드로 전환
  winsize: 22, //                            -> data u32 열 수, u32 줄 수
  rename: 23, // args [fromDirfd, toDirfd], path "from\0to"
  pollin: 24, // args [fd, timeoutMs]       -> ret 읽을 것이 있으면 1, 시간이 다 되면 0
  // 화면 (규약은 gui.ts)
  guiopen: 25, // args [w, h], path 제목     이 프로세스의 창을 연다 (프로세스당 하나)
  guidraw: 26, // data 그리기 명령 묶음      창의 내용을 통째로 바꿔 그린다
  guievent: 27, // args [timeoutMs | -1]    -> ret 이벤트가 있으면 1, 시간이 다 되면 0, data 이벤트
} as const

export interface SysReq {
  nr: number
  args: number[]
  path?: string
  data?: Uint8Array
  argv?: string[]
  env?: Record<string, string>
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
export const WaitFlags = { NOHANG: 1 } as const
/** spawn의 pgid 인자: 새 그룹을 만들거나 부모 그룹을 물려받는다. 양수면 그 그룹에 합류한다. */
export const Pgid = { NEW: 0, INHERIT: -1 } as const

/** 종료 코드 관례: 128 + 시그널 번호 */
export const ExitStatus = { HANGUP: 129, INTERRUPT: 130, ABORT: 134, KILLED: 137, PIPE: 141, TERMINATED: 143 } as const

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

/**
 * 화면 쪽 앱(파일 탐색기, 편집기)이 커널에 직접 요청하는 파일 작업.
 * 프로세스의 시스템 콜과 달리 비동기 메시지로 오가며, 경로는 모두 절대 경로다.
 */
export type FsRequest =
  | { op: 'list'; path: string }
  | { op: 'read'; path: string }
  | { op: 'write'; path: string; data: Uint8Array }
  | { op: 'mkdir'; path: string }
  | { op: 'remove'; path: string }
  | { op: 'rename'; from: string; to: string }

export interface FsEntry {
  name: string
  dir: boolean
  size: number
}

export type FsResult = { entries?: FsEntry[]; data?: Uint8Array }

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
  /** fresh: 저장된 것이 없어 처음 상태로 시작했다. persistent: 브라우저 저장소를 쓸 수 있다. */
  | { type: 'ready'; fresh: boolean; persistent: boolean }
  | { type: 'error'; msg: string }
  | { type: 'spawn'; pid: number; ppid: number; argv: string[] }
  | { type: 'exit'; pid: number; code: number }
  /** 터미널에 붙지 않은 프로세스의 표준 출력·오류 */
  | { type: 'stdio'; pid: number; fd: number; data: Uint8Array }
  /** ref는 tty-open 명령에 실어 보낸 값 그대로다 (어느 요청의 결과인지 구분용). */
  | { type: 'tty-open'; ref: number; tty: number; pid: number }
  | { type: 'tty-output'; tty: number; data: Uint8Array }
  | { type: 'tty-close'; tty: number }
  | { type: 'fs-result'; id: number; result?: FsResult; errno?: number }
  /** 파일시스템 내용이 바뀌었다 (짧은 시간에 여러 번 바뀌면 한 번으로 묶인다). */
  | { type: 'fs-change' }
  /** flush 명령에 대한 응답: 바뀐 내용이 모두 저장소에 반영됐다. */
  | { type: 'flushed' }
  /** 저장된 내용이 통째로 바뀌었다(초기화, 보관 폴더에서 불러오기). 화면은 페이지를 다시 불러와야 한다. */
  | { type: 'restart' }
  /** 보관 폴더 연결·해제 요청의 결과 */
  | { type: 'archive-result'; id: number; ok: true }
  /** needs-choice: 예전에 쓰던 보관 폴더라 어느 쪽 내용을 살릴지 정해야 한다. not-empty: 다른 파일이 든 폴더다. */
  | { type: 'archive-result'; id: number; ok: false; reason: 'needs-choice' | 'not-empty' }
  | { type: 'archive-result'; id: number; ok: false; reason: 'too-large'; files: number; bytes: number }
  | { type: 'archive-result'; id: number; ok: false; reason: 'failed'; msg: string }
  /** 백업 내보내기의 결과: tar 형식의 파일 묶음 */
  | { type: 'backup-data'; id: number; data: Uint8Array }
  /** 백업 가져오기에 실패했다. 성공하면 대신 restart가 온다. */
  | { type: 'backup-failed'; id: number; reason: 'invalid' | 'too-large'; msg: string }
  /** 보관 폴더에 저장하지 못했다 (권한이 취소됐거나 폴더가 사라진 경우 등) */
  | { type: 'archive-error'; msg: string }
  /** 프로세스가 창을 열었다. w, h는 바라는 안쪽 크기다. */
  | { type: 'gui-open'; pid: number; title: string; w: number; h: number }
  /** 창에 그릴 내용 (gui.ts의 그리기 명령 묶음) */
  | { type: 'gui-draw'; pid: number; data: Uint8Array }
  /** 창을 연 프로세스가 끝났다. */
  | { type: 'gui-close'; pid: number }
  /** 추적 중에 일어난 시스템 콜들. 너무 많으면 일부를 버리고 그 수를 dropped에 적는다. */
  | { type: 'trace'; records: TraceRecord[]; dropped: number }

/** 메인 스레드 → 커널 명령. */
export type KernelCommand =
  | { type: 'tty-open'; ref: number; cols: number; rows: number }
  | { type: 'tty-close'; tty: number }
  | { type: 'tty-resize'; tty: number; cols: number; rows: number }
  | { type: 'tty-input'; tty: number; text: string }
  | { type: 'kill'; pid: number }
  /** 터미널 없이 프로그램을 실행한다 (실행 메뉴에서 띄우는 화면 프로그램). */
  | { type: 'spawn'; path: string; argv: string[] }
  /** 창에서 일어난 입력을 그 프로세스에 전한다 (gui.ts의 이벤트). */
  | { type: 'gui-event'; pid: number; data: Uint8Array }
  | { type: 'fs'; id: number; request: FsRequest }
  | { type: 'storage-reset' }
  /**
   * 사용자가 고른 로컬 폴더를 보관 폴더로 연결한다. 연결된 동안 파일시스템 전체(/proc 제외)가 그 폴더에도 저장된다.
   *  - auto: 새로 고른 폴더. 빈 폴더면 지금 내용을 내보내고, 예전 보관 폴더면 되묻고, 그 밖에는 거절한다.
   *  - export: 지금 내용으로 폴더를 맞춘다 (폴더에만 있던 것은 지워진다).
   *  - import: 폴더의 내용으로 지금 내용을 바꾼 뒤 다시 시작한다.
   *  - attach: 지난 방문 때 연결했던 폴더를 다시 잇는다.
   */
  | {
      type: 'archive-link'
      id: number
      handle: FileSystemDirectoryHandle
      mode: 'auto' | 'export' | 'import' | 'attach'
      maxFiles: number
      maxBytes: number
    }
  | { type: 'archive-unlink'; id: number }
  /** 파일시스템 전체(/proc 제외)를 tar 묶음으로 내보낸다. */
  | { type: 'backup-export'; id: number }
  /** tar 묶음의 내용으로 파일시스템을 통째로 바꾼 뒤 다시 시작한다. */
  | { type: 'backup-import'; id: number; data: Uint8Array; maxFiles: number; maxBytes: number }
  /** 아직 저장하지 않은 변경을 지금 모두 저장한다. 끝나면 flushed 이벤트가 온다. */
  | { type: 'flush' }
  /** 시스템 콜 추적을 켜거나 끈다. */
  | { type: 'trace'; on: boolean }
