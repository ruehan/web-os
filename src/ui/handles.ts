// 연결했던 로컬 폴더의 핸들을 브라우저에 기억해 둔다. 다음 방문 때 폴더를 다시 고르지 않아도 된다.
// (핸들은 일반 저장소에 넣을 수 없고 IndexedDB에만 보관할 수 있다.)

const DB = 'webos'
const STORE = 'mounts'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

/** 기억해 둔 폴더들: 연결 이름 → 핸들 */
export async function savedHandles(): Promise<Map<string, FileSystemDirectoryHandle>> {
  const [names, handles] = await Promise.all([
    run('readonly', (s) => s.getAllKeys()),
    run('readonly', (s) => s.getAll() as IDBRequest<FileSystemDirectoryHandle[]>),
  ])
  return new Map(names.map((name, i) => [String(name), handles[i]!]))
}

export const saveHandle = (name: string, handle: FileSystemDirectoryHandle) => run('readwrite', (s) => s.put(handle, name))

export const forgetHandle = (name: string) => run('readwrite', (s) => s.delete(name))
