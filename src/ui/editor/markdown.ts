// 마크다운을 화면에 그릴 수 있는 구조로 해석한다. 자주 쓰는 문법을 다룬다:
// 제목, 문단, 목록(체크 목록 포함), 인용, 코드 블록, 표, 구분선,
// 그리고 줄 안의 굵게·기울임·코드·링크·그림·[[메모 링크]]·#태그.
// 글자 그대로의 HTML은 해석하지 않으므로, 파일에 든 태그가 실행되는 일은 없다.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  /** ![설명](주소): 주소는 바깥 사이트이거나 보관함 안의 파일이다. */
  | { type: 'image'; src: string; alt: string }
  /** [[대상|표시]]: 다른 메모로 가는 링크. embed면 ![[대상]] 꼴로, 그 자리에 내용(그림)을 넣는다. */
  | { type: 'wikilink'; target: string; label: string; embed: boolean }
  | { type: 'tag'; name: string }

export interface ListItem {
  children: Inline[]
  /** 체크 목록(- [ ] / - [x])이면 체크 여부. 보통 목록이면 없다. */
  checked?: boolean
  /** 원문에서 이 항목이 있는 줄 (0부터). 체크를 눌렀을 때 그 줄을 고치는 데 쓴다. */
  line: number
  /** 이 항목 아래에 들여 쓴 목록 */
  sub?: ListBlock
}

export interface ListBlock {
  type: 'list'
  ordered: boolean
  items: ListItem[]
}

