import { describe, expect, it } from 'vitest'
import { Persister, type PersistStore } from '../src/kernel/persist.ts'
import { MemFs } from '../src/kernel/vfs/memfs.ts'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

/** 메모리에 흉내 낸 저장소. 받은 요청을 순서대로 기록한다. */
function fakeStore(initial: Record<string, string | null> = {}) {
  const items = new Map<string, Uint8Array | null>(Object.entries(initial).map(([k, v]) => [k, v === null ? null : bytes(v)]))
  const log: string[] = []
  const store: PersistStore = {
    async load() {
      return [...items].map(([path, data]) => (data ? { path, data } : { path }))
    },
    async writeFile(path, data) {
      log.push(`write ${path}`)
      items.set(path, data)
    },
    async mkdir(path) {
      log.push(`mkdir ${path}`)
      items.set(path, null)
    },
    async remove(path) {
      log.push(`remove ${path}`)
      for (const key of [...items.keys()]) if (key === path || key.startsWith(`${path}/`)) items.delete(key)
    },
  }
  const dump = () => Object.fromEntries([...items].map(([k, v]) => [k, v ? text(v) : null]))
  return { store, log, dump }
}

function setup(initial?: Record<string, string | null>) {
  const fs = new MemFs()
  fs.mkdirp('/home')
  fs.mkdirp('/tmp')
  const fake = fakeStore(initial)
  const persister = new Persister(fs, '/home', fake.store)
  return { fs, persister, ...fake }
}

describe('Persister', () => {
  it('restores saved files and directories without writing them back', async () => {
    const { fs, persister, log } = setup({ guest: null, 'guest/a.txt': 'hello', 'guest/empty': null })
    expect(await persister.restore()).toBe(1)
    expect(text(fs.readFile('/home/guest/a.txt'))).toBe('hello')
    expect(fs.lookup(fs.root, '/home/guest/empty').kind).toBe('dir')
    await persister.sync()
    expect(log).toEqual([])
  })

  it('saves new and changed files, parents first, and nothing outside its root', async () => {
    const { fs, persister, log, dump } = setup()
    await persister.restore()
    fs.mkdirp('/home/guest/docs')
    fs.writeFile('/home/guest/docs/a.txt', bytes('one'))
    fs.writeFile('/tmp/scratch', bytes('not saved'))
    await persister.sync()
    expect(log).toEqual(['mkdir guest', 'mkdir guest/docs', 'write guest/docs/a.txt'])

    log.length = 0
    fs.writeFile('/home/guest/docs/a.txt', bytes('two'))
    await persister.sync()
    await persister.sync()
    expect(log).toEqual(['write guest/docs/a.txt'])
    expect(dump()).toEqual({ guest: null, 'guest/docs': null, 'guest/docs/a.txt': 'two' })
  })

  it('removes deleted entries, once per removed tree', async () => {
    const { fs, persister, log, dump } = setup({ guest: null, 'guest/d': null, 'guest/d/x': '1', 'guest/d/y': '2', 'guest/keep': 'k' })
    await persister.restore()
    const guest = fs.lookup(fs.root, '/home/guest')
    if (guest.kind !== 'dir') throw new Error('expected a directory')
    fs.removeTree(guest, 'd')
    await persister.sync()
    expect(log).toEqual(['remove guest/d'])
    expect(dump()).toEqual({ guest: null, 'guest/keep': 'k' })
  })

  it('follows renames and replacements', async () => {
    const { fs, persister, log, dump } = setup({ guest: null, 'guest/a': 'A', 'guest/b': 'B' })
    await persister.restore()
    const guest = fs.lookup(fs.root, '/home/guest')
    if (guest.kind !== 'dir') throw new Error('expected a directory')
    fs.rename(guest, 'a', guest, 'c')
    // 같은 이름으로 지웠다 다시 만든 파일은 내용이 달라졌을 수 있으므로 다시 쓴다.
    fs.unlink(guest, 'b')
    fs.writeFile('/home/guest/b', bytes('new'))
    // 파일이 있던 자리에 디렉터리가 생기는 경우
    fs.unlink(guest, 'c')
    fs.mkdirp('/home/guest/c/inner')
    await persister.sync()
    expect(log).toEqual(['remove guest/a', 'write guest/b', 'mkdir guest/c', 'mkdir guest/c/inner'])
    expect(dump()).toEqual({ guest: null, 'guest/b': 'new', 'guest/c': null, 'guest/c/inner': null })
  })

  it('replaces a directory with a file of the same name', async () => {
    const { fs, persister, log, dump } = setup({ guest: null, 'guest/x': null, 'guest/x/inner': 'i' })
    await persister.restore()
    const guest = fs.lookup(fs.root, '/home/guest')
    if (guest.kind !== 'dir') throw new Error('expected a directory')
    fs.removeTree(guest, 'x')
    fs.writeFile('/home/guest/x', bytes('now a file'))
    await persister.sync()
    expect(log).toEqual(['remove guest/x', 'write guest/x'])
    expect(dump()).toEqual({ guest: null, 'guest/x': 'now a file' })
  })

  it('batches changes made close together', async () => {
    const { fs, persister, log } = setup()
    await persister.restore()
    fs.mkdirp('/home/guest')
    for (let i = 0; i < 5; i++) {
      fs.writeFile('/home/guest/f', bytes(`v${i}`))
      persister.schedule()
    }
    expect(log).toEqual([])
    await new Promise((r) => setTimeout(r, 400))
    expect(log).toEqual(['mkdir guest', 'write guest/f'])
  })

  it('reports store failures and retries on the next change', async () => {
    const { fs, persister, store, log } = setup()
    await persister.restore()
    const errors: unknown[] = []
    persister.onError = (e) => errors.push(e)
    const write = store.writeFile
    store.writeFile = async () => {
      throw new Error('disk full')
    }
    fs.writeFile('/home/f', bytes('x'))
    await persister.sync()
    expect(errors.length).toBe(1)

    store.writeFile = write
    await persister.sync()
    expect(log).toEqual(['write f'])
  })

  it('stops saving after stop()', async () => {
    const { fs, persister, log } = setup()
    await persister.restore()
    await persister.stop()
    fs.writeFile('/home/f', bytes('x'))
    persister.schedule()
    await persister.sync()
    await new Promise((r) => setTimeout(r, 300))
    expect(log).toEqual([])
  })
})

