import { charWidth } from '../shared/wcwidth.ts'
import { WaitQueue } from './pipe.ts'

export interface TtyHost {
  /** 터미널 화면으로 나가는 바이트 */
  output(data: Uint8Array): void
  /** Ctrl+C */
  interrupt(): void
  /** 읽을 입력이 생겼다 */
  readable(): void
}

const enc = new TextEncoder()

/**
 * 터미널 장치. 키보드 입력을 줄 단위로 모아(줄 편집, 에코) 프로세스에 넘기고,
 * 프로세스 출력의 줄바꿈을 터미널이 기대하는 CR LF로 바꾼다.
 */
export class Tty {
  id: number
  /** 키보드 입력을 받을 수 있는 전경 프로세스 그룹 */
  fg = 0
  readQ = new WaitQueue()
  /** 화면 크기 (글자 수). 줄 편집기가 줄바꿈 위치를 계산하는 데 쓴다. */
  cols = 80
  rows = 24
  /**
   * 키 단위 입력 모드. 켜면 줄 편집·에코·Ctrl+C 처리를 하지 않고 키 입력을 그대로 넘긴다.
   * 셸의 줄 편집기처럼 화면을 직접 다루는 프로그램이 쓴다.
   */
  raw = false

  private host: TtyHost
  private line: string[] = []
  /** 완성된 입력 덩어리. 길이 0인 덩어리는 EOF(Ctrl+D)를 뜻한다. */
  private ready: Uint8Array[] = []
  private escape: 'none' | 'esc' | 'csi' = 'none'

  constructor(id: number, host: TtyHost) {
    this.id = id
    this.host = host
  }

  /** 프로세스 → 화면 */
  write(data: Uint8Array): void {
    let newlines = 0
    for (const b of data) if (b === 10) newlines++
    if (newlines === 0) return this.host.output(data)
    const out = new Uint8Array(data.length + newlines)
    let j = 0
    for (const b of data) {
      if (b === 10) out[j++] = 13
      out[j++] = b
    }
    this.host.output(out)
  }

  /** 읽으면 바로 돌려줄 입력이 있는가 */
  hasInput(): boolean {
    return this.ready.length > 0
  }

  /** 프로세스 ← 키보드. 읽을 것이 없으면 null (호출자가 멈춰야 한다). */
  read(max: number): Uint8Array | null {
    const chunk = this.ready[0]
    if (!chunk) return null
    if (chunk.length <= max) {
      this.ready.shift()
      return chunk
    }
    this.ready[0] = chunk.subarray(max)
    return chunk.subarray(0, max)
  }

  /** 편집 중인 줄과 상관없이 입력을 밀어 넣는다. */
  deliver(text: string): void {
    this.ready.push(enc.encode(text))
    this.host.readable()
  }

  setRaw(on: boolean): void {
    if (on === this.raw) return
    this.raw = on
    if (on) {
      // 줄 모드에서 치다 만 내용은 버리지 않고 그대로 넘겨준다.
      if (this.line.length === 0) return
      this.ready.push(enc.encode(this.line.join('')))
      this.line = []
      this.host.readable()
    } else {
      // 키 단위 모드에서 아직 읽히지 않은 입력은 줄 모드의 규칙(에코, 줄 편집)으로 다시 처리한다.
      // 그래야 셸이 명령을 실행하기 직전에 미리 친 키가 그 명령에 올바르게 전달된다.
      const dec = new TextDecoder()
      const unread = this.ready.map((chunk) => dec.decode(chunk, { stream: true })).join('')
      this.ready = []
      if (unread) this.input(unread)
    }
  }

  /** 키보드 → 프로세스 */
  input(text: string): void {
    if (this.raw) {
      if (text) this.deliver(text)
      return
    }
    let echo = ''
    let wake = false
    for (const ch of text) {
      if (this.escape !== 'none') {
        // 방향키 같은 이스케이프 시퀀스는 줄 편집 모드에서 버린다.
        if (this.escape === 'esc') this.escape = ch === '[' || ch === 'O' ? 'csi' : 'none'
        else if (ch >= '@' && ch <= '~') this.escape = 'none'
        continue
      }
      switch (ch) {
        case '\x1b':
          this.escape = 'esc'
          break
        case '\r':
        case '\n':
          echo += '\r\n'
          this.ready.push(enc.encode(this.line.join('') + '\n'))
          this.line = []
          wake = true
          break
        case '\x7f':
        case '\b':
          echo += this.erase(1)
          break
        case '\x15': // Ctrl+U: 줄 전체 지우기
          echo += this.erase(this.line.length)
          break
        case '\x17': {
          // Ctrl+W: 단어 하나 지우기
          let n = 0
          while (n < this.line.length && this.line[this.line.length - 1 - n] === ' ') n++
          while (n < this.line.length && this.line[this.line.length - 1 - n] !== ' ') n++
          echo += this.erase(n)
          break
        }
        case '\x03': // Ctrl+C
          this.line = []
          this.host.output(enc.encode(echo + '^C\r\n'))
          echo = ''
          this.host.interrupt()
          break
        case '\x04': // Ctrl+D: 빈 줄이면 EOF, 아니면 지금까지 친 내용을 바로 넘긴다
          this.ready.push(enc.encode(this.line.join('')))
          this.line = []
          wake = true
          break
        default:
          if (ch < ' ') break
          this.line.push(ch)
          echo += ch
      }
    }
    if (echo) this.host.output(enc.encode(echo))
    if (wake) this.host.readable()
  }

  private erase(count: number): string {
    let out = ''
    for (let i = 0; i < count; i++) {
      const ch = this.line.pop()
      if (ch === undefined) break
      const w = charWidth(ch)
      out += '\b'.repeat(w) + ' '.repeat(w) + '\b'.repeat(w)
    }
    return out
  }
}
