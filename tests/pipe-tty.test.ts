import { describe, expect, it } from 'vitest'
import { Pipe } from '../src/kernel/pipe.ts'
import { Tty } from '../src/kernel/tty.ts'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('Pipe', () => {
  it('returns data in order across chunk boundaries', () => {
    const p = new Pipe()
    p.write(bytes('abc'))
    p.write(bytes('defg'))
    expect(text(p.read(2))).toBe('ab')
    expect(text(p.read(4))).toBe('cdef')
    expect(text(p.read(10))).toBe('g')
    expect(p.size).toBe(0)
  })

  it('accepts only what fits', () => {
    const p = new Pipe()
    expect(p.write(new Uint8Array(Pipe.CAPACITY - 1))).toBe(Pipe.CAPACITY - 1)
    expect(p.write(bytes('xyz'))).toBe(1)
    expect(p.write(bytes('z'))).toBe(0)
    p.read(10)
    expect(p.write(bytes('z'))).toBe(1)
  })
})

describe('Tty', () => {
  function make() {
    let out = ''
    let interrupts = 0
    const tty = new Tty(1, {
      output: (d) => (out += text(d)),
      interrupt: () => interrupts++,
      suspend() {},
      readable() {},
    })
    return { tty, out: () => out, interrupts: () => interrupts }
  }

  it('hands over input only when the line is complete', () => {
    const { tty, out } = make()
    tty.input('ls')
    expect(tty.read(100)).toBeNull()
    tty.input(' -l\r')
    expect(text(tty.read(100)!)).toBe('ls -l\n')
    expect(out()).toBe('ls -l\r\n')
  })

  it('splits a long line across small reads', () => {
    const { tty } = make()
    tty.input('abcdef\r')
    expect(text(tty.read(4)!)).toBe('abcd')
    expect(text(tty.read(4)!)).toBe('ef\n')
    expect(tty.read(4)).toBeNull()
  })

  it('Ctrl+U and Ctrl+W erase the line and the last word', () => {
    const { tty } = make()
    tty.input('one two  \x17three\r')
    expect(text(tty.read(100)!)).toBe('one three\n')
    tty.input('junk\x15ok\r')
    expect(text(tty.read(100)!)).toBe('ok\n')
  })

  it('Ctrl+D signals EOF on an empty line and flushes a partial one', () => {
    const { tty } = make()
    tty.input('\x04')
    expect(tty.read(100)!.length).toBe(0)
    tty.input('ab\x04')
    expect(text(tty.read(100)!)).toBe('ab')
  })

  it('ignores arrow keys and other escape sequences', () => {
    const { tty } = make()
    tty.input('a\x1b[Ab\x1b[1;5Cc\x1bOPd\r')
    expect(text(tty.read(100)!)).toBe('abcd\n')
  })

  it('Ctrl+C drops the line and raises an interrupt', () => {
    const { tty, out, interrupts } = make()
    tty.input('abc\x03')
    expect(interrupts()).toBe(1)
    expect(out()).toBe('abc^C\r\n')
    tty.input('x\r')
    expect(text(tty.read(100)!)).toBe('x\n')
  })

  it('raw mode passes keys through untouched, without echo or interrupts', () => {
    const { tty, out, interrupts } = make()
    tty.setRaw(true)
    tty.input('a')
    tty.input('\x1b[A\x03\r')
    expect(text(tty.read(100)!)).toBe('a')
    expect(text(tty.read(100)!)).toBe('\x1b[A\x03\r')
    expect(out()).toBe('')
    expect(interrupts()).toBe(0)
  })

  it('switching to raw mode hands over a half-typed line', () => {
    const { tty } = make()
    tty.input('ec')
    expect(tty.read(100)).toBeNull()
    tty.setRaw(true)
    expect(text(tty.read(100)!)).toBe('ec')
    tty.setRaw(false)
    tty.input('ho\r')
    expect(text(tty.read(100)!)).toBe('ho\n')
  })

  it('leaving raw mode replays unread keys through line editing', () => {
    const { tty, out } = make()
    tty.setRaw(true)
    tty.input('ab\x7fc\rnext')
    tty.setRaw(false)
    expect(out()).toBe('ab\b \bc\r\nnext')
    expect(text(tty.read(100)!)).toBe('ac\n')
    expect(tty.read(100)).toBeNull()
  })

  it('translates newlines on output', () => {
    const { tty, out } = make()
    tty.write(bytes('a\nb\n'))
    expect(out()).toBe('a\r\nb\r\n')
  })
})
