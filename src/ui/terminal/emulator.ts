// 터미널 에뮬레이터의 화면 모델. 프로그램이 보낸 문자와 제어 시퀀스(VT100/ANSI의 일부)를
// 해석해 글자 격자를 갱신한다. DOM을 모르며, 그리는 일은 Terminal 컴포넌트가 한다.
import { charWidth } from '../../shared/wcwidth.ts'

export interface Cell {
  ch: string
  /** 0은 2칸짜리 글자의 오른쪽 절반 자리다. */
  width: 0 | 1 | 2
  /** 0–15는 팔레트 색, -1은 기본색 */
  fg: number
  bg: number
  bold: boolean
}

export interface Line {
  cells: Cell[]
}

const SCROLLBACK = 5000
const TAB = 8

const blank = (): Cell => ({ ch: ' ', width: 1, fg: -1, bg: -1, bold: false })

export function lineText(line: Line): string {
  return line.cells
    .map((c) => c.ch)
    .join('')
    .trimEnd()
}

export class Emulator {
  cols: number
  rows: number
  /** 스크롤 기록과 현재 화면. 마지막 rows개가 화면이다. */
  lines: Line[] = []
  /** 화면 안에서의 커서 위치 */
  cx = 0
  cy = 0
  cursorVisible = true
  /** 다시 그려야 하는 줄 (새로 생긴 줄 포함, 생긴 순서대로) */
  dirty = new Set<Line>()
  /** 스크롤 기록에서 밀려나 사라진 줄 */
  removed: Line[] = []

