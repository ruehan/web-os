// 브라우저의 출처 전용 파일시스템(OPFS)을 영구 저장소로 쓴다. Worker 안에서만 동작한다.
import { directoryStore, type Dir } from './dirstore.ts'
import type { PersistStore } from './persist.ts'

const ROOT = 'home'

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

  const store = directoryStore(root, async (file, data) => {
    const handle: SyncHandle = await (
      file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }
    ).createSyncAccessHandle()
    try {
      handle.truncate(0)
      handle.write(data, { at: 0 })
      handle.flush()
    } finally {
      handle.close()
    }
  })
  return { ...store, fresh }
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
