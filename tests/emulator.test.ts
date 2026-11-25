import { describe, expect, it } from 'vitest'
import { Emulator, lineText } from '../src/ui/terminal/emulator.ts'

const term = (cols = 20, rows = 4) => new Emulator(cols, rows)
const visible = (e: Emulator) => e.screenText().filter((l) => l !== '')

describe('Emulator', () => {
  it('prints text and handles CR, LF and backspace', () => {
    const e = term()
    e.write('hello\r\nworld\rW')
    expect(visible(e)).toEqual(['hello', 'World'])
    e.write('\b\b\bXY')
    expect(e.screenText()[1]).toBe('XYrld')
    expect([e.cx, e.cy]).toEqual([2, 1])
  })

  it('wraps at the right edge only when the next character arrives', () => {
    const e = term(5)
    e.write('abcde')
    expect([e.cx, e.cy]).toEqual([4, 0])
    e.write('\r\n')
    expect(e.cy).toBe(1)
    e.write('12345678')
    expect(visible(e)).toEqual(['abcde', '12345', '678'])
  })

  it('scrolls and keeps history', () => {
    const e = term(10, 3)
    e.write('1\r\n2\r\n3\r\n4\r\n5')
    expect(e.screenText()).toEqual(['3', '4', '5'])
    expect(e.lines.map(lineText)).toEqual(['1', '2', '3', '4', '5'])
    expect(e.cy).toBe(2)
  })

  it('places wide characters in two cells and wraps them whole', () => {
    const e = term(5)
    e.write('한글')
    expect(e.cx).toBe(4)
    expect(e.cursorLine.cells.map((c) => c.width)).toEqual([2, 0, 2, 0])
    e.write('가')
    expect(visible(e)).toEqual(['한글', '가'])
  })

  it('erases a wide character with the TTY backspace sequence', () => {
    const e = term()
    e.write('a한')
    e.write('\b\b  \b\b')
    expect(e.screenText()[0]).toBe('a')
    expect(e.cx).toBe(1)
  })

  it('overwriting half of a wide character clears the other half', () => {
    const e = term()
    e.write('한글\r')
    e.write('\x1b[C')
    e.write('x')
    expect(e.screenText()[0]).toBe(' x글')
  })

  it('applies and resets colors', () => {
    const e = term()
    e.write('\x1b[1;32mok\x1b[0m \x1b[91;44mx\x1b[39my')
    const cells = e.cursorLine.cells
    expect(cells[0]).toMatchObject({ ch: 'o', fg: 2, bold: true })
    expect(cells[2]).toMatchObject({ ch: ' ', fg: -1, bold: false })
    expect(cells[3]).toMatchObject({ ch: 'x', fg: 9, bg: 4 })
    expect(cells[4]).toMatchObject({ ch: 'y', fg: -1, bg: 4 })
  })

  it('moves the cursor with CSI sequences and clamps to the screen', () => {
    const e = term(10, 4)
    e.write('\x1b[3;5H')
    expect([e.cx, e.cy]).toEqual([4, 2])
    e.write('\x1b[A\x1b[2D')
    expect([e.cx, e.cy]).toEqual([2, 1])
    e.write('\x1b[99B\x1b[99C')
    expect([e.cx, e.cy]).toEqual([9, 3])
    e.write('\x1b[H')
    expect([e.cx, e.cy]).toEqual([0, 0])
  })

  it('erases parts of a line', () => {
    const e = term()
    e.write('abcdef\x1b[3D\x1b[K')
    expect(e.screenText()[0]).toBe('abc')
    e.write('\rxyz123\x1b[4D\x1b[1K')
    expect(e.screenText()[0]).toBe('   123')
    e.write('\x1b[2K')
    expect(e.screenText()[0]).toBe('')
  })

  it('clear wipes the screen and the history', () => {
    const e = term(10, 3)
    e.write('1\r\n2\r\n3\r\n4\r\n5')
    e.write('\x1b[H\x1b[2J\x1b[3J')
    expect(e.lines.length).toBe(3)
    expect(visible(e)).toEqual([])
    expect([e.cx, e.cy]).toEqual([0, 0])
    expect(e.removed.length).toBe(2)
  })

  it('ignores unknown sequences without printing them', () => {
    const e = term()
    e.write('a\x1b]0;title\x07b\x1b[?2004hc\x1b[5nd\x07')
    expect(e.screenText()[0]).toBe('abcd')
  })

  it('hides and shows the cursor', () => {
    const e = term()
    e.write('\x1b[?25l')
    expect(e.cursorVisible).toBe(false)
    e.write('\x1b[?25h')
    expect(e.cursorVisible).toBe(true)
  })

  it('keeps the cursor on its line when the screen is resized', () => {
    const e = term(10, 4)
    e.write('a\r\nb')
    e.resize(10, 2)
    expect(e.screenText()).toEqual(['a', 'b'])
    expect(e.cy).toBe(1)
    e.resize(10, 6)
    expect(e.screenText().slice(0, 2)).toEqual(['a', 'b'])
    expect(e.cy).toBe(1)

    const full = term(10, 3)
    full.write('1\r\n2\r\n3\r\n4')
    full.resize(10, 2)
    expect(full.screenText()).toEqual(['3', '4'])
    expect(full.cy).toBe(1)
  })

  it('marks inverse text and clears it on reset', () => {
    const e = term()
    e.write('\x1b[7mbar\x1b[27mx\x1b[7my\x1b[0mz')
    expect(e.cursorLine.cells.map((c) => c.inverse)).toEqual([true, true, true, false, true, false])
  })

  it('the alternate screen hides the main screen and gives it back untouched', () => {
    const e = term(10, 3)
    e.write('one\r\ntwo\r\nthree\r\nfour')
    const before = { lines: e.lines.map(lineText), cx: e.cx, cy: e.cy }
    const mainLines = [...e.lines]

    e.write('\x1b[?1049h')
    expect(e.alternate).toBe(true)
    expect(e.screenText()).toEqual(['', '', ''])
    expect([e.cx, e.cy]).toEqual([0, 0])
    // 원래 화면의 줄은 화면에서 내려간다.
    expect(e.removed).toEqual(mainLines)

    // 대체 화면은 밀려난 줄을 기록으로 남기지 않는다.
    e.write('a\r\nb\r\nc\r\nd\r\ne')
    expect(e.lines.map(lineText)).toEqual(['c', 'd', 'e'])

    e.removed.length = 0
    e.dirty.clear()
    e.write('\x1b[?1049l')
    expect(e.alternate).toBe(false)
    expect({ lines: e.lines.map(lineText), cx: e.cx, cy: e.cy }).toEqual(before)
    // 돌아온 줄들은 위에서부터 순서대로 다시 그려진다.
    expect([...e.dirty]).toEqual(mainLines)
    expect(e.removed.some((line) => mainLines.includes(line))).toBe(false)
    e.write('!')
    expect(e.screenText().at(-1)).toBe('four!')
  })

  it('leaving the alternate screen twice, or without entering, is harmless', () => {
    const e = term(10, 3)
    e.write('keep\x1b[?1049l\x1b[?1049h\x1b[?1049h\x1b[?1049l\x1b[?1049l')
    expect(e.screenText()[0]).toBe('keep')
    expect(e.alternate).toBe(false)
  })

  it('tracks which lines need redrawing', () => {
    const e = term(10, 3)
    e.dirty.clear()
    e.write('x')
    expect([...e.dirty]).toEqual([e.lines[0]])
  })
})