  /** 마지막 칸에 글자를 쓴 직후: 다음 글자가 올 때 비로소 줄을 넘긴다. */
  private pendingWrap = false
  private fg = -1
  private bg = -1
  private bold = false
  private state: 'ground' | 'esc' | 'csi' | 'osc' = 'ground'
  private params = ''
  private saved = { cx: 0, cy: 0 }

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    for (let i = 0; i < rows; i++) this.addLine()
  }

  get base(): number {
    return this.lines.length - this.rows
  }

  get cursorLine(): Line {
    return this.lines[this.base + this.cy]!
  }

  /** 화면에 보이는 줄들의 텍스트 (테스트와 디버깅용) */
  screenText(): string[] {
    return this.lines.slice(this.base).map(lineText)
  }

  write(text: string): void {
    for (const ch of text) this.step(ch)
  }

  resize(cols: number, rows: number): void {
    const cursorIndex = this.base + this.cy
    while (this.lines.length < rows) this.addLine()
    // 화면이 줄어들 때는 커서 아래의 빈 줄부터 버려서 내용이 위로 밀려나지 않게 한다.
    while (this.lines.length > rows && this.lines.length - 1 > cursorIndex && this.lines.at(-1)!.cells.length === 0) {
      this.dropLine(this.lines.pop()!)
    }
    this.cols = cols
    this.rows = rows
    this.cy = Math.min(rows - 1, Math.max(0, cursorIndex - this.base))
    this.cx = Math.min(this.cx, cols - 1)
    this.pendingWrap = false
  }

  // ───────────── 해석 ─────────────

  private step(ch: string): void {
    switch (this.state) {
      case 'ground':
        return this.ground(ch)
      case 'esc':
        this.state = 'ground'
        if (ch === '[') {
          this.state = 'csi'
          this.params = ''
        } else if (ch === ']') this.state = 'osc'
        else if (ch === '7') this.saved = { cx: this.cx, cy: this.cy }
        else if (ch === '8') this.moveTo(this.saved.cx, this.saved.cy)
        return
      case 'csi':
        if (ch >= '@' && ch <= '~') {
          this.state = 'ground'
          this.csi(ch)
        } else if (ch === '\x1b') this.state = 'esc'
        else this.params += ch
        return
      case 'osc':
        // 창 제목 설정 등: 내용은 무시하고 끝(BEL 또는 ESC \)까지 건너뛴다.
        if (ch === '\x07') this.state = 'ground'
        else if (ch === '\x1b') this.state = 'esc'
        return
    }
  }

  private ground(ch: string): void {
    switch (ch) {
      case '\x1b':
        this.state = 'esc'
        return
      case '\r':
        this.moveTo(0, this.cy)
        return
      case '\n':
        this.pendingWrap = false
        this.lineFeed()
        return
      case '\b':
        this.moveTo(this.cx - 1, this.cy)
        return
      case '\t':
        this.moveTo((Math.floor(this.cx / TAB) + 1) * TAB, this.cy)
        return
    }
    if (ch < ' ' || ch === '\x7f') return

    const width = charWidth(ch)
    if (width === 0) {
      // 결합 문자는 앞 글자에 붙인다.
      const prev = this.cursorLine.cells[this.pendingWrap ? this.cx : this.cx - 1]
      if (prev) {
        prev.ch += ch
        this.dirty.add(this.cursorLine)
      }
      return
    }
    if (this.pendingWrap || this.cx + width > this.cols) {
      this.cx = 0
      this.pendingWrap = false
      this.lineFeed()
    }
    const line = this.cursorLine
    const cells = line.cells
    while (cells.length < this.cx) cells.push(blank())
    this.splitWide(cells, this.cx)
    if (width === 2) this.splitWide(cells, this.cx + 1)
    const attrs = { fg: this.fg, bg: this.bg, bold: this.bold }
    cells[this.cx] = { ch, width, ...attrs }
    if (width === 2) cells[this.cx + 1] = { ch: '', width: 0, ...attrs }
    this.dirty.add(line)
    this.cx += width
    if (this.cx >= this.cols) {
      this.cx = this.cols - 1
      this.pendingWrap = true
    }
  }

  /** 덮어쓸 자리에 2칸 글자의 절반이 걸쳐 있으면 나머지 절반도 지운다. */
  private splitWide(cells: Cell[], i: number): void {
    const cell = cells[i]
    if (!cell) return
    if (cell.width === 0 && i > 0) cells[i - 1] = blank()
    if (cell.width === 2 && cells[i + 1]) cells[i + 1] = blank()
  }

  private csi(final: string): void {
    const priv = this.params.startsWith('?')
    const nums = this.params
      .replace(/^[?>=]/, '')
      .split(';')
      .map((s) => (s === '' ? NaN : parseInt(s, 10)))
    const arg = (i: number, fallback: number) => {
      const n = nums[i]
      return n === undefined || Number.isNaN(n) ? fallback : n
    }
    switch (final) {
      case 'A':
        return this.moveTo(this.cx, this.cy - arg(0, 1))
      case 'B':
        return this.moveTo(this.cx, this.cy + arg(0, 1))
      case 'C':
        return this.moveTo(this.cx + arg(0, 1), this.cy)
      case 'D':
        return this.moveTo(this.cx - arg(0, 1), this.cy)
      case 'G':
        return this.moveTo(arg(0, 1) - 1, this.cy)
      case 'd':
        return this.moveTo(this.cx, arg(0, 1) - 1)
      case 'H':
      case 'f':
        return this.moveTo(arg(1, 1) - 1, arg(0, 1) - 1)
      case 'J':
        return this.eraseDisplay(arg(0, 0))
      case 'K':
        return this.eraseLine(this.cursorLine, arg(0, 0))
      case 'm':
        return this.sgr(nums.map((n) => (Number.isNaN(n) ? 0 : n)))
      case 'h':
      case 'l':
        if (priv && nums[0] === 25) this.cursorVisible = final === 'h'
        return
      case 's':
        this.saved = { cx: this.cx, cy: this.cy }
        return
      case 'u':
        return this.moveTo(this.saved.cx, this.saved.cy)
    }
  }

  private sgr(codes: number[]): void {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!
      if (c === 0) {
        this.fg = this.bg = -1
        this.bold = false
      } else if (c === 1) this.bold = true
      else if (c === 22) this.bold = false
      else if (c >= 30 && c <= 37) this.fg = c - 30
      else if (c === 39) this.fg = -1
      else if (c >= 40 && c <= 47) this.bg = c - 40
      else if (c === 49) this.bg = -1
      else if (c >= 90 && c <= 97) this.fg = c - 90 + 8
      else if (c >= 100 && c <= 107) this.bg = c - 100 + 8
      else if (c === 38 || c === 48) {
        // 확장 색: 256색 중 앞의 16색만 지원하고 나머지는 기본색으로 둔다.
        const mode = codes[i + 1]
        const color = mode === 5 && codes[i + 2]! < 16 ? codes[i + 2]! : -1
        if (c === 38) this.fg = color
        else this.bg = color
        i += mode === 5 ? 2 : mode === 2 ? 4 : 0
      }
    }
  }

  // ───────────── 화면 조작 ─────────────

  private moveTo(cx: number, cy: number): void {
    this.cx = Math.min(this.cols - 1, Math.max(0, cx))
    this.cy = Math.min(this.rows - 1, Math.max(0, cy))
    this.pendingWrap = false
  }

  private lineFeed(): void {
    if (this.cy < this.rows - 1) {
      this.cy++
      return
    }
    this.addLine()
    if (this.lines.length > SCROLLBACK + this.rows) this.dropLine(this.lines.shift()!)
  }

  private addLine(): void {
    const line: Line = { cells: [] }
    this.lines.push(line)
    this.dirty.add(line)
  }

  private dropLine(line: Line): void {
    this.dirty.delete(line)
    this.removed.push(line)
  }

  /** mode 0: 커서부터 끝까지, 1: 처음부터 커서까지, 2: 줄 전체 */
  private eraseLine(line: Line, mode: number): void {
    const cells = line.cells
    if (mode === 0) {
      this.splitWide(cells, this.cx)
      cells.length = Math.min(cells.length, this.cx)
    } else if (mode === 1) {
      this.splitWide(cells, this.cx)
      for (let i = 0; i <= this.cx && i < cells.length; i++) cells[i] = blank()
    } else {
      cells.length = 0
    }
    this.dirty.add(line)
  }

  /** mode 0: 커서 아래, 1: 커서 위, 2: 화면 전체, 3: 스크롤 기록 */
  private eraseDisplay(mode: number): void {
    const screen = this.lines.slice(this.base)
    if (mode === 3) {
      for (const line of this.lines.splice(0, this.base)) this.dropLine(line)
      return
    }
    if (mode === 0 || mode === 1) this.eraseLine(this.cursorLine, mode)
    screen.forEach((line, y) => {
      if (mode === 2 || (mode === 0 && y > this.cy) || (mode === 1 && y < this.cy)) this.eraseLine(line, 2)
    })
  }
}
