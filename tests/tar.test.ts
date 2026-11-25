import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packTar, unpackTar, type TarEntry } from '../src/kernel/tar.ts'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : null)
const plain = (entries: TarEntry[]) => entries.map((e) => [e.path, text(e.data)])
/** 시스템 tar가 한글 이름을 그대로 다루도록 UTF-8 환경에서 실행한다. */
const tar = (args: string[]) =>
  execFileSync('tar', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8', COPYFILE_DISABLE: '1' } })

const longDir = '아주긴폴더이름'.repeat(8)
const sample: TarEntry[] = [
  { path: 'home' },
  { path: 'home/guest' },
  { path: 'home/guest/note.txt', data: bytes('안녕\n') },
  { path: 'home/guest/empty', data: new Uint8Array(0) },
  { path: 'home/guest/exact', data: new Uint8Array(512).fill(65) },
  { path: `home/${longDir}` },
  { path: `home/${longDir}/한글 파일 이름.txt`, data: bytes('long') },
]

describe('tar', () => {
  it('round-trips files, directories, empty files and long non-ASCII names', () => {
    expect(plain(unpackTar(packTar(sample)))).toEqual(plain(sample))
  })

  it('is made of whole 512-byte blocks and ends with two empty ones', () => {
    const tar = packTar([{ path: 'a', data: bytes('x') }])
    expect(tar.length).toBe(512 * 4)
    expect(tar.subarray(512 * 2).every((b) => b === 0)).toBe(true)
  })

  it('produces archives that the system tar can list and extract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webos-tar-'))
    try {
      writeFileSync(join(dir, 'backup.tar'), packTar(sample))
      // macOS는 한글 이름을 자모로 풀어쓴 형태로 돌려주므로, 같은 형태로 맞춰 비교한다.
      const listed = tar(['-tf', join(dir, 'backup.tar')]).normalize('NFC').trim().split('\n')
      expect(listed).toContain('home/guest/note.txt')
      expect(listed).toContain(`home/${longDir}/한글 파일 이름.txt`)
      tar(['-xf', join(dir, 'backup.tar'), '-C', dir])
      expect(readFileSync(join(dir, 'home/guest/note.txt'), 'utf8')).toBe('안녕\n')
      expect(readFileSync(join(dir, `home/${longDir}/한글 파일 이름.txt`), 'utf8')).toBe('long')
      expect(readdirSync(join(dir, 'home/guest')).sort()).toEqual(['empty', 'exact', 'note.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads archives made by the system tar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webos-tar-'))
    try {
      execFileSync('mkdir', ['-p', join(dir, 'src/docs', longDir)])
      writeFileSync(join(dir, 'src/a.txt'), 'from tar\n')
      writeFileSync(join(dir, 'src/docs', longDir, '긴 이름.txt'), 'deep')
      tar(['-cf', join(dir, 'made.tar'), '-C', join(dir, 'src'), '.'])
      const entries = unpackTar(readFileSync(join(dir, 'made.tar')))
      const files = Object.fromEntries(entries.filter((e) => e.data).map((e) => [e.path.normalize('NFC'), text(e.data)]))
      expect(files).toEqual({ 'a.txt': 'from tar\n', [`docs/${longDir}/긴 이름.txt`]: 'deep' })
      expect(entries.filter((e) => !e.data).map((e) => e.path.normalize('NFC')).sort()).toEqual(['docs', `docs/${longDir}`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects things that are not tar archives', () => {
    expect(() => unpackTar(bytes('just some text'))).toThrow('not a tar archive')
    expect(() => unpackTar(new Uint8Array(2048).fill(7))).toThrow('bad header checksum')
    const damaged = packTar(sample)
    damaged[10] = damaged[10]! ^ 0xff
    expect(() => unpackTar(damaged)).toThrow('bad header checksum')
    // 내려받다 끊긴 파일
    expect(() => unpackTar(packTar(sample).subarray(0, 512 * 3 + 10))).toThrow('truncated')
    expect(() => unpackTar(packTar(sample).subarray(0, 512 * 4))).toThrow('truncated')
  })

  it('refuses paths that climb out of the archive', () => {
    expect(() => unpackTar(packTar([{ path: 'a/../../etc/passwd', data: bytes('x') }]))).toThrow('unsafe path')
  })

  it('accepts an empty archive', () => {
    expect(unpackTar(packTar([]))).toEqual([])
  })
})
