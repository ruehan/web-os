import { Errno, KernelError } from '../errno.ts'

export interface FileNode {
  kind: 'file'
  ino: number
  /** 용량 버퍼. 실제 내용은 앞의 size 바이트다. */
  buf: Uint8Array
  size: number
  /** 내용이 바뀔 때마다 증가한다 (컴파일된 실행 파일 캐시 무효화용). */
  version: number
}

export interface DirNode {
  kind: 'dir'
  ino: number
  parent: DirNode
  entries: Map<string, Inode>
}

export type Inode = FileNode | DirNode

/** 메모리에만 존재하는 파일시스템. 새로고침하면 사라진다. */
export class MemFs {
  private nextIno = 1
  readonly root: DirNode
  /** 파일이나 디렉터리가 생기고, 사라지고, 바뀔 때마다 증가한다 (화면 갱신 알림용). */
  generation = 0

  constructor() {
    const root = { kind: 'dir', ino: this.nextIno++, entries: new Map() } as DirNode
    root.parent = root
    this.root = root
  }

  /** 경로를 따라가 inode를 찾는다. 절대 경로는 루트에서, 상대 경로는 base에서 시작한다. */
  lookup(base: DirNode, path: string): Inode {
    let node: Inode = path.startsWith('/') ? this.root : base
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue
      if (node.kind !== 'dir') throw new KernelError(Errno.NOTDIR)
      if (part === '..') {
        node = node.parent
        continue
      }
      const next = node.entries.get(part)
      if (!next) throw new KernelError(Errno.NOENT)
      node = next
    }
    return node
  }

  /** 마지막 요소를 뺀 부모 디렉터리와 마지막 이름을 돌려준다. */
  lookupParent(base: DirNode, path: string): { dir: DirNode; name: string } {
    const trimmed = path.replace(/\/+$/, '')
    const cut = trimmed.lastIndexOf('/')
    const name = trimmed.slice(cut + 1)
    if (name === '' || name === '.' || name === '..') throw new KernelError(Errno.INVAL)
    const dirPath = cut < 0 ? '.' : trimmed.slice(0, cut) || '/'
    const dir = this.lookup(base, dirPath)
    if (dir.kind !== 'dir') throw new KernelError(Errno.NOTDIR)
    return { dir, name }
  }

  createFile(dir: DirNode, name: string): FileNode {
    if (dir.entries.has(name)) throw new KernelError(Errno.EXIST)
    const file: FileNode = { kind: 'file', ino: this.nextIno++, buf: new Uint8Array(0), size: 0, version: 0 }
    dir.entries.set(name, file)
    this.generation++
    return file
  }

  mkdir(dir: DirNode, name: string): DirNode {
    if (dir.entries.has(name)) throw new KernelError(Errno.EXIST)
    const child: DirNode = { kind: 'dir', ino: this.nextIno++, parent: dir, entries: new Map() }
    dir.entries.set(name, child)
    this.generation++
    return child
  }

  unlink(dir: DirNode, name: string): void {
    const node = dir.entries.get(name)
    if (!node) throw new KernelError(Errno.NOENT)
    if (node.kind === 'dir') throw new KernelError(Errno.ISDIR)
    dir.entries.delete(name)
    this.generation++
  }

  rmdir(dir: DirNode, name: string): void {
    const node = dir.entries.get(name)
    if (!node) throw new KernelError(Errno.NOENT)
    if (node.kind !== 'dir') throw new KernelError(Errno.NOTDIR)
    if (node.entries.size > 0) throw new KernelError(Errno.NOTEMPTY)
    dir.entries.delete(name)
    this.generation++
  }

  /** 이름을 바꾸거나 다른 디렉터리로 옮긴다. 같은 이름이 이미 있으면 덮어쓰지 않고 실패한다. */
  rename(fromDir: DirNode, fromName: string, toDir: DirNode, toName: string): void {
    const node = fromDir.entries.get(fromName)
    if (!node) throw new KernelError(Errno.NOENT)
    if (fromDir === toDir && fromName === toName) return
    if (toDir.entries.has(toName)) throw new KernelError(Errno.EXIST)
    if (node.kind === 'dir') {
      // 디렉터리를 자기 자신이나 자기 아래로 옮길 수는 없다.
      for (let d = toDir; ; d = d.parent) {
        if (d === node) throw new KernelError(Errno.INVAL)
        if (d === d.parent) break
      }
      node.parent = toDir
    }
    fromDir.entries.delete(fromName)
    toDir.entries.set(toName, node)
    this.generation++
  }

  /** 파일이든 디렉터리든(내용 포함) 지운다. */
  removeTree(dir: DirNode, name: string): void {
    if (!dir.entries.delete(name)) throw new KernelError(Errno.NOENT)
    this.generation++
  }

  read(file: FileNode, offset: number, length: number): Uint8Array {
    if (offset >= file.size) return new Uint8Array(0)
    return file.buf.subarray(offset, Math.min(file.size, offset + length))
  }

  write(file: FileNode, offset: number, data: Uint8Array): number {
    const end = offset + data.length
    if (end > file.buf.length) {
      const grown = new Uint8Array(Math.max(end, file.buf.length * 2, 64))
      grown.set(file.buf.subarray(0, file.size))
      file.buf = grown
    }
    // 파일 끝을 넘어선 위치에 쓰면 사이 구간은 0으로 채워져 있어야 한다.
    if (offset > file.size) file.buf.fill(0, file.size, offset)
    file.buf.set(data, offset)
    file.version++
    this.generation++
    file.size = Math.max(file.size, end)
    return data.length
  }

  truncate(file: FileNode): void {
    file.size = 0
    file.version++
    this.generation++
  }

  // 커널 내부(부팅, 테스트)용 편의 함수

  mkdirp(path: string): DirNode {
    let dir = this.root
    for (const part of path.split('/')) {
      if (part === '') continue
      const next = dir.entries.get(part) ?? this.mkdir(dir, part)
      if (next.kind !== 'dir') throw new KernelError(Errno.NOTDIR)
      dir = next
    }
    return dir
  }

  writeFile(path: string, data: Uint8Array): void {
    const { dir, name } = this.lookupParent(this.root, path)
    const existing = dir.entries.get(name)
    if (existing?.kind === 'dir') throw new KernelError(Errno.ISDIR)
    const file = existing ?? this.createFile(dir, name)
    this.truncate(file)
    this.write(file, 0, data)
  }

  readFile(path: string): Uint8Array {
    const node = this.lookup(this.root, path)
    if (node.kind !== 'file') throw new KernelError(Errno.ISDIR)
    return node.buf.slice(0, node.size)
  }
}
