import { describe, expect, it } from 'vitest'
import { parseCsv } from '../src/ui/editor/csv.ts'
import { highlight, languageOf, type Lang } from '../src/ui/editor/highlight.ts'
import { parseInline, parseMarkdown, toggleTask } from '../src/ui/editor/markdown.ts'

/** 색이 입혀지는 조각만 "종류:글" 꼴로 모은다. */
const colored = (text: string, lang: Lang) =>
  highlight(text, lang)
    .filter((t) => t.kind)
    .map((t) => `${t.kind}:${t.text}`)

describe('highlight', () => {
  it('picks the language from the file extension', () => {
    expect(languageOf('/home/guest/hello.sh')).toBe('sh')
    expect(languageOf('data.JSON')).toBe('json')
    expect(languageOf('/a/b.rs')).toBe('rust')
    expect(languageOf('note.md')).toBe('markdown')
    expect(languageOf('/etc/motd')).toBeUndefined()
    expect(languageOf('.hidden')).toBeUndefined()
    expect(languageOf('archive.tar.gz')).toBeUndefined()
  })

  it.each<[Lang | undefined, string]>([
    ['sh', '# 주석\necho "hi $USER" > f # 끝\nif true; then exit 1; fi'],
    ['json', '{\n  "이름": "값",\n  "n": [1, -2.5e3, true, null]\n}'],
    ['js', 'const a = `x` // c\n/* 여러\n줄 */ let s = \'q\''],
    ['rust', "fn main() { let c = 'a'; let s: &'static str = \"x\"; }"],
    ['markdown', '# 제목\n글 **굵게** `code`\n```\nx\n```\n- 항목'],
    ['csv', 'a,b\n1,2'],
    [undefined, '그냥 글\n'],
  ])('never changes the text (%s)', (lang, text) => {
    expect(highlight(text, lang).map((t) => t.text).join('')).toBe(text)
  })

  it('colors shell comments, strings, variables and keywords', () => {
    expect(colored('# 주석\nif echo "a $B" \'c\' $D ${E}; then exit 2; fi', 'sh')).toEqual([
      'comment:# 주석',
      'keyword:if',
      'keyword:echo',
      'string:"a $B"',
      "string:'c'",
      'name:$D',
      'name:${E}',
      'keyword:then',
      'keyword:exit',
      'number:2',
      'keyword:fi',
    ])
    // 낱말 중간의 #은 주석이 아니다.
    expect(colored('echo a#b #c', 'sh')).toEqual(['keyword:echo', 'comment:#c'])
  })

  it('tells JSON keys from values', () => {
    expect(colored('{"k": "v", "n": -1.5, "t": true, "z": null}', 'json')).toEqual([
      'name:"k"',
      'string:"v"',
      'name:"n"',
      'number:-1.5',
      'name:"t"',
      'keyword:true',
      'name:"z"',
      'keyword:null',
    ])
  })

  it('handles comments and strings in JavaScript and Rust', () => {
    expect(colored('const s = "a//b" // real\n/* x */ return 42', 'js')).toEqual([
      'keyword:const',
      'string:"a//b"',
      'comment:// real',
      'comment:/* x */',
      'keyword:return',
      'number:42',
    ])
    // 수명 표기('a)의 작은따옴표를 문자열의 시작으로 오해하지 않는다.
    expect(colored("fn f<'a>(x: &'a str) -> char { 'z' }", 'rust')).toEqual(['keyword:fn', "string:'z'"])
  })

  it('an unterminated string or comment colors to the end without failing', () => {
    expect(colored('let s = "open', 'js')).toEqual(['keyword:let', 'string:"open'])
    expect(colored('a /* never closed', 'js')).toEqual(['comment:/* never closed'])
  })

  it('marks up Markdown structure', () => {
    expect(colored('# 제목\n> 인용\n- **굵게** 와 `코드` 와 [링크](https://a.b)\n```sh\n# 주석 아님\n```', 'markdown')).toEqual([
      'heading:# 제목\n',
      'comment:> 인용\n',
      'mark:- ',
      'emphasis:**굵게**',
      'code:`코드`',
      'link:[링크](https://a.b)',
      'code:```sh\n',
      'code:# 주석 아님\n',
      'code:```',
    ])
  })
})

