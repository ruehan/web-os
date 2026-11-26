// 커널 Worker 진입점. 메인 스레드의 명령을 받고, 프로세스 Worker를 직접 띄운다.
// 파일시스템을 브라우저 저장소와 (연결돼 있으면) 사용자의 보관 폴더에 보존하는 일도 여기서 한다.
import type { KernelCommand, KernelEvent, SysReq } from './abi.ts'
import { TooLarge, directoryStore, measure, type Dir, type FileWriter } from './dirstore.ts'
import { KernelError } from './errno.ts'
import { Kernel } from './kernel.ts'
import { clearOpfs, openOpfs } from './opfs.ts'
import { Persister } from './persist.ts'
import { packTar, unpackTar, type TarEntry } from './tar.ts'
import type { DirNode } from './vfs/memfs.ts'

/** 보관 폴더임을 알리는 표시 파일. 폴더의 맨 위에 두며, OS의 파일로는 취급하지 않는다. */
const MARKER = '.webos'
/** 보존하지 않는 것: 커널이 그때그때 만들어 내는 /proc, 그리고 표시 파일 */
const EXCLUDE = ['proc', MARKER]

/** 파일시스템을 브라우저 저장소(OPFS)와 맞춰 두는 동기화기. 저장소를 쓸 수 없으면 없다. */
let persister: Persister | undefined
/** 첫 저장이 끝났음을 저장소에 기록한다 (저장소를 쓸 수 있을 때만 있다). */
let markStorageReady: (() => Promise<void>) | undefined
/** 파일시스템을 사용자의 보관 폴더와 맞춰 두는 동기화기. 연결돼 있을 때만 있다. */
let archive: Persister | undefined

const emit = (event: KernelEvent) => {
  // 파일이 바뀌었다는 알림은 화면뿐 아니라 저장의 신호이기도 하다.
  if (event.type === 'fs-change') {
    persister?.schedule()
    archive?.schedule()
  }
  self.postMessage(event)
}

const kernel: Kernel = new Kernel({
  emit,
  now: () => performance.now(),
  launch(init) {
    const worker = new Worker(new URL('../process/process.worker.ts', import.meta.url), {
      type: 'module',
      name: `pid-${init.pid}`,
    })
    worker.onmessage = (e: MessageEvent<SysReq>) => kernel.syscall(init.pid, e.data)
    worker.onerror = (e) => kernel.crashed(init.pid, e.message)
    worker.postMessage(init)
    return { terminate: () => worker.terminate() }
  },
})

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ───────────── 부팅 ─────────────

interface Initrd {
  bin: string[]
  files: string[]
}

/**
 * 지난 방문 때의 파일시스템을 되살린다.
 * fresh는 저장된 것이 없어 기본 파일을 새로 깔아야 한다는 뜻이다 (첫 방문이거나 저장소를 쓸 수 없을 때).
 */
async function restoreFiles(): Promise<{ fresh: boolean; persistent: boolean }> {
  try {
    const store = await openOpfs()
    persister = new Persister(kernel.fs, '/', store, EXCLUDE)
    markStorageReady = store.markReady
    persister.onError = (e) => kernel.log(`storage: failed to save: ${describe(e)}`)
    const files = await persister.restore()
    if (store.legacyHome) {
      for (const entry of store.legacyHome) {
        if (entry.data) kernel.fs.writeFile(`/home/${entry.path}`, entry.data)
        else kernel.fs.mkdirp(`/home/${entry.path}`)
      }
      await store.discardLegacy()
      kernel.log('storage: moved /home from the previous storage layout')
    }
    kernel.mounts.add('opfs')
    kernel.log(store.fresh ? 'storage: created persistent storage' : `storage: restored ${files} files`)
    return { fresh: store.fresh, persistent: true }
  } catch (e) {
    kernel.log(`storage: unavailable, files will not survive a reload (${describe(e)})`)
    return { fresh: true, persistent: false }
  }
}

