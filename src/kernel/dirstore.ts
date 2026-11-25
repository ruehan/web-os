// 브라우저의 디렉터리 핸들(출처 전용 저장소든, 사용자가 고른 로컬 폴더든)을 영구 저장소로 쓴다.
import type { PersistStore } from './persist.ts'

export type Dir = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>
}

/** 파일 하나의 내용을 통째로 바꿔 쓰는 방법. 저장소 종류마다 쓸 수 있는 방식이 다르다. */
export type FileWriter = (file: FileSystemFileHandle, data: Uint8Array) => Promise<void>

const isNotFound = (e: unknown) => e instanceof DOMException && e.name === 'NotFoundError'

export function directoryStore(root: Dir, write: FileWriter): PersistStore {
  /** 경로의 부모 디렉터리와 마지막 이름 */
  async function locate(path: string, create: boolean): Promise<{ dir: Dir; name: string }> {
    const parts = path.split('/')
    const name = parts.pop()!
    let dir = root
    for (const part of parts) dir = (await dir.getDirectoryHandle(part, { create })) as Dir
    return { dir, name }
  }

  return {
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
      await write(await dir.getFileHandle(name, { create: true }), data)
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
        if (!isNotFound(e)) throw e
      }
    },
  }
}

/** 디렉터리 아래의 파일 수와 전체 크기 한도 */
export interface Limits {
  maxFiles: number
  maxBytes: number
}

/** 폴더가 한도를 넘는다. 세다가 한도를 넘는 순간 멈추므로, 값은 "적어도 이만큼"이다. */
export class TooLarge extends Error {
  files: number
  bytes: number

  constructor(files: number, bytes: number) {
    super('directory exceeds the configured limits')
    this.files = files
    this.bytes = bytes
  }
}

/**
 * 폴더를 통째로 메모리에 올려도 되는 크기인지 먼저 센다.
 * 실수로 사진 폴더 같은 큰 폴더를 고르면 수 GB를 읽으려 들 수 있기 때문이다.
 */
export async function measure(root: Dir, limits: Limits): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (dir: Dir) => {
    for await (const [, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        await walk(handle as Dir)
        continue
      }
      files++
      bytes += (await (handle as FileSystemFileHandle).getFile()).size
      if (files > limits.maxFiles || bytes > limits.maxBytes) throw new TooLarge(files, bytes)
    }
  }
  await walk(root)
  return { files, bytes }
}
