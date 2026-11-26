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
const QUICK = 5

async function openNotepad(...args: string[]) {
  const pid = host.kernel.launch('/bin/notepad', ['notepad', ...args])
  await host.until(() => all('gui-draw', pid).length > 0, 'first frame')
  const frames = () => all('gui-draw', pid).map((e) => decodeDrawList(e.data))
  const latest = () => frames().at(-1)!
  const of = <T extends DrawOp['op']>(op: T) => latest().filter((o): o is Op<T> => o.op === op)
  const texts = () => of('text').map((op) => op.text)
  const region = (label: string, role?: Op<'region'>['role']) => of('region').find((r) => r.label === label && (!role || r.role === role))
  const send = (kind: number, a = 0, b = 0, c = 0) => host.kernel.guiEvent(pid, encodeEvent(kind, a, b, c))
  function point(label: string, button: number, clicks: number, role?: Op<'region'>['role']) {
    const r = region(label, role)
    if (!r) throw new Error(`no "${label}" on screen; there are: ${of('region').map((x) => x.label).join(', ')}`)
    const [x, y] = [r.x + r.w / 2, r.y + r.h / 2]
    host.kernel.guiEvent(pid, encodePointer(GuiEvent.pointerDown, x, y, button + 256 * (clicks - 1)))
    host.kernel.guiEvent(pid, encodePointer(GuiEvent.pointerUp, x, y))
  }
  /** 이미 고른 메뉴가 든 그림들의 수. 그 뒤의 그림에서만 새 메뉴를 찾는다. */
  let answered = 0
  /** 가장 최근에 띄워 달라고 한, 아직 고르지 않은 메뉴 */
  const menu = () => frames().slice(answered).flatMap((ops) => ops.filter((o): o is Op<'menu'> => o.op === 'menu')).at(-1)
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
    press: (label: string, role?: Op<'region'>['role']) => point(label, 0, 1, role),
    doublePress: (label: string) => (point(label, 0, 1), point(label, 0, 2)),
    middlePress: (label: string) => point(label, 1, 1),
    rightPress: (label: string) => point(label, 2, 1),
    menu: () => menu()?.items.map((item) => (item.separator ? '---' : item.label)),
    /** 떠 있는 메뉴에서 한 줄을 고른다. */
    choose(label: string) {
      const at = menu()!.items.findIndex((item) => item.label === label)
      if (at < 0) throw new Error(`no "${label}" in the menu`)
      answered = frames().length
      send(GuiEvent.menu, at)
    },
    /** 포인터 이벤트 하나를 그대로 보낸다 (끌기처럼 누르고 떼는 사이가 있는 동작에 쓴다). */
    pointer: (kind: number, x: number, y: number, c = 0) => host.kernel.guiEvent(pid, encodePointer(kind, x, y, c)),
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
      op: 'field', id: EDITOR, x: 264, y: 95, w: 622, h: 437, size: 13, color: '#191a20', background: '#ffffff',
      multiline: true, mono: true, bold: false, focus: true, select: false, keys: true, grabEnter: false, where: false, label: '메모 내용', placeholder: '',
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
    expect(pad.menu()).toEqual(['탭 닫기', '다른 탭 모두 닫기', '---', '옆에 열기'])
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
    expect(pad.menu()).toEqual(['열기', '옆에 열기', '이름 바꾸기', '다른 폴더로 옮기기…', '---', '삭제…'])
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

  it('draws markdown beside the editor or instead of it', async () => {
    write('글.md', '# 큰 제목\n\n**굵게** 그리고 `코드`\n\n- 하나\n- 둘\n\n| 이름 | 값 |\n|---|---|\n| 가 | 1 |')
    write('그냥.txt', '# 제목 아님')
    const pad = await openNotepad('글.md')
    // 왼쪽의 목차에도 제목이 나오므로, 본문 쪽(x > 250)의 것만 본다.
    const text = (t: string) => pad.latest().find((op) => op.op === 'text' && op.text === t && op.x > 250) as Extract<DrawOp, { op: 'text' }> | undefined
    // 처음에는 편집만: 글의 내용은 그려지지 않는다.
    expect(pad.region('편집')).toMatchObject({ on: true })
    expect(text('큰 제목')).toBeUndefined()

    pad.press('나란히')
    await pad.until(() => text('큰 제목'), 'the preview')
    // 본문(폭 650)을 반으로 나눠 왼쪽에 입력 칸, 오른쪽에 미리보기.
    expect(pad.field(EDITOR)).toMatchObject({ x: 264, w: 325 - 28 })
    expect(text('큰 제목')).toMatchObject({ x: 250 + 325 + 20, size: 22, bold: true })
    expect(text('굵게')).toMatchObject({ bold: true, size: 13 })
    expect(text('코드')).toMatchObject({ mono: true })
    expect(pad.texts()).toEqual(expect.arrayContaining(['하나', '둘', '이름', '값', '가', '1']))

    pad.press('읽기')
    await pad.until(() => !pad.field(EDITOR), 'the editor to go')
    expect(text('큰 제목')).toMatchObject({ x: 250 + 20 })
    // 고친 글은 미리보기에 바로 반영된다.
    pad.press('나란히')
    await pad.until(() => pad.field(EDITOR), 'the editor')
    pad.type('## 바뀐 제목')
    await pad.until(() => text('바뀐 제목'), 'the new text')
    expect(text('바뀐 제목')).toMatchObject({ size: 18 })

    // 마크다운이 아닌 메모에는 보기 방식이 없다.
    pad.press('그냥')
    await pad.see('notes/그냥.txt')
    expect(pad.region('나란히')).toBeUndefined()
    expect(pad.field(EDITOR)).toMatchObject({ w: 622 })
  })

  it('wraps long text to the width and scrolls the preview', async () => {
    const words = Array.from({ length: 80 }, (_, i) => `낱말${i}`).join(' ')
    write('긴.md', `${words}\n\n${Array.from({ length: 60 }, (_, i) => `줄 ${i}`).join('\n\n')}`)
    const pad = await openNotepad('긴.md')
    pad.press('읽기')
    await pad.until(() => !pad.field(EDITOR), 'the preview')
    const body = () => pad.latest().filter((op): op is Extract<DrawOp, { op: 'text' }> => op.op === 'text' && op.x >= 270 && op.size === 13 && op.text.includes('낱'))
    const ys = () => [...new Set(body().map((op) => op.y))]
    // 폭 610에 다 들어가지 않으므로 여러 줄로 나뉘고, 줄 사이는 22다.
    expect(ys().length).toBeGreaterThan(3)
    expect(ys()[1]! - ys()[0]!).toBe(22)
    // 어느 줄도 오른쪽 여백을 넘지 않는다 (테스트의 화면은 한글 13, 그 밖의 글자 6.5로 잰다).
    const width = (t: string) => [...t].reduce((n, ch) => n + (ch.codePointAt(0)! >= 0x1100 ? 13 : 6.5), 0)
    for (const op of body()) expect(op.x + width(op.text.trimEnd())).toBeLessThanOrEqual(900 - 20)
    // 보이지 않는 아래쪽은 그리지 않는다. 휠로 밀면 나온다.
    expect(pad.texts()).not.toContain('줄 59')
    pad.wheel(600, 300, 99999)
    await pad.see('줄 59')
    expect(pad.texts()).not.toContain('줄 0')
  })

  it('follows links in the preview, creating the note when it does not exist yet', async () => {
    write('일/계획.md', '[[회의록]]과 [[새 생각]] 그리고 [[회의록|이름 바꿔 보기]]')
    write('회의록.md', '안건')
    const pad = await openNotepad('일/계획.md')
    pad.press('읽기')
    await pad.until(() => pad.regions('link').length, 'the links')
    expect(pad.regions('link')).toEqual(['회의록', '새 생각', '이름 바꿔 보기'])
    // 없는 메모의 링크는 흐리게 보인다.
    const ink = (t: string) => (pad.latest().find((op) => op.op === 'text' && op.text === t) as Extract<DrawOp, { op: 'text' }>).color
    expect(ink('회의록')).toBe('#4553d6')
    expect(ink('새 생각')).toBe('#6b6e7b')

    pad.press('이름 바꿔 보기')
    await pad.see('notes/회의록.md')
    pad.press('뒤로')
    await pad.until(() => pad.region('새 생각'), 'back to the plan')
    // 없는 메모는 지금 메모와 같은 폴더에 만들어진다.
    pad.press('새 생각')
    await pad.until(() => exists('일/새 생각.md'), 'the new note')
    await pad.see('notes/일/새 생각.md')
  })

  it('lists the notes that link here, and opens them', async () => {
    write('회의록.md', '안건')
    write('계획.md', '할 일\n자세한 것은 [[회의록]] 참고')
    write('일기.md', '오늘은 [[회의록|회의]]를 했다')
    write('무관.md', '[[다른 것]]')
    const pad = await openNotepad('회의록.md')
    pad.press('이 메모를 가리키는 메모 2개')
    await pad.until(() => pad.region('계획', 'link'), 'the list')
    expect(pad.regions('link')).toEqual(['계획', '일기'])
    // 링크가 든 줄을 함께 보여 준다.
    expect(pad.texts()).toEqual(expect.arrayContaining(['자세한 것은 [[회의록]] 참고', '오늘은 [[회의록|회의]]를 했다']))
    pad.press('일기')
    await pad.see('notes/일기.md')
    expect(pad.region('이 메모를 가리키는 메모 2개')).toBeUndefined()
  })

  it('checks off tasks from the preview by rewriting the note', async () => {
    write('할 일.md', '- [ ] 우유\n  - [x] 빵\n- 그냥')
    write('모음.md', '![[할 일]]')
    const pad = await openNotepad('할 일.md')
    pad.press('나란히')
    await pad.until(() => pad.regions('checkbox').length === 2, 'the checkboxes')
    expect(pad.latest().filter((op) => op.op === 'region' && op.role === 'checkbox').map((r) => (r as { on: boolean }).on)).toEqual([false, true])
    // 끝낸 일은 줄을 긋는다.
    expect(pad.latest()).toContainEqual(expect.objectContaining({ op: 'text', text: '빵', strike: true }))
    pad.press('완료')
    await host.until(() => file('할 일.md') === '- [x] 우유\n  - [x] 빵\n- 그냥', 'the file to change')
    expect(pad.shown()).toBe('- [x] 우유\n  - [x] 빵\n- 그냥')

    // 다른 메모에 넣어져 보이는 글에서는 누를 수 없다.
    pad.press('모음')
    await pad.until(() => pad.region('할 일', 'link'), 'the embedded note')
    expect(pad.texts()).toEqual(expect.arrayContaining(['우유', '빵', '그냥']))
    expect(pad.latest().filter((op) => op.op === 'region' && op.role === 'checkbox')).toMatchObject([{ disabled: true }, { disabled: true }])
  })

  it('shows the outline and tags under the tree', async () => {
    write('글.md', '# 하나\n\n내용 #업무\n\n## 둘\n\n### 셋 #개인')
    write('다른.md', '#업무 만')
    write('없음.md', '태그 없음')
    const pad = await openNotepad('글.md')
    // 목차는 펼쳐져 있다. 누르면 그 줄로 커서를 옮긴다 (자리는 바이트 위치).
    expect(pad.region('목차')).toMatchObject({ on: true })
    pad.press('둘')
    await pad.until(() => pad.latest().some((op) => op.op === 'select'), 'the cursor to move')
    const at = utf8('# 하나\n\n내용 #업무\n\n').length
    expect(pad.latest()).toContainEqual({ op: 'select', id: EDITOR, start: at, end: at })
    // 읽기에서는 그 제목이 위로 오도록 민다.
    write('글.md', `# 하나\n\n${'줄\n\n'.repeat(60)}## 둘\n\n${'끝\n\n'.repeat(40)}`)
    pad.send(GuiEvent.focus, 1)
    pad.press('읽기')
    await pad.until(() => !pad.field(EDITOR), 'the preview')
    pad.press('둘')
    await pad.until(() => (pad.latest().find((op) => op.op === 'text' && op.text === '둘' && op.size === 18) as { y: number } | undefined)?.y! < 160, 'the heading to come up')

    // 태그는 접혀 있다. 펼치면 많이 쓰인 것부터 나오고, 누르면 그 태그가 든 메모를 찾는다.
    write('글.md', '# 하나\n\n내용 #업무\n\n## 둘\n\n### 셋 #개인')
    pad.send(GuiEvent.focus, 1)
    pad.press('편집')
    await pad.until(() => pad.field(EDITOR) && pad.region('태그 2개'), 'the tags')
    expect(pad.region('#업무')).toBeUndefined()
    pad.press('태그 2개')
    await pad.until(() => pad.region('#업무'), 'the tag list')
    expect(pad.regions('button').filter((label) => label.startsWith('#'))).toEqual(['#업무', '#개인'])
    pad.press('#업무')
    await pad.until(() => pad.regions('option').length, 'the notes with the tag')
    expect(pad.regions('option')).toEqual(['글', '다른'])
    expect(pad.shown(SEARCH)).toBe('#업무')
    expect(pad.region('#업무')).toMatchObject({ on: true })
    // 다시 누르면 찾기가 지워진다.
    pad.press('#업무')
    await pad.until(() => pad.regions('treeitem').length === 3, 'the tree')
  })

  it('opens notes by a few letters of their name, above everything else', async () => {
    write('장보기.md', '')
    write('일/보고서.md', '')
    write('회의록.md', '')
    const pad = await openNotepad('회의록.md')
    pad.send(GuiEvent.key, keyCode('o'), Mod.ctrl)
    await pad.until(() => pad.field(QUICK), 'the quick open panel')
    // 입력 칸들보다 위에 그려진다: 위층으로 넘어가는 명령 뒤에 온다.
    const ops = pad.latest()
    const overlay = ops.findIndex((op) => op.op === 'overlay')
    expect(overlay).toBeGreaterThan(ops.findIndex((op) => op.op === 'field' && op.id === EDITOR))
    expect(ops.findIndex((op) => op.op === 'field' && op.id === QUICK)).toBeGreaterThan(overlay)
    expect(pad.field(QUICK)).toMatchObject({ focus: true, placeholder: '메모 이름' })
    // 친 글자가 없으면 최근에 연 메모부터.
    expect(pad.regions('option')).toEqual(['회의록', '보고서', '장보기'])

    pad.type('보', QUICK)
    await pad.until(() => pad.regions('option').length === 2, 'the matches')
    // 이름의 앞쪽에서 맞을수록 먼저다. 어느 폴더의 것인지 옆에 나온다.
    expect(pad.regions('option')).toEqual(['보고서', '장보기'])
    expect(pad.texts()).toContain('일')
    expect(pad.region('보고서', 'option')).toMatchObject({ on: true })
    pad.send(GuiEvent.key, keyCode('ArrowDown'))
    await pad.until(() => pad.region('장보기', 'option')?.on, 'the second row')
    pad.send(GuiEvent.key, keyCode('Enter'))
    await pad.see('notes/장보기.md')
    expect(pad.field(QUICK)).toBeUndefined()

    // 단추로도 열리고, Esc나 바깥을 누르면 닫힌다.
    pad.press('빠른 열기')
    await pad.until(() => pad.field(QUICK), 'the panel again')
    expect(pad.regions('option')[0]).toBe('장보기')
    pad.type('없는이름', QUICK)
    await pad.see('그런 이름의 메모가 없습니다.')
    pad.send(GuiEvent.key, keyCode('Escape'))
    await pad.until(() => !pad.field(QUICK), 'the panel to close')
    pad.press('빠른 열기')
    await pad.until(() => pad.field(QUICK), 'the panel again')
    pad.pointer(GuiEvent.pointerDown, 30, 500)
    await pad.until(() => !pad.field(QUICK), 'the panel to close')
  })

  it('draws the notes and their links as a graph', async () => {
    write('계획.md', '[[회의록]] [[회의록]] [[아직 없음]] ![[그림.png]]')
    write('회의록.md', '[[계획]]')
    write('외톨이.md', '')
    write('그림.png', '')
    const pad = await openNotepad('계획.md')
    pad.press('그래프')
    await pad.until(() => pad.region('계획, 링크 3개'), 'the graph')
    expect(pad.region('그래프')).toMatchObject({ on: true })
    expect(pad.regions('button').filter((label) => label.includes('링크 '))).toEqual(['계획, 링크 3개', '외톨이, 링크 0개', '회의록, 링크 2개', '아직 없음 (아직 없는 메모), 링크 1개'])
    expect(pad.texts().some((t) => t.startsWith('메모 3개 · 링크 3개'))).toBe(true)
    // 그래프가 떠 있는 동안에는 본문이 없다.
    expect(pad.field(EDITOR)).toBeUndefined()
    // 선은 이어진 두 점 사이에 그어진다.
    const circle = (label: string) => {
      const r = pad.region(label)!
      return [r.x + 22, r.y + 16]
    }
    expect(pad.latest()).toContainEqual(expect.objectContaining({ op: 'line', points: [...circle('계획, 링크 3개'), ...circle('회의록, 링크 2개')] }))

    pad.press('회의록, 링크 2개')
    await pad.see('notes/회의록.md')
    expect(pad.region('그래프')).toMatchObject({ on: false })
    // 아직 없는 메모의 점을 누르면 그 이름으로 만든다.
    pad.press('그래프')
    await pad.until(() => pad.region('아직 없음 (아직 없는 메모), 링크 1개'), 'the graph')
    pad.press('아직 없음 (아직 없는 메모), 링크 1개')
    await pad.until(() => exists('아직 없음.md'), 'the new note')
  })

  it('opens another note beside the one being edited, for reference', async () => {
    write('글.md', '# 쓰는 글')
    write('참고.md', '# 참고할 것\n\n- [ ] 누를 수 없는 체크\n\n[[글]]')
    const pad = await openNotepad('글.md')
    pad.rightPress('참고')
    await pad.until(() => pad.menu(), 'the menu')
    expect(pad.menu()).toContain('옆에 열기')
    pad.choose('옆에 열기')
    await pad.until(() => pad.region('참고 메모 닫기'), 'the reference pane')
    // 본문(폭 650)을 편집과 참고가 반씩 나눈다. 지금 메모는 그대로다.
    expect(pad.field(EDITOR)).toMatchObject({ x: 264, w: 325 - 28 })
    expect(pad.region('글', 'tab')).toMatchObject({ on: true })
    expect(pad.latest()).toContainEqual(expect.objectContaining({ op: 'text', text: '참고할 것', x: 250 + 325 + 1 + 20, size: 22 }))
    // 참고 쪽의 체크는 누를 수 없다 (지금 편집하는 메모가 바뀌면 안 된다).
    expect(pad.latest().filter((op) => op.op === 'region' && op.role === 'checkbox')).toMatchObject([{ disabled: true }])

    // 나란히 보기와 함께면 셋으로 나뉜다.
    pad.press('나란히')
    await pad.until(() => pad.field(EDITOR)?.w === Math.floor(650 / 3) - 28, 'three panes')
    // 이름을 바꿔도 따라간다.
    await host.sh('mv notes/참고.md notes/자료.md')
    pad.send(GuiEvent.focus, 1)
    await pad.until(() => !pad.region('참고 메모 닫기'), 'the pane to close when its note is gone')
    pad.rightPress('자료')
    await pad.until(() => pad.menu()?.includes('옆에 열기'), 'the menu')
    pad.choose('옆에 열기')
    await pad.until(() => pad.region('자료 편집하러 가기'), 'the pane')
    pad.press('자료 편집하러 가기')
    await pad.see('notes/자료.md')
    pad.press('참고 메모 닫기')
    await pad.until(() => !pad.region('참고 메모 닫기'), 'the pane to close')
  })

  it('moves a note by dragging it onto a folder', async () => {
    write('가.md', '내용')
    write('보관/나.md', '')
    const pad = await openNotepad('가.md')
    const center = (label: string) => {
      const r = pad.region(label, 'treeitem')!
      return [r.x + r.w / 2, r.y + r.h / 2] as const
    }
    const [from, to] = [center('가'), center('보관')]
    pad.pointer(GuiEvent.pointerDown, ...from)
    // 조금 움직인 것은 끌기가 아니다.
    pad.pointer(GuiEvent.pointerMove, from[0] + 2, from[1] + 1, 1)
    pad.pointer(GuiEvent.pointerMove, ...to, 1)
    // 끄는 동안 이름표가 위층에서 포인터를 따라다니고, 놓으면 들어갈 폴더가 표시된다.
    await pad.until(() => pad.latest().some((op) => op.op === 'overlay'), 'the drag label')
    const folder = pad.region('보관', 'treeitem')!
    await pad.until(() => pad.latest().some((op) => op.op === 'frame' && op.x === folder.x && op.y === folder.y && op.color === '#4553d6'), 'the drop target')
    pad.pointer(GuiEvent.pointerUp, ...to)
    await pad.until(() => exists('보관/가.md'), 'the note to move')
    expect(exists('가.md')).toBe(false)
    await pad.see('notes/보관/가.md')
    expect(pad.latest().some((op) => op.op === 'overlay')).toBe(false)

    // 폴더 밖 빈 곳에 놓으면 보관함 맨 위로 나온다.
    const again = center('가')
    pad.pointer(GuiEvent.pointerDown, ...again)
    pad.pointer(GuiEvent.pointerMove, 100, 500, 1)
    pad.pointer(GuiEvent.pointerUp, 100, 500)
    await pad.until(() => exists('가.md'), 'the note to come back')
    // 본문 쪽에 놓으면 아무 일도 없다.
    const third = center('가')
    pad.pointer(GuiEvent.pointerDown, ...third)
    pad.pointer(GuiEvent.pointerMove, 600, 300, 1)
    pad.pointer(GuiEvent.pointerUp, 600, 300)
    await pad.until(() => !pad.latest().some((op) => op.op === 'overlay'), 'the drag to end')
    expect(exists('가.md')).toBe(true)
  })

  describe('writing helpers', () => {
    /** 사용자가 본문 칸에서 한 일을 화면 쪽이 알리는 순서대로 흉내 낸다. */
    async function editing(text: string, name = '글.md') {
      write(name, text)
      const pad = await openNotepad(name)
      pad.send(GuiEvent.fieldFocus, EDITOR, 1)
      const caret = (start: number, end = start) => pad.send(GuiEvent.caret, EDITOR, start, end)
      const selects = () => all('gui-draw', pad.pid).flatMap((e) => decodeDrawList(e.data).filter((op) => op.op === 'select'))
      const sets = () => all('gui-text', pad.pid).filter((e) => e.field === EDITOR).length
      /** 사용자가 마지막으로 친 글과, 그때까지 프로그램이 칸의 글을 정한 횟수 */
      let typed: { text: string; sets: number } | undefined
      /** 지금 칸에 있는 글: 사용자가 친 것과 프로그램이 정한 것 중 나중 것 */
      const value = () => (typed && typed.sets === sets() ? typed.text : pad.shown()!)
      const type = (text: string) => {
        typed = { text, sets: sets() }
        pad.type(text)
      }
      const moved = () => selects().at(-1) as { start: number; end: number } | undefined
      return {
        pad,
        caret,
        type,
        /** 프로그램이 커서를 이 자리로 옮길 때까지 기다린다. */
        lands: (start: number, end = start) => host.until(() => moved()?.start === start && moved()?.end === end, `the cursor at ${start}..${end}`),
        /** 커서 자리에서 Enter: 칸이 줄을 바꾸고, 바뀐 글과 커서 자리, 그리고 Enter가 차례로 전해진다. */
        enter(at: number, mods = 0) {
          const bytes = utf8(value())
          type(new TextDecoder().decode(bytes.slice(0, at)) + '\n' + new TextDecoder().decode(bytes.slice(at)))
          caret(at + 1)
          pad.send(GuiEvent.key, keyCode('Enter'), mods)
        },
        key: (key: string, mods = 0) => pad.send(GuiEvent.key, keyCode(key), mods),
        /** 프로그램이 마지막으로 옮긴 커서 자리 */
        moved,
        becomes: (text: string) => host.until(() => pad.shown() === text, `the text to become ${JSON.stringify(text)}`),
      }
    }
    const len = (text: string) => utf8(text).length

    it('continues a list when Enter is pressed at the end of an item', async () => {
      const ed = await editing('- 우유')
      ed.enter(len('- 우유'))
      await ed.becomes('- 우유\n- ')
      await ed.lands(len('- 우유\n- '))
      await host.until(() => file('글.md') === '- 우유\n- ', 'the file')

      // 빈 항목에서 한 번 더 치면 목록이 끝난다.
      ed.enter(len('- 우유\n- '))
      await ed.becomes('- 우유\n')
      // 번호는 하나 올리고, 체크 목록은 빈 상자로 시작한다.
      ed.type('1. 하나\n- [x] 끝')
      ed.enter(len('1. 하나'))
      await ed.becomes('1. 하나\n2. \n- [x] 끝')
      ed.enter(len('1. 하나\n2. \n- [x] 끝'))
      await ed.becomes('1. 하나\n2. \n- [x] 끝\n- [ ] ')
    })

    it('leaves ordinary line breaks alone', async () => {
      const ed = await editing('그냥 글\n- 목록')
      const count = () => all('gui-text', ed.pad.pid).filter((e) => e.field === EDITOR).length
      const before = count()
      ed.enter(len('그냥 글'))
      // Shift+Enter는 목록에서도 그냥 줄바꿈이다.
      ed.enter(len('그냥 글\n\n- 목록'), Mod.shift)
      await host.until(() => file('글.md') === '그냥 글\n\n- 목록\n', 'the file')
      // 프로그램은 입력 칸의 글을 건드리지 않았다.
      expect(count()).toBe(before)
      expect(ed.moved()).toBeUndefined()
    })

    it('does not continue lists in plain text notes', async () => {
      const ed = await editing('- 우유', '글.txt')
      expect(ed.pad.field(EDITOR)).toMatchObject({ keys: false })
      ed.enter(len('- 우유'))
      await host.until(() => file('글.txt') === '- 우유\n', 'the file')
    })

    it('indents with Tab and outdents with Shift+Tab', async () => {
      const ed = await editing('- 하나\n- 둘\n글')
      ed.caret(len('- 하나\n- 둘'))
      ed.key('Tab')
      await ed.becomes('- 하나\n  - 둘\n글')
      await ed.lands(len('- 하나\n  - 둘'))
      ed.key('Tab', Mod.shift)
      await ed.becomes('- 하나\n- 둘\n글')
      // 여러 줄을 고르면 모두 옮긴다.
      ed.caret(0, len('- 하나\n- 둘'))
      ed.key('Tab')
      await ed.becomes('  - 하나\n  - 둘\n글')
      await ed.lands(2, len('  - 하나\n  - 둘'))
      // 목록이 아닌 줄에서는 그 자리에 공백 두 칸을 넣는다.
      ed.caret(len('  - 하나\n  - 둘\n글'))
      ed.key('Tab')
      await ed.becomes('  - 하나\n  - 둘\n글  ')
    })

    it('never overwrites what was typed while it was working', async () => {
      const ed = await editing('- 하나')
      const sets = () => all('gui-text', ed.pad.pid).filter((e) => e.field === EDITOR).length
      const before = sets()
      // Tab을 누른 직후, 프로그램이 그것을 처리하기도 전에 글자를 더 쳤다.
      ed.caret(len('- 하나'))
      ed.key('Tab')
      ed.type('- 하나 더')
      await host.until(() => file('글.md') === '- 하나 더', 'the typed text to be saved')
      // 들여 쓴 글로 덮어쓰지 않았다: 프로그램은 칸의 글을 건드리지 않았다.
      expect(sets()).toBe(before)
      // 그다음부터는 다시 평소대로 된다.
      ed.caret(len('- 하나 더'))
      ed.key('Tab')
      await ed.becomes('  - 하나 더')
    })

    it('wraps the selection with Ctrl+B, I and K', async () => {
      const ed = await editing('가 나 다')
      ed.caret(len('가 '), len('가 나'))
      ed.key('b', Mod.ctrl)
      await ed.becomes('가 **나** 다')
      // 감싼 안쪽이 고른 채로 남아, 이어서 다른 것으로 감쌀 수 있다.
      await ed.lands(len('가 **'), len('가 **나'))
      ed.key('i', Mod.meta)
      await ed.becomes('가 ***나*** 다')
      ed.caret(len('가 ***나*** 다'))
      ed.key('k', Mod.ctrl)
      await ed.becomes('가 ***나*** 다[[]]')
      await ed.lands(len('가 ***나*** 다[['))
    })

    it('offers notes to link, under the cursor, while it is inside an open [[', async () => {
      write('회의록.md', '')
      write('일/회계.md', '')
      write('그림.png', '')
      write('무관.md', '')
      const ed = await editing('보기 [[회')
      ed.caret(len('보기 [[회'))
      // 고를 것이 생기면 커서가 창의 어디에 있는지 묻고, Enter와 위·아래 키를 가져간다.
      await ed.pad.until(() => ed.pad.field(EDITOR)?.where, 'the question about the cursor')
      expect(ed.pad.field(EDITOR)).toMatchObject({ grabEnter: true })
      expect(ed.pad.regions('option')).toEqual([])
      ed.pad.send(GuiEvent.caretAt, EDITOR, 400, 200)
      await ed.pad.until(() => ed.pad.regions('option').length, 'the list')
      expect(ed.pad.regions('option')).toEqual(['회계', '회의록'])
      // 목록은 입력 칸 위에, 커서 바로 아래에 뜬다. 어느 폴더의 것인지 옆에 나온다.
      const ops = ed.pad.latest()
      expect(ops.findIndex((op) => op.op === 'overlay')).toBeGreaterThan(ops.findIndex((op) => op.op === 'field' && op.id === EDITOR))
      expect(ed.pad.region('회계', 'option')).toMatchObject({ x: 404, y: 208, on: true })
      expect(ed.pad.texts()).toContain('일')

      ed.key('ArrowDown')
      await ed.pad.until(() => ed.pad.region('회의록', 'option')?.on, 'the second row')
      ed.key('Enter')
      await ed.becomes('보기 [[회의록]]')
      await ed.lands(len('보기 [[회의록]]'))
      await ed.pad.until(() => !ed.pad.regions('option').length, 'the list to go')
      expect(ed.pad.field(EDITOR)).toMatchObject({ grabEnter: false, where: false })

      // 눌러서 고를 수도 있다. 뒤에 이미 ]]가 있으면 다시 붙이지 않는다.
      ed.type('[[그]] 끝')
      ed.caret(len('[[그'))
      ed.pad.send(GuiEvent.caretAt, EDITOR, 300, 120)
      await ed.pad.until(() => ed.pad.region('그림.png', 'option'), 'the image to be offered')
      ed.pad.press('그림.png', 'option')
      await ed.becomes('[[그림.png]] 끝')
      // Esc로 닫으면 같은 자리에서는 다시 뜨지 않고, 커서가 [[ 밖으로 나가도 사라진다.
      ed.type('[[')
      ed.caret(2)
      ed.pad.send(GuiEvent.caretAt, EDITOR, 280, 120)
      await ed.pad.until(() => ed.pad.region('회계', 'option'), 'everything to be offered')
      ed.key('Escape')
      await ed.pad.until(() => !ed.pad.regions('option').length, 'the list to go')
      ed.type('[[회')
      ed.caret(len('[[회'))
      await new Promise((r) => setTimeout(r, 60))
      expect(ed.pad.field(EDITOR)).toMatchObject({ where: false })
      ed.type('[[회 [[회')
      ed.caret(len('[[회 [[회'))
      ed.pad.send(GuiEvent.caretAt, EDITOR, 330, 120)
      await ed.pad.until(() => ed.pad.region('회계', 'option'), 'the list at another place')
      ed.caret(0)
      await ed.pad.until(() => !ed.pad.regions('option').length, 'the list to go')
    })

    it('offers things to insert when / is typed, like a command palette', async () => {
      write('회의록.md', '')
      const ed = await editing('앞 줄\n/')
      ed.caret(len('앞 줄\n/'))
      await ed.pad.until(() => ed.pad.field(EDITOR)?.where, 'the question about the cursor')
      ed.pad.send(GuiEvent.caretAt, EDITOR, 280, 150)
      await ed.pad.until(() => ed.pad.regions('option').length, 'the commands')
      expect(ed.pad.regions('option')).toEqual(['제목 1', '제목 2', '제목 3', '글머리 목록', '번호 목록', '할 일', '인용', '코드 블록'])
      // 여덟 줄까지 보이고, 아래로 내려가면 나머지가 나온다.
      for (let i = 0; i < 9; i++) ed.key('ArrowDown')
      await ed.pad.until(() => ed.pad.region('구분선', 'option')?.on, 'the tenth command')
      expect(ed.pad.regions('option')).toContain('표')

      // 이어서 친 글자로 거른다. 한글 이름이나 영문 별명 어느 쪽으로도 찾는다.
      ed.type('앞 줄\n/제목')
      ed.caret(len('앞 줄\n/제목'))
      await ed.pad.until(() => ed.pad.regions('option').length === 3, 'the headings')
      ed.type('앞 줄\n/todo')
      ed.caret(len('앞 줄\n/todo'))
      await ed.pad.until(() => ed.pad.regions('option').join() === '할 일', 'the task command')
      ed.key('Enter')
      await ed.becomes('앞 줄\n- [ ] ')
      await ed.lands(len('앞 줄\n- [ ] '))

      // 커서가 넣은 것의 안쪽으로 가는 명령도 있다.
      ed.type('/코드')
      ed.caret(len('/코드'))
      ed.pad.send(GuiEvent.caretAt, EDITOR, 280, 130)
      await ed.pad.until(() => ed.pad.regions('option').join() === '코드 블록', 'the code command')
      ed.key('Tab')
      await ed.becomes('```\n\n```')
      await ed.lands(4)
      // "메모 링크"는 [[ 를 넣고, 곧바로 링크할 메모를 고르게 한다.
      ed.type('/링크')
      ed.caret(len('/링크'))
      ed.pad.send(GuiEvent.caretAt, EDITOR, 280, 130)
      await ed.pad.until(() => ed.pad.regions('option').join() === '메모 링크', 'the link command')
      ed.key('Enter')
      await ed.becomes('[[')
      ed.pad.send(GuiEvent.caretAt, EDITOR, 290, 150)
      await ed.pad.until(() => ed.pad.region('회의록', 'option'), 'the notes to link')

      // 맞는 명령이 없거나, 주소 속의 / 이거나, 텍스트 메모면 뜨지 않는다.
      for (const text of ['/없는명령', 'http://example']) {
        ed.type(text)
        ed.caret(len(text))
        await new Promise((r) => setTimeout(r, 50))
        expect(ed.pad.field(EDITOR)).toMatchObject({ where: false, grabEnter: false })
      }
      const plain = await editing('/', '그냥.txt')
      plain.caret(1)
      await new Promise((r) => setTimeout(r, 50))
      expect(plain.pad.field(EDITOR)).toMatchObject({ where: false })
    })
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
