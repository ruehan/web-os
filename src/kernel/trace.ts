// 시스템 콜을 사람이 읽을 수 있는 한 줄로 풀어 쓴다 (strace와 비슷한 표기).
import { GuiEvent, POINTER_SCALE } from './gui.ts'
import { FdFlags, FileType, OFlags, Signal, Sys, WAIT_STOPPED, WaitFlags, type SysReq, type SysRes } from './abi.ts'
import { Errno } from './errno.ts'

export interface TraceRecord {
  seq: number
  /** 호출이 끝난 시각 (부팅 후 밀리초) */
  time: number
  pid: number
  /** 프로그램 이름 */
  comm: string
  /** 호출 이름 */
  call: string
  args: string
  /** "= 3", "= -1 ENOENT" 등. 응답 없이 끝나는 호출(exit)은 빈 문자열이다. */
  result: string
  error: boolean
  /** 조건이 충족되기를 기다리며 멈춰 있던 시간 (밀리초). 바로 끝났으면 없다. */
  waited?: number
}

const GUI_EVENT_NAMES = new Map<number, string>(Object.entries(GuiEvent).map(([name, kind]) => [kind, name]))
const SYS_NAMES = new Map<number, string>(Object.entries(Sys).map(([name, nr]) => [nr, name]))
const ERRNO_NAMES = new Map<number, string>(Object.entries(Errno).map(([name, nr]) => [nr, `E${name}`]))
const FILE_TYPES: Record<number, string> = {
  [FileType.CHAR_DEVICE]: 'tty',
  [FileType.DIRECTORY]: 'dir',
  [FileType.REGULAR]: 'file',
  [FileType.UNKNOWN]: 'pipe',
}

const PREVIEW_BYTES = 32

const quote = (s: string) => JSON.stringify(s)

/** 프로세스는 경로를 루트 디렉터리(fd 3) 기준으로 넘긴다. 읽기 쉽게 절대 경로로 보여 준다. */
const pathOf = (dirfd: number, path: string) => quote(dirfd === 3 ? `/${path}` : path)

/** 데이터의 앞부분을 문자열로 보여 준다. 글자가 아닌 바이트는 \xNN 으로 적는다. */
function preview(data: Uint8Array): string {
  let out = ''
  const text = new TextDecoder().decode(data.subarray(0, PREVIEW_BYTES))
  for (const ch of text) {
    if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch === '"' || ch === '\\') out += `\\${ch}`
    else if (ch < ' ' || ch === '\x7f' || ch === '�') out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0').slice(-2)}`
    else out += ch
  }
  return `"${out}"${data.length > PREVIEW_BYTES ? '…' : ''}`
}

function flags(value: number, names: Record<string, number>): string {
  const set = Object.entries(names)
    .filter(([, bit]) => value & bit)
    .map(([name]) => name)
  return set.join('|')
}

export const sysName = (nr: number) => SYS_NAMES.get(nr) ?? `sys_${nr}`