describe('Persister over the whole tree', () => {
  function whole(initial?: Record<string, string | null>) {
    const fs = new MemFs()
    for (const dir of ['/home', '/etc', '/proc', '/tmp']) fs.mkdirp(dir)
    const fake = fakeStore(initial)
    const persister = new Persister(fs, '/', fake.store, ['proc', '.marker'])
    return { fs, persister, ...fake }
  }

  it('saves every directory except the excluded ones', async () => {
    const { fs, persister, log } = whole()
    await persister.restore()
    fs.writeFile('/etc/conf', bytes('c'))
    fs.writeFile('/proc/1', bytes('virtual'))
    fs.writeFile('/home/f', bytes('h'))
    await persister.sync()
    expect(log).toEqual(['mkdir home', 'write home/f', 'mkdir etc', 'write etc/conf', 'mkdir tmp'])
  })

  it('restores to absolute paths and ignores excluded entries in the store', async () => {
    const { fs, persister } = whole({ etc: null, 'etc/conf': 'saved', proc: null, 'proc/stale': 'x', '.marker': 'm' })
    expect(await persister.restore()).toBe(1)
    expect(text(fs.readFile('/etc/conf'))).toBe('saved')
    const proc = fs.lookup(fs.root, '/proc')
    expect(proc.kind === 'dir' && proc.entries.size).toBe(0)
    expect(() => fs.lookup(fs.root, '/.marker')).toThrow()
  })

  it('adopt() makes a store match memory, touching only what differs', async () => {
    const { fs, persister, log, dump } = whole({
      home: null,
      'home/same': 'equal',
      'home/changed': 'old',
      'home/gone': 'x',
      'home/was-dir': null,
      'home/was-dir/inner': 'i',
      proc: null,
      '.marker': 'keep me',
    })
    fs.writeFile('/home/same', bytes('equal'))
    fs.writeFile('/home/changed', bytes('new'))
    fs.writeFile('/home/was-dir', bytes('now a file'))
    fs.writeFile('/home/added', bytes('a'))
    await persister.adopt()
    await persister.sync()
    expect(log).toEqual([
      'remove home/gone',
      'remove home/was-dir',
      'write home/changed',
      'write home/was-dir',
      'write home/added',
      'mkdir etc',
      'mkdir tmp',
    ])
    // 제외한 이름은 저장소에 있어도 건드리지 않는다.
    expect(dump()).toMatchObject({ '.marker': 'keep me', 'home/same': 'equal', 'home/changed': 'new', 'home/was-dir': 'now a file' })
    expect(dump()).not.toHaveProperty('home/gone')
    expect(dump()).toHaveProperty('proc')
  })
})