/**
 * 빌드 때 만들어 둔 초기 파일들을 올린다.
 * 실행 파일은 매번 최신으로 맞추고(프로그램이 고쳐지면 반영돼야 한다),
 * 그 밖의 기본 파일은 사용자가 고치거나 지웠을 수 있으므로 처음 한 번만 깐다.
 */
async function loadInitrd(installDefaults: boolean): Promise<Initrd> {
  const base = import.meta.env.BASE_URL
  const fetchBytes = async (url: string) => {
    const res = await fetch(base + url)
    if (!res.ok) throw new Error(`failed to load ${url}: HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
  /** 내용이 같으면 쓰지 않는다. 쓰면 저장소에도 매번 다시 저장하게 된다. */
  const install = (path: string, data: Uint8Array) => {
    try {
      const current = kernel.fs.readFile(path)
      if (current.length === data.length && current.every((b, i) => b === data[i])) return
    } catch {
      // 아직 없는 파일
    }
    kernel.fs.mkdirp(path.slice(0, path.lastIndexOf('/')))
    kernel.fs.writeFile(path, data)
  }
  const initrd: Initrd = JSON.parse(new TextDecoder().decode(await fetchBytes('initrd.json')))
  const files = installDefaults ? initrd.files : []
  await Promise.all([
    ...initrd.bin.map(async (name) => install(`/bin/${name}`, await fetchBytes(`bin/${name}.wasm`))),
    ...files.map(async (path) => install(`/${path}`, await fetchBytes(`rootfs/${path}`))),
  ])
  return { bin: initrd.bin, files }
}

/** /tmp 는 켤 때마다 비운다. */
function clearTmp(): void {
  const tmp = kernel.fs.lookup(kernel.fs.root, '/tmp')
  if (tmp.kind === 'dir') for (const name of [...tmp.entries.keys()]) kernel.fs.removeTree(tmp, name)
}

async function boot(): Promise<void> {
  kernel.log('kernel: booting')
  kernel.log(`kernel: cross-origin isolated = ${self.crossOriginIsolated}`)
  kernel.log('vfs: mounted memfs on /')
  const storage = await restoreFiles()
  const initrd = await loadInitrd(storage.fresh)
  clearTmp()
  kernel.log(`initrd: ${initrd.bin.length} programs in /bin, ${initrd.files.length} default files`)
  // 부팅을 기다리게 하지 않고 뒤에서 첫 저장을 한다. 끝나야 비로소 "저장된 상태"가 된다.
  void persister
    ?.sync()
    .then(() => markStorageReady?.())
    .catch((e) => kernel.log(`storage: failed to save: ${describe(e)}`))
  kernel.log('kernel: ready')
  emit({ type: 'ready', ...storage })
}

// ───────────── 저장 ─────────────

/** 미뤄 둔 저장을 지금 모두 끝낸다 (다른 탭에 자리를 넘겨주기 직전 등). */
async function flush(): Promise<void> {
  await persister?.sync()
  await archive?.sync()
  emit({ type: 'flushed' })
}

/** 저장된 파일을 모두 지운다. 진행 중이던 저장이 끝난 뒤에 지워야 다시 생기지 않는다. */
async function resetStorage(): Promise<void> {
  await persister?.stop()
  await archive?.stop()
  await clearOpfs()
  emit({ type: 'restart' })
}

// ───────────── 보관 폴더 ─────────────

/** 로컬 파일은 쓰기 스트림으로 바꿔 쓴다. 닫는 순간 내용이 한꺼번에 교체된다. */
const writeLocal: FileWriter = async (file, data) => {
  const writable = await file.createWritable()
  await writable.write(data as Uint8Array<ArrayBuffer>)
  await writable.close()
}

const hasMarker = (root: Dir) =>
  root.getFileHandle(MARKER).then(
    () => true,
    () => false,
  )

async function isEmpty(root: Dir): Promise<boolean> {
  for await (const _ of root.entries()) return false
  return true
}

function stopArchive(): Promise<void> | undefined {
  const stopping = archive?.stop()
  archive = undefined
  kernel.mounts.delete('localdir')
  return stopping
}

/** 폴더를 지금의 파일시스템과 똑같이 맞추고, 이후의 변경도 계속 반영한다. */
async function mirrorTo(root: Dir): Promise<void> {
  await stopArchive()
  const mirror = new Persister(kernel.fs, '/', directoryStore(root, writeLocal), EXCLUDE)
  mirror.onError = (e) => {
    kernel.log(`archive: failed to save: ${describe(e)}`)
    emit({ type: 'archive-error', msg: describe(e) })
  }
  await writeLocal(await root.getFileHandle(MARKER, { create: true }), new TextEncoder().encode('Web OS archive v1\n'))
  await mirror.adopt()
  await mirror.sync()
  archive = mirror
  kernel.mounts.add('localdir')
  kernel.log(`archive: mirroring to local folder "${root.name}"`)
}

/** 파일시스템의 내용을 모두 지운다 (보존하지 않는 /proc 은 그대로 둔다). */
function clearTree(): void {
  for (const name of [...kernel.fs.root.entries.keys()]) {
    if (!EXCLUDE.includes(name)) kernel.fs.removeTree(kernel.fs.root, name)
  }
}

/** 폴더의 내용으로 파일시스템을 통째로 바꾼다. 실행 중인 프로그램이 있으므로 곧바로 다시 시작해야 한다. */
async function loadFrom(root: Dir): Promise<void> {
  await stopArchive()
  clearTree()
  await new Persister(kernel.fs, '/', directoryStore(root, writeLocal), EXCLUDE).restore()
  // 다시 시작하면 브라우저 저장소에서 부팅하므로, 불러온 내용을 먼저 거기에 반영해 둔다.
  await persister?.sync()
  kernel.log(`archive: loaded from local folder "${root.name}"`)
}

// ───────────── 백업 파일 ─────────────

/** 파일시스템 전체를 묶음에 넣을 항목으로 나열한다. 부모가 자식보다 먼저 나온다. */
function treeEntries(): TarEntry[] {
  const out: TarEntry[] = []
  const walk = (dir: DirNode, prefix: string) => {
    for (const [name, node] of dir.entries) {
      if (prefix === '' && EXCLUDE.includes(name)) continue
      const path = prefix + name
      if (node.kind === 'dir') {
        out.push({ path })
        walk(node, `${path}/`)
      } else {
        out.push({ path, data: node.buf.subarray(0, node.size) })
      }
    }
  }
  walk(kernel.fs.root, '')
  return out
}

async function importBackup(cmd: Extract<KernelCommand, { type: 'backup-import' }>): Promise<void> {
  const fail = (reason: 'invalid' | 'too-large', msg: string) => emit({ type: 'backup-failed', id: cmd.id, reason, msg })
  let entries: TarEntry[]
  try {
    entries = unpackTar(cmd.data)
  } catch (e) {
    return fail('invalid', describe(e))
  }
  // 아무 파일이나 골랐을 때 지금 내용을 날리지 않도록, 이 OS의 백업처럼 생겼는지 확인한다.
  if (!entries.some((e) => !e.data && e.path === 'home')) return fail('invalid', 'archive has no /home directory')
  const files = entries.filter((e) => e.data)
  const bytes = files.reduce((n, e) => n + e.data!.length, 0)
  if (files.length > cmd.maxFiles || bytes > cmd.maxBytes) return fail('too-large', `${files.length} files, ${bytes} bytes`)

  clearTree()
  for (const entry of entries) {
    if (EXCLUDE.includes(entry.path.split('/', 1)[0]!)) continue
    if (entry.data) {
      kernel.fs.mkdirp(`/${entry.path}`.slice(0, `/${entry.path}`.lastIndexOf('/')) || '/')
      kernel.fs.writeFile(`/${entry.path}`, entry.data)
    } else {
      kernel.fs.mkdirp(`/${entry.path}`)
    }
  }
  // 다시 시작하면 브라우저 저장소에서 부팅하므로 먼저 반영해 둔다. 보관 폴더가 연결돼 있으면 거기에도.
  await persister?.sync()
  await archive?.sync()
  kernel.log(`backup: restored ${files.length} files from a backup file`)
  emit({ type: 'restart' })
}

async function linkArchive(cmd: Extract<KernelCommand, { type: 'archive-link' }>): Promise<void> {
  const root = cmd.handle as Dir
  const fail = (result: Record<string, unknown>) => emit({ type: 'archive-result', id: cmd.id, ok: false, ...result } as KernelEvent)
  try {
    const marked = await hasMarker(root)
    if (cmd.mode === 'auto' && marked) return fail({ reason: 'needs-choice' })
    if (cmd.mode === 'auto' && !(await isEmpty(root))) return fail({ reason: 'not-empty' })
    if (cmd.mode === 'attach' && !marked) return fail({ reason: 'failed', msg: 'not an archive folder' })
    // 내용을 통째로 읽어 비교하거나 불러오므로, 예상 밖으로 큰 폴더는 읽기 전에 거절한다.
    await measure(root, cmd)

    if (cmd.mode === 'import') {
      await loadFrom(root)
      emit({ type: 'archive-result', id: cmd.id, ok: true })
      return emit({ type: 'restart' })
    }
    await mirrorTo(root)
    emit({ type: 'archive-result', id: cmd.id, ok: true })
  } catch (e) {
    if (e instanceof TooLarge) fail({ reason: 'too-large', files: e.files, bytes: e.bytes })
    else fail({ reason: 'failed', msg: describe(e) })
  }
}

async function unlinkArchive(id: number): Promise<void> {
  // 남은 변경을 마저 쓴 뒤에 끊는다. 폴더와 그 안의 파일은 그대로 남는다.
  await archive?.sync().catch(() => {})
  await stopArchive()
  kernel.log('archive: disconnected')
  emit({ type: 'archive-result', id, ok: true })
}

// ───────────── 명령 ─────────────

self.onmessage = (e: MessageEvent<KernelCommand>) => {
  const cmd = e.data
  try {
    switch (cmd.type) {
      case 'tty-open':
        return void kernel.openTerminal(cmd.cols, cmd.rows, cmd.ref)
      case 'tty-close':
        return kernel.closeTerminal(cmd.tty)
      case 'tty-resize':
        return kernel.ttyResize(cmd.tty, cmd.cols, cmd.rows)
      case 'tty-input':
        return kernel.ttyInput(cmd.tty, cmd.text)
      case 'kill':
        return kernel.kill(cmd.pid)
      case 'spawn':
        return void kernel.launch(cmd.path, cmd.argv)
      case 'gui-event':
        return kernel.guiEvent(cmd.pid, cmd.data)
      case 'fs':
        return emit({ type: 'fs-result', id: cmd.id, result: kernel.fsRequest(cmd.request) })
      case 'trace':
        return kernel.setTracing(cmd.on)
      case 'flush':
        return void flush()
      case 'storage-reset':
        return void resetStorage()
      case 'archive-link':
        return void linkArchive(cmd)
      case 'archive-unlink':
        return void unlinkArchive(cmd.id)
      case 'backup-export':
        return emit({ type: 'backup-data', id: cmd.id, data: packTar(treeEntries()) })
      case 'backup-import':
        return void importBackup(cmd)
    }
  } catch (err) {
    if (!(err instanceof KernelError)) throw err
    if (cmd.type === 'fs') emit({ type: 'fs-result', id: cmd.id, errno: err.errno })
    else emit({ type: 'error', msg: err.message })
  }
}

boot().catch((err) => emit({ type: 'error', msg: `boot failed: ${describe(err)}` }))
