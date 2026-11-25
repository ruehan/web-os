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

  /** 키보드 → 줄 편집 */
  input(text: string): void {
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
