import { describe, expect, it } from 'vitest'
import {
  buildGraph,
  extensionForType,
  imageTypeOf,
  isLegacyName,
  layoutGraph,
  moveProblem,
  outlineOf,
  tagsOf,
  kindOf,
  nameProblem,
  parseLinks,
  renameLinks,
  resolveLink,
  stemOf,
  titleFromText,
  uniqueName,
} from '../src/ui/notes/vault.ts'

const paths = ['회의록.md', '계획.md', '프로젝트/계획.md', '프로젝트/깊이/메모.md', 'attachments/그림.png', '그림.md', '할일.txt']

describe('vault', () => {
  it('classifies files', () => {
    expect([kindOf('a.md'), kindOf('b.TXT'), kindOf('c.PNG'), kindOf('d.svg'), kindOf('e.wasm'), kindOf('이름없음')]).toEqual([
      'note', 'note', 'image', 'image', 'other', 'other',
    ])
    expect(stemOf('프로젝트/회의.록.md')).toBe('회의.록')
    expect(imageTypeOf('a/b.JPG')).toBe('image/jpeg')
    expect(extensionForType('image/jpeg')).toBe('jpg')
    expect(extensionForType('image/unknown')).toBe('png')
  })

  it('finds the links in a note', () => {
    expect(parseLinks('[[회의록]] 과 [[프로젝트/계획#일정|이번 계획]], ![[그림.png]], [일반](https://a.b), [[ 공백 ]]')).toEqual([
      { target: '회의록', embed: false },
      { target: '프로젝트/계획', embed: false },
      { target: '그림.png', embed: true },
      { target: '공백', embed: false },
    ])
    expect(parseLinks('[[]] [[a\nb]] 없음')).toEqual([])
  })

  it('resolves a link by name anywhere in the vault, or by path', () => {
    expect(resolveLink('회의록', paths)).toBe('회의록.md')
    expect(resolveLink('회의록.md', paths)).toBe('회의록.md')
    expect(resolveLink('메모', paths)).toBe('프로젝트/깊이/메모.md')
    expect(resolveLink('할일', paths)).toBe('할일.txt')
    // 같은 이름이 여러 곳에 있으면 위쪽 폴더의 것, 경로를 적으면 그 경로의 것
    expect(resolveLink('계획', paths)).toBe('계획.md')
    expect(resolveLink('프로젝트/계획', paths)).toBe('프로젝트/계획.md')
    expect(resolveLink('없는 메모', paths)).toBeUndefined()
    expect(resolveLink('', paths)).toBeUndefined()
  })

  it('ignores case, and prefers a note over an image of the same name', () => {
    expect(resolveLink('readme', ['README.md'])).toBe('README.md')
    expect(resolveLink('그림', paths)).toBe('그림.md')
    expect(resolveLink('그림.png', paths)).toBe('attachments/그림.png')
  })

  it('rewrites links when a note is renamed, keeping labels and anchors', () => {
    const text = '[[회의록]] [[회의록|표시]] [[회의록#3월]] ![[그림.png]] [[계획]] [[프로젝트/계획|P]] [[없는 메모]]'
    expect(renameLinks(text, '회의록.md', '주간 회의.md', paths)).toBe(
      '[[주간 회의]] [[주간 회의|표시]] [[주간 회의#3월]] ![[그림.png]] [[계획]] [[프로젝트/계획|P]] [[없는 메모]]',
    )
    // 경로로 적은 링크는 경로로, 이름만 적은 링크는 이름으로 남는다.
    expect(renameLinks(text, '프로젝트/계획.md', '프로젝트/로드맵.md', paths)).toContain('[[계획]] [[프로젝트/로드맵|P]]')
    // 그림은 확장자까지 적는다.
    expect(renameLinks(text, 'attachments/그림.png', 'attachments/화면.png', paths)).toContain('![[화면.png]]')
  })

  it('picks names that are not taken', () => {
    expect(uniqueName([], '제목 없음', 'md')).toBe('제목 없음.md')
    expect(uniqueName(['제목 없음.md', '제목 없음 2.md'], '제목 없음', 'md')).toBe('제목 없음 3.md')
    expect(uniqueName(['README.MD'], 'readme', 'md')).toBe('readme 2.md')
    expect(uniqueName(['새 폴더'], '새 폴더', '')).toBe('새 폴더 2')
  })

  it('explains why a name cannot be used', () => {
    expect(nameProblem('회의록 3월')).toBeUndefined()
    expect(nameProblem('  ')).toBe('이름을 적어 주세요.')
    expect(nameProblem('a/b')).toContain('/')
    expect(nameProblem('a[b]')).toContain('링크')
    expect(nameProblem('.숨김')).toContain('점')
  })

  it('recognizes the old timestamp names and derives a title from the text', () => {
    expect(isLegacyName('20261125-181026.md')).toBe(true)
    expect(isLegacyName('notes/20261125-181026-2.txt')).toBe(true)
    expect(isLegacyName('2026 회고.md')).toBe(false)
    expect(titleFromText('\n\n# 장보기 목록\n- 우유')).toBe('장보기 목록')
    expect(titleFromText('a/b [c] #d | e')).toBe('a b c d e')
    expect(titleFromText('')).toBe('')
    expect(titleFromText('x'.repeat(100)).length).toBe(60)
  })
})

