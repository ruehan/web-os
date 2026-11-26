// 메모 보관함의 규칙: 어떤 파일이 메모이고 그림인지, [[링크]]가 어느 파일을 가리키는지,
// 이름이 바뀌면 링크를 어떻게 고치는지. 화면이나 파일 접근 없이 글자만 다루므로 단독으로 테스트할 수 있다.

/** 보관함의 위치. 메모와 그림은 모두 이 폴더 아래의 파일이다. */
export const VAULT = '/home/guest/notes'
/** 붙여 넣거나 끌어다 놓은 그림이 저장되는 폴더 (보관함 기준) */
export const ATTACHMENTS = 'attachments'

const NOTE_EXTENSIONS = ['md', 'txt']
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

export const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
export const extOf = (path: string) => {
  const name = baseOf(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
/** 확장자를 뗀 파일 이름. 메모의 제목이다. */
export const stemOf = (path: string) => {
  const name = baseOf(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

export type FileKind = 'note' | 'image' | 'other'

export function kindOf(path: string): FileKind {
  const ext = extOf(path)
  if (NOTE_EXTENSIONS.includes(ext)) return 'note'
  return ext in IMAGE_TYPES ? 'image' : 'other'
}

/** 그림 파일의 종류 (브라우저에 그림으로 보여 줄 때 필요하다) */
export const imageTypeOf = (path: string) => IMAGE_TYPES[extOf(path)]

/** 파일 종류(image/png 등)에 맞는 확장자 */
export function extensionForType(type: string): string {
  const found = Object.entries(IMAGE_TYPES).find(([ext, mime]) => mime === type && ext !== 'jpeg')
  return found?.[0] ?? 'png'
}

export interface Link {
  /** 가리키는 대상: 메모 이름이나 보관함 기준 경로 */
  target: string
  /** ![[...]] 꼴: 링크가 아니라 그 자리에 내용(그림)을 넣는다 */
  embed: boolean
}

const LINK = /(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g

/** 글에 든 [[링크]]들. 표시 이름(|...)과 제목 위치(#...)는 떼고 대상만 돌려준다. */
export function parseLinks(text: string): Link[] {
  return [...text.matchAll(LINK)].map((m) => ({ target: m[2]!.trim(), embed: m[1] === '!' }))
}

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0

/**
 * 링크가 가리키는 파일을 찾는다. 폴더를 적었으면 그 경로와 맞는 것을, 이름만 적었으면
 * 어느 폴더에 있든 이름이 같은 것을 고른다. 확장자는 생략할 수 있고 대소문자는 가리지 않는다.
 * 같은 이름이 여러 폴더에 있으면 경로가 짧은(위쪽 폴더의) 것이 이긴다.
 */
export function resolveLink(target: string, paths: string[]): string | undefined {
  const wanted = target.trim().replace(/^\/+/, '')
  if (!wanted) return undefined
  const withoutExt = (path: string) => (extOf(path) ? path.slice(0, path.length - extOf(path).length - 1) : path)
  const matches = paths.filter((path) => {
    if (wanted.includes('/')) return same(path, wanted) || same(withoutExt(path), wanted)
    return same(baseOf(path), wanted) || same(stemOf(path), wanted)
  })
  // 메모와 그림의 이름이 같으면 메모가 먼저다 ([[회의]]는 회의.md를, ![[회의.png]]는 그림을 가리킨다).
  matches.sort((a, b) => Number(kindOf(a) !== 'note') - Number(kindOf(b) !== 'note') || a.length - b.length || a.localeCompare(b))
  return matches[0]
}

/**
 * 파일 이름이 바뀌었을 때, 그 파일을 가리키던 링크를 새 이름으로 고친 글을 돌려준다.
 * 이름만 적었던 링크는 새 이름으로, 경로로 적었던 링크는 새 경로로 바꾼다. 표시 이름과 제목 위치는 그대로 둔다.
 */
export function renameLinks(text: string, oldPath: string, newPath: string, paths: string[]): string {
  const strip = (path: string) => (kindOf(path) === 'note' ? path.slice(0, path.length - extOf(path).length - 1) : path)
  return text.replace(LINK, (whole, bang: string, target: string) => {
    if (resolveLink(target, paths) !== oldPath) return whole
    const renamed = target.includes('/') ? strip(newPath) : kindOf(newPath) === 'note' ? stemOf(newPath) : baseOf(newPath)
    return `${bang}[[${renamed}${whole.slice(bang.length + 2 + target.length)}`
  })
}

/** 같은 폴더에 이미 있는 이름을 피해 "이름", "이름 2", "이름 3" … 중 비어 있는 것을 고른다. */
export function uniqueName(taken: string[], stem: string, ext: string): string {
  const used = new Set(taken.map((name) => name.toLowerCase()))
  for (let n = 1; ; n++) {
    const name = `${stem}${n > 1 ? ` ${n}` : ''}${ext ? `.${ext}` : ''}`
    if (!used.has(name.toLowerCase())) return name
  }
}

/** 파일 이름으로 쓸 수 없는 글자를 걸러 낸다. 못 쓰는 이름이면 이유를 돌려준다. */
export function nameProblem(name: string): string | undefined {
  if (!name.trim()) return '이름을 적어 주세요.'
  if (/[\/\\]/.test(name)) return '이름에는 / 와 \\ 를 쓸 수 없습니다.'
  if (/[\[\]|#^]/.test(name)) return '이름에는 [ ] | # ^ 를 쓸 수 없습니다 (링크에서 특별한 뜻으로 쓰입니다).'
  if (name.startsWith('.')) return '이름은 점으로 시작할 수 없습니다.'
  return undefined
}

/** 예전 메모 앱이 만든 파일 이름 (만든 시각). 제목으로 된 이름으로 바꿔 줄 대상이다. */
export const isLegacyName = (path: string) => /^\d{8}-\d{6}(-\d+)?\.(md|txt)$/.test(baseOf(path))

/** 메모의 첫 줄에서 뽑은 제목 (파일 이름으로 쓸 수 있게 다듬는다). 뽑을 것이 없으면 빈 문자열. */
export function titleFromText(text: string): string {
  const first = text.split('\n').find((line) => line.trim() !== '') ?? ''
  return first
    .replace(/^#+\s*/, '')
    .replace(/[\/\\\[\]|#^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim()
}

// ───────────── 메모에서 뽑아내는 것들 ─────────────

const TAG = /(?<![\p{L}\p{N}_#&/])#([\p{L}_][\p{L}\p{N}_/-]*)/gu

/** 코드(``` 블록과 `줄 안 코드`)를 뺀 글. 코드 안의 #이나 [[ ]]는 태그나 링크가 아니다. */
const withoutCode = (text: string) => text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`\n]*`/g, '')

/** 메모에 든 태그들 (# 없이, 중복 없이, 나온 순서대로) */
export function tagsOf(text: string): string[] {
  return [...new Set([...withoutCode(text).matchAll(TAG)].map((m) => m[1]!))]
}

export interface Heading {
  level: number
  title: string
  /** 원문에서의 줄 (0부터) */
  line: number
}

/** 메모의 제목 줄들 (목차) */
export function outlineOf(text: string): Heading[] {
  const out: Heading[] = []
  let fenced = false
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced
    const match = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*$/.exec(line)
    if (match && match[2]) out.push({ level: match[1]!.length, title: match[2], line: i })
  })
  return out
}

// ───────────── 옮기기 ─────────────

/** path가 dir 자신이거나 그 아래에 있는가 */
export const isInside = (path: string, dir: string) => dir === '' || path === dir || path.startsWith(`${dir}/`)

/**
 * 파일이나 폴더를 다른 폴더로 옮길 수 있는지 본다. 옮길 수 없으면 이유를, 옮길 필요가 없으면(이미 거기 있음) 빈 문자열을 돌려준다.
 * 옮길 수 있으면 undefined.
 */
export function moveProblem(path: string, destDir: string, taken: string[]): string | undefined {
  if (dirOf(path) === destDir) return ''
  if (isInside(destDir, path) && destDir !== '') return '폴더를 자기 자신 안으로 옮길 수는 없습니다.'
  if (taken.some((name) => name.toLowerCase() === baseOf(path).toLowerCase())) return '옮길 곳에 같은 이름이 이미 있습니다.'
  return undefined
}

// ───────────── 그래프 ─────────────

export interface GraphNode {
  /** 메모의 경로. 아직 없는 메모는 "?이름" */
  id: string
  label: string
  /** 실제로 있는 메모인가 (없는 메모를 가리키는 링크도 점으로 그린다) */
  exists: boolean
  /** 이어진 선의 수 */
  degree: number
  x: number
  y: number
}

export interface Graph {
  nodes: GraphNode[]
  links: { source: string; target: string }[]
}

/** 메모들과 그 사이의 링크로 그래프를 만든다. 자리(x, y)는 아직 정하지 않는다. */
export function buildGraph(notes: { path: string; text: string }[], files: string[]): Graph {
  const nodes = new Map<string, GraphNode>()
  const add = (id: string, label: string, exists: boolean) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, exists, degree: 0, x: 0, y: 0 })
    return nodes.get(id)!
  }
  for (const note of notes) add(note.path, stemOf(note.path), true)
  const seen = new Set<string>()
  const links: Graph['links'] = []
  for (const note of notes) {
    for (const link of parseLinks(withoutCode(note.text))) {
      const found = resolveLink(link.target, files)
      // 그림을 넣은 것은 메모 사이의 관계가 아니다.
      if (found && kindOf(found) !== 'note') continue
      if (!found && link.embed && imageTypeOf(link.target)) continue
      const target = found ?? `?${baseOf(link.target).toLowerCase()}`
      const key = `${note.path}\n${target}`
      if (target === note.path || seen.has(key)) continue
      seen.add(key)
      add(target, found ? stemOf(found) : baseOf(link.target), !!found)
      links.push({ source: note.path, target })
    }
  }
  for (const link of links) {
    nodes.get(link.source)!.degree++
    nodes.get(link.target)!.degree++
  }
  return { nodes: [...nodes.values()], links }
}

/**
 * 점들의 자리를 정한다: 서로 밀어내고, 이어진 점끼리는 당기고, 전체를 가운데로 모은다.
 * 같은 입력에는 늘 같은 그림이 나오도록 무작위를 쓰지 않는다 (처음 자리는 원 위에 고르게 놓는다).
 */
export function layoutGraph(graph: Graph, width: number, height: number, iterations = 300): Graph {
  const nodes = graph.nodes.map((node, i) => {
    const angle = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2
    const radius = Math.min(width, height) * 0.35
    return { ...node, x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius }
  })
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // 점 사이의 알맞은 거리. 넓은 화면에서도 가장자리까지 퍼지지 않도록 위를 막는다.
  const ideal = Math.min(150, Math.sqrt((width * height) / Math.max(1, nodes.length)) * 0.5)
  for (let step = 0; step < iterations; step++) {
    // 뒤로 갈수록 덜 움직여 자리를 잡는다.
    const heat = (1 - step / iterations) * ideal * 0.15
    const push = nodes.map(() => ({ x: 0, y: 0 }))
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const dx = nodes[a]!.x - nodes[b]!.x || 0.01 * (a - b)
        const dy = nodes[a]!.y - nodes[b]!.y || 0.01
        const dist = Math.hypot(dx, dy)
        const force = (ideal * ideal) / dist
        push[a]!.x += (dx / dist) * force
        push[a]!.y += (dy / dist) * force
        push[b]!.x -= (dx / dist) * force
        push[b]!.y -= (dy / dist) * force
      }
    }
    for (const link of graph.links) {
      const a = nodes.indexOf(byId.get(link.source)!)
      const b = nodes.indexOf(byId.get(link.target)!)
      const dx = nodes[a]!.x - nodes[b]!.x
      const dy = nodes[a]!.y - nodes[b]!.y
      const dist = Math.hypot(dx, dy) || 0.01
      const force = (dist * dist) / ideal
      push[a]!.x -= (dx / dist) * force
      push[a]!.y -= (dy / dist) * force
      push[b]!.x += (dx / dist) * force
      push[b]!.y += (dy / dist) * force
    }
    nodes.forEach((node, i) => {
      // 가운데로 살짝 당겨서, 이어지지 않은 점들이 멀리 날아가지 않게 한다.
      push[i]!.x += (width / 2 - node.x) * 0.006 * ideal
      push[i]!.y += (height / 2 - node.y) * 0.006 * ideal
      const size = Math.hypot(push[i]!.x, push[i]!.y) || 1
      node.x += (push[i]!.x / size) * Math.min(size, heat)
      node.y += (push[i]!.y / size) * Math.min(size, heat)
      // 이름표와 아래 안내문이 들어갈 자리를 남긴다.
      node.x = Math.min(width - 40, Math.max(40, node.x))
      node.y = Math.min(height - 56, Math.max(24, node.y))
    })
  }
  return { nodes, links: graph.links }
}
