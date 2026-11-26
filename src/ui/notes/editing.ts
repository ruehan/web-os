// 메모를 쓸 때의 편의 동작: 목록에서 Enter를 치면 다음 항목이 이어지고, Tab으로 들여 쓴다.
// 글과 커서 위치를 받아 바뀐 글과 커서 위치를 돌려주는 계산만 하므로 단독으로 테스트할 수 있다.

export interface Edit {
  text: string
  /** 바뀐 뒤의 선택 범위 (커서만 있으면 둘이 같다) */
  start: number
  end: number
}

const INDENT = '  '
/** 들여쓰기, 목록 표시(- * + 또는 1.), 체크 상자, 내용 */
const LIST_LINE = /^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)$/

const lineStart = (text: string, pos: number) => text.lastIndexOf('\n', pos - 1) + 1
const lineEnd = (text: string, pos: number) => {
  const end = text.indexOf('\n', pos)
  return end < 0 ? text.length : end
}

/**
 * 목록 항목에서 Enter를 쳤을 때. 목록이 아니면 null (보통의 줄바꿈에 맡긴다).
 *  - 내용이 있는 항목: 같은 들여쓰기와 표시로 다음 항목을 시작한다. 번호 목록은 번호를 하나 올리고, 체크 목록은 빈 상자로 시작한다.
 *  - 내용이 없는 항목: 목록을 끝낸다 (표시를 지운다). 들여 쓴 항목이면 한 단계 내어 쓴다.
 */
export function continueList(text: string, pos: number): Edit | null {
  const from = lineStart(text, pos)
  const to = lineEnd(text, pos)
  const match = LIST_LINE.exec(text.slice(from, to))
  if (!match) return null
  const [, indent, marker, task, content] = match as unknown as [string, string, string, string | undefined, string]
  // 표시 앞이나 한가운데에서 친 Enter는 보통의 줄바꿈이다.
  if (pos < from + indent.length + marker.length + 1) return null

  if (content.trim() === '') {
    const kept = indent.length >= INDENT.length ? `${indent.slice(INDENT.length)}${marker} ${task ?? ''}` : ''
    const next = text.slice(0, from) + kept + text.slice(to)
    return { text: next, start: from + kept.length, end: from + kept.length }
  }
  const number = /^\d+/.exec(marker)
  const nextMarker = number ? `${Number(number[0]) + 1}.` : marker
  const insert = `\n${indent}${nextMarker} ${task ? '[ ] ' : ''}`
  const next = text.slice(0, pos) + insert + text.slice(pos)
  return { text: next, start: pos + insert.length, end: pos + insert.length }
}

/**
 * Tab / Shift+Tab. 선택한 줄들(또는 커서가 있는 목록 항목)을 한 단계 들여 쓰거나 내어 쓴다.
 * 목록도 아니고 여러 줄을 고른 것도 아니면, Tab은 그 자리에 공백 두 칸을 넣는다.
 */
export function indent(text: string, start: number, end: number, outdent: boolean): Edit {
  const from = lineStart(text, start)
  const to = lineEnd(text, end)
  const block = text.slice(from, to)
  const single = !block.includes('\n')
  if (single && !outdent && !LIST_LINE.test(block)) {
    return { text: text.slice(0, start) + INDENT + text.slice(end), start: start + INDENT.length, end: start + INDENT.length }
  }
  let first = 0
  let total = 0
  const lines = block.split('\n').map((line, i) => {
    let delta: number
    let changed: string
    if (outdent) {
      const removable = /^ {1,2}|^\t/.exec(line)?.[0].length ?? 0
      delta = -removable
      changed = line.slice(removable)
    } else {
      // 빈 줄은 들여 쓰지 않는다 (줄 끝 공백이 생기지 않게).
      delta = line.trim() === '' ? 0 : INDENT.length
      changed = delta ? INDENT + line : line
    }
    if (i === 0) first = delta
    total += delta
    return changed
  })
  const next = text.slice(0, from) + lines.join('\n') + text.slice(to)
  return { text: next, start: Math.max(from, start + first), end: Math.max(from, end + total) }
}
