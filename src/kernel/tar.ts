// 파일 묶음을 tar(ustar) 형식으로 묶고 푼다. 백업 파일을 일반 도구(tar, 압축 프로그램)로도 열 수 있게 하기 위함이다.
//
// 구조: 512바이트 머리 + 512바이트 단위로 채운 내용이 항목마다 이어지고, 빈 블록 둘로 끝난다.
// 이름이 머리의 100바이트에 들어가지 않으면(한글 이름은 금방 넘는다) 바로 앞에 확장 머리(pax)를 둔다.

export interface TarEntry {
  path: string
  /** 없으면 디렉터리 */
  data?: Uint8Array
}

const BLOCK = 512
const NAME_MAX = 100
const enc = new TextEncoder()
const dec = new TextDecoder()

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK

function header(name: Uint8Array, size: number, type: string, mtime: number): Uint8Array {
  const block = new Uint8Array(BLOCK)
  const put = (text: string, offset: number) => block.set(enc.encode(text), offset)
  const octal = (value: number, width: number, offset: number) => put(value.toString(8).padStart(width - 1, '0') + '\0', offset)
  block.set(name, 0)
  octal(type === '5' ? 0o755 : 0o644, 8, 100) // 권한
  octal(0, 8, 108) // 소유자
  octal(0, 8, 116) // 그룹
  octal(size, 12, 124)
  octal(mtime, 12, 136)
  put('        ', 148) // 체크섬 자리는 공백으로 두고 계산한다
  put(type, 156)
  put('ustar\x0000', 257)
  const sum = block.reduce((a, b) => a + b, 0)
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return block
}

export function packTar(entries: TarEntry[], now = Date.now()): Uint8Array {
  const mtime = Math.floor(now / 1000)
  const parts: Uint8Array[] = []
  const add = (name: Uint8Array, type: string, data: Uint8Array) => {
    parts.push(header(name, data.length, type, mtime))
    if (data.length === 0) return
    const body = new Uint8Array(padded(data.length))
    body.set(data)
    parts.push(body)
  }
  for (const entry of entries) {
    const path = entry.data ? entry.path : `${entry.path}/`
    let name = enc.encode(path)
    if (name.length > NAME_MAX) {
      // 확장 머리의 기록은 "길이 키=값\n" 꼴이고, 길이에는 자기 자신의 자릿수도 포함된다.
      const record = ` path=${path}\n`
      const bytes = enc.encode(record).length
      let length = bytes + 1
      while (String(length).length + bytes !== length) length = String(length).length + bytes
      add(enc.encode('PaxHeader'), 'x', enc.encode(length + record))
      name = name.subarray(0, NAME_MAX)
    }
    add(name, entry.data ? '0' : '5', entry.data ?? new Uint8Array(0))
  }
  parts.push(new Uint8Array(BLOCK * 2))

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** tar 파일을 푼다. 형식이 맞지 않으면 예외를 던진다. */
export function unpackTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  const text = (from: number, length: number) => {
    const field = bytes.subarray(from, from + length)
    const end = field.indexOf(0)
    return dec.decode(end < 0 ? field : field.subarray(0, end))
  }
  let longName: string | undefined
  let offset = 0
  let sawEnd = false

  while (offset + BLOCK <= bytes.length) {
    const block = bytes.subarray(offset, offset + BLOCK)
    if (block.every((b) => b === 0)) {
      sawEnd = true
      break
    }
    // 체크섬: 체크섬 자리를 공백으로 친 머리 전체의 합
    const stored = parseInt(text(offset + 148, 8).trim(), 8)
    const sum = block.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0)
    if (stored !== sum) throw new Error('not a tar archive (bad header checksum)')

    const size = parseInt(text(offset + 124, 12).trim() || '0', 8)
    const type = text(offset + 156, 1) || '0'
    const dataStart = offset + BLOCK
    if (!Number.isFinite(size) || dataStart + size > bytes.length) throw new Error('tar archive is truncated')
    const data = bytes.subarray(dataStart, dataStart + size)
    offset = dataStart + padded(size)

    if (type === 'x') {
      // 확장 머리: 다음 항목에 적용할 값들. 경로만 쓴다.
      const match = /^\d+ path=(.*)$/m.exec(dec.decode(data))
      if (match) longName = match[1]
      continue
    }
    if (type === 'L') {
      // 다른 도구가 긴 이름을 적는 방식 (GNU)
      longName = dec.decode(data).replace(/\0+$/, '')
      continue
    }
    const prefix = text(dataStart - BLOCK + 345, 155)
    const raw = longName ?? (prefix ? `${prefix}/` : '') + text(dataStart - BLOCK, NAME_MAX)
    longName = undefined
    if (type !== '0' && type !== '5') continue // 링크, 장치 파일 등은 건너뛴다

    const path = raw.replace(/^(\.?\/)+/, '').replace(/\/+$/, '')
    if (path === '' || path === '.') continue
    // 묶음 밖을 가리키는 경로는 받지 않는다.
    if (path.split('/').includes('..')) throw new Error(`tar archive has an unsafe path: ${raw}`)
    entries.push(type === '5' ? { path } : { path, data: data.slice() })
  }
  // 끝 표시(빈 블록)가 없으면 내려받다 끊긴 파일일 수 있다. 일부만 복원하느니 받지 않는다.
  if (!sawEnd) throw new Error(entries.length ? 'tar archive is truncated' : 'not a tar archive')
  return entries
}
