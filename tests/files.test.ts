// 파일 앱(programs/files): 창을 직접 그리는 프로세스. 실제 바이너리를 커널 위에서 돌려,
// 화면 쪽이 받는 그리기 명령과 파일시스템에 남는 결과를 확인한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KernelEvent } from '../src/kernel/abi.ts'
import { GuiEvent, decodeDrawList, encodeEvent, encodePointer, keyCode, type DrawOp } from '../src/kernel/gui.ts'
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
const write = (path: string, text = '') => {
  host.kernel.fs.mkdirp(path.slice(0, path.lastIndexOf('/')) || '/')
  host.kernel.fs.writeFile(path, utf8(text))
}
const exists = (path: string) => {
  try {
    host.kernel.fs.lookup(host.kernel.fs.root, path)
    return true
  } catch {
    return false
  }
}
/** 입력 칸의 번호 (programs/files/src/main.rs) */
const RENAME = 1

async function openFiles(...args: string[]) {
  const pid = host.kernel.launch('/bin/files', ['files', ...args])
  await host.until(() => all('gui-draw', pid).length > 0, 'first frame')
  const frames = () => all('gui-draw', pid).map((e) => decodeDrawList(e.data))
  const latest = () => frames().at(-1)!
  const of = <T extends DrawOp['op']>(op: T) => latest().filter((o): o is Op<T> => o.op === op)
  const sent = <T extends DrawOp['op']>(op: T) => frames().flatMap((ops) => ops.filter((o): o is Op<T> => o.op === op))
  const region = (label: string, role?: Op<'region'>['role']) => of('region').find((r) => r.label === label && (!role || r.role === role))
  const send = (kind: number, a = 0, b = 0, c = 0) => host.kernel.guiEvent(pid, encodeEvent(kind, a, b, c))
  function point(label: string, button: number, clicks: number) {
    const r = region(label)
    if (!r) throw new Error(`no "${label}" on screen; there are: ${of('region').map((x) => x.label).join(', ')}`)
    const [x, y] = [r.x + r.w / 2, r.y + r.h / 2]
    host.kernel.guiEvent(pid, encodePointer(GuiEvent.pointerDown, x, y, button + 256 * (clicks - 1)))
    host.kernel.guiEvent(pid, encodePointer(GuiEvent.pointerUp, x, y))
  }
  let answered = 0
  const menu = () => frames().slice(answered).flatMap((ops) => ops.filter((o): o is Op<'menu'> => o.op === 'menu')).at(-1)
  return {
    pid,
    latest,
    sent,
    region,
    texts: () => of('text').map((op) => op.text),
    names: () => of('region').filter((r) => r.role === 'option').map((r) => r.label),
    crumbs: () => of('region').filter((r) => r.role === 'link').map((r) => r.label),
    status: () => of('region').find((r) => r.role === 'status' || r.role === 'alert')?.label,
    field: () => of('field').find((f) => f.id === RENAME),
    press: (label: string) => point(label, 0, 1),
    open: (label: string) => (point(label, 0, 1), point(label, 0, 2)),
    rightPress: (label: string) => point(label, 2, 1),
    menu: () => menu()?.items.map((item) => (item.separator ? '---' : item.label)),
    choose(label: string) {
      const at = menu()!.items.findIndex((item) => item.label === label)
      if (at < 0) throw new Error(`no "${label}" in the menu`)
      answered = frames().length
      send(GuiEvent.menu, at)
    },
    send,
    key: (key: string) => send(GuiEvent.key, keyCode(key)),
    /** 이름 칸에 글을 치고 Enter를 누른다. */
    rename(text: string) {
      host.kernel.guiText(pid, RENAME, utf8(text))
      send(GuiEvent.key, keyCode('Enter'))
    },
    /** 프로그램이 이름 칸에 넣은 글 */
    shown: () => {
      const set = all('gui-text', pid).findLast((e) => e.field === RENAME)
      return set && new TextDecoder().decode(set.data)
    },
    until: (check: () => unknown, what: string) => host.until(() => !!check(), what),
  }
}

