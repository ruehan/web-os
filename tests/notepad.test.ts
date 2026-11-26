// 메모장(programs/notepad): 창을 직접 그리는 프로세스. 실제 바이너리를 커널 위에서 돌려,
// 화면 쪽이 받는 그리기 명령과 파일에 남는 결과를 확인한다.
// 단추와 항목은 그리기 명령에 든 "자리 알림"(region)의 이름으로 찾아 그 가운데를 누른다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KernelEvent } from '../src/kernel/abi.ts'
import { GuiEvent, Mod, decodeDrawList, decodeMeasure, encodeEvent, encodePointer, keyCode, type DrawOp } from '../src/kernel/gui.ts'
import { boot } from './host.ts'

type Host = ReturnType<typeof boot>
let host: Host

beforeEach(() => {
  host = boot()
})
afterEach(() => host.shutdown())

type Of<T extends KernelEvent['type']> = Extract<KernelEvent, { type: T }>
type Op<T extends DrawOp['op']> = Extract<DrawOp, { op: T }>
const all = <T extends KernelEvent['type']>(type: T, pid: number) =>
  host.events.filter((e): e is Of<T> => e.type === type && 'pid' in e && e.pid === pid)
const utf8 = (text: string) => new TextEncoder().encode(text)
const VAULT = '/home/guest/notes'
const file = (path: string) => new TextDecoder().decode(host.kernel.fs.readFile(`${VAULT}/${path}`))
const exists = (path: string) => {
  try {
    host.kernel.fs.lookup(host.kernel.fs.root, `${VAULT}/${path}`)
    return true
  } catch {
    return false
  }
}
const write = (path: string, text: string) => {
  host.kernel.fs.mkdirp(`${VAULT}/${path}`.slice(0, `${VAULT}/${path}`.lastIndexOf('/')))
  host.kernel.fs.writeFile(`${VAULT}/${path}`, utf8(text))
}

// 입력 칸의 번호 (programs/notepad/src/main.rs)
const EDITOR = 1
const TITLE = 2
const SEARCH = 3
const DIR_NAME = 4

async function openNotepad(...args: string[]) {
  const pid = host.kernel.launch('/bin/notepad', ['notepad', ...args])
  await host.until(() => all('gui-draw', pid).length > 0, 'first frame')
  const frames = () => all('gui-draw', pid).map((e) => decodeDrawList(e.data))
  const latest = () => frames().at(-1)!
  const of = <T extends DrawOp['op']>(op: T) => latest().filter((o): o is Op<T> => o.op === op)
  const texts = () => of('text').map((op) => op.text)
  const region = (label: string, role?: Op<'region'>['role']) => of('region').find((r) => r.label === label && (!role || r.role === role))
  const send = (kind: number, a = 0, b = 0, c = 0) => host.kernel.guiEvent(pid, encodeEvent(kind, a, b, c))
  function point(label: string, button: number, clicks: number) {
    const r = region(label)
    if (!r) throw new Error(`no "${label}" on screen; there are: ${of('region').map((x) => x.label).join(', ')}`)
    const [x, y] = [r.x + r.w / 2, r.y + r.h / 2]
    host.kernel.guiEvent(pid, encodePointer(GuiEvent.pointerDown, x, y, button + 256 * (clicks - 1)))
    host.kernel.guiEvent(pid, encodePointer(GuiEvent.pointerUp, x, y))
  }
  /** 가장 최근에 띄워 달라고 한 메뉴 */
  const menu = () => frames().flatMap((ops) => ops.filter((o): o is Op<'menu'> => o.op === 'menu')).at(-1)
  return {
    pid,
    latest,
    texts,
    region,
    regions: (role: Op<'region'>['role']) => of('region').filter((r) => r.role === role).map((r) => r.label),
    field: (id: number) => of('field').find((f) => f.id === id),
    /** 프로그램이 입력 칸에 넣은 글 (가장 최근 것) */
    shown: (field = EDITOR) => {
      const set = all('gui-text', pid).findLast((e) => e.field === field)
      return set && new TextDecoder().decode(set.data)
    },
    press: (label: string) => point(label, 0, 1),
    doublePress: (label: string) => (point(label, 0, 1), point(label, 0, 2)),
    middlePress: (label: string) => point(label, 1, 1),
    rightPress: (label: string) => point(label, 2, 1),
    menu: () => menu()?.items.map((item) => (item.separator ? '---' : item.label)),
    /** 떠 있는 메뉴에서 한 줄을 고른다. */
    choose(label: string) {
      const at = menu()!.items.findIndex((item) => item.label === label)
      if (at < 0) throw new Error(`no "${label}" in the menu`)
      send(GuiEvent.menu, at)
    },
    wheel: (x: number, y: number, dy: number) => host.kernel.guiEvent(pid, encodePointer(GuiEvent.wheel, x, y, dy)),
    send,
    /** 사용자가 입력 칸의 글을 고친 것처럼 한다. */
    type: (text: string, field = EDITOR) => host.kernel.guiText(pid, field, utf8(text)),
    /** 한 줄짜리 칸에 커서를 두고 글을 친 뒤 Enter를 누른다. */
    enter(field: number, text: string) {
      send(GuiEvent.fieldFocus, field, 1)
      host.kernel.guiText(pid, field, utf8(text))
      send(GuiEvent.key, keyCode('Enter'))
    },
    see: (text: string) => host.until(() => texts().some((t) => t.includes(text)), `"${text}" on screen`),
    until: (check: () => unknown, what: string) => host.until(() => !!check(), what),
  }
}