export function describeArgs(req: SysReq): string {
  const [a0 = 0, a1 = 0, a2 = 0, a3 = 0] = req.args
  const path = req.path ?? ''
  switch (req.nr) {
    case Sys.write: {
      const data = req.data ?? new Uint8Array(0)
      return `${a0}, ${preview(data)}, ${data.length}`
    }
    case Sys.read:
      return `${a0}, ${a1}`
    case Sys.seek:
      return `${a0}, ${a1}, ${['SET', 'CUR', 'END'][a2] ?? a2}`
    case Sys.open: {
      const mode = [flags(a1, OFlags), flags(a2, FdFlags)].filter(Boolean).join('|')
      return pathOf(a0, path) + (mode ? `, ${mode}` : '')
    }
    case Sys.pathstat:
    case Sys.mkdir:
    case Sys.unlink:
    case Sys.rmdir:
      return pathOf(a0, path)
    case Sys.rename: {
      const [from = '', to = ''] = path.split('\0')
      return `${pathOf(a0, from)}, ${pathOf(a1, to)}`
    }
    case Sys.readdir:
      return `${a0}, ${a1}`
    case Sys.spawn: {
      // 표준 입출력을 다른 곳으로 돌렸을 때만 적는다.
      const stdio = a0 === 0 && a1 === 1 && a2 === 2 ? '' : `, stdio=[${a0},${a1},${a2}]`
      return `${quote(path)}, [${(req.argv ?? []).map(quote).join(', ')}]${stdio}${a3 > 0 ? `, pgid=${a3}` : ''}`
    }
    case Sys.wait:
      return `${a0}${a1 & WaitFlags.NOHANG ? ', NOHANG' : ''}${a1 & WaitFlags.UNTRACED ? ', UNTRACED' : ''}`
    case Sys.ttyraw:
      return a0 ? 'on' : 'off'
    case Sys.pollin:
      return `${a0}, ${a1}ms`
    case Sys.guiopen:
      return `${quote(path)}, ${a0}x${a1}`
    case Sys.guidraw:
      return `${req.data?.length ?? 0} bytes`
    case Sys.guievent:
      return a0 < 0 ? '' : `${a0}ms`
    case Sys.guitext:
      return `${a0}, ${a1}, ${a2}`
    case Sys.guisettext:
      return `${a0}, ${preview(req.data ?? new Uint8Array(0))}, ${req.data?.length ?? 0}`
    case Sys.guimeasure:
      return `${req.data?.length ?? 0} bytes`
    case Sys.guiimage:
      return quote(req.path ?? '')
    case Sys.fetch:
      return `${quote(req.path ?? '')}${a0 ? ', HEAD' : ''}`
    case Sys.kill:
      return `${a0}${a1 === Signal.STOP ? ', STOP' : a1 === Signal.CONT ? ', CONT' : ''}`
    case Sys.guistyle:
      return `${a0}, ${(req.data?.length ?? 0) / 13} ranges`
    case Sys.pipe:
    case Sys.getpid:
    case Sys.winsize:
      return ''
    default:
      return req.args.length ? String(a0) : ''
  }
}

export function describeResult(req: SysReq, res: SysRes): { result: string; error: boolean } {
  if (res.errno) return { result: `= -1 ${ERRNO_NAMES.get(res.errno) ?? `errno ${res.errno}`}`, error: true }
  const data = res.data
  const u32 = (i: number) => (data && data.length >= (i + 1) * 4 ? new DataView(data.buffer, data.byteOffset).getUint32(i * 4, true) : 0)
  const i32 = (i: number) => (data && data.length >= (i + 1) * 4 ? new DataView(data.buffer, data.byteOffset).getInt32(i * 4, true) : 0)
  let result: string
  switch (req.nr) {
    case Sys.read:
    case Sys.readdir:
    case Sys.guitext:
      result = `${data?.length ?? 0}`
      break
    case Sys.guimeasure:
      result = `${(data?.length ?? 0) / 4} widths`
      break
    case Sys.guiimage: {
      const view = data && data.length >= 8 ? new DataView(data.buffer, data.byteOffset) : undefined
      result = view ? `${view.getFloat32(0, true)}x${view.getFloat32(4, true)}` : 'none'
      break
    }
    case Sys.fdstat:
      result = FILE_TYPES[res.ret ?? 0] ?? String(res.ret)
      break
    case Sys.prestat:
      result = quote(new TextDecoder().decode(data))
      break
    case Sys.pipe:
      result = `[${u32(0)}, ${u32(1)}]`
      break
    case Sys.winsize:
      result = `${u32(0)}x${u32(1)}`
      break
    case Sys.wait:
      result = !res.ret ? '0' : i32(0) === WAIT_STOPPED ? `${res.ret} (stopped)` : `${res.ret} (exit ${i32(0)})`
      break
    case Sys.guievent:
      if (!res.ret) result = '0'
      else {
        // 포인터 좌표는 픽셀로 되돌려 보여 준다.
        const pointer = i32(0) >= GuiEvent.pointerDown && i32(0) <= GuiEvent.pointerUp
        const px = (v: number) => (pointer ? Math.round((v / POINTER_SCALE) * 10) / 10 : v)
        result = `${GUI_EVENT_NAMES.get(i32(0)) ?? i32(0)}(${px(i32(1))}, ${px(i32(2))}, ${i32(3)})`
      }
      break
    default:
      result = String(res.ret ?? 0)
  }
  return { result: `= ${result}`, error: false }
}
