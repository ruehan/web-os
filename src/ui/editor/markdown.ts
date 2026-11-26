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
}

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; text: string; lang: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
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

const LIST_ITEM = /^\s*(?:([-*+])|\d+\.)\s+(.*)$/
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

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) })
    paragraph = []
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
      blocks.push({ type: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!) })
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
    const item = LIST_ITEM.exec(line)
    if (item) {
      flush()
      const ordered = item[1] === undefined
      const items: ListItem[] = []
      for (; i < lines.length; i++) {
        const next = LIST_ITEM.exec(lines[i]!)
        if (!next || (next[1] === undefined) !== ordered) break
        const task = TASK.exec(next[2]!)
        if (task) items.push({ children: parseInline(task[2]!), checked: task[1] !== ' ', line: i })
        else items.push({ children: parseInline(next[2]!), line: i })
      }
      i--
      blocks.push({ type: 'list', ordered, items })
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