describe('notepad', () => {
  it('shows the vault as a tree: folders first, then notes by name', async () => {
    write('장보기.md', '우유')
    write('회의록.txt', '안건')
    write('프로젝트/계획.md', '할 일')
    write('프로젝트/깊은/메모 10.md', '')
    write('프로젝트/깊은/메모 2.md', '')
    write('.숨김.md', '')
    write('attachments/그림.png', '')
    const pad = await openNotepad()
    expect(all('gui-open', pad.pid)[0]).toMatchObject({ title: '메모장', w: 900, h: 580 })
    // 그림 폴더는 접혀 있다. 한글이 영문보다 먼저, 숫자는 수로 견준다.
    expect(pad.regions('treeitem')).toEqual(['프로젝트', '깊은', '메모 2', '메모 10', '계획', 'attachments', '장보기', '회의록'])
    // .md가 아닌 메모는 확장자가 옆에 붙는다.
    expect(pad.latest()).toContainEqual(expect.objectContaining({ op: 'text', text: 'txt', mono: true }))
    // 처음에는 첫 메모가 열려 있다.
    expect(pad.region('장보기', 'treeitem')).toMatchObject({ on: true })
    expect(pad.regions('tab')).toEqual(['장보기'])
    expect(pad.shown()).toBe('우유')
    expect(pad.shown(TITLE)).toBe('장보기')
    expect(pad.texts()).toContain('notes/장보기.md · 저장됨')
    expect(pad.texts()).toContain('2자')
  })

  it('opens a note into real input fields: the body and the title', async () => {
    write('가.md', '')
    write('장보기.md', '- 우유\n- 빵')
    const pad = await openNotepad()
    pad.press('장보기')
    await pad.until(() => pad.region('장보기', 'tab')?.on, 'the note')
    expect(pad.shown()).toBe('- 우유\n- 빵')
    // 글의 내용은 그리기 명령에 들어 있지 않다. 칸의 자리와 모양만 있다.
    expect(pad.field(EDITOR)).toEqual({
      op: 'field', id: EDITOR, x: 264, y: 93, w: 622, h: 439, size: 13, color: '#191a20', background: '#ffffff',
      multiline: true, mono: true, bold: false, focus: true, select: false, label: '메모 내용', placeholder: '',
    })
    expect(pad.field(TITLE)).toMatchObject({ multiline: false, bold: true, size: 15, label: '제목', focus: false })
    expect(pad.field(SEARCH)).toMatchObject({ placeholder: '메모 찾기' })
    expect(pad.regions('tab')).toEqual(['가', '장보기'])
    expect(pad.region('장보기', 'tab')).toMatchObject({ on: true })
  })

  it('saves what is typed after a pause, and says so', async () => {
    write('일기.md', '')
    const pad = await openNotepad('일기.md')
    await pad.see('저장됨')
    pad.type('오늘은')
    await pad.see('저장 중…')
    expect(file('일기.md')).toBe('')
    pad.type('오늘은 맑음')
    await host.until(() => file('일기.md') === '오늘은 맑음', 'the file to be written')
    await pad.see('저장됨')
    expect(pad.texts()).toContain('6자')
    // 커서를 주는 것은 칸이 처음 나타날 때 한 번뿐이다 (칠 때마다 커서를 빼앗지 않는다).
    expect(pad.field(EDITOR)!.focus).toBe(false)
  })

  it('saves at once on Ctrl+S, when switching notes, and when closing', async () => {
    write('가.md', 'A')
    write('나.md', 'B')
    const pad = await openNotepad('가.md')
    await pad.see('저장됨')
    pad.type('A 고침')
    pad.send(GuiEvent.key, keyCode('s'), Mod.ctrl)
    await host.until(() => file('가.md') === 'A 고침', 'save on Ctrl+S')

    pad.type('A 다시 고침')
    pad.press('나')
    await host.until(() => pad.shown() === 'B', 'the other note')
    expect(file('가.md')).toBe('A 다시 고침')

    pad.type('B 고침')
    pad.send(GuiEvent.close)
    await host.until(() => all('exit', pad.pid).length > 0, 'exit')
    expect(file('나.md')).toBe('B 고침')
  })

  it('reads a long note in pieces without losing any of it', async () => {
    write('긴 글.md', '')
    const pad = await openNotepad('긴 글.md')
    await pad.see('저장됨')
    // 응답 한 번에 실을 수 있는 크기(64KB)보다 훨씬 긴 글
    const long = Array.from({ length: 30_000 }, (_, i) => `${i}번째 줄입니다`).join('\n')
    expect(utf8(long).length).toBeGreaterThan(500_000)
    pad.type(long)
    await host.until(() => file('긴 글.md').length === long.length, 'the long note to be saved', 8000)
    expect(file('긴 글.md')).toBe(long)
  })

  it('keeps only the latest text when typing outpaces the program', async () => {
    write('빠름.md', '')
    const pad = await openNotepad('빠름.md')
    await pad.see('저장됨')
    for (let i = 1; i <= 200; i++) pad.type('가'.repeat(i))
    await host.until(() => file('빠름.md') === '가'.repeat(200), 'the final text')
  })

  it('creates a note with a free name and puts the cursor on its title', async () => {
    write('제목 없음.md', '이미 있음')
    const pad = await openNotepad()
    pad.press('새 메모')
    await pad.until(() => pad.region('제목 없음 2', 'tab')?.on, 'the new note')
    expect(file('제목 없음 2.md')).toBe('')
    expect(file('제목 없음.md')).toBe('이미 있음')
    expect(pad.shown()).toBe('')
    // 새 메모는 제목부터 정하도록, 제목을 통째로 고른 채 커서를 준다.
    expect(pad.field(TITLE)).toMatchObject({ focus: true, select: true })

    // 제목을 치고 Enter를 누르면 파일 이름이 바뀌고 커서가 본문으로 간다.
    pad.enter(TITLE, '여행 계획')
    await pad.until(() => exists('여행 계획.md'), 'the renamed file')
    expect(exists('제목 없음 2.md')).toBe(false)
    await pad.until(() => pad.region('여행 계획', 'tab')?.on, 'the tab to follow')
    expect(pad.texts()).toContain('notes/여행 계획.md · 저장됨')
  })

  it('makes new notes in the chosen format', async () => {
    const pad = await openNotepad()
    expect(pad.texts()).toContain('“새 메모”를 눌러 적기 시작하세요.')
    pad.press('새 메모의 형식: 마크다운 (.md)')
    await pad.until(() => pad.menu(), 'the format menu')
    expect(pad.menu()).toEqual(['마크다운 (.md)', '텍스트 (.txt)'])
    pad.choose('텍스트 (.txt)')
    await pad.until(() => pad.region('새 메모의 형식: 텍스트 (.txt)'), 'the chosen format')
    pad.press('새 메모')
    await pad.until(() => exists('제목 없음.txt'), 'a text note')
  })

  it('renames a note from its title, fixing links in other notes', async () => {
    write('가.md', '[[나]]와 [[나|이렇게]] 참고')
    write('나.md', '내용')
    const pad = await openNotepad('나.md')
    pad.enter(TITLE, '다')
    await pad.until(() => exists('다.md'), 'the renamed file')
    expect(file('다.md')).toBe('내용')
    expect(exists('나.md')).toBe(false)
    await pad.until(() => file('가.md') === '[[다]]와 [[다|이렇게]] 참고', 'the links to follow')

    // 쓸 수 없는 이름은 이유를 알리고 그대로 둔다.
    pad.enter(TITLE, '다/라')
    await pad.see('이름에는 / 와 \\ 를 쓸 수 없습니다.')
    expect(pad.shown(TITLE)).toBe('다')
    pad.enter(TITLE, '가')
    await pad.see('같은 이름의 파일이 이미 있습니다.')
    // 칸을 벗어나기만 해도 바뀐다.
    pad.type('마', TITLE)
    pad.send(GuiEvent.fieldFocus, TITLE, 0)
    await pad.until(() => exists('마.md'), 'rename on blur')
  })

  it('folds folders, and makes and renames them', async () => {
    write('프로젝트/계획.md', '')
    write('장보기.md', '')
    const pad = await openNotepad()
    pad.press('프로젝트')
    await pad.until(() => !pad.region('계획'), 'the folder to fold')
    // 고른 폴더 안에 새 폴더가 생기고(접혀 있었으면 펼쳐진다), 곧바로 이름을 고칠 수 있다.
    pad.press('새 폴더')
    await pad.until(() => pad.field(DIR_NAME), 'the name field')
    expect(pad.field(DIR_NAME)).toMatchObject({ focus: true, select: true, label: '폴더 이름' })
    expect(pad.shown(DIR_NAME)).toBe('새 폴더')
    expect(pad.region('계획')).toBeDefined()
    pad.enter(DIR_NAME, '자료')
    await pad.until(() => exists('프로젝트/자료'), 'the renamed folder')
    expect(exists('프로젝트/새 폴더')).toBe(false)
    await pad.until(() => pad.region('자료'), 'the new name')
    expect(pad.regions('treeitem')).toEqual(['프로젝트', '자료', '계획', '장보기'])

    // 두 번 누르면 이름을 바꾼다. 안에 열어 둔 메모가 있으면 그 탭도 따라간다.
    pad.press('계획')
    await pad.see('notes/프로젝트/계획.md')
    pad.doublePress('프로젝트')
    await pad.until(() => pad.field(DIR_NAME), 'the name field')
    pad.enter(DIR_NAME, '일')
    await pad.see('notes/일/계획.md')
    expect(exists('일/자료')).toBe(true)
    // Esc는 바꾸지 않고 닫는다.
    pad.doublePress('일')
    await pad.until(() => pad.field(DIR_NAME), 'the name field')
    pad.type('버림', DIR_NAME)
    pad.send(GuiEvent.key, keyCode('Escape'))
    await pad.until(() => !pad.field(DIR_NAME), 'the field to go')
    expect(exists('일')).toBe(true)
  })

  it('asks before deleting, and closes the tab of what was deleted', async () => {
    write('가.md', '')
    write('나.md', '')
    write('폴더/다.md', '')
    const pad = await openNotepad('나.md')
    pad.press('삭제')
    await pad.see('“나.md” 메모를 지울까요?')
    pad.press('취소')
    await pad.until(() => !pad.region('지우기'), 'the question to go')
    expect(exists('나.md')).toBe(true)
    pad.press('삭제')
    await pad.until(() => pad.region('지우기'), 'the question')
    pad.press('지우기')
    await pad.until(() => !exists('나.md'), 'the note to be deleted')
    await pad.until(() => !pad.region('나', 'tab'), 'its tab to close')

    // 폴더는 고르면 나오는 × 단추로 지운다.
    pad.press('다')
    pad.press('폴더')
    await pad.until(() => pad.region('폴더 폴더 지우기'), 'the delete button')
    pad.press('폴더 폴더 지우기')
    await pad.see('“폴더” 폴더와 그 안의 모든 것을 지울까요?')
    pad.press('지우기')
    await pad.until(() => !exists('폴더'), 'the folder to be deleted')
    await pad.until(() => !pad.regions('tab').includes('다'), 'its tab to close')
  })

  it('keeps tabs for opened notes and walks back and forth through them', async () => {
    for (const name of ['가', '나', '다']) write(`${name}.md`, name)
    const pad = await openNotepad('가.md')
    pad.press('나')
    pad.press('다')
    await pad.until(() => pad.region('다', 'tab')?.on, 'the third note')
    expect(pad.regions('tab')).toEqual(['가', '나', '다'])
    expect(pad.region('앞으로')).toMatchObject({ disabled: true })

    pad.press('뒤로')
    await pad.until(() => pad.region('나', 'tab')?.on, 'back')
    pad.send(GuiEvent.key, keyCode('ArrowLeft'), Mod.ctrl | Mod.alt)
    await pad.until(() => pad.region('가', 'tab')?.on, 'back again')
    expect(pad.region('뒤로')).toMatchObject({ disabled: true })
    pad.press('앞으로')
    await pad.until(() => pad.region('나', 'tab')?.on, 'forward')

    // 지금 탭을 닫으면 오른쪽 탭으로 간다. 가운데 단추로도 닫힌다.
    pad.press('나 탭 닫기')
    await pad.until(() => pad.region('다', 'tab')?.on, 'the tab to the right')
    pad.middlePress('가')
    await pad.until(() => pad.regions('tab').length === 1, 'one tab left')
    pad.press('다 탭 닫기')
    await pad.see('“새 메모”를 눌러 적기 시작하세요.')
    expect(pad.field(EDITOR)).toBeUndefined()

    // 탭 메뉴
    pad.press('가')
    pad.press('나')
    await pad.until(() => pad.regions('tab').length === 2, 'two tabs')
    pad.rightPress('가')
    await pad.until(() => pad.menu(), 'the tab menu')
    expect(pad.menu()).toEqual(['탭 닫기', '다른 탭 모두 닫기'])
    pad.choose('다른 탭 모두 닫기')
    await pad.until(() => pad.regions('tab').join() === '가', 'only that tab')
  })

  it('finds notes by their text or name', async () => {
    write('장보기.md', '우유\n달걀 한 판')
    write('요리/달걀찜.md', '재료\n')
    write('회의록.md', '안건')
    const pad = await openNotepad()
    pad.type('달걀', SEARCH)
    await pad.until(() => pad.regions('option').length, 'results')
    expect(pad.regions('option')).toEqual(['달걀찜', '장보기'])
    expect(pad.regions('treeitem')).toEqual([])
    // 찾은 글이 든 줄을 함께 보여 준다. 이름만 맞으면 첫 줄을.
    expect(pad.texts()).toEqual(expect.arrayContaining(['달걀 한 판', '재료']))
    pad.press('달걀찜')
    await pad.see('notes/요리/달걀찜.md')
    pad.type('없는 말', SEARCH)
    await pad.see('찾는 내용이 든 메모가 없습니다.')
    pad.type('', SEARCH)
    await pad.until(() => pad.regions('treeitem').length === 4, 'the tree to come back')
  })

  it('moves a note to another folder from its menu, fixing links that spell out the folder', async () => {
    write('가.md', '[[폴더/나]]와 [[나]]')
    write('폴더/나.md', '')
    write('다른/안쪽/x.md', '')
    const pad = await openNotepad('가.md')
    pad.rightPress('나')
    await pad.until(() => pad.menu(), 'the menu')
    expect(pad.menu()).toEqual(['열기', '이름 바꾸기', '다른 폴더로 옮기기…', '---', '삭제…'])
    pad.choose('다른 폴더로 옮기기…')
    // 지금 있는 폴더는 빠진다.
    await pad.until(() => pad.menu()?.[0] === '보관함 맨 위', 'the folders')
    expect(pad.menu()).toEqual(['보관함 맨 위', '다른', '다른/안쪽'])
    pad.choose('다른/안쪽')
    await pad.until(() => exists('다른/안쪽/나.md'), 'the note to move')
    expect(exists('폴더/나.md')).toBe(false)
    await pad.until(() => file('가.md') === '[[다른/안쪽/나]]와 [[나]]', 'the link to follow')
    expect(pad.shown()).toBe('[[다른/안쪽/나]]와 [[나]]')

    // 폴더의 메뉴: 그 안에 만든다.
    pad.rightPress('폴더')
    await pad.until(() => pad.menu()?.[0] === '여기에 새 메모', 'the folder menu')
    expect(pad.menu()).toEqual(['여기에 새 메모', '여기에 새 폴더', '---', '이름 바꾸기', '다른 폴더로 옮기기…', '삭제…'])
    pad.choose('여기에 새 메모')
    await pad.until(() => exists('폴더/제목 없음.md'), 'a note in that folder')
    // 고르지 않고 닫으면 아무 일도 없다.
    pad.rightPress('폴더')
    pad.send(GuiEvent.menu, -1)
    await new Promise((r) => setTimeout(r, 60))
    expect(exists('폴더/제목 없음 2.md')).toBe(false)
  })

  it('scrolls a long tree with the wheel, drawing only the visible rows', async () => {
    for (let i = 1; i <= 60; i++) write(`메모 ${String(i).padStart(2, '0')}.md`, '')
    const pad = await openNotepad()
    const rows = () => pad.regions('treeitem')
    // 높이 476인 목록에 28짜리 줄: 17줄이 걸친다.
    expect(rows()).toHaveLength(17)
    expect(rows()[0]).toBe('메모 01')
    expect(pad.latest()).toContainEqual({ op: 'clip', x: 0, y: 104, w: 249, h: 476 })

    pad.wheel(60, 300, 280)
    await pad.until(() => rows()[0] === '메모 11', 'ten rows down')
    // 끝을 넘겨 밀어도 마지막 줄에서 멈춘다.
    pad.wheel(60, 300, 99999)
    await pad.until(() => rows().at(-1) === '메모 60', 'the end')
    const last = pad.region('메모 60')!
    expect(last.y + last.h).toBe(580 - 6)
    // 밀린 만큼 누르는 자리도 옮겨진다.
    pad.press('메모 60')
    await pad.see('notes/메모 60.md')
    // 글 쪽에서 굴린 휠은 목록을 움직이지 않는다 (입력 칸이 알아서 스크롤한다).
    const before = all('gui-draw', pad.pid).length
    pad.wheel(500, 300, -300)
    await new Promise((r) => setTimeout(r, 80))
    expect(all('gui-draw', pad.pid)).toHaveLength(before)
  })

  it('asks the display how wide text is, and shortens names that do not fit', async () => {
    write('아주아주아주아주아주아주아주아주아주아주 긴 이름의 메모.md', '')
    write('짧음.md', '')
    const pad = await openNotepad('짧음.md')
    const asked = all('gui-measure', pad.pid).map((e) => decodeMeasure(e.data))
    expect(asked).toContainEqual({ size: 12, bold: false, mono: false, italic: false, texts: ['새 메모'] })
    // 테스트의 화면은 한글 한 글자를 글자 크기만큼(13)으로 잰다.
    const shortened = pad.texts().find((t) => t.startsWith('아주'))!
    expect(shortened.endsWith('…')).toBe(true)
    expect([...shortened].length).toBeLessThan(16)
    // 줄여 그려도 이름은 온전히 알린다.
    expect(pad.region('아주아주아주아주아주아주아주아주아주아주 긴 이름의 메모')).toBeDefined()
    // 단추의 폭은 잰 글의 폭에 맞춰진다: 글 3글자 반(42) + 여백 20.
    expect(pad.region('새 메모')).toMatchObject({ x: 8, y: 6, w: 62, h: 26, role: 'button' })

    // 같은 글은 다시 묻지 않는다.
    const count = all('gui-measure', pad.pid).length
    pad.send(GuiEvent.resize, 1000, 600, 0)
    await pad.until(() => pad.field(EDITOR)?.w === 1000 - 250 - 28, 'redraw')
    expect(all('gui-measure', pad.pid)).toHaveLength(count)
  })

  it('highlights what the pointer is over, redrawing only when that changes', async () => {
    write('가.md', '')
    write('나.md', '')
    const pad = await openNotepad('가.md')
    const row = pad.region('나', 'treeitem')!
    const lit = () => pad.latest().some((op) => op.op === 'rect' && op.x === row.x && op.y === row.y && op.color === '#1416280f')
    expect(lit()).toBe(false)
    host.kernel.guiEvent(pad.pid, encodePointer(GuiEvent.pointerMove, row.x + 30, row.y + 5))
    await pad.until(lit, 'the row to light up')
    const count = all('gui-draw', pad.pid).length
    host.kernel.guiEvent(pad.pid, encodePointer(GuiEvent.pointerMove, row.x + 40, row.y + 9))
    await new Promise((r) => setTimeout(r, 60))
    expect(all('gui-draw', pad.pid)).toHaveLength(count)
    pad.send(GuiEvent.pointerLeave)
    await pad.until(() => !lit(), 'the light to go')
  })

  it('picks up changes made elsewhere when its window comes back to the front', async () => {
    write('공유.md', '처음')
    const pad = await openNotepad('공유.md')
    await pad.see('저장됨')
    await host.sh('echo 터미널에서 > notes/공유.md; echo x > notes/새로.md')
    pad.send(GuiEvent.focus, 1)
    await pad.until(() => pad.region('새로'), 'the new file')
    expect(pad.shown()).toBe('터미널에서\n')

    // 치고 있던 것이 있으면 덮어쓰지 않는다.
    pad.type('내가 치는 중')
    await host.sh('echo 다른 내용 > notes/공유.md')
    pad.send(GuiEvent.focus, 1)
    await host.until(() => file('공유.md') === '내가 치는 중', 'my text to win')
    expect(pad.shown()).toBe('터미널에서\n')
  })

  it('saves at once when its window loses focus', async () => {
    write('초점.md', '')
    const pad = await openNotepad('초점.md')
    await pad.see('저장됨')
    pad.type('넘어가기 전')
    pad.send(GuiEvent.focus, 0)
    // 기다림 없이 바로 저장된다.
    await host.until(() => file('초점.md') === '넘어가기 전', 'save on blur', 300)
  })

  it('reports a file that cannot be opened instead of crashing', async () => {
    const pad = await openNotepad('없는 파일.md')
    expect(pad.texts()).toContain('그런 파일이 없습니다: 없는 파일.md')
    expect(host.kernel.pids()).toContain(pad.pid)
  })

  it('its field calls show up in the system call trace', async () => {
    write('추적.md', '내용')
    host.kernel.setTracing(true)
    const pad = await openNotepad('추적.md')
    pad.type('고침')
    await host.until(() => file('추적.md') === '고침', 'save')
    pad.send(GuiEvent.close)
    await host.until(() => host.events.some((e) => e.type === 'trace' && e.records.some((r) => r.pid === pad.pid && r.call === 'exit')), 'trace')
    const shown = host.events.flatMap((e) => (e.type === 'trace' ? e.records : [])).filter((r) => r.pid === pad.pid).map((r) => `${r.call}(${r.args}) ${r.result}`)
    expect(shown).toContain('guisettext(1, "내용", 6) = 0')
    expect(shown).toContain('guisettext(2, "추적", 6) = 0')
    // 요청: 글자 크기와 꾸밈 5바이트 + 길이 4바이트 + "새 메모" 10바이트
    expect(shown).toContain('guimeasure(19 bytes) = 1 widths')
    expect(shown).toContain('guievent() = input(1, 6, 0)')
    expect(shown).toContain('guitext(1, 0, 32768) = 6')
  })
})
