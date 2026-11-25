import { describe, expect, it } from 'vitest'
import { Errno, KernelError } from '../src/kernel/errno.ts'
import { MemFs } from '../src/kernel/vfs/memfs.ts'

const text = (b: Uint8Array) => new TextDecoder().decode(b)
const bytes = (s: string) => new TextEncoder().encode(s)

function errnoOf(fn: () => unknown): number {
  try {
    fn()
  } catch (e) {
    if (e instanceof KernelError) return e.errno
    throw e
  }
  throw new Error('expected a KernelError')
}

describe('MemFs', () => {
  it('writes and reads back a file', () => {
    const fs = new MemFs()
    fs.mkdirp('/a/b')
    fs.writeFile('/a/b/f.txt', bytes('hello'))
    expect(text(fs.readFile('/a/b/f.txt'))).toBe('hello')
  })

  it('resolves relative paths, "." and ".."', () => {
    const fs = new MemFs()
    const b = fs.mkdirp('/a/b')
    fs.writeFile('/a/top.txt', bytes('x'))
    expect(fs.lookup(b, '../top.txt').kind).toBe('file')
    expect(fs.lookup(b, './../../a/b')).toBe(b)
    expect(fs.lookup(b, '/../..')).toBe(fs.root)
  })

  it('reports missing entries and non-directories', () => {
    const fs = new MemFs()
    fs.writeFile('/f', bytes('x'))
    expect(errnoOf(() => fs.lookup(fs.root, '/nope'))).toBe(Errno.NOENT)
    expect(errnoOf(() => fs.lookup(fs.root, '/f/child'))).toBe(Errno.NOTDIR)
    expect(errnoOf(() => fs.mkdir(fs.root, 'f'))).toBe(Errno.EXIST)
  })

  it('grows on write and zero-fills gaps', () => {
    const fs = new MemFs()
    const f = fs.createFile(fs.root, 'f')
    fs.write(f, 0, bytes('abc'))
    fs.write(f, 6, bytes('z'))
    expect([...fs.readFile('/f')]).toEqual([97, 98, 99, 0, 0, 0, 122])
  })

  it('does not leak old contents after truncate', () => {
    const fs = new MemFs()
    const f = fs.createFile(fs.root, 'f')
    fs.write(f, 0, bytes('secret'))
    fs.truncate(f)
    fs.write(f, 4, bytes('!'))
    expect([...fs.readFile('/f')]).toEqual([0, 0, 0, 0, 33])
  })

  it('reads are clamped to the file size', () => {
    const fs = new MemFs()
    const f = fs.createFile(fs.root, 'f')
    fs.write(f, 0, bytes('abcdef'))
    expect(text(fs.read(f, 4, 100))).toBe('ef')
    expect(fs.read(f, 6, 10).length).toBe(0)
  })

  it('unlink removes files but refuses directories', () => {
    const fs = new MemFs()
    fs.mkdirp('/d')
    fs.writeFile('/f', bytes('x'))
    fs.unlink(fs.root, 'f')
    expect(errnoOf(() => fs.lookup(fs.root, '/f'))).toBe(Errno.NOENT)
    expect(errnoOf(() => fs.unlink(fs.root, 'd'))).toBe(Errno.ISDIR)
  })
})
