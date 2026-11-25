// WASI preview1 errno 값. 커널 내부 오류도 같은 번호 체계를 쓴다.
export const Errno = {
  SUCCESS: 0,
  ACCES: 2,
  BADF: 8,
  CHILD: 12,
  EXIST: 20,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  NOENT: 44,
  NOEXEC: 45,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTTY: 59,
  SPIPE: 70,
  SRCH: 71,
} as const

export class KernelError extends Error {
  errno: number

  constructor(errno: number, message?: string) {
    super(message ?? `errno ${errno}`)
    this.errno = errno
  }
}