describe('what a note contains', () => {
  it('lists its tags once each, ignoring code', () => {
    expect(tagsOf('#할일 과 #프로젝트/웹, 다시 #할일\n`#코드`\n```\n#블록\n```\nC# 은 아님')).toEqual(['할일', '프로젝트/웹'])
    expect(tagsOf('# 제목은 태그가 아니다')).toEqual([])
  })

  it('lists its headings with their lines', () => {
    expect(outlineOf('# 하나\n글\n## 둘 ##\n```\n# 코드 안\n```\n### 셋')).toEqual([
      { level: 1, title: '하나', line: 0 },
      { level: 2, title: '둘', line: 2 },
      { level: 3, title: '셋', line: 6 },
    ])
  })
})

describe('moving', () => {
  it('explains why something cannot be moved', () => {
    expect(moveProblem('a.md', '프로젝트', ['b.md'])).toBeUndefined()
    expect(moveProblem('프로젝트/a.md', '', [])).toBeUndefined()
    // 이미 그 폴더에 있으면 옮길 것이 없다.
    expect(moveProblem('프로젝트/a.md', '프로젝트', ['a.md'])).toBe('')
    expect(moveProblem('a.md', '프로젝트', ['A.md'])).toContain('같은 이름')
    expect(moveProblem('프로젝트', '프로젝트/하위', [])).toContain('자기 자신')
    expect(moveProblem('프로젝트', '프로젝트', [])).toContain('자기 자신')
    expect(moveProblem('프로젝트2', '프로젝트', [])).toBeUndefined()
  })
})

describe('graph', () => {
  const notes = [
    { path: '회의록.md', text: '[[예산]] [[일정]] [[예산]] ![[그림.png]] `[[코드]]`' },
    { path: '예산.md', text: '[[회의록]] [[회의록|다시]] [[없는 메모]]' },
    { path: '폴더/일정.md', text: '[[일정]] 자기 자신' },
    { path: '외톨이.md', text: '링크 없음' },
  ]
  const files = [...notes.map((n) => n.path), 'attachments/그림.png']

  it('has a node per note and per missing target, and one link per pair and direction', () => {
    const graph = buildGraph(notes, files)
    expect(graph.nodes.map((n) => [n.id, n.label, n.exists, n.degree])).toEqual([
      ['회의록.md', '회의록', true, 3],
      ['예산.md', '예산', true, 3],
      ['폴더/일정.md', '일정', true, 1],
      ['외톨이.md', '외톨이', true, 0],
      ['?없는 메모', '없는 메모', false, 1],
    ])
    expect(graph.links).toEqual([
      { source: '회의록.md', target: '예산.md' },
      { source: '회의록.md', target: '폴더/일정.md' },
      { source: '예산.md', target: '회의록.md' },
      { source: '예산.md', target: '?없는 메모' },
    ])
  })

  it('lays nodes out inside the area, apart from each other, and the same way every time', () => {
    const graph = buildGraph(notes, files)
    const a = layoutGraph(graph, 600, 400)
    const b = layoutGraph(graph, 600, 400)
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]))
    for (const node of a.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(30)
      expect(node.x).toBeLessThanOrEqual(570)
      expect(node.y).toBeGreaterThanOrEqual(20)
      expect(node.y).toBeLessThanOrEqual(380)
    }
    const distances = a.nodes.flatMap((p, i) => a.nodes.slice(i + 1).map((q) => Math.hypot(p.x - q.x, p.y - q.y)))
    expect(Math.min(...distances)).toBeGreaterThan(40)
    // 이어진 점끼리가 이어지지 않은 점보다 가깝다.
    const at = (id: string) => a.nodes.find((n) => n.id === id)!
    const dist = (p: string, q: string) => Math.hypot(at(p).x - at(q).x, at(p).y - at(q).y)
    expect(dist('회의록.md', '예산.md')).toBeLessThan(dist('외톨이.md', '예산.md'))
  })

  it('handles an empty vault and a single note', () => {
    expect(layoutGraph(buildGraph([], []), 600, 400).nodes).toEqual([])
    const one = layoutGraph(buildGraph([{ path: 'a.md', text: '' }], ['a.md']), 600, 400).nodes[0]!
    expect(Number.isFinite(one.x) && Number.isFinite(one.y)).toBe(true)
  })
})