export type Block =
  /** line: 원문에서 이 제목이 있는 줄 (0부터). 목차에서 그 위치로 가는 데 쓴다. */
  | { type: 'heading'; level: number; children: Inline[]; line: number }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; text: string; lang: string }
  | ListBlock
  /** 한 줄에 ![[메모]]만 있는 경우: 그 자리에 그 메모의 내용을 넣는다. */
  | { type: 'embed'; target: string; label: string }
  | { type: 'quote'; children: Inline[] }
  | { type: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' }

// 순서가 중요하다: 그림(![..](..))과 넣기(![[..]])를 링크보다 먼저 찾아야 느낌표가 떨어져 나가지 않는다.
const INLINE = new RegExp(
  [
    '`([^`\\n]+)`', // 1 코드
    '!\\[\\[([^\\]\\n]+)\\]\\]', // 2 넣기
    '\\[\\[([^\\]\\n]+)\\]\\]', // 3 메모 링크
    '!\\[([^\\]\\n]*)\\]\\(([^)\\s]*)\\)', // 4, 5 그림
    '\\*\\*([^*\\n]+)\\*\\*', // 6 굵게
    '\\*([^*\\s][^*\\n]*)\\*', // 7 기울임
    '_([^_\\s][^_\\n]*)_', // 8 기울임
    '\\[([^\\]\\n]+)\\]\\(([^)\\s]*)\\)', // 9, 10 링크
    '(?<![\\p{L}\\p{N}_#&/])#([\\p{L}_][\\p{L}\\p{N}_/-]*)', // 11 태그
  ].join('|'),
  'gu',
)
/** 눌렀을 때 페이지 밖으로 나가도 안전한 주소만 링크로 만든다. */
const SAFE_LINK = /^(https?:|mailto:)/i

/** [[대상#제목|표시]] 의 안쪽을 대상과 표시 이름으로 나눈다. */
function wikilink(inner: string, embed: boolean): Inline {
  const bar = inner.indexOf('|')
  const target = (bar < 0 ? inner : inner.slice(0, bar)).replace(/#.*$/, '').trim()
  const label = bar < 0 ? inner.trim() : inner.slice(bar + 1).trim()
  return { type: 'wikilink', target, label: label || target, embed }
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const plain = (piece: string | undefined) => piece && out.push({ type: 'text', text: piece })
  let at = 0
  for (const match of text.matchAll(INLINE)) {
    plain(text.slice(at, match.index))
    const [whole, code, embed, wiki, alt, src, strong, em, em2, label, href, tag] = match
    if (code !== undefined) out.push({ type: 'code', text: code })
    else if (embed !== undefined) out.push(wikilink(embed, true))
    else if (wiki !== undefined) out.push(wikilink(wiki, false))
    else if (src !== undefined) out.push({ type: 'image', src, alt: alt ?? '' })
    else if (strong !== undefined) out.push({ type: 'strong', children: parseInline(strong) })
    else if (em !== undefined || em2 !== undefined) out.push({ type: 'em', children: parseInline((em ?? em2)!) })
    else if (tag !== undefined) out.push({ type: 'tag', name: tag })
    else if (SAFE_LINK.test(href!)) out.push({ type: 'link', href: href!, children: parseInline(label!) })
    else plain(label)
    at = match.index + whole.length
  }
  plain(text.slice(at))
  return out
}

const LIST_ITEM = /^(\s*)(?:([-*+])|\d+\.)\s+(.*)$/
/** 이만큼 더 들여 쓰면 아래 단계의 목록으로 본다. */
const SUB_INDENT = 2
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i
const TASK = /^\[([ xX])\]\s+(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** 표의 한 줄을 칸으로 나눈다. 양 끝의 | 는 떼고, \| 는 글자로 본다. */
function cells(line: string): Inline[][] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => parseInline(cell.replace(/\\\|/g, '|').trim()))
}

/** 탭은 공백 두 칸으로 쳐서 들여쓰기의 깊이를 잰다. */
const indentOf = (space: string) => space.replace(/\t/g, '  ').length

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length === 0) return
    const children = parseInline(paragraph.join(' '))
    paragraph = []
    // 한 줄에 메모 넣기(![[메모]])만 있으면 문단이 아니라 넣기 블록이다. 그림은 줄 안에 그대로 둔다.
    const only = children.length === 1 ? children[0]! : undefined
    if (only?.type === 'wikilink' && only.embed && !IMAGE_NAME.test(only.target)) {
      blocks.push({ type: 'embed', target: only.target, label: only.label })
    } else {
      blocks.push({ type: 'paragraph', children })
    }
  }

  /**
   * i번째 줄에서 시작하는 목록을 읽는다. 같은 깊이의 항목이 이어지는 동안 모으고,
   * 더 깊이 들여 쓴 항목들은 바로 앞 항목의 아래 목록으로 넣는다. 읽은 다음 줄의 번호를 함께 돌려준다.
   */
  const readList = (start: number): [ListBlock, number] => {
    const first = LIST_ITEM.exec(lines[start]!)!
    const base = indentOf(first[1]!)
    const ordered = first[2] === undefined
    const items: ListItem[] = []
    let i = start
    while (i < lines.length) {
      const next = LIST_ITEM.exec(lines[i]!)
      if (!next) break
      const depth = indentOf(next[1]!)
      if (depth >= base + SUB_INDENT && items.length) {
        const [sub, after] = readList(i)
        items.at(-1)!.sub = sub
        i = after
        continue
      }
      // 덜 들여 쓴 줄은 바깥 목록의 것이고, 표시의 종류가 바뀌면 다른 목록이다.
      if (depth < base || (next[2] === undefined) !== ordered) break
      const task = TASK.exec(next[3]!)
      if (task) items.push({ children: parseInline(task[2]!), checked: task[1] !== ' ', line: i })
      else items.push({ children: parseInline(next[3]!), line: i })
      i++
    }
    return [{ type: 'list', ordered, items }, i]
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*```\s*(\S*)/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i]!)
      blocks.push({ type: 'code', text: body.join('\n'), lang: fence[1]! })
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!), line: i })
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush()
      blocks.push({ type: 'rule' })
      continue
    }
    // 표: 머리줄 바로 아래에 |---|---| 꼴의 줄이 있어야 표로 본다.
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flush()
      const head = cells(line)
      const rows: Inline[][][] = []
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]!); i++) rows.push(cells(lines[i]!))
      i--
      blocks.push({ type: 'table', head, rows })
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const body: string[] = []
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*>\s?/, ''))
      i--
      blocks.push({ type: 'quote', children: parseInline(body.join(' ')) })
      continue
    }
    if (LIST_ITEM.test(line)) {
      flush()
      const [list, after] = readList(i)
      blocks.push(list)
      i = after - 1
      continue
    }
    if (line.trim() === '') flush()
    else paragraph.push(line.trim())
  }
  flush()
  return blocks
}

/** 체크 목록의 한 줄에서 체크를 뒤집은 글을 돌려준다. 그 줄이 체크 목록이 아니면 그대로다. */
export function toggleTask(text: string, line: number): string {
  const lines = text.split('\n')
  const current = lines[line]
  if (current === undefined) return text
  lines[line] = current.replace(/^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/, (_, open, mark, close) => `${open}${mark === ' ' ? 'x' : ' '}${close}`)
  return lines.join('\n')
}
