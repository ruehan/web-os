// 메모리 파일시스템의 한 디렉터리(/home)를 영구 저장소와 맞춰 둔다.
//
// 읽고 쓰는 일은 전부 메모리에서 일어나고, 여기서는 바뀐 부분만 조금 뒤에 저장소로 옮긴다.
// 부팅할 때는 반대로 저장소의 내용을 메모리에 되살린다.
import type { DirNode, Inode, MemFs } from './vfs/memfs.ts'

/** 영구 저장소. 경로는 저장 대상 디렉터리 기준 상대 경로다 ("guest/notes.txt"). */
export interface PersistStore {
  /** 저장된 모든 항목. 디렉터리는 data가 없고, 부모가 자식보다 먼저 나온다. */
  load(): Promise<{ path: string; data?: Uint8Array }[]>
  writeFile(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string): Promise<void>
  /** 파일이든 디렉터리든(내용 포함) 지운다. */
  remove(path: string): Promise<void>
}

/** 마지막으로 저장소에 반영한 상태 */
type Snapshot = Map<string, { node: Inode; version: number }>

const SYNC_DELAY_MS = 250

export class Persister {
  private fs: MemFs
  private root: string
  private store: PersistStore
  private snapshot: Snapshot = new Map()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private again = false
  private stopped = false
  /** 저장에 실패했을 때 알릴 곳 */
  onError: (error: unknown) => void = () => {}

  constructor(fs: MemFs, root: string, store: PersistStore) {
    this.fs = fs
    this.root = root
    this.store = store
  }

  /** 저장소의 내용을 메모리에 되살리고, 되살린 파일 수를 돌려준다. */
  async restore(): Promise<number> {
    let files = 0
    for (const entry of await this.store.load()) {
      const path = `${this.root}/${entry.path}`
      if (entry.data) {
        this.fs.writeFile(path, entry.data)
        files++
      } else {
        this.fs.mkdirp(path)
      }
    }
    // 방금 되살린 것은 이미 저장소에 있으므로 다시 쓸 필요가 없다.
    this.snapshot = this.capture()
    return files
  }

  /** 파일시스템이 바뀌었을 때 부른다. 잠시 모았다가 한꺼번에 저장한다. */
  schedule(): void {
    if (this.stopped || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.sync()
    }, SYNC_DELAY_MS)
  }

  /** 바뀐 부분을 저장소에 반영한다. 이미 진행 중이면 끝난 뒤 한 번 더 돈다. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        try {
          if (!this.stopped) await this.flush()
        } catch (e) {
          this.onError(e)
        }
      } while (this.again)
      this.running = undefined
    })()
    return this.running
  }

  /** 더 이상 저장하지 않는다 (저장소를 비우고 다시 시작할 때). */
  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.running
  }

  private capture(): Snapshot {
    const out: Snapshot = new Map()
    const walk = (dir: DirNode, prefix: string) => {
      for (const [name, node] of dir.entries) {
        const path = prefix + name
        out.set(path, { node, version: node.kind === 'file' ? node.version : 0 })
        if (node.kind === 'dir') walk(node, `${path}/`)
      }
    }
    const root = this.fs.lookup(this.fs.root, this.root)
    if (root.kind === 'dir') walk(root, '')
    return out
  }

  private async flush(): Promise<void> {
    const before = this.snapshot
    const now = this.capture()

    // 사라졌거나 종류가 바뀐(파일 ↔ 디렉터리) 항목을 먼저 지운다. 부모를 지웠으면 자식은 건너뛴다.
    const removed: string[] = []
    for (const [path, old] of before) {
      const current = now.get(path)
      if (current && current.node.kind === old.node.kind) continue
      if (!removed.some((parent) => path.startsWith(`${parent}/`))) removed.push(path)
    }
    for (const path of removed) await this.store.remove(path)

    // Map은 넣은 순서를 지키므로 부모 디렉터리가 항상 자식보다 먼저 만들어진다.
    for (const [path, current] of now) {
      const old = before.get(path)
      const unchanged = old && old.node === current.node && old.version === current.version
      if (unchanged) continue
      const node = current.node
      if (node.kind === 'dir') {
        if (!old || old.node.kind !== 'dir') await this.store.mkdir(path)
      } else {
        await this.store.writeFile(path, node.buf.slice(0, node.size))
      }
    }
    this.snapshot = now
  }
}
