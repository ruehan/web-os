// 브라우저의 출처 전용 파일시스템(OPFS)을 영구 저장소로 쓴다. Worker 안에서만 동작한다.
import type { PersistStore } from './persist.ts'

const ROOT = 'home'

type Dir = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>
}

/** Worker에서만 쓸 수 있는 동기 파일 핸들 */
interface SyncHandle {
  truncate(size: number): void
  write(data: Uint8Array, options?: { at: number }): number
  flush(): void
  close(): void
}

export interface OpfsStore extends PersistStore {
  /** 이번에 저장소를 처음 만들었는가 (첫 방문이거나 초기화한 직후) */
  fresh: boolean
}

/** 저장소를 연다. 브라우저가 지원하지 않으면 예외가 난다. */
export async function openOpfs(): Promise<OpfsStore> {
  const origin = await navigator.storage.getDirectory()
  let fresh = false
  try {
    await origin.getDirectoryHandle(ROOT)
  } catch {
    fresh = true
  }
  const root = (await origin.getDirectoryHandle(ROOT, { create: true })) as Dir

  /** 경로의 부모 디렉터리와 마지막 이름 */
  async function locate(path: string, create: boolean): Promise<{ dir: Dir; name: string }> {
    const parts = path.split('/')
    const name = parts.pop()!
    let dir = root
    for (const part of parts) dir = (await dir.getDirectoryHandle(part, { create })) as Dir
    return { dir, name }
  }

  return {
    fresh,

    async load() {
      const out: { path: string; data?: Uint8Array }[] = []
      const walk = async (dir: Dir, prefix: string) => {
        for await (const [name, handle] of dir.entries()) {
          const path = prefix + name
          if (handle.kind === 'directory') {
            out.push({ path })
            await walk(handle as Dir, `${path}/`)
          } else {
            const file = await (handle as FileSystemFileHandle).getFile()
            out.push({ path, data: new Uint8Array(await file.arrayBuffer()) })
          }
        }
      }
      await walk(root, '')
      return out
    },

    async writeFile(path, data) {
      const { dir, name } = await locate(path, true)
      const file = await dir.getFileHandle(name, { create: true })
      const handle: SyncHandle = await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()
      try {
        handle.truncate(0)
        handle.write(data, { at: 0 })
        handle.flush()
      } finally {
        handle.close()
      }
    },

    async mkdir(path) {
      const { dir, name } = await locate(path, true)
      await dir.getDirectoryHandle(name, { create: true })
    },

    async remove(path) {
      try {
        const { dir, name } = await locate(path, false)
        await dir.removeEntry(name, { recursive: true })
      } catch (e) {
        // 이미 없으면 할 일이 없다.
        if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e
      }
    },
  }
}

/** 저장된 내용을 전부 지운다. 다음 부팅은 첫 방문처럼 시작한다. */
export async function clearOpfs(): Promise<void> {
  const origin = await navigator.storage.getDirectory()
  try {
    await origin.removeEntry(ROOT, { recursive: true })
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e
  }
}