describe('files', () => {
  it('lists the home folder: folders first, then by name, with sizes', async () => {
    write('/home/guest/b.txt', 'abc')
    write('/home/guest/a 10.txt')
    write('/home/guest/a 2.txt')
    write('/home/guest/work/x.md', '#')
    write('/home/guest/.hidden')
    const app = await openFiles()
    expect(all('gui-open', app.pid)[0]).toMatchObject({ title: '파일', w: 600, h: 420 })
    expect(app.names()).toEqual(['work', 'a 2.txt', 'a 10.txt', 'b.txt', 'hello.sh', 'README.md'])
    expect(app.crumbs()).toEqual(['/', 'home', 'guest'])
    expect(app.texts()).toEqual(expect.arrayContaining(['항목 1개', '3 B', '0 B']))
    expect(app.status()).toBe('항목 6개')
    // 창의 제목은 보고 있는 폴더의 이름이다.
    expect(app.sent('title')).toEqual([{ op: 'title', text: 'guest' }])
  })

  it('moves between folders with a double press, the breadcrumbs and the up button', async () => {
    write('/home/guest/work/deep/x.md')
    const app = await openFiles()
    app.open('work')
    await app.until(() => app.names().join() === 'deep', 'the folder')
    expect(app.crumbs()).toEqual(['/', 'home', 'guest', 'work'])
    expect(app.sent('title').at(-1)).toEqual({ op: 'title', text: 'work' })
    app.press('위 폴더로')
    await app.until(() => app.names().includes('work'), 'the parent')
    app.press('/')
    await app.until(() => app.names().join() === 'bin,etc,home,proc,tmp', 'the root')
    expect(app.region('위 폴더로')).toMatchObject({ disabled: true })
    // 시작할 폴더를 정해 줄 수도 있다.
    const etc = await openFiles('/etc')
    expect(etc.names()).toEqual(['motd'])
  })

  it('opens a file by asking the display to pick an app for it', async () => {
    const app = await openFiles()
    app.open('README.md')
    await app.until(() => app.sent('launch').length, 'the request')
    expect(app.sent('launch')).toEqual([{ op: 'launch', path: '/home/guest/README.md' }])
    // 키보드로도: 위로 골라 Enter. (방금 누른 README.md가 골라져 있다.)
    app.key('ArrowUp')
    await app.until(() => app.region('hello.sh', 'option')?.on, 'the row above')
    app.key('Enter')
    await app.until(() => app.sent('launch').length === 2, 'the second request')
    expect(app.sent('launch')[1]).toEqual({ op: 'launch', path: '/home/guest/hello.sh' })
  })

  it('creates folders and files, starting with the name ready to change', async () => {
    const app = await openFiles()
    app.press('새 폴더')
    await app.until(() => app.field(), 'the name field')
    expect(app.shown()).toBe('새 폴더')
    expect(exists('/home/guest/새 폴더')).toBe(true)
    app.rename('docs')
    await app.until(() => exists('/home/guest/docs'), 'the new name')
    expect(exists('/home/guest/새 폴더')).toBe(false)

    app.press('새 파일')
    await app.until(() => app.region('JSON .json'), 'the kinds of file')
    app.press('JSON .json')
    await app.until(() => app.shown() === '새 파일.json', 'the new file')
    // 확장자는 남기고 이름 부분만 고른 채로 시작한다.
    await app.until(() => app.sent('select').length === 2, 'the selection')
    expect(app.sent('select').at(-1)).toEqual({ op: 'select', id: RENAME, start: 0, end: utf8('새 파일').length })
    expect(new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/새 파일.json'))).toBe('{}\n')
    app.rename('config.json')
    await app.until(() => exists('/home/guest/config.json'), 'the new name')
    expect(app.region('JSON .json')).toBeUndefined()
  })

  it('refuses a name that is taken or has a slash, and Esc leaves it alone', async () => {
    const app = await openFiles()
    app.press('README.md')
    await app.until(() => app.region('이름 바꾸기'), 'the actions for the selection')
    app.press('이름 바꾸기')
    await app.until(() => app.field(), 'the name field')
    app.rename('hello.sh')
    await app.until(() => app.status() === '같은 이름이 이미 있습니다.', 'the reason')
    expect(app.region('같은 이름이 이미 있습니다.')).toMatchObject({ role: 'alert' })
    app.press('README.md')
    app.rightPress('README.md')
    await app.until(() => app.menu(), 'the menu')
    expect(app.menu()).toEqual(['편집기로 열기', '이름 바꾸기', '경로 복사', '---', '삭제…'])
    app.choose('이름 바꾸기')
    await app.until(() => app.field(), 'the name field')
    app.rename('a/b')
    await app.until(() => app.status() === '이름에는 / 를 쓸 수 없습니다.', 'the reason')
    app.press('README.md')
    await app.until(() => app.region('이름 바꾸기'), 'the actions for the selection')
    app.press('이름 바꾸기')
    await app.until(() => app.field(), 'the name field')
    host.kernel.guiText(app.pid, RENAME, utf8('버림.md'))
    app.key('Escape')
    await app.until(() => !app.field(), 'the field to go')
    expect(exists('/home/guest/README.md')).toBe(true)
  })

  it('asks before deleting, and deletes folders with what is in them', async () => {
    write('/home/guest/work/a.txt')
    write('/home/guest/work/b.txt')
    const app = await openFiles()
    app.press('work')
    await app.until(() => app.region('삭제'), 'the actions')
    app.press('삭제')
    await app.until(() => app.status() === '“work”과 그 안의 항목 2개을(를) 지울까요?', 'the question')
    app.press('취소')
    await app.until(() => app.status() === 'work', 'the question to go')
    expect(exists('/home/guest/work')).toBe(true)
    app.key('Delete')
    await app.until(() => app.region('지우기'), 'the question again')
    app.press('지우기')
    await app.until(() => !exists('/home/guest/work'), 'the folder to be deleted')
    await app.until(() => app.status() === '항목 2개', 'the list to shrink')
  })

  it('notices what other programs change, without being told', async () => {
    const app = await openFiles()
    await host.sh('mkdir work; echo hi > work/a.txt; touch from-shell.txt')
    await app.until(() => app.names().includes('from-shell.txt'), 'the new file')
    expect(app.texts()).toContain('항목 1개')
    // 보고 있던 폴더가 지워지면 위 폴더로 물러난다.
    app.open('work')
    await app.until(() => app.names().join() === 'a.txt', 'the folder')
    await host.sh('rm -r work')
    await app.until(() => app.crumbs().join() === '/,home,guest', 'the parent')
  })

  it('takes files dropped on the window, and offers to copy paths', async () => {
    const app = await openFiles()
    host.kernel.fs.mkdirp(`/tmp/.gui-${app.pid}`)
    host.kernel.fs.writeFile(`/tmp/.gui-${app.pid}/0000-mine.wasm`, utf8('\0asm'))
    app.send(GuiEvent.files, 1, 0)
    await app.until(() => app.names().includes('mine.wasm'), 'the dropped file')
    expect(new TextDecoder().decode(host.kernel.fs.readFile('/home/guest/mine.wasm'))).toBe('\0asm')

    app.rightPress('mine.wasm')
    await app.until(() => app.menu(), 'the menu')
    app.choose('경로 복사')
    await app.until(() => app.sent('copy').length, 'the copy')
    expect(app.sent('copy')).toEqual([{ op: 'copy', text: '/home/guest/mine.wasm' }])
  })

  it('shows up as a process, and its calls can be traced', async () => {
    host.kernel.setTracing(true)
    const app = await openFiles()
    const r = await host.sh('ps | grep "files$"')
    expect(r.stdout).toMatch(/^\s*\d+\s+0 [RS]\s+-\s+files\n$/)
    app.send(GuiEvent.close)
    await host.until(() => all('exit', app.pid).length > 0, 'exit')
  })
})
