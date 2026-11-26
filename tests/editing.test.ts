import { describe, expect, it } from 'vitest'
import { continueList, indent } from '../src/ui/notes/editing.ts'

/** 글에서 | 를 커서(또는 선택의 양 끝)로 보고, 결과도 같은 표기로 돌려준다. */
function run(marked: string, edit: (text: string, start: number, end: number) => { text: string; start: number; end: number } | null) {
  const start = marked.indexOf('|')
  const rest = marked.slice(0, start) + marked.slice(start + 1)
  const second = rest.indexOf('|')
  const text = second < 0 ? rest : rest.slice(0, second) + rest.slice(second + 1)
  const result = edit(text, start, second < 0 ? start : second)
  if (!result) return null
  const { text: out, start: s, end: e } = result
  return s === e ? `${out.slice(0, s)}|${out.slice(s)}` : `${out.slice(0, s)}|${out.slice(s, e)}|${out.slice(e)}`
}

const enter = (marked: string) => run(marked, (text, pos) => continueList(text, pos))
const tab = (marked: string) => run(marked, (text, s, e) => indent(text, s, e, false))
const shiftTab = (marked: string) => run(marked, (text, s, e) => indent(text, s, e, true))

describe('Enter in a list', () => {
  it('starts the next item with the same marker', () => {
    expect(enter('- 우유|')).toBe('- 우유\n- |')
    expect(enter('* 우유|\n* 빵')).toBe('* 우유\n* |\n* 빵')
    expect(enter('  + 들여 쓴|')).toBe('  + 들여 쓴\n  + |')
  })

  it('counts up in numbered lists and starts tasks unchecked', () => {
    expect(enter('1. 하나|')).toBe('1. 하나\n2. |')
    expect(enter('9. 아홉|')).toBe('9. 아홉\n10. |')
    expect(enter('- [x] 한 일|')).toBe('- [x] 한 일\n- [ ] |')
    expect(enter('3. [ ] 할 일|')).toBe('3. [ ] 할 일\n4. [ ] |')
  })

  it('splits an item when pressed in the middle', () => {
    expect(enter('- 우유|와 빵')).toBe('- 우유\n- |와 빵')
  })

  it('ends the list on an empty item, or steps out one level if indented', () => {
    expect(enter('- 우유\n- |')).toBe('- 우유\n|')
    expect(enter('- [ ] |')).toBe('|')
    expect(enter('- 과일\n  - |')).toBe('- 과일\n- |')
    expect(enter('  1. |\n다음')).toBe('1. |\n다음')
  })

  it('leaves ordinary lines, and Enter before the marker, alone', () => {
    expect(enter('보통 문단|')).toBeNull()
    expect(enter('# 제목|')).toBeNull()
    expect(enter('|- 우유')).toBeNull()
    expect(enter('-|우유')).toBeNull()
  })
})

describe('Tab and Shift+Tab', () => {
  it('indents and outdents the list item the cursor is on', () => {
    expect(tab('- 과일\n- 사|과')).toBe('- 과일\n  - 사|과')
    expect(shiftTab('- 과일\n  - 사|과')).toBe('- 과일\n- 사|과')
    expect(shiftTab('- 이미 맨 앞|')).toBe('- 이미 맨 앞|')
  })

  it('inserts two spaces on an ordinary line', () => {
    expect(tab('보통| 글')).toBe('보통  | 글')
    expect(tab('|')).toBe('  |')
  })

  it('moves every selected line, keeping the selection over the same text', () => {
    expect(tab('- 하|나\n- 둘\n- 셋|\n- 넷')).toBe('  - 하|나\n  - 둘\n  - 셋|\n- 넷')
    expect(shiftTab('  - 하|나\n    - 둘\n- 셋|')).toBe('- 하|나\n  - 둘\n- 셋|')
    // 빈 줄은 들여 쓰지 않는다.
    expect(tab('|가\n\n나|')).toBe('  |가\n\n  나|')
  })

  it('outdents a tab character too', () => {
    expect(shiftTab('\t- 탭으로|')).toBe('- 탭으로|')
  })
})