describe('markdown', () => {
  it('parses block structure', () => {
    const blocks = parseMarkdown(
      ['# 제목 #', '', '첫 문단', '이어지는 줄', '', '- 하나', '- 둘', '', '1. 일', '2. 이', '', '> 인용', '> 계속', '', '---', '```rust', 'fn x() {}', '', '```'].join('\n'),
    )
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'rule', 'code'])
    expect(blocks[0]).toEqual({ type: 'heading', level: 1, children: [{ type: 'text', text: '제목' }] })
    expect(blocks[1]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: '첫 문단 이어지는 줄' }] })
    expect(blocks[2]).toMatchObject({ ordered: false, items: [{ children: [{ text: '하나' }], line: 5 }, { children: [{ text: '둘' }], line: 6 }] })
    expect(blocks[3]).toMatchObject({ ordered: true, items: [{ children: [{ text: '일' }] }, { children: [{ text: '이' }] }] })
    expect(blocks[4]).toMatchObject({ children: [{ text: '인용 계속' }] })
    expect(blocks[6]).toEqual({ type: 'code', lang: 'rust', text: 'fn x() {}\n' })
  })

  it('parses inline emphasis, code and links', () => {
    // 굵게 안의 기울임은 밑줄 표기(_)로 적어야 알아본다. 별표끼리 겹친 표기(**a *b***)는 다루지 않는다.
    expect(parseInline('a **b _c_** `d*e*` [f](https://x.y) _g_')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', children: [{ type: 'text', text: 'b ' }, { type: 'em', children: [{ type: 'text', text: 'c' }] }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'd*e*' },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://x.y', children: [{ type: 'text', text: 'f' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'g' }] },
    ])
  })

  it('does not turn script links or raw HTML into anything active', () => {
    expect(parseInline('[눌러](javascript:alert(1)) <script>x</script>')).toEqual([
      { type: 'text', text: '눌러' },
      { type: 'text', text: ') <script>x</script>' },
    ])
    expect(parseMarkdown('<img src=x onerror=alert(1)>')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
    ])
  })

  it('parses note links, embeds, images and tags', () => {
    expect(parseInline('[[회의록]] [[폴더/계획#일정|이번 계획]] ![[그림.png]] ![설명](attachments/a.png) #할일 #프로젝트/웹')).toEqual([
      { type: 'wikilink', target: '회의록', label: '회의록', embed: false },
      { type: 'text', text: ' ' },
      { type: 'wikilink', target: '폴더/계획', label: '이번 계획', embed: false },
      { type: 'text', text: ' ' },
      { type: 'wikilink', target: '그림.png', label: '그림.png', embed: true },
      { type: 'text', text: ' ' },
      { type: 'image', src: 'attachments/a.png', alt: '설명' },
      { type: 'text', text: ' ' },
      { type: 'tag', name: '할일' },
      { type: 'text', text: ' ' },
      { type: 'tag', name: '프로젝트/웹' },
    ])
  })

  it('does not mistake other uses of # for tags', () => {
    const kinds = (text: string) => parseInline(text).map((i) => i.type)
    expect(kinds('C#은 언어다, 가격은 #1, 주소 a.b/#top, 색 &#35;')).toEqual(['text'])
    expect(kinds('`#코드` 안과 [[메모#제목]] 안')).toEqual(['code', 'text', 'wikilink', 'text'])
  })

  it('parses task lists with the line each task is on', () => {
    const blocks = parseMarkdown('머리말\n\n- [ ] 할 일\n- [x] 한 일\n- 보통 항목')
    expect(blocks[1]).toMatchObject({
      type: 'list',
      items: [
        { checked: false, line: 2, children: [{ text: '할 일' }] },
        { checked: true, line: 3, children: [{ text: '한 일' }] },
        { line: 4, children: [{ text: '보통 항목' }] },
      ],
    })
    expect((blocks[1] as { items: { checked?: boolean }[] }).items[2]!.checked).toBeUndefined()
  })

  it('toggles a task in the source text, leaving everything else alone', () => {
    const text = '- [ ] 하나\n  1. [x] 둘\n- 셋 [ ]\n글'
    expect(toggleTask(text, 0)).toBe('- [x] 하나\n  1. [x] 둘\n- 셋 [ ]\n글')
    expect(toggleTask(text, 1)).toBe('- [ ] 하나\n  1. [ ] 둘\n- 셋 [ ]\n글')
    // 체크 목록이 아닌 줄이나 없는 줄은 건드리지 않는다.
    expect(toggleTask(text, 2)).toBe(text)
    expect(toggleTask(text, 3)).toBe(text)
    expect(toggleTask(text, 99)).toBe(text)
  })

  it('parses tables', () => {
    const blocks = parseMarkdown('| 이름 | 값 |\n|---|:--:|\n| **가** | 1 |\n| 나 \\| 다 | `2` |\n\n다음 문단')
    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph'])
    expect(blocks[0]).toMatchObject({
      head: [[{ text: '이름' }], [{ text: '값' }]],
      rows: [
        [[{ type: 'strong' }], [{ text: '1' }]],
        [[{ text: '나 | 다' }], [{ type: 'code', text: '2' }]],
      ],
    })
    // 구분 줄이 없으면 표가 아니다.
    expect(parseMarkdown('| 그냥 | 글 |').map((b) => b.type)).toEqual(['paragraph'])
  })

  it('an unclosed code fence runs to the end', () => {
    expect(parseMarkdown('```\na\nb')).toEqual([{ type: 'code', lang: '', text: 'a\nb' }])
  })
})

describe('csv', () => {
  it('splits rows and cells', () => {
    expect(parseCsv('이름,값\n가,1\n나,2\n')).toEqual([['이름', '값'], ['가', '1'], ['나', '2']])
    expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('handles quoted cells with commas, quotes and newlines', () => {
    expect(parseCsv('"a,b","he said ""hi""","two\nlines"\nx,,')).toEqual([
      ['a,b', 'he said "hi"', 'two\nlines'],
      ['x', '', ''],
    ])
  })

  it('an empty file has no rows', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n')).toEqual([['']])
  })
})
