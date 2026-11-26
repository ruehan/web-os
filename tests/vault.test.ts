import { describe, expect, it } from 'vitest'
import {
  extensionForType,
  imageTypeOf,
  isLegacyName,
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
