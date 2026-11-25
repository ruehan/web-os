// 마크다운을 화면에 그릴 수 있는 구조로 해석한다. 자주 쓰는 기본 문법만 다룬다:
// 제목, 문단, 목록, 인용, 코드 블록, 구분선, 그리고 줄 안의 굵게·기울임·코드·링크.
// 글자 그대로의 HTML은 해석하지 않으므로, 파일에 든 태그가 실행되는 일은 없다.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; text: string; lang: string }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'rule' }

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*|_([^_\s][^_\n]*)_|\[([^\]\n]+)\]\(([^)\s]*)\)/g
/** 눌렀을 때 페이지 밖으로 나가도 안전한 주소만 링크로 만든다. */
const SAFE_LINK = /^(https?:|mailto:)/i

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const plain = (piece: string) => piece && out.push({ type: 'text', text: piece })
  let at = 0
  for (const match of text.matchAll(INLINE)) {
    plain(text.slice(at, match.index))
    const [whole, code, strong, em, em2, label, href] = match
    if (code !== undefined) out.push({ type: 'code', text: code })
    else if (strong !== undefined) out.push({ type: 'strong', children: parseInline(strong) })
    else if (em !== undefined || em2 !== undefined) out.push({ type: 'em', children: parseInline((em ?? em2)!) })
    else if (SAFE_LINK.test(href!)) out.push({ type: 'link', href: href!, children: parseInline(label!) })
    else plain(label!)
    at = match.index + whole.length
  }
  plain(text.slice(at))
  return out
}

const LIST_ITEM = /^\s*(?:([-*+])|\d+\.)\s+(.*)$/

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
      const items: Inline[][] = []
      for (; i < lines.length; i++) {
        const next = LIST_ITEM.exec(lines[i]!)
        if (!next || (next[1] === undefined) !== ordered) break
        items.push(parseInline(next[2]!))
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
