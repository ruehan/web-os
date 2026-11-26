// 문법에 따라 글자에 색을 입히기 위한 간단한 분석기. 글을 "종류가 붙은 조각"들로 나눈다.
// 정확한 문법 분석이 아니라, 주석·문자열·숫자·예약어처럼 눈에 띄어야 하는 것만 가려낸다.

export type TokenKind = '' | 'comment' | 'string' | 'number' | 'keyword' | 'name' | 'heading' | 'emphasis' | 'code' | 'link' | 'mark'

export interface Token {
  text: string
  kind: TokenKind
}

export type Lang = 'sh' | 'json' | 'js' | 'rust' | 'markdown' | 'csv'

const EXTENSIONS: Record<string, Lang> = {
  sh: 'sh',
  json: 'json',
  js: 'js',
  mjs: 'js',
  ts: 'js',
  tsx: 'js',
  jsx: 'js',
  rs: 'rust',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
}

/** 파일 이름의 확장자로 형식을 정한다. 모르는 확장자는 일반 텍스트(undefined)다. */
export function languageOf(path: string): Lang | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1).toLowerCase()] : undefined
}

const words = (list: string) => new Set(list.split(' '))

const KEYWORDS: Record<'sh' | 'js' | 'rust', Set<string>> = {
  sh: words('if then else elif fi for while until do done case esac in function return export unset cd exit echo'),
  js: words(
    'as async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof interface let new null of return static super switch this throw true try type typeof undefined var void while yield',
  ),
  rust: words(
    'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  ),
}

/** [찾을 모양, 조각의 종류 또는 찾은 글로 종류를 정하는 함수] */
type Rule = [RegExp, TokenKind | ((match: string, rest: string) => TokenKind)]

const STRING_DOUBLE = /"(?:\\.|[^"\\\n])*"?/y
const STRING_SINGLE = /'(?:\\.|[^'\\\n])*'?/y
const NUMBER = /-?\b\d[\w.]*/y
const WORD = /[A-Za-z_$][\w$]*/y

const cLike = (lang: 'js' | 'rust', extra: Rule[] = []): Rule[] => [
  [/\/\/[^\n]*/y, 'comment'],
  [/\/\*[\s\S]*?(?:\*\/|$)/y, 'comment'],
  [STRING_DOUBLE, 'string'],
  ...extra,
  [NUMBER, 'number'],
  [WORD, (word) => (KEYWORDS[lang].has(word) ? 'keyword' : '')],
]

const RULES: Record<Exclude<Lang, 'markdown' | 'csv'>, Rule[]> = {
  js: cLike('js', [
    [STRING_SINGLE, 'string'],
    [/`(?:\\.|[^`\\])*`?/y, 'string'],
  ]),
  // 러스트의 작은따옴표는 문자('a')와 수명('a)에 모두 쓰이므로 문자 꼴일 때만 문자열로 본다.
  rust: cLike('rust', [[/'(?:\\.|[^'\\\n])'/y, 'string']]),
  sh: [
    [/#[^\n]*/y, 'comment'],
    [STRING_DOUBLE, 'string'],
    [STRING_SINGLE, 'string'],
    [/\$\{[^}\n]*\}?|\$[\w?$#@*]+/y, 'name'],
    [NUMBER, 'number'],
    [/[A-Za-z_][\w-]*/y, (word) => (KEYWORDS.sh.has(word) ? 'keyword' : '')],
  ],
  json: [
    // 뒤에 콜론이 오는 문자열은 이름(키)이다.
    [STRING_DOUBLE, (_, rest) => (/^\s*:/.test(rest) ? 'name' : 'string')],
    [/-?\d[\d.eE+-]*/y, 'number'],
    [/\b(?:true|false|null)\b/y, 'keyword'],
  ],
}

function scan(text: string, rules: Rule[], comments: 'word-start' | 'anywhere'): Token[] {
  const tokens: Token[] = []
  const push = (piece: string, kind: TokenKind) => {
    const last = tokens.at(-1)
    if (last && last.kind === kind) last.text += piece
    else tokens.push({ text: piece, kind })
  }
  let i = 0
  outer: while (i < text.length) {
    for (const [pattern, kind] of rules) {
      // 셸의 #은 낱말 처음에 올 때만 주석이다 (echo a#b 의 #은 아니다).
      if (comments === 'word-start' && pattern.source.startsWith('#') && i > 0 && !/\s/.test(text[i - 1]!)) continue
      pattern.lastIndex = i
      const match = pattern.exec(text)
      if (!match || match[0] === '') continue
      const end = i + match[0].length
      push(match[0], typeof kind === 'function' ? kind(match[0], text.slice(end, end + 8)) : kind)
      i = end
      continue outer
    }
    push(text[i]!, '')
    i++
  }
  return tokens
}

/** 마크다운은 줄 단위로 본다: 제목, 인용, 목록, 코드 블록을 가리고, 줄 안에서는 강조와 링크를 찾는다. */
function markdown(text: string): Token[] {
  const tokens: Token[] = []
  const push = (piece: string, kind: TokenKind) => piece && tokens.push({ text: piece, kind })
  // 메모 링크([[..]], ![[..]])와 그림(![..](..))도 링크처럼 색을 입힌다.
  const INLINE = /`[^`\n]+`|!?\[\[[^\]\n]+\]\]|\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|!?\[[^\]\n]*\]\([^)\n]*\)/g
  let fenced = false
  const lines = text.split('\n')
  lines.forEach((line, n) => {
    const newline = n < lines.length - 1 ? '\n' : ''
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      return push(line + newline, 'code')
    }
    if (fenced) return push(line + newline, 'code')
    if (/^#{1,6}\s/.test(line)) return push(line + newline, 'heading')
    if (/^\s*>/.test(line)) return push(line + newline, 'comment')
    const marker = /^\s*(?:[-*+]|\d+\.)\s/.exec(line)?.[0] ?? ''
    push(marker, 'mark')
    let at = marker.length
    for (const match of line.slice(at).matchAll(INLINE)) {
      const start = marker.length + match.index
      push(line.slice(at, start), '')
      const piece = match[0]
      push(piece, piece.startsWith('`') ? 'code' : piece.startsWith('[') || piece.startsWith('!') ? 'link' : 'emphasis')
      at = start + piece.length
    }
    push(line.slice(at) + newline, '')
  })
  return tokens
}

/** 글을 종류가 붙은 조각들로 나눈다. 조각들을 이어 붙이면 원래 글과 정확히 같다. */
export function highlight(text: string, lang: Lang | undefined): Token[] {
  if (!lang || lang === 'csv') return text ? [{ text, kind: '' }] : []
  if (lang === 'markdown') return markdown(text)
  return scan(text, RULES[lang], lang === 'sh' ? 'word-start' : 'anywhere')
}
